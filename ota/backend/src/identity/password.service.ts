// Customer password reset and change (OBE-034; the document's requestPasswordReset, resetPassword and changePassword,
// ADR-0008 "Passwords", "Lockout" and "E-mail verification and password reset", OADR-0006 points 2 and 4, OADR-0013
// item 4, architecture §8).
//
// auth.requestPasswordReset (5 per hour per end-user IP and 3 per hour per address: the request limits of
// rate-limits.ts) always answers the same `202 AuthAcceptedResult` (`PASSWORD_RESET_ACCEPTED`), whether or not the
// address has an account, so the answer never tells a stranger which addresses are registered. With customer accounts
// off for the storefront it answers `403 FEATURE_DISABLED` for every address. For an enabled password identity whose
// customer may hold a session (`active`, `pending_verification`), in one transaction under the customer's lock:
//
// 1. at most three reset e-mails per customer in any hour (the document's account limit; the rows of the last hour are
//    counted, so it slides where the request limit's window is fixed): above it the request is dropped silently;
// 2. the customer's earlier open tokens end at once, so only the newest link works;
// 3. a new token `pr_…` (256 bits) is stored as its SHA-256 in `customer_password_resets`, valid one hour, with the
//    end user's IP;
// 4. the `auth.password_reset` e-mail is queued in the outbox (OBE-030) with the token only in `secretData` (sealed in
//    `notifications.secret_payload_ciphertext`, erased once sent); the worker renders the link
//    `/account/reset-password.html?token=…` on the tenant's storefront host. `returnPath` is accepted and not kept:
//    the tenant schema has no place for it and the e-mail link is fixed (OADR-0015 point 5).
//
// Unknown addresses, blocked customers (disabled, deleted) and dropped requests answer the same, byte for byte; the
// work a sent e-mail adds is a few short writes in the same transaction, and the `notify` job after the commit, which
// gives up after 2 s (outbox.service.ts). The log line (`customer.password_reset_requested`) names the outcome and the
// customer id only, never the address.
//
// auth.resetPassword: the token is checked first (an unknown, used or expired one answers `400
// PASSWORD_RESET_TOKEN_INVALID` with `details.reason` `unknown`, `used` or `expired`), then the new password against
// the policy (`422 PASSWORD_TOO_WEAK`; the token stays usable), and the password is hashed (Argon2id, outside any
// transaction). Then, in one transaction, under the customer's lock and the token row's (so a token works once even
// when two confirmations race): the token is checked again and marked used, the customer's other open tokens end, the
// identity gets the new hash (`password_updated_at`), the address counts as verified (the inbox was proven:
// `pending_verification` becomes `active`), every session of the customer is revoked (`password_change`), and with
// `signIn` (default true) a new session is opened (30 days, as a sign-in's default `rememberMe`). After the commit the
// sign-in lockout of the address is cleared.
//
// auth.changePassword (signed-in customer): the current password is verified with the sign-in lockout (lockout.ts:
// the attempt is counted before the password is looked at; 5 wrong attempts within 15 minutes, sign-ins and changes
// together, answer `423 ACCOUNT_LOCKED`); a wrong one answers `422 CURRENT_PASSWORD_INCORRECT` (the document) and
// changes nothing. The new password must pass the policy and differ from the current one (`422 PASSWORD_TOO_WEAK`,
// `sameAsCurrent`). Then, in one transaction under the customer's lock: the new hash is stored only while the hash
// that was verified is still the stored one, the request's own session is rotated (`SessionsService.rotateCurrent`:
// the same family and end, a new refresh token, the old one stops working), every other session of the customer is
// revoked with `signOutOtherSessions` (default true), and the customer's open reset tokens end. A session that ended
// meanwhile answers `401 UNAUTHENTICATED` and changes nothing.
//
// The document also has both operations queue a `password_changed` security e-mail; OADR-0013 item 4 lists no such
// template key for the MVP, so none is queued (OBE-034's questions).
//
// Passwords and tokens are never logged or stored in clear: the idempotency request hashes leave the passwords out
// (`ResetPasswordIdempotencyHooks`, `ChangePasswordIdempotencyHooks`), and every log line carries ids only.
import { isIP } from "node:net";
import { Injectable } from "@nestjs/common";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { verify } from "argon2";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { CustomerContext } from "../common/auth/customer.guard";
import { Clock } from "../common/clock";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotentInput,
} from "../common/http/idempotency.service";
import { IdGenerator } from "../common/ids";
import { EMAIL_ADDRESS } from "../config";
import { OutboxService } from "../notifications/outbox.service";
import { canonicalLocale } from "../storefront/storefront.mapper";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { CustomersRepository, type CustomerRecord } from "./customers.repository";
import { AccountLockedError, normaliseEmail, SignInLockout } from "./lockout";
import { CustomerPasswordPolicy } from "./password-policy";
import {
  PasswordResetsRepository,
  type CustomerPasswordIdentity,
  type PasswordResetRecord,
} from "./password-resets.repository";
import {
  mayHoldSession,
  SessionsService,
  type IssuedSession,
  type SessionView,
  type SessionWithTokens,
} from "./sessions.service";
import { hashCustomerPassword } from "./sign-in.service";

const HOUR_MS = 60 * 60 * 1000;

/** How long a reset link works: one hour (ADR-0008, the document's "valid 60 minutes"). */
export const PASSWORD_RESET_TTL_MS = HOUR_MS;

/** The reset e-mails a customer gets at most in any hour; more requests are dropped silently (the document). */
export const MAX_PASSWORD_RESETS_PER_HOUR = 3;

/** The prefix of reset tokens (`pr_…`, the contract's `^pr_[A-Za-z0-9_-]{32,64}$`). */
export const PASSWORD_RESET_TOKEN_PREFIX = "pr";

/** The bytes of a reset token: 256 bits (`pr_` and 43 base64url characters). */
export const PASSWORD_RESET_TOKEN_BYTES = 32;

/** Whether a session opened by a reset is long-lived: as auth.signIn's default `rememberMe`. */
export const RESET_SESSION_REMEMBER_ME = true;

/** The one answer of auth.requestPasswordReset (`AuthAcceptedResult`), whatever happened. */
export const PASSWORD_RESET_ACCEPTED = Object.freeze({
  status: "accepted",
  message: "If an account exists for this address, we have sent a link to reset your password.",
} as const);

/** What a reset token is not usable for (`details.reason` of `PASSWORD_RESET_TOKEN_INVALID`). */
export type ResetTokenProblem = "unknown" | "used" | "expired";

/** What happened to a reset request, for the log line only: every one answers alike. */
type ResetRequestOutcome =
  "sent" | "unknown_address" | "customer_blocked" | "throttled" | "unmailable_address";

/** The outcome of a reset request's transaction: one of the above, or customer accounts off for the storefront. */
interface ResetRequestResult {
  readonly outcome: ResetRequestOutcome | "feature_disabled";
  readonly customerId?: string | undefined;
}

/** What `requestReset` takes: the validated body's address and the end user's IP. */
export interface RequestPasswordResetInput {
  readonly email: string;
  /** The end user's IP (the rate limits' `endUserIp`); stored only when it is a valid address. */
  readonly requestedIp?: string | undefined;
}

/** What `resetPassword` takes. */
export interface ResetPasswordInput {
  readonly token: string;
  readonly newPassword: string;
  /** Optional, default true: open a session. */
  readonly signIn?: boolean | undefined;
  /** The end user's user agent, for the new session. */
  readonly userAgent?: string | null | undefined;
}

/** The outcome of a reset: the customer as it is now, and the new session when one was opened. */
export interface PasswordResetOutcome {
  readonly customer: CustomerRecord;
  readonly session: SessionWithTokens | null;
}

/** What `changePassword` takes. */
export interface ChangePasswordInput {
  /** The signed-in customer of the request (the access token's `sub` and `sid`). */
  readonly principal: { readonly customerId: string; readonly sessionId: string };
  readonly currentPassword: string;
  readonly newPassword: string;
  /** Optional, default true: revoke every other session of the customer. */
  readonly signOutOtherSessions?: boolean | undefined;
}

/**
 * The problem of a reset row at `now`, or `undefined` when its token may be used: no row is `unknown`, a used row
 * `used` (also once it has expired), a row at or past its end `expired`.
 */
export function resetTokenProblem(
  reset: Pick<PasswordResetRecord, "usedAt" | "expiresAt"> | undefined,
  now: Date,
): ResetTokenProblem | undefined {
  if (reset === undefined) {
    return "unknown";
  }
  if (reset.usedAt !== null) {
    return "used";
  }
  return reset.expiresAt.getTime() <= now.getTime() ? "expired" : undefined;
}

/** `400 PASSWORD_RESET_TOKEN_INVALID` with the reason. */
function tokenInvalid(reason: ResetTokenProblem): AppError {
  return new AppError("PASSWORD_RESET_TOKEN_INVALID", { details: { reason } });
}

/** An instant as the templates show it: ISO 8601 in UTC, whole seconds (`2026-11-01T11:00:00Z`). */
function isoSeconds(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The IP stored with a reset: the end user's address when it is one, else none (an `inet` column). */
function storedIp(ip: string | undefined): string | null {
  return ip !== undefined && isIP(ip) !== 0 ? ip : null;
}

/** `422 CURRENT_PASSWORD_INCORRECT` on `/currentPassword` (`AuthPasswordRejected` of the document). */
function currentPasswordIncorrect(): AppError {
  return new AppError("CURRENT_PASSWORD_INCORRECT", {
    fieldErrors: [
      { path: "/currentPassword", code: "incorrect", message: "Your current password is not correct." },
    ],
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

@Injectable()
export class PasswordService {
  constructor(
    private readonly resets: PasswordResetsRepository,
    private readonly customers: CustomersRepository,
    private readonly sessions: SessionsService,
    private readonly lockout: SignInLockout,
    private readonly policy: CustomerPasswordPolicy,
    private readonly outbox: OutboxService,
    private readonly tx: TenantTx,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectPinoLogger(PasswordService.name) private readonly logger: PinoLogger,
  ) {}

  /** auth.requestPasswordReset (see the file header): never tells whether the address has an account. */
  async requestReset(input: RequestPasswordResetInput): Promise<void> {
    const email = normaliseEmail(input.email);
    const result = await this.tx.run(async (trx): Promise<ResetRequestResult> => {
      if (!(await this.customers.customerAccountsEnabled(trx))) {
        return { outcome: "feature_disabled" };
      }
      const identity = await this.customers.findPasswordIdentity(trx, email);
      if (identity === undefined) {
        return { outcome: "unknown_address" };
      }
      const outcome = await this.issueReset(trx, identity.customerId, storedIp(input.requestedIp));
      return { outcome, customerId: identity.customerId };
    });
    if (result.outcome === "feature_disabled") {
      throw new AppError("FEATURE_DISABLED", { details: { feature: "customerAccounts" } });
    }
    // Ids only: the address and the token are never logged.
    this.logger.info(
      { outcome: result.outcome, customerId: result.customerId },
      "customer.password_reset_requested",
    );
  }

  /**
   * Issues a reset of `customerId` in `trx` (steps 1–4 of the file header) and says what it did; nothing is written
   * unless it answers `sent`.
   */
  private async issueReset(
    trx: TenantTransaction,
    customerId: string,
    requestedIp: string | null,
  ): Promise<ResetRequestOutcome> {
    const customer = await this.resets.lockCustomer(trx, customerId);
    if (customer === undefined || !mayHoldSession(customer)) {
      return "customer_blocked";
    }
    if (!EMAIL_ADDRESS.test(customer.email)) {
      // Never the case for an address sign-up accepted; an e-mail the outbox would refuse is not attempted.
      return "unmailable_address";
    }
    const now = this.clock.now();
    const recent = await this.resets.countRequestedSince(trx, customerId, new Date(now.getTime() - HOUR_MS));
    if (recent >= MAX_PASSWORD_RESETS_PER_HOUR) {
      return "throttled";
    }
    await this.resets.expireOpen(trx, customerId, now);
    const { token, hash } = generateToken(PASSWORD_RESET_TOKEN_PREFIX, PASSWORD_RESET_TOKEN_BYTES);
    const resetId = this.ids.newId("pwr");
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
    await this.resets.insert(trx, { id: resetId, customerId, tokenHash: hash, requestedIp, expiresAt, now });
    const locales = await this.resets.mailLocales(trx, customerId);
    await this.outbox.enqueue(trx, {
      templateKey: "auth.password_reset",
      to: customer.email,
      locale: canonicalLocale(locales.preferred) ?? canonicalLocale(locales.storefrontDefault) ?? "en",
      customerId,
      data: { customer: { firstName: customer.first_name ?? "" }, expiresAt: isoSeconds(expiresAt) },
      secretData: { token },
      dedupeKey: `auth.password_reset:${resetId}`,
    });
    return "sent";
  }

  /** auth.resetPassword (see the file header). */
  async resetPassword(input: ResetPasswordInput): Promise<PasswordResetOutcome> {
    const tokenHash = sha256Hex(input.token);
    // The token first, read without a lock: an unusable one is refused before the password is looked at.
    const seen = await this.tx.run((trx) => this.resets.findByTokenHash(trx, tokenHash));
    const problem = resetTokenProblem(seen, this.clock.now());
    if (seen === undefined || problem !== undefined) {
      throw tokenInvalid(problem ?? "unknown");
    }
    this.policy.check(input.newPassword, "/newPassword");
    const passwordHash = await hashCustomerPassword(input.newPassword);
    const signIn = input.signIn ?? true;
    const done = await this.tx.run(async (trx) => {
      const customer = await this.resets.lockCustomer(trx, seen.customerId);
      // Read again under the locks: a confirmation that committed meanwhile used the token.
      const reset = await this.resets.lockByTokenHash(trx, tokenHash);
      const now = this.clock.now();
      const lockedProblem = resetTokenProblem(reset, now);
      if (reset === undefined || lockedProblem !== undefined) {
        throw tokenInvalid(lockedProblem ?? "unknown");
      }
      const identity = await this.resets.passwordIdentityOf(trx, reset.customerId);
      if (customer === undefined || identity === undefined || !mayHoldSession(customer)) {
        // The account was disabled, deleted or erased after the link was sent: the link no longer names one.
        throw tokenInvalid("unknown");
      }
      await this.resets.setPassword(trx, { identityId: identity.identityId, passwordHash, now });
      await this.resets.markUsed(trx, reset.id, now);
      await this.resets.expireOpen(trx, reset.customerId, now);
      await this.resets.markEmailVerified(trx, reset.customerId, identity.identityId, now);
      const revoked = await this.sessions.revokeAllOfCustomer(trx, reset.customerId, "password_change");
      const opened = signIn ? await this.openSession(trx, identity, input.userAgent, now) : undefined;
      const record = await this.customers.findCustomer(trx, reset.customerId);
      if (record === undefined) {
        // Locked by this transaction a moment ago: it cannot be missing.
        throw new Error("PasswordService.resetPassword: the customer cannot be read back");
      }
      return { identity, revoked, opened, customer: opened?.view.customer ?? record };
    });
    await this.clearLockout(done.identity.subject);
    // Ids only: the token and the passwords are never logged.
    this.logger.info(
      {
        customerId: done.identity.customerId,
        revokedSessions: done.revoked,
        sessionId: done.opened?.issued.sessionId,
      },
      "customer.password_reset",
    );
    return {
      customer: done.customer,
      session:
        done.opened === undefined
          ? null
          : { ...done.opened.view, tokens: await this.sessions.tokensFor(done.opened.issued) },
    };
  }

  /** auth.changePassword (see the file header): the rotated session with new tokens. */
  async changePassword(input: ChangePasswordInput): Promise<SessionWithTokens> {
    const { customerId, sessionId } = input.principal;
    const before = await this.tx.run(async (trx) => ({
      customer: await this.customers.findCustomer(trx, customerId),
      identity: await this.resets.passwordIdentityOf(trx, customerId),
    }));
    const identity = before.identity;
    if (before.customer === undefined || identity === undefined || !mayHoldSession(before.customer)) {
      throw new AppError("UNAUTHENTICATED");
    }
    await this.verifyCurrentPassword(identity, input.currentPassword);
    if (input.newPassword === input.currentPassword) {
      throw new AppError("PASSWORD_TOO_WEAK", {
        details: { violations: ["sameAsCurrent"] },
        fieldErrors: [
          {
            path: "/newPassword",
            code: "too_weak",
            message: "Choose a password that differs from your current one.",
          },
        ],
      });
    }
    this.policy.check(input.newPassword, "/newPassword");
    const passwordHash = await hashCustomerPassword(input.newPassword);
    const changed = await this.tx.run(async (trx) => {
      const customer = await this.resets.lockCustomer(trx, customerId);
      if (customer === undefined || !mayHoldSession(customer)) {
        throw new AppError("UNAUTHENTICATED");
      }
      const now = this.clock.now();
      const stored = await this.resets.setPassword(trx, {
        identityId: identity.identityId,
        passwordHash,
        now,
        expectedHash: identity.passwordHash,
      });
      if (!stored) {
        // The password changed since it was verified (another change or a reset): the one given is not current.
        throw currentPasswordIncorrect();
      }
      const issued = await this.sessions.rotateCurrent(trx, customerId, sessionId);
      if (issued === undefined) {
        // The request's session ended after its access token was issued: nothing is changed.
        throw new AppError("UNAUTHENTICATED");
      }
      const revoked =
        (input.signOutOtherSessions ?? true)
          ? await this.sessions.revokeAllOfCustomer(trx, customerId, "password_change", sessionId)
          : 0;
      await this.resets.expireOpen(trx, customerId, now);
      const view = await this.sessions.view(trx, customerId, sessionId);
      if (view === undefined) {
        // Rotated in this transaction a moment ago: it cannot be missing.
        throw new Error("PasswordService.changePassword: the rotated session cannot be read back");
      }
      return { issued, view, revoked };
    });
    // Ids only: the passwords and the tokens are never logged.
    this.logger.info(
      { customerId, sessionId, revokedSessions: changed.revoked },
      "customer.password_changed",
    );
    return { ...changed.view, tokens: await this.sessions.tokensFor(changed.issued) };
  }

  /**
   * Verifies the current password of a change with the sign-in lockout: the attempt is counted first (a locked address
   * answers `423` without a verification), a wrong password answers `422 CURRENT_PASSWORD_INCORRECT` (or `423` when it
   * started the lock), the right one clears the counter.
   */
  private async verifyCurrentPassword(identity: CustomerPasswordIdentity, password: string): Promise<void> {
    const attempt = await this.lockout.takeAttempt(identity.subject);
    if (!attempt.taken) {
      throw new AccountLockedError(attempt.state.retryAfterSeconds, this.clock.now());
    }
    if (!(await this.matches(identity, password))) {
      this.logger.info(
        { customerId: identity.customerId, locked: attempt.state.locked },
        "customer.password_change_refused",
      );
      if (attempt.state.locked) {
        throw new AccountLockedError(attempt.state.retryAfterSeconds, this.clock.now());
      }
      throw currentPasswordIncorrect();
    }
    await this.clearLockout(identity.subject);
  }

  /** Opens the session of a reset in `trx` and reads it back for the answer. */
  private async openSession(
    trx: TenantTransaction,
    identity: CustomerPasswordIdentity,
    userAgent: string | null | undefined,
    now: Date,
  ): Promise<{ readonly issued: IssuedSession; readonly view: SessionView }> {
    const issued = await this.sessions.start(trx, {
      customerId: identity.customerId,
      identityId: identity.identityId,
      rememberMe: RESET_SESSION_REMEMBER_ME,
      userAgent,
    });
    await this.customers.recordSignIn(trx, identity.customerId, identity.identityId, now);
    const view = await this.sessions.view(trx, identity.customerId, issued.sessionId);
    if (view === undefined) {
      // Written in this transaction a moment ago: it cannot be missing.
      throw new Error("PasswordService.openSession: the new session cannot be read back");
    }
    return { issued, view };
  }

  /** One Argon2id verification of `password` against the identity's hash; a hash Argon2 cannot read never matches. */
  private async matches(identity: CustomerPasswordIdentity, password: string): Promise<boolean> {
    try {
      return await verify(identity.passwordHash, password);
    } catch {
      // Logged by id, never the hash or the password.
      this.logger.warn({ identityId: identity.identityId }, "customer.password_hash_unreadable");
      return false;
    }
  }

  /**
   * Forgets the sign-in failures of `subject` after a password was proven or replaced. Best effort: the change has
   * committed or the password was right, and a counter Redis cannot delete ends with its 15-minute TTL.
   */
  private async clearLockout(subject: string): Promise<void> {
    try {
      await this.lockout.clear(subject);
    } catch (error) {
      this.logger.warn({ err: error }, "customer.lockout_clear_failed");
    }
  }
}

/**
 * The idempotency request hash of auth.resetPassword (idempotency.service.ts): the body without the new password,
 * which has no safe unkeyed hash. The token stays: a replay needs the token of the link, as the first request did.
 */
@Injectable()
@IdempotencyHooksFor(["resetPassword"])
export class ResetPasswordIdempotencyHooks implements IdempotencyHooks {
  hashInput(input: IdempotentInput): unknown {
    const body = isObject(input.body) ? input.body : {};
    return {
      path: input.path,
      query: input.query,
      body: { token: body["token"] ?? null, signIn: body["signIn"] ?? null },
    };
  }
}

/**
 * The idempotency request hash of auth.changePassword: the body without the passwords, and the request's session
 * (`sid`). The idempotency principal is the customer; with the session in the hash, a stored change (its answer holds
 * the rotated session's tokens) is replayed only to the session that made it, never to another session of the same
 * customer (`409 IDEMPOTENCY_KEY_REUSED`).
 */
@Injectable()
@IdempotencyHooksFor(["changePassword"])
export class ChangePasswordIdempotencyHooks implements IdempotencyHooks {
  constructor(private readonly customers: CustomerContext) {}

  hashInput(input: IdempotentInput): unknown {
    const body = isObject(input.body) ? input.body : {};
    return {
      path: input.path,
      query: input.query,
      body: { signOutOtherSessions: body["signOutOtherSessions"] ?? null },
      session: this.customers.get()?.sessionId ?? null,
    };
  }
}
