// `storefront.get` (getStorefront, OBE-016): the tenant's `storefront_settings` row → `StorefrontConfig` of the OTA
// document, in two steps (OADR-0012 point 7, api-changes §4):
//
// 1. `toCachedStorefront` builds the caller-independent part from the row, the tenant and one locale: everything of
//    the configuration except the asset URLs and the edge-only airline-card fields. The images are kept as asset
//    references (id and file extension) and the airline-card availability of the environment as a flag. This is what
//    the storefront service caches in `t:<tenantId>:<env>:sf:<locale>` for 5 minutes.
// 2. `storefrontFor` adds the caller-specific parts on every request, so whichever caller fills the cache first never
//    decides what the others get: asset URLs as same-origin `/api/v1/assets/…` paths for the hosted storefront's edge
//    (its CSP allows images from its own origin only) and absolute `PUBLIC_OTA_API_URL` URLs for key callers
//    (OADR-0012 point 3), the payment account (OBE-038, below) and the airline card (OBE-050, below).
//
// The contract requires values the settings row of a new tenant does not have yet (the OTA admin edits them from M4,
// OBE-070). Each has a documented default, so the configuration of a freshly provisioned tenant is complete and valid:
// the neutral palette and the Inter font of the storefront build, a `data:` badge with the brand's initials as logo and
// favicon (the approach of the reference endpoints' airline logos), the content-page URLs `/p/<slug>` of the legal
// pages on the primary storefront host, the settings' creation date as the version of terms, privacy and cookie
// policies, one market derived from the default locale and currency, and a support address on the reserved `.invalid`
// domain (RFC 2606), which no mail system delivers, until the OTA sets its own.
//
// Never published: the operational columns (booking queue, `ops_alert_email`, TTLs, payment timing, search defaults)
// are not even read by the repository. Platform data: the tenant's name (`payment.merchantName`) and, from the
// tenant key and STOREFRONT_BASE_DOMAIN, its storefront sub-domain as `primaryUrl` and `domains`; verified custom
// domains (M5) are not read yet; plan-gated features are not gated yet (no plan data is read in M2).
//
// Payment (api-changes §4, OADR-0010 point 1; OBE-038). The cached part carries the settings' side of
// StorefrontPaymentConfig (card brands, 3-D Secure, merchant country) with the OTA's name as `merchantName`, and no
// method. `storefrontFor` completes it per request with the account the payment gateway serves for the tenant's
// environment (read through the 60-second connection cache, so a platform change shows without waiting for this
// cache): in `velexis` mode the Velexis publishable key of the environment, `merchantName` "Velexis on behalf of <OTA
// name>", the connection's statement descriptor suffix and its methods (`card`); without an account that can take
// payments the section stays without a method (`supportedMethods: []`, an empty `publishableKey`), and
// checkout.createPayment answers `424 PAYMENT_PROVIDER_NOT_CONFIGURED`. No secret key is ever part of it.
//
// Airline card (api-changes §4, OADR-0004 point 1, OADR-0017 point 7; OBE-050). The cache entry keeps only the tenant's
// setting for its environment (`airlineCardEnabled`, from `airline_card_enabled_<env>`). `storefrontFor` decides per
// request: `airline_card` is appended to `supportedMethods` and `payment.airlineCard` is filled (`enabled`, the
// accepted brands, `chargedBy: "airline"` and the localised notice) only when the caller is the storefront edge, the
// global switch `AIRLINE_CARD_ENABLED` is on and the entry's flag is on. The completion is edge-only, so `pk_` and
// `sk_` callers never see the method, whichever caller filled the cache; for them `airlineCard` is always null. The
// method does not need a Stripe account: the airline charges the card.
import type { components } from "@velexis/api-types";
import { codeBadge, displayLanguage, ReferenceNames, toCurrency } from "../reference/reference.mapper";
import type { CurrencyRow, StorefrontAssetRow, StorefrontSettingsRow } from "./storefront.repository";

type Schemas = components["schemas"];
export type StorefrontConfig = Schemas["StorefrontConfig"];
type Branding = Schemas["StorefrontBranding"];
type Seo = Schemas["StorefrontSeo"];
type Payment = Schemas["StorefrontPaymentConfig"];
type Market = Schemas["StorefrontMarket"];
type Locale = Schemas["StorefrontLocale"];
type Currency = Schemas["Currency"];
type Features = Schemas["StorefrontFeatures"];
type AuthPolicy = Schemas["StorefrontAuthPolicy"];
type LegalLinks = Schemas["StorefrontLegalLinks"];
type Support = Schemas["StorefrontSupport"];
type Consent = Schemas["StorefrontConsent"];
type ConsentCategory = Schemas["StorefrontConsentCategory"];
type Font = Schemas["StorefrontFont"];
type CardBrand = Schemas["StorefrontCardBrand"];
type AirlineCard = Schemas["StorefrontAirlineCard"];
type PaymentBrand = Schemas["AmadeusPaymentBrand"];
export type StorefrontFontFamily = Schemas["StorefrontFontFamily"];

/** The branding fields that are asset URLs, added per caller. */
type BrandingAssetUrl = "logoUrl" | "logoDarkUrl" | "logoSquareUrl" | "faviconUrl";

/** `StorefrontConfig` without its caller-specific fields: what the cache holds besides the asset references. */
export type StorefrontBase = Omit<StorefrontConfig, "branding" | "seo" | "payment"> & {
  readonly branding: Omit<Branding, BrandingAssetUrl>;
  readonly seo: Omit<Seo, "ogImageUrl">;
  readonly payment: Omit<Payment, "airlineCard">;
};

/** An uploaded image as the cache keeps it: its id and the extension of its public URL. */
export interface AssetRef {
  readonly id: string;
  readonly extension: string;
}

/** The images the settings reference, by use; `null` when none is set (or the row is not one of that kind). */
export interface StorefrontAssetRefs {
  readonly logo: AssetRef | null;
  readonly logoDark: AssetRef | null;
  readonly logoSquare: AssetRef | null;
  readonly favicon: AssetRef | null;
  readonly ogImage: AssetRef | null;
}

/** The caller-independent part of `storefront.get` for one locale: one cache entry (OADR-0012 point 7). */
export interface CachedStorefront {
  /** The locale the entry was built for: `config.defaultLocale` or one of `config.locales`. */
  readonly locale: string;
  readonly config: StorefrontBase;
  readonly assets: StorefrontAssetRefs;
  /** `airline_card_enabled_<env>` of the settings, for the edge-only airline-card fields (`airlineCardFor`). */
  readonly airlineCardEnabled: boolean;
}

/** Everything `toCachedStorefront` reads: the settings row with its assets and currencies, and the tenant. */
export interface StorefrontSource {
  readonly tenantKey: string;
  /** `platform.tenants.name`, or `null` when the platform row could not be found. */
  readonly tenantName: string | null;
  /** The request's environment (the key's, or the tenant's storefront environment for the edge). */
  readonly environment: "test" | "live";
  /** STOREFRONT_BASE_DOMAIN: `<key>.<base>` is the tenant's storefront sub-domain. */
  readonly storefrontBaseDomain: string;
  readonly settings: StorefrontSettingsRow;
  /** The `storefront_assets` rows of the settings' asset ids. */
  readonly assets: readonly StorefrontAssetRow[];
  /** The `reference.currencies` rows of the settings' currencies. */
  readonly currencies: readonly CurrencyRow[];
}

/** Who the response is for: the storefront edge, or a `pk_`/`sk_` key caller. */
export type StorefrontCaller = "edge" | "key";

export interface StorefrontAudience {
  readonly caller: StorefrontCaller;
  /** PUBLIC_OTA_API_URL: the origin (and optional path) of the absolute asset URLs given to key callers. */
  readonly publicApiUrl: string;
  /**
   * The payment account of the tenant's environment (the payment gateway's `findAccount`), or `null`/absent when none
   * can take payments: the payment section then has no method.
   */
  readonly payment?: StorefrontPaymentAccount | null | undefined;
  /** AIRLINE_CARD_ENABLED, the global switch of the airline card (absent: off). */
  readonly airlineCardSwitch?: boolean | undefined;
}

/** The payment methods `storefront.get` may list for the payment account (what checkout.createPayment takes). */
const ACCOUNT_METHODS: readonly Payment["supportedMethods"][number][] = ["card"];

/** The public side of a payment account (no secret): what StorefrontPaymentConfig shows of it. */
export interface StorefrontPaymentAccount {
  readonly provider: "stripe";
  readonly accountMode: Payment["accountMode"];
  /** The publishable key of the environment (Velexis's in `velexis` and `connect_standard` mode). */
  readonly publishableKey: string;
  /** `acct_…` in `connect_standard` mode, else `null`. */
  readonly accountId: string | null;
  /** The statement descriptor suffix (`velexis` mode), else `null`. */
  readonly statementDescriptor: string | null;
  /** The methods the account takes. */
  readonly methods: readonly string[];
}

/** The text before the OTA's name in `merchantName` when Velexis takes the payment (`velexis` mode). */
export const VELEXIS_MERCHANT_PREFIX = "Velexis on behalf of";

/**
 * The payment section for one request: the cached part (the OTA's name as `merchantName`, no method) completed with the
 * account and the airline card of the caller (`airlineCardFor`), see the file header.
 */
export function paymentConfigFor(
  base: StorefrontBase["payment"],
  account: StorefrontPaymentAccount | null | undefined,
  airlineCard: AirlineCard | null = null,
): Payment {
  const airlineMethods: Payment["supportedMethods"] = airlineCard === null ? [] : ["airline_card"];
  if (account === null || account === undefined) {
    return { ...base, supportedMethods: airlineMethods, airlineCard };
  }
  const velexis = account.accountMode === "velexis";
  return {
    ...base,
    provider: account.provider,
    accountMode: account.accountMode,
    publishableKey: account.publishableKey,
    accountId: account.accountMode === "connect_standard" ? account.accountId : null,
    merchantName: velexis ? `${VELEXIS_MERCHANT_PREFIX} ${base.merchantName}` : base.merchantName,
    statementDescriptor: velexis ? account.statementDescriptor : null,
    supportedMethods: [
      ...ACCOUNT_METHODS.filter((method) => account.methods.includes(method)),
      ...airlineMethods,
    ],
    airlineCard,
  };
}

/** The notice shown before the airline-card form, by primary language (api-changes §4); English otherwise. */
export const AIRLINE_CARD_NOTICES: Readonly<Record<string, string>> = Object.freeze({
  en: "The airline charges your card. The price is the airline's price.",
  de: "Die Fluggesellschaft belastet Ihre Karte. Es gilt der Preis der Fluggesellschaft.",
  es: "La aerolínea carga el importe en tu tarjeta. El precio es el de la aerolínea.",
  fr: "La compagnie aérienne débite votre carte. Le prix est celui de la compagnie aérienne.",
  it: "La compagnia aerea addebita l'importo sulla tua carta. Il prezzo è quello della compagnia aerea.",
  nl: "De luchtvaartmaatschappij belast uw kaart. De prijs is die van de luchtvaartmaatschappij.",
  pt: "A companhia aérea cobra o seu cartão. O preço é o da companhia aérea.",
});

/** The airline-card notice in `locale` (its primary language subtag), else in English. */
export function airlineCardNotice(locale: string): string {
  const language = locale.split("-")[0]?.toLowerCase() ?? "";
  return AIRLINE_CARD_NOTICES[language] ?? AIRLINE_CARD_NOTICES["en"] ?? "";
}

/**
 * The airline card of one request (see the file header): for the storefront edge only, when the global switch and the
 * tenant's setting of the entry's environment are both on; `null` for every key caller.
 */
export function airlineCardFor(entry: CachedStorefront, audience: StorefrontAudience): AirlineCard | null {
  if (audience.caller !== "edge" || audience.airlineCardSwitch !== true || !entry.airlineCardEnabled) {
    return null;
  }
  return {
    enabled: true,
    cardBrands: entry.config.payment.pspCardBrands.map((brand) => ({ ...brand })),
    chargedBy: "airline",
    notice: airlineCardNotice(entry.locale),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Defaults
 * ---------------------------------------------------------------------------------------------- */

/** The neutral palette of the storefront build (ota/frontend/src/styles/main.css); every pair reaches WCAG AA. */
export const NEUTRAL_COLORS = Object.freeze({
  primary: "#1d4ed8",
  secondary: "#0f172a",
  accent: "#0e7490",
  background: "#ffffff",
  surface: "#f8fafc",
  text: "#0f172a",
  mutedText: "#475569",
  success: "#15803d",
  warning: "#b45309",
  error: "#b91c1c",
} as const);

/**
 * The font families bundled with the hosted storefront (`StorefrontFontFamily` of the document; a unit test compares
 * both). All are open-licence Google Fonts: `StorefrontFont.cssUrl` is the Google Fonts stylesheet for frontends of
 * key callers, while the hosted storefront uses its own copies and never loads it (`font-src 'self'`, OADR-0015).
 */
export const BUNDLED_FONTS: readonly StorefrontFontFamily[] = Object.freeze([
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Source Sans 3",
  "Merriweather",
  "Playfair Display",
]);

/** The storefront build's default font (`--vx-font-body`). */
export const DEFAULT_FONT: StorefrontFontFamily = "Inter";

/** The weights the stylesheet loads: regular and bold exist in every bundled family. */
const FONT_WEIGHTS: readonly number[] = Object.freeze([400, 700]);

const CORNER_RADII: readonly Branding["cornerRadius"][] = ["none", "small", "medium", "large"];
export const DEFAULT_CORNER_RADIUS: Branding["cornerRadius"] = "medium";

/** Feature switches of the settings' `features` jsonb that are on unless the OTA turns them off. */
export const DEFAULT_FEATURES = Object.freeze({ ancillaries: true, brandedFareUpsell: true } as const);

/** The customer password rules of ADR-0008: at least 10 characters, no composition rules, breached list checked. */
export const CUSTOMER_PASSWORD_POLICY = Object.freeze({
  minLength: 10,
  maxLength: 128,
  requireUppercase: false,
  requireLowercase: false,
  requireDigit: false,
  requireSymbol: false,
  rejectBreached: true,
} as const);

/** Customer access tokens (`__Host-vx_at`, 900 s) and refresh tokens with `rememberMe` (30 days), ADR-0008. */
const ACCESS_TOKEN_TTL_SECONDS = 900;
const REFRESH_TOKEN_TTL_DAYS = 30;

/** The consent cookie of the storefront and how long a choice is kept. */
const CONSENT_COOKIE_NAME = "vx_consent";
const CONSENT_LIFETIME_DAYS = 180;

/** The one consent category every storefront has: its own cookies (session, CSRF, checkout). */
export const NECESSARY_CONSENT_CATEGORY: ConsentCategory = Object.freeze({
  id: "necessary",
  required: true,
  defaultEnabled: true,
  title: "Strictly necessary",
  description: "Sign-in, checkout and security cookies.",
});

/** The content-page slugs the legal links default to (`/p/<slug>`, OADR-0015 point 4). */
export const DEFAULT_LEGAL_SLUGS = Object.freeze({
  terms: "terms",
  privacy: "privacy",
  cookies: "cookies",
  refund_policy: "refund-policy",
} as const);

/** The reserved domain of the placeholder support address (RFC 2606): never delivered anywhere. */
export const PLACEHOLDER_EMAIL_DOMAIN = "invalid";

/**
 * Amadeus payment brands → Stripe's brand ids (`StorefrontCardBrand.psp`). Brands Stripe cannot take (the corporate
 * and virtual ones: Ixaris, AirPlus, UATP, Pyton) are left out of `cardBrands` and `pspCardBrands`.
 */
export const STRIPE_CARD_BRANDS: Readonly<Partial<Record<PaymentBrand, { psp: string; label: string }>>> =
  Object.freeze({
    VISA: { psp: "visa", label: "Visa" },
    VISA_ELECTRON: { psp: "visa", label: "Visa Electron" },
    VISA_DEBIT: { psp: "visa", label: "Visa Debit" },
    MASTERCARD: { psp: "mastercard", label: "Mastercard" },
    MASTERCARD_DEBIT: { psp: "mastercard", label: "Mastercard Debit" },
    MAESTRO: { psp: "mastercard", label: "Maestro" },
    AMERICAN_EXPRESS: { psp: "amex", label: "American Express" },
    DINERS: { psp: "diners", label: "Diners Club" },
  });

/* ------------------------------------------------------------------------------------------------
 * Small parsers
 * ---------------------------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > maxLength ? undefined : trimmed;
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
/** The `email` format of ajv-formats, which the response conformance check applies. */
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const PAGE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ASSET_ID = /^ast_[0-9A-Za-z]{16,40}$/;
const ASSET_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "webp", "ico"]);

function hexColor(value: unknown): string | undefined {
  return typeof value === "string" && HEX_COLOR.test(value) ? value : undefined;
}

function e164(value: unknown): string | null {
  return typeof value === "string" && E164.test(value) ? value : null;
}

/** An https URL in its serialised form, or `undefined` for anything else. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------------------------------------
 * Locales
 * ---------------------------------------------------------------------------------------------- */

/** At most this many `Accept-Language` entries are looked at. */
const MAX_LANGUAGE_RANGES = 20;

/** `tag` as a canonical BCP 47 language tag without extensions (`en-gb` → `en-GB`), or `undefined`. */
export function canonicalLocale(tag: unknown): string | undefined {
  if (typeof tag !== "string" || tag.trim() === "" || tag.length > 64) {
    return undefined;
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(tag.trim());
    return canonical === undefined ? undefined : new Intl.Locale(canonical).baseName;
  } catch {
    return undefined;
  }
}

/** The language ranges of an `Accept-Language` value, canonical, by preference (`q`, then order); no `*`. */
export function acceptedLocales(acceptLanguage: string | undefined): string[] {
  if (acceptLanguage === undefined) {
    return [];
  }
  return acceptLanguage
    .split(",")
    .slice(0, MAX_LANGUAGE_RANGES)
    .map((entry, index) => {
      const [range = "", ...parameters] = entry.split(";").map((part) => part.trim());
      const qParameter = parameters.find((parameter) => /^q=/i.test(parameter));
      const quality = qParameter === undefined ? 1 : Number(qParameter.slice(2));
      return { locale: range === "*" ? undefined : canonicalLocale(range), quality, index };
    })
    .filter(
      (entry): entry is { locale: string; quality: number; index: number } =>
        entry.locale !== undefined &&
        Number.isFinite(entry.quality) &&
        entry.quality > 0 &&
        entry.quality <= 1,
    )
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((entry) => entry.locale);
}

/**
 * The storefront locale for an `Accept-Language` value: for each range by preference, a supported locale equal to it,
 * then to the range without its last subtags (`fr-CA` → `fr`), then the first supported locale of the same language
 * (`fr` → `fr-FR`); else `defaultLocale`. The answer is always `defaultLocale` or one of `supported`, so the cache
 * holds at most one entry per supported locale whatever the visitors send.
 */
export function negotiateLocale(
  acceptLanguage: string | undefined,
  supported: readonly string[],
  defaultLocale: string,
): string {
  const byLowerCase = new Map(supported.map((locale) => [locale.toLowerCase(), locale]));
  for (const range of acceptedLocales(acceptLanguage)) {
    const subtags = range.split("-");
    for (let length = subtags.length; length > 0; length -= 1) {
      const match = byLowerCase.get(subtags.slice(0, length).join("-").toLowerCase());
      if (match !== undefined) {
        return match;
      }
    }
    const language = new Intl.Locale(range).language;
    const sameLanguage = supported.find((locale) => new Intl.Locale(locale).language === language);
    if (sameLanguage !== undefined) {
      return sameLanguage;
    }
  }
  return defaultLocale;
}

/** The scripts written right to left (CLDR), for `StorefrontLocale.direction`. */
const RTL_SCRIPTS: ReadonlySet<string> = new Set([
  "Adlm",
  "Arab",
  "Hebr",
  "Mand",
  "Mend",
  "Nkoo",
  "Rohg",
  "Samr",
  "Syrc",
  "Thaa",
]);

function localeOf(code: string): Locale {
  let name: string | undefined;
  let direction: Locale["direction"] = "ltr";
  try {
    name = new Intl.DisplayNames([code], { type: "language", fallback: "none" }).of(code);
    const script = new Intl.Locale(code).maximize().script;
    direction = script !== undefined && RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
  } catch {
    name = undefined;
  }
  return { code, name: name === undefined || name === "" ? code : name, direction };
}

/** A two-letter region for a locale: its own, else its language's likely one (CLDR), else `US`. */
function regionOf(locale: string): string {
  const candidates: Array<string | undefined> = [];
  try {
    const parsed = new Intl.Locale(locale);
    candidates.push(
      parsed.region,
      parsed.maximize().region,
      new Intl.Locale(parsed.language).maximize().region,
    );
  } catch {
    // A tag ICU cannot parse: the fallback below.
  }
  return candidates.find((region) => region !== undefined && /^[A-Z]{2}$/.test(region)) ?? "US";
}

/** ICU's name of a region in `language` (English when `undefined`), or the code. */
function regionName(code: string, language: string | undefined): string {
  try {
    const name = new Intl.DisplayNames([language ?? "en"], { type: "region", fallback: "none" }).of(code);
    return name === undefined || name === "" ? code : name;
  } catch {
    return code;
  }
}

/* ------------------------------------------------------------------------------------------------
 * The caller-independent part
 * ---------------------------------------------------------------------------------------------- */

/** WCAG relative luminance of a `#RRGGBB` colour. */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** White or black text on `background`, whichever contrasts more (WCAG contrast ratio). */
export function textColorOn(background: string): string {
  const light = luminance(background);
  return 1.05 / (light + 0.05) >= (light + 0.05) / 0.05 ? "#ffffff" : "#000000";
}

function fontOf(family: unknown): Font {
  const chosen = isOneOf(family, BUNDLED_FONTS) ? family : DEFAULT_FONT;
  return {
    family: chosen,
    cssUrl: `https://fonts.googleapis.com/css2?family=${chosen.replace(/ /g, "+")}:wght@${FONT_WEIGHTS.join(";")}&display=swap`,
    weights: [...FONT_WEIGHTS],
  };
}

function brandingOf(settings: StorefrontSettingsRow): StorefrontBase["branding"] {
  const theme = isRecord(settings.theme) ? settings.theme : {};
  const colors = isRecord(theme["colors"]) ? theme["colors"] : {};
  const fonts = isRecord(theme["fonts"]) ? theme["fonts"] : {};
  const color = (name: keyof typeof NEUTRAL_COLORS): string => hexColor(colors[name]) ?? NEUTRAL_COLORS[name];
  const primary = hexColor(settings.primaryColor) ?? color("primary");
  return {
    colors: {
      primary,
      onPrimary: textColorOn(primary),
      secondary: hexColor(settings.secondaryColor) ?? color("secondary"),
      accent: color("accent"),
      background: color("background"),
      surface: color("surface"),
      text: color("text"),
      mutedText: color("mutedText"),
      success: color("success"),
      warning: color("warning"),
      error: color("error"),
    },
    fonts: { heading: fontOf(fonts["heading"]), body: fontOf(fonts["body"]) },
    cornerRadius: isOneOf(theme["cornerRadius"], CORNER_RADII)
      ? theme["cornerRadius"]
      : DEFAULT_CORNER_RADIUS,
    customCssUrl: null,
  };
}

/** The supported locales: canonical, unique, the default one included (first when it was missing). */
function supportedLocales(settings: StorefrontSettingsRow, defaultLocale: string): string[] {
  const locales = settings.supportedLocales.flatMap((locale) => canonicalLocale(locale) ?? []);
  return [...new Set(locales.includes(defaultLocale) ? locales : [defaultLocale, ...locales])];
}

function currenciesOf(
  settings: StorefrontSettingsRow,
  defaultCurrency: string,
  rows: readonly CurrencyRow[],
  names: ReferenceNames,
): Currency[] {
  const codes = settings.supportedCurrencies.flatMap((code) => {
    const upper = code.trim().toUpperCase();
    return /^[A-Z]{3}$/.test(upper) ? [upper] : [];
  });
  const unique = [...new Set(codes.includes(defaultCurrency) ? codes : [defaultCurrency, ...codes])];
  const byCode = new Map(rows.map((row) => [row.code, row]));
  return unique.map((code) => {
    const row = byCode.get(code);
    if (row !== undefined) {
      return toCurrency(row, names);
    }
    // A currency outside the reference data (the settings validation refuses one, OBE-070): ICU's name and digits.
    let decimals = 2;
    try {
      decimals =
        new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      decimals = 2;
    }
    return {
      code,
      name: names.currency(code, code),
      symbol: code,
      decimals: Math.min(Math.max(decimals, 0), 4),
    };
  });
}

function marketsOf(
  settings: StorefrontSettingsRow,
  defaults: { readonly locale: string; readonly currency: string },
  language: string | undefined,
): { readonly markets: Market[]; readonly defaultMarket: string } {
  const configured = Array.isArray(settings.markets) ? (settings.markets as unknown[]) : [];
  const seen = new Set<string>();
  const markets = configured.flatMap((item): Market[] => {
    if (!isRecord(item)) {
      return [];
    }
    const countryCode = item["countryCode"];
    const currency = item["currency"];
    const locale = canonicalLocale(item["locale"]);
    if (
      typeof countryCode !== "string" ||
      !/^[A-Z]{2}$/.test(countryCode) ||
      seen.has(countryCode) ||
      typeof currency !== "string" ||
      !/^[A-Z]{3}$/.test(currency) ||
      locale === undefined
    ) {
      return [];
    }
    seen.add(countryCode);
    return [
      {
        countryCode,
        name: nonEmpty(item["name"], 80) ?? regionName(countryCode, language),
        currency,
        locale,
      },
    ];
  });
  const [first] = markets;
  if (first === undefined) {
    // No market configured yet: the country of the default locale, with the default currency and locale.
    const countryCode = regionOf(defaults.locale);
    const market = {
      countryCode,
      name: regionName(countryCode, language),
      currency: defaults.currency,
      locale: defaults.locale,
    };
    return { markets: [market], defaultMarket: countryCode };
  }
  const configuredDefault = settings.defaultMarket?.trim();
  const defaultMarket =
    markets.find((market) => market.countryCode === configuredDefault)?.countryCode ?? first.countryCode;
  return { markets, defaultMarket };
}

function featuresOf(settings: StorefrontSettingsRow): Features {
  const features = isRecord(settings.features) ? settings.features : {};
  const flag = (name: keyof typeof DEFAULT_FEATURES): boolean =>
    typeof features[name] === "boolean" ? (features[name] as boolean) : DEFAULT_FEATURES[name];
  return {
    guestCheckout: settings.guestCheckoutEnabled,
    customerAccounts: settings.customerAccountsEnabled,
    // Saved travellers and seat maps are outside the MVP (ota/docs/scope.md §3).
    savedTravelers: false,
    ancillaries: flag("ancillaries"),
    seatSelection: false,
    brandedFareUpsell: flag("brandedFareUpsell"),
    autoIssue: settings.autoIssue === true,
  };
}

function authOf(settings: StorefrontSettingsRow): AuthPolicy {
  return {
    emailVerification: settings.requireEmailVerification ? "required_before_checkout" : "not_required",
    passwordPolicy: { ...CUSTOMER_PASSWORD_POLICY },
    accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: REFRESH_TOKEN_TTL_DAYS,
  };
}

const LEGAL_KINDS = ["terms", "privacy", "cookies", "refund_policy", "imprint", "accessibility"] as const;
type LegalKind = (typeof LEGAL_KINDS)[number];

/** The URL of each legal link kind (the first link of a kind wins): https URLs, or content pages of the storefront. */
function legalUrls(settings: StorefrontSettingsRow, primaryUrl: string): Map<LegalKind, string> {
  const urls = new Map<LegalKind, string>();
  for (const link of Array.isArray(settings.legalLinks) ? (settings.legalLinks as unknown[]) : []) {
    if (!isRecord(link) || !isOneOf(link["kind"], LEGAL_KINDS) || urls.has(link["kind"])) {
      continue;
    }
    const slug = link["pageSlug"];
    const url =
      typeof slug === "string" && PAGE_SLUG.test(slug) ? `${primaryUrl}/p/${slug}` : httpsUrl(link["url"]);
    if (url !== undefined) {
      urls.set(link["kind"], url);
    }
  }
  return urls;
}

function legalOf(settings: StorefrontSettingsRow, primaryUrl: string, since: string): LegalLinks {
  const urls = legalUrls(settings, primaryUrl);
  const page = (slug: string): string => `${primaryUrl}/p/${slug}`;
  return {
    termsUrl: urls.get("terms") ?? httpsUrl(settings.termsUrl) ?? page(DEFAULT_LEGAL_SLUGS.terms),
    termsVersion: nonEmpty(settings.termsVersion, 40) ?? since,
    privacyUrl: urls.get("privacy") ?? httpsUrl(settings.privacyUrl) ?? page(DEFAULT_LEGAL_SLUGS.privacy),
    privacyVersion: nonEmpty(settings.privacyVersion, 40) ?? since,
    cookiePolicyUrl: urls.get("cookies") ?? page(DEFAULT_LEGAL_SLUGS.cookies),
    refundPolicyUrl: urls.get("refund_policy") ?? page(DEFAULT_LEGAL_SLUGS.refund_policy),
    imprintUrl: urls.get("imprint") ?? null,
    accessibilityUrl: urls.get("accessibility") ?? null,
  };
}

/** The placeholder support address of a tenant without one: on the reserved `.invalid` domain. */
export function placeholderSupportEmail(tenantKey: string): string {
  return `support@${tenantKey}.${PLACEHOLDER_EMAIL_DOMAIN}`;
}

function supportOf(settings: StorefrontSettingsRow, tenantKey: string): Support {
  const details = isRecord(settings.supportDetails) ? settings.supportDetails : {};
  const email = settings.supportEmail?.trim();
  return {
    email: email !== undefined && EMAIL.test(email) ? email : placeholderSupportEmail(tenantKey),
    phone: e164(settings.supportPhone),
    hours: nonEmpty(details["hours"], 200) ?? "",
    helpCenterUrl: httpsUrl(details["helpCenterUrl"]) ?? null,
    emergencyPhone: e164(details["emergencyPhone"]),
  };
}

const CONSENT_REGIMES: readonly Consent["regime"][] = ["gdpr", "ccpa", "lgpd", "none"];
const CONSENT_CATEGORIES: readonly ConsentCategory["id"][] = [
  "necessary",
  "preferences",
  "analytics",
  "marketing",
];

function consentOf(settings: StorefrontSettingsRow, since: string): Consent {
  const consent = isRecord(settings.consent) ? settings.consent : {};
  const seen = new Set<string>();
  const categories = (
    Array.isArray(consent["categories"]) ? (consent["categories"] as unknown[]) : []
  ).flatMap((item): ConsentCategory[] => {
    if (
      !isRecord(item) ||
      !isOneOf(item["id"], CONSENT_CATEGORIES) ||
      seen.has(item["id"]) ||
      typeof item["required"] !== "boolean" ||
      typeof item["defaultEnabled"] !== "boolean"
    ) {
      return [];
    }
    const title = nonEmpty(item["title"], 80);
    if (title === undefined) {
      return [];
    }
    seen.add(item["id"]);
    return [
      {
        id: item["id"],
        required: item["required"],
        defaultEnabled: item["defaultEnabled"],
        title,
        description: typeof item["description"] === "string" ? item["description"] : "",
      },
    ];
  });
  return {
    // Without a configured policy: the protective default, a GDPR banner before any non-necessary cookie.
    regime: isOneOf(consent["regime"], CONSENT_REGIMES) ? consent["regime"] : "gdpr",
    bannerRequired: typeof consent["bannerRequired"] === "boolean" ? consent["bannerRequired"] : true,
    policyVersion: nonEmpty(consent["policyVersion"], 40) ?? since,
    cookieName: CONSENT_COOKIE_NAME,
    lifetimeDays: CONSENT_LIFETIME_DAYS,
    categories: seen.has("necessary") ? categories : [{ ...NECESSARY_CONSENT_CATEGORY }, ...categories],
  };
}

function seoOf(
  settings: StorefrontSettingsRow,
  name: string,
  primaryUrl: string,
  environment: "test" | "live",
): StorefrontBase["seo"] {
  const seo = isRecord(settings.seo) ? settings.seo : {};
  const template = nonEmpty(seo["titleTemplate"], 120);
  const robots = isRecord(seo["robots"]) ? seo["robots"] : {};
  return {
    titleTemplate: template?.includes("%s") === true ? template : `%s | ${name}`,
    defaultTitle: nonEmpty(seo["defaultTitle"], 120) ?? name,
    defaultDescription: nonEmpty(seo["defaultDescription"], 300) ?? "",
    twitterHandle: null,
    canonicalBaseUrl: primaryUrl,
    // A test storefront is never indexed (the document's StorefrontSeo.robots).
    robots:
      environment === "test"
        ? { index: false, follow: false }
        : {
            index: typeof robots["index"] === "boolean" ? robots["index"] : true,
            follow: typeof robots["follow"] === "boolean" ? robots["follow"] : true,
          },
  };
}

/** The accepted brands Stripe can take, as Amadeus brands and with their Stripe names, in the settings' order. */
function cardBrandsOf(settings: StorefrontSettingsRow): { cardBrands: PaymentBrand[]; psp: CardBrand[] } {
  const psp = [...new Set(settings.acceptedCardBrands)].flatMap((brand): CardBrand[] => {
    const stripe = STRIPE_CARD_BRANDS[brand as PaymentBrand];
    return stripe === undefined ? [] : [{ amadeus: brand as PaymentBrand, ...stripe }];
  });
  return { cardBrands: psp.map((brand) => brand.amadeus), psp };
}

function assetRefsOf(
  settings: StorefrontSettingsRow,
  rows: readonly StorefrontAssetRow[],
): StorefrontAssetRefs {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ref = (id: string | null, kind: string): AssetRef | null => {
    const row = id === null ? undefined : byId.get(id);
    return row === undefined ||
      row.kind !== kind ||
      !ASSET_ID.test(row.id) ||
      !ASSET_EXTENSIONS.has(row.fileExtension)
      ? null
      : { id: row.id, extension: row.fileExtension };
  };
  return {
    logo: ref(settings.logoAssetId, "logo"),
    logoDark: ref(settings.logoDarkAssetId, "logo_dark"),
    logoSquare: ref(settings.logoSquareAssetId, "logo_square"),
    favicon: ref(settings.faviconAssetId, "favicon"),
    ogImage: ref(settings.ogImageAssetId, "og_image"),
  };
}

/** The asset ids the settings reference, for the repository. */
export function referencedAssetIds(settings: StorefrontSettingsRow): string[] {
  return [
    settings.logoAssetId,
    settings.logoDarkAssetId,
    settings.logoSquareAssetId,
    settings.faviconAssetId,
    settings.ogImageAssetId,
  ].filter((id): id is string => id !== null);
}

/** The settings' default and supported currencies (upper case, unique), for the repository. */
export function referencedCurrencies(settings: StorefrontSettingsRow): string[] {
  return [
    ...new Set(
      [settings.defaultCurrency, ...settings.supportedCurrencies].map((code) => code.trim().toUpperCase()),
    ),
  ];
}

/** The tenant's storefront sub-domain as a URL, without a trailing slash: `https://<key>.<base>`. */
export function storefrontSubdomainUrl(tenantKey: string, storefrontBaseDomain: string): string {
  return `https://${tenantKey}.${storefrontBaseDomain}`;
}

/**
 * The caller-independent configuration for `locale` (one of the storefront's locales; the default locale when
 * `undefined` or not supported). Currency and default market names follow the locale where ICU has them.
 */
export function toCachedStorefront(source: StorefrontSource, locale?: string): CachedStorefront {
  const { settings, tenantKey, environment } = source;
  const defaultLocale = canonicalLocale(settings.defaultLocale) ?? "en";
  const locales = supportedLocales(settings, defaultLocale);
  const entryLocale = locale !== undefined && locales.includes(locale) ? locale : defaultLocale;
  const language = displayLanguage(entryLocale);
  const names = new ReferenceNames(language);
  const name = nonEmpty(settings.brandName, 120) ?? nonEmpty(source.tenantName, 120) ?? tenantKey;
  const primaryUrl = storefrontSubdomainUrl(tenantKey, source.storefrontBaseDomain);
  const since = settings.createdAt.toISOString().slice(0, 10);
  const defaultCurrency = settings.defaultCurrency.trim().toUpperCase();
  const { markets, defaultMarket } = marketsOf(
    settings,
    { locale: defaultLocale, currency: defaultCurrency },
    language,
  );
  const { cardBrands, psp } = cardBrandsOf(settings);
  const config: StorefrontBase = {
    tenantKey,
    name,
    legalName: nonEmpty(settings.legalName, 200) ?? null,
    environment,
    primaryUrl,
    domains: [
      {
        host: `${tenantKey}.${source.storefrontBaseDomain}`,
        kind: "subdomain",
        primary: true,
        // The sub-domain serves the storefront from provisioning on, when the settings row is seeded.
        verifiedAt: settings.createdAt.toISOString(),
      },
    ],
    timeZone: nonEmpty(settings.timeZone, 64) ?? "UTC",
    branding: brandingOf(settings),
    defaultLocale,
    locales: locales.map(localeOf),
    defaultCurrency,
    currencies: currenciesOf(settings, defaultCurrency, source.currencies, names),
    defaultMarket,
    markets,
    features: featuresOf(settings),
    auth: authOf(settings),
    payment: {
      // Without a method: `storefrontFor` adds the payment account of the request (`paymentConfigFor`).
      provider: "stripe",
      environment,
      accountMode: "velexis",
      publishableKey: "",
      accountId: null,
      merchantName: nonEmpty(source.tenantName, 200) ?? name,
      statementDescriptor: null,
      supportedMethods: [],
      cardBrands,
      pspCardBrands: psp,
      merchantCountry: defaultMarket,
      threeDSecure: settings.require3ds ? "always" : "automatic",
    },
    legal: legalOf(settings, primaryUrl, since),
    support: supportOf(settings, tenantKey),
    consent: consentOf(settings, since),
    seo: seoOf(settings, name, primaryUrl, environment),
    version: settings.version,
    updatedAt: settings.updatedAt.toISOString(),
  };
  return {
    locale: entryLocale,
    config,
    assets: assetRefsOf(settings, source.assets),
    airlineCardEnabled:
      environment === "live" ? settings.airlineCardEnabledLive : settings.airlineCardEnabledTest,
  };
}

/** The locales an entry was built from: the default one and every supported one. */
export function localesOf(entry: CachedStorefront): string[] {
  return entry.config.locales.map((locale) => locale.code);
}

/* ------------------------------------------------------------------------------------------------
 * The caller-specific part
 * ---------------------------------------------------------------------------------------------- */

/**
 * The public URL of an asset (`getPublicAsset`, OADR-0012 point 3): `/api/v1/assets/<key>/<id>.<ext>` on the
 * storefront's own origin for the edge (Caddy proxies `/api/*` to the API), `<PUBLIC_OTA_API_URL>/v1/assets/…`
 * for key callers.
 */
export function assetUrl(tenantKey: string, asset: AssetRef, audience: StorefrontAudience): string {
  const path = `/v1/assets/${tenantKey}/${asset.id}.${asset.extension}`;
  return audience.caller === "edge" ? `/api${path}` : `${audience.publicApiUrl.replace(/\/+$/, "")}${path}`;
}

/** Up to two initials of the brand name (A–Z, 0–9), else of the tenant key: the text of the fallback badge. */
export function brandInitials(name: string, tenantKey: string): string {
  const initials = name
    .normalize("NFD")
    .toUpperCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Z0-9]/g, "").charAt(0))
    .join("")
    .slice(0, 2);
  return initials === "" ? tenantKey.charAt(0).toUpperCase() : initials;
}

/**
 * The response of `storefront.get` for one caller: the cached part with the asset URLs of that caller (a `data:`
 * badge for a missing logo or favicon), the payment account of the request, and the payment fields that differ per
 * caller.
 */
export function storefrontFor(entry: CachedStorefront, audience: StorefrontAudience): StorefrontConfig {
  const { config, assets } = entry;
  const url = (asset: AssetRef | null): string | null =>
    asset === null ? null : assetUrl(config.tenantKey, asset, audience);
  const initials = brandInitials(config.name, config.tenantKey);
  return {
    ...config,
    branding: {
      ...config.branding,
      logoUrl: url(assets.logo) ?? codeBadge(initials, "wide"),
      logoDarkUrl: url(assets.logoDark),
      logoSquareUrl: url(assets.logoSquare),
      faviconUrl: url(assets.favicon) ?? codeBadge(initials, "square"),
    },
    seo: { ...config.seo, ogImageUrl: url(assets.ogImage) },
    // `airline_card` and `airlineCard` for the edge only, when the flag and AIRLINE_CARD_ENABLED are on.
    payment: paymentConfigFor(config.payment, audience.payment, airlineCardFor(entry, audience)),
  };
}

/* ------------------------------------------------------------------------------------------------
 * The cache entry
 * ---------------------------------------------------------------------------------------------- */

/** The version of the stored JSON (`{"v":1,…}`); an entry of another version is a miss and is replaced. */
export const STOREFRONT_CACHE_FORMAT = 1;

/** The JSON stored in Redis for an entry. */
export function encodeCachedStorefront(entry: CachedStorefront): string {
  return JSON.stringify({ v: STOREFRONT_CACHE_FORMAT, ...entry });
}

function isAssetRef(value: unknown): value is AssetRef | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value["id"] === "string" &&
      ASSET_ID.test(value["id"]) &&
      typeof value["extension"] === "string" &&
      ASSET_EXTENSIONS.has(value["extension"]))
  );
}

/**
 * An entry read back from Redis, or `undefined` when it is not one this version wrote (it is then rebuilt). The
 * check covers the envelope and the parts the service and `storefrontFor` rely on; the rest was built by
 * `toCachedStorefront` and is passed on as it was stored.
 */
export function decodeCachedStorefront(raw: string): CachedStorefront | undefined {
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(stored) || stored["v"] !== STOREFRONT_CACHE_FORMAT) {
    return undefined;
  }
  const { locale, config, assets, airlineCardEnabled } = stored;
  if (
    typeof locale !== "string" ||
    typeof airlineCardEnabled !== "boolean" ||
    !isRecord(config) ||
    typeof config["tenantKey"] !== "string" ||
    typeof config["name"] !== "string" ||
    typeof config["defaultLocale"] !== "string" ||
    !Array.isArray(config["locales"]) ||
    !config["locales"].every((item) => isRecord(item) && typeof item["code"] === "string") ||
    !isRecord(config["branding"]) ||
    !isRecord(config["seo"]) ||
    !isRecord(config["payment"]) ||
    !isRecord(assets) ||
    !["logo", "logoDark", "logoSquare", "favicon", "ogImage"].every((key) => isAssetRef(assets[key]))
  ) {
    return undefined;
  }
  return {
    locale,
    config: config as unknown as StorefrontBase,
    assets: assets as unknown as StorefrontAssetRefs,
    airlineCardEnabled,
  };
}
