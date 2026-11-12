// `secrets:rewrap` (OBE-100; secrets/rewrap.command.ts and rewrap.repository.ts) against PostgreSQL 16: the re-wrap of
// every tenant ciphertext under the current master key, run through dist/cli.js's entry (`runCli`) as velexis_ota_app
// with the variables of ota-backend.env, as master-key-rotation.md steps 5 and 7 run it.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and seeds, in both schemas,
// values under `local:v1` and `local:v2` in every ciphertext column set (saved travellers and their documents, checkout
// and booking travellers, notifications, idempotency records), sealed as their writers seal them: a fresh data key per
// value and the associated data of its place. Next to them: rows without a ciphertext, and a sent notification whose
// secrets were purged but whose `encryption_key_id` still names `local:v1`. The plaintexts carry made-up markers (no
// real document number), so the captured output and logs can be searched for them. Later runs meet a corrupted and a
// copied value, rows another writer changes between the read and the write, and a table whose writes PostgreSQL
// refuses (the schema owner revokes UPDATE from velexis_ota_app for one run).
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aadFor, decryptValue, encryptValue, envelopeKekId, LocalFileKeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  type Kysely,
  type PlatformDatabase,
  tenantTx,
  type TenantDatabase,
  type TenantDb,
  type TenantSchema,
  type Transaction,
} from "@velexis/db";
import { createTestDatabase, type TestDatabase } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { runCli } from "../../../src/cli";
import { newId } from "../../../src/common/ids";
import { REWRAP_EXIT, rewrapSource } from "../../../src/secrets/rewrap.command";
import { REWRAP_SOURCES, RewrapRepository, type RewrapStore } from "../../../src/secrets/rewrap.repository";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";

type Schema = "tenant_alpha" | "tenant_beta";
type JsonObject = Record<string, unknown>;

/**
 * Cloning the template, writing the key files and seeding both schemas take a few seconds on a loaded CI runner, and
 * each run of the command opens its own pool: the runs happen in the hooks with this budget, the tests read what they
 * left.
 */
const SETUP_TIMEOUT_MS = 90_000;

const DAY_MS = 24 * 60 * 60_000;
const fromNow = (ms: number): Date => new Date(Date.now() + ms);
const marker = (label: string): string => `${label}-${randomBytes(6).toString("hex").toUpperCase()}`;

let db: TestDatabase;
let otaPool: OtaPool;
let tenantDb: TenantDb;
/** velexis_ota_app outside any tenant transaction: the catalog only. */
let catalog: Kysely<PlatformDatabase>;
const keyFolders: string[] = [];
/** MASTER_KEY_DIR of the runs: `master-v1.key` and `master-v2.key`. */
let keyDir: string;
let v1: LocalFileKeyProvider;
let v2: LocalFileKeyProvider;
/** `master-v2.key` alone: what remains once step 8 has removed `master-v1.key`. */
let v2Only: LocalFileKeyProvider;

const inTenant = <T>(schema: Schema, run: (trx: Transaction<TenantDatabase>) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, schema, run);

/** One sealed value as seeded: its place, its plaintext and the ciphertext written. */
interface Sealed {
  readonly schema: Schema;
  readonly table: string;
  readonly column: string;
  readonly id: string;
  readonly plaintext: string;
  readonly ciphertext: Buffer;
}

/** Every value sealed by the seed, and every row id it wrote. */
const sealed: Sealed[] = [];
const rowIds: string[] = [];

/** Seals `plaintext` for its place under `keys`, as the column's writer does. */
async function seal(
  keys: LocalFileKeyProvider,
  place: Omit<Sealed, "plaintext" | "ciphertext">,
  plaintext: string,
): Promise<Buffer> {
  const { ciphertext } = await encryptValue(plaintext, {
    aad: aadFor(place.schema, place.table, place.column, place.id),
    keys,
  });
  sealed.push({ ...place, plaintext, ciphertext });
  return ciphertext;
}

/** A row id with this prefix, remembered for the output checks. */
function rowId(
  prefix: "cus" | "trv" | "tdc" | "srch" | "off" | "prc" | "chk" | "ctr" | "bkg" | "btr" | "ntf" | "idk",
): string {
  const id = newId(prefix);
  rowIds.push(id);
  return id;
}

/** A documents list as the traveller writers seal it, with a made-up number. */
const documentsJson = (): string =>
  JSON.stringify([
    { documentType: "PASSPORT", number: marker("DOCNUM"), expiryDate: "2031-01-31", holder: true },
  ]);
/** A discount list as the traveller writers seal it, with a made-up card number. */
const discountsJson = (): string =>
  JSON.stringify([
    {
      subType: "SPANISH_RESIDENT",
      cityName: "MAD",
      travelerType: "SPANISH_CITIZEN",
      cardNumber: marker("CARDNUM"),
    },
  ]);

/**
 * Seeds every ciphertext column set of `schema`: per table rows under `local:v1` (8 in all), under `local:v2` (one per
 * table) and without a ciphertext.
 */
async function seedTenant(schema: Schema): Promise<void> {
  const keysOf = { v1, v2 } as const;
  const customerId = rowId("cus");
  await inTenant(schema, (trx) =>
    trx
      .insertInto("customers")
      .values({ id: customerId, email: `${marker("traveller").toLowerCase()}@example.com` })
      .execute(),
  );

  // saved_travelers: discount entries under v1 and v2, and none.
  const savedTravelers: string[] = [];
  for (const version of ["v1", "v2", null] as const) {
    const id = rowId("trv");
    savedTravelers.push(id);
    const ciphertext =
      version === null
        ? null
        : await seal(
            keysOf[version],
            { schema, table: "saved_travelers", column: "discount_eligibility_ciphertext", id },
            discountsJson(),
          );
    await inTenant(schema, (trx) =>
      trx
        .insertInto("saved_travelers")
        .values({
          id,
          customer_id: customerId,
          first_name: "TESTA",
          last_name: "SAMPLE",
          discount_eligibility_ciphertext: ciphertext,
          encryption_key_id: version === null ? null : `local:${version}`,
        })
        .execute(),
    );
  }

  // saved_traveler_documents: number and details under v1, the number alone under v1, the number under v2.
  for (const [version, withDetails] of [
    ["v1", true],
    ["v1", false],
    ["v2", false],
  ] as const) {
    const id = rowId("tdc");
    const place = { schema, table: "saved_traveler_documents", id };
    const number = await seal(keysOf[version], { ...place, column: "number_ciphertext" }, marker("DOCNUM"));
    const details = withDetails
      ? await seal(
          keysOf[version],
          { ...place, column: "details_ciphertext" },
          JSON.stringify({ birthPlace: marker("PLACE") }),
        )
      : null;
    await inTenant(schema, (trx) =>
      trx
        .insertInto("saved_traveler_documents")
        .values({
          id,
          saved_traveler_id: savedTravelers[0] ?? "",
          document_type: "PASSPORT",
          number_ciphertext: number,
          details_ciphertext: details,
          encryption_key_id: `local:${version}`,
          number_last4: "0042",
          expiry_date: "2031-01-31",
        })
        .execute(),
    );
  }

  // A checkout to hang the checkout travellers on: a search, an offer and its priced offer.
  const [searchId, offerId, pricedOfferId, checkoutId] = [
    rowId("srch"),
    rowId("off"),
    rowId("prc"),
    rowId("chk"),
  ];
  const expires = fromNow(30 * DAY_MS);
  await inTenant(schema, async (trx) => {
    await trx
      .insertInto("flight_searches")
      .values({
        id: searchId,
        environment: "test",
        criteria: JSON.stringify({
          mode: "simple",
          originLocationCode: "MAD",
          destinationLocationCode: "ORY",
        }),
        amadeus_request: JSON.stringify({ originLocationCode: "MAD", destinationLocationCode: "ORY" }),
        status: "completed",
        result_count: 1,
        expires_at: expires,
      })
      .execute();
    await trx
      .insertInto("flight_offers")
      .values({
        id: offerId,
        environment: "test",
        search_id: searchId,
        amadeus_offer_id: "1",
        payload: JSON.stringify({ type: "flight-offer", id: "1" }),
        currency: "EUR",
        net_total: "400.00",
        markup_amount: "40.00",
        selling_total: "440.00",
        first_departure_local: new Date(expires.getTime() - DAY_MS).toISOString().slice(0, 19),
        expires_at: expires,
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
        response: JSON.stringify({ data: { type: "flight-offers-pricing" } }),
        currency: "EUR",
        net_total: "400.00",
        markup_amount: "40.00",
        fee_amount: "0.00",
        selling_total: "440.00",
        expires_at: expires,
      })
      .execute();
    await trx
      .insertInto("checkouts")
      .values({
        id: checkoutId,
        environment: "test",
        base_priced_offer_id: pricedOfferId,
        priced_offer_id: pricedOfferId,
        status: "open",
        currency: "EUR",
        offer_amount: "440.00",
        total_amount: "440.00",
        expires_at: expires,
      })
      .execute();
  });

  // checkout_travelers and booking_travelers: documents and discount entries under v1, one of them under v1, one under
  // v2, and none.
  const bookingId = rowId("bkg");
  const departure = fromNow(30 * DAY_MS);
  await inTenant(schema, (trx) =>
    trx
      .insertInto("bookings")
      .values({
        id: bookingId,
        environment: "test",
        reference: newBookingReference(),
        status: "confirmed",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 2 * 60 * 60_000),
        currency: "EUR",
        net_amount: "400.00",
        markup_amount: "40.00",
        total_amount: "440.00",
        contact_email: "a***@example.com",
        lead_last_name: "SAMPLE",
      })
      .execute(),
  );
  for (const table of ["checkout_travelers", "booking_travelers"] as const) {
    const travelers = [
      ["v1", true, true],
      ["v1", false, true],
      ["v2", true, false],
      [null, false, false],
    ] as const;
    for (const [index, [version, withDocuments, withDiscounts]] of travelers.entries()) {
      // checkout_travelers keep the v1 row with documents alone, booking_travelers the one with discount entries alone.
      if (table === "booking_travelers" && index === 1) {
        continue;
      }
      const id = rowId(table === "checkout_travelers" ? "ctr" : "btr");
      const place = { schema, table, id };
      const documents =
        version !== null && withDocuments
          ? await seal(keysOf[version], { ...place, column: "documents_ciphertext" }, documentsJson())
          : null;
      const discounts =
        version !== null && withDiscounts
          ? await seal(
              keysOf[version],
              { ...place, column: "discount_eligibility_ciphertext" },
              discountsJson(),
            )
          : null;
      const common = {
        id,
        amadeus_traveler_id: String(index + 1),
        traveler_type: "ADULT",
        first_name: "TESTA",
        last_name: "SAMPLE",
        documents_ciphertext: documents,
        discount_eligibility_ciphertext: discounts,
        encryption_key_id: version === null ? null : `local:${version}`,
      } as const;
      await inTenant(schema, (trx) =>
        table === "checkout_travelers"
          ? trx
              .insertInto("checkout_travelers")
              .values({ ...common, checkout_id: checkoutId })
              .execute()
          : trx
              .insertInto("booking_travelers")
              .values({ ...common, booking_id: bookingId })
              .execute(),
      );
    }
  }

  // notifications: secrets of pending e-mails under v1 and v2, and a sent one whose secrets were purged but whose
  // encryption_key_id still names v1 (no value to move).
  for (const version of ["v1", "v2", "purged"] as const) {
    const id = rowId("ntf");
    const ciphertext =
      version === "purged"
        ? null
        : await seal(
            keysOf[version],
            { schema, table: "notifications", column: "secret_payload_ciphertext", id },
            JSON.stringify({ resetUrl: `https://demo.ota.example.com/reset?token=${marker("TOKEN")}` }),
          );
    await inTenant(schema, (trx) =>
      trx
        .insertInto("notifications")
        .values({
          id,
          template_key: "customer.password_reset",
          channel: "email",
          recipient: "a***@example.com",
          recipient_type: "customer",
          status: version === "purged" ? "sent" : "pending",
          secret_payload_ciphertext: ciphertext,
          encryption_key_id: "local:" + (version === "v2" ? "v2" : "v1"),
          secrets_purged_at: version === "purged" ? fromNow(-DAY_MS) : null,
          // Due in a year: no worker sends it while the test runs.
          next_attempt_at: fromNow(365 * DAY_MS),
        })
        .execute(),
    );
  }

  // idempotency_keys: verbatim answers under v1 and v2, and a record without one.
  for (const version of ["v1", "v2", null] as const) {
    const id = rowId("idk");
    const ciphertext =
      version === null
        ? null
        : await seal(
            keysOf[version],
            { schema, table: "idempotency_keys", column: "response_ciphertext", id },
            JSON.stringify({
              v: 1,
              empty: false,
              body: { bookingToken: marker("BOOKINGTOKEN") },
              setCookie: [],
            }),
          );
    await inTenant(schema, (trx) =>
      trx
        .insertInto("idempotency_keys")
        .values({
          id,
          scope: `test:key_${randomBytes(4).toString("hex")}:checkout.complete`,
          key: randomBytes(8).toString("hex"),
          request_method: "POST",
          request_path: "/v1/checkouts/chk_x/completion",
          request_hash: randomBytes(32).toString("hex"),
          status: "completed",
          response_status: 201,
          response_ciphertext: ciphertext,
          encryption_key_id: version === null ? null : `local:${version}`,
          expires_at: fromNow(DAY_MS),
        })
        .execute(),
    );
  }
}

/** Every row of the six tables of `schema`, every column, as velexis_ota_app reads them. */
async function rowsOf(schema: Schema): Promise<Record<string, JsonObject[]>> {
  return await inTenant(schema, async (trx) => {
    const tables: Record<string, JsonObject[]> = {};
    for (const { table } of REWRAP_SOURCES) {
      const { rows } = await sql<JsonObject>`SELECT * FROM ${sql.table(table)} ORDER BY id`.execute(trx);
      tables[table] = rows;
    }
    return tables;
  });
}

/** A row's ciphertext columns and `encryption_key_id` left out: what the re-wrap must not change. */
function withoutRewrapped(tables: Record<string, JsonObject[]>): Record<string, JsonObject[]> {
  return Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [
      table,
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([column]) => !column.endsWith("_ciphertext") && column !== "encryption_key_id",
          ),
        ),
      ),
    ]),
  );
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Everything every run printed, stdout and stderr (the log lines at `debug`), for the leak checks. */
const printed: string[] = [];

/** One run of the command through dist/cli.js's entry, with the variables of ota-backend.env and MASTER_KEY_CURRENT v2. */
async function rewrap(...args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["secrets:rewrap", ...args], {
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "debug",
      DATABASE_URL: db.urlFor("ota"),
      MASTER_KEY_DIR: keyDir,
      MASTER_KEY_CURRENT: "local:v2",
    },
  });
  const run = { code, stdout: out.join(""), stderr: err.join("") };
  printed.push(run.stdout, run.stderr);
  return run;
}

/** The report line of one table, as the command prints it. */
const line = (schema: Schema, table: string, counts: string): string =>
  `secrets:rewrap: ${schema}.${table}: ${counts}`;

/** The rows under v1 that the seed wrote per table (the same in both schemas). */
const SEEDED_V1: Readonly<Record<string, number>> = {
  saved_travelers: 1,
  saved_traveler_documents: 2,
  checkout_travelers: 2,
  booking_travelers: 1,
  notifications: 1,
  idempotency_keys: 1,
};

/** A key folder with copies of the given key files (mode 0700, files 0600 as `pnpm dev:keys` writes them). */
async function keyFolder(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-ota-rewrap-int-"));
  keyFolders.push(dir);
  await chmod(dir, 0o700);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
    await chmod(join(dir, name), 0o600);
  }
  return dir;
}

beforeAll(async () => {
  db = await createTestDatabase();
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-rewrap",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  catalog = createPlatformDb<PlatformDatabase>(otaPool);
  keyDir = await keyFolder({
    "master-v1.key": `${randomBytes(32).toString("base64")}\n`,
    "master-v2.key": `${randomBytes(32).toString("base64")}\n`,
  });
  const v2OnlyDir = await keyFolder({});
  await copyFile(join(keyDir, "master-v2.key"), join(v2OnlyDir, "master-v2.key"));
  await chmod(join(v2OnlyDir, "master-v2.key"), 0o600);
  [v1, v2, v2Only] = await Promise.all([
    LocalFileKeyProvider.fromDir(keyDir, "local:v1"),
    LocalFileKeyProvider.fromDir(keyDir, "local:v2"),
    LocalFileKeyProvider.fromDir(v2OnlyDir, "local:v2"),
  ]);
  await seedTenant("tenant_alpha");
  await seedTenant("tenant_beta");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await otaPool?.end();
  await db?.drop();
  await Promise.all(keyFolders.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("secrets:rewrap over every ciphertext column set of two tenants (OBE-100)", () => {
  let seeded: { alpha: Record<string, JsonObject[]>; beta: Record<string, JsonObject[]> };
  let dryRun: Run;
  let afterDryRun: typeof seeded;
  let alphaRun: Run;
  let afterAlpha: typeof seeded;
  let allRun: Run;
  let afterEverySchema: typeof seeded;
  let secondRun: Run;
  let afterSecond: typeof seeded;

  const snapshot = async () => ({ alpha: await rowsOf("tenant_alpha"), beta: await rowsOf("tenant_beta") });

  beforeAll(async () => {
    seeded = await snapshot();
    dryRun = await rewrap("--dry-run");
    afterDryRun = await snapshot();
    alphaRun = await rewrap("--tenant", "alpha", "--batch-size", "1");
    afterAlpha = await snapshot();
    allRun = await rewrap();
    afterEverySchema = await snapshot();
    secondRun = await rewrap("--all");
    afterSecond = await snapshot();
  }, SETUP_TIMEOUT_MS);

  it("[OBE-100 AC1] covers every ciphertext column of the tenant schema, booking_documents' key id alone left out", async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'tenant_alpha' AND (column_name LIKE '%\\_ciphertext' OR column_name = 'encryption_key_id')
      ORDER BY table_name, column_name
    `.execute(catalog);
    const ciphertexts = rows.filter((row) => row.column_name !== "encryption_key_id");
    expect(ciphertexts.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual(
      REWRAP_SOURCES.flatMap((source) => source.columns.map((column) => `${source.table}.${column}`)).sort(),
    );
    const keyIds = rows.filter((row) => row.column_name === "encryption_key_id").map((row) => row.table_name);
    expect(keyIds.sort()).toEqual(
      [...REWRAP_SOURCES.map((source) => source.table), "booking_documents"].sort(),
    );
  });

  it("[OBE-100 AC1] --dry-run reports the counts and what would move, and writes nothing", () => {
    expect([dryRun.code, dryRun.stderr.includes('"level":"error"')]).toEqual([REWRAP_EXIT.remains, false]);
    expect(afterDryRun).toEqual(seeded);
    expect(dryRun.stdout).toContain(
      "secrets:rewrap: current KEK local:v2 (loaded: local:v1, local:v2); 2 tenant schema(s); dry run: nothing is written.\n",
    );
    for (const schema of ["tenant_alpha", "tenant_beta"] as const) {
      for (const [table, rows] of Object.entries(SEEDED_V1)) {
        expect(dryRun.stdout).toContain(
          `${line(schema, table, `dry run: would re-wrap ${rows}, would fail 0; remainingByKekId before {"local:v1":${rows}}`)}\n`,
        );
      }
    }
    expect(dryRun.stdout).toContain(
      'secrets:rewrap: total of 2 tenant schema(s), 12 table(s): dry run: would re-wrap 16, would fail 0; remainingByKekId before {"local:v1":16}\n' +
        "secrets:rewrap: dry run: nothing was written; 16 row(s) would move to local:v2 and 0 would fail.\n",
    );
  });

  it("[OBE-100 AC1] --tenant moves every value of one schema to the current KEK and leaves the other schema alone", () => {
    expect([alphaRun.code, alphaRun.stderr.includes('"level":"error"')]).toEqual([REWRAP_EXIT.done, false]);
    expect(afterAlpha.beta).toEqual(seeded.beta);
    expect(alphaRun.stdout).not.toContain("tenant_beta");
    for (const [table, rows] of Object.entries(SEEDED_V1)) {
      expect(alphaRun.stdout).toContain(
        `${line("tenant_alpha", table, `rewrapped ${rows}, skipped 0, failed 0; remainingByKekId before {"local:v1":${rows}} after {}`)}\n`,
      );
    }
    expect(alphaRun.stdout).toContain(
      "secrets:rewrap: total of 1 tenant schema(s), 6 table(s): rewrapped 8, skipped 0, failed 0; " +
        'remainingByKekId before {"local:v1":8} after {}\n' +
        "secrets:rewrap: nothing is left under an old KEK: every value is under local:v2.\n",
    );
    // Only the ciphertexts and their key id changed: no other column, not `version`, not `updated_at`.
    expect(withoutRewrapped(afterAlpha.alpha)).toEqual(withoutRewrapped(seeded.alpha));
  });

  it("[OBE-100 AC1] moves every tenant schema by default, and a second run changes nothing (idempotent)", () => {
    expect(allRun.code).toBe(REWRAP_EXIT.done);
    for (const [table, rows] of Object.entries(SEEDED_V1)) {
      expect(allRun.stdout).toContain(
        `${line("tenant_beta", table, `rewrapped ${rows}, skipped 0, failed 0; remainingByKekId before {"local:v1":${rows}} after {}`)}\n`,
      );
      expect(allRun.stdout).toContain(
        `${line("tenant_alpha", table, "rewrapped 0, skipped 0, failed 0; remainingByKekId before {} after {}")}\n`,
      );
    }
    expect(afterEverySchema.alpha).toEqual(afterAlpha.alpha);
    expect(withoutRewrapped(afterEverySchema.beta)).toEqual(withoutRewrapped(seeded.beta));

    expect([secondRun.code, secondRun.stderr.includes('"level":"error"')]).toEqual([REWRAP_EXIT.done, false]);
    expect(afterSecond).toEqual(afterEverySchema);
    for (const schema of ["tenant_alpha", "tenant_beta"] as const) {
      for (const table of Object.keys(SEEDED_V1)) {
        expect(secondRun.stdout).toContain(
          `${line(schema, table, "rewrapped 0, skipped 0, failed 0; remainingByKekId before {} after {}")}\n`,
        );
      }
    }
    expect(secondRun.stdout).toContain(
      "secrets:rewrap: total of 2 tenant schema(s), 12 table(s): rewrapped 0, skipped 0, failed 0; remainingByKekId before {} after {}\n" +
        "secrets:rewrap: nothing is left under an old KEK: every value is under local:v2.\n",
    );
  });

  it("[OBE-100 AC1] leaves every value under the current KEK, decrypting at its place without the old key", async () => {
    for (const value of sealed) {
      const row = (value.schema === "tenant_alpha" ? afterSecond.alpha : afterSecond.beta)[value.table]?.find(
        (candidate) => candidate["id"] === value.id,
      );
      const stored = row?.[value.column];
      expect([value.table, value.column, Buffer.isBuffer(stored)]).toEqual([value.table, value.column, true]);
      const ciphertext = stored as Buffer;
      expect([value.table, row?.["encryption_key_id"], envelopeKekId(ciphertext)]).toEqual([
        value.table,
        "local:v2",
        "local:v2",
      ]);
      const plaintext = await decryptValue(ciphertext, {
        aad: aadFor(value.schema, value.table, value.column, value.id),
        keys: v2Only,
      });
      expect(plaintext.toString("utf8")).toBe(value.plaintext);
    }
    // The purged notification has no value to move: its key id stays as it was.
    for (const tables of [afterSecond.alpha, afterSecond.beta]) {
      const purged =
        tables["notifications"]?.filter((row) => row["secret_payload_ciphertext"] === null) ?? [];
      expect(purged.map((row) => row["encryption_key_id"])).toEqual(["local:v1"]);
    }
  });
});

describe("secrets:rewrap with a corrupted value, a concurrent change and an unknown tenant (OBE-100)", () => {
  let corruptedRun: Run;
  let unknown: Run;
  let corruptedRows: JsonObject[];
  let unrecordedId: string;
  let unrecorded: JsonObject | undefined;
  let before: JsonObject[];
  let concurrent: Awaited<ReturnType<typeof rewrapSource>>;
  /** What the other writer wrote to each row, by row id: a new value and its key id, or the key id alone. */
  const otherWriter = new Map<string, { readonly value: Buffer | undefined; readonly kekId: string }>();
  /** The ciphertext each of those rows held before the other writer came. */
  const seededValue = new Map<string, Buffer>();
  let afterConcurrent: JsonObject[];

  beforeAll(async () => {
    // Two notifications under v1: one intact, one holding a copy of the other's ciphertext (it fails at its own place),
    // and an idempotency record whose ciphertext lost a byte's worth of integrity.
    const [intact, copied, damaged] = [rowId("ntf"), rowId("ntf"), rowId("idk")];
    const intactValue = await seal(
      v1,
      { schema: "tenant_alpha", table: "notifications", column: "secret_payload_ciphertext", id: intact },
      JSON.stringify({ token: marker("TOKEN") }),
    );
    const damagedValue = Buffer.from(
      await seal(
        v1,
        { schema: "tenant_alpha", table: "idempotency_keys", column: "response_ciphertext", id: damaged },
        JSON.stringify({ v: 1, empty: true, body: null, setCookie: [] }),
      ),
    );
    const last = damagedValue.length - 1;
    damagedValue.writeUInt8(damagedValue.readUInt8(last) ^ 0x80, last);
    await inTenant("tenant_alpha", async (trx) => {
      for (const [id, value] of [
        [intact, intactValue],
        [copied, intactValue],
      ] as const) {
        await trx
          .insertInto("notifications")
          .values({
            id,
            template_key: "customer.verify_email",
            channel: "email",
            recipient: "a***@example.com",
            recipient_type: "customer",
            secret_payload_ciphertext: value,
            encryption_key_id: "local:v1",
            next_attempt_at: fromNow(365 * DAY_MS),
          })
          .execute();
      }
      await trx
        .insertInto("idempotency_keys")
        .values({
          id: damaged,
          scope: "test:key_x:checkout.complete",
          key: randomBytes(8).toString("hex"),
          request_method: "POST",
          request_path: "/v1/checkouts/chk_x/completion",
          request_hash: randomBytes(32).toString("hex"),
          response_ciphertext: damagedValue,
          encryption_key_id: "local:v1",
          expires_at: fromNow(DAY_MS),
        })
        .execute();
    });
    // A saved traveller whose discount entries were sealed under v1 but whose row names no key id (the one table without
    // a CHECK against it): reported as `(none)`, and the re-wrap sets the column.
    unrecordedId = rowId("trv");
    const customerId = (await rowsOf("tenant_alpha"))["saved_travelers"]?.[0]?.["customer_id"] as string;
    const unrecordedValue = await seal(
      v1,
      {
        schema: "tenant_alpha",
        table: "saved_travelers",
        column: "discount_eligibility_ciphertext",
        id: unrecordedId,
      },
      discountsJson(),
    );
    await inTenant("tenant_alpha", (trx) =>
      trx
        .insertInto("saved_travelers")
        .values({
          id: unrecordedId,
          customer_id: customerId,
          first_name: "TESTA",
          last_name: "SAMPLE",
          discount_eligibility_ciphertext: unrecordedValue,
          encryption_key_id: null,
        })
        .execute(),
    );
    const failedIds = [copied, damaged];
    const pick = async () => {
      const tables = await rowsOf("tenant_alpha");
      return [...(tables["notifications"] ?? []), ...(tables["idempotency_keys"] ?? [])].filter((row) =>
        failedIds.includes(row["id"] as string),
      );
    };
    before = await pick();
    corruptedRun = await rewrap("--tenant=alpha");
    corruptedRows = await pick();
    unrecorded = (await rowsOf("tenant_alpha"))["saved_travelers"]?.find((row) => row["id"] === unrecordedId);

    // Three checkout travellers under v1 that another writer changes between the re-wrap's read and its write: one gets
    // a new value under the current KEK, as the current code writes it; one a new value under the old KEK (a process
    // that has not restarted on the new key yet), which only the check on the old ciphertext can tell; and one keeps
    // its ciphertext while its key id alone changes (no writer does that today), which only the check on the old
    // `encryption_key_id` can tell.
    const checkoutId = (await rowsOf("tenant_alpha"))["checkout_travelers"]?.[0]?.["checkout_id"] as string;
    for (const [version, keys] of [
      ["local:v2", v2],
      ["local:v1", v1],
      ["local:v3", undefined],
    ] as const) {
      const id = rowId("ctr");
      const place = {
        schema: "tenant_alpha",
        table: "checkout_travelers",
        column: "documents_ciphertext",
        id,
      } as const;
      const old = await seal(v1, place, documentsJson());
      await inTenant("tenant_alpha", (trx) =>
        trx
          .insertInto("checkout_travelers")
          .values({
            id,
            checkout_id: checkoutId,
            amadeus_traveler_id: String(otherWriter.size + 8),
            traveler_type: "ADULT",
            documents_ciphertext: old,
            encryption_key_id: "local:v1",
          })
          .execute(),
      );
      seededValue.set(id, old);
      otherWriter.set(id, {
        value: keys === undefined ? undefined : await seal(keys, place, documentsJson()),
        kekId: version,
      });
    }
    const repository = new RewrapRepository(tenantDb);
    const racing: RewrapStore = {
      fetch: (schema, source, page) => repository.fetch(schema, source, page),
      countNotUnder: (schema, source, current) => repository.countNotUnder(schema, source, current),
      update: async (schema, source, change) => {
        const written = otherWriter.get(change.id);
        if (written !== undefined) {
          await inTenant("tenant_alpha", (trx) =>
            trx
              .updateTable("checkout_travelers")
              .set({
                ...(written.value === undefined ? {} : { documents_ciphertext: written.value }),
                encryption_key_id: written.kekId,
              })
              .where("id", "=", change.id)
              .execute(),
          );
        }
        return await repository.update(schema, source, change);
      },
    };
    const source = REWRAP_SOURCES.find((candidate) => candidate.table === "checkout_travelers");
    if (source === undefined) {
      throw new Error("no checkout_travelers source");
    }
    concurrent = await rewrapSource({
      store: racing,
      schema: "tenant_alpha" as TenantSchema,
      source,
      keys: v2,
      batchSize: 500,
      dryRun: false,
    });
    afterConcurrent = ((await rowsOf("tenant_alpha"))["checkout_travelers"] ?? []).filter((row) =>
      otherWriter.has(row["id"] as string),
    );

    unknown = await rewrap("--tenant", "gamma");
  }, SETUP_TIMEOUT_MS);

  it("[OBE-100 AC1] counts a value that does not authenticate at its place as failed and leaves it under the old KEK", () => {
    expect(corruptedRun.code).toBe(REWRAP_EXIT.remains);
    expect(corruptedRows).toEqual(before);
    expect(corruptedRun.stdout).toContain(
      `${line("tenant_alpha", "notifications", 'rewrapped 1, skipped 0, failed 1; remainingByKekId before {"local:v1":2} after {"local:v1":1}')}\n`,
    );
    expect(corruptedRun.stdout).toContain(
      `${line("tenant_alpha", "idempotency_keys", 'rewrapped 0, skipped 0, failed 1; remainingByKekId before {"local:v1":1} after {"local:v1":1}')}\n`,
    );
    expect(corruptedRun.stdout).toContain(
      "secrets:rewrap: 2 row(s) remain under an old KEK (2 failed, 0 skipped): keep the old key (master-key-rotation.md step 5).\n",
    );
  });

  it("[OBE-100 AC1] moves a value whose row names no key id and records the key id", async () => {
    expect(corruptedRun.stdout).toContain(
      `${line("tenant_alpha", "saved_travelers", 'rewrapped 1, skipped 0, failed 0; remainingByKekId before {"(none)":1} after {}')}\n`,
    );
    expect(unrecorded?.["encryption_key_id"]).toBe("local:v2");
    const ciphertext = unrecorded?.["discount_eligibility_ciphertext"] as Buffer;
    expect(envelopeKekId(ciphertext)).toBe("local:v2");
    const aad = aadFor("tenant_alpha", "saved_travelers", "discount_eligibility_ciphertext", unrecordedId);
    await expect(decryptValue(ciphertext, { aad, keys: v2Only })).resolves.toBeInstanceOf(Buffer);
  });

  it("[OBE-100 AC1] skips a row changed between the read and the write and keeps the other writer's value", () => {
    // The rows the other writer left under another KEK id still count as remaining: the next run (step 7) takes them.
    expect(concurrent).toEqual({
      kind: "rewrapped",
      schema: "tenant_alpha",
      table: "checkout_travelers",
      before: { "local:v1": 3 },
      rewrapped: 0,
      skipped: 3,
      failed: 0,
      after: { "local:v1": 1, "local:v3": 1 },
    });
    expect(afterConcurrent).toHaveLength(3);
    for (const row of afterConcurrent) {
      const id = row["id"] as string;
      const written = otherWriter.get(id);
      expect([row["documents_ciphertext"], row["encryption_key_id"]]).toEqual([
        written?.value ?? seededValue.get(id),
        written?.kekId,
      ]);
    }
  });

  it("[OBE-100 AC1] refuses a tenant without a schema with exit code 2, re-wrapping nothing", () => {
    expect(unknown.code).toBe(REWRAP_EXIT.usage);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain(
      "secrets:rewrap: no tenant schema tenant_gamma exists; nothing was re-wrapped.\n",
    );
  });
});

describe("secrets:rewrap past a table that stops, and the run that continues (OBE-100)", () => {
  let stoppedRun: Run;
  let stoppedRows: Record<string, JsonObject[]>;
  let resumedRun: Run;
  let resumedRows: Record<string, JsonObject[]>;
  const pendingIds = { notification: "", record: "" };

  beforeAll(async () => {
    // tenant_beta again holds a notification and an idempotency record under v1 (the runs above moved the rest).
    pendingIds.notification = rowId("ntf");
    pendingIds.record = rowId("idk");
    const secret = await seal(
      v1,
      {
        schema: "tenant_beta",
        table: "notifications",
        column: "secret_payload_ciphertext",
        id: pendingIds.notification,
      },
      JSON.stringify({ token: marker("TOKEN") }),
    );
    const answer = await seal(
      v1,
      {
        schema: "tenant_beta",
        table: "idempotency_keys",
        column: "response_ciphertext",
        id: pendingIds.record,
      },
      JSON.stringify({ v: 1, empty: false, body: { bookingToken: marker("BOOKINGTOKEN") }, setCookie: [] }),
    );
    await inTenant("tenant_beta", async (trx) => {
      await trx
        .insertInto("notifications")
        .values({
          id: pendingIds.notification,
          template_key: "customer.verify_email",
          channel: "email",
          recipient: "a***@example.com",
          recipient_type: "customer",
          secret_payload_ciphertext: secret,
          encryption_key_id: "local:v1",
          next_attempt_at: fromNow(365 * DAY_MS),
        })
        .execute();
      await trx
        .insertInto("idempotency_keys")
        .values({
          id: pendingIds.record,
          scope: "test:key_y:checkout.complete",
          key: randomBytes(8).toString("hex"),
          request_method: "POST",
          request_path: "/v1/checkouts/chk_y/completion",
          request_hash: randomBytes(32).toString("hex"),
          status: "completed",
          response_status: 201,
          response_ciphertext: answer,
          encryption_key_id: "local:v1",
          expires_at: fromNow(DAY_MS),
        })
        .execute();
    });
    // velexis_ota_app loses UPDATE on tenant_beta.idempotency_keys (the schema owner revokes it), so that table's first
    // write fails with a real PostgreSQL error; the privilege comes back before the second run.
    const owner = createPool(db.urlFor("provisioner"), {
      applicationName: "ota-test-rewrap-owner",
      logger: { error: () => undefined },
      max: 1,
    });
    try {
      await owner.query("REVOKE UPDATE ON tenant_beta.idempotency_keys FROM velexis_ota_app");
      try {
        stoppedRun = await rewrap("--tenant", "beta");
        stoppedRows = await rowsOf("tenant_beta");
      } finally {
        await owner.query("GRANT UPDATE ON tenant_beta.idempotency_keys TO velexis_ota_app");
      }
    } finally {
      await owner.end();
    }
    resumedRun = await rewrap("--tenant", "beta");
    resumedRows = await rowsOf("tenant_beta");
  }, SETUP_TIMEOUT_MS);

  const keyIdOf = (rows: Record<string, JsonObject[]>, table: string, id: string): unknown =>
    rows[table]?.find((row) => row["id"] === id)?.["encryption_key_id"];

  it("[OBE-100 AC1] goes on past a table that stops, names the error by its class and code only, and exits 1", () => {
    expect(stoppedRun.code).toBe(REWRAP_EXIT.remains);
    expect(stoppedRun.stdout).toContain(
      `${line("tenant_beta", "notifications", 'rewrapped 1, skipped 0, failed 0; remainingByKekId before {"local:v1":1} after {}')}\n`,
    );
    expect(stoppedRun.stdout).toContain(
      `${line("tenant_beta", "idempotency_keys", "stopped (DatabaseError 42501); run the command again: it continues with what is left")}\n`,
    );
    expect(stoppedRun.stdout).toContain(
      "secrets:rewrap: total of 1 tenant schema(s), 6 table(s): rewrapped 1, skipped 0, failed 0; " +
        'remainingByKekId before {"local:v1":1} after {}\n' +
        "secrets:rewrap: 1 table(s) stopped before the end: run the command again.\n" +
        "secrets:rewrap: nothing is left under an old KEK in the tables that ran to the end.\n",
    );
    expect(stoppedRun.stderr).toContain('"msg":"secrets.rewrap.stopped"');
    expect(stoppedRun.stderr).toContain('"err":"DatabaseError 42501"');
    // PostgreSQL's message is never printed.
    expect(`${stoppedRun.stdout}${stoppedRun.stderr}`).not.toMatch(/permission denied/i);
    // The row written before the stop stays written; the stopped table's row stays as it was.
    expect([
      keyIdOf(stoppedRows, "notifications", pendingIds.notification),
      keyIdOf(stoppedRows, "idempotency_keys", pendingIds.record),
    ]).toEqual(["local:v2", "local:v1"]);
  });

  it("[OBE-100 AC1] continues with what is left on the next run", () => {
    expect(resumedRun.code).toBe(REWRAP_EXIT.done);
    expect(resumedRun.stdout).toContain(
      `${line("tenant_beta", "idempotency_keys", 'rewrapped 1, skipped 0, failed 0; remainingByKekId before {"local:v1":1} after {}')}\n`,
    );
    expect(resumedRun.stdout).toContain(
      `${line("tenant_beta", "notifications", "rewrapped 0, skipped 0, failed 0; remainingByKekId before {} after {}")}\n`,
    );
    expect(keyIdOf(resumedRows, "idempotency_keys", pendingIds.record)).toBe("local:v2");
  });
});

describe("the output of every run above (OBE-100)", () => {
  let finalRows: { alpha: Record<string, JsonObject[]>; beta: Record<string, JsonObject[]> };

  beforeAll(async () => {
    finalRows = { alpha: await rowsOf("tenant_alpha"), beta: await rowsOf("tenant_beta") };
  }, SETUP_TIMEOUT_MS);

  it("[OBE-100 AC2] prints and logs counts and KEK ids only: no plaintext, ciphertext or row id", () => {
    const text = printed.join("\n");
    // The log lines were captured (LOG_LEVEL=debug): one per page and one per table.
    expect(text).toContain('"msg":"secrets.rewrap.batch"');
    expect(text).toContain('"msg":"secrets.rewrap.done"');
    const finals = [finalRows.alpha, finalRows.beta].flatMap((tables) =>
      Object.values(tables).flatMap((rows) =>
        rows.flatMap((row) => Object.values(row).filter((value): value is Buffer => Buffer.isBuffer(value))),
      ),
    );
    for (const ciphertext of [...sealed.map((value) => value.ciphertext), ...finals]) {
      for (const shown of [
        ciphertext.toString("hex"),
        ciphertext.toString("base64"),
        ciphertext.subarray(-24).toString("base64"),
      ]) {
        expect(text.includes(shown)).toBe(false);
      }
    }
    for (const value of sealed) {
      expect(text.includes(value.plaintext)).toBe(false);
      for (const found of value.plaintext.match(/[A-Z]+-[0-9A-F]{12}/g) ?? []) {
        expect(text.includes(found)).toBe(false);
      }
    }
    for (const id of rowIds) {
      expect(text.includes(id)).toBe(false);
    }
  });
});
