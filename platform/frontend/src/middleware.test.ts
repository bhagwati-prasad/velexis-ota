import { NextRequest, type NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  APP_ENV: "production" as "development" | "test" | "production",
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
}));

vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import { contentSecurityPolicy } from "./lib/csp";
import { APP_ROUTE_PREFIXES, config, middleware, signInUrl } from "./middleware";

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

function accessToken(options: { expiresInSeconds: number; emailVerified?: boolean }): string {
  return jwt({
    sub: "acc_1",
    aud: "portal",
    exp: Math.floor(Date.now() / 1000) + options.expiresInSeconds,
    ev: options.emailVerified ?? true,
  });
}

function portalSession(token: string, refreshToken: string): Record<string, unknown> {
  return {
    accessToken: token,
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken,
    refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    account: { id: "acc_1" },
  };
}

function request(
  path: string,
  init: { cookies?: Record<string, string>; headers?: Record<string, string> } = {},
) {
  const headers = new Headers(init.headers);
  const cookies = Object.entries(init.cookies ?? {}).map(([name, value]) => `${name}=${value}`);
  if (cookies.length > 0) {
    headers.set("cookie", cookies.join("; "));
  }
  return new NextRequest(new URL(path, "http://127.0.0.1:3000"), { headers });
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
    .filter((input) => input.url.endsWith("/v1/auth/refresh"));
}

function isPassedThrough(response: NextResponse): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

beforeEach(() => {
  settings.APP_ENV = "production";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("access token refresh", () => {
  it("[PFE-002 AC1] five parallel requests with an expired access token cause exactly one refresh call", async () => {
    const refreshToken = uniqueRefreshToken();
    const expired = accessToken({ expiresInSeconds: -60 });
    const renewed = accessToken({ expiresInSeconds: 900 });
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolveAnswer) => {
        release = resolveAnswer;
      }),
    );

    const pending = ["/dashboard", "/otas/ten_1", "/account", "/", "/otas/ten_1/team"].map((path) =>
      middleware(request(path, { cookies: { "__Host-vxp_at": expired, "__Host-vxp_rt": refreshToken } })),
    );
    // Let all five reach the refresh before the API answers.
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    release(Response.json(portalSession(renewed, "rotated-refresh-token")));
    const responses = await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshCalls()).toHaveLength(1);
    expect(await refreshCalls()[0]!.json()).toEqual({ refreshToken });
    for (const response of responses) {
      expect(isPassedThrough(response)).toBe(true);
      const cookies = setCookies(response);
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toMatch(new RegExp(`^__Host-vxp_at=${renewed.replace(/[.]/g, "\\.")}; Path=/; `));
      expect(cookies[1]).toMatch(/^__Host-vxp_rt=rotated-refresh-token; Path=\/; /);
      // The page rendered for this request already sees the new tokens, never the expired one.
      expect(forwardedCookies(response).get("__Host-vxp_at")).toBe(renewed);
      expect(forwardedCookies(response).get("__Host-vxp_rt")).toBe("rotated-refresh-token");
    }
  });

  it("[PFE-002 AC5] the refresh call carries the three end-user headers and a request id, without a bearer token", async () => {
    const refreshToken = uniqueRefreshToken();
    fetchMock.mockResolvedValue(
      Response.json(portalSession(accessToken({ expiresInSeconds: 900 }), "rotated")),
    );

    await middleware(
      request("/dashboard", {
        cookies: { "__Host-vxp_rt": refreshToken },
        headers: {
          "X-Forwarded-For": "6.6.6.6, 203.0.113.7",
          "User-Agent": `Agent/3.0 ${"z".repeat(600)}`,
          "X-Request-Id": "8d1f4c2a-3b5e-4f6a-9c7d-0e1f2a3b4c5d",
        },
      }),
    );

    const [call] = refreshCalls();
    expect(call).toBeDefined();
    expect(call!.url).toBe("http://127.0.0.1:3100/v1/auth/refresh");
    expect(call!.headers.get("x-velexis-end-user-ip")).toBe("203.0.113.7");
    expect(call!.headers.get("x-velexis-end-user-agent")).toHaveLength(512);
    expect(call!.headers.get("x-velexis-bff-key")).toBe(settings.PLATFORM_BFF_KEY);
    expect(call!.headers.get("x-request-id")).toBe("8d1f4c2a-3b5e-4f6a-9c7d-0e1f2a3b4c5d");
    expect(call!.headers.has("authorization")).toBe(false);
    expect(call!.cache).toBe("no-store");
  });

  it("uses a fresh access token as it is, without a refresh call or cookie changes", async () => {
    const fresh = accessToken({ expiresInSeconds: 600 });

    const response = await middleware(
      request("/dashboard", { cookies: { "__Host-vxp_at": fresh, "__Host-vxp_rt": uniqueRefreshToken() } }),
    );

    expect(isPassedThrough(response)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  it("refreshes an access token that expires within 30 seconds", async () => {
    fetchMock.mockResolvedValue(
      Response.json(portalSession(accessToken({ expiresInSeconds: 900 }), "rotated")),
    );

    await middleware(
      request("/dashboard", {
        cookies: {
          "__Host-vxp_at": accessToken({ expiresInSeconds: 20 }),
          "__Host-vxp_rt": uniqueRefreshToken(),
        },
      }),
    );

    expect(refreshCalls()).toHaveLength(1);
  });

  it("refreshes when the access cookie is gone and only the refresh token is left", async () => {
    const renewed = accessToken({ expiresInSeconds: 900 });
    fetchMock.mockResolvedValue(Response.json(portalSession(renewed, "rotated")));

    const response = await middleware(
      request("/account", { cookies: { "__Host-vxp_rt": uniqueRefreshToken() } }),
    );

    expect(isPassedThrough(response)).toBe(true);
    expect(refreshCalls()).toHaveLength(1);
    expect(forwardedCookies(response).get("__Host-vxp_at")).toBe(renewed);
  });

  it("deletes both cookies and sends the person to sign in when the refresh token can never work again", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { code: "REFRESH_TOKEN_REUSED", status: 401, message: "m", requestId: "req_1" } },
        { status: 401 },
      ),
    );

    const response = await middleware(
      request("/otas/ten_1", {
        cookies: {
          "__Host-vxp_at": accessToken({ expiresInSeconds: -5 }),
          "__Host-vxp_rt": uniqueRefreshToken(),
        },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://platform.example.com/sign-in?next=%2Fotas%2Ften_1",
    );
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Host-vxp_(at|rt)=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=lax$/i);
    }
  });

  it("on a public page after a final refresh failure, the page sees no session cookies", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { code: "REFRESH_TOKEN_INVALID", status: 401, message: "m", requestId: "req_1" } },
        { status: 401 },
      ),
    );

    const response = await middleware(
      request("/pricing", {
        cookies: {
          "__Host-vxp_at": accessToken({ expiresInSeconds: -5 }),
          "__Host-vxp_rt": uniqueRefreshToken(),
          theme: "dark",
        },
      }),
    );

    expect(isPassedThrough(response)).toBe(true);
    expect([...forwardedCookies(response)]).toEqual([["theme", "dark"]]);
    expect(setCookies(response)).toHaveLength(2);
  });

  it("keeps the cookies when the API is unavailable, and the next request tries again", async () => {
    const refreshToken = uniqueRefreshToken();
    const cookies = { "__Host-vxp_at": accessToken({ expiresInSeconds: -5 }), "__Host-vxp_rt": refreshToken };
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    fetchMock.mockResolvedValueOnce(
      Response.json(portalSession(accessToken({ expiresInSeconds: 900 }), "rotated")),
    );

    const unavailable = await middleware(request("/dashboard", { cookies }));
    const retried = await middleware(request("/dashboard", { cookies }));

    expect(unavailable.status).toBe(303);
    expect(setCookies(unavailable)).toEqual([]);
    expect(isPassedThrough(retried)).toBe(true);
    expect(refreshCalls()).toHaveLength(2);
  });

  it("deletes an unreadable access token that has no refresh token", async () => {
    const response = await middleware(request("/", { cookies: { "__Host-vxp_at": "garbage" } }));

    expect(isPassedThrough(response)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(forwardedCookies(response).has("__Host-vxp_at")).toBe(false);
    expect(setCookies(response).map((cookie) => cookie.split(";")[0])).toEqual([
      "__Host-vxp_at=",
      "__Host-vxp_rt=",
    ]);
  });
});

describe("signed-in area", () => {
  it.each(APP_ROUTE_PREFIXES)(
    "sends a request for %s without a session to /sign-in with next",
    async (prefix) => {
      const response = await middleware(request(`${prefix}/sub/page?tab=2`));

      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("https://platform.example.com");
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("next")).toBe(`${prefix}/sub/page?tab=2`);
    },
  );

  it.each([
    "/",
    "/pricing",
    "/legal/terms",
    "/sign-in",
    "/sign-up",
    "/verify-pending",
    "/verify-email",
    "/dashboards",
  ])("lets %s through without a session", async (path) => {
    const response = await middleware(request(path));

    expect(isPassedThrough(response)).toBe(true);
  });

  it("sends an unverified account from the signed-in area to /verify-pending", async () => {
    const unverified = accessToken({ expiresInSeconds: 600, emailVerified: false });

    const dashboard = await middleware(request("/dashboard", { cookies: { "__Host-vxp_at": unverified } }));
    const pending = await middleware(
      request("/verify-pending", { cookies: { "__Host-vxp_at": unverified } }),
    );

    expect(dashboard.status).toBe(303);
    expect(dashboard.headers.get("location")).toBe("https://platform.example.com/verify-pending");
    expect(isPassedThrough(pending)).toBe(true);
  });

  it("decides on the refreshed token: an account verified meanwhile gets in", async () => {
    fetchMock.mockResolvedValue(
      Response.json(portalSession(accessToken({ expiresInSeconds: 900, emailVerified: true }), "rotated")),
    );

    const response = await middleware(
      request("/dashboard", {
        cookies: {
          "__Host-vxp_at": accessToken({ expiresInSeconds: -1, emailVerified: false }),
          "__Host-vxp_rt": uniqueRefreshToken(),
        },
      }),
    );

    expect(isPassedThrough(response)).toBe(true);
  });

  it("[PFE-002 AC2] the sign-in redirect never carries an absolute or protocol-relative next", () => {
    const portal = settings.PUBLIC_PORTAL_URL;

    const protocolRelative = new NextRequest("http://127.0.0.1:3000//evil.example/x");

    expect(protocolRelative.nextUrl.pathname).toBe("//evil.example/x");
    expect(signInUrl(protocolRelative, portal).toString()).toBe("https://platform.example.com/sign-in");
    expect(signInUrl(request("/dashboard"), portal).toString()).toBe(
      "https://platform.example.com/sign-in?next=%2Fdashboard",
    );
  });
});

describe("Content-Security-Policy", () => {
  function nonceOf(policy: string | null): string | undefined {
    return /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy ?? "")?.[1];
  }

  it("sets a nonce-based policy on the response and hands the same nonce to the page", async () => {
    const response = await middleware(request("/"));

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
        "form-action 'self' https://admin.ota.example.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
      ].join("; "),
    );
  });

  it("uses a new nonce for every request", async () => {
    const first = nonceOf((await middleware(request("/"))).headers.get("content-security-policy"));
    const second = nonceOf((await middleware(request("/"))).headers.get("content-security-policy"));

    expect(first).not.toBe(second);
  });

  it("allows form posts to the origin of PUBLIC_OTA_ADMIN_URL only (SSO hand-off)", () => {
    const policy = contentSecurityPolicy({
      nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
      otaAdminUrl: "http://localhost:3002/sso?x=1",
      development: false,
    });

    expect(policy).toContain("form-action 'self' http://localhost:3002;");
  });

  it("adds 'unsafe-eval' for next dev only", async () => {
    settings.APP_ENV = "development";
    const development = (await middleware(request("/"))).headers.get("content-security-policy");
    settings.APP_ENV = "test";
    const test = (await middleware(request("/"))).headers.get("content-security-policy");

    expect(development).toMatch(/script-src 'self' 'nonce-[^']+' 'unsafe-eval';/);
    expect(test).not.toContain("unsafe-eval");
  });

  it("refuses a nonce that could break out of the header", () => {
    expect(() =>
      contentSecurityPolicy({
        nonce: "abc'; script-src *",
        otaAdminUrl: settings.PUBLIC_OTA_ADMIN_URL,
        development: false,
      }),
    ).toThrow(TypeError);
  });

  it("sets the policy on redirects too", async () => {
    const response = await middleware(request("/dashboard"));

    expect(response.status).toBe(303);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("token links (PFE-006)", () => {
  /** A reset token as the e-mail carries it (a dummy, never a real one). */
  const RESET_TOKEN = "pr_Pr2xL9qW5mT8vK3cN7bZ4hY1dF6sJ0aG2eU8iO5rQ1k";

  /** The HTML entities `tokenLinkPage` writes, decoded as a browser decodes an attribute value. */
  function unescapeHtml(value: string): string {
    return value
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  }

  /**
   * Where the page of a token link takes the browser: the URL of its declarative refresh, which must be the URL of
   * its fallback link too.
   */
  async function refreshTarget(response: NextResponse): Promise<string> {
    const html = await response.clone().text();
    const refreshes = [...html.matchAll(/<meta http-equiv="refresh" content="0; url=([^"]*)">/g)];
    const links = [...html.matchAll(/<a href="([^"]*)">/g)];
    expect(refreshes).toHaveLength(1);
    expect(links).toHaveLength(1);
    expect(links[0]?.[1]).toBe(refreshes[0]?.[1]);
    return unescapeHtml(refreshes[0]?.[1] ?? "");
  }

  it("[PFE-006 AC3] moves the token of /reset-password?token=… into an HttpOnly cookie and takes the browser to the URL without it [PF-05 AC1]", async () => {
    const response = await middleware(request(`/reset-password?token=${RESET_TOKEN}`));

    // A page without script that refreshes at once, not a 303: after a redirect the browser would not send the
    // SameSite=Strict cookie with a link opened from web mail (README §6).
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.clone().text();
    expect(html).not.toMatch(/<script|<form/i);
    // The browser URL it ends on (and so the history and any later Referer) carries no token, and the page shows
    // none either.
    expect(await refreshTarget(response)).toBe("https://platform.example.com/reset-password");
    expect(html).not.toContain(RESET_TOKEN);
    expect(html).not.toContain("token");
    // One cookie: the token, HttpOnly (no browser JavaScript reads it), Secure, SameSite=Strict, 15 minutes, no
    // Domain (the __Host- prefix). The Expires attribute Next.js adds next to Max-Age is left out of the comparison.
    const [line, ...others] = setCookies(response);
    expect(others).toEqual([]);
    expect(
      line
        ?.split("; ")
        .filter((attribute) => !attribute.startsWith("Expires="))
        .sort(),
    ).toEqual(
      [
        `__Host-vxp_reset=${RESET_TOKEN}`,
        "HttpOnly",
        "Max-Age=900",
        "Path=/",
        "SameSite=strict",
        "Secure",
      ].sort(),
    );
    // The refresh sends no Referer, whatever the browser takes from the header or the page.
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers HEAD of a token link the same way, without passing it to the page", async () => {
    const response = await middleware(
      new NextRequest(new URL(`/reset-password?token=${RESET_TOKEN}`, "http://127.0.0.1:3000"), {
        method: "HEAD",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(setCookies(response)).toHaveLength(1);
    expect(setCookies(response)[0]).toContain(`__Host-vxp_reset=${RESET_TOKEN};`);
  });

  it("[PFE-006 AC3] passes the clean URL through to the page, which reads the cookie", async () => {
    const response = await middleware(
      request("/reset-password", { cookies: { "__Host-vxp_reset": RESET_TOKEN } }),
    );

    expect(isPassedThrough(response)).toBe(true);
    expect(forwardedCookies(response).get("__Host-vxp_reset")).toBe(RESET_TOKEN);
    expect(setCookies(response)).toEqual([]);
  });

  it("keeps the other query parameters and the session refresh of the same request", async () => {
    const refreshToken = uniqueRefreshToken();
    fetchMock.mockResolvedValue(
      Response.json(portalSession(accessToken({ expiresInSeconds: 900 }), "rotated")),
    );

    const response = await middleware(
      request(`/reset-password?lang=en&token=${RESET_TOKEN}&token=second`, {
        cookies: { "__Host-vxp_rt": refreshToken },
      }),
    );

    expect(await refreshTarget(response)).toBe("https://platform.example.com/reset-password?lang=en");
    // The first token is the one moved; the session cookies of the refresh are set next to it.
    expect(setCookies(response).map((line) => line.slice(0, line.indexOf("=")))).toEqual([
      "__Host-vxp_reset",
      "__Host-vxp_at",
      "__Host-vxp_rt",
    ]);
    expect(setCookies(response)[0]).toContain(`__Host-vxp_reset=${RESET_TOKEN};`);
  });

  it("deletes an older reset cookie for an empty or over-long token, so the page says the link is no good", async () => {
    for (const token of ["", "x".repeat(513)]) {
      const response = await middleware(
        request(`/reset-password?token=${token}`, { cookies: { "__Host-vxp_reset": RESET_TOKEN } }),
      );

      expect(response.status).toBe(200);
      expect(await refreshTarget(response)).toBe("https://platform.example.com/reset-password");
      expect(setCookies(response)).toEqual([
        "__Host-vxp_reset=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=strict",
      ]);
    }
  });

  it("escapes the other query parameters it keeps, so a crafted link cannot add markup to the page", async () => {
    const crafted = `"><script>alert(1)</script><a href='x`;
    const response = await middleware(
      request(`/reset-password?lang=en&next=${encodeURIComponent(crafted)}&token=${RESET_TOKEN}`),
    );

    const html = await response.clone().text();
    expect(html).not.toMatch(/<script/i);
    expect(html.match(/<a /g)).toHaveLength(1);
    // Two parameters: the `&` between them is written as `&amp;` in the attributes.
    expect(html).toContain("reset-password?lang=en&amp;next=");
    const target = new URL(await refreshTarget(response));
    expect(`${target.origin}${target.pathname}`).toBe("https://platform.example.com/reset-password");
    expect([...target.searchParams]).toEqual([
      ["lang", "en"],
      ["next", crafted],
    ]);
  });

  it("leaves a POST (the form's server action) and other pages with ?token= alone", async () => {
    const post = await middleware(
      new NextRequest(new URL(`/reset-password?token=${RESET_TOKEN}`, "http://127.0.0.1:3000"), {
        method: "POST",
      }),
    );
    const other = await middleware(request(`/sign-in?token=${RESET_TOKEN}`));

    expect(isPassedThrough(post)).toBe(true);
    expect(isPassedThrough(other)).toBe(true);
    expect(setCookies(post)).toEqual([]);
    expect(setCookies(other)).toEqual([]);
  });
});

describe("request id", () => {
  it("keeps a valid X-Request-Id and creates one when there is none", async () => {
    const kept = await middleware(request("/", { headers: { "X-Request-Id": "req_from_caddy_0001" } }));
    const created = await middleware(request("/", { headers: { "X-Request-Id": "no" } }));

    expect(forwardedHeader(kept, "x-request-id")).toBe("req_from_caddy_0001");
    expect(forwardedHeader(created, "x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("matcher", () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);

  it("runs on pages, route handlers and server actions", () => {
    for (const path of [
      "/",
      "/dashboard",
      "/sign-in",
      "/otas/ten_1/console/launch",
      "/sign-out",
      "/verify-email",
    ]) {
      expect(matcher.test(path), path).toBe(true);
    }
  });

  it("skips static files and the health routes", () => {
    for (const path of [
      "/_next/static/chunks/main.js",
      "/_next/image",
      "/favicon.ico",
      "/health/live",
      "/health/ready",
    ]) {
      expect(matcher.test(path), path).toBe(false);
    }
  });

  it("runs in the Node.js runtime, where the single-flight map lives in the portal process", () => {
    expect(config.runtime).toBe("nodejs");
  });
});
