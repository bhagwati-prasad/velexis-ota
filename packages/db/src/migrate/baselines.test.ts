// The baseline migrations and the OTA read grants of the repository (X-012; ADR-0005 Baselines, ADR-0004
// Database roles, ADR-0021). No database: the files themselves, as the runner reads them. The privileges they
// give on PostgreSQL are proven by test/integration/baselines.int.test.ts.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readMigrationFiles, splitSqlStatements, type MigrationFile, type MigrationSet } from "./index.js";

const REPO = resolve(__dirname, "..", "..", "..", "..");
const PACKAGE_DIR = resolve(__dirname, "..", "..");
const REFERENCE_DDL = resolve(REPO, "docs", "velexis-sdk", "db");

/** The migration folder of each set, and the reference DDL its baseline copies. */
const SETS: ReadonlyArray<{ set: MigrationSet; dir: string; source: string }> = [
  { set: "platform", dir: "platform/backend/migrations/platform", source: "platform.sql" },
  { set: "reference", dir: "platform/backend/migrations/reference", source: "reference.sql" },
  { set: "tenant", dir: "ota/backend/migrations/tenant", source: "tenant.sql" },
];

/** ADR-0004: the platform tables velexis_ota_app may read in full. */
const OTA_READABLE_TABLES = [
  "tenants",
  "tenant_domains",
  "api_keys",
  "api_key_tenant_grants",
  "tenant_memberships",
  "plans",
  "supplier_connections",
  "payment_provider_connections",
];
/** ADR-0004: the only `platform.accounts` columns velexis_ota_app may read. */
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
/** ADR-0004, ADR-0021: secrets, hashes and security counters of `platform.accounts`, never granted. */
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

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** One statement on one line, single spaces: the way the assertions below spell them. */
const normalise = (statement: string): string =>
  statement.replace(/\s+/g, " ").replace(/\(\s/g, "(").replace(/\s\)/g, ")").trim();

/** The `platform.<table>` names created by platform.sql, in file order. */
function platformTables(ddl: string): string[] {
  return [...ddl.matchAll(/^CREATE TABLE platform\.([a-z_]+) \(/gm)].map((match) => match[1] ?? "");
}

/** The column names of `platform.<table>` in platform.sql: the two-space indented lines of its body. */
function platformColumns(ddl: string, table: string): string[] {
  const start = ddl.indexOf(`CREATE TABLE platform.${table} (\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = ddl.slice(start, ddl.indexOf("\n);", start));
  return [...body.matchAll(/^ {2}([a-z][a-z0-9_]*) /gm)].map((match) => match[1] ?? "");
}

async function repeatableFile(): Promise<MigrationFile> {
  const files = await readMigrationFiles(resolve(REPO, "platform/backend/migrations/platform"), "platform");
  const file = files.repeatable.find((candidate) => candidate.id === "R__ota_read_access");
  expect(file).toBeDefined();
  return file as MigrationFile;
}

describe("the baseline migrations", () => {
  for (const { set, dir, source } of SETS) {
    it(`${dir}/0001_baseline.sql has the SHA-256 of docs/velexis-sdk/db/${source} [X-012 AC1]`, async () => {
      const baseline = await readFile(resolve(REPO, dir, "0001_baseline.sql"));
      const reference = await readFile(resolve(REFERENCE_DDL, source));
      expect(sha256(baseline)).toBe(sha256(reference));
      expect(baseline.equals(reference)).toBe(true);
    });

    it(`the runner reads ${dir}: the baseline, phase expand, with the checksum of ${source} [X-012 AC1]`, async () => {
      const files = await readMigrationFiles(resolve(REPO, dir), set);
      expect(files.exists).toBe(true);
      // The baseline comes first; the platform set continues with the MVP deltas of 0002 (PBE-002), the tenant set
      // with its own (OBE-008).
      expect(files.numbered.map((file) => [file.id, file.kind, file.phase, file.noTransaction])).toEqual([
        ["0001_baseline", "numbered", "expand", false],
        ...(set === "platform" ? [["0002_add_mvp_platform_deltas", "numbered", "expand", false]] : []),
        ...(set === "tenant"
          ? [
              ["0002_add_mvp_tenant_deltas", "numbered", "expand", false],
              // The booking sync's claim column and last changes (FIX-W27-SYNC).
              ["0003_add_booking_sync_claim", "numbered", "expand", false],
            ]
          : []),
      ]);
      expect(files.numbered[0]?.checksum).toBe(sha256(await readFile(resolve(REFERENCE_DDL, source))));
      expect(files.repeatable.map((file) => [file.id, file.phase])).toEqual(
        set === "platform" ? [["R__ota_read_access", "repeatable"]] : [],
      );
    });
  }

  it("is what pnpm db:migrate applies: the platform set, then the reference set [X-012 AC6]", async () => {
    const root = JSON.parse(await readFile(resolve(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts["db:migrate"]).toBe("pnpm --filter @velexis/db run migrate");

    const pkg = JSON.parse(await readFile(resolve(PACKAGE_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const commands = (pkg.scripts["migrate"] ?? "").split("&&").map((command) => command.trim().split(/\s+/));
    expect(commands.map((argv) => argv.slice(0, 4))).toEqual([
      ["node", "dist/cli/migrate.js", "platform", "--dir"],
      ["node", "dist/cli/migrate.js", "reference", "--dir"],
    ]);
    // A missing folder would be an empty set (ADR-0021), so a wrong path would apply nothing without an error.
    const dirs = commands.map((argv) => resolve(PACKAGE_DIR, argv[4] ?? ""));
    expect(dirs).toEqual([
      resolve(REPO, "platform/backend/migrations/platform"),
      resolve(REPO, "platform/backend/migrations/reference"),
    ]);
    for (const dir of dirs) {
      expect((await stat(dir)).isDirectory()).toBe(true);
    }
  });
});

describe("R__ota_read_access.sql", () => {
  it("grants SELECT on exactly the eight platform tables of ADR-0004 and the listed accounts columns [X-012 AC2]", async () => {
    const file = await repeatableFile();
    expect(file.description).toBe(
      "OTA backend read access: SELECT for velexis_ota_app on the baseline platform tables it needs.",
    );
    expect(splitSqlStatements(file.sql).map(normalise)).toEqual([
      `GRANT SELECT ON ${OTA_READABLE_TABLES.map((table) => `platform.${table}`).join(", ")} TO velexis_ota_app`,
      `GRANT SELECT (${OTA_READABLE_ACCOUNT_COLUMNS.join(", ")}) ON platform.accounts TO velexis_ota_app`,
    ]);

    // Every name exists in the baseline, so the grants apply and a typo cannot pass unnoticed.
    const ddl = await readFile(resolve(REFERENCE_DDL, "platform.sql"), "utf8");
    const tables = platformTables(ddl);
    expect(tables).toHaveLength(16);
    expect(tables).toEqual(expect.arrayContaining([...OTA_READABLE_TABLES, "accounts"]));
    expect(platformColumns(ddl, "accounts")).toEqual(expect.arrayContaining(OTA_READABLE_ACCOUNT_COLUMNS));
  });

  it("never grants the secrets, hashes or security counters of platform.accounts [X-012 AC3]", async () => {
    const file = await repeatableFile();
    const ddl = await readFile(resolve(REFERENCE_DDL, "platform.sql"), "utf8");
    const accountColumns = platformColumns(ddl, "accounts");
    // The denied columns are real columns of the baseline: the integration test selects each of them.
    expect(accountColumns).toEqual(expect.arrayContaining(NEVER_GRANTED_ACCOUNT_COLUMNS));
    expect(
      OTA_READABLE_ACCOUNT_COLUMNS.filter((column) => NEVER_GRANTED_ACCOUNT_COLUMNS.includes(column)),
    ).toEqual([]);

    const statements = splitSqlStatements(file.sql).map(normalise);
    for (const statement of statements) {
      for (const column of NEVER_GRANTED_ACCOUNT_COLUMNS) {
        expect(statement).not.toMatch(new RegExp(`\\b${column}\\b`));
      }
    }
    // accounts is granted column by column only: a table-level SELECT would cover every column.
    const onAccounts = statements.filter((statement) => /\bplatform\.accounts\b/.test(statement));
    expect(onAccounts).toEqual([
      expect.stringMatching(/^GRANT SELECT \([a-z_, ]+\) ON platform\.accounts TO /),
    ]);
  });

  it("grants nothing but SELECT, nothing on the other platform tables, and nothing to another role [X-012 AC4]", async () => {
    const statements = splitSqlStatements((await repeatableFile()).sql).map(normalise);
    for (const statement of statements) {
      expect(statement).toMatch(/^GRANT SELECT\b/);
      expect(statement).toMatch(/ TO velexis_ota_app$/);
      expect(statement).not.toMatch(/\bALL\b|\bWITH GRANT OPTION\b|\bPUBLIC\b/i);
    }
    const named = statements.flatMap((statement) =>
      [...statement.matchAll(/\bplatform\.([a-z_]+)/g)].map((match) => match[1]),
    );
    expect(new Set(named)).toEqual(new Set([...OTA_READABLE_TABLES, "accounts"]));
    for (const table of OTA_DENIED_TABLES) {
      expect(named).not.toContain(table);
    }
  });
});
