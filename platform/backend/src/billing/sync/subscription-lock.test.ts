// The lock of one Stripe subscription's sync (FIX-W30-PLATFORM; subscription-lock.ts, PADR-0002 item 5 revision of
// 2026-10-26): two billing events of one subscription run their re-fetch and their write one after the other, a
// waiting event gives up after 30 s with a retryable failure (BullMQ runs it again), the holder renews the lock while
// it works and confirms it just before its commit, and a holder never renews or releases a lock it lost.
//
// The lock runs here over an in-memory Redis whose TTLs follow the (fake) clock, with Vitest's fake timers, so a
// holder "works" for 40 seconds without a real wait and every step happens at a known instant. The lock over the real
// Redis, inside the worker, is in test/integration/billing/billing-events.int.test.ts.
import type { PinoLogger } from "nestjs-pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  redisKeys,
  STRIPE_SUBSCRIPTION_LOCK_TTL_SECONDS,
  type RedisWriter,
} from "../../common/redis/redis-keys";
import { StripeEventFailure } from "../../common/stripe/stripe-inbox.service";
import {
  SUBSCRIPTION_LOCK_POLL_MS,
  SUBSCRIPTION_LOCK_RENEW_MS,
  SUBSCRIPTION_LOCK_WAIT_MS,
  SubscriptionSyncLock,
  type HeldSubscriptionLock,
} from "./subscription-lock";

const SUBSCRIPTION = "sub_1QFixW30LockUnitAlpha";
const OTHER_SUBSCRIPTION = "sub_1QFixW30LockUnitBravo";
const LOCK = redisKeys.stripeSubscriptionLock(SUBSCRIPTION).key;

/**
 * Redis in memory, for what the lock sends: `SET … EX … NX` and the renew and release scripts of redis-keys.ts (told
 * apart by their text). A key expires when the fake clock passes its TTL.
 */
class MemoryRedis {
  private readonly entries = new Map<string, { readonly value: string; readonly expiresAt: number }>();
  private readonly origin = Date.now();
  /** The renewals asked for: milliseconds since the test began, and whether the lock was renewed. */
  readonly renewals: Array<{ readonly at: number; readonly renewed: boolean }> = [];
  /** Errors the next `SET`s throw, one each. */
  readonly setFailures: Error[] = [];
  /** Errors the next scripts (a renewal or the release) throw, one each; a failed renewal is not in `renewals`. */
  readonly evalFailures: Error[] = [];

  value(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry !== undefined && Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry?.value;
  }

  /** Milliseconds `key` has left, or -2 when it does not exist (as `PTTL` answers). */
  pttl(key: string): number {
    const entry = this.value(key) === undefined ? undefined : this.entries.get(key);
    return entry === undefined ? -2 : entry.expiresAt - Date.now();
  }

  /** Writes `key` as another holder would. */
  put(key: string, value: string, ttlSeconds: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  set(key: string, value: string, ex: string, ttlSeconds: number, nx?: string): Promise<"OK" | null> {
    const failure = this.setFailures.shift();
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    if (ex !== "EX" || nx !== "NX") {
      throw new Error(`MemoryRedis: unexpected SET options ${ex} ${String(nx)}`);
    }
    if (this.value(key) !== undefined) {
      return Promise.resolve(null);
    }
    this.put(key, value, ttlSeconds);
    return Promise.resolve("OK");
  }

  eval(script: string, keys: number, key: string, token: string, ttlSeconds?: string): Promise<number> {
    if (keys !== 1) {
      throw new Error("MemoryRedis: one key per script");
    }
    const failure = this.evalFailures.shift();
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    const held = this.value(key) === token;
    if (script.includes("redis.call('EXPIRE', KEYS[1], ARGV[2])")) {
      if (held) {
        this.put(key, token, Number(ttlSeconds));
      }
      this.renewals.push({ at: Date.now() - this.origin, renewed: held });
      return Promise.resolve(held ? 1 : 0);
    }
    if (script.includes("redis.call('DEL', KEYS[1])")) {
      if (held) {
        this.entries.delete(key);
      }
      return Promise.resolve(held ? 1 : 0);
    }
    throw new Error("MemoryRedis: a script the lock does not send");
  }
}

interface Harness {
  readonly redis: MemoryRedis;
  readonly lock: SubscriptionSyncLock;
  /** What the lock logged, in order (`info` and `warn`). */
  readonly logs: Array<{ readonly level: string; readonly line: unknown; readonly msg: unknown }>;
}

function harness(): Harness {
  const redis = new MemoryRedis();
  const logs: Array<{ level: string; line: unknown; msg: unknown }> = [];
  const logger = {
    info: (line: unknown, msg: unknown) => logs.push({ level: "info", line, msg }),
    warn: (line: unknown, msg: unknown) => logs.push({ level: "warn", line, msg }),
  } as unknown as PinoLogger;
  return { redis, lock: new SubscriptionSyncLock(redis as unknown as RedisWriter, logger), logs };
}

/** Work that records its start and end in `steps` and takes `ms` of the fake clock. */
function work(steps: string[], name: string, ms: number) {
  return async (): Promise<string> => {
    steps.push(`${name} start`);
    await new Promise((resolveWork) => setTimeout(resolveWork, ms));
    steps.push(`${name} end`);
    return name;
  };
}

/** The StripeEventFailure that `promise` rejects with. */
async function failureOf(promise: Promise<unknown>): Promise<StripeEventFailure> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof StripeEventFailure)) {
    throw new Error(`expected a StripeEventFailure, got ${String(error)}`);
  }
  return error;
}

describe("SubscriptionSyncLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("[FIX-W30-PLATFORM AC1] runs the events of one subscription one after the other, and those of another subscription at once", async () => {
    const { redis, lock, logs } = harness();
    const steps: string[] = [];

    const first = lock.run(SUBSCRIPTION, { eventId: "evt_first" }, work(steps, "first", 2_000));
    const second = lock.run(SUBSCRIPTION, { eventId: "evt_second" }, work(steps, "second", 1_000));
    const other = lock.run(OTHER_SUBSCRIPTION, { eventId: "evt_other" }, work(steps, "other", 1_000));
    await vi.advanceTimersByTimeAsync(1_500);

    expect(steps).toEqual(["first start", "other start", "other end"]);
    expect(redis.value(LOCK)).toBeDefined();
    await vi.advanceTimersByTimeAsync(500 + SUBSCRIPTION_LOCK_POLL_MS + 1_000);

    expect(await Promise.all([first, second, other])).toEqual(["first", "second", "other"]);
    expect(steps).toEqual([
      "first start",
      "other start",
      "other end",
      "first end",
      "second start",
      "second end",
    ]);
    // Released after each work: nothing is left for the next event.
    expect(redis.value(LOCK)).toBeUndefined();
    expect(redis.value(redisKeys.stripeSubscriptionLock(OTHER_SUBSCRIPTION).key)).toBeUndefined();
    // The wait is logged once, with the event and the subscription, never the token.
    expect(logs).toEqual([
      {
        level: "info",
        line: { eventId: "evt_second", providerSubscriptionId: SUBSCRIPTION },
        msg: "billing.sync_lock_waiting",
      },
    ]);
  });

  it("[FIX-W30-PLATFORM AC1] renews the lock while the work runs past its TTL, and a waiter gives up after 30 s with the retryable SUBSCRIPTION_BUSY without running its work", async () => {
    const { redis, lock, logs } = harness();
    const steps: string[] = [];
    expect(STRIPE_SUBSCRIPTION_LOCK_TTL_SECONDS * 1000).toBeLessThan(40_000);

    const holder = lock.run(SUBSCRIPTION, { eventId: "evt_holder" }, work(steps, "holder", 40_000));
    await vi.advanceTimersByTimeAsync(1_000);
    const waiter = lock.run(SUBSCRIPTION, { eventId: "evt_waiter" }, work(steps, "waiter", 1_000));
    const refused = failureOf(waiter);
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_LOCK_WAIT_MS + SUBSCRIPTION_LOCK_POLL_MS);

    const failure = await refused;
    expect(failure.code).toBe("SUBSCRIPTION_BUSY");
    expect(failure.options.retryable).toBe(true);
    expect(failure.message).toBe("another event of the subscription held its lock for 30 s");
    expect(steps).toEqual(["holder start"]);
    // Past its 15 s TTL twice over, the lock is still the holder's, renewed every 5 s.
    expect(redis.value(LOCK)).toBeDefined();
    expect(redis.pttl(LOCK)).toBeGreaterThan(
      STRIPE_SUBSCRIPTION_LOCK_TTL_SECONDS * 1000 - SUBSCRIPTION_LOCK_RENEW_MS,
    );
    expect(logs.map((log) => log.msg)).toEqual(["billing.sync_lock_waiting", "billing.sync_lock_busy"]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(await holder).toBe("holder");
    expect(redis.renewals.map((renewal) => renewal.at)).toEqual([
      5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000,
    ]);
    expect(redis.renewals.every((renewal) => renewal.renewed)).toBe(true);
    // Released, and nothing renews it after the work.
    expect(redis.value(LOCK)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(redis.renewals).toHaveLength(7);
  });

  it("[FIX-W30-PLATFORM AC1] confirm() renews the held lock, and fails with the retryable SUBSCRIPTION_LOCK_LOST once the lock is another holder's", async () => {
    const { redis, lock, logs } = harness();

    const confirmed = await lock.run(SUBSCRIPTION, { eventId: "evt_kept" }, async (held) => {
      await vi.advanceTimersByTimeAsync(4_000);
      await held.confirm();
      return redis.pttl(LOCK);
    });
    expect(confirmed).toBe(STRIPE_SUBSCRIPTION_LOCK_TTL_SECONDS * 1000);

    let attempted = false;
    const lost = lock.run(SUBSCRIPTION, { eventId: "evt_lost" }, async (held: HeldSubscriptionLock) => {
      // The lock expired while Redis was unreachable and another event took it with its own token.
      redis.put(LOCK, "another-holder", 60);
      attempted = true;
      await held.confirm();
      return "committed";
    });
    const failure = await failureOf(lost);

    expect(attempted).toBe(true);
    expect(failure.code).toBe("SUBSCRIPTION_LOCK_LOST");
    expect(failure.options.retryable).toBe(true);
    // The release left the other holder's lock alone.
    expect(redis.value(LOCK)).toBe("another-holder");
    expect(logs).toEqual([
      {
        level: "warn",
        line: { eventId: "evt_lost", providerSubscriptionId: SUBSCRIPTION },
        msg: "billing.sync_lock_lost",
      },
    ]);
  });

  it("[FIX-W30-PLATFORM AC1] takes a lock that its holder stopped renewing (a worker that died) once its 15 s have passed", async () => {
    const { redis, lock } = harness();
    const steps: string[] = [];
    redis.put(LOCK, "dead-worker", STRIPE_SUBSCRIPTION_LOCK_TTL_SECONDS);

    const waiter = lock.run(SUBSCRIPTION, { eventId: "evt_after" }, work(steps, "waiter", 1_000));
    await vi.advanceTimersByTimeAsync(
      STRIPE_SUBSCRIPTION_LOCK_TTL_SECONDS * 1000 - SUBSCRIPTION_LOCK_POLL_MS,
    );
    expect(steps).toEqual([]);
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_LOCK_POLL_MS + 1_000);

    expect(await waiter).toBe("waiter");
    expect(steps).toEqual(["waiter start", "waiter end"]);
    expect(redis.value(LOCK)).toBeUndefined();
  });

  it("releases the lock when the work fails, never releases another holder's lock, and lets a Redis failure of the take fail the event before any work", async () => {
    const { redis, lock } = harness();

    await expect(
      lock.run(SUBSCRIPTION, { eventId: "evt_failing" }, () => Promise.reject(new Error("the write failed"))),
    ).rejects.toThrow("the write failed");
    expect(redis.value(LOCK)).toBeUndefined();

    const taken = await lock.run(SUBSCRIPTION, { eventId: "evt_taken" }, () => {
      redis.put(LOCK, "another-holder", 60);
      return Promise.resolve("done");
    });
    expect(taken).toBe("done");
    expect(redis.value(LOCK)).toBe("another-holder");

    redis.setFailures.push(new Error("Connection is closed."));
    let ran = false;
    await expect(
      lock.run(OTHER_SUBSCRIPTION, { eventId: "evt_down" }, () => {
        ran = true;
        return Promise.resolve("never");
      }),
    ).rejects.toThrow("Connection is closed.");
    expect(ran).toBe(false);
  });

  it("[FIX-W30-PLATFORM AC1] logs a renewal that Redis fails and renews the lock at the next one, before its TTL ends", async () => {
    const { redis, lock, logs } = harness();
    const steps: string[] = [];
    // The renewal at 5 s meets a Redis error.
    redis.evalFailures.push(new Error("Connection is closed."));

    const holder = lock.run(SUBSCRIPTION, { eventId: "evt_flaky" }, work(steps, "holder", 20_000));
    await vi.advanceTimersByTimeAsync(STRIPE_SUBSCRIPTION_LOCK_TTL_SECONDS * 1000 + 2_000);

    // Past the 15 s the lock had from its take, it is still the holder's: the renewal at 10 s renewed it.
    expect(redis.value(LOCK)).toBeDefined();
    expect(logs).toEqual([
      {
        level: "warn",
        line: { eventId: "evt_flaky", providerSubscriptionId: SUBSCRIPTION, err: expect.any(Error) },
        msg: "billing.sync_lock_renew_failed",
      },
    ]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await holder).toBe("holder");
    expect(redis.renewals).toEqual([
      { at: 10_000, renewed: true },
      { at: 15_000, renewed: true },
    ]);
    expect(redis.value(LOCK)).toBeUndefined();
  });

  it("[FIX-W30-PLATFORM AC1] stops renewing a lock a renewal found another holder's, and confirm() then fails with SUBSCRIPTION_LOCK_LOST", async () => {
    const { redis, lock, logs } = harness();
    let committed = false;

    const overtaken = lock.run(SUBSCRIPTION, { eventId: "evt_overtaken" }, async (held) => {
      await new Promise((resolveWork) => setTimeout(resolveWork, 12_000));
      await held.confirm();
      committed = true;
      return "committed";
    });
    const refused = failureOf(overtaken);
    await vi.advanceTimersByTimeAsync(1_000);
    // The lock expired while Redis was unreachable and another event took it with its own token.
    redis.put(LOCK, "another-holder", 60);
    await vi.advanceTimersByTimeAsync(11_000);

    const failure = await refused;
    expect(failure.code).toBe("SUBSCRIPTION_LOCK_LOST");
    expect(committed).toBe(false);
    // The renewal at 5 s found the other holder's lock and none ran after it (none at 10 s); confirm() at 12 s found
    // it too. The other holder's lock is left alone.
    expect(redis.renewals).toEqual([
      { at: 5_000, renewed: false },
      { at: 12_000, renewed: false },
    ]);
    expect(logs.map((log) => log.msg)).toEqual(["billing.sync_lock_lost", "billing.sync_lock_lost"]);
    expect(redis.value(LOCK)).toBe("another-holder");
  });

  it("[FIX-W30-PLATFORM AC1] logs a release that Redis fails and still answers the work's result; the lock then expires on its own", async () => {
    const { redis, lock, logs } = harness();

    const done = await lock.run(SUBSCRIPTION, { eventId: "evt_release" }, () => {
      // The release after this work meets a Redis error.
      redis.evalFailures.push(new Error("Connection is closed."));
      return Promise.resolve("done");
    });

    expect(done).toBe("done");
    expect(logs).toEqual([
      {
        level: "warn",
        line: { eventId: "evt_release", providerSubscriptionId: SUBSCRIPTION, err: expect.any(Error) },
        msg: "billing.sync_lock_release_failed",
      },
    ]);
    expect(redis.value(LOCK)).toBeDefined();
    await vi.advanceTimersByTimeAsync(STRIPE_SUBSCRIPTION_LOCK_TTL_SECONDS * 1000);
    // Nothing renewed it after the work.
    expect(redis.renewals).toEqual([]);
    expect(redis.value(LOCK)).toBeUndefined();
  });
});
