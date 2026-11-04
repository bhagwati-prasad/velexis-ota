// Accessibility and security headers on every route of the OTA admin (OAD-019 step 1; ota/admin/README.md §5, §10 and
// §12, ADR-0014, the shared checks of platform task PAD-016): against the built OTA admin, portal and OTA API, so the
// journey needs `E2E_WITH_OTA=1` (the e2e workflow sets it).
//
//   the owner opens the console from the portal → every route of the built OTA admin, one by one: its page passes axe
//   (WCAG 2.2 A and AA, no serious or critical violation) and its answer carries the admin's headers → the session's
//   own routes (/auth/refresh, the single sign-on's refusal, sign-out and /signed-out) and the health routes → every
//   HTML, RSC and JavaScript answer the browser received holds no NEXT_PUBLIC_ name, no secret of the OTA admin's
//   configuration and no token
//
// "Every route" is the route list of the build the stack runs: `ota/admin/.next/app-path-routes-manifest.json`. The
// first step compares it with this journey's own list, and the last step checks that each was visited, so a route a
// later task adds fails here until the journey covers it.
//
// The headers (README §10). An answer the middleware sees (every page, RSC request, server action and session route)
// carries the admin's policy with a fresh nonce of its own, and nothing else as its Content-Security-Policy:
//   default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
//   font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'
// and every script element of its HTML carries that nonce. The answers it does not see (Next.js's static files, the
// health routes) carry exactly next.config.ts's `frame-ancestors 'none'`. Both are checked on every answer the browser
// receives from the OTA admin, by the middleware's matcher. Every answer of the OTA admin has `Referrer-Policy:
// strict-origin-when-cross-origin` and `X-Content-Type-Options: nosniff`, and none has `X-Powered-By` or the request
// headers the middleware hands to the page (`x-nonce`, `x-velexis-page-path`). Every page asks search engines not to
// index it (`<meta name="robots" content="noindex, nofollow">`; PAD-016's `X-Robots-Tag` is the platform admin's), and
// a browser that holds only the portal's session gets no console page (PAD-016's portal cookie check). Caddy adds HSTS
// and X-Frame-Options on the VM (deploy/caddy/Caddyfile); the stack runs without Caddy, so they are the Caddy smoke
// test's.
//
// What leaks. The context's every answer from the OTA admin is kept as it arrives: the HTML documents through
// Playwright, every one of them; the RSC payloads (prefetches, navigations, server actions) also as the console's own
// JavaScript reads them, because Playwright alone cannot be relied on for them (`Network.getResponseBody` found "No data"
// for nearly every prefetch in a run without the copy), so a script added to each page of the OTA admin hands a copy of
// every RSC body its `fetch` receives to the journey (`exposeBinding`); every RSC answer must be read one way or the
// other, or have failed in the browser. The JavaScript files the browser loaded are fetched again at the end. Each must hold none of:
// the text `NEXT_PUBLIC_` (no such variable exists in this app, README §11; Next.js inlines such a variable into the
// browser's code, and leaves its name where it has none); the value of a `NEXT_PUBLIC_` variable of the journey's or
// the OTA admin's environment, in case a dependency reads one; the value of any secret-like variable of the OTA admin's
// environment in the stack (its service key among them); the tokens the browser held at any point (the staff session's
// access and refresh tokens before and after a refresh, the portal session's, the storefront customer's of the
// arrangement); nor anything shaped like a JWT, a staff refresh token, a portal token or a secret API key. A finding
// names the address and what was found, never the value.
//
// Arranged in `beforeAll` through the platform API and the OTA API (PADR-0017 item 5): the owner's OTA with its Amadeus
// test office (`newOwnerWithActiveOta`), its airline card switched on for its test storefront, a booking made through
// the OTA API as its storefront edge (`EdgeApi`) that waits in manual review (the stub's `ticketing-failed` scenario), so
// the booking, payment and dashboard pages show work for staff, and a storefront customer signed up through the same
// edge, for the customer pages. A fee rule and a content page are created through the console's own forms. The steps
// are tests in order (`mode: "serial"`) on the owner's browser context, made in `beforeAll`.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type APIResponse,
  type BrowserContext,
  type Page,
  type Response,
  type Route,
} from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y";
import {
  addSessionCookies,
  expect,
  newAccountContext,
  test,
  uniqueTestIp,
  type SessionTokens,
} from "../../support/fixtures";
import { uniqueEmail } from "../../support/mailpit";
import {
  bookAirlineCardTrip,
  EdgeApi,
  newOwnerWithActiveOta,
  openConsoleFromPortal,
  scriptReadableCookieNames,
  STAFF_COOKIES,
  switchAirlineCardOn,
  withTenantTx,
  type OwnedOta,
  type SeededBooking,
} from "../../support/ota";
import { newPassword, stack } from "../../support/seed";
import { OTA_ADMIN_URL, PORTAL_URL, REPO_ROOT, serviceEnv } from "../../support/stack";

test.describe.configure({ mode: "serial" });

/** The route list of the OTA admin build the stack runs (`next build` writes it). */
const ROUTES_MANIFEST = resolve(REPO_ROOT, "ota/admin/.next/app-path-routes-manifest.json");

/**
 * Every route of the OTA admin, as the build's route list names it, and the step of this journey that visits it.
 * A route the build has and this list lacks (or the other way round) fails the first step.
 */
const ROUTES = Object.freeze({
  "/": "dashboard and bookings",
  "/bookings": "dashboard and bookings",
  "/bookings/[bookingId]": "dashboard and bookings",
  "/payments": "payments and customers",
  "/payments/[paymentId]": "payments and customers",
  "/customers": "payments and customers",
  "/customers/[customerId]": "payments and customers",
  "/pnr": "Amadeus and support pages",
  "/queues": "Amadeus and support pages",
  "/queues/[queueId]": "Amadeus and support pages",
  "/shopping": "Amadeus and support pages",
  "/supplier-log": "Amadeus and support pages",
  "/portal": "Amadeus and support pages",
  "/settings/markups": "pricing settings",
  "/settings/markups/[id]": "pricing settings",
  "/settings/markups/new": "pricing settings",
  "/settings/fees": "pricing settings",
  "/settings/fees/new": "pricing settings",
  "/settings/fees/[id]": "pricing settings",
  "/settings/storefront": "storefront settings",
  "/settings/assets": "storefront settings",
  "/settings/templates": "storefront settings",
  "/settings/templates/[key]/[channel]/[locale]": "storefront settings",
  "/settings/pages": "content pages",
  "/settings/pages/[pageId]": "content pages",
  "/_not-found": "not found, refresh and health",
  "/auth/refresh": "not found, refresh and health",
  "/health/live": "not found, refresh and health",
  "/health/ready": "not found, refresh and health",
  "/sso": "single sign-on refusal",
  "/auth/sign-out": "sign-out",
  "/signed-out": "sign-out",
} as const);
type AdminRoute = keyof typeof ROUTES;

/** The OTA admin's title of a page (`%s · Velexis OTA admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis OTA admin`;

/** The admin's policy (README §10, src/middleware.ts) with `nonce` as the nonce of its scripts. */
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

/** next.config.ts's policy of the answers the middleware does not see. */
const STATIC_POLICY: Record<string, string[]> = { "frame-ancestors": ["'none'"] };

/** The request headers the middleware hands to the page, which no answer may carry. */
const REQUEST_ONLY_HEADERS = ["x-nonce", "x-velexis-page-path"] as const;

/** A CSP nonce as the middleware writes it: 128 random bits in base64. */
const NONCE = /^'nonce-([A-Za-z0-9+/]{22,}={0,2})'$/;

/** A policy's directives by name, each with its sources (`frame-ancestors 'none'` → `{ "frame-ancestors": ["'none'"] }`). */
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

/** The answer's headers as name (lower case) → every value, from Playwright's full list (security headers included). */
type HeaderList = readonly { readonly name: string; readonly value: string }[];

function valuesOf(headers: HeaderList, name: string): string[] {
  return headers.filter((header) => header.name.toLowerCase() === name).map((header) => header.value);
}

/** What every answer of the OTA admin carries, whatever its kind; the problems in words, empty when there are none. */
function commonHeaderProblems(headers: HeaderList): string[] {
  const problems: string[] = [];
  if (valuesOf(headers, "x-powered-by").length > 0) {
    problems.push("X-Powered-By is sent");
  }
  if (valuesOf(headers, "referrer-policy").join(",") !== "strict-origin-when-cross-origin") {
    problems.push("Referrer-Policy is not strict-origin-when-cross-origin");
  }
  if (valuesOf(headers, "x-content-type-options").join(",") !== "nosniff") {
    problems.push("X-Content-Type-Options is not nosniff");
  }
  for (const name of REQUEST_ONLY_HEADERS) {
    if (valuesOf(headers, name).length > 0) {
      problems.push(`the request header ${name} is sent back`);
    }
  }
  const policies = valuesOf(headers, "content-security-policy");
  if (policies.length !== 1) {
    problems.push(`${policies.length} Content-Security-Policy headers instead of one`);
  } else if (directivesOf(policies[0] ?? "")["frame-ancestors"]?.join(" ") !== "'none'") {
    problems.push("the Content-Security-Policy has no frame-ancestors 'none'");
  }
  return problems;
}

/** Every nonce the journey saw: each answer must have a fresh one. */
const nonces = new Set<string>();

/**
 * Checks the headers of an answer the middleware saw (a page or a session route): the common ones, then exactly the
 * admin's policy with a nonce no earlier answer had. Resolves to the nonce.
 */
function expectMiddlewareHeaders(headers: HeaderList): string {
  expect(commonHeaderProblems(headers)).toEqual([]);
  const directives = directivesOf(valuesOf(headers, "content-security-policy")[0] ?? "");
  const nonce = NONCE.exec(directives["script-src"]?.[1] ?? "")?.[1];
  if (nonce === undefined) {
    throw new Error("the Content-Security-Policy's script-src has no nonce");
  }
  expect(directives).toEqual(adminPolicy(nonce));
  expect(nonces.has(nonce)).toBe(false);
  nonces.add(nonce);
  return nonce;
}

/** Checks the headers of an answer the middleware does not see (a health route): the common ones and the fallback policy. */
function expectStaticHeaders(headers: HeaderList): void {
  expect(commonHeaderProblems(headers)).toEqual([]);
  expect(directivesOf(valuesOf(headers, "content-security-policy")[0] ?? "")).toEqual(STATIC_POLICY);
}

/**
 * Whether the OTA admin's middleware sees a request for `pathname`: its matcher (src/middleware.ts) takes every path
 * but Next.js's own files (`/_next/…`), the favicon and the health routes.
 */
function middlewareSees(pathname: string): boolean {
  return !(pathname.startsWith("/_next/") || pathname === "/favicon.ico" || pathname.startsWith("/health/"));
}

/**
 * The Content-Security-Policy an answer for `pathname` must carry, checked exactly: the admin's policy with a nonce
 * where the middleware saw the request, next.config.ts's otherwise. Resolves to the problem in words, or to the nonce
 * (`undefined` for an answer the middleware does not see).
 */
function policyOf(
  pathname: string,
  headers: HeaderList,
): { readonly problem: string } | { readonly nonce: string | undefined } {
  const directives = directivesOf(valuesOf(headers, "content-security-policy")[0] ?? "");
  if (!middlewareSees(pathname)) {
    return isDeepStrictEqual(directives, STATIC_POLICY)
      ? { nonce: undefined }
      : { problem: "the Content-Security-Policy is not next.config.ts's" };
  }
  const nonce = NONCE.exec(directives["script-src"]?.[1] ?? "")?.[1];
  return nonce !== undefined && isDeepStrictEqual(directives, adminPolicy(nonce))
    ? { nonce }
    : { problem: "the Content-Security-Policy is not the admin's policy with a nonce" };
}

/** The script elements of an HTML page, as written. */
const SCRIPT_TAG = /<script\b[^>]*>/g;
/** The robots meta element of the root layout's metadata (`robots: { index: false, follow: false }`). */
const NO_INDEX = /<meta name="robots" content="noindex, nofollow"\s*\/?>/;

/**
 * Checks a page's answer (`response`, HTML): the headers of an answer the middleware saw, every script element with the
 * answer's nonce (there is at least one: the page's own Next.js scripts), and the robots meta element.
 */
async function expectPageHeaders(response: Response): Promise<void> {
  const nonce = expectMiddlewareHeaders(await response.headersArray());
  expect(valuesOf(await response.headersArray(), "content-type").join(",")).toMatch(/^text\/html/);
  const html = await response.text();
  const scripts = html.match(SCRIPT_TAG) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((tag) => !tag.includes(` nonce="${nonce}"`))).toEqual([]);
  expect(html).toMatch(NO_INDEX);
}

// ---- What may not leak --------------------------------------------------------------------------------------------

/** One thing found in an answer: where, and what kind of value (never the value). */
interface Leak {
  readonly url: string;
  readonly found: string;
}

/** Shapes of tokens and keys that no answer of the OTA admin may carry. */
const TOKEN_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "a JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/ },
  { name: "a staff refresh token", pattern: /srt_[0-9A-HJKMNP-TV-Z]{26}[A-Za-z0-9_-]{43}/ },
  { name: "a portal token", pattern: /ptk_[A-Za-z0-9]{24,64}/ },
  { name: "a secret API key", pattern: /\b(?:sk|rk)_(?:test|live|dev|svc)_[A-Za-z0-9_]{8,}/ },
];

/** A variable of the OTA admin's environment whose value is a secret (or names where one is kept). */
const SECRET_VARIABLE = /KEY|SECRET|TOKEN|PASSWORD|PEPPER|DSN|CREDENTIAL/;

/**
 * The values no answer may hold, by variable name: the secret-like ones of the OTA admin's environment in the stack
 * (`serviceEnv`), and those of any `NEXT_PUBLIC_` variable there or in the journey's own environment, which the build
 * shares in CI (turbo.json passes `NEXT_PUBLIC_*` to every build): Next.js would inline such a value where code reads it.
 */
function adminSecrets(): Map<string, string> {
  const secrets = new Map<string, string>();
  const admin = serviceEnv("ota-admin", stack());
  for (const [name, value] of Object.entries(admin)) {
    if (!name.startsWith("PUBLIC_") && SECRET_VARIABLE.test(name) && value.length >= 8) {
      secrets.set(`the value of ${name}`, value);
    }
  }
  for (const [name, value] of [...Object.entries(process.env), ...Object.entries(admin)]) {
    if (name.startsWith("NEXT_PUBLIC_") && value !== undefined && value.length >= 8) {
      secrets.set(`the value of ${name}`, value);
    }
  }
  return secrets;
}

/** The values that may not appear in any answer, by what they are; filled as the journey goes on. */
const secrets = new Map<string, string>();

/** The cookies that hold tokens: the staff session's (README §4) and the portal session's. */
const TOKEN_COOKIES: readonly string[] = [
  "__Host-vx_staff_at",
  "__Host-vx_staff_rt",
  "__Host-vxp_at",
  "__Host-vxp_rt",
];

/** Remembers the tokens in `context`'s session cookies, as they are now, as the secrets they are. */
async function rememberCookies(target: BrowserContext): Promise<void> {
  for (const cookie of await target.cookies()) {
    if (TOKEN_COOKIES.includes(cookie.name) && cookie.value !== "") {
      secrets.set(`a token of the cookie ${cookie.name} (${secrets.size})`, cookie.value);
    }
  }
}

/** Remembers the tokens of a session as secrets. */
function rememberSession(label: string, session: Pick<SessionTokens, "accessToken" | "refreshToken">): void {
  secrets.set(`${label}'s access token`, session.accessToken);
  secrets.set(`${label}'s refresh token`, session.refreshToken);
}

/** What `body` (an answer of `url`) holds that it may not. */
function leaksIn(url: string, body: string): Leak[] {
  const leaks: Leak[] = [];
  if (body.includes("NEXT_PUBLIC_")) {
    leaks.push({ url, found: "the text NEXT_PUBLIC_" });
  }
  for (const [what, value] of secrets) {
    if (body.includes(value)) {
      leaks.push({ url, found: what });
    }
  }
  for (const { name, pattern } of TOKEN_SHAPES) {
    if (pattern.test(body)) {
      leaks.push({ url, found: name });
    }
  }
  return leaks;
}

/** An answer of the OTA admin, kept as it arrived. */
interface KeptAnswer {
  readonly url: string;
  readonly kind: "html" | "rsc";
  readonly body: string;
}

/** The binding through which a page of the OTA admin hands the journey a copy of each RSC body its `fetch` receives. */
const COPY_RSC_BINDING = "__oad019CopyRscBody";

/**
 * In the browser, before any script of a document of `origin` (the OTA admin): wraps `fetch`, so that every RSC answer
 * (`text/x-component`) the page receives is also read from a copy (`Response.clone()`) and handed to the binding
 * `binding` with its address. The page's own answer is untouched. Playwright sends this function's source to the page,
 * so it uses nothing from its module.
 */
function copyRscBodies({ origin, binding }: { readonly origin: string; readonly binding: string }): void {
  if (window.location.origin !== origin) {
    return;
  }
  const original = window.fetch.bind(window);
  // The parameter and answer types come from `fetch` itself (the module's `Response` is Playwright's).
  window.fetch = async (input, init) => {
    const answer = await original(input, init);
    if ((answer.headers.get("content-type") ?? "").startsWith("text/x-component")) {
      void answer
        .clone()
        .text()
        .then(
          (body) => {
            const copy = (window as unknown as Record<string, unknown>)[binding];
            if (typeof copy === "function") {
              void (copy as (url: string, body: string) => Promise<void>)(answer.url, body);
            }
          },
          () => undefined,
        );
    }
    return answer;
  };
}

/** How often each address was counted. */
class Tally {
  private readonly counts = new Map<string, number>();

  add(url: string): void {
    this.counts.set(url, this.of(url) + 1);
  }

  of(url: string): number {
    return this.counts.get(url) ?? 0;
  }

  get size(): number {
    return [...this.counts.values()].reduce((sum, count) => sum + count, 0);
  }

  entries(): [string, number][] {
    return [...this.counts];
  }
}

/**
 * Watches every answer of the OTA admin in a browser context: the headers every answer must carry (the common ones and
 * exactly the policy its kind needs, with a nonce no other answer had where the middleware saw it; problems collected,
 * checked by the last step), the HTML and RSC bodies kept for the leak check, and the addresses of the JavaScript files,
 * which the last step fetches again. HTML bodies are read through Playwright; RSC bodies through Playwright where
 * Chromium kept them, and from the page's own copy in every case (`copyRscBodies`).
 */
class AdminAnswers {
  readonly headerProblems: string[] = [];
  readonly kept: KeptAnswer[] = [];
  /** HTML answers whose body Playwright could not read. */
  readonly unreadHtml: string[] = [];
  readonly scripts = new Set<string>();
  /** The RSC answers seen, those read through Playwright, those copied in the page and the requests that failed. */
  readonly rscSeen = new Tally();
  readonly rscRead = new Tally();
  readonly rscCopied = new Tally();
  readonly failed = new Tally();
  private readonly nonces = new Map<string, string>();
  private readonly pending: Promise<void>[] = [];

  async watch(context: BrowserContext): Promise<void> {
    await context.exposeBinding(COPY_RSC_BINDING, (_source, url: unknown, body: unknown) => {
      if (typeof url === "string" && typeof body === "string" && url.startsWith(`${OTA_ADMIN_URL}/`)) {
        this.rscCopied.add(url);
        this.kept.push({ url, kind: "rsc", body });
      }
    });
    await context.addInitScript(copyRscBodies, {
      origin: new URL(OTA_ADMIN_URL).origin,
      binding: COPY_RSC_BINDING,
    });
    context.on("response", (response) => {
      if (response.url().startsWith(`${OTA_ADMIN_URL}/`)) {
        this.pending.push(this.take(response));
      }
    });
    context.on("requestfailed", (request) => {
      if (request.url().startsWith(`${OTA_ADMIN_URL}/`)) {
        this.failed.add(request.url());
      }
    });
  }

  private async take(response: Response): Promise<void> {
    const url = response.url();
    const pathname = new URL(url).pathname;
    // Playwright has an answer's headers once the browser has them (the raw headers, security headers included). An
    // answer whose headers it cannot give is an answer the journey did not check: a problem too.
    let headers: HeaderList;
    try {
      headers = await response.headersArray();
    } catch {
      this.headerProblems.push(`${pathname}: its headers could not be read`);
      return;
    }
    for (const problem of commonHeaderProblems(headers)) {
      this.headerProblems.push(`${pathname}: ${problem}`);
    }
    const policy = policyOf(pathname, headers);
    if ("problem" in policy) {
      this.headerProblems.push(`${pathname}: ${policy.problem}`);
    } else if (policy.nonce !== undefined) {
      const earlier = this.nonces.get(policy.nonce);
      if (earlier !== undefined) {
        this.headerProblems.push(`${pathname}: the nonce of an earlier answer (${earlier})`);
      }
      this.nonces.set(policy.nonce, pathname);
    }
    const type = valuesOf(headers, "content-type").join(",");
    if (/javascript/.test(type)) {
      this.scripts.add(url);
      return;
    }
    const kind = /^text\/html/.test(type) ? "html" : /^text\/x-component/.test(type) ? "rsc" : undefined;
    if (kind === undefined || (response.status() >= 300 && response.status() < 400)) {
      return;
    }
    if (kind === "rsc") {
      this.rscSeen.add(url);
    }
    try {
      this.kept.push({ url, kind, body: await response.text() });
      if (kind === "rsc") {
        this.rscRead.add(url);
      }
    } catch {
      // Chromium kept no body for Playwright ("No data found for resource", seen for RSC prefetches). An RSC body is
      // then the page's copy; an HTML body has no other source, so the last step fails on it.
      if (kind === "html") {
        this.unreadHtml.push(url);
      }
    }
  }

  /** Waits until every answer seen so far is taken. */
  async settled(): Promise<void> {
    await Promise.all(this.pending);
  }

  /**
   * The RSC answers (by address) that were neither read through Playwright nor copied in the page, and whose request
   * did not fail in the browser: answers the leak check would have missed.
   */
  unscannedRsc(): string[] {
    return this.rscSeen
      .entries()
      .filter(
        ([url, seen]) => Math.max(this.rscRead.of(url), this.rscCopied.of(url)) + this.failed.of(url) < seen,
      )
      .map(([url]) => new URL(url).pathname);
  }
}

// ---- The journey --------------------------------------------------------------------------------------------------

let owned: OwnedOta;
let booking: SeededBooking;
let customerId: string;
let context: BrowserContext;
let page: Page;
const answers = new AdminAnswers();
/** The routes the journey visited, with their answers' headers checked. */
const visited = new Set<AdminRoute>();

/** Waits until `target` shows the OTA admin's page `title`, then runs axe and checks that no cookie is readable. */
async function expectAdminPage(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(adminTitle(title));
  await expectNoSeriousA11yViolations(target);
  expect(await scriptReadableCookieNames(target)).toEqual([]);
}

/**
 * Opens `path` (the page of `route`) as a new document, without a redirect: its answer `200` with the admin's headers
 * and nonce, then its title, axe and no readable cookie.
 */
async function visit(route: AdminRoute, path: string, title: string): Promise<void> {
  const response = await page.goto(path);
  if (response === null) {
    throw new Error(`${path} gave no answer`);
  }
  expect(response.status()).toBe(200);
  expect(response.request().redirectedFrom()).toBeNull();
  await expectPageHeaders(response);
  await expectAdminPage(page, title);
  visited.add(route);
}

/** The path of the current page of `target`. */
const pathOf = (target: Page): string => new URL(target.url()).pathname;

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "a11y-headers.e2e.ts needs the OTA backend and the OTA admin: run it with E2E_WITH_OTA=1 (the Amadeus stub, " +
        "the OTA worker, API and admin)",
    );
  }
  // Budget: a sign-up with its verification e-mail (up to 15 s), the OTA's set-up on the OTA worker (about 2 s locally;
  // PF-11 allows a minute), a booking and a customer sign-up through the OTA API and the stub (a few seconds) and the
  // single sign-on into the console (a few seconds, axe on the portal's page included): 120 s.
  test.setTimeout(120_000);
  for (const [what, value] of adminSecrets()) {
    secrets.set(what, value);
  }
  owned = await newOwnerWithActiveOta("Hedda Headers", "hdr");
  rememberSession("the owner's portal session", owned.session);
  await switchAirlineCardOn(owned.schema);
  const edge = new EdgeApi(owned.storefrontHost, uniqueTestIp());
  booking = await bookAirlineCardTrip(edge, {
    daysAhead: 64,
    traveller: { firstName: "Hanne", lastName: "Headers", dateOfBirth: "1984-03-17", gender: "FEMALE" },
    email: uniqueEmail("oad019-booking"),
    completionScenario: "ticketing-failed",
  });

  // A customer account of the OTA's storefront (signUp as its edge), with the terms version the storefront publishes.
  const storefront = (await edge.call("storefront.get", "GET", "/v1/storefront")) as {
    readonly legal?: { readonly termsVersion?: string };
  };
  const signUp = (await edge.call(
    "auth.signUp",
    "POST",
    "/v1/auth/sign-up",
    {
      email: uniqueEmail("oad019-customer"),
      password: newPassword(),
      firstName: "Carla",
      lastName: "Customer",
      marketingConsent: false,
      ...(storefront.legal?.termsVersion === undefined
        ? {}
        : { termsVersion: storefront.legal.termsVersion }),
    },
    201,
  )) as {
    readonly customer?: { readonly id?: string };
    readonly session?: { readonly accessToken?: string; readonly refreshToken?: string } | null;
  };
  if (signUp.customer?.id === undefined) {
    throw new Error("auth.signUp answered without the customer's id");
  }
  customerId = signUp.customer.id;
  if (signUp.session?.accessToken !== undefined && signUp.session.refreshToken !== undefined) {
    rememberSession("the storefront customer", {
      accessToken: signUp.session.accessToken,
      refreshToken: signUp.session.refreshToken,
    });
  }

  context = await newAccountContext(browser, owned.owner.account, OTA_ADMIN_URL);
  await answers.watch(context);
  await addSessionCookies(context, "portal", owned.session);
  page = await context.newPage();
  await openConsoleFromPortal(page, owned.ota.id);
  await rememberCookies(context);
});

test.afterAll(async () => {
  await context?.close();
});

test("the journey's route list is the built OTA admin's [OAD-019 step 1]", () => {
  const manifest = JSON.parse(readFileSync(ROUTES_MANIFEST, "utf8")) as Record<string, string>;
  const built = [...new Set(Object.values(manifest))].sort((a, b) => a.localeCompare(b));
  expect(built).toEqual(Object.keys(ROUTES).sort((a, b) => a.localeCompare(b)));
});

test("the dashboard and the bookings pages pass axe and send the admin's headers [OAD-019 step 1]", async () => {
  await visit("/", "/", "Dashboard");
  await visit("/bookings", "/bookings", "Bookings");
  await expect(
    page.getByRole("main").getByRole("link", { name: booking.reference, exact: true }),
  ).toBeVisible();
  await visit("/bookings/[bookingId]", `/bookings/${encodeURIComponent(booking.bookingId)}`, "Booking");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(booking.reference);
});

test("the payments and customers pages pass axe and send the admin's headers [OAD-019 step 1]", async () => {
  await visit("/payments", "/payments", "Payments");
  await visit("/payments/[paymentId]", `/payments/${encodeURIComponent(booking.paymentId)}`, "Payment");
  await visit("/customers", "/customers", "Customers");
  await visit("/customers/[customerId]", `/customers/${encodeURIComponent(customerId)}`, "Customer");
  await expect(page.getByRole("main").getByText("Carla", { exact: false }).first()).toBeVisible();
});

test("the PNR, queues, shopping, supplier log and portal pages pass axe and send the admin's headers [OAD-019 step 1]", async () => {
  await visit("/pnr", "/pnr", "PNR lookup");
  await visit("/queues", "/queues", "Queues");
  // The stored view of a queue of the OTA's office: no Amadeus call ("Read now" is not pressed).
  await visit(
    "/queues/[queueId]",
    `/queues/50?${new URLSearchParams({ officeId: owned.connection.officeId }).toString()}`,
    "Queue",
  );
  await visit("/shopping", "/shopping", "Shopping on behalf");
  await visit("/supplier-log", "/supplier-log", "Supplier log");
  await visit("/portal", "/portal", "Portal links");
});

test("the markup and fee rule pages pass axe and send the admin's headers [OAD-019 step 1]", async () => {
  await visit("/settings/markups", "/settings/markups", "Markup rules");
  const defaultRule = await page
    .getByRole("main")
    .getByRole("link", { name: "Default", exact: true })
    .getAttribute("href");
  if (defaultRule === null) {
    throw new Error("the markup rules list has no link to the default rule");
  }
  await visit("/settings/markups/[id]", defaultRule, "Markup rule");
  await visit("/settings/markups/new", "/settings/markups/new", "New markup rule");
  await visit("/settings/fees", "/settings/fees", "Fee rules");
  await visit("/settings/fees/new", "/settings/fees/new", "New fee rule");

  // A fee rule through the console's form, for the page of one rule.
  const form = page.getByRole("form", { name: "Create fee rule" });
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Service fee (OAD-019 journey)");
  await form.getByRole("textbox", { name: "Label", exact: true }).fill("Service fee");
  await form.getByRole("radio", { name: /^Booking service fee/ }).check();
  await form.getByRole("radio", { name: "Fixed amount", exact: true }).check();
  await form.getByRole("textbox", { name: "Fixed amount", exact: true }).fill("5.00");
  await form.getByRole("combobox", { name: "Computed" }).selectOption({ label: "Per booking" });
  await form.getByRole("button", { name: "Create fee rule" }).click();
  await page.waitForURL(/\/settings\/fees\/fee_[0-9A-Za-z]{16,40}$/);
  await visit("/settings/fees/[id]", pathOf(page), "Fee rule");
});

test("the storefront settings, images and e-mail template pages pass axe and send the admin's headers [OAD-019 step 1]", async () => {
  await visit("/settings/storefront", "/settings/storefront", "Storefront settings");
  await visit("/settings/assets", "/settings/assets", "Storefront images");
  await visit("/settings/templates", "/settings/templates", "E-mail templates");
  const locale = await withTenantTx(
    owned.schema,
    async (trx) =>
      (await trx.selectFrom("storefront_settings").select("default_locale").executeTakeFirstOrThrow())
        .default_locale,
  );
  await visit(
    "/settings/templates/[key]/[channel]/[locale]",
    `/settings/templates/booking.confirmed/email/${encodeURIComponent(locale)}`,
    "E-mail template",
  );
});

test("the content page pages pass axe and send the admin's headers [OAD-019 step 1]", async () => {
  await visit("/settings/pages", "/settings/pages", "Content pages");
  await visit("/settings/pages/[pageId]", "/settings/pages/new", "Content page");

  // A draft page through the console's form, for the page of one content page.
  const main = page.getByRole("main");
  await main
    .getByRole("textbox", { name: "Address", exact: true })
    .fill(`oad019-${randomBytes(3).toString("hex")}`);
  await main.getByRole("textbox", { name: "Title", exact: true }).fill("Accessibility statement");
  await main
    .getByRole("textbox", { name: "Body", exact: true })
    .fill("## Our promise\n\nEvery page works with a keyboard.");
  await main.getByRole("button", { name: "Create page" }).click();
  await page.waitForURL(/\/settings\/pages\/stp_[0-9A-Za-z]{16,40}$/);
  await visit("/settings/pages/[pageId]", pathOf(page), "Content page");
});

test("a page that does not exist, the refresh route and the health routes send the admin's headers [OAD-019 step 1]", async () => {
  // Not found: the root layout's not-found page, with the session, rendered per request with its nonce.
  const missing = await page.goto("/oad019-no-such-page");
  if (missing === null) {
    throw new Error("the missing page gave no answer");
  }
  expect(missing.status()).toBe(404);
  await expectPageHeaders(missing);
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  expect(await scriptReadableCookieNames(page)).toEqual([]);
  visited.add("/_not-found");

  // /auth/refresh renews the session and answers 303 to the page it was given.
  const refreshAnswer = page.waitForResponse(
    (response) =>
      response.url().startsWith(`${OTA_ADMIN_URL}/auth/refresh`) && response.request().method() === "GET",
  );
  await page.goto("/auth/refresh?next=%2Fportal");
  const refreshed = await refreshAnswer;
  expect(refreshed.status()).toBe(303);
  expect(new URL((await refreshed.headerValue("location")) ?? "", OTA_ADMIN_URL).pathname).toBe("/portal");
  expectMiddlewareHeaders(await refreshed.headersArray());
  await expectAdminPage(page, "Portal links");
  await rememberCookies(context);
  visited.add("/auth/refresh");

  // The health routes, which deploy.sh polls without a session: next.config.ts's headers.
  for (const route of ["/health/live", "/health/ready"] as const) {
    const health: APIResponse = await context.request.get(route);
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });
    expectStaticHeaders(health.headersArray());
    visited.add(route);
  }
});

test("the single sign-on's refusal page passes axe, and a portal session alone opens no console [OAD-019 step 1]", async ({
  browser,
}) => {
  // A form of the portal's origin that posts a well-formed portal token no one issued to /sso (the hand-off page's own
  // form, served by the journey: the portal mints a token only for a launch).
  const handOff = `${PORTAL_URL}/oad019-hand-off`;
  const unknownToken = `ptk_${randomBytes(32).toString("hex").slice(0, 43)}`;
  const formPage = await context.newPage();
  try {
    await formPage.route(handOff, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body:
          '<!doctype html><html lang="en"><head><title>Opening the OTA admin</title></head><body><main>' +
          "<h1>Opening the OTA admin</h1>" +
          `<form method="post" action="${OTA_ADMIN_URL}/sso">` +
          `<input type="hidden" name="portalToken" value="${unknownToken}">` +
          "<button>Continue</button></form></main></body></html>",
      }),
    );
    await formPage.goto(handOff);
    await expectNoSeriousA11yViolations(formPage);
    const ssoAnswer = formPage.waitForResponse(
      (response) => response.url() === `${OTA_ADMIN_URL}/sso` && response.request().method() === "POST",
    );
    await formPage.getByRole("button", { name: "Continue" }).click();
    const refused = await ssoAnswer;
    // The OTA API does not know the token: 401 PORTAL_TOKEN_INVALID, the refusal page with the admin's headers.
    expect(refused.status()).toBe(401);
    expectMiddlewareHeaders(await refused.headersArray());
    expect(valuesOf(await refused.headersArray(), "content-type").join(",")).toMatch(/^text\/html/);
    await formPage.waitForURL(`${OTA_ADMIN_URL}/sso`);
    await expect(
      formPage.getByRole("heading", { level: 1, name: "The console could not be opened" }),
    ).toBeVisible();
    await expectAdminPage(formPage, "The console could not be opened");
    // The page names no token: neither the one posted nor any other (the leak check below reads its body too).
    expect(await refused.text()).not.toContain(unknownToken);
    visited.add("/sso");
  } finally {
    await formPage.close();
  }
  // The owner's console session is untouched by the refused sign-on.
  await page.goto("/bookings");
  await expectAdminPage(page, "Bookings");

  // The portal's session cookie does not open the console: the OTA admin answers 303 to the portal's console page and
  // sets no staff cookie.
  const portalOnly = await newAccountContext(browser, owned.owner.account, OTA_ADMIN_URL);
  try {
    await answers.watch(portalOnly);
    await addSessionCookies(portalOnly, "portal", owned.session);
    const portalPage = await portalOnly.newPage();
    const adminAnswer = portalPage.waitForResponse(
      (response) => response.url() === `${OTA_ADMIN_URL}/bookings` && response.request().method() === "GET",
    );
    await portalPage.goto("/bookings");
    const sentAway = await adminAnswer;
    expect(sentAway.status()).toBe(303);
    expect(await sentAway.headerValue("location")).toBe(`${PORTAL_URL}/console`);
    expectMiddlewareHeaders(await sentAway.headersArray());
    await expect(portalPage).toHaveTitle("Open the OTA admin · Velexis");
    await expectNoSeriousA11yViolations(portalPage);
    // Names only: a failure never prints a cookie's value.
    const staffCookies = (await portalOnly.cookies(OTA_ADMIN_URL))
      .map((cookie) => cookie.name)
      .filter((name) => (STAFF_COOKIES as readonly string[]).includes(name));
    expect(staffCookies).toEqual([]);
    // Its answers are taken (headers and bodies) while the context is still open.
    await answers.settled();
  } finally {
    await portalOnly.close();
  }
});

test("sign-out answers with the admin's headers, and /signed-out passes axe [OAD-019 step 1]", async () => {
  await rememberCookies(context);
  await page.goto("/portal");
  await expectAdminPage(page, "Portal links");
  const signOutAnswer = page.waitForResponse(
    (response) =>
      response.url() === `${OTA_ADMIN_URL}/auth/sign-out` && response.request().method() === "POST",
  );
  const signedOutAnswer = page.waitForResponse(
    (response) => response.url() === `${OTA_ADMIN_URL}/signed-out` && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const signOut = await signOutAnswer;
  expect(signOut.status()).toBe(303);
  expect(await signOut.headerValue("location")).toBe(`${OTA_ADMIN_URL}/signed-out`);
  expectMiddlewareHeaders(await signOut.headersArray());
  visited.add("/auth/sign-out");

  const signedOut = await signedOutAnswer;
  expect(signedOut.status()).toBe(200);
  await expectPageHeaders(signedOut);
  await expectAdminPage(page, "Signed out");
  await expect(page.getByRole("heading", { level: 1, name: "You have signed out" })).toBeVisible();
  // The session's cookies are gone; the tenant cookie stays for "Back to the portal".
  const left = (await context.cookies(OTA_ADMIN_URL))
    .map((cookie) => cookie.name)
    .filter((name) => (STAFF_COOKIES as readonly string[]).includes(name));
  expect(left).toEqual(["__Host-vx_tenant"]);
  visited.add("/signed-out");
});

test("no HTML, RSC or JavaScript answer of the OTA admin holds a NEXT_PUBLIC_ value, a secret or a token [OAD-019 step 1]", async () => {
  await answers.settled();
  // Every route was visited, and every answer the browser received carried the common headers and exactly the policy
  // of its kind, each nonce its own.
  expect([...visited].sort((a, b) => a.localeCompare(b))).toEqual(
    Object.keys(ROUTES).sort((a, b) => a.localeCompare(b)),
  );
  expect(answers.headerProblems).toEqual([]);

  // The HTML pages and RSC payloads as they arrived (every page of the journey, its prefetches, navigations and server
  // actions): every HTML body read, every RSC body read or copied in the page unless its request failed.
  expect(answers.unreadHtml).toEqual([]);
  expect(answers.unscannedRsc()).toEqual([]);
  const html = answers.kept.filter((answer) => answer.kind === "html");
  expect(html.length).toBeGreaterThanOrEqual(Object.keys(ROUTES).length - 6);
  expect(answers.rscCopied.size).toBeGreaterThan(0);
  const leaks = answers.kept.flatMap((answer) => leaksIn(answer.url, answer.body));

  // The JavaScript files the browser loaded, fetched again (they are immutable build files).
  expect(answers.scripts.size).toBeGreaterThan(0);
  for (const url of answers.scripts) {
    const script = await context.request.get(url);
    expect(script.status()).toBe(200);
    expect(commonHeaderProblems(script.headersArray())).toEqual([]);
    leaks.push(...leaksIn(url, await script.text()));
  }
  test.info().annotations.push({
    type: "answers checked",
    description:
      `${html.length} HTML, ${answers.rscSeen.size} RSC (${answers.rscRead.size} read through Playwright, ` +
      `${answers.rscCopied.size} copied in the page, ${answers.failed.size} requests failed in the browser), ` +
      `${answers.scripts.size} JavaScript`,
  });
  expect(leaks).toEqual([]);
});
