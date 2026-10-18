// The customer sign-in lockout (OBE-033; ota/docs/architecture.md §7 `authfail` and §8, ADR-0008 "Lockout",
// flows/my-bookings-and-guest-lookup.md §3 step 3 and §4): five wrong sign-ins for one e-mail address lock password
// sign-in for that address for 15 minutes, `423 ACCOUNT_LOCKED` with `Retry-After`, even with the right password.
//
// The counter is `t:<tenantId>:<env>:authfail:<sha256(email)>` of redis.keys.ts, where the e-mail is the sign-in's
// address normalised as the identities store it (trimmed, lower case; `provider_subject` of `customer_identities`).
// So no address is kept in clear, and two tenants, or a tenant's two environments, never share a counter. It counts
// every wrong sign-in for the address, also for an address without an account: the answers (`401
// INVALID_CREDENTIALS` with `details.remainingAttempts`, then `423`) are the same whether or not the address is
// registered, so the lockout tells nobody which addresses have an account.
//
// - `takeAttempt(email)`: an attempt is counted **before** its password is looked at, in one Lua script that reads
//   and counts at once. While fewer than five are counted it counts this one and lets the sign-in verify the password;
//   with five counted it counts nothing and the sign-in answers `423` at once. So however many sign-ins of one address
//   arrive at the same moment, at most five passwords are ever verified in a window: a check, then a verification,
//   then a count would let a burst of parallel guesses all pass the check while the counter is still empty. The first
//   attempt opens a 15-minute window (the counter's TTL), so attempts that are not within 15 minutes of the first one
//   start afresh; the fifth sets the TTL to 15 minutes again, so the lock lasts 15 minutes from the attempt that
//   started it. A counter never exists without a TTL (Redis runs with `noeviction`, ADR-0009 item 2): the script sets
//   one again if it was lost.
// - `clear(email)`: a successful sign-in deletes the counter, so the attempts that lock are consecutive failures (and
//   the attempts still in flight beside the successful one).
//
// A Redis that cannot answer refuses the sign-in with `503 SERVICE_UNAVAILABLE` (architecture §10): a lockout that
// cannot be checked or counted is never skipped. Neither the address nor its digest is ever logged.
import { Inject, Injectable } from "@nestjs/common";
import { sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { redisKeys, SIGN_IN_LOCKOUT_TTL_SECONDS, type RedisKey } from "../common/redis/redis.keys";
import { TenantContext } from "../tenancy/tenant-context";

/** Consecutive wrong sign-ins that lock an address (ADR-0008 "Lockout"). */
export const MAX_SIGN_IN_FAILURES = 5;

/** How long a lock lasts, and the window of the failures that lead to it: 15 minutes (architecture §7). */
export const SIGN_IN_LOCKOUT_SECONDS = SIGN_IN_LOCKOUT_TTL_SECONDS;

/** What the lockout needs of the command client (`REDIS_CLIENT`). */
export type LockoutRedis = Pick<Redis, "eval" | "del">;

/**
 * Takes one attempt (`ARGV[1]`: the window in milliseconds, `ARGV[2]`: the limit). With the limit counted already it
 * counts nothing and answers taken = 0 (a counter that somehow lost its TTL gets the full lock time back, so it can
 * never lock an address for ever). Otherwise `INCR`; the TTL is set to the full window on the first attempt (or when
 * it is missing) and again on the attempt that reaches the limit, which starts the lock; taken = 1. Answers the
 * attempts counted, the TTL and taken.
 */
const TAKE_ATTEMPT = `
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local attempts = tonumber(redis.call('GET', KEYS[1])) or 0
local ttl = redis.call('PTTL', KEYS[1])
if attempts >= limit then
  if ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], window)
    ttl = window
  end
  return { attempts, ttl, 0 }
end
attempts = redis.call('INCR', KEYS[1])
ttl = redis.call('PTTL', KEYS[1])
if attempts == 1 or ttl < 0 or attempts == limit then
  redis.call('PEXPIRE', KEYS[1], window)
  ttl = window
end
return { attempts, ttl, 1 }
`;

/** The lockout of one address at one moment. */
export interface LockoutState {
  /** Attempts counted in the current window: failures, and attempts still being verified. */
  readonly failures: number;
  /** True from the fifth attempt until the counter ends. */
  readonly locked: boolean;
  /** Wrong sign-ins left before the lock: `5 − failures`, at least 0 (`details.remainingAttempts`). */
  readonly remainingAttempts: number;
  /** Whole seconds until the counter ends, at least 1 while there is one; 0 without a counter (`Retry-After`). */
  readonly retryAfterSeconds: number;
}

/** The outcome of `takeAttempt`. */
export interface LockoutAttempt {
  /**
   * True when the attempt was counted and its password may be verified; false when the address was locked already
   * (nothing was counted, and the password must not be looked at).
   */
  readonly taken: boolean;
  /** The lockout with this attempt counted: what a wrong password answers (`401` with the attempts left, or `423`). */
  readonly state: LockoutState;
}

/** The address as identities store it and as the counter is keyed: trimmed, lower case. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The SHA-256 (hex) of the normalised address: the last part of the counter's key. */
export function emailDigest(email: string): string {
  return sha256Hex(normaliseEmail(email));
}

/** The state for `failures` counted and a counter that ends in `ttlMs` milliseconds (negative: no counter). */
export function lockoutState(failures: number, ttlMs: number): LockoutState {
  const counted = Number.isSafeInteger(failures) && failures > 0 ? failures : 0;
  const retryAfterSeconds = counted > 0 && ttlMs > 0 ? Math.max(1, Math.ceil(ttlMs / 1000)) : 0;
  return Object.freeze({
    failures: counted,
    locked: counted >= MAX_SIGN_IN_FAILURES && retryAfterSeconds > 0,
    remainingAttempts: Math.max(0, MAX_SIGN_IN_FAILURES - counted),
    retryAfterSeconds,
  });
}

/**
 * `423 ACCOUNT_LOCKED` with `details.lockedUntil`, and the seconds the controller answers as `Retry-After`
 * (`AuthAccountLocked` of the document).
 */
export class AccountLockedError extends AppError<"ACCOUNT_LOCKED"> {
  constructor(
    readonly retryAfterSeconds: number,
    now: Date,
  ) {
    super("ACCOUNT_LOCKED", {
      details: { lockedUntil: new Date(now.getTime() + retryAfterSeconds * 1000).toISOString() },
    });
  }
}

/** The answer of the script as an attempt; anything else is a Redis that cannot be trusted. */
function attemptOf(reply: unknown): LockoutAttempt {
  const [attempts, ttlMs, taken] = Array.isArray(reply) ? reply.map(Number) : [];
  if (
    attempts === undefined ||
    ttlMs === undefined ||
    (taken !== 0 && taken !== 1) ||
    !Number.isFinite(attempts + ttlMs)
  ) {
    throw new AppError("SERVICE_UNAVAILABLE");
  }
  return Object.freeze({ taken: taken === 1, state: lockoutState(attempts, ttlMs) });
}

/** The sign-in lockout of the request's tenant and environment (see the file header). */
@Injectable()
export class SignInLockout {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: LockoutRedis,
    private readonly tenants: TenantContext,
  ) {}

  /** Counts a sign-in attempt of `email` before its password is looked at, unless the address is locked. */
  async takeAttempt(email: string): Promise<LockoutAttempt> {
    const counter = this.counterOf(email);
    return attemptOf(
      await this.command(() =>
        this.redis.eval(
          TAKE_ATTEMPT,
          1,
          counter.key,
          String(counter.ttlSeconds * 1000),
          String(MAX_SIGN_IN_FAILURES),
        ),
      ),
    );
  }

  /** Forgets the attempts of `email` (a successful sign-in). */
  async clear(email: string): Promise<void> {
    const counter = this.counterOf(email);
    await this.command(() => this.redis.del(counter.key));
  }

  /** The counter of `email` for the request's tenant and environment. */
  private counterOf(email: string): RedisKey<"tenant"> {
    const tenant = this.tenants.require();
    return redisKeys.authfail(tenant.tenantId, tenant.environment, emailDigest(email));
  }

  /** A Redis command; a failure is `503 SERVICE_UNAVAILABLE` (the lockout is never skipped). */
  private async command<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
  }
}
