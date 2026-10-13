import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEALTH_CHECK_TIMEOUT_MS,
  HealthCheckTimeoutError,
  HealthService,
  UnexpectedPingReplyError,
  type PostgresProbeTarget,
  type RedisProbeTarget,
} from "./health.service";

const healthyPostgres = (): PostgresProbeTarget => ({ query: vi.fn(() => Promise.resolve({ rows: [{}] })) });
const healthyRedis = (): RedisProbeTarget => ({ ping: vi.fn(() => Promise.resolve("PONG")) });

afterEach(() => {
  vi.useRealTimers();
});

describe("HealthService", () => {
  it("is live without touching a dependency", () => {
    const postgres = healthyPostgres();
    const redis = healthyRedis();

    expect(new HealthService(postgres, redis).live()).toEqual({ status: "ok" });
    expect(postgres.query).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });

  it("is ready when SELECT 1 and PING succeed", async () => {
    const postgres = healthyPostgres();
    const redis = healthyRedis();

    const readiness = await new HealthService(postgres, redis).ready();

    expect(readiness).toEqual({
      report: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
      failures: [],
    });
    expect(postgres.query).toHaveBeenCalledWith("SELECT 1");
    expect(redis.ping).toHaveBeenCalledOnce();
  });

  it("[PBE-001 AC2] names redis when PING fails, and keeps the cause out of the report", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6390"), { code: "ECONNREFUSED" });

    const readiness = await new HealthService(healthyPostgres(), {
      ping: () => Promise.reject(cause),
    }).ready();

    expect(readiness.report).toEqual({ status: "unavailable", checks: { postgres: "ok", redis: "down" } });
    expect(readiness.failures).toEqual([{ dependency: "redis", error: cause }]);
    expect(JSON.stringify(readiness.report)).not.toContain("ECONNREFUSED");
  });

  it("names postgres when the query fails, also when it throws synchronously", async () => {
    const readiness = await new HealthService(
      {
        query: () => {
          throw new Error("pool ended");
        },
      },
      healthyRedis(),
    ).ready();

    expect(readiness.report).toEqual({ status: "unavailable", checks: { postgres: "down", redis: "ok" } });
    expect(readiness.failures.map((failure) => failure.dependency)).toEqual(["postgres"]);
  });

  it("names both when both fail", async () => {
    const readiness = await new HealthService(
      { query: () => Promise.reject(new Error("down")) },
      { ping: () => Promise.reject(new Error("down")) },
    ).ready();

    expect(readiness.report.checks).toEqual({ postgres: "down", redis: "down" });
    expect(readiness.failures.map((failure) => failure.dependency)).toEqual(["postgres", "redis"]);
  });

  it("counts a PING reply other than PONG as down", async () => {
    const readiness = await new HealthService(healthyPostgres(), {
      ping: () => Promise.resolve("LOADING"),
    }).ready();

    expect(readiness.report.checks.redis).toBe("down");
    expect(readiness.failures[0]?.error).toBeInstanceOf(UnexpectedPingReplyError);
  });

  it("counts a dependency that does not answer within the timeout as down, without waiting longer", async () => {
    vi.useFakeTimers();
    const service = new HealthService({ query: () => new Promise<never>(() => undefined) }, healthyRedis());

    const pending = service.ready();
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS);
    const readiness = await pending;

    expect(readiness.report).toEqual({ status: "unavailable", checks: { postgres: "down", redis: "ok" } });
    expect(readiness.failures[0]?.error).toBeInstanceOf(HealthCheckTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("probes both dependencies in parallel", async () => {
    vi.useFakeTimers();
    const slow = (): Promise<never> => new Promise<never>(() => undefined);
    const pending = new HealthService({ query: slow }, { ping: slow }).ready();

    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS);

    expect((await pending).report.checks).toEqual({ postgres: "down", redis: "down" });
  });
});
