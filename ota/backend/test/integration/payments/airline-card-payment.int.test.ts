// The airline-card payment method before the card is typed (OBE-050; OADR-0004 points 1, 4 and 5,
// ota/docs/flows/checkout-airline-card.md §1 and §3 steps 1–2, ota/docs/api-changes.md §3.1 and §4): its two switches
// and its caller, the airline's price on the checkout (`pricing_mode = net`), the payment row without a provider, the
// Amadeus card fee of updatePayment, the way back to the selling price with a card, another tenant's `404`,
// storefront.get's edge-only airline card decided per request from one shared cache entry, and the extras of
// checkout.setAncillaries priced in each pricing mode (FIX-W22).
//
// Against PostgreSQL 16, Redis 7, the Amadeus stub and the fake Stripe API (test/helpers/fake-stripe.ts): two API
// applications on one cloned database, `api` with AIRLINE_CARD_ENABLED=true and `apiOff` with the switch at its
// default (off). Alpha has the `velexis` test payment connection, the airline card on for the test environment, a 10 %
// markup rule, a 0.50 EUR VISA surcharge and a 2.50 EUR `ancillary_service` fee per extra (so the selling and the
// airline's price differ); beta has neither the connection nor the airline card. Every checkout opens from a priced
// offer of the stub's Madrid–Paris Orly offer 2 (moved 60 days ahead), with its traveller and contact. Every answer is
// checked against the OTA document.
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
const NOTICE = "The airline charges your card. The price is the airline's price.";
/** Alpha's `ancillary_service` fee per extra, at the selling price only. */
const EXTRA_FEE = "2.50";

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let apiOff: TestApp;
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

type Tenant = "alpha" | "beta";

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

async function insertTenant(key: Tenant): Promise<string> {
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
async function insertPaymentConnection(tenantId: string): Promise<void> {
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id: newId("ppc"),
      tenant_id: tenantId,
      provider: "stripe",
      environment: "test",
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
      statement_descriptor_suffix: "ALPHA TRAVEL",
    })
    .execute();
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
      ...(kind === "pk" ? { allowed_origins: [ALPHA_ORIGIN] } : {}),
    })
    .execute();
  return key;
}

const idempotencyKey = (): string => randomBytes(16).toString("hex");
const hostOf = (tenant: Tenant): string => (tenant === "alpha" ? ALPHA_HOST : BETA_HOST);
const edgeWrite = (tenant: Tenant = "alpha"): Record<string, string> => ({
  ...edgeWriteHeaders(hostOf(tenant)),
});
const edgeRead = (tenant: Tenant = "alpha"): Record<string, string> => ({ ...edgeHeaders(hostOf(tenant)) });
const skHeaders = (): Record<string, string> => ({ "X-Api-Key": alphaSk });
const pkHeaders = (): Record<string, string> => ({ "X-Api-Key": alphaPk, Origin: ALPHA_ORIGIN });
const tx = <T>(tenant: Tenant, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, `tenant_${tenant}`, run);
const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> => tx("alpha", run);

interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

interface PaymentBody {
  readonly id: string;
  readonly checkoutId: string;
  readonly provider: string;
  readonly method: string;
  readonly status: string;
  readonly captureMethod: string;
  readonly amount: MoneyBody;
  readonly cardFee: MoneyBody | null;
  readonly cardHint: { brand: string; bin?: string } | null;
  readonly clientSecret: string | null;
  readonly providerPublicKey: string | null;
  readonly providerPaymentId: string | null;
  readonly nextAction: { type: string } | null;
  readonly threeDSecure: { required: boolean; status: string };
}

interface CheckoutBody {
  readonly id: string;
  readonly status: string;
  readonly pricedOfferId: string;
  readonly totals: {
    readonly offer: MoneyBody;
    readonly ancillaries: MoneyBody;
    readonly cardFee: MoneyBody | null;
    readonly total: MoneyBody;
  };
}

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    readonly fieldErrors?: Array<{ path: string; code: string }>;
  };
}

interface StorefrontPaymentBody {
  readonly supportedMethods: string[];
  readonly pspCardBrands: unknown[];
  readonly airlineCard: {
    enabled: boolean;
    cardBrands: unknown[];
    chargedBy: string;
    notice: string;
  } | null;
}

let searchCount = 0;

/** A priced offer of `tenant` for the stub's offer 2 of a new search, its flight moved 60 days ahead. */
async function newPricedOffer(app: TestApp, tenant: Tenant): Promise<string> {
  searchCount += 1;
  const searched = await request(app.server)
    .post("/v1/flight-searches")
    .set({ ...edgeWrite(tenant), "Idempotency-Key": idempotencyKey() })
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
  const priced = await request(app.server)
    .post("/v1/priced-offers")
    .set({ ...edgeWrite(tenant), "Idempotency-Key": idempotencyKey() })
    .send({ offerIds: [offerId] });
  expect(priced.status).toBe(201);
  return (priced.body as { id: string }).id;
}

/** A guest checkout of `tenant` on the edge of `app`, with its traveller and contact. */
async function newCheckout(app: TestApp = api, tenant: Tenant = "alpha"): Promise<CheckoutBody> {
  const pricedOfferId = await newPricedOffer(app, tenant);
  const created = await request(app.server)
    .post("/v1/checkouts")
    .set({ ...edgeWrite(tenant), "Idempotency-Key": idempotencyKey() })
    .send({ pricedOfferId });
  expect(created.status).toBe(201);
  const checkout = created.body as CheckoutBody;
  const travelers = await request(app.server)
    .put(`/v1/checkouts/${checkout.id}/travelers`)
    .set(edgeWrite(tenant))
    .send({ travelers: [buildTravelerInput()] });
  expect(travelers.status).toBe(200);
  const contacts = await request(app.server)
    .put(`/v1/checkouts/${checkout.id}/contacts`)
    .set(edgeWrite(tenant))
    .send({ contacts: [buildContactInput()] });
  expect(contacts.status).toBe(200);
  return contacts.body as CheckoutBody;
}

/**
 * Adds a checked bag to a checkout as checkout.setAncillaries (OBE-037) leaves it: the selection with its selling
 * price (38.00) and its Amadeus price (35.00), and the checkout's extras and total at the selling price.
 */
async function addBag(checkoutId: string): Promise<void> {
  await alphaTx(async (trx) => {
    await trx
      .insertInto("checkout_ancillaries")
      .values({
        id: newId("can"),
        checkout_id: checkoutId,
        type: "CHECKED_BAGS",
        service_code: "1",
        quantity: 1,
        currency: "EUR",
        price_amount: "38.00",
        net_amount: "35.00",
        details: JSON.stringify({ optionId: "bag_1" }),
      })
      .execute();
    await trx
      .updateTable("checkouts")
      .set({
        ancillaries_amount: "38.00",
        total_amount: sql`offer_amount + 38.00 + fees_amount`,
        version: sql`version + 1`,
      })
      .where("id", "=", checkoutId)
      .execute();
  });
}

const createPayment = (app: TestApp, headers: Record<string, string>, checkoutId: string, body: object) =>
  request(app.server)
    .post(`/v1/checkouts/${checkoutId}/payments`)
    .set({ ...headers, "Idempotency-Key": idempotencyKey() })
    .send(body);

const updatePayment = (headers: Record<string, string>, paymentId: string, body: object) =>
  request(api.server).patch(`/v1/payments/${paymentId}`).set(headers).send(body);

/**
 * Adds the stub's one-checked-bag option of the checkout's catalogue with checkout.setAncillaries on the edge (OBE-037);
 * answers the option's Amadeus price (markup rules have no ancillary scope, so the catalogue shows it) and the answer.
 */
async function addCatalogueBag(
  checkout: CheckoutBody,
): Promise<{ readonly bagNet: string; readonly body: CheckoutBody }> {
  const catalogue = await request(api.server)
    .get(`/v1/priced-offers/${checkout.pricedOfferId}/ancillaries`)
    .set(edgeRead());
  expect(catalogue.status).toBe(200);
  const bag = (
    catalogue.body as { checkedBags: Array<{ id: string; quantity: number | null; price: MoneyBody }> }
  ).checkedBags.find((option) => option.quantity === 1);
  if (bag === undefined) {
    throw new Error("the stub's catalogue has no one-bag option");
  }
  const res = await request(api.server)
    .put(`/v1/checkouts/${checkout.id}/ancillaries`)
    .set(edgeWrite())
    .send({ selections: [{ optionId: bag.id, travelerId: "1" }] });
  expect(res.status).toBe(200);
  expectResponseToMatch("setCheckoutAncillaries", res);
  return { bagNet: bag.price.amount, body: res.body as CheckoutBody };
}

/** The checkout's extras: their selling and Amadeus prices. */
async function extraPrices(checkoutId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("checkout_ancillaries")
      .select([sql<string>`price_amount::text`.as("price"), sql<string>`net_amount::text`.as("net")])
      .where("checkout_id", "=", checkoutId)
      .execute(),
  );
}

const AIRLINE = { method: "airline_card", termsAccepted: true } as const;
const CARD = { method: "card", termsAccepted: true } as const;

/** The checkout's pricing columns and the priced offer's two totals. */
async function pricingOf(checkoutId: string) {
  return await alphaTx((trx) =>
    trx
      .selectFrom("checkouts as c")
      .innerJoin("priced_offers as p", "p.id", "c.priced_offer_id")
      .select([
        "c.pricing_mode as pricingMode",
        "c.status as status",
        sql<string>`c.offer_amount::text`.as("offer"),
        sql<string>`c.ancillaries_amount::text`.as("ancillaries"),
        sql<string>`c.fees_amount::text`.as("fees"),
        sql<string>`c.total_amount::text`.as("total"),
        sql<string>`p.net_total::text`.as("netTotal"),
        sql<string>`p.selling_total::text`.as("sellingTotal"),
      ])
      .where("c.id", "=", checkoutId)
      .executeTakeFirstOrThrow(),
  );
}

async function paymentRows(tenant: Tenant, checkoutId: string) {
  return await tx(tenant, (trx) =>
    trx
      .selectFrom("payments")
      .select([
        "id",
        "provider",
        "method",
        "status",
        "capture_method as captureMethod",
        "provider_payment_id as providerPaymentId",
        "provider_connection_id as providerConnectionId",
        "next_action as nextAction",
        "three_ds as threeDs",
        "card_brand as cardBrand",
        sql<string>`amount::text`.as("amount"),
        sql<string>`card_fee_amount::text`.as("cardFee"),
      ])
      .where("checkout_id", "=", checkoutId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );
}

const sum = (...amounts: string[]): string =>
  (amounts.reduce((total, amount) => total + Math.round(Number(amount) * 100), 0) / 100).toFixed(2);

// Cloning the template, starting the stub and the fake Stripe API and building two API module graphs take several
// seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own timeout.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["createCheckoutPayment", [201, 400, 403, 404]],
    ["getPayment", [200, 404]],
    ["updatePayment", [200, 403, 404]],
    ["getCheckout", [200]],
    ["getStorefront", [200]],
    ["getPricedOfferAncillaries", [200]],
    ["setCheckoutAncillaries", [200]],
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
  await insertTenant("beta");
  await insertPaymentConnection(alphaId);
  alphaSk = await issueKey(alphaId, "sk");
  alphaPk = await issueKey(alphaId, "pk");
  for (const [tenant, name] of [
    ["alpha", "Alpha Travel"],
    ["beta", "Beta Trips"],
  ] as const) {
    await tx(tenant, async (trx) => {
      await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
      await seedDefaultMarkupRule(trx);
    });
  }
  await alphaTx(async (trx) => {
    // Alpha sells with a 10 % markup and charges 0.50 EUR more on VISA cards: the airline's price has neither.
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
    await trx
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
      .execute();
    // Each extra costs 2.50 EUR more at the selling price (OADR-0005 point 7); the airline's price has no such fee.
    await trx
      .insertInto("fee_rules")
      .values({
        id: newId("fee"),
        name: "Extras",
        label: "Extras service fee",
        fee_type: "ancillary_service",
        scope: JSON.stringify({}),
        calculation: "fixed",
        fixed_amount: EXTRA_FEE,
        currency: "EUR",
        applies_per: "booking",
      })
      .execute();
    // The OTA turned the airline card on for its test environment (console settings, OBE-070).
    await trx.updateTable("storefront_settings").set({ airline_card_enabled_test: true }).execute();
  });
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  const env = {
    AMADEUS_BASE_URL_TEST: stub.url,
    STRIPE_SECRET_KEY_TEST: SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
  };
  [api, apiOff] = await Promise.all([
    createTestApp({
      database: db,
      redis,
      imports: [stripeEndpointModule(stripe.endpoint)],
      env: { ...env, AIRLINE_CARD_ENABLED: "true" },
    }),
    createTestApp({ database: db, redis, imports: [stripeEndpointModule(stripe.endpoint)], env }),
  ]);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await apiOff?.close();
  await stub?.stop();
  await stripe?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(async () => {
  // Full Amadeus buckets, rate limits (10 payments per minute per IP) and no cached storefront from the previous test.
  await redis.client.flushdb();
  stripe.reset();
});

describe("the airline card's switches and caller", () => {
  it("is absent from storefront.get and refused by createPayment while AIRLINE_CARD_ENABLED is off (OF-05 AC3) [OBE-050 AC1]", async () => {
    const checkout = await newCheckout(apiOff);

    const storefronts = [
      await request(apiOff.server).get("/v1/storefront").set(edgeRead()),
      await request(apiOff.server).get("/v1/storefront").set(pkHeaders()),
    ];
    const refusals = [
      await createPayment(apiOff, edgeWrite(), checkout.id, AIRLINE),
      await createPayment(apiOff, skHeaders(), checkout.id, AIRLINE),
    ];

    for (const res of storefronts) {
      expect(res.status).toBe(200);
      expectResponseToMatch("getStorefront", res);
      const payment = (res.body as { payment: StorefrontPaymentBody }).payment;
      expect(payment.supportedMethods).toEqual(["card"]);
      expect(payment.airlineCard).toBeNull();
    }
    for (const res of refusals) {
      expect(res.status).toBe(403);
      expectResponseToMatch("createCheckoutPayment", res);
      expect((res.body as ErrorBody).error).toMatchObject({
        code: "FEATURE_DISABLED",
        details: { feature: "airlineCard" },
      });
    }
    expect(await paymentRows("alpha", checkout.id)).toEqual([]);
    expect((await pricingOf(checkout.id)).pricingMode).toBe("markup_rules");
  });

  it("shows airline_card to the edge only when both switches are on, from one cache fill by a pk_ call [OBE-050 AC1]", async () => {
    const cacheKeys = async (): Promise<string[]> =>
      (await redis.client.keys(`t:${alphaId}:test:sf:*`)).sort();

    const byKey = await request(api.server).get("/v1/storefront").set(pkHeaders());
    const filled = await cacheKeys();
    const cached = await redis.client.get(`t:${alphaId}:test:sf:und`);
    const byEdge = await request(api.server).get("/v1/storefront").set(edgeRead());
    const byKeyAgain = await request(api.server).get("/v1/storefront").set(pkHeaders());
    const bySecretKey = await request(api.server).get("/v1/storefront").set(skHeaders());

    for (const res of [byKey, byEdge, byKeyAgain, bySecretKey]) {
      expect(res.status).toBe(200);
      expectResponseToMatch("getStorefront", res);
    }
    // One entry, filled by the pk_ call and read by the others: it holds the setting's flag, no caller's fields.
    expect(filled).toEqual([`t:${alphaId}:test:sf:und`]);
    expect(await cacheKeys()).toEqual(filled);
    expect(await redis.client.get(`t:${alphaId}:test:sf:und`)).toBe(cached);
    expect(cached).not.toContain("airline_card");
    expect(cached).not.toContain(NOTICE);
    const edgePayment = (byEdge.body as { payment: StorefrontPaymentBody }).payment;
    expect(edgePayment.supportedMethods).toEqual(["card", "airline_card"]);
    expect(edgePayment.airlineCard).toEqual({
      enabled: true,
      cardBrands: edgePayment.pspCardBrands,
      chargedBy: "airline",
      notice: NOTICE,
    });
    for (const res of [byKey, byKeyAgain, bySecretKey]) {
      const payment = (res.body as { payment: StorefrontPaymentBody }).payment;
      expect(payment.supportedMethods).toEqual(["card"]);
      expect(payment.airlineCard).toBeNull();
    }
  });

  it("is refused for a tenant whose environment setting is off, and absent from its storefront [OBE-050 AC1]", async () => {
    const checkout = await newCheckout(api, "beta");

    const storefront = await request(api.server).get("/v1/storefront").set(edgeRead("beta"));
    const res = await createPayment(api, edgeWrite("beta"), checkout.id, AIRLINE);

    expect(storefront.status).toBe(200);
    expectResponseToMatch("getStorefront", storefront);
    expect((storefront.body as { payment: StorefrontPaymentBody }).payment).toMatchObject({
      supportedMethods: [],
      airlineCard: null,
    });
    expect(res.status).toBe(403);
    expectResponseToMatch("createCheckoutPayment", res);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: "FEATURE_DISABLED",
      details: { feature: "airlineCard" },
    });
    expect(await paymentRows("beta", checkout.id)).toEqual([]);
  });

  it("answers 403 SCOPE_NOT_ALLOWED to pk_ and sk_ callers, which never prepare an airline-card payment (OF-05 AC2 groundwork) [OBE-050 AC2]", async () => {
    const checkout = await newCheckout();

    const refusals = [
      await createPayment(api, skHeaders(), checkout.id, AIRLINE),
      await createPayment(api, pkHeaders(), checkout.id, AIRLINE),
      await createPayment(api, skHeaders(), checkout.id, { ...AIRLINE, card: { brand: "VISA" } }),
    ];

    for (const res of refusals) {
      expect(res.status).toBe(403);
      expectResponseToMatch("createCheckoutPayment", res);
      expect((res.body as ErrorBody).error).toMatchObject({
        code: "SCOPE_NOT_ALLOWED",
        details: { reason: "edge_only" },
      });
    }
    expect(await paymentRows("alpha", checkout.id)).toEqual([]);
    expect(await pricingOf(checkout.id)).toMatchObject({ pricingMode: "markup_rules", status: "open" });
    expect(stripe.requests).toEqual([]);
  });

  it("refuses a provider with the airline card: no payment provider takes it", async () => {
    const checkout = await newCheckout();

    const res = await createPayment(api, edgeWrite(), checkout.id, { ...AIRLINE, provider: "stripe" });

    expect(res.status).toBe(400);
    expectResponseToMatch("createCheckoutPayment", res);
    // The document refuses it already (PaymentCreateRequest's `if method = airline_card then no provider`).
    expect((res.body as ErrorBody).error.code).toBe("VALIDATION_FAILED");
    expect((res.body as ErrorBody).error.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/provider" })]),
    );
    expect(await paymentRows("alpha", checkout.id)).toEqual([]);
  });
});

describe("an airline-card payment", () => {
  it("switches the checkout to the airline's price, replaces the card payment and calls no provider", async () => {
    const checkout = await newCheckout();
    await addBag(checkout.id);
    const card = await createPayment(api, edgeWrite(), checkout.id, CARD);
    expect(card.status).toBe(201);
    const cardPayment = card.body as PaymentBody;
    const selling = await pricingOf(checkout.id);
    expect(selling).toMatchObject({ pricingMode: "markup_rules", ancillaries: "38.00" });
    // The 10 % markup: the selling price is not the airline's.
    expect(Number(selling.sellingTotal)).toBeGreaterThan(Number(selling.netTotal));
    stripe.reset();

    const res = await createPayment(api, edgeWrite(), checkout.id, AIRLINE);

    expect(res.status).toBe(201);
    expectResponseToMatch("createCheckoutPayment", res);
    expect(res.headers["cache-control"]).toBe("no-store");
    const payment = res.body as PaymentBody;
    expect(res.headers["location"]).toBe(`/v1/payments/${payment.id}`);
    const net = await pricingOf(checkout.id);
    // The Amadeus total of the priced offer and the bag's Amadeus price; no markup, no OTA fee.
    expect(net).toEqual({
      pricingMode: "net",
      status: "payment_pending",
      offer: net.netTotal,
      ancillaries: "35.00",
      fees: "0.00",
      total: sum(net.netTotal, "35.00"),
      netTotal: selling.netTotal,
      sellingTotal: selling.sellingTotal,
    });
    expect(payment).toMatchObject({
      checkoutId: checkout.id,
      provider: "airline",
      method: "airline_card",
      status: "requires_payment_method",
      captureMethod: "automatic",
      amount: { amount: net.total, currency: "EUR" },
      cardFee: null,
      cardHint: null,
      clientSecret: null,
      providerPublicKey: null,
      providerPaymentId: null,
      nextAction: { type: "airline_card_form" },
      threeDSecure: { required: false, status: "not_required" },
    });
    // The row the database CHECK allows: no provider, no stored next action, no 3-D Secure; the card payment is gone
    // and its PaymentIntent cancelled at Stripe, the only provider call of the step.
    expect(await paymentRows("alpha", checkout.id)).toEqual([
      expect.objectContaining({ id: cardPayment.id, provider: "stripe", status: "canceled" }),
      {
        id: payment.id,
        provider: "airline",
        method: "airline_card",
        status: "requires_payment_method",
        captureMethod: "automatic",
        providerPaymentId: null,
        providerConnectionId: null,
        nextAction: null,
        threeDs: null,
        cardBrand: null,
        amount: net.total,
        cardFee: "0.00",
      },
    ]);
    expect(stripe.requests.map((req) => `${req.method} ${req.path}`)).toEqual([
      `POST /v1/payment_intents/${cardPayment.providerPaymentId}/cancel`,
    ]);
    const events = await alphaTx((trx) =>
      trx
        .selectFrom("payment_events")
        .select(["type", "payload"])
        .where("payment_id", "=", payment.id)
        .execute(),
    );
    expect(events).toEqual([
      {
        type: "payment.created",
        payload: expect.objectContaining({
          method: "airline_card",
          pricingMode: "net",
          replaced: [cardPayment.id],
        }),
      },
    ]);

    // The checkout and the payment read back as created; getPayment calls no provider.
    stripe.reset();
    const view = await request(api.server).get(`/v1/checkouts/${checkout.id}`).set(edgeRead());
    const read = await request(api.server).get(`/v1/payments/${payment.id}`).set(edgeRead());
    expect(view.status).toBe(200);
    expectResponseToMatch("getCheckout", view);
    expect((view.body as CheckoutBody).totals).toMatchObject({
      offer: { amount: net.netTotal },
      ancillaries: { amount: "35.00" },
      cardFee: null,
      total: { amount: net.total },
    });
    expect(read.status).toBe(200);
    expectResponseToMatch("getPayment", read);
    expect(read.body).toMatchObject({ id: payment.id, nextAction: { type: "airline_card_form" } });
    expect(stripe.requests).toEqual([]);
  });

  it("quotes the Amadeus card fee alone for the brand and BIN of updatePayment, without the OTA's surcharge", async () => {
    const checkout = await newCheckout();
    const payment = (await createPayment(api, edgeWrite(), checkout.id, AIRLINE)).body as PaymentBody;
    const { netTotal } = await pricingOf(checkout.id);

    // VISA: the stub's Amadeus fee 1.20; alpha's 0.50 VISA surcharge belongs to the selling price only.
    const visa = await updatePayment(edgeWrite(), payment.id, { card: { brand: "VISA", bin: "411111" } });
    const keyCaller = await updatePayment(skHeaders(), payment.id, { card: { brand: "MASTERCARD" } });

    expect(visa.status).toBe(200);
    expectResponseToMatch("updatePayment", visa);
    expect(visa.body).toMatchObject({
      id: payment.id,
      provider: "airline",
      cardFee: { amount: "1.20", currency: "EUR" },
      cardHint: { brand: "VISA", bin: "411111" },
      amount: { amount: sum(netTotal, "1.20") },
      nextAction: { type: "airline_card_form" },
      providerPaymentId: null,
    });
    expect(await pricingOf(checkout.id)).toMatchObject({
      pricingMode: "net",
      fees: "1.20",
      total: sum(netTotal, "1.20"),
    });
    expect(keyCaller.status).toBe(403);
    expectResponseToMatch("updatePayment", keyCaller);
    expect((keyCaller.body as ErrorBody).error).toMatchObject({
      code: "SCOPE_NOT_ALLOWED",
      details: { reason: "edge_only" },
    });

    // A bag added meanwhile at its selling price (as checkout.setAncillaries writes it), then MASTERCARD: the stub's
    // 1.50 on the airline's price again, the bag at its Amadeus price. No provider was told about any amount.
    await addBag(checkout.id);
    const mastercard = await updatePayment(edgeWrite(), payment.id, { card: { brand: "MASTERCARD" } });
    expect(mastercard.status).toBe(200);
    expect(mastercard.body).toMatchObject({
      cardFee: { amount: "1.50" },
      amount: { amount: sum(netTotal, "35.00", "1.50") },
    });
    expect(await pricingOf(checkout.id)).toMatchObject({
      pricingMode: "net",
      offer: netTotal,
      ancillaries: "35.00",
      fees: "1.50",
      total: sum(netTotal, "35.00", "1.50"),
    });
    expect(stripe.requests).toEqual([]);
    expect(await paymentRows("alpha", checkout.id)).toEqual([
      expect.objectContaining({
        id: payment.id,
        cardBrand: "MASTERCARD",
        cardFee: "1.50",
        amount: sum(netTotal, "35.00", "1.50"),
        nextAction: null,
      }),
    ]);
  });

  it("gives the checkout its selling price back when a card is chosen again", async () => {
    const checkout = await newCheckout();
    await addBag(checkout.id);
    const airline = (
      await createPayment(api, edgeWrite(), checkout.id, { ...AIRLINE, card: { brand: "VISA" } })
    ).body as PaymentBody;
    const net = await pricingOf(checkout.id);
    expect(net).toMatchObject({
      pricingMode: "net",
      fees: "1.20",
      total: sum(net.netTotal, "35.00", "1.20"),
    });
    expect(airline.cardFee).toEqual({ amount: "1.20", currency: "EUR" });

    const res = await createPayment(api, edgeWrite(), checkout.id, { ...CARD, card: { brand: "VISA" } });

    expect(res.status).toBe(201);
    expectResponseToMatch("createCheckoutPayment", res);
    const card = res.body as PaymentBody;
    const selling = await pricingOf(checkout.id);
    // The selling total, the bag's selling price and the VISA fee with alpha's surcharge (1.20 + 0.50).
    expect(selling).toMatchObject({
      pricingMode: "markup_rules",
      offer: selling.sellingTotal,
      ancillaries: "38.00",
      fees: "1.70",
      total: sum(selling.sellingTotal, "38.00", "1.70"),
    });
    expect(card).toMatchObject({
      provider: "stripe",
      method: "card",
      captureMethod: "manual",
      amount: { amount: selling.total },
      nextAction: { type: "confirm_with_provider_sdk" },
    });
    expect(card.clientSecret).toMatch(/^pi_.+_secret_/);
    // The airline-card payment is cancelled without a stored next action (payments_airline_card_ck holds).
    expect(await paymentRows("alpha", checkout.id)).toEqual([
      expect.objectContaining({ id: airline.id, provider: "airline", status: "canceled", nextAction: null }),
      expect.objectContaining({ id: card.id, provider: "stripe", status: "requires_payment_method" }),
    ]);
    const old = await request(api.server).get(`/v1/payments/${airline.id}`).set(edgeRead());
    expect(old.status).toBe(200);
    expectResponseToMatch("getPayment", old);
    expect(old.body).toMatchObject({ status: "cancelled", nextAction: { type: "none" } });
  });

  it("keeps another tenant's checkout and payment unknown, and refuses updatePayment once either switch is off", async () => {
    const checkout = await newCheckout();
    const created = await createPayment(api, edgeWrite(), checkout.id, AIRLINE);
    expect(created.status).toBe(201);
    const payment = created.body as PaymentBody;
    const before = await pricingOf(checkout.id);
    const rowsBefore = await paymentRows("alpha", checkout.id);

    // Beta's edge knows neither alpha's checkout nor its payment: 404, never alpha's data or a change to it.
    const unknown = [
      {
        operation: "createCheckoutPayment",
        res: await createPayment(api, edgeWrite("beta"), checkout.id, AIRLINE),
      },
      {
        operation: "getPayment",
        res: await request(api.server).get(`/v1/payments/${payment.id}`).set(edgeRead("beta")),
      },
      {
        operation: "updatePayment",
        res: await updatePayment(edgeWrite("beta"), payment.id, { card: { brand: "VISA" } }),
      },
    ] as const;
    // The global switch off (apiOff), then the tenant's setting off: the payment can no longer be re-quoted.
    const switchedOff = await request(apiOff.server)
      .patch(`/v1/payments/${payment.id}`)
      .set(edgeWrite())
      .send({ card: { brand: "VISA" } });
    await alphaTx((trx) =>
      trx.updateTable("storefront_settings").set({ airline_card_enabled_test: false }).execute(),
    );
    let settingOff: Awaited<ReturnType<typeof updatePayment>>;
    try {
      settingOff = await updatePayment(edgeWrite(), payment.id, { card: { brand: "VISA" } });
    } finally {
      await alphaTx((trx) =>
        trx.updateTable("storefront_settings").set({ airline_card_enabled_test: true }).execute(),
      );
    }

    for (const { operation, res } of unknown) {
      expect([operation, res.status]).toEqual([operation, 404]);
      expectResponseToMatch(operation, res);
      expect(JSON.stringify(res.body)).not.toContain(checkout.id);
    }
    for (const res of [switchedOff, settingOff]) {
      expect(res.status).toBe(403);
      expectResponseToMatch("updatePayment", res);
      expect((res.body as ErrorBody).error).toMatchObject({
        code: "FEATURE_DISABLED",
        details: { feature: "airlineCard" },
      });
    }
    expect(await paymentRows("beta", checkout.id)).toEqual([]);
    expect(await paymentRows("alpha", checkout.id)).toEqual(rowsBefore);
    expect(await pricingOf(checkout.id)).toEqual(before);
    expect(stripe.requests).toEqual([]);
  });
});

describe("the extras of a checkout in each pricing mode (FIX-W22)", () => {
  it("[FIX-W22 AC2] prices an extra at the airline's price as the fare: its Amadeus price, no markup and no service fee, the airline-card payment's amount", async () => {
    const checkout = await newCheckout();
    expect((await createPayment(api, edgeWrite(), checkout.id, AIRLINE)).status).toBe(201);

    const { bagNet, body } = await addCatalogueBag(checkout);

    const net = await pricingOf(checkout.id);
    // The child priced offer's Amadeus total and the bag's Amadeus price: what the airline charges.
    expect(net).toMatchObject({
      pricingMode: "net",
      offer: net.netTotal,
      ancillaries: bagNet,
      fees: "0.00",
      total: sum(net.netTotal, bagNet),
    });
    expect(Number(net.sellingTotal)).toBeGreaterThan(Number(net.netTotal));
    expect(body.totals).toMatchObject({
      offer: { amount: net.netTotal },
      ancillaries: { amount: bagNet },
      total: { amount: net.total },
    });
    // The row keeps the selling price too, for a card chosen later.
    expect(await extraPrices(checkout.id)).toEqual([{ price: sum(bagNet, EXTRA_FEE), net: bagNet }]);
    // The airline-card payment the storefront creates now charges exactly these totals, which stay as they are.
    const payment = await createPayment(api, edgeWrite(), checkout.id, AIRLINE);
    expect(payment.status).toBe(201);
    expect((payment.body as PaymentBody).amount).toEqual({ amount: net.total, currency: "EUR" });
    expect(await pricingOf(checkout.id)).toEqual(net);
  });

  it("[FIX-W22 AC2] prices an extra at the selling price with a card: the service fee on the extra, the markup on the fare, the card payment's amount", async () => {
    const checkout = await newCheckout();
    expect((await createPayment(api, edgeWrite(), checkout.id, CARD)).status).toBe(201);

    const { bagNet, body } = await addCatalogueBag(checkout);

    const selling = await pricingOf(checkout.id);
    expect(selling).toMatchObject({
      pricingMode: "markup_rules",
      offer: selling.sellingTotal,
      ancillaries: sum(bagNet, EXTRA_FEE),
      fees: "0.00",
      total: sum(selling.sellingTotal, bagNet, EXTRA_FEE),
    });
    expect(Number(selling.sellingTotal)).toBeGreaterThan(Number(selling.netTotal));
    expect(body.totals).toMatchObject({ total: { amount: selling.total } });
    expect(await extraPrices(checkout.id)).toEqual([{ price: sum(bagNet, EXTRA_FEE), net: bagNet }]);
    const payment = await createPayment(api, edgeWrite(), checkout.id, CARD);
    expect(payment.status).toBe(201);
    expect((payment.body as PaymentBody).amount).toEqual({ amount: selling.total, currency: "EUR" });
    expect(await pricingOf(checkout.id)).toEqual(selling);
  });
});
