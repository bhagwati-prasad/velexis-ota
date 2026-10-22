import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PermissionError } from "@velexis/ota-sdk";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  TEST_PORTAL_URL,
  apiError,
  fakeOtaApi,
  fakeRedirect,
  rateLimited,
  redirectOf,
  staffAccessToken,
  staffProfile,
  staffSession,
  type FakeOtaApi,
} from "@/test/fake-ota-api";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", () => ({ redirect: vi.fn(fakeRedirect) }));

import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  COOKIE_MAX_AGE,
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
  accessTokenExpiry,
  accessTokenNeedsRefresh,
  allowedEnvironment,
  clearStaffSession,
  clearedSessionCookies,
  environmentCookie,
  portalConsoleUrl,
  readSession,
  readSessionCookies,
  redirectOnSessionError,
  refreshPath,
  requireStaff,
  safeNextPath,
  setStaffSession,
  staffSessionCookies,
  writeCookies,
} from "./session";

const PORTAL_CONSOLE = `${TEST_PORTAL_URL}/console`;
const PORTAL_CONSOLE_OF_TENANT = `${PORTAL_CONSOLE}?tenant=${TENANT_ID}`;

/** A refresh token no other test uses: the process-wide de-duplication map outlives each test. */
let tokenSequence = 0;
function uniqueRefreshToken(): string {
  tokenSequence += 1;
  return `staff-refresh-token-session-test-${tokenSequence}-${Date.now()}`;
}

/** The `Set-Cookie` lines of `writes` as Next.js writes them on a response. */
function setCookieLines(writes: Parameters<typeof writeCookies>[1]): string[] {
  const response = NextResponse.next();
  writeCookies(response.cookies, writes);
  return response.headers.getSetCookie();
}

describe("session cookies", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");

  it("sets the four __Host- cookies of OADR-0018 point 2: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain", () => {
    const lines = setCookieLines(staffSessionCookies(staffSession(now), { environment: "live", now }));

    expect(lines.map((line) => line.split("=")[0])).toEqual([
      "__Host-vx_staff_at",
      "__Host-vx_staff_rt",
      "__Host-vx_env",
      "__Host-vx_tenant",
    ]);
    for (const line of lines) {
      const attributes = line.split(";").map((part) => part.trim().toLowerCase());
      expect(attributes).toEqual(expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/"]));
      expect(attributes.some((attribute) => attribute.startsWith("domain="))).toBe(false);
    }
  });

  it("keeps each token as long as it is valid, the environment and the tenant for 12 hours", () => {
    const writes = staffSessionCookies(staffSession(now), { environment: "live", now });

    expect(writes.map((write) => [write.name, write.value, write.options.maxAge])).toEqual([
      [STAFF_ACCESS_TOKEN_COOKIE, staffSession(now).session.accessToken, 900],
      [STAFF_REFRESH_TOKEN_COOKIE, "staff-refresh-token-rotated", 11 * 3600],
      [ENVIRONMENT_COOKIE, "live", 12 * 3600],
      [TENANT_COOKIE, TENANT_ID, 12 * 3600],
    ]);
    expect(COOKIE_MAX_AGE).toEqual({
      [STAFF_ACCESS_TOKEN_COOKIE]: 900,
      [STAFF_REFRESH_TOKEN_COOKIE]: 12 * 3600,
      [ENVIRONMENT_COOKIE]: 12 * 3600,
      [TENANT_COOKIE]: 12 * 3600,
    });
  });

  it("never lets a cookie outlive its maximum, even when the API's expiry is later or unreadable", () => {
    const result = staffSession(now);
    const late = {
      ...result,
      session: {
        ...result.session,
        accessTokenExpiresAt: new Date(now + 3600_000).toISOString(),
        refreshTokenExpiresAt: "not a time",
      },
    };

    const [access, refresh] = staffSessionCookies(late, { now });

    expect(access?.options.maxAge).toBe(900);
    expect(refresh?.options.maxAge).toBe(12 * 3600);
  });

  it("keeps the environment only when the session allows it (OADR-0018 point 6)", () => {
    const testOnly = staffSession(now, { environments: ["test"] });

    expect(staffSessionCookies(testOnly, { environment: "live", now })[2]?.value).toBe("test");
    expect(staffSessionCookies(staffSession(now), { now })[2]?.value).toBe("test");
    expect(allowedEnvironment("live", ["test", "live"])).toBe("live");
    expect(allowedEnvironment("live", ["test"])).toBe("test");
    expect(allowedEnvironment(undefined, ["test", "live"])).toBe("test");
    expect(environmentCookie("live")).toMatchObject({ name: ENVIRONMENT_COOKIE, value: "live" });
  });

  it("clears the tokens and the environment with Max-Age=0 and the same attributes, and keeps the tenant", () => {
    const lines = setCookieLines(clearedSessionCookies());

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.split(";")[0])).toEqual([
      "__Host-vx_staff_at=",
      "__Host-vx_staff_rt=",
      "__Host-vx_env=",
    ]);
    for (const line of lines) {
      expect(line.toLowerCase()).toContain("max-age=0");
      expect(line.toLowerCase()).toContain("secure");
      expect(line.toLowerCase()).toContain("path=/");
    }
  });

  it("reads the session cookies; an empty or unknown value counts as absent", () => {
    expect(
      readSessionCookies(
        new CookieJar({
          [STAFF_ACCESS_TOKEN_COOKIE]: "at",
          [STAFF_REFRESH_TOKEN_COOKIE]: "rt",
          [ENVIRONMENT_COOKIE]: "live",
          [TENANT_COOKIE]: TENANT_ID,
        }),
      ),
    ).toEqual({ accessToken: "at", refreshToken: "rt", environment: "live", tenantId: TENANT_ID });
    expect(
      readSessionCookies(
        new CookieJar({
          [STAFF_ACCESS_TOKEN_COOKIE]: "",
          [ENVIRONMENT_COOKIE]: "LIVE",
          [TENANT_COOKIE]: "ten_x/../evil",
        }),
      ),
    ).toEqual({ environment: "test" });
  });

  it("writes and clears the cookies through cookies() in actions and route handlers", async () => {
    const jar = new CookieJar();
    nextHeaders.cookies.mockResolvedValue(jar);

    await setStaffSession(staffSession(Date.now()), "live");
    await clearStaffSession();

    expect(jar.writes.map((write) => [write.name, write.options["maxAge"] === 0])).toEqual([
      [STAFF_ACCESS_TOKEN_COOKIE, false],
      [STAFF_REFRESH_TOKEN_COOKIE, false],
      [ENVIRONMENT_COOKIE, false],
      [TENANT_COOKIE, false],
      [STAFF_ACCESS_TOKEN_COOKIE, true],
      [STAFF_REFRESH_TOKEN_COOKIE, true],
      [ENVIRONMENT_COOKIE, true],
    ]);
    expect(jar.get(TENANT_COOKIE)?.value).toBe(TENANT_ID);
  });
});

describe("access token expiry", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");

  it("reads the exp claim without checking the signature", () => {
    expect(accessTokenExpiry(staffAccessToken("a", now, 900))).toBe(now + 900_000);
    expect(accessTokenExpiry("not-a-jwt")).toBeUndefined();
    expect(accessTokenExpiry("a.%%%.c")).toBeUndefined();
    expect(accessTokenExpiry(`a.${Buffer.from("{}").toString("base64url")}.c`)).toBeUndefined();
  });

  it("refreshes a token that is missing, unreadable or expires within 60 seconds", () => {
    expect(ACCESS_TOKEN_REFRESH_MARGIN_MS).toBe(60_000);
    expect(accessTokenNeedsRefresh(staffAccessToken("a", now, 61), now)).toBe(false);
    expect(accessTokenNeedsRefresh(staffAccessToken("a", now, 60), now)).toBe(true);
    expect(accessTokenNeedsRefresh(staffAccessToken("a", now, -5), now)).toBe(true);
    expect(accessTokenNeedsRefresh("not-a-jwt", now)).toBe(true);
    expect(accessTokenNeedsRefresh(undefined, now)).toBe(true);
  });
});

describe("redirects", () => {
  beforeEach(() => {
    nextHeaders.cookies.mockResolvedValue(new CookieJar());
  });

  it("sends people without a session to the portal's console page, naming the tenant when it is known", async () => {
    nextHeaders.cookies.mockResolvedValue(new CookieJar({ [TENANT_COOKIE]: TENANT_ID }));
    expect(await redirectOf(() => readSession())).toBe(PORTAL_CONSOLE_OF_TENANT);

    nextHeaders.cookies.mockResolvedValue(new CookieJar());
    expect(await redirectOf(() => readSession())).toBe(PORTAL_CONSOLE);
  });

  it("builds the portal URL from PUBLIC_PORTAL_URL and drops a tenant that is not a tenant id", () => {
    expect(portalConsoleUrl("https://platform.example.com/", TENANT_ID)).toBe(
      `https://platform.example.com/console?tenant=${TENANT_ID}`,
    );
    expect(portalConsoleUrl("https://platform.example.com", "ten_1&next=https://evil.example")).toBe(
      "https://platform.example.com/console",
    );
  });

  it("keeps only relative return paths for /auth/refresh", () => {
    expect(refreshPath("/bookings?status=pending#top")).toBe(
      `/auth/refresh?next=${encodeURIComponent("/bookings?status=pending#top")}`,
    );
    for (const unsafe of [
      "https://evil.example/x",
      "//evil.example",
      "/\\evil.example",
      "bookings",
      "/a\nb",
      "",
      // Dot segments that the URL parser normalises to a protocol-relative `//evil.example`.
      "/.//evil.example",
      "/bookings/..//evil.example",
      "/%2e//evil.example",
      "/%2E%2E//evil.example?x=1#y",
    ]) {
      expect(safeNextPath(unsafe), unsafe).toBeUndefined();
      expect(refreshPath(unsafe)).toBe("/auth/refresh");
    }
    expect(refreshPath()).toBe("/auth/refresh");
    // Dot segments that stay on the admin are kept, normalised; an encoded slash is a path character.
    expect(safeNextPath("/bookings/../queues?x=1")).toBe("/queues?x=1");
    expect(safeNextPath("/%2Fevil.example")).toBe("/%2Fevil.example");
  });

  it("sends an expired access token to /auth/refresh and an ended session to the portal; other errors pass", async () => {
    nextHeaders.cookies.mockResolvedValue(new CookieJar({ [TENANT_COOKIE]: TENANT_ID }));

    expect(await redirectOf(() => redirectOnSessionError({ code: "TOKEN_EXPIRED" }, "/queues"))).toBe(
      "/auth/refresh?next=%2Fqueues",
    );
    for (const code of [
      "UNAUTHENTICATED",
      "REFRESH_TOKEN_INVALID",
      "REFRESH_TOKEN_REUSED",
      "STAFF_MEMBERSHIP_INACTIVE",
    ]) {
      expect(await redirectOf(() => redirectOnSessionError({ code })), code).toBe(PORTAL_CONSOLE_OF_TENANT);
    }
    const other = { code: "TENANT_SUSPENDED" };
    await expect(redirectOnSessionError(other)).rejects.toBe(other);
  });
});

describe("requireStaff", () => {
  let api: FakeOtaApi;
  let jar: CookieJar;

  /** The cookies of a request whose access token expires in `seconds`. */
  function signedIn(
    seconds: number,
    extra: Record<string, string> = {},
  ): { refreshToken: string; accessToken: string } {
    const refreshToken = uniqueRefreshToken();
    const accessToken = staffAccessToken(refreshToken, Date.now(), seconds);
    jar = new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: accessToken,
      [STAFF_REFRESH_TOKEN_COOKIE]: refreshToken,
      [ENVIRONMENT_COOKIE]: "live",
      [TENANT_COOKIE]: TENANT_ID,
      ...extra,
    });
    nextHeaders.cookies.mockResolvedValue(jar);
    return { refreshToken, accessToken };
  }

  beforeEach(() => {
    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    nextHeaders.headers.mockResolvedValue(
      new Headers({ "X-Forwarded-For": "203.0.113.7", "User-Agent": "Mozilla/5.0 Test" }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls console.auth.me with the session's token and environment and hands out the console client", async () => {
    const { accessToken } = signedIn(900);

    const context = await requireStaff("bookings:issue");

    expect(context.staff).toEqual(staffProfile());
    expect(context.environment).toBe("live");
    expect(api.requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "GET /v1/console/auth/me",
    ]);
    expect(api.requests[0]?.headers.get("Authorization")).toBe(`Bearer ${accessToken}`);
    expect(api.requests[0]?.headers.get("X-Velexis-Environment")).toBe("live");
    expect(jar.writes).toEqual([]);

    await context.console.bookings.list({ limit: 1 }).catch(() => undefined);
    expect(api.requests[1]?.headers.get("Authorization")).toBe(`Bearer ${accessToken}`);
  });

  it("refuses a missing permission with FORBIDDEN and details.requiredPermission before any other call", async () => {
    signedIn(900);
    api.on("GET /v1/console/auth/me", () =>
      Response.json(staffProfile({ role: "viewer", environments: ["test"] })),
    );

    const refusal = await requireStaff("bookings:issue").catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(PermissionError);
    expect(refusal).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
      details: { requiredPermission: "bookings:issue" },
    });
    expect(api.requests.map((request) => request.url.pathname)).toEqual(["/v1/console/auth/me"]);
  });

  it("refreshes an access token that expires within 60 s, writes the new cookies and uses the new token", async () => {
    const { refreshToken } = signedIn(30);
    const rotated = staffSession(Date.now(), { accessToken: staffAccessToken("new", Date.now(), 900) });
    api.on("POST /v1/console/auth/refresh", () => Response.json(rotated));

    const context = await requireStaff("bookings:read");

    expect(api.requests.map((request) => request.url.pathname)).toEqual([
      "/v1/console/auth/refresh",
      "/v1/console/auth/me",
    ]);
    expect(api.requests[0]?.body).toEqual({ refreshToken });
    expect(api.requests[1]?.headers.get("Authorization")).toBe(`Bearer ${rotated.session.accessToken}`);
    expect(jar.writes.map((write) => [write.name, write.value])).toEqual([
      [STAFF_ACCESS_TOKEN_COOKIE, rotated.session.accessToken],
      [STAFF_REFRESH_TOKEN_COOKIE, rotated.session.refreshToken],
      [ENVIRONMENT_COOKIE, "live"],
      [TENANT_COOKIE, TENANT_ID],
    ]);
    expect(context.environment).toBe("live");
  });

  it("refreshes when the access cookie is gone, and falls back to test when live is no longer allowed", async () => {
    signedIn(900);
    jar.entries.delete(STAFF_ACCESS_TOKEN_COOKIE);
    api.on("POST /v1/console/auth/refresh", () =>
      Response.json(staffSession(Date.now(), { environments: ["test"] })),
    );

    const context = await requireStaff("bookings:read");

    expect(context.environment).toBe("test");
    expect(jar.get(ENVIRONMENT_COOKIE)?.value).toBe("test");
    expect(api.sent("GET /v1/console/auth/me")[0]?.headers.get("X-Velexis-Environment")).toBe("test");
  });

  it("[OAD-002 AC1] parallel server actions with the same expiring token refresh once and share the new tokens", async () => {
    signedIn(30);
    const rotated = staffSession(Date.now(), { accessToken: staffAccessToken("shared", Date.now(), 900) });
    api.on("POST /v1/console/auth/refresh", () => Response.json(rotated));

    await Promise.all([
      requireStaff("bookings:read"),
      requireStaff("bookings:read"),
      requireStaff("queues:read"),
    ]);

    expect(api.sent("POST /v1/console/auth/refresh")).toHaveLength(1);
    const bearers = api
      .sent("GET /v1/console/auth/me")
      .map((request) => request.headers.get("Authorization"));
    expect(bearers).toEqual(Array(3).fill(`Bearer ${rotated.session.accessToken}`));
  });

  it("clears the session and goes to the portal when the refresh token can never work again", async () => {
    signedIn(30);
    api.on("POST /v1/console/auth/refresh", () => apiError("REFRESH_TOKEN_REUSED", 401));

    expect(await redirectOf(() => requireStaff("bookings:read"))).toBe(PORTAL_CONSOLE_OF_TENANT);
    expect(jar.writes.map((write) => [write.name, write.value, write.options["maxAge"]])).toEqual([
      [STAFF_ACCESS_TOKEN_COOKIE, "", 0],
      [STAFF_REFRESH_TOKEN_COOKIE, "", 0],
      [ENVIRONMENT_COOKIE, "", 0],
    ]);
    expect(api.sent("GET /v1/console/auth/me")).toEqual([]);
  });

  it("goes on with a still valid access token when the refresh fails for a reason that may pass", async () => {
    const { accessToken } = signedIn(30);
    api.on("POST /v1/console/auth/refresh", rateLimited);

    await requireStaff("bookings:read");

    expect(api.sent("GET /v1/console/auth/me")[0]?.headers.get("Authorization")).toBe(
      `Bearer ${accessToken}`,
    );
    expect(jar.writes).toEqual([]);
  });

  it("throws the refresh failure when no usable access token is left", async () => {
    signedIn(-5);
    api.on("POST /v1/console/auth/refresh", rateLimited);

    await expect(requireStaff("bookings:read")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(api.sent("GET /v1/console/auth/me")).toEqual([]);
  });

  it("goes to the portal without any session cookie, and when an expired token has no refresh token", async () => {
    jar = new CookieJar();
    nextHeaders.cookies.mockResolvedValue(jar);
    expect(await redirectOf(() => requireStaff("bookings:read"))).toBe(PORTAL_CONSOLE);

    signedIn(-5);
    jar.entries.delete(STAFF_REFRESH_TOKEN_COOKIE);
    expect(await redirectOf(() => requireStaff("bookings:read"))).toBe(PORTAL_CONSOLE_OF_TENANT);
    expect(api.requests).toEqual([]);
  });

  it("clears the session when the API says it ended, and passes other refusals on", async () => {
    signedIn(900);
    api.on("GET /v1/console/auth/me", () => apiError("UNAUTHENTICATED", 401));
    expect(await redirectOf(() => requireStaff("bookings:read"))).toBe(PORTAL_CONSOLE_OF_TENANT);
    expect(jar.writes.map((write) => write.name)).toEqual([
      STAFF_ACCESS_TOKEN_COOKIE,
      STAFF_REFRESH_TOKEN_COOKIE,
      ENVIRONMENT_COOKIE,
    ]);

    signedIn(900);
    api.on("GET /v1/console/auth/me", () => apiError("ENVIRONMENT_NOT_ALLOWED", 403));
    await expect(requireStaff("bookings:read")).rejects.toMatchObject({ code: "ENVIRONMENT_NOT_ALLOWED" });
    expect(jar.writes).toEqual([]);
  });
});

describe("module boundaries", () => {
  it.each(["session.ts", "velexis.ts", "refresh-dedup.ts"])("%s is a server-only module", (file) => {
    const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");

    expect(source).toMatch(/^import "server-only";$/m);
  });
});
