// The storage of the API's rate limits (OBE-013; ota/docs/architecture.md §8, tech-stack "Rate limiting"): the
// counters of @nestjs/throttler in Redis, so the limits hold across processes and restarts. One fixed-window counter
// per throttler and tracker, `rl:<throttler>:<tracker>` of redis.keys.ts, whose TTL is the window: the first hit
// starts the window, the hit after the limit is refused until the window ends, and the time left is the `Retry-After`
// of the 429 (common/http/rate-limits.ts).
//
// The counter and its TTL are written by one Lua script, so a counter never exists without a TTL (Redis runs with
// `noeviction`, ADR-0009 item 2): a counter that somehow lost it gets it back on the next hit. A failing Redis (down,
// or an answer that is not the script's) throws `RateLimitStoreUnavailableError`, which the rate-limit guard turns into
// `503 SERVICE_UNAVAILABLE` (architecture §10): a limit that cannot be counted is not skipped. While the client waits to
// reconnect it fails at once, as the platform cache does, rather than holding the request until the next attempt
// (up to 2 s, redis.module.ts).
import type { ThrottlerStorage } from "@nestjs/throttler";
import type { Redis } from "ioredis";
import { redisKeys } from "./redis.keys";

/** What the storage needs of the command client (`REDIS_CLIENT`). */
export type ThrottlerRedis = Pick<Redis, "eval" | "status">;

/** ioredis statuses in which the command client cannot answer: it waits to reconnect, or has been closed. */
const REDIS_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

/**
 * Counts one hit: `INCR`, and the window as the TTL when the hit is the first (or the counter has no TTL). Answers the
 * hits in the window so far, this one included, and the milliseconds until the window ends.
 */
const INCREMENT_IN_WINDOW = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if hits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/** Redis could not count a hit: the request is refused with 503 rather than let through uncounted. */
export class RateLimitStoreUnavailableError extends Error {
  override readonly name = "RateLimitStoreUnavailableError";
}

/** What @nestjs/throttler expects of `increment`. */
export interface ThrottlerCount {
  readonly totalHits: number;
  /** Seconds until the window ends (at least 1). */
  readonly timeToExpire: number;
  readonly isBlocked: boolean;
  /** Seconds until a blocked tracker may try again: the rest of the window; 0 when not blocked. */
  readonly timeToBlockExpire: number;
}

/**
 * The throttler storage on Redis. `key` is the tracker the guard computed (a digest, never an IP or an e-mail address
 * in clear), `ttl` the window in milliseconds; `blockDuration` is ignored: a tracker over the limit waits for its
 * window to end.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly client: ThrottlerRedis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerCount> {
    const counter = redisKeys.throttle(throttlerName, key, ttl / 1000);
    if (REDIS_DOWN.has(this.client.status)) {
      throw new RateLimitStoreUnavailableError("the rate-limit counters in Redis cannot be reached");
    }
    let reply: unknown;
    try {
      reply = await this.client.eval(INCREMENT_IN_WINDOW, 1, counter.key, String(counter.ttlSeconds * 1000));
    } catch (error) {
      throw new RateLimitStoreUnavailableError("the rate-limit counters in Redis cannot be reached", {
        cause: error,
      });
    }
    const [hits, expiresInMs] = Array.isArray(reply) ? reply.map(Number) : [];
    if (hits === undefined || expiresInMs === undefined || !Number.isFinite(hits + expiresInMs)) {
      throw new RateLimitStoreUnavailableError("unexpected reply of the rate-limit script");
    }
    const secondsLeft = Math.max(1, Math.ceil(expiresInMs / 1000));
    const isBlocked = hits > limit;
    return {
      totalHits: hits,
      timeToExpire: secondsLeft,
      isBlocked,
      timeToBlockExpire: isBlocked ? secondsLeft : 0,
    };
  }
}
