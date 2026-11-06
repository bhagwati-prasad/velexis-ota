import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  APP_ENV: "production" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
}));

vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import { STRIPE_CONNECT_COOKIE } from "@/lib/session";
import { middleware } from "@/middleware";

import { GET, HEAD } from "./route";

// ---- Dummy values only: never a real code, state or token ---------------------------------------------------------

const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const OTHER_TENANT_ID = "ten_01JB3A8R5N0S3V7W1Y4A9C2E6G";
/** The OAuth state of the platform document's example (a dummy) and an authorisation code of Stripe's shape. */
const STATE = "Xq7Lm2Np9Rt4Vw8Yb3Dc6Fg1Hj5Kk0Zs2Ae7Ui4Ow9Pq";
const CODE = "ac_PFE024DummyAuthorizationCode0001";
const CALLBACK_PATH = "/connect/stripe/callback";
const COMPLETE_PATH = "/v1/payment-connections/stripe-connect/callback";
const PAYMENTS = `/otas/${TENANT_ID}/payments`;

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(payload)}.c2lnbmF0dXJl`;
}

/** A fresh access token of a verified account, so the middleware passes the request on without a refresh. */
const ACCESS_TOKEN = jwt({ sub: "acc_1", aud: "portal", exp: Math.floor(Date.now() / 1000) + 900, ev: true });
const SESSION = {
  "__Host-vxp_at": ACCESS_TOKEN,
  "__Host-vxp_rt": "Rf5nW8qL2xK7vT4cB9mZ1pH6yD3sJ0aG8eU5iO2rQ4w",
};
/** The session and the Stripe Connect cookie that `connectStripe` set before the browser left for Stripe. */
const STARTED = { ...SESSION, [STRIPE_CONNECT_COOKIE]: TENANT_ID };

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

/** Stripe's redirect back to the portal, as the browser sends it (a top-level GET from connect.stripe.com). */
function callbackRequest(
  query: Record<string, string> | string,
  init: { cookies?: Record<string, string>; method?: string } = {},
): NextRequest {
  const search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers({
    "x-forwarded-for": "198.51.100.7",
    "user-agent": "Mozilla/5.0 (PFE-024 test)",
    "x-request-id": "req_pfe024_stripe_callback",
    referer: "https://connect.stripe.com/",
  });
  const cookies = Object.entries(init.cookies ?? STARTED).map(([name, value]) => `${name}=${value}`);
  if (cookies.length > 0) {
    headers.set("cookie", cookies.join("; "));
  }
  return new NextRequest(new URL(`${CALLBACK_PATH}?${search}`, "http://127.0.0.1:3000"), {
    method: init.method ?? "GET",
    headers,
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiError(code: string, status: number, details?: Record<string, unknown>): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pfe024",
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
  );
}

/** A payment connection as `completeStripeConnect` answers it (dummy ids). */
function connection(environment: "test" | "live", status: "active" | "pending") {
  return {
    id: environment === "test" ? "ppc_01JA2ZBA4D8F2H6K0N4Q8S2V6X" : "ppc_01JA2ZH9K3N7Q1T5W9Z3B7D1F5",
    environment,
    provider: "stripe",
    accountMode: "connect_standard",
    status,
    accountReference: "acct_1QPFE024Dummy",
    publishableKey: null,
    statementDescriptorSuffix: "ACME TRAVEL",
    capabilities: { chargesEnabled: status === "active", payoutsEnabled: false, detailsSubmitted: true },
    connectedAt: new Date().toISOString(),
    disconnectedAt: null,
    webhookUrl: null,
    pendingSubmission: null,
    version: 3,
  };
}

function completed(status: "active" | "pending" = "active", tenantId = TENANT_ID): Response {
  return json({ tenantId, connections: [connection("test", status)] }, 200);
}

/** The calls to `completeStripeConnect` so far. */
function completeCalls(): Request[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => new URL(input.url).pathname === COMPLETE_PATH);
}

async function bodyOf(request: Request | undefined): Promise<unknown> {
  if (request === undefined) {
    throw new Error("No such call.");
  }
  return request.clone().json();
}

/** Every header of `response` as one text, to look for the code or the state in it. */
function headerText(headers: Headers): string {
  return [...headers].map(([name, value]) => `${name}: ${value}`).join("\n");
}

/** The path and query of the redirect's `Location` on the portal's public URL. */
function locationOf(response: Response): string {
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error("No Location header.");
  }
  const url = new URL(location);
  expect(url.origin).toBe(settings.PUBLIC_PORTAL_URL);
  return `${url.pathname}${url.search}`;
}

/** The redirect clears the Stripe Connect cookie, with the attributes a browser needs to accept a `__Host-` deletion. */
function expectConnectCookieCleared(response: Response): void {
  const cleared = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${STRIPE_CONNECT_COOKIE}=`));
  expect(cleared).toBeDefined();
  expect(cleared).toMatch(/Max-Age=0/i);
  expect(cleared).toMatch(/Secure/i);
  expect(cleared).toMatch(/HttpOnly/i);
  expect(cleared).toMatch(/Path=\//i);
}

/** A `303` to `path` that keeps nothing of Stripe's query, carries `no-store`, and clears the Stripe Connect cookie. */
async function expectSeeOther(response: Response, path: string): Promise<void> {
  expect(response.status).toBe(303);
  expect(locationOf(response)).toBe(path);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expectConnectCookieCleared(response);
  const text = `${headerText(response.headers)}\n${await response.clone().text()}`;
  expect(text).not.toContain(CODE);
  expect(text).not.toContain(STATE);
}

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  consoleSpies.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, method));
  }
});

/** Nothing was written to the console: the handler logs nothing, least of all the query. */
function expectNothingLogged(): void {
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
  }
}

describe("GET /connect/stripe/callback: what Stripe sent back", () => {
  it("[PFE-024 AC1] posts the code and the state with the session and redirects to the OTA's payments page, never rendering or logging them [PF-61 AC1]", async () => {
    fetchMock.mockResolvedValue(completed());

    const response = await GET(callbackRequest({ code: CODE, state: STATE, scope: "read_write" }));

    // completeStripeConnect: the code and the state in the body only, with the bearer token and the end-user headers.
    const [call, ...more] = completeCalls();
    expect(more).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`${settings.PLATFORM_API_URL}${COMPLETE_PATH}`);
    expect(await bodyOf(call)).toEqual({ state: STATE, code: CODE });
    expect(call?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call?.headers.get("x-velexis-end-user-ip")).toBe("198.51.100.7");
    expect(call?.headers.get("x-velexis-end-user-agent")).toBe("Mozilla/5.0 (PFE-024 test)");
    expect(call?.headers.get("x-velexis-bff-key")).toBe(settings.PLATFORM_BFF_KEY);
    expect(new URL(call?.url ?? "").search).toBe("");

    // A 303 to the payments page with the outcome only: the code and the state are nowhere in the answer.
    await expectSeeOther(response, `${PAYMENTS}?stripeConnect=connected`);
    expect(await response.text()).toBe("");
    expectNothingLogged();
  });

  it("[PFE-024 AC1] names a connected account that Stripe has not enabled yet as pending [PF-61 AC1]", async () => {
    fetchMock.mockResolvedValue(completed("pending"));

    const response = await GET(callbackRequest({ code: CODE, state: STATE }));

    await expectSeeOther(response, `${PAYMENTS}?stripeConnect=pending`);
  });

  it("[PFE-024 AC1] goes to the OTA the API answers, whatever the cookie says, and works without the cookie", async () => {
    fetchMock.mockResolvedValue(completed("active", OTHER_TENANT_ID));
    await expectSeeOther(
      await GET(callbackRequest({ code: CODE, state: STATE })),
      `/otas/${OTHER_TENANT_ID}/payments?stripeConnect=connected`,
    );
    fetchMock.mockResolvedValue(completed());
    await expectSeeOther(
      await GET(callbackRequest({ code: CODE, state: STATE }, { cookies: SESSION })),
      `${PAYMENTS}?stripeConnect=connected`,
    );
    // An answer whose OTA is no OTA id is never put into the path: the OTA that started, else the dashboard.
    fetchMock.mockResolvedValue(completed("active", "ten_not-an-id/../x"));
    await expectSeeOther(
      await GET(callbackRequest({ code: CODE, state: STATE })),
      `${PAYMENTS}?stripeConnect=connected`,
    );
    await expectSeeOther(
      await GET(callbackRequest({ code: CODE, state: STATE }, { cookies: SESSION })),
      "/dashboard",
    );
  });

  it("[PFE-024 AC1] posts Stripe's error with the state, never its description, and says the person declined [PF-61 AC1]", async () => {
    fetchMock.mockResolvedValue(apiError("UNPROCESSABLE", 422, { reason: "access_denied" }));

    const response = await GET(
      callbackRequest({
        error: "access_denied",
        error_description: "The user denied your request",
        state: STATE,
      }),
    );

    expect(await bodyOf(completeCalls()[0])).toEqual({ state: STATE, error: "access_denied" });
    await expectSeeOther(response, `${PAYMENTS}?stripeConnect=denied`);
    expect(headerText(response.headers)).not.toContain("denied your request");
    expectNothingLogged();
  });

  it.each([
    ["CONNECT_STATE_INVALID", 400, undefined, "state_invalid"],
    ["VALIDATION_FAILED", 400, undefined, "state_invalid"],
    ["UNPROCESSABLE", 422, { reason: "oauth_error" }, "oauth_error"],
    ["UNPROCESSABLE", 422, { reason: "livemode_mismatch" }, "livemode_mismatch"],
    ["UNPROCESSABLE", 422, { reason: "a_newer_reason" }, "oauth_error"],
    ["STRIPE_ACCOUNT_ALREADY_CONNECTED", 409, undefined, "already_connected"],
    ["CONFLICT", 409, { reason: "connection_disabled" }, "connection_disabled"],
    ["CONFLICT", 409, undefined, "unavailable"],
    ["FEATURE_DISABLED", 403, { feature: "own_stripe" }, "feature_disabled"],
    ["TENANT_NOT_ACTIVE", 409, { status: "suspended" }, "not_active"],
    ["FORBIDDEN", 403, undefined, "forbidden"],
    ["RATE_LIMITED", 429, undefined, "rate_limited"],
    ["PROVIDER_ERROR", 502, { provider: "stripe" }, "provider_error"],
    ["SERVICE_UNAVAILABLE", 503, undefined, "unavailable"],
    ["INTERNAL_ERROR", 500, undefined, "unavailable"],
  ] as const)(
    "[PFE-024 AC1] maps %s (%s, %j) to the outcome %s on the payments page of the OTA that started",
    async (code, status, details, outcome) => {
      fetchMock.mockResolvedValue(apiError(code, status, details));

      const response = await GET(callbackRequest({ code: CODE, state: STATE }));

      expect(completeCalls()).toHaveLength(1);
      await expectSeeOther(response, `${PAYMENTS}?stripeConnect=${outcome}`);
      expectNothingLogged();
    },
  );

  it("an unreachable API reads as unavailable, and a refusal without the cookie goes to the dashboard", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expectSeeOther(
      await GET(callbackRequest({ code: CODE, state: STATE })),
      `${PAYMENTS}?stripeConnect=unavailable`,
    );

    fetchMock.mockResolvedValue(apiError("CONNECT_STATE_INVALID", 400));
    await expectSeeOther(
      await GET(callbackRequest({ code: CODE, state: STATE }, { cookies: SESSION })),
      "/dashboard",
    );
    // A cookie that holds no OTA id is no OTA.
    await expectSeeOther(
      await GET(
        callbackRequest(
          { code: CODE, state: STATE },
          { cookies: { ...SESSION, [STRIPE_CONNECT_COOKIE]: "../evil" } },
        ),
      ),
      "/dashboard",
    );
  });
});

describe("GET /connect/stripe/callback: the session", () => {
  it("[PFE-024 AC1] without a session it asks the API nothing and signs in, then shows the payments page [PF-61 AC1]", async () => {
    const response = await GET(
      callbackRequest({ code: CODE, state: STATE }, { cookies: { [STRIPE_CONNECT_COOKIE]: TENANT_ID } }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    await expectSeeOther(
      response,
      `/sign-in?${new URLSearchParams({ next: `${PAYMENTS}?stripeConnect=signed_out` }).toString()}`,
    );
  });

  it("an ended session signs in again, and an unverified account goes to /verify-pending", async () => {
    fetchMock.mockResolvedValue(apiError("UNAUTHENTICATED", 401));
    await expectSeeOther(
      await GET(callbackRequest({ code: CODE, state: STATE })),
      `/sign-in?${new URLSearchParams({ next: `${PAYMENTS}?stripeConnect=signed_out` }).toString()}`,
    );
    fetchMock.mockResolvedValue(apiError("TOKEN_EXPIRED", 401));
    await expectSeeOther(
      await GET(callbackRequest({ code: CODE, state: STATE }, { cookies: SESSION })),
      `/sign-in?${new URLSearchParams({ next: "/dashboard" }).toString()}`,
    );
    fetchMock.mockResolvedValue(apiError("EMAIL_NOT_VERIFIED", 403));
    await expectSeeOther(await GET(callbackRequest({ code: CODE, state: STATE })), "/verify-pending");
  });

  it("[PFE-030 AC1] the API's MFA enrolment gate leads to the enrolment page, then to the payments page to try again", async () => {
    fetchMock.mockResolvedValue(apiError("MFA_REQUIRED", 403, { reason: "enrolment_required" }));

    await expectSeeOther(
      await GET(callbackRequest({ code: CODE, state: STATE })),
      `/mfa-enrolment?${new URLSearchParams({ next: `${PAYMENTS}?stripeConnect=unavailable` }).toString()}`,
    );
  });

  it("the middleware passes the callback on to the handler with the session, and the answer is a redirect", async () => {
    const passed = await middleware(callbackRequest({ code: CODE, state: STATE }));

    // Not sent to sign-in by the middleware: the handler decides (a signed-in user is required there).
    expect(passed.headers.get("x-middleware-next")).toBe("1");
    expect(passed.headers.get("location")).toBeNull();
    expect(headerText(passed.headers)).not.toContain(CODE);
  });
});

describe("GET /connect/stripe/callback: a query that is not Stripe's", () => {
  it.each([
    ["no state", { code: CODE }],
    ["a state shorter than the document allows", { code: CODE, state: "short" }],
    ["a state with characters the document does not allow", { code: CODE, state: `${STATE}/..` }],
    ["a code with characters Stripe never sends", { code: "ac_<script>", state: STATE }],
    ["both a code and an error", { code: CODE, error: "access_denied", state: STATE }],
    ["neither a code nor an error", { state: STATE }],
    ["an error that is not one of Stripe's codes", { error: "Access Denied", state: STATE }],
  ] as const)("[PFE-024 AC1] %s: asks the API nothing and says to try again", async (_case, query) => {
    const response = await GET(callbackRequest(query));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(locationOf(response)).toBe(`${PAYMENTS}?stripeConnect=state_invalid`);
    expectConnectCookieCleared(response);
    expect(headerText(response.headers)).not.toContain("<script>");
    expectNothingLogged();
  });

  it("a repeated parameter takes Stripe's first value, and nothing of the rest reaches the answer", async () => {
    fetchMock.mockResolvedValue(completed());

    const response = await GET(callbackRequest(`code=${CODE}&code=ac_second&state=${STATE}&state=other`));

    expect(await bodyOf(completeCalls()[0])).toEqual({ state: STATE, code: CODE });
    await expectSeeOther(response, `${PAYMENTS}?stripeConnect=connected`);
  });
});

describe("other methods", () => {
  it("[PFE-024 AC1] HEAD answers 405 without spending the code", () => {
    const response = HEAD();

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
