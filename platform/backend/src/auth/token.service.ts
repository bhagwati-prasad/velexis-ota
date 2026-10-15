// Access tokens of the portal and the platform admin (platform/docs/architecture.md §3.1, PADR-0009 item 4, ADR-0008):
// EdDSA JWTs signed with the Ed25519 key of JWT_PRIVATE_KEY_FILE through `jose`, valid 15 minutes, with the key's JWK
// thumbprint (RFC 7638) as `kid` so the key can rotate later. The claims:
//
//   iss     https://api.platform.example.com
//   aud     `portal` or `platform_admin`; the two never mix (each guard verifies its own audience)
//   sub     the account (`acc_…`)
//   typ     `portal` or `admin`, following `aud`
//   sid     the refresh family (`account_sessions.family_id`, the `familyId` of listSessions)
//   ev      e-mail verified; always `true` in admin tokens
//   amr     `["pwd"]` or `["pwd","otp"]`; always with `otp` in admin tokens
//   mfa_at  the family's last TOTP verification (epoch seconds), when there was one
//
// Refresh tokens are opaque and live in `account_sessions` (PBE-014); this service only signs and verifies access
// tokens. A token is never logged, and an error never quotes one.
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readKeyFile } from "@velexis/config";
import { AppError } from "@velexis/errors";
import { errors as joseErrors, jwtVerify, SignJWT, type JWTPayload, type JWTVerifyResult } from "jose";
import { Clock } from "../common/clock";
import { JWT_PRIVATE_KEY_MIN_BYTES, type PlatformBackendConfig } from "../config";

/** The `iss` of every platform access token: the public host of the platform API (decisions.md §4). */
export const ACCESS_TOKEN_ISSUER = "https://api.platform.example.com";

/** Access tokens live 15 minutes (PADR-0009 item 4). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** The only signature algorithm signed and accepted. */
export const ACCESS_TOKEN_ALGORITHM = "EdDSA";

/** The audiences: the portal surface and the platform admin surface. */
export const TOKEN_AUDIENCES = Object.freeze(["portal", "platform_admin"] as const);
export type TokenAudience = (typeof TOKEN_AUDIENCES)[number];

/** The `typ` claim of each audience. */
export const TOKEN_TYPES = Object.freeze({ portal: "portal", platform_admin: "admin" } as const);
export type TokenType = (typeof TOKEN_TYPES)[TokenAudience];

/** The authentication methods of `amr` (RFC 8176): the password and a TOTP code. */
export const AUTH_METHODS = Object.freeze(["pwd", "otp"] as const);
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** What `sign` takes: the claims that differ per token. */
export interface AccessTokenInput {
  readonly aud: TokenAudience;
  /** The account, `acc_…`. */
  readonly sub: string;
  /**
   * The refresh family: `account_sessions.family_id`, shared by every refresh token of one sign-in (not the `id` of
   * one generation). An opaque `SessionFamilyId` of the platform document, so `listSessions` can mark the `current`
   * family and `signOut` revoke it.
   */
  readonly sid: string;
  /** E-mail verified. Must be `true` for `platform_admin`. */
  readonly ev: boolean;
  /** How the family was authenticated. Must include `otp` for `platform_admin`. */
  readonly amr: readonly AuthMethod[];
  /** The family's last TOTP verification in epoch seconds (`account_sessions.mfa_verified_at`), if any. */
  readonly mfa_at?: number;
}

/** The claims of a verified access token. */
export interface AccessTokenClaims extends AccessTokenInput {
  readonly iss: typeof ACCESS_TOKEN_ISSUER;
  readonly typ: TokenType;
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

/** The signing key of the platform: an Ed25519 key pair and its `kid`. */
export interface SigningKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** The RFC 7638 JWK thumbprint (SHA-256, base64url) of the public key. */
  readonly kid: string;
}

/** `AccountId` of the platform document. */
const ACCOUNT_ID = /^acc_[0-9A-HJKMNP-TV-Z]{26}$/;
/** `SessionFamilyId` of the platform document: opaque, 1–64 characters of `[A-Za-z0-9_-]`. */
const FAMILY_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** RFC 6750 `b64token` after `Bearer`. */
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i;
/** A signed token is a few hundred characters; anything far longer is refused before it is parsed. */
export const MAX_ACCESS_TOKEN_LENGTH = 4096;

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
      `JWT_PRIVATE_KEY_FILE ${path} holds a key of type ${privateKey.asymmetricKeyType ?? "unknown"}; platform tokens are signed with Ed25519`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, kid: jwkThumbprint(publicKey) };
}

/** The bearer token of an `Authorization: Bearer <token>` header; `undefined` without one or with another scheme. */
export function bearerTokenOf(headers: IncomingHttpHeaders): string | undefined {
  const value = headers.authorization;
  if (typeof value !== "string" || value.length > MAX_ACCESS_TOKEN_LENGTH + 16) {
    return undefined;
  }
  return BEARER.exec(value)?.[1];
}

const isInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** True when `amr` is a non-empty list of known methods, each once. */
function isAmr(value: unknown): value is AuthMethod[] {
  const methods: readonly unknown[] = AUTH_METHODS;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((method) => methods.includes(method)) &&
    new Set(value).size === value.length
  );
}

/** Admin tokens are issued only after the password and a TOTP code, for a verified address (§3.1). */
function isAdminShaped(ev: boolean, amr: readonly AuthMethod[]): boolean {
  return ev && amr.includes("otp");
}

/** The claims of a payload whose signature, issuer, audience and lifetime jose has checked; `undefined` if malformed. */
function claimsOf(payload: JWTPayload, audience: TokenAudience): AccessTokenClaims | undefined {
  const { iss, aud, sub, iat, exp } = payload;
  const { typ, sid, ev, amr, mfa_at: mfaAt } = payload as Record<string, unknown>;
  if (
    iss !== ACCESS_TOKEN_ISSUER ||
    aud !== audience ||
    typeof sub !== "string" ||
    !ACCOUNT_ID.test(sub) ||
    typ !== TOKEN_TYPES[audience] ||
    typeof sid !== "string" ||
    !FAMILY_ID.test(sid) ||
    typeof ev !== "boolean" ||
    !isAmr(amr) ||
    (mfaAt !== undefined && !isInteger(mfaAt)) ||
    !isInteger(iat) ||
    !isInteger(exp) ||
    (audience === "platform_admin" && !isAdminShaped(ev, amr))
  ) {
    return undefined;
  }
  return Object.freeze({
    iss,
    aud: audience,
    sub,
    typ: TOKEN_TYPES[audience],
    sid,
    ev,
    amr: Object.freeze([...amr]),
    ...(mfaAt === undefined ? {} : { mfa_at: mfaAt }),
    iat,
    exp,
  });
}

/**
 * Signs and verifies platform access tokens with the key of JWT_PRIVATE_KEY_FILE (read once, at start-up: a missing,
 * readable-by-others or non-Ed25519 key stops the API). Times come from the injected Clock.
 */
@Injectable()
export class TokenService {
  private readonly key: SigningKey;

  constructor(
    config: ConfigService<PlatformBackendConfig, true>,
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
   * A new access token for 15 minutes from now. Throws a `TypeError` for claims that would never verify (a malformed
   * id, an admin token without TOTP or for an unverified address, an `mfa_at` in the future).
   */
  async sign(input: AccessTokenInput): Promise<SignedAccessToken> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    if (!(TOKEN_AUDIENCES as readonly string[]).includes(input.aud)) {
      throw new TypeError("TokenService.sign: unknown audience");
    }
    if (!ACCOUNT_ID.test(input.sub) || !FAMILY_ID.test(input.sid)) {
      throw new TypeError("TokenService.sign: sub must be an acc_ id and sid a session family id");
    }
    if (!isAmr(input.amr)) {
      throw new TypeError("TokenService.sign: amr must list pwd and otp at most once each");
    }
    if (input.aud === "platform_admin" && !isAdminShaped(input.ev, input.amr)) {
      throw new TypeError("TokenService.sign: admin tokens need ev = true and otp in amr");
    }
    if (input.mfa_at !== undefined && (!isInteger(input.mfa_at) || input.mfa_at > now)) {
      throw new TypeError("TokenService.sign: mfa_at must be epoch seconds, not in the future");
    }
    const exp = now + ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({
      typ: TOKEN_TYPES[input.aud],
      sid: input.sid,
      ev: input.ev,
      amr: [...input.amr],
      ...(input.mfa_at === undefined ? {} : { mfa_at: input.mfa_at }),
    })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid: this.key.kid })
      .setIssuer(ACCESS_TOKEN_ISSUER)
      .setAudience(input.aud)
      .setSubject(input.sub)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.key.privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * The claims of `token` for `audience`. Throws `AppError("TOKEN_EXPIRED")` for a token past its `exp` and
   * `AppError("UNAUTHENTICATED")` for anything else that is not a valid token of this audience: none, malformed,
   * another algorithm, key or `kid`, another issuer or audience (a portal token on the admin surface, and the
   * reverse), or claims of the wrong shape.
   */
  async verify(token: string | undefined, audience: TokenAudience): Promise<AccessTokenClaims> {
    if (token === undefined || token.length === 0 || token.length > MAX_ACCESS_TOKEN_LENGTH) {
      throw new AppError("UNAUTHENTICATED");
    }
    let verified: JWTVerifyResult;
    try {
      verified = await jwtVerify(token, this.key.publicKey, {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        issuer: ACCESS_TOKEN_ISSUER,
        audience,
        currentDate: this.clock.now(),
        requiredClaims: ["sub", "iat", "exp"],
      });
    } catch (error) {
      // jose checks the issuer and the audience before the lifetime, so an expired token of the other surface is
      // UNAUTHENTICATED, not TOKEN_EXPIRED.
      if (error instanceof joseErrors.JWTExpired) {
        throw new AppError("TOKEN_EXPIRED");
      }
      throw new AppError("UNAUTHENTICATED");
    }
    const claims =
      verified.protectedHeader.kid === this.key.kid ? claimsOf(verified.payload, audience) : undefined;
    if (claims === undefined) {
      throw new AppError("UNAUTHENTICATED");
    }
    return claims;
  }
}
