// Start-up of the worker and its health port without PostgreSQL or Redis (the probes connect on the first readiness
// check only; the BullMQ queues, the scheduler registration and the vx:invalidate subscriber try a Redis where nothing
// listens). Readiness with real dependencies: test/integration/health.
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testWorkerVariables } from "../test/helpers/api-env";
import { exchange } from "../test/helpers/http";
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

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

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

  it("serves the health port on 127.0.0.1:HEALTH_PORT and stops it on shutdown", async () => {
    const sink = new MemorySink();
    const port = await freePort();

    const worker = await startWorker({
      env: { ...ENV, REDIS_URL: await unreachableRedisUrl(), HEALTH_PORT: String(port) },
      logDestination: sink,
    });

    expect(worker?.health).toMatchObject({ address: WORKER_HOST, port });
    expect(sink.records()).toContainEqual(
      expect.objectContaining({ app: "ota-worker", msg: "worker.health_listening", port }),
    );
    const live = await exchange(port, "/health/live");
    expect(live.status).toBe(200);
    expect(live.headers["cache-control"]).toBe("no-store");
    expect(live.json()).toEqual({ status: "ok" });

    await worker?.app.close();
    await expect(exchange(port, "/health/live")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("logs worker.start_failed and resolves to undefined when HEALTH_PORT is taken", async () => {
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

    expect(worker).toBeUndefined();
    expect(sink.records()).toContainEqual(
      expect.objectContaining({
        msg: "worker.start_failed",
        err: expect.objectContaining({ code: "EADDRINUSE" }),
      }),
    );
  });
});

describe("the worker's health port", () => {
  it("answers HEAD like GET without a body, ignores query strings", async () => {
    const { port } = await runningWorker();

    const head = await exchange(port, "/health/live", "HEAD");
    const query = await exchange(port, "/health/live?probe=1");

    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(query.json()).toEqual({ status: "ok" });
  });

  it("answers 404 for other paths and 405 for other methods", async () => {
    const { port } = await runningWorker();

    const other = await exchange(port, "/v1/storefront");
    const post = await exchange(port, "/health/ready", "POST");

    expect(other.status).toBe(404);
    expect(other.body).toBe("");
    expect(post.status).toBe(405);
    expect(post.headers["allow"]).toBe("GET, HEAD");
  });

  it("does not log health requests", async () => {
    const sink = new MemorySink();
    const { port } = await runningWorker(sink);
    const before = sink.lines.length;

    await exchange(port, "/health/live");

    expect(sink.lines.slice(before)).toEqual([]);
  });
});

describe("the worker's module graph", () => {
  it("has the provisioner DSN in its ConfigService, never the migrator DSN or process.env [OBE-001 AC3]", async () => {
    vi.stubEnv("DATABASE_MIGRATOR_URL", "postgres://velexis_migrator:dummy@127.0.0.1:5432/velexis");
    const { worker } = await runningWorker();
    const config = worker.app.get(ConfigService);

    expect(config.get("DATABASE_PROVISIONER_URL")).toBe(ENV.DATABASE_PROVISIONER_URL);
    expect(config.get("DATABASE_MIGRATOR_URL")).toBeUndefined();
    expect(config.get("PORT")).toBeUndefined();
  });

  it("provides Clock and IdGenerator", async () => {
    const { worker } = await runningWorker();

    expect(worker.app.get(Clock).now()).toBeInstanceOf(Date);
    expect(worker.app.get(IdGenerator).newId("job")).toMatch(/^job_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("provides the e-mail outbox and the ota-notifications consumer (OBE-030)", async () => {
    const { worker } = await runningWorker();

    expect(worker.app.get(OutboxService, { strict: false })).toBeInstanceOf(OutboxService);
    expect(worker.app.get(NotificationsProcessor, { strict: false })).toBeInstanceOf(NotificationsProcessor);
  });
});
