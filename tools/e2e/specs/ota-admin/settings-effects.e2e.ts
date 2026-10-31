// The OTA admin's settings and what they change on the storefront (OAD-017; ota/admin/README.md §12, routes.md §9,
// scope OF-10): an OTA that its owner created through the portal API (`createTenant`) and the OTA worker set up, so the
// journey needs `E2E_WITH_OTA=1` (the e2e workflow sets it).
//
//   the owner opens the console from the portal → the default markup rule at 10 % → the next storefront search shows
//   every flight 10 % dearer → a booking service fee of €7.50 → the next priced offer carries it in its breakdown and
//   total → the primary colour changed → the storefront shows it once its own 5-minute copy is gone → a new published
//   page listed in the footer → the storefront shows it at /p/<slug> and lists it → an e-mail template that does not
//   compile is refused, line by line, and nothing is saved
//
// The storefront in the browser. The journey's OTA is its own (`newOwnerWithActiveOta`: a new owner, an office of the
// test pool): the demo OTA is shared by every storefront journey and must not change. No preview serves the journey
// OTA's host, so the storefront's own context sends the `/api/*` requests of the preview's pages (the one build every
// OTA's storefront serves) to the OTA API as that OTA's storefront edge (`serveStorefrontOf` of support/ota.ts), as
// Caddy does in front of the OTA's host; the storefront guards of OFE-008 watch that context (CSP, first-party requests,
// cookies, axe) and are checked after every step. The owner's console is a context of its own.
//
// The 5-minute caches (OADR-0012 point 7, OF-10 AC2). Two copies stand between a settings change and the storefront:
// the OTA API's Redis entries of the test environment (`t:<tenantId>:test:sf:<locale>` and `…:pages:<locale>`), which
// the console's change deletes after its commit, and the storefront tab's own `sessionStorage` copies of storefront.get
// and of the footer's page list (`STOREFRONT_SESSION_COPIES`). The journey never touches Redis: the API's own deletion
// is what it proves (the colour step reads the storefront from the API just before the change, so the API's entries
// hold the old settings then). A tab that read the storefront before the change keeps showing its copy (within its 5
// minutes, as the storefront documents), so the journey forgets that tab's copies the storefront's own way, by their
// keys (`forgetStorefrontCopies`, what `clearCachedConfig` does), and the next page reads the API again.
//
// Prices. The Amadeus stub answers every search with the five offers of its fixture, whatever the date, in EUR, the
// OTA's currency. A new OTA's only markup rule is the default one at 0 %, so the first search shows the net prices; at
// 10 % each selling price is its net price plus 10 % of it rounded half-up to the cent (OADR-0005 point 4). The API
// answers an identical search within 30 s with the search already made (OADR-0002 point 2), so every search of the
// journey asks for a departure date of its own.
//
// Every page the journey visits passes axe once its title is in place (the console's pages, the portal's page of the
// OTA, the storefront's pages), and on every page of the OTA admin JavaScript reads no cookie.
//
// The steps are tests in order (`mode: "serial"`) on the owner's console context and the storefront's context, both
// made in `beforeAll`.
import { randomBytes } from "node:crypto";
import { type BrowserContext, type Locator, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y";
import { addSessionCookies, expect, newAccountContext, test, uniqueTestIp } from "../../support/fixtures";
import {
  departureDate,
  forgetStorefrontCopies,
  newOwnerWithActiveOta,
  openConsoleFromPortal,
  scriptReadableCookieNames,
  serveStorefrontOf,
  withTenantTx,
  type OwnedOta,
} from "../../support/ota";
import { stack } from "../../support/seed";
import { OTA_ADMIN_URL, STOREFRONT_URL } from "../../support/stack";
import { StorefrontGuards } from "../../support/storefront-guards";

test.describe.configure({ mode: "serial" });

/** The departures of the journey's searches, days from today: one each, never shared within the API's 30 s. */
const BEFORE_MARKUP_DAYS = 44;
const AFTER_MARKUP_DAYS = 45;
const FEE_DAYS = 46;

/** The default rule's new percentage, and the booking service fee the journey adds (EUR, the OTA's currency). */
const MARKUP_PERCENT = 10;
const FEE_CENTS = 750;
const FEE_LABEL = "Service fee";

/** The new primary colour: a dark rust that passes every contrast rule of the storefront (lib/theme.js). */
const NEW_PRIMARY = "#7c2d12";
const NEW_PRIMARY_RGB = "rgb(124, 45, 18)";

/** The journey's content page: a slug and a title no other run uses. */
const RUN = randomBytes(4).toString("hex");
const PAGE_SLUG = `about-us-${RUN}`;
const PAGE_TITLE = `About us ${RUN}`;
const PAGE_BODY = ["## Who we are", "", "A **small team** that books flights for travellers."].join("\n");

/** The template the journey breaks: its HTML body with a mustache that is never closed, on line 2. */
const TEMPLATE_KEY = "booking.confirmed";
const BROKEN_HTML = ["<p>Your booking is confirmed.</p>", "<p>Reference {{booking.reference</p>"].join("\n");

/** The OTA admin's title of a page (`%s · Velexis OTA admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis OTA admin`;

let owned: OwnedOta;
let admin: BrowserContext;
let consolePage: Page;
let storefront: BrowserContext;
let shop: Page;
let guards: StorefrontGuards;
/** The net prices of the five offers in cents, cheapest first: the first search's, under the default rule at 0 %. */
let netCents: number[] = [];

/** Waits until `target` shows the OTA admin's page `title`, then runs axe and checks that no cookie is readable. */
async function expectAdminPage(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(adminTitle(title));
  await expectNoSeriousA11yViolations(target);
  expect(await scriptReadableCookieNames(target)).toEqual([]);
}

/** The cents of a euro amount in a label such as "Select this flight for €98.47 …" (never through a float). */
function centsOf(label: string): number {
  const match = /€([\d,]+)\.(\d{2})/.exec(label);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`no euro amount in "${label}"`);
  }
  return Number(match[1].replace(/,/g, "")) * 100 + Number(match[2]);
}

/** `cents` as the storefront writes a euro amount: `€1,234.56`. */
function euros(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString("en-GB");
  return `€${whole}.${String(cents % 100).padStart(2, "0")}`;
}

/** A selling price under a percentage markup: the net plus `percent` % of it, rounded half-up to the cent. */
function withMarkup(cents: number, percent: number): number {
  return cents + Math.floor((cents * percent + 50) / 100);
}

/** The results page address of a one-way search from Madrid to Paris (docs/pages.md §3). */
function searchAddress(daysAhead: number): string {
  const query = new URLSearchParams({
    trip: "oneway",
    from: "MAD",
    to: "PAR",
    depart: departureDate(daysAhead),
    adults: "1",
    children: "0",
    infants: "0",
    cabin: "ECONOMY",
  });
  return `/search.html?${query.toString()}`;
}

/** The "Select this flight for …" links of the results (one per offer). */
const selectLinks = (page: Page): Locator => page.getByRole("link", { name: /^Select this flight for / });

/** Searches on the storefront and answers each offer's selling price in cents, cheapest first. */
async function searchPrices(daysAhead: number): Promise<number[]> {
  await shop.goto(searchAddress(daysAhead));
  await shop.waitForURL(/[?&]search=srch_/);
  const results = shop.getByRole("region", { name: /flights?$/ });
  await expect(results.getByRole("heading", { level: 2, name: "5 flights" })).toBeVisible();
  await expect(selectLinks(shop)).toHaveCount(5);
  await guards.checkA11y(shop);
  const labels = await selectLinks(shop).evaluateAll((links) =>
    links.map((link) => link.getAttribute("aria-label") ?? ""),
  );
  return labels.map(centsOf).sort((a, b) => a - b);
}

/** The value of the storefront's primary colour property on `<html>` (lib/theme.js `--vx-primary`). */
async function primaryProperty(page: Page): Promise<string> {
  return await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--vx-primary").trim().toLowerCase(),
  );
}

/** Opens the storefront's home page and waits for its search form. */
async function openHome(): Promise<Locator> {
  await shop.goto("/");
  const form = shop.getByRole("form", { name: "Search flights" });
  await expect(form.getByRole("button", { name: "Search flights" })).toBeVisible();
  await expect(shop.getByRole("note")).toContainText("Test mode");
  return form;
}

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "settings-effects.e2e.ts needs the OTA backend, the OTA admin and the storefront previews: run it with " +
        "E2E_WITH_OTA=1 (the Amadeus stub, the OTA worker, API and admin)",
    );
  }
  // Budget: a sign-up with its verification e-mail (up to 15 s) and the OTA's set-up on the OTA worker (about 2 s
  // locally; PF-11 allows a minute).
  test.setTimeout(120_000);
  owned = await newOwnerWithActiveOta("Sigrid Settings", "sfx");

  admin = await newAccountContext(browser, owned.owner.account, OTA_ADMIN_URL);
  await addSessionCookies(admin, "portal", owned.session);
  consolePage = await admin.newPage();

  // A traveller's browser on the OTA's storefront: an end-user IP of its own, the guards before its first page.
  storefront = await browser.newContext({
    baseURL: STOREFRONT_URL,
    extraHTTPHeaders: { "X-Forwarded-For": uniqueTestIp() },
  });
  guards = await StorefrontGuards.install(storefront);
  await serveStorefrontOf(storefront, owned.storefrontHost);
  shop = await storefront.newPage();
});

test.afterEach(async () => {
  // The storefront guards of every step: CSP, first-party requests, readable cookies, axe on the page it ended on.
  await guards.finish(shop);
});

test.afterAll(async () => {
  await admin?.close();
  await storefront?.close();
});

test("the default markup rule at 10 % reaches the next storefront search [OAD-017 AC1] [OF-10 AC1]", async () => {
  // The storefront first: the five offers at their net prices (the default rule adds 0 %).
  netCents = await searchPrices(BEFORE_MARKUP_DAYS);
  expect(netCents).toHaveLength(5);

  await openConsoleFromPortal(consolePage, owned.ota.id);
  await expectAdminPage(consolePage, "Bookings");

  await consolePage.goto("/settings/markups");
  await expectAdminPage(consolePage, "Markup rules");
  await consolePage.getByRole("main").getByRole("link", { name: "Default", exact: true }).click();
  await expect(consolePage.getByRole("heading", { level: 1 })).toContainText("Default");
  await expectAdminPage(consolePage, "Markup rule");

  const form = consolePage.getByRole("form", { name: "Save changes: Default" });
  await expect(form.getByRole("radio", { name: "Percentage of the net price", exact: true })).toBeChecked();
  await form.getByRole("textbox", { name: "Percentage", exact: true }).fill(String(MARKUP_PERCENT));
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form.getByRole("status")).toContainText(
    "Saved. The change applies to the next search; offers already shown keep their prices.",
  );
  await expectAdminPage(consolePage, "Markup rule");

  // The next search: every offer 10 % dearer, rounded half-up to the cent, nothing else.
  const sellingCents = await searchPrices(AFTER_MARKUP_DAYS);
  expect(sellingCents).toEqual(netCents.map((cents) => withMarkup(cents, MARKUP_PERCENT)));
  expect(sellingCents).not.toEqual(netCents);

  // The change as the API audited it: the owner's update of the default rule.
  const actions = await withTenantTx(owned.schema, async (trx) =>
    trx
      .selectFrom("staff_actions")
      .select(["outcome", "staff_role"])
      .where("action", "=", "settings.markupRules.update")
      .execute(),
  );
  expect(actions).toEqual([{ outcome: "succeeded", staff_role: "owner" }]);
});

test("a booking service fee reaches the next priced offer [OAD-017 AC1] [OF-10 AC1]", async () => {
  await consolePage.goto("/settings/fees");
  await expectAdminPage(consolePage, "Fee rules");
  await consolePage.getByRole("main").getByRole("link", { name: "New fee rule" }).click();
  await expectAdminPage(consolePage, "New fee rule");

  const form = consolePage.getByRole("form", { name: "Create fee rule" });
  await form.getByRole("textbox", { name: "Name", exact: true }).fill(`Service fee ${RUN}`);
  await form.getByRole("textbox", { name: "Label", exact: true }).fill(FEE_LABEL);
  await form.getByRole("radio", { name: /^Booking service fee/ }).check();
  await form.getByRole("radio", { name: "Fixed amount", exact: true }).check();
  await form.getByRole("textbox", { name: "Fixed amount", exact: true }).fill((FEE_CENTS / 100).toFixed(2));
  await expect(form.getByRole("textbox", { name: "Currency of the amounts" })).toHaveValue("EUR");
  await form.getByRole("combobox", { name: "Computed" }).selectOption({ label: "Per booking" });
  await form.getByRole("button", { name: "Create fee rule" }).click();
  // Created without warnings: the new rule opens.
  await consolePage.waitForURL(/\/settings\/fees\/fee_[0-9A-Za-z]{16,40}$/);
  await expect(consolePage.getByRole("heading", { level: 1 })).toContainText(`Service fee ${RUN}`);
  await expectAdminPage(consolePage, "Fee rule");

  // The next search, its cheapest offer and its own fare priced: the fee in the breakdown and in the total.
  const offers = await searchPrices(FEE_DAYS);
  const cheapest = offers[0];
  if (cheapest === undefined) {
    throw new Error("the search answered no offer");
  }
  await shop
    .getByRole("link", {
      name: new RegExp(`^Select this flight for ${euros(cheapest).replace(/[.$]/g, "\\$&")}`),
    })
    .first()
    .click();
  await shop.waitForURL(/\/offer\.html\?offer=off_/);
  const keepFare = shop.getByRole("button", { name: "Continue with this fare" });
  await expect(keepFare).toBeVisible();
  await guards.checkA11y(shop);
  await keepFare.click();
  await shop.waitForURL(/\/price\.html\?priced=prc_/);
  await expect(shop.getByRole("heading", { level: 1, name: "Your price" })).toBeVisible();

  const details = shop.getByRole("region", { name: "Price details" });
  await expect(details.getByText(FEE_LABEL, { exact: true })).toBeVisible();
  await expect(
    details
      .getByRole("definition")
      .filter({ hasText: euros(FEE_CENTS) })
      .first(),
  ).toBeVisible();
  await expect(details.getByRole("definition").last()).toHaveText(euros(cheapest + FEE_CENTS));
  await guards.checkA11y(shop);
});

test("a new primary colour reaches the storefront once its 5-minute copy is gone [OAD-017 AC1] [OF-10 AC2]", async () => {
  // The storefront as it is, read from the API now: the tab's copy of storefront.get (and of the footer's pages) is
  // made here, seconds before the change, so it is still within its 5 minutes below however long the steps before
  // took, and the API's own entries hold the old settings when the change comes (only the change's deletion makes the
  // new colour appear below).
  await forgetStorefrontCopies(shop);
  await openHome();
  const before = await primaryProperty(shop);
  expect(before).toMatch(/^#[0-9a-f]{6}$/);
  expect(before).not.toBe(NEW_PRIMARY);
  await guards.checkA11y(shop);

  await consolePage.goto("/settings/storefront");
  await expectAdminPage(consolePage, "Storefront settings");
  const branding = consolePage.getByRole("form", { name: "Branding and theme" });
  await branding.getByRole("textbox", { name: "Primary", exact: true }).fill(NEW_PRIMARY);
  // The theme editor's own check: every pair passes, so the storefront uses these colours.
  await expect(branding.getByText("the storefront uses these colours", { exact: false })).toBeVisible();
  await branding.getByRole("button", { name: "Save branding and theme" }).click();
  // The section's answer (the theme editor's contrast verdict is a status of its own).
  await expect(
    branding
      .getByRole("status")
      .filter({ hasText: "Saved. The storefront shows the change within 5 minutes." }),
  ).toBeVisible();
  await expectAdminPage(consolePage, "Storefront settings");

  // The tab that read the storefront before keeps its copy for up to 5 minutes (OADR-0012 point 7)…
  await openHome();
  expect(await primaryProperty(shop)).toBe(before);
  // …and once it is gone, the storefront reads the API again, whose own entries the change deleted.
  await forgetStorefrontCopies(shop);
  const form = await openHome();
  expect(await primaryProperty(shop)).toBe(NEW_PRIMARY);
  await expect(form.getByRole("button", { name: "Search flights" })).toHaveCSS(
    "background-color",
    NEW_PRIMARY_RGB,
  );
  await guards.checkA11y(shop);
});

test("a new published page reaches the storefront and its footer [OAD-017 AC1] [OF-10 AC2]", async () => {
  await consolePage.goto("/settings/pages");
  await expectAdminPage(consolePage, "Content pages");
  await consolePage.getByRole("main").getByRole("link", { name: "New page" }).click();
  await expectAdminPage(consolePage, "Content page");

  const main = consolePage.getByRole("main");
  await main.getByRole("textbox", { name: "Address", exact: true }).fill(PAGE_SLUG);
  await main.getByRole("textbox", { name: "Title", exact: true }).fill(PAGE_TITLE);
  await main.getByRole("textbox", { name: "Body", exact: true }).fill(PAGE_BODY);
  await main.getByRole("checkbox", { name: "Published on the storefront" }).check();
  await main.getByRole("checkbox", { name: "Listed in the storefront footer" }).check();
  await main.getByRole("button", { name: "Create page" }).click();
  await consolePage.waitForURL(/\/settings\/pages\/stp_[0-9A-Za-z]{16,40}$/);
  await expect(
    consolePage.getByRole("main").getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue(PAGE_TITLE);
  await expectAdminPage(consolePage, "Content page");

  // The tab's copy of the footer's pages predates the page: forgotten as above, then the page and its footer link.
  await forgetStorefrontCopies(shop);
  await shop.goto(`/p/${PAGE_SLUG}`);
  await expect(shop.getByRole("heading", { level: 1, name: PAGE_TITLE })).toBeVisible();
  await expect(shop).toHaveTitle(new RegExp(PAGE_TITLE));
  const article = shop.getByRole("main");
  await expect(article.getByRole("heading", { level: 2, name: "Who we are" })).toBeVisible();
  await expect(article.getByText("small team", { exact: true })).toBeVisible();
  const footerLink = shop.getByRole("contentinfo").getByRole("link", { name: PAGE_TITLE });
  await expect(footerLink).toHaveAttribute("href", `/p/${PAGE_SLUG}`);
  await expect(footerLink).toHaveAttribute("aria-current", "page");
  await guards.checkA11y(shop);
});

test("an e-mail template that does not compile is refused, and nothing is saved [OAD-017 AC1] [OF-10 AC3]", async () => {
  const locale = await withTenantTx(
    owned.schema,
    async (trx) =>
      (await trx.selectFrom("storefront_settings").select("default_locale").executeTakeFirstOrThrow())
        .default_locale,
  );
  /** The OTA's rows of the template in that locale: what a refused save must leave as it is. */
  const templateRows = async () =>
    await withTenantTx(owned.schema, async (trx) =>
      trx
        .selectFrom("notification_templates")
        .select(["id", "version", "body_html"])
        .where("key", "=", TEMPLATE_KEY)
        .where("locale", "=", locale)
        .execute(),
    );
  const rowsBefore = await templateRows();

  await consolePage.goto("/settings/templates");
  await expectAdminPage(consolePage, "E-mail templates");
  await consolePage.goto(`/settings/templates/${TEMPLATE_KEY}/email/${encodeURIComponent(locale)}`);
  await expectAdminPage(consolePage, "E-mail template");

  const main = consolePage.getByRole("main");
  const html = main.getByRole("textbox", { name: "HTML body", exact: true });
  const saved = await html.inputValue();
  await html.fill(BROKEN_HTML);
  await main.getByRole("button", { name: "Save", exact: true }).click();

  // 422 TEMPLATE_INVALID, per part and line: the HTML body's line 2, with the way to it.
  await expect(main.getByRole("alert")).toContainText("The template does not compile");
  const problems = main.getByRole("region", { name: "The template does not compile" });
  await expect(problems.getByRole("listitem")).toHaveCount(1);
  await expect(problems.getByRole("listitem")).toContainText("HTML body, line 2: ");
  await expect(problems.getByRole("button", { name: "Go to line 2 of the HTML body" })).toBeVisible();
  await expectAdminPage(consolePage, "E-mail template");

  // Nothing was saved: the rows as they were, the refusal audited, and the editor shows the saved body again.
  expect(await templateRows()).toEqual(rowsBefore);
  const refusals = await withTenantTx(owned.schema, async (trx) =>
    trx
      .selectFrom("staff_actions")
      .select(["outcome", "staff_role"])
      .where("action", "=", "settings.templates.put")
      .execute(),
  );
  expect(refusals).toEqual([{ outcome: "failed", staff_role: "owner" }]);
  await consolePage.reload();
  await expect(main.getByRole("textbox", { name: "HTML body", exact: true })).toHaveValue(saved);
  await expectAdminPage(consolePage, "E-mail template");
});
