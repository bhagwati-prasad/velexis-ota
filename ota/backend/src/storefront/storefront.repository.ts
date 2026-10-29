// The repository of the storefront context (ota/docs/architecture.md §2.1, OADR-0012): reads of the tenant's single
// `storefront_settings` row, the `storefront_assets` it references and the `reference.currencies` rows of its
// currencies, inside the request's `tenantTx` transaction (search_path `tenant_<key>, reference`). Like every
// repository it takes the transaction first and never opens one; the tenant tables are named without a schema, the
// reference table as `reference.currencies`, as the reference repository does.
//
// `settings` selects only the columns `storefront.get` publishes or derives from. The operational columns (the
// booking queue, `ops_alert_email`, TTLs, payment timing, search defaults) and the legacy `logo_url`/`favicon_url` of
// the baseline are never read there, so they cannot reach a response or the storefront cache.
//
// The console's storefront settings (console.settings.storefront.get and update, OBE-070;
// settings/storefront-settings.service.ts) read the row with its operational columns through `editableSettings`, into
// a row type of their own (`StorefrontSettingsEditRow`) that only the settings mapper reads, write it with
// `updateSettings`, and check what an update refers to: active currencies (with their minor units), time zones and
// countries of `reference`, assets by id, content-page slugs, and whether markup or fee rules that add an amount are
// active (the airline-card warning). `search_defaults`, `logo_url` and `favicon_url` are never read by either.
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
//
// The uploaded images themselves (OBE-071; settings/assets.service.ts, storefront/public-assets.controller.ts): the
// `storefront_assets` rows with their file metadata (`StoredAssetRow`), listed newest first with a keyset position,
// read by id or by storage key (`forUpdate` locks the row: a delete holds it against new settings references, whose
// foreign key check waits for it), inserted without a second row for a storage key (`ON CONFLICT DO NOTHING`), and
// deleted; and where an asset is in use: the settings columns that name it and the content pages whose body shows it.
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase, type Updateable } from "@velexis/db";
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

/** An uploaded image with its file metadata (OBE-071). */
export interface StoredAssetRow extends StorefrontAssetRow {
  readonly contentType: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  /** `tenant_<key>/assets/<sha256>.<ext>`: unique, so one row holds one file. */
  readonly storageKey: string;
  /** SHA-256 of the file, hex. */
  readonly contentHash: string;
  readonly createdAt: Date;
}

/** A listed asset with its keyset position: `created_at` in UTC with microseconds (`YYYY-MM-DDTHH:MM:SS.ffffff`). */
export interface ListedAssetRow extends StoredAssetRow {
  readonly sortKey: string;
}

/** The columns of `StoredAssetRow`. */
const ASSET_COLUMNS = [
  "id",
  "kind",
  "file_extension as fileExtension",
  "content_type as contentType",
  "file_name as fileName",
  "size_bytes as sizeBytes",
  "width",
  "height",
  "storage_key as storageKey",
  "content_hash as contentHash",
  "created_at as createdAt",
] as const;

/** The settings columns that reference an asset, as JSON pointers of the console's StorefrontSettings. */
export const ASSET_SETTINGS_COLUMNS = Object.freeze([
  ["logo_asset_id", "/branding/logoAssetId"],
  ["logo_dark_asset_id", "/branding/logoDarkAssetId"],
  ["logo_square_asset_id", "/branding/logoSquareAssetId"],
  ["favicon_asset_id", "/branding/faviconAssetId"],
  ["og_image_asset_id", "/seo/ogImageAssetId"],
] as const);

/** The columns of `settings`, as `StorefrontSettingsRow` names them. */
const SETTINGS_COLUMNS = [
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
] as const;

/** The columns of `editableSettings`: those of `settings` and the operational ones of the console. */
const EDIT_COLUMNS = [
  ...SETTINGS_COLUMNS,
  "ticketing_policy as ticketingPolicy",
  "payment_timing as paymentTiming",
  "offer_ttl_minutes as offerTtlMinutes",
  "checkout_ttl_minutes as checkoutTtlMinutes",
  "booking_queue_number as bookingQueueNumber",
  "booking_queue_category as bookingQueueCategory",
  "ops_alert_email as opsAlertEmail",
] as const;

/**
 * The settings row as the console reads and writes it (OBE-070): the columns of `storefront.get` and the operational
 * ones. Only the settings mapper reads it; it never reaches the storefront mapper or its cache.
 */
export interface StorefrontSettingsEditRow extends StorefrontSettingsRow {
  readonly ticketingPolicy: string;
  readonly paymentTiming: string;
  readonly offerTtlMinutes: number;
  readonly checkoutTtlMinutes: number;
  readonly bookingQueueNumber: number | null;
  readonly bookingQueueCategory: number;
  readonly opsAlertEmail: string | null;
}

/**
 * The columns an update of the console may write (jsonb as JSON text, conventions §1): never the id, the version, the
 * timestamps, the generated `auto_issue`, `search_defaults` or the legacy `logo_url` and `favicon_url`.
 */
export type StorefrontSettingsChanges = Omit<
  Updateable<TenantDatabase["storefront_settings"]>,
  | "id"
  | "version"
  | "created_at"
  | "updated_at"
  | "auto_issue"
  | "search_defaults"
  | "logo_url"
  | "favicon_url"
>;

@Injectable()
export class StorefrontRepository {
  /** The tenant's settings row (`id = 'sfs_default'`, seeded at provisioning), or `undefined` when there is none. */
  async settings(trx: TenantTransaction): Promise<StorefrontSettingsRow | undefined> {
    return await trx
      .selectFrom("storefront_settings")
      .select(SETTINGS_COLUMNS)
      .where("id", "=", "sfs_default")
      .executeTakeFirst();
  }

  /**
   * The settings row with its operational columns, for the console (OBE-070); `forUpdate` locks it until the end of
   * the transaction, so two updates never interleave between the `If-Match` check and the write.
   */
  async editableSettings(
    trx: TenantTransaction,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<StorefrontSettingsEditRow | undefined> {
    const query = trx.selectFrom("storefront_settings").select(EDIT_COLUMNS).where("id", "=", "sfs_default");
    return await (options.forUpdate === true ? query.forUpdate() : query).executeTakeFirst();
  }

  /**
   * Writes `changes` to the row at `version` and moves it to `version + 1` with `updated_at = now()`; `undefined`
   * when the row is no longer at that version (or is missing).
   */
  async updateSettings(
    trx: TenantTransaction,
    version: number,
    changes: StorefrontSettingsChanges,
  ): Promise<StorefrontSettingsEditRow | undefined> {
    return await trx
      .updateTable("storefront_settings")
      .set({ ...changes, version: sql<number>`version + 1`, updated_at: sql<Date>`now()` })
      .where("id", "=", "sfs_default")
      .where("version", "=", version)
      .returning(EDIT_COLUMNS)
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

  /** The active currencies of `reference.currencies` among `codes`, with their minor units (any order). */
  async activeCurrencies(
    trx: TenantTransaction,
    codes: readonly string[],
  ): Promise<Array<{ code: string; minorUnits: number }>> {
    if (codes.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("reference.currencies")
      .select(["code", "minor_units as minorUnits"])
      .where("code", "in", [...codes])
      .where("is_active", "=", true)
      .execute();
  }

  /** The codes among `codes` that are countries of `reference.countries`. */
  async countryCodes(trx: TenantTransaction, codes: readonly string[]): Promise<string[]> {
    if (codes.length === 0) {
      return [];
    }
    const rows = await trx
      .selectFrom("reference.countries")
      .select("code")
      .where("code", "in", [...codes])
      .execute();
    return rows.map((row) => row.code);
  }

  /** True when `name` is a time zone of `reference.time_zones`. */
  async timeZoneExists(trx: TenantTransaction, name: string): Promise<boolean> {
    const row = await trx
      .selectFrom("reference.time_zones")
      .select("name")
      .where("name", "=", name)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The slugs among `slugs` that name a content page of `storefront_pages` (in any locale). */
  async pageSlugs(trx: TenantTransaction, slugs: readonly string[]): Promise<string[]> {
    if (slugs.length === 0) {
      return [];
    }
    const rows = await trx
      .selectFrom("storefront_pages")
      .select("slug")
      .distinct()
      .where("slug", "in", [...slugs])
      .execute();
    return rows.map((row) => row.slug);
  }

  /**
   * True when an active markup or fee rule that has not ended at `now` adds an amount: a percentage, a fixed amount or
   * a minimum other than zero (the default rule at 0 % does not). The airline card sells at the airline's price, so
   * such rules are not applied there (OADR-0004 point 4).
   */
  async hasAmountAddingRules(trx: TenantTransaction, now: Date): Promise<boolean> {
    const addsAmount = sql<boolean>`(coalesce(percentage, 0) <> 0 OR coalesce(fixed_amount, 0) <> 0 OR coalesce(min_amount, 0) <> 0)`;
    const markup = await trx
      .selectFrom("markup_rules")
      .select("id")
      .where("is_active", "=", true)
      .where((eb) => eb.or([eb("active_until", "is", null), eb("active_until", ">", now)]))
      .where(addsAmount)
      .limit(1)
      .executeTakeFirst();
    if (markup !== undefined) {
      return true;
    }
    const fee = await trx
      .selectFrom("fee_rules")
      .select("id")
      .where("is_active", "=", true)
      .where((eb) => eb.or([eb("active_until", "is", null), eb("active_until", ">", now)]))
      .where(addsAmount)
      .limit(1)
      .executeTakeFirst();
    return fee !== undefined;
  }

  // ---- Uploaded images (OBE-071) ------------------------------------------------------------------------------------

  /**
   * One page of the assets, of `kind` when given, newest first (`created_at`, then `id`), after the keyset position
   * `after`, at most `limit` rows.
   */
  async listAssets(
    trx: TenantTransaction,
    page: {
      readonly kind?: string | undefined;
      readonly after?: { readonly key: string; readonly id: string } | undefined;
      readonly limit: number;
    },
  ): Promise<ListedAssetRow[]> {
    let select = trx
      .selectFrom("storefront_assets")
      .select([
        ...ASSET_COLUMNS,
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`.as("sortKey"),
      ]);
    if (page.kind !== undefined) {
      select = select.where("kind", "=", page.kind);
    }
    if (page.after !== undefined) {
      select = select.where(
        sql<boolean>`(created_at, id) < (${page.after.key}::timestamp AT TIME ZONE 'UTC', ${page.after.id})`,
      );
    }
    return await select.orderBy("created_at", "desc").orderBy("id", "desc").limit(page.limit).execute();
  }

  /** The asset `id`; `forUpdate` locks its row until the end of the transaction. */
  async assetById(
    trx: TenantTransaction,
    id: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<StoredAssetRow | undefined> {
    const query = trx.selectFrom("storefront_assets").select(ASSET_COLUMNS).where("id", "=", id);
    return await (options.forUpdate === true ? query.forUpdate() : query).executeTakeFirst();
  }

  /** The asset whose file is stored under `storageKey`, its row locked until the end of the transaction. */
  async assetByStorageKeyForUpdate(
    trx: TenantTransaction,
    storageKey: string,
  ): Promise<StoredAssetRow | undefined> {
    return await trx
      .selectFrom("storefront_assets")
      .select(ASSET_COLUMNS)
      .where("storage_key", "=", storageKey)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Inserts an asset, unless a row already holds its storage key (written by a request that committed meanwhile):
   * `undefined` then, and nothing is written.
   */
  async insertAsset(
    trx: TenantTransaction,
    row: Insertable<TenantDatabase["storefront_assets"]>,
  ): Promise<StoredAssetRow | undefined> {
    return await trx
      .insertInto("storefront_assets")
      .values(row)
      .onConflict((conflict) => conflict.column("storage_key").doNothing())
      .returning(ASSET_COLUMNS)
      .executeTakeFirst();
  }

  /** Deletes the asset `id`; the settings' foreign keys refuse it while they reference it (RESTRICT). */
  async deleteAsset(trx: TenantTransaction, id: string): Promise<void> {
    await trx.deleteFrom("storefront_assets").where("id", "=", id).execute();
  }

  /** The JSON pointers of the settings fields that reference the asset `id` (ASSET_SETTINGS_COLUMNS order). */
  async settingsReferencing(trx: TenantTransaction, id: string): Promise<string[]> {
    const row = await trx
      .selectFrom("storefront_settings")
      .select(ASSET_SETTINGS_COLUMNS.map(([column]) => column))
      .where("id", "=", "sfs_default")
      .executeTakeFirst();
    if (row === undefined) {
      return [];
    }
    return ASSET_SETTINGS_COLUMNS.filter(([column]) => row[column] === id).map(([, path]) => path);
  }

  /** The content pages whose body shows the asset `id` (`![alt](ast_…)`; its id anywhere in the body), by id. */
  async pagesShowing(trx: TenantTransaction, id: string): Promise<string[]> {
    const rows = await trx
      .selectFrom("storefront_pages")
      .select("id")
      .where(sql<boolean>`strpos(body_markdown, ${id}) > 0`)
      .orderBy("id")
      .execute();
    return rows.map((row) => row.id);
  }
}
