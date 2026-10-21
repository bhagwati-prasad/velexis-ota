// Staff sessions of the console (OBE-059; OADR-0011 points 1–3, PADR-0007, ota/docs/architecture.md §3.2 and §7,
// platform architecture §6.4, flows/console-operations.md §1 and §4). Everything here lives in Redis and in the
// platform tables the OTA backend may read; no tenant table and no platform table is written.
//
// - The portal token. The platform's API stores `ptk:<sha256(token)>` = `{v: 1, accountId, tenantId, membershipId,
//   role, mfa, issuedAt, requestId}` for 60 s (`SET … EX 60 NX`); `redeemPortalToken` takes it with `GETDEL`, so a
//   token works once, whatever the outcome of the sign-in. Only the SHA-256 of the token is ever used as a key. A token
//   issued at or before the account's cut-off `staffdeny:acct:<accountId>` is refused by the sign-in
//   (`accountCutOff`), so the platform's "sign out everywhere" also ends the tokens of the 60 s before it.
// - Staff access tokens (`StaffTokens`): EdDSA JWTs with the OTA backend's own key (JWT_PRIVATE_KEY_FILE, the key of
//   the customer tokens, read once at start-up), 15 minutes, claims `typ: staff`, `sub` (`stf_…`, the membership),
//   `tid` (`ten_…`), `roles` (the membership's one role), `sid` (`asn_…`, the family), `iat`, `exp`. A customer token
//   never verifies as a staff token, or the other way round (`typ`).
// - Refresh families (`staffsess:<asn_…>`, absolute lifetime 12 hours, `SET … EX NX`, rotations `KEEPTTL`): JSON
//   `{v: 1, id, staffId, accountId, tenantId, role, createdAt, expiresAt, userAgent, current, rotated}` where `current`
//   is the SHA-256 of the newest refresh token and `rotated` those of the tokens it replaced (the last 100). A refresh
//   token is `srt_` + the family's ULID + 43 base64url characters (256 random bits), so the token names its family. One
//   Lua script rotates: the current token gets a new one; a rotated token presented again deletes the family and
//   writes `staffdeny:<familyId>` (reuse revokes the family); any other token changes nothing.
// - Revocation checks, on every console request (the staff guard) and on every refresh (OADR-0011 point 3): the family
//   exists, belongs to the tenant, has not ended and is not in `staffdeny:<familyId>`; it was created after the
//   cut-offs (epoch ms) `staffdeny:acct:<accountId>` (the platform's "sign out everywhere", PADR-0007),
//   `staffdeny:tenant:<tenantId>` (`tenant.suspend`, OADR-0007) and `staffdeny:member:<staffId>` (console.auth.signOut
//   with `scope: all`); a family created at or before a cut-off is refused, and a cut-off that is not a number refuses
//   every family. The cached membership (`member:<accountId>:<tenantId>`, 60 s, deleted by the `membership` and
//   `account` invalidations) must be active, of an active account, and have the family's role: a removed or suspended
//   member is `403 STAFF_MEMBERSHIP_INACTIVE`, a role change ends the session (a new sign-in through the portal).
//
// A Redis that cannot answer refuses with `503 SERVICE_UNAVAILABLE`: a revocation that cannot be checked is never
// skipped. No token, refresh token or portal token is ever logged, stored in clear or put into an error.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import {
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../../common/clock";
import { IdGenerator } from "../../common/ids";
import { REDIS_CLIENT } from "../../common/redis/redis.module";
import { redisKeys, STAFF_FAMILY_LIFETIME_SECONDS } from "../../common/redis/redis.keys";
import type { ApiConfig } from "../../config";
import { PlatformCache, type CacheParser } from "../../tenancy/platform-cache";
import {
  ACCOUNT_STATUSES,
  MEMBERSHIP_STATUSES,
  PlatformReadRepository,
  STAFF_ROLES,
  type PlatformStaffAccount,
  type PlatformStaffMember,
  type StaffRole,
} from "../../tenancy/platform-read.repository";
import { UnexpectedPlatformValueError } from "../../tenancy/platform-read.types";
import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  loadSigningKey,
  MAX_ACCESS_TOKEN_LENGTH,
  type SignedAccessToken,
  type SigningKey,
  type TokenRefusal,
} from "../token.service";

/** The `typ` claim of a staff access token. */
export const STAFF_TOKEN_TYPE = "staff";

/** The absolute lifetime of a staff family: 12 hours (OADR-0011 point 2), as its Redis key lives. */
export const STAFF_FAMILY_LIFETIME_MS = STAFF_FAMILY_LIFETIME_SECONDS * 1000;

/** The prefix of family ids: `asn_…`, the contract's `ConsoleStaffProfile.session.id`. */
export const STAFF_FAMILY_PREFIX = "asn";

/** The prefix of staff refresh tokens (`srt_…`, the contract's examples). */
export const STAFF_REFRESH_TOKEN_PREFIX = "srt";

/** The random bytes of a refresh token: 256 bits (architecture §3.2). */
export const STAFF_REFRESH_TOKEN_BYTES = 32;

/** How many rotated refresh tokens of a family are remembered for reuse detection (a working day is about 50). */
export const MAX_ROTATED_TOKENS = 100;

/** The contract's `ConsolePortalTokenSignIn.portalToken` (PADR-0007: `ptk_` and 43 base62 characters). */
export const PORTAL_TOKEN_PATTERN = /^ptk_[A-Za-z0-9]{24,64}$/;

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const STAFF_ID = new RegExp(`^stf_${ULID}$`);
const TENANT_ID = new RegExp(`^ten_${ULID}$`);
const ACCOUNT_ID = new RegExp(`^acc_${ULID}$`);
const FAMILY_ID = new RegExp(`^${STAFF_FAMILY_PREFIX}_${ULID}$`);
/** `srt_`, the family's ULID, then 43 base64url characters. */
const REFRESH_TOKEN = new RegExp(`^${STAFF_REFRESH_TOKEN_PREFIX}_(${ULID})([A-Za-z0-9_-]{43})$`);

/** The version of the stored family JSON. */
const FAMILY_FORMAT = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

const isInstant = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

// ---- Portal tokens ------------------------------------------------------------------------------------------------

/** What a redeemed portal token grants (PADR-0007 item 1). `role` is informative: the membership is re-read. */
export interface PortalTokenGrant {
  readonly accountId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly role: StaffRole;
  /** Whether the account has MFA enabled (the platform checked the live-tenant rule before it issued the token). */
  readonly mfa: boolean;
  readonly issuedAt: string;
  readonly requestId: string | null;
}

/** The value of a `ptk:` key, or `undefined` when it is not one the platform writes. */
export function parsePortalToken(raw: string | null): PortalTokenGrant | undefined {
  if (raw === null) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["v"] !== 1) {
    return undefined;
  }
  const { accountId, tenantId, membershipId, role, mfa, issuedAt, requestId } = value;
  if (
    typeof accountId !== "string" ||
    !ACCOUNT_ID.test(accountId) ||
    typeof tenantId !== "string" ||
    !TENANT_ID.test(tenantId) ||
    typeof membershipId !== "string" ||
    !STAFF_ID.test(membershipId) ||
    !isOneOf(role, STAFF_ROLES) ||
    typeof mfa !== "boolean" ||
    !isInstant(issuedAt) ||
    !(requestId === undefined || requestId === null || typeof requestId === "string")
  ) {
    return undefined;
  }
  return Object.freeze({
    accountId,
    tenantId,
    membershipId,
    role,
    mfa,
    issuedAt,
    requestId: requestId ?? null,
  });
}

// ---- Families -----------------------------------------------------------------------------------------------------

/** A staff refresh family, as the checks and the answers use it (the token hashes stay in Redis). */
export interface StaffFamily {
  /** `asn_…`: the family, the session id and the `sid` of its access tokens. */
  readonly id: string;
  /** `stf_…`: the membership. */
  readonly staffId: string;
  readonly accountId: string;
  readonly tenantId: string;
  /** The membership's role at sign-in: a different role ends the session. */
  readonly role: StaffRole;
  readonly createdAt: Date;
  /** The absolute end, 12 hours after `createdAt`; rotations never move it. */
  readonly expiresAt: Date;
  /** The staff member's user agent at sign-in, at most 512 characters. */
  readonly userAgent: string | null;
}

/** The family of a `staffsess:` value, or `undefined` when it is not one this version wrote. */
export function parseFamily(raw: string | null): StaffFamily | undefined {
  if (raw === null) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["v"] !== FAMILY_FORMAT) {
    return undefined;
  }
  const { id, staffId, accountId, tenantId, role, createdAt, expiresAt, userAgent } = value;
  if (
    typeof id !== "string" ||
    !FAMILY_ID.test(id) ||
    typeof staffId !== "string" ||
    !STAFF_ID.test(staffId) ||
    typeof accountId !== "string" ||
    !ACCOUNT_ID.test(accountId) ||
    typeof tenantId !== "string" ||
    !TENANT_ID.test(tenantId) ||
    !isOneOf(role, STAFF_ROLES) ||
    !isInstant(createdAt) ||
    !isInstant(expiresAt) ||
    !(userAgent === null || typeof userAgent === "string")
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    staffId,
    accountId,
    tenantId,
    role,
    createdAt: new Date(createdAt),
    expiresAt: new Date(expiresAt),
    userAgent,
  });
}

/** The family a refresh token names and the token's SHA-256, or `undefined` for anything that is not one. */
export function parseRefreshToken(token: string): { familyId: string; hash: string } | undefined {
  const match = REFRESH_TOKEN.exec(token);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return { familyId: `${STAFF_FAMILY_PREFIX}_${match[1]}`, hash: sha256Hex(token) };
}

/** A new refresh token of family `familyId` and its SHA-256 (the only form that is stored). */
export function newRefreshToken(familyId: string): { token: string; hash: string } {
  if (!FAMILY_ID.test(familyId)) {
    throw new TypeError("newRefreshToken: familyId must be an asn_ id");
  }
  const random = generateToken(STAFF_REFRESH_TOKEN_PREFIX, STAFF_REFRESH_TOKEN_BYTES).token.slice(
    STAFF_REFRESH_TOKEN_PREFIX.length + 1,
  );
  const token = `${STAFF_REFRESH_TOKEN_PREFIX}_${familyId.slice(STAFF_FAMILY_PREFIX.length + 1)}${random}`;
  return { token, hash: sha256Hex(token) };
}

/** The revocations read with a family: its own deny key and the three cut-offs (epoch ms). */
export interface StaffRevocations {
  readonly familyDenied: boolean;
  readonly accountCutOff: number | undefined;
  readonly tenantCutOff: number | undefined;
  readonly memberCutOff: number | undefined;
}

/** No revocation at all. */
export const NO_REVOCATIONS: StaffRevocations = Object.freeze({
  familyDenied: false,
  accountCutOff: undefined,
  tenantCutOff: undefined,
  memberCutOff: undefined,
});

/**
 * A cut-off value as written (`<epoch ms>`): `undefined` without one; a value that is not a whole number of
 * milliseconds refuses every family (`Infinity`): a revocation that cannot be read is never ignored.
 */
export function cutOffOf(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw.trim());
  return raw.trim() !== "" && Number.isSafeInteger(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

/** Why a family no longer holds a session. */
export type FamilyProblem =
  "missing" | "other_tenant" | "expired" | "denied" | "member_cut_off" | "account_cut_off" | "tenant_cut_off";

/** A family and the revocations read with it. */
export interface StaffSessionState {
  readonly family: StaffFamily | undefined;
  readonly revocations: StaffRevocations;
}

/** True when a family created at `createdAt` falls under `cutOff`: created at or before it. */
const cutOff = (createdAt: Date, value: number | undefined): boolean =>
  value !== undefined && createdAt.getTime() <= value;

/** Why `state` holds no session of tenant `tenantId` at `now`, or `undefined` when it does (see the file header). */
export function familyProblem(
  state: StaffSessionState,
  tenantId: string,
  now: Date,
): FamilyProblem | undefined {
  const { family, revocations } = state;
  if (family === undefined) {
    return "missing";
  }
  if (family.tenantId !== tenantId) {
    return "other_tenant";
  }
  if (family.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  if (revocations.familyDenied) {
    return "denied";
  }
  if (cutOff(family.createdAt, revocations.memberCutOff)) {
    return "member_cut_off";
  }
  if (cutOff(family.createdAt, revocations.accountCutOff)) {
    return "account_cut_off";
  }
  if (cutOff(family.createdAt, revocations.tenantCutOff)) {
    return "tenant_cut_off";
  }
  return undefined;
}

/** True when the account may hold a staff session: active and not erased. */
export function accountMayHoldSession(account: PlatformStaffAccount): boolean {
  return account.status === "active" && account.deletedAt === null;
}

/** Why a membership no longer holds the family's session. */
export type MembershipProblem = "inactive" | "role_changed";

/**
 * `inactive` when the membership is gone, another one (a new invitation after a removal), not `active`, or of an
 * account that is not active; `role_changed` when its role is not the family's; `undefined` when it holds the session.
 */
export function membershipProblem(
  member: PlatformStaffMember | null,
  family: Pick<StaffFamily, "staffId" | "accountId" | "tenantId" | "role">,
): MembershipProblem | undefined {
  if (
    member === null ||
    member.id !== family.staffId ||
    member.accountId !== family.accountId ||
    member.tenantId !== family.tenantId ||
    member.status !== "active" ||
    !accountMayHoldSession(member.account)
  ) {
    return "inactive";
  }
  return member.role === family.role ? undefined : "role_changed";
}

/** A cached `PlatformStaffMember` (`member:<accountId>:<tenantId>`). */
export const parseStaffMember: CacheParser<PlatformStaffMember> = (value) => {
  const account: unknown = isRecord(value) ? value["account"] : undefined;
  if (!isRecord(value) || !isRecord(account)) {
    return undefined;
  }
  const { id, tenantId, accountId, role, status, lastActiveAt, createdAt, tenantTimeZone } = value;
  const { email, fullName, locale, timeZone, mfaEnabled, deletedAt } = account;
  const accountStatus = account["status"];
  if (
    typeof id !== "string" ||
    typeof tenantId !== "string" ||
    typeof accountId !== "string" ||
    !isOneOf(role, STAFF_ROLES) ||
    !isOneOf(status, MEMBERSHIP_STATUSES) ||
    !(lastActiveAt === null || isInstant(lastActiveAt)) ||
    !isInstant(createdAt) ||
    typeof tenantTimeZone !== "string" ||
    typeof email !== "string" ||
    typeof fullName !== "string" ||
    typeof locale !== "string" ||
    typeof timeZone !== "string" ||
    typeof mfaEnabled !== "boolean" ||
    !isOneOf(accountStatus, ACCOUNT_STATUSES) ||
    !(deletedAt === null || isInstant(deletedAt))
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    tenantId,
    accountId,
    role,
    status,
    lastActiveAt,
    createdAt,
    account: Object.freeze({
      email,
      fullName,
      locale,
      timeZone,
      mfaEnabled,
      status: accountStatus,
      deletedAt,
    }),
    tenantTimeZone,
  });
};

// ---- Access tokens ------------------------------------------------------------------------------------------------

/** What `StaffTokens.sign` takes. */
export interface StaffTokenInput {
  /** The membership, `stf_…`. */
  readonly sub: string;
  /** The tenant, `ten_…`. */
  readonly tid: string;
  /** The family, `asn_…`. */
  readonly sid: string;
  readonly role: StaffRole;
}

/** The claims of a verified staff access token. */
export interface StaffTokenClaims {
  readonly typ: typeof STAFF_TOKEN_TYPE;
  readonly sub: string;
  readonly tid: string;
  readonly sid: string;
  /** The `roles` claim: the membership's one role. */
  readonly role: StaffRole;
  readonly iat: number;
  readonly exp: number;
}

/** The outcome of `StaffTokens.verify`. */
export type StaffTokenVerdict =
  | { readonly ok: true; readonly claims: StaffTokenClaims }
  | { readonly ok: false; readonly reason: TokenRefusal };

const isEpochSeconds = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** The claims of a payload whose signature jose checked; `undefined` when it is not a staff token's. */
function staffClaimsOf(payload: JWTPayload): StaffTokenClaims | undefined {
  const { sub, iat, exp } = payload;
  const { typ, tid, sid, roles } = payload as Record<string, unknown>;
  const role: unknown = Array.isArray(roles) && roles.length === 1 ? roles[0] : undefined;
  if (
    typ !== STAFF_TOKEN_TYPE ||
    typeof sub !== "string" ||
    !STAFF_ID.test(sub) ||
    typeof tid !== "string" ||
    !TENANT_ID.test(tid) ||
    typeof sid !== "string" ||
    !FAMILY_ID.test(sid) ||
    !isOneOf(role, STAFF_ROLES) ||
    !isEpochSeconds(iat) ||
    !isEpochSeconds(exp) ||
    exp - iat !== ACCESS_TOKEN_TTL_SECONDS
  ) {
    return undefined;
  }
  return Object.freeze({ typ: STAFF_TOKEN_TYPE, sub, tid, sid, role, iat, exp });
}

/**
 * Signs and verifies staff access tokens with the OTA backend's key (JWT_PRIVATE_KEY_FILE, the one TokenService signs
 * customer tokens with, read once at start-up) and the same rules: EdDSA with this key's `kid` only, 30 s of clock
 * skew, a reason instead of an exception. Times come from the injected Clock.
 */
@Injectable()
export class StaffTokens {
  private readonly key: SigningKey;

  constructor(
    config: ConfigService<ApiConfig, true>,
    private readonly clock: Clock,
  ) {
    this.key = loadSigningKey(config.get("JWT_PRIVATE_KEY_FILE", { infer: true }));
  }

  /** A new staff access token for 15 minutes from now; a claim of the wrong shape is a `TypeError` (never its value). */
  async sign(input: StaffTokenInput): Promise<SignedAccessToken> {
    if (!STAFF_ID.test(input.sub)) {
      throw new TypeError("StaffTokens.sign: sub must be a stf_ id");
    }
    if (!TENANT_ID.test(input.tid)) {
      throw new TypeError("StaffTokens.sign: tid must be a ten_ id");
    }
    if (!FAMILY_ID.test(input.sid)) {
      throw new TypeError("StaffTokens.sign: sid must be an asn_ id");
    }
    if (!isOneOf(input.role, STAFF_ROLES)) {
      throw new TypeError("StaffTokens.sign: role must be a staff role");
    }
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const exp = now + ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({
      typ: STAFF_TOKEN_TYPE,
      tid: input.tid,
      roles: [input.role],
      sid: input.sid,
    })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid: this.key.kid })
      .setSubject(input.sub)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.key.privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * The tenant (`tid`) of a staff access token signed with this key, also when it has expired; `undefined` for anything
   * else (not a token, another key, a customer token). The tenant guard locates the tenant of an OTA admin request with
   * it (OBE-060, OADR-0009 point 2: the service caller's tenant is its staff token's `tid`); the staff guard then
   * verifies the token against that tenant as for any caller. The unverified `tid` only picks the tenant `verify`
   * checks the token for.
   */
  async tenantOf(token: string): Promise<string | undefined> {
    if (token.length === 0 || token.length > MAX_ACCESS_TOKEN_LENGTH) {
      return undefined;
    }
    let claimed: unknown;
    try {
      claimed = decodeJwt(token)["tid"];
    } catch {
      return undefined;
    }
    if (typeof claimed !== "string" || !TENANT_ID.test(claimed)) {
      return undefined;
    }
    const verdict = await this.verify(token, claimed);
    return verdict.ok || verdict.reason === "expired" ? claimed : undefined;
  }

  /**
   * The verdict on `token` presented to tenant `tenantId`, as TokenService.verifyCustomerToken: the signature first,
   * then the claims; an expired token is `expired` only when it is a staff token of `tenantId`.
   */
  async verify(token: string | undefined, tenantId: string): Promise<StaffTokenVerdict> {
    if (token === undefined || token.length === 0) {
      return { ok: false, reason: "missing" };
    }
    if (token.length > MAX_ACCESS_TOKEN_LENGTH) {
      return { ok: false, reason: "malformed" };
    }
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (header.alg !== ACCESS_TOKEN_ALGORITHM || header.kid !== this.key.kid) {
      return { ok: false, reason: "signature" };
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.key.publicKey, {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        currentDate: this.clock.now(),
        clockTolerance: CLOCK_SKEW_SECONDS,
        maxTokenAge: ACCESS_TOKEN_TTL_SECONDS,
        requiredClaims: ["sub", "iat", "exp"],
      }));
    } catch (error) {
      return { ok: false, reason: refusalOf(error, tenantId) };
    }
    const claims = staffClaimsOf(payload);
    if (claims === undefined) {
      return { ok: false, reason: "claims" };
    }
    return claims.tid === tenantId ? { ok: true, claims } : { ok: false, reason: "other_tenant" };
  }
}

/** Why jose refused a token; the payload of a claim error is this key's own (jose checks the signature first). */
function refusalOf(error: unknown, tenantId: string): TokenRefusal {
  if (error instanceof joseErrors.JWTExpired) {
    const claims = staffClaimsOf(error.payload);
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

// ---- Redis --------------------------------------------------------------------------------------------------------

/**
 * Rotates a family (KEYS[1] `staffsess:<id>`, KEYS[2] `staffdeny:<id>`; ARGV[1] the presented token's SHA-256,
 * ARGV[2] the new one's, ARGV[3] how many rotated hashes to keep, ARGV[4] the deny key's TTL in seconds). The current
 * token is replaced, keeping the key's TTL; a rotated one deletes the family and writes the deny key; anything else
 * changes nothing. Answers `rotated`, `reused`, `missing` or `invalid`.
 */
const ROTATE = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 'missing'
end
local ok, family = pcall(cjson.decode, raw)
if not ok or type(family) ~= 'table' or type(family['current']) ~= 'string' then
  return 'missing'
end
local rotated = family['rotated']
if type(rotated) ~= 'table' then
  rotated = {}
end
if family['current'] == ARGV[1] then
  table.insert(rotated, ARGV[1])
  while #rotated > tonumber(ARGV[3]) do
    table.remove(rotated, 1)
  end
  family['rotated'] = rotated
  family['current'] = ARGV[2]
  redis.call('SET', KEYS[1], cjson.encode(family), 'KEEPTTL')
  return 'rotated'
end
for _, hash in ipairs(rotated) do
  if hash == ARGV[1] then
    redis.call('DEL', KEYS[1])
    redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[4]))
    return 'reused'
  end
end
return 'invalid'
`;

/**
 * Whether a refresh token is a family's current token (`2`), one of its rotated tokens (`1`) or neither (`0`; KEYS[1]
 * `staffsess:<id>`, ARGV[1] the token's SHA-256). console.auth.signOut ends a session only for a token the family
 * issued.
 */
const ISSUED_BY_FAMILY = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local ok, family = pcall(cjson.decode, raw)
if not ok or type(family) ~= 'table' then
  return 0
end
if family['current'] == ARGV[1] then
  return 2
end
if type(family['rotated']) == 'table' then
  for _, hash in ipairs(family['rotated']) do
    if hash == ARGV[1] then
      return 1
    end
  end
end
return 0
`;

/** What the staff sessions need of the command client (`REDIS_CLIENT`). */
export type StaffSessionsRedis = Pick<Redis, "getdel" | "set" | "mget" | "eval" | "multi">;

/** A new family and its first refresh token (which exists only here and in the answer). */
export interface IssuedStaffFamily {
  readonly family: StaffFamily;
  readonly refreshToken: string;
}

/** The outcome of `rotate`. */
export type RotationOutcome =
  | { readonly outcome: "rotated"; readonly refreshToken: string }
  | { readonly outcome: "reused" | "missing" | "invalid" };

/** A staff member whose session the checks accepted (the staff guard). */
export interface AuthenticatedStaff {
  readonly family: StaffFamily;
  readonly member: PlatformStaffMember;
}

/** The staff sessions of the console in Redis, and the memberships they rest on (see the file header). */
@Injectable()
export class StaffSessions {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: StaffSessionsRedis,
    private readonly cache: PlatformCache,
    private readonly platform: PlatformReadRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectPinoLogger(StaffSessions.name) private readonly logger: PinoLogger,
  ) {}

  /** Takes the portal token (`GETDEL`): its grant, or `undefined` when it is unknown, used, expired or unreadable. */
  async redeemPortalToken(token: string): Promise<PortalTokenGrant | undefined> {
    if (!PORTAL_TOKEN_PATTERN.test(token)) {
      return undefined;
    }
    const key = redisKeys.portalToken(sha256Hex(token));
    const raw = await this.command(() => this.redis.getdel(key.key));
    const grant = parsePortalToken(raw);
    if (raw !== null && grant === undefined) {
      // Not a value the platform writes (another version?): the token is used up either way.
      this.logger.warn({ reason: "unreadable" }, "staff.portal_token_refused");
    }
    return grant;
  }

  /**
   * The grant of a portal token without taking it (`GET`), or `undefined` when it is unknown, used, expired or
   * unreadable. The tenant guard reads the tenant of an OTA admin sign-in with it (OBE-060, OADR-0009 point 2: the
   * redeemed portal token's tenant); console.auth.signIn still takes the token with `GETDEL`, after the rate limit, and
   * checks its tenant against the request's.
   */
  async peekPortalToken(token: string): Promise<PortalTokenGrant | undefined> {
    if (!PORTAL_TOKEN_PATTERN.test(token)) {
      return undefined;
    }
    const [raw] = await this.command(() => this.redis.mget(redisKeys.portalToken(sha256Hex(token)).key));
    return parsePortalToken(raw ?? null);
  }

  /**
   * The family a refresh token names (`srt_<family ULID>…`), whatever the token's own state, or `undefined` when there
   * is none. The tenant guard reads the tenant of an OTA admin refresh or sign-out with it (OBE-060); console.auth.
   * refresh and signOut check the token itself.
   */
  async familyOf(refreshToken: string): Promise<StaffFamily | undefined> {
    const presented = parseRefreshToken(refreshToken);
    if (presented === undefined) {
      return undefined;
    }
    const [raw] = await this.command(() => this.redis.mget(redisKeys.staffSession(presented.familyId).key));
    return parseFamily(raw ?? null);
  }

  /** Opens a family for `member` (checked by the caller) with the staff member's user agent. */
  async open(member: PlatformStaffMember, userAgent: string | null): Promise<IssuedStaffFamily> {
    const now = this.clock.now();
    const id = this.ids.newId(STAFF_FAMILY_PREFIX);
    const family: StaffFamily = Object.freeze({
      id,
      staffId: member.id,
      accountId: member.accountId,
      tenantId: member.tenantId,
      role: member.role,
      createdAt: now,
      expiresAt: new Date(now.getTime() + STAFF_FAMILY_LIFETIME_MS),
      userAgent,
    });
    const { token, hash } = newRefreshToken(id);
    const key = redisKeys.staffSession(id);
    const stored = JSON.stringify({
      v: FAMILY_FORMAT,
      id,
      staffId: family.staffId,
      accountId: family.accountId,
      tenantId: family.tenantId,
      role: family.role,
      createdAt: family.createdAt.toISOString(),
      expiresAt: family.expiresAt.toISOString(),
      userAgent,
      current: hash,
      rotated: [],
    });
    const written = await this.command(() => this.redis.set(key.key, stored, "EX", key.ttlSeconds, "NX"));
    if (written !== "OK") {
      // A new ULID never meets an existing family; a Redis that says otherwise cannot be trusted with sessions.
      throw new AppError("SERVICE_UNAVAILABLE");
    }
    return { family, refreshToken: token };
  }

  /** Family `familyId` and its revocations (two reads: the family names the account and the membership). */
  async state(familyId: string, tenantId: string): Promise<StaffSessionState> {
    const familyKey = redisKeys.staffSession(familyId);
    const [rawFamily, rawDenied, rawTenantCutOff] = await this.command(() =>
      this.redis.mget(
        familyKey.key,
        redisKeys.staffDeny(familyId).key,
        redisKeys.staffDenyTenant(tenantId).key,
      ),
    );
    const family = parseFamily(rawFamily ?? null);
    if (rawFamily !== null && rawFamily !== undefined && family === undefined) {
      this.logger.warn({ familyId }, "staff.family_unreadable");
    }
    if (family === undefined) {
      return { family, revocations: NO_REVOCATIONS };
    }
    const [rawAccountCutOff, rawMemberCutOff] = await this.command(() =>
      this.redis.mget(
        redisKeys.staffDenyAccount(family.accountId).key,
        redisKeys.staffDenyMember(family.staffId).key,
      ),
    );
    return {
      family,
      revocations: Object.freeze({
        familyDenied: rawDenied !== null && rawDenied !== undefined,
        accountCutOff: this.cutOff(rawAccountCutOff, "account"),
        tenantCutOff: this.cutOff(rawTenantCutOff, "tenant"),
        memberCutOff: this.cutOff(rawMemberCutOff, "member"),
      }),
    };
  }

  /**
   * The checks of the staff guard for a verified access token of tenant `tenantId`: the family of `claims.sid`
   * (`401 UNAUTHENTICATED` when it ended, was revoked, or is not the token's member and role) and the cached
   * membership (`403 STAFF_MEMBERSHIP_INACTIVE`; a role change `401 UNAUTHENTICATED`). Reads only.
   */
  async authenticate(claims: StaffTokenClaims, tenantId: string): Promise<AuthenticatedStaff> {
    const state = await this.state(claims.sid, tenantId);
    const { family } = state;
    const mismatch = family !== undefined && (family.staffId !== claims.sub || family.role !== claims.role);
    const problem =
      familyProblem(state, tenantId, this.clock.now()) ?? (mismatch ? "token_mismatch" : undefined);
    if (problem !== undefined || family === undefined) {
      this.logger.info({ reason: problem, familyId: claims.sid }, "staff.session_refused");
      throw new AppError("UNAUTHENTICATED");
    }
    const member = await this.member(family.accountId, tenantId);
    const membership = membershipProblem(member, family);
    if (membership !== undefined || member === null) {
      this.logger.info(
        { reason: membership, familyId: family.id, staffId: family.staffId },
        "staff.session_refused",
      );
      throw membership === "role_changed"
        ? new AppError("UNAUTHENTICATED")
        : new AppError("STAFF_MEMBERSHIP_INACTIVE");
    }
    return { family, member };
  }

  /**
   * Rotates family `familyId` for the presented refresh token (`hash` its SHA-256): a new token when it is the current
   * one; `reused` (the family deleted and denied) when it was rotated already; `missing` or `invalid` otherwise.
   */
  async rotate(familyId: string, hash: string): Promise<RotationOutcome> {
    const next = newRefreshToken(familyId);
    const family = redisKeys.staffSession(familyId);
    const deny = redisKeys.staffDeny(familyId);
    const reply = await this.command(() =>
      this.redis.eval(
        ROTATE,
        2,
        family.key,
        deny.key,
        hash,
        next.hash,
        String(MAX_ROTATED_TOKENS),
        String(deny.ttlSeconds),
      ),
    );
    if (reply === "rotated") {
      return { outcome: "rotated", refreshToken: next.token };
    }
    if (reply === "reused" || reply === "missing" || reply === "invalid") {
      return { outcome: reply };
    }
    throw new AppError("SERVICE_UNAVAILABLE");
  }

  /** Whether `hash` is the SHA-256 of the current refresh token of family `familyId`, a rotated one, or neither. */
  async issuedByFamily(familyId: string, hash: string): Promise<"current" | "rotated" | "none"> {
    const family = redisKeys.staffSession(familyId);
    const reply = await this.command(() => this.redis.eval(ISSUED_BY_FAMILY, 1, family.key, hash));
    return reply === 2 ? "current" : reply === 1 ? "rotated" : "none";
  }

  /** Ends family `familyId`: deletes it and writes `staffdeny:<familyId>`, in one transaction. */
  async revoke(familyId: string): Promise<void> {
    const family = redisKeys.staffSession(familyId);
    const deny = redisKeys.staffDeny(familyId);
    const results = await this.command(() =>
      this.redis
        .multi([
          ["del", family.key],
          ["set", deny.key, "1", "EX", String(deny.ttlSeconds)],
        ])
        .exec(),
    );
    if (results === null || results.some(([error]) => error !== null)) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }
  }

  /**
   * The account's cut-off `staffdeny:acct:<accountId>` (epoch ms; `Infinity` when unreadable), or `undefined` without
   * one: console.auth.signIn refuses a portal token issued at or before it (the platform's "sign out everywhere" also
   * ends the tokens it issued in the 60 s before).
   */
  async accountCutOff(accountId: string): Promise<number | undefined> {
    const [raw] = await this.command(() => this.redis.mget(redisKeys.staffDenyAccount(accountId).key));
    return this.cutOff(raw, "account");
  }

  /** Ends every family of membership `staffId` created until now (`staffdeny:member:<staffId>`). */
  async revokeMember(staffId: string): Promise<void> {
    const key = redisKeys.staffDenyMember(staffId);
    await this.command(() =>
      this.redis.set(key.key, String(this.clock.now().getTime()), "EX", key.ttlSeconds),
    );
  }

  /** The membership of `accountId` in `tenantId` through the platform cache (60 s, invalidated by the platform). */
  member(accountId: string, tenantId: string): Promise<PlatformStaffMember | null> {
    return this.cache.membership(
      accountId,
      tenantId,
      () => this.platform.staffMember(accountId, tenantId),
      parseStaffMember,
    );
  }

  /** The membership read from the platform tables, past the cache (console.auth.signIn). */
  async freshMember(accountId: string, tenantId: string): Promise<PlatformStaffMember | null> {
    try {
      return await this.platform.staffMember(accountId, tenantId);
    } catch (error) {
      // As PlatformCache: a row the backend cannot read stays an error (500); a failure to read is 503.
      if (error instanceof AppError || error instanceof UnexpectedPlatformValueError) {
        throw error;
      }
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
  }

  /** A cut-off read back; an unreadable one is logged by kind (never its value) and refuses every family. */
  private cutOff(raw: string | null | undefined, kind: "account" | "tenant" | "member"): number | undefined {
    const value = cutOffOf(raw ?? null);
    if (value === Number.POSITIVE_INFINITY) {
      this.logger.warn({ kind }, "staff.cut_off_unreadable");
    }
    return value;
  }

  /** A Redis command; a failure is `503 SERVICE_UNAVAILABLE` (a revocation is never skipped). */
  private async command<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
  }
}
