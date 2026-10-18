// flights.getOffer and flights.upsell against PostgreSQL 16, Redis 7 and the Amadeus stub (OBE-022;
// ota/docs/flows/search-and-price.md §2 step 6, OADR-0002, OADR-0005). The file clones the @velexis/testing template
// (tenant_alpha and tenant_beta provisioned), writes the platform rows of two tenants on the Velexis test Amadeus
// account as the platform does (tenants, their connections with an office each, API keys), seeds their settings and
// default markup rule as provisioning does, gives alpha a 10 % markup rule, and calls the API in-process with secret
// keys, a console:automation key and the hosted storefront's edge headers.
//
// The stub answers its five-offer Madrid–Paris fixture for every search, and for every Branded Fares Upsell the three
// fare families of its offer 2 (Iberia IB3436, net 98.47 EUR): BASIC 98.47, CLASSIC 126.47 and FLEXIBLE 189.47 EUR.
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

/** The net grand totals of the stub's upsell fixture, by brand. */
const UPSELL_NET = Object.freeze({ BASIC: "98.47", CLASSIC: "126.47", FLEXIBLE: "189.47" });
/** The net grand total of the search fixture's offer 2, the offer the tests upsell. */
const BASE_NET = "98.47";
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

const idempotencyKey = (): string => randomBytes(16).toString("hex");

const search = (key: string, body: unknown = SIMPLE) =>
  request(api.server)
    .post("/v1/flight-searches")
    .set({ "X-Api-Key": key, "Idempotency-Key": idempotencyKey() })
    .send(body as object);

const getOffer = (key: string, id: string, headers: Readonly<Record<string, string>> = {}) =>
  request(api.server)
    .get(`/v1/flight-offers/${id}`)
    .set({ "X-Api-Key": key, ...headers });

const upsell = (key: string, id: string, body?: unknown, headers: Readonly<Record<string, string>> = {}) => {
  const call = request(api.server)
    .post(`/v1/flight-offers/${id}/upsells`)
    .set({ "X-Api-Key": key, "Idempotency-Key": idempotencyKey(), ...headers });
  return body === undefined ? call : call.send(body as object);
};

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
  readonly searchId: string;
  readonly origin: string;
  readonly baseOfferId: string | null;
  readonly upsellId: string | null;
  readonly expiresAt: string;
  readonly price: { readonly total: { readonly amount: string } };
  readonly summary: { readonly brandedFares: Array<{ readonly code: string }> };
  readonly travelerPricings?: unknown[];
  readonly amadeus?: { readonly id: string; readonly price: { readonly grandTotal: string } };
  readonly netPrice?: { readonly amount: string };
  readonly markup?: { readonly amount: { readonly amount: string } };
}

interface UpsellBody {
  readonly id: string;
  readonly baseOfferId: string;
  readonly offerIds: string[];
  readonly offers: OfferBody[];
  readonly cached: boolean;
  readonly expiresAt: string;
  readonly comparison: {
    readonly columns: Array<{
      readonly offerId: string;
      readonly isBaseOffer: boolean;
      readonly brandedFare: string | null;
      readonly price: { readonly amount: string };
      readonly priceDifference: { readonly amount: string };
    }>;
    readonly rows: Array<{
      readonly key: string;
      readonly values: Array<{
        readonly offerId: string;
        readonly status: string;
        readonly detail?: string | null;
      }>;
    }>;
  };
}

const upsellCalls = () =>
  stub.requests().filter((entry) => entry.operation === "upsellAirOffers" && entry.status !== undefined);

/** A completed search of alpha with a secret key: its id and its offers' ids by Amadeus offer id. */
async function alphaSearch(
  body: unknown = SIMPLE,
): Promise<{ searchId: string; offers: Map<string, string> }> {
  const res = await search(alphaSk, body);
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

/** The offer of alpha's new search that the stub's upsell fixture belongs to (Amadeus offer 2). */
async function baseOffer(): Promise<{ searchId: string; offerId: string; others: Map<string, string> }> {
  const { searchId, offers } = await alphaSearch();
  const offerId = offers.get("2");
  expect(offerId).toMatch(/^off_/);
  return { searchId, offerId: offerId ?? "", others: offers };
}

// Cloning the template, starting the stub and building the API's module graph (Nest, pools, Redis, the OTA document's
// validators) take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its
// own timeout, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations (the FlightOffer and UpsellResult schemas are large) compile on their
  // first check: here, with every status the tests below check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["createFlightSearch", [201]],
    ["getFlightOffer", [200, 404, 410]],
    ["upsellFlightOffer", [200, 400, 403, 404, 409, 410, 422]],
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

describe("flights.getOffer", () => {
  it("answers the stored offer in the full view with selling prices only in customer scope", async () => {
    const { searchId, offerId } = await baseOffer();
    stub.clearRequests();

    const res = await getOffer(alphaSk, offerId);

    expect(res.status).toBe(200);
    expectResponseToMatch("getFlightOffer", res);
    expect(res.headers["cache-control"]).toBe("no-store");
    const offer = res.body as OfferBody;
    expect(offer).toMatchObject({
      id: offerId,
      searchId,
      origin: "search",
      baseOfferId: null,
      upsellId: null,
    });
    expect(offer.price.total.amount).toBe(sellingOf(BASE_NET));
    // The full view: the Amadeus offer rewritten to selling amounts, the traveller pricings and the dictionaries.
    expect(offer.amadeus?.price.grandTotal).toBe(sellingOf(BASE_NET));
    expect(offer.travelerPricings).toHaveLength(1);
    expect(res.body).toHaveProperty("dictionaries.locations.ORY.countryName", "France");
    expect(res.body).toHaveProperty("dictionaries.carriers.IB.name");
    expect(netKeys(res.body)).toEqual([]);
    expect(strings(res.body)).not.toContain(BASE_NET);
    expect(res.body).not.toHaveProperty("markup");
    // Read from PostgreSQL only: no Amadeus call.
    expect(stub.requests()).toEqual([]);

    const german = await getOffer(alphaSk, offerId, { "Accept-Language": "de" });
    expectResponseToMatch("getFlightOffer", german);
    expect(german.body).toHaveProperty("dictionaries.locations.ORY.countryName", "Frankreich");
  });

  it("gives console scope the verbatim Amadeus offer, the net price and the markup", async () => {
    const { offerId } = await baseOffer();

    const res = await getOffer(alphaConsole, offerId, { "X-Velexis-Scope": "console" });

    expect(res.status).toBe(200);
    expectResponseToMatch("getFlightOffer", res);
    const offer = res.body as OfferBody;
    expect(offer.netPrice).toEqual({ amount: BASE_NET, currency: "EUR" });
    expect(offer.markup?.amount).toEqual({ amount: "9.85", currency: "EUR" });
    expect(offer.amadeus?.price.grandTotal).toBe(BASE_NET);
    expect(offer.price.total.amount).toBe(sellingOf(BASE_NET));
  });

  it("answers 410 OFFER_EXPIRED after expires_at", async () => {
    const { offerId } = await baseOffer();
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .updateTable("flight_offers")
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where("id", "=", offerId)
        .execute(),
    );

    const res = await getOffer(alphaSk, offerId);

    expect(res.status).toBe(410);
    expectResponseToMatch("getFlightOffer", res);
    expect(res.body).toMatchObject({ error: { code: "OFFER_EXPIRED" } });
  });

  it("answers 404 to tenant B for tenant A's offer, and for an unknown id [OBE-022 AC2]", async () => {
    const { offerId } = await baseOffer();

    const other = await getOffer(betaSk, offerId);
    expect(other.status).toBe(404);
    expectResponseToMatch("getFlightOffer", other);
    expect(other.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    const unknown = await getOffer(alphaSk, newId("off"));
    expect(unknown.status).toBe(404);
    expectResponseToMatch("getFlightOffer", unknown);
  });

  it("follows a customer-bound search: 404 to another caller of the tenant, readable in console scope", async () => {
    const { searchId, offerId } = await baseOffer();
    // The search of a signed-in customer (a customer session sets flight_searches.customer_id).
    await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
      const customerId = newId("cus");
      await trx
        .insertInto("customers")
        .values({ id: customerId, email: `${customerId}@example.com` })
        .execute();
      await trx
        .updateTable("flight_searches")
        .set({ customer_id: customerId })
        .where("id", "=", searchId)
        .execute();
    });
    stub.clearRequests();

    // A plain secret key is not that customer: the offer does not exist for it, and nothing is upsold.
    const plain = await getOffer(alphaSk, offerId);
    expect(plain.status).toBe(404);
    expectResponseToMatch("getFlightOffer", plain);
    const upsold = await upsell(alphaSk, offerId);
    expect(upsold.status).toBe(404);
    expectResponseToMatch("upsellFlightOffer", upsold);
    expect(stub.requests()).toEqual([]);
    // Console scope reads it.
    const consoleRead = await getOffer(alphaConsole, offerId, { "X-Velexis-Scope": "console" });
    expect(consoleRead.status).toBe(200);
    expectResponseToMatch("getFlightOffer", consoleRead);
    expect(consoleRead.body).toMatchObject({ id: offerId, searchId });
  });
});

describe("flights.upsell", () => {
  it("returns the brand alternatives as new off_ ids with selling prices, and stores them [OBE-022 AC1]", async () => {
    const { searchId, offerId, others } = await baseOffer();
    stub.clearRequests();

    const res = await upsell(alphaSk, offerId);

    expect(res.status).toBe(200);
    expectResponseToMatch("upsellFlightOffer", res);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as UpsellBody;
    expect(body).toMatchObject({ baseOfferId: offerId, offerIds: [offerId], cached: false });
    expect(body.id).toMatch(/^ups_/);
    // Three new offers, none of them an offer of the search, in the order of the Amadeus answer.
    const ids = body.offers.map((offer) => offer.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(/^off_/);
      expect([...others.values()]).not.toContain(id);
    }
    expect(body.offers.map((offer) => offer.summary.brandedFares[0]?.code)).toEqual([
      "BASIC",
      "CLASSIC",
      "FLEXIBLE",
    ]);
    expect(body.offers.map((offer) => offer.price.total.amount)).toEqual(
      Object.values(UPSELL_NET).map(sellingOf),
    );
    for (const offer of body.offers) {
      expect(offer).toMatchObject({ searchId, origin: "upsell", baseOfferId: offerId, upsellId: body.id });
      // The summary view plus the traveller pricings.
      expect(offer).not.toHaveProperty("amadeus");
      expect(offer.travelerPricings).toHaveLength(1);
    }
    // Selling prices only: no net field and no net total anywhere in the answer.
    expect(netKeys(res.body)).toEqual([]);
    const values = strings(res.body);
    for (const net of Object.values(UPSELL_NET)) {
      expect(values).not.toContain(net);
    }
    // The comparison: the base offer first, then the upsell offers by ascending price, differences to the base.
    const columns = body.comparison.columns;
    expect(columns.map((column) => [column.offerId, column.isBaseOffer, column.brandedFare])).toEqual([
      [offerId, true, "BASIC"],
      [ids[0], false, "BASIC"],
      [ids[1], false, "CLASSIC"],
      [ids[2], false, "FLEXIBLE"],
    ]);
    expect(columns.map((column) => column.priceDifference.amount)).toEqual([
      "0.00",
      "0.00",
      new Money(sellingOf(UPSELL_NET.CLASSIC)).minus(sellingOf(BASE_NET)).toFixed(2),
      new Money(sellingOf(UPSELL_NET.FLEXIBLE)).minus(sellingOf(BASE_NET)).toFixed(2),
    ]);
    const row = (key: string) =>
      body.comparison.rows.find((entry) => entry.key === key)?.values.map((cell) => cell.status);
    expect(row("checked_bags")).toEqual(["not_offered", "chargeable", "included", "included"]);
    expect(row("refund")).toEqual(["unknown", "not_offered", "not_offered", "included"]);
    expect(row("change")).toEqual(["unknown", "chargeable", "chargeable", "included"]);
    expect(row("seat_selection")).toEqual(["unknown", "chargeable", "included", "included"]);

    // One Amadeus call; the upsell, its offers (selling = net + markup) and the supplier call are stored.
    expect(upsellCalls()).toHaveLength(1);
    const stored = await tenantTx(tenantDb, "tenant_alpha", async (trx) => ({
      search: await trx
        .selectFrom("flight_searches")
        .select("expires_at")
        .where("id", "=", searchId)
        .executeTakeFirstOrThrow(),
      upsell: await trx
        .selectFrom("offer_upsells")
        .selectAll()
        .where("id", "=", body.id)
        .executeTakeFirstOrThrow(),
      offers: await trx
        .selectFrom("flight_offers")
        .select([
          "id",
          "origin",
          "search_id",
          "upsell_id",
          "amadeus_offer_id",
          "net_total",
          "markup_amount",
          "selling_total",
          "expires_at",
        ])
        .where("upsell_id", "=", body.id)
        .orderBy("amadeus_offer_id")
        .execute(),
      calls: await trx
        .selectFrom("supplier_requests")
        .select(["search_id", "amadeus_operation_id"])
        .where("amadeus_operation_id", "=", "upsellAirOffers")
        .execute(),
    }));
    expect(stored.upsell).toMatchObject({ base_offer_id: offerId, status: "completed", result_count: 3 });
    expect(stored.upsell.expires_at).toEqual(stored.search.expires_at);
    expect(stored.offers.map((offer) => [offer.id, offer.net_total, offer.selling_total])).toEqual(
      ids.map((id, index) => {
        const net = Object.values(UPSELL_NET)[index] ?? "";
        return [id, net, sellingOf(net)];
      }),
    );
    for (const offer of stored.offers) {
      expect(offer).toMatchObject({ origin: "upsell", search_id: searchId, upsell_id: body.id });
      expect(new Money(offer.net_total).plus(offer.markup_amount).toFixed(2)).toBe(offer.selling_total);
      // OADR-0002 point 3: the upsell offers expire with the parent search.
      expect(offer.expires_at).toEqual(stored.search.expires_at);
    }
    expect(stored.calls).toEqual([{ search_id: searchId, amadeus_operation_id: "upsellAirOffers" }]);
    expect(body.expiresAt).toBe(stored.search.expires_at.toISOString());
    // The upsell call, linked to the search, does not replace the search's own call in its console diagnostics.
    const diagnosed = await request(api.server)
      .get(`/v1/flight-searches/${searchId}`)
      .set({ "X-Api-Key": alphaConsole, "X-Velexis-Scope": "console" });
    expect(diagnosed.status).toBe(200);
    expect(diagnosed.body).toHaveProperty("diagnostics.amadeusOperationId", "getFlightOffers");

    // An upsell offer reads like any offer, with its upsell fields; the search's listing never shows it.
    const read = await getOffer(alphaSk, ids[2] ?? "");
    expect(read.status).toBe(200);
    expectResponseToMatch("getFlightOffer", read);
    expect(read.body).toMatchObject({
      id: ids[2],
      origin: "upsell",
      baseOfferId: offerId,
      upsellId: body.id,
      price: { total: { amount: sellingOf(UPSELL_NET.FLEXIBLE) } },
    });
    expect(netKeys(read.body)).toEqual([]);
    const list = await request(api.server)
      .get(`/v1/flight-searches/${searchId}/offers?limit=50`)
      .set({ "X-Api-Key": alphaSk });
    expect(list.status).toBe(200);
    expect((list.body as { total: number }).total).toBe(5);
  });

  it("answers 409 SOLD_OUT when Amadeus cannot sell the segments, and stores nothing [OBE-022 AC1]", async () => {
    const { offerId } = await baseOffer();
    stub.clearRequests();

    const res = await upsell(alphaSk, offerId, undefined, stubScenario("sold-out"));

    expect(res.status).toBe(409);
    expectResponseToMatch("upsellFlightOffer", res);
    expect(res.body).toMatchObject({ error: { code: "SOLD_OUT" } });
    expect(upsellCalls()).toHaveLength(1);
    const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.selectFrom("offer_upsells").select("id").where("base_offer_id", "=", offerId).execute(),
    );
    expect(rows).toEqual([]);
  });

  it("answers an identical request again from offer_upsells without calling Amadeus", async () => {
    const { offerId } = await baseOffer();
    const payments = [{ brand: "VISA", bin: "411111" }];
    const first = await upsell(alphaSk, offerId, { payments });
    expect(first.status).toBe(200);
    stub.clearRequests();

    // Another Idempotency-Key: not an idempotent replay, the same offers and payments.
    const again = await upsell(alphaSk, offerId, { payments });

    expect(again.status).toBe(200);
    expectResponseToMatch("upsellFlightOffer", again);
    const before = first.body as UpsellBody;
    const after = again.body as UpsellBody;
    expect(after.cached).toBe(true);
    expect(after.id).toBe(before.id);
    expect(after.offers.map((offer) => offer.id)).toEqual(before.offers.map((offer) => offer.id));
    expect(after.comparison).toEqual(before.comparison);
    expect(upsellCalls()).toEqual([]);

    // Other payments are another request: Amadeus is called again, with the BIN as an integer.
    const other = await upsell(alphaSk, offerId, { payments: [{ brand: "MASTERCARD", bin: "555555" }] });
    expect(other.status).toBe(200);
    expectResponseToMatch("upsellFlightOffer", other);
    expect(other.body).toMatchObject({ cached: false });
    expect((other.body as UpsellBody).id).not.toBe(before.id);
    expect(upsellCalls()).toHaveLength(1);
    const stored = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .selectFrom("offer_upsells")
        .select("amadeus_request")
        .where("id", "=", (other.body as UpsellBody).id)
        .executeTakeFirstOrThrow(),
    );
    expect(stored.amadeus_request).toMatchObject({
      data: { payments: [{ brand: "MASTERCARD", binNumber: 555555, flightOfferIds: ["2"] }] },
    });
  });

  it("answers 404 to tenant B for tenant A's offer, and calls nothing [OBE-022 AC2]", async () => {
    const { offerId } = await baseOffer();
    stub.clearRequests();

    const res = await upsell(betaSk, offerId);

    expect(res.status).toBe(404);
    expectResponseToMatch("upsellFlightOffer", res);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(stub.requests()).toEqual([]);
  });

  it("answers 410 OFFER_EXPIRED for an expired offer without calling Amadeus", async () => {
    const { offerId } = await baseOffer();
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .updateTable("flight_offers")
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where("id", "=", offerId)
        .execute(),
    );
    stub.clearRequests();

    const res = await upsell(alphaSk, offerId);

    expect(res.status).toBe(410);
    expectResponseToMatch("upsellFlightOffer", res);
    expect(res.body).toMatchObject({ error: { code: "OFFER_EXPIRED" } });
    expect(upsellCalls()).toEqual([]);
  });

  it("refuses offers of two searches with 422 and a card for another offer with 400", async () => {
    const first = await baseOffer();
    // Other criteria: an identical search within 30 s would join the first one (single flight).
    const second = await alphaSearch({ ...SIMPLE, departureDate: "2027-01-16" });
    expect(second.searchId).not.toBe(first.searchId);
    stub.clearRequests();

    const mixed = await upsell(alphaSk, first.offerId, { combineWithOfferIds: [second.offers.get("3")] });
    expect(mixed.status).toBe(422);
    expectResponseToMatch("upsellFlightOffer", mixed);
    expect(mixed.body).toMatchObject({ error: { code: "OFFER_COMBINATION_INVALID" } });

    const card = await upsell(alphaSk, first.offerId, {
      payments: [{ brand: "VISA", offerIds: [first.others.get("3")] }],
    });
    expect(card.status).toBe(400);
    expectResponseToMatch("upsellFlightOffer", card);
    expect(card.body).toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: [{ path: "/payments/0/offerIds/0" }] },
    });
    expect(upsellCalls()).toEqual([]);
  });

  it("upsells two offers of one search together with their one-way combinations", async () => {
    const { offerId, others } = await baseOffer();
    const other = others.get("3") ?? "";

    const res = await upsell(
      alphaConsole,
      offerId,
      { combineWithOfferIds: [other] },
      {
        "X-Velexis-Scope": "console",
      },
    );

    expect(res.status).toBe(200);
    expectResponseToMatch("upsellFlightOffer", res);
    const body = res.body as UpsellBody & {
      oneWayUpselledCombinations: Array<{ offerId: string; upsellOfferIds: string[] }>;
    };
    expect(body.offerIds).toEqual([offerId, other]);
    // The stub's fare families fly offer 2's flight (IB3436), not offer 3's.
    expect(body.oneWayUpselledCombinations).toEqual([
      { offerId, upsellOfferIds: body.offers.map((offer) => offer.id) },
      { offerId: other, upsellOfferIds: [] },
    ]);
    // Console scope: net prices and markups of the upsell offers.
    expect(body.offers.map((offer) => offer.netPrice?.amount)).toEqual(Object.values(UPSELL_NET));
    const [call] = upsellCalls();
    expect(call?.status).toBe(200);
  });

  it("answers 403 FEATURE_DISABLED in customer scope when the storefront turned upsell off", async () => {
    const { offerId } = await baseOffer();
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .updateTable("storefront_settings")
        .set({ features: JSON.stringify({ brandedFareUpsell: false }) })
        .execute(),
    );
    stub.clearRequests();
    try {
      const res = await upsell(alphaSk, offerId);
      expect(res.status).toBe(403);
      expectResponseToMatch("upsellFlightOffer", res);
      expect(res.body).toMatchObject({
        error: { code: "FEATURE_DISABLED", details: { feature: "brandedFareUpsell" } },
      });
      expect(upsellCalls()).toEqual([]);

      // Console scope may always call it.
      const consoleCall = await upsell(alphaConsole, offerId, undefined, { "X-Velexis-Scope": "console" });
      expect(consoleCall.status).toBe(200);
      expectResponseToMatch("upsellFlightOffer", consoleCall);
    } finally {
      await tenantTx(tenantDb, "tenant_alpha", (trx) =>
        trx
          .updateTable("storefront_settings")
          .set({ features: JSON.stringify({}) })
          .execute(),
      );
    }
  });

  it("runs from the hosted storefront with the CSRF header", async () => {
    const { offerId } = await baseOffer();

    const res = await request(api.server)
      .post(`/v1/flight-offers/${offerId}/upsells`)
      .set({ ...edgeWriteHeaders(ALPHA_HOST), "Idempotency-Key": idempotencyKey() })
      .send({});

    expect(res.status).toBe(200);
    expectResponseToMatch("upsellFlightOffer", res);
    expect(netKeys(res.body)).toEqual([]);
  });
});
