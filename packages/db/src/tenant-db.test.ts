// Unit tests of tenantTx against a recording fake pool: what reaches the database, and in which order.
// The same behaviour against PostgreSQL is in test/integration/tenant-tx.int.test.ts.
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createTenantDb,
  DEFAULT_TENANT_STATEMENT_TIMEOUT_MS,
  SearchPathLeakError,
  tenantTx,
} from "./tenant-db.js";
import { InvalidTenantSchemaError } from "./tenant-schema.js";

interface Items {
  items: { id: string; label: string };
}

interface RecordedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** A pool with one fake connection that records every statement and answers the leak guard query. */
function fakePool(settings: { searchPath?: string; roleDefault?: string } = {}) {
  const queries: RecordedQuery[] = [];
  const client = {
    query: (text: string, parameters: readonly unknown[]) => {
      const sql = text.replace(/\s+/g, " ").trim();
      queries.push({ sql, parameters });
      const rows = sql.includes("pg_settings")
        ? [
            {
              search_path: settings.searchPath ?? "pg_catalog",
              role_default: settings.roleDefault ?? "pg_catalog",
            },
          ]
        : [];
      return Promise.resolve({ command: "SELECT", rowCount: rows.length, rows });
    },
    release: vi.fn(),
  };
  const connect = vi.fn(() => Promise.resolve(client));
  const pool = { connect, end: () => Promise.resolve() } as unknown as pg.Pool;
  return { pool, connect, client, queries, statements: () => queries.map((query) => query.sql) };
}

const GUARD =
  "SELECT current_setting('search_path') AS search_path, reset_val AS role_default FROM pg_catalog.pg_settings WHERE name = 'search_path'";
const SET_SEARCH_PATH = "SELECT set_config('search_path', $1, true)";
const SET_STATEMENT_TIMEOUT = "SELECT set_config('statement_timeout', $1, true)";

describe("tenantTx", () => {
  it.each(["tenant_a; DROP TABLE x", "public", "tenant_x; SET search_path TO public", "Tenant_acme"])(
    "rejects the schema %j before any SQL runs [X-010 AC3]",
    async (schema) => {
      const fake = fakePool();
      const db = createTenantDb<Items>(fake.pool, { appEnv: "test" });
      const fn = vi.fn(() => Promise.resolve("never"));

      await expect(tenantTx(db, schema, fn)).rejects.toBeInstanceOf(InvalidTenantSchemaError);
      expect(fake.connect).not.toHaveBeenCalled();
      expect(fake.queries).toEqual([]);
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it("runs the leak guard, then set_config for search_path and statement_timeout, then fn, then commits", async () => {
    const fake = fakePool();
    const db = createTenantDb<Items>(fake.pool, { appEnv: "test" });

    const result = await tenantTx(db, "tenant_acme", async (trx) => {
      await trx.selectFrom("items").select(["id", "label"]).execute();
      return "done";
    });

    expect(result).toBe("done");
    expect(fake.statements()).toEqual([
      "begin",
      GUARD,
      SET_SEARCH_PATH,
      SET_STATEMENT_TIMEOUT,
      'select "id", "label" from "items"',
      "commit",
    ]);
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it("binds the schema and the timeout as parameters and never concatenates them into SQL", async () => {
    const fake = fakePool();
    const db = createTenantDb<Items>(fake.pool, { appEnv: "test" });

    await tenantTx(db, "tenant_acme", () => Promise.resolve(null), { statementTimeoutMs: 1234 });

    const setSearchPath = fake.queries.find((query) => query.sql === SET_SEARCH_PATH);
    const setTimeout = fake.queries.find((query) => query.sql === SET_STATEMENT_TIMEOUT);
    expect(setSearchPath?.parameters).toEqual(["tenant_acme, reference"]);
    expect(setTimeout?.parameters).toEqual(["1234"]);
    expect(fake.statements().filter((sql) => sql.includes("tenant_acme") || sql.includes("1234"))).toEqual(
      [],
    );
  });

  it("uses a 5000 ms statement_timeout by default", async () => {
    const fake = fakePool();
    const db = createTenantDb<Items>(fake.pool, { appEnv: "test" });

    await tenantTx(db, "tenant_acme", () => Promise.resolve(null));

    expect(DEFAULT_TENANT_STATEMENT_TIMEOUT_MS).toBe(5000);
    expect(fake.queries.find((query) => query.sql === SET_STATEMENT_TIMEOUT)?.parameters).toEqual(["5000"]);
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 31])(
    "rejects statementTimeoutMs %s before any SQL runs",
    async (statementTimeoutMs) => {
      const fake = fakePool();
      const db = createTenantDb<Items>(fake.pool, { appEnv: "test" });

      await expect(
        tenantTx(db, "tenant_acme", () => Promise.resolve(null), { statementTimeoutMs }),
      ).rejects.toThrow(TypeError);
      expect(fake.connect).not.toHaveBeenCalled();
    },
  );

  it("throws SearchPathLeakError, rolls back and never runs fn when the guard finds a session-level search_path [X-010 AC4]", async () => {
    const fake = fakePool({ searchPath: "tenant_alpha", roleDefault: "pg_catalog" });
    const db = createTenantDb<Items>(fake.pool, { appEnv: "test" });
    const fn = vi.fn(() => Promise.resolve("never"));

    const error: unknown = await tenantTx(db, "tenant_beta", fn).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SearchPathLeakError);
    expect(error).toMatchObject({ searchPath: "tenant_alpha", roleDefault: "pg_catalog" });
    expect((error as Error).message).toContain('found search_path "tenant_alpha"');
    expect(fn).not.toHaveBeenCalled();
    expect(fake.statements()).toEqual(["begin", GUARD, "rollback"]);
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it.each(["development", "test", undefined])("runs the leak guard when APP_ENV is %s", async (appEnv) => {
    const fake = fakePool();
    const db = createTenantDb<Items>(fake.pool, appEnv === undefined ? {} : { appEnv });

    await tenantTx(db, "tenant_acme", () => Promise.resolve(null));

    expect(fake.statements()[1]).toBe(GUARD);
  });

  it("skips the leak guard in production", async () => {
    const fake = fakePool({ searchPath: "tenant_alpha" });
    const db = createTenantDb<Items>(fake.pool, { appEnv: "production" });

    await tenantTx(db, "tenant_acme", () => Promise.resolve(null));

    expect(fake.statements()).toEqual(["begin", SET_SEARCH_PATH, SET_STATEMENT_TIMEOUT, "commit"]);
  });

  it("rolls back and rethrows the error of fn", async () => {
    const fake = fakePool();
    const db = createTenantDb<Items>(fake.pool, { appEnv: "test" });
    const failure = new Error("use case failed");

    await expect(tenantTx(db, "tenant_acme", () => Promise.reject(failure))).rejects.toBe(failure);

    expect(fake.statements().at(-1)).toBe("rollback");
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it("gives no query methods outside tenantTx", () => {
    const fake = fakePool();
    const db = createTenantDb<Items>(fake.pool, { appEnv: "test" });

    expect(() => {
      // @ts-expect-error: tenant tables are reachable only inside tenantTx
      db.selectFrom("items");
    }).toThrow(TypeError);
    expect(Object.keys(db)).toEqual([]);
  });

  it("types the transaction with the tenant tables", async () => {
    const fake = fakePool();
    const db = createTenantDb<Items>(fake.pool, { appEnv: "test" });

    await tenantTx(db, "tenant_acme", async (trx) => {
      await trx.selectFrom("items").select("label").execute();
      // @ts-expect-error: "bookings" is not a table of this tenant database
      await trx.selectFrom("bookings").selectAll().execute();
    });
  });
});

describe("SearchPathLeakError", () => {
  it("names both values and points at tenantTx", () => {
    const error = new SearchPathLeakError("tenant_alpha, public", "pg_catalog");
    expect(error.name).toBe("SearchPathLeakError");
    expect(error.message).toBe(
      'tenantTx found search_path "tenant_alpha, public" on a pooled connection instead of the role default ' +
        '"pg_catalog": a session-level SET search_path leaked. Reach tenant data only through tenantTx (ADR-0004).',
    );
  });
});
