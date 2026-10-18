// Password sign-in to the portal (PBE-014; platform/docs/flows/signup-and-create-ota.md step 4 and "Failure handling",
// scope PF-03 AC1 and AC2, PADR-0008, ADR-0008 "Lockout", api-inventory §2 "Rate limits"). In this order:
//
// 1. The lockout: an account whose `locked_until` is still ahead answers `423 ACCOUNT_LOCKED` with `Retry-After`
//    (the seconds left), before its password is looked at.
// 2. The password, always with one Argon2id verification: against the account's hash, or against a dummy hash of the
//    same parameters (made once, when the module starts) for an unknown address, an erased account or one without a
//    password. So a wrong address and a wrong password give the same `401 INVALID_CREDENTIALS`, with the same body
//    apart from the request id, after the same Argon2id work. A wrong password of an existing account counts one more
//    consecutive failure (`auth.sign_in_failed`); the fifth starts a 15-minute lockout (`auth.locked`) and answers
//    `423` at once. The count goes on until a sign-in succeeds (or an admin unlocks the account), so after a lockout
//    every further failure starts the next one. Counting is one short transaction that an unknown address does not
//    run (a few milliseconds next to the verification's tens); the lockout itself shows after five failures that an
//    address has an account anyway.
// 3. The status, only after a correct password: a disabled (or otherwise blocked) account answers `403
//    ACCOUNT_DISABLED`, so the answer never tells a stranger that an address is disabled.
// 4. Success clears the failure count and the lockout. Without MFA it also sets `last_login_at`, starts a portal
//    refresh family (SessionsService), audits `auth.sign_in` and answers the `PortalSession`. With MFA it answers an
//    MFA challenge (`mfach:<sha256>`, 5 minutes, 5 attempts; MfaChallengeStore) that `verifyMfa` (PBE-015) completes
//    with `startSession`.
//
// An account that waits for e-mail verification signs in too; its access token has `ev = false` and reaches only the
// `portal_unverified` operations (PADR-0008 item 2). The rate limit (10 sign-ins per end-user IP per minute) is the
// operation's throttler. The password is never logged, audited or stored; neither are the tokens.
//
// The admin's `adminSignIn` (PBE-028, admin/admin-auth.service.ts) shares steps 1 and 2 (`verifyPassword`: the same
// lockout and the same failure count, a wrong password audited as `admin.sign_in_failed` there) and the challenge
// (`issueChallenge`, with the `platform_admin` audience); its own checks of the account follow the password.
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { generateToken } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { AccountsRepository, type AccountStatus, type SignInAccount } from "./accounts.repository";
import { MfaChallengeStore, type IssuedMfaChallenge } from "./mfa-challenge.store";
import { PasswordPolicy } from "./password-policy";
import type { SessionAudience } from "./sessions.repository";
import { maySignIn, SessionsService, type PortalSession } from "./sessions.service";

export type SignInRequest = components["schemas"]["SignInRequest"];
export type SignInResult = components["schemas"]["SignInResult"];
export type MfaChallengeAnswer = components["schemas"]["MfaChallenge"];

/** Consecutive failed sign-ins that lock an account (ADR-0008 "Lockout"). */
export const MAX_CONSECUTIVE_FAILED_SIGN_INS = 5;

/** How long a lockout lasts (ADR-0008 "Lockout"). */
export const SIGN_IN_LOCKOUT_MS = 15 * 60 * 1000;

/** The seconds of `Retry-After` while an account is locked until `lockedUntil`: at least 1. */
export function lockoutRetryAfter(lockedUntil: Date, now: Date): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}

/** `423 ACCOUNT_LOCKED`, with the seconds the controller answers as `Retry-After`. */
export class AccountLockedError extends AppError<"ACCOUNT_LOCKED"> {
  constructor(readonly retryAfterSeconds: number) {
    super("ACCOUNT_LOCKED");
  }
}

/** True when `account` is still locked out at `now`. */
function isLockedOut(account: Pick<SignInAccount, "locked_until">, now: Date): boolean {
  return account.locked_until !== null && account.locked_until.getTime() > now.getTime();
}

/** The audit action of a wrong password on each surface: the portal's `signIn` and the admin's `adminSignIn`. */
const SIGN_IN_FAILED_ACTIONS = Object.freeze({
  portal: "auth.sign_in_failed",
  platform_admin: "admin.sign_in_failed",
} as const satisfies Record<SessionAudience, string>);

/** The account a password may sign in to: not erased. An erased account is as unknown as an address without one. */
function signInCandidate(account: SignInAccount | undefined): SignInAccount | undefined {
  return account === undefined ||
    account.status === ("deleted" satisfies AccountStatus) ||
    account.deleted_at !== null
    ? undefined
    : account;
}

@Injectable()
export class SignInService implements OnModuleInit {
  /** An Argon2id hash of a random value, with the parameters of real hashes: the verification of unknown addresses. */
  private dummyHash: string | undefined;

  constructor(
    private readonly accounts: AccountsRepository,
    private readonly passwords: PasswordPolicy,
    private readonly sessions: SessionsService,
    private readonly challenges: MfaChallengeStore,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** Makes the dummy hash once, before the first request. */
  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.passwords.hash(generateToken("dummy").token);
  }

  /** signIn (see the file header). */
  async signIn(request: SignInRequest): Promise<SignInResult> {
    const account = await this.verifyPassword(request, "portal");
    if (!maySignIn(account.status)) {
      await this.recordRefusal(account);
      throw new AppError("ACCOUNT_DISABLED");
    }
    if (account.mfa_enabled) {
      const issued = await this.issueChallenge(account.id, "portal");
      return { mfaRequired: true, mfaChallengeToken: issued.token, expiresIn: issued.expiresIn };
    }
    return this.startSession(account.id, { mfaVerifiedAt: null });
  }

  /**
   * Steps 1 and 2 of the file header for a sign-in on `surface`: answers `423 ACCOUNT_LOCKED` for an account that is
   * locked out, verifies the password with one Argon2id verification (against the dummy hash for an unknown address),
   * answers `401 INVALID_CREDENTIALS` for a wrong address or password and counts a wrong password of an existing
   * account (audited as the surface's failure, `auth.sign_in_failed` or `admin.sign_in_failed`; the fifth starts the
   * lockout). Returns the account whose password is right, whatever its status: the caller checks the rest.
   */
  async verifyPassword(
    credentials: Pick<SignInRequest, "email" | "password">,
    surface: SessionAudience,
  ): Promise<SignInAccount> {
    const now = this.clock.now();
    const account = signInCandidate(await this.accounts.findForSignIn(this.db, credentials.email.trim()));
    if (account !== undefined && isLockedOut(account, now)) {
      throw new AccountLockedError(lockoutRetryAfter(account.locked_until ?? now, now));
    }
    const hash = account?.password_hash ?? (await this.dummy());
    const matches = await this.passwords.verify(hash, credentials.password);
    if (account === undefined) {
      throw new AppError("INVALID_CREDENTIALS");
    }
    if (!matches || account.password_hash === null) {
      throw await this.recordFailure(account, surface);
    }
    return account;
  }

  /**
   * Completes a sign-in of `accountId` whose credentials are verified, in one transaction: clears the failure count
   * and the lockout, sets `last_login_at`, starts a portal family (with `mfaVerifiedAt`, the TOTP verification of an
   * MFA sign-in) and audits `auth.sign_in`. Answers the `PortalSession`, or `423 ACCOUNT_LOCKED` when a concurrent
   * failure locked the account meanwhile. `verifyMfa` (PBE-015) calls it after a valid code.
   */
  async startSession(
    accountId: string,
    options: { readonly mfaVerifiedAt: Date | null },
  ): Promise<PortalSession> {
    return runInTransaction(this.db, async (trx) => {
      const now = this.clock.now();
      if (!(await this.accounts.recordSignIn(trx, accountId, now, { signedIn: true }))) {
        throw await this.lockedError(trx, accountId, now);
      }
      const issued = await this.sessions.startPortalFamily(trx, accountId, options, now);
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "auth.sign_in",
        targetType: "session",
        targetId: issued.familyId,
        details: { audience: "portal", mfa: options.mfaVerifiedAt !== null },
      });
      return this.sessions.portalSession(trx, issued);
    });
  }

  /**
   * The password of an account with MFA was right: clears its failures and issues a challenge of `audience` for the
   * MFA step of that surface (verifyMfa, or the admin's adminVerifyMfa). `423 ACCOUNT_LOCKED` when a concurrent
   * failure locked the account meanwhile.
   */
  async issueChallenge(accountId: string, audience: SessionAudience): Promise<IssuedMfaChallenge> {
    await runInTransaction(this.db, async (trx) => {
      const now = this.clock.now();
      if (!(await this.accounts.recordSignIn(trx, accountId, now, { signedIn: false }))) {
        throw await this.lockedError(trx, accountId, now);
      }
    });
    return this.challenges.create(accountId, audience);
  }

  /**
   * Counts a wrong password of `account` on `surface` and audits it (and the lockout it may start), then returns the
   * error to answer: `401 INVALID_CREDENTIALS`, or `423 ACCOUNT_LOCKED` when this failure started a lockout or a
   * concurrent one had.
   */
  private async recordFailure(account: SignInAccount, surface: SessionAudience): Promise<AppError> {
    return runInTransaction(this.db, async (trx): Promise<AppError> => {
      const now = this.clock.now();
      const lockedUntil = new Date(now.getTime() + SIGN_IN_LOCKOUT_MS);
      const failed = await this.accounts.recordFailedSignIn(trx, account.id, now, {
        threshold: MAX_CONSECUTIVE_FAILED_SIGN_INS,
        lockedUntil,
      });
      if (failed === undefined) {
        return this.lockedError(trx, account.id, now);
      }
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: account.id,
        action: SIGN_IN_FAILED_ACTIONS[surface],
        targetType: "account",
        targetId: account.id,
        details: { reason: "invalid_password", failedLoginCount: failed.failedLoginCount },
      });
      if (failed.lockedUntil === null) {
        return new AppError("INVALID_CREDENTIALS");
      }
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: account.id,
        action: "auth.locked",
        targetType: "account",
        targetId: account.id,
        after: { lockedUntil: failed.lockedUntil.toISOString() },
        details: { failedLoginCount: failed.failedLoginCount },
      });
      return new AccountLockedError(lockoutRetryAfter(failed.lockedUntil, now));
    });
  }

  /** Audits the refused sign-in of a disabled account (the password was right). */
  private async recordRefusal(account: SignInAccount): Promise<void> {
    await runInTransaction(this.db, async (trx) => {
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: account.id,
        action: "auth.sign_in_failed",
        targetType: "account",
        targetId: account.id,
        details: { reason: "account_disabled", status: account.status },
      });
    });
  }

  /** `423 ACCOUNT_LOCKED` for the account's current lockout (a lockout that just ended still waits a second). */
  private async lockedError(
    trx: PlatformTransaction,
    accountId: string,
    now: Date,
  ): Promise<AccountLockedError> {
    const lockedUntil = await this.accounts.lockedUntil(trx, accountId);
    return new AccountLockedError(lockoutRetryAfter(lockedUntil ?? now, now));
  }

  /** The dummy hash; made on first use if a test calls the service before the module started. */
  private async dummy(): Promise<string> {
    this.dummyHash ??= await this.passwords.hash(generateToken("dummy").token);
    return this.dummyHash;
  }
}
