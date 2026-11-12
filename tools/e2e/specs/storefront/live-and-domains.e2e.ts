// The live-mode and custom-domain journey of the hosted storefront (OFE-022; ota/frontend/README.md §13 journey 6,
// OF-12 AC1, the M5 demo of platform/docs/plans/implementation-plan.md §4), in the `storefront` project, with the
// storefront guards on (support/storefront-guards.ts) and axe on every page it visits.
//
//   an owner with MFA creates an OTA and steps up → goLive names only the preconditions the stack cannot reach → a
//   platform admin of the journey's own gives the OTA a plan with live mode and makes its manual subscription `active`
//   through the platform admin API, and velexis_migrator fixtures meet what no API reaches (the OTA's own live Amadeus
//   connection, a Stripe Connect test connection) → goLive switches the OTA to live → its custom domain, verified
//   with its certificate issued (a fixture: no DNS in the stack),
//   becomes its primary host → in the browser: the sub-domain and the custom domain show the same OTA without the test
//   banner → a search on the custom domain runs on the live Amadeus connection → sign-in on the sub-domain goes to the
//   same page on the primary host before any session → a sign-up through the sub-domain lands on the primary host, and
//   its e-mail's links name the primary host
//
// The OTA's two hosts are its own origins in the journey's browser (support/ota.ts, "The storefront's live mode and
// custom domain"): its sub-domain `<key>.ota.example.com` is mapped to the preview on STOREFRONT_URL by Chromium's
// host-resolver rules (the browser of this file is launched with them; the preview allows the storefront sub-domains,
// ota/frontend/vite.config.js), so the page runs on the sub-domain itself, where the primary-host rule of OFE-021 acts;
// the custom domain is answered over https by the journey from the same preview, as Caddy answers it on the VM, so the
// redirect's target loads and the storefront's Secure `__Host-` cookies work there. On both hosts the pages' `/api/*`
// requests reach the OTA API with the edge headers Caddy adds in front of that host.
//
// The steps are tests in order on one browser context made in `beforeAll` (`mode: "serial"`): a failed step stops the
// rest. The owner's password, TOTP secret and tokens stay in variables, never logged; the OTA's own Amadeus client
// secret is random and only ever stored sealed (support/ota.ts, `sealedClientSecret`).
import type { Browser, BrowserContext, Page, Request } from "@playwright/test";
import { uniqueTestIp } from "../../support/fixtures";
import { extractLinks, uniqueEmail, waitForEmail } from "../../support/mailpit";
import {
  addPrimaryCustomDomain,
  amadeusConnectionOf,
  customDomainOf,
  departureDate,
  EdgeApi,
  FIXTURE_PRECONDITIONS,
  goLiveAttempt,
  hostResolverRules,
  meetLivePreconditions,
  newHarnessAdmin,
  newOwnerWithActiveOta,
  recordedSearchOf,
  searchIdOf,
  serveStorefrontHost,
  stepUpWithApi,
  storefrontHostsOf,
  uniqueLiveOfficeId,
  type AmadeusConnectionRow,
  type GoLiveAnswer,
  type LivePreconditionFixtures,
  type OwnedOta,
  type StorefrontHosts,
} from "../../support/ota";
import { newPassword } from "../../support/seed";
import { STACK_PORTS, STOREFRONT_URL } from "../../support/stack";
import { CSRF_COOKIE, expect, StorefrontGuards, test } from "../../support/storefront-guards";

test.describe.configure({ mode: "serial" });

/**
 * The arrangement of `beforeAll`: a verified account with MFA and a sign-up e-mail through Mailpit (at most 15 s), up
 * to three TOTP codes of their own 30-second steps (enableMfa, the MFA sign-in, the step-up: the platform takes each
 * code once, so up to 90 s), the OTA's set-up on the OTA worker (about 2 s, at most 45 s), a platform admin of the
 * journey's own (`newHarnessAdmin`: an account with MFA through Mailpit, at most 15 s, `admin:grant` and two TOTP codes
 * of its own steps), the plan and the subscription through the admin API and the fixtures, two goLive calls, the
 * custom domain, the storefront's answer following them (at most 10 s) and a browser launch: about 200 s at worst. Its
 * own budget, commented; each step keeps the default 30 s.
 */
const ARRANGE_TIMEOUT_MS = 240_000;

/** How long the storefront configuration may take to follow goLive and the custom domain (the invalidations). */
const FOLLOW_TIMEOUT_MS = 10_000;

/** The departure of the journey's search: 40 days from today (tools/e2e/README.md, "Storefront journeys"). */
const DAYS_AHEAD = 40;

/** The traveller who signs up on the primary host: synthetic. */
const CUSTOMER = { firstName: "Liv", lastName: "Primary" } as const;

/** The results page address the search form sends for a one-way trip from Madrid to Paris (docs/pages.md §3). */
function searchAddress(): string {
  const query = new URLSearchParams({
    trip: "oneway",
    from: "MAD",
    to: "PAR",
    depart: departureDate(DAYS_AHEAD),
    adults: "1",
    children: "0",
    infants: "0",
    cabin: "ECONOMY",
  });
  return `/search.html?${query.toString()}`;
}

/** What `beforeAll` arranged and recorded; the tests check it. */
interface Arranged {
  readonly owned: OwnedOta;
  readonly liveOffice: string;
  /** The OTA's live Amadeus connection before the fixtures (none) and after them. */
  readonly liveConnections: {
    readonly before: AmadeusConnectionRow | undefined;
    readonly after: AmadeusConnectionRow | undefined;
  };
  readonly refused: GoLiveAnswer;
  readonly fixtures: LivePreconditionFixtures;
  readonly wentLive: GoLiveAnswer;
  /** The OTA's sub-domain, `<key>.ota.example.com`. */
  readonly subHost: string;
  readonly customHost: string;
  /** storefront.get as the edge of each host answers it once it follows goLive and the custom domain. */
  readonly configs: { readonly sub: StorefrontHosts; readonly custom: StorefrontHosts };
}

let arranged: Arranged;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page;
let guards: StorefrontGuards;
/** `http://<key>.ota.example.com:4173`: the sub-domain, mapped to the preview on STOREFRONT_URL. */
let subOrigin: string;
/** `https://<custom domain>`: the primary host, answered by the journey from the preview. */
let customOrigin: string;

/** storefront.get as the storefront edge of `host` answers it, its hosts and environment only. */
async function storefrontOf(host: string, endUserIp: string): Promise<StorefrontHosts | undefined> {
  return storefrontHostsOf(await new EdgeApi(host, endUserIp).call("getStorefront", "GET", "/v1/storefront"));
}

/**
 * Waits until the page shows the OTA `name`'s configuration (the header's brand: boot applied storefront.get, and with
 * it the environment in the same step) and checks the live storefront: no test banner.
 */
async function expectLiveStorefront(target: Page, name: string): Promise<void> {
  await expect(target.locator('header [data-field="brandName"]')).toHaveText(name);
  // The page has the banner (every page includes its partial) and boot left it hidden: a missing partial never passes.
  const banner = target.locator('[data-slot="test-banner"]');
  await expect(banner).toHaveCount(1);
  await expect(banner).toBeHidden();
  await expect(target.getByRole("note")).toHaveCount(0);
}

/**
 * The live home page has no robots meta: a test storefront's pages get `noindex` from boot, and the home page has no
 * robots meta of its own (the results, account and checkout pages keep their own `noindex` in both environments).
 */
async function expectIndexableHome(target: Page): Promise<void> {
  await expect(target.locator('meta[name="robots"]')).toHaveCount(0);
}

test.beforeAll(async ({ playwright, launchOptions }) => {
  test.setTimeout(ARRANGE_TIMEOUT_MS);
  const endUserIp = uniqueTestIp();

  // The owner and the OTA, through the portal's API; the owner turns MFA on and steps up before the sensitive calls.
  const owned = await newOwnerWithActiveOta("Lena Live", "live", { mfa: true });
  const owner = await stepUpWithApi(owned.owner);
  const liveOffice = uniqueLiveOfficeId();

  // goLive names what is still missing; the admin API and the fixtures meet exactly that, and goLive switches the OTA to
  // live.
  const admin = await newHarnessAdmin("Lars Live Admin");
  const before = await amadeusConnectionOf(owned.ota.id, "live");
  const refused = await goLiveAttempt(owner, owned.ota.id);
  const fixtures = await meetLivePreconditions(owned, liveOffice, admin);
  const after = await amadeusConnectionOf(owned.ota.id, "live");
  const wentLive = await goLiveAttempt(owner, owned.ota.id);

  const subHost = owned.storefrontHost;
  const customHost = customDomainOf(owned.ota.key);
  await addPrimaryCustomDomain(owned, customHost);
  let configs: { sub: StorefrontHosts | undefined; custom: StorefrontHosts | undefined } = {
    sub: undefined,
    custom: undefined,
  };
  await expect
    .poll(
      async () => {
        configs = {
          sub: await storefrontOf(subHost, endUserIp),
          custom: await storefrontOf(customHost, endUserIp),
        };
        return [configs.sub, configs.custom].map((config) => `${config?.environment} ${config?.primaryUrl}`);
      },
      {
        timeout: FOLLOW_TIMEOUT_MS,
        message: "the storefront of both hosts is live on the primary custom domain",
      },
    )
    .toEqual([`live https://${customHost}`, `live https://${customHost}`]);
  arranged = {
    owned,
    liveOffice,
    liveConnections: { before, after },
    refused,
    fixtures,
    wentLive,
    subHost,
    customHost,
    configs: { sub: configs.sub as StorefrontHosts, custom: configs.custom as StorefrontHosts },
  };

  // A browser of this file whose resolver maps the sub-domain to the stack's loopback address, and the journey's context.
  subOrigin = `http://${subHost}:${STACK_PORTS.storefront}`;
  customOrigin = `https://${customHost}`;
  const mapped = await playwright.chromium.launch({
    ...launchOptions,
    args: [...(launchOptions.args ?? []), hostResolverRules([subHost])],
  });
  browser = mapped;
  context = await mapped.newContext();
  guards = await StorefrontGuards.install(context, { origins: [subOrigin, customOrigin] });
  await serveStorefrontHost(context, { origin: subOrigin, endUserIp });
  await serveStorefrontHost(context, { origin: customOrigin, endUserIp, pagesFrom: STOREFRONT_URL });
  page = await context.newPage();
});

test.afterEach(async () => {
  // The guards of the journey's context: CSP, third-party requests, readable cookies, axe on the page it is on.
  await guards?.finish(page);
});

test.afterAll(async () => {
  await context?.close();
  await browser?.close();
});

test("the owner takes the OTA live through the platform API, the fixtures meeting only what the stack cannot reach [OFE-022 AC1] [OF-12 AC1]", () => {
  const { owned, liveOffice, liveConnections, refused, fixtures, wentLive } = arranged;
  // Before the fixtures, the new OTA has no live Amadeus connection, and goLive (an owner with MFA, stepped up) names
  // exactly the preconditions they meet: MFA, the one goLive checks last, is the owner's own.
  expect(liveConnections.before).toBeUndefined();
  expect(refused).toEqual({
    status: 422,
    code: "LIVE_PRECONDITIONS_UNMET",
    missing: [...FIXTURE_PRECONDITIONS],
  });
  // The OTA's own live Amadeus connection as the platform worker leaves verified own credentials.
  expect(fixtures.liveConnectionId).toMatch(/^sc_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(liveConnections.after).toEqual({
    status: "active",
    credentialSource: "tenant",
    defaultOfficeId: liveOffice,
    officeIds: [liveOffice],
  });
  // The plan with live mode and the OTA's own manual subscription, made `active` through the platform admin API.
  expect(fixtures.planCode).toBe(`e2elive_${owned.ota.key}`);
  expect(fixtures.subscriptionId).toMatch(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(fixtures.connectAccount).toMatch(/^acct_[A-Za-z0-9]+$/);
  // Then goLive switches it to live.
  expect(wentLive).toEqual({ status: 200, storefrontEnvironment: "live" });
});

test("the sub-domain shows the live storefront: no test banner and no noindex [OFE-022 AC1]", async () => {
  const { owned, configs, subHost, customHost } = arranged;
  expect(configs.sub).toMatchObject({
    tenantKey: owned.ota.key,
    environment: "live",
    primaryUrl: customOrigin,
  });
  // Both hosts are servable; the custom domain is primary (StorefrontConfig.domains, FIX-W38-OTA).
  expect(configs.sub.domains).toEqual([
    { host: subHost, kind: "subdomain", primary: false },
    { host: customHost, kind: "custom", primary: true },
  ]);

  const configAnswer = page.waitForResponse(
    (response) => response.url().startsWith(`${subOrigin}/api/v1/storefront`) && response.status() === 200,
  );
  await page.goto(`${subOrigin}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Search flights" })).toBeVisible();
  // The page runs on the sub-domain itself (its `Host`), and its API answers name this OTA, live.
  expect(new URL(page.url()).host).toBe(`${subHost}:${STACK_PORTS.storefront}`);
  expect(storefrontHostsOf(await (await configAnswer).json())).toMatchObject({
    tenantKey: owned.ota.key,
    environment: "live",
  });
  await expectLiveStorefront(page, owned.ota.name);
  await expectIndexableHome(page);
  await guards.checkA11y(page);
});

test("the primary custom domain serves the same OTA, live and without a redirect [OFE-022 AC1]", async () => {
  const { owned, configs } = arranged;
  expect(configs.custom).toEqual(configs.sub);

  const configAnswer = page.waitForResponse(
    (response) => response.url().startsWith(`${customOrigin}/api/v1/storefront`) && response.status() === 200,
  );
  await page.goto(`${customOrigin}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Search flights" })).toBeVisible();
  expect(storefrontHostsOf(await (await configAnswer).json())).toMatchObject({
    tenantKey: owned.ota.key,
    environment: "live",
    primaryUrl: customOrigin,
  });
  await expectLiveStorefront(page, owned.ota.name);
  await expectIndexableHome(page);
  // A custom domain never redirects (lib/primary-host.js): the page stays where it is.
  expect(page.url()).toBe(`${customOrigin}/`);
  await guards.checkA11y(page);
});

test("a search on the custom domain runs on the OTA's live Amadeus connection [OFE-022 AC1] [OF-12 AC1]", async () => {
  const { owned, liveOffice } = arranged;
  await page.goto(`${customOrigin}${searchAddress()}`);
  await page.waitForURL(/\/search\.html\?.*search=srch_/);
  const results = page.getByRole("region", { name: /flights?$/ });
  await expect(results.getByRole("heading", { level: 2, name: "5 flights" })).toBeVisible();
  await expectLiveStorefront(page, owned.ota.name);
  await guards.checkA11y(page);

  // The OTA recorded the search in the live environment, and its Amadeus calls went out on the live connection: the
  // office of the OTA's own live credentials (the stack has one stub for both environments, AMADEUS_BASE_URL_TEST and
  // _LIVE, so the environment and the office tell the connection apart, not a port).
  const recorded = await recordedSearchOf(owned.schema, searchIdOf(page.url()));
  expect(recorded.environment).toBe("live");
  expect(recorded.supplierRequests.filter((call) => call.amadeusApi === "FlightOffersSearch")).toEqual([
    { environment: "live", amadeusApi: "FlightOffersSearch", officeId: liveOffice, outcome: "success" },
  ]);
  expect(recorded.supplierRequests.filter((call) => call.environment !== "live")).toEqual([]);
});

test("sign-in on the sub-domain goes to the same page on the primary host before any session [OFE-022 AC1]", async () => {
  const subApiCalls: string[] = [];
  const onRequest = (request: Request): void => {
    const url = new URL(request.url());
    if (url.origin === subOrigin && url.pathname.startsWith("/api/")) {
      subApiCalls.push(`${request.method()} ${url.pathname}`);
    }
  };
  page.on("request", onRequest);
  const target = `${customOrigin}/account/sign-in.html?next=%2Fbookings.html`;
  const redirect = page.waitForRequest(
    (request) => request.isNavigationRequest() && request.url() === target,
  );
  // The redirect may start before the sub-domain's page has loaded (boot reads the tab's configuration copy), so the
  // navigation is followed from its commit.
  await page.goto(`${subOrigin}/account/sign-in.html?next=%2Fbookings.html`, { waitUntil: "commit" });
  const navigation = await redirect;
  expect(navigation.frame()).toBe(page.mainFrame());
  await page.waitForURL(target);
  page.off("request", onRequest);

  // On the primary host, the sign-in page itself, with the path and query kept; it does not redirect again.
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(page.url()).toBe(target);
  // Nothing on the sub-domain asked for a session or made one: at most storefront.get, and no cookie of its own.
  expect(subApiCalls.filter((call) => call !== "GET /api/v1/storefront")).toEqual([]);
  expect((await (context as BrowserContext).cookies(subOrigin)).map((cookie) => cookie.name)).toEqual([]);
  await guards.checkA11y(page);
});

test("a sign-up through the sub-domain lands on the primary host, and its e-mail's links name the primary host [OFE-022 AC1]", async () => {
  const email = uniqueEmail("ofe022-live");
  await page.goto(`${subOrigin}/account/sign-up.html`, { waitUntil: "commit" });
  await page.waitForURL(`${customOrigin}/account/sign-up.html`);
  await expect(page.getByRole("heading", { level: 1, name: "Create an account" })).toBeVisible();
  await guards.checkA11y(page);

  const form = page.getByRole("main").locator("form");
  await form.getByRole("textbox", { name: "First name" }).fill(CUSTOMER.firstName);
  await form.getByRole("textbox", { name: "Last name" }).fill(CUSTOMER.lastName);
  await form.getByRole("textbox", { name: "E-mail address" }).fill(email);
  await form.getByLabel("Password", { exact: true }).fill(newPassword());
  await form.getByRole("checkbox", { name: /^I accept the terms and conditions/ }).check();
  await form.getByRole("button", { name: "Create account" }).click();
  // The session lives on the primary host (its own httpOnly cookies); JavaScript there reads the CSRF token alone.
  await page.waitForURL(`${customOrigin}/account/`);
  await expect(page.getByRole("navigation", { name: "Main" })).toContainText(`Hi, ${CUSTOMER.firstName}`);
  await guards.checkA11y(page);
  const cookies = await (context as BrowserContext).cookies(customOrigin);
  expect(cookies.filter((cookie) => !cookie.httpOnly).map((cookie) => cookie.name)).toEqual([CSRF_COOKIE]);

  // Every link of the verification e-mail names the primary host (OBE-080), the verification link among them.
  const message = await waitForEmail({ to: email });
  const links = extractLinks(message)
    .filter((href) => /^https?:/i.test(href))
    .map((href) => new URL(href));
  expect(links.length).toBeGreaterThan(0);
  expect([...new Set(links.map((link) => link.origin))]).toEqual([customOrigin]);
  const verify = links.find((link) => link.pathname === "/account/verify.html");
  expect(verify, "the verification link").toBeDefined();

  // The link opens on the primary host, where the address is confirmed.
  await page.goto((verify as URL).href);
  await expect(page.getByRole("heading", { level: 1, name: "Confirm your e-mail address" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: `${email} is confirmed` })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(customOrigin);
  await guards.checkA11y(page);
});
