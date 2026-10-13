// /health/live and /health/ready of both processes against the real PostgreSQL 16 and Redis 7 (ADR-0016), on the
// ports of the systemd units: the API on 127.0.0.1:4000 (PORT default) and the worker on 127.0.0.1:4001 (HEALTH_PORT
// default). The files of this suite run one after the other (vitest.int.config.ts), so the two ports are free.
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterEach, describe, expect, it } from "vitest";
import { startApi } from "../../../src/main";
import { startWorker, type RunningWorker } from "../../../src/worker";
import { exchange } from "../../helpers/http";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { freePort } from "../../helpers/ports";
import { integrationEnv } from "../env";

const API_PORT = 4000;
const WORKER_HEALTH_PORT = 4001;
const services = integrationEnv();

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Processes {
  readonly api: NestExpressApplication;
  readonly worker: RunningWorker;
  readonly sink: MemorySink;
}

/** Starts the API and the worker on their default ports with `overrides` applied to both environments. */
async function startBoth(overrides: Record<string, string> = {}): Promise<Processes> {
  const sink = new MemorySink();
  useNextApplicationLoggerOutsideRequests();
  const api = await startApi({ env: { ...services.api, ...overrides }, logDestination: sink });
  if (api !== undefined) {
    cleanups.push(() => api.close());
  }
  // The worker checks its dependencies outside any request: its lines go to its own logger.
  useNextApplicationLoggerOutsideRequests();
  const worker = await startWorker({ env: { ...services.worker, ...overrides }, logDestination: sink });
  if (worker !== undefined) {
    cleanups.push(() => worker.app.close());
  }
  if (api === undefined || worker === undefined) {
    throw new Error(`a process did not start:\n${sink.text()}`);
  }
  return { api, worker, sink };
}

async function get(port: number, path: string): Promise<{ status: number; cache: unknown; body: unknown }> {
  const response = await exchange(port, path);
  return { status: response.status, cache: response.headers["cache-control"], body: response.json() };
}

describe("GET /health/ready", () => {
  it("answers 200 on 4000 (API) and 4001 (worker) with PostgreSQL and Redis up [OBE-001 AC2]", async () => {
    const { worker } = await startBoth();
    expect(worker.health.port).toBe(WORKER_HEALTH_PORT);

    for (const port of [API_PORT, WORKER_HEALTH_PORT]) {
      await expect(get(port, "/health/ready")).resolves.toEqual({
        status: 200,
        cache: "no-store",
        body: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
      });
    }
  });

  it("answers 503 naming redis on 4000 and 4001 when Redis is unreachable [OBE-001 AC2]", async () => {
    const { sink } = await startBoth({
      REDIS_URL: `redis://:dummy-redis-password@127.0.0.1:${await freePort()}/0`,
    });

    for (const port of [API_PORT, WORKER_HEALTH_PORT]) {
      await expect(get(port, "/health/ready")).resolves.toEqual({
        status: 503,
        cache: "no-store",
        body: { status: "unavailable", checks: { postgres: "ok", redis: "down" } },
      });
    }
    const unavailable = sink.records().filter((line) => line["msg"] === "health.dependency_unavailable");
    expect(unavailable).toEqual([
      expect.objectContaining({ app: "ota-api", dependency: "redis", status: "down" }),
      expect.objectContaining({ app: "ota-worker", dependency: "redis", status: "down" }),
    ]);
    expect(sink.text()).not.toContain("dummy-redis-password");
  });

  it("answers 503 naming postgres on 4000 and 4001 when PostgreSQL is unreachable", async () => {
    await startBoth({
      DATABASE_URL: `postgres://velexis_ota_app:dummy@127.0.0.1:${await freePort()}/velexis`,
    });

    for (const port of [API_PORT, WORKER_HEALTH_PORT]) {
      await expect(get(port, "/health/ready")).resolves.toMatchObject({
        status: 503,
        body: { status: "unavailable", checks: { postgres: "down", redis: "ok" } },
      });
    }
  });

  it("answers concurrent first checks of a new process with 200: they share one Redis connection attempt", async () => {
    await startBoth();

    // No check has run yet: all three open the probes' connections at the same time.
    const answers = await Promise.all([1, 2, 3].map(() => get(API_PORT, "/health/ready")));

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
  });
});

describe("GET /health/live", () => {
  it("answers 200 on 4000 and 4001 even while the dependencies are unreachable", async () => {
    const closed = await freePort();
    await startBoth({
      DATABASE_URL: `postgres://velexis_ota_app:dummy@127.0.0.1:${closed}/velexis`,
      REDIS_URL: `redis://127.0.0.1:${closed}/0`,
    });

    for (const port of [API_PORT, WORKER_HEALTH_PORT]) {
      await expect(get(port, "/health/live")).resolves.toEqual({
        status: 200,
        cache: "no-store",
        body: { status: "ok" },
      });
    }
  });
});
