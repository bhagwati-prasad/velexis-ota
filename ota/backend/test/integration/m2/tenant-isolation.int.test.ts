// Shopping isolation between two tenants on a pool of ONE connection, against PostgreSQL 16, Redis 7 and the Amadeus
// stub (OBE-026; ota/docs/flows/search-and-price.md §6, ota/docs/architecture.md §4 and §9,
// docs/velexis-sdk/db/README.md §5, ADR-0004). The file clones the @velexis/testing template (tenant_alpha and
// tenant_beta provisioned) and writes the platform rows of two tenants as the platform does: their tenants, a verified
// custom storefront domain for beta, their own Amadeus test connection (one office each) on the Velexis test account
// the stub accepts, and a secret test key each. Their settings and default markup rule are seeded as provisioning
// seeds them; alpha sells at net + 10 %, beta at net + 5.00 EUR.
//
// The API runs in-process with its pool of velexis_ota_app cut to one connection (the `vi.mock` below): every tenant
// transaction and every platform read of both tenants queues for the same connection, so a `search_path` that
// outlived its transaction would reach the other tenant's next transaction, where the leak guard of `tenantTx`
// (@velexis/db, on outside production) or the answer itself would show it. The four shopping flows (alpha and beta,
// edge and key: every M2 customer operation) run at once, interleaved, in a `beforeAll` hook; the tests check what they
// answered, then present each tenant's `srch_`, `off_` and `prc_` ids at the other tenant (404) and look into both
// schemas.
//
// Every answer is checked against the OTA document (`expectResponseToMatch`).
import { randomBytes } from "node:crypto";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import { encryptValue, hashApiKey, type KeyProvider } from "@velexis/crypto";
import type * as DbModule from "@velexis/db";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type ReferenceDatabase,
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { API_APP } from "../../../src/config";
import { Money } from "../../../src/pricing/pricing.types";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { OTA_POOL, type OtaPool } from "../../../src/tenancy/tenancy.module";
import {
  edgeHeaders,
  edgeWriteHeaders,
  newApiKey,
  TEST_STOREFRONT_BASE_DOMAIN,
  testApiCredentials,
  testKeyProvider,
} from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

// The API's pool of velexis_ota_app (application_name `ota-api`) gets one connection, every other pool its own size.
vi.mock("@velexis/db", async (importOriginal) => {
  const original = await importOriginal<typeof DbModule>();
  return {
    ...original,
    createPool: (url: string, options: DbModule.CreatePoolOptions) =>
      original.createPool(url, options.applicationName === "ota-api" ? { ...options, max: 1 } : options),
  };
});

/** The M2 operations a customer-scope caller may call. */
const M2_CUSTOMER_OPERATIONS: readonly OtaOperationId[] = otaOperations
  .filter((operation) => operation.milestone === "M2" && operation.scope !== "console")
  .map((operation) => operation.operationId);

/** The net grand totals of the stub's search fixture, by Amadeus offer id; the flows open and price offer 2. */
const NET = Object.freeze({ "1": "92.15", "2": "98.47", "3": "109.32", "4": "131.86", "5": "558.94" });
/** The net grand totals of the stub's Branded Fares Upsell fixture (offer 2's fare families). */
const UPSELL_NET = Object.freeze(["98.47", "126.47", "189.47"]);

type Mode = "edge" | "key";
const MODES: readonly Mode[] = ["edge", "key"];

interface Tenant {
  readonly name: "alpha" | "beta";
  readonly schema: "tenant_alpha" | "tenant_beta";
  /** The storefront host of its edge requests: alpha's sub-domain, beta's verified custom domain. */
  readonly host: string;
  readonly sellingOf: (net: string) => string;
  /** The tenant's own Amadeus office: one per tenant, never the other's. */
  readonly office: string;
  id: string;
  sk: string;
}

const alpha: Tenant = {
  name: "alpha",
  schema: "tenant_alpha",
  host: `alpha.${TEST_STOREFRONT_BASE_DOMAIN}`,
  sellingOf: (net) => new Money(net).times("1.1").toFixed(2),
  office: "NCE1A0001",
  id: "",
  sk: "",
};
const beta: Tenant = {
  name: "beta",
  schema: "tenant_beta",
  host: "book.beta-trips.example",
  sellingOf: (net) => new Money(net).plus("5.00").toFixed(2),
  office: "PAR1A0002",
  id: "",
  sk: "",
};
const TENANTS: readonly Tenant[] = [alpha, beta];

/** A one-way SIMPLE search Madrid → Paris Orly for one adult; each search gets its own day (no single flight). */
let searchDays = 0;
const simpleSearch = (): Record<string, unknown> => {
  searchDays += 1;
  return {
    mode: "simple",
    originLocationCode: "MAD",
    destinationLocationCode: "ORY",
    departureDate: new Date(Date.now() + (90 + searchDays) * 86_400_000).toISOString().slice(0, 10),
    adults: 1,
  };
};

/** The last ticketing day of the priced offers, 60 days ahead, so no expiry depends on the fixture's calendar date. */
const LAST_TICKETING_DATE = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
/** velexis_migrator, the owner of the platform and reference tables: it writes what the platform and the loader do. */
let migrator: Kysely<PlatformDatabase & ReferenceDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let accountId: string;

const idempotencyKey = (): string => randomBytes(16).toString("hex");

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

/** The platform rows of a tenant (tenant, beta's custom domain, Amadeus connection, key) and its seeded settings. */
async function insertTenant(tenant: Tenant): Promise<void> {
  tenant.id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: tenant.id,
      key: tenant.name,
      name: `${tenant.name} Travel`,
      status: "active",
      plan_code: "early_access",
    })
    .execute();
  if (!tenant.host.endsWith(`.${TEST_STOREFRONT_BASE_DOMAIN}`)) {
    await migrator
      .insertInto("platform.tenant_domains")
      .values({
        id: newId("dom"),
        tenant_id: tenant.id,
        hostname: tenant.host,
        kind: "custom",
        verification_token: `velexis-verify-${newId("tok")}`,
        purpose: "storefront",
        verification_status: "verified",
      })
      .execute();
  }
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: tenant.id,
      environment: "test",
      credential_source: "velexis",
      amadeus_account_id: accountId,
      office_ids: [tenant.office],
      default_office_id: tenant.office,
      queuing_office_id: tenant.office,
      owner_office_id: tenant.office,
      status: "active",
    })
    .execute();
  tenant.sk = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenant.id,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: tenant.sk.slice(0, 14),
      key_hash: hashApiKey(tenant.sk, testApiCredentials().pepper),
      last4: tenant.sk.slice(-4),
    })
    .execute();
  await tenantTx(tenantDb, tenant.schema, async (trx) => {
    await seedStorefrontSettings(trx, {
      name: `${tenant.name} Travel`,
      defaultCurrency: "EUR",
      defaultLocale: "en",
    });
    await seedDefaultMarkupRule(trx);
  });
}

/** Alpha's 10 % markup and beta's 5.00 EUR per booking, over their default rules. */
async function seedMarkups(): Promise<void> {
  const rule = {
    scope: JSON.stringify({}),
    priority: 10,
    stackable: false,
    is_default: false,
    is_active: true,
  };
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx
      .insertInto("markup_rules")
      .values({ ...rule, id: newId("mkr"), name: "Ten percent", calculation: "percentage", percentage: "10" })
      .execute(),
  );
  await tenantTx(tenantDb, "tenant_beta", (trx) =>
    trx
      .insertInto("markup_rules")
      .values({
        ...rule,
        id: newId("mkr"),
        name: "Five euros",
        calculation: "fixed",
        fixed_amount: "5.00",
        fixed_currency: "EUR",
        applies_per: "booking",
      })
      .execute(),
  );
}

/** CDG with its time zone and position, as the reference loader writes them (the template's fixture has neither). */
async function completeReference(): Promise<void> {
  await migrator
    .insertInto("reference.time_zones")
    .values({ name: "Europe/Paris", country_code: "FR", utc_offset_minutes: 60, dst_offset_minutes: 120 })
    .execute();
  await migrator
    .updateTable("reference.airports")
    .set({ time_zone: "Europe/Paris", latitude: "49.009722", longitude: "2.547778" })
    .where("iata_code", "=", "CDG")
    .execute();
}

/** The headers of a caller of `tenant` in `mode`; `write` adds what state-changing requests need. */
function credentials(tenant: Tenant, mode: Mode, write: boolean): Record<string, string> {
  const caller =
    mode === "edge"
      ? write
        ? edgeWriteHeaders(tenant.host)
        : edgeHeaders(tenant.host)
      : { "X-Api-Key": tenant.sk };
  return write ? { ...caller, "Idempotency-Key": idempotencyKey() } : { ...caller };
}

/** One request as `tenant` in `mode`. */
function send(tenant: Tenant, mode: Mode, method: "get" | "post", path: string, body?: object): request.Test {
  const headers = credentials(tenant, mode, method === "post");
  return method === "post"
    ? request(api.server).post(path).set(headers).send(body)
    : request(api.server).get(path).set(headers);
}

/** What one shopping flow answered, by operation, and the ids it made. */
interface Flow {
  readonly tenant: Tenant;
  readonly mode: Mode;
  readonly answers: ReadonlyMap<OtaOperationId, request.Response>;
  readonly searchId: string;
  readonly offerId: string;
  readonly upsellOfferIds: readonly string[];
  readonly pricedOfferId: string;
}

/** A value of an answer the next step needs; throws with the step's status and error code when it is missing. */
function required(res: request.Response, operationId: OtaOperationId, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    const code = (res.body as { error?: { code?: string } }).error?.code ?? "no error code";
    throw new Error(`${operationId} answered ${res.status} (${code}); the flow cannot go on`);
  }
  return value;
}

/** Every M2 customer operation once, in the storefront's order, as `tenant` in `mode`. */
async function shop(tenant: Tenant, mode: Mode): Promise<Flow> {
  const answers = new Map<OtaOperationId, request.Response>();
  const call = async (
    operationId: OtaOperationId,
    method: "get" | "post",
    path: string,
    body?: object,
  ): Promise<request.Response> => {
    const res = await send(tenant, mode, method, path, body);
    answers.set(operationId, res);
    return res;
  };
  await call("getStorefront", "get", "/v1/storefront");
  await call("searchLocations", "get", "/v1/reference/locations?keyword=cdg");
  await call("getAirport", "get", "/v1/reference/airports/CDG");
  await call("listAirlines", "get", "/v1/reference/airlines");
  await call("getAirline", "get", "/v1/reference/airlines/AF");
  await call("listCountries", "get", "/v1/reference/countries");
  await call("listCurrencies", "get", "/v1/reference/currencies");
  const search = await call("createFlightSearch", "post", "/v1/flight-searches", simpleSearch());
  const searchId = required(search, "createFlightSearch", (search.body as { id?: unknown }).id);
  await tenantTx(tenantDb, tenant.schema, (trx) =>
    trx
      .updateTable("flight_offers")
      .set({
        payload: sql`jsonb_set(payload, '{lastTicketingDate}', to_jsonb(${LAST_TICKETING_DATE}::text))`,
        last_ticketing_date: LAST_TICKETING_DATE,
      })
      .where("search_id", "=", searchId)
      .execute(),
  );
  await call("getFlightSearch", "get", `/v1/flight-searches/${searchId}`);
  const results = await call(
    "listFlightSearchResults",
    "get",
    `/v1/flight-searches/${searchId}/offers?view=full&limit=50`,
  );
  const listed = (results.body as { data?: Array<{ id: string; amadeus?: { id: string } }> }).data ?? [];
  const offerId = required(
    results,
    "listFlightSearchResults",
    listed.find((offer) => offer.amadeus?.id === "2")?.id,
  );
  await call("getFlightOffer", "get", `/v1/flight-offers/${offerId}`);
  const upsell = await call("upsellFlightOffer", "post", `/v1/flight-offers/${offerId}/upsells`, {});
  const upsellOfferIds = ((upsell.body as { offers?: Array<{ id: string }> }).offers ?? []).map(
    (offer) => offer.id,
  );
  const priced = await call("priceFlightOffers", "post", "/v1/priced-offers", { offerIds: [offerId] });
  const pricedOfferId = required(priced, "priceFlightOffers", (priced.body as { id?: unknown }).id);
  await call("getPricedOffer", "get", `/v1/priced-offers/${pricedOfferId}`);
  await call("getPricedOfferAncillaries", "get", `/v1/priced-offers/${pricedOfferId}/ancillaries`);
  await call("getPricedOfferFareRules", "get", `/v1/priced-offers/${pricedOfferId}/fare-rules`);
  return { tenant, mode, answers, searchId, offerId, upsellOfferIds, pricedOfferId };
}

/** The success status of each M2 customer operation. */
const successOf = (operationId: OtaOperationId): number =>
  operationId === "createFlightSearch" || operationId === "priceFlightOffers" ? 201 : 200;

let flows: Flow[] = [];
const flowOf = (tenant: Tenant, mode: Mode): Flow => {
  const flow = flows.find((entry) => entry.tenant === tenant && entry.mode === mode);
  if (flow === undefined) {
    throw new Error(`no ${mode} flow of ${tenant.name}`);
  }
  return flow;
};

/** What the API's pool did during the flows: the most connections checked out at once, and the longest queue. */
const poolUse = { checkedOut: 0, maxCheckedOut: 0, maxWaiting: 0, acquisitions: 0 };

// Cloning the template, the platform rows, starting the stub and building the API's module graph (Nest, pools, Redis,
// the OTA document's validators) take several seconds alone and much longer on a busy 4-CPU runner: all of it happens
// once here, with its own budget, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of the M2 operations compile on their first check: here, with every status the tests
  // check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const operationId of M2_CUSTOMER_OPERATIONS) {
    for (const status of [successOf(operationId), 404]) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, keys] = await Promise.all([createTestDatabase(), useRedis(), testKeyProvider()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase & ReferenceDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  accountId = await insertAccount(clientId, secret);
  for (const tenant of TENANTS) {
    await insertTenant(tenant);
  }
  await seedMarkups();
  await completeReference();
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  api = await createTestApp({ database: db, redis, env: { AMADEUS_BASE_URL_TEST: stub.url } });
  const pool = api.app.get<string, OtaPool>(OTA_POOL);
  pool.on("acquire", () => {
    poolUse.checkedOut += 1;
    poolUse.acquisitions += 1;
    poolUse.maxCheckedOut = Math.max(poolUse.maxCheckedOut, poolUse.checkedOut);
    poolUse.maxWaiting = Math.max(poolUse.maxWaiting, pool.waitingCount);
  });
  pool.on("release", () => {
    poolUse.checkedOut -= 1;
  });
}, OPENAPI_SETUP_TIMEOUT_MS);

// The four flows at once, so the two tenants' requests interleave on the one connection: 64 requests, 12 of which call
// the stub. About a second here; budgeted for a loaded CI runner, where they also wait for each other's transactions.
beforeAll(async () => {
  flows = await Promise.all(TENANTS.flatMap((tenant) => MODES.map((mode) => shop(tenant, mode))));
}, 60_000);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

describe("the pool-of-one run", () => {
  it("serves every M2 operation of two tenants at once on one connection, each answer its own tenant's [OBE-026 AC3]", () => {
    const pool = api.app.get<string, OtaPool>(OTA_POOL);
    expect([pool.options.application_name, pool.options.max]).toEqual([API_APP, 1]);
    // One connection checked out at a time, and requests queued for it: the tenants really shared it.
    expect(poolUse.maxCheckedOut).toBe(1);
    expect(poolUse.maxWaiting).toBeGreaterThan(0);
    expect(poolUse.acquisitions).toBeGreaterThan(flows.length * M2_CUSTOMER_OPERATIONS.length);

    for (const flow of flows) {
      const { tenant, answers } = flow;
      const label = `${tenant.name} ${flow.mode}`;
      expect([label, [...answers.keys()].sort()]).toEqual([label, [...M2_CUSTOMER_OPERATIONS].sort()]);
      for (const [operationId, res] of answers) {
        expect([label, operationId, res.status]).toEqual([label, operationId, successOf(operationId)]);
        expectResponseToMatch(operationId, res);
      }
      expect(answers.get("getStorefront")?.body, label).toMatchObject({ tenantKey: tenant.name });
      // Each tenant's own markup priced its offers: no answer of one tenant carries the other's prices.
      const offers = (
        answers.get("listFlightSearchResults")?.body as {
          data: Array<{ price: { total: { amount: string } } }>;
        }
      ).data;
      expect(offers.map((offer) => offer.price.total.amount).sort(), label).toEqual(
        Object.values(NET).map(tenant.sellingOf).sort(),
      );
      const upsold = (
        answers.get("upsellFlightOffer")?.body as { offers: Array<{ price: { total: { amount: string } } }> }
      ).offers;
      expect(
        upsold.map((offer) => offer.price.total.amount),
        label,
      ).toEqual(UPSELL_NET.map(tenant.sellingOf));
      expect(answers.get("getPricedOffer")?.body, label).toMatchObject({
        id: flow.pricedOfferId,
        searchId: flow.searchId,
        offerIds: [flow.offerId],
        price: { total: { amount: tenant.sellingOf(NET["2"]) } },
      });
    }
  });

  it("hands the connection back with the role's search_path after every transaction [OBE-026 AC3]", async () => {
    const pool = api.app.get<string, OtaPool>(OTA_POOL);

    const { rows } = await pool.query<{ path: string; reset: string }>(
      "SELECT current_setting('search_path') AS path, reset_val AS reset FROM pg_catalog.pg_settings WHERE name = 'search_path'",
    );

    expect(rows).toEqual([{ path: "pg_catalog", reset: "pg_catalog" }]);
    expect(pool.totalCount).toBeLessThanOrEqual(1);
  });
});

describe("tenant A's ids at tenant B", () => {
  /** Every M2 request that names one of `owner`'s ids. */
  const requestsFor = (
    owner: Flow,
  ): ReadonlyArray<readonly [OtaOperationId, "get" | "post", string, object?]> => [
    ["getFlightSearch", "get", `/v1/flight-searches/${owner.searchId}`],
    ["listFlightSearchResults", "get", `/v1/flight-searches/${owner.searchId}/offers`],
    ["getFlightOffer", "get", `/v1/flight-offers/${owner.offerId}`],
    ["getFlightOffer", "get", `/v1/flight-offers/${owner.upsellOfferIds[0] ?? ""}`],
    ["upsellFlightOffer", "post", `/v1/flight-offers/${owner.offerId}/upsells`, {}],
    ["priceFlightOffers", "post", "/v1/priced-offers", { offerIds: [owner.offerId] }],
    ["priceFlightOffers", "post", "/v1/priced-offers", { offerIds: [owner.upsellOfferIds[1] ?? ""] }],
    ["getPricedOffer", "get", `/v1/priced-offers/${owner.pricedOfferId}`],
    ["getPricedOfferAncillaries", "get", `/v1/priced-offers/${owner.pricedOfferId}/ancillaries`],
    ["getPricedOfferFareRules", "get", `/v1/priced-offers/${owner.pricedOfferId}/fare-rules`],
  ];

  it("answer 404 NOT_FOUND, by key and by edge, on every operation that takes a srch_, off_ or prc_ id [OBE-026 AC1] [OF-01 AC2]", async () => {
    stub.clearRequests();
    for (const [owner, other] of [
      [alpha, beta],
      [beta, alpha],
    ] as const) {
      for (const mode of MODES) {
        const ids = flowOf(owner, mode);
        expect(ids.upsellOfferIds).toHaveLength(3);
        for (const [operationId, method, path, body] of requestsFor(ids)) {
          const res = await send(other, mode, method, path, body);

          expect([owner.name, other.name, mode, operationId, res.status, res.body.error?.code]).toEqual([
            owner.name,
            other.name,
            mode,
            operationId,
            404,
            "NOT_FOUND",
          ]);
          expectResponseToMatch(operationId, res);
        }
      }
    }
    // Nothing of another tenant reached Amadeus: no upsell and no pricing for the foreign offers.
    expect(stub.requests()).toEqual([]);
  });

  it("are still the owner's: the same requests by the owning tenant succeed", async () => {
    for (const tenant of TENANTS) {
      const ids = flowOf(tenant, "key");
      for (const [operationId, method, path] of requestsFor(ids).filter(([, method]) => method === "get")) {
        const res = await send(tenant, "key", method, path);

        expect([tenant.name, operationId, res.status]).toEqual([tenant.name, operationId, 200]);
        expectResponseToMatch(operationId, res);
      }
    }
  });
});

describe("the tenant schemas", () => {
  it("hold each tenant's searches, offers, upsells and priced offers, none of the other's [OBE-026 AC1]", async () => {
    const idsIn = async (schema: Tenant["schema"]) =>
      await tenantTx(tenantDb, schema, async (trx) => ({
        searches: (await trx.selectFrom("flight_searches").select("id").execute()).map((row) => row.id),
        offers: (await trx.selectFrom("flight_offers").select("id").execute()).map((row) => row.id),
        upsells: (await trx.selectFrom("offer_upsells").select("base_offer_id").execute()).map(
          (row) => row.base_offer_id,
        ),
        priced: (await trx.selectFrom("priced_offers").select("id").execute()).map((row) => row.id),
      }));
    const stored = { alpha: await idsIn("tenant_alpha"), beta: await idsIn("tenant_beta") };

    for (const tenant of TENANTS) {
      const own = stored[tenant.name];
      const other = stored[tenant === alpha ? "beta" : "alpha"];
      for (const mode of MODES) {
        const flow = flowOf(tenant, mode);
        expect(own.searches).toContain(flow.searchId);
        expect(own.offers).toEqual(expect.arrayContaining([flow.offerId, ...flow.upsellOfferIds]));
        expect(own.upsells).toContain(flow.offerId);
        expect(own.priced).toContain(flow.pricedOfferId);
        expect(other.searches).not.toContain(flow.searchId);
        for (const offerId of [flow.offerId, ...flow.upsellOfferIds]) {
          expect(other.offers).not.toContain(offerId);
        }
        expect(other.upsells).not.toContain(flow.offerId);
        expect(other.priced).not.toContain(flow.pricedOfferId);
      }
    }
  });

  it("log every Amadeus call of a tenant with that tenant's own office", async () => {
    for (const tenant of TENANTS) {
      const calls = await tenantTx(tenantDb, tenant.schema, (trx) =>
        trx.selectFrom("supplier_requests").select(["office_id", "amadeus_operation_id"]).execute(),
      );

      // Two flows: two searches, two upsells and two pricings.
      expect(calls.map((call) => call.amadeus_operation_id).sort()).toEqual([
        "getFlightOffers",
        "getFlightOffers",
        "quoteAirOffers",
        "quoteAirOffers",
        "upsellAirOffers",
        "upsellAirOffers",
      ]);
      expect(new Set(calls.map((call) => call.office_id))).toEqual(new Set([tenant.office]));
    }
  });
});
