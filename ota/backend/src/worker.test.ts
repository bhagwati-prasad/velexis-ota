// Start-up of the worker and its health port without PostgreSQL or Redis (the probes connect on the first readiness
// check only; the BullMQ queues, the scheduler registration and the vx:invalidate subscriber try a Redis where nothing
// listens). Readiness with real dependencies: test/integration/health.
//
// The workers start (and the one whose shutdown is checked stops) in setup hooks, never in a test's 5 s bound (the
// lead's test timing rule; FIX-W28-FOLLOWUPS): a test that counts its worker's log lines gets a worker of its own
// (a beforeEach hook), the module graph's reads share one, and the tests assert on what the hooks recorded. The workers
// still running are closed together after the file: each close waits up to BULLMQ_STARTUP_SETTLE_MS (1 s) for the
// queues and workers that cannot reach their Redis, which took about 1 s of every test while each test closed its own.
// A refused configuration starts nothing and stays in its test.
import { ConfigService } from "@nestjs/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testWorkerVariables } from "../test/helpers/api-env";
import { exchange, type Exchange } from "../test/helpers/http";
import { MemorySink } from "../test/helpers/log-sink";
import { freePort, occupiedPort, unreachableRedisUrl } from "../test/helpers/ports";
import { Clock } from "./common/clock";
import { IdGenerator } from "./common/ids";
import { NotificationsProcessor } from "./notifications/notifications.processor";
import { OutboxService } from "./notifications/outbox.service";
import { startWorker, WORKER_HOST, type RunningWorker } from "./worker";

/**
 * Dummy values; nothing connects to them in these tests. A worker that starts gets `unreachableRedisUrl()` instead of
 * this REDIS_URL: at start-up it registers its job schedulers and connects its vx:invalidate subscriber (OBE-024),
 * which must not reach a Redis without a password (CI's) and leave a scheduler there.
 */
const ENV = {
  APP_ENV: "test",
  DATABASE_URL: "postgres://velexis_ota_app:dummy@127.0.0.1:5432/velexis",
  REDIS_URL: "redis://:dummy@127.0.0.1:6379/0",
  DATABASE_PROVISIONER_URL: "postgres://velexis_provisioner:dummy@127.0.0.1:5432/velexis",
  // The key folder, base domain and e-mail settings of the notifications module (OBE-030); nothing is sent here.
  ...testWorkerVariables(),
} as const;

/**
 * The budget of a hook that starts a worker (and, for the shutdown test, stops it): the worker's module graph, about
 * 0.1 s alone and a few seconds while every package's tests run at once on a 4-CPU runner, and a close of up to 1 s
 * for its queues. The budget only stops a start or a close that hangs.
 */
const WORKER_START_TIMEOUT_MS = 30_000;

/** The budget of the hook that closes the workers still running, all at once (up to 1 s each, together). */
const WORKER_CLOSE_TIMEOUT_MS = 30_000;

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
}, WORKER_CLOSE_TIMEOUT_MS);

/** A worker a setup hook started, with its sink. */
interface StartedWorker {
  readonly worker: RunningWorker;
  readonly port: number;
  readonly sink: MemorySink;
}

/** The worker a setup hook started, for the test that reads it. */
function started(current: StartedWorker | undefined): StartedWorker {
  if (current === undefined) {
    throw new Error("the setup hook started no worker");
  }
  return current;
}

/**
 * Gives each test of the current block a worker of its own, started in its beforeEach hook (after `prepare`, which may
 * stub the environment: Vitest unstubs it before each test's hooks).
 */
function workerPerTest(prepare?: () => void): () => StartedWorker {
  let current: StartedWorker | undefined;
  beforeEach(async () => {
    current = undefined;
    prepare?.();
    const sink = new MemorySink();
    current = { ...(await runningWorker(sink)), sink };
  }, WORKER_START_TIMEOUT_MS);
  return () => started(current);
}

/** Gives the tests of the current block one worker, started in its beforeAll hook. */
function workerForBlock(): () => StartedWorker {
  let current: StartedWorker | undefined;
  beforeAll(async () => {
    const sink = new MemorySink();
    current = { ...(await runningWorker(sink)), sink };
  }, WORKER_START_TIMEOUT_MS);
  return () => started(current);
}

/** Starts a worker on a free health port (closed after the file); only the setup hooks call it. */
async function runningWorker(sink = new MemorySink()): Promise<{ worker: RunningWorker; port: number }> {
  const port = await freePort();
  const worker = await startWorker({
    env: { ...ENV, REDIS_URL: await unreachableRedisUrl(), HEALTH_PORT: String(port) },
    logDestination: sink,
  });
  if (worker === undefined) {
    throw new Error(`the worker did not start:\n${sink.text()}`);
  }
  cleanups.push(() => worker.app.close());
  return { worker, port };
}

describe("startWorker", () => {
  it("does not start without DATABASE_URL and logs a ConfigError naming it [OBE-001 AC3]", async () => {
    const sink = new MemorySink();
    const { DATABASE_URL: _omitted, ...withoutUrl } = ENV;

    const worker = await startWorker({ env: withoutUrl, logDestination: sink });

    expect(worker).toBeUndefined();
    expect(sink.records()).toEqual([
      expect.objectContaining({
        level: 60,
        app: "ota-worker",
        msg: "worker.config_invalid",
        err: expect.objectContaining({
          type: "ConfigError",
          message: expect.stringContaining("DATABASE_URL is required but missing"),
        }),
      }),
    ]);
  });

  it("does not start without the provisioner DSN [OBE-001 AC3]", async () => {
    const sink = new MemorySink();
    const { DATABASE_PROVISIONER_URL: _omitted, ...withoutProvisioner } = ENV;

    const worker = await startWorker({ env: withoutProvisioner, logDestination: sink });

    expect(worker).toBeUndefined();
    expect(sink.text()).toContain("DATABASE_PROVISIONER_URL is required but missing");
  });

  describe("on a free HEALTH_PORT", () => {
    /** What the worker did: its start, its answer, its shutdown, and the answer after the shutdown. */
    let served: {
      readonly sink: MemorySink;
      readonly port: number;
      readonly worker: RunningWorker | undefined;
      readonly health: RunningWorker["health"] | undefined;
      readonly live: Exchange | undefined;
      readonly afterShutdown: unknown;
    };

    beforeAll(async () => {
      const sink = new MemorySink();
      const port = await freePort();
      const worker = await startWorker({
        env: { ...ENV, REDIS_URL: await unreachableRedisUrl(), HEALTH_PORT: String(port) },
        logDestination: sink,
      });
      const health = worker?.health;
      const live = worker === undefined ? undefined : await exchange(port, "/health/live");
      await worker?.app.close();
      const afterShutdown = await exchange(port, "/health/live").then(
        () => undefined,
        (error: unknown) => error,
      );
      served = { sink, port, worker, health, live, afterShutdown };
    }, WORKER_START_TIMEOUT_MS);

    it("serves the health port on 127.0.0.1:HEALTH_PORT and stops it on shutdown", () => {
      const { sink, port, worker, health, live, afterShutdown } = served;

      expect(worker).toBeDefined();
      expect(health).toMatchObject({ address: WORKER_HOST, port });
      expect(sink.records()).toContainEqual(
        expect.objectContaining({ app: "ota-worker", msg: "worker.health_listening", port }),
      );
      expect(live?.status).toBe(200);
      expect(live?.headers["cache-control"]).toBe("no-store");
      expect(live?.json()).toEqual({ status: "ok" });

      // The request after the shutdown (the hook closed the worker) was refused: an error, never an answer.
      expect(afterShutdown).toBeInstanceOf(Error);
      expect((afterShutdown as Error).message).toMatch(/ECONNREFUSED/);
    });
  });

  describe("on a HEALTH_PORT that is taken", () => {
    let refused: { readonly sink: MemorySink; readonly worker: RunningWorker | undefined };

    beforeAll(async () => {
      const sink = new MemorySink();
      const taken = await occupiedPort();
      cleanups.push(taken.release);
      const worker = await startWorker({
        env: { ...ENV, REDIS_URL: await unreachableRedisUrl(), HEALTH_PORT: String(taken.port) },
        logDestination: sink,
      });
      if (worker !== undefined) {
        cleanups.push(() => worker.app.close());
      }
      refused = { sink, worker };
    }, WORKER_START_TIMEOUT_MS);

    it("logs worker.start_failed and resolves to undefined when HEALTH_PORT is taken", () => {
      const { sink, worker } = refused;

      expect(worker).toBeUndefined();
      expect(sink.records()).toContainEqual(
        expect.objectContaining({
          msg: "worker.start_failed",
          err: expect.objectContaining({ code: "EADDRINUSE" }),
        }),
      );
    });
  });
});

describe("the worker's health port", () => {
  // Each test has a worker of its own: the last one counts its worker's log lines.
  const current = workerPerTest();

  it("answers HEAD like GET without a body, ignores query strings", async () => {
    const { port } = current();

    const head = await exchange(port, "/health/live", "HEAD");
    const query = await exchange(port, "/health/live?probe=1");

    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(query.json()).toEqual({ status: "ok" });
  });

  it("answers 404 for other paths and 405 for other methods", async () => {
    const { port } = current();

    const other = await exchange(port, "/v1/storefront");
    const post = await exchange(port, "/health/ready", "POST");

    expect(other.status).toBe(404);
    expect(other.body).toBe("");
    expect(post.status).toBe(405);
    expect(post.headers["allow"]).toBe("GET, HEAD");
  });

  it("does not log health requests", async () => {
    const { port, sink } = current();
    const before = sink.lines.length;

    await exchange(port, "/health/live");

    expect(sink.lines.slice(before)).toEqual([]);
  });
});

describe("the worker's module graph", () => {
  describe("with the migrator DSN in process.env", () => {
    // The migrator DSN set in the worker's environment, from its start to the test's reads, stays invisible to it.
    const current = workerPerTest(() => {
      vi.stubEnv("DATABASE_MIGRATOR_URL", "postgres://velexis_migrator:dummy@127.0.0.1:5432/velexis");
    });

    it("has the provisioner DSN in its ConfigService, never the migrator DSN or process.env [OBE-001 AC3]", () => {
      const { worker } = current();
      const config = worker.app.get(ConfigService);
      expect(config.get("DATABASE_PROVISIONER_URL")).toBe(ENV.DATABASE_PROVISIONER_URL);
      expect(config.get("DATABASE_MIGRATOR_URL")).toBeUndefined();
      expect(config.get("PORT")).toBeUndefined();
    });
  });

  // These tests read the module graph only: they share one worker.
  const shared = workerForBlock();

  it("provides Clock and IdGenerator", () => {
    const { worker } = shared();

    expect(worker.app.get(Clock).now()).toBeInstanceOf(Date);
    expect(worker.app.get(IdGenerator).newId("job")).toMatch(/^job_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("provides the e-mail outbox and the ota-notifications consumer (OBE-030)", () => {
    const { worker } = shared();

    expect(worker.app.get(OutboxService, { strict: false })).toBeInstanceOf(OutboxService);
    expect(worker.app.get(NotificationsProcessor, { strict: false })).toBeInstanceOf(NotificationsProcessor);
  });
});
