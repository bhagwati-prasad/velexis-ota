import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NextRequest, type NextResponse } from "next/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  APP_ENV: "production" as "development" | "test" | "production",
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PLATFORM_ADMIN_URL: "https://admin.platform.example.com",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
}));

vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import { config, contentSecurityPolicy, isPublicPath, middleware, signInUrl } from "./middleware";

const README = fileURLToPath(new URL("../README.md", import.meta.url));
const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

let counter = 0;
/** A refresh token no other test uses: the single-flight map of the module lives for the whole file. */
function uniqueRefreshToken(): string {
  counter += 1;
  return `refresh-token-${counter}-${Math.random().toString(36).slice(2)}`;
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(payload)}.c2lnbmF0dXJl`;
}

function accessToken(options: { expiresInSeconds: number; aud?: string }): string {
  return jwt({
    sub: "acc_1",
    aud: options.aud ?? "platform_admin",
    typ: "admin",
    exp: Math.floor(Date.now() / 1000) + options.expiresInSeconds,
  });
}

function adminSession(token: string, refreshToken: string): Record<string, unknown> {
  return {
    accessToken: token,
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken,
    refreshTokenExpiresAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    admin: { id: "acc_1", email: "lena.holm@example.com", fullName: "Lena Holm", features: {} },
  };
}

function request(
  path: string,
  init: { cookies?: Record<string, string>; headers?: Record<string, string>; method?: string } = {},
) {
  const headers = new Headers(init.headers);
  const cookies = Object.entries(init.cookies ?? {}).map(([name, value]) => `${name}=${value}`);
  if (cookies.length > 0) {
    headers.set("cookie", cookies.join("; "));
  }
  return new NextRequest(new URL(path, "http://127.0.0.1:3001"), {
    headers,
    ...(init.method === undefined ? {} : { method: init.method }),
  });
}

/** The request headers the page rendered after the middleware receives (`NextResponse.next({ request })`). */
function forwardedHeader(response: NextResponse, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

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

function setCookies(response: NextResponse): string[] {
  return response.headers.getSetCookie();
}

function refreshCalls(): Request[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => input.url.endsWith("/v1/admin/auth/refresh"));
}

function isPassedThrough(response: NextResponse): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

beforeEach(() => {
  settings.APP_ENV = "production";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // [PAD-002 AC4] every mocked API call of this file carried the three end-user headers of PADR-0019.
  for (const [call] of fetchMock.mock.calls) {
    expect(call.headers.get("x-velexis-bff-key")).toBe(settings.PLATFORM_BFF_KEY);
    expect(call.headers.has("x-velexis-end-user-ip")).toBe(true);
    expect(call.headers.has("x-velexis-end-user-agent")).toBe(true);
  }
});

describe("access token refresh", () => {
  it("[PAD-002 AC3] five parallel requests with an expired access token cause exactly one refresh call", async () => {
    const refreshToken = uniqueRefreshToken();
    const expired = accessToken({ expiresInSeconds: -60 });
    const renewed = accessToken({ expiresInSeconds: 900 });
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolveAnswer) => {
        release = resolveAnswer;
      }),
    );

    const pending = ["/", "/tenants", "/tenants/ten_1", "/queues", "/audit?actor=acc_1"].map((path) =>
      middleware(request(path, { cookies: { "__Host-vxa_at": expired, "__Host-vxa_rt": refreshToken } })),
    );
    // Let all five reach the refresh before the API answers.
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    release(Response.json(adminSession(renewed, "rotated-refresh-token")));
    const responses = await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshCalls()).toHaveLength(1);
    expect(await refreshCalls()[0]!.json()).toEqual({ refreshToken });
    for (const response of responses) {
      expect(isPassedThrough(response)).toBe(true);
      const cookies = setCookies(response);
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toMatch(new RegExp(`^__Host-vxa_at=${renewed.replace(/[.]/g, "\\.")}; Path=/; `));
      expect(cookies[1]).toMatch(/^__Host-vxa_rt=rotated-refresh-token; Path=\/; /);
      for (const cookie of cookies) {
        expect(cookie).toMatch(/; Secure; HttpOnly; SameSite=strict$/i);
      }
      // The page rendered for this request already sees the new tokens, never the expired one.
      expect(forwardedCookies(response).get("__Host-vxa_at")).toBe(renewed);
      expect(forwardedCookies(response).get("__Host-vxa_rt")).toBe("rotated-refresh-token");
    }
  });

  it("[PAD-002 AC4] the refresh call carries the three end-user headers and a request id, without a bearer token", async () => {
    const refreshToken = uniqueRefreshToken();
    fetchMock.mockResolvedValue(
      Response.json(adminSession(accessToken({ expiresInSeconds: 900 }), "rotated")),
    );

    await middleware(
      request("/tenants", {
        cookies: { "__Host-vxa_rt": refreshToken },
        headers: {
          "X-Forwarded-For": "6.6.6.6, 203.0.113.7",
          "User-Agent": `Agent/3.0 ${"z".repeat(600)}`,
          "X-Request-Id": "8d1f4c2a-3b5e-4f6a-9c7d-0e1f2a3b4c5d",
        },
      }),
    );

    const [call] = refreshCalls();
    expect(call).toBeDefined();
    expect(call!.url).toBe("http://127.0.0.1:3100/v1/admin/auth/refresh");
    expect(call!.headers.get("x-velexis-end-user-ip")).toBe("203.0.113.7");
    expect(call!.headers.get("x-velexis-end-user-agent")).toBe(`Agent/3.0 ${"z".repeat(502)}`);
    expect(call!.headers.get("x-velexis-bff-key")).toBe(settings.PLATFORM_BFF_KEY);
    expect(call!.headers.get("x-request-id")).toBe("8d1f4c2a-3b5e-4f6a-9c7d-0e1f2a3b4c5d");
    expect(call!.headers.has("authorization")).toBe(false);
    expect(call!.cache).toBe("no-store");
  });

  it("uses a fresh access token as it is, without a refresh call or cookie changes", async () => {
    const fresh = accessToken({ expiresInSeconds: 600 });

    const response = await middleware(
      request("/tenants", { cookies: { "__Host-vxa_at": fresh, "__Host-vxa_rt": uniqueRefreshToken() } }),
    );

    expect(isPassedThrough(response)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  it("refreshes an access token that expires within 30 seconds", async () => {
    fetchMock.mockResolvedValue(
      Response.json(adminSession(accessToken({ expiresInSeconds: 900 }), "rotated")),
    );

    await middleware(
      request("/", {
        cookies: {
          "__Host-vxa_at": accessToken({ expiresInSeconds: 20 }),
          "__Host-vxa_rt": uniqueRefreshToken(),
        },
      }),
    );

    expect(refreshCalls()).toHaveLength(1);
  });

  it("refreshes when the access cookie is gone and only the refresh token is left", async () => {
    const renewed = accessToken({ expiresInSeconds: 900 });
    fetchMock.mockResolvedValue(Response.json(adminSession(renewed, "rotated")));

    const response = await middleware(
      request("/accounts", { cookies: { "__Host-vxa_rt": uniqueRefreshToken() } }),
    );

    expect(isPassedThrough(response)).toBe(true);
    expect(refreshCalls()).toHaveLength(1);
    expect(forwardedCookies(response).get("__Host-vxa_at")).toBe(renewed);
  });

  it("deletes both cookies and sends the admin to sign in when the refresh token can never work again", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { code: "REFRESH_TOKEN_REUSED", status: 401, message: "m", requestId: "req_1" } },
        { status: 401 },
      ),
    );

    const response = await middleware(
      request("/tenants/ten_1", {
        cookies: {
          "__Host-vxa_at": accessToken({ expiresInSeconds: -5 }),
          "__Host-vxa_rt": uniqueRefreshToken(),
        },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://admin.platform.example.com/sign-in?next=%2Ftenants%2Ften_1",
    );
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Host-vxa_(at|rt)=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=strict$/i);
    }
  });

  it("on the sign-in page after a final refresh failure, the page sees no session cookies", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { code: "REFRESH_TOKEN_INVALID", status: 401, message: "m", requestId: "req_1" } },
        { status: 401 },
      ),
    );

    const response = await middleware(
      request("/sign-in", {
        cookies: {
          "__Host-vxa_at": accessToken({ expiresInSeconds: -5 }),
          "__Host-vxa_rt": uniqueRefreshToken(),
          theme: "light",
        },
      }),
    );

    expect(isPassedThrough(response)).toBe(true);
    expect([...forwardedCookies(response)]).toEqual([["theme", "light"]]);
    expect(setCookies(response)).toHaveLength(2);
  });

  it("keeps the cookies when the API is unavailable, and the next request tries again", async () => {
    const refreshToken = uniqueRefreshToken();
    const cookies = { "__Host-vxa_at": accessToken({ expiresInSeconds: -5 }), "__Host-vxa_rt": refreshToken };
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    fetchMock.mockResolvedValueOnce(
      Response.json(adminSession(accessToken({ expiresInSeconds: 900 }), "rotated")),
    );

    const unavailable = await middleware(request("/tenants", { cookies }));
    const retried = await middleware(request("/tenants", { cookies }));

    expect(unavailable.status).toBe(303);
    expect(setCookies(unavailable)).toEqual([]);
    expect(isPassedThrough(retried)).toBe(true);
    expect(refreshCalls()).toHaveLength(2);
  });

  it("deletes an unreadable access token that has no refresh token, and sends the admin to sign in", async () => {
    const response = await middleware(request("/", { cookies: { "__Host-vxa_at": "garbage" } }));

    expect(response.status).toBe(303);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setCookies(response).map((cookie) => cookie.split(";")[0])).toEqual([
      "__Host-vxa_at=",
      "__Host-vxa_rt=",
    ]);
  });

  it("does not take a portal token or the portal's cookies for an admin session", async () => {
    const portalToken = accessToken({ expiresInSeconds: 600, aud: "portal" });

    const inAdminCookie = await middleware(
      request("/tenants", { cookies: { "__Host-vxa_at": portalToken } }),
    );
    const portalCookies = await middleware(
      request("/tenants", {
        cookies: {
          "__Host-vxp_at": accessToken({ expiresInSeconds: 600 }),
          "__Host-vxp_rt": "portal-refresh",
        },
      }),
    );

    expect(inAdminCookie.status).toBe(303);
    expect(portalCookies.status).toBe(303);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The routes of README §2 (route map and route handlers) with sample values for their parameters, so the list
 * follows the specification: a new route there is checked here at once.
 */
function readmeRoutes(): string[] {
  const readme = readFileSync(README, "utf8");
  const section = readme.slice(readme.indexOf("## 2. Route map"), readme.indexOf("## 3. Folder layout"));
  const tableRoutes = [...section.matchAll(/^\| `(\/[^`]*)` \|/gm)].map((match) => match[1]!);
  const handlerLine = section.split("\n").find((line) => line.startsWith("Route handlers:")) ?? "";
  const handlerRoutes = [...handlerLine.matchAll(/`(\/[^`\s]*)`/g)].map((match) => match[1]!);
  return [...tableRoutes, ...handlerRoutes].map((route) =>
    route.replace(/\[([A-Za-z]+)\]/g, (_all, name: string) => `${name.toLowerCase()}_01SAMPLE`),
  );
}

describe("the signed-in area", () => {
  let routes: string[] = [];

  beforeAll(() => {
    routes = readmeRoutes();
  });

  it("reads the route map of README §2", () => {
    expect(routes).toContain("/");
    expect(routes).toContain("/sign-in");
    expect(routes).toContain("/tenants/tenantid_01SAMPLE");
    expect(routes).toContain("/audit/export.csv");
    expect(routes.length).toBeGreaterThan(25);
  });

  it("[PAD-002 AC2] sends every (app) route of README §2 to /sign-in without a session, with the path as next", async () => {
    const appRoutes = routes.filter((route) => !isPublicPath(route) && !route.startsWith("/health/"));
    expect(appRoutes.length).toBeGreaterThan(20);

    for (const route of appRoutes) {
      const response = await middleware(request(`${route}?tab=2`));

      expect(response.status, route).toBe(303);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin, route).toBe("https://admin.platform.example.com");
      expect(location.pathname, route).toBe("/sign-in");
      expect(location.searchParams.get("next"), route).toBe(`${route}?tab=2`);
      expect(response.headers.get("cache-control"), route).toBe("no-store");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[PAD-002 AC2] sends the dashboard to /sign-in without a next, and denies paths that do not exist yet", async () => {
    const dashboard = await middleware(request("/"));
    const unknown = await middleware(request("/no-such-page"));
    const lookAlike = await middleware(request("/sign-in-elsewhere"));

    expect(dashboard.status).toBe(303);
    expect(dashboard.headers.get("location")).toBe("https://admin.platform.example.com/sign-in");
    expect(unknown.status).toBe(303);
    expect(lookAlike.status).toBe(303);
    // Only the two sign-in steps themselves are public, not every path below /sign-in.
    for (const path of ["/sign-in/other", "/sign-in/mfa/extra", "/sign-out/x"]) {
      const response = await middleware(request(path));

      expect(isPublicPath(path), path).toBe(false);
      expect(response.status, path).toBe(303);
      expect(new URL(response.headers.get("location") ?? "").searchParams.get("next"), path).toBe(path);
    }
  });

  it("[PAD-002 AC2] sends a server action or form post of an (app) page to /sign-in with 303", async () => {
    const response = await middleware(request("/tenants/ten_1", { method: "POST" }));

    expect(response.status).toBe(303);
  });

  it("[PAD-002 AC2] with a session, every (app) route renders", async () => {
    const fresh = accessToken({ expiresInSeconds: 600 });
    for (const route of routes.filter((candidate) => !isPublicPath(candidate))) {
      const response = await middleware(request(route, { cookies: { "__Host-vxa_at": fresh } }));

      expect(isPassedThrough(response), route).toBe(true);
    }
  });

  it.each(["/sign-in", "/sign-in?mfa=expired", "/sign-in/mfa", "/sign-out"])(
    "lets %s through without a session",
    async (path) => {
      const response = await middleware(request(path, { method: path === "/sign-out" ? "POST" : "GET" }));

      expect(isPassedThrough(response)).toBe(true);
    },
  );

  it("the sign-in redirect never carries an absolute or protocol-relative next", () => {
    const adminUrl = settings.PUBLIC_PLATFORM_ADMIN_URL;

    const protocolRelative = new NextRequest("http://127.0.0.1:3001//evil.example/x");

    expect(protocolRelative.nextUrl.pathname).toBe("//evil.example/x");
    expect(signInUrl(protocolRelative, adminUrl).toString()).toBe(
      "https://admin.platform.example.com/sign-in",
    );
    expect(signInUrl(request("/tenants"), adminUrl).toString()).toBe(
      "https://admin.platform.example.com/sign-in?next=%2Ftenants",
    );
  });
});

describe("Content-Security-Policy and X-Robots-Tag", () => {
  function nonceOf(policy: string | null): string | undefined {
    return /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy ?? "")?.[1];
  }

  it("sets a nonce-based policy with form-action 'self' on the response and hands the same nonce to the page", async () => {
    const response = await middleware(request("/sign-in"));

    const policy = response.headers.get("content-security-policy");
    const nonce = nonceOf(policy);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(forwardedHeader(response, "x-nonce")).toBe(nonce);
    expect(forwardedHeader(response, "content-security-policy")).toBe(policy);
    expect(policy).toBe(
      [
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
      ].join("; "),
    );
  });

  it("sends X-Robots-Tag: noindex on pages and on its own redirects", async () => {
    const page = await middleware(request("/sign-in"));
    const redirect = await middleware(request("/tenants"));

    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("x-robots-tag")).toBe("noindex");
    expect(redirect.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("uses a new nonce for every request", async () => {
    const first = nonceOf((await middleware(request("/sign-in"))).headers.get("content-security-policy"));
    const second = nonceOf((await middleware(request("/sign-in"))).headers.get("content-security-policy"));

    expect(first).not.toBe(second);
  });

  it("adds 'unsafe-eval' for next dev only", async () => {
    settings.APP_ENV = "development";
    const development = (await middleware(request("/sign-in"))).headers.get("content-security-policy");
    settings.APP_ENV = "test";
    const test = (await middleware(request("/sign-in"))).headers.get("content-security-policy");

    expect(development).toMatch(/script-src 'self' 'nonce-[^']+' 'unsafe-eval';/);
    expect(test).not.toContain("unsafe-eval");
  });

  it("every page renders per request, so Next.js can put the nonce on its scripts", async () => {
    // A prerendered page (the not-found page, a page that reads no request data) would keep inline scripts without
    // the nonce, and the policy would block them.
    const layout = await import("./app/layout");

    expect(layout.dynamic).toBe("force-dynamic");
  });

  it("refuses a nonce that could break out of the header", () => {
    expect(() => contentSecurityPolicy({ nonce: "abc'; script-src *", development: false })).toThrow(
      TypeError,
    );
  });
});

describe("request id", () => {
  it("keeps a valid X-Request-Id and creates one when there is none", async () => {
    const kept = await middleware(
      request("/sign-in", { headers: { "X-Request-Id": "req_from_caddy_0001" } }),
    );
    const created = await middleware(request("/sign-in", { headers: { "X-Request-Id": "no" } }));

    expect(forwardedHeader(kept, "x-request-id")).toBe("req_from_caddy_0001");
    expect(forwardedHeader(created, "x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("matcher", () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);

  it("runs on pages, route handlers and server actions", () => {
    for (const path of ["/", "/tenants", "/sign-in", "/sign-in/mfa", "/sign-out", "/audit/export.csv"]) {
      expect(matcher.test(path), path).toBe(true);
    }
  });

  it("skips Next.js's own files, the favicon and the health routes", () => {
    for (const path of [
      "/_next/static/chunks/main.js",
      "/_next/image",
      "/_next/webpack-hmr",
      "/favicon.ico",
      "/health/live",
      "/health/ready",
    ]) {
      expect(matcher.test(path), path).toBe(false);
    }
  });

  it("runs in the Node.js runtime, where the single-flight map lives in the admin process", () => {
    expect(config.runtime).toBe("nodejs");
  });
});
