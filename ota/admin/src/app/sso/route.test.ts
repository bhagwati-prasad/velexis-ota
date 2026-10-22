import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TENANT_ID,
  TEST_CONFIG,
  TEST_PORTAL_URL,
  TEST_SERVICE_KEY,
  apiError,
  fakeOtaApi,
  rateLimited,
  staffSession,
  type FakeOtaApi,
} from "@/test/fake-ota-api";

vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));

import { TENANT_COOKIE } from "@/lib/session";

import { POST } from "./route";

const SIGN_IN_ROUTE = "POST /v1/console/auth/sign-in";
const FORM = "application/x-www-form-urlencoded";
const PORTAL_ORIGIN = new URL(TEST_PORTAL_URL).origin;

let tokenSequence = 0;
/** A portal token as the platform mints it: `ptk_` and 43 base62 characters (PADR-0007 point 1). */
function portalToken(): string {
  tokenSequence += 1;
  return `ptk_${String(tokenSequence).padStart(3, "0")}${"Ab3".repeat(13)}x`;
}

/** The portal's hand-off: a form post of `body` from `origin`. */
function handOff(
  body: string,
  init: { origin?: string | null; contentType?: string; cookies?: Record<string, string> } = {},
): NextRequest {
  const headers = new Headers({
    "Content-Type": init.contentType ?? FORM,
    "X-Forwarded-For": "6.6.6.6, 203.0.113.7",
    "User-Agent": "Mozilla/5.0 Test",
  });
  const origin = init.origin === undefined ? PORTAL_ORIGIN : init.origin;
  if (origin !== null) {
    headers.set("Origin", origin);
  }
  const cookies = Object.entries(init.cookies ?? {}).map(([name, value]) => `${name}=${value}`);
  if (cookies.length > 0) {
    headers.set("Cookie", cookies.join("; "));
  }
  return new NextRequest("http://localhost:3002/sso", { method: "POST", headers, body });
}

function formOf(token: string): string {
  return new URLSearchParams({ portalToken: token }).toString();
}

/** The `Set-Cookie` lines as `[name, value, attributes in lower case]`. */
function setCookies(response: Response): [string, string, string[]][] {
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
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /sso", () => {
  it("[OAD-003 AC1] answers 403 to a foreign, opaque or missing Origin, before any call", async () => {
    for (const origin of [
      "https://evil.example",
      "http://localhost:3002",
      "http://localhost:3000.evil.example",
      "null",
      null,
    ]) {
      const response = await POST(handOff(formOf(portalToken()), { origin }));

      expect(response.status, String(origin)).toBe(403);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toContain("Back to the portal");
      expect(setCookies(response)).toEqual([]);
    }
    expect(api.requests).toEqual([]);
  });

  it("[OAD-003 AC1] shows the error page when a token is used a second time", async () => {
    const token = portalToken();
    const used = new Set<string>();
    api.on(SIGN_IN_ROUTE, (request) => {
      const { portalToken: sent } = request.body as { portalToken: string };
      if (used.has(sent)) {
        return apiError("PORTAL_TOKEN_INVALID", 401);
      }
      used.add(sent);
      return Response.json(staffSession(Date.now()));
    });

    const first = await POST(handOff(formOf(token)));
    const second = await POST(handOff(formOf(token), { cookies: { [TENANT_COOKIE]: TENANT_ID } }));

    expect(first.status).toBe(303);
    expect(second.status).toBe(401);
    expect(second.headers.get("Cache-Control")).toBe("no-store");
    const page = await second.text();
    expect(page).toContain("<h1>The console could not be opened</h1>");
    expect(page).toContain("This console link expired or was already used.");
    expect(page).toContain("<code>req_fake_1</code>");
    expect(page).toContain(`<a href="${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}">Back to the portal</a>`);
    expect(page).not.toContain(token);
    expect(page).not.toContain("<script");
    expect(setCookies(second)).toEqual([]);
    expect(api.sent(SIGN_IN_ROUTE)).toHaveLength(2);
  });

  it("[OAD-003 AC2] sets the four __Host- cookies and redirects to /bookings without a token in the URL or body", async () => {
    const token = portalToken();
    const result = staffSession(Date.now(), { environments: ["test", "live"] });
    api.on(SIGN_IN_ROUTE, () => Response.json(result));

    const response = await POST(handOff(formOf(token)));

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("http://localhost:3002/bookings");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookies = setCookies(response);
    expect(cookies.map(([name, value]) => [name, value])).toEqual([
      ["__Host-vx_staff_at", result.session.accessToken],
      ["__Host-vx_staff_rt", result.session.refreshToken],
      // A new session starts in test, even when live is allowed.
      ["__Host-vx_env", "test"],
      ["__Host-vx_tenant", TENANT_ID],
    ]);
    for (const [name, , attributes] of cookies) {
      expect(attributes, name).toEqual(
        expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/"]),
      );
      expect(
        attributes.some((attribute) => attribute.startsWith("domain=")),
        name,
      ).toBe(false);
      expect(
        attributes.some((attribute) => attribute.startsWith("max-age=")),
        name,
      ).toBe(true);
    }
    const body = await response.text();
    const location = response.headers.get("Location") ?? "";
    for (const secret of [token, result.session.accessToken, result.session.refreshToken]) {
      expect(location).not.toContain(secret);
      expect(body).not.toContain(secret);
    }
  });

  it("signs in with the service key only, the portal token grant, test and the staff member's address", async () => {
    const token = portalToken();

    await POST(handOff(formOf(token), { contentType: `${FORM}; charset=UTF-8` }));

    const [sent] = api.sent(SIGN_IN_ROUTE);
    expect(sent?.body).toEqual({ grantType: "portal_token", portalToken: token });
    expect(sent?.headers.get("X-Api-Key")).toBe(TEST_SERVICE_KEY);
    expect(sent?.headers.has("Authorization")).toBe(false);
    expect(sent?.headers.get("X-Velexis-Environment")).toBe("test");
    // consoleSignIn requires an Idempotency-Key, so a retry of the SDK replays the session instead of failing.
    expect(sent?.headers.get("Idempotency-Key")).toMatch(/\S/);
    expect(sent?.headers.get("X-Velexis-End-User-IP")).toBe("203.0.113.7");
    expect(sent?.headers.get("X-Velexis-End-User-Agent")).toBe("Mozilla/5.0 Test");
  });

  it("accepts only a form, before any call (415)", async () => {
    const token = portalToken();
    for (const contentType of ["application/json", "multipart/form-data; boundary=x", "text/plain", ""]) {
      const response = await POST(handOff(JSON.stringify({ portalToken: token }), { contentType }));
      expect(response.status, contentType).toBe(415);
    }
    expect(api.requests).toEqual([]);
  });

  it("accepts only one portal token of the contract's pattern in a small form (400)", async () => {
    const valid = portalToken();
    for (const body of [
      "",
      "token=ptk_abc",
      formOf("ptk_short"),
      formOf(`ptk_${"a".repeat(65)}`),
      formOf(`ptk_${"a".repeat(30)}-`),
      formOf(`ptk_${"a".repeat(30)}\n`),
      formOf(`sk_${"a".repeat(30)}`),
      `${formOf(valid)}&${formOf(portalToken())}`,
      `${formOf(valid)}&padding=${"x".repeat(2000)}`,
    ]) {
      const response = await POST(handOff(body));
      expect(response.status, body.slice(0, 40)).toBe(400);
      expect(await response.text()).toContain("This was not a valid console link.");
    }
    expect(api.requests).toEqual([]);
  });

  it("shows the API's refusal by code, with its status, and the security page for MFA_REQUIRED", async () => {
    const cases = [
      ["STAFF_MEMBERSHIP_INACTIVE", 403, "Your access to this OTA is not active."],
      ["TENANT_SUSPENDED", 403, "This OTA is suspended."],
      ["MFA_REQUIRED", 403, "turn on two-factor authentication in the portal first"],
      ["RATE_LIMITED", 429, "Too many requests, retry in 60 s."],
    ] as const;
    for (const [code, status, message] of cases) {
      api.on(SIGN_IN_ROUTE, () => (code === "RATE_LIMITED" ? rateLimited() : apiError(code, status)));

      const response = await POST(handOff(formOf(portalToken())));

      expect(response.status, code).toBe(status);
      const page = await response.text();
      expect(page, code).toContain(message);
      expect(page.includes(`href="${TEST_PORTAL_URL}/account/security"`), code).toBe(code === "MFA_REQUIRED");
      expect(page, code).toContain(`<a href="${TEST_PORTAL_URL}/console">Back to the portal</a>`);
      // The API's own message is never shown.
      expect(page, code).not.toContain("The API refused the request");
    }
  });

  it("answers 503 when the OTA API is unavailable, and escapes what it shows", async () => {
    api.on(SIGN_IN_ROUTE, () =>
      Response.json(
        { error: { code: "INTERNAL_ERROR", status: 500, message: "x", requestId: 'req_<b>"1"</b>' } },
        { status: 500, headers: { "X-Request-Id": 'req_<b>"1"</b>', "Retry-After": "60" } },
      ),
    );

    const response = await POST(handOff(formOf(portalToken())));

    expect(response.status).toBe(503);
    const page = await response.text();
    expect(page).toContain("<code>req_&lt;b&gt;&quot;1&quot;&lt;/b&gt;</code>");
    expect(page).not.toContain("<b>");
  });
});
