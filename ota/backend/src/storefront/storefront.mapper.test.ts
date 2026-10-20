// The pure parts of `storefront.get` (OBE-016): the settings row → the caller-independent cache entry → the answer of
// each caller, checked against the OTA document with the same check as the integration tests; the defaults of a new
// tenant, the locale negotiation and the cache entry's encoding.
import { readFileSync } from "node:fs";
import { responseChecker, type ResponseChecker } from "@velexis/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { OTA_OPENAPI_DOCUMENT } from "../common/http/openapi-validation.interceptor";
import { newId } from "../common/ids";
import {
  acceptedLocales,
  assetUrl,
  brandInitials,
  BUNDLED_FONTS,
  canonicalLocale,
  decodeCachedStorefront,
  encodeCachedStorefront,
  localesOf,
  negotiateLocale,
  NEUTRAL_COLORS,
  placeholderSupportEmail,
  referencedAssetIds,
  referencedCurrencies,
  STRIPE_CARD_BRANDS,
  storefrontFor,
  textColorOn,
  toCachedStorefront,
  type StorefrontAudience,
  type StorefrontConfig,
  type StorefrontSource,
} from "./storefront.mapper";
import type { StorefrontAssetRow, StorefrontSettingsRow } from "./storefront.repository";

let checker: ResponseChecker;
let documentEnums: { fonts: unknown; paymentBrands: unknown };

// Parsing the OTA document (for the response check and its enums) takes about a second alone, several times that
// while every package's tests run at once on a 4-CPU runner: paid once here, with a budget that only stops a hang.
beforeAll(() => {
  checker = responseChecker("ota");
  const schemas = (
    parse(readFileSync(OTA_OPENAPI_DOCUMENT, "utf8")) as {
      components: { schemas: Record<string, { enum?: unknown }> };
    }
  ).components.schemas;
  documentEnums = {
    fonts: schemas["StorefrontFontFamily"]?.enum,
    paymentBrands: schemas["AmadeusPaymentBrand"]?.enum,
  };
}, 60_000);

const CREATED = new Date("2026-09-01T08:00:00.000Z");
const UPDATED = new Date("2026-10-01T09:30:00.000Z");
const EDGE: StorefrontAudience = { caller: "edge", publicApiUrl: "https://api.ota.example.com" };
const KEY: StorefrontAudience = { caller: "key", publicApiUrl: "https://api.ota.example.com/" };

/** The row the provisioning seed writes for a new tenant (storefront-settings.seed.ts) with the column defaults. */
function seededRow(overrides: Partial<StorefrontSettingsRow> = {}): StorefrontSettingsRow {
  return {
    brandName: "Alpha Travel",
    legalName: null,
    timeZone: "UTC",
    primaryColor: null,
    secondaryColor: null,
    theme: {},
    defaultLocale: "en",
    supportedLocales: ["en"],
    defaultCurrency: "EUR",
    supportedCurrencies: ["EUR"],
    defaultMarket: null,
    markets: [],
    supportEmail: null,
    supportPhone: null,
    supportDetails: {},
    seo: {},
    consent: {},
    autoIssue: true,
    acceptedCardBrands: ["VISA", "MASTERCARD", "AMERICAN_EXPRESS"],
    require3ds: true,
    guestCheckoutEnabled: true,
    customerAccountsEnabled: true,
    requireEmailVerification: false,
    features: {},
    termsUrl: null,
    privacyUrl: null,
    legalLinks: [],
    termsVersion: null,
    privacyVersion: null,
    airlineCardEnabledTest: false,
    airlineCardEnabledLive: false,
    logoAssetId: null,
    logoDarkAssetId: null,
    logoSquareAssetId: null,
    faviconAssetId: null,
    ogImageAssetId: null,
    version: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...overrides,
  };
}

const CURRENCIES = [
  { code: "EUR", name: "Euro", symbol: "€", minorUnits: 2 },
  { code: "GBP", name: "Pound Sterling", symbol: "£", minorUnits: 2 },
];

function source(
  settings: StorefrontSettingsRow,
  overrides: Partial<StorefrontSource> = {},
): StorefrontSource {
  return {
    tenantKey: "alpha",
    tenantName: "Alpha Travel Holding",
    environment: "test",
    storefrontBaseDomain: "ota.example.com",
    settings,
    assets: [],
    currencies: CURRENCIES,
    ...overrides,
  };
}

function expectValid(body: StorefrontConfig): void {
  expect(checker.check("getStorefront", { status: 200, body })).toEqual([]);
}

/** A fully configured tenant, as console.settings.storefront.update (OBE-070) writes the row, with every asset. */
function configured(): { settings: StorefrontSettingsRow; assets: StorefrontAssetRow[] } {
  const asset = (kind: string, fileExtension = "png"): StorefrontAssetRow => ({
    id: newId("ast"),
    kind,
    fileExtension,
  });
  const assets = [
    asset("logo"),
    asset("logo_dark", "webp"),
    asset("logo_square"),
    asset("favicon", "ico"),
    asset("og_image", "jpg"),
  ];
  const [logo, logoDark, logoSquare, favicon, ogImage] = assets.map((row) => row.id);
  const settings = seededRow({
    legalName: "Alpha Travel Ltd",
    timeZone: "Europe/London",
    primaryColor: "#0B5FFF",
    secondaryColor: "#14213D",
    theme: {
      colors: { accent: "#FCA311", background: "#FFFFFF", text: "#1A1A1A" },
      fonts: { heading: "Montserrat", body: "Source Sans 3" },
      cornerRadius: "large",
    },
    defaultLocale: "en-GB",
    supportedLocales: ["en-GB", "fr-FR"],
    defaultCurrency: "GBP",
    supportedCurrencies: ["GBP", "EUR"],
    defaultMarket: "GB",
    markets: [
      { countryCode: "GB", name: "United Kingdom", currency: "GBP", locale: "en-GB" },
      { countryCode: "FR", name: "France", currency: "EUR", locale: "fr-FR" },
    ],
    supportEmail: "help@alpha-travel.example",
    supportPhone: "+442071234567",
    supportDetails: {
      hours: "Mon-Fri 08:00-20:00",
      helpCenterUrl: "https://help.alpha-travel.example",
      emergencyPhone: "+442071234568",
    },
    seo: {
      titleTemplate: "%s · Alpha",
      defaultTitle: "Alpha Travel flights",
      defaultDescription: "Cheap flights",
      robots: { index: true, follow: false },
    },
    consent: {
      regime: "gdpr",
      bannerRequired: true,
      policyVersion: "2026-09-01",
      categories: [
        { id: "necessary", required: true, defaultEnabled: true, title: "Necessary", description: "Needed." },
        {
          id: "analytics",
          required: false,
          defaultEnabled: false,
          title: "Analytics",
          description: "Usage.",
        },
      ],
    },
    features: { ancillaries: false, brandedFareUpsell: true, selfServiceCancellation: true },
    legalLinks: [
      { kind: "terms", label: "Terms", url: "https://alpha-travel.example/terms" },
      { kind: "privacy", label: "Privacy", pageSlug: "privacy-policy" },
      { kind: "imprint", label: "Imprint", url: "https://alpha-travel.example/imprint" },
    ],
    termsVersion: "2026-09-15",
    privacyVersion: "3",
    airlineCardEnabledTest: true,
    logoAssetId: logo ?? null,
    logoDarkAssetId: logoDark ?? null,
    logoSquareAssetId: logoSquare ?? null,
    faviconAssetId: favicon ?? null,
    ogImageAssetId: ogImage ?? null,
    version: 7,
  });
  return { settings, assets };
}

describe("a new tenant's configuration", () => {
  const entry = toCachedStorefront(source(seededRow()));
  const forEdge = storefrontFor(entry, EDGE);
  const forKey = storefrontFor(entry, KEY);

  it("validates against StorefrontConfig for the edge and for key callers [OBE-016 AC2]", () => {
    expectValid(forEdge);
    expectValid(forKey);
  });

  it("maps the settings, the tenant and the environment, with a payment section without methods", () => {
    expect(forKey).toMatchObject({
      tenantKey: "alpha",
      name: "Alpha Travel",
      legalName: null,
      environment: "test",
      primaryUrl: "https://alpha.ota.example.com",
      domains: [
        {
          host: "alpha.ota.example.com",
          kind: "subdomain",
          primary: true,
          verifiedAt: CREATED.toISOString(),
        },
      ],
      timeZone: "UTC",
      defaultLocale: "en",
      locales: [{ code: "en", name: "English", direction: "ltr" }],
      defaultCurrency: "EUR",
      currencies: [{ code: "EUR", name: "Euro", symbol: "€", decimals: 2 }],
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
        emailVerification: "not_required",
        passwordPolicy: { minLength: 10, maxLength: 128, rejectBreached: true },
        accessTokenTtlSeconds: 900,
        refreshTokenTtlDays: 30,
      },
      payment: {
        provider: "stripe",
        environment: "test",
        accountMode: "velexis",
        merchantName: "Alpha Travel Holding",
        supportedMethods: [],
        airlineCard: null,
        cardBrands: ["VISA", "MASTERCARD", "AMERICAN_EXPRESS"],
        pspCardBrands: [
          { amadeus: "VISA", psp: "visa", label: "Visa" },
          { amadeus: "MASTERCARD", psp: "mastercard", label: "Mastercard" },
          { amadeus: "AMERICAN_EXPRESS", psp: "amex", label: "American Express" },
        ],
        threeDSecure: "always",
      },
      version: 1,
      updatedAt: UPDATED.toISOString(),
    });
  });

  it("fills what the contract requires and the row does not have yet with documented defaults", () => {
    expect(forKey.branding.colors).toEqual({
      ...NEUTRAL_COLORS,
      onPrimary: "#ffffff",
    });
    expect(forKey.branding.fonts.body).toEqual({
      family: "Inter",
      cssUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
      weights: [400, 700],
    });
    expect(forKey.branding.cornerRadius).toBe("medium");
    expect(forKey.branding.customCssUrl).toBeNull();
    // A badge with the initials as logo and favicon: shown under the storefront's `img-src 'self' data:` CSP.
    expect(forEdge.branding.logoUrl).toMatch(/^data:image\/svg\+xml,.*%3EAT%3C\/text%3E/);
    expect(forEdge.branding.faviconUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(forKey.branding.logoUrl).toBe(forEdge.branding.logoUrl);
    expect(forEdge.branding.logoDarkUrl).toBeNull();
    expect(forEdge.seo.ogImageUrl).toBeNull();
    // One market from the default locale (en → US) with the default currency.
    expect(forKey.defaultMarket).toBe("US");
    expect(forKey.markets).toEqual([
      { countryCode: "US", name: "United States", currency: "EUR", locale: "en" },
    ]);
    expect(forKey.payment.merchantCountry).toBe("US");
    expect(forKey.legal).toEqual({
      termsUrl: "https://alpha.ota.example.com/p/terms",
      termsVersion: "2026-09-01",
      privacyUrl: "https://alpha.ota.example.com/p/privacy",
      privacyVersion: "2026-09-01",
      cookiePolicyUrl: "https://alpha.ota.example.com/p/cookies",
      refundPolicyUrl: "https://alpha.ota.example.com/p/refund-policy",
      imprintUrl: null,
      accessibilityUrl: null,
    });
    expect(forKey.support).toEqual({
      email: "support@alpha.invalid",
      phone: null,
      hours: "",
      helpCenterUrl: null,
      emergencyPhone: null,
    });
    expect(forKey.consent).toEqual({
      regime: "gdpr",
      bannerRequired: true,
      policyVersion: "2026-09-01",
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
    });
    expect(forKey.seo).toEqual({
      titleTemplate: "%s | Alpha Travel",
      defaultTitle: "Alpha Travel",
      defaultDescription: "",
      ogImageUrl: null,
      twitterHandle: null,
      canonicalBaseUrl: "https://alpha.ota.example.com",
      robots: { index: false, follow: false },
    });
  });

  it("falls back to the tenant's platform name, then its key, for an empty brand name", () => {
    expect(storefrontFor(toCachedStorefront(source(seededRow({ brandName: " " }))), KEY).name).toBe(
      "Alpha Travel Holding",
    );
    const unnamed = toCachedStorefront(source(seededRow({ brandName: "" }), { tenantName: null }));
    expect(storefrontFor(unnamed, KEY).name).toBe("alpha");
    expect(storefrontFor(unnamed, KEY).payment.merchantName).toBe("alpha");
  });
});

describe("a configured tenant", () => {
  const { settings, assets } = configured();
  const entry = toCachedStorefront(source(settings, { assets, environment: "live" }));
  const forEdge = storefrontFor(entry, EDGE);
  const forKey = storefrontFor(entry, KEY);

  it("validates against StorefrontConfig for both callers [OBE-016 AC2]", () => {
    expectValid(forEdge);
    expectValid(forKey);
  });

  it("gives key callers absolute asset URLs and the edge same-origin /api/v1/assets/ paths [OBE-016 AC4]", () => {
    const [logo, logoDark, logoSquare, favicon, ogImage] = assets.map(
      (asset) => `/v1/assets/alpha/${asset.id}.${asset.fileExtension}`,
    );
    expect(forKey.branding).toMatchObject({
      logoUrl: `https://api.ota.example.com${logo}`,
      logoDarkUrl: `https://api.ota.example.com${logoDark}`,
      logoSquareUrl: `https://api.ota.example.com${logoSquare}`,
      faviconUrl: `https://api.ota.example.com${favicon}`,
    });
    expect(forKey.seo.ogImageUrl).toBe(`https://api.ota.example.com${ogImage}`);
    expect(forEdge.branding).toMatchObject({
      logoUrl: `/api${logo}`,
      logoDarkUrl: `/api${logoDark}`,
      logoSquareUrl: `/api${logoSquare}`,
      faviconUrl: `/api${favicon}`,
    });
    expect(forEdge.seo.ogImageUrl).toBe(`/api${ogImage}`);
    // Everything but the asset URLs is the same for both callers.
    const withoutUrls = (config: StorefrontConfig) => ({
      ...config,
      branding: { ...config.branding, logoUrl: 0, logoDarkUrl: 0, logoSquareUrl: 0, faviconUrl: 0 },
      seo: { ...config.seo, ogImageUrl: 0 },
    });
    expect(withoutUrls(forEdge)).toEqual(withoutUrls(forKey));
  });

  it("decorates one cache entry for any caller in any order without changing it [OBE-016 AC4]", () => {
    const stored = encodeCachedStorefront(entry);
    const keyFirst = [storefrontFor(entry, KEY), storefrontFor(entry, EDGE)];
    const edgeFirst = [storefrontFor(entry, EDGE), storefrontFor(entry, KEY)];

    expect(edgeFirst).toEqual([keyFirst[1], keyFirst[0]]);
    expect(encodeCachedStorefront(entry)).toBe(stored);
    // The entry holds asset references, never a caller's URL.
    expect(stored).not.toContain("/v1/assets/");
    expect(entry.assets.logo).toEqual({ id: assets[0]?.id, extension: "png" });
  });

  it("maps every configured section", () => {
    expect(forKey).toMatchObject({
      legalName: "Alpha Travel Ltd",
      environment: "live",
      timeZone: "Europe/London",
      defaultLocale: "en-GB",
      locales: [
        { code: "en-GB", name: "British English", direction: "ltr" },
        { code: "fr-FR", name: "français (France)", direction: "ltr" },
      ],
      defaultCurrency: "GBP",
      currencies: [
        { code: "GBP", name: "Pound Sterling", symbol: "£", decimals: 2 },
        { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
      ],
      defaultMarket: "GB",
      markets: [
        { countryCode: "GB", name: "United Kingdom", currency: "GBP", locale: "en-GB" },
        { countryCode: "FR", name: "France", currency: "EUR", locale: "fr-FR" },
      ],
      features: { ancillaries: false, brandedFareUpsell: true },
      legal: {
        termsUrl: "https://alpha-travel.example/terms",
        termsVersion: "2026-09-15",
        privacyUrl: "https://alpha.ota.example.com/p/privacy-policy",
        privacyVersion: "3",
        imprintUrl: "https://alpha-travel.example/imprint",
      },
      support: {
        email: "help@alpha-travel.example",
        phone: "+442071234567",
        hours: "Mon-Fri 08:00-20:00",
        helpCenterUrl: "https://help.alpha-travel.example/",
        emergencyPhone: "+442071234568",
      },
      seo: {
        titleTemplate: "%s · Alpha",
        defaultTitle: "Alpha Travel flights",
        defaultDescription: "Cheap flights",
        robots: { index: true, follow: false },
      },
      version: 7,
    });
    expect(forKey.branding.colors).toMatchObject({
      primary: "#0B5FFF",
      onPrimary: "#ffffff",
      secondary: "#14213D",
      accent: "#FCA311",
      text: "#1A1A1A",
      surface: NEUTRAL_COLORS.surface,
    });
    expect(forKey.branding.fonts.heading.family).toBe("Montserrat");
    expect(forKey.branding.fonts.body.cssUrl).toBe(
      "https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;700&display=swap",
    );
    expect(forKey.branding.cornerRadius).toBe("large");
    expect(forKey.consent.categories.map((category) => category.id)).toEqual(["necessary", "analytics"]);
    expect(entry.airlineCardEnabled).toBe(false); // live, and only airline_card_enabled_test is on
  });

  it("keeps the airline card out of every answer until OBE-050 adds it for the edge", () => {
    const testEntry = toCachedStorefront(source(settings, { assets }));

    expect(testEntry.airlineCardEnabled).toBe(true);
    for (const audience of [EDGE, KEY]) {
      const { payment } = storefrontFor(testEntry, audience);
      expect(payment.airlineCard).toBeNull();
      expect(payment.supportedMethods).not.toContain("airline_card");
    }
  });

  it("publishes no operational column of the settings [OBE-016 AC2]", () => {
    const row = {
      ...settings,
      opsAlertEmail: "ops-alerts@alpha-travel.example",
      bookingQueueNumber: 77,
      bookingQueueCategory: 3,
      offerTtlMinutes: 31,
    } as StorefrontSettingsRow;
    const texts = [KEY, EDGE].map((audience) =>
      JSON.stringify(storefrontFor(toCachedStorefront(source(row, { assets })), audience)),
    );
    for (const text of [...texts, encodeCachedStorefront(toCachedStorefront(source(row, { assets })))]) {
      expect(text).not.toMatch(/ops_?alert|booking_?queue|offer_?ttl/i);
      expect(text).not.toContain("ops-alerts@alpha-travel.example");
    }
  });

  it("ignores values the contract cannot carry and falls back to the defaults", () => {
    const broken = seededRow({
      primaryColor: "blue",
      theme: { colors: { accent: "#12345" }, fonts: { heading: "Comic Sans MS" }, cornerRadius: "round" },
      supportedLocales: ["en", "not a locale", "fr"],
      supportedCurrencies: ["usd", "EURO"],
      markets: [{ countryCode: "gb", name: "UK", currency: "GBP", locale: "en-GB" }, "nonsense"],
      supportEmail: "not an e-mail",
      supportPhone: "020 7123 4567",
      supportDetails: { helpCenterUrl: "http://insecure.example", emergencyPhone: 12345 },
      legalLinks: [
        { kind: "terms", label: "Terms", url: "javascript:alert(1)" },
        { kind: "privacy", label: "Privacy", pageSlug: "../etc" },
        { kind: "unknown", label: "?", url: "https://example.com" },
      ],
      seo: { titleTemplate: "No placeholder", robots: { index: "yes" } },
      consent: { regime: "other", categories: [{ id: "analytics", required: "no" }] },
      acceptedCardBrands: ["VISA", "UATP_AIRPLUS", "VISA"],
      logoAssetId: newId("ast"), // no such row
    });
    const config = storefrontFor(toCachedStorefront(source(broken)), KEY);

    expectValid(config);
    expect(config.branding.colors.primary).toBe(NEUTRAL_COLORS.primary);
    expect(config.branding.colors.accent).toBe(NEUTRAL_COLORS.accent);
    expect(config.branding.fonts.heading.family).toBe("Inter");
    expect(config.branding.cornerRadius).toBe("medium");
    expect(config.locales.map((locale) => locale.code)).toEqual(["en", "fr"]);
    expect(config.currencies.map((currency) => currency.code)).toEqual(["EUR", "USD"]);
    expect(config.markets).toHaveLength(1);
    expect(config.support).toMatchObject({
      email: placeholderSupportEmail("alpha"),
      phone: null,
      helpCenterUrl: null,
      emergencyPhone: null,
    });
    expect(config.legal.termsUrl).toBe("https://alpha.ota.example.com/p/terms");
    expect(config.legal.privacyUrl).toBe("https://alpha.ota.example.com/p/privacy");
    expect(config.seo.titleTemplate).toBe("%s | Alpha Travel");
    expect(config.consent.regime).toBe("gdpr");
    expect(config.consent.categories.map((category) => category.id)).toEqual(["necessary"]);
    expect(config.payment.cardBrands).toEqual(["VISA"]);
    expect(config.branding.logoUrl).toMatch(/^data:/);
  });

  it("ignores an asset of the wrong kind", () => {
    const logo = assets[0] as StorefrontAssetRow;
    const entryWithWrongKind = toCachedStorefront(
      source(seededRow({ faviconAssetId: logo.id }), { assets: [logo] }),
    );

    expect(entryWithWrongKind.assets.favicon).toBeNull();
  });
});

describe("the payment account (OBE-038)", () => {
  const entry = toCachedStorefront(source(seededRow()));
  /** The Velexis account of the test environment, as the payment gateway gives it (no secret). */
  const velexis = {
    provider: "stripe" as const,
    accountMode: "velexis" as const,
    publishableKey: "pk_test_publishable_key_of_the_velexis_account",
    accountId: null,
    statementDescriptor: "ALPHA TRAVEL",
    methods: ["card"],
  };

  it("shows Velexis as the merchant on behalf of the OTA in velexis mode, for the edge and key callers [OBE-038 AC3]", () => {
    for (const audience of [EDGE, KEY]) {
      const config = storefrontFor(entry, { ...audience, payment: velexis });

      expectValid(config);
      expect(config.payment).toEqual({
        provider: "stripe",
        environment: "test",
        accountMode: "velexis",
        publishableKey: velexis.publishableKey,
        accountId: null,
        merchantName: "Velexis on behalf of Alpha Travel Holding",
        statementDescriptor: "ALPHA TRAVEL",
        supportedMethods: ["card"],
        cardBrands: ["VISA", "MASTERCARD", "AMERICAN_EXPRESS"],
        pspCardBrands: [
          { amadeus: "VISA", psp: "visa", label: "Visa" },
          { amadeus: "MASTERCARD", psp: "mastercard", label: "Mastercard" },
          { amadeus: "AMERICAN_EXPRESS", psp: "amex", label: "American Express" },
        ],
        merchantCountry: "US",
        threeDSecure: "always",
        airlineCard: null,
      });
    }
  });

  it("keeps the section without a method when no account can take payments", () => {
    for (const payment of [null, undefined]) {
      const config = storefrontFor(entry, { ...EDGE, payment });

      expect(config.payment).toMatchObject({
        accountMode: "velexis",
        publishableKey: "",
        merchantName: "Alpha Travel Holding",
        statementDescriptor: null,
        supportedMethods: [],
        airlineCard: null,
      });
    }
  });

  it("lists only the methods checkout.createPayment takes, and leaves the cached entry unchanged", () => {
    const config = storefrontFor(entry, {
      ...KEY,
      payment: { ...velexis, methods: ["paypal", "card", "bank_transfer"] },
    });
    const without = storefrontFor(entry, KEY);

    expect(config.payment.supportedMethods).toEqual(["card"]);
    expect(without.payment.supportedMethods).toEqual([]);
    expect(entry.config.payment.merchantName).toBe("Alpha Travel Holding");
  });

  it("names the OTA as the merchant of its own account (connect_standard, M5) with Stripe.js's account id", () => {
    const config = storefrontFor(entry, {
      ...EDGE,
      payment: { ...velexis, accountMode: "connect_standard", accountId: "acct_test_alpha" },
    });

    expect(config.payment).toMatchObject({
      accountMode: "connect_standard",
      accountId: "acct_test_alpha",
      merchantName: "Alpha Travel Holding",
      statementDescriptor: null,
    });
  });
});

describe("locales", () => {
  it("negotiates Accept-Language against the supported locales, else the default one", () => {
    const supported = ["en-GB", "fr-FR", "de"];

    expect(negotiateLocale(undefined, supported, "en-GB")).toBe("en-GB");
    expect(negotiateLocale("fr-FR,fr;q=0.9", supported, "en-GB")).toBe("fr-FR");
    expect(negotiateLocale("fr-ca", supported, "en-GB")).toBe("fr-FR");
    expect(negotiateLocale("de-AT", supported, "en-GB")).toBe("de");
    expect(negotiateLocale("es, de;q=0.5", supported, "en-GB")).toBe("de");
    expect(negotiateLocale("ja, zh;q=0.8, *;q=0.1", supported, "en-GB")).toBe("en-GB");
    expect(negotiateLocale("de;q=0.2, fr;q=0.8", supported, "en-GB")).toBe("fr-FR");
    expect(negotiateLocale("fr;q=0, de;q=0.5", supported, "en-GB")).toBe("de");
    expect(negotiateLocale("!!!, en-US", supported, "en-GB")).toBe("en-GB");
  });

  it("parses language ranges by quality and canonicalises them without extensions", () => {
    expect(acceptedLocales("da, en-gb;q=0.8, en;q=0.7")).toEqual(["da", "en-GB", "en"]);
    expect(acceptedLocales("en-US-u-ca-gregory")).toEqual(["en-US"]);
    expect(acceptedLocales("*")).toEqual([]);
    expect(canonicalLocale("ZH-hant-tw")).toBe("zh-Hant-TW");
    expect(canonicalLocale("not a locale")).toBeUndefined();
  });

  it("names each locale in its own language with its direction", () => {
    const entry = toCachedStorefront(source(seededRow({ supportedLocales: ["en", "ar", "he-IL"] })));

    expect(entry.config.locales).toEqual([
      { code: "en", name: "English", direction: "ltr" },
      { code: "ar", name: "العربية", direction: "rtl" },
      { code: "he-IL", name: "עברית (ישראל)", direction: "rtl" },
    ]);
    expect(localesOf(entry)).toEqual(["en", "ar", "he-IL"]);
  });

  it("localises currency and default market names for the entry's locale", () => {
    const settings = seededRow({ supportedLocales: ["en", "fr-FR"] });
    const english = toCachedStorefront(source(settings));
    const french = toCachedStorefront(source(settings), "fr-FR");
    const unsupported = toCachedStorefront(source(settings), "de");

    expect(english.locale).toBe("en");
    expect(french.locale).toBe("fr-FR");
    expect(unsupported.locale).toBe("en");
    expect(english.config.currencies[0]?.name).toBe("Euro");
    expect(french.config.currencies[0]?.name).toBe("euro");
    expect(french.config.markets[0]?.name).toBe("États-Unis");
  });
});

describe("the cache entry", () => {
  const { settings, assets } = configured();
  const entry = toCachedStorefront(source(settings, { assets }));

  it("round-trips through its JSON", () => {
    expect(decodeCachedStorefront(encodeCachedStorefront(entry))).toEqual(entry);
  });

  it("refuses entries this version did not write", () => {
    const stored = JSON.parse(encodeCachedStorefront(entry)) as Record<string, unknown>;
    for (const raw of [
      "not json",
      "null",
      JSON.stringify({ ...stored, v: 2 }),
      JSON.stringify({ ...stored, locale: 1 }),
      JSON.stringify({ ...stored, config: null }),
      JSON.stringify({ ...stored, assets: { ...entry.assets, logo: { id: "../x", extension: "png" } } }),
      JSON.stringify({
        ...stored,
        assets: { ...entry.assets, favicon: { id: newId("ast"), extension: "svg" } },
      }),
      JSON.stringify({ ...stored, airlineCardEnabled: "no" }),
    ]) {
      expect(decodeCachedStorefront(raw)).toBeUndefined();
    }
  });

  it("names the assets and currencies the repository reads", () => {
    expect(referencedAssetIds(settings)).toEqual(assets.map((asset) => asset.id));
    expect(referencedAssetIds(seededRow())).toEqual([]);
    expect(
      referencedCurrencies(seededRow({ defaultCurrency: "gbp", supportedCurrencies: ["EUR", "GBP"] })),
    ).toEqual(["GBP", "EUR"]);
  });
});

describe("helpers", () => {
  it("builds asset URLs for each caller", () => {
    const asset = { id: "ast_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E", extension: "png" };

    expect(assetUrl("alpha", asset, EDGE)).toBe("/api/v1/assets/alpha/ast_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E.png");
    expect(assetUrl("alpha", asset, KEY)).toBe(
      "https://api.ota.example.com/v1/assets/alpha/ast_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E.png",
    );
    expect(assetUrl("alpha", asset, { caller: "key", publicApiUrl: "http://localhost:4000" })).toBe(
      "http://localhost:4000/v1/assets/alpha/ast_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E.png",
    );
  });

  it("picks white or black text for the best contrast", () => {
    expect(textColorOn("#1d4ed8")).toBe("#ffffff");
    expect(textColorOn("#FCA311")).toBe("#000000");
    expect(textColorOn("#000000")).toBe("#ffffff");
    expect(textColorOn("#ffffff")).toBe("#000000");
  });

  it("takes up to two initials of the brand name, else the key's first letter", () => {
    expect(brandInitials("Alpha Travel", "alpha")).toBe("AT");
    expect(brandInitials("Évasion", "evasion")).toBe("E");
    expect(brandInitials("Alpha Beta Gamma", "abg")).toBe("AB");
    expect(brandInitials("東京旅行", "tokyo")).toBe("T");
  });

  it("offers exactly the document's bundled fonts and maps only Amadeus payment brands", () => {
    expect([...BUNDLED_FONTS]).toEqual(documentEnums.fonts);
    for (const brand of Object.keys(STRIPE_CARD_BRANDS)) {
      expect(documentEnums.paymentBrands).toContain(brand);
    }
  });
});
