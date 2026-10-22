// The console payments (OBE-068; ota/docs/api-changes-console-and-internal.md §3, ota/docs/flows/console-operations.md
// §3 step 5, OADR-0010 points 1, 3, 5 and 6): console.payments.list, get, capture and refund against PostgreSQL 16,
// Redis 7 and a fake of the Stripe API, through the API's whole pipeline (guards, validation, idempotency, the audit
// interceptor). Both processes run in-process, as in the webhook tests (OBE-039):
//
//   - the API's module graph (createTestApp), whose `stripe` client sends its requests to test/helpers/fake-stripe.ts;
//   - the worker's module graph (WorkerModule.forRoot), whose `ota-payments` consumer sends a refund the console asked
//     for (`refund.submit`) and whose `ota-stripe-events` consumer applies the refund webhook that follows.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does (alpha in test with its `velexis` test payment connection, beta with its own; accounts and
// memberships of each role; a `console:automation` key of alpha listing `payments:refund`). Staff sign in through the
// OTA admin's service key with portal tokens, each admin client with an end-user IP address of its own. Payments and
// bookings are written straight into the tenant schemas as checkout.createPayment, the webhooks and the booking
// orchestration leave them, with their PaymentIntents in the fake; the Stripe keys and the webhook secret are built at
// run time. Every answer is checked against the OTA document (`expectResponseToMatch`). Lead decision 6 of 2026-10-22:
// a refund request writes the customer-visible booking event `refund.requested`, and only Stripe's answer (the
// webhook) writes `refund.succeeded`.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Module, type INestApplicationContext } from "@nestjs/common";
import { hashApiKey, sha256Hex } from "@velexis/crypto";
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
import { signedStripeEvent, STRIPE_SIGNATURE_HEADER } from "@velexis/testing/stripe";
import type { Job, Queue } from "bullmq";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { loadWorkerConfig } from "../../../src/config";
import { PAYMENT_JOB, paymentJob } from "../../../src/payments/payments.processor";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { newApiKey, testApiCredentials, testWorkerVariables } from "../../helpers/api-env";
import {
  startFakeStripe,
  stripeEndpointModule,
  type FakePaymentIntent,
  type FakeStripe,
} from "../../helpers/fake-stripe";
import { probeLockOrder, type LockOrderObservation } from "../../helpers/lock-order";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Role = "owner" | "admin" | "agent" | "finance" | "viewer";
type JsonObject = Record<string, unknown>;

/**
 * Cloning the template, starting the API's graph (it parses the OTA document) and the worker's (BullMQ connections),
 * and the first sign-in: a few seconds alone, more while every package's integration tests run on a 4-CPU runner. The
 * bound only stops a start-up that hangs.
 */
const SETUP_TIMEOUT_MS = 90_000;
/** A scenario makes a few calls and may wait for the worker; the bound only stops one that hangs. */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for the worker. */
const WAIT_MS = 20_000;

const DAY_MS = 24 * 60 * 60_000;
const PAYMENTS = "/v1/console/payments";
const WEBHOOK = "/webhooks/stripe/velexis/test";

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
let paymentsQueue: Queue;
let stripeEvents: Queue;
let alphaId: string;
let alphaConnectionId: string;
let betaConnectionId: string;
let automationKey: string;
let automationKeyId: string;

const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", run);
const betaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_beta", run);

/** A fresh Stripe-shaped id of this run (`pi_test_…`). */
const stripeId = (prefix: string): string => `${prefix}_test_${randomBytes(10).toString("hex")}`;

// ---- Platform rows -------------------------------------------------------------------------------------------------

/** An active test tenant with its default `velexis` test payment connection, as the platform writes them. */
async function insertTenant(key: "alpha" | "beta"): Promise<{ id: string; connectionId: string }> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  const connectionId = newId("ppc");
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id: connectionId,
      tenant_id: id,
      provider: "stripe",
      environment: "test",
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
    })
    .execute();
  return { id, connectionId };
}

/** A secret test key of alpha with `scopes` (a `console:automation` key lists its permissions). */
async function issueKey(scopes: string[]): Promise<{ key: string; id: string }> {
  const key = newApiKey("sk", "test");
  const id = newId("key");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id,
      tenant_id: alphaId,
      name: `Automation (${scopes.join(", ")})`,
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      scopes,
    })
    .execute();
  return { key, id };
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

  get(path: string) {
    return request(api.server).get(path).set(this.headers());
  }

  capture(paymentId: string, ifMatch: string, body: JsonObject, key: string = randomUUID()) {
    return request(api.server)
      .post(`${PAYMENTS}/${paymentId}/capture`)
      .set({ ...this.headers(), "If-Match": ifMatch, "Idempotency-Key": key })
      .send(body);
  }

  refund(paymentId: string, body: JsonObject, key: string = randomUUID()) {
    return request(api.server)
      .post(`${PAYMENTS}/${paymentId}/refunds`)
      .set({ ...this.headers(), "Idempotency-Key": key })
      .send(body);
  }
}

const sessions = new Map<Role, AdminSession>();

/** A signed-in staff member of `role` (one per role and file). */
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

/** A confirmed booking of alpha that waits for its money (OBE-042: the manual review policy). */
async function insertBooking(): Promise<string> {
  const id = newId("bkg");
  const departure = new Date(Date.now() + 30 * DAY_MS);
  await alphaTx(async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: `VX${randomBytes(3).toString("hex").toUpperCase()}`,
        status: "confirmed",
        ticketing_status: "manual_review",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 3 * 60 * 60_000),
        currency: "EUR",
        net_amount: "400.00",
        total_amount: "452.10",
        contact_email: "traveller@example.com",
        lead_last_name: "SAMPLE",
      })
      .execute();
  });
  return id;
}

interface PaymentSeed {
  readonly status: string;
  readonly bookingId?: string | null;
  readonly amountAuthorized?: string;
  readonly amountCaptured?: string;
  readonly amountRefunded?: string;
  readonly environment?: "test" | "live";
  readonly provider?: "stripe" | "airline";
  readonly connectionId?: string | null;
  readonly createdAt?: Date;
}

/** A card payment of 452.10 EUR in `tenant`, as checkout.createPayment and the webhooks leave it in `status`. */
async function insertPayment(
  seed: PaymentSeed,
  tenant: "alpha" | "beta" = "alpha",
): Promise<{ id: string; intentId: string | null }> {
  const id = newId("pay");
  const airline = seed.provider === "airline";
  const intentId = airline ? null : stripeId("pi");
  const confirmed = seed.status !== "requires_payment_method" && seed.status !== "requires_action";
  await (tenant === "alpha" ? alphaTx : betaTx)(async (trx) => {
    await trx
      .insertInto("payments")
      .values({
        id,
        environment: seed.environment ?? "test",
        booking_id: seed.bookingId ?? null,
        provider: airline ? "airline" : "stripe",
        provider_connection_id: airline
          ? null
          : seed.connectionId === undefined
            ? alphaConnectionId
            : seed.connectionId,
        provider_payment_id: intentId,
        method: airline ? "airline_card" : "card",
        capture_method: airline ? "automatic" : "manual",
        currency: "EUR",
        amount: "452.10",
        amount_authorized: seed.amountAuthorized ?? (confirmed ? "452.10" : "0"),
        amount_captured: seed.amountCaptured ?? "0",
        amount_refunded: seed.amountRefunded ?? "0",
        status: seed.status,
        card_brand: "VISA",
        card_last4: confirmed ? "4242" : null,
        authorized_at: confirmed ? new Date(Date.now() - DAY_MS) : null,
        captured_at: ["captured", "partially_refunded", "refunded"].includes(seed.status) ? new Date() : null,
        three_ds: airline ? null : JSON.stringify({ required: false, status: "not_required", version: null }),
        metadata: JSON.stringify({}),
        version: 1,
        ...(seed.createdAt === undefined ? {} : { created_at: seed.createdAt, updated_at: seed.createdAt }),
      })
      .execute();
  });
  return { id, intentId };
}

/** The PaymentIntent the fake Stripe API answers for a payment of alpha (authorised for 452.10 EUR by default). */
function putIntent(intentId: string, paymentId: string, patch: Partial<FakePaymentIntent> = {}): void {
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
    metadata: metadataOf(paymentId),
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

/** The Velexis metadata of alpha's payment, as the gateway writes it on every PaymentIntent. */
const metadataOf = (paymentId: string): Record<string, string> => ({
  velexis_tenant_id: alphaId,
  velexis_environment: "test",
  payment_id: paymentId,
});

/** A Stripe payment of alpha with its PaymentIntent in the fake. */
async function stripePayment(seed: PaymentSeed, intent: Partial<FakePaymentIntent> = {}) {
  const payment = await insertPayment(seed);
  if (payment.intentId === null) {
    throw new Error("a Stripe payment has a PaymentIntent");
  }
  putIntent(payment.intentId, payment.id, intent);
  return { id: payment.id, intentId: payment.intentId };
}

async function paymentRow(id: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("payments")
      .select([
        "status",
        "version",
        sql<string>`amount_captured::text`.as("amountCaptured"),
        sql<string>`amount_authorized::text`.as("amountAuthorized"),
      ])
      .where("id", "=", id)
      .executeTakeFirstOrThrow(),
  );
}

const paymentEventsOf = (paymentId: string) =>
  alphaTx((trx) =>
    trx
      .selectFrom("payment_events")
      .select(["type", "source", "status_from", "status_to", sql<string | null>`amount::text`.as("amount")])
      .where("payment_id", "=", paymentId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const bookingEventsOf = (bookingId: string) =>
  alphaTx((trx) =>
    trx
      .selectFrom("booking_events")
      .select(["type", "actor_type", "actor_id", "summary", "data", "visible_to_customer"])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const staffActionsOn = (paymentId: string) =>
  alphaTx((trx) =>
    trx
      .selectFrom("staff_actions")
      .select([
        "action",
        "outcome",
        "actor_type",
        "actor_id",
        "staff_id",
        "reason",
        "booking_id",
        "before",
        "after",
      ])
      .where("target_id", "=", paymentId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const refundsOf = (paymentId: string) =>
  alphaTx((trx) =>
    trx
      .selectFrom("refunds")
      .select([
        "id",
        "status",
        "reason",
        "reason_note",
        "requested_by_type",
        "requested_by_id",
        "provider_refund_id",
        sql<string>`amount::text`.as("amount"),
      ])
      .where("payment_id", "=", paymentId)
      .orderBy("created_at")
      .execute(),
  );

/** The Stripe requests about a PaymentIntent (its reads and captures). */
const stripeRequestsAbout = (intentId: string) =>
  stripe.requests.filter((entry) => entry.path.includes(intentId));

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

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

/** Waits until the job `id` of `queue` has finished (completed or failed) and answers it. */
async function finished(queue: Queue, id: string): Promise<Job> {
  return await waitFor(`the job ${id}`, async () => {
    const state = await queue.getJobState(id);
    return state === "completed" || state === "failed" ? await queue.getJob(id) : undefined;
  });
}

beforeAll(() => {
  preloadOpenApiDocument();
  // The response validators compile on their first check: here, with every status the tests check, not in a test.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["consoleListPayments", [200, 400]],
    ["consoleGetPayment", [200, 404, 502]],
    ["consoleCapturePayment", [200, 400, 402, 403, 409, 412, 422, 502]],
    ["consoleRefundPayment", [201, 403, 409, 422]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
}, OPENAPI_SETUP_TIMEOUT_MS);

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
  ({ id: alphaId, connectionId: alphaConnectionId } = await insertTenant("alpha"));
  ({ connectionId: betaConnectionId } = await insertTenant("beta"));
  ({ key: automationKey, id: automationKeyId } = await issueKey(["console:automation", "payments:refund"]));
  await alphaTx((trx) =>
    seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" }),
  );
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
  paymentsQueue = worker.get<Queue>(getQueueToken(OTA_QUEUE.payments), { strict: false });
  stripeEvents = worker.get<Queue>(getQueueToken(OTA_QUEUE.stripeEvents), { strict: false });
  // No scheduler iteration may fire while the file runs.
  const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
  // The first sign-ins and console calls of a process open the pools' connections and warm the token, validation and
  // Stripe code; done once here, so that no test pays for it.
  for (const role of ["owner", "admin", "agent", "finance", "viewer"] as const) {
    await staff(role);
  }
  const warm = await stripePayment({ status: "authorized" });
  const owner = await staff("owner");
  expect((await owner.get(`${PAYMENTS}?limit=1`)).status).toBe(200);
  expect((await owner.get(`${PAYMENTS}/${warm.id}?refresh=true`)).status).toBe(200);
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

// ---- console.payments.list -----------------------------------------------------------------------------------------

describe("console.payments.list", () => {
  const base = Date.now() - 300 * DAY_MS;
  let bookingId: string;
  let ids: string[];
  let liveId: string;
  let betaId: string;

  beforeAll(async () => {
    bookingId = await insertBooking();
    ids = [];
    // Three payments of one booking, a minute apart, the newest first in the list; a cancelled one among them.
    for (const [index, status] of (["captured", "canceled", "authorized"] as const).entries()) {
      const { id } = await insertPayment({
        status,
        bookingId,
        amountCaptured: status === "captured" ? "452.10" : "0",
        createdAt: new Date(base + index * 60_000),
      });
      ids.push(id);
    }
    // The live environment's payment of the same booking, and a payment of tenant beta with the same filters.
    ({ id: liveId } = await insertPayment({ status: "authorized", bookingId, environment: "live" }));
    ({ id: betaId } = await insertPayment({ status: "authorized", connectionId: betaConnectionId }, "beta"));
  }, SCENARIO_TIMEOUT_MS);

  it("lists the environment's payments newest first, page by page, with their booking and account mode", async () => {
    const viewer = await staff("viewer");
    const first = await viewer.get(`${PAYMENTS}?bookingId=${bookingId}&limit=2`);
    expect(answer(first)).toEqual([200, undefined]);
    expectResponseToMatch("consoleListPayments", first);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    const page = first.body as { data: JsonObject[]; page: { nextCursor: string | null; limit: number } };
    expect(page.data.map((payment) => payment["id"])).toEqual([ids[2], ids[1]]);
    expect(page.page).toEqual({ nextCursor: expect.any(String), limit: 2 });
    expect(page.data[0]).toMatchObject({
      environment: "test",
      version: 1,
      status: "authorized",
      clientSecret: null,
      providerPublicKey: null,
      booking: { id: bookingId, reference: expect.stringMatching(/^VX/), status: "confirmed" },
      providerConnection: { accountMode: "velexis" },
      events: [],
      refunds: [],
    });
    // The stored `canceled` in the API's spelling.
    expect(page.data[1]).toMatchObject({ status: "cancelled" });

    const second = await viewer.get(
      `${PAYMENTS}?bookingId=${bookingId}&limit=2&cursor=${String(page.page.nextCursor)}`,
    );
    expect(answer(second)).toEqual([200, undefined]);
    expect((second.body.data as JsonObject[]).map((payment) => payment["id"])).toEqual([ids[0]]);
    expect(second.body.page).toEqual({ nextCursor: null, limit: 2 });
    // The live payment and beta's never show in alpha's test list.
    const all = [...page.data, ...(second.body.data as JsonObject[])].map((payment) => payment["id"]);
    expect(all).not.toContain(liveId);
    expect(all).not.toContain(betaId);
  });

  it("filters by status (cancelled for the stored canceled), provider, method and creation time", async () => {
    const viewer = await staff("viewer");
    const ofBooking = (query: string) => viewer.get(`${PAYMENTS}?bookingId=${bookingId}&${query}`);
    const idsOf = (res: Response) => (res.body.data as JsonObject[]).map((payment) => payment["id"]);
    expect(idsOf(await ofBooking("status=cancelled,captured"))).toEqual([ids[1], ids[0]]);
    expect(idsOf(await ofBooking("provider=airline"))).toEqual([]);
    expect(idsOf(await ofBooking("method=card&provider=stripe"))).toEqual([ids[2], ids[1], ids[0]]);
    const from = new Date(base + 60_000).toISOString();
    const to = new Date(base + 2 * 60_000).toISOString();
    expect(idsOf(await ofBooking(`createdFrom=${from}&createdTo=${to}`))).toEqual([ids[1]]);
  });

  it("refuses a cursor of another list with 400 VALIDATION_FAILED at /query/cursor", async () => {
    const viewer = await staff("viewer");
    const first = await viewer.get(`${PAYMENTS}?bookingId=${bookingId}&limit=1`);
    const cursor = String(first.body.page.nextCursor);
    const other = await viewer.get(
      `${PAYMENTS}?bookingId=${bookingId}&status=captured&limit=1&cursor=${cursor}`,
    );
    expect(answer(other)).toEqual([400, "VALIDATION_FAILED"]);
    expect(other.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/query/cursor" })]);
    expect((await viewer.get(`${PAYMENTS}?cursor=not-a-cursor`)).status).toBe(400);
  });
});

// ---- console.payments.get ------------------------------------------------------------------------------------------

describe("console.payments.get", () => {
  it("answers one payment with its ETag, writes no staff action, and 404 for another environment or tenant", async () => {
    const viewer = await staff("viewer");
    const { id } = await stripePayment({ status: "authorized" });
    const res = await viewer.get(`${PAYMENTS}/${id}`);
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetPayment", res);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.body).toMatchObject({
      id,
      clientSecret: null,
      providerConnection: { accountMode: "velexis" },
    });
    expect(await staffActionsOn(id)).toEqual([]);

    const { id: liveId } = await insertPayment({ status: "authorized", environment: "live" });
    expect(answer(await viewer.get(`${PAYMENTS}/${liveId}`))).toEqual([404, "NOT_FOUND"]);
    const { id: betaId } = await insertPayment(
      { status: "authorized", connectionId: betaConnectionId },
      "beta",
    );
    expect(answer(await viewer.get(`${PAYMENTS}/${betaId}`))).toEqual([404, "NOT_FOUND"]);
    // A payment of alpha that names beta's connection shows no account mode of another tenant.
    const { id: crossed } = await insertPayment({ status: "authorized", connectionId: betaConnectionId });
    expect((await viewer.get(`${PAYMENTS}/${crossed}`)).body.providerConnection).toBeNull();
  });

  it("applies the PaymentIntent read again with refresh=true, as a webhook would", async () => {
    const agent = await staff("agent");
    const { id, intentId } = await stripePayment({ status: "requires_action" });
    stripe.reset();
    const res = await agent.get(`${PAYMENTS}/${id}?refresh=true`);
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetPayment", res);
    expect(stripeRequestsAbout(intentId).map((entry) => entry.method)).toEqual(["GET"]);
    expect(res.body).toMatchObject({
      status: "authorized",
      version: 2,
      amountAuthorized: { amount: "452.10" },
    });
    expect(res.headers["etag"]).toBe('"2"');
    expect(await paymentEventsOf(id)).toEqual([
      expect.objectContaining({
        type: "payment.authorized",
        source: "staff",
        status_from: "requires_action",
        status_to: "authorized",
      }),
    ]);
  });

  it("answers 502 PAYMENT_PROVIDER_ERROR when Stripe is out of reach, and changes nothing", async () => {
    const agent = await staff("agent");
    const { id } = await stripePayment({ status: "requires_action" });
    // The connection and the SDK's one retry.
    stripe.fail(2, "drop");
    const res = await agent.get(`${PAYMENTS}/${id}?refresh=true`);
    stripe.reset();
    expect(answer(res)).toEqual([502, "PAYMENT_PROVIDER_ERROR"]);
    expectResponseToMatch("consoleGetPayment", res);
    expect(await paymentRow(id)).toMatchObject({ status: "requires_action", version: 1 });
  });

  it("answers an airline-card payment as stored, without a Stripe call or a connection", async () => {
    const agent = await staff("agent");
    const { id } = await insertPayment({ status: "captured", provider: "airline", amountCaptured: "452.10" });
    stripe.reset();
    const res = await agent.get(`${PAYMENTS}/${id}?refresh=true`);
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetPayment", res);
    expect(stripe.requests).toEqual([]);
    expect(res.body).toMatchObject({ provider: "airline", method: "airline_card", providerConnection: null });
  });
});

// ---- console.payments.capture --------------------------------------------------------------------------------------

describe("console.payments.capture twice with the same key", () => {
  let bookingId: string;
  let paymentId: string;
  let intentId: string;
  let answers: Response[];
  let lockOrder: LockOrderObservation | undefined;

  beforeAll(async () => {
    bookingId = await insertBooking();
    ({ id: paymentId, intentId } = await stripePayment({ status: "authorized", bookingId }));
    const finance = await staff("finance");
    const key = randomUUID();
    const body = { reason: "Manual review passed; booking confirmed with the airline" };
    stripe.reset();
    // While Stripe captures (no transaction open), a second transaction takes the booking: the capture's record must
    // wait for it holding nothing of the payment (the booking, then the payment: OADR-0003 point 11).
    let probe: ReturnType<typeof probeLockOrder> | undefined;
    stripe.onRequest(async (req) => {
      if (req.method !== "POST" || !req.path.endsWith("/capture") || probe !== undefined) {
        return;
      }
      probe = probeLockOrder(tenantDb, "tenant_alpha", { bookingId, paymentId });
      await probe.locked;
    });
    try {
      answers = [await finance.capture(paymentId, '"1"', body, key)];
      lockOrder = await probe?.result;
    } finally {
      stripe.onRequest(undefined);
    }
    answers.push(await finance.capture(paymentId, '"1"', body, key));
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-068 AC2] captures once: one Stripe capture, the same answer twice", () => {
    const captures = stripeRequestsAbout(intentId).filter((entry) => entry.path.endsWith("/capture"));
    expect(captures).toHaveLength(1);
    expect(captures[0]?.headers["idempotency-key"]).toBe(`pi:capture:${paymentId}:452.10`);
    expect(captures[0]?.form).toMatchObject({ amount_to_capture: "45210" });
    for (const res of answers) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("consoleCapturePayment", res);
      expect(res.headers["etag"]).toBe('"2"');
    }
    expect(answers[1]?.body).toEqual(answers[0]?.body);
    expect(answers[0]?.body).toMatchObject({
      status: "captured",
      version: 2,
      amountCaptured: { amount: "452.10", currency: "EUR" },
      capturedAt: expect.any(String),
    });
  });

  it("[OBE-068 AC2] records one capture: the payment event, the booking's payment and the staff action", async () => {
    expect((await paymentEventsOf(paymentId)).filter((event) => event.type === "payment.captured")).toEqual([
      expect.objectContaining({
        source: "staff",
        status_from: "authorized",
        status_to: "captured",
        amount: "452.10",
      }),
    ]);
    const finance = await staff("finance");
    expect(await bookingEventsOf(bookingId)).toEqual([
      expect.objectContaining({
        type: "payment.captured",
        actor_type: "staff",
        actor_id: finance.member.staffId,
        summary: "Payment received.",
        visible_to_customer: true,
      }),
    ]);
    const amountPaid = await alphaTx((trx) =>
      trx
        .selectFrom("bookings")
        .select(sql<string>`amount_paid::text`.as("amountPaid"))
        .where("id", "=", bookingId)
        .executeTakeFirstOrThrow(),
    );
    expect(amountPaid.amountPaid).toBe("452.10");
    expect(await staffActionsOn(paymentId)).toEqual([
      expect.objectContaining({
        action: "payment.capture",
        outcome: "succeeded",
        staff_id: finance.member.staffId,
        booking_id: bookingId,
        reason: "Manual review passed; booking confirmed with the airline",
        before: expect.objectContaining({ status: "authorized", version: 1 }),
        after: expect.objectContaining({ status: "captured", amountCaptured: "452.10", version: 2 }),
      }),
      // The idempotent replay keeps its own succeeded row (OADR-0011 point 8 as decided on 2026-10-21), with the
      // operation's action and nothing the use case would know: its use case did not run.
      expect.objectContaining({
        action: "payments.capture",
        outcome: "succeeded",
        staff_id: finance.member.staffId,
        reason: null,
        before: null,
        after: null,
      }),
    ]);
  });

  it("locks the booking before the payment: the payment is free while the capture waits", () => {
    expect(lockOrder).toEqual({ waiterSeen: true, paymentFree: true });
  });
});

describe("console.payments.capture", () => {
  it("captures part of the authorisation and releases the rest at Stripe", async () => {
    const agent = await staff("agent");
    const { id, intentId } = await stripePayment({ status: "authorized" });
    stripe.reset();
    const res = await agent.capture(id, '"1"', {
      amount: { amount: "400.00", currency: "EUR" },
      reason: "One traveller dropped before issuance",
    });
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleCapturePayment", res);
    const [capture] = stripeRequestsAbout(intentId).filter((entry) => entry.path.endsWith("/capture"));
    expect(capture?.form).toMatchObject({ amount_to_capture: "40000" });
    expect(capture?.headers["idempotency-key"]).toBe(`pi:capture:${id}:400.00`);
    expect(res.body).toMatchObject({ status: "captured", amountCaptured: { amount: "400.00" } });
  });

  it("refuses a stale If-Match, a payment that is not authorised and amounts the rules refuse", async () => {
    const agent = await staff("agent");
    const { id } = await stripePayment({ status: "authorized" });
    const reason = { reason: "Manual review passed" };
    stripe.reset();
    const stale = await agent.capture(id, '"7"', reason);
    expect(answer(stale)).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("consoleCapturePayment", stale);
    const above = await agent.capture(id, '"1"', {
      ...reason,
      amount: { amount: "452.11", currency: "EUR" },
    });
    expect(answer(above)).toEqual([422, "UNPROCESSABLE"]);
    expectResponseToMatch("consoleCapturePayment", above);
    expect(above.body.error.details).toEqual({
      reason: "amount_exceeds_authorized",
      authorized: { amount: "452.10", currency: "EUR" },
    });
    const currency = await agent.capture(id, '"1"', {
      ...reason,
      amount: { amount: "10.00", currency: "USD" },
    });
    expect([...answer(currency), currency.body.error.details]).toEqual([
      422,
      "UNPROCESSABLE",
      { reason: "currency_mismatch", currency: "EUR" },
    ]);
    const decimals = await agent.capture(id, '"1"', {
      ...reason,
      amount: { amount: "10.001", currency: "EUR" },
    });
    expect(answer(decimals)).toEqual([400, "VALIDATION_FAILED"]);
    expect(decimals.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/amount/amount" })]);
    expect(
      answer(await agent.capture(id, '"1"', { ...reason, amount: { amount: "0", currency: "EUR" } })),
    ).toEqual([400, "VALIDATION_FAILED"]);
    // Nothing reached Stripe, and the payment is as it was.
    expect(stripe.requests).toEqual([]);
    expect(await paymentRow(id)).toMatchObject({ status: "authorized", version: 1 });

    const { id: captured } = await stripePayment({ status: "captured", amountCaptured: "452.10" });
    const again = await agent.capture(captured, '"1"', reason);
    expect(answer(again)).toEqual([409, "CONFLICT"]);
    expectResponseToMatch("consoleCapturePayment", again);
    expect(again.body.error.details).toEqual({
      reason: "payment_not_capturable",
      status: "captured",
      provider: "stripe",
    });
    const { id: airline } = await insertPayment({ status: "authorized", provider: "airline" });
    expect((await agent.capture(airline, '"1"', reason)).body.error.details).toMatchObject({
      reason: "payment_not_capturable",
      provider: "airline",
    });
  });

  it("answers 402 PAYMENT_DECLINED for an authorisation that expired at Stripe, and records the cancellation", async () => {
    const agent = await staff("agent");
    const { id, intentId } = await stripePayment({ status: "authorized" });
    // Stripe cancelled the PaymentIntent when its authorisation expired: the capture is refused, the read shows why.
    stripe.update(intentId, { status: "canceled", amount_capturable: 0 });
    stripe.fail(1, "refused");
    const res = await agent.capture(id, '"1"', { reason: "Manual review passed" });
    stripe.reset();
    expect(answer(res)).toEqual([402, "PAYMENT_DECLINED"]);
    expectResponseToMatch("consoleCapturePayment", res);
    expect(await paymentRow(id)).toMatchObject({ status: "canceled", version: 2 });
    // The audit interceptor's row of a failed call, with the operation's action (staff-actions.writer.ts).
    expect(await staffActionsOn(id)).toEqual([
      expect.objectContaining({ action: "payments.capture", outcome: "failed" }),
    ]);
  });

  it("answers 502 when Stripe is out of reach, and captures on the retry with the same key", async () => {
    const agent = await staff("agent");
    const { id, intentId } = await stripePayment({ status: "authorized" });
    const key = randomUUID();
    // The capture and the SDK's one retry are dropped; the read that follows shows the payment still authorised.
    stripe.fail(2, "drop");
    const failed = await agent.capture(id, '"1"', { reason: "Manual review passed" }, key);
    expect(answer(failed)).toEqual([502, "PAYMENT_PROVIDER_ERROR"]);
    expectResponseToMatch("consoleCapturePayment", failed);
    expect(await paymentRow(id)).toMatchObject({ status: "authorized", version: 1 });
    const retried = await agent.capture(id, '"1"', { reason: "Manual review passed" }, key);
    expect(answer(retried)).toEqual([200, undefined]);
    const keys = stripeRequestsAbout(intentId)
      .filter((entry) => entry.path.endsWith("/capture"))
      .map((entry) => entry.headers["idempotency-key"]);
    expect(new Set(keys)).toEqual(new Set([`pi:capture:${id}:452.10`]));
    stripe.reset();
  });

  it("is refused to a viewer with 403 FORBIDDEN and an audited denial", async () => {
    const viewer = await staff("viewer");
    const { id } = await stripePayment({ status: "authorized" });
    const res = await viewer.capture(id, '"1"', { reason: "Manual review passed" });
    expect(answer(res)).toEqual([403, "FORBIDDEN"]);
    expect(res.body.error.details).toMatchObject({ requiredPermission: "payments:capture" });
    expect(await staffActionsOn(id)).toEqual([
      expect.objectContaining({
        action: "payments.capture",
        outcome: "denied",
        staff_id: viewer.member.staffId,
      }),
    ]);
  });
});

// ---- console.payments.refund ---------------------------------------------------------------------------------------

describe("console.payments.refund by finance, sent by the payments queue and finished by Stripe's webhook", () => {
  let bookingId: string;
  let paymentId: string;
  let intentId: string;
  let res: Response;
  let lockOrder: LockOrderObservation;
  let webhookLockOrder: LockOrderObservation;
  let eventsAtRequest: Awaited<ReturnType<typeof bookingEventsOf>>;
  let submitJob: Job;
  let refundId: string;

  beforeAll(async () => {
    bookingId = await insertBooking();
    ({ id: paymentId, intentId } = await stripePayment(
      { status: "captured", bookingId, amountCaptured: "452.10" },
      { status: "succeeded", amount_capturable: 0, amount_received: 45210 },
    ));
    const finance = await staff("finance");
    stripe.reset();
    // A second transaction holds the booking first: the refund's transaction waits for it holding nothing of the
    // payment (the booking, then the payment: OADR-0003 point 11).
    const probe = probeLockOrder(tenantDb, "tenant_alpha", { bookingId, paymentId });
    await probe.locked;
    res = await finance.refund(paymentId, {
      amount: { amount: "50.00", currency: "EUR" },
      reason: "goodwill",
      reasonNote: "Delayed outbound flight, agreed with the customer by phone",
    });
    lockOrder = await probe.result;
    eventsAtRequest = await bookingEventsOf(bookingId);
    refundId = String((res.body.refunds as JsonObject[] | undefined)?.[0]?.["id"]);
    // The payments queue sends it (refund.submit, the worker); Stripe then reports it succeeded with a webhook.
    submitJob = await finished(
      paymentsQueue,
      paymentJob(PAYMENT_JOB.refundSubmit, alphaId, refundId).opts.jobId,
    );
    const [submitted] = stripe.requests.filter(
      (entry) => entry.method === "POST" && entry.path === "/v1/refunds",
    );
    const providerRefundId = [...stripe.refunds.keys()].find(
      (id) => (stripe.refunds.get(id)?.["metadata"] as JsonObject | undefined)?.["refund_id"] === refundId,
    );
    if (submitted === undefined || providerRefundId === undefined) {
      throw new Error("the refund did not reach Stripe");
    }
    const chargeId = stripeId("ch");
    stripe.refunds.set(providerRefundId, {
      ...(stripe.refunds.get(providerRefundId) ?? { id: providerRefundId }),
      charge: chargeId,
      status: "succeeded",
      currency: "eur",
    });
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
    const eventId = stripeId("evt");
    const delivery = signedStripeEvent(
      "charge.refunded",
      {
        id: eventId,
        data: { object: { id: chargeId, payment_intent: intentId, metadata: metadataOf(paymentId) } },
      },
      SECRET,
    );
    // While the worker applies Stripe's answer, a second transaction holds the booking: the webhook's transaction,
    // which writes the booking's refund.succeeded event, must wait for it holding nothing of the payment (applyRefunds
    // locks the refunds' bookings, then the payment: OADR-0003 point 11). The receiver locks no booking.
    const webhookProbe = probeLockOrder(tenantDb, "tenant_alpha", { bookingId, paymentId });
    await webhookProbe.locked;
    const delivered = await request(api.server)
      .post(WEBHOOK)
      .set(STRIPE_SIGNATURE_HEADER, delivery.header)
      .set("Content-Type", "application/json; charset=utf-8")
      .send(delivery.payload);
    expect(delivered.status).toBe(200);
    webhookLockOrder = await webhookProbe.result;
    await finished(stripeEvents, eventId);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-068 AC1] lets a finance user refund: 201 with the pending refund, no Stripe call in the request", async () => {
    expect(answer(res)).toEqual([201, undefined]);
    expectResponseToMatch("consoleRefundPayment", res);
    expect(res.headers["location"]).toBe(`${PAYMENTS}/${paymentId}`);
    expect(res.headers["etag"]).toBe('"1"');
    const finance = await staff("finance");
    expect(res.body).toMatchObject({
      id: paymentId,
      status: "captured",
      refunds: [
        {
          id: expect.stringMatching(/^rfd_/),
          amount: { amount: "50.00", currency: "EUR" },
          reason: "goodwill",
          status: "pending",
          reasonNote: "Delayed outbound flight, agreed with the customer by phone",
          requestedBy: { type: "staff", id: finance.member.staffId },
          providerRefundId: null,
        },
      ],
    });
    expect((res.body.events as JsonObject[]).map((event) => event["type"])).toContain("refund.requested");
    expect(await staffActionsOn(paymentId)).toEqual([
      expect.objectContaining({
        action: "payment.refund",
        outcome: "succeeded",
        staff_id: finance.member.staffId,
        booking_id: bookingId,
        reason: "Delayed outbound flight, agreed with the customer by phone",
        after: expect.objectContaining({ refundId, amount: "50.00", status: "pending" }),
      }),
    ]);
  });

  it("shows the customer a refund asked for, and refunded only once Stripe says so (lead decision 6)", async () => {
    // At the request: refund.requested, worded as asked for; nothing says refunded.
    expect(eventsAtRequest).toEqual([
      {
        type: "refund.requested",
        actor_type: "staff",
        actor_id: (await staff("finance")).member.staffId,
        summary: "Refund of 50.00 EUR requested.",
        data: { refundId, paymentId, amount: "50.00", currency: "EUR" },
        visible_to_customer: true,
      },
    ]);
    // After Stripe's answer (the webhook): refund.succeeded, never payment.refunded.
    const events = await bookingEventsOf(bookingId);
    expect(events.map((event) => event.type)).toEqual(["refund.requested", "refund.succeeded"]);
    expect(events[1]).toMatchObject({
      actor_type: "system",
      summary: "Refund of 50.00 EUR completed.",
      data: { refundId, paymentId, amount: "50.00", currency: "EUR" },
      visible_to_customer: true,
    });
  });

  it("queues refund.submit, which sends refund:<rfd_id> to Stripe; the webhook finishes the refund", async () => {
    expect(submitJob.returnvalue).toMatchObject({ outcome: "applied" });
    const [submitted] = stripe.requests.filter(
      (entry) => entry.method === "POST" && entry.path === "/v1/refunds",
    );
    expect(submitted?.headers["idempotency-key"]).toBe(`refund:${refundId}`);
    expect(submitted?.form).toMatchObject({ amount: "5000", payment_intent: intentId });
    expect(await refundsOf(paymentId)).toEqual([
      expect.objectContaining({
        id: refundId,
        status: "succeeded",
        requested_by_type: "staff",
        amount: "50.00",
      }),
    ]);
    const viewer = await staff("viewer");
    const after = await viewer.get(`${PAYMENTS}/${paymentId}`);
    expectResponseToMatch("consoleGetPayment", after);
    expect(after.body).toMatchObject({
      status: "partially_refunded",
      amountRefunded: { amount: "50.00" },
      refunds: [expect.objectContaining({ id: refundId, status: "succeeded" })],
    });
  });

  it("locks the booking before the payment: the payment is free while the refund waits", () => {
    expect(lockOrder).toEqual({ waiterSeen: true, paymentFree: true });
  });

  it("locks the refund's booking before the payment when Stripe's answer writes refund.succeeded", () => {
    expect(webhookLockOrder).toEqual({ waiterSeen: true, paymentFree: true });
  });
});

describe("console.payments.refund", () => {
  it("[OBE-068 AC1] is refused to an agent with 403 FORBIDDEN, audited, and nothing is asked for", async () => {
    const agent = await staff("agent");
    const { id } = await stripePayment({ status: "captured", amountCaptured: "452.10" });
    const res = await agent.refund(id, { amount: { amount: "10.00", currency: "EUR" }, reason: "goodwill" });
    expect(answer(res)).toEqual([403, "FORBIDDEN"]);
    expectResponseToMatch("consoleRefundPayment", res);
    expect(res.body.error.details).toMatchObject({ requiredPermission: "payments:refund" });
    expect(await refundsOf(id)).toEqual([]);
    expect(await staffActionsOn(id)).toEqual([
      expect.objectContaining({
        action: "payments.refund",
        outcome: "denied",
        staff_id: agent.member.staffId,
      }),
    ]);
  });

  it("[OBE-068 AC1] answers 422 amount_exceeds_captured above the captured amount less refunds and refunds in flight", async () => {
    const finance = await staff("finance");
    const { id } = await stripePayment({
      status: "partially_refunded",
      amountCaptured: "452.10",
      amountRefunded: "52.10",
    });
    const over = await finance.refund(id, {
      amount: { amount: "400.01", currency: "EUR" },
      reason: "goodwill",
    });
    expect(answer(over)).toEqual([422, "UNPROCESSABLE"]);
    expectResponseToMatch("consoleRefundPayment", over);
    expect(over.body.error.details).toEqual({
      reason: "amount_exceeds_captured",
      refundable: { amount: "400.00", currency: "EUR" },
    });
    // A refund in flight counts too.
    expect(
      (await finance.refund(id, { amount: { amount: "300.00", currency: "EUR" }, reason: "goodwill" }))
        .status,
    ).toBe(201);
    const second = await finance.refund(id, {
      amount: { amount: "100.01", currency: "EUR" },
      reason: "goodwill",
    });
    expect(second.body.error.details).toEqual({
      reason: "amount_exceeds_captured",
      refundable: { amount: "100.00", currency: "EUR" },
    });
    expect((await refundsOf(id)).map((refund) => refund.amount)).toEqual(["300.00"]);
  });

  it("refuses an airline-card payment (refund_via_airline), an uncaptured one and another currency", async () => {
    const finance = await staff("finance");
    const body = { amount: { amount: "10.00", currency: "EUR" }, reason: "goodwill" };
    const { id: airline } = await insertPayment({
      status: "captured",
      provider: "airline",
      amountCaptured: "452.10",
    });
    const viaAirline = await finance.refund(airline, body);
    expect([...answer(viaAirline), viaAirline.body.error.details]).toEqual([
      422,
      "UNPROCESSABLE",
      { reason: "refund_via_airline" },
    ]);
    expectResponseToMatch("consoleRefundPayment", viaAirline);
    const { id: authorized } = await stripePayment({ status: "authorized" });
    const notCaptured = await finance.refund(authorized, body);
    expect([...answer(notCaptured), notCaptured.body.error.details]).toEqual([
      409,
      "CONFLICT",
      { reason: "payment_not_refundable", status: "authorized", provider: "stripe" },
    ]);
    expectResponseToMatch("consoleRefundPayment", notCaptured);
    const { id: captured } = await stripePayment({ status: "captured", amountCaptured: "452.10" });
    const usd = await finance.refund(captured, { ...body, amount: { amount: "10.00", currency: "USD" } });
    expect(usd.body.error.details).toEqual({ reason: "currency_mismatch", currency: "EUR" });
    for (const id of [airline, authorized, captured]) {
      expect(await refundsOf(id)).toEqual([]);
    }
  });

  it("asks for one refund for two calls with the same key", async () => {
    const finance = await staff("finance");
    const { id } = await stripePayment({ status: "captured", amountCaptured: "452.10" });
    const key = randomUUID();
    const body = { amount: { amount: "20.00", currency: "EUR" }, reason: "duplicate" };
    const first = await finance.refund(id, body, key);
    const second = await finance.refund(id, body, key);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body).toEqual(first.body);
    expect(await refundsOf(id)).toHaveLength(1);
  });

  it("takes a console:automation key's refund as staff without a staff member, audited as the key", async () => {
    const { id } = await stripePayment({ status: "captured", amountCaptured: "452.10" });
    const res = await request(api.server)
      .post(`${PAYMENTS}/${id}/refunds`)
      .set({ "X-Api-Key": automationKey, "Idempotency-Key": randomUUID() })
      .send({ amount: { amount: "15.00", currency: "EUR" }, reason: "customer_request" });
    expect(answer(res)).toEqual([201, undefined]);
    expectResponseToMatch("consoleRefundPayment", res);
    expect((res.body.refunds as JsonObject[])[0]).toMatchObject({ requestedBy: { type: "staff", id: null } });
    expect(await refundsOf(id)).toEqual([
      expect.objectContaining({
        requested_by_type: "staff",
        requested_by_id: null,
        reason: "customer_request",
      }),
    ]);
    expect(await staffActionsOn(id)).toEqual([
      expect.objectContaining({ action: "payment.refund", actor_type: "api_key", actor_id: automationKeyId }),
    ]);
  });
});
