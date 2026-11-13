// Server mode, the contract's secret-key session (ota/sdk/README.md §4.3, docs/velexis-sdk/sdk/src/console.d.ts
// `sessionKind` and `onStaffSessionRefreshed`, ota/docs/api-changes.md §5, OADR-0016 point 5, task SDK-004): the secret
// key is refused in a browser page; `environment` sends X-Velexis-Environment on console operations only;
// `sessionKind: "staff"` refreshes through console.auth.refresh and reports the whole staff session. The clients of a
// family (a client and those derived from it with withOptions) share the refresh of each refresh-token value, so two
// staff clients holding one refresh token send one refresh and never present a rotated one (task SDK-017).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { createVelexisClient } from "../../src/index.js";
import { createCore } from "../../src/internal/client.js";
import { op } from "../../src/internal/operations.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

/** Fake keys and tokens with the right shapes; none of them works anywhere. */
const SK = "sk_test_sdk004_fake_secret";
const STAFF_AT = "at_sdk004_staff_first";
const STAFF_RT = "rt_sdk004_staff_first_0000000000";

/** The working OpenAPI document the route table is generated from. */
const DOCUMENT = fileURLToPath(
  new URL("../../../backend/openapi/velexis-ota-booking-api.openapi.yaml", import.meta.url),
);

/** The `x-scope` of every SDK operation of the document, by route-table key (`x-sdk-method`, dots as `_`). */
const scopes = new Map();

beforeAll(() => {
  const document = parse(readFileSync(DOCUMENT, "utf8"));
  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values(item)) {
      const method = operation?.["x-sdk-method"];
      if (typeof method === "string") {
        scopes.set(method.replaceAll(".", "_"), operation["x-scope"]);
      }
    }
  }
  // Parsing the whole document takes about a second alone and much longer under CI's parallel turbo load.
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

/** The `ConsoleStaffSession` of a staff refresh. */
const staffSession = {
  session: {
    accessToken: "at_sdk004_staff_second",
    accessTokenExpiresAt: "2026-10-17T18:15:00Z",
    refreshToken: "rt_sdk004_staff_second_000000000",
    refreshTokenExpiresAt: "2026-10-18T06:00:00Z",
    tokenType: "Bearer",
    subject: { type: "staff", id: "stf_1", roles: ["agent"] },
  },
  staff: { id: "stf_1" },
  tenant: { id: "tnt_1" },
  permissions: ["bookings:read"],
  environments: ["test"],
};

/**
 * Sample params for an operation: every path param set, nothing else.
 * @param {import("../../src/internal/operations.js").Operation} operation
 */
const paramsOf = (operation) => Object.fromEntries(operation.pathParams.map((name) => [name, "x1"]));

describe("server mode: the secret key", () => {
  it("is refused with a TypeError where globalThis.document exists, before any request [SDK-004 AC1]", () => {
    const fake = createFakeFetch();
    vi.stubGlobal("document", { cookie: "" });

    for (const create of [
      () => createVelexisClient({ secretKey: SK, fetch: fake.fetch }),
      () => createCore({ secretKey: SK, fetch: fake.fetch, sessionKind: "staff" }),
    ]) {
      expect(create).toThrow(
        new TypeError(
          'Velexis SDK: option "secretKey" belongs on servers only and cannot be used in a browser page',
        ),
      );
    }
    const browser = createVelexisClient({ publishableKey: "pk_test_sdk004_fake", fetch: fake.fetch });
    expect(() => browser.withOptions({ publishableKey: undefined, secretKey: SK })).toThrow(
      /option "secretKey"/,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("is accepted where there is no document, and leaves fetch's credentials to the runtime [SDK-004 AC1]", async () => {
    const fake = createFakeFetch([{ body: {} }, { body: {} }]);
    const core = createCore({ secretKey: SK, fetch: fake.fetch, accessToken: STAFF_AT });
    const hosting = createCore({
      hostingKey: "hk_test_sdk004_fake",
      fetch: fake.fetch,
      host: "demo.example.com",
    });

    await core.call(op.console_auth_me);
    await hosting.call(op.storefront_get);

    expect([core.mode, hosting.mode]).toEqual(["server", "server"]);
    expect(fake.requests[0]?.headers).toMatchObject({ "x-api-key": SK, authorization: `Bearer ${STAFF_AT}` });
    expect(fake.requests[1]?.headers).toMatchObject({ "x-api-key": "hk_test_sdk004_fake" });
    for (const request of fake.requests) {
      expect(request.init.credentials).toBeUndefined();
      expect(request.init.mode).toBeUndefined();
    }
  });
});

describe("server mode: environment", () => {
  it("marks exactly the console-scope operations of the document as taking X-Velexis-Environment [SDK-004 AC3]", () => {
    const entries = Object.entries(op);

    expect(scopes.size).toBe(entries.length);
    expect(entries.filter(([key]) => scopes.get(key) === "console").length).toBeGreaterThan(30);
    for (const [key, operation] of entries) {
      expect({ key, environment: operation.environment }).toEqual({
        key,
        environment: scopes.get(key) === "console",
      });
    }
  });

  it("sends X-Velexis-Environment on every console operation and on no customer operation [SDK-004 AC3]", async () => {
    const entries = Object.entries(op);
    const fake = createFakeFetch(entries.map(() => ({ body: {} })));
    const core = createCore({ secretKey: SK, fetch: fake.fetch, accessToken: STAFF_AT, environment: "live" });

    for (const [, operation] of entries) {
      await core.call(operation, paramsOf(operation));
    }

    expect(fake.requests).toHaveLength(entries.length);
    entries.forEach(([name], index) => {
      const header = fake.requests[index]?.headers["x-velexis-environment"];
      expect({ name, header }).toEqual({ name, header: scopes.get(name) === "console" ? "live" : undefined });
    });
    const customerOps = entries.filter(([name]) => scopes.get(name) !== "console").length;
    expect(customerOps).toBeGreaterThan(60);
    expect(
      fake.requests.filter((request) => request.headers["x-velexis-environment"] === undefined),
    ).toHaveLength(customerOps);
  });

  it("sends it through the escape hatch on console paths only, and never without the option [SDK-004 AC3]", async () => {
    const fake = createFakeFetch(Array.from({ length: 5 }, () => ({ body: {} })));
    const client = createVelexisClient({ secretKey: SK, fetch: fake.fetch, environment: "test" });
    const without = createCore({ secretKey: SK, fetch: fake.fetch });

    await client.request("GET", "/v1/console/bookings?limit=5");
    await client.request("GET", "/v1/consoles");
    await client.request("GET", "/v1/bookings");
    await client.request("POST", "/v1/flight-searches", { body: {} });
    await without.call(op.console_bookings_list);

    expect(fake.requests.map((request) => request.headers["x-velexis-environment"])).toEqual([
      "test",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("server mode: staff sessions", () => {
  it("refreshes through console.auth.refresh with sessionKind staff and reports to both hooks [SDK-004 AC2]", async () => {
    const fake = createFakeFetch([
      errorResponse(401, "TOKEN_EXPIRED"),
      { body: staffSession },
      { body: { data: [], page: { nextCursor: null, limit: 20 } } },
    ]);
    const onSessionRefreshed = vi.fn();
    const onStaffSessionRefreshed = vi.fn(async () => {});
    const core = createCore({
      secretKey: SK,
      fetch: fake.fetch,
      accessToken: STAFF_AT,
      refreshToken: STAFF_RT,
      sessionKind: "staff",
      environment: "test",
      endUser: { ip: "198.51.100.20", userAgent: "Admin/1" },
      onSessionRefreshed,
      onStaffSessionRefreshed,
    });

    const page = await core.call(op.console_bookings_list);

    expect(page).toMatchObject({ data: [] });
    const [first, refresh, retry] = fake.requests;
    expect(first?.headers["authorization"]).toBe(`Bearer ${STAFF_AT}`);
    expect(refresh).toMatchObject({
      method: "POST",
      path: "/v1/console/auth/refresh",
      json: { refreshToken: STAFF_RT },
    });
    expect(refresh?.headers).toMatchObject({
      "x-api-key": SK,
      "x-velexis-environment": "test",
      "x-velexis-end-user-ip": "198.51.100.20",
    });
    expect(refresh?.headers["authorization"]).toBeUndefined();
    expect(retry?.headers["authorization"]).toBe("Bearer at_sdk004_staff_second");
    expect(onSessionRefreshed).toHaveBeenCalledWith(staffSession.session);
    expect(onStaffSessionRefreshed).toHaveBeenCalledWith(staffSession);
  });

  it("refreshes customer sessions through auth.refresh by default and never calls the staff hook [SDK-004 AC2]", async () => {
    const fake = createFakeFetch([
      errorResponse(401, "TOKEN_EXPIRED"),
      { body: { session: staffSession.session, customer: { id: "cus_1" } } },
      { body: { id: "cus_1" } },
    ]);
    const onStaffSessionRefreshed = vi.fn();
    const core = createCore({
      secretKey: SK,
      fetch: fake.fetch,
      accessToken: STAFF_AT,
      refreshToken: STAFF_RT,
      environment: "test",
      onStaffSessionRefreshed,
    });

    await core.call(op.account_get);

    expect(fake.requests[1]?.path).toBe("/v1/auth/refresh");
    expect(fake.requests[1]?.headers["x-velexis-environment"]).toBeUndefined();
    expect(onStaffSessionRefreshed).not.toHaveBeenCalled();
  });

  it("shares one staff refresh between five concurrent console calls [SDK-004 AC2]", async () => {
    let refreshes = 0;
    /** @type {import("../helpers/fake-fetch.js").Answer} */
    const api = (request) => {
      if (request.path === "/v1/console/auth/refresh") {
        refreshes += 1;
        return { body: staffSession };
      }
      return request.headers["authorization"] === "Bearer at_sdk004_staff_second"
        ? { body: { id: request.path } }
        : errorResponse(401, "TOKEN_EXPIRED");
    };
    const fake = createFakeFetch(Array.from({ length: 11 }, () => api));
    const onStaffSessionRefreshed = vi.fn();
    const core = createCore({
      secretKey: SK,
      fetch: fake.fetch,
      accessToken: STAFF_AT,
      refreshToken: STAFF_RT,
      sessionKind: "staff",
      onStaffSessionRefreshed,
    });

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => core.call(op.console_bookings_get, { bookingId: `bkg_${n}` })),
    );

    expect(results).toEqual([1, 2, 3, 4, 5].map((n) => ({ id: `/v1/console/bookings/bkg_${n}` })));
    expect(refreshes).toBe(1);
    expect(onStaffSessionRefreshed).toHaveBeenCalledTimes(1);
    expect(fake.requests).toHaveLength(11);
  });
});

/**
 * The n-th `ConsoleStaffSession` of a fake staff session whose refresh token rotates.
 * @param {number} n
 * @param {string} [member] the staff member, `stf_1` by default
 */
const staffRefreshed = (n, member = "stf_1") => ({
  ...staffSession,
  session: {
    ...staffSession.session,
    accessToken: `at_sdk017_${member}_${n}`,
    refreshToken: `rt_sdk017_${member}_${n}`,
    subject: { type: "staff", id: member, roles: ["agent"] },
  },
  staff: { id: member },
});

/**
 * A fake console API with one staff session per member (SDK-017), as strict as the backend's staff refresh: `POST
 * /v1/console/auth/refresh` rotates the session of the presented refresh token, and a token presented again answers
 * `401 REFRESH_TOKEN_REUSED` (counted); a console call answers 200 with its member and client (`X-Client`) when it
 * carries the member's current access token, else `401 TOKEN_EXPIRED`. `api.holdRefusals(n)` answers the next `n`
 * refusals together, once all of them have been sent; `api.delaySecondRefusal()` answers the next refusal of the
 * client `second` 100 ms late, after the first client's refresh has finished.
 * @param {string[]} [members]
 */
function staffApi(members = ["stf_1"]) {
  const sessions = new Map(
    members.map((member) => [
      member,
      { accessToken: /** @type {string | null} */ (null), refreshToken: `rt_sdk017_${member}_0`, n: 0 },
    ]),
  );
  /** @type {string[]} */
  const presented = [];
  const counts = { reused: 0, refreshes: 0 };
  let held = 0;
  let release = () => {};
  /** @type {Promise<void>} */
  let allSent = Promise.resolve();
  let delaySecond = false;
  /** @type {import("../helpers/fake-fetch.js").Answer} */
  const answer = async (request) => {
    if (request.path === "/v1/console/auth/refresh") {
      const token = /** @type {{ refreshToken: string }} */ (request.json).refreshToken;
      presented.push(token);
      const [member, session] = [...sessions].find(([, each]) => each.refreshToken === token) ?? [];
      if (member === undefined || session === undefined) {
        counts.reused += 1;
        return errorResponse(401, "REFRESH_TOKEN_REUSED");
      }
      counts.refreshes += 1;
      session.n += 1;
      const body = staffRefreshed(session.n, member);
      session.accessToken = body.session.accessToken;
      session.refreshToken = body.session.refreshToken;
      return { body };
    }
    const client = request.headers["x-client"] ?? "first";
    const member = [...sessions].find(
      ([, each]) => request.headers["authorization"] === `Bearer ${each.accessToken}`,
    )?.[0];
    if (member !== undefined) {
      return { body: { member, client } };
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
    presented,
    counts,
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
    /** @param {string} member */
    expireAccessToken(member) {
      const session = sessions.get(member);
      if (session !== undefined) {
        session.accessToken = "at_expired_on_the_server";
      }
    },
  };
}

describe("server mode: the staff clients of a family share the refresh of a refresh token", () => {
  /** The options of a service client of the OTA admin's kind, without a staff session. */
  const serviceOptions = (/** @type {typeof fetch} */ fetch) => ({
    secretKey: SK,
    fetch,
    sessionKind: /** @type {const} */ ("staff"),
    environment: /** @type {const} */ ("test"),
  });
  /** The first tokens of the staff member `stf_1`. */
  const STAFF_TOKENS = { accessToken: "at_sdk017_stf_1_0", refreshToken: "rt_sdk017_stf_1_0" };

  /**
   * The two clients holding one staff refresh token, by how they came to hold it.
   * @type {Record<string, (setup: { fetch: typeof fetch, api: ReturnType<typeof staffApi>, hooks: { onSessionRefreshed: () => void, onStaffSessionRefreshed: () => void } }) => Promise<[import("../../src/index.js").VelexisClient, import("../../src/index.js").VelexisClient]>>}
   */
  const pairs = {
    "a client and a client derived from it before a refresh": async ({ fetch, hooks }) => {
      const first = createVelexisClient({ ...serviceOptions(fetch), ...STAFF_TOKENS, ...hooks });
      return [first, first.withOptions({ headers: { "X-Client": "second" } })];
    },
    "a client and a client derived from it after a refresh": async ({ fetch, api, hooks }) => {
      const first = createVelexisClient({ ...serviceOptions(fetch), ...STAFF_TOKENS, ...hooks });
      await first.console.auth.me();
      const second = first.withOptions({ headers: { "X-Client": "second" } });
      api.expireAccessToken("stf_1");
      return [first, second];
    },
    "two clients derived with the same refreshToken string": async ({ fetch, hooks }) => {
      const serviceClient = createVelexisClient(serviceOptions(fetch));
      return [
        serviceClient.withOptions({ ...STAFF_TOKENS, ...hooks }),
        serviceClient.withOptions({ ...STAFF_TOKENS, ...hooks, headers: { "X-Client": "second" } }),
      ];
    },
  };

  /**
   * How the console calls of the two clients meet the expired access token.
   * @type {Record<string, (pair: { first: import("../../src/index.js").VelexisClient, second: import("../../src/index.js").VelexisClient, api: ReturnType<typeof staffApi> }) => Promise<unknown[]>>}
   */
  const timings = {
    "answered 401 TOKEN_EXPIRED at once": ({ first, second, api }) => {
      api.holdRefusals(2);
      return Promise.all([first.console.auth.me(), second.console.auth.me()]);
    },
    "one after the other": async ({ first, second }) => [
      await first.console.auth.me(),
      await second.console.auth.me(),
    ],
    "the second client first, then the first": async ({ first, second }) => {
      const fromSecond = await second.console.auth.me();
      return [await first.console.auth.me(), fromSecond];
    },
    "the second client's refusal arriving after the first client's refresh": async ({
      first,
      second,
      api,
    }) => {
      api.delaySecondRefusal();
      vi.useFakeTimers();
      const both = Promise.all([first.console.auth.me(), second.console.auth.me()]);
      await vi.advanceTimersByTimeAsync(100);
      return both;
    },
  };

  for (const [pairName, makePair] of Object.entries(pairs)) {
    for (const [timingName, run] of Object.entries(timings)) {
      it(`${pairName}, ${timingName}: send one console refresh for the token and never REFRESH_TOKEN_REUSED [SDK-017 AC1]`, async () => {
        const api = staffApi();
        const fake = createFakeFetch(api.answers(16));
        const hooks = { onSessionRefreshed: vi.fn(), onStaffSessionRefreshed: vi.fn() };
        const [first, second] = await makePair({ fetch: fake.fetch, api, hooks });
        const before = {
          refreshes: api.counts.refreshes,
          reported: hooks.onStaffSessionRefreshed.mock.calls.length,
        };

        const results = await run({ first, second, api });

        expect(results).toEqual([
          { member: "stf_1", client: "first" },
          { member: "stf_1", client: "second" },
        ]);
        expect(api.counts.reused).toBe(0);
        expect(api.counts.refreshes).toBe(before.refreshes + 1);
        expect(new Set(api.presented).size).toBe(api.presented.length);
        const newest = staffRefreshed(api.counts.refreshes);
        expect(hooks.onStaffSessionRefreshed).toHaveBeenCalledTimes(before.reported + 1);
        expect(hooks.onStaffSessionRefreshed).toHaveBeenLastCalledWith(newest);
        expect(hooks.onSessionRefreshed).toHaveBeenLastCalledWith(newest.session);
        for (const request of fake.requests.filter((each) => each.path === "/v1/console/auth/refresh")) {
          expect(request.headers).toMatchObject({ "x-api-key": SK, "x-velexis-environment": "test" });
          expect(request.headers["authorization"]).toBeUndefined();
        }
      });
    }
  }

  it("refreshes two staff members' clients derived from one service client separately, and each keeps its own session [SDK-017 AC1]", async () => {
    const api = staffApi(["stf_1", "stf_2"]);
    const fake = createFakeFetch(api.answers(10));
    const serviceClient = createVelexisClient(serviceOptions(fake.fetch));
    const reported = { stf_1: vi.fn(), stf_2: vi.fn() };
    const memberClient = (/** @type {"stf_1" | "stf_2"} */ member) =>
      serviceClient.withOptions({
        accessToken: `at_sdk017_${member}_0`,
        refreshToken: `rt_sdk017_${member}_0`,
        onStaffSessionRefreshed: reported[member],
        headers: { "X-Client": member },
      });
    const [one, two] = [memberClient("stf_1"), memberClient("stf_2")];

    const atOnce = await Promise.all([one.console.auth.me(), two.console.auth.me()]);
    api.expireAccessToken("stf_2");
    const afterwards = [await one.console.auth.me(), await two.console.auth.me()];

    expect(atOnce).toEqual([
      { member: "stf_1", client: "stf_1" },
      { member: "stf_2", client: "stf_2" },
    ]);
    expect(afterwards).toEqual(atOnce);
    expect(api.presented.sort()).toEqual(["rt_sdk017_stf_1_0", "rt_sdk017_stf_2_0", "rt_sdk017_stf_2_1"]);
    expect(api.counts.reused).toBe(0);
    expect(reported.stf_1).toHaveBeenCalledExactlyOnceWith(staffRefreshed(1, "stf_1"));
    expect(reported.stf_2.mock.calls).toEqual([[staffRefreshed(1, "stf_2")], [staffRefreshed(2, "stf_2")]]);
  });

  it("never gives a staff client that holds only an old access token of a staff session the newer tokens the family rotated it into [SDK-017 AC1]", async () => {
    // One service client per process, a client per staff request derived from it: an old, expired staff access token
    // presented again (alone) must not become the staff member's new one.
    const api = staffApi();
    const fake = createFakeFetch(api.answers(6));
    const serviceClient = createVelexisClient(serviceOptions(fake.fetch));
    const member = serviceClient.withOptions(STAFF_TOKENS);
    await expect(member.console.auth.me()).resolves.toEqual({ member: "stf_1", client: "first" });
    const sentBefore = fake.requests.length;

    const stale = serviceClient.withOptions({ accessToken: STAFF_TOKENS.accessToken });
    const error = await stale.console.auth.me().catch((caught) => caught);

    expect(error).toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(fake.requests.slice(sentBefore).map((request) => request.headers["authorization"])).toEqual([
      `Bearer ${STAFF_TOKENS.accessToken}`,
    ]);
    expect(api.presented).toEqual([STAFF_TOKENS.refreshToken]);
    await expect(member.console.auth.me()).resolves.toEqual({ member: "stf_1", client: "first" });
  });
});
