// The tenant commands of the migration runner on PostgreSQL 16 (X-013; ADR-0004, ADR-0005 item 4, ADR-0021, db
// README §3 and §4): migrateTenantSchema and `migrate.js tenant` for one schema, migrateTenants and
// `migrate.js tenants` for the fan-out over platform.tenants.
//
// Every test gets a fresh database `velexis_dbtest_<random>`, created as TEST_DATABASE_ADMIN_URL as a copy of
// one template `velexis_dbtest_tpl_<random>` that this file builds once (beforeAll). The template is bootstrapped
// like deploy/postgres/bootstrap.sql: the database section (psql variables there) is mirrored below, the
// statements after `\connect :db_name` are read from bootstrap.sql itself. The platform and reference baselines of
// the repository are applied with runMigrations, and a plan is added for the tenant rows. PostgreSQL copies
// everything inside a database to its clone, but not the database ACL, so every clone gets the database grants
// again. A clone takes a fraction of a second, where bootstrapping and migrating a database from template0 took
// more than Vitest's 10 s hook timeout while the other integration test files ran in parallel. The CLI runs as
// velexis_migrator (DATABASE_MIGRATOR_URL with the database name swapped, as velexis-deploy does); provisioning
// runs the library with the DATABASE_PROVISIONER_URL of the root .env.example, as the OTA worker does. The app
// roles log in with the development DSNs of ota/backend/.env.example and platform/backend/.env.example (dummy values
// that deploy/scripts/dev-setup.sh and the CI bootstrap set).
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrateCli } from "../../src/cli/migrate.js";
import { sql, type Kysely, type TenantDatabase } from "../../src/index.js";
import {
  BASELINE_FILE,
  migrateTenants,
  migrateTenantSchema,
  runMigrations,
  splitSqlStatements,
  TenantChecksumMismatchError,
  TenantMigrationFailedError,
  TenantSchemaError,
  type TenantMigrationFileEvent,
  type TenantMigrationReport,
} from "../../src/migrate/index.js";

const PACKAGE_DIR = resolve(__dirname, "..", "..");
const REPO = resolve(PACKAGE_DIR, "..", "..");
const REFERENCE_DDL = join(REPO, "docs", "velexis-sdk", "db");
const TENANT_DIR = join(REPO, "ota", "backend", "migrations", "tenant");
const PROVISIONER = "velexis_provisioner";
/**
 * What the repository's tenant set holds after its baseline: migration 0002 (OBE-008,
 * ota/docs/data-model-migration-0002.md), which creates 2 tables. The tests that run TENANT_DIR expect it.
 */
const TENANT_MIGRATION_0002 = {
  file: "0002_add_mvp_tenant_deltas.sql",
  id: "0002_add_mvp_tenant_deltas",
  tables: ["storefront_assets", "storefront_pages"],
};
/** Then migration 0003 (FIX-W27-SYNC), two columns of `bookings` and no table. */
const TENANT_MIGRATION_0003 = {
  file: "0003_add_booking_sync_claim.sql",
  id: "0003_add_booking_sync_claim",
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
 * The DSN of a role on `database`: user and development password from `variable` in an `.env.example` file
 * (`DATABASE_URL` of `<component>/backend/.env.example` for the app roles, `DATABASE_PROVISIONER_URL` of the root
 * one for the provisioner), host and port from TEST_DATABASE_ADMIN_URL. These are the dummy values that
 * dev-setup.sh and the CI bootstrap set; reading them here also keeps the test independent of the variables that
 * Turborepo passes through to `pnpm test:int`. Never printed.
 */
async function roleUrl(
  envExample: string,
  variable: string,
  role: string,
  admin: string,
  database: string,
): Promise<string> {
  const example = await readFile(join(REPO, envExample), "utf8");
  const value = new RegExp(`^${variable}=(\\S+)$`, "m").exec(example)?.[1];
  if (value === undefined) {
    throw new Error(`${envExample} has no ${variable} line`);
  }
  const dsn = new URL(value);
  if (dsn.username !== role) {
    throw new Error(`${envExample}: ${variable} is not the role ${role}`);
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
  const connectLine = /^\\connect :db_name[ \t]*$/m.exec(script);
  if (connectLine === null) {
    throw new Error("deploy/postgres/bootstrap.sql has no \\connect :db_name line");
  }
  const rest = script.slice(connectLine.index + connectLine[0].length);
  if (/^\s*\\/m.test(rest) || /:'?[a-z_]+'?/i.test(rest.replace(/--.*$/gm, "").replace(/::/g, ""))) {
    throw new Error("bootstrap.sql after \\connect is no longer plain SQL; update tenants.int.test.ts");
  }
  return splitSqlStatements(rest);
}

interface TestDatabase {
  readonly name: string;
  /** velexis_test_admin (member of velexis_migrator) on this database. */
  readonly adminUrl: string;
  /** DATABASE_MIGRATOR_URL on this database: what migrate.js and velexis-deploy use. */
  readonly migratorUrl: string;
  /** DATABASE_PROVISIONER_URL (root .env.example) on this database: what the OTA worker uses. */
  readonly provisionerUrl: string;
  readonly otaUrl: string;
  readonly platformUrl: string;
  /** Runs a query as velexis_test_admin on one connection kept for the test. */
  query<R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<R[]>;
  /** Closes that connection and drops the database. */
  drop(): Promise<void>;
}

/**
 * The databases this file created and has not dropped yet. afterAll drops what is left, also the database of a
 * beforeEach that Vitest gave up on: its setup goes on after the hook's timeout and still creates the database.
 */
const liveDatabases = new Set<string>();
/** Every setup started by beforeAll or beforeEach; afterAll waits for them to settle before it drops. */
const setups: Promise<unknown>[] = [];

/** How often dropDatabase tries; the pause before retry n is n times DROP_RETRY_DELAY_MS (4.5 s in all). */
const DROP_ATTEMPTS = 10;
const DROP_RETRY_DELAY_MS = 100;

/**
 * DROP DATABASE … WITH (FORCE), retried while a session that velexis_test_admin may not terminate is on the
 * database (42501): an autovacuum worker, which visits the template during the file's run, or an app role's session
 * that is still exiting; or while a session did not exit in time (55006). Both end by themselves, as in
 * @velexis/testing's dropDatabase.
 */
async function dropDatabase(admin: string, name: string): Promise<void> {
  await withClient(admin, async (client) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
        return;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (attempt >= DROP_ATTEMPTS || (code !== "42501" && code !== "55006")) {
          throw error;
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, DROP_RETRY_DELAY_MS * attempt));
    }
  });
  liveDatabases.delete(name);
}

/**
 * Creates `name` owned by velexis_migrator, as a copy of `template`, with the database-level grants of
 * bootstrap.sql. A clone needs them again: PostgreSQL does not copy the database ACL.
 */
async function createDatabase(admin: string, name: string, template: string): Promise<void> {
  const database = pg.escapeIdentifier(name);
  const options =
    template === "template0"
      ? "ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0"
      : `TEMPLATE ${pg.escapeIdentifier(template)}`;
  liveDatabases.add(name);
  await withClient(admin, async (client) => {
    await client.query(`CREATE DATABASE ${database} OWNER velexis_migrator ${options}`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO velexis_platform_app, velexis_ota_app`,
    );
    await client.query(`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${database} TO velexis_provisioner`);
    await client.query(`GRANT ALL ON DATABASE ${database} TO velexis_migrator`);
  });
}

/**
 * The template of this file's test databases: a database bootstrapped like bootstrap.sql, with the repository's
 * platform and reference sets applied and the plan of the tenant rows. Every connection to it is closed when this
 * returns, so that CREATE DATABASE … TEMPLATE can copy it.
 */
async function createTemplateDatabase(): Promise<string> {
  const urls = testUrls();
  const name = `velexis_dbtest_tpl_${randomBytes(6).toString("hex")}`;
  await createDatabase(urls.admin, name, "template0");
  try {
    const statements = await bootstrapDatabaseStatements();
    await withClient(withDatabase(urls.admin, name), async (admin) => {
      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE velexis_migrator");
      for (const statement of statements) {
        await admin.query(statement);
      }
      await admin.query("COMMIT");
    });
    for (const set of ["platform", "reference"] as const) {
      await runMigrations({
        set,
        dir: join(REPO, "platform", "backend", "migrations", set),
        url: withDatabase(urls.migrator, name),
      });
    }
    const platformUrl = await roleUrl(
      "platform/backend/.env.example",
      "DATABASE_URL",
      "velexis_platform_app",
      urls.admin,
      name,
    );
    await withClient(platformUrl, async (client) => {
      await client.query("INSERT INTO platform.plans (code, name) VALUES ('starter', 'Starter')");
    });
  } catch (error) {
    await dropDatabase(urls.admin, name);
    throw error;
  }
  return name;
}

/** A copy of the template: bootstrapped like bootstrap.sql, with the platform and reference sets applied. */
async function createTestDatabase(template: string): Promise<TestDatabase> {
  const urls = testUrls();
  const name = `velexis_dbtest_${randomBytes(6).toString("hex")}`;
  await createDatabase(urls.admin, name, template);
  const adminUrl = withDatabase(urls.admin, name);
  const admin = new pg.Client({ connectionString: adminUrl, application_name: "velexis-db-int-test" });
  admin.on("error", () => undefined);
  const db: TestDatabase = {
    name,
    adminUrl,
    migratorUrl: withDatabase(urls.migrator, name),
    provisionerUrl: await roleUrl(".env.example", "DATABASE_PROVISIONER_URL", PROVISIONER, urls.admin, name),
    otaUrl: await roleUrl("ota/backend/.env.example", "DATABASE_URL", "velexis_ota_app", urls.admin, name),
    platformUrl: await roleUrl(
      "platform/backend/.env.example",
      "DATABASE_URL",
      "velexis_platform_app",
      urls.admin,
      name,
    ),
    query: async (text, values) => (await admin.query(text, values)).rows,
    drop: async () => {
      await admin.end().catch(() => undefined);
      await dropDatabase(urls.admin, name);
    },
  };
  try {
    await admin.connect();
  } catch (error) {
    await db.drop();
    throw error;
  }
  return db;
}

let template: string;
let db: TestDatabase;
const folders: string[] = [];

// Timeouts. Bootstrapping and migrating a database from template0 takes about 0.7 s on an idle server, but it
// took more than Vitest's 10 s default hook timeout while turbo ran the integration test files of every package in
// parallel against the same server (a slowdown of 15x and more). It now runs once per file, with 60 s. A clone
// (CREATE DATABASE … TEMPLATE, then the grants) takes 0.1 to 0.4 s on an idle server; the same slowdown would bring
// it close to the default, so beforeEach gets 30 s.
beforeAll(async () => {
  const setup = createTemplateDatabase();
  setups.push(setup);
  template = await setup;
}, 60_000);

beforeEach(async () => {
  const setup = createTestDatabase(template);
  setups.push(setup);
  db = await setup;
}, 30_000);

afterEach(async () => {
  await db?.drop();
});

// Drops what this file created and has not dropped yet: the template, and the database of a setup that outlived
// its hook's timeout (waited for first, so that it cannot create its database after this ran).
afterAll(async () => {
  await Promise.allSettled(setups);
  const { admin } = testUrls();
  for (const name of [...liveDatabases].reverse()) {
    await dropDatabase(admin, name);
  }
  await Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true })));
}, 60_000);

async function scratchFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-tenants-int-"));
  folders.push(dir);
  return dir;
}

/**
 * A small tenant baseline for the fan-out tests, which provision many schemas: the tenant ledger exactly as
 * tenant.sql creates it, and a `customers` table. The fan-out does not depend on the size of the baseline.
 */
async function smallBaseline(): Promise<string> {
  const tenantSql = await readFile(join(REFERENCE_DDL, "tenant.sql"), "utf8");
  const ledgerDdl = splitSqlStatements(tenantSql).find((statement) =>
    statement.startsWith("CREATE TABLE schema_migrations ("),
  );
  if (ledgerDdl === undefined) {
    throw new Error("tenant.sql has no CREATE TABLE schema_migrations statement");
  }
  return (
    "-- A small tenant baseline for the fan-out tests\n" +
    `${ledgerDdl};\n` +
    "CREATE TABLE customers (id text PRIMARY KEY, email text NOT NULL, first_name text NOT NULL, " +
    "last_name text NOT NULL);\n"
  );
}

/**
 * A tenant migration folder: `0001_baseline.sql` (the small baseline, or a byte copy of the repository's), plus
 * `files` (name → SQL).
 */
async function tenantFolder(
  files: Record<string, string> = {},
  baseline: "small" | "repository" = "small",
): Promise<string> {
  const dir = await scratchFolder();
  if (baseline === "repository") {
    await copyFile(join(TENANT_DIR, BASELINE_FILE), join(dir, BASELINE_FILE));
  } else {
    await writeFile(join(dir, BASELINE_FILE), await smallBaseline());
  }
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql);
  }
  return dir;
}

const expand = (description: string, ...statements: string[]): string =>
  `-- velexis:phase expand\n-- ${description}\n${statements.join("\n")}\n`;

/** A later tenant migration: a table with a foreign key into the baseline and a sequence, and no GRANT. */
const LOYALTY_FILE = "0002_add_loyalty_cards.sql";
const LOYALTY_SQL = expand(
  "Add the loyalty cards of customers",
  "CREATE TABLE loyalty_cards (",
  "  id          text PRIMARY KEY CHECK (id LIKE 'lyc\\_%'),",
  "  customer_id text NOT NULL REFERENCES customers (id) ON DELETE CASCADE,",
  "  points      integer NOT NULL DEFAULT 0,",
  "  created_at  timestamptz NOT NULL DEFAULT now()",
  ");",
  "COMMENT ON TABLE loyalty_cards IS 'Loyalty cards of customers.';",
  "CREATE SEQUENCE loyalty_card_numbers;",
);
const LOYALTY_INDEX_FILE = "0003_index_loyalty_cards.sql";
const LOYALTY_INDEX_SQL =
  "-- velexis:phase expand\n-- velexis:no-transaction\n-- Index the loyalty cards by customer\n" +
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS loyalty_cards_customer_idx ON loyalty_cards (customer_id);\n";

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly events: TenantMigrationFileEvent[];
}

/** `migrate.js <argv>` with DATABASE_MIGRATOR_URL on the test database. */
async function cli(argv: readonly string[]): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await runMigrateCli(argv, {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    env: { APP_ENV: "test", DATABASE_MIGRATOR_URL: db.migratorUrl },
  });
  const events = stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as TenantMigrationFileEvent);
  return { code, stdout, stderr, events };
}

/** Adds a tenant row; its schema_name is generated as `tenant_<key>`. */
async function addTenant(key: string, status = "active"): Promise<string> {
  await withClient(db.platformUrl, async (client) => {
    await client.query(
      "INSERT INTO platform.tenants (id, key, name, plan_code, status) VALUES ($1, $2, $3, 'starter', $4)",
      [`ten_${key}`, key, `OTA ${key}`, status],
    );
  });
  return `tenant_${key}`;
}

/** Provisions `tenant_<key>` with the files of `dir` as the OTA worker does, and adds its active tenant row. */
async function provisionTenant(key: string, dir: string): Promise<string> {
  const schema = await addTenant(key);
  await migrateTenantSchema({ schema, dir, url: db.provisionerUrl, create: true });
  return schema;
}

async function tablesOf(schema: string): Promise<string[]> {
  const rows = await db.query<{ table: string }>(
    "SELECT tablename AS table FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
    [schema],
  );
  return rows.map((row) => row.table);
}

/** The tables a reference DDL file creates, sorted. */
async function ddlTables(file: string): Promise<string[]> {
  const ddl = await readFile(join(REFERENCE_DDL, file), "utf8");
  return [...ddl.matchAll(/^CREATE TABLE (?:[a-z]+\.)?([a-z_]+) \(/gm)].map((match) => match[1] ?? "").sort();
}

/** The tables of a schema migrated with TENANT_DIR: the baseline's 42 and those of 0002, sorted. */
async function repositoryTenantTables(): Promise<string[]> {
  return [...(await ddlTables("tenant.sql")), ...TENANT_MIGRATION_0002.tables].sort();
}

/** The owners of a schema and of every relation in it. */
async function ownersOf(schema: string): Promise<string[]> {
  const rows = await db.query<{ owner: string }>(
    "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = $1 UNION " +
      "SELECT DISTINCT relowner::regrole::text FROM pg_class WHERE relnamespace = to_regnamespace($1)",
    [schema],
  );
  return rows.map((row) => row.owner).sort();
}

interface LedgerRecord {
  id: string;
  checksum: string;
  phase: string;
  status: string;
  updated_at: Date;
}

function ledger(schema: string): Promise<LedgerRecord[]> {
  return db.query<LedgerRecord>(
    `SELECT id, checksum, phase, status, updated_at FROM ${pg.escapeIdentifier(schema)}.schema_migrations ORDER BY id`,
  );
}

async function schemaExists(schema: string): Promise<boolean> {
  const [row] = await db.query<{ found: boolean }>("SELECT to_regnamespace($1) IS NOT NULL AS found", [
    pg.escapeIdentifier(schema),
  ]);
  return row?.found === true;
}

/** Runs `fn` as velexis_ota_app in a transaction on `schema`, the way tenantTx sets it up, then commits. */
async function asOtaApp<T>(schema: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  return withClient(db.otaUrl, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('search_path', $1, true)", [`${schema}, reference`]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

const CUSTOMER =
  "INSERT INTO customers (id, email, first_name, last_name) VALUES ($1, $2, 'Tia', 'Traveller')";

const denied = (message: string) => ({ code: "42501", message });

/** Runner connections still open on the test database. */
async function runnerSessions(): Promise<number> {
  const [row] = await db.query<{ sessions: number }>(
    "SELECT count(*)::int AS sessions FROM pg_stat_activity " +
      "WHERE datname = $1 AND application_name LIKE 'velexis-migrate%'",
    [db.name],
  );
  return row?.sessions ?? -1;
}

async function readReport(path: string): Promise<TenantMigrationReport> {
  return JSON.parse(await readFile(path, "utf8")) as TenantMigrationReport;
}

describe("migrateTenantSchema and migrate.js tenant on PostgreSQL", () => {
  it("creates tenant_demo with --create: the baseline's 42 tables and those of 0002, owned by velexis_provisioner, writable by velexis_ota_app, closed to velexis_platform_app [X-013 AC1]", async () => {
    const run = await cli(["tenant", "--schema", "tenant_demo", "--dir", TENANT_DIR, "--create"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const baselineChecksum = await sha256(join(REFERENCE_DDL, "tenant.sql"));
    const migrationChecksum = await sha256(join(TENANT_DIR, TENANT_MIGRATION_0002.file));
    const syncClaimChecksum = await sha256(join(TENANT_DIR, TENANT_MIGRATION_0003.file));
    expect(run.events).toEqual([
      {
        set: "tenant",
        schema: "tenant_demo",
        file: BASELINE_FILE,
        id: "0001_baseline",
        kind: "numbered",
        phase: "expand",
        status: "applied",
        checksum: baselineChecksum,
        transaction: true,
        executionMs: expect.any(Number),
      },
      {
        set: "tenant",
        schema: "tenant_demo",
        file: TENANT_MIGRATION_0002.file,
        id: TENANT_MIGRATION_0002.id,
        kind: "numbered",
        phase: "expand",
        status: "applied",
        checksum: migrationChecksum,
        transaction: true,
        executionMs: expect.any(Number),
      },
      {
        set: "tenant",
        schema: "tenant_demo",
        file: TENANT_MIGRATION_0003.file,
        id: TENANT_MIGRATION_0003.id,
        kind: "numbered",
        phase: "expand",
        status: "applied",
        checksum: syncClaimChecksum,
        transaction: true,
        executionMs: expect.any(Number),
      },
    ]);

    expect(await ddlTables("tenant.sql")).toHaveLength(42);
    const tenantTables = await repositoryTenantTables();
    expect(await tablesOf("tenant_demo")).toEqual(tenantTables);
    // The schema and every relation in it (tables, indexes) belong to the provisioner, not to the migrator.
    expect(await ownersOf("tenant_demo")).toEqual([PROVISIONER]);
    expect(
      (await ledger("tenant_demo")).map(({ id, checksum, phase, status }) => [id, checksum, phase, status]),
    ).toEqual([
      ["0001_baseline", baselineChecksum, "expand", "applied"],
      [TENANT_MIGRATION_0002.id, migrationChecksum, "expand", "applied"],
      [TENANT_MIGRATION_0003.id, syncClaimChecksum, "expand", "applied"],
    ]);

    // velexis_ota_app: USAGE and DML on every table, nothing more, and inserts into customers.
    const privileges = await db.query<{ table: string; privileges: string[] }>(
      "SELECT c.relname AS table, array(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p " +
        "WHERE has_table_privilege('velexis_ota_app', c.oid, p)) AS privileges FROM pg_class c " +
        "WHERE c.relnamespace = 'tenant_demo'::regnamespace AND c.relkind = 'r' ORDER BY 1",
    );
    expect(privileges).toEqual(
      tenantTables.map((table) => ({ table, privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"] })),
    );
    const inserted = await asOtaApp("tenant_demo", async (client) => {
      await client.query(CUSTOMER, ["cus_01J9ZK3V5Q8X2M4N6P7R9S1T4Y", "traveller@example.com"]);
      return (await client.query("SELECT id, email FROM customers")).rows;
    });
    expect(inserted).toEqual([{ id: "cus_01J9ZK3V5Q8X2M4N6P7R9S1T4Y", email: "traveller@example.com" }]);

    // velexis_platform_app: no privilege on the schema, so no table of it is reachable.
    await withClient(db.platformUrl, async (client) => {
      await expect(client.query("SELECT * FROM tenant_demo.customers")).rejects.toMatchObject(
        denied("permission denied for schema tenant_demo"),
      );
    });
    expect(
      await db.query(
        "SELECT has_schema_privilege('velexis_platform_app', 'tenant_demo', 'USAGE') AS usage, " +
          "has_table_privilege('velexis_platform_app', 'tenant_demo.customers', 'SELECT') AS select",
      ),
    ).toEqual([{ usage: false, select: false }]);

    // The default privileges that give later tables and sequences to velexis_ota_app without a GRANT.
    expect(
      await db.query(
        "SELECT pg_get_userbyid(d.defaclrole) AS role, d.defaclobjtype AS type, a.grantee::regrole::text AS grantee, " +
          "array_agg(a.privilege_type ORDER BY a.privilege_type) AS privileges FROM pg_default_acl d " +
          "CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace = 'tenant_demo'::regnamespace " +
          "GROUP BY 1, 2, 3 ORDER BY 2",
      ),
    ).toEqual([
      {
        role: PROVISIONER,
        type: "S",
        grantee: "velexis_ota_app",
        privileges: ["SELECT", "USAGE"],
      },
      {
        role: PROVISIONER,
        type: "r",
        grantee: "velexis_ota_app",
        privileges: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      },
    ]);
    expect(await runnerSessions()).toBe(0);

    // Re-running applies nothing [X-013 AC7].
    expect(await cli(["tenant", "--schema", "tenant_demo", "--dir", TENANT_DIR, "--create"])).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
      events: [],
    });
    expect(await cli(["tenant", "--schema", "tenant_demo", "--dir", TENANT_DIR])).toMatchObject({
      code: 0,
      stdout: "",
    });
  });

  it("works with the provisioner DSN, and that connection cannot write platform or reference tables [X-013 AC2]", async () => {
    const result = await migrateTenantSchema({
      schema: "tenant_prov",
      dir: TENANT_DIR,
      url: db.provisionerUrl,
      create: true,
    });
    expect(result).toMatchObject({ schema: "tenant_prov", dirExists: true, created: true, upToDate: 0 });
    expect(result.applied.map((event) => [event.id, event.status])).toEqual([
      ["0001_baseline", "applied"],
      [TENANT_MIGRATION_0002.id, "applied"],
      [TENANT_MIGRATION_0003.id, "applied"],
    ]);
    expect(await tablesOf("tenant_prov")).toEqual(await repositoryTenantTables());
    expect(await ownersOf("tenant_prov")).toEqual([PROVISIONER]);
    await asOtaApp("tenant_prov", (client) =>
      client.query(CUSTOMER, ["cus_01J9ZK3V5Q8X2M4N6P7R9S1T5Z", "prov@example.com"]),
    );

    await withClient(db.provisionerUrl, async (provisioner) => {
      const [{ user } = { user: "" }] = (
        await provisioner.query<{ user: string }>("SELECT current_user AS user")
      ).rows;
      expect(user).toBe(PROVISIONER);
      await expect(
        provisioner.query("UPDATE platform.accounts SET full_name = full_name WHERE false"),
      ).rejects.toMatchObject(denied("permission denied for schema platform"));
      await expect(
        provisioner.query(
          "INSERT INTO platform.platform_audit_log (id, action) VALUES ('pal_01J9ZK3V5Q8X2M4N6P7R9S1T6A', 'tenant.created')",
        ),
      ).rejects.toMatchObject(denied("permission denied for schema platform"));
      await expect(provisioner.query("DROP SCHEMA platform CASCADE")).rejects.toMatchObject(
        denied("must be owner of schema platform"),
      );
      await expect(
        provisioner.query(
          "INSERT INTO reference.airports (iata_code, name, country_code) VALUES ('CDG', 'Paris Charles de Gaulle', 'FR')",
        ),
      ).rejects.toMatchObject(denied("permission denied for schema reference"));
      await expect(
        provisioner.query("UPDATE reference.airports SET name = name WHERE false"),
      ).rejects.toMatchObject(denied("permission denied for schema reference"));
      await expect(provisioner.query("DROP SCHEMA reference CASCADE")).rejects.toMatchObject(
        denied("must be owner of schema reference"),
      );
    });
    // Nothing reached the platform or reference schemas.
    expect(
      await db.query(
        "SELECT nspname FROM pg_namespace WHERE nspname IN ('platform', 'reference') ORDER BY 1",
      ),
    ).toEqual([{ nspname: "platform" }, { nspname: "reference" }]);
    expect(await db.query("SELECT count(*)::int AS rows FROM platform.platform_audit_log")).toEqual([
      { rows: 0 },
    ]);
  });

  it("rolls the whole schema transaction back when a file fails: with --create the schema does not exist afterwards", async () => {
    const dir = await tenantFolder(
      {
        "0002_break.sql": expand(
          "Breaks halfway",
          "CREATE TABLE partial (id int);",
          "SELECT * FROM does_not_exist;",
        ),
      },
      "repository",
    );
    const run = await cli(["tenant", "--schema", "tenant_broken", "--dir", dir, "--create"]);
    expect(run.code).toBe(1);
    // The baseline ran in the same transaction and was rolled back with it: no applied line.
    expect(run.events).toEqual([
      expect.objectContaining({
        schema: "tenant_broken",
        file: "0002_break.sql",
        status: "failed",
        error: { message: 'relation "does_not_exist" does not exist', code: "42P01", line: 4 },
      }),
    ]);
    expect(run.stderr).toBe(
      'migrate: Migration tenant/0002_break.sql failed in tenant_broken: relation "does_not_exist" does not exist ' +
        "(SQLSTATE 42P01, line 4). The transaction of tenant_broken was rolled back: nothing of it is applied or " +
        "recorded (a schema it was creating does not exist); files committed before it stay applied.\n",
    );
    expect(await schemaExists("tenant_broken")).toBe(false);

    const error = await migrateTenantSchema({
      schema: "tenant_broken",
      dir,
      url: db.provisionerUrl,
      create: true,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TenantMigrationFailedError);
    expect(error).toMatchObject({ exitCode: 1, schema: "tenant_broken", file: "0002_break.sql" });
    expect(await schemaExists("tenant_broken")).toBe(false);
  });

  it("exits 2 and applies nothing after an applied tenant file was edited", async () => {
    const dir = await tenantFolder({ [LOYALTY_FILE]: LOYALTY_SQL });
    expect((await cli(["tenant", "--schema", "tenant_edit", "--dir", dir, "--create"])).code).toBe(0);
    const before = await ledger("tenant_edit");
    const appliedChecksum = await sha256(join(dir, LOYALTY_FILE));
    await writeFile(join(dir, LOYALTY_FILE), `${LOYALTY_SQL}-- edited after it was merged\n`);
    await writeFile(
      join(dir, "0003_create_notes.sql"),
      expand("Create the notes", "CREATE TABLE notes (id text);"),
    );

    const run = await cli(["tenant", "--schema", "tenant_edit", "--dir", dir]);
    expect(run.code).toBe(2);
    expect(run.events).toEqual([
      expect.objectContaining({
        schema: "tenant_edit",
        file: LOYALTY_FILE,
        status: "checksum_mismatch",
        appliedChecksum,
        checksum: await sha256(join(dir, LOYALTY_FILE)),
      }),
    ]);
    expect(run.stderr).toMatch(
      /^migrate: 1 applied tenant migration file\(s\) changed since they were applied to tenant_edit: 0002_add_loyalty_cards\.sql\. Nothing was applied to tenant_edit\./,
    );
    expect(await ledger("tenant_edit")).toEqual(before);
    expect(await tablesOf("tenant_edit")).not.toContain("notes");
    await expect(
      migrateTenantSchema({ schema: "tenant_edit", dir, url: db.migratorUrl }),
    ).rejects.toBeInstanceOf(TenantChecksumMismatchError);
  });

  it("refuses a missing schema without --create, and schemas that provisioning did not create", async () => {
    const missing = await cli(["tenant", "--schema", "tenant_nowhere", "--dir", TENANT_DIR]);
    expect(missing).toMatchObject({ code: 1, stdout: "" });
    expect(missing.stderr).toContain("Tenant schema tenant_nowhere does not exist");
    expect(await schemaExists("tenant_nowhere")).toBe(false);

    // Owned by another role: left alone, even with --create.
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE velexis_migrator");
    await db.query("CREATE SCHEMA tenant_foreign");
    await db.query("COMMIT");
    const foreign = await cli(["tenant", "--schema", "tenant_foreign", "--dir", TENANT_DIR, "--create"]);
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain(
      "Tenant schema tenant_foreign belongs to velexis_migrator, not velexis_provisioner",
    );
    expect(await tablesOf("tenant_foreign")).toEqual([]);

    // Relations without a ledger ("foreign content", OADR-0007): left alone.
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE velexis_provisioner");
    await db.query("CREATE SCHEMA tenant_stray");
    await db.query("CREATE TABLE tenant_stray.leftovers (id int)");
    await db.query("COMMIT");
    const stray = await cli(["tenant", "--schema", "tenant_stray", "--dir", TENANT_DIR, "--create"]);
    expect(stray.code).toBe(1);
    expect(stray.stderr).toContain("Tenant schema tenant_stray holds 1 relation but no");
    expect(await tablesOf("tenant_stray")).toEqual(["leftovers"]);
    const strayError = await migrateTenantSchema({
      schema: "tenant_stray",
      dir: TENANT_DIR,
      url: db.migratorUrl,
      create: true,
    }).catch((thrown: unknown) => thrown);
    expect(strayError).toBeInstanceOf(TenantSchemaError);
    expect(strayError).toMatchObject({ schema: "tenant_stray", problem: "foreign_content", exitCode: 1 });

    // An orphan empty schema of the provisioner (a crash between steps) is completed.
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE velexis_provisioner");
    await db.query("CREATE SCHEMA tenant_orphan");
    await db.query("COMMIT");
    const orphan = await cli(["tenant", "--schema", "tenant_orphan", "--dir", TENANT_DIR, "--create"]);
    expect(orphan).toMatchObject({ code: 0, stderr: "" });
    expect(await tablesOf("tenant_orphan")).toEqual(await repositoryTenantTables());
  });

  it("runs every file as velexis_provisioner with the timeouts, the advisory lock and the schema's search_path, in and outside a transaction", async () => {
    const capture = (kind: string): string =>
      `SELECT '${kind}'::text AS kind, current_user::text AS role, session_user::text AS login, ` +
      "current_setting('search_path') AS search_path, current_setting('lock_timeout') AS lock_timeout, " +
      "current_setting('statement_timeout') AS statement_timeout, " +
      "(SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted)::int " +
      "AS advisory_locks, now() = statement_timestamp() AS own_transaction";
    const dir = await tenantFolder({
      "0002_capture_settings.sql": expand(
        "Capture the settings of the tenant transaction",
        // A session-level change by a file must not reach the transactions after it.
        "SET statement_timeout = '1h';",
        `CREATE TABLE runner_settings AS ${capture("transaction")};`,
      ),
      "0003_capture_session.sql":
        "-- velexis:phase expand\n-- velexis:no-transaction\n-- Capture the settings of the dedicated connection\n" +
        `INSERT INTO runner_settings ${capture("session")};\n`,
      "0004_capture_again.sql": expand(
        "Capture the settings of the next transaction",
        `INSERT INTO runner_settings ${capture("next")};`,
      ),
    });
    const run = await cli(["tenant", "--schema", "tenant_settings", "--dir", dir, "--create"]);
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(run.events.map((event) => [event.id, event.transaction])).toEqual([
      ["0001_baseline", true],
      ["0002_capture_settings", true],
      ["0003_capture_session", false],
      ["0004_capture_again", true],
    ]);
    const settings = {
      role: PROVISIONER,
      login: "velexis_migrator",
      search_path: "tenant_settings, reference",
      lock_timeout: "5s",
      advisory_locks: 1,
    };
    expect(await db.query("SELECT * FROM tenant_settings.runner_settings ORDER BY kind")).toEqual([
      // The session-level SET of 0002 survives on the runner's connection, but every tenant transaction sets
      // statement_timeout again.
      { kind: "next", ...settings, statement_timeout: "10min", own_transaction: false },
      // The no-transaction file runs alone (now() is its own statement's time): no transaction around it.
      { kind: "session", ...settings, statement_timeout: "10min", own_transaction: true },
      { kind: "transaction", ...settings, statement_timeout: "1h", own_transaction: false },
    ]);
    expect(await runnerSessions()).toBe(0);
  });

  it("serialises two runs on the same schema with the advisory lock: the second applies nothing", async () => {
    const waiting = async (): Promise<number> => {
      const [row] = await db.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
          "WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = $1",
        [db.name],
      );
      return row?.waiting ?? -1;
    };
    // Hold the schema's lock, so both runs queue on it (they wait up to lock_timeout = 5s).
    await withClient(db.adminUrl, async (holder) => {
      await holder.query("SELECT pg_advisory_lock(hashtext('tenant_twice'))");
      const runs = [
        migrateTenantSchema({
          schema: "tenant_twice",
          dir: TENANT_DIR,
          url: db.provisionerUrl,
          create: true,
        }),
        migrateTenantSchema({ schema: "tenant_twice", dir: TENANT_DIR, url: db.migratorUrl, create: true }),
      ];
      runs.forEach((run) => void run.catch(() => undefined));
      await expect.poll(waiting, { timeout: 4_000, interval: 20 }).toBe(2);
      await holder.query("SELECT pg_advisory_unlock(hashtext('tenant_twice'))");
      const results = await Promise.all(runs);
      // The first applies the baseline, 0002 and 0003; the second, once it gets the lock, finds nothing pending.
      expect(results.map((result) => [result.created, result.applied.length]).sort()).toEqual([
        [false, 0],
        [true, 3],
      ]);
    });
    expect(await ledger("tenant_twice")).toHaveLength(3);
    expect(await ownersOf("tenant_twice")).toEqual([PROVISIONER]);
  });
});

describe("migrateTenantSchema beforeCommit on PostgreSQL (OADR-0007 item 2)", () => {
  interface TransactionFacts {
    readonly role: string;
    readonly search_path: string;
    readonly lock_timeout: string;
    readonly advisory_locks: number;
    readonly xid: string;
  }

  /** What a beforeCommit callback records about the transaction it runs in. */
  const transactionFacts = sql<TransactionFacts>`SELECT current_user::text AS role,
    current_setting('search_path') AS search_path, current_setting('lock_timeout') AS lock_timeout,
    (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted)::int
      AS advisory_locks,
    pg_current_xact_id()::xid::text AS xid`;

  /** The ids of the transactions that wrote the ledger rows of `schema`. */
  async function ledgerXids(schema: string): Promise<string[]> {
    const rows = await db.query<{ xid: string }>(
      `SELECT DISTINCT xmin::text AS xid FROM ${pg.escapeIdentifier(schema)}.schema_migrations`,
    );
    return rows.map((row) => row.xid);
  }

  it("runs in the transaction of the files, after them and before COMMIT, as velexis_provisioner under the lock", async () => {
    const seen: Array<{
      created: boolean;
      schema: string;
      facts: TransactionFacts | undefined;
      emails: string[];
    }> = [];
    const migrate = () =>
      migrateTenantSchema({
        schema: "tenant_hooked",
        dir: TENANT_DIR,
        url: db.provisionerUrl,
        create: true,
        beforeCommit: async ({ schema, created, db: trx }) => {
          // The baseline's tables resolve unqualified through the transaction's search_path.
          await trx
            .insertInto("customers")
            .values({
              id: `cus_01J9ZK3V5Q8X2M4N6P7R9S1T${seen.length === 0 ? "4Y" : "5Z"}`,
              email: `hook${seen.length}@example.com`,
              first_name: "Hook",
              last_name: "Seed",
            })
            .execute();
          const { rows } = await transactionFacts.execute(trx);
          const customers = await trx.selectFrom("customers").select("email").orderBy("email").execute();
          seen.push({ created, schema, facts: rows[0], emails: customers.map((row) => row.email) });
        },
      });

    const first = await migrate();

    expect(first).toMatchObject({ created: true, upToDate: 0 });
    expect(first.applied.map((event) => event.id)).toEqual([
      "0001_baseline",
      TENANT_MIGRATION_0002.id,
      TENANT_MIGRATION_0003.id,
    ]);
    expect(seen).toEqual([
      {
        created: true,
        schema: "tenant_hooked",
        facts: {
          role: PROVISIONER,
          search_path: "tenant_hooked, reference",
          lock_timeout: "5s",
          advisory_locks: 1,
          xid: expect.stringMatching(/^\d+$/),
        },
        emails: ["hook0@example.com"],
      },
    ]);
    // The ledger rows of both files were written by the transaction the callback ran in, and all of it committed.
    expect(await ledgerXids("tenant_hooked")).toEqual([seen[0]?.facts?.xid]);
    const committed = await asOtaApp(
      "tenant_hooked",
      async (client) => (await client.query("SELECT email FROM customers")).rows,
    );
    expect(committed).toEqual([{ email: "hook0@example.com" }]);

    // A re-run applies nothing, still reaches the callback, and reports the schema as existing.
    const second = await migrate();
    expect(second).toMatchObject({ created: false, applied: [], upToDate: 3 });
    expect(seen.map(({ created, emails }) => [created, emails])).toEqual([
      [true, ["hook0@example.com"]],
      [false, ["hook0@example.com", "hook1@example.com"]],
    ]);
    expect(await runnerSessions()).toBe(0);
  });

  it("rolls the whole transaction back when it throws: a schema being created does not exist, a pending file is not applied", async () => {
    const crash = new Error("crash injected before COMMIT");
    const failing = async ({ db: trx }: { db: Kysely<TenantDatabase> }): Promise<void> => {
      await trx
        .insertInto("customers")
        .values({
          id: "cus_01J9ZK3V5Q8X2M4N6P7R9S1T4Y",
          email: "a@example.com",
          first_name: "A",
          last_name: "B",
        })
        .execute();
      throw crash;
    };
    const dir = await tenantFolder({}, "repository");

    await expect(
      migrateTenantSchema({
        schema: "tenant_crashed",
        dir,
        url: db.provisionerUrl,
        create: true,
        beforeCommit: failing,
      }),
    ).rejects.toBe(crash);
    expect(await schemaExists("tenant_crashed")).toBe(false);

    // On an existing schema, the pending file goes with the rest: ledger and tables stay as they were.
    await migrateTenantSchema({ schema: "tenant_crashed", dir, url: db.provisionerUrl, create: true });
    const before = await ledger("tenant_crashed");
    await writeFile(
      join(dir, "0002_create_notes.sql"),
      expand("Create the notes", "CREATE TABLE notes (id text);"),
    );
    const events: TenantMigrationFileEvent[] = [];
    await expect(
      migrateTenantSchema({
        schema: "tenant_crashed",
        dir,
        url: db.provisionerUrl,
        beforeCommit: failing,
        onFile: (event) => events.push(event),
      }),
    ).rejects.toBe(crash);
    expect(await ledger("tenant_crashed")).toEqual(before);
    expect(await tablesOf("tenant_crashed")).not.toContain("notes");
    expect(await db.query("SELECT count(*)::int AS customers FROM tenant_crashed.customers")).toEqual([
      { customers: 0 },
    ]);
    // No applied event names the rolled-back file.
    expect(events).toEqual([]);
    expect(await runnerSessions()).toBe(0);
  });

  it("refuses transaction control from the callback, and the run then rolls back", async () => {
    const refused: unknown[] = [];
    await expect(
      migrateTenantSchema({
        schema: "tenant_control",
        dir: await tenantFolder(),
        url: db.provisionerUrl,
        create: true,
        beforeCommit: async ({ db: trx }) => {
          refused.push(
            await trx
              .transaction()
              .execute(() => Promise.resolve())
              .catch((error: unknown) => error),
          );
          await sql`COMMIT`.execute(trx);
        },
      }),
    ).rejects.toThrow(/BEGIN, COMMIT, ROLLBACK and the other transaction statements are refused/);
    expect(refused).toEqual([expect.objectContaining({ name: "TypeError" })]);
    expect(await schemaExists("tenant_control")).toBe(false);
  });

  it("runs once, in the last transaction, after a no-transaction file and the files after it", async () => {
    const order: string[] = [];
    const dir = await tenantFolder({
      [LOYALTY_FILE]: LOYALTY_SQL,
      [LOYALTY_INDEX_FILE]: LOYALTY_INDEX_SQL,
      "0004_create_notes.sql": expand("Create the notes", "CREATE TABLE notes (id text);"),
    });

    const result = await migrateTenantSchema({
      schema: "tenant_segments",
      dir,
      url: db.provisionerUrl,
      create: true,
      onFile: (event) => order.push(event.id),
      beforeCommit: async ({ created, db: trx }) => {
        const { rows } = await sql<{
          notes: string | null;
        }>`SELECT to_regclass('notes')::text AS notes`.execute(trx);
        order.push(`beforeCommit created=${String(created)} notes=${String(rows[0]?.notes)}`);
      },
    });

    expect(result.created).toBe(true);
    // Events are emitted after each transaction commits; the callback runs before the last COMMIT.
    expect(order).toEqual([
      "0001_baseline",
      "0002_add_loyalty_cards",
      "0003_index_loyalty_cards",
      "beforeCommit created=true notes=notes",
      "0004_create_notes",
    ]);
  });
});

describe("migrateTenants and migrate.js tenants on PostgreSQL", () => {
  it("applies a later file as velexis_migrator: the table belongs to velexis_provisioner and velexis_ota_app writes it without a GRANT [X-013 AC3]", async () => {
    const dir = await tenantFolder({}, "repository");
    const schema = await provisionTenant("alpha", dir);
    await writeFile(join(dir, LOYALTY_FILE), LOYALTY_SQL);
    await writeFile(join(dir, LOYALTY_INDEX_FILE), LOYALTY_INDEX_SQL);
    expect(LOYALTY_SQL + LOYALTY_INDEX_SQL).not.toMatch(/grant|velexis_/i);

    const run = await cli(["tenants", "--dir", dir]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.events.map((event) => [event.schema, event.file, event.status, event.transaction])).toEqual([
      [schema, LOYALTY_FILE, "applied", true],
      [schema, LOYALTY_INDEX_FILE, "applied", false],
    ]);
    expect((await ledger(schema)).map((row) => [row.id, row.status])).toEqual([
      ["0001_baseline", "applied"],
      ["0002_add_loyalty_cards", "applied"],
      ["0003_index_loyalty_cards", "applied"],
    ]);

    // Applied by velexis_migrator, owned by velexis_provisioner: the table, its sequence and its indexes.
    expect(
      await db.query(
        "SELECT c.relname AS name, c.relkind AS kind, c.relowner::regrole::text AS owner FROM pg_class c " +
          "WHERE c.relnamespace = $1::regnamespace AND c.relname LIKE 'loyalty%' ORDER BY 1",
        [schema],
      ),
    ).toEqual([
      { name: "loyalty_card_numbers", kind: "S", owner: PROVISIONER },
      { name: "loyalty_cards", kind: "r", owner: PROVISIONER },
      { name: "loyalty_cards_customer_idx", kind: "i", owner: PROVISIONER },
      { name: "loyalty_cards_pkey", kind: "i", owner: PROVISIONER },
    ]);
    expect(
      await db.query("SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = $1::regclass", [
        `${schema}.loyalty_cards_customer_idx`,
      ]),
    ).toEqual([{ valid: true }]);

    // velexis_ota_app writes the new table and uses the new sequence through the default privileges.
    const rows = await asOtaApp(schema, async (client) => {
      await client.query(CUSTOMER, ["cus_01J9ZK3V5Q8X2M4N6P7R9S1T7B", "loyal@example.com"]);
      await client.query(
        "INSERT INTO loyalty_cards (id, customer_id, points) VALUES ('lyc_1', 'cus_01J9ZK3V5Q8X2M4N6P7R9S1T7B', nextval('loyalty_card_numbers'))",
      );
      await client.query("UPDATE loyalty_cards SET points = points + 10 WHERE id = 'lyc_1'");
      const { rows: cards } = await client.query("SELECT id, points FROM loyalty_cards");
      await client.query("DELETE FROM loyalty_cards WHERE id = 'lyc_1'");
      return cards;
    });
    expect(rows).toEqual([{ id: "lyc_1", points: 11 }]);
    // The no-transaction file ran on a dedicated connection that is closed again.
    expect(await runnerSessions()).toBe(0);
  });

  it("migrates 9 of 10 schemas when one has a conflicting table, reports the failure and exits 0 [X-013 AC4]", async () => {
    const dir = await tenantFolder();
    const keys = Array.from({ length: 10 }, (_, index) => `ota${String(index + 1).padStart(2, "0")}`);
    const schemas: string[] = [];
    for (const key of keys) {
      schemas.push(await provisionTenant(key, dir));
    }
    // tenant_ota07 already has a table of the name the next file creates.
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE velexis_provisioner");
    await db.query("CREATE TABLE tenant_ota07.loyalty_cards (id int)");
    await db.query("COMMIT");
    await writeFile(join(dir, LOYALTY_FILE), LOYALTY_SQL);
    const reportPath = join(await scratchFolder(), "migrate-report.json");

    const run = await cli(["tenants", "--dir", dir, "--report", reportPath]);
    expect(run.code).toBe(0);
    // Written atomically through a temporary file that is gone again, readable by its owner only.
    expect(await readdir(dirname(reportPath))).toEqual(["migrate-report.json"]);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    const report = await readReport(reportPath);
    expect(report).toMatchObject({ target: "0002_add_loyalty_cards", total: 10, skipped: [] });
    expect(report.applied.map((entry) => [entry.schema, entry.files.map((file) => file.file)])).toEqual(
      schemas.filter((schema) => schema !== "tenant_ota07").map((schema) => [schema, [LOYALTY_FILE]]),
    );
    expect(report.failed).toEqual([
      {
        schema: "tenant_ota07",
        file: LOYALTY_FILE,
        // CREATE TABLE fails in the catalog, not in the parser: PostgreSQL gives no position, so no line.
        error: { message: 'relation "loyalty_cards" already exists', code: "42P07" },
        exitCode: 1,
      },
    ]);
    expect(run.events.filter((event) => event.status === "applied")).toHaveLength(9);
    expect(run.events.filter((event) => event.status === "failed").map((event) => event.schema)).toEqual([
      "tenant_ota07",
    ]);
    expect(run.stderr).toBe(
      'migrate: tenant_ota07 0002_add_loyalty_cards.sql failed: relation "loyalty_cards" already exists (SQLSTATE 42P07)\n' +
        "migrate: 1 of 10 tenant schema(s) failed (10 %), within --max-failure-ratio 0.1\n",
    );

    for (const schema of schemas) {
      const ids = (await ledger(schema)).map((row) => row.id);
      expect(ids).toEqual(
        schema === "tenant_ota07" ? ["0001_baseline"] : ["0001_baseline", "0002_add_loyalty_cards"],
      );
    }
    // The failed schema kept its own table untouched.
    expect(
      await db.query(
        "SELECT attname FROM pg_attribute WHERE attrelid = 'tenant_ota07.loyalty_cards'::regclass AND attnum > 0",
      ),
    ).toEqual([{ attname: "id" }]);
  });

  it("exits 3 when one of 3 schemas fails (33 % > 10 %) [X-013 AC5]", async () => {
    const dir = await tenantFolder();
    for (const key of ["one", "two", "three"]) {
      await provisionTenant(key, dir);
    }
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE velexis_provisioner");
    await db.query("CREATE TABLE tenant_two.loyalty_cards (id int)");
    await db.query("COMMIT");
    await writeFile(join(dir, LOYALTY_FILE), LOYALTY_SQL);
    const reportPath = join(await scratchFolder(), "report.json");

    const run = await cli(["tenants", "--dir", dir, "--report", reportPath]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain(
      "migrate: 1 of 3 tenant schema(s) failed (33.3 %), more than --max-failure-ratio 0.1 allows\n",
    );
    const report = await readReport(reportPath);
    expect(report.total).toBe(3);
    // ORDER BY key: one, three, two.
    expect(report.applied.map((entry) => entry.schema)).toEqual(["tenant_one", "tenant_three"]);
    expect(report.failed.map((entry) => [entry.schema, entry.file])).toEqual([["tenant_two", LOYALTY_FILE]]);

    // The library returns the same exit code; a higher ratio lets the same failure pass.
    const library = await migrateTenants({ dir, url: db.migratorUrl });
    expect(library).toMatchObject({ exitCode: 3, failureRatio: 1 / 3 });
    const tolerant = await cli(["tenants", "--dir", dir, "--max-failure-ratio", "0.5"]);
    expect(tolerant.code).toBe(0);
    expect(tolerant.stderr).toContain("within --max-failure-ratio 0.5");
  });

  it("never migrates more schemas at the same time than the concurrency allows [X-013 AC6]", async () => {
    const dir = await tenantFolder();
    for (let index = 1; index <= 7; index += 1) {
      await provisionTenant(`par${index}`, dir);
    }
    await writeFile(join(dir, LOYALTY_FILE), LOYALTY_SQL);

    for (const concurrency of [3, 1, 4]) {
      let active = 0;
      let peak = 0;
      const started: string[] = [];
      const ended: string[] = [];
      const result = await migrateTenants({
        dir,
        url: db.migratorUrl,
        concurrency,
        onSchemaStart: (schema) => {
          started.push(schema);
          active += 1;
          peak = Math.max(peak, active);
        },
        onSchemaEnd: ({ schema, status }) => {
          expect(status).toBe("applied");
          ended.push(schema);
          active -= 1;
        },
      });
      expect(result.exitCode).toBe(0);
      expect(peak).toBe(concurrency);
      expect(active).toBe(0);
      expect(started).toEqual(Array.from({ length: 7 }, (_, index) => `tenant_par${index + 1}`));
      expect([...ended].sort()).toEqual(started);
    }
    expect(await runnerSessions()).toBe(0);
  });

  it("applies nothing on a second run, and reports every schema as migrated [X-013 AC7]", async () => {
    const dir = await tenantFolder();
    const schemas = [await provisionTenant("first", dir), await provisionTenant("second", dir)];
    await writeFile(join(dir, LOYALTY_FILE), LOYALTY_SQL);
    const first = await cli(["tenants", "--dir", dir]);
    expect(first.code).toBe(0);
    // Two schemas run at the same time, so their lines may come in either order.
    expect(first.events.map((event) => [event.schema, event.id]).sort()).toEqual(
      schemas.map((schema) => [schema, "0002_add_loyalty_cards"]),
    );
    const ledgers = await Promise.all(schemas.map((schema) => ledger(schema)));

    const reportPath = join(await scratchFolder(), "again.json");
    const second = await cli(["tenants", "--dir", dir, "--report", reportPath]);
    expect(second).toEqual({ code: 0, stdout: "", stderr: "", events: [] });
    expect(await readReport(reportPath)).toEqual({
      target: "0002_add_loyalty_cards",
      total: 2,
      applied: schemas.map((schema) => ({ schema, files: [] })),
      failed: [],
      skipped: [],
    });
    expect(await Promise.all(schemas.map((schema) => ledger(schema)))).toEqual(ledgers);
  });

  it("targets provisioning, active and suspended tenants only, and skips a provisioning tenant without a schema", async () => {
    const dir = await tenantFolder();
    const active = await provisionTenant("live", dir);
    // Provisioned, then suspended: still migrated.
    const suspended = await provisionTenant("paused", dir);
    await withClient(db.platformUrl, (client) =>
      client.query("UPDATE platform.tenants SET status = 'suspended' WHERE key = 'paused'"),
    );
    // Signed up, schema not created yet: provisioning will apply every file.
    const fresh = await addTenant("fresh", "provisioning");
    // Deleted and failed tenants are not targets, whether their schema exists or not.
    await provisionTenant("gone", dir);
    await withClient(db.platformUrl, (client) =>
      client.query("UPDATE platform.tenants SET status = 'deleted' WHERE key = 'gone'"),
    );
    await addTenant("broken", "failed");
    await writeFile(join(dir, LOYALTY_FILE), LOYALTY_SQL);
    const reportPath = join(await scratchFolder(), "report.json");

    const run = await cli(["tenants", "--dir", dir, "--report", reportPath]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe(
      "migrate: notice: tenant_fresh skipped: the tenant is provisioning and its schema does not exist yet; " +
        "provisioning applies every file\n",
    );
    const report = await readReport(reportPath);
    expect(report.total).toBe(3);
    expect(report.applied.map((entry) => entry.schema)).toEqual([active, suspended]);
    expect(report.skipped.map((entry) => entry.schema)).toEqual([fresh]);
    expect(report.failed).toEqual([]);
    expect((await ledger("tenant_gone")).map((row) => row.id)).toEqual(["0001_baseline"]);
    expect(await schemaExists(fresh)).toBe(false);

    // An active tenant without a schema is a failure, not a skip.
    const ghost = await addTenant("ghost", "active");
    const again = await cli(["tenants", "--dir", dir, "--report", reportPath]);
    expect(again.code).toBe(3);
    expect((await readReport(reportPath)).failed).toEqual([
      {
        schema: ghost,
        file: null,
        error: {
          message: `Tenant schema ${ghost} does not exist; provisioning creates it (migrate.js tenant --create)`,
        },
        exitCode: 1,
      },
    ]);
    expect(again.stderr).toContain(`migrate: ${ghost} failed: Tenant schema ${ghost} does not exist`);
  });

  it("completes an empty orphan schema with the grants of velexis_ota_app, also without --create", async () => {
    const dir = await tenantFolder({ [LOYALTY_FILE]: LOYALTY_SQL });
    // Empty schemas of the provisioner, as a crash between CREATE SCHEMA and the files would leave them.
    const orphans = [await addTenant("orphan", "provisioning"), "tenant_spare"];
    for (const schema of orphans) {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE velexis_provisioner");
      await db.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await db.query("COMMIT");
    }
    const [fanned, single] = orphans as [string, string];

    const run = await cli(["tenants", "--dir", dir]);
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(run.events.map((event) => [event.schema, event.id, event.status])).toEqual([
      [fanned, "0001_baseline", "applied"],
      [fanned, "0002_add_loyalty_cards", "applied"],
    ]);
    const solo = await cli(["tenant", "--schema", single, "--dir", dir]);
    expect(solo).toMatchObject({ code: 0, stderr: "" });
    expect(solo.events.map((event) => [event.schema, event.id])).toEqual([
      [single, "0001_baseline"],
      [single, "0002_add_loyalty_cards"],
    ]);

    for (const [index, schema] of orphans.entries()) {
      expect(await ownersOf(schema)).toEqual([PROVISIONER]);
      const customer = `cus_01J9ZK3V5Q8X2M4N6P7R9S1T8${index}`;
      const cards = await asOtaApp(schema, async (client) => {
        await client.query(CUSTOMER, [customer, `orphan${index}@example.com`]);
        await client.query("INSERT INTO loyalty_cards (id, customer_id) VALUES ('lyc_1', $1)", [customer]);
        return (await client.query("SELECT id FROM loyalty_cards")).rows;
      });
      expect(cards).toEqual([{ id: "lyc_1" }]);
      // The default privileges are there for the tables of later releases.
      expect(
        await db.query(
          "SELECT d.defaclobjtype AS type FROM pg_default_acl d WHERE d.defaclnamespace = $1::regnamespace " +
            "AND d.defaclrole = 'velexis_provisioner'::regrole ORDER BY 1",
          [schema],
        ),
      ).toEqual([{ type: "S" }, { type: "r" }]);
    }
  });

  it("counts a checksum mismatch as a failed schema with exit code 2 in the report", async () => {
    const dir = await tenantFolder({ [LOYALTY_FILE]: LOYALTY_SQL });
    const schema = await provisionTenant("edited", dir);
    await writeFile(join(dir, LOYALTY_FILE), `${LOYALTY_SQL}-- edited\n`);
    const result = await migrateTenants({ dir, url: db.migratorUrl });
    expect(result.exitCode).toBe(3);
    expect(result.report?.failed).toEqual([
      {
        schema,
        file: LOYALTY_FILE,
        error: { message: expect.stringContaining("changed since they were applied to tenant_edited") },
        exitCode: 2,
      },
    ]);
  });

  it("prints a notice, connects to nothing and writes no report for a missing --dir", async () => {
    const missing = join(await scratchFolder(), "tenant");
    const reportPath = join(await scratchFolder(), "report.json");
    const run = await runMigrateCli(["tenants", "--dir", missing, "--report", reportPath], {
      stdout: { write: () => true },
      stderr: { write: () => true },
      env: { APP_ENV: "production" },
    });
    expect(run).toBe(0);
    await expect(readFile(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await migrateTenants({ dir: missing, url: "postgres://nobody@127.0.0.1:1/none" });
    expect(result).toEqual({ dir: missing, dirExists: false, report: null, failureRatio: 0, exitCode: 0 });
    await expect(
      migrateTenantSchema({ schema: "tenant_none", dir: missing, url: "postgres://nobody@127.0.0.1:1/none" }),
    ).resolves.toMatchObject({ dirExists: false, created: false, applied: [] });
  });
});
