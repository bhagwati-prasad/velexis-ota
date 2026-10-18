// AmadeusRateLimiter against a recording Redis double (OBE-018; OADR-0001 point 6, flows/amadeus-connection-and-tokens
// .md §4 and §7): the two buckets, their limits and TTLs, the answers of the script, 429 with the wait, and 503 without
// Redis. The script itself runs against Redis 7 in test/integration/amadeus/client.int.test.ts (burst, refill, the
// shared credential bucket, nothing taken on a refusal).
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "../common/ids";
import { AMADEUS_BUCKET_TTL_SECONDS, redisKeys } from "../common/redis/redis.keys";
import { DEFAULT_AMADEUS_LIMITS, type AmadeusLimits } from "./limits";
import {
  AmadeusRateLimitedError,
  AmadeusRateLimiter,
  bucketTtlMs,
  retryAfterSeconds,
  TAKE_TOKENS_SCRIPT,
  type BucketOwner,
} from "./rate-limiter";

/** The EVAL calls it receives, answering with `answer` (or failing with `failure`). */
class RecordingRedis {
  status = "ready";
  answer: unknown = [1, 0, ""];
  failure: Error | undefined;
  readonly calls: unknown[][] = [];

  eval(...args: unknown[]): Promise<unknown> {
    this.calls.push(args);
    return this.failure === undefined ? Promise.resolve(this.answer) : Promise.reject(this.failure);
  }
}

const NOW = new Date("2026-11-01T12:00:00.000Z");

let redis: RecordingRedis;
let clock: FakeClock;
let owner: BucketOwner;

const limiter = (limits?: AmadeusLimits): AmadeusRateLimiter =>
  new AmadeusRateLimiter(redis as unknown as Redis, clock, limits);

/** The AppError a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

beforeEach(() => {
  redis = new RecordingRedis();
  clock = new FakeClock(NOW);
  owner = { credId: newId("ama"), tenantId: newId("ten"), environment: "test" };
});

describe("the buckets", () => {
  it("start at 20 per second for a credential set and 5 per second, burst 10, for a tenant (flow §4)", () => {
    expect(DEFAULT_AMADEUS_LIMITS.credentialBucket).toEqual({ ratePerSecond: 20, burst: 20 });
    expect(DEFAULT_AMADEUS_LIMITS.tenantBucket).toEqual({ ratePerSecond: 5, burst: 10 });
  });

  it("takes from both keys in one script, with the clock's time, the limits and the TTLs", async () => {
    await limiter().take(owner);

    const credential = redisKeys.amadeusCredentialBucket(owner.credId, "test");
    const tenant = redisKeys.amadeusTenantBucket(owner.tenantId, "test");
    expect(credential.key).toBe(`rl:amadeus:cred:${owner.credId}:test`);
    expect(tenant.key).toBe(`rl:amadeus:ten:${owner.tenantId}:test`);
    expect(redis.calls).toEqual([
      [TAKE_TOKENS_SCRIPT, 2, credential.key, tenant.key, NOW.getTime(), 20, 20, 2000, 5, 10, 2000],
    ]);
  });

  it("keeps a bucket until it would be full again: the key's TTL, or longer for a slow bucket", () => {
    const key = redisKeys.amadeusTenantBucket(owner.tenantId, "live");

    expect(key.ttlSeconds).toBe(AMADEUS_BUCKET_TTL_SECONDS);
    expect(bucketTtlMs(key, { ratePerSecond: 5, burst: 10 })).toBe(2000);
    expect(bucketTtlMs(key, { ratePerSecond: 20, burst: 20 })).toBe(2000);
    expect(bucketTtlMs(key, { ratePerSecond: 0.5, burst: 3 })).toBe(6000);
  });
});

describe("an empty bucket", () => {
  it("answers 429 RATE_LIMITED with the wait in whole seconds, at least 1 [OBE-018 AC3]", async () => {
    redis.answer = [0, 200, "tenant"];
    const tenantEmpty = await rejection(limiter().take(owner));
    redis.answer = [0, 2001, "credential"];
    const credentialEmpty = await rejection(limiter().take(owner));

    expect([tenantEmpty.status, tenantEmpty.code, tenantEmpty.details]).toEqual([
      429,
      "RATE_LIMITED",
      { retryAfterSeconds: 1 },
    ]);
    expect(tenantEmpty.cause).toEqual(new AmadeusRateLimitedError("tenant", 200));
    expect(credentialEmpty.details).toEqual({ retryAfterSeconds: 3 });
    expect((credentialEmpty.cause as AmadeusRateLimitedError).bucket).toBe("credential");
    expect([0, 1, 999, 1000, 1001, 59_500].map(retryAfterSeconds)).toEqual([1, 1, 1, 1, 2, 60]);
  });
});

describe("without Redis", () => {
  it("refuses the call with 503 while the client reconnects, without a command", async () => {
    for (const status of ["reconnecting", "close", "end"]) {
      redis.status = status;
      const error = await rejection(limiter().take(owner));

      expect([error.status, error.code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    }
    expect(redis.calls).toEqual([]);
  });

  it("refuses the call with 503 when the script fails or answers something else", async () => {
    const closed = new Error("Connection is closed.");
    redis.failure = closed;
    const failed = await rejection(limiter().take(owner));
    redis.failure = undefined;
    redis.answer = "OK";
    const unexpected = await rejection(limiter().take(owner));
    redis.answer = [0, "soon", "tenant"];
    const malformed = await rejection(limiter().take(owner));

    expect([failed.code, unexpected.code, malformed.code]).toEqual([
      "SERVICE_UNAVAILABLE",
      "SERVICE_UNAVAILABLE",
      "SERVICE_UNAVAILABLE",
    ]);
    expect(failed.cause).toBe(closed);
  });
});

describe("other limits", () => {
  it("passes the limits it was given", async () => {
    await limiter({
      ...DEFAULT_AMADEUS_LIMITS,
      credentialBucket: { ratePerSecond: 100, burst: 50 },
      tenantBucket: { ratePerSecond: 0.5, burst: 1 },
    }).take({ ...owner, environment: "live" });

    expect(redis.calls[0]?.slice(2)).toEqual([
      redisKeys.amadeusCredentialBucket(owner.credId, "live").key,
      redisKeys.amadeusTenantBucket(owner.tenantId, "live").key,
      NOW.getTime(),
      100,
      50,
      2000,
      0.5,
      1,
      2000,
    ]);
  });
});
