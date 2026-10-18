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
// Verification accepts EdDSA with this key's `kid` only, allows 30 s of clock skew between the API's processes and
// the client, and answers why a token is refused instead of throwing, so the guard maps the reason to the error code
// (`TOKEN_EXPIRED` for an expired token of the request's tenant, `UNAUTHENTICATED` for anything else) and logs it.
// Refresh tokens are opaque and live in `customer_sessions` (sessions.service.ts); this service only signs and
// verifies access tokens. A token is never logged, and no error or reason quotes one.
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { Injectable } from "@nestjs/common";
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
 * long, another algorithm or `kid`, a bad signature); its claims are not those of a customer token (another `typ`, a
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
 * Signs and verifies the OTA backend's access tokens with the key of JWT_PRIVATE_KEY_FILE (read once, at start-up: a
 * missing, readable-by-others or non-Ed25519 key stops the API). Times come from the injected Clock.
 */
@Injectable()
export class TokenService {
  private readonly key: SigningKey;

  constructor(
    config: ConfigService<ApiConfig, true>,
    private readonly clock: Clock,
  ) {
    this.key = loadSigningKey(config.get("JWT_PRIVATE_KEY_FILE", { infer: true }));
  }

  /** The `kid` of every token this service signs: the JWK thumbprint of the public key. */
  get kid(): string {
    return this.key.kid;
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
   * The verdict on `token` presented to tenant `tenantId`. The signature is checked first, so the claims of a refused
   * token are trusted only when they were signed with this key: an expired token is `expired` only when it is a
   * customer token of `tenantId`; one of another tenant is `other_tenant`, expired or not.
   */
  async verifyCustomerToken(token: string | undefined, tenantId: string): Promise<CustomerTokenVerdict> {
    if (token === undefined || token.length === 0) {
      return { ok: false, reason: "missing" };
    }
    if (token.length > MAX_ACCESS_TOKEN_LENGTH) {
      return { ok: false, reason: "malformed" };
    }
    const headerProblem = this.headerProblem(token);
    if (headerProblem !== undefined) {
      return { ok: false, reason: headerProblem };
    }
    let verified: JWTVerifyResult;
    try {
      verified = await jwtVerify(token, this.key.publicKey, {
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

  /**
   * Why the token's protected header rules it out before any signature check: `malformed` when there is no JWS header,
   * `signature` when it names another algorithm or key (`alg` must be EdDSA and `kid` this key's).
   */
  private headerProblem(token: string): TokenRefusal | undefined {
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      return "malformed";
    }
    return header.alg === ACCESS_TOKEN_ALGORITHM && header.kid === this.key.kid ? undefined : "signature";
  }
}

/**
 * Why jose refused a token. jose checks the signature before any claim, so the payload of a claim error is this key's
 * own: an expired token is reported as such only when it is a well-formed customer token of `tenantId`.
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
