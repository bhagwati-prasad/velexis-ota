// The abuse limits of checkout.completeWithAirlineCard (OBE-051; OADR-0004 point 6, ADR-0011 (C), ota/docs/
// architecture.md §7 and §8, ota/docs/flows/checkout-airline-card.md §1 and §4). The request limits (5 per minute per
// IP and 60 per hour per tenant) are the rate-limit guard's (common/http/rate-limits.ts, `airlineCardPerIp` and
// `airlineCardPerTenant`), counted before the handler. This file holds the two that are counted where the outcome is
// known, both in Redis with their TTL (redis.keys.ts):
//
//   - the attempts of one checkout, `t:<tenantId>:<env>:ac:chk:<checkoutId>` (2 hours): a card the airline declined
//     counts as an attempt. The third decline answers `403 PAYMENT_ATTEMPTS_EXCEEDED` (and alerts, the completion
//     service), and every later request on the checkout is refused with the same `403` before anything is sent: the
//     fourth attempt never reaches Amadeus. `assertAvailable` runs before the booking's claim and again right before the
//     card is sent, after the claim, and a decline is counted before its booking fails and frees the checkout, so a
//     completion running concurrently with the third decline is refused too. A card the server refuses (Luhn, expiry,
//     brand) or a request that never sent the card (a price change, a sold-out re-price, Amadeus not reached) is not an
//     attempt;
//   - the declines of the tenant and environment, `t:<tenantId>:<env>:ac:declines` (a fixed window of one hour from the
//     first): the 20th suspends the method for the tenant and environment for an hour, the flag
//     `t:<tenantId>:<env>:ac:suspended`, set once (`SET NX`) so the alert of a suspension goes out once; the counter is
//     dropped with it, so counting starts afresh once the hour is over. While the flag is set every completion answers
//     `403 FEATURE_DISABLED` (`details.feature = "airlineCard"`, `details.reason = "suspended"`).
//
// Both are read and written by one Lua script each, so a counter never exists without its TTL (noeviction, ADR-0009
// item 2). Without Redis the route refuses with `503 SERVICE_UNAVAILABLE` rather than run without its limits
// (architecture §10): `assertAvailable` fails the request, and a decline that cannot be counted is logged (the
// declined card's booking fails all the same; the next request meets the Redis outage at `assertAvailable`).
//
// The suspension is also read where the method is offered (lead decision (2) of 2026-10-24, FIX-W29-OTA; OADR-0004
// point 6 as revised that day): `suspension` tells storefront.get not to list the method while the flag is set, and
// `assertNotSuspended` refuses checkout.createPayment {method: "airline_card"} with the same `403 FEATURE_DISABLED`
// (`details.reason = "suspended"`). A Redis that cannot say counts as suspended there too: storefront.get leaves the
// method out, and createPayment answers `503 SERVICE_UNAVAILABLE`, as the completion would.
import { Inject, Injectable } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../../common/redis/redis.module";
import { redisKeys, type KeyEnvironment } from "../../common/redis/redis.keys";
import { AIRLINE_CARD_FEATURE } from "./airline-card.gateway";

/** Declined attempts on one checkout; the one that reaches it answers `403 PAYMENT_ATTEMPTS_EXCEEDED`. */
export const AIRLINE_CARD_MAX_ATTEMPTS = 3;

/** Declines of a tenant and environment within an hour that suspend the method for an hour. */
export const AIRLINE_CARD_TENANT_DECLINES = 20;

/** `details.reason` of the `403 FEATURE_DISABLED` of a suspended method. */
export const AIRLINE_CARD_SUSPENDED = "suspended";

/** What the limits need of the command client (`REDIS_CLIENT`). */
export type AbuseLimitsRedis = Pick<Redis, "eval" | "status">;

/** ioredis statuses in which the command client cannot answer (as the throttler storage's). */
const REDIS_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

/** The checkout's attempts so far, and whether the method is suspended: `{attempts, suspended}`. */
const READ_LIMITS = `
local attempts = tonumber(redis.call('GET', KEYS[1]) or '0')
local suspended = redis.call('EXISTS', KEYS[2])
return { attempts, suspended }
`;

/**
 * Counts one decline: the checkout's attempts and the tenant's declines (each `INCR`, with its TTL when new or lost),
 * and, at the tenant's limit, the suspension flag (`SET NX EX`) with the declines counter dropped. Answers
 * `{attempts, declines, suspendedNow}`, `suspendedNow` 1 only for the decline that set the flag.
 */
const COUNT_DECLINE = `
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local declines = redis.call('INCR', KEYS[2])
if declines == 1 or redis.call('TTL', KEYS[2]) < 0 then
  redis.call('EXPIRE', KEYS[2], ARGV[2])
end
local suspendedNow = 0
if declines >= tonumber(ARGV[4]) then
  if redis.call('SET', KEYS[3], '1', 'EX', ARGV[3], 'NX') then
    suspendedNow = 1
  end
  redis.call('DEL', KEYS[2])
end
return { attempts, declines, suspendedNow }
`;

/** Whether the suspension flag of a tenant and environment is set: 1 or 0. */
const READ_SUSPENSION = `
return redis.call('EXISTS', KEYS[1])
`;

/**
 * What the suspension flag says of the method for a tenant and environment: `available`, `suspended` while it is set,
 * `unknown` when Redis cannot say (the method is then never offered).
 */
export type AirlineCardSuspension = "available" | "suspended" | "unknown";

/** Whose limits: the tenant, the environment and the checkout of the request. */
export interface AirlineCardScope {
  readonly tenantId: string;
  readonly environment: KeyEnvironment;
  readonly checkoutId: string;
}

/** What counting a decline gave. */
export interface CountedDecline {
  /** The checkout's declined attempts, this one included. */
  readonly attempts: number;
  /** The tenant's declines in the window, this one included. */
  readonly declines: number;
  /** True when this decline suspended the method (once per suspension). */
  readonly suspendedNow: boolean;
  /** True when the checkout reached AIRLINE_CARD_MAX_ATTEMPTS with this decline. */
  readonly locked: boolean;
}

/** `403 PAYMENT_ATTEMPTS_EXCEEDED` (new catalogue code of api-changes.md §6). */
export function attemptsExceeded(): AppError {
  return new AppError("PAYMENT_ATTEMPTS_EXCEEDED", {
    message: "Too many airline-card attempts on this checkout; start a new checkout or use another method.",
  });
}

/** `403 FEATURE_DISABLED` of a method suspended after too many declines. */
export function suspendedMethod(): AppError {
  return new AppError("FEATURE_DISABLED", {
    message: "Paying with the airline card is not available at the moment. Use another payment method.",
    details: { feature: AIRLINE_CARD_FEATURE, reason: AIRLINE_CARD_SUSPENDED },
  });
}

const unavailable = (cause?: unknown): AppError =>
  new AppError("SERVICE_UNAVAILABLE", {
    message: "Paying with the airline card is not available at the moment; try again later.",
    cause,
  });

/** The limits of the file header, on the process's Redis client. */
@Injectable()
export class AirlineCardLimits {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: AbuseLimitsRedis) {}

  /**
   * Refuses a request the limits do not let run: `503 SERVICE_UNAVAILABLE` without Redis, `403 FEATURE_DISABLED` while
   * the method is suspended, `403 PAYMENT_ATTEMPTS_EXCEEDED` once the checkout has AIRLINE_CARD_MAX_ATTEMPTS declines.
   */
  async assertAvailable(scope: AirlineCardScope): Promise<void> {
    const attemptsKey = redisKeys.acChk(scope.tenantId, scope.environment, scope.checkoutId);
    const suspendedKey = redisKeys.acSuspended(scope.tenantId, scope.environment);
    const reply = await this.command(() =>
      this.redis.eval(READ_LIMITS, 2, attemptsKey.key, suspendedKey.key),
    );
    const [attempts, suspended] = Array.isArray(reply) ? reply.map(Number) : [];
    if (attempts === undefined || suspended === undefined || !Number.isFinite(attempts + suspended)) {
      throw unavailable();
    }
    if (suspended === 1) {
      throw suspendedMethod();
    }
    if (attempts >= AIRLINE_CARD_MAX_ATTEMPTS) {
      throw attemptsExceeded();
    }
  }

  /** Counts a declined card (see the file header). Throws `503 SERVICE_UNAVAILABLE` when Redis cannot count it. */
  async countDecline(scope: AirlineCardScope): Promise<CountedDecline> {
    const attemptsKey = redisKeys.acChk(scope.tenantId, scope.environment, scope.checkoutId);
    const declinesKey = redisKeys.acDeclines(scope.tenantId, scope.environment);
    const suspendedKey = redisKeys.acSuspended(scope.tenantId, scope.environment);
    const reply = await this.command(() =>
      this.redis.eval(
        COUNT_DECLINE,
        3,
        attemptsKey.key,
        declinesKey.key,
        suspendedKey.key,
        String(attemptsKey.ttlSeconds),
        String(declinesKey.ttlSeconds),
        String(suspendedKey.ttlSeconds),
        String(AIRLINE_CARD_TENANT_DECLINES),
      ),
    );
    const [attempts, declines, suspendedNow] = Array.isArray(reply) ? reply.map(Number) : [];
    if (
      attempts === undefined ||
      declines === undefined ||
      suspendedNow === undefined ||
      !Number.isFinite(attempts + declines + suspendedNow)
    ) {
      throw unavailable();
    }
    return {
      attempts,
      declines,
      suspendedNow: suspendedNow === 1,
      locked: attempts >= AIRLINE_CARD_MAX_ATTEMPTS,
    };
  }

  /**
   * The suspension of the method for the tenant and environment (see the file header): `suspended` while the flag is
   * set, `unknown` when Redis does not answer or answers something else, `available` otherwise. Never throws.
   */
  async suspension(tenantId: string, environment: KeyEnvironment): Promise<AirlineCardSuspension> {
    const suspendedKey = redisKeys.acSuspended(tenantId, environment);
    try {
      const reply = await this.command(() => this.redis.eval(READ_SUSPENSION, 1, suspendedKey.key));
      return reply === 1 ? "suspended" : reply === 0 ? "available" : "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * Refuses to prepare a payment of a method that is suspended (checkout.createPayment, see the file header): `403
   * FEATURE_DISABLED` (`details.reason = "suspended"`) while the flag is set, `503 SERVICE_UNAVAILABLE` when Redis
   * cannot say.
   */
  async assertNotSuspended(tenantId: string, environment: KeyEnvironment): Promise<void> {
    const suspension = await this.suspension(tenantId, environment);
    if (suspension === "suspended") {
      throw suspendedMethod();
    }
    if (suspension === "unknown") {
      throw unavailable();
    }
  }

  /** A Redis command; a client that waits to reconnect or fails is `503 SERVICE_UNAVAILABLE`. */
  private async command<T>(run: () => Promise<T>): Promise<T> {
    if (REDIS_DOWN.has(this.redis.status)) {
      throw unavailable();
    }
    try {
      return await run();
    } catch (error) {
      throw unavailable(error);
    }
  }
}
