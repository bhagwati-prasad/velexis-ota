// Start-up of the API without PostgreSQL or Redis (the health probes connect on the first readiness check only; the
// vx:invalidate subscriber tries a Redis where nothing listens): configuration failures, the bound interface, and a
// clean shutdown. Readiness with real dependencies: test/integration/health.
//
// An API that builds its application (and so its queues, whose close waits up to BULLMQ_STARTUP_SETTLE_MS, 1 s, for
// the unreachable Redis) starts, answers and stops in a setup hook, never in a test's 5 s bound (the lead's test timing
// rule; FIX-W28-FOLLOWUPS); the tests assert on what the hook recorded. A refused configuration builds no application
// and stays in its test.
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exchange, type Exchange } from "../test/helpers/http";
import { testApiVariables } from "../test/helpers/api-env";
import { MemorySink } from "../test/helpers/log-sink";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../test/helpers/openapi";
import { freePort, occupiedPort, unreachableRedisUrl } from "../test/helpers/ports";
import { API_HOST, startApi } from "./main";

/**
 * Dummy values; nothing connects to them in these tests. An API that starts gets `unreachableRedisUrl()` instead of
 * this REDIS_URL, for the subscriber it connects at start-up (OBE-012).
 */
const ENV = {
  APP_ENV: "test",
  DATABASE_URL: "postgres://velexis_ota_app:dummy@127.0.0.1:5432/velexis",
  REDIS_URL: "redis://:dummy@127.0.0.1:6379/0",
  ...testApiVariables(),
} as const;

/**
 * The budget of the hook that starts the APIs, makes their requests and closes them: two start-ups on the preloaded
 * document (about 0.1 s each alone, a few seconds while every package's tests run at once on a 4-CPU runner) and their
 * closes (up to 1 s each for the queues). The budget only stops a start or a close that hangs.
 */
const START_TIMEOUT_MS = 60_000;

const cleanups: Array<() => Promise<void>> = [];

// The applications the hooks start reuse the OTA document, parsed and compiled once, here (test/helpers/openapi.ts).
beforeAll(preloadOpenApiDocument, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
}, START_TIMEOUT_MS);

function closeLater(app: NestExpressApplication | undefined): void {
  if (app !== undefined) {
    cleanups.push(() => app.close());
  }
}

/** What the API that started on a free port did: its start, its answer, its close, and the answer after the close. */
interface Listened {
  readonly sink: MemorySink;
  readonly port: number;
  readonly app: NestExpressApplication | undefined;
  readonly address: unknown;
  readonly live: Exchange | undefined;
  readonly afterClose: unknown;
}

/** What the API that found its port taken did. */
interface PortTaken {
  readonly sink: MemorySink;
  readonly app: NestExpressApplication | undefined;
}

let listened: Listened;
let portTaken: PortTaken;

beforeAll(async () => {
  {
    const sink = new MemorySink();
    const port = await freePort();
    const app = await startApi({
      env: { ...ENV, REDIS_URL: await unreachableRedisUrl(), PORT: String(port) },
      logDestination: sink,
    });
    const address: unknown = app?.getHttpServer().address();
    const live = app === undefined ? undefined : await exchange(port, "/health/live");
    await app?.close();
    const afterClose = await exchange(port, "/health/live").then(
      () => undefined,
      (error: unknown) => error,
    );
    listened = { sink, port, app, address, live, afterClose };
  }
  {
    const sink = new MemorySink();
    const taken = await occupiedPort();
    cleanups.push(taken.release);
    const app = await startApi({
      env: { ...ENV, REDIS_URL: await unreachableRedisUrl(), PORT: String(taken.port) },
      logDestination: sink,
    });
    closeLater(app);
    portTaken = { sink, app };
  }
}, START_TIMEOUT_MS);

describe("startApi", () => {
  it("does not start without DATABASE_URL and logs a ConfigError naming it [OBE-001 AC3]", async () => {
    const sink = new MemorySink();
    const { DATABASE_URL: _omitted, ...withoutUrl } = ENV;

    const app = await startApi({ env: withoutUrl, logDestination: sink });

    expect(app).toBeUndefined();
    expect(sink.records()).toEqual([
      expect.objectContaining({
        level: 60,
        app: "ota-api",
        msg: "api.config_invalid",
        err: expect.objectContaining({
          type: "ConfigError",
          message: expect.stringContaining("DATABASE_URL is required but missing"),
        }),
      }),
    ]);
  });

  it("never prints a configuration value when it refuses to start", async () => {
    const sink = new MemorySink();

    const app = await startApi({
      env: { ...ENV, REDIS_URL: "http://:dummy-secret-value@127.0.0.1:6379" },
      logDestination: sink,
    });

    expect(app).toBeUndefined();
    expect(sink.text()).toContain("REDIS_URL");
    expect(sink.text()).not.toContain("dummy-secret-value");
  });

  it("listens on 127.0.0.1:PORT, answers /health/live and stops listening when closed", () => {
    const { sink, port, app, address, live, afterClose } = listened;

    expect(app).toBeDefined();
    expect(address).toMatchObject({ address: API_HOST, port });
    expect(sink.records()).toContainEqual(
      expect.objectContaining({ msg: "api.listening", host: "127.0.0.1", port }),
    );
    expect(live?.status).toBe(200);
    expect(live?.json()).toEqual({ status: "ok" });

    // The request after the close (the hook closed the API) was refused: an error, never an answer.
    expect(afterClose).toBeInstanceOf(Error);
    expect((afterClose as Error).message).toMatch(/ECONNREFUSED/);
  });

  it("logs api.start_failed and resolves to undefined when the port is taken", () => {
    const { sink, app } = portTaken;

    expect(app).toBeUndefined();
    expect(sink.records()).toContainEqual(
      expect.objectContaining({
        level: 60,
        msg: "api.start_failed",
        err: expect.objectContaining({ code: "EADDRINUSE" }),
      }),
    );
  });
});
