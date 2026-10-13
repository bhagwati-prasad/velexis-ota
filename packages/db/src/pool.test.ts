import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPool, POOL_DEFAULTS, type PoolLogger } from "./pool.js";
import { PG_TYPE_OID } from "./type-parsers.js";

// Never connected to: the pools below only check their configuration.
const UNREACHABLE_URL = "postgres://velexis_ota_app:not-a-real-password@127.0.0.1:1/velexis";

function silentLogger(): PoolLogger & { error: ReturnType<typeof vi.fn> } {
  return { error: vi.fn() };
}

describe("createPool", () => {
  it("configures the pool with its own type parsers and the defaults", async () => {
    const pool = createPool(UNREACHABLE_URL, { applicationName: "ota-api", logger: silentLogger() });
    try {
      expect(pool.options).toMatchObject({
        application_name: "ota-api",
        max: POOL_DEFAULTS.max,
        statement_timeout: POOL_DEFAULTS.statementTimeoutMs,
        idleTimeoutMillis: POOL_DEFAULTS.idleTimeoutMillis,
        connectionTimeoutMillis: POOL_DEFAULTS.connectionTimeoutMillis,
      });
      const { types } = pool.options;
      expect(types).toBeDefined();
      expect(types).not.toBe(pg.types);
      const parseNumeric = types?.getTypeParser(PG_TYPE_OID.NUMERIC, "text") as (value: string) => unknown;
      expect(parseNumeric("12.30")).toBe("12.30");
    } finally {
      await pool.end();
    }
  });

  it("gives every pool its own types object and leaves the global pg.types alone", async () => {
    const before = pg.types.getTypeParser(PG_TYPE_OID.TIMESTAMPTZ, "text");
    const first = createPool(UNREACHABLE_URL, { applicationName: "a", logger: silentLogger() });
    const second = createPool(UNREACHABLE_URL, { applicationName: "b", logger: silentLogger() });
    try {
      expect(first.options.types).not.toBe(second.options.types);
      expect(pg.types.getTypeParser(PG_TYPE_OID.TIMESTAMPTZ, "text")).toBe(before);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it("takes the options it is given", async () => {
    const pool = createPool(UNREACHABLE_URL, {
      applicationName: "ota-worker",
      logger: silentLogger(),
      max: 1,
      statementTimeoutMs: 1000,
      idleTimeoutMillis: 2000,
      connectionTimeoutMillis: 3000,
    });
    try {
      expect(pool.options).toMatchObject({
        max: 1,
        statement_timeout: 1000,
        idleTimeoutMillis: 2000,
        connectionTimeoutMillis: 3000,
      });
    } finally {
      await pool.end();
    }
  });

  it("logs an idle client error instead of crashing the process", async () => {
    const logger = silentLogger();
    const pool = createPool(UNREACHABLE_URL, { applicationName: "ota-api", logger });
    try {
      const err = new Error("terminating connection due to administrator command");
      expect(pool.emit("error", err)).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        { err, applicationName: "ota-api" },
        "db.pool.idle_client_error",
      );
    } finally {
      await pool.end();
    }
  });

  it.each([
    ["an empty url", "", {}],
    ["an empty applicationName", UNREACHABLE_URL, { applicationName: " " }],
    ["max 0", UNREACHABLE_URL, { max: 0 }],
    ["a fractional statementTimeoutMs", UNREACHABLE_URL, { statementTimeoutMs: 1.5 }],
    ["a negative idleTimeoutMillis", UNREACHABLE_URL, { idleTimeoutMillis: -1 }],
    ["a connectionTimeoutMillis beyond 2^31 - 1", UNREACHABLE_URL, { connectionTimeoutMillis: 2 ** 31 }],
  ])("rejects %s without echoing the url", (_case, url, overrides) => {
    let thrown: unknown;
    try {
      createPool(url, { applicationName: "ota-api", logger: silentLogger(), ...overrides });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).not.toContain("not-a-real-password");
  });
});
