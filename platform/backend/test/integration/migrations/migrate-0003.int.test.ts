// Migration 0003 on PostgreSQL 16 (FIX-W29-PLATFORM; PADR-0002 item 3 revision of 2026-10-24, conventions §9): the
// table `billing_customer_attempts` that holds the attempt of a tenant's Stripe Customer creation after a failure that
// spent its idempotency key. It must apply from scratch and as an upgrade of a database at the previous version:
//   - from scratch: the template database of @velexis/testing (the real runner and the real folders), cloned here;
//   - as an upgrade: a new empty database prepared like deploy/postgres/bootstrap.sql, the runner applied to a
//     temporary folder holding the files before 0003 (0001, 0002 and the repeatable grants), one tenant written by
//     velexis_platform_app, then the runner applied to the real folder: only 0003 is applied, the tenant survives.
// The table's rules are checked as the roles that use it: velexis_platform_app writes it (the CHECK and the foreign
// key refuse what the code must never write), and velexis_ota_app may not read it ("permission denied", SQLSTATE
// 42501). checkout.int.test.ts uses it through createTenant and createCheckoutSession.
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
import { insertTenant, testId } from "../../builders/platform-rows";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");
const PLATFORM_MIGRATIONS = join(REPO, "platform", "backend", "migrations", "platform");
const SCHEMAS_SQL = join(REPO, "deploy", "postgres", "schemas.sql");
const MIGRATION_ID = "0003_add_billing_customer_attempts";
/** The files of the version before 0003. */
const PREVIOUS_FILES = ["0001_baseline.sql", "0002_add_mvp_platform_deltas.sql", "R__ota_read_access.sql"];

type Pool = ReturnType<typeof createPool>;
type Row = Record<string, unknown>;

const adminUrl = testDatabaseAdminUrl();
const denied = (table: string) => ({ code: "42501", message: `permission denied for table ${table}` });

function pool(url: string): Pool {
  return createPool(url, {
    applicationName: "platform-int-migrate-0003",
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

/** A new empty database prepared like deploy/postgres/bootstrap.sql (as migrate-0002.int.test.ts prepares one). */
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

/** The columns of billing_customer_attempts, in table order. */
async function columnsOf(db: Pool): Promise<Row[]> {
  return (
    await db.query(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns " +
        "WHERE table_schema = 'platform' AND table_name = 'billing_customer_attempts' ORDER BY ordinal_position",
    )
  ).rows;
}

describe("migration 0003 from scratch", () => {
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

  it("[FIX-W29-PLATFORM AC2] is in the ledger as an expand migration and creates billing_customer_attempts", async () => {
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
    expect(await columnsOf(migrator)).toEqual([
      { column_name: "tenant_id", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "attempt", data_type: "integer", is_nullable: "NO", column_default: null },
      {
        column_name: "updated_at",
        data_type: "timestamp with time zone",
        is_nullable: "NO",
        column_default: "now()",
      },
    ]);
  });

  it("[FIX-W29-PLATFORM AC2] lets velexis_platform_app keep one attempt from 1 per existing tenant, and hides it from velexis_ota_app", async () => {
    const tenant = await insertTenant(platformApp);
    const insert = (tenantId: string, attempt: number) =>
      platformApp.query(
        "INSERT INTO platform.billing_customer_attempts (tenant_id, attempt) VALUES ($1, $2)",
        [tenantId, attempt],
      );

    await expect(insert(tenant.id, 0)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(testId("ten", 9_003), 1)).rejects.toMatchObject({ code: "23503" });
    await insert(tenant.id, 1);
    await expect(insert(tenant.id, 2)).rejects.toMatchObject({ code: "23505" });
    await platformApp.query(
      "UPDATE platform.billing_customer_attempts SET attempt = 2 WHERE tenant_id = $1",
      [tenant.id],
    );
    expect(
      (
        await platformApp.query(
          "SELECT attempt FROM platform.billing_customer_attempts WHERE tenant_id = $1",
          [tenant.id],
        )
      ).rows,
    ).toEqual([{ attempt: 2 }]);

    await expect(ota.query("SELECT * FROM platform.billing_customer_attempts")).rejects.toMatchObject(
      denied("billing_customer_attempts"),
    );
    await platformApp.query("DELETE FROM platform.billing_customer_attempts WHERE tenant_id = $1", [
      tenant.id,
    ]);
  });
});

describe("migration 0003 as an upgrade from 0002", () => {
  let name: string | undefined;
  let previousDir: string | undefined;
  let previousRun: RunMigrationsResult;
  let upgradeRun: RunMigrationsResult;
  let migrator: Pool;
  let platformApp: Pool;
  let tenantBefore: Row;

  beforeAll(async () => {
    name = await createEmptyDatabase();
    const migratorUrl = databaseUrl(adminUrl, name, TEST_ROLES.migrator);
    migrator = pool(migratorUrl);
    platformApp = pool(databaseUrl(adminUrl, name, TEST_ROLES.platform));

    previousDir = await mkdtemp(join(tmpdir(), "velexis-fix-w29-0002-"));
    for (const file of PREVIOUS_FILES) {
      await copyFile(join(PLATFORM_MIGRATIONS, file), join(previousDir, file));
    }
    previousRun = await runMigrations({ set: "platform", dir: previousDir, url: migratorUrl });
    tenantBefore = await insertTenant(platformApp);

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

  it("[FIX-W29-PLATFORM AC2] applies only 0003 on top of 0002, in a transaction, and keeps the tenant written before", async () => {
    expect(previousRun.applied.map((event) => event.id)).toEqual([
      "0001_baseline",
      "0002_add_mvp_platform_deltas",
      "R__ota_read_access",
    ]);
    expect(
      upgradeRun.applied.map(({ id, phase, status, transaction }) => ({ id, phase, status, transaction })),
    ).toEqual([{ id: MIGRATION_ID, phase: "expand", status: "applied", transaction: true }]);
    expect(await columnsOf(migrator)).toHaveLength(3);
    expect(
      (await platformApp.query("SELECT * FROM platform.tenants WHERE id = $1", [tenantBefore["id"]])).rows,
    ).toEqual([tenantBefore]);
    expect(
      (await platformApp.query("SELECT count(*)::int AS n FROM platform.billing_customer_attempts")).rows,
    ).toEqual([{ n: 0 }]);
  });
});
