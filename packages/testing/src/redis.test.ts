import { describe, expect, it } from "vitest";
import { REDIS_TEST_DATABASES, redisDatabaseIndex, redisUrlWithDatabase } from "./redis.js";

// Tests of task X-015 step 4: the Redis database of a Vitest worker. useRedis itself runs against Redis in
// test/integration/redis.int.test.ts.

describe("redisDatabaseIndex", () => {
  it("is 1 + (VITEST_POOL_ID % 15): 1 to 15, never the developer's database 0", () => {
    expect(REDIS_TEST_DATABASES).toBe(15);
    expect([0, 1, 2, 14, 15, 16, 29, 30].map(redisDatabaseIndex)).toEqual([1, 2, 3, 15, 1, 2, 15, 1]);
    const indexes = new Set(Array.from({ length: 100 }, (_, poolId) => redisDatabaseIndex(poolId)));
    expect([...indexes].sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it("gives workers running at the same time different databases (up to 15 workers)", () => {
    const workers = Array.from({ length: 15 }, (_, i) => redisDatabaseIndex(i + 1));
    expect(new Set(workers).size).toBe(15);
  });

  it("refuses a pool id that is not a non-negative integer", () => {
    for (const poolId of [-1, 1.5, Number.NaN]) {
      expect(() => redisDatabaseIndex(poolId)).toThrow(
        new RangeError("VITEST_POOL_ID must be a non-negative integer"),
      );
    }
  });
});

describe("redisUrlWithDatabase", () => {
  it("sets the database path and keeps password, host and port", () => {
    expect(redisUrlWithDatabase("redis://:dev_redis@127.0.0.1:6379/0", 7)).toBe(
      "redis://:dev_redis@127.0.0.1:6379/7",
    );
    expect(redisUrlWithDatabase("redis://127.0.0.1:6380", 3)).toBe("redis://127.0.0.1:6380/3");
    expect(redisUrlWithDatabase("rediss://user:pw@redis.internal:6390/2?family=6", 15)).toBe(
      "rediss://user:pw@redis.internal:6390/15?family=6",
    );
  });
});
