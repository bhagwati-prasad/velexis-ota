// Migration 0003 as the runner reads it (FIX-W29-PLATFORM; conventions §9, PADR-0002 item 3 revision of 2026-10-24):
// the third platform file, an `expand` migration applied in one transaction, that creates `billing_customer_attempts`
// with a comment on the table and on every column and grants DML to velexis_platform_app only; and the Kysely table
// types generated after it (`pnpm db:codegen`) carry the table, at compile time (`pnpm typecheck`). No database:
// test/integration/migrations/migrate-0003.int.test.ts applies it from scratch and as an upgrade.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import { readMigrationFiles } from "@velexis/db/migrate";
import { describe, expect, expectTypeOf, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO, "platform", "backend", "migrations", "platform");
const MIGRATION_ID = "0003_add_billing_customer_attempts";

describe("migration 0003", () => {
  it("[FIX-W29-PLATFORM AC2] is read by the runner as the third platform file: expand, one transaction, commented, granted to the platform role only", async () => {
    const files = await readMigrationFiles(MIGRATIONS_DIR, "platform");
    expect(files.numbered.map((file) => file.id).slice(0, 3)).toEqual([
      "0001_baseline",
      "0002_add_mvp_platform_deltas",
      MIGRATION_ID,
    ]);
    expect(files.numbered[2]).toMatchObject({
      kind: "numbered",
      phase: "expand",
      noTransaction: false,
      description: expect.stringMatching(/^Add the attempts of a tenant's Stripe Customer creation/),
    });

    const sql = await readFile(join(MIGRATIONS_DIR, `${MIGRATION_ID}.sql`), "utf8");
    expect(sql.startsWith("-- velexis:phase expand\n")).toBe(true);
    expect(sql.endsWith(";\n")).toBe(true);
    expect([...sql.matchAll(/^CREATE TABLE (\S+) \(/gm)].map((match) => match[1])).toEqual([
      "platform.billing_customer_attempts",
    ]);
    expect([...sql.matchAll(/^COMMENT ON (TABLE|COLUMN) (\S+) IS /gm)].map((match) => match[2])).toEqual([
      "platform.billing_customer_attempts",
      "platform.billing_customer_attempts.tenant_id",
      "platform.billing_customer_attempts.attempt",
      "platform.billing_customer_attempts.updated_at",
    ]);
    expect([...sql.matchAll(/^(GRANT|REVOKE) .*$/gm)].map((match) => match[0])).toEqual([
      "GRANT SELECT, INSERT, UPDATE, DELETE ON platform.billing_customer_attempts TO velexis_platform_app;",
    ]);
  });

  it("[FIX-W29-PLATFORM AC2] is in the generated table types: the attempt a number, the tenant a text id", () => {
    // Compile time: `pnpm typecheck` fails when the table or a column is missing or has another type.
    expectTypeOf<PlatformDatabase>().toHaveProperty("platform.billing_customer_attempts");
    type Row = Selectable<PlatformDatabase["platform.billing_customer_attempts"]>;
    expectTypeOf<Row>().toHaveProperty("tenant_id").toEqualTypeOf<string>();
    expectTypeOf<Row>().toHaveProperty("attempt").toEqualTypeOf<number>();
    expectTypeOf<Row>().toHaveProperty("updated_at").toEqualTypeOf<Date>();
  });
});
