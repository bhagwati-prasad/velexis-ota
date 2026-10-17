// The M2 namespaces `storefront`, `reference` and `flights` (task SDK-005, ota/sdk/README.md §5.2,
// docs/velexis-sdk/sdk/src/identity.d.ts and flights.d.ts, guides B1 and B2): every method is named exactly by its
// `x-sdk-method` and sends the request its route-table entry describes (method, path, query, headers, body);
// `flights.search`, `.upsell` and `.price` wait 60 s; the deferred `storefront.resolve` and `flights.availability`
// surface `501 NOT_IMPLEMENTED` as a `ServerError`; the namespace types are inferred from the factories without `any`.
// The canned responses come from test/fixtures/, which are checked against the working OpenAPI document with the Ajv
// helper of @velexis/testing, so the fake answers cannot drift from the contract. Requests go to the fake fetch only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ConnectionError,
  Page,
  PriceChangedError,
  ServerError,
  createVelexisClient,
} from "../../src/index.js";
import { op } from "../../src/internal/operations.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

/** Fake keys with the right shapes; none of them works anywhere. */
const SK = "sk_test_sdk005_fake_secret";
const PK = "pk_test_sdk005_fake";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BASE_URL = "https://api.ota.example.com";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** @param {string} name a file of test/fixtures/ */
const fixture = (name) => JSON.parse(readFileSync(join(SDK_ROOT, "test", "fixtures", name), "utf8"));

/** `GET /v1/storefront` (getStorefront, 200). */
const STOREFRONT = fixture("storefront.json");
/** `POST /v1/flight-searches` (createFlightSearch, 201): a completed search with its first page. */
const FLIGHT_SEARCH = fixture("flight-search.json");

const SEARCH_ID = FLIGHT_SEARCH.id;
const OFFER_ID = FLIGHT_SEARCH.offers[0].id;
const PRICED_OFFER_ID = "prc_01JA4CB2X6M9Q3T7V1Y5A8D2G4";

/**
 * A page of `flights.listResults` (listFlightSearchResults, 200) built from the search fixture.
 * @param {string | null} nextCursor
 */
const resultsPage = (nextCursor) => ({
  data: FLIGHT_SEARCH.offers,
  page: { nextCursor, limit: 1 },
  searchId: SEARCH_ID,
  currency: FLIGHT_SEARCH.currency,
  total: 2,
  sort: "price",
  facets: FLIGHT_SEARCH.facets,
  dictionaries: FLIGHT_SEARCH.dictionaries,
  expiresAt: FLIGHT_SEARCH.expiresAt,
});

/** The 18 methods of the M2 namespaces: their `x-sdk-method`, as the contract names them (identity.d.ts, flights.d.ts). */
const M2_METHODS = [
  "storefront.get",
  "storefront.resolve",
  "reference.locations.search",
  "reference.airports.get",
  "reference.airlines.list",
  "reference.airlines.get",
  "reference.countries.list",
  "reference.currencies.list",
  "flights.search",
  "flights.getSearch",
  "flights.listResults",
  "flights.getOffer",
  "flights.upsell",
  "flights.availability",
  "flights.price",
  "flights.getPricedOffer",
  "flights.getAncillaries",
  "flights.getFareRules",
];

/** @typedef {import("../../src/index.js").VelexisClient} VelexisClient */

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The dotted names of every function reachable from the namespaces of a client.
 * @param {Record<string, unknown>} client
 */
function methodNamesOf(client) {
  /** @type {string[]} */
  const names = [];
  /** @param {unknown} value @param {string} path */
  const walk = (value, path) => {
    if (typeof value === "function") {
      names.push(path);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(child, `${path}.${key}`);
      }
    }
  };
  for (const namespace of ["storefront", "reference", "flights"]) {
    walk(client[namespace], namespace);
  }
  return names;
}

/**
 * One method called with sample parameters, and the request it must send.
 * @typedef {object} RouteCase
 * @property {string} method the `x-sdk-method`
 * @property {(client: VelexisClient) => Promise<unknown>} call
 * @property {"GET" | "POST"} http
 * @property {string} path the path with its parameters filled in
 * @property {[string, string][]} query the decoded query parameters, in order
 * @property {Record<string, unknown>} [body] the JSON body; none when absent
 * @property {Record<string, string>} [headers] headers the call must carry besides the common ones
 * @property {number} [status] the canned status (200 by default)
 * @property {unknown} [response] the canned body (`{ method }` by default)
 */

/** A SIMPLE search, the B2 §2 example. */
const SIMPLE_SEARCH = {
  mode: "simple",
  originLocationCode: "PAR",
  destinationLocationCode: "NYC",
  departureDate: "2026-11-20",
  returnDate: "2026-11-27",
  adults: 1,
  children: 1,
  travelClass: "ECONOMY",
  nonStop: false,
  currencyCode: "EUR",
  resultOptions: { limit: 20, sort: "best", view: "summary" },
};

/** @type {RouteCase[]} */
const CASES = [
  {
    method: "storefront.get",
    call: (client) => client.storefront.get({ locale: "fr-FR" }),
    http: "GET",
    path: "/v1/storefront",
    query: [],
    headers: { "accept-language": "fr-FR" },
    response: STOREFRONT,
  },
  {
    method: "storefront.resolve",
    call: (client) => client.storefront.resolve({ host: "www.acmetravel.com" }),
    http: "GET",
    path: "/v1/storefront/resolve",
    query: [["host", "www.acmetravel.com"]],
  },
  {
    method: "reference.locations.search",
    call: (client) =>
      client.reference.locations.search({
        keyword: "par",
        subType: ["AIRPORT", "CITY"],
        countryCode: "FR",
        cursor: "cur_1",
        limit: 8,
      }),
    http: "GET",
    path: "/v1/reference/locations",
    query: [
      ["keyword", "par"],
      ["subType", "AIRPORT,CITY"],
      ["countryCode", "FR"],
      ["cursor", "cur_1"],
      ["limit", "8"],
    ],
  },
  {
    method: "reference.airports.get",
    call: (client) => client.reference.airports.get({ iataCode: "LHR" }),
    http: "GET",
    path: "/v1/reference/airports/LHR",
    query: [],
  },
  {
    method: "reference.airlines.list",
    call: (client) => client.reference.airlines.list({ iataCodes: ["BA", "U2"], limit: 100 }),
    http: "GET",
    path: "/v1/reference/airlines",
    query: [
      ["iataCodes", "BA,U2"],
      ["limit", "100"],
    ],
  },
  {
    method: "reference.airlines.get",
    call: (client) => client.reference.airlines.get({ iataCode: "BA" }),
    http: "GET",
    path: "/v1/reference/airlines/BA",
    query: [],
  },
  {
    method: "reference.countries.list",
    call: (client) => client.reference.countries.list({ cursor: "cur_2", limit: 50 }),
    http: "GET",
    path: "/v1/reference/countries",
    query: [
      ["cursor", "cur_2"],
      ["limit", "50"],
    ],
  },
  {
    method: "reference.currencies.list",
    call: (client) => client.reference.currencies.list(),
    http: "GET",
    path: "/v1/reference/currencies",
    query: [],
  },
  {
    method: "flights.search",
    call: (client) => client.flights.search(SIMPLE_SEARCH),
    http: "POST",
    path: "/v1/flight-searches",
    query: [],
    body: SIMPLE_SEARCH,
    status: 201,
    response: FLIGHT_SEARCH,
  },
  {
    method: "flights.getSearch",
    call: (client) => client.flights.getSearch({ searchId: SEARCH_ID }),
    http: "GET",
    path: `/v1/flight-searches/${SEARCH_ID}`,
    query: [],
  },
  {
    method: "flights.listResults",
    call: (client) =>
      client.flights.listResults({
        searchId: SEARCH_ID,
        stops: [0, 1],
        carriers: ["AF", "KL"],
        minPrice: "100.00",
        maxPrice: "1500",
        departureWindow: ["0:06:00-11:59", "0:18:00-23:59"],
        arrivalWindow: ["1:18:00-23:59"],
        maxDurationMinutes: 900,
        cabins: ["ECONOMY", "BUSINESS"],
        minIncludedCheckedBags: 1,
        refundable: true,
        changeable: false,
        brandedFares: ["LIGHT", "STANDARD"],
        sort: "price",
        view: "full",
        cursor: "cur_3",
        limit: 20,
      }),
    http: "GET",
    path: `/v1/flight-searches/${SEARCH_ID}/offers`,
    query: [
      ["stops", "0,1"],
      ["carriers", "AF,KL"],
      ["minPrice", "100.00"],
      ["maxPrice", "1500"],
      ["departureWindow", "0:06:00-11:59,0:18:00-23:59"],
      ["arrivalWindow", "1:18:00-23:59"],
      ["maxDurationMinutes", "900"],
      ["cabins", "ECONOMY,BUSINESS"],
      ["minIncludedCheckedBags", "1"],
      ["refundable", "true"],
      ["changeable", "false"],
      ["brandedFares", "LIGHT,STANDARD"],
      ["sort", "price"],
      ["view", "full"],
      ["cursor", "cur_3"],
      ["limit", "20"],
    ],
    response: resultsPage(null),
  },
  {
    method: "flights.getOffer",
    call: (client) => client.flights.getOffer({ offerId: OFFER_ID }),
    http: "GET",
    path: `/v1/flight-offers/${OFFER_ID}`,
    query: [],
  },
  {
    method: "flights.upsell",
    call: (client) =>
      client.flights.upsell({
        offerId: OFFER_ID,
        combineWithOfferIds: ["off_01JA4C8Q2H6K9M3P5S8U1W4Y7B"],
        payments: [{ brand: "VISA", bin: "411111" }],
      }),
    http: "POST",
    path: `/v1/flight-offers/${OFFER_ID}/upsells`,
    query: [],
    body: {
      combineWithOfferIds: ["off_01JA4C8Q2H6K9M3P5S8U1W4Y7B"],
      payments: [{ brand: "VISA", bin: "411111" }],
    },
  },
  {
    method: "flights.availability",
    call: (client) =>
      client.flights.availability({
        query: {
          originDestinations: [
            {
              id: "1",
              originLocationCode: "CDG",
              destinationLocationCode: "JFK",
              departureDateTime: { date: "2026-11-20" },
            },
          ],
          travelers: [{ id: "1", travelerType: "ADULT" }],
          sources: ["GDS"],
        },
      }),
    http: "POST",
    path: "/v1/flight-availabilities",
    query: [],
    body: {
      query: {
        originDestinations: [
          {
            id: "1",
            originLocationCode: "CDG",
            destinationLocationCode: "JFK",
            departureDateTime: { date: "2026-11-20" },
          },
        ],
        travelers: [{ id: "1", travelerType: "ADULT" }],
        sources: ["GDS"],
      },
    },
    headers: { "x-velexis-environment": "test" },
  },
  {
    method: "flights.price",
    call: (client) =>
      client.flights.price({
        offerIds: [OFFER_ID],
        include: ["bags", "other-services"],
        expectedTotal: { amount: "1240.56", currency: "EUR" },
      }),
    http: "POST",
    path: "/v1/priced-offers",
    query: [],
    body: {
      offerIds: [OFFER_ID],
      include: ["bags", "other-services"],
      expectedTotal: { amount: "1240.56", currency: "EUR" },
    },
    status: 201,
  },
  {
    method: "flights.getPricedOffer",
    call: (client) => client.flights.getPricedOffer({ pricedOfferId: PRICED_OFFER_ID }),
    http: "GET",
    path: `/v1/priced-offers/${PRICED_OFFER_ID}`,
    query: [],
  },
  {
    method: "flights.getAncillaries",
    call: (client) => client.flights.getAncillaries({ pricedOfferId: PRICED_OFFER_ID }),
    http: "GET",
    path: `/v1/priced-offers/${PRICED_OFFER_ID}/ancillaries`,
    query: [],
  },
  {
    method: "flights.getFareRules",
    call: (client) => client.flights.getFareRules({ pricedOfferId: PRICED_OFFER_ID }),
    http: "GET",
    path: `/v1/priced-offers/${PRICED_OFFER_ID}/fare-rules`,
    query: [],
  },
];

describe("the fixtures", () => {
  /**
   * Parsing the OTA document and compiling the response schemas with Ajv takes about a second alone and much longer
   * while Turborepo runs every package's tests at once on a CI runner; the hook warms the helper's cache within its own
   * budget, so the tests below only run the compiled validators.
   */
  beforeAll(() => {
    const checker = responseChecker("ota");
    checker.check("getStorefront", { status: 200, body: STOREFRONT });
    checker.check("createFlightSearch", { status: 201, body: FLIGHT_SEARCH });
    checker.check("listFlightSearchResults", { status: 200, body: resultsPage(null) });
  }, 60_000);

  it("are response bodies of the working OpenAPI document, checked with the Ajv helper of @velexis/testing [SDK-005 AC1]", () => {
    expect(() => expectResponseToMatch("getStorefront", { status: 200, body: STOREFRONT })).not.toThrow();
    expect(() =>
      expectResponseToMatch("createFlightSearch", { status: 201, body: FLIGHT_SEARCH }),
    ).not.toThrow();
    for (const nextCursor of ["cur_2", null]) {
      expect(() =>
        expectResponseToMatch("listFlightSearchResults", { status: 200, body: resultsPage(nextCursor) }),
      ).not.toThrow();
    }
    expect(FLIGHT_SEARCH).toMatchObject({ status: "completed", page: { limit: 20 } });
    expect(FLIGHT_SEARCH.offers.length).toBeGreaterThan(0);
  });

  it("hold no secret key and no supplier net amounts [SDK-005 AC1]", () => {
    const text = JSON.stringify([STOREFRONT, FLIGHT_SEARCH]);
    expect(text).not.toMatch(/\b(?:sk|hk|rk)_(?:test|live)_/);
    expect(text).not.toMatch(/"(?:netPrice|markup|diagnostics)"/);
  });
});

describe("the M2 namespaces", () => {
  // The exact method set of the client against the document is the parity test's (SDK-006, with its pending list):
  // later tasks add methods to these namespaces (storefront.listPages and .getPage, SDK-012). Here every M2 method
  // must be there, and every method of these namespaces must be named by an x-sdk-method of the route table.
  it("offer every M2 method of the contract, each named by its x-sdk-method in the route table [SDK-005 AC1]", () => {
    const client = createVelexisClient({ publishableKey: PK, fetch: createFakeFetch().fetch });
    const names = methodNamesOf(client);

    expect(Object.keys(client)).toEqual(expect.arrayContaining(["storefront", "reference", "flights"]));
    expect(names).toEqual(expect.arrayContaining(M2_METHODS));
    for (const method of names) {
      expect(op, method).toHaveProperty(method.replaceAll(".", "_"));
    }
    expect(CASES.map((testCase) => testCase.method).sort()).toEqual([...M2_METHODS].sort());
  });

  it("are rebuilt by withOptions on the new client's options [SDK-005 AC1]", async () => {
    const fake = createFakeFetch([{ body: { data: [], page: { nextCursor: null, limit: 50 } } }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch, locale: "en-GB" });

    await client.withOptions({ locale: "de-DE" }).reference.countries.list({ limit: 50 });

    expect(fake.requests[0]?.headers["accept-language"]).toBe("de-DE");
    expect(methodNamesOf(client.withOptions({ currency: "EUR" })).sort()).toEqual(
      methodNamesOf(client).sort(),
    );
  });
});

describe("each M2 method sends the request of its route-table entry", () => {
  it.each(CASES)("$method → $http $path [SDK-005 AC1]", async (testCase) => {
    const key = /** @type {keyof typeof op} */ (testCase.method.replaceAll(".", "_"));
    const entry = op[key];
    const response = testCase.response ?? { method: testCase.method };
    const fake = createFakeFetch([{ status: testCase.status ?? 200, body: response }]);
    // A server-mode client with an environment: only the operations that declare X-Velexis-Environment may send it.
    const client = createVelexisClient({ secretKey: SK, environment: "test", fetch: fake.fetch });

    const result = await testCase.call(client);

    expect(fake.requests).toHaveLength(1);
    const request = /** @type {import("../helpers/fake-fetch.js").RecordedRequest} */ (fake.requests[0]);
    // The route table: method, path template and query parameter names (in the table's order).
    expect(request.method).toBe(testCase.http);
    expect(entry.method).toBe(testCase.http);
    expect(testCase.path).toMatch(new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, "[^/]+")}$`));
    expect(request.url.split("?")[0]).toBe(`${BASE_URL}${testCase.path}`);
    expect([...request.searchParams]).toEqual(testCase.query);
    const queryNames = testCase.query.map(([name]) => name);
    expect(entry.queryParams.filter((name) => queryNames.includes(name))).toEqual(queryNames);
    // Arrays are comma-separated with the commas themselves unencoded (style form, explode false).
    expect(request.url).not.toMatch(/%2C/i);
    // The body: the params that are not path, query or header params, as JSON; none for a GET.
    if (testCase.body === undefined) {
      expect(request.body).toBeNull();
      expect(request.headers).not.toHaveProperty("content-type");
    } else {
      expect(request.json).toEqual(testCase.body);
      expect(request.headers["content-type"]).toBe("application/json");
    }
    // The headers: the key, JSON, one generated Idempotency-Key where the operation takes one, the environment
    // header only where the operation declares it, and the case's own headers.
    expect(request.headers).toMatchObject({
      accept: "application/json",
      "x-api-key": SK,
      ...testCase.headers,
    });
    if (entry.idempotency === "none") {
      expect(request.headers).not.toHaveProperty("idempotency-key");
    } else {
      expect(request.headers["idempotency-key"]).toMatch(UUID_V4);
    }
    expect(request.headers["x-velexis-environment"]).toBe(entry.environment ? "test" : undefined);
    expect(Boolean(testCase.headers?.["x-velexis-environment"])).toBe(entry.environment);
    // The fetch cache mode: flights are live and priced (no-store), storefront and reference are the caller's choice.
    expect(request.init.cache).toBe(testCase.method.startsWith("flights.") ? "no-store" : undefined);
    // The result: the response body, or a Page of it for a list operation.
    if (
      entry.queryParams.includes("cursor") &&
      Array.isArray(/** @type {{ data?: unknown }} */ (response).data)
    ) {
      expect(result).toBeInstanceOf(Page);
      expect(JSON.parse(JSON.stringify(result))).toEqual(response);
    } else {
      expect(result).toEqual(response);
    }
  });

  it("send the client's publishable key and no environment header in token mode [SDK-005 AC1]", async () => {
    const fake = createFakeFetch([{ status: 201, body: FLIGHT_SEARCH }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    await expect(client.flights.search(SIMPLE_SEARCH)).resolves.toEqual(FLIGHT_SEARCH);

    expect(fake.requests[0]?.headers).toMatchObject({ "x-api-key": PK });
    expect(fake.requests[0]?.headers).not.toHaveProperty("x-velexis-environment");
    expect(fake.requests[0]?.init.credentials).toBe("omit");
  });

  it("work in cookie mode: same-origin /api paths, the CSRF header on writes and no key [SDK-005 AC1]", async () => {
    vi.stubGlobal("document", { cookie: "__Host-vx_csrf=csrf_sdk005_fake" });
    const fake = createFakeFetch([{ body: STOREFRONT }, { status: 201, body: FLIGHT_SEARCH }]);
    const client = createVelexisClient({ session: "cookie", fetch: fake.fetch });

    await client.storefront.get();
    await client.flights.search(SIMPLE_SEARCH);

    expect(fake.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /api/v1/storefront",
      "POST /api/v1/flight-searches",
    ]);
    expect(fake.requests[0]?.headers).not.toHaveProperty("x-csrf-token");
    expect(fake.requests[1]?.headers["x-csrf-token"]).toBe("csrf_sdk005_fake");
    for (const request of fake.requests) {
      expect(request.headers).not.toHaveProperty("x-api-key");
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.init).toMatchObject({ credentials: "same-origin", mode: "same-origin" });
    }
  });

  it("refuse invalid params and options with a TypeError before any request [SDK-005 AC1]", async () => {
    const fake = createFakeFetch();
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    await expect(client.storefront.get(/** @type {never} */ ("fr-FR"))).rejects.toThrow(
      new TypeError("Velexis SDK: the params of GET /v1/storefront must be an object"),
    );
    await expect(client.flights.search(SIMPLE_SEARCH, /** @type {never} */ ("x"))).rejects.toThrow(
      new TypeError("Velexis SDK: request option must be an object"),
    );
    await expect(client.storefront.get({ locale: /** @type {never} */ (42) })).rejects.toThrow(
      /request option "locale" must be a non-empty string/,
    );
    await expect(client.flights.getOffer(/** @type {never} */ ({}))).rejects.toThrow(
      new TypeError('Velexis SDK: GET /v1/flight-offers/{offerId} needs the path parameter "offerId"'),
    );
    await expect(client.reference.airports.get({ iataCode: ".." })).rejects.toThrow(
      /cannot be "\." or "\.\."/,
    );
    // Options that are not a plain object are refused as by every other method, also where the namespace adds its
    // defaults (the cache mode of flights, the locale shortcut of storefront.get): copying them into a plain object
    // would accept them and silently drop what they inherit, such as a signal.
    const signal = new AbortController().signal;
    for (const options of [new Map(), Object.create({ signal })]) {
      await expect(client.flights.getOffer({ offerId: OFFER_ID }, options)).rejects.toThrow(
        new TypeError("Velexis SDK: request option must be an object"),
      );
      await expect(client.storefront.get({ locale: "fr-FR" }, options)).rejects.toThrow(
        new TypeError("Velexis SDK: request option must be an object"),
      );
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("storefront.get", () => {
  it("takes params.locale as the contract's shortcut for options.locale; the call's options win [SDK-005 AC1]", async () => {
    const fake = createFakeFetch([{ body: STOREFRONT }, { body: STOREFRONT }, { body: STOREFRONT }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch, locale: "en-GB" });

    await client.storefront.get({ locale: "fr-FR" }, { headers: { "If-None-Match": '"12-fr"' } });
    await client.storefront.get({ locale: "fr-FR" }, { locale: "de-DE" });
    await client.storefront.get();

    expect(fake.requests.map((request) => request.headers["accept-language"])).toEqual([
      "fr-FR",
      "de-DE",
      "en-GB",
    ]);
    expect(fake.requests[0]?.headers["if-none-match"]).toBe('"12-fr"');
    expect(fake.requests.map((request) => request.url)).toEqual(Array(3).fill(`${BASE_URL}/v1/storefront`));
  });
});

describe("the fetch cache mode", () => {
  it("is no-store on flights unless the call chooses cache or next, and the caller's on storefront and reference [SDK-005 AC1]", async () => {
    const fake = createFakeFetch(Array.from({ length: 6 }, () => ({ body: {} })));
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    await client.flights.getOffer({ offerId: OFFER_ID });
    await client.flights.getOffer({ offerId: OFFER_ID }, { cache: "force-cache" });
    await client.flights.getOffer({ offerId: OFFER_ID }, { next: { tags: ["offer"] } });
    await client.storefront.get({}, { next: { revalidate: 300, tags: ["velexis:storefront"] } });
    await client.reference.airports.get({ iataCode: "LHR" });
    await client.reference.airports.get({ iataCode: "LHR" }, { cache: "no-cache" });

    expect(
      fake.requests.map((request) => [
        request.init.cache,
        /** @type {{ next?: unknown }} */ (request.init).next,
      ]),
    ).toEqual([
      ["no-store", undefined],
      ["force-cache", undefined],
      [undefined, { tags: ["offer"] }],
      [undefined, { revalidate: 300, tags: ["velexis:storefront"] }],
      [undefined, undefined],
      ["no-cache", undefined],
    ]);
  });
});

describe("list methods", () => {
  it("resolve flights.listResults with a page that keeps facets and follows the cursor with the same filters [SDK-005 AC1]", async () => {
    const fake = createFakeFetch([{ body: resultsPage("cur_2") }, { body: resultsPage(null) }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    const page = await client.flights.listResults({
      searchId: SEARCH_ID,
      stops: [0],
      sort: "price",
      limit: 1,
    });

    expect(page).toBeInstanceOf(Page);
    expect(page).toMatchObject({
      searchId: SEARCH_ID,
      currency: "EUR",
      total: 2,
      sort: "price",
      facets: FLIGHT_SEARCH.facets,
      expiresAt: FLIGHT_SEARCH.expiresAt,
      page: { nextCursor: "cur_2", limit: 1 },
    });
    /** @type {string[]} */
    const ids = [];
    for await (const offer of page) {
      ids.push(offer.id);
    }
    expect(ids).toEqual([OFFER_ID, OFFER_ID]);
    expect(fake.requests.map((request) => [...request.searchParams])).toEqual([
      [
        ["stops", "0"],
        ["sort", "price"],
        ["limit", "1"],
      ],
      [
        ["stops", "0"],
        ["sort", "price"],
        ["cursor", "cur_2"],
        ["limit", "1"],
      ],
    ]);
    expect(fake.requests.map((request) => request.init.cache)).toEqual(["no-store", "no-store"]);
  });

  it("resolve every reference list with a Page whose next() keeps the params [SDK-005 AC1]", async () => {
    const empty = { body: { data: [], page: { nextCursor: null, limit: 5 } } };
    const fake = createFakeFetch([
      { body: { data: [], page: { nextCursor: "cur_9", limit: 5 } } },
      empty,
      empty,
      empty,
      empty,
    ]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    const first = await client.reference.locations.search({ keyword: "lon", subType: ["CITY"], limit: 5 });
    const second = await first.next();
    const pages = [
      second,
      await client.reference.airlines.list(),
      await client.reference.countries.list(),
      await client.reference.currencies.list({ limit: 5 }),
    ];

    for (const page of [first, ...pages]) {
      expect(page).toBeInstanceOf(Page);
    }
    expect(await second?.next()).toBeNull();
    expect([...(fake.requests[1]?.searchParams ?? [])]).toEqual([
      ["keyword", "lon"],
      ["subType", "CITY"],
      ["cursor", "cur_9"],
      ["limit", "5"],
    ]);
  });
});

describe("errors of the M2 methods", () => {
  it("flights.price throws PriceChangedError with the stored priced offer id [SDK-005 AC1]", async () => {
    const fake = createFakeFetch([
      errorResponse(409, "PRICE_CHANGED", {
        details: {
          oldPrice: { amount: "1240.56", currency: "EUR" },
          newPrice: { amount: "1302.10", currency: "EUR" },
          pricedOfferId: PRICED_OFFER_ID,
        },
      }),
    ]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    const error = await client.flights
      .price({ offerIds: [OFFER_ID], expectedTotal: { amount: "1240.56", currency: "EUR" } })
      .catch((/** @type {unknown} */ caught) => caught);

    expect(error).toBeInstanceOf(PriceChangedError);
    expect(error).toMatchObject({
      code: "PRICE_CHANGED",
      pricedOfferId: PRICED_OFFER_ID,
      newPrice: { amount: "1302.10", currency: "EUR" },
    });
    expect(fake.requests).toHaveLength(1);
  });
});

describe("timeouts of the M2 methods", () => {
  /**
   * Starts a call whose answer never comes and reports when its request is aborted.
   * @param {(client: VelexisClient) => Promise<unknown>} call
   * @param {Partial<import("../../src/index.js").VelexisClientOptions>} [options]
   */
  async function abortTimeOf(call, options = {}) {
    vi.useFakeTimers();
    const fake = createFakeFetch([{ delayMs: Infinity }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch, ...options });
    const pending = call(client).catch((/** @type {unknown} */ error) => error);
    let elapsed = 0;
    while (!(fake.requests[0]?.signal?.aborted ?? false) && elapsed < 120_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      elapsed += 1_000;
    }
    return { elapsed, error: await pending, requests: fake.requests.length };
  }

  it.each([
    ["flights.search", (/** @type {VelexisClient} */ client) => client.flights.search(SIMPLE_SEARCH)],
    ["flights.upsell", (/** @type {VelexisClient} */ client) => client.flights.upsell({ offerId: OFFER_ID })],
    [
      "flights.price",
      (/** @type {VelexisClient} */ client) => client.flights.price({ offerIds: [OFFER_ID] }),
    ],
  ])(
    "%s waits 60 s, not the client's 30 s, and the timeout is not retried [SDK-005 AC2]",
    async (_name, call) => {
      const { elapsed, error, requests } = await abortTimeOf(call, { timeoutMs: 30_000 });

      expect(elapsed).toBe(60_000);
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error).toMatchObject({ code: "TIMEOUT", status: 0, retryable: true });
      expect(requests).toBe(1);
    },
  );

  it("flights.search aborts at exactly 60 000 ms [SDK-005 AC2]", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch([{ delayMs: Infinity }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    const pending = client.flights.search(SIMPLE_SEARCH).catch((/** @type {unknown} */ error) => error);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.requests[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toMatchObject({ code: "TIMEOUT" });
    expect(fake.requests).toHaveLength(1);
  });

  it("the other methods use the client's timeout, and options.timeoutMs wins over the table [SDK-005 AC2]", async () => {
    const getSearch = await abortTimeOf((client) => client.flights.getSearch({ searchId: SEARCH_ID }));
    const storefront = await abortTimeOf((client) => client.storefront.get(), { timeoutMs: 10_000 });
    const shorter = await abortTimeOf((client) => client.flights.search(SIMPLE_SEARCH, { timeoutMs: 5_000 }));

    expect([getSearch.elapsed, storefront.elapsed, shorter.elapsed]).toEqual([30_000, 10_000, 5_000]);
    for (const result of [getSearch, storefront, shorter]) {
      expect(result.error).toMatchObject({ code: "TIMEOUT" });
    }
  });
});

describe("deferred M2 methods", () => {
  it.each([
    [
      "storefront.resolve",
      (/** @type {VelexisClient} */ client) => client.storefront.resolve({ host: "www.acmetravel.com" }),
    ],
    [
      "flights.availability",
      (/** @type {VelexisClient} */ client) => client.flights.availability({ query: {} }),
    ],
  ])(
    "%s surfaces 501 as a ServerError with code NOT_IMPLEMENTED, sent once [SDK-005 AC2]",
    async (_name, call) => {
      const fake = createFakeFetch([
        errorResponse(501, "NOT_IMPLEMENTED", {
          message: "This operation is not available yet.",
          details: { milestone: "deferred" },
        }),
      ]);
      const client = createVelexisClient({ secretKey: SK, fetch: fake.fetch, maxRetries: 2 });

      const error = await call(client).catch((/** @type {unknown} */ caught) => caught);

      expect(error).toBeInstanceOf(ServerError);
      expect(error).toMatchObject({
        name: "ServerError",
        code: "NOT_IMPLEMENTED",
        status: 501,
        retryable: false,
        details: { milestone: "deferred" },
      });
      expect(fake.requests).toHaveLength(1);
    },
  );
});

describe("the namespace types", () => {
  const NAMESPACE_FILES = ["storefront.js", "reference.js", "flights.js"].map((name) =>
    join(SDK_ROOT, "src", "namespaces", name),
  );
  const PUBLIC_FILES = ["identity.js", "flights.js", "index.js"].map((name) => join(SDK_ROOT, "src", name));
  const FACTORIES = [
    ["storefront.js", "createStorefrontApi", "storefront"],
    ["reference.js", "createReferenceApi", "reference"],
    ["flights.js", "createFlightsApi", "flights"],
  ];

  /** @type {string[]} */
  const diagnostics = [];
  /** @type {{ name: string, types: string[], loose: boolean }[]} */
  const signatures = [];
  /**
   * Per public module: its typedef names in source order, and the type names its contract file exports, in order.
   * @type {Record<string, { sdk: string[], contract: string[] }>}
   */
  const mirrors = {};
  /** @type {string[]} the names the package root exports */
  const rootExports = [];
  /** @type {Map<string, string>} the text of each namespace file, as the program read it */
  const namespaceSources = new Map();

  /** Whether a type is `any` or `unknown`. @param {ts.Type} type */
  const isLoose = (type) => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;

  /**
   * Building the program reads the generated OTA types (several MB of declarations) and the DOM library: a few seconds
   * alone, and much more while Turborepo runs every package's tests at once on a CI runner, so the hook gets its own
   * budget instead of Vitest's 10 s default.
   */
  beforeAll(() => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(SDK_ROOT, "tsconfig.json"),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        },
      },
    );
    if (!parsed) {
      throw new Error("tsconfig.json could not be read");
    }
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();
    for (const file of [...NAMESPACE_FILES, ...PUBLIC_FILES]) {
      const source = program.getSourceFile(file);
      if (source === undefined) {
        throw new Error(`${file} is not part of the SDK's type check`);
      }
      if (NAMESPACE_FILES.includes(file)) {
        namespaceSources.set(file, source.text);
      }
      for (const diagnostic of [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source),
      ]) {
        diagnostics.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
      }
    }
    for (const [fileName, factoryName, namespace] of FACTORIES) {
      const source = /** @type {ts.SourceFile} */ (
        program.getSourceFile(join(SDK_ROOT, "src", "namespaces", fileName))
      );
      const moduleSymbol = /** @type {ts.Symbol} */ (checker.getSymbolAtLocation(source));
      const factory = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === factoryName);
      const [signature] = checker
        .getTypeOfSymbolAtLocation(/** @type {ts.Symbol} */ (factory), source)
        .getCallSignatures();
      /** @param {ts.Type} type @param {string} path */
      const walk = (type, path) => {
        for (const property of type.getProperties()) {
          const name = `${path}.${property.name}`;
          const propertyType = checker.getTypeOfSymbolAtLocation(property, source);
          const [method] = propertyType.getCallSignatures();
          if (method === undefined) {
            walk(propertyType, name);
            continue;
          }
          const params = method
            .getParameters()
            .map((parameter) => checker.getTypeOfSymbolAtLocation(parameter, source));
          const result = checker.getAwaitedType(method.getReturnType()) ?? method.getReturnType();
          const data = result.getProperty("data");
          const items = data
            ? checker.getIndexTypeOfType(checker.getTypeOfSymbolAtLocation(data, source), ts.IndexKind.Number)
            : undefined;
          const types = [...params, result, ...(items ? [items] : [])];
          signatures.push({
            name,
            types: types.map((type) => checker.typeToString(type)),
            loose: types.some(isLoose) || params.length !== 2,
          });
        }
      };
      walk(/** @type {ts.Signature} */ (signature).getReturnType(), namespace);
    }
    /** @param {string} file */
    const exportsOf = (file) =>
      checker.getExportsOfModule(
        /** @type {ts.Symbol} */ (
          checker.getSymbolAtLocation(/** @type {ts.SourceFile} */ (program.getSourceFile(file)))
        ),
      );
    for (const name of ["identity", "flights"]) {
      const sdk = exportsOf(join(SDK_ROOT, "src", `${name}.js`))
        .filter((symbol) => (symbol.flags & ts.SymbolFlags.TypeAlias) !== 0)
        .map((symbol) => ({ name: symbol.name, start: symbol.declarations?.[0]?.getStart() ?? -1 }))
        .sort((left, right) => left.start - right.start)
        .map((entry) => entry.name);
      const contractFile = join(SDK_ROOT, "..", "..", "docs", "velexis-sdk", "sdk", "src", `${name}.d.ts`);
      const contract = ts
        .createSourceFile(contractFile, readFileSync(contractFile, "utf8"), ts.ScriptTarget.ES2022)
        .statements.filter(
          (statement) =>
            (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
            (statement.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
        )
        .map((statement) => /** @type {ts.TypeAliasDeclaration} */ (statement).name.text);
      mirrors[name] = { sdk, contract };
    }
    rootExports.push(...exportsOf(join(SDK_ROOT, "src", "index.js")).map((symbol) => symbol.name));
  }, 120_000);

  it("type-check without a diagnostic in the namespace and public modules [SDK-005 AC3]", () => {
    expect(diagnostics).toEqual([]);
  });

  it("give every method typed params, options and an awaited result, never any or unknown [SDK-005 AC3]", () => {
    expect(signatures.map((signature) => signature.name)).toEqual(expect.arrayContaining(M2_METHODS));
    expect(signatures.filter((signature) => signature.loose)).toEqual([]);
    const byName = Object.fromEntries(signatures.map((signature) => [signature.name, signature.types]));
    expect(byName["flights.search"]?.[2]).not.toMatch(/\bany\b/);
    // The items of a list page are the schema's objects, not a loose record.
    expect(byName["flights.listResults"]?.[3]).toMatch(/^\{ id: string; searchId: string; /);
    expect(byName["reference.locations.search"]?.[3]).toMatch(/^\{ id: string; subType: /);
  });

  it("declare no any and suppress no check in the three namespace files [SDK-005 AC3]", () => {
    expect([...namespaceSources.keys()]).toEqual(NAMESPACE_FILES);
    for (const file of NAMESPACE_FILES) {
      const source = namespaceSources.get(file) ?? "";
      const types = [
        ...source.matchAll(/@(?:param|returns|type|typedef|template|throws)\s*\{([^}]*)\}/g),
      ].map((match) => match[1] ?? "");
      expect(types.length, file).toBeGreaterThan(0);
      expect(
        types.filter((type) => /\bany\b|\bFunction\b|\bObject\b/.test(type)),
        file,
      ).toEqual([]);
      expect(source, file).not.toMatch(/@ts-(?:ignore|expect-error|nocheck)/);
    }
  });

  it("declare the type names of flights.d.ts and identity.d.ts in the contract's order, exported from the root [SDK-005 AC3]", () => {
    const { flights, identity } = /** @type {Record<string, { sdk: string[], contract: string[] }>} */ (
      mirrors
    );
    /** The storefront and reference part of identity.d.ts; SDK-008 adds the auth and account typedefs. */
    const identityM2 = [
      "StorefrontGetParams",
      "StorefrontResolveParams",
      "LocationSubType",
      "LocationSearchParams",
      "AirportGetParams",
      "AirlineListParams",
      "AirlineGetParams",
      "CountryListParams",
      "CurrencyListParams",
      "StorefrontApi",
      "ReferenceApi",
      "ReferenceLocationsApi",
      "ReferenceAirportsApi",
      "ReferenceAirlinesApi",
      "ReferenceCountriesApi",
      "ReferenceCurrenciesApi",
    ];

    expect(flights?.sdk).toEqual(flights?.contract);
    // Only names of the contract file, in its order (auth and account join in their places).
    expect(identity?.sdk).toEqual(identity?.contract.filter((name) => identity.sdk.includes(name)));
    expect(identity?.sdk).toEqual(expect.arrayContaining(identityM2));
    // EndUserContext and EndUserSource are declared in shared.js, which the root re-exports as well.
    expect(rootExports).toEqual(
      expect.arrayContaining([
        ...(flights?.contract ?? []),
        ...identityM2,
        "EndUserContext",
        "EndUserSource",
      ]),
    );
  });
});
