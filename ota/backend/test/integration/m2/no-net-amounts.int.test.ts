// Selling prices only in customer scope, for every M2 operation of two tenants, against PostgreSQL 16, Redis 7 and the
// Amadeus stub (OBE-026; ota/docs/scope.md OF-02 AC1, ota/docs/flows/search-and-price.md §6, ota/docs/architecture.md
// §9, OADR-0005). The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes
// the platform rows of two tenants as the platform does: their tenants, their own Amadeus test connection (one office
// each) on the Velexis test account the stub accepts, a secret test key each, and for alpha a publishable key (with its
// storefront origin) and a console:automation key. Their settings and default markup rule are seeded as provisioning
// seeds them; alpha sells at net + 10 %, beta at net + 5.00 EUR, so no selling amount equals a net one.
//
// Customer scope is every caller but console scope: the hosted storefront (edge headers), publishable keys, and secret
// keys without `X-Velexis-Scope: console`. Five shopping flows (alpha as the edge, with its publishable and its secret
// key; beta as the edge and with its secret key: every M2 customer operation each) and the console reads of alpha's
// resources run once in `beforeAll` hooks. Every customer-scope answer then goes through the JSON walk of
// test/support/json-walk.ts: no `net*` field, no console-only field (markup, diagnostics, supplier details, the
// verbatim Amadeus dictionaries), no net amount the tenant's tables hold for its offers, and every embedded Amadeus
// offer at its selling price. The console answers are the walk's positive control: they hold all of it. The API runs on
// a pool of ONE connection (the pool-of-one run of db README §5).
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
import { startAmadeusStub, stubScenario, type AmadeusStub } from "@velexis/testing/amadeus";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { Money } from "../../../src/pricing/pricing.types";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
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
import { customerScopeLeaks, findInJson, walkJson, type JsonLeak } from "../../support/json-walk";

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

/** The net grand total of the stub's search fixture's offer 2, the offer the flows open, upsell and price. */
const NET_2 = "98.47";

/** Customer-scope callers: the edge, a publishable key from its storefront origin, a secret key. */
type Mode = "edge" | "publishable" | "secret";

interface Tenant {
  readonly name: "alpha" | "beta";
  readonly schema: "tenant_alpha" | "tenant_beta";
  readonly host: string;
  readonly sellingOf: (net: string) => string;
  readonly modes: readonly Mode[];
  id: string;
  office: string;
  sk: string;
  pk: string;
  console: string;
}

const alpha: Tenant = {
  name: "alpha",
  schema: "tenant_alpha",
  host: `alpha.${TEST_STOREFRONT_BASE_DOMAIN}`,
  sellingOf: (net) => new Money(net).times("1.1").toFixed(2),
  modes: ["edge", "publishable", "secret"],
  id: "",
  office: "",
  sk: "",
  pk: "",
  console: "",
};
const beta: Tenant = {
  name: "beta",
  schema: "tenant_beta",
  host: `beta.${TEST_STOREFRONT_BASE_DOMAIN}`,
  sellingOf: (net) => new Money(net).plus("5.00").toFixed(2),
  modes: ["edge", "secret"],
  id: "",
  office: "",
  sk: "",
  pk: "",
  console: "",
};
const TENANTS: readonly Tenant[] = [alpha, beta];

/** Console scope: a console:automation key that asks for it (OADR-0009 point 4). */
const CONSOLE = Object.freeze({ "X-Velexis-Scope": "console" });

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

/** Issues a test key of a tenant as the platform does: secret (with `scopes`) or publishable (its storefront). */
async function issueKey(tenant: Tenant, kind: "pk" | "sk", scopes: readonly string[] = []): Promise<string> {
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
      ...(kind === "pk" ? { allowed_origins: [`https://${tenant.host}`] } : {}),
      ...(scopes.length === 0 ? {} : { scopes: [...scopes] }),
    })
    .execute();
  return key;
}

/** The platform rows of a tenant (tenant, Amadeus connection, keys) and its seeded settings. */
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
  if (tenant.modes.includes("publishable")) {
    tenant.pk = await issueKey(tenant, "pk");
    tenant.console = await issueKey(tenant, "sk", ["console:automation", "queues:read"]);
  }
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

/** The headers of a customer-scope caller of `tenant` in `mode`; `write` adds what state-changing requests need. */
function credentials(tenant: Tenant, mode: Mode, write: boolean): Record<string, string> {
  const caller =
    mode === "edge"
      ? write
        ? edgeWriteHeaders(tenant.host)
        : edgeHeaders(tenant.host)
      : mode === "publishable"
        ? { "X-Api-Key": tenant.pk, Origin: `https://${tenant.host}` }
        : { "X-Api-Key": tenant.sk };
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
  const search = await call("createFlightSearch", "post", "/v1/flight-searches", {
    ...simpleSearch(),
    resultOptions: { view: "full" },
  });
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
const successOf = (operationId: OtaOperationId): number =>
  operationId === "createFlightSearch" || operationId === "priceFlightOffers" ? 201 : 200;

/** The amounts of an Amadeus offer that a markup changes: grand total, total and base, per offer and traveller. */
function pricedAmounts(offer: unknown): Array<string | undefined> {
  const amadeus = offer as {
    price?: { grandTotal?: string; total?: string; base?: string };
    travelerPricings?: Array<{ price?: { total?: string; base?: string } }>;
  };
  return [
    amadeus.price?.grandTotal,
    amadeus.price?.total,
    amadeus.price?.base,
    ...(amadeus.travelerPricings ?? []).flatMap((traveler) => [traveler.price?.total, traveler.price?.base]),
  ];
}

/** An Amadeus offer embedded in an answer, with the flight offer whose verbatim offer it is a copy of. */
interface EmbeddedOffer {
  readonly pointer: string;
  readonly offerId: string;
  readonly amadeus: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Every Amadeus offer an answer embeds: the `amadeus` of a flight offer (by its `off_` id: search and results in the
 * full view, the offer, a priced offer's `offers`), and the offers of a priced offer's Amadeus exchange (by the priced
 * offer's `offerIds`, in order).
 */
function embeddedOffers(body: unknown): EmbeddedOffer[] {
  const found: EmbeddedOffer[] = [];
  walkJson(body, ({ pointer, value }) => {
    if (!isRecord(value)) {
      return;
    }
    const { id, amadeus, offerIds } = value;
    if (typeof id === "string" && id.startsWith("off_") && isRecord(amadeus)) {
      found.push({ pointer: `${pointer}/amadeus`, offerId: id, amadeus });
    }
    const data = isRecord(amadeus) ? amadeus["data"] : undefined;
    const exchanged = isRecord(data) ? data["flightOffers"] : undefined;
    if (Array.isArray(offerIds) && Array.isArray(exchanged)) {
      exchanged.forEach((offer: unknown, index) => {
        const offerId: unknown = offerIds[index];
        if (typeof offerId === "string") {
          found.push({ pointer: `${pointer}/amadeus/data/flightOffers/${index}`, offerId, amadeus: offer });
        }
      });
    }
  });
  return found;
}

/**
 * What a tenant's tables hold for its offers: the net totals (`net_total` of every flight offer, search and upsell, and
 * of every priced offer: the Amadeus grand totals, `netPrice` in console scope), and the verbatim Amadeus offer of
 * every flight offer by id.
 */
async function storedOf(tenant: Tenant): Promise<{ nets: Set<string>; payloads: Map<string, unknown> }> {
  return await tenantTx(tenantDb, tenant.schema, async (trx) => {
    const offers = await trx.selectFrom("flight_offers").select(["id", "net_total", "payload"]).execute();
    const priced = await trx.selectFrom("priced_offers").select("net_total").execute();
    return {
      nets: new Set([...offers.map((offer) => offer.net_total), ...priced.map((row) => row.net_total)]),
      payloads: new Map(offers.map((offer) => [offer.id, offer.payload])),
    };
  });
}

const flows: Flow[] = [];
const netAmounts = new Map<Tenant, Set<string>>();
/** The verbatim Amadeus offers of every tenant's flight offers, by offer id. */
const payloads = new Map<string, unknown>();
/** Alpha's console-scope reads of the resources of its secret-key flow, by operation. */
const consoleAnswers = new Map<OtaOperationId, request.Response>();
/** A supplier error (the stub's 5xx) in customer and in console scope. */
const supplierErrors = new Map<"customer" | "console", request.Response>();

// Cloning the template, the platform rows, starting the stub and building the API's module graph (Nest, pools, Redis,
// the OTA document's validators) take several seconds alone and much longer on a busy 4-CPU runner: all of it happens
// once here, with its own budget, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of the M2 operations compile on their first check: here, with every status the tests
  // check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const operationId of M2_CUSTOMER_OPERATIONS) {
    for (const status of [successOf(operationId), 502]) {
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
}, OPENAPI_SETUP_TIMEOUT_MS);

// The five customer-scope flows (16 requests each, three of which call the stub), alpha's console reads of the same
// resources (stored data only), then one stub 5xx per scope on full Amadeus buckets (the client retries a read once,
// after 300 to 800 ms). A few seconds here; budgeted for a loaded CI runner.
beforeAll(async () => {
  for (const tenant of TENANTS) {
    for (const mode of tenant.modes) {
      flows.push(await shop(tenant, mode));
    }
    const stored = await storedOf(tenant);
    netAmounts.set(tenant, stored.nets);
    for (const [id, payload] of stored.payloads) {
      payloads.set(id, payload);
    }
  }
  const own = flows.find((flow) => flow.tenant === alpha && flow.mode === "secret");
  if (own === undefined) {
    throw new Error("no secret-key flow of alpha");
  }
  const asConsole = { "X-Api-Key": alpha.console, ...CONSOLE };
  for (const [operationId, path] of [
    ["getFlightSearch", `/v1/flight-searches/${own.searchId}`],
    ["listFlightSearchResults", `/v1/flight-searches/${own.searchId}/offers?view=full&limit=50`],
    ["getFlightOffer", `/v1/flight-offers/${own.offerId}`],
    ["getPricedOffer", `/v1/priced-offers/${own.pricedOfferId}`],
    ["getPricedOfferAncillaries", `/v1/priced-offers/${own.pricedOfferId}/ancillaries`],
  ] as const) {
    consoleAnswers.set(operationId, await request(api.server).get(path).set(asConsole));
  }
  consoleAnswers.set(
    "upsellFlightOffer",
    await request(api.server)
      .post(`/v1/flight-offers/${own.offerId}/upsells`)
      .set({ ...asConsole, "Idempotency-Key": idempotencyKey() })
      .send({}),
  );
  await redis.client.flushdb();
  for (const [scope, key, headers] of [
    ["customer", alpha.sk, {}],
    ["console", alpha.console, CONSOLE],
  ] as const) {
    supplierErrors.set(
      scope,
      await request(api.server)
        .post("/v1/flight-searches")
        .set({
          "X-Api-Key": key,
          "Idempotency-Key": idempotencyKey(),
          ...headers,
          ...stubScenario("server-error"),
        })
        .send(simpleSearch()),
    );
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

/** The leaks of an answer, labelled for the assertion message. */
const leaksOf = (flow: Flow, operationId: OtaOperationId, res: request.Response): JsonLeak[] =>
  customerScopeLeaks(res.body, { netAmounts: netAmounts.get(flow.tenant) ?? [] });

describe("customer scope", () => {
  it("never answers a net field, a console-only field, a net amount or an unrewritten Amadeus price, on any M2 operation [OBE-026 AC2] [OF-02 AC1]", () => {
    expect(flows.map((flow) => `${flow.tenant.name} ${flow.mode}`)).toEqual([
      "alpha edge",
      "alpha publishable",
      "alpha secret",
      "beta edge",
      "beta secret",
    ]);
    // The walk has amounts to look for: the stored net totals of every search, upsell and priced offer.
    expect(netAmounts.get(alpha)).toContain(NET_2);
    expect(netAmounts.get(beta)).toContain(NET_2);
    for (const flow of flows) {
      expect([flow.tenant.name, flow.mode, [...flow.answers.keys()].sort()]).toEqual([
        flow.tenant.name,
        flow.mode,
        [...M2_CUSTOMER_OPERATIONS].sort(),
      ]);
      for (const [operationId, res] of flow.answers) {
        const label = [flow.tenant.name, flow.mode, operationId];
        expect([...label, res.status]).toEqual([...label, successOf(operationId)]);
        expectResponseToMatch(operationId, res);
        expect([...label, leaksOf(flow, operationId, res)]).toEqual([...label, []]);
      }
    }
  });

  it("gets the embedded Amadeus offers rewritten to the tenant's selling price [OBE-026 AC2] [OF-02 AC1]", () => {
    for (const flow of flows) {
      const label = `${flow.tenant.name} ${flow.mode}`;
      const selling = flow.tenant.sellingOf(NET_2);
      const offer = flow.answers.get("getFlightOffer")?.body as {
        price: { total: { amount: string } };
        amadeus: {
          price: { grandTotal: string; total: string };
          travelerPricings: Array<{ price: { total: string } }>;
        };
      };
      expect([
        label,
        offer.price.total.amount,
        offer.amadeus.price.grandTotal,
        offer.amadeus.price.total,
      ]).toEqual([label, selling, selling, selling]);
      expect(offer.amadeus.travelerPricings.map((traveler) => traveler.price.total)).toEqual([selling]);
      const listed = (
        flow.answers.get("listFlightSearchResults")?.body as {
          data: Array<{
            id: string;
            price: { total: { amount: string } };
            amadeus: { price: { grandTotal: string } };
          }>;
        }
      ).data;
      expect(listed.map((entry) => entry.amadeus.price.grandTotal)).toEqual(
        listed.map((entry) => entry.price.total.amount),
      );
      // Offer by offer, in every answer that embeds one, every amount the markup changes (grand total, total and base,
      // per offer and traveller) differs from the verbatim offer the tenant stored.
      const embedded = [...flow.answers].flatMap(([operationId, res]) =>
        embeddedOffers(res.body).map((entry) => ({ operationId, ...entry })),
      );
      expect(new Set(embedded.map((entry) => entry.operationId))).toEqual(
        new Set([
          "createFlightSearch",
          "listFlightSearchResults",
          "getFlightOffer",
          "priceFlightOffers",
          "getPricedOffer",
        ]),
      );
      for (const { operationId, pointer, offerId, amadeus } of embedded) {
        const verbatim = pricedAmounts(payloads.get(offerId));
        expect(verbatim.every((amount) => typeof amount === "string")).toBe(true);
        const kept = pricedAmounts(amadeus).filter((amount, index) => amount === verbatim[index]);
        expect([label, operationId, pointer, kept]).toEqual([label, operationId, pointer, []]);
      }
      const priced = flow.answers.get("priceFlightOffers")?.body as {
        price: { total: { amount: string } };
        amadeus: { data: { flightOffers: Array<{ price: { grandTotal: string } }> } };
      };
      expect([
        label,
        priced.price.total.amount,
        priced.amadeus.data.flightOffers[0]?.price.grandTotal,
      ]).toEqual([label, selling, selling]);
      // The walk saw the rewritten blocks: every listed offer, the opened offer and the priced offers carry one.
      expect(
        findInJson(flow.answers.get("listFlightSearchResults")?.body, ({ key }) => key === "amadeus"),
      ).toHaveLength(listed.length);
    }
  });

  it("gets no supplier details with a supplier error, which console scope does [OBE-026 AC2]", () => {
    const customer = supplierErrors.get("customer");
    const consoleError = supplierErrors.get("console");

    expect([customer?.status, customer?.body.error.code]).toEqual([502, "SUPPLIER_ERROR"]);
    expectResponseToMatch("createFlightSearch", customer ?? { status: 0 });
    expect(customerScopeLeaks(customer?.body)).toEqual([]);
    expect([consoleError?.status, consoleError?.body.error.code]).toEqual([502, "SUPPLIER_ERROR"]);
    expectResponseToMatch("createFlightSearch", consoleError ?? { status: 0 });
    expect(customerScopeLeaks(consoleError?.body)).toContainEqual({
      pointer: "/error/supplier",
      reason: "console_only_field",
    });
  });
});

describe("console scope, the walk's positive control", () => {
  it("answers the net prices, the markups, the supplier diagnostics and the verbatim Amadeus amounts the walk looks for", () => {
    const nets = netAmounts.get(alpha) ?? new Set<string>();
    const leaks = new Map(
      [...consoleAnswers].map(([operationId, res]) => {
        expect([operationId, res.status]).toEqual([operationId, 200]);
        expectResponseToMatch(operationId, res);
        return [operationId, customerScopeLeaks(res.body, { netAmounts: nets })] as const;
      }),
    );

    expect(leaks.get("getFlightSearch")).toContainEqual({
      pointer: "/diagnostics",
      reason: "console_only_field",
    });
    expect(leaks.get("getFlightOffer")).toEqual(
      expect.arrayContaining([
        { pointer: "/netPrice", reason: "net_field" },
        { pointer: "/markup", reason: "console_only_field" },
        { pointer: "/amadeus/price/grandTotal", reason: "net_amount" },
        { pointer: "/amadeus/price/grandTotal", reason: "amadeus_price" },
      ]),
    );
    expect(leaks.get("listFlightSearchResults")).toContainEqual({
      pointer: "/data/0/netPrice",
      reason: "net_field",
    });
    expect(leaks.get("upsellFlightOffer")).toContainEqual({
      pointer: "/offers/0/netPrice",
      reason: "net_field",
    });
    expect(leaks.get("getPricedOffer")).toEqual(
      expect.arrayContaining([
        { pointer: "/netPrice", reason: "net_field" },
        { pointer: "/markup", reason: "console_only_field" },
        { pointer: "/amadeus/data/flightOffers/0/price/grandTotal", reason: "net_amount" },
      ]),
    );
    expect(leaks.get("getPricedOfferAncillaries")).toContainEqual({
      pointer: "/checkedBags/0/netPrice",
      reason: "net_field",
    });
    expect(
      (consoleAnswers.get("getFlightOffer")?.body as { netPrice: { amount: string } }).netPrice.amount,
    ).toBe(NET_2);
    // The offer-by-offer comparison of customer scope finds the verbatim amounts where console scope gets them.
    const reads: readonly OtaOperationId[] = ["getFlightOffer", "listFlightSearchResults", "getPricedOffer"];
    const verbatimOffers = reads.flatMap((operationId) =>
      embeddedOffers(consoleAnswers.get(operationId)?.body),
    );
    expect(verbatimOffers).toHaveLength(1 + 5 + 2);
    for (const { pointer, offerId, amadeus } of verbatimOffers) {
      expect([pointer, pricedAmounts(amadeus)]).toEqual([pointer, pricedAmounts(payloads.get(offerId))]);
    }
  });

  it("flags every kind of leak it knows, also those no console answer of the stub carries", () => {
    const answer = {
      data: [
        {
          price: { total: { amount: "108.32" } },
          amadeus: { price: { grandTotal: "98.47", margins: [] } },
          network: "net-named key",
        },
      ],
      dictionaries: { amadeus: {}, carriers: {} },
      error: { supplierRequestId: "sup_1" },
      "a/b~c": { markupRuleId: "mkr_1" },
      taxes: "42.47",
    };

    expect(customerScopeLeaks(answer, { netAmounts: [NET_2] })).toEqual([
      { pointer: "/data/0/amadeus/price/grandTotal", reason: "amadeus_price" },
      { pointer: "/data/0/amadeus/price/grandTotal", reason: "net_amount" },
      { pointer: "/data/0/amadeus/price/margins", reason: "console_only_field" },
      { pointer: "/data/0/network", reason: "net_field" },
      { pointer: "/dictionaries/amadeus", reason: "console_only_field" },
      { pointer: "/error/supplierRequestId", reason: "console_only_field" },
      { pointer: "/a~1b~0c/markupRuleId", reason: "console_only_field" },
    ]);
    // The verbatim Amadeus block outside `dictionaries` is the rewritten offer, not a leak by itself.
    expect(customerScopeLeaks({ amadeus: { id: "2" }, dictionaries: { carriers: {} } })).toEqual([]);
  });
});
