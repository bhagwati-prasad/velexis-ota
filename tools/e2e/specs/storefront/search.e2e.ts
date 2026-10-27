// The M2 search journey of the hosted storefront (OFE-008; ota/frontend/README.md §13 journey 1, docs/pages.md §3 to
// §6, OF-02 AC1): the production build in `vite preview` for the demo OTA, proxied to the OTA API and the Amadeus stub,
// under the storefront guards (support/storefront-guards.ts) in every test. The stub answers every search with the
// five offers of its fixture (Madrid to Paris; destination `ZZZ`: none) and every upsell with the fare families
// BASIC, CLASSIC and FLEXIBLE (tools/amadeus-stub/README.md). The second part proves the guards themselves: a page
// that breaks a rule on purpose, served with the production headers, fails its test (OFE-008 AC2).
import type { Page, Response } from "@playwright/test";
import { customerScopeLeaks, expireSearch, searchIdOf, withSuspendedTenant } from "../../support/ota";
import { SUSPENDED_STOREFRONT_URL } from "../../support/stack";
import { expect, test, type StorefrontGuards } from "../../support/storefront-guards";

/** The departure of the storefront journeys: 40 days from today (tools/e2e/README.md, "Storefront journeys"). */
const DAYS_AHEAD = 40;
/**
 * The departure of the search that `expireSearch` expires: a date no other journey searches. The API's single flight
 * answers an identical search (same criteria, channel and customer) within 30 s with the same search (OADR-0002 point
 * 2), so expiring a search of the shared date could expire the search of a journey running next to this one.
 */
const EXPIRED_SEARCH_DAYS_AHEAD = 61;

/** A departure `daysAhead` days from today: always in the future, and never a fixed calendar date. */
function departureDate(daysAhead = DAYS_AHEAD): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

/** The results page address the search form sends for a one-way trip (docs/pages.md §3). */
function searchAddress(from: string, to: string, daysAhead = DAYS_AHEAD): string {
  const query = new URLSearchParams({
    trip: "oneway",
    from,
    to,
    depart: departureDate(daysAhead),
    adults: "1",
    children: "0",
    infants: "0",
    cabin: "ECONOMY",
  });
  return `/search.html?${query.toString()}`;
}

/** The amount of a price label such as "€98.47" (the demo OTA sells in EUR), as a number for ordering only. */
function amountOf(label: string): number {
  const match = /€([\d,]+\.\d{2})/.exec(label);
  if (match?.[1] === undefined) {
    throw new Error(`no euro amount in "${label}"`);
  }
  return Number(match[1].replace(/,/g, ""));
}

/** Types `typed` into the location combobox `name` and picks its first suggestion of `code` ("MAD Madrid …"). */
async function chooseLocation(page: Page, name: string, typed: string, code: string): Promise<void> {
  const field = page.getByRole("combobox", { name });
  await field.fill(typed);
  await page
    .getByRole("listbox", { name })
    .getByRole("option", { name: new RegExp(`^${code} `) })
    .first()
    .click();
  await expect(field).toHaveValue(new RegExp(`\\(${code}\\)$`));
}

/** A JSON answer of a shopping operation; `readable` is false when its body could not be read as JSON. */
interface ShoppingAnswer {
  readonly path: string;
  readonly readable: boolean;
  readonly body: unknown;
}

/** Keeps the JSON answers of the shopping operations the page receives (searches, offers, priced offers). */
function recordShoppingAnswers(page: Page): Promise<ShoppingAnswer>[] {
  const answers: Promise<ShoppingAnswer>[] = [];
  page.on("response", (response: Response) => {
    const { pathname } = new URL(response.url());
    if (/^\/api\/v1\/(flight-searches|flight-offers|priced-offers)(\/|$)/.test(pathname)) {
      answers.push(
        response.json().then(
          (body: unknown) => ({ path: pathname, readable: true, body }),
          () => ({ path: pathname, readable: false, body: undefined }),
        ),
      );
    }
  });
  return answers;
}

test.describe("the M2 search journey", () => {
  test("searches, filters and sorts the results, opens an offer, chooses a branded fare and prices it [OFE-008 AC1] [OF-02 AC1]", async ({
    page,
    guards,
  }) => {
    const answers = recordShoppingAnswers(page);

    // Home: the search form, a one-way trip from Madrid to Paris.
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Search flights" })).toBeVisible();
    await expect(page.getByRole("note")).toContainText("Test mode");
    await guards.checkA11y(page);
    const form = page.getByRole("form", { name: "Search flights" });
    await form.getByRole("radio", { name: "One way" }).check();
    await chooseLocation(page, "From", "Madrid", "MAD");
    await chooseLocation(page, "To", "Paris", "PAR");
    await form.getByRole("textbox", { name: "Departure" }).fill(departureDate());
    await form.getByRole("button", { name: "Search flights" }).click();

    // Results: the search runs once and its id goes into the address.
    await page.waitForURL(/\/search\.html\?.*search=srch_/);
    const results = page.getByRole("region", { name: /flights?$/ });
    await expect(results.getByRole("heading", { level: 2, name: "5 flights" })).toBeVisible();
    await guards.checkA11y(page);

    // Filter: direct flights only.
    await page
      .getByRole("form", { name: "Filters" })
      .getByRole("checkbox", { name: /^Direct/ })
      .check();
    await expect(results.getByRole("heading", { level: 2, name: "4 flights" })).toBeVisible();
    await expect(page).toHaveURL(/[?&]stops=0(&|$)/);
    const cards = results.getByRole("article");
    await expect(cards).toHaveCount(4);
    for (const card of await cards.all()) {
      await expect(card).toContainText("Direct");
    }

    // Sort: cheapest first, the API's order.
    await results.getByRole("combobox", { name: "Sort by" }).selectOption({ label: "Cheapest first" });
    await expect(page).toHaveURL(/[?&]sort=price(&|$)/);
    await expect(cards).toHaveCount(4);
    const select = cards.getByRole("link", { name: /^Select this flight for / });
    await expect(select).toHaveCount(4);
    const labels = await select.evaluateAll((links) =>
      links.map((link) => link.getAttribute("aria-label") ?? ""),
    );
    const amounts = labels.map(amountOf);
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    await guards.checkA11y(page);

    // Offer: the cheapest direct flight, with its fare families.
    await select.first().click();
    await page.waitForURL(/\/offer\.html\?offer=off_/);
    const fares = page.getByRole("group", { name: "Choose your fare" });
    await expect(fares.getByRole("radio", { name: /^FLEXIBLE / })).toBeVisible();
    await expect(fares.getByRole("radio", { name: /^CLASSIC / })).toBeVisible();
    await guards.checkA11y(page);

    // Branded fare: FLEXIBLE, then price it.
    const flexible = fares.getByRole("radio", { name: /^FLEXIBLE / });
    // `- radio "FLEXIBLE €189.47 in total €91.00 more than your fare"`: the family's total comes first.
    const flexibleLabel = await flexible.ariaSnapshot();
    await flexible.check();
    await expect(page.getByText(/^Selected fare: FLEXIBLE, /)).toBeVisible();
    await page.getByRole("button", { name: "Continue with this fare" }).click();

    // Price: the confirmed price of the chosen fare, held for a while.
    await page.waitForURL(/\/price\.html\?priced=prc_/);
    await expect(page.getByRole("heading", { level: 1, name: "Your price" })).toBeVisible();
    await expect(page.getByText("Fare: FLEXIBLE")).toBeVisible();
    const total = page.getByRole("complementary", { name: "Total" });
    await expect(total.getByRole("timer")).toHaveText(/^Price held for \d+:\d{2}$/);
    await expect(total.getByRole("button", { name: "Continue to checkout" })).toBeEnabled();
    const details = page.getByRole("region", { name: "Price details" });
    const breakdownTotal = details.getByRole("definition").last();
    await expect(breakdownTotal).toHaveText(/^€[\d,]+\.\d{2}$/);
    // The total box repeats the API's total, which is the price the fare family was offered at.
    await expect(total.getByText((await breakdownTotal.textContent()) ?? "", { exact: true })).toBeVisible();
    expect(amountOf((await breakdownTotal.textContent()) ?? "")).toBe(amountOf(flexibleLabel));
    await guards.checkA11y(page);

    // OF-02 AC1: the storefront received selling prices only: no net amount, markup, margin, diagnostics, supplier
    // detail or verbatim Amadeus dictionary, and every embedded Amadeus offer rewritten to the selling total (the OTA
    // backend's own walk, OBE-026). The search, the offer and the priced offer must be among the answers read, so the
    // check never passes on bodies it could not see.
    const bodies = (await Promise.all(answers)).filter((answer) => answer.readable);
    expect(bodies.map((answer) => answer.path)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/api\/v1\/flight-searches$/),
        expect.stringMatching(/^\/api\/v1\/flight-offers\/off_/),
        expect.stringMatching(/^\/api\/v1\/priced-offers\/prc_/),
      ]),
    );
    expect(
      bodies.flatMap((answer) =>
        customerScopeLeaks(answer.body).map((leak) => `${answer.path}${leak.pointer} (${leak.reason})`),
      ),
    ).toEqual([]);
    // The walk compared an embedded Amadeus offer: the opened offer (full view) carries one, at its selling total.
    const offer = bodies.find((answer) => /^\/api\/v1\/flight-offers\/off_[^/]+$/.test(answer.path))?.body as
      | { price?: { total?: { amount?: unknown } }; amadeus?: { price?: { grandTotal?: unknown } } }
      | undefined;
    expect(offer?.price?.total?.amount).toEqual(expect.stringMatching(/^\d+\.\d{2}$/));
    expect(offer?.amadeus?.price?.grandTotal).toBe(offer?.price?.total?.amount);
  });

  test("destination ZZZ shows No flights found [OFE-008 AC1]", async ({ page, guards }) => {
    await page.goto(searchAddress("MAD", "ZZZ"));
    await page.waitForURL(/[?&]search=srch_/);
    await expect(page.getByRole("heading", { level: 2, name: "No flights found" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^One day later: / })).toBeVisible();
    await guards.checkA11y(page);
  });

  test("an expired search shows Prices have expired [OFE-008 AC1]", async ({ page, guards }) => {
    await page.goto(searchAddress("MAD", "PAR", EXPIRED_SEARCH_DAYS_AHEAD));
    await page.waitForURL(/[?&]search=srch_/);
    await expect(page.getByRole("heading", { level: 2, name: "5 flights" })).toBeVisible();
    const searchId = searchIdOf(page.url());
    await expireSearch(searchId);

    // Opened again from a bookmark: the search is there, but its prices have expired.
    await page.goto(`/search.html?search=${searchId}`);
    const main = page.getByRole("main");
    await expect(main.getByText("Prices have expired", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Prices have expired");
    // Refresh would run the same search again. Not clicked here: within 30 s of the first search the API's single
    // flight answers an identical search with that same search, which no real time to live lets expire that soon.
    await expect(main.getByRole("button", { name: "Refresh results" })).toBeVisible();
    await guards.checkA11y(page);
  });

  test("a suspended OTA shows temporarily unavailable [OFE-008 AC1]", async ({ page, guards }) => {
    await withSuspendedTenant(async () => {
      await page.goto(`${SUSPENDED_STOREFRONT_URL}/`);
      await expect(
        page.getByRole("heading", { level: 1, name: "This travel site is temporarily unavailable" }),
      ).toBeVisible();
      // The page is final: no Retry, no search form, and not for search engines.
      await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
      await expect(page.getByRole("form", { name: "Search flights" })).toHaveCount(0);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      await guards.checkA11y(page);
    });
  });
});

/** Serves `path` of the storefront as the preview answers it, with `extra` added at the end of its `<head>`. */
async function serveWithExtraHead(page: Page, path: string, extra: string): Promise<void> {
  await page.route(`**${path}`, async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    expect(html).toContain("</head>");
    // The preview's own headers, the production CSP among them.
    expect(response.headers()["content-security-policy"]).toContain("script-src 'self'");
    await route.fulfill({ response, body: html.replace("</head>", `${extra}</head>`) });
  });
}

/** Waits until the guards have recorded a problem of `kind`. */
async function problemsOf(guards: StorefrontGuards, kind: string): Promise<unknown[]> {
  await expect
    .poll(() => guards.problems.filter((problem) => problem.kind === kind).length)
    .toBeGreaterThan(0);
  return guards.problems.filter((problem) => problem.kind === kind);
}

test.describe("the storefront guards", () => {
  test("an inline script in a page is a CSP violation that fails the test [OFE-008 AC2]", async ({
    page,
    guards,
  }) => {
    await serveWithExtraHead(
      page,
      "/index.html",
      '<script>document.documentElement.dataset.e2e = "inline";</script>',
    );
    await page.goto("/index.html");
    await expect(page.getByRole("heading", { level: 1, name: "Search flights" })).toBeVisible();
    // The browser refused it: the production CSP has no 'unsafe-inline'.
    await expect(page.locator("html")).not.toHaveAttribute("data-e2e", "inline");
    expect(await problemsOf(guards, "csp")).toEqual([
      expect.objectContaining({
        kind: "csp",
        directive: "script-src-elem",
        blocked: "inline",
        document: expect.stringMatching(/\/index\.html$/),
      }),
    ]);
    expect(() => guards.verify()).toThrow(/securitypolicyviolation: script-src-elem refused inline/);
    guards.forget();
  });

  test("the inline script fails the test through the guards alone [OFE-008 AC2]", async ({ page }) => {
    // Expected to fail: the test asserts nothing, and the guards' check at its end must fail it. Should the guards
    // ever stop failing it, Playwright reports this test as an unexpected pass, and the run fails.
    test.fail();
    await serveWithExtraHead(page, "/index.html", "<script>window.e2eInline = true;</script>");
    await page.goto("/index.html");
    await expect(page.getByRole("heading", { level: 1, name: "Search flights" })).toBeVisible();
  });

  test("a third-party script is refused off the card page and allowed on it [OFE-008 AC2]", async ({
    page,
    guards,
  }) => {
    // Stripe.js never comes from the network in a test: the route answers an empty script.
    await page.route("https://js.stripe.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
    );
    // Allowed by the CSP on every page, by the guard on the card payment page only.
    await serveWithExtraHead(page, "/index.html", '<script src="https://js.stripe.com/v3/"></script>');
    await page.goto("/index.html");
    expect(await problemsOf(guards, "third-party")).toEqual([
      {
        kind: "third-party",
        url: "https://js.stripe.com/v3/",
        page: expect.stringMatching(/\/index\.html$/),
      },
    ]);
    expect(() => guards.verify()).toThrow(/request to a third-party host: https:\/\/js\.stripe\.com\/v3\//);
    guards.forget();

    const stripeOnCardPage = page.waitForRequest("https://js.stripe.com/v3/");
    await page.goto("/checkout/pay-card.html");
    await stripeOnCardPage;
    expect(guards.problems).toEqual([]);
  });

  test("a cookie that JavaScript can read, other than the CSRF token, fails the test [OFE-008 AC2]", async ({
    page,
    guards,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Search flights" })).toBeVisible();
    await page.evaluate(() => {
      document.cookie = "e2e_tracker=1; path=/";
    });
    await page.reload();
    expect(await problemsOf(guards, "cookie")).toEqual([
      expect.objectContaining({ kind: "cookie", names: ["e2e_tracker"] }),
    ]);
    expect(() => guards.verify()).toThrow(
      /cookie readable by JavaScript other than __Host-vx_csrf: e2e_tracker/,
    );
    guards.forget();
    await page.context().clearCookies({ name: "e2e_tracker" });
    await guards.checkContextCookies();
    expect(guards.problems).toEqual([]);
  });

  test("a serious accessibility violation fails the axe guard [OFE-008 AC2]", async ({ page, guards }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Search flights" })).toBeVisible();
    await page.evaluate(() => {
      const image = document.createElement("img");
      image.src = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
      image.id = "e2e-image-without-alt";
      document.querySelector("main")?.append(image);
    });
    await expect(guards.checkA11y(page)).rejects.toThrow(/critical: image-alt/);
    await page.evaluate(() => document.getElementById("e2e-image-without-alt")?.remove());
    await guards.checkA11y(page);
  });
});
