// Test databases (X-015; ADR-0022 item 4, ADR-0015 "Dependencies in tests"): one migrated template database per
// Vitest run, built by the global setup (vitest-global-setup.ts), and one clone of it per test file.
//
// Everything runs as TEST_DATABASE_ADMIN_URL: the role velexis_test_admin (LOGIN CREATEDB, member of
// velexis_migrator), which exists only locally (deploy/scripts/dev-setup.sh) and in CI, never on the VM. The template
// is bootstrapped like deploy/postgres/bootstrap.sql: the database-level grants are mirrored in
// `databaseGrantStatements` (bootstrap.sql runs them through psql variables), the in-database statements are
// deploy/postgres/schemas.sql itself. Then the real migration runner of @velexis/db applies the platform and
// reference sets and creates tenant_alpha and tenant_beta, and a tiny reference fixture is inserted.
//
// PostgreSQL does not copy a database's ACL (pg_database.datacl) to a clone: CREATE DATABASE … TEMPLATE gives the
// clone the default ACL, where PUBLIC may connect. Every clone therefore gets the grants again, right after
// CREATE DATABASE. Everything inside the database (schemas, tables, grants, default privileges, rows) is copied.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { migrateTenantSchema, runMigrations } from "@velexis/db/migrate";
import pg from "pg";
import { databaseUrl, TEST_ROLES, type TestRole } from "./roles.js";

/**
 * The key under which the global setup provides the template's name to the test files (Vitest's `provide` and
 * `inject`). Vitest types these keys through `ProvidedContext`, which a CommonJS package cannot augment (Vitest is
 * ESM-only), so the two call sites below are typed by hand.
 */
export const TEMPLATE_DATABASE_KEY = "velexisTestTemplateDatabase";

/** The repository root (this file is `packages/testing/src/*.ts` or `packages/testing/dist/*.js`). */
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** The in-database statements of deploy/postgres/bootstrap.sql, without psql meta-commands. */
export const SCHEMAS_SQL = join(REPO_ROOT, "deploy", "postgres", "schemas.sql");
/** The platform and reference migration sets (`pnpm db:migrate`). */
export const SHARED_MIGRATIONS_DIR = join(REPO_ROOT, "platform", "backend", "migrations");
/** The tenant migration set (`pnpm db:migrate:tenants`, OTA provisioning). */
export const TENANT_MIGRATIONS_DIR = join(REPO_ROOT, "ota", "backend", "migrations", "tenant");

/** The two tenant schemas of every test database, for isolation tests (ADR-0015). */
export const TEST_TENANTS = Object.freeze(["tenant_alpha", "tenant_beta"] as const);
export type TestTenant = (typeof TEST_TENANTS)[number];

/** `velexis_test_tpl_<runId>`: the template database of one run. */
export const TEMPLATE_DATABASE_PREFIX = "velexis_test_tpl_";
/** `velexis_test_<runId>_<random>`: one clone. The run id ties a clone to its template. */
export const TEST_DATABASE_PREFIX = "velexis_test_";

const OWNER = TEST_ROLES.migrator.user;
const APPLICATION_NAME = "velexis-testing";
/** How often `drop()` retries when a session slipped in while the database was being dropped. */
const DROP_ATTEMPTS = 5;
/** The pause before retry n of `drop()` is n times this. */
const DROP_RETRY_DELAY_MS = 50;
/**
 * How long an app role waits for each of its terminated sessions to exit (`pg_terminate_backend(pid, timeout)`):
 * a session that is still exiting would make DROP DATABASE … WITH (FORCE) fail with "permission denied".
 */
const TERMINATE_WAIT_MS = 5_000;

/** A frozen list of frozen rows. */
function rows<T extends object>(list: T[]): readonly Readonly<T>[] {
  return Object.freeze(list.map((row) => Object.freeze(row)));
}

/**
 * The tiny reference fixture of every test database: 3 currencies, 3 countries, 5 airports and 3 airlines. Real
 * codes, so tests read like production data; `pnpm db:seed:reference` loads the full vendored data instead.
 */
export const REFERENCE_FIXTURE = Object.freeze({
  currencies: rows([
    { code: "EUR", numeric_code: "978", name: "Euro", symbol: "€", minor_units: 2 },
    { code: "GBP", numeric_code: "826", name: "Pound Sterling", symbol: "£", minor_units: 2 },
    { code: "USD", numeric_code: "840", name: "US Dollar", symbol: "$", minor_units: 2 },
  ]),
  countries: rows([
    {
      code: "FR",
      alpha3: "FRA",
      numeric_code: "250",
      name: "France",
      continent_code: "EU",
      currency_code: "EUR",
      calling_code: "33",
      is_eu: true,
    },
    {
      code: "GB",
      alpha3: "GBR",
      numeric_code: "826",
      name: "United Kingdom",
      continent_code: "EU",
      currency_code: "GBP",
      calling_code: "44",
      is_eu: false,
    },
    {
      code: "US",
      alpha3: "USA",
      numeric_code: "840",
      name: "United States",
      continent_code: "NA",
      currency_code: "USD",
      calling_code: "1",
      is_eu: false,
    },
  ]),
  airports: rows([
    {
      iata_code: "CDG",
      icao_code: "LFPG",
      name: "Paris Charles de Gaulle",
      city_name: "Paris",
      country_code: "FR",
    },
    { iata_code: "ORY", icao_code: "LFPO", name: "Paris Orly", city_name: "Paris", country_code: "FR" },
    { iata_code: "LHR", icao_code: "EGLL", name: "London Heathrow", city_name: "London", country_code: "GB" },
    {
      iata_code: "JFK",
      icao_code: "KJFK",
      name: "John F. Kennedy International",
      city_name: "New York",
      country_code: "US",
    },
    {
      iata_code: "LAX",
      icao_code: "KLAX",
      name: "Los Angeles International",
      city_name: "Los Angeles",
      country_code: "US",
    },
  ]),
  airlines: rows([
    {
      iata_code: "AF",
      icao_code: "AFR",
      name: "Air France",
      country_code: "FR",
      accounting_code: "057",
      alliance: "skyteam",
    },
    {
      iata_code: "BA",
      icao_code: "BAW",
      name: "British Airways",
      country_code: "GB",
      accounting_code: "125",
      alliance: "oneworld",
    },
    {
      iata_code: "AA",
      icao_code: "AAL",
      name: "American Airlines",
      country_code: "US",
      accounting_code: "001",
      alliance: "oneworld",
    },
  ]),
});

/** One test database: a clone of the run's template, with its own data. */
export interface TestDatabase {
  /** `velexis_test_<runId>_<random>`. */
  readonly name: string;
  /**
   * The DSN of `role` on this database: host and port of TEST_DATABASE_ADMIN_URL, user and development password
   * from `TEST_ROLES`. Give it to the code under test (`DATABASE_URL`, `DATABASE_MIGRATOR_URL`, …). It carries a
   * password: never log or print it.
   */
  urlFor(role: TestRole): string;
  /**
   * Drops the database with `WITH (FORCE)`, even while pools still hold connections. Idempotent. Call it in
   * `afterAll`, after closing your pools when you can.
   */
  drop(): Promise<void>;
}

/** The template database of one run (see `createTemplateDatabase`). */
export interface TemplateDatabase {
  /** `velexis_test_tpl_<runId>`. */
  readonly name: string;
  readonly runId: string;
  /** Drops the clones of this run that are still there (`dropRunClones`), then the template. Idempotent. */
  drop(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /**
   * The template to clone. Default: the one the global setup provided to this test file (`inject`). Only needed
   * outside a Vitest worker.
   */
  readonly template?: string | undefined;
  /** Default: TEST_DATABASE_ADMIN_URL from the environment (or the `.env.local` files outside production). */
  readonly adminUrl?: string | undefined;
}

export interface CreateTemplateDatabaseOptions {
  /** Default: a new random run id (lower-case letters, digits and `_`). */
  readonly runId?: string | undefined;
  /** Default: TEST_DATABASE_ADMIN_URL from the environment (or the `.env.local` files outside production). */
  readonly adminUrl?: string | undefined;
}

/**
 * TEST_DATABASE_ADMIN_URL, read through @velexis/config: the real environment (CI services), else the `.env.local`
 * files of the package under test and of the repository root (local development). Never printed.
 */
export function testDatabaseAdminUrl(): string {
  loadDevEnvFiles({ appDir: process.cwd() });
  const config = defineConfig({
    TEST_DATABASE_ADMIN_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
  });
  return config.TEST_DATABASE_ADMIN_URL;
}

/** A new run id: a base-36 timestamp and 6 random hex digits. */
export function newRunId(): string {
  return `${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

const RUN_ID_PATTERN = /^[a-z0-9_]{1,30}$/;

function assertRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new TypeError(`run id must match ${RUN_ID_PATTERN.source}`);
  }
  return runId;
}

/** The run id of a template name `velexis_test_tpl_<runId>`. */
export function runIdOfTemplate(template: string): string {
  if (!template.startsWith(TEMPLATE_DATABASE_PREFIX)) {
    throw new TypeError(`${template} is not a template database name (${TEMPLATE_DATABASE_PREFIX}<runId>)`);
  }
  return assertRunId(template.slice(TEMPLATE_DATABASE_PREFIX.length));
}

/**
 * The database-level statements of deploy/postgres/bootstrap.sql for `database` (its "Database" section, which
 * bootstrap.sql runs with `\gexec` and psql variables): no privilege for PUBLIC, CONNECT and TEMPORARY for the
 * app roles, CREATE as well for velexis_provisioner (tenant schemas), everything for velexis_migrator.
 */
export function databaseGrantStatements(database: string): readonly string[] {
  const name = pg.escapeIdentifier(database);
  return [
    `REVOKE ALL ON DATABASE ${name} FROM PUBLIC`,
    `GRANT CONNECT, TEMPORARY ON DATABASE ${name} TO ${TEST_ROLES.platform.user}, ${TEST_ROLES.ota.user}`,
    `GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${name} TO ${TEST_ROLES.provisioner.user}`,
    `GRANT ALL ON DATABASE ${name} TO ${OWNER}`,
  ];
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: APPLICATION_NAME });
  // A terminated session (drop) must not crash the process with an unhandled 'error' event.
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** PostgreSQL's SQLSTATE of an error, if it has one. */
function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Ends the sessions on `database` that velexis_test_admin may not terminate itself: those of roles it is not a
 * member of (velexis_platform_app, velexis_ota_app). Each such role logs in to the admin URL's database (the
 * maintenance database, `postgres`) with its development password and terminates its own sessions, which every role
 * may do, waiting until each has exited: DROP DATABASE … WITH (FORCE) checks every session still listed, including
 * one that is exiting. Sessions of other roles are left to DROP DATABASE … WITH (FORCE).
 */
async function terminateForeignSessions(admin: pg.Client, adminUrl: string, database: string): Promise<void> {
  const { rows } = await admin.query<{ usename: string }>(
    "SELECT DISTINCT usename FROM pg_stat_activity " +
      "WHERE datname = $1 AND usename IS NOT NULL AND pid <> pg_backend_pid() " +
      "AND NOT pg_has_role(current_user, usename, 'USAGE')",
    [database],
  );
  const maintenance = decodeURIComponent(new URL(adminUrl).pathname.slice(1)) || "postgres";
  for (const { usename } of rows) {
    const login = Object.values(TEST_ROLES).find((role) => role.user === usename);
    if (login === undefined) {
      continue;
    }
    await withClient(databaseUrl(adminUrl, maintenance, login), async (client) => {
      await client.query(
        "SELECT pg_terminate_backend(pid, $2) FROM pg_stat_activity " +
          "WHERE datname = $1 AND usename = current_user AND pid <> pg_backend_pid()",
        [database, TERMINATE_WAIT_MS],
      );
    });
  }
}

/**
 * Drops `database` even while connections are open. As TEST_DATABASE_ADMIN_URL it first refuses new connections
 * (`ALLOW_CONNECTIONS false`, so pools cannot reconnect), has the app roles end their own sessions, then runs
 * `DROP DATABASE … WITH (FORCE)`, which terminates the remaining sessions (velexis_migrator, velexis_provisioner,
 * velexis_test_admin) and waits for them to exit. A missing database is not an error.
 */
export async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  const name = pg.escapeIdentifier(database);
  await withClient(adminUrl, async (admin) => {
    for (let attempt = 1; ; attempt += 1) {
      const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
      if (rowCount === 0) {
        return;
      }
      try {
        await admin.query(`ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS false`);
        await terminateForeignSessions(admin, adminUrl, database);
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        return;
      } catch (error) {
        // 42501: a session of a role velexis_test_admin may not signal appeared; 55006: a session did not exit in
        // time; 3D000: someone else dropped it meanwhile. Anything else is a real failure.
        const state = sqlState(error);
        if (attempt >= DROP_ATTEMPTS || !["42501", "55006", "3D000"].includes(state ?? "")) {
          throw error;
        }
      }
      await delay(DROP_RETRY_DELAY_MS * attempt);
    }
  });
}

/**
 * Drops every clone of the run `runId` that is still there (`velexis_test_<runId>_*`): those of a test file that
 * crashed before its `afterAll`, or that never called `drop()`. Returns their names. The run id is unique, so no other
 * run's database matches. The template's `drop()` calls it, so the global setup's teardown leaves nothing behind.
 */
export async function dropRunClones(adminUrl: string, runId: string): Promise<readonly string[]> {
  const prefix = `${TEST_DATABASE_PREFIX}${assertRunId(runId)}_`;
  const names = await withClient(adminUrl, async (admin) => {
    const { rows } = await admin.query<{ name: string }>(
      "SELECT datname AS name FROM pg_database WHERE starts_with(datname, $1) ORDER BY 1",
      [prefix],
    );
    return rows.map((row) => row.name);
  });
  for (const name of names) {
    await dropDatabase(adminUrl, name);
  }
  return Object.freeze(names);
}

/** Creates `database` owned by velexis_migrator, as a copy of `template`, and gives it the bootstrap.sql grants. */
async function createDatabase(adminUrl: string, database: string, template: string): Promise<void> {
  const name = pg.escapeIdentifier(database);
  const source = pg.escapeIdentifier(template);
  await withClient(adminUrl, async (admin) => {
    const options =
      template === "template0"
        ? `ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE ${source}`
        : `TEMPLATE ${source}`;
    await admin.query(`CREATE DATABASE ${name} OWNER ${pg.escapeIdentifier(OWNER)} ${options}`);
    try {
      for (const statement of databaseGrantStatements(database)) {
        await admin.query(statement);
      }
    } catch (error) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
      throw error;
    }
  });
}

/** Inserts `REFERENCE_FIXTURE` as velexis_platform_app, the role of `pnpm db:seed:reference`. */
async function insertReferenceFixture(url: string): Promise<void> {
  await withClient(url, async (client) => {
    await client.query("BEGIN");
    for (const row of REFERENCE_FIXTURE.currencies) {
      await client.query(
        "INSERT INTO reference.currencies (code, numeric_code, name, symbol, minor_units) VALUES ($1, $2, $3, $4, $5)",
        [row.code, row.numeric_code, row.name, row.symbol, row.minor_units],
      );
    }
    for (const row of REFERENCE_FIXTURE.countries) {
      await client.query(
        "INSERT INTO reference.countries (code, alpha3, numeric_code, name, continent_code, currency_code, " +
          "calling_code, is_eu) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          row.code,
          row.alpha3,
          row.numeric_code,
          row.name,
          row.continent_code,
          row.currency_code,
          row.calling_code,
          row.is_eu,
        ],
      );
    }
    for (const row of REFERENCE_FIXTURE.airports) {
      await client.query(
        "INSERT INTO reference.airports (iata_code, icao_code, name, city_name, country_code) " +
          "VALUES ($1, $2, $3, $4, $5)",
        [row.iata_code, row.icao_code, row.name, row.city_name, row.country_code],
      );
    }
    for (const row of REFERENCE_FIXTURE.airlines) {
      await client.query(
        "INSERT INTO reference.airlines (iata_code, icao_code, name, country_code, accounting_code, alliance) " +
          "VALUES ($1, $2, $3, $4, $5, $6)",
        [row.iata_code, row.icao_code, row.name, row.country_code, row.accounting_code, row.alliance],
      );
    }
    await client.query("COMMIT");
  });
}

/**
 * Builds the template database `velexis_test_tpl_<runId>` (the global setup calls it once per run):
 * 1. as TEST_DATABASE_ADMIN_URL, creates it owned by velexis_migrator with the database-level grants of
 *    bootstrap.sql;
 * 2. runs deploy/postgres/schemas.sql as velexis_migrator (`SET LOCAL ROLE`), so `public` is closed and `platform`
 *    and `reference` exist with their USAGE grants and default privileges;
 * 3. applies the platform and reference sets with `runMigrations` as velexis_migrator, and the tenant set to
 *    tenant_alpha and tenant_beta with `migrateTenantSchema({ create: true })`, the provisioning path;
 * 4. inserts `REFERENCE_FIXTURE` as velexis_platform_app.
 * On any failure it drops what it created and rethrows. No connection to the template stays open, because
 * PostgreSQL refuses to clone a database that has sessions.
 */
export async function createTemplateDatabase(
  options: CreateTemplateDatabaseOptions = {},
): Promise<TemplateDatabase> {
  const adminUrl = options.adminUrl ?? testDatabaseAdminUrl();
  const runId = assertRunId(options.runId ?? newRunId());
  const name = `${TEMPLATE_DATABASE_PREFIX}${runId}`;
  let dropped = false;
  const drop = async (): Promise<void> => {
    if (!dropped) {
      await dropRunClones(adminUrl, runId);
      await dropDatabase(adminUrl, name);
      dropped = true;
    }
  };

  await createDatabase(adminUrl, name, "template0");
  try {
    const schemasSql = await readFile(SCHEMAS_SQL, "utf8");
    await withClient(databaseUrl(adminUrl, name), async (client) => {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${pg.escapeIdentifier(OWNER)}`);
      await client.query(schemasSql);
      await client.query("COMMIT");
    });
    const migratorUrl = databaseUrl(adminUrl, name, TEST_ROLES.migrator);
    for (const set of ["platform", "reference"] as const) {
      await runMigrations({ set, dir: join(SHARED_MIGRATIONS_DIR, set), url: migratorUrl });
    }
    for (const schema of TEST_TENANTS) {
      await migrateTenantSchema({ schema, dir: TENANT_MIGRATIONS_DIR, url: migratorUrl, create: true });
    }
    await insertReferenceFixture(databaseUrl(adminUrl, name, TEST_ROLES.platform));
  } catch (error) {
    await drop().catch(() => undefined);
    throw error;
  }
  return Object.freeze({ name, runId, drop });
}

/** The template of this test file: provided by `@velexis/testing/vitest-global-setup`. */
async function injectedTemplate(): Promise<string> {
  // Vitest is ESM-only, and this package is CommonJS: a dynamic import resolves the same instance as the test file.
  const { inject } = await import("vitest");
  const template = (inject as (key: string) => unknown)(TEMPLATE_DATABASE_KEY);
  if (typeof template !== "string" || template === "") {
    throw new Error(
      "createTestDatabase: no template database was provided to this test file. Add " +
        '`globalSetup: ["@velexis/testing/vitest-global-setup"]` to the Vitest config of the integration tests.',
    );
  }
  return template;
}

/**
 * Clones the run's template into a new database `velexis_test_<runId>_<random>` (`CREATE DATABASE … TEMPLATE …
 * OWNER velexis_migrator`) and gives it the database-level grants of bootstrap.sql. The clone has the platform and
 * reference schemas, `tenant_alpha`, `tenant_beta` and the reference fixture, and nothing written by other test
 * files. Call it once per test file (`beforeAll`) and `drop()` it in `afterAll`.
 */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const adminUrl = options.adminUrl ?? testDatabaseAdminUrl();
  const template = options.template ?? (await injectedTemplate());
  const runId = runIdOfTemplate(template);
  const name = `${TEST_DATABASE_PREFIX}${runId}_${randomBytes(6).toString("hex")}`;
  await createDatabase(adminUrl, name, template);

  let dropped = false;
  return Object.freeze({
    name,
    urlFor: (role: TestRole): string => {
      const login = TEST_ROLES[role] as (typeof TEST_ROLES)[TestRole] | undefined;
      if (login === undefined) {
        throw new TypeError(`unknown test role: ${String(role)}`);
      }
      return databaseUrl(adminUrl, name, login);
    },
    drop: async (): Promise<void> => {
      if (!dropped) {
        await dropDatabase(adminUrl, name);
        dropped = true;
      }
    },
  });
}
