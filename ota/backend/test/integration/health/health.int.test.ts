// /health/live and /health/ready of both processes against the real PostgreSQL 16 and Redis 7 (ADR-0016), on the
// ports of the systemd units: the API on 127.0.0.1:4000 (PORT default) and the worker on 127.0.0.1:4001 (HEALTH_PORT
// default). The files of this suite run one after the other (vitest.int.config.ts), so the two ports are free. The
// worker's readiness also reports its BullMQ queues (OBE-025, src/health/queue-age.ts): the last part of the file runs
// it on a Redis database of its own (`useRedis`), with jobs the test adds and fails through BullMQ itself.
import type { NestExpressApplication } from "@nestjs/platform-express";
import { FakeClock, responseChecker, useRedis, type ResponseChecker, type TestRedis } from "@velexis/testing";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BULLMQ_PREFIX, OTA_QUEUE, OTA_QUEUES } from "../../../src/common/queues/queue-names";
import { createQueueAgeReport, FAILED_WINDOW_MS } from "../../../src/health/queue-age";
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

let checker: ResponseChecker;

// The OTA document's response schemas, compiled once for the file (a few seconds on a loaded runner).
beforeAll(() => {
  checker = responseChecker("ota");
}, 60_000);

describe("GET /health/ready", () => {
  it("answers 200 on 4000 (API) and 4001 (worker) with PostgreSQL and Redis up [OBE-001 AC2]", async () => {
    const { worker } = await startBoth();
    expect(worker.health.port).toBe(WORKER_HEALTH_PORT);

    await expect(get(API_PORT, "/health/ready")).resolves.toEqual({
      status: 200,
      cache: "no-store",
      body: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
    });
    // The worker's answer adds its queues (OBE-025): every OTA queue, whatever jobs this shared database holds.
    const ready = await get(WORKER_HEALTH_PORT, "/health/ready");
    expect(ready).toEqual({
      status: 200,
      cache: "no-store",
      body: { status: "ok", checks: { postgres: "ok", redis: "ok" }, queues: expect.any(Object) },
    });
    expect(Object.keys((ready.body as { queues: object }).queues)).toEqual([...OTA_QUEUES]);
    expect(checker.check("healthReady", ready)).toEqual([]);
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
    // The worker's queues are unknown, so its answer above has none (OBE-025).
    expect(sink.records().filter((line) => line["msg"] === "health.queues_unknown")).toEqual([
      expect.objectContaining({ app: "ota-worker", part: "queues", status: "down" }),
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

describe("the worker's queues in /health/ready (OBE-025)", () => {
  let redis: TestRedis;
  /** BullMQ connections the tests open on the file's database, closed after each test. */
  const connections: Redis[] = [];

  beforeAll(async () => {
    redis = await useRedis();
  });

  afterAll(async () => {
    await redis.close();
  });

  afterEach(async () => {
    for (const connection of connections.splice(0)) {
      await connection.quit().catch(() => undefined);
    }
  });

  /** A BullMQ connection on the file's database (a worker's needs `maxRetriesPerRequest: null`). */
  function bullmqConnection(): Redis {
    const connection = new Redis(redis.url, { maxRetriesPerRequest: null });
    connections.push(connection);
    return connection;
  }

  /** Adds `count` jobs to `queue` and lets a worker of the test fail each of them for good; resolves when all failed. */
  async function failJobs(name: string, count: number): Promise<void> {
    const queue = new Queue(name, { connection: bullmqConnection(), prefix: BULLMQ_PREFIX });
    const worker = new Worker(name, () => Promise.reject(new UnrecoverableError("the test fails this job")), {
      connection: bullmqConnection(),
      prefix: BULLMQ_PREFIX,
      autorun: false,
    });
    let failed = 0;
    const done = new Promise<void>((resolveDone) => {
      worker.on("failed", () => {
        failed += 1;
        if (failed === count) {
          resolveDone();
        }
      });
    });
    try {
      for (let index = 0; index < count; index += 1) {
        await queue.add("test.fail", { index });
      }
      void worker.run();
      await done;
    } finally {
      await worker.close();
      await queue.close();
    }
  }

  it("[OBE-025 AC1] reports oldestWaitingSeconds ≥ 120 for a job that has waited 2 minutes, and the job that failed, with 200", async () => {
    // Before the worker starts: one ota-documents job failed for good, then the queue is paused, so that the job
    // added afterwards with a BullMQ timestamp 2 minutes old waits there (the worker's consumer takes nothing from a
    // paused queue).
    await failJobs(OTA_QUEUE.documents, 1);
    const documents = new Queue(OTA_QUEUE.documents, {
      connection: bullmqConnection(),
      prefix: BULLMQ_PREFIX,
    });
    try {
      await documents.pause();
      await documents.add("document.render", { test: true }, { timestamp: Date.now() - 2 * 60_000 });

      const sink = new MemorySink();
      useNextApplicationLoggerOutsideRequests();
      const worker = await startWorker({
        env: { ...services.worker, REDIS_URL: redis.url },
        logDestination: sink,
      });
      if (worker === undefined) {
        throw new Error(`the worker did not start:\n${sink.text()}`);
      }
      cleanups.push(() => worker.app.close());

      const ready = await get(WORKER_HEALTH_PORT, "/health/ready");

      expect(ready).toMatchObject({
        status: 200,
        body: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
      });
      expect(checker.check("healthReady", ready)).toEqual([]);
      const queues = (ready.body as { queues: Record<string, { oldestWaitingSeconds: number | null }> })
        .queues;
      expect(Object.keys(queues)).toEqual([...OTA_QUEUES]);
      expect(queues[OTA_QUEUE.documents]).toEqual({
        waiting: 1,
        oldestWaitingSeconds: expect.any(Number),
        failedLastHour: 1,
      });
      expect(queues[OTA_QUEUE.documents]?.oldestWaitingSeconds).toBeGreaterThanOrEqual(120);
      expect(sink.text()).not.toContain("health.queues_unknown");
    } finally {
      await documents.close();
    }
  });

  it("counts a delayed job and a retry in its backoff as waiting once they are due, from BullMQ's own fields (FakeClock)", async () => {
    // No worker consumes this database now, as on a VM where every worker of the queue is busy or stuck: BullMQ keeps
    // a due job in the delayed set until a worker asks for its next job.
    const payments = new Queue(OTA_QUEUE.payments, { connection: bullmqConnection(), prefix: BULLMQ_PREFIX });
    const bookings = new Queue(OTA_QUEUE.bookings, { connection: bullmqConnection(), prefix: BULLMQ_PREFIX });
    const clock = new FakeClock();
    const report = createQueueAgeReport(redis.url, { connectionName: "ota-test-health-queues", clock });
    const retrying = new Worker(
      OTA_QUEUE.bookings,
      () => Promise.reject(new Error("the test fails this attempt")),
      { connection: bullmqConnection(), prefix: BULLMQ_PREFIX, autorun: false },
    );
    try {
      const delayed = await payments.add("test.delayed", { test: true }, { delay: 60_000 });
      // A job whose first attempt fails: BullMQ puts it in the delayed set for its 2-minute backoff.
      const attempted = new Promise<void>((resolveAttempt) =>
        retrying.once("failed", () => resolveAttempt()),
      );
      const retry = await bookings.add(
        "test.retry",
        { test: true },
        { attempts: 2, backoff: { type: "fixed", delay: 120_000 } },
      );
      void retrying.run();
      await attempted;
      await retrying.close();
      const tried = await bookings.getJob(retry.id ?? "");
      expect([await bookings.getJobState(retry.id ?? ""), tried?.delay]).toEqual(["delayed", 120_000]);
      const triedAt = tried?.processedOn ?? Number.NaN;

      // Before either is due: nothing waits.
      clock.set(Math.min(delayed.timestamp + 60_000, triedAt + 120_000) - 1);
      const early = await report.read();
      expect([early[OTA_QUEUE.payments], early[OTA_QUEUE.bookings]]).toEqual([
        { waiting: 0, oldestWaitingSeconds: null, failedLastHour: 0 },
        { waiting: 0, oldestWaitingSeconds: null, failedLastHour: 0 },
      ]);

      // Five minutes after the delayed job was due; three after the retry's backoff ended (counted from the start of
      // the attempt that failed).
      clock.set(delayed.timestamp + 60_000 + 5 * 60_000);
      expect((await report.read())[OTA_QUEUE.payments]).toEqual({
        waiting: 1,
        oldestWaitingSeconds: 5 * 60,
        failedLastHour: 0,
      });
      clock.set(triedAt + 120_000 + 3 * 60_000);
      expect((await report.read())[OTA_QUEUE.bookings]).toEqual({
        waiting: 1,
        oldestWaitingSeconds: 3 * 60,
        failedLastHour: 0,
      });
    } finally {
      await retrying.close();
      await report.close();
      await payments.close();
      await bookings.close();
    }
  });

  it("counts the failures of the last hour on BullMQ's failed set, newest first, whatever the hour's edge (FakeClock)", async () => {
    await failJobs(OTA_QUEUE.notifications, 40);
    const notifications = new Queue(OTA_QUEUE.notifications, {
      connection: bullmqConnection(),
      prefix: BULLMQ_PREFIX,
    });
    const clock = new FakeClock();
    const report = createQueueAgeReport(redis.url, { connectionName: "ota-test-health-queues", clock });
    try {
      const finished = (await notifications.getFailed(0, -1)).map((job) => job.finishedOn ?? Number.NaN);
      expect(finished).toHaveLength(40);
      const edges = [...new Set(finished)].sort((a, b) => a - b);
      // An hour after the oldest failure, after one in the middle, after the newest one, and later still.
      for (const edge of [edges[0], edges[Math.floor(edges.length / 2)], edges.at(-1)]) {
        for (const offset of [0, 1]) {
          const now = clock.set((edge ?? 0) + FAILED_WINDOW_MS + offset);
          const expected = finished.filter((at) => at >= now.getTime() - FAILED_WINDOW_MS).length;

          const queues = await report.read();

          expect([offset, queues[OTA_QUEUE.notifications]]).toEqual([
            offset,
            { waiting: 0, oldestWaitingSeconds: null, failedLastHour: expected },
          ]);
        }
      }
      clock.set((edges.at(-1) ?? 0) + 2 * FAILED_WINDOW_MS);
      await expect(report.read()).resolves.toMatchObject({
        [OTA_QUEUE.notifications]: { failedLastHour: 0 },
      });
    } finally {
      await report.close();
      await notifications.close();
    }
  });
});
