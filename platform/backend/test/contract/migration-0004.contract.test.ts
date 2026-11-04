// Migration 0004 as the runner reads it (FIX-W42-PLATFORM, lead decision (4c) of 2026-11-04, second set; conventions
// §9, PADR-0002 item 2): the fourth platform file, an `expand` migration applied in one transaction, that adds one
// column to `plans` (`price_warnings`, a JSON array of the plan's price warnings) with its CHECK and comment, creates no
// table, grants nothing (the table-level privileges on `plans` cover the column) and writes no row; and the Kysely
// table types generated after it (`pnpm db:codegen`) carry the column, at compile time (`pnpm typecheck`) and in the
// committed file. No database: test/integration/migrations/migrate-0004.int.test.ts applies it from scratch and as an
// upgrade.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import { readMigrationFiles } from "@velexis/db/migrate";
import { describe, expect, expectTypeOf, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO, "platform", "backend", "migrations", "platform");
const MIGRATION_ID = "0004_add_plan_price_warnings";
const GENERATED_TYPES = join(REPO, "packages", "db", "src", "generated", "platform.ts");

describe("migration 0004", () => {
  it("[FIX-W42-PLATFORM AC1] is read by the runner as the fourth platform file: expand, one transaction, one commented column of plans, no grant", async () => {
    const files = await readMigrationFiles(MIGRATIONS_DIR, "platform");
    expect(files.numbered.map((file) => file.id).slice(0, 4)).toEqual([
      "0001_baseline",
      "0002_add_mvp_platform_deltas",
      "0003_add_billing_customer_attempts",
      MIGRATION_ID,
    ]);
    expect(files.numbered[3]).toMatchObject({
      kind: "numbered",
      phase: "expand",
      noTransaction: false,
      description: expect.stringMatching(/^Add the price warnings of a plan's last comparison/),
    });

    const sql = await readFile(join(MIGRATIONS_DIR, `${MIGRATION_ID}.sql`), "utf8");
    expect(sql.startsWith("-- velexis:phase expand\n")).toBe(true);
    expect(sql.endsWith(";\n")).toBe(true);
    const statements = sql
      .split("\n")
      .filter((line) => !line.startsWith("--") && line.trim() !== "")
      .join("\n");
    expect(
      [...statements.matchAll(/^ALTER TABLE (\S+) ADD COLUMN (\S+) /gm)].map((m) => [m[1], m[2]]),
    ).toEqual([["platform.plans", "price_warnings"]]);
    // A JSON array, never null, empty by default; the CHECK refuses an object, a string or a number.
    expect(statements).toContain(
      "ADD COLUMN price_warnings jsonb NOT NULL DEFAULT '[]'::jsonb\n" +
        "  CONSTRAINT plans_price_warnings_ck CHECK (jsonb_typeof(price_warnings) = 'array');",
    );
    expect([...statements.matchAll(/^COMMENT ON (TABLE|COLUMN) (\S+) IS /gm)].map((m) => m[2])).toEqual([
      "platform.plans.price_warnings",
    ]);
    // No table, no privilege and no data: the warnings come with the plans' next comparison (no backfill).
    expect(statements).not.toMatch(/^(CREATE|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b/m);
  });

  it("[FIX-W42-PLATFORM AC1] is in the generated table types: price_warnings of plans is JSON, generated (it has a default)", async () => {
    // Compile time: `pnpm typecheck` fails when the column is missing or has another type.
    type PlanRow = Selectable<PlatformDatabase["platform.plans"]>;
    expectTypeOf<PlanRow>().toHaveProperty("price_warnings");
    expectTypeOf<PlanRow["price_warnings"]>().not.toBeAny();
    expectTypeOf<[]>().toExtend<PlanRow["price_warnings"]>();

    // Run time: the committed file that `pnpm db:codegen` writes (CI fails on any diff after regenerating it).
    const generated = await readFile(GENERATED_TYPES, "utf8");
    const plans = /^export interface PlatformPlans \{\n([\s\S]*?)^\}$/m.exec(generated)?.[1] ?? "";
    expect(plans).toMatch(/^ {2}price_warnings: Generated<Json>;$/m);
  });
});
