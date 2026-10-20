// checkout.complete for Stripe payments (completeCheckout; OBE-042, OF-04; ota/docs/architecture-booking.md §1 and §2,
// OADR-0003 points 1–3, OADR-0008 points 1 and 7, ota/docs/flows/checkout-stripe.md §2 steps 5–7) against PostgreSQL
// 16, Redis 7, the Amadeus stub and the fake Stripe API of test/helpers/fake-stripe.ts (Stripe mocked at the HTTP
// layer: the application's own `stripe` client sends its requests there).
//
// The file clones the @velexis/testing template (tenant_alpha provisioned), writes the platform rows as the platform
// does (alpha on the Velexis test Amadeus account with the `velexis` test payment connection), seeds the storefront
// settings and the default markup rule, and calls the API in-process with alpha's secret key. Every booking starts
// from a guest checkout opened from a priced offer of the stub's Madrid–Paris Orly offer 2 (moved 60 days ahead, as
// the checkout and payment tests do), with its traveller and contact, and a payment whose PaymentIntent the test then
// confirms on the fake as Stripe.js would (`requires_capture` for the checkout total). The Stripe keys are built at
// run time. Every answer is checked against the OTA document (`expectResponseToMatch`).
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
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
import { startAmadeusStub, stubScenario, type AmadeusStub } from "@velexis/testing/amadeus";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PAYMENT_JOBS } from "../../../src/bookings/booking-orchestrator.service";
import { BOOKING_REFERENCE_PATTERN } from "../../../src/bookings/booking-reference";
import { OrderRecorder } from "../../../src/bookings/order-recorder";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { OTA_POOL, type OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildStripeConfirmation } from "../../builders/bookings";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import { newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const OPS_EMAIL = "ops@alpha-travel.example";

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

type Policy = "issue_at_booking" | "issue_after_payment" | "manual_review";

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
let accountId: string;
let alphaId: string;
let alphaSk: string;
let office: string;

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

async function insertTenant(): Promise<string> {
  const id = newId("ten");
  office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
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
  return id;
}

async function issueKey(tenantId: string): Promise<string> {
  const key = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
    })
    .execute();
  return key;
}

const idempotencyKey = (): string => randomBytes(16).toString("hex");
const headers = (): Record<string, string> => ({ "X-Api-Key": alphaSk });
const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", run);

interface ErrorBody {
  readonly error: { readonly code: string; readonly details?: Record<string, unknown> };
}

interface Money {
  readonly amount: string;
  readonly currency: string;
}

interface CompletionBody {
  readonly checkoutId: string;
  readonly booking: {
    readonly id: string;
    readonly reference: string;
    readonly status: string;
    readonly recordLocator: string | null;
    readonly isGuest: boolean;
    readonly ticketing: { readonly status: string; readonly deadlineAt: string | null };
    readonly tickets: ReadonlyArray<{ readonly documentNumber: string; readonly travelerId: string | null }>;
    readonly travelers: ReadonlyArray<{
      readonly documents: ReadonlyArray<Record<string, unknown>>;
      readonly ticketNumbers?: readonly string[];
    }>;
    readonly payments: ReadonlyArray<{ readonly id: string; readonly status: string }>;
    readonly totals: { readonly total: Money };
  };
  readonly bookingToken: string | null;
  readonly warnings?: ReadonlyArray<{ readonly title?: string; readonly code?: number }>;
}

interface CheckoutBody {
  readonly id: string;
  readonly status: string;
  readonly pricedOfferId: string;
  readonly totals: { readonly total: Money };
}

interface PaymentBody {
  readonly id: string;
  readonly providerPaymentId: string | null;
}

let searchCount = 0;

/** A priced offer of alpha for the stub's offer 2 of a new search, its flight moved 60 days ahead. */
async function newPricedOffer(): Promise<string> {
  searchCount += 1;
  const searched = await request(api.server)
    .post("/v1/flight-searches")
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({
      mode: "simple",
      originLocationCode: "MAD",
      destinationLocationCode: "ORY",
      departureDate: dateFromToday(60 + searchCount),
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
  return (priced.body as { id: string }).id;
}

/** A guest checkout of alpha with its traveller (passport `documentNumber`) and contact. */
async function newCheckout(): Promise<CheckoutBody & { readonly documentNumber: string }> {
  const pricedOfferId = await newPricedOffer();
  const created = await request(api.server)
    .post("/v1/checkouts")
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({ pricedOfferId });
  expect(created.status).toBe(201);
  const checkout = created.body as CheckoutBody;
  const traveler = buildTravelerInput();
  const travelers = await request(api.server)
    .put(`/v1/checkouts/${checkout.id}/travelers`)
    .set(headers())
    .send({ travelers: [traveler] });
  expect(travelers.status).toBe(200);
  const contacts = await request(api.server)
    .put(`/v1/checkouts/${checkout.id}/contacts`)
    .set(headers())
    .send({ contacts: [buildContactInput()] });
  expect(contacts.status).toBe(200);
  const remarks = await request(api.server)
    .put(`/v1/checkouts/${checkout.id}/remarks`)
    .set(headers())
    .send({ remarks: [{ text: "Vegetarian meal please", travelerIds: ["1"] }] });
  expect(remarks.status).toBe(200);
  return { ...(remarks.body as CheckoutBody), documentNumber: traveler.documents?.[0]?.number ?? "" };
}

/** A card payment of the checkout, confirmed on the fake Stripe API for `amount` (the total by default). */
async function payCheckout(
  checkout: CheckoutBody,
  options: { readonly confirm?: boolean; readonly amount?: string } = {},
): Promise<PaymentBody> {
  const created = await request(api.server)
    .post(`/v1/checkouts/${checkout.id}/payments`)
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({ method: "card", termsAccepted: true });
  expect(created.status).toBe(201);
  const payment = created.body as PaymentBody;
  if (options.confirm !== false) {
    const minor = Math.round(Number(options.amount ?? checkout.totals.total.amount) * 100);
    stripe.update(payment.providerPaymentId ?? "", buildStripeConfirmation(minor));
  }
  return payment;
}

/** The complete, unpaid checkout that `beforeEach` opens for every test. */
let fresh: CheckoutBody & { readonly documentNumber: string };

/** The test's checkout, paid with a confirmed card payment. */
async function paidCheckout(): Promise<{
  readonly checkout: CheckoutBody & { readonly documentNumber: string };
  readonly payment: PaymentBody;
}> {
  const payment = await payCheckout(fresh);
  return { checkout: fresh, payment };
}

const complete = (
  checkoutId: string,
  options: { readonly key?: string; readonly body?: object; readonly extra?: Record<string, string> } = {},
) =>
  request(api.server)
    .post(`/v1/checkouts/${checkoutId}/complete`)
    .set({ ...headers(), "Idempotency-Key": options.key ?? idempotencyKey(), ...options.extra })
    .send(options.body ?? {});

async function setPolicy(policy: Policy): Promise<void> {
  await alphaTx((trx) => trx.updateTable("storefront_settings").set({ ticketing_policy: policy }).execute());
}

async function bookingRow(bookingId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("bookings")
      .select([
        "id",
        "reference",
        "status",
        "ticketing_status",
        "checkout_id",
        "record_locator",
        "issue_requested",
        "ticketing_deadline_at",
        "ticketing_next_attempt_at",
        "ticketing_error_code",
        "failure_code",
        "create_order_started_at",
        "order_snapshot",
        "queuing_office_id",
        sql<string>`total_amount::text`.as("total"),
        sql<string>`amount_paid::text`.as("paid"),
      ])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
  );
}

async function bookingsOfCheckout(checkoutId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("bookings")
      .innerJoin("payments", "payments.booking_id", "bookings.id")
      .select(["bookings.id", "bookings.status", "bookings.checkout_id", "bookings.failure_code"])
      .where("payments.checkout_id", "=", checkoutId)
      .orderBy("bookings.created_at")
      .execute(),
  );
}

async function eventTypes(bookingId: string): Promise<string[]> {
  const rows = await alphaTx((trx) =>
    trx.selectFrom("booking_events").select("type").where("booking_id", "=", bookingId).execute(),
  );
  return rows.map((row) => row.type).sort();
}

async function paymentRow(paymentId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("payments")
      .select(["id", "status", "booking_id", sql<string>`amount_captured::text`.as("captured")])
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow(),
  );
}

async function checkoutRow(checkoutId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("checkouts")
      .select(["status", "priced_offer_id", sql<string>`total_amount::text`.as("total")])
      .where("id", "=", checkoutId)
      .executeTakeFirstOrThrow(),
  );
}

async function notifications(bookingId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("notifications")
      .select(["template_key", "recipient", "recipient_type", "payload"])
      .where("booking_id", "=", bookingId)
      .orderBy("template_key")
      .execute(),
  );
}

/** The Amadeus booking calls the stub received, by operation. */
const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

const stripePosts = (suffix: string) =>
  stripe.requests.filter((req) => req.method === "POST" && req.path.endsWith(suffix));

// Cloning the template, starting the stub and the fake Stripe API and building the API's module graph take several
// seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own timeout.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["createFlightSearch", [201]],
    ["priceFlightOffers", [201]],
    ["createCheckout", [201]],
    ["getCheckout", [200]],
    ["setCheckoutTravelers", [200]],
    ["setCheckoutContacts", [200]],
    ["setCheckoutRemarks", [200]],
    ["createCheckoutPayment", [201]],
    ["completeCheckout", [201, 400, 402, 409, 422, 502, 504]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
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
  accountId = await insertAccount(clientId, secret);
  alphaId = await insertTenant();
  alphaSk = await issueKey(alphaId);
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
    await trx
      .updateTable("storefront_settings")
      .set({ ops_alert_email: OPS_EMAIL, time_zone: "Europe/Madrid" })
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

/** The budget of the hook that opens each test's checkout: six API calls, slow on a busy 4-CPU runner. */
const CHECKOUT_SETUP_TIMEOUT_MS = 30_000;

beforeEach(async () => {
  // Full Amadeus buckets, rate limits and no cached rows or jobs from the previous test.
  await redis.client.flushdb();
  stripe.reset();
  await setPolicy("issue_after_payment");
  // A search, a priced offer and a checkout with its traveller, contact and special request: the expensive part of
  // every test happens here, under its own budget. The policy is read when the checkout is completed, so a test may
  // still change it.
  fresh = await newCheckout();
  stub.clearRequests();
}, CHECKOUT_SETUP_TIMEOUT_MS);

describe("checkout.complete with a Stripe payment, for each ticketing policy", () => {
  it("[OBE-042 AC1] issue_at_booking: creates the order with issue=true, records it ticketed and captures the authorisation", async () => {
    await setPolicy("issue_at_booking");
    const { checkout, payment } = await paidCheckout();

    const res = await complete(checkout.id);

    expect(res.status).toBe(201);
    expectResponseToMatch("completeCheckout", res);
    const completion = res.body as CompletionBody;
    const { booking } = completion;
    expect(res.headers["location"]).toBe(`/v1/bookings/${booking.id}`);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(completion.checkoutId).toBe(checkout.id);
    expect(booking.reference).toMatch(BOOKING_REFERENCE_PATTERN);
    expect(booking).toMatchObject({ status: "ticketed", ticketing: { status: "issued" }, isGuest: true });
    expect(booking.recordLocator).toMatch(/^[A-Z0-9]{6}$/);
    expect(booking.tickets).toHaveLength(1);
    expect(booking.totals.total).toEqual(checkout.totals.total);
    expect(completion.bookingToken).toBeNull();

    // Amadeus: one Flight Create Orders with issue=true, no Flight Order Issue.
    const creates = amadeusCalls("createFlightOrders");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.query).toMatchObject({ issue: "true" });
    expect(amadeusCalls("issueFlightOrder")).toHaveLength(0);
    // Stripe: the authorisation captured once, for the total, under its key.
    const captures = stripePosts("/capture");
    expect(captures).toHaveLength(1);
    expect(captures[0]?.headers["idempotency-key"]).toBe(
      `pi:capture:${payment.id}:${checkout.totals.total.amount}`,
    );
    expect(captures[0]?.form["amount_to_capture"]).toBe(
      String(Math.round(Number(checkout.totals.total.amount) * 100)),
    );
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.status).toBe("succeeded");

    const row = await bookingRow(booking.id);
    expect(row).toMatchObject({
      status: "ticketed",
      ticketing_status: "issued",
      checkout_id: checkout.id,
      issue_requested: true,
      queuing_office_id: office,
      total: checkout.totals.total.amount,
      paid: checkout.totals.total.amount,
    });
    expect(row.create_order_started_at).not.toBeNull();
    // OADR-0008 point 3: the start (00:00) of the order's lastTicketingDate in the OTA's time zone (Europe/Madrid).
    const snapshotOffers = (row.order_snapshot as { flightOffers: Array<{ lastTicketingDate: string }> })
      .flightOffers;
    const lastTicketingDate = snapshotOffers[0]?.lastTicketingDate ?? "";
    expect(lastTicketingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const { rows: deadline } = await alphaTx((trx) =>
      sql<{ at: Date }>`
        SELECT (${lastTicketingDate}::date::timestamp AT TIME ZONE 'Europe/Madrid') AS at
      `.execute(trx),
    );
    expect(row.ticketing_deadline_at?.toISOString()).toBe(deadline[0]?.at.toISOString());
    expect(booking.ticketing.deadlineAt).toBe(deadline[0]?.at.toISOString());
    expect(await paymentRow(payment.id)).toMatchObject({ status: "captured", booking_id: booking.id });
    expect((await checkoutRow(checkout.id)).status).toBe("completed");
    expect(await eventTypes(booking.id)).toEqual(
      expect.arrayContaining([
        "booking.create_order_started",
        "booking.created",
        "booking.ticketed",
        "payment.captured",
      ]),
    );
  });

  it("[OBE-042 AC1] issue_after_payment: creates the order, captures, then issues the tickets", async () => {
    const { checkout, payment } = await paidCheckout();

    const res = await complete(checkout.id);

    expect(res.status).toBe(201);
    expectResponseToMatch("completeCheckout", res);
    const { booking } = res.body as CompletionBody;
    expect(booking).toMatchObject({ status: "ticketed", ticketing: { status: "issued" } });
    expect(booking.tickets).toHaveLength(1);
    expect(booking.travelers[0]?.ticketNumbers).toEqual([booking.tickets[0]?.documentNumber]);

    expect(amadeusCalls("createFlightOrders").map((call) => call.query)).toEqual([
      expect.objectContaining({ issue: "false" }),
    ]);
    expect(amadeusCalls("issueFlightOrder")).toHaveLength(1);
    // The capture came before the issuance (OADR-0008 point 1).
    const capture = stripePosts("/capture")[0];
    expect(capture?.headers["idempotency-key"]).toBe(
      `pi:capture:${payment.id}:${checkout.totals.total.amount}`,
    );
    expect(await paymentRow(payment.id)).toMatchObject({ status: "captured" });

    const row = await bookingRow(booking.id);
    expect(row).toMatchObject({ status: "ticketed", ticketing_status: "issued", issue_requested: false });
    // The order as recorded: the VELEXIS remark, the special request, the OTA-merchant form of payment and the queue.
    const snapshot = row.order_snapshot as Record<string, unknown>;
    const remarks = (snapshot["remarks"] as { general: Array<{ subType: string; text: string }> }).general;
    expect(remarks).toEqual([
      { subType: "GENERAL_MISCELLANEOUS", text: "VEGETARIAN MEAL PLEASE", travelerIds: ["1"] },
      { subType: "BACKOFFICE", text: `VELEXIS ${booking.reference}` },
    ]);
    expect(snapshot["formOfPayments"]).toEqual([{ other: { method: "ACCOUNT", flightOfferIds: ["2"] } }]);
    expect(snapshot["automatedProcess"]).toEqual([
      { code: "IMMEDIATE", queue: { number: "50", category: "0" }, officeId: office },
    ]);
    // The snapshot keeps the passport masked; the number is nowhere in the answer or the logs, and sealed at rest.
    expect(JSON.stringify(snapshot)).not.toContain(checkout.documentNumber);
    expect(res.text).not.toContain(checkout.documentNumber);
    expect(booking.travelers[0]?.documents[0]).not.toHaveProperty("number");
    expect(api.sink.text()).not.toContain(checkout.documentNumber);
    expect(api.sink.text()).not.toContain(SECRET_KEY);
    const traveler = await alphaTx((trx) =>
      trx
        .selectFrom("booking_travelers")
        .select(["document_last4", "documents_ciphertext"])
        .where("booking_id", "=", booking.id)
        .executeTakeFirstOrThrow(),
    );
    expect(traveler.document_last4).toBe(checkout.documentNumber.slice(-4));
    expect(traveler.documents_ciphertext).not.toBeNull();
    expect(traveler.documents_ciphertext?.toString("latin1")).not.toContain(checkout.documentNumber);
    // Flight Create Orders carried the passport, but its supplier_requests row keeps the number masked.
    const supplierRows = await alphaTx((trx) =>
      trx
        .selectFrom("supplier_requests")
        .select(["amadeus_operation_id", "request_body", "response_body"])
        .where("booking_id", "=", booking.id)
        .execute(),
    );
    expect(supplierRows.map((entry) => entry.amadeus_operation_id).sort()).toEqual([
      "createFligtOrders",
      "issueFlightOrder",
    ]);
    expect(JSON.stringify(supplierRows)).not.toContain(checkout.documentNumber);
    // The confirmation e-mail is queued for the primary contact.
    const queued = await notifications(booking.id);
    expect(queued.map((entry) => entry.template_key)).toEqual(["booking.confirmed"]);
    expect(queued[0]?.recipient).toMatch(/^contact-\d+@example\.com$/);
    expect(await eventTypes(booking.id)).toEqual(
      expect.arrayContaining(["booking.created", "booking.ticketed", "payment.captured"]),
    );
  });

  it("[OBE-042 AC1] manual_review: creates the order, keeps the authorisation for staff and alerts them", async () => {
    await setPolicy("manual_review");
    const { checkout, payment } = await paidCheckout();

    const res = await complete(checkout.id);

    expect(res.status).toBe(201);
    expectResponseToMatch("completeCheckout", res);
    const { booking } = res.body as CompletionBody;
    expect(booking).toMatchObject({ status: "confirmed", ticketing: { status: "manual_review" } });
    expect(booking.tickets).toEqual([]);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
    expect(amadeusCalls("issueFlightOrder")).toHaveLength(0);
    // Nothing captured: staff issue from the console, which captures first.
    expect(stripePosts("/capture")).toHaveLength(0);
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.status).toBe("requires_capture");
    expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized", booking_id: booking.id });
    expect(await bookingRow(booking.id)).toMatchObject({
      status: "confirmed",
      ticketing_status: "manual_review",
    });
    const queued = await notifications(booking.id);
    expect(queued.map((entry) => [entry.template_key, entry.recipient, entry.recipient_type])).toEqual([
      ["booking.confirmed", expect.stringMatching(/@example\.com$/), "guest"],
      ["staff.manual_review", OPS_EMAIL, "staff"],
    ]);
  });
});

describe("checkout.complete when Amadeus refuses the order", () => {
  it("[OBE-042 AC2] voids the authorisation on a sold-out answer, keeps a failed booking and leaves the checkout open for a new payment", async () => {
    const { checkout, payment } = await paidCheckout();

    const refused = await complete(checkout.id, { extra: stubScenario("sold-out") });

    expect(refused.status).toBe(409);
    expectResponseToMatch("completeCheckout", refused);
    expect((refused.body as ErrorBody).error.code).toBe("SOLD_OUT");
    // The authorisation is voided at Stripe under its key, the payment row cancelled.
    const cancels = stripePosts("/cancel");
    expect(cancels.map((req) => req.headers["idempotency-key"])).toEqual([`pi:cancel:${payment.id}`]);
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.status).toBe("canceled");
    expect(stripePosts("/capture")).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled" });
    // A failed booking stays for the console, without the checkout; the checkout is open again.
    const [failed] = await bookingsOfCheckout(checkout.id);
    expect(failed).toMatchObject({ status: "failed", checkout_id: null, failure_code: "SOLD_OUT" });
    expect(await eventTypes(failed?.id ?? "")).toEqual(["booking.create_order_started", "booking.failed"]);
    expect((await checkoutRow(checkout.id)).status).toBe("open");
    const read = await request(api.server).get(`/v1/checkouts/${checkout.id}`).set(headers());
    expect(read.status).toBe(200);
    expect((read.body as CheckoutBody).status).toBe("open");

    // The open checkout is paid again and completed.
    stripe.reset();
    const second = await payCheckout(checkout);
    const res = await complete(checkout.id);

    expect(res.status).toBe(201);
    expectResponseToMatch("completeCheckout", res);
    const { booking } = res.body as CompletionBody;
    expect(booking.id).not.toBe(failed?.id);
    expect(booking.status).toBe("ticketed");
    expect(await paymentRow(second.id)).toMatchObject({ status: "captured", booking_id: booking.id });
    expect((await checkoutRow(checkout.id)).status).toBe("completed");
  });

  it("[OBE-042 AC2] answers 502 SUPPLIER_ERROR on an Amadeus system error, after voiding the authorisation", async () => {
    await setPolicy("issue_at_booking");
    const { checkout, payment } = await paidCheckout();

    const res = await complete(checkout.id, { extra: stubScenario("server-error") });

    expect(res.status).toBe(502);
    expectResponseToMatch("completeCheckout", res);
    expect((res.body as ErrorBody).error.code).toBe("SUPPLIER_ERROR");
    expect(stripePosts("/cancel")).toHaveLength(1);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled" });
    expect((await checkoutRow(checkout.id)).status).toBe("open");
  });

  it("[OBE-042 AC2] queues payment.void when the void itself fails, and still fails the booking and reopens the checkout", async () => {
    const { checkout, payment } = await paidCheckout();
    stripe.onRequest((req) => {
      if (req.path.endsWith("/cancel")) {
        throw new Error("cancel refused by the test");
      }
    });

    const refused = await complete(checkout.id, { extra: stubScenario("sold-out") });

    expect(refused.status).toBe(409);
    expect((refused.body as ErrorBody).error.code).toBe("SOLD_OUT");
    // The authorisation is still there; the payments queue voids it later (OBE-040), by the queue's `{tenantId, id}`.
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.status).toBe("requires_capture");
    expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized" });
    const queue = api.app.get<Queue>(getQueueToken(OTA_QUEUE.payments), { strict: false });
    const job = await queue.getJob(`payment-void-${payment.id}`);
    expect(job?.name).toBe(PAYMENT_JOBS.void);
    expect(job?.data).toEqual({ tenantId: alphaId, id: payment.id });
    await job?.remove();
    const [failed] = await bookingsOfCheckout(checkout.id);
    expect(failed).toMatchObject({ status: "failed", checkout_id: null, failure_code: "SOLD_OUT" });
    expect((await checkoutRow(checkout.id)).status).toBe("open");
  });
});

describe("checkout.complete idempotency and transactions", () => {
  it("[OBE-042 AC3] makes one order for two calls with the same key; another key answers 409 CHECKOUT_ALREADY_COMPLETED", async () => {
    const { checkout } = await paidCheckout();
    const key = idempotencyKey();

    const [first, second] = await Promise.all([
      complete(checkout.id, { key }),
      complete(checkout.id, { key }),
    ]);

    expect([first.status, second.status]).toEqual([201, 201]);
    const firstBooking = (first.body as CompletionBody).booking;
    expect((second.body as CompletionBody).booking.id).toBe(firstBooking.id);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
    expect(stripePosts("/capture")).toHaveLength(1);
    const replay = await complete(checkout.id, { key });
    expect(replay.status).toBe(201);
    expect((replay.body as CompletionBody).booking.id).toBe(firstBooking.id);

    const other = await complete(checkout.id);

    expect(other.status).toBe(409);
    expectResponseToMatch("completeCheckout", other);
    expect(other.body).toMatchObject({
      error: { code: "CHECKOUT_ALREADY_COMPLETED", details: { bookingId: firstBooking.id } },
    });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });

  it("[OBE-042 AC3] makes one order for two calls with different keys at once: the claim (bookings.checkout_id) lets one through", async () => {
    const { checkout } = await paidCheckout();

    // Different keys: the idempotency interceptor does not order them, only the claim's lock and UNIQUE do.
    const answers = await Promise.all([complete(checkout.id), complete(checkout.id)]);

    const created = answers.filter((res) => res.status === 201);
    const refused = answers.filter((res) => res.status !== 201);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const bookingId = (created[0]?.body as CompletionBody).booking.id;
    // The other call found the claimed booking: still pending (504, the order may exist) or already completed (409).
    const error = (refused[0]?.body as ErrorBody).error;
    expect([refused[0]?.status, error.code]).toEqual(
      error.code === "SUPPLIER_TIMEOUT" ? [504, "SUPPLIER_TIMEOUT"] : [409, "CHECKOUT_ALREADY_COMPLETED"],
    );
    expect(error.details).toMatchObject({ bookingId });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
    expect(stripePosts("/capture")).toHaveLength(1);
    expect(
      await alphaTx((trx) =>
        trx.selectFrom("bookings").select("id").where("checkout_id", "=", checkout.id).execute(),
      ),
    ).toEqual([{ id: bookingId }]);
  });

  it("[OBE-042 AC3] holds no database connection, so no transaction, while Amadeus or Stripe is called", async () => {
    const pool = api.app.get<OtaPool>(OTA_POOL, { strict: false });
    const inUse = (): number => pool.totalCount - pool.idleCount;
    const atAmadeus: Array<{ path: string; inUse: number }> = [];
    const atStripe: Array<{ path: string; inUse: number }> = [];
    const { checkout } = await paidCheckout();
    // From here on, every Amadeus request (the AmadeusClient's fetch) and every Stripe request (the fake's hook) notes
    // how many connections of the API's pool are checked out at that moment.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(stub.url) && !url.includes("/oauth2/")) {
        atAmadeus.push({ path: new URL(url).pathname, inUse: inUse() });
      }
      return realFetch(input, init);
    });
    stripe.onRequest((req) => {
      atStripe.push({ path: req.path, inUse: inUse() });
    });

    const res = await complete(checkout.id);

    expect(res.status).toBe(201);
    expect(atAmadeus.map((entry) => entry.path)).toEqual([
      "/v1/booking/flight-orders",
      expect.stringMatching(/^\/v1\/booking\/flight-orders\/[^/]+\/issuance$/),
    ]);
    expect(atAmadeus.every((entry) => entry.inUse === 0)).toBe(true);
    expect(atStripe.map((entry) => entry.path)).toEqual([
      expect.stringMatching(/^\/v1\/payment_intents\/pi_test_[0-9a-f]+$/),
      expect.stringMatching(/\/capture$/),
    ]);
    expect(atStripe.every((entry) => entry.inUse === 0)).toBe(true);
  });
});

describe("checkout.complete after the order exists", () => {
  it("answers 504 SUPPLIER_TIMEOUT and keeps the booking pending when the order cannot be recorded: never a second order", async () => {
    const { checkout, payment } = await paidCheckout();
    const recorder = api.app.get(OrderRecorder, { strict: false });
    vi.spyOn(recorder, "record").mockRejectedValueOnce(new Error("T2 failed in the test"));

    const res = await complete(checkout.id);

    expect(res.status).toBe(504);
    expectResponseToMatch("completeCheckout", res);
    const error = (res.body as ErrorBody).error;
    expect(error.code).toBe("SUPPLIER_TIMEOUT");
    const bookingId = String(error.details?.["bookingId"]);
    // The order exists at Amadeus; T2 rolled back, so the claim is all that is stored: nothing voided or captured.
    expect(await bookingRow(bookingId)).toMatchObject({
      status: "pending",
      checkout_id: checkout.id,
      record_locator: null,
    });
    expect(stripePosts("/cancel")).toHaveLength(0);
    expect(stripePosts("/capture")).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized", booking_id: bookingId });
    expect((await checkoutRow(checkout.id)).status).toBe("payment_pending");

    // Another key finds the pending booking: the same 504, and Flight Create Orders is not sent again.
    const again = await complete(checkout.id);

    expect(again.status).toBe(504);
    expect((again.body as ErrorBody).error.details).toMatchObject({ bookingId });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });

  it("answers 201 with CAPTURE_FAILED when the capture fails: manual review, a capture retry queued and staff alerted", async () => {
    const { checkout, payment } = await paidCheckout();
    stripe.onRequest((req) => {
      if (req.path.endsWith("/capture")) {
        throw new Error("capture refused by the test");
      }
    });

    const res = await complete(checkout.id);

    expect(res.status).toBe(201);
    expectResponseToMatch("completeCheckout", res);
    const completion = res.body as CompletionBody;
    expect(completion.booking).toMatchObject({ status: "confirmed", ticketing: { status: "manual_review" } });
    expect(completion.warnings?.map((warning) => warning.title)).toContain("CAPTURE_FAILED");
    // No issuance without the money.
    expect(amadeusCalls("issueFlightOrder")).toHaveLength(0);
    expect(await bookingRow(completion.booking.id)).toMatchObject({
      status: "confirmed",
      ticketing_status: "manual_review",
      ticketing_error_code: "PAYMENT_CAPTURE_FAILED",
    });
    expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized" });
    const queue = api.app.get<Queue>(getQueueToken(OTA_QUEUE.payments), { strict: false });
    const job = await queue.getJob(`capture-retry-${payment.id}`);
    expect(job?.name).toBe(PAYMENT_JOBS.captureRetry);
    // The queue's payload: ids only, `{tenantId, id}` (ota/docs/architecture.md §6).
    expect(job?.data).toEqual({ tenantId: alphaId, id: payment.id });
    expect(job?.opts.delay).toBe(10 * 60_000);
    await job?.remove();
    expect((await notifications(completion.booking.id)).map((entry) => entry.template_key)).toEqual([
      "booking.confirmed",
      "staff.manual_review",
    ]);
  });

  it("answers 201 with the booking confirmed and ticketing failed when Flight Order Issue fails, the next attempt set", async () => {
    const { checkout, payment } = await paidCheckout();

    const res = await complete(checkout.id, { extra: stubScenario("ticketing-failed") });

    expect(res.status).toBe(201);
    expectResponseToMatch("completeCheckout", res);
    const { booking } = res.body as CompletionBody;
    expect(booking).toMatchObject({ status: "confirmed", ticketing: { status: "failed" } });
    expect(await paymentRow(payment.id)).toMatchObject({ status: "captured" });
    const row = await bookingRow(booking.id);
    expect(row).toMatchObject({ ticketing_status: "failed", ticketing_error_code: "TICKETING_FAILED" });
    expect(row.ticketing_next_attempt_at).not.toBeNull();
    expect(await eventTypes(booking.id)).toContain("booking.ticketing_failed");
  });
});

describe("checkout.complete refusals before anything is booked", () => {
  it("refuses a request without Idempotency-Key", async () => {
    const { checkout } = await paidCheckout();

    const res = await request(api.server)
      .post(`/v1/checkouts/${checkout.id}/complete`)
      .set(headers())
      .send({});

    expect(res.status).toBe(400);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
  });

  it("answers 402 PAYMENT_REQUIRED for a PaymentIntent not confirmed yet, and books nothing", async () => {
    const checkout = fresh;
    await payCheckout(checkout, { confirm: false });

    const res = await complete(checkout.id);

    expect(res.status).toBe(402);
    expectResponseToMatch("completeCheckout", res);
    expect((res.body as ErrorBody).error.code).toBe("PAYMENT_REQUIRED");
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    expect(await bookingsOfCheckout(checkout.id)).toEqual([]);
  });

  it("answers 409 PAYMENT_AMOUNT_MISMATCH when the authorisation does not hold the total", async () => {
    const checkout = fresh;
    const total = Number(checkout.totals.total.amount);
    await payCheckout(checkout, { amount: (total - 1).toFixed(2) });

    const res = await complete(checkout.id);

    expect(res.status).toBe(409);
    expectResponseToMatch("completeCheckout", res);
    expect((res.body as ErrorBody).error.code).toBe("PAYMENT_AMOUNT_MISMATCH");
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    expect(stripePosts("/cancel")).toHaveLength(0);
  });

  it("answers 409 PRICE_CHANGED when the total is above expectedTotal", async () => {
    const { checkout } = await paidCheckout();
    const lower = (Number(checkout.totals.total.amount) - 5).toFixed(2);

    const res = await complete(checkout.id, { body: { expectedTotal: { amount: lower, currency: "EUR" } } });

    expect(res.status).toBe(409);
    expectResponseToMatch("completeCheckout", res);
    expect(res.body).toMatchObject({
      error: { code: "PRICE_CHANGED", details: { oldPrice: { amount: lower, currency: "EUR" } } },
    });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
  });
});

describe("checkout.complete with a priced offer older than ten minutes", () => {
  async function ageOffer(pricedOfferId: string): Promise<void> {
    await alphaTx((trx) =>
      trx
        .updateTable("priced_offers")
        .set({ created_at: sql<Date>`now() - interval '11 minutes'` })
        .where("id", "=", pricedOfferId)
        .execute(),
    );
  }

  it("prices the offers again and books the same price on the new priced offer", async () => {
    const { checkout } = await paidCheckout();
    await ageOffer(checkout.pricedOfferId);
    stub.clearRequests();

    const res = await complete(checkout.id);

    expect(res.status).toBe(201);
    expectResponseToMatch("completeCheckout", res);
    expect(amadeusCalls("quoteAirOffers")).toHaveLength(1);
    const after = await checkoutRow(checkout.id);
    expect(after.priced_offer_id).not.toBe(checkout.pricedOfferId);
    expect(after.total).toBe(checkout.totals.total.amount);
  });

  it("answers 409 PRICE_CHANGED for a higher price: the checkout moves to the new priced offer and the authorisation is voided", async () => {
    const { checkout, payment } = await paidCheckout();
    await ageOffer(checkout.pricedOfferId);

    const res = await complete(checkout.id, { extra: stubScenario("price-changed") });

    expect(res.status).toBe(409);
    expectResponseToMatch("completeCheckout", res);
    const error = (res.body as ErrorBody).error;
    expect(error.code).toBe("PRICE_CHANGED");
    expect(error.details).toMatchObject({ oldPrice: checkout.totals.total });
    const after = await checkoutRow(checkout.id);
    expect(error.details?.["pricedOfferId"]).toBe(after.priced_offer_id);
    expect(after.priced_offer_id).not.toBe(checkout.pricedOfferId);
    expect(after.status).toBe("open");
    expect(Number(after.total)).toBeGreaterThan(Number(checkout.totals.total.amount));
    expect((error.details?.["newPrice"] as Money).amount).toBe(after.total);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled" });
  });
});
