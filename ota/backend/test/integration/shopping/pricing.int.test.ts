// flights.price, flights.getPricedOffer, flights.getAncillaries and flights.getFareRules against PostgreSQL 16, Redis 7
// and the Amadeus stub (OBE-023; ota/docs/flows/search-and-price.md §2 steps 7–8 and §3, OADR-0002 point 3, OADR-0005
// points 7 and 8). The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned), writes the
// platform rows of two tenants on the Velexis test Amadeus account as the platform does (tenants, their connections
// with an office each, API keys), seeds their settings and default markup rule as provisioning does, gives alpha a
// 10 % markup rule, a 10.00 EUR booking service fee and a 1 % ticketing fee, and calls the API in-process with secret
// keys, a console:automation key, a customer token and the hosted storefront's edge headers.
//
// The stub answers its five-offer Madrid–Paris fixture for every search; Flight Offers Price echoes the posted offers
// with the booking requirements and the `included` maps of its fixture (two checked-bag options at 30.00 and 65.00
// EUR, priority boarding at 9.00 EUR, the penalty notes "NON-REFUNDABLE" with a change charge). The tests price offer 2
// (Iberia IB3436, net 98.47 EUR, one adult). Every answer is checked against the OTA document (`expectResponseToMatch`).
import { randomBytes } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
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
import { startAmadeusStub, stubScenario, type AmadeusStub } from "@velexis/testing/amadeus";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import type { ApiConfig } from "../../../src/config";
import { TokenService } from "../../../src/identity/token.service";
import { Money } from "../../../src/pricing/pricing.types";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeWriteHeaders, newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const ALPHA_HOST = "alpha.ota.example.com";

/** The net grand total of the search fixture's offer 2 (the offer the tests price) and of its offer 3. */
const NET = "98.47";
const NET_3 = "109.32";
/** The stub's `price-changed` scenario raises each traveller's price by 10.00 (one adult here). */
const NET_CHANGED = "108.47";
/** Alpha's markup: 10 % of the net total, rounded half-up to cents. */
const markupOf = (net: string): string => new Money(net).times("0.1").toFixed(2);
const sellingOf = (net: string): string => new Money(net).plus(markupOf(net)).toFixed(2);
/** Alpha's fees at pricing: 10.00 EUR booking service fee plus 1 % ticketing on the price after markup. */
const feesOf = (sellingTotal: string): string =>
  new Money("10.00").plus(new Money(sellingTotal).times("0.01").toDecimalPlaces(2)).toFixed(2);
const totalOf = (net: string): string => new Money(sellingOf(net)).plus(feesOf(sellingOf(net))).toFixed(2);

/** A one-way SIMPLE search Madrid → Paris Orly for one adult. */
const SIMPLE = Object.freeze({
  mode: "simple",
  originLocationCode: "MAD",
  destinationLocationCode: "ORY",
  departureDate: "2027-01-15",
  adults: 1,
});

/** A synthetic traveller (no real person) with a passport number that must never be stored in clear. */
const PASSPORT_NUMBER = "X98765432";
const TRAVELER = Object.freeze({
  id: "1",
  dateOfBirth: "1990-02-15",
  gender: "FEMALE",
  name: { firstName: "TESTA", lastName: "SAMPLE" },
  documents: [
    {
      documentType: "PASSPORT",
      number: PASSPORT_NUMBER,
      expiryDate: "2031-05-01",
      issuanceCountry: "ES",
      nationality: "ES",
      holder: true,
    },
  ],
});

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
let alphaId: string;
let alphaSk: string;
let alphaConsole: string;
let betaSk: string;
let tokens: TokenService;

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
async function issueKey(tenantId: string, scopes: readonly string[] = []): Promise<string> {
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
      ...(scopes.length === 0 ? {} : { scopes: [...scopes] }),
    })
    .execute();
  return key;
}

/** Settings and the default markup rule as provisioning seeds them. */
async function seedTenant(schema: "tenant_alpha" | "tenant_beta", name: string): Promise<void> {
  await tenantTx(tenantDb, schema, async (trx) => {
    await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
  });
}

/** Alpha's 10 % markup, its 10.00 EUR booking service fee and its 1 % ticketing fee. */
async function seedAlphaRules(): Promise<void> {
  await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
    await trx
      .insertInto("markup_rules")
      .values({
        id: newId("mkr"),
        name: "Ten percent",
        scope: JSON.stringify({}),
        calculation: "percentage",
        percentage: "10",
        priority: 10,
        stackable: false,
        is_default: false,
        is_active: true,
      })
      .execute();
    await trx
      .insertInto("fee_rules")
      .values([
        {
          id: newId("fee"),
          name: "Booking fee",
          label: "Booking service fee",
          fee_type: "booking_service",
          scope: JSON.stringify({}),
          calculation: "fixed",
          fixed_amount: "10.00",
          currency: "EUR",
          applies_per: "booking",
        },
        {
          id: newId("fee"),
          name: "Ticketing",
          label: "Ticketing fee",
          fee_type: "ticketing",
          scope: JSON.stringify({}),
          calculation: "percentage",
          percentage: "1",
          applies_per: "booking",
        },
      ])
      .execute();
  });
}

const idempotencyKey = (): string => randomBytes(16).toString("hex");

const search = (key: string, body: unknown = SIMPLE, headers: Readonly<Record<string, string>> = {}) =>
  request(api.server)
    .post("/v1/flight-searches")
    .set({ "X-Api-Key": key, "Idempotency-Key": idempotencyKey(), ...headers })
    .send(body as object);

const price = (
  key: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  idempotency: string = idempotencyKey(),
) =>
  request(api.server)
    .post("/v1/priced-offers")
    .set({ "X-Api-Key": key, "Idempotency-Key": idempotency, ...headers })
    .send(body as object);

const read = (key: string, path: string, headers: Readonly<Record<string, string>> = {}) =>
  request(api.server)
    .get(path)
    .set({ "X-Api-Key": key, ...headers });

const CONSOLE = Object.freeze({ "X-Velexis-Scope": "console" });

/** Every key of a JSON value whose name starts with `net` (netPrice, netTotal, …), as JSON pointers. */
function netKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => netKeys(item, `${path}/${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(/^net/i.test(key) ? [`${path}/${key}`] : []),
      ...netKeys(item, `${path}/${key}`),
    ]);
  }
  return [];
}

/** Every string value of a JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

interface PricedOfferBody {
  readonly id: string;
  readonly status: string;
  readonly searchId: string;
  readonly offerIds: string[];
  readonly customerId?: string | null;
  readonly offers: Array<{
    readonly id: string;
    readonly price: { readonly total: MoneyBody };
    readonly amadeus?: { readonly price: { readonly grandTotal: string } };
  }>;
  readonly price: {
    readonly total: MoneyBody;
    readonly base: MoneyBody;
    readonly fees: MoneyBody;
    readonly breakdown: {
      readonly fees: Array<{
        readonly type: string;
        readonly amount: MoneyBody;
        readonly description: string | null;
      }>;
      readonly travelers: Array<{ readonly travelerId: string; readonly total: MoneyBody }>;
    };
  };
  readonly priceChange: {
    readonly changed: boolean;
    readonly oldPrice: MoneyBody;
    readonly newPrice: MoneyBody;
    readonly difference: MoneyBody;
    readonly direction: string;
  };
  readonly bookingRequirements: {
    readonly emailAddressRequired: boolean;
    readonly travelerRequirements: Array<{ readonly travelerId: string }>;
  };
  readonly creditCardFees: Array<{
    readonly brand: string;
    readonly amount: MoneyBody;
    readonly offerId: string;
  }>;
  readonly ancillaries: {
    readonly loaded: boolean;
    readonly checkedBags: boolean;
    readonly otherServices: boolean;
  };
  readonly ancillaryCatalogue: CatalogueBody | null;
  readonly fareRules: FareRulesBody | null;
  readonly conditions: { readonly refundable: boolean | null; readonly changeable: boolean | null };
  readonly include: string[];
  readonly warnings: Array<{ readonly code?: number; readonly title: string }>;
  readonly amadeus: {
    readonly query: { readonly include: string };
    readonly data: { readonly flightOffers: Array<{ readonly price: { readonly grandTotal: string } }> };
  };
  readonly netPrice?: MoneyBody;
  readonly markup?: {
    readonly amount: MoneyBody;
    readonly ruleId: string | null;
    readonly serviceFee: MoneyBody | null;
  };
  readonly expiresAt: string;
  readonly createdAt: string;
}

interface OptionBody {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly label: string;
  readonly price: MoneyBody | null;
  readonly netPrice?: MoneyBody | null;
  readonly quantity: number | null;
  readonly amadeus: { readonly flightOfferId: string; readonly includedKey: string | null };
}

interface CatalogueBody {
  readonly pricedOfferId: string;
  readonly currency: string;
  readonly checkedBags: OptionBody[];
  readonly otherServices: OptionBody[];
  readonly seats: OptionBody[];
  readonly loadedAt: string;
}

interface FareRulesBody {
  readonly pricedOfferId: string;
  readonly available: boolean;
  readonly summary: {
    readonly refundable: boolean | null;
    readonly changeable: boolean | null;
    readonly source: string;
  };
  readonly fareComponents: Array<{ readonly fareBasis: string | null; readonly segmentId: string | null }>;
}

const pricingCalls = () =>
  stub.requests().filter((entry) => entry.operation === "quoteAirOffers" && entry.status !== undefined);

/** A completed search of alpha: its id and its offers' ids by Amadeus offer id. */
async function alphaSearch(
  body: unknown = SIMPLE,
  key: string = alphaSk,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ searchId: string; offers: Map<string, string> }> {
  const res = await search(key, body, headers);
  expect(res.status).toBe(201);
  const searchId = (res.body as { id: string }).id;
  const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx
      .selectFrom("flight_offers")
      .select(["id", "amadeus_offer_id"])
      .where("search_id", "=", searchId)
      .execute(),
  );
  return { searchId, offers: new Map(rows.map((row) => [row.amadeus_offer_id, row.id])) };
}

/**
 * The last ticketing day of the offers the tests price, 60 days ahead. The stub echoes the posted offers, whose
 * fixture date (2027-01-15) would bound a priced offer's expiry (OADR-0002 point 3) and expire every priced offer at
 * its creation once that day has passed: the stored offers get this date instead, so the tests never depend on today.
 */
const LAST_TICKETING_DATE = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);

/** Offer 2 of a new search of alpha (each call searches another day, so no single flight joins an older search). */
let searchCount = 0;
async function offerToPrice(
  key: string = alphaSk,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ searchId: string; offerId: string; others: Map<string, string> }> {
  searchCount += 1;
  const date = new Date(Date.UTC(2027, 1, 1) + searchCount * 86_400_000).toISOString().slice(0, 10);
  const { searchId, offers } = await alphaSearch({ ...SIMPLE, departureDate: date }, key, headers);
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx
      .updateTable("flight_offers")
      .set({
        payload: sql`jsonb_set(payload, '{lastTicketingDate}', to_jsonb(${LAST_TICKETING_DATE}::text))`,
        last_ticketing_date: LAST_TICKETING_DATE,
      })
      .where("search_id", "=", searchId)
      .execute(),
  );
  const offerId = offers.get("2") ?? "";
  expect(offerId).toMatch(/^off_/);
  return { searchId, offerId, others: offers };
}

/** The stored priced offer of alpha. */
async function storedPricedOffer(id: string) {
  return await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx.selectFrom("priced_offers").selectAll().where("id", "=", id).executeTakeFirstOrThrow(),
  );
}

/** Expires a priced offer of alpha. */
async function expire(id: string): Promise<void> {
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx
      .updateTable("priced_offers")
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where("id", "=", id)
      .execute(),
  );
}

// Cloning the template, starting the stub and building the API's module graph (Nest, pools, Redis, the OTA document's
// validators) take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its
// own timeout, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations (the PricedOffer and FlightOffer schemas are large) compile on their
  // first check: here, with every status the tests below check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["createFlightSearch", [201]],
    ["priceFlightOffers", [201, 400, 403, 404, 409, 410, 422]],
    ["getPricedOffer", [200, 404, 410]],
    ["getPricedOfferAncillaries", [200, 403, 404, 410]],
    ["getPricedOfferFareRules", [200, 404, 410]],
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
  alphaId = await insertTenant("alpha");
  const betaId = await insertTenant("beta");
  alphaSk = await issueKey(alphaId);
  alphaConsole = await issueKey(alphaId, ["console:automation", "queues:read"]);
  betaSk = await issueKey(betaId);
  await seedTenant("tenant_alpha", "Alpha Travel");
  await seedTenant("tenant_beta", "Beta Trips");
  await seedAlphaRules();
  tokens = new TokenService(
    { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>,
    new Clock(),
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
  // Full Amadeus buckets and no single-flight keys from the previous test.
  await redis.client.flushdb();
  stub.clearRequests();
});

describe("flights.price", () => {
  it("prices the offer with Amadeus and stores selling = net + markup + fees with the line list [OBE-023 AC1]", async () => {
    const { searchId, offerId } = await offerToPrice();
    stub.clearRequests();

    const res = await price(alphaSk, { offerIds: [offerId] });

    expect(res.status).toBe(201);
    expectResponseToMatch("priceFlightOffers", res);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as PricedOfferBody;
    expect(body.id).toMatch(/^prc_/);
    expect(res.headers["location"]).toBe(`/v1/priced-offers/${body.id}`);
    expect(body).toMatchObject({ status: "active", searchId, offerIds: [offerId], customerId: null });
    // The defaults: ancillaries (the storefront sells them) and the detailed fare rules.
    expect(body.include).toEqual(["bags", "other-services", "detailed-fare-rules"]);
    expect(body.amadeus.query.include).toBe("bags,other-services,detailed-fare-rules");
    // 98.47 net + 9.85 markup + 10.00 booking service + 1.08 ticketing (1 % of 108.32).
    expect(body.price.total).toEqual({ amount: totalOf(NET), currency: "EUR" });
    expect(body.price.fees).toEqual({ amount: feesOf(sellingOf(NET)), currency: "EUR" });
    expect(body.price.breakdown.fees).toEqual([
      {
        type: "service_fee",
        amount: { amount: "10.00", currency: "EUR" },
        description: "Booking service fee",
      },
      { type: "service_fee", amount: { amount: "1.08", currency: "EUR" }, description: "Ticketing fee" },
    ]);
    expect(body.price.breakdown.travelers.map((traveler) => traveler.total.amount)).toEqual([totalOf(NET)]);
    // The offer is unchanged: the results price plus the same fees.
    expect(body.priceChange).toEqual({
      changed: false,
      oldPrice: { amount: totalOf(NET), currency: "EUR" },
      newPrice: { amount: totalOf(NET), currency: "EUR" },
      difference: { amount: "0.00", currency: "EUR" },
      direction: "none",
    });
    // The confirmed offer at its selling price (no fees: they belong to the booking).
    expect(body.offers.map((offer) => [offer.id, offer.price.total.amount])).toEqual([
      [offerId, sellingOf(NET)],
    ]);
    expect(body.bookingRequirements).toMatchObject({
      emailAddressRequired: true,
      mobilePhoneNumberRequired: true,
      travelerRequirements: [{ travelerId: "1", genderRequired: true, dateOfBirthRequired: true }],
    });
    // The embedded catalogue and fare rules of the pricing answer.
    expect(body.ancillaries).toEqual({
      loaded: true,
      checkedBags: true,
      cabinBags: false,
      otherServices: true,
      seats: false,
    });
    expect(
      body.ancillaryCatalogue?.checkedBags.map((option) => [option.quantity, option.price?.amount]),
    ).toEqual([
      [1, "30.00"],
      [2, "65.00"],
    ]);
    expect(body.ancillaryCatalogue?.otherServices.map((option) => option.name)).toEqual([
      "PRIORITY_BOARDING",
    ]);
    expect(body.fareRules).toMatchObject({
      pricedOfferId: body.id,
      available: true,
      summary: { refundable: false, changeable: true, source: "detailed_fare_rules" },
    });
    expect(body.conditions).toMatchObject({ refundable: false, changeable: true });
    // Selling prices only: no net field and no net amount anywhere in the answer.
    expect(netKeys(res.body)).toEqual([]);
    expect(strings(res.body)).not.toContain(NET);
    expect(body).not.toHaveProperty("markup");
    expect(body.amadeus.data.flightOffers[0]?.price.grandTotal).toBe(sellingOf(NET));

    // One Amadeus call, linked to the search; the row satisfies selling = net + markup + fees.
    expect(pricingCalls()).toHaveLength(1);
    const row = await storedPricedOffer(body.id);
    expect(row).toMatchObject({
      environment: "test",
      offer_id: offerId,
      offer_ids: [offerId],
      include_bags: true,
      include_other_services: true,
      include_detailed_fare_rules: true,
      include_credit_card_fees: false,
      price_changed: false,
      currency: "EUR",
      net_total: NET,
      markup_amount: markupOf(NET),
      fee_amount: feesOf(sellingOf(NET)),
      selling_total: totalOf(NET),
    });
    expect(new Money(row.net_total).plus(row.markup_amount).plus(row.fee_amount).toFixed(2)).toBe(
      row.selling_total,
    );
    // OADR-0005 point 8: the line list in the stored payload, with the base rule.
    const snapshot = (row.response as { velexis: Record<string, unknown> }).velexis;
    expect(snapshot["offers"]).toEqual([
      expect.objectContaining({
        offerId,
        net: NET,
        markup: markupOf(NET),
        markupRuleId: row.markup_rule_id,
        markupLines: [expect.objectContaining({ role: "base", amount: markupOf(NET) })],
      }),
    ]);
    expect(snapshot["feeLines"]).toEqual([
      expect.objectContaining({ feeType: "booking_service", amount: "10.00", label: "Booking service fee" }),
      expect.objectContaining({ feeType: "ticketing", amount: "1.08", label: "Ticketing fee" }),
    ]);
    expect(row.booking_requirements).toMatchObject({ emailAddressRequired: true });
    expect(row.amadeus_request).toMatchObject({
      data: { type: "flight-offers-pricing", additionalInformation: { fareRules: true } },
    });
    // OADR-0002 point 3: the offer TTL (30 minutes) bounds it; the last ticketing day (60 days ahead) is later.
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(30 * 60_000);
    expect(body.expiresAt).toBe(row.expires_at.toISOString());
    expect(body).toMatchObject({ lastTicketingDate: LAST_TICKETING_DATE });
    const calls = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .selectFrom("supplier_requests")
        .select(["search_id", "operation"])
        .where("amadeus_operation_id", "=", "quoteAirOffers")
        .where("search_id", "=", searchId)
        .execute(),
    );
    expect(calls).toEqual([{ search_id: searchId, operation: "flights.price" }]);
  });

  it("answers the stub's price-changed scenario with priceChange and both totals; the row holds selling = net + markup + fees [OBE-023 AC1]", async () => {
    const { offerId } = await offerToPrice();
    stub.clearRequests();

    const res = await price(alphaSk, { offerIds: [offerId] }, stubScenario("price-changed"));

    // The document answers 201 (the plan's "200" is the same success); the change is `priceChange.changed`.
    expect(res.status).toBe(201);
    expectResponseToMatch("priceFlightOffers", res);
    const body = res.body as PricedOfferBody;
    const oldTotal = new Money(sellingOf(NET)).plus(feesOf(sellingOf(NET_CHANGED))).toFixed(2);
    expect(body.priceChange).toEqual({
      changed: true,
      oldPrice: { amount: oldTotal, currency: "EUR" },
      newPrice: { amount: totalOf(NET_CHANGED), currency: "EUR" },
      difference: { amount: new Money(totalOf(NET_CHANGED)).minus(oldTotal).toFixed(2), currency: "EUR" },
      direction: "up",
    });
    expect(body.price.total.amount).toBe(totalOf(NET_CHANGED));
    expect(body.warnings).toEqual([expect.objectContaining({ code: 37200, title: "PRICE DISCREPANCY" })]);
    expect(netKeys(res.body)).toEqual([]);
    expect(strings(res.body)).not.toContain(NET_CHANGED);

    const row = await storedPricedOffer(body.id);
    expect(row).toMatchObject({
      price_changed: true,
      net_total: NET_CHANGED,
      markup_amount: markupOf(NET_CHANGED),
      fee_amount: feesOf(sellingOf(NET_CHANGED)),
      selling_total: totalOf(NET_CHANGED),
    });
    expect(new Money(row.net_total).plus(row.markup_amount).plus(row.fee_amount).toFixed(2)).toBe(
      row.selling_total,
    );
  });

  it("answers 409 PRICE_CHANGED for another expectedTotal, after storing the priced offer", async () => {
    const { offerId } = await offerToPrice();

    const res = await price(
      alphaSk,
      { offerIds: [offerId], expectedTotal: { amount: sellingOf(NET), currency: "EUR" } },
      stubScenario("price-changed"),
    );

    expect(res.status).toBe(409);
    expectResponseToMatch("priceFlightOffers", res);
    const details = (res.body as { error: { code: string; details: Record<string, unknown> } }).error;
    expect(details.code).toBe("PRICE_CHANGED");
    expect(details.details).toMatchObject({
      oldPrice: { amount: sellingOf(NET), currency: "EUR" },
      newPrice: { amount: totalOf(NET_CHANGED), currency: "EUR" },
    });
    const pricedOfferId = details.details["pricedOfferId"] as string;
    const stored = await read(alphaSk, `/v1/priced-offers/${pricedOfferId}`);
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({
      id: pricedOfferId,
      price: { total: { amount: totalOf(NET_CHANGED) } },
    });

    // The expected total of the confirmed price passes.
    const same = await price(alphaSk, {
      offerIds: [offerId],
      expectedTotal: { amount: totalOf(NET), currency: "EUR" },
    });
    expect(same.status).toBe(201);
  });

  it("gives console scope the net price, the markup and the verbatim Amadeus answer", async () => {
    const { offerId } = await offerToPrice();

    const res = await price(alphaConsole, { offerIds: [offerId] }, CONSOLE);

    expect(res.status).toBe(201);
    expectResponseToMatch("priceFlightOffers", res);
    const body = res.body as PricedOfferBody;
    expect(body.netPrice).toEqual({ amount: NET, currency: "EUR" });
    expect(body.markup).toMatchObject({
      amount: { amount: markupOf(NET), currency: "EUR" },
      serviceFee: { amount: feesOf(sellingOf(NET)), currency: "EUR" },
    });
    expect(body.markup?.ruleId).toMatch(/^mkr_/);
    expect(body.amadeus.data.flightOffers[0]?.price.grandTotal).toBe(NET);
    expect(body.ancillaryCatalogue?.checkedBags[0]?.netPrice).toEqual({ amount: "30.00", currency: "EUR" });
  });

  it("prices two offers of one search together, with the booking fees once", async () => {
    const { offerId, others } = await offerToPrice();
    const other = others.get("3") ?? "";

    const res = await price(alphaSk, { offerIds: [offerId, other], include: [] });

    expect(res.status).toBe(201);
    expectResponseToMatch("priceFlightOffers", res);
    const body = res.body as PricedOfferBody;
    expect(body.offerIds).toEqual([offerId, other]);
    expect(body.offers.map((offer) => offer.price.total.amount)).toEqual([sellingOf(NET), sellingOf(NET_3)]);
    const selling = new Money(sellingOf(NET)).plus(sellingOf(NET_3)).toFixed(2);
    expect(body.price.total.amount).toBe(new Money(selling).plus(feesOf(selling)).toFixed(2));
    expect(body.price.breakdown.fees.map((fee) => fee.description)).toEqual([
      "Booking service fee",
      "Ticketing fee",
    ]);
    expect(body.include).toEqual([]);
    expect(body.ancillaryCatalogue).toBeNull();
    expect(body.fareRules).toBeNull();
    const row = await storedPricedOffer(body.id);
    expect(row.offer_ids).toEqual([offerId, other]);
    expect(new Money(row.net_total).plus(row.markup_amount).plus(row.fee_amount).toFixed(2)).toBe(
      row.selling_total,
    );
  });

  it("sends the card hints and travellers, and stores the request with the passport number masked", async () => {
    const { offerId } = await offerToPrice();

    const res = await price(alphaSk, {
      offerIds: [offerId],
      payments: [{ brand: "VISA", bin: "411111" }],
      travelers: [TRAVELER],
    });

    expect(res.status).toBe(201);
    expectResponseToMatch("priceFlightOffers", res);
    const body = res.body as PricedOfferBody;
    // Payments add credit-card-fees to the default include; the stub charges 1.20 EUR for VISA.
    expect(body.include).toContain("credit-card-fees");
    expect(body.creditCardFees).toEqual([
      { brand: "VISA", amount: { amount: "1.20", currency: "EUR" }, offerId },
    ]);
    const row = await storedPricedOffer(body.id);
    expect(row.include_credit_card_fees).toBe(true);
    expect(row.amadeus_request).toMatchObject({
      data: { payments: [{ brand: "VISA", binNumber: 411111, flightOfferIds: ["2"] }] },
    });
    const stored = JSON.stringify(row.amadeus_request);
    expect(stored).not.toContain(PASSPORT_NUMBER);
    expect(stored).toContain(PASSPORT_NUMBER.slice(-4));
    const logged = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .selectFrom("supplier_requests")
        .select("request_body")
        .where("amadeus_operation_id", "=", "quoteAirOffers")
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow(),
    );
    expect(JSON.stringify(logged.request_body)).not.toContain(PASSPORT_NUMBER);
  });

  it("answers a retry with the same Idempotency-Key from the stored answer, without pricing again", async () => {
    const { offerId } = await offerToPrice();
    const key = idempotencyKey();
    const first = await price(alphaSk, { offerIds: [offerId] }, {}, key);
    expect(first.status).toBe(201);
    stub.clearRequests();

    const again = await price(alphaSk, { offerIds: [offerId] }, {}, key);

    expect(again.status).toBe(201);
    expect((again.body as PricedOfferBody).id).toBe((first.body as PricedOfferBody).id);
    expect(pricingCalls()).toEqual([]);
  });

  it("answers 409 SOLD_OUT when Amadeus cannot sell the segments, and stores nothing", async () => {
    const { offerId } = await offerToPrice();
    stub.clearRequests();

    const res = await price(alphaSk, { offerIds: [offerId] }, stubScenario("sold-out"));

    expect(res.status).toBe(409);
    expectResponseToMatch("priceFlightOffers", res);
    expect(res.body).toMatchObject({ error: { code: "SOLD_OUT" } });
    expect(pricingCalls()).toHaveLength(1);
    const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.selectFrom("priced_offers").select("id").where("offer_id", "=", offerId).execute(),
    );
    expect(rows).toEqual([]);
  });

  it("refuses offers of two searches with 422 OFFER_COMBINATION_INVALID, without calling Amadeus", async () => {
    const first = await offerToPrice();
    const second = await offerToPrice();
    stub.clearRequests();

    const res = await price(alphaSk, { offerIds: [first.offerId, second.offerId] });

    expect(res.status).toBe(422);
    expectResponseToMatch("priceFlightOffers", res);
    expect(res.body).toMatchObject({
      error: {
        code: "OFFER_COMBINATION_INVALID",
        details: { offerIds: [first.offerId, second.offerId], reason: "different_search" },
      },
    });
    expect(pricingCalls()).toEqual([]);
  });

  it("refuses requests it cannot send: raw offers, extras, cards and travellers of other offers", async () => {
    const { offerId, others } = await offerToPrice();
    const { payload } = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.selectFrom("flight_offers").select("payload").where("id", "=", offerId).executeTakeFirstOrThrow(),
    );
    stub.clearRequests();

    const raw = await price(alphaSk, { amadeusFlightOffers: [payload] });
    expect(raw.status).toBe(403);
    expectResponseToMatch("priceFlightOffers", raw);
    expect(raw.body).toMatchObject({ error: { code: "SCOPE_NOT_ALLOWED" } });
    const consoleRaw = await price(alphaConsole, { amadeusFlightOffers: [payload] }, CONSOLE);
    expect(consoleRaw.status).toBe(422);
    expectResponseToMatch("priceFlightOffers", consoleRaw);
    expect(consoleRaw.body).toMatchObject({
      error: { code: "UNPROCESSABLE", details: { reason: "raw_offers_not_supported" } },
    });
    const extras = await price(alphaSk, {
      offerIds: [offerId],
      additionalServices: [{ type: "CHECKED_BAGS", travelerId: "1", quantity: 1 }],
    });
    expect(extras.status).toBe(422);
    expectResponseToMatch("priceFlightOffers", extras);
    expect(extras.body).toMatchObject({
      error: { code: "UNPROCESSABLE", details: { reason: "additional_services_not_supported" } },
    });
    const card = await price(alphaSk, {
      offerIds: [offerId],
      payments: [{ brand: "VISA", offerIds: [others.get("3")] }],
    });
    expect(card.status).toBe(400);
    expectResponseToMatch("priceFlightOffers", card);
    expect(card.body).toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: [{ path: "/payments/0/offerIds/0" }] },
    });
    const traveler = await price(alphaSk, { offerIds: [offerId], travelers: [{ ...TRAVELER, id: "7" }] });
    expect(traveler.status).toBe(400);
    expectResponseToMatch("priceFlightOffers", traveler);
    expect(traveler.body).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: [{ path: "/travelers/0/id", code: "unknown_traveler" }],
      },
    });
    const none = await price(alphaSk, {});
    expect(none.status).toBe(400);
    expectResponseToMatch("priceFlightOffers", none);
    expect(pricingCalls()).toEqual([]);
  });

  it("answers 410 OFFER_EXPIRED for an expired offer and 404 for another tenant's offer, without calling Amadeus", async () => {
    const { offerId } = await offerToPrice();
    stub.clearRequests();

    const other = await price(betaSk, { offerIds: [offerId] });
    expect(other.status).toBe(404);
    expectResponseToMatch("priceFlightOffers", other);
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .updateTable("flight_offers")
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where("id", "=", offerId)
        .execute(),
    );
    const expired = await price(alphaSk, { offerIds: [offerId] });
    expect(expired.status).toBe(410);
    expectResponseToMatch("priceFlightOffers", expired);
    expect(expired.body).toMatchObject({ error: { code: "OFFER_EXPIRED" } });
    expect(pricingCalls()).toEqual([]);
  });

  it("runs from the hosted storefront with the CSRF header and answers selling amounts only [OBE-023 AC2]", async () => {
    const { offerId } = await offerToPrice();

    const res = await request(api.server)
      .post("/v1/priced-offers")
      .set({ ...edgeWriteHeaders(ALPHA_HOST), "Idempotency-Key": idempotencyKey() })
      .send({ offerIds: [offerId] });

    expect(res.status).toBe(201);
    expectResponseToMatch("priceFlightOffers", res);
    expect(netKeys(res.body)).toEqual([]);
    expect(strings(res.body)).not.toContain(NET);
  });
});

describe("flights.getPricedOffer", () => {
  it("reads the priced offer exactly as flights.price answered it, without calling Amadeus", async () => {
    const { offerId } = await offerToPrice();
    const priced = await price(alphaSk, { offerIds: [offerId] });
    expect(priced.status).toBe(201);
    stub.clearRequests();

    const res = await read(alphaSk, `/v1/priced-offers/${(priced.body as PricedOfferBody).id}`);

    expect(res.status).toBe(200);
    expectResponseToMatch("getPricedOffer", res);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual(priced.body);
    // Customer scope: no net field and no net amount in the stored priced offer either.
    expect(netKeys(res.body)).toEqual([]);
    expect(strings(res.body)).not.toContain(NET);
    expect(stub.requests()).toEqual([]);
  });

  it("answers 410 OFFER_EXPIRED on every read of an expired priced offer [OBE-023 AC2]", async () => {
    const { offerId } = await offerToPrice();
    const priced = await price(alphaSk, { offerIds: [offerId], include: [] });
    const id = (priced.body as PricedOfferBody).id;
    await expire(id);
    stub.clearRequests();

    for (const [operationId, path] of [
      ["getPricedOffer", `/v1/priced-offers/${id}`],
      ["getPricedOfferAncillaries", `/v1/priced-offers/${id}/ancillaries`],
      ["getPricedOfferFareRules", `/v1/priced-offers/${id}/fare-rules`],
    ] as const) {
      const res = await read(alphaSk, path);
      expect([operationId, res.status]).toEqual([operationId, 410]);
      expectResponseToMatch(operationId, res);
      expect(res.body).toMatchObject({ error: { code: "OFFER_EXPIRED" } });
    }
    expect(stub.requests()).toEqual([]);
  });

  it("answers 404 to tenant B for tenant A's priced offer, and for an unknown id", async () => {
    const { offerId } = await offerToPrice();
    const priced = await price(alphaSk, { offerIds: [offerId] });
    const id = (priced.body as PricedOfferBody).id;

    for (const [operationId, path] of [
      ["getPricedOffer", `/v1/priced-offers/${id}`],
      ["getPricedOfferAncillaries", `/v1/priced-offers/${id}/ancillaries`],
      ["getPricedOfferFareRules", `/v1/priced-offers/${id}/fare-rules`],
    ] as const) {
      const res = await read(betaSk, path);
      expect([operationId, res.status]).toEqual([operationId, 404]);
      expectResponseToMatch(operationId, res);
    }
    const unknown = await read(alphaSk, `/v1/priced-offers/${newId("prc")}`);
    expect(unknown.status).toBe(404);
    expectResponseToMatch("getPricedOffer", unknown);
  });

  it("keeps a priced offer of a signed-in customer to that customer and console scope", async () => {
    const customerId = newId("cus");
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .insertInto("customers")
        .values({ id: customerId, email: `${customerId}@example.com` })
        .execute(),
    );
    const token = await tokens.signCustomerToken({ sub: customerId, tid: alphaId, sid: newId("ses") });
    const bearer = { Authorization: `Bearer ${token.token}` };
    const { offerId } = await offerToPrice(alphaSk, bearer);
    const priced = await price(alphaSk, { offerIds: [offerId] }, bearer);
    expect(priced.status).toBe(201);
    expectResponseToMatch("priceFlightOffers", priced);
    const id = (priced.body as PricedOfferBody).id;
    expect(priced.body).toMatchObject({ customerId });

    const plain = await read(alphaSk, `/v1/priced-offers/${id}`);
    expect(plain.status).toBe(404);
    expectResponseToMatch("getPricedOffer", plain);
    const own = await read(alphaSk, `/v1/priced-offers/${id}`, bearer);
    expect(own.status).toBe(200);
    expectResponseToMatch("getPricedOffer", own);
    const consoleRead = await read(alphaConsole, `/v1/priced-offers/${id}`, CONSOLE);
    expect(consoleRead.status).toBe(200);
    expectResponseToMatch("getPricedOffer", consoleRead);
    expect(consoleRead.body).toMatchObject({ id, customerId, netPrice: { amount: NET } });
  });
});

describe("flights.getAncillaries", () => {
  it("answers the catalogue of the pricing answer with selling prices, without calling Amadeus [OBE-023 AC2]", async () => {
    const { offerId } = await offerToPrice();
    const priced = await price(alphaSk, { offerIds: [offerId] });
    const pricedBody = priced.body as PricedOfferBody;
    stub.clearRequests();

    const res = await read(alphaSk, `/v1/priced-offers/${pricedBody.id}/ancillaries`);

    expect(res.status).toBe(200);
    expectResponseToMatch("getPricedOfferAncillaries", res);
    expect(res.headers["cache-control"]).toBe("no-store");
    const catalogue = res.body as CatalogueBody;
    // The same options and ids as the catalogue embedded in the priced offer.
    expect(catalogue).toEqual(pricedBody.ancillaryCatalogue);
    expect(catalogue.checkedBags.map((option) => [option.type, option.label, option.price?.amount])).toEqual([
      ["CHECKED_BAGS", "1 extra checked bag (23 kg) – MAD–ORY", "30.00"],
      ["CHECKED_BAGS", "2 extra checked bags (23 kg) – MAD–ORY", "65.00"],
    ]);
    for (const option of [...catalogue.checkedBags, ...catalogue.otherServices]) {
      expect(option.id).toMatch(/^anc_/);
      expect(option.amadeus.flightOfferId).toBe("2");
    }
    expect(netKeys(res.body)).toEqual([]);
    expect(stub.requests()).toEqual([]);
  });

  it("loads the catalogue once when the pricing did not include it, then answers the stored one", async () => {
    const { offerId } = await offerToPrice();
    const priced = await price(alphaSk, { offerIds: [offerId], include: ["detailed-fare-rules"] });
    const pricedBody = priced.body as PricedOfferBody;
    expect(pricedBody.ancillaryCatalogue).toBeNull();
    expect(pricedBody.ancillaries.loaded).toBe(false);
    stub.clearRequests();

    const first = await read(alphaSk, `/v1/priced-offers/${pricedBody.id}/ancillaries`);

    expect(first.status).toBe(200);
    expectResponseToMatch("getPricedOfferAncillaries", first);
    const calls = pricingCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toMatchObject({ include: "bags,other-services" });
    const catalogue = first.body as CatalogueBody;
    expect(catalogue.checkedBags).toHaveLength(2);
    expect(catalogue.otherServices).toHaveLength(1);
    stub.clearRequests();

    const again = await read(alphaSk, `/v1/priced-offers/${pricedBody.id}/ancillaries`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(stub.requests()).toEqual([]);
    const calls2 = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .selectFrom("supplier_requests")
        .select("operation")
        .where("operation", "=", "flights.getAncillaries")
        .where("search_id", "=", pricedBody.searchId)
        .execute(),
    );
    expect(calls2).toHaveLength(1);
  });

  it("keeps the option ids of the embedded catalogue when it loads the services the pricing left out", async () => {
    const { offerId } = await offerToPrice();
    const priced = await price(alphaSk, { offerIds: [offerId], include: ["bags"] });
    const pricedBody = priced.body as PricedOfferBody;
    const embedded = pricedBody.ancillaryCatalogue;
    expect(embedded?.checkedBags).toHaveLength(2);
    expect(embedded?.otherServices).toEqual([]);
    stub.clearRequests();

    const res = await read(alphaSk, `/v1/priced-offers/${pricedBody.id}/ancillaries`);

    expect(res.status).toBe(200);
    expectResponseToMatch("getPricedOfferAncillaries", res);
    expect(pricingCalls()).toHaveLength(1);
    const catalogue = res.body as CatalogueBody;
    expect(catalogue.checkedBags.map((option) => option.id)).toEqual(
      embedded?.checkedBags.map((option) => option.id),
    );
    expect(catalogue.otherServices.map((option) => option.name)).toEqual(["PRIORITY_BOARDING"]);
  });

  it("answers two first loads at once with the same option ids: the first stored load wins", async () => {
    const { offerId } = await offerToPrice();
    const priced = await price(alphaSk, { offerIds: [offerId], include: [] });
    const id = (priced.body as PricedOfferBody).id;

    const [first, second] = await Promise.all([
      read(alphaSk, `/v1/priced-offers/${id}/ancillaries`),
      read(alphaSk, `/v1/priced-offers/${id}/ancillaries`),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expectResponseToMatch("getPricedOfferAncillaries", first);
    expect(second.body).toEqual(first.body);
    const stored = await storedPricedOffer(id);
    const load = (
      stored.response as { velexis: { loads: { ancillaries: { optionIds: Record<string, string> } } } }
    ).velexis.loads.ancillaries;
    expect((first.body as CatalogueBody).checkedBags.map((option) => option.id)).toEqual([
      load.optionIds["bags:1"],
      load.optionIds["bags:2"],
    ]);
  });

  it("answers 403 FEATURE_DISABLED in customer scope when the storefront turned ancillaries off", async () => {
    const { offerId } = await offerToPrice();
    const priced = await price(alphaSk, { offerIds: [offerId] });
    const id = (priced.body as PricedOfferBody).id;
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .updateTable("storefront_settings")
        .set({ features: JSON.stringify({ ancillaries: false }) })
        .execute(),
    );
    try {
      const res = await read(alphaSk, `/v1/priced-offers/${id}/ancillaries`);
      expect(res.status).toBe(403);
      expectResponseToMatch("getPricedOfferAncillaries", res);
      expect(res.body).toMatchObject({
        error: { code: "FEATURE_DISABLED", details: { feature: "ancillaries" } },
      });
      const consoleRead = await read(alphaConsole, `/v1/priced-offers/${id}/ancillaries`, CONSOLE);
      expect(consoleRead.status).toBe(200);
      expectResponseToMatch("getPricedOfferAncillaries", consoleRead);
    } finally {
      await tenantTx(tenantDb, "tenant_alpha", (trx) =>
        trx
          .updateTable("storefront_settings")
          .set({ features: JSON.stringify({}) })
          .execute(),
      );
    }
  });
});

describe("flights.getFareRules", () => {
  it("answers the fare rules of the pricing answer without calling Amadeus", async () => {
    const { offerId } = await offerToPrice();
    const priced = await price(alphaSk, { offerIds: [offerId] });
    const pricedBody = priced.body as PricedOfferBody;
    stub.clearRequests();

    const res = await read(alphaSk, `/v1/priced-offers/${pricedBody.id}/fare-rules`);

    expect(res.status).toBe(200);
    expectResponseToMatch("getPricedOfferFareRules", res);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual(pricedBody.fareRules);
    const rules = res.body as FareRulesBody;
    expect(rules.fareComponents).toEqual([
      expect.objectContaining({ fareBasis: "ADNNALB4", segmentId: "3" }),
    ]);
    expect(stub.requests()).toEqual([]);
  });

  it("loads the fare rules once when the pricing did not ask for them, then answers the stored ones", async () => {
    const { offerId } = await offerToPrice();
    const priced = await price(alphaSk, { offerIds: [offerId], include: [], fareRules: false });
    const pricedBody = priced.body as PricedOfferBody;
    expect(pricedBody.fareRules).toBeNull();
    stub.clearRequests();

    const first = await read(alphaSk, `/v1/priced-offers/${pricedBody.id}/fare-rules`);

    expect(first.status).toBe(200);
    expectResponseToMatch("getPricedOfferFareRules", first);
    const calls = pricingCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toMatchObject({ include: "detailed-fare-rules" });
    expect(first.body).toMatchObject({
      pricedOfferId: pricedBody.id,
      available: true,
      summary: { refundable: false, changeable: true },
    });
    stub.clearRequests();

    const again = await read(alphaSk, `/v1/priced-offers/${pricedBody.id}/fare-rules`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(stub.requests()).toEqual([]);
  });
});
