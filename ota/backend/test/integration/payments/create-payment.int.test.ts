// checkout.createPayment, checkout.getPayment, checkout.updatePayment and the payment section of storefront.get in
// `velexis` mode, against PostgreSQL 16, Redis 7, the Amadeus stub and a fake of the Stripe API (OBE-038;
// ota/docs/flows/checkout-stripe.md §2 steps 3–4, OADR-0010 points 1–3, 7, 8). Stripe is mocked at the HTTP layer:
// the API's own `stripe` SDK client sends its requests to test/helpers/fake-stripe.ts on the loopback interface, so
// the tests see the PaymentIntent exactly as Stripe would receive it, and the fake looks into the database while a
// request is in flight (the payment row must be committed before the PaymentIntent is created).
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned), writes the platform rows
// as the platform does (two tenants on the Velexis test Amadeus account, and the `velexis` test payment connection
// provisioning gives alpha; beta has none), seeds the storefront settings and the default markup rule, and calls the
// API in-process. Every checkout opens from a priced offer the API made from the stub's Madrid–Paris Orly offer 2
// (moved 60 days ahead, as the checkout tests do), gets its traveller and contact, and is then paid. The Stripe keys
// are built at run time. Every answer is checked against the OTA document (`expectResponseToMatch`).
import { randomBytes } from "node:crypto";
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
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../../../src/common/ids";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import {
  edgeHeaders,
  edgeWriteHeaders,
  newApiKey,
  testApiCredentials,
  testKeyProvider,
} from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const ALPHA_HOST = "alpha.ota.example.com";
const BETA_HOST = "beta.ota.example.com";
const ALPHA_ORIGIN = "https://shop.alpha-travel.example";
const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const DESCRIPTOR = "ALPHA TRAVEL";

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

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
let alphaPk: string;
let betaSk: string;

/** The response bodies of the secret-key test, counted there. */
const bodies: string[] = [];
/** Every response body of the file, refusals of the earlier tests included: the secret key is in none of them. */
const everyBody: string[] = [];

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

async function insertTenant(key: "alpha" | "beta"): Promise<string> {
  const id = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
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
  return id;
}

/** The `velexis` test connection, as the provisioning post-step `create_payment_connection` writes it (PBE-022). */
async function insertPaymentConnection(tenantId: string): Promise<string> {
  const id = newId("ppc");
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id,
      tenant_id: tenantId,
      provider: "stripe",
      environment: "test",
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
      statement_descriptor_suffix: DESCRIPTOR,
    })
    .execute();
  return id;
}

async function issueKey(tenantId: string, kind: "sk" | "pk" = "sk"): Promise<string> {
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
      ...(kind === "pk" ? { allowed_origins: [ALPHA_ORIGIN] } : {}),
    })
    .execute();
  return key;
}

const idempotencyKey = (): string => randomBytes(16).toString("hex");
const keyHeaders = (key: string): Record<string, string> => ({ "X-Api-Key": key });
const edgeWrite = (host = ALPHA_HOST): Record<string, string> => ({ ...edgeWriteHeaders(host) });
type Tenant = "alpha" | "beta";
const tx = <T>(tenant: Tenant, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, `tenant_${tenant}`, run);
const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> => tx("alpha", run);

/** Records the body of an answer for the secret-key check, and hands the answer back. */
function seen<T extends { text: string }>(res: T): T {
  bodies.push(res.text);
  everyBody.push(res.text);
  return res;
}

interface PaymentBody {
  readonly id: string;
  readonly checkoutId: string;
  readonly status: string;
  readonly captureMethod: string;
  readonly amount: { amount: string; currency: string };
  readonly cardFee: { amount: string; currency: string } | null;
  readonly cardHint: { brand: string; bin?: string } | null;
  readonly amountAuthorized: { amount: string; currency: string };
  readonly clientSecret: string | null;
  readonly providerPublicKey: string | null;
  readonly providerPaymentId: string | null;
  readonly nextAction: { type: string } | null;
  readonly card: { brand: string; last4: string } | null;
  readonly threeDSecure: { required: boolean; status: string };
  readonly authorizedAt?: string | null;
}

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    readonly fieldErrors?: Array<{ path: string; code: string }>;
  };
}

let searchCount = 0;

/** A priced offer of `tenant` for the stub's offer 2 of a new search, its flight moved 60 days ahead. */
async function newPricedOffer(headers: () => Record<string, string>, tenant: Tenant): Promise<string> {
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
  const offerId = await tx(tenant, async (trx) => {
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

interface CheckoutBody {
  readonly id: string;
  readonly status: string;
  readonly version: number;
  readonly expiresAt: string;
  readonly totals: {
    readonly offer: { amount: string };
    readonly cardFee: { amount: string } | null;
    readonly total: { amount: string; currency: string };
  };
  readonly termsAcceptedAt: string | null;
}

/** A guest checkout of alpha (or `tenant`), opened with `headers`, with its traveller and contact unless `complete` is false. */
async function newCheckout(
  headers: () => Record<string, string>,
  options: { readonly complete?: boolean; readonly tenant?: Tenant } = {},
): Promise<CheckoutBody> {
  const pricedOfferId = await newPricedOffer(headers, options.tenant ?? "alpha");
  const created = await request(api.server)
    .post("/v1/checkouts")
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({ pricedOfferId });
  expect(created.status).toBe(201);
  const checkout = created.body as CheckoutBody;
  if (options.complete === false) {
    return checkout;
  }
  const travelers = await request(api.server)
    .put(`/v1/checkouts/${checkout.id}/travelers`)
    .set(headers())
    .send({ travelers: [buildTravelerInput()] });
  expect(travelers.status).toBe(200);
  const contacts = await request(api.server)
    .put(`/v1/checkouts/${checkout.id}/contacts`)
    .set(headers())
    .send({ contacts: [buildContactInput()] });
  expect(contacts.status).toBe(200);
  return contacts.body as CheckoutBody;
}

const createPayment = (
  headers: Record<string, string>,
  checkoutId: string,
  body: object,
  key = idempotencyKey(),
) =>
  request(api.server)
    .post(`/v1/checkouts/${checkoutId}/payments`)
    .set({ ...headers, "Idempotency-Key": key })
    .send(body)
    .then(seen);

const getPayment = (headers: Record<string, string>, paymentId: string) =>
  request(api.server).get(`/v1/payments/${paymentId}`).set(headers).then(seen);

const updatePayment = (headers: Record<string, string>, paymentId: string, body: object) =>
  request(api.server).patch(`/v1/payments/${paymentId}`).set(headers).send(body).then(seen);

const getCheckout = (headers: Record<string, string>, checkoutId: string) =>
  request(api.server).get(`/v1/checkouts/${checkoutId}`).set(headers).then(seen);

const CARD = { method: "card", termsAccepted: true } as const;

async function paymentRows(checkoutId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("payments")
      .select([
        "id",
        "status",
        "provider_payment_id",
        "provider_connection_id",
        "capture_method",
        "card_brand",
        "card_bin",
        sql<string>`amount::text`.as("amount"),
        sql<string>`card_fee_amount::text`.as("cardFee"),
      ])
      .where("checkout_id", "=", checkoutId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );
}

/**
 * The types of a payment's events, sorted by name: events of one request can share a millisecond, and ids of one
 * millisecond do not sort by time.
 */
async function eventTypes(paymentId: string): Promise<string[]> {
  const rows = await alphaTx((trx) =>
    trx.selectFrom("payment_events").select(["type"]).where("payment_id", "=", paymentId).execute(),
  );
  return rows.map((row) => row.type).sort();
}

const creates = () =>
  stripe.requests.filter((req) => req.method === "POST" && req.path === "/v1/payment_intents");

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
    ["setCheckoutTravelers", [200]],
    ["setCheckoutContacts", [200]],
    ["createCheckoutPayment", [201, 403, 404, 422, 424, 502]],
    ["getPayment", [200, 404]],
    ["updatePayment", [200, 404, 409, 422, 502]],
    ["getStorefront", [200]],
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
  alphaId = await insertTenant("alpha");
  const betaId = await insertTenant("beta");
  await insertPaymentConnection(alphaId);
  alphaSk = await issueKey(alphaId);
  alphaPk = await issueKey(alphaId, "pk");
  betaSk = await issueKey(betaId);
  for (const [schema, name] of [
    ["tenant_alpha", "Alpha Travel"],
    ["tenant_beta", "Beta Trips"],
  ] as const) {
    await tenantTx(tenantDb, schema, async (trx) => {
      await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
      await seedDefaultMarkupRule(trx);
    });
  }
  // The OTA's own card surcharge for VISA: 0.50 EUR per booking, on top of the Amadeus fee (OADR-0005 point 7).
  await alphaTx((trx) =>
    trx
      .insertInto("fee_rules")
      .values({
        id: newId("fee"),
        name: "Visa surcharge",
        label: "Card fee",
        fee_type: "payment_card",
        scope: JSON.stringify({ cardBrands: ["VISA"] }),
        calculation: "fixed",
        fixed_amount: "0.50",
        currency: "EUR",
      })
      .execute(),
  );
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

beforeEach(async () => {
  // Full Amadeus buckets, rate limits (10 payments per minute per IP) and no cached rows from the previous test.
  await redis.client.flushdb();
  stripe.reset();
});

describe("a payment session on the Velexis Stripe account", () => {
  it("creates the PaymentIntent with manual capture, the four metadata keys and its idempotency key, after the payment row is committed [OBE-038 AC1]", async () => {
    const checkout = await newCheckout(() => edgeWrite());
    // The fake looks into the database while the PaymentIntent is being created.
    const atCall: Array<{ id: string; status: string; providerPaymentId: string | null } | undefined> = [];
    stripe.onRequest(async (req) => {
      if (req.path === "/v1/payment_intents") {
        const paymentId = (req.form["metadata"] as Record<string, string> | undefined)?.["payment_id"] ?? "";
        const row = await alphaTx((trx) =>
          trx
            .selectFrom("payments")
            .select(["id", "status", "provider_payment_id as providerPaymentId"])
            .where("id", "=", paymentId)
            .executeTakeFirst(),
        );
        atCall.push(row);
      }
    });

    const res = await createPayment(edgeWrite(), checkout.id, CARD);

    expect(res.status).toBe(201);
    expectResponseToMatch("createCheckoutPayment", res);
    const payment = res.body as PaymentBody;
    expect(res.headers["location"]).toBe(`/v1/payments/${payment.id}`);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(payment).toMatchObject({
      checkoutId: checkout.id,
      status: "requires_payment_method",
      captureMethod: "manual",
      amount: checkout.totals.total,
      cardFee: null,
      cardHint: null,
      providerPublicKey: PUBLISHABLE_KEY,
      nextAction: { type: "confirm_with_provider_sdk" },
      threeDSecure: { required: true, status: "pending" },
    });
    expect(payment.clientSecret).toMatch(/^pi_.+_secret_/);

    // What reached Stripe.
    expect(creates()).toHaveLength(1);
    const [intent] = creates();
    expect(intent?.headers["idempotency-key"]).toBe(`pi:create:${payment.id}`);
    expect(intent?.headers["authorization"]).toBe(`Bearer ${SECRET_KEY}`);
    expect(intent?.form).toMatchObject({
      amount: String(Math.round(Number(checkout.totals.total.amount) * 100)),
      currency: "eur",
      capture_method: "manual",
      payment_method_types: ["card"],
      payment_method_options: { card: { request_three_d_secure: "any" } },
      statement_descriptor_suffix: DESCRIPTOR,
    });
    expect(intent?.form["metadata"]).toEqual({
      velexis_tenant_id: alphaId,
      velexis_environment: "test",
      checkout_id: checkout.id,
      payment_id: payment.id,
    });
    // The call-order assertion: the row existed, committed and without a PaymentIntent, when Stripe was called.
    expect(atCall).toEqual([{ id: payment.id, status: "requires_payment_method", providerPaymentId: null }]);
    expect(payment.providerPaymentId).toBe(stripe.intents.get(payment.providerPaymentId ?? "")?.id);

    const rows = await paymentRows(checkout.id);
    expect(rows).toMatchObject([
      {
        id: payment.id,
        status: "requires_payment_method",
        provider_payment_id: payment.providerPaymentId,
        capture_method: "manual",
        amount: checkout.totals.total.amount,
      },
    ]);
    expect(await eventTypes(payment.id)).toEqual(["payment.created", "payment.session_created"]);
    const after = (await getCheckout(edgeHeaders(ALPHA_HOST), checkout.id)).body as CheckoutBody;
    expect(after.status).toBe("payment_pending");
    expect(after.termsAcceptedAt).not.toBeNull();
    expect(after.version).toBe(checkout.version + 1);
    expect(new Date(after.expiresAt).getTime() - new Date(checkout.expiresAt).getTime()).toBe(15 * 60_000);
  });

  it("answers 502 PAYMENT_PROVIDER_ERROR and charges nothing while Stripe is unreachable; the same key can be sent again [OBE-038 AC2]", async () => {
    const checkout = await newCheckout(() => keyHeaders(alphaSk));
    const key = idempotencyKey();
    stripe.fail(2, "drop");

    const failed = await createPayment(keyHeaders(alphaSk), checkout.id, CARD, key);

    expect(failed.status).toBe(502);
    expectResponseToMatch("createCheckoutPayment", failed);
    expect((failed.body as ErrorBody).error.code).toBe("PAYMENT_PROVIDER_ERROR");
    // The SDK's one network retry, with the same idempotency key; no PaymentIntent exists.
    expect(creates()).toHaveLength(2);
    const [first, second] = creates();
    expect(second?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
    const intentsBefore = [...stripe.intents.values()].filter(
      (intent) => (intent["metadata"] as Record<string, string>)["checkout_id"] === checkout.id,
    );
    expect(intentsBefore).toEqual([]);
    const [orphan] = await paymentRows(checkout.id);
    expect(orphan).toMatchObject({ status: "requires_payment_method", provider_payment_id: null });

    // Stripe answers again: the same Idempotency-Key is accepted, and the payment row of the failed attempt is used,
    // with its own Stripe key, so a PaymentIntent Stripe made for a lost answer would be the one that comes back.
    stripe.reset();
    const retried = await createPayment(keyHeaders(alphaSk), checkout.id, CARD, key);

    expect(retried.status).toBe(201);
    expectResponseToMatch("createCheckoutPayment", retried);
    const payment = retried.body as PaymentBody;
    expect(payment.id).toBe(orphan?.id);
    expect(creates().map((req) => req.headers["idempotency-key"])).toEqual([`pi:create:${orphan?.id}`]);
    expect(await paymentRows(checkout.id)).toMatchObject([
      { id: orphan?.id, provider_payment_id: payment.providerPaymentId },
    ]);
    expect(await eventTypes(payment.id)).toEqual([
      "payment.created",
      "payment.provider_error",
      "payment.retried",
      "payment.session_created",
    ]);
  });

  it("finds the PaymentIntent of a lost answer again with the payment's Stripe key: one PaymentIntent, no orphan [OBE-038 AC2]", async () => {
    const checkout = await newCheckout(() => keyHeaders(alphaSk));
    const key = idempotencyKey();
    const intents = () =>
      [...stripe.intents.values()].filter(
        (intent) => (intent["metadata"] as Record<string, string>)["checkout_id"] === checkout.id,
      );
    // Stripe creates the PaymentIntent, but neither its answer nor the replay of the SDK's retry arrives.
    stripe.fail(2, "lost");

    const failed = await createPayment(keyHeaders(alphaSk), checkout.id, CARD, key);

    expect(failed.status).toBe(502);
    expectResponseToMatch("createCheckoutPayment", failed);
    expect(intents()).toHaveLength(1);
    const [orphan] = await paymentRows(checkout.id);
    expect(orphan).toMatchObject({ status: "requires_payment_method", provider_payment_id: null });

    const retried = await createPayment(keyHeaders(alphaSk), checkout.id, CARD, key);

    expect(retried.status).toBe(201);
    expectResponseToMatch("createCheckoutPayment", retried);
    const payment = retried.body as PaymentBody;
    expect(payment.id).toBe(orphan?.id);
    // Stripe replayed the PaymentIntent it had made for the lost answer: still one, and it is the payment's.
    expect(intents().map((intent) => intent.id)).toEqual([payment.providerPaymentId]);
    expect(payment.clientSecret).toBe(intents()[0]?.["client_secret"]);
  });

  it("gives the retry a payment and a Stripe key of its own when Stripe keeps a 5xx for the first key [OBE-038 AC2]", async () => {
    const checkout = await newCheckout(() => keyHeaders(alphaSk));
    const key = idempotencyKey();
    // Stripe answers 500 and keeps that answer for pi:create:<pay_id>: that key can only replay it from now on.
    stripe.fail(2, "server_error");

    const failed = await createPayment(keyHeaders(alphaSk), checkout.id, CARD, key);

    expect(failed.status).toBe(502);
    expectResponseToMatch("createCheckoutPayment", failed);
    const [first] = await paymentRows(checkout.id);
    expect(first).toMatchObject({ status: "failed", provider_payment_id: null });

    const retried = await createPayment(keyHeaders(alphaSk), checkout.id, CARD, key);

    expect(retried.status).toBe(201);
    expectResponseToMatch("createCheckoutPayment", retried);
    const payment = retried.body as PaymentBody;
    expect(payment.id).not.toBe(first?.id);
    expect(creates().map((req) => req.headers["idempotency-key"])).toEqual([
      `pi:create:${first?.id}`,
      `pi:create:${first?.id}`,
      `pi:create:${payment.id}`,
    ]);
    expect(await paymentRows(checkout.id)).toMatchObject([
      { id: first?.id, status: "failed" },
      { id: payment.id, status: "requires_payment_method", provider_payment_id: payment.providerPaymentId },
    ]);
    const old = await getPayment(keyHeaders(alphaSk), first?.id ?? "");
    expect(old.status).toBe(200);
    expectResponseToMatch("getPayment", old);
    expect(old.body).toMatchObject({
      status: "failed",
      clientSecret: null,
      failure: { code: "PAYMENT_PROVIDER_ERROR" },
    });
  });

  it("replaces an unconfirmed payment of the checkout and cancels its PaymentIntent at Stripe", async () => {
    const checkout = await newCheckout(() => keyHeaders(alphaSk));
    const first = (await createPayment(keyHeaders(alphaSk), checkout.id, CARD)).body as PaymentBody;

    const second = await createPayment(keyHeaders(alphaSk), checkout.id, CARD);

    expect(second.status).toBe(201);
    const replacement = second.body as PaymentBody;
    expect(replacement.id).not.toBe(first.id);
    expect(await paymentRows(checkout.id)).toMatchObject([
      { id: first.id, status: "canceled" },
      { id: replacement.id, status: "requires_payment_method" },
    ]);
    const cancel = stripe.requests.find(
      (req) => req.path === `/v1/payment_intents/${first.providerPaymentId}/cancel`,
    );
    expect(cancel?.headers["idempotency-key"]).toBe(`pi:cancel:${first.id}`);
    expect(stripe.intents.get(first.providerPaymentId ?? "")?.status).toBe("canceled");
    const old = await getPayment(keyHeaders(alphaSk), first.id);
    expect(old.body).toMatchObject({ status: "cancelled", clientSecret: null, nextAction: { type: "none" } });
  });

  it("refuses a checkout whose travellers or contacts are missing (422 CHECKOUT_INCOMPLETE), before any payment", async () => {
    const checkout = await newCheckout(() => keyHeaders(alphaSk), { complete: false });

    const res = await createPayment(keyHeaders(alphaSk), checkout.id, CARD);

    expect(res.status).toBe(422);
    expectResponseToMatch("createCheckoutPayment", res);
    const error = (res.body as ErrorBody).error;
    expect(error.code).toBe("CHECKOUT_INCOMPLETE");
    expect(error.fieldErrors?.map((field) => field.path)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/travelers\/0\//),
        expect.stringMatching(/^\/contacts/),
      ]),
    );
    expect(await paymentRows(checkout.id)).toEqual([]);
    expect(stripe.requests).toEqual([]);
  });

  it("takes card payments only in this release, and only for brands the storefront accepts", async () => {
    const checkout = await newCheckout(() => keyHeaders(alphaSk));

    const airline = await createPayment(keyHeaders(alphaSk), checkout.id, {
      method: "airline_card",
      termsAccepted: true,
    });
    const paypal = await createPayment(keyHeaders(alphaSk), checkout.id, {
      ...CARD,
      method: "paypal",
      provider: "paypal",
    });
    const diners = await createPayment(keyHeaders(alphaSk), checkout.id, {
      ...CARD,
      card: { brand: "DINERS" },
    });

    expect([airline.status, paypal.status, diners.status]).toEqual([403, 403, 422]);
    for (const res of [airline, paypal, diners]) {
      expectResponseToMatch("createCheckoutPayment", res);
    }
    expect((airline.body as ErrorBody).error).toMatchObject({
      code: "FEATURE_DISABLED",
      details: { feature: "airlineCard" },
    });
    expect((diners.body as ErrorBody).error).toMatchObject({
      code: "UNPROCESSABLE",
      details: { reason: "card_brand_not_accepted" },
    });
    expect(await paymentRows(checkout.id)).toEqual([]);
    expect(stripe.requests).toEqual([]);
  });

  it("answers 424 PAYMENT_PROVIDER_NOT_CONFIGURED for a tenant without a payment connection, and lists no method", async () => {
    const checkout = await newCheckout(() => keyHeaders(betaSk), { tenant: "beta" });

    const res = await createPayment(keyHeaders(betaSk), checkout.id, CARD);

    expect(res.status).toBe(424);
    expectResponseToMatch("createCheckoutPayment", res);
    expect((res.body as ErrorBody).error.code).toBe("PAYMENT_PROVIDER_NOT_CONFIGURED");
    const rows = await tx("beta", (trx) =>
      trx.selectFrom("payments").select("id").where("checkout_id", "=", checkout.id).execute(),
    );
    expect(rows).toEqual([]);
    expect(stripe.requests).toEqual([]);
    const storefront = seen(await request(api.server).get("/v1/storefront").set(edgeHeaders(BETA_HOST)));
    expect(storefront.status).toBe(200);
    expectResponseToMatch("getStorefront", storefront);
    expect((storefront.body as { payment: Record<string, unknown> }).payment).toMatchObject({
      supportedMethods: [],
      publishableKey: "",
      merchantName: "beta Travel",
    });
  });
});

describe("the card fee and the payment's state", () => {
  it("quotes the Amadeus card fee with the OTA's surcharge, and follows the card hint with the PaymentIntent's amount", async () => {
    const checkout = await newCheckout(() => edgeWrite());
    const offer = checkout.totals.offer.amount;
    const plus = (amount: string, fee: string): string => (Number(amount) + Number(fee)).toFixed(2);

    // VISA: the stub's Amadeus fee 1.20 plus alpha's 0.50 surcharge.
    const created = await createPayment(edgeWrite(), checkout.id, {
      ...CARD,
      card: { brand: "VISA", bin: "424242" },
    });
    expect(created.status).toBe(201);
    const payment = created.body as PaymentBody;
    expect(payment).toMatchObject({
      cardFee: { amount: "1.70", currency: "EUR" },
      cardHint: { brand: "VISA", bin: "424242" },
      amount: { amount: plus(offer, "1.70"), currency: "EUR" },
    });
    expect(creates()[0]?.form["amount"]).toBe(String(Math.round(Number(plus(offer, "1.70")) * 100)));

    // MASTERCARD: the stub's 1.50, no surcharge; the same PaymentIntent gets the new amount.
    stripe.reset();
    const updated = await updatePayment(edgeWrite(), payment.id, {
      card: { brand: "MASTERCARD", bin: "555555" },
    });
    expect(updated.status).toBe(200);
    expectResponseToMatch("updatePayment", updated);
    expect(updated.headers["cache-control"]).toBe("no-store");
    expect(updated.body).toMatchObject({
      id: payment.id,
      providerPaymentId: payment.providerPaymentId,
      cardFee: { amount: "1.50" },
      cardHint: { brand: "MASTERCARD", bin: "555555" },
      amount: { amount: plus(offer, "1.50") },
      clientSecret: null,
    });
    expect(stripe.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: `/v1/payment_intents/${payment.providerPaymentId}`,
        form: { amount: String(Math.round(Number(plus(offer, "1.50")) * 100)) },
      }),
    ]);
    expect(stripe.requests[0]?.headers["idempotency-key"]).toBe(`pi:update:${payment.id}:2`);
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.amount).toBe(
      Math.round(Number(plus(offer, "1.50")) * 100),
    );
    const view = (await getCheckout(edgeHeaders(ALPHA_HOST), checkout.id)).body as CheckoutBody;
    expect(view.totals).toMatchObject({
      cardFee: { amount: "1.50" },
      total: { amount: plus(offer, "1.50") },
    });

    // The same hint again changes nothing and calls no one.
    stripe.reset();
    const again = await updatePayment(edgeWrite(), payment.id, {
      card: { brand: "MASTERCARD", bin: "555555" },
    });
    expect(again.status).toBe(200);
    expect(stripe.requests).toEqual([]);
    expect(await eventTypes(payment.id)).toEqual([
      "payment.amount_updated",
      "payment.created",
      "payment.session_created",
    ]);

    // A brand the storefront does not accept.
    const diners = await updatePayment(edgeWrite(), payment.id, { card: { brand: "DINERS" } });
    expect(diners.status).toBe(422);
    expectResponseToMatch("updatePayment", diners);
  });

  it("gives the next card hint a Stripe key of its own after a PaymentIntent update whose answer was lost", async () => {
    const checkout = await newCheckout(() => edgeWrite());
    const offer = checkout.totals.offer.amount;
    const minor = (fee: string): number => Math.round((Number(offer) + Number(fee)) * 100);
    const payment = (await createPayment(edgeWrite(), checkout.id, CARD)).body as PaymentBody;
    // Stripe sets the VISA amount (1.20 + 0.50) for pi:update:<pay_id>:2, but the answer never arrives.
    stripe.fail(2, "lost");

    const lost = await updatePayment(edgeWrite(), payment.id, { card: { brand: "VISA", bin: "424242" } });

    expect(lost.status).toBe(502);
    expectResponseToMatch("updatePayment", lost);
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.amount).toBe(minor("1.70"));

    // The customer types another card. Stripe keeps pi:update:<pay_id>:2 for the VISA amount and would refuse it with
    // another one, so this update sends the payment's next version.
    const sent = stripe.requests.length;
    const updated = await updatePayment(edgeWrite(), payment.id, {
      card: { brand: "MASTERCARD", bin: "555555" },
    });

    expect(updated.status).toBe(200);
    expectResponseToMatch("updatePayment", updated);
    expect(updated.body).toMatchObject({
      cardHint: { brand: "MASTERCARD", bin: "555555" },
      cardFee: { amount: "1.50" },
      amount: { amount: (minor("1.50") / 100).toFixed(2) },
    });
    expect(stripe.requests.slice(sent).map((req) => req.headers["idempotency-key"])).toEqual([
      `pi:update:${payment.id}:3`,
    ]);
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.amount).toBe(minor("1.50"));
    expect(await eventTypes(payment.id)).toEqual([
      "payment.amount_updated",
      "payment.created",
      "payment.provider_error",
      "payment.session_created",
    ]);
  });

  it("reads the payment again from Stripe: the client secret before confirmation, the authorisation after", async () => {
    const checkout = await newCheckout(() => keyHeaders(alphaSk));
    const payment = (await createPayment(keyHeaders(alphaSk), checkout.id, CARD)).body as PaymentBody;

    const before = await getPayment(keyHeaders(alphaSk), payment.id);
    expect(before.status).toBe(200);
    expectResponseToMatch("getPayment", before);
    expect(before.headers["cache-control"]).toBe("no-store");
    expect(before.body).toMatchObject({
      status: "requires_payment_method",
      clientSecret: payment.clientSecret,
    });

    // The browser confirmed the payment with 3-D Secure: Stripe holds the authorisation.
    stripe.update(payment.providerPaymentId ?? "", {
      status: "requires_capture",
      amount_capturable: stripe.intents.get(payment.providerPaymentId ?? "")?.amount,
      payment_method: {
        id: "pm_test_card",
        object: "payment_method",
        card: { brand: "visa", last4: "3184", exp_month: 12, exp_year: 2031 },
      },
      latest_charge: {
        id: "ch_test_charge",
        object: "charge",
        payment_method_details: { card: { three_d_secure: { result: "authenticated", version: "2.2.0" } } },
      },
    });
    const after = await getPayment(keyHeaders(alphaSk), payment.id);

    expect(after.status).toBe(200);
    expectResponseToMatch("getPayment", after);
    const authorized = after.body as PaymentBody;
    expect(authorized).toMatchObject({
      status: "authorized",
      amountAuthorized: payment.amount,
      clientSecret: null,
      nextAction: { type: "none" },
      card: { brand: "VISA", last4: "3184" },
      threeDSecure: { required: true, status: "authenticated" },
    });
    expect(authorized.authorizedAt).not.toBeNull();
    expect(await eventTypes(payment.id)).toEqual([
      "payment.authorized",
      "payment.created",
      "payment.session_created",
    ]);

    // Authorised is not final, but there is nothing left to update.
    const refused = await updatePayment(keyHeaders(alphaSk), payment.id, { card: { brand: "VISA" } });
    expect(refused.status).toBe(409);
    expectResponseToMatch("updatePayment", refused);
    expect((refused.body as ErrorBody).error).toMatchObject({
      code: "PAYMENT_NOT_UPDATABLE",
      details: { status: "authorized" },
    });
  });

  it("keeps another tenant's payment unknown: 404 to read and to change it", async () => {
    const checkout = await newCheckout(() => keyHeaders(alphaSk));
    const payment = (await createPayment(keyHeaders(alphaSk), checkout.id, CARD)).body as PaymentBody;
    stripe.reset();

    const read = await getPayment(keyHeaders(betaSk), payment.id);
    const changed = await updatePayment(keyHeaders(betaSk), payment.id, { card: { brand: "VISA" } });
    // Nor can beta pay alpha's checkout.
    const paid = await createPayment(keyHeaders(betaSk), checkout.id, CARD);

    expect([read.status, changed.status, paid.status]).toEqual([404, 404, 404]);
    expectResponseToMatch("getPayment", read);
    expectResponseToMatch("updatePayment", changed);
    expectResponseToMatch("createCheckoutPayment", paid);
    expect(stripe.requests).toEqual([]);
    expect(await paymentRows(checkout.id)).toMatchObject([
      { id: payment.id, status: "requires_payment_method" },
    ]);
    const betaRows = await tx("beta", (trx) =>
      trx.selectFrom("payments").select("id").where("checkout_id", "=", checkout.id).execute(),
    );
    expect(betaRows).toEqual([]);
  });

  it("names the card of a payment confirmed without a hint, with neither a card hint nor a card fee", async () => {
    const checkout = await newCheckout(() => keyHeaders(alphaSk));
    const payment = (await createPayment(keyHeaders(alphaSk), checkout.id, CARD)).body as PaymentBody;
    // The storefront never sent the brand: the card was a JCB, which Amadeus has no PaymentBrand for.
    stripe.update(payment.providerPaymentId ?? "", {
      status: "requires_capture",
      amount_capturable: stripe.intents.get(payment.providerPaymentId ?? "")?.amount,
      payment_method: {
        id: "pm_test_jcb",
        object: "payment_method",
        card: { brand: "jcb", last4: "0505", exp_month: 6, exp_year: 2032 },
      },
    });

    const after = await getPayment(keyHeaders(alphaSk), payment.id);

    expect(after.status).toBe(200);
    expectResponseToMatch("getPayment", after);
    expect(after.body).toMatchObject({
      status: "authorized",
      card: { brand: "JCB", last4: "0505" },
      cardHint: null,
      cardFee: null,
      amount: payment.amount,
    });
  });
});

describe("storefront.get in velexis mode", () => {
  it("shows the Velexis account, Velexis as the merchant on behalf of the OTA and the card method [OBE-038 AC3]", async () => {
    for (const headers of [edgeHeaders(ALPHA_HOST), { ...keyHeaders(alphaPk), Origin: ALPHA_ORIGIN }]) {
      const res = seen(await request(api.server).get("/v1/storefront").set(headers));

      expect(res.status).toBe(200);
      expectResponseToMatch("getStorefront", res);
      expect((res.body as { payment: Record<string, unknown> }).payment).toMatchObject({
        provider: "stripe",
        environment: "test",
        accountMode: "velexis",
        publishableKey: PUBLISHABLE_KEY,
        accountId: null,
        merchantName: "Velexis on behalf of alpha Travel",
        statementDescriptor: DESCRIPTOR,
        supportedMethods: ["card"],
        airlineCard: null,
      });
    }
  });

  it("never shows the Velexis secret key in an answer: storefront, payments, refusals [OBE-038 AC3]", async () => {
    bodies.length = 0;
    const checkout = await newCheckout(() => edgeWrite());
    seen(await request(api.server).get("/v1/storefront").set(edgeHeaders(ALPHA_HOST)));
    seen(
      await request(api.server)
        .get("/v1/storefront")
        .set({ ...keyHeaders(alphaPk), Origin: ALPHA_ORIGIN }),
    );
    const payment = (await createPayment(edgeWrite(), checkout.id, { ...CARD, card: { brand: "VISA" } }))
      .body as PaymentBody;
    await getPayment(edgeHeaders(ALPHA_HOST), payment.id);
    await updatePayment(edgeWrite(), payment.id, { card: { brand: "AMERICAN_EXPRESS" } });
    await updatePayment(edgeWrite(), payment.id, { card: { brand: "DINERS" } });
    await getCheckout(edgeHeaders(ALPHA_HOST), checkout.id);
    stripe.fail(2, "server_error");
    await createPayment(edgeWrite(), checkout.id, CARD);

    expect(bodies).toHaveLength(8);
    expect(bodies.filter((body) => body.includes(SECRET_KEY))).toEqual([]);
    expect(bodies.filter((body) => /\b(?:sk|rk)_(?:test|live)_/.test(body))).toEqual([]);
    // The publishable key is meant for the browser: both storefront answers and the three payment answers have it.
    expect(bodies.filter((body) => body.includes(PUBLISHABLE_KEY))).toHaveLength(5);
    // Nor in any answer of the tests before this one in the file (the 424, the 502 of a dropped connection, the 404s
    // of another tenant, the refusals of methods and brands ...).
    expect(everyBody.filter((body) => body.includes(SECRET_KEY))).toEqual([]);
    expect(everyBody.filter((body) => /\b(?:sk|rk)_(?:test|live)_/.test(body))).toEqual([]);
  });
});
