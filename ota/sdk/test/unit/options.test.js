// Client and request options (ota/sdk/README.md §5.1, docs/velexis-sdk/sdk/src/shared.d.ts, task SDK-003):
// createVelexisClient validates its options with the contract's defaults and throws a TypeError before any request,
// naming the option but never its value; withOptions makes a new client that shares nothing mutable; the per-call
// options are validated the same way.
import { afterEach, describe, expect, it, vi } from "vitest";

import { VERSION, createVelexisClient } from "../../src/index.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  createCore,
  validateClientOptions,
} from "../../src/internal/client.js";
import { op } from "../../src/internal/operations.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

const PK = "pk_test_sdk003_fake";
const SK = "sk_test_sdk003_fake_secret";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The TypeError that `create` throws, checked to name `name` and never to contain a key.
 * @param {() => unknown} create
 */
function typeErrorOf(create) {
  try {
    create();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    const { message } = /** @type {TypeError} */ (error);
    expect(message).toMatch(/^Velexis SDK: /);
    expect(message).not.toMatch(/sk_test|pk_test_sdk003|hk_test/);
    return message;
  }
  throw new Error("expected a TypeError");
}

describe("createVelexisClient", () => {
  it("applies the contract's defaults: base URL, 30 s timeout and 2 retries [SDK-003 AC1]", async () => {
    expect([DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES]).toEqual([
      "https://api.ota.example.com",
      30_000,
      2,
    ]);
    const fake = createFakeFetch([
      { body: {} },
      errorResponse(503, "SERVICE_UNAVAILABLE"),
      errorResponse(503, "SERVICE_UNAVAILABLE"),
      errorResponse(503, "SERVICE_UNAVAILABLE"),
      { delayMs: Infinity },
    ]);
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });
    vi.useFakeTimers();

    await client.request("GET", "/v1/storefront");
    expect(fake.requests[0]?.url).toBe("https://api.ota.example.com/v1/storefront");

    const retried = client.request("GET", "/v1/storefront").catch((error) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await retried).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(fake.requests).toHaveLength(4);

    const slow = client.request("GET", "/v1/storefront").catch((error) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fake.requests[4]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await slow).toMatchObject({ code: "TIMEOUT" });
  });

  it("returns a client with withOptions and request, and the public entry exports VERSION [SDK-003 AC1]", () => {
    const client = createVelexisClient({ publishableKey: PK, fetch: createFakeFetch().fetch });

    // Besides the namespaces of the milestones built so far (M2: storefront, reference, flights since SDK-005; M3:
    // checkout since SDK-009, bookings since SDK-010).
    expect(Object.keys(client).sort()).toEqual([
      "bookings",
      "checkout",
      "flights",
      "reference",
      "request",
      "storefront",
      "withOptions",
    ]);
    expect(typeof VERSION).toBe("string");
  });

  it("accepts every option of the contract, its augmentations and the extensions [SDK-003 AC1]", () => {
    const noop = () => {};
    expect(() =>
      createVelexisClient({
        secretKey: SK,
        baseUrl: "http://127.0.0.1:4000",
        accessToken: () => "at",
        bookingToken: null,
        refreshToken: "rt",
        onSessionRefreshed: noop,
        onSessionExpired: noop,
        locale: "en-GB",
        currency: "EUR",
        fetch: createFakeFetch().fetch,
        timeoutMs: 45_000,
        maxRetries: 0,
        headers: { "X-Velexis-End-User-IP": "203.0.113.1" },
        onResponse: noop,
        host: "demo.ota.example.com",
        endUser: { ip: "203.0.113.1", userAgent: "Agent" },
        sessionKind: "staff",
        onStaffSessionRefreshed: noop,
        session: "token",
        environment: "test",
        publishableKey: undefined,
      }),
    ).not.toThrow();
    expect(() =>
      createVelexisClient({ hostingKey: "hk_test_sdk003_fake", endUser: async () => null }),
    ).not.toThrow();
    // Cookie mode needs a browser page (SDK-004); a stand-in `document` makes this Node runtime one.
    vi.stubGlobal("document", { cookie: "" });
    expect(() => createVelexisClient({ baseUrl: "/api", session: "cookie" })).not.toThrow();
  });

  it.each([
    [
      "publishableKey",
      "sk_test_sdk003_fake_secret",
      'option "publishableKey" must be a key that starts with "pk_"',
    ],
    ["publishableKey", "pk_", 'option "publishableKey" must be a key that starts with "pk_"'],
    ["secretKey", "pk_test_sdk003_fake", 'option "secretKey" must be a key that starts with "sk_"'],
    ["secretKey", "sk_test_sdk003 fake", 'option "secretKey" must be a key that starts with "sk_"'],
    ["hostingKey", 42, 'option "hostingKey" must be a key that starts with "hk_"'],
    [
      "baseUrl",
      "ftp://api.ota.example.com",
      'option "baseUrl" must be an http(s) URL without credentials, query or fragment',
    ],
    [
      "baseUrl",
      "https://user:pw@api.ota.example.com",
      'option "baseUrl" must be an http(s) URL without credentials, query or fragment',
    ],
    [
      "baseUrl",
      "https://api.ota.example.com/?x=1",
      'option "baseUrl" must be an http(s) URL without credentials, query or fragment',
    ],
    [
      "baseUrl",
      "api.ota.example.com",
      'option "baseUrl" must be an absolute http(s) URL or a same-origin path such as /api',
    ],
    [
      "baseUrl",
      "//api.ota.example.com",
      'option "baseUrl" must be an absolute http(s) URL or a same-origin path such as /api',
    ],
    [
      "baseUrl",
      "/\\api.ota.example.com",
      'option "baseUrl" must be an absolute http(s) URL or a same-origin path such as /api',
    ],
    ["accessToken", 7, 'option "accessToken" must be a string, null or a function'],
    ["refreshToken", {}, 'option "refreshToken" must be a string, null or a function'],
    ["onResponse", "log", 'option "onResponse" must be a function'],
    ["fetch", {}, 'option "fetch" must be a function'],
    ["locale", "", 'option "locale" must be a non-empty string'],
    ["currency", "eur", 'option "currency" must be an ISO 4217 code such as EUR'],
    ["timeoutMs", 0, 'option "timeoutMs" must be an integer number of milliseconds from 1 to 2147483647'],
    [
      "timeoutMs",
      2_147_483_648,
      'option "timeoutMs" must be an integer number of milliseconds from 1 to 2147483647',
    ],
    ["timeoutMs", 1.5, 'option "timeoutMs" must be an integer number of milliseconds from 1 to 2147483647'],
    ["maxRetries", -1, 'option "maxRetries" must be an integer of 0 or more'],
    ["maxRetries", Infinity, 'option "maxRetries" must be an integer of 0 or more'],
    ["headers", { "X-Count": 1 }, 'option "headers" must be an object of header names to string values'],
    ["headers", { "Bad Name": "x" }, 'option "headers" must be an object of valid header names and values'],
    ["headers", { "X-Line": "a\nb" }, 'option "headers" must be an object of valid header names and values'],
    ["endUser", { ip: 1 }, 'option "endUser" must be an object with the strings ip and userAgent'],
    [
      "endUser",
      { address: "1.2.3.4" },
      'option "endUser" must be an object with the strings ip and userAgent',
    ],
    ["sessionKind", "admin", 'option "sessionKind" must be one of "customer", "staff"'],
    ["session", "jwt", 'option "session" must be one of "token", "cookie"'],
    ["environment", "prod", 'option "environment" must be one of "test", "live"'],
    ["timeOutMs", 1000, 'unknown option "timeOutMs"'],
  ])("refuses %s = %j with a TypeError that names it [SDK-003 AC1]", (name, value, message) => {
    expect(typeErrorOf(() => createVelexisClient({ fetch: createFakeFetch().fetch, [name]: value }))).toBe(
      `Velexis SDK: ${message}`,
    );
  });

  it("refuses more than one API key, a missing or non-object options argument, and a runtime without fetch [SDK-003 AC1]", () => {
    expect(typeErrorOf(() => createVelexisClient({ publishableKey: PK, secretKey: SK }))).toBe(
      'Velexis SDK: set only one of "publishableKey", "secretKey"',
    );
    expect(typeErrorOf(() => createVelexisClient(/** @type {any} */ (undefined)))).toBe(
      "Velexis SDK: createVelexisClient needs an options object",
    );
    expect(typeErrorOf(() => createVelexisClient(/** @type {any} */ ("pk_test_sdk003_fake")))).toBe(
      "Velexis SDK: option must be an object",
    );
    expect(typeErrorOf(() => createVelexisClient(/** @type {any} */ (new Map())))).toBe(
      "Velexis SDK: option must be an object",
    );
    vi.stubGlobal("fetch", undefined);
    expect(typeErrorOf(() => createVelexisClient({ publishableKey: PK }))).toBe(
      'Velexis SDK: this runtime has no global fetch; pass the "fetch" option',
    );
    expect(() => createVelexisClient({ publishableKey: PK, fetch: createFakeFetch().fetch })).not.toThrow();
  });

  it("trims a trailing slash of the base URL and accepts a same-origin path [SDK-003 AC1]", async () => {
    const fake = createFakeFetch([{ body: {} }, { body: {} }]);

    await createCore({ fetch: fake.fetch, baseUrl: "https://api.example.test/prefix//" }).call(
      op.storefront_get,
    );
    await createCore({ fetch: fake.fetch, baseUrl: "/api" }).call(op.storefront_get);

    expect(fake.requests.map((request) => request.url)).toEqual([
      "https://api.example.test/prefix/v1/storefront",
      "/api/v1/storefront",
    ]);
  });

  it("copies its options, so later changes to the caller's objects reach nothing [SDK-003 AC1]", async () => {
    const fake = createFakeFetch([{ body: {} }]);
    const headers = { "X-Trace": "before" };
    const options = { publishableKey: PK, fetch: fake.fetch, headers };
    const core = createCore(options);

    headers["X-Trace"] = "after";
    options.publishableKey = "pk_test_changed";
    await core.call(op.storefront_get);

    expect(fake.lastRequest?.headers).toMatchObject({ "x-trace": "before", "x-api-key": PK });
    expect(Object.isFrozen(core.options)).toBe(true);
    expect(validateClientOptions({ publishableKey: PK, locale: undefined })).toEqual({ publishableKey: PK });
  });
});

describe("withOptions", () => {
  it("makes a new client with some options replaced and leaves the original as it was [SDK-003 AC1]", async () => {
    const fake = createFakeFetch([{ body: {} }, { body: {} }, { body: {} }]);
    const client = createVelexisClient({
      secretKey: SK,
      fetch: fake.fetch,
      locale: "es-ES",
      headers: { "X-Trace": "base" },
    });

    const perRequest = client.withOptions({ accessToken: "at_staff", headers: { "X-Other": "1" } });
    await perRequest.request("GET", "/v1/console/auth/me");
    await client.request("GET", "/v1/console/auth/me");
    await perRequest.withOptions({ locale: "en-GB" }).request("GET", "/v1/console/auth/me");

    const [first, second, third] = fake.requests.map((request) => request.headers);
    expect(first).toMatchObject({
      "x-api-key": SK,
      authorization: "Bearer at_staff",
      "accept-language": "es-ES",
    });
    expect(first?.["x-other"]).toBe("1");
    expect(first?.["x-trace"]).toBeUndefined();
    expect(second?.["authorization"]).toBeUndefined();
    expect(second).toMatchObject({ "x-trace": "base" });
    expect(third).toMatchObject({ authorization: "Bearer at_staff", "accept-language": "en-GB" });
  });

  it("validates the merged options and refuses a non-object [SDK-003 AC1]", () => {
    const client = createVelexisClient({ publishableKey: PK, fetch: createFakeFetch().fetch });

    expect(typeErrorOf(() => client.withOptions({ secretKey: SK }))).toBe(
      'Velexis SDK: set only one of "publishableKey", "secretKey"',
    );
    expect(typeErrorOf(() => client.withOptions({ timeoutMs: -5 }))).toMatch(/option "timeoutMs"/);
    expect(typeErrorOf(() => client.withOptions(/** @type {any} */ (null)))).toBe(
      "Velexis SDK: withOptions needs an options object",
    );
    expect(() => client.withOptions({ publishableKey: undefined, secretKey: SK })).not.toThrow();
  });
});

describe("request options", () => {
  it.each([
    [
      { idempotencyKey: "short" },
      'request option "idempotencyKey" must be a string of 16 to 128 visible ASCII characters',
    ],
    [{ idempotencyKey: "x".repeat(129) }, 'request option "idempotencyKey"'],
    [{ idempotencyKey: "has a space in it!" }, 'request option "idempotencyKey"'],
    [{ timeoutMs: 0 }, 'request option "timeoutMs"'],
    [{ signal: { aborted: false } }, 'request option "signal" must be an AbortSignal'],
    [{ headers: { "X-Count": 2 } }, 'request option "headers"'],
    [{ accessToken: "" }, 'request option "accessToken" must be a non-empty string'],
    [{ endUser: () => ({}) }, 'request option "endUser"'],
    [{ next: "revalidate" }, 'request option "next" must be an object'],
    [{ retries: 3 }, 'unknown request option "retries"'],
  ])("refuses %j before any request [SDK-003 AC1]", async (options, message) => {
    const fake = createFakeFetch([{ body: {} }]);
    const core = createCore({ publishableKey: PK, fetch: fake.fetch });

    const error = await core
      .call(op.storefront_get, {}, /** @type {any} */ (options))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message.startsWith(`Velexis SDK: ${message}`)).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an invalid method, path or init of the escape hatch before any request [SDK-003 AC1]", async () => {
    const fake = createFakeFetch();
    const client = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });

    await expect(client.request(/** @type {any} */ ("HEAD"), "/v1/storefront")).rejects.toThrow(
      "Velexis SDK: request method must be one of GET, POST, PUT, PATCH, DELETE",
    );
    for (const path of [
      "v1/storefront",
      "//evil.example/v1",
      "/\\evil.example/v1",
      "https://evil.example/v1",
      "/v1/a b",
      "/v1#x",
    ]) {
      await expect(client.request("GET", path)).rejects.toThrow(/request path must be an API path/);
    }
    await expect(client.request("GET", "/v1/x", { body: { a: 1 } })).rejects.toThrow(
      "Velexis SDK: a GET request cannot have a body; send its values in query",
    );
    await expect(client.request("GET", "/v1/x", /** @type {any} */ ({ params: {} }))).rejects.toThrow(
      'Velexis SDK: unknown request init "params"',
    );
    await expect(client.request("GET", "/v1/x", /** @type {any} */ ({ query: "a=1" }))).rejects.toThrow(
      "Velexis SDK: request query must be an object",
    );
    expect(fake.requests).toHaveLength(0);
  });
});
