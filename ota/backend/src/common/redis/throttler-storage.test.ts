// The Redis storage of the rate limits (OBE-013): what it asks Redis and how it reads the answer, with a recording
// client. Against Redis itself (the counter, its TTL, an outage): test/integration/common/guards.int.test.ts.
import { describe, expect, it, vi } from "vitest";
import {
  RateLimitStoreUnavailableError,
  RedisThrottlerStorage,
  type ThrottlerRedis,
} from "./throttler-storage";

const TRACKER = "a".repeat(64);

function storage(reply: () => Promise<unknown>, status = "ready") {
  const evalCall = vi.fn(reply);
  return {
    store: new RedisThrottlerStorage({ eval: evalCall, status } as unknown as ThrottlerRedis),
    evalCall,
  };
}

describe("RedisThrottlerStorage", () => {
  it("counts one hit of rl:<throttler>:<tracker> with the window as its TTL, in one script", async () => {
    const { store, evalCall } = storage(() => Promise.resolve<unknown>([3, 42_100]));

    const count = await store.increment(TRACKER, 60_000, 30, 60_000, "ota_shopping");

    expect(count).toEqual({ totalHits: 3, timeToExpire: 43, isBlocked: false, timeToBlockExpire: 0 });
    expect(evalCall).toHaveBeenCalledWith(
      expect.stringContaining("INCR"),
      1,
      `rl:ota_shopping:${TRACKER}`,
      "60000",
    );
  });

  it("blocks the hit after the limit until the window ends, never for less than a second", async () => {
    expect(
      await storage(() => Promise.resolve<unknown>([31, 12_001])).store.increment(
        TRACKER,
        60_000,
        30,
        60_000,
        "ota_shopping",
      ),
    ).toEqual({
      totalHits: 31,
      timeToExpire: 13,
      isBlocked: true,
      timeToBlockExpire: 13,
    });
    expect(
      (
        await storage(() => Promise.resolve<unknown>([31, 0])).store.increment(
          TRACKER,
          60_000,
          30,
          60_000,
          "ota_shopping",
        )
      ).timeToBlockExpire,
    ).toBe(1);
  });

  it("throws RateLimitStoreUnavailableError when Redis fails or answers something else", async () => {
    for (const reply of [
      () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:6379")),
      () => Promise.resolve<unknown>("OK"),
      () => Promise.resolve<unknown>([1]),
      () => Promise.resolve<unknown>(["x", "y"]),
    ]) {
      await expect(
        storage(reply).store.increment(TRACKER, 60_000, 30, 60_000, "ota_shopping"),
      ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    }
  });

  it("fails at once while the client waits to reconnect or has closed, without a command", async () => {
    for (const status of ["reconnecting", "close", "end"]) {
      const { store, evalCall } = storage(() => Promise.resolve<unknown>([1, 60_000]), status);
      await expect(store.increment(TRACKER, 60_000, 30, 60_000, "ota_shopping")).rejects.toBeInstanceOf(
        RateLimitStoreUnavailableError,
      );
      expect(evalCall).not.toHaveBeenCalled();
    }
  });

  it("refuses a throttler name or tracker that cannot be a key part, before any command", async () => {
    const { store, evalCall } = storage(() => Promise.resolve<unknown>([1, 60_000]));

    await expect(store.increment("203.0.113.7", 60_000, 30, 60_000, "ota_shopping")).rejects.toThrow(
      /tracker/,
    );
    await expect(store.increment(TRACKER, 60_000, 30, 60_000, "amadeus")).rejects.toThrow(/amadeus/);
    expect(evalCall).not.toHaveBeenCalled();
  });
});
