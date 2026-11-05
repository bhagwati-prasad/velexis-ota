// The security headers and cookies of the platform admin (PAD-016 step 2; platform/admin/README.md §4 "Security
// headers", "Cookies", "Middleware" and "Portal sessions do not work here", PADR-0006 Access items 1 and 7, PADR-0009),
// project `platform-admin`:
//
//   signed out, the console answers `303` to the sign-in → the admin signs in through the browser: the password step
//   sets the challenge cookie, the code step the session cookies → every route of the built console, one by one → the
//   access cookie expires and the middleware refreshes the session → the route handlers (the CSV downloads, the health
//   routes) → a browser with the admin's own portal session gets no console page, and neither do the portal's tokens
//   put into the admin's cookies → "Sign out" deletes the session cookies → every answer of the journey checked
//
// The headers. Every answer the browser receives from the admin (pages, RSC requests, server actions, redirects,
// Next.js's static files, the route handlers) carries `X-Robots-Tag: noindex`, `X-Content-Type-Options: nosniff`,
// `Referrer-Policy: same-origin` and the admin's `Permissions-Policy`, and no `X-Powered-By`. An answer the middleware
// sees (every path but `/_next/…`, the favicon and the health routes) also carries exactly the admin's
// Content-Security-Policy with a nonce no other answer had, `form-action 'self'` among its directives:
//   default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
//   font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'
// and every script element of a page carries that nonce; every page asks robots not to index it
// (`<meta name="robots" content="noindex, nofollow">`). Caddy adds HSTS and X-Frame-Options on the VM
// (deploy/caddy/Caddyfile); the stack runs without Caddy.
//
// The cookies. Every cookie the admin sets or deletes is one of its own three (`__Host-vxa_mfa` during the sign-in,
// `__Host-vxa_at` and `__Host-vxa_rt` for the session) and carries `HttpOnly`, `Secure`, `SameSite=Strict` and
// `Path=/` without a `Domain`; the browser keeps them so (`sameSite: "Strict"`, `httpOnly`, `secure`).
//
// The portal's session. The stack serves the portal and the admin on two ports of 127.0.0.1, so the browser sends the
// portal's `__Host-` cookies to the admin too (on the VM they are two hosts; the step checks that the admin's request
// carried them): a browser that holds the platform admin's own portal session, which works on the portal, gets the
// admin's sign-in, and the admin sets no cookie. The portal's
// tokens put into the admin's cookie names are refused as well (another audience, PADR-0006 Access item 1): the
// middleware's refresh with the portal's refresh token fails, so it deletes both cookies and answers `303` to the
// sign-in; the platform API itself answers `401` to the portal's access token on `adminGetMe`.
//
// Arranged in `beforeAll` through the platform API: the admin (an account with MFA that `admin:grant` makes a platform
// admin) and its portal session (`signIn` and `verifyMfa`); the console's sign-in is the journey's. The routes with an
// id are opened with the admin's own account, a plan and a queue the console lists, and well-formed ids of no OTA,
// job, subscription or statement, whose pages answer `404` through the same middleware (admin-a11y.e2e.ts shows them
// with data). The journey needs no OTA, so it runs with or without `E2E_WITH_OTA=1`. The steps are tests in order
// (`mode: "serial"`) on browser contexts made in `beforeAll`. Tokens stay in variables: a finding names a cookie or a
// header, never a value.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { APIResponse, BrowserContext, Page, Response } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import {
  addSessionCookies,
  callPlatformApi,
  createVerifiedAccount,
  enableMfa,
  expect,
  newAccountContext,
  type PlatformApiError,
  signInWithApi,
  test,
  type MfaAccount,
  type SessionTokens,
} from "../support/fixtures";
import { buildAccount, grantPlatformAdmin } from "../support/seed";
import { PLATFORM_ADMIN_URL, PORTAL_URL, REPO_ROOT, STACK_HOST } from "../support/stack";
import { TOTP_PERIOD_SECONDS, totpStep } from "../support/totp";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/** The route list of the platform admin build the stack runs (`next build` writes it). */
const ROUTES_MANIFEST = resolve(REPO_ROOT, "platform/admin/.next/app-path-routes-manifest.json");

/** Every route of the platform admin, as the build's route list names it, and the step of this journey that visits it. */
const ROUTES = Object.freeze({
  "/sign-in": "sign-in",
  "/sign-in/mfa": "sign-in",
  "/": "every page",
  "/tenants": "every page",
  "/tenants/[tenantId]": "every page",
  "/provisioning-jobs": "every page",
  "/provisioning-jobs/[jobId]": "every page",
  "/queues": "every page",
  "/queues/[queue]": "every page",
  "/plans": "every page",
  "/plans/[planCode]": "every page",
  "/subscriptions": "every page",
  "/subscriptions/[subscriptionId]": "every page",
  "/invoices": "every page",
  "/stripe-events": "every page",
  "/amadeus/accounts": "every page",
  "/amadeus/offices": "every page",
  "/settlements": "every page",
  "/settlements/[settlementId]": "every page",
  "/domains": "every page",
  "/accounts": "every page",
  "/accounts/[accountId]": "every page",
  "/admins": "every page",
  "/audit": "every page",
  "/_not-found": "every page",
  "/audit/export.csv": "route handlers",
  "/settlements/[settlementId]/lines.csv": "route handlers",
  "/health/live": "route handlers",
  "/health/ready": "route handlers",
  "/sign-out": "sign-out",
} as const);
type AdminRoute = keyof typeof ROUTES;

/** The admin's title of a page (`%s · Velexis admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis admin`;

/** The admin's policy (README §4, src/middleware.ts; `APP_ENV=test`, so no `'unsafe-eval'`) with `nonce`. */
function adminPolicy(nonce: string): Record<string, string[]> {
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };
}

/** The static headers of next.config.ts (`SECURITY_HEADERS`) that every answer carries. */
const STATIC_HEADERS = Object.freeze({
  "x-robots-tag": "noindex",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
} as const);

/** The cookies of the admin (README §4). */
const ADMIN_COOKIES = Object.freeze(["__Host-vxa_at", "__Host-vxa_rt", "__Host-vxa_mfa"] as const);

/** A CSP nonce as the middleware writes it: 128 random bits in base64. */
const NONCE = /^'nonce-([A-Za-z0-9+/]{22,}={0,2})'$/;

/** The script elements of an HTML page, as written. */
const SCRIPT_TAG = /<script\b[^>]*>/g;
/** The robots meta element of the root layout's metadata. */
const NO_INDEX = /<meta name="robots" content="noindex, nofollow"\s*\/?>/;

/** An answer's headers as Playwright lists them (every value, `Set-Cookie` lines one by one). */
type HeaderList = readonly { readonly name: string; readonly value: string }[];

function valuesOf(headers: HeaderList, name: string): string[] {
  return headers.filter((header) => header.name.toLowerCase() === name).map((header) => header.value);
}

/** A policy's directives by name, each with its sources. */
function directivesOf(policy: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== "") {
      directives[name.toLowerCase()] = sources;
    }
  }
  return directives;
}

/**
 * Whether the admin's middleware sees a request for `pathname`: its matcher (src/middleware.ts) takes every path but
 * Next.js's own files (`/_next/…`), the favicon and the health routes.
 */
function middlewareSees(pathname: string): boolean {
  return !(pathname.startsWith("/_next/") || pathname === "/favicon.ico" || pathname.startsWith("/health/"));
}

/** The admin's attributes of one `Set-Cookie` line, in words when one is missing; the value is never named. */
function setCookieProblems(line: string): string[] {
  const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
  const name = pair.slice(0, Math.max(pair.indexOf("="), 0));
  if (!(ADMIN_COOKIES as readonly string[]).includes(name)) {
    return [`sets the cookie ${name === "" ? "(no name)" : name}, which is not one of the admin's`];
  }
  const flags = new Map(
    attributes.map((attribute) => {
      const [key = "", ...value] = attribute.split("=");
      return [key.toLowerCase(), value.join("=")] as const;
    }),
  );
  const problems: string[] = [];
  if (!flags.has("httponly")) {
    problems.push(`${name} without HttpOnly`);
  }
  if (!flags.has("secure")) {
    problems.push(`${name} without Secure`);
  }
  if ((flags.get("samesite") ?? "").toLowerCase() !== "strict") {
    problems.push(`${name} without SameSite=Strict`);
  }
  if (flags.get("path") !== "/") {
    problems.push(`${name} without Path=/`);
  }
  if (flags.has("domain")) {
    problems.push(`${name} with a Domain`);
  }
  return problems;
}

/**
 * What is wrong with an answer of `pathname` (`headers`), in words: the static headers of every answer, no
 * X-Powered-By, the admin's policy with a nonce (returned) where the middleware saw the request and no policy where it
 * did not, and the attributes of every cookie it sets.
 */
function headerProblems(
  pathname: string,
  headers: HeaderList,
): { readonly problems: string[]; readonly nonce?: string } {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(STATIC_HEADERS)) {
    const values = valuesOf(headers, name);
    if (values.join(", ") !== value) {
      problems.push(
        `${name} is ${values.length === 0 ? "missing" : `"${values.join(", ")}"`}, not "${value}"`,
      );
    }
  }
  if (valuesOf(headers, "x-powered-by").length > 0) {
    problems.push("X-Powered-By is sent");
  }
  for (const line of valuesOf(headers, "set-cookie")) {
    problems.push(...setCookieProblems(line));
  }
  const policies = valuesOf(headers, "content-security-policy");
  if (!middlewareSees(pathname)) {
    return { problems };
  }
  if (policies.length !== 1) {
    problems.push(`${policies.length} Content-Security-Policy headers instead of one`);
    return { problems };
  }
  const directives = directivesOf(policies[0] ?? "");
  if (directives["form-action"]?.join(" ") !== "'self'") {
    problems.push("the Content-Security-Policy has no form-action 'self'");
  }
  const nonce = NONCE.exec(directives["script-src"]?.[1] ?? "")?.[1];
  if (nonce === undefined || !isDeepStrictEqual(directives, adminPolicy(nonce))) {
    problems.push("the Content-Security-Policy is not the admin's policy with a nonce");
    return { problems };
  }
  return { problems, nonce };
}

/**
 * Watches every answer of the admin in browser contexts: the problems of its headers and cookies (checked by the last
 * step), each nonce its own, and the cookies each answer set.
 */
class AdminAnswers {
  readonly problems: string[] = [];
  /** The admin's cookies set (with a value) or deleted (empty) by the answers, by name. */
  readonly cookiesSet = new Set<string>();
  readonly cookiesDeleted = new Set<string>();
  private readonly nonces = new Map<string, string>();
  private readonly pending: Promise<void>[] = [];
  private count = 0;

  get answers(): number {
    return this.count;
  }

  watch(target: BrowserContext): void {
    target.on("response", (response) => {
      if (new URL(response.url()).port === new URL(PLATFORM_ADMIN_URL).port) {
        this.pending.push(this.take(response));
      }
    });
  }

  /** Checks one answer: `pathname` and its headers, from the browser or from an API request of the journey. */
  check(pathname: string, headers: HeaderList): string | undefined {
    this.count += 1;
    const { problems, nonce } = headerProblems(pathname, headers);
    for (const problem of problems) {
      this.problems.push(`${pathname}: ${problem}`);
    }
    if (nonce !== undefined) {
      const earlier = this.nonces.get(nonce);
      if (earlier !== undefined) {
        this.problems.push(`${pathname}: the nonce of an earlier answer (${earlier})`);
      }
      this.nonces.set(nonce, pathname);
    }
    for (const line of valuesOf(headers, "set-cookie")) {
      const [pair = ""] = line.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      (pair.slice(separator + 1).trim() === "" ? this.cookiesDeleted : this.cookiesSet).add(name);
    }
    return nonce;
  }

  private async take(response: Response): Promise<void> {
    const pathname = new URL(response.url()).pathname;
    try {
      this.check(pathname, await response.headersArray());
    } catch {
      this.problems.push(`${pathname}: its headers could not be read`);
    }
  }

  /** Waits until every answer seen so far is checked. */
  async settled(): Promise<void> {
    await Promise.all(this.pending);
  }
}

let admin: MfaAccount;
let adminAccountId: string;
let portalSession: SessionTokens;
let context: BrowserContext;
let page: Page;
const answers = new AdminAnswers();
/** The routes the journey visited. */
const visited = new Set<AdminRoute>();

/** A well-formed id of `prefix` that no row has: `<prefix>_` and 26 random ULID characters. */
function unknownId(prefix: "ten" | "job" | "sub" | "stl"): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(26);
  return `${prefix}_${[...bytes].map((byte) => alphabet[byte % 32] ?? "0").join("")}`;
}

/** A day in UTC (`yyyy-mm-dd`) `offset` days from today. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Waits in the one-time arrangement until the TOTP step `step` has begun (see admin-a11y.e2e.ts). */
async function waitForTotpStep(step: number): Promise<void> {
  const wait = step * TOTP_PERIOD_SECONDS * 1000 - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait + 50));
  }
}

/**
 * Checks a page's HTML answer: every script element with the answer's nonce (at least the page's own Next.js scripts)
 * and the robots meta element.
 */
async function expectPageHtml(response: Response): Promise<void> {
  const headers = await response.headersArray();
  expect(valuesOf(headers, "content-type").join(",")).toMatch(/^text\/html/);
  const nonce = headerProblems(new URL(response.url()).pathname, headers).nonce;
  expect(nonce).toBeDefined();
  const html = await response.text();
  const scripts = html.match(SCRIPT_TAG) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((tag) => !tag.includes(` nonce="${nonce ?? ""}"`))).toEqual([]);
  expect(html).toMatch(NO_INDEX);
}

/** Opens `path` (a page of `route`) as a new document: `status` without a redirect, the title, the page's HTML. */
async function visit(route: AdminRoute, path: string, title: string | RegExp, status = 200): Promise<void> {
  const response = await page.goto(path);
  if (response === null) {
    throw new Error(`${path} gave no answer`);
  }
  expect(response.status(), path).toBe(status);
  expect(response.request().redirectedFrom(), path).toBeNull();
  await expect(page).toHaveTitle(typeof title === "string" ? adminTitle(title) : title);
  await expectPageHtml(response);
  visited.add(route);
}

/** The admin's cookies in `target`, as the browser keeps them; names and attributes only, never a value. */
async function adminCookiesOf(
  target: BrowserContext,
): Promise<{ name: string; httpOnly: boolean; secure: boolean; sameSite: string; path: string }[]> {
  return (await target.cookies(PLATFORM_ADMIN_URL))
    .filter((cookie) => cookie.name.startsWith("__Host-vxa_"))
    .map(({ name, httpOnly, secure, sameSite, path }) => ({ name, httpOnly, secure, sameSite, path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The names of the cookies a request sent (its `Cookie` header), sorted; the values are never kept. */
function cookieNamesSent(headers: Record<string, string>): string[] {
  return (headers["cookie"] ?? "")
    .split(";")
    .map((pair) => pair.trim().split("=")[0] ?? "")
    .filter((name) => name !== "")
    .sort();
}

/** The browser's admin cookies of a session, as the admin sets them. */
const SESSION_COOKIES = [
  { name: "__Host-vxa_at", httpOnly: true, secure: true, sameSite: "Strict", path: "/" },
  { name: "__Host-vxa_rt", httpOnly: true, secure: true, sameSite: "Strict", path: "/" },
] as const;

test.beforeAll(async ({ browser }) => {
  // Budget: an account through the platform API and Mailpit (at most 15 s), its MFA, `admin:grant`, its portal
  // sign-in with a TOTP code and the wait for two unused TOTP steps (at most 60 s).
  test.setTimeout(120_000);
  admin = await enableMfa(await createVerifiedAccount(buildAccount({ fullName: "Hedvig Headers Admin" })));
  await grantPlatformAdmin(admin.email);
  // The admin's own portal session: the same account, signed in to the portal with its password and a TOTP code.
  portalSession = await signInWithApi(admin);
  const lastCodeStep = totpStep(Date.now());
  const me = await callPlatformApi<Schemas["Account"]>({
    operation: "getMe",
    method: "GET",
    path: "/v1/me",
    endUserIp: admin.endUserIp,
    accessToken: portalSession.accessToken,
  });
  adminAccountId = me.id;
  context = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  answers.watch(context);
  page = await context.newPage();
  await waitForTotpStep(lastCodeStep + 2);
});

test.afterAll(async () => {
  await context?.close();
});

test("the journey's route list is the built platform admin's [PAD-016 step 2]", () => {
  const manifest = JSON.parse(readFileSync(ROUTES_MANIFEST, "utf8")) as Record<string, string>;
  const built = [...new Set(Object.values(manifest))].sort((a, b) => a.localeCompare(b));
  expect(built).toEqual(Object.keys(ROUTES).sort((a, b) => a.localeCompare(b)));
});

test("signed out, a console page answers 303 to the sign-in with the admin's headers [PAD-016 step 2]", async () => {
  const redirect = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admins" && response.request().method() === "GET",
  );
  await page.goto("/admins");
  const answer = await redirect;
  expect(answer.status()).toBe(303);
  const location = new URL((await answer.headerValue("location")) ?? "", PLATFORM_ADMIN_URL);
  expect(location.pathname + location.search).toBe("/sign-in?next=%2Fadmins");
  const { problems, nonce } = headerProblems("/admins", await answer.headersArray());
  expect(problems).toEqual([]);
  expect(nonce).toBeDefined();
  expect(await adminCookiesOf(context)).toEqual([]);
});

test("the sign-in sets the challenge cookie, then the session cookies, each HttpOnly, Secure and SameSite=Strict [PAD-016 step 2]", async () => {
  // Back to the stack's own host: Next.js writes a middleware redirect's loopback host as `localhost`.
  await visit("/sign-in", "/sign-in", "Sign in");
  await page.getByLabel("E-mail address").fill(admin.email);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in/mfa");
  await expect(page.getByLabel("Authentication code")).toBeVisible();
  // The password step writes the MFA challenge only, never a session cookie.
  expect(await adminCookiesOf(context)).toEqual([
    { name: "__Host-vxa_mfa", httpOnly: true, secure: true, sameSite: "Strict", path: "/" },
  ]);
  await visit("/sign-in/mfa", "/sign-in/mfa", "Two-factor authentication");

  await page.getByLabel("Authentication code").fill(await admin.authenticator.nextCode());
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page).toHaveTitle(adminTitle("Dashboard"));
  // The code step replaces the challenge with the session.
  expect(await adminCookiesOf(context)).toEqual(SESSION_COOKIES);
  await answers.settled();
  expect([...answers.cookiesSet].sort()).toEqual(["__Host-vxa_at", "__Host-vxa_mfa", "__Host-vxa_rt"]);
  expect([...answers.cookiesDeleted]).toEqual(["__Host-vxa_mfa"]);
});

/** A page route the journey opens: its route, path, title (a pattern for a not-found page) and status (200). */
type PageVisit = readonly [AdminRoute, string, string | RegExp, number?];

// The page routes are split over three steps, so no step comes near Playwright's 30 seconds on a slower runner.
test("the overview, OTA, job, queue and plan pages answer with the admin's headers, their scripts with the nonce and robots told not to index [PAD-016 step 2]", async () => {
  const pages: readonly PageVisit[] = [
    ["/", "/", "Dashboard"],
    ["/tenants", "/tenants", "Tenants"],
    ["/tenants/[tenantId]", `/tenants/${unknownId("ten")}`, /./, 404],
    ["/provisioning-jobs", "/provisioning-jobs", "Provisioning jobs"],
    ["/provisioning-jobs/[jobId]", `/provisioning-jobs/${unknownId("job")}`, /./, 404],
  ];
  for (const [route, path, title, status] of pages) {
    await visit(route, path, title, status);
  }
  // The queues and the plans, and a queue and a plan they list.
  await visit("/queues", "/queues", "Queues");
  const queue = await page.getByRole("main").locator('a[href^="/queues/"]').first().getAttribute("href");
  await visit("/plans", "/plans", "Plans");
  const plan = await page.getByRole("main").locator('a[href^="/plans/"]').first().getAttribute("href");
  if (queue === null || plan === null) {
    throw new Error("the console lists no queue or no plan");
  }
  await visit("/queues/[queue]", queue, "Queues");
  await visit("/plans/[planCode]", plan, "Plan");
});

test("the billing, Amadeus, settlement and domain pages answer with the admin's headers, their scripts with the nonce and robots told not to index [PAD-016 step 2]", async () => {
  const pages: readonly PageVisit[] = [
    ["/subscriptions", "/subscriptions", "Subscriptions"],
    ["/subscriptions/[subscriptionId]", `/subscriptions/${unknownId("sub")}`, /./, 404],
    ["/invoices", "/invoices", "Invoices"],
    ["/stripe-events", "/stripe-events", "Stripe events"],
    ["/amadeus/accounts", "/amadeus/accounts", "Amadeus accounts"],
    ["/amadeus/offices", "/amadeus/offices", "Office pool"],
    ["/settlements", "/settlements", "Settlements"],
    ["/settlements/[settlementId]", `/settlements/${unknownId("stl")}`, /./, 404],
    ["/domains", "/domains", "Domains"],
  ];
  for (const [route, path, title, status] of pages) {
    await visit(route, path, title, status);
  }
});

test("the account, admin, audit and not-found pages answer with the admin's headers, their scripts with the nonce and robots told not to index [PAD-016 step 2]", async () => {
  const pages: readonly PageVisit[] = [
    ["/accounts", "/accounts", "Accounts"],
    ["/accounts/[accountId]", `/accounts/${adminAccountId}`, "Account"],
    ["/admins", "/admins", "Platform admins"],
    ["/audit", "/audit", "Audit log"],
    ["/_not-found", "/pad016-no-such-page", /./, 404],
  ];
  for (const [route, path, title, status] of pages) {
    await visit(route, path, title, status);
  }
});

test("the middleware refreshes an expired access cookie, and the new session cookies are SameSite=Strict [PAD-016 step 2]", async () => {
  const before = await context.cookies(PLATFORM_ADMIN_URL);
  await context.clearCookies({ name: "__Host-vxa_at" });
  const response = await page.goto("/admins");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(adminTitle("Platform admins"));
  // The page's own answer carries the refreshed session (both tokens replaced), with the admin's attributes.
  const lines = valuesOf((await response?.headersArray()) ?? [], "set-cookie");
  expect(lines.map((line) => line.split("=")[0]).sort()).toEqual(["__Host-vxa_at", "__Host-vxa_rt"]);
  expect(lines.flatMap(setCookieProblems)).toEqual([]);
  expect(await adminCookiesOf(context)).toEqual(SESSION_COOKIES);
  const after = await context.cookies(PLATFORM_ADMIN_URL);
  const valueOf = (cookies: typeof after, name: string): string | undefined =>
    cookies.find((cookie) => cookie.name === name)?.value;
  expect(valueOf(after, "__Host-vxa_rt") === valueOf(before, "__Host-vxa_rt")).toBe(false);
});

test("the route handlers answer with the admin's headers: the CSV downloads and the health routes [PAD-016 step 2]", async () => {
  const handlers: readonly (readonly [AdminRoute, string, number, RegExp])[] = [
    [
      "/audit/export.csv",
      `/audit/export.csv?${new URLSearchParams({ actorAccountId: adminAccountId, from: utcDay(-1), to: utcDay(1) }).toString()}`,
      200,
      /^text\/csv/,
    ],
    // A statement no row has: `404` before any file.
    [
      "/settlements/[settlementId]/lines.csv",
      `/settlements/${unknownId("stl")}/lines.csv`,
      404,
      /^text\/plain/,
    ],
    ["/health/live", "/health/live", 200, /^application\/json/],
    ["/health/ready", "/health/ready", 200, /^application\/json/],
  ];
  for (const [route, path, status, type] of handlers) {
    const answer: APIResponse = await context.request.get(path, { maxRedirects: 0 });
    expect(answer.status(), path).toBe(status);
    expect(answer.headers()["content-type"] ?? "", path).toMatch(type);
    const pathname = new URL(answer.url()).pathname;
    answers.check(pathname, answer.headersArray());
    expect(headerProblems(pathname, answer.headersArray()).problems, path).toEqual([]);
    if (route === "/audit/export.csv") {
      expect(answer.headers()["cache-control"]).toBe("no-store");
      expect(answer.headers()["content-disposition"] ?? "").toMatch(/^attachment; filename="velexis-audit-/);
    }
    visited.add(route);
  }
});

test("the admin's own portal session, which works on the portal, opens no console page [PAD-016 step 2]", async ({
  browser,
}) => {
  // The platform API refuses the portal's access token on the admin surface: another audience.
  await expect(
    callPlatformApi({
      operation: "adminGetMe",
      method: "GET",
      path: "/v1/admin/me",
      endUserIp: admin.endUserIp,
      accessToken: portalSession.accessToken,
    }),
  ).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" } satisfies Partial<PlatformApiError>);

  const portalOnly = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  try {
    answers.watch(portalOnly);
    await addSessionCookies(portalOnly, "portal", portalSession);
    // The session works on the portal: its dashboard, without a redirect to the portal's sign-in.
    const onPortal = await portalOnly.request.get(`${PORTAL_URL}/dashboard`, { maxRedirects: 0 });
    expect(onPortal.status()).toBe(200);

    const portalPage = await portalOnly.newPage();
    const adminAnswer = portalPage.waitForResponse(
      (response) => new URL(response.url()).pathname === "/" && response.request().method() === "GET",
    );
    await portalPage.goto("/");
    const sentAway = await adminAnswer;
    // The browser did send the portal's session to the admin (one host for both in the stack): names only.
    expect(cookieNamesSent(await sentAway.request().allHeaders())).toEqual([
      "__Host-vxp_at",
      "__Host-vxp_rt",
    ]);
    expect(sentAway.status()).toBe(303);
    expect(new URL((await sentAway.headerValue("location")) ?? "", PLATFORM_ADMIN_URL).pathname).toBe(
      "/sign-in",
    );
    await expect(portalPage).toHaveTitle(adminTitle("Sign in"));
    // The admin set no cookie of its own; the portal's two are the fixture's.
    expect(await adminCookiesOf(portalOnly)).toEqual([]);
  } finally {
    await answers.settled();
    await portalOnly.close();
  }

  // The portal's tokens in the admin's own cookie names: the access token is of another audience, so the middleware
  // refreshes with the refresh token, which the admin's refresh refuses; both cookies are deleted, and the console
  // answers its sign-in.
  const swapped = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  try {
    answers.watch(swapped);
    await addSessionCookies(swapped, "admin", portalSession);
    const swappedPage = await swapped.newPage();
    const adminAnswer = swappedPage.waitForResponse(
      (response) => new URL(response.url()).pathname === "/" && response.request().method() === "GET",
    );
    await swappedPage.goto("/");
    const refused = await adminAnswer;
    expect(cookieNamesSent(await refused.request().allHeaders())).toEqual(["__Host-vxa_at", "__Host-vxa_rt"]);
    expect(refused.status()).toBe(303);
    expect(new URL((await refused.headerValue("location")) ?? "", PLATFORM_ADMIN_URL).pathname).toBe(
      "/sign-in",
    );
    const deleted = valuesOf(await refused.headersArray(), "set-cookie");
    expect(deleted.map((line) => line.split("=")[0]).sort()).toEqual(["__Host-vxa_at", "__Host-vxa_rt"]);
    expect(deleted.flatMap(setCookieProblems)).toEqual([]);
    expect(await adminCookiesOf(swapped)).toEqual([]);
  } finally {
    await answers.settled();
    await swapped.close();
  }
});

test("Sign out deletes the session cookies with the same attributes, and the console asks for a sign-in again [PAD-016 step 2]", async () => {
  await page.goto("/");
  await expect(page).toHaveTitle(adminTitle("Dashboard"));
  const signOutAnswer = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/sign-out" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  const signOut = await signOutAnswer;
  expect(signOut.status()).toBe(303);
  const deleted = valuesOf(await signOut.headersArray(), "set-cookie");
  expect(deleted.map((line) => line.split("=")[0]).sort()).toEqual(["__Host-vxa_at", "__Host-vxa_rt"]);
  expect(deleted.flatMap(setCookieProblems)).toEqual([]);
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("signedOut") === "1");
  await expect(page).toHaveTitle(adminTitle("Sign in"));
  expect(await adminCookiesOf(context)).toEqual([]);
  visited.add("/sign-out");

  const again = await page.goto("/admins");
  expect(again?.request().redirectedFrom()?.url()).toBe(`${PLATFORM_ADMIN_URL}/admins`);
});

test("every answer of the journey carried the admin's headers and cookie attributes, and every route was visited [PAD-016 step 2]", async () => {
  await answers.settled();
  expect([...visited].sort((a, b) => a.localeCompare(b))).toEqual(
    Object.keys(ROUTES).sort((a, b) => a.localeCompare(b)),
  );
  expect(answers.problems).toEqual([]);
  test.info().annotations.push({
    type: "answers checked",
    description: `${answers.answers} answers of the platform admin (on ${STACK_HOST})`,
  });
  expect(answers.answers).toBeGreaterThan(Object.keys(ROUTES).length);
});
