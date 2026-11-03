// Live mode and custom domains on the storefront (OFE-021; ota/frontend/README.md §2 points 4 and 5, OADR-0006
// Follow-ups, ADR-0018 "Custom domain lifecycle" step 5): the primary-host rule of lib/primary-host.js on its own, and
// boot() of src/boot.js on the real pages (their partials expanded by the build's include plugin, in a happy-dom
// browser page) against a fake SDK. It covers live versus test rendering (the test banner and `noindex`), and the
// redirect of the sign-in and sign-up pages from the OTA's sub-domain to its primary custom domain: only those pages,
// only to the primary host that storefront.get names, with the path and the query kept, and never anywhere else.
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { applyEnvironment, boot } from "../src/boot.js";
import {
  AUTH_PAGE_PATHS,
  isAuthPage,
  primaryCustomHost,
  primaryHostRedirect,
} from "../src/lib/primary-host.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

const SUBDOMAIN = "acme.ota.example.com";
const PRIMARY = "travel.acme-example.com";
const SECONDARY = "flights.acme-example.com";

/** The storefront hosts as storefront.get names them once the custom domain is primary (FIX-W38-OTA). */
const CUSTOM_PRIMARY = Object.freeze({
  primaryUrl: `https://${PRIMARY}`,
  domains: [
    { host: SUBDOMAIN, kind: "subdomain", primary: false, verifiedAt: "2026-10-01T09:00:00Z" },
    { host: SECONDARY, kind: "custom", primary: false, verifiedAt: "2026-10-20T09:00:00Z" },
    { host: PRIMARY, kind: "custom", primary: true, verifiedAt: "2026-10-21T09:00:00Z" },
  ],
});

/** The storefront hosts while the sub-domain is primary (no custom domain, or none primary with a certificate). */
const SUBDOMAIN_PRIMARY = Object.freeze({
  primaryUrl: `https://${SUBDOMAIN}`,
  domains: [
    { host: SUBDOMAIN, kind: "subdomain", primary: true, verifiedAt: "2026-10-01T09:00:00Z" },
    { host: SECONDARY, kind: "custom", primary: false, verifiedAt: "2026-10-20T09:00:00Z" },
  ],
});

/**
 * The page address parts the rule reads, from a URL.
 * @param {string} href
 */
function at(href) {
  const { hostname, pathname, search, hash } = new URL(href);
  return { hostname, pathname, search, hash };
}

/** The configuration `storefront.get` answers for the edge, with `overrides` (environment test, sub-domain primary). */
function config(/** @type {Record<string, unknown>} */ overrides = {}) {
  return {
    tenantKey: "acme",
    name: "Acme Travel",
    legalName: "Acme Travel Ltd",
    environment: "test",
    ...SUBDOMAIN_PRIMARY,
    timeZone: "Europe/London",
    branding: {
      logoUrl: null,
      logoDarkUrl: null,
      logoSquareUrl: null,
      faviconUrl: null,
      colors: {
        primary: "#0b5d1e",
        onPrimary: "#ffffff",
        secondary: "#14213d",
        accent: "#0e7490",
        background: "#ffffff",
        surface: "#f5f7fa",
        text: "#1a1a1a",
        mutedText: "#4b5563",
        success: "#15803d",
        warning: "#b45309",
        error: "#b91c1c",
      },
      fonts: { heading: null, body: null },
      cornerRadius: "small",
      customCssUrl: null,
    },
    defaultLocale: "en-GB",
    locales: [{ code: "en-GB", name: "English (UK)", direction: "ltr" }],
    defaultCurrency: "GBP",
    currencies: [{ code: "GBP", name: "Pound sterling", symbol: "£", decimals: 2 }],
    defaultMarket: "GB",
    markets: [{ countryCode: "GB", name: "United Kingdom", currency: "GBP", locale: "en-GB" }],
    features: {
      guestCheckout: true,
      customerAccounts: true,
      savedTravelers: false,
      ancillaries: false,
      seatSelection: false,
      brandedFareUpsell: false,
      autoIssue: true,
    },
    auth: {
      emailVerification: "required_before_checkout",
      passwordPolicy: {
        minLength: 10,
        maxLength: 128,
        requireUppercase: false,
        requireLowercase: false,
        requireDigit: false,
        requireSymbol: false,
        rejectBreached: true,
      },
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
    },
    payment: {
      provider: "stripe",
      environment: "test",
      accountMode: "velexis",
      publishableKey: "pk_test_fake_storefront_fixture",
      accountId: null,
      merchantName: "Velexis on behalf of Acme Travel",
      statementDescriptor: null,
      supportedMethods: [],
      airlineCard: null,
      cardBrands: [],
      pspCardBrands: [],
      merchantCountry: "GB",
      threeDSecure: "automatic",
    },
    legal: {
      termsUrl: `https://${SUBDOMAIN}/p/terms`,
      termsVersion: "2026-10-01",
      privacyUrl: `https://${SUBDOMAIN}/p/privacy`,
      privacyVersion: "2026-10-01",
      cookiePolicyUrl: null,
      refundPolicyUrl: null,
      imprintUrl: null,
      accessibilityUrl: null,
    },
    support: {
      email: "help@acme-example.com",
      phone: null,
      hours: "",
      helpCenterUrl: null,
      emergencyPhone: null,
    },
    consent: {
      regime: "gdpr",
      bannerRequired: true,
      policyVersion: "2026-10-01",
      cookieName: "vx_consent",
      lifetimeDays: 180,
      categories: [],
    },
    seo: {
      titleTemplate: "%s | Acme Travel",
      defaultTitle: "Acme Travel",
      defaultDescription: "",
      ogImageUrl: null,
      twitterHandle: null,
      canonicalBaseUrl: `https://${SUBDOMAIN}`,
      robots: { index: false, follow: false },
    },
    version: 1,
    updatedAt: "2026-10-21T09:00:00Z",
    ...overrides,
  };
}

/**
 * A fake SDK client: `storefront.get` answers `answer`, `auth.getSession` answers a visitor (`null`).
 * @param {unknown} answer
 */
function fakeClient(answer) {
  /** @type {{ storefront: { get: import("vitest").Mock }, withOptions: import("vitest").Mock, auth: { getSession: import("vitest").Mock } }} */
  const client = {
    storefront: { get: vi.fn(async () => structuredClone(answer)) },
    withOptions: vi.fn(),
    auth: { getSession: vi.fn(async () => null) },
  };
  client.withOptions.mockImplementation(() => client);
  return client;
}

/** Waits until queued promise callbacks have run (the fake SDK answers at once). */
const settle = async () => {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
};

/** Whether `promise` has settled after the queued callbacks ran. */
async function hasSettled(/** @type {Promise<unknown>} */ promise) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await settle();
  return settled;
}

const robots = (/** @type {Document} */ doc) =>
  doc.head.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null;
const bannerShown = (/** @type {Document} */ doc) =>
  doc.querySelector('[data-slot="test-banner"]')?.hasAttribute("hidden") === false;

/** @type {Browser | undefined} */
let browser;
/** The expanded HTML of the pages these tests open, by file name. */
const pages = /** @type {Record<string, string>} */ ({});
const PAGE_FILES = ["index.html", "search.html", "account/sign-in.html", "account/sign-up.html"];

beforeAll(async () => {
  // Expands the pages with the build's include plugin and starts one happy-dom browser for the whole file.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  for (const file of PAGE_FILES) {
    pages[file] = await transform.handler(readFileSync(join(STOREFRONT_ROOT, file), "utf8"), {
      path: `/${file}`,
    });
  }
  browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
}, 15_000); // file reads and one happy-dom browser; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

/** Errors boot reported for parts of the page it skipped; none is expected. */
let reported = vi.fn();
beforeEach(() => {
  reported = vi.fn();
  vi.stubGlobal("reportError", reported);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A fresh browser page with `file` (expanded) at `href`; returns its document.
 * @param {string} file
 * @param {string} href
 */
function openPage(file, href) {
  const page = /** @type {Browser} */ (browser).newPage();
  page.url = href;
  page.content = /** @type {string} */ (pages[file]);
  return /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}

describe("primaryHostRedirect: the sign-in and sign-up pages go to the primary custom domain", () => {
  it("[OFE-021 AC1] sends sign-in and sign-up on the sub-domain to the same path on the primary host, query and fragment kept", () => {
    expect(
      primaryHostRedirect(
        CUSTOM_PRIMARY,
        at(`https://${SUBDOMAIN}/account/sign-in.html?next=%2Fbooking.html%3Fid%3Dbkg_01J&x=1#form`),
      ),
    ).toBe(`https://${PRIMARY}/account/sign-in.html?next=%2Fbooking.html%3Fid%3Dbkg_01J&x=1#form`);
    expect(primaryHostRedirect(CUSTOM_PRIMARY, at(`https://${SUBDOMAIN}/account/sign-up.html`))).toBe(
      `https://${PRIMARY}/account/sign-up.html`,
    );
    // The same pages without `.html`, which Caddy's try_files serves too.
    expect(primaryHostRedirect(CUSTOM_PRIMARY, at(`https://${SUBDOMAIN}/account/sign-in?next=%2F`))).toBe(
      `https://${PRIMARY}/account/sign-in?next=%2F`,
    );
    expect(primaryHostRedirect(CUSTOM_PRIMARY, at(`https://${SUBDOMAIN}/account/sign-up`))).toBe(
      `https://${PRIMARY}/account/sign-up`,
    );
    // The fully qualified spelling of the sub-domain is the sub-domain.
    expect(primaryHostRedirect(CUSTOM_PRIMARY, at(`https://${SUBDOMAIN}./account/sign-in.html`))).toBe(
      `https://${PRIMARY}/account/sign-in.html`,
    );
  });

  it("[OFE-021 AC1] redirects only the authentication pages that create a session; every other page works on both hosts", () => {
    expect(AUTH_PAGE_PATHS).toEqual([
      "/account/sign-in.html",
      "/account/sign-in",
      "/account/sign-up.html",
      "/account/sign-up",
    ]);
    for (const path of [
      "/",
      "/index.html",
      "/search.html?from=LHR&to=CDG&depart=2027-03-01",
      "/offer.html?offer=off_01J",
      "/price.html?priced=prc_01J",
      "/checkout.html?id=chk_01J",
      "/checkout/pay-card.html?id=chk_01J&payment=pay_01J",
      "/confirmation.html?booking=bkg_01J",
      "/bookings.html",
      "/booking.html?id=bkg_01J",
      "/lookup.html",
      "/p/terms",
      "/404.html",
      "/account/",
      "/account/index.html",
      "/account/verify.html",
      "/account/forgot-password.html",
      "/account/reset-password.html",
      // Look-alikes of the authentication pages are not them.
      "/account/sign-in.html/",
      "/account/sign-in.htm",
      "/ACCOUNT/SIGN-IN.HTML",
      "/account/sign-in.html.evil",
      "/x/account/sign-in.html",
      "//account/sign-in.html",
    ]) {
      expect(primaryHostRedirect(CUSTOM_PRIMARY, at(`https://${SUBDOMAIN}${path}`)), path).toBeNull();
    }
    expect(isAuthPage("/account/sign-up.html")).toBe(true);
    expect(isAuthPage(undefined)).toBe(false);
  });

  it("[OFE-021 AC1] redirects only from the OTA's sub-domain: never from the primary host, another custom domain or an unlisted host", () => {
    for (const host of [PRIMARY, SECONDARY, "localhost", "127.0.0.1", "evil.example", `x.${SUBDOMAIN}`]) {
      expect(
        primaryHostRedirect(CUSTOM_PRIMARY, at(`https://${host}/account/sign-in.html`)),
        host,
      ).toBeNull();
    }
    // The dev server and `vite preview` run on a port of localhost, which the configuration never lists.
    expect(primaryHostRedirect(CUSTOM_PRIMARY, at("http://localhost:5173/account/sign-in.html"))).toBeNull();
  });

  it("[OFE-021 AC1] does nothing while the sub-domain is primary", () => {
    expect(primaryCustomHost(SUBDOMAIN_PRIMARY)).toBeNull();
    expect(
      primaryHostRedirect(SUBDOMAIN_PRIMARY, at(`https://${SUBDOMAIN}/account/sign-in.html`)),
    ).toBeNull();
    expect(
      primaryHostRedirect(SUBDOMAIN_PRIMARY, at(`https://${SECONDARY}/account/sign-up.html`)),
    ).toBeNull();
  });

  it("[OFE-021 AC1] goes only to the configured primary host: an inconsistent configuration is no redirect", () => {
    const subdomain = {
      host: SUBDOMAIN,
      kind: "subdomain",
      primary: false,
      verifiedAt: "2026-10-01T09:00:00Z",
    };
    /** @param {string} host @param {Record<string, unknown>} [entry] */
    const custom = (host, entry = {}) => ({
      host,
      kind: "custom",
      primary: true,
      verifiedAt: "2026-10-21T09:00:00Z",
      ...entry,
    });
    const page = at(`https://${SUBDOMAIN}/account/sign-in.html`);
    expect(primaryCustomHost(CUSTOM_PRIMARY)).toBe(PRIMARY);
    // `primaryUrl` with the final slash names the same host.
    expect(
      primaryHostRedirect({ primaryUrl: `https://${PRIMARY}/`, domains: [subdomain, custom(PRIMARY)] }, page),
    ).toBe(`https://${PRIMARY}/account/sign-in.html`);

    const inconsistent = {
      "primaryUrl names another host": {
        primaryUrl: "https://evil.example",
        domains: [subdomain, custom(PRIMARY)],
      },
      "domains marks another host than primaryUrl": {
        primaryUrl: `https://${PRIMARY}`,
        domains: [subdomain, custom("evil.example")],
      },
      "primaryUrl over http": { primaryUrl: `http://${PRIMARY}`, domains: [subdomain, custom(PRIMARY)] },
      "primaryUrl with a port": {
        primaryUrl: `https://${PRIMARY}:8443`,
        domains: [subdomain, custom(PRIMARY)],
      },
      "primaryUrl with credentials": {
        primaryUrl: `https://user:secret@${PRIMARY}`,
        domains: [subdomain, custom(PRIMARY)],
      },
      "primaryUrl with a path": {
        primaryUrl: `https://${PRIMARY}/shop`,
        domains: [subdomain, custom(PRIMARY)],
      },
      "primaryUrl with a query": {
        primaryUrl: `https://${PRIMARY}/?a=b`,
        domains: [subdomain, custom(PRIMARY)],
      },
      "primaryUrl missing": { domains: [subdomain, custom(PRIMARY)] },
      "primaryUrl not a URL": { primaryUrl: "travel", domains: [subdomain, custom(PRIMARY)] },
      "two domains marked primary": {
        primaryUrl: `https://${PRIMARY}`,
        domains: [subdomain, custom(PRIMARY), custom(SECONDARY)],
      },
      "the primary entry is not a custom domain": {
        primaryUrl: `https://${PRIMARY}`,
        domains: [subdomain, custom(PRIMARY, { kind: "subdomain" })],
      },
      "a host name in upper case": {
        primaryUrl: `https://${PRIMARY}`,
        domains: [subdomain, custom(PRIMARY.toUpperCase())],
      },
      "a host name with a port": {
        primaryUrl: `https://${PRIMARY}`,
        domains: [subdomain, custom(`${PRIMARY}:443`)],
      },
      "a host name with a path": {
        primaryUrl: `https://${PRIMARY}`,
        domains: [subdomain, custom(`${PRIMARY}/account`)],
      },
      "a host name with credentials": {
        primaryUrl: `https://${PRIMARY}`,
        domains: [subdomain, custom(`evil.example@${PRIMARY}`)],
      },
      "an empty host name": { primaryUrl: `https://${PRIMARY}`, domains: [subdomain, custom("")] },
      "a host name that is no string": {
        primaryUrl: `https://${PRIMARY}`,
        domains: [subdomain, custom(PRIMARY, { host: 42 })],
      },
      "no domains": { primaryUrl: `https://${PRIMARY}`, domains: "travel.acme-example.com" },
      "no sub-domain listed": { primaryUrl: `https://${PRIMARY}`, domains: [custom(PRIMARY)] },
    };
    for (const [name, hosts] of Object.entries(inconsistent)) {
      expect(primaryHostRedirect(hosts, page), name).toBeNull();
    }
    expect(primaryCustomHost({ primaryUrl: `https://${PRIMARY}`, domains: [null, 7, custom(PRIMARY)] })).toBe(
      PRIMARY,
    );
  });

  it("[OFE-021 AC1] nothing in the address chooses the target: the query and `next` never change its origin", () => {
    for (const query of [
      "?next=https%3A%2F%2Fevil.example%2F",
      "?next=//evil.example",
      "?@evil.example",
      "?next=%2F%2Fevil.example%2F",
    ]) {
      const target = primaryHostRedirect(
        CUSTOM_PRIMARY,
        at(`https://${SUBDOMAIN}/account/sign-in.html${query}`),
      );
      expect(target, query).not.toBeNull();
      const url = new URL(/** @type {string} */ (target));
      expect(url.origin, query).toBe(`https://${PRIMARY}`);
      expect(url.pathname, query).toBe("/account/sign-in.html");
      expect(url.search, query).toBe(new URL(`https://${SUBDOMAIN}/account/sign-in.html${query}`).search);
    }
  });
});

describe("boot on the sign-in and sign-up pages", () => {
  it("[OFE-021 AC1] on the sub-domain: goes to the primary host before a session is asked or the page module runs", async () => {
    for (const file of ["account/sign-in.html", "account/sign-up.html"]) {
      const doc = openPage(file, `https://${SUBDOMAIN}/${file}?next=%2Fbookings.html`);
      const client = fakeClient(config({ ...CUSTOM_PRIMARY, environment: "live" }));
      const navigate = vi.fn();

      const started = boot({ client, storage: null, preferences: null, doc, navigate });

      expect(await hasSettled(started), file).toBe(false);
      expect(navigate, file).toHaveBeenCalledTimes(1);
      expect(navigate, file).toHaveBeenCalledWith(`https://${PRIMARY}/${file}?next=%2Fbookings.html`);
      // No session on the sub-domain: not even the account menu's auth.getSession, and the form cannot be used.
      expect(client.auth.getSession, file).not.toHaveBeenCalled();
      expect(client.storefront.get, file).toHaveBeenCalledTimes(1);
      const main = /** @type {HTMLElement} */ (doc.querySelector("main"));
      expect(main.hasAttribute("inert"), file).toBe(true);
      expect(main.getAttribute("aria-busy"), file).toBe("true");
    }
    expect(reported).not.toHaveBeenCalled();
  });

  it("[OFE-021 AC1] leaves with location.replace, so the sub-domain's page does not stay in the history", async () => {
    const href = `https://${SUBDOMAIN}/account/sign-up.html?next=%2Fbookings.html`;
    const doc = openPage("account/sign-up.html", href);
    const location = /** @type {Location} */ (doc.defaultView?.location);
    // The page's own navigation, kept from leaving the test page: replace() is the only way out boot may take.
    const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    const client = fakeClient(config({ ...CUSTOM_PRIMARY }));

    const started = boot({ client, storage: null, preferences: null, doc });

    expect(await hasSettled(started)).toBe(false);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`https://${PRIMARY}/account/sign-up.html?next=%2Fbookings.html`);
    expect(assign).not.toHaveBeenCalled();
    expect(location.href).toBe(href);
    expect(client.auth.getSession).not.toHaveBeenCalled();
    expect(reported).not.toHaveBeenCalled();
  });

  it("[OFE-021 AC1] on the primary host, and while the sub-domain is primary, the page starts as usual", async () => {
    const cases = [
      { href: `https://${PRIMARY}/account/sign-in.html?next=%2Fbookings.html`, hosts: CUSTOM_PRIMARY },
      { href: `https://${SUBDOMAIN}/account/sign-in.html`, hosts: SUBDOMAIN_PRIMARY },
      { href: `https://${SECONDARY}/account/sign-up.html`, hosts: CUSTOM_PRIMARY },
    ];
    for (const { href, hosts } of cases) {
      const file = new URL(href).pathname.slice(1);
      const doc = openPage(file, href);
      const client = fakeClient(config({ ...hosts, environment: "live" }));
      const navigate = vi.fn();

      const context = await boot({ client, storage: null, preferences: null, doc, navigate });

      expect(context.config.primaryUrl, href).toBe(hosts.primaryUrl);
      expect(navigate, href).not.toHaveBeenCalled();
      expect(client.auth.getSession, href).toHaveBeenCalledTimes(1);
      expect(doc.querySelector("main")?.hasAttribute("inert"), href).toBe(false);
    }
    expect(reported).not.toHaveBeenCalled();
  });

  it("[OFE-021 AC1] other pages on the sub-domain keep working while a custom domain is primary", async () => {
    for (const file of ["index.html", "search.html"]) {
      const doc = openPage(file, `https://${SUBDOMAIN}/${file}`);
      const client = fakeClient(config({ ...CUSTOM_PRIMARY, environment: "live" }));
      const navigate = vi.fn();

      await boot({ client, storage: null, preferences: null, doc, navigate });

      expect(navigate, file).not.toHaveBeenCalled();
      expect(client.auth.getSession, file).toHaveBeenCalledTimes(1);
    }
  });

  it("[OFE-021 AC1] a navigation the browser refuses is reported and the page starts where it is", async () => {
    const doc = openPage("account/sign-in.html", `https://${SUBDOMAIN}/account/sign-in.html`);
    const client = fakeClient(config({ ...CUSTOM_PRIMARY, environment: "live" }));
    const refused = new Error("navigation blocked");
    const navigate = vi.fn(() => {
      throw refused;
    });

    const context = await boot({ client, storage: null, preferences: null, doc, navigate });

    expect(navigate).toHaveBeenCalledWith(`https://${PRIMARY}/account/sign-in.html`);
    expect(reported).toHaveBeenCalledWith(refused);
    expect(context.config.primaryUrl).toBe(`https://${PRIMARY}`);
    const main = /** @type {HTMLElement} */ (doc.querySelector("main"));
    expect(main.hasAttribute("inert")).toBe(false);
    expect(main.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("boot: live versus test", () => {
  it("[OFE-021 AC1] environment = live shows no test banner and no noindex; test shows both", async () => {
    const live = openPage("index.html", `https://${PRIMARY}/`);
    await boot({
      client: fakeClient(config({ ...CUSTOM_PRIMARY, environment: "live" })),
      storage: null,
      preferences: null,
      doc: live,
    });
    expect(bannerShown(live)).toBe(false);
    expect(live.head.querySelector('meta[name="robots"]')).toBeNull();

    const test = openPage("index.html", `https://${SUBDOMAIN}/`);
    await boot({ client: fakeClient(config()), storage: null, preferences: null, doc: test });
    expect(bannerShown(test)).toBe(true);
    expect(robots(test)).toBe("noindex");
    expect(reported).not.toHaveBeenCalled();
  });

  it("[OFE-021 AC1] a page's own robots meta stays in live; test adds noindex to it once", async () => {
    // search.html is kept out of search engines in both environments by its own HTML.
    const live = openPage("search.html", `https://${PRIMARY}/search.html`);
    await boot({
      client: fakeClient(config({ ...CUSTOM_PRIMARY, environment: "live" })),
      storage: null,
      preferences: null,
      doc: live,
    });
    expect(robots(live)).toBe("noindex");
    expect(bannerShown(live)).toBe(false);

    const test = openPage("search.html", `https://${SUBDOMAIN}/search.html`);
    await boot({ client: fakeClient(config()), storage: null, preferences: null, doc: test });
    expect(test.head.querySelectorAll('meta[name="robots"]').length).toBe(1);
    expect(robots(test)).toBe("noindex");
    expect(bannerShown(test)).toBe(true);
  });

  it("[OFE-021 AC1] an environment this build does not know is shown as test", async () => {
    for (const environment of [undefined, "", "production", "LIVE"]) {
      const doc = openPage("index.html", `https://${SUBDOMAIN}/`);
      await boot({
        client: fakeClient(config({ environment })),
        storage: null,
        preferences: null,
        doc,
      });
      expect(bannerShown(doc), String(environment)).toBe(true);
      expect(robots(doc), String(environment)).toBe("noindex");
    }
  });

  it("[OFE-021 AC1] live removes the test banner and the noindex that test added, and gives the page's own robots meta back", () => {
    const index = openPage("index.html", `https://${SUBDOMAIN}/`);
    applyEnvironment(index, "test");
    applyEnvironment(index, "test");
    expect(bannerShown(index)).toBe(true);
    expect(index.head.querySelectorAll('meta[name="robots"]').length).toBe(1);
    expect(robots(index)).toBe("noindex");

    applyEnvironment(index, "live");
    expect(bannerShown(index)).toBe(false);
    expect(index.head.querySelector('meta[name="robots"]')).toBeNull();

    // A page with its own directives: test puts noindex first, live restores them as they were.
    const signIn = openPage("account/sign-in.html", `https://${SUBDOMAIN}/account/sign-in.html`);
    const own = /** @type {HTMLMetaElement} */ (signIn.head.querySelector('meta[name="robots"]'));
    own.content = "index, max-image-preview:large";
    applyEnvironment(signIn, "test");
    expect(robots(signIn)).toBe("noindex, max-image-preview:large");
    applyEnvironment(signIn, "live");
    expect(signIn.head.querySelectorAll('meta[name="robots"]').length).toBe(1);
    expect(robots(signIn)).toBe("index, max-image-preview:large");
    expect(own.attributes.length).toBe(2);

    // A page whose own HTML says noindex keeps it in live.
    const signUp = openPage("account/sign-up.html", `https://${SUBDOMAIN}/account/sign-up.html`);
    applyEnvironment(signUp, "test");
    applyEnvironment(signUp, "live");
    expect(robots(signUp)).toBe("noindex");
  });
});
