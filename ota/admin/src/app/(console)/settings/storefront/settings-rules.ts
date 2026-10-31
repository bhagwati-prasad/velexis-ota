// The storefront settings of the OTA admin (OAD-014; routes.md §9, api-changes part 2 §2.3, OADR-0012 points 1, 4 and
// 6, OADR-0004): what the page (page.tsx), its sections (sections.tsx, theme-editor.tsx) and the server actions
// (actions.ts) share. A `"use server"` module may export only async functions, and server code cannot read the
// constants of a `"use client"` module (they reach it as client references), so the choices and their labels, the Zod
// mirrors of the thirteen sections of `StorefrontSettingsUpdate`, the form-to-body rules and the texts of the API's
// refusals live here, in a module without a directive that imports no server-only module and of the SDK only types
// (OADR-0018 point 1), as pricing-rules.ts does for the markup and fee rules.
//
// Every section is its own form and its own `PATCH` (each section sent replaces that section as a whole, the others
// keep their value), with `ifMatch` = the version the page displayed. The forms post flat fields named after the
// request body's JSON pointers (`brand.name`, `branding.colors.primary`, `markets.list.2.currency`), so the API's field
// errors land on the field that caused them (lib/errors.ts turns `/markets/list/2/currency` into
// `markets.list.2.currency`; `settingsFieldOf` folds an item of a code list into its list and maps a row's position in
// the body back to the row the form posted). A row list (markets, legal links) posts each row under its own index,
// which the body keeps in order; the consent categories post under their id (`consent.categories.analytics.title`).
import type {
  StorefrontSettings,
  StorefrontSettingsUpdate,
  StorefrontSettingsUpdateResult,
} from "@velexis/ota-sdk";
import { z } from "zod";

import type { Choice } from "@/app/(console)/bookings/[bookingId]/action-rules";
import type { ActionState } from "@/lib/action-state";

// ---- Sections ---------------------------------------------------------------------------------------------------

/** A top-level section of the settings, which an update replaces as a whole. */
export type SettingsSection = keyof StorefrontSettingsUpdate & keyof StorefrontSettings;

/** The sections in the document's order. */
export const SETTINGS_SECTIONS = Object.freeze([
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
] as const satisfies readonly SettingsSection[]);

/** A warning of the API about saved settings (`airline_card_net_price`, OADR-0004); new codes may appear. */
export type SettingsWarning = StorefrontSettingsUpdateResult["warnings"][number];

/** The state of a section's save: lib/action-state.ts's, and the API's warnings after a success. */
export interface SettingsActionState extends ActionState {
  readonly warnings?: readonly SettingsWarning[];
}

/** The warnings of a state (none before a save or after a failure). */
export function warningsOf(state: ActionState): readonly SettingsWarning[] {
  return (state as SettingsActionState).warnings ?? [];
}

/** The page of the settings, which every save revalidates. */
export const STOREFRONT_SETTINGS_PATH = "/settings/storefront";

/** The page's tabs (routes.md §9), each with the sections it shows; `?tab=` opens one. */
export const STOREFRONT_TABS = Object.freeze([
  { value: "brand", label: "Brand and theme", sections: ["brand", "branding"] },
  { value: "locales", label: "Locales and markets", sections: ["locales", "currencies", "markets"] },
  { value: "features", label: "Features", sections: ["features"] },
  { value: "policies", label: "Policies", sections: ["policies"] },
  { value: "payments", label: "Payments", sections: ["airlineCard"] },
  { value: "legal", label: "Legal and support", sections: ["legal", "support"] },
  { value: "seo", label: "SEO and consent", sections: ["seo", "consent"] },
  { value: "operations", label: "Operations", sections: ["operations"] },
] as const satisfies readonly {
  readonly value: string;
  readonly label: string;
  readonly sections: readonly SettingsSection[];
}[]);

/** A tab of the page. */
export type StorefrontTab = (typeof STOREFRONT_TABS)[number]["value"];

/** The tab a `?tab=` value opens: one of the tabs, else the first. */
export function storefrontTabOf(value: unknown): StorefrontTab {
  const found = STOREFRONT_TABS.find((tab) => tab.value === value);
  return found === undefined ? "brand" : found.value;
}

/** The hidden field of every section's form: the settings' `version` the page displayed (`ifMatch`). */
export const VERSION_FIELD = "version";

/** A version as the page renders it: a positive whole number. */
export const VERSION_PATTERN = /^[1-9][0-9]{0,9}$/;

// ---- Choices ----------------------------------------------------------------------------------------------------

type Branding = StorefrontSettings["branding"];
type FontFamily = Branding["fonts"]["heading"];
type CornerRadius = Branding["cornerRadius"];
type Policies = StorefrontSettings["policies"];
type CardBrand = Policies["acceptedCardBrands"][number];
type LegalLink = StorefrontSettings["legal"]["links"][number];
type LegalLinkKind = LegalLink["kind"];
type Consent = StorefrontSettings["consent"];
type ConsentCategory = Consent["categories"][number];
type ConsentCategoryId = ConsentCategory["id"];
type Market = StorefrontSettings["markets"]["list"][number];

/**
 * The font families bundled with the hosted storefront (`StorefrontFontFamily`; its `FONT_STACKS` and the API's
 * `BUNDLED_FONTS` are the same list): the only ones the API accepts.
 */
export const FONT_FAMILIES = Object.freeze([
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Source Sans 3",
  "Merriweather",
  "Playfair Display",
] as const satisfies readonly FontFamily[]);

/** A font family's CSS stack, as the storefront applies it (serif families fall back to Georgia). */
export function fontStackOf(family: string): string {
  const serif = family === "Merriweather" || family === "Playfair Display";
  return `"${family}", ${serif ? "Georgia, serif" : "system-ui, sans-serif"}`;
}

export const CORNER_RADII: readonly Choice<CornerRadius>[] = Object.freeze([
  { value: "none", label: "None (square corners)" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
]);

/** `cornerRadius` → the CSS radius the storefront uses (`RADIUS_VALUES` of its theme module). */
export const RADIUS_VALUES: Readonly<Record<CornerRadius, string>> = Object.freeze({
  none: "0",
  small: "0.25rem",
  medium: "0.5rem",
  large: "1rem",
});

/** The ticketing policies (OADR-0008), with what each does. */
export const TICKETING_POLICIES: readonly (Choice<Policies["ticketingPolicy"]> & {
  readonly detail: string;
})[] = Object.freeze([
  {
    value: "issue_after_payment",
    label: "Issue after payment",
    detail: "Tickets are issued once the payment is captured (the usual choice).",
  },
  {
    value: "issue_at_booking",
    label: "Issue at booking",
    detail: "Tickets are issued right after Amadeus confirms the order.",
  },
  {
    value: "manual_review",
    label: "Manual review",
    detail: "Every booking waits for staff to issue it in the OTA admin.",
  },
]);

/** The card brands (`AmadeusPaymentBrand`) in the document's order. */
export const CARD_BRANDS: readonly Choice<CardBrand>[] = Object.freeze([
  { value: "VISA", label: "Visa" },
  { value: "AMERICAN_EXPRESS", label: "American Express" },
  { value: "MASTERCARD", label: "Mastercard" },
  { value: "VISA_ELECTRON", label: "Visa Electron" },
  { value: "VISA_DEBIT", label: "Visa Debit" },
  { value: "MASTERCARD_DEBIT", label: "Mastercard Debit" },
  { value: "MAESTRO", label: "Maestro" },
  { value: "DINERS", label: "Diners Club" },
  { value: "MASTERCARD_IXARIS", label: "Mastercard (Ixaris)" },
  { value: "VISA_IXARIS", label: "Visa (Ixaris)" },
  { value: "MASTERCARD_AIRPLUS", label: "Mastercard (AirPlus)" },
  { value: "UATP_AIRPLUS", label: "UATP (AirPlus)" },
  { value: "PYTON", label: "Pyton" },
]);

export const LEGAL_LINK_KINDS: readonly Choice<LegalLinkKind>[] = Object.freeze([
  { value: "terms", label: "Terms and conditions" },
  { value: "privacy", label: "Privacy policy" },
  { value: "cookies", label: "Cookie policy" },
  { value: "refund_policy", label: "Refund policy" },
  { value: "imprint", label: "Imprint" },
  { value: "accessibility", label: "Accessibility statement" },
  { value: "other", label: "Other" },
]);

/** Where a legal link goes: an external page or a content page of the storefront. */
export const LEGAL_LINK_TARGETS: readonly Choice<"url" | "page">[] = Object.freeze([
  { value: "url", label: "External page (https)" },
  { value: "page", label: "Content page of the storefront" },
]);

export const CONSENT_REGIMES: readonly Choice<Consent["regime"]>[] = Object.freeze([
  { value: "gdpr", label: "GDPR (EU, EEA, UK)" },
  { value: "ccpa", label: "CCPA (California)" },
  { value: "lgpd", label: "LGPD (Brazil)" },
  { value: "none", label: "None" },
]);

/** The cookie categories, each at most once; only `necessary` may be required. */
export const CONSENT_CATEGORIES: readonly (Choice<ConsentCategoryId> & {
  readonly title: string;
  readonly description: string;
})[] = Object.freeze([
  {
    value: "necessary",
    label: "Necessary",
    title: "Necessary",
    description: "Needed for search, booking and sign-in; always on.",
  },
  {
    value: "preferences",
    label: "Preferences",
    title: "Preferences",
    description: "Remember your language and currency.",
  },
  {
    value: "analytics",
    label: "Analytics",
    title: "Analytics",
    description: "Help us understand how the site is used.",
  },
  {
    value: "marketing",
    label: "Marketing",
    title: "Marketing",
    description: "Show you offers on other sites.",
  },
]);

/** The only payment timing of the MVP (`capture_before_booking` and `pay_later` are refused). */
export const PAYMENT_TIMING: Policies["paymentTiming"] = "authorize_before_booking";

/** The longest lists of the document. */
export const MAX_LIST_LENGTH = Object.freeze({ locales: 20, currencies: 20, markets: 50, legalLinks: 20 });

// ---- Form fields ------------------------------------------------------------------------------------------------

/** The text of a field (`""` when absent or a file). */
function textOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** A checkbox: ticked posts `true`. */
function checkedOf(form: FormData, name: string): boolean {
  return form.get(name) === "true";
}

/** The values of a repeated field (checkboxes). */
function valuesOf(form: FormData, name: string): string[] {
  return form.getAll(name).filter((value): value is string => typeof value === "string");
}

/**
 * The keys a row list posted (`markets.list.<key>.<field>`), in the form's order of their numbers: the rows the form
 * shows, whatever their numbers.
 */
export function rowKeysOf(form: FormData, prefix: string): string[] {
  const keys = new Set<string>();
  for (const name of form.keys()) {
    if (name.startsWith(`${prefix}.`)) {
      const key = name.slice(prefix.length + 1).split(".")[0];
      if (key !== undefined && /^\d{1,3}$/.test(key)) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort((left, right) => Number(left) - Number(right));
}

/** A comma, semicolon or white-space separated list of codes, without empty items or repeats. */
export function splitCodes(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((item) => item.trim())
        .filter((item) => item !== ""),
    ),
  ];
}

/**
 * A locale as the API spells it: the language in lower case, the region in upper case (`fr_ca` → `fr-CA`); anything
 * else as it is, for the pattern to refuse.
 */
export function canonicalLocaleOf(value: string): string {
  const [language = "", region, ...rest] = value.split(/[-_]/);
  if (rest.length > 0) {
    return value;
  }
  return region === undefined ? language.toLowerCase() : `${language.toLowerCase()}-${region.toUpperCase()}`;
}

// ---- Schemas ----------------------------------------------------------------------------------------------------

const MESSAGES = Object.freeze({
  brandName: "Enter the brand name (at most 120 characters).",
  legalName: "Use at most 200 characters.",
  timeZone: "Choose the OTA's time zone.",
  color: "Enter a colour as #RRGGBB, like #0B5FFF.",
  font: "Choose one of the bundled fonts.",
  cornerRadius: "Choose a corner radius.",
  assetId: "Choose an image from the list.",
  locale: "Enter locales like en or fr-CA.",
  locales: "Enter locales like en, fr-CA, separated by commas (at most 20).",
  defaultLocale: (code: string) => `The supported locales must include the default one (${code}).`,
  currency: "Enter a currency code like EUR.",
  currencies: "Enter currency codes like EUR, USD, separated by commas (at most 20).",
  defaultCurrency: (code: string) => `The supported currencies must include the default one (${code}).`,
  country: "Enter a two-letter country code like NO.",
  marketName: "Enter the market's name (at most 80 characters).",
  markets: "Add at most 50 markets.",
  duplicateMarket: "Each country can be one market only.",
  defaultMarket: "The default market must be one of the markets below, or empty.",
  ticketingPolicy: "Choose when tickets are issued.",
  paymentTiming: "The payment is authorised before the booking: the only timing of the MVP.",
  cardBrands: "Choose at least one card brand.",
  offerTtl: "Enter a whole number of minutes from 5 to 240.",
  checkoutTtl: "Enter a whole number of minutes from 5 to 1440.",
  version: "Use at most 40 characters.",
  legalKind: "Choose what the link is for.",
  legalLabel: "Enter the link text (at most 80 characters).",
  legalTarget: "Choose where the link goes.",
  legalUrl: "Enter an https:// address.",
  pageSlug: "Enter a page slug like terms or refund-policy.",
  legalLinks: "Add at most 20 links.",
  email: "Enter an e-mail address like support@example.com.",
  phone: "Enter the number in international format, like +4722334455.",
  hours: "Use at most 200 characters.",
  titleTemplate: "Enter at most 120 characters with one %s where the page title goes, like %s | Acme Travel.",
  defaultTitle: "Use at most 120 characters.",
  defaultDescription: "Use at most 300 characters.",
  regime: "Choose the privacy regime.",
  categoryTitle: "Enter the category's title (at most 80 characters).",
  categoryDescription: "Use at most 500 characters.",
  queueNumber: "Enter a queue number from 0 to 99, or leave it empty for none.",
  queueCategory: "Enter a category from 0 to 255.",
});

const ASSET_ID = /^ast_[0-9A-Za-z]{16,40}$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const HTTPS = /^https:\/\/\S+$/;
// Close to the API's `format: email`; the API decides.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A trimmed text that is `null` when empty, else checked by `schema`. */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value))
    .pipe(schema.nullable());
}

/** A required trimmed text of 1 to `max` characters (Unicode code points, as JSON Schema counts them). */
function required(max: number, message: string) {
  return z
    .string()
    .trim()
    .refine((value) => [...value].length >= 1 && [...value].length <= max, message);
}

/** An optional text of at most `max` characters. */
function optionalText(max: number, message: string) {
  return optional(z.string().refine((value) => [...value].length <= max, message));
}

/** An optional asset id (the picker's empty choice is `null`). */
const assetIdField = optional(z.string().regex(ASSET_ID, MESSAGES.assetId));

/** A whole number from `min` to `max`. */
function wholeNumber(min: number, max: number, message: string) {
  return z
    .string()
    .trim()
    .regex(/^\d{1,6}$/, message)
    .transform(Number)
    .pipe(z.number().int().min(min, message).max(max, message));
}

/** A list of codes typed in one field: normalised, unique, each matching `pattern`, 1 to `max` of them. */
function codeList(pattern: RegExp, normalise: (code: string) => string, max: number, message: string) {
  return z.string().transform((value, context) => {
    const codes = [...new Set(splitCodes(value).map(normalise))];
    if (codes.length === 0 || codes.length > max || codes.some((code) => !pattern.test(code))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    }
    return codes;
  });
}

const brandSchema = z.object({
  name: required(120, MESSAGES.brandName),
  legalName: optionalText(200, MESSAGES.legalName),
  timeZone: required(64, MESSAGES.timeZone),
});

const colorField = z.string().trim().regex(HEX, MESSAGES.color);
const fontField = z.enum(FONT_FAMILIES, { errorMap: () => ({ message: MESSAGES.font }) });

const brandingSchema = z.object({
  logoAssetId: assetIdField,
  logoDarkAssetId: assetIdField,
  logoSquareAssetId: assetIdField,
  faviconAssetId: assetIdField,
  colors: z.object({
    primary: colorField,
    secondary: colorField,
    accent: colorField,
    background: colorField,
    text: colorField,
  }),
  fonts: z.object({ heading: fontField, body: fontField }),
  cornerRadius: z.enum(["none", "small", "medium", "large"], {
    errorMap: () => ({ message: MESSAGES.cornerRadius }),
  }),
});

const localesSchema = z
  .object({
    default: z.string().trim().transform(canonicalLocaleOf).pipe(z.string().regex(LOCALE, MESSAGES.locale)),
    supported: codeList(LOCALE, canonicalLocaleOf, MAX_LIST_LENGTH.locales, MESSAGES.locales),
  })
  .superRefine((value, context) => {
    if (!value.supported.includes(value.default)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supported"],
        message: MESSAGES.defaultLocale(value.default),
      });
    }
  });

const upper = (code: string): string => code.toUpperCase();

const currenciesSchema = z
  .object({
    default: z.string().trim().transform(upper).pipe(z.string().regex(CURRENCY, MESSAGES.currency)),
    supported: codeList(CURRENCY, upper, MAX_LIST_LENGTH.currencies, MESSAGES.currencies),
  })
  .superRefine((value, context) => {
    if (!value.supported.includes(value.default)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supported"],
        message: MESSAGES.defaultCurrency(value.default),
      });
    }
  });

const marketSchema = z.object({
  countryCode: z.string().trim().transform(upper).pipe(z.string().regex(COUNTRY, MESSAGES.country)),
  name: required(80, MESSAGES.marketName),
  currency: z.string().trim().transform(upper).pipe(z.string().regex(CURRENCY, MESSAGES.currency)),
  locale: z.string().trim().transform(canonicalLocaleOf).pipe(z.string().regex(LOCALE, MESSAGES.locale)),
});

const marketsSchema = z
  .object({
    default: optional(z.string().transform(upper).pipe(z.string().regex(COUNTRY, MESSAGES.country))),
    list: z.record(z.string(), marketSchema),
  })
  .superRefine((value, context) => {
    const rows = Object.entries(value.list);
    if (rows.length > MAX_LIST_LENGTH.markets) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["list"], message: MESSAGES.markets });
    }
    const seen = new Set<string>();
    for (const [key, market] of rows) {
      if (seen.has(market.countryCode)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["list", key, "countryCode"],
          message: MESSAGES.duplicateMarket,
        });
      }
      seen.add(market.countryCode);
    }
    if (value.default !== null && !seen.has(value.default)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["default"], message: MESSAGES.defaultMarket });
    }
  })
  .transform((value): StorefrontSettings["markets"] => ({
    default: value.default,
    list: Object.values(value.list) as Market[],
  }));

const featuresSchema = z.object({
  guestCheckout: z.boolean(),
  customerAccounts: z.boolean(),
  ancillaries: z.boolean(),
  brandedFareUpsell: z.boolean(),
  selfServiceCancellation: z.boolean(),
});

const policiesSchema = z.object({
  ticketingPolicy: z.enum(["issue_after_payment", "issue_at_booking", "manual_review"], {
    errorMap: () => ({ message: MESSAGES.ticketingPolicy }),
  }),
  paymentTiming: z.literal(PAYMENT_TIMING, { errorMap: () => ({ message: MESSAGES.paymentTiming }) }),
  require3ds: z.boolean(),
  // The ticked boxes, in the document's order; a value the form does not offer is dropped.
  acceptedCardBrands: z
    .array(z.string())
    .transform((brands): CardBrand[] =>
      CARD_BRANDS.map((brand) => brand.value).filter((brand) => brands.includes(brand)),
    )
    .refine((brands) => brands.length > 0, MESSAGES.cardBrands),
  requireEmailVerification: z.boolean(),
  offerTtlMinutes: wholeNumber(5, 240, MESSAGES.offerTtl),
  checkoutTtlMinutes: wholeNumber(5, 1440, MESSAGES.checkoutTtl),
});

const airlineCardSchema = z.object({ enabledTest: z.boolean(), enabledLive: z.boolean() });

const legalLinkSchema = z
  .object({
    kind: z.enum(["terms", "privacy", "cookies", "refund_policy", "imprint", "accessibility", "other"], {
      errorMap: () => ({ message: MESSAGES.legalKind }),
    }),
    label: required(80, MESSAGES.legalLabel),
    target: z.enum(["url", "page"], { errorMap: () => ({ message: MESSAGES.legalTarget }) }),
    url: z.string().trim(),
    pageSlug: z.string().trim(),
  })
  .superRefine((value, context) => {
    if (value.target === "url" && !(HTTPS.test(value.url) && URL.canParse(value.url))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: MESSAGES.legalUrl });
    }
    if (value.target === "page" && !SLUG.test(value.pageSlug)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["pageSlug"], message: MESSAGES.pageSlug });
    }
  })
  .transform((value): LegalLink =>
    value.target === "url"
      ? { kind: value.kind, label: value.label, url: value.url }
      : { kind: value.kind, label: value.label, pageSlug: value.pageSlug },
  );

const legalSchema = z
  .object({
    termsVersion: optionalText(40, MESSAGES.version),
    privacyVersion: optionalText(40, MESSAGES.version),
    links: z.record(z.string(), legalLinkSchema),
  })
  .superRefine((value, context) => {
    if (Object.keys(value.links).length > MAX_LIST_LENGTH.legalLinks) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["links"], message: MESSAGES.legalLinks });
    }
  })
  .transform((value): StorefrontSettings["legal"] => ({
    termsVersion: value.termsVersion,
    privacyVersion: value.privacyVersion,
    links: Object.values(value.links),
  }));

const httpsUrl = z
  .string()
  .regex(HTTPS, MESSAGES.legalUrl)
  .refine((value) => URL.canParse(value), MESSAGES.legalUrl);

const supportSchema = z.object({
  email: optional(z.string().regex(EMAIL, MESSAGES.email)),
  phone: optional(z.string().regex(E164, MESSAGES.phone)),
  hours: optionalText(200, MESSAGES.hours),
  helpCenterUrl: optional(httpsUrl),
  emergencyPhone: optional(z.string().regex(E164, MESSAGES.phone)),
});

const seoSchema = z.object({
  titleTemplate: optional(
    z.string().refine((value) => [...value].length <= 120 && value.includes("%s"), MESSAGES.titleTemplate),
  ),
  defaultTitle: optionalText(120, MESSAGES.defaultTitle),
  defaultDescription: optionalText(300, MESSAGES.defaultDescription),
  ogImageAssetId: assetIdField,
  robots: z.object({ index: z.boolean(), follow: z.boolean() }),
});

const consentCategorySchema = z.object({
  id: z.enum(["necessary", "preferences", "analytics", "marketing"]),
  required: z.boolean(),
  defaultEnabled: z.boolean(),
  title: required(80, MESSAGES.categoryTitle),
  description: z
    .string()
    .trim()
    .refine((value) => [...value].length <= 500, MESSAGES.categoryDescription),
});

const consentSchema = z
  .object({
    regime: z.enum(["gdpr", "ccpa", "lgpd", "none"], { errorMap: () => ({ message: MESSAGES.regime }) }),
    bannerRequired: z.boolean(),
    policyVersion: optionalText(40, MESSAGES.version),
    categories: z.record(z.string(), consentCategorySchema),
  })
  .transform((value): Consent => ({
    regime: value.regime,
    bannerRequired: value.bannerRequired,
    policyVersion: value.policyVersion,
    categories: Object.values(value.categories),
  }));

const operationsSchema = z.object({
  opsAlertEmail: optional(z.string().regex(EMAIL, MESSAGES.email)),
  bookingQueue: z.object({
    number: optional(
      z
        .string()
        .regex(/^\d{1,2}$/, MESSAGES.queueNumber)
        .transform(Number),
    ),
    category: wholeNumber(0, 255, MESSAGES.queueCategory),
  }),
});

/** The Zod mirror of each section of `StorefrontSettingsUpdate`, from the raw fields `formInputOf` reads. */
const SECTION_SCHEMAS = {
  brand: brandSchema,
  branding: brandingSchema,
  locales: localesSchema,
  currencies: currenciesSchema,
  markets: marketsSchema,
  features: featuresSchema,
  policies: policiesSchema,
  airlineCard: airlineCardSchema,
  legal: legalSchema,
  support: supportSchema,
  seo: seoSchema,
  consent: consentSchema,
  operations: operationsSchema,
} as const satisfies Record<SettingsSection, z.ZodTypeAny>;

// Compile-time check: each schema's output is the section of the request body.
type SchemaOutputs = { [S in SettingsSection]: z.output<(typeof SECTION_SCHEMAS)[S]> };
type SectionBodies = { [S in SettingsSection]: NonNullable<StorefrontSettingsUpdate[S]> };
const _schemasMatchTheContract: {
  [S in SettingsSection]: SchemaOutputs[S] extends SectionBodies[S] ? true : never;
} = {
  brand: true,
  branding: true,
  locales: true,
  currencies: true,
  markets: true,
  features: true,
  policies: true,
  airlineCard: true,
  legal: true,
  support: true,
  seo: true,
  consent: true,
  operations: true,
};

// ---- Form → body ------------------------------------------------------------------------------------------------

/** The rows a section's form posted, by list: their keys in the order the body lists them. */
export type PostedRows = Readonly<Record<string, readonly string[]>>;

/** The raw fields of a section's form (what its schema parses) and the rows it posted. */
function formInputOf(section: SettingsSection, form: FormData): { input: unknown; rows: PostedRows } {
  const text = (name: string): string => textOf(form, `${section}.${name}`);
  const checked = (name: string): boolean => checkedOf(form, `${section}.${name}`);
  switch (section) {
    case "brand":
      return {
        input: { name: text("name"), legalName: text("legalName"), timeZone: text("timeZone") },
        rows: {},
      };
    case "branding":
      return {
        input: {
          logoAssetId: text("logoAssetId"),
          logoDarkAssetId: text("logoDarkAssetId"),
          logoSquareAssetId: text("logoSquareAssetId"),
          faviconAssetId: text("faviconAssetId"),
          colors: {
            primary: text("colors.primary"),
            secondary: text("colors.secondary"),
            accent: text("colors.accent"),
            background: text("colors.background"),
            text: text("colors.text"),
          },
          fonts: { heading: text("fonts.heading"), body: text("fonts.body") },
          cornerRadius: text("cornerRadius"),
        },
        rows: {},
      };
    case "locales":
    case "currencies":
      return { input: { default: text("default"), supported: text("supported") }, rows: {} };
    case "markets": {
      const keys = rowKeysOf(form, "markets.list");
      return {
        input: {
          default: text("default"),
          list: Object.fromEntries(
            keys.map((key) => [
              key,
              {
                countryCode: text(`list.${key}.countryCode`),
                name: text(`list.${key}.name`),
                currency: text(`list.${key}.currency`),
                locale: text(`list.${key}.locale`),
              },
            ]),
          ),
        },
        rows: { "markets.list": keys },
      };
    }
    case "features":
      return {
        input: {
          guestCheckout: checked("guestCheckout"),
          customerAccounts: checked("customerAccounts"),
          ancillaries: checked("ancillaries"),
          brandedFareUpsell: checked("brandedFareUpsell"),
          selfServiceCancellation: checked("selfServiceCancellation"),
        },
        rows: {},
      };
    case "policies":
      return {
        input: {
          ticketingPolicy: text("ticketingPolicy"),
          paymentTiming: text("paymentTiming"),
          require3ds: checked("require3ds"),
          acceptedCardBrands: valuesOf(form, "policies.acceptedCardBrands"),
          requireEmailVerification: checked("requireEmailVerification"),
          offerTtlMinutes: text("offerTtlMinutes"),
          checkoutTtlMinutes: text("checkoutTtlMinutes"),
        },
        rows: {},
      };
    case "airlineCard":
      return {
        input: { enabledTest: checked("enabledTest"), enabledLive: checked("enabledLive") },
        rows: {},
      };
    case "legal": {
      const keys = rowKeysOf(form, "legal.links");
      return {
        input: {
          termsVersion: text("termsVersion"),
          privacyVersion: text("privacyVersion"),
          links: Object.fromEntries(
            keys.map((key) => [
              key,
              {
                kind: text(`links.${key}.kind`),
                label: text(`links.${key}.label`),
                target: text(`links.${key}.target`),
                url: text(`links.${key}.url`),
                pageSlug: text(`links.${key}.pageSlug`),
              },
            ]),
          ),
        },
        rows: { "legal.links": keys },
      };
    }
    case "support":
      return {
        input: {
          email: text("email"),
          phone: text("phone"),
          hours: text("hours"),
          helpCenterUrl: text("helpCenterUrl"),
          emergencyPhone: text("emergencyPhone"),
        },
        rows: {},
      };
    case "seo":
      return {
        input: {
          titleTemplate: text("titleTemplate"),
          defaultTitle: text("defaultTitle"),
          defaultDescription: text("defaultDescription"),
          ogImageAssetId: text("ogImageAssetId"),
          robots: { index: checked("robots.index"), follow: checked("robots.follow") },
        },
        rows: {},
      };
    case "consent": {
      const ids = CONSENT_CATEGORIES.map((category) => category.value).filter((id) =>
        checked(`categories.${id}.included`),
      );
      return {
        input: {
          regime: text("regime"),
          bannerRequired: checked("bannerRequired"),
          policyVersion: text("policyVersion"),
          categories: Object.fromEntries(
            ids.map((id) => [
              id,
              {
                id,
                // Only `necessary` may be required (`consent_category_required`); its form alone offers the box.
                required: id === "necessary" && checked(`categories.${id}.required`),
                defaultEnabled: checked(`categories.${id}.defaultEnabled`),
                title: text(`categories.${id}.title`),
                description: text(`categories.${id}.description`),
              },
            ]),
          ),
        },
        rows: { "consent.categories": ids },
      };
    }
    case "operations":
      return {
        input: {
          opsAlertEmail: text("opsAlertEmail"),
          bookingQueue: { number: text("bookingQueue.number"), category: text("bookingQueue.category") },
        },
        rows: {},
      };
  }
}

/** A section's form read and checked: the body to send and the rows it posted, or the Zod error. */
export type SectionParse =
  | {
      readonly success: true;
      readonly changes: StorefrontSettingsUpdate;
      readonly rows: PostedRows;
    }
  | { readonly success: false; readonly error: z.ZodError };

/**
 * The `StorefrontSettingsUpdate` of a section's form (that one section, complete, as the API replaces it), checked
 * with the Zod mirror of the document: the issues' paths are the form's field names (`brand.name`).
 */
export function sectionChangesOf(section: SettingsSection, form: FormData): SectionParse {
  const { input, rows } = formInputOf(section, form);
  const parsed = z.object({ [section]: SECTION_SCHEMAS[section] }).safeParse({ [section]: input });
  if (!parsed.success) {
    return { success: false, error: parsed.error };
  }
  return { success: true, changes: parsed.data as StorefrontSettingsUpdate, rows };
}

// ---- The API's answers ------------------------------------------------------------------------------------------

/** The code lists typed in one field: an item's error (`locales.supported.3`) belongs to the field. */
const CODE_LIST_FIELDS: readonly string[] = [
  "locales.supported",
  "currencies.supported",
  "policies.acceptedCardBrands",
];

/**
 * The form field of a field name derived from an API pointer (lib/errors.ts `fieldNameOfPointer`): an item of a code
 * list is its list; a row's position in the body (`markets.list.1.currency`) is the key the form posted it under
 * (`markets.list.2.currency` when the form showed rows 0 and 2), the consent categories' positions their ids; the
 * section's other fields as they are.
 */
export function settingsFieldOf(name: string, rows: PostedRows): string {
  for (const list of CODE_LIST_FIELDS) {
    if (name.startsWith(`${list}.`)) {
      return list;
    }
  }
  for (const [list, keys] of Object.entries(rows)) {
    if (!name.startsWith(`${list}.`)) {
      continue;
    }
    const [position = "", ...rest] = name.slice(list.length + 1).split(".");
    const key = /^\d+$/.test(position) ? keys[Number(position)] : undefined;
    if (key === undefined) {
      return list;
    }
    return [list, key, ...rest].join(".");
  }
  return name;
}

/** The texts of the reasons of `422 UNPROCESSABLE` (`details.reason`, with `details.path` the refused field). */
export const UNPROCESSABLE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  unknown_time_zone: "This time zone is not in the reference data. Choose another one.",
  asset_not_found: "This image no longer exists. Choose another one, or upload it again on the Assets page.",
  asset_kind: "This image was uploaded for another purpose. Choose one uploaded as this kind of image.",
  default_not_supported: "The supported list must include the default.",
  unknown_currency: "This is not an active currency of the reference data.",
  currency_not_supported:
    "This currency has more than two decimals, which the storefront cannot sell in. Choose another one.",
  unknown_country: "This is not a known country code.",
  duplicate_market: MESSAGES.duplicateMarket,
  market_not_listed: MESSAGES.defaultMarket,
  market_currency_not_supported: "Use one of the storefront's supported currencies (Locales and markets).",
  market_locale_not_supported: "Use one of the storefront's supported locales (Locales and markets).",
  page_not_found: "No content page has this slug. Create the page first (Settings → Pages).",
  payment_timing_not_supported: MESSAGES.paymentTiming,
  duplicate_consent_category: "Each cookie category can be listed once.",
  consent_category_required: "Only the necessary category can be required.",
});
