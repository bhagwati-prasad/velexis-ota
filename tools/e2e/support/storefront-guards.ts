// The guards of every storefront journey (OFE-008; ota/frontend/README.md §13 "Assertions in every journey",
// OADR-0015 point 11, OADR-0006, ADR-0011 §C). Import `test` and `expect` from here in specs/storefront/**:
//
//   import { expect, test } from "../../support/storefront-guards";
//
//   test("…", async ({ page, guards }) => {
//     await page.goto("/");
//     await guards.checkA11y(page);
//   });
//
// The `guards` fixture is automatic: every test of a storefront spec runs under it, whether it names it or not. It
// watches the test's browser context from before the first navigation and fails the test, when it ends, on:
//
//   1. any `securitypolicyviolation` in any frame: the build has no inline script or style, and the preview sends the
//      Caddyfile's CSP, so a violation is a bug (a listener added to every document before its own scripts run);
//   2. any request to a host other than the storefront's own (STOREFRONT_URL, SUSPENDED_STOREFRONT_URL): Stripe's hosts
//      are allowed on `/checkout/pay-card.html` only (the page and the frames inside it), and nothing else anywhere;
//   3. a cookie that page JavaScript can read other than `__Host-vx_csrf`: the names of `document.cookie` of every
//      storefront document, when it has loaded and when it is left, and every cookie of the context that is not
//      httpOnly at the end. Values never leave the page: the CSRF token is no credential, but it stays out of reports.
//      In the storefront-stripe journeys only (`install(context, { stripeJourney: true })`), the two first-party
//      cookies Stripe.js sets for Stripe Radar's fraud signals, `__stripe_mid` and `__stripe_sid` (STRIPE_JS_COOKIES),
//      are allowed too, from the card payment page on: on `/checkout/pay-card.html` and on every page the context shows
//      after it (OADR-0006, revision of 2026-10-28, FIX-W32-OTA; they hold no session or credential). Never another
//      name, never before the card page, and never in any other journey;
//   4. a serious or critical axe violation (WCAG 2.2 A and AA) on the page the test ends on. Journeys also call
//      `guards.checkA11y(page)` on every page they visit, once it shows what they came for (tools/e2e/README.md).
//
// A test that provokes a guard on purpose reads what it recorded (`guards.problems`), checks that `verify()` throws, and
// then takes the problems back with `forget()`, so its own end is clean again.
import { type BrowserContext, type Page, type Request } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./a11y";
import { test as base } from "./fixtures";
import { STOREFRONT_URL, SUSPENDED_STOREFRONT_URL } from "./stack";

export { expect } from "./fixtures";

/** The only cookie storefront JavaScript may read: the CSRF token of the SDK's cookie mode (OADR-0006). */
export const CSRF_COOKIE = "__Host-vx_csrf";

/**
 * The first-party cookies Stripe.js sets on the card payment page for Stripe Radar's advanced fraud signals, readable
 * by JavaScript (a device id for a year and a session id for 30 minutes; no session, token or card data of Velexis or
 * the traveller): allowed in the storefront-stripe journeys from the card page on, and nowhere else (OADR-0006,
 * revision of 2026-10-28).
 */
export const STRIPE_JS_COOKIES: readonly string[] = Object.freeze(["__stripe_mid", "__stripe_sid"]);

/** The origins of the storefront under test: everything a page may load from, besides Stripe on the card page. */
export const FIRST_PARTY_ORIGINS: readonly string[] = Object.freeze([
  STOREFRONT_URL,
  SUSPENDED_STOREFRONT_URL,
]);

/** The card payment page, the only page with Stripe.js (OADR-0015 point 9; Caddy's try_files serves both paths). */
export const CARD_PAGE_PATHS: readonly string[] = Object.freeze([
  "/checkout/pay-card.html",
  "/checkout/pay-card",
]);

/** Stripe's hosts: js.stripe.com, api.stripe.com, hooks.stripe.com, m.stripe.network, b.stripecdn.com and the like. */
const STRIPE_HOST = /(^|\.)(stripe\.com|stripe\.network|stripecdn\.com)$/;

/** The name of the binding through which the storefront's documents report to the guard. */
export const GUARD_BINDING = "__vxE2eGuard";

/** Something a guard found. */
export type GuardProblem =
  | {
      readonly kind: "csp";
      /** The directive that refused it (`script-src-elem`, `connect-src`, …). */
      readonly directive: string;
      /** What was refused: a URL, or `inline`, `eval`. */
      readonly blocked: string;
      /** The document that tried. */
      readonly document: string;
      /** The first characters of an inline script or style, when the browser gives them. */
      readonly sample: string;
    }
  | {
      readonly kind: "third-party";
      /** The requested URL without its query string. */
      readonly url: string;
      /** The top-level page that made the request. */
      readonly page: string;
    }
  | {
      readonly kind: "cookie";
      /** The names of the cookies JavaScript could read, other than CSRF_COOKIE. */
      readonly names: readonly string[];
      /** The document that could read them, or `context` for the final check. */
      readonly document: string;
    };

/** A URL without its query string and fragment, which may carry ids or tokens. */
export function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? "";
  }
}

/**
 * Whether a request to `requestUrl`, made by the top-level page at `pageUrl`, goes to a third-party host the storefront
 * must never contact. Only `http:` and `https:` requests count (`data:` and `blob:` are local); the storefront's own
 * origins are always allowed, and Stripe's hosts on the card payment page only.
 */
export function isThirdPartyRequest(requestUrl: string, pageUrl: string): boolean {
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return false;
  }
  if (request.protocol !== "http:" && request.protocol !== "https:") {
    return false;
  }
  if (FIRST_PARTY_ORIGINS.includes(request.origin)) {
    return false;
  }
  if (request.protocol === "https:" && STRIPE_HOST.test(request.hostname)) {
    return !isCardPage(pageUrl);
  }
  return true;
}

/** Whether `pageUrl` is the card payment page of the storefront. */
export function isCardPage(pageUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    return FIRST_PARTY_ORIGINS.includes(page.origin) && CARD_PAGE_PATHS.includes(page.pathname);
  } catch {
    return false;
  }
}

/**
 * The names among `names` that are neither CSRF_COOKIE nor one of `allowed` (STRIPE_JS_COOKIES where the guards allow
 * them), in order, without repeats and empty names.
 */
export function unexpectedCookieNames(names: readonly string[], allowed: readonly string[] = []): string[] {
  return [
    ...new Set(
      names
        .map((name) => name.trim())
        .filter((name) => name !== "" && name !== CSRF_COOKIE && !allowed.includes(name)),
    ),
  ];
}

/** One line per problem, for the error that fails the test. */
export function formatProblems(problems: readonly GuardProblem[]): string {
  return problems
    .map((problem) => {
      switch (problem.kind) {
        case "csp":
          return (
            `  - securitypolicyviolation: ${problem.directive} refused ${problem.blocked} on ${problem.document}` +
            (problem.sample === "" ? "" : ` (${JSON.stringify(problem.sample)})`)
          );
        case "third-party":
          return `  - request to a third-party host: ${problem.url} from ${problem.page}`;
        case "cookie":
          return `  - cookie readable by JavaScript other than ${CSRF_COOKIE}: ${problem.names.join(", ")} on ${problem.document}`;
      }
    })
    .join("\n");
}

/** What a storefront document sends to the binding. */
type DocumentReport =
  | {
      readonly kind: "csp";
      readonly directive: string;
      readonly blocked: string;
      readonly document: string;
      readonly sample: string;
    }
  | { readonly kind: "cookies"; readonly names: readonly string[]; readonly document: string };

/**
 * Added to every document of the context before its own scripts: reports CSP violations of any frame, and the cookie
 * names of top-level documents when they have loaded and when they are left. It looks the binding up when it reports,
 * so the order of Playwright's own scripts does not matter, and it never sends a cookie value.
 */
export const GUARD_INIT_SCRIPT = `(() => {
  const report = (data) => {
    const binding = globalThis[${JSON.stringify(GUARD_BINDING)}];
    if (typeof binding === "function") binding(data);
  };
  addEventListener("securitypolicyviolation", (event) => {
    report({
      kind: "csp",
      directive: String(event.effectiveDirective || event.violatedDirective || ""),
      blocked: String(event.blockedURI || ""),
      document: String(event.documentURI || location.href),
      sample: String(event.sample || ""),
    });
  }, true);
  if (window.top === window) {
    const cookies = () => report({
      kind: "cookies",
      names: document.cookie.split(";").map((cookie) => cookie.split("=")[0].trim()).filter(Boolean),
      document: location.href,
    });
    addEventListener("load", cookies);
    addEventListener("pagehide", cookies);
  }
})();`;

/** The part of a browser context the guards use; a fake in the unit tests. */
export type GuardedContext = Pick<BrowserContext, "addInitScript" | "exposeBinding" | "cookies"> & {
  on(event: "request", listener: (request: Request) => void): unknown;
};

/** How the guards of one context are set up. */
export interface StorefrontGuardOptions {
  /**
   * A storefront-stripe journey (OFE-017): Stripe.js runs on its card payment page, so its cookies (STRIPE_JS_COOKIES)
   * are allowed from that page on. Every other journey leaves it out, and allows only CSRF_COOKIE.
   */
  readonly stripeJourney?: boolean | undefined;
}

/** The guards of one test's browser context. */
export class StorefrontGuards {
  readonly #problems: GuardProblem[] = [];
  /** The context showed the card payment page (a document or a request of it): the Stripe.js cookies may follow. */
  #cardPageSeen = false;

  private constructor(
    private readonly context: GuardedContext,
    private readonly options: StorefrontGuardOptions,
  ) {}

  /** Installs the guards on `context` (before its first navigation) and returns them. */
  static async install(
    context: GuardedContext,
    options: StorefrontGuardOptions = {},
  ): Promise<StorefrontGuards> {
    const guards = new StorefrontGuards(context, options);
    await context.exposeBinding(GUARD_BINDING, (_source, report: unknown) => guards.record(report));
    await context.addInitScript({ content: GUARD_INIT_SCRIPT });
    context.on("request", (request) => guards.request(request));
    return guards;
  }

  /** What the guards found so far. */
  get problems(): readonly GuardProblem[] {
    return [...this.#problems];
  }

  /** Throws one error that names every problem found so far; nothing when there is none. */
  verify(): void {
    if (this.#problems.length > 0) {
      throw new Error(`The storefront guards failed this test:\n${formatProblems(this.#problems)}`);
    }
  }

  /** Returns what the guards found so far and forgets it (a test that provoked a guard on purpose). */
  forget(): GuardProblem[] {
    return this.#problems.splice(0, this.#problems.length);
  }

  /** The axe guard: no serious or critical violation of WCAG 2.2 A and AA on `page` as it is now. */
  async checkA11y(page: Page): Promise<void> {
    await expectNoSeriousA11yViolations(page);
  }

  /**
   * The readable cookies allowed besides CSRF_COOKIE now: the Stripe.js cookies in a storefront-stripe journey once its
   * context showed the card payment page, else none.
   */
  get allowedCookies(): readonly string[] {
    return this.options.stripeJourney === true && this.#cardPageSeen ? STRIPE_JS_COOKIES : [];
  }

  /** The cookie guard at the end: every cookie of the storefront's origins that is not httpOnly. */
  async checkContextCookies(): Promise<void> {
    const readable = (await this.context.cookies([...FIRST_PARTY_ORIGINS])).filter(
      (cookie) => !cookie.httpOnly,
    );
    const names = unexpectedCookieNames(
      readable.map((cookie) => cookie.name),
      this.allowedCookies,
    );
    if (names.length > 0) {
      this.#add({ kind: "cookie", names, document: "context" });
    }
  }

  /** Records `problem` once: a document reports its cookies when it loads and again when it is left. */
  #add(problem: GuardProblem): void {
    const key = JSON.stringify(problem);
    if (!this.#problems.some((known) => JSON.stringify(known) === key)) {
      this.#problems.push(problem);
    }
  }

  /** A report of a document (through the binding). */
  record(report: unknown): void {
    if (report === null || typeof report !== "object") {
      return;
    }
    const data = report as DocumentReport;
    if (data.kind === "csp") {
      this.#add({
        kind: "csp",
        directive: data.directive,
        blocked: data.blocked === "" ? "(unknown)" : withoutQuery(data.blocked),
        document: withoutQuery(data.document),
        sample: data.sample,
      });
    } else if (data.kind === "cookies") {
      if (isCardPage(data.document)) {
        this.#cardPageSeen = true;
      }
      const names = unexpectedCookieNames(data.names, this.allowedCookies);
      // Only the storefront's own documents: a cross-origin page (an error page of a refused navigation) has its own.
      if (names.length > 0 && FIRST_PARTY_ORIGINS.some((origin) => data.document.startsWith(`${origin}/`))) {
        this.#add({ kind: "cookie", names, document: withoutQuery(data.document) });
      }
    }
  }

  /** A request of any page or frame of the context. */
  request(request: Request): void {
    let pageUrl = "";
    try {
      pageUrl = request.frame().page().url();
    } catch {
      // A request without a frame (a service worker's): the storefront allows none (`worker-src 'none'`).
    }
    if (isCardPage(pageUrl)) {
      this.#cardPageSeen = true;
    }
    if (isThirdPartyRequest(request.url(), pageUrl)) {
      this.#add({
        kind: "third-party",
        url: withoutQuery(request.url()),
        page: pageUrl === "" ? "(no page)" : withoutQuery(pageUrl),
      });
    }
  }

  /**
   * The end of a test: the context's cookies, and axe on `page` when it still shows a storefront page; then fails the
   * test with every problem found.
   */
  async finish(page: Page): Promise<void> {
    await this.checkContextCookies();
    if (!page.isClosed() && FIRST_PARTY_ORIGINS.some((origin) => page.url().startsWith(`${origin}/`))) {
      await this.checkA11y(page);
    }
    this.verify();
  }
}

export interface StorefrontFixtures {
  /** The guards of this test (automatic: every storefront test runs under them). */
  guards: StorefrontGuards;
}

/** `test` of support/fixtures.ts with the automatic `guards` fixture; every storefront spec imports it from here. */
export const test = base.extend<StorefrontFixtures>({
  guards: [
    // It takes `page`, so it is set up after the page exists and torn down before the page closes.
    async ({ context, page }, use) => {
      const guards = await StorefrontGuards.install(context);
      await use(guards);
      await guards.finish(page);
    },
    { auto: true },
  ],
});
