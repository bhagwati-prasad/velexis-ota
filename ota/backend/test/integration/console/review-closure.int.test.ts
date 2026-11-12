// console.bookings.closeReview (consoleCloseBookingReview; OBE-099, lead decision (15l) of 2026-11-11; OADR-0003 point
// 5 and its follow-up, ota/docs/runbooks/supplier-timeout-and-reconciliation.md §4.3) against PostgreSQL 16, Redis 7,
// the Amadeus stub and the fake Stripe API of test/helpers/fake-stripe.ts, through the API's whole pipeline (the OTA
// admin's service key with staff tokens, the permission guard, validation, idempotency, the audit interceptor) and
// the worker's queues. Both processes run in-process on the same database and Redis:
//
//   - the API's module graph (createTestApp) with AIRLINE_CARD_ENABLED=true: alpha's secret key completes Stripe
//     checkouts and the hosted storefront's edge completes airline-card ones, each answered by the stub's `timeout`
//     scenario (the order is stored, then the answer is held and given up with a 504) or `timeout-lost` (nothing is
//     stored); staff sign in through the OTA admin's service key with portal tokens;
//   - the worker's module graph (WorkerModule.forRoot): the reconciliation (`ota-bookings`, `ota-maintenance`) that
//     hands each booking to the staff's review, and the `ota-payments` consumer whose `payment.capture_retry` and
//     `payment.void` the closure queues. The e-mail and document consumers are paused: the outbox rows are checked.
//
// Each booking reaches the Reconciliation review the way production gets it there, through the storefront's
// completion and the worker's attempts (the file plays the scheduler: the first `booking.reconcile` is promoted, a scan
// iteration is the per-tenant `bookings.reconcile_scan` job of its minute, the worker's Clock is a FakeClock set
// relative to the booking's `create_order_started_at`): an airline-card order never created goes to the review at
// `reconcile_until` by itself (OBE-051); the others are searched with a Queue List answer whose `meta.count` says the
// queue holds one PNR more than it lists and by-reference reads that Amadeus refuses (spies on the worker's Amadeus
// client, as reconcile.int.test.ts does), so the search stays incomplete and the booking goes to the review instead of
// being found or voided. Fixtures only for what
// no API reaches: another tenant's booking in review (a row of tenant_beta), and the decoy orders of the stub (orders
// of other bookings, created through the worker's Amadeus client as the reconciliation's tests create them).
//
// Every API answer is checked against the OTA document. The Stripe keys and the Amadeus credentials are built at run
// time; card values are test data only (Visa's documented test PAN).
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Global, Module, type DynamicModule, type INestApplicationContext } from "@nestjs/common";
import { encryptValue, hashApiKey, sha256Hex, type KeyProvider } from "@velexis/crypto";
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
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { AMADEUS_LIMITS, DEFAULT_AMADEUS_LIMITS, type AmadeusLimits } from "../../../src/amadeus/limits";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { readCreatedOrder } from "../../../src/bookings/order-recorder";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { RECONCILE_SCAN_JOB, type ReconcileJobResult } from "../../../src/bookings/reconcile.processor";
import { RECONCILE_JOB, reconcileJobId } from "../../../src/bookings/reconcile.service";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { loadWorkerConfig } from "../../../src/config";
import {
  AIRLINE_CARD_CHARGE_NOTE,
  AIRLINE_CARD_NOT_CONFIRMED_SUMMARY,
  REVIEW_CLOSE_ACTION,
  REVIEW_CLOSED_EVENT,
} from "../../../src/console/review-closure.service";
import { DocumentsProcessor } from "../../../src/documents/documents.processor";
import { jobTenant, minuteBucket, tenantJob } from "../../../src/jobs/fan-out";
import { NotificationsProcessor } from "../../../src/notifications/notifications.processor";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { PlatformCache } from "../../../src/tenancy/platform-cache";
import { TenantContext } from "../../../src/tenancy/tenant-context";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderRequestInput, buildOrderTraveler, buildStripeConfirmation } from "../../builders/bookings";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import {
  edgeWriteHeaders,
  newApiKey,
  testApiCredentials,
  testKeyProvider,
  testWorkerVariables,
} from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type Role = "owner" | "admin" | "agent" | "finance" | "viewer";

const ALPHA_HOST = "alpha.ota.example.com";
const OPS_EMAIL = "ops@alpha-travel.example";
const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const BOOKINGS = "/v1/console/bookings";
const OPERATION = "consoleCloseBookingReview";

// Test data only: Visa's documented test PAN and a made-up security code.
const TEST_PAN = "4111111111111111";
const TEST_CVV = "123";
/** Three years ahead: never expired, within the schema's 2026–2099. */
const EXPIRY_YEAR = new Date().getUTCFullYear() + 3;

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

/**
 * The budget of a scenario hook: a search, a priced offer, a checkout with its traveller, contact and payment, a
 * timed-out completion, two worker attempts, the staff's calls and the payments job that follows. Seconds locally,
 * much longer on a busy 4-CPU runner.
 */
const SCENARIO_TIMEOUT_MS = 90_000;
/** How long a hook waits at most for the worker (its jobs take milliseconds to a second). */
const JOB_WAIT = { timeout: 20_000, interval: 25 } as const;

/**
 * The Amadeus buckets of this file: the scenarios make their calls one after the other for one tenant while the
 * worker's clock stands still (no refill), so the buckets hold enough for the whole file (as issue-cancel does).
 */
const LIMITS: AmadeusLimits = Object.freeze({
  ...DEFAULT_AMADEUS_LIMITS,
  credentialBucket: Object.freeze({ ratePerSecond: 20, burst: 500 }),
  tenantBucket: Object.freeze({ ratePerSecond: 5, burst: 500 }),
});

/** A global module that provides LIMITS to the Amadeus client and rate limiter of the API and of the worker. */
function amadeusLimitsModule(): DynamicModule {
  @Global()
  @Module({})
  class TestAmadeusLimitsModule {}
  return {
    module: TestAmadeusLimitsModule,
    providers: [{ provide: AMADEUS_LIMITS, useValue: LIMITS }],
    exports: [AMADEUS_LIMITS],
    global: true,
  };
}

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
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };
let bookingsQueue: Queue;
let paymentsQueue: Queue;
let maintenance: Queue;
/** The worker's time (see the file header). */
const clock = new FakeClock();

const quietPoolLogger = { error: (): void => undefined };

// ---- Platform rows -------------------------------------------------------------------------------------------------

async function insertAccount(): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(stubCredentials.clientSecret, {
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
      client_id: stubCredentials.clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

/** The active tenant alpha with its test Amadeus connection (the stub) and its Velexis-mode Stripe connection. */
async function insertTenant(accountId: string): Promise<string> {
  const id = newId("ten");
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

interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly role: Role;
}

async function insertMember(role: Role): Promise<Member> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: `staff.${randomBytes(4).toString("hex")}@example.com`,
      full_name: "Maria Lopez",
      status: "active",
      email_verified_at: new Date(),
      locale: "en-GB",
      time_zone: "Europe/Paris",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: alphaId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, role };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stores a portal token for `member` as the platform's API does (PADR-0007 item 1). */
async function portalTokenFor(member: Member): Promise<string> {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: alphaId,
    membershipId: member.staffId,
    role: member.role,
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 60, "NX")).toBe(
    "OK",
  );
  return token;
}

let ipCounter = 0;

/** A staff member signed in through the OTA admin (its service key, the staff member's IP, the test environment). */
class AdminSession {
  readonly ip: string;
  readonly userAgent = `Mozilla/5.0 (OTA admin test ${randomBytes(3).toString("hex")})`;
  accessToken = "";

  constructor(readonly member: Member) {
    ipCounter += 1;
    this.ip = `198.51.100.${ipCounter}`;
  }

  headers(): Record<string, string> {
    return {
      "X-Api-Key": testApiCredentials().serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": this.userAgent,
      "X-Velexis-Environment": "test",
      ...(this.accessToken === "" ? {} : { Authorization: `Bearer ${this.accessToken}` }),
    };
  }

  async signIn(): Promise<this> {
    const res = await request(api.server)
      .post("/v1/console/auth/sign-in")
      .set({ ...this.headers(), "Idempotency-Key": randomUUID() })
      .send({ grantType: "portal_token", portalToken: await portalTokenFor(this.member) });
    expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
    this.accessToken = (res.body.session as { accessToken: string }).accessToken;
    return this;
  }

  get(bookingId: string) {
    return request(api.server).get(`${BOOKINGS}/${bookingId}`).set(this.headers());
  }

  closeReview(bookingId: string, ifMatch: string, body: JsonObject, key: string = randomUUID()) {
    return request(api.server)
      .post(`${BOOKINGS}/${bookingId}/review-closure`)
      .set({ ...this.headers(), "If-Match": ifMatch, "Idempotency-Key": key })
      .send(body);
  }

  import(body: JsonObject) {
    return request(api.server)
      .post(`${BOOKINGS}/imports`)
      .set({ ...this.headers(), "Idempotency-Key": randomUUID() })
      .send(body);
  }
}

const sessions = new Map<Role, AdminSession>();

/** A signed-in staff member of `role` (one per role and file: the sign-in limit counts per IP). */
async function staff(role: Role): Promise<AdminSession> {
  const known = sessions.get(role);
  if (known !== undefined) {
    return known;
  }
  const session = await new AdminSession(await insertMember(role)).signIn();
  sessions.set(role, session);
  return session;
}

// ---- Tenant rows ---------------------------------------------------------------------------------------------------

const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", run);
const betaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_beta", run);

async function bookingRow(bookingId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("bookings")
      .select([
        "id",
        "reference",
        "status",
        "version",
        "ticketing_status",
        "ticketing_requested_at",
        "ticketing_next_attempt_at",
        "checkout_id",
        "record_locator",
        "amadeus_order_id",
        "failure_code",
        "create_order_started_at",
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
      .select([
        "id",
        "status",
        "booking_id",
        "method",
        "failure_code",
        sql<string>`amount_captured::text`.as("captured"),
      ])
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow(),
  );
}

async function paymentEventTypes(paymentId: string): Promise<string[]> {
  const rows = await alphaTx((trx) =>
    trx
      .selectFrom("payment_events")
      .select("type")
      .where("payment_id", "=", paymentId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );
  return rows.map((row) => row.type);
}

async function checkoutStatus(checkoutId: string): Promise<string> {
  const row = await alphaTx((trx) =>
    trx.selectFrom("checkouts").select("status").where("id", "=", checkoutId).executeTakeFirstOrThrow(),
  );
  return row.status;
}

async function eventsOf(bookingId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("booking_events")
      .select([
        "type",
        "actor_type as actorType",
        "actor_id as actorId",
        "status_to as statusTo",
        "summary",
        "data",
        "visible_to_customer as visible",
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );
}

async function staffActionsOf(bookingId: string, action?: string) {
  const rows = await alphaTx((trx) =>
    trx
      .selectFrom("staff_actions")
      .select([
        "action",
        "outcome",
        "actor_type as actorType",
        "staff_id as staffId",
        "reason",
        "before",
        "after",
      ])
      .where((eb) => eb.or([eb("booking_id", "=", bookingId), eb("target_id", "=", bookingId)]))
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );
  return action === undefined ? rows : rows.filter((row) => row.action === action);
}

async function notificationsOf(bookingId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("notifications")
      .select(["template_key as templateKey", "recipient", "dedupe_key as dedupeKey"])
      .where("booking_id", "=", bookingId)
      .orderBy("template_key")
      .execute(),
  );
}

/** Every text and jsonb value of the tenant's tables a closure writes, as one text (a light leak check). */
async function storedText(): Promise<string> {
  const { rows } = await alphaTx((trx) =>
    sql<{ text: string }>`
      SELECT concat_ws(' ',
        (SELECT string_agg(t::text, ' ') FROM booking_events t),
        (SELECT string_agg(t::text, ' ') FROM payment_events t),
        (SELECT string_agg(t::text, ' ') FROM staff_actions t),
        (SELECT string_agg(t::text, ' ') FROM idempotency_keys t),
        (SELECT string_agg(t::text, ' ') FROM notifications t)) AS text
    `.execute(trx),
  );
  return rows[0]?.text ?? "";
}

// ---- The storefront's completions -----------------------------------------------------------------------------------

const idempotencyKey = (): string => randomBytes(16).toString("hex");
const keyHeaders = (): Record<string, string> => ({ "X-Api-Key": alphaSk });
const edgeWrite = (): Record<string, string> => ({ ...edgeWriteHeaders(ALPHA_HOST) });

let searchCount = 0;

/** A priced offer of alpha for the stub's offer 2 of a new search, its flight moved 60 days ahead. */
async function newPricedOffer(headers: Record<string, string>): Promise<string> {
  searchCount += 1;
  const searched = await request(api.server)
    .post("/v1/flight-searches")
    .set({ ...headers, "Idempotency-Key": idempotencyKey() })
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
    .set({ ...headers, "Idempotency-Key": idempotencyKey() })
    .send({ offerIds: [offerId] });
  expect(priced.status).toBe(201);
  return (priced.body as { id: string }).id;
}

/** A guest checkout of alpha with its traveller (`lastName`) and contact; its id and contact e-mail. */
async function readyCheckout(
  headers: Record<string, string>,
  lastName: string,
): Promise<{ readonly checkoutId: string; readonly contactEmail: string }> {
  const pricedOfferId = await newPricedOffer(headers);
  const created = await request(api.server)
    .post("/v1/checkouts")
    .set({ ...headers, "Idempotency-Key": idempotencyKey() })
    .send({ pricedOfferId });
  expect(created.status).toBe(201);
  const checkoutId = (created.body as { id: string }).id;
  const traveler = buildTravelerInput();
  const travelers = await request(api.server)
    .put(`/v1/checkouts/${checkoutId}/travelers`)
    .set(headers)
    .send({ travelers: [{ ...traveler, name: { ...traveler.name, lastName } }] });
  expect(travelers.status).toBe(200);
  const contact = buildContactInput();
  const contacts = await request(api.server)
    .put(`/v1/checkouts/${checkoutId}/contacts`)
    .set(headers)
    .send({ contacts: [contact] });
  expect(contacts.status).toBe(200);
  return { checkoutId, contactEmail: contact.emailAddress ?? "" };
}

/** What a timed-out completion left: the pending booking, its checkout and its payment. */
interface Completed {
  readonly kind: "stripe" | "airline";
  readonly bookingId: string;
  readonly checkoutId: string;
  readonly paymentId: string;
  readonly providerPaymentId: string | null;
  readonly contactEmail: string;
  readonly started: Date;
}

/** The booking of a `504 SUPPLIER_TIMEOUT` answer. */
function timedOutBookingOf(res: Response): string {
  expect([res.status, (res.body as { error?: { code?: string } }).error?.code]).toEqual([
    504,
    "SUPPLIER_TIMEOUT",
  ]);
  return String((res.body as { error: { details: JsonObject } }).error.details["bookingId"]);
}

/** A Stripe checkout of alpha paid by card and completed with alpha's secret key, the stub answering `scenario`. */
async function stripeCompletion(scenario: "timeout" | "timeout-lost", lastName: string): Promise<Completed> {
  const { checkoutId, contactEmail } = await readyCheckout(keyHeaders(), lastName);
  const paid = await request(api.server)
    .post(`/v1/checkouts/${checkoutId}/payments`)
    .set({ ...keyHeaders(), "Idempotency-Key": idempotencyKey() })
    .send({ method: "card", termsAccepted: true });
  expect(paid.status).toBe(201);
  const payment = paid.body as { id: string; providerPaymentId: string | null; amount: { amount: string } };
  stripe.update(
    payment.providerPaymentId ?? "",
    buildStripeConfirmation(Math.round(Number(payment.amount.amount) * 100)),
  );
  const res = await request(api.server)
    .post(`/v1/checkouts/${checkoutId}/complete`)
    .set({ ...keyHeaders(), "Idempotency-Key": idempotencyKey(), ...stubScenario(scenario) })
    .send({});
  const bookingId = timedOutBookingOf(res);
  return {
    kind: "stripe",
    bookingId,
    checkoutId,
    paymentId: payment.id,
    providerPaymentId: payment.providerPaymentId,
    contactEmail,
    started: await startedOf(bookingId),
  };
}

/** An airline-card checkout of alpha completed on the storefront's edge with Visa's test PAN, the stub answering `scenario`. */
async function airlineCompletion(scenario: "timeout" | "timeout-lost", lastName: string): Promise<Completed> {
  const { checkoutId, contactEmail } = await readyCheckout(edgeWrite(), lastName);
  const created = await request(api.server)
    .post(`/v1/checkouts/${checkoutId}/payments`)
    .set({ ...edgeWrite(), "Idempotency-Key": idempotencyKey() })
    .send({ method: "airline_card", termsAccepted: true });
  expect(created.status).toBe(201);
  const payment = created.body as { id: string; amount: { amount: string; currency: string } };
  const hinted = await request(api.server)
    .patch(`/v1/payments/${payment.id}`)
    .set(edgeWrite())
    .send({ card: { brand: "VISA", bin: TEST_PAN.slice(0, 6) } });
  expect(hinted.status).toBe(200);
  const res = await request(api.server)
    .post(`/v1/checkouts/${checkoutId}/airline-card-completion`)
    .set({ ...edgeWrite(), "Idempotency-Key": idempotencyKey(), ...stubScenario(scenario) })
    .send({
      paymentId: payment.id,
      expectedTotal: (hinted.body as { amount: { amount: string; currency: string } }).amount,
      card: {
        brand: "VISA",
        holderName: "Anna Berg",
        number: TEST_PAN,
        expiryMonth: 12,
        expiryYear: EXPIRY_YEAR,
        securityCode: TEST_CVV,
      },
    });
  const bookingId = timedOutBookingOf(res);
  return {
    kind: "airline",
    bookingId,
    checkoutId,
    paymentId: payment.id,
    providerPaymentId: null,
    contactEmail,
    started: await startedOf(bookingId),
  };
}

async function startedOf(bookingId: string): Promise<Date> {
  const started = (await bookingRow(bookingId)).create_order_started_at;
  if (started === null) {
    throw new Error("a pending booking without create_order_started_at");
  }
  return started;
}

// ---- The worker: the reconciliation hands the booking to the staff ---------------------------------------------------

/** Empties the API's throttler counters and the Amadeus token buckets. */
async function resetRateLimits(): Promise<void> {
  const found = await redis.client.keys("rl:*");
  if (found.length > 0) {
    await redis.client.del(...found);
  }
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

const after = (started: Date, ms: number): Date => new Date(started.getTime() + ms);

/**
 * A booking in Reconciliation review (see the file header): a completion of `kind` whose answer the stub loses
 * (`timeout`: the order exists; `timeout-lost`: it was never created), then the reconciliation's first attempt and its
 * attempt at `reconcile_until`, which hands it to the staff. Its search sees a Queue List that may leave PNRs out and
 * by-reference reads that Amadeus refuses, except for an airline card without an order, which the reconciliation hands
 * to the staff by itself.
 */
async function bookingInReview(
  kind: "stripe" | "airline",
  scenario: "timeout" | "timeout-lost",
  lastName: string,
): Promise<Completed> {
  const clockSpy = vi
    .spyOn(worker.get(Clock, { strict: false }), "now")
    .mockImplementation(() => clock.now());
  await resetRateLimits();
  stub.setDefaultScenario("success");
  const completed =
    kind === "stripe"
      ? await stripeCompletion(scenario, lastName)
      : await airlineCompletion(scenario, lastName);
  const client = worker.get(AmadeusClient, { strict: false });
  const real = client.listQueue.bind(client);
  const spoiled = kind === "stripe" || scenario === "timeout";
  const spy = vi.spyOn(client, "listQueue").mockImplementation(async (context, input, options) => {
    const reply = await real(context, input, options);
    if (spoiled && context.bookingId === completed.bookingId) {
      // Amadeus says the queue holds one PNR more than it listed: the search can prove nothing.
      const body = reply.body as { meta?: Record<string, unknown>; data?: unknown[] };
      body.meta = { ...body.meta, count: (body.data?.length ?? 0) + 1 };
    }
    return reply;
  });
  const read = client.getFlightOrderByReference.bind(client);
  const readSpy = vi
    .spyOn(client, "getFlightOrderByReference")
    .mockImplementation(async (context, input, options) => {
      if (spoiled && context.bookingId === completed.bookingId) {
        // Amadeus refuses the reads of the PNRs that may be the order (a 4xx another attempt would meet again): the
        // reconciliation can neither find the order nor prove it absent.
        throw new AppError("SUPPLIER_REJECTED");
      }
      return await read(context, input, options);
    });
  try {
    expect(await firstAttempt(completed.bookingId, after(completed.started, 30 * SECOND))).toMatchObject({
      outcome: "pending",
    });
    expect(await scanAttempt(completed.bookingId, after(completed.started, 15 * MINUTE))).toMatchObject({
      outcome: "manual_review",
    });
  } finally {
    spy.mockRestore();
    readSpy.mockRestore();
    // The staff close the review in real time: the payments job's issuance is due now, not 15 minutes ahead.
    clockSpy.mockRestore();
  }
  expect(await bookingRow(completed.bookingId)).toMatchObject({
    status: "pending",
    reconcile_outcome: "manual_review",
    checkout_id: completed.checkoutId,
  });
  return completed;
}

/** The record locator of the stub's order that carries the remark `VELEXIS <reference>`. */
function recordLocatorOf(reference: string): string {
  const order = stub.orders.list().find((stored) => {
    const general = (stored.remarks?.["general"] ?? []) as Array<{ text?: string }>;
    return general.some((remark) => remark.text === `VELEXIS ${reference}`);
  });
  if (order === undefined) {
    throw new Error(`the stub holds no order of booking ${reference}`);
  }
  return order.recordLocator;
}

/** An order of another booking in alpha's office (its own VELEXIS remark), created as the reconciliation's tests do. */
async function decoyOrder(lastName: string): Promise<string> {
  const tenant = await worker.get(PlatformCache, { strict: false }).tenantById(alphaId);
  if (tenant === null) {
    throw new Error("alpha is not readable");
  }
  const requestId = `review-test-${randomBytes(4).toString("hex")}`;
  const built = buildCreateOrderRequest(
    buildOrderRequestInput({
      reference: newBookingReference(),
      queue: { number: 50, category: 0 },
      offices: { queuing: office, owner: office },
      issue: false,
      travelers: [buildOrderTraveler({ travelerId: "1", lastName })],
    }),
  );
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

// ---- Answers -------------------------------------------------------------------------------------------------------

/** `[status, error code]` of an answer, `undefined` for a success. */
const answer = (res: Response): [number, string | undefined] => [
  res.status,
  (res.body as { error?: { code?: string } }).error?.code,
];

const errorOf = (res: Response): { code: string; details?: JsonObject; fieldErrors?: JsonObject[] } =>
  (res.body as { error: { code: string; details?: JsonObject; fieldErrors?: JsonObject[] } }).error;

/** The booking's ETag as the console reads it. */
async function etagOf(session: AdminSession, bookingId: string): Promise<string> {
  const res = await session.get(bookingId);
  expect(answer(res)).toEqual([200, undefined]);
  return res.headers["etag"] as string;
}

/** The booking's state that a refusal must leave as it was. */
async function unchanged(completed: Completed) {
  return {
    booking: await bookingRow(completed.bookingId),
    payment: await paymentRow(completed.paymentId),
    checkout: await checkoutStatus(completed.checkoutId),
    events: (await eventsOf(completed.bookingId)).map((event) => event.type),
  };
}

// Cloning the template, starting the stub and the fake Stripe API and building both module graphs take several
// seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own timeout.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    [OPERATION, [200, 400, 403, 404, 409, 412]],
    ["consoleGetBooking", [200, 404]],
    ["consoleImportBooking", [201]],
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
  stubCredentials = {
    clientId: `velexis-test-${randomBytes(4).toString("hex")}`,
    clientSecret: randomBytes(24).toString("base64url"),
  };
  office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  stub = await startAmadeusStub({
    credentials: stubCredentials,
    // The `timeout` scenarios hold an answer for 100 ms, then give up with their 504, as after 30 s.
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 100)),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  alphaId = await insertTenant(await insertAccount());
  alphaSk = await issueKey(alphaId);
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
    // The airline card on for alpha's test environment (OBE-070), and the staff's alert address.
    await trx
      .updateTable("storefront_settings")
      .set({ airline_card_enabled_test: true, ops_alert_email: OPS_EMAIL })
      .execute();
  });
  const stripeKeys = { STRIPE_SECRET_KEY_TEST: SECRET_KEY, STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY };
  api = await createTestApp({
    database: db,
    redis,
    imports: [stripeEndpointModule(stripe.endpoint), amadeusLimitsModule()],
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
      amadeusLimitsModule(),
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
  // From here on the file plays the scheduler, and no e-mail or document is rendered: the file reads the outbox rows.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
  await worker.get(NotificationsProcessor, { strict: false }).worker.pause();
  await worker.get(DocumentsProcessor, { strict: false }).worker.pause();
  // The sign-ins open the pools' connections and warm the token and validation code once, for every scenario.
  for (const role of ["agent", "finance"] as const) {
    await staff(role);
  }
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  vi.restoreAllMocks();
  await worker?.close();
  await api?.close();
  await stub?.stop();
  await stripe?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

// ---- order_found, Stripe -------------------------------------------------------------------------------------------

describe("a Stripe booking in review whose order exists, closed as order_found", () => {
  let review: Completed;
  let reference: string;
  let recordLocator: string;
  let agent: AdminSession;
  let before: JsonObject;
  let key: string;
  let closed: Response;
  let replay: Response;
  let again: Response;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let captureCalls: number;

  beforeAll(async () => {
    review = await bookingInReview("stripe", "timeout", "FOUNDSTRIPE");
    reference = (await bookingRow(review.bookingId)).reference;
    recordLocator = recordLocatorOf(reference);
    agent = await staff("agent");
    const viewed = await agent.get(review.bookingId);
    before = viewed.body as JsonObject;
    stub.clearRequests();
    stripe.requests.length = 0;
    key = randomUUID();
    closed = await agent.closeReview(
      review.bookingId,
      viewed.headers["etag"] as string,
      {
        outcome: "order_found",
        recordLocator,
        note: `Found on queue 50 with the remark VELEXIS ${reference}.`,
      },
      key,
    );
    // The payments job captures the authorisation (promoted to run now after the closure's commit).
    await vi.waitFor(async () => {
      expect((await paymentRow(review.paymentId)).status).toBe("captured");
    }, JOB_WAIT);
    captureCalls = stripe.requests.filter(
      (req) =>
        req.method === "POST" && req.path === `/v1/payment_intents/${review.providerPaymentId ?? ""}/capture`,
    ).length;
    decided = await bookingRow(review.bookingId);
    replay = await agent.closeReview(
      review.bookingId,
      viewed.headers["etag"] as string,
      {
        outcome: "order_found",
        recordLocator,
        note: `Found on queue 50 with the remark VELEXIS ${reference}.`,
      },
      key,
    );
    // A new key with the booking's current ETag (the payments job moved its version since the closure's answer).
    again = await agent.closeReview(review.bookingId, await etagOf(agent, review.bookingId), {
      outcome: "order_found",
      recordLocator,
    });
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-099 AC1] was offered: canCloseReview true for the agent, the other actions refused as pending", () => {
    expect((before["consoleActions"] as JsonObject)["canCloseReview"]).toBe(true);
    expect(before).toMatchObject({
      status: "pending",
      consoleActions: {
        canIssue: false,
        canCancel: false,
        reasons: { canIssue: "pending", canCancel: "pending" },
      },
    });
  });

  it("[OBE-099 AC1] answers 200 with the booking confirmed, its record locator and the new ETag", () => {
    expect(answer(closed)).toEqual([200, undefined]);
    expectResponseToMatch(OPERATION, closed);
    const body = closed.body as JsonObject;
    expect(body).toMatchObject({
      id: review.bookingId,
      status: "confirmed",
      recordLocator,
      consoleActions: { canCloseReview: false, reasons: { canCloseReview: "not_in_review" } },
    });
    expect(closed.headers["etag"]).toBe(`"${String(body["version"])}"`);
    expect(closed.headers["cache-control"]).toBe("private, no-store");
  });

  it("[OBE-099 AC1] records the order through the found path: reconcile_outcome found, the checkout's lock released", async () => {
    expect(decided).toMatchObject({
      status: "confirmed",
      reconcile_outcome: "found",
      record_locator: recordLocator,
      checkout_id: review.checkoutId,
      failure_code: null,
    });
    expect(decided.amadeus_order_id).not.toBeNull();
    expect(await checkoutStatus(review.checkoutId)).toBe("completed");
    // One read by record locator of the API, and never a second Flight Create Orders.
    expect(stub.requests().filter((entry) => entry.operation === "getFlightOrderByReference")).toHaveLength(
      1,
    );
    expect(stub.requests().filter((entry) => entry.operation === "createFlightOrders")).toHaveLength(0);
    expect(stub.orders.list().filter((order) => order.recordLocator === recordLocator)).toHaveLength(1);
  });

  it("[OBE-099 AC1] has the payments job capture the authorisation once, and makes the issuance due", async () => {
    expect(await paymentRow(review.paymentId)).toMatchObject({ status: "captured", captured: decided.total });
    expect(captureCalls).toBe(1);
    expect(decided.paid).toBe(decided.total);
    // The issue_after_payment policy: the capture asks for the issuance, which the ticketing job takes now.
    expect(decided.ticketing_status).toBe("pending");
    expect(decided.ticketing_requested_at).not.toBeNull();
    expect(decided.ticketing_next_attempt_at?.getTime()).toBeLessThanOrEqual(Date.now() + MINUTE);
    expect(await paymentEventTypes(review.paymentId)).toContain("payment.captured");
  });

  it("[OBE-099 AC1] writes booking.reconcile_closed by the staff member, the note, the staff action and the e-mail", async () => {
    const events = await eventsOf(review.bookingId);
    const closedEvent = events.find((event) => event.type === REVIEW_CLOSED_EVENT);
    expect(closedEvent).toMatchObject({
      actorType: "staff",
      actorId: agent.member.staffId,
      statusTo: "confirmed",
      visible: false,
      data: { outcome: "order_found", recordLocator },
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["booking.created", REVIEW_CLOSED_EVENT, "staff.note"]),
    );
    expect(events.find((event) => event.type === "staff.note")).toMatchObject({
      actorType: "staff",
      visible: false,
    });
    const [action] = await staffActionsOf(review.bookingId, REVIEW_CLOSE_ACTION);
    expect(action).toMatchObject({
      outcome: "succeeded",
      actorType: "staff",
      staffId: agent.member.staffId,
      reason: `Found on queue 50 with the remark VELEXIS ${reference}.`,
      before: { status: "pending", reconcileOutcome: "manual_review" },
      after: {
        outcome: "order_found",
        status: "confirmed",
        reconcileOutcome: "found",
        recordLocator,
        payments: [{ id: review.paymentId, action: "capture_queued" }],
      },
    });
    expect(await notificationsOf(review.bookingId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ templateKey: "booking.confirmed", recipient: review.contactEmail }),
      ]),
    );
    expect((await notificationsOf(review.bookingId)).map((row) => row.templateKey)).not.toContain(
      "booking.not_confirmed",
    );
  });

  it("[OBE-099 AC2] replays the first answer for the same key, and answers a new key 409 not_in_review without a change", async () => {
    expect(answer(replay)).toEqual([200, undefined]);
    expect((replay.body as JsonObject)["version"]).toBe((closed.body as JsonObject)["version"]);
    expect(answer(again)).toEqual([409, "CONFLICT"]);
    expectResponseToMatch(OPERATION, again);
    expect(errorOf(again).details).toEqual({
      reason: "not_in_review",
      status: "confirmed",
      reconcileOutcome: "found",
    });
    expect((await bookingRow(review.bookingId)).version).toBe(decided.version);
    expect(await staffActionsOf(review.bookingId, REVIEW_CLOSE_ACTION)).toEqual([
      expect.objectContaining({ outcome: "succeeded" }),
    ]);
  });
});

// ---- order_found, airline card -------------------------------------------------------------------------------------

describe("an airline-card booking in review whose order exists, closed as order_found", () => {
  let review: Completed;
  let recordLocator: string;
  let closed: Response;
  let decided: Awaited<ReturnType<typeof bookingRow>>;

  beforeAll(async () => {
    review = await bookingInReview("airline", "timeout", "FOUNDCARD");
    recordLocator = recordLocatorOf((await bookingRow(review.bookingId)).reference);
    const agent = await staff("agent");
    stripe.requests.length = 0;
    closed = await agent.closeReview(review.bookingId, await etagOf(agent, review.bookingId), {
      outcome: "order_found",
      recordLocator,
    });
    decided = await bookingRow(review.bookingId);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-099 AC1] records the order the airline issued and settles the payment as the airline charged it", async () => {
    expect(answer(closed)).toEqual([200, undefined]);
    expectResponseToMatch(OPERATION, closed);
    expect(decided).toMatchObject({
      status: "ticketed",
      reconcile_outcome: "found",
      record_locator: recordLocator,
    });
    expect(await checkoutStatus(review.checkoutId)).toBe("completed");
    expect(await paymentRow(review.paymentId)).toMatchObject({ status: "captured", method: "airline_card" });
    expect(await paymentEventTypes(review.paymentId)).toContain("airline.charged");
    // Velexis never charges an airline card: no Stripe call, no capture job.
    expect(stripe.requests).toEqual([]);
    expect(await paymentsQueue.getJob(`capture-retry-${review.paymentId}`)).toBeUndefined();
    const [action] = await staffActionsOf(review.bookingId, REVIEW_CLOSE_ACTION);
    expect(action).toMatchObject({
      outcome: "succeeded",
      actorType: "staff",
      before: { status: "pending", reconcileOutcome: "manual_review" },
      after: {
        outcome: "order_found",
        status: "ticketed",
        reconcileOutcome: "found",
        recordLocator,
        payments: [{ id: review.paymentId, action: "airline_charged" }],
      },
    });
    expect(
      (await eventsOf(review.bookingId)).find((event) => event.type === REVIEW_CLOSED_EVENT),
    ).toMatchObject({
      actorType: "staff",
      statusTo: "ticketed",
      visible: false,
      data: { outcome: "order_found", recordLocator },
    });
    expect((await notificationsOf(review.bookingId)).map((row) => row.templateKey)).toContain(
      "booking.confirmed",
    );
  });

  it("[OBE-099] keeps no card value anywhere the closure wrote", async () => {
    const text = await storedText();
    expect(text).not.toContain(TEST_PAN);
    expect(text).not.toContain(TEST_PAN.slice(-12));
    expect(text).not.toContain(`"${TEST_CVV}"`);
  });
});

// ---- Refusals, then not_booked, Stripe -----------------------------------------------------------------------------

describe("a Stripe booking in review whose order was never created: the refusals, then not_booked", () => {
  let review: Completed;
  let reference: string;
  let etag: string;
  let initial: Awaited<ReturnType<typeof unchanged>>;
  const refused: Record<string, Response> = {};
  let afterRefusals: Awaited<ReturnType<typeof unchanged>>;
  let betaBefore: { status: string; version: number };
  let betaAfter: { status: string; version: number };
  let financeView: JsonObject;
  let closed: Response;
  let decided: Awaited<ReturnType<typeof bookingRow>>;
  let voidCalls: number;

  beforeAll(async () => {
    review = await bookingInReview("stripe", "timeout-lost", "NOTBOOKED");
    reference = (await bookingRow(review.bookingId)).reference;
    const agent = await staff("agent");
    const finance = await staff("finance");
    etag = await etagOf(agent, review.bookingId);
    financeView = (await finance.get(review.bookingId)).body as JsonObject;
    initial = await unchanged(review);
    // Another booking's order in alpha's office (its own remark), and another that a booking of alpha holds already.
    const decoy = await decoyOrder("NOTBOOKED");
    const held = await decoyOrder("NOTBOOKED");
    expect(answer(await agent.import({ reference: held, pricing: { mode: "net" } }))).toEqual([
      201,
      undefined,
    ]);
    // A booking of tenant beta in its own review: a row no API of alpha reaches (fixture).
    const betaId = newId("bkg");
    await betaTx((trx) =>
      trx
        .insertInto("bookings")
        .values({
          id: betaId,
          environment: "test",
          reference: newBookingReference(),
          channel: "storefront",
          status: "pending",
          ticketing_status: "manual_review",
          reconcile_outcome: "manual_review",
          trip_type: "one_way",
          origin_iata: "MAD",
          destination_iata: "ORY",
          first_departure_at: new Date(Date.now() + 60 * 24 * 60 * MINUTE),
          last_arrival_at: new Date(Date.now() + 60 * 24 * 60 * MINUTE + 2 * 60 * MINUTE),
          travelers_count: 1,
          currency: "EUR",
          pricing_mode: "markup_rules",
          net_amount: "98.47",
          markup_amount: "0.00",
          fees_amount: "0.00",
          taxes_amount: "42.47",
          total_amount: "98.47",
          contact_email: "beta.traveller@example.com",
          lead_last_name: "SAMPLE",
        })
        .execute(),
    );
    const betaRow = () =>
      betaTx((trx) =>
        trx
          .selectFrom("bookings")
          .select(["status", "version"])
          .where("id", "=", betaId)
          .executeTakeFirstOrThrow(),
      );
    betaBefore = await betaRow();
    stub.clearRequests();
    const found = (recordLocator: string) => ({ outcome: "order_found", recordLocator });
    refused["noPermission"] = await finance.closeReview(review.bookingId, etag, {
      outcome: "not_booked",
      note: "Finance tries.",
    });
    refused["staleVersion"] = await agent.closeReview(
      review.bookingId,
      `"${String(initial.booking.version - 1)}"`,
      {
        outcome: "not_booked",
        note: "An old page.",
      },
    );
    refused["noNote"] = await agent.closeReview(review.bookingId, etag, { outcome: "not_booked" });
    refused["noLocator"] = await agent.closeReview(review.bookingId, etag, { outcome: "order_found" });
    refused["remarkMismatch"] = await agent.closeReview(review.bookingId, etag, found(decoy));
    refused["alreadyImported"] = await agent.closeReview(review.bookingId, etag, found(held));
    refused["unknownLocator"] = await agent.closeReview(review.bookingId, etag, found("ZZZZZZ"));
    refused["otherTenant"] = await agent.closeReview(betaId, etag, {
      outcome: "not_booked",
      note: "Not ours.",
    });
    betaAfter = await betaRow();
    afterRefusals = await unchanged(review);
    stripe.requests.length = 0;
    closed = await agent.closeReview(review.bookingId, etag, {
      outcome: "not_booked",
      note: "Queue 50 and the Selling Platform checked for NOTBOOKED around the request; no order.",
    });
    // The payments job voids the authorisation after the closure's commit.
    await finished(paymentsQueue, `payment-void-${review.paymentId}`);
    voidCalls = stripe.requests.filter(
      (req) =>
        req.method === "POST" && req.path === `/v1/payment_intents/${review.providerPaymentId ?? ""}/cancel`,
    ).length;
    decided = await bookingRow(review.bookingId);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-099 AC2] does not offer the closure to a caller without bookings:cancel, and refuses it 403 FORBIDDEN", async () => {
    expect(financeView).toMatchObject({
      consoleActions: { canCloseReview: false, reasons: { canCloseReview: "no_permission" } },
    });
    expect(answer(refused["noPermission"] as Response)).toEqual([403, "FORBIDDEN"]);
    expectResponseToMatch(OPERATION, refused["noPermission"] as Response);
    expect(await staffActionsOf(review.bookingId, "bookings.closeReview")).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "denied", actorType: "staff" })]),
    );
  });

  it("[OBE-099 AC2] refuses a stale If-Match, a missing note or record locator, and an order without this booking's remark", () => {
    expect(answer(refused["staleVersion"] as Response)).toEqual([412, "PRECONDITION_FAILED"]);
    expect(answer(refused["noNote"] as Response)).toEqual([400, "VALIDATION_FAILED"]);
    expect(errorOf(refused["noNote"] as Response).fieldErrors).toEqual([
      expect.objectContaining({ path: "/body/note", code: "required" }),
    ]);
    expect(errorOf(refused["noLocator"] as Response).fieldErrors).toEqual([
      expect.objectContaining({ path: "/body/recordLocator", code: "required" }),
    ]);
    expect(answer(refused["remarkMismatch"] as Response)).toEqual([409, "CONFLICT"]);
    expect(errorOf(refused["remarkMismatch"] as Response).details).toEqual({ reason: "remark_mismatch" });
    for (const res of Object.values(refused)) {
      expectResponseToMatch(OPERATION, res);
    }
  });

  it("[OBE-099 AC2] refuses an order another booking holds (ORDER_ALREADY_IMPORTED) before Amadeus is called, and an unknown record locator 404", () => {
    expect(answer(refused["alreadyImported"] as Response)).toEqual([409, "ORDER_ALREADY_IMPORTED"]);
    expect(errorOf(refused["alreadyImported"] as Response).details).toMatchObject({
      bookingId: expect.stringMatching(/^bkg_/),
    });
    expect(answer(refused["unknownLocator"] as Response)).toEqual([404, "NOT_FOUND"]);
    // Two reads by record locator: the decoy's and the unknown one; the held one was refused from the database.
    expect(stub.requests().filter((entry) => entry.operation === "getFlightOrderByReference")).toHaveLength(
      2,
    );
  });

  it("[OBE-099 AC2] answers another tenant's booking 404 and leaves it as it was", () => {
    expect(answer(refused["otherTenant"] as Response)).toEqual([404, "NOT_FOUND"]);
    expect(betaAfter).toEqual(betaBefore);
    expect(betaAfter.status).toBe("pending");
  });

  it("[OBE-099 AC2] changes nothing with any refusal: the booking, its payment, its checkout and its timeline", () => {
    expect(afterRefusals).toEqual(initial);
    expect(initial.booking).toMatchObject({ status: "pending", reconcile_outcome: "manual_review" });
    expect(initial.payment.status).toBe("authorized");
    expect(initial.checkout).toBe("payment_pending");
  });

  it("[OBE-099 AC1] closes it as not booked: failed, not_found, the checkout reopened, booking.reconcile_closed", async () => {
    expect(answer(closed)).toEqual([200, undefined]);
    expectResponseToMatch(OPERATION, closed);
    expect(closed.body).toMatchObject({
      status: "failed",
      failure: { code: "SUPPLIER_TIMEOUT" },
      consoleActions: { canCloseReview: false, reasons: { canCloseReview: "not_in_review" } },
    });
    expect(decided).toMatchObject({
      status: "failed",
      reconcile_outcome: "not_found",
      failure_code: "SUPPLIER_TIMEOUT",
      checkout_id: null,
      ticketing_status: "not_applicable",
    });
    expect(await checkoutStatus(review.checkoutId)).toBe("open");
    const events = await eventsOf(review.bookingId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["booking.failed", "booking.not_confirmed", REVIEW_CLOSED_EVENT, "staff.note"]),
    );
    expect(events.find((event) => event.type === REVIEW_CLOSED_EVENT)).toMatchObject({
      actorType: "staff",
      visible: false,
      data: { outcome: "not_booked", recordLocator: null, paymentVoidQueued: true },
    });
    expect(events.find((event) => event.type === "booking.not_confirmed")).toMatchObject({ visible: true });
    // Flight Create Orders is never sent again.
    expect(stub.requests().filter((entry) => entry.operation === "createFlightOrders")).toHaveLength(0);
  });

  it("[OBE-099 AC1] has the payments job void the authorisation and e-mails the traveller booking.not_confirmed", async () => {
    expect(voidCalls).toBe(1);
    expect(await paymentRow(review.paymentId)).toMatchObject({ status: "canceled" });
    expect(await paymentEventTypes(review.paymentId)).toContain("payment.voided");
    expect(await notificationsOf(review.bookingId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateKey: "booking.not_confirmed",
          recipient: review.contactEmail,
          dedupeKey: `booking.not_confirmed:${review.bookingId}`,
        }),
      ]),
    );
    const [action] = await staffActionsOf(review.bookingId, REVIEW_CLOSE_ACTION);
    expect(action).toMatchObject({
      outcome: "succeeded",
      after: {
        outcome: "not_booked",
        status: "failed",
        reconcileOutcome: "not_found",
        payments: [{ id: review.paymentId, action: "void_queued" }],
      },
    });
    expect(reference).toMatch(/^[A-Z0-9]{6,10}$/);
  });
});

// ---- not_booked, airline card --------------------------------------------------------------------------------------

describe("an airline-card booking in review whose order was never created, closed as not_booked", () => {
  let review: Completed;
  let withCard: Response;
  let initial: Awaited<ReturnType<typeof unchanged>>;
  let afterCard: Awaited<ReturnType<typeof unchanged>>;
  let closed: Response;
  let decided: Awaited<ReturnType<typeof bookingRow>>;

  beforeAll(async () => {
    review = await bookingInReview("airline", "timeout-lost", "CARDLOST");
    const agent = await staff("agent");
    const etag = await etagOf(agent, review.bookingId);
    initial = await unchanged(review);
    withCard = await agent.closeReview(review.bookingId, etag, {
      outcome: "not_booked",
      note: `The traveller says ${TEST_PAN} was charged.`,
    });
    afterCard = await unchanged(review);
    stripe.requests.length = 0;
    closed = await agent.closeReview(review.bookingId, etag, {
      outcome: "not_booked",
      note: "No order in the office; asked the airline about a charge.",
    });
    decided = await bookingRow(review.bookingId);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-099] refuses a note that holds a card number, without a change and without echoing it", async () => {
    expect(answer(withCard)).toEqual([400, "VALIDATION_FAILED"]);
    expect(errorOf(withCard).fieldErrors).toEqual([
      expect.objectContaining({ path: "/body/note", code: "card_data" }),
    ]);
    expect(withCard.text).not.toContain(TEST_PAN);
    expect(afterCard).toEqual(initial);
    expect(await storedText()).not.toContain(TEST_PAN);
  });

  it("[OBE-099 AC1] fails the booking, the payment failed with nothing voided, the checkout reopened, no e-mail", async () => {
    expect(answer(closed)).toEqual([200, undefined]);
    expectResponseToMatch(OPERATION, closed);
    expect(decided).toMatchObject({
      status: "failed",
      reconcile_outcome: "not_found",
      failure_code: "SUPPLIER_TIMEOUT",
      checkout_id: null,
    });
    expect(await checkoutStatus(review.checkoutId)).toBe("open");
    expect(await paymentRow(review.paymentId)).toMatchObject({
      status: "failed",
      method: "airline_card",
      failure_code: "SUPPLIER_TIMEOUT",
    });
    expect(await paymentEventTypes(review.paymentId)).toContain("payment.failed");
    expect(stripe.requests).toEqual([]);
    expect(await paymentsQueue.getJob(`payment-void-${review.paymentId}`)).toBeUndefined();
    // The template says nothing was charged and a hold is released: never for an airline card.
    expect((await notificationsOf(review.bookingId)).map((row) => row.templateKey)).not.toContain(
      "booking.not_confirmed",
    );
  });

  it("[OBE-099 AC1] records that the agent asks the airline about a charge, never a card value", async () => {
    const events = await eventsOf(review.bookingId);
    const closedEvent = events.find((event) => event.type === REVIEW_CLOSED_EVENT);
    expect(closedEvent).toMatchObject({
      actorType: "staff",
      data: { outcome: "not_booked", airlineCard: true, airlineChargeCheck: "agent_asks_airline" },
    });
    expect(closedEvent?.summary).toContain(AIRLINE_CARD_CHARGE_NOTE);
    expect(events.find((event) => event.type === "booking.not_confirmed")).toMatchObject({
      visible: true,
      summary: AIRLINE_CARD_NOT_CONFIRMED_SUMMARY,
    });
    const [action] = await staffActionsOf(review.bookingId, REVIEW_CLOSE_ACTION);
    expect(action?.after).toMatchObject({ payments: [{ id: review.paymentId, action: "airline_failed" }] });
    expect(await storedText()).not.toContain(TEST_PAN);
  });
});
