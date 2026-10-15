// Error mapping (ota/sdk/README.md §5.3, OADR-0016 point 6, task SDK-003): every code of the `x-error-catalogue` of
// the working OpenAPI document becomes the contract's class for its status and code (the list of `fromErrorData` in
// docs/velexis-sdk/sdk/src/react.d.ts), responses without the envelope get a generic code, failures before a response
// are ConnectionErrors, and `toJSON()` never contains keys, tokens or request bodies.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { createVelexisClient } from "../../src/index.js";
import { createCore } from "../../src/internal/client.js";
import { connectionError, errorClassFor, parseRetryAfter } from "../../src/internal/errors.js";
import { op } from "../../src/internal/operations.js";
import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  ExpiredError,
  NotFoundError,
  PaymentError,
  PermissionError,
  PriceChangedError,
  RateLimitError,
  ServerError,
  SoldOutError,
  SupplierError,
  ValidationError,
  VelexisError,
  isVelexisError,
} from "../../src/shared.js";
import { createFakeFetch, errorResponse, networkError } from "../helpers/fake-fetch.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const DOCUMENT = join(REPO_ROOT, "ota", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");
/** @type {Record<string, { status: number }>} */
const CATALOGUE = parse(readFileSync(DOCUMENT, "utf8"))["x-error-catalogue"];

const PK = "pk_test_sdk003_fake";
/** A fake secret key: the right prefix, nothing that works anywhere. */
const SK = "sk_test_sdk003_fake_secret";

/**
 * The class each status maps to (react.d.ts `fromErrorData`): 400 / 422 ValidationError, 401 AuthenticationError,
 * 402 PaymentError, 403 PermissionError, 404 NotFoundError, 409 ConflictError, 410 ExpiredError, 429 RateLimitError,
 * 424 / 502 / 504 SupplierError, 500 / other 503 ServerError; 412 and 423 have no class of their own. 501 is
 * ServerError (OADR-0016 point 6). A status the catalogue gains later fails the test until it is added here.
 */
const CLASS_BY_STATUS = new Map([
  [400, ValidationError],
  [401, AuthenticationError],
  [402, PaymentError],
  [403, PermissionError],
  [404, NotFoundError],
  [409, ConflictError],
  [410, ExpiredError],
  [412, VelexisError],
  [422, ValidationError],
  [423, VelexisError],
  [424, SupplierError],
  [429, RateLimitError],
  [500, ServerError],
  [501, ServerError],
  [502, SupplierError],
  [503, ServerError],
  [504, SupplierError],
]);
/** Codes whose class is not their status's. */
const CLASS_BY_CODE = new Map([
  ["PRICE_CHANGED", PriceChangedError],
  ["SOLD_OUT", SoldOutError],
  ["SUPPLIER_UNAVAILABLE", SupplierError],
]);
/** Codes that may succeed when the same call is made later, besides the 429, 500, 502, 503 and 504 statuses. */
const RETRY_LATER_CODES = new Set(["ACCOUNT_LOCKED", "DOCUMENT_NOT_READY"]);

/**
 * The error of one call answered with the given answers (no retries).
 * @param {import("../helpers/fake-fetch.js").Answer[]} answers
 * @param {import("../../src/shared.js").VelexisClientOptions} [options]
 */
async function failWith(answers, options = {}) {
  const fake = createFakeFetch(answers);
  const core = createCore({ publishableKey: PK, fetch: fake.fetch, maxRetries: 0, ...options });
  const error = await core.call(op.storefront_get).then(
    () => {
      throw new Error("expected the call to fail");
    },
    (caught) => caught,
  );
  return { error, fake };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the error catalogue", () => {
  it("has entries, each with an HTTP error status", () => {
    const entries = Object.entries(CATALOGUE);
    expect(entries.length).toBeGreaterThan(60);
    for (const [code, { status }] of entries) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(status, code).toBeGreaterThanOrEqual(400);
    }
  });

  it.each(Object.entries(CATALOGUE).map(([code, { status }]) => [code, status]))(
    "maps %s (%i) to the contract's class [SDK-003 AC1]",
    async (code, status) => {
      const expected = CLASS_BY_CODE.get(code) ?? CLASS_BY_STATUS.get(status);
      expect(expected, `status ${status} of ${code} has no class in this test yet`).toBeDefined();

      const { error } = await failWith([errorResponse(status, code, { requestId: `req_${code}` })]);

      expect(Object.getPrototypeOf(error)).toBe(expected?.prototype);
      expect(error).toBeInstanceOf(VelexisError);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        name: expected?.name,
        code,
        status,
        message: `Fake ${code}`,
        requestId: `req_${code}`,
        fieldErrors: [],
        retryable: RETRY_LATER_CODES.has(code) || [429, 500, 502, 503, 504].includes(status),
      });
    },
  );

  it("maps 501 NOT_IMPLEMENTED of a deferred operation to a ServerError that is not retryable [SDK-003 AC1]", async () => {
    const { error, fake } = await failWith(
      [
        errorResponse(501, "NOT_IMPLEMENTED", {
          details: { milestone: "deferred", operationId: "resolveStorefront" },
        }),
      ],
      { maxRetries: 2 },
    );

    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({
      code: "NOT_IMPLEMENTED",
      status: 501,
      retryable: false,
      details: { milestone: "deferred", operationId: "resolveStorefront" },
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("maps by status alone for a code it does not know, and keeps the code [SDK-003 AC1]", async () => {
    expect(errorClassFor(403, "SOMETHING_NEW")).toBe(PermissionError);
    expect(errorClassFor(418, "SOMETHING_NEW")).toBe(VelexisError);
    expect(errorClassFor(505, "SOMETHING_NEW")).toBe(ServerError);

    const { error } = await failWith([errorResponse(409, "BRAND_NEW_CONFLICT")]);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("BRAND_NEW_CONFLICT");
  });
});

describe("the envelope", () => {
  it("copies details, valid field errors and the supplier issue, and prefers the body's requestId [SDK-003 AC1]", async () => {
    const { error } = await failWith([
      errorResponse(422, "SUPPLIER_REJECTED", {
        requestId: "req_body",
        headers: { "x-request-id": "req_header" },
        details: { errors: [{ code: 477 }] },
        fieldErrors: [
          { path: "/travelers/0/dateOfBirth", code: "invalid", message: "Invalid date" },
          { code: "no path" },
          "not an object",
        ],
        supplier: { provider: "amadeus", status: 400, code: 477, title: "INVALID FORMAT" },
      }),
    ]);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      requestId: "req_body",
      details: { errors: [{ code: 477 }] },
      fieldErrors: [{ path: "/travelers/0/dateOfBirth", code: "invalid", message: "Invalid date" }],
      supplier: { provider: "amadeus", status: 400, code: 477, title: "INVALID FORMAT" },
    });
  });

  it("takes the requestId from X-Request-Id when the body has none [SDK-003 AC1]", async () => {
    const { error } = await failWith([
      {
        status: 404,
        headers: { "x-request-id": "req_header" },
        body: { error: { code: "NOT_FOUND", message: "No" } },
      },
    ]);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({
      requestId: "req_header",
      message: "No",
      supplier: undefined,
      details: undefined,
    });
  });

  it.each([
    [
      "a proxy's HTML 502",
      { status: 502, statusText: "Bad Gateway", body: "<html>down</html>" },
      ServerError,
      "SERVICE_UNAVAILABLE",
      true,
    ],
    ["an empty 504", { status: 504 }, ServerError, "SERVICE_UNAVAILABLE", true],
    ["an empty 503", { status: 503 }, ServerError, "SERVICE_UNAVAILABLE", true],
    ["a 500 page", { status: 500, body: "Internal" }, ServerError, "INTERNAL_ERROR", true],
    ["a 404 page", { status: 404, body: "Not here" }, NotFoundError, "NOT_FOUND", false],
    ["an empty 429", { status: 429 }, RateLimitError, "RATE_LIMITED", true],
    ["a 413", { status: 413, body: "Too large" }, VelexisError, "INVALID_REQUEST", false],
    [
      "an envelope with a malformed code",
      { status: 400, body: { error: { code: "bad code", message: "x" } } },
      ValidationError,
      "INVALID_REQUEST",
      false,
    ],
  ])(
    "maps %s without the API's envelope by its status [SDK-003 AC1]",
    async (_what, answer, expected, code, retryable) => {
      const { error } = await failWith([answer]);

      expect(Object.getPrototypeOf(error)).toBe(expected.prototype);
      expect(error).toMatchObject({ code, status: answer.status, retryable, requestId: null });
      expect(error.message).toMatch(new RegExp(`^The API answered ${answer.status}`));
      expect(error.message).not.toMatch(/down|Internal|Not here|Too large/);
    },
  );

  it("gives a PriceChangedError its prices and priced offer from details [SDK-003 AC1]", async () => {
    const newPrice = { amount: "512.40", currency: "EUR" };
    const { error } = await failWith([
      errorResponse(409, "PRICE_CHANGED", {
        details: { newPrice, oldPrice: { amount: "498.00", currency: "EUR" }, pricedOfferId: "prc_2" },
      }),
    ]);

    expect(error).toBeInstanceOf(PriceChangedError);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      newPrice,
      oldPrice: { amount: "498.00", currency: "EUR" },
      pricedOfferId: "prc_2",
    });

    const bare = new PriceChangedError({
      code: "PRICE_CHANGED",
      message: "m",
      status: 409,
      details: { newPrice: 5 },
    });
    expect(bare).toMatchObject({ newPrice: undefined, oldPrice: undefined, pricedOfferId: undefined });
  });

  it("gives a RateLimitError its Retry-After, else details.retryAfterSeconds [SDK-003 AC1]", async () => {
    const fromHeader = await failWith([
      errorResponse(429, "RATE_LIMITED", { headers: { "Retry-After": "45" } }),
    ]);
    const fromDetails = await failWith([
      errorResponse(429, "RATE_LIMITED", { details: { retryAfterSeconds: 12 } }),
    ]);
    const neither = await failWith([errorResponse(429, "RATE_LIMITED")]);

    expect(fromHeader.error.retryAfterSeconds).toBe(45);
    expect(fromDetails.error.retryAfterSeconds).toBe(12);
    expect(neither.error.retryAfterSeconds).toBeUndefined();
    expect(parseRetryAfter("not a date", 0)).toBeUndefined();
    expect(parseRetryAfter("1.5", 0)).toBe(1.5);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:01 GMT", 5000)).toBe(0);
  });
});

describe("connection errors", () => {
  it.each([
    ["NETWORK_ERROR", true],
    ["TIMEOUT", true],
    ["ABORTED", false],
  ])("are ConnectionErrors with status 0: %s (retryable %s) [SDK-003 AC1]", (code, retryable) => {
    const cause = new TypeError("fetch failed");
    const error = connectionError(/** @type {any} */ (code), "Network error (GET /v1/storefront)", cause);

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({
      name: "ConnectionError",
      code,
      status: 0,
      requestId: null,
      retryable,
      cause,
    });
  });

  it("reports a failed fetch as NETWORK_ERROR with the failure as its cause [SDK-003 AC1]", async () => {
    const { error } = await failWith([networkError("getaddrinfo ENOTFOUND")]);

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ code: "NETWORK_ERROR", message: "Network error (GET /v1/storefront)" });
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});

describe("the error classes", () => {
  it.each([
    VelexisError,
    ValidationError,
    AuthenticationError,
    PermissionError,
    NotFoundError,
    ConflictError,
    PriceChangedError,
    SoldOutError,
    ExpiredError,
    PaymentError,
    RateLimitError,
    SupplierError,
    ConnectionError,
    ServerError,
  ])(
    "%o can be built from the contract's constructor argument and names itself [SDK-003 AC1]",
    (ErrorClass) => {
      const error = new ErrorClass({ code: "SOME_CODE", message: "Something", status: 418 });

      expect(error.name).toBe(ErrorClass.name);
      expect(String(error)).toBe(`${ErrorClass.name}: Something`);
      expect(error).toBeInstanceOf(VelexisError);
      expect(error).toMatchObject({
        code: "SOME_CODE",
        status: 418,
        requestId: null,
        details: undefined,
        fieldErrors: [],
        supplier: undefined,
        retryable: false,
      });
      expect(error.toJSON()).toEqual({
        name: ErrorClass.name,
        code: "SOME_CODE",
        message: "Something",
        status: 418,
        requestId: null,
        fieldErrors: [],
        retryable: false,
      });
    },
  );

  it("isVelexisError recognises SDK errors, optionally by code [SDK-003 AC1]", () => {
    const error = new SoldOutError({ code: "SOLD_OUT", message: "Gone", status: 409 });

    expect(isVelexisError(error)).toBe(true);
    expect(isVelexisError(error, "SOLD_OUT")).toBe(true);
    expect(isVelexisError(error, "PRICE_CHANGED")).toBe(false);
    expect(isVelexisError(new Error("plain"))).toBe(false);
    expect(isVelexisError({ name: "VelexisError", code: "SOLD_OUT", status: 409 })).toBe(false);
    expect(isVelexisError(null)).toBe(false);
  });
});

describe("toJSON", () => {
  it.each([
    [
      "an API error that echoes the key in its message and details",
      errorResponse(401, "INVALID_API_KEY", {
        message: `The key ${SK} is unknown`,
        details: { apiKey: SK, hint: `rotate ${SK}`, nested: [{ key: SK }] },
      }),
    ],
    ["a proxy error page that shows the key", { status: 502, body: `<p>${SK}</p>` }],
    ["a network failure whose message names the key", { error: new TypeError(`connect failed for ${SK}`) }],
    ["a timeout", { delayMs: Infinity }],
  ])(
    "contains no sk_ string for %s raised from a request with a secret key [SDK-003 AC2]",
    async (_what, answer) => {
      const fake = createFakeFetch([answer]);
      const client = createVelexisClient({
        secretKey: SK,
        fetch: fake.fetch,
        timeoutMs: 1000,
        maxRetries: 0,
      });
      vi.useFakeTimers();

      const outcome = client.request("GET", "/v1/console/bookings").catch((caught) => caught);
      await vi.advanceTimersByTimeAsync(1000);
      const error = await outcome;

      expect(fake.lastRequest?.headers["x-api-key"]).toBe(SK);
      expect(isVelexisError(error)).toBe(true);
      expect(JSON.stringify(error.toJSON())).not.toContain("sk_");
      expect(JSON.stringify(error)).not.toContain("sk_");
      expect(error.message).not.toContain("sk_");
    },
  );

  it("drops tokens from details, redacts bearer tokens and JWTs, and keeps the rest [SDK-003 AC2]", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdXNfMSJ9.c2lnbmF0dXJl";
    const { error } = await failWith([
      errorResponse(504, "SUPPLIER_TIMEOUT", {
        message: `Timed out for Bearer ${jwt}`,
        details: {
          bookingId: "bkg_1",
          bookingToken: "bt_guest_secret",
          bookingTokenExpiresAt: "2026-10-16T12:00:00Z",
          card: { brand: "visa", cardNumber: "4242424242424242", securityCode: "123" },
          reconcileBy: "2026-10-15T12:15:00Z",
          note: `token ${jwt}`,
        },
      }),
    ]);

    expect(error.details).toMatchObject({ bookingToken: "bt_guest_secret" });
    const json = error.toJSON();
    expect(json.details).toEqual({
      bookingId: "bkg_1",
      card: { brand: "visa" },
      reconcileBy: "2026-10-15T12:15:00Z",
      note: "token [redacted]",
    });
    expect(json.message).toBe("Timed out for [redacted]");
    expect(JSON.stringify(json)).not.toMatch(/bt_guest_secret|eyJ|4242|"123"/);
  });

  it("never contains the request body, for example the card of an airline-card completion [SDK-003 AC2]", async () => {
    const fake = createFakeFetch([errorResponse(402, "PAYMENT_DECLINED"), networkError()]);
    const core = createCore({ publishableKey: PK, fetch: fake.fetch });
    const card = { number: "4242424242424242", securityCode: "123", holderName: "Ada Lovelace" };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await core
        .call(op.checkout_completeWithAirlineCard, { checkoutId: "chk_1", paymentId: "pay_1", card })
        .catch((caught) => caught);

      expect(fake.lastRequest?.json).toMatchObject({ card });
      const everything = JSON.stringify([error.toJSON(), error, error.message, Object.entries(error)]);
      expect(everything).not.toMatch(/4242424242424242|Ada Lovelace/);
    }
    expect(fake.requests).toHaveLength(2);
  });
});
