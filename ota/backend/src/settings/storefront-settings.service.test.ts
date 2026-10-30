// console.settings.storefront.get and update without PostgreSQL or Redis (OBE-070): the settings row ↔
// StorefrontSettings mapping (checked against the OTA document with the checker of the integration tests, and read
// back by storefront.get's own mapper), the rules of an update, and the service's order of checks, warnings, audit row
// and cache deletion, with an in-memory repository that keeps the row as PostgreSQL would. The SQL, the pipeline and
// storefront.get after a change are test/integration/settings/storefront-settings.int.test.ts.
import { readFileSync } from "node:fs";
import type { ConfigService } from "@nestjs/config";
import type { TenantSchema } from "@velexis/db";
import { AppError } from "@velexis/errors";
import { responseChecker, type ResponseChecker } from "@velexis/testing";
import type { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { Clock } from "../common/clock";
import { OTA_OPENAPI_DOCUMENT } from "../common/http/openapi-validation.interceptor";
import { newId } from "../common/ids";
import type { ApiConfig } from "../config";
import type { StaffActionEntry, StaffActionsWriter } from "../console/staff-actions.writer";
import { storefrontFor, toCachedStorefront } from "../storefront/storefront.mapper";
import type {
  StorefrontAssetRow,
  StorefrontRepository,
  StorefrontSettingsChanges,
  StorefrontSettingsEditRow,
} from "../storefront/storefront.repository";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import {
  mergeSettings,
  PAYMENT_BRANDS,
  sectionsOf,
  settingsEtagOf,
  toSettingsChanges,
  toStorefrontSettings,
  type SettingsSection,
  type StorefrontSettings,
  type StorefrontSettingsUpdate,
} from "./storefront-settings.mapper";
import {
  airlineCardTurnedOn,
  lookupsFor,
  settingsProblem,
  storefrontCacheKeys,
  StorefrontSettingsService,
  type SettingsLookups,
} from "./storefront-settings.service";

let checker: ResponseChecker;
let paymentBrands: unknown;

// Parsing the OTA document (for the response check and its enum) takes about a second alone, several times that while
// every package's tests run at once on a 4-CPU runner: paid once here, with a budget that only stops a hang.
beforeAll(() => {
  checker = responseChecker("ota");
  const schemas = (
    parse(readFileSync(OTA_OPENAPI_DOCUMENT, "utf8")) as {
      components: { schemas: Record<string, { enum?: unknown }> };
    }
  ).components.schemas;
  paymentBrands = schemas["AmadeusPaymentBrand"]?.enum;
}, 60_000);

const TENANT_ID = "ten_01JA4CH3G1K4N7R0V3X6A9D2F5";
const CREATED = new Date("2026-09-01T08:00:00.000Z");
const UPDATED = new Date("2026-10-01T09:30:00.000Z");
const NOW = new Date("2026-10-02T10:00:00.000Z");

/** The row the provisioning seed writes for a new tenant, with the column defaults and the 0002 seed values. */
function seededRow(overrides: Partial<StorefrontSettingsEditRow> = {}): StorefrontSettingsEditRow {
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
    ticketingPolicy: "issue_after_payment",
    paymentTiming: "authorize_before_booking",
    offerTtlMinutes: 30,
    checkoutTtlMinutes: 30,
    bookingQueueNumber: 50,
    bookingQueueCategory: 0,
    opsAlertEmail: null,
    ...overrides,
  };
}

/** The jsonb columns: written as JSON text, read back as values. */
const JSON_COLUMNS: ReadonlySet<string> = new Set([
  "theme",
  "markets",
  "features",
  "legal_links",
  "support_details",
  "seo",
  "consent",
]);

/** The row after `changes`, as PostgreSQL stores them (snake_case column → camelCase field, jsonb parsed). */
function applied(
  row: StorefrontSettingsEditRow,
  changes: StorefrontSettingsChanges,
  version = row.version + 1,
): StorefrontSettingsEditRow {
  const fields = Object.fromEntries(
    Object.entries(changes).map(([column, value]) => [
      column.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase()),
      JSON_COLUMNS.has(column) && typeof value === "string" ? (JSON.parse(value) as unknown) : value,
    ]),
  );
  const next = { ...row, ...fields, version, updatedAt: NOW } as StorefrontSettingsEditRow;
  return { ...next, autoIssue: next.ticketingPolicy !== "manual_review" };
}

const asset = (kind: string, fileExtension = "png"): StorefrontAssetRow => ({
  id: newId("ast"),
  kind,
  fileExtension,
});

/** The settings of a fully configured OTA, as the OTA admin sends them, minus version and updatedAt. */
function fullUpdate(assets: {
  logo: string;
  logoDark: string;
  logoSquare: string;
  favicon: string;
  ogImage: string;
}): Required<StorefrontSettingsUpdate> {
  return {
    brand: { name: "Acme Travel", legalName: "Acme Travel Ltd", timeZone: "Europe/London" },
    branding: {
      logoAssetId: assets.logo,
      logoDarkAssetId: assets.logoDark,
      logoSquareAssetId: assets.logoSquare,
      faviconAssetId: assets.favicon,
      colors: {
        primary: "#0B5FFF",
        secondary: "#0F172A",
        accent: "#F59E0B",
        background: "#FFFFFF",
        text: "#111827",
      },
      fonts: { heading: "Montserrat", body: "Source Sans 3" },
      cornerRadius: "large",
    },
    locales: { default: "en", supported: ["en", "fr"] },
    currencies: { default: "GBP", supported: ["GBP", "EUR"] },
    markets: {
      default: "GB",
      list: [
        { countryCode: "GB", name: "United Kingdom", currency: "GBP", locale: "en" },
        { countryCode: "FR", name: "France", currency: "EUR", locale: "fr" },
      ],
    },
    features: {
      guestCheckout: false,
      customerAccounts: true,
      ancillaries: false,
      brandedFareUpsell: true,
      selfServiceCancellation: true,
    },
    policies: {
      ticketingPolicy: "manual_review",
      paymentTiming: "authorize_before_booking",
      require3ds: false,
      acceptedCardBrands: ["VISA", "MASTERCARD"],
      requireEmailVerification: true,
      offerTtlMinutes: 45,
      checkoutTtlMinutes: 120,
    },
    airlineCard: { enabledTest: true, enabledLive: false },
    legal: {
      termsVersion: "2026-09",
      privacyVersion: "3",
      links: [
        { kind: "terms", label: "Terms and conditions", pageSlug: "terms" },
        { kind: "refund_policy", label: "Refunds", url: "https://www.acmetravel.example/refunds" },
      ],
    },
    support: {
      email: "support@acmetravel.example",
      phone: "+442071234567",
      hours: "Mon–Fri 09:00–18:00",
      helpCenterUrl: "https://help.acmetravel.example/",
      emergencyPhone: "+442071234500",
    },
    seo: {
      titleTemplate: "%s | Acme Travel",
      defaultTitle: "Cheap flights",
      defaultDescription: "Compare and book flights.",
      ogImageAssetId: assets.ogImage,
      robots: { index: true, follow: false },
    },
    consent: {
      regime: "gdpr",
      bannerRequired: true,
      policyVersion: "2026-09",
      categories: [
        {
          id: "necessary",
          required: true,
          defaultEnabled: true,
          title: "Necessary",
          description: "Always on.",
        },
        { id: "analytics", required: false, defaultEnabled: false, title: "Analytics", description: "" },
      ],
    },
    operations: { opsAlertEmail: "ops@acmetravel.example", bookingQueue: { number: 42, category: 7 } },
  };
}

function expectValidSettings(settings: StorefrontSettings): void {
  expect(checker.check("consoleGetStorefrontSettings", { status: 200, body: settings })).toEqual([]);
}

/** The active currencies of the tests' reference data and their minor units (KWD has 3, as ISO 4217 says). */
const ACTIVE_CURRENCIES: ReadonlyMap<string, number> = new Map([
  ["EUR", 2],
  ["GBP", 2],
  ["USD", 2],
  ["KWD", 3],
]);

/** Lookups that find everything they are asked for, assets with the kinds given. */
function everythingFound(assets: readonly StorefrontAssetRow[] = []): SettingsLookups {
  return {
    timeZones: new Set(["UTC", "Europe/London"]),
    currencies: ACTIVE_CURRENCIES,
    countries: new Set(["GB", "FR", "US"]),
    assetKinds: new Map(assets.map((row) => [row.id, row.kind])),
    pageSlugs: new Set(["terms", "privacy"]),
  };
}

describe("the settings row as StorefrontSettings", () => {
  it("answers a new tenant's row with the defaults storefront.get uses, valid against the document", () => {
    const settings = toStorefrontSettings(seededRow());

    expectValidSettings(settings);
    expect(settings).toMatchObject({
      brand: { name: "Alpha Travel", legalName: null, timeZone: "UTC" },
      branding: {
        logoAssetId: null,
        colors: { primary: "#1d4ed8", secondary: "#0f172a", accent: "#0e7490" },
        fonts: { heading: "Inter", body: "Inter" },
        cornerRadius: "medium",
      },
      locales: { default: "en", supported: ["en"] },
      currencies: { default: "EUR", supported: ["EUR"] },
      markets: { default: null, list: [] },
      features: {
        guestCheckout: true,
        customerAccounts: true,
        ancillaries: true,
        brandedFareUpsell: true,
        selfServiceCancellation: false,
      },
      policies: { ticketingPolicy: "issue_after_payment", paymentTiming: "authorize_before_booking" },
      airlineCard: { enabledTest: false, enabledLive: false },
      legal: { termsVersion: null, privacyVersion: null, links: [] },
      consent: { regime: "gdpr", bannerRequired: true, policyVersion: null, categories: [] },
      operations: { opsAlertEmail: null, bookingQueue: { number: 50, category: 0 } },
      version: 1,
      updatedAt: UPDATED.toISOString(),
    });
    expect(settingsEtagOf(settings.version)).toBe('"1"');
  });

  it("answers stored values the document cannot carry as storefront.get reads them, so the answer stays valid", () => {
    const settings = toStorefrontSettings(
      seededRow({
        primaryColor: "blue",
        theme: { colors: { accent: "#12345" }, fonts: { heading: "Comic Sans" }, cornerRadius: "round" },
        defaultLocale: "fr-fr",
        supportedLocales: ["en", "not a locale"],
        defaultCurrency: "gbp",
        supportedCurrencies: ["EUR"],
        markets: [{ countryCode: "GB", currency: "GBP", locale: "en" }, "junk", { countryCode: "GB" }],
        defaultMarket: "US",
        supportEmail: "not an address",
        supportDetails: { helpCenterUrl: "http://help.example", hours: "" },
        seo: { titleTemplate: "No placeholder" },
        legalLinks: [{ kind: "terms", label: "Terms", url: "javascript:alert(1)" }, { kind: "nope" }],
        consent: { categories: [{ id: "analytics", required: false, defaultEnabled: false, title: "" }] },
        acceptedCardBrands: ["NOT_A_BRAND"],
        bookingQueueNumber: 120,
      }),
    );

    expectValidSettings(settings);
    expect(settings.branding.colors).toMatchObject({ primary: "#1d4ed8", accent: "#0e7490" });
    expect(settings.branding.fonts.heading).toBe("Inter");
    expect(settings.branding.cornerRadius).toBe("medium");
    expect(settings.locales).toEqual({ default: "fr-FR", supported: ["fr-FR", "en"] });
    expect(settings.currencies).toEqual({ default: "GBP", supported: ["GBP", "EUR"] });
    expect(settings.markets).toEqual({
      default: "GB",
      list: [{ countryCode: "GB", name: "GB", currency: "GBP", locale: "en" }],
    });
    expect(settings.support).toMatchObject({ email: null, helpCenterUrl: null, hours: null });
    expect(settings.seo.titleTemplate).toBeNull();
    expect(settings.legal.links).toEqual([]);
    expect(settings.consent.categories).toEqual([]);
    expect(settings.policies.acceptedCardBrands).toEqual(["VISA", "MASTERCARD", "AMERICAN_EXPRESS"]);
    expect(settings.operations.bookingQueue.number).toBeNull();
  });

  it("knows the document's AmadeusPaymentBrand values", () => {
    expect([...PAYMENT_BRANDS]).toEqual(paymentBrands);
  });
});

describe("an update of the row", () => {
  const assets = [
    asset("logo"),
    asset("logo_dark", "webp"),
    asset("logo_square"),
    asset("favicon", "ico"),
    asset("og_image", "jpg"),
  ];
  const [logo, logoDark, logoSquare, favicon, ogImage] = assets.map((row) => row.id) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const update = fullUpdate({ logo, logoDark, logoSquare, favicon, ogImage });

  it("writes every section to its columns and reads them back as sent [OBE-070 AC1]", () => {
    const row = seededRow();
    const saved = applied(row, toSettingsChanges(update, row));
    const settings = toStorefrontSettings(saved);

    expectValidSettings(settings);
    for (const section of sectionsOf(update)) {
      expect([section, settings[section]]).toEqual([section, update[section]]);
    }
    expect(settings.version).toBe(2);
    expect(saved).toMatchObject({
      brandName: "Acme Travel",
      primaryColor: "#0B5FFF",
      secondaryColor: "#0F172A",
      theme: {
        colors: { accent: "#F59E0B", background: "#FFFFFF", text: "#111827" },
        fonts: { heading: "Montserrat", body: "Source Sans 3" },
        cornerRadius: "large",
      },
      guestCheckoutEnabled: false,
      features: { ancillaries: false, brandedFareUpsell: true, selfServiceCancellation: true },
      ticketingPolicy: "manual_review",
      autoIssue: false,
      supportDetails: { hours: "Mon–Fri 09:00–18:00", emergencyPhone: "+442071234500" },
      bookingQueueNumber: 42,
      bookingQueueCategory: 7,
    });
  });

  it("is what the next uncached storefront.get answers: branding, locales, currencies, markets, legal, support [OBE-070 AC1]", () => {
    const row = seededRow();
    const saved = applied(row, toSettingsChanges(update, row));
    const entry = toCachedStorefront({
      tenantKey: "alpha",
      tenantName: "Alpha Travel Holding",
      environment: "test",
      storefrontBaseDomain: "ota.example.com",
      settings: saved,
      assets,
      currencies: [
        { code: "GBP", name: "Pound Sterling", symbol: "£", minorUnits: 2 },
        { code: "EUR", name: "Euro", symbol: "€", minorUnits: 2 },
      ],
    });
    const config = storefrontFor(entry, { caller: "edge", publicApiUrl: "https://api.ota.example.com" });

    expect(checker.check("getStorefront", { status: 200, body: config })).toEqual([]);
    expect(config).toMatchObject({
      name: "Acme Travel",
      legalName: "Acme Travel Ltd",
      timeZone: "Europe/London",
      branding: {
        logoUrl: `/api/v1/assets/alpha/${logo}.png`,
        logoDarkUrl: `/api/v1/assets/alpha/${logoDark}.webp`,
        faviconUrl: `/api/v1/assets/alpha/${favicon}.ico`,
        colors: { primary: "#0B5FFF", secondary: "#0F172A", accent: "#F59E0B", text: "#111827" },
        fonts: { heading: { family: "Montserrat" }, body: { family: "Source Sans 3" } },
        cornerRadius: "large",
      },
      defaultLocale: "en",
      defaultCurrency: "GBP",
      defaultMarket: "GB",
      markets: [{ countryCode: "GB" }, { countryCode: "FR" }],
      features: { guestCheckout: false, ancillaries: false, brandedFareUpsell: true, autoIssue: false },
      legal: {
        termsUrl: "https://alpha.ota.example.com/p/terms",
        termsVersion: "2026-09",
        refundPolicyUrl: "https://www.acmetravel.example/refunds",
      },
      support: { email: "support@acmetravel.example", phone: "+442071234567" },
      seo: { titleTemplate: "%s | Acme Travel", ogImageUrl: `/api/v1/assets/alpha/${ogImage}.jpg` },
      version: 2,
    });
    expect(entry.airlineCardEnabled).toBe(true);
  });

  it("writes only the sections sent, keeps what the document does not show, and clears the legacy legal URLs", () => {
    const row = seededRow({
      theme: { colors: { primary: "#000000", surface: "#F1F5F9", error: "#B91C1C" }, spacing: "wide" },
      features: { seatMap: true, ancillaries: true },
      termsUrl: "https://old.example/terms",
      privacyUrl: "https://old.example/privacy",
    });
    const brandingOnly = applied(row, toSettingsChanges({ branding: update.branding }, row));
    const legalOnly = toSettingsChanges({ legal: update.legal }, row);

    expect(brandingOnly.theme).toEqual({
      colors: {
        surface: "#F1F5F9",
        error: "#B91C1C",
        accent: "#F59E0B",
        background: "#FFFFFF",
        text: "#111827",
      },
      spacing: "wide",
      fonts: { heading: "Montserrat", body: "Source Sans 3" },
      cornerRadius: "large",
    });
    expect(brandingOnly).toMatchObject({ brandName: "Alpha Travel", features: { seatMap: true } });
    expect(Object.keys(toSettingsChanges({ features: update.features }, row)).sort()).toEqual([
      "customer_accounts_enabled",
      "features",
      "guest_checkout_enabled",
    ]);
    expect(JSON.parse(String(toSettingsChanges({ features: update.features }, row).features))).toEqual({
      seatMap: true,
      ancillaries: false,
      brandedFareUpsell: true,
      selfServiceCancellation: true,
    });
    expect(legalOnly).toMatchObject({ terms_url: null, privacy_url: null });
    // jsonb arrays go as JSON text, never as a PostgreSQL array.
    expect(typeof legalOnly.legal_links).toBe("string");
  });

  it("replaces whole sections when merged with the saved settings", () => {
    const before = toStorefrontSettings(seededRow());
    const merged = mergeSettings(before, { currencies: update.currencies });

    expect(merged.currencies).toEqual(update.currencies);
    expect(merged.brand).toBe(before.brand);
    expect(sectionsOf({ seo: update.seo, brand: update.brand })).toEqual(["brand", "seo"]);
  });
});

describe("the rules of an update", () => {
  const logo = asset("logo");
  const favicon = asset("favicon", "ico");
  const ogImage = asset("og_image", "jpg");
  const before = toStorefrontSettings(seededRow());

  /** The refusal of `update` with everything found but what `lookups` says. */
  const refusal = (update: StorefrontSettingsUpdate, lookups: Partial<SettingsLookups> = {}) => {
    const merged = mergeSettings(before, update);
    const sent = new Set<SettingsSection>(sectionsOf(update));
    const found = settingsProblem(merged, sent, {
      ...everythingFound([logo, favicon, ogImage]),
      ...lookups,
    });
    return found === undefined ? undefined : [found.reason, found.path];
  };
  const full = fullUpdate({
    logo: logo.id,
    logoDark: logo.id,
    logoSquare: logo.id,
    favicon: favicon.id,
    ogImage: ogImage.id,
  });
  const branding = { ...full.branding, logoDarkAssetId: null, logoSquareAssetId: null };

  it("accepts the full settings and the new tenant's own", () => {
    expect(refusal({ ...full, branding })).toBeUndefined();
    const { version: _version, updatedAt: _updatedAt, ...unchanged } = before;
    expect(refusal(unchanged)).toBeUndefined();
  });

  it("refuses paymentTiming other than authorize_before_booking [OBE-070 AC2]", () => {
    for (const paymentTiming of ["pay_later", "capture_before_booking"] as const) {
      expect(refusal({ policies: { ...full.policies, paymentTiming } })).toEqual([
        "payment_timing_not_supported",
        "/policies/paymentTiming",
      ]);
    }
  });

  it("checks currencies, time zones and countries against the reference data", () => {
    expect(refusal({ brand: full.brand }, { timeZones: new Set() })).toEqual([
      "unknown_time_zone",
      "/brand/timeZone",
    ]);
    expect(refusal({ currencies: { default: "JPY", supported: ["JPY"] } })).toEqual([
      "unknown_currency",
      "/currencies/default",
    ]);
    expect(refusal({ currencies: { default: "EUR", supported: ["EUR", "JPY"] } })).toEqual([
      "unknown_currency",
      "/currencies/supported/1",
    ]);
    // 3 minor units do not fit the numeric(12,2) money columns, and flights.search refuses such a currency.
    expect(refusal({ currencies: { default: "KWD", supported: ["KWD"] } })).toEqual([
      "currency_not_supported",
      "/currencies/default",
    ]);
    expect(refusal({ currencies: { default: "EUR", supported: ["EUR", "GBP", "KWD"] } })).toEqual([
      "currency_not_supported",
      "/currencies/supported/2",
    ]);
    expect(
      refusal(
        {
          markets: {
            default: null,
            list: [{ countryCode: "DE", name: "Germany", currency: "EUR", locale: "en" }],
          },
        },
        { countries: new Set(["GB"]) },
      ),
    ).toEqual(["unknown_country", "/markets/list/0/countryCode"]);
  });

  it("requires every supported list to contain its default", () => {
    expect(refusal({ locales: { default: "fr", supported: ["en"] } })).toEqual([
      "default_not_supported",
      "/locales/supported",
    ]);
    expect(refusal({ currencies: { default: "EUR", supported: ["GBP"] } })).toEqual([
      "default_not_supported",
      "/currencies/supported",
    ]);
  });

  it("checks the markets against the supported currencies and locales they will have", () => {
    const gb = { countryCode: "GB", name: "United Kingdom", currency: "GBP", locale: "en" };
    expect(refusal({ markets: { default: "GB", list: [gb] } })).toEqual([
      "market_currency_not_supported",
      "/markets/list/0/currency",
    ]);
    expect(
      refusal({ currencies: full.currencies, markets: { default: "GB", list: [{ ...gb, locale: "fr" }] } }),
    ).toEqual(["market_locale_not_supported", "/markets/list/0/locale"]);
    expect(refusal({ currencies: full.currencies, markets: { default: "FR", list: [gb] } })).toEqual([
      "market_not_listed",
      "/markets/default",
    ]);
    expect(refusal({ currencies: full.currencies, markets: { default: "GB", list: [gb, gb] } })).toEqual([
      "duplicate_market",
      "/markets/list/1/countryCode",
    ]);
    // Removing a currency that a saved market uses is refused at that market.
    const withMarkets = mergeSettings(before, { currencies: full.currencies, markets: full.markets });
    expect(
      settingsProblem(
        mergeSettings(withMarkets, { currencies: { default: "GBP", supported: ["GBP"] } }),
        new Set<SettingsSection>(["currencies"]),
        everythingFound(),
      ),
    ).toMatchObject({ reason: "market_currency_not_supported", path: "/markets/list/1/currency" });
  });

  it("requires asset ids of the right kind and page slugs that exist", () => {
    expect(refusal({ branding: { ...branding, faviconAssetId: logo.id } })).toEqual([
      "asset_kind",
      "/branding/faviconAssetId",
    ]);
    expect(refusal({ branding: { ...branding, logoAssetId: newId("ast") } })).toEqual([
      "asset_not_found",
      "/branding/logoAssetId",
    ]);
    expect(refusal({ seo: { ...full.seo, ogImageAssetId: logo.id } })).toEqual([
      "asset_kind",
      "/seo/ogImageAssetId",
    ]);
    expect(
      refusal({
        legal: {
          ...full.legal,
          links: [...full.legal.links, { kind: "privacy", label: "P", pageSlug: "gone" }],
        },
      }),
    ).toEqual(["page_not_found", "/legal/links/2/pageSlug"]);
  });

  it("allows each cookie category once and only necessary as required", () => {
    const [necessary, analytics] = full.consent.categories as [
      (typeof full.consent.categories)[number],
      (typeof full.consent.categories)[number],
    ];
    expect(refusal({ consent: { ...full.consent, categories: [necessary, necessary] } })).toEqual([
      "duplicate_consent_category",
      "/consent/categories/1/id",
    ]);
    expect(
      refusal({ consent: { ...full.consent, categories: [necessary, { ...analytics, required: true }] } }),
    ).toEqual(["consent_category_required", "/consent/categories/1/required"]);
  });

  it("looks up only what the sections sent refer to", () => {
    const merged = mergeSettings(before, { currencies: full.currencies, seo: full.seo });

    expect(lookupsFor(merged, new Set<SettingsSection>(["currencies", "seo"]))).toEqual({
      timeZones: [],
      currencies: ["GBP", "EUR"],
      countries: [],
      assetIds: [ogImage.id],
      pageSlugs: [],
    });
  });

  it("names the airline-card flags turned on", () => {
    const off = toStorefrontSettings(seededRow());
    const on = mergeSettings(off, { airlineCard: { enabledTest: true, enabledLive: true } });

    expect(airlineCardTurnedOn(off, on)).toEqual(["/airlineCard/enabledTest", "/airlineCard/enabledLive"]);
    expect(airlineCardTurnedOn(on, on)).toEqual([]);
  });
});

/** The storefront.get entries and the content pages' caches of `locales` in both environments (OBE-072). */
const cacheKeysOf = (locales: readonly string[]): string[] =>
  ["test", "live"]
    .flatMap((environment) => [
      `t:${TENANT_ID}:${environment}:sf:und`,
      ...locales.flatMap((locale) => [
        `t:${TENANT_ID}:${environment}:sf:${locale}`,
        `t:${TENANT_ID}:${environment}:pages:${locale}`,
      ]),
    ])
    .sort();

describe("the storefront.get entries a change deletes", () => {
  it("are sf:und and every locale before and after, in both environments, with the content pages' caches of those locales [OBE-072]", () => {
    const keys = storefrontCacheKeys(TENANT_ID, [
      seededRow({ defaultLocale: "en", supportedLocales: ["en", "fr-fr"] }),
      seededRow({ defaultLocale: "en", supportedLocales: ["en", "de"] }),
    ]);

    expect([...keys].sort()).toEqual(cacheKeysOf(["en", "fr-FR", "de"]));
  });
});

/* ------------------------------------------------------------------------------------------------
 * The service
 * ---------------------------------------------------------------------------------------------- */

const TRX = { transaction: "alpha" } as unknown as TenantTransaction;
const TENANT: RequestTenant = {
  tenantId: TENANT_ID,
  key: "alpha",
  schemaName: "tenant_alpha" as TenantSchema,
  environment: "test",
  caller: { type: "service", id: "service" },
  actor: { type: "staff", id: "stf_01JA4CH3G1K4N7R0V3X6A9D2F6" },
  requestId: "req-settings-1",
};

/** The repository on one in-memory row, with the SQL's semantics for the version and the lookups. */
class MemoryRepository {
  row: StorefrontSettingsEditRow | undefined = seededRow();
  readonly assets: StorefrontAssetRow[] = [];
  amountAddingRules = false;
  readonly calls: string[] = [];

  editableSettings(
    trx: TenantTransaction,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<StorefrontSettingsEditRow | undefined> {
    expect(trx).toBe(TRX);
    this.calls.push(options.forUpdate === true ? "editableSettings:forUpdate" : "editableSettings");
    return Promise.resolve(this.row);
  }

  updateSettings(
    _trx: TenantTransaction,
    version: number,
    changes: StorefrontSettingsChanges,
  ): Promise<StorefrontSettingsEditRow | undefined> {
    this.calls.push("updateSettings");
    if (this.row === undefined || this.row.version !== version) {
      return Promise.resolve(undefined);
    }
    this.row = applied(this.row, changes);
    return Promise.resolve(this.row);
  }

  timeZoneExists(_trx: TenantTransaction, name: string): Promise<boolean> {
    return Promise.resolve(["UTC", "Europe/London"].includes(name));
  }

  activeCurrencies(
    _trx: TenantTransaction,
    codes: readonly string[],
  ): Promise<Array<{ code: string; minorUnits: number }>> {
    return Promise.resolve(
      codes.flatMap((code) => {
        const minorUnits = ACTIVE_CURRENCIES.get(code);
        return minorUnits === undefined ? [] : [{ code, minorUnits }];
      }),
    );
  }

  countryCodes(_trx: TenantTransaction, codes: readonly string[]): Promise<string[]> {
    return Promise.resolve(codes.filter((code) => ["GB", "FR", "US"].includes(code)));
  }

  assetsByIds(_trx: TenantTransaction, ids: readonly string[]): Promise<StorefrontAssetRow[]> {
    return Promise.resolve(this.assets.filter((row) => ids.includes(row.id)));
  }

  pageSlugs(_trx: TenantTransaction, slugs: readonly string[]): Promise<string[]> {
    return Promise.resolve(slugs.filter((slug) => slug === "terms"));
  }

  hasAmountAddingRules(_trx: TenantTransaction, now: Date): Promise<boolean> {
    expect(now).toEqual(NOW);
    this.calls.push("hasAmountAddingRules");
    return Promise.resolve(this.amountAddingRules);
  }
}

interface Harness {
  readonly service: StorefrontSettingsService;
  readonly repository: MemoryRepository;
  readonly records: StaffActionEntry[];
  readonly del: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly transactions: () => number;
}

function harness(options: { airlineCardSwitch?: boolean; redisFails?: boolean } = {}): Harness {
  const repository = new MemoryRepository();
  const records: StaffActionEntry[] = [];
  let transactions = 0;
  const tx = {
    run: async <T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> => {
      transactions += 1;
      // A failure rolls the row back, as PostgreSQL would.
      const saved = repository.row;
      try {
        return await fn(TRX);
      } catch (error) {
        repository.row = saved;
        throw error;
      }
    },
  } as unknown as TenantTx;
  const writer = {
    record: (trx: TenantTransaction, entry: StaffActionEntry): Promise<void> => {
      expect(trx).toBe(TRX);
      records.push(entry);
      return Promise.resolve();
    },
  } as unknown as StaffActionsWriter;
  const del = vi.fn(() =>
    options.redisFails === true ? Promise.reject(new Error("Connection is closed.")) : Promise.resolve(1),
  );
  const warn = vi.fn();
  const config = {
    get: (name: string) => (name === "AIRLINE_CARD_ENABLED" ? options.airlineCardSwitch === true : undefined),
  } as unknown as ConfigService<ApiConfig, true>;
  const service = new StorefrontSettingsService(
    tx,
    { require: () => TENANT } as unknown as TenantContext,
    repository as unknown as StorefrontRepository,
    writer,
    { now: () => NOW } as unknown as Clock,
    { del } as unknown as Redis,
    config,
    { warn } as unknown as PinoLogger,
  );
  return { service, repository, records, del, warn, transactions: () => transactions };
}

/** The AppError `promise` rejects with, as `[code, details]`. */
async function refusalOf(promise: Promise<unknown>): Promise<[string, unknown]> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return [(error as AppError).code, (error as AppError).details];
}

describe("StorefrontSettingsService", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it("gets the row, and answers a tenant without one as not ready", async () => {
    expectValidSettings(await h.service.get());

    h.repository.row = undefined;
    expect(await refusalOf(h.service.get())).toEqual(["TENANT_SUSPENDED", undefined]);
  });

  it("saves the sections sent at version + 1, audits them and deletes the storefront.get entries of both environments [OBE-070 AC1]", async () => {
    const result = await h.service.update(
      {
        branding: {
          ...toStorefrontSettings(seededRow()).branding,
          colors: {
            primary: "#0B5FFF",
            secondary: "#0F172A",
            accent: "#F59E0B",
            background: "#FFFFFF",
            text: "#111827",
          },
        },
        locales: { default: "en", supported: ["en", "fr"] },
      },
      '"1"',
    );

    expect(checker.check("consoleUpdateStorefrontSettings", { status: 200, body: result })).toEqual([]);
    expect(result).toMatchObject({ version: 2, warnings: [], branding: { colors: { primary: "#0B5FFF" } } });
    expect(h.repository.calls).toEqual(["editableSettings:forUpdate", "updateSettings"]);
    expect(h.records).toEqual([
      {
        action: "settings.storefront.update",
        targetType: "storefront_settings",
        targetId: "sfs_default",
        before: {
          version: 1,
          branding: expect.objectContaining({ colors: expect.objectContaining({ primary: "#1d4ed8" }) }),
          locales: { default: "en", supported: ["en"] },
        },
        after: {
          version: 2,
          branding: expect.objectContaining({ colors: expect.objectContaining({ primary: "#0B5FFF" }) }),
          locales: { default: "en", supported: ["en", "fr"] },
        },
      },
    ]);
    expect(h.del).toHaveBeenCalledTimes(1);
    expect([...(h.del.mock.calls[0] as string[])].sort()).toEqual(cacheKeysOf(["en", "fr"]));
  });

  it("takes If-Match quoted, weak or bare, and answers a stale one 412 without writing", async () => {
    await h.service.update({ airlineCard: { enabledTest: true, enabledLive: false } }, 'W/"1"');
    await h.service.update({ airlineCard: { enabledTest: false, enabledLive: false } }, "2");

    expect(
      await refusalOf(h.service.update({ airlineCard: { enabledTest: true, enabledLive: false } }, '"2"')),
    ).toEqual(["PRECONDITION_FAILED", undefined]);
    expect(h.repository.row?.version).toBe(3);
    expect(h.records).toHaveLength(2);
    expect(h.del).toHaveBeenCalledTimes(2);
  });

  it("answers paymentTiming pay_later 422 UNPROCESSABLE and writes nothing [OBE-070 AC2]", async () => {
    const policies = { ...toStorefrontSettings(seededRow()).policies, paymentTiming: "pay_later" as const };

    expect(await refusalOf(h.service.update({ policies }, '"1"'))).toEqual([
      "UNPROCESSABLE",
      { reason: "payment_timing_not_supported", path: "/policies/paymentTiming" },
    ]);
    expect(h.repository.row?.version).toBe(1);
    expect(h.records).toEqual([]);
    expect(h.del).not.toHaveBeenCalled();
  });

  it("answers a currency the money columns cannot hold 422 currency_not_supported, from the repository's minor units", async () => {
    expect(
      await refusalOf(h.service.update({ currencies: { default: "EUR", supported: ["EUR", "KWD"] } }, '"1"')),
    ).toEqual(["UNPROCESSABLE", { reason: "currency_not_supported", path: "/currencies/supported/1" }]);
    expect(h.repository.row?.supportedCurrencies).toEqual(["EUR"]);
  });

  it("answers turning enabledLive on 403 FEATURE_DISABLED while AIRLINE_CARD_ENABLED is off, and writes nothing [OBE-070 AC2] [FIX-W35-OTA AC6]", async () => {
    expect(
      await refusalOf(h.service.update({ airlineCard: { enabledTest: false, enabledLive: true } }, '"1"')),
    ).toEqual(["FEATURE_DISABLED", { feature: "airlineCard" }]);
    // Since FIX-W35-OTA the refusal compares with the stored flag, read in the update's transaction: nothing is
    // written, audited or deleted.
    expect(h.repository.calls).toEqual(["editableSettings:forUpdate"]);
    expect(h.repository.row?.version).toBe(1);
    expect(h.records).toEqual([]);
    expect(h.del).not.toHaveBeenCalled();

    const on = harness({ airlineCardSwitch: true });
    const result = await on.service.update({ airlineCard: { enabledTest: false, enabledLive: true } }, '"1"');
    expect(result.airlineCard).toEqual({ enabledTest: false, enabledLive: true, liveAvailable: true });
  });

  it("[FIX-W35-OTA AC6] passes a save that keeps a stored enabledLive true, or sets it false, while the switch is off", async () => {
    // The live card was turned on while the switch was on; then the switch went off.
    h.repository.row = { ...seededRow(), airlineCardEnabledLive: true };

    const kept = await h.service.update({ airlineCard: { enabledTest: true, enabledLive: true } }, '"1"');
    expect(kept.airlineCard).toEqual({ enabledTest: true, enabledLive: true, liveAvailable: false });
    expect(h.repository.row?.airlineCardEnabledLive).toBe(true);

    const off = await h.service.update({ airlineCard: { enabledTest: true, enabledLive: false } }, '"2"');
    expect(off.airlineCard).toEqual({ enabledTest: true, enabledLive: false, liveAvailable: false });
    expect(h.repository.row?.airlineCardEnabledLive).toBe(false);
    expect(h.records).toHaveLength(2);

    // Turned off, it cannot be turned on again while the switch is off.
    expect(
      await refusalOf(h.service.update({ airlineCard: { enabledTest: true, enabledLive: true } }, '"3"')),
    ).toEqual(["FEATURE_DISABLED", { feature: "airlineCard" }]);
    expect(checker.check("consoleUpdateStorefrontSettings", { status: 200, body: off })).toEqual([]);
  });

  it("[FIX-W35-OTA AC5] answers liveAvailable from the switch on get and update, and ignores a value sent", async () => {
    expect((await h.service.get()).airlineCard).toEqual({
      enabledTest: false,
      enabledLive: false,
      liveAvailable: false,
    });
    const on = harness({ airlineCardSwitch: true });
    const got = await on.service.get();
    expect(got.airlineCard.liveAvailable).toBe(true);
    expect(checker.check("consoleGetStorefrontSettings", { status: 200, body: got })).toEqual([]);

    // A client that sends the section back as get answered it: `liveAvailable` is neither stored nor audited, and the
    // answer carries the switch, not the value sent.
    const result = await h.service.update(
      { airlineCard: { enabledTest: true, enabledLive: false, liveAvailable: true } },
      '"1"',
    );
    expect(result.airlineCard).toEqual({ enabledTest: true, enabledLive: false, liveAvailable: false });
    expect(h.records).toEqual([
      expect.objectContaining({
        before: { version: 1, airlineCard: { enabledTest: false, enabledLive: false } },
        after: { version: 2, airlineCard: { enabledTest: true, enabledLive: false } },
      }),
    ]);
  });

  it("warns when the airline card is turned on while amount-adding rules are active, and only then", async () => {
    const without = await h.service.update({ airlineCard: { enabledTest: true, enabledLive: false } }, '"1"');
    h.repository.amountAddingRules = true;
    const again = await h.service.update({ airlineCard: { enabledTest: true, enabledLive: false } }, '"2"');
    const other = await h.service.update(
      { brand: { name: "Alpha", legalName: null, timeZone: "UTC" } },
      '"3"',
    );
    const on = harness({ airlineCardSwitch: true });
    on.repository.amountAddingRules = true;
    const both = await on.service.update({ airlineCard: { enabledTest: true, enabledLive: true } }, '"1"');

    expect(without.warnings).toEqual([]);
    expect(again.warnings).toEqual([]);
    expect(other.warnings).toEqual([]);
    expect(both.warnings).toEqual([
      expect.objectContaining({ code: "airline_card_net_price", path: "/airlineCard/enabledTest" }),
      expect.objectContaining({ code: "airline_card_net_price", path: "/airlineCard/enabledLive" }),
    ]);
    expect(checker.check("consoleUpdateStorefrontSettings", { status: 200, body: both })).toEqual([]);
    // The rules are read only when a flag is turned on.
    expect(h.repository.calls.filter((call) => call === "hasAmountAddingRules")).toHaveLength(1);
  });

  it("answers the saved change when Redis cannot delete the entries, and logs it without the keys", async () => {
    const offline = harness({ redisFails: true });

    const result = await offline.service.update(
      { airlineCard: { enabledTest: true, enabledLive: false } },
      '"1"',
    );

    expect(result.version).toBe(2);
    // sf:und, sf:en and the content pages' pages:en (OBE-072), in both environments.
    expect(offline.warn).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, keys: 6 },
      "storefront_settings.cache_not_deleted",
    );
  });

  it("answers a missing row 403 TENANT_SUSPENDED", async () => {
    h.repository.row = undefined;

    expect(
      await refusalOf(h.service.update({ airlineCard: { enabledTest: true, enabledLive: false } }, '"1"')),
    ).toEqual(["TENANT_SUSPENDED", undefined]);
  });
});
