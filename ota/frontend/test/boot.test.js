// src/boot.js and its components (ota/frontend/README.md §5.1, docs/pages.md §2, docs/pages-account.md §8): the shared
// start-up of every page against a fake SDK, on the real pages (index.html and 404.html with their partials, expanded
// by the build's own include plugin and loaded into a happy-dom browser page). It covers the full-page states of a
// failed storefront.get, the theme, header, footer, test banner, currency selector and session, and that pages include
// the partials boot needs.
import {
  AuthenticationError,
  ConnectionError,
  PermissionError,
  RateLimitError,
  ServerError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { htmlInputs, includePartials } from "../scripts/vite-plugins.js";
import { CURRENCY_CHANGE_EVENT, CURRENCY_STORAGE_KEY, boot, renderState } from "../src/boot.js";
import { mount as mountLiveRegion } from "../src/components/live-region.js";
import { NEUTRAL_PALETTE } from "../src/lib/theme.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

const ORIGIN = "https://demo.ota.example.com";

/** The configuration `storefront.get` answers for the edge (same-origin asset paths), test environment. */
const CONFIG = Object.freeze({
  tenantKey: "demo",
  name: "Demo Travel",
  legalName: "Demo Travel Ltd",
  environment: "test",
  primaryUrl: `${ORIGIN}/`,
  domains: [
    { host: "demo.ota.example.com", kind: "subdomain", primary: true, verifiedAt: "2026-10-01T09:00:00Z" },
  ],
  timeZone: "Europe/London",
  branding: {
    logoUrl: "/api/v1/assets/demo/ast_01JLOGO.png",
    logoDarkUrl: "/api/v1/assets/demo/ast_01JLOGODARK.png",
    logoSquareUrl: null,
    faviconUrl: "/api/v1/assets/demo/ast_01JFAVICON.png",
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
    fonts: {
      heading: {
        family: "Montserrat",
        cssUrl: "https://fonts.googleapis.com/css2?family=Montserrat",
        weights: [400, 700],
      },
      body: {
        family: "Inter",
        cssUrl: "https://fonts.googleapis.com/css2?family=Inter",
        weights: [400, 700],
      },
    },
    cornerRadius: "small",
    customCssUrl: null,
  },
  defaultLocale: "en-GB",
  locales: [{ code: "en-GB", name: "English (UK)", direction: "ltr" }],
  defaultCurrency: "GBP",
  currencies: [
    { code: "GBP", name: "Pound sterling", symbol: "£", decimals: 2 },
    { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
    { code: "CHF", name: "Swiss franc", symbol: "CHF", decimals: 2 },
  ],
  defaultMarket: "GB",
  markets: [{ countryCode: "GB", name: "United Kingdom", currency: "GBP", locale: "en-GB" }],
  features: {
    guestCheckout: true,
    customerAccounts: true,
    savedTravelers: false,
    ancillaries: true,
    seatSelection: false,
    brandedFareUpsell: true,
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
    merchantName: "Velexis on behalf of Demo Travel",
    statementDescriptor: null,
    supportedMethods: [],
    airlineCard: null,
    cardBrands: [],
    pspCardBrands: [],
    merchantCountry: "GB",
    threeDSecure: "automatic",
  },
  legal: {
    termsUrl: `${ORIGIN}/p/terms`,
    termsVersion: "2026-10-01",
    privacyUrl: `${ORIGIN}/p/privacy`,
    privacyVersion: "2026-10-01",
    cookiePolicyUrl: `${ORIGIN}/p/cookies`,
    refundPolicyUrl: "javascript:alert(1)",
    imprintUrl: null,
    accessibilityUrl: "https://accessibility.demo-travel.example/statement",
  },
  support: {
    email: "help@demo-travel.example",
    phone: "+44 20 7123 4567",
    hours: "Mon–Fri 09:00–17:00",
    helpCenterUrl: null,
    emergencyPhone: null,
  },
  consent: {
    regime: "gdpr",
    bannerRequired: true,
    policyVersion: "2026-10-01",
    cookieName: "vx_consent",
    lifetimeDays: 180,
    categories: [
      {
        id: "necessary",
        required: true,
        defaultEnabled: true,
        title: "Strictly necessary",
        description: "Sign-in, checkout and security cookies.",
      },
    ],
  },
  seo: {
    titleTemplate: "%s | Demo Travel",
    defaultTitle: "Demo Travel",
    defaultDescription: "Flights with Demo Travel.",
    ogImageUrl: null,
    twitterHandle: null,
    canonicalBaseUrl: `${ORIGIN}/`,
    robots: { index: false, follow: false },
  },
  version: 3,
  updatedAt: "2026-10-12T08:00:00Z",
});

/** A customer session as `auth.getSession` answers it. */
const SESSION = Object.freeze({
  customer: { id: "cus_01J", email: "ada@example.com", firstName: "Ada", lastName: "Lovelace" },
  session: { id: "ses_01J", rememberMe: false, authMethod: "password" },
});

/**
 * An SDK error as the SDK builds it from the API's error envelope.
 * @param {new (init: object, options?: object) => Error} ErrorClass
 */
const sdkError = (ErrorClass, code = "", status = 0, options = {}) =>
  new ErrorClass({ code, message: `${code} from the API`, status, requestId: "req_ofe003" }, options);

/**
 * The fake SDK client of these tests; `derivedWith` holds the options of a client made by `withOptions`.
 * @typedef {object} FakeClient
 * @property {{ get: import("vitest").Mock }} storefront
 * @property {import("vitest").Mock} withOptions
 * @property {{ getSession: import("vitest").Mock }} [auth]
 * @property {object} [derivedWith]
 */

/**
 * A fake SDK client: `storefront.get` answers `answers` in turn (an Error is thrown, the last answer repeats), and
 * `withOptions` records the options of each derived client.
 * @param {unknown[]} answers
 * @param {{ getSession?: () => Promise<unknown> }} [auth] the `auth` namespace (SDK-008), absent by default
 * @returns {FakeClient}
 */
function fakeClient(answers, auth) {
  const queue = [...answers];
  const get = vi.fn(async () => {
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer instanceof Error) {
      throw answer;
    }
    return structuredClone(answer);
  });
  /** @type {FakeClient} */
  const client = { storefront: { get }, withOptions: vi.fn() };
  client.withOptions.mockImplementation((/** @type {object} */ options) => ({
    ...client,
    derivedWith: options,
  }));
  if (auth) {
    client.auth = { getSession: vi.fn(auth.getSession) };
  }
  return client;
}

/** An in-memory localStorage. */
function memoryStorage(/** @type {Record<string, string>} */ initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (/** @type {string} */ key) => (items.has(key) ? items.get(key) : null),
    setItem: (/** @type {string} */ key, /** @type {string} */ value) => void items.set(key, value),
  };
}

/** @type {Browser | undefined} */
let browser;
/** The expanded HTML of each page, by file name. */
const pages = /** @type {Record<string, string>} */ ({});
/** Every page of the package, by file name relative to the package (index.html, 404.html, …). */
let pageFiles = /** @type {string[]} */ ([]);

beforeAll(async () => {
  // Expands the pages with the build's include plugin and starts one happy-dom browser for the whole file.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  pageFiles = Object.values(htmlInputs(STOREFRONT_ROOT)).map((file) => relative(STOREFRONT_ROOT, file));
  for (const file of pageFiles) {
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

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A fresh browser page with `file` (expanded) at `path` on the demo storefront; returns its document.
 * @param {string} [file]
 * @param {string} [path]
 */
function openPage(file = "index.html", path = "/") {
  const page = /** @type {Browser} */ (browser).newPage();
  page.url = `${ORIGIN}${path}`;
  page.content = /** @type {string} */ (pages[file]);
  return /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
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

const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim();
const mainHeading = (/** @type {Document} */ doc) => text(doc.querySelector("main h1"));
const robots = (/** @type {Document} */ doc) =>
  doc.head.querySelector('meta[name="robots"]')?.getAttribute("content");

describe("boot: full-page states of storefront.get", () => {
  it("[OFE-003 AC2] 403 TENANT_SUSPENDED renders the 'temporarily unavailable' page and the page module never runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const doc = openPage();
    const client = fakeClient([sdkError(PermissionError, "TENANT_SUSPENDED", 403)], {
      getSession: async () => SESSION,
    });

    const started = boot({ client, storage: null, preferences: memoryStorage(), doc });

    expect(await hasSettled(started)).toBe(false);
    // Not later either: no timer resolves boot or asks the API again.
    vi.runAllTimers();
    expect(await hasSettled(started)).toBe(false);
    expect(mainHeading(doc)).toBe("This travel site is temporarily unavailable");
    expect(text(doc.querySelector("main [data-state] p"))).toBe("Please come back later.");
    expect(doc.querySelector("main [data-state]")?.getAttribute("data-state")).toBe("suspended");
    expect(doc.title).toBe("This travel site is temporarily unavailable");
    // The page content is gone, there is nothing to retry, and the storefront is kept out of search engines.
    expect(doc.body.textContent).not.toContain("Search flights");
    expect(doc.querySelector('main [data-action="retry"]')).toBeNull();
    expect(robots(doc)).toBe("noindex");
    // Header and footer navigation lead nowhere on a suspended storefront.
    expect(doc.querySelector("body > header nav")?.hasAttribute("hidden")).toBe(true);
    expect(doc.querySelector("body > footer nav")?.hasAttribute("hidden")).toBe(true);
    // No support address is known without the configuration; no session was asked for.
    expect(doc.querySelector("main a[href^='mailto:']")).toBeNull();
    expect(client.auth?.getSession).not.toHaveBeenCalled();
    expect(client.storefront.get).toHaveBeenCalledTimes(1);
  });

  it("[OFE-003 AC2] 403 HOST_NOT_ALLOWED renders 'this storefront does not exist'", async () => {
    const doc = openPage();
    const client = fakeClient([sdkError(PermissionError, "HOST_NOT_ALLOWED", 403)]);

    const started = boot({ client, storage: null, preferences: memoryStorage(), doc });

    expect(await hasSettled(started)).toBe(false);
    expect(mainHeading(doc)).toBe("This storefront does not exist");
    expect(doc.querySelector("main [data-state]")?.getAttribute("data-state")).toBe("unknown-host");
    expect(text(doc.querySelector("main [data-state] p"))).toMatch(/^Check the address in your browser/);
    expect(doc.querySelector('main [data-action="retry"]')).toBeNull();
    expect(robots(doc)).toBe("noindex");
    // Header branding from a configuration never applied.
    expect(text(doc.querySelector('body > header a[data-field="brandName"]'))).toBe("Flights");
    expect(doc.querySelector('[data-slot="test-banner"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("[OFE-003 AC2] keeps the 404 page's own noindex and renders the states there too", async () => {
    const doc = openPage("404.html", "/no/such/page");
    const started = boot({
      client: fakeClient([sdkError(PermissionError, "HOST_NOT_ALLOWED", 403)]),
      storage: null,
      preferences: memoryStorage(),
      doc,
    });

    expect(await hasSettled(started)).toBe(false);
    expect(mainHeading(doc)).toBe("This storefront does not exist");
    expect(doc.head.querySelectorAll('meta[name="robots"]').length).toBe(1);
    expect(robots(doc)).toBe("noindex");
  });

  it("[OFE-003] 503 SERVICE_UNAVAILABLE shows Retry; a successful retry puts the page back and boot carries on", async () => {
    const doc = openPage();
    const client = fakeClient([sdkError(ServerError, "SERVICE_UNAVAILABLE", 503), CONFIG]);
    const main = /** @type {HTMLElement} */ (doc.querySelector("main"));
    const original = Array.from(main.childNodes);

    const started = boot({ client, storage: null, preferences: memoryStorage(), doc });
    expect(await hasSettled(started)).toBe(false);
    expect(mainHeading(doc)).toBe(
      "The service is not available right now. Nothing is lost: try again in a moment.",
    );
    const retry = /** @type {HTMLButtonElement} */ (doc.querySelector('main [data-action="retry"]'));
    expect(text(retry)).toBe("Try again");
    expect(retry.disabled).toBe(false);
    expect(retry.closest("[hidden]")).toBeNull();

    retry.click();
    const context = await started;

    expect(client.storefront.get).toHaveBeenCalledTimes(2);
    expect(context.config).toEqual(CONFIG);
    // The very same nodes are back (nothing typed into the page is lost) and the page is no longer a state.
    expect(Array.from(main.childNodes)).toEqual(original);
    expect(mainHeading(doc)).toBe("Search flights");
    expect(doc.body.dataset.pageState).toBeUndefined();
    expect(doc.title).toBe("Search flights");
    expect(doc.querySelector("body > header nav")?.hasAttribute("hidden")).toBe(false);
    expect(doc.activeElement).toBe(main);
  });

  it("[OFE-003] a connection failure that fails again on Retry stays on the state with the focus on its title", async () => {
    const doc = openPage();
    const client = fakeClient([
      sdkError(ConnectionError, "NETWORK_ERROR", 0),
      sdkError(ConnectionError, "TIMEOUT", 0),
      CONFIG,
    ]);

    const started = boot({ client, storage: null, preferences: memoryStorage(), doc });
    await settle();
    /** @type {HTMLButtonElement} */ (doc.querySelector('main [data-action="retry"]')).click();
    await settle();

    expect(mainHeading(doc)).toMatch(/^The service is not available right now/);
    expect(doc.activeElement).toBe(doc.querySelector("main h1"));
    /** @type {HTMLButtonElement} */ (doc.querySelector('main [data-action="retry"]')).click();
    await expect(started).resolves.toMatchObject({ config: CONFIG });
    expect(client.storefront.get).toHaveBeenCalledTimes(3);
  });

  it("[OFE-003] 429 RATE_LIMITED enables Retry only after Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const doc = openPage();
    const client = fakeClient([
      sdkError(RateLimitError, "RATE_LIMITED", 429, { retryAfterSeconds: 7 }),
      CONFIG,
    ]);

    const started = boot({ client, storage: null, preferences: memoryStorage(), doc });
    await settle();
    expect(mainHeading(doc)).toBe("Busy, try again in a few seconds");
    const retry = /** @type {HTMLButtonElement} */ (doc.querySelector('main [data-action="retry"]'));
    expect(retry.disabled).toBe(true);
    retry.click();
    await settle();
    expect(client.storefront.get).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6_999);
    expect(retry.disabled).toBe(true);
    vi.advanceTimersByTime(1);
    expect(retry.disabled).toBe(false);
    retry.click();
    await expect(started).resolves.toMatchObject({ config: CONFIG });
  });

  it("[OFE-003] any other error is 'Something went wrong' with the request id for support and Retry", async () => {
    const doc = openPage();
    const client = fakeClient([sdkError(ServerError, "INTERNAL_ERROR", 500), CONFIG]);

    const started = boot({ client, storage: null, preferences: memoryStorage(), doc });
    await settle();

    expect(mainHeading(doc)).toBe("Something went wrong. Please try again.");
    expect(text(doc.querySelector("main .font-mono"))).toBe("req_ofe003");
    expect(doc.querySelector("main .font-mono")?.closest("[hidden]")).toBeNull();
    /** @type {HTMLButtonElement} */ (doc.querySelector('main [data-action="retry"]')).click();
    await expect(started).resolves.toMatchObject({ config: CONFIG });
  });
});

describe("renderState", () => {
  it("[OFE-003] renders the shared states inline, with a real support address and without the placeholder", () => {
    const doc = openPage();
    const box = doc.createElement("div");
    doc.querySelector("main")?.append(box);
    const support = { email: "help@demo-travel.example", phone: null, hours: "" };

    const suspended = renderState(
      box,
      { name: "suspended", scope: "page", message: "This travel site is temporarily unavailable" },
      { scope: "inline", support },
    );
    expect(text(suspended.querySelector('[data-field="title"]'))).toBe(
      "This travel site is temporarily unavailable",
    );
    const mail = /** @type {HTMLAnchorElement} */ (suspended.querySelector("a"));
    expect(mail.getAttribute("href")).toBe("mailto:help@demo-travel.example");
    expect(text(mail)).toBe("help@demo-travel.example");
    expect(mail.closest("[hidden]")).toBeNull();

    const notConfigured = renderState(
      box,
      { name: "supplier-not-configured", scope: "inline", message: "Flight search is not available yet" },
      { support: { email: "support@demo.invalid" } },
    );
    expect(box.children.length).toBe(1);
    expect(text(notConfigured.querySelector('[data-field="hint"]'))).toBe(
      "This travel site is still being set up. Please come back later.",
    );
    expect(notConfigured.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(notConfigured.querySelector('[data-action="retry"]')).toBeNull();
  });
});

describe("boot: theme, header, footer, banner and session", () => {
  it("[OFE-003] applies the theme, brands the header and fills the footer", async () => {
    const doc = openPage();
    const { config, session, client } = await boot({
      client: fakeClient([CONFIG]),
      storage: null,
      preferences: memoryStorage(),
      doc,
    });

    expect(config).toEqual(CONFIG);
    expect(session).toBeNull();
    expect(client.withOptions).not.toHaveBeenCalled();
    const style = doc.documentElement.style;
    expect(style.getPropertyValue("--vx-primary")).toBe("#0b5d1e");
    expect(style.getPropertyValue("--vx-panel")).toBe("#f5f7fa");
    expect(style.getPropertyValue("--vx-radius")).toBe("0.25rem");
    expect(style.getPropertyValue("--vx-font-heading")).toBe('"Montserrat", system-ui, sans-serif');
    expect(doc.head.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe(CONFIG.branding.faviconUrl);
    expect(doc.head.querySelectorAll("style").length).toBe(0);

    // Header: the name with the dark-background logo (the header colour #14213d is dark).
    const brand = /** @type {HTMLAnchorElement} */ (
      doc.querySelector('body > header a[data-field="brandName"]')
    );
    expect(text(brand)).toBe("Demo Travel");
    expect(brand.querySelector("img")?.getAttribute("src")).toBe(CONFIG.branding.logoDarkUrl);
    expect(brand.querySelector("img")?.getAttribute("alt")).toBe("");

    // Footer: legal links with checked URLs (the javascript: one is dropped), then the support contacts.
    const links = Array.from(doc.querySelectorAll('body > footer [data-slot="footer-links"] a'), (a) => [
      text(a),
      a.getAttribute("href"),
      a.getAttribute("rel"),
    ]);
    expect(links).toEqual([
      ["Find a booking", "/lookup.html", null],
      ["Terms and conditions", `${ORIGIN}/p/terms`, null],
      ["Privacy policy", `${ORIGIN}/p/privacy`, null],
      ["Cookie policy", `${ORIGIN}/p/cookies`, null],
      ["Accessibility", "https://accessibility.demo-travel.example/statement", "noopener noreferrer"],
      ["help@demo-travel.example", "mailto:help@demo-travel.example", null],
      ["+44 20 7123 4567", "tel:+442071234567", null],
    ]);
    const support = doc.querySelector('body > footer [data-slot="support"]');
    expect(support?.hasAttribute("hidden")).toBe(false);
    expect(text(support)).toBe("Support: help@demo-travel.example, +44 20 7123 4567 (Mon–Fri 09:00–17:00)");
  });

  it("[OFE-003 AC1] falls back to the neutral palette for a low-contrast primary colour at boot", async () => {
    const doc = openPage();
    const lowContrast = {
      ...CONFIG,
      branding: { ...CONFIG.branding, colors: { ...CONFIG.branding.colors, primary: "#facc15" } },
    };
    await boot({ client: fakeClient([lowContrast]), storage: null, preferences: memoryStorage(), doc });

    expect(doc.documentElement.style.getPropertyValue("--vx-primary")).toBe(NEUTRAL_PALETTE.primary);
    expect(doc.documentElement.style.getPropertyValue("--vx-secondary")).toBe(NEUTRAL_PALETTE.secondary);
    expect(doc.documentElement.style.getPropertyValue("--vx-panel")).toBe(NEUTRAL_PALETTE.surface);
  });

  it("[OFE-003] shows the test banner and noindex for environment = test only", async () => {
    const test = openPage();
    await boot({ client: fakeClient([CONFIG]), storage: null, preferences: memoryStorage(), doc: test });
    const banner = test.querySelector('[data-slot="test-banner"]');
    expect(banner?.hasAttribute("hidden")).toBe(false);
    expect(text(banner)).toBe("Test mode: no real bookings or payments");
    expect(robots(test)).toBe("noindex");

    const live = openPage();
    await boot({
      client: fakeClient([{ ...CONFIG, environment: "live" }]),
      storage: null,
      preferences: memoryStorage(),
      doc: live,
    });
    expect(live.querySelector('[data-slot="test-banner"]')?.hasAttribute("hidden")).toBe(true);
    expect(live.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it("[OFE-003] hides the support contacts when only the API's .invalid placeholder address is known", async () => {
    const doc = openPage();
    const placeholder = {
      ...CONFIG,
      support: { email: "support@demo.invalid", phone: null, hours: "", helpCenterUrl: null },
    };
    await boot({ client: fakeClient([placeholder]), storage: null, preferences: memoryStorage(), doc });

    const support = doc.querySelector('body > footer [data-slot="support"]');
    expect(support?.hasAttribute("hidden")).toBe(true);
    expect(doc.body.textContent).not.toContain("demo.invalid");
  });

  it("[OFE-003] offers config.currencies, sends the remembered one with withOptions and keeps a new choice", async () => {
    const doc = openPage();
    const preferences = memoryStorage({ [CURRENCY_STORAGE_KEY]: "EUR" });
    const sdk = fakeClient([CONFIG]);

    const { client } = await boot({ client: sdk, storage: null, preferences, doc });

    expect(sdk.withOptions).toHaveBeenCalledWith({ currency: "EUR" });
    expect(/** @type {FakeClient} */ (/** @type {unknown} */ (client)).derivedWith).toEqual({
      currency: "EUR",
    });
    const select = /** @type {HTMLSelectElement} */ (doc.querySelector("body > header select"));
    expect(doc.querySelector(`label[for="${select.id}"]`)?.textContent).toBe("Currency");
    expect(Array.from(select.options, (option) => [option.value, option.textContent])).toEqual([
      ["GBP", "GBP (£)"],
      ["EUR", "EUR (€)"],
      ["CHF", "CHF"],
    ]);
    expect(select.value).toBe("EUR");

    const changes = /** @type {CustomEvent[]} */ ([]);
    doc.addEventListener(CURRENCY_CHANGE_EVENT, (event) => changes.push(/** @type {CustomEvent} */ (event)));
    select.value = "CHF";
    // An event of the page's own window, like the browser's.
    const view = /** @type {typeof globalThis} */ (/** @type {unknown} */ (doc.defaultView));
    select.dispatchEvent(new view.Event("change", { bubbles: true }));

    expect(preferences.items.get(CURRENCY_STORAGE_KEY)).toBe("CHF");
    expect(changes.length).toBe(1);
    expect(changes[0]?.detail.currency).toBe("CHF");
    expect(changes[0]?.detail.client.derivedWith).toEqual({ currency: "CHF" });
  });

  it("[OFE-003] ignores a remembered currency the storefront no longer offers, and a refusing storage", async () => {
    const stale = openPage();
    const sdk = fakeClient([CONFIG]);
    const { client } = await boot({
      client: sdk,
      storage: null,
      preferences: memoryStorage({ [CURRENCY_STORAGE_KEY]: "USD" }),
      doc: stale,
    });
    expect(sdk.withOptions).not.toHaveBeenCalled();
    expect(client).toBe(sdk);
    expect(/** @type {HTMLSelectElement} */ (stale.querySelector("body > header select")).value).toBe("GBP");

    const refusing = {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      },
    };
    const doc = openPage();
    await expect(
      boot({
        client: fakeClient([{ ...CONFIG, currencies: CONFIG.currencies.slice(0, 1) }]),
        storage: null,
        preferences: refusing,
        doc,
      }),
    ).resolves.toMatchObject({ config: { name: "Demo Travel" } });
    // One currency: no selector at all.
    expect(doc.querySelector("body > header select")).toBeNull();
  });

  it("[OFE-003] asks auth.getSession only when the SDK has it: 401 is signed out, a session shows the account link", async () => {
    // Before SDK-008 the client has no auth namespace: a visitor, and no request.
    const before = openPage("index.html", "/search.html?from=PAR");
    const visitor = await boot({
      client: fakeClient([CONFIG]),
      storage: null,
      preferences: memoryStorage(),
      doc: before,
    });
    expect(visitor.session).toBeNull();
    const signIn = before.querySelector('body > header [data-slot="account-menu"] a');
    expect(text(signIn)).toBe("Sign in");
    expect(signIn?.getAttribute("href")).toBe("/account/sign-in.html?next=%2Fsearch.html%3Ffrom%3DPAR");

    const signedOut = openPage();
    const unauthenticated = fakeClient([CONFIG], {
      getSession: async () => {
        throw sdkError(AuthenticationError, "UNAUTHENTICATED", 401);
      },
    });
    const out = await boot({
      client: unauthenticated,
      storage: null,
      preferences: memoryStorage(),
      doc: signedOut,
    });
    expect(unauthenticated.auth.getSession).toHaveBeenCalledTimes(1);
    expect(out.session).toBeNull();
    expect(text(signedOut.querySelector('body > header [data-slot="account-menu"] a'))).toBe("Sign in");

    const signedIn = openPage();
    const customer = fakeClient([CONFIG], { getSession: async () => SESSION });
    const result = await boot({
      client: customer,
      storage: null,
      preferences: memoryStorage(),
      doc: signedIn,
    });
    expect(result.session).toEqual(SESSION);
    const account = signedIn.querySelector('body > header [data-slot="account-menu"] a');
    expect(text(account)).toBe("My account");
    expect(account?.getAttribute("href")).toBe("/account/");
  });

  it("[OFE-003] without customer accounts: no session request, no account menu and no 'My bookings'", async () => {
    const doc = openPage();
    const sdk = fakeClient([{ ...CONFIG, features: { ...CONFIG.features, customerAccounts: false } }], {
      getSession: async () => SESSION,
    });
    const { session } = await boot({ client: sdk, storage: null, preferences: memoryStorage(), doc });

    expect(session).toBeNull();
    expect(sdk.auth.getSession).not.toHaveBeenCalled();
    expect(doc.querySelector('body > header [data-slot="account-menu"]')?.hasAttribute("hidden")).toBe(true);
    expect(
      doc.querySelector('body > header a[href="/bookings.html"]')?.closest("li")?.hasAttribute("hidden"),
    ).toBe(true);
  });

  it("[OFE-003 AC3] boot changes styles through style.setProperty only", async () => {
    const doc = openPage();
    const setProperty = vi.spyOn(doc.documentElement.style, "setProperty");
    const cssText = vi.spyOn(Object.getPrototypeOf(doc.documentElement.style), "cssText", "set");
    await boot({ client: fakeClient([CONFIG]), storage: null, preferences: memoryStorage(), doc });

    expect(setProperty).toHaveBeenCalled();
    expect(cssText).not.toHaveBeenCalled();
    expect(setProperty.mock.calls.every(([property]) => /^--vx-[a-z-]+$/.test(String(property)))).toBe(true);
    expect(
      doc.querySelectorAll("style, link[rel~='stylesheet']:not([href='/src/styles/main.css'])").length,
    ).toBe(0);
    expect(Array.from(doc.querySelectorAll("[style]"), (element) => element.tagName)).toEqual(["HTML"]);
  });
});

describe("live region", () => {
  it("[OFE-003] announces politely after a short pause, so a message cleared at once is never read", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const doc = openPage();
    const region = mountLiveRegion(doc.body);

    expect(region.element).toBe(doc.querySelector("[data-live-region]"));
    expect(region.element.getAttribute("role")).toBe("status");
    expect(region.element.getAttribute("aria-live")).toBe("polite");
    region.announce("Loading");
    region.clear();
    vi.runAllTimers();
    expect(region.element.textContent).toBe("");

    region.announce("3 flights");
    vi.runAllTimers();
    expect(region.element.textContent).toBe("3 flights");
    region.destroy();
    expect(doc.querySelector("[data-live-region]")).not.toBeNull();
  });
});

describe("pages", () => {
  it("[OFE-003] every page includes the test banner, the page states and its own module script", () => {
    expect(pageFiles).toEqual(expect.arrayContaining(["index.html", "404.html"]));
    for (const file of pageFiles) {
      const html = /** @type {string} */ (pages[file]);
      expect(html, file).toContain('data-slot="test-banner"');
      expect(html, file).toContain('id="tpl-state-page"');
      expect(html, file).toContain('id="tpl-state-inline"');
      expect(html, file).toContain("data-live-region");
      const entry = file
        .replace(/\.html$/, "")
        .split("/")
        .join("-");
      expect(html, file).toContain(`<script type="module" src="/src/pages/${entry}.js"></script>`);
    }
  });
});
