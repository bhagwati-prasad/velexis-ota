// checkout.completeWithAirlineCard (completeCheckoutWithAirlineCard; OBE-051, OF-05; ota/docs/api-changes.md §3.2,
// OADR-0004 points 2, 3, 5–7, ota/docs/flows/checkout-airline-card.md §2–§4, architecture-booking.md §3) against
// PostgreSQL 16, Redis 7, the Amadeus stub and the fake Stripe API (which the airline card never calls). Both processes
// run in-process on the same database and Redis, as test/integration/bookings/reconcile.int.test.ts runs them:
//
//   - the API's module graph (createTestApp) with AIRLINE_CARD_ENABLED=true, called as the hosted storefront's edge;
//   - the worker's module graph (WorkerModule.forRoot), for the reconciliation of a lost answer: its `Clock` is pointed
//     at a FakeClock that each step sets relative to the booking's `create_order_started_at`, and the file plays the
//     scheduler (the first `booking.reconcile` is promoted, a scan iteration is the per-tenant
//     `bookings.reconcile_scan` job of its minute).
//
// Alpha has the Velexis test Amadeus account (whose `base_url` is the stub, for the worker), the `velexis` test payment
// connection, the airline card on for its test environment, a 10 % markup rule (the airline's price has none) and an
// alert address. Every checkout opens from a priced offer of the stub's Madrid–Paris Orly offer 2 (moved 60 days
// ahead) with its traveller and contact, gets its airline-card payment (checkout.createPayment) and the VISA hint of
// checkout.updatePayment (one goes without it), and is completed with Visa's documented test PAN, or the stub's
// declined test card `4000000000000002` (Amadeus 1304). The stub holds a `timeout` and `timeout-lost` answer for 100 ms
// instead of 30 s.
//
// Each scenario runs in its `beforeAll` hook, with a budget of its own, and keeps what it saw; its tests read it.
// Every API answer is checked against the OTA document. The Stripe keys and the Amadeus credentials are built at run
// time; card values are test data only (OBE-052 proves their absence everywhere; the checks here are the task's own).
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
import type { Job, Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { RECONCILE_SCAN_JOB, type ReconcileJobResult } from "../../../src/bookings/reconcile.processor";
import { RECONCILE_JOB, reconcileJobId } from "../../../src/bookings/reconcile.service";
import { BOOKING_TOKEN_PATTERN } from "../../../src/common/auth/booking-access.guard";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import { minuteBucket, tenantJob } from "../../../src/jobs/fan-out";
import { AIRLINE_CARD_BODY_LIMIT_BYTES } from "../../../src/main";
import { AirlineCardLimits } from "../../../src/payments/airline-card/abuse-limits";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import {
  edgeWriteHeaders,
  newApiKey,
  testApiCredentials,
  testKeyProvider,
  testWorkerVariables,
} from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { probeLockOrder, type LockOrderObservation, type LockOrderProbe } from "../../helpers/lock-order";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const ALPHA_HOST = "alpha.ota.example.com";
const OPS_EMAIL = "ops@alpha-travel.example";
const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const OPERATION = "completeCheckoutWithAirlineCard";

// Test data only: Visa's documented test PAN, the stub's declined test card and a made-up security code.
const TEST_PAN = "4111111111111111";
const DECLINED_PAN = "4000000000000002";
const TEST_CVV = "123";
/** Three years ahead: never expired, within the schema's 2026–2099. */
const EXPIRY_YEAR = new Date().getUTCFullYear() + 3;

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

/**
 * The budget of a scenario hook: a search, a priced offer, a checkout with its traveller, contact, payment and card hint
 * (seven API calls), the completions of the scenario and, for a lost answer, up to two worker attempts. Seconds locally,
 * much longer on a busy 4-CPU runner.
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
let alphaPk: string;
let bookingsQueue: Queue;
let maintenance: Queue;
/** The worker's time (see the file header). */
const clock = new FakeClock();

const quietPoolLogger = { error: (): void => undefined };

interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
    readonly fieldErrors?: Array<{ path: string; code: string; message?: string }>;
  };
}

interface PaymentBody {
  readonly id: string;
  readonly status: string;
  readonly provider: string;
  readonly method: string;
  readonly amount: MoneyBody;
  readonly amountCaptured: MoneyBody;
  readonly card: {
    brand: string;
    last4: string;
    bin: string | null;
    expMonth: number | null;
    expYear: number | null;
  } | null;
}

interface CompletionBody {
  readonly checkoutId: string;
  readonly booking: {
    readonly id: string;
    readonly status: string;
    readonly ticketing: { readonly status: string };
    readonly tickets: ReadonlyArray<{ readonly documentNumber: string }>;
    readonly payments: readonly PaymentBody[];
    readonly totals: { readonly total: MoneyBody };
  };
  readonly bookingToken: string | null;
  readonly bookingTokenExpiresAt: string | null;
  readonly warnings?: ReadonlyArray<{ readonly title: string; readonly detail?: string }>;
}

interface CheckoutBody {
  readonly id: string;
  readonly pricedOfferId: string;
  readonly totals: { readonly total: MoneyBody };
}

/** A supertest answer, as a scenario keeps it. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

/** The card of a request body, Visa's test PAN unless told otherwise. */
const cardOf = (overrides: Record<string, unknown> = {}) => ({
  brand: "VISA",
  holderName: "Anna Berg",
  number: TEST_PAN,
  expiryMonth: 12,
  expiryYear: EXPIRY_YEAR,
  securityCode: TEST_CVV,
  ...overrides,
});

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
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
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

async function issueKey(tenantId: string, kind: "sk" | "pk"): Promise<string> {
  const key = newApiKey(kind);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: kind === "pk" ? "Storefront (test)" : "Server (test)",
      kind: kind === "pk" ? "publishable" : "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      ...(kind === "pk" ? { allowed_origins: [`https://${ALPHA_HOST}`] } : {}),
    })
    .execute();
  return key;
}

const idempotencyKey = (): string => randomBytes(16).toString("hex");
const edgeWrite = (): Record<string, string> => ({ ...edgeWriteHeaders(ALPHA_HOST) });
const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", run);

let searchCount = 0;

/** A priced offer of alpha for the stub's offer 2 of a new search, its flight moved 60 days ahead. */
async function newPricedOffer(): Promise<string> {
  searchCount += 1;
  const searched = await request(api.server)
    .post("/v1/flight-searches")
    .set({ ...edgeWrite(), "Idempotency-Key": idempotencyKey() })
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
    .set({ ...edgeWrite(), "Idempotency-Key": idempotencyKey() })
    .send({ offerIds: [offerId] });
  expect(priced.status).toBe(201);
  return (priced.body as { id: string }).id;
}

/** What a scenario completes: a guest checkout of alpha with its airline-card payment and the VISA card hint. */
interface AirlineCheckout {
  readonly checkout: CheckoutBody;
  readonly payment: PaymentBody;
}

async function airlineCheckout(options: { readonly hint?: boolean } = {}): Promise<AirlineCheckout> {
  const pricedOfferId = await newPricedOffer();
  const created = await request(api.server)
    .post("/v1/checkouts")
    .set({ ...edgeWrite(), "Idempotency-Key": idempotencyKey() })
    .send({ pricedOfferId });
  expect(created.status).toBe(201);
  const checkoutId = (created.body as CheckoutBody).id;
  const travelers = await request(api.server)
    .put(`/v1/checkouts/${checkoutId}/travelers`)
    .set(edgeWrite())
    .send({ travelers: [buildTravelerInput()] });
  expect(travelers.status).toBe(200);
  const contacts = await request(api.server)
    .put(`/v1/checkouts/${checkoutId}/contacts`)
    .set(edgeWrite())
    .send({ contacts: [buildContactInput()] });
  expect(contacts.status).toBe(200);
  const paid = await request(api.server)
    .post(`/v1/checkouts/${checkoutId}/payments`)
    .set({ ...edgeWrite(), "Idempotency-Key": idempotencyKey() })
    .send({ method: "airline_card", termsAccepted: true });
  expect(paid.status).toBe(201);
  let payment = paid.body as PaymentBody;
  if (options.hint !== false) {
    const hinted = await request(api.server)
      .patch(`/v1/payments/${payment.id}`)
      .set(edgeWrite())
      .send({ card: { brand: "VISA", bin: TEST_PAN.slice(0, 6) } });
    expect(hinted.status).toBe(200);
    payment = hinted.body as PaymentBody;
  }
  const checkout = await request(api.server).get(`/v1/checkouts/${checkoutId}`).set(edgeWrite());
  expect(checkout.status).toBe(200);
  return { checkout: checkout.body as CheckoutBody, payment };
}

/** checkout.completeWithAirlineCard on the edge (or with `headers`), its answer checked against the document. */
async function complete(
  { checkout, payment }: AirlineCheckout,
  options: {
    readonly card?: Record<string, unknown>;
    readonly key?: string;
    readonly headers?: Record<string, string>;
    readonly expectedTotal?: MoneyBody;
    readonly extra?: Record<string, unknown>;
  } = {},
): Promise<Answer> {
  const res = await request(api.server)
    .post(`/v1/checkouts/${checkout.id}/airline-card-completion`)
    .set({ ...(options.headers ?? edgeWrite()), "Idempotency-Key": options.key ?? idempotencyKey() })
    .send({
      paymentId: payment.id,
      expectedTotal: options.expectedTotal ?? payment.amount,
      card: options.card ?? cardOf(),
      ...options.extra,
    });
  expectResponseToMatch(OPERATION, res);
  return {
    status: res.status,
    body: res.body as unknown,
    text: res.text,
    headers: res.headers as Record<string, string | string[] | undefined>,
  };
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
        "ticketing_next_attempt_at",
        "issue_requested",
        "checkout_id",
        "pricing_mode",
        "markup_rule_id",
        "failure_code",
        "create_order_started_at",
        "reconcile_until",
        "reconcile_outcome",
        sql<string>`markup_amount::text`.as("markup"),
        sql<string>`fees_amount::text`.as("fees"),
        sql<string>`total_amount::text`.as("total"),
        sql<string>`amount_paid::text`.as("paid"),
      ])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
  );
}

async function bookingsOfCheckout(checkoutId: string) {
  const payments = await alphaTx((trx) =>
    trx
      .selectFrom("payment_events")
      .select(sql<string | null>`payload->>'bookingId'`.as("bookingId"))
      .where(
        "payment_id",
        "in",
        trx.selectFrom("payments").select("id").where("checkout_id", "=", checkoutId),
      )
      .execute(),
  );
  const ids = [...new Set(payments.flatMap((row) => (row.bookingId === null ? [] : [row.bookingId])))];
  return await Promise.all(ids.map((id) => bookingRow(id)));
}

async function paymentRow(paymentId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("payments")
      .select([
        "id",
        "status",
        "booking_id",
        "card_brand",
        "card_bin",
        "card_last4",
        "card_exp_month",
        "card_exp_year",
        "failure_code",
        sql<string>`amount::text`.as("amount"),
        sql<string>`amount_captured::text`.as("captured"),
      ])
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow(),
  );
}

async function paymentEvents(paymentId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("payment_events")
      .select(["type", "status_to as statusTo", sql<string | null>`amount::text`.as("amount"), "payload"])
      .where("payment_id", "=", paymentId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );
}

async function checkoutRow(checkoutId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("checkouts")
      .select(["status", "pricing_mode", "priced_offer_id", sql<string>`total_amount::text`.as("total")])
      .where("id", "=", checkoutId)
      .executeTakeFirstOrThrow(),
  );
}

async function eventTypes(bookingId: string): Promise<string[]> {
  const rows = await alphaTx((trx) =>
    trx.selectFrom("booking_events").select("type").where("booking_id", "=", bookingId).execute(),
  );
  return rows.map((row) => row.type).sort();
}

/** The outbox rows of the tenant whose dedupe key starts with `prefix`. */
async function notificationsLike(prefix: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("notifications")
      .select(["template_key as templateKey", "recipient", "dedupe_key as dedupeKey", "payload"])
      .where("dedupe_key", "like", `${prefix}%`)
      .orderBy("dedupe_key")
      .execute(),
  );
}

/** Every text and jsonb value of the tenant's tables this flow writes, as one text (a light leak check). */
async function storedText(): Promise<string> {
  const { rows } = await alphaTx((trx) =>
    sql<{ text: string }>`
      SELECT concat_ws(' ',
        (SELECT string_agg(t::text, ' ') FROM bookings t),
        (SELECT string_agg(t::text, ' ') FROM booking_events t),
        (SELECT string_agg(t::text, ' ') FROM payments t),
        (SELECT string_agg(t::text, ' ') FROM payment_events t),
        (SELECT string_agg(t::text, ' ') FROM supplier_requests t),
        (SELECT string_agg(t::text, ' ') FROM idempotency_keys t),
        (SELECT string_agg(t::text, ' ') FROM notifications t)) AS text
    `.execute(trx),
  );
  return rows[0]?.text ?? "";
}

/** Fails when `text` shows the test PAN, its last 12 digits or the security code as a JSON value. */
function expectNoCard(text: string, what: string): void {
  expect(text, what).not.toContain(TEST_PAN);
  expect(text, what).not.toContain(TEST_PAN.slice(-12));
  expect(text, what).not.toContain(DECLINED_PAN);
  expect(text, what).not.toContain(`"${TEST_CVV}"`);
}

/** The stub's requests of one Amadeus operation, since the last `stub.clearRequests()`. */
const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

/** Empties the API's throttler counters and the Amadeus token buckets. */
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

/** The first attempt: the worker's clock at `at`, the API's delayed `booking.reconcile` promoted, its result. */
async function firstAttempt(bookingId: string, at: Date): Promise<ReconcileJobResult> {
  clock.set(at);
  const job = await bookingsQueue.getJob(reconcileJobId(bookingId, "first"));
  if (job === undefined) {
    throw new Error("the completion queued no booking.reconcile");
  }
  await job.promote();
  return (await finished(bookingsQueue, reconcileJobId(bookingId, "first")))
    .returnvalue as ReconcileJobResult;
}

/** One `bookings.reconcile_scan` of alpha at `at`, and the booking's `booking.reconcile` it added. */
async function scanAttempt(bookingId: string, at: Date): Promise<ReconcileJobResult> {
  clock.set(at);
  const scan = tenantJob(RECONCILE_SCAN_JOB, alphaId, minuteBucket(at));
  await (await maintenance.getJob(scan.opts.jobId))?.remove();
  await maintenance.add(scan.name, scan.data, scan.opts);
  await finished(maintenance, scan.opts.jobId);
  const job = await finished(bookingsQueue, reconcileJobId(bookingId, minuteBucket(at)));
  expect(job.name).toBe(RECONCILE_JOB);
  return job.returnvalue as ReconcileJobResult;
}

/** `create_order_started_at` plus `ms`. */
const after = (started: Date | null, ms: number): Date => new Date((started?.getTime() ?? 0) + ms);

const errorOf = (answer: Answer): ErrorBody["error"] => (answer.body as ErrorBody).error;
const completionOf = (answer: Answer): CompletionBody => answer.body as CompletionBody;

// Cloning the template, starting the stub and the fake Stripe API and building both module graphs take several
// seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own timeout.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [[OPERATION, [201, 400, 402, 403, 409, 422, 504]]] as const) {
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
    // The `timeout` scenarios hold an answer for 100 ms, then give up with their 504, as after 30 s.
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 100)),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  alphaId = await insertTenant(await insertAccount(clientId, secret));
  alphaSk = await issueKey(alphaId, "sk");
  alphaPk = await issueKey(alphaId, "pk");
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
    // Alpha sells with a 10 % markup: the airline's price has none (OADR-0004 point 4).
    await trx
      .insertInto("markup_rules")
      .values({
        id: newId("mkr"),
        name: "Ten percent",
        scope: JSON.stringify({}),
        calculation: "percentage",
        percentage: "10",
        priority: 10,
      })
      .execute();
    // The OTA turned the airline card on for its test environment (console settings, OBE-070).
    await trx
      .updateTable("storefront_settings")
      .set({ airline_card_enabled_test: true, ops_alert_email: OPS_EMAIL })
      .execute();
  });
  const stripeKeys = { STRIPE_SECRET_KEY_TEST: SECRET_KEY, STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY };
  api = await createTestApp({
    database: db,
    redis,
    imports: [stripeEndpointModule(stripe.endpoint)],
    env: { AMADEUS_BASE_URL_TEST: stub.url, AIRLINE_CARD_ENABLED: "true", ...stripeKeys },
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
  maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  // From here on the file plays the scheduler: no iteration of the real one may fire while it runs.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
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

describe("a card the airline charges (stub success)", () => {
  let paid: AirlineCheckout;
  let key: string;
  let first: Answer;
  let replay: Answer;
  let sent: { readonly body: unknown; readonly query: unknown; readonly redacted: unknown } | undefined;
  let booking: Awaited<ReturnType<typeof bookingRow>>;
  let payment: Awaited<ReturnType<typeof paymentRow>>;
  let events: Awaited<ReturnType<typeof paymentEvents>>;
  let supplierRow: { request: string; response: string };
  let stored: string;
  let logs: string;

  beforeAll(async () => {
    await resetRateLimits();
    paid = await airlineCheckout();
    stub.clearRequests();
    const client = api.app.get(AmadeusClient, { strict: false });
    const real = client.createFlightOrders.bind(client);
    // What the client was handed, kept by the test only: the order with the card and the copy for supplier_requests.
    vi.spyOn(client, "createFlightOrders").mockImplementation(async (context, input, options) => {
      sent = { body: structuredClone(input.body), query: input.query, redacted: options?.redactedRequest };
      return await real(context, input, options);
    });
    const headers = edgeWrite();
    key = idempotencyKey();
    first = await complete(paid, { key, headers });
    replay = await complete(paid, { key, headers });
    const bookingId = completionOf(first).booking.id;
    booking = await bookingRow(bookingId);
    payment = await paymentRow(paid.payment.id);
    events = await paymentEvents(paid.payment.id);
    supplierRow = await alphaTx(async (trx) => {
      const row = await trx
        .selectFrom("supplier_requests")
        .select([
          sql<string>`request_body::text`.as("request"),
          sql<string>`response_body::text`.as("response"),
        ])
        .where("booking_id", "=", bookingId)
        .where("amadeus_operation_id", "=", "createFligtOrders")
        .executeTakeFirstOrThrow();
      return row;
    });
    stored = await storedText();
    logs = api.sink.text();
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-051 AC1] answers 201 with the booking ticketed and its payment captured, carrying the last 4 only", () => {
    expect(first.status).toBe(201);
    const completion = completionOf(first);
    expect(first.headers["location"]).toBe(`/v1/bookings/${completion.booking.id}`);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(completion.checkoutId).toBe(paid.checkout.id);
    expect(completion.booking).toMatchObject({ status: "ticketed", ticketing: { status: "issued" } });
    expect(completion.booking.tickets).toHaveLength(1);
    expect(completion.booking.totals.total).toEqual(paid.payment.amount);
    expect(completion.booking.payments).toEqual([
      expect.objectContaining({
        id: paid.payment.id,
        provider: "airline",
        method: "airline_card",
        status: "captured",
        amountCaptured: paid.payment.amount,
        card: { brand: "VISA", last4: "1111", bin: "411111", expMonth: null, expYear: null },
      }),
    ]);
    // A guest on the edge: the booking token is in the __Host-vx_bt cookie, never in the body (OADR-0006).
    expect([completion.bookingToken, completion.bookingTokenExpiresAt]).toEqual([null, null]);
    expect(String(first.headers["set-cookie"])).toMatch(/__Host-vx_bt=/);
    expectNoCard(first.text, "the answer");
  });

  it("[OBE-051 AC1] records the booking at the airline's price and the payment captured with brand, BIN and last 4", () => {
    expect(booking).toMatchObject({
      status: "ticketed",
      ticketing_status: "issued",
      issue_requested: true,
      pricing_mode: "net",
      markup_rule_id: null,
      markup: "0.00",
      fees: "0.00",
      total: paid.payment.amount.amount,
      paid: paid.payment.amount.amount,
    });
    expect(payment).toMatchObject({
      status: "captured",
      booking_id: booking.id,
      card_brand: "VISA",
      card_bin: "411111",
      card_last4: "1111",
      card_exp_month: null,
      card_exp_year: null,
      failure_code: null,
      captured: paid.payment.amount.amount,
    });
    expect(events.map((event) => event.type)).toEqual([
      "payment.created",
      "payment.amount_updated",
      "payment.processing",
      "airline.charged",
    ]);
    expect(events.at(-1)).toMatchObject({ statusTo: "captured", amount: paid.payment.amount.amount });
  });

  it("[OBE-051 AC1] sends the card once with issue=true and keeps only a copy without it", () => {
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
    expect(sent?.query).toEqual({ issue: true });
    const data = (sent?.body as { data: { formOfPayments: unknown[]; flightOffers: Array<{ id: string }> } })
      .data;
    const offerIds = data.flightOffers.map((offer) => offer.id);
    expect(data.formOfPayments).toEqual([
      {
        creditCard: {
          brand: "VISA",
          holder: "ANNA BERG",
          number: TEST_PAN,
          expiryDate: `${EXPIRY_YEAR}-12`,
          securityCode: TEST_CVV,
          flightOfferIds: offerIds,
          paymentOperationContext: { interactionCondition: "ECOMMERCE" },
        },
      },
    ]);
    // Brand and last 4 only: no holder, no expiry, no security code (FIX-W29-SECURITY).
    expect((sent?.redacted as { data: { formOfPayments: unknown[] } }).data.formOfPayments).toEqual([
      {
        creditCard: {
          brand: "VISA",
          number: "1111",
          flightOfferIds: offerIds,
          paymentOperationContext: { interactionCondition: "ECOMMERCE" },
        },
      },
    ]);
    expect(JSON.parse(supplierRow.request)).toMatchObject({
      data: { formOfPayments: [{ creditCard: { number: "1111" } }] },
    });
    expectNoCard(`${supplierRow.request} ${supplierRow.response}`, "supplier_requests");
  });

  it("[OBE-051 AC1] replays the same key without a second order, and keeps the card nowhere", () => {
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
    expectNoCard(stored, "the tenant's rows");
    expectNoCard(logs, "the API's log lines");
  });
});

describe("the card holder and the expiry, also when Amadeus echoes them (FIX-W29-SECURITY)", () => {
  // A holder and an expiry month used by no other scenario, so a match can only come from this completion.
  const HOLDER = "Ingrid Solberg";
  const EXPIRY_MONTH = 10;
  const expiry = `${EXPIRY_YEAR}-${String(EXPIRY_MONTH).padStart(2, "0")}`;
  let answer: Answer;
  let echoes = 0;
  let rows: {
    readonly supplierRequests: Array<{ request: string | null; response: string | null }>;
    readonly booking: { formOfPayments: string; snapshot: string | null };
    readonly idempotency: string;
  };
  let stored: string;
  let logs: string;

  beforeAll(async () => {
    await resetRateLimits();
    const paid = await airlineCheckout();
    // Amadeus may echo the card it charged with its holder and expiry (the stub masks the number and leaves both
    // out): every answer of this completion that holds forms of payment gets them, as the airline would send them.
    const client = api.app.get(AmadeusClient, { strict: false }) as unknown as {
      fetch: (url: string, init?: RequestInit) => Promise<Response>;
    };
    const realFetch = client.fetch;
    const spy = vi.spyOn(client, "fetch").mockImplementation(async (url, init) => {
      const response = await realFetch(url, init);
      const text = await response.text();
      let body: { data?: { formOfPayments?: Array<{ creditCard?: Record<string, unknown> }> } };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        return new Response(text, { status: response.status, headers: response.headers });
      }
      for (const entry of body.data?.formOfPayments ?? []) {
        if (entry.creditCard !== undefined) {
          entry.creditCard = { ...entry.creditCard, holder: HOLDER.toUpperCase(), expiryDate: expiry };
          echoes += 1;
        }
      }
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    });
    try {
      answer = await complete(paid, { card: cardOf({ holderName: HOLDER, expiryMonth: EXPIRY_MONTH }) });
    } finally {
      spy.mockRestore();
    }
    const bookingId = completionOf(answer).booking.id;
    rows = await alphaTx(async (trx) => ({
      supplierRequests: await trx
        .selectFrom("supplier_requests")
        .select([
          sql<string | null>`request_body::text`.as("request"),
          sql<string | null>`response_body::text`.as("response"),
        ])
        .where("booking_id", "=", bookingId)
        .execute(),
      booking: await trx
        .selectFrom("bookings")
        .select([
          sql<string>`form_of_payments::text`.as("formOfPayments"),
          sql<string | null>`order_snapshot::text`.as("snapshot"),
        ])
        .where("id", "=", bookingId)
        .executeTakeFirstOrThrow(),
      idempotency:
        (
          await sql<{
            text: string | null;
          }>`SELECT string_agg(t::text, ' ') AS text FROM idempotency_keys t`.execute(trx)
        ).rows[0]?.text ?? "",
    }));
    stored = await storedText();
    logs = api.sink.text();
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W29-SECURITY AC2] completes the airline-card checkout while Amadeus echoes the holder and the expiry", () => {
    expect(answer.status).toBe(201);
    expect(completionOf(answer).booking.status).toBe("ticketed");
    expect(echoes).toBeGreaterThan(0);
    expect(rows.supplierRequests.length).toBeGreaterThan(0);
  });

  it("[FIX-W29-SECURITY AC2] keeps brand and last 4 of the card in bookings.form_of_payments and order_snapshot, without holder or expiry", () => {
    /** The `creditCard` objects of a list of forms of payment. */
    const cardsOf = (entries: unknown): unknown[] =>
      (Array.isArray(entries) ? (entries as Array<{ creditCard?: unknown }>) : []).flatMap((entry) =>
        entry.creditCard === undefined ? [] : [entry.creditCard],
      );
    const snapshot = JSON.parse(rows.booking.snapshot ?? "{}") as { formOfPayments?: unknown };
    for (const [what, cards] of [
      ["bookings.form_of_payments", cardsOf(JSON.parse(rows.booking.formOfPayments))],
      ["bookings.order_snapshot", cardsOf(snapshot.formOfPayments)],
    ] as const) {
      expect(cards, what).toEqual([{ brand: "VISA", number: "1111", flightOfferIds: expect.any(Array) }]);
    }
  });

  it("[FIX-W29-SECURITY AC2] finds no holder name or expiry in supplier_requests, bookings, order_snapshot, idempotency rows or the logs", () => {
    const texts: Array<readonly [string, string]> = [
      ["supplier_requests", rows.supplierRequests.map((row) => `${row.request} ${row.response}`).join(" ")],
      ["bookings.form_of_payments", rows.booking.formOfPayments],
      ["bookings.order_snapshot", rows.booking.snapshot ?? ""],
      ["idempotency_keys", rows.idempotency],
      ["the tenant's rows", stored],
      ["the API's log lines", logs],
    ];
    for (const [what, text] of texts) {
      expect(text, what).not.toContain(HOLDER);
      expect(text, what).not.toContain(HOLDER.toUpperCase());
      expect(text, what).not.toContain(expiry);
      expectNoCard(text, what);
    }
  });
});

describe("callers other than the storefront edge", () => {
  let paid: AirlineCheckout;
  let answers: Array<readonly [string, Answer]>;

  beforeAll(async () => {
    await resetRateLimits();
    paid = await airlineCheckout();
    stub.clearRequests();
    answers = [
      ["pk_", await complete(paid, { headers: { "X-Api-Key": alphaPk, Origin: `https://${ALPHA_HOST}` } })],
      ["sk_", await complete(paid, { headers: { "X-Api-Key": alphaSk } })],
      [
        "the OTA admin's service key",
        await complete(paid, {
          headers: {
            "X-Api-Key": testApiCredentials().serviceKey,
            "X-Velexis-Environment": "test",
            "X-Velexis-End-User-IP": "203.0.113.7",
            "X-Velexis-End-User-Agent": "OTA admin test",
          },
        }),
      ],
    ];
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-051 AC2] refuses pk_, sk_ and the service key with 403 SCOPE_NOT_ALLOWED [OF-05 AC2]", async () => {
    for (const [caller, answer] of answers) {
      expect([answer.status, errorOf(answer).code, errorOf(answer).details], caller).toEqual([
        403,
        "SCOPE_NOT_ALLOWED",
        { reason: "edge_only" },
      ]);
      expectNoCard(answer.text, caller);
    }
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    expect(await paymentRow(paid.payment.id)).toMatchObject({
      status: "requires_payment_method",
      booking_id: null,
    });
  });
});

describe("cards the airline declines (stub card 4000000000000002)", () => {
  let paid: AirlineCheckout;
  let other: AirlineCheckout;
  let answers: Answer[];
  let fourth: Answer;
  let createsAfterThree: number;
  let attemptsKey: { value: string | null; ttl: number };
  let suspendedDecline: Answer;
  let whileSuspended: Answer;
  let suspension: { value: string | null; ttl: number };

  beforeAll(async () => {
    await resetRateLimits();
    paid = await airlineCheckout();
    other = await airlineCheckout();
    await resetRateLimits();
    stub.clearRequests();
    const declined = cardOf({ number: DECLINED_PAN });
    answers = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      answers.push(await complete(paid, { card: declined }));
    }
    createsAfterThree = amadeusCalls("createFlightOrders").length;
    // The fourth attempt, with a good card: refused before anything is sent.
    fourth = await complete(paid);
    const counter = `t:${alphaId}:test:ac:chk:${paid.checkout.id}`;
    attemptsKey = { value: await redis.client.get(counter), ttl: await redis.client.ttl(counter) };
    // The tenant's 20th decline within the hour suspends the method (the counter set to 19 by hand). The edge's five
    // completions per minute and IP were used up above.
    await resetRateLimits();
    await redis.client.set(`t:${alphaId}:test:ac:declines`, "19", "EX", 3600);
    suspendedDecline = await complete(other, { card: declined });
    whileSuspended = await complete(other);
    const flag = `t:${alphaId}:test:ac:suspended`;
    suspension = { value: await redis.client.get(flag), ttl: await redis.client.ttl(flag) };
    await redis.client.del(flag);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-051 AC2] answers 402 PAYMENT_DECLINED twice, 403 PAYMENT_ATTEMPTS_EXCEEDED at the third, and refuses the fourth unsent", () => {
    expect(answers.map((answer) => [answer.status, errorOf(answer).code])).toEqual([
      [402, "PAYMENT_DECLINED"],
      [402, "PAYMENT_DECLINED"],
      [403, "PAYMENT_ATTEMPTS_EXCEEDED"],
    ]);
    expect([fourth.status, errorOf(fourth).code]).toEqual([403, "PAYMENT_ATTEMPTS_EXCEEDED"]);
    expect(createsAfterThree).toBe(3);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(3 + 1);
    expect(attemptsKey.value).toBe("3");
    expect(attemptsKey.ttl).toBeGreaterThan(0);
    expect(attemptsKey.ttl).toBeLessThanOrEqual(7200);
    for (const answer of [...answers, fourth]) {
      expectNoCard(answer.text, "a refusal");
    }
  });

  it("[OBE-051 AC2] fails each booking and the payment, never voids, and lets the payment take the next card", async () => {
    const bookings = await bookingsOfCheckout(paid.checkout.id);
    expect(bookings).toHaveLength(3);
    for (const booking of bookings) {
      expect(booking).toMatchObject({
        status: "failed",
        ticketing_status: "not_applicable",
        checkout_id: null,
        failure_code: "PAYMENT_DECLINED",
        pricing_mode: "net",
      });
    }
    expect(await paymentRow(paid.payment.id)).toMatchObject({
      status: "failed",
      failure_code: "PAYMENT_DECLINED",
      card_last4: "0002",
      captured: "0.00",
    });
    const types = (await paymentEvents(paid.payment.id)).map((event) => event.type);
    expect(types.filter((type) => type === "airline.declined")).toHaveLength(3);
    expect(types.filter((type) => type === "payment.processing")).toHaveLength(3);
    expect((await checkoutRow(paid.checkout.id)).status).toBe("payment_pending");
  });

  it("[OBE-051 AC2] alerts the OTA's staff once about the checkout (staff.airline_card_alert)", async () => {
    const alerts = await notificationsLike(`staff.airline_card_alert:repeated_declines:${paid.checkout.id}`);
    expect(alerts).toEqual([
      expect.objectContaining({ templateKey: "staff.airline_card_alert", recipient: OPS_EMAIL }),
    ]);
    expect(alerts[0]?.payload).toMatchObject({ alert: { kind: "repeated_declines" } });
    expectNoCard(JSON.stringify(alerts), "the alert");
    // Velexis ops: the error line (and the e-mail to OPS_ALERT_EMAIL when the process has one).
    expect(
      api.sink.records().filter((line) => line["msg"] === "payments.airline_card_attempts_exceeded"),
    ).toEqual([
      expect.objectContaining({ level: 50, tenantId: alphaId, checkoutId: paid.checkout.id, attempts: 3 }),
    ]);
  });

  it("suspends the method for an hour at the tenant's 20th decline, alerts once, and refuses the next card unsent", async () => {
    expect([suspendedDecline.status, errorOf(suspendedDecline).code]).toEqual([402, "PAYMENT_DECLINED"]);
    expect([whileSuspended.status, errorOf(whileSuspended).code, errorOf(whileSuspended).details]).toEqual([
      403,
      "FEATURE_DISABLED",
      { feature: "airlineCard", reason: "suspended" },
    ]);
    expect(suspension.value).toBe("1");
    expect(suspension.ttl).toBeGreaterThan(0);
    expect(suspension.ttl).toBeLessThanOrEqual(3600);
    expect(await notificationsLike("staff.airline_card_alert:method_suspended:test:")).toEqual([
      expect.objectContaining({ templateKey: "staff.airline_card_alert", recipient: OPS_EMAIL }),
    ]);
    expect(api.sink.records().filter((line) => line["msg"] === "payments.airline_card_suspended")).toEqual([
      expect.objectContaining({ level: 50, tenantId: alphaId, environment: "test", declines: 20 }),
    ]);
    // One order was sent for the other checkout: its decline; the refusal while suspended sent nothing.
    expect(await bookingsOfCheckout(other.checkout.id)).toHaveLength(1);
  });
});

describe("a third decline counted while another completion of the checkout is under way", () => {
  let paid: AirlineCheckout;
  let answer: Answer;
  let checks: number;
  let payment: Awaited<ReturnType<typeof paymentRow>>;
  let booking: Awaited<ReturnType<typeof bookingRow>> | undefined;

  beforeAll(async () => {
    await resetRateLimits();
    paid = await airlineCheckout();
    stub.clearRequests();
    const counter = `t:${alphaId}:test:ac:chk:${paid.checkout.id}`;
    const limits = api.app.get(AirlineCardLimits, { strict: false });
    const real = limits.assertAvailable.bind(limits);
    let calls = 0;
    // The request's first check passes; the checkout's third decline is counted right after it, as a concurrent
    // completion of the checkout counts it before its declined booking frees the checkout.
    const spy = vi.spyOn(limits, "assertAvailable").mockImplementation(async (scope) => {
      calls += 1;
      await real(scope);
      if (calls === 1) {
        await redis.client.set(counter, "3", "EX", 7200);
      }
    });
    try {
      answer = await complete(paid);
    } finally {
      spy.mockRestore();
    }
    checks = calls;
    payment = await paymentRow(paid.payment.id);
    booking = payment.booking_id === null ? undefined : await bookingRow(payment.booking_id);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-051 AC2] checks the limits again before the card is sent and refuses it unsent: 403 PAYMENT_ATTEMPTS_EXCEEDED", () => {
    expect([answer.status, errorOf(answer).code]).toEqual([403, "PAYMENT_ATTEMPTS_EXCEEDED"]);
    expect(checks).toBe(2);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    // The claimed booking fails unsent; the payment still awaits a card and kept nothing of this one.
    expect(booking).toMatchObject({
      status: "failed",
      failure_code: "PAYMENT_ATTEMPTS_EXCEEDED",
      checkout_id: null,
    });
    expect(payment).toMatchObject({
      status: "requires_payment_method",
      card_last4: null,
      failure_code: null,
    });
    expectNoCard(answer.text, "the refusal");
  });
});

describe("cards and requests the server refuses before anything is sent", () => {
  let paid: AirlineCheckout;
  let unquoted: AirlineCheckout;
  let luhn: Answer;
  let expired: Answer;
  let brand: Answer;
  let otherBrand: Answer;
  let noQuote: Answer;
  let wrongTotal: Answer;
  let disabled: Answer;
  let tooLarge: Answer;
  let attempts: string | null;

  beforeAll(async () => {
    await resetRateLimits();
    paid = await airlineCheckout();
    // A checkout whose card fee was never quoted: checkout.updatePayment was not called.
    unquoted = await airlineCheckout({ hint: false });
    await resetRateLimits();
    stub.clearRequests();
    luhn = await complete(paid, { card: cardOf({ number: "4111111111111112" }) });
    expired = await complete(paid, { card: cardOf({ expiryMonth: 1, expiryYear: 2026 }) });
    // Diners Club's documented test number: a brand alpha does not accept.
    brand = await complete(paid, { card: cardOf({ brand: "DINERS", number: "30569309025904" }) });
    // Mastercard's documented test number: accepted by alpha, but the card fee was quoted for a Visa card.
    otherBrand = await complete(paid, { card: cardOf({ brand: "MASTERCARD", number: "5555555555554444" }) });
    await resetRateLimits();
    noQuote = await complete(unquoted);
    wrongTotal = await complete(paid, {
      expectedTotal: { amount: "1.00", currency: paid.payment.amount.currency },
    });
    await alphaTx((trx) =>
      trx.updateTable("storefront_settings").set({ airline_card_enabled_test: false }).execute(),
    );
    try {
      disabled = await complete(paid);
    } finally {
      await alphaTx((trx) =>
        trx.updateTable("storefront_settings").set({ airline_card_enabled_test: true }).execute(),
      );
    }
    tooLarge = await complete(paid, { extra: { padding: "x".repeat(AIRLINE_CARD_BODY_LIMIT_BYTES) } });
    attempts = await redis.client.get(`t:${alphaId}:test:ac:chk:${paid.checkout.id}`);
  }, SCENARIO_TIMEOUT_MS);

  it("answers 400 VALIDATION_FAILED for a bad Luhn digit or a past expiry, by path and without the value", () => {
    expect([luhn.status, errorOf(luhn).code, errorOf(luhn).fieldErrors]).toEqual([
      400,
      "VALIDATION_FAILED",
      [{ path: "/card/number", code: "luhn", message: expect.any(String) }],
    ]);
    expect([expired.status, errorOf(expired).code, errorOf(expired).fieldErrors]).toEqual([
      400,
      "VALIDATION_FAILED",
      [{ path: "/card/expiryYear", code: "expired", message: expect.any(String) }],
    ]);
    expect(luhn.text).not.toContain("4111111111111112");
    expect(luhn.text).not.toContain("111111111112");
  });

  it("answers 422 UNPROCESSABLE for a brand the storefront does not accept, 403 FEATURE_DISABLED while it is off", () => {
    expect([brand.status, errorOf(brand).code, errorOf(brand).details?.["reason"]]).toEqual([
      422,
      "UNPROCESSABLE",
      "card_brand_not_accepted",
    ]);
    expect([disabled.status, errorOf(disabled).code, errorOf(disabled).details]).toEqual([
      403,
      "FEATURE_DISABLED",
      { feature: "airlineCard" },
    ]);
  });

  it("answers 409 PAYMENT_AMOUNT_MISMATCH for a card whose fee was not quoted, or an amount the traveller did not confirm", () => {
    expect([otherBrand.status, errorOf(otherBrand).code, errorOf(otherBrand).details?.["reason"]]).toEqual([
      409,
      "PAYMENT_AMOUNT_MISMATCH",
      "card_changed",
    ]);
    // Without a quote the total holds no card fee, while the airline charges the fee of the card's brand.
    expect([noQuote.status, errorOf(noQuote).code, errorOf(noQuote).details?.["reason"]]).toEqual([
      409,
      "PAYMENT_AMOUNT_MISMATCH",
      "card_changed",
    ]);
    expect([wrongTotal.status, errorOf(wrongTotal).code]).toEqual([409, "PAYMENT_AMOUNT_MISMATCH"]);
    expect(errorOf(wrongTotal).details?.["reason"]).toBeUndefined();
    for (const answer of [otherBrand, noQuote, wrongTotal]) {
      expect(answer.text).not.toContain("5555555555554444");
      expectNoCard(answer.text, "a refusal");
    }
  });

  it("refuses a body over 10 KB before reading it (its own JSON limit)", () => {
    expect([tooLarge.status, errorOf(tooLarge).code, errorOf(tooLarge).details]).toEqual([
      400,
      "INVALID_REQUEST",
      { reason: "body_too_large", limitBytes: AIRLINE_CARD_BODY_LIMIT_BYTES },
    ]);
  });

  it("counts none of them as an attempt, books nothing and sends nothing", async () => {
    expect(attempts).toBeNull();
    expect(amadeusCalls("createFlightOrders")).toHaveLength(0);
    for (const checkout of [paid, unquoted]) {
      expect(await bookingsOfCheckout(checkout.checkout.id)).toEqual([]);
      expect(await paymentRow(checkout.payment.id)).toMatchObject({
        status: "requires_payment_method",
        booking_id: null,
        card_last4: null,
      });
    }
    expect(await redis.client.get(`t:${alphaId}:test:ac:chk:${unquoted.checkout.id}`)).toBeNull();
  });
});

describe("a price the airline raised before the order (re-price)", () => {
  let paid: AirlineCheckout;
  let changed: Answer;
  let failedBooking: Awaited<ReturnType<typeof bookingRow>> | undefined;
  let afterChange: {
    checkout: Awaited<ReturnType<typeof checkoutRow>>;
    payment: Awaited<ReturnType<typeof paymentRow>>;
  };
  let createsAfterChange: number;
  let confirmed: Answer;

  beforeAll(async () => {
    await resetRateLimits();
    paid = await airlineCheckout();
    // Older than the re-price threshold (ten minutes): checkout.complete prices it again.
    await alphaTx((trx) =>
      trx
        .updateTable("priced_offers")
        .set({ created_at: sql<Date>`now() - interval '11 minutes'` })
        .where("id", "=", paid.checkout.pricedOfferId)
        .execute(),
    );
    stub.clearRequests();
    changed = await complete(paid, {
      extra: {},
      headers: { ...edgeWrite(), ...stubScenario("price-changed") },
    });
    createsAfterChange = amadeusCalls("createFlightOrders").length;
    [failedBooking] = await bookingsOfCheckout(paid.checkout.id);
    afterChange = {
      checkout: await checkoutRow(paid.checkout.id),
      payment: await paymentRow(paid.payment.id),
    };
    // The traveller confirms the new total and types the card again.
    const newPrice = errorOf(changed).details?.["newPrice"] as MoneyBody;
    confirmed = await complete(paid, { expectedTotal: newPrice });
  }, SCENARIO_TIMEOUT_MS);

  it("answers 409 PRICE_CHANGED unsent: the checkout and its payment move to the airline's new total, no attempt counted", async () => {
    expect([changed.status, errorOf(changed).code]).toEqual([409, "PRICE_CHANGED"]);
    const details = errorOf(changed).details ?? {};
    expect(details["oldPrice"]).toEqual(paid.payment.amount);
    expect(createsAfterChange).toBe(0);
    expect(failedBooking).toMatchObject({
      status: "failed",
      failure_code: "PRICE_CHANGED",
      checkout_id: null,
    });
    expect(afterChange.checkout).toMatchObject({
      status: "payment_pending",
      pricing_mode: "net",
      priced_offer_id: details["pricedOfferId"],
      total: (details["newPrice"] as MoneyBody).amount,
    });
    expect(Number(afterChange.checkout.total)).toBeGreaterThan(Number(paid.payment.amount.amount));
    expect(afterChange.payment).toMatchObject({
      status: "requires_payment_method",
      amount: afterChange.checkout.total,
    });
    expect(await redis.client.get(`t:${alphaId}:test:ac:chk:${paid.checkout.id}`)).toBeNull();
  });

  it("then books the new total with the same payment", () => {
    expect(confirmed.status).toBe(201);
    expect(completionOf(confirmed).booking.totals.total.amount).toBe(afterChange.checkout.total);
    expect(completionOf(confirmed).booking.payments[0]).toMatchObject({ status: "captured" });
  });
});

describe("an order without every ticket (stub ticketing-failed)", () => {
  let paid: AirlineCheckout;
  let answer: Answer;
  let booking: Awaited<ReturnType<typeof bookingRow>>;

  beforeAll(async () => {
    await resetRateLimits();
    paid = await airlineCheckout();
    stub.clearRequests();
    answer = await complete(paid, { headers: { ...edgeWrite(), ...stubScenario("ticketing-failed") } });
    booking = await bookingRow(completionOf(answer).booking.id);
  }, SCENARIO_TIMEOUT_MS);

  it("answers 201 with a warning: the booking confirmed in the staff's review, the payment processing, no issue retry", async () => {
    expect(answer.status).toBe(201);
    const completion = completionOf(answer);
    expect(completion.booking).toMatchObject({ status: "confirmed", ticketing: { status: "manual_review" } });
    expect(completion.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "TICKETING_MANUAL_REVIEW" })]),
    );
    expect(booking).toMatchObject({
      status: "confirmed",
      ticketing_status: "manual_review",
      ticketing_next_attempt_at: null,
      paid: "0.00",
    });
    expect(await paymentRow(paid.payment.id)).toMatchObject({ status: "processing", card_last4: "1111" });
    expect(amadeusCalls("issueFlightOrder")).toHaveLength(0);
    expect(await eventTypes(booking.id)).toContain("booking.ticketing_manual_review");
    expect(await notificationsLike(`staff.manual_review:${booking.id}:airline_card_not_ticketed`)).toEqual([
      expect.objectContaining({ templateKey: "staff.manual_review", recipient: OPS_EMAIL }),
    ]);
  });
});

describe("an order whose answer was lost but that exists (stub timeout)", () => {
  let paid: AirlineCheckout;
  let key: string;
  let headers: Record<string, string>;
  let timedOut: Answer;
  let pendingPayment: Awaited<ReturnType<typeof paymentRow>>;
  let found: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let finalReplay: Answer;

  beforeAll(async () => {
    useWorkerClock();
    await resetRateLimits();
    paid = await airlineCheckout();
    stub.clearRequests();
    key = idempotencyKey();
    headers = edgeWrite();
    timedOut = await complete(paid, { key, headers: { ...headers, ...stubScenario("timeout") } });
    const bookingId = String(errorOf(timedOut).details?.["bookingId"]);
    pendingPayment = await paymentRow(paid.payment.id);
    const started = (await bookingRow(bookingId)).create_order_started_at;
    found = await firstAttempt(bookingId, after(started, 30 * SECOND));
    decided = await bookingRow(bookingId);
    finalReplay = await complete(paid, { key, headers });
  }, SCENARIO_TIMEOUT_MS);

  it("answers 504 SUPPLIER_TIMEOUT with the pending booking, the payment processing", () => {
    expect([timedOut.status, errorOf(timedOut).code]).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expect(errorOf(timedOut).details).toMatchObject({ bookingToken: null, replayed: false });
    expect(String(timedOut.headers["set-cookie"])).toMatch(/__Host-vx_bt=/);
    expect(pendingPayment).toMatchObject({ status: "processing", card_last4: "1111" });
  });

  it("records the order the reconciliation finds and settles the payment as the airline charged it", async () => {
    expect(found).toMatchObject({ outcome: "found", captured: true, status: "ticketed", ticketing: null });
    expect(decided).toMatchObject({
      status: "ticketed",
      reconcile_outcome: "found",
      pricing_mode: "net",
      paid: paid.payment.amount.amount,
    });
    expect(await paymentRow(paid.payment.id)).toMatchObject({
      status: "captured",
      captured: paid.payment.amount.amount,
    });
    expect((await paymentEvents(paid.payment.id)).map((event) => event.type)).toContain("airline.charged");
    expect(finalReplay.status).toBe(201);
    expect(completionOf(finalReplay).booking).toMatchObject({ id: decided.id, status: "ticketed" });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });
});

describe("an order whose answer was lost and that was never created (stub timeout-lost)", () => {
  let paid: AirlineCheckout;
  let key: string;
  let headers: Record<string, string>;
  let timedOut: Answer;
  let undecidedReplay: Answer;
  let early: ReconcileJobResult;
  let decision: ReconcileJobResult;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let finalReplay: Answer;
  let otherKey: Answer;

  beforeAll(async () => {
    useWorkerClock();
    await resetRateLimits();
    paid = await airlineCheckout();
    stub.clearRequests();
    key = idempotencyKey();
    headers = edgeWrite();
    timedOut = await complete(paid, { key, headers: { ...headers, ...stubScenario("timeout-lost") } });
    const bookingId = String(errorOf(timedOut).details?.["bookingId"]);
    undecidedReplay = await complete(paid, { key, headers });
    const started = (await bookingRow(bookingId)).create_order_started_at;
    early = await firstAttempt(bookingId, after(started, 30 * SECOND));
    decision = await scanAttempt(bookingId, after(started, 15 * MINUTE));
    decided = await bookingRow(bookingId);
    finalReplay = await complete(paid, { key, headers });
    otherKey = await complete(paid);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-051 AC3] answers 504 and replays it while the order is looked for, never sending the card again", () => {
    expect([timedOut.status, errorOf(timedOut).code]).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expect([undecidedReplay.status, errorOf(undecidedReplay).details]).toEqual([
      504,
      expect.objectContaining({ bookingId: decided.id, replayed: true }),
    ]);
    expect(early).toMatchObject({ outcome: "pending", reason: "not_found_yet" });
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
  });

  it("[OBE-051 AC3] ends in manual_review, not failed: the booking pending in the staff's review, the payment processing", async () => {
    expect(decision).toMatchObject({ outcome: "manual_review", reason: "airline_card_not_found" });
    expect(decided).toMatchObject({
      status: "pending",
      reconcile_outcome: "manual_review",
      ticketing_status: "manual_review",
      failure_code: null,
      checkout_id: paid.checkout.id,
    });
    expect(await paymentRow(paid.payment.id)).toMatchObject({ status: "processing", card_last4: "1111" });
    expect((await checkoutRow(paid.checkout.id)).status).toBe("payment_pending");
    expect(await eventTypes(decided.id)).toEqual(
      expect.arrayContaining(["booking.supplier_timeout", "booking.reconcile_manual_review"]),
    );
    expect(await eventTypes(decided.id)).not.toContain("booking.failed");
    expect(
      await notificationsLike(`staff.manual_review:${decided.id}:reconcile_airline_card_not_found`),
    ).toEqual([expect.objectContaining({ templateKey: "staff.manual_review", recipient: OPS_EMAIL })]);
    expect(await notificationsLike(`booking.not_confirmed:${decided.id}`)).toEqual([]);
  });

  it("[OBE-051 AC3] keeps answering the same key's 504 in review, and another key the same pending booking", () => {
    expect([finalReplay.status, errorOf(finalReplay).details]).toEqual([
      504,
      expect.objectContaining({ bookingId: decided.id, replayed: true }),
    ]);
    expect([otherKey.status, errorOf(otherKey).code, errorOf(otherKey).details?.["bookingId"]]).toEqual([
      504,
      "SUPPLIER_TIMEOUT",
      decided.id,
    ]);
    expect(amadeusCalls("createFlightOrders")).toHaveLength(1);
    expect(BOOKING_TOKEN_PATTERN.test(String(errorOf(otherKey).details?.["bookingToken"]))).toBe(false);
  });
});

describe("the airline card's lock order (OADR-0003 point 11: the checkout, the booking, the payment)", () => {
  let recorded: { readonly status: number; readonly seen: LockOrderObservation | undefined };
  let declined: { readonly status: number; readonly seen: LockOrderObservation | undefined };

  /**
   * Completes `paid` with `card` while a probe (test/helpers/lock-order.ts) takes the booking right after Flight Create
   * Orders answered (its `supplier_requests` row written), then probes the payment: the transaction after the call (the
   * record step and the airline's charge, or the failure of a decline) must wait for the booking without the payment's
   * lock.
   */
  async function completeWhileBookingHeld(paid: AirlineCheckout, card: Record<string, unknown>) {
    let probe: LockOrderProbe | undefined;
    const client = api.app.get(AmadeusClient, { strict: false });
    const real = client.createFlightOrders.bind(client);
    const hold = async (): Promise<void> => {
      const pending = await alphaTx((trx) =>
        trx
          .selectFrom("bookings")
          .select("id")
          .where("checkout_id", "=", paid.checkout.id)
          .where("status", "=", "pending")
          .executeTakeFirstOrThrow(),
      );
      probe = probeLockOrder(tenantDb, "tenant_alpha", { bookingId: pending.id, paymentId: paid.payment.id });
      await probe.locked;
    };
    const spy = vi.spyOn(client, "createFlightOrders").mockImplementation(async (context, input, options) => {
      let reply: Awaited<ReturnType<typeof real>>;
      try {
        reply = await real(context, input, options);
      } catch (error) {
        await hold();
        throw error;
      }
      await hold();
      return reply;
    });
    try {
      const answer = await complete(paid, { card });
      return { status: answer.status, seen: await probe?.result };
    } finally {
      spy.mockRestore();
    }
  }

  beforeAll(async () => {
    await resetRateLimits();
    recorded = await completeWhileBookingHeld(await airlineCheckout(), cardOf());
    declined = await completeWhileBookingHeld(await airlineCheckout(), cardOf({ number: DECLINED_PAN }));
  }, SCENARIO_TIMEOUT_MS);

  it("records the order and the airline's charge with the booking locked before the payment", () => {
    expect(recorded).toEqual({ status: 201, seen: { waiterSeen: true, paymentFree: true } });
  });

  it("fails the booking and the payment of a declined card with the booking locked before the payment", () => {
    expect(declined).toEqual({ status: 402, seen: { waiterSeen: true, paymentFree: true } });
  });
});
