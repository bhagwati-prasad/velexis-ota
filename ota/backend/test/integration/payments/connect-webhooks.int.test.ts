// The Stripe webhooks of the OTAs' own accounts end to end (OBE-078; OADR-0010 point 4, ADR-0011, PADR-0011 points 1
// and 5, architecture flow (d)): the Connect endpoint `/webhooks/stripe/connect/{environment}` (`connect_standard`
// mode) and a connection's own endpoint `/webhooks/stripe/c/<ppc_id>` (`api_keys` mode), against PostgreSQL 16, Redis
// 7 and a fake of the Stripe API. Both processes run in-process:
//
//   - the API's module graph (createTestApp), whose receiver verifies each delivery (the Connect secrets of this file;
//     a connection's own signing secret, sealed on its platform row as the platform seals it), takes the tenant only
//     from `event.account` or from the path's connection, stores the event as a `payment_events` row and queues
//     `stripe.event` on `ota-stripe-events`;
//   - the worker's module graph (WorkerModule.forRoot, as dist/worker.js builds it), whose consumer reads the event's
//     object again from the fake Stripe API on the account the payment was created on (the Velexis key with
//     `Stripe-Account` for Connect, the connection's own decrypted key for `api_keys`, and the Connect path for an
//     `api_keys` payment whose account the OTA has connected since, lead decision (2i) of 2026-10-30) and applies that
//     state: PaymentIntents, a dispute and a refund with its charge.
//
// The platform rows are written as the platform writes them (velexis_migrator): tenant alpha has a `connect_standard`
// connection in test and an `api_keys` one in live, tenant beta an `api_keys` one in test (one Stripe connection per
// tenant and environment). The payments are written straight into `tenant_alpha` and `tenant_beta` with the account
// snapshot the gateway records (`payments.metadata.connection`, OBE-077). The deliveries are the signed fixtures of
// @velexis/testing/stripe, changed to name this file's accounts, tenants, payments and Stripe objects; every secret
// and key is built at run time, none is real. Each scenario delivers in its `beforeAll` hook, with a budget of its own,
// and its tests read what it left. Every answer is checked against the OTA document.
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Module, type INestApplicationContext } from "@nestjs/common";
import { encryptValue, type KeyProvider } from "@velexis/crypto";
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
import { connectionSecretAad } from "../../../src/payments/stripe/stripe-client.factory";
import { connectionWebhookSecretAad } from "../../../src/payments/webhooks/webhook-receiver.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { PlatformReadRepository } from "../../../src/tenancy/platform-read.repository";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { testKeyProvider, testWorkerVariables } from "../../helpers/api-env";
import {
  startFakeStripe,
  stripeEndpointModule,
  type FakePaymentIntent,
  type FakeStripe,
  type FakeStripeRequest,
} from "../../helpers/fake-stripe";
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

const CONNECT_TEST = "/webhooks/stripe/connect/test";
const connectionPath = (connectionId: string): string => `/webhooks/stripe/c/${connectionId}`;
/** The operation of a webhook path, for the answer's check against the OTA document. */
const operationOf = (path: string) =>
  path.startsWith("/webhooks/stripe/c/") ? "receiveStripeConnectionWebhook" : "receiveStripeConnectWebhook";
const OPS_ALERT_EMAIL = "ops-alerts@alpha-travel.example";

/** This run's Velexis test keys and Connect signing secrets: Stripe's shapes, random, never committed values. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;
const CONNECT_SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
const CONNECT_SECRET_LIVE = `whsec_${randomBytes(24).toString("base64url")}`;
/** Tenant alpha's connected account (Connect, test) and own account (API keys, live), with the live account's keys. */
const ALPHA_CONNECTED = `acct_${randomBytes(8).toString("hex")}AlphaConnect`;
const ALPHA_OWN = `acct_${randomBytes(8).toString("hex")}AlphaOwn`;
const ALPHA_SECRET_KEY = `sk_live_${randomBytes(20).toString("hex")}`;
const ALPHA_PUBLISHABLE_KEY = `pk_live_${randomBytes(20).toString("hex")}`;
const ALPHA_WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("hex")}`;
/** Tenant beta's own account (API keys, test) and its keys. */
const BETA_OWN = `acct_${randomBytes(8).toString("hex")}BetaOwn`;
const BETA_SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const BETA_PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;
const BETA_WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("hex")}`;

const quietPoolLogger = { error: (): void => undefined };

let db: TestDatabase;
let redis: TestRedis;
let stripe: FakeStripe;
let keys: KeyProvider;
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
/** Alpha's `connect_standard` (test) and `api_keys` (live) connections, beta's `api_keys` one (test). */
let alphaConnectId: string;
let alphaOwnId: string;
let betaOwnId: string;

type Tenant = "alpha" | "beta";
const txOf =
  (tenant: Tenant) =>
  <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
    tenantTx(tenantDb, `tenant_${tenant}`, run);

/** A fresh Stripe-shaped id of this run (`pi_test_…`, `evt_test_…`). */
const stripeId = (prefix: string): string => `${prefix}_test_${randomBytes(10).toString("hex")}`;

async function insertTenant(key: Tenant): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  return id;
}

/** `value` sealed as the platform seals a column of connection `rowId` (ADR-0010: the row's associated data). */
async function sealed(aad: string, value: string): Promise<{ ciphertext: Buffer; kekId: string }> {
  const { ciphertext, kekId } = await encryptValue(Buffer.from(value, "utf8"), { aad, keys });
  return { ciphertext: Buffer.from(ciphertext), kekId };
}

/** A `connect_standard` connection, as the platform's Connect OAuth callback writes it (PBE-055). */
async function insertConnectConnection(
  tenantId: string,
  environment: "test" | "live",
  account: string,
): Promise<string> {
  const id = newId("ppc");
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id,
      tenant_id: tenantId,
      provider: "stripe",
      environment,
      account_mode: "connect_standard",
      account_reference: account,
      capture_mode: "manual",
      is_default: true,
      status: "active",
    })
    .execute();
  return id;
}

/** An `api_keys` connection with its keys and signing secret sealed for its row, as the platform applies them. */
async function insertApiKeysConnection(
  tenantId: string,
  environment: "test" | "live",
  own: { account: string; secretKey: string; publishableKey: string; webhookSecret: string },
): Promise<string> {
  const id = newId("ppc");
  const secret = await sealed(connectionSecretAad(id), own.secretKey);
  const webhook = await sealed(connectionWebhookSecretAad(id), own.webhookSecret);
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id,
      tenant_id: tenantId,
      provider: "stripe",
      environment,
      account_mode: "api_keys",
      account_reference: own.account,
      publishable_key: own.publishableKey,
      secret_ciphertext: secret.ciphertext,
      webhook_secret_ciphertext: webhook.ciphertext,
      encryption_key_id: secret.kekId,
      capture_mode: "manual",
      is_default: true,
      status: "active",
    })
    .execute();
  return id;
}

interface PaymentSeed {
  readonly tenant: Tenant;
  readonly environment: "test" | "live";
  readonly connectionId: string;
  readonly account: {
    readonly accountMode: "connect_standard" | "api_keys";
    readonly accountReference: string;
  };
  readonly status: string;
  readonly intentId: string;
  readonly amountAuthorized?: string;
  readonly amountCaptured?: string;
}

/** A Stripe card payment of 452.10 EUR, as checkout.createPayment leaves it on an OTA's own account (OBE-077). */
async function insertPayment(seed: PaymentSeed): Promise<string> {
  const id = newId("pay");
  await txOf(seed.tenant)(async (trx) => {
    await trx
      .insertInto("payments")
      .values({
        id,
        environment: seed.environment,
        provider: "stripe",
        provider_connection_id: seed.connectionId,
        provider_payment_id: seed.intentId,
        method: "card",
        capture_method: "manual",
        currency: "EUR",
        amount: "452.10",
        amount_authorized: seed.amountAuthorized ?? "0",
        amount_captured: seed.amountCaptured ?? "0",
        status: seed.status,
        three_ds: JSON.stringify({ required: false, status: "not_required", version: null }),
        metadata: JSON.stringify({ connection: seed.account }),
        version: 1,
      })
      .execute();
  });
  return id;
}

/** What a test may change in the fixtures it signs (`signedStripeEvent`'s overrides). */
type PaymentIntentOverrides = Parameters<typeof signedStripeEvent<"payment_intent.succeeded">>[1];
type DisputeOverrides = Parameters<typeof signedStripeEvent<"charge.dispute.created">>[1];

/** The Velexis metadata of a payment, as the gateway writes it on every PaymentIntent. */
const metadataOf = (
  tenantId: string,
  paymentId: string,
  environment: "test" | "live" = "test",
): Record<string, string> => ({
  velexis_tenant_id: tenantId,
  velexis_environment: environment,
  payment_id: paymentId,
});

/** The PaymentIntent the fake Stripe API answers for a payment. */
function putIntent(
  intentId: string,
  metadata: Record<string, string>,
  patch: Partial<FakePaymentIntent>,
): void {
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
    metadata,
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

/** Posts a signed delivery to `path` as Stripe does: the exact signed bytes and `Stripe-Signature`. */
async function deliver(path: string, payload: string, header: string): Promise<request.Response> {
  return await request(api.server)
    .post(path)
    .set(STRIPE_SIGNATURE_HEADER, header)
    .set("Content-Type", "application/json; charset=utf-8")
    .send(payload);
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

/** The jobs of `ota-stripe-events` whose id is `eventId`, whatever their state. */
async function jobsOf(eventId: string): Promise<Job[]> {
  const jobs = await stripeEvents.getJobs([
    "completed",
    "failed",
    "active",
    "waiting",
    "delayed",
    "prioritized",
  ]);
  return jobs.filter((job) => job.id === eventId);
}

interface PaymentState {
  readonly status: string;
  readonly version: number;
  readonly amountAuthorized: string;
  readonly amountCaptured: string;
}

async function paymentOf(tenant: Tenant, id: string): Promise<PaymentState> {
  return await txOf(tenant)(
    async (trx) =>
      await trx
        .selectFrom("payments")
        .select([
          "status",
          "version",
          sql<string>`amount_authorized::text`.as("amountAuthorized"),
          sql<string>`amount_captured::text`.as("amountCaptured"),
        ])
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
  );
}

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly providerEventId: string | null;
  readonly payload: Record<string, unknown>;
}

/** The payment events of a payment, oldest first. */
async function eventsOf(tenant: Tenant, paymentId: string): Promise<EventRow[]> {
  return await txOf(tenant)(
    async (trx) =>
      (await trx
        .selectFrom("payment_events")
        .select(["id", "type", "provider_event_id as providerEventId", "payload"])
        .where("payment_id", "=", paymentId)
        .orderBy("created_at")
        .orderBy("id")
        .execute()) as EventRow[],
  );
}

/** The payment events that name a Stripe event id in `tenant` (any payment): the row and the rows its job wrote. */
async function rowsOfStripeEvent(eventId: string, tenant: Tenant): Promise<number> {
  return await txOf(tenant)(async (trx) => {
    const row = await trx
      .selectFrom("payment_events")
      .select(sql<number>`count(*)::int`.as("n"))
      .where(sql<boolean>`provider_event_id = ${eventId} or payload ->> 'providerEventId' = ${eventId}`)
      .executeTakeFirstOrThrow();
    return row.n;
  });
}

/** The staff alerts queued in `tenant`'s outbox. */
async function staffAlerts(tenant: Tenant): Promise<number> {
  return await txOf(tenant)(async (trx) => {
    const row = await trx
      .selectFrom("notifications")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("recipient_type", "=", "staff")
      .executeTakeFirstOrThrow();
    return row.n;
  });
}

/** The requests the fake Stripe API received for `path` (GET: the worker's reads). */
const readsOf = (path: string): FakeStripeRequest[] =>
  stripe.requests.filter((entry) => entry.method === "GET" && entry.path === path);

/** What a request carried to Stripe: its key and its `Stripe-Account` header. */
const credentialsOf = (req: FakeStripeRequest | undefined): [string | undefined, string | undefined] => [
  req?.headers["authorization"],
  req?.headers["stripe-account"],
];

/** The API's security events about one Stripe event. */
const securityEventsOf = (eventId: string): Record<string, unknown>[] =>
  api.sink
    .records()
    .filter((line) => line["securityEvent"] === "payments.webhook_mismatch" && line["eventId"] === eventId);

beforeAll(() => {
  preloadOpenApiDocument();
  // The response validators compile on their first check: here, with every status the tests check, not in a test.
  const checker = responseChecker("ota");
  for (const operationId of ["receiveStripeConnectWebhook", "receiveStripeConnectionWebhook"] as const) {
    for (const status of [200, 400]) {
      checker.check(operationId, { status, body: {} });
    }
  }
}, OPENAPI_SETUP_TIMEOUT_MS);

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
  stripe = await startFakeStripe();
  keys = await testKeyProvider();
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
  alphaConnectId = await insertConnectConnection(alphaId, "test", ALPHA_CONNECTED);
  alphaOwnId = await insertApiKeysConnection(alphaId, "live", {
    account: ALPHA_OWN,
    secretKey: ALPHA_SECRET_KEY,
    publishableKey: ALPHA_PUBLISHABLE_KEY,
    webhookSecret: ALPHA_WEBHOOK_SECRET,
  });
  betaOwnId = await insertApiKeysConnection(betaId, "test", {
    account: BETA_OWN,
    secretKey: BETA_SECRET_KEY,
    publishableKey: BETA_PUBLISHABLE_KEY,
    webhookSecret: BETA_WEBHOOK_SECRET,
  });
  // Both OTAs' settings as the provisioning seed writes them, with the alert address an OTA sets in its admin.
  for (const tenant of ["alpha", "beta"] as const) {
    await txOf(tenant)(async (trx) => {
      await seedStorefrontSettings(trx, {
        name: `${tenant} Travel`,
        defaultCurrency: "EUR",
        defaultLocale: "en",
      });
      await trx.updateTable("storefront_settings").set({ ops_alert_email: OPS_ALERT_EMAIL }).execute();
    });
  }
  const velexisKeys = { STRIPE_SECRET_KEY_TEST: SECRET_KEY, STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY };

  api = await createTestApp({
    database: db,
    redis,
    env: {
      ...velexisKeys,
      STRIPE_WEBHOOK_SECRET_CONNECT_TEST: CONNECT_SECRET,
      STRIPE_WEBHOOK_SECRET_CONNECT_LIVE: CONNECT_SECRET_LIVE,
    },
    imports: [stripeEndpointModule(stripe.endpoint)],
  });

  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    ...velexisKeys,
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

describe("the platform rows the receivers read", () => {
  it("find the connect_standard connection of an account, and a connection with its signing secret's ciphertext", async () => {
    const platform = api.app.get(PlatformReadRepository);

    expect(await platform.connectPaymentConnection("test", ALPHA_CONNECTED)).toMatchObject({
      id: alphaConnectId,
      tenantId: alphaId,
      accountMode: "connect_standard",
    });
    // Only a connect_standard connection of that environment: not alpha's live own account, nor another environment.
    expect(await platform.connectPaymentConnection("live", ALPHA_CONNECTED)).toBeNull();
    expect(await platform.connectPaymentConnection("live", ALPHA_OWN)).toBeNull();
    expect(await platform.connectPaymentConnection("test", "acct_test_alpha")).toBeNull();
    const own = await platform.paymentConnectionWebhook(betaOwnId);
    expect(own?.connection).toMatchObject({ id: betaOwnId, tenantId: betaId, accountMode: "api_keys" });
    expect(own?.webhookSecretCiphertext).toEqual(expect.any(String));
    expect(own?.webhookSecretCiphertext).not.toContain(BETA_WEBHOOK_SECRET);
    expect((await platform.paymentConnectionWebhook(alphaConnectId))?.webhookSecretCiphertext).toBeNull();
    expect(await platform.paymentConnectionWebhook(newId("ppc"))).toBeNull();
  });
});

describe("a Connect event of alpha's connected account, delivered twice", () => {
  let paymentId: string;
  let intentId: string;
  let eventId: string;
  let answers: request.Response[];

  beforeAll(async () => {
    intentId = stripeId("pi");
    eventId = stripeId("evt");
    paymentId = await insertPayment({
      tenant: "alpha",
      environment: "test",
      connectionId: alphaConnectId,
      account: { accountMode: "connect_standard", accountReference: ALPHA_CONNECTED },
      status: "requires_action",
      intentId,
    });
    putIntent(intentId, metadataOf(alphaId, paymentId), {
      status: "requires_capture",
      amount_capturable: 45210,
    });
    const { payload, header } = signedStripeEvent(
      "payment_intent.amount_capturable_updated",
      {
        id: eventId,
        account: ALPHA_CONNECTED,
        data: { object: { id: intentId, metadata: metadataOf(alphaId, paymentId) } },
      },
      CONNECT_SECRET,
    );
    answers = [await deliver(CONNECT_TEST, payload, header)];
    await finishedJob(eventId);
    answers.push(await deliver(CONNECT_TEST, payload, header));
    await finishedJob(eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("answers 200 {received: true} both times, as the OTA document says [OBE-078 AC1]", () => {
    for (const res of answers) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(res.headers["cache-control"]).toBe("no-store");
      expectResponseToMatch("receiveStripeConnectWebhook", res);
    }
  });

  it("stores the event once in alpha, with the endpoint, the account and the connection [OBE-078 AC1]", async () => {
    const stored = (await eventsOf("alpha", paymentId)).filter((row) => row.providerEventId === eventId);

    expect(stored).toEqual([
      expect.objectContaining({ type: "webhook.payment_intent.amount_capturable_updated" }),
    ]);
    expect(stored[0]?.payload).toMatchObject({
      endpoint: "connect",
      account: ALPHA_CONNECTED,
      connectionId: alphaConnectId,
      object: { id: intentId },
    });
    expect(JSON.stringify(stored)).not.toContain("_secret_");
    expect(await rowsOfStripeEvent(eventId, "beta")).toBe(0);
  });

  it("processes it once, reading the PaymentIntent on the connected account with the Velexis key [OBE-078 AC1]", async () => {
    const jobs = await jobsOf(eventId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({
      tenantId: alphaId,
      paymentEventId: (await eventsOf("alpha", paymentId)).find((row) => row.providerEventId === eventId)?.id,
    });
    expect(jobs[0]?.returnvalue).toMatchObject({
      outcome: "applied",
      type: "payment_intent.amount_capturable_updated",
    });
    const reads = readsOf(`/v1/payment_intents/${intentId}`);
    expect(reads.map(credentialsOf)).toEqual([[`Bearer ${SECRET_KEY}`, ALPHA_CONNECTED]]);
    expect(
      (await eventsOf("alpha", paymentId)).filter((row) => row.type === "payment.authorized"),
    ).toHaveLength(1);
    expect(await paymentOf("alpha", paymentId)).toEqual({
      status: "authorized",
      version: 2,
      amountAuthorized: "452.10",
      amountCaptured: "0.00",
    });
  });
});

describe("an event of beta's own account at its connection's endpoint, delivered twice", () => {
  let paymentId: string;
  let intentId: string;
  let eventId: string;
  let answers: request.Response[];

  beforeAll(async () => {
    intentId = stripeId("pi");
    eventId = stripeId("evt");
    paymentId = await insertPayment({
      tenant: "beta",
      environment: "test",
      connectionId: betaOwnId,
      account: { accountMode: "api_keys", accountReference: BETA_OWN },
      status: "authorized",
      intentId,
      amountAuthorized: "452.10",
    });
    putIntent(intentId, metadataOf(betaId, paymentId), { status: "succeeded", amount_received: 45210 });
    const { payload, header } = signedStripeEvent(
      "payment_intent.succeeded",
      { id: eventId, data: { object: { id: intentId, metadata: metadataOf(betaId, paymentId) } } },
      BETA_WEBHOOK_SECRET,
    );
    answers = [await deliver(connectionPath(betaOwnId), payload, header)];
    await finishedJob(eventId);
    answers.push(await deliver(connectionPath(betaOwnId), payload, header));
    await finishedJob(eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("answers 200 {received: true} both times, as the OTA document says [OBE-078 AC1]", () => {
    for (const res of answers) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(res.headers["cache-control"]).toBe("no-store");
      expectResponseToMatch("receiveStripeConnectionWebhook", res);
    }
  });

  it("stores the event once in beta, with the endpoint, the account and the connection [OBE-078 AC1]", async () => {
    const stored = (await eventsOf("beta", paymentId)).filter((row) => row.providerEventId === eventId);

    expect(stored).toEqual([expect.objectContaining({ type: "webhook.payment_intent.succeeded" })]);
    expect(stored[0]?.payload).toMatchObject({
      endpoint: "connection",
      account: BETA_OWN,
      connectionId: betaOwnId,
    });
    expect(await rowsOfStripeEvent(eventId, "alpha")).toBe(0);
  });

  it("processes it once, reading the PaymentIntent with the connection's own key [OBE-078 AC1]", async () => {
    const jobs = await jobsOf(eventId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ tenantId: betaId });
    expect(jobs[0]?.returnvalue).toMatchObject({ outcome: "applied", type: "payment_intent.succeeded" });
    // The OTA's own key, decrypted for the job, and no Stripe-Account header.
    expect(readsOf(`/v1/payment_intents/${intentId}`).map(credentialsOf)).toEqual([
      [`Bearer ${BETA_SECRET_KEY}`, undefined],
    ]);
    expect(await paymentOf("beta", paymentId)).toEqual({
      status: "captured",
      version: 2,
      amountAuthorized: "452.10",
      amountCaptured: "452.10",
    });
  });
});

describe("a dispute on alpha's connected account", () => {
  let paymentId: string;
  let disputeId: string;
  let alertsBefore: number;

  beforeAll(async () => {
    const intentId = stripeId("pi");
    const chargeId = stripeId("ch");
    disputeId = stripeId("dp");
    alertsBefore = await staffAlerts("alpha");
    paymentId = await insertPayment({
      tenant: "alpha",
      environment: "test",
      connectionId: alphaConnectId,
      account: { accountMode: "connect_standard", accountReference: ALPHA_CONNECTED },
      status: "captured",
      intentId,
      amountAuthorized: "452.10",
      amountCaptured: "452.10",
    });
    putIntent(intentId, metadataOf(alphaId, paymentId), { status: "succeeded", amount_received: 45210 });
    const dispute = stripeFixture("charge.dispute.created").data.object;
    stripe.disputes.set(disputeId, {
      ...(dispute as unknown as Record<string, unknown>),
      id: disputeId,
      charge: chargeId,
      payment_intent: intentId,
    });
    const eventId = stripeId("evt");
    // Disputes carry no metadata: the account alone names the OTA, the PaymentIntent the payment.
    const { payload, header } = signedStripeEvent(
      "charge.dispute.created",
      {
        id: eventId,
        account: ALPHA_CONNECTED,
        data: { object: { id: disputeId, charge: chargeId, payment_intent: intentId } },
      },
      CONNECT_SECRET,
    );
    expect((await deliver(CONNECT_TEST, payload, header)).status).toBe(200);
    await finishedJob(eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("is read on the connected account, recorded once and alerts alpha's staff once [OBE-078 AC1]", async () => {
    expect(readsOf(`/v1/disputes/${disputeId}`).map(credentialsOf)).toEqual([
      [`Bearer ${SECRET_KEY}`, ALPHA_CONNECTED],
    ]);
    expect(
      (await eventsOf("alpha", paymentId)).filter((row) => row.type === "payment.dispute_created"),
    ).toHaveLength(1);
    expect(await staffAlerts("alpha")).toBe(alertsBefore + 1);
  });
});

describe("a refund on alpha's connected account", () => {
  let paymentId: string;
  let refundId: string;
  let providerRefundId: string;
  let chargeId: string;
  let job: Job;

  beforeAll(async () => {
    const intentId = stripeId("pi");
    chargeId = stripeId("ch");
    providerRefundId = stripeId("re");
    paymentId = await insertPayment({
      tenant: "alpha",
      environment: "test",
      connectionId: alphaConnectId,
      account: { accountMode: "connect_standard", accountReference: ALPHA_CONNECTED },
      status: "captured",
      intentId,
      amountAuthorized: "452.10",
      amountCaptured: "452.10",
    });
    refundId = newId("rfd");
    // The refund row as `refund.submit` (OBE-040) leaves it before Stripe's answer is stored.
    await txOf("alpha")(async (trx) => {
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
    putIntent(intentId, metadataOf(alphaId, paymentId), { status: "succeeded", amount_received: 45210 });
    stripe.charges.set(chargeId, {
      id: chargeId,
      object: "charge",
      payment_intent: intentId,
      amount: 45210,
      amount_captured: 45210,
      amount_refunded: 10000,
      currency: "eur",
      metadata: metadataOf(alphaId, paymentId),
    });
    const refund = {
      id: providerRefundId,
      object: "refund",
      charge: chargeId,
      payment_intent: intentId,
      amount: 10000,
      currency: "eur",
      status: "succeeded",
      failure_reason: null,
      metadata: { ...metadataOf(alphaId, paymentId), refund_id: refundId },
    };
    stripe.refunds.set(providerRefundId, refund);
    // `charge.refund.updated` has no fixture: signed here as Stripe signs it, with the Connect secret.
    const eventId = stripeId("evt");
    const payload = JSON.stringify(
      {
        id: eventId,
        object: "event",
        account: ALPHA_CONNECTED,
        api_version: Stripe.API_VERSION,
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type: "charge.refund.updated",
        data: { object: refund },
      },
      null,
      2,
    );
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: CONNECT_SECRET });
    expect((await deliver(CONNECT_TEST, payload, header)).status).toBe(200);
    job = await finishedJob(eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("reads the refund, its charge and the charge's refunds on the connected account, and applies them [OBE-078 AC1]", async () => {
    expect(job.returnvalue).toMatchObject({ outcome: "applied", type: "charge.refund.updated" });
    const reads = [
      ...readsOf(`/v1/refunds/${providerRefundId}`),
      ...readsOf(`/v1/charges/${chargeId}`),
      ...readsOf("/v1/refunds").filter((entry) => entry.query["charge"] === chargeId),
    ];
    expect(reads.map(credentialsOf)).toEqual([
      [`Bearer ${SECRET_KEY}`, ALPHA_CONNECTED],
      [`Bearer ${SECRET_KEY}`, ALPHA_CONNECTED],
      [`Bearer ${SECRET_KEY}`, ALPHA_CONNECTED],
    ]);
    expect(
      await txOf("alpha")(
        async (trx) =>
          await trx
            .selectFrom("refunds")
            .select(["status", "provider_refund_id"])
            .where("id", "=", refundId)
            .executeTakeFirstOrThrow(),
      ),
    ).toEqual({ status: "succeeded", provider_refund_id: providerRefundId });
    expect(
      await txOf("alpha")(
        async (trx) =>
          await trx
            .selectFrom("payments")
            .select(["status", sql<string>`amount_refunded::text`.as("amountRefunded")])
            .where("id", "=", paymentId)
            .executeTakeFirstOrThrow(),
      ),
    ).toEqual({ status: "partially_refunded", amountRefunded: "100.00" });
  });
});

describe("an api_keys payment of an account alpha connected with Connect since (lead decision (2i))", () => {
  let paymentId: string;
  let intentId: string;
  let eventId: string;

  beforeAll(async () => {
    intentId = stripeId("pi");
    eventId = stripeId("evt");
    // Created while alpha's test connection held its own keys for that account; the row now says connect_standard.
    paymentId = await insertPayment({
      tenant: "alpha",
      environment: "test",
      connectionId: alphaConnectId,
      account: { accountMode: "api_keys", accountReference: ALPHA_CONNECTED },
      status: "requires_action",
      intentId,
    });
    putIntent(intentId, metadataOf(alphaId, paymentId), {
      status: "requires_capture",
      amount_capturable: 45210,
    });
    const { payload, header } = signedStripeEvent(
      "payment_intent.amount_capturable_updated",
      {
        id: eventId,
        account: ALPHA_CONNECTED,
        data: { object: { id: intentId, metadata: metadataOf(alphaId, paymentId) } },
      },
      CONNECT_SECRET,
    );
    expect((await deliver(CONNECT_TEST, payload, header)).status).toBe(200);
    await finishedJob(eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("is stored on the Connect endpoint and read through the Connect path on that same account [OBE-078 AC1]", async () => {
    expect((await eventsOf("alpha", paymentId)).filter((row) => row.providerEventId === eventId)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ endpoint: "connect" }) as unknown }),
    ]);
    expect((await jobsOf(eventId))[0]?.returnvalue).toMatchObject({ outcome: "applied" });
    expect(readsOf(`/v1/payment_intents/${intentId}`).map(credentialsOf)).toEqual([
      [`Bearer ${SECRET_KEY}`, ALPHA_CONNECTED],
    ]);
    expect(await paymentOf("alpha", paymentId)).toMatchObject({ status: "authorized", version: 2 });
  });
});

describe("deliveries whose signature is refused", () => {
  const eventIds: string[] = [];
  let answers: Array<[string, string, request.Response]>;

  beforeAll(async () => {
    answers = [];
    const refused = async (what: string, path: string, secret: string, account?: string): Promise<void> => {
      const eventId = stripeId("evt");
      eventIds.push(eventId);
      const { payload, header } = signedStripeEvent(
        "payment_intent.succeeded",
        { id: eventId, ...(account === undefined ? {} : { account }) },
        secret,
      );
      answers.push([what, path, await deliver(path, payload, header)]);
    };
    // Beta's endpoint, signed with alpha's own connection's secret, with the Connect secret, and a changed body.
    await refused("another connection's secret", connectionPath(betaOwnId), ALPHA_WEBHOOK_SECRET);
    await refused("the Connect secret", connectionPath(betaOwnId), CONNECT_SECRET);
    // An id no connection has, and a connection that is not in api_keys mode (alpha's Connect one, no secret).
    await refused("an unknown connection", connectionPath(newId("ppc")), BETA_WEBHOOK_SECRET);
    await refused("a connect_standard connection", connectionPath(alphaConnectId), BETA_WEBHOOK_SECRET);
    // The Connect endpoint, signed with a connection's own secret, and the live Connect secret on the test endpoint.
    await refused("a connection's secret on Connect", CONNECT_TEST, BETA_WEBHOOK_SECRET, ALPHA_CONNECTED);
    await refused("the live Connect secret", CONNECT_TEST, CONNECT_SECRET_LIVE, ALPHA_CONNECTED);
    const tamperedId = stripeId("evt");
    eventIds.push(tamperedId);
    const original = signedStripeEvent(
      "payment_intent.succeeded",
      { id: tamperedId, data: { object: { amount_received: 45210 } } },
      BETA_WEBHOOK_SECRET,
    );
    const changed = original.payload.replace('"amount_received": 45210', '"amount_received": 1');
    expect(changed).not.toBe(original.payload);
    const tamperedPath = connectionPath(betaOwnId);
    answers.push([
      "a body changed after signing",
      tamperedPath,
      await deliver(tamperedPath, changed, original.header),
    ]);
  }, SCENARIO_TIMEOUT_MS);

  it("answers the same 400 INVALID_REQUEST to each, so the endpoint never tells which connections exist [OBE-078 AC1]", () => {
    expect(answers).toHaveLength(7);
    for (const [what, path, res] of answers) {
      expect([what, res.status]).toEqual([what, 400]);
      expect([what, res.body]).toEqual([
        what,
        {
          error: expect.objectContaining({
            code: "INVALID_REQUEST",
            message: "The Stripe signature of the request is not valid.",
            details: { reason: "signature_invalid" },
          }) as unknown,
        },
      ]);
      expectResponseToMatch(operationOf(path), res);
    }
  });

  it("stores and queues nothing in either schema [OBE-078 AC1]", async () => {
    for (const eventId of eventIds) {
      expect([
        eventId,
        await rowsOfStripeEvent(eventId, "alpha"),
        await rowsOfStripeEvent(eventId, "beta"),
      ]).toEqual([eventId, 0, 0]);
      expect(await jobsOf(eventId)).toEqual([]);
    }
  });
});

describe("an event of an acct_ that no connection has", () => {
  let unknownAccount: request.Response;
  let withoutAccount: request.Response;
  const eventIds: string[] = [];

  beforeAll(async () => {
    const [unknownId, missingId] = [stripeId("evt"), stripeId("evt")];
    eventIds.push(unknownId, missingId);
    const unknown = signedStripeEvent(
      "payment_intent.succeeded",
      {
        id: unknownId,
        account: `acct_${randomBytes(8).toString("hex")}Unknown`,
        // Even with metadata naming alpha: the account alone would choose the OTA, and it chooses none.
        data: { object: { metadata: metadataOf(alphaId, newId("pay")) } },
      },
      CONNECT_SECRET,
    );
    unknownAccount = await deliver(CONNECT_TEST, unknown.payload, unknown.header);
    const missing = signedStripeEvent("payment_intent.succeeded", { id: missingId }, CONNECT_SECRET);
    withoutAccount = await deliver(CONNECT_TEST, missing.payload, missing.header);
  }, SCENARIO_TIMEOUT_MS);

  it("is acknowledged with 200 and ignored: nothing stored or queued in any schema [OBE-078 AC2]", async () => {
    for (const res of [unknownAccount, withoutAccount]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expectResponseToMatch("receiveStripeConnectWebhook", res);
    }
    for (const eventId of eventIds) {
      expect([await rowsOfStripeEvent(eventId, "alpha"), await rowsOfStripeEvent(eventId, "beta")]).toEqual([
        0, 0,
      ]);
      expect(await jobsOf(eventId)).toEqual([]);
      expect(
        api.sink
          .records()
          .filter((line) => line["eventId"] === eventId && line["msg"] === "payments.webhook_ignored"),
      ).toEqual([expect.objectContaining({ outcome: "account_unknown" })]);
      expect(securityEventsOf(eventId)).toEqual([]);
    }
  });
});

describe("forged metadata and livemode mismatches", () => {
  /** Beta's payment, which the forged events name, and its state before them. */
  let betaPaymentId: string;
  let betaIntentId: string;
  let alphaPaymentId: string;
  let alertsBefore: Record<Tenant, number>;
  const forged: Record<
    string,
    { eventId: string; path: string; res: request.Response; check: string; endpoint: string }
  > = {};

  beforeAll(async () => {
    alertsBefore = { alpha: await staffAlerts("alpha"), beta: await staffAlerts("beta") };
    betaIntentId = stripeId("pi");
    betaPaymentId = await insertPayment({
      tenant: "beta",
      environment: "test",
      connectionId: betaOwnId,
      account: { accountMode: "api_keys", accountReference: BETA_OWN },
      status: "authorized",
      intentId: betaIntentId,
      amountAuthorized: "452.10",
    });
    alphaPaymentId = await insertPayment({
      tenant: "alpha",
      environment: "test",
      connectionId: alphaConnectId,
      account: { accountMode: "connect_standard", accountReference: ALPHA_CONNECTED },
      status: "requires_action",
      intentId: stripeId("pi"),
    });
    /** Signs an event of `type` with `secret`, posts it to `path`, and keeps what the tests check of it. */
    const send = async (
      name: string,
      expected: { path: string; secret: string; check: string; endpoint: string },
      overrides: Record<string, unknown>,
      type: "payment_intent.succeeded" | "charge.dispute.created" = "payment_intent.succeeded",
    ): Promise<void> => {
      const eventId = stripeId("evt");
      const { payload, header } =
        type === "payment_intent.succeeded"
          ? signedStripeEvent(type, { ...overrides, id: eventId } as PaymentIntentOverrides, expected.secret)
          : signedStripeEvent(type, { ...overrides, id: eventId } as DisputeOverrides, expected.secret);
      forged[name] = {
        eventId,
        path: expected.path,
        res: await deliver(expected.path, payload, header),
        check: expected.check,
        endpoint: expected.endpoint,
      };
    };
    const connect = (check: string) => ({
      path: CONNECT_TEST,
      secret: CONNECT_SECRET,
      check,
      endpoint: "connect/test",
    });
    const alphaOwn = (check: string) => ({
      path: connectionPath(alphaOwnId),
      secret: ALPHA_WEBHOOK_SECRET,
      check,
      endpoint: `c/${alphaOwnId}`,
    });
    // Alpha's correctly signed Connect events, whose objects name beta and beta's payment and PaymentIntent.
    await send("connect: beta's tenant id", connect("metadata_tenant"), {
      account: ALPHA_CONNECTED,
      data: { object: { id: betaIntentId, metadata: metadataOf(betaId, betaPaymentId) } },
    });
    await send(
      "connect: a dispute naming beta",
      connect("metadata_tenant"),
      {
        account: ALPHA_CONNECTED,
        data: {
          object: {
            id: stripeId("dp"),
            payment_intent: betaIntentId,
            metadata: metadataOf(betaId, betaPaymentId),
          },
        },
      },
      "charge.dispute.created",
    );
    // Alpha's own live account at its connection's endpoint, correctly signed, naming beta.
    await send("c/: beta's tenant id", alphaOwn("metadata_tenant"), {
      livemode: true,
      data: {
        object: { id: betaIntentId, livemode: true, metadata: metadataOf(betaId, betaPaymentId, "live") },
      },
    });
    // livemode against the path's environment (Connect) and against the connection's (c/: alpha's is live).
    await send("connect: livemode on test", connect("livemode"), {
      account: ALPHA_CONNECTED,
      livemode: true,
      data: { object: { metadata: metadataOf(alphaId, alphaPaymentId) } },
    });
    await send("c/: test event on a live connection", alphaOwn("livemode"), {
      livemode: false,
      data: { object: { metadata: metadataOf(alphaId, alphaPaymentId, "live") } },
    });
    // A Connect event of alpha's account naming beta's payment with alpha's own tenant id: looked up in alpha only.
    await send("connect: beta's payment in alpha", connect(""), {
      account: ALPHA_CONNECTED,
      data: { object: { id: betaIntentId, metadata: metadataOf(alphaId, betaPaymentId) } },
    });
  }, SCENARIO_TIMEOUT_MS);

  it("acknowledges each with 200 {received: true} [OBE-078 AC3]", () => {
    expect(Object.keys(forged)).toHaveLength(6);
    for (const [name, { path, res }] of Object.entries(forged)) {
      expect([name, res.status, res.body]).toEqual([name, 200, { received: true }]);
      expectResponseToMatch(operationOf(path), res);
    }
  });

  it("writes no payment_events row in either schema and queues nothing [OBE-078 AC3]", async () => {
    for (const [name, { eventId }] of Object.entries(forged)) {
      expect([
        name,
        await rowsOfStripeEvent(eventId, "alpha"),
        await rowsOfStripeEvent(eventId, "beta"),
      ]).toEqual([name, 0, 0]);
      expect([name, await jobsOf(eventId)]).toEqual([name, []]);
    }
    expect(await eventsOf("beta", betaPaymentId)).toEqual([]);
    expect(await paymentOf("beta", betaPaymentId)).toMatchObject({ status: "authorized", version: 1 });
    expect(await paymentOf("alpha", alphaPaymentId)).toMatchObject({ status: "requires_action", version: 1 });
  });

  it("raises no staff alert in either schema [OBE-078 AC3]", async () => {
    expect({ alpha: await staffAlerts("alpha"), beta: await staffAlerts("beta") }).toEqual(alertsBefore);
  });

  it("logs a security event for each mismatch, without the payload [OBE-078 AC3]", () => {
    for (const [name, { eventId, check, endpoint }] of Object.entries(forged)) {
      if (check === "") {
        continue;
      }
      const security = securityEventsOf(eventId);
      expect([name, security]).toEqual([
        name,
        [expect.objectContaining({ check, endpoint, eventType: expect.any(String) as unknown, level: 40 })],
      ]);
      // Ids only: no metadata, no amounts, no client secret.
      expect(JSON.stringify(security)).not.toContain("_secret_");
      expect(JSON.stringify(security)).not.toContain(betaPaymentId);
    }
    // Beta's payment named in alpha: alpha has no such payment, so the event is acknowledged as an unknown payment.
    const named = forged["connect: beta's payment in alpha"];
    expect(
      api.sink
        .records()
        .filter((line) => line["eventId"] === named?.eventId && line["msg"] === "payments.webhook_ignored"),
    ).toEqual([expect.objectContaining({ outcome: "payment_unknown", tenantId: alphaId })]);
  });

  it("logs no signing secret, Stripe key, signature or client secret in either process", () => {
    const logged = `${api.sink.text()}\n${workerSink.text()}`;
    for (const secret of [
      CONNECT_SECRET,
      CONNECT_SECRET_LIVE,
      ALPHA_WEBHOOK_SECRET,
      BETA_WEBHOOK_SECRET,
      SECRET_KEY,
      ALPHA_SECRET_KEY,
      BETA_SECRET_KEY,
      "_secret_",
      "v1=",
    ]) {
      expect([secret, logged.includes(secret)]).toEqual([secret, false]);
    }
  });
});
