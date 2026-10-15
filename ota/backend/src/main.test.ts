// Start-up of the API without PostgreSQL or Redis (the health probes connect on the first readiness check only):
// configuration failures, the bound interface, and a clean shutdown. Readiness with real dependencies:
// test/integration/health.
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterEach, describe, expect, it } from "vitest";
import { exchange } from "../test/helpers/http";
import { testApiVariables } from "../test/helpers/api-env";
import { MemorySink } from "../test/helpers/log-sink";
import { freePort, occupiedPort } from "../test/helpers/ports";
import { API_HOST, startApi } from "./main";

/** Dummy values; nothing connects to them in these tests. */
const ENV = {
  APP_ENV: "test",
  DATABASE_URL: "postgres://velexis_ota_app:dummy@127.0.0.1:5432/velexis",
  REDIS_URL: "redis://:dummy@127.0.0.1:6379/0",
  ...testApiVariables(),
} as const;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function closeLater(app: NestExpressApplication | undefined): void {
  if (app !== undefined) {
    cleanups.push(() => app.close());
  }
}

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

  it("listens on 127.0.0.1:PORT, answers /health/live and stops listening when closed", async () => {
    const sink = new MemorySink();
    const port = await freePort();

    const app = await startApi({ env: { ...ENV, PORT: String(port) }, logDestination: sink });

    expect(app).toBeDefined();
    const address: unknown = app?.getHttpServer().address();
    expect(address).toMatchObject({ address: API_HOST, port });
    expect(sink.records()).toContainEqual(
      expect.objectContaining({ msg: "api.listening", host: "127.0.0.1", port }),
    );
    const live = await exchange(port, "/health/live");
    expect(live.status).toBe(200);
    expect(live.json()).toEqual({ status: "ok" });

    await app?.close();
    await expect(exchange(port, "/health/live")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("logs api.start_failed and resolves to undefined when the port is taken", async () => {
    const sink = new MemorySink();
    const taken = await occupiedPort();
    cleanups.push(taken.release);

    const app = await startApi({ env: { ...ENV, PORT: String(taken.port) }, logDestination: sink });
    closeLater(app);

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
