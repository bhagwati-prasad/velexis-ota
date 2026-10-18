// flights.search, flights.getSearch and flights.listResults against PostgreSQL 16, Redis 7 and the Amadeus stub
// (OBE-021; ota/docs/flows/search-and-price.md §2–§4, §6, OADR-0002, OADR-0005). The file clones the @velexis/testing
// template (tenant_alpha and tenant_beta provisioned), writes the platform rows of two tenants on the Velexis test
// Amadeus account as the platform does (tenants, their connections with an office each, API keys), seeds their
// settings and default markup rule as provisioning does, gives alpha a 10 % markup rule, and calls the API in-process
// with secret keys, a console:automation key and the hosted storefront's edge headers. The stub answers its five-offer
// Madrid–Paris fixture (net 92.15, 98.47, 109.32, 131.86 and 558.94 EUR) for every search, and none for `ZZZ`.
//
// Every answer is checked against the OTA document (`expectResponseToMatch`).
import { randomBytes } from "node:crypto";
import { encryptValue, hashApiKey, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
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
import { newId } from "../../../src/common/ids";
import { Money } from "../../../src/pricing/pricing.types";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeWriteHeaders, newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const ALPHA_HOST = "alpha.ota.example.com";

/** The net grand totals of the stub's search fixture, by Amadeus offer id. */
const NET = Object.freeze({ "1": "92.15", "2": "98.47", "3": "109.32", "4": "131.86", "5": "558.94" });
/** Alpha's markup: 10 % of the net total, rounded half-up to cents. */
const sellingOf = (net: string): string => new Money(net).times("1.1").toFixed(2);

/** A one-way SIMPLE search Madrid → Paris Orly for one adult. */
const SIMPLE = Object.freeze({
  mode: "simple",
  originLocationCode: "MAD",
  destinationLocationCode: "ORY",
  departureDate: "2027-01-15",
  adults: 1,
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
let alphaSk: string;
let alphaConsole: string;
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

const search = (key: string, body: unknown, headers: Readonly<Record<string, string>> = {}) =>
  request(api.server)
    .post("/v1/flight-searches")
    .set({ "X-Api-Key": key, "Idempotency-Key": randomBytes(16).toString("hex"), ...headers })
    .send(body as object);

const getSearch = (key: string, id: string, headers: Readonly<Record<string, string>> = {}) =>
  request(api.server)
    .get(`/v1/flight-searches/${id}`)
    .set({ "X-Api-Key": key, ...headers });

const listResults = (key: string, id: string, query = "", headers: Readonly<Record<string, string>> = {}) =>
  request(api.server)
    .get(`/v1/flight-searches/${id}/offers${query}`)
    .set({ "X-Api-Key": key, ...headers });

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

interface OfferBody {
  readonly id: string;
  readonly price: { readonly total: { readonly amount: string } };
  readonly summary: {
    readonly maxStops: number;
    readonly marketingCarriers: string[];
    readonly departureAt: string;
    readonly totalDurationMinutes: number;
  };
  readonly amadeus?: {
    readonly id: string;
    readonly price: { readonly grandTotal: string; readonly total: string; readonly base: string };
  };
  readonly netPrice?: { readonly amount: string };
  readonly markup?: { readonly amount: { readonly amount: string } };
}

const offersOf = (body: unknown): OfferBody[] => (body as { offers: OfferBody[] }).offers;
const dataOf = (body: unknown): OfferBody[] => (body as { data: OfferBody[] }).data;
const getFlightOffersCalls = () =>
  stub.requests().filter((entry) => entry.operation === "getFlightOffers" && entry.status !== undefined);

/** A completed search of alpha with a secret key; its id. */
async function alphaSearch(body: unknown = SIMPLE): Promise<string> {
  const res = await search(alphaSk, body);
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

// Cloning the template, starting the stub and building the API's module graph (Nest, pools, Redis, the OTA document's
// validators) take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its
// own timeout, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of the three operations (the FlightSearch and FlightOffer schemas are large) compile on
  // their first check: here, with every status the tests below check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["createFlightSearch", [201, 400, 403, 500, 502]],
    ["getFlightSearch", [200, 404]],
    ["listFlightSearchResults", [200, 400, 404, 409, 410]],
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
  alphaConsole = await issueKey(alphaId, ["console:automation", "queues:read"]);
  betaSk = await issueKey(betaId);
  await seedTenant("tenant_alpha", "Alpha Travel");
  await seedTenant("tenant_beta", "Beta Trips");
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
  });
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
  // Full Amadeus buckets, no single-flight keys and no cached rows from the previous test.
  await redis.client.flushdb();
  stub.clearRequests();
});

describe("flights.search", () => {
  it("searches in SIMPLE mode and answers selling prices only in customer scope [OBE-021 AC1] [OF-02 AC1]", async () => {
    const res = await search(alphaSk, {
      ...SIMPLE,
      resultOptions: { limit: 5, sort: "price", view: "full" },
    });

    expect(res.status).toBe(201);
    expectResponseToMatch("createFlightSearch", res);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as {
      id: string;
      status: string;
      resultCount: number;
      currency: string;
      location: unknown;
      criteria: { amadeusQuery: Record<string, string> };
    };
    expect(res.headers["location"]).toBe(`/v1/flight-searches/${body.id}`);
    expect(body).toMatchObject({ status: "completed", resultCount: 5, currency: "EUR" });
    expect(body.criteria.amadeusQuery).toEqual({
      originLocationCode: "MAD",
      destinationLocationCode: "ORY",
      departureDate: "2027-01-15",
      adults: "1",
      currencyCode: "EUR",
      max: "250",
    });
    // One Amadeus call, the GET of SIMPLE mode, with the default currency and the storefront's limit.
    const calls = getFlightOffersCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toMatchObject({ currencyCode: "EUR", max: "250", originLocationCode: "MAD" });

    // Sorted by price, every total is net + 10 %, inside `amadeus` too.
    const offers = offersOf(res.body);
    const expected = Object.entries(NET)
      .map(([id, net]) => ({ id, selling: sellingOf(net) }))
      .sort((a, b) => new Money(a.selling).comparedTo(b.selling));
    expect(offers.map((offer) => offer.price.total.amount)).toEqual(expected.map((entry) => entry.selling));
    for (const offer of offers) {
      expect(offer.amadeus?.price.grandTotal).toBe(offer.price.total.amount);
      expect(offer.amadeus?.price.total).toBe(offer.price.total.amount);
      expect(offer).not.toHaveProperty("markup");
    }
    // A JSON walk finds no net field, and no net total appears anywhere in the answer.
    expect(netKeys(res.body)).toEqual([]);
    const values = strings(res.body);
    for (const net of Object.values(NET)) {
      expect(values).not.toContain(net);
    }
  });

  it("stores the search, its offers with net, markup and selling totals, and links the supplier call", async () => {
    const id = await alphaSearch();

    const stored = await tenantTx(tenantDb, "tenant_alpha", async (trx) => ({
      search: await trx
        .selectFrom("flight_searches")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
      offers: await trx
        .selectFrom("flight_offers")
        .select([
          "amadeus_offer_id",
          "net_total",
          "markup_amount",
          "selling_total",
          "max_stops",
          "main_cabin",
        ])
        .where("search_id", "=", id)
        .orderBy("amadeus_offer_id")
        .execute(),
      calls: await trx
        .selectFrom("supplier_requests")
        .select(["search_id"])
        .where("search_id", "=", id)
        .execute(),
    }));
    expect(stored.search).toMatchObject({
      status: "completed",
      result_count: 5,
      mode: "simple",
      channel: "storefront",
    });
    expect(
      stored.offers.map((offer) => [offer.amadeus_offer_id, offer.net_total, offer.selling_total]),
    ).toEqual(Object.entries(NET).map(([offerId, net]) => [offerId, net, sellingOf(net)]));
    for (const offer of stored.offers) {
      expect(new Money(offer.net_total).plus(offer.markup_amount).toFixed(2)).toBe(offer.selling_total);
    }
    expect(stored.offers.map((offer) => offer.max_stops)).toEqual([1, 0, 0, 0, 0]);
    expect(stored.offers.map((offer) => offer.main_cabin)).toEqual([
      "ECONOMY",
      "ECONOMY",
      "ECONOMY",
      "ECONOMY",
      "BUSINESS",
    ]);
    expect(stored.calls).toEqual([{ search_id: id }]);
    // Tenant isolation: beta's schema has neither the search nor its offers.
    const beta = await tenantTx(tenantDb, "tenant_beta", (trx) =>
      trx.selectFrom("flight_searches").select("id").where("id", "=", id).execute(),
    );
    expect(beta).toEqual([]);
  });

  it("searches in ADVANCED mode with the POST body and the defaults filled in", async () => {
    const res = await search(alphaSk, {
      mode: "advanced",
      query: {
        originDestinations: [
          {
            id: "1",
            originLocationCode: "MAD",
            destinationLocationCode: "PAR",
            departureDateTimeRange: { date: "2027-01-15" },
          },
        ],
        travelers: [{ id: "1", travelerType: "ADULT" }],
        sources: ["GDS"],
      },
      resultOptions: { limit: 2 },
    });

    expect(res.status).toBe(201);
    expectResponseToMatch("createFlightSearch", res);
    const body = res.body as {
      criteria: { amadeusOperationId: string; amadeusBody: Record<string, unknown> };
      page: { nextCursor: string | null; limit: number };
    };
    expect(body.criteria.amadeusOperationId).toBe("searchFlightOffers");
    expect(body.criteria.amadeusBody).toMatchObject({
      currencyCode: "EUR",
      searchCriteria: {
        maxFlightOffers: 250,
        additionalInformation: { brandedFares: true, chargeableCheckedBags: true, fareRules: true },
      },
    });
    expect(offersOf(res.body)).toHaveLength(2);
    expect(body.page).toMatchObject({ limit: 2, nextCursor: expect.any(String) });
    expect(stub.requests().filter((entry) => entry.operation === "searchFlightOffers")).toHaveLength(1);
  });

  it("answers 201 with zero offers for the destination ZZZ [OBE-021 AC2]", async () => {
    const res = await search(alphaSk, { ...SIMPLE, destinationLocationCode: "ZZZ" });

    expect(res.status).toBe(201);
    expectResponseToMatch("createFlightSearch", res);
    expect(res.body).toMatchObject({
      status: "completed",
      resultCount: 0,
      offers: [],
      highlights: { cheapest: null, fastest: null, best: null },
      facets: { total: 0 },
    });
  });

  it("makes one stub call for two identical concurrent searches [OBE-021 AC3]", async () => {
    const [first, second] = await Promise.all([search(alphaSk, SIMPLE), search(alphaSk, SIMPLE)]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expectResponseToMatch("createFlightSearch", first);
    expectResponseToMatch("createFlightSearch", second);
    const id = (first.body as { id: string }).id;
    expect((second.body as { id: string }).id).toBe(id);
    expect(getFlightOffersCalls()).toHaveLength(1);
    // The single-flight key of the tenant, the environment and the criteria holds the search id, for 30 s at most.
    const keys = await redis.client.keys("t:*:test:search:*");
    expect(keys).toEqual([expect.stringMatching(/^t:ten_[0-9A-Za-z]+:test:search:[0-9a-f]{64}$/)]);
    expect(await redis.client.get(keys[0] ?? "")).toBe(id);
    const ttl = await redis.client.ttl(keys[0] ?? "");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
    // A different search is not joined.
    await search(alphaSk, { ...SIMPLE, adults: 2 });
    expect(getFlightOffersCalls()).toHaveLength(2);
  });

  it("answers 403 FEATURE_DISABLED for an asynchronous search without calling Amadeus", async () => {
    const res = await search(alphaSk, { ...SIMPLE, resultOptions: { async: true } });

    expect(res.status).toBe(403);
    expectResponseToMatch("createFlightSearch", res);
    expect(res.body).toMatchObject({
      error: { code: "FEATURE_DISABLED", details: { feature: "asyncSearch" } },
    });
    expect(stub.requests()).toEqual([]);
  });

  it("refuses included and excluded airlines together with 400 VALIDATION_FAILED", async () => {
    const res = await search(alphaSk, {
      ...SIMPLE,
      includedAirlineCodes: ["AF"],
      excludedAirlineCodes: ["IB"],
    });

    expect(res.status).toBe(400);
    expectResponseToMatch("createFlightSearch", res);
    expect(res.body).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: [{ path: "/excludedAirlineCodes", code: "conflict" }],
      },
    });
    expect(stub.requests()).toEqual([]);
  });

  it("marks the search failed when Amadeus answers 5xx, and answers the supplier error", async () => {
    const res = await search(alphaSk, SIMPLE, stubScenario("server-error"));

    expect(res.status).toBe(502);
    expectResponseToMatch("createFlightSearch", res);
    expect(res.body).toMatchObject({ error: { code: "SUPPLIER_ERROR" } });
    const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .selectFrom("flight_searches")
        .select(["id", "status", "error_code", "result_count"])
        .where("status", "=", "failed")
        .execute(),
    );
    expect(rows).toEqual([
      expect.objectContaining({ status: "failed", error_code: "SUPPLIER_ERROR", result_count: 0 }),
    ]);
    const failed = rows[0]?.id ?? "";
    const read = await getSearch(alphaSk, failed);
    expect(read.status).toBe(200);
    expectResponseToMatch("getFlightSearch", read);
    expect(read.body).toMatchObject({ status: "failed", error: { code: "SUPPLIER_ERROR" }, resultCount: 0 });
    const list = await listResults(alphaSk, failed);
    expect(list.status).toBe(409);
    expectResponseToMatch("listFlightSearchResults", list);
    expect(list.body).toMatchObject({
      error: { code: "SEARCH_NOT_COMPLETED", details: { status: "failed", errorCode: "SUPPLIER_ERROR" } },
    });
  });

  it("refuses an ADVANCED search for more than 9 travellers over two years old with 400 VALIDATION_FAILED", async () => {
    const res = await search(alphaSk, {
      mode: "advanced",
      query: {
        originDestinations: [
          {
            id: "1",
            originLocationCode: "MAD",
            destinationLocationCode: "PAR",
            departureDateTimeRange: { date: "2027-01-15" },
          },
        ],
        travelers: Array.from({ length: 10 }, (_unused, index) => ({
          id: String(index + 1),
          travelerType: "ADULT",
        })),
        sources: ["GDS"],
      },
    });

    expect(res.status).toBe(400);
    expectResponseToMatch("createFlightSearch", res);
    expect(res.body).toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: [{ path: "/query/travelers", code: "range" }] },
    });
    expect(stub.requests()).toEqual([]);
  });

  it("marks the search failed, never left pending, when its offers cannot be stored", async () => {
    // A fixed markup no `numeric(12,2)` selling total can hold: the insert of the offers fails.
    const ruleId = newId("mkr");
    await tenantTx(tenantDb, "tenant_beta", (trx) =>
      trx
        .insertInto("markup_rules")
        .values({
          id: ruleId,
          name: "Overflow",
          scope: JSON.stringify({}),
          calculation: "fixed",
          fixed_amount: "9999999999.99",
          fixed_currency: "EUR",
          applies_per: "booking",
          priority: 1,
          stackable: false,
          is_default: false,
          is_active: true,
        })
        .execute(),
    );
    try {
      const res = await search(betaSk, SIMPLE);

      expect(res.status).toBe(500);
      expectResponseToMatch("createFlightSearch", res);
      expect(res.body).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
      const rows = await tenantTx(tenantDb, "tenant_beta", (trx) =>
        trx.selectFrom("flight_searches").select(["status", "error_code", "result_count"]).execute(),
      );
      expect(rows).toEqual([{ status: "failed", error_code: "INTERNAL_ERROR", result_count: 0 }]);
    } finally {
      await tenantTx(tenantDb, "tenant_beta", async (trx) => {
        await trx.deleteFrom("flight_searches").execute();
        await trx.deleteFrom("markup_rules").where("id", "=", ruleId).execute();
      });
    }
  });

  it("runs from the hosted storefront with the CSRF header", async () => {
    const res = await request(api.server)
      .post("/v1/flight-searches")
      .set({ ...edgeWriteHeaders(ALPHA_HOST), "Idempotency-Key": randomBytes(16).toString("hex") })
      .send(SIMPLE);

    expect(res.status).toBe(201);
    expectResponseToMatch("createFlightSearch", res);
    expect(netKeys(res.body)).toEqual([]);
  });

  it("gives console scope the verbatim Amadeus offer, the net price and the markup", async () => {
    const res = await search(
      alphaConsole,
      { ...SIMPLE, resultOptions: { limit: 5, sort: "price", view: "full" } },
      {
        "X-Velexis-Scope": "console",
      },
    );

    expect(res.status).toBe(201);
    expectResponseToMatch("createFlightSearch", res);
    const [cheapest] = offersOf(res.body);
    expect(cheapest?.netPrice).toEqual({ amount: "92.15", currency: "EUR" });
    expect(cheapest?.markup?.amount).toEqual({ amount: "9.22", currency: "EUR" });
    expect(cheapest?.amadeus?.price.grandTotal).toBe("92.15");
    expect(cheapest?.price.total.amount).toBe(sellingOf("92.15"));
    expect(res.body).toHaveProperty("diagnostics.amadeusOperationId", "getFlightOffers");
  });
});

describe("flights.getSearch", () => {
  it("returns the search without offers, and 404 to another tenant's key", async () => {
    const id = await alphaSearch();

    const res = await getSearch(alphaSk, id);
    expect(res.status).toBe(200);
    expectResponseToMatch("getFlightSearch", res);
    expect(res.body).toMatchObject({
      id,
      status: "completed",
      resultCount: 5,
      summary: { tripType: "one_way", travelers: { adults: 1, total: 1 } },
    });
    expect(res.body).not.toHaveProperty("offers");
    expect(netKeys(res.body)).toEqual([]);
    expect(res.body).toHaveProperty("dictionaries.locations.ORY.countryName", "France");

    // The dictionaries' country and currency names follow Accept-Language, as in the reference operations.
    const german = await getSearch(alphaSk, id, { "Accept-Language": "de-DE,de;q=0.9" });
    expect(german.status).toBe(200);
    expectResponseToMatch("getFlightSearch", german);
    expect(german.body).toHaveProperty("dictionaries.locations.ORY.countryName", "Frankreich");
    const results = await listResults(alphaSk, id, "?limit=1", { "Accept-Language": "de" });
    expectResponseToMatch("listFlightSearchResults", results);
    expect(results.body).toHaveProperty("dictionaries.locations.ORY.countryName", "Frankreich");

    const other = await getSearch(betaSk, id);
    expect(other.status).toBe(404);
    expectResponseToMatch("getFlightSearch", other);
  });
});

describe("flights.listResults", () => {
  it("filters, sorts and pages in SQL with selling prices only [OBE-021 AC1] [OF-02 AC1]", async () => {
    const id = await alphaSearch();
    const totals = (body: unknown) => dataOf(body).map((offer) => offer.price.total.amount);

    const byPrice = await listResults(alphaSk, id, "?sort=-price&view=full");
    expect(byPrice.status).toBe(200);
    expectResponseToMatch("listFlightSearchResults", byPrice);
    expect(totals(byPrice.body)).toEqual(
      Object.values(NET)
        .map(sellingOf)
        .sort((a, b) => new Money(b).comparedTo(a)),
    );
    // The full view carries `amadeus`, rewritten to selling amounts: no net field and no net total anywhere.
    for (const offer of dataOf(byPrice.body)) {
      expect(offer.amadeus?.price.grandTotal).toBe(offer.price.total.amount);
    }
    expect(netKeys(byPrice.body)).toEqual([]);
    const values = strings(byPrice.body);
    for (const net of Object.values(NET)) {
      expect(values).not.toContain(net);
    }

    const nonStop = await listResults(alphaSk, id, "?stops=0&sort=price");
    expectResponseToMatch("listFlightSearchResults", nonStop);
    expect(dataOf(nonStop.body).every((offer) => offer.summary.maxStops === 0)).toBe(true);
    expect(nonStop.body).toMatchObject({ total: 4 });

    const airFrance = await listResults(alphaSk, id, "?carriers=AF&sort=price");
    expectResponseToMatch("listFlightSearchResults", airFrance);
    expect(totals(airFrance.body)).toEqual([sellingOf(NET["4"]), sellingOf(NET["5"])]);
    // Disjunctive facets: the carriers group ignores the carriers filter, the others apply it.
    const facets = (airFrance.body as { facets: { carriers: Array<{ value: string; count: number }> } })
      .facets;
    expect(facets.carriers.map((bucket) => [bucket.value, bucket.count])).toEqual([
      ["AF", 2],
      ["IB", 1],
      ["TP", 1],
      ["UX", 1],
    ]);

    const morning = await listResults(
      alphaSk,
      id,
      "?departureWindow=0:06:00-11:59&cabins=ECONOMY&sort=departure",
    );
    expectResponseToMatch("listFlightSearchResults", morning);
    expect(dataOf(morning.body).map((offer) => offer.summary.departureAt)).toEqual([
      "2027-01-15T06:00:00",
      "2027-01-15T07:15:00",
      "2027-01-15T08:45:00",
    ]);

    const capped = await listResults(alphaSk, id, `?maxPrice=${sellingOf(NET["3"])}&sort=price`);
    expect(totals(capped.body)).toEqual([NET["1"], NET["2"], NET["3"]].map(sellingOf));
  });

  it("pages with a cursor that belongs to its filters and sort", async () => {
    const id = await alphaSearch();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?sort=duration&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
      const res = await listResults(alphaSk, id, query);
      expect(res.status).toBe(200);
      expectResponseToMatch("listFlightSearchResults", res);
      const body = res.body as { total: number; page: { nextCursor: string | null } };
      expect(body.total).toBe(5);
      seen.push(...dataOf(res.body).map((offer) => offer.id));
      cursor = body.page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 5);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);

    const first = await listResults(alphaSk, id, "?sort=duration&limit=2");
    const next = (first.body as { page: { nextCursor: string } }).page.nextCursor;
    const otherSort = await listResults(alphaSk, id, `?sort=price&limit=2&cursor=${next}`);
    expect(otherSort.status).toBe(400);
    expectResponseToMatch("listFlightSearchResults", otherSort);
    expect(otherSort.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("answers 400 INVALID_REQUEST, never 500, for a cursor whose sort keys were tampered with", async () => {
    const id = await alphaSearch();
    /** The cursor of the first page of `sort` with its sort keys replaced by `keys`. */
    const tampered = async (sort: string, keys: unknown[]): Promise<string> => {
      const first = await listResults(alphaSk, id, `?sort=${sort}&limit=2`);
      const cursor = (first.body as { page: { nextCursor: string } }).page.nextCursor;
      const [version, fingerprint, , offerId] = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      ) as unknown[];
      return Buffer.from(JSON.stringify([version, fingerprint, keys, offerId])).toString("base64url");
    };

    for (const [sort, keys] of [
      ["price", ["abc"]],
      ["price", []],
      ["duration", [2_147_483_648, "101.37"]],
      ["departure", ["2027-02-30T25:00:00", "101.37"]],
      ["best", ["0.1000", 7]],
    ] as const) {
      const res = await listResults(
        alphaSk,
        id,
        `?sort=${sort}&limit=2&cursor=${await tampered(sort, [...keys])}`,
      );
      expect(res.status, `${sort} ${JSON.stringify(keys)}`).toBe(400);
      expectResponseToMatch("listFlightSearchResults", res);
      expect(res.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    }
  });

  it("agrees with the facet total for every filter it pages through", async () => {
    const id = await alphaSearch();

    // The expected totals follow from the fixture (offer 1: TP via LIS 06:00–11:45, 345 min; 2: IB 07:15–09:20 BASIC;
    // 3: UX 12:30–14:35 LITE; 4: AF 08:45–10:55, 130 min, LIGHT; 5: AF business 16:50–18:55 with 2 bags), so neither
    // the SQL nor facets.ts can agree on a wrong count.
    for (const [query, expected] of [
      ["stops=0", 4],
      ["stops=1,2", 1],
      ["carriers=AF,IB", 3],
      ["cabins=BUSINESS", 1],
      ["departureWindow=0:22:00-07:00", 1],
      ["arrivalWindow=0:12:00-23:59", 2],
      ["maxDurationMinutes=130", 4],
      ["minIncludedCheckedBags=1", 1],
      ["brandedFares=BASIC,LIGHT", 2],
      [`minPrice=${sellingOf(NET["2"])}&maxPrice=${sellingOf(NET["4"])}`, 3],
    ] as const) {
      const res = await listResults(alphaSk, id, `?${query}&limit=100`);
      expect(res.status).toBe(200);
      expectResponseToMatch("listFlightSearchResults", res);
      expect((res.body as { total: number }).total, query).toBe(expected);
      expect(dataOf(res.body), query).toHaveLength(expected);
    }
  });

  it("answers 410 SEARCH_EXPIRED after expires_at, while getSearch says expired [OBE-021 AC2] [OF-02 AC2]", async () => {
    const id = await alphaSearch();
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .updateTable("flight_searches")
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where("id", "=", id)
        .execute(),
    );

    const list = await listResults(alphaSk, id);
    expect(list.status).toBe(410);
    expectResponseToMatch("listFlightSearchResults", list);
    expect(list.body).toMatchObject({ error: { code: "SEARCH_EXPIRED" } });

    const read = await getSearch(alphaSk, id);
    expect(read.status).toBe(200);
    expectResponseToMatch("getFlightSearch", read);
    expect(read.body).toMatchObject({ id, status: "expired" });
  });

  it("answers 404 for another tenant's search and an unknown id", async () => {
    const id = await alphaSearch();

    const other = await listResults(betaSk, id);
    expect(other.status).toBe(404);
    expectResponseToMatch("listFlightSearchResults", other);
    const unknown = await listResults(alphaSk, newId("srch"));
    expect(unknown.status).toBe(404);
  });
});
