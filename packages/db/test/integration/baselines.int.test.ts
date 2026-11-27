// The baseline migrations and the OTA read grants on PostgreSQL 16 (X-012; ADR-0004 Database roles, ADR-0005
// Baselines, ADR-0021).
//
// One fresh database `velexis_dbtest_<random>` for this file, created as TEST_DATABASE_ADMIN_URL and bootstrapped
// like deploy/postgres/bootstrap.sql: its database section needs psql variables and superuser rights, so it is
// mirrored below; the statements after `\connect :db_name` (base schemas, USAGE, default privileges) are read
// from bootstrap.sql itself and run as velexis_migrator. Then, in beforeAll:
//   - the platform and reference sets are applied as `pnpm db:migrate` applies them: the commands of the
//     `migrate` script of packages/db/package.json, through runMigrateCli, as velexis_migrator. The platform folder
//     also holds 0002_add_mvp_platform_deltas.sql (PBE-002), so its 11 tables and its two OTA grants
//     (amadeus_accounts, amadeus_offices) are expected next to the baseline's, and
//     0003_add_billing_customer_attempts.sql (FIX-W29-PLATFORM), one table the OTA role may not read,
//     0004_add_plan_price_warnings.sql (FIX-W42-PLATFORM), one column of plans and no table, and
//     0005_add_supplier_registry.sql (PBE-078), the four tables of the supply registry, of which the OTA role may
//     read listed columns of three and nothing of suppliers;
//   - the tenant set is applied to tenant_alpha through the runner library (readMigrationFiles, recordMigration)
//     in one provisioning transaction as velexis_provisioner (db README §3; migrateTenantSchema of X-013 replaces
//     this helper). The tenant folder also holds 0002_add_mvp_tenant_deltas.sql (OBE-008), so its 2 tables are
//     expected next to the baseline's;
//   - velexis_platform_app adds a plan, an account, a tenant, and a supply source with a stop and its supply id.
// The tests compare the privileges of velexis_ota_app and velexis_platform_app with ADR-0004 in the catalog and
// with real queries, logged in as those roles with the development DSNs of ota/backend/.env.example and
// platform/backend/.env.example (dummy values that deploy/scripts/dev-setup.sh and the CI bootstrap set).
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrateCli } from "../../src/cli/migrate.js";
import {
  MIGRATION_LOCK_TIMEOUT,
  MIGRATION_STATEMENT_TIMEOUT,
  readMigrationFiles,
  recordMigration,
  splitSqlStatements,
  type MigrationFileEvent,
} from "../../src/migrate/index.js";
import { assertTenantSchema } from "../../src/tenant-schema.js";

const PACKAGE_DIR = resolve(__dirname, "..", "..");
const REPO = resolve(PACKAGE_DIR, "..", "..");
const REFERENCE_DDL = join(REPO, "docs", "velexis-sdk", "db");
const TENANT_DIR = join(REPO, "ota", "backend", "migrations", "tenant");
const TENANT = "tenant_alpha";

/** ADR-0004: the platform tables velexis_ota_app may read in full. */
const OTA_READABLE_TABLES = [
  "api_key_tenant_grants",
  "api_keys",
  "payment_provider_connections",
  "plans",
  "supplier_connections",
  "tenant_domains",
  "tenant_memberships",
  "tenants",
];
/**
 * What migration 0002 (PBE-002) changes here: the tables it creates (platform/docs/data-model.md §3), the two of them
 * it grants to velexis_ota_app itself (the rest of ADR-0004's list, "the shared Amadeus account tables of ADR-0012";
 * data-model.md §4.8), and the append-only audit log.
 */
const MIGRATION_0002 = {
  file: "0002_add_mvp_platform_deltas.sql",
  tables: [
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
  ],
  otaReadableTables: ["amadeus_accounts", "amadeus_offices"],
  /** Tables on which 0002 revokes UPDATE, DELETE and TRUNCATE from velexis_platform_app (data-model.md §4.7). */
  appendOnlyTables: ["platform_audit_log"],
};
/** Platform migration 0003 (FIX-W29-PLATFORM): one table, not granted to velexis_ota_app. */
const MIGRATION_0003 = {
  file: "0003_add_billing_customer_attempts.sql",
  tables: ["billing_customer_attempts"],
};
/** Platform migration 0004 (FIX-W42-PLATFORM): one column of `plans` (`price_warnings`), no table. */
const MIGRATION_0004 = {
  file: "0004_add_plan_price_warnings.sql",
};
/**
 * Platform migration 0005 (PBE-078): the four tables of the supply registry (platform/docs/data-model.md §4.11). The
 * OTA role reads, column by column, what the OTA backend's resolver needs (OBE-146), in table order, and nothing else
 * of them: not who set a stop, when or why, no row version or time, and nothing of `suppliers`. The two columns 0005
 * adds to supplier_connections and the one it adds to amadeus_accounts fall under the table-level SELECT of those
 * tables (R__ota_read_access.sql and 0002).
 */
const MIGRATION_0005 = {
  file: "0005_add_supplier_registry.sql",
  tables: ["supplier_environments", "suppliers", "supply_source_ids", "supply_sources"],
  otaReadableColumns: {
    supplier_environments: ["supplier_id", "environment", "sales_enabled"],
    supply_source_ids: ["supply_id", "supply_source_id", "retired_at"],
    supply_sources: ["id", "supplier_id", "environment", "credential_source", "tenant_id", "sales_stop"],
  } as Record<string, string[]>,
  otaDeniedColumns: {
    supplier_environments: ["version", "created_at", "updated_at"],
    supply_source_ids: ["issued_at"],
    supply_sources: [
      "sales_stop_at",
      "sales_stop_reason",
      "sales_stop_by_account_id",
      "version",
      "created_at",
      "updated_at",
    ],
  } as Record<string, string[]>,
  otaDeniedTables: ["suppliers"],
};
/** The supply source and supply id velexis_platform_app writes in beforeAll: a Velexis PKFare source stopped by staff. */
const SOURCE = {
  id: "ssr_01J9ZK3V5Q8X2M4N6P7R9S1T5Z",
  supplyId: "sup_7KQ2M9XW3HT6PBNC",
  reason: "Paused for the pilot",
};
/** What tenant migration 0002 (OBE-008, ota/docs/data-model-migration-0002.md) adds after the tenant baseline. */
const TENANT_MIGRATION_0002 = {
  id: "0002_add_mvp_tenant_deltas",
  file: "0002_add_mvp_tenant_deltas.sql",
  tables: ["storefront_assets", "storefront_pages"],
};
/** Tenant migration 0003 (FIX-W27-SYNC): two columns of `bookings`, no table. */
const TENANT_MIGRATION_0003 = {
  id: "0003_add_booking_sync_claim",
  file: "0003_add_booking_sync_claim.sql",
};
/** Tenant migration 0004 (FIX-W28-CANCEL): one column of `payments`, no table. */
const TENANT_MIGRATION_0004 = {
  id: "0004_add_payment_card_fee_lines",
  file: "0004_add_payment_card_fee_lines.sql",
};
/** Tenant migration 0005 (FIX-W31-OTA): one column of `bookings` and two CHECKs replaced, no table. */
const TENANT_MIGRATION_0005 = {
  id: "0005_add_cancellation_claim_tighten_calling_codes",
  file: "0005_add_cancellation_claim_tighten_calling_codes.sql",
};
/** ADR-0004: the only platform.accounts columns velexis_ota_app may read, in table order. */
const OTA_READABLE_ACCOUNT_COLUMNS = [
  "id",
  "email",
  "email_verified_at",
  "full_name",
  "locale",
  "time_zone",
  "mfa_enabled",
  "status",
  "deleted_at",
  "version",
];
/** ADR-0004, ADR-0021: secrets, hashes and security counters of platform.accounts, never granted. */
const NEVER_GRANTED_ACCOUNT_COLUMNS = [
  "password_hash",
  "mfa_secret_ciphertext",
  "encryption_key_id",
  "failed_login_count",
  "locked_until",
  "is_platform_admin",
];
/** Platform tables the OTA backend must not read (X-012 AC4). */
const OTA_DENIED_TABLES = [
  "subscriptions",
  "invoices",
  "account_sessions",
  "provisioning_jobs",
  "platform_audit_log",
];
/** Every table privilege PostgreSQL knows. */
const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

const ACCOUNT = {
  id: "acc_01J9ZK3V5Q8X2M4N6P7R9S1T2W",
  email: "owner@example.com",
  full_name: "Ada Owner",
};

function testUrls(): { admin: string; migrator: string } {
  loadDevEnvFiles({ appDir: PACKAGE_DIR });
  const postgres = { protocols: ["postgres:", "postgresql:"] };
  const config = defineConfig({
    TEST_DATABASE_ADMIN_URL: env.url(postgres),
    DATABASE_MIGRATOR_URL: env.url(postgres),
  });
  return { admin: config.TEST_DATABASE_ADMIN_URL, migrator: config.DATABASE_MIGRATOR_URL };
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * The DSN of an app role on `database`: user and development password from `<component>/backend/.env.example`
 * (DATABASE_URL), host and port from TEST_DATABASE_ADMIN_URL. Never printed.
 */
async function appRoleUrl(
  component: "platform" | "ota",
  role: string,
  admin: string,
  database: string,
): Promise<string> {
  const example = await readFile(join(REPO, component, "backend", ".env.example"), "utf8");
  const value = /^DATABASE_URL=(\S+)$/m.exec(example)?.[1];
  if (value === undefined) {
    throw new Error(`${component}/backend/.env.example has no DATABASE_URL line`);
  }
  const dsn = new URL(value);
  if (dsn.username !== role) {
    throw new Error(`${component}/backend/.env.example: DATABASE_URL is not the role ${role}`);
  }
  const url = new URL(withDatabase(admin, database));
  url.username = dsn.username;
  url.password = dsn.password;
  return url.toString();
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, application_name: "velexis-db-int-test" });
  await client.connect();
  return client;
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connect(url);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** The statements of bootstrap.sql that run inside the database (after `\connect :db_name`). */
async function bootstrapDatabaseStatements(): Promise<string[]> {
  const script = await readFile(join(REPO, "deploy", "postgres", "bootstrap.sql"), "utf8");
  const connect = /^\\connect :db_name[ \t]*$/m.exec(script);
  if (connect === null) {
    throw new Error("deploy/postgres/bootstrap.sql has no \\connect :db_name line");
  }
  const rest = script.slice(connect.index + connect[0].length);
  // Plain SQL only: a psql meta-command or variable would need psql, and this test would no longer mirror it.
  if (/^\s*\\/m.test(rest) || /:'?[a-z_]+'?/i.test(rest.replace(/--.*$/gm, "").replace(/::/g, ""))) {
    throw new Error("bootstrap.sql after \\connect is no longer plain SQL; update baselines.int.test.ts");
  }
  return splitSqlStatements(rest);
}

/**
 * Applies the tenant set to the new schema `tenant` in one transaction, the way provisioning does it (db README
 * §3, ADR-0021): as velexis_provisioner, schema and files together, then the grants of velexis_ota_app.
 */
async function provisionTenantSchema(migratorUrl: string, tenant: string): Promise<void> {
  assertTenantSchema(tenant);
  const identifier = pg.escapeIdentifier(tenant);
  const files = await readMigrationFiles(TENANT_DIR, "tenant");
  await withClient(migratorUrl, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
      await client.query(`SET LOCAL statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
      await client.query("SET LOCAL ROLE velexis_provisioner");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [tenant]);
      await client.query(`CREATE SCHEMA ${identifier} AUTHORIZATION velexis_provisioner`);
      await client.query("SELECT set_config('search_path', $1, true)", [`${tenant}, reference`]);
      for (const file of files.numbered) {
        if (file.noTransaction) {
          throw new Error(`${file.file}: no-transaction tenant files need migrateTenantSchema (X-013)`);
        }
        const start = performance.now();
        await client.query(file.sql);
        await recordMigration(client, tenant, file, Math.round(performance.now() - start));
      }
      await client.query(`GRANT USAGE ON SCHEMA ${identifier} TO velexis_ota_app`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${identifier} TO velexis_ota_app`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE velexis_provisioner IN SCHEMA ${identifier} ` +
          "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velexis_ota_app",
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

interface CliRun {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly events: MigrationFileEvent[];
}

/**
 * `pnpm db:migrate`: the `&&`-joined `node dist/cli/migrate.js …` commands of the `migrate` script, run in
 * packages/db (so the relative --dir paths resolve as in the script) with DATABASE_MIGRATOR_URL on `url`.
 */
async function dbMigrate(url: string): Promise<CliRun[]> {
  const pkg = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const runs: CliRun[] = [];
  for (const command of (pkg.scripts["migrate"] ?? "").split("&&")) {
    const [node, script, ...argv] = command.trim().split(/\s+/);
    if (node !== "node" || script !== "dist/cli/migrate.js") {
      throw new Error(`unexpected command in the migrate script: ${command.trim()}`);
    }
    let stdout = "";
    let stderr = "";
    const code = await runMigrateCli(argv, {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
      env: { APP_ENV: "test", DATABASE_MIGRATOR_URL: url },
      cwd: PACKAGE_DIR,
    });
    const events = stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as MigrationFileEvent);
    runs.push({ argv, code, stdout, stderr, events });
    if (code !== 0) {
      break;
    }
  }
  return runs;
}

let databaseName = "";
let adminUrl = "";
let migratorUrl = "";
let dropDatabase: (() => Promise<void>) | undefined;
/** velexis_test_admin (member of velexis_migrator) on the fresh database: catalog queries. */
let admin: pg.Client | undefined;
/** velexis_ota_app (role default search_path = pg_catalog). */
let ota: pg.Client | undefined;
/** velexis_platform_app. */
let platformApp: pg.Client | undefined;
/** The first `pnpm db:migrate` on the fresh database. */
let firstMigrate: CliRun[] = [];

const clients = () => {
  if (admin === undefined || ota === undefined || platformApp === undefined) {
    throw new Error("beforeAll did not finish");
  }
  return { admin, ota, platformApp };
};

beforeAll(async () => {
  const urls = testUrls();
  databaseName = `velexis_dbtest_${randomBytes(6).toString("hex")}`;
  const database = pg.escapeIdentifier(databaseName);
  // The database section of bootstrap.sql (psql variables there): owner, encoding and database grants.
  await withClient(urls.admin, async (client) => {
    await client.query(
      `CREATE DATABASE ${database} OWNER velexis_migrator ENCODING 'UTF8' ` +
        `LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0`,
    );
  });
  dropDatabase = () =>
    withClient(
      urls.admin,
      async (client) => void (await client.query(`DROP DATABASE IF EXISTS ${database}`)),
    );
  await withClient(urls.admin, async (client) => {
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO velexis_platform_app, velexis_ota_app`,
    );
    await client.query(`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${database} TO velexis_provisioner`);
    await client.query(`GRANT ALL ON DATABASE ${database} TO velexis_migrator`);
  });
  adminUrl = withDatabase(urls.admin, databaseName);
  migratorUrl = withDatabase(urls.migrator, databaseName);

  // The rest of bootstrap.sql, statement by statement, as the migrator that owns the database.
  const statements = await bootstrapDatabaseStatements();
  await withClient(adminUrl, async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE velexis_migrator");
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  });

  firstMigrate = await dbMigrate(migratorUrl);
  if (firstMigrate.some((run) => run.code !== 0)) {
    throw new Error(`pnpm db:migrate failed: ${firstMigrate.map((run) => run.stderr).join("")}`);
  }
  await provisionTenantSchema(migratorUrl, TENANT);

  admin = await connect(adminUrl);
  ota = await connect(await appRoleUrl("ota", "velexis_ota_app", urls.admin, databaseName));
  platformApp = await connect(await appRoleUrl("platform", "velexis_platform_app", urls.admin, databaseName));

  await platformApp.query("INSERT INTO platform.plans (code, name) VALUES ('starter', 'Starter')");
  await platformApp.query(
    "INSERT INTO platform.accounts (id, email, full_name, status, email_verified_at) " +
      "VALUES ($1, $2, $3, 'active', now())",
    [ACCOUNT.id, ACCOUNT.email, ACCOUNT.full_name],
  );
  await platformApp.query(
    "INSERT INTO platform.tenants (id, key, name, plan_code) VALUES ('ten_01J9ZK3V5Q8X2M4N6P7R9S1T3X', 'alpha', 'Alpha Travel', 'starter')",
  );
  await platformApp.query(
    "INSERT INTO platform.supply_sources (id, supplier_id, environment, credential_source, sales_stop, " +
      "sales_stop_at, sales_stop_reason, sales_stop_by_account_id) " +
      "VALUES ($1, 'pkfare', 'test', 'velexis', 'staff', now(), $2, $3)",
    [SOURCE.id, SOURCE.reason, ACCOUNT.id],
  );
  await platformApp.query(
    "INSERT INTO platform.supply_source_ids (supply_id, supply_source_id) VALUES ($1, $2)",
    [SOURCE.supplyId, SOURCE.id],
  );
});

afterAll(async () => {
  const open = [admin, ota, platformApp].filter((client): client is pg.Client => client !== undefined);
  await Promise.all(open.map((client) => client.end().catch(() => undefined)));
  await dropDatabase?.();
});

/** Rows of a catalog query as velexis_test_admin. */
async function catalog<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<R[]> {
  return (await clients().admin.query<R>(text, values)).rows;
}

async function tablesOf(schema: string): Promise<string[]> {
  const rows = await catalog<{ table: string }>(
    "SELECT tablename AS table FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
    [schema],
  );
  return rows.map((row) => row.table);
}

/** The tables a DDL file creates, sorted (without the schema prefix). */
function createdTables(ddl: string): string[] {
  return [...ddl.matchAll(/^CREATE TABLE (?:[a-z]+\.)?([a-z_]+) \(/gm)].map((match) => match[1] ?? "").sort();
}

/** The tables a reference DDL file creates, sorted (without the schema prefix). */
async function ddlTables(file: string): Promise<string[]> {
  return createdTables(await readFile(join(REFERENCE_DDL, file), "utf8"));
}

const denied = (table: string) => ({ code: "42501", message: `permission denied for table ${table}` });

describe("the baselines and the OTA read grants on PostgreSQL", () => {
  it("applies the platform and reference baselines: 16 and 7 tables, each set with its ledger [X-012 AC1]", async () => {
    const platformTables = await ddlTables("platform.sql");
    const referenceTables = await ddlTables("reference.sql");
    expect(platformTables).toHaveLength(16);
    expect(referenceTables).toHaveLength(7);
    // The platform set continues with 0002 (PBE-002), which creates 11 more tables, 0003 (FIX-W29-PLATFORM), one, and
    // 0004 (FIX-W42-PLATFORM), none.
    const migrationTables = createdTables(
      await readFile(join(REPO, "platform/backend/migrations/platform", MIGRATION_0002.file), "utf8"),
    );
    expect(migrationTables).toEqual(MIGRATION_0002.tables);
    const migration0003Tables = createdTables(
      await readFile(join(REPO, "platform/backend/migrations/platform", MIGRATION_0003.file), "utf8"),
    );
    expect(migration0003Tables).toEqual(MIGRATION_0003.tables);
    expect(
      createdTables(
        await readFile(join(REPO, "platform/backend/migrations/platform", MIGRATION_0004.file), "utf8"),
      ),
    ).toEqual([]);
    // 0005 (PBE-078) creates the four tables of the supply registry.
    const migration0005Tables = createdTables(
      await readFile(join(REPO, "platform/backend/migrations/platform", MIGRATION_0005.file), "utf8"),
    );
    expect(migration0005Tables).toEqual(MIGRATION_0005.tables);
    expect(await tablesOf("platform")).toEqual(
      [
        ...platformTables,
        ...migrationTables,
        ...migration0003Tables,
        ...migration0005Tables,
        "schema_migrations",
      ].sort(),
    );
    expect(await tablesOf("reference")).toEqual([...referenceTables, "schema_migrations"].sort());

    for (const set of ["platform", "reference"] as const) {
      const ledger = await catalog<{ id: string; checksum: string; phase: string; status: string }>(
        `SELECT id, checksum, phase, status FROM ${set}.schema_migrations WHERE id = '0001_baseline'`,
      );
      expect(ledger).toEqual([
        {
          id: "0001_baseline",
          checksum: await sha256(join(REFERENCE_DDL, `${set}.sql`)),
          phase: "expand",
          status: "applied",
        },
      ]);
    }
    const [repeatable] = await catalog<{ checksum: string; phase: string }>(
      "SELECT checksum, phase FROM platform.schema_migrations WHERE id = 'R__ota_read_access'",
    );
    expect(repeatable).toEqual({
      checksum: await sha256(join(REPO, "platform/backend/migrations/platform/R__ota_read_access.sql")),
      phase: "repeatable",
    });
    // The migrator owns every table, so bootstrap.sql's default privileges reached them.
    expect(
      await catalog(
        "SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname IN ('platform', 'reference')",
      ),
    ).toEqual([{ owner: "velexis_migrator" }]);
  });

  it("applies the tenant set to tenant_alpha through the runner library: the baseline's 42 tables and those of 0002, owned by velexis_provisioner [X-012 AC1]", async () => {
    const tenantTables = await ddlTables("tenant.sql");
    expect(tenantTables).toHaveLength(42);
    expect(tenantTables).toContain("schema_migrations");
    // The tenant set continues with 0002 (OBE-008), which creates 2 more tables.
    const migrationTables = createdTables(
      await readFile(join(TENANT_DIR, TENANT_MIGRATION_0002.file), "utf8"),
    );
    expect(migrationTables).toEqual(TENANT_MIGRATION_0002.tables);
    expect(await tablesOf(TENANT)).toEqual([...tenantTables, ...migrationTables].sort());

    expect(
      await catalog(
        `SELECT id, checksum, phase, status FROM ${pg.escapeIdentifier(TENANT)}.schema_migrations ORDER BY id`,
      ),
    ).toEqual([
      {
        id: "0001_baseline",
        checksum: await sha256(join(REFERENCE_DDL, "tenant.sql")),
        phase: "expand",
        status: "applied",
      },
      {
        id: TENANT_MIGRATION_0002.id,
        checksum: await sha256(join(TENANT_DIR, TENANT_MIGRATION_0002.file)),
        phase: "expand",
        status: "applied",
      },
      {
        id: TENANT_MIGRATION_0003.id,
        checksum: await sha256(join(TENANT_DIR, TENANT_MIGRATION_0003.file)),
        phase: "expand",
        status: "applied",
      },
      {
        id: TENANT_MIGRATION_0004.id,
        checksum: await sha256(join(TENANT_DIR, TENANT_MIGRATION_0004.file)),
        phase: "expand",
        status: "applied",
      },
      {
        id: TENANT_MIGRATION_0005.id,
        checksum: await sha256(join(TENANT_DIR, TENANT_MIGRATION_0005.file)),
        phase: "contract",
        status: "applied",
      },
    ]);
    expect(
      await catalog(
        "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = $1 UNION " +
          "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = $1",
        [TENANT],
      ),
    ).toEqual([{ owner: "velexis_provisioner" }]);

    // The OTA role works in the schema through tenantTx's search_path; here schema-qualified, for the check only.
    const { ota } = clients();
    await ota.query("BEGIN");
    try {
      await ota.query(
        `INSERT INTO ${pg.escapeIdentifier(TENANT)}.customers (id, email, first_name, last_name) ` +
          "VALUES ('cus_01J9ZK3V5Q8X2M4N6P7R9S1T4Y', 'traveller@example.com', 'Tia', 'Traveller')",
      );
      const { rows } = await ota.query(`SELECT id FROM ${pg.escapeIdentifier(TENANT)}.customers`);
      expect(rows).toEqual([{ id: "cus_01J9ZK3V5Q8X2M4N6P7R9S1T4Y" }]);
    } finally {
      await ota.query("ROLLBACK");
    }
  });

  it("lets velexis_ota_app select the eight platform tables of ADR-0004 and the listed accounts columns [X-012 AC2]", async () => {
    const { ota } = clients();
    for (const table of OTA_READABLE_TABLES) {
      await expect(ota.query(`SELECT * FROM platform.${table}`)).resolves.toBeDefined();
    }
    // `early_access` is the plan migration 0002 seeds (PBE-002); `starter` was added in beforeAll.
    const { rows: plans } = await ota.query("SELECT code FROM platform.plans ORDER BY code");
    expect(plans).toEqual([{ code: "early_access" }, { code: "starter" }]);
    const { rows: tenants } = await ota.query("SELECT key, schema_name, status FROM platform.tenants");
    expect(tenants).toEqual([{ key: "alpha", schema_name: TENANT, status: "provisioning" }]);

    const { rows: accounts } = await ota.query(
      `SELECT ${OTA_READABLE_ACCOUNT_COLUMNS.join(", ")} FROM platform.accounts`,
    );
    expect(accounts).toEqual([
      {
        ...ACCOUNT,
        email_verified_at: expect.any(Date),
        locale: "en",
        time_zone: "UTC",
        mfa_enabled: false,
        status: "active",
        deleted_at: null,
        version: 1,
      },
    ]);
  });

  it("gives velexis_ota_app exactly the platform privileges of ADR-0004 and nothing else [X-012 AC2]", async () => {
    const tableGrants = await catalog(
      "SELECT c.relname AS table, a.privilege_type AS privilege FROM pg_class c " +
        "CROSS JOIN LATERAL aclexplode(c.relacl) a " +
        "WHERE c.relnamespace = 'platform'::regnamespace AND a.grantee = 'velexis_ota_app'::regrole ORDER BY 1, 2",
    );
    // ADR-0004's list: the eight baseline tables of R__ota_read_access.sql, and the shared Amadeus account tables of
    // ADR-0012, which migration 0002 grants itself.
    expect(tableGrants).toEqual(
      [...OTA_READABLE_TABLES, ...MIGRATION_0002.otaReadableTables]
        .sort()
        .map((table) => ({ table, privilege: "SELECT" })),
    );

    // Column by column: the accounts columns of R__ota_read_access.sql and the registry columns that 0005 grants.
    const columnGrants = await catalog(
      "SELECT c.relname AS table, att.attname AS column, a.privilege_type AS privilege FROM pg_attribute att " +
        "JOIN pg_class c ON c.oid = att.attrelid CROSS JOIN LATERAL aclexplode(att.attacl) a " +
        "WHERE c.relnamespace = 'platform'::regnamespace AND a.grantee = 'velexis_ota_app'::regrole " +
        "ORDER BY c.relname, att.attnum",
    );
    expect(columnGrants).toEqual(
      [
        ["accounts", OTA_READABLE_ACCOUNT_COLUMNS] as const,
        ...Object.entries(MIGRATION_0005.otaReadableColumns),
      ].flatMap(([table, columns]) => columns.map((column) => ({ table, column, privilege: "SELECT" }))),
    );

    // No default privileges in platform, no grant to PUBLIC, USAGE only on the schema (bootstrap.sql).
    expect(
      await catalog(
        "SELECT a.grantee::regrole::text AS grantee FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a " +
          "WHERE d.defaclnamespace = 'platform'::regnamespace AND a.grantee IN (0, 'velexis_ota_app'::regrole)",
      ),
    ).toEqual([]);
    expect(
      await catalog(
        "SELECT c.relname FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a " +
          "WHERE c.relnamespace = 'platform'::regnamespace AND a.grantee = 0",
      ),
    ).toEqual([]);
    expect(
      await catalog(
        "SELECT a.privilege_type AS privilege FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a " +
          "WHERE n.nspname = 'platform' AND a.grantee = 'velexis_ota_app'::regrole",
      ),
    ).toEqual([{ privilege: "USAGE" }]);
  });

  it("re-applying R__ota_read_access.sql changes no privilege", async () => {
    const acl = () =>
      catalog(
        "SELECT c.relname, c.relacl::text, (SELECT array_agg(att.attname || '=' || att.attacl::text ORDER BY att.attnum) " +
          "FROM pg_attribute att WHERE att.attrelid = c.oid AND att.attacl IS NOT NULL) AS columns " +
          "FROM pg_class c WHERE c.relnamespace = 'platform'::regnamespace ORDER BY 1",
      );
    const before = await acl();
    const sql = await readFile(
      join(REPO, "platform/backend/migrations/platform/R__ota_read_access.sql"),
      "utf8",
    );
    await withClient(migratorUrl, async (client) => void (await client.query(sql)));
    expect(await acl()).toEqual(before);
  });

  it.each(NEVER_GRANTED_ACCOUNT_COLUMNS)(
    "denies velexis_ota_app platform.accounts.%s with permission denied [X-012 AC3]",
    async (column) => {
      const { ota, platformApp } = clients();
      await expect(ota.query(`SELECT ${column} FROM platform.accounts`)).rejects.toMatchObject(
        denied("accounts"),
      );
      await expect(
        ota.query(`SELECT id FROM platform.accounts WHERE ${column} IS NULL`),
      ).rejects.toMatchObject(denied("accounts"));
      // The column exists and the platform role reads it: the denial is a privilege, not a typo.
      await expect(platformApp.query(`SELECT ${column} FROM platform.accounts`)).resolves.toMatchObject({
        rowCount: 1,
      });
      const [privilege] = await catalog<{ allowed: boolean }>(
        "SELECT has_column_privilege('velexis_ota_app', 'platform.accounts', $1, 'SELECT') AS allowed",
        [column],
      );
      expect(privilege?.allowed).toBe(false);
    },
  );

  it("denies velexis_ota_app SELECT * on platform.accounts [X-012 AC3]", async () => {
    await expect(clients().ota.query("SELECT * FROM platform.accounts")).rejects.toMatchObject(
      denied("accounts"),
    );
  });

  it.each(OTA_DENIED_TABLES)(
    "denies velexis_ota_app SELECT on platform.%s with permission denied [X-012 AC4]",
    async (table) => {
      const { ota, platformApp } = clients();
      await expect(ota.query(`SELECT * FROM platform.${table}`)).rejects.toMatchObject(denied(table));
      await expect(ota.query(`SELECT count(*) FROM platform.${table}`)).rejects.toMatchObject(denied(table));
      await expect(platformApp.query(`SELECT * FROM platform.${table}`)).resolves.toBeDefined();
    },
  );

  it("lets velexis_ota_app read the granted columns of the supply registry, with real rows [PBE-078 AC3]", async () => {
    const { ota } = clients();
    // supplier_environments: the global switch of each supplier and environment that 0005 seeds.
    await expect(
      ota.query(
        `SELECT ${MIGRATION_0005.otaReadableColumns["supplier_environments"]?.join(", ")} ` +
          "FROM platform.supplier_environments ORDER BY supplier_id, environment",
      ),
    ).resolves.toMatchObject({
      rows: [
        { supplier_id: "amadeus", environment: "live", sales_enabled: true },
        { supplier_id: "amadeus", environment: "test", sales_enabled: true },
        { supplier_id: "pkfare", environment: "live", sales_enabled: false },
        { supplier_id: "pkfare", environment: "test", sales_enabled: false },
      ],
    });
    // supply_sources: the source and whether a stop is set, never who set it, when or why.
    await expect(
      ota.query(
        `SELECT ${MIGRATION_0005.otaReadableColumns["supply_sources"]?.join(", ")} FROM platform.supply_sources`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          id: SOURCE.id,
          supplier_id: "pkfare",
          environment: "test",
          credential_source: "velexis",
          tenant_id: null,
          sales_stop: "staff",
        },
      ],
    });
    // supply_source_ids: the source of an id, and whether the id is current.
    await expect(
      ota.query(
        `SELECT ${MIGRATION_0005.otaReadableColumns["supply_source_ids"]?.join(", ")} FROM platform.supply_source_ids`,
      ),
    ).resolves.toMatchObject({
      rows: [{ supply_id: SOURCE.supplyId, supply_source_id: SOURCE.id, retired_at: null }],
    });
    // The resolver's join: an id, current or old, to its source and its stop.
    await expect(
      ota.query(
        "SELECT s.id, s.sales_stop IS NOT NULL AS stopped FROM platform.supply_source_ids i " +
          "JOIN platform.supply_sources s ON s.id = i.supply_source_id WHERE i.supply_id = $1 AND i.retired_at IS NULL",
        [SOURCE.supplyId],
      ),
    ).resolves.toMatchObject({ rows: [{ id: SOURCE.id, stopped: true }] });
    // The columns 0005 adds to supplier_connections and amadeus_accounts are covered by their table-level SELECT.
    await expect(
      ota.query("SELECT supply_source_id, sales_enabled FROM platform.supplier_connections"),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(ota.query("SELECT supply_source_id FROM platform.amadeus_accounts")).resolves.toMatchObject({
      rowCount: 0,
    });
  });

  it("lets velexis_ota_app read exactly the listed columns of the registry in the catalog, and no registry table as a whole [PBE-078 AC3]", async () => {
    // The catalog: every column of the three tables is either granted or listed as denied, so a column added later
    // and granted by mistake, or a grant dropped, fails here.
    for (const table of Object.keys(MIGRATION_0005.otaReadableColumns)) {
      const columns = await catalog<{ column: string; allowed: boolean }>(
        "SELECT a.attname AS column, has_column_privilege('velexis_ota_app', a.attrelid, a.attnum, 'SELECT') AS allowed " +
          "FROM pg_attribute a WHERE a.attrelid = format('platform.%I', $1::text)::regclass AND a.attnum > 0 " +
          "AND NOT a.attisdropped ORDER BY a.attnum",
        [table],
      );
      expect({ table, allowed: columns.filter((row) => row.allowed).map((row) => row.column) }).toEqual({
        table,
        allowed: MIGRATION_0005.otaReadableColumns[table],
      });
      expect({
        table,
        denied: columns
          .filter((row) => !row.allowed)
          .map((row) => row.column)
          .sort(),
      }).toEqual({
        table,
        denied: [...(MIGRATION_0005.otaDeniedColumns[table] ?? [])].sort(),
      });
    }
    // No table-level privilege on any of the four.
    for (const table of MIGRATION_0005.tables) {
      const [privilege] = await catalog<{ allowed: boolean }>(
        "SELECT has_table_privilege('velexis_ota_app', format('platform.%I', $1::text), 'SELECT') AS allowed",
        [table],
      );
      expect({ table, allowed: privilege?.allowed }).toEqual({ table, allowed: false });
    }
  });

  it.each(
    Object.entries(MIGRATION_0005.otaDeniedColumns).flatMap(([table, columns]) =>
      columns.map((column) => [table, column] as const),
    ),
  )("denies velexis_ota_app platform.%s.%s with permission denied [PBE-078 AC3]", async (table, column) => {
    const { ota, platformApp } = clients();
    await expect(ota.query(`SELECT ${column} FROM platform.${table}`)).rejects.toMatchObject(denied(table));
    await expect(
      ota.query(`SELECT 1 FROM platform.${table} WHERE ${column} IS NOT NULL`),
    ).rejects.toMatchObject(denied(table));
    // The column exists and the platform role reads it: the denial is a privilege, not a typo.
    await expect(platformApp.query(`SELECT ${column} FROM platform.${table}`)).resolves.toBeDefined();
  });

  it.each([...Object.keys(MIGRATION_0005.otaDeniedColumns), ...MIGRATION_0005.otaDeniedTables])(
    "denies velexis_ota_app SELECT * on platform.%s [PBE-078 AC3]",
    async (table) => {
      const { ota, platformApp } = clients();
      await expect(ota.query(`SELECT * FROM platform.${table}`)).rejects.toMatchObject(denied(table));
      await expect(platformApp.query(`SELECT * FROM platform.${table}`)).resolves.toMatchObject({
        rowCount: expect.any(Number),
      });
    },
  );

  it("denies velexis_ota_app every column of platform.suppliers [PBE-078 AC3]", async () => {
    const { ota, platformApp } = clients();
    for (const column of ["id", "name", "created_at", "updated_at"]) {
      await expect(ota.query(`SELECT ${column} FROM platform.suppliers`)).rejects.toMatchObject(
        denied("suppliers"),
      );
    }
    await expect(ota.query("SELECT count(*) FROM platform.suppliers")).rejects.toMatchObject(
      denied("suppliers"),
    );
    await expect(platformApp.query("SELECT id FROM platform.suppliers ORDER BY id")).resolves.toMatchObject({
      rows: [{ id: "amadeus" }, { id: "pkfare" }],
    });
    expect(
      await catalog(
        "SELECT a.attname FROM pg_attribute a WHERE a.attrelid = 'platform.suppliers'::regclass AND a.attnum > 0 " +
          "AND has_column_privilege('velexis_ota_app', a.attrelid, a.attnum, 'SELECT')",
      ),
    ).toEqual([]);
  });

  it("denies velexis_ota_app every write on the supply registry, as the platform role makes them [PBE-078 AC3]", async () => {
    const { ota, platformApp } = clients();
    const writes: ReadonlyArray<readonly [string, string, unknown[]]> = [
      ["suppliers", "INSERT INTO platform.suppliers (id, name) VALUES ('duffel', 'Duffel')", []],
      [
        "supplier_environments",
        "UPDATE platform.supplier_environments SET sales_enabled = false WHERE supplier_id = 'amadeus'",
        [],
      ],
      [
        "supply_sources",
        "UPDATE platform.supply_sources SET sales_stop = NULL, sales_stop_at = NULL, sales_stop_reason = NULL, sales_stop_by_account_id = NULL WHERE id = $1",
        [SOURCE.id],
      ],
      [
        "supply_source_ids",
        "INSERT INTO platform.supply_source_ids (supply_id, supply_source_id, retired_at) VALUES ('sup_8KQ2M9XW3HT6PBNC', $1, now())",
        [SOURCE.id],
      ],
      ["supply_source_ids", "DELETE FROM platform.supply_source_ids WHERE supply_id = $1", [SOURCE.supplyId]],
    ];
    for (const [table, text, values] of writes) {
      await expect(ota.query(text, values)).rejects.toMatchObject(denied(table));
      // The same statement is valid: the platform role runs it, in a transaction that is rolled back.
      await platformApp.query("BEGIN");
      try {
        await expect(platformApp.query(text, values)).resolves.toBeDefined();
      } finally {
        await platformApp.query("ROLLBACK");
      }
    }
  });

  it("denies velexis_ota_app UPDATE, and every other write, on every platform table [X-012 AC4]", async () => {
    const { ota, platformApp } = clients();
    // One plain column per table (not generated, not identity), so the statement itself is valid.
    const targets = await catalog<{ table: string; column: string }>(
      "SELECT DISTINCT ON (c.relname) c.relname AS table, a.attname AS column FROM pg_class c " +
        "JOIN pg_attribute a ON a.attrelid = c.oid " +
        "WHERE c.relnamespace = 'platform'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 " +
        "AND NOT a.attisdropped AND a.attgenerated = '' AND a.attidentity = '' ORDER BY c.relname, a.attnum",
    );
    expect(targets.map((target) => target.table)).toEqual(await tablesOf("platform"));
    // 16 baseline tables, the ledger, the 11 tables of migration 0002, the one of 0003 and the four of 0005.
    expect(targets).toHaveLength(
      17 + MIGRATION_0002.tables.length + MIGRATION_0003.tables.length + MIGRATION_0005.tables.length,
    );
    for (const { table, column } of targets) {
      const update =
        `UPDATE platform.${pg.escapeIdentifier(table)} ` +
        `SET ${pg.escapeIdentifier(column)} = ${pg.escapeIdentifier(column)} WHERE false`;
      await expect(ota.query(update)).rejects.toMatchObject(denied(table));
      await expect(
        ota.query(`DELETE FROM platform.${pg.escapeIdentifier(table)} WHERE false`),
      ).rejects.toMatchObject(denied(table));
      if (MIGRATION_0002.appendOnlyTables.includes(table)) {
        // Migration 0002 makes the audit log append-only for the platform role too (PADR-0006), so the same
        // statement is shown valid as the owner (velexis_test_admin is a member of velexis_migrator).
        await expect(platformApp.query(update)).rejects.toMatchObject(denied(table));
        await expect(clients().admin.query(update)).resolves.toMatchObject({ rowCount: 0 });
      } else {
        // The same statement is valid: the platform role runs it.
        await expect(platformApp.query(update)).resolves.toMatchObject({ rowCount: 0 });
      }
    }

    const writes = await catalog(
      "SELECT c.relname AS table, p.privilege FROM pg_class c " +
        "CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(privilege) " +
        "WHERE c.relnamespace = 'platform'::regnamespace AND c.relkind IN ('r','p','v','m','f') " +
        "AND (has_table_privilege('velexis_ota_app', c.oid, p.privilege) " +
        "OR (p.privilege IN ('INSERT','UPDATE','REFERENCES') AND has_any_column_privilege('velexis_ota_app', c.oid, p.privilege)))",
    );
    expect(writes).toEqual([]);
    expect(
      await catalog(
        "SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'platform'::regnamespace AND c.relkind = 'S' " +
          "AND (has_sequence_privilege('velexis_ota_app', c.oid, 'USAGE') OR has_sequence_privilege('velexis_ota_app', c.oid, 'UPDATE'))",
      ),
    ).toEqual([]);
  });

  it("gives velexis_platform_app no privilege on tenant_alpha [X-012 AC5]", async () => {
    const { platformApp } = clients();
    const [schema] = await catalog<{ usage: boolean; create: boolean }>(
      "SELECT has_schema_privilege('velexis_platform_app', $1, 'USAGE') AS usage, " +
        "has_schema_privilege('velexis_platform_app', $1, 'CREATE') AS create",
      [TENANT],
    );
    expect(schema).toEqual({ usage: false, create: false });

    const relations = await catalog(
      "SELECT c.relname AS table, p.privilege FROM pg_class c CROSS JOIN unnest($2::text[]) AS p(privilege) " +
        "WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r','p','v','m','f') " +
        "AND (has_table_privilege('velexis_platform_app', c.oid, p.privilege) " +
        "OR (p.privilege IN ('SELECT','INSERT','UPDATE','REFERENCES') AND has_any_column_privilege('velexis_platform_app', c.oid, p.privilege)))",
      [TENANT, TABLE_PRIVILEGES],
    );
    expect(relations).toEqual([]);

    // No ACL entry anywhere in the schema names the platform role or PUBLIC.
    const entries = await catalog(
      "SELECT 'schema' AS object FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a " +
        "WHERE n.nspname = $1 AND a.grantee IN (0, 'velexis_platform_app'::regrole) " +
        "UNION ALL SELECT c.relname FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a " +
        "WHERE c.relnamespace = $1::regnamespace AND a.grantee IN (0, 'velexis_platform_app'::regrole) " +
        "UNION ALL SELECT c.relname || '.' || att.attname FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid " +
        "CROSS JOIN LATERAL aclexplode(att.attacl) a " +
        "WHERE c.relnamespace = $1::regnamespace AND a.grantee IN (0, 'velexis_platform_app'::regrole) " +
        "UNION ALL SELECT 'default privileges' FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a " +
        "WHERE d.defaclnamespace = $1::regnamespace AND a.grantee IN (0, 'velexis_platform_app'::regrole)",
      [TENANT],
    );
    expect(entries).toEqual([]);

    for (const table of await tablesOf(TENANT)) {
      await expect(
        platformApp.query(`SELECT * FROM ${pg.escapeIdentifier(TENANT)}.${pg.escapeIdentifier(table)}`),
      ).rejects.toMatchObject({ code: "42501", message: `permission denied for schema ${TENANT}` });
    }
  });

  it("lets velexis_platform_app insert into reference.airports [X-012 AC5]", async () => {
    const { platformApp, ota } = clients();
    await platformApp.query("BEGIN");
    try {
      await platformApp.query("INSERT INTO reference.countries (code, name) VALUES ('FR', 'France')");
      const inserted = await platformApp.query(
        "INSERT INTO reference.airports (iata_code, name, country_code) " +
          "VALUES ('CDG', 'Paris Charles de Gaulle', 'FR') RETURNING iata_code",
      );
      expect(inserted.rows).toEqual([{ iata_code: "CDG" }]);
    } finally {
      await platformApp.query("ROLLBACK");
    }
    // The OTA role reads reference data but never writes it.
    await expect(ota.query("SELECT iata_code FROM reference.airports")).resolves.toMatchObject({
      rowCount: 0,
    });
    await expect(
      ota.query(
        "INSERT INTO reference.airports (iata_code, name, country_code) VALUES ('ORY', 'Orly', 'FR')",
      ),
    ).rejects.toMatchObject(denied("airports"));
  });

  it("prints one applied line per file on the first pnpm db:migrate, then nothing on a second run [X-012 AC6]", async () => {
    expect(firstMigrate.map((run) => [run.argv[0], run.code, run.stderr])).toEqual([
      ["platform", 0, ""],
      ["reference", 0, ""],
    ]);
    expect(
      firstMigrate.flatMap((run) => run.events.map((event) => [event.set, event.file, event.status])),
    ).toEqual([
      ["platform", "0001_baseline.sql", "applied"],
      ["platform", MIGRATION_0002.file, "applied"],
      ["platform", MIGRATION_0003.file, "applied"],
      ["platform", MIGRATION_0004.file, "applied"],
      ["platform", MIGRATION_0005.file, "applied"],
      ["platform", "R__ota_read_access.sql", "applied"],
      ["reference", "0001_baseline.sql", "applied"],
    ]);
    // One line per file: every line is one event.
    for (const run of firstMigrate) {
      expect(run.stdout.split("\n").filter((line) => line !== "")).toHaveLength(run.events.length);
    }

    const second = await dbMigrate(migratorUrl);
    expect(second.map((run) => [run.argv[0], run.code, run.stdout, run.stderr])).toEqual([
      ["platform", 0, "", ""],
      ["reference", 0, "", ""],
    ]);
  });
});
