import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";
import { NextRequest, type NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  APP_ENV: "production" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
}));

vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import * as routeModule from "./route";
import { POST } from "./route";

// Dummy session values, never real tokens.
const ACCESS_TOKEN = "header.payload-of-the-session.signature";
const REFRESH_TOKEN = "Rf5nW8qL2xK7vT4cB9mZ1pH6yD3sJ0aG8eU5iO2rQ4w";
const SESSION = { "__Host-vxp_at": ACCESS_TOKEN, "__Host-vxp_rt": REFRESH_TOKEN };

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

/** A form post to `/sign-out`, as the "Sign out" buttons send it. */
function signOutRequest(
  init: { origin?: string | null; cookies?: Record<string, string>; method?: string } = {},
): NextRequest {
  const headers = new Headers({
    "x-forwarded-for": "198.51.100.7",
    "user-agent": "Mozilla/5.0 (PFE-006 test)",
    "content-type": "application/x-www-form-urlencoded",
  });
  const origin = init.origin === undefined ? "https://platform.example.com" : init.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  const cookies = Object.entries(init.cookies ?? {}).map(([name, value]) => `${name}=${value}`);
  if (cookies.length > 0) {
    headers.set("cookie", cookies.join("; "));
  }
  return new NextRequest(new URL("/sign-out", "http://127.0.0.1:3000"), {
    method: init.method ?? "POST",
    headers,
  });
}

/** The cookie writes of `response` as `name=value; Max-Age=…`, without the `Expires` Next.js may add. */
function cookieWrites(response: NextResponse): string[] {
  return response.headers.getSetCookie().map((line) =>
    line
      .split("; ")
      .filter((attribute) => attribute.startsWith("__Host-") || attribute.startsWith("Max-Age="))
      .join("; "),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("POST /sign-out", () => {
  it.each([
    ["a foreign origin", "https://evil.example"],
    ["a look-alike host", "https://platform.example.com.evil.example"],
    ["the portal host over http", "http://platform.example.com"],
    ["an opaque origin", "null"],
    ["no Origin header", null],
  ])(
    "[PFE-006 AC4] answers 403 to %s without calling the API or touching the cookies",
    async (_case, origin) => {
      const response = await POST(signOutRequest({ origin, cookies: SESSION }));

      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("[PFE-006 AC4] revokes the session and deletes its cookies for the portal's own origin", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await POST(
      signOutRequest({ cookies: { ...SESSION, "__Host-vxp_mfa": "an-abandoned-challenge" } }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://platform.example.com/sign-in?signedOut=1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cookieWrites(response)).toEqual([
      "__Host-vxp_at=; Max-Age=0",
      "__Host-vxp_rt=; Max-Age=0",
      "__Host-vxp_mfa=; Max-Age=0",
    ]);
    for (const line of response.headers.getSetCookie()) {
      expect(line).toContain("Path=/");
      expect(line).toContain("Secure");
      expect(line).toContain("HttpOnly");
    }
    // signOut: the bearer token of the session and its refresh token, with the end-user headers (PADR-0019).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]?.[0] as Request;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("http://127.0.0.1:3100/v1/auth/sign-out");
    expect(call.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(await call.json()).toEqual({ refreshToken: REFRESH_TOKEN });
    expect(call.headers.get("x-velexis-end-user-ip")).toBe("198.51.100.7");
    expect(call.headers.get("x-velexis-bff-key")).toBe(settings.PLATFORM_BFF_KEY);
  });

  it("deletes the cookies even when the API cannot revoke the session", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:3100"));

    const response = await POST(signOutRequest({ cookies: SESSION }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://platform.example.com/sign-in?signedOut=1");
    expect(cookieWrites(response)).toEqual(["__Host-vxp_at=; Max-Age=0", "__Host-vxp_rt=; Max-Age=0"]);
  });

  it("without a usable session only deletes the cookies: signOut needs the bearer token", async () => {
    const withoutAccess = await POST(signOutRequest({ cookies: { "__Host-vxp_rt": REFRESH_TOKEN } }));
    const withoutAny = await POST(signOutRequest());

    for (const response of [withoutAccess, withoutAny]) {
      expect(response.status).toBe(303);
      expect(cookieWrites(response)).toEqual(["__Host-vxp_at=; Max-Age=0", "__Host-vxp_rt=; Max-Age=0"]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only answers POST: a link or an image cannot sign anyone out", async () => {
    // The handlers as Next.js dispatches them: methods a route module does not export answer 405.
    const methods = autoImplementMethods(routeModule);

    const response = (await methods.GET(signOutRequest({ method: "GET", cookies: SESSION }), {})) as Response;

    expect(response.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
