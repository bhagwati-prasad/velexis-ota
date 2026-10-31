// `tenants:scrub-card-copies` (FIX-W30-OTA, lead decision (1) of 2026-10-26; payments/airline-card/card-copies-scrub.ts
// and scrub-card-copies.command.ts) against PostgreSQL 16: the one-off job, per tenant, that drops the card holder and
// expiry from the copies stored before FIX-W29-SECURITY (`bookings.form_of_payments`, `bookings.order_snapshot`,
// `supplier_requests.request_body` and `response_body`), run through dist/cli.js's entry (`runCli`) as velexis_ota_app
// with the variables of ota-backend.env.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned), writes their platform rows
// as the platform does (as velexis_migrator), and seeds rows as the code of before 2026-10-24 wrote them for an
// airline-card booking: its forms of payment and order with the card's brand, holder, last 4 and expiry, the Amadeus
// calls' bodies (Flight Create Orders, an order read, an answer cut to its preview), next to rows written since (the
// card already brand and last 4) and rows without a card. The holder and the expiry are made up; the card number is
// the last 4 of Stripe's documented test card. Batches of 2 rows make every table take several batches.
import { randomBytes } from "node:crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDatabase,
  type TenantDb,
  type Transaction,
} from "@velexis/db";
import { redactPayload } from "@velexis/logger";
import { createTestDatabase, type TestDatabase } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { runCli } from "../../../src/cli";
import { newId } from "../../../src/common/ids";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";

type JsonObject = Record<string, unknown>;
type Schema = "tenant_alpha" | "tenant_beta";

/**
 * Cloning the template and seeding the rows take a few seconds on a loaded CI runner, and each run of the command
 * opens its own pool: the scenarios run in their hooks with this budget, the tests only read what they left.
 */
const SETUP_TIMEOUT_MS = 90_000;

const HOLDER = `ANNA ${randomBytes(3).toString("hex").toUpperCase()}`;
const EXPIRY = "2031-07";
const DOCUMENT_EXPIRY = "2032-04-14";

let db: TestDatabase;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;

const inTenant = <T>(schema: Schema, run: (trx: Transaction<TenantDatabase>) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, schema, run);

/** The airline card as a copy of before 2026-10-24 kept it, and as one written since keeps it. */
const oldCard = { brand: "VISA", holder: HOLDER, number: "4242", expiryDate: EXPIRY, flightOfferIds: ["1"] };
const newCard = { brand: "VISA", number: "4242", flightOfferIds: ["1"] };

/** An Amadeus order with a traveller's passport (its expiry stays) and `card` as its form of payment. */
function order(card: JsonObject): JsonObject {
  return {
    type: "flight-order",
    id: `eJzT${randomBytes(8).toString("hex")}`,
    associatedRecords: [{ reference: "MN6T2W", originSystemCode: "GDS", flightOfferId: "1" }],
    travelers: [
      {
        id: "1",
        name: { firstName: "TESTA", lastName: "SAMPLE" },
        documents: [{ documentType: "PASSPORT", number: "7731", expiryDate: DOCUMENT_EXPIRY, holder: true }],
        contact: { phones: [{ deviceType: "MOBILE", countryCallingCode: "1", number: "******0143" }] },
      },
    ],
    formOfPayments: [{ creditCard: card }],
  };
}

async function insertTenant(key: "alpha" | "beta"): Promise<void> {
  await migrator
    .insertInto("platform.tenants")
    .values({ id: newId("ten"), key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
}

/** A booking of an airline-card order, its copies `formOfPayments` and `snapshot` as stored. */
async function insertBooking(
  schema: Schema,
  copies: { readonly formOfPayments: unknown; readonly snapshot: unknown },
): Promise<string> {
  const id = newId("bkg");
  const departure = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  await inTenant(schema, (trx) =>
    trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: newBookingReference(),
        channel: "storefront",
        status: "ticketed",
        ticketing_status: "issued",
        amadeus_order_id: `eJzT${randomBytes(8).toString("hex")}`,
        record_locator: randomBytes(3).toString("hex").toUpperCase(),
        origin_system_code: "GDS",
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 2 * 60 * 60_000),
        validating_carrier: "IB",
        travelers_count: 1,
        currency: "EUR",
        pricing_mode: "net",
        net_amount: "98.47",
        net_base_amount: "56.00",
        net_fees_amount: "0.00",
        net_services_amount: "0.00",
        markup_amount: "0.00",
        fees_amount: "0.00",
        taxes_amount: "42.47",
        total_amount: "98.47",
        contact_email: "a***@example.com",
        lead_last_name: "SAMPLE",
        form_of_payments: JSON.stringify(copies.formOfPayments),
        order_snapshot: JSON.stringify(copies.snapshot),
        version: 3,
        created_at: new Date(Date.now() - 3 * 24 * 60 * 60_000),
        updated_at: new Date(Date.now() - 2 * 24 * 60 * 60_000),
      })
      .execute(),
  );
  return id;
}

/** A `supplier_requests` row with these bodies, as the Amadeus client wrote it. */
async function insertSupplierRequest(
  schema: Schema,
  call: {
    readonly operation: string;
    readonly api: "FlightCreateOrders" | "FlightOrderManagement" | "FlightOffersSearch";
    readonly method: "GET" | "POST";
    readonly requestBody: unknown;
    readonly responseBody: unknown;
    readonly truncated?: boolean;
    readonly bookingId?: string;
  },
): Promise<string> {
  const id = newId("sreq");
  await inTenant(schema, (trx) =>
    trx
      .insertInto("supplier_requests")
      .values({
        id,
        environment: "test",
        operation: call.operation,
        amadeus_api: call.api,
        amadeus_operation_id: call.method === "GET" ? "getFlightOrder" : "createFlightOrders",
        http_method: call.method,
        path: "/v1/booking/flight-orders",
        http_status: 201,
        outcome: "success",
        duration_ms: 812,
        request_body: call.requestBody === null ? null : JSON.stringify(call.requestBody),
        response_body: call.responseBody === null ? null : JSON.stringify(call.responseBody),
        truncated: call.truncated === true,
        booking_id: call.bookingId ?? null,
        created_at: new Date(Date.now() - 2 * 24 * 60 * 60_000),
        updated_at: new Date(Date.now() - 2 * 24 * 60 * 60_000),
      })
      .execute(),
  );
  return id;
}

/** Every row of the two tables of `schema`, every column, as velexis_ota_app reads them. */
async function rowsOf(schema: Schema): Promise<{ bookings: JsonObject[]; supplierRequests: JsonObject[] }> {
  return await inTenant(schema, async (trx) => ({
    bookings: (await trx.selectFrom("bookings").selectAll().orderBy("id").execute()) as JsonObject[],
    supplierRequests: (await trx
      .selectFrom("supplier_requests")
      .selectAll()
      .orderBy("id")
      .execute()) as JsonObject[],
  }));
}

/** The text of every column of the two tables of `schema`, as a dump of them would show it. */
async function tablesText(schema: Schema): Promise<string> {
  return await inTenant(schema, async (trx) => {
    const { rows } = await sql<{ text: string }>`
      SELECT coalesce((SELECT json_agg(b)::text FROM bookings b), '') ||
             coalesce((SELECT json_agg(s)::text FROM supplier_requests s), '') AS text
    `.execute(trx);
    return rows[0]?.text ?? "";
  });
}

/** One run of the command through dist/cli.js's entry, with the variables of ota-backend.env. */
async function scrub(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["tenants:scrub-card-copies", ...args], {
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    env: { APP_ENV: "test", LOG_LEVEL: "error", DATABASE_URL: db.urlFor("ota") },
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** The row of `rows` with this id. */
const byId = (rows: readonly JsonObject[], id: string): JsonObject => {
  const row = rows.find((candidate) => candidate["id"] === id);
  if (row === undefined) {
    throw new Error(`no row ${id}`);
  }
  return row;
};

/** A row without the columns the scrub may change. */
const without = (row: JsonObject, columns: readonly string[]): JsonObject =>
  Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)));

beforeAll(async () => {
  db = await createTestDatabase();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-scrub",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  await insertTenant("alpha");
  await insertTenant("beta");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

describe("tenants:scrub-card-copies --tenant (FIX-W30-OTA)", () => {
  const ids: Record<string, string> = {};
  let before: Awaited<ReturnType<typeof rowsOf>>;
  let after: Awaited<ReturnType<typeof rowsOf>>;
  let again: Awaited<ReturnType<typeof rowsOf>>;
  let beta: { before: Awaited<ReturnType<typeof rowsOf>>; after: Awaited<ReturnType<typeof rowsOf>> };
  let first: Awaited<ReturnType<typeof scrub>>;
  let second: Awaited<ReturnType<typeof scrub>>;
  let afterText: string;
  /** The JSON text whose first part the truncated answer stored as its preview. */
  let truncatedText: string;

  beforeAll(async () => {
    // Before 2026-10-24: the booking's copies and its Amadeus calls kept the card's holder and expiry.
    const oldOrder = order(oldCard);
    ids["oldBooking"] = await insertBooking("tenant_alpha", {
      formOfPayments: [{ creditCard: oldCard }],
      snapshot: oldOrder,
    });
    ids["createOrders"] = await insertSupplierRequest("tenant_alpha", {
      operation: "checkout.completeWithAirlineCard",
      api: "FlightCreateOrders",
      method: "POST",
      requestBody: { data: { ...oldOrder, id: undefined, formOfPayments: [{ creditCard: oldCard }] } },
      responseBody: { data: oldOrder, dictionaries: { locations: { MAD: { cityCode: "MAD" } } } },
      bookingId: ids["oldBooking"],
    });
    ids["orderRead"] = await insertSupplierRequest("tenant_alpha", {
      operation: "bookings.get",
      api: "FlightOrderManagement",
      method: "GET",
      requestBody: null,
      responseBody: { data: oldOrder },
      bookingId: ids["oldBooking"],
    });
    const text = JSON.stringify({ data: oldOrder });
    truncatedText = text;
    ids["truncated"] = await insertSupplierRequest("tenant_alpha", {
      operation: "bookings.get",
      api: "FlightOrderManagement",
      method: "GET",
      requestBody: null,
      responseBody: { truncated: true, bytes: 70_211, preview: text.slice(0, text.indexOf(HOLDER) + 6) },
      truncated: true,
    });
    // Since 2026-10-24: brand and last 4 only; and rows without a card at all.
    const newOrder = redactPayload(order(newCard));
    ids["newBooking"] = await insertBooking("tenant_alpha", {
      formOfPayments: [{ creditCard: newCard }],
      snapshot: newOrder,
    });
    ids["stripeBooking"] = await insertBooking("tenant_alpha", {
      formOfPayments: [{ other: { method: "ACCOUNT", flightOfferIds: ["1"] } }],
      snapshot: { ...newOrder, formOfPayments: [{ other: { method: "ACCOUNT", flightOfferIds: ["1"] } }] },
    });
    ids["newCall"] = await insertSupplierRequest("tenant_alpha", {
      operation: "checkout.completeWithAirlineCard",
      api: "FlightCreateOrders",
      method: "POST",
      requestBody: { data: newOrder },
      responseBody: { data: newOrder },
      bookingId: ids["newBooking"],
    });
    ids["search"] = await insertSupplierRequest("tenant_alpha", {
      operation: "flights.search",
      api: "FlightOffersSearch",
      method: "POST",
      requestBody: { originDestinations: [{ id: "1", originLocationCode: "MAD" }] },
      responseBody: { meta: { count: 0 }, data: [] },
    });
    // Another OTA's copy of before: `--tenant alpha` leaves it alone.
    ids["betaBooking"] = await insertBooking("tenant_beta", {
      formOfPayments: [{ creditCard: oldCard }],
      snapshot: order(oldCard),
    });

    before = await rowsOf("tenant_alpha");
    const betaBefore = await rowsOf("tenant_beta");
    first = await scrub("--tenant", "alpha", "--batch-size", "2");
    after = await rowsOf("tenant_alpha");
    afterText = await tablesText("tenant_alpha");
    second = await scrub("--tenant=alpha", "--batch-size", "2");
    again = await rowsOf("tenant_alpha");
    beta = { before: betaBefore, after: await rowsOf("tenant_beta") };
  }, SETUP_TIMEOUT_MS);

  it("[FIX-W30-OTA AC5] leaves the card of every copy of before with its brand and last 4 only", () => {
    expect([first.code, first.stderr]).toEqual([0, ""]);
    const booking = byId(after.bookings, ids["oldBooking"] ?? "");
    expect(booking["form_of_payments"]).toEqual([{ creditCard: newCard }]);
    expect((booking["order_snapshot"] as JsonObject)["formOfPayments"]).toEqual([{ creditCard: newCard }]);
    const createOrders = byId(after.supplierRequests, ids["createOrders"] ?? "");
    expect(((createOrders["request_body"] as JsonObject)["data"] as JsonObject)["formOfPayments"]).toEqual([
      { creditCard: newCard },
    ]);
    expect(((createOrders["response_body"] as JsonObject)["data"] as JsonObject)["formOfPayments"]).toEqual([
      { creditCard: newCard },
    ]);
    const read = byId(after.supplierRequests, ids["orderRead"] ?? "");
    expect(((read["response_body"] as JsonObject)["data"] as JsonObject)["formOfPayments"]).toEqual([
      { creditCard: newCard },
    ]);
    // The truncated answer keeps its preview up to the card, which it held with its holder.
    const truncated = byId(after.supplierRequests, ids["truncated"] ?? "")["response_body"] as JsonObject;
    expect(truncated).toMatchObject({ truncated: true, bytes: 70_211 });
    expect(truncated["preview"]).toBe(truncatedText.slice(0, truncatedText.indexOf('"formOfPayments"')));
    // Nowhere in the two tables: not the holder, not the expiry; the passport's expiry stays.
    expect(afterText).not.toContain(HOLDER);
    expect(afterText).not.toContain(EXPIRY);
    expect(afterText).toContain(DOCUMENT_EXPIRY);
    expect(first.stdout).toContain(
      "tenant_alpha: bookings 1 scrubbed of 3 read (0 changed meanwhile, left for another run); " +
        "supplier_requests 3 scrubbed of 4 read (0 changed meanwhile, left for another run).",
    );
    expect(first.stdout).toContain("1 of 1 tenant schema(s) scrubbed.");
  });

  it("[FIX-W30-OTA AC5] changes nothing else: other columns, rows written since and rows without a card", () => {
    const scrubbed: Record<string, readonly string[]> = {
      oldBooking: ["form_of_payments", "order_snapshot"],
      createOrders: ["request_body", "response_body"],
      orderRead: ["response_body"],
      truncated: ["response_body"],
    };
    for (const [table, rows] of [
      ["bookings", "bookings"],
      ["supplier_requests", "supplierRequests"],
    ] as const) {
      expect(after[rows].map((row) => row["id"])).toEqual(before[rows].map((row) => row["id"]));
      for (const row of before[rows]) {
        const name = Object.entries(ids).find(([, id]) => id === row["id"])?.[0] ?? "";
        const columns = scrubbed[name] ?? [];
        // Every other column as it was, `version` and `updated_at` included; a row with nothing to scrub, whole.
        expect([table, name, without(byId(after[rows], row["id"] as string), columns)]).toEqual([
          table,
          name,
          without(row, columns),
        ]);
      }
    }
    // The scrubbed order keeps everything but the card's holder and expiry.
    const snapshot = byId(after.bookings, ids["oldBooking"] ?? "")["order_snapshot"] as JsonObject;
    const old = byId(before.bookings, ids["oldBooking"] ?? "")["order_snapshot"] as JsonObject;
    expect(snapshot).toEqual({ ...old, formOfPayments: [{ creditCard: newCard }] });
    // Another tenant's copies are its own run's.
    expect(beta.after).toEqual(beta.before);
  });

  it("[FIX-W30-OTA AC5] changes nothing on a second run", () => {
    expect([second.code, second.stderr]).toEqual([0, ""]);
    expect(again).toEqual(after);
    expect(second.stdout).toContain(
      "tenant_alpha: bookings 0 scrubbed of 3 read (0 changed meanwhile, left for another run); " +
        "supplier_requests 0 scrubbed of 4 read (0 changed meanwhile, left for another run).",
    );
  });
});

describe("tenants:scrub-card-copies --all and its refusals (FIX-W30-OTA)", () => {
  let all: Awaited<ReturnType<typeof scrub>>;
  let unknown: Awaited<ReturnType<typeof scrub>>;
  let usage: Awaited<ReturnType<typeof scrub>>;
  let betaText: string;

  beforeAll(async () => {
    all = await scrub("--all");
    betaText = await tablesText("tenant_beta");
    unknown = await scrub("--tenant", "gamma");
    usage = await scrub("--tenant", "alpha", "--all");
  }, SETUP_TIMEOUT_MS);

  it("[FIX-W30-OTA AC5] scrubs every active OTA, one after the other", () => {
    expect([all.code, all.stderr]).toEqual([0, ""]);
    expect(all.stdout).toContain("tenant_beta: bookings 1 scrubbed of 1 read");
    expect(all.stdout).toContain("tenant_alpha: bookings 0 scrubbed of 3 read");
    expect(all.stdout).toContain("2 of 2 tenant schema(s) scrubbed.");
    expect(betaText).not.toContain(HOLDER);
    expect(betaText).not.toContain(EXPIRY);
  });

  it("[FIX-W30-OTA AC5] refuses an unknown tenant or two targets with exit code 1, scrubbing nothing", () => {
    expect(unknown).toEqual({
      code: 1,
      stdout: "",
      stderr: "tenants:scrub-card-copies: no tenant has the key gamma; nothing was scrubbed.\n",
    });
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain(
      "Usage: node dist/cli.js tenants:scrub-card-copies (--tenant <key> | --all)",
    );
  });
});
