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
//      from the skip link to the search button never hidden behind anything (2.4.11).
//
// What the stack cannot answer on demand is answered in the browser (`page.route`), and only that: the shared states
// of `storefront.get` (the API's error envelope) and, for part 3, storefront.get's own answer with the OTA's name and
// currencies changed. The customer signs up through the OTA API (`auth.signUp`, as the browser's SDK calls it). The
// pages, their scripts and their headers stay the preview's. Stripe.js never comes from the network (its request is
// aborted): the card page then shows "Card payment is unavailable".
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

async function openBrowsing(browser: Browser): Promise<Browsing> {
  const ip = uniqueTestIp();
  const context = await browser.newContext({
    ...PHONE,
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

/** The header's parts on a phone: the name, the currency selector and the account menu. */
function header(page: Page) {
  const banner = page.getByRole("banner");
  return {
    name: banner.locator('a[data-field="brandName"]'),
    currency: banner.getByRole("combobox", { name: "Currency" }),
    signIn: banner.getByRole("link", { name: "Sign in", exact: true }),
    signOut: banner.getByRole("button", { name: "Sign out" }),
    greeting: banner.getByText(`Hi, ${CUSTOMER.firstName}`, { exact: true }),
  };
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
    // The customer signs up through the OTA API, as the sign-up page's SDK does; the demo OTA opens the session at
    // once (its e-mail verification is optional), in the context's httpOnly cookies.
    const config = (await customer.api.call("getStorefront", "GET", "/v1/storefront")) as {
      legal?: { termsVersion?: string | null };
    };
    const termsVersion = config.legal?.termsVersion;
    await customer.api.call(
      "signUp",
      "POST",
      "/v1/auth/sign-up",
      {
        email: uniqueEmail("ofe030-phone"),
        password: newPassword(),
        firstName: CUSTOMER.firstName,
        lastName: CUSTOMER.lastName,
        marketingConsent: false,
        ...(typeof termsVersion === "string" && termsVersion !== "" ? { termsVersion } : {}),
      },
      201,
    );
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
    test(`${target.file} at 360 px for a visitor and for a customer [OFE-030 AC2]`, async () => {
      for (const [browsing, signedIn] of [
        [visitor, false],
        [customer, true],
      ] as const) {
        const { page, guards } = browsing;
        await page.goto(target.path);
        const parts = header(page);
        // The whole name in the link's text, on one line.
        await expect(parts.name).toHaveText(LONG_NAME);
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
          await expect(signedIn ? parts.signOut : parts.signIn).toBeVisible();
          if (signedIn) {
            await expect(parts.greeting).toBeVisible();
          }
        }
        await expect((signedIn ? target.customer : target.visitor)(page)).toBeVisible();
        expect(await reflowsOnPhone(page), "no sideways scrolling").toBe(true);
        await guards.checkA11y(page);
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
