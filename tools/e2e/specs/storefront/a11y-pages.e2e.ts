// The storefront's accessibility pass (OFE-024; ota/frontend/README.md §8, ota/docs/storefront-accessibility.md): axe
// with the WCAG 2.2 A and AA rules on every page of the build in every main state, error states included, in the
// `storefront` project: the production build in `vite preview` for the demo OTA, proxied to the OTA API, the OTA
// worker and the Amadeus stub, under the storefront guards (CSP, third-party requests, readable cookies, axe).
//
//   1. the page list equals the build's: a page a later task adds fails this spec until it is covered here;
//   2. every page in the states every page shares (docs/pages.md §2): loading, and `storefront.get` answered with
//      `403 TENANT_SUSPENDED`, `403 HOST_NOT_ALLOWED`, `503`, `429` and `500`;
//   3. every page in its own states (docs/pages.md §3 to §11, docs/pages-account.md §2 to §8), on data made through
//      the OTA API as the browser's SDK makes it (support/ota.ts `StorefrontApi`: searches, checkouts, airline-card
//      payments and bookings of the demo OTA, no Stripe), and by the pages themselves (sign-up, sign-in, lookup).
//
// What the stack cannot answer on demand is answered in the browser (`page.route`), and only that: the shared states
// of `storefront.get`, a supplier timeout, a sold-out pricing, an expired checkout, a stale profile, a locked account,
// too many lookups, a price that changed or expired, a failed card payment, and a published content page; the
// answers are the API's error envelope or the API's own answer with one field changed (`patchJson`), and the pages,
// their scripts and their headers stay the preview's. Stripe.js never comes from the network: the card page's script
// request is aborted, which is that page's "Card payment is unavailable" state (its Payment Element is the nightly
// storefront-stripe journey's, checkout-stripe.e2e.ts, whose guards run axe on it).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page, Route } from "@playwright/test";
import { uniqueTestIp } from "../../support/fixtures";
import { uniqueEmail, waitForLink } from "../../support/mailpit";
import {
  departureDate,
  enableAirlineCard,
  enableSelfServiceCancellation,
  expireSearch,
  searchIdOf,
  StorefrontApi,
  type SeedTraveller,
} from "../../support/ota";
import { newPassword } from "../../support/seed";
import { REPO_ROOT, STOREFRONT_URL } from "../../support/stack";
import { expect, StorefrontGuards, test } from "../../support/storefront-guards";

/** The built storefront the preview serves. */
const DIST = join(REPO_ROOT, "ota", "frontend", "dist");

/** Every page of the build (its file in dist/) and the address that opens it. */
const PAGES: readonly { readonly file: string; readonly path: string }[] = Object.freeze([
  { file: "404.html", path: "/404.html" },
  { file: "account/forgot-password.html", path: "/account/forgot-password.html" },
  { file: "account/index.html", path: "/account/" },
  { file: "account/reset-password.html", path: "/account/reset-password.html" },
  { file: "account/sign-in.html", path: "/account/sign-in.html" },
  { file: "account/sign-up.html", path: "/account/sign-up.html" },
  { file: "account/verify.html", path: "/account/verify.html" },
  { file: "booking.html", path: "/booking.html" },
  { file: "bookings.html", path: "/bookings.html" },
  { file: "checkout.html", path: "/checkout.html" },
  { file: "checkout/complete.html", path: "/checkout/complete.html" },
  // With well-formed ids: without them the airline-card page says "We could not find this payment" before it asks
  // the API anything (docs/pages.md §9).
  {
    file: "checkout/pay-airline.html",
    path: "/checkout/pay-airline.html?id=chk_0000000000000000000000AXE1&payment=pay_0000000000000000000000AXE1",
  },
  { file: "checkout/pay-card.html", path: "/checkout/pay-card.html" },
  { file: "confirmation.html", path: "/confirmation.html" },
  { file: "index.html", path: "/" },
  { file: "lookup.html", path: "/lookup.html" },
  { file: "offer.html", path: "/offer.html" },
  { file: "p.html", path: "/p/about" },
  { file: "price.html", path: "/price.html" },
  { file: "search.html", path: "/search.html" },
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

/** The departures this spec searches, days from today: dates of its own (searches are shared for 30 s, OADR-0002). */
const DAYS = Object.freeze({ shopping: 64, expired: 65, checkout: 66, customer: 67, pending: 68 });

/** The traveller of the spec's bookings: synthetic. */
const TRAVELLER: SeedTraveller = Object.freeze({
  firstName: "Alba",
  lastName: "Axetest",
  dateOfBirth: "1990-05-17",
  gender: "FEMALE",
});

/** How long the arrangements of a `beforeAll` may take: the demo OTA's settings and a few API calls. */
const ARRANGE_TIMEOUT_MS = 30_000;

/** A request id the routed error answers carry, as the API's would (the state shows it for support). */
const ROUTED_REQUEST_ID = "req_e2e_a11y_pass";

/** The API's error envelope (docs/mvp/conventions.md §6), as the routed answers send it. */
function errorBody(
  status: number,
  code: string,
  details?: Record<string, unknown>,
  fieldErrors?: readonly { path: string; code: string; message: string }[],
): string {
  return JSON.stringify({
    error: {
      code,
      message: `Answered by the accessibility pass: ${code}`,
      status,
      requestId: ROUTED_REQUEST_ID,
      ...(details === undefined ? {} : { details }),
      ...(fieldErrors === undefined ? {} : { fieldErrors }),
    },
  });
}

/** Whether `url` is the OTA API path `path` (`/v1/…`) through the preview's `/api` proxy, for `method`. */
const apiCall =
  (method: string, path: RegExp) =>
  (url: URL, request: { method(): string }): boolean =>
    request.method() === method && path.test(url.pathname.replace(/^\/api(?=\/)/, ""));

/** Answers the next calls of `matches` with the API's error envelope. */
async function answerError(
  page: Page,
  matches: (url: URL, request: { method(): string }) => boolean,
  status: number,
  code: string,
  options: {
    retryAfter?: number;
    details?: Record<string, unknown>;
    fieldErrors?: readonly { path: string; code: string; message: string }[];
  } = {},
): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      if (!matches(new URL(route.request().url()), route.request())) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status,
        contentType: "application/json",
        headers: options.retryAfter === undefined ? {} : { "retry-after": String(options.retryAfter) },
        body: errorBody(status, code, options.details, options.fieldErrors),
      });
    },
  );
}

/** Answers the next calls of `matches` with the API's own answer, `patch` applied to its JSON. */
async function patchJson(
  page: Page,
  matches: (url: URL, request: { method(): string }) => boolean,
  patch: (body: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route: Route) => {
      if (!matches(new URL(route.request().url()), route.request())) {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, body: JSON.stringify(patch(body)) });
    },
  );
}

/** The state element a page rendered for `name` (boot's full-page states and the pages' own, `renderState`). */
const stateOf = (page: Page, name: string) => page.locator(`main [data-state="${name}"]`).first();

/** The results page address the search form sends for a one-way trip from Madrid (docs/pages.md §3). */
function searchAddress(to: string, daysAhead: number, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    trip: "oneway",
    from: "MAD",
    to,
    depart: departureDate(daysAhead),
    adults: "1",
    children: "0",
    infants: "0",
    cabin: "ECONOMY",
    ...extra,
  });
  return `/search.html?${query.toString()}`;
}

/** A well-formed id the API has never issued: `<prefix>_` and a ULID of zeros and a random tail. */
function unknownId(prefix: string): string {
  const tail = Array.from(
    { length: 10 },
    () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)],
  );
  return `${prefix}_0000000000000000${tail.join("")}`;
}

/** One browser of the spec: its context, page and guards, with an end-user IP of its own (per-IP limits). */
interface Browsing {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly guards: StorefrontGuards;
  readonly api: StorefrontApi;
}

async function openBrowsing(browser: Browser): Promise<Browsing> {
  const ip = uniqueTestIp();
  const context = await browser.newContext({
    baseURL: STOREFRONT_URL,
    extraHTTPHeaders: { "X-Forwarded-For": ip },
  });
  // Stripe.js never comes from the network in this spec: the card page then shows "Card payment is unavailable".
  await context.route("https://js.stripe.com/**", (route) => route.abort("blockedbyclient"));
  const guards = await StorefrontGuards.install(context);
  const page = await context.newPage();
  return { context, page, guards, api: new StorefrontApi(context, ip) };
}

/** A string field of an API answer (the next step needs it). */
function idOf(answer: unknown, field = "id"): string {
  const value = (answer as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`the answer has no ${field}`);
  }
  return value;
}

/** A checkout of the demo OTA through the OTA API: a search, its first offer priced, checkout.create. */
async function createCheckout(api: StorefrontApi, daysAhead: number): Promise<{ checkoutId: string }> {
  const search = (await api.call(
    "flights.search",
    "POST",
    "/v1/flight-searches",
    {
      mode: "simple",
      originLocationCode: "MAD",
      destinationLocationCode: "PAR",
      departureDate: departureDate(daysAhead),
      adults: 1,
    },
    201,
  )) as { offers?: unknown[] };
  const priced = await api.call(
    "offers.price",
    "POST",
    "/v1/priced-offers",
    { offerIds: [idOf(search.offers?.[0])] },
    201,
  );
  const checkout = await api.call(
    "checkout.create",
    "POST",
    "/v1/checkouts",
    { pricedOfferId: idOf(priced) },
    201,
  );
  return { checkoutId: idOf(checkout) };
}

/** The traveller and the contact of a checkout, through the OTA API (the travellers and contact steps). */
async function completeDetails(
  api: StorefrontApi,
  checkoutId: string,
  email: string,
  contact = true,
): Promise<void> {
  await api.call("checkout.setTravelers", "PUT", `/v1/checkouts/${checkoutId}/travelers`, {
    travelers: [
      {
        travelerId: "1",
        name: { firstName: TRAVELLER.firstName, lastName: TRAVELLER.lastName },
        dateOfBirth: TRAVELLER.dateOfBirth,
        gender: TRAVELLER.gender,
      },
    ],
  });
  if (contact) {
    await api.call("checkout.setContacts", "PUT", `/v1/checkouts/${checkoutId}/contacts`, {
      contacts: [
        {
          purpose: "STANDARD",
          isPrimary: true,
          addresseeName: { firstName: TRAVELLER.firstName, lastName: TRAVELLER.lastName },
          emailAddress: email,
          phones: [{ deviceType: "MOBILE", countryCallingCode: "34", number: "600000000" }],
          language: "en",
        },
      ],
    });
  }
}

/** An airline-card payment of a checkout whose details are complete (terms accepted, as the payment step does). */
async function createAirlinePayment(api: StorefrontApi, checkoutId: string): Promise<string> {
  const payment = await api.call(
    "checkout.createPayment",
    "POST",
    `/v1/checkouts/${checkoutId}/payments`,
    { method: "airline_card", termsAccepted: true },
    201,
  );
  return idOf(payment);
}

/**
 * Lets `form` be sent with its fields as they are: the browser's own checks (`required`, `pattern`) would stop it
 * before the page's script and the API answer, and the error states they lead to are what axe is to judge here (the
 * state an API refusal, or a browser without those checks, shows).
 */
async function withoutBrowserChecks(form: Locator): Promise<void> {
  await form.evaluate((element) => {
    (element as HTMLFormElement).noValidate = true;
  });
}

/**
 * The longest wait of the booking page after a `429` of its fare rules: a `Retry-After` of at most 10 s is waited out
 * before it asks once more (`RULES_RETRY_MAX_SECONDS` of ota/frontend/src/pages/booking.js, FIX-W46-OTA and
 * FIX-W47-OTA); a longer one is not.
 */
const FARE_RULES_RETRY_MAX_MS = 10_000;

/**
 * Opens the "Changes and refunds" disclosure of the price or booking page and waits for what its first opening loads,
 * so that axe judges the loaded disclosure: the airline's rule categories or full rules, its "no detailed rules", or a
 * state (a booking synced less than a minute ago has no rules to show until then: `429` with the seconds left as
 * `Retry-After`, customer-bookings.service.ts; the booking page says "available in about a minute" with Try again at
 * once, or, when the `Retry-After` is 10 s or less, asks once more after it, FIX-W47-OTA). With `skipRetryWait` (the
 * booking page, whose context's clock the caller installed before the page loaded) the page's clock jumps over such a
 * wait instead of the test waiting it out.
 */
async function openFareRules(page: Page, { skipRetryWait = false } = {}): Promise<void> {
  const rules = page.locator("details[data-fare-rules]");
  await rules.locator("summary").first().click();
  await expect(rules).toHaveAttribute("open", "");
  const settled = rules
    .locator(
      "[data-rules-categories] > li, [data-rules-notes], [data-rules-unavailable], [data-rules-state] [data-state]",
    )
    .filter({ visible: true })
    .first();
  if (skipRetryWait) {
    // Each pass moves the page's clock past the longest wait, which fires the retry once the 429 has scheduled it.
    await expect(async () => {
      await page.clock.fastForward(FARE_RULES_RETRY_MAX_MS);
      await expect(settled).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 10_000 });
  } else {
    await expect(settled).toBeVisible();
  }
  await expect(rules.locator("[data-rules-loading]")).toBeHidden();
}

/** Signs a new customer up on the sign-up page of `page` (the demo OTA opens the session at once). */
async function signUpOnPage(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/account/sign-up.html");
  const form = page.getByRole("main").locator("form");
  await form.getByRole("textbox", { name: "First name" }).fill(TRAVELLER.firstName);
  await form.getByRole("textbox", { name: "Last name" }).fill(TRAVELLER.lastName);
  await form.getByRole("textbox", { name: "E-mail address" }).fill(email);
  await form.getByLabel("Password", { exact: true }).fill(password);
  await form.getByRole("checkbox", { name: /^I accept the terms and conditions/ }).check();
  await form.getByRole("button", { name: "Create account" }).click();
}

/** The card form of the airline-card page, filled with a test card (stub test numbers only). */
async function typeCard(page: Page, number: string): Promise<void> {
  const form = page.locator("[data-card-form]");
  await form.getByLabel("Name on the card").fill(`${TRAVELLER.firstName} ${TRAVELLER.lastName}`);
  await form.getByLabel("Card number").fill(number);
  await form.getByLabel("Month (MM)").fill("11");
  await form.getByLabel("Year (YYYY)").fill(String(new Date().getUTCFullYear() + 3));
  await form.getByLabel("Security code").fill("853");
}

test.describe("every page of the build", () => {
  test("the spec covers every page the build has [OFE-024 AC1]", () => {
    const built = readdirSync(DIST, { recursive: true, encoding: "utf8" })
      .map((file) => file.split(/[\\/]/).join("/"))
      .filter((file) => file.endsWith(".html"))
      .sort();
    expect(PAGES.map((page) => page.file).sort()).toEqual(built);
  });
});

test.describe("the states every page shares", () => {
  for (const target of PAGES) {
    test(`${target.file}: loading, suspended, unknown host, unavailable, busy and unexpected [OFE-024 AC1]`, async ({
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
      await guards.checkA11y(page);
      release?.();

      for (const state of SHARED_STATES) {
        answer = state;
        await page.goto(target.path);
        await expect(stateOf(page, state.state)).toBeVisible();
        await guards.checkA11y(page);
      }
    });
  }
});

test.describe("the shopping pages in their states", () => {
  test.describe.configure({ mode: "serial" });

  let browsing: Browsing;
  let offerAddress = "";
  let priceAddress = "";

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

  test("home: the search form, its checks, the location suggestions and the passengers [OFE-024 AC1]", async () => {
    await page().goto("/");
    const form = page().getByRole("form", { name: "Search flights" });
    await expect(form).toBeVisible();
    await browsing.guards.checkA11y(page());

    // Sent empty: the error summary takes the focus.
    await form.getByRole("button", { name: "Search flights" }).click();
    await expect(form.getByRole("heading", { name: /^There (is|are) \d+ problems?$/ })).toBeVisible();
    await browsing.guards.checkA11y(page());

    // The location combobox with its suggestions open.
    await form.getByRole("combobox", { name: "From" }).fill("Madrid");
    await expect(page().getByRole("listbox", { name: "From" }).getByRole("option").first()).toBeVisible();
    await browsing.guards.checkA11y(page());
    // And with none ("No airport or city found").
    await form.getByRole("combobox", { name: "To" }).fill("Qqxqq");
    await expect(
      page().getByRole("main").getByText("No airport or city found", { exact: true }).last(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());
    await page().keyboard.press("Escape");

    // The passenger picker open, and the multi-city legs.
    const passengers = form.getByRole("button", { name: /passenger|traveller|adult/i }).first();
    await passengers.click();
    await expect(passengers).toHaveAttribute("aria-expanded", "true");
    await expect(form.getByRole("group", { name: "Passengers" })).toBeVisible();
    await browsing.guards.checkA11y(page());
    await form.getByRole("radio", { name: "Multi-city" }).check();
    await expect(form.locator("[data-legs-section]")).toBeVisible();
    await expect(form.locator("[data-legs] > li").first()).toBeVisible();
    await browsing.guards.checkA11y(page());
  });

  test("results: searching, the offers, no match, no flights, expired and the airlines not answering [OFE-024 AC1]", async () => {
    // Searching: the search held until axe has looked at the skeleton.
    let release: (() => void) | undefined;
    await page().route(
      (url) => url.pathname === "/api/v1/flight-searches",
      async (route) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.continue();
      },
    );
    await page().goto(searchAddress("PAR", DAYS.shopping));
    await expect.poll(() => release !== undefined).toBe(true);
    await browsing.guards.checkA11y(page());
    release?.();
    await page().unrouteAll({ behavior: "wait" });

    const results = page().getByRole("region", { name: /flights?$/ });
    await expect(results.getByRole("heading", { level: 2, name: "5 flights" })).toBeVisible();
    await page().waitForURL(/[?&]search=srch_/);
    await browsing.guards.checkA11y(page());
    const searchId = searchIdOf(page().url());

    // A filter nothing matches: "No flights match these filters" with "Clear filters".
    await page().goto(`/search.html?search=${searchId}&maxPrice=1`);
    await expect(
      page().getByRole("main").getByText("No flights match these filters", { exact: true }),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    // No offers at all (the stub's ZZZ), with nearby dates.
    await page().goto(searchAddress("ZZZ", DAYS.shopping));
    await expect(page().getByRole("heading", { level: 2, name: "No flights found" })).toBeVisible();
    await browsing.guards.checkA11y(page());

    // An expired search of its own date, opened from a bookmark.
    await page().goto(searchAddress("PAR", DAYS.expired));
    await page().waitForURL(/[?&]search=srch_/);
    const expired = searchIdOf(page().url());
    await expireSearch(expired);
    await page().goto(`/search.html?search=${expired}`);
    await expect(stateOf(page(), "search-expired")).toBeVisible();
    await browsing.guards.checkA11y(page());

    // The airlines not answering (504 SUPPLIER_TIMEOUT of the search).
    await answerError(page(), apiCall("POST", /^\/v1\/flight-searches$/), 504, "SUPPLIER_TIMEOUT", {
      retryAfter: 60,
    });
    await page().goto(searchAddress("PAR", DAYS.shopping, { adults: "2" }));
    await expect(stateOf(page(), "supplier-timeout")).toBeVisible();
    await browsing.guards.checkA11y(page());
  });

  test("offer: the fares, no id, an offer that is gone and a flight sold out at pricing [OFE-024 AC1]", async () => {
    await page().goto(searchAddress("PAR", DAYS.shopping));
    const results = page().getByRole("region", { name: /flights?$/ });
    await results
      .getByRole("link", { name: /^Select this flight for / })
      .first()
      .click();
    await page().waitForURL(/\/offer\.html\?offer=off_/);
    offerAddress = new URL(page().url()).pathname + new URL(page().url()).search;
    await expect(
      page().getByRole("group", { name: "Choose your fare" }).getByRole("radio").first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().goto("/offer.html");
    await expect(page().getByRole("main").getByText("We could not find this flight")).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().goto(`/offer.html?offer=${unknownId("off")}`);
    await expect(stateOf(page(), "offer-expired")).toBeVisible();
    await browsing.guards.checkA11y(page());

    await answerError(page(), apiCall("POST", /^\/v1\/priced-offers$/), 409, "SOLD_OUT");
    await page().goto(offerAddress);
    await page().getByRole("button", { name: "Continue with this fare" }).click();
    await expect(stateOf(page(), "sold-out")).toBeVisible();
    await browsing.guards.checkA11y(page());
  });

  test("price: the price, its fare rules, a changed price, an expired price, no id and a price that is gone [OFE-024 AC1]", async () => {
    await page().goto(offerAddress);
    await page().getByRole("button", { name: "Continue with this fare" }).click();
    await page().waitForURL(/\/price\.html\?priced=prc_/);
    priceAddress = new URL(page().url()).pathname + new URL(page().url()).search;
    const total = page().getByRole("complementary", { name: "Total" });
    await expect(total.getByRole("button", { name: "Continue to checkout" })).toBeEnabled();
    await browsing.guards.checkA11y(page());

    // "Changes and refunds" opened, with what the airline publishes.
    await openFareRules(page());
    await browsing.guards.checkA11y(page());

    const pricedPath = /^\/v1\/priced-offers\/prc_[^/]+$/;
    await patchJson(page(), apiCall("GET", pricedPath), (body) => {
      const totalPrice = (body["price"] as { total: { amount: string; currency: string } }).total;
      return {
        ...body,
        priceChange: {
          changed: true,
          oldPrice: { amount: "1.00", currency: totalPrice.currency },
          newPrice: totalPrice,
          difference: { amount: totalPrice.amount, currency: totalPrice.currency },
          direction: "up",
        },
      };
    });
    await page().goto(priceAddress);
    await expect(page().getByRole("main").getByText("The airline changed the price").first()).toBeVisible();
    await browsing.guards.checkA11y(page());
    await page().unrouteAll({ behavior: "wait" });

    await patchJson(page(), apiCall("GET", pricedPath), (body) => ({
      ...body,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    await page().goto(priceAddress);
    await expect(page().getByRole("main").getByText("Price expired").first()).toBeVisible();
    await browsing.guards.checkA11y(page());
    await page().unrouteAll({ behavior: "wait" });

    await page().goto("/price.html");
    await expect(page().getByRole("main").getByText("We could not find this price")).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().goto(`/price.html?priced=${unknownId("prc")}`);
    await expect(stateOf(page(), "offer-expired")).toBeVisible();
    await browsing.guards.checkA11y(page());
  });
});

test.describe("the checkout and payment pages in their states", () => {
  test.describe.configure({ mode: "serial" });

  const email = uniqueEmail("ofe024-guest");
  let browsing: Browsing;
  let checkoutId = "";
  let paymentId = "";

  test.beforeAll(async ({ browser }) => {
    // The demo OTA's airline card and self-service cancellation, and the wait for storefront.get (support/ota.ts).
    test.setTimeout(ARRANGE_TIMEOUT_MS);
    await enableAirlineCard();
    await enableSelfServiceCancellation();
    browsing = await openBrowsing(browser);
    ({ checkoutId } = await createCheckout(browsing.api, DAYS.checkout));
  });

  test.afterEach(async () => {
    await page().unrouteAll({ behavior: "ignoreErrors" });
    await browsing?.guards.finish(page());
  });

  test.afterAll(async () => {
    await browsing?.context.close();
  });

  const page = () => browsing.page;

  test("checkout: the four steps, the travellers' errors, an expired checkout and no id [OFE-024 AC1]", async () => {
    await page().goto(`/checkout.html?id=${checkoutId}&step=travellers`);
    await expect(page()).toHaveTitle("Travellers – Checkout");
    await browsing.guards.checkA11y(page());

    // The API's field errors and the focused summary: the travellers sent as they are, and answered with
    // `422 TRAVELER_DATA_INVALID` for the first name. The API itself saves a traveller sent without a name and lists
    // the name in `progress.missing` (a form may send a traveller in parts, setCheckoutTravelers), so the refusal of a
    // name it cannot take is routed (ota/docs/storefront-accessibility.md §2, finding 2).
    await answerError(
      page(),
      apiCall("PUT", /^\/v1\/checkouts\/chk_[^/]+\/travelers$/),
      422,
      "TRAVELER_DATA_INVALID",
      {
        fieldErrors: [
          { path: "/travelers/0/name/firstName", code: "required", message: "Enter the first name" },
        ],
      },
    );
    const travellers = page().getByRole("main").locator("form").first();
    await withoutBrowserChecks(travellers);
    await travellers
      .getByRole("button", { name: /^Continue/ })
      .first()
      .click();
    await expect(
      page()
        .getByRole("heading", { name: /^There (is|are) \d+ problems?$/ })
        .first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    await completeDetails(browsing.api, checkoutId, email, false);
    await page().goto(`/checkout.html?id=${checkoutId}&step=contacts`);
    await expect(page()).toHaveTitle("Contact details – Checkout");
    await browsing.guards.checkA11y(page());

    await completeDetails(browsing.api, checkoutId, email);
    await page().goto(`/checkout.html?id=${checkoutId}&step=extras`);
    await expect(page()).toHaveTitle("Extras – Checkout");
    await browsing.guards.checkA11y(page());

    await page().goto(`/checkout.html?id=${checkoutId}&step=payment`);
    await expect(page()).toHaveTitle("Payment – Checkout");
    await expect(page().getByRole("main").getByRole("radio").first()).toBeVisible();
    await browsing.guards.checkA11y(page());

    await answerError(page(), apiCall("GET", /^\/v1\/checkouts\/chk_[^/]+$/), 410, "CHECKOUT_EXPIRED");
    await page().goto(`/checkout.html?id=${checkoutId}&step=payment`);
    await expect(stateOf(page(), "checkout-expired")).toBeVisible();
    await browsing.guards.checkA11y(page());
    await page().unrouteAll({ behavior: "wait" });

    await page().goto("/checkout.html");
    await expect(page().getByRole("main").locator("[data-state]").first()).toBeVisible();
    await browsing.guards.checkA11y(page());
  });

  test("airline card: the form, the review, a typing mistake, a declined card and no id [OFE-024 AC1]", async () => {
    paymentId = await createAirlinePayment(browsing.api, checkoutId);
    await page().goto(`/checkout/pay-airline.html?id=${checkoutId}&payment=${paymentId}`);
    await expect(page().locator("[data-card-form]").getByLabel("Card number")).toBeVisible();
    await browsing.guards.checkA11y(page());

    // The review: six digits typed, the airline's card fee quoted, "Pay €…" (OADR-0017; nothing is paid yet).
    await typeCard(page(), "4111111111111112");
    await expect(page().locator("[data-review-panel]")).toBeVisible();
    await expect(page().locator("[data-pay-button]")).toHaveText(/^Pay /);
    await browsing.guards.checkA11y(page());

    // That number's check digit is wrong: Pay sends nothing, the summary of the problems takes the focus.
    await page().locator("[data-pay-button]").click();
    await expect(page().locator("[data-card-errors]")).toBeVisible();
    await browsing.guards.checkA11y(page());

    // The stub's declined test card: "The airline declined the card", the inputs emptied.
    await typeCard(page(), "4000000000000002");
    await expect(page().locator("[data-pay-button]")).toHaveText(/^Pay /);
    await page().locator("[data-pay-button]").click();
    await expect(page().locator('[data-state="payment-declined"]')).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().goto("/checkout/pay-airline.html");
    await expect(page().locator("main [data-state]").first()).toBeVisible();
    await browsing.guards.checkA11y(page());
  });

  test("card and complete pages: Stripe.js unavailable, a failed payment and no id [OFE-024 AC1]", async () => {
    await page().goto(`/checkout/pay-card.html?id=${checkoutId}&payment=${paymentId}`);
    await expect(page().getByRole("main").getByText("Card payment is unavailable").first()).toBeVisible();
    await browsing.guards.checkA11y(page());

    // The complete page for a card payment that did not go through (the payment read with method and status changed).
    await patchJson(page(), apiCall("GET", /^\/v1\/payments\/pay_[^/]+$/), (body) => ({
      ...body,
      method: "card",
      status: "failed",
    }));
    await page().goto(`/checkout/complete.html?id=${checkoutId}&payment=${paymentId}`);
    await expect(page().getByRole("main").locator("[data-state]").first()).toBeVisible();
    await browsing.guards.checkA11y(page());
    await page().unrouteAll({ behavior: "wait" });

    await page().goto("/checkout/complete.html");
    await expect(page().getByRole("main").getByText("We could not find this payment").first()).toBeVisible();
    await browsing.guards.checkA11y(page());
  });

  test("confirmation: the ticketed booking of a guest, a pending booking, no access and no id [OFE-024 AC1]", async () => {
    // Paid on the airline-card page: the confirmation with the tickets, for a guest.
    await page().goto(`/checkout/pay-airline.html?id=${checkoutId}&payment=${paymentId}`);
    await typeCard(page(), "4111111111111111");
    await expect(page().locator("[data-pay-button]")).toHaveText(/^Pay /);
    await page().locator("[data-pay-button]").click();
    await page().waitForURL(/\/confirmation\.html\?booking=bkg_/);
    await expect(page().getByRole("heading", { level: 2, name: "Booking reference" })).toBeVisible();
    await expect(page().getByRole("heading", { level: 2, name: "Save your reference" })).toBeVisible();
    await browsing.guards.checkA11y(page());
    const confirmation = new URL(page().url());

    // A booking the airline has not confirmed: the stub's server error at Flight Create Orders (504, kept pending).
    const pending = await createCheckout(browsing.api, DAYS.pending);
    await completeDetails(browsing.api, pending.checkoutId, email);
    const pendingPayment = await createAirlinePayment(browsing.api, pending.checkoutId);
    const quoted = (await browsing.api.call(
      "checkout.updatePayment",
      "PATCH",
      `/v1/payments/${pendingPayment}`,
      {
        card: { brand: "VISA", bin: "411111" },
      },
    )) as { amount: { amount: string; currency: string } };
    const lost = (await browsing.api.call(
      "checkout.completeWithAirlineCard",
      "POST",
      `/v1/checkouts/${pending.checkoutId}/airline-card-completion`,
      {
        paymentId: pendingPayment,
        expectedTotal: quoted.amount,
        card: {
          brand: "VISA",
          holderName: `${TRAVELLER.firstName} ${TRAVELLER.lastName}`,
          number: "4111111111111111",
          expiryMonth: 11,
          expiryYear: new Date().getUTCFullYear() + 3,
          securityCode: "853",
        },
      },
      504,
      { "x-stub-scenario": "server-error" },
    )) as { error?: { details?: { bookingId?: string } } };
    const pendingBooking = lost.error?.details?.bookingId ?? "";
    expect(pendingBooking).toMatch(/^bkg_/);
    await page().goto(`/confirmation.html?booking=${pendingBooking}&pending=1`);
    await expect(
      page().getByRole("main").getByText("We are confirming your booking with the airline").first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    // Another browser without the guest's cookie: no access, the lookup offered.
    const stranger = await page().context().browser()?.newContext({ baseURL: STOREFRONT_URL });
    if (stranger === undefined) {
      throw new Error("no browser for the second context");
    }
    try {
      const strangerGuards = await StorefrontGuards.install(stranger);
      const strangerPage = await stranger.newPage();
      await strangerPage.goto(confirmation.pathname + confirmation.search);
      await expect(
        strangerPage
          .getByRole("main")
          .getByRole("link", { name: /find your booking|lookup/i })
          .first(),
      ).toBeVisible();
      await strangerGuards.checkA11y(strangerPage);
      await strangerPage.goto("/confirmation.html?booking=nope");
      await expect(
        strangerPage.getByRole("main").getByText("We could not find this booking").first(),
      ).toBeVisible();
      await strangerGuards.checkA11y(strangerPage);
      await strangerGuards.finish(strangerPage);
    } finally {
      await stranger.close();
    }
  });
});

test.describe("the account and bookings pages in their states", () => {
  test.describe.configure({ mode: "serial" });

  const email = uniqueEmail("ofe024-customer");
  const password = newPassword();
  let browsing: Browsing;
  let bookingId = "";

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(ARRANGE_TIMEOUT_MS);
    await enableAirlineCard();
    await enableSelfServiceCancellation();
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

  test("sign-up: the form, its errors, then a new customer's account page, its dialog and its refusals [OFE-024 AC1]", async () => {
    await page().goto("/account/sign-up.html");
    const form = page().getByRole("main").locator("form");
    await expect(form.getByRole("button", { name: "Create account" })).toBeVisible();
    await browsing.guards.checkA11y(page());

    await withoutBrowserChecks(form);
    await form.getByRole("button", { name: "Create account" }).click();
    await expect(
      page()
        .getByRole("heading", { name: /^There (is|are) \d+ problems?$/ })
        .first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    await signUpOnPage(page(), email, password);
    await page().waitForURL(/\/account\/$/);
    await expect(page().getByRole("heading", { level: 1, name: "My account" })).toBeVisible();
    await browsing.guards.checkA11y(page());

    // The deletion dialog, open.
    await page().getByRole("button", { name: "Delete my account" }).first().click();
    await expect(page().getByRole("dialog")).toBeVisible();
    await browsing.guards.checkA11y(page());
    await page().keyboard.press("Escape");
    await expect(page().getByRole("dialog")).toBeHidden();

    // The password change with a wrong current password (the API's 422).
    const change = page()
      .getByRole("main")
      .locator("form")
      .filter({ has: page().getByRole("button", { name: "Change password" }) });
    await change.getByLabel("Current password").fill(`${password}-wrong`);
    await change.getByLabel("New password", { exact: true }).fill(newPassword());
    await change.getByRole("button", { name: "Change password" }).click();
    await expect(change.getByText("This is not your current password").first()).toBeVisible();
    await browsing.guards.checkA11y(page());

    // A profile saved on a version another tab changed (412).
    await answerError(page(), apiCall("PATCH", /^\/v1\/account$/), 412, "PRECONDITION_FAILED");
    const profile = page().getByRole("main").locator("form").first();
    await profile.getByRole("textbox", { name: "First name" }).fill(`${TRAVELLER.firstName}a`);
    await profile.getByRole("button", { name: /^Save/ }).first().click();
    await expect(
      page().getByRole("main").getByText("Your profile was updated elsewhere").first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());
  });

  test("verify: the confirmed address from the e-mail's link [OFE-024 AC1]", async () => {
    const link = await waitForLink({ to: email, path: "/account/verify.html" });
    await page().goto(`${link.pathname}${link.search}`);
    await expect(page().getByRole("heading", { level: 2, name: `${email} is confirmed` })).toBeVisible();
    await browsing.guards.checkA11y(page());
  });

  test("my bookings and a booking: the tabs, the booking, its dialogs, its rules and an unknown booking [OFE-024 AC1]", async () => {
    await page().goto("/bookings.html");
    await expect(page().getByRole("main").getByText("No upcoming trips", { exact: true })).toBeVisible();
    await browsing.guards.checkA11y(page());

    const { checkoutId } = await createCheckout(browsing.api, DAYS.customer);
    await completeDetails(browsing.api, checkoutId, email);
    const paymentId = await createAirlinePayment(browsing.api, checkoutId);
    await page().goto(`/checkout/pay-airline.html?id=${checkoutId}&payment=${paymentId}`);
    await typeCard(page(), "4111111111111111");
    await expect(page().locator("[data-pay-button]")).toHaveText(/^Pay /);
    await page().locator("[data-pay-button]").click();
    await page().waitForURL(/\/confirmation\.html\?booking=bkg_/);
    bookingId = new URL(page().url()).searchParams.get("booking") ?? "";
    // The customer's confirmation: no "Save your reference".
    await expect(page().getByRole("heading", { level: 2, name: "Booking reference" })).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().goto("/bookings.html");
    await expect(
      page().getByRole("main").getByRole("listitem").filter({ hasText: "Booking reference" }),
    ).toHaveCount(1);
    await browsing.guards.checkA11y(page());
    for (const tab of ["past", "cancelled"]) {
      await page().goto(`/bookings.html?tab=${tab}`);
      await expect(page().getByRole("main").getByText(`No ${tab} trips`, { exact: true })).toBeVisible();
      await browsing.guards.checkA11y(page());
    }

    // The page's clock, so that the fare rules' wait after a 429 can be jumped over (openFareRules); it keeps time.
    await page().clock.install();
    await page().goto(`/booking.html?id=${bookingId}`);
    await expect(page().getByRole("heading", { level: 1, name: /^Booking VX/ })).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().getByRole("button", { name: "Change contact details" }).first().click();
    const contacts = page().getByRole("dialog", { name: "Change contact details" });
    await expect(contacts).toBeVisible();
    await browsing.guards.checkA11y(page());
    await page().keyboard.press("Escape");
    await expect(contacts).toBeHidden();

    await page().getByRole("button", { name: "Cancel booking" }).click();
    const cancel = page().getByRole("dialog", { name: "Cancel your booking" });
    await expect(cancel.getByText(/^If you cancel now, you get back /)).toBeVisible();
    await browsing.guards.checkA11y(page());
    await page().keyboard.press("Escape");
    await expect(cancel).toBeHidden();

    await openFareRules(page(), { skipRetryWait: true });
    await browsing.guards.checkA11y(page());

    await page().goto(`/booking.html?id=${unknownId("bkg")}`);
    await expect(page().getByRole("main").getByText("Booking not found").first()).toBeVisible();
    await browsing.guards.checkA11y(page());
  });
});

test.describe("the visitor's pages in their states", () => {
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

  test("sign-in: the form, wrong credentials and a locked account [OFE-024 AC1]", async () => {
    // My bookings sends a visitor here.
    await page().goto("/bookings.html");
    await page().waitForURL(/\/account\/sign-in\.html\?next=%2Fbookings\.html/);
    const form = page().getByRole("main").locator("form");
    await expect(form.getByRole("button", { name: "Sign in" })).toBeVisible();
    await browsing.guards.checkA11y(page());

    await form.getByRole("textbox", { name: "E-mail address" }).fill(uniqueEmail("ofe024-nobody"));
    await form.getByLabel("Password", { exact: true }).fill(newPassword());
    await form.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page().getByRole("main").getByText("The e-mail address or the password is not right").first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    await answerError(page(), apiCall("POST", /^\/v1\/auth\/sign-in$/), 423, "ACCOUNT_LOCKED", {
      details: { lockedUntil: new Date(Date.now() + 15 * 60_000).toISOString() },
    });
    await form.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page().getByRole("main").getByText("Too many attempts: sign-in is paused for 15 minutes").first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());
  });

  test("sign-up of an address that has an account, and the password reset pages [OFE-024 AC1]", async ({
    browser,
  }) => {
    // The address signs up first in a browser of its own (which then holds that session), then here.
    const taken = uniqueEmail("ofe024-taken");
    const first = await openBrowsing(browser);
    try {
      await signUpOnPage(first.page, taken, newPassword());
      await first.page.waitForURL(/\/account\/$/);
      await first.guards.finish(first.page);
    } finally {
      await first.context.close();
    }
    await signUpOnPage(page(), taken, newPassword());
    await expect(stateOf(page(), "already-registered")).toBeVisible();
    await expect(
      stateOf(page(), "already-registered").getByRole("link", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().goto("/account/forgot-password.html");
    const forgot = page().getByRole("main").locator("form");
    await expect(forgot.getByRole("button", { name: "Send the link" })).toBeVisible();
    await browsing.guards.checkA11y(page());
    await forgot.getByRole("textbox", { name: "E-mail address" }).fill(uniqueEmail("ofe024-reset"));
    await forgot.getByRole("button", { name: "Send the link" }).click();
    await expect(
      page()
        .getByRole("main")
        .getByText(/If an account exists/)
        .first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().goto("/account/reset-password.html");
    await expect(page().getByRole("main").getByText("Request a new link").first()).toBeVisible();
    await browsing.guards.checkA11y(page());

    // The new-password form (a well-formed token is only judged by the API), then the API's refusal of the token.
    await page().goto(`/account/reset-password.html?token=pr_${"x".repeat(43)}`);
    const reset = page().getByRole("main").locator("form").first();
    await expect(reset.getByLabel("New password", { exact: true })).toBeVisible();
    await browsing.guards.checkA11y(page());
    await reset.getByLabel("New password", { exact: true }).fill(newPassword());
    await reset.getByRole("button").first().click();
    await expect(page().getByRole("main").getByText("Request a new link").first()).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().goto("/account/verify.html");
    await expect(page().getByRole("heading", { name: "Get a new link" })).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().goto(`/account/verify.html?token=vt_${"x".repeat(43)}`);
    await expect(page().getByRole("heading", { name: "Get a new link" })).toBeVisible();
    await browsing.guards.checkA11y(page());
  });

  test("lookup: the form, its checks, no booking found and too many attempts [OFE-024 AC1]", async () => {
    await page().goto("/lookup.html");
    const form = page().getByRole("main").locator("form");
    const submit = form.getByRole("button", { name: "Find my booking" });
    await expect(submit).toBeVisible();
    await browsing.guards.checkA11y(page());

    await withoutBrowserChecks(form);
    await submit.click();
    await expect(
      page()
        .getByRole("heading", { name: /^There (is|are) \d+ problems?$/ })
        .first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    await form.getByRole("textbox", { name: /reference/i }).fill("VXZZZZZZ");
    await form.getByRole("textbox", { name: /last name/i }).fill(TRAVELLER.lastName);
    await submit.click();
    await expect(
      page().getByRole("main").getByText("We could not find a booking with these details").first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    await answerError(page(), apiCall("POST", /^\/v1\/bookings\/lookup$/), 429, "RATE_LIMITED", {
      retryAfter: 600,
    });
    await submit.click();
    await expect(submit).toBeDisabled();
    await browsing.guards.checkA11y(page());
  });

  test("a booking without access, content pages and the not-found page [OFE-024 AC1]", async () => {
    await page().goto(`/booking.html?id=${unknownId("bkg")}`);
    await expect(
      page().getByRole("main").getByRole("link", { name: "Find your booking" }).first(),
    ).toBeVisible();
    await browsing.guards.checkA11y(page());

    // A published page of the OTA: storefront.getPage answered with the blocks a page can have.
    await page().route(
      (url) => url.pathname === "/api/v1/storefront/pages/about-us",
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "pg_000000000000000000000000AX",
            slug: "about-us",
            locale: "en",
            kind: "about",
            title: "About us",
            isPublished: true,
            showInFooter: true,
            sortOrder: 1,
            publishedAt: new Date().toISOString(),
            bodyMarkdown: "",
            blocks: [
              { type: "paragraph", content: [{ type: "text", text: "We sell flights." }] },
              { type: "heading", level: 2, content: [{ type: "text", text: "Contact" }] },
              {
                type: "list",
                ordered: false,
                items: [
                  { content: [{ type: "strong", content: [{ type: "text", text: "E-mail" }] }] },
                  {
                    content: [
                      {
                        type: "link",
                        href: "mailto:help@example.com",
                        content: [{ type: "text", text: "help@example.com" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "paragraph",
                content: [{ type: "link", href: "/p/terms", content: [{ type: "text", text: "Terms" }] }],
              },
            ],
          }),
        });
      },
    );
    await page().goto("/p/about-us");
    await expect(page().getByRole("heading", { level: 1, name: "About us" })).toBeVisible();
    await browsing.guards.checkA11y(page());

    await page().goto("/p/no-such-page-ofe024");
    await expect(page().getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    await browsing.guards.checkA11y(page());

    const missing = await page().goto("/no-such-page-ofe024");
    expect(missing?.status()).toBe(404);
    await expect(page().getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    await browsing.guards.checkA11y(page());
  });
});
