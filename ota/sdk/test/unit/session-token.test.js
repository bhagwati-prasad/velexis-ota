// Token mode, the contract's session for third-party browser frontends (ota/sdk/README.md §4.2, docs/velexis-sdk/sdk/src/
// shared.d.ts, OADR-0016 point 6, task SDK-004): the publishable key, the access and booking tokens from their sources,
// `credentials: "omit"`; with `refreshToken` an expired access token is refreshed once through auth.refresh (one refresh
// for concurrent calls), the new tokens go to onSessionRefreshed and the call is sent once more; the session keeps the
// new tokens, so a rotated refresh token is never presented again by the client. The clients of a family (a client and
// those derived from it with withOptions) share the refresh of each refresh-token value and the tokens that replaced
// it, so clients holding the same refresh token send one refresh and never present a rotated one, and clients with
// different refresh tokens share nothing (task SDK-017).
import { AsyncLocalStorage } from "node:async_hooks";

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

/** The second client of each pair sends `X-Currency: EUR`, so the fake API can tell its requests apart. */
const SECOND = /** @type {const} */ ({ currency: "EUR" });

/**
 * A fake API for the clients of one family (SDK-017), as strict as the backend's refresh: one session whose refresh
 * token rotates on every refresh, and a refresh token presented again answers `401 REFRESH_TOKEN_REUSED` (counted in
 * `state.reused`, every presented token in `state.presented`). A call with the session's current access token answers
 * 200 with its path and which client sent it; any other `401 TOKEN_EXPIRED`. `api.holdRefusals(n)` answers the next
 * `n` refusals together, once all of them have been sent (calls in flight at once); `api.delaySecondRefusal()` answers
 * the second client's next refusal 100 ms late, after the first client's refresh has finished (its attempt went out
 * before the refresh, its refusal arrives after).
 */
function familyApi() {
  /** @type {{ accessToken: string | null, refreshToken: string, refreshes: number, presented: string[], reused: number }} */
  const state = { accessToken: null, refreshToken: RT, refreshes: 0, presented: [], reused: 0 };
  let held = 0;
  let release = () => {};
  /** @type {Promise<void>} */
  let allSent = Promise.resolve();
  let delaySecond = false;
  /** @type {import("../helpers/fake-fetch.js").Answer} */
  const answer = async (request) => {
    if (request.path === "/v1/auth/refresh") {
      const presented = /** @type {{ refreshToken: string }} */ (request.json).refreshToken;
      state.presented.push(presented);
      if (presented !== state.refreshToken) {
        state.reused += 1;
        return errorResponse(401, "REFRESH_TOKEN_REUSED");
      }
      state.refreshes += 1;
      const body = refreshed(state.refreshes);
      state.accessToken = body.session.accessToken;
      state.refreshToken = body.session.refreshToken;
      return { body };
    }
    const client = request.headers["x-currency"] === "EUR" ? "second" : "first";
    if (request.headers["authorization"] === `Bearer ${state.accessToken}`) {
      return { body: { path: request.path, client } };
    }
    if (held > 0) {
      held -= 1;
      if (held === 0) {
        release();
      }
      await allSent;
    } else if (delaySecond && client === "second") {
      delaySecond = false;
      return { ...errorResponse(401, "TOKEN_EXPIRED"), delayMs: 100 };
    }
    return errorResponse(401, "TOKEN_EXPIRED");
  };
  return {
    state,
    answers: (/** @type {number} */ count) => Array.from({ length: count }, () => answer),
    /** @param {number} count */
    holdRefusals(count) {
      held = count;
      allSent = new Promise((resolve) => {
        release = () => resolve(undefined);
      });
    },
    delaySecondRefusal() {
      delaySecond = true;
    },
    /** The session's access token expires on the server; the refresh token stays the current one. */
    expireAccessToken() {
      state.accessToken = "at_expired_on_the_server";
    },
  };
}

/**
 * The two clients of one family that hold the same refresh token, by how they came to hold it. The first client's
 * hook, `onSessionRefreshed`, is the second's too.
 * @type {Record<string, (setup: { fetch: typeof fetch, api: ReturnType<typeof familyApi>, onSessionRefreshed: () => void }) => Promise<[import("../../src/index.js").VelexisClient, import("../../src/index.js").VelexisClient]>>}
 */
const PAIRS = {
  "a client and a client derived from it before a refresh": async ({ fetch, onSessionRefreshed }) => {
    const first = createVelexisClient({
      publishableKey: PK,
      fetch,
      accessToken: AT,
      refreshToken: RT,
      onSessionRefreshed,
    });
    return [first, first.withOptions(SECOND)];
  },
  "a client and a client derived from it after a refresh": async ({ fetch, api, onSessionRefreshed }) => {
    const first = createVelexisClient({
      publishableKey: PK,
      fetch,
      accessToken: AT,
      refreshToken: RT,
      onSessionRefreshed,
    });
    await first.account.get();
    // Both now hold the first refresh's tokens, until the access token expires again.
    const second = first.withOptions(SECOND);
    api.expireAccessToken();
    return [first, second];
  },
  "two clients derived with the same refreshToken string": async ({ fetch, onSessionRefreshed }) => {
    const anonymous = createVelexisClient({ publishableKey: PK, fetch });
    const tokens = { accessToken: AT, refreshToken: RT, onSessionRefreshed };
    return [anonymous.withOptions(tokens), anonymous.withOptions({ ...tokens, ...SECOND })];
  },
};

/**
 * How the calls of the two clients meet the expired access token.
 * @type {Record<string, (pair: { first: import("../../src/index.js").VelexisClient, second: import("../../src/index.js").VelexisClient, api: ReturnType<typeof familyApi> }) => Promise<unknown[]>>}
 */
const TIMINGS = {
  "answered 401 TOKEN_EXPIRED at once": ({ first, second, api }) => {
    api.holdRefusals(2);
    return Promise.all([first.account.get(), second.account.get()]);
  },
  "one after the other": async ({ first, second }) => [await first.account.get(), await second.account.get()],
  "the second client first, then the first": async ({ first, second }) => {
    const fromSecond = await second.account.get();
    return [await first.account.get(), fromSecond];
  },
  "the second client's refusal arriving after the first client's refresh": async ({ first, second, api }) => {
    api.delaySecondRefusal();
    vi.useFakeTimers();
    const both = Promise.all([first.account.get(), second.account.get()]);
    await vi.advanceTimersByTimeAsync(100);
    return both;
  },
};

describe("token mode: the clients of a family share the refresh of a refresh token", () => {
  for (const [pairName, makePair] of Object.entries(PAIRS)) {
    for (const [timingName, run] of Object.entries(TIMINGS)) {
      it(`${pairName}, ${timingName}: send one refresh for the token and never REFRESH_TOKEN_REUSED [SDK-017 AC1]`, async () => {
        const api = familyApi();
        const fake = createFakeFetch(api.answers(16));
        const onSessionRefreshed = vi.fn();
        const [first, second] = await makePair({ fetch: fake.fetch, api, onSessionRefreshed });
        const refreshesBefore = api.state.refreshes;
        const reportedBefore = onSessionRefreshed.mock.calls.length;

        const results = await run({ first, second, api });

        expect(results).toEqual([
          { path: "/v1/account", client: "first" },
          { path: "/v1/account", client: "second" },
        ]);
        expect(api.state.reused).toBe(0);
        expect(api.state.refreshes).toBe(refreshesBefore + 1);
        expect(new Set(api.state.presented).size).toBe(api.state.presented.length);
        // The new tokens are reported once, and both clients send them from now on.
        expect(onSessionRefreshed).toHaveBeenCalledTimes(reportedBefore + 1);
        expect(onSessionRefreshed).toHaveBeenLastCalledWith(refreshed(api.state.refreshes).session);
        const sentBefore = fake.requests.length;
        await first.request("GET", "/v1/bookings");
        await second.request("GET", "/v1/bookings");
        expect(fake.requests.slice(sentBefore).map((request) => request.headers["authorization"])).toEqual([
          `Bearer at_sdk004_${api.state.refreshes}`,
          `Bearer at_sdk004_${api.state.refreshes}`,
        ]);
      });
    }
  }

  it("lets a client derived from a client that has never refreshed take the tokens of a sibling's refresh, and start from them in withOptions [SDK-017 AC1]", async () => {
    const api = familyApi();
    const fake = createFakeFetch(api.answers(4));
    const parent = createCore({ publishableKey: PK, fetch: fake.fetch, accessToken: AT, refreshToken: RT });
    const sibling = createCore(parent.derive({ currency: "EUR" }), parent.family);

    await sibling.call(op.account_get);
    const grandchild = createCore(parent.derive({ locale: "es-ES" }), parent.family);
    await grandchild.call(op.account_get);

    // The parent never refreshed, yet it and what is derived from it start from the sibling's new tokens.
    expect(parent.options).toMatchObject({
      accessToken: "at_sdk004_1",
      refreshToken: "rt_sdk004_1_00000000000000000000",
    });
    expect(fake.requests.map((request) => request.headers["authorization"] ?? request.json)).toEqual([
      `Bearer ${AT}`,
      { refreshToken: RT },
      "Bearer at_sdk004_1",
      "Bearer at_sdk004_1",
    ]);
    expect(api.state.reused).toBe(0);
  });

  it("sends a call again without another refresh when a client of the family finished refreshing while the refresh-token function was answering [SDK-017 AC1]", async () => {
    const api = familyApi();
    const fake = createFakeFetch(api.answers(5));
    let read = 0;
    const first = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      // The second read (the second client's) takes 50 ms, while the first client's refresh comes and goes.
      refreshToken: async () => {
        read += 1;
        if (read === 2) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return RT;
      },
    });
    const second = first.withOptions(SECOND);
    vi.useFakeTimers();

    const both = Promise.all([first.account.get(), second.account.get()]);
    await vi.advanceTimersByTimeAsync(50);

    expect(await both).toEqual([
      { path: "/v1/account", client: "first" },
      { path: "/v1/account", client: "second" },
    ]);
    expect(api.state.presented).toEqual([RT]);
    expect(fake.requests.map((request) => request.headers["authorization"] ?? request.json)).toEqual([
      `Bearer ${AT}`,
      `Bearer ${AT}`,
      { refreshToken: RT },
      "Bearer at_sdk004_1",
      "Bearer at_sdk004_1",
    ]);
  });

  it("follows a chain of refreshes made by other clients: a client that held the first token presents only the newest [SDK-017 AC1]", async () => {
    const api = familyApi();
    const fake = createFakeFetch(api.answers(9));
    const first = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: RT,
    });
    const second = first.withOptions(SECOND);
    const third = first.withOptions({ locale: "es-ES" });

    await second.account.get();
    api.expireAccessToken();
    await third.account.get();
    api.expireAccessToken();
    await first.account.get();

    expect(api.state.presented).toEqual([
      RT,
      "rt_sdk004_1_00000000000000000000",
      "rt_sdk004_2_00000000000000000000",
    ]);
    expect(api.state.reused).toBe(0);
    expect(fake.requests.at(-1)?.headers["authorization"]).toBe("Bearer at_sdk004_3");
  });

  it("rejects the waiting calls of every client with the refused refresh's error and calls onSessionExpired once, the starting client's [SDK-017 AC1]", async () => {
    const answers = [
      errorResponse(401, "TOKEN_EXPIRED"),
      { ...errorResponse(401, "TOKEN_EXPIRED"), delayMs: 10 },
      { ...errorResponse(401, "REFRESH_TOKEN_INVALID"), delayMs: 50 },
    ];
    const fake = createFakeFetch(answers);
    const firstExpired = vi.fn();
    const secondExpired = vi.fn();
    const first = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: RT,
      onSessionExpired: firstExpired,
    });
    const second = first.withOptions({ ...SECOND, onSessionExpired: secondExpired });
    vi.useFakeTimers();

    const errors = Promise.all([
      first.account.get().catch((caught) => caught),
      second.bookings.list().catch((caught) => caught),
    ]);
    await vi.advanceTimersByTimeAsync(60);
    const [firstError, secondError] = await errors;

    expect(firstError).toBeInstanceOf(AuthenticationError);
    expect(firstError.code).toBe("REFRESH_TOKEN_INVALID");
    expect(secondError).toBe(firstError);
    expect(firstExpired).toHaveBeenCalledTimes(1);
    expect(secondExpired).not.toHaveBeenCalled();
    expect(fake.requests.map((request) => request.path)).toEqual([
      "/v1/account",
      "/v1/bookings",
      "/v1/auth/refresh",
    ]);
  });

  it("never presents a refresh token that a client's auth.refresh or auth.changePassword rotated, and keeps a sign-in to the client that made it [SDK-017 AC1]", async () => {
    const api = familyApi();
    /** @type {import("../helpers/fake-fetch.js").Answer} */
    const changePassword = () => {
      // The API rotates the session of the call (`rotateCurrent`): the old refresh token is now a reused one.
      api.state.refreshes += 1;
      const body = refreshed(api.state.refreshes);
      api.state.accessToken = body.session.accessToken;
      api.state.refreshToken = body.session.refreshToken;
      return { body };
    };
    /** @type {import("../helpers/fake-fetch.js").Answer} */
    const signIn = () => ({ body: { ...refreshed(99), customer: { id: "cus_2" } } });
    const fake = createFakeFetch([
      ...api.answers(1),
      ...api.answers(1),
      changePassword,
      ...api.answers(1),
      signIn,
      ...api.answers(1),
    ]);
    const first = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: AT,
      refreshToken: RT,
    });
    const second = first.withOptions(SECOND);
    const third = first.withOptions({ locale: "es-ES" });

    // The first client refreshes by hand: the second one's next call sends the new access token.
    await first.auth.refresh({ refreshToken: RT });
    await expect(second.account.get()).resolves.toEqual({ path: "/v1/account", client: "second" });
    // The second client changes the password: the API rotates its session, and the first one follows.
    await second.auth.changePassword({ currentPassword: "Old-password-1", newPassword: "New-password-22" });
    await expect(first.account.get()).resolves.toEqual({ path: "/v1/account", client: "first" });
    // The third client signs another customer in: that session is the third client's only.
    await third.auth.signIn({ email: "other@example.com", password: "Other-password-3" });
    await expect(first.account.get()).resolves.toEqual({ path: "/v1/account", client: "first" });

    expect(fake.requests.map((request) => [request.path, request.headers["authorization"]])).toEqual([
      ["/v1/auth/refresh", `Bearer ${AT}`],
      ["/v1/account", "Bearer at_sdk004_1"],
      ["/v1/auth/password/change", "Bearer at_sdk004_1"],
      ["/v1/account", "Bearer at_sdk004_2"],
      ["/v1/auth/sign-in", "Bearer at_sdk004_2"],
      ["/v1/account", "Bearer at_sdk004_2"],
    ]);
    expect(api.state.reused).toBe(0);
  });
});

describe("token mode: clients with different refresh tokens share nothing", () => {
  /**
   * A fake API with one session per customer (`a`, `b`): `POST /v1/auth/refresh` rotates the session of the presented
   * token (a token presented again: `REFRESH_TOKEN_REUSED`), and a call answers 200 with its customer when it carries
   * that customer's current access token, else `401 TOKEN_EXPIRED`.
   */
  function customersApi() {
    /** @type {Map<string, { accessToken: string | null, refreshToken: string, generation: number }>} */
    const sessions = new Map([
      ["a", { accessToken: null, refreshToken: "rt_sdk017_a_0", generation: 0 }],
      ["b", { accessToken: null, refreshToken: "rt_sdk017_b_0", generation: 0 }],
    ]);
    /** @type {string[]} */
    const presented = [];
    /** @type {import("../helpers/fake-fetch.js").Answer} */
    const answer = (request) => {
      if (request.path === "/v1/auth/refresh") {
        const token = /** @type {{ refreshToken: string }} */ (request.json).refreshToken;
        presented.push(token);
        const [customer, session] = [...sessions].find(([, each]) => each.refreshToken === token) ?? [];
        if (customer === undefined || session === undefined) {
          return errorResponse(401, "REFRESH_TOKEN_REUSED");
        }
        session.generation += 1;
        session.accessToken = `at_sdk017_${customer}_${session.generation}`;
        session.refreshToken = `rt_sdk017_${customer}_${session.generation}`;
        return {
          body: {
            session: { accessToken: session.accessToken, refreshToken: session.refreshToken },
            customer: { id: `cus_${customer}` },
          },
        };
      }
      const customer = [...sessions].find(
        ([, each]) => request.headers["authorization"] === `Bearer ${each.accessToken}`,
      )?.[0];
      return customer === undefined ? errorResponse(401, "TOKEN_EXPIRED") : { body: { customer } };
    };
    return {
      presented,
      answers: (/** @type {number} */ count) => Array.from({ length: count }, () => answer),
    };
  }

  it("refreshes two visitors' clients derived from one client separately, one after the other, and each keeps its own tokens [SDK-017 AC1]", async () => {
    const api = customersApi();
    const fake = createFakeFetch(api.answers(8));
    const anonymous = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });
    const refreshedA = vi.fn();
    const refreshedB = vi.fn();
    const visitorA = anonymous.withOptions({
      accessToken: "at_sdk017_a_0",
      refreshToken: "rt_sdk017_a_0",
      onSessionRefreshed: refreshedA,
    });
    const visitorB = anonymous.withOptions({
      accessToken: "at_sdk017_b_0",
      refreshToken: "rt_sdk017_b_0",
      onSessionRefreshed: refreshedB,
    });

    await expect(visitorA.account.get()).resolves.toEqual({ customer: "a" });
    await expect(visitorB.account.get()).resolves.toEqual({ customer: "b" });
    await expect(visitorA.account.get()).resolves.toEqual({ customer: "a" });
    await expect(visitorB.account.get()).resolves.toEqual({ customer: "b" });

    expect(api.presented).toEqual(["rt_sdk017_a_0", "rt_sdk017_b_0"]);
    expect(refreshedA).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ refreshToken: "rt_sdk017_a_1" }),
    );
    expect(refreshedB).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ refreshToken: "rt_sdk017_b_1" }),
    );
    expect(fake.requests.map((request) => request.headers["authorization"])).toEqual([
      "Bearer at_sdk017_a_0",
      undefined,
      "Bearer at_sdk017_a_1",
      "Bearer at_sdk017_b_0",
      undefined,
      "Bearer at_sdk017_b_1",
      "Bearer at_sdk017_a_1",
      "Bearer at_sdk017_b_1",
    ]);
  });

  it("refreshes each visitor's own token when one client's token functions give two visitors' tokens at once, and never sends one visitor's token for another [SDK-017 AC1]", async () => {
    // A server that keeps the visitor of each request in AsyncLocalStorage and gives one client functions that read
    // it: two requests whose tokens expired together refresh two tokens, and each call gets its own visitor's.
    /** @type {AsyncLocalStorage<{ accessToken: string, refreshToken: string }>} */
    const visitor = new AsyncLocalStorage();
    const api = customersApi();
    const fake = createFakeFetch(api.answers(10));
    const client = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: () => visitor.getStore()?.accessToken,
      refreshToken: () => visitor.getStore()?.refreshToken,
    });

    const results = await Promise.all([
      visitor.run({ accessToken: "at_sdk017_a_0", refreshToken: "rt_sdk017_a_0" }, () =>
        client.account.get(),
      ),
      visitor.run({ accessToken: "at_sdk017_b_0", refreshToken: "rt_sdk017_b_0" }, () =>
        client.account.get(),
      ),
    ]);
    // A visitor whose storage still gives the old tokens gets its own new ones, never the other visitor's.
    const again = await Promise.all([
      visitor.run({ accessToken: "at_sdk017_a_0", refreshToken: "rt_sdk017_a_0" }, () =>
        client.account.get(),
      ),
      visitor.run({ accessToken: "at_sdk017_b_0", refreshToken: "rt_sdk017_b_0" }, () =>
        client.account.get(),
      ),
    ]);

    expect(results).toEqual([{ customer: "a" }, { customer: "b" }]);
    expect(again).toEqual([{ customer: "a" }, { customer: "b" }]);
    expect(api.presented.sort()).toEqual(["rt_sdk017_a_0", "rt_sdk017_b_0"]);
    expect(fake.requests.slice(-2).map((request) => request.headers["authorization"])).toEqual([
      "Bearer at_sdk017_a_1",
      "Bearer at_sdk017_b_1",
    ]);
  });

  it("refreshes the second visitor's token too when one client's token functions give two visitors' tokens and the second's refusal arrives after the first's refresh [SDK-017 AC1]", async () => {
    // The first visitor's refresh must not make the second visitor's call skip its own: the call decides from the
    // tokens its own sources give, not from what the client did for another visitor in the meantime.
    /** @type {AsyncLocalStorage<{ accessToken: string, refreshToken: string }>} */
    const visitor = new AsyncLocalStorage();
    const [answer] = customersApi().answers(1);
    let delayed = false;
    /** @type {import("../helpers/fake-fetch.js").Answer} */
    const late = async (request) => {
      const response = /** @type {import("../helpers/fake-fetch.js").CannedResponse} */ (
        await /** @type {NonNullable<typeof answer>} */ (answer)(request)
      );
      if (!delayed && request.headers["authorization"] === "Bearer at_sdk017_b_0") {
        // The second visitor's first refusal arrives after the first visitor's refresh has finished.
        delayed = true;
        return { ...response, delayMs: 100 };
      }
      return response;
    };
    const fake = createFakeFetch(Array.from({ length: 6 }, () => late));
    const client = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: () => visitor.getStore()?.accessToken,
      refreshToken: () => visitor.getStore()?.refreshToken,
    });
    vi.useFakeTimers();

    const results = Promise.all([
      visitor.run({ accessToken: "at_sdk017_a_0", refreshToken: "rt_sdk017_a_0" }, () =>
        client.account.get(),
      ),
      visitor.run({ accessToken: "at_sdk017_b_0", refreshToken: "rt_sdk017_b_0" }, () =>
        client.account.get(),
      ),
    ]);
    await vi.advanceTimersByTimeAsync(100);

    expect(await results).toEqual([{ customer: "a" }, { customer: "b" }]);
    expect(fake.requests.map((request) => request.headers["authorization"] ?? request.json)).toEqual([
      "Bearer at_sdk017_a_0",
      "Bearer at_sdk017_b_0",
      { refreshToken: "rt_sdk017_a_0" },
      "Bearer at_sdk017_a_1",
      { refreshToken: "rt_sdk017_b_0" },
      "Bearer at_sdk017_b_1",
    ]);
  });

  it("never gives a client that holds only an old access token of a session the newer tokens the family rotated it into [SDK-017 AC1]", async () => {
    // A server's per-visitor clients share one family: someone who presents a visitor's old, expired access token
    // (alone, or with a refresh token of another session) must not be served with that visitor's new tokens.
    const api = customersApi();
    const fake = createFakeFetch(api.answers(8));
    const anonymous = createVelexisClient({ publishableKey: PK, fetch: fake.fetch });
    const visitorA = anonymous.withOptions({ accessToken: "at_sdk017_a_0", refreshToken: "rt_sdk017_a_0" });
    await expect(visitorA.account.get()).resolves.toEqual({ customer: "a" });
    const sentBefore = fake.requests.length;

    const accessOnly = anonymous.withOptions({ accessToken: "at_sdk017_a_0" });
    const withOtherRefreshToken = anonymous.withOptions({
      accessToken: "at_sdk017_a_0",
      refreshToken: "rt_sdk017_unknown",
    });
    const errors = [
      await accessOnly.account.get().catch((caught) => caught),
      await withOtherRefreshToken.account.get().catch((caught) => caught),
    ];

    expect(errors.map((error) => error.code)).toEqual(["TOKEN_EXPIRED", "REFRESH_TOKEN_REUSED"]);
    expect(
      fake.requests.slice(sentBefore).map((request) => request.headers["authorization"] ?? request.json),
    ).toEqual(["Bearer at_sdk017_a_0", "Bearer at_sdk017_a_0", { refreshToken: "rt_sdk017_unknown" }]);
    expect(api.presented).toEqual(["rt_sdk017_a_0", "rt_sdk017_unknown"]);
    // The visitor's own client keeps its session.
    await expect(visitorA.account.get()).resolves.toEqual({ customer: "a" });
  });
});

describe("token mode: token functions that read a store the starting client's hook writes", () => {
  it("sends a call of another client of the family again with the stored new tokens, without a second refresh, when its refusal arrives after the refresh [SDK-017 AC1]", async () => {
    // A browser-only app (the build-your-own-frontend guide §8.4): one memory store, written by onSessionRefreshed,
    // read by the token functions of the client and of the clients derived from it.
    const api = familyApi();
    api.delaySecondRefusal();
    const fake = createFakeFetch(api.answers(5));
    const store = { accessToken: AT, refreshToken: RT };
    const first = createVelexisClient({
      publishableKey: PK,
      fetch: fake.fetch,
      accessToken: () => store.accessToken,
      refreshToken: () => store.refreshToken,
      onSessionRefreshed: (session) => {
        store.accessToken = session.accessToken;
        store.refreshToken = session.refreshToken;
      },
    });
    const second = first.withOptions(SECOND);
    vi.useFakeTimers();

    const both = Promise.all([first.account.get(), second.account.get()]);
    await vi.advanceTimersByTimeAsync(100);

    expect(await both).toEqual([
      { path: "/v1/account", client: "first" },
      { path: "/v1/account", client: "second" },
    ]);
    expect(api.state.presented).toEqual([RT]);
    expect(fake.requests.map((request) => request.headers["authorization"] ?? request.json)).toEqual([
      `Bearer ${AT}`,
      `Bearer ${AT}`,
      { refreshToken: RT },
      "Bearer at_sdk004_1",
      "Bearer at_sdk004_1",
    ]);
  });
});
