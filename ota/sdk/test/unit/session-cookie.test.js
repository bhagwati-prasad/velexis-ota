// @vitest-environment happy-dom
// Cookie mode, the hosted storefront's session (ota/sdk/README.md §4.1, OADR-0006 points 3 and 5, OADR-0016 points 5
// and 6, task SDK-004): keys, tokens and credential headers are refused with a TypeError before any request; fetch runs
// same-origin with cookies; writes copy the __Host-vx_csrf cookie into X-CSRF-Token, fetching it with GET /v1/storefront
// when it is missing and once more after 403 CSRF_TOKEN_INVALID; 401 TOKEN_EXPIRED refreshes through POST
// /v1/auth/refresh with an empty body, once for concurrent calls. `document.cookie` is a jar the fake API writes to,
// as the browser would apply its Set-Cookie (only the CSRF cookie is readable by scripts; the others are httpOnly).
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVelexisClient } from "../../src/index.js";
import { COOKIE_BASE_URL, createCore } from "../../src/internal/client.js";
import { op } from "../../src/internal/operations.js";
import { CSRF_COOKIE, readCsrfCookie } from "../../src/internal/session.js";
import { AuthenticationError, ConnectionError, PermissionError, ServerError } from "../../src/shared.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

/** Fake values with the right shapes; none of them works anywhere. */
const CSRF = "csrf_sdk004_first";
const CSRF_NEW = "csrf_sdk004_second";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The page's cookies as scripts see them (`document.cookie`), by name. */
let jar = new Map();

/**
 * Puts a cookie jar behind `document.cookie`: reading lists the cookies, writing sets one (attributes ignored).
 * @param {Record<string, string>} [cookies]
 */
function useCookies(cookies = {}) {
  jar = new Map(Object.entries(cookies));
  Object.defineProperty(globalThis.document, "cookie", {
    configurable: true,
    get: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    set: (text) => {
      const [pair = ""] = String(text).split(";");
      const index = pair.indexOf("=");
      jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    },
  });
}

afterEach(() => {
  if (globalThis.document) {
    Reflect.deleteProperty(globalThis.document, "cookie");
  }
  vi.useRealTimers();
});

/**
 * A cookie-mode client and its core on a fake fetch.
 * @param {import("../helpers/fake-fetch.js").Answer[]} [answers]
 * @param {import("../../src/shared.js").VelexisClientOptions} [options]
 */
function setup(answers = [], options = {}) {
  const fake = createFakeFetch(answers);
  const all = { session: /** @type {const} */ ("cookie"), fetch: fake.fetch, maxRetries: 0, ...options };
  return { fake, core: createCore(all), client: createVelexisClient(all) };
}

/** The answer of `GET /v1/storefront` that issues a CSRF cookie, as the API's Set-Cookie would. */
const storefrontIssuing = (/** @type {string} */ value) => () => {
  globalThis.document.cookie = `${CSRF_COOKIE}=${value}; Path=/; Secure; SameSite=Lax`;
  return { body: { id: "sf_1" } };
};

/**
 * The TypeError a call or a construction throws, checked to never contain the refused value.
 * @param {() => unknown} run
 * @param {string} value
 */
async function typeErrorOf(run, value) {
  const error = await (async () => run())().then(
    () => undefined,
    (caught) => caught,
  );
  expect(error).toBeInstanceOf(TypeError);
  expect(error.message).toMatch(/^Velexis SDK: /);
  expect(error.message).not.toContain(value);
  return error.message;
}

describe("cookie mode: refused options", () => {
  it.each([
    ["publishableKey", "pk_test_sdk004_fake"],
    ["secretKey", "sk_test_sdk004_fake_secret"],
    ["hostingKey", "hk_test_sdk004_fake"],
    ["accessToken", "at_sdk004_fake"],
    ["refreshToken", "rt_sdk004_fake"],
    ["bookingToken", "bkg_1.bt_sdk004_fake"],
  ])("refuses the option %s with a TypeError before any request [SDK-004 AC1]", async (name, value) => {
    const fake = createFakeFetch();

    const message = await typeErrorOf(
      () => createVelexisClient({ session: "cookie", fetch: fake.fetch, [name]: value }),
      value,
    );

    expect(message).toBe(
      `Velexis SDK: option "${name}" cannot be used with session "cookie"; the browser sends the session cookies`,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it.each([["accessToken"], ["refreshToken"], ["bookingToken"]])(
    "refuses the token source %s as a function or null too [SDK-004 AC1]",
    async (name) => {
      const tokenSource = vi.fn(() => "tok_sdk004_fake");

      for (const value of [tokenSource, null]) {
        expect(
          await typeErrorOf(() => createVelexisClient({ session: "cookie", [name]: value }), "tok_"),
        ).toBe(
          `Velexis SDK: option "${name}" cannot be used with session "cookie"; the browser sends the session cookies`,
        );
      }
      expect(tokenSource).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["X-Api-Key", "pk_test_sdk004_fake", "X-Api-Key"],
    ["x-api-key", "pk_test_sdk004_fake", "X-Api-Key"],
    ["Authorization", "Bearer at_sdk004_fake", "Authorization"],
    ["AUTHORIZATION", "Bearer at_sdk004_fake", "Authorization"],
  ])(
    "refuses the client header %s with a TypeError before any request [SDK-004 AC1]",
    async (header, value, named) => {
      const fake = createFakeFetch();

      const message = await typeErrorOf(
        () => createVelexisClient({ session: "cookie", fetch: fake.fetch, headers: { [header]: value } }),
        value,
      );

      expect(message).toBe(
        `Velexis SDK: option "headers" cannot set ${named} with session "cookie"; the browser sends the session cookies`,
      );
      expect(fake.requests).toHaveLength(0);
    },
  );

  it.each([
    [
      "accessToken",
      { accessToken: "at_sdk004_fake" },
      'request option "accessToken" cannot be used',
      "at_sdk004",
    ],
    [
      "bookingToken",
      { bookingToken: "bkg_1.bt_fake" },
      'request option "bookingToken" cannot be used',
      "bt_fake",
    ],
    [
      "headers.Authorization",
      { headers: { Authorization: "Bearer at_sdk004_fake" } },
      'request option "headers" cannot set Authorization',
      "at_sdk004",
    ],
    [
      "headers.x-api-key",
      { headers: { "x-api-key": "sk_test_sdk004_fake" } },
      'request option "headers" cannot set X-Api-Key',
      "sk_test",
    ],
  ])(
    "refuses the request option %s on every call, before any request [SDK-004 AC1]",
    async (_name, options, text, value) => {
      useCookies({ [CSRF_COOKIE]: CSRF });
      const { fake, core, client } = setup();

      const messages = [
        await typeErrorOf(() => core.call(op.storefront_get, {}, options), value),
        await typeErrorOf(() => core.call(op.flights_search, { originLocationCode: "MAD" }, options), value),
        await typeErrorOf(() => client.request("POST", "/v1/flight-searches", { body: {}, options }), value),
      ];

      for (const message of messages) {
        expect(message.startsWith(`Velexis SDK: ${text}`)).toBe(true);
      }
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("needs a browser page: without document the mode is refused [SDK-004 AC1]", async () => {
    vi.stubGlobal("document", undefined);

    expect(await typeErrorOf(() => createVelexisClient({ session: "cookie" }), "cookie=")).toBe(
      'Velexis SDK: session "cookie" needs a browser page (document); use a key on servers',
    );
  });

  it("cannot be switched to keys or another mode through withOptions [SDK-004 AC1]", async () => {
    const { fake, client } = setup();

    expect(
      await typeErrorOf(() => client.withOptions({ publishableKey: "pk_test_sdk004_fake" }), "pk_test"),
    ).toMatch(/option "publishableKey" cannot be used with session "cookie"/);
    expect(
      await typeErrorOf(
        () => client.withOptions({ session: "token", publishableKey: "pk_test_sdk004_fake" }),
        "pk_test",
      ),
    ).toBe('Velexis SDK: withOptions cannot switch a client with session "cookie" to another mode');
    expect(await typeErrorOf(() => client.withOptions({ session: undefined }), "token")).toBe(
      'Velexis SDK: withOptions cannot switch a client with session "cookie" to another mode',
    );
    expect(() => client.withOptions({ locale: "es-ES", session: "cookie" })).not.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
});

describe("cookie mode: requests", () => {
  it("sends same-origin requests with cookies to /api, without keys or tokens [SDK-004 AC1]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const { fake, core } = setup([{ body: { id: "sf_1" } }]);

    await core.call(op.storefront_get);

    expect(COOKIE_BASE_URL).toBe("/api");
    expect(fake.lastRequest?.url).toBe("/api/v1/storefront");
    expect(fake.lastRequest?.init).toMatchObject({ credentials: "same-origin", mode: "same-origin" });
    expect(fake.lastRequest?.headers).toEqual({ accept: "application/json" });
  });

  it("copies the CSRF cookie into X-CSRF-Token on POST, PUT, PATCH and DELETE only [SDK-004 AC1]", async () => {
    useCookies({ other: "1", [CSRF_COOKIE]: CSRF });
    const { fake, core, client } = setup([
      { body: {} },
      { body: {} },
      { body: {} },
      { status: 204 },
      { body: {} },
      { body: {} },
    ]);

    await core.call(op.storefront_get);
    await core.call(op.flights_search, { originLocationCode: "MAD" });
    await core.call(op.account_update, { firstName: "Ana" });
    await core.call(op.account_savedTravelers_delete, { savedTravelerId: "stv_1" });
    await client.request("PUT", "/v1/anything", { body: {} });
    await client.request("GET", "/v1/anything");

    expect(fake.requests.map((request) => [request.method, request.headers["x-csrf-token"]])).toEqual([
      ["GET", undefined],
      ["POST", CSRF],
      ["PATCH", CSRF],
      ["DELETE", CSRF],
      ["PUT", CSRF],
      ["GET", undefined],
    ]);
    expect(readCsrfCookie()).toBe(CSRF);
  });

  it("gets the missing CSRF cookie with one GET /v1/storefront first, shared by concurrent writes [SDK-004 AC3]", async () => {
    useCookies();
    const { fake, core } = setup([
      storefrontIssuing(CSRF),
      { status: 201, body: { id: "srch_1" } },
      { status: 201, body: { id: "srch_2" } },
      { status: 201, body: { id: "srch_3" } },
    ]);

    const results = await Promise.all(
      ["MAD", "BCN", "LIS"].map((code) => core.call(op.flights_search, { originLocationCode: code })),
    );

    expect(results).toEqual([{ id: "srch_1" }, { id: "srch_2" }, { id: "srch_3" }]);
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/v1/storefront",
      "POST /api/v1/flight-searches",
      "POST /api/v1/flight-searches",
      "POST /api/v1/flight-searches",
    ]);
    expect(fake.requests.slice(1).map((request) => request.headers["x-csrf-token"])).toEqual([
      CSRF,
      CSRF,
      CSRF,
    ]);
  });

  it("re-fetches the CSRF cookie once after 403 CSRF_TOKEN_INVALID and retries once, with the same key [SDK-004 AC3]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const { fake, core } = setup([
      errorResponse(403, "CSRF_TOKEN_INVALID"),
      storefrontIssuing(CSRF_NEW),
      { status: 201, body: { id: "srch_1" } },
    ]);

    await expect(core.call(op.flights_search, { originLocationCode: "MAD" })).resolves.toEqual({
      id: "srch_1",
    });

    const [first, refetch, retry] = fake.requests;
    expect([first?.path, refetch?.path, retry?.path]).toEqual([
      "/api/v1/flight-searches",
      "/api/v1/storefront",
      "/api/v1/flight-searches",
    ]);
    expect(first?.headers["x-csrf-token"]).toBe(CSRF);
    expect(retry?.headers["x-csrf-token"]).toBe(CSRF_NEW);
    expect(first?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(retry?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
  });

  it("never loops on CSRF failures: a second 403 after the re-fetch is thrown [SDK-004 AC3]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const { fake, core } = setup([
      errorResponse(403, "CSRF_TOKEN_INVALID"),
      storefrontIssuing(CSRF_NEW),
      errorResponse(403, "CSRF_TOKEN_INVALID"),
    ]);

    const error = await core.call(op.flights_search, { originLocationCode: "MAD" }).catch((caught) => caught);

    expect(error).toBeInstanceOf(PermissionError);
    expect(error.code).toBe("CSRF_TOKEN_INVALID");
    expect(fake.requests.map((request) => request.method)).toEqual(["POST", "GET", "POST"]);
    expect(fake.remaining).toBe(0);
  });

  it("does not loop when the API never issues the cookie: one fetch first, one after the 403 [SDK-004 AC3]", async () => {
    useCookies();
    const { fake, client } = setup([
      { body: {} },
      errorResponse(403, "CSRF_TOKEN_INVALID"),
      { body: {} },
      errorResponse(403, "CSRF_TOKEN_INVALID"),
    ]);

    await expect(client.request("DELETE", "/v1/anything")).rejects.toBeInstanceOf(PermissionError);

    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/v1/storefront",
      "DELETE /api/v1/anything",
      "GET /api/v1/storefront",
      "DELETE /api/v1/anything",
    ]);
    expect(fake.requests[1]?.headers["x-csrf-token"]).toBeUndefined();
  });

  it("asks the API, not the browser's HTTP cache, for the CSRF cookie: both fetches use cache no-store [SDK-004 AC3]", async () => {
    // storefront.get answers `Cache-Control: public, max-age=60`, and a cached copy carries no Set-Cookie, so a
    // fetch served from the cache could never issue the cookie.
    useCookies();
    const { fake, core } = setup([
      storefrontIssuing(CSRF),
      errorResponse(403, "CSRF_TOKEN_INVALID"),
      storefrontIssuing(CSRF_NEW),
      { status: 201, body: { id: "srch_1" } },
    ]);

    await core.call(op.flights_search, { originLocationCode: "MAD" });

    expect(fake.requests.map((request) => [request.method, request.path, request.init.cache])).toEqual([
      ["GET", "/api/v1/storefront", "no-store"],
      ["POST", "/api/v1/flight-searches", undefined],
      ["GET", "/api/v1/storefront", "no-store"],
      ["POST", "/api/v1/flight-searches", undefined],
    ]);
  });

  it("leaves the cache mode of the caller's own storefront.get alone [SDK-004 AC3]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const { fake, core } = setup([{ body: {} }, { body: {} }]);

    await core.call(op.storefront_get);
    await core.call(op.storefront_get, {}, { cache: "force-cache" });

    expect(fake.requests.map((request) => request.init.cache)).toEqual([undefined, "force-cache"]);
  });

  it("throws the failure of the CSRF fetch instead of sending the write [SDK-004 AC3]", async () => {
    useCookies();
    const { fake, core } = setup([errorResponse(500, "INTERNAL_ERROR")]);

    await expect(core.call(op.flights_search, { originLocationCode: "MAD" })).rejects.toBeInstanceOf(
      ServerError,
    );

    expect(fake.requests.map((request) => request.path)).toEqual(["/api/v1/storefront"]);
  });
});

describe("cookie mode: refresh", () => {
  it("refreshes on 401 TOKEN_EXPIRED with an empty body and the CSRF token, then retries once [SDK-004 AC2]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const onSessionExpired = vi.fn();
    const { fake, core } = setup(
      [
        errorResponse(401, "TOKEN_EXPIRED"),
        { body: { customer: { id: "cus_1" }, sessionExpiresAt: "2026-10-17T18:00:00Z" } },
        { body: { id: "cus_1" } },
      ],
      { onSessionExpired },
    );

    await expect(core.call(op.account_get)).resolves.toEqual({ id: "cus_1" });

    const [first, refresh, retry] = fake.requests;
    expect([first?.path, refresh?.path, retry?.path]).toEqual([
      "/api/v1/account",
      "/api/v1/auth/refresh",
      "/api/v1/account",
    ]);
    expect(refresh).toMatchObject({ method: "POST", body: "{}", json: {} });
    expect(refresh?.headers).toMatchObject({ "x-csrf-token": CSRF, "content-type": "application/json" });
    expect(refresh?.headers["authorization"]).toBeUndefined();
    expect(refresh?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(refresh?.init).toMatchObject({ credentials: "same-origin", mode: "same-origin" });
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it("shares one refresh between five concurrent calls that all get 401 TOKEN_EXPIRED, then retries all five [SDK-004 AC2]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    let refreshed = false;
    /** @type {import("../helpers/fake-fetch.js").Answer} */
    const api = (request) => {
      if (request.path === "/api/v1/auth/refresh") {
        refreshed = true;
        return { body: { customer: { id: "cus_1" } } };
      }
      return refreshed ? { body: { path: request.path } } : errorResponse(401, "TOKEN_EXPIRED");
    };
    const { fake, core } = setup(Array.from({ length: 11 }, () => api));

    const results = await Promise.all(
      ["bkg_1", "bkg_2", "bkg_3", "bkg_4", "bkg_5"].map((bookingId) =>
        core.call(op.bookings_get, { bookingId }),
      ),
    );

    expect(results.map((result) => /** @type {{ path: string }} */ (result).path)).toEqual([
      "/api/v1/bookings/bkg_1",
      "/api/v1/bookings/bkg_2",
      "/api/v1/bookings/bkg_3",
      "/api/v1/bookings/bkg_4",
      "/api/v1/bookings/bkg_5",
    ]);
    const paths = fake.requests.map((request) => request.path);
    expect(paths.filter((path) => path === "/api/v1/auth/refresh")).toHaveLength(1);
    expect(paths).toHaveLength(11);
    expect(fake.remaining).toBe(0);
  });

  it("calls onSessionExpired and throws the AuthenticationError when the refresh is refused, without a retry [SDK-004 AC2]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const onSessionExpired = vi.fn(async () => {
      throw new Error("a broken hook is ignored");
    });
    const { fake, core } = setup(
      [
        errorResponse(401, "TOKEN_EXPIRED"),
        errorResponse(401, "TOKEN_EXPIRED"),
        errorResponse(401, "REFRESH_TOKEN_REUSED"),
      ],
      { onSessionExpired },
    );

    const errors = await Promise.all([
      core.call(op.account_get).catch((caught) => caught),
      core.call(op.bookings_list).catch((caught) => caught),
    ]);

    for (const error of errors) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.code).toBe("REFRESH_TOKEN_REUSED");
    }
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/api/v1/account",
      "/api/v1/bookings",
      "/api/v1/auth/refresh",
    ]);
  });

  it("does not sign the visitor out when the refresh fails for another reason [SDK-004 AC2]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const onSessionExpired = vi.fn();
    const { core } = setup([errorResponse(401, "TOKEN_EXPIRED"), errorResponse(503, "SERVICE_UNAVAILABLE")], {
      onSessionExpired,
    });

    await expect(core.call(op.account_get)).rejects.toBeInstanceOf(ServerError);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it("retries once only: TOKEN_EXPIRED again after the refresh is thrown [SDK-004 AC2]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const { fake, core } = setup([
      errorResponse(401, "TOKEN_EXPIRED"),
      { body: { customer: { id: "cus_1" } } },
      errorResponse(401, "TOKEN_EXPIRED"),
    ]);

    const error = await core.call(op.account_get).catch((caught) => caught);

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.code).toBe("TOKEN_EXPIRED");
    expect(fake.requests).toHaveLength(3);
  });

  it("lets a call's signal end its wait for the shared refresh without stopping the refresh [SDK-004 AC2]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const { fake, core } = setup([
      errorResponse(401, "TOKEN_EXPIRED"),
      errorResponse(401, "TOKEN_EXPIRED"),
      { delayMs: 50, body: { customer: { id: "cus_1" } } },
      { body: { id: "cus_1" } },
    ]);
    vi.useFakeTimers();
    const controller = new AbortController();

    const aborted = core.call(op.account_get, {}, { signal: controller.signal }).catch((caught) => caught);
    const waiting = core.call(op.account_get);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const abortError = await aborted;
    await vi.advanceTimersByTimeAsync(50);

    expect(abortError).toBeInstanceOf(ConnectionError);
    expect(abortError.code).toBe("ABORTED");
    await expect(waiting).resolves.toEqual({ id: "cus_1" });
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/api/v1/account",
      "/api/v1/account",
      "/api/v1/auth/refresh",
      "/api/v1/account",
    ]);
  });
});

describe("cookie mode: the airline-card completion is sent once per submit", () => {
  const card = {
    checkoutId: "chk_1",
    paymentId: "pay_1",
    expectedTotal: { amount: "120.00", currency: "EUR" },
    card: {
      brand: "visa",
      holderName: "Ana Test",
      number: "4111111111111111",
      expiryMonth: 12,
      expiryYear: 2030,
    },
  };

  it("re-fetches the CSRF cookie after 403 for the next submit, but does not send the card again [SDK-004 AC3]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const { fake, core } = setup([errorResponse(403, "CSRF_TOKEN_INVALID"), storefrontIssuing(CSRF_NEW)]);

    const error = await core.call(op.checkout_completeWithAirlineCard, card).catch((caught) => caught);

    expect(error).toBeInstanceOf(PermissionError);
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/v1/checkouts/chk_1/airline-card-completion",
      "GET /api/v1/storefront",
    ]);
    expect(readCsrfCookie()).toBe(CSRF_NEW);
  });

  it("refreshes after 401 TOKEN_EXPIRED for the next submit, but does not send the card again [SDK-004 AC2]", async () => {
    useCookies({ [CSRF_COOKIE]: CSRF });
    const { fake, core } = setup([
      errorResponse(401, "TOKEN_EXPIRED"),
      { body: { customer: { id: "cus_1" } } },
    ]);

    const error = await core.call(op.checkout_completeWithAirlineCard, card).catch((caught) => caught);

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.code).toBe("TOKEN_EXPIRED");
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/api/v1/checkouts/chk_1/airline-card-completion",
      "/api/v1/auth/refresh",
    ]);
  });

  it("still gets a missing CSRF cookie before the one attempt [SDK-004 AC3]", async () => {
    useCookies();
    const { fake, core } = setup([storefrontIssuing(CSRF), { body: { status: "confirmed" } }]);

    await expect(core.call(op.checkout_completeWithAirlineCard, card)).resolves.toEqual({
      status: "confirmed",
    });
    expect(fake.requests[1]?.headers["x-csrf-token"]).toBe(CSRF);
  });
});
