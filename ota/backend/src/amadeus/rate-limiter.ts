// The Amadeus token buckets (OADR-0001 point 6, flows/amadeus-connection-and-tokens.md §4 and §7, ADR-0012; OBE-018).
// Every call to Amadeus takes one token from two buckets, atomically, in one Lua script:
//
//   rl:amadeus:cred:<credId>:<env>    the credential set's bucket: 20 per second, burst 20, shared by every OTA on the
//                                     Velexis shared account, so one OTA cannot exhaust the account's Amadeus quota
//   rl:amadeus:ten:<tenantId>:<env>   the tenant's bucket: 5 per second, burst 10
//
// A bucket is a hash `{ tokens, at }`: the level after the last take and the time of that take (milliseconds of the
// injected `Clock`, so tests control time; the API processes share one clock on the VM). The script refills each
// bucket for the time since `at` (never above its burst; a missing key is a full bucket), and takes a token from both
// only when both have one. A refused call takes nothing from either, so the tenant that is over its limit does not
// eat the shared bucket. The keys expire when a full refill would have been reached (the TTL of redis.keys.ts, longer
// when a bucket refills more slowly), so an idle bucket costs no memory and comes back full.
//
// An empty bucket answers `429 RATE_LIMITED` with `details.retryAfterSeconds` (the error filter sends it as
// `Retry-After`: the wait until both buckets have a token, at least 1 s), and no call is made. Without Redis the call
// is refused with `503 SERVICE_UNAVAILABLE` (flow §7): unlimited calls could exhaust the shared account's quota.
import { Inject, Injectable, Optional } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { Clock } from "../common/clock";
import { redisKeys, type RedisKey } from "../common/redis/redis.keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import type { AmadeusEnvironment } from "../tenancy/platform-read.repository";
import { AMADEUS_LIMITS, DEFAULT_AMADEUS_LIMITS, type AmadeusLimits, type TokenBucketLimit } from "./limits";

/** ioredis statuses in which the command client cannot answer (as platform-cache.ts and token-provider.ts). */
const REDIS_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

/**
 * KEYS[1] the credential bucket, KEYS[2] the tenant bucket. ARGV[1] now (ms); ARGV[2..4] the credential bucket's rate
 * per second, burst and TTL (ms); ARGV[5..7] the tenant bucket's. Returns `{1, 0, ""}` when both gave a token, else
 * `{0, waitMs, bucket}` with the wait until both have one and the bucket that was empty ("tenant" when both were).
 */
export const TAKE_TOKENS_SCRIPT = `
local now = tonumber(ARGV[1])
local function level(key, rate, burst)
  local state = redis.call("HMGET", key, "tokens", "at")
  local tokens = tonumber(state[1])
  local at = tonumber(state[2])
  if tokens == nil or at == nil then
    return burst, now
  end
  local elapsed = now - at
  if elapsed < 0 then
    elapsed = 0
  end
  local refilled = tokens + elapsed * rate / 1000
  if refilled > burst then
    refilled = burst
  end
  if at > now then
    return refilled, at
  end
  return refilled, now
end
local credRate, credBurst = tonumber(ARGV[2]), tonumber(ARGV[3])
local tenRate, tenBurst = tonumber(ARGV[5]), tonumber(ARGV[6])
local cred, credAt = level(KEYS[1], credRate, credBurst)
local ten, tenAt = level(KEYS[2], tenRate, tenBurst)
if cred < 1 or ten < 1 then
  local wait = 0
  local empty = "tenant"
  if cred < 1 then
    wait = (1 - cred) * 1000 / credRate
    empty = "credential"
  end
  if ten < 1 then
    local tenWait = (1 - ten) * 1000 / tenRate
    if tenWait > wait then
      wait = tenWait
    end
    empty = "tenant"
  end
  return {0, math.ceil(wait), empty}
end
redis.call("HSET", KEYS[1], "tokens", tostring(cred - 1), "at", tostring(credAt))
redis.call("PEXPIRE", KEYS[1], ARGV[4])
redis.call("HSET", KEYS[2], "tokens", tostring(ten - 1), "at", tostring(tenAt))
redis.call("PEXPIRE", KEYS[2], ARGV[7])
return {1, 0, ""}
`;

/** Which bucket refused a call. */
export type AmadeusBucket = "credential" | "tenant";

/** The cause of a `429 RATE_LIMITED`: the bucket and the ids, for the logs. */
export class AmadeusRateLimitedError extends Error {
  override readonly name = "AmadeusRateLimitedError";

  constructor(
    readonly bucket: AmadeusBucket,
    readonly retryAfterMs: number,
  ) {
    super(`the Amadeus ${bucket} bucket is empty for another ${retryAfterMs} ms`);
  }
}

/** What a call takes tokens for: the credential set and the tenant, in one environment. */
export interface BucketOwner {
  readonly credId: string;
  readonly tenantId: string;
  readonly environment: AmadeusEnvironment;
}

/** The TTL of a bucket key: the builder's, or longer when the bucket takes longer to refill completely. */
export function bucketTtlMs(key: RedisKey, limit: TokenBucketLimit): number {
  return Math.max(key.ttlSeconds * 1000, Math.ceil((limit.burst / limit.ratePerSecond) * 1000));
}

/** `Retry-After` in whole seconds for a wait in milliseconds: at least 1. */
export function retryAfterSeconds(waitMs: number): number {
  return Math.max(1, Math.ceil(waitMs / 1000));
}

@Injectable()
export class AmadeusRateLimiter {
  private readonly limits: AmadeusLimits;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly clock: Clock,
    @Optional() @Inject(AMADEUS_LIMITS) limits?: AmadeusLimits,
  ) {
    this.limits = limits ?? DEFAULT_AMADEUS_LIMITS;
  }

  /**
   * Takes one token from the credential set's bucket and one from the tenant's, or neither. Throws
   * `429 RATE_LIMITED` (`details.retryAfterSeconds`, cause `AmadeusRateLimitedError`) when either is empty, and
   * `503 SERVICE_UNAVAILABLE` when Redis cannot answer.
   */
  async take(owner: BucketOwner): Promise<void> {
    const credential = redisKeys.amadeusCredentialBucket(owner.credId, owner.environment);
    const tenant = redisKeys.amadeusTenantBucket(owner.tenantId, owner.environment);
    const { credentialBucket, tenantBucket } = this.limits;
    if (REDIS_DOWN.has(this.redis.status)) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }
    let result: unknown;
    try {
      result = await this.redis.eval(
        TAKE_TOKENS_SCRIPT,
        2,
        credential.key,
        tenant.key,
        this.clock.now().getTime(),
        credentialBucket.ratePerSecond,
        credentialBucket.burst,
        bucketTtlMs(credential, credentialBucket),
        tenantBucket.ratePerSecond,
        tenantBucket.burst,
        bucketTtlMs(tenant, tenantBucket),
      );
    } catch (error) {
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
    const [allowed, waitMs, bucket] = Array.isArray(result) ? (result as unknown[]) : [];
    if (allowed === 1) {
      return;
    }
    if (allowed !== 0 || typeof waitMs !== "number" || (bucket !== "credential" && bucket !== "tenant")) {
      throw new AppError("SERVICE_UNAVAILABLE", {
        cause: new Error("the Amadeus bucket script answered something unexpected"),
      });
    }
    throw new AppError("RATE_LIMITED", {
      details: { retryAfterSeconds: retryAfterSeconds(waitMs) },
      cause: new AmadeusRateLimitedError(bucket, waitMs),
    });
  }
}
