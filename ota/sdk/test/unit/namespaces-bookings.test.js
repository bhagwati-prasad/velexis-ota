// The `bookings` namespace (task SDK-010, docs/velexis-sdk/sdk/src/bookings.d.ts `BookingsApi`, guide B3 §3–§5,
// ota/sdk/README.md §4.1 and §5.2): the fourteen methods are named exactly by their `x-sdk-method` and send the request
// their route-table entry describes (method, path, query, headers, body); the lists resolve with a `Page` that iterates
// across cursors; `update`, `addAncillaries` and `cancel` require `ifMatch` and send it as `If-Match`; a guest booking
// token goes per call in token mode and is refused in cookie mode, where `lookup` resolves with `bookingToken: null`;
// the three deferred methods surface `501 NOT_IMPLEMENTED` as a `ServerError`. The canned responses are the examples
// of the working OpenAPI document, checked with the Ajv helper of @velexis/testing, so the fake answers cannot drift
// from the contract. Requests go to the fake fetch only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { ConflictError, Page, ServerError, VelexisError, createVelexisClient } from "../../src/index.js";
import { op } from "../../src/internal/operations.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

/** Fake keys and tokens with the right shapes; none of them works anywhere. */
const SK = "sk_test_sdk010_fake_secret";
const PK = "pk_test_sdk010_fake";
const CLIENT_BOOKING_TOKEN = "bt_sdk010_fake_client";
const CALL_BOOKING_TOKEN = "bt_sdk010_fake_call";
const CSRF = "csrf_sdk010_fake";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The working contract, whose response examples are the canned answers. */
const DOCUMENT = join(SDK_ROOT, "..", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");
const BASE_URL = "https://api.ota.example.com";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];

const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const DOCUMENT_ID = "doc_01JA4CG8B6E9H2L5P8S1W4Z7C0";
const PAYMENT_ID = "pay_01JA4D02B5E8H1K4N7Q0T3W6Z9";
const OPTION_ID = "bao_01JA4D01A4D7G0J3M6P9S2V5Y8";

/** The fourteen methods of `BookingsApi`, as the contract names them (bookings.d.ts). */
const BOOKINGS_METHODS = [
  "list",
  "get",
  "lookup",
  "update",
  "getAncillaries",
  "createPayment",
  "addAncillaries",
  "quoteCancellation",
  "cancel",
  "getFareRules",
  "listDocuments",
  "getDocumentDownloadUrl",
  "listEvents",
  "getTicketingStatus",
];

/** The methods that are deferred until after the MVP (scope.md §3, pending-operations.ts of the OTA backend). */
const DEFERRED = ["getAncillaries", "createPayment", "addAncillaries"];

/** @typedef {import("../../src/index.js").VelexisClient} VelexisClient */
/** @typedef {import("../helpers/fake-fetch.js").RecordedRequest} RecordedRequest */
/** @typedef {{ operationId: string, status: number, body: Record<string, unknown> }} Example */

/**
 * The first documented 2xx example of every `bookings.*` operation, by `x-sdk-method`, filled in by the setup hook.
 * @type {Map<string, Example>}
 */
const EXAMPLES = new Map();

/**
 * The example of one method.
 * @param {string} method the `x-sdk-method`, for example `bookings.get`
 * @returns {Example}
 */
function example(method) {
  const found = EXAMPLES.get(method);
  if (found === undefined) {
    throw new Error(`the OpenAPI document has no 2xx example for ${method}`);
  }
  return found;
}

/**
 * A deep copy of an example body with some top-level fields replaced.
 * @param {string} method
 * @param {Record<string, unknown>} [changes]
 */
const bodyOf = (method, changes = {}) => ({ ...structuredClone(example(method).body), ...changes });

/**
 * Resolves the local `$ref`s of a parsed document node (responses and examples refer to components).
 * @param {Record<string, unknown>} document
 * @param {unknown} node
 * @returns {Record<string, any>}
 */
function deref(document, node) {
  let current = /** @type {Record<string, any>} */ (node);
  while (current !== null && typeof current === "object" && typeof current["$ref"] === "string") {
    current = current["$ref"]
      .slice(2)
      .split("/")
      .reduce((/** @type {Record<string, any>} */ value, /** @type {string} */ key) => value[key], document);
  }
  return current;
}

/**
 * The first 2xx JSON example of every `bookings.*` operation of a parsed document.
 * @param {Record<string, any>} document
 * @returns {Map<string, Example>}
 */
function bookingExamplesOf(document) {
  /** @type {Map<string, Example>} */
  const examples = new Map();
  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      const sdkMethod = operation?.["x-sdk-method"];
      if (typeof sdkMethod !== "string" || !sdkMethod.startsWith("bookings.")) {
        continue;
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        const media = deref(document, response)?.content?.["application/json"];
        const first = Object.values(media?.examples ?? {})[0];
        if (/^2\d\d$/.test(status) && first !== undefined && !examples.has(sdkMethod)) {
          examples.set(sdkMethod, {
            operationId: operation.operationId,
            status: Number(status),
            body: deref(document, first).value,
          });
        }
      }
    }
  }
  return examples;
}

/**
 * A page body of a list operation built from its example.
 * @param {string} method
 * @param {unknown[]} data
 * @param {string | null} nextCursor
 * @param {number} limit
 */
const pageBody = (method, data, nextCursor, limit) => bodyOf(method, { data, page: { nextCursor, limit } });

/**
 * Stubs a browser page, which cookie mode needs, with the CSRF cookie by default. Without it (`csrf: false`) every
 * write first asks `GET /v1/storefront` for the cookie, so a test that expects no request at all proves that a call
 * is refused before that request too.
 * @param {{ csrf?: boolean }} [page]
 */
function stubBrowserPage({ csrf = true } = {}) {
  vi.stubGlobal("document", { cookie: csrf ? `__Host-vx_csrf=${CSRF}` : "" });
}

/**
 * The setup hook parses the OTA document (about half a second alone) and compiles the response schemas of the examples
 * with Ajv; both take much longer while Turborepo runs every package's tests at once on a CI runner, so the hook gets
 * its own budget and the tests below only use the parsed examples and the compiled validators.
 */
const SETUP_TIMEOUT_MS = 60_000;

beforeAll(() => {
  for (const [method, found] of bookingExamplesOf(parse(readFileSync(DOCUMENT, "utf8")))) {
    EXAMPLES.set(method, found);
  }
  const checker = responseChecker("ota");
  for (const found of EXAMPLES.values()) {
    checker.check(found.operationId, { status: found.status, body: found.body });
  }
}, SETUP_TIMEOUT_MS);

describe("the canned responses", () => {
  it("are the documented examples of all fourteen operations and match their response schemas [SDK-010]", () => {
    expect([...EXAMPLES.keys()].sort()).toEqual(BOOKINGS_METHODS.map((name) => `bookings.${name}`).sort());
    for (const found of EXAMPLES.values()) {
      expect(() =>
        expectResponseToMatch(/** @type {never} */ (found.operationId), {
          status: found.status,
          body: found.body,
        }),
      ).not.toThrow();
    }
  });
});

describe("the bookings namespace", () => {
  it("offers the fourteen methods of BookingsApi, each named by its x-sdk-method in the route table [SDK-010]", () => {
    const client = createVelexisClient({ publishableKey: PK, fetch: createFakeFetch().fetch });

    expect(Object.keys(client.bookings).sort()).toEqual([...BOOKINGS_METHODS].sort());
    for (const name of BOOKINGS_METHODS) {
      expect(typeof client.bookings[/** @type {keyof VelexisClient["bookings"]} */ (name)]).toBe("function");
      expect(op, name).toHaveProperty(`bookings_${name}`);
    }
  });

  it("is rebuilt by withOptions on the new client's options [SDK-010]", async () => {
    const fake = createFakeFetch([{ body: bodyOf("bookings.get") }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch, locale: "en-GB" });

    await client.withOptions({ locale: "de-DE" }).bookings.get({ bookingId: BOOKING_ID });

    expect(fake.requests[0]?.headers["accept-language"]).toBe("de-DE");
    expect(Object.keys(client.withOptions({ currency: "EUR" }).bookings).sort()).toEqual(
      [...BOOKINGS_METHODS].sort(),
    );
  });
});

/**
 * One method called with sample parameters, and the request it must send.
 * @typedef {object} RouteCase
 * @property {string} method the method of `BookingsApi`
 * @property {(client: VelexisClient) => Promise<unknown>} call
 * @property {"GET" | "POST" | "PATCH"} http
 * @property {string} path the path with its parameters filled in
 * @property {[string, string][]} query the decoded query parameters, in order
 * @property {Record<string, unknown>} [body] the JSON body; none when absent
 * @property {Record<string, string>} [headers] headers the call must carry besides the common ones
 */

const EXPECTED_TOTAL = { amount: "45.00", currency: "EUR" };
const SELECTIONS = [{ optionId: OPTION_ID, travelerId: "1" }];

/** @type {RouteCase[]} */
const CASES = [
  {
    method: "list",
    call: (client) =>
      client.bookings.list({
        timeframe: "upcoming",
        departureFrom: "2026-11-01",
        departureTo: "2026-12-31",
        createdFrom: "2026-10-01T00:00:00Z",
        createdTo: "2026-10-11T00:00:00Z",
        sort: "departure",
        cursor: "cur_1",
        limit: 20,
      }),
    http: "GET",
    path: "/v1/bookings",
    query: [
      ["timeframe", "upcoming"],
      ["departureFrom", "2026-11-01"],
      ["departureTo", "2026-12-31"],
      ["createdFrom", "2026-10-01T00:00:00Z"],
      ["createdTo", "2026-10-11T00:00:00Z"],
      ["sort", "departure"],
      ["cursor", "cur_1"],
      ["limit", "20"],
    ],
  },
  {
    method: "get",
    call: (client) =>
      client.bookings.get({
        bookingId: BOOKING_ID,
        refresh: true,
        include: ["bags"],
        fareRules: ["rebooks", "refunds"],
      }),
    http: "GET",
    path: `/v1/bookings/${BOOKING_ID}`,
    query: [
      ["refresh", "true"],
      ["include", "bags"],
      ["fareRules", "rebooks,refunds"],
    ],
  },
  {
    method: "lookup",
    call: (client) => client.bookings.lookup({ bookingReference: "VX9M4T", lastName: "Berg" }),
    http: "POST",
    path: "/v1/bookings/lookup",
    query: [],
    body: { bookingReference: "VX9M4T", lastName: "Berg" },
  },
  {
    method: "update",
    call: (client) =>
      client.bookings.update({
        bookingId: BOOKING_ID,
        ifMatch: 3,
        remarks: [{ text: "Wheelchair at arrival", travelerIds: ["1"] }],
      }),
    http: "PATCH",
    path: `/v1/bookings/${BOOKING_ID}`,
    query: [],
    body: { remarks: [{ text: "Wheelchair at arrival", travelerIds: ["1"] }] },
    headers: { "if-match": '"3"' },
  },
  {
    method: "getAncillaries",
    call: (client) => client.bookings.getAncillaries({ bookingId: BOOKING_ID }),
    http: "GET",
    path: `/v1/bookings/${BOOKING_ID}/ancillaries`,
    query: [],
  },
  {
    method: "createPayment",
    call: (client) =>
      client.bookings.createPayment({
        bookingId: BOOKING_ID,
        selections: SELECTIONS,
        expectedTotal: EXPECTED_TOTAL,
        method: "card",
        termsAccepted: true,
      }),
    http: "POST",
    path: `/v1/bookings/${BOOKING_ID}/payments`,
    query: [],
    body: { selections: SELECTIONS, expectedTotal: EXPECTED_TOTAL, method: "card", termsAccepted: true },
  },
  {
    method: "addAncillaries",
    call: (client) =>
      client.bookings.addAncillaries({
        bookingId: BOOKING_ID,
        ifMatch: '"4"',
        paymentId: PAYMENT_ID,
        selections: SELECTIONS,
        expectedTotal: EXPECTED_TOTAL,
      }),
    http: "POST",
    path: `/v1/bookings/${BOOKING_ID}/ancillaries`,
    query: [],
    body: { paymentId: PAYMENT_ID, selections: SELECTIONS, expectedTotal: EXPECTED_TOTAL },
    headers: { "if-match": '"4"' },
  },
  {
    method: "quoteCancellation",
    call: (client) => client.bookings.quoteCancellation({ bookingId: BOOKING_ID }),
    http: "GET",
    path: `/v1/bookings/${BOOKING_ID}/cancellation-quote`,
    query: [],
  },
  {
    method: "cancel",
    call: (client) =>
      client.bookings.cancel({
        bookingId: BOOKING_ID,
        ifMatch: 5,
        reasonCode: "change_of_plans",
        comment: "Trip postponed",
        expectedRefund: { amount: "275.12", currency: "EUR" },
      }),
    http: "POST",
    path: `/v1/bookings/${BOOKING_ID}/cancellation`,
    query: [],
    body: {
      reasonCode: "change_of_plans",
      comment: "Trip postponed",
      expectedRefund: { amount: "275.12", currency: "EUR" },
    },
    headers: { "if-match": '"5"' },
  },
  {
    method: "getFareRules",
    call: (client) =>
      client.bookings.getFareRules({ bookingId: BOOKING_ID, types: ["rebooks", "refunds"], refresh: true }),
    http: "GET",
    path: `/v1/bookings/${BOOKING_ID}/fare-rules`,
    query: [
      ["types", "rebooks,refunds"],
      ["refresh", "true"],
    ],
  },
  {
    method: "listDocuments",
    call: (client) =>
      client.bookings.listDocuments({
        bookingId: BOOKING_ID,
        kind: ["e_ticket_receipt", "itinerary"],
        limit: 10,
      }),
    http: "GET",
    path: `/v1/bookings/${BOOKING_ID}/documents`,
    query: [
      ["kind", "e_ticket_receipt,itinerary"],
      ["limit", "10"],
    ],
  },
  {
    method: "getDocumentDownloadUrl",
    call: (client) =>
      client.bookings.getDocumentDownloadUrl({ bookingId: BOOKING_ID, documentId: DOCUMENT_ID }),
    http: "GET",
    path: `/v1/bookings/${BOOKING_ID}/documents/${DOCUMENT_ID}/download-url`,
    query: [],
  },
  {
    method: "listEvents",
    call: (client) => client.bookings.listEvents({ bookingId: BOOKING_ID, cursor: "cur_4", limit: 50 }),
    http: "GET",
    path: `/v1/bookings/${BOOKING_ID}/events`,
    query: [
      ["cursor", "cur_4"],
      ["limit", "50"],
    ],
  },
  {
    method: "getTicketingStatus",
    call: (client) => client.bookings.getTicketingStatus({ bookingId: BOOKING_ID, refresh: true }),
    http: "GET",
    path: `/v1/bookings/${BOOKING_ID}/ticketing`,
    query: [["refresh", "true"]],
  },
];

describe("each bookings method sends the request of its route-table entry", () => {
  it("covers all fourteen methods [SDK-010]", () => {
    expect(CASES.map((testCase) => testCase.method).sort()).toEqual([...BOOKINGS_METHODS].sort());
  });

  it.each(CASES)("bookings.$method → $http $path [SDK-010]", async (testCase) => {
    const entry = op[/** @type {keyof typeof op} */ (`bookings_${testCase.method}`)];
    const { status, body: response } = example(`bookings.${testCase.method}`);
    const fake = createFakeFetch([{ status, body: response }]);
    // A server-mode client with a booking token and an environment: the token goes with every bookings call, the
    // environment header with none of them (they are customer operations).
    const client = createVelexisClient({
      secretKey: SK,
      bookingToken: CLIENT_BOOKING_TOKEN,
      environment: "test",
      fetch: fake.fetch,
    });

    const result = await testCase.call(client);

    expect(fake.requests).toHaveLength(1);
    const request = /** @type {RecordedRequest} */ (fake.requests[0]);
    // The route table: method, path template and query parameter names (in the table's order).
    expect(request.method).toBe(testCase.http);
    expect(entry.method).toBe(testCase.http);
    expect(testCase.path).toMatch(new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, "[^/]+")}$`));
    expect(request.url.split("?")[0]).toBe(`${BASE_URL}${testCase.path}`);
    expect([...request.searchParams]).toEqual(testCase.query);
    const queryNames = testCase.query.map(([name]) => name);
    expect(entry.queryParams.filter((name) => queryNames.includes(name))).toEqual(queryNames);
    expect(request.url).not.toMatch(/%2C/i);
    // The body: the params that are not path, query or header params, as JSON (never `ifMatch`); none for a GET.
    if (testCase.body === undefined) {
      expect(request.body).toBeNull();
      expect(request.headers).not.toHaveProperty("content-type");
    } else {
      expect(request.json).toEqual(testCase.body);
      expect(request.headers["content-type"]).toBe("application/json");
    }
    // The headers: the key, the booking token, JSON, one generated Idempotency-Key where the operation takes one,
    // If-Match only where the operation requires it, never the environment header.
    expect(request.headers).toMatchObject({
      accept: "application/json",
      "x-api-key": SK,
      "x-booking-token": CLIENT_BOOKING_TOKEN,
      ...testCase.headers,
    });
    if (entry.idempotency === "none") {
      expect(request.headers).not.toHaveProperty("idempotency-key");
    } else {
      expect(request.headers["idempotency-key"]).toMatch(UUID_V4);
    }
    expect(Boolean(testCase.headers?.["if-match"])).toBe("ifMatch" in entry.headerParams);
    expect(request.headers).not.toHaveProperty("x-velexis-environment");
    // Bookings are personal: no-store unless the call chooses a cache mode itself.
    expect(request.init.cache).toBe("no-store");
    // The result: the response body, or a Page of it for a list.
    if (entry.queryParams.includes("cursor")) {
      expect(result).toBeInstanceOf(Page);
      expect(JSON.parse(JSON.stringify(result))).toEqual(response);
    } else {
      expect(result).toEqual(response);
    }
  });
});

describe("bookings.list", () => {
  it("returns a Page that iterates across cursors with the same filters [SDK-010 AC1]", async () => {
    const [summary] = /** @type {Record<string, unknown>[]} */ (example("bookings.list").body["data"]);
    /** @param {string} id */
    const trip = (id) => ({ ...structuredClone(summary), id });
    const pages = [
      pageBody("bookings.list", [trip("bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2")], "cur_2", 1),
      pageBody("bookings.list", [trip("bkg_01JA4CH3G1K4N7R0U3X6A9D2F5")], "cur_3", 1),
      pageBody("bookings.list", [trip("bkg_01JA4CJ5M7Q0T3W6Z9C2F5H8K1")], null, 1),
    ];
    const checker = responseChecker("ota");
    for (const body of pages) {
      expect(checker.check("listBookings", { status: 200, body })).toEqual([]);
    }
    const fake = createFakeFetch(pages.map((body) => ({ body })));
    const client = createVelexisClient({
      publishableKey: PK,
      accessToken: "at_sdk010_fake",
      fetch: fake.fetch,
    });

    const page = await client.bookings.list({ timeframe: "past", sort: "-departure", limit: 1 });

    expect(page).toBeInstanceOf(Page);
    expect(page.page).toEqual({ nextCursor: "cur_2", limit: 1 });
    /** @type {string[]} */
    const ids = [];
    for await (const booking of page) {
      ids.push(booking.id);
    }
    expect(ids).toEqual([
      "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
      "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5",
      "bkg_01JA4CJ5M7Q0T3W6Z9C2F5H8K1",
    ]);
    // Each page is fetched once, with the first call's filters, sort, limit and options plus the next cursor.
    expect(fake.requests.map((request) => [...request.searchParams])).toEqual([
      [
        ["timeframe", "past"],
        ["sort", "-departure"],
        ["limit", "1"],
      ],
      [
        ["timeframe", "past"],
        ["sort", "-departure"],
        ["cursor", "cur_2"],
        ["limit", "1"],
      ],
      [
        ["timeframe", "past"],
        ["sort", "-departure"],
        ["cursor", "cur_3"],
        ["limit", "1"],
      ],
    ]);
    for (const request of fake.requests) {
      expect(request.path).toBe("/v1/bookings");
      expect(request.headers.authorization).toBe("Bearer at_sdk010_fake");
      expect(request.init.cache).toBe("no-store");
    }
    // next() walks the same pages; the last page has none after it.
    fake.enqueue({ body: pages[1] }, { body: pages[2] });
    const second = await page.next();
    const third = await second?.next();
    expect(second?.data.map((booking) => booking.id)).toEqual(["bkg_01JA4CH3G1K4N7R0U3X6A9D2F5"]);
    expect(third?.page.nextCursor).toBeNull();
    expect(await third?.next()).toBeNull();
    expect(fake.remaining).toBe(0);
  });

  it("resolves with a Page without params too (the default tab) [SDK-010 AC1]", async () => {
    const fake = createFakeFetch([{ body: example("bookings.list").body }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    const page = await client.bookings.list();

    expect(page).toBeInstanceOf(Page);
    expect(page.page.nextCursor).toBeNull();
    expect(await page.next()).toBeNull();
    expect(fake.requests[0]?.url).toBe(`${BASE_URL}/v1/bookings`);
  });
});

describe("listDocuments and listEvents", () => {
  it("resolve with Pages that follow the cursor with the same booking and filters [SDK-010]", async () => {
    const documents = /** @type {unknown[]} */ (example("bookings.listDocuments").body["data"]);
    const events = /** @type {unknown[]} */ (example("bookings.listEvents").body["data"]);
    const fake = createFakeFetch([
      { body: pageBody("bookings.listDocuments", documents.slice(0, 1), "cur_d2", 1) },
      { body: pageBody("bookings.listDocuments", documents.slice(1, 2), null, 1) },
      { body: pageBody("bookings.listEvents", events.slice(0, 1), "cur_e2", 1) },
      { body: pageBody("bookings.listEvents", events.slice(1, 2), null, 1) },
    ]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    /** @type {unknown[]} */
    const seen = [];
    for await (const document of await client.bookings.listDocuments({
      bookingId: BOOKING_ID,
      kind: ["itinerary"],
      limit: 1,
    })) {
      seen.push(document);
    }
    for await (const event of await client.bookings.listEvents({ bookingId: BOOKING_ID, limit: 1 })) {
      seen.push(event);
    }

    expect(seen).toEqual([...documents.slice(0, 2), ...events.slice(0, 2)]);
    expect(fake.requests.map((request) => `${request.path}?${request.searchParams}`)).toEqual([
      `/v1/bookings/${BOOKING_ID}/documents?kind=itinerary&limit=1`,
      `/v1/bookings/${BOOKING_ID}/documents?kind=itinerary&cursor=cur_d2&limit=1`,
      `/v1/bookings/${BOOKING_ID}/events?limit=1`,
      `/v1/bookings/${BOOKING_ID}/events?cursor=cur_e2&limit=1`,
    ]);
  });
});

describe("ifMatch on update, addAncillaries and cancel", () => {
  it("is sent as If-Match: a version number as its ETag, a string as it is, and never in the body [SDK-010]", async () => {
    const booking = bodyOf("bookings.update");
    const cancelled = bodyOf("bookings.cancel");
    const fake = createFakeFetch([
      { body: booking },
      { body: booking },
      { body: cancelled },
      { body: cancelled },
    ]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });
    const remarks = [{ text: "Vegetarian meal" }];

    await client.bookings.update({ bookingId: BOOKING_ID, ifMatch: 0, remarks });
    await client.bookings.update({ bookingId: BOOKING_ID, ifMatch: '"12"', remarks });
    await client.bookings.cancel({ bookingId: BOOKING_ID, ifMatch: 12, reasonCode: "illness" });
    await client.bookings.cancel({ bookingId: BOOKING_ID, ifMatch: 'W/"12"', reasonCode: "other" });

    expect(fake.requests.map((request) => request.headers["if-match"])).toEqual([
      '"0"',
      '"12"',
      '"12"',
      'W/"12"',
    ]);
    for (const request of fake.requests) {
      expect(request.json).not.toHaveProperty("ifMatch");
      expect(request.json).not.toHaveProperty("bookingId");
    }
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["an empty string", ""],
    ["blank", "   "],
    ["negative", -1],
    ["a fraction", 1.5],
    ["not a number", Number.NaN],
    ["an object", { version: 3 }],
    ["a header line break", '"3"\r\nX-Other: 1'],
    ["not ASCII", '"3€"'],
  ])(
    "refuses an ifMatch that is %s with a TypeError before any request, in token and cookie mode [SDK-010]",
    async (_label, ifMatch) => {
      // Cookie mode without the CSRF cookie: a write that got through would first ask for the cookie.
      stubBrowserPage({ csrf: false });
      const fake = createFakeFetch();
      const clients = [
        createVelexisClient({ publishableKey: PK, fetch: fake.fetch }),
        createVelexisClient({ session: "cookie", fetch: fake.fetch }),
      ];
      const params = /** @type {never} */ ({ bookingId: BOOKING_ID, ifMatch });

      for (const client of clients) {
        for (const call of [
          () => client.bookings.update({ .../** @type {object} */ (params), remarks: [] }),
          () => client.bookings.cancel({ .../** @type {object} */ (params), reasonCode: "other" }),
          () =>
            client.bookings.addAncillaries({
              .../** @type {object} */ (params),
              paymentId: PAYMENT_ID,
              selections: SELECTIONS,
              expectedTotal: EXPECTED_TOTAL,
            }),
        ]) {
          const error = await call().catch((/** @type {unknown} */ caught) => caught);
          expect(error).toBeInstanceOf(TypeError);
          expect(/** @type {TypeError} */ (error).message).toMatch(
            /^Velexis SDK: (PATCH|POST) \/v1\/bookings\/\{bookingId\}(\/[a-z]+)? needs "ifMatch", the booking version \(a whole number\) or its ETag \(a string\)$/,
          );
        }
      }
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("leaves a stale version to the API: PRECONDITION_FAILED is a VelexisError and the PATCH is not retried [SDK-010]", async () => {
    const fake = createFakeFetch([errorResponse(412, "PRECONDITION_FAILED")]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch, maxRetries: 2 });

    const error = await client.bookings
      .update({ bookingId: BOOKING_ID, ifMatch: 2, remarks: [{ text: "Window seat" }] })
      .catch((/** @type {unknown} */ caught) => caught);

    expect(error).toBeInstanceOf(VelexisError);
    expect(error).toMatchObject({ code: "PRECONDITION_FAILED", status: 412 });
    expect(fake.requests).toHaveLength(1);
  });
});

describe("the guest booking token", () => {
  it("goes per call in token mode as X-Booking-Token, and wins over the client's token [SDK-010]", async () => {
    const fake = createFakeFetch([
      { body: example("bookings.get").body },
      { body: example("bookings.get").body },
      { body: example("bookings.getTicketingStatus").body },
    ]);
    const plain = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });
    const withToken = createVelexisClient({
      publishableKey: PK,
      bookingToken: CLIENT_BOOKING_TOKEN,
      fetch: fake.fetch,
    });

    await plain.bookings.get({ bookingId: BOOKING_ID }, { bookingToken: CALL_BOOKING_TOKEN });
    await withToken.bookings.get({ bookingId: BOOKING_ID }, { bookingToken: CALL_BOOKING_TOKEN });
    await withToken.bookings.getTicketingStatus({ bookingId: BOOKING_ID });

    expect(fake.requests.map((request) => request.headers["x-booking-token"])).toEqual([
      CALL_BOOKING_TOKEN,
      CALL_BOOKING_TOKEN,
      CLIENT_BOOKING_TOKEN,
    ]);
    for (const request of fake.requests) {
      expect(request.headers["x-api-key"]).toBe(PK);
      expect(request.init.credentials).toBe("omit");
    }
  });

  it.each(CASES)(
    "throws a TypeError before any request when bookings.$method gets a bookingToken in cookie mode [SDK-010 AC2]",
    async (testCase) => {
      // Without the CSRF cookie a write would first ask GET /v1/storefront for it: none of that happens either.
      stubBrowserPage({ csrf: false });
      const fake = createFakeFetch();
      const client = createVelexisClient({ session: "cookie", fetch: fake.fetch });
      const method = /** @type {(params: unknown, options: unknown) => Promise<unknown>} */ (
        client.bookings[/** @type {keyof VelexisClient["bookings"]} */ (testCase.method)]
      );
      const params = { bookingId: BOOKING_ID, ifMatch: 1 };

      const error = await method(params, { bookingToken: CALL_BOOKING_TOKEN }).catch(
        (/** @type {unknown} */ caught) => caught,
      );

      expect(error).toBeInstanceOf(TypeError);
      expect(/** @type {TypeError} */ (error).message).toBe(
        'Velexis SDK: request option "bookingToken" cannot be used with session "cookie"; the browser sends the session cookies',
      );
      expect(/** @type {TypeError} */ (error).message).not.toContain(CALL_BOOKING_TOKEN);
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("is refused as a client option in cookie mode, before any request [SDK-010 AC2]", () => {
    stubBrowserPage({ csrf: false });
    const fake = createFakeFetch();

    for (const bookingToken of [CALL_BOOKING_TOKEN, () => CALL_BOOKING_TOKEN, null]) {
      expect(() => createVelexisClient({ session: "cookie", bookingToken, fetch: fake.fetch })).toThrow(
        new TypeError(
          'Velexis SDK: option "bookingToken" cannot be used with session "cookie"; the browser sends the session cookies',
        ),
      );
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("bookings.lookup", () => {
  it("resolves with bookingToken: null in cookie mode, also when a response carries a token [SDK-010]", async () => {
    stubBrowserPage();
    const edgeAnswer = bodyOf("bookings.lookup", { bookingToken: null });
    const fake = createFakeFetch([
      { body: edgeAnswer },
      { body: bodyOf("bookings.lookup", { bookingToken: CALL_BOOKING_TOKEN }) },
      { body: example("bookings.get").body },
    ]);
    const client = createVelexisClient({ session: "cookie", fetch: fake.fetch });
    expect(responseChecker("ota").check("lookupBooking", { status: 200, body: edgeAnswer })).toEqual([]);

    const first = await client.bookings.lookup({ bookingReference: "VX9M4T", lastName: "Berg" });
    const second = await client.bookings.lookup({ bookingReference: "VX9M4T", lastName: "Berg" });
    // The booking page then reads the booking with the guest cookie the browser holds; the SDK adds no token.
    await client.bookings.get({ bookingId: first.bookingId });

    expect(first).toEqual(edgeAnswer);
    expect(second.bookingToken).toBeNull();
    expect(JSON.stringify([first, second])).not.toContain(CALL_BOOKING_TOKEN);
    expect(fake.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST /api/v1/bookings/lookup",
      "POST /api/v1/bookings/lookup",
      `GET /api/v1/bookings/${first.bookingId}`,
    ]);
    for (const request of fake.requests) {
      expect(request.headers).not.toHaveProperty("x-booking-token");
      expect(request.headers).not.toHaveProperty("x-api-key");
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.init).toMatchObject({ credentials: "same-origin", mode: "same-origin" });
    }
    expect(fake.requests[0]?.headers["x-csrf-token"]).toBe(CSRF);
    expect(fake.requests[0]?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(fake.requests[0]?.json).toEqual({ bookingReference: "VX9M4T", lastName: "Berg" });
  });

  it("resolves with the guest token in token and server mode, which the next calls send per call [SDK-010]", async () => {
    const answer = example("bookings.lookup").body;
    const fake = createFakeFetch([
      { body: answer },
      { body: answer },
      { body: example("bookings.get").body },
    ]);
    const browser = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });
    const server = createVelexisClient({ secretKey: SK, fetch: fake.fetch });

    const found = await browser.bookings.lookup({ bookingReference: "VX9M4T", lastName: "Berg" });
    const again = await server.bookings.lookup({ bookingReference: "VX9M4T", lastName: "Berg" });
    const token = /** @type {string} */ (found.bookingToken);
    await server.bookings.get({ bookingId: found.bookingId }, { bookingToken: token });

    expect(found).toEqual(answer);
    expect(again).toEqual(answer);
    expect(typeof token).toBe("string");
    expect(fake.requests[0]?.headers).not.toHaveProperty("x-booking-token");
    expect(fake.requests[2]?.headers["x-booking-token"]).toBe(token);
  });
});

describe("deferred methods", () => {
  it.each(DEFERRED)(
    "bookings.%s surfaces 501 NOT_IMPLEMENTED as a ServerError and sends one request [SDK-010]",
    async (name) => {
      const fake = createFakeFetch([
        errorResponse(501, "NOT_IMPLEMENTED", { details: { milestone: "deferred" } }),
      ]);
      const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch, maxRetries: 2 });
      const testCase = /** @type {RouteCase} */ (CASES.find((candidate) => candidate.method === name));

      const error = await testCase.call(client).catch((/** @type {unknown} */ caught) => caught);

      expect(error).toBeInstanceOf(ServerError);
      expect(error).toMatchObject({ code: "NOT_IMPLEMENTED", status: 501, retryable: false });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.path).toBe(testCase.path);
    },
  );
});

describe("the fetch cache mode", () => {
  it("is no-store unless the call chooses cache or next [SDK-010]", async () => {
    const body = example("bookings.getTicketingStatus").body;
    const fake = createFakeFetch(Array.from({ length: 3 }, () => ({ body })));
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    await client.bookings.getTicketingStatus({ bookingId: BOOKING_ID });
    await client.bookings.getTicketingStatus({ bookingId: BOOKING_ID }, { cache: "no-cache" });
    await client.bookings.getTicketingStatus({ bookingId: BOOKING_ID }, { next: { tags: ["booking"] } });

    expect(
      fake.requests.map((request) => [
        request.init.cache,
        /** @type {{ next?: unknown }} */ (request.init).next,
      ]),
    ).toEqual([
      ["no-store", undefined],
      ["no-cache", undefined],
      [undefined, { tags: ["booking"] }],
    ]);
  });

  it("refuses options that are not a plain object, as every method does [SDK-010]", async () => {
    const fake = createFakeFetch();
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });
    const signal = new AbortController().signal;

    for (const options of [new Map(), Object.create({ signal })]) {
      await expect(client.bookings.get({ bookingId: BOOKING_ID }, options)).rejects.toThrow(
        new TypeError("Velexis SDK: request option must be an object"),
      );
      await expect(client.bookings.update({ bookingId: BOOKING_ID, ifMatch: 1 }, options)).rejects.toThrow(
        new TypeError("Velexis SDK: request option must be an object"),
      );
      await expect(
        client.bookings.lookup({ bookingReference: "VX9M4T", lastName: "Berg" }, options),
      ).rejects.toThrow(new TypeError("Velexis SDK: request option must be an object"));
    }
    await expect(client.bookings.update(/** @type {never} */ ("bkg_1"))).rejects.toThrow(
      new TypeError("Velexis SDK: the params of PATCH /v1/bookings/{bookingId} must be an object"),
    );
    await expect(client.bookings.get(/** @type {never} */ ({}))).rejects.toThrow(
      new TypeError('Velexis SDK: GET /v1/bookings/{bookingId} needs the path parameter "bookingId"'),
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe("errors of the bookings methods", () => {
  it("getDocumentDownloadUrl throws a retryable ConflictError DOCUMENT_NOT_READY with its details [SDK-010]", async () => {
    const fake = createFakeFetch([
      errorResponse(409, "DOCUMENT_NOT_READY", { details: { retryAfterSeconds: 5 } }),
    ]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    const error = await client.bookings
      .getDocumentDownloadUrl({ bookingId: BOOKING_ID, documentId: DOCUMENT_ID })
      .catch((/** @type {unknown} */ caught) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      code: "DOCUMENT_NOT_READY",
      status: 409,
      retryable: true,
      details: { retryAfterSeconds: 5 },
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("cancel retries a 503 with the same Idempotency-Key [SDK-010]", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeFetch([
        errorResponse(503, "SERVICE_UNAVAILABLE", { headers: { "retry-after": "1" } }),
        { body: example("bookings.cancel").body },
      ]);
      const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

      const pending = client.bookings.cancel(
        { bookingId: BOOKING_ID, ifMatch: 5, reasonCode: "change_of_plans" },
        { idempotencyKey: `cancel-${BOOKING_ID}-5` },
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual(example("bookings.cancel").body);
      expect(fake.requests.map((request) => request.headers["idempotency-key"])).toEqual([
        `cancel-${BOOKING_ID}-5`,
        `cancel-${BOOKING_ID}-5`,
      ]);
      expect(fake.requests.map((request) => request.headers["if-match"])).toEqual(['"5"', '"5"']);
    } finally {
      vi.useRealTimers();
    }
  });
});
