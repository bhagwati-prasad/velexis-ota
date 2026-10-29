// The storefront guards without a browser (OFE-008 step 3): what counts as a third-party request or an unexpected
// cookie, the report of the script every document runs, and the guard object a test's fixture installs and checks at
// its end. The journey proves the same guards in Chromium (specs/storefront/search.e2e.ts, "the storefront guards").
import { runInNewContext } from "node:vm";
import type { Page, Request } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { STOREFRONT_URL, SUSPENDED_STOREFRONT_URL } from "../support/stack";
import {
  CSRF_COOKIE,
  formatProblems,
  GUARD_BINDING,
  GUARD_INIT_SCRIPT,
  isCardPage,
  isThirdPartyRequest,
  STRIPE_JS_COOKIES,
  StorefrontGuards,
  unexpectedCookieNames,
  withoutQuery,
  type GuardedContext,
} from "../support/storefront-guards";

const HOME = `${STOREFRONT_URL}/index.html`;
const CARD_PAGE = `${STOREFRONT_URL}/checkout/pay-card.html?id=chk_1&payment=pay_1`;

describe("isThirdPartyRequest", () => {
  it("allows the storefront's own origins and local schemes [OFE-008 AC2]", () => {
    expect(isThirdPartyRequest(`${STOREFRONT_URL}/api/v1/storefront`, HOME)).toBe(false);
    expect(isThirdPartyRequest(`${SUSPENDED_STOREFRONT_URL}/assets/index.js`, HOME)).toBe(false);
    expect(isThirdPartyRequest("data:image/gif;base64,R0lGODlhAQABAAAAACw=", HOME)).toBe(false);
    expect(isThirdPartyRequest(`blob:${STOREFRONT_URL}/1234`, HOME)).toBe(false);
  });

  it("refuses every other host, Stripe's off the card payment page [OFE-008 AC2]", () => {
    expect(isThirdPartyRequest("https://js.stripe.com/v3/", HOME)).toBe(true);
    expect(
      isThirdPartyRequest("https://api.stripe.com/v1/payment_intents", `${STOREFRONT_URL}/checkout.html`),
    ).toBe(true);
    expect(isThirdPartyRequest("https://fonts.googleapis.com/css2", HOME)).toBe(true);
    expect(isThirdPartyRequest("https://www.google-analytics.com/collect", CARD_PAGE)).toBe(true);
    // Another port of 127.0.0.1 is another origin: the portal, the OTA API itself.
    expect(isThirdPartyRequest("http://127.0.0.1:4000/v1/storefront", HOME)).toBe(true);
    expect(isThirdPartyRequest("http://localhost:4173/index.html", HOME)).toBe(true);
  });

  it("allows Stripe's hosts over https on the card payment page only, never on the airline-card page [OFE-008 AC2]", () => {
    for (const url of [
      "https://js.stripe.com/v3/",
      "https://api.stripe.com/v1/elements/sessions",
      "https://hooks.stripe.com/3d_secure",
      "https://m.stripe.network/inner.html",
      "https://b.stripecdn.com/stripethirdparty-srv/assets/v1.js",
    ]) {
      expect(isThirdPartyRequest(url, CARD_PAGE)).toBe(false);
      expect(isThirdPartyRequest(url, `${STOREFRONT_URL}/checkout/pay-card`)).toBe(false);
      expect(isThirdPartyRequest(url, `${STOREFRONT_URL}/checkout/pay-airline.html`)).toBe(true);
    }
    expect(isThirdPartyRequest("http://js.stripe.com/v3/", CARD_PAGE)).toBe(true);
    expect(isThirdPartyRequest("https://stripe.com.evil.example/v3/", CARD_PAGE)).toBe(true);
    expect(
      isThirdPartyRequest("https://js.stripe.com/v3/", "https://evil.example/checkout/pay-card.html"),
    ).toBe(true);
    expect(isThirdPartyRequest("https://js.stripe.com/v3/", "")).toBe(true);
  });

  it("knows the card payment page by its path on a storefront origin [OFE-008 AC2]", () => {
    expect(isCardPage(CARD_PAGE)).toBe(true);
    expect(isCardPage(`${SUSPENDED_STOREFRONT_URL}/checkout/pay-card`)).toBe(true);
    expect(isCardPage(`${STOREFRONT_URL}/checkout/pay-card.html.evil`)).toBe(false);
    expect(isCardPage("about:blank")).toBe(false);
  });
});

describe("unexpectedCookieNames", () => {
  it("lets the CSRF cookie through and names every other one once [OFE-008 AC2]", () => {
    expect(unexpectedCookieNames([CSRF_COOKIE])).toEqual([]);
    expect(unexpectedCookieNames([])).toEqual([]);
    expect(unexpectedCookieNames([CSRF_COOKIE, " vx_at", "", "_ga", "_ga"])).toEqual(["vx_at", "_ga"]);
  });

  it("[FIX-W32-OTA AC9] lets exactly the names it is given through besides the CSRF cookie, never others", () => {
    expect(STRIPE_JS_COOKIES).toEqual(["__stripe_mid", "__stripe_sid"]);
    expect(unexpectedCookieNames([CSRF_COOKIE, "__stripe_mid", "__stripe_sid"], STRIPE_JS_COOKIES)).toEqual(
      [],
    );
    expect(
      unexpectedCookieNames(
        ["__stripe_mid", "__stripe_orig_props", "__stripe_sid_x", "__Host-vx_at", "_ga"],
        STRIPE_JS_COOKIES,
      ),
    ).toEqual(["__stripe_orig_props", "__stripe_sid_x", "__Host-vx_at", "_ga"]);
    // Without the allowance (every journey but the storefront-stripe ones): Stripe's cookies are refused like any.
    expect(unexpectedCookieNames([CSRF_COOKIE, "__stripe_mid", "__stripe_sid"])).toEqual([
      "__stripe_mid",
      "__stripe_sid",
    ]);
  });
});

describe("withoutQuery", () => {
  it("drops the query string and fragment, which may carry ids or tokens", () => {
    expect(withoutQuery(`${STOREFRONT_URL}/account/verify.html?token=secret#x`)).toBe(
      `${STOREFRONT_URL}/account/verify.html`,
    );
    expect(withoutQuery("inline")).toBe("inline");
  });
});

describe("formatProblems", () => {
  it("names each problem on a line of its own [OFE-008 AC2]", () => {
    expect(
      formatProblems([
        { kind: "csp", directive: "script-src-elem", blocked: "inline", document: HOME, sample: "alert(1)" },
        { kind: "third-party", url: "https://js.stripe.com/v3/", page: HOME },
        { kind: "cookie", names: ["_ga"], document: "context" },
      ]),
    ).toBe(
      [
        `  - securitypolicyviolation: script-src-elem refused inline on ${HOME} ("alert(1)")`,
        `  - request to a third-party host: https://js.stripe.com/v3/ from ${HOME}`,
        "  - cookie readable by JavaScript other than __Host-vx_csrf: _ga on context",
      ].join("\n"),
    );
  });
});

/** The script every document runs, in a fake top-level document with `cookie`; returns its handlers and reports. */
function runInitScript(options: { readonly top: boolean; readonly cookie: string }) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const reports: unknown[] = [];
  const window: Record<string, unknown> = {
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) =>
      handlers.set(type, handler),
    document: { cookie: options.cookie },
    location: { href: HOME },
    [GUARD_BINDING]: (report: unknown) => reports.push(report),
  };
  window["window"] = window;
  window["globalThis"] = window;
  window["top"] = options.top ? window : {};
  runInNewContext(GUARD_INIT_SCRIPT, window);
  return { handlers, reports };
}

describe("GUARD_INIT_SCRIPT", () => {
  it("reports CSP violations of every frame with directive, blocked URI, document and sample [OFE-008 AC2]", () => {
    const { handlers, reports } = runInitScript({ top: false, cookie: "" });
    expect([...handlers.keys()]).toEqual(["securitypolicyviolation"]);
    handlers.get("securitypolicyviolation")?.({
      effectiveDirective: "script-src-elem",
      blockedURI: "inline",
      documentURI: HOME,
      sample: "document.title = 1",
    });
    expect(reports).toEqual([
      {
        kind: "csp",
        directive: "script-src-elem",
        blocked: "inline",
        document: HOME,
        sample: "document.title = 1",
      },
    ]);
  });

  it("reports the cookie names of a top-level document when it loads and is left, never a value [OFE-008 AC2]", () => {
    const { handlers, reports } = runInitScript({
      top: true,
      cookie: `${CSRF_COOKIE}=csrf-value; _ga=GA1.2.3`,
    });
    expect([...handlers.keys()].sort()).toEqual(["load", "pagehide", "securitypolicyviolation"]);
    handlers.get("load")?.({});
    handlers.get("pagehide")?.({});
    const names = { kind: "cookies", names: [CSRF_COOKIE, "_ga"], document: HOME };
    expect(reports).toEqual([names, names]);
    expect(JSON.stringify(reports)).not.toMatch(/csrf-value|GA1/);
  });
});

/** A fake browser context: the binding, the init script and the request listener the guards install. */
function fakeContext(cookies: { name: string; httpOnly: boolean }[] = []) {
  const installed: {
    binding?: (source: unknown, report: unknown) => void;
    bindingName?: string;
    script?: string;
    onRequest?: (request: Request) => void;
  } = {};
  const context = {
    exposeBinding: async (name: string, callback: (source: unknown, report: unknown) => void) => {
      installed.bindingName = name;
      installed.binding = callback;
    },
    addInitScript: async (script: { content: string }) => {
      installed.script = script.content;
    },
    cookies: async () => cookies.map((cookie) => ({ ...cookie, value: "x", domain: "127.0.0.1", path: "/" })),
    on: (event: string, listener: (request: Request) => void) => {
      if (event === "request") {
        installed.onRequest = listener;
      }
    },
  } as unknown as GuardedContext;
  return { context, installed };
}

/** A fake request from the top-level page at `pageUrl`. */
function fakeRequest(url: string, pageUrl: string): Request {
  return { url: () => url, frame: () => ({ page: () => ({ url: () => pageUrl }) }) } as unknown as Request;
}

/** A page the end-of-test check skips axe on (closed, or not a storefront page). */
const closedPage = { isClosed: () => true, url: () => "about:blank" } as unknown as Page;

describe("StorefrontGuards", () => {
  it("installs its binding, its script and its request listener on the context [OFE-008 AC2]", async () => {
    const { context, installed } = fakeContext();
    await StorefrontGuards.install(context);
    expect(installed.bindingName).toBe(GUARD_BINDING);
    expect(installed.script).toBe(GUARD_INIT_SCRIPT);
    expect(installed.onRequest).toBeTypeOf("function");
  });

  it("fails the end of a test on a CSP violation reported by a document [OFE-008 AC2]", async () => {
    const { context, installed } = fakeContext();
    const guards = await StorefrontGuards.install(context);
    await guards.finish(closedPage);
    installed.binding?.(
      {},
      {
        kind: "csp",
        directive: "script-src-elem",
        blocked: "inline",
        document: `${HOME}?search=srch_1`,
        sample: "",
      },
    );
    await expect(guards.finish(closedPage)).rejects.toThrow(
      `The storefront guards failed this test:\n  - securitypolicyviolation: script-src-elem refused inline on ${HOME}`,
    );
    expect(guards.forget()).toHaveLength(1);
    await guards.finish(closedPage);
  });

  it("records a third-party request once, without its query string, and lets Stripe through on the card page [OFE-008 AC2]", async () => {
    const { context, installed } = fakeContext();
    const guards = await StorefrontGuards.install(context);
    installed.onRequest?.(fakeRequest("https://js.stripe.com/v3/", CARD_PAGE));
    installed.onRequest?.(fakeRequest(`${STOREFRONT_URL}/api/v1/storefront`, HOME));
    expect(guards.problems).toEqual([]);
    installed.onRequest?.(fakeRequest("https://tracker.example/pixel?user=1", `${HOME}?x=1`));
    installed.onRequest?.(fakeRequest("https://tracker.example/pixel?user=2", `${HOME}?x=2`));
    expect(guards.problems).toEqual([
      { kind: "third-party", url: "https://tracker.example/pixel", page: HOME },
    ]);
    expect(() => guards.verify()).toThrow(/request to a third-party host: https:\/\/tracker\.example\/pixel/);
  });

  it("records the unexpected cookies of storefront documents only [OFE-008 AC2]", async () => {
    const { context, installed } = fakeContext();
    const guards = await StorefrontGuards.install(context);
    installed.binding?.({}, { kind: "cookies", names: [CSRF_COOKIE], document: HOME });
    installed.binding?.(
      {},
      { kind: "cookies", names: ["other"], document: "https://js.stripe.com/v3/m.html" },
    );
    installed.binding?.({}, null);
    expect(guards.problems).toEqual([]);
    installed.binding?.({}, { kind: "cookies", names: [CSRF_COOKIE, "vx_session"], document: HOME });
    installed.binding?.({}, { kind: "cookies", names: [CSRF_COOKIE, "vx_session"], document: HOME });
    expect(guards.problems).toEqual([{ kind: "cookie", names: ["vx_session"], document: HOME }]);
  });

  it("[FIX-W32-OTA AC9] allows the Stripe.js cookies in a storefront-stripe journey from the card page on, and nothing more", async () => {
    const stripeCookies = ["__stripe_mid", "__stripe_sid"];
    const confirmation = `${STOREFRONT_URL}/confirmation.html?booking=bkg_1`;
    const { context, installed } = fakeContext([
      { name: CSRF_COOKIE, httpOnly: false },
      { name: "__stripe_mid", httpOnly: false },
      { name: "__stripe_sid", httpOnly: false },
    ]);
    const guards = await StorefrontGuards.install(context, { stripeJourney: true });
    expect(guards.allowedCookies).toEqual([]);
    // Before the card page: the Stripe.js cookies are not the storefront's (Stripe.js runs on the card page only).
    installed.binding?.({}, { kind: "cookies", names: [CSRF_COOKIE, ...stripeCookies], document: HOME });
    expect(guards.forget()).toEqual([{ kind: "cookie", names: stripeCookies, document: HOME }]);

    // The card page (its document, or a request it makes), and every page after it in the context.
    installed.onRequest?.(fakeRequest("https://js.stripe.com/v3/", CARD_PAGE));
    expect(guards.allowedCookies).toEqual(STRIPE_JS_COOKIES);
    installed.binding?.({}, { kind: "cookies", names: [CSRF_COOKIE, ...stripeCookies], document: CARD_PAGE });
    installed.binding?.(
      {},
      { kind: "cookies", names: [CSRF_COOKIE, ...stripeCookies], document: confirmation },
    );
    await guards.finish(closedPage);
    expect(guards.problems).toEqual([]);

    // Never another name, even after the card page.
    installed.binding?.(
      {},
      { kind: "cookies", names: [...stripeCookies, "__stripe_orig_props", "_ga"], document: confirmation },
    );
    expect(guards.forget()).toEqual([
      {
        kind: "cookie",
        names: ["__stripe_orig_props", "_ga"],
        document: `${STOREFRONT_URL}/confirmation.html`,
      },
    ]);
  });

  it("[FIX-W32-OTA AC9] refuses the Stripe.js cookies in any other journey, even on the card page, and at the end", async () => {
    const { context, installed } = fakeContext([{ name: "__stripe_mid", httpOnly: false }]);
    const guards = await StorefrontGuards.install(context);
    installed.onRequest?.(fakeRequest("https://js.stripe.com/v3/", CARD_PAGE));
    installed.binding?.({}, { kind: "cookies", names: [CSRF_COOKIE, "__stripe_sid"], document: CARD_PAGE });
    expect(guards.allowedCookies).toEqual([]);
    await expect(guards.finish(closedPage)).rejects.toThrow(
      /cookie readable by JavaScript other than __Host-vx_csrf: __stripe_sid on .*\n.*__stripe_mid on context/s,
    );
  });

  it("[FIX-W32-OTA AC9] refuses the Stripe.js cookies of a storefront-stripe journey's context that never showed the card page", async () => {
    const { context } = fakeContext([
      { name: CSRF_COOKIE, httpOnly: false },
      { name: "__stripe_mid", httpOnly: false },
    ]);
    const guards = await StorefrontGuards.install(context, { stripeJourney: true });
    await expect(guards.finish(closedPage)).rejects.toThrow(/__stripe_mid on context/);
  });

  it("checks the context's cookies at the end: httpOnly ones are allowed, readable ones only the CSRF cookie [OFE-008 AC2]", async () => {
    const allowed = fakeContext([
      { name: CSRF_COOKIE, httpOnly: false },
      { name: "__Host-vx_at", httpOnly: true },
    ]);
    await (await StorefrontGuards.install(allowed.context)).finish(closedPage);
    const readable = fakeContext([
      { name: CSRF_COOKIE, httpOnly: false },
      { name: "__Host-vx_rt", httpOnly: false },
    ]);
    await expect((await StorefrontGuards.install(readable.context)).finish(closedPage)).rejects.toThrow(
      /cookie readable by JavaScript other than __Host-vx_csrf: __Host-vx_rt on context/,
    );
  });
});
