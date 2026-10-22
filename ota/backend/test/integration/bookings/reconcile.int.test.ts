// The reconciliation of a timed-out Flight Create Orders and the replay of its 504 (OBE-043, OF-04 AC3; OADR-0003
// points 4–6, ota/docs/architecture-booking.md §4 and §5.2) against PostgreSQL 16, Redis 7, the Amadeus stub and the
// fake Stripe API of test/helpers/fake-stripe.ts. Both processes run in-process on the same database and Redis:
//
//   - the API's module graph (createTestApp): checkout.complete with alpha's secret key, whose Flight Create Orders the
//     stub answers with its `timeout` scenario (the order is stored, then the answer is held and given up with a 504)
//     or `timeout-lost` (nothing is stored), and the same-key retries the idempotency hooks answer from the booking;
//   - the worker's module graph (WorkerModule.forRoot, as dist/worker.js builds it): the `ota-bookings` consumer with
//     the reconciliation, the `bookings.reconcile_scan` handler, the `ota-payments` consumer that voids, and the
//     ticketing attempt; their Amadeus client reads the account's `base_url` (the stub), their Stripe client the fake.
//
// The stub holds a `timeout` answer for 100 ms instead of 30 s (its timers option). The API, the stub and the PNRs'
// creation times run on the real clock; the worker's `Clock` is pointed at a FakeClock that each step sets relative to
// the booking's `create_order_started_at`, so "30 seconds", "14 minutes" and "15 minutes later" take no time. The file
// plays the scheduler: the first `booking.reconcile` the API queues (30 s delayed) is promoted, and a scan iteration is
// the per-tenant `bookings.reconcile_scan` job of its minute. The Amadeus token buckets are emptied of their state
// before each scenario (the worker's clock goes back between scenarios, which would freeze a bucket's refill).
//
// FIX-W24-BOOKINGS (lead decision of 2026-10-21): two scenarios make a stale claim, a completion whose unknown-outcome
// write fails (`staleClaim`), and let the scan adopt it after 2 minutes, then reconcile it like any unknown outcome.
//
// FIX-W25-BOOKINGS (lead decisions of 2026-10-21, third batch): the search reads every PNR that may be the order (more
// than three of one minute, the order read last: the stub's clock is moved a minute back while the order is created,
// so the PNRs of the claim's minute are closer to it and read first), a search that could not read them all (a Queue
// List that may leave PNRs out, a read that times out) never voids and ends in the staff's review, an adopted claim
// whose re-price lowered the price is captured for the re-priced total, and the decisions lock the checkout before
// the booking (test/helpers/lock-order.ts).
//
// Each scenario runs in its `beforeAll` hook, with a budget of its own, and keeps what it saw; its tests read it.
// Every API answer is checked against the OTA document (`expectResponseToMatch`). The Stripe keys and the Amadeus
// credentials are built at run time.
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Module, type INestApplicationContext } from "@nestjs/common";
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
  FakeClock,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { startAmadeusStub, stubScenario, type AmadeusStub } from "@velexis/testing/amadeus";
import { AppError } from "@velexis/errors";
import type { Job, Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { OrderRecorder, readCreatedOrder } from "../../../src/bookings/order-recorder";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import {
  RECONCILE_SCAN_JOB,
  ReconcileScan,
  type ReconcileJobResult,
} from "../../../src/bookings/reconcile.processor";
import {
  RECONCILE_ADOPTED_EVENT,
  RECONCILE_DEADLINE_RETRIES,
  RECONCILE_DEADLINE_RETRY_EVENT,
  RECONCILE_JOB,
  RECONCILE_MANUAL_REVIEW_EVENT,
  RECONCILE_QUEUE_LIST_MAX,
  reconcileJobId,
  ReconcileRepository,
  type AdoptedClaim,
} from "../../../src/bookings/reconcile.service";
import { BOOKING_TOKEN_PATTERN } from "../../../src/common/auth/booking-access.guard";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import { jobTenant, minuteBucket, tenantJob } from "../../../src/jobs/fan-out";
import { Money } from "../../../src/pricing/pricing.types";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { PlatformCache } from "../../../src/tenancy/platform-cache";
import { TenantContext } from "../../../src/tenancy/tenant-context";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderRequestInput, buildOrderTraveler, buildStripeConfirmation } from "../../builders/bookings";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import { newApiKey, testApiCredentials, testKeyProvider, testWorkerVariables } from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import {
  holdKeyShare,
  probeRowLockOrder,
  type KeyShareHolder,
  type RowLockOrderObservation,
} from "../../helpers/lock-order";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const OPS_EMAIL = "ops@alpha-travel.example";
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

/**
 * The budget of a scenario hook: a search, a priced offer, a checkout with its traveller, contact and payment (eight
 * API calls), a timed-out completion, a few same-key retries and up to four worker attempts with their Amadeus,
 * Stripe and database work. Seconds locally, much longer on a busy 4-CPU runner.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a hook waits at most for the worker to finish a job it added (they take milliseconds to a second). */
const JOB_WAIT = { timeout: 15_000, interval: 25 } as const;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let worker: INestApplicationContext;
let stub: AmadeusStub;
let stripe: FakeStripe;
let keys: KeyProvider;
let migratorPool: ReturnType<typeof createPool>;
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let alphaId: string;
let alphaSk: string;
let office: string;
let bookingsQueue: Queue;
let paymentsQueue: Queue;
let maintenance: Queue;
/** The worker's time (see the file header). */
const clock = new FakeClock();
/**
 * The stub's time: the real clock, `stubShiftMs` apart. A scenario moves it a minute back while Flight Create Orders
 * creates the order, so Queue List gives the order an earlier minute than the PNRs created after it.
 */
let stubShiftMs = 0;
const stubClock = { now: (): Date => new Date(Date.now() + stubShiftMs) };

const quietPoolLogger = { error: (): void => undefined };

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
      // The stub, as dev:seed writes it in development: the worker reads the account's base URL.
      base_url: stub.url,
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

async function insertTenant(accountId: string): Promise<string> {
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

interface CompletionBody {
  readonly checkoutId: string;
  readonly booking: {
    readonly id: string;
    readonly reference: string;
    readonly status: string;
    readonly recordLocator: string | null;
    readonly tickets: ReadonlyArray<{ readonly documentNumber: string }>;
    readonly payments: ReadonlyArray<{ readonly id: string; readonly status: string }>;
    readonly totals: { readonly total: { readonly amount: string; readonly currency: string } };
  };
  readonly bookingToken: string | null;
  readonly bookingTokenExpiresAt: string | null;
}

interface CheckoutBody {
  readonly id: string;
  readonly pricedOfferId: string;
  readonly totals: { readonly total: { readonly amount: string; readonly currency: string } };
}

interface PaymentBody {
  readonly id: string;
  readonly providerPaymentId: string | null;
}

/** A supertest answer, as a scenario keeps it. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
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

/**
 * A guest checkout of alpha with its traveller (last name SAMPLE, or `lastName`) and contact, paid with a confirmed card
 * payment.
 */
async function paidCheckout(lastName?: string): Promise<{
  readonly checkout: CheckoutBody;
  readonly payment: PaymentBody;
  readonly contactEmail: string;
}> {
  const pricedOfferId = await newPricedOffer();
  const created = await request(api.server)
    .post("/v1/checkouts")
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({ pricedOfferId });
  expect(created.status).toBe(201);
  const checkoutId = (created.body as CheckoutBody).id;
  const traveler = buildTravelerInput();
  const travelers = await request(api.server)
    .put(`/v1/checkouts/${checkoutId}/travelers`)
    .set(headers())
    .send({
      travelers: [lastName === undefined ? traveler : { ...traveler, name: { ...traveler.name, lastName } }],
    });
  expect(travelers.status).toBe(200);
  const contact = buildContactInput();
  const contacts = await request(api.server)
    .put(`/v1/checkouts/${checkoutId}/contacts`)
    .set(headers())
    .send({ contacts: [contact] });
  expect(contacts.status).toBe(200);
  const checkout = contacts.body as CheckoutBody;
  const paid = await request(api.server)
    .post(`/v1/checkouts/${checkoutId}/payments`)
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({ method: "card", termsAccepted: true });
  expect(paid.status).toBe(201);
  const payment = paid.body as PaymentBody;
  const minor = Math.round(Number(checkout.totals.total.amount) * 100);
  stripe.update(payment.providerPaymentId ?? "", buildStripeConfirmation(minor));
  return { checkout, payment, contactEmail: contact.emailAddress ?? "" };
}

async function complete(
  checkoutId: string,
  options: { readonly key?: string; readonly extra?: Record<string, string> } = {},
): Promise<Answer> {
  const res = await request(api.server)
    .post(`/v1/checkouts/${checkoutId}/complete`)
    .set({ ...headers(), "Idempotency-Key": options.key ?? idempotencyKey(), ...options.extra })
    .send({});
  expectResponseToMatch("completeCheckout", res);
  return { status: res.status, body: res.body as unknown, headers: res.headers as Record<string, string> };
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
        "ticketing_requested_at",
        "checkout_id",
        "priced_offer_id",
        "record_locator",
        "failure_code",
        "create_order_started_at",
        "reconcile_until",
        "reconcile_attempts",
        "reconcile_outcome",
        sql<string>`total_amount::text`.as("total"),
        sql<string>`amount_paid::text`.as("paid"),
      ])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
  );
}

async function paymentRow(paymentId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("payments")
      .select(["id", "status", "booking_id"])
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow(),
  );
}

async function checkoutStatus(checkoutId: string): Promise<string> {
  return (await checkoutRow(checkoutId)).status;
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

/** Makes a priced offer older than the re-price threshold (ten minutes), so checkout.complete prices it again. */
async function ageOffer(pricedOfferId: string): Promise<void> {
  await alphaTx((trx) =>
    trx
      .updateTable("priced_offers")
      .set({ created_at: sql<Date>`now() - interval '11 minutes'` })
      .where("id", "=", pricedOfferId)
      .execute(),
  );
}

async function eventTypes(bookingId: string): Promise<string[]> {
  const rows = await alphaTx((trx) =>
    trx.selectFrom("booking_events").select("type").where("booking_id", "=", bookingId).execute(),
  );
  return rows.map((row) => row.type).sort();
}

async function notificationsOf(bookingId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("notifications")
      .select(["template_key as templateKey", "recipient", "recipient_type as recipientType", "payload"])
      .where("booking_id", "=", bookingId)
      .orderBy("template_key")
      .execute(),
  );
}

/** The stub's requests of one Amadeus operation, from now on (`stub.clearRequests()` at the start of a scenario). */
const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

const stripePosts = (suffix: string) =>
  stripe.requests.filter((req) => req.method === "POST" && req.path.endsWith(suffix));

/**
 * The POSTs about one payment's PaymentIntent (`stripePosts`): a scenario that ends with a not-found decision leaves its
 * `payment.void` to the worker, whose cancel can reach the fake after the next scenario's `stripe.reset()`.
 */
const stripePostsOf = (payment: PaymentBody, suffix: string) =>
  stripePosts(suffix).filter(
    (req) => payment.providerPaymentId !== null && req.path.includes(`/${payment.providerPaymentId}/`),
  );

/** The job with this id once the worker has finished it, completed (a failed attempt names its reason). */
async function finished(queue: Queue, id: string): Promise<Job> {
  let found: Job | undefined;
  await vi.waitFor(async () => {
    found = await queue.getJob(id);
    expect(
      found?.finishedOn,
      `job ${id} is finished; ${found?.failedReason ?? "no attempt failed"}`,
    ).toBeDefined();
  }, JOB_WAIT);
  if (found === undefined) {
    throw new Error(`job ${id} not found`);
  }
  expect(await found.getState(), `job ${id}: ${found.failedReason ?? ""}`).toBe("completed");
  return found;
}

/** Empties the Amadeus token buckets and the API's throttler counters (see the file header). */
async function resetRateLimits(): Promise<void> {
  const found = await redis.client.keys("rl:*");
  if (found.length > 0) {
    await redis.client.del(...found);
  }
}

/** Points the worker's Clock at the file's FakeClock (restoreMocks undoes it after every test). */
function useWorkerClock(): void {
  vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
}

/** The first `booking.reconcile` of a booking, queued by checkout.complete. */
async function firstJobOf(bookingId: string): Promise<Job | undefined> {
  return (await bookingsQueue.getJob(reconcileJobId(bookingId, "first"))) ?? undefined;
}

/** The first attempt: the worker's clock at `at`, the API's delayed job promoted, its result. */
async function firstAttempt(bookingId: string, at: Date): Promise<ReconcileJobResult> {
  clock.set(at);
  const job = await firstJobOf(bookingId);
  if (job === undefined) {
    throw new Error("checkout.complete queued no booking.reconcile");
  }
  await job.promote();
  return (await finished(bookingsQueue, reconcileJobId(bookingId, "first")))
    .returnvalue as ReconcileJobResult;
}

/**
 * One `bookings.reconcile_scan` of alpha at `at`, as the fan-out enqueues it: its counts (`adopted`, `due`). A scan job
 * of the same minute left by an earlier scenario or step is removed first, so this one runs.
 */
async function scan(at: Date): Promise<Record<string, number>> {
  clock.set(at);
  const job = tenantJob(RECONCILE_SCAN_JOB, alphaId, minuteBucket(at));
  await (await maintenance.getJob(job.opts.jobId))?.remove();
  await maintenance.add(job.name, job.data, job.opts);
  return ((await finished(maintenance, job.opts.jobId)).returnvalue as { counts: Record<string, number> })
    .counts;
}

/** One `bookings.reconcile_scan` of alpha at `at` (`scan`), and the booking's `booking.reconcile` it added. */
async function scanAttempt(bookingId: string, at: Date): Promise<ReconcileJobResult> {
  await scan(at);
  const job = await finished(bookingsQueue, reconcileJobId(bookingId, minuteBucket(at)));
  expect(job.name).toBe(RECONCILE_JOB);
  return job.returnvalue as ReconcileJobResult;
}

/** The booking of a `504 SUPPLIER_TIMEOUT` answer. */
function bookingIdOf(answer: Answer): string {
  const error = (answer.body as ErrorBody).error;
  expect(error.code).toBe("SUPPLIER_TIMEOUT");
  return String(error.details?.["bookingId"]);
}

/** `create_order_started_at` of a booking, plus `ms`. */
const after = (started: Date | null, ms: number): Date => new Date((started?.getTime() ?? 0) + ms);

/** What a scenario's checkout.complete left: its checkout, payment, key, first answer and booking. */
interface TimedOut {
  readonly checkout: CheckoutBody;
  readonly payment: PaymentBody;
  readonly contactEmail: string;
  readonly key: string;
  readonly first: Answer;
  readonly bookingId: string;
  readonly started: Date;
}

/**
 * A paid checkout completed with the stub's `scenario` on Flight Create Orders: the `504` and its pending booking.
 * `prepare` changes the paid checkout before its completion (with `success`, it is what loses the answer);
 * `lastName` is its lead traveller's (SAMPLE otherwise).
 */
async function timedOutCompletion(
  scenario: "timeout" | "timeout-lost" | "success",
  prepare?: (checkout: CheckoutBody) => Promise<void>,
  lastName?: string,
): Promise<TimedOut> {
  await resetRateLimits();
  stub.setDefaultScenario("success");
  stripe.reset();
  const { checkout, payment, contactEmail } = await paidCheckout(lastName);
  await prepare?.(checkout);
  stub.clearRequests();
  const key = idempotencyKey();
  const first = await complete(checkout.id, { key, extra: stubScenario(scenario) });
  expect(first.status).toBe(504);
  const bookingId = bookingIdOf(first);
  const started = (await bookingRow(bookingId)).create_order_started_at;
  if (started === null) {
    throw new Error("a pending booking without create_order_started_at");
  }
  return { checkout, payment, contactEmail, key, first, bookingId, started };
}

/**
 * A stale claim (FIX-W24-BOOKINGS): a completion whose unknown-outcome write fails, as `bookings.reconcile_not_scheduled`
 * logs it. The API's OrderRecorder refuses the `booking.supplier_timeout` event, so that transaction rolls back: the
 * booking stays `pending` without `reconcile_until`, without the event and without its first `booking.reconcile`, its
 * checkout locked and its authorisation held, and the answer is still the `504`. The stub's `scenario` decides whether
 * the order exists; `lastName` is the lead traveller's and `prepare` changes the paid checkout first
 * (`timedOutCompletion`).
 */
async function staleClaim(
  scenario: "timeout" | "timeout-lost" | "success",
  lastName?: string,
  prepare?: (checkout: CheckoutBody) => Promise<void>,
): Promise<TimedOut> {
  const recorder = api.app.get(OrderRecorder, { strict: false });
  const record = recorder.event.bind(recorder);
  const refused = vi.spyOn(recorder, "event").mockImplementation(async (trx, bookingId, event) => {
    if (event.type === "booking.supplier_timeout") {
      throw new Error("the unknown-outcome write failed in the test");
    }
    await record(trx, bookingId, event);
  });
  try {
    return await timedOutCompletion(scenario, prepare, lastName);
  } finally {
    refused.mockRestore();
  }
}

/**
 * Loses the answers of Flight Create Orders the stub gave (the order exists there): the connection is reset on the way
 * back, an unknown outcome (OADR-0003 point 9). Answers the spy to restore.
 */
function loseCreatedOrderAnswers(): { mockRestore(): void } {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const answer = await realFetch(input, init);
    if (url.startsWith(stub.url) && new URL(url).pathname === "/v1/booking/flight-orders" && answer.ok) {
      await answer.arrayBuffer();
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      });
    }
    return answer;
  });
}

/** `amount` (a decimal string) `units` major units lower, as Amadeus would answer a lower fare. */
const lowered = (amount: unknown, units: number): unknown =>
  typeof amount === "string" ? new Money(amount).minus(units).toFixed(2) : amount;

/**
 * Makes the API's Flight Offers Price answer every offer `units` major units cheaper (its base, total and grand total,
 * and each traveller pricing's base and total), as a re-price that lowers the price; answers the spy to restore.
 */
function lowerRepricing(units: number): { mockRestore(): void } {
  const client = api.app.get(AmadeusClient, { strict: false });
  const real = client.quoteAirOffers.bind(client);
  return vi.spyOn(client, "quoteAirOffers").mockImplementation(async (context, input) => {
    const reply = await real(context, input);
    const data = (reply.body as { data?: { flightOffers?: Array<Record<string, unknown>> } }).data;
    for (const offer of data?.flightOffers ?? []) {
      const price = offer["price"] as Record<string, unknown>;
      for (const field of ["base", "total", "grandTotal"]) {
        price[field] = lowered(price[field], units);
      }
      for (const pricing of (offer["travelerPricings"] ?? []) as Array<Record<string, unknown>>) {
        const own = pricing["price"] as Record<string, unknown>;
        own["base"] = lowered(own["base"], units);
        own["total"] = lowered(own["total"], units);
      }
    }
    return reply;
  });
}

/** The `booking.reconcile_adopted` events of a booking. */
async function adoptedEvents(bookingId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("booking_events")
      .select(["actor_type as actorType", "visible_to_customer as visible", "data"])
      .where("booking_id", "=", bookingId)
      .where("type", "=", RECONCILE_ADOPTED_EVENT)
      .execute(),
  );
}

/**
 * A decoy order on alpha's booking queue, created through the worker's Amadeus client: its record locator. Its
 * traveller's last name is SAMPLE, or `lastName`.
 */
async function createDecoy(
  adjust: (data: Record<string, unknown>) => void,
  lastName?: string,
): Promise<string> {
  const tenant = await worker.get(PlatformCache, { strict: false }).tenantById(alphaId);
  if (tenant === null) {
    throw new Error("alpha is not readable");
  }
  const requestId = `reconcile-test-${randomBytes(4).toString("hex")}`;
  const built = buildCreateOrderRequest(
    buildOrderRequestInput({
      reference: newBookingReference(),
      queue: { number: 50, category: 0 },
      offices: { queuing: office, owner: office },
      issue: false,
      ...(lastName === undefined ? {} : { travelers: [buildOrderTraveler({ travelerId: "1", lastName })] }),
    }),
  );
  adjust((built.body as { data: Record<string, unknown> }).data);
  const reply = await worker
    .get(TenantContext, { strict: false })
    .run(jobTenant(tenant, { id: requestId, name: "setup" }), () =>
      worker.get(AmadeusClient, { strict: false }).createFlightOrders(
        { tenantId: tenant.id, environment: "test", operation: "test.setup", requestId },
        {
          body: built.body as unknown as Parameters<AmadeusClient["createFlightOrders"]>[1]["body"],
          query: built.query,
        },
      ),
    );
  const recordLocator = readCreatedOrder(reply.body)?.records[0]?.reference;
  if (recordLocator === undefined) {
    throw new Error("the stub did not create the decoy order");
  }
  return recordLocator;
}

// Cloning the template, starting the stub and the fake Stripe API and building both module graphs take several
// seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own timeout.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["createFlightSearch", [201]],
    ["priceFlightOffers", [201]],
    ["createCheckout", [201]],
    ["setCheckoutTravelers", [200]],
    ["setCheckoutContacts", [200]],
    ["createCheckoutPayment", [201]],
    ["completeCheckout", [201, 402, 409, 502, 504]],
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
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: quietPoolLogger,
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  stub = await startAmadeusStub({
    credentials: { clientId, clientSecret: secret },
    clock: stubClock,
    // The `timeout` scenarios hold an answer for 100 ms, then give up with their 504, as after 30 s.
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 100)),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  const accountId = await insertAccount(clientId, secret);
  alphaId = await insertTenant(accountId);
  alphaSk = await issueKey(alphaId);
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
    await trx
      .updateTable("storefront_settings")
      .set({
        ops_alert_email: OPS_EMAIL,
        time_zone: "Europe/Madrid",
        ticketing_policy: "issue_after_payment",
      })
      .execute();
  });
  const stripeKeys = { STRIPE_SECRET_KEY_TEST: SECRET_KEY, STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY };
  api = await createTestApp({
    database: db,
    redis,
    imports: [stripeEndpointModule(stripe.endpoint)],
    env: { AMADEUS_BASE_URL_TEST: stub.url, ...stripeKeys },
  });
  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    ...stripeKeys,
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  @Module({
    imports: [
      stripeEndpointModule(stripe.endpoint),
      WorkerModule.forRoot(config, { logger: createWorkerLogger(config, new MemorySink()) }),
    ],
  })
  class WorkerRootModule {}
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(WorkerRootModule);
  await worker.init();
  bookingsQueue = worker.get<Queue>(getQueueToken(OTA_QUEUE.bookings), { strict: false });
  paymentsQueue = worker.get<Queue>(getQueueToken(OTA_QUEUE.payments), { strict: false });
  maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  // From here on the file plays the scheduler: no iteration of the real one may fire while it runs.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
  // The booking documents' consumer (`ota-documents`, OBE-053) runs: the booking.created of an order found asks for its
  // itinerary, whose write takes the booking's FOR KEY SHARE only (documents.processor.ts, T2), so the reconciliation's
  // inline ticketing claim (FOR NO KEY UPDATE SKIP LOCKED, lead decision (1) of 2026-10-22) never skips the booking for
  // it (before FIX-W26-BOOKINGS the file paused the consumer, commit 16c3ea9).
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await stub?.stop();
  await stripe?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

describe("an order whose answer was lost but that exists (stub timeout)", () => {
  let timedOut: TimedOut;
  let firstJob: Job | undefined;
  let pendingRow: Awaited<ReturnType<typeof bookingRow>>;
  let replays: Answer[];
  let blocked: ReconcileJobResult;
  let afterBlocked: Awaited<ReturnType<typeof bookingRow>>;
  let found: ReconcileJobResult;
  let foundAt: Date;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let finalReplay: Answer;
  let otherKey: Answer;

  beforeAll(async () => {
    useWorkerClock();
    timedOut = await timedOutCompletion("timeout");
    pendingRow = await bookingRow(timedOut.bookingId);
    firstJob = await firstJobOf(timedOut.bookingId);
    replays = [await complete(timedOut.checkout.id, { key: timedOut.key })];
    // The first attempt, 30 s later, cannot read the booking queue (Amadeus answers 429): it decides nothing.
    stub.setDefaultScenario("rate-limited");
    blocked = await firstAttempt(timedOut.bookingId, after(timedOut.started, 30 * SECOND));
    stub.setDefaultScenario("success");
    afterBlocked = await bookingRow(timedOut.bookingId);
    replays.push(await complete(timedOut.checkout.id, { key: timedOut.key }));
    // The scan two minutes after the order finds it.
    foundAt = after(timedOut.started, 2 * MINUTE);
    found = await scanAttempt(timedOut.bookingId, foundAt);
    decided = await bookingRow(timedOut.bookingId);
    finalReplay = await complete(timedOut.checkout.id, { key: timedOut.key });
    otherKey = await complete(timedOut.checkout.id);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-043 AC1] keeps the booking pending, queues the first booking.reconcile 30 s later and replays the same 504", () => {
    expect(pendingRow).toMatchObject({
      status: "pending",
      checkout_id: timedOut.checkout.id,
      record_locator: null,
      reconcile_attempts: 0,
      reconcile_outcome: null,
    });
    expect(pendingRow.reconcile_until?.getTime()).toBe(timedOut.started.getTime() + 15 * MINUTE);
    expect(firstJob?.name).toBe(RECONCILE_JOB);
    expect(firstJob?.data).toEqual({ tenantId: alphaId, bookingId: timedOut.bookingId });
    expect(firstJob?.opts.delay).toBe(30 * SECOND);
    const firstDetails = (timedOut.first.body as ErrorBody).error.details;
    // A guest's key caller gets the booking's guest token with the 504 (OBE-047), to follow the pending booking.
    expect(firstDetails).toMatchObject({
      bookingToken: expect.stringMatching(BOOKING_TOKEN_PATTERN),
      replayed: false,
    });
    // Same key while undecided: the same 504 with the same details, replayed, and never a second order.
    expect(blocked).toMatchObject({ outcome: "pending", attempts: 1, reason: "search_incomplete" });
    expect(afterBlocked).toMatchObject({ status: "pending", reconcile_attempts: 1, reconcile_outcome: null });
    for (const replay of replays) {
      expect(replay.status).toBe(504);
      expect((replay.body as ErrorBody).error).toMatchObject({
        code: "SUPPLIER_TIMEOUT",
        details: {
          bookingId: timedOut.bookingId,
          bookingToken: firstDetails?.["bookingToken"],
          bookingTokenExpiresAt: firstDetails?.["bookingTokenExpiresAt"],
          replayed: true,
        },
      });
    }
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });

  it("[OBE-043 AC1] finds the order within 15 minutes (FakeClock), records it, captures and issues it [OF-04 AC3]", async () => {
    expect(found).toMatchObject({ outcome: "found", attempts: 2, captured: true, status: "ticketed" });
    expect(foundAt.getTime()).toBeLessThan(decided.reconcile_until?.getTime() ?? 0);
    expect(decided).toMatchObject({
      status: "ticketed",
      ticketing_status: "issued",
      reconcile_outcome: "found",
      reconcile_attempts: 2,
      checkout_id: timedOut.checkout.id,
      paid: decided.total,
    });
    expect(decided.record_locator).toMatch(/^[A-Z0-9]{6}$/);
    // issue_after_payment: the capture requested the issuance (tenant.sql `ticketing_requested_at`).
    expect(decided.ticketing_requested_at).toBeInstanceOf(Date);
    // The PNR it read is the one the lost answer created: a Queue List, a read by its record locator.
    const reads = amadeusCalls("getFlightOrderByReference");
    expect(reads.map((read) => read.query["reference"])).toContain(decided.record_locator);
    expect(await checkoutStatus(timedOut.checkout.id)).toBe("completed");
    expect(await paymentRow(timedOut.payment.id)).toMatchObject({
      status: "captured",
      booking_id: timedOut.bookingId,
    });
    const captures = stripePosts("/capture");
    expect(captures).toHaveLength(1);
    expect(captures[0]?.headers["idempotency-key"]).toBe(
      `pi:capture:${timedOut.payment.id}:${timedOut.checkout.totals.total.amount}`,
    );
    expect(amadeusCalls("issueFlightOrder")).toHaveLength(1);
    expect(await eventTypes(timedOut.bookingId)).toEqual(
      expect.arrayContaining([
        "booking.supplier_timeout",
        "booking.created",
        "booking.reconciled",
        "payment.captured",
        "booking.ticketed",
      ]),
    );
    expect((await notificationsOf(timedOut.bookingId)).map((row) => row.templateKey)).toContain(
      "booking.confirmed",
    );
  });

  it("[OBE-043 AC1] then answers the same key with 201 and the booking, another key with 409", () => {
    expect(finalReplay.status).toBe(201);
    expect(finalReplay.headers["location"]).toBe(`/v1/bookings/${timedOut.bookingId}`);
    expect(finalReplay.headers["cache-control"]).toBe("no-store");
    const completion = finalReplay.body as CompletionBody;
    expect(completion.checkoutId).toBe(timedOut.checkout.id);
    expect(completion.booking).toMatchObject({
      id: timedOut.bookingId,
      status: "ticketed",
      recordLocator: decided.record_locator,
    });
    expect(completion.booking.tickets).toHaveLength(1);
    expect(completion.booking.payments).toEqual([
      expect.objectContaining({ id: timedOut.payment.id, status: "captured" }),
    ]);
    expect(completion.booking.totals.total).toEqual(timedOut.checkout.totals.total);
    // The guest token of the first answer, again (OBE-047): its replays never issue another one.
    const firstDetails = (timedOut.first.body as ErrorBody).error.details;
    expect(completion.bookingToken).toMatch(BOOKING_TOKEN_PATTERN);
    expect(completion).toMatchObject({
      bookingToken: firstDetails?.["bookingToken"],
      bookingTokenExpiresAt: firstDetails?.["bookingTokenExpiresAt"],
    });
    expect(otherKey.status).toBe(409);
    expect((otherKey.body as ErrorBody).error).toMatchObject({
      code: "CHECKOUT_ALREADY_COMPLETED",
      details: { bookingId: timedOut.bookingId },
    });
    // Flight Create Orders was sent once for the checkout, whatever the retries.
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });
});

describe("an order that was never created (stub timeout-lost)", () => {
  let timedOut: TimedOut;
  let early: ReconcileJobResult;
  let late: ReconcileJobResult;
  let lateRow: Awaited<ReturnType<typeof bookingRow>>;
  let undecidedReplay: Answer;
  let decision: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let voidJob: Job;
  let finalReplay: Answer;
  let newKey: Answer;

  beforeAll(async () => {
    useWorkerClock();
    timedOut = await timedOutCompletion("timeout-lost");
    early = await firstAttempt(timedOut.bookingId, after(timedOut.started, 30 * SECOND));
    late = await scanAttempt(timedOut.bookingId, after(timedOut.started, 14 * MINUTE));
    lateRow = await bookingRow(timedOut.bookingId);
    undecidedReplay = await complete(timedOut.checkout.id, { key: timedOut.key });
    decision = await scanAttempt(timedOut.bookingId, after(timedOut.started, 15 * MINUTE));
    decided = await bookingRow(timedOut.bookingId);
    voidJob = await finished(paymentsQueue, `payment-void-${timedOut.payment.id}`);
    finalReplay = await complete(timedOut.checkout.id, { key: timedOut.key });
    newKey = await complete(timedOut.checkout.id);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-043 AC2] keeps the booking pending and replays the 504 while reconcile_until has not passed", () => {
    expect(early).toMatchObject({ outcome: "pending", attempts: 1, reason: "not_found_yet" });
    expect(late).toMatchObject({ outcome: "pending", attempts: 2, reason: "not_found_yet" });
    expect(lateRow).toMatchObject({ status: "pending", reconcile_outcome: null });
    expect(undecidedReplay.status).toBe(504);
    expect((undecidedReplay.body as ErrorBody).error.details).toMatchObject({
      bookingId: timedOut.bookingId,
      replayed: true,
    });
    expect(amadeusCalls("listQueue")).toHaveLength(3);
  });

  it("[OBE-043 AC2] after 15 minutes voids the authorisation through payment.void and fails the booking", async () => {
    expect(decision).toMatchObject({ outcome: "not_found", attempts: 3, voids: 1 });
    expect(decided).toMatchObject({
      status: "failed",
      ticketing_status: "not_applicable",
      checkout_id: null,
      failure_code: "SUPPLIER_TIMEOUT",
      reconcile_outcome: "not_found",
      record_locator: null,
    });
    expect(voidJob.data).toEqual({ tenantId: alphaId, id: timedOut.payment.id });
    expect(voidJob.returnvalue).toMatchObject({ outcome: "applied" });
    const cancels = stripePosts("/cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.headers["idempotency-key"]).toBe(`pi:cancel:${timedOut.payment.id}`);
    expect(stripe.intents.get(timedOut.payment.providerPaymentId ?? "")?.status).toBe("canceled");
    expect(stripePosts("/capture")).toHaveLength(0);
    expect(await paymentRow(timedOut.payment.id)).toMatchObject({ status: "canceled" });
    // The checkout's lock is released: it is open again, for a new payment.
    expect(await checkoutStatus(timedOut.checkout.id)).toBe("open");
    expect(await eventTypes(timedOut.bookingId)).toEqual(
      expect.arrayContaining(["booking.supplier_timeout", "booking.failed", "booking.not_confirmed"]),
    );
  });

  it("[OBE-043 AC2] queues the traveller e-mail booking.not_confirmed and the staff alert", async () => {
    const queued = await notificationsOf(timedOut.bookingId);
    expect(queued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateKey: "booking.not_confirmed",
          recipient: timedOut.contactEmail,
          recipientType: "guest",
          payload: expect.objectContaining({
            booking: expect.objectContaining({ reference: decided.reference, recordLocator: "" }) as unknown,
          }) as unknown,
        }),
        expect.objectContaining({
          templateKey: "staff.manual_review",
          recipient: OPS_EMAIL,
          recipientType: "staff",
        }),
      ]),
    );
    expect(queued.filter((row) => row.templateKey === "booking.confirmed")).toEqual([]);
  });

  it("[OBE-043 AC2] answers the same key with the final 502 SUPPLIER_ERROR, and a new key without paying again with 402", () => {
    expect(finalReplay.status).toBe(502);
    expect((finalReplay.body as ErrorBody).error).toMatchObject({
      code: "SUPPLIER_ERROR",
      details: { bookingId: timedOut.bookingId, bookingStatus: "failed" },
    });
    expect(newKey.status).toBe(402);
    expect((newKey.body as ErrorBody).error.code).toBe("PAYMENT_REQUIRED");
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });
});

describe("PNRs with the lead traveller's name but not the booking's remark", () => {
  let timedOut: TimedOut;
  let decoys: string[];
  let early: ReconcileJobResult;
  let decision: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;

  beforeAll(async () => {
    useWorkerClock();
    timedOut = await timedOutCompletion("timeout-lost");
    const { reference } = await bookingRow(timedOut.bookingId);
    decoys = [
      // Another booking's order of the same traveller, at the same time.
      await createDecoy(() => undefined),
      // The booking's text as a special request, not the BACKOFFICE remark.
      await createDecoy((data) => {
        data["remarks"] = { general: [{ subType: "GENERAL_MISCELLANEOUS", text: `VELEXIS ${reference}` }] };
      }),
    ];
    early = await firstAttempt(timedOut.bookingId, after(timedOut.started, 30 * SECOND));
    decision = await scanAttempt(timedOut.bookingId, after(timedOut.started, 15 * MINUTE));
    decided = await bookingRow(timedOut.bookingId);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-043 AC3] reads them by record locator but never accepts one without the VELEXIS remark", () => {
    const read = amadeusCalls("getFlightOrderByReference").map((entry) => entry.query["reference"]);
    for (const decoy of decoys) {
      expect(read).toContain(decoy);
    }
    expect(early).toMatchObject({ outcome: "pending", reason: "not_found_yet" });
    expect(decision).toMatchObject({ outcome: "not_found" });
    expect(decided).toMatchObject({ status: "failed", record_locator: null, reconcile_outcome: "not_found" });
    expect(decoys).not.toContain(decided.record_locator);
    expect(stripePosts("/capture")).toHaveLength(0);
  });
});

describe("an OTA without a booking queue", () => {
  let timedOut: TimedOut;
  let early: ReconcileJobResult;
  let decision: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;

  beforeAll(async () => {
    useWorkerClock();
    await alphaTx((trx) =>
      trx.updateTable("storefront_settings").set({ booking_queue_number: null }).execute(),
    );
    try {
      timedOut = await timedOutCompletion("timeout");
      early = await firstAttempt(timedOut.bookingId, after(timedOut.started, 30 * SECOND));
      decision = await scanAttempt(timedOut.bookingId, after(timedOut.started, 15 * MINUTE));
      decided = await bookingRow(timedOut.bookingId);
    } finally {
      await alphaTx((trx) =>
        trx.updateTable("storefront_settings").set({ booking_queue_number: 50 }).execute(),
      );
    }
  }, SCENARIO_TIMEOUT_MS);

  it("fails the booking after 15 minutes without searching, and tells the staff to check the office by hand", async () => {
    expect(early).toMatchObject({ outcome: "pending", reason: "no_queue" });
    expect(amadeusCalls("listQueue")).toHaveLength(0);
    expect(decision).toMatchObject({ outcome: "not_found", voids: 1 });
    expect(decided).toMatchObject({ status: "failed", reconcile_outcome: "not_found" });
    const alert = (await notificationsOf(timedOut.bookingId)).find(
      (row) => row.templateKey === "staff.manual_review",
    );
    expect(JSON.stringify(alert?.payload)).toContain("check the office by hand");
  });
});

describe("a re-price accepted before the lost answer", () => {
  let original: string;
  let timedOut: TimedOut;
  let pricings: number;
  let pending: Awaited<ReturnType<typeof bookingRow>>;
  let moved: Awaited<ReturnType<typeof checkoutRow>>;
  let early: ReconcileJobResult;
  let decision: ReconcileJobResult;
  let reopened: Awaited<ReturnType<typeof checkoutRow>>;

  beforeAll(async () => {
    useWorkerClock();
    // The priced offer is older than ten minutes: checkout.complete prices it again (the stub answers the same total)
    // and sends the order from the new priced offer, whose answer `timeout-lost` holds.
    timedOut = await timedOutCompletion("timeout-lost", async (checkout) => {
      original = checkout.pricedOfferId;
      await ageOffer(checkout.pricedOfferId);
    });
    pricings = amadeusCalls("quoteAirOffers").length;
    pending = await bookingRow(timedOut.bookingId);
    moved = await checkoutRow(timedOut.checkout.id);
    // Decided here, so no pending booking is left behind.
    early = await firstAttempt(timedOut.bookingId, after(timedOut.started, 30 * SECOND));
    decision = await scanAttempt(timedOut.bookingId, after(timedOut.started, 15 * MINUTE));
    reopened = await checkoutRow(timedOut.checkout.id);
  }, SCENARIO_TIMEOUT_MS);

  it("moves the booking and the checkout to the new priced offer at the timeout, as the order sent holds it", () => {
    expect(pricings).toBe(1);
    expect(moved.priced_offer_id).not.toBe(original);
    expect(pending).toMatchObject({
      status: "pending",
      priced_offer_id: moved.priced_offer_id,
      total: moved.total,
      reconcile_outcome: null,
    });
    expect(early).toMatchObject({ outcome: "pending", reason: "not_found_yet" });
    expect(decision).toMatchObject({ outcome: "not_found", voids: 1 });
    // Reopened on the priced offer the order was sent with.
    expect(reopened).toMatchObject({ status: "open", priced_offer_id: moved.priced_offer_id });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });
});

describe("a stale claim whose order exists (FIX-W24-BOOKINGS, stub timeout)", () => {
  let timedOut: TimedOut;
  let stale: Awaited<ReturnType<typeof bookingRow>>;
  let firstJob: Job | undefined;
  let freshScans: Array<Record<string, number>>;
  let freshRows: Array<Awaited<ReturnType<typeof bookingRow>>>;
  let freshJobs: Array<Job | undefined>;
  let adoptedAt: Date;
  let adoptingScan: Record<string, number>;
  let found: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let laterScan: Record<string, number>;
  let finalReplay: Answer;

  beforeAll(async () => {
    useWorkerClock();
    // A last name of its own: the earlier scenarios' orders and decoys (all SAMPLE) are on the booking queue too, and
    // Queue List gives their creation to the minute only, so they could tie with this order for the search's three
    // reads (RECONCILE_MAX_READS) and leave it unread.
    timedOut = await staleClaim("timeout", "ADOPTED");
    stale = await bookingRow(timedOut.bookingId);
    firstJob = await firstJobOf(timedOut.bookingId);
    // A claim younger than 2 minutes may still have its request in flight: the scans of 1 and of exactly 2 minutes
    // after it leave it alone.
    freshScans = [];
    freshRows = [];
    freshJobs = [];
    for (const at of [after(timedOut.started, MINUTE), after(timedOut.started, 2 * MINUTE)]) {
      freshScans.push(await scan(at));
      freshRows.push(await bookingRow(timedOut.bookingId));
      freshJobs.push(
        (await bookingsQueue.getJob(reconcileJobId(timedOut.bookingId, minuteBucket(at)))) ?? undefined,
      );
    }
    // The scan after the 2 minutes adopts it, and its booking.reconcile finds the order the lost answer created.
    adoptedAt = after(timedOut.started, 2 * MINUTE + SECOND);
    adoptingScan = await scan(adoptedAt);
    found = (await finished(bookingsQueue, reconcileJobId(timedOut.bookingId, minuteBucket(adoptedAt))))
      .returnvalue as ReconcileJobResult;
    decided = await bookingRow(timedOut.bookingId);
    laterScan = await scan(after(timedOut.started, 3 * MINUTE + SECOND));
    finalReplay = await complete(timedOut.checkout.id, { key: timedOut.key });
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W24-BOOKINGS AC3] leaves a claim without reconcile_until alone for 2 minutes: no adoption, no job, no event", async () => {
    // The failed write left nothing for the reconciliation: no deadline, no first job, no event.
    expect(stale).toMatchObject({ status: "pending", reconcile_until: null, reconcile_attempts: 0 });
    expect(firstJob).toBeUndefined();
    expect(await eventTypes(timedOut.bookingId)).not.toContain("booking.supplier_timeout");
    expect(freshScans.map((counts) => counts["adopted"])).toEqual([0, 0]);
    for (const row of freshRows) {
      expect(row).toMatchObject({ status: "pending", reconcile_until: null, reconcile_attempts: 0 });
    }
    expect(freshJobs).toEqual([undefined, undefined]);
  });

  it("[FIX-W24-BOOKINGS AC1] adopts it after 2 minutes and reconciles it to confirmed: found in the queuing office, captured, issued", async () => {
    expect(adoptingScan).toMatchObject({ adopted: 1 });
    expect(decided.reconcile_until?.getTime()).toBe(adoptedAt.getTime() + 15 * MINUTE);
    expect(found).toMatchObject({ outcome: "found", attempts: 1, captured: true, status: "ticketed" });
    expect(decided).toMatchObject({
      status: "ticketed",
      ticketing_status: "issued",
      reconcile_outcome: "found",
      reconcile_attempts: 1,
      checkout_id: timedOut.checkout.id,
      paid: decided.total,
    });
    // The order was looked for in the booking queue before anything was decided, and read by its record locator.
    expect(amadeusCalls("listQueue")).toHaveLength(1);
    expect(amadeusCalls("getFlightOrderByReference").map((read) => read.query["reference"])).toContain(
      decided.record_locator,
    );
    expect(await checkoutStatus(timedOut.checkout.id)).toBe("completed");
    expect(await paymentRow(timedOut.payment.id)).toMatchObject({ status: "captured" });
    expect(stripePostsOf(timedOut.payment, "/capture")).toHaveLength(1);
    expect(stripePostsOf(timedOut.payment, "/cancel")).toHaveLength(0);
    expect(await adoptedEvents(timedOut.bookingId)).toEqual([
      {
        actorType: "system",
        visible: false,
        data: {
          reason: "stale_claim",
          createOrderStartedAt: timedOut.started.toISOString(),
          reconcileUntil: new Date(adoptedAt.getTime() + 15 * MINUTE).toISOString(),
        },
      },
    ]);
    expect(laterScan).toMatchObject({ adopted: 0 });
    // The same key's replay follows the booking: the final 201, and still one Flight Create Orders.
    expect(finalReplay.status).toBe(201);
    expect((finalReplay.body as CompletionBody).booking).toMatchObject({
      id: timedOut.bookingId,
      status: "ticketed",
    });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });
});

describe("a stale claim whose order was never created (FIX-W24-BOOKINGS, stub timeout-lost)", () => {
  let timedOut: TimedOut;
  let concurrent: { readonly first: AdoptedClaim[]; readonly second: AdoptedClaim[] };
  let afterRollback: Awaited<ReturnType<typeof bookingRow>>;
  let adoptedAt: Date;
  let firstScan: { readonly counts: Record<string, number>; readonly attempt: ReconcileJobResult };
  let secondScan: { readonly counts: Record<string, number>; readonly attempt: ReconcileJobResult };
  let undecided: Awaited<ReturnType<typeof bookingRow>>;
  let undecidedCheckout: string;
  let cancelsBefore: number;
  let decision: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let voidJob: Job;
  let finalReplay: Answer;

  /** A scan of alpha at `at`: its counts and the attempt of the booking's booking.reconcile it added. */
  async function scanned(at: Date) {
    const counts = await scan(at);
    const attempt = (await finished(bookingsQueue, reconcileJobId(timedOut.bookingId, minuteBucket(at))))
      .returnvalue as ReconcileJobResult;
    return { counts, attempt };
  }

  beforeAll(async () => {
    useWorkerClock();
    timedOut = await staleClaim("timeout-lost");
    adoptedAt = after(timedOut.started, 2 * MINUTE + SECOND);
    // Two scans at once: the second runs while the first holds the claim it adopts, and adopts nothing. The first's
    // transaction is then rolled back, so the scans below find the claim as the failed write left it.
    const scanner = worker.get(ReconcileScan, { strict: false });
    const rollback = new Error("rolled back by the test");
    let seen: typeof concurrent | undefined;
    await alphaTx(async (trx) => {
      const first = await scanner.adopt(trx, adoptedAt, "reconcile-test-first");
      const second = await alphaTx((other) => scanner.adopt(other, adoptedAt, "reconcile-test-second"));
      seen = { first, second };
      throw rollback;
    }).catch((error: unknown) => {
      if (error !== rollback) {
        throw error;
      }
    });
    if (seen === undefined) {
      throw new Error("the concurrent adoption did not run");
    }
    concurrent = seen;
    afterRollback = await bookingRow(timedOut.bookingId);
    // Two scans a minute apart: the first adopts the claim, the second only reconciles it; both find nothing yet.
    firstScan = await scanned(adoptedAt);
    secondScan = await scanned(after(timedOut.started, 3 * MINUTE + 2 * SECOND));
    undecided = await bookingRow(timedOut.bookingId);
    undecidedCheckout = await checkoutStatus(timedOut.checkout.id);
    cancelsBefore = stripePostsOf(timedOut.payment, "/cancel").length;
    // 15 minutes after the adoption the order is proven absent.
    decision = (await scanned(new Date(adoptedAt.getTime() + 15 * MINUTE))).attempt;
    decided = await bookingRow(timedOut.bookingId);
    voidJob = await finished(paymentsQueue, `payment-void-${timedOut.payment.id}`);
    finalReplay = await complete(timedOut.checkout.id, { key: timedOut.key });
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W24-BOOKINGS AC4] adopts the claim once, whatever the scans: two at once and two a minute apart", async () => {
    expect(concurrent.first.map((claim) => claim.id)).toEqual([timedOut.bookingId]);
    expect(concurrent.second).toEqual([]);
    expect(afterRollback).toMatchObject({ reconcile_until: null, reconcile_attempts: 0 });
    expect(firstScan.counts).toMatchObject({ adopted: 1 });
    expect(secondScan.counts).toMatchObject({ adopted: 0 });
    expect(firstScan.attempt).toMatchObject({ outcome: "pending", attempts: 1, reason: "not_found_yet" });
    expect(secondScan.attempt).toMatchObject({ outcome: "pending", attempts: 2, reason: "not_found_yet" });
    expect(undecided).toMatchObject({ status: "pending", reconcile_outcome: null });
    expect(undecided.reconcile_until?.getTime()).toBe(adoptedAt.getTime() + 15 * MINUTE);
    expect(await adoptedEvents(timedOut.bookingId)).toHaveLength(1);
  });

  it("[FIX-W24-BOOKINGS AC2] voids and reopens the checkout only once the order is proven absent, 15 minutes after the adoption", async () => {
    // Before the deadline nothing was voided and the checkout stayed locked; each attempt looked for the order in the
    // booking queue.
    expect(cancelsBefore).toBe(0);
    expect(undecidedCheckout).toBe("payment_pending");
    expect(amadeusCalls("listQueue")).toHaveLength(3);
    expect(decision).toMatchObject({ outcome: "not_found", attempts: 3, voids: 1 });
    expect(decided).toMatchObject({
      status: "failed",
      checkout_id: null,
      failure_code: "SUPPLIER_TIMEOUT",
      reconcile_outcome: "not_found",
      record_locator: null,
    });
    expect(voidJob.returnvalue).toMatchObject({ outcome: "applied" });
    const cancels = stripePostsOf(timedOut.payment, "/cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.headers["idempotency-key"]).toBe(`pi:cancel:${timedOut.payment.id}`);
    expect(stripePostsOf(timedOut.payment, "/capture")).toHaveLength(0);
    expect(await paymentRow(timedOut.payment.id)).toMatchObject({ status: "canceled" });
    expect(await checkoutStatus(timedOut.checkout.id)).toBe("open");
    expect(finalReplay.status).toBe(502);
    expect((finalReplay.body as ErrorBody).error).toMatchObject({
      code: "SUPPLIER_ERROR",
      details: { bookingId: timedOut.bookingId, bookingStatus: "failed" },
    });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });
});

// ---- FIX-W25-BOOKINGS (lead decisions of 2026-10-21, third batch) ----------------------------------------------------

/** The `booking.reconcile_manual_review` events of a booking, and the staff alert of its review. */
async function reviewOf(bookingId: string) {
  return await alphaTx(async (trx) => ({
    events: await trx
      .selectFrom("booking_events")
      .select(["actor_type as actorType", "visible_to_customer as visible", "data"])
      .where("booking_id", "=", bookingId)
      .where("type", "=", RECONCILE_MANUAL_REVIEW_EVENT)
      .execute(),
    alerts: await trx
      .selectFrom("notifications")
      .select(["recipient", "recipient_type as recipientType", "payload"])
      .where("booking_id", "=", bookingId)
      .where("dedupe_key", "=", `staff.manual_review:${bookingId}:reconcile_manual_review`)
      .execute(),
  }));
}

/** The `booking.reconcile_deadline_retry` events of a booking (FIX-W26-BOOKINGS), oldest first. */
async function deadlineRetriesOf(bookingId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("booking_events")
      .select(["actor_type as actorType", "visible_to_customer as visible", "data"])
      .where("booking_id", "=", bookingId)
      .where("type", "=", RECONCILE_DEADLINE_RETRY_EVENT)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );
}

/** The by-reference reads of the stub, in order: their record locators. */
const readLocators = (): string[] =>
  amadeusCalls("getFlightOrderByReference").map((entry) => String(entry.query["reference"]));

describe("more than three PNRs of the lead's name in the order's minute, the order read last (FIX-W25-BOOKINGS)", () => {
  const LEAD = "MINUTEMATE";
  let timedOut: TimedOut;
  let decoys: string[];
  let found: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let reads: string[];

  beforeAll(async () => {
    useWorkerClock();
    try {
      // The order is created a minute back on the stub's clock: Queue List gives it the minute before the claim's.
      timedOut = await timedOutCompletion(
        "timeout",
        () => {
          stubShiftMs = -MINUTE;
          return Promise.resolve();
        },
        LEAD,
      );
    } finally {
      stubShiftMs = 0;
    }
    // Four more PNRs of the same traveller name, created in the claim's minute: closer to it, so read first.
    decoys = [];
    for (let index = 0; index < 4; index += 1) {
      decoys.push(await createDecoy(() => undefined, LEAD));
    }
    // The decoys took tokens of the tenant's Amadeus bucket, which the worker's still clock never refills: the
    // attempt's Queue List, five reads, resync and issue start from a full one.
    await resetRateLimits();
    found = await firstAttempt(timedOut.bookingId, after(timedOut.started, 30 * SECOND));
    decided = await bookingRow(timedOut.bookingId);
    reads = readLocators();
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W25-BOOKINGS AC1] reads every candidate of the window and finds the order read fifth, after four of one minute", () => {
    expect(found).toMatchObject({ outcome: "found", attempts: 1, captured: true });
    expect(decided).toMatchObject({ status: "ticketed", reconcile_outcome: "found" });
    // Three reads at most before the lead decision: the order would have stayed unread and been voided at the deadline.
    expect(reads).toHaveLength(5);
    expect([...reads.slice(0, 4)].sort()).toEqual([...decoys].sort());
    expect(reads.at(-1)).toBe(decided.record_locator);
    expect(decoys).not.toContain(decided.record_locator);
    expect(stripePostsOf(timedOut.payment, "/capture")).toHaveLength(1);
    expect(stripePostsOf(timedOut.payment, "/cancel")).toHaveLength(0);
    // The Queue List asked for RECONCILE_QUEUE_LIST_MAX PNRs, so an answer that holds that many is known to be partial.
    expect(String(amadeusCalls("listQueue")[0]?.query["max"])).toBe(String(RECONCILE_QUEUE_LIST_MAX));
  });
});

describe("a complete search of more than three PNRs that finds none of them is the order (FIX-W25-BOOKINGS)", () => {
  const LEAD = "ALLREAD";
  let timedOut: TimedOut;
  let decoys: string[];
  let early: ReconcileJobResult;
  let decision: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let voidJob: Job;

  beforeAll(async () => {
    useWorkerClock();
    timedOut = await timedOutCompletion("timeout-lost", undefined, LEAD);
    decoys = [];
    for (let index = 0; index < 4; index += 1) {
      decoys.push(await createDecoy(() => undefined, LEAD));
    }
    await resetRateLimits();
    early = await firstAttempt(timedOut.bookingId, after(timedOut.started, 30 * SECOND));
    decision = await scanAttempt(timedOut.bookingId, after(timedOut.started, 15 * MINUTE));
    decided = await bookingRow(timedOut.bookingId);
    voidJob = await finished(paymentsQueue, `payment-void-${timedOut.payment.id}`);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W25-BOOKINGS AC1] reads all of them in each attempt and voids at reconcile_until: only a complete search proves absence", async () => {
    expect(early).toMatchObject({ outcome: "pending", attempts: 1, reason: "not_found_yet" });
    expect(decision).toMatchObject({ outcome: "not_found", attempts: 2, voids: 1 });
    const reads = readLocators();
    expect(reads).toHaveLength(8);
    expect([...new Set(reads)].sort()).toEqual([...decoys].sort());
    expect(decided).toMatchObject({ status: "failed", reconcile_outcome: "not_found", checkout_id: null });
    expect(voidJob.returnvalue).toMatchObject({ outcome: "applied" });
    expect(stripePostsOf(timedOut.payment, "/cancel")).toHaveLength(1);
    expect(await checkoutStatus(timedOut.checkout.id)).toBe("open");
  });
});

/**
 * What an incomplete search left at `reconcile_until`: the attempts before and at the deadline, the booking, its
 * payment and checkout, a later scan, a replay of the `504` and the Stripe calls about the payment.
 */
interface Undecided {
  readonly timedOut: TimedOut;
  readonly early: ReconcileJobResult;
  readonly decision: ReconcileJobResult;
  readonly decided: Awaited<ReturnType<typeof bookingRow>>;
  readonly payment: Awaited<ReturnType<typeof paymentRow>>;
  readonly checkout: string;
  /** The booking.reconcile a scan a minute after the review would have added for the booking. */
  readonly laterJob: Job | undefined;
  readonly replay: Answer;
}

/**
 * A timed-out completion whose order was never created (stub `timeout-lost`, lead traveller `lastName`) and whose every
 * search `spoil` makes incomplete: the first attempt, the one at `reconcile_until`, then a scan a minute later and the
 * same key's replay. `spoil` gets the booking and answers the spy to restore.
 */
async function undecided(
  lastName: string,
  spoil: (timedOut: TimedOut) => Promise<{ mockRestore(): void }>,
): Promise<Undecided> {
  useWorkerClock();
  const timedOut = await timedOutCompletion("timeout-lost", undefined, lastName);
  const spy = await spoil(timedOut);
  try {
    const early = await firstAttempt(timedOut.bookingId, after(timedOut.started, 30 * SECOND));
    const decision = await scanAttempt(timedOut.bookingId, after(timedOut.started, 15 * MINUTE));
    const decided = await bookingRow(timedOut.bookingId);
    const laterAt = after(timedOut.started, 16 * MINUTE);
    await scan(laterAt);
    return {
      timedOut,
      early,
      decision,
      decided,
      payment: await paymentRow(timedOut.payment.id),
      checkout: await checkoutStatus(timedOut.checkout.id),
      laterJob:
        (await bookingsQueue.getJob(reconcileJobId(timedOut.bookingId, minuteBucket(laterAt)))) ?? undefined,
      replay: await complete(timedOut.checkout.id, { key: timedOut.key }),
    };
  } finally {
    spy.mockRestore();
  }
}

/** The common expectations of a booking whose search was still incomplete at `reconcile_until`. */
async function expectStaffReview(seen: Undecided, gap: string): Promise<void> {
  const { timedOut } = seen;
  expect(seen.early).toMatchObject({ outcome: "pending", attempts: 1, reason: "search_incomplete" });
  expect(seen.decision).toMatchObject({ outcome: "manual_review", attempts: 2, gap });
  // Never voided: the booking stays pending with its checkout and authorisation, for the staff to decide.
  expect(seen.decided).toMatchObject({
    status: "pending",
    ticketing_status: "manual_review",
    reconcile_outcome: "manual_review",
    checkout_id: timedOut.checkout.id,
    failure_code: null,
  });
  expect(seen.payment).toMatchObject({ status: "authorized", booking_id: timedOut.bookingId });
  expect(seen.checkout).toBe("payment_pending");
  expect(stripePostsOf(timedOut.payment, "/cancel")).toHaveLength(0);
  expect(await paymentsQueue.getJob(`payment-void-${timedOut.payment.id}`)).toBeUndefined();
  expect(stripe.intents.get(timedOut.payment.providerPaymentId ?? "")?.status).toBe("requires_capture");
  // The scan stops: no attempt after the review.
  expect(seen.laterJob).toBeUndefined();
  const review = await reviewOf(timedOut.bookingId);
  expect(review.events).toEqual([
    {
      actorType: "system",
      visible: false,
      data: expect.objectContaining({ reconcileOutcome: "manual_review", attempt: 2, gap }) as unknown,
    },
  ]);
  expect(review.alerts).toEqual([expect.objectContaining({ recipient: OPS_EMAIL, recipientType: "staff" })]);
  expect((await eventTypes(timedOut.bookingId)).filter((type) => type === "booking.failed")).toEqual([]);
  // The same key still answers that the booking is being confirmed.
  expect(seen.replay.status).toBe(504);
  expect((seen.replay.body as ErrorBody).error.details).toMatchObject({
    bookingId: timedOut.bookingId,
    replayed: true,
  });
}

describe("a Queue List answer that may leave PNRs out (FIX-W25-BOOKINGS)", () => {
  let seen: Undecided;

  beforeAll(async () => {
    // Amadeus says the queue holds one PNR more than it listed.
    seen = await undecided("TRUNCATED", (timedOut) => {
      const client = worker.get(AmadeusClient, { strict: false });
      const real = client.listQueue.bind(client);
      return Promise.resolve(
        vi.spyOn(client, "listQueue").mockImplementation(async (context, input, options) => {
          const reply = await real(context, input, options);
          if (context.bookingId === timedOut.bookingId) {
            const body = reply.body as { meta?: Record<string, unknown>; data?: unknown[] };
            body.meta = { ...body.meta, count: (body.data?.length ?? 0) + 1 };
          }
          return reply;
        }),
      );
    });
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W25-BOOKINGS AC1] never proves the order absent: at reconcile_until the booking goes to staff review, nothing voided", async () => {
    await expectStaffReview(seen, "queue_truncated");
  });

  it("[FIX-W26-BOOKINGS AC2] gets no grace after the deadline: a truncated Queue List is no transient failure, so the review comes at once", async () => {
    expect(seen.decision).toMatchObject({ outcome: "manual_review", attempts: 2, gap: "queue_truncated" });
    expect(await deadlineRetriesOf(seen.timedOut.bookingId)).toEqual([]);
    expect(seen.laterJob).toBeUndefined();
  });
});

describe("a read of a possible order that Amadeus refuses (FIX-W25-BOOKINGS)", () => {
  let decoy: string;
  let seen: Undecided;

  beforeAll(async () => {
    seen = await undecided("UNREADABLE", async () => {
      // A PNR of the traveller's name that the reconciliation cannot read: it may be the order. Amadeus refuses the
      // read (a 4xx other than a 404), which another attempt would meet again. (Until FIX-W26-BOOKINGS the read timed
      // out here; a timeout is a transient failure now, which the grace after the deadline tries again: lead decision
      // (3) of 2026-10-22, the scenario "a read that keeps timing out after reconcile_until" below.)
      decoy = await createDecoy(() => undefined, "UNREADABLE");
      const client = worker.get(AmadeusClient, { strict: false });
      const real = client.getFlightOrderByReference.bind(client);
      return vi
        .spyOn(client, "getFlightOrderByReference")
        .mockImplementation(async (context, input, options) => {
          if (input.query.reference === decoy) {
            throw new AppError("SUPPLIER_REJECTED");
          }
          return await real(context, input, options);
        });
    });
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W25-BOOKINGS AC1] never voids on a failed read: at reconcile_until the booking goes to staff review", async () => {
    await expectStaffReview(seen, "read_failed");
    expect(seen.decision).toMatchObject({ outcome: "manual_review" });
    expect(amadeusCalls("getFlightOrderByReference").map((entry) => entry.query["reference"])).not.toContain(
      decoy,
    );
  });
});

describe("an adopted claim whose re-price lowered the price before the order was sent (FIX-W25-BOOKINGS)", () => {
  let original: CheckoutBody;
  let timedOut: TimedOut;
  let stale: Awaited<ReturnType<typeof bookingRow>>;
  let found: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let captured: Awaited<ReturnType<typeof capturedOf>>;

  /** The captured amount and state of a payment. */
  async function capturedOf(paymentId: string) {
    return await alphaTx((trx) =>
      trx
        .selectFrom("payments")
        .select(["status", sql<string>`amount_captured::text`.as("captured")])
        .where("id", "=", paymentId)
        .executeTakeFirstOrThrow(),
    );
  }

  beforeAll(async () => {
    useWorkerClock();
    const spies: Array<{ mockRestore(): void }> = [];
    try {
      // The priced offer is priced again 10.00 lower, the order is created from the new priced offer, and its answer
      // is lost; the unknown-outcome write then fails too, as if the process had died after the send.
      timedOut = await staleClaim("success", "REPRICED", async (checkout) => {
        original = checkout;
        await ageOffer(checkout.pricedOfferId);
        spies.push(lowerRepricing(10), loseCreatedOrderAnswers());
      });
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
    stale = await bookingRow(timedOut.bookingId);
    const adoptedAt = after(timedOut.started, 2 * MINUTE + SECOND);
    await scan(adoptedAt);
    found = (await finished(bookingsQueue, reconcileJobId(timedOut.bookingId, minuteBucket(adoptedAt))))
      .returnvalue as ReconcileJobResult;
    decided = await bookingRow(timedOut.bookingId);
    captured = await capturedOf(timedOut.payment.id);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W25-BOOKINGS AC2] captures the re-priced total of the order sent, never the first priced offer's", () => {
    // Recorded before the send: the stale claim holds the re-priced offer and total, below the authorisation.
    expect(stale).toMatchObject({ status: "pending", reconcile_until: null });
    expect(stale.priced_offer_id).not.toBe(original.pricedOfferId);
    expect(Number(stale.total)).toBeLessThan(Number(original.totals.total.amount));
    expect(found).toMatchObject({ outcome: "found", attempts: 1, captured: true });
    expect(decided).toMatchObject({
      status: "ticketed",
      reconcile_outcome: "found",
      priced_offer_id: stale.priced_offer_id,
      total: stale.total,
      paid: stale.total,
    });
    const captures = stripePostsOf(timedOut.payment, "/capture");
    expect(captures).toHaveLength(1);
    expect(captures[0]?.headers["idempotency-key"]).toBe(`pi:capture:${timedOut.payment.id}:${stale.total}`);
    expect(captures[0]?.form["amount_to_capture"]).toBe(String(Math.round(Number(stale.total) * 100)));
    expect(captured).toEqual({ status: "captured", captured: stale.total });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });
});

describe("the reconciliation's lock order (FIX-W25-BOOKINGS)", () => {
  let notFound: { readonly decision: ReconcileJobResult; readonly seen: RowLockOrderObservation };
  let found: { readonly attempt: ReconcileJobResult; readonly seen: RowLockOrderObservation };

  /** Holds the checkout of `timedOut` until the attempt waits for it, then probes its booking. */
  async function holdCheckout(timedOut: TimedOut) {
    const probe = probeRowLockOrder(tenantDb, "tenant_alpha", {
      held: { table: "checkouts", id: timedOut.checkout.id },
      probed: { table: "bookings", id: timedOut.bookingId },
    });
    await probe.locked;
    return probe;
  }

  beforeAll(async () => {
    useWorkerClock();
    // The not-found decision, while another transaction holds the checkout: it waits for the checkout before it locks
    // the booking and the payments (before FIX-W25-BOOKINGS it took them first and the checkout last).
    const lost = await timedOutCompletion("timeout-lost", undefined, "LOCKLOST");
    await firstAttempt(lost.bookingId, after(lost.started, 30 * SECOND));
    const lostProbe = await holdCheckout(lost);
    const [decision, lostSeen] = await Promise.all([
      scanAttempt(lost.bookingId, after(lost.started, 15 * MINUTE)),
      lostProbe.result,
    ]);
    notFound = { decision, seen: lostSeen };
    // The found decision: it records the order and completes the checkout, the checkout locked first too.
    const kept = await timedOutCompletion("timeout", undefined, "LOCKFOUND");
    const keptProbe = await holdCheckout(kept);
    const [attempt, keptSeen] = await Promise.all([
      firstAttempt(kept.bookingId, after(kept.started, 30 * SECOND)),
      keptProbe.result,
    ]);
    found = { attempt, seen: keptSeen };
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W25-BOOKINGS AC3] the not-found decision locks the checkout before the booking: the booking is free while it waits", () => {
    expect(notFound.seen).toEqual({ waiterSeen: true, probedFree: true });
    expect(notFound.decision).toMatchObject({ outcome: "not_found", voids: 1 });
  });

  it("[FIX-W25-BOOKINGS AC3] the found decision locks the checkout before the booking too", () => {
    expect(found.seen).toEqual({ waiterSeen: true, probedFree: true });
    expect(found.attempt).toMatchObject({ outcome: "found", captured: true });
  });
});

// ---- FIX-W26-BOOKINGS (lead decisions (1) and (3) of 2026-10-22) -----------------------------------------------------

describe("a search rate-limited at reconcile_until whose order exists (FIX-W26-BOOKINGS)", () => {
  let timedOut: TimedOut;
  let early: ReconcileJobResult;
  let atDeadline: ReconcileJobResult;
  let afterDeadline: Awaited<ReturnType<typeof bookingRow>>;
  let retries: Awaited<ReturnType<typeof deadlineRetriesOf>>;
  let found: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;

  beforeAll(async () => {
    useWorkerClock();
    timedOut = await timedOutCompletion("timeout", undefined, "GRACEFOUND");
    // Amadeus answers 429 to the attempts before and at the deadline: the booking queue cannot be read.
    stub.setDefaultScenario("rate-limited");
    try {
      early = await firstAttempt(timedOut.bookingId, after(timedOut.started, 30 * SECOND));
      atDeadline = await scanAttempt(timedOut.bookingId, after(timedOut.started, 15 * MINUTE));
    } finally {
      stub.setDefaultScenario("success");
    }
    afterDeadline = await bookingRow(timedOut.bookingId);
    retries = await deadlineRetriesOf(timedOut.bookingId);
    // A minute later Amadeus answers again: the more attempt finds the order, records, captures and issues it.
    found = await scanAttempt(timedOut.bookingId, after(timedOut.started, 16 * MINUTE));
    decided = await bookingRow(timedOut.bookingId);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W26-BOOKINGS AC2] tries a 429 at the deadline again instead of the staff's review, and the next complete search finds the order", async () => {
    expect(early).toMatchObject({ outcome: "pending", attempts: 1, reason: "search_incomplete" });
    expect(atDeadline).toMatchObject({ outcome: "pending", attempts: 2, reason: "deadline_retry", retry: 1 });
    expect(afterDeadline).toMatchObject({
      status: "pending",
      reconcile_outcome: null,
      ticketing_status: "pending",
      checkout_id: timedOut.checkout.id,
    });
    expect(retries).toEqual([
      {
        actorType: "system",
        visible: false,
        data: expect.objectContaining({
          attempt: 2,
          retry: 1,
          retries: RECONCILE_DEADLINE_RETRIES,
          gap: "queue_failed",
        }) as unknown,
      },
    ]);
    expect(found).toMatchObject({ outcome: "found", attempts: 3, captured: true, status: "ticketed" });
    expect(decided).toMatchObject({
      status: "ticketed",
      ticketing_status: "issued",
      reconcile_outcome: "found",
    });
    expect((await reviewOf(timedOut.bookingId)).events).toEqual([]);
    expect(await checkoutStatus(timedOut.checkout.id)).toBe("completed");
    expect(stripePostsOf(timedOut.payment, "/capture")).toHaveLength(1);
    expect(stripePostsOf(timedOut.payment, "/cancel")).toHaveLength(0);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });
});

describe("a read that keeps timing out after reconcile_until (FIX-W26-BOOKINGS)", () => {
  const LEAD = "GRACELOST";
  let timedOut: TimedOut;
  let decoy: string;
  let early: ReconcileJobResult;
  let retried: ReconcileJobResult[];
  let decision: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let laterJob: Job | undefined;
  let payment: Awaited<ReturnType<typeof paymentRow>>;
  let checkout: string;
  let retries: Awaited<ReturnType<typeof deadlineRetriesOf>>;

  beforeAll(async () => {
    useWorkerClock();
    timedOut = await timedOutCompletion("timeout-lost", undefined, LEAD);
    // A PNR of the traveller's name whose by-reference read times out every time: it may be the order.
    decoy = await createDecoy(() => undefined, LEAD);
    await resetRateLimits();
    const client = worker.get(AmadeusClient, { strict: false });
    const real = client.getFlightOrderByReference.bind(client);
    const spy = vi
      .spyOn(client, "getFlightOrderByReference")
      .mockImplementation(async (context, input, options) => {
        if (input.query.reference === decoy) {
          throw new AppError("SUPPLIER_TIMEOUT");
        }
        return await real(context, input, options);
      });
    try {
      early = await firstAttempt(timedOut.bookingId, after(timedOut.started, 30 * SECOND));
      // The attempt at the deadline and the next two are tried again; the third more attempt's failure is the last.
      retried = [];
      for (const minutes of [15, 16, 17]) {
        retried.push(await scanAttempt(timedOut.bookingId, after(timedOut.started, minutes * MINUTE)));
      }
      decision = await scanAttempt(timedOut.bookingId, after(timedOut.started, 18 * MINUTE));
      decided = await bookingRow(timedOut.bookingId);
      const laterAt = after(timedOut.started, 19 * MINUTE);
      await scan(laterAt);
      laterJob =
        (await bookingsQueue.getJob(reconcileJobId(timedOut.bookingId, minuteBucket(laterAt)))) ?? undefined;
    } finally {
      spy.mockRestore();
    }
    payment = await paymentRow(timedOut.payment.id);
    checkout = await checkoutStatus(timedOut.checkout.id);
    retries = await deadlineRetriesOf(timedOut.bookingId);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W26-BOOKINGS AC2] gives three more attempts after the deadline, then sends the booking to the staff's review, nothing voided", async () => {
    expect(early).toMatchObject({ outcome: "pending", attempts: 1, reason: "search_incomplete" });
    expect(retried).toEqual(
      [1, 2, 3].map((retry) =>
        expect.objectContaining({ outcome: "pending", attempts: retry + 1, reason: "deadline_retry", retry }),
      ),
    );
    expect(decision).toMatchObject({ outcome: "manual_review", attempts: 5, gap: "read_failed" });
    expect(retries.map((row) => row.data)).toEqual(
      [1, 2, 3].map((retry) =>
        expect.objectContaining({ retry, gap: "read_failed", code: "SUPPLIER_TIMEOUT" }),
      ),
    );
    // As OADR-0003 point 5's review: pending with its checkout (still locked) and its authorisation, the scan stopped.
    expect(decided).toMatchObject({
      status: "pending",
      ticketing_status: "manual_review",
      reconcile_outcome: "manual_review",
      checkout_id: timedOut.checkout.id,
      failure_code: null,
    });
    expect(payment).toMatchObject({ status: "authorized", booking_id: timedOut.bookingId });
    expect(checkout).toBe("payment_pending");
    expect(stripePostsOf(timedOut.payment, "/cancel")).toHaveLength(0);
    expect(laterJob).toBeUndefined();
    const review = await reviewOf(timedOut.bookingId);
    expect(review.events).toEqual([
      {
        actorType: "system",
        visible: false,
        data: expect.objectContaining({
          reconcileOutcome: "manual_review",
          attempt: 5,
          gap: "read_failed",
          deadlineRetries: RECONCILE_DEADLINE_RETRIES,
        }) as unknown,
      },
    ]);
    expect(review.alerts).toEqual([
      expect.objectContaining({ recipient: OPS_EMAIL, recipientType: "staff" }),
    ]);
  });
});

describe("the claims' lock mode (FIX-W26-BOOKINGS, lead decision (1) of 2026-10-22)", () => {
  const ids: string[] = [];

  /**
   * A pending booking as an unknown outcome leaves it (`reconcile_until` set), or as a stale claim (none): its
   * create-order attempt started 10 minutes ago. Removed again after the describe, so no later scan finds it.
   */
  async function pendingBooking(reconciling: boolean): Promise<string> {
    const id = newId("bkg");
    const now = Date.now();
    await alphaTx((trx) =>
      trx
        .insertInto("bookings")
        .values({
          id,
          environment: "test",
          reference: newBookingReference(),
          status: "pending",
          ticketing_status: "pending",
          trip_type: "one_way",
          origin_iata: "MAD",
          destination_iata: "ORY",
          first_departure_at: new Date(now + 60 * 24 * 60 * MINUTE),
          last_arrival_at: new Date(now + 60 * 24 * 60 * MINUTE + 2 * 60 * MINUTE),
          currency: "EUR",
          net_amount: "98.47",
          total_amount: "110.47",
          contact_email: "contact-1@example.com",
          lead_last_name: "LOCKMODE",
          create_order_started_at: new Date(now - 10 * MINUTE),
          reconcile_until: reconciling ? new Date(now + 5 * MINUTE) : null,
        })
        .execute(),
    );
    ids.push(id);
    return id;
  }

  /** `run` in a transaction of its own that is rolled back: what it answered. */
  async function rolledBack<T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> {
    const rollback = new Error("rolled back by the test");
    let seen: { readonly value: T } | undefined;
    await alphaTx(async (trx) => {
      seen = { value: await run(trx) };
      throw rollback;
    }).catch((error: unknown) => {
      if (error !== rollback) {
        throw error;
      }
    });
    if (seen === undefined) {
      throw new Error("the transaction did not run");
    }
    return seen.value;
  }

  afterAll(async () => {
    await alphaTx((trx) => trx.deleteFrom("bookings").where("id", "in", ids).execute());
  });

  it.each(["booking_documents", "booking_events"] as const)(
    "[FIX-W26-BOOKINGS AC1] the reconcile claim and the scan's adoption claim a booking while another transaction holds its FOR KEY SHARE (an uncommitted %s insert)",
    async (holder: KeyShareHolder) => {
      const reconciling = await pendingBooking(true);
      const stale = await pendingBooking(false);
      const repository = worker.get(ReconcileRepository, { strict: false });
      const scanner = worker.get(ReconcileScan, { strict: false });
      const holds = [reconciling, stale].map((bookingId) =>
        holdKeyShare(tenantDb, "tenant_alpha", { bookingId, by: holder }),
      );
      let seen: { claimed: unknown; adopted: string[]; updateSkipped: boolean };
      try {
        await Promise.all(holds.map((hold) => hold.held));
        seen = {
          claimed: (await rolledBack((trx) => repository.lock(trx, reconciling, { skipLocked: true })))?.id,
          adopted: (
            await rolledBack((trx) => scanner.adopt(trx, new Date(), "reconcile-test-key-share"))
          ).map((claim) => claim.id),
          // The claims' mode before FIX-W26-BOOKINGS skips it: the key share is held indeed.
          updateSkipped:
            (await rolledBack((trx) =>
              trx
                .selectFrom("bookings")
                .select("id")
                .where("id", "=", reconciling)
                .forUpdate()
                .skipLocked()
                .executeTakeFirst(),
            )) === undefined,
        };
      } finally {
        for (const hold of holds) {
          hold.release();
        }
        await Promise.all(holds.map((hold) => hold.done));
      }

      expect(seen.claimed).toBe(reconciling);
      expect(seen.adopted).toContain(stale);
      expect(seen.updateSkipped).toBe(true);
    },
  );

  it("[FIX-W26-BOOKINGS AC1] still skip a booking that another claim holds: an attempt's claim, a scan's adoption", async () => {
    const reconciling = await pendingBooking(true);
    const stale = await pendingBooking(false);
    const repository = worker.get(ReconcileRepository, { strict: false });
    const scanner = worker.get(ReconcileScan, { strict: false });

    const seen = await rolledBack(async (trx) => {
      // Another attempt's claim and another scan's adoption, held while the others try.
      expect((await repository.lock(trx, reconciling, { skipLocked: true }))?.id).toBe(reconciling);
      expect(
        (await scanner.adopt(trx, new Date(), "reconcile-test-first")).map((claim) => claim.id),
      ).toContain(stale);
      return {
        claimed: await rolledBack((other) => repository.lock(other, reconciling, { skipLocked: true })),
        adopted: (await rolledBack((other) => scanner.adopt(other, new Date(), "reconcile-test-second"))).map(
          (claim) => claim.id,
        ),
      };
    });

    expect(seen.claimed).toBeUndefined();
    expect(seen.adopted).not.toContain(stale);
  });
});
