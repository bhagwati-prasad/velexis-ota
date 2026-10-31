// `checkouts.expire` and `retention.daily` against PostgreSQL 16, Redis 7 and a fake of the Stripe API (OBE-056;
// ota/docs/architecture.md §6, ota/docs/data-model.md §6, OADR-0014 points 2, 4 and 5, OADR-0003 points 9 and 10).
// The worker's module graph runs in-process (WorkerModule.forRoot, as dist/worker.js builds it) on a clone of the
// @velexis/testing template (`tenant_alpha` and `tenant_beta` provisioned) and a Redis database of its own: the
// `ota-maintenance` consumer with the fan-out and both handlers, and the `ota-payments` consumer, which voids through
// the StripeGateway and the real `stripe` client pointed at the fake (test/helpers/fake-stripe.ts).
//
// The file plays the platform (velexis_migrator: alpha `active`, beta `suspended`, each with its Velexis-mode Stripe
// connection) and the API (`tenantTx` as velexis_ota_app: the shopping rows a checkout needs, checkouts, payments and
// bookings as checkout.createPayment, checkout.complete and the reconciliation leave them, and the rows the retention
// keeps or purges). It removes the schedulers the worker registered at start-up and plays the scheduler instead: each
// run adds a `fan-out` job with the `prevMillis` of an iteration due at the FakeClock's minute, as BullMQ's scheduler
// adds them, and waits for the per-tenant jobs, whose ids it knows. Both handlers and the payments jobs read the time
// from `Clock`, which each scenario points at the file's FakeClock; the clock only moves forward, a minute or more
// between runs, so every run has a bucket of its own. Each scenario does its work in its `beforeAll` hook, with a
// budget of its own; its tests read what it left.
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
import type { Job, Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CHECKOUTS_EXPIRE_JOB,
  expireLockedCheckouts,
  VOID_LOOKBACK_MS,
  type CheckoutExpiryCounts,
} from "../../../src/checkout/checkout-expiry.processor";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import { minuteBucket, tenantJobId, type TenantJobResult } from "../../../src/jobs/fan-out";
import { JOB_BATCH_LIMITS } from "../../../src/jobs/limits";
import {
  RETENTION_BATCH,
  RETENTION_BATCHES_PER_JOB,
  RETENTION_JOB,
  type RetentionCounts,
} from "../../../src/jobs/retention.processor";
import { RetentionRepository } from "../../../src/jobs/retention.repository";
import { FAN_OUT_JOB } from "../../../src/jobs/schedulers";
import { PaymentsProcessor, type PaymentJobResult } from "../../../src/payments/payments.processor";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { testWorkerVariables } from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

/**
 * Cloning the template and starting the worker's graph (BullMQ connections, the scheduler registration): a few seconds
 * alone, more while every package's integration tests run on a 4-CPU CI runner. The bound only stops a hang.
 */
const SETUP_TIMEOUT_MS = 90_000;
/** A scenario writes its rows, runs a few jobs and waits for the worker each time; the bound only stops a hang. */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for one job of the worker (they take milliseconds). */
const WAIT_MS = 20_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** This run's Velexis test keys: Stripe's shapes, random, never a committed value. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

const quietPoolLogger = { error: (): void => undefined };

type TenantKey = "alpha" | "beta";

let db: TestDatabase;
let redis: TestRedis;
let stripe: FakeStripe;
let worker: INestApplicationContext;
const sink = new MemorySink();
let migratorPool: ReturnType<typeof createPool>;
/** velexis_migrator, the owner of the platform tables: inserts the tenants as the platform does. */
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
/** `tenantTx` as velexis_ota_app: writes the tenant rows as the API does. */
let tenantDb: TenantDb;
let maintenance: Queue;
let payments: Queue;
/** The `ota-payments` worker, paused while a scenario asks for one void several times. */
let paymentsWorker: Worker;
const tenantIds: Record<TenantKey, string> = { alpha: "", beta: "" };
/** The priced offer every checkout of a tenant is opened with. */
const pricedOfferIds: Record<TenantKey, string> = { alpha: "", beta: "" };

/** Tomorrow at this minute: the file's first run; the clock only moves forward from here. */
const BASE = new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS + DAY_MS);
const clock = new FakeClock(BASE);

const txOf =
  (tenant: TenantKey) =>
  <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
    tenantTx(tenantDb, `tenant_${tenant}`, run);

/** A fresh Stripe-shaped id of this run (`pi_test_…`). */
const stripeId = (prefix: string): string => `${prefix}_test_${randomBytes(10).toString("hex")}`;
/** A fresh booking reference (`bookings.reference`: 6 to 10 upper-case letters and digits). */
const bookingReference = (): string => `VX${randomBytes(3).toString("hex").toUpperCase()}`;
/** A fresh SHA-256-shaped hex value, as the token tables store hashes. */
const hash = (): string => randomBytes(32).toString("hex");
/** The clock's instant moved by `ms` (negative: in the past). */
const fromNow = (ms: number): Date => new Date(clock.now().getTime() + ms);

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

/** A search with one offer and its priced offer, valid for a year: what checkout.create opens a checkout with. */
async function insertPricedOffer(tenant: TenantKey): Promise<string> {
  const searchId = newId("srch");
  const offerId = newId("off");
  const pricedOfferId = newId("prc");
  const expires = fromNow(365 * DAY_MS);
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
  });
  return pricedOfferId;
}

// ---- Checkouts, payments and bookings ---------------------------------------------------------------------------

interface CheckoutSeed {
  /** `expired`: as an earlier run of the job left it, at `updatedInMs`. */
  readonly status?: "open" | "payment_pending" | "expired";
  /** When it expires, relative to the clock. */
  readonly expiresInMs: number;
  /** Its last change (the expiry of an `expired` one), relative to the clock; the database's `now()` otherwise. */
  readonly updatedInMs?: number;
}

/** A guest checkout as checkout.create and checkout.createPayment (or the expiry) leave it; in `trx` when given. */
async function insertCheckout(
  tenant: TenantKey,
  seed: CheckoutSeed,
  trx?: TenantTransaction,
): Promise<string> {
  const id = newId("chk");
  const insert = (into: TenantTransaction) =>
    into
      .insertInto("checkouts")
      .values({
        id,
        environment: "test",
        is_guest: true,
        base_priced_offer_id: pricedOfferIds[tenant],
        priced_offer_id: pricedOfferIds[tenant],
        status: seed.status ?? "payment_pending",
        currency: "EUR",
        offer_amount: "440.00",
        total_amount: "440.00",
        expires_at: fromNow(seed.expiresInMs),
        version: 3,
        ...(seed.updatedInMs === undefined ? {} : { updated_at: fromNow(seed.updatedInMs) }),
      })
      .execute();
  await (trx === undefined ? txOf(tenant)(insert) : insert(trx));
  return id;
}

interface PaymentSeed {
  readonly checkoutId: string;
  readonly status: string;
  readonly bookingId?: string | null;
  /** An airline-card payment: no PaymentIntent, nothing to void. */
  readonly airline?: boolean;
  /** Stripe status of the PaymentIntent the fake answers (`requires_capture` for an authorisation). */
  readonly intentStatus?: string;
}

interface SeededPayment {
  readonly id: string;
  readonly intentId: string | null;
}

/**
 * A payment of 440.00 EUR of `seed.checkoutId`, as checkout.createPayment and the webhooks leave it; a Stripe one has
 * its PaymentIntent in the fake, with the metadata the gateway checks.
 */
async function insertPayment(
  tenant: TenantKey,
  seed: PaymentSeed,
  trx?: TenantTransaction,
): Promise<SeededPayment> {
  const id = newId("pay");
  const airline = seed.airline === true;
  const intentId = airline ? null : stripeId("pi");
  const authorised = seed.status === "authorized";
  const insert = (into: TenantTransaction) =>
    into
      .insertInto("payments")
      .values({
        id,
        environment: "test",
        checkout_id: seed.checkoutId,
        booking_id: seed.bookingId ?? null,
        provider: airline ? "airline" : "stripe",
        provider_connection_id: airline ? null : newId("ppc"),
        provider_payment_id: intentId,
        method: airline ? "airline_card" : "card",
        capture_method: airline ? "automatic" : "manual",
        currency: "EUR",
        amount: "440.00",
        amount_authorized: authorised ? "440.00" : "0",
        status: seed.status,
        authorized_at: authorised ? fromNow(-30 * MINUTE_MS) : null,
        three_ds: airline ? null : JSON.stringify({ required: false, status: "not_required", version: null }),
        metadata: JSON.stringify({}),
        version: 2,
      })
      .execute();
  await (trx === undefined ? txOf(tenant)(insert) : insert(trx));
  if (intentId !== null) {
    stripe.intents.set(intentId, {
      id: intentId,
      object: "payment_intent",
      status: seed.intentStatus ?? (authorised ? "requires_capture" : "requires_action"),
      amount: 44000,
      amount_capturable: authorised ? 44000 : 0,
      amount_received: 0,
      currency: "eur",
      capture_method: "manual",
      client_secret: `${intentId}_secret_${randomBytes(8).toString("hex")}`,
      metadata: {
        velexis_tenant_id: tenantIds[tenant],
        velexis_environment: "test",
        checkout_id: seed.checkoutId,
        payment_id: id,
      },
      payment_method: null,
      latest_charge: null,
      last_payment_error: null,
      livemode: false,
    });
  }
  return { id, intentId };
}

interface BookingSeed {
  readonly status: "pending" | "failed" | "ticketed";
  readonly checkoutId?: string | null;
  readonly createdAt?: Date;
}

/**
 * A booking: `pending` as checkout.complete leaves it after an Amadeus 5xx on Flight Create Orders (claimed, the
 * unknown outcome recorded: `reconcile_until` 15 minutes after the attempt), `failed` as the reconciliation's not-found
 * decision leaves it (`checkout_id` cleared), or an old `ticketed` one.
 */
async function insertBooking(tenant: TenantKey, seed: BookingSeed, trx?: TenantTransaction): Promise<string> {
  const id = newId("bkg");
  const created = seed.createdAt ?? fromNow(-10 * MINUTE_MS);
  const departure = new Date(created.getTime() + 30 * DAY_MS);
  const started = new Date(created.getTime() + MINUTE_MS);
  const insert = (into: TenantTransaction) =>
    into
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: bookingReference(),
        checkout_id: seed.checkoutId ?? null,
        priced_offer_id: pricedOfferIds[tenant],
        status: seed.status,
        ticketing_status:
          seed.status === "pending" ? "pending" : seed.status === "failed" ? "not_applicable" : "issued",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 3 * HOUR_MS),
        currency: "EUR",
        net_amount: "400.00",
        total_amount: "440.00",
        contact_email: "traveller@example.com",
        lead_last_name: "SAMPLE",
        create_order_started_at: seed.status === "ticketed" ? null : started,
        reconcile_until: seed.status === "ticketed" ? null : new Date(started.getTime() + 15 * MINUTE_MS),
        reconcile_outcome: seed.status === "failed" ? "not_found" : null,
        failure_code: seed.status === "failed" ? "SUPPLIER_TIMEOUT" : null,
        created_at: created,
        updated_at: created,
      })
      .execute();
  await (trx === undefined ? txOf(tenant)(insert) : insert(trx));
  return id;
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
): Promise<{ status: string; bookingId: string | null; version: number }> {
  return await txOf(tenant)((trx) =>
    trx
      .selectFrom("payments")
      .select(["status", "booking_id as bookingId", "version"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow(),
  );
}

/** The `payment.voided` events of a payment. */
async function voidEventsOf(tenant: TenantKey, paymentId: string): Promise<number> {
  const rows = await txOf(tenant)((trx) =>
    trx
      .selectFrom("payment_events")
      .select("id")
      .where("payment_id", "=", paymentId)
      .where("type", "=", "payment.voided")
      .execute(),
  );
  return rows.length;
}

/** The cancellations of a PaymentIntent the fake Stripe API received. */
const cancelsOf = (intentId: string | null) =>
  stripe.requests.filter(
    (request) => request.method === "POST" && request.path === `/v1/payment_intents/${intentId ?? ""}/cancel`,
  );

/** The job id of a payment's void, as its producers add it (`paymentJob`). */
const voidJobId = (paymentId: string): string => `payment-void-${paymentId}`;

// ---- The scheduler's side ---------------------------------------------------------------------------------------

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
 * The job `id` of `queue` once it has finished (completed or failed). The state is read first and the job after it:
 * BullMQ writes a job's result and moves it to its final set in one step.
 */
async function finished(queue: Queue, id: string): Promise<Job> {
  return await waitFor(`the job ${id}`, async () => {
    const state = await queue.getJobState(id);
    return state === "completed" || state === "failed" ? await queue.getJob(id) : undefined;
  });
}

/** The per-tenant jobs of one run, by tenant. */
type RunJobs = Record<TenantKey, Job>;

/**
 * One scheduler iteration of `task` due at the clock's minute: its `fan-out` job, then the per-tenant jobs of both
 * tenants (alpha `active`, beta `suspended`), whose ids the fan-out builds.
 */
async function iteration(task: string): Promise<RunJobs> {
  const due = clock.now();
  const fanOut = await maintenance.add(FAN_OUT_JOB, { task }, { prevMillis: due.getTime() });
  await finished(maintenance, fanOut.id ?? "");
  return {
    alpha: await finished(maintenance, tenantJobId(task, tenantIds.alpha, minuteBucket(due))),
    beta: await finished(maintenance, tenantJobId(task, tenantIds.beta, minuteBucket(due))),
  };
}

/** The result a per-tenant job completed with. */
function resultOf(job: Job): TenantJobResult {
  return job.returnvalue as TenantJobResult;
}

/** A completed per-tenant job's result with these counts. */
function done<C extends Readonly<Record<string, number>>>(
  tenant: TenantKey,
  task: string,
  counts: C,
  continued = false,
): TenantJobResult {
  return { task, tenantId: tenantIds[tenant], outcome: "done", counts, continued };
}

const expiryCounts = (expired: number, voids: number, held = 0): CheckoutExpiryCounts => ({
  expired,
  held,
  voids,
});

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
  tenantIds.alpha = await insertTenant("alpha", "active");
  tenantIds.beta = await insertTenant("beta", "suspended");
  for (const tenant of ["alpha", "beta"] as const) {
    await txOf(tenant)((trx) =>
      seedStorefrontSettings(trx, { name: `${tenant} Travel`, defaultCurrency: "EUR", defaultLocale: "en" }),
    );
    pricedOfferIds[tenant] = await insertPricedOffer(tenant);
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
      WorkerModule.forRoot(config, { logger: createWorkerLogger(config, sink) }),
    ],
  })
  class WorkerRootModule {}
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(WorkerRootModule);
  await worker.init();
  maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  payments = worker.get<Queue>(getQueueToken(OTA_QUEUE.payments), { strict: false });
  paymentsWorker = worker.get(PaymentsProcessor, { strict: false }).worker;
  await paymentsWorker.waitUntilReady();
  // From here on the file plays the scheduler: no iteration of the real ones may fire while it runs.
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

describe("checkouts.expire: the expiry and the void", () => {
  /** Alpha: payment_pending past its expiry, authorised. */
  let authorised: { checkoutId: string; payment: SeededPayment };
  /** Alpha: payment_pending past its expiry, its PaymentIntent waiting for 3-D Secure. */
  let unconfirmed: { checkoutId: string; payment: SeededPayment };
  /** Alpha: open past its expiry, without a payment. */
  let unpaid: string;
  /** Alpha: payment_pending past its expiry with an airline-card payment (nothing to void). */
  let airline: { checkoutId: string; payment: SeededPayment };
  /** Alpha: not expired yet (a year to go), authorised. */
  let live: { checkoutId: string; payment: SeededPayment };
  /** Beta (suspended): payment_pending past its expiry, authorised. */
  let suspended: { checkoutId: string; payment: SeededPayment };
  let versionsBefore: Record<string, number>;
  const runs: RunJobs[] = [];
  /** The void jobs of the two authorisations, each one, while the payments worker was paused for two runs. */
  let queuedWhilePaused: Record<string, number>;
  let voids: Record<string, Job>;

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    const pastExpiry = (tenant: TenantKey, status: "open" | "payment_pending" = "payment_pending") =>
      insertCheckout(tenant, { status, expiresInMs: -MINUTE_MS });
    const withPayment = async (
      tenant: TenantKey,
      checkoutId: string,
      seed: Omit<PaymentSeed, "checkoutId">,
    ) => ({
      checkoutId,
      payment: await insertPayment(tenant, { ...seed, checkoutId }),
    });
    authorised = await withPayment("alpha", await pastExpiry("alpha"), { status: "authorized" });
    unconfirmed = await withPayment("alpha", await pastExpiry("alpha"), { status: "requires_action" });
    unpaid = await pastExpiry("alpha", "open");
    airline = await withPayment("alpha", await pastExpiry("alpha"), {
      status: "requires_payment_method",
      airline: true,
    });
    live = await withPayment("alpha", await insertCheckout("alpha", { expiresInMs: 365 * DAY_MS }), {
      status: "authorized",
    });
    suspended = await withPayment("beta", await pastExpiry("beta"), { status: "authorized" });
    versionsBefore = {};
    for (const id of [authorised.checkoutId, unpaid, live.checkoutId]) {
      versionsBefore[id] = (await checkoutOf("alpha", id)).version;
    }

    // Two runs, a minute apart, while the payments worker takes nothing: both ask for the same voids.
    await paymentsWorker.pause();
    runs.push(await iteration(CHECKOUTS_EXPIRE_JOB));
    clock.advance(MINUTE_MS);
    runs.push(await iteration(CHECKOUTS_EXPIRE_JOB));
    const waiting = await payments.getJobs(["waiting", "delayed", "prioritized", "active"]);
    queuedWhilePaused = {};
    for (const payment of [authorised.payment, unconfirmed.payment, suspended.payment]) {
      queuedWhilePaused[payment.id] = waiting.filter((job) => job.id === voidJobId(payment.id)).length;
    }
    paymentsWorker.resume();
    voids = {};
    for (const payment of [authorised.payment, unconfirmed.payment, suspended.payment]) {
      voids[payment.id] = await finished(payments, voidJobId(payment.id));
    }
    // A third run once the voids are done: the payments are cancelled, nothing is asked for again.
    clock.advance(MINUTE_MS);
    runs.push(await iteration(CHECKOUTS_EXPIRE_JOB));
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-056 AC1] an expired checkout with an authorised payment ends expired and its void job runs once", async () => {
    expect(await checkoutOf("alpha", authorised.checkoutId)).toEqual({
      status: "expired",
      version: (versionsBefore[authorised.checkoutId] ?? 0) + 1,
    });
    // Two runs asked for the void before it ran: BullMQ held one job under the producers' id.
    expect(queuedWhilePaused[authorised.payment.id]).toBe(1);
    expect(voids[authorised.payment.id]?.returnvalue).toEqual({
      tenantId: tenantIds.alpha,
      job: "payment.void",
      id: authorised.payment.id,
      outcome: "applied",
    } satisfies PaymentJobResult);
    const cancels = cancelsOf(authorised.payment.intentId);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.headers["idempotency-key"]).toBe(`pi:cancel:${authorised.payment.id}`);
    expect(await paymentOf("alpha", authorised.payment.id)).toMatchObject({ status: "canceled" });
    expect(await voidEventsOf("alpha", authorised.payment.id)).toBe(1);
  });

  it("[OBE-056 AC1] counts per run: four checkouts expired, the voids asked for until they ran, then none", () => {
    const [first, second, third] = runs;
    // Alpha: the authorised, unconfirmed, unpaid and airline-card checkouts; two voidable Stripe payments.
    expect(first === undefined ? undefined : resultOf(first.alpha)).toEqual(
      done("alpha", CHECKOUTS_EXPIRE_JOB, expiryCounts(4, 2)),
    );
    expect(first === undefined ? undefined : resultOf(first.beta)).toEqual(
      done("beta", CHECKOUTS_EXPIRE_JOB, expiryCounts(1, 1)),
    );
    // The next minute nothing is due, and the voids that have not run yet are asked for again (BullMQ ignores them).
    expect(second === undefined ? undefined : resultOf(second.alpha)).toEqual(
      done("alpha", CHECKOUTS_EXPIRE_JOB, expiryCounts(0, 2)),
    );
    expect(third === undefined ? undefined : resultOf(third.alpha)).toEqual(
      done("alpha", CHECKOUTS_EXPIRE_JOB, expiryCounts(0, 0)),
    );
    expect(third === undefined ? undefined : resultOf(third.beta)).toEqual(
      done("beta", CHECKOUTS_EXPIRE_JOB, expiryCounts(0, 0)),
    );
  });

  it("voids a PaymentIntent that was not confirmed yet, so no authorisation comes after the expiry", async () => {
    expect(await checkoutOf("alpha", unconfirmed.checkoutId)).toMatchObject({ status: "expired" });
    expect(queuedWhilePaused[unconfirmed.payment.id]).toBe(1);
    expect(voids[unconfirmed.payment.id]?.returnvalue).toMatchObject({ outcome: "applied" });
    expect(cancelsOf(unconfirmed.payment.intentId)).toHaveLength(1);
    expect(await paymentOf("alpha", unconfirmed.payment.id)).toMatchObject({ status: "canceled" });
  });

  it("expires a checkout without a payment, and one with an airline-card payment without a void", async () => {
    expect(await checkoutOf("alpha", unpaid)).toEqual({
      status: "expired",
      version: (versionsBefore[unpaid] ?? 0) + 1,
    });
    expect(await checkoutOf("alpha", airline.checkoutId)).toMatchObject({ status: "expired" });
    expect(await payments.getJobState(voidJobId(airline.payment.id))).toBe("unknown");
    expect(await paymentOf("alpha", airline.payment.id)).toMatchObject({ status: "requires_payment_method" });
  });

  it("leaves a checkout that has not expired, and its authorisation, alone", async () => {
    expect(await checkoutOf("alpha", live.checkoutId)).toEqual({
      status: "payment_pending",
      version: versionsBefore[live.checkoutId],
    });
    expect(await payments.getJobState(voidJobId(live.payment.id))).toBe("unknown");
    expect(cancelsOf(live.payment.intentId)).toEqual([]);
    expect(await paymentOf("alpha", live.payment.id)).toMatchObject({ status: "authorized" });
  });

  it("expires the checkouts of a suspended tenant and releases their authorisations (OADR-0014 point 4)", async () => {
    expect(await checkoutOf("beta", suspended.checkoutId)).toMatchObject({ status: "expired" });
    expect(voids[suspended.payment.id]?.returnvalue).toMatchObject({
      tenantId: tenantIds.beta,
      outcome: "applied",
    });
    expect(cancelsOf(suspended.payment.intentId)).toHaveLength(1);
    expect(await paymentOf("beta", suspended.payment.id)).toMatchObject({ status: "canceled" });
  });

  it("logs counts with the tenant, never a checkout or payment id", () => {
    expect(sink.records()).toContainEqual(
      expect.objectContaining({
        msg: "checkouts.expired",
        tenantId: tenantIds.alpha,
        expired: 4,
        held: 0,
        voids: 2,
      }),
    );
    const logged = sink.text();
    for (const id of [authorised.checkoutId, unconfirmed.checkoutId, unpaid, airline.checkoutId]) {
      expect(logged).not.toContain(id);
    }
  });
});

describe("checkouts.expire: a checkout whose booking is pending", () => {
  /** More pending completions due than one batch holds. */
  const PENDING = JOB_BATCH_LIMITS.checkoutExpiry + 1;
  let pending: { checkoutId: string; bookingId: string; paymentId: string }[];
  let pendingBefore: PendingCompletion[];
  let pendingAfter: PendingCompletion[];
  /** The BullMQ state of each pending payment's void job id after the run. */
  let pendingVoids: string[];
  /** Due later than the pending ones, so a batch that took those first would never reach them. */
  let others: { checkoutId: string; payment: SeededPayment }[];
  /** Past its expiry, whose booking the reconciliation decided: `failed`, `checkout_id` cleared. */
  let decided: { checkoutId: string; bookingId: string; payment: SeededPayment };
  let run: RunJobs;
  let otherVoids: Job[];

  interface PendingCompletion {
    readonly checkout: { readonly status: string; readonly version: number };
    readonly booking: {
      readonly status: string;
      readonly checkoutId: string | null;
      readonly reconcileUntil: Date | null;
    };
    readonly payment: {
      readonly status: string;
      readonly bookingId: string | null;
      readonly version: number;
    };
  }

  /** The checkout, booking and payment of each pending completion, in the order of `pending` (three reads). */
  async function pendingState(): Promise<PendingCompletion[]> {
    return await txOf("alpha")(async (trx) => {
      const checkouts = await trx
        .selectFrom("checkouts")
        .select(["id", "status", "version"])
        .where(
          "id",
          "in",
          pending.map((entry) => entry.checkoutId),
        )
        .execute();
      const bookings = await trx
        .selectFrom("bookings")
        .select(["id", "status", "checkout_id as checkoutId", "reconcile_until as reconcileUntil"])
        .where(
          "id",
          "in",
          pending.map((entry) => entry.bookingId),
        )
        .execute();
      const paymentRows = await trx
        .selectFrom("payments")
        .select(["id", "status", "booking_id as bookingId", "version"])
        .where(
          "id",
          "in",
          pending.map((entry) => entry.paymentId),
        )
        .execute();
      return pending.map((entry) => {
        const checkout = checkouts.find((row) => row.id === entry.checkoutId);
        const booking = bookings.find((row) => row.id === entry.bookingId);
        const payment = paymentRows.find((row) => row.id === entry.paymentId);
        if (checkout === undefined || booking === undefined || payment === undefined) {
          throw new Error("a pending completion lost a row");
        }
        return {
          checkout: { status: checkout.status, version: checkout.version },
          booking: {
            status: booking.status,
            checkoutId: booking.checkoutId,
            reconcileUntil: booking.reconcileUntil,
          },
          payment: { status: payment.status, bookingId: payment.bookingId, version: payment.version },
        };
      });
    });
  }

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    clock.advance(HOUR_MS);
    pending = [];
    await txOf("alpha")(async (trx) => {
      for (let index = 0; index < PENDING; index += 1) {
        // Past its expiry two hours ago: the oldest due checkouts of the tenant.
        const checkoutId = await insertCheckout("alpha", { expiresInMs: -2 * HOUR_MS - index * 1000 }, trx);
        const bookingId = await insertBooking(
          "alpha",
          { status: "pending", checkoutId, createdAt: fromNow(-3 * HOUR_MS) },
          trx,
        );
        const payment = await insertPayment("alpha", { checkoutId, status: "authorized", bookingId }, trx);
        pending.push({ checkoutId, bookingId, paymentId: payment.id });
      }
    });
    pendingBefore = await pendingState();
    others = [];
    for (let index = 0; index < 2; index += 1) {
      const checkoutId = await insertCheckout("alpha", { expiresInMs: -MINUTE_MS });
      others.push({
        checkoutId,
        payment: await insertPayment("alpha", { checkoutId, status: "authorized" }),
      });
    }
    const decidedCheckout = await insertCheckout("alpha", { expiresInMs: -MINUTE_MS });
    const failedBooking = await insertBooking("alpha", { status: "failed", checkoutId: null });
    decided = {
      checkoutId: decidedCheckout,
      bookingId: failedBooking,
      payment: await insertPayment("alpha", {
        checkoutId: decidedCheckout,
        status: "authorized",
        bookingId: failedBooking,
      }),
    };

    run = await iteration(CHECKOUTS_EXPIRE_JOB);
    otherVoids = [];
    for (const payment of [...others.map((entry) => entry.payment), decided.payment]) {
      otherVoids.push(await finished(payments, voidJobId(payment.id)));
    }
    pendingAfter = await pendingState();
    pendingVoids = await Promise.all(
      pending.map((entry) => payments.getJobState(voidJobId(entry.paymentId))),
    );
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-056 AC2] is skipped: it keeps its status, its authorisation stays with the booking, no void is queued", () => {
    expect(pendingAfter).toHaveLength(PENDING);
    // Nothing of the checkout, its booking or its payment changed (versions included).
    expect(pendingAfter).toEqual(pendingBefore);
    pendingAfter.forEach((row, index) => {
      expect(row).toEqual({
        checkout: { status: "payment_pending", version: expect.any(Number) },
        booking: {
          status: "pending",
          checkoutId: pending[index]?.checkoutId,
          reconcileUntil: expect.any(Date),
        },
        payment: { status: "authorized", bookingId: pending[index]?.bookingId, version: expect.any(Number) },
      });
    });
    expect(pendingVoids).toEqual(pending.map(() => "unknown"));
  });

  it("[OBE-056 AC2] leaves the pending ones out of the batch, so the same run expires the tenant's other due checkouts", async () => {
    // One job, no continuation: the 51 pending checkouts never used up the batch of 50.
    expect(resultOf(run.alpha)).toEqual(done("alpha", CHECKOUTS_EXPIRE_JOB, expiryCounts(3, 3)));
    expect(
      await maintenance.getJobState(
        tenantJobId(CHECKOUTS_EXPIRE_JOB, tenantIds.alpha, minuteBucket(clock.now()), 1),
      ),
    ).toBe("unknown");
    for (const entry of others) {
      expect(await checkoutOf("alpha", entry.checkoutId)).toMatchObject({ status: "expired" });
      expect(await paymentOf("alpha", entry.payment.id)).toMatchObject({ status: "canceled" });
    }
    expect(otherVoids.map((job) => (job.returnvalue as PaymentJobResult).outcome)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);
  });

  it("expires a checkout once the reconciliation decided its booking, and voids the authorisation", async () => {
    expect(await checkoutOf("alpha", decided.checkoutId)).toMatchObject({ status: "expired" });
    expect(await paymentOf("alpha", decided.payment.id)).toMatchObject({
      status: "canceled",
      bookingId: decided.bookingId,
    });
    expect(cancelsOf(decided.payment.intentId)).toHaveLength(1);
  });
});

describe("checkouts.expire: a claim of checkout.complete beside the job", () => {
  /** Past its expiry, locked by a claim in progress while a run takes place, then claimed. */
  let claimed: { checkoutId: string; bookingId: string; payment: SeededPayment };
  let whileHeld: RunJobs;
  let afterCommit: RunJobs;
  /** The re-check after the lock: one checkout a booking claimed, one that nothing holds. */
  let recheck: { held: string; free: string; result: Awaited<ReturnType<typeof expireLockedCheckouts>> };

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    clock.advance(HOUR_MS);
    const checkoutId = await insertCheckout("alpha", { expiresInMs: -MINUTE_MS });
    const payment = await insertPayment("alpha", { checkoutId, status: "authorized" });
    const bookingId = newId("bkg");
    claimed = { checkoutId, bookingId, payment };

    // The claim's transaction (booking-orchestrator.service.ts, claimIn): the checkout locked FOR UPDATE, the pending
    // booking inserted, the payment pointed at it; it commits once a run has taken place beside it.
    let markHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claim = txOf("alpha")(async (trx) => {
      await trx.selectFrom("checkouts").select("id").where("id", "=", checkoutId).forUpdate().execute();
      const departure = fromNow(30 * DAY_MS);
      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          environment: "test",
          reference: bookingReference(),
          checkout_id: checkoutId,
          priced_offer_id: pricedOfferIds.alpha,
          status: "pending",
          ticketing_status: "pending",
          first_departure_at: departure,
          last_arrival_at: new Date(departure.getTime() + 3 * HOUR_MS),
          currency: "EUR",
          net_amount: "400.00",
          total_amount: "440.00",
          contact_email: "traveller@example.com",
          lead_last_name: "SAMPLE",
          create_order_started_at: clock.now(),
        })
        .execute();
      await trx.updateTable("payments").set({ booking_id: bookingId }).where("id", "=", payment.id).execute();
      markHeld();
      await released;
    });
    try {
      // The claim's own failure ends the wait too.
      await Promise.race([held, claim]);
      whileHeld = await iteration(CHECKOUTS_EXPIRE_JOB);
    } finally {
      // Commits the claim, also when the run failed: an open transaction would hold its pool connection.
      release();
      await claim;
    }
    clock.advance(MINUTE_MS);
    afterCommit = await iteration(CHECKOUTS_EXPIRE_JOB);

    // The re-check after the lock (steps 2 and 3): a claim that committed after the selection's snapshot and before
    // its row lock hands the job a checkout that a booking holds, which this plays by locking such a checkout
    // directly and passing it to the re-check with one that nothing holds.
    const heldCheckout = await insertCheckout("alpha", { expiresInMs: -MINUTE_MS });
    await insertBooking("alpha", { status: "pending", checkoutId: heldCheckout });
    const freeCheckout = await insertCheckout("alpha", { expiresInMs: -MINUTE_MS });
    const result = await txOf("alpha")(async (trx) => {
      await trx
        .selectFrom("checkouts")
        .select("id")
        .where("id", "in", [heldCheckout, freeCheckout])
        .orderBy("id")
        .forUpdate()
        .execute();
      return await expireLockedCheckouts(trx, [heldCheckout, freeCheckout], clock.now());
    });
    recheck = { held: heldCheckout, free: freeCheckout, result };
  }, SCENARIO_TIMEOUT_MS);

  it("skips a checkout a claim holds locked, and never expires it once the claim committed", async () => {
    // Locked by the claim: SKIP LOCKED leaves it to the next run, without waiting.
    expect(resultOf(whileHeld.alpha)).toEqual(done("alpha", CHECKOUTS_EXPIRE_JOB, expiryCounts(0, 0)));
    // Committed: its booking holds it, so the selection leaves it out.
    expect(resultOf(afterCommit.alpha)).toEqual(done("alpha", CHECKOUTS_EXPIRE_JOB, expiryCounts(0, 0)));
    expect(await checkoutOf("alpha", claimed.checkoutId)).toMatchObject({ status: "payment_pending" });
    expect(await paymentOf("alpha", claimed.payment.id)).toMatchObject({
      status: "authorized",
      bookingId: claimed.bookingId,
    });
    expect(await payments.getJobState(voidJobId(claimed.payment.id))).toBe("unknown");
    expect(cancelsOf(claimed.payment.intentId)).toEqual([]);
  });

  it("checks the booking again after the lock, and leaves a checkout a claim committed meanwhile as it was", async () => {
    expect(recheck.result).toEqual({ expired: [recheck.free], held: [recheck.held] });
    expect(await checkoutOf("alpha", recheck.held)).toMatchObject({ status: "payment_pending" });
    expect(await checkoutOf("alpha", recheck.free)).toMatchObject({ status: "expired" });
  });
});

describe("checkouts.expire: a full batch", () => {
  const DUE = JOB_BATCH_LIMITS.checkoutExpiry + 2;
  let due: string[];
  let first: Job;
  let continuation: Job;

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    clock.advance(HOUR_MS);
    due = [];
    await txOf("alpha")(async (trx) => {
      for (let index = 0; index < DUE; index += 1) {
        due.push(
          await insertCheckout("alpha", { status: "open", expiresInMs: -MINUTE_MS - index * 1000 }, trx),
        );
      }
    });
    const bucket = minuteBucket(clock.now());
    first = (await iteration(CHECKOUTS_EXPIRE_JOB)).alpha;
    continuation = await finished(maintenance, tenantJobId(CHECKOUTS_EXPIRE_JOB, tenantIds.alpha, bucket, 1));
  }, SCENARIO_TIMEOUT_MS);

  it("expires at most 50 checkouts per job and continues with the rest (OADR-0014 point 2)", async () => {
    expect(resultOf(first)).toEqual(
      done("alpha", CHECKOUTS_EXPIRE_JOB, expiryCounts(JOB_BATCH_LIMITS.checkoutExpiry, 0), true),
    );
    expect(resultOf(continuation)).toEqual(done("alpha", CHECKOUTS_EXPIRE_JOB, expiryCounts(2, 0)));
    for (const id of due) {
      expect((await checkoutOf("alpha", id)).status).toBe("expired");
    }
  });
});

describe("checkouts.expire: the voids of checkouts an earlier run expired", () => {
  /** Expired by an earlier run 2 hours ago, whose void was never queued (the add was lost after its commit). */
  let lost: { checkoutId: string; payment: SeededPayment };
  /** Expired just over a day ago (VOID_LOOKBACK_MS), still authorised: the staff's now (the authorisation watch). */
  let stale: { checkoutId: string; payment: SeededPayment };
  /** Expired 2 hours ago, its authorised payment paying for an order that stands (a ticketed booking). */
  let booked: { checkoutId: string; bookingId: string; payment: SeededPayment };
  let run: RunJobs;
  let lostVoid: Job;

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    clock.advance(HOUR_MS);
    const expiredAgo = (ms: number): Promise<string> =>
      insertCheckout("alpha", { status: "expired", expiresInMs: -ms - MINUTE_MS, updatedInMs: -ms });
    const lostCheckout = await expiredAgo(2 * HOUR_MS);
    lost = {
      checkoutId: lostCheckout,
      payment: await insertPayment("alpha", { checkoutId: lostCheckout, status: "authorized" }),
    };
    const staleCheckout = await expiredAgo(VOID_LOOKBACK_MS + MINUTE_MS);
    stale = {
      checkoutId: staleCheckout,
      payment: await insertPayment("alpha", { checkoutId: staleCheckout, status: "authorized" }),
    };
    const bookedCheckout = await expiredAgo(2 * HOUR_MS);
    const ticketed = await insertBooking("alpha", { status: "ticketed", checkoutId: null });
    booked = {
      checkoutId: bookedCheckout,
      bookingId: ticketed,
      payment: await insertPayment("alpha", {
        checkoutId: bookedCheckout,
        status: "authorized",
        bookingId: ticketed,
      }),
    };
    run = await iteration(CHECKOUTS_EXPIRE_JOB);
    lostVoid = await finished(payments, voidJobId(lost.payment.id));
  }, SCENARIO_TIMEOUT_MS);

  it("queues the void of a checkout an earlier run expired whose enqueue was lost, and it runs once", async () => {
    // Nothing is due: the run only asks for the one void that is missing.
    expect(resultOf(run.alpha)).toEqual(done("alpha", CHECKOUTS_EXPIRE_JOB, expiryCounts(0, 1)));
    expect(resultOf(run.beta)).toEqual(done("beta", CHECKOUTS_EXPIRE_JOB, expiryCounts(0, 0)));
    expect(lostVoid.returnvalue).toMatchObject({ id: lost.payment.id, outcome: "applied" });
    expect(cancelsOf(lost.payment.intentId)).toHaveLength(1);
    expect(await paymentOf("alpha", lost.payment.id)).toMatchObject({ status: "canceled" });
    expect(await checkoutOf("alpha", lost.checkoutId)).toMatchObject({ status: "expired", version: 3 });
  });

  it("never voids the payment of a checkout that expired more than a day ago, or one that pays for an order", async () => {
    for (const payment of [stale.payment, booked.payment]) {
      expect(await payments.getJobState(voidJobId(payment.id))).toBe("unknown");
      expect(cancelsOf(payment.intentId)).toEqual([]);
      expect(await paymentOf("alpha", payment.id)).toMatchObject({ status: "authorized" });
    }
    expect(await paymentOf("alpha", booked.payment.id)).toMatchObject({ bookingId: booked.bookingId });
  });
});

// ---- retention.daily ----------------------------------------------------------------------------------------------

/** The tables the retention purges, by the name of their count. */
type PurgedTable = keyof RetentionCounts;

/** Rows of one tenant, by table: those past their limit and those within it. */
interface RetentionSeed {
  readonly purged: Record<PurgedTable, string[]>;
  readonly kept: Record<PurgedTable, string[]>;
  /** Values that must never reach a log line (ids, hashes). */
  readonly secrets: string[];
}

const PURGED_TABLES: Record<PurgedTable, string> = {
  supplierRequests: "supplier_requests",
  queueSnapshots: "queue_snapshots",
  idempotencyKeys: "idempotency_keys",
  customerSessions: "customer_sessions",
  passwordResets: "customer_password_resets",
  bookingAccessTokens: "booking_access_tokens",
};

/** The financial and audit tables the retention never deletes from (data-model §6). */
const KEPT_TABLES = [
  "bookings",
  "payments",
  "refunds",
  "booking_events",
  "payment_events",
  "booking_documents",
  "staff_actions",
] as const;

/** Every row of the kept tables of `tenant` as JSON, by table, in id order. */
async function keptTablesOf(tenant: TenantKey): Promise<Record<string, unknown[]>> {
  return await txOf(tenant)(async (trx) => {
    const tables: Record<string, unknown[]> = {};
    for (const table of KEPT_TABLES) {
      const { rows } = await sql<{ row: unknown }>`
        SELECT to_jsonb(t) AS row FROM ${sql.table(table)} AS t ORDER BY t.id
      `.execute(trx);
      tables[table] = rows.map((entry) => entry.row);
    }
    return tables;
  });
}

/** Which of `ids` are still in the table of `name`. */
async function remainingOf(tenant: TenantKey, name: PurgedTable, ids: readonly string[]): Promise<string[]> {
  const { rows } = await txOf(tenant)((trx) =>
    sql<{ id: string }>`
      SELECT id FROM ${sql.table(PURGED_TABLES[name])} WHERE id = ANY(${[...ids]}) ORDER BY id
    `.execute(trx),
  );
  return rows.map((row) => row.id);
}

/**
 * The rows of one tenant for a retention run at the clock's instant: per table one row past the limit and one within
 * it (a day or a minute on either side; of each environment for the supplier requests and queue snapshots, whose
 * indexes lead with it), and old financial and audit rows that must stay: a ticketed booking of 400
 * days ago with its captured payment, a refund, both kinds of events (the booking event names the purged supplier
 * request), a document and a staff action.
 */
async function seedRetention(tenant: TenantKey): Promise<RetentionSeed> {
  const now = clock.now();
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  const purged: Record<PurgedTable, string[]> = {
    supplierRequests: [],
    queueSnapshots: [],
    idempotencyKeys: [],
    customerSessions: [],
    passwordResets: [],
    bookingAccessTokens: [],
  };
  const kept: Record<PurgedTable, string[]> = {
    supplierRequests: [],
    queueSnapshots: [],
    idempotencyKeys: [],
    customerSessions: [],
    passwordResets: [],
    bookingAccessTokens: [],
  };
  const secrets: string[] = [];
  await txOf(tenant)(async (trx) => {
    const supplierRequest = async (
      createdAt: Date,
      environment: "test" | "live" = "test",
    ): Promise<string> => {
      const id = newId("sreq");
      await trx
        .insertInto("supplier_requests")
        .values({
          id,
          environment,
          operation: "bookings.get",
          amadeus_api: "FlightOrderManagement",
          amadeus_operation_id: "getFlightOrder",
          http_method: "GET",
          path: "/v1/booking/flight-orders/eJzTd9f3NjIwsQQACwsCVA",
          http_status: 200,
          outcome: "success",
          duration_ms: 420,
          created_at: createdAt,
          updated_at: createdAt,
        })
        .execute();
      return id;
    };
    const oldRequest = await supplierRequest(ago(91 * DAY_MS));
    // Both environments: the purge names both, the leading column of their per-environment indexes.
    purged.supplierRequests.push(oldRequest, await supplierRequest(ago(91 * DAY_MS), "live"));
    kept.supplierRequests.push(
      await supplierRequest(ago(89 * DAY_MS)),
      await supplierRequest(ago(89 * DAY_MS), "live"),
    );

    const snapshot = async (
      fetchedAt: Date,
      supplierRequestId: string | null,
      environment: "test" | "live" = "test",
    ): Promise<string> => {
      const id = newId("qsn");
      await trx
        .insertInto("queue_snapshots")
        .values({
          id,
          environment,
          office_id: "MADVX38AA",
          queue_id: 50,
          item_count: 0,
          response: JSON.stringify({ data: [], meta: { count: 0 } }),
          supplier_request_id: supplierRequestId,
          fetched_at: fetchedAt,
          created_at: fetchedAt,
          updated_at: fetchedAt,
        })
        .execute();
      return id;
    };
    purged.queueSnapshots.push(
      await snapshot(ago(31 * DAY_MS), oldRequest),
      await snapshot(ago(31 * DAY_MS), null, "live"),
    );
    kept.queueSnapshots.push(
      await snapshot(ago(29 * DAY_MS), null),
      await snapshot(ago(29 * DAY_MS), null, "live"),
    );

    const idempotencyKey = async (expiresAt: Date): Promise<string> => {
      const id = newId("idk");
      await trx
        .insertInto("idempotency_keys")
        .values({
          id,
          scope: `test:key_retention:checkouts.create`,
          key: `retention-${id}`,
          request_method: "POST",
          request_path: "/v1/checkouts",
          request_hash: hash(),
          status: "completed",
          response_status: 201,
          expires_at: expiresAt,
          created_at: new Date(expiresAt.getTime() - DAY_MS),
        })
        .execute();
      return id;
    };
    purged.idempotencyKeys.push(await idempotencyKey(ago(MINUTE_MS)));
    kept.idempotencyKeys.push(await idempotencyKey(new Date(now.getTime() + DAY_MS)));

    const customerId = newId("cus");
    await trx
      .insertInto("customers")
      .values({ id: customerId, email: `retention-${randomBytes(6).toString("hex")}@example.com` })
      .execute();
    const session = async (expiresAt: Date): Promise<string> => {
      const id = newId("ses");
      const tokenHash = hash();
      secrets.push(tokenHash);
      await trx
        .insertInto("customer_sessions")
        .values({
          id,
          customer_id: customerId,
          refresh_token_hash: tokenHash,
          family_id: newId("fam"),
          family_expires_at: expiresAt,
          expires_at: expiresAt,
          created_at: new Date(expiresAt.getTime() - 12 * HOUR_MS),
        })
        .execute();
      return id;
    };
    purged.customerSessions.push(await session(ago(8 * DAY_MS)));
    kept.customerSessions.push(
      await session(ago(6 * DAY_MS)),
      await session(new Date(now.getTime() + HOUR_MS)),
    );

    const reset = async (expiresAt: Date): Promise<string> => {
      const id = newId("pwr");
      const tokenHash = hash();
      secrets.push(tokenHash);
      await trx
        .insertInto("customer_password_resets")
        .values({ id, customer_id: customerId, token_hash: tokenHash, expires_at: expiresAt })
        .execute();
      return id;
    };
    purged.passwordResets.push(await reset(ago(8 * DAY_MS)));
    kept.passwordResets.push(await reset(ago(6 * DAY_MS)));

    // The old financial and audit rows.
    const bookingId = await insertBooking(tenant, { status: "ticketed", createdAt: ago(400 * DAY_MS) }, trx);
    const token = async (expiresAt: Date): Promise<string> => {
      const id = newId("bat");
      const tokenHash = hash();
      secrets.push(tokenHash);
      await trx
        .insertInto("booking_access_tokens")
        .values({
          id,
          booking_id: bookingId,
          token_hash: tokenHash,
          issued_via: "booking_created",
          expires_at: expiresAt,
        })
        .execute();
      return id;
    };
    purged.bookingAccessTokens.push(await token(ago(8 * DAY_MS)));
    kept.bookingAccessTokens.push(
      await token(ago(6 * DAY_MS)),
      await token(new Date(now.getTime() + DAY_MS)),
    );

    const paymentId = newId("pay");
    await trx
      .insertInto("payments")
      .values({
        id: paymentId,
        environment: "test",
        booking_id: bookingId,
        provider: "stripe",
        provider_payment_id: stripeId("pi"),
        currency: "EUR",
        amount: "440.00",
        amount_authorized: "440.00",
        amount_captured: "440.00",
        amount_refunded: "40.00",
        status: "partially_refunded",
        authorized_at: ago(400 * DAY_MS),
        captured_at: ago(400 * DAY_MS),
        created_at: ago(400 * DAY_MS),
        updated_at: ago(399 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("refunds")
      .values({
        id: newId("rfd"),
        payment_id: paymentId,
        booking_id: bookingId,
        currency: "EUR",
        amount: "40.00",
        reason: "goodwill",
        status: "succeeded",
        requested_by_type: "staff",
        processed_at: ago(399 * DAY_MS),
        created_at: ago(399 * DAY_MS),
        updated_at: ago(399 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("payment_events")
      .values({
        id: newId("pev"),
        payment_id: paymentId,
        type: "payment.captured",
        source: "system",
        payload: JSON.stringify({}),
        created_at: ago(400 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("booking_events")
      .values({
        id: newId("evt"),
        booking_id: bookingId,
        type: "booking.synced",
        actor_type: "system",
        summary: "Booking synchronised with the airline.",
        supplier_request_id: oldRequest,
        visible_to_customer: false,
        created_at: ago(91 * DAY_MS),
        updated_at: ago(91 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("booking_documents")
      .values({
        id: newId("doc"),
        booking_id: bookingId,
        kind: "itinerary",
        file_name: "itinerary.pdf",
        storage_key: `tenant_${tenant}/documents/${newId("doc")}.pdf`,
        content_hash: hash(),
        created_at: ago(400 * DAY_MS),
        updated_at: ago(400 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("staff_actions")
      .values({
        id: newId("sact"),
        actor_type: "system",
        action: "booking.note",
        target_type: "booking",
        target_id: bookingId,
        booking_id: bookingId,
        outcome: "succeeded",
        created_at: ago(400 * DAY_MS),
        updated_at: ago(400 * DAY_MS),
      })
      .execute();
  });
  for (const table of Object.keys(purged) as PurgedTable[]) {
    secrets.push(...purged[table]);
  }
  return { purged, kept, secrets };
}

const retentionCounts = (overrides: Partial<RetentionCounts> = {}): RetentionCounts => ({
  supplierRequests: 0,
  queueSnapshots: 0,
  idempotencyKeys: 0,
  customerSessions: 0,
  passwordResets: 0,
  bookingAccessTokens: 0,
  ...overrides,
});

describe("retention.daily: what it deletes", () => {
  const seeds = {} as Record<TenantKey, RetentionSeed>;
  let keptBefore: Record<string, unknown[]>;
  let keptAfter: Record<string, unknown[]>;
  /** The booking event that named the purged supplier request. */
  let linkedEvent: string;
  let run: RunJobs;

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    clock.advance(HOUR_MS);
    seeds.alpha = await seedRetention("alpha");
    seeds.beta = await seedRetention("beta");
    const oldRequest = seeds.alpha.purged.supplierRequests[0] ?? "";
    linkedEvent = await txOf("alpha")(async (trx) => {
      const row = await trx
        .selectFrom("booking_events")
        .select("id")
        .where("supplier_request_id", "=", oldRequest)
        .executeTakeFirstOrThrow();
      return row.id;
    });
    keptBefore = await keptTablesOf("alpha");
    run = await iteration(RETENTION_JOB);
    keptAfter = await keptTablesOf("alpha");
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-056 AC3] deletes only the rows past their limits, for active and suspended tenants", async () => {
    // Exact per tenant: a job that reached the other tenant's rows would count them.
    const perTenant = retentionCounts({
      supplierRequests: 2,
      queueSnapshots: 2,
      idempotencyKeys: 1,
      customerSessions: 1,
      passwordResets: 1,
      bookingAccessTokens: 1,
    });
    expect(resultOf(run.alpha)).toEqual(done("alpha", RETENTION_JOB, perTenant));
    expect(resultOf(run.beta)).toEqual(done("beta", RETENTION_JOB, perTenant));
    for (const tenant of ["alpha", "beta"] as const) {
      for (const table of Object.keys(PURGED_TABLES) as PurgedTable[]) {
        const { purged, kept } = seeds[tenant];
        expect(
          await remainingOf(tenant, table, [...purged[table], ...kept[table]]),
          `${tenant} ${table}`,
        ).toEqual([...kept[table]].sort());
      }
    }
  });

  it("[OBE-056 AC3] never touches bookings, payments, refunds, events, documents or staff actions", () => {
    // Every row stays as it was; the booking event that named a purged supplier request only loses that link, by
    // the baseline's foreign key (ON DELETE SET NULL).
    const expected = structuredClone(keptBefore);
    for (const event of expected["booking_events"] ?? []) {
      const row = event as { id: string; supplier_request_id: string | null };
      if (row.id === linkedEvent) {
        row.supplier_request_id = null;
      }
    }
    expect(keptAfter).toEqual(expected);
    for (const table of KEPT_TABLES) {
      expect(keptAfter[table]?.length ?? 0, table).toBeGreaterThan(0);
    }
  });

  it("logs the counts per table with the tenant, never an id or a token hash", () => {
    expect(sink.records()).toContainEqual(
      expect.objectContaining({
        msg: "retention.purged",
        tenantId: tenantIds.beta,
        supplierRequests: 2,
        bookingAccessTokens: 1,
        more: false,
      }),
    );
    const logged = sink.text();
    for (const secret of [...seeds.alpha.secrets, ...seeds.beta.secrets]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("retention.daily: batches", () => {
  /** More expired idempotency records than one job deletes. */
  const BACKLOG = RETENTION_BATCH * (RETENTION_BATCHES_PER_JOB + 1) + 5;
  const SCOPE = "test:key_backlog:checkouts.create";
  let firstBatch: number;
  let first: Job;
  let beta: Job;
  let continuation: Job;
  let left: number;

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    clock.advance(HOUR_MS);
    const expired = new Date(clock.now().getTime() - MINUTE_MS);
    const created = new Date(expired.getTime() - DAY_MS);
    // One statement for the backlog: ids of the `idk_` shape, one key each.
    await txOf("alpha")((trx) =>
      sql`
        INSERT INTO idempotency_keys
          (id, scope, key, request_method, request_path, request_hash, status, response_status, expires_at,
           created_at, updated_at)
        SELECT 'idk_' || lpad(i::text, 26, '0'), ${SCOPE}, 'backlog-' || i, 'POST', '/v1/checkouts',
               repeat('0', 64), 'completed', 201, ${expired}, ${created}, ${created}
        FROM generate_series(1, ${BACKLOG}::int) AS i
      `.execute(trx),
    );
    // One statement deletes one batch.
    firstBatch = await txOf("alpha")((trx) =>
      new RetentionRepository().idempotencyKeys(trx, clock.now(), RETENTION_BATCH),
    );
    const bucket = minuteBucket(clock.now());
    const jobs = await iteration(RETENTION_JOB);
    first = jobs.alpha;
    beta = jobs.beta;
    continuation = await finished(maintenance, tenantJobId(RETENTION_JOB, tenantIds.alpha, bucket, 1));
    left = Number(
      (
        await txOf("alpha")((trx) =>
          trx
            .selectFrom("idempotency_keys")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("scope", "=", SCOPE)
            .executeTakeFirstOrThrow(),
        )
      ).count,
    );
  }, SCENARIO_TIMEOUT_MS);

  it("deletes 1 000 rows per statement and 10 batches per table per job, then continues (OADR-0014 point 2)", () => {
    expect(firstBatch).toBe(RETENTION_BATCH);
    expect(resultOf(first)).toEqual(
      done(
        "alpha",
        RETENTION_JOB,
        retentionCounts({ idempotencyKeys: RETENTION_BATCH * RETENTION_BATCHES_PER_JOB }),
        true,
      ),
    );
    expect(resultOf(beta)).toEqual(done("beta", RETENTION_JOB, retentionCounts()));
    expect(resultOf(continuation)).toEqual(
      done("alpha", RETENTION_JOB, retentionCounts({ idempotencyKeys: 5 })),
    );
    expect(left).toBe(0);
  });
});
