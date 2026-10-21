// checkout.setAncillaries against PostgreSQL 16, Redis 7 and the Amadeus stub (OBE-037; ota/docs/flows/checkout-
// stripe.md §2 step 2, OADR-0005 point 7). The file clones the @velexis/testing template (tenant_alpha and tenant_beta
// provisioned), writes the platform rows of two tenants on the Velexis test Amadeus account as the platform does,
// seeds their storefront settings, the default markup rule and, for alpha, one `ancillary_service` fee rule (2.50 EUR
// per extra), and calls the API in-process with secret keys.
//
// Every test gets a new checkout in `beforeEach`, opened from a priced offer made by the API itself, as in
// checkout.int.test.ts: the stub's Madrid–Paris Orly offer 2 (IB3436, one adult, segment "3") moved to a day 60 days
// from today, priced with the default `include`, so its catalogue holds the stub's two checked-bag options (1 bag for
// 30.00, 2 bags for 65.00 EUR) and PRIORITY_BOARDING (9.00 EUR); the last describe prices it without `bags` and
// `other-services`, so no catalogue is stored with it. The stub echoes the posted offers: it confirms the flights' net and states no `price.additionalServices`,
// so an extra's net is its catalogue price; its `price-changed` scenario raises the fare by 10.00 per traveller. Every
// answer is checked against the OTA document (`expectResponseToMatch`).
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
  type TenantDatabase,
  type TenantDb,
  type Transaction,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { startAmadeusStub, stubScenario, type AmadeusStub } from "@velexis/testing/amadeus";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { newId } from "../../../src/common/ids";
import { Money } from "../../../src/pricing/pricing.types";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { dateFromToday } from "../../builders/checkouts";
import { newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/** The day of the priced flight (the stored offer is moved there) and its last ticketing day. */
const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
/** The `ancillary_service` fee of alpha: a fixed amount per extra. */
const EXTRA_FEE = "2.50";
/** The stub's `price-changed` scenario raises each traveller's fare by 10.00 (one adult here). */
const PRICE_CHANGE = "10.00";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let accountId: string;
let alphaSk: string;
let betaSk: string;

/** Inserts the Velexis test Amadeus account with `secret` encrypted as the platform encrypts it. */
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

/** Inserts a tenant of a provisioned test schema and its connection on the shared account. */
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

/** Issues a secret test key of a tenant as the platform does. */
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

async function seedTenant(schema: "tenant_alpha" | "tenant_beta", name: string): Promise<void> {
  await tenantTx(tenantDb, schema, async (trx) => {
    await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
  });
}

const idempotencyKey = (): string => randomBytes(16).toString("hex");
const alpha = (extra: Readonly<Record<string, string>> = {}) => ({ "X-Api-Key": alphaSk, ...extra });
const alphaTx = <T>(run: (trx: Transaction<TenantDatabase>) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", run);

interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

interface CheckoutBody {
  readonly id: string;
  readonly pricedOfferId: string;
  readonly basePricedOfferId: string;
  readonly totals: {
    readonly offer: MoneyBody;
    readonly ancillaries: MoneyBody;
    readonly cardFee: MoneyBody | null;
    readonly total: MoneyBody;
  };
  readonly ancillaries: Array<Record<string, unknown>>;
  readonly version: number;
}

interface CatalogueOption {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly quantity: number | null;
  readonly serviceName: string | null;
  readonly price: MoneyBody | null;
}

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    readonly fieldErrors?: Array<{ path: string; code: string }>;
  };
}

const eur = (amount: string): MoneyBody => ({ amount: new Money(amount).toFixed(2), currency: "EUR" });
const plus = (...amounts: readonly string[]): string =>
  amounts.reduce((sum, amount) => sum.plus(amount), new Money(0)).toFixed(2);

let searchCount = 0;

/** A checkout opened for a test, with the total of its base priced offer. */
interface OpenedCheckout {
  readonly checkout: CheckoutBody;
  readonly baseTotal: string;
}

/** An opened checkout with the bag and service options of its base catalogue (flights.getAncillaries). */
interface CheckoutFixture extends OpenedCheckout {
  readonly bag: CatalogueOption;
  readonly twoBags: CatalogueOption;
  readonly priority: CatalogueOption;
}

/**
 * A guest checkout of alpha opened with its secret key from a new priced offer of offer 2 of a new search; `include`
 * is the pricing's (the defaults when omitted).
 */
async function openCheckout(include?: readonly string[]): Promise<OpenedCheckout> {
  searchCount += 1;
  const searched = await request(api.server)
    .post("/v1/flight-searches")
    .set(alpha({ "Idempotency-Key": idempotencyKey() }))
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
    .set(alpha({ "Idempotency-Key": idempotencyKey() }))
    .send({ offerIds: [offerId], ...(include === undefined ? {} : { include }) });
  expect(priced.status).toBe(201);
  const pricedOffer = priced.body as { id: string; price: { total: MoneyBody } };
  const created = await request(api.server)
    .post("/v1/checkouts")
    .set(alpha({ "Idempotency-Key": idempotencyKey() }))
    .send({ pricedOfferId: pricedOffer.id });
  expect(created.status).toBe(201);
  return { checkout: created.body as CheckoutBody, baseTotal: pricedOffer.price.total.amount };
}

/** `openCheckout` with the default `include` and the options of its base catalogue. */
async function newCheckout(): Promise<CheckoutFixture> {
  const opened = await openCheckout();
  const catalogue = await request(api.server)
    .get(`/v1/priced-offers/${opened.checkout.pricedOfferId}/ancillaries`)
    .set(alpha());
  expect(catalogue.status).toBe(200);
  const options = catalogue.body as { checkedBags: CatalogueOption[]; otherServices: CatalogueOption[] };
  const bag = options.checkedBags.find((option) => option.quantity === 1);
  const twoBags = options.checkedBags.find((option) => option.quantity === 2);
  const priority = options.otherServices.find((option) => option.serviceName === "PRIORITY_BOARDING");
  if (bag === undefined || twoBags === undefined || priority === undefined) {
    throw new Error("the stub's catalogue lacks the bag and service options of the fixture");
  }
  return { ...opened, bag, twoBags, priority };
}

/**
 * The budget of a test's checkout, opened in `beforeEach` (a search, a pricing, the checkout and its catalogue: four
 * API calls, two of them to the Amadeus stub), so the tests themselves only make the calls they check.
 */
const CHECKOUT_SETUP_TIMEOUT_MS = 30_000;

const setAncillaries = (checkoutId: string, body: object, headers: Readonly<Record<string, string>> = {}) =>
  request(api.server).put(`/v1/checkouts/${checkoutId}/ancillaries`).set(alpha(headers)).send(body);

/** The number of Flight Offers Price calls the stub answered so far. */
const pricingCalls = (): number =>
  stub.requests().filter((entry) => entry.operation === "quoteAirOffers").length;

/** The checkout's own rows: the `checkouts` row and its `checkout_ancillaries`. */
async function checkoutRows(checkoutId: string) {
  return await alphaTx(async (trx) => ({
    checkout: await trx
      .selectFrom("checkouts")
      .selectAll()
      .select([
        sql<string>`offer_amount::text`.as("offer"),
        sql<string>`ancillaries_amount::text`.as("ancillaries"),
        sql<string>`fees_amount::text`.as("fees"),
        sql<string>`total_amount::text`.as("total"),
        sql<boolean>`total_amount = offer_amount + ancillaries_amount + fees_amount`.as("balanced"),
      ])
      .where("id", "=", checkoutId)
      .executeTakeFirstOrThrow(),
    ancillaries: await trx
      .selectFrom("checkout_ancillaries")
      .selectAll()
      .select([sql<string>`net_amount::text`.as("net"), sql<string>`price_amount::text`.as("price")])
      .where("checkout_id", "=", checkoutId)
      .orderBy("created_at")
      .execute(),
  }));
}

// Cloning the template, starting the stub and building the API's module graph (Nest, pools, Redis, the OTA document's
// validators) take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its
// own timeout, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations (the Checkout schema is large) compile on their first check: here,
  // with every status the tests below check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["createFlightSearch", [201]],
    ["priceFlightOffers", [201]],
    ["createCheckout", [201]],
    ["getCheckout", [200]],
    ["getPricedOfferAncillaries", [200]],
    ["setCheckoutAncillaries", [200, 400, 403, 404, 409, 412, 422]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, keys] = await Promise.all([createTestDatabase(), useRedis(), testKeyProvider()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  accountId = await insertAccount(clientId, secret);
  const alphaId = await insertTenant("alpha");
  const betaId = await insertTenant("beta");
  alphaSk = await issueKey(alphaId);
  betaSk = await issueKey(betaId);
  await seedTenant("tenant_alpha", "Alpha Travel");
  await seedTenant("tenant_beta", "Beta Trips");
  await alphaTx((trx) =>
    trx
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
      .execute(),
  );
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  api = await createTestApp({ database: db, redis, env: { AMADEUS_BASE_URL_TEST: stub.url } });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(async () => {
  // Full Amadeus buckets, rate limits and no single-flight keys from the previous test.
  await redis.client.flushdb();
});

describe("checkout.setAncillaries", () => {
  let fixture: CheckoutFixture;

  beforeEach(async () => {
    fixture = await newCheckout();
  }, CHECKOUT_SETUP_TIMEOUT_MS);

  it("re-prices a bag into a child priced offer, with total = offer + ancillaries + fees [OBE-037 AC1]", async () => {
    const { checkout, baseTotal, bag } = fixture;
    const calls = pricingCalls();
    const extras = plus(bag.price?.amount ?? "0", EXTRA_FEE);
    const total = plus(baseTotal, extras);

    const res = await setAncillaries(
      checkout.id,
      { selections: [{ optionId: bag.id, travelerId: "1" }], expectedTotal: eur(total) },
      { "If-Match": '"1"' },
    );

    expect(res.status).toBe(200);
    expectResponseToMatch("setCheckoutAncillaries", res);
    expect(res.headers["etag"]).toBe('"2"');
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as CheckoutBody;
    expect(body.pricedOfferId).toMatch(/^prc_/);
    expect(body.pricedOfferId).not.toBe(checkout.pricedOfferId);
    expect(body).toMatchObject({
      basePricedOfferId: checkout.pricedOfferId,
      version: 2,
      totals: { offer: eur(baseTotal), ancillaries: eur(extras), cardFee: null, total: eur(total) },
    });
    expect(body.ancillaries).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^can_/) as unknown,
        optionId: bag.id,
        type: "CHECKED_BAGS",
        label: bag.label,
        travelerId: "1",
        segmentIds: ["3"],
        quantity: 1,
        weight: 23,
        weightUnit: "KG",
        price: eur(extras),
      }),
    ]);
    // One Flight Offers Price call, with the bag in the traveller's fare detail.
    expect(pricingCalls()).toBe(calls + 1);
    const sent = await alphaTx((trx) =>
      trx
        .selectFrom("supplier_requests")
        .select(
          sql<unknown>`request_body #> '{data,flightOffers,0,travelerPricings,0,fareDetailsBySegment,0,additionalServices}'`.as(
            "services",
          ),
        )
        .where("operation", "=", "checkout.setAncillaries")
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow(),
    );
    expect(sent.services).toEqual({ chargeableCheckedBags: { quantity: 1, weight: 23, weightUnit: "KG" } });
    // The child holds the flights only, priced as the base; the extra's fee line is in its snapshot.
    const prices = await alphaTx((trx) =>
      trx
        .selectFrom("priced_offers")
        .select([
          "id",
          "parent_priced_offer_id as parent",
          sql<string>`selling_total::text`.as("selling"),
          sql<unknown>`response #> '{velexis,extras,feeLines}'`.as("feeLines"),
        ])
        .where("id", "in", [checkout.pricedOfferId, body.pricedOfferId])
        .execute(),
    );
    const base = prices.find((row) => row.id === checkout.pricedOfferId);
    const child = prices.find((row) => row.id === body.pricedOfferId);
    expect(child).toMatchObject({ parent: checkout.pricedOfferId, selling: base?.selling });
    expect(child?.feeLines).toEqual([
      expect.objectContaining({ feeType: "ancillary_service", amount: EXTRA_FEE, extraRef: "selection:0" }),
    ]);
    // The stored totals satisfy the table's CHECK, and the extra keeps its net next to its selling price.
    const rows = await checkoutRows(checkout.id);
    expect(rows.checkout).toMatchObject({
      priced_offer_id: body.pricedOfferId,
      base_priced_offer_id: checkout.pricedOfferId,
      offer: baseTotal,
      ancillaries: extras,
      fees: "0.00",
      total,
      balanced: true,
      version: 2,
    });
    expect(rows.ancillaries).toEqual([
      expect.objectContaining({
        type: "CHECKED_BAGS",
        segment_id: "3",
        net: bag.price?.amount,
        price: extras,
      }),
    ]);
    // checkout.get answers the same checkout.
    const read = await request(api.server).get(`/v1/checkouts/${checkout.id}`).set(alpha());
    expect(read.status).toBe(200);
    expect(read.body).toEqual(body);
  });

  it("keeps the card fee in the total: total = offer + ancillaries + fees [OBE-037 AC1]", async () => {
    const { checkout, baseTotal, bag } = fixture;
    // A card fee as checkout.updatePayment stores it for a known brand (the payment itself is not this test's).
    const cardFee = "3.10";
    await alphaTx((trx) =>
      trx
        .updateTable("checkouts")
        .set({
          payment_brand: "VISA",
          fees_amount: cardFee,
          total_amount: sql`offer_amount + ancillaries_amount + ${cardFee}::numeric`,
        })
        .where("id", "=", checkout.id)
        .execute(),
    );
    const extras = plus(bag.price?.amount ?? "0", EXTRA_FEE);
    const total = plus(baseTotal, extras, cardFee);

    const res = await setAncillaries(checkout.id, {
      selections: [{ optionId: bag.id, travelerId: "1" }],
      expectedTotal: eur(total),
    });

    expect(res.status).toBe(200);
    expectResponseToMatch("setCheckoutAncillaries", res);
    expect((res.body as CheckoutBody).totals).toMatchObject({
      offer: eur(baseTotal),
      ancillaries: eur(extras),
      cardFee: eur(cardFee),
      total: eur(total),
    });
    expect((await checkoutRows(checkout.id)).checkout).toMatchObject({
      offer: baseTotal,
      ancillaries: extras,
      fees: cardFee,
      total,
      balanced: true,
    });

    // Removing the extras keeps the card fee too.
    const reverted = await setAncillaries(checkout.id, { selections: [] }, { "If-Match": '"2"' });
    expect(reverted.status).toBe(200);
    expect((reverted.body as CheckoutBody).totals).toMatchObject({
      ancillaries: eur("0"),
      cardFee: eur(cardFee),
      total: eur(plus(baseTotal, cardFee)),
    });
  });

  it("prices extras chosen by type, and an empty list reverts to the base priced offer without a call [OBE-037 AC1]", async () => {
    const { checkout, baseTotal, twoBags, priority } = fixture;
    const extras = plus(twoBags.price?.amount ?? "0", EXTRA_FEE, priority.price?.amount ?? "0", EXTRA_FEE);

    const res = await setAncillaries(checkout.id, {
      selections: [
        { type: "CHECKED_BAGS", travelerId: "1", quantity: 2 },
        { type: "OTHER_SERVICES", serviceName: "PRIORITY_BOARDING", travelerId: "1", segmentIds: ["3"] },
      ],
    });

    expect(res.status).toBe(200);
    expectResponseToMatch("setCheckoutAncillaries", res);
    const body = res.body as CheckoutBody;
    expect(body.totals).toMatchObject({
      offer: eur(baseTotal),
      ancillaries: eur(extras),
      total: eur(plus(baseTotal, extras)),
    });
    expect(body.ancillaries).toEqual([
      expect.objectContaining({ optionId: twoBags.id, type: "CHECKED_BAGS", quantity: 2 }),
      expect.objectContaining({
        optionId: priority.id,
        type: "OTHER_SERVICES",
        serviceName: "PRIORITY_BOARDING",
      }),
    ]);
    expect((await checkoutRows(checkout.id)).checkout).toMatchObject({ balanced: true });

    const calls = pricingCalls();
    const reverted = await setAncillaries(checkout.id, { selections: [] }, { "If-Match": '"2"' });

    expect(reverted.status).toBe(200);
    expectResponseToMatch("setCheckoutAncillaries", reverted);
    expect(reverted.body).toMatchObject({
      pricedOfferId: checkout.pricedOfferId,
      version: 3,
      ancillaries: [],
      totals: { offer: eur(baseTotal), ancillaries: eur("0"), total: eur(baseTotal) },
    });
    expect(pricingCalls()).toBe(calls);
    const rows = await checkoutRows(checkout.id);
    expect(rows.ancillaries).toEqual([]);
    expect(rows.checkout).toMatchObject({ priced_offer_id: checkout.pricedOfferId, balanced: true });
  });

  it("answers 409 PRICE_CHANGED to a mismatching expectedTotal and changes nothing [OBE-037 AC2]", async () => {
    const { checkout, baseTotal, bag, priority } = fixture;
    const first = await setAncillaries(checkout.id, { selections: [{ optionId: bag.id, travelerId: "1" }] });
    expect(first.status).toBe(200);
    const shown = first.body as CheckoutBody;
    const before = await checkoutRows(checkout.id);
    const selections = [
      { optionId: bag.id, travelerId: "1" },
      { optionId: priority.id, travelerId: "1" },
    ];
    const newTotal = plus(
      baseTotal,
      bag.price?.amount ?? "0",
      priority.price?.amount ?? "0",
      EXTRA_FEE,
      EXTRA_FEE,
    );

    // The customer saw the total of the bag alone.
    const res = await setAncillaries(
      checkout.id,
      { selections, expectedTotal: shown.totals.total },
      { "If-Match": '"2"' },
    );

    expect(res.status).toBe(409);
    expectResponseToMatch("setCheckoutAncillaries", res);
    const error = (res.body as ErrorBody).error;
    expect(error.code).toBe("PRICE_CHANGED");
    expect(error.details).toEqual({
      oldPrice: shown.totals.total,
      newPrice: eur(newTotal),
      pricedOfferId: expect.stringMatching(/^prc_/) as unknown,
    });
    // Nothing of the checkout changed: its row (priced offer, amounts, version), its extras and its answer.
    expect(await checkoutRows(checkout.id)).toEqual(before);
    const read = await request(api.server).get(`/v1/checkouts/${checkout.id}`).set(alpha());
    expect(read.body).toEqual(shown);
    // The new priced offer the details name exists, a child of the base the checkout does not buy.
    const named = await alphaTx((trx) =>
      trx
        .selectFrom("priced_offers")
        .select("parent_priced_offer_id as parent")
        .where("id", "=", String(error.details?.["pricedOfferId"]))
        .executeTakeFirstOrThrow(),
    );
    expect(named.parent).toBe(checkout.pricedOfferId);

    // Called again with the new total, the selection is applied.
    const retried = await setAncillaries(
      checkout.id,
      { selections, expectedTotal: error.details?.["newPrice"] },
      { "If-Match": '"2"' },
    );
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ version: 3, totals: { total: eur(newTotal) } });
  });

  it("answers 409 PRICE_CHANGED when Amadeus moved the fare and the expected total was the old one [OBE-037 AC2]", async () => {
    const { checkout, baseTotal, bag } = fixture;
    const before = await checkoutRows(checkout.id);
    const selections = [{ optionId: bag.id, travelerId: "1" }];
    const extras = plus(bag.price?.amount ?? "0", EXTRA_FEE);

    const res = await setAncillaries(
      checkout.id,
      { selections, expectedTotal: eur(plus(baseTotal, extras)) },
      stubScenario("price-changed"),
    );

    expect(res.status).toBe(409);
    expectResponseToMatch("setCheckoutAncillaries", res);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: "PRICE_CHANGED",
      details: { newPrice: eur(plus(baseTotal, PRICE_CHANGE, extras)) },
    });
    expect(await checkoutRows(checkout.id)).toEqual(before);

    // Without expectedTotal the moved fare is applied: the flights are priced again, the extras stay as they were.
    const applied = await setAncillaries(checkout.id, { selections }, stubScenario("price-changed"));
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      version: 2,
      totals: {
        offer: eur(plus(baseTotal, PRICE_CHANGE)),
        ancillaries: eur(extras),
        total: eur(plus(baseTotal, PRICE_CHANGE, extras)),
      },
    });
    expect((await checkoutRows(checkout.id)).checkout).toMatchObject({ balanced: true });
  });

  it("answers 422 ANCILLARY_NOT_AVAILABLE for an option outside the catalogue or for another traveller", async () => {
    const { checkout, bag } = fixture;
    const calls = pricingCalls();

    for (const [selection, reason] of [
      [{ optionId: newId("anc"), travelerId: "1" }, "unknown_option"],
      [{ optionId: bag.id, travelerId: "2" }, "not_bookable_for_traveler"],
      [{ optionId: bag.id, travelerId: "1", segmentIds: ["9"] }, "not_bookable_for_segment"],
      [{ optionId: bag.id, travelerId: "1", quantity: 3 }, "quantity_exceeded"],
      [{ type: "OTHER_SERVICES", serviceName: "FAST_TRACK", travelerId: "1" }, "unknown_option"],
    ] as const) {
      const res = await setAncillaries(checkout.id, {
        selections: [{ optionId: bag.id, travelerId: "1" }, selection],
      });
      expect([reason, res.status]).toEqual([reason, 422]);
      expectResponseToMatch("setCheckoutAncillaries", res);
      expect((res.body as ErrorBody).error).toMatchObject({
        code: "ANCILLARY_NOT_AVAILABLE",
        details: { selectionIndex: 1, reason },
      });
    }
    const duplicate = await setAncillaries(checkout.id, {
      selections: [
        { optionId: bag.id, travelerId: "1" },
        { type: "CHECKED_BAGS", travelerId: "1", quantity: 1 },
      ],
    });
    expect(duplicate.status).toBe(400);
    expectResponseToMatch("setCheckoutAncillaries", duplicate);
    expect((duplicate.body as ErrorBody).error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/selections/1", code: "duplicate" }),
    ]);
    expect(pricingCalls()).toBe(calls);
    expect((await checkoutRows(checkout.id)).checkout).toMatchObject({ version: 1 });
  });

  it("[FIX-W22 AC1] answers 422 ANCILLARY_NOT_AVAILABLE when Amadeus answers without a selected extra: it would be paid for and not booked", async () => {
    const { checkout, bag, priority } = fixture;
    // Amadeus answers the pricing, but the fare details no longer carry the bag.
    const client = api.app.get(AmadeusClient, { strict: false });
    const real = client.quoteAirOffers.bind(client);
    vi.spyOn(client, "quoteAirOffers").mockImplementation(async (context, input) => {
      const reply = await real(context, input);
      const offers = (reply.body as { data: { flightOffers: unknown[] } }).data.flightOffers;
      for (const offer of offers as Array<{ travelerPricings: Array<{ fareDetailsBySegment: object[] }> }>) {
        for (const detail of offer.travelerPricings.flatMap((pricing) => pricing.fareDetailsBySegment)) {
          const services = (detail as { additionalServices?: Record<string, unknown> }).additionalServices;
          delete services?.["chargeableCheckedBags"];
        }
      }
      return reply;
    });

    const res = await setAncillaries(checkout.id, {
      selections: [
        { optionId: priority.id, travelerId: "1" },
        { optionId: bag.id, travelerId: "1" },
      ],
    });

    expect(res.status).toBe(422);
    expectResponseToMatch("setCheckoutAncillaries", res);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: "ANCILLARY_NOT_AVAILABLE",
      details: { selectionIndex: 1, reason: "rejected_by_airline" },
    });
    const rows = await checkoutRows(checkout.id);
    expect(rows.checkout).toMatchObject({ version: 1, priced_offer_id: checkout.pricedOfferId });
    expect(rows.ancillaries).toEqual([]);
  });

  it("answers 409 SOLD_OUT when the fare is gone, and changes nothing", async () => {
    const { checkout, bag } = fixture;
    const before = await checkoutRows(checkout.id);

    const res = await setAncillaries(
      checkout.id,
      { selections: [{ optionId: bag.id, travelerId: "1" }] },
      stubScenario("sold-out"),
    );

    expect(res.status).toBe(409);
    expectResponseToMatch("setCheckoutAncillaries", res);
    expect((res.body as ErrorBody).error.code).toBe("SOLD_OUT");
    expect(await checkoutRows(checkout.id)).toEqual(before);
  });

  it("answers 412 to a stale If-Match, 404 to another tenant, and 403 while the storefront sells no extras", async () => {
    const { checkout, bag } = fixture;
    const selections = [{ optionId: bag.id, travelerId: "1" }];

    const stale = await setAncillaries(checkout.id, { selections }, { "If-Match": '"5"' });
    expect(stale.status).toBe(412);
    expectResponseToMatch("setCheckoutAncillaries", stale);
    expect((stale.body as ErrorBody).error.code).toBe("PRECONDITION_FAILED");

    const foreign = await request(api.server)
      .put(`/v1/checkouts/${checkout.id}/ancillaries`)
      .set({ "X-Api-Key": betaSk })
      .send({ selections });
    expect(foreign.status).toBe(404);
    expectResponseToMatch("setCheckoutAncillaries", foreign);

    const toggle = (on: boolean) =>
      alphaTx((trx) =>
        trx
          .updateTable("storefront_settings")
          .set({ features: sql`jsonb_set(features, '{ancillaries}', ${JSON.stringify(on)}::jsonb, true)` })
          .execute(),
      );
    await toggle(false);
    try {
      const disabled = await setAncillaries(checkout.id, { selections });
      expect(disabled.status).toBe(403);
      expectResponseToMatch("setCheckoutAncillaries", disabled);
      expect((disabled.body as ErrorBody).error).toMatchObject({
        code: "FEATURE_DISABLED",
        details: { feature: "ancillaries" },
      });
      // Removing every extra needs no catalogue, but the feature still decides.
      const none = await setAncillaries(checkout.id, { selections: [] });
      expect(none.status).toBe(403);
      expect((none.body as ErrorBody).error.code).toBe("FEATURE_DISABLED");
    } finally {
      await toggle(true);
    }
    expect((await checkoutRows(checkout.id)).checkout).toMatchObject({ version: 1, ancillaries: "0.00" });
  });
});

describe("checkout.setAncillaries on a base priced offer without a catalogue", () => {
  let opened: OpenedCheckout;

  beforeEach(async () => {
    // Priced without `bags` and `other-services`: no catalogue is stored with it, and none is loaded here.
    opened = await openCheckout(["detailed-fare-rules"]);
  }, CHECKOUT_SETUP_TIMEOUT_MS);

  it("reverts an empty list to the base priced offer without loading a catalogue from Amadeus", async () => {
    const { checkout, baseTotal } = opened;
    const calls = pricingCalls();

    const res = await setAncillaries(checkout.id, { selections: [] }, { "If-Match": '"1"' });

    expect(res.status).toBe(200);
    expectResponseToMatch("setCheckoutAncillaries", res);
    expect(res.body).toMatchObject({
      pricedOfferId: checkout.pricedOfferId,
      version: 2,
      ancillaries: [],
      totals: { offer: eur(baseTotal), ancillaries: eur("0"), total: eur(baseTotal) },
    });
    // No Flight Offers Price call at all: neither a re-pricing nor a catalogue load.
    expect(pricingCalls()).toBe(calls);
    expect((await checkoutRows(checkout.id)).checkout).toMatchObject({
      priced_offer_id: checkout.pricedOfferId,
      balanced: true,
    });
  });
});
