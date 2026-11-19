import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  databaseGrantStatements,
  dropDatabase,
  newRunId,
  REFERENCE_FIXTURE,
  REPO_ROOT,
  runIdOfTemplate,
  SCHEMAS_SQL,
  SHARED_MIGRATIONS_DIR,
  TEMPLATE_DATABASE_PREFIX,
  TENANT_MIGRATIONS_DIR,
  TEST_TENANTS,
} from "./test-database.js";

// Unit tests of task X-015 steps 2 and 3 that need no PostgreSQL: the mirrored database grants of bootstrap.sql, the
// reference fixture, run ids and the paths the template is built from. The databases themselves are tested in
// test/integration/test-database.int.test.ts. The statements `dropDatabase` sends for a database that another drop
// has marked invalid (FIX-W60-TESTS) are tested here against a fake `pg` client: such a database cannot be made as
// velexis_test_admin (NOSUPERUSER), only by a drop that is running or was interrupted.

/** One connection a fake `pg.Client` opened, with the SQL it was sent in order. */
interface FakeConnection {
  readonly url: string;
  readonly statements: string[];
  /** Closed by the server after a FATAL error: every later query fails, as pg's own client does. */
  closed: boolean;
  ended: boolean;
}

/** What the fake server answers on connection `index` (0 is the first one opened) to `text`: rows, or it throws. */
type FakeAnswer = (index: number, text: string) => readonly Record<string, unknown>[];

const fake = vi.hoisted(() => ({
  connections: [] as FakeConnection[],
  answer: ((): readonly Record<string, unknown>[] => []) as FakeAnswer,
}));

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<{ default: { escapeIdentifier(value: string): string } }>();
  class Client {
    private readonly connection: FakeConnection;
    private readonly index: number;

    constructor(options: { connectionString: string }) {
      this.connection = { url: options.connectionString, statements: [], closed: false, ended: false };
      this.index = fake.connections.push(this.connection) - 1;
    }

    on(): this {
      return this;
    }

    connect(): Promise<void> {
      return Promise.resolve();
    }

    query(text: string): Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number }> {
      if (this.connection.closed) {
        return Promise.reject(new Error("Client was closed and is not queryable"));
      }
      this.connection.statements.push(text.replace(/\s+/g, " ").trim());
      try {
        const rows = fake.answer(this.index, text);
        return Promise.resolve({ rows, rowCount: rows.length });
      } catch (error) {
        if ((error as { severity?: unknown }).severity === "FATAL") {
          this.connection.closed = true;
        }
        return Promise.reject(error as Error);
      }
    }

    end(): Promise<void> {
      this.connection.ended = true;
      return Promise.resolve();
    }
  }
  return { default: { escapeIdentifier: actual.default.escapeIdentifier, Client } };
});

/** An error as pg reports the server's ErrorResponse: SQLSTATE in `code`, and its severity. */
function serverError(code: string, severity: "ERROR" | "FATAL", message: string): Error {
  return Object.assign(new Error(message), { code, severity });
}

describe("databaseGrantStatements", () => {
  it("are the database-level statements of bootstrap.sql's Database section, in order", () => {
    const bootstrap = readFileSync(join(REPO_ROOT, "deploy/postgres/bootstrap.sql"), "utf8");
    const mirrored = [
      ...bootstrap.matchAll(/^SELECT format\('((?:REVOKE|GRANT) [^']* ON DATABASE %I [^']*)'/gm),
    ].map((match) => (match[1] as string).replace("%I", '"velexis_test_x"'));
    expect(mirrored).toHaveLength(4);
    expect(databaseGrantStatements("velexis_test_x")).toEqual(mirrored);
  });

  it("quotes the database name as an identifier", () => {
    expect(databaseGrantStatements('odd"name')[0]).toBe('REVOKE ALL ON DATABASE "odd""name" FROM PUBLIC');
  });
});

describe("REFERENCE_FIXTURE", () => {
  it("has 3 currencies, 3 countries, 5 airports and 3 airlines whose references resolve", () => {
    const { currencies, countries, airports, airlines } = REFERENCE_FIXTURE;
    expect([currencies.length, countries.length, airports.length, airlines.length]).toEqual([3, 3, 5, 3]);
    const currencyCodes = new Set(currencies.map((row) => row.code));
    const countryCodes = new Set(countries.map((row) => row.code));
    expect(countries.every((row) => currencyCodes.has(row.currency_code))).toBe(true);
    expect(airports.every((row) => countryCodes.has(row.country_code))).toBe(true);
    expect(airlines.every((row) => countryCodes.has(row.country_code))).toBe(true);
    expect(new Set(airports.map((row) => row.iata_code)).size).toBe(5);
  });
});

describe("run ids and template names", () => {
  it("names the template velexis_test_tpl_<runId> and reads the run id back", () => {
    const runId = newRunId();
    expect(runId).toMatch(/^[a-z0-9]+_[0-9a-f]{6}$/);
    expect(runIdOfTemplate(`${TEMPLATE_DATABASE_PREFIX}${runId}`)).toBe(runId);
    // Every name built from it stays under PostgreSQL's 63-byte identifier limit.
    expect(`velexis_test_${runId}_${"0".repeat(12)}`.length).toBeLessThanOrEqual(63);
    expect(newRunId()).not.toBe(runId);
  });

  it("refuses names that are not template names", () => {
    expect(() => runIdOfTemplate("velexis")).toThrow(
      new TypeError("velexis is not a template database name (velexis_test_tpl_<runId>)"),
    );
    expect(() => runIdOfTemplate(`${TEMPLATE_DATABASE_PREFIX}Bad-Id`)).toThrow(TypeError);
  });
});

describe("the files the template is built from", () => {
  it("exist in the repository", () => {
    expect(existsSync(SCHEMAS_SQL)).toBe(true);
    expect(existsSync(join(SHARED_MIGRATIONS_DIR, "platform", "0001_baseline.sql"))).toBe(true);
    expect(existsSync(join(SHARED_MIGRATIONS_DIR, "reference", "0001_baseline.sql"))).toBe(true);
    expect(existsSync(join(TENANT_MIGRATIONS_DIR, "0001_baseline.sql"))).toBe(true);
    expect(TEST_TENANTS).toEqual(["tenant_alpha", "tenant_beta"]);
  });
});

describe("dropDatabase", () => {
  const ADMIN_URL = "postgres://velexis_test_admin:dev_test_admin@127.0.0.1:5432/postgres";
  const DATABASE = "velexis_test_unit_0123456789ab";
  const CHECK = "SELECT datconnlimit AS connlimit FROM pg_database WHERE datname = $1";
  const ALTER = `ALTER DATABASE "${DATABASE}" WITH ALLOW_CONNECTIONS false`;
  const DROP = `DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`;
  /** The foreign-session lookup of terminateForeignSessions. */
  const isSessionLookup = (text: string): boolean => text.includes("pg_stat_activity");

  beforeEach(() => {
    fake.connections.length = 0;
    fake.answer = () => [];
  });

  it("refuses connections, looks for the app roles' sessions, then drops a valid database [FIX-W60-TESTS]", async () => {
    fake.answer = (_index, text) => (text.startsWith("SELECT datconnlimit") ? [{ connlimit: -1 }] : []);

    await dropDatabase(ADMIN_URL, DATABASE);

    expect(fake.connections).toHaveLength(1);
    const [check, alter, lookup, drop] = fake.connections[0]!.statements;
    expect([check, alter, drop]).toEqual([CHECK, ALTER, DROP]);
    expect(isSessionLookup(lookup ?? "")).toBe(true);
    expect(fake.connections[0]!.ended).toBe(true);
  });

  it("drops a database another drop marked invalid (datconnlimit -2) without ALTER or session lookup [FIX-W60-TESTS]", async () => {
    fake.answer = (_index, text) => (text.startsWith("SELECT datconnlimit") ? [{ connlimit: -2 }] : []);

    await dropDatabase(ADMIN_URL, DATABASE);

    expect(fake.connections.map((connection) => connection.statements)).toEqual([[CHECK, DROP]]);
  });

  it("tries again on a new connection when the ALTER meets a database marked invalid meanwhile (FATAL 55000) [FIX-W60-TESTS]", async () => {
    // The first check still sees a valid database; then another drop marks it invalid, the ALTER gets the FATAL
    // 55000 and the server closes that session; the second attempt finds the drop still running.
    fake.answer = (index, text) => {
      if (text.startsWith("SELECT datconnlimit")) {
        return [{ connlimit: index === 0 ? -1 : -2 }];
      }
      if (text.startsWith("ALTER DATABASE")) {
        throw serverError("55000", "FATAL", `cannot alter invalid database "${DATABASE}"`);
      }
      return [];
    };

    await dropDatabase(ADMIN_URL, DATABASE);

    expect(fake.connections.map((connection) => connection.statements)).toEqual([
      [CHECK, ALTER],
      [CHECK, DROP],
    ]);
    expect(fake.connections.every((connection) => connection.ended)).toBe(true);
  });

  it("returns at once for a missing database and rethrows an error it does not retry [FIX-W60-TESTS]", async () => {
    await dropDatabase(ADMIN_URL, DATABASE);
    expect(fake.connections.map((connection) => connection.statements)).toEqual([[CHECK]]);

    fake.connections.length = 0;
    const refused = serverError("57014", "ERROR", "canceling statement due to statement timeout");
    fake.answer = (_index, text) => {
      if (text.startsWith("DROP DATABASE")) {
        throw refused;
      }
      return text.startsWith("SELECT datconnlimit") ? [{ connlimit: -2 }] : [];
    };
    await expect(dropDatabase(ADMIN_URL, DATABASE)).rejects.toBe(refused);
    expect(fake.connections).toHaveLength(1);
  });
});
