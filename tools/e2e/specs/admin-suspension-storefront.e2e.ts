// A suspension in the platform admin reaches the OTA's hosted storefront, and a resume brings it back (PAD-011;
// flows/platform-admin-operations.md "Tests that prove it", PADR-0014 point 5, PF-82): an OTA created through the portal
// API by its owner (`createTenant`) and set up by the OTA worker, so the journey needs `E2E_WITH_OTA=1` (the e2e
// workflow sets it).
//
//   a traveller opens the OTA's storefront, which works → the admin suspends the OTA with a reason → a traveller who
//   arrives sees "temporarily unavailable" within 60 s, and the traveller whose tab was open sees it at their next
//   search → the admin resumes the OTA → a traveller who arrives sees the storefront work again within 60 s, and the
//   open tab's next call to the API is answered again
//
// Its storefront is the production build in `vite preview` on ADMIN_SUSPENSION_STOREFRONT_URL, whose proxy sends the
// OTA API the host of ADMIN_SUSPENSION_TENANT_KEY (support/stack.ts): the OTA takes that key, which no other journey
// takes, so nothing else of a run ever sees its storefront unavailable. The stack's database is new for each run, so
// the key is free; a second run of this file in the same stack (`--repeat-each`) would be refused the key.
//
// How fast. The OTA API reads the tenant's status from its platform cache, which the platform's `tenant` invalidation
// clears right after the admin's commit (PBE-036 proves about a second on the API); without the invalidation the
// cache's 60 s are the bound of PF-82. Each wait is for the state the storefront shows, polled, never a sleep, within
// the step's default 30 s (a test's own budget is never raised, tools/e2e/README.md), and so within the 60 s.
//
// What a reload shows. Each page asks `storefront.get` once and keeps its answer in the tab's sessionStorage for 5
// minutes (ota/frontend/src/lib/config.js, OADR-0015 point 7); errors are never kept. So a tab that showed the home page
// just before the suspension shows it again on a reload, from that copy, until its next call to the API, which the
// API answers `403 TENANT_SUSPENDED`. The journey therefore follows the storefront as a traveller who arrives does (a
// new tab, which asks the API: the `storefront.get` answer is part of each check), and shows the open tab's next search
// replaced by the unavailable page.
//
// The steps are tests in order (`mode: "serial"`) on the admin's page and the traveller's browser context, whose
// storefront pages run under the storefront guards (support/storefront-guards.ts: CSP, third-party requests, cookies
// JavaScript can read, axe), checked after every step. Every page the journey visits passes axe once it shows what the
// journey came for.
import { type BrowserContext, type Page, type Response } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  createVerifiedAccount,
  enableMfa,
  expect,
  newAccountContext,
  signInToAdminWithApi,
  signInWithApi,
  test,
  type MfaAccount,
} from "../support/fixtures";
import { buildAccount, grantPlatformAdmin, stack } from "../support/seed";
import {
  ADMIN_SUSPENSION_STOREFRONT_URL,
  ADMIN_SUSPENSION_TENANT_KEY,
  PLATFORM_ADMIN_URL,
} from "../support/stack";
import { StorefrontGuards } from "../support/storefront-guards";
import { createOtaWithApi, waitForOtaStatus, type Ota } from "../support/tenants";

test.describe.configure({ mode: "serial" });

const SUSPEND_REASON = "The OTA asked for a pause while it moves offices (PAD-011 journey).";
const RESUME_REASON = "The OTA finished its move and asked to sell again (PAD-011 journey).";

/** The first heading of the storefront's home page when it works (docs/pages.md §3). */
const WORKING = "Search flights";
/** The first heading of the full-page state of `403 TENANT_SUSPENDED` (partials/states.html, lib/i18n.js). */
const UNAVAILABLE = "This travel site is temporarily unavailable";
/** The first heading of either. */
const HOME_HEADING = new RegExp(`^(?:${WORKING}|${UNAVAILABLE})$`);

/** PF-82: the storefront follows a suspension and a resume within 60 seconds each. */
const PF82_BOUND_MS = 60_000;
/**
 * How long a step waits for the storefront to follow: inside the step's default 30 s, and so inside PF82_BOUND_MS. The
 * platform's invalidation makes it about a second (see the file header).
 */
const FOLLOW_TIMEOUT_MS = 25_000;

/** The departure of the open tab's search: days from today, never a fixed calendar date. */
const SEARCH_DAYS_AHEAD = 47;

/** `storefront.get` through the preview's proxy (`GET /v1/storefront` of the OTA API). */
const isStorefrontGet = (response: Response): boolean =>
  response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/storefront";

/** `flights.search` through the preview's proxy (`POST /v1/flight-searches`). */
const isFlightSearch = (response: Response): boolean =>
  response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/flight-searches";

/** `reference.locations.search` through the preview's proxy (`GET /v1/reference/locations`). */
const isLocationSearch = (response: Response): boolean =>
  response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/reference/locations";

/** The traveller's browser: one context with the storefront guards, and the tab they keep open. */
interface Traveller {
  readonly context: BrowserContext;
  readonly guards: StorefrontGuards;
  /** The tab that shows the storefront from the first step on. */
  readonly page: Page;
}

let admin: MfaAccount;
let ota: Ota;
let adminContext: BrowserContext;
let adminPage: Page;
let traveller: Traveller;
/** When the admin confirmed the suspension or the resume: where each "within 60 s" starts. */
let confirmedAt = 0;

/** Waits until `target` shows the admin page `title`, then runs axe. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(`${title} · Velexis admin`);
  await expectNoSeriousA11yViolations(target);
}

/** What a traveller who arrives now sees on the storefront's home page. */
interface Arrival {
  /** The new tab, on the home page (the caller closes it). */
  readonly page: Page;
  /** The page's `storefront.get` answer. */
  readonly answer: Response;
  /** The page's first heading: WORKING or UNAVAILABLE. */
  readonly heading: string;
}

/**
 * Opens the storefront's home page in a new tab of the traveller's context, as a traveller who arrives now: a new tab
 * has no copy of `storefront.get` in its sessionStorage, so the page asks the API, and its state is the API's answer.
 * Resolves once the page shows the working home page or the unavailable state.
 */
async function arrive(): Promise<Arrival> {
  const page = await traveller.context.newPage();
  const configAnswer = page.waitForResponse(isStorefrontGet);
  await page.goto("/");
  const answer = await configAnswer;
  const heading = page.getByRole("heading", { level: 1, name: HOME_HEADING });
  await expect(heading).toBeVisible();
  return { page, answer, heading: await heading.innerText() };
}

/**
 * Lets travellers arrive, one new tab after the other, until the home page shows `heading` with `storefront.get`
 * answered `status`, within FOLLOW_TIMEOUT_MS, and resolves to that arrival (the other tabs are closed). Fails when
 * the storefront has not followed by then, with the last state seen.
 */
async function waitUntilArrivalsSee(heading: string, status: number): Promise<Arrival> {
  let shown: Arrival | undefined;
  await expect
    .poll(
      async () => {
        const arrival = await arrive();
        const seen = `${arrival.answer.status()} ${arrival.heading}`;
        if (arrival.heading === heading && arrival.answer.status() === status) {
          shown = arrival;
        } else {
          await arrival.page.close();
        }
        return seen;
      },
      { timeout: FOLLOW_TIMEOUT_MS, intervals: [250, 500, 1_000] },
    )
    .toBe(`${status} ${heading}`);
  if (shown === undefined) {
    throw new Error(`no tab showed "${heading}"`);
  }
  return shown;
}

/** The address the home page's search form sends for a one-way trip from Madrid to Paris (docs/pages.md §3). */
function searchAddress(): string {
  const depart = new Date(Date.now() + SEARCH_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10);
  const query = new URLSearchParams({
    trip: "oneway",
    from: "MAD",
    to: "PAR",
    depart,
    adults: "1",
    children: "0",
    infants: "0",
    cabin: "ECONOMY",
  });
  return `/search.html?${query.toString()}`;
}

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "admin-suspension-storefront.e2e.ts needs an OTA with a storefront: run it with E2E_WITH_OTA=1 (the Amadeus " +
        "stub, the OTA worker and API, and the storefront previews)",
    );
  }
  // Budget: two sign-ups with their verification e-mails (up to 15 s each, in parallel), an MFA set-up, `admin:grant`
  // through the platform CLI and the OTA's set-up on the OTA worker (about 2 s locally; PF-11 allows a minute).
  test.setTimeout(90_000);
  const [ownerAccount, adminAccount] = await Promise.all([
    createVerifiedAccount(buildAccount({ fullName: "Stella Storefront" })),
    createVerifiedAccount(buildAccount({ fullName: "Sam Suspender" })).then(enableMfa),
  ]);
  admin = adminAccount;
  const ownerSession = await signInWithApi(ownerAccount);
  const owner = { account: ownerAccount, accessToken: ownerSession.accessToken };
  const created = await createOtaWithApi(owner, {
    key: ADMIN_SUSPENSION_TENANT_KEY,
    name: "Suspension Travel",
  });
  await grantPlatformAdmin(admin.email);
  ota = await waitForOtaStatus(owner, created.id, "active");

  adminContext = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  await addSessionCookies(adminContext, "admin", await signInToAdminWithApi(admin));
  adminPage = await adminContext.newPage();

  // The traveller: no account, no cookie; the guards watch the context from before its first navigation.
  const context = await browser.newContext({ baseURL: ADMIN_SUSPENSION_STOREFRONT_URL });
  const guards = await StorefrontGuards.install(context);
  traveller = { context, guards, page: await context.newPage() };
});

test.afterEach(async () => {
  // The guards of the traveller's context: CSP, third-party requests, readable cookies, axe on the open tab.
  await traveller?.guards.finish(traveller.page);
});

test.afterAll(async () => {
  await traveller?.context.close();
  await adminContext?.close();
});

test("a traveller opens the OTA's storefront, which works [PAD-011 AC1]", async () => {
  const { page, guards } = traveller;
  const configAnswer = page.waitForResponse(isStorefrontGet);
  await page.goto("/");
  expect((await configAnswer).status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: WORKING })).toBeVisible();
  // The OTA's own storefront: its name in the header, in test mode as a new OTA is (`storefront_environment`).
  await expect(page.getByRole("banner").getByRole("link", { name: ota.name })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Test mode");
  await expect(page.getByRole("form", { name: WORKING })).toBeVisible();
  await guards.checkA11y(page);
});

test("the admin suspends the OTA with a reason [PAD-011 AC1]", async () => {
  await adminPage.goto(`/tenants/${ota.id}`);
  await expect(adminPage.getByRole("heading", { level: 1, name: ota.name })).toBeVisible();
  await expectAccessible(adminPage, "Tenant");

  await adminPage.getByRole("button", { name: "Suspend", exact: true }).click();
  const dialog = adminPage.getByRole("dialog", { name: `Suspend ${ota.name}?` });
  await dialog.getByLabel("Kind of suspension").selectOption("request");
  await dialog.getByLabel("Reason").fill(SUSPEND_REASON);
  await expectNoSeriousA11yViolations(adminPage);
  confirmedAt = Date.now();
  await dialog.getByRole("button", { name: "Suspend OTA" }).click();

  const outcome = adminPage.getByRole("status").filter({ hasText: "The OTA is suspended." });
  await expect(outcome).toContainText("Suspended");
  await expect(adminPage.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await expectAccessible(adminPage, "Tenant");
});

test("a traveller who arrives sees the storefront temporarily unavailable within 60 seconds [PAD-011 AC1] [PF-82]", async () => {
  const { page, answer } = await waitUntilArrivalsSee(UNAVAILABLE, 403);
  const followedAfterMs = Date.now() - confirmedAt;
  test.info().annotations.push({ type: "suspension followed after", description: `${followedAfterMs} ms` });
  expect(followedAfterMs).toBeLessThan(PF82_BOUND_MS);
  // PF-82: `storefront.get` is answered `TENANT_SUSPENDED` (a `403 HOST_NOT_ALLOWED` shows another page).
  expect(await answer.json()).toMatchObject({ error: { code: "TENANT_SUSPENDED" } });
  // The state is final: no Retry, no search form, and not for search engines (PADR-0014 point 5).
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByRole("form", { name: WORKING })).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await traveller.guards.checkA11y(page);
  await page.close();
});

test("the traveller's open tab shows it at their next search [PAD-011 AC1] [PF-82]", async () => {
  const { page, guards } = traveller;
  // The home page's form is a GET form to /search.html: its address, as submitting the form sends it. The page itself
  // comes from the tab's copy of the configuration; its search goes to the API, which refuses the suspended OTA.
  const searchAnswer = page.waitForResponse(isFlightSearch);
  await page.goto(searchAddress());
  const answer = await searchAnswer;
  expect(answer.status()).toBe(403);
  expect(await answer.json()).toMatchObject({ error: { code: "TENANT_SUSPENDED" } });
  await expect(page.getByRole("heading", { level: 1, name: UNAVAILABLE })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await guards.checkA11y(page);
});

test("the admin resumes the OTA with a reason [PAD-011 AC1]", async () => {
  await adminPage.getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = adminPage.getByRole("dialog", { name: `Resume ${ota.name}?` });
  await dialog.getByLabel("Reason").fill(RESUME_REASON);
  await expectNoSeriousA11yViolations(adminPage);
  confirmedAt = Date.now();
  await dialog.getByRole("button", { name: "Resume OTA" }).click();

  const outcome = adminPage.getByRole("status").filter({ hasText: "The OTA is active again." });
  await expect(outcome).toContainText("Active");
  await expect(adminPage.getByRole("button", { name: "Suspend", exact: true })).toBeVisible();
  await expectAccessible(adminPage, "Tenant");
});

test("a traveller who arrives sees the storefront work again within 60 seconds [PAD-011 AC1] [PF-82]", async () => {
  const { page } = await waitUntilArrivalsSee(WORKING, 200);
  const followedAfterMs = Date.now() - confirmedAt;
  test.info().annotations.push({ type: "resume followed after", description: `${followedAfterMs} ms` });
  expect(followedAfterMs).toBeLessThan(PF82_BOUND_MS);
  await expect(page.getByRole("banner").getByRole("link", { name: ota.name })).toBeVisible();
  await expect(page.getByRole("form", { name: WORKING })).toBeVisible();
  await traveller.guards.checkA11y(page);
  await page.close();
});

test("the traveller's open tab is answered again: the airports of the search form come from the API [PAD-011 AC1] [PF-82]", async () => {
  const { page, guards } = traveller;
  await page.goto("/");
  const form = page.getByRole("form", { name: WORKING });
  await expect(form).toBeVisible();
  // The suggestions of the "From" field are `reference.locations.search` of the API, which answers this OTA again. No
  // earlier step asked for this keyword, so the browser's cache (reference answers are public for an hour) has none.
  const field = page.getByRole("combobox", { name: "From" });
  const suggestions = page.waitForResponse(isLocationSearch);
  await field.fill("Madrid");
  expect((await suggestions).status()).toBe(200);
  const option = page.getByRole("listbox", { name: "From" }).getByRole("option", { name: /^MAD / }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(field).toHaveValue(/\(MAD\)$/);
  await guards.checkA11y(page);
});
