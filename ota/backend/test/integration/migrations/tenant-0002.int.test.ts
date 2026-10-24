// Tenant migration 0002 on PostgreSQL 16 (OBE-008; ota/docs/data-model-migration-0002.md §3, conventions §9,
// ota/backend/migrations/README.md). The tests of §3 of the document, and the provisioning criterion of the task:
//   - from scratch: 0001 and 0002 on an empty schema, in the one provisioning transaction, and the schema's columns
//     against the committed Kysely types (`pnpm db:codegen`, packages/db/src/generated/tenant.ts);
//   - upgrade: a schema provisioned at version N-1 (a folder holding only the baseline, as the previous release has
//     it) with baseline rows in payments, checkouts, bookings and storefront_settings; then the deploy fan-out
//     (`migrateTenants` as velexis_migrator, what `pnpm db:migrate:tenants` and velexis-deploy run) applies 0002. The
//     rows survive, still validate and get the new defaults, and the schema ends with the catalogue of a fresh one;
//   - the airline-card CHECK, the RESTRICT foreign keys of the settings to their assets, page uniqueness and
//     `published_at`;
//   - the ledger row of 0002: phase expand, the file's checksum, written by the transaction of its DDL;
//   - a tenant provisioned by the worker's ProvisioningService (OBE-005) after this task: 0002 in its ledger, and
//     velexis_ota_app writes the two new tables through the default privileges of provisioning (the file has no
//     GRANT; test/contract/migration-0002.contract.test.ts checks the file).
// Since FIX-W27-SYNC the release holds tenant migration 0003 (`bookings.sync_claimed_at`, `bookings.sync_changes`)
// after 0002, and since FIX-W28-CANCEL 0004 (`payments.card_fee_lines`): provisioning and the deploy fan-out apply them
// all, so the tests above expect the release's files (0002 to 0004), and one test each checks the columns of 0003 and
// of 0004 themselves.
// The file runs on its own clone of the @velexis/testing template. Tenant rows are written and read as
// velexis_ota_app through tenantTx, the application's path; the catalogue is read as velexis_migrator, a member of
// the schemas' owner (test code may name a schema, application code never). Every test uses schemas of its own.
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Insertable,
  type Kysely,
  type PlatformDatabase,
  type TenantDatabase,
  type TenantDb,
} from "@velexis/db";
import { BASELINE_FILE, migrateTenants, migrateTenantSchema } from "@velexis/db/migrate";
import { createTestDatabase, type TestDatabase } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { APP_DIR } from "../../../src/config";
import {
  createProvisionerDatabase,
  DEFAULT_PROVISIONING_OPTIONS,
  ProvisioningService,
  TENANT_MIGRATIONS_DIR,
  type ProvisionerDatabase,
} from "../../../src/provisioning/provisioning.service";
import { PlatformReadRepository } from "../../../src/tenancy/platform-read.repository";

const MIGRATION_ID = "0002_add_mvp_tenant_deltas";
const MIGRATION_FILE = `${MIGRATION_ID}.sql`;
/** The release's files after 0002 (FIX-W27-SYNC, FIX-W28-CANCEL): a schema at version N has them too. */
const SYNC_CLAIM_ID = "0003_add_booking_sync_claim";
const SYNC_CLAIM_FILE = `${SYNC_CLAIM_ID}.sql`;
const LATEST_ID = "0004_add_payment_card_fee_lines";
const LATEST_FILE = `${LATEST_ID}.sql`;
const GENERATED_TYPES = join(APP_DIR, "..", "..", "packages", "db", "src", "generated", "tenant.ts");
/** The privileges of velexis_ota_app on every tenant table: exactly DML (OADR-0007 item 3). */
const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"];
/** SQLSTATEs: check_violation, unique_violation, foreign_key_violation. */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const NOW = new Date("2026-10-15T09:30:00.000Z");
/** The five asset references of storefront_settings (data-model-migration-0002.md §2, part 6). */
const ASSET_COLUMNS = [
  "logo_asset_id",
  "logo_dark_asset_id",
  "logo_square_asset_id",
  "favicon_asset_id",
  "og_image_asset_id",
] as const;

const quietPoolLogger = { error: (): void => undefined };

type Pool = ReturnType<typeof createPool>;
type Row = Record<string, unknown>;

let db: TestDatabase;
let migratorPool: Pool;
/** velexis_migrator: the platform's tenant rows, and catalogue queries on the tenant schemas. */
let migrator: Kysely<PlatformDatabase>;
let otaPool: Pool;
/** velexis_ota_app through tenantTx: the application's access to tenant rows. */
let app: TenantDb;
let provisioner: ProvisionerDatabase;
let provisioning: ProvisioningService;
const folders: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 2,
  });
  app = createTenantDb(otaPool, { appEnv: "test" });
  // The worker's provisioning service with its real collaborators: the read-only platform repository on the
  // velexis_ota_app pool, the provisioner database (DATABASE_PROVISIONER_URL), the release's migrations folder.
  provisioner = createProvisionerDatabase(
    { APP_ENV: "test", DATABASE_PROVISIONER_URL: db.urlFor("provisioner") },
    quietPoolLogger,
  );
  provisioning = new ProvisioningService(
    new PlatformReadRepository(createPlatformDb(otaPool)),
    provisioner,
    DEFAULT_PROVISIONING_OPTIONS,
    new Clock(),
  );
});

afterAll(async () => {
  await provisioner?.pool.end();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
  await Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---- Schemas ----------------------------------------------------------------------------------------------------

/** A tenant migrations folder as the previous release ships it: the baseline only (schema version N-1). */
async function previousReleaseFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-obe008-n-minus-1-"));
  folders.push(dir);
  await copyFile(join(TENANT_MIGRATIONS_DIR, BASELINE_FILE), join(dir, BASELINE_FILE));
  return dir;
}

/** Provisions `schema` as the OTA worker does (velexis_provisioner, `create`), with this release's files or `dir`. */
async function provision(schema: string, dir = TENANT_MIGRATIONS_DIR) {
  return migrateTenantSchema({ schema, dir, url: db.urlFor("provisioner"), create: true });
}

/** Inserts a tenant as the platform does (velexis_migrator) and returns its id; its schema is `tenant_<key>`. */
async function insertTenant(key: string, status: string): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `OTA ${key}`, plan_code: "early_access", status })
    .execute();
  return id;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function migrationChecksum(file = MIGRATION_FILE): Promise<string> {
  return sha256(await readFile(join(TENANT_MIGRATIONS_DIR, file)));
}

async function tablesOf(schema: string): Promise<string[]> {
  const { rows } = await sql<{ table: string }>`SELECT tablename AS table FROM pg_catalog.pg_tables
    WHERE schemaname = ${schema} ORDER BY tablename`.execute(migrator);
  return rows.map((row) => row.table);
}

/** The schema's ledger with the transaction id (xmin) of each row, read as velexis_ota_app through tenantTx. */
async function ledgerOf(schema: string) {
  return tenantTx(app, schema, async (trx) => {
    const { rows } = await sql<{
      id: string;
      checksum: string;
      phase: string;
      status: string;
      execution_ms: number | null;
      xid: string;
    }>`SELECT id, checksum, phase, status, execution_ms, xmin::text AS xid FROM schema_migrations ORDER BY id`.execute(
      trx,
    );
    return rows;
  });
}

/**
 * The normalised catalogue of `schema`, one sorted line per column, index, constraint (with its validation state),
 * trigger, comment and privilege, with the schema's own name taken out: two schemas with the same lines have the same
 * structure, the same documentation and the same grants.
 */
async function catalogue(schema: string): Promise<string[]> {
  const { rows } = await sql<{ line: string }>`
    WITH ns AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = ${schema}),
    lines AS (
      SELECT format('column %s.%s %s %s %s %s %s', table_name, column_name, data_type,
        coalesce(character_maximum_length::text, ''), is_nullable, coalesce(column_default, ''),
        coalesce(generation_expression, '')) AS line
      FROM information_schema.columns WHERE table_schema = ${schema}
      UNION ALL SELECT format('index %s', indexdef) FROM pg_catalog.pg_indexes WHERE schemaname = ${schema}
      UNION ALL SELECT format('constraint %s %s %s validated=%s comment=%s', cl.relname, co.conname,
          pg_get_constraintdef(co.oid), co.convalidated, coalesce(obj_description(co.oid, 'pg_constraint'), ''))
        FROM pg_catalog.pg_constraint co JOIN pg_catalog.pg_class cl ON cl.oid = co.conrelid
        WHERE cl.relnamespace = (SELECT oid FROM ns)
      UNION ALL SELECT format('trigger %s', pg_get_triggerdef(t.oid)) FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class cl ON cl.oid = t.tgrelid WHERE cl.relnamespace = (SELECT oid FROM ns)
        AND NOT t.tgisinternal
      UNION ALL SELECT format('comment %s.%s %s', cl.relname, coalesce(a.attname, ''), d.description)
        FROM pg_catalog.pg_description d JOIN pg_catalog.pg_class cl ON cl.oid = d.objoid
        AND d.classoid = 'pg_catalog.pg_class'::regclass
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = cl.oid AND a.attnum = d.objsubid AND d.objsubid > 0
        WHERE cl.relnamespace = (SELECT oid FROM ns)
      UNION ALL SELECT format('acl %s %s %s', cl.relname, cl.relkind, cl.relacl) FROM pg_catalog.pg_class cl
        WHERE cl.relnamespace = (SELECT oid FROM ns)
      UNION ALL SELECT format('owner %s %s', cl.relname, pg_get_userbyid(cl.relowner)) FROM pg_catalog.pg_class cl
        WHERE cl.relnamespace = (SELECT oid FROM ns)
      UNION ALL SELECT format('default acl %s %s', d.defaclobjtype, d.defaclacl) FROM pg_catalog.pg_default_acl d
        WHERE d.defaclnamespace = (SELECT oid FROM ns)
    )
    SELECT replace(line, ${schema}, '<schema>') AS line FROM lines ORDER BY 1`.execute(migrator);
  return rows.map((row) => row.line);
}

/** The privileges of velexis_ota_app on the tables of `schema`, by table. */
async function otaPrivileges(schema: string): Promise<Record<string, string[]>> {
  const { rows } = await sql<{ table: string; privileges: string[] }>`
    SELECT c.relname AS table, array(
      SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p
      WHERE has_table_privilege('velexis_ota_app', c.oid, p)) AS privileges
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p')
    ORDER BY c.relname`.execute(migrator);
  return Object.fromEntries(rows.map((row) => [row.table, row.privileges]));
}

// ---- The committed Kysely types ---------------------------------------------------------------------------------

interface ColumnShape {
  readonly nullable: boolean;
  /** Has a default (or is generated): optional on insert, `Generated<…>` in the types. */
  readonly hasDefault: boolean;
}

/** The tables and columns of `TenantTables` in packages/db/src/generated/tenant.ts, as `table.column` → shape. */
async function generatedColumns(): Promise<Record<string, ColumnShape>> {
  const generated = await readFile(GENERATED_TYPES, "utf8");
  const body = (name: string): string => {
    const match = new RegExp(`^export interface ${name} \\{\\n([\\s\\S]*?)^\\}$`, "m").exec(generated);
    if (match === null) {
      throw new Error(`packages/db/src/generated/tenant.ts has no interface ${name}`);
    }
    return match[1] ?? "";
  };
  const columns: Record<string, ColumnShape> = {};
  for (const [, table, rowType] of body("TenantTables").matchAll(/^ {2}([a-z_]+): ([A-Za-z]+);$/gm)) {
    for (const [, column, type] of body(rowType ?? "").matchAll(/^ {2}([a-z_][a-z0-9_]*): (.+);$/gm)) {
      columns[`${table ?? ""}.${column ?? ""}`] = {
        nullable: /\| null\b/.test(type ?? ""),
        hasDefault: (type ?? "").startsWith("Generated<"),
      };
    }
  }
  return columns;
}

/** The columns of the tables of `schema` in the database, in the shape of `generatedColumns`. */
async function databaseColumns(schema: string): Promise<Record<string, ColumnShape>> {
  const { rows } = await sql<{ table: string; column: string; nullable: boolean; has_default: boolean }>`
    SELECT c.table_name AS table, c.column_name AS column, c.is_nullable = 'YES' AS nullable,
      (c.column_default IS NOT NULL OR c.is_generated = 'ALWAYS' OR c.is_identity = 'YES') AS has_default
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = ${schema}`.execute(migrator);
  return Object.fromEntries(
    rows.map((row) => [
      `${row.table}.${row.column}`,
      { nullable: row.nullable, hasDefault: row.has_default },
    ]),
  );
}

// ---- Rows -------------------------------------------------------------------------------------------------------

type PaymentInsert = Insertable<TenantDatabase["payments"]>;

/** A Stripe card payment of the baseline: PSP reference, expiry, 3-D Secure outcome, manual capture. */
function stripePayment(overrides: Partial<PaymentInsert> = {}): PaymentInsert {
  return {
    id: newId("pay", NOW),
    environment: "test",
    provider: "stripe",
    method: "card",
    provider_payment_id: "pi_test_obe008",
    capture_method: "manual",
    currency: "EUR",
    amount: "250.00",
    status: "authorized",
    amount_authorized: "250.00",
    card_brand: "VISA",
    card_bin: "424242",
    card_last4: "4242",
    card_exp_month: 12,
    card_exp_year: 2030,
    three_ds: JSON.stringify({ version: "2.2.0", eci: "05" }),
    ...overrides,
  };
}

/** An airline-card payment as ADR-0011 allows it: brand, BIN, last 4 and the outcome, automatic capture. */
function airlinePayment(overrides: Partial<PaymentInsert> = {}): PaymentInsert {
  return {
    id: newId("pay", NOW),
    environment: "test",
    provider: "airline",
    method: "airline_card",
    capture_method: "automatic",
    currency: "EUR",
    amount: "180.40",
    status: "captured",
    amount_authorized: "180.40",
    amount_captured: "180.40",
    card_brand: "MASTERCARD",
    card_bin: "555555",
    card_last4: "4444",
    ...overrides,
  };
}

/**
 * The baseline rows of the upgrade test, written as velexis_ota_app at schema version N-1: the settings row, a
 * search with an offer, its priced offer, a checkout, the booking it produced, and two payments of the baseline
 * kinds (a Stripe card and a manual cash payment).
 */
async function insertBaselineRows(schema: string): Promise<void> {
  const searchId = newId("srch", NOW);
  const offerId = newId("off", NOW);
  const pricedOfferId = newId("prc", NOW);
  const checkoutId = newId("chk", NOW);
  const bookingId = newId("bkg", NOW);
  const expiresAt = new Date("2026-10-15T10:00:00.000Z");
  await tenantTx(app, schema, async (trx) => {
    await trx
      .insertInto("storefront_settings")
      .values({ id: "sfs_default", brand_name: "Upgrade Travel", support_email: "help@upgrade.example.com" })
      .execute();
    await trx
      .insertInto("flight_searches")
      .values({
        id: searchId,
        environment: "test",
        criteria: JSON.stringify({ origin: "CDG", destination: "LHR", departureDate: "2026-11-02" }),
        amadeus_request: JSON.stringify({ originLocationCode: "CDG", destinationLocationCode: "LHR" }),
        expires_at: expiresAt,
      })
      .execute();
    await trx
      .insertInto("flight_offers")
      .values({
        id: offerId,
        environment: "test",
        search_id: searchId,
        amadeus_offer_id: "1",
        payload: JSON.stringify({ id: "1", type: "flight-offer" }),
        currency: "EUR",
        net_total: "200.00",
        markup_amount: "20.00",
        selling_total: "220.00",
        first_departure_local: "2026-11-02 08:15:00",
        expires_at: expiresAt,
      })
      .execute();
    await trx
      .insertInto("priced_offers")
      .values({
        id: pricedOfferId,
        environment: "test",
        offer_id: offerId,
        offer_ids: [offerId],
        amadeus_request: JSON.stringify({ data: { type: "flight-offers-pricing" } }),
        response: JSON.stringify({ data: { flightOffers: [] } }),
        currency: "EUR",
        net_total: "200.00",
        markup_amount: "20.00",
        fee_amount: "5.00",
        selling_total: "225.00",
        expires_at: expiresAt,
      })
      .execute();
    await trx
      .insertInto("checkouts")
      .values({
        id: checkoutId,
        environment: "test",
        base_priced_offer_id: pricedOfferId,
        priced_offer_id: pricedOfferId,
        status: "completed",
        currency: "EUR",
        offer_amount: "225.00",
        fees_amount: "25.00",
        total_amount: "250.00",
        expires_at: expiresAt,
        completed_at: NOW,
      })
      .execute();
    await trx
      .insertInto("bookings")
      .values({
        id: bookingId,
        environment: "test",
        reference: "VXUPGR01",
        checkout_id: checkoutId,
        priced_offer_id: pricedOfferId,
        status: "confirmed",
        record_locator: "ABC123",
        first_departure_at: new Date("2026-11-02T07:15:00.000Z"),
        last_arrival_at: new Date("2026-11-02T07:35:00.000Z"),
        currency: "EUR",
        net_amount: "200.00",
        markup_amount: "20.00",
        fees_amount: "5.00",
        card_fee_amount: "25.00",
        total_amount: "250.00",
        contact_email: "traveller@example.com",
        lead_last_name: "TRAVELLER",
      })
      .execute();
    await trx
      .insertInto("payments")
      .values([
        stripePayment({ checkout_id: checkoutId, booking_id: bookingId, card_fee_amount: "25.00" }),
        {
          id: newId("pay", NOW),
          environment: "test",
          booking_id: bookingId,
          provider: "manual",
          method: "cash",
          capture_method: "automatic",
          currency: "EUR",
          amount: "10.00",
          status: "captured",
          amount_authorized: "10.00",
          amount_captured: "10.00",
        },
      ])
      .execute();
  });
}

/** Every row of the four upgraded tables, read as velexis_ota_app, ordered by id. */
interface UpgradedRows {
  readonly payments: Row[];
  readonly checkouts: Row[];
  readonly bookings: Row[];
  readonly storefrontSettings: Row[];
}

async function upgradedRows(schema: string): Promise<UpgradedRows> {
  return tenantTx(app, schema, async (trx) => {
    const all = async (table: "payments" | "checkouts" | "bookings" | "storefront_settings") =>
      (await sql<Row>`SELECT * FROM ${sql.table(table)} ORDER BY id`.execute(trx)).rows;
    return {
      payments: await all("payments"),
      checkouts: await all("checkouts"),
      bookings: await all("bookings"),
      storefrontSettings: await all("storefront_settings"),
    };
  });
}

/** The PostgreSQL error of a failed statement: its SQLSTATE and the constraint it names. */
async function failure(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined }> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error, "the statement was expected to fail").toBeInstanceOf(Error);
  const { code, constraint } = error as { code?: string; constraint?: string };
  return { code, constraint };
}

// ---- Tests ------------------------------------------------------------------------------------------------------

describe("tenant migration 0002 on PostgreSQL", () => {
  it("applies 0001 and 0002 to an empty schema in one transaction; the columns match the generated types [OBE-008 AC1]", async () => {
    const schema = "tenant_m2_scratch";

    const result = await provision(schema);

    expect(result.created).toBe(true);
    expect(result.applied.map((file) => [file.id, file.phase, file.transaction, file.status])).toEqual([
      ["0001_baseline", "expand", true, "applied"],
      [MIGRATION_ID, "expand", true, "applied"],
      [SYNC_CLAIM_ID, "expand", true, "applied"],
      [LATEST_ID, "expand", true, "applied"],
    ]);
    // Every ledger row comes from the one provisioning transaction.
    expect(new Set((await ledgerOf(schema)).map((row) => row.xid)).size).toBe(1);
    const tables = await tablesOf(schema);
    expect(tables).toHaveLength(44);
    expect(tables).toEqual(expect.arrayContaining(["storefront_assets", "storefront_pages"]));

    // The catalogue matches the committed types of `pnpm db:codegen`: the same tables and columns, the same
    // nullability and the same defaults (CI also regenerates them and fails on a diff).
    const generated = await generatedColumns();
    const actual = await databaseColumns(schema);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(generated).sort());
    expect(actual).toEqual(generated);
    expect(actual["payments.provider"]).toEqual({ nullable: false, hasDefault: false });
    expect(actual["checkouts.pricing_mode"]).toEqual({ nullable: false, hasDefault: true });
    expect(actual["bookings.reconcile_until"]).toEqual({ nullable: true, hasDefault: false });
    expect(actual["storefront_settings.booking_queue_number"]).toEqual({ nullable: true, hasDefault: false });
    // 0003 (FIX-W27-SYNC).
    expect(actual["bookings.sync_claimed_at"]).toEqual({ nullable: true, hasDefault: false });
    expect(actual["bookings.sync_changes"]).toEqual({ nullable: false, hasDefault: true });
    // 0004 (FIX-W28-CANCEL).
    expect(actual["payments.card_fee_lines"]).toEqual({ nullable: false, hasDefault: true });
  });

  it("upgrades a schema at N-1 with baseline rows in payments, checkouts, bookings and storefront_settings: the rows survive and still validate [OBE-008 AC1]", async () => {
    // An active tenant, so the fan-out targets its schema.
    await insertTenant("upgrade", "active");
    const schema = "tenant_upgrade";
    await provision(schema, await previousReleaseFolder());
    expect((await ledgerOf(schema)).map((row) => row.id)).toEqual(["0001_baseline"]);
    await insertBaselineRows(schema);
    const before = await upgradedRows(schema);
    expect(Object.values(before).map((rows) => rows.length)).toEqual([2, 1, 1, 1]);

    // The deploy fan-out of this release: every schema of an active tenant, as velexis_migrator, no --create.
    const fanOut = await migrateTenants({ dir: TENANT_MIGRATIONS_DIR, url: db.urlFor("migrator") });

    expect(fanOut.exitCode).toBe(0);
    expect(fanOut.report?.target).toBe(LATEST_ID);
    expect(fanOut.report?.failed).toEqual([]);
    const upgraded = fanOut.report?.applied.find((entry) => entry.schema === schema);
    expect(upgraded?.files.map((file) => [file.id, file.status])).toEqual([
      [MIGRATION_ID, "applied"],
      [SYNC_CLAIM_ID, "applied"],
      [LATEST_ID, "applied"],
    ]);

    // The rows are all there, unchanged, with the defaults of the new columns.
    const after = await upgradedRows(schema);
    // 0004 (FIX-W28-CANCEL): no card fee line stored, so the card fee of these payments counts as kept.
    expect(after.payments).toEqual(before.payments.map((row) => ({ ...row, card_fee_lines: [] })));
    expect(after.checkouts).toEqual(
      before.checkouts.map((row) => ({ ...row, pricing_mode: "markup_rules" })),
    );
    expect(after.bookings).toEqual(
      before.bookings.map((row) => ({
        ...row,
        create_order_started_at: null,
        reconcile_until: null,
        reconcile_attempts: 0,
        reconcile_outcome: null,
        // 0003 (FIX-W27-SYNC): no claim yet, no change recorded.
        sync_claimed_at: null,
        sync_changes: [],
      })),
    );
    expect(after.storefrontSettings).toEqual(
      before.storefrontSettings.map((row) => ({
        ...row,
        legal_name: null,
        time_zone: "UTC",
        default_market: null,
        markets: [],
        support_details: {},
        seo: {},
        consent: {},
        terms_version: null,
        privacy_version: null,
        airline_card_enabled_test: false,
        airline_card_enabled_live: false,
        booking_queue_number: null,
        booking_queue_category: 0,
        ops_alert_email: null,
        logo_asset_id: null,
        logo_dark_asset_id: null,
        logo_square_asset_id: null,
        favicon_asset_id: null,
        og_image_asset_id: null,
      })),
    );

    // Still valid: the replaced CHECKs are validated against the existing rows, and rewriting every row re-checks
    // each constraint of the four tables.
    const { rows: constraints } = await sql<{ name: string; validated: boolean }>`
      SELECT conname AS name, convalidated AS validated FROM pg_catalog.pg_constraint
      WHERE conrelid = ${`${schema}.payments`}::regclass AND contype = 'c' AND conname LIKE 'payments\_%'
      ORDER BY conname`.execute(migrator);
    expect(constraints).toEqual(
      expect.arrayContaining([
        { name: "payments_airline_card_ck", validated: true },
        { name: "payments_method_ck", validated: true },
        { name: "payments_provider_ck", validated: true },
      ]),
    );
    expect(constraints.map((row) => row.name)).not.toContain("payments_provider_check");
    expect(constraints.map((row) => row.name)).not.toContain("payments_method_check");
    const rewritten = await tenantTx(app, schema, async (trx) => {
      const counts: number[] = [];
      for (const table of ["payments", "checkouts", "bookings", "storefront_settings"] as const) {
        const result = await sql`UPDATE ${sql.table(table)} SET version = version + 1`.execute(trx);
        counts.push(Number(result.numAffectedRows ?? 0n));
      }
      return counts;
    });
    expect(rewritten).toEqual([2, 1, 1, 1]);

    // The upgraded schema has exactly the catalogue of a schema provisioned with the release's files.
    await provision("tenant_m2_reference");
    const reference = await catalogue("tenant_m2_reference");
    expect(reference.length).toBeGreaterThan(500);
    expect(await catalogue(schema)).toEqual(reference);
  });

  it("refuses an airline-card payment with an expiry, a PSP reference, 3-D Secure data or the card method, and keeps brand, BIN and last 4 [OBE-008 AC1]", async () => {
    const schema = "tenant_m2_airline";
    await provision(schema);
    const insert = (payment: PaymentInsert) =>
      tenantTx(app, schema, (trx) => trx.insertInto("payments").values(payment).execute());

    // Brand, BIN, last 4 and the outcome: accepted, next to a Stripe card payment with everything the PSP returns.
    await insert(airlinePayment());
    await insert(stripePayment());
    const kept = await tenantTx(app, schema, (trx) =>
      trx
        .selectFrom("payments")
        .select(["provider", "method", "card_brand", "card_bin", "card_last4", "card_exp_month", "three_ds"])
        .where("provider", "=", "airline")
        .execute(),
    );
    expect(kept).toEqual([
      {
        provider: "airline",
        method: "airline_card",
        card_brand: "MASTERCARD",
        card_bin: "555555",
        card_last4: "4444",
        card_exp_month: null,
        three_ds: null,
      },
    ]);

    // Anything else about the card, a PSP reference, or a provider without its method is refused by the CHECK.
    const airlineCheck = { code: CHECK_VIOLATION, constraint: "payments_airline_card_ck" };
    expect(await failure(insert(airlinePayment({ card_exp_month: 12 })))).toEqual(airlineCheck);
    expect(await failure(insert(airlinePayment({ card_exp_year: 2030 })))).toEqual(airlineCheck);
    expect(await failure(insert(airlinePayment({ method: "card" })))).toEqual(airlineCheck);
    expect(await failure(insert(stripePayment({ method: "airline_card" })))).toEqual(airlineCheck);
    expect(await failure(insert(airlinePayment({ provider_payment_id: "pi_123" })))).toEqual(airlineCheck);
    expect(await failure(insert(airlinePayment({ provider_customer_id: "cus_123" })))).toEqual(airlineCheck);
    expect(await failure(insert(airlinePayment({ three_ds: JSON.stringify({ version: "2.2.0" }) })))).toEqual(
      airlineCheck,
    );
    expect(
      await failure(insert(airlinePayment({ next_action: JSON.stringify({ type: "redirect" }) }))),
    ).toEqual(airlineCheck);
    expect(await failure(insert(airlinePayment({ capture_method: "manual" })))).toEqual(airlineCheck);
    // The extended lists are the named constraints of 0002 now.
    expect(await failure(insert(stripePayment({ provider: "wire" })))).toEqual({
      code: CHECK_VIOLATION,
      constraint: "payments_provider_ck",
    });
    expect(await failure(insert(stripePayment({ method: "crypto" })))).toEqual({
      code: CHECK_VIOLATION,
      constraint: "payments_method_ck",
    });
    expect(
      await tenantTx(app, schema, (trx) =>
        trx.selectFrom("payments").select("provider").orderBy("provider").execute(),
      ),
    ).toEqual([{ provider: "airline" }, { provider: "stripe" }]);
  });

  it("refuses to delete an asset that storefront_settings references (RESTRICT) and deletes an unused one [OBE-008 AC1]", async () => {
    const schema = "tenant_m2_assets";
    await provision(schema);
    const asset = (kind: string, extension: "png" | "ico", hashDigit: string) => ({
      id: newId("ast", NOW),
      kind,
      content_type: extension === "png" ? "image/png" : "image/x-icon",
      file_extension: extension,
      file_name: `${kind}.${extension}`,
      size_bytes: 2048,
      width: 64,
      height: 64,
      storage_key: `tenant_assets/assets/${hashDigit.repeat(64)}.${extension}`,
      content_hash: hashDigit.repeat(64),
      uploaded_by_staff_id: "stf_01J9ZK3V5Q8X2M4N6P7R9S1T3X",
    });
    const used = asset("logo", "png", "a");
    const unused = asset("og_image", "png", "b");
    await tenantTx(app, schema, async (trx) => {
      await trx
        .insertInto("storefront_settings")
        .values({ id: "sfs_default", brand_name: "Assets Travel" })
        .execute();
      await trx.insertInto("storefront_assets").values([used, unused]).execute();
    });

    // Each of the five references holds the asset it points at.
    for (const column of ASSET_COLUMNS) {
      await tenantTx(app, schema, (trx) =>
        trx.updateTable("storefront_settings").set(column, used.id).execute(),
      );
      expect(
        await failure(
          tenantTx(app, schema, (trx) =>
            trx.deleteFrom("storefront_assets").where("id", "=", used.id).execute(),
          ),
        ),
      ).toEqual({ code: FOREIGN_KEY_VIOLATION, constraint: `storefront_settings_${column}_fkey` });
      await tenantTx(app, schema, (trx) =>
        trx.updateTable("storefront_settings").set(column, null).execute(),
      );
    }
    const { rows: foreignKeys } = await sql<{ name: string; on_delete: string }>`
      SELECT conname AS name, confdeltype AS on_delete FROM pg_catalog.pg_constraint
      WHERE conrelid = ${`${schema}.storefront_settings`}::regclass AND contype = 'f' ORDER BY conname`.execute(
      migrator,
    );
    expect(foreignKeys).toEqual(
      [...ASSET_COLUMNS]
        .sort()
        .map((column) => ({ name: `storefront_settings_${column}_fkey`, on_delete: "r" })),
    );

    // An asset nothing references can go; an icon only as a favicon.
    await tenantTx(app, schema, (trx) =>
      trx.deleteFrom("storefront_assets").where("id", "=", unused.id).execute(),
    );
    expect(
      await failure(
        tenantTx(app, schema, (trx) =>
          trx
            .insertInto("storefront_assets")
            .values(asset("logo", "ico", "c"))
            .execute(),
        ),
      ),
    ).toEqual({ code: CHECK_VIOLATION, constraint: "storefront_assets_icon_ck" });
    await tenantTx(app, schema, (trx) =>
      trx
        .insertInto("storefront_assets")
        .values(asset("favicon", "ico", "d"))
        .execute(),
    );
    expect(
      await tenantTx(app, schema, (trx) =>
        trx.selectFrom("storefront_assets").select("kind").orderBy("kind").execute(),
      ),
    ).toEqual([{ kind: "favicon" }, { kind: "logo" }]);
  });

  it("refuses two pages with the same slug and locale, and a published page without published_at [OBE-008 AC1]", async () => {
    const schema = "tenant_m2_pages";
    await provision(schema);
    const page = (overrides: Partial<Insertable<TenantDatabase["storefront_pages"]>> = {}) => ({
      id: newId("stp", NOW),
      slug: "terms",
      locale: "en",
      kind: "terms",
      title: "Terms and conditions",
      body_markdown: "## Booking\n\nYour contract is with the airline.",
      ...overrides,
    });
    const insert = (row: Insertable<TenantDatabase["storefront_pages"]>) =>
      tenantTx(app, schema, (trx) => trx.insertInto("storefront_pages").values(row).execute());

    await insert(page());
    // The same slug in another locale is another version of the page.
    await insert(page({ locale: "fr", title: "Conditions générales" }));
    expect(await failure(insert(page({ title: "Terms again" })))).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: "storefront_pages_slug_locale_uq",
    });

    expect(await failure(insert(page({ slug: "privacy", kind: "privacy", is_published: true })))).toEqual({
      code: CHECK_VIOLATION,
      constraint: "storefront_pages_published_ck",
    });
    await insert(page({ slug: "privacy", kind: "privacy", is_published: true, published_at: NOW }));
    // Unpublishing keeps the first publication time; publishing again needs it.
    await tenantTx(app, schema, (trx) =>
      trx
        .updateTable("storefront_pages")
        .set({ is_published: false })
        .where("slug", "=", "privacy")
        .execute(),
    );
    expect(
      await failure(
        tenantTx(app, schema, (trx) =>
          trx
            .updateTable("storefront_pages")
            .set({ is_published: true, published_at: null })
            .where("slug", "=", "privacy")
            .execute(),
        ),
      ),
    ).toEqual({ code: CHECK_VIOLATION, constraint: "storefront_pages_published_ck" });

    const pages = await tenantTx(app, schema, (trx) =>
      trx
        .selectFrom("storefront_pages")
        .select(["slug", "locale", "is_published", "published_at", "show_in_footer", "sort_order", "version"])
        .orderBy("slug")
        .orderBy("locale")
        .execute(),
    );
    expect(pages).toEqual([
      {
        slug: "privacy",
        locale: "en",
        is_published: false,
        published_at: NOW,
        show_in_footer: false,
        sort_order: 100,
        version: 1,
      },
      {
        slug: "terms",
        locale: "en",
        is_published: false,
        published_at: null,
        show_in_footer: false,
        sort_order: 100,
        version: 1,
      },
      {
        slug: "terms",
        locale: "fr",
        is_published: false,
        published_at: null,
        show_in_footer: false,
        sort_order: 100,
        version: 1,
      },
    ]);
  });

  it("records 0002_add_mvp_tenant_deltas in the ledger with phase expand and the file's checksum, in the transaction of its DDL [OBE-008 AC1]", async () => {
    const schema = "tenant_m2_ledger";
    await provision(schema, await previousReleaseFolder());

    // As `migrate.js tenant` and the fan-out run it: velexis_migrator, no --create.
    const result = await migrateTenantSchema({
      schema,
      dir: TENANT_MIGRATIONS_DIR,
      url: db.urlFor("migrator"),
    });

    expect(result).toMatchObject({ created: false, upToDate: 1, ledgerOnly: [] });
    expect(result.applied.map((file) => [file.id, file.checksum])).toEqual([
      [MIGRATION_ID, await migrationChecksum()],
      [SYNC_CLAIM_ID, await migrationChecksum(SYNC_CLAIM_FILE)],
      [LATEST_ID, await migrationChecksum(LATEST_FILE)],
    ]);
    const ledger = await ledgerOf(schema);
    expect(ledger.map(({ id, checksum, phase, status }) => ({ id, checksum, phase, status }))).toEqual([
      {
        id: "0001_baseline",
        checksum: sha256(await readFile(join(TENANT_MIGRATIONS_DIR, BASELINE_FILE))),
        phase: "expand",
        status: "applied",
      },
      { id: MIGRATION_ID, checksum: await migrationChecksum(), phase: "expand", status: "applied" },
      {
        id: SYNC_CLAIM_ID,
        checksum: await migrationChecksum(SYNC_CLAIM_FILE),
        phase: "expand",
        status: "applied",
      },
      { id: LATEST_ID, checksum: await migrationChecksum(LATEST_FILE), phase: "expand", status: "applied" },
    ]);
    expect(ledger[1]?.execution_ms).toEqual(expect.any(Number));
    // The ledger row and the two tables of 0002 were written by one transaction, a later one than the baseline's.
    const { rows } = await sql<{ xid: string }>`SELECT DISTINCT xmin::text AS xid FROM pg_catalog.pg_class
      WHERE oid IN (${`${schema}.storefront_assets`}::regclass, ${`${schema}.storefront_pages`}::regclass)`.execute(
      migrator,
    );
    expect(rows).toEqual([{ xid: ledger[1]?.xid }]);
    expect(ledger[1]?.xid).not.toBe(ledger[0]?.xid);

    // A second run applies nothing.
    const again = await migrateTenantSchema({
      schema,
      dir: TENANT_MIGRATIONS_DIR,
      url: db.urlFor("migrator"),
    });
    expect(again).toMatchObject({ applied: [], upToDate: 4 });
  });

  it("provisions a new tenant with 0002 in its ledger; velexis_ota_app writes storefront_assets and storefront_pages through the default privileges [OBE-008 AC2]", async () => {
    const tenantId = await insertTenant("pagesco", "provisioning");
    const schema = "tenant_pagesco";

    // The OTA worker's provisioning (OBE-005): schema, every file, grants and seeds in one transaction.
    const result = await provisioning.provisionTenant(tenantId);

    expect(result.status).toBe("provisioned");
    const payload = result.status === "provisioned" ? result.payload : undefined;
    expect(payload?.schemaName).toBe(schema);
    expect(payload?.schemaVersion).toBe(LATEST_ID);
    expect(payload?.migrations.map((migration) => [migration.version, migration.phase])).toEqual([
      ["0001_baseline", "expand"],
      [MIGRATION_ID, "expand"],
      [SYNC_CLAIM_ID, "expand"],
      [LATEST_ID, "expand"],
    ]);
    const ledger = await ledgerOf(schema);
    expect(ledger.map(({ id, checksum }) => [id, checksum]).find(([id]) => id === MIGRATION_ID)).toEqual([
      MIGRATION_ID,
      await migrationChecksum(),
    ]);

    // The new tables carry exactly the DML of every other tenant table: they come from the default privileges that
    // provisioning set for velexis_provisioner's tables, since 0002 has no GRANT.
    const privileges = await otaPrivileges(schema);
    expect(privileges["storefront_assets"]).toEqual(DML);
    expect(privileges["storefront_pages"]).toEqual(DML);
    expect(new Set(Object.values(privileges).map((granted) => granted.join(",")))).toEqual(
      new Set([DML.join(",")]),
    );
    const { rows: defaults } = await sql<{
      owner: string;
      type: string;
      grantee: string;
      privileges: string[];
    }>`
      SELECT pg_get_userbyid(d.defaclrole) AS owner, d.defaclobjtype AS type, a.grantee::regrole::text AS grantee,
        array_agg(a.privilege_type ORDER BY a.privilege_type) AS privileges
      FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclnamespace = to_regnamespace(${schema}) AND d.defaclobjtype = 'r'
      GROUP BY 1, 2, 3`.execute(migrator);
    expect(defaults).toEqual([
      {
        owner: "velexis_provisioner",
        type: "r",
        grantee: "velexis_ota_app",
        privileges: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      },
    ]);

    // The application writes, reads, updates and deletes in both tables, and points the seeded settings at an asset.
    const assetId = newId("ast", NOW);
    const pageId = newId("stp", NOW);
    const written = await tenantTx(app, schema, async (trx) => {
      await trx
        .insertInto("storefront_assets")
        .values({
          id: assetId,
          kind: "logo",
          content_type: "image/webp",
          file_extension: "webp",
          file_name: "logo.webp",
          size_bytes: 10_240,
          width: 320,
          height: 80,
          storage_key: `tenant_pagesco/assets/${"e".repeat(64)}.webp`,
          content_hash: "e".repeat(64),
        })
        .execute();
      await trx
        .insertInto("storefront_pages")
        .values({ id: pageId, slug: "about", locale: "en", kind: "about", title: "About us" })
        .execute();
      await trx
        .updateTable("storefront_pages")
        .set({ is_published: true, published_at: NOW, show_in_footer: true, version: 2 })
        .where("id", "=", pageId)
        .execute();
      await trx.updateTable("storefront_settings").set({ logo_asset_id: assetId }).execute();
      return {
        settings: await trx
          .selectFrom("storefront_settings")
          .select([
            "brand_name",
            "logo_asset_id",
            "time_zone",
            "booking_queue_number",
            "booking_queue_category",
            "airline_card_enabled_test",
            "airline_card_enabled_live",
          ])
          .execute(),
        pages: await trx.selectFrom("storefront_pages").select(["id", "is_published", "version"]).execute(),
      };
    });
    // The seeds (OBE-004) wrote the 0002 columns of the settings row, as they do on a schema at version N.
    expect(written).toEqual({
      settings: [
        {
          brand_name: "OTA pagesco",
          logo_asset_id: assetId,
          time_zone: "UTC",
          booking_queue_number: 50,
          booking_queue_category: 0,
          airline_card_enabled_test: false,
          airline_card_enabled_live: false,
        },
      ],
      pages: [{ id: pageId, is_published: true, version: 2 }],
    });
    await tenantTx(app, schema, async (trx) => {
      await trx.deleteFrom("storefront_pages").where("id", "=", pageId).execute();
      await trx.updateTable("storefront_settings").set({ logo_asset_id: null }).execute();
      await trx.deleteFrom("storefront_assets").where("id", "=", assetId).execute();
    });
    expect(
      await tenantTx(app, schema, async (trx) => ({
        assets: await trx.selectFrom("storefront_assets").select("id").execute(),
        pages: await trx.selectFrom("storefront_pages").select("id").execute(),
      })),
    ).toEqual({ assets: [], pages: [] });
  });
});

describe("tenant migration 0003 on PostgreSQL (FIX-W27-SYNC)", () => {
  it("[FIX-W27-SYNC AC1] adds the claim column, empty, and the last changes, an empty list that holds arrays only", async () => {
    const schema = "tenant_m3_claim";
    await provision(schema);
    await insertBaselineRows(schema);

    const booking = await tenantTx(app, schema, (trx) =>
      trx.selectFrom("bookings").select(["id", "sync_claimed_at", "sync_changes"]).executeTakeFirstOrThrow(),
    );
    expect(booking).toMatchObject({ sync_claimed_at: null, sync_changes: [] });
    const claimedAt = new Date("2026-10-23T09:00:00.000Z");
    await tenantTx(app, schema, (trx) =>
      trx
        .updateTable("bookings")
        .set({
          sync_claimed_at: claimedAt,
          sync_changes: JSON.stringify([
            { path: "/status", label: "Booking status", before: "a", after: "b" },
          ]),
        })
        .where("id", "=", booking.id)
        .execute(),
    );
    expect(
      await tenantTx(app, schema, (trx) =>
        trx.selectFrom("bookings").select(["sync_claimed_at", "sync_changes"]).executeTakeFirstOrThrow(),
      ),
    ).toEqual({
      sync_claimed_at: claimedAt,
      sync_changes: [{ path: "/status", label: "Booking status", before: "a", after: "b" }],
    });
    expect(
      await failure(
        tenantTx(app, schema, (trx) =>
          trx
            .updateTable("bookings")
            .set({ sync_changes: JSON.stringify({ path: "/status" }) })
            .where("id", "=", booking.id)
            .execute(),
        ),
      ),
    ).toEqual({ code: CHECK_VIOLATION, constraint: "bookings_sync_changes_ck" });
    // Documented like every column (conventions §9).
    const { rows } = await sql<{ column: string; comment: string | null }>`
      SELECT a.attname AS column, col_description(a.attrelid, a.attnum) AS comment FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = ${`${schema}.bookings`}::regclass AND a.attname IN ('sync_claimed_at', 'sync_changes')
      ORDER BY a.attname`.execute(migrator);
    expect(rows.map((row) => [row.column, (row.comment ?? "").length > 20])).toEqual([
      ["sync_changes", true],
      ["sync_claimed_at", true],
    ]);
  });
});

describe("tenant migration 0004 on PostgreSQL (FIX-W28-CANCEL)", () => {
  it("[FIX-W28-CANCEL AC2] adds the card fee's lines, an empty list on existing payments, that holds arrays only", async () => {
    const schema = "tenant_m4_fee_lines";
    await provision(schema);
    await insertBaselineRows(schema);

    const payment = await tenantTx(app, schema, (trx) =>
      trx.selectFrom("payments").select(["id", "card_fee_lines"]).orderBy("id").executeTakeFirstOrThrow(),
    );
    // A payment of before the column has no line: its whole card fee counts as kept.
    expect(payment.card_fee_lines).toEqual([]);
    const lines = [
      { source: "amadeus", ruleId: null, amount: "1.50", refundable: false },
      { source: "fee_rule", ruleId: "fee_01JA0000000000000000000001", amount: "2.00", refundable: true },
    ];
    await tenantTx(app, schema, (trx) =>
      trx
        .updateTable("payments")
        .set({ card_fee_lines: JSON.stringify(lines) })
        .where("id", "=", payment.id)
        .execute(),
    );
    expect(
      await tenantTx(app, schema, (trx) =>
        trx
          .selectFrom("payments")
          .select("card_fee_lines")
          .where("id", "=", payment.id)
          .executeTakeFirstOrThrow(),
      ),
    ).toEqual({ card_fee_lines: lines });
    expect(
      await failure(
        tenantTx(app, schema, (trx) =>
          trx
            .updateTable("payments")
            .set({ card_fee_lines: JSON.stringify({ source: "amadeus" }) })
            .where("id", "=", payment.id)
            .execute(),
        ),
      ),
    ).toEqual({ code: CHECK_VIOLATION, constraint: "payments_card_fee_lines_ck" });
    // Documented like every column (conventions §9).
    const { rows } = await sql<{ comment: string | null }>`
      SELECT col_description(a.attrelid, a.attnum) AS comment FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = ${`${schema}.payments`}::regclass AND a.attname = 'card_fee_lines'`.execute(
      migrator,
    );
    expect(rows.map((row) => (row.comment ?? "").length > 20)).toEqual([true]);
  });
});
