// Customer sign-in (OBE-033; flows/my-bookings-and-guest-lookup.md §1, §3 step 3 and §4, the document's signIn,
// ADR-0008 "Passwords" and "Lockout", architecture §8). In this order:
//
// 1. Customer accounts must be on for the storefront (`storefront_settings.customer_accounts_enabled`), else
//    `403 FEATURE_DISABLED` with `details.feature: "customerAccounts"`.
// 2. The lockout (lockout.ts) counts the attempt before the password is looked at: an address with five attempts in
//    its window answers `423 ACCOUNT_LOCKED` with `Retry-After` at once, so the right password does not open a locked
//    address either, and a burst of parallel guesses never gets more than five verifications.
// 3. The password, always with one Argon2id verification: against the identity's hash, or against a dummy hash of the
//    same parameters (made once, when the module starts) for an address without an enabled password identity. A wrong
//    address, a wrong password and a customer who may not sign in (disabled by staff, deleted) all answer the same
//    `401 INVALID_CREDENTIALS` with `details.remainingAttempts`, after the same Argon2id work, and all stay counted as
//    a failure of the address; the fifth answers `423`. So neither the answer nor its timing tells a stranger whether
//    an address has an account, or whether it is disabled.
// 4. Success clears the counter, opens a refresh family (SessionsService.start: 12 hours, or 30 days with
//    `rememberMe`, which defaults to true as the contract says) with the end user's user agent, records
//    `customers.last_sign_in_at` and the identity's `last_used_at`, and answers the new tokens with the customer and the
//    session's metadata. The controller puts the tokens into the storefront edge's cookies (`AuthSessionInfo` in the
//    body) or into the body for key callers (`AuthSessionResult`).
//
// Customers that wait for e-mail verification (`pending_verification`) sign in like active ones: this OTA asks for a
// verified address before checkout (`require_email_verification`, `storefront.auth.emailVerification =
// required_before_checkout`), never before sign-in, so `EMAIL_NOT_VERIFIED` is not an answer of this operation yet.
//
// The rate limit (10 per minute per end-user IP) is the operation's throttler (rate-limits.ts). The password is never
// logged, stored or hashed: `SignInIdempotencyHooks` leaves it out of the idempotency request hash
// (idempotency.service.ts), which then covers the normalised address and `rememberMe`, so a retry with the same
// `Idempotency-Key` from the same caller gets the stored answer (encrypted, it carries tokens), as the contract says.
import { Injectable, type OnModuleInit } from "@nestjs/common";
import { generateToken } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { argon2id, hash, verify } from "argon2";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotentInput,
} from "../common/http/idempotency.service";
import { TenantTx } from "../tenancy/tenant-tx";
import { CustomersRepository, type PasswordIdentity } from "./customers.repository";
import { AccountLockedError, normaliseEmail, SignInLockout, type LockoutState } from "./lockout";
import { mayHoldSession, SessionsService, type SessionWithTokens } from "./sessions.service";

/**
 * Argon2id with the OWASP parameters of ADR-0008 "Passwords" (m = 19 MiB, t = 2, p = 1), as the platform hashes portal
 * passwords: the parameters of every customer password hash, and of the dummy hash.
 */
export const CUSTOMER_ARGON2_OPTIONS = Object.freeze({
  type: argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
});

/** What `signIn` takes: the validated body and the end user's user agent. */
export interface SignInInput {
  readonly email: string;
  readonly password: string;
  /** Optional, default true (`SignInRequest.rememberMe`). */
  readonly rememberMe?: boolean | undefined;
  /** The request's own `User-Agent`, or a secret key's `X-Velexis-End-User-Agent`. */
  readonly userAgent?: string | null | undefined;
}

/** Why a sign-in failed, for the log line only: every one answers alike. */
type FailureReason = "unknown_address" | "wrong_password" | "customer_blocked";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** True when the customer of `identity` may sign in: neither deleted nor disabled (the states that hold sessions). */
export function maySignIn(identity: PasswordIdentity): boolean {
  return mayHoldSession({
    id: identity.customerId,
    status: identity.customerStatus,
    deleted_at: identity.customerDeletedAt,
  });
}

/** The Argon2id hash of `password` with `CUSTOMER_ARGON2_OPTIONS`, in PHC format. */
export function hashCustomerPassword(password: string): Promise<string> {
  return hash(password, { ...CUSTOMER_ARGON2_OPTIONS });
}

@Injectable()
export class SignInService implements OnModuleInit {
  /** An Argon2id hash of a random value, made like real ones: the verification of unknown addresses. */
  private dummyHash: string | undefined;

  constructor(
    private readonly customers: CustomersRepository,
    private readonly sessions: SessionsService,
    private readonly lockout: SignInLockout,
    private readonly tx: TenantTx,
    private readonly clock: Clock,
    @InjectPinoLogger(SignInService.name) private readonly logger: PinoLogger,
  ) {}

  /** Makes the dummy hash once, before the first request. */
  async onModuleInit(): Promise<void> {
    await this.dummy();
  }

  /** auth.signIn (see the file header). */
  async signIn(input: SignInInput): Promise<SessionWithTokens> {
    const email = normaliseEmail(input.email);
    const { enabled, identity } = await this.tx.run(async (trx) => ({
      enabled: await this.customers.customerAccountsEnabled(trx),
      identity: await this.customers.findPasswordIdentity(trx, email),
    }));
    if (!enabled) {
      throw new AppError("FEATURE_DISABLED", { details: { feature: "customerAccounts" } });
    }
    const attempt = await this.lockout.takeAttempt(email);
    if (!attempt.taken) {
      throw new AccountLockedError(attempt.state.retryAfterSeconds, this.clock.now());
    }
    const matches = await this.verify(
      identity?.passwordHash ?? (await this.dummy()),
      input.password,
      identity,
    );
    if (identity === undefined) {
      throw this.failure(attempt.state, "unknown_address", undefined);
    }
    if (!matches) {
      throw this.failure(attempt.state, "wrong_password", identity.customerId);
    }
    if (!maySignIn(identity)) {
      throw this.failure(attempt.state, "customer_blocked", identity.customerId);
    }
    await this.lockout.clear(email);
    const opened = await this.tx.run(async (trx) => {
      const issued = await this.sessions.start(trx, {
        customerId: identity.customerId,
        identityId: identity.identityId,
        rememberMe: input.rememberMe ?? true,
        userAgent: input.userAgent,
      });
      await this.customers.recordSignIn(trx, identity.customerId, identity.identityId, this.clock.now());
      const view = await this.sessions.view(trx, identity.customerId, issued.sessionId);
      if (view === undefined) {
        // Written in this transaction a moment ago: it cannot be missing.
        throw new Error("SignInService.signIn: the new session cannot be read back");
      }
      return { issued, view };
    });
    // Ids only: the address, the password and the tokens are never logged.
    this.logger.info(
      { customerId: identity.customerId, sessionId: opened.issued.sessionId },
      "customer.signed_in",
    );
    return { ...opened.view, tokens: await this.sessions.tokensFor(opened.issued) };
  }

  /**
   * The error of a failed sign-in whose attempt left the lockout in `state` (the attempt stays counted):
   * `401 INVALID_CREDENTIALS` with the attempts left, or `423 ACCOUNT_LOCKED` when this attempt started the lock.
   */
  private failure(state: LockoutState, reason: FailureReason, customerId: string | undefined): AppError {
    this.logger.info({ reason, customerId, locked: state.locked }, "customer.sign_in_failed");
    if (state.locked) {
      return new AccountLockedError(state.retryAfterSeconds, this.clock.now());
    }
    return new AppError("INVALID_CREDENTIALS", { details: { remainingAttempts: state.remainingAttempts } });
  }

  /** One Argon2id verification of `password` against `passwordHash`; a hash Argon2 cannot read never matches. */
  private async verify(
    passwordHash: string,
    password: string,
    identity: PasswordIdentity | undefined,
  ): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      // The identity's hash is not a PHC string Argon2 reads: logged by id, never the hash or the password.
      this.logger.warn({ identityId: identity?.identityId }, "customer.password_hash_unreadable");
      return false;
    }
  }

  /** The dummy hash; made on first use if a test calls the service before the module started. */
  private async dummy(): Promise<string> {
    this.dummyHash ??= await hashCustomerPassword(generateToken("dummy").token);
    return this.dummyHash;
  }
}

/**
 * The idempotency request hash of auth.signIn (idempotency.service.ts): the body without the password, which has no
 * safe unkeyed hash, and with the address normalised as the sign-in reads it.
 */
@Injectable()
@IdempotencyHooksFor(["signIn"])
export class SignInIdempotencyHooks implements IdempotencyHooks {
  hashInput(input: IdempotentInput): unknown {
    const body = isObject(input.body) ? input.body : {};
    const email = body["email"];
    return {
      path: input.path,
      query: input.query,
      body: {
        email: typeof email === "string" ? normaliseEmail(email) : null,
        rememberMe: body["rememberMe"] ?? null,
      },
    };
  }
}
