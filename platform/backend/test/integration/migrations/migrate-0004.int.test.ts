// Migration 0004 on PostgreSQL 16 (FIX-W42-PLATFORM, lead decision (4c) of 2026-11-04, second set; PADR-0002 item 2,
// conventions §9): the column `plans.price_warnings` that keeps the price warnings of a plan's last comparison with its
// Stripe prices. It must apply from scratch and as an upgrade of a database at the previous version:
//   - from scratch: the template database of @velexis/testing (the real runner and the real folders), cloned here;
//   - as an upgrade: a new empty database prepared like deploy/postgres/bootstrap.sql, the runner applied to a
//     temporary folder holding the files before 0004 (0001 to 0003 and the repeatable grants), one plan written by
//     velexis_platform_app, then the runner applied to the real folder: only 0004 is applied, and the plan survives
//     with no warning and its version (`updated_at`) unchanged.
// The column's rules are checked as the roles that use it: velexis_platform_app writes it (the CHECK and NOT NULL
// refuse what the code must never write), and velexis_ota_app reads `plans` in full (ADR-0004), this column included.
// admin-billing.int.test.ts uses it through adminUpdatePlan, adminCheckPlanPrices and adminListPlans.
// Databases are created as TEST_DATABASE_ADMIN_URL with the development role passwords of .env.example (TEST_ROLES),
// named velexis_test_<runId>_<random> so the global teardown removes any left behind.
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool } from "@velexis/db";
import { runMigrations, type RunMigrationsResult } from "@velexis/db/migrate";
import {
  createTestDatabase,
  databaseGrantStatements,
  databaseUrl,
  dropDatabase,
  runIdOfTemplate,
  TEMPLATE_DATABASE_KEY,
  TEST_DATABASE_PREFIX,
  TEST_ROLES,
  testDatabaseAdminUrl,
  type TestDatabase,
} from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { insertPlan } from "../../builders/platform-rows";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");
const PLATFORM_MIGRATIONS = join(REPO, "platform", "backend", "migrations", "platform");
const SCHEMAS_SQL = join(REPO, "deploy", "postgres", "schemas.sql");
const MIGRATION_ID = "0004_add_plan_price_warnings";
/** The files of the version before 0004. */
const PREVIOUS_FILES = [
  "0001_baseline.sql",
  "0002_add_mvp_platform_deltas.sql",
  "0003_add_billing_customer_attempts.sql",
  "R__ota_read_access.sql",
];
/** The first number of this file's plans (`plan_<n>`), away from the other test files'. */
const FIRST_PLAN = 9_420;
const WARNING = { field: "stripePriceIdMonth.currency", expected: "EUR", actual: "USD" };

type Pool = ReturnType<typeof createPool>;
type Row = Record<string, unknown>;

const adminUrl = testDatabaseAdminUrl();

function pool(url: string): Pool {
  return createPool(url, {
    applicationName: "platform-int-migrate-0004",
    logger: { error: () => undefined },
    max: 2,
  });
}

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** The run id of the template the global setup built, so a database of this file is one of the run's clones. */
function runId(): string {
  const template = (inject as (key: string) => unknown)(TEMPLATE_DATABASE_KEY);
  if (typeof template !== "string") {
    throw new Error(
      "no template database: vitest.int.config.ts must use @velexis/testing/vitest-global-setup",
    );
  }
  return runIdOfTemplate(template);
}

/** A new empty database prepared like deploy/postgres/bootstrap.sql (as migrate-0003.int.test.ts prepares one). */
async function createEmptyDatabase(): Promise<string> {
  const name = `${TEST_DATABASE_PREFIX}${runId()}_${randomBytes(6).toString("hex")}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unexpected database name ${name}`);
  }
  const admin = pool(adminUrl);
  try {
    await admin.query(
      `CREATE DATABASE "${name}" OWNER velexis_migrator ENCODING 'UTF8' ` +
        "LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0",
    );
    for (const statement of databaseGrantStatements(name)) {
      await admin.query(statement);
    }
  } finally {
    await admin.end();
  }
  const migrator = pool(databaseUrl(adminUrl, name, TEST_ROLES.migrator));
  try {
    await migrator.query(await readFile(SCHEMAS_SQL, "utf8"));
  } finally {
    await migrator.end();
  }
  return name;
}

/** The column price_warnings of plans, as the catalog describes it; `undefined` before 0004. */
async function priceWarningsColumn(db: Pool): Promise<Row | undefined> {
  const { rows } = await db.query(
    "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns " +
      "WHERE table_schema = 'platform' AND table_name = 'plans' AND column_name = 'price_warnings'",
  );
  return rows[0] as Row | undefined;
}

/** The stored warnings of the plan `code`. */
async function warningsOf(db: Pool, code: string): Promise<unknown> {
  const { rows } = await db.query("SELECT price_warnings FROM platform.plans WHERE code = $1", [code]);
  return (rows[0] as Row | undefined)?.["price_warnings"];
}

describe("migration 0004 from scratch", () => {
  let clone: TestDatabase;
  let migrator: Pool;
  let platformApp: Pool;
  let ota: Pool;

  beforeAll(async () => {
    clone = await createTestDatabase();
    migrator = pool(clone.urlFor("migrator"));
    platformApp = pool(clone.urlFor("platform"));
    ota = pool(clone.urlFor("ota"));
  });

  afterAll(async () => {
    await Promise.all([migrator?.end(), platformApp?.end(), ota?.end()]);
    await clone?.drop();
  });

  it("[FIX-W42-PLATFORM AC1] is in the ledger as an expand migration and adds plans.price_warnings, a JSON array that is never null", async () => {
    const { rows } = await migrator.query(
      "SELECT id, phase, status, checksum FROM platform.schema_migrations WHERE id = $1",
      [MIGRATION_ID],
    );
    expect(rows).toEqual([
      {
        id: MIGRATION_ID,
        phase: "expand",
        status: "applied",
        checksum: await sha256(join(PLATFORM_MIGRATIONS, `${MIGRATION_ID}.sql`)),
      },
    ]);
    expect(await priceWarningsColumn(migrator)).toEqual({
      column_name: "price_warnings",
      data_type: "jsonb",
      is_nullable: "NO",
      column_default: "'[]'::jsonb",
    });
    // The seeded plan (migration 0002) was never compared.
    expect(await warningsOf(migrator, "early_access")).toEqual([]);
  });

  it("[FIX-W42-PLATFORM AC1] lets velexis_platform_app keep an array of warnings only, and velexis_ota_app read it with the plan", async () => {
    const plan = await insertPlan(platformApp, { code: `plan_${FIRST_PLAN}` });
    expect(plan["price_warnings"]).toEqual([]);
    const write = (json: string | null) =>
      platformApp.query("UPDATE platform.plans SET price_warnings = $2::jsonb WHERE code = $1", [
        plan.code,
        json,
      ]);

    for (const notAnArray of ['{"field": "stripePriceIdMonth.amount"}', '"warnings"', "1", "null"]) {
      await expect(write(notAnArray)).rejects.toMatchObject({
        code: "23514",
        constraint: "plans_price_warnings_ck",
      });
    }
    await expect(write(null)).rejects.toMatchObject({ code: "23502" });
    await write(JSON.stringify([WARNING]));
    expect(await warningsOf(platformApp, plan.code)).toEqual([WARNING]);

    // ADR-0004: the OTA backend reads plans in full; the warnings hold no secret.
    expect(await warningsOf(ota, plan.code)).toEqual([WARNING]);
    await expect(
      ota.query("UPDATE platform.plans SET price_warnings = '[]'::jsonb WHERE code = $1", [plan.code]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("migration 0004 as an upgrade from 0003", () => {
  let name: string | undefined;
  let previousDir: string | undefined;
  let previousRun: RunMigrationsResult;
  let upgradeRun: RunMigrationsResult;
  let migrator: Pool;
  let platformApp: Pool;
  let planBefore: Row;
  let columnBefore: Row | undefined;

  beforeAll(async () => {
    name = await createEmptyDatabase();
    const migratorUrl = databaseUrl(adminUrl, name, TEST_ROLES.migrator);
    migrator = pool(migratorUrl);
    platformApp = pool(databaseUrl(adminUrl, name, TEST_ROLES.platform));

    previousDir = await mkdtemp(join(tmpdir(), "velexis-fix-w42-0003-"));
    for (const file of PREVIOUS_FILES) {
      await copyFile(join(PLATFORM_MIGRATIONS, file), join(previousDir, file));
    }
    previousRun = await runMigrations({ set: "platform", dir: previousDir, url: migratorUrl });
    planBefore = await insertPlan(platformApp, {
      code: `plan_${FIRST_PLAN + 1}`,
      stripe_price_id_month: `price_TestFixW42Upgrade${FIRST_PLAN + 1}`,
    });
    columnBefore = await priceWarningsColumn(migrator);

    upgradeRun = await runMigrations({ set: "platform", dir: PLATFORM_MIGRATIONS, url: migratorUrl });
  });

  afterAll(async () => {
    await Promise.all([migrator?.end(), platformApp?.end()]);
    if (previousDir !== undefined) {
      await rm(previousDir, { recursive: true, force: true });
    }
    if (name !== undefined) {
      await dropDatabase(adminUrl, name);
    }
  });

  it("[FIX-W42-PLATFORM AC1] applies only 0004 on top of 0003, in a transaction, and keeps the plan written before with no warning and its version", async () => {
    expect(previousRun.applied.map((event) => event.id)).toEqual([
      "0001_baseline",
      "0002_add_mvp_platform_deltas",
      "0003_add_billing_customer_attempts",
      "R__ota_read_access",
    ]);
    expect(columnBefore).toBeUndefined();
    expect(
      upgradeRun.applied.map(({ id, phase, status, transaction }) => ({ id, phase, status, transaction })),
    ).toEqual([{ id: MIGRATION_ID, phase: "expand", status: "applied", transaction: true }]);
    expect(await priceWarningsColumn(migrator)).toMatchObject({ data_type: "jsonb", is_nullable: "NO" });

    // The existing rows get the default, and nothing else changes: no backfill, the same `updated_at` (version).
    const { rows } = await platformApp.query("SELECT * FROM platform.plans WHERE code = $1", [
      planBefore["code"],
    ]);
    expect(rows).toEqual([{ ...planBefore, price_warnings: [] }]);
    expect(await warningsOf(platformApp, "early_access")).toEqual([]);
  });
});
