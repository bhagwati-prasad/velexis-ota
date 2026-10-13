// tenantTx, the leak guard, the type parsers and platformDb against PostgreSQL 16 (X-010).
// Every pool connects as velexis_ota_app, whose role default search_path is pg_catalog (bootstrap.sql).
import { sql, type Generated, type Transaction } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  InvalidTenantSchemaError,
  PG_TYPE_OID,
  SearchPathLeakError,
  tenantTx,
} from "../../src/index.js";
import { createScratchDatabase, ITEMS, TENANTS, type ScratchDatabase, type TestTenant } from "./helpers.js";

interface TestTenantDatabase {
  items: { id: string; label: string; price: string; created_at: Generated<Date> };
  currencies: { code: string; minor_units: number };
}

interface TestPlatformDatabase {
  "platform.tenants": { id: string; schema_name: string };
}

interface SessionState {
  search_path: string;
  statement_timeout: string;
  pid: number;
}

const WORD: Record<TestTenant, string> = { tenant_alpha: "alpha", tenant_beta: "beta" };

let scratch: ScratchDatabase;
const logger = { error: vi.fn() };
const pools = new Set<pg.Pool>();

beforeAll(async () => {
  scratch = await createScratchDatabase();
});

afterAll(async () => {
  // A failed test can leave its pool open, and DROP DATABASE refuses while connections remain.
  await Promise.all([...pools].filter((pool) => !pool.ending).map((pool) => pool.end()));
  await scratch?.drop();
  expect(logger.error).not.toHaveBeenCalled();
});

/** A pool on the scratch database as velexis_ota_app; every test ends its own, afterAll any it left open. */
function otaPool(max = 4): pg.Pool {
  const pool = createPool(scratch.otaUrl, { applicationName: "velexis-db-int-test", logger, max });
  pools.add(pool);
  return pool;
}

/** The seed rows of a tenant, whatever other tests added. */
function seedLabels(trx: Transaction<TestTenantDatabase>): Promise<string[]> {
  return trx
    .selectFrom("items")
    .select("label")
    .where("id", "like", "itm\\_%")
    .orderBy("id")
    .execute()
    .then((rows) => rows.map((row) => row.label));
}

/** Deletes the rows that the isolation test added, so every test starts from the seed rows. */
async function removeRuns(pool: pg.Pool): Promise<void> {
  const db = createTenantDb<TestTenantDatabase>(pool, { appEnv: "test" });
  for (const tenant of TENANTS) {
    await tenantTx(db, tenant, (trx) => trx.deleteFrom("items").where("id", "like", "run\\_%").execute());
  }
}

/** search_path, statement_timeout and backend pid of the next free connection, outside any transaction. */
async function sessionState(pool: pg.Pool): Promise<SessionState> {
  const { rows } = await pool.query<SessionState>(
    "SELECT current_setting('search_path') AS search_path, current_setting('statement_timeout') AS statement_timeout, pg_backend_pid() AS pid",
  );
  return rows[0]!;
}

async function stateIn(trx: Transaction<TestTenantDatabase>): Promise<SessionState & { schema: string }> {
  const { rows } = await sql<SessionState & { schema: string }>`
    SELECT current_setting('search_path') AS search_path, current_setting('statement_timeout') AS statement_timeout,
           pg_backend_pid() AS pid, current_schema() AS schema`.execute(trx);
  return rows[0]!;
}

describe("tenantTx on PostgreSQL", () => {
  it("keeps 50 interleaved tenantTx calls of two tenants apart through a pool of size 1 [X-010 AC1]", async () => {
    const pool = otaPool(1);
    try {
      const db = createTenantDb<TestTenantDatabase>(pool, { appEnv: "test" });
      const runs = Array.from({ length: 50 }, (_, index) => {
        const tenant = TENANTS[index % 2]!;
        return tenantTx(db, tenant, async (trx) => {
          await trx
            .insertInto("items")
            .values({ id: `run_${index}`, label: `${WORD[tenant]} run ${index}`, price: "1.00" })
            .execute();
          const items = await trx.selectFrom("items").select(["id", "label"]).orderBy("id").execute();
          const state = await stateIn(trx);
          if (index % 5 === 0) {
            throw new Error(`roll back run ${index}`);
          }
          return { index, tenant, items, state };
        });
      });

      const settled = await Promise.allSettled(runs);

      const committed = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      const rolledBack = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      expect(committed).toHaveLength(40);
      expect(rolledBack.map((reason) => (reason as Error).message)).toEqual(
        Array.from({ length: 10 }, (_, n) => `roll back run ${n * 5}`),
      );

      const pids = new Set<number>();
      for (const { index, tenant, items, state } of committed) {
        pids.add(state.pid);
        expect(state.schema).toBe(tenant);
        expect(state.search_path).toBe(`${tenant}, reference`);
        // Every row a transaction sees belongs to its own tenant: the seed rows and its own committed runs.
        for (const item of items) {
          expect(item.label.startsWith(`${WORD[tenant]} `)).toBe(true);
        }
        expect(items.map((item) => item.id)).toEqual(
          expect.arrayContaining(ITEMS[tenant].map((item) => item.id)),
        );
        expect(items.map((item) => item.id)).toContain(`run_${index}`);
      }
      // One connection served all 50 transactions, alternating between the tenants.
      expect(pids.size).toBe(1);
      expect(pool.totalCount).toBe(1);

      // Afterwards each tenant holds exactly its seed rows and its committed runs, nothing of the other one.
      for (const tenant of TENANTS) {
        const ids = await tenantTx(db, tenant, (trx) =>
          trx.selectFrom("items").select("id").orderBy("id").execute(),
        );
        const expected = [
          ...ITEMS[tenant].map((item) => item.id),
          ...committed.filter((run) => run.tenant === tenant).map((run) => `run_${run.index}`),
        ].sort();
        expect(ids.map((row) => row.id)).toEqual(expected);
      }
    } finally {
      try {
        await removeRuns(pool);
      } finally {
        await pool.end();
      }
    }
  });

  it("leaves the same connection on the role default search_path after a commit and after a rollback [X-010 AC2]", async () => {
    const pool = otaPool(1);
    try {
      const db = createTenantDb<TestTenantDatabase>(pool, { appEnv: "test" });

      const inCommitted = await tenantTx(db, "tenant_alpha", (trx) => stateIn(trx));
      expect(inCommitted).toMatchObject({ search_path: "tenant_alpha, reference", statement_timeout: "5s" });
      expect(await sessionState(pool)).toEqual({
        search_path: "pg_catalog",
        statement_timeout: "30s",
        pid: inCommitted.pid,
      });

      let inRolledBack: SessionState | undefined;
      await expect(
        tenantTx(db, "tenant_beta", async (trx) => {
          inRolledBack = await stateIn(trx);
          await trx.deleteFrom("items").execute();
          throw new Error("use case failed");
        }),
      ).rejects.toThrow("use case failed");
      expect(inRolledBack).toMatchObject({ search_path: "tenant_beta, reference", pid: inCommitted.pid });
      expect(await sessionState(pool)).toEqual({
        search_path: "pg_catalog",
        statement_timeout: "30s",
        pid: inCommitted.pid,
      });
      // The rollback kept the rows, and outside tenantTx no tenant table resolves at all.
      expect(await tenantTx(db, "tenant_beta", seedLabels)).toEqual(
        ITEMS.tenant_beta.map((item) => item.label),
      );
      await expect(pool.query("SELECT id FROM items")).rejects.toThrow('relation "items" does not exist');
    } finally {
      await pool.end();
    }
  });

  it.each(["tenant_a; DROP TABLE x", "public", "tenant_alpha; DROP TABLE items", "reference"])(
    "rejects %j before any SQL runs [X-010 AC3]",
    async (schema) => {
      const pool = otaPool(1);
      try {
        const connect = vi.spyOn(pool, "connect");
        const db = createTenantDb<TestTenantDatabase>(pool, { appEnv: "test" });
        const fn = vi.fn(() => Promise.resolve([]));

        await expect(tenantTx(db, schema, fn)).rejects.toBeInstanceOf(InvalidTenantSchemaError);

        expect(connect).not.toHaveBeenCalled();
        expect(pool.totalCount).toBe(0);
        expect(fn).not.toHaveBeenCalled();
        connect.mockRestore();
        expect(
          await tenantTx(db, "tenant_alpha", (trx) => trx.selectFrom("items").select("id").execute()),
        ).not.toEqual([]);
      } finally {
        await pool.end();
      }
    },
  );

  it.each([
    ["SET search_path TO tenant_a", "tenant_a"],
    ["SELECT set_config('search_path', 'tenant_alpha, public', false)", "tenant_alpha, public"],
  ])(
    "throws SearchPathLeakError in the next tenantTx after a session-level %j (test environment) [X-010 AC4]",
    async (leak, leaked) => {
      const pool = otaPool(1);
      try {
        // The bug the guard catches: some code changes search_path for the whole session of a pooled connection.
        const client = await pool.connect();
        await client.query(leak);
        client.release();

        const db = createTenantDb<TestTenantDatabase>(pool, { appEnv: "test" });
        const fn = vi.fn((trx: Transaction<TestTenantDatabase>) =>
          trx.selectFrom("items").selectAll().execute(),
        );
        const error: unknown = await tenantTx(db, "tenant_beta", fn).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SearchPathLeakError);
        expect(error).toMatchObject({ searchPath: leaked, roleDefault: "pg_catalog" });
        expect(fn).not.toHaveBeenCalled();
        expect(pool.totalCount).toBe(1);
      } finally {
        await pool.end();
      }
    },
  );

  it("skips the leak guard in production, where search_path is still set for the transaction", async () => {
    const pool = otaPool(1);
    try {
      const client = await pool.connect();
      await client.query("SET search_path TO tenant_alpha");
      client.release();

      const db = createTenantDb<TestTenantDatabase>(pool, { appEnv: "production" });
      const labels = await tenantTx(db, "tenant_beta", seedLabels);

      expect(labels).toEqual(ITEMS.tenant_beta.map((item) => item.label));
    } finally {
      await pool.end();
    }
  });

  it("returns numeric and int8 as strings, timestamptz as Date and jsonb parsed [X-010 AC5]", async () => {
    const pool = otaPool(1);
    const globalNumeric = pg.types.getTypeParser(PG_TYPE_OID.NUMERIC, "text");
    try {
      const db = createTenantDb<TestTenantDatabase>(pool, { appEnv: "test" });
      // A global change by other code must not reach a Velexis pool.
      pg.types.setTypeParser(PG_TYPE_OID.NUMERIC, "text", Number.parseFloat);

      const { item, values } = await tenantTx(db, "tenant_alpha", async (trx) => ({
        item: await trx
          .selectFrom("items")
          .select(["price", "created_at"])
          .where("id", "=", "itm_a1")
          .executeTakeFirstOrThrow(),
        values: (
          await sql<{
            amount: unknown;
            big: unknown;
            amounts: unknown;
            at: unknown;
            doc: unknown;
            json: unknown;
          }>`
            SELECT 12.3::numeric(12,2) AS amount, 9007199254740993::int8 AS big,
                   ARRAY[1.5, 2.30, NULL]::numeric[] AS amounts,
                   '2026-10-13 07:44:00.123456+00'::timestamptz AS at,
                   '{"a": [1, "x"], "n": 12.30}'::jsonb AS doc, '[true]'::json AS json`.execute(trx)
        ).rows[0]!,
      }));

      expect(item.price).toBe("12.30");
      expect(item.created_at).toBeInstanceOf(Date);
      expect(values.amount).toBe("12.30");
      expect(values.big).toBe("9007199254740993");
      expect(values.amounts).toEqual(["1.5", "2.30", null]);
      expect(values.at).toEqual(new Date("2026-10-13T07:44:00.123Z"));
      expect(values.doc).toEqual({ a: [1, "x"], n: 12.3 });
      expect(values.json).toEqual([true]);
    } finally {
      pg.types.setTypeParser(PG_TYPE_OID.NUMERIC, "text", globalNumeric);
      await pool.end();
    }
  });

  it.each(["UTC", "Asia/Kolkata", "America/St_Johns", "Pacific/Chatham", "America/Los_Angeles"])(
    "reads timestamptz as the same instant in the session time zone %s",
    async (timeZone) => {
      const pool = otaPool(1);
      try {
        const db = createTenantDb<TestTenantDatabase>(pool, { appEnv: "test" });
        const rows = await tenantTx(db, "tenant_alpha", async (trx) => {
          await sql`SELECT set_config('TimeZone', ${timeZone}, true)`.execute(trx);
          const { rows: result } = await sql<{ text: string; at: Date; epoch_ms: string }>`
            SELECT at::text AS text, at, (extract(epoch FROM at) * 1000)::int8 AS epoch_ms
            FROM unnest(ARRAY['2026-10-13 07:44:00.123+00', '2026-01-15 23:30:00+00', '0099-06-01 12:00:00+00',
                              '1900-01-01 00:00:00+00']::timestamptz[]) AS at`.execute(trx);
          return result;
        });
        for (const row of rows) {
          expect(row.at).toBeInstanceOf(Date);
          expect({ text: row.text, ms: row.at.getTime() }).toEqual({
            text: row.text,
            ms: Number(row.epoch_ms),
          });
        }
      } finally {
        await pool.end();
      }
    },
  );

  it("limits each statement to the transaction's statement_timeout", async () => {
    const pool = otaPool(1);
    try {
      const db = createTenantDb<TestTenantDatabase>(pool, { appEnv: "test" });

      await expect(
        tenantTx(db, "tenant_alpha", (trx) => sql`SELECT pg_sleep(5)`.execute(trx), {
          statementTimeoutMs: 50,
        }),
      ).rejects.toThrow("canceling statement due to statement timeout");
      expect(
        await tenantTx(db, "tenant_alpha", (trx) => stateIn(trx), { statementTimeoutMs: 1500 }),
      ).toMatchObject({
        statement_timeout: "1500ms",
      });
      expect((await sessionState(pool)).statement_timeout).toBe("30s");
    } finally {
      await pool.end();
    }
  });

  it("reaches reference tables unqualified inside tenantTx", async () => {
    const pool = otaPool(1);
    try {
      const db = createTenantDb<TestTenantDatabase>(pool, { appEnv: "test" });
      const currencies = await tenantTx(db, "tenant_beta", (trx) =>
        trx.selectFrom("currencies").select(["code", "minor_units"]).orderBy("code").execute(),
      );
      expect(currencies).toEqual([
        { code: "EUR", minor_units: 2 },
        { code: "JPY", minor_units: 0 },
      ]);
    } finally {
      await pool.end();
    }
  });
});

describe("platformDb on PostgreSQL", () => {
  it("reads platform tables by their schema-qualified names only", async () => {
    const pool = otaPool(1);
    try {
      const platformDb = createPlatformDb<TestPlatformDatabase>(pool);

      const tenants = await platformDb
        .selectFrom("platform.tenants")
        .select(["id", "schema_name"])
        .orderBy("id")
        .execute();

      expect(tenants).toEqual([
        { id: "ten_alpha", schema_name: "tenant_alpha" },
        { id: "ten_beta", schema_name: "tenant_beta" },
      ]);
      await expect(sql`SELECT id FROM tenants`.execute(platformDb)).rejects.toThrow(
        'relation "tenants" does not exist',
      );
    } finally {
      await pool.end();
    }
  });
});
