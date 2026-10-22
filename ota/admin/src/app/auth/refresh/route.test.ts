import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TENANT_ID,
  TEST_CONFIG,
  TEST_PORTAL_URL,
  apiError,
  deferred,
  fakeOtaApi,
  rateLimited,
  staffAccessToken,
  staffSession,
  type FakeOtaApi,
} from "@/test/fake-ota-api";

vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));

import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import { GET } from "./route";

const REFRESH_ROUTE = "POST /v1/console/auth/refresh";
const ADMIN = "http://localhost:3002";
const PORTAL_CONSOLE_OF_TENANT = `${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`;

let tokenSequence = 0;
/** A refresh token no other test uses: the process-wide de-duplication map outlives each test. */
function uniqueRefreshToken(): string {
  tokenSequence += 1;
  return `staff-refresh-token-refresh-route-test-${tokenSequence}-${Date.now()}`;
}

/** A server component's redirect to `/auth/refresh` with `query`, carrying `cookies`. */
function refreshRequest(query: string, cookies: Record<string, string>): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new NextRequest(`${ADMIN}/auth/refresh${query}`, {
    headers: { Cookie: cookie, "X-Forwarded-For": "203.0.113.7" },
  });
}

function signedIn(): Record<string, string> {
  return {
    [STAFF_ACCESS_TOKEN_COOKIE]: "an-access-token-the-api-called-expired",
    [STAFF_REFRESH_TOKEN_COOKIE]: uniqueRefreshToken(),
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

let api: FakeOtaApi;

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /auth/refresh", () => {
  it("refreshes, writes the four cookies and goes back to the safe next path", async () => {
    const cookies = signedIn();
    const rotated = staffSession(Date.now());
    api.on(REFRESH_ROUTE, () => Response.json(rotated));

    const response = await GET(
      refreshRequest(`?next=${encodeURIComponent("/bookings?status=pending")}`, cookies),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${ADMIN}/bookings?status=pending`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(api.sent(REFRESH_ROUTE)[0]?.body).toEqual({ refreshToken: cookies[STAFF_REFRESH_TOKEN_COOKIE] });
    expect(api.sent(REFRESH_ROUTE)[0]?.headers.get("X-Velexis-End-User-IP")).toBe("203.0.113.7");
    expect(setCookies(response).map(([name, value]) => [name, value])).toEqual([
      [STAFF_ACCESS_TOKEN_COOKIE, rotated.session.accessToken],
      [STAFF_REFRESH_TOKEN_COOKIE, rotated.session.refreshToken],
      [ENVIRONMENT_COOKIE, "live"],
      [TENANT_COOKIE, TENANT_ID],
    ]);
  });

  it("refreshes even when the access token looks fresh, so the page never comes back with the refused one", async () => {
    // The page came here because the API answered TOKEN_EXPIRED for this token (clock skew, a revoked key): going back
    // without a new token would only bring it here again.
    const cookies = {
      ...signedIn(),
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken("looks-fresh", Date.now(), 600),
    };
    const rotated = staffSession(Date.now());
    api.on(REFRESH_ROUTE, () => Response.json(rotated));

    const response = await GET(refreshRequest("?next=%2Fbookings", cookies));

    expect(api.sent(REFRESH_ROUTE)).toHaveLength(1);
    expect(response.headers.get("Location")).toBe(`${ADMIN}/bookings`);
    expect(setCookies(response).find(([name]) => name === STAFF_ACCESS_TOKEN_COOKIE)?.[1]).toBe(
      rotated.session.accessToken,
    );
  });

  it("goes to the dashboard when next is missing or not a relative path on the admin", async () => {
    for (const query of [
      "",
      "?next=https%3A%2F%2Fevil.example%2Fx",
      "?next=%2F%2Fevil.example",
      "?next=%2F.%2F%2Fevil.example",
      "?next=%2F%5Cevil.example",
      "?next=bookings",
    ]) {
      const response = await GET(refreshRequest(query, signedIn()));
      expect(response.headers.get("Location"), query).toBe(`${ADMIN}/`);
    }
  });

  it("makes one call for parallel redirects with the same token", async () => {
    const cookies = signedIn();
    const answer = deferred<Response>();
    api.on(REFRESH_ROUTE, () => answer.promise);

    const pending = [
      GET(refreshRequest("?next=%2Fqueues", cookies)),
      GET(refreshRequest("?next=%2F", cookies)),
    ];
    await vi.waitFor(() => expect(api.sent(REFRESH_ROUTE)).toHaveLength(1));
    answer.resolve(Response.json(staffSession(Date.now(), { refreshToken: "staff-refresh-token-shared" })));
    const responses = await Promise.all(pending);

    expect(api.sent(REFRESH_ROUTE)).toHaveLength(1);
    for (const response of responses) {
      expect(setCookies(response).find(([name]) => name === STAFF_REFRESH_TOKEN_COOKIE)?.[1]).toBe(
        "staff-refresh-token-shared",
      );
    }
  });

  it("clears the session and goes to the portal when the refresh is refused for good", async () => {
    api.on(REFRESH_ROUTE, () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));

    const response = await GET(refreshRequest("?next=%2Fbookings", signedIn()));

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(PORTAL_CONSOLE_OF_TENANT);
    expect(setCookies(response)).toEqual([
      [STAFF_ACCESS_TOKEN_COOKIE, "", "0"],
      [STAFF_REFRESH_TOKEN_COOKIE, "", "0"],
      [ENVIRONMENT_COOKIE, "", "0"],
    ]);
  });

  it("goes to the portal without a refresh token", async () => {
    const cookies = Object.fromEntries(
      Object.entries(signedIn()).filter(([name]) => name !== STAFF_REFRESH_TOKEN_COOKIE),
    );

    const response = await GET(refreshRequest("?next=%2Fbookings", cookies));

    expect(response.headers.get("Location")).toBe(PORTAL_CONSOLE_OF_TENANT);
    expect(setCookies(response).map(([name]) => name)).toEqual([
      STAFF_ACCESS_TOKEN_COOKIE,
      STAFF_REFRESH_TOKEN_COOKIE,
      ENVIRONMENT_COOKIE,
    ]);
    expect(api.requests).toEqual([]);
  });

  it("keeps the cookies and offers Try again when the refresh may pass later, never a redirect back", async () => {
    api.on(REFRESH_ROUTE, rateLimited);

    const response = await GET(refreshRequest("?next=%2Fqueues", signedIn()));

    expect(response.status).toBe(429);
    expect(response.headers.get("Location")).toBeNull();
    expect(setCookies(response)).toEqual([]);
    const page = await response.text();
    expect(page).toContain("Too many requests, retry in 60 s.");
    expect(page).toContain('<a href="/auth/refresh?next=%2Fqueues">Try again</a>');
    expect(page).toContain(`<a href="${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}">Back to the portal</a>`);

    api.on(REFRESH_ROUTE, () => apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }));
    const unavailable = await GET(refreshRequest("", signedIn()));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toContain("The OTA API is unavailable right now.");
  });
});
