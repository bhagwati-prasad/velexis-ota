// Account support and platform admins in the platform admin (PBE-032; platform/docs/api-inventory-admin.md §7,
// flows/platform-admin-operations.md §H, PADR-0006 "Access" items 3 to 6, scope PF-86 and PF-87). AuthModule owns the
// accounts and their sessions and AccountsModule the recovery codes, so this service works through their exported
// repositories; it owns the transactions, their audit rows (`actor_type = 'platform_admin'`, the caller's account,
// `target_type = 'account'`, one row per change) and what follows a commit. AdminAuthGuard has checked that the caller
// is an active platform admin; RecentMfaGuard the step-up of the operations marked `x-mfa-step-up`.
//
// - adminListAccounts: newest first, `q` (part of the e-mail address or the name, ignoring letter case) and `status`;
//   an opaque cursor of the last account's id (`400` on `/query/cursor` for anything else).
// - adminGetAccount: the account, its active memberships, the number of its active sessions (portal and admin
//   families that are neither revoked nor expired at the Clock's time) and its last 50 audit rows.
// - adminDisableAccount (reason): never the caller (`403 FORBIDDEN`, `self`) nor the last active platform admin
//   (`last_admin`); `409 CONFLICT` (`not_enabled`) for a `disabled` or `deleted` account. The OTA cut-off
//   `staffdeny:acct:<id>` is written first, as signOutEverywhere, the password reset and `admin:reset-mfa` do (if Redis
//   fails nothing changes; if the database fails afterwards the staff sessions are cut off anyway, the safe side), after
//   a read that refuses what the transaction would refuse, so a refused request cuts nothing off. Then one transaction:
//   the status `disabled` (`version + 1`), every session family of the account revoked (`admin`), the audit row
//   `account.disabled` and, after the commit, an `account` invalidation.
// - adminEnableAccount (reason): only a `disabled` account (`409`, `not_disabled`); back to `active`, or to
//   `pending_verification` when the address was never verified. Revoked sessions stay revoked. Audit `account.enabled`,
//   `account` invalidation.
// - adminUnlockAccount: clears the failure count and the lockout, locked or not (the answer is the account either
//   way); audit `account.unlocked` with the counters before and after.
// - adminResetAccountMfa (reason, step-up): refused for a platform admin (`403`, `platform_admin`: another admin
//   revokes the rights first, or the developer runs `admin:reset-mfa`), `409` (`mfa_not_enabled`) without MFA. The
//   cut-off first, as for a disable; then one transaction: MFA off (secret erased, `version + 1`), recovery codes
//   deleted, every session revoked (`admin`), the `auth.mfa_changed` e-mail queued, the audit row `account.mfa_reset`;
//   after the commit an `account` invalidation.
// - adminListAdmins: every account with `is_platform_admin`, by name.
// - adminGrantAdmin (reason, step-up): the account of the address (`404`), not an admin yet (`409`, `already_admin`),
//   with a verified address (`422`, `email_not_verified`), `active` (`account_not_active`) and MFA on
//   (`mfa_not_enabled`), as `admin:grant` requires. Audit `admin.granted`.
// - adminRevokeAdmin (step-up, optional reason): a platform admin (`404` otherwise), never the caller (`403`, `self`)
//   nor the last active platform admin (`last_admin`). One transaction clears `is_platform_admin` (`version + 1`) and
//   revokes the account's admin families (`admin`); its portal sessions stay. AdminAuthGuard re-reads the flag on every
//   request, so its admin tokens stop working at once. Audit `admin.revoked`.
//
// Disable and revoke lock every active platform admin first (in id order), then the target: two admins who disable or
// revoke each other at the same time run one after the other, and the second sees that only one admin is left. The
// target's `FOR UPDATE` lock also waits for any change of its session families in progress (they hold the account's
// `FOR KEY SHARE` lock), as signOutEverywhere does, so a revocation never misses a generation being written. No
// password, token, TOTP secret or recovery code is read, logged or audited here.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { MFA_CHANGES } from "../accounts/mfa.service";
import { RecoveryCodesRepository } from "../accounts/recovery-codes.repository";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditQueryService } from "../audit/audit-query.service";
import { AuditService } from "../audit/audit.service";
import {
  AccountsRepository,
  type AccountMembershipRecord,
  type AccountStatus,
  type AdminAccountRecord,
} from "../auth/accounts.repository";
import { SessionsRepository } from "../auth/sessions.repository";
import type { AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { redisKeys, setKey } from "../common/redis/redis-keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { OutboxService } from "../notifications/outbox.service";
import { isActiveAdmin } from "./admin-auth.service";

export type AdminAccount = components["schemas"]["AdminAccount"];
export type AdminAccountList = components["schemas"]["AdminAccountList"];
export type AdminAccountDetail = components["schemas"]["AdminAccountDetail"];
export type AdminAccountSummary = components["schemas"]["AdminAccountSummary"];
export type PlatformAdmin = components["schemas"]["PlatformAdmin"];
export type PlatformAdminList = components["schemas"]["PlatformAdminList"];
export type GrantAdminRequest = components["schemas"]["GrantAdminRequest"];
export type AdminReasonRequest = components["schemas"]["AdminReasonRequest"];
type AccountMembership = components["schemas"]["AccountMembership"];

/** The query of adminListAccounts, as the validation interceptor passes it on (`limit` defaults to 50). */
export interface ListAccountsQuery {
  readonly q?: string | undefined;
  readonly status?: AccountStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The caller: the admin of the access token. */
type Caller = Pick<AccessTokenClaims, "sub">;

/** The page size without `limit` (the document's default). */
export const DEFAULT_ACCOUNT_PAGE_LIMIT = 50;

/** The states a disable refuses (`409 CONFLICT`, `not_enabled`). */
const NOT_ENABLED_STATUSES: ReadonlySet<string> = new Set<AccountStatus>(["disabled", "deleted"]);

/** The states a disable starts from. */
const DISABLEABLE_STATUSES: readonly AccountStatus[] = Object.freeze([
  "pending_verification",
  "active",
  "locked",
]);

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The API's `AdminAccount` of a row. */
export function toAdminAccount(row: AdminAccountRecord): AdminAccount {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    fullName: row.full_name,
    locale: row.locale,
    timeZone: row.time_zone,
    status: row.status as AdminAccount["status"],
    mfaEnabled: row.mfa_enabled,
    mfaEnabledAt: iso(row.mfa_enabled_at),
    isPlatformAdmin: row.is_platform_admin,
    failedLoginCount: row.failed_login_count,
    lockedUntil: iso(row.locked_until),
    lastLoginAt: iso(row.last_login_at),
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

/** The API's `AdminAccountSummary` of a row (the search). */
export function toAdminAccountSummary(row: AdminAccountRecord): AdminAccountSummary {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status as AdminAccountSummary["status"],
    mfaEnabled: row.mfa_enabled,
    isPlatformAdmin: row.is_platform_admin,
    lastLoginAt: iso(row.last_login_at),
    createdAt: row.created_at.toISOString(),
  };
}

/** The API's `PlatformAdmin` of a row. */
export function toPlatformAdmin(row: AdminAccountRecord): PlatformAdmin {
  return {
    accountId: row.id,
    email: row.email,
    fullName: row.full_name,
    mfaEnabled: row.mfa_enabled,
    lastLoginAt: iso(row.last_login_at),
  };
}

function toAccountMembership(row: AccountMembershipRecord): AccountMembership {
  return {
    membershipId: row.membership_id,
    tenantId: row.tenant_id,
    tenantKey: row.tenant_key,
    tenantName: row.tenant_name,
    tenantStatus: row.tenant_status as AccountMembership["tenantStatus"],
    role: row.role as AccountMembership["role"],
  };
}

/** An opaque cursor: base64url of `{"id": "<account id>"}`, the last account of the page. */
export function encodeAccountCursor(accountId: string): string {
  return Buffer.from(JSON.stringify({ id: accountId }), "utf8").toString("base64url");
}

const ACCOUNT_ID = /^acc_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The account id of a cursor of this list, or `undefined` when it is not one. */
export function decodeAccountCursor(cursor: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const id: unknown = (value as Record<string, unknown>)["id"];
    return Object.keys(value).length === 1 && typeof id === "string" && ACCOUNT_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function invalidCursor(): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "Is not a cursor of this list." }],
  });
}

function forbidden(reason: "self" | "last_admin" | "platform_admin"): AppError<"FORBIDDEN"> {
  return new AppError("FORBIDDEN", { details: { reason } });
}

function conflict(
  reason: "not_enabled" | "not_disabled" | "mfa_not_enabled" | "already_admin",
): AppError<"CONFLICT"> {
  return new AppError("CONFLICT", { details: { reason } });
}

function unprocessable(
  reason: "account_not_active" | "email_not_verified" | "mfa_not_enabled",
): AppError<"UNPROCESSABLE"> {
  return new AppError("UNPROCESSABLE", { details: { reason } });
}

/** True when the account is `disabled` or erased: a disable has nothing to do. */
function isNotEnabled(account: Pick<AdminAccountRecord, "status" | "deleted_at">): boolean {
  return account.deleted_at !== null || NOT_ENABLED_STATUSES.has(account.status);
}

@Injectable()
export class AdminAccountsService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly sessions: SessionsRepository,
    private readonly recoveryCodes: RecoveryCodesRepository,
    private readonly audit: AuditService,
    private readonly auditQueries: AuditQueryService,
    private readonly outbox: OutboxService,
    private readonly publisher: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** adminListAccounts (see the file header). */
  async list(query: ListAccountsQuery): Promise<AdminAccountList> {
    const limit = query.limit ?? DEFAULT_ACCOUNT_PAGE_LIMIT;
    let afterId: string | undefined;
    if (query.cursor !== undefined) {
      afterId = decodeAccountCursor(query.cursor);
      if (afterId === undefined || (await this.accounts.findAdminAccount(this.db, afterId)) === undefined) {
        throw invalidCursor();
      }
    }
    const rows = await this.accounts.searchForAdmin(
      this.db,
      { q: query.q, status: query.status },
      afterId,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAdminAccountSummary),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeAccountCursor(last.id) : null,
        limit,
      },
    };
  }

  /** adminGetAccount (see the file header). */
  async get(accountId: string): Promise<AdminAccountDetail> {
    const account = await this.accounts.findAdminAccount(this.db, accountId);
    if (account === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const [memberships, families, recentAudit] = await Promise.all([
      this.accounts.listActiveMemberships(this.db, accountId),
      this.sessions.listActiveFamilies(this.db, accountId, this.clock.now()),
      this.auditQueries.recentForAccount(accountId),
    ]);
    return {
      account: toAdminAccount(account),
      memberships: memberships.map(toAccountMembership),
      activeSessions: families.length,
      recentAudit,
    };
  }

  /** adminDisableAccount (see the file header). */
  async disable(caller: Caller, accountId: string, request: AdminReasonRequest): Promise<AdminAccount> {
    // The refusals first, so a refused request writes no cut-off; the transaction checks them again under its locks.
    const seen = await this.accounts.findAdminAccount(this.db, accountId);
    if (seen === undefined) {
      throw new AppError("NOT_FOUND");
    }
    this.refuseSelf(caller, accountId);
    if (isNotEnabled(seen)) {
      throw conflict("not_enabled");
    }
    if (isActiveAdmin(seen) && (await this.accounts.countActivePlatformAdmins(this.db)) <= 1) {
      throw forbidden("last_admin");
    }
    const cutOff = await this.cutOffStaffSessions(accountId);
    return runInTransaction(this.db, async (trx) => {
      const admins = await this.accounts.lockActivePlatformAdmins(trx);
      const account = await this.lockExisting(trx, accountId);
      if (isNotEnabled(account)) {
        throw conflict("not_enabled");
      }
      if (isActiveAdmin(account) && admins.length <= 1) {
        throw forbidden("last_admin");
      }
      const now = this.clock.now();
      await this.accounts.setStatus(trx, accountId, DISABLEABLE_STATUSES, "disabled", now);
      const revokedFamilies = await this.sessions.revokeAllOfAccount(trx, accountId, "admin", now);
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "account.disabled",
        targetType: "account",
        targetId: accountId,
        before: { status: account.status },
        after: { status: "disabled" },
        details: { reason: request.reason, revokedFamilies, staffDenyFrom: cutOff.toISOString() },
      });
      this.publisher.publishAfterCommit(trx, { v: 1, type: "account", accountId });
      return this.reread(trx, accountId);
    });
  }

  /** adminEnableAccount (see the file header). */
  async enable(caller: Caller, accountId: string, request: AdminReasonRequest): Promise<AdminAccount> {
    return runInTransaction(this.db, async (trx) => {
      const account = await this.lockExisting(trx, accountId);
      if (account.status !== "disabled" || account.deleted_at !== null) {
        throw conflict("not_disabled");
      }
      const status: AccountStatus = account.email_verified_at === null ? "pending_verification" : "active";
      await this.accounts.setStatus(trx, accountId, ["disabled"], status, this.clock.now());
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "account.enabled",
        targetType: "account",
        targetId: accountId,
        before: { status: "disabled" },
        after: { status },
        details: { reason: request.reason },
      });
      this.publisher.publishAfterCommit(trx, { v: 1, type: "account", accountId });
      return this.reread(trx, accountId);
    });
  }

  /** adminUnlockAccount (see the file header). */
  async unlock(caller: Caller, accountId: string): Promise<AdminAccount> {
    return runInTransaction(this.db, async (trx) => {
      const account = await this.lockExisting(trx, accountId);
      const now = this.clock.now();
      await this.accounts.clearLockout(trx, accountId, now);
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "account.unlocked",
        targetType: "account",
        targetId: accountId,
        before: { failedLoginCount: account.failed_login_count, lockedUntil: iso(account.locked_until) },
        after: { failedLoginCount: 0, lockedUntil: null },
        details: {
          wasLocked: account.locked_until !== null && account.locked_until.getTime() > now.getTime(),
        },
      });
      return this.reread(trx, accountId);
    });
  }

  /** adminResetAccountMfa (see the file header): RecentMfaGuard has checked the caller's step-up. */
  async resetMfa(caller: Caller, accountId: string, request: AdminReasonRequest): Promise<AdminAccount> {
    const seen = await this.accounts.findAdminAccount(this.db, accountId);
    if (seen === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (seen.is_platform_admin) {
      throw forbidden("platform_admin");
    }
    if (!seen.mfa_enabled) {
      throw conflict("mfa_not_enabled");
    }
    const cutOff = await this.cutOffStaffSessions(accountId);
    return runInTransaction(this.db, async (trx) => {
      const account = await this.lockExisting(trx, accountId);
      if (account.is_platform_admin) {
        throw forbidden("platform_admin");
      }
      const now = this.clock.now();
      if (!(await this.accounts.disableMfa(trx, accountId, now))) {
        throw conflict("mfa_not_enabled");
      }
      const recoveryCodesRemoved = await this.recoveryCodes.deleteAll(trx, accountId);
      const revokedFamilies = await this.sessions.revokeAllOfAccount(trx, accountId, "admin", now);
      await this.outbox.queue(trx, {
        templateKey: "auth.mfa_changed",
        to: account.email,
        accountId,
        data: { fullName: account.full_name, change: MFA_CHANGES.disabled },
      });
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "account.mfa_reset",
        targetType: "account",
        targetId: accountId,
        before: { mfaEnabled: true },
        after: { mfaEnabled: false },
        details: {
          reason: request.reason,
          recoveryCodesRemoved,
          revokedFamilies,
          staffDenyFrom: cutOff.toISOString(),
        },
      });
      this.publisher.publishAfterCommit(trx, { v: 1, type: "account", accountId });
      return this.reread(trx, accountId);
    });
  }

  /** adminListAdmins (see the file header). */
  async listAdmins(): Promise<PlatformAdminList> {
    const rows = await this.accounts.listPlatformAdmins(this.db);
    return { data: rows.map(toPlatformAdmin) };
  }

  /** adminGrantAdmin (see the file header): RecentMfaGuard has checked the caller's step-up. */
  async grantAdmin(caller: Caller, request: GrantAdminRequest): Promise<PlatformAdmin> {
    return runInTransaction(this.db, async (trx) => {
      const identity = await this.accounts.findByEmail(trx, request.email);
      const account =
        identity === undefined ? undefined : await this.accounts.lockMfaAccount(trx, identity.id);
      if (identity === undefined || account === undefined || account.deleted_at !== null) {
        throw new AppError("NOT_FOUND");
      }
      if (account.is_platform_admin) {
        throw conflict("already_admin");
      }
      if (identity.email_verified_at === null || account.status === "pending_verification") {
        throw unprocessable("email_not_verified");
      }
      if (account.status !== "active") {
        throw unprocessable("account_not_active");
      }
      if (!account.mfa_enabled || account.mfa_secret_ciphertext === null) {
        throw unprocessable("mfa_not_enabled");
      }
      if (!(await this.accounts.grantPlatformAdmin(trx, account.id, this.clock.now()))) {
        throw conflict("already_admin");
      }
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "admin.granted",
        targetType: "account",
        targetId: account.id,
        before: { isPlatformAdmin: false },
        after: { isPlatformAdmin: true },
        details: { reason: request.reason },
      });
      const granted = await this.accounts.findAdminAccount(trx, account.id);
      if (granted === undefined) {
        throw new AppError("NOT_FOUND");
      }
      return toPlatformAdmin(granted);
    });
  }

  /** adminRevokeAdmin (see the file header): RecentMfaGuard has checked the caller's step-up. */
  async revokeAdmin(caller: Caller, accountId: string, reason: string | undefined): Promise<void> {
    await runInTransaction(this.db, async (trx) => {
      const admins = await this.accounts.lockActivePlatformAdmins(trx);
      const account = await this.accounts.lockAdminAccount(trx, accountId);
      if (account === undefined || !account.is_platform_admin) {
        throw new AppError("NOT_FOUND");
      }
      this.refuseSelf(caller, accountId);
      if (isActiveAdmin(account) && admins.length <= 1) {
        throw forbidden("last_admin");
      }
      const now = this.clock.now();
      await this.accounts.revokePlatformAdmin(trx, accountId, now);
      const revokedFamilies = await this.sessions.revokeAllOfAccountForAudience(
        trx,
        accountId,
        "platform_admin",
        "admin",
        now,
      );
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "admin.revoked",
        targetType: "account",
        targetId: accountId,
        before: { isPlatformAdmin: true },
        after: { isPlatformAdmin: false },
        details: { ...(reason === undefined ? {} : { reason }), revokedFamilies },
      });
    });
  }

  /** `403 FORBIDDEN` (`self`) when the caller acts on their own account. */
  private refuseSelf(caller: Caller, accountId: string): void {
    if (caller.sub === accountId) {
      throw forbidden("self");
    }
  }

  /** The account, locked for the rest of `trx`; `404` when there is none. */
  private async lockExisting(trx: PlatformTransaction, accountId: string): Promise<AdminAccountRecord> {
    const account = await this.accounts.lockAdminAccount(trx, accountId);
    if (account === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return account;
  }

  /** The account as the transaction sees it after its change, for the answer. */
  private async reread(trx: PlatformTransaction, accountId: string): Promise<AdminAccount> {
    const account = await this.accounts.findAdminAccount(trx, accountId);
    if (account === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return toAdminAccount(account);
  }

  /**
   * Writes the OTA cut-off `staffdeny:acct:<accountId>` = now (epoch milliseconds, 30 days) and returns its time: the
   * OTA backend then ends the account's OTA admin staff sessions (architecture §6.4).
   */
  private async cutOffStaffSessions(accountId: string): Promise<Date> {
    const cutOff = this.clock.now();
    await setKey(this.redis, redisKeys.staffDenyAccount(accountId), String(cutOff.getTime()));
    return cutOff;
  }
}
