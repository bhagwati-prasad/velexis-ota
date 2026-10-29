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
//
// FIX-W22 (OADR-0003): an Amadeus 5xx on Flight Create Orders is an unknown outcome, not a refusal, so its test now
// expects the pending booking and the `504` instead of a void and a `502`; the re-price of a checkout with extras, and
// the lock of a checkout whose booking is pending, have tests of their own (the last describes).
//
// FIX-W24-BOOKINGS (lead decision of 2026-10-21, OADR-0003 point 11): the capture's transaction locks the booking
// before the payment, proven with a second transaction that holds the booking (test/helpers/lock-order.ts).
// FIX-W25-BOOKINGS (third batch: checkout, booking, payment, refund): the transactions after Flight Create Orders (T2,
// the failure, the unknown outcome) lock the checkout before the booking, proven the same way with the checkout held;
// and a claim that a reconciliation decided before the order was sent (an adopted claim) sends no order at all.
// FIX-W32-OTA (lead decision (1a) of 2026-10-28): the issuance of step 5 respects a cancellation's hold, proven with a
// barrier at the capture that commits a cancellation's claim (or the flag of a DELETE without an answer) first.
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
import { CancellationRepository } from "../../../src/bookings/cancellation.service";
import { OrderRecorder } from "../../../src/bookings/order-recorder";
import { claimSkip, TicketingRepository } from "../../../src/bookings/ticketing.service";
import { BOOKING_TOKEN_PATTERN } from "../../../src/common/auth/booking-access.guard";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { OTA_POOL, type OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildStripeConfirmation } from "../../builders/bookings";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import { newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { mapAmadeusError } from "../../../src/amadeus/error-mapper";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import {
  probeLockOrder,
  probeRowLockOrder,
  type LockOrderProbe,
  type RowLockOrderProbe,
} from "../../helpers/lock-order";
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
  readonly basePricedOfferId?: string;
  readonly version?: number;
  readonly totals: { readonly total: Money; readonly offer?: Money; readonly ancillaries?: Money };
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
        "reconcile_until",
        "order_snapshot",
        "queuing_office_id",
        "priced_offer_id",
        sql<string>`total_amount::text`.as("total"),
        sql<string>`ancillaries_amount::text`.as("ancillaries"),
        sql<string | null>`net_services_amount::text`.as("netServices"),
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

/** The `reason` of a booking's `booking.supplier_timeout` event (what made the outcome unknown). */
async function supplierTimeoutReason(bookingId: string): Promise<unknown> {
  const row = await alphaTx((trx) =>
    trx
      .selectFrom("booking_events")
      .select("data")
      .where("booking_id", "=", bookingId)
      .where("type", "=", "booking.supplier_timeout")
      .executeTakeFirstOrThrow(),
  );
  return (row.data as { reason?: unknown }).reason;
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
      .select([
        "status",
        "priced_offer_id",
        "version",
        sql<string>`offer_amount::text`.as("offer"),
        sql<string>`ancillaries_amount::text`.as("ancillaries"),
        sql<string>`total_amount::text`.as("total"),
        sql<boolean>`total_amount = offer_amount + ancillaries_amount + fees_amount`.as("balanced"),
      ])
      .where("id", "=", checkoutId)
      .executeTakeFirstOrThrow(),
  );
}

/** The checkout's extras (`checkout_ancillaries`), in their order. */
async function extraRows(checkoutId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("checkout_ancillaries")
      .select([
        "id",
        "type",
        sql<string>`price_amount::text`.as("price"),
        sql<string>`net_amount::text`.as("net"),
      ])
      .where("checkout_id", "=", checkoutId)
      .orderBy("created_at")
      .execute(),
  );
}

/** The parent of a priced offer. */
async function parentOf(pricedOfferId: string): Promise<string | null> {
  const row = await alphaTx((trx) =>
    trx
      .selectFrom("priced_offers")
      .select("parent_priced_offer_id")
      .where("id", "=", pricedOfferId)
      .executeTakeFirstOrThrow(),
  );
  return row.parent_priced_offer_id;
}

/** The request bodies the API sent to Amadeus for a booking (`supplier_requests`, redacted), by operation id. */
async function supplierRequestBodies(bookingId: string, operationId: string): Promise<unknown[]> {
  const rows = await alphaTx((trx) =>
    trx
      .selectFrom("supplier_requests")
      .select(["request_body"])
      .where("booking_id", "=", bookingId)
      .where("amadeus_operation_id", "=", operationId)
      .orderBy("created_at")
      .execute(),
  );
  return rows.map((row) => row.request_body);
}

/** The `additionalServices` of every fare detail of a Flight Offers Price or Flight Create Orders request body. */
function additionalServicesOf(body: unknown): unknown[] {
  const offers = (body as { data?: { flightOffers?: unknown[] } }).data?.flightOffers ?? [];
  return offers.flatMap((offer) =>
    ((offer as { travelerPricings?: unknown[] }).travelerPricings ?? []).flatMap((pricing) =>
      ((pricing as { fareDetailsBySegment?: unknown[] }).fareDetailsBySegment ?? []).flatMap((detail) => {
        const services = (detail as { additionalServices?: unknown }).additionalServices;
        return services === undefined ? [] : [services];
      }),
    ),
  );
}

interface CatalogueOption {
  readonly id: string;
  readonly quantity: number | null;
  readonly price: Money | null;
}

/** The one-bag option of a priced offer's catalogue (the stub's 1 checked bag). */
async function oneBagOf(pricedOfferId: string): Promise<CatalogueOption> {
  const res = await request(api.server).get(`/v1/priced-offers/${pricedOfferId}/ancillaries`).set(headers());
  expect(res.status).toBe(200);
  const bag = (res.body as { checkedBags: CatalogueOption[] }).checkedBags.find(
    (option) => option.quantity === 1,
  );
  if (bag === undefined) {
    throw new Error("the stub's catalogue has no one-bag option");
  }
  return bag;
}

/** The checkout with one checked bag added by checkout.setAncillaries. */
async function withBag(checkout: CheckoutBody): Promise<CheckoutBody> {
  const bag = await oneBagOf(checkout.pricedOfferId);
  const res = await request(api.server)
    .put(`/v1/checkouts/${checkout.id}/ancillaries`)
    .set(headers())
    .send({ selections: [{ optionId: bag.id, travelerId: "1" }] });
  expect(res.status).toBe(200);
  return res.body as CheckoutBody;
}

/** Makes a priced offer older than the re-price threshold (ten minutes). */
async function ageOffer(pricedOfferId: string): Promise<void> {
  await alphaTx((trx) =>
    trx
      .updateTable("priced_offers")
      .set({ created_at: sql<Date>`now() - interval '11 minutes'` })
      .where("id", "=", pricedOfferId)
      .execute(),
  );
}

/** The `payment.void` job of a payment on `ota-payments`, if one was queued. */
async function queuedVoid(paymentId: string) {
  const queue = api.app.get<Queue>(getQueueToken(OTA_QUEUE.payments), { strict: false });
  return (await queue.getJob(`payment-void-${paymentId}`)) ?? undefined;
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
    ["setCheckoutTravelers", [200, 409]],
    ["setCheckoutContacts", [200, 409]],
    ["setCheckoutRemarks", [200, 409]],
    ["createCheckoutPayment", [201, 409]],
    ["getPricedOfferAncillaries", [200]],
    ["setCheckoutAncillaries", [200, 409]],
    ["updatePayment", [409]],
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
    // A guest booking: the key caller gets its guest token (OBE-047; test/integration/bookings/guest-access.int.test.ts).
    expect(completion.bookingToken).toMatch(BOOKING_TOKEN_PATTERN);

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
    // The confirmation e-mail is queued for the primary contact, and so is the e-ticket e-mail of the tickets the
    // issuance stored (OBE-055: `booking.ticketed` queues it).
    const queued = await notifications(booking.id);
    expect(queued.map((entry) => entry.template_key)).toEqual(["booking.confirmed", "booking.ticketed"]);
    expect(queued[0]?.recipient).toMatch(/^contact-\d+@example\.com$/);
    expect(queued[1]?.recipient).toBe(queued[0]?.recipient);
    expect(queued[1]?.payload).toMatchObject({
      tickets: [{ number: booking.tickets[0]?.documentNumber, travellerName: expect.any(String) as unknown }],
    });
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

describe("checkout.complete when Amadeus does not prove a refusal (OADR-0003)", () => {
  /** The booking of a `504` answer, as stored. */
  async function pendingBookingOf(res: { body: unknown }) {
    const error = (res.body as ErrorBody).error;
    expect(error.code).toBe("SUPPLIER_TIMEOUT");
    // The guest follows the pending booking with its token (OBE-047).
    expect(error.details).toMatchObject({
      bookingToken: expect.stringMatching(BOOKING_TOKEN_PATTERN),
      replayed: false,
    });
    return await bookingRow(String(error.details?.["bookingId"]));
  }

  it("[FIX-W22 AC4] answers 504 SUPPLIER_TIMEOUT on an Amadeus 500: the booking stays pending for the reconciliation, nothing is voided, no second order", async () => {
    await setPolicy("issue_at_booking");
    const { checkout, payment } = await paidCheckout();

    const res = await complete(checkout.id, { extra: stubScenario("server-error") });

    expect(res.status).toBe(504);
    expectResponseToMatch("completeCheckout", res);
    const booking = await pendingBookingOf(res);
    // The order may exist: the claim stays, with the checkout, until the reconciliation (OBE-043) decides it.
    expect(booking).toMatchObject({ status: "pending", checkout_id: checkout.id, record_locator: null });
    expect(booking.reconcile_until?.getTime()).toBe(
      (booking.create_order_started_at?.getTime() ?? 0) + 15 * 60_000,
    );
    expect(await eventTypes(booking.id)).toEqual([
      "booking.create_order_started",
      "booking.supplier_timeout",
    ]);
    expect(stripePosts("/cancel")).toHaveLength(0);
    expect(stripePosts("/capture")).toHaveLength(0);
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.status).toBe("requires_capture");
    expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized", booking_id: booking.id });
    expect((await checkoutRow(checkout.id)).status).toBe("payment_pending");
    expect(await queuedVoid(payment.id)).toBeUndefined();

    // Another key, or the same one, finds the pending booking: the same 504 and never a second Flight Create Orders.
    const again = await complete(checkout.id);

    expect(again.status).toBe(504);
    expectResponseToMatch("completeCheckout", again);
    expect((again.body as ErrorBody).error.details).toMatchObject({ bookingId: booking.id });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
    expect(stripePosts("/cancel")).toHaveLength(0);
  });

  it("[FIX-W22 AC4] answers 504 SUPPLIER_TIMEOUT on an Amadeus 503 too: a gateway answer proves nothing about the order", async () => {
    const { checkout, payment } = await paidCheckout();
    const realFetch = globalThis.fetch;
    const creates: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(stub.url) && new URL(url).pathname === "/v1/booking/flight-orders") {
        creates.push(url);
        const body = { errors: [{ status: 503, code: 141, title: "SYSTEM ERROR HAS OCCURRED" }] };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 503,
            headers: { "content-type": "application/vnd.amadeus+json" },
          }),
        );
      }
      return realFetch(input, init);
    });

    const res = await complete(checkout.id);

    expect(res.status).toBe(504);
    expectResponseToMatch("completeCheckout", res);
    const booking = await pendingBookingOf(res);
    expect(booking).toMatchObject({ status: "pending", checkout_id: checkout.id });
    expect(booking.reconcile_until).not.toBeNull();
    expect(stripePosts("/cancel")).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized" });

    const again = await complete(checkout.id);

    expect(again.status).toBe(504);
    expect(creates).toHaveLength(1);
  });

  // The other answers that prove nothing: no answer at all, and a 2xx that cannot be read (the order may well exist).
  it.each([
    {
      answer: "a connection reset while waiting for the answer",
      reason: "SUPPLIER_TIMEOUT",
      respond: (): Promise<Response> =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
          }),
        ),
    },
    {
      answer: "a 2xx answer that is not JSON",
      reason: "SUPPLIER_ERROR",
      respond: (): Promise<Response> =>
        Promise.resolve(
          new Response("<html>order received</html>", {
            status: 201,
            headers: { "content-type": "text/html" },
          }),
        ),
    },
    {
      answer: "a created order whose answer cannot be read",
      reason: "create_order_unreadable",
      respond: (): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { type: "flight-order", id: "eJzTd9f3NjIJdgMADeQCtg" } }), {
            status: 201,
            headers: { "content-type": "application/vnd.amadeus+json" },
          }),
        ),
    },
  ])(
    "[FIX-W22 AC4] answers 504 SUPPLIER_TIMEOUT on $answer: pending with reconcile_until, nothing voided",
    async ({ reason, respond }) => {
      const { checkout, payment } = await paidCheckout();
      const realFetch = globalThis.fetch;
      let creates = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith(stub.url) && new URL(url).pathname === "/v1/booking/flight-orders") {
          creates += 1;
          return respond();
        }
        return realFetch(input, init);
      });

      const res = await complete(checkout.id);

      expect(res.status).toBe(504);
      expectResponseToMatch("completeCheckout", res);
      const booking = await pendingBookingOf(res);
      expect(booking).toMatchObject({ status: "pending", checkout_id: checkout.id, record_locator: null });
      expect(booking.reconcile_until?.getTime()).toBe(
        (booking.create_order_started_at?.getTime() ?? 0) + 15 * 60_000,
      );
      expect(await supplierTimeoutReason(booking.id)).toBe(reason);
      expect(stripePosts("/cancel")).toHaveLength(0);
      expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized", booking_id: booking.id });
      expect((await checkoutRow(checkout.id)).status).toBe("payment_pending");

      const again = await complete(checkout.id);

      expect(again.status).toBe(504);
      expect(creates).toBe(1);
    },
  );

  it("[OBE-042 AC2] still voids the authorisation and reopens the checkout for an Amadeus 4xx refusal", async () => {
    const { checkout, payment } = await paidCheckout();

    const refused = await complete(checkout.id, { extra: stubScenario("sold-out") });

    expect(refused.status).toBe(409);
    const [failed] = await bookingsOfCheckout(checkout.id);
    expect(failed).toMatchObject({ status: "failed", checkout_id: null });
    expect((await bookingRow(failed?.id ?? "")).reconcile_until).toBeNull();
    expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled" });
    expect((await checkoutRow(checkout.id)).status).toBe("open");
  });
});

describe("a checkout whose booking is pending (FIX-W22)", () => {
  it("[FIX-W22 AC3] refuses travellers, contacts, special requests, extras, a new payment and a payment update with 409 CHECKOUT_BEING_COMPLETED", async () => {
    const { checkout, payment } = await paidCheckout();
    const bag = await oneBagOf(checkout.pricedOfferId);
    // An Amadeus 500 leaves the claim pending (the order may exist), as during the call itself.
    const timedOut = await complete(checkout.id, { extra: stubScenario("server-error") });
    expect(timedOut.status).toBe(504);
    const bookingId = String((timedOut.body as ErrorBody).error.details?.["bookingId"]);
    const before = await checkoutRow(checkout.id);
    stub.clearRequests();
    stripe.reset();

    const answers = [
      [
        "setCheckoutTravelers",
        await request(api.server)
          .put(`/v1/checkouts/${checkout.id}/travelers`)
          .set(headers())
          .send({ travelers: [buildTravelerInput()] }),
      ],
      [
        "setCheckoutContacts",
        await request(api.server)
          .put(`/v1/checkouts/${checkout.id}/contacts`)
          .set(headers())
          .send({ contacts: [buildContactInput()] }),
      ],
      [
        "setCheckoutRemarks",
        await request(api.server)
          .put(`/v1/checkouts/${checkout.id}/remarks`)
          .set(headers())
          .send({ remarks: [] }),
      ],
      [
        "setCheckoutAncillaries",
        await request(api.server)
          .put(`/v1/checkouts/${checkout.id}/ancillaries`)
          .set(headers())
          .send({ selections: [{ optionId: bag.id, travelerId: "1" }] }),
      ],
      [
        "createCheckoutPayment",
        await request(api.server)
          .post(`/v1/checkouts/${checkout.id}/payments`)
          .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
          .send({ method: "card", termsAccepted: true }),
      ],
      [
        "updatePayment",
        await request(api.server)
          .patch(`/v1/payments/${payment.id}`)
          .set(headers())
          .send({ card: { brand: "VISA", bin: "424242" } }),
      ],
    ] as const;

    for (const [operationId, res] of answers) {
      expect([operationId, res.status]).toEqual([operationId, 409]);
      expectResponseToMatch(operationId, res);
      expect([operationId, res.body]).toEqual([
        operationId,
        {
          error: expect.objectContaining({
            code: "CHECKOUT_BEING_COMPLETED",
            status: 409,
            details: { bookingId },
          }),
        },
      ]);
    }
    // Nothing changed, nothing was priced or charged, and the authorisation of the booking is still there.
    expect(await checkoutRow(checkout.id)).toEqual(before);
    expect(stub.requests()).toEqual([]);
    expect(stripe.requests).toEqual([]);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized", booking_id: bookingId });
    expect(await bookingRow(bookingId)).toMatchObject({ status: "pending", checkout_id: checkout.id });
  });
});

describe("checkout.complete re-pricing a checkout with extras (FIX-W22)", () => {
  it("[FIX-W22 AC1] prices the offers again with the same extras past the threshold: the order and the booking totals keep them", async () => {
    const withExtras = await withBag(fresh);
    const total = withExtras.totals.total.amount;
    const ancillaries = withExtras.totals.ancillaries?.amount ?? "";
    expect(Number(ancillaries)).toBeGreaterThan(0);
    const payment = await payCheckout(withExtras);
    await ageOffer(withExtras.pricedOfferId);
    stub.clearRequests();

    const res = await complete(withExtras.id);

    expect(res.status).toBe(201);
    expectResponseToMatch("completeCheckout", res);
    const { booking } = res.body as CompletionBody & {
      booking: { totals: { total: Money; ancillaries: Money } };
    };
    expect(booking.totals).toMatchObject({
      total: { amount: total, currency: "EUR" },
      ancillaries: { amount: ancillaries, currency: "EUR" },
    });
    // One Flight Offers Price with the bag, then the order with it, from the new priced offer.
    expect(amadeusCalls("quoteAirOffers")).toHaveLength(1);
    const [pricing] = await supplierRequestBodies(booking.id, "quoteAirOffers");
    expect(additionalServicesOf(pricing)).toContainEqual(
      expect.objectContaining({ chargeableCheckedBags: expect.objectContaining({ quantity: 1 }) }),
    );
    const [order] = await supplierRequestBodies(booking.id, "createFligtOrders");
    expect(additionalServicesOf(order)).toEqual(additionalServicesOf(pricing));
    const after = await checkoutRow(withExtras.id);
    expect(after.priced_offer_id).not.toBe(withExtras.pricedOfferId);
    expect(await parentOf(after.priced_offer_id)).toBe(withExtras.basePricedOfferId);
    expect(after).toMatchObject({ status: "completed", total, ancillaries, balanced: true });
    expect(await extraRows(withExtras.id)).toEqual([
      expect.objectContaining({ type: "CHECKED_BAGS", price: ancillaries }),
    ]);
    expect(await bookingRow(booking.id)).toMatchObject({
      status: "ticketed",
      priced_offer_id: after.priced_offer_id,
      total,
      ancillaries,
      netServices: ancillaries,
      paid: total,
    });
    expect(await paymentRow(payment.id)).toMatchObject({ status: "captured", captured: total });
    // The log line says that the offers were priced again, never what Amadeus answered (AGENTS.md §8: no bodies).
    const completed = api.sink
      .records()
      .filter((line) => line["msg"] === "bookings.completed" && line["bookingId"] === booking.id);
    expect(completed).toEqual([expect.objectContaining({ repriced: true })]);
    expect(JSON.stringify(completed)).not.toContain("travelerPricings");
  });

  it("[FIX-W22 AC1] answers 409 PRICE_CHANGED for a higher price with the extras: the checkout moves with them, nothing is booked", async () => {
    const withExtras = await withBag(fresh);
    const payment = await payCheckout(withExtras);
    await ageOffer(withExtras.pricedOfferId);

    const res = await complete(withExtras.id, { extra: stubScenario("price-changed") });

    expect(res.status).toBe(409);
    expectResponseToMatch("completeCheckout", res);
    const error = (res.body as ErrorBody).error;
    expect(error.code).toBe("PRICE_CHANGED");
    const after = await checkoutRow(withExtras.id);
    expect(error.details).toMatchObject({
      oldPrice: withExtras.totals.total,
      newPrice: { amount: after.total, currency: "EUR" },
      pricedOfferId: after.priced_offer_id,
    });
    expect(error.details).not.toHaveProperty("reason");
    // The new priced offer is the fare with the bag again; the bag keeps its price.
    expect(await parentOf(after.priced_offer_id)).toBe(withExtras.basePricedOfferId);
    expect(after).toMatchObject({
      status: "open",
      ancillaries: withExtras.totals.ancillaries?.amount,
      balanced: true,
    });
    expect(Number(after.total)).toBeGreaterThan(Number(withExtras.totals.total.amount));
    expect(await extraRows(withExtras.id)).toHaveLength(1);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled" });
  });

  /** Lets the API's Amadeus client change the answer, or the failure, of its Flight Offers Price calls with extras. */
  function onPricingWithExtras(change: (body: Record<string, unknown>) => void | never): void {
    const client = api.app.get(AmadeusClient, { strict: false });
    const real = client.quoteAirOffers.bind(client);
    vi.spyOn(client, "quoteAirOffers").mockImplementation(async (context, input) => {
      const reply = await real(context, input);
      if (additionalServicesOf(input.body).length > 0) {
        change(reply.body as Record<string, unknown>);
      }
      return reply;
    });
  }

  it("[FIX-W22 AC1] never books without an extra Amadeus no longer confirms: 409 PRICE_CHANGED, the extra removed, the authorisation voided", async () => {
    const withExtras = await withBag(fresh);
    const payment = await payCheckout(withExtras);
    await ageOffer(withExtras.pricedOfferId);
    // Amadeus answers the pricing without the bag.
    onPricingWithExtras((body) => {
      for (const services of additionalServicesOf(body)) {
        delete (services as Record<string, unknown>)["chargeableCheckedBags"];
      }
    });

    const res = await complete(withExtras.id);

    expect(res.status).toBe(409);
    expectResponseToMatch("completeCheckout", res);
    const error = (res.body as ErrorBody).error;
    const after = await checkoutRow(withExtras.id);
    expect(error).toMatchObject({
      code: "PRICE_CHANGED",
      details: {
        reason: "extras_unavailable",
        oldPrice: withExtras.totals.total,
        newPrice: { amount: after.total, currency: "EUR" },
        pricedOfferId: after.priced_offer_id,
      },
    });
    expect(after).toMatchObject({ status: "open", ancillaries: "0.00", balanced: true });
    expect(after.total).toBe(withExtras.totals.offer?.amount);
    expect(await extraRows(withExtras.id)).toEqual([]);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled" });
  });

  it("[FIX-W22 AC1] prices the flights alone when Amadeus refuses an extra, and answers 409 PRICE_CHANGED without it", async () => {
    const withExtras = await withBag(fresh);
    const payment = await payCheckout(withExtras);
    await ageOffer(withExtras.pricedOfferId);
    const client = api.app.get(AmadeusClient, { strict: false });
    const real = client.quoteAirOffers.bind(client);
    vi.spyOn(client, "quoteAirOffers").mockImplementation(async (context, input) => {
      if (additionalServicesOf(input.body).length > 0) {
        throw mapAmadeusError("quoteAirOffers", {
          kind: "http",
          status: 400,
          issues: [
            {
              status: 400,
              code: 4926,
              title: "INVALID DATA RECEIVED",
              source: {
                pointer: "/data/flightOffers/0/travelerPricings/0/fareDetailsBySegment/0/additionalServices",
              },
            },
          ],
        });
      }
      return await real(context, input);
    });

    const res = await complete(withExtras.id);

    expect(res.status).toBe(409);
    expectResponseToMatch("completeCheckout", res);
    const after = await checkoutRow(withExtras.id);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: "PRICE_CHANGED",
      details: { reason: "extras_unavailable", pricedOfferId: after.priced_offer_id },
    });
    // The flights priced again without extras (a child of the priced offer the checkout was buying).
    expect(await parentOf(after.priced_offer_id)).toBe(withExtras.pricedOfferId);
    expect(after).toMatchObject({ status: "open", ancillaries: "0.00", balanced: true });
    expect(await extraRows(withExtras.id)).toEqual([]);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled" });
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

describe("checkout.complete's lock order (FIX-W24-BOOKINGS)", () => {
  it("[FIX-W24-BOOKINGS AC5] locks the booking before the payment in the capture's transaction: the payment is free while it waits", async () => {
    const { checkout, payment } = await paidCheckout();
    // When Stripe is asked to capture (no transaction open: OBE-042 AC3), the probe takes the booking. The capture's
    // transaction then waits for it; the probe checks that it waits without the payment's lock, and lets it go.
    let probe: LockOrderProbe | undefined;
    stripe.onRequest(async (req) => {
      if (req.method !== "POST" || !req.path.endsWith("/capture") || probe !== undefined) {
        return;
      }
      const { bookingId } = await alphaTx((trx) =>
        trx
          .selectFrom("payments")
          .select("booking_id as bookingId")
          .where("id", "=", payment.id)
          .executeTakeFirstOrThrow(),
      );
      if (bookingId === null) {
        throw new Error("the payment has no booking at its capture");
      }
      probe = probeLockOrder(tenantDb, "tenant_alpha", { bookingId, paymentId: payment.id });
      await probe.locked;
    });

    const res = await complete(checkout.id);

    expect(res.status).toBe(201);
    expectResponseToMatch("completeCheckout", res);
    expect(await probe?.result).toEqual({ waiterSeen: true, paymentFree: true });
    const { booking } = res.body as CompletionBody;
    expect(await paymentRow(payment.id)).toMatchObject({ status: "captured", booking_id: booking.id });
    expect((await bookingRow(booking.id)).paid).toBe(checkout.totals.total.amount);
  });
});

describe("checkout.complete's lock order of the checkout (FIX-W25-BOOKINGS)", () => {
  /**
   * Completes `checkoutId` with a probe (test/helpers/lock-order.ts) that takes the checkout while Flight Create Orders
   * is sent (no transaction open: OBE-042 AC3), then probes the booking; `respond` answers the request instead of the
   * stub. The transaction after the call (T2, the failure, the unknown outcome) must wait for the checkout without the
   * booking's lock: the lead decision of 2026-10-21 (checkout, booking, payment, refund).
   */
  async function completeWhileCheckoutHeld(
    checkoutId: string,
    options: { readonly extra?: Record<string, string>; readonly respond?: () => Response } = {},
  ) {
    let probe: RowLockOrderProbe | undefined;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (
        probe === undefined &&
        url.startsWith(stub.url) &&
        new URL(url).pathname === "/v1/booking/flight-orders"
      ) {
        const [pending] = await bookingsOfCheckout(checkoutId);
        if (pending === undefined) {
          throw new Error("Flight Create Orders before the claim");
        }
        probe = probeRowLockOrder(tenantDb, "tenant_alpha", {
          held: { table: "checkouts", id: checkoutId },
          probed: { table: "bookings", id: pending.id },
        });
        await probe.locked;
        return options.respond?.() ?? (await realFetch(input, init));
      }
      return await realFetch(input, init);
    });
    const res = await complete(checkoutId, options.extra === undefined ? {} : { extra: options.extra });
    expectResponseToMatch("completeCheckout", res);
    return { status: res.status, seen: await probe?.result };
  }

  it("[FIX-W25-BOOKINGS AC3] records the order (T2) with the checkout locked before the booking", async () => {
    const { checkout } = await paidCheckout();

    const { status, seen } = await completeWhileCheckoutHeld(checkout.id);

    expect(status).toBe(201);
    expect(seen).toEqual({ waiterSeen: true, probedFree: true });
    expect((await checkoutRow(checkout.id)).status).toBe("completed");
  });

  it("[FIX-W25-BOOKINGS AC3] fails a refused order with the checkout locked before the booking and the payment", async () => {
    const { checkout, payment } = await paidCheckout();

    const { status, seen } = await completeWhileCheckoutHeld(checkout.id, {
      extra: stubScenario("sold-out"),
    });

    expect(status).toBe(409);
    expect(seen).toEqual({ waiterSeen: true, probedFree: true });
    expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled" });
    expect((await checkoutRow(checkout.id)).status).toBe("open");
  });

  it("[FIX-W25-BOOKINGS AC3] keeps an unknown outcome after a re-price with the checkout locked before the booking", async () => {
    const { checkout } = await paidCheckout();
    await ageOffer(checkout.pricedOfferId);
    const unavailable = (): Response =>
      new Response(
        JSON.stringify({ errors: [{ status: 503, code: 141, title: "SYSTEM ERROR HAS OCCURRED" }] }),
        {
          status: 503,
          headers: { "content-type": "application/vnd.amadeus+json" },
        },
      );

    const { status, seen } = await completeWhileCheckoutHeld(checkout.id, { respond: unavailable });

    expect(status).toBe(504);
    expect(seen).toEqual({ waiterSeen: true, probedFree: true });
    // The unknown outcome moved the checkout to the re-priced offer, as the order sent holds it.
    expect((await checkoutRow(checkout.id)).priced_offer_id).not.toBe(checkout.pricedOfferId);
  });
});

describe("checkout.complete when its claim was decided before the order was sent (FIX-W25-BOOKINGS)", () => {
  /**
   * Completes `checkout` with a priced offer older than ten minutes; while it is priced again (after the claim, before
   * Flight Create Orders), `decide` changes the pending booking as a reconciliation that adopted the claim would
   * (OADR-0003 point 4). The step that records what is sent (`recordSending`) must then send nothing.
   */
  async function completeDecidedWhileRepriced(
    checkout: CheckoutBody,
    decide: (bookingId: string) => Promise<void>,
  ) {
    await ageOffer(checkout.pricedOfferId);
    const client = api.app.get(AmadeusClient, { strict: false });
    const real = client.quoteAirOffers.bind(client);
    let bookingId: string | undefined;
    vi.spyOn(client, "quoteAirOffers").mockImplementation(async (context, input, options) => {
      const reply = await real(context, input, options);
      const [pending] = await bookingsOfCheckout(checkout.id);
      if (bookingId === undefined && pending?.status === "pending") {
        bookingId = pending.id;
        await decide(pending.id);
      }
      return reply;
    });
    stub.clearRequests();
    const res = await complete(checkout.id);
    expectResponseToMatch("completeCheckout", res);
    if (bookingId === undefined) {
      throw new Error("the completion did not price the offers again after its claim");
    }
    return { res, bookingId };
  }

  it("[FIX-W25-BOOKINGS AC2] sends no order for a booking the reconciliation failed meanwhile, and leaves its money to it", async () => {
    const { checkout, payment } = await paidCheckout();

    const { res, bookingId } = await completeDecidedWhileRepriced(checkout, async (id) => {
      // As the reconciliation's not-found decision writes it (it voids the authorisation through ota-payments).
      await alphaTx((trx) =>
        trx
          .updateTable("bookings")
          .set({
            status: "failed",
            ticketing_status: "not_applicable",
            checkout_id: null,
            failure_code: "SUPPLIER_TIMEOUT",
            reconcile_until: sql<Date>`now()`,
            reconcile_outcome: "not_found",
          })
          .where("id", "=", id)
          .execute(),
      );
    });

    expect(res.status).toBe(502);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: "SUPPLIER_ERROR",
      details: { bookingId, bookingStatus: "failed" },
    });
    expect(amadeusCalls("quoteAirOffers")).toHaveLength(1);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    // Nothing of the request's own: no capture, no void, the decision's booking as it was.
    expect(stripePosts("/capture")).toHaveLength(0);
    expect(stripePosts("/cancel")).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized" });
    expect(await bookingRow(bookingId)).toMatchObject({
      status: "failed",
      failure_code: "SUPPLIER_TIMEOUT",
      priced_offer_id: checkout.pricedOfferId,
    });
  });

  it("[FIX-W25-BOOKINGS AC2] sends no order for a booking the reconciliation put in the staff's review meanwhile", async () => {
    const { checkout, payment } = await paidCheckout();

    const { res, bookingId } = await completeDecidedWhileRepriced(checkout, async (id) => {
      await alphaTx((trx) =>
        trx
          .updateTable("bookings")
          .set({
            ticketing_status: "manual_review",
            reconcile_until: sql<Date>`now()`,
            reconcile_outcome: "manual_review",
          })
          .where("id", "=", id)
          .execute(),
      );
    });

    expect(res.status).toBe(504);
    expect((res.body as ErrorBody).error).toMatchObject({ code: "SUPPLIER_TIMEOUT", details: { bookingId } });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    expect(stripePosts("/capture")).toHaveLength(0);
    expect(stripePosts("/cancel")).toHaveLength(0);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized" });
    expect(await bookingRow(bookingId)).toMatchObject({ status: "pending", checkout_id: checkout.id });
    expect((await checkoutRow(checkout.id)).status).toBe("payment_pending");
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
    const booking = await bookingRow(bookingId);
    expect(booking).toMatchObject({
      status: "pending",
      checkout_id: checkout.id,
      record_locator: null,
    });
    // An unknown outcome like a lost answer (FIX-W22, OADR-0003 point 4): the reconciliation looks for it.
    expect(booking.reconcile_until?.getTime()).toBe(
      (booking.create_order_started_at?.getTime() ?? 0) + 15 * 60_000,
    );
    expect(await supplierTimeoutReason(bookingId)).toBe("record_failed");
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

describe("checkout.complete's issuance while a cancellation holds the booking (FIX-W32-OTA)", () => {
  const cancellations = new CancellationRepository();
  const ticketing = new TicketingRepository();

  /**
   * The barrier: when Stripe is asked to capture (after the record step's commit, before the issuance, no transaction
   * open), `hold` commits a cancellation's hold of the booking in a transaction of its own that claims the booking as
   * T1 of bookings.cancel does (`FOR NO KEY UPDATE SKIP LOCKED`); the capture answers only once it committed, so the
   * issuance's claim comes after it, every run.
   */
  function holdAtCapture(
    paymentId: string,
    hold: (trx: TenantTransaction, bookingId: string) => Promise<void>,
  ): { readonly bookingId: () => string } {
    let held: string | undefined;
    stripe.onRequest(async (req) => {
      if (req.method !== "POST" || !req.path.endsWith("/capture") || held !== undefined) {
        return;
      }
      const { bookingId } = await alphaTx((trx) =>
        trx
          .selectFrom("payments")
          .select("booking_id as bookingId")
          .where("id", "=", paymentId)
          .executeTakeFirstOrThrow(),
      );
      if (bookingId === null) {
        throw new Error("the payment has no booking at its capture");
      }
      held = bookingId;
      await alphaTx(async (trx) => {
        if (!(await cancellations.lock(trx, bookingId, true))) {
          throw new Error("the booking is held by another transaction at its capture");
        }
        await hold(trx, bookingId);
      });
    });
    return {
      bookingId: () => {
        if (held === undefined) {
          throw new Error("the capture never came");
        }
        return held;
      },
    };
  }

  /** Whether the ticketing job would claim the booking now (its scan lists it, and its claim does not skip it). */
  async function jobWouldClaim(bookingId: string): Promise<string | undefined> {
    return await alphaTx(async (trx) => {
      const now = new Date();
      const due = await ticketing.dueBookingIds(trx, { now, paidOnly: false, limit: 1000 });
      if (!due.includes(bookingId)) {
        return "not_listed";
      }
      const row = await ticketing.lock(trx, bookingId, { skipLocked: true });
      return row === undefined ? "not_claimable" : claimSkip(row, now, "active");
    });
  }

  async function expectHeldIssuance(res: { status: number; body: unknown }, paymentId: string) {
    expect(res.status).toBe(201);
    expectResponseToMatch("completeCheckout", res);
    const { booking } = res.body as CompletionBody;
    // Confirmed and paid; no Flight Order Issue went to the order whose cancellation was in flight.
    expect(booking).toMatchObject({ status: "confirmed", ticketing: { status: "pending" } });
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "captured", booking_id: booking.id });
    const row = await bookingRow(booking.id);
    expect(row).toMatchObject({ status: "confirmed", ticketing_status: "pending", issue_requested: false });
    // Left to the ticketing job: due now, as the payments queue's safety net makes it.
    expect(row.ticketing_next_attempt_at).toBeInstanceOf(Date);
    expect(api.sink.text()).toContain("bookings.issue_held_by_cancellation");
    return booking.id;
  }

  it("[FIX-W32-OTA AC1] sends no Flight Order Issue when a cancellation's claim committed between the confirmation and the issuance, and leaves the booking due for the ticketing job once the claim ends", async () => {
    const { checkout, payment } = await paidCheckout();
    let claimedAt: Date | undefined;
    const barrier = holdAtCapture(payment.id, async (trx, bookingId) => {
      claimedAt = new Date();
      await cancellations.claim(trx, bookingId, claimedAt);
    });

    const res = await complete(checkout.id);

    const bookingId = await expectHeldIssuance(res, payment.id);
    expect(bookingId).toBe(barrier.bookingId());
    // While the cancellation's DELETE is in flight the job skips the booking, as it skips any booking it holds.
    expect(await jobWouldClaim(bookingId)).toBe("cancellation_pending");
    // The DELETE applied nothing (the airline refused it, Amadeus's 2552): the claim's release lets the job issue.
    const marker = claimedAt;
    if (marker === undefined) {
      throw new Error("the barrier wrote no claim");
    }
    await alphaTx((trx) => cancellations.releaseClaim(trx, bookingId, marker));
    expect(await jobWouldClaim(bookingId)).toBeUndefined();
  });

  it("[FIX-W32-OTA AC1] sends no Flight Order Issue while a cancellation's DELETE without an answer is undecided", async () => {
    const { checkout, payment } = await paidCheckout();
    holdAtCapture(payment.id, async (trx, bookingId) => {
      const now = new Date();
      // The flag of a DELETE without an answer (cancellation.service.ts recordUnknownOutcome), its claim released.
      await trx
        .insertInto("booking_events")
        .values({
          id: newId("evt"),
          booking_id: bookingId,
          type: "booking.cancellation_timeout",
          actor_type: "system",
          actor_id: null,
          summary: "Amadeus did not confirm the cancellation.",
          data: JSON.stringify({
            mode: "release",
            reasonCode: "change_of_plans",
            estimate: { amountPaid: "0.00", estimatedRefund: "0.00", penalty: "0.00", otaFee: "0.00" },
            currency: "EUR",
            requestedAt: now.toISOString(),
            until: new Date(now.getTime() + 15 * 60_000).toISOString(),
            actor: { type: "system", id: null },
            requestId: "req_test",
            reason: "SUPPLIER_TIMEOUT",
          }),
          visible_to_customer: false,
          created_at: now,
          updated_at: now,
        })
        .execute();
    });

    const res = await complete(checkout.id);

    const bookingId = await expectHeldIssuance(res, payment.id);
    expect(await jobWouldClaim(bookingId)).toBe("cancellation_pending");
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
