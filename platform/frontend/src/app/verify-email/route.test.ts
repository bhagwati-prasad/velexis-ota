import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import loadCustomRoutes from "next/dist/lib/load-custom-routes";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";
import { NextRequest, type NextResponse } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  APP_ENV: "production" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
}));

vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import nextConfig from "../../../next.config";
import * as routeModule from "./route";
import { GET } from "./route";

/** A verification token as the e-mail carries it: 43 base64url characters (a dummy, never a real one). */
const TOKEN = "Vf3kQ9mZ2xT7bN4cR8wL1pY6hD5sJ0aE2gU9iO3qK7v";

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

let counter = 0;
/** A refresh token no other test uses: the single-flight map of `lib/session.ts` lives for the whole file. */
function uniqueRefreshToken(): string {
  counter += 1;
  return `refresh-token-${counter}-${Math.random().toString(36).slice(2)}`;
}

function verifyRequest(
  query: string,
  init: { cookies?: Record<string, string>; headers?: Record<string, string> } = {},
): NextRequest {
  const headers = new Headers({
    "x-forwarded-for": "198.51.100.7",
    "user-agent": "Mozilla/5.0 (PFE-005 test)",
    "x-request-id": "req_pfe005_verify_email",
    ...init.headers,
  });
  const cookies = Object.entries(init.cookies ?? {}).map(([name, value]) => `${name}=${value}`);
  if (cookies.length > 0) {
    headers.set("cookie", cookies.join("; "));
  }
  return new NextRequest(new URL(`/verify-email${query}`, "http://127.0.0.1:3000"), { headers });
}

function errorAnswer(code: string, status: number): Response {
  return Response.json({ error: { code, message: "ignored", status, requestId: "req_api" } }, { status });
}

function verifiedAnswer(): Response {
  return Response.json({
    accountId: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
    email: "anna.berg@example.com",
    emailVerified: true,
  });
}

function sessionAnswer(emailVerified: boolean): Response {
  return Response.json({
    accessToken: "renewed-access-token",
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: "rotated-refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
    account: { id: "acc_01JA2Z9W5K7Q3M8N4P6R2T0V1X", emailVerified },
  });
}

/** Answers the API calls by path: verify-email first, then (for a signed-in visitor) refresh. */
function api(answers: { verify: () => Response; refresh?: () => Response }): void {
  fetchMock.mockImplementation((input) => {
    const { pathname } = new URL(input.url);
    if (pathname === "/v1/auth/verify-email") {
      return Promise.resolve(answers.verify());
    }
    if (pathname === "/v1/auth/refresh" && answers.refresh !== undefined) {
      return Promise.resolve(answers.refresh());
    }
    return Promise.reject(new Error(`unexpected call ${input.method} ${pathname}`));
  });
}

function calls(path: string): Request[] {
  return fetchMock.mock.calls.map(([input]) => input).filter((input) => new URL(input.url).pathname === path);
}

/** Asserts the clean-URL redirect of PF-02 AC1 and returns the `Location`. */
function expectCleanRedirect(response: NextResponse): string {
  expect(response.status).toBe(303);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const location = response.headers.get("location") ?? "";
  expect(location).not.toContain(TOKEN);
  expect(location).not.toContain("token=");
  return location;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("GET /verify-email", () => {
  it("[PFE-005 AC2] verifies the token on the server and answers 303 to /sign-in?verified=1 without the token, with Referrer-Policy: no-referrer", async () => {
    api({ verify: verifiedAnswer });

    const response = await GET(verifyRequest(`?token=${TOKEN}`));

    expect(expectCleanRedirect(response)).toBe("https://platform.example.com/sign-in?verified=1");
    expect(response.headers.getSetCookie()).toEqual([]);
    const [call, ...others] = calls("/v1/auth/verify-email");
    expect(others).toEqual([]);
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("http://127.0.0.1:3100/v1/auth/verify-email");
    expect(await call?.json()).toEqual({ token: TOKEN });
    // A public call: the end-user headers of PADR-0019 and the request id, never a bearer token.
    expect(call?.headers.get("x-velexis-end-user-ip")).toBe("198.51.100.7");
    expect(call?.headers.get("x-velexis-end-user-agent")).toBe("Mozilla/5.0 (PFE-005 test)");
    expect(call?.headers.get("x-velexis-bff-key")).toBe(settings.PLATFORM_BFF_KEY);
    expect(call?.headers.get("x-request-id")).toBe("req_pfe005_verify_email");
    expect(call?.headers.get("authorization")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("[PFE-005 AC2] renews the session of a signed-in visitor, so it reaches /dashboard with a token that says verified", async () => {
    const refreshToken = uniqueRefreshToken();
    api({ verify: verifiedAnswer, refresh: () => sessionAnswer(true) });

    const response = await GET(
      verifyRequest(`?token=${TOKEN}`, {
        cookies: { "__Host-vxp_at": "unverified-access-token", "__Host-vxp_rt": refreshToken },
      }),
    );

    expect(expectCleanRedirect(response)).toBe("https://platform.example.com/dashboard");
    // The token is consumed before the session is renewed: the renewed access token carries `ev: true`.
    expect(fetchMock.mock.calls.map(([input]) => new URL(input.url).pathname)).toEqual([
      "/v1/auth/verify-email",
      "/v1/auth/refresh",
    ]);
    expect(await calls("/v1/auth/refresh")[0]?.json()).toEqual({ refreshToken });
    expect(calls("/v1/auth/verify-email")[0]?.headers.get("authorization")).toBeNull();
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^__Host-vxp_at=renewed-access-token; Path=\/; /);
    expect(cookies[1]).toMatch(/^__Host-vxp_rt=rotated-refresh-token; Path=\/; /);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; SameSite=lax/i);
    }
  });

  it("keeps a signed-in account that is still unverified (another account's link) on /verify-pending", async () => {
    api({ verify: verifiedAnswer, refresh: () => sessionAnswer(false) });

    const response = await GET(
      verifyRequest(`?token=${TOKEN}`, { cookies: { "__Host-vxp_rt": uniqueRefreshToken() } }),
    );

    expect(expectCleanRedirect(response)).toBe("https://platform.example.com/verify-pending");
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("sends a session that can no longer be renewed to sign-in and deletes its cookies", async () => {
    api({ verify: verifiedAnswer, refresh: () => errorAnswer("REFRESH_TOKEN_INVALID", 401) });

    const response = await GET(
      verifyRequest(`?token=${TOKEN}`, { cookies: { "__Host-vxp_rt": uniqueRefreshToken() } }),
    );

    expect(expectCleanRedirect(response)).toBe("https://platform.example.com/sign-in?verified=1");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^__Host-vxp_at=; Path=\/; Max-Age=0; /);
    expect(cookies[1]).toMatch(/^__Host-vxp_rt=; Path=\/; Max-Age=0; /);
  });

  it("keeps the session when renewing it fails for a moment, and lets /verify-pending offer to continue", async () => {
    api({ verify: verifiedAnswer, refresh: () => errorAnswer("SERVICE_UNAVAILABLE", 503) });

    const response = await GET(
      verifyRequest(`?token=${TOKEN}`, { cookies: { "__Host-vxp_rt": uniqueRefreshToken() } }),
    );

    expect(expectCleanRedirect(response)).toBe("https://platform.example.com/verify-pending");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    ["an expired, used or unknown token", "VERIFICATION_TOKEN_INVALID", 400],
    ["a token the API refuses as malformed", "VALIDATION_FAILED", 400],
  ])("[PFE-005 AC2] sends %s to /verify-pending?error=token", async (_case, code, status) => {
    api({ verify: () => errorAnswer(code, status) });

    const response = await GET(verifyRequest(`?token=${TOKEN}`));

    expect(expectCleanRedirect(response)).toBe("https://platform.example.com/verify-pending?error=token");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    ["the rate limit", () => errorAnswer("RATE_LIMITED", 429)],
    ["an API error", () => errorAnswer("INTERNAL_ERROR", 500)],
    ["an unavailable API", () => new Response("Bad Gateway", { status: 502 })],
  ])("reports %s as a link that could not be checked yet, not as an invalid one", async (_case, answer) => {
    api({ verify: answer });

    const response = await GET(
      verifyRequest(`?token=${TOKEN}`, { cookies: { "__Host-vxp_rt": uniqueRefreshToken() } }),
    );

    expect(expectCleanRedirect(response)).toBe(
      "https://platform.example.com/verify-pending?error=unavailable",
    );
    // Nothing was verified, so the session is not touched.
    expect(calls("/v1/auth/refresh")).toEqual([]);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    ["no token", ""],
    ["an empty token", "?token="],
    ["a token longer than any Velexis issues", `?token=${"a".repeat(513)}`],
  ])(
    "[PFE-005 AC2] sends %s to /verify-pending?error=token without calling the API",
    async (_case, query) => {
      const response = await GET(verifyRequest(query));

      expect(expectCleanRedirect(response)).toBe("https://platform.example.com/verify-pending?error=token");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("[PFE-005 AC2] redirects to the portal's public URL, whatever host the request reached", async () => {
    api({ verify: verifiedAnswer });

    const response = await GET(verifyRequest(`?token=${TOKEN}`, { headers: { host: "evil.example" } }));

    expect(new URL(expectCleanRedirect(response)).origin).toBe("https://platform.example.com");
  });

  it("answers HEAD with 204 without calling the API, so a link checker cannot use up the token", async () => {
    api({ verify: verifiedAnswer });
    // The handlers as Next.js dispatches them: a route module without its own HEAD would answer HEAD with GET.
    const methods = autoImplementMethods(routeModule);
    expect(methods.HEAD).not.toBe(GET);

    const response = (await methods.HEAD(
      verifyRequest(`?token=${TOKEN}`, { cookies: { "__Host-vxp_rt": uniqueRefreshToken() } }),
      {},
    )) as NextResponse;

    expect(response.status).toBe(204);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The headers of next.config.ts that Next.js sets on the response for `path` before the route handler runs: the
 * rules loaded and compiled to the regular expressions `next build` writes to routes-manifest.json. Next.js keeps
 * these over a handler's own value of the same header (it appends a handler header only when it is absent), so
 * they are what reaches the browser.
 */
let staticHeadersFor: (path: string) => Headers;

beforeAll(async () => {
  const { headers: rules } = await loadCustomRoutes(nextConfig);
  const compiled = rules.map((rule) => ({ regex: new RegExp(buildCustomRoute("header", rule).regex), rule }));
  staticHeadersFor = (path) => {
    const headers = new Headers();
    for (const { regex, rule } of compiled) {
      if (regex.test(path)) {
        for (const { key, value } of rule.headers) {
          headers.set(key, value);
        }
      }
    }
    return headers;
  };
}, 30_000); // Loading next.config.ts through Next.js's own loader is the expensive step of this block.

describe("next.config.ts headers of the token page", () => {
  it("[PFE-005 AC2] serves /verify-email with Referrer-Policy: no-referrer, which Next.js keeps over the handler's", async () => {
    api({ verify: verifiedAnswer });
    const handler = await GET(verifyRequest(`?token=${TOKEN}`));

    // What the browser gets: the configured headers first, then the handler's headers that are not set yet.
    const sent = staticHeadersFor("/verify-email");
    handler.headers.forEach((value, name) => {
      if (!sent.has(name)) {
        sent.set(name, value);
      }
    });

    expect(sent.get("referrer-policy")).toBe("no-referrer");
    expect(sent.get("x-content-type-options")).toBe("nosniff");
    expect(sent.get("location")).toBe("https://platform.example.com/sign-in?verified=1");
  });

  it("keeps strict-origin-when-cross-origin on the other pages", () => {
    for (const path of ["/", "/sign-up", "/sign-up/check-email", "/verify-pending", "/verify-email/x"]) {
      expect(staticHeadersFor(path).get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    }
  });
});
