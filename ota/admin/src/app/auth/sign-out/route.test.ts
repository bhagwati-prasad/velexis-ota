import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TENANT_ID,
  TEST_CONFIG,
  TEST_SERVICE_KEY,
  apiError,
  fakeOtaApi,
  staffAccessToken,
  type FakeOtaApi,
} from "@/test/fake-ota-api";

vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));

import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import { POST } from "./route";

const SIGN_OUT_ROUTE = "POST /v1/console/auth/sign-out";
const ADMIN = "http://localhost:3002";

/** The shell's sign-out button: a form post from `origin` with `cookies`. */
function signOut(cookies: Record<string, string>, origin: string | null = ADMIN): NextRequest {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  if (origin !== null) {
    headers.set("Origin", origin);
  }
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  if (cookie !== "") {
    headers.set("Cookie", cookie);
  }
  return new NextRequest(`${ADMIN}/auth/sign-out`, { method: "POST", headers, body: "" });
}

function signedIn(accessTokenSeconds: number): Record<string, string> {
  return {
    [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken("sign-out", Date.now(), accessTokenSeconds),
    [STAFF_REFRESH_TOKEN_COOKIE]: "staff-refresh-token-of-the-session",
    [ENVIRONMENT_COOKIE]: "live",
    [TENANT_COOKIE]: TENANT_ID,
  };
}

/** The `Set-Cookie` lines as `[name, value, Max-Age]`. */
function setCookies(response: Response): [string, string, string | undefined][] {
  return response.headers.getSetCookie().map((line) => {
    const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
    const at = pair.indexOf("=");
    const maxAge = attributes.find((attribute) => attribute.toLowerCase().startsWith("max-age="));
    return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1)), maxAge?.slice("max-age=".length)];
  });
}

const CLEARED = [
  [STAFF_ACCESS_TOKEN_COOKIE, "", "0"],
  [STAFF_REFRESH_TOKEN_COOKIE, "", "0"],
  [ENVIRONMENT_COOKIE, "", "0"],
];

let api: FakeOtaApi;

beforeEach(() => {
  api = fakeOtaApi();
  api.on(SIGN_OUT_ROUTE, () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", api.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /auth/sign-out", () => {
  it("refuses a request that did not come from the admin itself, without a call or a cookie change", async () => {
    for (const origin of ["https://evil.example", "http://localhost:3000", "null", null]) {
      const response = await POST(signOut(signedIn(900), origin));

      expect(response.status, String(origin)).toBe(403);
      expect(setCookies(response)).toEqual([]);
    }
    expect(api.requests).toEqual([]);
  });

  it("ends the session in the API, clears the cookies but the tenant's and shows /signed-out", async () => {
    const cookies = signedIn(900);

    const response = await POST(signOut(cookies));

    const [sent] = api.sent(SIGN_OUT_ROUTE);
    expect(sent?.body).toEqual({ scope: "current", refreshToken: "staff-refresh-token-of-the-session" });
    expect(sent?.headers.get("X-Api-Key")).toBe(TEST_SERVICE_KEY);
    expect(sent?.headers.get("Authorization")).toBe(`Bearer ${cookies[STAFF_ACCESS_TOKEN_COOKIE]}`);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${ADMIN}/signed-out`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(setCookies(response)).toEqual(CLEARED);
  });

  it("names the session by its refresh token alone once the access token has expired", async () => {
    await POST(signOut(signedIn(-5)));

    const [sent] = api.sent(SIGN_OUT_ROUTE);
    expect(sent?.headers.has("Authorization")).toBe(false);
    expect(sent?.body).toEqual({ scope: "current", refreshToken: "staff-refresh-token-of-the-session" });
  });

  it("clears the cookies whatever the API answers", async () => {
    api.on(SIGN_OUT_ROUTE, () => apiError("UNAUTHENTICATED", 401));

    const response = await POST(signOut(signedIn(900)));

    expect(response.headers.get("Location")).toBe(`${ADMIN}/signed-out`);
    expect(setCookies(response)).toEqual(CLEARED);
  });

  it("makes no call without a token and still lands on /signed-out", async () => {
    const response = await POST(signOut({ [TENANT_COOKIE]: TENANT_ID }));

    expect(api.requests).toEqual([]);
    expect(response.headers.get("Location")).toBe(`${ADMIN}/signed-out`);
    expect(setCookies(response)).toEqual(CLEARED);
  });
});
