// Token mode, the contract's session for third-party browser frontends (ota/sdk/README.md §4.2, docs/velexis-sdk/sdk/src/
// shared.d.ts, OADR-0016 point 6, task SDK-004): the publishable key, the access and booking tokens from their sources,
// `credentials: "omit"`; with `refreshToken` an expired access token is refreshed once through auth.refresh (one refresh
// for concurrent calls), the new tokens go to onSessionRefreshed and the call is sent once more; the session keeps the
// new tokens, so a rotated refresh token is never presented again by the client.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVelexisClient } from "../../src/index.js";
import { createCore } from "../../src/internal/client.js";
import { op } from "../../src/internal/operations.js";
import { AuthenticationError, ServerError } from "../../src/shared.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

/** Fake keys and tokens with the right shapes; none of them works anywhere. */
const PK = "pk_test_sdk004_fake";
const AT = "at_sdk004_first";
const RT = "rt_sdk004_first_000000000000";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The `AuthSessionResult` of a refresh with the n-th token pair.
 * @param {number} n
 */
const refreshed = (n) => ({
  session: {
    accessToken: `at_sdk004_${n}`,
    accessTokenExpiresAt: "2026-10-17T18:15:00Z",
    refreshToken: `rt_sdk004_${n}_00000000000000000000`,
    refreshTokenExpiresAt: "2026-11-16T18:00:00Z",
    tokenType: "Bearer",
    subject: { type: "customer", id: "cus_1" },
  },
  customer: { id: "cus_1" },
});

/**
 * A fake API whose access token `AT` has expired: `POST /v1/auth/refresh` answers the next token pair while the
 * presented refresh token is the current one (`REFRESH_TOKEN_REUSED` otherwise, as the backend revokes the family);
 * other calls answer 200 with the current access token and 401 `TOKEN_EXPIRED` with any other.
 */
function fakeApi() {
  /** @type {{ accessToken: string | null, refreshToken: string, refreshes: number }} */
  const state = { accessToken: null, refreshToken: RT, refreshes: 0 };
  /** @type {import("../helpers/fake-fetch.js").Answer} */
  const answer = (request) => {
    if (request.path === "/v1/auth/refresh" || request.path === "/v1/console/auth/refresh") {
      const presented = /** @type {{ refreshToken?: string }} */ (request.json).refreshToken;
      if (presented !== state.refreshToken) {
        return errorResponse(401, "REFRESH_TOKEN_REUSED");
      }
      state.refreshes += 1;
      const body = refreshed(state.refreshes);
      state.accessToken = body.session.accessToken;
      state.refreshToken = body.session.refreshToken;
      return { body };
    }
    return request.headers["authorization"] === `Bearer ${state.accessToken}`
      ? { body: { path: request.path, ok: true } }
      : errorResponse(401, "TOKEN_EXPIRED");
  };
  return { state, answers: (/** @type {number} */ count) => Array.from({ length: count }, () => answer) };
}

describe("token mode: requests", () => {
  it("sends the publishable key and the tokens, with credentials omitted [SDK-004 AC1]", async () => {
    const fake = createFakeFetch([{ body: {} }]);
    const core = createCore({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      bookingToken: "bkg_1.bt",
    });

    await core.call(op.bookings_get, { bookingId: "bkg_1" });

    expect(core.mode).toBe("token");
    expect(fake.lastRequest?.init.credentials).toBe("omit");
    expect(fake.lastRequest?.init.mode).toBeUndefined();
    expect(fake.lastRequest?.headers).toMatchObject({
      "x-api-key": PK,
      authorization: `Bearer ${AT}`,
      "x-booking-token": "bkg_1.bt",
    });
    expect(fake.lastRequest?.headers["x-csrf-token"]).toBeUndefined();
  });
});

describe("token mode: refresh", () => {
  it("refreshes once with the refresh token and the key only, reports the session and retries [SDK-004 AC2]", async () => {
    const api = fakeApi();
    const fake = createFakeFetch(api.answers(3));
    const onSessionRefreshed = vi.fn();
    const core = createCore({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: RT,
      onSessionRefreshed,
    });

    await expect(core.call(op.account_get)).resolves.toEqual({ path: "/v1/account", ok: true });

    const [first, refresh, retry] = fake.requests;
    expect(first?.headers["authorization"]).toBe(`Bearer ${AT}`);
    expect(refresh).toMatchObject({ method: "POST", path: "/v1/auth/refresh", json: { refreshToken: RT } });
    expect(refresh?.headers["x-api-key"]).toBe(PK);
    expect(refresh?.headers["authorization"]).toBeUndefined();
    expect(refresh?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(retry?.headers["authorization"]).toBe("Bearer at_sdk004_1");
    expect(onSessionRefreshed).toHaveBeenCalledTimes(1);
    expect(onSessionRefreshed).toHaveBeenCalledWith(refreshed(1).session);
  });

  it("shares one refresh between five concurrent calls that all get 401 TOKEN_EXPIRED and retries all five [SDK-004 AC2]", async () => {
    const api = fakeApi();
    const fake = createFakeFetch(api.answers(11));
    const onSessionRefreshed = vi.fn();
    const client = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: RT,
      onSessionRefreshed,
    });

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => client.request("GET", `/v1/bookings/bkg_${n}`)),
    );

    expect(results).toHaveLength(5);
    const refreshes = fake.requests.filter((request) => request.path === "/v1/auth/refresh");
    const calls = fake.requests.filter((request) => request.path !== "/v1/auth/refresh");
    expect(refreshes).toHaveLength(1);
    expect(calls.map((request) => request.headers["authorization"])).toEqual([
      ...Array.from({ length: 5 }, () => `Bearer ${AT}`),
      ...Array.from({ length: 5 }, () => "Bearer at_sdk004_1"),
    ]);
    expect(onSessionRefreshed).toHaveBeenCalledTimes(1);
    expect(api.state.refreshes).toBe(1);
  });

  it("retries a call whose 401 arrives after a refresh has finished, without a second refresh [SDK-004 AC2]", async () => {
    const api = fakeApi();
    const [answer] = api.answers(1);
    const fake = createFakeFetch([
      /** @type {import("../helpers/fake-fetch.js").Answer} */ (answer),
      { ...errorResponse(401, "TOKEN_EXPIRED"), delayMs: 100 },
      ...api.answers(3),
    ]);
    const core = createCore({ publishableKey: PK, fetch: fake.fetch, accessToken: AT, refreshToken: RT });
    vi.useFakeTimers();

    const fast = core.call(op.account_get);
    const slow = core.call(op.bookings_list);
    await vi.advanceTimersByTimeAsync(0);
    await expect(fast).resolves.toEqual({ path: "/v1/account", ok: true });
    await vi.advanceTimersByTimeAsync(100);

    await expect(slow).resolves.toMatchObject({ ok: true });
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/v1/account",
      "/v1/bookings",
      "/v1/auth/refresh",
      "/v1/account",
      "/v1/bookings",
    ]);
    expect(fake.requests[1]?.headers["authorization"]).toBe(`Bearer ${AT}`);
    expect(fake.requests[4]?.headers["authorization"]).toBe("Bearer at_sdk004_1");
    expect(api.state.refreshes).toBe(1);
  });

  it("keeps the new tokens: later calls and the next refresh never present a rotated token [SDK-004 AC2]", async () => {
    const api = fakeApi();
    const fake = createFakeFetch(api.answers(7));
    const client = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: RT,
    });

    await client.request("GET", "/v1/account");
    await client.request("GET", "/v1/account");
    api.state.accessToken = "at_expired_on_the_server";
    await client.request("GET", "/v1/account");

    expect(fake.requests.map((request) => request.headers["authorization"] ?? request.json)).toEqual([
      `Bearer ${AT}`,
      { refreshToken: RT },
      "Bearer at_sdk004_1",
      "Bearer at_sdk004_1",
      "Bearer at_sdk004_1",
      { refreshToken: "rt_sdk004_1_00000000000000000000" },
      "Bearer at_sdk004_2",
    ]);
    expect(api.state.refreshes).toBe(2);
  });

  it("starts withOptions clients from the new string tokens [SDK-004 AC2]", async () => {
    const api = fakeApi();
    const fake = createFakeFetch(api.answers(4));
    const core = createCore({ publishableKey: PK, fetch: fake.fetch, accessToken: AT, refreshToken: RT });

    await core.call(op.account_get);
    const derived = createVelexisClient({ ...core.derive({ locale: "es-ES" }), fetch: fake.fetch });
    await derived.request("GET", "/v1/account");

    expect(core.options).toMatchObject({
      accessToken: "at_sdk004_1",
      refreshToken: "rt_sdk004_1_00000000000000000000",
    });
    expect(Object.isFrozen(core.options)).toBe(true);
    expect(fake.lastRequest?.headers).toMatchObject({
      authorization: "Bearer at_sdk004_1",
      "accept-language": "es-ES",
    });
  });

  it("uses a token function's value once it moves on, and the new token while it still gives the rotated one [SDK-004 AC2]", async () => {
    const api = fakeApi();
    const fake = createFakeFetch(api.answers(6));
    const onSessionExpired = vi.fn();
    const store = { accessToken: AT, refreshToken: RT };
    const core = createCore({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: () => store.accessToken,
      refreshToken: async () => store.refreshToken,
      onSessionExpired,
    });

    await core.call(op.account_get);
    await core.call(op.account_get);
    // Another visitor signs in on this page: both sources move on, and the session follows them.
    store.accessToken = "at_another_visitor";
    store.refreshToken = "rt_another_visitor_000000000000";
    const error = await core.call(op.account_get).catch((caught) => caught);

    expect(fake.requests.map((request) => request.headers["authorization"] ?? request.json)).toEqual([
      `Bearer ${AT}`,
      { refreshToken: RT },
      "Bearer at_sdk004_1",
      "Bearer at_sdk004_1",
      "Bearer at_another_visitor",
      { refreshToken: "rt_another_visitor_000000000000" },
    ]);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it("sends the call again with the same Idempotency-Key after the refresh [SDK-004 AC2]", async () => {
    const api = fakeApi();
    const fake = createFakeFetch(api.answers(3));
    const core = createCore({ publishableKey: PK, fetch: fake.fetch, accessToken: AT, refreshToken: RT });

    await core.call(op.flights_search, { originLocationCode: "MAD" });

    const [first, , retry] = fake.requests;
    expect(first?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(retry?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
    expect(retry?.json).toEqual({ originLocationCode: "MAD" });
  });

  it("calls onSessionExpired and throws the AuthenticationError when the refresh token is refused [SDK-004 AC2]", async () => {
    const fake = createFakeFetch([
      errorResponse(401, "TOKEN_EXPIRED"),
      errorResponse(401, "TOKEN_EXPIRED"),
      errorResponse(401, "REFRESH_TOKEN_INVALID"),
    ]);
    const onSessionExpired = vi.fn();
    const onSessionRefreshed = vi.fn();
    const core = createCore({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: RT,
      onSessionExpired,
      onSessionRefreshed,
    });

    const errors = await Promise.all([
      core.call(op.account_get).catch((caught) => caught),
      core.call(op.bookings_list).catch((caught) => caught),
    ]);

    for (const error of errors) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.code).toBe("REFRESH_TOKEN_INVALID");
      expect(JSON.stringify(error)).not.toContain("rt_sdk004");
    }
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(onSessionRefreshed).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(3);
  });

  it("does not refresh without a refresh token, with a call's own access token, or when the source gives none [SDK-004 AC2]", async () => {
    const fake = createFakeFetch(Array.from({ length: 3 }, () => errorResponse(401, "TOKEN_EXPIRED")));
    const withoutRefresh = createCore({ publishableKey: PK, fetch: fake.fetch, accessToken: AT });
    const withRefresh = createCore({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: RT,
    });
    const signedOut = createCore({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: () => null,
    });

    for (const run of [
      () => withoutRefresh.call(op.account_get),
      () => withRefresh.call(op.account_get, {}, { accessToken: "at_of_this_call" }),
      () => signedOut.call(op.account_get),
    ]) {
      const error = await run().catch((caught) => caught);
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.code).toBe("TOKEN_EXPIRED");
    }
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/v1/account",
      "/v1/account",
      "/v1/account",
    ]);
  });

  it("does not refresh a call that sends its own Authorization header, per call or in the client's headers [SDK-004 AC2]", async () => {
    const fake = createFakeFetch(Array.from({ length: 2 }, () => errorResponse(401, "TOKEN_EXPIRED")));
    const onSessionRefreshed = vi.fn();
    const withRefresh = createCore({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: RT,
      onSessionRefreshed,
    });
    const withHeader = createCore({
      publishableKey: PK,
      fetch: fake.fetch,
      refreshToken: RT,
      headers: { Authorization: "Bearer at_of_the_client_headers" },
    });

    for (const run of [
      () => withRefresh.call(op.account_get, {}, { headers: { authorization: "Bearer at_of_this_call" } }),
      () => withHeader.call(op.account_get),
    ]) {
      const error = await run().catch((caught) => caught);
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.code).toBe("TOKEN_EXPIRED");
    }
    expect(fake.requests.map((request) => [request.path, request.headers["authorization"]])).toEqual([
      ["/v1/account", "Bearer at_of_this_call"],
      ["/v1/account", "Bearer at_of_the_client_headers"],
    ]);
    expect(onSessionRefreshed).not.toHaveBeenCalled();
  });

  it("ignores failing session hooks, and refuses a refresh answer without tokens [SDK-004 AC2]", async () => {
    const api = fakeApi();
    const fake = createFakeFetch([
      ...api.answers(3),
      errorResponse(401, "TOKEN_EXPIRED"),
      { body: { customer: { id: "cus_1" } } },
    ]);
    const core = createCore({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: RT,
      onSessionRefreshed: () => {
        throw new Error("storage failed");
      },
    });

    await expect(core.call(op.account_get)).resolves.toMatchObject({ ok: true });
    const error = await core.call(op.account_get).catch((caught) => caught);

    expect(error).toBeInstanceOf(ServerError);
    expect(error.code).toBe("INTERNAL_ERROR");
  });

  it("forwards the call's host and end user to the refresh, nothing else of the call [SDK-004 AC2]", async () => {
    const api = fakeApi();
    const fake = createFakeFetch(api.answers(3));
    const core = createCore({ publishableKey: PK, fetch: fake.fetch, accessToken: AT, refreshToken: RT });

    await core.call(
      op.account_get,
      {},
      {
        host: "demo.ota.example.com",
        endUser: { ip: "203.0.113.9" },
        headers: { "X-Velexis-End-User-Agent": "Agent/2", "X-Trace": "call" },
        idempotencyKey: "call-key-0000000001",
      },
    );

    const refresh = fake.requests[1];
    expect(refresh?.headers).toMatchObject({
      "x-velexis-host": "demo.ota.example.com",
      "x-velexis-end-user-ip": "203.0.113.9",
      "x-velexis-end-user-agent": "Agent/2",
    });
    expect(refresh?.headers["x-trace"]).toBeUndefined();
    expect(refresh?.headers["idempotency-key"]).not.toBe("call-key-0000000001");
  });
});
