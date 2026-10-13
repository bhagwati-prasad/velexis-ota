import type { PinoLogger } from "nestjs-pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeRedis, type FakeRedis } from "../../test/helpers/fake-redis";
import { freePort } from "../../test/helpers/ports";
import {
  createPostgresProbe,
  createRedisProbe,
  HealthService,
  READINESS_TIMEOUT_MS,
  type DependencyName,
  type DependencyProbe,
  type ProbeLogger,
} from "./health.service";

interface FakeProbe extends DependencyProbe {
  readonly closed: () => number;
}

function probe(name: DependencyName, check: () => Promise<void>): FakeProbe {
  let closes = 0;
  return {
    name,
    check,
    close: () => {
      closes += 1;
      return Promise.resolve();
    },
    closed: () => closes,
  };
}

const up = (): Promise<void> => Promise.resolve();
const refused = (): Promise<void> =>
  Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
const hanging = (): Promise<void> => new Promise<void>(() => undefined);

function serviceWith(...probes: DependencyProbe[]): {
  service: HealthService;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  // Only `warn` is used by the service; the rest of PinoLogger is not needed here.
  const logger = { warn } as unknown as PinoLogger;
  return { service: new HealthService(probes, logger), warn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HealthService", () => {
  it("is live without checking any dependency", () => {
    const check = vi.fn(up);
    const { service } = serviceWith(probe("postgres", check), probe("redis", check));

    expect(service.live()).toEqual({ status: "ok" });
    expect(check).not.toHaveBeenCalled();
  });

  it("is ready when every dependency answers", async () => {
    const { service, warn } = serviceWith(probe("postgres", up), probe("redis", up));

    await expect(service.ready()).resolves.toEqual({
      ready: true,
      body: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("is not ready and names redis when Redis refuses the connection [OBE-001 AC2]", async () => {
    const { service, warn } = serviceWith(probe("postgres", up), probe("redis", refused));

    await expect(service.ready()).resolves.toEqual({
      ready: false,
      body: { status: "unavailable", checks: { postgres: "ok", redis: "down" } },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: "redis", status: "down", err: expect.any(Error) }),
      "health.dependency_unavailable",
    );
  });

  it("checks again on every call: no answer is cached, so a recovered dependency is ok at once", async () => {
    const check = vi.fn<() => Promise<void>>().mockImplementationOnce(refused).mockImplementation(up);
    const { service } = serviceWith(probe("postgres", up), probe("redis", check));

    await expect(service.ready()).resolves.toMatchObject({
      ready: false,
      body: { checks: { redis: "down" } },
    });
    await expect(service.ready()).resolves.toEqual({
      ready: true,
      body: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
    });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("reports a dependency that does not answer within READINESS_TIMEOUT_MS as timeout", async () => {
    vi.useFakeTimers();
    const { service } = serviceWith(probe("postgres", hanging), probe("redis", up));

    const readiness = service.ready();
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    await expect(readiness).resolves.toEqual({
      ready: false,
      body: { status: "unavailable", checks: { postgres: "timeout", redis: "ok" } },
    });
  });

  it("checks the dependencies in parallel, so the answer never takes much longer than one timeout", async () => {
    vi.useFakeTimers();
    const { service } = serviceWith(probe("postgres", hanging), probe("redis", hanging));

    const readiness = service.ready();
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    await expect(readiness).resolves.toMatchObject({
      body: { checks: { postgres: "timeout", redis: "timeout" } },
    });
  });

  it("ignores a rejection that arrives after the timeout", async () => {
    vi.useFakeTimers();
    let reject: (error: Error) => void = () => undefined;
    const late = (): Promise<void> => new Promise<void>((_resolve, rejectLater) => (reject = rejectLater));
    const { service } = serviceWith(probe("postgres", up), probe("redis", late));

    const readiness = service.ready();
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    reject(new Error("late failure"));

    await expect(readiness).resolves.toMatchObject({ body: { checks: { redis: "timeout" } } });
  });

  it("closes every probe at shutdown, even when one fails to close", async () => {
    const postgres = probe("postgres", up);
    const failing: DependencyProbe = {
      name: "redis",
      check: up,
      close: () => Promise.reject(new Error("boom")),
    };
    const { service } = serviceWith(postgres, failing);

    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
    expect(postgres.closed()).toBe(1);
  });
});

function probeLogger(): {
  logger: ProbeLogger;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const error = vi.fn();
  return { logger: { warn, error } as unknown as ProbeLogger, warn, error };
}

describe("the probes against a port where nothing listens", () => {
  it("fail the Redis check at once and log the outage once, without the URL", async () => {
    const port = await freePort();
    const { logger, warn } = probeLogger();
    const redis = createRedisProbe(`redis://:dummy-redis-password@127.0.0.1:${port}/0`, {
      connectionName: "ota-test-health",
      logger,
    });

    try {
      await expect(redis.check()).rejects.toThrow();
      await expect(redis.check()).rejects.toThrow();
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        { dependency: "redis", err: expect.objectContaining({ code: "ECONNREFUSED" }) },
        "health.redis.connection_error",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("dummy-redis-password");
    } finally {
      await redis.close();
    }
  });

  it("fail the PostgreSQL check", async () => {
    const port = await freePort();
    const { logger } = probeLogger();
    const postgres = createPostgresProbe(`postgres://velexis_ota_app:dummy@127.0.0.1:${port}/velexis`, {
      connectionName: "ota-test-health",
      logger,
    });

    try {
      await expect(postgres.check()).rejects.toThrow();
    } finally {
      await postgres.close();
      // Closing twice is harmless (Nest may call the shutdown hooks of a failed start-up again).
      await postgres.close();
    }
  });
});

describe("the Redis probe across an outage", () => {
  it("answers again once Redis is back, without a restart, and logs each outage once", async () => {
    const port = await freePort();
    const { logger, warn } = probeLogger();
    const redis = createRedisProbe(`redis://127.0.0.1:${port}/0`, {
      connectionName: "ota-test-health",
      logger,
    });
    let server: FakeRedis | undefined;

    try {
      // Down at start-up: the first check fails and the client keeps reconnecting in the background.
      await expect(redis.check()).rejects.toThrow();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

      server = await fakeRedis(port);
      await vi.waitFor(() => redis.check(), { timeout: 5_000, interval: 50 });
      expect(server.commands()).toContain("PING");

      // A second outage after the recovery is logged again, once.
      await server.close();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2), { timeout: 5_000, interval: 50 });
      await expect(redis.check()).rejects.toThrow();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      await redis.close();
      await server?.close();
    }
  });
});
