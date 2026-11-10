// The security headers, cookies and answers of the portal (PFE-028 step 4; platform/frontend/README.md §6 "Auth cookies
// and session" and §7 "Security headers", PADR-0007 point 4, PADR-0008 item 4, ADR-0008), project `portal`:
//
//   signed out: every public page, and a signed-in page answers `303` to the sign-in → the owner signs in through the
//   browser: the password step sets the challenge cookie, the code step the session cookies → every page route of the
//   built portal, one by one → the e-mail links: the verification link (in a visitor's browser), the reset link and an
//   invitation link → a new API key and the OTA's initial test keys, each shown once → "Open console"'s hand-off page →
//   the access cookie expires and the middleware refreshes the session → the route handlers → an admin of the live OTA
//   without MFA on the MFA enrolment page (PFE-030) → "Sign out" deletes the session cookies → every answer of the
//   journey checked, and no answer holds a token or a key it should not
//
// The headers. Every answer the browser receives from the portal (pages, RSC requests, server actions, redirects,
// Next.js's static files, the route handlers) carries `X-Content-Type-Options: nosniff`, the portal's
// `Permissions-Policy` and its `Referrer-Policy`, and no `X-Powered-By`. The referrer policy is
// `strict-origin-when-cross-origin`, except `no-referrer` on the token pages (`/verify-email`, and the answer of a
// `/reset-password?token=…` or `/invitations/accept?token=…` link, which moves the token into its cookie) and
// `strict-origin` on the hand-off page of "Open console". An answer the middleware sees (every path but Next.js's static
// files, the favicon and the health routes) carries exactly the portal's Content-Security-Policy with a nonce no other
// answer had, `frame-ancestors 'none'` among its directives:
//   default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
//   font-src 'self'; connect-src 'self'; form-action 'self' <the OTA admin's origin>; frame-ancestors 'none';
//   base-uri 'self'; object-src 'none'
// (the hand-off page's `form-action` is the OTA admin's origin alone), and every script element of a page carries that
// nonce. Caddy adds HSTS and X-Frame-Options on the VM (deploy/caddy/Caddyfile); the stack runs without Caddy.
//
// The cookies. Every cookie the portal sets or deletes is one of its own (`__Host-vxp_…`) and carries `HttpOnly`,
// `Secure` and `Path=/` without a `Domain`, with its `SameSite`: `Lax` for the session (`at`, `rt`), the return path
// (`next`) and Stripe Connect's (`connect`), `Strict` for the MFA challenge (`mfa`) and the tokens moved out of e-mail
// links (`reset`, `invite`); the browser keeps them so.
//
// The answers. No answer of the portal (page HTML, RSC payloads, server actions, scripts, JSON, text) holds an access
// token (a JWT: its `eyJ…` header, payload and signature) or the value of any token cookie the journey saw set (`at`,
// `rt`, `mfa`, `reset`, `invite`); a portal token (`ptk_…`) is only in the hand-off page's one hidden `portalToken`
// field, which PADR-0007 point 4 makes its carrier (the navigation to the OTA admin's `/sso` is cancelled in this
// browser context, so the browser stays on the page and the token is never redeemed); and a full API key (`pk_`/`sk_`
// of test or live and 40 characters) is only in the server action answer that shows it once, never in any other answer.
// Every page, RSC payload, script and server action answer is read: the journey reads a page's answers before it leaves
// the page (the browser drops them then), and a GET that the browser dropped before its end (an RSC prefetch the next
// navigation cancelled) is fetched again with the same request headers from the same browser context (so with its
// cookies), and that answer is checked as well. A server action's answer cannot be asked for again, and the browser
// does not always keep its streamed body, so every server action is intercepted (lead decision (13b) of 2026-11-10,
// FIX-W47-PLATFORM): each browser context routes its `POST`s that carry the `Next-Action` header (`context.route`),
// sends them itself (`route.fetch()`, the context's cookies included, no redirect followed), records the answer's
// headers and whole body, and hands that very answer to the page (`route.fulfill({ response })`). A server action that
// ends with `redirect()` answers `303` without a `Location` and with the RSC payload of the page it leads to, which is
// read like any answer; only a redirect the browser follows has no body. Any answer the journey could not read, a server
// action's included, is named in the last step's annotation and fails that step. (Routing turns the browser's HTTP
// cache off for the context, so the static scripts are fetched, and checked, on every page.)
//
// Arranged in `beforeAll` through the platform API (PADR-0017 item 5): the owner's active OTA (`newOwnerWithActiveOta`
// with MFA, set up by the OTA worker, so the journey needs `E2E_WITH_OTA=1` and fails at once without it); an admin, a
// verified account without MFA that the owner invites and that accepts with the token of its invitation e-mail; a
// pending invitation to an address of the journey's own; then the OTA goes live: `meetLivePreconditions` of
// support/ota.ts meets what the stack cannot reach as velexis_migrator fixtures (as OFE-022's, PFE-027's and PFE-030's
// journeys) and the owner's goLive switches it, with the step-up of the owner's TOTP sign-in. The owner has MFA; the
// admin meets the enrolment gate on purpose, as the page's subject. Pages with an id of no row (a statement) answer
// `404` through the same middleware. The steps are tests in order (`mode: "serial"`) on one browser context for the
// owner made in `beforeAll`. Tokens stay in variables: a finding names a cookie, a header or a path, never a value.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { APIResponse, BrowserContext, Page, Request, Response, Route } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import {
  addSessionCookies,
  callPlatformApi,
  createVerifiedAccount,
  E2E_TERMS_VERSION,
  expect,
  newAccountContext,
  signInWithApi,
  test,
  uniqueTestIp,
  type PortalAccount,
} from "../support/fixtures";
import { uniqueEmail, waitForLink } from "../support/mailpit";
import {
  goLiveAttempt,
  meetLivePreconditions,
  newOwnerWithActiveOta,
  uniqueLiveOfficeId,
  type OwnedOta,
} from "../support/ota";
import { buildAccount, stack } from "../support/seed";
import { OTA_ADMIN_URL, PORTAL_URL, REPO_ROOT, STACK_HOST } from "../support/stack";
import { TOTP_PERIOD_SECONDS, totpStep } from "../support/totp";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/** The route list of the portal build the stack runs (`next build` writes it). */
const ROUTES_MANIFEST = resolve(REPO_ROOT, "platform/frontend/.next/app-path-routes-manifest.json");

/** Every route of the portal, as the build's route list names it, and the step of this journey that visits it. */
const ROUTES = Object.freeze({
  "/": "signed out",
  "/pricing": "signed out",
  "/legal/terms": "signed out",
  "/legal/privacy": "signed out",
  "/_not-found": "signed out",
  "/sign-up": "signed out",
  "/sign-up/check-email": "signed out",
  "/forgot-password": "signed out",
  "/verify-pending": "signed out",
  "/reset-password": "signed out",
  "/invitations/accept": "signed out",
  "/sign-in": "sign-in",
  "/sign-in/mfa": "sign-in",
  "/dashboard": "every page",
  "/otas/new": "every page",
  "/console": "every page",
  "/account": "every page",
  "/account/security": "every page",
  "/otas/[tenantId]": "every page",
  "/otas/[tenantId]/setup": "every page",
  "/otas/[tenantId]/api-keys": "every page",
  "/otas/[tenantId]/domains": "every page",
  "/otas/[tenantId]/amadeus": "every page",
  "/otas/[tenantId]/payments": "every page",
  "/otas/[tenantId]/payments/payout-account": "every page",
  "/otas/[tenantId]/payments/settlements": "every page",
  "/otas/[tenantId]/payments/settlements/[settlementId]": "every page",
  "/otas/[tenantId]/team": "every page",
  "/otas/[tenantId]/billing": "every page",
  "/otas/[tenantId]/settings": "every page",
  "/otas/[tenantId]/go-live": "every page",
  "/verify-email": "e-mail links",
  "/otas/[tenantId]/console/launch": "Open console",
  "/otas/[tenantId]/payments/settlements/[settlementId]/lines.csv": "route handlers",
  "/connect/stripe/callback": "route handlers",
  "/health/live": "route handlers",
  "/health/ready": "route handlers",
  "/mfa-enrolment": "MFA enrolment",
  "/sign-out": "sign-out",
} as const);
type PortalRoute = keyof typeof ROUTES;

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): three accounts through the
 * platform API and Mailpit (up to 15 s each for the verification and invitation e-mails), the OTA's set-up on the OTA
 * worker (about 2 s, at most 45 s per OTA, and up to three OTAs while admin-amadeus-pool.e2e.ts holds the test pool),
 * the go-live fixtures and goLive, and the wait for two unused TOTP steps of the owner (at most 60 s).
 */
const ARRANGE_BUDGET_MS = 240_000;

/** The owner's name: the inviter in the invitation e-mails' subject. */
const OWNER_NAME = "Henrik Headers";

/** The origin of the OTA admin (`PUBLIC_OTA_ADMIN_URL` of the stack), the one other origin forms may post to. */
const OTA_ADMIN_ORIGIN = new URL(OTA_ADMIN_URL).origin;

/** The portal's policy (README §7, src/lib/csp.ts; `APP_ENV=test`, so no `'unsafe-eval'`) with `nonce`. */
function portalPolicy(nonce: string, handOff: boolean): Record<string, string[]> {
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "form-action": handOff ? [OTA_ADMIN_ORIGIN] : ["'self'", OTA_ADMIN_ORIGIN],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };
}

/** The static headers of next.config.ts (`SECURITY_HEADERS`) that every answer carries, the referrer policy aside. */
const STATIC_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
} as const);

/** The cookies of the portal (README §6) and the `SameSite` each must carry. */
const PORTAL_COOKIES: Readonly<Record<string, "lax" | "strict">> = Object.freeze({
  "__Host-vxp_at": "lax",
  "__Host-vxp_rt": "lax",
  "__Host-vxp_mfa": "strict",
  "__Host-vxp_reset": "strict",
  "__Host-vxp_invite": "strict",
  "__Host-vxp_next": "lax",
  "__Host-vxp_connect": "lax",
});

/** The portal's cookies whose values are secrets (tokens): no answer may hold them. */
const TOKEN_COOKIES = Object.freeze([
  "__Host-vxp_at",
  "__Host-vxp_rt",
  "__Host-vxp_mfa",
  "__Host-vxp_reset",
  "__Host-vxp_invite",
]);

/** A CSP nonce as the middleware writes it: 128 random bits in base64. */
const NONCE = /^'nonce-([A-Za-z0-9+/]{22,}={0,2})'$/;
/** The script elements of an HTML page, as written. */
const SCRIPT_TAG = /<script\b[^>]*>/g;
/** A portal token (PADR-0007: `ptk_` and 43 base62 characters; the OTA contract's pattern is 24 to 64). */
const PORTAL_TOKEN = /ptk_[A-Za-z0-9]{24,64}/g;
/**
 * An access token: a JWT's header, payload and signature (base64url of a JSON header and payload, both starting with
 * `{"`, so `eyJ`), the shape a11y-headers.e2e.ts looks for in the OTA admin's answers. A bare `eyJ` is not enough: an
 * API key's displayed prefix is random base62 and can hold it (one did in wave 46's integration run).
 */
const ACCESS_TOKEN = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/;
/** A full API key of the OTA booking API (PADR-0005): its prefix and 40 base62 characters. */
const FULL_API_KEY = /\b(?:pk|sk)_(?:test|live)_[A-Za-z0-9]{40}\b/g;
/** The hand-off page's one carrier of the portal token (the launch route handler's form). */
const PORTAL_TOKEN_FIELD = /<input type="hidden" name="portalToken" value="ptk_[A-Za-z0-9]{43}">/g;
/** Content types whose bodies the journey reads: pages, RSC payloads, scripts, JSON, text and CSV. */
const TEXT_BODY = /^(?:text\/(?:html|x-component|plain|csv|javascript)|application\/(?:json|javascript))/;

/**
 * How long the journey waits for an answer's headers or body (a few milliseconds locally): an answer the browser
 * dropped or never ended counts as unread instead of holding the step until its budget runs out.
 */
const READ_BUDGET_MS = 10_000;

/** `promise`'s value, or `undefined` when it fails or takes longer than READ_BUDGET_MS. */
async function within<T>(promise: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), READ_BUDGET_MS);
  });
  try {
    return await Promise.race([promise.catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

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

/** Whether the portal's middleware sees a request for `pathname` (its matcher, src/middleware.ts). */
function middlewareSees(pathname: string): boolean {
  return !(
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/_next/image") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/health/")
  );
}

/** The path of the "Open console" hand-off page (`/otas/{tenantId}/console/launch`). */
const isHandOff = (pathname: string): boolean => /^\/otas\/[^/]+\/console\/launch$/.test(pathname);

/** The referrer policy an answer of `pathname` with `search` must carry (README §7). */
function referrerPolicyOf(pathname: string, search: string): string {
  if (pathname === "/verify-email") {
    return "no-referrer";
  }
  if (
    (pathname === "/reset-password" || pathname === "/invitations/accept") &&
    new URLSearchParams(search).has("token")
  ) {
    return "no-referrer";
  }
  return isHandOff(pathname) ? "strict-origin" : "strict-origin-when-cross-origin";
}

/** The attributes of one `Set-Cookie` line, in words when one is wrong; the value is never named. */
function setCookieProblems(line: string): string[] {
  const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
  const name = pair.slice(0, Math.max(pair.indexOf("="), 0));
  const sameSite = PORTAL_COOKIES[name];
  if (sameSite === undefined) {
    return [`sets the cookie ${name === "" ? "(no name)" : name}, which is not one of the portal's`];
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
  if ((flags.get("samesite") ?? "").toLowerCase() !== sameSite) {
    problems.push(`${name} without SameSite=${sameSite === "lax" ? "Lax" : "Strict"}`);
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
 * What is wrong with an answer of `pathname` and `search` (`headers`), in words: the static headers, the referrer
 * policy, no X-Powered-By, the portal's policy with a nonce (returned) where the middleware saw the request, and the
 * attributes of every cookie it sets.
 */
function headerProblems(
  pathname: string,
  search: string,
  headers: HeaderList,
): { readonly problems: string[]; readonly nonce?: string } {
  const problems: string[] = [];
  const expected: Record<string, string> = {
    ...STATIC_HEADERS,
    "referrer-policy": referrerPolicyOf(pathname, search),
  };
  for (const [name, value] of Object.entries(expected)) {
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
  if (!middlewareSees(pathname)) {
    return { problems };
  }
  const policies = valuesOf(headers, "content-security-policy");
  if (policies.length !== 1) {
    problems.push(`${policies.length} Content-Security-Policy headers instead of one`);
    return { problems };
  }
  const directives = directivesOf(policies[0] ?? "");
  if (directives["frame-ancestors"]?.join(" ") !== "'none'") {
    problems.push("the Content-Security-Policy has no frame-ancestors 'none'");
  }
  const nonce = NONCE.exec(directives["script-src"]?.[1] ?? "")?.[1];
  if (nonce === undefined || !isDeepStrictEqual(directives, portalPolicy(nonce, isHandOff(pathname)))) {
    problems.push("the Content-Security-Policy is not the portal's policy with a nonce");
    return { problems };
  }
  return { problems, nonce };
}

/** One answer of the portal with a text body, kept for the last step's checks of what answers hold. */
interface AnswerBody {
  readonly pathname: string;
  readonly method: string;
  /** A server action's answer (a POST with `Next-Action`). */
  readonly serverAction: boolean;
  readonly body: string;
}

/** A server action's request: a `POST` with the `Next-Action` header (the headers the page sent need no wait). */
function isServerAction(request: Request): boolean {
  return request.method() === "POST" && request.headers()["next-action"] !== undefined;
}

/**
 * Watches every answer of the portal in browser contexts: the problems of its headers and cookies (checked by the last
 * step), each nonce its own, the cookies each answer set, the values of the token cookies, and the text bodies. Server
 * actions are routed through the journey (`intercept`), which reads each answer whole before the page gets it.
 */
class PortalAnswers {
  readonly problems: string[] = [];
  /** The portal's cookies set (with a value) or deleted (empty) by the answers, by name. */
  readonly cookiesSet = new Set<string>();
  readonly cookiesDeleted = new Set<string>();
  /** Every token value the journey saw: the token cookies' values set, and sessions it put into a context itself. */
  readonly secrets = new Set<string>();
  readonly bodies: AnswerBody[] = [];
  /** The answers with a text body that could not be read (the browser had dropped it, or it never ended). */
  readonly unreadBodies: string[] = [];
  private readonly nonces = new Map<string, string>();
  private readonly pending: Promise<void>[] = [];
  private count = 0;

  get answers(): number {
    return this.count;
  }

  /** Watches the answers of `target`, and routes its server actions through `intercept`. */
  async watch(target: BrowserContext): Promise<void> {
    const portalPort = new URL(PORTAL_URL).port;
    target.on("response", (response) => {
      if (new URL(response.url()).port === portalPort && !isServerAction(response.request())) {
        this.pending.push(this.take(response, target));
      }
    });
    await target.route(
      (url) => url.port === portalPort,
      async (route) => {
        if (!isServerAction(route.request())) {
          await route.fallback();
          return;
        }
        const intercepted = this.intercept(route);
        this.pending.push(intercepted);
        await intercepted;
      },
    );
  }

  /** Remembers token values the journey put into a context itself (`addSessionCookies`). */
  remember(...values: readonly string[]): void {
    for (const value of values) {
      this.secrets.add(value);
    }
  }

  /** Checks one answer: its URL and headers, from the browser or from an API request of the journey. */
  check(url: string, headers: HeaderList): string | undefined {
    this.count += 1;
    const { pathname, search } = new URL(url);
    const { problems, nonce } = headerProblems(pathname, search, headers);
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
      const value = pair.slice(separator + 1).trim();
      (value === "" ? this.cookiesDeleted : this.cookiesSet).add(name);
      if (value !== "" && TOKEN_COOKIES.includes(name)) {
        this.secrets.add(decodeURIComponent(value));
      }
    }
    return nonce;
  }

  /** Checks an answer of an API request of the journey (`context.request`), its body included. */
  async checkRequestAnswer(answer: APIResponse, method: string): Promise<void> {
    this.check(answer.url(), answer.headersArray());
    const type = answer.headers()["content-type"] ?? "";
    if (TEXT_BODY.test(type)) {
      this.bodies.push({
        pathname: new URL(answer.url()).pathname,
        method,
        serverAction: false,
        body: await answer.text(),
      });
    }
  }

  /**
   * Reads the body of a `GET` the browser dropped before its end (an RSC prefetch the next navigation cancelled) again:
   * the same URL and request headers from the same context, so with its cookies, as the server answers it.
   */
  private async again(target: BrowserContext, response: Response): Promise<string | undefined> {
    const sent = Object.entries(response.request().headers()).filter(
      ([name]) => !["host", "cookie", "content-length"].includes(name.toLowerCase()),
    );
    const answer = await within(
      target.request.get(response.url(), { headers: Object.fromEntries(sent), maxRedirects: 0 }),
    );
    if (answer === undefined) {
      return undefined;
    }
    this.check(answer.url(), answer.headersArray());
    return await within(answer.text());
  }

  /**
   * A server action of the page: sent by the journey (`route.fetch()`, from the context, so with its cookies, and
   * without following a redirect), its headers checked and its whole body kept, then that answer handed to the page
   * (`route.fulfill({ response })`). An answer that could not be fetched or read is unread, which fails the last step;
   * the page then gets a failed request.
   */
  private async intercept(route: Route): Promise<void> {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const answer = await within(route.fetch({ maxRedirects: 0, timeout: READ_BUDGET_MS }));
    const body = answer === undefined ? undefined : await within(answer.text());
    if (answer === undefined || body === undefined) {
      this.unreadBodies.push(`POST ${pathname} (server action)`);
      await route.abort("failed").catch(() => undefined);
      return;
    }
    this.check(answer.url(), answer.headersArray());
    if (TEXT_BODY.test(answer.headers()["content-type"] ?? "")) {
      this.bodies.push({ pathname, method: "POST", serverAction: true, body });
    }
    // The page may have gone meanwhile (a navigation of the journey): the answer was read either way.
    await route.fulfill({ response: answer }).catch(() => undefined);
  }

  private async take(response: Response, target: BrowserContext): Promise<void> {
    const { pathname } = new URL(response.url());
    // The body is asked for at once: the browser drops a page's answers when it leaves the page.
    const text = within(response.text());
    const headers = await within(response.headersArray());
    if (headers === undefined) {
      this.problems.push(`${pathname}: its headers could not be read`);
      return;
    }
    this.check(response.url(), headers);
    const status = response.status();
    const type = valuesOf(headers, "content-type").join(",");
    // A redirect the browser follows (a `Location`) has no body to read. A server action that ends with `redirect()`
    // answers `303` without one: its body is the RSC payload of the page it leads to, read like any other answer.
    const followed = status >= 300 && status < 400 && valuesOf(headers, "location").length > 0;
    if (followed || !TEXT_BODY.test(type)) {
      return;
    }
    const request = response.request();
    const body =
      (await text) ?? (request.method() === "GET" ? await this.again(target, response) : undefined);
    if (body === undefined) {
      this.unreadBodies.push(`${request.method()} ${pathname}`);
      return;
    }
    this.bodies.push({ pathname, method: request.method(), serverAction: false, body });
  }

  /** Waits until every answer seen so far is checked. */
  async settled(): Promise<void> {
    await Promise.all(this.pending);
  }
}

let owned: OwnedOta;
let admin: PortalAccount;
/** The address of the pending invitation, which has no account. */
const invitedAddress = uniqueEmail("pfe028-headers-invited");
let context: BrowserContext;
let page: Page;
const answers = new PortalAnswers();
/** The routes the journey visited. */
const visited = new Set<PortalRoute>();
/** The full API keys the pages showed once. */
const keysShown: string[] = [];

/** `/otas/<tenantId><path>`. */
const otaPath = (path = ""): string => `/otas/${owned.ota.id}${path}`;

/** A well-formed statement id that no row has: `stl_` and 26 random ULID characters. */
function unknownStatementId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `stl_${[...randomBytes(26)].map((byte) => alphabet[byte % 32] ?? "0").join("")}`;
}

/** Waits in the one-time arrangement until the TOTP step `step` has begun (see admin-a11y.e2e.ts). */
async function waitForTotpStep(step: number): Promise<void> {
  const wait = step * TOTP_PERIOD_SECONDS * 1000 - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait + 50));
  }
}

/**
 * Checks a page's HTML answer: the answer's own nonce on every script element (at least the page's own Next.js
 * scripts).
 */
async function expectPageHtml(response: Response): Promise<void> {
  const headers = await response.headersArray();
  expect(valuesOf(headers, "content-type").join(",")).toMatch(/^text\/html/);
  const url = new URL(response.url());
  const nonce = headerProblems(url.pathname, url.search, headers).nonce;
  expect(nonce).toBeDefined();
  const scripts = (await response.text()).match(SCRIPT_TAG) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((tag) => !tag.includes(` nonce="${nonce ?? ""}"`))).toEqual([]);
}

/**
 * Opens `path` (a page of `route`) in `target` as a new document: `status` without a redirect, the title (a pattern
 * for a not-found page), the page's HTML.
 */
async function visit(
  route: PortalRoute,
  path: string,
  title: string | RegExp,
  status = 200,
  target: Page = page,
): Promise<void> {
  // Every answer of the page the browser leaves is read first: a page's answers are only readable while it is shown.
  await answers.settled();
  const response = await target.goto(path);
  if (response === null) {
    throw new Error(`${path} gave no answer`);
  }
  expect(response.status(), path).toBe(status);
  expect(response.request().redirectedFrom(), path).toBeNull();
  await expect(target).toHaveTitle(
    typeof title === "string" ? (title === "" ? "Velexis" : `${title} · Velexis`) : title,
  );
  await expectPageHtml(response);
  visited.add(route);
}

/** The portal's cookies in `target`, as the browser keeps them; names and attributes only, never a value. */
async function portalCookiesOf(
  target: BrowserContext,
): Promise<{ name: string; httpOnly: boolean; secure: boolean; sameSite: string; path: string }[]> {
  return (await target.cookies(PORTAL_URL))
    .filter((cookie) => cookie.name.startsWith("__Host-vxp_"))
    .map(({ name, httpOnly, secure, sameSite, path }) => ({ name, httpOnly, secure, sameSite, path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The browser's cookie of `name` as the portal sets it. */
const keptCookie = (name: string, sameSite: "Lax" | "Strict") => ({
  name,
  httpOnly: true,
  secure: true,
  sameSite,
  path: "/",
});

/** The browser's session cookies, as the portal sets them. */
const SESSION_COOKIES = [keptCookie("__Host-vxp_at", "Lax"), keptCookie("__Host-vxp_rt", "Lax")] as const;

/** The `Set-Cookie` lines of an answer. */
async function setCookiesOf(response: Response): Promise<string[]> {
  return valuesOf(await response.headersArray(), "set-cookie");
}

/** The names of the cookies of `lines`, sorted. */
const cookieNames = (lines: readonly string[]): string[] =>
  lines.map((line) => line.split("=")[0] ?? "").sort();

/** A verified account (no MFA) that the owner invites as `role` and that accepts with its invitation e-mail's token. */
async function invitedMember(role: Schemas["TenantRole"], fullName: string): Promise<PortalAccount> {
  const account = await createVerifiedAccount(buildAccount({ fullName }));
  await callPlatformApi<Schemas["Invitation"]>({
    operation: "createInvitation",
    method: "POST",
    path: `/v1/tenants/${encodeURIComponent(owned.ota.id)}/invitations`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
    body: { email: account.email, role } satisfies Schemas["CreateInvitationRequest"],
  });
  const link = await waitForLink({
    to: account.email,
    subject: `${OWNER_NAME} invited you to ${owned.ota.name} on Velexis`,
    path: "/invitations/accept",
    origin: PORTAL_URL,
  });
  const token = link.searchParams.get("token");
  if (token === null) {
    throw new Error(`the invitation e-mail to ${account.email} has a link without a token`);
  }
  await callPlatformApi<Schemas["InvitationAccepted"]>({
    operation: "acceptInvitation",
    method: "POST",
    path: "/v1/invitations/accept",
    endUserIp: account.endUserIp,
    accessToken: (await signInWithApi(account)).accessToken,
    body: { token } satisfies Schemas["InvitationTokenRequest"],
  });
  return account;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-headers.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  owned = await newOwnerWithActiveOta(OWNER_NAME, "pfeheaders", { mfa: true });
  const lastCodeStep = totpStep(Date.now());
  admin = await invitedMember("admin", "Alva Admin");
  await callPlatformApi<Schemas["Invitation"]>({
    operation: "createInvitation",
    method: "POST",
    path: `/v1/tenants/${encodeURIComponent(owned.ota.id)}/invitations`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
    body: { email: invitedAddress, role: "viewer" } satisfies Schemas["CreateInvitationRequest"],
  });
  // The OTA goes live: the fixtures of what the stack cannot reach, then the owner's goLive (the owner's sign-in with
  // a TOTP code is the step-up it asks for).
  await meetLivePreconditions(owned, uniqueLiveOfficeId());
  expect(await goLiveAttempt(owned.owner, owned.ota.id)).toEqual({
    status: 200,
    storefrontEnvironment: "live",
  });

  context = await newAccountContext(browser, owned.owner.account, PORTAL_URL);
  await answers.watch(context);
  page = await context.newPage();
  await waitForTotpStep(lastCodeStep + 2);
});

test.afterAll(async () => {
  await context?.close();
});

test("the journey's route list is the built portal's [PFE-028 AC1]", () => {
  const manifest = JSON.parse(readFileSync(ROUTES_MANIFEST, "utf8")) as Record<string, string>;
  const built = [...new Set(Object.values(manifest))].sort((a, b) => a.localeCompare(b));
  expect(built).toEqual(Object.keys(ROUTES).sort((a, b) => a.localeCompare(b)));
});

test("signed out, a page of the signed-in area answers 303 to the sign-in with the portal's headers and sets no cookie [PFE-028 AC1]", async () => {
  const redirect = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/dashboard" && response.request().method() === "GET",
  );
  await answers.settled();
  await page.goto("/dashboard");
  const answer = await redirect;
  expect(answer.status()).toBe(303);
  const location = new URL((await answer.headerValue("location")) ?? "", PORTAL_URL);
  expect(location.pathname + location.search).toBe("/sign-in?next=%2Fdashboard");
  const { problems, nonce } = headerProblems("/dashboard", "", await answer.headersArray());
  expect(problems).toEqual([]);
  expect(nonce).toBeDefined();
  expect(await portalCookiesOf(context)).toEqual([]);
});

test("the public pages answer with the portal's headers and their scripts with the nonce [PFE-028 AC1]", async () => {
  const pages: readonly (readonly [PortalRoute, string, string | RegExp, number?])[] = [
    ["/", "/", ""],
    ["/pricing", "/pricing", "Pricing"],
    ["/legal/terms", "/legal/terms", "Terms of service"],
    ["/legal/privacy", "/legal/privacy", "Privacy notice"],
    ["/_not-found", "/pfe028-no-such-page", /./, 404],
    ["/sign-up", "/sign-up", "Sign up"],
    ["/sign-up/check-email", "/sign-up/check-email", "Check your e-mail"],
    ["/forgot-password", "/forgot-password", "Reset your password"],
    ["/verify-pending", "/verify-pending", "Verify your e-mail"],
    ["/reset-password", "/reset-password", "Choose a new password"],
    ["/invitations/accept", "/invitations/accept", "Your invitation"],
  ];
  for (const [route, path, title, status] of pages) {
    await visit(route, path, title, status);
  }
  // The owner asks for a reset link, which a later step opens.
  await answers.settled();
  await page.goto("/forgot-password");
  await page.getByLabel("E-mail address").fill(owned.owner.account.email);
  await page.getByRole("button", { name: "Send the reset link" }).click();
  await expect(
    page.getByRole("main").getByText(/^If an account uses this address, we sent it a link/),
  ).toBeVisible();
});

test("the sign-in sets the challenge and return-path cookies, then the session cookies, each with its attributes [PFE-028 AC1]", async () => {
  // Back to the stack's own host: Next.js writes a middleware redirect's loopback host as `localhost`.
  await visit("/sign-in", "/sign-in?next=%2Fdashboard", "Sign in");
  await page.getByLabel("E-mail address").fill(owned.owner.account.email);
  await page.getByLabel("Password", { exact: true }).fill(owned.owner.account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in/mfa");
  await expect(page.getByLabel("Authentication code")).toBeVisible();
  // The password step writes the MFA challenge and the return path only, never a session cookie.
  expect(await portalCookiesOf(context)).toEqual([
    keptCookie("__Host-vxp_mfa", "Strict"),
    keptCookie("__Host-vxp_next", "Lax"),
  ]);
  await visit("/sign-in/mfa", "/sign-in/mfa", "Two-factor authentication");

  const authenticator = owned.owner.account.authenticator;
  if (authenticator === undefined) {
    throw new Error("the owner has no authenticator");
  }
  await page.getByLabel("Authentication code").fill(await authenticator.nextCode());
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/dashboard");
  await expect(page).toHaveTitle("My OTAs · Velexis");
  // The code step replaces the challenge and the return path with the session.
  expect(await portalCookiesOf(context)).toEqual(SESSION_COOKIES);
  await answers.settled();
  expect([...answers.cookiesSet].sort()).toEqual([
    "__Host-vxp_at",
    "__Host-vxp_mfa",
    "__Host-vxp_next",
    "__Host-vxp_rt",
  ]);
  expect([...answers.cookiesDeleted].sort()).toEqual(["__Host-vxp_mfa", "__Host-vxp_next"]);
});

/** A page route the journey opens: its route, path, title (a pattern for a not-found page) and status (200). */
type PageVisit = readonly [PortalRoute, string, string | RegExp, number?];

// The page routes are split over two steps, so no step comes near Playwright's 30 seconds on a slower runner.
test("the account pages and the OTA's overview, set-up, API keys, domains and team answer with the portal's headers and their scripts with the nonce [PFE-028 AC1]", async () => {
  const pages: readonly PageVisit[] = [
    ["/dashboard", "/dashboard", "My OTAs"],
    ["/otas/new", "/otas/new", "Create an OTA"],
    ["/console", `/console?tenant=${encodeURIComponent(owned.ota.id)}`, "Open the OTA admin"],
    ["/account", "/account", "Your profile"],
    ["/account/security", "/account/security", "Security"],
    ["/otas/[tenantId]", otaPath(), "Overview"],
    ["/otas/[tenantId]/setup", otaPath("/setup"), "OTA set-up"],
    ["/otas/[tenantId]/api-keys", otaPath("/api-keys"), "API keys"],
    ["/otas/[tenantId]/domains", otaPath("/domains"), "Domains"],
    ["/otas/[tenantId]/team", otaPath("/team"), "Team"],
  ];
  for (const [route, path, title, status] of pages) {
    await visit(route, path, title, status);
  }
});

test("the OTA's Amadeus, payments, payout account, settlements, a statement of no row, billing, settings and go-live answer with the portal's headers and their scripts with the nonce [PFE-028 AC1]", async () => {
  const pages: readonly PageVisit[] = [
    ["/otas/[tenantId]/amadeus", otaPath("/amadeus"), "Amadeus"],
    ["/otas/[tenantId]/payments", otaPath("/payments"), "Payments"],
    ["/otas/[tenantId]/payments/payout-account", otaPath("/payments/payout-account"), "Payout account"],
    ["/otas/[tenantId]/payments/settlements", otaPath("/payments/settlements"), "Settlements"],
    [
      "/otas/[tenantId]/payments/settlements/[settlementId]",
      otaPath(`/payments/settlements/${unknownStatementId()}`),
      /./,
      404,
    ],
    ["/otas/[tenantId]/billing", otaPath("/billing"), "Billing"],
    ["/otas/[tenantId]/settings", otaPath("/settings"), "OTA settings"],
    ["/otas/[tenantId]/go-live", otaPath("/go-live"), "Go live"],
  ];
  for (const [route, path, title, status] of pages) {
    await visit(route, path, title, status);
  }
});

test("the e-mail links answer with no-referrer: the verification link, and the reset and invitation links, which move their token into a SameSite=Strict cookie [PFE-028 AC1]", async ({
  browser,
}) => {
  // The verification link of a new account, opened in a visitor's own browser (the owner's session would be renewed).
  const visitor: PortalAccount = { ...buildAccount({ fullName: "Vic Visitor" }), endUserIp: uniqueTestIp() };
  await callPlatformApi({
    operation: "signUp",
    method: "POST",
    path: "/v1/auth/sign-up",
    endUserIp: visitor.endUserIp,
    body: {
      email: visitor.email,
      password: visitor.password,
      fullName: visitor.fullName,
      acceptTerms: true,
      termsVersion: E2E_TERMS_VERSION,
    } satisfies Schemas["SignUpRequest"],
  });
  const verification = await waitForLink({ to: visitor.email, path: "/verify-email", origin: PORTAL_URL });
  const visitorContext = await newAccountContext(browser, visitor, PORTAL_URL);
  try {
    await answers.watch(visitorContext);
    const visitorPage = await visitorContext.newPage();
    const verifyAnswer = visitorPage.waitForResponse(
      (response) => new URL(response.url()).pathname === "/verify-email",
    );
    await visitorPage.goto(verification.href);
    const verified = await verifyAnswer;
    expect(verified.status()).toBe(303);
    expect(await verified.headerValue("referrer-policy")).toBe("no-referrer");
    expect(await verified.headerValue("cache-control")).toBe("no-store");
    await visitorPage.waitForURL(
      (url) => url.pathname === "/sign-in" && url.searchParams.get("verified") === "1",
    );
    visited.add("/verify-email");
  } finally {
    await answers.settled();
    await visitorContext.close();
  }

  // The reset link and an invitation link: the middleware answers each with a page that moves the token into its
  // cookie and refreshes to the page without it.
  const links = [
    [
      "__Host-vxp_reset",
      await waitForLink({ to: owned.owner.account.email, path: "/reset-password", origin: PORTAL_URL }),
    ],
    [
      "__Host-vxp_invite",
      await waitForLink({ to: invitedAddress, path: "/invitations/accept", origin: PORTAL_URL }),
    ],
  ] as const;
  for (const [cookie, link] of links) {
    const tokenAnswer = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === link.pathname &&
        new URL(response.url()).searchParams.has("token"),
    );
    await answers.settled();
    await page.goto(link.href);
    const moved = await tokenAnswer;
    expect(moved.status(), link.pathname).toBe(200);
    expect(await moved.headerValue("referrer-policy"), link.pathname).toBe("no-referrer");
    expect(await moved.headerValue("cache-control"), link.pathname).toBe("no-store");
    expect(cookieNames(await setCookiesOf(moved)), link.pathname).toEqual([cookie]);
    await page.waitForURL((url) => url.pathname === link.pathname && url.search === "");
    expect((await portalCookiesOf(context)).find((kept) => kept.name === cookie)).toEqual(
      keptCookie(cookie, "Strict"),
    );
  }
  await expect(page.getByRole("main").getByText("This invitation is for another address")).toBeVisible();
});

test("a new API key and the OTA's initial test keys are each shown once, by a server action's answer [PFE-028 AC1]", async () => {
  await answers.settled();
  await page.goto(otaPath("/setup"));
  await page.getByRole("button", { name: "Reveal the test keys" }).click();
  for (const label of ["Publishable test key", "Secret test key"]) {
    const field = page.getByLabel(label, { exact: true });
    await expect(field).toHaveValue(/^(?:pk|sk)_test_[A-Za-z0-9]{40}$/);
    keysShown.push(await field.inputValue());
  }
  await answers.settled();
  await page.reload();
  await expect(page.getByLabel("Secret test key", { exact: true })).toHaveCount(0);

  await answers.settled();
  await page.goto(otaPath("/api-keys"));
  await page.getByLabel("Name", { exact: true }).fill("Headers server");
  await page.getByRole("button", { name: "Create the key" }).click();
  const panel = page.getByRole("region", { name: "Your new secret test key" });
  const field = panel.getByLabel("Key “Headers server”", { exact: true });
  await expect(field).toHaveValue(/^sk_test_[A-Za-z0-9]{40}$/);
  keysShown.push(await field.inputValue());
  await answers.settled();
  await page.reload();
  await expect(page.getByRole("region", { name: "Your new secret test key" })).toHaveCount(0);
});

test("Open console's hand-off page answers with strict-origin, no-store and a policy whose forms post to the OTA admin only [PFE-028 AC1]", async () => {
  // The navigation to the OTA admin's `/sso` is cancelled in this context only (`ERR_ABORTED`): the browser stays on
  // the hand-off page, whose token is never redeemed.
  await page.route(`${OTA_ADMIN_URL}/sso`, (route) => route.abort("aborted"));
  try {
    await answers.settled();
    await page.goto(otaPath());
    const handOff = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === otaPath("/console/launch") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("main")
      .getByRole("button", { name: /^Open console/ })
      .click();
    const answer = await handOff;
    expect(answer.status()).toBe(200);
    expect(await answer.headerValue("referrer-policy")).toBe("strict-origin");
    expect(await answer.headerValue("cache-control")).toBe("no-store");
    const directives = directivesOf((await answer.headerValue("content-security-policy")) ?? "");
    expect(directives["form-action"]).toEqual([OTA_ADMIN_ORIGIN]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    await expectPageHtml(answer);
    await expect(page).toHaveTitle("Opening the OTA admin");
    visited.add("/otas/[tenantId]/console/launch");
  } finally {
    await page.unroute(`${OTA_ADMIN_URL}/sso`);
  }
});

test("the middleware refreshes an expired access cookie, and the new session cookies keep their attributes [PFE-028 AC1]", async () => {
  // Every earlier answer is read first: reading one again (`again`) shares the context's cookies, and so its refresh.
  await answers.settled();
  const before = await context.cookies(PORTAL_URL);
  await context.clearCookies({ name: "__Host-vxp_at" });
  const response = await page.goto("/account");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Your profile · Velexis");
  // The page's own answer carries the refreshed session (both tokens replaced), with the portal's attributes.
  const lines = response === null ? [] : await setCookiesOf(response);
  expect(cookieNames(lines)).toEqual(["__Host-vxp_at", "__Host-vxp_rt"]);
  expect(lines.flatMap(setCookieProblems)).toEqual([]);
  expect(
    (await portalCookiesOf(context)).filter((kept) => kept.name.endsWith("_at") || kept.name.endsWith("_rt")),
  ).toEqual(SESSION_COOKIES);
  const after = await context.cookies(PORTAL_URL);
  const valueOf = (cookies: typeof after, name: string): string | undefined =>
    cookies.find((cookie) => cookie.name === name)?.value;
  expect(valueOf(after, "__Host-vxp_rt") === valueOf(before, "__Host-vxp_rt")).toBe(false);
});

test("the route handlers answer with the portal's headers: a statement's CSV of no row, Stripe Connect's way back and the health routes [PFE-028 AC1]", async () => {
  const handlers: readonly (readonly [PortalRoute, string, number])[] = [
    [
      "/otas/[tenantId]/payments/settlements/[settlementId]/lines.csv",
      otaPath(`/payments/settlements/${unknownStatementId()}/lines.csv`),
      404,
    ],
    ["/connect/stripe/callback", "/connect/stripe/callback", 303],
    ["/health/live", "/health/live", 200],
    ["/health/ready", "/health/ready", 200],
  ];
  for (const [route, path, status] of handlers) {
    const answer = await context.request.get(path, { maxRedirects: 0 });
    expect(answer.status(), path).toBe(status);
    await answers.checkRequestAnswer(answer, "GET");
    const { pathname, search } = new URL(answer.url());
    expect(headerProblems(pathname, search, answer.headersArray()).problems, path).toEqual([]);
    expect(answer.headers()["cache-control"] ?? "", path).toMatch(/no-store/);
    visited.add(route);
  }
});

test("the admin of the live OTA without MFA gets the enrolment page, with the portal's headers and its scripts with the nonce [PFE-028 AC1]", async ({
  browser,
}) => {
  const adminContext = await newAccountContext(browser, admin, PORTAL_URL);
  try {
    await answers.watch(adminContext);
    const session = await signInWithApi(admin);
    answers.remember(session.accessToken, session.refreshToken);
    await addSessionCookies(adminContext, "portal", session);
    const adminPage = await adminContext.newPage();
    await adminPage.goto(otaPath());
    await adminPage.waitForURL((url) => url.pathname === "/mfa-enrolment");
    await visit(
      "/mfa-enrolment",
      `/mfa-enrolment?${new URLSearchParams({ next: otaPath() }).toString()}`,
      "Set up two-factor authentication",
      200,
      adminPage,
    );
    await expect(
      adminPage.getByRole("heading", { level: 1, name: "Set up two-factor authentication" }),
    ).toBeVisible();
  } finally {
    await answers.settled();
    await adminContext.close();
  }
});

test("Sign out deletes the session cookies with the same attributes, and the signed-in area asks for a sign-in again [PFE-028 AC1]", async () => {
  await answers.settled();
  await page.goto("/dashboard");
  await expect(page).toHaveTitle("My OTAs · Velexis");
  const signOutAnswer = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/sign-out" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const signOut = await signOutAnswer;
  expect(signOut.status()).toBe(303);
  const deleted = await setCookiesOf(signOut);
  expect(cookieNames(deleted)).toEqual(expect.arrayContaining(["__Host-vxp_at", "__Host-vxp_rt"]));
  expect(deleted.flatMap(setCookieProblems)).toEqual([]);
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("signedOut") === "1");
  expect((await portalCookiesOf(context)).map((kept) => kept.name)).not.toContain("__Host-vxp_at");
  expect((await portalCookiesOf(context)).map((kept) => kept.name)).not.toContain("__Host-vxp_rt");
  visited.add("/sign-out");

  await answers.settled();
  const again = await page.goto("/dashboard");
  expect(again?.request().redirectedFrom()?.url()).toBe(`${PORTAL_URL}/dashboard`);
});

test("every answer carried the portal's headers and cookie attributes, every route was visited, and no answer holds a token or a key it should not [PFE-028 AC1]", async () => {
  await answers.settled();
  const bodies = answers.bodies;
  // Recorded before the checks, so a failing run says what it read too.
  test.info().annotations.push({
    type: "answers checked",
    description: `${answers.answers} answers of the portal (on ${STACK_HOST}), ${bodies.length} bodies read (${bodies.filter((answer) => answer.serverAction).length} of server actions), ${answers.unreadBodies.length} no longer readable (${answers.unreadBodies.join(", ")})`,
  });
  expect([...visited].sort((a, b) => a.localeCompare(b))).toEqual(
    Object.keys(ROUTES).sort((a, b) => a.localeCompare(b)),
  );
  expect(answers.problems).toEqual([]);

  // Booleans and paths only, so a failure never prints a token. Every page, RSC payload and script the browser received
  // was read (a GET it dropped was read again), and every server action's answer, which the journey sent itself.
  expect(answers.unreadBodies).toEqual([]);
  // The journey's server actions: the reset request, the password and code steps of the sign-in, and the two that
  // showed keys.
  expect(bodies.filter((answer) => answer.serverAction).length).toBeGreaterThanOrEqual(5);
  expect(answers.secrets.size).toBeGreaterThanOrEqual(4);
  const secrets = [...answers.secrets];
  // The shape catches the journey's own access tokens (the `at` cookie values it saw set), so it would catch one in an
  // answer too.
  const accessTokens = secrets.filter((secret) => secret.startsWith("eyJ"));
  expect(accessTokens.length).toBeGreaterThan(0);
  expect(accessTokens.every((token) => ACCESS_TOKEN.test(token))).toBe(true);
  expect(bodies.filter((answer) => ACCESS_TOKEN.test(answer.body)).map((answer) => answer.pathname)).toEqual(
    [],
  );
  expect(
    bodies
      .filter((answer) => secrets.some((secret) => answer.body.includes(secret)))
      .map((answer) => answer.pathname),
  ).toEqual([]);

  // A portal token only in the hand-off page's hidden field, once.
  const withPortalToken = bodies.filter((answer) => (answer.body.match(PORTAL_TOKEN) ?? []).length > 0);
  expect(withPortalToken.map((answer) => `${answer.method} ${answer.pathname}`)).toEqual([
    `POST ${otaPath("/console/launch")}`,
  ]);
  const handOff = withPortalToken[0]?.body ?? "";
  expect((handOff.match(PORTAL_TOKEN) ?? []).length).toBe(1);
  expect((handOff.match(PORTAL_TOKEN_FIELD) ?? []).length).toBe(1);

  // A full API key only in the server action answer that showed it once, never in another answer: no page, RSC payload,
  // script or other server action answer holds one, and no answer holds a key the pages did not show.
  const keyAnswers = bodies.flatMap((answer) =>
    [...new Set(answer.body.match(FULL_API_KEY) ?? [])].map((key) => ({ key, answer })),
  );
  expect(
    keyAnswers
      .filter(({ answer }) => !(answer.serverAction && answer.method === "POST"))
      .map(({ answer }) => `${answer.method} ${answer.pathname}`),
  ).toEqual([]);
  const answersPerKey = new Map<string, number>();
  for (const { key } of keyAnswers) {
    answersPerKey.set(key, (answersPerKey.get(key) ?? 0) + 1);
  }
  expect([...answersPerKey.values()].every((count) => count === 1)).toBe(true);
  // The keys the pages showed are the pattern's, so a key held anywhere would have been found; each was in exactly one
  // answer (the server action's that showed it), and those are all the keys any answer held.
  const oneKey = new RegExp(`^${FULL_API_KEY.source}$`);
  expect(keysShown).toHaveLength(3);
  expect(keysShown.every((key) => oneKey.test(key) && answersPerKey.get(key) === 1)).toBe(true);
  expect(answersPerKey.size).toBe(keysShown.length);
  expect(answers.answers).toBeGreaterThan(Object.keys(ROUTES).length);
});
