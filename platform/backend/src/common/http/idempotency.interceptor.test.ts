// The lock of an idempotent request while its handler runs (PBE-009 file header item 3, FIX-W29-PLATFORM; PADR-0002
// revision of 2026-10-24): createTenant and createCheckoutSession wait on Stripe (a 10 s timeout and one retry per
// call), longer than the lock's 10 s TTL, so the request that holds the lock renews it until its answer is stored. A
// concurrent request with the same key then waits and replays the answer, or answers 503 after its own wait; it never
// runs the handler a second time. The renewal uses the holder's token, so a lock that was lost (or taken by another
// request since) is never renewed or released by the request that lost it.
//
// The interceptor runs here over an in-memory Redis whose TTLs follow the (fake) clock, with Vitest's fake timers:
// the handler "takes" 15 or 40 seconds without a real wait, and every step happens at a known instant. The same
// interceptor over the real Redis is in test/integration/common/idempotency.int.test.ts.
import { Controller, Post, type CallHandler } from "@nestjs/common";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { isAppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { defer } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_LOCK_TTL_SECONDS, redisKeys } from "../redis/redis-keys";
import {
  IDEMPOTENCY_LOCK_RENEW_MS,
  IDEMPOTENCY_WAIT_MS,
  IdempotencyInterceptor,
  type IdempotencyRecord,
} from "./idempotency.interceptor";
import { OpenApiOperation, VALIDATED_REQUEST } from "./openapi-operation.decorator";
import { PlatformOpenApi } from "./openapi-validation.interceptor";
import type { RequestContext } from "./request-context";

const ACCOUNT = "acc_01JATESTRW0000000000000029";
const KEY = "fix-w29-platform-lock-0001";
const LOCK = redisKeys.idempotencyLock(ACCOUNT, KEY).key;
const RECORD = redisKeys.idempotency(ACCOUNT, KEY).key;

/** The smallest platform document with one `x-idempotent` operation. */
const DOCUMENT = {
  openapi: "3.1.0",
  paths: { "/v1/tenants": { post: { operationId: "createTenant", "x-idempotent": true } } },
};

@Controller("test-idempotency")
class IdempotentController {
  @Post("tenants")
  @OpenApiOperation("createTenant")
  createTenant(): void {}
}

/**
 * Redis in memory, for the three things the interceptor sends: `GET`, `SET … EX … [NX]` and the lock scripts of
 * redis-keys.ts (renew and release, told apart by their text). A key expires when the fake clock passes its TTL.
 */
class MemoryRedis {
  private readonly entries = new Map<string, { readonly value: string; readonly expiresAt: number }>();
  /** The (fake) clock when the test began: renewals are timed from it. */
  private readonly origin = Date.now();
  /** The renewals asked for: milliseconds since the test began, and whether the lock was renewed. */
  readonly renewals: Array<{ readonly at: number; readonly renewed: boolean }> = [];
  /** Errors the next renewals throw, one each. */
  readonly renewalFailures: Error[] = [];

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

  /** Writes `key` as another holder would (a test's stand-in for a lost lock). */
  put(key: string, value: string, ttlSeconds: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.value(key) ?? null);
  }

  set(key: string, value: string, ex: string, ttlSeconds: number, nx?: string): Promise<"OK" | null> {
    if (ex !== "EX" || (nx !== undefined && nx !== "NX")) {
      throw new Error(`MemoryRedis: unexpected SET options ${ex} ${String(nx)}`);
    }
    if (nx === "NX" && this.value(key) !== undefined) {
      return Promise.resolve(null);
    }
    this.put(key, value, ttlSeconds);
    return Promise.resolve("OK");
  }

  eval(script: string, keys: number, key: string, token: string, ttlSeconds?: string): Promise<number> {
    if (keys !== 1) {
      throw new Error("MemoryRedis: one key per script");
    }
    const held = this.value(key) === token;
    if (script.includes("redis.call('EXPIRE', KEYS[1], ARGV[2])")) {
      const failure = this.renewalFailures.shift();
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
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
    throw new Error("MemoryRedis: a script the interceptor does not send");
  }
}

/** The answer of one request: its status and body, or the AppError code it was refused with. */
interface Outcome {
  readonly status?: number;
  readonly body?: unknown;
  readonly code?: string;
}

interface Harness {
  readonly redis: MemoryRedis;
  readonly warnings: Array<{ readonly line: unknown; readonly msg: unknown }>;
  /** How many times the handler started. */
  readonly runs: () => number;
  /** Sends the createTenant request with KEY; the handler takes `handlerMs` of the fake clock. */
  readonly send: (handlerMs: number) => Promise<Outcome>;
}

function harness(): Harness {
  const redis = new MemoryRedis();
  const warnings: Array<{ line: unknown; msg: unknown }> = [];
  const logger = {
    warn: (line: unknown, msg: unknown) => warnings.push({ line, msg }),
  } as unknown as PinoLogger;
  const context = { actor: { type: "account", accountId: ACCOUNT } } as unknown as RequestContext;
  const interceptor = new IdempotencyInterceptor(
    PlatformOpenApi.fromDocument(DOCUMENT),
    redis as unknown as Redis,
    context,
    logger,
  );
  let runs = 0;
  const send = async (handlerMs: number): Promise<Outcome> => {
    const req = {
      headers: { "idempotency-key": KEY },
      [VALIDATED_REQUEST]: { path: {}, query: {}, header: {}, body: { key: "acme", name: "Acme Travel" } },
    };
    const headers = new Map<string, string>();
    const res = {
      statusCode: 202,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: string) => headers.set(name, value),
    };
    const next: CallHandler = {
      handle: () =>
        defer(async () => {
          runs += 1;
          const run = runs;
          await new Promise((resolveRun) => setTimeout(resolveRun, handlerMs));
          return { run };
        }),
    };
    const execution = new ExecutionContextHost(
      [req, res, () => undefined],
      IdempotentController,
      IdempotentController.prototype.createTenant,
    );
    try {
      const body: unknown = await new Promise((resolveBody, rejectBody) => {
        interceptor.intercept(execution, next).subscribe({ next: resolveBody, error: rejectBody });
      });
      return { status: res.statusCode, body };
    } catch (error) {
      if (isAppError(error)) {
        return { code: error.code };
      }
      throw error;
    }
  };
  return { redis, warnings, runs: () => runs, send };
}

describe("IdempotencyInterceptor: the lock while the handler runs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("[FIX-W29-PLATFORM AC1] keeps the lock of a handler slower than its TTL to the end: a duplicate after the TTL waits and replays the answer, the handler runs once", async () => {
    const { redis, runs, send, warnings } = harness();
    expect(IDEMPOTENCY_LOCK_TTL_SECONDS * 1000).toBeLessThan(15_000);

    const first = send(15_000);
    await vi.advanceTimersByTimeAsync(11_000);
    // Past the lock's 10 s TTL the lock is still there, renewed by its holder.
    expect(redis.value(LOCK)).toBeDefined();
    expect(redis.pttl(LOCK)).toBeGreaterThan(IDEMPOTENCY_LOCK_TTL_SECONDS * 1000 - IDEMPOTENCY_LOCK_RENEW_MS);
    expect(redis.value(RECORD)).toBeUndefined();

    const duplicate = send(15_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const [a, b] = await Promise.all([first, duplicate]);

    expect(runs()).toBe(1);
    expect(a).toEqual({ status: 202, body: { run: 1 } });
    expect(b).toEqual(a);
    expect(JSON.parse(redis.value(RECORD) ?? "null")).toMatchObject({
      status: 202,
      body: { run: 1 },
    } satisfies Partial<IdempotencyRecord>);
    // Renewed every 3 s while the handler ran, then released; nothing renews it after the answer.
    expect(redis.renewals.map((renewal) => renewal.at)).toEqual([3_000, 6_000, 9_000, 12_000]);
    expect(redis.renewals.every((renewal) => renewal.renewed)).toBe(true);
    expect(redis.value(LOCK)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(redis.renewals).toHaveLength(4);
    expect(warnings).toEqual([]);
  });

  it("[FIX-W29-PLATFORM AC1] a duplicate that still finds the lock after its own wait answers 503 without running the handler; a retry after the answer replays it", async () => {
    const { redis, runs, send } = harness();

    const first = send(40_000);
    await vi.advanceTimersByTimeAsync(12_000);
    const duplicate = send(40_000);
    await vi.advanceTimersByTimeAsync(IDEMPOTENCY_WAIT_MS);

    expect(await duplicate).toEqual({ code: "SERVICE_UNAVAILABLE" });
    expect(runs()).toBe(1);
    expect(redis.value(LOCK)).toBeDefined();

    await vi.advanceTimersByTimeAsync(40_000);
    const answer = await first;
    const retry = await send(40_000);

    expect(answer).toEqual({ status: 202, body: { run: 1 } });
    expect(retry).toEqual(answer);
    expect(runs()).toBe(1);
  });

  it("[FIX-W29-PLATFORM AC1] never renews a lock it lost: another holder's lock keeps its own TTL and value, and the loss is logged once", async () => {
    const { redis, runs, send, warnings } = harness();

    const first = send(20_000);
    await vi.advanceTimersByTimeAsync(4_000);
    // The lock was lost (it expired while Redis was unreachable) and another request took it with its own token; that
    // holder keeps renewing it, so it is still there when the first request ends (30 s stands in for its renewals).
    const otherTtlSeconds = 30;
    redis.put(LOCK, "another-holder", otherTtlSeconds);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(redis.renewals.map((renewal) => [renewal.at, renewal.renewed])).toEqual([
      [3_000, true],
      [6_000, false],
    ]);
    expect(redis.value(LOCK)).toBe("another-holder");
    expect(redis.pttl(LOCK)).toBe(otherTtlSeconds * 1000 - 3_000);
    expect(warnings).toEqual([{ line: { operationId: "createTenant" }, msg: "idempotency.lock_lost" }]);

    await vi.advanceTimersByTimeAsync(14_000);
    expect(await first).toEqual({ status: 202, body: { run: 1 } });
    // No renewal after the loss, and the release did not touch the other holder's lock: same value, same TTL.
    expect(redis.renewals).toHaveLength(2);
    expect(redis.value(LOCK)).toBe("another-holder");
    expect(redis.pttl(LOCK)).toBe(otherTtlSeconds * 1000 - 17_000);
    expect(runs()).toBe(1);
  });

  it("[FIX-W29-PLATFORM AC1] logs a renewal that Redis refused and renews again at the next tick, so the lock survives", async () => {
    const { redis, send, warnings } = harness();
    redis.renewalFailures.push(new Error("Connection is closed."));

    const first = send(12_000);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(await first).toEqual({ status: 202, body: { run: 1 } });
    // The failed renewal at 3 s is not recorded; the next ones at 6 and 9 s kept the lock.
    expect(redis.renewals.map((renewal) => [renewal.at, renewal.renewed])).toEqual([
      [6_000, true],
      [9_000, true],
    ]);
    expect(warnings).toEqual([
      {
        line: { err: expect.any(Error), operationId: "createTenant" },
        msg: "idempotency.lock_renew_failed",
      },
    ]);
  });
});
