// The `console` namespace (task SDK-011, docs/velexis-sdk/sdk/src/console.d.ts `ConsoleApi`, guide B4, ota/sdk/README.md
// §4.3 and §5.2, OADR-0018 points 1 and 3): the 32 contract methods in six sub-namespaces are named exactly by their
// `x-sdk-method` and send the request their route-table entry describes (method, path, query, headers, body); in server
// mode with `environment: "live"` every console request carries `X-Velexis-Environment: live` and no customer request
// does (AC2); the lists resolve with a `Page` that keeps its extra fields; `bookings.patch`, `.issue` and `.cancel`
// require `ifMatch`; the record-locator lookups default `originSystemCode` to `"GDS"`; the long staff actions get 60 s;
// a `sessionKind: "staff"` client refreshes through `console.auth.refresh`; the five deferred methods surface
// `501 NOT_IMPLEMENTED` as a `ServerError`; and console.js declares the type names of console.d.ts in the contract's
// order. The contract project (test/contract/) checks the 32 methods' types against the contract (AC1). The canned
// responses are the examples of the working OpenAPI document, checked with the Ajv helper of @velexis/testing, so the
// fake answers cannot drift from the contract. Requests go to the fake fetch only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { responseChecker } from "@velexis/testing";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { ConnectionError, Page, ServerError, VelexisError, createVelexisClient } from "../../src/index.js";
import { op } from "../../src/internal/operations.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

/** Fake keys and tokens with the right shapes; none of them works anywhere. */
const SK = "sk_test_sdk011_fake_secret";
const STAFF_AT = "at_sdk011_fake_staff_first";
const STAFF_RT = "rt_sdk011_fake_staff_first_00000000";
const NEW_STAFF_AT = "at_sdk011_fake_staff_second";
const NEW_STAFF_RT = "rt_sdk011_fake_staff_second_0000000";
const PORTAL_TOKEN = "ptk_sdk011_fake_portal_token";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..", "..");
/** The working contract, whose response examples are the canned answers. */
const DOCUMENT = join(REPO_ROOT, "ota", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");
const BASE_URL = "https://api.ota.example.com";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];

const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const CUSTOMER_ID = "cus_01JA4C4M7P1S4V7Y0B3E6H9K2N";
const FLIGHT_ORDER_ID = "eJzTd9cPCjOJ8okIMgYADBcCLw";

/** The 32 methods of `ConsoleApi`, by sub-namespace, as the contract names them (console.d.ts). */
const CONSOLE_METHODS = {
  auth: ["signIn", "refresh", "signOut", "me"],
  bookings: [
    "list",
    "get",
    "findByRecordLocator",
    "import",
    "retrieve",
    "create",
    "patch",
    "issue",
    "cancel",
    "resync",
    "addNote",
  ],
  queues: ["list", "listSnapshots"],
  customers: ["list", "get"],
  supplierRequests: ["list"],
  amadeus: [
    "searchFlightOffers",
    "getFlightOffers",
    "searchFlightAvailabilities",
    "upsellAirOffers",
    "quoteAirOffers",
    "createFlightOrders",
    "issueFlightOrder",
    "getFlightOrder",
    "patchFlightOrder",
    "cancelFlightOrder",
    "getFlightOrderByReference",
    "getQueue",
  ],
};

/** Every console method by its dotted path below `console` (`bookings.get`). */
const ALL_METHODS = Object.entries(CONSOLE_METHODS).flatMap(([namespace, methods]) =>
  methods.map((method) => `${namespace}.${method}`),
);

/** The methods that are deferred until after the MVP (scope.md §3.4, pending-operations.ts of the OTA backend). */
const DEFERRED = [
  "bookings.create",
  "amadeus.createFlightOrders",
  "amadeus.issueFlightOrder",
  "amadeus.patchFlightOrder",
  "amadeus.cancelFlightOrder",
];

/** The methods with the reviewed 60 s timeout of scripts/operation-overrides.json. */
const LONG_ACTIONS = ["bookings.issue", "bookings.cancel", "bookings.import", "bookings.retrieve"];

/** @typedef {import("../../src/index.js").VelexisClient} VelexisClient */
/** @typedef {import("../helpers/fake-fetch.js").RecordedRequest} RecordedRequest */
/** @typedef {import("../../src/internal/operations.js").Operation} Operation */
/** @typedef {{ operationId: string, status: number, body: Record<string, unknown> | undefined }} Example */

/**
 * The first documented 2xx response of every console operation of the contract, by its path below `console`, filled
 * in by the setup hook: its JSON example, or no body for `auth.signOut` (204).
 * @type {Map<string, Example>}
 */
const EXAMPLES = new Map();

/**
 * The problems the Ajv helper of @velexis/testing finds in each example, by method, filled in by the setup hook.
 * @type {Map<string, unknown[]>}
 */
const EXAMPLE_PROBLEMS = new Map();

/**
 * The example of one method.
 * @param {string} method the path below `console`, for example `bookings.get`
 * @returns {Example}
 */
function example(method) {
  const found = EXAMPLES.get(method);
  if (found === undefined) {
    throw new Error(`the OpenAPI document has no 2xx response for console.${method}`);
  }
  return found;
}

/**
 * A deep copy of an example body with some top-level fields replaced.
 * @param {string} method
 * @param {Record<string, unknown>} [changes]
 * @returns {Record<string, unknown>}
 */
const bodyOf = (method, changes = {}) => ({ ...structuredClone(example(method).body), ...changes });

/**
 * The canned answer of one method: its documented status and example.
 * @param {string} method
 */
function answerOf(method) {
  const { status, body } = example(method);
  return body === undefined ? { status } : { status, body: structuredClone(body) };
}

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
 * The first 2xx response of every console operation of a parsed document that the contract has (`console.settings.*`
 * and `console.payments.*` are MVP additions of SDK-012): its first JSON example, or no body when it has none.
 * @param {Record<string, any>} document
 * @returns {Map<string, Example>}
 */
function consoleExamplesOf(document) {
  /** @type {Map<string, Example>} */
  const examples = new Map();
  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      const sdkMethod = operation?.["x-sdk-method"];
      if (typeof sdkMethod !== "string" || !sdkMethod.startsWith("console.")) {
        continue;
      }
      const name = sdkMethod.slice("console.".length);
      if (!ALL_METHODS.includes(name)) {
        continue;
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        if (!/^2\d\d$/.test(status) || examples.has(name)) {
          continue;
        }
        const media = deref(document, response)?.content?.["application/json"];
        const first = Object.values(media?.examples ?? {})[0];
        const body = first === undefined ? media?.example : deref(document, first).value;
        examples.set(name, { operationId: operation.operationId, status: Number(status), body });
      }
    }
  }
  return examples;
}

/**
 * The setup hook parses the OTA document (about half a second alone) and compiles the response schemas of the examples
 * with Ajv; both take much longer while Turborepo runs every package's tests at once on a CI runner, so the hook gets
 * its own budget and the tests below only use the parsed examples and the validators' results.
 */
const SETUP_TIMEOUT_MS = 60_000;

beforeAll(() => {
  for (const [method, found] of consoleExamplesOf(parse(readFileSync(DOCUMENT, "utf8")))) {
    EXAMPLES.set(method, found);
  }
  const checker = responseChecker("ota");
  for (const [method, found] of EXAMPLES) {
    EXAMPLE_PROBLEMS.set(
      method,
      checker.check(found.operationId, { status: found.status, body: found.body }),
    );
  }
}, SETUP_TIMEOUT_MS);

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A server-mode client as the OTA admin builds it (OADR-0018 point 1): secret key, staff access token, staff session,
 * live environment.
 * @param {typeof globalThis.fetch} fetch
 * @param {Partial<import("../../src/index.js").VelexisClientOptions>} [extra]
 */
const staffClient = (fetch, extra = {}) =>
  createVelexisClient({
    secretKey: SK,
    accessToken: STAFF_AT,
    sessionKind: "staff",
    environment: "live",
    fetch,
    ...extra,
  });

/**
 * The method of a client at a dotted path (`console.bookings.get`), bound to nothing (namespace methods are arrows).
 * @param {object} client
 * @param {string} path
 * @returns {((params?: unknown, options?: unknown) => Promise<unknown>) | undefined}
 */
function methodAt(client, path) {
  /** @type {unknown} */
  let current = client;
  for (const name of path.split(".")) {
    current =
      current !== null && typeof current === "object"
        ? /** @type {Record<string, unknown>} */ (current)[name]
        : undefined;
  }
  return typeof current === "function"
    ? /** @type {(params?: unknown, options?: unknown) => Promise<unknown>} */ (current)
    : undefined;
}

describe("the canned responses", () => {
  it("are the documented 2xx responses of all 32 console operations and match their response schemas [SDK-011]", () => {
    expect([...EXAMPLES.keys()].sort()).toEqual([...ALL_METHODS].sort());
    // Every operation but sign-out (204, no body) has a JSON example.
    expect([...EXAMPLES].filter(([, found]) => found.body === undefined).map(([method]) => method)).toEqual([
      "auth.signOut",
    ]);
    expect(example("auth.signOut").status).toBe(204);
    expect(Object.fromEntries(EXAMPLE_PROBLEMS)).toEqual(
      Object.fromEntries(ALL_METHODS.map((method) => [method, []])),
    );
  });
});

describe("the console namespace", () => {
  it("offers the 32 methods of ConsoleApi in six sub-namespaces, each named by its x-sdk-method [SDK-011]", () => {
    const client = createVelexisClient({ secretKey: SK, fetch: createFakeFetch().fetch });

    expect(Object.keys(client.console)).toEqual(Object.keys(CONSOLE_METHODS));
    for (const [namespace, methods] of Object.entries(CONSOLE_METHODS)) {
      const api = /** @type {Record<string, unknown>} */ (
        client.console[/** @type {keyof VelexisClient["console"]} */ (namespace)]
      );
      expect(Object.keys(api), namespace).toEqual(methods);
    }
    expect(ALL_METHODS).toHaveLength(32);
    for (const method of ALL_METHODS) {
      expect(typeof methodAt(client.console, method), method).toBe("function");
      expect(op, method).toHaveProperty(`console_${method.replace(/\./g, "_")}`);
    }
  });

  it("is rebuilt by withOptions on the new client's options [SDK-011]", async () => {
    const fake = createFakeFetch([answerOf("auth.me")]);
    const client = staffClient(fake.fetch);

    await client.withOptions({ environment: "test" }).console.auth.me();

    expect(fake.requests[0]?.headers["x-velexis-environment"]).toBe("test");
    expect(Object.keys(client.withOptions({ locale: "de-DE" }).console)).toEqual(
      Object.keys(CONSOLE_METHODS),
    );
  });
});

/**
 * One method called with sample parameters, and the request it must send.
 * @typedef {object} RouteCase
 * @property {string} method the path of the method below `console`
 * @property {(client: VelexisClient) => Promise<unknown>} call
 * @property {"GET" | "POST" | "PATCH" | "DELETE"} http
 * @property {string} path the path with its parameters filled in
 * @property {[string, string][]} query the decoded query parameters, in order
 * @property {Record<string, unknown>} [body] the JSON body; none when absent
 * @property {Record<string, string>} [headers] headers the call must carry besides the common ones
 */

const MONEY = { amount: "120.00", currency: "EUR" };
const AMADEUS_OFFER = { type: "flight-offer", id: "1", source: "GDS" };

/** @type {RouteCase[]} */
const CASES = [
  {
    method: "auth.signIn",
    call: (client) => client.console.auth.signIn({ grantType: "portal_token", portalToken: PORTAL_TOKEN }),
    http: "POST",
    path: "/v1/console/auth/sign-in",
    query: [],
    body: { grantType: "portal_token", portalToken: PORTAL_TOKEN },
  },
  {
    method: "auth.refresh",
    call: (client) => client.console.auth.refresh({ refreshToken: STAFF_RT }),
    http: "POST",
    path: "/v1/console/auth/refresh",
    query: [],
    body: { refreshToken: STAFF_RT },
  },
  {
    method: "auth.signOut",
    call: (client) => client.console.auth.signOut({ scope: "all" }),
    http: "POST",
    path: "/v1/console/auth/sign-out",
    query: [],
    body: { scope: "all" },
  },
  {
    method: "auth.me",
    call: (client) => client.console.auth.me(),
    http: "GET",
    path: "/v1/console/auth/me",
    query: [],
  },
  {
    method: "bookings.list",
    call: (client) =>
      client.console.bookings.list({
        status: ["confirmed", "partially_ticketed"],
        ticketingStatus: ["failed", "manual_review"],
        ticketingDeadlineBefore: "2026-11-02T00:00:00Z",
        customerEmail: "anna.berg@example.com",
        paymentStatus: ["authorized"],
        source: ["storefront", "import"],
        q: "BERG",
        sort: "ticketingDeadline",
        cursor: "cur_1",
        limit: 50,
      }),
    http: "GET",
    path: "/v1/console/bookings",
    query: [
      ["status", "confirmed,partially_ticketed"],
      ["ticketingStatus", "failed,manual_review"],
      ["ticketingDeadlineBefore", "2026-11-02T00:00:00Z"],
      ["customerEmail", "anna.berg@example.com"],
      ["paymentStatus", "authorized"],
      ["source", "storefront,import"],
      ["q", "BERG"],
      ["sort", "ticketingDeadline"],
      ["cursor", "cur_1"],
      ["limit", "50"],
    ],
  },
  {
    method: "bookings.get",
    call: (client) =>
      client.console.bookings.get({
        bookingId: BOOKING_ID,
        refresh: true,
        include: ["bags"],
        fareRules: ["rebooks", "refunds"],
      }),
    http: "GET",
    path: `/v1/console/bookings/${BOOKING_ID}`,
    query: [
      ["refresh", "true"],
      ["include", "bags"],
      ["fareRules", "rebooks,refunds"],
    ],
  },
  {
    method: "bookings.findByRecordLocator",
    call: (client) =>
      client.console.bookings.findByRecordLocator({
        reference: "L2P9XC",
        originSystemCode: "GDS",
        include: ["bags"],
      }),
    http: "GET",
    path: "/v1/console/bookings/by-record-locator",
    query: [
      ["reference", "L2P9XC"],
      ["originSystemCode", "GDS"],
      ["include", "bags"],
    ],
  },
  {
    method: "bookings.import",
    call: (client) =>
      client.console.bookings.import({
        reference: "L2P9XC",
        originSystemCode: "GDS",
        customerId: CUSTOMER_ID,
        pricing: { mode: "markup_rules" },
        reason: "Terminal booking",
      }),
    http: "POST",
    path: "/v1/console/bookings/imports",
    query: [],
    body: {
      reference: "L2P9XC",
      originSystemCode: "GDS",
      customerId: CUSTOMER_ID,
      pricing: { mode: "markup_rules" },
      reason: "Terminal booking",
    },
  },
  {
    method: "bookings.retrieve",
    call: (client) =>
      client.console.bookings.retrieve({
        bookingId: BOOKING_ID,
        include: ["bags"],
        fareRules: ["refunds"],
        updateSnapshot: false,
      }),
    http: "GET",
    path: `/v1/console/bookings/${BOOKING_ID}/amadeus-order`,
    query: [
      ["include", "bags"],
      ["fareRules", "refunds"],
      ["updateSnapshot", "false"],
    ],
  },
  {
    method: "bookings.create",
    call: (client) =>
      client.console.bookings.create(
        /** @type {never} */ ({
          pricedOfferId: "prc_01JA4D7F3J6M9P2S5V8Y1B4E7H",
          customerId: CUSTOMER_ID,
          pricing: { mode: "markup_rules" },
          reason: "Phone booking",
        }),
      ),
    http: "POST",
    path: "/v1/console/bookings",
    query: [],
    body: {
      pricedOfferId: "prc_01JA4D7F3J6M9P2S5V8Y1B4E7H",
      customerId: CUSTOMER_ID,
      pricing: { mode: "markup_rules" },
      reason: "Phone booking",
    },
  },
  {
    method: "bookings.patch",
    call: (client) =>
      client.console.bookings.patch({
        bookingId: BOOKING_ID,
        ifMatch: 7,
        ticketingAgreement: { option: "DELAY_TO_QUEUE", delay: "1D" },
        reason: "Customer pays tomorrow",
      }),
    http: "PATCH",
    path: `/v1/console/bookings/${BOOKING_ID}`,
    query: [],
    body: { ticketingAgreement: { option: "DELAY_TO_QUEUE", delay: "1D" }, reason: "Customer pays tomorrow" },
    headers: { "if-match": '"7"' },
  },
  {
    method: "bookings.issue",
    call: (client) =>
      client.console.bookings.issue({
        bookingId: BOOKING_ID,
        ifMatch: '"8"',
        formOfPayments: [{ other: { method: "CASH", flightOfferIds: ["1"] } }],
        reason: "Payment received",
      }),
    http: "POST",
    path: `/v1/console/bookings/${BOOKING_ID}/issuance`,
    query: [],
    body: {
      formOfPayments: [{ other: { method: "CASH", flightOfferIds: ["1"] } }],
      reason: "Payment received",
    },
    headers: { "if-match": '"8"' },
  },
  {
    method: "bookings.cancel",
    call: (client) =>
      client.console.bookings.cancel({
        bookingId: BOOKING_ID,
        ifMatch: 9,
        reasonCode: "customer_request",
        reason: "Trip cancelled",
        refund: { mode: "amount", amount: MONEY },
        notifyCustomer: true,
      }),
    http: "POST",
    path: `/v1/console/bookings/${BOOKING_ID}/cancellation`,
    query: [],
    body: {
      reasonCode: "customer_request",
      reason: "Trip cancelled",
      refund: { mode: "amount", amount: MONEY },
      notifyCustomer: true,
    },
    headers: { "if-match": '"9"' },
  },
  {
    method: "bookings.resync",
    call: (client) => client.console.bookings.resync({ bookingId: BOOKING_ID, include: ["bags"] }),
    http: "POST",
    path: `/v1/console/bookings/${BOOKING_ID}/resync`,
    query: [],
    body: { include: ["bags"] },
  },
  {
    method: "bookings.addNote",
    call: (client) =>
      client.console.bookings.addNote({
        bookingId: BOOKING_ID,
        text: "Called the customer",
        visibleToCustomer: false,
      }),
    http: "POST",
    path: `/v1/console/bookings/${BOOKING_ID}/notes`,
    query: [],
    body: { text: "Called the customer", visibleToCustomer: false },
  },
  {
    method: "queues.list",
    call: (client) =>
      client.console.queues.list({ queueId: 50, category: 0, officeId: "NCE1A0950", max: 100, limit: 50 }),
    http: "GET",
    path: "/v1/console/queues/50",
    query: [
      ["category", "0"],
      ["officeId", "NCE1A0950"],
      ["max", "100"],
      ["limit", "50"],
    ],
  },
  {
    method: "queues.listSnapshots",
    call: (client) =>
      client.console.queues.listSnapshots({
        queueId: 50,
        officeId: "NCE1A0950",
        include: ["items"],
        limit: 10,
      }),
    http: "GET",
    path: "/v1/console/queue-snapshots",
    query: [
      ["queueId", "50"],
      ["officeId", "NCE1A0950"],
      ["include", "items"],
      ["limit", "10"],
    ],
  },
  {
    method: "customers.list",
    call: (client) =>
      client.console.customers.list({
        q: "berg",
        status: ["active", "disabled"],
        hasBookings: true,
        sort: "-lastBooking",
        limit: 25,
      }),
    http: "GET",
    path: "/v1/console/customers",
    query: [
      ["q", "berg"],
      ["status", "active,disabled"],
      ["hasBookings", "true"],
      ["sort", "-lastBooking"],
      ["limit", "25"],
    ],
  },
  {
    method: "customers.get",
    call: (client) => client.console.customers.get({ customerId: CUSTOMER_ID }),
    http: "GET",
    path: `/v1/console/customers/${CUSTOMER_ID}`,
    query: [],
  },
  {
    method: "supplierRequests.list",
    call: (client) =>
      client.console.supplierRequests.list({
        bookingId: BOOKING_ID,
        amadeusApi: ["flight_order_management"],
        outcome: ["client_error", "server_error"],
        errorCode: 4926,
        includeBodies: true,
        limit: 20,
      }),
    http: "GET",
    path: "/v1/console/supplier-requests",
    query: [
      ["bookingId", BOOKING_ID],
      ["amadeusApi", "flight_order_management"],
      ["outcome", "client_error,server_error"],
      ["errorCode", "4926"],
      ["includeBodies", "true"],
      ["limit", "20"],
    ],
  },
  {
    method: "amadeus.searchFlightOffers",
    call: (client) =>
      client.console.amadeus.searchFlightOffers(
        /** @type {never} */ ({
          amadeus: { currencyCode: "EUR", travelers: [{ id: "1", travelerType: "ADULT" }], sources: ["GDS"] },
          reason: "Corporate request",
        }),
      ),
    http: "POST",
    path: "/v1/console/amadeus/v2/shopping/flight-offers",
    query: [],
    body: {
      amadeus: { currencyCode: "EUR", travelers: [{ id: "1", travelerType: "ADULT" }], sources: ["GDS"] },
      reason: "Corporate request",
    },
  },
  {
    method: "amadeus.getFlightOffers",
    call: (client) =>
      client.console.amadeus.getFlightOffers({
        originLocationCode: "PAR",
        destinationLocationCode: "NYC",
        departureDate: "2026-11-20",
        adults: 1,
        includedAirlineCodes: ["AF", "DL"],
        excludedAirlineCodes: "BA",
        nonStop: false,
        max: 10,
      }),
    http: "GET",
    path: "/v1/console/amadeus/v2/shopping/flight-offers",
    query: [
      ["originLocationCode", "PAR"],
      ["destinationLocationCode", "NYC"],
      ["departureDate", "2026-11-20"],
      ["adults", "1"],
      ["includedAirlineCodes", "AF,DL"],
      ["excludedAirlineCodes", "BA"],
      ["nonStop", "false"],
      ["max", "10"],
    ],
  },
  {
    method: "amadeus.searchFlightAvailabilities",
    call: (client) =>
      client.console.amadeus.searchFlightAvailabilities(
        /** @type {never} */ ({
          amadeus: { travelers: [{ id: "1", travelerType: "ADULT" }], sources: ["GDS"] },
        }),
      ),
    http: "POST",
    path: "/v1/console/amadeus/v1/shopping/availability/flight-availabilities",
    query: [],
    body: { amadeus: { travelers: [{ id: "1", travelerType: "ADULT" }], sources: ["GDS"] } },
  },
  {
    method: "amadeus.upsellAirOffers",
    call: (client) =>
      client.console.amadeus.upsellAirOffers(
        /** @type {never} */ ({
          amadeus: { data: { type: "flight-offer-upsell", flightOffers: [AMADEUS_OFFER] } },
        }),
      ),
    http: "POST",
    path: "/v1/console/amadeus/v1/shopping/flight-offers/upselling",
    query: [],
    body: { amadeus: { data: { type: "flight-offer-upsell", flightOffers: [AMADEUS_OFFER] } } },
  },
  {
    method: "amadeus.quoteAirOffers",
    call: (client) =>
      client.console.amadeus.quoteAirOffers(
        /** @type {never} */ ({
          include: ["credit-card-fees", "bags"],
          forceClass: false,
          amadeus: { data: { type: "flight-offer-pricing", flightOffers: [AMADEUS_OFFER] } },
        }),
      ),
    http: "POST",
    path: "/v1/console/amadeus/v1/shopping/flight-offers/pricing",
    query: [
      ["include", "credit-card-fees,bags"],
      ["forceClass", "false"],
    ],
    body: { amadeus: { data: { type: "flight-offer-pricing", flightOffers: [AMADEUS_OFFER] } } },
  },
  {
    method: "amadeus.createFlightOrders",
    call: (client) =>
      client.console.amadeus.createFlightOrders(
        /** @type {never} */ ({
          issue: false,
          importAsBooking: true,
          reason: "Group fare",
          amadeus: { data: { type: "flight-order", flightOffers: [AMADEUS_OFFER] } },
        }),
      ),
    http: "POST",
    path: "/v1/console/amadeus/v1/booking/flight-orders",
    query: [["issue", "false"]],
    body: {
      importAsBooking: true,
      reason: "Group fare",
      amadeus: { data: { type: "flight-order", flightOffers: [AMADEUS_OFFER] } },
    },
  },
  {
    method: "amadeus.issueFlightOrder",
    call: (client) =>
      client.console.amadeus.issueFlightOrder({ flightOrderId: FLIGHT_ORDER_ID, reason: "NDC cash" }),
    http: "POST",
    path: `/v1/console/amadeus/v1/booking/flight-orders/${FLIGHT_ORDER_ID}/issuance`,
    query: [],
    body: { reason: "NDC cash" },
  },
  {
    method: "amadeus.getFlightOrder",
    call: (client) =>
      client.console.amadeus.getFlightOrder({
        flightOrderId: FLIGHT_ORDER_ID,
        include: ["bags"],
        fareRules: ["rebooks", "refunds"],
      }),
    http: "GET",
    path: `/v1/console/amadeus/v1/booking/flight-orders/${FLIGHT_ORDER_ID}`,
    query: [
      ["include", "bags"],
      ["fareRules", "rebooks,refunds"],
    ],
  },
  {
    method: "amadeus.patchFlightOrder",
    call: (client) =>
      client.console.amadeus.patchFlightOrder(
        /** @type {never} */ ({
          flightOrderId: FLIGHT_ORDER_ID,
          amadeus: { data: { type: "flight-order", ownerOfficeId: "PAR1A2100" } },
          reason: "Transfer ownership",
        }),
      ),
    http: "PATCH",
    path: `/v1/console/amadeus/v1/booking/flight-orders/${FLIGHT_ORDER_ID}`,
    query: [],
    body: {
      amadeus: { data: { type: "flight-order", ownerOfficeId: "PAR1A2100" } },
      reason: "Transfer ownership",
    },
  },
  {
    method: "amadeus.cancelFlightOrder",
    call: (client) =>
      client.console.amadeus.cancelFlightOrder({
        flightOrderId: FLIGHT_ORDER_ID,
        reason: "Duplicate test order",
      }),
    http: "DELETE",
    path: `/v1/console/amadeus/v1/booking/flight-orders/${FLIGHT_ORDER_ID}`,
    query: [["reason", "Duplicate test order"]],
  },
  {
    method: "amadeus.getFlightOrderByReference",
    call: (client) =>
      client.console.amadeus.getFlightOrderByReference({
        reference: "K7M2QF",
        originSystemCode: "1A",
        include: ["bags"],
      }),
    http: "GET",
    path: "/v1/console/amadeus/v1/booking/flight-orders/by-reference",
    query: [
      ["reference", "K7M2QF"],
      ["originSystemCode", "1A"],
      ["include", "bags"],
    ],
  },
  {
    method: "amadeus.getQueue",
    call: (client) =>
      client.console.amadeus.getQueue({ queueId: 50, max: 5, category: 0, officeId: "NCE1A0950" }),
    http: "GET",
    path: "/v1/console/amadeus/office/queues/50",
    query: [
      ["max", "5"],
      ["category", "0"],
      ["officeId", "NCE1A0950"],
    ],
  },
];

/**
 * The route-table entry of a console method.
 * @param {string} method the path below `console`
 * @returns {Operation}
 */
const entryOf = (method) => op[/** @type {keyof typeof op} */ (`console_${method.replace(/\./g, "_")}`)];

describe("each console method sends the request of its route-table entry", () => {
  it("covers all 32 methods [SDK-011]", () => {
    expect(CASES.map((testCase) => testCase.method).sort()).toEqual([...ALL_METHODS].sort());
  });

  it.each(CASES)(
    "console.$method → $http $path, with X-Velexis-Environment: live [SDK-011 AC2]",
    async (testCase) => {
      const entry = entryOf(testCase.method);
      const answer = answerOf(testCase.method);
      const fake = createFakeFetch([answer]);
      const client = staffClient(fake.fetch);

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
      // The body: the params that are not path, query or header params, as JSON (never `ifMatch`); none for a GET or
      // DELETE.
      if (testCase.body === undefined) {
        expect(request.body).toBeNull();
        expect(request.headers).not.toHaveProperty("content-type");
      } else {
        expect(request.json).toEqual(testCase.body);
        expect(request.headers["content-type"]).toBe("application/json");
      }
      // The headers: the secret key, the staff token, the client's environment (every console operation takes it),
      // one generated Idempotency-Key where the operation takes one, If-Match only where the operation requires it.
      expect(entry.environment).toBe(true);
      expect(request.headers).toMatchObject({
        accept: "application/json",
        "x-api-key": SK,
        authorization: `Bearer ${STAFF_AT}`,
        "x-velexis-environment": "live",
        ...testCase.headers,
      });
      if (entry.idempotency === "none") {
        expect(request.headers).not.toHaveProperty("idempotency-key");
      } else {
        expect(request.headers["idempotency-key"]).toMatch(UUID_V4);
      }
      expect(Boolean(testCase.headers?.["if-match"])).toBe("ifMatch" in entry.headerParams);
      expect(request.headers).not.toHaveProperty("x-booking-token");
      // Console data is personal and live: no-store unless the call chooses a cache mode itself.
      expect(request.init.cache).toBe("no-store");
      // The result: the response body, a Page of it for a list, nothing for a 204.
      if (entry.queryParams.includes("cursor")) {
        expect(result).toBeInstanceOf(Page);
        expect(JSON.parse(JSON.stringify(result))).toEqual(answer.body);
      } else if (answer.body === undefined) {
        expect(result).toBeUndefined();
      } else {
        expect(result).toEqual(answer.body);
      }
    },
  );
});

describe("the environment header", () => {
  /**
   * Sample params for any route-table entry: every path param, `ifMatch` for the operations that require it.
   * @param {Operation} entry
   */
  const paramsFor = (entry) => ({
    ...Object.fromEntries(entry.pathParams.map((name) => [name, `x_${name}`])),
    ...("ifMatch" in entry.headerParams ? { ifMatch: 1 } : {}),
  });

  it("goes on every console request and on no customer request of a live server-mode client [SDK-011 AC2]", async () => {
    const fake = createFakeFetch();
    const client = staffClient(fake.fetch);
    // Every method of the client, by its x-sdk-method (the route-table key with dots), with its entry.
    const methods = Object.entries(op).flatMap(([key, entry]) => {
      const name = key.replace(/_/g, ".");
      const method = methodAt(client, name);
      return method === undefined ? [] : [{ name, entry, method }];
    });
    const consoleMethods = methods.filter(({ name }) => name.startsWith("console."));
    const customerMethods = methods.filter(({ entry }) => !entry.environment);
    expect(consoleMethods.map(({ name }) => name.slice("console.".length)).sort()).toEqual(
      [...ALL_METHODS].sort(),
    );
    // Besides console.*, only the console's availability search (x-scope: console) takes the header.
    expect(
      methods
        .filter(({ name, entry }) => entry.environment && !name.startsWith("console."))
        .map(({ name }) => name),
    ).toEqual(["flights.availability"]);
    expect(customerMethods.length).toBeGreaterThan(30);

    for (const { method, entry } of [...consoleMethods, ...customerMethods]) {
      fake.enqueue({ status: 200, body: {} });
      await method(paramsFor(entry));
    }

    expect(fake.requests).toHaveLength(consoleMethods.length + customerMethods.length);
    const headers = fake.requests.map((request) => request.headers["x-velexis-environment"]);
    expect(headers.slice(0, consoleMethods.length)).toEqual(consoleMethods.map(() => "live"));
    expect(headers.slice(consoleMethods.length)).toEqual(customerMethods.map(() => undefined));
    expect(
      fake.requests.slice(consoleMethods.length).filter((request) => request.path.startsWith("/v1/console/")),
    ).toEqual([]);
  });

  it("is not sent without the environment option, nor overridden per call [SDK-011 AC2]", async () => {
    const fake = createFakeFetch([answerOf("auth.me"), answerOf("auth.me"), answerOf("bookings.get")]);
    const plain = createVelexisClient({
      secretKey: SK,
      accessToken: STAFF_AT,
      sessionKind: "staff",
      fetch: fake.fetch,
    });
    const live = staffClient(fake.fetch);

    await plain.console.auth.me();
    await staffClient(fake.fetch, { environment: "test" }).console.auth.me();
    // A call's own header does not switch a live client to another environment: the operation's header wins.
    await live.console.bookings.get(
      { bookingId: BOOKING_ID },
      { headers: { "X-Velexis-Environment": "test" } },
    );
    // RequestOptions has no environment of its own.
    await expect(
      live.console.auth.me(undefined, /** @type {never} */ ({ environment: "test" })),
    ).rejects.toThrow(new TypeError('Velexis SDK: unknown request option "environment"'));

    expect(fake.requests.map((request) => request.headers["x-velexis-environment"])).toEqual([
      undefined,
      "test",
      "live",
    ]);
  });
});

describe("the lists", () => {
  it("bookings.list returns a Page that keeps totalCount and iterates across cursors with the same filters [SDK-011]", async () => {
    const [summary] = /** @type {Record<string, unknown>[]} */ (bodyOf("bookings.list")["data"]);
    /** @param {string} id */
    const row = (id) => ({ ...structuredClone(summary), id });
    const pages = [
      bodyOf("bookings.list", {
        data: [row("bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2")],
        page: { nextCursor: "cur_2", limit: 1 },
        totalCount: 2,
      }),
      bodyOf("bookings.list", {
        data: [row("bkg_01JA4CH3G1K4N7R0U3X6A9D2F5")],
        page: { nextCursor: null, limit: 1 },
        totalCount: 2,
      }),
    ];
    const checker = responseChecker("ota");
    for (const body of pages) {
      expect(checker.check("consoleListBookings", { status: 200, body })).toEqual([]);
    }
    const fake = createFakeFetch(pages.map((body) => ({ body })));
    const client = staffClient(fake.fetch);

    const page = await client.console.bookings.list({ status: ["confirmed"], sort: "-created", limit: 1 });

    expect(page).toBeInstanceOf(Page);
    expect(page.totalCount).toBe(2);
    expect(page.page).toEqual({ nextCursor: "cur_2", limit: 1 });
    /** @type {string[]} */
    const ids = [];
    for await (const booking of page) {
      ids.push(booking.id);
    }
    expect(ids).toEqual(["bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2", "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5"]);
    expect(fake.requests.map((request) => [...request.searchParams])).toEqual([
      [
        ["status", "confirmed"],
        ["sort", "-created"],
        ["limit", "1"],
      ],
      [
        ["status", "confirmed"],
        ["sort", "-created"],
        ["cursor", "cur_2"],
        ["limit", "1"],
      ],
    ]);
    for (const request of fake.requests) {
      expect(request.headers["x-velexis-environment"]).toBe("live");
      expect(request.headers.authorization).toBe(`Bearer ${STAFF_AT}`);
      expect(request.init.cache).toBe("no-store");
    }
  });

  it("queues.list keeps the snapshot and the warnings, and next() pages the stored snapshot by cursor [SDK-011]", async () => {
    const first = bodyOf("queues.list");
    const items = /** @type {unknown[]} */ (first["data"]);
    const pages = [
      { ...first, data: items.slice(0, 1), page: { nextCursor: "cur_q2", limit: 1 } },
      { ...structuredClone(first), data: items.slice(0, 1), page: { nextCursor: null, limit: 1 } },
    ];
    const checker = responseChecker("ota");
    for (const body of pages) {
      expect(checker.check("consoleListQueue", { status: 200, body })).toEqual([]);
    }
    const fake = createFakeFetch(pages.map((body) => ({ body })));
    const client = staffClient(fake.fetch);

    const page = await client.console.queues.list({ queueId: 50, category: 0, limit: 1 });
    const second = await page.next();

    expect(page.snapshot).toEqual(first["snapshot"]);
    expect(page.warnings).toEqual(first["warnings"]);
    expect(second?.snapshot).toEqual(first["snapshot"]);
    expect(await second?.next()).toBeNull();
    expect(fake.requests.map((request) => `${request.path}?${request.searchParams}`)).toEqual([
      "/v1/console/queues/50?category=0&limit=1",
      "/v1/console/queues/50?category=0&cursor=cur_q2&limit=1",
    ]);
  });

  it("the other lists resolve with a Page without params too [SDK-011]", async () => {
    const fake = createFakeFetch([
      answerOf("queues.listSnapshots"),
      answerOf("customers.list"),
      answerOf("supplierRequests.list"),
      answerOf("bookings.list"),
    ]);
    const client = staffClient(fake.fetch);

    const pages = [
      await client.console.queues.listSnapshots(),
      await client.console.customers.list(),
      await client.console.supplierRequests.list(),
      await client.console.bookings.list(),
    ];

    for (const page of pages) {
      expect(page).toBeInstanceOf(Page);
    }
    expect(fake.requests.map((request) => request.url)).toEqual([
      `${BASE_URL}/v1/console/queue-snapshots`,
      `${BASE_URL}/v1/console/customers`,
      `${BASE_URL}/v1/console/supplier-requests`,
      `${BASE_URL}/v1/console/bookings`,
    ]);
  });
});

describe("ifMatch on bookings.patch, bookings.issue and bookings.cancel", () => {
  it("is sent as If-Match: a version number as its ETag, a string as it is, and never in the body [SDK-011]", async () => {
    const booking = bodyOf("bookings.get");
    const fake = createFakeFetch(Array.from({ length: 4 }, () => ({ body: booking })));
    const client = staffClient(fake.fetch);

    await client.console.bookings.patch({
      bookingId: BOOKING_ID,
      ifMatch: 0,
      tags: ["vip"],
      reason: "Re-tag",
    });
    await client.console.bookings.patch({
      bookingId: BOOKING_ID,
      ifMatch: '"12"',
      tags: ["vip"],
      reason: "Re-tag",
    });
    await client.console.bookings.issue({ bookingId: BOOKING_ID, ifMatch: 12, reason: "Paid" });
    await client.console.bookings.cancel({
      bookingId: BOOKING_ID,
      ifMatch: 'W/"12"',
      reasonCode: "other",
      reason: "Test",
    });

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
    "refuses an ifMatch that is %s with a TypeError before any request [SDK-011]",
    async (_label, ifMatch) => {
      const fake = createFakeFetch();
      const client = staffClient(fake.fetch);
      const params = /** @type {never} */ ({ bookingId: BOOKING_ID, ifMatch });

      for (const call of [
        () => client.console.bookings.patch({ .../** @type {object} */ (params), tags: [] }),
        () => client.console.bookings.issue({ .../** @type {object} */ (params) }),
        () =>
          client.console.bookings.cancel({
            .../** @type {object} */ (params),
            reasonCode: "other",
            reason: "Test",
          }),
      ]) {
        const error = await call().catch((/** @type {unknown} */ caught) => caught);
        expect(error).toBeInstanceOf(TypeError);
        expect(/** @type {TypeError} */ (error).message).toMatch(
          /^Velexis SDK: (PATCH|POST) \/v1\/console\/bookings\/\{bookingId\}(\/[a-z]+)? needs "ifMatch", the booking version \(a whole number\) or its ETag \(a string\)$/,
        );
      }
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("leaves a stale version to the API: PRECONDITION_FAILED is a VelexisError and the PATCH is not retried [SDK-011]", async () => {
    const fake = createFakeFetch([errorResponse(412, "PRECONDITION_FAILED")]);
    const client = staffClient(fake.fetch, { maxRetries: 2 });

    const error = await client.console.bookings
      .patch({ bookingId: BOOKING_ID, ifMatch: 2, tags: ["late"], reason: "Re-tag" })
      .catch((/** @type {unknown} */ caught) => caught);

    expect(error).toBeInstanceOf(VelexisError);
    expect(error).toMatchObject({ code: "PRECONDITION_FAILED", status: 412 });
    expect(fake.requests).toHaveLength(1);
  });
});

describe("the record-locator lookups", () => {
  it("send originSystemCode GDS when the call leaves it out, and the caller's value otherwise [SDK-011]", async () => {
    const fake = createFakeFetch([
      answerOf("bookings.findByRecordLocator"),
      answerOf("amadeus.getFlightOrderByReference"),
      answerOf("bookings.findByRecordLocator"),
      answerOf("amadeus.getFlightOrderByReference"),
    ]);
    const client = staffClient(fake.fetch);
    const params = { reference: "L2P9XC" };

    await client.console.bookings.findByRecordLocator(params);
    await client.console.amadeus.getFlightOrderByReference({ reference: "K7M2QF", include: ["bags"] });
    await client.console.bookings.findByRecordLocator({ reference: "L2P9XC", originSystemCode: "1A" });
    await client.console.amadeus.getFlightOrderByReference({ reference: "K7M2QF", originSystemCode: "1A" });

    expect(fake.requests.map((request) => `${request.path}?${request.searchParams}`)).toEqual([
      "/v1/console/bookings/by-record-locator?reference=L2P9XC&originSystemCode=GDS",
      "/v1/console/amadeus/v1/booking/flight-orders/by-reference?reference=K7M2QF&originSystemCode=GDS&include=bags",
      "/v1/console/bookings/by-record-locator?reference=L2P9XC&originSystemCode=1A",
      "/v1/console/amadeus/v1/booking/flight-orders/by-reference?reference=K7M2QF&originSystemCode=1A",
    ]);
    // The caller's params are not changed.
    expect(params).toEqual({ reference: "L2P9XC" });
  });
});

describe("timeouts", () => {
  it.each(LONG_ACTIONS)(
    "console.%s waits 60 s before it times out (the reviewed long action) [SDK-011]",
    async (method) => {
      vi.useFakeTimers();
      const fake = createFakeFetch([{ delayMs: Number.POSITIVE_INFINITY }]);
      const client = staffClient(fake.fetch, { maxRetries: 0 });
      const testCase = /** @type {RouteCase} */ (CASES.find((candidate) => candidate.method === method));
      expect(entryOf(method).timeoutMs).toBe(60_000);

      const pending = testCase.call(client).catch((/** @type {unknown} */ caught) => caught);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fake.requests[0]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const error = await pending;
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error).toMatchObject({ code: "TIMEOUT", status: 0 });
      expect(fake.requests).toHaveLength(1);
    },
  );

  it("keeps the client's 30 s for the other console methods, and options.timeoutMs wins [SDK-011]", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch([
      { delayMs: Number.POSITIVE_INFINITY },
      { delayMs: Number.POSITIVE_INFINITY },
    ]);
    const client = staffClient(fake.fetch, { maxRetries: 0 });

    const get = client.console.bookings
      .get({ bookingId: BOOKING_ID })
      .catch((/** @type {unknown} */ caught) => caught);
    const issue = client.console.bookings
      .issue({ bookingId: BOOKING_ID, ifMatch: 1 }, { timeoutMs: 90_000 })
      .catch((/** @type {unknown} */ caught) => caught);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await get).toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.requests[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await issue).toMatchObject({ code: "TIMEOUT" });
  });
});

describe("retries", () => {
  it("bookings.issue retries a 503 with the same Idempotency-Key and If-Match; bookings.patch is not retried [SDK-011]", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch([
      errorResponse(503, "SERVICE_UNAVAILABLE", { headers: { "retry-after": "1" } }),
      answerOf("bookings.issue"),
      errorResponse(503, "SERVICE_UNAVAILABLE", { headers: { "retry-after": "1" } }),
    ]);
    const client = staffClient(fake.fetch);

    const issued = client.console.bookings.issue(
      { bookingId: BOOKING_ID, ifMatch: 5, reason: "Paid" },
      { idempotencyKey: `issue-${BOOKING_ID}-5` },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(issued).resolves.toEqual(example("bookings.issue").body);
    const patched = await client.console.bookings
      .patch({ bookingId: BOOKING_ID, ifMatch: 6, tags: ["vip"], reason: "Re-tag" })
      .catch((/** @type {unknown} */ caught) => caught);

    expect(fake.requests.slice(0, 2).map((request) => request.headers["idempotency-key"])).toEqual([
      `issue-${BOOKING_ID}-5`,
      `issue-${BOOKING_ID}-5`,
    ]);
    expect(fake.requests.slice(0, 2).map((request) => request.headers["if-match"])).toEqual(['"5"', '"5"']);
    expect(patched).toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    expect(fake.requests).toHaveLength(3);
  });
});

describe("staff sessions", () => {
  it("refresh through console.auth.refresh with sessionKind staff, in the live environment, and retry with the same key [SDK-011]", async () => {
    const refreshed = bodyOf("auth.refresh");
    const staffSession = {
      ...refreshed,
      session: {
        .../** @type {Record<string, unknown>} */ (refreshed["session"]),
        accessToken: NEW_STAFF_AT,
        refreshToken: NEW_STAFF_RT,
      },
    };
    expect(
      responseChecker("ota").check("consoleRefreshSession", { status: 200, body: staffSession }),
    ).toEqual([]);
    const fake = createFakeFetch([
      errorResponse(401, "TOKEN_EXPIRED"),
      { body: staffSession },
      answerOf("bookings.addNote"),
    ]);
    const onSessionRefreshed = vi.fn();
    const onStaffSessionRefreshed = vi.fn();
    const client = staffClient(fake.fetch, {
      refreshToken: STAFF_RT,
      onSessionRefreshed,
      onStaffSessionRefreshed,
    });

    const note = await client.console.bookings.addNote({
      bookingId: BOOKING_ID,
      text: "Called the customer",
    });

    expect(note).toEqual(example("bookings.addNote").body);
    const [first, refresh, retry] = /** @type {RecordedRequest[]} */ (fake.requests);
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST /v1/console/bookings/${BOOKING_ID}/notes`,
      "POST /v1/console/auth/refresh",
      `POST /v1/console/bookings/${BOOKING_ID}/notes`,
    ]);
    // The refresh carries the key and the environment, never the expired access token.
    expect(refresh?.json).toEqual({ refreshToken: STAFF_RT });
    expect(refresh?.headers).toMatchObject({ "x-api-key": SK, "x-velexis-environment": "live" });
    expect(refresh?.headers).not.toHaveProperty("authorization");
    // The retry sends the new token and the first attempt's Idempotency-Key.
    expect(retry?.headers.authorization).toBe(`Bearer ${NEW_STAFF_AT}`);
    expect(retry?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
    expect(retry?.headers["x-velexis-environment"]).toBe("live");
    expect(onSessionRefreshed).toHaveBeenCalledWith(staffSession.session);
    expect(onStaffSessionRefreshed).toHaveBeenCalledWith(staffSession);
  });

  it("an explicit console.auth.refresh sends the given token with the key only and leaves the client's tokens [SDK-011]", async () => {
    const fake = createFakeFetch([answerOf("auth.refresh"), answerOf("auth.me")]);
    const client = createVelexisClient({ secretKey: SK, environment: "live", fetch: fake.fetch });

    const session = await client.console.auth.refresh({ refreshToken: STAFF_RT });
    await client.console.auth.me(undefined, { accessToken: STAFF_AT });

    expect(session).toEqual(example("auth.refresh").body);
    expect(fake.requests[0]?.headers).not.toHaveProperty("authorization");
    expect(fake.requests[0]?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(fake.requests[1]?.headers.authorization).toBe(`Bearer ${STAFF_AT}`);
  });
});

describe("deferred methods", () => {
  it.each(DEFERRED)(
    "console.%s surfaces 501 NOT_IMPLEMENTED as a ServerError and sends one request [SDK-011]",
    async (name) => {
      const fake = createFakeFetch([
        errorResponse(501, "NOT_IMPLEMENTED", { details: { milestone: "deferred" } }),
      ]);
      const client = staffClient(fake.fetch, { maxRetries: 2 });
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
  it("is no-store unless the call chooses cache or next [SDK-011]", async () => {
    const fake = createFakeFetch(Array.from({ length: 3 }, () => answerOf("customers.get")));
    const client = staffClient(fake.fetch);

    await client.console.customers.get({ customerId: CUSTOMER_ID });
    await client.console.customers.get({ customerId: CUSTOMER_ID }, { cache: "no-cache" });
    await client.console.customers.get({ customerId: CUSTOMER_ID }, { next: { tags: ["customer"] } });

    expect(
      fake.requests.map((request) => [
        request.init.cache,
        /** @type {{ next?: unknown }} */ (request.init).next,
      ]),
    ).toEqual([
      ["no-store", undefined],
      ["no-cache", undefined],
      [undefined, { tags: ["customer"] }],
    ]);
  });

  it("refuses options and params that are not a plain object, as every method does [SDK-011]", async () => {
    const fake = createFakeFetch();
    const client = staffClient(fake.fetch);
    const signal = new AbortController().signal;

    for (const options of [new Map(), Object.create({ signal })]) {
      await expect(client.console.customers.get({ customerId: CUSTOMER_ID }, options)).rejects.toThrow(
        new TypeError("Velexis SDK: request option must be an object"),
      );
      await expect(
        client.console.bookings.issue({ bookingId: BOOKING_ID, ifMatch: 1 }, options),
      ).rejects.toThrow(new TypeError("Velexis SDK: request option must be an object"));
      await expect(
        client.console.bookings.findByRecordLocator({ reference: "L2P9XC" }, options),
      ).rejects.toThrow(new TypeError("Velexis SDK: request option must be an object"));
    }
    await expect(client.console.bookings.patch(/** @type {never} */ ("bkg_1"))).rejects.toThrow(
      new TypeError("Velexis SDK: the params of PATCH /v1/console/bookings/{bookingId} must be an object"),
    );
    await expect(
      client.console.bookings.findByRecordLocator(/** @type {never} */ ("L2P9XC")),
    ).rejects.toThrow(
      new TypeError(
        "Velexis SDK: the params of GET /v1/console/bookings/by-record-locator must be an object",
      ),
    );
    await expect(client.console.customers.get(/** @type {never} */ ({}))).rejects.toThrow(
      new TypeError(
        'Velexis SDK: GET /v1/console/customers/{customerId} needs the path parameter "customerId"',
      ),
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe("the console types", () => {
  const NAMESPACE_FILE = join(SDK_ROOT, "src", "namespaces", "console.js");
  const PUBLIC_FILES = ["console.js", "index.js"].map((name) => join(SDK_ROOT, "src", name));

  /** @type {string[]} */
  const diagnostics = [];
  /** @type {{ name: string, types: string[], resultMembers: string[], loose: boolean }[]} */
  const signatures = [];
  /** @type {{ sdk: string[], contract: string[] }} */
  const mirror = { sdk: [], contract: [] };
  /** @type {string[]} */
  const rootExports = [];
  let namespaceSource = "";

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
    for (const file of [NAMESPACE_FILE, ...PUBLIC_FILES]) {
      const source = program.getSourceFile(file);
      if (source === undefined) {
        throw new Error(`${file} is not part of the SDK's type check`);
      }
      if (file === NAMESPACE_FILE) {
        namespaceSource = source.text;
      }
      for (const diagnostic of [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source),
      ]) {
        diagnostics.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
      }
    }
    const source = /** @type {ts.SourceFile} */ (program.getSourceFile(NAMESPACE_FILE));
    const moduleSymbol = /** @type {ts.Symbol} */ (checker.getSymbolAtLocation(source));
    const factory = checker
      .getExportsOfModule(moduleSymbol)
      .find((symbol) => symbol.name === "createConsoleApi");
    const [signature] = checker
      .getTypeOfSymbolAtLocation(/** @type {ts.Symbol} */ (factory), source)
      .getCallSignatures();
    /** @param {ts.Type} type @param {string} path */
    const walk = (type, path) => {
      for (const property of type.getProperties()) {
        const name = path === "" ? property.name : `${path}.${property.name}`;
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
        const types = [...params, result];
        signatures.push({
          name,
          types: types.map((type) => checker.typeToString(type)),
          resultMembers: result.getProperties().map((member) => member.name),
          loose: types.some(isLoose) || params.length !== 2,
        });
      }
    };
    walk(/** @type {ts.Signature} */ (signature).getReturnType(), "");
    /** @param {string} file */
    const exportsOf = (file) =>
      checker.getExportsOfModule(
        /** @type {ts.Symbol} */ (
          checker.getSymbolAtLocation(/** @type {ts.SourceFile} */ (program.getSourceFile(file)))
        ),
      );
    mirror.sdk = exportsOf(join(SDK_ROOT, "src", "console.js"))
      .filter((symbol) => (symbol.flags & ts.SymbolFlags.TypeAlias) !== 0)
      .map((symbol) => ({ name: symbol.name, start: symbol.declarations?.[0]?.getStart() ?? -1 }))
      .sort((left, right) => left.start - right.start)
      .map((entry) => entry.name);
    const contractFile = join(REPO_ROOT, "docs", "velexis-sdk", "sdk", "src", "console.d.ts");
    mirror.contract = ts
      .createSourceFile(contractFile, readFileSync(contractFile, "utf8"), ts.ScriptTarget.ES2022)
      .statements.filter(
        (statement) =>
          (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
          (statement.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
      )
      .map((statement) => /** @type {ts.TypeAliasDeclaration} */ (statement).name.text);
    rootExports.push(...exportsOf(join(SDK_ROOT, "src", "index.js")).map((symbol) => symbol.name));
  }, 120_000);

  it("type-check without a diagnostic in namespaces/console.js, console.js and index.js [SDK-011]", () => {
    expect(diagnostics).toEqual([]);
  });

  it("give every method typed params, options and an awaited result, never any or unknown [SDK-011]", () => {
    expect(signatures.map((signature) => signature.name).sort()).toEqual([...ALL_METHODS].sort());
    expect(signatures.filter((signature) => signature.loose)).toEqual([]);
    const byName = Object.fromEntries(signatures.map((signature) => [signature.name, signature]));
    expect(byName["auth.signOut"]?.types[2]).toBe("void");
    expect(byName["auth.signIn"]?.resultMembers).toEqual(
      expect.arrayContaining(["session", "staff", "tenant", "permissions"]),
    );
    // The pages keep their extra fields; the booking is the console booking (net, markup, actions).
    expect(byName["bookings.list"]?.resultMembers).toEqual(
      expect.arrayContaining(["data", "page", "next", "totalCount"]),
    );
    expect(byName["queues.list"]?.resultMembers).toEqual(
      expect.arrayContaining(["data", "page", "next", "snapshot", "warnings"]),
    );
    expect(byName["bookings.get"]?.resultMembers).toEqual(
      expect.arrayContaining(["id", "version", "pricing", "consoleActions", "supplierSync"]),
    );
  });

  it("declare no any and suppress no check in namespaces/console.js [SDK-011]", () => {
    const types = [
      ...namespaceSource.matchAll(/@(?:param|returns|type|typedef|template|throws)\s*\{([^}]*)\}/g),
    ].map((match) => match[1] ?? "");
    expect(types.length).toBeGreaterThan(0);
    expect(types.filter((type) => /\bany\b|\bFunction\b|\bObject\b/.test(type))).toEqual([]);
    expect(namespaceSource).not.toMatch(/@ts-(?:ignore|expect-error|nocheck)/);
  });

  it("declare the type names of console.d.ts in the contract's order, exported from the root [SDK-011]", () => {
    expect(mirror.contract).toHaveLength(97);
    expect(mirror.sdk).toEqual(mirror.contract);
    expect(rootExports).toEqual(expect.arrayContaining([...mirror.contract, "createConsoleApi"]));
  });
});
