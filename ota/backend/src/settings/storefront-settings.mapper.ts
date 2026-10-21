// The console's storefront settings (console.settings.storefront.get and update, OBE-070; api-changes part 2 §2.3,
// OADR-0012 points 1, 4, 6 and 7): the tenant's single `storefront_settings` row ↔ `StorefrontSettings` of the OTA
// document, section by section.
//
//   brand        brand_name, legal_name, time_zone
//   branding     logo_asset_id, logo_dark_asset_id, logo_square_asset_id, favicon_asset_id, primary_color,
//                secondary_color, theme {colors: {accent, background, text}, fonts: {heading, body}, cornerRadius}
//   locales      default_locale, supported_locales
//   currencies   default_currency, supported_currencies
//   markets      default_market, markets [{countryCode, name, currency, locale}]
//   features     guest_checkout_enabled, customer_accounts_enabled,
//                features {ancillaries, brandedFareUpsell, selfServiceCancellation}
//   policies     ticketing_policy, payment_timing, require_3ds, accepted_card_brands, require_email_verification,
//                offer_ttl_minutes, checkout_ttl_minutes
//   airlineCard  airline_card_enabled_test, airline_card_enabled_live
//   legal        terms_version, privacy_version, legal_links [{kind, label, url} | {kind, label, pageSlug}]
//   support      support_email, support_phone, support_details {hours, helpCenterUrl, emergencyPhone}
//   seo          seo {titleTemplate, defaultTitle, defaultDescription, robots: {index, follow}}, og_image_asset_id
//   consent      consent {regime, bannerRequired, policyVersion, categories}
//   operations   ops_alert_email, booking_queue_number, booking_queue_category
//
// The jsonb shapes are those storefront.get reads (storefront.repository.ts header), so a saved change is what the next
// uncached storefront.get answers. Writing a jsonb section keeps the keys of the stored object that the document does
// not show (the extra theme colours `surface`, `mutedText`, `success`, `warning` and `error` of storefront.get, for
// example), so the console never erases what it cannot edit; it drops `primary` and `secondary` from `theme.colors`,
// whose columns win anyway. Writing `legal` clears the baseline's `terms_url` and `privacy_url`, which storefront.get
// would otherwise use when the links have no terms or privacy link: the console's links are the only legal links.
//
// Reading is defensive, as storefront.mapper.ts reads the row: a stored value the document cannot carry (written by an
// older version or by hand) is answered as the value storefront.get uses instead (the neutral colours and the Inter
// font of the storefront build, the default locale and currency in their supported lists, the protective GDPR banner),
// or as null where the document allows it, so the answer always validates and saving it back is accepted.
import type { components } from "@velexis/api-types";
import {
  BUNDLED_FONTS,
  canonicalLocale,
  DEFAULT_CORNER_RADIUS,
  DEFAULT_FEATURES,
  DEFAULT_FONT,
  NEUTRAL_COLORS,
} from "../storefront/storefront.mapper";
import type {
  StorefrontSettingsChanges,
  StorefrontSettingsEditRow,
} from "../storefront/storefront.repository";

type Schemas = components["schemas"];
export type StorefrontSettings = Schemas["StorefrontSettings"];
export type StorefrontSettingsUpdate = Schemas["StorefrontSettingsUpdate"];
export type StorefrontSettingsUpdateResult = Schemas["StorefrontSettingsUpdateResult"];
export type SettingsWarning = Schemas["SettingsWarning"];
type Branding = Schemas["StorefrontSettingsBranding"];
type Market = Schemas["StorefrontSettingsMarket"];
type Policies = Schemas["StorefrontSettingsPolicies"];
type LegalLink = Schemas["StorefrontLegalLink"];
type LegalLinkKind = Schemas["StorefrontLegalLinkKind"];
type Consent = Schemas["StorefrontSettingsConsent"];
type ConsentCategory = Schemas["StorefrontSettingsConsentCategory"];
type PaymentBrand = Schemas["AmadeusPaymentBrand"];

/** A top-level section of the settings, which an update replaces as a whole. */
export type SettingsSection = keyof StorefrontSettingsUpdate;

/** The sections in the document's order: the order in which an update is checked and audited. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = Object.freeze([
  "brand",
  "branding",
  "locales",
  "currencies",
  "markets",
  "features",
  "policies",
  "airlineCard",
  "legal",
  "support",
  "seo",
  "consent",
  "operations",
]);

/** `Cache-Control` of both answers: the OTA's own configuration, for one staff member. */
export const STOREFRONT_SETTINGS_CACHE_CONTROL = "private, no-store";

/** The settings ETag: `"<version>"` (the If-Match of console.settings.storefront.update). */
export const settingsEtagOf = (version: number): string => `"${version}"`;

/* ------------------------------------------------------------------------------------------------
 * Small parsers
 * ---------------------------------------------------------------------------------------------- */

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** A string of at most `maxLength` characters, or null (an empty one too, when `minLength` is 1). */
function text(value: unknown, maxLength: number, minLength = 1): string | null {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength ? value : null;
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const LOCALE_CODE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const PAGE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ASSET_ID = /^ast_[0-9A-Za-z]{16,40}$/;
/** The `email` format of ajv-formats, which the document's `format: email` means (as storefront.mapper.ts). */
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

const matching = (value: unknown, pattern: RegExp): string | null =>
  typeof value === "string" && pattern.test(value) ? value : null;

/** An https URL as stored (the document's `format: uri` with `^https://`), or null. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("https://")) {
    return null;
  }
  try {
    return new URL(value).hostname === "" ? null : value;
  } catch {
    return null;
  }
}

/** A LocaleCode of the document (`en`, `fr-CA`) from a stored tag, or `undefined`. */
function localeCode(value: unknown): string | undefined {
  const canonical = canonicalLocale(value);
  return canonical !== undefined && LOCALE_CODE.test(canonical) ? canonical : undefined;
}

/** `values` without repeats, `first` at the front when it was missing. */
function withDefault(first: string, values: readonly string[]): string[] {
  return [...new Set(values.includes(first) ? values : [first, ...values])];
}

/* ------------------------------------------------------------------------------------------------
 * Row → StorefrontSettings
 * ---------------------------------------------------------------------------------------------- */

const CORNER_RADII: readonly Branding["cornerRadius"][] = ["none", "small", "medium", "large"];
const TICKETING_POLICIES: readonly Policies["ticketingPolicy"][] = [
  "issue_after_payment",
  "issue_at_booking",
  "manual_review",
];
const PAYMENT_TIMINGS: readonly Policies["paymentTiming"][] = [
  "authorize_before_booking",
  "capture_before_booking",
  "pay_later",
];
/** The `AmadeusPaymentBrand` values (a unit test compares them with the document). */
export const PAYMENT_BRANDS: readonly PaymentBrand[] = Object.freeze([
  "VISA",
  "AMERICAN_EXPRESS",
  "MASTERCARD",
  "VISA_ELECTRON",
  "VISA_DEBIT",
  "MASTERCARD_DEBIT",
  "MAESTRO",
  "DINERS",
  "MASTERCARD_IXARIS",
  "VISA_IXARIS",
  "MASTERCARD_AIRPLUS",
  "UATP_AIRPLUS",
  "PYTON",
]);
/** `accepted_card_brands` of the baseline's column default, for a row whose list holds no known brand. */
const DEFAULT_CARD_BRANDS: readonly PaymentBrand[] = ["VISA", "MASTERCARD", "AMERICAN_EXPRESS"];
const LEGAL_LINK_KINDS: readonly LegalLinkKind[] = [
  "terms",
  "privacy",
  "cookies",
  "refund_policy",
  "imprint",
  "accessibility",
  "other",
];
const CONSENT_REGIMES: readonly Consent["regime"][] = ["gdpr", "ccpa", "lgpd", "none"];
const CONSENT_CATEGORY_IDS: readonly ConsentCategory["id"][] = [
  "necessary",
  "preferences",
  "analytics",
  "marketing",
];

function brandingOf(row: StorefrontSettingsEditRow): Branding {
  const theme = isRecord(row.theme) ? row.theme : {};
  const colors = isRecord(theme["colors"]) ? theme["colors"] : {};
  const fonts = isRecord(theme["fonts"]) ? theme["fonts"] : {};
  const color = (name: "primary" | "secondary" | "accent" | "background" | "text"): string =>
    matching(colors[name], HEX_COLOR) ?? NEUTRAL_COLORS[name];
  const font = (value: unknown): Branding["fonts"]["heading"] =>
    isOneOf(value, BUNDLED_FONTS) ? value : DEFAULT_FONT;
  const asset = (id: string | null): string | null => matching(id, ASSET_ID);
  return {
    logoAssetId: asset(row.logoAssetId),
    logoDarkAssetId: asset(row.logoDarkAssetId),
    logoSquareAssetId: asset(row.logoSquareAssetId),
    faviconAssetId: asset(row.faviconAssetId),
    colors: {
      primary: matching(row.primaryColor, HEX_COLOR) ?? color("primary"),
      secondary: matching(row.secondaryColor, HEX_COLOR) ?? color("secondary"),
      accent: color("accent"),
      background: color("background"),
      text: color("text"),
    },
    fonts: { heading: font(fonts["heading"]), body: font(fonts["body"]) },
    cornerRadius: isOneOf(theme["cornerRadius"], CORNER_RADII)
      ? theme["cornerRadius"]
      : DEFAULT_CORNER_RADIUS,
  };
}

function localesOf(row: StorefrontSettingsEditRow): StorefrontSettings["locales"] {
  const fallback = localeCode(row.defaultLocale) ?? "en";
  const supported = row.supportedLocales.flatMap((locale) => localeCode(locale) ?? []);
  return { default: fallback, supported: withDefault(fallback, supported).slice(0, 20) };
}

function currenciesOf(row: StorefrontSettingsEditRow): StorefrontSettings["currencies"] {
  const upper = (code: string): string => code.trim().toUpperCase();
  const fallback = matching(upper(row.defaultCurrency), CURRENCY_CODE) ?? "EUR";
  const supported = row.supportedCurrencies.flatMap((code) => matching(upper(code), CURRENCY_CODE) ?? []);
  return { default: fallback, supported: withDefault(fallback, supported).slice(0, 20) };
}

function marketsOf(row: StorefrontSettingsEditRow): StorefrontSettings["markets"] {
  const seen = new Set<string>();
  const list = (Array.isArray(row.markets) ? (row.markets as unknown[]) : []).flatMap((item): Market[] => {
    if (!isRecord(item)) {
      return [];
    }
    const countryCode = matching(item["countryCode"], COUNTRY_CODE);
    const currency = matching(item["currency"], CURRENCY_CODE);
    const locale = localeCode(item["locale"]);
    if (countryCode === null || seen.has(countryCode) || currency === null || locale === undefined) {
      return [];
    }
    seen.add(countryCode);
    return [{ countryCode, name: text(item["name"], 80) ?? countryCode, currency, locale }];
  });
  const configured = row.defaultMarket?.trim() ?? null;
  const fallback =
    list.find((market) => market.countryCode === configured)?.countryCode ?? list[0]?.countryCode ?? null;
  return { default: fallback, list: list.slice(0, 50) };
}

function featuresOf(row: StorefrontSettingsEditRow): StorefrontSettings["features"] {
  const features = isRecord(row.features) ? row.features : {};
  const flag = (name: keyof typeof DEFAULT_FEATURES): boolean => {
    const value = features[name];
    return typeof value === "boolean" ? value : DEFAULT_FEATURES[name];
  };
  return {
    guestCheckout: row.guestCheckoutEnabled,
    customerAccounts: row.customerAccountsEnabled,
    ancillaries: flag("ancillaries"),
    brandedFareUpsell: flag("brandedFareUpsell"),
    // Off unless the OTA turns it on (bookings/customer-bookings.service.ts): a cancellation moves money.
    selfServiceCancellation: features["selfServiceCancellation"] === true,
  };
}

function policiesOf(row: StorefrontSettingsEditRow): Policies {
  const brands = [...new Set(row.acceptedCardBrands)].filter((brand): brand is PaymentBrand =>
    isOneOf(brand, PAYMENT_BRANDS),
  );
  return {
    ticketingPolicy: isOneOf(row.ticketingPolicy, TICKETING_POLICIES)
      ? row.ticketingPolicy
      : "issue_after_payment",
    paymentTiming: isOneOf(row.paymentTiming, PAYMENT_TIMINGS)
      ? row.paymentTiming
      : "authorize_before_booking",
    require3ds: row.require3ds,
    acceptedCardBrands: brands.length > 0 ? brands : [...DEFAULT_CARD_BRANDS],
    requireEmailVerification: row.requireEmailVerification,
    offerTtlMinutes: row.offerTtlMinutes,
    checkoutTtlMinutes: row.checkoutTtlMinutes,
  };
}

function legalLinksOf(value: unknown): LegalLink[] {
  return (Array.isArray(value) ? (value as unknown[]) : []).flatMap((item): LegalLink[] => {
    if (!isRecord(item) || !isOneOf(item["kind"], LEGAL_LINK_KINDS)) {
      return [];
    }
    const label = text(item["label"], 80);
    const pageSlug = typeof item["pageSlug"] === "string" ? item["pageSlug"] : undefined;
    if (label === null) {
      return [];
    }
    if (pageSlug !== undefined) {
      return pageSlug.length <= 64 && PAGE_SLUG.test(pageSlug)
        ? [{ kind: item["kind"], label, pageSlug }]
        : [];
    }
    const url = httpsUrl(item["url"]);
    return url === null ? [] : [{ kind: item["kind"], label, url }];
  });
}

function supportOf(row: StorefrontSettingsEditRow): StorefrontSettings["support"] {
  const details = isRecord(row.supportDetails) ? row.supportDetails : {};
  return {
    email: matching(row.supportEmail, EMAIL),
    phone: matching(row.supportPhone, E164),
    hours: text(details["hours"], 200),
    helpCenterUrl: httpsUrl(details["helpCenterUrl"]),
    emergencyPhone: matching(details["emergencyPhone"], E164),
  };
}

function seoOf(row: StorefrontSettingsEditRow): StorefrontSettings["seo"] {
  const seo = isRecord(row.seo) ? row.seo : {};
  const robots = isRecord(seo["robots"]) ? seo["robots"] : {};
  const template = text(seo["titleTemplate"], 120);
  return {
    titleTemplate: template?.includes("%s") === true ? template : null,
    defaultTitle: text(seo["defaultTitle"], 120),
    defaultDescription: text(seo["defaultDescription"], 300),
    ogImageAssetId: matching(row.ogImageAssetId, ASSET_ID),
    robots: {
      index: typeof robots["index"] === "boolean" ? robots["index"] : true,
      follow: typeof robots["follow"] === "boolean" ? robots["follow"] : true,
    },
  };
}

function consentOf(row: StorefrontSettingsEditRow): Consent {
  const consent = isRecord(row.consent) ? row.consent : {};
  const seen = new Set<string>();
  const categories = (
    Array.isArray(consent["categories"]) ? (consent["categories"] as unknown[]) : []
  ).flatMap((item): ConsentCategory[] => {
    if (
      !isRecord(item) ||
      !isOneOf(item["id"], CONSENT_CATEGORY_IDS) ||
      seen.has(item["id"]) ||
      typeof item["required"] !== "boolean" ||
      typeof item["defaultEnabled"] !== "boolean"
    ) {
      return [];
    }
    const title = text(item["title"], 80);
    if (title === null) {
      return [];
    }
    seen.add(item["id"]);
    return [
      {
        id: item["id"],
        required: item["required"],
        defaultEnabled: item["defaultEnabled"],
        title,
        description: text(item["description"], 500, 0) ?? "",
      },
    ];
  });
  return {
    // Without a configured policy: the protective default storefront.get uses, a GDPR banner.
    regime: isOneOf(consent["regime"], CONSENT_REGIMES) ? consent["regime"] : "gdpr",
    bannerRequired: typeof consent["bannerRequired"] === "boolean" ? consent["bannerRequired"] : true,
    policyVersion: text(consent["policyVersion"], 40),
    categories,
  };
}

/** The settings row as the console edits it (see the file header). */
export function toStorefrontSettings(row: StorefrontSettingsEditRow): StorefrontSettings {
  const queue = row.bookingQueueNumber;
  return {
    brand: {
      name: row.brandName.slice(0, 120),
      legalName: text(row.legalName, 200, 0),
      timeZone: row.timeZone.slice(0, 64),
    },
    branding: brandingOf(row),
    locales: localesOf(row),
    currencies: currenciesOf(row),
    markets: marketsOf(row),
    features: featuresOf(row),
    policies: policiesOf(row),
    airlineCard: { enabledTest: row.airlineCardEnabledTest, enabledLive: row.airlineCardEnabledLive },
    legal: {
      termsVersion: text(row.termsVersion, 40),
      privacyVersion: text(row.privacyVersion, 40),
      links: legalLinksOf(row.legalLinks).slice(0, 20),
    },
    support: supportOf(row),
    seo: seoOf(row),
    consent: consentOf(row),
    operations: {
      opsAlertEmail: matching(row.opsAlertEmail, EMAIL),
      bookingQueue: {
        number: queue !== null && queue >= 0 && queue <= 99 ? queue : null,
        category: row.bookingQueueCategory,
      },
    },
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------------------------------------
 * StorefrontSettingsUpdate → the row
 * ---------------------------------------------------------------------------------------------- */

/** The sections an update sends, in the document's order. */
export function sectionsOf(update: StorefrontSettingsUpdate): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => update[section] !== undefined);
}

/** The settings with the sections of `update` replacing their saved values. */
export function mergeSettings(
  current: StorefrontSettings,
  update: StorefrontSettingsUpdate,
): StorefrontSettings {
  const merged: StorefrontSettings = { ...current };
  for (const section of sectionsOf(update)) {
    Object.assign(merged, { [section]: update[section] });
  }
  return merged;
}

/** The stored jsonb object without the keys the update writes (the rest is kept, see the file header). */
function kept(value: unknown, written: readonly string[]): JsonObject {
  return isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !written.includes(key)))
    : {};
}

/** jsonb is written as JSON text (conventions §1): an array would otherwise become a PostgreSQL array. */
const json = (value: unknown): string => JSON.stringify(value);

/**
 * The columns of the sections `update` sends, from `current` (the row before the update): the jsonb columns as JSON
 * text, keeping what the document does not show (see the file header).
 */
export function toSettingsChanges(
  update: StorefrontSettingsUpdate,
  current: StorefrontSettingsEditRow,
): StorefrontSettingsChanges {
  const changes: StorefrontSettingsChanges = {};
  // Typed, so a misspelt column does not compile.
  const set = (part: StorefrontSettingsChanges): void => {
    Object.assign(changes, part);
  };
  const { brand, branding, locales, currencies, markets, features, policies } = update;
  const { airlineCard, legal, support, seo, consent, operations } = update;
  if (brand !== undefined) {
    set({ brand_name: brand.name, legal_name: brand.legalName, time_zone: brand.timeZone });
  }
  if (branding !== undefined) {
    const theme = kept(current.theme, ["colors", "fonts", "cornerRadius"]);
    const colors = kept(isRecord(current.theme) ? current.theme["colors"] : {}, [
      "primary",
      "secondary",
      "accent",
      "background",
      "text",
    ]);
    set({
      logo_asset_id: branding.logoAssetId,
      logo_dark_asset_id: branding.logoDarkAssetId,
      logo_square_asset_id: branding.logoSquareAssetId,
      favicon_asset_id: branding.faviconAssetId,
      primary_color: branding.colors.primary,
      secondary_color: branding.colors.secondary,
      theme: json({
        ...theme,
        colors: {
          ...colors,
          accent: branding.colors.accent,
          background: branding.colors.background,
          text: branding.colors.text,
        },
        fonts: { heading: branding.fonts.heading, body: branding.fonts.body },
        cornerRadius: branding.cornerRadius,
      }),
    });
  }
  if (locales !== undefined) {
    set({ default_locale: locales.default, supported_locales: [...locales.supported] });
  }
  if (currencies !== undefined) {
    set({
      default_currency: currencies.default,
      supported_currencies: [...currencies.supported],
    });
  }
  if (markets !== undefined) {
    set({
      default_market: markets.default,
      markets: json(
        markets.list.map(({ countryCode, name, currency, locale }) => ({
          countryCode,
          name,
          currency,
          locale,
        })),
      ),
    });
  }
  if (features !== undefined) {
    set({
      guest_checkout_enabled: features.guestCheckout,
      customer_accounts_enabled: features.customerAccounts,
      features: json({
        ...kept(current.features, []),
        ancillaries: features.ancillaries,
        brandedFareUpsell: features.brandedFareUpsell,
        selfServiceCancellation: features.selfServiceCancellation,
      }),
    });
  }
  if (policies !== undefined) {
    set({
      ticketing_policy: policies.ticketingPolicy,
      payment_timing: policies.paymentTiming,
      require_3ds: policies.require3ds,
      accepted_card_brands: [...policies.acceptedCardBrands],
      require_email_verification: policies.requireEmailVerification,
      offer_ttl_minutes: policies.offerTtlMinutes,
      checkout_ttl_minutes: policies.checkoutTtlMinutes,
    });
  }
  if (airlineCard !== undefined) {
    set({
      airline_card_enabled_test: airlineCard.enabledTest,
      airline_card_enabled_live: airlineCard.enabledLive,
    });
  }
  if (legal !== undefined) {
    set({
      terms_version: legal.termsVersion,
      privacy_version: legal.privacyVersion,
      legal_links: json(
        legal.links.map((link) =>
          "pageSlug" in link
            ? { kind: link.kind, label: link.label, pageSlug: link.pageSlug }
            : { kind: link.kind, label: link.label, url: link.url },
        ),
      ),
      terms_url: null,
      privacy_url: null,
    });
  }
  if (support !== undefined) {
    set({
      support_email: support.email,
      support_phone: support.phone,
      support_details: json({
        ...kept(current.supportDetails, []),
        hours: support.hours,
        helpCenterUrl: support.helpCenterUrl,
        emergencyPhone: support.emergencyPhone,
      }),
    });
  }
  if (seo !== undefined) {
    set({
      og_image_asset_id: seo.ogImageAssetId,
      seo: json({
        ...kept(current.seo, []),
        titleTemplate: seo.titleTemplate,
        defaultTitle: seo.defaultTitle,
        defaultDescription: seo.defaultDescription,
        robots: { index: seo.robots.index, follow: seo.robots.follow },
      }),
    });
  }
  if (consent !== undefined) {
    set({
      consent: json({
        ...kept(current.consent, []),
        regime: consent.regime,
        bannerRequired: consent.bannerRequired,
        policyVersion: consent.policyVersion,
        categories: consent.categories.map(({ id, required, defaultEnabled, title, description }) => ({
          id,
          required,
          defaultEnabled,
          title,
          description,
        })),
      }),
    });
  }
  if (operations !== undefined) {
    set({
      ops_alert_email: operations.opsAlertEmail,
      booking_queue_number: operations.bookingQueue.number,
      booking_queue_category: operations.bookingQueue.category,
    });
  }
  return changes;
}

/** The audited view of the settings: their version and the sections an update sent (`staff_actions.before/after`). */
export function auditView(
  settings: StorefrontSettings,
  sections: readonly SettingsSection[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries([
    ["version", settings.version],
    ...sections.map((section) => [section, settings[section]] as const),
  ]);
}
