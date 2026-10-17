// API key usage (OBE-013; OADR-0009 point 6): the recorder's once-a-minute writes of `apikey:used:<keyId>` with a
// controlled clock and a recording Redis client, and the interceptor that calls it after successful key requests.
// Against Redis and the API's pipeline: test/integration/common/guards.int.test.ts.
import { EventEmitter } from "node:events";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { PinoLogger } from "nestjs-pino";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../common/clock";
import { newId } from "../common/ids";
import type { Caller, CallerContext } from "./caller-resolver";
import {
  KEY_USAGE_INTERVAL_MS,
  KeyUsageInterceptor,
  KeyUsageRecorder,
  MAX_TRACKED_KEYS,
  type KeyUsageRedis,
} from "./key-usage";

const START = Date.parse("2026-10-17T09:00:00.000Z");

/** A recorder over a clock the test moves and a client that records `SET` calls (or fails them). */
function recorder() {
  let now = START;
  const writes: unknown[][] = [];
  let failing = false;
  const redis = {
    status: "ready",
    set: vi.fn((...args: unknown[]) => {
      if (failing) {
        return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
      }
      writes.push(args);
      return Promise.resolve("OK");
    }),
  } as unknown as KeyUsageRedis;
  const warnings: unknown[] = [];
  const logger = {
    setContext: () => undefined,
    warn: (object: unknown, message: string) => warnings.push([message, object]),
  } as unknown as PinoLogger;
  const clock = { now: () => new Date(now) } as Clock;
  return {
    usage: new KeyUsageRecorder(redis, clock, logger),
    writes,
    warnings,
    advance: (ms: number) => {
      now += ms;
    },
    fail: (value: boolean) => {
      failing = value;
    },
    setStatus: (status: string) => {
      (redis as { status: string }).status = status;
    },
  };
}

describe("KeyUsageRecorder", () => {
  it("writes apikey:used:<keyId> once for ten uses within a minute, as {at, ip} for a day [OBE-013 AC3]", async () => {
    const { usage, writes, advance } = recorder();
    const keyId = newId("key");

    const results: boolean[] = [];
    for (let use = 0; use < 10; use += 1) {
      results.push(await usage.record(keyId, "203.0.113.7"));
      advance(5_000);
    }

    expect(results).toEqual([true, false, false, false, false, false, false, false, false, false]);
    expect(writes).toEqual([
      [
        `apikey:used:${keyId}`,
        JSON.stringify({ at: "2026-10-17T09:00:00.000Z", ip: "203.0.113.7" }),
        "EX",
        86_400,
      ],
    ]);
  });

  it("writes again once the minute is over, and keeps keys apart", async () => {
    const { usage, writes, advance } = recorder();
    const first = newId("key");
    const second = newId("key");

    await usage.record(first, "203.0.113.7");
    await usage.record(second, "198.51.100.23");
    advance(KEY_USAGE_INTERVAL_MS - 1);
    await usage.record(first, "203.0.113.7");
    advance(1);
    await usage.record(first, "203.0.113.8");

    expect(writes.map(([key, value]) => [key, JSON.parse(String(value))])).toEqual([
      [`apikey:used:${first}`, { at: "2026-10-17T09:00:00.000Z", ip: "203.0.113.7" }],
      [`apikey:used:${second}`, { at: "2026-10-17T09:00:00.000Z", ip: "198.51.100.23" }],
      [`apikey:used:${first}`, { at: "2026-10-17T09:01:00.000Z", ip: "203.0.113.8" }],
    ]);
  });

  it("counts a clock that went back as a new minute", async () => {
    const { usage, writes, advance } = recorder();
    const keyId = newId("key");

    await usage.record(keyId, "203.0.113.7");
    advance(-1_000);

    expect(await usage.record(keyId, "203.0.113.7")).toBe(true);
    expect(writes).toHaveLength(2);
  });

  it("logs a failed write with the key id and retries it with the key's next use", async () => {
    const { usage, writes, warnings, fail } = recorder();
    const keyId = newId("key");

    fail(true);
    expect(await usage.record(keyId, "203.0.113.7")).toBe(false);
    fail(false);
    expect(await usage.record(keyId, "203.0.113.7")).toBe(true);

    expect(writes).toHaveLength(1);
    expect(warnings).toEqual([["key_usage.write_failed", expect.objectContaining({ keyId })]]);
  });

  it("never rejects, also for a key id that cannot be a Redis key part, and warns about it once a minute", async () => {
    // The platform's ids are key_ + ULID, but platform.api_keys only checks the prefix: a rejection here would be
    // unhandled (the interceptor does not wait for the write) and stop the process.
    const { usage, writes, warnings, advance } = recorder();

    const results = [
      await usage.record("key_not-a-ulid", "203.0.113.7"),
      await usage.record("key_not-a-ulid", "203.0.113.7"),
    ];
    advance(KEY_USAGE_INTERVAL_MS);
    results.push(await usage.record("key_not-a-ulid", "203.0.113.7"));

    expect(results).toEqual([false, false, false]);
    expect(writes).toEqual([]);
    expect(warnings).toEqual([
      ["key_usage.key_id_invalid", expect.objectContaining({ keyId: "key_not-a-ulid" })],
      ["key_usage.key_id_invalid", expect.objectContaining({ keyId: "key_not-a-ulid" })],
    ]);
  });

  it("sends and logs nothing while Redis reconnects, and writes with the key's first use after the outage", async () => {
    const { usage, writes, warnings, setStatus } = recorder();
    const keyId = newId("key");

    setStatus("reconnecting");
    expect(await usage.record(keyId, "203.0.113.7")).toBe(false);
    setStatus("ready");
    expect(await usage.record(keyId, "203.0.113.7")).toBe(true);

    expect(writes).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("keeps the keys written within the minute when it tracks too many, dropping older ones", async () => {
    const { usage, writes, advance } = recorder();
    const old = newId("key");
    await usage.record(old, "203.0.113.7");
    advance(KEY_USAGE_INTERVAL_MS);
    for (let index = 1; index < MAX_TRACKED_KEYS; index += 1) {
      await usage.record(`key_${String(index).padStart(26, "0")}`, "203.0.113.7");
    }
    const recent = `key_${String(1).padStart(26, "0")}`;

    // The table is full: the next new key drops the old entry, not the recent ones.
    await usage.record(newId("key"), "203.0.113.7");
    const before = writes.length;
    await usage.record(recent, "203.0.113.7");

    expect(writes).toHaveLength(before);
  });
});

describe("KeyUsageInterceptor", () => {
  const keyId = newId("key");
  const KEY: Caller = {
    type: "key",
    id: keyId,
    keyId,
    kind: "secret",
    tenantId: newId("ten"),
    environment: "test",
    scopes: [],
  };

  function intercept(caller: Caller | undefined, statusCode: number) {
    const record = vi.fn(() => Promise.resolve(true));
    const interceptor = new KeyUsageInterceptor(
      { get: () => caller } as unknown as CallerContext,
      { record } as unknown as KeyUsageRecorder,
    );
    const res = Object.assign(new EventEmitter(), { statusCode });
    const req = { ip: "203.0.113.7", socket: { remoteAddress: "127.0.0.1" }, headers: {} };
    const context = {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    const handled = vi.fn(() => of({ ok: true }));
    interceptor.intercept(context, { handle: handled } as CallHandler);
    return { record, res, handled };
  }

  it("records the key and the address the request came from once the response has gone with a status below 400", () => {
    for (const status of [200, 201, 204, 302]) {
      const { record, res, handled } = intercept(KEY, status);
      expect(record).not.toHaveBeenCalled();
      res.emit("finish");
      expect([status, record.mock.calls]).toEqual([status, [[keyId, "203.0.113.7"]]]);
      expect(handled).toHaveBeenCalledOnce();
    }
  });

  it("records nothing for a failed key request or another caller [OBE-013 AC3]", () => {
    for (const [caller, status] of [
      [KEY, 400],
      [KEY, 404],
      [KEY, 500],
      [{ type: "edge", id: "edge", host: "demo.ota.example.com" }, 200],
      [{ type: "anonymous", id: "anonymous" }, 200],
      [undefined, 200],
    ] as const) {
      const { record, res, handled } = intercept(caller, status);
      res.emit("finish");
      expect(record).not.toHaveBeenCalled();
      expect(handled).toHaveBeenCalledOnce();
    }
  });
});
