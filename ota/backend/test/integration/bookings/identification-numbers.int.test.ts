// The numbers of an Amadeus order's forms of identification (`formOfIdentifications[].number`: passport, identity card
// and driving licence numbers) in every copy of the order Velexis keeps (FIX-W26-SECURITY; db README §8, conventions
// §7, ota/docs/architecture.md §4): the record step of checkout.complete (OBE-042's OrderRecorder, then the inline
// Flight Order Issue) and the customer refresh of bookings.get (OBE-046's CustomerBookingsService) store the order
// through the shared redactor of @velexis/logger, which cuts those numbers to their last 4 characters as it does
// `documents[].number`. Only Amadeus receives them in full. A second booking is recorded under `manual_review`, where
// no Flight Order Issue follows, so the stored snapshot is OrderRecorder's own copy.
//
// Against PostgreSQL 16, Redis 7, the Amadeus stub and the fake Stripe API of test/helpers/fake-stripe.ts, set up as
// complete-stripe.int.test.ts does: the @velexis/testing template (tenant_alpha provisioned) with alpha on the Velexis
// test Amadeus account and the `velexis` test payment connection, a guest checkout of the stub's Madrid–Paris Orly
// offer 2 (moved 60 days ahead) paid with a PaymentIntent confirmed on the fake. The order request the orchestrator
// sends gets forms of identification added on its way to the stub (a spy around `AmadeusClient.createFlightOrders`),
// as an airline that wants them for its e-tickets would have them; the stub keeps them in the order and returns them
// in every answer (Create Orders, Issue, Management GET).
import { randomBytes, randomInt } from "node:crypto";
import { encryptValue, hashApiKey, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { REFRESH_THROTTLE_MS } from "../../../src/bookings/allowed-actions";
import { newId } from "../../../src/common/ids";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildStripeConfirmation } from "../../builders/bookings";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import { newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;

const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let stripe: FakeStripe;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaSk: string;
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };

async function insertAccount(clientId: string, secret: string): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(secret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${id}`,
    keys,
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id,
      name: "Velexis test",
      environment: "test",
      base_url: "https://test.travel.api.amadeus.com",
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

/** Tenant alpha on the Velexis test Amadeus account, with the `velexis` test Stripe connection and a secret key. */
async function insertTenant(accountId: string): Promise<string> {
  const id = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key: "alpha", name: "alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: id,
      environment: "test",
      credential_source: "velexis",
      amadeus_account_id: accountId,
      office_ids: [office],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      status: "active",
    })
    .execute();
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id: newId("ppc"),
      tenant_id: id,
      provider: "stripe",
      environment: "test",
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
      statement_descriptor_suffix: "ALPHA TRAVEL",
    })
    .execute();
  const key = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: id,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
    })
    .execute();
  alphaSk = key;
  return id;
}

const idempotencyKey = (): string => randomBytes(16).toString("hex");
const headers = (): Record<string, string> => ({ "X-Api-Key": alphaSk });
const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", run);

interface CheckoutBody {
  readonly id: string;
  readonly totals: { readonly total: { readonly amount: string; readonly currency: string } };
}

interface CompletionBody {
  readonly booking: { readonly id: string; readonly status: string };
  readonly bookingToken: string | null;
}

/** A guest checkout of alpha for the stub's offer 2, its flight moved 60 days ahead, with traveller and contact. */
async function newCheckout(): Promise<CheckoutBody> {
  const searched = await request(api.server)
    .post("/v1/flight-searches")
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({
      mode: "simple",
      originLocationCode: "MAD",
      destinationLocationCode: "ORY",
      departureDate: FLIGHT_DATE,
      adults: 1,
    });
  expect(searched.status).toBe(201);
  const searchId = (searched.body as { id: string }).id;
  const offerId = await alphaTx(async (trx) => {
    await trx
      .updateTable("flight_offers")
      .set({
        payload: sql`jsonb_set(jsonb_set(jsonb_set(payload,
          '{itineraries,0,segments,0,departure,at}', to_jsonb(${`${FLIGHT_DATE}T07:15:00`}::text)),
          '{itineraries,0,segments,0,arrival,at}', to_jsonb(${`${FLIGHT_DATE}T09:20:00`}::text)),
          '{lastTicketingDate}', to_jsonb(${LAST_TICKETING_DATE}::text))`,
        last_ticketing_date: LAST_TICKETING_DATE,
      })
      .where("search_id", "=", searchId)
      .execute();
    const row = await trx
      .selectFrom("flight_offers")
      .select("id")
      .where("search_id", "=", searchId)
      .where("amadeus_offer_id", "=", "2")
      .executeTakeFirstOrThrow();
    return row.id;
  });
  const priced = await request(api.server)
    .post("/v1/priced-offers")
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({ offerIds: [offerId] });
  expect(priced.status).toBe(201);
  const created = await request(api.server)
    .post("/v1/checkouts")
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({ pricedOfferId: (priced.body as { id: string }).id });
  expect(created.status).toBe(201);
  const checkoutId = (created.body as CheckoutBody).id;
  const travelers = await request(api.server)
    .put(`/v1/checkouts/${checkoutId}/travelers`)
    .set(headers())
    .send({ travelers: [buildTravelerInput()] });
  expect(travelers.status).toBe(200);
  const contacts = await request(api.server)
    .put(`/v1/checkouts/${checkoutId}/contacts`)
    .set(headers())
    .send({ contacts: [buildContactInput()] });
  expect(contacts.status).toBe(200);
  return contacts.body as CheckoutBody;
}

/** A card payment of the checkout, confirmed on the fake Stripe API for its total. */
async function payCheckout(checkout: CheckoutBody): Promise<void> {
  const created = await request(api.server)
    .post(`/v1/checkouts/${checkout.id}/payments`)
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({ method: "card", termsAccepted: true });
  expect(created.status).toBe(201);
  const minor = Math.round(Number(checkout.totals.total.amount) * 100);
  stripe.update(
    (created.body as { providerPaymentId: string | null }).providerPaymentId ?? "",
    buildStripeConfirmation(minor),
  );
}

/** The stub's order with this id, read through its own Flight Order Management API: what Amadeus holds. */
async function stubOrder(orderId: string): Promise<JsonObject> {
  const tokenRes = await fetch(`${stub.url}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: stubCredentials.clientId,
      client_secret: stubCredentials.clientSecret,
    }).toString(),
  });
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };
  const res = await fetch(`${stub.url}/v1/booking/flight-orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: JsonObject }).data;
}

interface IdentificationNumbers {
  readonly passport: string;
  readonly idCard: string;
  readonly licence: string;
}

/** Synthetic identification numbers of this run: a passport, an identity card and a driving licence. */
function newIdentificationNumbers(): IdentificationNumbers {
  return {
    passport: `PX${randomInt(10_000_000, 99_999_999)}`,
    idCard: `ID${randomInt(10_000_000, 99_999_999)}`,
    licence: `DL${randomInt(10_000_000, 99_999_999)}`,
  };
}

type CreateOrderBody = Parameters<AmadeusClient["createFlightOrders"]>[1]["body"];

/**
 * Adds the forms of identification an airline asks for to the order the orchestrator built, on its way out (a spy
 * around `AmadeusClient.createFlightOrders`; restoreMocks of vitest.int.config.ts restores it after the test).
 */
function sendIdentificationsWithOrders(numbers: IdentificationNumbers): void {
  const client = api.app.get(AmadeusClient, { strict: false });
  const createFlightOrders = client.createFlightOrders.bind(client);
  vi.spyOn(client, "createFlightOrders").mockImplementation((context, order, options) => {
    const body: CreateOrderBody = {
      data: {
        ...order.body.data,
        formOfIdentifications: [
          { identificationType: "PASSPORT", number: numbers.passport, travelerIds: ["1"] },
          { identificationType: "NATIONAL_IDENTITY_CARD", number: numbers.idCard, travelerIds: ["1"] },
          { identificationType: "DRIVERS_LICENSE", number: numbers.licence, travelerIds: ["1"] },
        ],
      },
    } as CreateOrderBody;
    return createFlightOrders(context, { ...order, body }, options);
  });
}

/** The forms of identification `sendIdentificationsWithOrders` adds, as the booking keeps them: last 4 only. */
function maskedIdentifications(numbers: IdentificationNumbers): JsonObject[] {
  return [
    { identificationType: "PASSPORT", number: numbers.passport.slice(-4), travelerIds: ["1"] },
    { identificationType: "NATIONAL_IDENTITY_CARD", number: numbers.idCard.slice(-4), travelerIds: ["1"] },
    { identificationType: "DRIVERS_LICENSE", number: numbers.licence.slice(-4), travelerIds: ["1"] },
  ];
}

/** The `number`s of the forms of identification of an order's `data` (or of a list of them). */
function identificationNumbersOf(value: unknown): unknown[] {
  const list = Array.isArray(value)
    ? value
    : ((value as { formOfIdentifications?: unknown } | null)?.formOfIdentifications ?? []);
  return (list as JsonObject[]).map((entry) => entry["number"]);
}

/** Every copy of the booking's order the tenant schema keeps, and the other rows of the booking that could hold one. */
async function storedCopies(bookingId: string) {
  return await alphaTx(async (trx) => ({
    booking: await trx
      .selectFrom("bookings")
      .select([
        "amadeus_order_id",
        "order_snapshot",
        "form_of_identifications",
        "form_of_payments",
        "order_included",
      ])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
    supplierRequests: await trx
      .selectFrom("supplier_requests")
      .select(["amadeus_api", "amadeus_operation_id", "request_body", "response_body"])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .execute(),
    events: await trx
      .selectFrom("booking_events")
      .select(["type", "data"])
      .where("booking_id", "=", bookingId)
      .execute(),
    tickets: await trx
      .selectFrom("booking_tickets")
      .select(["details"])
      .where("booking_id", "=", bookingId)
      .execute(),
    notifications: await trx
      .selectFrom("notifications")
      .select(["template_key", "payload"])
      .where("booking_id", "=", bookingId)
      .execute(),
    idempotency: await trx.selectFrom("idempotency_keys").select(["response_body"]).execute(),
  }));
}

/** No stored copy of the booking's order, no answer and no log line holds one of `numbers` in full. */
function expectNoFullNumber(
  copies: Awaited<ReturnType<typeof storedCopies>>,
  answers: readonly string[],
  numbers: readonly string[],
): void {
  for (const number of numbers) {
    expect(JSON.stringify(copies.booking), number).not.toContain(number);
    expect(JSON.stringify(copies.supplierRequests), number).not.toContain(number);
    expect(JSON.stringify(copies.events), number).not.toContain(number);
    expect(JSON.stringify(copies.tickets), number).not.toContain(number);
    expect(JSON.stringify(copies.notifications), number).not.toContain(number);
    expect(JSON.stringify(copies.idempotency), number).not.toContain(number);
    for (const answer of answers) {
      expect(answer, number).not.toContain(number);
    }
    expect(api.sink.text(), number).not.toContain(number);
  }
}

beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, not in the test's budget.
  const checker = responseChecker("ota");
  for (const [operationId, status] of [
    ["createFlightSearch", 201],
    ["priceFlightOffers", 201],
    ["createCheckout", 201],
    ["setCheckoutTravelers", 200],
    ["setCheckoutContacts", 200],
    ["createCheckoutPayment", 201],
    ["completeCheckout", 201],
    ["getBooking", 200],
  ] as const) {
    checker.check(operationId, { status, body: {} });
  }
  [db, redis, keys, stripe] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    testKeyProvider(),
    startFakeStripe(),
  ]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  stubCredentials = { clientId, clientSecret: secret };
  await insertTenant(await insertAccount(clientId, secret));
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
    await trx
      .updateTable("storefront_settings")
      .set({ ticketing_policy: "issue_after_payment", time_zone: "Europe/Madrid" })
      .execute();
  });
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  api = await createTestApp({
    database: db,
    redis,
    imports: [stripeEndpointModule(stripe.endpoint)],
    env: {
      AMADEUS_BASE_URL_TEST: stub.url,
      STRIPE_SECRET_KEY_TEST: SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
    },
  });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await stripe?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

/** The budget of the hook that opens the checkout: five API calls, slow on a busy 4-CPU runner. */
const CHECKOUT_SETUP_TIMEOUT_MS = 30_000;

describe("the numbers of an order's forms of identification", () => {
  let checkout: CheckoutBody;

  beforeAll(async () => {
    checkout = await newCheckout();
    await payCheckout(checkout);
  }, CHECKOUT_SETUP_TIMEOUT_MS);

  it("[FIX-W26-SECURITY AC5] reach Amadeus in full, but the recorded and the refreshed order, the supplier log, the booking and the logs keep their last 4 only", async () => {
    const numbers = newIdentificationNumbers();
    const all = [numbers.passport, numbers.idCard, numbers.licence];
    const masked = all.map((number) => number.slice(-4));
    sendIdentificationsWithOrders(numbers);

    // The record step (checkout.complete: Flight Create Orders, the capture, Flight Order Issue).
    const completed = await request(api.server)
      .post(`/v1/checkouts/${checkout.id}/complete`)
      .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
      .send({});

    expect(completed.status).toBe(201);
    expectResponseToMatch("completeCheckout", completed);
    const { booking, bookingToken } = completed.body as CompletionBody;
    expect(booking.status).toBe("ticketed");
    const recorded = await storedCopies(booking.id);
    // Amadeus has the full numbers: the stub's order holds them.
    expect(identificationNumbersOf(await stubOrder(recorded.booking.amadeus_order_id ?? ""))).toEqual(all);
    expect(identificationNumbersOf(recorded.booking.order_snapshot)).toEqual(masked);
    expect(recorded.supplierRequests.map((row) => row.amadeus_api)).toEqual([
      "FlightCreateOrders",
      "FlightOrderIssue",
    ]);
    // The request of Flight Create Orders and the answers of both calls carried them; the log keeps the last 4.
    expect(
      identificationNumbersOf((recorded.supplierRequests[0]?.request_body as { data: unknown }).data),
    ).toEqual(masked);
    for (const row of recorded.supplierRequests) {
      expect(identificationNumbersOf((row.response_body as { data: unknown }).data)).toEqual(masked);
    }

    // The customer refresh of bookings.get, a minute later (the record step's sync is within the throttle).
    const shift = `${REFRESH_THROTTLE_MS} milliseconds`;
    await alphaTx(async (trx) => {
      await sql`UPDATE booking_events SET created_at = created_at - ${shift}::interval
        WHERE booking_id = ${booking.id}`.execute(trx);
      await sql`UPDATE bookings SET last_synced_at = last_synced_at - ${shift}::interval
        WHERE id = ${booking.id}`.execute(trx);
    });
    const refreshed = await request(api.server)
      .get(`/v1/bookings/${booking.id}?refresh=true`)
      .set({ ...headers(), "X-Booking-Token": bookingToken ?? "" });

    expect(refreshed.status).toBe(200);
    expectResponseToMatch("getBooking", refreshed);
    const body = refreshed.body as { syncStatus: string; amadeus?: { order: unknown } };
    expect(body.syncStatus).toBe("refreshed");
    expect(identificationNumbersOf(body.amadeus?.order)).toEqual(masked);
    const copies = await storedCopies(booking.id);
    expect(copies.supplierRequests.map((row) => row.amadeus_api)).toEqual([
      "FlightCreateOrders",
      "FlightOrderIssue",
      "FlightOrderManagement",
    ]);
    expect(
      identificationNumbersOf((copies.supplierRequests[2]?.response_body as { data: unknown }).data),
    ).toEqual(masked);
    expect(identificationNumbersOf(copies.booking.order_snapshot)).toEqual(masked);
    // Projected on the booking with their last 4 only, by the record step and again by the refresh (FIX-W27-SYNC).
    expect(copies.booking.form_of_identifications).toEqual(maskedIdentifications(numbers));

    // No stored copy and no log line holds a full number.
    expectNoFullNumber(copies, [completed.text, refreshed.text], all);
  });
});

describe("the numbers of an order's forms of identification, recorded without an issue", () => {
  let checkout: CheckoutBody;

  beforeAll(async () => {
    // manual_review: checkout.complete records the order and stops, so the snapshot is the record step's own copy
    // (with issue_after_payment the inline Flight Order Issue replaces it at once).
    await alphaTx((trx) =>
      trx.updateTable("storefront_settings").set({ ticketing_policy: "manual_review" }).execute(),
    );
    checkout = await newCheckout();
    await payCheckout(checkout);
  }, CHECKOUT_SETUP_TIMEOUT_MS);

  it("[FIX-W26-SECURITY AC5] [FIX-W27-SYNC AC4] keep their last 4 only in the order snapshot of the record step (OrderRecorder), the supplier log and the booking", async () => {
    const numbers = newIdentificationNumbers();
    const all = [numbers.passport, numbers.idCard, numbers.licence];
    const masked = all.map((number) => number.slice(-4));
    sendIdentificationsWithOrders(numbers);

    const completed = await request(api.server)
      .post(`/v1/checkouts/${checkout.id}/complete`)
      .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
      .send({});

    expect(completed.status).toBe(201);
    expectResponseToMatch("completeCheckout", completed);
    const { booking } = completed.body as CompletionBody;
    expect(booking.status).toBe("confirmed");
    const copies = await storedCopies(booking.id);
    expect(identificationNumbersOf(await stubOrder(copies.booking.amadeus_order_id ?? ""))).toEqual(all);
    // Flight Create Orders only: the snapshot is the one OrderRecorder wrote.
    expect(copies.supplierRequests.map((row) => row.amadeus_api)).toEqual(["FlightCreateOrders"]);
    expect(identificationNumbersOf(copies.booking.order_snapshot)).toEqual(masked);
    const [createOrders] = copies.supplierRequests;
    expect(identificationNumbersOf((createOrders?.request_body as { data: unknown }).data)).toEqual(masked);
    expect(identificationNumbersOf((createOrders?.response_body as { data: unknown }).data)).toEqual(masked);
    // The record step projects them on the booking, last 4 only (FIX-W27-SYNC AC4).
    expect(copies.booking.form_of_identifications).toEqual(maskedIdentifications(numbers));

    expectNoFullNumber(copies, [completed.text], all);
  });
});
