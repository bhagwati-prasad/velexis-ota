// Migration 0002 on PostgreSQL 16 (PBE-002; platform/docs/data-model-migration-0002.md "How to use it", conventions
// §9, ADR-0021). It must apply on a fresh database and as an upgrade of a database at version 0001, each time in one
// transaction with its ledger row:
//   - from scratch: the template database of @velexis/testing (built once per run by the global setup with the real
//     runner and the real platform/backend/migrations folders), cloned for this file;
//   - as an upgrade: a new empty database prepared like deploy/postgres/bootstrap.sql, the runner applied to a
//     temporary folder holding only 0001_baseline.sql, one tenant and one subscription written by
//     velexis_platform_app, then the runner applied to the real folder. The rows must survive.
// "One transaction" is read from PostgreSQL itself: every catalog row the file creates, the seeded plan and its ledger
// row carry the same transaction id (xmin), different from the baseline's.
// Databases are created as TEST_DATABASE_ADMIN_URL (velexis_test_admin) with the development role passwords of
// .env.example (TEST_ROLES), named velexis_test_<runId>_<random> so the global teardown removes any left behind.
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool } from "@velexis/db";
import { runMigrations, type RunMigrationsResult } from "@velexis/db/migrate";
import {
  createTestDatabase,
  databaseGrantStatements,
  databaseUrl,
  dropDatabase,
  runIdOfTemplate,
  TEMPLATE_DATABASE_KEY,
  TEST_DATABASE_PREFIX,
  TEST_ROLES,
  testDatabaseAdminUrl,
  type TestDatabase,
} from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");
const PLATFORM_MIGRATIONS = join(REPO, "platform", "backend", "migrations", "platform");
const SCHEMAS_SQL = join(REPO, "deploy", "postgres", "schemas.sql");
const BASELINE_ID = "0001_baseline";
const MIGRATION_ID = "0002_add_mvp_platform_deltas";

/** The 16 tables of the baseline (docs/velexis-sdk/db/platform.sql), plus the runner's ledger. */
const BASELINE_TABLES = [
  "account_sessions",
  "accounts",
  "api_key_tenant_grants",
  "api_keys",
  "invoices",
  "payment_provider_connections",
  "plans",
  "platform_audit_log",
  "provisioning_jobs",
  "subscriptions",
  "supplier_connections",
  "tenant_domains",
  "tenant_invitations",
  "tenant_memberships",
  "tenant_schema_migrations",
  "tenants",
];
/** The 11 tables 0002 creates (platform/docs/data-model.md §2 and §3). */
const NEW_TABLES = [
  "account_recovery_codes",
  "account_tokens",
  "amadeus_accounts",
  "amadeus_offices",
  "billing_customers",
  "credential_submissions",
  "email_outbox",
  "settlement_lines",
  "settlements",
  "stripe_events",
  "tenant_payout_accounts",
];

const PLAN = { code: "starter", name: "Starter" };
const TENANT = {
  id: "ten_01J9ZK3V5Q8X2M4N6P7R9S1T3X",
  key: "acme",
  name: "Acme Travel",
  plan_code: "starter",
};
const SUBSCRIPTION = {
  id: "sub_01J9ZK3V5Q8X2M4N6P7R9S1T4Y",
  tenant_id: TENANT.id,
  plan_code: "starter",
  status: "trialing",
  billing_provider: "manual",
  trial_ends_at: new Date("2026-11-01T00:00:00.000Z"),
};

type Pool = ReturnType<typeof createPool>;
type Row = Record<string, unknown>;

const adminUrl = testDatabaseAdminUrl();

function pool(url: string): Pool {
  return createPool(url, {
    applicationName: "platform-int-migrate-0002",
    logger: { error: () => undefined },
    max: 2,
  });
}

/** Runs `fn` with a pool on `url`, then ends the pool. */
async function withPool<T>(url: string, fn: (pool: Pool) => Promise<T>): Promise<T> {
  const connection = pool(url);
  try {
    return await fn(connection);
  } finally {
    await connection.end();
  }
}

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** The run id of the template the global setup built, so a database of this file is one of the run's clones. */
function runId(): string {
  const template = (inject as (key: string) => unknown)(TEMPLATE_DATABASE_KEY);
  if (typeof template !== "string") {
    throw new Error(
      "no template database: vitest.int.config.ts must use @velexis/testing/vitest-global-setup",
    );
  }
  return runIdOfTemplate(template);
}

/**
 * A new empty database prepared like deploy/postgres/bootstrap.sql: owned by velexis_migrator, the database grants,
 * then schemas.sql as velexis_migrator (closed `public`, `platform` and `reference`, USAGE, default privileges).
 */
async function createEmptyDatabase(): Promise<string> {
  const name = `${TEST_DATABASE_PREFIX}${runId()}_${randomBytes(6).toString("hex")}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unexpected database name ${name}`);
  }
  await withPool(adminUrl, async (admin) => {
    await admin.query(
      `CREATE DATABASE "${name}" OWNER velexis_migrator ENCODING 'UTF8' ` +
        "LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0",
    );
    for (const statement of databaseGrantStatements(name)) {
      await admin.query(statement);
    }
  });
  const schemasSql = await readFile(SCHEMAS_SQL, "utf8");
  await withPool(databaseUrl(adminUrl, name, TEST_ROLES.migrator), (migrator) => migrator.query(schemasSql));
  return name;
}

/** The ledger of the platform set: id, phase, status, checksum and the transaction id that wrote the row. */
async function ledger(db: Pool): Promise<Row[]> {
  return (
    await db.query(
      "SELECT id, phase, status, checksum, xmin::text AS xid FROM platform.schema_migrations ORDER BY id",
    )
  ).rows;
}

async function platformTables(db: Pool): Promise<string[]> {
  const { rows } = await db.query<{ table: string }>(
    "SELECT tablename AS table FROM pg_tables WHERE schemaname = 'platform' ORDER BY tablename",
  );
  return rows.map((row) => row.table);
}

/** The constraints and indexes 0002 adds to baseline tables (it also re-creates subscriptions_current_uq). */
const NEW_CONSTRAINTS = [
  "account_sessions_family_expiry_ck",
  "payment_provider_connections_mode_ck",
  "provisioning_jobs_reveal_ck",
  "subscriptions_status_ck",
  "supplier_connections_account_fk",
  "supplier_connections_source_ck",
  "tenant_domains_custom_token_ck",
  "tenants_key_dns_ck",
  "tenants_live_ck",
  "tenants_suspension_reason_ck",
];
const NEW_INDEXES = [
  "payment_provider_connections_connect_uq",
  "plans_stripe_price_month_uq",
  "plans_stripe_price_year_uq",
  "platform_audit_log_target_idx",
  "provisioning_jobs_reveal_idx",
  "provisioning_jobs_running_idx",
  "subscriptions_current_uq",
  "supplier_connections_account_idx",
  "tenant_domains_pending_idx",
  "tenant_domains_tenant_idx",
];

/**
 * The transaction ids (xmin) of what 0002 creates: the catalog rows of its 11 tables, of the constraints and indexes
 * it adds to baseline tables, and the seeded `early_access` plan, with the number of rows found of each kind. Nothing
 * after 0002 rewrites these rows (R__ota_read_access grants on baseline tables only), so one id means one transaction.
 */
async function migrationXids(
  db: Pool,
): Promise<{ xids: string[]; tables: number; constraints: number; indexes: number; seed: number }> {
  const { rows } = await db.query<{ kind: string; xid: string }>(
    "SELECT 'table' AS kind, xmin::text AS xid FROM pg_class WHERE relnamespace = 'platform'::regnamespace " +
      "AND relkind = 'r' AND relname = ANY($1::text[]) " +
      "UNION ALL SELECT 'constraint', xmin::text FROM pg_constraint WHERE connamespace = 'platform'::regnamespace " +
      "AND conname = ANY($2::text[]) " +
      "UNION ALL SELECT 'index', xmin::text FROM pg_class WHERE relnamespace = 'platform'::regnamespace " +
      "AND relkind = 'i' AND relname = ANY($3::text[]) " +
      "UNION ALL SELECT 'seed', xmin::text FROM platform.plans WHERE code = 'early_access'",
    [NEW_TABLES, NEW_CONSTRAINTS, NEW_INDEXES],
  );
  const count = (kind: string): number => rows.filter((row) => row.kind === kind).length;
  return {
    xids: [...new Set(rows.map((row) => row.xid))],
    tables: count("table"),
    constraints: count("constraint"),
    indexes: count("index"),
    seed: count("seed"),
  };
}

/** Asserts that 0002 was one transaction: everything it created and its ledger row, not the baseline's. */
async function expectOneTransaction(db: Pool): Promise<void> {
  const rows = await ledger(db);
  const baselineXid = rows.find((row) => row["id"] === BASELINE_ID)?.["xid"];
  const migrationXid = rows.find((row) => row["id"] === MIGRATION_ID)?.["xid"];
  expect(migrationXid).toEqual(expect.any(String));
  expect(migrationXid).not.toBe(baselineXid);
  expect(await migrationXids(db)).toEqual({
    xids: [migrationXid],
    tables: NEW_TABLES.length,
    constraints: NEW_CONSTRAINTS.length,
    indexes: NEW_INDEXES.length,
    seed: 1,
  });
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("migration 0002 from scratch", () => {
  let clone: TestDatabase;
  let migrator: Pool;

  beforeAll(async () => {
    clone = await createTestDatabase();
    migrator = pool(clone.urlFor("migrator"));
  });

  afterAll(async () => {
    await migrator?.end();
    await clone?.drop();
  });

  it("is in the ledger of the template database as 0002_add_mvp_platform_deltas, phase expand [PBE-002 AC2]", async () => {
    const rows = await ledger(migrator);
    expect(rows.map(({ id, phase, status }) => ({ id, phase, status }))).toEqual([
      { id: BASELINE_ID, phase: "expand", status: "applied" },
      { id: MIGRATION_ID, phase: "expand", status: "applied" },
      { id: "R__ota_read_access", phase: "repeatable", status: "applied" },
    ]);
    expect(rows[1]?.["checksum"]).toBe(await sha256(join(PLATFORM_MIGRATIONS, `${MIGRATION_ID}.sql`)));
  });

  it("has the 16 baseline tables and the 11 new tables [PBE-002 AC2]", async () => {
    expect(NEW_TABLES).toHaveLength(11);
    expect(BASELINE_TABLES).toHaveLength(16);
    expect(await platformTables(migrator)).toEqual(
      sorted([...BASELINE_TABLES, ...NEW_TABLES, "schema_migrations"]),
    );
    // Seeded by 0002: tenants.plan_code is NOT NULL, so M1 tenants need a plan before paid plans exist.
    const { rows } = await migrator.query(
      "SELECT code, monthly_price, trial_days, settlement_fee_bps, is_public, is_active, limits " +
        "FROM platform.plans ORDER BY code",
    );
    expect(rows).toEqual([
      {
        code: "early_access",
        monthly_price: "0.00",
        trial_days: 90,
        settlement_fee_bps: 0,
        is_public: true,
        is_active: true,
        limits: { staffSeats: 5, apiKeys: 10, customDomains: 0, liveMode: false },
      },
    ]);
  });

  it("was applied in one transaction: what it creates and its ledger row share one transaction id [PBE-002 AC2]", async () => {
    await expectOneTransaction(migrator);
  });
});

describe("migration 0002 as an upgrade from 0001", () => {
  let name: string | undefined;
  let baselineDir: string | undefined;
  let baselineRun: RunMigrationsResult;
  let upgradeRun: RunMigrationsResult;
  let migrator: Pool;
  let platformApp: Pool;
  /** The tenant and subscription rows as velexis_platform_app read them at version 0001. */
  let before: { tenant: Row; subscription: Row; tablesAt0001: string[] };

  beforeAll(async () => {
    name = await createEmptyDatabase();
    migrator = pool(databaseUrl(adminUrl, name, TEST_ROLES.migrator));
    platformApp = pool(databaseUrl(adminUrl, name, TEST_ROLES.platform));

    // Version 0001: the runner on a folder holding only the baseline.
    baselineDir = await mkdtemp(join(tmpdir(), "velexis-pbe002-0001-"));
    await copyFile(join(PLATFORM_MIGRATIONS, `${BASELINE_ID}.sql`), join(baselineDir, `${BASELINE_ID}.sql`));
    baselineRun = await runMigrations({
      set: "platform",
      dir: baselineDir,
      url: databaseUrl(adminUrl, name, TEST_ROLES.migrator),
    });

    // Data written by the platform role at version 0001: a plan, a tenant with a valid key, a subscription.
    await platformApp.query("INSERT INTO platform.plans (code, name) VALUES ($1, $2)", [
      PLAN.code,
      PLAN.name,
    ]);
    await platformApp.query(
      "INSERT INTO platform.tenants (id, key, name, plan_code) VALUES ($1, $2, $3, $4)",
      [TENANT.id, TENANT.key, TENANT.name, TENANT.plan_code],
    );
    await platformApp.query(
      "INSERT INTO platform.subscriptions (id, tenant_id, plan_code, status, billing_provider, trial_ends_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6)",
      [
        SUBSCRIPTION.id,
        SUBSCRIPTION.tenant_id,
        SUBSCRIPTION.plan_code,
        SUBSCRIPTION.status,
        SUBSCRIPTION.billing_provider,
        SUBSCRIPTION.trial_ends_at,
      ],
    );
    const tenant = (await platformApp.query("SELECT * FROM platform.tenants")).rows;
    const subscription = (await platformApp.query("SELECT * FROM platform.subscriptions")).rows;
    expect(tenant).toHaveLength(1);
    expect(subscription).toHaveLength(1);
    before = {
      tenant: tenant[0] as Row,
      subscription: subscription[0] as Row,
      tablesAt0001: await platformTables(migrator),
    };

    // The upgrade: the runner on the real folder.
    upgradeRun = await runMigrations({
      set: "platform",
      dir: PLATFORM_MIGRATIONS,
      url: databaseUrl(adminUrl, name, TEST_ROLES.migrator),
    });
  });

  afterAll(async () => {
    await Promise.all([migrator?.end(), platformApp?.end()]);
    if (baselineDir !== undefined) {
      await rm(baselineDir, { recursive: true, force: true });
    }
    if (name !== undefined) {
      await dropDatabase(adminUrl, name);
    }
  });

  it("starts at version 0001: the baseline only [PBE-002 AC2]", () => {
    expect(baselineRun.applied.map((event) => event.id)).toEqual([BASELINE_ID]);
    expect(before.tablesAt0001).toEqual(sorted([...BASELINE_TABLES, "schema_migrations"]));
  });

  it("applies 0002 (expand, in a transaction) and the repeatable grants on top of 0001 [PBE-002 AC2]", async () => {
    expect(
      upgradeRun.applied.map(({ id, phase, status, transaction }) => ({ id, phase, status, transaction })),
    ).toEqual([
      { id: MIGRATION_ID, phase: "expand", status: "applied", transaction: true },
      { id: "R__ota_read_access", phase: "repeatable", status: "applied", transaction: true },
    ]);
    expect(upgradeRun.upToDate).toBe(1);
    expect(upgradeRun.ledgerOnly).toEqual([]);
    expect((await ledger(migrator)).map((row) => [row["id"], row["phase"], row["status"]])).toEqual([
      [BASELINE_ID, "expand", "applied"],
      [MIGRATION_ID, "expand", "applied"],
      ["R__ota_read_access", "repeatable", "applied"],
    ]);
    expect(await platformTables(migrator)).toEqual(
      sorted([...BASELINE_TABLES, ...NEW_TABLES, "schema_migrations"]),
    );
  });

  it("was applied in one transaction: what it creates and its ledger row share one transaction id [PBE-002 AC2]", async () => {
    await expectOneTransaction(migrator);
  });

  it("keeps the tenant and the subscription written at 0001, with the new columns at their defaults [PBE-002 AC2]", async () => {
    const tenants = (await platformApp.query("SELECT * FROM platform.tenants")).rows;
    expect(tenants).toEqual([
      {
        ...before.tenant,
        storefront_environment: "test",
        live_enabled_at: null,
        live_enabled_by_account_id: null,
        billing_notice: null,
      },
    ]);
    const subscriptions = (await platformApp.query("SELECT * FROM platform.subscriptions")).rows;
    expect(subscriptions).toEqual([
      {
        ...before.subscription,
        provider_price_id: null,
        checkout_session_id: null,
        provider_synced_at: null,
      },
    ]);
    expect(before.tenant).toMatchObject({ key: TENANT.key, schema_name: `tenant_${TENANT.key}` });
    expect(before.subscription).toMatchObject({
      status: SUBSCRIPTION.status,
      trial_ends_at: SUBSCRIPTION.trial_ends_at,
    });
    // The plan written at 0001 gets the defaults of the new plan columns; 0002 adds early_access next to it.
    const plans = (
      await platformApp.query(
        "SELECT code, trial_days, settlement_fee_bps, stripe_price_id_month FROM platform.plans ORDER BY code",
      )
    ).rows;
    expect(plans).toEqual([
      { code: "early_access", trial_days: 90, settlement_fee_bps: 0, stripe_price_id_month: null },
      { code: PLAN.code, trial_days: 14, settlement_fee_bps: 0, stripe_price_id_month: null },
    ]);
  });

  it("applies nothing on a second run [PBE-002 AC2]", async () => {
    if (name === undefined) {
      throw new Error("beforeAll did not create the database");
    }
    const again = await runMigrations({
      set: "platform",
      dir: PLATFORM_MIGRATIONS,
      url: databaseUrl(adminUrl, name, TEST_ROLES.migrator),
    });
    expect(again.applied).toEqual([]);
    expect(again.upToDate).toBe(3);
  });
});
