// The storefront on a phone (OFE-030; ota/frontend/README.md §8, ota/docs/storefront-accessibility.md §1): axe with
// the WCAG 2.2 A and AA rules (`expectNoSeriousA11yViolations`, through the storefront guards) at 360 × 800 CSS
// pixels, a phone held upright, where `a11y-pages.e2e.ts` and every other journey run at `lg` or wider. In the
// `storefront` project: the production build in `vite preview` for the demo OTA, proxied to the OTA API, the OTA
// worker and the Amadeus stub, under the storefront guards (CSP, third-party requests, readable cookies, axe).
//
//   1. the page list equals the build's, as in `a11y-pages.e2e.ts`: a page a later task adds fails this spec too;
//   2. every page in the states every page shares (docs/pages.md §2): loading, and `storefront.get` answered with
//      `403 TENANT_SUSPENDED`, `403 HOST_NOT_ALLOWED`, `503`, `429` and `500`;
//   3. every page with the header at its fullest: an OTA name too long for one line, two currencies (the selector) and
//      a signed-in customer's account menu (a greeting, "My account" and "Sign out"), and the same pages for a visitor;
//      the page reflows to the phone's width (1.4.10: no sideways scrolling);
//   4. the home and results pages in the states a traveller meets first (the search form, its checks, the location
//      suggestions, the passengers, multi-city; the offers and the "Filters" disclosure), and the keyboard's focus
//      from the skip link to the search button never hidden behind anything (2.4.11);
//   5. (OFE-031) a signed-in customer's compact account menu below md: part 3 judges every page with the menu closed
//      and open; the page's layout shifts while storefront.get and then auth.getSession are held and answered, summed
//      with a PerformanceObserver at 360 and 412 px: nothing moves when the session answers (the header keeps its
//      height and nothing in it moves), and the home page moves by nothing at all; the menu's links by keyboard and by
//      pointer; and the search form's plain form when its module never mounts (the page's scripts aborted), which a
//      form mounted in time never shows. The footer shows the OTA's whole name on every page (part 3);
//   6. (OFE-032) a signed-in customer with a 23-character first name on home, in windows from 768 to 1280 px, for the
//      demo OTA and with a long OTA name and two currencies: below lg (768, 800, 850, 900 and 1023 px) the compact
//      menu, and nothing moves when the session answers late (OFE-031's held answers), axe with the menu closed and
//      open at 800 and 1023 px; from lg (1024 and 1280 px) the signed-in links in the navigation's row, which does
//      not wrap.
//
// What the stack cannot answer on demand is answered in the browser (`page.route`), and only that: the shared states
// of `storefront.get` (the API's error envelope) and, for parts 3 and 6, storefront.get's own answer with the OTA's
// name and currencies changed. Parts 5 and 6 hold storefront.get and auth.getSession in the browser and then let them
// through (to part 6's changed answer where it has one, else to the API), and part 5 aborts the page's scripts where
// it needs a module that never mounts. The customers sign up through the OTA API (`auth.signUp`, as the browser's SDK
// calls it). The pages, their scripts and their headers stay the preview's. Stripe.js never comes from the network
// (its request is aborted): the card page then shows "Card payment is unavailable".
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { uniqueTestIp } from "../../support/fixtures";
import { uniqueEmail } from "../../support/mailpit";
import { departureDate, StorefrontApi } from "../../support/ota";
import { newPassword } from "../../support/seed";
import { REPO_ROOT, STOREFRONT_URL } from "../../support/stack";
import { expect, StorefrontGuards, test } from "../../support/storefront-guards";

/** A phone held upright: 360 × 800 CSS pixels, touch, the device pixel ratio of a common Android phone. */
const PHONE = Object.freeze({
  viewport: Object.freeze({ width: 360, height: 800 }),
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

test.use({ ...PHONE });

/**
 * The phones of part 5's layout-shift check: 360 × 800 (PHONE) and Lighthouse's own 412 × 823 (the Moto G Power,
 * device pixel ratio 1.75, scripts/lighthouse.mjs).
 */
const SHIFT_PHONES = Object.freeze([
  PHONE,
  Object.freeze({
    viewport: Object.freeze({ width: 412, height: 823 }),
    deviceScaleFactor: 1.75,
    isMobile: true,
    hasTouch: true,
  }),
]);
/** A browser's device in this spec: a phone of SHIFT_PHONES, or OFE-032's window (WINDOW). */
interface Phone {
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

/** How long a search form whose module never mounts may keep its enhanced shape: main.css's 5 s, and a margin. */
const FALLBACK_BUDGET_MS = 10_000;

/** The built storefront the preview serves. */
const DIST = join(REPO_ROOT, "ota", "frontend", "dist");

/** What shows that a page is ready to be judged: a locator that becomes visible once its module has run. */
type Ready = (page: Page) => Locator;

const inMain =
  (text: string | RegExp): Ready =>
  (page) =>
    page.getByRole("main").getByText(text).first();
const heading =
  (name: string | RegExp): Ready =>
  (page) =>
    page.getByRole("heading", { level: 1, name }).first();
const button =
  (name: string | RegExp): Ready =>
  (page) =>
    page.getByRole("main").getByRole("button", { name }).first();
const anyState: Ready = (page) => page.locator("main [data-state]").first();
const searchForm: Ready = (page) => page.locator('main form[data-search-form][data-enhanced="true"]');

/**
 * Every page of the build (its file in dist/), the address that opens it (those of `a11y-pages.e2e.ts`), and what it
 * shows once ready for a visitor and for a signed-in customer (a page for customers only sends a visitor to sign-in;
 * sign-in and sign-up send a customer to the account page). `header`: "static" when the page fills only the OTA's name
 * of the static header, without boot() (the airline-card page, docs/pages.md §9: no currency selector, no account
 * menu); "no currency" when the page takes the currency selector away (the card page: the payment's currency is fixed).
 */
const PAGES: readonly {
  readonly file: string;
  readonly path: string;
  readonly visitor: Ready;
  readonly customer: Ready;
  readonly header?: "static" | "no currency";
}[] = Object.freeze([
  {
    file: "404.html",
    path: "/404.html",
    visitor: heading("Page not found"),
    customer: heading("Page not found"),
  },
  {
    file: "account/forgot-password.html",
    path: "/account/forgot-password.html",
    visitor: button(/link/i),
    customer: button(/link/i),
  },
  {
    file: "account/index.html",
    path: "/account/",
    visitor: heading("Sign in"),
    customer: heading("My account"),
  },
  {
    file: "account/reset-password.html",
    path: "/account/reset-password.html",
    visitor: inMain("Request a new link"),
    customer: inMain("Request a new link"),
  },
  {
    file: "account/sign-in.html",
    path: "/account/sign-in.html",
    visitor: button("Sign in"),
    customer: heading("My account"),
  },
  {
    file: "account/sign-up.html",
    path: "/account/sign-up.html",
    visitor: button("Create account"),
    customer: heading("My account"),
  },
  {
    file: "account/verify.html",
    path: "/account/verify.html",
    visitor: (page) => page.getByRole("heading", { name: "Get a new link" }),
    customer: (page) => page.getByRole("heading", { name: "Get a new link" }),
  },
  { file: "booking.html", path: "/booking.html", visitor: anyState, customer: anyState },
  {
    file: "bookings.html",
    path: "/bookings.html",
    visitor: heading("Sign in"),
    customer: inMain("No upcoming trips"),
  },
  {
    file: "checkout.html",
    path: "/checkout.html",
    visitor: inMain("We could not find this checkout"),
    customer: inMain("We could not find this checkout"),
  },
  {
    file: "checkout/complete.html",
    path: "/checkout/complete.html",
    visitor: inMain("We could not find this payment"),
    customer: inMain("We could not find this payment"),
  },
  // With well-formed ids: without them the airline-card page says "We could not find this payment" before it asks
  // the API anything (docs/pages.md §9).
  {
    file: "checkout/pay-airline.html",
    path: "/checkout/pay-airline.html?id=chk_0000000000000000000000AXE1&payment=pay_0000000000000000000000AXE1",
    visitor: anyState,
    customer: anyState,
    header: "static",
  },
  {
    file: "checkout/pay-card.html",
    path: "/checkout/pay-card.html",
    visitor: inMain("We could not find this payment"),
    customer: inMain("We could not find this payment"),
    header: "no currency",
  },
  {
    file: "confirmation.html",
    path: "/confirmation.html",
    visitor: inMain("We could not find this booking"),
    customer: inMain("We could not find this booking"),
  },
  { file: "index.html", path: "/", visitor: searchForm, customer: searchForm },
  {
    file: "lookup.html",
    path: "/lookup.html",
    visitor: button("Find my booking"),
    customer: button("Find my booking"),
  },
  {
    file: "offer.html",
    path: "/offer.html",
    visitor: inMain("We could not find this flight"),
    customer: inMain("We could not find this flight"),
  },
  {
    file: "p.html",
    path: "/p/about",
    visitor: heading("Page not found"),
    customer: heading("Page not found"),
  },
  {
    file: "price.html",
    path: "/price.html",
    visitor: inMain("We could not find this price"),
    customer: inMain("We could not find this price"),
  },
  { file: "search.html", path: "/search.html", visitor: searchForm, customer: searchForm },
]);

/** The states of `storefront.get` that every page shares (docs/pages.md §2), by the `data-state` they render. */
const SHARED_STATES: readonly {
  readonly state: string;
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
}[] = Object.freeze([
  { state: "suspended", status: 403, code: "TENANT_SUSPENDED" },
  { state: "unknown-host", status: 403, code: "HOST_NOT_ALLOWED" },
  // A Retry-After beyond the SDK's 30 s makes it give up at once instead of retrying (ota/sdk http.js).
  { state: "unavailable", status: 503, code: "SERVICE_UNAVAILABLE", retryAfter: 60 },
  { state: "rate-limited", status: 429, code: "RATE_LIMITED", retryAfter: 60 },
  { state: "unexpected", status: 500, code: "INTERNAL_ERROR" },
]);

/** An OTA name too long for one line of a phone's header (57 characters; the header cuts it with an ellipsis). */
const LONG_NAME = "Mediterranean Sunshine Holidays and Flights International";

/** The second currency of the header's selector, besides the demo OTA's own (EUR). */
const SECOND_CURRENCY = Object.freeze({ code: "USD", name: "US Dollar", symbol: "$", decimals: 2 });

/** The customer of part 3: synthetic. */
const CUSTOMER = Object.freeze({ firstName: "Alba", lastName: "Axetest" });

/** The departure this spec searches, days from today: a date of its own (searches are shared for 30 s, OADR-0002). */
const SEARCH_DAYS_AHEAD = 71;

/** How long the arrangements of a `beforeAll` may take: two browsers and a sign-up through the OTA API. */
const ARRANGE_TIMEOUT_MS = 30_000;

/** A request id the routed error answers carry, as the API's would (the state shows it for support). */
const ROUTED_REQUEST_ID = "req_e2e_a11y_phone";

/** The API's error envelope (docs/mvp/conventions.md §6), as the routed answers send it. */
function errorBody(status: number, code: string): string {
  return JSON.stringify({
    error: { code, message: `Answered by the phone pass: ${code}`, status, requestId: ROUTED_REQUEST_ID },
  });
}

/** The state element a page rendered for `name` (boot's full-page states and the pages' own, `renderState`). */
const stateOf = (page: Page, name: string) => page.locator(`main [data-state="${name}"]`).first();

/**
 * In the browser: whether the page needs no sideways scrolling at the phone's width (1.4.10 Reflow): the document is no
 * wider than `width`, the phone's CSS width. Not `window.innerWidth`: under the phone emulation (`isMobile`) Chromium
 * widens it to the content's width when a page overflows (a 600 px block gives `innerWidth` 608 at 360 px), so a
 * comparison with it never fails. Playwright sends this function's source to the page, so it uses nothing from its
 * module.
 */
function reflows(width: number): boolean {
  return document.documentElement.scrollWidth <= width;
}

/** Whether `page` needs no sideways scrolling on the phone (`reflows` at the phone's width). */
const reflowsOnPhone = (page: Page): Promise<boolean> => page.evaluate(reflows, PHONE.viewport.width);

/** One browser of the spec at phone size: its context, page and guards, with an end-user IP of its own. */
interface Browsing {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly guards: StorefrontGuards;
  readonly api: StorefrontApi;
}

async function openBrowsing(browser: Browser, phone: Phone = PHONE): Promise<Browsing> {
  const ip = uniqueTestIp();
  const context = await browser.newContext({
    ...phone,
    baseURL: STOREFRONT_URL,
    extraHTTPHeaders: { "X-Forwarded-For": ip },
  });
  // Stripe.js never comes from the network in this spec: the card page then shows "Card payment is unavailable".
  await context.route("https://js.stripe.com/**", (route) => route.abort("blockedbyclient"));
  const guards = await StorefrontGuards.install(context);
  const page = await context.newPage();
  return { context, page, guards, api: new StorefrontApi(context, ip) };
}

/**
 * storefront.get answered with the API's own configuration, the OTA's name and its currencies changed: the header at
 * its fullest on a phone (part 3).
 */
async function withFullestHeader(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.pathname === "/api/v1/storefront",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      const currencies = Array.isArray(body["currencies"]) ? (body["currencies"] as unknown[]) : [];
      await route.fulfill({
        response,
        body: JSON.stringify({ ...body, name: LONG_NAME, currencies: [...currencies, SECOND_CURRENCY] }),
      });
    },
  );
}

/**
 * The header's parts on a phone: the name, the currency selector and the account menu (below lg a signed-in
 * customer's "Account" button and the panel it opens, OFE-031 below md, OFE-032 up to lg); and the footer's line with
 * the OTA's whole name.
 */
function header(page: Page) {
  const banner = page.getByRole("banner");
  return {
    name: banner.locator('a[data-field="brandName"]'),
    currency: banner.getByRole("combobox", { name: "Currency" }),
    signIn: banner.getByRole("link", { name: "Sign in", exact: true }),
    menu: banner.getByRole("button", { name: "Account", exact: true }),
    account: banner.getByRole("link", { name: "My account", exact: true }),
    signOut: banner.getByRole("button", { name: "Sign out" }),
    greeting: banner.getByText(`Hi, ${CUSTOMER.firstName}`, { exact: true }),
    footerName: page.getByRole("contentinfo").locator('[data-field="footerName"]'),
  };
}

/**
 * Signs a new customer up through the OTA API in `browsing`'s context, as the sign-up page's SDK does: the demo OTA
 * opens the session at once (its e-mail verification is optional), in the context's httpOnly cookies.
 */
async function signUp(
  browsing: Browsing,
  tag: string,
  firstName: string = CUSTOMER.firstName,
): Promise<void> {
  const config = (await browsing.api.call("getStorefront", "GET", "/v1/storefront")) as {
    legal?: { termsVersion?: string | null };
  };
  const termsVersion = config.legal?.termsVersion;
  await browsing.api.call(
    "signUp",
    "POST",
    "/v1/auth/sign-up",
    {
      email: uniqueEmail(tag),
      password: newPassword(),
      firstName,
      lastName: CUSTOMER.lastName,
      marketingConsent: false,
      ...(typeof termsVersion === "string" && termsVersion !== "" ? { termsVersion } : {}),
    },
    201,
  );
}

/** What the page's focus is on, for 2.4.11: the element, and whether its centre is in the window and uncovered. */
interface FocusStop {
  readonly element: string;
  readonly unobscured: boolean;
  readonly searchButton: boolean;
}

/**
 * In the browser (self-contained, as Playwright sends its source): the focused element, whether the element at its
 * centre is that element or inside it (nothing, the test banner included, covers it), and whether it is the search
 * form's submit button.
 */
function focusStop(): FocusStop | null {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || element === document.body) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  // The layout viewport's size, not `window.innerWidth` (see `reflows`: the phone emulation can widen that).
  const view = document.documentElement;
  const inWindow = x >= 0 && y >= 0 && x < view.clientWidth && y < view.clientHeight;
  const hit = inWindow ? document.elementFromPoint(x, y) : null;
  const labels = element instanceof HTMLInputElement ? Array.from(element.labels ?? []) : [];
  const text = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40);
  return {
    element: `${element.tagName.toLowerCase()}${element.id === "" ? "" : `#${element.id}`} "${text}"`,
    unobscured:
      hit !== null &&
      (hit === element ||
        element.contains(hit) ||
        labels.some((label) => label === hit || label.contains(hit))),
    searchButton: element.matches("form[data-search-form] button[type='submit']"),
  };
}

/** The most focus stops from the top of the home page to the search button (the header's and the form's). */
const MAX_FOCUS_STOPS = 40;

test.describe("every page of the build", () => {
  test("the spec covers every page the build has [OFE-030 AC2]", () => {
    const built = readdirSync(DIST, { recursive: true, encoding: "utf8" })
      .map((file) => file.split(/[\\/]/).join("/"))
      .filter((file) => file.endsWith(".html"))
      .sort();
    expect(PAGES.map((page) => page.file).sort()).toEqual(built);
  });
});

test.describe("the states every page shares, on a phone", () => {
  for (const target of PAGES) {
    test(`${target.file} at 360 px: loading, suspended, unknown host, unavailable, busy and unexpected [OFE-030 AC2]`, async ({
      page,
      guards,
    }) => {
      await page.context().route("https://js.stripe.com/**", (route) => route.abort("blockedbyclient"));
      // One handler for storefront.get: held while the page loads, then the API's refusal of the state in turn.
      let release: (() => void) | undefined;
      let answer: (typeof SHARED_STATES)[number] | "hold" = "hold";
      await page.route(
        (url) => url.pathname === "/api/v1/storefront",
        async (route) => {
          if (answer === "hold") {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            // Never the real configuration: the page would keep it for 5 minutes and not ask again.
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              headers: { "retry-after": "60" },
              body: errorBody(503, "SERVICE_UNAVAILABLE"),
            });
            return;
          }
          await route.fulfill({
            status: answer.status,
            contentType: "application/json",
            headers: answer.retryAfter === undefined ? {} : { "retry-after": String(answer.retryAfter) },
            body: errorBody(answer.status, answer.code),
          });
        },
      );

      // Loading: the static page with storefront.get still on its way.
      await page.goto(target.path);
      await expect.poll(() => release !== undefined).toBe(true);
      await expect(page.locator("main")).toBeVisible();
      expect(await reflowsOnPhone(page), "no sideways scrolling").toBe(true);
      await guards.checkA11y(page);
      release?.();

      for (const state of SHARED_STATES) {
        answer = state;
        await page.goto(target.path);
        await expect(stateOf(page, state.state)).toBeVisible();
        expect(await reflowsOnPhone(page), `no sideways scrolling (${state.state})`).toBe(true);
        await guards.checkA11y(page);
      }
    });
  }
});

test.describe("every page with a long OTA name, two currencies and a signed-in customer, on a phone", () => {
  test.describe.configure({ mode: "serial" });

  let visitor: Browsing;
  let customer: Browsing;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(ARRANGE_TIMEOUT_MS);
    visitor = await openBrowsing(browser);
    customer = await openBrowsing(browser);
    await withFullestHeader(visitor.context);
    await withFullestHeader(customer.context);
    await signUp(customer, "ofe030-phone");
  });

  test.afterEach(async () => {
    for (const browsing of [visitor, customer]) {
      await browsing?.page.unrouteAll({ behavior: "ignoreErrors" });
      await browsing?.guards.finish(browsing.page);
    }
  });

  test.afterAll(async () => {
    await visitor?.context.close();
    await customer?.context.close();
  });

  for (const target of PAGES) {
    test(`${target.file} at 360 px for a visitor and for a customer, the account menu closed and open, the OTA's whole name in the footer [OFE-030 AC2] [OFE-031 AC2]`, async () => {
      for (const [browsing, signedIn] of [
        [visitor, false],
        [customer, true],
      ] as const) {
        const { page, guards } = browsing;
        await page.goto(target.path);
        const parts = header(page);
        // The whole name in the link's text, on one line; in the footer too, on a line that wraps (OFE-031).
        await expect(parts.name).toHaveText(LONG_NAME);
        await expect(parts.footerName).toHaveText(LONG_NAME);
        await expect(parts.footerName).toBeVisible();
        const signedInMenu = signedIn && target.header !== "static";
        if (target.header === "static") {
          // The static header's links as the partial has them, for the customer too.
          await expect(parts.signIn).toBeVisible();
          await expect(parts.currency).toHaveCount(0);
        } else {
          // The whole name in the link's title too; the selector with both currencies; the account menu.
          await expect(parts.name).toHaveAttribute("title", LONG_NAME);
          if (target.header === "no currency") {
            await expect(parts.currency).toHaveCount(0);
          } else {
            await expect(parts.currency).toBeVisible();
            await expect(parts.currency.locator("option")).toHaveCount(2);
          }
          if (signedInMenu) {
            // Below md one "Account" button, its panel closed (OFE-031).
            await expect(parts.menu).toBeVisible();
            await expect(parts.menu).toHaveAttribute("aria-expanded", "false");
            await expect(parts.signOut).toBeHidden();
          } else {
            await expect(parts.signIn).toBeVisible();
          }
        }
        await expect((signedIn ? target.customer : target.visitor)(page)).toBeVisible();
        expect(await reflowsOnPhone(page), "no sideways scrolling").toBe(true);
        await guards.checkA11y(page);
        if (signedInMenu) {
          // The panel open: the greeting, "My account" and "Sign out", over the page, still within its width.
          await parts.menu.click();
          await expect(parts.menu).toHaveAttribute("aria-expanded", "true");
          await expect(parts.greeting).toBeVisible();
          await expect(parts.account).toBeVisible();
          await expect(parts.signOut).toBeVisible();
          expect(await reflowsOnPhone(page), "no sideways scrolling with the account menu open").toBe(true);
          await guards.checkA11y(page);
          await page.keyboard.press("Escape");
          await expect(parts.menu).toHaveAttribute("aria-expanded", "false");
          await expect(parts.menu).toBeFocused();
        }
      }
    });
  }
});

test.describe("home and results on a phone", () => {
  test.describe.configure({ mode: "serial" });

  let browsing: Browsing;

  test.beforeAll(async ({ browser }) => {
    browsing = await openBrowsing(browser);
  });

  test.afterEach(async () => {
    await page().unrouteAll({ behavior: "ignoreErrors" });
    await browsing?.guards.finish(page());
  });

  test.afterAll(async () => {
    await browsing?.context.close();
  });

  const page = () => browsing.page;

  test("home at 360 px: the search form, its checks, the suggestions, the passengers and multi-city [OFE-030 AC2]", async () => {
    await page().goto("/");
    const form = page().getByRole("form", { name: "Search flights" });
    await expect(page().locator('form[data-search-form][data-enhanced="true"]')).toBeVisible();
    expect(await reflowsOnPhone(page()), "no sideways scrolling").toBe(true);
    await browsing.guards.checkA11y(page());

    // Sent empty: the error summary takes the focus.
    await form.getByRole("button", { name: "Search flights" }).click();
    await expect(form.getByRole("heading", { name: /^There (is|are) \d+ problems?$/ })).toBeVisible();
    expect(await reflowsOnPhone(page()), "no sideways scrolling with the errors").toBe(true);
    await browsing.guards.checkA11y(page());

    // The location combobox with its suggestions open.
    await form.getByRole("combobox", { name: "From" }).fill("Madrid");
    await expect(page().getByRole("listbox", { name: "From" }).getByRole("option").first()).toBeVisible();
    await browsing.guards.checkA11y(page());
    await page().keyboard.press("Escape");

    // The passenger picker open, then the multi-city legs.
    const passengers = form.getByRole("button", { name: /passenger|traveller|adult/i }).first();
    await passengers.click();
    await expect(passengers).toHaveAttribute("aria-expanded", "true");
    await expect(form.getByRole("group", { name: "Passengers" })).toBeVisible();
    expect(await reflowsOnPhone(page()), "no sideways scrolling with the passengers open").toBe(true);
    await browsing.guards.checkA11y(page());
    await form.getByRole("radio", { name: "Multi-city" }).check();
    await expect(form.locator("[data-legs] > li").first()).toBeVisible();
    expect(await reflowsOnPhone(page()), "no sideways scrolling with the legs").toBe(true);
    await browsing.guards.checkA11y(page());
  });

  test("home at 360 px: every focus stop from the top to the search button is in view and uncovered [OFE-030 AC2]", async () => {
    await page().goto("/");
    await expect(page().locator('form[data-search-form][data-enhanced="true"]')).toBeVisible();
    const stops: FocusStop[] = [];
    for (let presses = 0; presses < MAX_FOCUS_STOPS; presses += 1) {
      await page().keyboard.press("Tab");
      const stop = await page().evaluate(focusStop);
      if (stop === null) {
        continue;
      }
      stops.push(stop);
      if (stop.searchButton) {
        break;
      }
    }
    expect(stops.at(-1)?.searchButton, "the search button is reached by the keyboard").toBe(true);
    expect(stops.filter((stop) => !stop.unobscured).map((stop) => stop.element)).toEqual([]);
  });

  test("results at 360 px: the offers and the filters disclosure [OFE-030 AC2]", async () => {
    const query = new URLSearchParams({
      trip: "oneway",
      from: "MAD",
      to: "PAR",
      depart: departureDate(SEARCH_DAYS_AHEAD),
      adults: "1",
      children: "0",
      infants: "0",
      cabin: "ECONOMY",
    });
    await page().goto(`/search.html?${query.toString()}`);
    const results = page().getByRole("region", { name: /flights?$/ });
    await expect(results.getByRole("link", { name: /^Select this flight for / }).first()).toBeVisible();
    expect(await reflowsOnPhone(page()), "no sideways scrolling").toBe(true);
    await browsing.guards.checkA11y(page());

    // On a phone the filters are behind their disclosure (OFE-027): open it.
    const filters = page().locator("main button[data-filters-toggle]");
    await filters.click();
    await expect(filters).toHaveAttribute("aria-expanded", "true");
    expect(await reflowsOnPhone(page()), "no sideways scrolling with the filters open").toBe(true);
    await browsing.guards.checkA11y(page());
  });
});

/** A layout shift the page recorded (part 5): its score, whether input caused it, and whether it moved the header. */
interface RecordedShift {
  readonly value: number;
  readonly recentInput: boolean;
  readonly inHeader: boolean;
}

/**
 * In the browser, before the page's own scripts (an init script): records every layout shift with a
 * PerformanceObserver (`buffered`: none before it is lost), whether input caused it and whether an element of the
 * header moved, and offers `__vxTakeShifts()`, which also takes the entries not delivered yet and empties the record.
 * Playwright sends this function's source to the page, so it uses nothing from its module.
 */
function recordLayoutShifts(): void {
  type Entry = PerformanceEntry & {
    readonly value: number;
    readonly hadRecentInput: boolean;
    readonly sources?: ReadonlyArray<{ readonly node?: Node | null }>;
  };
  const shifts: { value: number; recentInput: boolean; inHeader: boolean }[] = [];
  const keep = (entries: PerformanceEntryList) => {
    const banner = document.querySelector("body > header");
    for (const entry of entries as Entry[]) {
      shifts.push({
        value: entry.value,
        recentInput: entry.hadRecentInput,
        inHeader: (entry.sources ?? []).some(
          (source) => source.node instanceof Node && banner !== null && banner.contains(source.node),
        ),
      });
    }
  };
  const observer = new PerformanceObserver((list) => keep(list.getEntries()));
  observer.observe({ type: "layout-shift", buffered: true });
  Object.assign(window, {
    __vxTakeShifts: () => {
      keep(observer.takeRecords());
      return shifts.splice(0);
    },
  });
}

/** The layout shifts the page recorded since the last call, once two frames have been painted. */
async function takeShifts(page: Page): Promise<RecordedShift[]> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  return page.evaluate(() =>
    (window as unknown as { __vxTakeShifts: () => RecordedShift[] }).__vxTakeShifts(),
  );
}

/** The sum of the shifts no input caused, as CLS counts them. */
const scoreOf = (shifts: readonly RecordedShift[]): number =>
  shifts.filter((shift) => !shift.recentInput).reduce((sum, shift) => sum + shift.value, 0);

/** Where the header ends and the main content starts, in the document, and how high the navigation is. */
const headerGeometry = (page: Page) =>
  page.evaluate(() => {
    const banner = document.querySelector("body > header")?.getBoundingClientRect();
    const main = document.querySelector("main")?.getBoundingClientRect();
    const nav = document.querySelector("body > header nav")?.getBoundingClientRect();
    return {
      headerHeight: banner?.height ?? -1,
      mainTop: (main?.top ?? -1) + window.scrollY,
      navHeight: nav?.height ?? -1,
    };
  });

/**
 * Holds the page's requests to `pathname` until `release()`, then lets them through as they are: to the context's own
 * route of that address when it has one (OFE-032's long OTA name, `withFullestHeader`), else to the API.
 */
async function hold(page: Page, pathname: string): Promise<{ seen: Promise<void>; release: () => void }> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saw: () => void = () => undefined;
  const seen = new Promise<void>((resolve) => {
    saw = resolve;
  });
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      saw();
      await released;
      await route.fallback();
    },
  );
  return { seen, release };
}

/**
 * Makes every page of `browsing` ask storefront.get (the configuration is never taken from sessionStorage), so that
 * it can be held, and record every layout shift from the first paint on.
 */
async function watchShifts(browsing: Browsing): Promise<void> {
  await browsing.context.addInitScript(() => {
    try {
      sessionStorage.removeItem("vx.storefront.config");
    } catch {
      // No storage: storefront.get is asked anyway.
    }
  });
  await browsing.context.addInitScript(recordLayoutShifts);
}

/**
 * The pages of the layout-shift check: those that show a signed-in customer's account menu and stay where they are
 * (not the airline-card page, whose static header has no menu, nor sign-in and sign-up, which send a customer on to
 * the account page).
 */
const MENU_PAGES = PAGES.filter(
  (target) =>
    target.header !== "static" && !["account/sign-in.html", "account/sign-up.html"].includes(target.file),
);

test.describe("a signed-in customer's page stays still on a phone when the session answers late (OFE-031)", () => {
  test.describe.configure({ mode: "serial" });

  /** One signed-in customer per phone. */
  const customers: Browsing[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(ARRANGE_TIMEOUT_MS);
    for (const phone of SHIFT_PHONES) {
      const browsing = await openBrowsing(browser, phone);
      await signUp(browsing, `ofe031-shift-${phone.viewport.width}`);
      await watchShifts(browsing);
      customers.push(browsing);
    }
  });

  test.afterEach(async () => {
    for (const browsing of customers) {
      await browsing.page.unrouteAll({ behavior: "ignoreErrors" });
      await browsing.guards.finish(browsing.page);
    }
  });

  test.afterAll(async () => {
    for (const browsing of customers.splice(0)) {
      await browsing.context.close();
    }
  });

  for (const target of MENU_PAGES) {
    test(`${target.file} at 360 and 412 px: nothing moves when auth.getSession answers after storefront.get, both held [OFE-031 AC1]`, async () => {
      for (const { page, guards } of customers) {
        const width = page.viewportSize()?.width;
        const config = await hold(page, "/api/v1/storefront");
        const session = await hold(page, "/api/v1/auth/session");
        await page.goto(target.path);
        // The static page painted, storefront.get on its way.
        await config.seen;
        const painted = await takeShifts(page);
        config.release();
        await expect(header(page).name).toHaveAttribute("title", /\S/);
        // The configuration applied (theme, header, footer, test banner), auth.getSession on its way.
        await session.seen;
        const configured = await takeShifts(page);
        const before = await headerGeometry(page);
        session.release();
        await expect(header(page).menu).toBeVisible();
        await expect(target.customer(page)).toBeVisible();
        const signedIn = await takeShifts(page);
        const after = await headerGeometry(page);
        test.info().annotations.push({
          type: "layout shifts",
          description:
            `${target.file} at ${width} px: painted ${scoreOf(painted).toFixed(4)}, configuration ` +
            `${scoreOf(configured).toFixed(4)}, session ${scoreOf(signedIn).toFixed(4)}`,
        });
        // The session's answer moves nothing in the header and does not make it grow (2.5.8's button included).
        expect(
          signedIn.filter((shift) => shift.inHeader),
          `${width} px: shifts in the header`,
        ).toEqual([]);
        expect(after, `${width} px: the header's height and where main starts`).toEqual(before);
        if (target.file === "index.html") {
          // The home page moves by nothing at all, from the first paint to the signed-in menu.
          expect(
            scoreOf([...painted, ...configured, ...signedIn]),
            `${width} px: the home page's shifts`,
          ).toBe(0);
        }
        expect(
          await page.evaluate(reflows, width ?? PHONE.viewport.width),
          `${width} px: no sideways scrolling`,
        ).toBe(true);
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await guards.checkA11y(page);
      }
    });
  }
});

/**
 * The windows of part 6 (OFE-032): a narrow desktop window or a tablet held upright, 900 px high, no touch. The width
 * changes per visit (`page.setViewportSize`).
 */
const WINDOW = Object.freeze({
  viewport: Object.freeze({ width: 1024, height: 900 }),
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
});
/** From md (768 px) to just below lg (1024 px): the compact account menu since OFE-032 (OFE-031: below md only). */
const BELOW_LG_WIDTHS = Object.freeze([768, 800, 850, 900, 1023]);
/** The widths of BELOW_LG_WIDTHS where axe also judges the account menu closed and open. */
const AXE_WIDTHS: readonly number[] = Object.freeze([800, 1023]);
/** From lg: the signed-in links in the navigation's row, as they have always been. */
const FROM_LG_WIDTHS = Object.freeze([1024, 1280]);
/**
 * A first name of 23 characters: with it the signed-in links wrapped the navigation's row when the session answered
 * at 768 px, and up to 850 px with a long OTA name and two currencies, before OFE-032 (storefront-accessibility.md
 * §3.8).
 */
const LONG_FIRST_NAME = "Maximiliana-Alexandrina";
/** The storefronts of part 6: the demo OTA as it is, and with the header at its fullest (`withFullestHeader`). */
const STOREFRONTS = Object.freeze([
  { label: "the demo OTA", fullest: false },
  { label: "a long OTA name and two currencies", fullest: true },
]);

test.describe("a signed-in customer with a long first name, from md to the large breakpoint and beyond (OFE-032)", () => {
  test.describe.configure({ mode: "serial" });

  /** One customer named LONG_FIRST_NAME per storefront of STOREFRONTS, signed in, in a WINDOW. */
  const customers = new Map<boolean, Browsing>();

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(ARRANGE_TIMEOUT_MS);
    for (const { fullest } of STOREFRONTS) {
      const browsing = await openBrowsing(browser, WINDOW);
      if (fullest) {
        await withFullestHeader(browsing.context);
      }
      await signUp(browsing, `ofe032-${fullest ? "fullest" : "demo"}`, LONG_FIRST_NAME);
      await watchShifts(browsing);
      customers.set(fullest, browsing);
    }
  });

  test.afterEach(async () => {
    for (const browsing of customers.values()) {
      await browsing.page.unrouteAll({ behavior: "ignoreErrors" });
      await browsing.guards.finish(browsing.page);
    }
  });

  test.afterAll(async () => {
    for (const browsing of customers.values()) {
      await browsing.context.close();
    }
    customers.clear();
  });

  /** The customer's greeting, wherever it is (the row from lg, the compact menu's panel below it). */
  const greeting = (page: Page) =>
    page.getByRole("banner").getByText(`Hi, ${LONG_FIRST_NAME}`, { exact: true });

  /**
   * Home at `width` as OFE-031's check opens a page: storefront.get held until the static page has painted, then
   * auth.getSession held until the configuration has been applied, then let through; the layout shifts of each phase,
   * and the header's geometry before and after the session answered.
   */
  async function homeWithLateSession(page: Page, width: number) {
    await page.setViewportSize({ width, height: WINDOW.viewport.height });
    const config = await hold(page, "/api/v1/storefront");
    const session = await hold(page, "/api/v1/auth/session");
    await page.goto("/");
    await config.seen;
    const painted = await takeShifts(page);
    config.release();
    await expect(header(page).name).toHaveAttribute("title", /\S/);
    await session.seen;
    const configured = await takeShifts(page);
    const before = await headerGeometry(page);
    session.release();
    await expect(
      page.locator('body > header [data-slot="account-menu"] [data-account-menu-panel]'),
    ).toBeAttached();
    await expect(searchForm(page)).toBeVisible();
    const signedIn = await takeShifts(page);
    const after = await headerGeometry(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    test.info().annotations.push({
      type: "layout shifts",
      description:
        `home at ${width} px: painted ${scoreOf(painted).toFixed(4)}, configuration ` +
        `${scoreOf(configured).toFixed(4)}, session ${scoreOf(signedIn).toFixed(4)}`,
    });
    return { painted, configured, signedIn, before, after };
  }

  for (const storefront of STOREFRONTS) {
    test(`home on ${storefront.label} at 768, 800, 850, 900 and 1023 px: the compact menu, nothing moves when auth.getSession answers late; axe with the menu closed and open at 800 and 1023 px [OFE-032 AC1] [OFE-032 AC3]`, async () => {
      const { page, guards } = customers.get(storefront.fullest) as Browsing;
      const parts = header(page);
      for (const width of BELOW_LG_WIDTHS) {
        const { painted, configured, signedIn, before, after } = await homeWithLateSession(page, width);
        // One "Account" button in the "Sign in" link's place, its panel closed: the long name is not in the row.
        await expect(parts.menu, `${width} px: the compact menu`).toBeVisible();
        await expect(parts.menu).toHaveAttribute("aria-expanded", "false");
        await expect(greeting(page)).toBeHidden();
        await expect(parts.signOut).toBeHidden();
        // The session's answer moves nothing: not in the header, which keeps its height, and not on the page.
        expect(
          signedIn.filter((shift) => shift.inHeader),
          `${width} px: shifts in the header`,
        ).toEqual([]);
        expect(after, `${width} px: the header's and the navigation's height, where main starts`).toEqual(
          before,
        );
        expect(scoreOf(signedIn), `${width} px: the session's shift`).toBe(0);
        expect(scoreOf([...painted, ...configured, ...signedIn]), `${width} px: the home page's shifts`).toBe(
          0,
        );
        expect(await page.evaluate(reflows, width), `${width} px: no sideways scrolling`).toBe(true);
        if (!AXE_WIDTHS.includes(width)) {
          continue;
        }
        await guards.checkA11y(page);
        // Open: the whole greeting, "My account" and "Sign out" in the panel, within the window.
        await parts.menu.click();
        await expect(parts.menu).toHaveAttribute("aria-expanded", "true");
        await expect(greeting(page)).toBeVisible();
        await expect(parts.account).toBeVisible();
        await expect(parts.signOut).toBeVisible();
        expect(
          await page.evaluate(reflows, width),
          `${width} px: no sideways scrolling with the account menu open`,
        ).toBe(true);
        await guards.checkA11y(page);
        await page.keyboard.press("Escape");
        await expect(parts.menu).toHaveAttribute("aria-expanded", "false");
        await expect(parts.menu).toBeFocused();
      }
    });

    test(`home on ${storefront.label} at 1024 and 1280 px: the signed-in links in the navigation's row as before, which does not wrap when the session answers [OFE-032 AC2]`, async () => {
      const { page, guards } = customers.get(storefront.fullest) as Browsing;
      const parts = header(page);
      for (const width of FROM_LG_WIDTHS) {
        const { painted, configured, before, after } = await homeWithLateSession(page, width);
        // No compact menu: its button is there but not shown, and the greeting, "My account" and "Sign out" are in
        // the row.
        const toggle = page.locator("body > header [data-account-menu-toggle]");
        await expect(toggle).toHaveCount(1);
        await expect(toggle, `${width} px: no compact menu`).toBeHidden();
        await expect(greeting(page)).toBeVisible();
        await expect(parts.account).toBeVisible();
        await expect(parts.signOut).toBeVisible();
        const row = await page.evaluate(() => {
          const middle = (element: Element | null) => {
            const rect = element?.getBoundingClientRect();
            return rect === undefined ? -1 : rect.top + rect.height / 2;
          };
          const nav = document.querySelector("body > header nav")?.getBoundingClientRect();
          return {
            nav: nav === undefined ? null : { top: nav.top, bottom: nav.bottom },
            middles: [
              'a[href="/lookup.html"]',
              "[data-customer-name]",
              'a[href="/account/"]',
              '[data-action="sign-out"]',
            ].map((selector) => middle(document.querySelector(`body > header nav ${selector}`))),
          };
        });
        // One row: every link's middle within the navigation, which kept its one line's height.
        expect(row.nav).not.toBeNull();
        for (const middle of row.middles) {
          expect(middle, `${width} px: a link out of the row`).toBeGreaterThan(row.nav?.top ?? 0);
          expect(middle, `${width} px: a link out of the row`).toBeLessThan(row.nav?.bottom ?? 0);
        }
        // The row does not wrap when the session answers: the header and the navigation keep their height and main
        // its start (the wider navigation only moves sideways, as before OFE-032); nothing moved before it either.
        expect(after, `${width} px: the header's and the navigation's height, where main starts`).toEqual(
          before,
        );
        expect(scoreOf([...painted, ...configured]), `${width} px: shifts before the session answered`).toBe(
          0,
        );
        expect(await page.evaluate(reflows, width), `${width} px: no sideways scrolling`).toBe(true);
        await guards.checkA11y(page);
      }
    });
  }
});

test.describe("the account menu by keyboard and by pointer, on a phone (OFE-031)", () => {
  /** A new customer of its own, signed in, on a phone. */
  async function signedInBrowsing(browser: Browser, tag: string): Promise<Browsing> {
    const browsing = await openBrowsing(browser);
    await signUp(browsing, tag);
    return browsing;
  }

  /** Presses Tab until `target` has the focus (at most MAX_FOCUS_STOPS times). */
  async function tabTo(page: Page, target: Locator): Promise<void> {
    for (let presses = 0; presses < MAX_FOCUS_STOPS; presses += 1) {
      await page.keyboard.press("Tab");
      if (await target.evaluate((element) => element === document.activeElement)) {
        return;
      }
    }
    throw new Error("the keyboard never reached the element");
  }

  test("by keyboard: Enter and Space open it, Tab walks its links and leaving closes it, Escape gives the focus back, My account and Sign out work [OFE-031 AC2]", async ({
    browser,
  }) => {
    const browsing = await signedInBrowsing(browser, "ofe031-keyboard");
    const { page, guards } = browsing;
    try {
      await page.goto("/lookup.html");
      const parts = header(page);
      await expect(parts.menu).toBeVisible();
      await tabTo(page, parts.menu);
      await page.keyboard.press("Enter");
      await expect(parts.menu).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Tab");
      await expect(parts.account).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(parts.signOut).toBeFocused();
      // Tab past the last link: the focus leaves the menu, which closes, so it covers nothing.
      await page.keyboard.press("Tab");
      await expect(parts.menu).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("Shift+Tab");
      await expect(parts.menu).toBeFocused();
      // Escape closes it from inside and gives the focus back to the button.
      await page.keyboard.press("Space");
      await expect(parts.menu).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Tab");
      await expect(parts.account).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(parts.menu).toHaveAttribute("aria-expanded", "false");
      await expect(parts.menu).toBeFocused();
      await guards.checkA11y(page);

      // My account.
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/account\/$/);
      await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();

      // Sign out: the home page, with "Sign in" in the button's place.
      await tabTo(page, parts.menu);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(parts.signOut).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/$/);
      await expect(parts.signIn).toBeVisible();
      await expect(parts.menu).toHaveCount(0);
      await guards.checkA11y(page);
    } finally {
      await guards.finish(page);
      await browsing.context.close();
    }
  });

  test("by pointer: a tap opens it, a tap outside closes it, My account and Sign out work [OFE-031 AC2]", async ({
    browser,
  }) => {
    const browsing = await signedInBrowsing(browser, "ofe031-pointer");
    const { page, guards } = browsing;
    try {
      await page.goto("/lookup.html");
      const parts = header(page);
      await parts.menu.click();
      await expect(parts.menu).toHaveAttribute("aria-expanded", "true");
      // A tap on the page outside the menu closes it; the focus, left nowhere, goes back to the button.
      await page.getByRole("heading", { level: 1 }).click();
      await expect(parts.menu).toHaveAttribute("aria-expanded", "false");
      await expect(parts.menu).toBeFocused();

      await parts.menu.click();
      await parts.account.click();
      await expect(page).toHaveURL(/\/account\/$/);
      await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();

      await parts.menu.click();
      await parts.signOut.click();
      await expect(page).toHaveURL(/\/$/);
      await expect(parts.signIn).toBeVisible();
      // The session has ended: a new page shows a visitor's header.
      await page.goto("/lookup.html");
      await expect(parts.signIn).toBeVisible();
      await expect(parts.menu).toHaveCount(0);
      await guards.checkA11y(page);
    } finally {
      await guards.finish(page);
      await browsing.context.close();
    }
  });
});

/** The search form's shape as the page shows it: whether its passenger fieldset, toggle and "Multi-city" are shown. */
interface FormShape {
  readonly panel: boolean;
  readonly toggle: boolean;
  readonly multi: boolean;
}

/**
 * In the browser (self-contained, as Playwright sends its source): the search form's shape in the main content, or
 * `null` without a form.
 */
function formShape(): FormShape | null {
  const form = document.querySelector("main form[data-search-form]");
  if (!form) {
    return null;
  }
  const shown = (selector: string) => {
    const element = form.querySelector(selector);
    return element !== null && getComputedStyle(element).display !== "none";
  };
  return {
    panel: shown("[data-passenger-panel]"),
    toggle: shown("[data-passenger-toggle]"),
    multi: shown("[data-trip-multi]"),
  };
}

const ENHANCED_SHAPE: FormShape = Object.freeze({ panel: false, toggle: true, multi: true });
const PLAIN_SHAPE: FormShape = Object.freeze({ panel: true, toggle: false, multi: false });

test.describe("the search form's plain form when its module never mounts, on a phone (OFE-031)", () => {
  /** Aborts every script of the storefront's build: the page's module never runs, as when it failed to load. */
  const withoutScripts = (page: Page) =>
    page.route(
      (url) => url.pathname.startsWith("/assets/") && url.pathname.endsWith(".js"),
      (route) => route.abort("blockedbyclient"),
    );

  test("home with its script blocked: the enhanced shape at load, the plain form within seconds, and it searches [OFE-031 AC3]", async ({
    page,
    guards,
  }) => {
    await withoutScripts(page);
    // The shape when the page has loaded, and when that was (main.css's timer starts with the first paint).
    await page.addInitScript(() => {
      addEventListener("load", () => {
        const form = document.querySelector("main form[data-search-form]");
        const shown = (selector: string) => {
          const element = form?.querySelector(selector);
          return element !== null && element !== undefined && getComputedStyle(element).display !== "none";
        };
        Object.assign(window, {
          __vxAtLoad: {
            at: performance.now(),
            shape: {
              panel: shown("[data-passenger-panel]"),
              toggle: shown("[data-passenger-toggle]"),
              multi: shown("[data-trip-multi]"),
            },
          },
        });
      });
    });
    await page.goto("/");
    const atLoad = await page.evaluate(
      () => (window as unknown as { __vxAtLoad: { at: number; shape: FormShape } }).__vxAtLoad,
    );
    expect(atLoad.at, "the page loaded before the timer's 5 s").toBeLessThan(5_000);
    expect(atLoad.shape).toEqual(ENHANCED_SHAPE);

    const form = page.getByRole("form", { name: "Search flights" });
    await expect(form.getByRole("group", { name: "Passengers" })).toBeVisible({
      timeout: FALLBACK_BUDGET_MS,
    });
    expect(await page.evaluate(formShape)).toEqual(PLAIN_SHAPE);
    await expect(form.getByRole("radio", { name: "Multi-city" })).toBeHidden();
    expect(
      await page.evaluate(() =>
        document.querySelector("form[data-search-form]")?.hasAttribute("data-enhanced"),
      ),
    ).toBe(false);
    expect(await reflowsOnPhone(page), "no sideways scrolling").toBe(true);
    await guards.checkA11y(page);

    // The plain GET form searches without its module.
    const depart = departureDate(SEARCH_DAYS_AHEAD);
    await form.getByRole("textbox", { name: "From", exact: true }).fill("MAD");
    await form.getByRole("textbox", { name: "To", exact: true }).fill("PAR");
    await form.locator("#search-depart").fill(depart);
    await form.locator("#search-return").fill(departureDate(SEARCH_DAYS_AHEAD + 7));
    await form.getByRole("button", { name: "Search flights" }).click();
    await page.waitForURL(/\/search\.html\?/);
    const sent = new URL(page.url()).searchParams;
    expect(
      Object.fromEntries(["trip", "from", "to", "depart", "adults"].map((name) => [name, sent.get(name)])),
    ).toEqual({
      trip: "return",
      from: "MAD",
      to: "PAR",
      depart,
      adults: "1",
    });
  });

  test("home with its module: the plain form never shows, before or after the timer's 5 s [OFE-031 AC3]", async ({
    page,
    guards,
  }) => {
    // Every frame until 6 s after the start: whether the plain form's fieldset ever showed on the form.
    await page.addInitScript(() => {
      const seen = { plain: false };
      Object.assign(window, { __vxPlainSeen: seen });
      const sample = () => {
        const panel = document.querySelector("main form[data-search-form] [data-passenger-panel]");
        if (panel && getComputedStyle(panel).display !== "none") {
          seen.plain = true;
        }
        if (performance.now() < 6_000) {
          requestAnimationFrame(sample);
        }
      };
      requestAnimationFrame(sample);
    });
    await page.goto("/");
    await expect(page.locator('main form[data-search-form][data-enhanced="true"]')).toBeVisible();
    await page.waitForFunction(() => performance.now() > 6_000, undefined, { timeout: FALLBACK_BUDGET_MS });
    expect(await page.evaluate(formShape)).toEqual(ENHANCED_SHAPE);
    expect(
      await page.evaluate(
        () => (window as unknown as { __vxPlainSeen: { plain: boolean } }).__vxPlainSeen.plain,
      ),
      "the fieldset was shown",
    ).toBe(false);
    await guards.checkA11y(page);
  });

  test("results with its script blocked: the form in the closed panel waits; opened, the plain form within seconds [OFE-031 AC3]", async ({
    page,
    guards,
  }) => {
    await withoutScripts(page);
    await page.goto("/search.html");
    const panel = page.locator("main details[data-search-panel]");
    // Long after the first paint the closed panel's form has kept its enhanced shape (its timer paused)...
    await page.waitForFunction(() => performance.now() > 6_000, undefined, { timeout: FALLBACK_BUDGET_MS });
    await panel.locator("summary").click();
    expect(await page.evaluate(formShape)).toEqual(ENHANCED_SHAPE);
    // ...and its module never enhances it: the plain form within seconds of opening.
    await expect(panel.getByRole("group", { name: "Passengers" })).toBeVisible({
      timeout: FALLBACK_BUDGET_MS,
    });
    expect(await page.evaluate(formShape)).toEqual(PLAIN_SHAPE);
    await guards.checkA11y(page);
  });
});
