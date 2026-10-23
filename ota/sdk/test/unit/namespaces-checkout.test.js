// The `checkout` namespace (task SDK-009, ota/sdk/README.md §5.2, docs/velexis-sdk/sdk/src/bookings.d.ts `CheckoutApi`,
// guide B3 §2, ota/sdk/docs/extensions.md §3.1, OADR-0017 point 6): the ten contract methods and the MVP addition
// `completeWithAirlineCard`, each named by its `x-sdk-method` and sending the request of its route-table entry (method,
// path, `If-Match`, `Idempotency-Key`, JSON body, `cache: "no-store"`); `complete` and `completeWithAirlineCard` wait
// 90 s; `complete` is retried with the same idempotency key while `completeWithAirlineCard` is sent once (AC1); an
// error of `completeWithAirlineCard` holds nothing of the card, however it is serialised, even when the API or a proxy
// echoed it (AC2); `bookings.js` mirrors the checkout part of bookings.d.ts. The canned responses are the examples of
// the working OpenAPI document, checked against their schemas with the Ajv helper of @velexis/testing. Requests go to
// the fake fetch only, and the card is Stripe's documented Visa test number, never a real card.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { responseChecker } from "@velexis/testing";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import {
  ConnectionError,
  PaymentError,
  PermissionError,
  PriceChangedError,
  RateLimitError,
  ServerError,
  SupplierError,
  ValidationError,
  VelexisError,
  createVelexisClient,
} from "../../src/index.js";
import { op } from "../../src/internal/operations.js";
import { CSRF_COOKIE } from "../../src/internal/session.js";
import { createFakeFetch, errorResponse, networkError } from "../helpers/fake-fetch.js";

/** Fake keys with the right shapes; none of them works anywhere. */
const SK = "sk_test_sdk009_fake_secret";
const PK = "pk_test_sdk009_fake";
const CSRF = "csrf_sdk009_fake";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..", "..");
/** The working contract, whose examples are the canned responses. */
const DOCUMENT = join(REPO_ROOT, "ota", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");
const BASE_URL = "https://api.ota.example.com";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The ids of the document's examples. */
const CHECKOUT_ID = "chk_01JA4CE5H8K1M4P7R0T3V6Y9B2";
const PAYMENT_ID = "pay_01JA4CF6M3Q6T9W2Z5C8F1H4K7";
const PRICED_OFFER_ID = "prc_01JA4CB2E7G1J4L6N9Q2S5U8W1";
const BOOKING_ID = "bkg_01JA4CH5L6Q9T2W5Z8C1F4J7M0";
const TOTAL = Object.freeze({ amount: "1361.06", currency: "EUR" });

/**
 * The card of the document's example: Stripe's documented Visa test number, a test security code and a fictitious
 * holder. Nothing here is a real card.
 */
const CARD = Object.freeze({
  brand: "VISA",
  holderName: "Marco Rossi",
  number: "4242424242424242",
  expiryMonth: 12,
  expiryYear: 2030,
  securityCode: "737",
});

/** The params of a `completeWithAirlineCard` call. */
const AIRLINE_CARD_PARAMS = Object.freeze({
  checkoutId: CHECKOUT_ID,
  paymentId: PAYMENT_ID,
  expectedTotal: TOTAL,
  card: CARD,
});

/**
 * What must never appear in an error of `completeWithAirlineCard`: the card number or its last 12 digits (also with
 * separators), the security code as a token of its own, and the holder name in any case.
 */
const CARD_VALUES = [/4242[ -]?4242[ -]?4242/, /(?<![\w])737(?![\w])/, /marco\s+rossi/i];
/** The names of the card's fields, which no error may carry as keys. */
const CARD_KEYS = [
  "card",
  "number",
  "holderName",
  "securityCode",
  "expiryMonth",
  "expiryYear",
  "creditCard",
  "holder",
];

/** The 11 methods of the namespace: the 10 of the contract (bookings.d.ts `CheckoutApi`) and the MVP addition. */
const CHECKOUT_METHODS = [
  "checkout.create",
  "checkout.get",
  "checkout.setTravelers",
  "checkout.setContacts",
  "checkout.setAncillaries",
  "checkout.setRemarks",
  "checkout.createPayment",
  "checkout.updatePayment",
  "checkout.getPayment",
  "checkout.complete",
  "checkout.completeWithAirlineCard",
];

/** @typedef {import("../../src/index.js").VelexisClient} VelexisClient */
/** @typedef {import("../helpers/fake-fetch.js").RecordedRequest} RecordedRequest */

/**
 * The response examples of the working document that the tests answer with, read in the first `beforeAll`.
 * @type {{ checkout: any, payment: any, airlinePayment: any, completion: any, airlineCompletion: any }}
 */
const EXAMPLES = /** @type {never} */ ({});

/**
 * Parsing the OTA document (about 40 000 lines) takes about a second alone and much longer while Turborepo runs every
 * package's tests at once on a CI runner, as does compiling the response schemas with Ajv; the hook reads the examples
 * and warms the helper's cache within its own budget, so the tests below only run the compiled validators.
 */
beforeAll(() => {
  const document = parse(readFileSync(DOCUMENT, "utf8"));
  /** @param {{ $ref?: string, value?: unknown }} example */
  const resolve = (example) =>
    example.$ref === undefined ? example : document.components.examples[example.$ref.split("/").at(-1)];
  /** @param {string} path @param {string} method @param {string} status @param {string} name */
  const example = (path, method, status, name) =>
    structuredClone(
      resolve(document.paths[path][method].responses[status].content["application/json"].examples[name])
        .value,
    );
  Object.assign(EXAMPLES, {
    checkout: example("/v1/checkouts", "post", "201", "checkout"),
    payment: example("/v1/checkouts/{checkoutId}/payments", "post", "201", "payment"),
    airlinePayment: example("/v1/checkouts/{checkoutId}/payments", "post", "201", "airlineCard"),
    completion: example("/v1/checkouts/{checkoutId}/complete", "post", "201", "guest"),
    airlineCompletion: example(
      "/v1/checkouts/{checkoutId}/airline-card-completion",
      "post",
      "201",
      "guestTicketed",
    ),
  });
  // Compiles the validator of every response the tests check (each is cached for the rest of the file).
  const checker = responseChecker("ota");
  checker.check("createCheckout", { status: 201, body: EXAMPLES.checkout });
  checker.check("getCheckout", { status: 200, body: EXAMPLES.checkout });
  checker.check("createCheckoutPayment", { status: 201, body: EXAMPLES.payment });
  checker.check("completeCheckout", { status: 201, body: EXAMPLES.completion });
  checker.check("completeCheckoutWithAirlineCard", { status: 201, body: EXAMPLES.airlineCompletion });
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The dotted names of every function of a client's `checkout` namespace.
 * @param {VelexisClient} client
 */
const checkoutMethodsOf = (client) =>
  Object.entries(client.checkout)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => `checkout.${name}`);

/**
 * A cookie-mode client on a fake fetch, in a page whose CSRF cookie is set (Node with a stubbed `document`).
 * @param {import("../helpers/fake-fetch.js").Answer[]} answers
 * @param {Partial<import("../../src/index.js").VelexisClientOptions>} [options]
 */
function cookieClient(answers, options = {}) {
  vi.stubGlobal("document", { cookie: `${CSRF_COOKIE}=${CSRF}` });
  const fake = createFakeFetch(answers);
  return { fake, client: createVelexisClient({ session: "cookie", fetch: fake.fetch, ...options }) };
}

/**
 * Everything an error shows, however it is serialised: `JSON.stringify` (its `toJSON()`), `toJSON()` itself, `String`,
 * the message and stack, its own fields, and Node's `inspect` with hidden fields and the whole `cause` chain.
 * @param {unknown} error
 */
function everythingOf(error) {
  const value = /** @type {VelexisError} */ (error);
  return [
    JSON.stringify(value),
    JSON.stringify(value.toJSON()),
    String(value),
    value.message,
    String(value.stack),
    JSON.stringify(Object.entries(value)),
    inspect(value, { depth: Infinity, showHidden: true, breakLength: Infinity }),
  ].join("\n");
}

/**
 * Every key of a JSON value, at every depth.
 * @param {unknown} value
 * @returns {string[]}
 */
function keysOf(value) {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]);
  }
  return [];
}

/**
 * Every own key, enumerable or not, of an error's `cause` and of everything it holds, a few levels deep (what a logger
 * that serialises causes, or `inspect`, can print).
 * @param {unknown} error
 * @returns {string[]}
 */
function causeKeysOf(error) {
  /** @type {string[]} */
  const keys = [];
  const seen = new Set();
  /** @param {unknown} value @param {number} depth */
  const walk = (value, depth) => {
    if (value === null || typeof value !== "object" || seen.has(value) || depth > 10) {
      return;
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      keys.push(String(key));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) {
        walk(descriptor.value, depth + 1);
      }
    }
  };
  walk(/** @type {{ cause?: unknown }} */ (error).cause, 0);
  return keys;
}

/**
 * Asserts that an error shows nothing of the card: no value in any serialisation, no card-named key in its JSON, its
 * own fields or its cause chain.
 * @param {unknown} error
 */
function expectNoCard(error) {
  expect(error).toBeInstanceOf(VelexisError);
  const text = everythingOf(error);
  for (const pattern of CARD_VALUES) {
    expect(text).not.toMatch(pattern);
  }
  // No card-named key in the serialised error, nor in its own fields (details, fieldErrors, supplier …).
  const json = /** @type {VelexisError} */ (error).toJSON();
  expect(keysOf(json).filter((key) => CARD_KEYS.includes(key))).toEqual([]);
  const fields = Object.fromEntries(Object.entries(/** @type {object} */ (error)));
  expect(keysOf(fields).filter((key) => CARD_KEYS.includes(key))).toEqual([]);
  expect(causeKeysOf(error).filter((key) => CARD_KEYS.includes(key))).toEqual([]);
}

/**
 * One method called with sample parameters, and the request it must send.
 * @typedef {object} RouteCase
 * @property {string} method the `x-sdk-method`
 * @property {(client: VelexisClient) => Promise<unknown>} call
 * @property {"GET" | "POST" | "PUT" | "PATCH"} http
 * @property {string} path the path with its parameters filled in
 * @property {Record<string, unknown>} [body] the JSON body; none when absent
 * @property {string | null} [ifMatch] the `If-Match` header; none when absent
 * @property {number} [status] the canned status (200 by default)
 * @property {keyof typeof EXAMPLES} response the document example the API answers with
 */

const TRAVELER = {
  travelerId: "1",
  name: { firstName: "MARCO", lastName: "ROSSI" },
  dateOfBirth: "1985-04-12",
  gender: "MALE",
};
const CONTACT = {
  purpose: "STANDARD",
  isPrimary: true,
  addresseeName: { firstName: "MARCO", lastName: "ROSSI" },
  emailAddress: "marco.rossi@example.com",
  phones: [{ deviceType: "MOBILE", countryCallingCode: "39", number: "3471234567" }],
};

/** @type {RouteCase[]} */
const CASES = [
  {
    method: "checkout.create",
    call: (client) => client.checkout.create({ pricedOfferId: PRICED_OFFER_ID, locale: "it-IT" }),
    http: "POST",
    path: "/v1/checkouts",
    body: { pricedOfferId: PRICED_OFFER_ID, locale: "it-IT" },
    status: 201,
    response: "checkout",
  },
  {
    method: "checkout.get",
    call: (client) => client.checkout.get({ checkoutId: CHECKOUT_ID }),
    http: "GET",
    path: `/v1/checkouts/${CHECKOUT_ID}`,
    response: "checkout",
  },
  {
    method: "checkout.setTravelers",
    call: (client) =>
      client.checkout.setTravelers({ checkoutId: CHECKOUT_ID, ifMatch: 6, travelers: [TRAVELER] }),
    http: "PUT",
    path: `/v1/checkouts/${CHECKOUT_ID}/travelers`,
    body: { travelers: [TRAVELER] },
    ifMatch: '"6"',
    response: "checkout",
  },
  {
    method: "checkout.setContacts",
    call: (client) =>
      client.checkout.setContacts({ checkoutId: CHECKOUT_ID, ifMatch: '"6"', contacts: [CONTACT] }),
    http: "PUT",
    path: `/v1/checkouts/${CHECKOUT_ID}/contacts`,
    body: { contacts: [CONTACT] },
    ifMatch: '"6"',
    response: "checkout",
  },
  {
    method: "checkout.setAncillaries",
    call: (client) =>
      client.checkout.setAncillaries({
        checkoutId: CHECKOUT_ID,
        ifMatch: 7,
        selections: [{ optionId: "anc_01JA4CC1D4F7H0K3M6P9R2T5V8", travelerId: "1", quantity: 1 }],
        expectedTotal: { amount: "1414.06", currency: "EUR" },
      }),
    http: "PUT",
    path: `/v1/checkouts/${CHECKOUT_ID}/ancillaries`,
    body: {
      selections: [{ optionId: "anc_01JA4CC1D4F7H0K3M6P9R2T5V8", travelerId: "1", quantity: 1 }],
      expectedTotal: { amount: "1414.06", currency: "EUR" },
    },
    ifMatch: '"7"',
    response: "checkout",
  },
  {
    method: "checkout.setRemarks",
    call: (client) =>
      client.checkout.setRemarks({
        checkoutId: CHECKOUT_ID,
        remarks: [{ text: "Vegetarian meal if possible", travelerIds: ["1"] }],
      }),
    http: "PUT",
    path: `/v1/checkouts/${CHECKOUT_ID}/remarks`,
    body: { remarks: [{ text: "Vegetarian meal if possible", travelerIds: ["1"] }] },
    ifMatch: null,
    response: "checkout",
  },
  {
    method: "checkout.createPayment",
    call: (client) =>
      client.checkout.createPayment({
        checkoutId: CHECKOUT_ID,
        method: "card",
        termsAccepted: true,
        returnUrl: "https://www.acmetravel.example/checkout/complete.html",
      }),
    http: "POST",
    path: `/v1/checkouts/${CHECKOUT_ID}/payments`,
    body: {
      method: "card",
      termsAccepted: true,
      returnUrl: "https://www.acmetravel.example/checkout/complete.html",
    },
    status: 201,
    response: "payment",
  },
  {
    method: "checkout.updatePayment",
    call: (client) =>
      client.checkout.updatePayment({ paymentId: PAYMENT_ID, card: { brand: "VISA", bin: "424242" } }),
    http: "PATCH",
    path: `/v1/payments/${PAYMENT_ID}`,
    body: { card: { brand: "VISA", bin: "424242" } },
    response: "airlinePayment",
  },
  {
    method: "checkout.getPayment",
    call: (client) => client.checkout.getPayment({ paymentId: PAYMENT_ID }),
    http: "GET",
    path: `/v1/payments/${PAYMENT_ID}`,
    response: "payment",
  },
  {
    method: "checkout.complete",
    call: (client) =>
      client.checkout.complete({ checkoutId: CHECKOUT_ID, paymentId: PAYMENT_ID, expectedTotal: TOTAL }),
    http: "POST",
    path: `/v1/checkouts/${CHECKOUT_ID}/complete`,
    body: { paymentId: PAYMENT_ID, expectedTotal: TOTAL },
    status: 201,
    response: "completion",
  },
  {
    method: "checkout.completeWithAirlineCard",
    call: (client) => client.checkout.completeWithAirlineCard(AIRLINE_CARD_PARAMS),
    http: "POST",
    path: `/v1/checkouts/${CHECKOUT_ID}/airline-card-completion`,
    body: { paymentId: PAYMENT_ID, expectedTotal: TOTAL, card: CARD },
    status: 201,
    response: "airlineCompletion",
  },
];

describe("the document examples", () => {
  it("are responses of their operations in the working OpenAPI document, checked with the Ajv helper [SDK-009]", () => {
    const checker = responseChecker("ota");
    expect(checker.check("createCheckout", { status: 201, body: EXAMPLES.checkout })).toEqual([]);
    expect(checker.check("getCheckout", { status: 200, body: EXAMPLES.checkout })).toEqual([]);
    expect(checker.check("createCheckoutPayment", { status: 201, body: EXAMPLES.payment })).toEqual([]);
    expect(checker.check("createCheckoutPayment", { status: 201, body: EXAMPLES.airlinePayment })).toEqual(
      [],
    );
    expect(checker.check("completeCheckout", { status: 201, body: EXAMPLES.completion })).toEqual([]);
    expect(
      checker.check("completeCheckoutWithAirlineCard", { status: 201, body: EXAMPLES.airlineCompletion }),
    ).toEqual([]);
    expect(EXAMPLES.checkout).toMatchObject({ id: CHECKOUT_ID, basePricedOfferId: PRICED_OFFER_ID });
    expect(EXAMPLES.airlinePayment).toMatchObject({
      id: PAYMENT_ID,
      method: "airline_card",
      provider: "airline",
    });
    expect(EXAMPLES.airlineCompletion).toMatchObject({
      checkoutId: CHECKOUT_ID,
      booking: { id: BOOKING_ID },
    });
  });
});

describe("the checkout namespace", () => {
  it("offers the ten contract methods and completeWithAirlineCard, each named by its x-sdk-method [SDK-009]", () => {
    const client = createVelexisClient({ publishableKey: PK, fetch: createFakeFetch().fetch });

    expect(Object.keys(client)).toContain("checkout");
    expect(checkoutMethodsOf(client).sort()).toEqual([...CHECKOUT_METHODS].sort());
    for (const method of CHECKOUT_METHODS) {
      expect(op, method).toHaveProperty(method.replaceAll(".", "_"));
    }
    expect(CASES.map((testCase) => testCase.method)).toEqual(CHECKOUT_METHODS);
    expect(checkoutMethodsOf(client.withOptions({ locale: "fr-FR" })).sort()).toEqual(
      [...CHECKOUT_METHODS].sort(),
    );
  });
});

describe("each checkout method sends the request of its route-table entry", () => {
  it.each(CASES)("$method → $http $path [SDK-009]", async (testCase) => {
    const key = /** @type {keyof typeof op} */ (testCase.method.replaceAll(".", "_"));
    const entry = op[key];
    const response = EXAMPLES[testCase.response];
    const fake = createFakeFetch([{ status: testCase.status ?? 200, body: response }]);
    const client = createVelexisClient({ secretKey: SK, environment: "test", fetch: fake.fetch });

    const result = await testCase.call(client);

    expect(result).toEqual(response);
    expect(fake.requests).toHaveLength(1);
    const request = /** @type {RecordedRequest} */ (fake.requests[0]);
    expect(request.method).toBe(testCase.http);
    expect(entry.method).toBe(testCase.http);
    expect(testCase.path).toMatch(new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, "[^/]+")}$`));
    expect(request.url).toBe(`${BASE_URL}${testCase.path}`);
    if (testCase.body === undefined) {
      expect(request.body).toBeNull();
      expect(request.headers).not.toHaveProperty("content-type");
    } else {
      expect(request.json).toEqual(testCase.body);
      expect(request.headers["content-type"]).toBe("application/json");
    }
    expect(request.headers).toMatchObject({ accept: "application/json", "x-api-key": SK });
    // If-Match: the version number as its ETag "<n>", an ETag string as it is, nothing without ifMatch.
    expect(request.headers["if-match"]).toBe(testCase.ifMatch ?? undefined);
    expect(Object.keys(entry.headerParams)).toEqual(testCase.ifMatch === undefined ? [] : ["ifMatch"]);
    if (entry.idempotency === "none") {
      expect(request.headers).not.toHaveProperty("idempotency-key");
    } else {
      expect(request.headers["idempotency-key"]).toMatch(UUID_V4);
    }
    // Checkout operations are customer operations: never the console's environment header.
    expect(entry.environment).toBe(false);
    expect(request.headers).not.toHaveProperty("x-velexis-environment");
    // Personal, priced and time-limited: no-store, as the contract says.
    expect(request.init.cache).toBe("no-store");
  });

  it("give POSTs an Idempotency-Key, and complete and completeWithAirlineCard 90 s in the route table [SDK-009]", () => {
    expect(
      CHECKOUT_METHODS.filter(
        (method) => op[/** @type {keyof typeof op} */ (method.replaceAll(".", "_"))].idempotency !== "none",
      ),
    ).toEqual([
      "checkout.create",
      "checkout.createPayment",
      "checkout.complete",
      "checkout.completeWithAirlineCard",
    ]);
    expect(op.checkout_complete).toMatchObject({
      timeoutMs: 90_000,
      retry: "idempotent",
      idempotency: "required",
    });
    expect(op.checkout_completeWithAirlineCard).toMatchObject({
      timeoutMs: 90_000,
      retry: "never",
      idempotency: "required",
    });
  });

  it("keep the caller's cache or next, and refuse invalid params and options with a TypeError before any request [SDK-009]", async () => {
    const fake = createFakeFetch([{ body: {} }, { body: {} }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    await client.checkout.get({ checkoutId: CHECKOUT_ID }, { cache: "no-cache" });
    await client.checkout.getPayment({ paymentId: PAYMENT_ID }, { next: { tags: ["payment"] } });
    expect(
      fake.requests.map((request) => [
        request.init.cache,
        /** @type {{ next?: unknown }} */ (request.init).next,
      ]),
    ).toEqual([
      ["no-cache", undefined],
      [undefined, { tags: ["payment"] }],
    ]);

    await expect(client.checkout.get(/** @type {never} */ ({}))).rejects.toThrow(
      new TypeError('Velexis SDK: GET /v1/checkouts/{checkoutId} needs the path parameter "checkoutId"'),
    );
    await expect(client.checkout.completeWithAirlineCard(/** @type {never} */ ("card"))).rejects.toThrow(
      new TypeError(
        "Velexis SDK: the params of POST /v1/checkouts/{checkoutId}/airline-card-completion must be an object",
      ),
    );
    const signal = new AbortController().signal;
    for (const options of [new Map(), Object.create({ signal })]) {
      await expect(client.checkout.complete({ checkoutId: CHECKOUT_ID }, options)).rejects.toThrow(
        new TypeError("Velexis SDK: request option must be an object"),
      );
      await expect(client.checkout.completeWithAirlineCard(AIRLINE_CARD_PARAMS, options)).rejects.toThrow(
        new TypeError("Velexis SDK: request option must be an object"),
      );
    }
    expect(fake.requests).toHaveLength(2);
  });

  it("work in cookie mode: the airline-card payment and its completion through /api with the CSRF header and no key [SDK-009]", async () => {
    const { fake, client } = cookieClient([
      { status: 201, body: EXAMPLES.airlinePayment },
      { status: 201, body: EXAMPLES.airlineCompletion },
    ]);

    const payment = await client.checkout.createPayment({
      checkoutId: CHECKOUT_ID,
      method: "airline_card",
      termsAccepted: true,
    });
    const completion = await client.checkout.completeWithAirlineCard({
      ...AIRLINE_CARD_PARAMS,
      paymentId: payment.id,
      expectedTotal: payment.amount,
    });

    expect(payment.nextAction).toMatchObject({ type: "airline_card_form" });
    expect(completion).toEqual(EXAMPLES.airlineCompletion);
    expect(completion.bookingToken).toBeNull();
    expect(fake.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST /api/v1/checkouts/${CHECKOUT_ID}/payments`,
      `POST /api/v1/checkouts/${CHECKOUT_ID}/airline-card-completion`,
    ]);
    for (const request of fake.requests) {
      expect(request.headers["x-csrf-token"]).toBe(CSRF);
      expect(request.headers).not.toHaveProperty("x-api-key");
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.init).toMatchObject({
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
      });
    }
    // The card goes to the API once, in the body of the completion, and nowhere else.
    expect(fake.requests[1]?.json).toEqual({
      paymentId: PAYMENT_ID,
      expectedTotal: payment.amount,
      card: CARD,
    });
    expect(JSON.stringify(fake.requests[0]?.json)).not.toContain(CARD.number);
  });
});

describe("retries", () => {
  it("completeWithAirlineCard throws a 503 at once, after one request, whatever maxRetries says [SDK-009 AC1]", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch([errorResponse(503, "SERVICE_UNAVAILABLE"), { status: 201, body: {} }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch, maxRetries: 5 });

    // No timer is advanced: a back-off wait would keep the promise pending.
    const error = await client.checkout
      .completeWithAirlineCard(AIRLINE_CARD_PARAMS)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503, retryable: true });
    expect(fake.requests).toHaveLength(1);
    expect(fake.remaining).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      "a 503 with Retry-After",
      errorResponse(503, "SUPPLIER_UNAVAILABLE", { headers: { "retry-after": "1" } }),
    ],
    ["a 429", errorResponse(429, "RATE_LIMITED", { headers: { "retry-after": "1" } })],
    [
      "a 504 SUPPLIER_TIMEOUT",
      errorResponse(504, "SUPPLIER_TIMEOUT", { details: { bookingId: BOOKING_ID } }),
    ],
    ["a network error", networkError()],
  ])("completeWithAirlineCard is not sent again after %s either [SDK-009 AC1]", async (_what, answer) => {
    vi.useFakeTimers();
    const fake = createFakeFetch([answer, { status: 201, body: {} }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch, maxRetries: 5 });

    const error = await client.checkout
      .completeWithAirlineCard(AIRLINE_CARD_PARAMS)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(VelexisError);
    expect(fake.requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("completeWithAirlineCard in cookie mode is not sent again after 503, 401 TOKEN_EXPIRED or 403 CSRF_TOKEN_INVALID [SDK-009 AC1]", async () => {
    const { fake, client } = cookieClient(
      [
        errorResponse(503, "SERVICE_UNAVAILABLE"),
        errorResponse(401, "TOKEN_EXPIRED"),
        { body: { customer: { id: "cus_1" } } },
        errorResponse(403, "CSRF_TOKEN_INVALID"),
        { body: { id: "sf_1" } },
      ],
      { maxRetries: 2 },
    );

    const unavailable = await client.checkout
      .completeWithAirlineCard(AIRLINE_CARD_PARAMS)
      .catch((caught) => caught);
    const expired = await client.checkout
      .completeWithAirlineCard(AIRLINE_CARD_PARAMS)
      .catch((caught) => caught);
    const csrf = await client.checkout.completeWithAirlineCard(AIRLINE_CARD_PARAMS).catch((caught) => caught);

    expect([unavailable.code, expired.code, csrf.code]).toEqual([
      "SERVICE_UNAVAILABLE",
      "TOKEN_EXPIRED",
      "CSRF_TOKEN_INVALID",
    ]);
    expect(csrf).toBeInstanceOf(PermissionError);
    // The session is renewed for the next submit (refresh, CSRF cookie), but the card is never sent twice.
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST /api/v1/checkouts/${CHECKOUT_ID}/airline-card-completion`,
      `POST /api/v1/checkouts/${CHECKOUT_ID}/airline-card-completion`,
      "POST /api/v1/auth/refresh",
      `POST /api/v1/checkouts/${CHECKOUT_ID}/airline-card-completion`,
      "GET /api/v1/storefront",
    ]);
    for (const request of fake.requests.filter((item) => item.path.endsWith("/airline-card-completion"))) {
      expect(request.json).toMatchObject({ card: CARD });
    }
    for (const request of fake.requests.filter((item) => !item.path.endsWith("/airline-card-completion"))) {
      expect(JSON.stringify(request.json ?? null)).not.toContain(CARD.number);
    }
  });

  it("completeWithAirlineCard sends a new Idempotency-Key with every call: one per submit [SDK-009 AC1]", async () => {
    const fake = createFakeFetch([errorResponse(402, "PAYMENT_DECLINED"), { status: 201, body: {} }]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    await client.checkout.completeWithAirlineCard(AIRLINE_CARD_PARAMS).catch(() => undefined);
    await client.checkout.completeWithAirlineCard(AIRLINE_CARD_PARAMS);

    const [first, second] = fake.requests.map((request) => request.headers["idempotency-key"]);
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
  });

  it("complete retries a 503 with the same generated Idempotency-Key and resolves with the booking [SDK-009 AC1]", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch([
      errorResponse(503, "SERVICE_UNAVAILABLE"),
      errorResponse(503, "SUPPLIER_UNAVAILABLE"),
      { status: 201, body: EXAMPLES.completion },
    ]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    const pending = client.checkout.complete({
      checkoutId: CHECKOUT_ID,
      paymentId: PAYMENT_ID,
      expectedTotal: TOTAL,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual(EXAMPLES.completion);
    expect(fake.requests).toHaveLength(3);
    const keys = fake.requests.map((request) => request.headers["idempotency-key"]);
    expect(keys[0]).toMatch(UUID_V4);
    expect(new Set(keys).size).toBe(1);
    expect(fake.requests.map((request) => request.json)).toEqual(
      Array(3).fill({ paymentId: PAYMENT_ID, expectedTotal: TOTAL }),
    );
  });

  it("complete retries a network error and a replayed 504 with the caller's stable key, then throws the last error [SDK-009 AC1]", async () => {
    vi.useFakeTimers();
    const timeout = errorResponse(504, "SUPPLIER_TIMEOUT", {
      details: { bookingId: BOOKING_ID, bookingToken: "vxbt_test_sdk009_fake", replayed: true },
    });
    const fake = createFakeFetch([networkError(), timeout, timeout]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });
    const idempotencyKey = `complete-${CHECKOUT_ID}-${PAYMENT_ID}`;

    const pending = client.checkout
      .complete({ checkoutId: CHECKOUT_ID, paymentId: PAYMENT_ID }, { idempotencyKey })
      .catch((caught) => caught);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;

    expect(error).toBeInstanceOf(SupplierError);
    expect(error).toMatchObject({ code: "SUPPLIER_TIMEOUT", details: { bookingId: BOOKING_ID } });
    expect(fake.requests.map((request) => request.headers["idempotency-key"])).toEqual(
      Array(3).fill(idempotencyKey),
    );
    // The guest token stays on error.details for the caller, but never in toJSON().
    expect(JSON.stringify(error)).not.toContain("vxbt_test_sdk009_fake");
  });
});

describe("timeouts", () => {
  it.each([
    [
      "checkout.complete",
      (/** @type {VelexisClient} */ client) =>
        client.checkout.complete({ checkoutId: CHECKOUT_ID, paymentId: PAYMENT_ID }),
    ],
    [
      "checkout.completeWithAirlineCard",
      (/** @type {VelexisClient} */ client) => client.checkout.completeWithAirlineCard(AIRLINE_CARD_PARAMS),
    ],
  ])(
    "%s waits 90 s, not the client's 30 s, and the timeout is not retried [SDK-009]",
    async (_name, call) => {
      vi.useFakeTimers();
      const fake = createFakeFetch([{ delayMs: Infinity }]);
      const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch, timeoutMs: 30_000 });

      const pending = call(client).catch((/** @type {unknown} */ error) => error);
      await vi.advanceTimersByTimeAsync(89_999);
      expect(fake.requests[0]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await pending;

      expect(error).toBeInstanceOf(ConnectionError);
      expect(error).toMatchObject({ code: "TIMEOUT", status: 0 });
      expect(fake.requests).toHaveLength(1);
      expectNoCard(error);
    },
  );

  it("the other checkout methods use the client's timeout, and options.timeoutMs wins over the table [SDK-009]", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch([{ delayMs: Infinity }, { delayMs: Infinity }]);
    const client = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      timeoutMs: 20_000,
      maxRetries: 0,
    });

    const get = client.checkout
      .get({ checkoutId: CHECKOUT_ID })
      .catch((/** @type {unknown} */ error) => error);
    const complete = client.checkout
      .complete({ checkoutId: CHECKOUT_ID }, { timeoutMs: 5_000 })
      .catch((/** @type {unknown} */ error) => error);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.requests.map((request) => request.signal?.aborted)).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.requests.map((request) => request.signal?.aborted)).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(15_000);

    expect([await get, await complete]).toMatchObject([{ code: "TIMEOUT" }, { code: "TIMEOUT" }]);
  });
});

describe("errors of completeWithAirlineCard", () => {
  /** A careless API or proxy that echoes the card everywhere an error has room for it. */
  const echoing = errorResponse(422, "VALIDATION_FAILED", {
    message: `Card 4242 4242 4242 4242 of MARCO ROSSI (cvv 737) refused; last digits 424242424242`,
    requestId: `req_${CARD.number}`,
    headers: { "x-request-id": "req_fake" },
    details: {
      bookingId: BOOKING_ID,
      card: { ...CARD },
      number: CARD.number,
      holderName: CARD.holderName,
      securityCode: CARD.securityCode,
      expiryMonth: CARD.expiryMonth,
      expiryYear: CARD.expiryYear,
      note: `holder Marco Rossi, number ${CARD.number}`,
      nested: [{ creditCard: { holder: "MARCO ROSSI", number: CARD.number } }],
    },
    fieldErrors: [
      {
        path: "/card/number",
        code: "luhn",
        message: `${CARD.number} fails the Luhn check`,
        value: CARD.number,
      },
      { path: "/card/securityCode", code: "pattern", params: { securityCode: CARD.securityCode } },
    ],
    supplier: {
      provider: "amadeus",
      status: 400,
      code: 477,
      title: "INVALID FORMAT",
      detail: `creditCard.holder MARCO ROSSI number ${CARD.number}`,
      source: { pointer: "/data/formOfPayments/0/creditCard/number", example: CARD.number },
    },
  });

  it.each([
    ["402 PAYMENT_DECLINED", errorResponse(402, "PAYMENT_DECLINED"), PaymentError],
    [
      "400 VALIDATION_FAILED with field errors",
      errorResponse(400, "VALIDATION_FAILED", {
        fieldErrors: [
          { path: "/card/number", code: "luhn", message: "The card number is not valid." },
          { path: "/card/expiryYear", code: "expired", message: "The card has expired." },
        ],
      }),
      ValidationError,
    ],
    [
      "403 PAYMENT_ATTEMPTS_EXCEEDED",
      errorResponse(403, "PAYMENT_ATTEMPTS_EXCEEDED", { details: { attempts: 3 } }),
      PermissionError,
    ],
    [
      "504 SUPPLIER_TIMEOUT",
      errorResponse(504, "SUPPLIER_TIMEOUT", { details: { bookingId: BOOKING_ID, replayed: false } }),
      SupplierError,
    ],
    ["an API that echoes the card", echoing, ValidationError],
    [
      "a network error that names the body",
      networkError(`fetch failed: ${JSON.stringify({ card: CARD })}`),
      ConnectionError,
    ],
    [
      "a proxy page that echoes the card",
      { status: 502, body: `<p>Bad gateway for card ${CARD.number}</p>` },
      ServerError,
    ],
    [
      "an API that echoes the card number and security code as JSON numbers",
      errorResponse(422, "VALIDATION_FAILED", {
        details: { bookingId: BOOKING_ID, pan: Number(CARD.number), cvc: Number(CARD.securityCode) },
        supplier: { provider: "amadeus", status: 400, code: Number(CARD.securityCode) },
      }),
      ValidationError,
    ],
    [
      // A fetch wrapper's error that keeps the request it failed to send (as some fetch libraries' errors do).
      "a fetch error that keeps the request body in a field",
      {
        error: Object.assign(new TypeError("fetch failed"), {
          options: { method: "POST", body: JSON.stringify({ card: CARD }) },
        }),
      },
      ConnectionError,
    ],
    [
      "a fetch error whose cause chain holds the card in a field",
      {
        error: new TypeError("fetch failed", {
          cause: new AggregateError(
            [Object.assign(new Error("socket hang up"), { code: "ECONNRESET", sent: { pan: CARD.number } })],
            "connect failed",
          ),
        }),
      },
      ConnectionError,
    ],
    [
      "a fetch error with a card-named field",
      { error: Object.assign(new TypeError("fetch failed"), { card: { brand: "VISA" } }) },
      ConnectionError,
    ],
  ])("serialise without any card field: %s [SDK-009 AC2]", async (_what, answer, ErrorClass) => {
    const responses = [];
    const fake = createFakeFetch([answer]);
    const client = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      onResponse: (info) => responses.push(info),
    });

    const error = await client.checkout
      .completeWithAirlineCard(AIRLINE_CARD_PARAMS)
      .catch((caught) => caught);

    // The card did go to the API, once, in the body.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.json).toMatchObject({ card: CARD });
    expect(error).toBeInstanceOf(ErrorClass);
    expectNoCard(error);
    // onResponse gets the method, the API path, the status, the request id and the duration: no argument.
    for (const info of responses) {
      expect(Object.keys(info).sort()).toEqual(["durationMs", "method", "path", "requestId", "status"]);
      expect(info.path).toBe(`/v1/checkouts/${CHECKOUT_ID}/airline-card-completion`);
      for (const pattern of CARD_VALUES) {
        expect(JSON.stringify(info)).not.toMatch(pattern);
      }
    }
  });

  it("keep everything else of the error: class, code, status, request id, retry facts, details and field-error paths [SDK-009 AC2]", async () => {
    const fake = createFakeFetch([
      echoing,
      errorResponse(429, "RATE_LIMITED", { headers: { "retry-after": "45" }, requestId: "req_sdk009_rate" }),
      errorResponse(409, "PRICE_CHANGED", {
        details: {
          oldPrice: TOTAL,
          newPrice: { amount: "1402.10", currency: "EUR" },
          pricedOfferId: "prc_01JA4CE9P7S0V3Y6A9D2G5J8L1",
        },
      }),
      networkError(),
      // Node's fetch on a DNS failure: a TypeError whose cause carries the system error's fields.
      {
        error: new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.ota.example.com"), {
            errno: -3008,
            code: "ENOTFOUND",
            syscall: "getaddrinfo",
            hostname: "api.ota.example.com",
          }),
        }),
      },
    ]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch, maxRetries: 3 });
    const call = () => client.checkout.completeWithAirlineCard(AIRLINE_CARD_PARAMS).catch((caught) => caught);

    const echoed = await call();
    const limited = await call();
    const priceChanged = await call();
    const network = await call();
    const dns = await call();

    expect(echoed).toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_FAILED",
      status: 422,
      requestId: "req_[redacted]",
      retryable: false,
      details: { bookingId: BOOKING_ID, note: "holder [redacted], number [redacted]", nested: [{}] },
      fieldErrors: [
        { path: "/card/number", code: "luhn", message: "[redacted] fails the Luhn check" },
        { path: "/card/securityCode", code: "pattern" },
      ],
      supplier: {
        provider: "amadeus",
        code: 477,
        detail: "creditCard.holder [redacted] number [redacted]",
        source: { pointer: "/data/formOfPayments/0/creditCard/number", example: "[redacted]" },
      },
    });
    expect(echoed.message).toBe(
      "Card [redacted] of [redacted] (cvv [redacted]) refused; last digits [redacted]",
    );
    expect(echoed.fieldErrors[1]).toEqual({ path: "/card/securityCode", code: "pattern" });
    expect(limited).toBeInstanceOf(RateLimitError);
    expect(limited).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 45,
      requestId: "req_sdk009_rate",
    });
    expect(priceChanged).toBeInstanceOf(PriceChangedError);
    expect(priceChanged).toMatchObject({
      newPrice: { amount: "1402.10", currency: "EUR" },
      oldPrice: TOTAL,
      pricedOfferId: "prc_01JA4CE9P7S0V3Y6A9D2G5J8L1",
    });
    expect(network).toBeInstanceOf(ConnectionError);
    expect(network).toMatchObject({ code: "NETWORK_ERROR", status: 0, retryable: true });
    // A cause without card values stays for debugging, with its own causes and fields; one that names the card
    // anywhere is dropped (previous test).
    expect(network.cause).toBeInstanceOf(TypeError);
    expect(dns).toBeInstanceOf(ConnectionError);
    expect(dns.cause).toBeInstanceOf(TypeError);
    expect(dns.cause.cause).toMatchObject({ code: "ENOTFOUND", syscall: "getaddrinfo" });
    expectNoCard(dns);
    expect(fake.requests).toHaveLength(5);
  });

  it("redact the card's values also when the card is not a plain object [SDK-009 AC2]", async () => {
    /** A card object of the page's own class: `JSON.stringify` sends its own fields like a plain object's. */
    class CardInput {
      constructor() {
        Object.assign(this, CARD);
      }
    }
    const fake = createFakeFetch([echoing]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    const error = await client.checkout
      .completeWithAirlineCard({ ...AIRLINE_CARD_PARAMS, card: /** @type {never} */ (new CardInput()) })
      .catch((caught) => caught);

    expect(fake.requests[0]?.json).toMatchObject({ card: CARD });
    expect(error).toBeInstanceOf(ValidationError);
    expectNoCard(error);
  });

  it("leave the errors of the other checkout methods as the API sent them [SDK-009 AC2]", async () => {
    const fake = createFakeFetch([
      errorResponse(422, "TRAVELER_DATA_INVALID", {
        fieldErrors: [{ path: "/travelers/0/documents/0/number", code: "DOCUMENT_NUMBER_INVALID" }],
        details: { number: "Y1234567" },
      }),
    ]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    const error = await client.checkout
      .setTravelers({ checkoutId: CHECKOUT_ID, travelers: [TRAVELER] })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.details).toEqual({ number: "Y1234567" });
  });
});

describe("the checkout types", () => {
  const NAMESPACE_FILE = join(SDK_ROOT, "src", "namespaces", "checkout.js");
  const PUBLIC_FILES = ["bookings.js", "index.js"].map((name) => join(SDK_ROOT, "src", name));
  /** The types of the MVP addition, after the contract's names. */
  const ADDITIONS = ["AirlineCard", "CompleteWithAirlineCardParams"];
  /** The names of bookings.d.ts that SDK-010 adds with the bookings namespace. */
  const BOOKINGS_PART = [
    "BookingListTimeframe",
    "BookingListStatus",
    "BookingListSort",
    "ListBookingsParams",
    "BookingRefParams",
    "GetBookingParams",
    "LookupBookingParams",
    "UpdateBookingParams",
    "CancelBookingParams",
    "CreateBookingPaymentParams",
    "AddBookingAncillariesParams",
    "GetBookingFareRulesParams",
    "GetTicketingStatusParams",
    "ListBookingDocumentsParams",
    "GetDocumentDownloadUrlParams",
    "ListBookingEventsParams",
    "BookingsApi",
  ];

  /** @type {string[]} */
  const diagnostics = [];
  /** @type {{ name: string, types: string[], loose: boolean }[]} */
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
      .find((symbol) => symbol.name === "createCheckoutApi");
    const [signature] = checker
      .getTypeOfSymbolAtLocation(/** @type {ts.Symbol} */ (factory), source)
      .getCallSignatures();
    for (const property of /** @type {ts.Signature} */ (signature).getReturnType().getProperties()) {
      const [method] = checker.getTypeOfSymbolAtLocation(property, source).getCallSignatures();
      const params = (method?.getParameters() ?? []).map((parameter) =>
        checker.getTypeOfSymbolAtLocation(parameter, source),
      );
      const returned = method?.getReturnType();
      const result = returned ? (checker.getAwaitedType(returned) ?? returned) : undefined;
      const types = [...params, ...(result ? [result] : [])];
      signatures.push({
        name: `checkout.${property.name}`,
        types: types.map((type) => checker.typeToString(type)),
        loose: method === undefined || types.some(isLoose) || params.length !== 2,
      });
    }
    /** @param {string} file */
    const exportsOf = (file) =>
      checker.getExportsOfModule(
        /** @type {ts.Symbol} */ (
          checker.getSymbolAtLocation(/** @type {ts.SourceFile} */ (program.getSourceFile(file)))
        ),
      );
    mirror.sdk = exportsOf(join(SDK_ROOT, "src", "bookings.js"))
      .filter((symbol) => (symbol.flags & ts.SymbolFlags.TypeAlias) !== 0)
      .map((symbol) => ({ name: symbol.name, start: symbol.declarations?.[0]?.getStart() ?? -1 }))
      .sort((left, right) => left.start - right.start)
      .map((entry) => entry.name);
    const contractFile = join(REPO_ROOT, "docs", "velexis-sdk", "sdk", "src", "bookings.d.ts");
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

  it("type-check without a diagnostic in checkout.js, bookings.js and index.js [SDK-009]", () => {
    expect(diagnostics).toEqual([]);
  });

  it("give every method typed params, options and an awaited result, never any or unknown [SDK-009]", () => {
    expect(signatures.map((signature) => signature.name).sort()).toEqual([...CHECKOUT_METHODS].sort());
    expect(signatures.filter((signature) => signature.loose)).toEqual([]);
    const byName = Object.fromEntries(signatures.map((signature) => [signature.name, signature.types]));
    expect(byName["checkout.completeWithAirlineCard"]?.[0]).toMatch(/CompleteWithAirlineCardParams|card: \{/);
    expect(byName["checkout.complete"]?.[2]).toMatch(/^\{ checkoutId: string; booking: /);
    expect(byName["checkout.get"]?.[2]).toMatch(/^\{ id: string; status: /);
  });

  it("declare no any and suppress no check in checkout.js [SDK-009]", () => {
    const types = [
      ...namespaceSource.matchAll(/@(?:param|returns|type|typedef|template|throws)\s*\{([^}]*)\}/g),
    ].map((match) => match[1] ?? "");
    expect(types.length).toBeGreaterThan(0);
    expect(types.filter((type) => /\bany\b|\bFunction\b|\bObject\b/.test(type))).toEqual([]);
    expect(namespaceSource).not.toMatch(/@ts-(?:ignore|expect-error|nocheck)/);
  });

  it("declare the type names of bookings.d.ts in the contract's order, the additions last, exported from the root [SDK-009]", () => {
    const contractPart = mirror.sdk.filter((name) => !ADDITIONS.includes(name));

    // Every name of the contract file, in its order, with the bookings part of SDK-010 in its places.
    expect(contractPart).toEqual(mirror.contract);
    expect(contractPart.filter((name) => BOOKINGS_PART.includes(name))).toEqual(BOOKINGS_PART);
    expect(mirror.sdk.slice(-ADDITIONS.length)).toEqual(ADDITIONS);
    expect(rootExports).toEqual(
      expect.arrayContaining([...contractPart, ...ADDITIONS, "createCheckoutApi", "createBookingsApi"]),
    );
  });
});
