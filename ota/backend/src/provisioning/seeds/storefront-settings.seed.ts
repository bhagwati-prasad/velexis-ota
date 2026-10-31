// The settings row of a new tenant (OADR-0007 item 4, tenant provisioning flow §2 step 5): one `storefront_settings`
// row with the tenant's name, currency and locale and the MVP defaults, inserted with ON CONFLICT DO NOTHING so a
// second run never overwrites what the OTA changed. The columns that tenant migration 0002 adds are written only when
// the schema has them, so the seed works on schema versions N-1 and N.
//
// The time zone (lead decision (2a) of 2026-10-30, FIX-W35-OTA): `time_zone` starts as the platform tenant's business
// time zone (`platform.tenants.time_zone`, which the provisioning service reads as `tenant_time_zone` before the
// transaction) when the runtime knows it, else `UTC` (`seedTimeZoneOf`). It is the OTA's day for a same-day void
// (bookings/cancellation-mode.ts), which console.bookings.get answers and the OTA admin shows; before, every OTA started
// in UTC while the OTA admin read the platform's zone, and the two could disagree on "today".
import { sql, type Insertable, type TenantDatabase } from "@velexis/db";
import { FALLBACK_TIME_ZONE, knownTimeZoneOr } from "../../common/time-zones";
import type { SeedTenant, TenantSeedDb } from "./index";

/** The fixed id of the one settings row of a tenant (`CHECK (id = 'sfs_default')`). */
export const STOREFRONT_SETTINGS_ID = "sfs_default";

/** The values every new tenant starts with, besides its name, currency, locale and time zone. */
export const STOREFRONT_SETTINGS_DEFAULTS = Object.freeze({
  /** The time zone of a tenant whose platform zone is missing or unknown to the runtime (`seedTimeZoneOf`). */
  timeZone: FALLBACK_TIME_ZONE,
  ticketingPolicy: "issue_after_payment",
  paymentTiming: "authorize_before_booking",
  /** The Velexis shared offices reserve queue 50 for new orders; an OTA with its own credentials changes it. */
  bookingQueueNumber: 50,
  bookingQueueCategory: 0,
  airlineCardEnabledTest: false,
  airlineCardEnabledLive: false,
});

/** The columns of tenant migration 0002 (data-model-migration-0002.md §6) that the seed writes. */
interface StorefrontSettings0002 {
  time_zone: string;
  booking_queue_number: number;
  booking_queue_category: number;
  airline_card_enabled_test: boolean;
  airline_card_enabled_live: boolean;
}

/** The seed's 0002 values for `tenant`, by column. */
function columns0002Of(tenant: SeedTenant): Readonly<StorefrontSettings0002> {
  return Object.freeze({
    time_zone: seedTimeZoneOf(tenant.timeZone),
    booking_queue_number: STOREFRONT_SETTINGS_DEFAULTS.bookingQueueNumber,
    booking_queue_category: STOREFRONT_SETTINGS_DEFAULTS.bookingQueueCategory,
    airline_card_enabled_test: STOREFRONT_SETTINGS_DEFAULTS.airlineCardEnabledTest,
    airline_card_enabled_live: STOREFRONT_SETTINGS_DEFAULTS.airlineCardEnabledLive,
  });
}

/** The columns added by tenant migration 0002 that the seed writes when they exist. */
export const STOREFRONT_SETTINGS_0002_COLUMNS: ReadonlyArray<keyof StorefrontSettings0002> = Object.freeze([
  "time_zone",
  "booking_queue_number",
  "booking_queue_category",
  "airline_card_enabled_test",
  "airline_card_enabled_live",
]);

/**
 * The `time_zone` a new tenant starts with: the platform tenant's zone when the runtime knows it, else `UTC`
 * (`STOREFRONT_SETTINGS_DEFAULTS.timeZone`; also for a tenant whose zone was not read).
 */
export function seedTimeZoneOf(platformTimeZone: string | null | undefined): string {
  return knownTimeZoneOr(platformTimeZone);
}

type StorefrontSettingsInsert = Insertable<TenantDatabase["storefront_settings"]> &
  Partial<StorefrontSettings0002>;

/**
 * The column names of `storefront_settings` in the transaction's tenant schema, read from the catalog. The table is
 * resolved through the `search_path` of the tenant transaction, never by a schema-qualified name.
 */
export async function storefrontSettingsColumns(trx: TenantSeedDb): Promise<ReadonlySet<string>> {
  const { rows } = await sql<{ name: string }>`
    SELECT attname AS name
    FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('storefront_settings') AND attnum > 0 AND NOT attisdropped
  `.execute(trx);
  return new Set(rows.map((row) => row.name));
}

/**
 * Inserts the tenant's settings row unless it exists: brand name = tenant name, default currency and locale from the
 * tenant (also the only supported ones, as the settings validation requires), `issue_after_payment`,
 * `authorize_before_booking`, and, on a schema with migration 0002, the tenant's time zone (`seedTimeZoneOf`: the
 * platform's when the runtime knows it, else `UTC`), booking queue 50 category 0 and the airline card off in both
 * environments. Returns true when it inserted the row.
 */
export async function seedStorefrontSettings(trx: TenantSeedDb, tenant: SeedTenant): Promise<boolean> {
  const columns = await storefrontSettingsColumns(trx);
  const values0002 = columns0002Of(tenant);
  const row: StorefrontSettingsInsert = {
    id: STOREFRONT_SETTINGS_ID,
    brand_name: tenant.name,
    default_currency: tenant.defaultCurrency,
    supported_currencies: [tenant.defaultCurrency],
    default_locale: tenant.defaultLocale,
    supported_locales: [tenant.defaultLocale],
    ticketing_policy: STOREFRONT_SETTINGS_DEFAULTS.ticketingPolicy,
    payment_timing: STOREFRONT_SETTINGS_DEFAULTS.paymentTiming,
  };
  for (const column of STOREFRONT_SETTINGS_0002_COLUMNS) {
    if (columns.has(column)) {
      Object.assign(row, { [column]: values0002[column] });
    }
  }
  const inserted = await trx
    .insertInto("storefront_settings")
    .values(row)
    .onConflict((conflict) => conflict.column("id").doNothing())
    .returning("id")
    .execute();
  return inserted.length > 0;
}
