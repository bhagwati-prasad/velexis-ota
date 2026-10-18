// The signed-in account's own routes (PBE-016; platform/docs/api-inventory.md §5, scope PF-06 AC1 and PF-07 AC1,
// PADR-0008 item 2, PADR-0015 item 3). `accountId` is always the caller's (`sub` of the access token), never a
// parameter, so nothing here can reach another account.
//
// - getMe (`portal_unverified`): the account with its active memberships (OTA id, key, name and status, and the role)
//   and the six milestone switches (`features`, featuresFor() of PADR-0015), the same `Account` a `PortalSession`
//   carries. An account that may no longer hold a session (disabled, erased) answers `401 UNAUTHENTICATED`, as a
//   refresh would.
// - updateMe (`portal_unverified`): `If-Match` must name the account's `version` (`412 PRECONDITION_FAILED` when
//   stale). The full name is trimmed and may not be blank, the time zone must be a zone of `reference.time_zones`
//   (`400 VALIDATION_FAILED` with field errors that never echo the value); the locale is checked by the schema. The
//   fields that really change are written with `version + 1` and one `account.updated` audit row of their before and
//   after values; a request that changes nothing writes nothing. The answer is the account as getMe shows it, with
//   its `ETag`. Architecture §6.3 publishes `account` only when an account is disabled or locked or its MFA or
//   password changes, so a profile change publishes no invalidation.
// - changePassword (`portal`): AuthModule owns the credentials, so `PasswordResetService.changePassword` does it, with
//   the family of the calling access token kept signed in.
// - listSessions (`portal_unverified`): the active refresh families of the account, portal and admin, newest sign-in
//   first, with `current` for the family of the calling access token.
// - revokeSession (`portal_unverified`): revokes one active family of the account (`logout`, audit
//   `auth.session_revoked`), so its refresh token stops working at once; a family of another account, an unknown one
//   or one that is revoked or has ended answers `404 NOT_FOUND`. It takes the locks of every change of a family, in
//   SessionsService's order: the account's `FOR KEY SHARE`, then the family's first row.
import { Inject, Injectable } from "@nestjs/common";
import { AppError, type FieldError } from "@velexis/errors";
import { AuditService } from "../audit/audit.service";
import { AccountsRepository, type AccountProfileChanges } from "../auth/accounts.repository";
import { PasswordResetService, type ChangePasswordRequest } from "../auth/password-reset.service";
import { SessionsRepository } from "../auth/sessions.repository";
import { maySignIn, toAccount, type Account } from "../auth/sessions.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches } from "../common/features";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import {
  profileChanges,
  profileRequestOf,
  toAccountSession,
  type AccountSessionList,
  type UpdateMeRequest,
} from "./accounts.mapper";

@Injectable()
export class AccountsService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly sessions: SessionsRepository,
    private readonly passwords: PasswordResetService,
    private readonly features: FeatureSwitches,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** getMe (see the file header). */
  async getMe(accountId: string): Promise<Account> {
    const record = await this.accounts.findPortalAccount(this.db, accountId);
    if (record === undefined || !maySignIn(record.status)) {
      throw new AppError("UNAUTHENTICATED");
    }
    return toAccount(record, this.features.features());
  }

  /** updateMe (see the file header): `expectedVersion` is the version `If-Match` names. */
  async updateMe(accountId: string, expectedVersion: number, request: UpdateMeRequest): Promise<Account> {
    const requested = await this.checkedProfile(request);
    return runInTransaction(this.db, async (trx) => {
      const current = await this.accounts.lockProfile(trx, accountId);
      if (current === undefined || !maySignIn(current.status)) {
        throw new AppError("UNAUTHENTICATED");
      }
      if (current.version !== expectedVersion) {
        throw new AppError("PRECONDITION_FAILED");
      }
      const changed = profileChanges(current, requested);
      if (changed !== undefined) {
        await this.accounts.updateProfile(trx, accountId, changed.changes, this.clock.now());
        await this.audit.record(trx, {
          actorType: "account",
          actorAccountId: accountId,
          action: "account.updated",
          targetType: "account",
          targetId: accountId,
          before: changed.before,
          after: changed.after,
        });
      }
      const record = await this.accounts.findPortalAccount(trx, accountId);
      if (record === undefined) {
        throw new AppError("UNAUTHENTICATED");
      }
      return toAccount(record, this.features.features());
    });
  }

  /** changePassword (see the file header): `currentFamilyId` is the `sid` of the caller's access token. */
  changePassword(accountId: string, currentFamilyId: string, request: ChangePasswordRequest): Promise<void> {
    return this.passwords.changePassword(accountId, currentFamilyId, request);
  }

  /** listSessions (see the file header): `currentFamilyId` is the `sid` of the caller's access token. */
  async listSessions(accountId: string, currentFamilyId: string): Promise<AccountSessionList> {
    const families = await this.sessions.listActiveFamilies(this.db, accountId, this.clock.now());
    return { data: families.map((family) => toAccountSession(family, currentFamilyId)) };
  }

  /** revokeSession (see the file header). */
  async revokeSession(accountId: string, familyId: string): Promise<void> {
    await runInTransaction(this.db, async (trx) => {
      if (!(await this.accounts.lockForSessionChange(trx, accountId))) {
        throw new AppError("NOT_FOUND");
      }
      // Read without a lock first, filtered by the account, so a stranger's family is never locked.
      const family = await this.sessions.findActiveFamily(trx, accountId, familyId, this.clock.now());
      if (family === undefined) {
        throw new AppError("NOT_FOUND");
      }
      await this.sessions.lockFamily(trx, familyId);
      const now = this.clock.now();
      // A reuse of a rotated token may have revoked the family while this request waited for its lock.
      if ((await this.sessions.revokeFamily(trx, familyId, "logout", now)) === 0) {
        throw new AppError("NOT_FOUND");
      }
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "auth.session_revoked",
        targetType: "session",
        targetId: familyId,
        details: { audience: family.audience },
      });
    });
  }

  /**
   * The columns of an update request after the checks the schema cannot make: a full name that is not blank once
   * trimmed, and a time zone of `reference.time_zones`, by value and stored as sent. Problems answer `400
   * VALIDATION_FAILED` with field errors that never echo the value.
   */
  private async checkedProfile(request: UpdateMeRequest): Promise<AccountProfileChanges> {
    const requested = profileRequestOf(request);
    const fieldErrors: FieldError[] = [];
    if (requested.full_name === "") {
      fieldErrors.push({ path: "/fullName", code: "blank", message: "Enter your full name." });
    }
    if (
      requested.time_zone !== undefined &&
      !(await this.accounts.timeZoneExists(this.db, requested.time_zone))
    ) {
      fieldErrors.push({
        path: "/timeZone",
        code: "unknown",
        message: "Must be an IANA time zone of the reference data.",
      });
    }
    if (fieldErrors.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors });
    }
    return requested;
  }
}
