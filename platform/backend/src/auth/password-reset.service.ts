// Password reset and change (PBE-016; platform/docs/scope.md PF-05, api-inventory §4 and §5, ADR-0008 "Passwords",
// PADR-0008 item 6, PADR-0007 item 6, flows/team-and-ota-admin-sso.md §D). AuthModule owns the credentials of an
// account, so the change of a known password (AccountsModule's changePassword) is made here too, with the steps it
// shares with a reset.
//
// - requestPasswordReset (`requestReset`): answers `202` whatever the address. An `active` account gets a reset token
//   (`pr_…`, 256 bits, 1 hour, single use) and the e-mail `auth.password_reset` with its link
//   `PUBLIC_PORTAL_URL/reset-password?token=…`; any other address gets nothing. Older links that have not expired keep
//   working until one of them is used. The rate limits (3 per address and 10 per end-user IP per hour) are the
//   operation's throttlers, shared with resendVerification.
// - confirmPasswordReset (`confirmReset`): the token first (an unknown, used or expired token, or one whose account can
//   no longer hold a session or no longer has the token's address, answers `400 PASSWORD_RESET_TOKEN_INVALID` without
//   saying why), then the password rules (`422 PASSWORD_TOO_WEAK` on `/newPassword`; the token stays usable). The
//   reset links of `auth.account_exists` (sign-up with a known address) are reset tokens too, so an account that still
//   waits for verification may use one; the reset does not verify its address.
// - changePassword (`changePassword`, scope `portal`): the current password must match (`422
//   CURRENT_PASSWORD_INCORRECT` on `/currentPassword`), then the rules for the new one.
//
// A new password, reset or changed, then takes the same steps: the OTA cut-off `staffdeny:acct:<accountId>` = now in
// epoch milliseconds (30 days, so the OTA backend ends the account's OTA admin staff sessions) is written first, as
// signOutEverywhere does (if Redis fails nothing changes and the call fails). Then one transaction holding the
// account's `FOR UPDATE` lock (so no refresh writes a generation meanwhile): the Argon2id hash with
// `password_changed_at`, the revocation of every family of the account, portal and admin (a change keeps the caller's
// own family, the access token's `sid`), the e-mail `auth.password_changed`, the audit row (`account.password_reset`
// or `account.password_changed`, with the number of revoked families and the cut-off) and an `account` invalidation
// after the commit (architecture §6.3). A reset also uses up the account's other reset links.
//
// The password is hashed before the transaction opens, so no lock waits for Argon2id. Passwords and tokens are never
// logged, audited or stored in clear; the reset link travels only as the outbox's encrypted secret data (PADR-0013).
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { redisKeys, setKey } from "../common/redis/redis-keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { OutboxService } from "../notifications/outbox.service";
import { AccountTokensRepository } from "./account-tokens.repository";
import { AccountsRepository, type AccountStatus, type CredentialsAccount } from "./accounts.repository";
import { PasswordPolicy } from "./password-policy";
import { maySignIn } from "./sessions.service";
import { SessionsRepository } from "./sessions.repository";
import { RESET_PASSWORD_PATH, RESET_TOKEN_TTL_MS } from "./sign-up.service";

export type PasswordResetRequest = components["schemas"]["PasswordResetRequest"];
export type PasswordResetConfirmRequest = components["schemas"]["PasswordResetConfirmRequest"];
export type ChangePasswordRequest = components["schemas"]["ChangePasswordRequest"];

/** The prefix of reset tokens (`pr_…`, as @velexis/crypto's `generateToken` documents it). */
const RESET_TOKEN_PREFIX = "pr";

/** The answer to a wrong current password: one field error, which never quotes the password. */
function currentPasswordIncorrect(): AppError {
  return new AppError("CURRENT_PASSWORD_INCORRECT", {
    fieldErrors: [{ path: "/currentPassword", code: "incorrect", message: "The current password is wrong." }],
  });
}

/** True when `account` may get a new password: it may hold a session (active or waiting for verification). */
export function mayChangePassword(account: Pick<CredentialsAccount, "status" | "deleted_at">): boolean {
  return maySignIn(account.status) && account.deleted_at === null;
}

/** Which new password: a reset (every session ends) or a change (the caller's session stays). */
type NewPasswordKind =
  { readonly kind: "reset" } | { readonly kind: "change"; readonly keptFamilyId: string };

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly tokens: AccountTokensRepository,
    private readonly sessions: SessionsRepository,
    private readonly passwords: PasswordPolicy,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly publisher: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly context: RequestContext,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** requestPasswordReset (see the file header). */
  async requestReset(request: PasswordResetRequest): Promise<void> {
    const email = request.email.trim();
    await runInTransaction(this.db, async (trx) => {
      const account = await this.accounts.findByEmail(trx, email);
      if (account?.status !== ("active" satisfies AccountStatus)) {
        return;
      }
      const now = this.clock.now();
      const { token, hash } = generateToken(RESET_TOKEN_PREFIX);
      await this.tokens.insert(trx, {
        id: this.ids.new("atk"),
        accountId: account.id,
        purpose: "password_reset",
        tokenHash: hash,
        email: account.email,
        expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
        ipAddress: this.context.ip ?? null,
        now,
      });
      await this.outbox.queue(trx, {
        templateKey: "auth.password_reset",
        to: account.email,
        accountId: account.id,
        data: { fullName: account.full_name },
        secretData: { resetUrl: this.outbox.portalLink(RESET_PASSWORD_PATH, { token }) },
      });
    });
  }

  /** confirmPasswordReset (see the file header). */
  async confirmReset(request: PasswordResetConfirmRequest): Promise<void> {
    const tokenHash = sha256Hex(request.token);
    // A read first, so a dead link is told before the password rules and nothing is hashed or cut off for it.
    const accountId = await runInTransaction(this.db, (trx) =>
      this.tokens.accountOfUsable(trx, "password_reset", tokenHash, this.clock.now()),
    );
    const account =
      accountId === undefined ? undefined : await this.accounts.findCredentials(this.db, accountId);
    if (account === undefined || !mayChangePassword(account)) {
      throw new AppError("PASSWORD_RESET_TOKEN_INVALID");
    }
    this.passwords.check(request.newPassword, "/newPassword");
    const passwordHash = await this.passwords.hash(request.newPassword);
    const cutOff = await this.cutOffStaffSessions(account.id);
    await runInTransaction(this.db, async (trx) => {
      const now = this.clock.now();
      // The account's lock first, then its token, as verifyEmail takes them: two of its links used at the same time
      // run one after the other, and the second finds its account's links used up.
      const locked = await this.accounts.lockCredentials(trx, account.id);
      const used =
        locked === undefined ? undefined : await this.tokens.consume(trx, "password_reset", tokenHash, now);
      // The throw rolls the consumption back.
      if (
        used === undefined ||
        locked === undefined ||
        used.accountId !== locked.id ||
        !mayChangePassword(locked) ||
        locked.email.toLowerCase() !== used.email.toLowerCase()
      ) {
        throw new AppError("PASSWORD_RESET_TOKEN_INVALID");
      }
      const revokedFamilies = await this.storeNewPassword(trx, locked, passwordHash, { kind: "reset" }, now);
      // The account's other reset links have done their job.
      await this.tokens.consumeAllOf(trx, locked.id, "password_reset", now);
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: locked.id,
        action: "account.password_reset",
        targetType: "account",
        targetId: locked.id,
        details: { revokedFamilies, staffDenyFrom: cutOff.toISOString() },
      });
    });
  }

  /**
   * changePassword (see the file header): `accountId` and `currentFamilyId` are the caller's, from the access token
   * (`sub` and `sid`); that family stays signed in.
   */
  async changePassword(
    accountId: string,
    currentFamilyId: string,
    request: ChangePasswordRequest,
  ): Promise<void> {
    const account = await this.accounts.findCredentials(this.db, accountId);
    if (account === undefined || !mayChangePassword(account)) {
      // The access token outlived the account's right to a session (disabled or erased since).
      throw new AppError("UNAUTHENTICATED");
    }
    const knownHash = account.password_hash;
    if (knownHash === null || !(await this.passwords.verify(knownHash, request.currentPassword))) {
      throw currentPasswordIncorrect();
    }
    this.passwords.check(request.newPassword, "/newPassword");
    const passwordHash = await this.passwords.hash(request.newPassword);
    const cutOff = await this.cutOffStaffSessions(account.id);
    await runInTransaction(this.db, async (trx) => {
      const locked = await this.accounts.lockCredentials(trx, account.id);
      if (locked === undefined || !mayChangePassword(locked)) {
        throw new AppError("UNAUTHENTICATED");
      }
      // A change or reset that committed since the check makes the current password this request knew stale.
      if (locked.password_hash !== knownHash) {
        throw currentPasswordIncorrect();
      }
      const now = this.clock.now();
      const revokedFamilies = await this.storeNewPassword(
        trx,
        locked,
        passwordHash,
        { kind: "change", keptFamilyId: currentFamilyId },
        now,
      );
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: locked.id,
        action: "account.password_changed",
        targetType: "account",
        targetId: locked.id,
        details: { revokedFamilies, staffDenyFrom: cutOff.toISOString() },
      });
    });
  }

  /**
   * Writes the OTA cut-off `staffdeny:acct:<accountId>` = now (epoch milliseconds, 30 days) and returns its time. It
   * is written before the transaction: if Redis fails nothing changes; if the database fails afterwards the staff
   * sessions are still cut off, which errs on the safe side.
   */
  private async cutOffStaffSessions(accountId: string): Promise<Date> {
    const cutOff = this.clock.now();
    await setKey(this.redis, redisKeys.staffDenyAccount(accountId), String(cutOff.getTime()));
    return cutOff;
  }

  /**
   * The steps every new password takes in `trx`, with `account` locked (`lockCredentials`): the hash and
   * `password_changed_at`, the revocation of the account's families (all for a reset; all but the caller's for a
   * change), the e-mail `auth.password_changed` and the `account` invalidation after the commit. Returns how many
   * families were revoked.
   */
  private async storeNewPassword(
    trx: PlatformTransaction,
    account: CredentialsAccount,
    passwordHash: string,
    change: NewPasswordKind,
    now: Date,
  ): Promise<number> {
    await this.accounts.setPassword(trx, account.id, passwordHash, now);
    const revokedFamilies =
      change.kind === "reset"
        ? await this.sessions.revokeAllOfAccount(trx, account.id, "password_change", now)
        : await this.sessions.revokeAllOfAccountExcept(
            trx,
            account.id,
            change.keptFamilyId,
            "password_change",
            now,
          );
    await this.outbox.queue(trx, {
      templateKey: "auth.password_changed",
      to: account.email,
      accountId: account.id,
      data: { fullName: account.full_name },
    });
    this.publisher.publishAfterCommit(trx, { v: 1, type: "account", accountId: account.id });
    return revokedFamilies;
  }
}
