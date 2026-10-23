import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  apiError,
  fakeOtaApi,
  fakeRedirect,
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
} from "@/test/fake-ota-api";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", () => ({ redirect: vi.fn(fakeRedirect) }));

import { INITIAL_ACTION_STATE } from "@/lib/action-state";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import { resetEnvironment, switchEnvironment } from "./env-actions";

const LIVE_REFUSED = "Live is not available for this OTA or role.";

let api: FakeOtaApi;
let jar: CookieJar;
let sequence = 0;

/** The cookies of a signed-in staff member whose switch says `environment`. */
function signedIn(environment: "test" | "live"): void {
  sequence += 1;
  jar = new CookieJar({
    [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`env-${sequence}`, Date.now(), 900),
    [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-env-actions-${sequence}-${Date.now()}`,
    [ENVIRONMENT_COOKIE]: environment,
    [TENANT_COOKIE]: TENANT_ID,
  });
  nextHeaders.cookies.mockResolvedValue(jar);
}

/** The form the switch posts. */
function form(environment: string): FormData {
  const data = new FormData();
  data.set("environment", environment);
  return data;
}

/** The values the action wrote to `__Host-vx_env`, in order. */
function environmentWrites(): string[] {
  return jar.writes.filter((write) => write.name === ENVIRONMENT_COOKIE).map((write) => write.value);
}

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("switchEnvironment", () => {
  it("[OAD-004 AC1] refuses env=live for a viewer and keeps the cookie at test", async () => {
    signedIn("test");
    api.on("GET /v1/console/auth/me", () =>
      Response.json(staffProfile({ role: "viewer", environments: ["test"] })),
    );

    const state = await switchEnvironment(INITIAL_ACTION_STATE, form("live"));

    expect(state).toEqual({ ok: false, message: LIVE_REFUSED, code: "ENVIRONMENT_NOT_ALLOWED" });
    expect(environmentWrites()).not.toContain("live");
    expect(jar.get(ENVIRONMENT_COOKIE)?.value).toBe("test");
    expect(api.sent("GET /v1/console/auth/me")).toHaveLength(1);
  });

  it("[OAD-004 AC1] refuses a viewer even when a profile lists live, and an OTA that is not live", async () => {
    signedIn("test");
    // The role decides too (scope §1.3: viewers never open live), whatever the list says.
    api.on("GET /v1/console/auth/me", () =>
      Response.json(staffProfile({ role: "viewer", environments: ["test", "live"] })),
    );
    expect(await switchEnvironment(INITIAL_ACTION_STATE, form("live"))).toMatchObject({
      ok: false,
      code: "ENVIRONMENT_NOT_ALLOWED",
    });
    expect(environmentWrites()).not.toContain("live");

    signedIn("test");
    api.on("GET /v1/console/auth/me", () =>
      Response.json(staffProfile({ role: "owner", environments: ["test"] })),
    );
    expect(await switchEnvironment(INITIAL_ACTION_STATE, form("live"))).toMatchObject({
      ok: false,
      message: LIVE_REFUSED,
    });
    expect(environmentWrites()).not.toContain("live");
  });

  it("switches an agent of a live OTA to live and opens the dashboard", async () => {
    signedIn("test");

    expect(await redirectOf(() => switchEnvironment(INITIAL_ACTION_STATE, form("live")))).toBe("/");

    expect(environmentWrites()).toEqual(["live"]);
    const [write] = jar.writes;
    expect(write?.options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 43_200,
    });
    // console.auth.me was asked in the environment of the cookie, with the staff token.
    expect(api.sent("GET /v1/console/auth/me")[0]?.headers.get("X-Velexis-Environment")).toBe("test");
  });

  it("switches to test without a call: test is always allowed", async () => {
    signedIn("live");

    expect(await redirectOf(() => switchEnvironment(INITIAL_ACTION_STATE, form("test")))).toBe("/");

    expect(environmentWrites()).toEqual(["test"]);
    expect(api.requests).toEqual([]);
  });

  it("resets a live cookie that the API refuses to test, and answers the refusal", async () => {
    signedIn("live");
    api.on("GET /v1/console/auth/me", () => apiError("ENVIRONMENT_NOT_ALLOWED", 403));

    const state = await switchEnvironment(INITIAL_ACTION_STATE, form("live"));

    expect(state).toMatchObject({ ok: false, code: "ENVIRONMENT_NOT_ALLOWED", message: LIVE_REFUSED });
    expect(environmentWrites()).toEqual(["test"]);
  });

  it("refuses anything but test or live without a call or a cookie", async () => {
    signedIn("test");

    for (const value of ["LIVE", "production", ""]) {
      expect(await switchEnvironment(INITIAL_ACTION_STATE, form(value)), value).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
        fieldErrors: { environment: "Choose TEST or LIVE." },
      });
    }
    expect(await switchEnvironment(INITIAL_ACTION_STATE, new FormData())).toMatchObject({ ok: false });
    expect(jar.writes).toEqual([]);
    expect(api.requests).toEqual([]);
  });

  it("answers other API errors as action state with the request id", async () => {
    signedIn("test");
    // `Retry-After: 60` ends the SDK's call at once instead of waiting for a retry.
    api.on("GET /v1/console/auth/me", () =>
      apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }),
    );

    expect(await switchEnvironment(INITIAL_ACTION_STATE, form("live"))).toMatchObject({
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      requestId: "req_fake_1",
    });
    expect(environmentWrites()).toEqual([]);
  });
});

describe("resetEnvironment", () => {
  it("sets the environment cookie to test", async () => {
    signedIn("live");

    await resetEnvironment();

    expect(jar.writes.map((write) => [write.name, write.value])).toEqual([[ENVIRONMENT_COOKIE, "test"]]);
    expect(api.requests).toEqual([]);
  });
});
