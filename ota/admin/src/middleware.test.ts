import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest, type NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TENANT_ID,
  TEST_CONFIG,
  TEST_PORTAL_URL,
  TEST_SERVICE_KEY,
  apiError,
  deferred,
  fakeOtaApi,
  rateLimited,
  staffAccessToken,
  staffSession,
  type FakeOtaApi,
} from "@/test/fake-ota-api";

const settings = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/config", () => ({ getConfig: () => settings.current }));

import { SECURITY_HEADERS } from "../next.config";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "./lib/session";
import { NONCE_HEADER, config, contentSecurityPolicy, isPublicPath, middleware } from "./middleware";

const REFRESH_ROUTE = "POST /v1/console/auth/refresh";
const PORTAL_CONSOLE = `${TEST_PORTAL_URL}/console`;
const PORTAL_CONSOLE_OF_TENANT = `${PORTAL_CONSOLE}?tenant=${TENANT_ID}`;

let tokenSequence = 0;
/** A refresh token no other test uses: the process-wide de-duplication map outlives each test. */
function uniqueRefreshToken(): string {
  tokenSequence += 1;
  return `staff-refresh-token-middleware-test-${tokenSequence}-${Date.now()}`;
}

/** A browser request to the admin, with its cookies and headers. */
function request(
  path: string,
  init: { cookies?: Record<string, string>; headers?: Record<string, string>; method?: string } = {},
): NextRequest {
  const headers = new Headers(init.headers);
  const cookies = Object.entries(init.cookies ?? {}).map(([name, value]) => `${name}=${value}`);
  if (cookies.length > 0) {
    headers.set("cookie", cookies.join("; "));
  }
  return new NextRequest(new URL(path, "http://localhost:3002"), {
    headers,
    ...(init.method === undefined ? {} : { method: init.method }),
  });
}

/** The cookies of a signed-in browser whose access token expires in `seconds`. */
function sessionCookies(seconds: number, extra: Record<string, string> = {}): Record<string, string> {
  const refreshToken = uniqueRefreshToken();
  return {
    [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(refreshToken, Date.now(), seconds),
    [STAFF_REFRESH_TOKEN_COOKIE]: refreshToken,
    [ENVIRONMENT_COOKIE]: "live",
    [TENANT_COOKIE]: TENANT_ID,
    ...extra,
  };
}

/** `cookies` without the cookie `name`. */
function without(cookies: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(cookies).filter(([key]) => key !== name));
}

/** The request headers the page or the action of this request receives (`NextResponse.next({ request })`). */
function forwardedHeader(response: NextResponse, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

/** The `Cookie` header the page or the action of this request receives, as a map. */
function forwardedCookies(response: NextResponse): Map<string, string> {
  const header = forwardedHeader(response, "cookie") ?? "";
  return new Map(
    header
      .split("; ")
      .filter((pair) => pair !== "")
      .map((pair) => [
        pair.slice(0, pair.indexOf("=")),
        decodeURIComponent(pair.slice(pair.indexOf("=") + 1)),
      ]),
  );
}

function isPassedThrough(response: NextResponse): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

/** The `Set-Cookie` lines of a response as `[name, value, attributes in lower case]`. */
function setCookies(response: NextResponse): [string, string, string[]][] {
  return response.headers.getSetCookie().map((line) => {
    const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
    const at = pair.indexOf("=");
    return [
      pair.slice(0, at),
      decodeURIComponent(pair.slice(at + 1)),
      attributes.map((attribute) => attribute.toLowerCase()),
    ];
  });
}

let api: FakeOtaApi;

beforeEach(() => {
  settings.current = { ...TEST_CONFIG };
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
});

afterEach(() => {
  // Every refresh of this file went out with the service key only, in test, and with the end-user headers.
  for (const sent of api.sent(REFRESH_ROUTE)) {
    expect(sent.headers.get("X-Api-Key")).toBe(TEST_SERVICE_KEY);
    expect(sent.headers.has("Authorization")).toBe(false);
    expect(sent.headers.get("X-Velexis-Environment")).toBe("test");
    expect(sent.headers.has("X-Velexis-End-User-IP")).toBe(true);
  }
  vi.unstubAllGlobals();
});

describe("matcher and runtime", () => {
  it("runs in the Node.js runtime on every path but Next.js's files, the favicon and the health routes", () => {
    expect(config.runtime).toBe("nodejs");
    for (const path of [
      "/",
      "/bookings",
      "/bookings/bkg_01JBT7A1B2C3D4E5F6G7H8J9K0?tab=payments",
      "/sso",
      "/auth/refresh?next=%2Fqueues",
      "/auth/sign-out",
      "/signed-out",
      "/healthy-looking-page",
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url: path }), path).toBe(true);
    }
    for (const path of [
      "/_next/static/chunks/main.js",
      "/_next/image?url=%2Flogo.png&w=64&q=75",
      "/_next/webpack-hmr",
      "/favicon.ico",
      "/health/live",
      "/health/ready",
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url: path }), path).toBe(false);
    }
  });

  it("serves only the four session routes without a session, by exact path", () => {
    for (const path of ["/sso", "/auth/refresh", "/auth/sign-out", "/signed-out"]) {
      expect(isPublicPath(path), path).toBe(true);
    }
    for (const path of ["/", "/bookings", "/sso/x", "/auth", "/auth/other", "/signed-out/x", "/SSO"]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });
});

describe("Content-Security-Policy", () => {
  it("sets a policy with a fresh nonce on every answer and hands the nonce to the page", async () => {
    const cookies = sessionCookies(900);
    const first = await middleware(request("/bookings", { cookies }));
    const second = await middleware(request("/bookings", { cookies }));

    const policy = first.headers.get("Content-Security-Policy") ?? "";
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];
    expect(nonce).toBeDefined();
    expect(forwardedHeader(first, NONCE_HEADER)).toBe(nonce);
    // Next.js reads the policy from the request to put the nonce on the scripts it renders.
    expect(forwardedHeader(first, "content-security-policy")).toBe(policy);
    expect(second.headers.get("Content-Security-Policy")).not.toBe(policy);
    expect(policy.split("; ")).toEqual([
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ]);
  });

  it("allows eval for next dev only, refuses a nonce that is not one, and keeps next.config.ts's frame-ancestors", () => {
    const nonce = "AAAAAAAAAAAAAAAAAAAAAA==";
    expect(contentSecurityPolicy({ nonce, development: true })).toContain(
      `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`,
    );
    expect(contentSecurityPolicy({ nonce, development: false })).not.toContain("unsafe-eval");
    expect(() => contentSecurityPolicy({ nonce: "x'; script-src *", development: false })).toThrow(TypeError);

    const fallback = SECURITY_HEADERS.find((header) => header.key === "Content-Security-Policy")?.value;
    expect(fallback).toBe("frame-ancestors 'none'");
    expect(contentSecurityPolicy({ nonce, development: false })).toContain(fallback);
  });

  it("sets the policy on the redirect to the portal and on the session routes too", async () => {
    const redirect = await middleware(request("/bookings"));
    const sso = await middleware(request("/sso", { method: "POST" }));

    expect(redirect.headers.get("Content-Security-Policy")).toMatch(/script-src 'self' 'nonce-/);
    expect(sso.headers.get("Content-Security-Policy")).toMatch(/script-src 'self' 'nonce-/);
    expect(forwardedHeader(sso, NONCE_HEADER)).not.toBeNull();
  });
});

describe("session refresh", () => {
  it("passes a request with a fresh access token on as it is, without a refresh call or a cookie change", async () => {
    const cookies = sessionCookies(900);

    const response = await middleware(request("/bookings", { cookies }));

    expect(isPassedThrough(response)).toBe(true);
    expect(api.requests).toEqual([]);
    expect(setCookies(response)).toEqual([]);
    expect(Object.fromEntries(forwardedCookies(response))).toEqual(cookies);
  });

  it("[OAD-003 AC3] two simultaneous requests with the same expiring token refresh once and share the new tokens", async () => {
    const cookies = sessionCookies(30);
    const rotated = staffSession(Date.now(), { accessToken: staffAccessToken("parallel", Date.now(), 900) });
    const answer = deferred<Response>();
    api.on(REFRESH_ROUTE, () => answer.promise);

    const pending = [
      middleware(request("/bookings", { cookies })),
      middleware(request("/queues?view=all", { cookies })),
    ];
    // Both requests reach the refresh before the API answers the first one.
    await vi.waitFor(() => expect(api.sent(REFRESH_ROUTE)).toHaveLength(1));
    answer.resolve(Response.json(rotated));
    const responses = await Promise.all(pending);

    expect(api.sent(REFRESH_ROUTE)).toHaveLength(1);
    expect(api.sent(REFRESH_ROUTE)[0]?.body).toEqual({ refreshToken: cookies[STAFF_REFRESH_TOKEN_COOKIE] });
    for (const response of responses) {
      expect(isPassedThrough(response)).toBe(true);
      expect(setCookies(response).map(([name, value]) => [name, value])).toEqual([
        [STAFF_ACCESS_TOKEN_COOKIE, rotated.session.accessToken],
        [STAFF_REFRESH_TOKEN_COOKIE, rotated.session.refreshToken],
        [ENVIRONMENT_COOKIE, "live"],
        [TENANT_COOKIE, TENANT_ID],
      ]);
      for (const [, , attributes] of setCookies(response)) {
        expect(attributes).toEqual(expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/"]));
      }
      // The page or the action of this request already uses the new tokens, never the old ones.
      expect(forwardedCookies(response).get(STAFF_ACCESS_TOKEN_COOKIE)).toBe(rotated.session.accessToken);
      expect(forwardedCookies(response).get(STAFF_REFRESH_TOKEN_COOKIE)).toBe(rotated.session.refreshToken);
    }
  });

  it("gives a later request with the same old token the same new tokens without a second call", async () => {
    const cookies = sessionCookies(30);
    const rotated = staffSession(Date.now(), { refreshToken: "staff-refresh-token-rotated-once" });
    api.on(REFRESH_ROUTE, () => Response.json(rotated));

    await middleware(request("/bookings", { cookies }));
    const later = await middleware(request("/customers", { cookies }));

    expect(api.sent(REFRESH_ROUTE)).toHaveLength(1);
    expect(forwardedCookies(later).get(STAFF_REFRESH_TOKEN_COOKIE)).toBe("staff-refresh-token-rotated-once");
  });

  it("refreshes a missing access token, forwards the staff member's address and keeps other cookies", async () => {
    const cookies = without(sessionCookies(900, { theme: "dark" }), STAFF_ACCESS_TOKEN_COOKIE);

    const response = await middleware(
      request("/bookings", {
        cookies,
        headers: { "X-Forwarded-For": "6.6.6.6, 203.0.113.7", "User-Agent": "Mozilla/5.0 Test" },
      }),
    );

    const [sent] = api.sent(REFRESH_ROUTE);
    expect(sent?.headers.get("X-Velexis-End-User-IP")).toBe("203.0.113.7");
    expect(sent?.headers.get("X-Velexis-End-User-Agent")).toBe("Mozilla/5.0 Test");
    expect(isPassedThrough(response)).toBe(true);
    expect(forwardedCookies(response).get("theme")).toBe("dark");
  });

  it("falls back to the test environment when the refreshed session no longer allows live", async () => {
    api.on(REFRESH_ROUTE, () => Response.json(staffSession(Date.now(), { environments: ["test"] })));

    const response = await middleware(request("/bookings", { cookies: sessionCookies(30) }));

    expect(setCookies(response).find(([name]) => name === ENVIRONMENT_COOKIE)?.[1]).toBe("test");
    expect(forwardedCookies(response).get(ENVIRONMENT_COOKIE)).toBe("test");
  });

  it("clears the session and goes to the portal when the API refuses the refresh for good", async () => {
    api.on(REFRESH_ROUTE, () => apiError("REFRESH_TOKEN_REUSED", 401));

    const response = await middleware(request("/bookings", { cookies: sessionCookies(30) }));

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(PORTAL_CONSOLE_OF_TENANT);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(setCookies(response).map(([name, value, attributes]) => [name, value, attributes])).toEqual(
      [STAFF_ACCESS_TOKEN_COOKIE, STAFF_REFRESH_TOKEN_COOKIE, ENVIRONMENT_COOKIE].map((name) => [
        name,
        "",
        expect.arrayContaining(["max-age=0", "secure", "httponly", "path=/"]),
      ]),
    );
  });

  it("keeps the session and goes on with a still valid access token when the refresh may pass later", async () => {
    const cookies = sessionCookies(30);
    api.on(REFRESH_ROUTE, rateLimited);

    const response = await middleware(request("/bookings", { cookies }));

    expect(isPassedThrough(response)).toBe(true);
    expect(setCookies(response)).toEqual([]);
    expect(Object.fromEntries(forwardedCookies(response))).toEqual(cookies);
  });

  it("leaves an expired access token out of the request when the refresh may pass later", async () => {
    const cookies = sessionCookies(-5);
    // `Retry-After: 60` ends the SDK's call at once instead of after its back-off.
    api.on(REFRESH_ROUTE, () => apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }));

    const response = await middleware(request("/bookings", { cookies }));

    expect(isPassedThrough(response)).toBe(true);
    expect(setCookies(response)).toEqual([]);
    const forwarded = forwardedCookies(response);
    expect(forwarded.has(STAFF_ACCESS_TOKEN_COOKIE)).toBe(false);
    expect(forwarded.get(STAFF_REFRESH_TOKEN_COOKIE)).toBe(cookies[STAFF_REFRESH_TOKEN_COOKIE]);
  });
});

describe("redirect to the portal", () => {
  it("sends a request without a session to the portal's console page, deny by default", async () => {
    for (const path of ["/", "/bookings", "/a-page-that-does-not-exist-yet"]) {
      const response = await middleware(request(path));
      expect(response.status, path).toBe(303);
      expect(response.headers.get("Location"), path).toBe(PORTAL_CONSOLE);
    }
    const withTenant = await middleware(request("/bookings", { cookies: { [TENANT_COOKIE]: TENANT_ID } }));
    expect(withTenant.headers.get("Location")).toBe(PORTAL_CONSOLE_OF_TENANT);
    expect(setCookies(withTenant)).toEqual([]);
    expect(api.requests).toEqual([]);
  });

  it("ends a session whose access token expired with nothing to refresh it", async () => {
    const cookies = without(sessionCookies(-5), STAFF_REFRESH_TOKEN_COOKIE);

    const response = await middleware(request("/bookings", { cookies }));

    expect(response.headers.get("Location")).toBe(PORTAL_CONSOLE_OF_TENANT);
    expect(setCookies(response).map(([name]) => name)).toEqual([
      STAFF_ACCESS_TOKEN_COOKIE,
      STAFF_REFRESH_TOKEN_COOKIE,
      ENVIRONMENT_COOKIE,
    ]);
    expect(api.requests).toEqual([]);
  });

  it("lets a still valid access token go on without a refresh token", async () => {
    const cookies = without(sessionCookies(30), STAFF_REFRESH_TOKEN_COOKIE);

    const response = await middleware(request("/bookings", { cookies }));

    expect(isPassedThrough(response)).toBe(true);
    expect(api.requests).toEqual([]);
  });

  it("never redirects or refreshes the session routes, which handle sessions themselves", async () => {
    const expiring = sessionCookies(30);
    for (const [path, method] of [
      ["/sso", "POST"],
      ["/auth/refresh?next=%2Fbookings", "GET"],
      ["/auth/sign-out", "POST"],
      ["/signed-out", "GET"],
    ] as const) {
      for (const cookies of [{}, expiring]) {
        const response = await middleware(request(path, { cookies, method }));
        expect(isPassedThrough(response), path).toBe(true);
        expect(setCookies(response), path).toEqual([]);
      }
    }
    expect(api.requests).toEqual([]);
  });
});
