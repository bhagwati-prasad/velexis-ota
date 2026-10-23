// Integration tests of task X-015 steps 2 and 3 on PostgreSQL 16: the template database that the global setup
// (src/vitest-global-setup.ts, configured in vitest.int.config.ts) builds once per run, and createTestDatabase()
// clones of it. They need TEST_DATABASE_ADMIN_URL (velexis_test_admin) and the development role passwords of
// .env.example, as set by deploy/scripts/dev-setup.sh and the CI bootstrap. Every database created here is dropped
// by the test that created it, or by afterAll.
import { performance } from "node:perf_hooks";
import { sql, tenantTx } from "@velexis/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  databaseUrl,
  REFERENCE_FIXTURE,
  runIdOfTemplate,
  TEMPLATE_DATABASE_PREFIX,
  TEST_DATABASE_PREFIX,
  TEST_ROLE_NAMES,
  TEST_ROLES,
  TEST_TENANTS,
  testDatabaseAdminUrl,
  type TestDatabase,
} from "../../src/index.js";
import setup from "../../src/vitest-global-setup.js";
import {
  arrive,
  BARRIER_TIMEOUT_MS,
  customerIds,
  leave,
  markerId,
  templateName,
  withTenantDb,
  writeMarkers,
} from "./parallel-isolation.js";

/** The acceptance limit of one clone (X-015 AC2), measured locally at 0.1 to 0.4 s. */
const CLONE_LIMIT_MS = 1_000;
// Building a whole template (in the setup hook of the global setup's test) migrates three sets: a few seconds, more on
// a busy runner.
const TEMPLATE_TIMEOUT_MS = 120_000;

const adminUrl = testDatabaseAdminUrl();

/** Runs `fn` with one connection as `url`, then closes it. */
async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: "velexis-testing-int" });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Runs one query as velexis_test_admin on `database` (default: the maintenance database). */
async function adminQuery<R extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
  database?: string,
): Promise<R[]> {
  const url = database === undefined ? adminUrl : databaseUrl(adminUrl, database);
  return await withClient(url, async (client) => (await client.query<R>(text, values)).rows);
}

async function databaseExists(name: string): Promise<boolean> {
  return (await adminQuery("SELECT 1 FROM pg_database WHERE datname = $1", [name])).length === 1;
}

/** The database's ACL as `grantee:privilege` pairs, sorted (`PUBLIC` for the grantee 0). */
async function databaseAcl(name: string): Promise<string[]> {
  const rows = await adminQuery<{ entry: string }>(
    "SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type " +
      "AS entry FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a " +
      "WHERE d.datname = $1 ORDER BY 1",
    [name],
  );
  return rows.map((row) => row.entry);
}

describe("createTestDatabase", () => {
  let db: TestDatabase;
  let cloneMs: number;

  beforeAll(async () => {
    const started = performance.now();
    db = await createTestDatabase();
    cloneMs = performance.now() - started;
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("clones the migrated template: platform, reference, tenant_alpha and tenant_beta [X-015 AC1]", async () => {
    const schemas = await adminQuery<{ name: string; owner: string }>(
      "SELECT nspname AS name, nspowner::regrole::text AS owner FROM pg_namespace " +
        "WHERE nspname IN ('platform', 'reference', 'tenant_alpha', 'tenant_beta', 'public') ORDER BY 1",
      [],
      db.name,
    );
    expect(schemas).toEqual([
      { name: "platform", owner: "velexis_migrator" },
      { name: "public", owner: "pg_database_owner" },
      { name: "reference", owner: "velexis_migrator" },
      { name: "tenant_alpha", owner: "velexis_provisioner" },
      { name: "tenant_beta", owner: "velexis_provisioner" },
    ]);
    // Every set was applied by the real runner: its ledger records the baseline (and the repeatable OTA grants), the
    // platform set the MVP deltas of its migration 0002 (PBE-002) and the tenant schemas those of theirs (OBE-008).
    const ledgers: Record<string, string[]> = {
      platform: ["0001_baseline", "0002_add_mvp_platform_deltas", "R__ota_read_access"],
      reference: ["0001_baseline"],
      tenant_alpha: ["0001_baseline", "0002_add_mvp_tenant_deltas"],
      tenant_beta: ["0001_baseline", "0002_add_mvp_tenant_deltas"],
    };
    for (const [schema, ids] of Object.entries(ledgers)) {
      const ledger = await adminQuery<{ id: string }>(
        `SELECT id FROM ${pg.escapeIdentifier(schema)}.schema_migrations ORDER BY id`,
        [],
        db.name,
      );
      expect({ schema, ids: ledger.map((row) => row.id) }).toEqual({ schema, ids });
    }
    // The tenant tables are reachable as velexis_ota_app through tenantTx, empty, with the reference fixture.
    await withTenantDb(db, async (tenants) => {
      for (const tenant of TEST_TENANTS) {
        const counts = await tenantTx(tenants, tenant, async (trx) => {
          const result = await sql<{ customers: string; currencies: string }>`
            SELECT (SELECT count(*) FROM customers) AS customers, (SELECT count(*) FROM currencies) AS currencies
          `.execute(trx);
          return result.rows[0];
        });
        expect({ tenant, ...counts }).toEqual({ tenant, customers: "0", currencies: "3" });
      }
    });
  });

  it("loads the reference fixture: 3 currencies, 3 countries, 5 airports, 3 airlines", async () => {
    await withClient(db.urlFor("platform"), async (client) => {
      for (const [table, key] of [
        ["currencies", "code"],
        ["countries", "code"],
        ["airports", "iata_code"],
        ["airlines", "iata_code"],
      ] as const) {
        const { rows } = await client.query<{ key: string }>(
          `SELECT ${key} AS key FROM reference.${table} ORDER BY 1`,
        );
        const expected = REFERENCE_FIXTURE[table].map((row) => (row as Record<string, string>)[key]).sort();
        expect({ table, keys: rows.map((row) => row.key) }).toEqual({ table, keys: expected });
      }
    });
  });

  it("logs every role in with its development password; velexis_ota_app resolves no schema [X-015 AC1]", async () => {
    for (const role of TEST_ROLE_NAMES) {
      const row = await withClient(db.urlFor(role), async (client) => {
        const { rows } = await client.query<{ user: string; database: string; search_path: string }>(
          "SELECT current_user AS user, current_database() AS database, current_setting('search_path') AS search_path",
        );
        return rows[0];
      });
      expect(row?.user).toBe(TEST_ROLES[role].user);
      expect(row?.database).toBe(db.name);
      if (role === "ota") {
        expect(row?.search_path).toBe("pg_catalog");
      }
    }
  });

  it("gives the clone the database grants of bootstrap.sql, which PostgreSQL does not copy [X-015 AC1]", async () => {
    const expected = [
      "velexis_migrator:CONNECT",
      "velexis_migrator:CREATE",
      "velexis_migrator:TEMPORARY",
      "velexis_ota_app:CONNECT",
      "velexis_ota_app:TEMPORARY",
      "velexis_platform_app:CONNECT",
      "velexis_platform_app:TEMPORARY",
      "velexis_provisioner:CONNECT",
      "velexis_provisioner:CREATE",
      "velexis_provisioner:TEMPORARY",
    ];
    expect(await databaseAcl(templateName())).toEqual(expected);
    expect(await databaseAcl(db.name)).toEqual(expected);
    const [owner] = await adminQuery<{ owner: string }>(
      "SELECT datdba::regrole::text AS owner FROM pg_database WHERE datname = $1",
      [db.name],
    );
    expect(owner?.owner).toBe("velexis_migrator");
  });

  it("keeps two databases apart: a change in one is invisible in the other [X-015 AC1]", async () => {
    const [one, two] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    try {
      expect(one.name).not.toBe(two.name);
      await writeMarkers(one, "first");
      expect(await customerIds(one)).toEqual({
        tenant_alpha: [markerId("first", "tenant_alpha")],
        tenant_beta: [markerId("first", "tenant_beta")],
      });
      expect(await customerIds(two)).toEqual({ tenant_alpha: [], tenant_beta: [] });
      expect(await customerIds(db)).toEqual({ tenant_alpha: [], tenant_beta: [] });
    } finally {
      await Promise.all([one.drop(), two.drop()]);
    }
  });

  it("builds the template once per run and clones it in less than 1 s [X-015 AC2]", async () => {
    const template = templateName();
    const runId = runIdOfTemplate(template);
    expect(db.name.startsWith(`${TEST_DATABASE_PREFIX}${runId}_`)).toBe(true);
    // One template for this run, however many files and clones there are (the other test file checks at the
    // barrier that it got the same one).
    const templateOid = async (): Promise<Array<{ name: string; oid: string }>> =>
      await adminQuery("SELECT datname AS name, oid::text AS oid FROM pg_database WHERE datname = $1", [
        `${TEMPLATE_DATABASE_PREFIX}${runId}`,
      ]);
    const before = await templateOid();
    expect(before.map((row) => row.name)).toEqual([template]);
    // Clones never rebuild it: three more each take less than the limit, like the first one, and the template is
    // still the very same database afterwards.
    const durations = [cloneMs];
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      const clone = await createTestDatabase();
      durations.push(performance.now() - started);
      await clone.drop();
    }
    expect(durations.filter((ms) => ms >= CLONE_LIMIT_MS)).toEqual([]);
    expect(await templateOid()).toEqual(before);
  });

  it("drop() removes the database while connections of every role are open (WITH (FORCE)) [X-015 AC3]", async () => {
    const victim = await createTestDatabase();
    const clients: pg.Client[] = [];
    try {
      for (const role of TEST_ROLE_NAMES) {
        const client = new pg.Client({
          connectionString: victim.urlFor(role),
          application_name: "velexis-testing-int",
        });
        // The session is terminated under the client: its 'error' event must not crash the worker.
        client.on("error", () => undefined);
        await client.connect();
        clients.push(client);
      }
      // velexis_ota_app also holds a transaction open, as a request waiting on a supplier would.
      await clients[3]?.query("BEGIN");
      await clients[3]?.query("SELECT 1");
      const sessions = await adminQuery<{ usename: string }>(
        "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = $1 ORDER BY 1",
        [victim.name],
      );
      expect(sessions.map((row) => row.usename)).toEqual(
        TEST_ROLE_NAMES.map((role) => TEST_ROLES[role].user).sort(),
      );

      await victim.drop();

      expect(await databaseExists(victim.name)).toBe(false);
      for (const client of clients) {
        await expect(client.query("SELECT 1")).rejects.toThrow();
      }
      // Idempotent.
      await expect(victim.drop()).resolves.toBeUndefined();
    } finally {
      await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
      await victim.drop();
    }
  });
});

describe("the global setup", () => {
  /** What a run of the global setup gave, observed in the setup hook; the test below asserts on it. */
  interface SetupRun {
    readonly name: string | undefined;
    readonly existed: boolean;
    readonly sessions: unknown[];
    readonly cloneCustomers: Awaited<ReturnType<typeof customerIds>>;
    readonly leftoverExisted: boolean;
    readonly leftovers: readonly string[];
    readonly oursSurvived: boolean;
    readonly existsAfterTeardown: boolean;
    readonly leftoversAfterTeardown: readonly boolean[];
  }
  let observed: SetupRun;

  // The global setup builds a whole template (it migrates three sets), then the teardown drops it: a few seconds, more
  // on a busy runner. It runs here, in the setup hook with TEMPLATE_TIMEOUT_MS, and not inside the test's 5 s.
  beforeAll(async () => {
    // A clone of this run's template, which the other run's teardown must leave alone.
    const ours = await createTestDatabase();
    const provided = new Map<string, string>();
    const teardown = await setup({ provide: (key, value) => provided.set(key, value) });
    const name = provided.get("velexisTestTemplateDatabase");
    const leftovers: string[] = [];
    let existed: boolean;
    let sessions: unknown[];
    let cloneCustomers: SetupRun["cloneCustomers"];
    let leftoverExisted: boolean;
    try {
      existed = await databaseExists(name as string);
      // A template accepts no session of its own after the build, so it can be cloned at once.
      sessions = await adminQuery("SELECT 1 FROM pg_stat_activity WHERE datname = $1", [name]);
      const clone = await createTestDatabase({ template: name });
      cloneCustomers = await customerIds(clone);
      await clone.drop();
      // A clone whose test file never called drop() (it crashed before afterAll): the teardown removes it.
      const leftover = await createTestDatabase({ template: name });
      leftovers.push(leftover.name);
      leftoverExisted = await databaseExists(leftover.name);
    } finally {
      await teardown();
    }
    // (Should anything above fail, this run's own teardown drops `ours`.)
    const oursSurvived = await databaseExists(ours.name);
    await ours.drop();
    observed = {
      name,
      existed,
      sessions,
      cloneCustomers,
      leftoverExisted,
      leftovers,
      oursSurvived,
      existsAfterTeardown: await databaseExists(name as string),
      leftoversAfterTeardown: await Promise.all(leftovers.map(async (leftover) => databaseExists(leftover))),
    };
  }, TEMPLATE_TIMEOUT_MS);

  it("builds a template, provides its name to the test files, and drops it at teardown with leftover clones", () => {
    const { name } = observed;
    expect(name).toMatch(/^velexis_test_tpl_[a-z0-9]+_[0-9a-f]{6}$/);
    expect(name).not.toBe(templateName());
    expect(observed.existed).toBe(true);
    expect(observed.sessions).toEqual([]);
    expect(observed.cloneCustomers).toEqual({ tenant_alpha: [], tenant_beta: [] });
    expect(observed.leftoverExisted).toBe(true);

    expect(observed.oursSurvived).toBe(true);
    expect(observed.existsAfterTeardown).toBe(false);
    expect(observed.leftovers).toHaveLength(1);
    for (const existsAfter of observed.leftoversAfterTeardown) {
      expect(existsAfter).toBe(false);
    }
  });
});

describe("two test files running in parallel", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await leave("first");
    await db?.drop();
  });

  it(
    "each get their own database, and changes in one are invisible to the other [X-015 AC1]",
    async () => {
      await writeMarkers(db, "first");
      // test-database-parallel.int.test.ts has written its own rows into its own database by now.
      const other = await arrive("first", db.name);
      // Their own databases, cloned from the one template of the run (X-015 AC2).
      expect(other.database).toMatch(new RegExp(`^${TEST_DATABASE_PREFIX}`));
      expect(other.database).not.toBe(db.name);
      expect(other.template).toBe(templateName());
      expect(await customerIds(db)).toEqual({
        tenant_alpha: [markerId("first", "tenant_alpha")],
        tenant_beta: [markerId("first", "tenant_beta")],
      });
    },
    BARRIER_TIMEOUT_MS + 10_000,
  );
});
