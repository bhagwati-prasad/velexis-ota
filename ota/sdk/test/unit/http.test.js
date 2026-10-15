// The request core and its transport (ota/sdk/README.md §5.3, OADR-0016 point 6, task SDK-003): how core.call turns
// params into a request through the route table, which headers every request carries, the idempotency key of a call
// (the same on every retry), each retry rule with its back-off and `Retry-After`, timeouts that are never retried,
// aborts, the onResponse hook and response parsing. Every request goes to the fake fetch; waits run on fake timers.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVelexisClient } from "../../src/index.js";
import { createCore } from "../../src/internal/client.js";
import { backoffMs } from "../../src/internal/http.js";
import { uuidV4 } from "../../src/internal/ids.js";
import { op } from "../../src/internal/operations.js";
import {
  AuthenticationError,
  ConnectionError,
  RateLimitError,
  ServerError,
  SupplierError,
  ValidationError,
} from "../../src/shared.js";
import { createFakeFetch, errorResponse, networkError } from "../helpers/fake-fetch.js";

/** Fake keys: the right prefixes, nothing that works anywhere. */
const PK = "pk_test_sdk003_fake";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE = "https://api.ota.example.com";

/**
 * A request core on a fake fetch with the given answers.
 * @param {import("../helpers/fake-fetch.js").Answer[]} [answers]
 * @param {import("../../src/shared.js").VelexisClientOptions} [options]
 */
function setup(answers = [], options = {}) {
  const fake = createFakeFetch(answers);
  const core = createCore({ publishableKey: PK, fetch: fake.fetch, ...options });
  return { fake, core };
}

/**
 * The outcome of a promise, observed at once so that a rejection is never unhandled while fake timers run.
 * @param {Promise<unknown>} promise
 * @returns {Promise<{ value?: unknown, error?: any }>}
 */
const settle = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("core.call: params to request", () => {
  it("fills path params URI-encoded, sends query params in table order and nothing else on a GET [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ body: { id: "bkg_1" } }]);

    const result = await core.call(op.bookings_get, {
      bookingId: "bkg 1/ä",
      include: ["documents", "events"],
      refresh: true,
      fareRules: undefined,
      ignored: "not a query param of this operation",
    });

    expect(result).toEqual({ id: "bkg_1" });
    expect(fake.requests).toHaveLength(1);
    expect(fake.lastRequest).toMatchObject({
      method: "GET",
      url: `${BASE}/v1/bookings/bkg%201%2F%C3%A4?refresh=true&include=documents,events`,
      body: null,
    });
    expect(fake.lastRequest?.headers["content-type"]).toBeUndefined();
    expect(fake.lastRequest?.headers["idempotency-key"]).toBeUndefined();
  });

  it("encodes arrays comma-separated, numbers and booleans as text, and drops undefined, null and empty arrays [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ body: { data: [], page: { nextCursor: null, limit: 20 } } }]);

    await core.call(op.flights_listResults, {
      searchId: "srch_1",
      carriers: ["IB", "LH", "A,B"],
      stops: [0, 1],
      maxPrice: 250.5,
      refundable: false,
      cabins: [],
      sort: undefined,
      cursor: null,
      view: "summary",
    });

    expect(fake.lastRequest?.url).toBe(
      `${BASE}/v1/flight-searches/srch_1/offers?stops=0,1&carriers=IB,LH,A%2CB&maxPrice=250.5&refundable=false&view=summary`,
    );
    expect(fake.lastRequest?.searchParams.get("carriers")).toBe("IB,LH,A,B");
  });

  it("refuses a missing path param and an object query value with a TypeError before any request [SDK-003 AC1]", async () => {
    const { fake, core } = setup();

    await expect(core.call(op.bookings_get, {})).rejects.toThrow(
      new TypeError('Velexis SDK: GET /v1/bookings/{bookingId} needs the path parameter "bookingId"'),
    );
    await expect(core.call(op.bookings_get, { bookingId: "" })).rejects.toBeInstanceOf(TypeError);
    await expect(core.call(op.bookings_get, { bookingId: "bkg_1", include: { a: 1 } })).rejects.toThrow(
      /query parameter "include"/,
    );
    await expect(core.call(op.bookings_get, /** @type {any} */ (["bkg_1"]))).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a path param of . or .., which the URL would resolve to another path, before any request [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ body: {} }]);

    for (const bookingId of [".", ".."]) {
      await expect(core.call(op.bookings_cancel, { bookingId, ifMatch: "1" })).rejects.toThrow(
        new TypeError(
          'Velexis SDK: POST /v1/bookings/{bookingId}/cancellation: the path parameter "bookingId" cannot be "." or ".."',
        ),
      );
    }
    expect(fake.requests).toHaveLength(0);

    await core.call(op.bookings_get, { bookingId: "..." });
    expect(fake.lastRequest?.path).toBe("/v1/bookings/...");
  });

  it("sends the remaining params as the JSON body, ifMatch as If-Match, and {} when nothing remains [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ body: { id: "bkg_1" } }, { body: {} }]);

    await core.call(op.bookings_cancel, {
      bookingId: "bkg_1",
      ifMatch: "7",
      reason: "change_of_plans",
      expectedRefund: { amount: "10.00", currency: "EUR" },
      note: undefined,
    });
    await core.call(op.auth_signOut);

    const [cancel, signOut] = fake.requests;
    expect(cancel).toMatchObject({
      method: "POST",
      path: "/v1/bookings/bkg_1/cancellation",
      json: { reason: "change_of_plans", expectedRefund: { amount: "10.00", currency: "EUR" } },
    });
    expect(cancel?.headers).toMatchObject({ "if-match": "7", "content-type": "application/json" });
    expect(signOut).toMatchObject({ method: "POST", body: "{}", json: {} });
  });

  it("builds multipart/form-data from Blob and text params and lets fetch set the boundary [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ status: 201, body: { id: "ast_1" } }]);
    /** @type {import("../../src/internal/operations.js").Operation} */
    const upload = {
      method: "POST",
      path: "/v1/console/settings/assets",
      pathParams: [],
      queryParams: [],
      headerParams: {},
      idempotency: "required",
      retry: "idempotent",
      timeoutMs: null,
      environment: true,
      body: "multipart",
    };

    await core.call(
      upload,
      { file: new Blob(["<svg/>"], { type: "image/svg+xml" }), kind: "logo", width: 120 },
      { headers: { "Content-Type": "application/json" } },
    );

    const form = /** @type {FormData} */ (fake.lastRequest?.body);
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("kind")).toBe("logo");
    expect(form.get("width")).toBe("120");
    expect(await /** @type {Blob} */ (form.get("file")).text()).toBe("<svg/>");
    expect(fake.lastRequest?.headers["content-type"]).toBeUndefined();
    expect(fake.lastRequest?.headers["idempotency-key"]).toMatch(UUID_V4);
  });
});

describe("headers", () => {
  it("sends Accept, the API key, locale, currency and the client's headers on every request [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ body: {} }], {
      locale: "es-ES",
      currency: "EUR",
      headers: { "X-Velexis-End-User-IP": "203.0.113.7", "X-Trace": "client" },
    });

    await core.call(op.storefront_get);

    expect(fake.lastRequest?.headers).toEqual({
      accept: "application/json",
      "accept-language": "es-ES",
      "x-currency": "EUR",
      "x-api-key": PK,
      "x-velexis-end-user-ip": "203.0.113.7",
      "x-trace": "client",
    });
  });

  it("lets the call override locale, currency and headers, and the operation's If-Match win over both [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ body: {} }], {
      locale: "es-ES",
      currency: "EUR",
      headers: { "X-Trace": "client", "X-Client-Only": "1" },
    });

    await core.call(
      op.account_preferences_update,
      { ifMatch: "3", marketingEmails: true },
      { locale: "en-GB", currency: "GBP", headers: { "x-trace": "call", "If-Match": "stale" } },
    );

    expect(fake.lastRequest?.headers).toMatchObject({
      "accept-language": "en-GB",
      "x-currency": "GBP",
      "x-trace": "call",
      "x-client-only": "1",
      "if-match": "3",
    });
  });

  it("sends the access and booking tokens, calling token functions before every request, retries included [SDK-003 AC1]", async () => {
    let calls = 0;
    const accessToken = vi.fn(async () => `at_${++calls}`);
    const { fake, core } = setup([errorResponse(503, "SERVICE_UNAVAILABLE"), { body: {} }, { body: {} }], {
      accessToken,
      bookingToken: "bt_client",
      maxRetries: 1,
    });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.useFakeTimers();

    const first = settle(core.call(op.bookings_get, { bookingId: "bkg_1" }));
    await vi.advanceTimersByTimeAsync(500);
    await first;
    await core.call(
      op.bookings_get,
      { bookingId: "bkg_1" },
      { accessToken: "at_call", bookingToken: "bt_call" },
    );

    expect(fake.requests.map((request) => request.headers["authorization"])).toEqual([
      "Bearer at_1",
      "Bearer at_2",
      "Bearer at_call",
    ]);
    expect(fake.requests.map((request) => request.headers["x-booking-token"])).toEqual([
      "bt_client",
      "bt_client",
      "bt_call",
    ]);
    expect(accessToken).toHaveBeenCalledTimes(2);
  });

  it("leaves Authorization out when the token source gives null or an empty string [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ body: {} }, { body: {} }], { accessToken: () => null, bookingToken: "" });

    await core.call(op.storefront_get);
    const other = createCore({ secretKey: "sk_test_sdk003_fake", fetch: fake.fetch, accessToken: null });
    await other.call(op.storefront_get);

    expect(fake.requests[0]?.headers["authorization"]).toBeUndefined();
    expect(fake.requests[0]?.headers["x-booking-token"]).toBeUndefined();
    expect(fake.requests[1]?.headers).toMatchObject({ "x-api-key": "sk_test_sdk003_fake" });
    expect(fake.requests[1]?.headers["authorization"]).toBeUndefined();
  });

  it("sends the storefront host and the end user from the client (value or function) or the call [SDK-003 AC1]", async () => {
    const endUser = vi.fn(() => ({ ip: "198.51.100.4", userAgent: "Agent/1.0" }));
    const { fake, core } = setup([{ body: {} }, { body: {} }], { host: "demo.ota.example.com", endUser });

    await core.call(op.storefront_get);
    await core.call(op.storefront_get, {}, { host: "www.example.org", endUser: { ip: "2001:db8::1" } });

    expect(fake.requests[0]?.headers).toMatchObject({
      "x-velexis-host": "demo.ota.example.com",
      "x-velexis-end-user-ip": "198.51.100.4",
      "x-velexis-end-user-agent": "Agent/1.0",
    });
    expect(fake.requests[1]?.headers).toMatchObject({
      "x-velexis-host": "www.example.org",
      "x-velexis-end-user-ip": "2001:db8::1",
    });
    expect(fake.requests[1]?.headers["x-velexis-end-user-agent"]).toBeUndefined();
    expect(endUser).toHaveBeenCalledTimes(1);
  });

  it("passes the fetch cache options through and uses globalThis.fetch, looked up per request, by default [SDK-003 AC1]", async () => {
    const fake = createFakeFetch([{ body: {} }]);
    const core = createCore({ publishableKey: PK, baseUrl: "http://127.0.0.1:4000/" });
    vi.stubGlobal("fetch", fake.fetch);

    await core.call(
      op.reference_airports_get,
      { iataCode: "MAD" },
      { cache: "no-store", next: { revalidate: 60, tags: ["airports"] } },
    );

    expect(fake.lastRequest?.url).toBe("http://127.0.0.1:4000/v1/reference/airports/MAD");
    expect(fake.lastRequest?.init).toMatchObject({
      cache: "no-store",
      next: { revalidate: 60, tags: ["airports"] },
    });
  });
});

describe("idempotency keys", () => {
  it("sends one UUID v4 per call on operations that take a key, and reuses it on every retry of the call [SDK-003 AC1]", async () => {
    const { fake, core } = setup(
      [errorResponse(503, "SERVICE_UNAVAILABLE"), networkError(), { body: { id: "srch_1" } }, { body: {} }],
      { maxRetries: 2 },
    );
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.useFakeTimers();

    const call = settle(core.call(op.flights_search, { originLocationCode: "MAD" }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(await call).toEqual({ value: { id: "srch_1" } });
    await core.call(op.flights_search, { originLocationCode: "BCN" });

    const keys = fake.requests.map((request) => request.headers["idempotency-key"]);
    expect(keys).toHaveLength(4);
    expect(keys[0]).toMatch(UUID_V4);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).toMatch(UUID_V4);
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("uses options.idempotencyKey, else an Idempotency-Key of the call's headers, and keeps it across retries [SDK-003 AC1]", async () => {
    const stable = "complete-chk_1-pay_1";
    const { fake, core } = setup(
      [errorResponse(504, "SUPPLIER_TIMEOUT"), { body: { bookingId: "bkg_1" } }, { body: {} }],
      { maxRetries: 1 },
    );
    vi.useFakeTimers();

    const call = settle(core.call(op.checkout_complete, { checkoutId: "chk_1" }, { idempotencyKey: stable }));
    await vi.advanceTimersByTimeAsync(600);
    await call;
    await core.call(op.checkout_create, {}, { headers: { "idempotency-key": "from-the-headers-1" } });

    expect(fake.requests.map((request) => request.headers["idempotency-key"])).toEqual([
      stable,
      stable,
      "from-the-headers-1",
    ]);
  });

  it("generates no key for an operation without one, and the client's headers never set one [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ body: {} }], { headers: { "Idempotency-Key": "client-wide-key-0001" } });

    await core.call(op.account_preferences_update, { ifMatch: "1" });

    expect(fake.lastRequest?.headers["idempotency-key"]).toBeUndefined();
  });

  it("formats keys from crypto.getRandomValues when crypto.randomUUID is missing [SDK-003 AC1]", () => {
    const getRandomValues = vi.fn((/** @type {Uint8Array} */ bytes) => bytes.fill(0xff));
    vi.stubGlobal("crypto", { getRandomValues });

    expect(uuidV4()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(getRandomValues).toHaveBeenCalledTimes(1);

    getRandomValues.mockImplementation((bytes) => bytes.fill(0));
    expect(uuidV4()).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("uses crypto.randomUUID when it exists and refuses a runtime without crypto [SDK-003 AC1]", () => {
    const keys = new Set(Array.from({ length: 50 }, () => uuidV4()));
    expect(keys.size).toBe(50);
    for (const key of keys) {
      expect(key).toMatch(UUID_V4);
    }
    vi.stubGlobal("crypto", undefined);
    expect(() => uuidV4()).toThrow(TypeError);
  });
});

describe("retries", () => {
  it.each([
    ["429", errorResponse(429, "RATE_LIMITED")],
    ["503", errorResponse(503, "SERVICE_UNAVAILABLE")],
    ["504", errorResponse(504, "SUPPLIER_TIMEOUT")],
    ["a network error", networkError()],
  ])("retries a GET after %s and returns the next answer [SDK-003 AC1]", async (_what, failure) => {
    const { fake, core } = setup([failure, { body: { ok: true } }]);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.useFakeTimers();

    const call = settle(core.call(op.storefront_get));
    await vi.advanceTimersByTimeAsync(500);

    expect(await call).toEqual({ value: { ok: true } });
    expect(fake.requests).toHaveLength(2);
  });

  it("retries at most maxRetries times (default 2) and throws the last error [SDK-003 AC1]", async () => {
    const { fake, core } = setup([
      errorResponse(503, "SERVICE_UNAVAILABLE", { requestId: "req_1" }),
      errorResponse(503, "SERVICE_UNAVAILABLE", { requestId: "req_2" }),
      errorResponse(503, "SUPPLIER_UNAVAILABLE", { requestId: "req_3" }),
    ]);
    vi.useFakeTimers();

    const call = settle(core.call(op.storefront_get));
    await vi.advanceTimersByTimeAsync(10_000);
    const { error } = await call;

    expect(fake.requests).toHaveLength(3);
    expect(error).toBeInstanceOf(SupplierError);
    expect(error).toMatchObject({ code: "SUPPLIER_UNAVAILABLE", requestId: "req_3", retryable: true });
  });

  it.each([400, 401, 404, 409, 422, 500, 501, 502])("never retries a %i [SDK-003 AC1]", async (status) => {
    const { fake, core } = setup([errorResponse(status, "SOME_CODE")]);

    await expect(core.call(op.storefront_get)).rejects.toMatchObject({ status });
    expect(fake.requests).toHaveLength(1);
  });

  it("does not retry when maxRetries is 0 [SDK-003 AC1]", async () => {
    const { fake, core } = setup([errorResponse(503, "SERVICE_UNAVAILABLE")], { maxRetries: 0 });

    await expect(core.call(op.storefront_get)).rejects.toBeInstanceOf(ServerError);
    expect(fake.requests).toHaveLength(1);
  });

  it("retries PUT and DELETE, and a POST with an Idempotency-Key [SDK-003 AC1]", async () => {
    const { fake, core } = setup([
      errorResponse(503, "SERVICE_UNAVAILABLE"),
      { body: {} },
      networkError(),
      { status: 204 },
      errorResponse(429, "RATE_LIMITED"),
      { body: {} },
    ]);
    vi.useFakeTimers();

    const put = settle(
      core.call(op.checkout_setContacts, { checkoutId: "chk_1", ifMatch: "2", contacts: [] }),
    );
    await vi.advanceTimersByTimeAsync(600);
    const del = settle(core.call(op.account_savedTravelers_delete, { savedTravelerId: "svt_1" }));
    await vi.advanceTimersByTimeAsync(600);
    const post = settle(core.call(op.checkout_create, { pricedOfferId: "prc_1" }));
    await vi.advanceTimersByTimeAsync(600);

    expect(await put).toEqual({ value: {} });
    expect(await del).toEqual({ value: undefined });
    expect(await post).toEqual({ value: {} });
    expect(fake.requests.map((request) => request.method)).toEqual([
      "PUT",
      "PUT",
      "DELETE",
      "DELETE",
      "POST",
      "POST",
    ]);
  });

  it("retries a POST the document marks x-idempotent-by-design, without generating a key for it [SDK-003 AC1]", async () => {
    const { fake, core } = setup([
      errorResponse(504, "SUPPLIER_TIMEOUT"),
      networkError(),
      { body: { id: "bkg_1" } },
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.useFakeTimers();

    const call = settle(core.call(op.console_bookings_resync, { bookingId: "bkg_1" }));
    await vi.advanceTimersByTimeAsync(1500);

    expect(await call).toEqual({ value: { id: "bkg_1" } });
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /v1/console/bookings/bkg_1/resync",
      "POST /v1/console/bookings/bkg_1/resync",
      "POST /v1/console/bookings/bkg_1/resync",
    ]);
    expect(fake.requests.map((request) => request.headers["idempotency-key"])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("never retries a PATCH without a key, nor a POST of the escape hatch without one [SDK-003 AC1]", async () => {
    const { fake, core } = setup([errorResponse(503, "SERVICE_UNAVAILABLE"), networkError()]);

    await expect(core.call(op.bookings_update, { bookingId: "bkg_1", ifMatch: "1" })).rejects.toBeInstanceOf(
      ServerError,
    );
    await expect(core.request("POST", "/v1/not-wrapped", { body: { a: 1 } })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("never retries checkout.completeWithAirlineCard, whatever maxRetries says [SDK-003 AC1]", async () => {
    const { fake, core } = setup([errorResponse(503, "SERVICE_UNAVAILABLE"), networkError()], {
      maxRetries: 5,
    });

    await expect(
      core.call(op.checkout_completeWithAirlineCard, { checkoutId: "chk_1", paymentId: "pay_1" }),
    ).rejects.toBeInstanceOf(ServerError);
    await expect(
      core.call(op.checkout_completeWithAirlineCard, { checkoutId: "chk_1", paymentId: "pay_1" }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.headers["idempotency-key"]).toMatch(UUID_V4);
  });

  it("retries the escape hatch's GET, PUT and DELETE, and its POST with the caller's key [SDK-003 AC1]", async () => {
    const { fake, core } = setup([networkError(), { body: { a: 1 } }, networkError(), { body: { b: 2 } }]);
    vi.useFakeTimers();

    const get = settle(
      core.request("GET", "/v1/not-wrapped?x=1", { query: { y: ["a", "b"], z: undefined } }),
    );
    await vi.advanceTimersByTimeAsync(600);
    const post = settle(
      core.request("POST", "/v1/not-wrapped", {
        body: {},
        options: { idempotencyKey: "escape-hatch-key-01" },
      }),
    );
    await vi.advanceTimersByTimeAsync(600);

    expect(await get).toEqual({ value: { a: 1 } });
    expect(await post).toEqual({ value: { b: 2 } });
    expect(fake.requests[0]?.url).toBe(`${BASE}/v1/not-wrapped?x=1&y=a,b`);
    expect(fake.requests.map((request) => request.headers["idempotency-key"])).toEqual([
      undefined,
      undefined,
      "escape-hatch-key-01",
      "escape-hatch-key-01",
    ]);
  });

  it("waits 0.5 s, then 1 s, then doubles up to the 8 s cap [SDK-003 AC1]", async () => {
    const failures = Array.from({ length: 7 }, () => errorResponse(503, "SERVICE_UNAVAILABLE"));
    const { fake, core } = setup([...failures, { body: {} }], { maxRetries: 7 });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.useFakeTimers();

    const call = settle(core.call(op.storefront_get));
    const waits = [500, 1000, 2000, 4000, 8000, 8000, 8000];
    for (const [index, wait] of waits.entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(fake.requests).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.requests).toHaveLength(index + 2);
    }
    expect(await call).toEqual({ value: {} });
  });

  it("adds ± 20 % jitter to each wait and never waits more than 8 s [SDK-003 AC1]", () => {
    const random = vi.spyOn(Math, "random");
    random.mockReturnValue(0);
    expect([1, 2, 3, 5].map(backoffMs)).toEqual([400, 800, 1600, 6400]);
    random.mockReturnValue(0.999_999);
    expect([1, 2, 3, 5, 9].map(backoffMs)).toEqual([600, 1200, 2400, 8000, 8000]);
  });

  it("honours Retry-After in seconds and as an HTTP date instead of the back-off [SDK-003 AC1]", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-15T12:00:00Z") });
    const { fake, core } = setup([
      errorResponse(429, "RATE_LIMITED", { headers: { "Retry-After": "3" } }),
      errorResponse(503, "SERVICE_UNAVAILABLE", {
        headers: { "Retry-After": "Thu, 15 Oct 2026 12:00:13 GMT" },
      }),
      { body: { ok: true } },
    ]);

    const call = settle(core.call(op.storefront_get));
    await vi.advanceTimersByTimeAsync(2999);
    expect(fake.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.requests).toHaveLength(2);
    // The date is 10 s after the second request (sent at 12:00:03).
    await vi.advanceTimersByTimeAsync(9999);
    expect(fake.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.requests).toHaveLength(3);
    expect(await call).toEqual({ value: { ok: true } });
  });

  it("throws RateLimitError at once when Retry-After is above 30 s, and waits 30 s when it is exactly 30 [SDK-003 AC1]", async () => {
    const { fake, core } = setup([
      errorResponse(429, "RATE_LIMITED", { headers: { "Retry-After": "31" } }),
      errorResponse(429, "RATE_LIMITED", { headers: { "Retry-After": "30" } }),
      { body: {} },
    ]);
    vi.useFakeTimers();

    const { error } = await settle(core.call(op.storefront_get));
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 31, retryable: true });
    expect(fake.requests).toHaveLength(1);

    const second = settle(core.call(op.storefront_get));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fake.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toEqual({ value: {} });
    expect(fake.requests).toHaveLength(3);
  });
});

describe("timeouts and aborts", () => {
  it("times out after the client's timeoutMs with a ConnectionError TIMEOUT and does not retry [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ delayMs: Infinity }, { body: {} }], { timeoutMs: 1000 });
    vi.useFakeTimers();

    const call = settle(core.call(op.storefront_get));
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.requests[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await call;

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ code: "TIMEOUT", status: 0, retryable: true, requestId: null });
    expect(error.message).toBe("Request timed out after 1000 ms (GET /v1/storefront)");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.requests).toHaveLength(1);
    expect(fake.remaining).toBe(1);
  });

  it("uses the route table's timeout for long operations unless the call sets one [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ delayMs: Infinity }, { delayMs: Infinity }], { timeoutMs: 1000 });
    vi.useFakeTimers();

    const search = settle(core.call(op.flights_search, {}));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.requests[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await search).error).toMatchObject({ code: "TIMEOUT" });

    const quick = settle(core.call(op.flights_search, {}, { timeoutMs: 5000 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect((await quick).error?.message).toBe("Request timed out after 5000 ms (POST /v1/flight-searches)");
  });

  it("covers reading the body with the timeout [SDK-003 AC1]", async () => {
    const stalled = new Response(new ReadableStream({ start() {} }), { status: 200 });
    const { core } = setup([stalled], { timeoutMs: 2000 });
    vi.useFakeTimers();

    const call = settle(core.call(op.storefront_get));
    await vi.advanceTimersByTimeAsync(2000);

    expect((await call).error).toMatchObject({ code: "TIMEOUT" });
  });

  it("aborts a request in flight with a ConnectionError ABORTED and does not retry it [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ delayMs: Infinity }, { body: {} }]);
    const controller = new AbortController();

    const call = settle(core.call(op.storefront_get, {}, { signal: controller.signal }));
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    controller.abort();
    const { error } = await call;

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ code: "ABORTED", status: 0, retryable: false });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.signal?.aborted).toBe(true);
  });

  it("sends nothing when the signal is already aborted, and stops waiting between retries on abort [SDK-003 AC1]", async () => {
    const { fake, core } = setup([errorResponse(503, "SERVICE_UNAVAILABLE"), { body: {} }]);
    const aborted = AbortSignal.abort();

    await expect(core.call(op.storefront_get, {}, { signal: aborted })).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(fake.requests).toHaveLength(0);

    vi.useFakeTimers();
    const controller = new AbortController();
    const call = settle(core.call(op.storefront_get, {}, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.requests).toHaveLength(1);
    controller.abort();
    expect((await call).error).toMatchObject({ code: "ABORTED" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.requests).toHaveLength(1);
  });
});

describe("responses", () => {
  it("calls onResponse for every response, retries included, with the path but no query and no headers [SDK-003 AC1]", async () => {
    vi.useFakeTimers({ now: 0 });
    const onResponse = vi.fn();
    const { core } = setup(
      [
        { ...errorResponse(503, "SERVICE_UNAVAILABLE", { requestId: "req_a" }), delayMs: 40 },
        { body: { data: [], page: { nextCursor: null, limit: 5 } }, headers: { "X-Request-Id": "req_b" } },
      ],
      { onResponse },
    );
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const call = settle(core.call(op.reference_countries_list, { limit: 5 }));
    await vi.advanceTimersByTimeAsync(540);
    await call;

    expect(onResponse.mock.calls).toEqual([
      [{ method: "GET", path: "/v1/reference/countries", status: 503, requestId: "req_a", durationMs: 40 }],
      [{ method: "GET", path: "/v1/reference/countries", status: 200, requestId: "req_b", durationMs: 0 }],
    ]);
  });

  it("ignores an onResponse hook that throws or rejects [SDK-003 AC1]", async () => {
    const { core } = setup([{ body: { a: 1 } }, { body: { b: 2 } }], {
      onResponse: () => {
        throw new Error("metrics are down");
      },
    });
    const asyncHook = createCore({
      publishableKey: PK,
      fetch: createFakeFetch([{ body: { c: 3 } }]).fetch,
      onResponse: /** @type {any} */ (async () => Promise.reject(new Error("async metrics are down"))),
    });

    await expect(core.call(op.storefront_get)).resolves.toEqual({ a: 1 });
    await expect(asyncHook.call(op.storefront_get)).resolves.toEqual({ c: 3 });
  });

  it("resolves an empty body as undefined and a non-JSON body as text [SDK-003 AC1]", async () => {
    const { core } = setup([{ status: 204 }, { body: "plain", headers: { "content-type": "text/plain" } }]);

    await expect(
      core.call(op.account_savedTravelers_delete, { savedTravelerId: "svt_1" }),
    ).resolves.toBeUndefined();
    await expect(core.request("GET", "/v1/text")).resolves.toBe("plain");
  });

  it("turns invalid JSON with a JSON content type into a ServerError without retrying [SDK-003 AC1]", async () => {
    const { fake, core } = setup([
      { body: "{not json", headers: { "content-type": "application/json", "x-request-id": "req_bad" } },
    ]);

    const error = await core.call(op.storefront_get).catch((caught) => caught);

    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      status: 200,
      requestId: "req_bad",
      retryable: false,
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("maps error responses through the public client and its escape hatch [SDK-003 AC1]", async () => {
    const fake = createFakeFetch([
      errorResponse(400, "VALIDATION_FAILED"),
      errorResponse(401, "TOKEN_EXPIRED"),
    ]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    await expect(client.request("POST", "/v1/flight-searches", { body: {} })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(client.request("GET", "/v1/auth/session")).rejects.toBeInstanceOf(AuthenticationError);
  });
});
