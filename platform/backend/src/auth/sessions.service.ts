// Portal sessions (PBE-014; platform/docs/flows/signup-and-create-ota.md step 4, scope PF-03 AC1 and AC3, PF-06 AC2,
// PADR-0009 item 4, PADR-0007 item 6, ADR-0008 "Refresh tokens", architecture §3.1): the refresh families of
// `account_sessions` and the `PortalSession` answers built on them.
//
// - A sign-in starts a family (`startPortalFamily`): its first row, `audience = 'portal'`, with the SHA-256 of an
//   opaque 256-bit refresh token (`rt_…`), the end user's user agent and IP (request context, PADR-0019), an absolute
//   end 30 days later (`family_expires_at`) and an idle expiry of 7 days for the token (never after the family's end).
// - `portalSession` answers a family: a 15-minute access token (`sid` = the family, `ev` from the account, `amr`
//   `["pwd"]` or `["pwd","otp"]`, `mfa_at` from `mfa_verified_at`), the refresh token and the `Account`.
// - refreshSession (`refresh`) rotates on use: the presented row is marked rotated and the next generation of the
//   family is written with a new token. Presenting a token that was rotated already revokes the whole family (`401
//   REFRESH_TOKEN_REUSED`, committed before the answer, so the newest token of the family stops working too). An
//   unknown, revoked or expired token, a family past its end, an admin family, or an account that may no longer hold
//   a session (disabled, erased) answers `401 REFRESH_TOKEN_INVALID` and changes nothing.
// - signOut revokes the family of the presented refresh token when it is a portal family of the caller; anything else
//   changes nothing (the answer is `204` either way).
// - signOutEverywhere writes the OTA cut-off `staffdeny:acct:<accountId>` = now in epoch milliseconds (30 days, so
//   the OTA backend revokes the account's OTA admin staff sessions), then revokes every family of the account, portal
//   and admin alike, audits `auth.signed_out_everywhere` and publishes an `account` invalidation after the commit.
//   The cut-off is written first: if Redis fails nothing is revoked and the call fails; if the database fails the
//   staff sessions are still cut off, which errs on the safe side.
//
// Concurrency: every change of a family takes the account's `FOR KEY SHARE` lock, then the lock of the family's first
// row, then the presented row; sign-out everywhere takes the account's `FOR UPDATE` lock. So a revocation never misses
// a generation that a concurrent rotation is writing, two refreshes with one token run one after the other (the second
// is a reuse), and the locks are always taken in the same order (no deadlock).
//
// Refresh tokens and access tokens are never logged, audited or stored in clear.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AuditService } from "../audit/audit.service";
import type { PlatformTransaction } from "../audit/audit.repository";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches, type MilestoneFeatures } from "../common/features";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { redisKeys, setKey } from "../common/redis/redis-keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { AccountsRepository, type AccountStatus, type PortalAccountRecord } from "./accounts.repository";
import { SessionsRepository, type SessionAudience, type SessionRecord } from "./sessions.repository";
import { TokenService, type AuthMethod } from "./token.service";

export type PortalSession = components["schemas"]["PortalSession"];
export type Account = components["schemas"]["Account"];
export type RefreshSessionRequest = components["schemas"]["RefreshSessionRequest"];
export type SignOutRequest = components["schemas"]["SignOutRequest"];
type AccountMembership = components["schemas"]["AccountMembership"];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The absolute lifetime of a portal family (PADR-0009 item 4). */
export const PORTAL_FAMILY_TTL_MS = 30 * DAY_MS;

/** The idle expiry of one portal refresh token (PADR-0009 item 4). */
export const PORTAL_REFRESH_TOKEN_TTL_MS = 7 * DAY_MS;

/** The prefix of refresh tokens (`rt_…`, as @velexis/crypto's `generateToken` documents it). */
export const REFRESH_TOKEN_PREFIX = "rt";

/** The longest refresh token looked up: the `OpaqueToken` schema's `maxLength`. */
const MAX_REFRESH_TOKEN_LENGTH = 512;

/** The account states that may hold a portal session: verified accounts and accounts that wait for verification. */
export const SESSION_ACCOUNT_STATUSES: readonly AccountStatus[] = Object.freeze([
  "active",
  "pending_verification",
]);

/** True when an account of `status` may sign in and refresh its sessions. */
export function maySignIn(status: string): boolean {
  return (SESSION_ACCOUNT_STATUSES as readonly string[]).includes(status);
}

/** When a refresh token issued at `now` stops working: its idle expiry, never after the family's end. */
export function refreshTokenExpiry(
  now: Date,
  familyExpiresAt: Date,
  idleMs = PORTAL_REFRESH_TOKEN_TTL_MS,
): Date {
  return new Date(Math.min(now.getTime() + idleMs, familyExpiresAt.getTime()));
}

/** What `refresh` does with a presented row: rotate it, revoke its family (a reuse), or refuse it. */
export type RefreshVerdict = "rotate" | "reused" | "invalid";

/**
 * The verdict for the row of a presented refresh token at `now`, on the `audience` surface. A rotated row is a reuse
 * whatever else holds (also when its family is revoked or expired: the reuse is still reported); otherwise a row of
 * the other surface, a revoked row, or one past its own or its family's expiry is invalid.
 */
export function refreshVerdict(
  row: Pick<SessionRecord, "audience" | "rotated_at" | "revoked_at" | "expires_at" | "family_expires_at">,
  now: Date,
  audience: SessionAudience,
): RefreshVerdict {
  if (row.audience !== audience) {
    return "invalid";
  }
  if (row.rotated_at !== null) {
    return "reused";
  }
  if (
    row.revoked_at !== null ||
    row.expires_at.getTime() <= now.getTime() ||
    (row.family_expires_at !== null && row.family_expires_at.getTime() <= now.getTime())
  ) {
    return "invalid";
  }
  return "rotate";
}

/** The `amr` of a family: the password, and the TOTP code when the family verified one. */
export function authMethodsOf(mfaVerifiedAt: Date | null): AuthMethod[] {
  return mfaVerifiedAt === null ? ["pwd"] : ["pwd", "otp"];
}

/** The `mfa_at` claim of a family: its last TOTP verification in epoch seconds, if any. */
export function mfaAtOf(mfaVerifiedAt: Date | null): number | undefined {
  return mfaVerifiedAt === null ? undefined : Math.floor(mfaVerifiedAt.getTime() / 1000);
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The `Account` of the document for a record of `AccountsRepository.findPortalAccount` and the process's switches. */
export function toAccount(record: PortalAccountRecord, features: MilestoneFeatures): Account {
  return {
    id: record.id,
    email: record.email,
    emailVerified: record.email_verified_at !== null,
    fullName: record.full_name,
    locale: record.locale,
    timeZone: record.time_zone,
    mfaEnabled: record.mfa_enabled,
    mfaEnabledAt: iso(record.mfa_enabled_at),
    isPlatformAdmin: record.is_platform_admin,
    createdAt: record.created_at.toISOString(),
    version: record.version,
    memberships: record.memberships.map((membership): AccountMembership => ({
      membershipId: membership.membership_id,
      tenantId: membership.tenant_id,
      tenantKey: membership.tenant_key,
      tenantName: membership.tenant_name,
      tenantStatus: membership.tenant_status as AccountMembership["tenantStatus"],
      role: membership.role as AccountMembership["role"],
    })),
    features,
  };
}

/** A family's newest generation as the service hands it out: the refresh token itself exists only here. */
export interface IssuedRefreshToken {
  readonly accountId: string;
  /** `asn_…` of the family's first row: the `sid` of its access tokens. */
  readonly familyId: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  /** The family's last TOTP verification, if any. */
  readonly mfaVerifiedAt: Date | null;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly sessions: SessionsRepository,
    private readonly accounts: AccountsRepository,
    private readonly tokens: TokenService,
    private readonly features: FeatureSwitches,
    private readonly audit: AuditService,
    private readonly publisher: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly context: RequestContext,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectPinoLogger(SessionsService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Starts a portal family of `accountId` at `now`, in `trx` (the sign-in's transaction): its first row and refresh
   * token. `mfaVerifiedAt` is the TOTP verification of an MFA sign-in (PBE-015), `null` for a password-only one.
   */
  async startPortalFamily(
    trx: PlatformTransaction,
    accountId: string,
    options: { readonly mfaVerifiedAt: Date | null },
    now: Date,
  ): Promise<IssuedRefreshToken> {
    const familyId = this.ids.new("asn");
    const familyExpiresAt = new Date(now.getTime() + PORTAL_FAMILY_TTL_MS);
    const { token, hash } = generateToken(REFRESH_TOKEN_PREFIX);
    const expiresAt = refreshTokenExpiry(now, familyExpiresAt);
    await this.sessions.insert(trx, {
      id: familyId,
      accountId,
      familyId,
      audience: "portal",
      refreshTokenHash: hash,
      userAgent: this.context.userAgent ?? null,
      ipAddress: this.context.ip ?? null,
      expiresAt,
      familyExpiresAt,
      mfaVerifiedAt: options.mfaVerifiedAt,
      now,
    });
    return {
      accountId,
      familyId,
      refreshToken: token,
      refreshTokenExpiresAt: expiresAt,
      mfaVerifiedAt: options.mfaVerifiedAt,
    };
  }

  /**
   * The `PortalSession` answer of `issued`: a new access token of its family and the account, read in `trx` unless the
   * caller read it already (`account`). Throws when the account is gone (a programming error: the caller holds its
   * family).
   */
  async portalSession(
    trx: PlatformTransaction,
    issued: IssuedRefreshToken,
    account?: PortalAccountRecord,
  ): Promise<PortalSession> {
    const record = account ?? (await this.accounts.findPortalAccount(trx, issued.accountId));
    if (record?.id !== issued.accountId) {
      throw new Error("SessionsService.portalSession: the account of the family does not exist");
    }
    const mfaAt = mfaAtOf(issued.mfaVerifiedAt);
    const access = await this.tokens.sign({
      aud: "portal",
      sub: record.id,
      sid: issued.familyId,
      ev: record.email_verified_at !== null,
      amr: authMethodsOf(issued.mfaVerifiedAt),
      ...(mfaAt === undefined ? {} : { mfa_at: mfaAt }),
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: issued.refreshToken,
      refreshTokenExpiresAt: issued.refreshTokenExpiresAt.toISOString(),
      account: toAccount(record, this.features.features()),
    };
  }

  /** refreshSession (see the file header). */
  async refresh(refreshToken: string): Promise<PortalSession> {
    if (refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) {
      throw new AppError("REFRESH_TOKEN_INVALID");
    }
    const tokenHash = sha256Hex(refreshToken);
    const outcome = await runInTransaction(
      this.db,
      async (trx): Promise<{ readonly session: PortalSession } | { readonly reused: SessionRecord }> => {
        const seen = await this.sessions.findByTokenHash(trx, tokenHash);
        if (seen === undefined || seen.audience !== ("portal" satisfies SessionAudience)) {
          throw new AppError("REFRESH_TOKEN_INVALID");
        }
        await this.accounts.lockForSessionChange(trx, seen.account_id);
        await this.sessions.lockFamily(trx, seen.family_id);
        // Read again under the locks: a rotation or revocation that committed meanwhile is seen now.
        const row = await this.sessions.lockByTokenHash(trx, tokenHash);
        const now = this.clock.now();
        const verdict = row === undefined ? "invalid" : refreshVerdict(row, now, "portal");
        if (row === undefined || verdict === "invalid") {
          throw new AppError("REFRESH_TOKEN_INVALID");
        }
        if (verdict === "reused") {
          await this.sessions.revokeFamily(trx, row.family_id, "rotation_reuse", now);
          return { reused: row };
        }
        const account = await this.accounts.findPortalAccount(trx, row.account_id);
        if (account === undefined || !maySignIn(account.status)) {
          throw new AppError("REFRESH_TOKEN_INVALID");
        }
        const issued = await this.rotate(trx, row, now);
        return { session: await this.portalSession(trx, issued, account) };
      },
    );
    if ("reused" in outcome) {
      // Ids only: the token is never logged.
      this.logger.warn(
        { accountId: outcome.reused.account_id, familyId: outcome.reused.family_id },
        "auth.refresh_token_reused",
      );
      throw new AppError("REFRESH_TOKEN_REUSED");
    }
    return outcome.session;
  }

  /** signOut (see the file header): `accountId` is the caller's, from the access token. */
  async signOut(accountId: string, refreshToken: string): Promise<void> {
    if (refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) {
      return;
    }
    const tokenHash = sha256Hex(refreshToken);
    await runInTransaction(this.db, async (trx) => {
      const seen = await this.sessions.findByTokenHash(trx, tokenHash);
      if (
        seen === undefined ||
        seen.account_id !== accountId ||
        seen.audience !== ("portal" satisfies SessionAudience)
      ) {
        return;
      }
      await this.accounts.lockForSessionChange(trx, accountId);
      await this.sessions.lockFamily(trx, seen.family_id);
      await this.sessions.revokeFamily(trx, seen.family_id, "logout", this.clock.now());
    });
  }

  /** signOutEverywhere (see the file header): `accountId` is the caller's, from the access token. */
  async signOutEverywhere(accountId: string): Promise<void> {
    const cutOff = this.clock.now();
    await setKey(this.redis, redisKeys.staffDenyAccount(accountId), String(cutOff.getTime()));
    await runInTransaction(this.db, async (trx) => {
      const account = await this.accounts.lockForUpdate(trx, accountId);
      if (account === undefined) {
        return;
      }
      const now = this.clock.now();
      const revokedFamilies = await this.sessions.revokeAllOfAccount(trx, accountId, "logout", now);
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "auth.signed_out_everywhere",
        targetType: "account",
        targetId: accountId,
        details: { revokedFamilies, staffDenyFrom: cutOff.toISOString() },
      });
      this.publisher.publishAfterCommit(trx, { v: 1, type: "account", accountId });
    });
  }

  /**
   * Rotates `row` (locked, verdict `rotate`) at `now`, in `trx`: the family's next generation with a new token and
   * the same family end and TOTP verification, and `row` marked rotated and replaced by it.
   */
  private async rotate(trx: PlatformTransaction, row: SessionRecord, now: Date): Promise<IssuedRefreshToken> {
    // A portal row always has a family end (startPortalFamily); an older row without one ends with its own expiry.
    const familyExpiresAt = row.family_expires_at ?? row.expires_at;
    const { token, hash } = generateToken(REFRESH_TOKEN_PREFIX);
    const expiresAt = refreshTokenExpiry(now, familyExpiresAt);
    const id = this.ids.new("asn");
    await this.sessions.insert(trx, {
      id,
      accountId: row.account_id,
      familyId: row.family_id,
      audience: "portal",
      refreshTokenHash: hash,
      // The family's device: the user agent and IP of the sign-in, as the columns document them.
      userAgent: row.user_agent,
      ipAddress: row.ip_address,
      expiresAt,
      familyExpiresAt,
      mfaVerifiedAt: row.mfa_verified_at,
      now,
    });
    await this.sessions.markRotated(trx, row.id, id, now);
    return {
      accountId: row.account_id,
      familyId: row.family_id,
      refreshToken: token,
      refreshTokenExpiresAt: expiresAt,
      mfaVerifiedAt: row.mfa_verified_at,
    };
  }
}
