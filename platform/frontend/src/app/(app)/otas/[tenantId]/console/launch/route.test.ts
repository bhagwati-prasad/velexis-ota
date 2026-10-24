import { Window } from "happy-dom";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import loadCustomRoutes from "next/dist/lib/load-custom-routes";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";
import { NextRequest, type NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  APP_ENV: "production" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
  PUBLIC_PORTAL_URL: "https://platform.example.com",
  PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
}));

vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import nextConfig from "../../../../../../../next.config";
import { middleware } from "@/middleware";

import * as routeModule from "./route";
import { GET, POST } from "./route";

// ---- Dummy values only: never a real token ------------------------------------------------------------------------

const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
const LAUNCH_PATH = `/otas/${TENANT_ID}/console/launch`;
/** A portal token of the document's pattern: `ptk_` and 43 base62 characters (a dummy). */
const PORTAL_TOKEN = "ptk_Pf3kQ9mZ2xT7bN4cR8wL1pY6hD5sJ0aE2gU9iO3qK7v";
const SSO_URL = "https://admin.ota.example.com/sso";
const PORTAL_ORIGIN = "https://platform.example.com";
const OTA_ADMIN_ORIGIN = "https://admin.ota.example.com";

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

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

/** The "Open console" form post, as a browser sends it from a portal page. */
function launchRequest(
  init: {
    origin?: string | null;
    cookies?: Record<string, string>;
    method?: string;
    headers?: Record<string, string>;
    path?: string;
  } = {},
): NextRequest {
  const headers = new Headers({
    "x-forwarded-for": "198.51.100.7",
    "user-agent": "Mozilla/5.0 (PFE-017 test)",
    "x-request-id": "req_pfe017_console_launch",
    "content-type": "application/x-www-form-urlencoded",
    ...init.headers,
  });
  const origin = init.origin === undefined ? PORTAL_ORIGIN : init.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  const cookies = Object.entries(init.cookies ?? SESSION).map(([name, value]) => `${name}=${value}`);
  if (cookies.length > 0) {
    headers.set("cookie", cookies.join("; "));
  }
  return new NextRequest(new URL(init.path ?? LAUNCH_PATH, "http://127.0.0.1:3000"), {
    method: init.method ?? "POST",
    headers,
  });
}

/** The route context Next.js passes: the dynamic segment as a promise. */
function context(tenantId = TENANT_ID): { params: Promise<{ tenantId: string }> } {
  return { params: Promise.resolve({ tenantId }) };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function issued(overrides: Record<string, unknown> = {}): Response {
  return json(
    {
      portalToken: PORTAL_TOKEN,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consoleSsoUrl: SSO_URL,
      ...overrides,
    },
    201,
  );
}

function apiError(code: string, status: number, details?: Record<string, unknown>): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pfe017",
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
  );
}

/** Every header of `response` as one text, to look for the token in it. */
function headerText(headers: Headers): string {
  return [...headers].map(([name, value]) => `${name}: ${value}`).join("\n");
}

/** The nonce of a policy's `script-src`. */
function policyNonce(policy: string | null): string | undefined {
  return /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy ?? "")?.[1];
}

/** The sources of one directive of a policy. */
function directive(policy: string | null, name: string): string[] {
  const found = (policy ?? "")
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([directiveName]) => directiveName === name);
  return found?.slice(1) ?? [];
}

// ---- Parsing the page, and what a browser makes of it -------------------------------------------------------------

const parser = new Window({ settings: { disableJavaScriptEvaluation: true } });

afterAll(async () => {
  await parser.happyDOM.close();
});

/** The hand-off page as a document: parsed, never run (no script is evaluated). */
function parse(html: string) {
  return new parser.DOMParser().parseFromString(html, "text/html");
}

/** The referrer policies of the Referrer Policy specification (§3). */
const REFERRER_POLICIES = new Set([
  "no-referrer",
  "no-referrer-when-downgrade",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
]);

/**
 * The referrer policy a browser applies to the page's form post. The document's policy comes from the
 * `Referrer-Policy` header (the last valid token wins: Referrer Policy §4.1), then a `<meta name="referrer">` with a
 * valid value replaces it (HTML §4.2.5.3); a form with `rel="noreferrer"` makes its navigation `no-referrer` (HTML
 * form submission). The browser default without any is `strict-origin-when-cross-origin`.
 */
function formPostPolicy(headers: Headers, html: string): string {
  let policy = "";
  for (const token of (headers.get("referrer-policy") ?? "").split(",")) {
    const value = token.trim().toLowerCase();
    if (REFERRER_POLICIES.has(value)) {
      policy = value;
    }
  }
  const document = parse(html);
  for (const meta of document.querySelectorAll('meta[name="referrer" i]')) {
    const value = (meta.getAttribute("content") ?? "").trim().toLowerCase();
    if (REFERRER_POLICIES.has(value)) {
      policy = value;
    }
  }
  const rel = (document.querySelector("form")?.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
  if (rel.includes("noreferrer")) {
    policy = "no-referrer";
  }
  return policy === "" ? "strict-origin-when-cross-origin" : policy;
}

/**
 * The `Origin` header of a navigation `POST` from a page at `documentUrl` to `actionUrl` under `policy`: Fetch,
 * "append a request `Origin` header" (a navigation's mode is `navigate`, so the referrer-policy switch applies).
 */
function formPostOrigin(documentUrl: string, actionUrl: string, policy: string): string {
  const origin = new URL(documentUrl);
  const target = new URL(actionUrl);
  const serialized = origin.origin;
  switch (policy) {
    case "no-referrer":
      return "null";
    case "no-referrer-when-downgrade":
    case "strict-origin":
    case "strict-origin-when-cross-origin":
      return origin.protocol === "https:" && target.protocol !== "https:" ? "null" : serialized;
    case "same-origin":
      return origin.origin === target.origin ? serialized : "null";
    default:
      return serialized;
  }
}

/**
 * The `Referer` of that post (Referrer Policy §8.3, "determine request's referrer"; both URLs are `https`, so no
 * downgrade applies): `undefined` when none is sent.
 */
function formPostReferer(documentUrl: string, actionUrl: string, policy: string): string | undefined {
  const page = new URL(documentUrl);
  const originOnly = `${page.origin}/`;
  const sameOrigin = page.origin === new URL(actionUrl).origin;
  switch (policy) {
    case "no-referrer":
      return undefined;
    case "origin":
    case "strict-origin":
      return originOnly;
    case "same-origin":
      return sameOrigin ? page.href : undefined;
    case "origin-when-cross-origin":
    case "strict-origin-when-cross-origin":
      return sameOrigin ? page.href : originOnly;
    default:
      return page.href;
  }
}

/**
 * The OTA admin's `POST /sso` admits a hand-off only with `Origin` = `PUBLIC_PORTAL_URL`'s origin, never `null`
 * (OADR-0018 point 2; `originMatches` of ota/admin/src/lib/auth-routes.ts).
 */
function ssoAccepts(origin: string): boolean {
  return origin !== "null" && origin === new URL(settings.PUBLIC_PORTAL_URL).origin;
}

// ---- next.config.ts and the middleware, as Next.js applies them around the route handler ---------------------------

/**
 * The headers of next.config.ts that Next.js sets for `path` before the middleware and the route handler run: the
 * rules loaded and compiled to the regular expressions `next build` writes to routes-manifest.json.
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
}, 30_000); // Loading next.config.ts through Next.js's own loader is the expensive step of this file.

/** What the browser gets for one request: the status, the headers as Next.js merges them, and the body. */
interface Served {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  /** The answer of the route handler alone. */
  readonly handler: NextResponse;
}

/**
 * Serves `request` as Next.js does (next-server's resolve-routes and send-response): the configured headers of
 * next.config.ts first; then the middleware runs, its request headers replace the request's (`x-middleware-override-
 * headers`), and its response headers replace configured ones of the same name; then the route handler answers, and
 * a header of its answer is only added when the response does not have it yet.
 */
async function serve(request: NextRequest, tenantId = TENANT_ID): Promise<Served> {
  const pathname = request.nextUrl.pathname;
  const sent = staticHeadersFor(pathname);
  const passed = await middleware(request);
  expect(passed.headers.get("x-middleware-next")).toBe("1");

  const forwarded = new Headers();
  for (const name of (passed.headers.get("x-middleware-override-headers") ?? "").split(",")) {
    const value = passed.headers.get(`x-middleware-request-${name.trim()}`);
    if (name.trim() !== "" && value !== null) {
      forwarded.set(name.trim(), value);
    }
  }
  passed.headers.forEach((value, name) => {
    if (!name.startsWith("x-middleware-")) {
      sent.set(name, value);
    }
  });

  const handler = await POST(
    new NextRequest(request.url, { method: request.method, headers: forwarded }),
    context(tenantId),
  );
  handler.headers.forEach((value, name) => {
    if (!sent.has(name)) {
      sent.set(name, value);
    }
  });
  return { status: handler.status, headers: sent, body: await handler.clone().text(), handler };
}

// ---- Tests --------------------------------------------------------------------------------------------------------

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  consoleSpies.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, method));
  }
});

/** The calls to `createConsoleToken` so far. */
function tokenCalls(): Request[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => new URL(input.url).pathname === `/v1/tenants/${TENANT_ID}/console-token`);
}

describe("POST /otas/{tenantId}/console/launch: the Origin check", () => {
  it.each([
    ["a foreign origin", "https://evil.example"],
    ["a look-alike host", "https://platform.example.com.evil.example"],
    ["the portal host over http", "http://platform.example.com"],
    ["the OTA admin's origin", OTA_ADMIN_ORIGIN],
    ["an opaque origin", "null"],
    ["no Origin header", null],
  ])("[PFE-017 AC2] answers 403 to %s without minting a token [PF-22 AC3]", async (_case, origin) => {
    const response = await POST(launchRequest({ origin }), context());

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 to a path that names no OTA id, without a call", async () => {
    const response = await POST(launchRequest({ path: "/otas/acme/console/launch" }), context("acme"));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /otas/{tenantId}/console/launch: the hand-off page", () => {
  it("[PFE-017 AC1] mints the token with the session and answers a page that posts it in the form body only [PF-22 AC2]", async () => {
    fetchMock.mockResolvedValue(issued());

    const response = await POST(
      launchRequest({ headers: { "x-nonce": "bm9uY2Utb2YtdGhlLW1pZGRsZXdhcmU=" } }),
      context(),
    );

    // createConsoleToken: the bearer token of the session and the end-user headers of PADR-0019, no body.
    expect(tokenCalls()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = tokenCalls()[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`http://127.0.0.1:3100/v1/tenants/${TENANT_ID}/console-token`);
    expect(call?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call?.headers.get("x-velexis-end-user-ip")).toBe("198.51.100.7");
    expect(call?.headers.get("x-velexis-bff-key")).toBe(settings.PLATFORM_BFF_KEY);
    expect(call?.headers.get("x-request-id")).toBe("req_pfe017_console_launch");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    const html = await response.text();
    const document = parse(html);

    // One form, posting to the OTA admin's /sso as a urlencoded form, with the token as its only field.
    const forms = document.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    const form = forms[0];
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe(SSO_URL);
    expect(form?.getAttribute("enctype")).toBe("application/x-www-form-urlencoded");
    const fields = [...(form?.querySelectorAll("input, select, textarea") ?? [])];
    expect(fields.map((field) => [field.getAttribute("type"), field.getAttribute("name")])).toEqual([
      ["hidden", "portalToken"],
    ]);
    expect(fields[0]?.getAttribute("value")).toBe(PORTAL_TOKEN);
    // The visible fallback for a browser without JavaScript.
    expect(form?.querySelector('button[type="submit"]')?.textContent).toBe("Continue");

    // The token is in that field and nowhere else: not in a URL of the page, not in a header, no cookie.
    expect(html.split(PORTAL_TOKEN)).toHaveLength(2);
    for (const element of document.querySelectorAll("[href], [src], [action]")) {
      for (const name of ["href", "src", "action"]) {
        expect(element.getAttribute(name) ?? "").not.toContain(PORTAL_TOKEN);
      }
    }
    expect(headerText(response.headers)).not.toContain(PORTAL_TOKEN);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);

    // The script that submits the form at once carries the request's nonce, which the policy allows.
    const scripts = document.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.getAttribute("nonce")).toBe("bm9uY2Utb2YtdGhlLW1pZGRsZXdhcmU=");
    expect(scripts[0]?.getAttribute("src")).toBeNull();
    expect(scripts[0]?.textContent).toBe(`document.getElementById("${form?.id}").submit();`);
    const policy = response.headers.get("content-security-policy");
    expect(policyNonce(policy)).toBe("bm9uY2Utb2YtdGhlLW1pZGRsZXdhcmU=");
    expect(directive(policy, "form-action")).toEqual([OTA_ADMIN_ORIGIN]);
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("strict-origin");

    // Never logged.
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("[PFE-017 AC1] as served with next.config.ts and the middleware: no-store, strict-origin, form posts to the OTA admin only, the nonce of the policy on the script [PF-22 AC2]", async () => {
    fetchMock.mockResolvedValue(issued());

    const served = await serve(launchRequest());

    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("no-store");
    // The configured strict-origin-when-cross-origin of every other page is replaced, never kept.
    expect(served.headers.get("referrer-policy")).toBe("strict-origin");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    // The middleware's policy is the one the browser gets (Next.js keeps it over the handler's), with the hand-off's
    // form-action, and the page's script carries its nonce.
    const policy = served.headers.get("content-security-policy");
    expect(directive(policy, "form-action")).toEqual([OTA_ADMIN_ORIGIN]);
    expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
    const nonce = policyNonce(policy);
    expect(nonce).toBeDefined();
    expect(parse(served.body).querySelector("script")?.getAttribute("nonce")).toBe(nonce);
    expect(served.handler.headers.get("content-security-policy")).toBe(policy);
    expect(headerText(served.headers)).not.toContain(PORTAL_TOKEN);
  });

  it("[PFE-017 AC1] the browser's form post to /sso carries the portal's Origin, which the OTA admin accepts, and no path in Referer", async () => {
    fetchMock.mockResolvedValue(issued());
    const served = await serve(launchRequest());
    const document = parse(served.body);
    const action = document.querySelector("form")?.getAttribute("action") ?? "";
    const pageUrl = `${PORTAL_ORIGIN}${LAUNCH_PATH}`;

    const policy = formPostPolicy(served.headers, served.body);
    const origin = formPostOrigin(pageUrl, action, policy);
    const referer = formPostReferer(pageUrl, action, policy);

    expect(policy).toBe("strict-origin");
    expect(origin).toBe(PORTAL_ORIGIN);
    expect(ssoAccepts(origin)).toBe(true);
    // Only the origin: neither the launch path nor the token reaches the OTA admin in a header.
    expect(referer).toBe(`${PORTAL_ORIGIN}/`);
    expect(referer).not.toContain("/console/launch");
    expect(`${origin} ${referer ?? ""}`).not.toContain(PORTAL_TOKEN);
  });

  it("[PFE-017 AC1] the same page under no-referrer would post Origin: null, which the OTA admin refuses (why it is not used)", async () => {
    fetchMock.mockResolvedValue(issued());
    const served = await serve(launchRequest());
    const action = parse(served.body).querySelector("form")?.getAttribute("action") ?? "";
    const pageUrl = `${PORTAL_ORIGIN}${LAUNCH_PATH}`;
    const noReferrer = new Headers({ "referrer-policy": "no-referrer" });
    const withoutMeta = served.body.replace(/<meta name="referrer"[^>]*>/, "");

    const origin = formPostOrigin(pageUrl, action, formPostPolicy(noReferrer, withoutMeta));

    expect(origin).toBe("null");
    expect(ssoAccepts(origin)).toBe(false);
  });

  it("renders the SSO URL as the URL parser writes it and uses a fresh nonce when no middleware handed one over", async () => {
    fetchMock.mockResolvedValue(issued({ consoleSsoUrl: 'https://admin.ota.example.com/sso/a"b<c>' }));

    const response = await POST(launchRequest(), context());
    const html = await response.text();
    const document = parse(html);

    expect(response.status).toBe(200);
    expect(document.querySelectorAll("form")).toHaveLength(1);
    expect(document.querySelector("form")?.getAttribute("action")).toBe(
      "https://admin.ota.example.com/sso/a%22b%3Cc%3E",
    );
    const nonce = policyNonce(response.headers.get("content-security-policy"));
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(document.querySelector("script")?.getAttribute("nonce")).toBe(nonce);
  });

  it.each([
    ["an SSO URL at another origin", issued({ consoleSsoUrl: "https://evil.example/sso" })],
    ["an SSO URL with a query", issued({ consoleSsoUrl: `${SSO_URL}?next=/bookings` })],
    ["an SSO URL with credentials", issued({ consoleSsoUrl: "https://user:pw@admin.ota.example.com/sso" })],
    ["an SSO URL that is no URL", issued({ consoleSsoUrl: "not a url" })],
    ["a token of another shape", issued({ portalToken: 'ptk_"><script>alert(1)</script>' })],
  ])(
    "never renders the token of an answer with %s: back to the OTA dashboard with the portal's message",
    async (_case, answer) => {
      fetchMock.mockResolvedValue(answer);

      const response = await POST(launchRequest(), context());

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${PORTAL_ORIGIN}/otas/${TENANT_ID}?console=unavailable`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("ptk_");
      expect(headerText(response.headers)).not.toContain("ptk_");
    },
  );
});

describe("POST /otas/{tenantId}/console/launch: refusals", () => {
  /** Asserts a `303` to `path` on the portal's URL, without the token or a body that holds one. */
  async function expectSeeOther(response: NextResponse, path: string): Promise<void> {
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${PORTAL_ORIGIN}${path}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("ptk_");
  }

  it("[PFE-017 AC2] MFA_REQUIRED leads to the security page with the message and the OTA to open again [PF-22 AC3]", async () => {
    fetchMock.mockResolvedValue(apiError("MFA_REQUIRED", 403));

    const response = await POST(launchRequest(), context());

    await expectSeeOther(response, `/account/security?console=mfa_required&tenant=${TENANT_ID}`);
  });

  it.each([
    [
      "suspended for billing",
      { status: "suspended", suspensionReason: "billing" },
      "?console=suspended&reason=billing",
    ],
    [
      "suspended by an admin",
      { status: "suspended", suspensionReason: "admin" },
      "?console=suspended&reason=admin",
    ],
    ["suspended without a reason", { status: "suspended" }, "?console=suspended"],
    [
      "suspended with an unknown reason",
      { status: "suspended", suspensionReason: "<x>" },
      "?console=suspended",
    ],
    ["still being set up", { status: "provisioning" }, "?console=provisioning"],
    ["whose set-up failed", { status: "failed" }, "?console=failed"],
    ["without details", undefined, "?console=not_active"],
  ])(
    "[PFE-017 AC2] TENANT_NOT_ACTIVE for an OTA %s goes back to the OTA dashboard with the explanation [PF-22 AC3]",
    async (_case, details, query) => {
      fetchMock.mockResolvedValue(apiError("TENANT_NOT_ACTIVE", 409, details));

      await expectSeeOther(await POST(launchRequest(), context()), `/otas/${TENANT_ID}${query}`);
    },
  );

  it.each([
    ["UNAUTHENTICATED", 401, `/sign-in?next=${encodeURIComponent(`/console?tenant=${TENANT_ID}`)}`],
    ["TOKEN_EXPIRED", 401, `/sign-in?next=${encodeURIComponent(`/console?tenant=${TENANT_ID}`)}`],
    ["EMAIL_NOT_VERIFIED", 403, "/verify-pending"],
    ["NOT_FOUND", 404, `/console?tenant=${TENANT_ID}`],
    ["VALIDATION_FAILED", 400, `/console?tenant=${TENANT_ID}`],
    ["RATE_LIMITED", 429, `/otas/${TENANT_ID}?console=rate_limited`],
    ["SERVICE_UNAVAILABLE", 503, `/otas/${TENANT_ID}?console=unavailable`],
    ["INTERNAL_ERROR", 500, `/otas/${TENANT_ID}?console=unavailable`],
  ])("sends %s to %s", async (code, status, path) => {
    fetchMock.mockResolvedValue(apiError(code, status));

    await expectSeeOther(await POST(launchRequest(), context()), path);
  });

  it("sends an unreachable API back to the OTA dashboard with the portal's message", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:3100"));

    await expectSeeOther(await POST(launchRequest(), context()), `/otas/${TENANT_ID}?console=unavailable`);
  });

  it("without an access token goes to sign-in and then to the console picker, without a call", async () => {
    await expectSeeOther(
      await POST(launchRequest({ cookies: {} }), context()),
      `/sign-in?next=${encodeURIComponent(`/console?tenant=${TENANT_ID}`)}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /otas/{tenantId}/console/launch", () => {
  it("[PFE-017 AC1] mints nothing: a link, a prefetch or the return from sign-in lands on the console picker", async () => {
    // The handlers as Next.js dispatches them: HEAD answers like GET. (Next.js types the context's params loosely;
    // the route's own handlers name the dynamic segment.)
    const methods = autoImplementMethods(
      routeModule as unknown as Parameters<typeof autoImplementMethods>[0],
    );
    for (const method of ["GET", "HEAD"] as const) {
      const response = (await methods[method](launchRequest({ method }), context())) as NextResponse;

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${PORTAL_ORIGIN}/console?tenant=${TENANT_ID}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const withoutId = await GET(
      launchRequest({ method: "GET", path: "/otas/x/console/launch" }),
      context("x"),
    );
    expect(withoutId.headers.get("location")).toBe(`${PORTAL_ORIGIN}/console`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("next.config.ts referrer policies", () => {
  it("[PFE-017 AC1] serves only the launch path with strict-origin; the other pages keep strict-origin-when-cross-origin", () => {
    expect(staticHeadersFor(LAUNCH_PATH).get("referrer-policy")).toBe("strict-origin");
    for (const path of [
      "/",
      "/console",
      `/otas/${TENANT_ID}`,
      `/otas/${TENANT_ID}/console`,
      `/otas/${TENANT_ID}/console/launch/x`,
      "/dashboard",
    ]) {
      expect(staticHeadersFor(path).get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    }
    // The token pages keep no-referrer.
    expect(staticHeadersFor("/verify-email").get("referrer-policy")).toBe("no-referrer");
  });

  it("keeps the portal's own form-action on every other page", async () => {
    const passed = await middleware(launchRequest({ method: "GET", path: `/otas/${TENANT_ID}` }));

    expect(directive(passed.headers.get("content-security-policy"), "form-action")).toEqual([
      "'self'",
      OTA_ADMIN_ORIGIN,
    ]);
  });
});
