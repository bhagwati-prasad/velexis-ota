// `tenant.suspend` and `tenant.resume` on the OTA worker (OBE-074; PADR-0014 items 3, 4 and 7, OADR-0007 point 8,
// OADR-0003 point 10, OADR-0014 point 4, tenant provisioning flow §3 and §7), against PostgreSQL 16, Redis 7, the
// Amadeus stub and a fake of the Stripe API.
//
// Both processes run in-process: the worker (WorkerModule.forRoot: the `ota-tenant-ops` consumer with the
// housekeeping, the `ota-payments` consumer that voids through the fake Stripe API, the fan-out, the ticketing scan and
// the `ota-ticketing` consumer, the worker's Amadeus client on the stub), whose schedulers are removed and whose e-mail
// and document consumers are paused, and the API (createTestApp), for the staff sessions. The file clones the
// @velexis/testing template (`tenant_alpha` and `tenant_beta` provisioned) and plays the platform (velexis_migrator):
// alpha and beta active, alpha on the Velexis test Amadeus account (the stub) with a Velexis-mode Stripe connection, a
// secret console key and an agent of alpha; it suspends and resumes alpha as the platform's lifecycle does (the status
// switch), dispatches `tenant.suspend` and `tenant.resume` on `ota-tenant-ops` with the platform's BullMQ id
// `<jobId>-<attempt>` and job options, and reads the answers back from `platform-tenant-events`, where no consumer
// takes them. The tenant rows are written as the API leaves them (`tenantTx` as velexis_ota_app): checkouts and their
// payments as checkout.createPayment and the webhooks leave them, a booking `pending` after an Amadeus 5xx on Flight
// Create Orders, and a paid booking whose first issuance failed, on an order created in the stub.
//
// The claim of checkout.complete that takes a checkout while the suspension runs is played by a transaction that locks
// the checkout `FOR UPDATE`, inserts its `pending` booking and points the payment at it
// (booking-orchestrator.service.ts, claimIn), and commits only once the suspension's statement waits for its lock (an
// ungranted lock in `pg_locks` that it blocks): the suspension's selection saw the checkout without a booking, and
// locked it only after the claim.
//
// Each scenario does its work in its `beforeAll` hook, with a budget of its own; its tests read what it left.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Module, type INestApplicationContext } from "@nestjs/common";
import {
  bullmqJobId,
  INVALIDATION_CHANNEL,
  type InvalidationEvent,
  type TenantEvent,
  type TenantResumeJob,
  type TenantSuspendJob,
} from "@velexis/api-types/jobs";
import { encryptValue, hashApiKey, sha256Hex } from "@velexis/crypto";
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
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import type { Job, JobsOptions, Queue } from "bullmq";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { readCreatedOrder } from "../../../src/bookings/order-recorder";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { TICKETING_SCAN_JOB, ticketingJobId } from "../../../src/bookings/ticketing.processor";
import { QUEUES_POLL_JOB } from "../../../src/console/queue-poller.processor";
import { newId } from "../../../src/common/ids";
import { validateTenantEventJob } from "../../../src/common/queues/job-validation";
import { OTA_QUEUE, PLATFORM_TENANT_EVENTS } from "../../../src/common/queues/queue-names";
import { redisKeys, STAFF_DENY_TTL_SECONDS } from "../../../src/common/redis/redis.keys";
import { loadWorkerConfig } from "../../../src/config";
import { DocumentsProcessor } from "../../../src/documents/documents.processor";
import {
  jobTenant,
  minuteBucket,
  tenantJob,
  tenantJobId,
  type TenantJobResult,
} from "../../../src/jobs/fan-out";
import { FAN_OUT_JOB } from "../../../src/jobs/schedulers";
import { NotificationsProcessor } from "../../../src/notifications/notifications.processor";
import type {
  HousekeepingSkipped,
  ResumeOutcome,
  SuspendOutcome,
} from "../../../src/provisioning/housekeeping.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { TenantOpsJobResult } from "../../../src/provisioning/tenant-ops.processor";
import { PlatformCache } from "../../../src/tenancy/platform-cache";
import { TenantContext } from "../../../src/tenancy/tenant-context";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderRequestInput } from "../../builders/bookings";
import { newApiKey, testApiCredentials, testKeyProvider, testWorkerVariables } from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/**
 * Cloning the template, starting the stub, the fake Stripe API, the worker's graph (BullMQ connections, the scheduler
 * registration, the key files) and the API: a few seconds alone, more on a busy 4-CPU runner. The bound stops a hang.
 */
const SETUP_TIMEOUT_MS = 90_000;
/** A scenario writes its rows, creates an order on the stub, runs a few jobs and waits for each. */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for one job of the worker (they take milliseconds). */
const WAIT = { timeout: 20_000, interval: 25 } as const;
/** How long the claim waits at most for the suspension to wait for its lock (it takes milliseconds). */
const CLAIM_WAIT_MS = 10_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The platform's job options of a dispatch (platform/docs/flows/provisioning.md, Dispatch). */
const PLATFORM_JOB_OPTIONS: JobsOptions = { attempts: 3, backoff: { type: "exponential", delay: 30_000 } };

/** This run's Velexis test keys: Stripe's shapes, random, never a committed value. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

const quietPoolLogger = { error: (): void => undefined };
const silentValidationLogger = { error: (): void => undefined };

type TenantKey = "alpha" | "beta";

let db: TestDatabase;
let redis: TestRedis;
let stripe: FakeStripe;
let stub: AmadeusStub;
let api: TestApp;
let worker: INestApplicationContext;
let migratorPool: ReturnType<typeof createPool>;
/** velexis_migrator, the owner of the platform tables: writes the platform rows as the platform does. */
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
/** `tenantTx` as velexis_ota_app: writes and reads the tenant rows as the API does. */
let tenantDb: TenantDb;
let tenantOps: Queue;
let platformEvents: Queue;
let payments: Queue;
let maintenance: Queue;
let ticketing: Queue;

const tenantIds: Record<TenantKey, string> = { alpha: "", beta: "" };
const pricedOfferIds: Record<TenantKey, string> = { alpha: "", beta: "" };
/** Alpha's office on the stub's account, and its secret console key (the OTA admin's). */
let office: string;
let alphaKey: string;
/** Alpha's agent: the portal account and the membership. */
let agent: { accountId: string; staffId: string };

const txOf =
  (tenant: TenantKey) =>
  <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
    tenantTx(tenantDb, `tenant_${tenant}`, run);

/** A fresh Stripe-shaped id of this run (`pi_test_…`). */
const stripeId = (prefix: string): string => `${prefix}_test_${randomBytes(10).toString("hex")}`;
const plus = (instant: Date, ms: number): Date => new Date(instant.getTime() + ms);

// ---- The platform's side ----------------------------------------------------------------------------------------

/** The Velexis test Amadeus account, whose base URL is the stub's (the worker reads it from the account). */
async function insertAmadeusAccount(clientId: string, secret: string): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(secret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${id}`,
    keys: await testKeyProvider(),
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id,
      name: "Velexis test",
      environment: "test",
      base_url: stub.url,
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

/** An active tenant with its Velexis-mode Stripe connection of the test environment, as the platform writes them. */
async function insertTenant(key: TenantKey): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
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
    })
    .execute();
  return id;
}

/** Alpha's Amadeus connection of the test environment on the stub's account, with an office of its own. */
async function insertAmadeusConnection(tenantId: string, accountId: string): Promise<void> {
  office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: tenantId,
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
}

/** A secret test key of the tenant scoped `console`: the OTA admin's service key. */
async function insertConsoleKey(tenantId: string): Promise<string> {
  const apiKey = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "OTA admin (test)",
      kind: "secret",
      environment: "test",
      prefix: apiKey.slice(0, 14),
      key_hash: hashApiKey(apiKey, testApiCredentials().pepper),
      last4: apiKey.slice(-4),
      scopes: ["console"],
    })
    .execute();
  return apiKey;
}

/** An active portal account (made-up name and address) and its agent membership of `tenantId`. */
async function insertAgent(tenantId: string): Promise<{ accountId: string; staffId: string }> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: `agent.${randomBytes(4).toString("hex")}@example.com`,
      full_name: "Sam Agent",
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
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role: "agent", status: "active" })
    .execute();
  return { accountId, staffId };
}

/** The platform's suspension of `tenantId` for `abuse` (the status switch of PADR-0014 item 2). */
async function suspendOnPlatform(tenantId: string): Promise<void> {
  await migrator
    .updateTable("platform.tenants")
    .set({
      status: "suspended",
      suspended_at: new Date(),
      suspension_reason: "abuse",
      version: sql<number>`version + 1`,
    })
    .where("id", "=", tenantId)
    .execute();
}

/**
 * The platform's resumption of `tenantId` (PADR-0014 item 4), with its `tenant` invalidation after the commit;
 * resolves once the subscribers have dropped the cached row (`tenant:<id>`, which the API and the worker share).
 */
async function resumeOnPlatform(tenantId: string): Promise<void> {
  await migrator
    .updateTable("platform.tenants")
    .set({ status: "active", suspended_at: null, suspension_reason: null, version: sql<number>`version + 1` })
    .where("id", "=", tenantId)
    .execute();
  await publishInvalidation({ v: 1, type: "tenant", id: tenantId });
  await vi.waitFor(async () => {
    expect(await redis.client.exists(redisKeys.tenant(tenantId).key)).toBe(0);
  }, WAIT);
}

/** Publishes an invalidation event on `vx:invalidate`, as the platform does after its commit. */
async function publishInvalidation(event: InvalidationEvent): Promise<void> {
  await redis.client.publish(INVALIDATION_CHANNEL, JSON.stringify(event));
}

/** A `tenant.suspend` or `tenant.resume` message of a new job of `tenantId`, as the platform dispatches it. */
function suspendMessage(tenantId: string): TenantSuspendJob {
  return {
    v: 1,
    name: "tenant.suspend",
    jobId: newId("job"),
    tenantId,
    requestedAt: new Date().toISOString(),
    requestId: randomUUID(),
    payload: { reason: "abuse" },
  };
}

function resumeMessage(tenantId: string): TenantResumeJob {
  return { ...suspendMessage(tenantId), name: "tenant.resume", payload: {} };
}

/** Dispatches `message` as its first attempt (BullMQ id `<jobId>-1`) and resolves with the finished job. */
async function dispatch(message: TenantSuspendJob | TenantResumeJob): Promise<Job> {
  const id = bullmqJobId(message.jobId, 1);
  await tenantOps.add(message.name, message, { ...PLATFORM_JOB_OPTIONS, jobId: id });
  return await finished(tenantOps, id);
}

/** The events published for the tenant job `jobId`, validated with PBE-004's schemas, by BullMQ id. */
async function eventsOf(jobId: string): Promise<Map<string, TenantEvent>> {
  const jobs = await platformEvents.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
  const events = new Map<string, TenantEvent>();
  for (const job of jobs) {
    const event = validateTenantEventJob(job, silentValidationLogger);
    if (event.jobId === jobId) {
      events.set(String(job.id), event);
    }
  }
  return events;
}

// ---- The worker's side ------------------------------------------------------------------------------------------

/** The job `id` of `queue` once it has finished, completed (a failed attempt names its reason). */
async function finished(queue: Queue, id: string): Promise<Job> {
  let found: Job | undefined;
  await vi.waitFor(async () => {
    found = await queue.getJob(id);
    expect(
      found?.finishedOn,
      `job ${id} is finished; ${found?.failedReason ?? "no attempt failed"}`,
    ).toBeDefined();
  }, WAIT);
  if (found === undefined) {
    throw new Error(`job ${id} not found`);
  }
  expect(await found.getState(), `job ${id}: ${found.failedReason ?? ""}`).toBe("completed");
  return found;
}

/** The job id of a payment's void, as its producers add it (`paymentJob`). */
const voidJobId = (paymentId: string): string => `payment-void-${paymentId}`;

/** The cancellations of a PaymentIntent the fake Stripe API received. */
const cancelsOf = (intentId: string) =>
  stripe.requests.filter(
    (entry) => entry.method === "POST" && entry.path === `/v1/payment_intents/${intentId}/cancel`,
  );

// ---- The tenant's rows ------------------------------------------------------------------------------------------

/** A search with one offer and its priced offer, valid for a year: what checkout.create opens a checkout with. */
async function insertPricedOffer(tenant: TenantKey): Promise<string> {
  const searchId = newId("srch");
  const offerId = newId("off");
  const pricedOfferId = newId("prc");
  const expires = plus(new Date(), 365 * DAY);
  await txOf(tenant)(async (trx) => {
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
        first_departure_local: plus(expires, -DAY).toISOString().slice(0, 19),
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
  });
  return pricedOfferId;
}

/** A guest checkout as checkout.create and checkout.createPayment leave it: it expires in an hour (not due yet). */
async function insertCheckout(tenant: TenantKey, status: "open" | "payment_pending"): Promise<string> {
  const id = newId("chk");
  await txOf(tenant)((trx) =>
    trx
      .insertInto("checkouts")
      .values({
        id,
        environment: "test",
        is_guest: true,
        base_priced_offer_id: pricedOfferIds[tenant],
        priced_offer_id: pricedOfferIds[tenant],
        status,
        currency: "EUR",
        offer_amount: "440.00",
        total_amount: "440.00",
        expires_at: plus(new Date(), HOUR),
        version: 3,
      })
      .execute(),
  );
  return id;
}

interface SeededPayment {
  readonly id: string;
  readonly intentId: string;
}

/**
 * A Stripe payment of 440.00 EUR of `checkoutId` (`authorized`, or `requires_action` before 3-D Secure), as
 * checkout.createPayment and the webhooks leave it, with its PaymentIntent in the fake and the metadata the gateway
 * checks.
 */
async function insertPayment(
  tenant: TenantKey,
  checkoutId: string,
  status: "authorized" | "requires_action",
  bookingId: string | null = null,
): Promise<SeededPayment> {
  const id = newId("pay");
  const intentId = stripeId("pi");
  const authorised = status === "authorized";
  await txOf(tenant)((trx) =>
    trx
      .insertInto("payments")
      .values({
        id,
        environment: "test",
        checkout_id: checkoutId,
        booking_id: bookingId,
        provider: "stripe",
        provider_connection_id: newId("ppc"),
        provider_payment_id: intentId,
        method: "card",
        capture_method: "manual",
        currency: "EUR",
        amount: "440.00",
        amount_authorized: authorised ? "440.00" : "0",
        status,
        authorized_at: authorised ? plus(new Date(), -10 * MINUTE) : null,
        three_ds: JSON.stringify({ required: false, status: "not_required", version: null }),
        metadata: JSON.stringify({}),
        version: 2,
      })
      .execute(),
  );
  stripe.intents.set(intentId, {
    id: intentId,
    object: "payment_intent",
    status: authorised ? "requires_capture" : "requires_action",
    amount: 44000,
    amount_capturable: authorised ? 44000 : 0,
    amount_received: 0,
    currency: "eur",
    capture_method: "manual",
    client_secret: `${intentId}_secret_${randomBytes(8).toString("hex")}`,
    metadata: {
      velexis_tenant_id: tenantIds[tenant],
      velexis_environment: "test",
      checkout_id: checkoutId,
      payment_id: id,
    },
    payment_method: null,
    latest_charge: null,
    last_payment_error: null,
    livemode: false,
  });
  return { id, intentId };
}

/** The booking columns a claim of checkout.complete writes (`pending`, the create-order attempt started). */
function pendingBooking(checkoutId: string, reconcileUntil: Date | null) {
  const started = plus(new Date(), -MINUTE);
  const departure = plus(new Date(), 30 * DAY);
  return {
    id: newId("bkg"),
    environment: "test",
    reference: newBookingReference(),
    checkout_id: checkoutId,
    priced_offer_id: pricedOfferIds.alpha,
    status: "pending",
    ticketing_status: "pending",
    first_departure_at: departure,
    last_arrival_at: plus(departure, 3 * HOUR),
    currency: "EUR",
    net_amount: "400.00",
    total_amount: "440.00",
    contact_email: "traveller@example.com",
    lead_last_name: "SAMPLE",
    create_order_started_at: started,
    reconcile_until: reconcileUntil,
  } as const;
}

/** An order of the stub's priced offer for one traveller, created as alpha through the worker's Amadeus client. */
async function createOrder(): Promise<{ readonly id: string; readonly recordLocator: string }> {
  const tenant = await worker.get(PlatformCache, { strict: false }).tenantById(tenantIds.alpha);
  if (tenant === null) {
    throw new Error("alpha is not readable");
  }
  const requestId = `suspend-test-${randomBytes(4).toString("hex")}`;
  const order = buildCreateOrderRequest(
    buildOrderRequestInput({
      reference: newBookingReference(),
      queue: null,
      offices: { queuing: office, owner: office },
      issue: false,
    }),
  );
  const client = worker.get(AmadeusClient, { strict: false });
  const reply = await worker
    .get(TenantContext, { strict: false })
    .run(jobTenant(tenant, { id: requestId, name: "setup" }), () =>
      client.createFlightOrders(
        { tenantId: tenant.id, environment: "test", operation: "test.setup", requestId },
        {
          body: order.body as unknown as Parameters<AmadeusClient["createFlightOrders"]>[1]["body"],
          query: order.query,
        },
      ),
    );
  const created = readCreatedOrder(reply.body);
  const recordLocator = created?.records[0]?.reference;
  if (created === undefined || recordLocator === undefined || created.tickets.length > 0) {
    throw new Error("the stub did not create an order without tickets");
  }
  return { id: created.id, recordLocator };
}

/**
 * A paid booking of alpha as checkout.complete leaves one whose issuance failed (OBE-042: `confirmed`,
 * `ticketing_status = failed`, one attempt, the next one due 5 minutes later, which is now).
 */
async function insertPaidBooking(): Promise<{ readonly id: string; readonly orderId: string }> {
  const order = await createOrder();
  const id = newId("bkg");
  const failedAt = plus(new Date(), -10 * MINUTE);
  const departure = plus(failedAt, 30 * DAY);
  const email = `traveller-${randomBytes(4).toString("hex")}@example.com`;
  await txOf("alpha")(async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: newBookingReference(),
        status: "confirmed",
        amadeus_order_id: order.id,
        record_locator: order.recordLocator,
        origin_system_code: "1A",
        queuing_office_id: office,
        owner_office_id: office,
        ticketing_deadline_at: null,
        issue_requested: false,
        ticketing_status: "failed",
        ticketing_requested_at: failedAt,
        ticketing_attempts: 1,
        ticketing_last_attempt_at: failedAt,
        ticketing_next_attempt_at: plus(failedAt, 5 * MINUTE),
        ticketing_error_code: "TICKETING_FAILED",
        ticketing_error: "Flight Order Issue failed",
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: departure,
        last_arrival_at: plus(departure, 2 * HOUR),
        currency: "EUR",
        net_amount: "100.00",
        total_amount: "115.00",
        amount_paid: "115.00",
        contact_email: email,
        lead_last_name: "SAMPLE",
        created_at: failedAt,
        updated_at: failedAt,
      })
      .execute();
    await trx
      .insertInto("booking_travelers")
      .values({
        id: newId("btr"),
        booking_id: id,
        amadeus_traveler_id: "1",
        traveler_type: "ADULT",
        first_name: "TESTA",
        last_name: "SAMPLE",
      })
      .execute();
    await trx
      .insertInto("booking_contacts")
      .values({
        id: newId("bco"),
        booking_id: id,
        purpose: "STANDARD",
        is_primary: true,
        first_name: "TESTA",
        last_name: "SAMPLE",
        email,
        phones: JSON.stringify([]),
        language: "en",
      })
      .execute();
  });
  return { id, orderId: order.id };
}

interface CheckoutState {
  readonly status: string;
  readonly version: number;
}

async function checkoutOf(tenant: TenantKey, id: string): Promise<CheckoutState> {
  return await txOf(tenant)((trx) =>
    trx.selectFrom("checkouts").select(["status", "version"]).where("id", "=", id).executeTakeFirstOrThrow(),
  );
}

async function paymentOf(
  tenant: TenantKey,
  id: string,
): Promise<{ status: string; bookingId: string | null }> {
  return await txOf(tenant)((trx) =>
    trx
      .selectFrom("payments")
      .select(["status", "booking_id as bookingId"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow(),
  );
}

// ---- The staff's side -------------------------------------------------------------------------------------------

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A portal token in the platform's format (PADR-0007 item 1): `ptk_` and 43 random base62 characters. */
function newPortalToken(): string {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  return token;
}

/** Stores a portal token for alpha's agent as the platform's createConsoleToken does (PBE-039), issued now. */
async function portalToken(): Promise<string> {
  const token = newPortalToken();
  const value = JSON.stringify({
    v: 1,
    accountId: agent.accountId,
    tenantId: tenantIds.alpha,
    membershipId: agent.staffId,
    role: "agent",
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 60, "NX")).toBe(
    "OK",
  );
  return token;
}

/** The OTA admin's server for alpha's agent: the console key, an end-user IP address and user agent of its own. */
const headers = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  "X-Api-Key": alphaKey,
  "X-Velexis-End-User-IP": "203.0.113.74",
  "X-Velexis-End-User-Agent": "Mozilla/5.0 (suspend-resume test)",
  ...extra,
});

const signIn = async (): Promise<Response> =>
  request(api.server)
    .post("/v1/console/auth/sign-in")
    .set(headers({ "Idempotency-Key": randomUUID() }))
    .send({ grantType: "portal_token", portalToken: await portalToken() });

const me = (accessToken: string): Promise<Response> =>
  request(api.server)
    .get("/v1/console/auth/me")
    .set(headers({ Authorization: `Bearer ${accessToken}` }));

const refresh = (refreshToken: string): Promise<Response> =>
  request(api.server)
    .post("/v1/console/auth/refresh")
    .set(headers({ "Idempotency-Key": randomUUID() }))
    .send({ refreshToken });

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** A signed-in agent's tokens; fails unless the sign-in answers 200. */
async function signedIn(): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await signIn();
  expect(answer(res)).toEqual([200, undefined]);
  return res.body.session as { accessToken: string; refreshToken: string };
}

beforeAll(async () => {
  [db, redis, stripe] = await Promise.all([createTestDatabase(), useRedis(), startFakeStripe()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 4,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });

  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  const accountId = await insertAmadeusAccount(clientId, secret);
  for (const key of ["alpha", "beta"] as const) {
    tenantIds[key] = await insertTenant(key);
    await txOf(key)((trx) =>
      seedStorefrontSettings(trx, { name: `${key} Travel`, defaultCurrency: "EUR", defaultLocale: "en" }),
    );
    pricedOfferIds[key] = await insertPricedOffer(key);
  }
  await insertAmadeusConnection(tenantIds.alpha, accountId);
  alphaKey = await insertConsoleKey(tenantIds.alpha);
  agent = await insertAgent(tenantIds.alpha);

  api = await createTestApp({ database: db, redis });
  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    STRIPE_SECRET_KEY_TEST: SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
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
  tenantOps = worker.get<Queue>(getQueueToken(OTA_QUEUE.tenantOps), { strict: false });
  platformEvents = worker.get<Queue>(getQueueToken(PLATFORM_TENANT_EVENTS), { strict: false });
  payments = worker.get<Queue>(getQueueToken(OTA_QUEUE.payments), { strict: false });
  maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  ticketing = worker.get<Queue>(getQueueToken(OTA_QUEUE.ticketing), { strict: false });
  // From here on the file plays the scheduler: no iteration of the real ones may fire while it runs. The e-mails and
  // documents of the issuance are not this file's.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
  await worker.get(NotificationsProcessor, { strict: false }).worker.pause();
  await worker.get(DocumentsProcessor, { strict: false }).worker.pause();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await worker?.close();
  await stub?.stop();
  await stripe?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
}, SETUP_TIMEOUT_MS);

/** The minute bucket of a fan-out this file adds: a minute of its own each time, after now. */
let fanOutMinute = minuteBucket(new Date()) + 10;

/** One iteration of `task`'s scheduler: its `fan-out` job, finished; resolves with the iteration's minute bucket. */
async function fanOut(task: string): Promise<number> {
  fanOutMinute += 1;
  const job = await maintenance.add(FAN_OUT_JOB, { task }, { prevMillis: fanOutMinute * MINUTE });
  await finished(maintenance, job.id ?? "");
  return fanOutMinute;
}

describe("tenant.suspend", () => {
  /** Alpha: open, with an authorised payment (it expires in an hour: the suspension does not wait for that). */
  let open: { checkoutId: string; payment: SeededPayment };
  /** Alpha: payment_pending, its PaymentIntent waiting for 3-D Secure. */
  let unconfirmed: { checkoutId: string; payment: SeededPayment };
  /** Alpha: open, without a payment. */
  let unpaid: string;
  /** Alpha: payment_pending, its booking `pending` with `reconcile_until` (an Amadeus 5xx on Flight Create Orders). */
  let pending: { checkoutId: string; bookingId: string; payment: SeededPayment };
  /** Alpha: payment_pending, taken by a claim after the suspension selected it and before it locked it. */
  let raced: { checkoutId: string; bookingId: string; payment: SeededPayment };
  /** Beta (active): open, with an authorised payment. */
  let other: { checkoutId: string; payment: SeededPayment };
  /** Alpha: a paid booking whose issuance retry is due. */
  let paid: { id: string; orderId: string };
  let before: Record<string, CheckoutState>;
  let session: { accessToken: string; refreshToken: string };
  let message: TenantSuspendJob;
  let job: Job;
  /** The claim's transaction saw the suspension wait for its lock before it committed. */
  let claimSawWaiter: boolean;
  /** The epoch ms just before the dispatch and just after the answer. */
  let window: { from: number; to: number };
  let afterSuspension: { me: Response; refresh: Response; signIn: Response };
  let voids: Record<string, Job>;
  /** A suspension of beta, which is active: a no-op. */
  let noOp: { message: TenantSuspendJob; job: Job; checkout: CheckoutState };
  let pollWhileSuspended: number;
  let ticketingRun: { scan: Job; issue: Job };

  beforeAll(async () => {
    // A staff session created before the suspension.
    session = await signedIn();
    expect((await me(session.accessToken)).status).toBe(200);

    const withPayment = async (
      tenant: TenantKey,
      status: "open" | "payment_pending",
      paymentStatus: "authorized" | "requires_action",
    ) => {
      const checkoutId = await insertCheckout(tenant, status);
      return { checkoutId, payment: await insertPayment(tenant, checkoutId, paymentStatus) };
    };
    open = await withPayment("alpha", "open", "authorized");
    unconfirmed = await withPayment("alpha", "payment_pending", "requires_action");
    unpaid = await insertCheckout("alpha", "open");
    {
      const checkoutId = await insertCheckout("alpha", "payment_pending");
      const booking = pendingBooking(checkoutId, plus(new Date(), 14 * MINUTE));
      await txOf("alpha")((trx) => trx.insertInto("bookings").values(booking).execute());
      pending = {
        checkoutId,
        bookingId: booking.id,
        payment: await insertPayment("alpha", checkoutId, "authorized", booking.id),
      };
    }
    {
      const checkoutId = await insertCheckout("alpha", "payment_pending");
      raced = {
        checkoutId,
        bookingId: "",
        payment: await insertPayment("alpha", checkoutId, "authorized"),
      };
    }
    other = await withPayment("beta", "open", "authorized");
    paid = await insertPaidBooking();
    before = {};
    for (const id of [
      open.checkoutId,
      unconfirmed.checkoutId,
      unpaid,
      pending.checkoutId,
      raced.checkoutId,
    ]) {
      before[id] = await checkoutOf("alpha", id);
    }
    before[other.checkoutId] = await checkoutOf("beta", other.checkoutId);

    await suspendOnPlatform(tenantIds.alpha);

    // The claim of checkout.complete on `raced`: it holds the checkout and its uncommitted booking until the
    // suspension's statement waits for the lock, then commits.
    const booking = pendingBooking(raced.checkoutId, null);
    raced = { ...raced, bookingId: booking.id };
    let markHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const claim = txOf("alpha")(async (trx) => {
      await trx.selectFrom("checkouts").select("id").where("id", "=", raced.checkoutId).forUpdate().execute();
      await trx.insertInto("bookings").values(booking).execute();
      await trx
        .updateTable("payments")
        .set({ booking_id: booking.id })
        .where("id", "=", raced.payment.id)
        .execute();
      markHeld();
      const deadline = Date.now() + CLAIM_WAIT_MS;
      for (;;) {
        // pg_locks is read live: a backend that waits for one of this transaction's locks.
        const { rows } = await sql<{ waiting: number }>`
          SELECT count(*)::int AS waiting FROM pg_locks
          WHERE NOT granted AND pg_backend_pid() = ANY (pg_blocking_pids(pid))
        `.execute(trx);
        if ((rows[0]?.waiting ?? 0) > 0) {
          return true;
        }
        if (Date.now() > deadline) {
          return false;
        }
        await new Promise((done) => setTimeout(done, 20));
      }
    });
    // The claim's own failure ends the wait too.
    await Promise.race([held, claim]);

    message = suspendMessage(tenantIds.alpha);
    window = { from: Date.now(), to: 0 };
    const dispatched = dispatch(message);
    claimSawWaiter = await claim;
    job = await dispatched;
    window.to = Date.now();

    // The platform's invalidation is lost (or not there yet): the API still serves alpha's cached row, `active`, for
    // up to 60 s (OADR-0009); the cut-off refuses the session created before the suspension all the same.
    afterSuspension = {
      me: await me(session.accessToken),
      refresh: await refresh(session.refreshToken),
      // The sign-in reads the tenant past the cache: no new session while suspended.
      signIn: await signIn(),
    };

    voids = {};
    for (const payment of [open.payment, unconfirmed.payment]) {
      voids[payment.id] = await finished(payments, voidJobId(payment.id));
    }

    // A suspension of a tenant that is active is a no-op, answered all the same (PADR-0014 item 7).
    const noOpMessage = suspendMessage(tenantIds.beta);
    noOp = {
      message: noOpMessage,
      job: await dispatch(noOpMessage),
      checkout: await checkoutOf("beta", other.checkoutId),
    };

    // The platform's invalidation arrives: the worker's jobs read alpha as suspended from here on.
    await publishInvalidation({ v: 1, type: "tenant", id: tenantIds.alpha });
    await vi.waitFor(async () => {
      expect((await worker.get(PlatformCache, { strict: false }).tenantById(tenantIds.alpha))?.status).toBe(
        "suspended",
      );
    }, WAIT);

    // The schedules of a suspended tenant: the queue poller skips it, the ticketing scan does not.
    pollWhileSuspended = await fanOut(QUEUES_POLL_JOB);
    const at = new Date();
    const scan = tenantJob(TICKETING_SCAN_JOB, tenantIds.alpha, minuteBucket(at));
    await maintenance.add(scan.name, scan.data, scan.opts);
    ticketingRun = {
      scan: await finished(maintenance, scan.opts.jobId),
      issue: await finished(ticketing, ticketingJobId(paid.id, minuteBucket(at))),
    };
  }, SCENARIO_TIMEOUT_MS);

  it("expires the open checkouts and voids their authorisations, then answers tenant.suspended [OBE-074 AC1]", async () => {
    for (const id of [open.checkoutId, unconfirmed.checkoutId, unpaid]) {
      expect(await checkoutOf("alpha", id), id).toEqual({
        status: "expired",
        version: (before[id]?.version ?? 0) + 1,
      });
    }
    // One void job per voidable payment, under the producers' id, and the fake Stripe API cancelled each intent once.
    for (const payment of [open.payment, unconfirmed.payment]) {
      expect(voids[payment.id]?.data).toEqual({ tenantId: tenantIds.alpha, id: payment.id });
      expect(await paymentOf("alpha", payment.id)).toMatchObject({ status: "canceled" });
      expect(cancelsOf(payment.intentId)).toHaveLength(1);
    }
    expect(job.returnvalue as TenantOpsJobResult).toEqual({
      event: "tenant.suspended",
      outcome: {
        status: "applied",
        expired: 3,
        held: 1,
        voids: 2,
        staffDenied: true,
      } satisfies SuspendOutcome,
    });
    // Another tenant's checkouts are not touched.
    expect(await checkoutOf("beta", other.checkoutId)).toEqual(before[other.checkoutId]);
    expect(await payments.getJobState(voidJobId(other.payment.id))).toBe("unknown");
  });

  it("refuses a staff session created before it, and any new sign-in [OBE-074 AC1]", async () => {
    expect(answer(afterSuspension.me)).toEqual([401, "UNAUTHENTICATED"]);
    expect(answer(afterSuspension.refresh)).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    expect(answer(afterSuspension.signIn)).toEqual([403, "TENANT_SUSPENDED"]);
    // The cut-off: the job's now in epoch ms, kept for 30 days.
    const cutOff = redisKeys.staffDenyTenant(tenantIds.alpha).key;
    const value = Number(await redis.client.get(cutOff));
    expect(value).toBeGreaterThanOrEqual(window.from);
    expect(value).toBeLessThanOrEqual(window.to);
    const ttl = await redis.client.ttl(cutOff);
    expect(ttl).toBeGreaterThan(STAFF_DENY_TTL_SECONDS - 60);
    expect(ttl).toBeLessThanOrEqual(STAFF_DENY_TTL_SECONDS);
  });

  it("still runs the ticketing job of a paid booking of the suspended tenant [OBE-074 AC1]", async () => {
    expect(ticketingRun.scan.returnvalue as TenantJobResult).toMatchObject({
      task: TICKETING_SCAN_JOB,
      tenantId: tenantIds.alpha,
      outcome: "done",
    });
    expect(ticketingRun.issue.data).toEqual({ tenantId: tenantIds.alpha, bookingId: paid.id });
    expect(ticketingRun.issue.returnvalue).toMatchObject({ outcome: "ticketed", via: "issue" });
    const booking = await txOf("alpha")((trx) =>
      trx
        .selectFrom("bookings")
        .select(["status", "ticketing_status as ticketingStatus"])
        .where("id", "=", paid.id)
        .executeTakeFirstOrThrow(),
    );
    expect(booking).toEqual({ status: "ticketed", ticketingStatus: "issued" });
  });

  it("skips a checkout whose booking is pending: its status, authorisation and booking stay, no void is queued [OBE-074 AC2]", async () => {
    expect(await checkoutOf("alpha", pending.checkoutId)).toEqual(before[pending.checkoutId]);
    expect(await paymentOf("alpha", pending.payment.id)).toEqual({
      status: "authorized",
      bookingId: pending.bookingId,
    });
    const booking = await txOf("alpha")((trx) =>
      trx
        .selectFrom("bookings")
        .select(["status", "checkout_id as checkoutId"])
        .where("id", "=", pending.bookingId)
        .executeTakeFirstOrThrow(),
    );
    expect(booking).toEqual({ status: "pending", checkoutId: pending.checkoutId });
    expect(await payments.getJobState(voidJobId(pending.payment.id))).toBe("unknown");
    expect(cancelsOf(pending.payment.intentId)).toEqual([]);
  });

  it("leaves a checkout a claim took after the suspension selected it and before it locked it [OBE-074 AC2]", async () => {
    // The suspension's statement waited for the claim's lock: it had selected the checkout without a booking.
    expect(claimSawWaiter).toBe(true);
    expect(await checkoutOf("alpha", raced.checkoutId)).toEqual(before[raced.checkoutId]);
    expect(await paymentOf("alpha", raced.payment.id)).toEqual({
      status: "authorized",
      bookingId: raced.bookingId,
    });
    expect(await payments.getJobState(voidJobId(raced.payment.id))).toBe("unknown");
    expect(cancelsOf(raced.payment.intentId)).toEqual([]);
  });

  it("answers tenant.suspended once, valid against PBE-004's schema, with the attempt's job id [OBE-074 AC3]", async () => {
    const events = await eventsOf(message.jobId);
    expect([...events.keys()]).toEqual([bullmqJobId(message.jobId, 1)]);
    expect(events.get(bullmqJobId(message.jobId, 1))).toMatchObject({
      v: 1,
      name: "tenant.suspended",
      jobId: message.jobId,
      tenantId: tenantIds.alpha,
      requestId: message.requestId,
      payload: {},
    });
  });

  it("is a no-op, answered all the same, for a tenant that is active (PADR-0014 item 7)", async () => {
    expect(noOp.job.returnvalue as TenantOpsJobResult).toEqual({
      event: "tenant.suspended",
      outcome: { status: "skipped", tenantStatus: "active" } satisfies HousekeepingSkipped,
    });
    expect(noOp.checkout).toEqual(before[other.checkoutId]);
    expect(await redis.client.exists(redisKeys.staffDenyTenant(tenantIds.beta).key)).toBe(0);
    expect([...(await eventsOf(noOp.message.jobId)).values()].map((event) => event.name)).toEqual([
      "tenant.suspended",
    ]);
  });

  it("is skipped by the queue poller's fan-out while it is suspended (OADR-0014 point 4)", async () => {
    expect(
      await maintenance.getJobState(tenantJobId(QUEUES_POLL_JOB, tenantIds.alpha, pollWhileSuspended)),
    ).toBe("unknown");
    expect(
      await maintenance.getJobState(tenantJobId(QUEUES_POLL_JOB, tenantIds.beta, pollWhileSuspended)),
    ).not.toBe("unknown");
  });
});

describe("tenant.resume", () => {
  let stillSuspended: { message: TenantResumeJob; job: Job; cutOff: string | null };
  let message: TenantResumeJob;
  let job: Job;
  let session: { signIn: Response; me: Response | undefined };
  let pollAfterResume: number;

  beforeAll(async () => {
    // A resume that arrives while the tenant is still suspended is a no-op (PADR-0014 item 7).
    const early = resumeMessage(tenantIds.alpha);
    stillSuspended = {
      message: early,
      job: await dispatch(early),
      cutOff: await redis.client.get(redisKeys.staffDenyTenant(tenantIds.alpha).key),
    };

    await resumeOnPlatform(tenantIds.alpha);
    message = resumeMessage(tenantIds.alpha);
    job = await dispatch(message);

    const signedIn = await signIn();
    session = {
      signIn: signedIn,
      me:
        signedIn.status === 200
          ? await me((signedIn.body.session as { accessToken: string }).accessToken)
          : undefined,
    };
    // The schedulers pick the tenant up on their next run.
    pollAfterResume = await fanOut(QUEUES_POLL_JOB);
  }, SCENARIO_TIMEOUT_MS);

  it("deletes the staff cut-off and lets staff sign in again [OBE-074 AC3]", async () => {
    expect(job.returnvalue as TenantOpsJobResult).toEqual({
      event: "tenant.resumed",
      outcome: { status: "applied", staffDenied: false } satisfies ResumeOutcome,
    });
    expect(await redis.client.exists(redisKeys.staffDenyTenant(tenantIds.alpha).key)).toBe(0);
    expect(answer(session.signIn)).toEqual([200, undefined]);
    expect(session.me?.status).toBe(200);
  });

  it("answers tenant.resumed once, valid against PBE-004's schema, with the attempt's job id [OBE-074 AC3]", async () => {
    const events = await eventsOf(message.jobId);
    expect([...events.keys()]).toEqual([bullmqJobId(message.jobId, 1)]);
    expect(events.get(bullmqJobId(message.jobId, 1))).toMatchObject({
      v: 1,
      name: "tenant.resumed",
      jobId: message.jobId,
      tenantId: tenantIds.alpha,
      requestId: message.requestId,
      payload: {},
    });
  });

  it("is a no-op, answered all the same, while the tenant is still suspended (PADR-0014 item 7)", async () => {
    expect(stillSuspended.job.returnvalue as TenantOpsJobResult).toEqual({
      event: "tenant.resumed",
      outcome: { status: "skipped", tenantStatus: "suspended" } satisfies HousekeepingSkipped,
    });
    // The cut-off stayed.
    expect(stillSuspended.cutOff).not.toBeNull();
    expect([...(await eventsOf(stillSuspended.message.jobId)).values()].map((event) => event.name)).toEqual([
      "tenant.resumed",
    ]);
  });

  it("is polled again by the queue poller's next fan-out", async () => {
    expect(
      await maintenance.getJobState(tenantJobId(QUEUES_POLL_JOB, tenantIds.alpha, pollAfterResume)),
    ).not.toBe("unknown");
  });
});
