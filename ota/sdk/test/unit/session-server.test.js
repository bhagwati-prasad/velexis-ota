// Server mode, the contract's secret-key session (ota/sdk/README.md §4.3, docs/velexis-sdk/sdk/src/console.d.ts
// `sessionKind` and `onStaffSessionRefreshed`, ota/docs/api-changes.md §5, OADR-0016 point 5, task SDK-004): the secret
// key is refused in a browser page; `environment` sends X-Velexis-Environment on console operations only;
// `sessionKind: "staff"` refreshes through console.auth.refresh and reports the whole staff session.
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
