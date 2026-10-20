// Every M2 customer operation of two tenants, called as the hosted storefront (edge headers) and with an sk_test key,
// against PostgreSQL 16, Redis 7 and the Amadeus stub (OBE-026; ota/docs/scope.md OF-01 and OF-02, OADR-0009,
// ota/docs/architecture.md §3.1). The file clones the @velexis/testing template (tenant_alpha and tenant_beta
// provisioned) and writes the platform rows of the two tenants as the platform does: their tenants, a verified custom
// storefront domain each next to their sub-domain, their own Amadeus test connection (one office each) on the Velexis
// test account the stub accepts, a secret and a publishable test key each. Their settings and default markup rule are
// seeded as provisioning seeds them; alpha sells at net + 10 %, beta at net + 5.00 EUR, so each answer shows whose
// rules priced it. The API runs in-process on a pool of ONE connection (the pool-of-one run of db README §5).
//
// The four shopping flows (alpha and beta, edge and key) run once in a `beforeAll` hook; the tests check what they
// answered. Then the credentials of one tenant are presented at the other: an API key with the other tenant's edge
// headers (400), with its host header alone (the key's own tenant only), from its storefront origin (403), and a
// customer token of one tenant at the other, by key and by edge (401) [OF-01 AC2]. Last, `dev:seed` (OBE-007) runs on
// the same database and the two keys it prints are used once against the API.
//
// Every answer is checked against the OTA document (`expectResponseToMatch`).
import { randomBytes } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
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
import { runCli } from "../../../src/cli";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { API_APP, type ApiConfig } from "../../../src/config";
import { TokenService } from "../../../src/identity/token.service";
import { Money } from "../../../src/pricing/pricing.types";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { OTA_POOL, type OtaPool } from "../../../src/tenancy/tenancy.module";
import {
  edgeHeaders,
  edgeWriteHeaders,
  newApiKey,
  newCsrfToken,
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

/** The M2 operations a customer-scope caller may call: every one of them runs in both modes below. */
const M2_CUSTOMER_OPERATIONS: readonly OtaOperationId[] = otaOperations
  .filter((operation) => operation.milestone === "M2" && operation.scope !== "console")
  .map((operation) => operation.operationId);

/** The net grand totals of the stub's search fixture, by Amadeus offer id; the flows open and price offer 2. */
const NET = Object.freeze({ "1": "92.15", "2": "98.47", "3": "109.32", "4": "131.86", "5": "558.94" });

type Mode = "edge" | "key";
const MODES: readonly Mode[] = ["edge", "key"];

interface Tenant {
  readonly name: "alpha" | "beta";
  readonly schema: "tenant_alpha" | "tenant_beta";
  /** The storefront sub-domain and a verified custom storefront domain. */
  readonly subdomain: string;
  readonly customDomain: string;
  /** The host the edge flow uses. */
  readonly edgeHost: string;
  /** The tenant's selling total of a net total: its own markup rule. */
  readonly sellingOf: (net: string) => string;
  id: string;
  office: string;
  sk: string;
  pk: string;
}

const alpha: Tenant = {
  name: "alpha",
  schema: "tenant_alpha",
  subdomain: `alpha.${TEST_STOREFRONT_BASE_DOMAIN}`,
  customDomain: "book.alpha-travel.example",
  edgeHost: `alpha.${TEST_STOREFRONT_BASE_DOMAIN}`,
  sellingOf: (net) => new Money(net).times("1.1").toFixed(2),
  id: "",
  office: "",
  sk: "",
  pk: "",
};
const beta: Tenant = {
  name: "beta",
  schema: "tenant_beta",
  subdomain: `beta.${TEST_STOREFRONT_BASE_DOMAIN}`,
  customDomain: "book.beta-trips.example",
  edgeHost: "book.beta-trips.example",
  sellingOf: (net) => new Money(net).plus("5.00").toFixed(2),
  id: "",
  office: "",
  sk: "",
  pk: "",
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

/**
 * The last ticketing day of the offers the flows price, 60 days ahead: the stub echoes the posted offers, whose fixture
 * date would bound a priced offer's expiry (OADR-0002 point 3) once it has passed; the stored offers get this one.
 */
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
let tokens: TokenService;

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

/** Issues a test key of a tenant as the platform does; a publishable key lists the tenant's storefront origin. */
async function issueKey(tenant: Tenant, kind: "pk" | "sk"): Promise<string> {
  const key = newApiKey(kind);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenant.id,
      name: kind === "pk" ? "Storefront (test)" : "Server (test)",
      kind: kind === "pk" ? "publishable" : "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      ...(kind === "pk" ? { allowed_origins: [`https://${tenant.customDomain}`] } : {}),
    })
    .execute();
  return key;
}

/** The platform rows of a tenant (tenant, custom domain, Amadeus connection, keys) and its seeded settings. */
async function insertTenant(tenant: Tenant): Promise<void> {
  tenant.id = newId("ten");
  tenant.office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
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
  await migrator
    .insertInto("platform.tenant_domains")
    .values({
      id: newId("dom"),
      tenant_id: tenant.id,
      hostname: tenant.customDomain,
      kind: "custom",
      verification_token: `velexis-verify-${newId("tok")}`,
      purpose: "storefront",
      verification_status: "verified",
    })
    .execute();
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
  tenant.sk = await issueKey(tenant, "sk");
  tenant.pk = await issueKey(tenant, "pk");
  await tenantTx(tenantDb, tenant.schema, async (trx) => {
    await seedStorefrontSettings(trx, {
      name: `${tenant.name} Travel`,
      defaultCurrency: "EUR",
      defaultLocale: "en",
    });
    await seedDefaultMarkupRule(trx);
  });
}

/**
 * The template's reference fixture has no time zones, and reference.airports.get offers no airport without one: CDG
 * gets its time zone and position, as the reference loader writes them.
 */
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

/** The headers of a caller of `tenant` in `mode`; `write` adds what state-changing requests need. */
function credentials(tenant: Tenant, mode: Mode, write: boolean): Record<string, string> {
  const host = tenant.edgeHost;
  const caller =
    mode === "edge" ? (write ? edgeWriteHeaders(host) : edgeHeaders(host)) : { "X-Api-Key": tenant.sk };
  return write ? { ...caller, "Idempotency-Key": idempotencyKey() } : { ...caller };
}

/** What one shopping flow answered, by operation, and the ids it made. */
interface Flow {
  readonly tenant: Tenant;
  readonly mode: Mode;
  readonly answers: ReadonlyMap<OtaOperationId, request.Response>;
  readonly searchId: string;
  readonly offerId: string;
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
    const headers = credentials(tenant, mode, method === "post");
    const res =
      method === "post"
        ? await request(api.server).post(path).set(headers).send(body)
        : await request(api.server).get(path).set(headers);
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
  await call("upsellFlightOffer", "post", `/v1/flight-offers/${offerId}/upsells`, {});
  const priced = await call("priceFlightOffers", "post", "/v1/priced-offers", { offerIds: [offerId] });
  const pricedOfferId = required(priced, "priceFlightOffers", (priced.body as { id?: unknown }).id);
  await call("getPricedOffer", "get", `/v1/priced-offers/${pricedOfferId}`);
  await call("getPricedOfferAncillaries", "get", `/v1/priced-offers/${pricedOfferId}/ancillaries`);
  await call("getPricedOfferFareRules", "get", `/v1/priced-offers/${pricedOfferId}/fare-rules`);
  return { tenant, mode, answers, searchId, offerId, pricedOfferId };
}

/** The success status of each M2 customer operation. */
const SUCCESS: Readonly<Partial<Record<OtaOperationId, number>>> = Object.freeze({
  createFlightSearch: 201,
  priceFlightOffers: 201,
});
const successOf = (operationId: OtaOperationId): number => SUCCESS[operationId] ?? 200;

const flows: Flow[] = [];
const flowOf = (tenant: Tenant, mode: Mode): Flow => {
  const flow = flows.find((entry) => entry.tenant === tenant && entry.mode === mode);
  if (flow === undefined) {
    throw new Error(`no ${mode} flow of ${tenant.name}`);
  }
  return flow;
};

// Cloning the template, the platform rows, starting the stub and building the API's module graph (Nest, pools, Redis,
// the OTA document's validators) take several seconds alone and much longer on a busy 4-CPU runner: all of it happens
// once here, with its own budget, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of the M2 operations (FlightSearch, FlightOffer, PricedOffer are large) compile on their
  // first check: here, with every status the tests check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const operationId of M2_CUSTOMER_OPERATIONS) {
    for (const status of [successOf(operationId), 400, 401, 403, 404]) {
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
  tokens = new TokenService(
    { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>,
    new Clock(),
  );
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  api = await createTestApp({ database: db, redis, env: { AMADEUS_BASE_URL_TEST: stub.url } });
}, OPENAPI_SETUP_TIMEOUT_MS);

// The four flows: 16 requests each, three of which call the stub (search, upsell, price). Well under a second each
// here; budgeted for a loaded CI runner, where the first answers of each operation also compile their serialisers.
beforeAll(async () => {
  for (const tenant of TENANTS) {
    for (const mode of MODES) {
      flows.push(await shop(tenant, mode));
    }
  }
}, 60_000);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

describe("both modes", () => {
  it("run on a pool of one connection of the API [OBE-026 AC3]", () => {
    const pool = api.app.get<string, OtaPool>(OTA_POOL);

    expect([pool.options.application_name, pool.options.max]).toEqual([API_APP, 1]);
    expect(pool.totalCount).toBeLessThanOrEqual(1);
  });

  it("call every M2 customer operation as the edge and with an sk_test key, for both tenants; every answer is documented [OBE-026 AC2] [OF-02 AC1]", () => {
    expect(M2_CUSTOMER_OPERATIONS).toHaveLength(16);
    for (const flow of flows) {
      expect([flow.tenant.name, flow.mode, [...flow.answers.keys()].sort()]).toEqual([
        flow.tenant.name,
        flow.mode,
        [...M2_CUSTOMER_OPERATIONS].sort(),
      ]);
      for (const [operationId, res] of flow.answers) {
        expect([flow.tenant.name, flow.mode, operationId, res.status]).toEqual([
          flow.tenant.name,
          flow.mode,
          operationId,
          successOf(operationId),
        ]);
        expectResponseToMatch(operationId, res);
      }
    }
    expect(flows.map((flow) => [flow.tenant.name, flow.mode])).toEqual([
      ["alpha", "edge"],
      ["alpha", "key"],
      ["beta", "edge"],
      ["beta", "key"],
    ]);
  });

  it("answer each tenant's own storefront and its own selling prices, the same in both modes [OBE-026 AC2] [OF-02 AC1]", () => {
    for (const flow of flows) {
      const { tenant, answers } = flow;
      const label = `${tenant.name} ${flow.mode}`;
      expect(answers.get("getStorefront")?.body, label).toMatchObject({
        tenantKey: tenant.name,
        environment: "test",
      });
      // Every listed total is the tenant's selling total of one of the fixture's net totals.
      const offers = (
        answers.get("listFlightSearchResults")?.body as {
          data: Array<{ price: { total: { amount: string } } }>;
        }
      ).data;
      expect(offers.map((offer) => offer.price.total.amount).sort(), label).toEqual(
        Object.values(NET).map(tenant.sellingOf).sort(),
      );
      expect(answers.get("getFlightOffer")?.body, label).toMatchObject({
        id: flow.offerId,
        price: { total: { amount: tenant.sellingOf(NET["2"]) } },
      });
      // No fee rules: the priced total is the offer's selling total.
      expect(answers.get("priceFlightOffers")?.body, label).toMatchObject({
        id: flow.pricedOfferId,
        offerIds: [flow.offerId],
        price: { total: { amount: tenant.sellingOf(NET["2"]), currency: "EUR" } },
      });
      expect(answers.get("getPricedOffer")?.body, label).toEqual(answers.get("priceFlightOffers")?.body);
    }
  });

  it("serve each tenant on its sub-domain and its verified custom domain", async () => {
    for (const tenant of TENANTS) {
      for (const host of [tenant.subdomain, tenant.customDomain]) {
        const res = await request(api.server).get("/v1/storefront").set(edgeHeaders(host));

        expect([host, res.status, res.body.tenantKey]).toEqual([host, 200, tenant.name]);
        expectResponseToMatch("getStorefront", res);
      }
    }
  });
});

describe("credentials of tenant A at tenant B", () => {
  /** One request of every M2 customer operation, with `owner`'s ids where the operation takes one. */
  const everyOperation = (
    owner: Flow,
  ): ReadonlyArray<readonly [OtaOperationId, "get" | "post", string, object?]> => [
    ["getStorefront", "get", "/v1/storefront"],
    ["searchLocations", "get", "/v1/reference/locations?keyword=cdg"],
    ["getAirport", "get", "/v1/reference/airports/CDG"],
    ["listAirlines", "get", "/v1/reference/airlines"],
    ["getAirline", "get", "/v1/reference/airlines/AF"],
    ["listCountries", "get", "/v1/reference/countries"],
    ["listCurrencies", "get", "/v1/reference/currencies"],
    ["createFlightSearch", "post", "/v1/flight-searches", simpleSearch()],
    ["getFlightSearch", "get", `/v1/flight-searches/${owner.searchId}`],
    ["listFlightSearchResults", "get", `/v1/flight-searches/${owner.searchId}/offers`],
    ["getFlightOffer", "get", `/v1/flight-offers/${owner.offerId}`],
    ["upsellFlightOffer", "post", `/v1/flight-offers/${owner.offerId}/upsells`, {}],
    ["priceFlightOffers", "post", "/v1/priced-offers", { offerIds: [owner.offerId] }],
    ["getPricedOffer", "get", `/v1/priced-offers/${owner.pricedOfferId}`],
    ["getPricedOfferAncillaries", "get", `/v1/priced-offers/${owner.pricedOfferId}/ancillaries`],
    ["getPricedOfferFareRules", "get", `/v1/priced-offers/${owner.pricedOfferId}/fare-rules`],
  ];

  /**
   * Checks the 400 of a request with both credentials against the document. The caller guard answers it on every
   * operation (OADR-0009 point 1, architecture §3.1), but eight M2 operations (the reads without a query or body:
   * getStorefront, getAirport, getAirline, getFlightSearch, getFlightOffer, getPricedOffer, getPricedOfferAncillaries,
   * getPricedOfferFareRules) list no 400 response yet; for those the body is checked against the document's BadRequest
   * response (the ErrorResponse of an operation that lists it), which is what the 400 of any operation answers.
   */
  function expectDocumentedRefusal(operationId: OtaOperationId, res: request.Response): void {
    const problems = responseChecker("ota").check(operationId, res);
    const undocumentedStatus = problems.length === 1 && problems[0]?.keyword === "status";
    expectResponseToMatch(undocumentedStatus ? "searchLocations" : operationId, res);
  }

  it("refuse tenant A's API key with tenant B's edge headers with 400 INVALID_REQUEST on every M2 operation [OBE-026 AC1] [OF-01 AC2]", async () => {
    stub.clearRequests();
    for (const [holder, other] of [
      [alpha, beta],
      [beta, alpha],
    ] as const) {
      const target = flowOf(other, "edge");
      for (const key of [holder.sk, holder.pk]) {
        for (const [operationId, method, path, body] of everyOperation(target)) {
          const headers = {
            ...edgeWriteHeaders(other.edgeHost),
            "X-Api-Key": key,
            "Idempotency-Key": idempotencyKey(),
          };
          const res =
            method === "post"
              ? await request(api.server).post(path).set(headers).send(body)
              : await request(api.server).get(path).set(headers);

          expect([
            holder.name,
            operationId,
            res.status,
            res.body.error?.code,
            res.body.error?.details,
          ]).toEqual([holder.name, operationId, 400, "INVALID_REQUEST", { reason: "edge_with_api_key" }]);
          expectDocumentedRefusal(operationId, res);
        }
      }
    }
    // Refused before any tenant was resolved: nothing reached Amadeus.
    expect(stub.requests()).toEqual([]);
  });

  it("resolve only tenant A for tenant A's key with tenant B's host headers and no edge credential [OBE-026 AC1] [OF-01 AC2]", async () => {
    for (const [holder, other] of [
      [alpha, beta],
      [beta, alpha],
    ] as const) {
      const own = flowOf(holder, "key");
      const others = flowOf(other, "key");
      // The storefront's host as Caddy forwards it, and as the HTTP Host header: a key caller's tenant is the key's.
      const atOtherHost = {
        "X-Api-Key": holder.sk,
        "X-Velexis-Host": other.customDomain,
        Host: other.customDomain,
      };

      const storefront = await request(api.server).get("/v1/storefront").set(atOtherHost);
      const ownSearch = await request(api.server).get(`/v1/flight-searches/${own.searchId}`).set(atOtherHost);
      const otherSearch = await request(api.server)
        .get(`/v1/flight-searches/${others.searchId}`)
        .set(atOtherHost);
      const otherPriced = await request(api.server)
        .get(`/v1/priced-offers/${others.pricedOfferId}`)
        .set(atOtherHost);

      expect([holder.name, storefront.status, storefront.body.tenantKey]).toEqual([
        holder.name,
        200,
        holder.name,
      ]);
      expectResponseToMatch("getStorefront", storefront);
      expect([holder.name, ownSearch.status, ownSearch.body.id]).toEqual([holder.name, 200, own.searchId]);
      expectResponseToMatch("getFlightSearch", ownSearch);
      expect([holder.name, otherSearch.status, otherSearch.body.error.code]).toEqual([
        holder.name,
        404,
        "NOT_FOUND",
      ]);
      expectResponseToMatch("getFlightSearch", otherSearch);
      expect([holder.name, otherPriced.status, otherPriced.body.error.code]).toEqual([
        holder.name,
        404,
        "NOT_FOUND",
      ]);
      expectResponseToMatch("getPricedOffer", otherPriced);
    }
  });

  it("refuse tenant A's publishable key from tenant B's storefront origin with 403 ORIGIN_NOT_ALLOWED [OBE-026 AC1] [OF-01 AC2]", async () => {
    for (const [holder, other] of [
      [alpha, beta],
      [beta, alpha],
    ] as const) {
      const foreign = await request(api.server)
        .get("/v1/storefront")
        .set({ "X-Api-Key": holder.pk, Origin: `https://${other.customDomain}` });
      const own = await request(api.server)
        .get("/v1/storefront")
        .set({ "X-Api-Key": holder.pk, Origin: `https://${holder.customDomain}` });

      expect([holder.name, foreign.status, foreign.body.error.code]).toEqual([
        holder.name,
        403,
        "ORIGIN_NOT_ALLOWED",
      ]);
      expectResponseToMatch("getStorefront", foreign);
      expect([holder.name, own.status, own.body.tenantKey]).toEqual([holder.name, 200, holder.name]);
    }
  });

  it("refuse a customer token of tenant A at tenant B with 401, by key and by edge, and accept it at A [OBE-026 AC1] [OF-01 AC2]", async () => {
    const customerId = newId("cus");
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .insertInto("customers")
        .values({ id: customerId, email: `${customerId}@example.com` })
        .execute(),
    );
    const { token } = await tokens.signCustomerToken({ sub: customerId, tid: alpha.id, sid: newId("ses") });
    const betaFlow = flowOf(beta, "key");
    const csrf = newCsrfToken();
    const betaEdgeWrite = {
      ...edgeWriteHeaders(beta.edgeHost, csrf),
      Cookie: `__Host-vx_csrf=${csrf}; __Host-vx_at=${token}`,
      "Idempotency-Key": idempotencyKey(),
    };
    const betaEdgeRead = { ...edgeHeaders(beta.edgeHost), Cookie: `__Host-vx_at=${token}` };
    const betaKey = { "X-Api-Key": beta.sk, Authorization: `Bearer ${token}` };
    stub.clearRequests();
    const logged = api.sink.lines.length;

    const refused: Array<readonly [string, OtaOperationId, request.Response]> = [
      [
        "key",
        "createFlightSearch",
        await request(api.server)
          .post("/v1/flight-searches")
          .set({ ...betaKey, "Idempotency-Key": idempotencyKey() })
          .send(simpleSearch()),
      ],
      [
        "edge",
        "createFlightSearch",
        await request(api.server).post("/v1/flight-searches").set(betaEdgeWrite).send(simpleSearch()),
      ],
      [
        "key",
        "getFlightSearch",
        await request(api.server).get(`/v1/flight-searches/${betaFlow.searchId}`).set(betaKey),
      ],
      [
        "edge",
        "getFlightOffer",
        await request(api.server).get(`/v1/flight-offers/${betaFlow.offerId}`).set(betaEdgeRead),
      ],
      [
        "key",
        "getPricedOffer",
        await request(api.server).get(`/v1/priced-offers/${betaFlow.pricedOfferId}`).set(betaKey),
      ],
      [
        "edge",
        "getPricedOfferFareRules",
        await request(api.server)
          .get(`/v1/priced-offers/${betaFlow.pricedOfferId}/fare-rules`)
          .set(betaEdgeRead),
      ],
    ];
    const atAlpha = await request(api.server)
      .post("/v1/flight-searches")
      .set({ "X-Api-Key": alpha.sk, Authorization: `Bearer ${token}`, "Idempotency-Key": idempotencyKey() })
      .send(simpleSearch());

    for (const [mode, operationId, res] of refused) {
      expect([mode, operationId, res.status, res.body.error.code]).toEqual([
        mode,
        operationId,
        401,
        "UNAUTHENTICATED",
      ]);
      expectResponseToMatch(operationId, res);
    }
    // Refused for its tenant (`tid`): the same token is accepted at alpha, below. The log line names no token.
    const reasons = api.sink
      .records()
      .slice(logged)
      .filter((line) => line["msg"] === "customer.token_refused")
      .map((line) => line["reason"]);
    expect(reasons).toEqual(refused.map(() => "other_tenant"));
    // Nothing of the refused requests reached Amadeus; the token's own tenant searches for its customer.
    expect(stub.requests().filter((entry) => entry.operation === "getFlightOffers")).toHaveLength(1);
    expect([atAlpha.status, atAlpha.body.customerId]).toEqual([201, customerId]);
    expectResponseToMatch("createFlightSearch", atAlpha);
    expect(api.sink.text()).not.toContain(token);
  });
});

describe("the keys dev:seed prints", () => {
  const KEY_TEXT = /\b[ps]k_test_[A-Za-z0-9]{40}\b/g;
  let seeded: { code: number; stdout: string; stderr: string };
  let printed: string[];

  // The platform's dev:seed leaves the test Amadeus account (this file's) with a pool of offices; the OTA's dev:seed
  // then provisions tenant_demo with the real provisioning function, about 3 s here. Budgeted for a loaded runner.
  beforeAll(async () => {
    await migrator
      .insertInto("platform.amadeus_offices")
      .values({ id: newId("amo"), amadeus_account_id: accountId, office_id: "DEV1A0001" })
      .execute();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["dev:seed"], {
      stdout: { write: (chunk: string) => void out.push(chunk) },
      stderr: { write: (chunk: string) => void err.push(chunk) },
      env: {
        APP_ENV: "test",
        LOG_LEVEL: "warn",
        DATABASE_URL: db.urlFor("ota"),
        DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
        DATABASE_MIGRATOR_URL: db.urlFor("migrator"),
        API_KEY_PEPPER_FILE: testApiCredentials().pepperFile,
        STOREFRONT_BASE_DOMAIN: TEST_STOREFRONT_BASE_DOMAIN,
      },
    });
    seeded = { code, stdout: out.join(""), stderr: err.join("") };
    printed = seeded.stdout.match(KEY_TEXT) ?? [];
  }, 120_000);

  it("work once against the API: the publishable key reads the demo storefront, the secret key searches [OBE-026 AC2]", async () => {
    expect([seeded.code, seeded.stderr]).toEqual([0, ""]);
    const publishable = printed.find((key) => key.startsWith("pk_test_")) ?? "";
    const secret = printed.find((key) => key.startsWith("sk_test_")) ?? "";
    expect([publishable.length, secret.length]).toEqual([48, 48]);

    const storefront = await request(api.server).get("/v1/storefront").set({ "X-Api-Key": publishable });
    const search = await request(api.server)
      .post("/v1/flight-searches")
      .set({ "X-Api-Key": secret, "Idempotency-Key": idempotencyKey() })
      .send(simpleSearch());
    const edge = await request(api.server)
      .get("/v1/storefront")
      .set(edgeHeaders(`demo.${TEST_STOREFRONT_BASE_DOMAIN}`));
    // The demo tenant's key is no key of alpha's: alpha's search is not found with it.
    const alphaSearch = await request(api.server)
      .get(`/v1/flight-searches/${flowOf(alpha, "key").searchId}`)
      .set({ "X-Api-Key": secret });

    expect([storefront.status, storefront.body.tenantKey, storefront.body.name]).toEqual([
      200,
      "demo",
      "Demo Travel",
    ]);
    expectResponseToMatch("getStorefront", storefront);
    expect([search.status, search.body.status, search.body.resultCount]).toEqual([201, "completed", 5]);
    expectResponseToMatch("createFlightSearch", search);
    expect([edge.status, edge.body.tenantKey]).toEqual([200, "demo"]);
    expect([alphaSearch.status, alphaSearch.body.error.code]).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("getFlightSearch", alphaSearch);
    // The keys are printed for the developer, never logged by the API that served them.
    expect(api.sink.text()).not.toContain(secret);
    expect(api.sink.text()).not.toContain(publishable);
  });
});
