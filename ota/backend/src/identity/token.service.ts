// Customer access tokens of the OTA backend (OBE-031; ota/docs/architecture.md §3.2, ADR-0008 "Access tokens"): EdDSA
// JWTs signed through `jose` with the OTA backend's own Ed25519 key (JWT_PRIVATE_KEY_FILE, never the platform's), with
// the key's JWK thumbprint (RFC 7638) as `kid` so the key can rotate later. They live 15 minutes and carry:
//
//   typ   `customer` (staff tokens of OBE-059 will be `staff`; a token of one kind never passes as the other)
//   sub   the customer, `cus_…`
//   tid   the tenant, `ten_…`: the customer guard refuses a token whose tenant is not the request's (OF-01 AC2)
//   sid   the session, `ses_…`: the refresh family in `customer_sessions` (`AuthSessionDetails.id`)
//   iat, exp
//
// Verification accepts EdDSA with this key's `kid` (or the previous key's during a rotation, below), allows 30 s of
// clock skew between the API's processes and the client, and answers why a token is refused instead of throwing, so the
// guard maps the reason to the error code (`TOKEN_EXPIRED` for an expired token of the request's tenant,
// `UNAUTHENTICATED` for anything else) and logs it.
// Refresh tokens are opaque and live in `customer_sessions` (sessions.service.ts); this service only signs and
// verifies access tokens. A token is never logged, and no error or reason quotes one.
//
// Key rotation (FIX-W48-OTA, lead decision (15f) of 2026-11-11; ADR-0010 "Rotation": the old public key stays valid
// for one token lifetime): besides its own key, the service verifies the tokens whose `kid` is that of the optional
// JWT_PREVIOUS_PUBLIC_KEY_FILE (`PreviousSigningKey`), the public half of the key it signed with before the rotation,
// and it signs with JWT_PRIVATE_KEY_FILE only. A token's `kid` picks the key it is verified with, so a token of another
// `kid`, or one whose signature is not its `kid`'s key, is refused (`signature`). Removing the variable (and
// restarting) ends the overlap: ota/docs/runbooks/jwt-key-rotation.md removes it 15 minutes after the rotation.
// StaffTokens (staff/staff-sessions.ts) verifies staff tokens with the same keys.
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readKeyFile } from "@velexis/config";
import {
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  SignJWT,
  type JWTPayload,
  type JWTVerifyResult,
} from "jose";
import { Clock } from "../common/clock";
import { JWT_PRIVATE_KEY_MIN_BYTES, type ApiConfig } from "../config";
import { isSamePublicKey, JWT_PUBLIC_KEY_MIN_BYTES, previousPublicKeyOf } from "./jwt-keys";

/** Access tokens live 15 minutes (ADR-0008, architecture §3.2). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** The clock skew verification allows on `exp` and `iat` (OBE-031 step 1). */
export const CLOCK_SKEW_SECONDS = 30;

/** The only signature algorithm signed and accepted. */
export const ACCESS_TOKEN_ALGORITHM = "EdDSA";

/** The `typ` claim of a customer access token. */
export const CUSTOMER_TOKEN_TYPE = "customer";

/** A signed token is a few hundred characters; anything far longer is refused before it is parsed. */
export const MAX_ACCESS_TOKEN_LENGTH = 4096;

/** `cus_…`, `ten_…`, `ses_…`: the ids of the claims, a prefix and a ULID (db README §2.1). */
const CUSTOMER_ID = /^cus_[0-9A-HJKMNP-TV-Z]{26}$/;
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_ID = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;

/** RFC 6750 `b64token` after `Bearer`. */
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i;

/** What `signCustomerToken` takes: the claims that differ per token. */
export interface CustomerTokenInput {
  /** The customer, `cus_…`. */
  readonly sub: string;
  /** The tenant of the request that opens or refreshes the session, `ten_…`. */
  readonly tid: string;
  /** The session (refresh family), `ses_…`. */
  readonly sid: string;
}

/** The claims of a verified customer access token. */
export interface CustomerTokenClaims extends CustomerTokenInput {
  readonly typ: typeof CUSTOMER_TOKEN_TYPE;
  /** Issued at, epoch seconds. */
  readonly iat: number;
  /** Expires at, epoch seconds: `iat` + 15 minutes. */
  readonly exp: number;
}

/** A signed access token and when it expires (`accessTokenExpiresAt` of the session answers). */
export interface SignedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Why a presented token is refused: none was sent; it is not a JWT this service could have signed (malformed, too
 * long, another algorithm, a `kid` that is neither the current key's nor the previous key's of a rotation, a signature
 * that is not its `kid`'s key); its claims are not those of a customer token (another `typ`, a
 * malformed id, a missing or inconsistent time); it expired; or it belongs to another tenant than the request's.
 */
export type TokenRefusal = "missing" | "malformed" | "signature" | "claims" | "expired" | "other_tenant";

/** The outcome of `verifyCustomerToken`. */
export type CustomerTokenVerdict =
  | { readonly ok: true; readonly claims: CustomerTokenClaims }
  | { readonly ok: false; readonly reason: TokenRefusal };

/** The signing key of the OTA backend: an Ed25519 key pair and its `kid`. */
export interface SigningKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** The RFC 7638 JWK thumbprint (SHA-256, base64url) of the public key. */
  readonly kid: string;
}

/** A key that only verifies: the previous key of a rotation (JWT_PREVIOUS_PUBLIC_KEY_FILE) and its `kid`. */
export interface VerifyingKey {
  readonly publicKey: KeyObject;
  /** The RFC 7638 JWK thumbprint (SHA-256, base64url) of the public key. */
  readonly kid: string;
}

/** The RFC 7638 thumbprint of an Ed25519 public key: SHA-256 of `{"crv","kty","x"}` in that order, base64url. */
export function jwkThumbprint(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new TypeError("jwkThumbprint: the key is not an Ed25519 public key");
  }
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

/**
 * Reads and checks the signing key: the file passes `readKeyFile` (a regular file of mode 0400 or 0600 with a PEM
 * block of at least 48 bytes) and holds an Ed25519 private key in PKCS#8. Errors name the path and the reason, never
 * a byte of the file.
 */
export function loadSigningKey(path: string): SigningKey {
  const pem = readKeyFile(path, { minBytes: JWT_PRIVATE_KEY_MIN_BYTES, encoding: "pem" });
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new Error(`JWT_PRIVATE_KEY_FILE ${path} does not hold a PEM private key`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `JWT_PRIVATE_KEY_FILE ${path} holds a key of type ${privateKey.asymmetricKeyType ?? "unknown"}; OTA tokens are signed with Ed25519`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, kid: jwkThumbprint(publicKey) };
}

/**
 * Reads and checks the previous key of a rotation (JWT_PREVIOUS_PUBLIC_KEY_FILE): the file passes `readKeyFile` (a
 * regular file of mode 0400 or 0600 with a PEM block of at least 44 bytes) and holds an Ed25519 public key in SPKI and
 * no private key (`previousPublicKeyOf`). Errors name the path and the reason, never a byte of the file.
 */
export function loadVerifyingKey(path: string): VerifyingKey {
  const pem = readKeyFile(path, { minBytes: JWT_PUBLIC_KEY_MIN_BYTES, encoding: "pem" });
  let publicKey: KeyObject;
  try {
    publicKey = previousPublicKeyOf(pem);
  } catch (error) {
    throw new Error(`JWT_PREVIOUS_PUBLIC_KEY_FILE ${path} ${(error as Error).message}`);
  }
  return { publicKey, kid: jwkThumbprint(publicKey) };
}

/**
 * The previous key of a rotation of JWT_PRIVATE_KEY_FILE, read once at start-up from the optional
 * JWT_PREVIOUS_PUBLIC_KEY_FILE (`loadVerifyingKey`; a missing, readable-by-others, private or non-Ed25519 key stops the
 * API); `key` is `undefined` outside a rotation. IdentityModule provides it to TokenService and StaffTokens, which also
 * verify the tokens of its `kid`; one read serves both.
 */
@Injectable()
export class PreviousSigningKey {
  readonly key: VerifyingKey | undefined;

  constructor(config: ConfigService<ApiConfig, true>) {
    const path = config.get("JWT_PREVIOUS_PUBLIC_KEY_FILE", { infer: true });
    this.key = path === undefined ? undefined : loadVerifyingKey(path);
  }
}

/**
 * The keys that verify the tokens of a service signing with `signing`: its own and, during a rotation, `previous`'s.
 * Throws when the previous key is the signing key's public half (the same `kid`), which configuration also refuses.
 */
export class VerificationKeys {
  readonly previous: VerifyingKey | undefined;

  constructor(
    private readonly signing: SigningKey,
    previous: PreviousSigningKey | undefined,
  ) {
    this.previous = previous?.key;
    if (this.previous !== undefined && isSamePublicKey(this.previous.publicKey, signing.publicKey)) {
      throw new Error(
        "JWT_PREVIOUS_PUBLIC_KEY_FILE holds the public half of JWT_PRIVATE_KEY_FILE (the same kid)",
      );
    }
  }

  /**
   * The public key that verifies the tokens of `kid`: the signing key's, or the previous key's during a rotation;
   * `undefined` for any other `kid` (and for none).
   */
  of(kid: unknown): KeyObject | undefined {
    if (kid === this.signing.kid) {
      return this.signing.publicKey;
    }
    if (this.previous !== undefined && kid === this.previous.kid) {
      return this.previous.publicKey;
    }
    return undefined;
  }
}

/** The token of an `Authorization: Bearer <token>` header; `undefined` without one or with another scheme. */
export function bearerTokenOf(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  const value = headers["authorization"];
  if (typeof value !== "string" || value.length > MAX_ACCESS_TOKEN_LENGTH + 16) {
    return undefined;
  }
  return BEARER.exec(value)?.[1];
}

const isEpochSeconds = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** The claims of a payload whose signature jose has checked; `undefined` when it is not a customer token's. */
function claimsOf(payload: JWTPayload): CustomerTokenClaims | undefined {
  const { sub, iat, exp } = payload;
  const { typ, tid, sid } = payload as Record<string, unknown>;
  if (
    typ !== CUSTOMER_TOKEN_TYPE ||
    typeof sub !== "string" ||
    !CUSTOMER_ID.test(sub) ||
    typeof tid !== "string" ||
    !TENANT_ID.test(tid) ||
    typeof sid !== "string" ||
    !SESSION_ID.test(sid) ||
    !isEpochSeconds(iat) ||
    !isEpochSeconds(exp) ||
    exp - iat !== ACCESS_TOKEN_TTL_SECONDS
  ) {
    return undefined;
  }
  return Object.freeze({ typ: CUSTOMER_TOKEN_TYPE, sub, tid, sid, iat, exp });
}

/**
 * Signs the OTA backend's customer access tokens with the key of JWT_PRIVATE_KEY_FILE and verifies them with it or,
 * during a rotation, with the previous public key of JWT_PREVIOUS_PUBLIC_KEY_FILE (`PreviousSigningKey`; both read
 * once, at start-up: a missing, readable-by-others or non-Ed25519 key stops the API, and so does a previous key with
 * the current `kid`). A service built without `previous` (a test's) verifies with its own key only. Times come from
 * the injected Clock.
 */
@Injectable()
export class TokenService {
  private readonly key: SigningKey;
  private readonly keys: VerificationKeys;

  constructor(
    config: ConfigService<ApiConfig, true>,
    private readonly clock: Clock,
    @Inject(PreviousSigningKey) previous?: PreviousSigningKey,
  ) {
    this.key = loadSigningKey(config.get("JWT_PRIVATE_KEY_FILE", { infer: true }));
    this.keys = new VerificationKeys(this.key, previous);
  }

  /** The `kid` of every token this service signs: the JWK thumbprint of the public key. */
  get kid(): string {
    return this.key.kid;
  }

  /** The `kid` of the previous key whose tokens are still accepted, or `undefined` outside a rotation. */
  get previousKid(): string | undefined {
    return this.keys.previous?.kid;
  }

  /** The public key, for tests and a later JWKS. */
  get publicKey(): KeyObject {
    return this.key.publicKey;
  }

  /**
   * A new customer access token for 15 minutes from now. Throws a `TypeError` for claims that would never verify (an
   * id of the wrong kind or shape); the error names the claim, never its value.
   */
  async signCustomerToken(input: CustomerTokenInput): Promise<SignedAccessToken> {
    if (!CUSTOMER_ID.test(input.sub)) {
      throw new TypeError("TokenService.signCustomerToken: sub must be a cus_ id");
    }
    if (!TENANT_ID.test(input.tid)) {
      throw new TypeError("TokenService.signCustomerToken: tid must be a ten_ id");
    }
    if (!SESSION_ID.test(input.sid)) {
      throw new TypeError("TokenService.signCustomerToken: sid must be a ses_ id");
    }
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const exp = now + ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({ typ: CUSTOMER_TOKEN_TYPE, tid: input.tid, sid: input.sid })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid: this.key.kid })
      .setSubject(input.sub)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.key.privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * The verdict on `token` presented to tenant `tenantId`. The signature is checked first, with the key of the token's
   * `kid` (this service's, or the previous key's during a rotation), so the claims of a refused token are trusted only
   * when they were signed with one of these keys: an expired token is `expired` only when it is a customer token of
   * `tenantId`; one of another tenant is `other_tenant`, expired or not.
   */
  async verifyCustomerToken(token: string | undefined, tenantId: string): Promise<CustomerTokenVerdict> {
    if (token === undefined || token.length === 0) {
      return { ok: false, reason: "missing" };
    }
    if (token.length > MAX_ACCESS_TOKEN_LENGTH) {
      return { ok: false, reason: "malformed" };
    }
    const verifier = verifierOf(token, this.keys);
    if (typeof verifier === "string") {
      return { ok: false, reason: verifier };
    }
    let verified: JWTVerifyResult;
    try {
      verified = await jwtVerify(token, verifier, {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        currentDate: this.clock.now(),
        clockTolerance: CLOCK_SKEW_SECONDS,
        maxTokenAge: ACCESS_TOKEN_TTL_SECONDS,
        requiredClaims: ["sub", "iat", "exp"],
      });
    } catch (error) {
      return { ok: false, reason: refusalOf(error, tenantId) };
    }
    const claims = claimsOf(verified.payload);
    if (claims === undefined) {
      return { ok: false, reason: "claims" };
    }
    if (claims.tid !== tenantId) {
      return { ok: false, reason: "other_tenant" };
    }
    return { ok: true, claims };
  }
}

/**
 * The public key that verifies `token`, picked by its protected header before any signature check, or why the header
 * rules the token out: `malformed` when there is no JWS header, `signature` when it names another algorithm or a key
 * that is not one of `keys` (`alg` must be EdDSA, `kid` the signing key's or the previous key's of a rotation).
 * StaffTokens picks the key of a staff token with it too.
 */
export function verifierOf(token: string, keys: VerificationKeys): KeyObject | TokenRefusal {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return "malformed";
  }
  return (header.alg === ACCESS_TOKEN_ALGORITHM ? keys.of(header.kid) : undefined) ?? "signature";
}

/**
 * Why jose refused a token. jose checks the signature before any claim, so the payload of a claim error is signed by
 * one of this service's keys: an expired token is reported as such only when it is a well-formed customer token of
 * `tenantId`.
 */
function refusalOf(error: unknown, tenantId: string): TokenRefusal {
  if (error instanceof joseErrors.JWTExpired) {
    const claims = claimsOf(error.payload);
    if (claims === undefined) {
      return "claims";
    }
    return claims.tid === tenantId ? "expired" : "other_tenant";
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return "claims";
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return "signature";
  }
  return "malformed";
}
