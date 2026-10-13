// The migration runner and migrate.js against PostgreSQL 16 (X-011).
//
// Every test gets a fresh database `velexis_dbtest_<random>`, created as TEST_DATABASE_ADMIN_URL and prepared
// like deploy/postgres/bootstrap.sql (owner velexis_migrator, the database grants, empty `platform` and
// `reference` schemas with their default privileges). The runner connects as velexis_migrator through
// DATABASE_MIGRATOR_URL with the database name swapped, as `pnpm db:migrate` and velexis-deploy do.
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrateCli } from "../../src/cli/migrate.js";
import {
  ChecksumMismatchError,
  MigrationFailedError,
  MigrationFilesError,
  runMigrations,
  splitSqlStatements,
  type MigrationFileEvent,
  type SharedMigrationSet,
} from "../../src/migrate/index.js";

const REFERENCE_DDL = resolve(__dirname, "..", "..", "..", "..", "docs", "velexis-sdk", "db");

function testUrls(): { admin: string; migrator: string } {
  loadDevEnvFiles({ appDir: resolve(__dirname, "..", "..") });
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

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: "velexis-db-int-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

interface FreshDatabase {
  readonly name: string;
  /** DATABASE_MIGRATOR_URL on this database (role velexis_migrator). */
  readonly migratorUrl: string;
  /** TEST_DATABASE_ADMIN_URL on this database (velexis_test_admin, member of velexis_migrator). */
  readonly adminUrl: string;
  /** Runs a query as velexis_test_admin on this database, on one connection kept for the test. */
  query<R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<R[]>;
  /** Closes that connection and drops the database. */
  drop(): Promise<void>;
}

/** A database prepared like deploy/postgres/bootstrap.sql, without any table. */
async function createFreshDatabase(): Promise<FreshDatabase> {
  const urls = testUrls();
  const name = `velexis_dbtest_${randomBytes(6).toString("hex")}`;
  const database = pg.escapeIdentifier(name);
  await withClient(urls.admin, async (client) => {
    await client.query(
      `CREATE DATABASE ${database} OWNER velexis_migrator ENCODING 'UTF8' ` +
        `LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0`,
    );
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO velexis_platform_app, velexis_ota_app`,
    );
    await client.query(`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${database} TO velexis_provisioner`);
    await client.query(`GRANT ALL ON DATABASE ${database} TO velexis_migrator`);
  });
  const adminUrl = withDatabase(urls.admin, name);
  const admin = new pg.Client({ connectionString: adminUrl, application_name: "velexis-db-int-test" });
  const fresh: FreshDatabase = {
    name,
    migratorUrl: withDatabase(urls.migrator, name),
    adminUrl,
    query: async (text, values) => (await admin.query(text, values)).rows,
    drop: async () => {
      await admin.end().catch(() => undefined);
      await withClient(
        urls.admin,
        async (client) => void (await client.query(`DROP DATABASE IF EXISTS ${database}`)),
      );
    },
  };
  try {
    await admin.connect();
    // The \connect part of bootstrap.sql: base schemas owned by the migrator and the default privileges.
    await admin.query("BEGIN");
    await admin.query("SET LOCAL ROLE velexis_migrator");
    await admin.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    await admin.query("CREATE SCHEMA platform AUTHORIZATION velexis_migrator");
    await admin.query("CREATE SCHEMA reference AUTHORIZATION velexis_migrator");
    await admin.query("GRANT USAGE ON SCHEMA platform, reference TO velexis_platform_app");
    await admin.query("GRANT USAGE ON SCHEMA platform, reference TO velexis_ota_app");
    for (const schema of ["platform", "reference"]) {
      await admin.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA ${schema} ` +
          "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velexis_platform_app",
      );
      await admin.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA ${schema} ` +
          "GRANT USAGE, SELECT ON SEQUENCES TO velexis_platform_app",
      );
    }
    await admin.query(
      "ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA reference GRANT SELECT ON TABLES TO velexis_ota_app",
    );
    await admin.query("COMMIT");
  } catch (error) {
    await fresh.drop();
    throw error;
  }
  return fresh;
}

const folders: string[] = [];
let db: FreshDatabase;

beforeEach(async () => {
  db = await createFreshDatabase();
});

afterEach(async () => {
  await db?.drop();
});

afterAll(async () => {
  await Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A migration folder with `files` (name → SQL). */
async function migrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-migrate-int-"));
  folders.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(dir, name), sql);
  }
  return dir;
}

const expand = (description: string, ...statements: string[]): string =>
  `-- velexis:phase expand\n-- ${description}\n${statements.join("\n")}\n`;

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly events: MigrationFileEvent[];
}

/** `migrate.js <set> --dir <dir>` with DATABASE_MIGRATOR_URL on the fresh database. */
async function cli(set: SharedMigrationSet, dir: string): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await runMigrateCli([set, "--dir", dir], {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    env: { APP_ENV: "test", DATABASE_MIGRATOR_URL: db.migratorUrl },
  });
  const events = stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as MigrationFileEvent);
  return { code, stdout, stderr, events };
}

interface LedgerRecord {
  id: string;
  description: string;
  checksum: string;
  phase: string;
  status: string;
  execution_ms: number | null;
  created_at: Date;
  updated_at: Date;
}

function ledger(schema: SharedMigrationSet = "platform"): Promise<LedgerRecord[]> {
  return db.query<LedgerRecord>(
    `SELECT id, description, checksum, phase, status, execution_ms, created_at, updated_at ` +
      `FROM ${schema}.schema_migrations ORDER BY id`,
  );
}

async function exists(relation: string): Promise<boolean> {
  const [row] = await db.query<{ found: boolean }>("SELECT to_regclass($1) IS NOT NULL AS found", [relation]);
  return row?.found === true;
}

const APPLY_LOG =
  "CREATE TABLE platform.apply_log (n integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, file text NOT NULL);";
const logged = (file: string): string => `INSERT INTO platform.apply_log (file) VALUES ('${file}');`;

async function applyLog(): Promise<string[]> {
  const rows = await db.query<{ file: string }>("SELECT file FROM platform.apply_log ORDER BY n");
  return rows.map((row) => row.file);
}

describe("runMigrations and migrate.js on PostgreSQL", () => {
  it("applies the files of a fresh database in order, then nothing on a second run [X-011 AC1]", async () => {
    const dir = await migrations({
      // Written out of order: the runner sorts by number, and 0010 needs the column of 0002.
      "0010_seed_items.sql": expand(
        "Seed one item",
        "INSERT INTO platform.items (id, label, price) VALUES ('itm_1', 'one', 12.30);",
        logged("0010"),
      ),
      "R__grants.sql":
        "-- Read access for the OTA backend\nGRANT SELECT ON platform.items TO velexis_ota_app;\n",
      "0002_add_price.sql":
        "-- velexis:phase migrate\n-- Add the price\nALTER TABLE platform.items ADD COLUMN price numeric(12,2);\n" +
        `${logged("0002")}\n`,
      "0001_create_items.sql": expand(
        "Create the items",
        "CREATE TABLE platform.items (id text PRIMARY KEY, label text NOT NULL);",
        APPLY_LOG,
        logged("0001"),
      ),
    });

    const first = await cli("platform", dir);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(first.events.map((event) => [event.file, event.status, event.phase, event.kind])).toEqual([
      ["0001_create_items.sql", "applied", "expand", "numbered"],
      ["0002_add_price.sql", "applied", "migrate", "numbered"],
      ["0010_seed_items.sql", "applied", "expand", "numbered"],
      ["R__grants.sql", "applied", "repeatable", "repeatable"],
    ]);
    expect(await applyLog()).toEqual(["0001", "0002", "0010"]);

    const rows = await ledger();
    expect(rows.map((row) => [row.id, row.description, row.phase, row.status])).toEqual([
      ["0001_create_items", "Create the items", "expand", "applied"],
      ["0002_add_price", "Add the price", "migrate", "applied"],
      ["0010_seed_items", "Seed one item", "expand", "applied"],
      ["R__grants", "Read access for the OTA backend", "repeatable", "applied"],
    ]);
    for (const row of rows) {
      expect(row.checksum).toBe(await sha256(join(dir, `${row.id}.sql`)));
      expect(row.execution_ms).toBeGreaterThanOrEqual(0);
      expect(row.created_at).toBeInstanceOf(Date);
    }
    for (const event of first.events) {
      expect(event).toMatchObject({
        set: "platform",
        transaction: true,
        checksum: await sha256(join(dir, event.file)),
      });
    }

    // The tables belong to the migrator and get bootstrap.sql's default privileges; the repeatable file ran last.
    const [owner] = await db.query<{ owner: string; platform_app: boolean; ota_app: boolean }>(
      "SELECT tableowner AS owner, has_table_privilege('velexis_platform_app', 'platform.items', 'INSERT') AS platform_app, " +
        "has_table_privilege('velexis_ota_app', 'platform.items', 'SELECT') AS ota_app FROM pg_tables " +
        "WHERE schemaname = 'platform' AND tablename = 'items'",
    );
    expect(owner).toEqual({ owner: "velexis_migrator", platform_app: true, ota_app: true });

    const second = await cli("platform", dir);
    expect(second).toEqual({ code: 0, stdout: "", stderr: "", events: [] });
    expect(await ledger()).toEqual(rows);
    expect(await applyLog()).toEqual(["0001", "0002", "0010"]);
  });

  it("applies the reference DDL baseline byte for byte, with the ledger created first [X-011 AC1]", async () => {
    const platformDir = await migrations({
      "0001_baseline.sql": await readFile(join(REFERENCE_DDL, "platform.sql"), "utf8"),
    });
    const referenceDir = await migrations({
      "0001_baseline.sql": await readFile(join(REFERENCE_DDL, "reference.sql"), "utf8"),
    });
    for (const [set, dir, tables] of [
      ["platform", platformDir, 16],
      ["reference", referenceDir, 7],
    ] as const) {
      const run = await cli(set, dir);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(run.events.map((event) => [event.set, event.id, event.status])).toEqual([
        [set, "0001_baseline", "applied"],
      ]);
      const [count] = await db.query<{ tables: string }>(
        "SELECT count(*) AS tables FROM pg_tables WHERE schemaname = $1 AND tablename <> 'schema_migrations'",
        [set],
      );
      expect(Number(count?.tables)).toBe(tables);
      const rows = await ledger(set);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "0001_baseline", phase: "expand", status: "applied" });
      expect(rows[0]?.checksum).toBe(await sha256(join(REFERENCE_DDL, `${set}.sql`)));
      expect(await cli(set, dir)).toEqual({ code: 0, stdout: "", stderr: "", events: [] });
    }
  });

  it("creates the schema and its ledger when bootstrap.sql did not create the schema", async () => {
    await db.query("DROP SCHEMA reference");
    const dir = await migrations({
      "0001_baseline.sql": await readFile(join(REFERENCE_DDL, "reference.sql"), "utf8"),
    });
    expect((await cli("reference", dir)).code).toBe(0);
    const [schema] = await db.query<{ owner: string }>(
      "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'reference'",
    );
    expect(schema?.owner).toBe("velexis_migrator");
    expect(await ledger("reference")).toHaveLength(1);
  });

  it("gives the platform and reference ledgers the columns of the tenant ledger, plus the repeatable phase", async () => {
    expect((await cli("platform", await migrations({}))).code).toBe(0);
    expect((await cli("reference", await migrations({}))).code).toBe(0);

    const tenantSql = await readFile(join(REFERENCE_DDL, "tenant.sql"), "utf8");
    const tenantLedger = splitSqlStatements(tenantSql).find((statement) =>
      statement.startsWith("CREATE TABLE schema_migrations ("),
    );
    expect(tenantLedger).toBeDefined();
    await db.query("CREATE SCHEMA ledger_probe");
    await db.query(
      tenantLedger!.replace("CREATE TABLE schema_migrations", "CREATE TABLE ledger_probe.schema_migrations"),
    );

    const columns = (schema: string) =>
      db.query(
        "SELECT ordinal_position, column_name, data_type, is_nullable, column_default FROM information_schema.columns " +
          "WHERE table_schema = $1 AND table_name = 'schema_migrations' ORDER BY ordinal_position",
        [schema],
      );
    const tenantColumns = await columns("ledger_probe");
    expect(tenantColumns.map((column) => column["column_name"])).toEqual([
      "id",
      "description",
      "checksum",
      "phase",
      "status",
      "execution_ms",
      "created_at",
      "updated_at",
    ]);
    expect(await columns("platform")).toEqual(tenantColumns);
    expect(await columns("reference")).toEqual(tenantColumns);

    const insert = (schema: string, id: string, phase: string) =>
      db.query(
        `INSERT INTO ${schema}.schema_migrations (id, description, checksum, phase) VALUES ($1, 'probe', 'x', $2)`,
        [id, phase],
      );
    await expect(insert("platform", "R__ota_read_access", "repeatable")).resolves.toEqual([]);
    await expect(insert("reference", "0002_add_x", "contract")).resolves.toEqual([]);
    await expect(insert("platform", "R__Bad", "repeatable")).rejects.toThrow(/schema_migrations_id_check/);
    await expect(insert("platform", "0003_x", "later")).rejects.toThrow(/schema_migrations_phase_check/);
    await expect(insert("ledger_probe", "R__ota_read_access", "repeatable")).rejects.toThrow(
      /check constraint/,
    );

    const [comment] = await db.query<{ comment: string | null }>(
      "SELECT obj_description('platform.schema_migrations'::regclass, 'pg_class') AS comment",
    );
    expect(comment?.comment).toMatch(/^Migration ledger of the platform schema/);
  });

  it("runs each file with lock_timeout 5s and statement_timeout 10min, whatever an earlier file set on the session", async () => {
    const seen = (table: string): string =>
      `CREATE TABLE platform.${table} AS SELECT current_setting('lock_timeout') AS lock_timeout, ` +
      "current_setting('statement_timeout') AS statement_timeout;";
    const dir = await migrations({
      "0001_settings.sql": expand("Record the settings", seen("seen_1")),
      // A plain SET commits with the file and stays on the runner's connection: later files must not inherit it.
      "0002_change_session.sql": expand(
        "Change the session settings",
        "SET lock_timeout = '1min';",
        "SET statement_timeout = '1h';",
      ),
      "0003_settings.sql": expand("Record the settings in a transaction", seen("seen_3")),
      "0004_settings_no_transaction.sql":
        "-- velexis:phase expand\n-- velexis:no-transaction\n-- Record the settings outside a transaction\n" +
        `${seen("seen_4")}\n`,
    });
    expect((await cli("platform", dir)).code).toBe(0);
    for (const table of ["seen_1", "seen_3", "seen_4"]) {
      expect(await db.query(`SELECT lock_timeout, statement_timeout FROM platform.${table}`)).toEqual([
        { lock_timeout: "5s", statement_timeout: "10min" },
      ]);
    }
  });

  it("exits 2 and applies nothing after an applied file was edited [X-011 AC2]", async () => {
    const dir = await migrations({
      "0001_create_items.sql": expand(
        "Create the items",
        "CREATE TABLE platform.items (id text PRIMARY KEY);",
      ),
      "0002_create_tags.sql": expand("Create the tags", "CREATE TABLE platform.tags (id text PRIMARY KEY);"),
    });
    expect((await cli("platform", dir)).code).toBe(0);
    const before = await ledger();
    const appliedChecksum = await sha256(join(dir, "0002_create_tags.sql"));

    // Even a comment changes the bytes. A new pending file must not be applied either.
    await appendFile(join(dir, "0002_create_tags.sql"), "-- edited after it was merged\n");
    await writeFile(
      join(dir, "0003_create_notes.sql"),
      expand("Create the notes", "CREATE TABLE platform.notes (id text);"),
    );

    const run = await cli("platform", dir);
    expect(run.code).toBe(2);
    expect(run.events).toEqual([
      {
        set: "platform",
        file: "0002_create_tags.sql",
        id: "0002_create_tags",
        kind: "numbered",
        phase: "expand",
        status: "checksum_mismatch",
        checksum: await sha256(join(dir, "0002_create_tags.sql")),
        transaction: true,
        appliedChecksum,
      },
    ]);
    expect(run.stderr).toMatch(
      /^migrate: 1 applied platform migration file\(s\) changed since they were applied: 0002_create_tags\.sql\. Nothing was applied\./,
    );
    expect(await ledger()).toEqual(before);
    expect(await exists("platform.notes")).toBe(false);

    const error = await runMigrations({ set: "platform", dir, url: db.migratorUrl }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ChecksumMismatchError);
    expect(error).toMatchObject({ exitCode: 2, files: ["0002_create_tags.sql"] });
    expect(await exists("platform.notes")).toBe(false);
  });

  it("rolls back a failing file, records nothing for it, keeps the files before it and exits 1 [X-011 AC3]", async () => {
    const broken = expand(
      "Breaks halfway",
      "CREATE TABLE platform.partial (id int);",
      "INSERT INTO platform.items (id) VALUES ('itm_partial');",
      "SELECT * FROM platform.does_not_exist;",
    );
    const dir = await migrations({
      "0001_create_items.sql": expand(
        "Create the items",
        "CREATE TABLE platform.items (id text PRIMARY KEY);",
      ),
      "0002_create_tags.sql": expand("Create the tags", "CREATE TABLE platform.tags (id text PRIMARY KEY);"),
      "0003_break.sql": broken,
      "0004_create_notes.sql": expand("Create the notes", "CREATE TABLE platform.notes (id text);"),
    });

    const run = await cli("platform", dir);
    expect(run.code).toBe(1);
    expect(run.events.map((event) => [event.id, event.status])).toEqual([
      ["0001_create_items", "applied"],
      ["0002_create_tags", "applied"],
      ["0003_break", "failed"],
    ]);
    expect(run.events[2]?.error).toEqual({
      message: 'relation "platform.does_not_exist" does not exist',
      code: "42P01",
      line: 5,
    });
    expect(run.stderr).toBe(
      'migrate: Migration platform/0003_break.sql failed: relation "platform.does_not_exist" does not exist ' +
        "(SQLSTATE 42P01, line 5). It was rolled back and nothing of it is recorded; the files before it stay applied.\n",
    );
    expect((await ledger()).map((row) => row.id)).toEqual(["0001_create_items", "0002_create_tags"]);
    expect(await exists("platform.items")).toBe(true);
    expect(await exists("platform.tags")).toBe(true);
    expect(await exists("platform.partial")).toBe(false);
    expect(await db.query("SELECT id FROM platform.items")).toEqual([]);
    expect(await exists("platform.notes")).toBe(false);

    // The library throws the same failure; a fixed file then applies with the ones after it.
    const error = await runMigrations({ set: "platform", dir, url: db.migratorUrl }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(MigrationFailedError);
    expect(error).toMatchObject({ exitCode: 1, file: "0003_break.sql", failure: { code: "42P01" } });
    await writeFile(
      join(dir, "0003_break.sql"),
      broken.replace("SELECT * FROM platform.does_not_exist;", ""),
    );
    const fixed = await cli("platform", dir);
    expect(fixed.code).toBe(0);
    expect(fixed.events.map((event) => event.id)).toEqual(["0003_break", "0004_create_notes"]);
  });

  it("applies and records a -- velexis:no-transaction file with CREATE INDEX CONCURRENTLY [X-011 AC4]", async () => {
    const dir = await migrations({
      "0001_create_items.sql": expand(
        "Create the items",
        "CREATE TABLE platform.items (id text PRIMARY KEY, label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());",
        "INSERT INTO platform.items (id, label) SELECT 'itm_' || n, 'item ' || n FROM generate_series(1, 100) AS n;",
      ),
      "0002_index_items.sql":
        "-- velexis:phase expand\n-- velexis:no-transaction\n-- Index the items without blocking writes\n" +
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_label_idx ON platform.items (label);\n" +
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_created_at_idx ON platform.items (created_at);\n",
    });

    const run = await cli("platform", dir);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.events.map((event) => [event.id, event.status, event.transaction])).toEqual([
      ["0001_create_items", "applied", true],
      ["0002_index_items", "applied", false],
    ]);
    expect((await ledger())[1]).toMatchObject({
      id: "0002_index_items",
      description: "Index the items without blocking writes",
      phase: "expand",
      status: "applied",
      checksum: await sha256(join(dir, "0002_index_items.sql")),
    });
    expect(
      await db.query(
        "SELECT c.relname AS index, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid " +
          "WHERE i.indrelid = 'platform.items'::regclass AND NOT i.indisprimary ORDER BY 1",
      ),
    ).toEqual([
      { index: "items_created_at_idx", valid: true },
      { index: "items_label_idx", valid: true },
    ]);
    expect((await cli("platform", dir)).events).toEqual([]);

    // Without the header the same statement runs in the file's transaction, which PostgreSQL refuses.
    await writeFile(
      join(dir, "0003_index_in_transaction.sql"),
      expand(
        "Index in a transaction",
        "CREATE INDEX CONCURRENTLY items_id_label_idx ON platform.items (id, label);",
      ),
    );
    const refused = await cli("platform", dir);
    expect(refused.code).toBe(1);
    expect(refused.events[0]?.error).toMatchObject({ code: "25001" });
  });

  it("keeps the statements before a failing no-transaction statement and records nothing", async () => {
    const dir = await migrations({
      "0001_create_items.sql": expand(
        "Create the items",
        "CREATE TABLE platform.items (id text PRIMARY KEY, label text);",
      ),
      "0002_index_items.sql":
        "-- velexis:phase expand\n-- velexis:no-transaction\n-- Two indexes\n" +
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_label_idx ON platform.items (label);\n" +
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS tags_label_idx ON platform.tags (label);\n",
    });
    const run = await cli("platform", dir);
    expect(run.code).toBe(1);
    expect(run.events[1]).toMatchObject({
      id: "0002_index_items",
      status: "failed",
      transaction: false,
      error: { code: "42P01", statement: 2 },
    });
    expect(run.stderr).toContain(
      "It ran outside a transaction: the statements before the failing one stay applied",
    );
    expect(await exists("platform.items_label_idx")).toBe(true);
    expect((await ledger()).map((row) => row.id)).toEqual(["0001_create_items"]);

    // IF NOT EXISTS makes the file safe to run again once the cause is fixed.
    await writeFile(
      join(dir, "0002_index_items.sql"),
      "-- velexis:phase expand\n-- velexis:no-transaction\n-- Two indexes\n" +
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_label_idx ON platform.items (label);\n" +
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_id_label_idx ON platform.items (id, label);\n",
    );
    const again = await cli("platform", dir);
    expect(again.code).toBe(0);
    expect(again.events.map((event) => [event.id, event.status])).toEqual([["0002_index_items", "applied"]]);
  });

  it("applies a repeatable file once, again after an edit, and rejects one with CREATE TABLE [X-011 AC5]", async () => {
    const dir = await migrations({
      "0001_create_tables.sql": expand(
        "Create two tables",
        "CREATE TABLE platform.items (id text PRIMARY KEY);",
        "CREATE TABLE platform.secrets (id text PRIMARY KEY);",
      ),
      "R__ota_read_access.sql": "-- OTA read access\nGRANT SELECT ON platform.items TO velexis_ota_app;\n",
    });
    const canRead = async (table: string): Promise<boolean> => {
      const [row] = await db.query<{ ok: boolean }>(
        "SELECT has_table_privilege('velexis_ota_app', $1, 'SELECT') AS ok",
        [table],
      );
      return row?.ok === true;
    };

    const first = await cli("platform", dir);
    expect(first.code).toBe(0);
    expect(first.events.map((event) => [event.id, event.phase])).toEqual([
      ["0001_create_tables", "expand"],
      ["R__ota_read_access", "repeatable"],
    ]);
    expect(await canRead("platform.items")).toBe(true);
    expect(await canRead("platform.secrets")).toBe(false);
    const [applied] = (await ledger()).filter((row) => row.id === "R__ota_read_access");

    // Applied once: an unchanged file is not run again.
    expect(await cli("platform", dir)).toEqual({ code: 0, stdout: "", stderr: "", events: [] });
    expect((await ledger()).find((row) => row.id === "R__ota_read_access")).toEqual(applied);

    // Edited: applied again and its ledger row updated in place.
    await writeFile(
      join(dir, "R__ota_read_access.sql"),
      "-- OTA read access\nGRANT SELECT ON platform.items, platform.secrets TO velexis_ota_app;\n",
    );
    const edited = await cli("platform", dir);
    expect(edited.code).toBe(0);
    expect(edited.events.map((event) => [event.id, event.status, event.kind])).toEqual([
      ["R__ota_read_access", "applied", "repeatable"],
    ]);
    expect(await canRead("platform.secrets")).toBe(true);
    const reapplied = (await ledger()).filter((row) => row.id === "R__ota_read_access");
    expect(reapplied).toHaveLength(1);
    expect(reapplied[0]?.checksum).toBe(await sha256(join(dir, "R__ota_read_access.sql")));
    expect(reapplied[0]?.checksum).not.toBe(applied?.checksum);
    expect(reapplied[0]?.created_at).toEqual(applied?.created_at);
    expect(reapplied[0]!.updated_at.getTime()).toBeGreaterThan(applied!.updated_at.getTime());
    expect(await cli("platform", dir)).toEqual({ code: 0, stdout: "", stderr: "", events: [] });

    // A repeatable file with CREATE TABLE is rejected before anything runs, pending numbered files included.
    await writeFile(
      join(dir, "R__sneaky.sql"),
      "GRANT SELECT ON platform.items TO velexis_ota_app;\nCREATE TABLE platform.sneaky (id int);\n",
    );
    await writeFile(
      join(dir, "0002_create_notes.sql"),
      expand("Create the notes", "CREATE TABLE platform.notes (id text);"),
    );
    const before = await ledger();
    const rejected = await cli("platform", dir);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain(
      'R__sneaky.sql: statement 2 starts with "CREATE TABLE": a repeatable file may contain only GRANT, REVOKE and COMMENT ON',
    );
    expect(await ledger()).toEqual(before);
    expect(await exists("platform.sneaky")).toBe(false);
    expect(await exists("platform.notes")).toBe(false);
    await expect(runMigrations({ set: "platform", dir, url: db.migratorUrl })).rejects.toBeInstanceOf(
      MigrationFilesError,
    );
  });

  it("never applies a file twice when two runs of the same set start together [X-011 AC6]", async () => {
    const dir = await migrations({
      "0001_create_log.sql": expand("Create the log", APPLY_LOG, logged("0001")),
      "0002_log.sql": expand("Log", logged("0002")),
      "0003_create_items.sql": expand(
        "Not idempotent",
        "CREATE TABLE platform.items (id text);",
        logged("0003"),
      ),
      "R__grants.sql": "GRANT SELECT ON platform.items TO velexis_ota_app;\n",
    });
    const lock = "hashtext('velexis:migrate:platform')";
    /** Sessions of this database waiting for an advisory lock: the queued runs. */
    const waiting = async (): Promise<number> => {
      const [row] = await db.query<{ waiting: string }>(
        "SELECT count(*) AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
          "WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = $1",
        [db.name],
      );
      return Number(row?.waiting);
    };

    // Hold the set's lock, so both runs are queued on it before either can start.
    await withClient(db.adminUrl, async (holder) => {
      await holder.query(`SELECT pg_advisory_lock(${lock})`);
      const runs = [
        runMigrations({ set: "platform", dir, url: db.migratorUrl }),
        runMigrations({ set: "platform", dir, url: db.migratorUrl }),
      ];
      // Keep a rejection from being unhandled while the test waits for both runs to queue.
      runs.forEach((run) => void run.catch(() => undefined));
      await expect.poll(waiting, { timeout: 10_000, interval: 20 }).toBe(2);
      await holder.query(`SELECT pg_advisory_unlock(${lock})`);
      const [a, b] = await Promise.all(runs);
      const counts = [a!.applied.length, b!.applied.length].sort();
      expect(counts).toEqual([0, 4]);
      expect([a!.upToDate, b!.upToDate].sort()).toEqual([0, 4]);
    });

    expect(await applyLog()).toEqual(["0001", "0002", "0003"]);
    expect((await ledger()).map((row) => row.id)).toEqual([
      "0001_create_log",
      "0002_log",
      "0003_create_items",
      "R__grants",
    ]);
  });

  it("prints a notice, applies nothing and creates no ledger for a missing --dir [X-011 AC7]", async () => {
    const missing = join(await migrations({}), "platform");
    const run = await cli("platform", missing);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`notice: the platform migrations folder ${missing} does not exist`);
    expect(await exists("platform.schema_migrations")).toBe(false);
  });

  it("reports a ledger row without a file as a notice and keeps going", async () => {
    const dir = await migrations({
      "0001_create_items.sql": expand("Create the items", "CREATE TABLE platform.items (id text);"),
      "0002_create_tags.sql": expand("Create the tags", "CREATE TABLE platform.tags (id text);"),
    });
    expect((await cli("platform", dir)).code).toBe(0);
    await rm(join(dir, "0002_create_tags.sql"));
    const run = await cli("platform", dir);
    expect(run).toMatchObject({ code: 0, stdout: "" });
    expect(run.stderr).toBe(
      `migrate: notice: platform.schema_migrations has 0002_create_tags, which is not in ${dir} (applied by another release)\n`,
    );
  });
});
