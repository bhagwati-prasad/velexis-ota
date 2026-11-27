// Migration 0005 as the runner reads it (PBE-078; ADR-0030 items 2, 3 and 11, PADR-0020 items 7 to 9, conventions §9,
// platform/docs/data-model.md §4.11): the fifth platform file, an `expand` migration applied in one transaction, that
// creates the four tables of the supplier registry with a comment on each table and each column, adds the supply
// source and the per-tenant switch to supplier_connections and the supply source to amadeus_accounts, each commented,
// replaces the CHECK of `provider` by a foreign key and supplier_connections_source_ck by its rewrite (NOT VALID, then
// VALIDATE), and grants DML on the registry to velexis_platform_app and, column by column, what the OTA backend reads
// to velexis_ota_app; the `ssr_` id of a source is a prefixed ULID of PLATFORM_ID_PREFIXES and the `sup_` supply id
// is no ULID; and the Kysely table types generated after it (`pnpm db:codegen`) carry the tables and columns, at
// compile time (`pnpm typecheck`) and in the committed file. No database: test/integration/migrations/
// migrate-0005.int.test.ts applies it from scratch and as an upgrade, and packages/db's baselines.int.test.ts proves
// the grants and denials of the OTA role.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import { readMigrationFiles, splitSqlStatements } from "@velexis/db/migrate";
import { describe, expect, expectTypeOf, it } from "vitest";
import { PLATFORM_ID_PREFIXES } from "../../src/common/ids";

const REPO = resolve(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO, "platform", "backend", "migrations", "platform");
const MIGRATION_ID = "0005_add_supplier_registry";
const GENERATED_TYPES = join(REPO, "packages", "db", "src", "generated", "platform.ts");

/** The four registry tables, in the order 0005 creates them. */
const REGISTRY_TABLES = [
  "suppliers",
  "supplier_environments",
  "supply_sources",
  "supply_source_ids",
] as const;
/** The columns 0005 adds to tables that existed before it. */
const ADDED_COLUMNS = [
  ["supplier_connections", "supply_source_id"],
  ["supplier_connections", "sales_enabled"],
  ["amadeus_accounts", "supply_source_id"],
] as const;
/** What velexis_ota_app may read of the registry (OBE-146's reads), column by column; nothing of suppliers. */
const OTA_COLUMNS = {
  supplier_environments: ["supplier_id", "environment", "sales_enabled"],
  supply_sources: ["id", "supplier_id", "environment", "credential_source", "tenant_id", "sales_stop"],
  supply_source_ids: ["supply_id", "supply_source_id", "retired_at"],
} as const;

/** The file without its comment lines. */
async function statementsText(): Promise<string> {
  const sql = await readFile(join(MIGRATIONS_DIR, `${MIGRATION_ID}.sql`), "utf8");
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** The column names of a `CREATE TABLE platform.<table> (…);` of the file, in order. */
function createdColumns(sql: string, table: string): string[] {
  const body = new RegExp(`^CREATE TABLE platform\\.${table} \\(\\n([\\s\\S]*?)^\\);$`, "m").exec(sql)?.[1];
  if (body === undefined) {
    throw new Error(`0005 creates no table platform.${table}`);
  }
  return [...body.matchAll(/^ {2}([a-z_]+) +(?:text|boolean|integer|timestamptz)\b/gm)].map(
    (match) => match[1] ?? "",
  );
}

describe("migration 0005", () => {
  it("[PBE-078 AC1] is read by the runner as the fifth platform file: expand, one transaction, no transaction control", async () => {
    const files = await readMigrationFiles(MIGRATIONS_DIR, "platform");
    expect(files.numbered.map((file) => file.id).slice(0, 5)).toEqual([
      "0001_baseline",
      "0002_add_mvp_platform_deltas",
      "0003_add_billing_customer_attempts",
      "0004_add_plan_price_warnings",
      MIGRATION_ID,
    ]);
    expect(files.numbered[4]).toMatchObject({
      kind: "numbered",
      phase: "expand",
      noTransaction: false,
      description: expect.stringMatching(/^Add the supplier registry and tie the supplier connections/),
    });
    const sql = await readFile(join(MIGRATIONS_DIR, `${MIGRATION_ID}.sql`), "utf8");
    expect(sql.startsWith("-- velexis:phase expand\n")).toBe(true);
    expect(sql.endsWith(";\n")).toBe(true);
    for (const statement of splitSqlStatements(sql)) {
      expect(statement).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|SAVEPOINT)\b/i);
    }
  });

  it("[PBE-078 AC1] creates the four registry tables and comments every table and column it adds", async () => {
    const sql = await statementsText();
    expect([...sql.matchAll(/^CREATE TABLE (\S+) \(/gm)].map((match) => match[1])).toEqual(
      REGISTRY_TABLES.map((table) => `platform.${table}`),
    );
    const commented = [...sql.matchAll(/^COMMENT ON (TABLE|COLUMN) (\S+) IS /gm)].map((match) => match[2]);
    const expected = [
      ...REGISTRY_TABLES.flatMap((table) => [
        `platform.${table}`,
        ...createdColumns(sql, table).map((column) => `platform.${table}.${column}`),
      ]),
      ...ADDED_COLUMNS.map(([table, column]) => `platform.${table}.${column}`),
    ];
    expect(new Set(commented)).toEqual(new Set([...expected, "platform.supplier_connections.provider"]));
    expect(commented).toHaveLength(new Set(commented).size);
    expect(
      [...sql.matchAll(/^ALTER TABLE platform\.(\S+)\s+ADD COLUMN (\S+) /gm)].map((match) => [
        match[1],
        match[2],
      ]),
    ).toEqual([
      ["supplier_connections", "supply_source_id"],
      ["amadeus_accounts", "supply_source_id"],
    ]);
    expect(sql).toContain("  ADD COLUMN sales_enabled boolean NOT NULL DEFAULT true;");
    expect(sql).toContain("  ADD COLUMN supply_source_id text,\n");
  });

  it("[PBE-078 AC2] replaces the CHECK of provider by a foreign key, keeps its default, adds the credential source to the unique key and rewrites the source CHECK NOT VALID, then validated", async () => {
    const sql = await statementsText();
    // provider: the FK first (NOT VALID), the baseline's CHECK dropped, the FK validated; the default is not touched.
    expect(sql).toMatch(
      /ADD CONSTRAINT supplier_connections_provider_fk FOREIGN KEY \(provider\)\s+REFERENCES platform\.suppliers \(id\) ON DELETE RESTRICT NOT VALID;/,
    );
    expect(sql).toContain("DROP CONSTRAINT supplier_connections_provider_check;");
    expect(sql).toContain("VALIDATE CONSTRAINT supplier_connections_provider_fk;");
    expect(sql).not.toMatch(/ALTER COLUMN provider/);
    // The unique key: one row per tenant, supplier, environment and credential source.
    expect(sql).toContain(
      "ADD CONSTRAINT supplier_connections_env_source_uq UNIQUE (tenant_id, provider, environment, credential_source);",
    );
    expect(sql).toContain("DROP CONSTRAINT supplier_connections_env_uq;");
    // The source CHECK keeps its name, so a violation still names it.
    const sourceCheck = sql.indexOf("ADD CONSTRAINT supplier_connections_source_ck CHECK (");
    expect(sql.indexOf("DROP CONSTRAINT supplier_connections_source_ck;")).toBeLessThan(sourceCheck);
    expect(sql.indexOf(") NOT VALID;", sourceCheck)).toBeGreaterThan(sourceCheck);
    expect(sql.indexOf("VALIDATE CONSTRAINT supplier_connections_source_ck;")).toBeGreaterThan(sourceCheck);
    expect(sql).toContain(
      "(provider <> 'amadeus' AND amadeus_account_id IS NULL AND supply_source_id IS NOT NULL)",
    );
  });

  it("[PBE-078 AC1] gives a source an ssr_ ULID of PLATFORM_ID_PREFIXES and a supply id a pattern CHECK of sup_ and 16 base32 characters", async () => {
    const sql = await statementsText();
    expect(sql).toContain("id                       text PRIMARY KEY CHECK (id LIKE 'ssr\\_%'),");
    expect(PLATFORM_ID_PREFIXES).toContain("ssr");
    // No ULID: no `id LIKE 'sup\_%'` CHECK (ids.test.ts reads those as prefixes of PLATFORM_ID_PREFIXES).
    expect(sql).not.toMatch(/LIKE 'sup\\_%'/);
    expect(sql).toContain("CHECK (supply_id ~ '^sup_[0-9A-HJKMNP-TV-Z]{16}$')");
    expect(PLATFORM_ID_PREFIXES).not.toContain("sup");
    // pgcrypto is not installed: the ids of the backfill come from gen_random_uuid() of core PostgreSQL 16.
    expect(sql).toContain("gen_random_uuid()");
    expect(sql).not.toMatch(/gen_random_bytes|pgcrypto|CREATE EXTENSION/i);
  });

  it("[PBE-078 AC3] grants DML on the registry to the platform role and, column by column, only what the OTA backend reads", async () => {
    const statements = splitSqlStatements(await readFile(join(MIGRATIONS_DIR, `${MIGRATION_ID}.sql`), "utf8"))
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter((statement) => /^(GRANT|REVOKE)\b/.test(statement));
    expect(statements).toEqual([
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${REGISTRY_TABLES.map((table) => `platform.${table}`).join(", ")} ` +
        "TO velexis_platform_app",
      ...Object.entries(OTA_COLUMNS).map(
        ([table, columns]) => `GRANT SELECT (${columns.join(", ")}) ON platform.${table} TO velexis_ota_app`,
      ),
    ]);
  });

  it("[PBE-078 AC1] is in the generated table types: the four tables and the new columns", async () => {
    // Compile time: `pnpm typecheck` fails when a table or a column is missing or has another type.
    expectTypeOf<PlatformDatabase>().toHaveProperty("platform.suppliers");
    expectTypeOf<PlatformDatabase>().toHaveProperty("platform.supplier_environments");
    expectTypeOf<PlatformDatabase>().toHaveProperty("platform.supply_sources");
    expectTypeOf<PlatformDatabase>().toHaveProperty("platform.supply_source_ids");
    type Connection = Selectable<PlatformDatabase["platform.supplier_connections"]>;
    expectTypeOf<Connection>().toHaveProperty("supply_source_id").toEqualTypeOf<string | null>();
    expectTypeOf<Connection>().toHaveProperty("sales_enabled").toEqualTypeOf<boolean>();
    type Account = Selectable<PlatformDatabase["platform.amadeus_accounts"]>;
    expectTypeOf<Account>().toHaveProperty("supply_source_id").toEqualTypeOf<string | null>();
    type Source = Selectable<PlatformDatabase["platform.supply_sources"]>;
    expectTypeOf<Source>().toHaveProperty("sales_stop").toEqualTypeOf<string | null>();
    expectTypeOf<Source>().toHaveProperty("tenant_id").toEqualTypeOf<string | null>();
    type SupplyId = Selectable<PlatformDatabase["platform.supply_source_ids"]>;
    expectTypeOf<SupplyId>().toHaveProperty("supply_id").toEqualTypeOf<string>();
    expectTypeOf<SupplyId>().toHaveProperty("retired_at").toEqualTypeOf<Date | null>();

    // Run time: the committed file that `pnpm db:codegen` writes (CI fails on any diff after regenerating it).
    const generated = await readFile(GENERATED_TYPES, "utf8");
    for (const name of ["Suppliers", "SupplierEnvironments", "SupplySources", "SupplySourceIds"]) {
      expect(generated).toMatch(new RegExp(`^export interface Platform${name} \\{$`, "m"));
    }
    const connections = /^export interface PlatformSupplierConnections \{\n([\s\S]*?)^\}$/m.exec(
      generated,
    )?.[1];
    expect(connections).toMatch(/^ {2}sales_enabled: Generated<boolean>;$/m);
    expect(connections).toMatch(/^ {2}supply_source_id: string \| null;$/m);
  });
});
