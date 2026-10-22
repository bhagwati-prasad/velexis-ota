// The Velexis Stripe account's webhooks end to end (OBE-039; OADR-0010 points 4 and 5, ADR-0011 (A) "webhooks",
// architecture flow (d)), against PostgreSQL 16, Redis 7 and a fake of the Stripe API. Both processes run in-process:
//
//   - the API's module graph (createTestApp): `POST /webhooks/stripe/velexis/test` with this file's signing secret,
//     which stores each verified event as a `payment_events` row and queues `stripe.event` on `ota-stripe-events`;
//   - the worker's module graph (WorkerModule.forRoot, as dist/worker.js builds it): the `ota-stripe-events` consumer,
//     which reads each event's PaymentIntent, charge, refund or dispute again from the fake Stripe API
//     (test/helpers/fake-stripe.ts, the processes' real `stripe` clients pointed at it) and applies that state.
//
// The deliveries are the signed fixtures of @velexis/testing/stripe, changed to name this file's tenant, payments and
// Stripe objects, and signed with a secret built at run time (types without a fixture are signed the same way, with
// Stripe's own `generateTestHeaderString`). The platform rows are written as the platform does (velexis_migrator), the
// payments, refunds and storefront settings straight into `tenant_alpha`. Each scenario runs in its `beforeAll` hook,
// which delivers and waits for the worker with a budget of its own; its tests read what it left. Every answer is checked
// against the OTA document (`expectResponseToMatch`). FIX-W25-BOOKINGS (lead decision of 2026-10-21: checkout, booking,
// payment, refund): a refund event's transaction locks the payment before its refunds, proven with a second
// transaction that holds the payment (test/helpers/lock-order.ts).
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
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { signedStripeEvent, stripeFixture, STRIPE_SIGNATURE_HEADER } from "@velexis/testing/stripe";
import type { Job, Queue } from "bullmq";
import Stripe from "stripe";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
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
  probeRowLockOrder,
  type RowLockOrderObservation,
  type RowLockOrderProbe,
} from "../../helpers/lock-order";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/**
 * Cloning the template, starting the API's graph (it parses the OTA document) and the worker's (BullMQ connections,
 * the scheduler registration): a few seconds alone, more while every package's integration tests run on a 4-CPU CI
 * runner. The bound only stops a start-up that hangs.
 */
const SETUP_TIMEOUT_MS = 90_000;
/** A scenario delivers a few events and waits for the worker each time; the bound only stops one that hangs. */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for the worker. */
const WAIT_MS = 20_000;

const WEBHOOK = "/webhooks/stripe/velexis/test";
const OPS_ALERT_EMAIL = "ops-alerts@alpha-travel.example";

/** This run's signing secret and Velexis test keys: Stripe's shapes, random, never a committed value. */
const SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

const quietPoolLogger = { error: (): void => undefined };

let db: TestDatabase;
let redis: TestRedis;
let stripe: FakeStripe;
let api: TestApp;
let worker: INestApplicationContext;
const workerSink = new MemorySink();
let migratorPool: ReturnType<typeof createPool>;
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let stripeEvents: Queue;
let alphaId: string;
let betaId: string;

const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", run);
const betaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_beta", run);

/** A fresh Stripe-shaped id of this run (`pi_test_…`, `evt_test_…`). */
const stripeId = (prefix: string): string => `${prefix}_test_${randomBytes(10).toString("hex")}`;

async function insertTenant(key: "alpha" | "beta"): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  return id;
}

interface PaymentSeed {
  readonly status: string;
  readonly intentId: string;
  readonly amountAuthorized?: string;
  readonly amountCaptured?: string;
  /** The card a confirmed payment shows already. */
  readonly cardLast4?: string;
}

/** A Stripe card payment of 452.10 EUR in `tenant_alpha`, as checkout.createPayment leaves it, in `status`. */
async function insertPayment(seed: PaymentSeed): Promise<string> {
  const id = newId("pay");
  await alphaTx(async (trx) => {
    await trx
      .insertInto("payments")
      .values({
        id,
        environment: "test",
        provider: "stripe",
        provider_connection_id: newId("ppc"),
        provider_payment_id: seed.intentId,
        method: "card",
        capture_method: "manual",
        currency: "EUR",
        amount: "452.10",
        amount_authorized: seed.amountAuthorized ?? "0",
        amount_captured: seed.amountCaptured ?? "0",
        card_last4: seed.cardLast4 ?? null,
        status: seed.status,
        three_ds: JSON.stringify({ required: false, status: "not_required", version: null }),
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
    status: "requires_payment_method",
    amount: 45210,
    amount_capturable: 0,
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

/** The Velexis metadata of tenant alpha's payment, as the gateway writes it on every PaymentIntent. */
const metadataOf = (paymentId: string): Record<string, string> => ({
  velexis_tenant_id: alphaId,
  velexis_environment: "test",
  payment_id: paymentId,
});

/** Posts a signed delivery as Stripe does: the exact signed bytes and `Stripe-Signature`. */
async function deliver(payload: string, header: string): Promise<request.Response> {
  return await request(api.server)
    .post(WEBHOOK)
    .set(STRIPE_SIGNATURE_HEADER, header)
    .set("Content-Type", "application/json; charset=utf-8")
    .send(payload);
}

/** Signs an event of a type without a fixture (payment_intent.canceled, charge.refund.updated) as Stripe would. */
function signed(event: Record<string, unknown>): { payload: string; header: string } {
  const payload = JSON.stringify({ created: Math.floor(Date.now() / 1000), ...event }, null, 2);
  return { payload, header: Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) };
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

/** Waits until the job of a Stripe event has finished (completed or failed) and answers it. */
async function finishedJob(eventId: string): Promise<Job> {
  return await waitFor(`the job of ${eventId}`, async () => {
    const job = await stripeEvents.getJob(eventId);
    if (job === undefined) {
      return undefined;
    }
    const state = await job.getState();
    return state === "completed" || state === "failed" ? job : undefined;
  });
}

/** The jobs of `ota-stripe-events` in every state. */
async function allJobs(): Promise<Job[]> {
  return await stripeEvents.getJobs(["completed", "failed", "active", "waiting", "delayed", "prioritized"]);
}

/** The jobs of `ota-stripe-events` whose id is `eventId`, whatever their state. */
async function jobsOf(eventId: string): Promise<Job[]> {
  return (await allJobs()).filter((job) => job.id === eventId);
}

interface PaymentState {
  readonly status: string;
  readonly version: number;
  readonly amountAuthorized: string;
  readonly amountCaptured: string;
  readonly amountRefunded: string;
  readonly cardLast4: string | null;
}

async function paymentOf(id: string): Promise<PaymentState> {
  return await alphaTx(
    async (trx) =>
      await trx
        .selectFrom("payments")
        .select([
          "status",
          "version",
          "card_last4 as cardLast4",
          sql<string>`amount_authorized::text`.as("amountAuthorized"),
          sql<string>`amount_captured::text`.as("amountCaptured"),
          sql<string>`amount_refunded::text`.as("amountRefunded"),
        ])
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
  );
}

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly providerEventId: string | null;
  readonly payload: Record<string, unknown>;
}

/** The payment events of a payment in `tenant`, oldest first. */
async function eventsOf(paymentId: string, tenant: "alpha" | "beta" = "alpha"): Promise<EventRow[]> {
  const run = tenant === "alpha" ? alphaTx : betaTx;
  return await run(
    async (trx) =>
      (await trx
        .selectFrom("payment_events")
        .select(["id", "type", "source", "provider_event_id as providerEventId", "payload"])
        .where("payment_id", "=", paymentId)
        .orderBy("created_at")
        .orderBy("id")
        .execute()) as EventRow[],
  );
}

/** The payment events of a Stripe event id in `tenant` (any payment). */
async function rowsOfStripeEvent(eventId: string, tenant: "alpha" | "beta"): Promise<number> {
  const run = tenant === "alpha" ? alphaTx : betaTx;
  return await run(async (trx) => {
    const row = await trx
      .selectFrom("payment_events")
      .select(sql<number>`count(*)::int`.as("n"))
      .where(sql<boolean>`provider_event_id = ${eventId} or payload ->> 'providerEventId' = ${eventId}`)
      .executeTakeFirstOrThrow();
    return row.n;
  });
}

/** The GET requests the fake Stripe API received for `path`. */
const readsOf = (path: string): number =>
  stripe.requests.filter((entry) => entry.method === "GET" && entry.path === path).length;

beforeAll(() => {
  preloadOpenApiDocument();
  // The response validators compile on their first check: here, with every status the tests check, not in a test.
  const checker = responseChecker("ota");
  for (const status of [200, 400]) {
    checker.check("receiveStripeVelexisWebhook", { status, body: {} });
  }
}, OPENAPI_SETUP_TIMEOUT_MS);

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
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alphaId = await insertTenant("alpha");
  betaId = await insertTenant("beta");
  // Alpha's settings as the provisioning seed writes them, with the alert address an OTA sets in its admin.
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await trx.updateTable("storefront_settings").set({ ops_alert_email: OPS_ALERT_EMAIL }).execute();
  });
  const keys = { STRIPE_SECRET_KEY_TEST: SECRET_KEY, STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY };

  api = await createTestApp({
    database: db,
    redis,
    env: { ...keys, STRIPE_WEBHOOK_SECRET_VELEXIS_TEST: SECRET },
    imports: [stripeEndpointModule(stripe.endpoint)],
  });

  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    ...keys,
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
  stripeEvents = worker.get<Queue>(getQueueToken(OTA_QUEUE.stripeEvents), { strict: false });
  // No scheduler iteration may fire while the file runs.
  const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await stripe?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
}, SETUP_TIMEOUT_MS);

describe("an authorisation delivered twice", () => {
  let paymentId: string;
  let intentId: string;
  let eventId: string;
  let answers: request.Response[];
  let versionBefore: number;

  beforeAll(async () => {
    intentId = stripeId("pi");
    eventId = stripeId("evt");
    paymentId = await insertPayment({ status: "requires_action", intentId });
    versionBefore = (await paymentOf(paymentId)).version;
    putIntent(intentId, paymentId, { status: "requires_capture", amount_capturable: 45210 });
    const { payload, header } = signedStripeEvent(
      "payment_intent.amount_capturable_updated",
      { id: eventId, data: { object: { id: intentId, metadata: metadataOf(paymentId) } } },
      SECRET,
    );
    answers = [await deliver(payload, header)];
    await finishedJob(eventId);
    answers.push(await deliver(payload, header));
    await finishedJob(eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("answers 200 {received: true} both times, as the OTA document says [OBE-039 AC1]", () => {
    for (const res of answers) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(res.headers["cache-control"]).toBe("no-store");
      expectResponseToMatch("receiveStripeVelexisWebhook", res);
    }
  });

  it("stores the event once, as a webhook row with its Stripe id and no client secret [OBE-039 AC1]", async () => {
    const stored = (await eventsOf(paymentId)).filter((row) => row.providerEventId === eventId);

    expect(stored).toEqual([
      expect.objectContaining({
        type: "webhook.payment_intent.amount_capturable_updated",
        source: "webhook",
        providerEventId: eventId,
      }),
    ]);
    expect(stored[0]?.payload).toMatchObject({ endpoint: "velexis", object: { id: intentId } });
    expect(JSON.stringify(stored)).not.toContain("_secret_");
  });

  it("queues one job, whose id is the Stripe event id, and processes it once [OBE-039 AC1]", async () => {
    const jobs = await jobsOf(eventId);
    const paymentEventId = (await eventsOf(paymentId)).find((row) => row.providerEventId === eventId)?.id;

    expect(jobs).toHaveLength(1);
    // No second job under another id either: the stored event has exactly one job in the whole queue.
    expect(
      (await allJobs()).filter(
        (job) => (job.data as { paymentEventId?: unknown } | undefined)?.paymentEventId === paymentEventId,
      ),
    ).toHaveLength(1);
    expect(jobs[0]?.name).toBe("stripe.event");
    expect(jobs[0]?.data).toEqual({ tenantId: alphaId, paymentEventId });
    expect(await jobs[0]?.getState()).toBe("completed");
    expect(jobs[0]?.returnvalue).toMatchObject({
      outcome: "applied",
      type: "payment_intent.amount_capturable_updated",
    });
    // Processed once: one read of the PaymentIntent, one state change, one version step.
    expect(readsOf(`/v1/payment_intents/${intentId}`)).toBe(1);
    expect((await eventsOf(paymentId)).filter((row) => row.type === "payment.authorized")).toHaveLength(1);
    expect(await paymentOf(paymentId)).toEqual({
      status: "authorized",
      version: versionBefore + 1,
      amountAuthorized: "452.10",
      amountCaptured: "0.00",
      amountRefunded: "0.00",
      cardLast4: "4242",
    });
  });
});

describe("deliveries that are refused or acknowledged without effect", () => {
  let paymentId: string;
  let tampered: request.Response;
  let unknownTenant: request.Response;
  let otherTenant: request.Response;
  let live: request.Response;
  let unknownEventId: string;
  let otherTenantEventId: string;
  let liveEventId: string;
  let tamperedEventId: string;

  beforeAll(async () => {
    const intentId = stripeId("pi");
    paymentId = await insertPayment({ status: "requires_action", intentId });
    putIntent(intentId, paymentId, { status: "requires_capture", amount_capturable: 45210 });
    tamperedEventId = stripeId("evt");
    unknownEventId = stripeId("evt");
    otherTenantEventId = stripeId("evt");
    liveEventId = stripeId("evt");

    const original = signedStripeEvent(
      "payment_intent.amount_capturable_updated",
      { id: tamperedEventId, data: { object: { id: intentId, metadata: metadataOf(paymentId) } } },
      SECRET,
    );
    const changed = original.payload.replace('"amount_capturable": 45210', '"amount_capturable": 1');
    expect(changed).not.toBe(original.payload);
    tampered = await deliver(changed, original.header);

    const unknown = signedStripeEvent(
      "payment_intent.succeeded",
      {
        id: unknownEventId,
        data: {
          object: { id: intentId, metadata: { ...metadataOf(paymentId), velexis_tenant_id: newId("ten") } },
        },
      },
      SECRET,
    );
    unknownTenant = await deliver(unknown.payload, unknown.header);

    // Tenant beta's id with tenant alpha's payment: looked up in beta only, where it does not exist.
    const forged = signedStripeEvent(
      "payment_intent.succeeded",
      {
        id: otherTenantEventId,
        data: { object: { id: intentId, metadata: { ...metadataOf(paymentId), velexis_tenant_id: betaId } } },
      },
      SECRET,
    );
    otherTenant = await deliver(forged.payload, forged.header);

    const livemode = signedStripeEvent(
      "payment_intent.succeeded",
      {
        id: liveEventId,
        livemode: true,
        data: { object: { id: intentId, livemode: true, metadata: metadataOf(paymentId) } },
      },
      SECRET,
    );
    live = await deliver(livemode.payload, livemode.header);
  }, SCENARIO_TIMEOUT_MS);

  it("answers 400 INVALID_REQUEST to a payload changed after signing, and stores nothing [OBE-039 AC2]", async () => {
    expect(tampered.status).toBe(400);
    expect(tampered.body).toMatchObject({
      error: { code: "INVALID_REQUEST", details: { reason: "signature_invalid" } },
    });
    expectResponseToMatch("receiveStripeVelexisWebhook", tampered);
    expect(await rowsOfStripeEvent(tamperedEventId, "alpha")).toBe(0);
    expect(await jobsOf(tamperedEventId)).toEqual([]);
  });

  it("answers 200 to an event of an unknown tenant and writes nothing in any schema [OBE-039 AC2]", async () => {
    expect(unknownTenant.status).toBe(200);
    expect(unknownTenant.body).toEqual({ received: true });
    expectResponseToMatch("receiveStripeVelexisWebhook", unknownTenant);
    expect(await rowsOfStripeEvent(unknownEventId, "alpha")).toBe(0);
    expect(await rowsOfStripeEvent(unknownEventId, "beta")).toBe(0);
    expect(await jobsOf(unknownEventId)).toEqual([]);
  });

  it("never writes tenant alpha's payment into tenant beta, nor beta's event into alpha", async () => {
    expect(otherTenant.status).toBe(200);
    expect(await rowsOfStripeEvent(otherTenantEventId, "alpha")).toBe(0);
    expect(await rowsOfStripeEvent(otherTenantEventId, "beta")).toBe(0);
    expect(await jobsOf(otherTenantEventId)).toEqual([]);
  });

  it("answers 200 to a livemode event on the test endpoint, writes nothing and logs a security event [OBE-039 AC3]", async () => {
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ received: true });
    expect(await rowsOfStripeEvent(liveEventId, "alpha")).toBe(0);
    expect(await jobsOf(liveEventId)).toEqual([]);
    const security = api.sink
      .records()
      .filter(
        (line) => line["securityEvent"] === "payments.webhook_mismatch" && line["eventId"] === liveEventId,
      );
    expect(security).toEqual([
      expect.objectContaining({ check: "livemode", endpoint: "velexis/test", level: 40 }),
    ]);
    // Logged without the payload.
    expect(JSON.stringify(security)).not.toContain("_secret_");
    expect(await paymentOf(paymentId)).toMatchObject({ status: "requires_action", version: 1 });
  });

  it("logs no signing secret, signature, client secret or Stripe key", () => {
    const logged = `${api.sink.text()}\n${workerSink.text()}`;
    for (const secret of [SECRET, SECRET_KEY, "_secret_", "v1="]) {
      expect([secret, logged.includes(secret)]).toEqual([secret, false]);
    }
  });
});

describe("an event whose body is stale", () => {
  let lateAuthorisation: { paymentId: string; eventId: string };
  let lateOnCaptured: { paymentId: string; eventId: string };

  beforeAll(async () => {
    // Stripe has captured the payment since the event was created; its body still says requires_capture.
    const intentId = stripeId("pi");
    lateAuthorisation = {
      paymentId: await insertPayment({ status: "requires_action", intentId }),
      eventId: stripeId("evt"),
    };
    putIntent(intentId, lateAuthorisation.paymentId, { status: "succeeded", amount_received: 45210 });
    const stale = signedStripeEvent(
      "payment_intent.amount_capturable_updated",
      {
        id: lateAuthorisation.eventId,
        data: { object: { id: intentId, metadata: metadataOf(lateAuthorisation.paymentId) } },
      },
      SECRET,
    );
    expect((await deliver(stale.payload, stale.header)).status).toBe(200);
    await finishedJob(lateAuthorisation.eventId);

    // The same late event for a payment the row already shows captured: nothing moves back.
    const capturedIntent = stripeId("pi");
    lateOnCaptured = {
      paymentId: await insertPayment({
        status: "captured",
        intentId: capturedIntent,
        amountAuthorized: "452.10",
        amountCaptured: "452.10",
        cardLast4: "4242",
      }),
      eventId: stripeId("evt"),
    };
    putIntent(capturedIntent, lateOnCaptured.paymentId, { status: "succeeded", amount_received: 45210 });
    const late = signedStripeEvent(
      "payment_intent.amount_capturable_updated",
      {
        id: lateOnCaptured.eventId,
        data: { object: { id: capturedIntent, metadata: metadataOf(lateOnCaptured.paymentId) } },
      },
      SECRET,
    );
    expect((await deliver(late.payload, late.header)).status).toBe(200);
    await finishedJob(lateOnCaptured.eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("is applied as Stripe reports it now, not as the body says [OBE-039 AC4]", async () => {
    const stored = (await eventsOf(lateAuthorisation.paymentId)).find(
      (row) => row.providerEventId === lateAuthorisation.eventId,
    );

    expect(stored?.payload).toMatchObject({ object: { status: "requires_capture" } });
    expect(await paymentOf(lateAuthorisation.paymentId)).toMatchObject({
      status: "captured",
      amountCaptured: "452.10",
      amountAuthorized: "452.10",
    });
    expect((await eventsOf(lateAuthorisation.paymentId)).map((row) => row.type)).toContain(
      "payment.captured",
    );
  });

  it("never moves a captured payment back to authorised [OBE-039 AC4]", async () => {
    expect(await paymentOf(lateOnCaptured.paymentId)).toMatchObject({ status: "captured", version: 1 });
    expect((await jobsOf(lateOnCaptured.eventId))[0]?.returnvalue).toMatchObject({ outcome: "unchanged" });
  });
});

describe("a cancellation without a fixture", () => {
  let paymentId: string;

  beforeAll(async () => {
    const intentId = stripeId("pi");
    const eventId = stripeId("evt");
    paymentId = await insertPayment({ status: "authorized", intentId, amountAuthorized: "452.10" });
    putIntent(intentId, paymentId, { status: "canceled" });
    const fixture = stripeFixture("payment_intent.succeeded");
    const { payload, header } = signed({
      ...fixture,
      id: eventId,
      type: "payment_intent.canceled",
      data: {
        object: { ...fixture.data.object, id: intentId, status: "canceled", metadata: metadataOf(paymentId) },
      },
    });
    expect((await deliver(payload, header)).status).toBe(200);
    await finishedJob(eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("cancels the authorised payment", async () => {
    expect(await paymentOf(paymentId)).toMatchObject({ status: "canceled" });
    expect((await eventsOf(paymentId)).map((row) => row.type)).toContain("payment.canceled");
  });
});

describe("a declined payment", () => {
  let paymentId: string;
  let eventId: string;

  beforeAll(async () => {
    const intentId = stripeId("pi");
    eventId = stripeId("evt");
    paymentId = await insertPayment({ status: "requires_action", intentId });
    // Stripe reports the decline with its own code now; the fixture's body says generic_decline.
    putIntent(intentId, paymentId, {
      status: "requires_payment_method",
      payment_method: null,
      last_payment_error: {
        type: "card_error",
        code: "card_declined",
        decline_code: "insufficient_funds",
        message: "Your card has insufficient funds.",
      },
    });
    const { payload, header } = signedStripeEvent(
      "payment_intent.payment_failed",
      { id: eventId, data: { object: { id: intentId, metadata: metadataOf(paymentId) } } },
      SECRET,
    );
    expect((await deliver(payload, header)).status).toBe(200);
    await finishedJob(eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("sends the payment back to requires_payment_method with the decline code Stripe reports", async () => {
    const row = await alphaTx(
      async (trx) =>
        await trx
          .selectFrom("payments")
          .select(["status", "failure_code", "failure_message", "version"])
          .where("id", "=", paymentId)
          .executeTakeFirstOrThrow(),
    );

    expect(row).toEqual({
      status: "requires_payment_method",
      failure_code: "PAYMENT_DECLINED",
      failure_message: "insufficient_funds",
      version: 2,
    });
    expect((await jobsOf(eventId))[0]?.returnvalue).toMatchObject({
      type: "payment_intent.payment_failed",
      outcome: "applied",
    });
    expect((await eventsOf(paymentId)).map((row) => row.type)).toEqual([
      "webhook.payment_intent.payment_failed",
      "payment.requires_payment_method",
    ]);
  });
});

describe("refunds", () => {
  let paymentId: string;
  let refundId: string;
  let afterRefunded: { payment: PaymentState; refund: Record<string, unknown> };
  let afterFailure: { payment: PaymentState; refund: Record<string, unknown> };
  let providerRefundId: string;

  const refundRow = async (): Promise<Record<string, unknown>> =>
    await alphaTx(
      async (trx) =>
        (await trx
          .selectFrom("refunds")
          .select(["status", "provider_refund_id", "failure_reason", "processed_at", "version"])
          .where("id", "=", refundId)
          .executeTakeFirstOrThrow()) as Record<string, unknown>,
    );

  beforeAll(async () => {
    const intentId = stripeId("pi");
    const chargeId = stripeId("ch");
    providerRefundId = stripeId("re");
    paymentId = await insertPayment({
      status: "captured",
      intentId,
      amountAuthorized: "452.10",
      amountCaptured: "452.10",
    });
    refundId = newId("rfd");
    // The refund row as `refund.submit` (OBE-040) leaves it before Stripe's answer is stored.
    await alphaTx(async (trx) => {
      await trx
        .insertInto("refunds")
        .values({
          id: refundId,
          payment_id: paymentId,
          currency: "EUR",
          amount: "100.00",
          reason: "customer_request",
          status: "pending",
          requested_by_type: "customer",
        })
        .execute();
    });
    putIntent(intentId, paymentId, { status: "succeeded", amount_received: 45210 });
    stripe.charges.set(chargeId, {
      id: chargeId,
      object: "charge",
      payment_intent: intentId,
      amount: 45210,
      amount_captured: 45210,
      amount_refunded: 10000,
      currency: "eur",
      metadata: metadataOf(paymentId),
    });
    stripe.refunds.set(providerRefundId, {
      id: providerRefundId,
      object: "refund",
      charge: chargeId,
      payment_intent: intentId,
      amount: 10000,
      currency: "eur",
      status: "succeeded",
      failure_reason: null,
      metadata: { ...metadataOf(paymentId), refund_id: refundId },
    });

    // The body says fully refunded; Stripe says 100.00 of 452.10.
    const refundedEventId = stripeId("evt");
    const refunded = signedStripeEvent(
      "charge.refunded",
      {
        id: refundedEventId,
        data: { object: { id: chargeId, payment_intent: intentId, metadata: metadataOf(paymentId) } },
      },
      SECRET,
    );
    expect((await deliver(refunded.payload, refunded.header)).status).toBe(200);
    await finishedJob(refundedEventId);
    afterRefunded = { payment: await paymentOf(paymentId), refund: await refundRow() };

    // The refund fails later: Stripe gives the money back to the charge.
    stripe.refunds.set(providerRefundId, {
      ...(stripe.refunds.get(providerRefundId) ?? { id: providerRefundId }),
      status: "failed",
      failure_reason: "expired_or_canceled_card",
    });
    stripe.charges.set(chargeId, {
      ...(stripe.charges.get(chargeId) ?? { id: chargeId }),
      amount_refunded: 0,
    });
    const updatedEventId = stripeId("evt");
    const updated = signed({
      id: updatedEventId,
      object: "event",
      api_version: Stripe.API_VERSION,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "charge.refund.updated",
      data: {
        object: {
          id: providerRefundId,
          object: "refund",
          amount: 10000,
          charge: chargeId,
          payment_intent: intentId,
          currency: "eur",
          status: "failed",
          metadata: { ...metadataOf(paymentId), refund_id: refundId },
        },
      },
    });
    expect((await deliver(updated.payload, updated.header)).status).toBe(200);
    await finishedJob(updatedEventId);
    afterFailure = { payment: await paymentOf(paymentId), refund: await refundRow() };
  }, SCENARIO_TIMEOUT_MS);

  it("record the refund's Stripe id and final state, and the refunded amount Stripe reports", () => {
    expect(afterRefunded.refund).toMatchObject({
      status: "succeeded",
      provider_refund_id: providerRefundId,
      version: 2,
    });
    expect(afterRefunded.refund["processed_at"]).toBeInstanceOf(Date);
    expect(afterRefunded.payment).toMatchObject({
      status: "partially_refunded",
      amountCaptured: "452.10",
      amountRefunded: "100.00",
    });
  });

  it("follow a refund that fails later, and the payment's refunded amount back to zero", async () => {
    expect(afterFailure.refund).toMatchObject({
      status: "failed",
      failure_reason: "expired_or_canceled_card",
    });
    expect(afterFailure.payment).toMatchObject({ status: "captured", amountRefunded: "0.00" });
    expect((await eventsOf(paymentId)).map((row) => row.type)).toEqual(
      expect.arrayContaining([
        "refund.succeeded",
        "payment.partially_refunded",
        "refund.failed",
        "payment.captured",
      ]),
    );
  });
});

describe("the lock order of a refund event (FIX-W25-BOOKINGS)", () => {
  let paymentId: string;
  let refundId: string;
  let seen: RowLockOrderObservation | undefined;
  let job: Job;

  beforeAll(async () => {
    const intentId = stripeId("pi");
    const chargeId = stripeId("ch");
    const providerRefundId = stripeId("re");
    paymentId = await insertPayment({
      status: "captured",
      intentId,
      amountAuthorized: "452.10",
      amountCaptured: "452.10",
    });
    refundId = newId("rfd");
    await alphaTx(async (trx) => {
      await trx
        .insertInto("refunds")
        .values({
          id: refundId,
          payment_id: paymentId,
          currency: "EUR",
          amount: "50.00",
          reason: "customer_request",
          status: "processing",
          provider_refund_id: providerRefundId,
          requested_by_type: "customer",
        })
        .execute();
    });
    putIntent(intentId, paymentId, { status: "succeeded", amount_received: 45210 });
    stripe.charges.set(chargeId, {
      id: chargeId,
      object: "charge",
      payment_intent: intentId,
      amount: 45210,
      amount_captured: 45210,
      amount_refunded: 5000,
      currency: "eur",
      metadata: metadataOf(paymentId),
    });
    stripe.refunds.set(providerRefundId, {
      id: providerRefundId,
      object: "refund",
      charge: chargeId,
      payment_intent: intentId,
      amount: 5000,
      currency: "eur",
      status: "succeeded",
      failure_reason: null,
      metadata: { ...metadataOf(paymentId), refund_id: refundId },
    });
    // When the worker lists the charge's refunds (its last read, no transaction open), the probe takes the payment;
    // the transaction that applies them must wait for it holding nothing of the refund.
    let probe: RowLockOrderProbe | undefined;
    stripe.onRequest(async (req) => {
      if (req.method !== "GET" || req.path !== "/v1/refunds" || probe !== undefined) {
        return;
      }
      probe = probeRowLockOrder(tenantDb, "tenant_alpha", {
        held: { table: "payments", id: paymentId },
        probed: { table: "refunds", id: refundId },
      });
      await probe.locked;
    });
    try {
      const eventId = stripeId("evt");
      const refunded = signedStripeEvent(
        "charge.refunded",
        {
          id: eventId,
          data: { object: { id: chargeId, payment_intent: intentId, metadata: metadataOf(paymentId) } },
        },
        SECRET,
      );
      expect((await deliver(refunded.payload, refunded.header)).status).toBe(200);
      job = await finishedJob(eventId);
      seen = await probe?.result;
    } finally {
      stripe.onRequest(undefined);
    }
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W25-BOOKINGS AC3] applies the refunds with the payment locked before them: the refund is free while it waits", async () => {
    expect(seen).toEqual({ waiterSeen: true, probedFree: true });
    expect(job.returnvalue).toMatchObject({ outcome: "applied" });
    expect(await paymentOf(paymentId)).toMatchObject({
      status: "partially_refunded",
      amountRefunded: "50.00",
    });
  });
});

describe("a dispute", () => {
  let paymentId: string;
  let disputeId: string;

  beforeAll(async () => {
    const intentId = stripeId("pi");
    const chargeId = stripeId("ch");
    disputeId = stripeId("dp");
    paymentId = await insertPayment({
      status: "captured",
      intentId,
      amountAuthorized: "452.10",
      amountCaptured: "452.10",
    });
    putIntent(intentId, paymentId, { status: "succeeded", amount_received: 45210 });
    const dispute = stripeFixture("charge.dispute.created").data.object;
    stripe.disputes.set(disputeId, {
      ...(dispute as unknown as Record<string, unknown>),
      id: disputeId,
      charge: chargeId,
      payment_intent: intentId,
    });
    for (const eventId of [stripeId("evt"), stripeId("evt")]) {
      // Disputes carry no metadata: the receiver reads the tenant from the dispute's PaymentIntent.
      const { payload, header } = signedStripeEvent(
        "charge.dispute.created",
        { id: eventId, data: { object: { id: disputeId, charge: chargeId, payment_intent: intentId } } },
        SECRET,
      );
      expect((await deliver(payload, header)).status).toBe(200);
      await finishedJob(eventId);
    }
  }, SCENARIO_TIMEOUT_MS);

  it("is recorded once and alerts the OTA's staff once, without changing the payment", async () => {
    const recorded = (await eventsOf(paymentId)).filter((row) => row.type === "payment.dispute_created");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({ disputeId, reason: "fraudulent", status: "needs_response" });
    expect(await paymentOf(paymentId)).toMatchObject({ status: "captured", version: 1 });
    const alerts = await alphaTx(
      async (trx) =>
        await trx
          .selectFrom("notifications")
          .select(["template_key", "recipient", "recipient_type", "dedupe_key"])
          .where("dedupe_key", "=", `staff.dispute:${disputeId}`)
          .execute(),
    );
    expect(alerts).toEqual([
      {
        template_key: "staff.manual_review",
        recipient: OPS_ALERT_EMAIL,
        recipient_type: "staff",
        dedupe_key: `staff.dispute:${disputeId}`,
      },
    ]);
  });
});

describe("an object whose Stripe metadata names another payment", () => {
  let paymentId: string;
  let eventId: string;

  beforeAll(async () => {
    const intentId = stripeId("pi");
    eventId = stripeId("evt");
    paymentId = await insertPayment({ status: "requires_action", intentId });
    // The event's body names this payment; the PaymentIntent Stripe answers names another one.
    putIntent(intentId, paymentId, { status: "requires_capture", amount_capturable: 45210 });
    const intent = stripe.intents.get(intentId);
    stripe.update(intentId, {
      metadata: { ...(intent?.["metadata"] as Record<string, string>), payment_id: newId("pay") },
    });
    const { payload, header } = signedStripeEvent(
      "payment_intent.amount_capturable_updated",
      { id: eventId, data: { object: { id: intentId, metadata: metadataOf(paymentId) } } },
      SECRET,
    );
    expect((await deliver(payload, header)).status).toBe(200);
    await finishedJob(eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("changes nothing and logs a security event in the worker", async () => {
    expect(await paymentOf(paymentId)).toMatchObject({ status: "requires_action", version: 1 });
    expect((await jobsOf(eventId))[0]?.returnvalue).toMatchObject({ outcome: "mismatch" });
    expect(
      workerSink
        .records()
        .filter(
          (line) =>
            line["securityEvent"] === "payments.stripe_event_mismatch" && line["paymentId"] === paymentId,
        ),
    ).toEqual([expect.objectContaining({ check: "payment_intent_metadata" })]);
  });
});
