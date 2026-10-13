// The baseline migrations and the OTA read grants on PostgreSQL 16 (X-012; ADR-0004 Database roles, ADR-0005
// Baselines, ADR-0021).
//
// One fresh database `velexis_dbtest_<random>` for this file, created as TEST_DATABASE_ADMIN_URL and bootstrapped
// like deploy/postgres/bootstrap.sql: its database section needs psql variables and superuser rights, so it is
// mirrored below; the statements after `\connect :db_name` (base schemas, USAGE, default privileges) are read
// from bootstrap.sql itself and run as velexis_migrator. Then, in beforeAll:
//   - the platform and reference sets are applied as `pnpm db:migrate` applies them: the commands of the
//     `migrate` script of packages/db/package.json, through runMigrateCli, as velexis_migrator;
//   - the tenant set is applied to tenant_alpha through the runner library (readMigrationFiles, recordMigration)
//     in one provisioning transaction as velexis_provisioner (db README §3; migrateTenantSchema of X-013 replaces
//     this helper);
//   - velexis_platform_app adds a plan, an account and a tenant.
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

/** The tables a reference DDL file creates, sorted (without the schema prefix). */
async function ddlTables(file: string): Promise<string[]> {
  const ddl = await readFile(join(REFERENCE_DDL, file), "utf8");
  return [...ddl.matchAll(/^CREATE TABLE (?:[a-z]+\.)?([a-z_]+) \(/gm)].map((match) => match[1] ?? "").sort();
}

const denied = (table: string) => ({ code: "42501", message: `permission denied for table ${table}` });

describe("the baselines and the OTA read grants on PostgreSQL", () => {
  it("applies the platform and reference baselines: 16 and 7 tables, each set with its ledger [X-012 AC1]", async () => {
    const platformTables = await ddlTables("platform.sql");
    const referenceTables = await ddlTables("reference.sql");
    expect(platformTables).toHaveLength(16);
    expect(referenceTables).toHaveLength(7);
    expect(await tablesOf("platform")).toEqual([...platformTables, "schema_migrations"].sort());
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

  it("applies the tenant set to tenant_alpha through the runner library: 42 tables owned by velexis_provisioner [X-012 AC1]", async () => {
    const tenantTables = await ddlTables("tenant.sql");
    expect(tenantTables).toHaveLength(42);
    expect(tenantTables).toContain("schema_migrations");
    expect(await tablesOf(TENANT)).toEqual(tenantTables);

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
    const { rows: plans } = await ota.query("SELECT code FROM platform.plans");
    expect(plans).toEqual([{ code: "starter" }]);
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
    expect(tableGrants).toEqual(OTA_READABLE_TABLES.map((table) => ({ table, privilege: "SELECT" })));

    const columnGrants = await catalog(
      "SELECT c.relname AS table, att.attname AS column, a.privilege_type AS privilege FROM pg_attribute att " +
        "JOIN pg_class c ON c.oid = att.attrelid CROSS JOIN LATERAL aclexplode(att.attacl) a " +
        "WHERE c.relnamespace = 'platform'::regnamespace AND a.grantee = 'velexis_ota_app'::regrole " +
        "ORDER BY att.attnum",
    );
    expect(columnGrants).toEqual(
      OTA_READABLE_ACCOUNT_COLUMNS.map((column) => ({ table: "accounts", column, privilege: "SELECT" })),
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
    expect(targets).toHaveLength(17);
    for (const { table, column } of targets) {
      const update =
        `UPDATE platform.${pg.escapeIdentifier(table)} ` +
        `SET ${pg.escapeIdentifier(column)} = ${pg.escapeIdentifier(column)} WHERE false`;
      await expect(ota.query(update)).rejects.toMatchObject(denied(table));
      await expect(
        ota.query(`DELETE FROM platform.${pg.escapeIdentifier(table)} WHERE false`),
      ).rejects.toMatchObject(denied(table));
      // The same statement is valid: the platform role runs it.
      await expect(platformApp.query(update)).resolves.toMatchObject({ rowCount: 0 });
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
