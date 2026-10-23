// The payments queue end to end (OBE-040; OADR-0010 points 3 and 6, OADR-0008 points 6 and 7, OADR-0014 points 4–6),
// against PostgreSQL 16, Redis 7 and a fake of the Stripe API. The worker's module graph runs in-process
// (WorkerModule.forRoot, as dist/worker.js builds it): the `ota-payments` consumer (payments.processor.ts), which voids,
// captures and refunds through the StripeGateway, the real `stripe` client pointed at the fake
// (test/helpers/fake-stripe.ts), and the `payments.authorisation_watch` handler that the `ota-maintenance` runner finds.
//
// The file plays the producers: it adds the jobs the booking orchestration, the cancellation and the scheduler add
// (`paymentJob`, `tenantJob`), and writes the rows those producers leave, as the platform (velexis_migrator: the tenants
// and their Velexis-mode Stripe connection) and as the API (`tenantTx` as velexis_ota_app: payments, bookings, the
// orchestrator's `payment.capture_failed` event, refunds through RefundsRepository). Each scenario runs in its
// `beforeAll` hook, which adds its jobs and waits for the worker with a budget of its own; its tests read what it left.
// The watch reads its time from `Clock`, which the watch's scenario points at a FakeClock.
//
// FIX-W24-BOOKINGS (lead decision of 2026-10-21, OADR-0003 point 11): the capture retry, the watch and a refund request
// lock a payment's booking before the payment, proven with a second transaction that holds the booking
// (test/helpers/lock-order.ts). FIX-W25-BOOKINGS (third batch: checkout, booking, payment, refund): refund.submit's
// transactions lock the payment before the refund, proven with a second transaction that holds the payment.
//
// FIX-W27-FOLLOWUPS (lead decision (4) of 2026-10-23): the `refunds.sweep` schedule, run through the fan-out as the
// scheduler adds it, queues `refund.submit` for the refunds whose enqueue was lost (the file asks for them through
// RefundsRepository and adds no job), and leaves the others alone; a full batch continues with the next one, so a lost
// enqueue behind a batch of refunds whose jobs wait is reached in the same run (OADR-0014 point 2).
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Module, type INestApplicationContext } from "@nestjs/common";
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
import { createTestDatabase, FakeClock, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import type { Job, Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import { minuteBucket, tenantJob, tenantJobId } from "../../../src/jobs/fan-out";
import { FAN_OUT_JOB } from "../../../src/jobs/schedulers";
import {
  AUTHORISATION_EXPIRING_EVENT,
  AUTHORISATION_WATCH_JOB,
} from "../../../src/payments/authorisation-watch.processor";
import { PAYMENT_JOB, paymentJob, type PaymentJobResult } from "../../../src/payments/payments.processor";
import {
  REFUND_SWEEP_AFTER_MS,
  REFUND_SWEEP_BATCH,
  REFUNDS_SWEEP_JOB,
} from "../../../src/payments/refunds-sweep.processor";
import { RefundsRepository, type CreateRefundResult } from "../../../src/payments/refunds.repository";
import { STRIPE_MAX_NETWORK_RETRIES } from "../../../src/payments/stripe/stripe-client.factory";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { testWorkerVariables } from "../../helpers/api-env";
import {
  startFakeStripe,
  stripeEndpointModule,
  type FakePaymentIntent,
  type FakeStripe,
} from "../../helpers/fake-stripe";
import {
  probeLockOrder,
  probeRowLockOrder,
  type LockOrderObservation,
  type RowLockOrderObservation,
  type RowLockOrderProbe,
} from "../../helpers/lock-order";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

/**
 * Cloning the template and starting the worker's graph (BullMQ connections, the scheduler registration): a few seconds
 * alone, more while every package's integration tests run on a 4-CPU CI runner. The bound only stops a hang.
 */
const SETUP_TIMEOUT_MS = 90_000;
/** A scenario adds a few jobs and waits for the worker each time; the bound only stops one that hangs. */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for the worker. */
const WAIT_MS = 20_000;

const OPS_ALERT_EMAIL = `ops-alerts-${randomBytes(4).toString("hex")}@alpha-travel.example`;
const DAY_MS = 24 * 60 * 60_000;

/** This run's Velexis test keys: Stripe's shapes, random, never a committed value. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

const quietPoolLogger = { error: (): void => undefined };

let db: TestDatabase;
let redis: TestRedis;
let stripe: FakeStripe;
let worker: INestApplicationContext;
const workerSink = new MemorySink();
let migratorPool: ReturnType<typeof createPool>;
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let payments: Queue;
let maintenance: Queue;
let alphaId: string;
let betaId: string;
const refunds = new RefundsRepository();

type TenantKey = "alpha" | "beta";

const txOf =
  (tenant: TenantKey) =>
  <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
    tenantTx(tenantDb, `tenant_${tenant}`, run);
const alphaTx = txOf("alpha");

/** A fresh Stripe-shaped id of this run (`pi_test_…`). */
const stripeId = (prefix: string): string => `${prefix}_test_${randomBytes(10).toString("hex")}`;

async function insertTenant(key: TenantKey, status: "active" | "suspended"): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status, plan_code: "early_access" })
    .execute();
  // The Velexis-mode Stripe connection of the test environment, as the platform writes it.
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

interface PaymentSeed {
  readonly status: string;
  readonly intentId?: string | null;
  readonly amountAuthorized?: string;
  readonly amountCaptured?: string;
  readonly bookingId?: string | null;
  readonly authorizedAt?: Date | null;
  readonly provider?: "stripe" | "airline";
}

/** A Stripe card payment of 452.10 EUR in `tenant`, as checkout.createPayment and the webhooks leave it. */
async function insertPayment(seed: PaymentSeed, tenant: TenantKey = "alpha"): Promise<string> {
  const id = newId("pay");
  // An airline-card payment keeps no PSP reference, expiry or 3-D Secure data (payments_airline_card_ck).
  const airline = seed.provider === "airline";
  await txOf(tenant)(async (trx) => {
    await trx
      .insertInto("payments")
      .values({
        id,
        environment: "test",
        provider: airline ? "airline" : "stripe",
        provider_connection_id: airline ? null : newId("ppc"),
        provider_payment_id: airline ? null : seed.intentId === undefined ? stripeId("pi") : seed.intentId,
        method: airline ? "airline_card" : "card",
        capture_method: airline ? "automatic" : "manual",
        currency: "EUR",
        amount: "452.10",
        amount_authorized:
          seed.amountAuthorized ?? (seed.status === "requires_payment_method" ? "0" : "452.10"),
        amount_captured: seed.amountCaptured ?? "0",
        status: seed.status,
        booking_id: seed.bookingId ?? null,
        authorized_at: seed.authorizedAt ?? null,
        three_ds: airline ? null : JSON.stringify({ required: false, status: "not_required", version: null }),
        metadata: JSON.stringify({}),
        version: 1,
      })
      .execute();
  });
  return id;
}

/** The PaymentIntent the fake Stripe API answers for a payment of tenant alpha. */
function putIntent(intentId: string, paymentId: string, patch: Partial<FakePaymentIntent>): void {
  stripe.intents.set(intentId, {
    id: intentId,
    object: "payment_intent",
    status: "requires_capture",
    amount: 45210,
    amount_capturable: 45210,
    amount_received: 0,
    currency: "eur",
    capture_method: "manual",
    client_secret: `${intentId}_secret_${randomBytes(8).toString("hex")}`,
    metadata: {
      velexis_tenant_id: alphaId,
      velexis_environment: "test",
      checkout_id: newId("chk"),
      payment_id: paymentId,
    },
    payment_method: {
      id: stripeId("pm"),
      object: "payment_method",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    },
    latest_charge: null,
    last_payment_error: null,
    livemode: false,
    ...patch,
  });
}

/** A Stripe payment of tenant alpha with its PaymentIntent in the fake. */
async function stripePayment(
  seed: PaymentSeed,
  intent: Partial<FakePaymentIntent> = {},
): Promise<{ id: string; intentId: string }> {
  const intentId = stripeId("pi");
  const id = await insertPayment({ ...seed, intentId });
  putIntent(intentId, id, intent);
  return { id, intentId };
}

/** A confirmed booking of tenant alpha whose capture failed (OBE-042): manual review, nothing paid yet. */
async function insertBooking(status = "confirmed"): Promise<string> {
  const id = newId("bkg");
  const departure = new Date(Date.now() + 30 * DAY_MS);
  await alphaTx(async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: `VX${randomBytes(3).toString("hex").toUpperCase()}`,
        status,
        ticketing_status: status === "failed" ? "not_applicable" : "manual_review",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 3 * 60 * 60_000),
        currency: "EUR",
        net_amount: "400.00",
        total_amount: "440.00",
        contact_email: "traveller@example.com",
        lead_last_name: "SAMPLE",
      })
      .execute();
  });
  return id;
}

/** The `payment.capture_failed` event the orchestrator writes for a failed capture (booking-orchestrator.service.ts). */
async function insertCaptureFailure(paymentId: string, bookingId: string, amount: string): Promise<void> {
  await alphaTx(async (trx) => {
    await trx
      .insertInto("payment_events")
      .values({
        id: newId("pev"),
        payment_id: paymentId,
        type: "payment.capture_failed",
        source: "api",
        payload: JSON.stringify({ bookingId, amount }),
      })
      .execute();
  });
}

/** Calls `check` every 25 ms until it returns a value other than `undefined`, at most WAIT_MS. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor: ${what} did not happen within ${WAIT_MS} ms`);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
}

/**
 * Waits until the job `id` of `queue` has finished (completed or failed) and answers it. The state is read first and the
 * job after it: BullMQ writes a job's result and moves it to its final set in one step, so a job read once that state is
 * seen carries its return value, where a job read before could still lack it.
 */
async function finished(queue: Queue, id: string): Promise<Job> {
  return await waitFor(`the job ${id}`, async () => {
    const state = await queue.getJobState(id);
    return state === "completed" || state === "failed" ? await queue.getJob(id) : undefined;
  });
}

/** Adds a payments job as its producers do (`paymentJob`), or under another id, and waits for it. */
async function runPaymentJob(
  name: (typeof PAYMENT_JOB)[keyof typeof PAYMENT_JOB],
  id: string,
  jobId?: string,
): Promise<Job> {
  const spec = paymentJob(name, alphaId, id);
  const opts = jobId === undefined ? spec.opts : { jobId };
  await payments.add(spec.name, spec.data, opts);
  return await finished(payments, opts.jobId);
}

/** The requests the fake Stripe API received for a path, by method. */
const requestsTo = (method: string, path: string) =>
  stripe.requests.filter((entry) => entry.method === method && entry.path === path);

/** The Stripe requests about a PaymentIntent, its cancel and capture included. */
const requestsAbout = (intentId: string) => stripe.requests.filter((entry) => entry.path.includes(intentId));

interface PaymentState {
  readonly status: string;
  readonly version: number;
  readonly amountCaptured: string;
  readonly canceledAt: Date | null;
  readonly capturedAt: Date | null;
}

async function paymentOf(id: string, tenant: TenantKey = "alpha"): Promise<PaymentState> {
  return await txOf(tenant)(
    async (trx) =>
      await trx
        .selectFrom("payments")
        .select([
          "status",
          "version",
          "canceled_at as canceledAt",
          "captured_at as capturedAt",
          sql<string>`amount_captured::text`.as("amountCaptured"),
        ])
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
  );
}

interface EventRow {
  readonly type: string;
  readonly source: string;
  readonly statusFrom: string | null;
  readonly statusTo: string | null;
  readonly amount: string | null;
  readonly payload: Record<string, unknown>;
}

/** The payment events of a payment in `tenant`, oldest first. */
async function eventsOf(paymentId: string, tenant: TenantKey = "alpha"): Promise<EventRow[]> {
  return await txOf(tenant)(
    async (trx) =>
      (await trx
        .selectFrom("payment_events")
        .select([
          "type",
          "source",
          "status_from as statusFrom",
          "status_to as statusTo",
          sql<string | null>`amount::text`.as("amount"),
          "payload",
        ])
        .where("payment_id", "=", paymentId)
        .orderBy("created_at")
        .orderBy("id")
        .execute()) as EventRow[],
  );
}

interface NotificationRow {
  readonly templateKey: string;
  readonly recipient: string;
  readonly recipientType: string;
  readonly dedupeKey: string | null;
  readonly bookingId: string | null;
  readonly payload: Record<string, unknown>;
}

/** The outbox rows of `tenant` whose dedupe key starts with `prefix`. */
async function alertsLike(prefix: string, tenant: TenantKey = "alpha"): Promise<NotificationRow[]> {
  return await txOf(tenant)(
    async (trx) =>
      (await trx
        .selectFrom("notifications")
        .select([
          "template_key as templateKey",
          "recipient",
          "recipient_type as recipientType",
          "dedupe_key as dedupeKey",
          "booking_id as bookingId",
          "payload",
        ])
        .where("dedupe_key", "like", `${prefix}%`)
        .orderBy("dedupe_key")
        .execute()) as NotificationRow[],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
  stripe = await startFakeStripe();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alphaId = await insertTenant("alpha", "active");
  betaId = await insertTenant("beta", "suspended");
  for (const tenant of ["alpha", "beta"] as const) {
    // The settings as the provisioning seed writes them, with the alert address an OTA sets in its admin.
    await txOf(tenant)(async (trx) => {
      await seedStorefrontSettings(trx, {
        name: `${tenant} Travel`,
        defaultCurrency: "EUR",
        defaultLocale: "en",
      });
      await trx.updateTable("storefront_settings").set({ ops_alert_email: OPS_ALERT_EMAIL }).execute();
    });
  }

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
      WorkerModule.forRoot(config, { logger: createWorkerLogger(config, workerSink) }),
    ],
  })
  class WorkerRootModule {}
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(WorkerRootModule);
  await worker.init();
  payments = worker.get<Queue>(getQueueToken(OTA_QUEUE.payments), { strict: false });
  maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  // No scheduler iteration may fire while the file runs: the watch's scenario plays the scheduler.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await stripe?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
}, SETUP_TIMEOUT_MS);

describe("payment.void", () => {
  let cancelled: { id: string; intentId: string };
  let authorised: { id: string; intentId: string };
  let booked: { id: string; intentId: string };
  let jobs: Record<"cancelled" | "authorised" | "again" | "booked", Job>;
  let versionBefore: number;

  beforeAll(async () => {
    cancelled = await stripePayment({ status: "canceled" }, { status: "canceled", amount_capturable: 0 });
    versionBefore = (await paymentOf(cancelled.id)).version;
    authorised = await stripePayment({ status: "authorized" });
    // The authorisation of a booking whose order exists (a void asked for too late): it is captured, never voided.
    booked = await stripePayment({ status: "authorized", bookingId: await insertBooking() });
    const cancelledJob = await runPaymentJob(PAYMENT_JOB.void, cancelled.id);
    const authorisedJob = await runPaymentJob(PAYMENT_JOB.void, authorised.id);
    // The same payment voided again by another producer (another job id): the row moved, nothing is sent.
    const again = await runPaymentJob(PAYMENT_JOB.void, authorised.id, `manual-void-${authorised.id}`);
    const bookedJob = await runPaymentJob(PAYMENT_JOB.void, booked.id);
    jobs = { cancelled: cancelledJob, authorised: authorisedJob, again, booked: bookedJob };
  }, SCENARIO_TIMEOUT_MS);

  it("makes no Stripe call for a payment that is already cancelled, and changes nothing [OBE-040 AC1]", async () => {
    expect(await jobs.cancelled.getState()).toBe("completed");
    expect(jobs.cancelled.returnvalue).toEqual({
      tenantId: alphaId,
      job: "payment.void",
      id: cancelled.id,
      outcome: "unchanged",
    } satisfies PaymentJobResult);
    expect(requestsAbout(cancelled.intentId)).toEqual([]);
    expect((await paymentOf(cancelled.id)).version).toBe(versionBefore);
    expect(await eventsOf(cancelled.id)).toEqual([]);
  });

  it("cancels an authorised PaymentIntent once, with the key pi:cancel:<pay_id>, and records the void", async () => {
    expect(jobs.authorised.returnvalue).toMatchObject({ outcome: "applied" });
    expect(jobs.again.returnvalue).toMatchObject({ outcome: "unchanged" });
    const cancels = requestsTo("POST", `/v1/payment_intents/${authorised.intentId}/cancel`);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.headers["idempotency-key"]).toBe(`pi:cancel:${authorised.id}`);
    expect(await paymentOf(authorised.id)).toMatchObject({
      status: "canceled",
      canceledAt: expect.any(Date),
    });
    expect(await eventsOf(authorised.id)).toEqual([
      expect.objectContaining({
        type: "payment.voided",
        source: "system",
        statusFrom: "authorized",
        statusTo: "canceled",
        payload: expect.objectContaining({ job: "payment.void", jobId: `payment-void-${authorised.id}` }),
      }),
    ]);
  });

  it("makes no Stripe call for the authorisation of a confirmed booking, and leaves it authorised", async () => {
    expect(jobs.booked.returnvalue).toMatchObject({ outcome: "unchanged" });
    expect(requestsAbout(booked.intentId)).toEqual([]);
    expect((await paymentOf(booked.id)).status).toBe("authorized");
    expect(await eventsOf(booked.id)).toEqual([]);
  });
});

describe("payment.capture_retry", () => {
  let retried: { id: string; intentId: string; bookingId: string; job: Job };
  let captured: { id: string; intentId: string; bookingId: string; job: Job };
  let refused: { id: string; intentId: string; bookingId: string; job: Job };
  let bookingGone: { id: string; intentId: string; job: Job };
  let noBooking: { id: string; intentId: string; job: Job };
  let authorisationGone: { id: string; intentId: string; bookingId: string; job: Job };

  beforeAll(async () => {
    // A capture that failed after the order: the orchestrator recorded the amount it tried (the booking's total).
    const bookingId = await insertBooking();
    const payment = await stripePayment({ status: "authorized", bookingId });
    await insertCaptureFailure(payment.id, bookingId, "440.00");
    retried = { ...payment, bookingId, job: await runPaymentJob(PAYMENT_JOB.captureRetry, payment.id) };

    // Captured meanwhile (staff, or a capture whose answer was lost and the webhook saw): nothing to send, but the
    // booking shows the payment.
    const capturedBooking = await insertBooking();
    const done = await stripePayment(
      { status: "captured", amountCaptured: "452.10", bookingId: capturedBooking },
      { status: "succeeded", amount_capturable: 0, amount_received: 45210 },
    );
    captured = {
      ...done,
      bookingId: capturedBooking,
      job: await runPaymentJob(PAYMENT_JOB.captureRetry, done.id),
    };

    // Stripe answers the retry with a 5xx, which it keeps for the key: the PaymentIntent is read again, still not
    // captured, so the staff are alerted and the job ends (once, then staff).
    const failingBooking = await insertBooking();
    const failing = await stripePayment({ status: "authorized", bookingId: failingBooking });
    await insertCaptureFailure(failing.id, failingBooking, "452.10");
    stripe.fail(1, "server_error");
    refused = {
      ...failing,
      bookingId: failingBooking,
      job: await runPaymentJob(PAYMENT_JOB.captureRetry, failing.id),
    };

    // The booking did not go ahead meanwhile: its payment is not captured.
    const failedBooking = await insertBooking("failed");
    const notNeeded = await stripePayment({ status: "authorized", bookingId: failedBooking });
    bookingGone = { ...notNeeded, job: await runPaymentJob(PAYMENT_JOB.captureRetry, notNeeded.id) };

    // A payment without a booking: no order exists, so nothing is captured (OADR-0008).
    const unbooked = await stripePayment({ status: "authorized" });
    noBooking = { ...unbooked, job: await runPaymentJob(PAYMENT_JOB.captureRetry, unbooked.id) };

    // The authorisation was cancelled (expired at Stripe) while the booking stands: nothing to capture, staff decide.
    const standing = await insertBooking();
    const lapsed = await stripePayment(
      { status: "canceled", bookingId: standing },
      { status: "canceled", amount_capturable: 0 },
    );
    authorisationGone = {
      ...lapsed,
      bookingId: standing,
      job: await runPaymentJob(PAYMENT_JOB.captureRetry, lapsed.id),
    };
  }, SCENARIO_TIMEOUT_MS);

  it("captures the amount of the failed capture with its key, and shows the payment on the booking", async () => {
    expect(retried.job.returnvalue).toMatchObject({ outcome: "applied" });
    const captures = requestsTo("POST", `/v1/payment_intents/${retried.intentId}/capture`);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.headers["idempotency-key"]).toBe(`pi:capture:${retried.id}:440.00`);
    expect(captures[0]?.form).toMatchObject({ amount_to_capture: "44000" });
    expect(await paymentOf(retried.id)).toMatchObject({
      status: "captured",
      amountCaptured: "440.00",
      capturedAt: expect.any(Date),
    });
    expect((await eventsOf(retried.id)).map((event) => [event.type, event.source, event.amount])).toEqual([
      ["payment.capture_failed", "api", null],
      ["payment.captured", "system", "440.00"],
    ]);
    const booking = await alphaTx(async (trx) => ({
      row: await trx
        .selectFrom("bookings")
        .select([sql<string>`amount_paid::text`.as("amountPaid"), "ticketing_status as ticketingStatus"])
        .where("id", "=", retried.bookingId)
        .executeTakeFirstOrThrow(),
      events: await trx
        .selectFrom("booking_events")
        .select(["type", "actor_type as actorType", "visible_to_customer as visible", "data"])
        .where("booking_id", "=", retried.bookingId)
        .execute(),
    }));
    // Staff still issue the booking: the capture retry never changes its ticketing.
    expect(booking.row).toEqual({ amountPaid: "440.00", ticketingStatus: "manual_review" });
    expect(booking.events).toEqual([
      {
        type: "payment.captured",
        actorType: "system",
        visible: true,
        data: { paymentId: retried.id, amount: "440.00" },
      },
    ]);
  });

  it("makes no Stripe call for a payment that is already captured, and shows it on the booking", async () => {
    expect(captured.job.returnvalue).toMatchObject({ outcome: "unchanged" });
    expect(requestsAbout(captured.intentId)).toEqual([]);
    const booking = await alphaTx(async (trx) => ({
      amountPaid: (
        await trx
          .selectFrom("bookings")
          .select(sql<string>`amount_paid::text`.as("amountPaid"))
          .where("id", "=", captured.bookingId)
          .executeTakeFirstOrThrow()
      ).amountPaid,
      events: await trx
        .selectFrom("booking_events")
        .select("type")
        .where("booking_id", "=", captured.bookingId)
        .execute(),
    }));
    expect(booking).toEqual({ amountPaid: "452.10", events: [{ type: "payment.captured" }] });
  });

  it("makes no Stripe call for the payment of a booking that did not go ahead, or of no booking", async () => {
    for (const payment of [bookingGone, noBooking]) {
      expect(payment.job.returnvalue).toMatchObject({ outcome: "unchanged" });
      expect(requestsAbout(payment.intentId)).toEqual([]);
      expect((await paymentOf(payment.id)).status).toBe("authorized");
    }
  });

  it("alerts the staff without a Stripe call when the authorisation of a standing booking is gone", async () => {
    expect(authorisationGone.job.returnvalue).toMatchObject({ outcome: "failed" });
    expect(requestsAbout(authorisationGone.intentId)).toEqual([]);
    expect(
      (await alertsLike(`staff.payment:${authorisationGone.id}:`)).map((alert) => alert.dedupeKey),
    ).toEqual([`staff.payment:${authorisationGone.id}:capture_retry_failed`]);
  });

  it("alerts the staff once when the retry cannot capture, after reading the PaymentIntent again", async () => {
    expect(await refused.job.getState()).toBe("completed");
    expect(refused.job.returnvalue).toMatchObject({ outcome: "failed" });
    // One capture of the job, which the SDK's one network retry sends again with the same key (Stripe replays the 5xx).
    const captures = requestsTo("POST", `/v1/payment_intents/${refused.intentId}/capture`);
    expect(captures).toHaveLength(1 + STRIPE_MAX_NETWORK_RETRIES);
    expect(new Set(captures.map((call) => call.headers["idempotency-key"]))).toEqual(
      new Set([`pi:capture:${refused.id}:452.10`]),
    );
    expect(requestsTo("GET", `/v1/payment_intents/${refused.intentId}`)).toHaveLength(1);
    expect((await paymentOf(refused.id)).status).toBe("authorized");
    const alerts = await alertsLike(`staff.payment:${refused.id}:`);
    expect(alerts).toEqual([
      expect.objectContaining({
        templateKey: "staff.manual_review",
        recipient: OPS_ALERT_EMAIL,
        recipientType: "staff",
        dedupeKey: `staff.payment:${refused.id}:capture_retry_failed`,
        bookingId: refused.bookingId,
      }),
    ]);
    expect(JSON.stringify(alerts[0]?.payload)).toContain(`bookings/${refused.bookingId}`);
  });
});

describe("refunds", () => {
  let paymentId: string;
  let intentId: string;
  let requests: Record<"tooMuch" | "first" | "rest" | "notCaptured" | "airline", CreateRefundResult>;
  let refundId: string;
  let first: Job;
  let second: Job;
  let later: Job;
  let unknown: { refundId: string; job: Job };

  beforeAll(async () => {
    const payment = await stripePayment(
      { status: "captured", amountCaptured: "452.10" },
      { status: "succeeded", amount_capturable: 0, amount_received: 45210 },
    );
    paymentId = payment.id;
    intentId = payment.intentId;
    const authorised = await stripePayment({ status: "authorized" });
    const airline = await insertPayment({
      status: "captured",
      provider: "airline",
      amountCaptured: "452.10",
    });
    const ask = (id: string, amount: string, type: "customer" | "staff" = "customer") =>
      alphaTx((trx) =>
        refunds.create(trx, {
          id: newId("rfd"),
          paymentId: id,
          amount,
          reason: type === "customer" ? "booking_cancelled" : "goodwill",
          requestedBy: { type, id: type === "customer" ? newId("cus") : newId("stf") },
          now: new Date(),
        }),
      );
    requests = {
      tooMuch: await ask(paymentId, "452.11"),
      first: await ask(paymentId, "300.00"),
      // 152.10 are left: 300.00 are in flight.
      rest: await ask(paymentId, "152.11", "staff"),
      notCaptured: await ask(authorised.id, "10.00"),
      airline: await ask(airline, "10.00"),
    };
    if (!requests.first.ok) {
      throw new Error("the first refund was refused");
    }
    refundId = requests.first.refund.id;

    // Two refund.submit jobs for the one row: the second runs while the first one's Stripe call is in flight, and
    // its own retry comes after the first one recorded the Stripe refund.
    let secondAdded = false;
    stripe.onRequest(async (request) => {
      if (request.method !== "POST" || request.path !== "/v1/refunds" || secondAdded) {
        return;
      }
      secondAdded = true;
      const spec = paymentJob(PAYMENT_JOB.refundSubmit, alphaId, refundId);
      await payments.add(spec.name, spec.data, {
        jobId: `second-refund-submit-${refundId}`,
        attempts: 3,
        backoff: { type: "fixed", delay: 1000 },
      });
      await waitFor("the second job's first attempt", async () => {
        const job = await payments.getJob(`second-refund-submit-${refundId}`);
        return job !== undefined && job.attemptsMade >= 1 ? true : undefined;
      });
    });
    first = await runPaymentJob(PAYMENT_JOB.refundSubmit, refundId);
    stripe.onRequest(undefined);
    second = await finished(payments, `second-refund-submit-${refundId}`);
    // A third job, after both: the row is sent, nothing goes to Stripe.
    later = await runPaymentJob(PAYMENT_JOB.refundSubmit, refundId, `later-refund-submit-${refundId}`);

    // A refund whose submission Stripe answers with a 5xx: the outcome is unknown, so the claim is released and the
    // staff are alerted.
    const other = await stripePayment(
      { status: "captured", amountCaptured: "452.10" },
      { status: "succeeded", amount_capturable: 0, amount_received: 45210 },
    );
    const asked = await ask(other.id, "50.00");
    if (!asked.ok) {
      throw new Error("the refund of the 5xx was refused");
    }
    stripe.fail(1, "server_error");
    unknown = {
      refundId: asked.refund.id,
      job: await runPaymentJob(PAYMENT_JOB.refundSubmit, asked.refund.id),
    };
  }, SCENARIO_TIMEOUT_MS);

  it("refuse an amount above the captured amount less the refunds in flight, and other payments", () => {
    expect(requests.tooMuch).toEqual({ ok: false, reason: "amount_exceeds_captured", refundable: "452.10" });
    expect(requests.rest).toEqual({ ok: false, reason: "amount_exceeds_captured", refundable: "152.10" });
    expect(requests.notCaptured).toEqual({ ok: false, reason: "payment_not_refundable", refundable: null });
    expect(requests.airline).toEqual({ ok: false, reason: "refund_via_airline", refundable: null });
  });

  it("store the requester, the reason and a refund.requested event", async () => {
    const row = await alphaTx(
      async (trx) =>
        await trx
          .selectFrom("refunds")
          .select(["requested_by_type as type", "requested_by_id as by", "reason", "booking_id as bookingId"])
          .where("id", "=", refundId)
          .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({
      type: "customer",
      by: expect.stringMatching(/^cus_/),
      reason: "booking_cancelled",
      bookingId: null,
    });
    expect((await eventsOf(paymentId)).find((event) => event.type === "refund.requested")).toMatchObject({
      source: "api",
      statusTo: "pending",
      amount: "300.00",
      payload: { refundId, reason: "booking_cancelled", requestedByType: "customer" },
    });
  });

  it("make one Stripe refund call for two refund.submit jobs of one row, with the key refund:<rfd_id> [OBE-040 AC2]", async () => {
    const calls = requestsTo("POST", "/v1/refunds");
    const ours = calls.filter((call) => call.headers["idempotency-key"] === `refund:${refundId}`);
    expect(ours).toHaveLength(1);
    expect(calls.filter((call) => call.form["payment_intent"] === intentId)).toHaveLength(1);
    expect(ours[0]?.form).toMatchObject({
      payment_intent: intentId,
      amount: "30000",
      metadata: {
        refund_id: refundId,
        payment_id: paymentId,
        velexis_tenant_id: alphaId,
        velexis_environment: "test",
      },
    });
    expect(first.returnvalue).toMatchObject({ outcome: "applied" });
    // The second job's first attempt found the first one's claim and left it; its retry found the refund recorded.
    expect(workerSink.records()).toContainEqual(
      expect.objectContaining({
        msg: "payments.job_failed",
        jobId: `second-refund-submit-${refundId}`,
        code: "RefundSubmissionInFlightError",
      }),
    );
    expect(await second.getState()).toBe("completed");
    expect(second.returnvalue).toMatchObject({ outcome: "unchanged" });
    expect(later.returnvalue).toMatchObject({ outcome: "unchanged" });
  });

  it("record the Stripe refund once and leave its final state to the webhook", async () => {
    const row = await alphaTx(
      async (trx) =>
        await trx
          .selectFrom("refunds")
          .select(["status", "provider_refund_id as providerRefundId", "processed_at as processedAt"])
          .where("id", "=", refundId)
          .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({
      status: "processing",
      providerRefundId: expect.stringMatching(/^re_test_/),
      processedAt: null,
    });
    expect((await eventsOf(paymentId)).filter((event) => event.type === "refund.submitted")).toEqual([
      expect.objectContaining({
        source: "system",
        statusFrom: "processing",
        statusTo: "processing",
        amount: "300.00",
        payload: expect.objectContaining({ refundId, providerRefundId: row.providerRefundId }),
      }),
    ]);
    // The payment's refunded amount moves with the webhook (OBE-039), not with the submission.
    expect((await paymentOf(paymentId)).status).toBe("captured");
  });

  it("release a submission whose outcome is unknown and alert the staff", async () => {
    expect(unknown.job.returnvalue).toMatchObject({ outcome: "failed" });
    const row = await alphaTx(
      async (trx) =>
        await trx
          .selectFrom("refunds")
          .select(["status", "provider_refund_id as providerRefundId"])
          .where("id", "=", unknown.refundId)
          .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ status: "pending", providerRefundId: null });
    // One submission, which the SDK's one network retry sends again with the same key (Stripe replays the 5xx).
    expect(
      requestsTo("POST", "/v1/refunds").filter(
        (call) => call.headers["idempotency-key"] === `refund:${unknown.refundId}`,
      ),
    ).toHaveLength(1 + STRIPE_MAX_NETWORK_RETRIES);
    expect((await alertsLike(`staff.refund:${unknown.refundId}:`)).map((alert) => alert.dedupeKey)).toEqual([
      `staff.refund:${unknown.refundId}:not_submitted`,
    ]);
  });
});

describe("refunds.sweep (FIX-W27-FOLLOWUPS)", () => {
  /** A request the sweep counts as lost: asked for more than REFUND_SWEEP_AFTER_MS ago. */
  const longAgo = (): Date => new Date(Date.now() - REFUND_SWEEP_AFTER_MS - 5 * 60_000);
  let lost: string;
  let lostBeta: string;
  let fresh: string;
  let claimed: string;
  let submitted: string;
  let released: string;
  let waiting: string;
  /** The rows the sweep leaves alone, as they were before it ran. */
  let untouched: Map<string, RefundState>;
  const sweeps: Job[] = [];
  let submissions: Record<TenantKey, Job>;

  interface RefundState {
    readonly status: string;
    readonly version: number;
    readonly providerRefundId: string | null;
    readonly updatedAt: Date;
  }

  async function refundOf(id: string, tenant: TenantKey = "alpha"): Promise<RefundState> {
    return await txOf(tenant)(
      async (trx) =>
        await trx
          .selectFrom("refunds")
          .select(["status", "version", "provider_refund_id as providerRefundId", "updated_at as updatedAt"])
          .where("id", "=", id)
          .executeTakeFirstOrThrow(),
    );
  }

  /** A customer's refund of `amount` asked for at `now`, whose `refund.submit` enqueue was lost: no job is added. */
  async function askRefund(
    paymentId: string,
    amount: string,
    now: Date,
    tenant: TenantKey = "alpha",
  ): Promise<string> {
    const result = await txOf(tenant)((trx) =>
      refunds.create(trx, {
        id: newId("rfd"),
        paymentId,
        amount,
        reason: "booking_cancelled",
        requestedBy: { type: "customer", id: newId("cus") },
        now,
      }),
    );
    if (!result.ok) {
      throw new Error(`the refund of ${amount} was refused (${result.reason})`);
    }
    return result.refund.id;
  }

  /** Runs the sweep of `tenantId` for the iteration of minute `bucket`, as the fan-out adds it, and waits for it. */
  async function sweep(tenantId: string, bucket: number): Promise<Job> {
    const spec = tenantJob(REFUNDS_SWEEP_JOB, tenantId, bucket);
    await maintenance.add(spec.name, spec.data, spec.opts);
    return await finished(maintenance, spec.opts.jobId);
  }

  /** The Stripe refund requests of the refund `id` (its idempotency key). */
  const submissionsOf = (id: string) =>
    requestsTo("POST", "/v1/refunds").filter((call) => call.headers["idempotency-key"] === `refund:${id}`);

  beforeAll(async () => {
    const payment = await stripePayment(
      { status: "captured", amountCaptured: "452.10" },
      { status: "succeeded", amount_capturable: 0, amount_received: 45210 },
    );
    const betaPayment = await insertPayment({ status: "captured", amountCaptured: "452.10" }, "beta");
    lost = await askRefund(payment.id, "40.00", longAgo());
    // A suspended OTA's refunds are swept too (OADR-0014 point 4).
    lostBeta = await askRefund(betaPayment, "40.00", longAgo(), "beta");
    // Asked for a moment ago: its producer's enqueue may still come.
    fresh = await askRefund(payment.id, "10.00", new Date());
    // Claimed by a refund.submit job that is sending it now.
    claimed = await askRefund(payment.id, "10.00", longAgo());
    // Sent: Stripe's refund id is recorded, the final state is left to the webhook.
    submitted = await askRefund(payment.id, "10.00", longAgo());
    // A claim released after an answer that never came: its own job retries it, then the staff are alerted.
    released = await askRefund(payment.id, "10.00", longAgo());
    await alphaTx(async (trx) => {
      const now = new Date();
      for (const id of [claimed, submitted, released]) {
        if ((await refunds.claim(trx, id, 1, now)) === undefined) {
          throw new Error(`the refund ${id} could not be claimed`);
        }
      }
      await refunds.recordSubmission(trx, submitted, stripeId("re"), now);
      await refunds.release(trx, released, 2, now);
    });
    // Its enqueue came through and its job waits (a backlog): the sweep's job for it is that same job.
    waiting = await askRefund(payment.id, "10.00", longAgo());
    const queued = paymentJob(PAYMENT_JOB.refundSubmit, alphaId, waiting);
    await payments.add(queued.name, queued.data, { ...queued.opts, delay: 60 * 60_000 });
    untouched = new Map(
      await Promise.all(
        [fresh, claimed, submitted, released, waiting].map(async (id) => [id, await refundOf(id)] as const),
      ),
    );

    // The scheduler's iteration: the fan-out adds one sweep per active or suspended tenant.
    const due = new Date();
    const fanOut = await maintenance.add(
      FAN_OUT_JOB,
      { task: REFUNDS_SWEEP_JOB },
      { prevMillis: due.getTime() },
    );
    await finished(maintenance, fanOut.id ?? "");
    for (const tenantId of [alphaId, betaId]) {
      sweeps.push(await finished(maintenance, tenantJobId(REFUNDS_SWEEP_JOB, tenantId, minuteBucket(due))));
    }
    submissions = {
      alpha: await finished(payments, paymentJob(PAYMENT_JOB.refundSubmit, alphaId, lost).opts.jobId),
      beta: await finished(payments, paymentJob(PAYMENT_JOB.refundSubmit, betaId, lostBeta).opts.jobId),
    };
    // A later iteration, after the submissions.
    sweeps.push(await sweep(alphaId, minuteBucket(due) + 5));
    sweeps.push(await sweep(betaId, minuteBucket(due) + 5));
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    // The waiting job would only run in an hour: the file's worker never takes it.
    await (
      await payments.getJob(paymentJob(PAYMENT_JOB.refundSubmit, alphaId, waiting).opts.jobId)
    )?.remove();
  });

  it("[FIX-W27-FOLLOWUPS AC1] submits a refund whose enqueue was lost exactly once, through its own job id, whatever the runs", async () => {
    expect(sweeps.map((job) => job.returnvalue as unknown)).toEqual([
      expect.objectContaining({
        task: REFUNDS_SWEEP_JOB,
        tenantId: alphaId,
        outcome: "done",
        counts: { refunds: 2 },
      }),
      expect.objectContaining({
        task: REFUNDS_SWEEP_JOB,
        tenantId: betaId,
        outcome: "done",
        counts: { refunds: 1 },
      }),
      // The later run: the lost refunds are claimed and sent now; the waiting one is found again, its job kept.
      expect.objectContaining({ tenantId: alphaId, outcome: "done", counts: { refunds: 1 } }),
      expect.objectContaining({ tenantId: betaId, outcome: "done", counts: { refunds: 0 } }),
    ]);
    const cases = [
      { tenant: "alpha", tenantId: alphaId, id: lost, job: submissions.alpha },
      { tenant: "beta", tenantId: betaId, id: lostBeta, job: submissions.beta },
    ] as const;
    for (const { tenant, tenantId, id, job } of cases) {
      expect(job.id).toBe(`refund-submit-${id}`);
      expect(job.returnvalue).toEqual({
        tenantId,
        job: "refund.submit",
        id,
        outcome: "applied",
      } satisfies PaymentJobResult);
      const calls = submissionsOf(id);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.form).toMatchObject({
        amount: "4000",
        metadata: { refund_id: id, velexis_tenant_id: tenantId, velexis_environment: "test" },
      });
      expect(await refundOf(id, tenant)).toMatchObject({
        status: "processing",
        providerRefundId: expect.stringMatching(/^re_test_/),
      });
    }
  });

  it("[FIX-W27-FOLLOWUPS AC2] leaves alone a refund being sent, one already sent, a released claim, a fresh request and a queued job", async () => {
    for (const [id, before] of untouched) {
      expect(await refundOf(id), id).toEqual(before);
      expect(submissionsOf(id), id).toEqual([]);
    }
    for (const id of [fresh, claimed, submitted, released]) {
      expect(await payments.getJob(`refund-submit-${id}`), id).toBeUndefined();
    }
    // The waiting refund keeps the one job its producer added, still delayed.
    const kept = await payments.getJob(`refund-submit-${waiting}`);
    expect(await kept?.getState()).toBe("delayed");
    expect(kept?.opts.delay).toBe(60 * 60_000);
  });

  describe("after a full batch (OADR-0014 point 2)", () => {
    /** A full batch of older refunds whose jobs BullMQ holds without having claimed them: a backlog. */
    let held: string[];
    /** The refund behind them, whose enqueue was lost. */
    let behind: string;
    let runs: Job[];
    let submission: Job;

    const submitJobId = (id: string): string => paymentJob(PAYMENT_JOB.refundSubmit, betaId, id).opts.jobId;

    beforeAll(async () => {
      const payment = await insertPayment({ status: "captured", amountCaptured: "452.10" }, "beta");
      const older = new Date(Date.now() - REFUND_SWEEP_AFTER_MS - 10 * 60_000);
      held = [];
      for (let n = 0; n < REFUND_SWEEP_BATCH; n += 1) {
        held.push(await askRefund(payment, "0.01", older, "beta"));
      }
      behind = await askRefund(payment, "0.01", longAgo(), "beta");
      // Their jobs wait behind others (delayed an hour): every run finds these refunds first.
      await payments.addBulk(
        held.map((id) => {
          const job = paymentJob(PAYMENT_JOB.refundSubmit, betaId, id);
          return { name: job.name, data: job.data, opts: { ...job.opts, delay: 60 * 60_000 } };
        }),
      );

      // One run of a later iteration: its first job and the continuation the runner adds for the full batch.
      const bucket = minuteBucket(new Date()) + 30;
      runs = [
        await sweep(betaId, bucket),
        await finished(maintenance, tenantJobId(REFUNDS_SWEEP_JOB, betaId, bucket, 1)),
      ];
      submission = await finished(payments, submitJobId(behind));
    }, SCENARIO_TIMEOUT_MS);

    afterAll(async () => {
      // The held jobs would only run in an hour: the file's worker never takes them.
      for (const id of held) {
        await (await payments.getJob(submitJobId(id)))?.remove();
      }
    });

    it("[FIX-W27-FOLLOWUPS AC1] continues with the next batch and submits the lost refund behind it once", async () => {
      expect(runs.map((job) => job.returnvalue as unknown)).toEqual([
        expect.objectContaining({
          tenantId: betaId,
          outcome: "done",
          counts: { refunds: REFUND_SWEEP_BATCH },
          continued: true,
        }),
        expect.objectContaining({
          tenantId: betaId,
          outcome: "done",
          counts: { refunds: 1 },
          continued: false,
        }),
      ]);
      expect(submission.returnvalue).toEqual({
        tenantId: betaId,
        job: "refund.submit",
        id: behind,
        outcome: "applied",
      } satisfies PaymentJobResult);
      expect(submissionsOf(behind)).toHaveLength(1);
      expect(await refundOf(behind, "beta")).toMatchObject({ status: "processing" });
    });

    it("[FIX-W27-FOLLOWUPS AC2] leaves the held refunds to the jobs BullMQ holds for them", async () => {
      const unchanged = await txOf("beta")(
        async (trx) =>
          await trx
            .selectFrom("refunds")
            .select(sql<string>`count(*)::text`.as("count"))
            .where("id", "in", held)
            .where("status", "=", "pending")
            .where("version", "=", 1)
            .executeTakeFirstOrThrow(),
      );
      expect(unchanged.count).toBe(String(REFUND_SWEEP_BATCH));
      expect(held.flatMap((id) => submissionsOf(id))).toEqual([]);
      const states = await Promise.all(held.map((id) => payments.getJobState(submitJobId(id))));
      expect(new Set(states)).toEqual(new Set(["delayed"]));
    });
  });
});

describe("payments.authorisation_watch", () => {
  const MINUTE_MS = 60_000;
  /** Tomorrow at this minute: the watch's first run; later runs add days. */
  const BASE = new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS + DAY_MS);
  const clock = new FakeClock(BASE);
  let due: string;
  let dueTomorrow: string;
  let fresh: string;
  let notAuthorised: string[];
  let suspended: string;
  const results: Job[] = [];

  /** Runs the watch for `tenantId` at the clock's current minute, as the fan-out adds it, and waits for it. */
  async function watch(tenantId: string): Promise<Job> {
    const spec = tenantJob(AUTHORISATION_WATCH_JOB, tenantId, minuteBucket(clock.now()));
    await maintenance.add(spec.name, spec.data, spec.opts);
    const job = await finished(maintenance, spec.opts.jobId);
    results.push(job);
    return job;
  }

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    const at = (days: number) => new Date(BASE.getTime() - days * DAY_MS);
    due = await insertPayment({ status: "authorized", authorizedAt: at(6) });
    dueTomorrow = await insertPayment({ status: "authorized", authorizedAt: at(4.5) });
    fresh = await insertPayment({ status: "authorized", authorizedAt: at(1) });
    notAuthorised = [
      await insertPayment({ status: "captured", amountCaptured: "452.10", authorizedAt: at(6) }),
      await insertPayment({ status: "canceled", authorizedAt: at(6) }),
      await insertPayment({ status: "requires_payment_method", intentId: stripeId("pi") }),
    ];
    suspended = await insertPayment({ status: "authorized", authorizedAt: at(6) }, "beta");

    // The scheduler's iteration: the fan-out adds one job per active or suspended tenant.
    const fanOut = await maintenance.add(
      FAN_OUT_JOB,
      { task: AUTHORISATION_WATCH_JOB },
      { prevMillis: clock.now().getTime() },
    );
    await finished(maintenance, fanOut.id ?? "");
    for (const tenantId of [alphaId, betaId]) {
      results.push(
        await finished(
          maintenance,
          tenantJobId(AUTHORISATION_WATCH_JOB, tenantId, minuteBucket(clock.now())),
        ),
      );
    }
    // The same day again (a later run, a continuation), then a day later.
    clock.advance(MINUTE_MS);
    await watch(alphaId);
    clock.advance(DAY_MS);
    await watch(alphaId);
    await watch(betaId);
  }, SCENARIO_TIMEOUT_MS);

  it("alerts once per payment, whatever the runs, and only payments authorised more than 5 days ago [OBE-040 AC3]", async () => {
    expect(results.map((job) => job.returnvalue as { counts?: unknown })).toEqual([
      expect.objectContaining({ tenantId: alphaId, outcome: "done", counts: { payments: 1, alerts: 1 } }),
      expect.objectContaining({ tenantId: betaId, outcome: "done", counts: { payments: 1, alerts: 1 } }),
      expect.objectContaining({ tenantId: alphaId, counts: { payments: 0, alerts: 0 } }),
      expect.objectContaining({ tenantId: alphaId, counts: { payments: 1, alerts: 1 } }),
      expect.objectContaining({ tenantId: betaId, counts: { payments: 0, alerts: 0 } }),
    ]);
    const alerts = await alertsLike("staff.authorisation_watch:");
    expect(alerts.map((alert) => alert.dedupeKey).sort()).toEqual(
      [`staff.authorisation_watch:${due}`, `staff.authorisation_watch:${dueTomorrow}`].sort(),
    );
    for (const alert of alerts) {
      expect(alert).toMatchObject({
        templateKey: "staff.manual_review",
        recipient: OPS_ALERT_EMAIL,
        recipientType: "staff",
      });
    }
    expect(
      JSON.stringify(alerts.find((alert) => alert.dedupeKey?.endsWith(due) === true)?.payload),
    ).toContain(`authorised at ${new Date(BASE.getTime() - 6 * DAY_MS).toISOString()}`);
    for (const id of [due, dueTomorrow]) {
      expect((await eventsOf(id)).map((event) => [event.type, event.source, event.amount])).toEqual([
        [AUTHORISATION_EXPIRING_EVENT, "system", "452.10"],
      ]);
    }
    for (const id of [fresh, ...notAuthorised]) {
      expect(await eventsOf(id)).toEqual([]);
    }
  });

  it("runs for suspended tenants too, in their own schema (OADR-0014 point 4)", async () => {
    expect((await alertsLike("staff.authorisation_watch:", "beta")).map((alert) => alert.dedupeKey)).toEqual([
      `staff.authorisation_watch:${suspended}`,
    ]);
    expect(await eventsOf(suspended, "beta")).toEqual([
      expect.objectContaining({ type: AUTHORISATION_EXPIRING_EVENT }),
    ]);
  });
});

describe("the lock order of a booking and its payment (FIX-W24-BOOKINGS)", () => {
  let retry: { readonly paymentId: string; readonly bookingId: string; readonly job: Job };
  let retrySeen: LockOrderObservation;
  let watched: { readonly paymentId: string; readonly bookingId: string; readonly job: Job };
  let watchSeen: LockOrderObservation;
  let refunded: { readonly bookingId: string; readonly result: CreateRefundResult };
  let refundSeen: LockOrderObservation;

  beforeAll(async () => {
    // A capture retry while another transaction holds the payment's booking (test/helpers/lock-order.ts): the job's
    // transaction waits for the booking before it locks the payment, then captures and shows it on the booking.
    const bookingId = await insertBooking();
    const payment = await stripePayment({ status: "authorized", bookingId });
    await insertCaptureFailure(payment.id, bookingId, "440.00");
    const retryProbe = probeLockOrder(tenantDb, "tenant_alpha", { bookingId, paymentId: payment.id });
    await retryProbe.locked;
    const [retryJob, seenByRetry] = await Promise.all([
      runPaymentJob(PAYMENT_JOB.captureRetry, payment.id),
      retryProbe.result,
    ]);
    retry = { paymentId: payment.id, bookingId, job: retryJob };
    retrySeen = seenByRetry;

    // The authorisation watch alerts about the payment of a booking (its outbox row references the booking): it locks
    // the booking before the payment too. Only this payment is due at the watch's time (the others are alerted, newer,
    // or not authorised).
    const clock = new FakeClock(new Date());
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    const watchedBooking = await insertBooking();
    const watchedPayment = await insertPayment({
      status: "authorized",
      bookingId: watchedBooking,
      authorizedAt: new Date(clock.now().getTime() - 6 * DAY_MS),
    });
    const watchProbe = probeLockOrder(tenantDb, "tenant_alpha", {
      bookingId: watchedBooking,
      paymentId: watchedPayment,
    });
    await watchProbe.locked;
    const spec = tenantJob(AUTHORISATION_WATCH_JOB, alphaId, minuteBucket(clock.now()));
    await maintenance.add(spec.name, spec.data, spec.opts);
    const [watchJob, seenByWatch] = await Promise.all([
      finished(maintenance, spec.opts.jobId),
      watchProbe.result,
    ]);
    watched = { paymentId: watchedPayment, bookingId: watchedBooking, job: watchJob };
    watchSeen = seenByWatch;

    // A refund asked for through RefundsRepository.create (the cancellation of OBE-049, the console of OBE-068): its
    // row references the booking, so the booking is locked before the payment there too.
    const refundedBooking = await insertBooking();
    const refundedPayment = await stripePayment(
      { status: "captured", amountCaptured: "452.10", bookingId: refundedBooking },
      { status: "succeeded", amount_capturable: 0, amount_received: 45210 },
    );
    const refundProbe = probeLockOrder(tenantDb, "tenant_alpha", {
      bookingId: refundedBooking,
      paymentId: refundedPayment.id,
    });
    await refundProbe.locked;
    const [result, seenByRefund] = await Promise.all([
      alphaTx((trx) =>
        refunds.create(trx, {
          id: newId("rfd"),
          paymentId: refundedPayment.id,
          amount: "100.00",
          reason: "booking_cancelled",
          requestedBy: { type: "system", id: null },
          now: new Date(),
        }),
      ),
      refundProbe.result,
    ]);
    refunded = { bookingId: refundedBooking, result };
    refundSeen = seenByRefund;
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W24-BOOKINGS AC6] payment.capture_retry locks the booking before the payment: the payment is free while it waits", async () => {
    expect(retrySeen).toEqual({ waiterSeen: true, paymentFree: true });
    expect(retry.job.returnvalue).toMatchObject({ outcome: "applied" });
    expect(await paymentOf(retry.paymentId)).toMatchObject({ status: "captured", amountCaptured: "440.00" });
    const amountPaid = await alphaTx(
      async (trx) =>
        (
          await trx
            .selectFrom("bookings")
            .select(sql<string>`amount_paid::text`.as("amountPaid"))
            .where("id", "=", retry.bookingId)
            .executeTakeFirstOrThrow()
        ).amountPaid,
    );
    expect(amountPaid).toBe("440.00");
  });

  it("[FIX-W24-BOOKINGS AC6] the authorisation watch locks the booking before the payment it alerts about", async () => {
    expect(watchSeen).toEqual({ waiterSeen: true, paymentFree: true });
    expect(watched.job.returnvalue).toMatchObject({ outcome: "done", counts: { payments: 1, alerts: 1 } });
    expect(await alertsLike(`staff.authorisation_watch:${watched.paymentId}`)).toEqual([
      expect.objectContaining({ bookingId: watched.bookingId, recipientType: "staff" }),
    ]);
  });

  it("[FIX-W24-BOOKINGS AC6] a refund request locks the booking its row references before the payment", () => {
    expect(refundSeen).toEqual({ waiterSeen: true, paymentFree: true });
    expect(refunded.result).toMatchObject({
      ok: true,
      refund: { bookingId: refunded.bookingId, amount: "100.00", status: "pending" },
    });
  });
});

describe("the lock order of a refund and its payment (FIX-W25-BOOKINGS)", () => {
  /** What a `refund.submit` job did while the probe held the refund's payment. */
  interface Seen {
    readonly refundId: string;
    readonly job: Job;
    readonly seen: RowLockOrderObservation;
  }
  let recorded: Seen;
  let refused: Seen;
  let notRefundable: Seen;

  /** A captured payment of a confirmed booking, with a pending refund of 50.00 asked for through RefundsRepository. */
  async function askedRefund(): Promise<{ readonly paymentId: string; readonly refundId: string }> {
    const bookingId = await insertBooking();
    const payment = await stripePayment(
      { status: "captured", amountCaptured: "452.10", bookingId },
      { status: "succeeded", amount_capturable: 0, amount_received: 45210 },
    );
    const asked = await alphaTx((trx) =>
      refunds.create(trx, {
        id: newId("rfd"),
        paymentId: payment.id,
        amount: "50.00",
        reason: "booking_cancelled",
        requestedBy: { type: "system", id: null },
        now: new Date(),
      }),
    );
    if (!asked.ok) {
      throw new Error(`the refund was refused: ${asked.reason}`);
    }
    return { paymentId: payment.id, refundId: asked.refund.id };
  }

  /** Holds the payment, then probes the refund (test/helpers/lock-order.ts). */
  const holdPayment = (ids: { readonly paymentId: string; readonly refundId: string }) =>
    probeRowLockOrder(tenantDb, "tenant_alpha", {
      held: { table: "payments", id: ids.paymentId },
      probed: { table: "refunds", id: ids.refundId },
    });

  /**
   * Runs `refund.submit` for the refund of `ids`; when Stripe is asked for the refund (the claim committed, no
   * transaction open), the probe takes the payment, and Stripe answers once it holds it.
   */
  async function submitWhileStripeAnswers(ids: {
    readonly paymentId: string;
    readonly refundId: string;
  }): Promise<Seen> {
    let probe: RowLockOrderProbe | undefined;
    stripe.onRequest(async (req) => {
      if (req.method !== "POST" || req.path !== "/v1/refunds" || probe !== undefined) {
        return;
      }
      probe = holdPayment(ids);
      await probe.locked;
    });
    try {
      const job = await runPaymentJob(PAYMENT_JOB.refundSubmit, ids.refundId);
      if (probe === undefined) {
        throw new Error("refund.submit did not call Stripe");
      }
      return { refundId: ids.refundId, job, seen: await probe.result };
    } finally {
      stripe.onRequest(undefined);
    }
  }

  beforeAll(async () => {
    // The record of the Stripe refund: its payment event references the payment.
    recorded = await submitWhileStripeAnswers(await askedRefund());
    // A refund Stripe refuses: the refund `failed`, its payment event and the staff alert.
    const second = await askedRefund();
    stripe.fail(1, "refused");
    refused = await submitWhileStripeAnswers(second);
    // A refund of a payment without a PaymentIntent (a row create() would refuse), failed by the claim itself while
    // the probe holds the payment from before the job.
    const bookingId = await insertBooking();
    const paymentId = await insertPayment({
      status: "captured",
      amountCaptured: "452.10",
      bookingId,
      intentId: null,
    });
    const refundId = newId("rfd");
    await alphaTx((trx) =>
      trx
        .insertInto("refunds")
        .values({
          id: refundId,
          payment_id: paymentId,
          booking_id: bookingId,
          currency: "EUR",
          amount: "50.00",
          reason: "booking_cancelled",
          status: "pending",
          requested_by_type: "system",
        })
        .execute(),
    );
    const probe = holdPayment({ paymentId, refundId });
    await probe.locked;
    const [job, seen] = await Promise.all([runPaymentJob(PAYMENT_JOB.refundSubmit, refundId), probe.result]);
    notRefundable = { refundId, job, seen };
  }, SCENARIO_TIMEOUT_MS);

  /** The status of a refund. */
  const refundStatus = async (refundId: string): Promise<string> =>
    (
      await alphaTx((trx) =>
        trx.selectFrom("refunds").select("status").where("id", "=", refundId).executeTakeFirstOrThrow(),
      )
    ).status;

  it("[FIX-W25-BOOKINGS AC3] records a Stripe refund with the payment locked before the refund: the refund is free while it waits", async () => {
    expect(recorded.seen).toEqual({ waiterSeen: true, probedFree: true });
    expect(recorded.job.returnvalue).toMatchObject({ outcome: "applied" });
    expect(await refundStatus(recorded.refundId)).toBe("processing");
  });

  it("[FIX-W25-BOOKINGS AC3] fails a refund Stripe refused with the payment locked before the refund", async () => {
    expect(refused.seen).toEqual({ waiterSeen: true, probedFree: true });
    expect(refused.job.returnvalue).toMatchObject({ outcome: "failed" });
    expect(await refundStatus(refused.refundId)).toBe("failed");
    expect((await alertsLike(`staff.refund:${refused.refundId}:`)).map((alert) => alert.dedupeKey)).toEqual([
      `staff.refund:${refused.refundId}:failed`,
    ]);
  });

  it("[FIX-W25-BOOKINGS AC3] fails a refund its claim cannot send with the payment locked before the refund", async () => {
    expect(notRefundable.seen).toEqual({ waiterSeen: true, probedFree: true });
    expect(notRefundable.job.returnvalue).toMatchObject({ outcome: "failed" });
    expect(await refundStatus(notRefundable.refundId)).toBe("failed");
  });
});

describe("the worker's log", () => {
  it("never holds a Stripe key, a client secret or the alert address", () => {
    const text = workerSink.text();
    expect(text).toContain("payments.job_processed");
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("_secret_");
    expect(text).not.toContain(OPS_ALERT_EMAIL);
  });
});
