// Migration 0005 on PostgreSQL 16 (PBE-078; ADR-0030 items 2, 3 and 11, PADR-0020 items 7 to 9, conventions §9,
// platform/docs/data-model.md §4.11): the supplier registry, and the supply sources of the connections and of the
// Velexis Amadeus accounts. It must apply to an empty and to a populated database:
//   - empty: the template database of @velexis/testing (the real runner and the real folders on an empty database),
//     cloned here: the registry's seeded rows, its constraints as velexis_platform_app writes the tables, and the
//     connection repository, which names the supplier on every insert and points a `velexis` row at its account's
//     source;
//   - populated: a new empty database prepared like deploy/postgres/bootstrap.sql, the runner applied to a temporary
//     folder holding the files before 0005 (0001 to 0004 and the repeatable grants), then the rows as today's seeds
//     and tests write them, as velexis_platform_app: the platform dev:seed's Velexis test Amadeus account and offices,
//     a live account as the end-to-end harness adds it, the OTA dev:seed's `velexis` test connection of the demo OTA
//     with its office, a `velexis` live connection waiting for an office, an OTA's own (`tenant`) connection as
//     `applyOwnLiveCredentials` writes it, and a connection that names no provider, as most OTA integration tests
//     insert them; then the runner applied to the real folder: only 0005 is applied, in one transaction, every
//     connection then has a source (a `velexis` one its account's, a `tenant` one its own) and is switched on, every
//     source has one `sup_` id of its own, and the rows keep their other columns, `version` and `updated_at`.
// packages/db's baselines.int.test.ts proves the grants and denials of velexis_ota_app on the four tables.
// Databases are created as TEST_DATABASE_ADMIN_URL with the development role passwords of .env.example (TEST_ROLES),
// named velexis_test_<runId>_<random> so the global teardown removes any left behind.
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPlatformDb,
  createPool,
  type Kysely,
  type PlatformDatabase,
  type ReferenceDatabase,
} from "@velexis/db";
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
import { SupplierConnectionsRepository } from "../../../src/supplier-connections/supplier-connections.repository";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertRow,
  insertSupplierConnection,
  insertTenant,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  testId,
  velexisSource,
  type PlatformInsert,
  type PlatformRow,
} from "../../builders/platform-rows";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");
const PLATFORM_MIGRATIONS = join(REPO, "platform", "backend", "migrations", "platform");
const SCHEMAS_SQL = join(REPO, "deploy", "postgres", "schemas.sql");
const MIGRATION_ID = "0005_add_supplier_registry";
/** The files of the version before 0005. */
const PREVIOUS_FILES = [
  "0001_baseline.sql",
  "0002_add_mvp_platform_deltas.sql",
  "0003_add_billing_customer_attempts.sql",
  "0004_add_plan_price_warnings.sql",
  "R__ota_read_access.sql",
];
const SOURCE_ID = /^ssr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUPPLY_ID = /^sup_[0-9A-HJKMNP-TV-Z]{16}$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The columns 0005 adds to supplier_connections and amadeus_accounts. */
const NEW_CONNECTION_COLUMNS = ["sales_enabled", "supply_source_id"];

type Pool = ReturnType<typeof createPool>;
type Row = Record<string, unknown>;
type PlatformDb = Kysely<PlatformDatabase & ReferenceDatabase>;

const adminUrl = testDatabaseAdminUrl();

function pool(url: string): Pool {
  return createPool(url, {
    applicationName: "platform-int-migrate-0005",
    logger: { error: () => undefined },
    max: 2,
  });
}

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** The millisecond timestamp in the first 10 characters of a ULID (after the `<prefix>_`). */
function ulidTime(id: string): number {
  const ulid = id.slice(id.indexOf("_") + 1);
  return [...ulid.slice(0, 10)].reduce((time, char) => time * 32 + CROCKFORD.indexOf(char), 0);
}

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

/** A new empty database prepared like deploy/postgres/bootstrap.sql (as migrate-0004.int.test.ts prepares one). */
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

const rowsOf = async (db: Pool, text: string, values: unknown[] = []): Promise<Row[]> =>
  (await db.query(text, values)).rows as Row[];

/** The rejection of a constraint violation: SQLSTATE `code` and the constraint's name. */
const violates = (code: "23503" | "23505" | "23514", constraint: string) => ({ code, constraint });

/** Runs `fn` in a transaction of `db` that is always rolled back, so a check leaves no row behind. */
async function rolledBack(db: Pool, fn: (client: Pool) => Promise<void>): Promise<void> {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await fn(client as unknown as Pool);
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    client.release(broken);
  }
}

/** A supply source written by velexis_platform_app, with its current supply id. */
async function insertSource(
  db: Pool,
  n: number,
  source: { supplier_id: string; environment: string; credential_source: string; tenant_id?: string | null },
): Promise<{ id: string; supplyId: string }> {
  const row = await insertRow(db, "supply_sources", { id: testId("ssr", n), ...source });
  const supplyId = `sup_${String(n).padStart(16, "0")}`;
  await insertRow(db, "supply_source_ids", { supply_id: supplyId, supply_source_id: row.id });
  return { id: row.id, supplyId };
}

const OWN_CREDENTIALS = {
  baseUrl: "https://test.travel.api.amadeus.com",
  clientId: "ota-own-client",
  clientSecretCiphertext: new Uint8Array(Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8")),
  encryptionKeyId: PLACEHOLDER_KEK_ID,
  officeIds: ["NCE1B0901"],
  defaultOfficeId: "NCE1B0901",
  queuingOfficeId: "NCE1B0901",
  ownerOfficeId: "NCE1B0901",
};

describe("migration 0005 on an empty database", () => {
  let clone: TestDatabase;
  let migrator: Pool;
  let platformApp: Pool;
  let platformDb: PlatformDb;
  /** The Velexis Amadeus accounts of this database, one per environment, written without a source. */
  let accounts: { test: PlatformRow<"amadeus_accounts">; live: PlatformRow<"amadeus_accounts"> };

  beforeAll(async () => {
    clone = await createTestDatabase();
    migrator = pool(clone.urlFor("migrator"));
    platformApp = pool(clone.urlFor("platform"));
    platformDb = createPlatformDb<PlatformDatabase & ReferenceDatabase>(pool(clone.urlFor("platform")));
    accounts = {
      test: await insertAmadeusAccount(platformApp),
      live: await insertAmadeusAccount(platformApp, {
        environment: "live",
        base_url: "https://travel.api.amadeus.com",
      }),
    };
  });

  afterAll(async () => {
    await Promise.all([migrator?.end(), platformApp?.end(), platformDb?.destroy()]);
    await clone?.drop();
  });

  it("[PBE-078 AC1] is in the ledger as an expand migration and seeds the suppliers and their global switches, with no source on an empty database", async () => {
    expect(
      await rowsOf(
        migrator,
        "SELECT id, phase, status, checksum FROM platform.schema_migrations WHERE id = $1",
        [MIGRATION_ID],
      ),
    ).toEqual([
      {
        id: MIGRATION_ID,
        phase: "expand",
        status: "applied",
        checksum: await sha256(join(PLATFORM_MIGRATIONS, `${MIGRATION_ID}.sql`)),
      },
    ]);
    expect(await rowsOf(migrator, "SELECT id, name FROM platform.suppliers ORDER BY id")).toEqual([
      { id: "amadeus", name: "Amadeus" },
      { id: "pkfare", name: "PKFare" },
    ]);
    // Amadeus sells today; PKFare is off in both environments until staff switch it on (ADR-0030 item 28 for live).
    expect(
      await rowsOf(
        migrator,
        "SELECT supplier_id, environment, sales_enabled, version FROM platform.supplier_environments " +
          "ORDER BY supplier_id, environment",
      ),
    ).toEqual([
      { supplier_id: "amadeus", environment: "live", sales_enabled: true, version: 1 },
      { supplier_id: "amadeus", environment: "test", sales_enabled: true, version: 1 },
      { supplier_id: "pkfare", environment: "live", sales_enabled: false, version: 1 },
      { supplier_id: "pkfare", environment: "test", sales_enabled: false, version: 1 },
    ]);
    expect(
      await rowsOf(
        migrator,
        "SELECT (SELECT count(*)::int FROM platform.supply_sources) AS sources, " +
          "(SELECT count(*)::int FROM platform.supply_source_ids) AS ids",
      ),
    ).toEqual([{ sources: 0, ids: 0 }]);
  });

  it("[PBE-078 AC2] refuses an unknown supplier, stores a connection that names none as Amadeus and switched on, and needs the other credential source for a second row", async () => {
    const tenant = await insertTenant(platformApp);
    await expect(insertSupplierConnection(platformApp, tenant, { provider: "duffel" })).rejects.toMatchObject(
      violates("23503", "supplier_connections_provider_fk"),
    );

    // Most OTA integration tests insert a connection without `provider` (X-075 moves them to the builders).
    const unnamed = await insertSupplierConnection(platformApp, tenant, { provider: undefined });
    expect(unnamed).toMatchObject({ provider: "amadeus", sales_enabled: true, supply_source_id: null });

    // One row per tenant, supplier, environment and credential source.
    await expect(insertSupplierConnection(platformApp, tenant)).rejects.toMatchObject(
      violates("23505", "supplier_connections_env_source_uq"),
    );
    const account = accounts.test;
    const velexis = await insertSupplierConnection(platformApp, tenant, velexisSource(account));
    expect(velexis).toMatchObject({
      tenant_id: tenant.id,
      provider: "amadeus",
      credential_source: "velexis",
    });
    await expect(insertSupplierConnection(platformApp, tenant, velexisSource(account))).rejects.toMatchObject(
      violates("23505", "supplier_connections_env_source_uq"),
    );
  });

  it("[PBE-078 AC2] rewrites the source CHECK for other suppliers: a Velexis row of PKFare names no Amadeus account and needs its source", async () => {
    const tenant = await insertTenant(platformApp);
    const account = accounts.live;
    const pkfare = await insertSource(platformApp, 10, {
      supplier_id: "pkfare",
      environment: "test",
      credential_source: "velexis",
    });
    const pkfareVelexis = { ...velexisSource(account), environment: "test" as const, provider: "pkfare" };

    await rolledBack(platformApp, async (tx) => {
      // Without a source: refused.
      await expect(
        insertSupplierConnection(tx, tenant, { ...pkfareVelexis, amadeus_account_id: null }),
      ).rejects.toMatchObject(violates("23514", "supplier_connections_source_ck"));
    });
    await rolledBack(platformApp, async (tx) => {
      // With an Amadeus account: refused.
      await expect(
        insertSupplierConnection(tx, tenant, { ...pkfareVelexis, supply_source_id: pkfare.id }),
      ).rejects.toMatchObject(violates("23514", "supplier_connections_source_ck"));
    });
    const row = await insertSupplierConnection(platformApp, tenant, {
      ...pkfareVelexis,
      amadeus_account_id: null,
      supply_source_id: pkfare.id,
    });
    expect(row).toMatchObject({
      provider: "pkfare",
      credential_source: "velexis",
      supply_source_id: pkfare.id,
    });

    // An Amadeus row of either source keeps the rules of 0002.
    await expect(
      insertSupplierConnection(platformApp, tenant, { ...velexisSource(account), amadeus_account_id: null }),
    ).rejects.toMatchObject(violates("23514", "supplier_connections_source_ck"));
    await expect(
      insertSupplierConnection(platformApp, tenant, { amadeus_account_id: account.id, environment: "live" }),
    ).rejects.toMatchObject(violates("23514", "supplier_connections_source_ck"));
  });

  it("[PBE-078 AC2] keeps a connection on a source of its own supplier, environment and credential source, and an account on a source of its environment", async () => {
    const tenant = await insertTenant(platformApp);
    const other = await insertTenant(platformApp);
    const testVelexis = await insertSource(platformApp, 20, {
      supplier_id: "amadeus",
      environment: "test",
      credential_source: "velexis",
    });
    const liveVelexis = await insertSource(platformApp, 21, {
      supplier_id: "amadeus",
      environment: "live",
      credential_source: "velexis",
    });
    const ownSource = await insertSource(platformApp, 22, {
      supplier_id: "amadeus",
      environment: "test",
      credential_source: "tenant",
      tenant_id: tenant.id,
    });

    await rolledBack(platformApp, async (tx) => {
      // A `tenant` row on a Velexis source, and the other way round: refused by the composite foreign key.
      await expect(
        insertSupplierConnection(tx, tenant, { supply_source_id: testVelexis.id }),
      ).rejects.toMatchObject(violates("23503", "supplier_connections_supply_source_fk"));
    });
    await rolledBack(platformApp, async (tx) => {
      // A test connection on a live source: refused.
      await expect(
        insertSupplierConnection(tx, tenant, {
          supply_source_id: liveVelexis.id,
          credential_source: "tenant",
        }),
      ).rejects.toMatchObject(violates("23503", "supplier_connections_supply_source_fk"));
    });
    const setAccountSource = (tx: Pool, account: PlatformRow<"amadeus_accounts">, sourceId: string) =>
      tx.query(
        "UPDATE platform.amadeus_accounts SET supply_source_id = $2 WHERE id = $1 RETURNING supply_source_id",
        [account.id, sourceId],
      );
    await rolledBack(platformApp, async (tx) => {
      // The account of the test environment on a live source: refused.
      await expect(setAccountSource(tx, accounts.test, liveVelexis.id)).rejects.toMatchObject(
        violates("23503", "amadeus_accounts_supply_source_fk"),
      );
    });
    await rolledBack(platformApp, async (tx) => {
      await expect(setAccountSource(tx, accounts.test, testVelexis.id)).resolves.toMatchObject({
        rows: [{ supply_source_id: testVelexis.id }],
      });
    });
    const own = await insertSupplierConnection(platformApp, tenant, { supply_source_id: ownSource.id });
    expect(own).toMatchObject({ credential_source: "tenant", supply_source_id: ownSource.id });
    const shared = await insertSupplierConnection(platformApp, other, {
      ...velexisSource(accounts.test),
      supply_source_id: testVelexis.id,
    });
    expect(shared.supply_source_id).toBe(testVelexis.id);

    // A deleted OTA takes its own sources and their ids with it; a Velexis source stays.
    await rolledBack(platformApp, async (tx) => {
      await tx.query("DELETE FROM platform.supplier_connections WHERE tenant_id = $1", [tenant.id]);
      await tx.query("DELETE FROM platform.tenants WHERE id = $1", [tenant.id]);
      expect(
        await rowsOf(tx, "SELECT id FROM platform.supply_sources WHERE id = ANY($1::text[]) ORDER BY id", [
          [ownSource.id, testVelexis.id],
        ]),
      ).toEqual([{ id: testVelexis.id }]);
      expect(
        await rowsOf(tx, "SELECT supply_id FROM platform.supply_source_ids WHERE supply_id = $1", [
          ownSource.supplyId,
        ]),
      ).toEqual([]);
    });
  });

  it("[PBE-078 AC1] holds a source's owner and its stop: who set it, when and why", async () => {
    const tenant = await insertTenant(platformApp);
    const staff = await insertAccount(platformApp);
    const source = (n: number, extra: Row) =>
      insertRow(platformApp, "supply_sources", {
        id: testId("ssr", n),
        supplier_id: "pkfare",
        environment: "test",
        credential_source: "velexis",
        ...extra,
      } as PlatformInsert<"supply_sources">);

    await expect(source(30, { id: "src_01JATESTRW0000000000000030" })).rejects.toMatchObject(
      violates("23514", "supply_sources_id_check"),
    );
    await expect(source(31, { supplier_id: "duffel" })).rejects.toMatchObject(
      violates("23503", "supply_sources_supplier_id_fkey"),
    );
    // A Velexis source has no tenant; an own source has one.
    await expect(source(32, { tenant_id: tenant.id })).rejects.toMatchObject(
      violates("23514", "supply_sources_owner_ck"),
    );
    await expect(source(33, { credential_source: "tenant" })).rejects.toMatchObject(
      violates("23514", "supply_sources_owner_ck"),
    );
    // Who may set a stop: staff, the wallet watch or a balance refusal; each with when and why.
    const at = new Date("2026-11-27T09:00:00.000Z");
    await expect(
      source(34, { sales_stop: "cap", sales_stop_at: at, sales_stop_reason: "cap reached" }),
    ).rejects.toMatchObject(violates("23514", "supply_sources_sales_stop_ck"));
    await expect(source(35, { sales_stop: "staff", sales_stop_at: at })).rejects.toMatchObject(
      violates("23514", "supply_sources_sales_stop_shape_ck"),
    );
    await expect(
      source(36, { sales_stop: "wallet_watch", sales_stop_reason: "under the floor" }),
    ).rejects.toMatchObject(violates("23514", "supply_sources_sales_stop_shape_ck"));
    await expect(
      source(37, {
        sales_stop: "wallet_watch",
        sales_stop_at: at,
        sales_stop_reason: "under the floor",
        sales_stop_by_account_id: staff.id,
      }),
    ).rejects.toMatchObject(violates("23514", "supply_sources_sales_stop_shape_ck"));
    await expect(source(38, { sales_stop_reason: "no stop" })).rejects.toMatchObject(
      violates("23514", "supply_sources_sales_stop_shape_ck"),
    );
    await expect(
      source(39, { sales_stop: "staff", sales_stop_at: at, sales_stop_reason: "x".repeat(501) }),
    ).rejects.toMatchObject(violates("23514", "supply_sources_sales_stop_shape_ck"));

    for (const [n, stop] of [
      [
        40,
        {
          sales_stop: "staff",
          sales_stop_at: at,
          sales_stop_reason: "Pilot paused",
          sales_stop_by_account_id: staff.id,
        },
      ],
      [41, { sales_stop: "wallet_watch", sales_stop_at: at, sales_stop_reason: "Balance under the floor" }],
      [42, { sales_stop: "balance_refusal", sales_stop_at: at, sales_stop_reason: "Balance not enough" }],
      [43, {}],
    ] as const) {
      await expect(source(n, stop)).resolves.toMatchObject({ id: testId("ssr", n), version: 1 });
    }
    const own = await source(44, {
      credential_source: "tenant",
      tenant_id: tenant.id,
      supplier_id: "amadeus",
    });
    expect(own).toMatchObject({ credential_source: "tenant", tenant_id: tenant.id, sales_stop: null });
  });

  it("[PBE-078 AC1] keeps every supply id of a source, unique for ever, with one current id per source", async () => {
    const source = await insertRow(platformApp, "supply_sources", {
      id: testId("ssr", 50),
      supplier_id: "amadeus",
      environment: "test",
      credential_source: "velexis",
    });
    const supplyId = (id: string, extra: Row = {}) =>
      insertRow(platformApp, "supply_source_ids", {
        supply_id: id,
        supply_source_id: source.id,
        ...extra,
      } as PlatformInsert<"supply_source_ids">);

    // sup_ and 16 Crockford base32 characters: no lower case, no I, L, O or U, no other length, no ULID.
    for (const bad of [
      "sup_0000000000000I50",
      "sup_000000000000000u",
      "sup_00000000000050",
      "sup_000000000000000050",
      testId("sup", 50),
      "ssr_0000000000000050",
    ]) {
      await expect(supplyId(bad)).rejects.toMatchObject(violates("23514", "supply_source_ids_supply_id_ck"));
    }
    const first = await supplyId("sup_7KQ2M9XW3HT6PBNC");
    expect(first).toMatchObject({
      supply_source_id: source.id,
      retired_at: null,
      issued_at: expect.any(Date),
    });
    // A second current id is refused; once the first is retired, the next one is current.
    await expect(supplyId("sup_8KQ2M9XW3HT6PBNC")).rejects.toMatchObject(
      violates("23505", "supply_source_ids_current_uq"),
    );
    await platformApp.query("UPDATE platform.supply_source_ids SET retired_at = now() WHERE supply_id = $1", [
      first.supply_id,
    ]);
    await supplyId("sup_8KQ2M9XW3HT6PBNC");
    // An id is never issued twice, not even to another source.
    const other = await insertRow(platformApp, "supply_sources", {
      id: testId("ssr", 51),
      supplier_id: "amadeus",
      environment: "live",
      credential_source: "velexis",
    });
    await expect(
      insertRow(platformApp, "supply_source_ids", { supply_id: first.supply_id, supply_source_id: other.id }),
    ).rejects.toMatchObject(violates("23505", "supply_source_ids_pkey"));
    await expect(
      supplyId("sup_9KQ2M9XW3HT6PBNC", {
        issued_at: new Date("2026-11-27T10:00:00.000Z"),
        retired_at: new Date("2026-11-27T09:00:00.000Z"),
      }),
    ).rejects.toMatchObject(violates("23514", "supply_source_ids_dates_ck"));
    expect(
      await rowsOf(
        platformApp,
        "SELECT supply_id, retired_at IS NULL AS current FROM platform.supply_source_ids " +
          "WHERE supply_source_id = $1 ORDER BY issued_at, supply_id",
        [source.id],
      ),
    ).toEqual([
      { supply_id: "sup_7KQ2M9XW3HT6PBNC", current: false },
      { supply_id: "sup_8KQ2M9XW3HT6PBNC", current: true },
    ]);
  });

  it("[PBE-078 AC4] lets the connection repository name the supplier on every insert and point a velexis row at its account's source", async () => {
    const repository = new SupplierConnectionsRepository(platformDb);
    const now = new Date("2026-11-27T12:00:00.000Z");
    const accountSource = await insertSource(platformApp, 60, {
      supplier_id: "amadeus",
      environment: "live",
      credential_source: "velexis",
    });
    const live = accounts.live;
    await platformApp.query("UPDATE platform.amadeus_accounts SET supply_source_id = $2 WHERE id = $1", [
      live.id,
      accountSource.id,
    ]);
    // The test account has no source yet (an account written before its writer sets one, X-075, PBE-080).
    const test = accounts.test;
    const [served, waiting, unsourced, own] = await Promise.all(
      [1, 2, 3, 4].map(() => insertTenant(platformApp)),
    );
    if (served === undefined || waiting === undefined || unsourced === undefined || own === undefined) {
      throw new Error("four tenants were not written");
    }

    const inserted = await platformDb.transaction().execute(async (trx) => ({
      served: await repository.insertVelexis(trx, {
        id: testId("sc", 61),
        tenantId: served.id,
        environment: "live",
        amadeusAccountId: live.id,
        officeId: "NCE1A0961",
        createdByAccountId: null,
        now,
      }),
      waiting: await repository.insertPendingVelexis(trx, {
        id: testId("sc", 62),
        tenantId: waiting.id,
        environment: "live",
        amadeusAccountId: live.id,
        createdByAccountId: null,
        now,
      }),
      unsourced: await repository.insertVelexis(trx, {
        id: testId("sc", 63),
        tenantId: unsourced.id,
        environment: "test",
        amadeusAccountId: test.id,
        officeId: "NCE1A0963",
        createdByAccountId: null,
        now,
      }),
      own: await repository.insertTenant(trx, {
        id: testId("sc", 64),
        tenantId: own.id,
        environment: "test",
        credentials: OWN_CREDENTIALS,
        createdByAccountId: null,
        now,
      }),
    }));
    // The stored rows: the API's view of a connection carries no supply columns yet, so they are read back here.
    const stored = async (id: string): Promise<Row | undefined> =>
      (
        await rowsOf(
          platformApp,
          "SELECT provider, credential_source, client_id, sales_enabled, supply_source_id, status, version " +
            "FROM platform.supplier_connections WHERE id = $1",
          [id],
        )
      )[0];
    expect(await stored(inserted.served.id)).toMatchObject({
      provider: "amadeus",
      credential_source: "velexis",
      sales_enabled: true,
      supply_source_id: accountSource.id,
      status: "active",
    });
    expect(inserted.served.supply_source_id).toBe(accountSource.id);
    expect(await stored(inserted.waiting.id)).toMatchObject({
      provider: "amadeus",
      sales_enabled: true,
      supply_source_id: accountSource.id,
      status: "pending_verification",
    });
    expect(await stored(inserted.unsourced.id)).toMatchObject({
      provider: "amadeus",
      sales_enabled: true,
      supply_source_id: null,
    });
    expect(await stored(inserted.own.id)).toMatchObject({
      provider: "amadeus",
      credential_source: "tenant",
      sales_enabled: true,
      supply_source_id: null,
    });

    // Completing the waiting row with an office points it at the account's source again.
    await platformApp.query(
      "UPDATE platform.supplier_connections SET supply_source_id = NULL WHERE id = $1",
      [inserted.waiting.id],
    );
    await platformDb
      .transaction()
      .execute((trx) =>
        repository.completeVelexis(
          trx,
          inserted.waiting.id,
          { amadeusAccountId: live.id, officeId: "NCE1A0962" },
          now,
        ),
      );
    expect(await stored(inserted.waiting.id)).toMatchObject({
      status: "active",
      supply_source_id: accountSource.id,
      version: 2,
    });

    // A velexis row switched to the OTA's own credentials leaves the Velexis source; a tenant row keeps its own.
    await platformDb
      .transaction()
      .execute((trx) => repository.switchToTenant(trx, inserted.served.id, OWN_CREDENTIALS, now));
    expect(await stored(inserted.served.id)).toMatchObject({
      credential_source: "tenant",
      supply_source_id: null,
      sales_enabled: true,
    });
    const ownSource = await insertSource(platformApp, 65, {
      supplier_id: "amadeus",
      environment: "test",
      credential_source: "tenant",
      tenant_id: own.id,
    });
    await platformApp.query("UPDATE platform.supplier_connections SET supply_source_id = $2 WHERE id = $1", [
      inserted.own.id,
      ownSource.id,
    ]);
    await platformDb
      .transaction()
      .execute((trx) =>
        repository.switchToTenant(
          trx,
          inserted.own.id,
          { ...OWN_CREDENTIALS, clientId: "ota-new-client" },
          now,
        ),
      );
    expect(await stored(inserted.own.id)).toMatchObject({
      client_id: "ota-new-client",
      supply_source_id: ownSource.id,
    });
  });
});

describe("migration 0005 as an upgrade from 0004 holding the rows of today's seeds", () => {
  let name: string | undefined;
  let previousDir: string | undefined;
  let previousRun: RunMigrationsResult;
  let upgradeRun: RunMigrationsResult;
  let migrator: Pool;
  let platformApp: Pool;
  let startedAt: number;
  let before: {
    accounts: Array<PlatformRow<"amadeus_accounts">>;
    connections: Array<PlatformRow<"supplier_connections">>;
  };

  beforeAll(async () => {
    name = await createEmptyDatabase();
    const migratorUrl = databaseUrl(adminUrl, name, TEST_ROLES.migrator);
    migrator = pool(migratorUrl);
    platformApp = pool(databaseUrl(adminUrl, name, TEST_ROLES.platform));

    previousDir = await mkdtemp(join(tmpdir(), "velexis-pbe078-0004-"));
    for (const file of PREVIOUS_FILES) {
      await copyFile(join(PLATFORM_MIGRATIONS, file), join(previousDir, file));
    }
    previousRun = await runMigrations({ set: "platform", dir: previousDir, url: migratorUrl });

    // The platform dev:seed: the Velexis test account (active) and its office pool; the end-to-end harness's live
    // account.
    const testAccount = await insertAmadeusAccount(platformApp, { name: "Velexis test (dev seed)" });
    const liveAccount = await insertAmadeusAccount(platformApp, {
      environment: "live",
      base_url: "https://travel.api.amadeus.com",
      status: "pending_verification",
    });
    const demo = await insertTenant(platformApp, { key: "demo", status: "active" });
    const office = await insertAmadeusOffice(platformApp, testAccount, {
      office_id: "DEV1A0001",
      status: "assigned",
      assigned_tenant_id: demo.id,
      assigned_at: new Date("2026-11-20T08:00:00.000Z"),
    });
    await insertAmadeusOffice(platformApp, testAccount, { office_id: "DEV1A0002" });
    // The OTA dev:seed: the demo OTA's velexis test connection on its office; a live one waiting for an office.
    await insertSupplierConnection(platformApp, demo, {
      ...velexisSource(testAccount),
      office_ids: [office.office_id],
      default_office_id: office.office_id,
      queuing_office_id: office.office_id,
      owner_office_id: office.office_id,
      status: "active",
    });
    await insertSupplierConnection(platformApp, demo, {
      ...velexisSource(liveAccount),
      status: "pending_verification",
    });
    // An OTA on its own credentials (applyOwnLiveCredentials), and an admin-disabled velexis connection.
    const ownOta = await insertTenant(platformApp, { key: "ownota", status: "active" });
    await insertSupplierConnection(platformApp, ownOta, {
      environment: "live",
      status: "active",
      version: 3,
    });
    const disabledOta = await insertTenant(platformApp, { key: "offota", status: "active" });
    await insertSupplierConnection(platformApp, disabledOta, {
      ...velexisSource(testAccount),
      status: "disabled",
    });
    // A connection that names no provider, as the OTA integration tests insert theirs today.
    const legacy = await insertTenant(platformApp, { key: "legacyota" });
    await insertSupplierConnection(platformApp, legacy, { provider: undefined, status: "active" });

    before = {
      accounts: (await rowsOf(platformApp, "SELECT * FROM platform.amadeus_accounts ORDER BY id")) as Array<
        PlatformRow<"amadeus_accounts">
      >,
      connections: (await rowsOf(
        platformApp,
        "SELECT * FROM platform.supplier_connections ORDER BY id",
      )) as Array<PlatformRow<"supplier_connections">>,
    };
    startedAt = Date.now();
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

  it("[PBE-078 AC1] applies only 0005 on top of 0004, in one transaction with its rows", async () => {
    expect(previousRun.applied.map((event) => event.id)).toEqual([
      "0001_baseline",
      "0002_add_mvp_platform_deltas",
      "0003_add_billing_customer_attempts",
      "0004_add_plan_price_warnings",
      "R__ota_read_access",
    ]);
    expect(before.connections).toHaveLength(5);
    // The unchanged repeatable grants are not applied again.
    expect(
      upgradeRun.applied.map(({ id, phase, status, transaction }) => ({ id, phase, status, transaction })),
    ).toEqual([{ id: MIGRATION_ID, phase: "expand", status: "applied", transaction: true }]);
    // The sources, their ids and the ledger row were written by one transaction.
    const xids = await rowsOf(
      migrator,
      "SELECT DISTINCT xmin::text AS xid FROM platform.supply_sources UNION " +
        "SELECT DISTINCT xmin::text FROM platform.supply_source_ids UNION " +
        "SELECT xmin::text FROM platform.schema_migrations WHERE id = $1",
      [MIGRATION_ID],
    );
    expect(xids).toHaveLength(1);
  });

  it("[PBE-078 AC1] gives every connection a source and switches it on: a velexis one its account's, a tenant one its own", async () => {
    const connections = await rowsOf(
      platformApp,
      "SELECT c.id, c.tenant_id, c.provider, c.environment, c.credential_source, c.amadeus_account_id, " +
        "c.supply_source_id, c.sales_enabled, s.supplier_id, s.environment AS source_environment, " +
        "s.credential_source AS source_credential_source, s.tenant_id AS source_tenant_id, " +
        "a.supply_source_id AS account_source_id " +
        "FROM platform.supplier_connections c JOIN platform.supply_sources s ON s.id = c.supply_source_id " +
        "LEFT JOIN platform.amadeus_accounts a ON a.id = c.amadeus_account_id ORDER BY c.id",
    );
    expect(connections).toHaveLength(before.connections.length);
    for (const connection of connections) {
      expect(connection).toMatchObject({
        sales_enabled: true,
        supply_source_id: expect.stringMatching(SOURCE_ID),
        supplier_id: connection["provider"],
        source_environment: connection["environment"],
        source_credential_source: connection["credential_source"],
      });
      if (connection["credential_source"] === "velexis") {
        expect(connection["supply_source_id"]).toBe(connection["account_source_id"]);
        expect(connection["source_tenant_id"]).toBeNull();
      } else {
        expect(connection["source_tenant_id"]).toBe(connection["tenant_id"]);
      }
    }
    // Three velexis connections share the test account's source (two) and the live account's (one); each of the two
    // tenant connections has its own.
    const byCredentialSource = (kind: string): unknown[] =>
      connections.filter((row) => row["credential_source"] === kind).map((row) => row["supply_source_id"]);
    expect(new Set(byCredentialSource("velexis")).size).toBe(2);
    expect(new Set(byCredentialSource("tenant")).size).toBe(2);
    expect(connections.find((row) => row["provider"] !== "amadeus")).toBeUndefined();
  });

  it("[PBE-078 AC1] gives every Velexis Amadeus account a source of its own environment, and every source one sup_ id of its own", async () => {
    const accounts = await rowsOf(
      platformApp,
      "SELECT a.id, a.environment, s.id AS source_id, s.supplier_id, s.environment AS source_environment, " +
        "s.credential_source, s.tenant_id, s.sales_stop, s.version FROM platform.amadeus_accounts a " +
        "JOIN platform.supply_sources s ON s.id = a.supply_source_id ORDER BY a.id",
    );
    expect(accounts).toHaveLength(2);
    for (const account of accounts) {
      expect(account).toMatchObject({
        supplier_id: "amadeus",
        source_environment: account["environment"],
        credential_source: "velexis",
        tenant_id: null,
        sales_stop: null,
        version: 1,
      });
    }

    // Four sources: two accounts and two own connections; one current id each, all different.
    const sources = await rowsOf(
      platformApp,
      "SELECT s.id, s.created_at, i.supply_id, i.issued_at, i.retired_at FROM platform.supply_sources s " +
        "JOIN platform.supply_source_ids i ON i.supply_source_id = s.id ORDER BY s.id",
    );
    expect(sources).toHaveLength(4);
    expect(new Set(sources.map((row) => row["id"])).size).toBe(4);
    expect(new Set(sources.map((row) => row["supply_id"])).size).toBe(4);
    for (const source of sources) {
      expect(source).toMatchObject({
        id: expect.stringMatching(SOURCE_ID),
        supply_id: expect.stringMatching(SUPPLY_ID),
        retired_at: null,
      });
      // The source's id is a ULID of the migration's time; its supply id has no time part.
      const created = (source["created_at"] as Date).getTime();
      expect(ulidTime(String(source["id"]))).toBe(Math.floor(created));
      expect(created).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(source["issued_at"]).toEqual(source["created_at"]);
    }
  });

  it("[PBE-078 AC1] keeps every other column of the connections and accounts, their version and updated_at", async () => {
    const strip = (row: Row): Row =>
      Object.fromEntries(Object.entries(row).filter(([column]) => !NEW_CONNECTION_COLUMNS.includes(column)));
    const accounts = await rowsOf(platformApp, "SELECT * FROM platform.amadeus_accounts ORDER BY id");
    expect(accounts.map(strip)).toEqual(before.accounts);
    const connections = await rowsOf(platformApp, "SELECT * FROM platform.supplier_connections ORDER BY id");
    expect(connections.map(strip)).toEqual(before.connections);
    expect(connections.map((row) => row["provider"])).toEqual(before.connections.map(() => "amadeus"));
  });

  it("[PBE-078 AC1] applies nothing on a second run", async () => {
    if (name === undefined) {
      throw new Error("beforeAll did not create the database");
    }
    const again = await runMigrations({
      set: "platform",
      dir: PLATFORM_MIGRATIONS,
      url: databaseUrl(adminUrl, name, TEST_ROLES.migrator),
    });
    expect(again.applied).toEqual([]);
    expect(await rowsOf(platformApp, "SELECT count(*)::int AS n FROM platform.supply_sources")).toEqual([
      { n: 4 },
    ]);
  });
});
