// The repository of the storefront context (ota/docs/architecture.md §2.1, OADR-0012): reads of the tenant's single
// `storefront_settings` row, the `storefront_assets` it references and the `reference.currencies` rows of its
// currencies, inside the request's `tenantTx` transaction (search_path `tenant_<key>, reference`). Like every
// repository it takes the transaction first and never opens one; the tenant tables are named without a schema, the
// reference table as `reference.currencies`, as the reference repository does.
//
// `settings` selects only the columns `storefront.get` publishes or derives from. The operational columns (the
// booking queue, `ops_alert_email`, TTLs, payment timing, search defaults) and the legacy `logo_url`/`favicon_url` of
// the baseline are never read here, so they cannot reach a response or the storefront cache.
//
// The jsonb columns are written by console.settings.storefront.update (OBE-070) in these shapes, which the mapper
// reads defensively (anything else falls back to the defaults of storefront.mapper.ts):
//
//   theme            {colors: {accent, background, text, surface?, mutedText?, success?, warning?, error?},
//                     fonts: {heading, body}, cornerRadius}   (primary and secondary are primary_color, secondary_color)
//   features         {ancillaries, brandedFareUpsell, selfServiceCancellation}
//   markets          [{countryCode, name, currency, locale}]
//   legal_links      [{kind, label, url} | {kind, label, pageSlug}]
//   support_details  {hours, helpCenterUrl, emergencyPhone}
//   seo              {titleTemplate, defaultTitle, defaultDescription, robots: {index, follow}}
//   consent          {regime, bannerRequired, policyVersion, categories: [{id, required, defaultEnabled, title,
//                     description}]}
//
// The five `*_asset_id` columns reference `storefront_assets` (RESTRICT); the response carries URLs built from the
// asset id and its file extension (OADR-0012 point 3), so `assetsByIds` reads those two columns and the kind.
import { Injectable } from "@nestjs/common";
import type { CurrencyRow } from "../reference/reference.repository";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** The settings row as `storefront.get` reads it; the jsonb columns are `unknown` (see the file header). */
export interface StorefrontSettingsRow {
  readonly brandName: string;
  readonly legalName: string | null;
  readonly timeZone: string;
  readonly primaryColor: string | null;
  readonly secondaryColor: string | null;
  readonly theme: unknown;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  readonly defaultCurrency: string;
  readonly supportedCurrencies: readonly string[];
  readonly defaultMarket: string | null;
  readonly markets: unknown;
  readonly supportEmail: string | null;
  readonly supportPhone: string | null;
  readonly supportDetails: unknown;
  readonly seo: unknown;
  readonly consent: unknown;
  readonly autoIssue: boolean | null;
  readonly acceptedCardBrands: readonly string[];
  readonly require3ds: boolean;
  readonly guestCheckoutEnabled: boolean;
  readonly customerAccountsEnabled: boolean;
  readonly requireEmailVerification: boolean;
  readonly features: unknown;
  readonly termsUrl: string | null;
  readonly privacyUrl: string | null;
  readonly legalLinks: unknown;
  readonly termsVersion: string | null;
  readonly privacyVersion: string | null;
  readonly airlineCardEnabledTest: boolean;
  readonly airlineCardEnabledLive: boolean;
  readonly logoAssetId: string | null;
  readonly logoDarkAssetId: string | null;
  readonly logoSquareAssetId: string | null;
  readonly faviconAssetId: string | null;
  readonly ogImageAssetId: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** An uploaded image referenced by the settings: what its public URL is built from. */
export interface StorefrontAssetRow {
  readonly id: string;
  readonly kind: string;
  /** `png`, `jpg`, `webp` or `ico` (the CHECK of `storefront_assets.file_extension`). */
  readonly fileExtension: string;
}

export type { CurrencyRow };

@Injectable()
export class StorefrontRepository {
  /** The tenant's settings row (`id = 'sfs_default'`, seeded at provisioning), or `undefined` when there is none. */
  async settings(trx: TenantTransaction): Promise<StorefrontSettingsRow | undefined> {
    return await trx
      .selectFrom("storefront_settings")
      .select([
        "brand_name as brandName",
        "legal_name as legalName",
        "time_zone as timeZone",
        "primary_color as primaryColor",
        "secondary_color as secondaryColor",
        "theme",
        "default_locale as defaultLocale",
        "supported_locales as supportedLocales",
        "default_currency as defaultCurrency",
        "supported_currencies as supportedCurrencies",
        "default_market as defaultMarket",
        "markets",
        "support_email as supportEmail",
        "support_phone as supportPhone",
        "support_details as supportDetails",
        "seo",
        "consent",
        "auto_issue as autoIssue",
        "accepted_card_brands as acceptedCardBrands",
        "require_3ds as require3ds",
        "guest_checkout_enabled as guestCheckoutEnabled",
        "customer_accounts_enabled as customerAccountsEnabled",
        "require_email_verification as requireEmailVerification",
        "features",
        "terms_url as termsUrl",
        "privacy_url as privacyUrl",
        "legal_links as legalLinks",
        "terms_version as termsVersion",
        "privacy_version as privacyVersion",
        "airline_card_enabled_test as airlineCardEnabledTest",
        "airline_card_enabled_live as airlineCardEnabledLive",
        "logo_asset_id as logoAssetId",
        "logo_dark_asset_id as logoDarkAssetId",
        "logo_square_asset_id as logoSquareAssetId",
        "favicon_asset_id as faviconAssetId",
        "og_image_asset_id as ogImageAssetId",
        "version",
        "created_at as createdAt",
        "updated_at as updatedAt",
      ])
      .where("id", "=", "sfs_default")
      .executeTakeFirst();
  }

  /** The assets with these ids (any order; unknown ids are absent). */
  async assetsByIds(trx: TenantTransaction, ids: readonly string[]): Promise<StorefrontAssetRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("storefront_assets")
      .select(["id", "kind", "file_extension as fileExtension"])
      .where("id", "in", [...ids])
      .execute();
  }

  /** The `reference.currencies` rows of these codes (any order; unknown codes are absent). */
  async currenciesByCodes(trx: TenantTransaction, codes: readonly string[]): Promise<CurrencyRow[]> {
    if (codes.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("reference.currencies")
      .select(["code", "name", "symbol", "minor_units as minorUnits"])
      .where("code", "in", [...codes])
      .execute();
  }
}
