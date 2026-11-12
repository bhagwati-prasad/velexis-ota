// AmadeusRateLimiter against Redis doubles (OBE-018, OBE-102; OADR-0001 point 6 and its revision of 2026-11-12,
// flows/amadeus-connection-and-tokens.md §4 and §7): the two buckets, their limits, reserves and TTLs, the answers of
// the script, 429 with the wait, and 503 without Redis. A recording double checks what the limiter sends; a second double
// runs the script's arithmetic as a line-by-line port of TAKE_TOKENS_SCRIPT (below), for the reserve of the interactive
// calls: a background call refused at the reserve and an interactive one let through, both buckets, the refill, and
// nothing taken on a refusal. The script itself runs against Redis 7 with the same figures in
// test/integration/amadeus/client.int.test.ts.
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "../common/ids";
import { AMADEUS_BUCKET_TTL_SECONDS, redisKeys } from "../common/redis/redis.keys";
import { AMADEUS_BACKGROUND_RESERVE, DEFAULT_AMADEUS_LIMITS, type AmadeusLimits } from "./limits";
import {
  AmadeusRateLimitedError,
  AmadeusRateLimiter,
  bucketTtlMs,
  checkBackgroundReserve,
  reserveFor,
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

/** A bucket hash as the script writes it. */
interface BucketHash {
  readonly tokens: number;
  readonly at: number;
}

/**
 * A Redis whose EVAL runs TAKE_TOKENS_SCRIPT's arithmetic, ported statement by statement (the same names, the same
 * order), with the bucket hashes in a map. Only the script is accepted.
 */
class BucketRedis {
  status = "ready";
  readonly hashes = new Map<string, BucketHash>();

  /** The level of a bucket as `level()` of the script computes it, without taking. */
  levelOf(key: string, now: number, rate: number, burst: number): number {
    return this.level(key, now, rate, burst)[0];
  }

  private level(key: string, now: number, rate: number, burst: number): [number, number] {
    const state = this.hashes.get(key);
    if (state === undefined) {
      return [burst, now];
    }
    const elapsed = Math.max(now - state.at, 0);
    const refilled = Math.min(state.tokens + (elapsed * rate) / 1000, burst);
    return [refilled, state.at > now ? state.at : now];
  }

  eval(script: string, keyCount: number, ...rest: Array<string | number>): Promise<unknown> {
    expect([script, keyCount]).toEqual([TAKE_TOKENS_SCRIPT, 2]);
    const [credKey, tenKey] = [String(rest[0]), String(rest[1])];
    /** ARGV[i] of the script (1-based, as in Lua). */
    const argv = (index: number): number => Number(rest[1 + index]);
    const now = argv(1);
    const [credRate, credBurst] = [argv(2), argv(3)];
    const [tenRate, tenBurst] = [argv(5), argv(6)];
    const credNeed = argv(8) + 1;
    const tenNeed = argv(9) + 1;
    const [cred, credAt] = this.level(credKey, now, credRate, credBurst);
    const [ten, tenAt] = this.level(tenKey, now, tenRate, tenBurst);
    if (cred < credNeed || ten < tenNeed) {
      let wait = 0;
      let empty = "tenant";
      if (cred < credNeed) {
        wait = ((credNeed - cred) * 1000) / credRate;
        empty = "credential";
      }
      if (ten < tenNeed) {
        wait = Math.max(wait, ((tenNeed - ten) * 1000) / tenRate);
        empty = "tenant";
      }
      return Promise.resolve([0, Math.ceil(wait), empty]);
    }
    this.hashes.set(credKey, { tokens: cred - 1, at: credAt });
    this.hashes.set(tenKey, { tokens: ten - 1, at: tenAt });
    return Promise.resolve([1, 0, ""]);
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

  it("[OBE-102 AC1] keep half of each burst for the interactive calls: 10 of the credential set's, 5 of the tenant's", () => {
    const { credentialBucket, tenantBucket, backgroundReserve } = DEFAULT_AMADEUS_LIMITS;

    expect(backgroundReserve).toBe(AMADEUS_BACKGROUND_RESERVE);
    expect(backgroundReserve).toEqual({
      credential: credentialBucket.burst / 2,
      tenant: tenantBucket.burst / 2,
    });
    expect(reserveFor(DEFAULT_AMADEUS_LIMITS, "background")).toEqual({ credential: 10, tenant: 5 });
    expect(reserveFor(DEFAULT_AMADEUS_LIMITS, "interactive")).toEqual({ credential: 0, tenant: 0 });
  });

  it("takes from both keys in one script, with the clock's time, the limits, the TTLs and no reserve", async () => {
    await limiter().take(owner);

    const credential = redisKeys.amadeusCredentialBucket(owner.credId, "test");
    const tenant = redisKeys.amadeusTenantBucket(owner.tenantId, "test");
    expect(credential.key).toBe(`rl:amadeus:cred:${owner.credId}:test`);
    expect(tenant.key).toBe(`rl:amadeus:ten:${owner.tenantId}:test`);
    expect(redis.calls).toEqual([
      [TAKE_TOKENS_SCRIPT, 2, credential.key, tenant.key, NOW.getTime(), 20, 20, 2000, 5, 10, 2000, 0, 0],
    ]);
  });

  it("[OBE-102 AC1] sends the reserves with a background call, and none with an interactive one", async () => {
    await limiter().take(owner, "background");
    await limiter().take(owner, "interactive");

    expect(redis.calls.map((call) => call.slice(-2))).toEqual([
      [10, 5],
      [0, 0],
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

describe("the script's arithmetic, with the reserve [OBE-102 AC1]", () => {
  let buckets: BucketRedis;
  const credKey = (credId: string): string => redisKeys.amadeusCredentialBucket(credId, "test").key;
  const tenKey = (tenantId: string): string => redisKeys.amadeusTenantBucket(tenantId, "test").key;
  const take = (who: BucketOwner, priority: "interactive" | "background"): Promise<void> =>
    new AmadeusRateLimiter(buckets as unknown as Redis, clock).take(who, priority);
  /** The levels of the owner's two buckets at the clock's time: `[credential, tenant]`. */
  const levels = (who: BucketOwner): [number, number] => [
    buckets.levelOf(credKey(who.credId), clock.now().getTime(), 20, 20),
    buckets.levelOf(tenKey(who.tenantId), clock.now().getTime(), 5, 10),
  ];

  beforeEach(() => {
    buckets = new BucketRedis();
  });

  it("refuses a background call at the tenant's reserve, lets an interactive one through, and refills", async () => {
    for (let call = 0; call < 5; call += 1) {
      await take(owner, "interactive");
    }
    expect(levels(owner)).toEqual([15, 5]);

    const refused = await rejection(take(owner, "background"));

    expect([refused.code, refused.details]).toEqual(["RATE_LIMITED", { retryAfterSeconds: 1 }]);
    expect(refused.cause).toEqual(new AmadeusRateLimitedError("tenant", 200, "background"));
    expect(levels(owner)).toEqual([15, 5]);

    await take(owner, "interactive");
    expect(levels(owner)).toEqual([14, 4]);

    // 400 ms refill 2 tenant tokens: 6, the reserve and one more.
    clock.advance(400);
    await take(owner, "background");
    expect(levels(owner)).toEqual([19, 5]);
    expect((await rejection(take(owner, "background"))).cause).toEqual(
      new AmadeusRateLimitedError("tenant", 200, "background"),
    );
  });

  it("refuses a background call at the shared credential set's reserve, and takes nothing from the tenant", async () => {
    const credId = newId("ama");
    const [first, second, third] = [newId("ten"), newId("ten"), newId("ten")];
    for (const tenantId of [first, second]) {
      for (let call = 0; call < 5; call += 1) {
        await take({ credId, tenantId, environment: "test" }, "interactive");
      }
    }
    const shopper = { credId, tenantId: third, environment: "test" } as const;
    expect(levels(shopper)).toEqual([10, 10]);

    const refused = await rejection(take(shopper, "background"));

    expect(refused.cause).toEqual(new AmadeusRateLimitedError("credential", 50, "background"));
    expect(buckets.hashes.has(tenKey(third))).toBe(false);
    await take(shopper, "interactive");
    expect(levels(shopper)).toEqual([9, 9]);

    // 100 ms refill 2 credential tokens: 11, the reserve and one more; the tenant has 9.5.
    clock.advance(100);
    await take(shopper, "background");
    expect(levels(shopper)).toEqual([10, 8.5]);
  });

  it("answers the longer wait and the tenant when both buckets are at their reserve, and changes neither", async () => {
    const credId = newId("ama");
    const tenants = [newId("ten"), newId("ten")];
    for (const tenantId of tenants) {
      for (let call = 0; call < 5; call += 1) {
        await take({ credId, tenantId, environment: "test" }, "interactive");
      }
    }
    const busy = { credId, tenantId: tenants[1] as string, environment: "test" } as const;
    expect(levels(busy)).toEqual([10, 5]);

    const refused = await rejection(take(busy, "background"));

    expect(refused.cause).toEqual(new AmadeusRateLimitedError("tenant", 200, "background"));
    expect(levels(busy)).toEqual([10, 5]);
    // An interactive call still has 5 tenant tokens and 10 of the account.
    for (let call = 0; call < 5; call += 1) {
      await take(busy, "interactive");
    }
    expect(levels(busy)).toEqual([5, 0]);
    expect((await rejection(take(busy, "interactive"))).cause).toEqual(
      new AmadeusRateLimitedError("tenant", 200),
    );
  });

  it("gives a background call the tokens above the reserve of a full bucket, then the refill only", async () => {
    let taken = 0;
    for (;;) {
      const outcome = await take(owner, "background").then(
        () => true,
        () => false,
      );
      if (!outcome) {
        break;
      }
      taken += 1;
    }
    expect([taken, ...levels(owner)]).toEqual([5, 15, 5]);

    clock.advance(1000);
    let refilled = 0;
    while (
      await take(owner, "background").then(
        () => true,
        () => false,
      )
    ) {
      refilled += 1;
    }
    expect(refilled).toBe(5);
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
    expect((tenantEmpty.cause as AmadeusRateLimitedError).priority).toBe("interactive");
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
      backgroundReserve: { credential: 25, tenant: 0 },
    }).take({ ...owner, environment: "live" }, "background");

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
      25,
      0,
    ]);
  });

  it("[OBE-102 AC1] refuses a reserve that does not leave a background call a token of its bucket", () => {
    const withReserve = (credential: number, tenant: number): AmadeusLimits => ({
      ...DEFAULT_AMADEUS_LIMITS,
      backgroundReserve: { credential, tenant },
    });

    expect(() => checkBackgroundReserve(DEFAULT_AMADEUS_LIMITS)).not.toThrow();
    expect(() => checkBackgroundReserve(withReserve(0, 9))).not.toThrow();
    expect(() => checkBackgroundReserve(withReserve(19, 0))).not.toThrow();
    for (const [credential, tenant] of [
      [20, 5],
      [10, 10],
      [-1, 5],
      [10, 2.5],
      [Number.NaN, 5],
    ] as const) {
      expect(() => checkBackgroundReserve(withReserve(credential, tenant))).toThrow(RangeError);
    }
    expect(() => limiter(withReserve(10, 10))).toThrow(RangeError);
  });
});
