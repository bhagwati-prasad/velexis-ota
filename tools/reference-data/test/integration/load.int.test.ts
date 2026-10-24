// The reference data loader on PostgreSQL 16 (task X-018; ADR-0024 Loader, ADR-0004 Database roles).
//
// Every test gets a fresh database `velexis_reftest_<random>`, created as TEST_DATABASE_ADMIN_URL (role
// velexis_test_admin: LOGIN CREATEDB, member of velexis_migrator) and prepared like deploy/postgres/bootstrap.sql:
// its database section needs psql variables and superuser rights, so it is mirrored here; the statements after
// `\connect :db_name` (base schemas, USAGE, the default privileges that give velexis_platform_app DML and
// velexis_ota_app SELECT on `reference`) are read from bootstrap.sql itself and run as velexis_migrator. Then the
// real migration runner of @velexis/db (X-011, X-012) applies the platform and reference sets of
// platform/backend/migrations, as `pnpm db:migrate` does. The loader runs as velexis_platform_app (DATABASE_URL)
// and as velexis_ota_app (the development DSN of ota/backend/.env.example, a dummy value that
// deploy/scripts/dev-setup.sh and the CI bootstrap set). The data is the committed snapshot of data/, or a copy of
// it in a temporary folder that a test edits.
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { runMigrations, splitSqlStatements } from "@velexis/db/migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLoadCli } from "../../src/cli/load.js";
import {
  LOAD_ORDER,
  loadReferenceData,
  OVERRIDES_FILE,
  readReferenceData,
  REFERENCE_TABLES,
  ReferenceLoadError,
  type LoadReferenceDataResult,
  type ReferenceDataSet,
  type ReferenceRow,
  type ReferenceTable,
  type TableCounts,
} from "../../src/load.js";

const PACKAGE_DIR = resolve(__dirname, "..", "..");
const REPO = resolve(PACKAGE_DIR, "..", "..");
const DATA_DIR = join(PACKAGE_DIR, "data");
const MIGRATIONS = join(REPO, "platform", "backend", "migrations");
/** numeric(9,6) columns: compared without trailing zeros (the files write 141.0478, PostgreSQL 141.047800). */
const NUMERIC_COLUMNS = new Set(["latitude", "longitude"]);
/** Task X-018 AC4: a full load takes less than 30 s on a developer machine. */
const FULL_LOAD_BUDGET_MS = 30_000;

interface TestUrls {
  readonly admin: string;
  readonly migrator: string;
  readonly platform: string;
}

function testUrls(): TestUrls {
  loadDevEnvFiles({ appDir: PACKAGE_DIR });
  const postgres = { protocols: ["postgres:", "postgresql:"] };
  const config = defineConfig({
    TEST_DATABASE_ADMIN_URL: env.url(postgres),
    DATABASE_MIGRATOR_URL: env.url(postgres),
    DATABASE_URL: env.url(postgres),
  });
  if (new URL(config.DATABASE_URL).username !== "velexis_platform_app") {
    throw new Error("DATABASE_URL must be the velexis_platform_app DSN of .env.example");
  }
  return {
    admin: config.TEST_DATABASE_ADMIN_URL,
    migrator: config.DATABASE_MIGRATOR_URL,
    platform: config.DATABASE_URL,
  };
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** The DSN of velexis_ota_app on `database`: user and password from ota/backend/.env.example. Never printed. */
async function otaAppUrl(admin: string, database: string): Promise<string> {
  const example = await readFile(join(REPO, "ota", "backend", ".env.example"), "utf8");
  const value = /^DATABASE_URL=(\S+)$/m.exec(example)?.[1];
  if (value === undefined) {
    throw new Error("ota/backend/.env.example has no DATABASE_URL line");
  }
  const dsn = new URL(value);
  if (dsn.username !== "velexis_ota_app") {
    throw new Error("ota/backend/.env.example: DATABASE_URL is not the role velexis_ota_app");
  }
  const url = new URL(withDatabase(admin, database));
  url.username = dsn.username;
  url.password = dsn.password;
  return url.toString();
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: "velexis-reference-int-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The statements of bootstrap.sql that run inside the database (after `\connect :db_name`). */
async function bootstrapDatabaseStatements(): Promise<string[]> {
  const script = await readFile(join(REPO, "deploy", "postgres", "bootstrap.sql"), "utf8");
  const connect = /^\\connect :db_name[ \t]*$/m.exec(script);
  if (connect === null) {
    throw new Error("deploy/postgres/bootstrap.sql has no \\connect :db_name line");
  }
  const rest = script.slice(connect.index + connect[0].length);
  if (/^\s*\\/m.test(rest)) {
    throw new Error("bootstrap.sql after \\connect has a psql meta-command; update load.int.test.ts");
  }
  return splitSqlStatements(rest);
}

interface TestDatabase {
  readonly name: string;
  /** velexis_test_admin (member of velexis_migrator): reads everything, for the assertions. */
  readonly adminUrl: string;
  /** velexis_platform_app: the loader's role. */
  readonly platformUrl: string;
  /** velexis_ota_app: SELECT only on `reference`. */
  readonly otaUrl: string;
}

/**
 * The budget of a scenario's setup hook: a fresh database (CREATE DATABASE, the bootstrap statements and the platform
 * and reference migrations, a few seconds) and up to four loads of the full datasets with their reads, which task
 * X-018 bounds at 30 s per full load on a developer machine (about 1-3 s per scenario alone). The bound only stops a
 * scenario that hangs.
 */
const SCENARIO_TIMEOUT_MS = 60_000;

/** The budget of the hook that drops the scenarios' databases (seven DROP DATABASE) and their temporary folders. */
const CLEANUP_TIMEOUT_MS = 60_000;

let urls: TestUrls | undefined;
const dropDatabases: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

beforeAll(() => {
  urls = testUrls();
});

afterAll(async () => {
  for (const drop of dropDatabases) {
    await drop();
  }
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
}, CLEANUP_TIMEOUT_MS);

/** A fresh database, bootstrapped and migrated as described at the top of this file. */
async function freshDatabase(): Promise<TestDatabase> {
  if (urls === undefined) {
    throw new Error("beforeAll did not run");
  }
  const { admin, migrator, platform } = urls;
  const name = `velexis_reftest_${randomBytes(6).toString("hex")}`;
  const database = pg.escapeIdentifier(name);
  await withClient(admin, async (client) => {
    await client.query(
      `CREATE DATABASE ${database} OWNER velexis_migrator ENCODING 'UTF8' ` +
        `LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0`,
    );
  });
  dropDatabases.push(() =>
    withClient(admin, async (client) => void (await client.query(`DROP DATABASE IF EXISTS ${database}`))),
  );
  await withClient(admin, async (client) => {
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO velexis_platform_app, velexis_ota_app`,
    );
    await client.query(`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${database} TO velexis_provisioner`);
    await client.query(`GRANT ALL ON DATABASE ${database} TO velexis_migrator`);
  });
  const adminUrl = withDatabase(admin, name);
  const statements = await bootstrapDatabaseStatements();
  await withClient(adminUrl, async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE velexis_migrator");
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  });
  for (const set of ["platform", "reference"] as const) {
    await runMigrations({ set, dir: join(MIGRATIONS, set), url: withDatabase(migrator, name) });
  }
  return {
    name,
    adminUrl,
    platformUrl: withDatabase(platform, name),
    otaUrl: await otaAppUrl(admin, name),
  };
}

/** A copy of data/ in a new temporary folder, removed after the file. */
async function copyOfData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-reference-data-"));
  tempDirs.push(dir);
  for (const table of LOAD_ORDER) {
    const { file } = REFERENCE_TABLES[table];
    await copyFile(join(DATA_DIR, file), join(dir, file));
  }
  await copyFile(join(DATA_DIR, OVERRIDES_FILE), join(dir, OVERRIDES_FILE));
  return dir;
}

const quoteCsv = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** Rewrites the file of `table` in `dir` with `rows` (the canonical form of fetch.mjs). */
async function writeTable(dir: string, table: ReferenceTable, rows: readonly ReferenceRow[]): Promise<void> {
  const { file, columns } = REFERENCE_TABLES[table];
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => quoteCsv(row[column] ?? "")).join(",")),
  ];
  await writeFile(join(dir, file), `${lines.join("\n")}\n`);
}

/** Every row of `table` as text (numerics without trailing zeros), by key. */
async function tableRows(url: string, table: ReferenceTable): Promise<Map<string, ReferenceRow>> {
  const { key, columns } = REFERENCE_TABLES[table];
  const select = columns
    .map((column) => {
      const name = pg.escapeIdentifier(column);
      return `${NUMERIC_COLUMNS.has(column) ? `trim_scale(${name})` : name}::text AS ${name}`;
    })
    .join(", ");
  const { rows } = await withClient(url, (client) =>
    client.query<Record<string, string | null>>(
      `SELECT ${select} FROM reference.${pg.escapeIdentifier(table)}`,
    ),
  );
  return new Map(rows.map((row) => [row[key] ?? "", row]));
}

/** One digest per table over every column, created_at and updated_at included: any change shows up. */
async function fingerprint(url: string): Promise<Record<string, string>> {
  return withClient(url, async (client) => {
    const digests: Record<string, string> = {};
    for (const table of LOAD_ORDER) {
      const { key } = REFERENCE_TABLES[table];
      const { rows } = await client.query<{ rows: number; digest: string | null }>(
        `SELECT count(*)::int AS rows, md5(string_agg(t::text, E'\\n' ORDER BY t.${pg.escapeIdentifier(key)})) ` +
          `AS digest FROM reference.${pg.escapeIdentifier(table)} AS t`,
      );
      digests[table] = `${rows[0]?.rows ?? "?"}:${rows[0]?.digest ?? "empty"}`;
    }
    return digests;
  });
}

const zero: TableCounts = { inserted: 0, updated: 0, deactivated: 0 };
const allZero = (): Record<ReferenceTable, TableCounts> =>
  Object.fromEntries(LOAD_ORDER.map((table) => [table, zero])) as Record<ReferenceTable, TableCounts>;

let committed: ReferenceDataSet | undefined;
async function committedData(): Promise<ReferenceDataSet> {
  committed ??= await readReferenceData(DATA_DIR);
  return committed;
}

/** The first `count` active airports of the snapshot with an ICAO code and a city (plain, typical rows). */
async function typicalAirports(count: number): Promise<ReferenceRow[]> {
  const data = await committedData();
  const found = data.tables.airports.filter(
    (row) => row["is_active"] === "true" && row["icao_code"] !== null && row["city_code"] !== null,
  );
  if (found.length < count) {
    throw new Error(`the snapshot has fewer than ${count} typical airports`);
  }
  return found.slice(0, count);
}

describe("loadReferenceData on PostgreSQL 16", () => {
  // Each scenario creates its database, loads, edits and reads in its setup hook, with its own budget (the lead's test
  // timing rule; FIX-W28-FOLLOWUPS: the tests no longer need Vitest's raised 60 s test timeout), and its test asserts
  // on what the hook recorded.

  describe("a first load and a second one", () => {
    let data: ReferenceDataSet;
    let first: LoadReferenceDataResult;
    let loaded: Map<ReferenceTable, Map<string, ReferenceRow>>;
    let second: LoadReferenceDataResult;
    let before: Record<string, string>;
    let after: Record<string, string>;

    beforeAll(async () => {
      const db = await freshDatabase();
      data = await committedData();
      first = await loadReferenceData({ url: db.platformUrl, dataDir: DATA_DIR });
      loaded = new Map();
      for (const table of LOAD_ORDER) {
        loaded.set(table, await tableRows(db.adminUrl, table));
      }
      before = await fingerprint(db.adminUrl);
      second = await loadReferenceData({ url: db.platformUrl, dataDir: DATA_DIR });
      after = await fingerprint(db.adminUrl);
    }, SCENARIO_TIMEOUT_MS);

    it("inserts every row on the first load and reports zero inserts and updates on the second [X-018 AC1]", () => {
      for (const table of LOAD_ORDER) {
        expect(first.tables[table], table).toEqual({
          inserted: data.tables[table].length,
          updated: 0,
          deactivated: 0,
        });
        // Every row, every column, exactly as in the files (with the overrides of overrides.csv).
        const rows = loaded.get(table) ?? new Map<string, ReferenceRow>();
        const { key } = REFERENCE_TABLES[table];
        expect(rows.size, table).toBe(data.tables[table].length);
        for (const row of data.tables[table]) {
          expect(rows.get(row[key] ?? ""), `${table} ${row[key]}`).toEqual(row);
        }
      }
      expect(first.overrides).toBe(data.overrides);

      expect(second.tables).toEqual(allZero());
      // Nothing was written: not even updated_at moved.
      expect(after).toEqual(before);
    });
  });

  describe("an airport removed from the file, then back", () => {
    let data: ReferenceDataSet;
    let code: string;
    let loadedBefore: ReferenceRow | undefined;
    let result: LoadReferenceDataResult;
    let after: Map<string, ReferenceRow>;
    let again: LoadReferenceDataResult;
    let restored: LoadReferenceDataResult;
    let restoredRow: ReferenceRow | undefined;

    beforeAll(async () => {
      const db = await freshDatabase();
      data = await committedData();
      await loadReferenceData({ url: db.platformUrl, dataDir: DATA_DIR });
      const [removed] = await typicalAirports(1);
      code = removed?.["iata_code"] ?? "";
      loadedBefore = (await tableRows(db.adminUrl, "airports")).get(code);

      const dir = await copyOfData();
      await writeTable(
        dir,
        "airports",
        data.tables.airports.filter((row) => row["iata_code"] !== code),
      );
      result = await loadReferenceData({ url: db.platformUrl, dataDir: dir });
      after = await tableRows(db.adminUrl, "airports");
      // The row stays inactive: a second run with the same files changes nothing.
      again = await loadReferenceData({ url: db.platformUrl, dataDir: dir });
      // Back in the file, the code is active again.
      restored = await loadReferenceData({ url: db.platformUrl, dataDir: DATA_DIR });
      restoredRow = (await tableRows(db.adminUrl, "airports")).get(code);
    }, SCENARIO_TIMEOUT_MS);

    it("sets is_active to false on an airport removed from the file and keeps its row [X-018 AC2]", () => {
      expect(result.tables).toEqual({ ...allZero(), airports: { inserted: 0, updated: 0, deactivated: 1 } });

      expect(after.size).toBe(data.tables.airports.length);
      expect(after.get(code)).toEqual({ ...loadedBefore, is_active: "false" });

      // The row stays inactive: a second run with the same files changes nothing.
      expect(again.tables).toEqual(allZero());

      // Back in the file, the code is active again.
      expect(restored.tables).toEqual({
        ...allZero(),
        airports: { inserted: 0, updated: 1, deactivated: 0 },
      });
      expect(restoredRow).toEqual(loadedBefore);
    });
  });

  describe("a load as velexis_ota_app", () => {
    let db: TestDatabase;
    let before: Record<string, string>;
    let failure: unknown;
    let afterFailure: Record<string, string>;
    let cli: { readonly code: number; readonly stdout: string; readonly stderr: string };
    let afterCli: Record<string, string>;

    beforeAll(async () => {
      db = await freshDatabase();
      const data = await committedData();
      await loadReferenceData({ url: db.platformUrl, dataDir: DATA_DIR });
      before = await fingerprint(db.adminUrl);

      // Files that would change every kind of row: a renamed currency, a removed airport.
      const dir = await copyOfData();
      await writeTable(
        dir,
        "currencies",
        data.tables.currencies.map((row) =>
          row["code"] === "EUR" ? { ...row, name: "Euro (renamed)" } : row,
        ),
      );
      const [removed] = await typicalAirports(1);
      await writeTable(
        dir,
        "airports",
        data.tables.airports.filter((row) => row["iata_code"] !== removed?.["iata_code"]),
      );

      failure = await loadReferenceData({ url: db.otaUrl, dataDir: dir }).then(
        () => undefined,
        (error: unknown) => error,
      );
      afterFailure = await fingerprint(db.adminUrl);

      // The CLI reports it as one JSON line and exits 1, without the DSN or its password.
      let stdout = "";
      let stderr = "";
      const code = await runLoadCli(["--data", dir], {
        stdout: { write: (chunk: string) => (stdout += chunk) },
        stderr: { write: (chunk: string) => (stderr += chunk) },
        env: { APP_ENV: "test", DATABASE_URL: db.otaUrl },
      });
      cli = { code, stdout, stderr };
      afterCli = await fingerprint(db.adminUrl);
    }, SCENARIO_TIMEOUT_MS);

    it("fails with a permission error as velexis_ota_app and changes nothing [X-018 AC3]", () => {
      expect(failure).toBeInstanceOf(ReferenceLoadError);
      expect(failure).toMatchObject({ code: "42501", table: "currencies" });
      expect((failure as Error).message).toMatch(/permission denied for table currencies/);
      expect(afterFailure).toEqual(before);

      // The CLI reports it as one JSON line and exits 1, without the DSN or its password.
      const { code, stdout, stderr } = cli;
      expect(code).toBe(1);
      expect(stderr).toBe("");
      const lines = stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0] ?? "") as { msg?: string; level?: number; err?: { code?: string } };
      expect(line).toMatchObject({ msg: "reference.load_failed", level: 50, err: { code: "42501" } });
      const password = decodeURIComponent(new URL(db.otaUrl).password);
      expect(password).not.toBe("");
      expect(stdout).not.toContain(password);
      expect(stdout).not.toContain(db.otaUrl);
      expect(afterCli).toEqual(before);
    });
  });

  describe("`pnpm db:seed:reference`'s command on a new database", () => {
    let data: ReferenceDataSet;
    let script: { readonly node: string | undefined; readonly file: string | undefined };
    let code: number;
    let stdout: string;
    let elapsed: number;

    beforeAll(async () => {
      const db = await freshDatabase();
      data = await committedData();
      // The `load` script of package.json, which the root `pnpm db:seed:reference` runs in this folder.
      const pkg = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      const [node, file, ...argv] = (pkg.scripts["load"] ?? "").trim().split(/\s+/);
      script = { node, file };

      stdout = "";
      const started = performance.now();
      code = await runLoadCli(argv, {
        stdout: { write: (chunk: string) => (stdout += chunk) },
        stderr: { write: () => undefined },
        env: { APP_ENV: "test", DATABASE_URL: db.platformUrl },
        cwd: PACKAGE_DIR,
      });
      elapsed = performance.now() - started;
    }, SCENARIO_TIMEOUT_MS);

    it("loads the full datasets with `pnpm db:seed:reference`'s command in less than 30 s [X-018 AC4]", () => {
      expect([script.node, script.file]).toEqual(["node", "dist/cli/load.js"]);
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(FULL_LOAD_BUDGET_MS);

      const lines = stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0] ?? "") as LoadReferenceDataResult & { msg?: string; app?: string };
      expect(line).toMatchObject({ msg: "reference.loaded", app: "reference-loader" });
      for (const table of LOAD_ORDER) {
        expect(line.tables[table], table).toEqual({
          inserted: data.tables[table].length,
          updated: 0,
          deactivated: 0,
        });
      }
      expect(line.durationMs).toBeLessThan(FULL_LOAD_BUDGET_MS);
    });
  });

  describe("overrides.csv over the files", () => {
    let data: ReferenceDataSet;
    let airport: ReferenceRow | undefined;
    let code: string;
    let first: LoadReferenceDataResult;
    let overriddenName: string | null | undefined;
    let overriddenSymbol: string | null | undefined;
    let second: LoadReferenceDataResult;
    let plain: LoadReferenceDataResult;
    let plainName: string | null | undefined;

    beforeAll(async () => {
      const db = await freshDatabase();
      data = await committedData();
      [airport] = await typicalAirports(1);
      code = airport?.["iata_code"] ?? "";
      const dir = await copyOfData();
      await writeFile(
        join(dir, OVERRIDES_FILE),
        `table,key,column,value\nairports,${code},name,"Overridden, Airport"\ncurrencies,EUR,symbol,\n`,
      );

      first = await loadReferenceData({ url: db.platformUrl, dataDir: dir });
      overriddenName = (await tableRows(db.adminUrl, "airports")).get(code)?.["name"];
      overriddenSymbol = (await tableRows(db.adminUrl, "currencies")).get("EUR")?.["symbol"];
      second = await loadReferenceData({ url: db.platformUrl, dataDir: dir });
      // Without the overrides, the file values come back.
      plain = await loadReferenceData({ url: db.platformUrl, dataDir: DATA_DIR });
      plainName = (await tableRows(db.adminUrl, "airports")).get(code)?.["name"];
    }, SCENARIO_TIMEOUT_MS);

    it("applies overrides.csv over the files, and a second run still changes nothing", () => {
      expect(first.overrides).toBe(2);
      expect(first.tables.airports).toEqual({
        inserted: data.tables.airports.length,
        updated: 0,
        deactivated: 0,
      });
      expect(overriddenName).toBe("Overridden, Airport");
      expect(overriddenSymbol).toBeNull();

      expect(second.tables).toEqual(allZero());

      // Without the overrides, the file values come back.
      expect(plain.tables).toEqual({
        ...allZero(),
        currencies: { inserted: 0, updated: 1, deactivated: 0 },
        airports: { inserted: 0, updated: 1, deactivated: 0 },
      });
      expect(plainName).toBe(airport?.["name"]);
    });
  });

  describe("ICAO codes that move between airports", () => {
    let codes: { readonly a: ReferenceRow | undefined; readonly b: ReferenceRow | undefined };
    let c: ReferenceRow | undefined;
    let target: ReferenceRow | undefined;
    let result: LoadReferenceDataResult;
    let after: Map<string, ReferenceRow>;
    let again: LoadReferenceDataResult;

    const icao = (row: ReferenceRow | undefined) => row?.["icao_code"] ?? null;
    const codeOf = (row: ReferenceRow | undefined) => row?.["iata_code"] ?? "";

    beforeAll(async () => {
      const db = await freshDatabase();
      const data = await committedData();
      await loadReferenceData({ url: db.platformUrl, dataDir: DATA_DIR });
      const [a, b, third] = await typicalAirports(3);
      codes = { a, b };
      c = third;
      target = data.tables.airports.find((row) => row["icao_code"] === null && row["is_active"] === "true");

      // A and B swap their codes; C leaves the file and its code goes to an airport that had none.
      const dir = await copyOfData();
      const newCodes = new Map([
        [codeOf(a), icao(b)],
        [codeOf(b), icao(a)],
        [codeOf(target), icao(c)],
      ]);
      const moved = data.tables.airports
        .filter((row) => row["iata_code"] !== codeOf(c))
        .map((row) => {
          const code = row["iata_code"] ?? "";
          return newCodes.has(code) ? { ...row, icao_code: newCodes.get(code) ?? null } : row;
        });
      await writeTable(dir, "airports", moved);

      result = await loadReferenceData({ url: db.platformUrl, dataDir: dir });
      after = await tableRows(db.adminUrl, "airports");
      again = await loadReferenceData({ url: db.platformUrl, dataDir: dir });
    }, SCENARIO_TIMEOUT_MS);

    it("moves ICAO codes between airports without breaking their UNIQUE constraint", () => {
      const { a, b } = codes;
      expect(target).toBeDefined();

      expect(result.tables).toEqual({ ...allZero(), airports: { inserted: 0, updated: 3, deactivated: 1 } });
      expect(after.get(codeOf(a))?.["icao_code"]).toBe(icao(b));
      expect(after.get(codeOf(b))?.["icao_code"]).toBe(icao(a));
      expect(after.get(codeOf(target))?.["icao_code"]).toBe(icao(c));
      expect(after.get(codeOf(c))).toMatchObject({ icao_code: null, is_active: "false" });

      expect(again.tables).toEqual(allZero());
    });
  });

  describe("a later table that fails", () => {
    let data: ReferenceDataSet;
    let before: Record<string, string>;
    let failure: unknown;
    let after: Record<string, string>;

    beforeAll(async () => {
      const db = await freshDatabase();
      data = await committedData();
      before = await fingerprint(db.adminUrl);
      // The airports come after five tables that load fine; one of them names a city that does not exist.
      const dir = await copyOfData();
      const [airport] = await typicalAirports(1);
      await writeTable(
        dir,
        "airports",
        data.tables.airports.map((row) =>
          row["iata_code"] === airport?.["iata_code"] ? { ...row, city_code: "QQQ" } : row,
        ),
      );

      failure = await loadReferenceData({ url: db.platformUrl, dataDir: dir }).then(
        () => undefined,
        (error: unknown) => error,
      );
      after = await fingerprint(db.adminUrl);
    }, SCENARIO_TIMEOUT_MS);

    it("rolls the whole load back when a later table fails", () => {
      expect(data.tables.cities.some((row) => row["iata_code"] === "QQQ")).toBe(false);

      expect(failure).toBeInstanceOf(ReferenceLoadError);
      expect(failure).toMatchObject({ code: "23503", table: "airports" });
      // Not even the currencies, loaded first, were kept.
      expect(after).toEqual(before);
    });
  });
});
