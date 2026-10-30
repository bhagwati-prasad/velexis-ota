// The provisioning seeds (OADR-0007 item 4, tenant provisioning flow §2 step 5): the defaults every new tenant schema
// gets right after its migrations, in the same transaction. They live in code, not in a migration, because they use
// the tenant's name, currency and locale and must not run again on the deploy fan-out. Each one inserts with
// ON CONFLICT DO NOTHING, so a second run, after a retry or a duplicate message, never overwrites what the OTA changed.
import type { Kysely, TenantDatabase } from "@velexis/db";
import { seedDefaultMarkupRule } from "./markup-rules.seed";
import { seedStorefrontSettings } from "./storefront-settings.seed";
import { seedNotificationTemplates } from "./templates.seed";
import type { TemplateKey } from "../../notifications/templates/registry";

/**
 * The caller's open transaction on the tenant schema, whose `search_path` resolves the tenant tables: a
 * `Transaction` from `tenantTx`, or a Kysely bound to the provisioning connection inside its migration transaction.
 * The seeds never begin, commit or roll back.
 */
export type TenantSeedDb = Kysely<TenantDatabase>;

/** What the seeds take from the tenant (`platform.tenants`, read by the provisioning worker). */
export interface SeedTenant {
  /** The tenant's display name: the storefront's brand name. */
  readonly name: string;
  /** ISO 4217 code, such as `EUR`. */
  readonly defaultCurrency: string;
  /** BCP 47 locale, such as `en`. */
  readonly defaultLocale: string;
  /**
   * The tenant's business time zone (`platform.tenants.time_zone`, IANA), the storefront settings' first `time_zone`
   * when the runtime knows it; missing, `null` or unknown: `UTC` (FIX-W35-OTA).
   */
  readonly timeZone?: string | null | undefined;
}

export interface SeedTenantOptions {
  /** Timestamp of the new ids (`mkr_`, `ntt_`); the provisioning service passes `Clock.now()`. */
  readonly now?: Date | undefined;
  /** Folder of the template code defaults. Default: `notifications/templates/` (tests pass a fixture folder). */
  readonly templatesDir?: string | undefined;
}

/** What one run inserted; everything else already existed and was kept. */
export interface SeedTenantResult {
  readonly storefrontSettings: boolean;
  readonly defaultMarkupRule: boolean;
  /** The template keys inserted, in registry order. */
  readonly notificationTemplates: readonly TemplateKey[];
}

/**
 * Seeds the tenant schema of `trx` inside the caller's transaction: the `storefront_settings` row, the default markup
 * rule and the notification templates whose code defaults exist. Idempotent: rows that exist are never changed.
 */
export async function seedTenant(
  trx: TenantSeedDb,
  tenant: SeedTenant,
  options: SeedTenantOptions = {},
): Promise<SeedTenantResult> {
  const storefrontSettings = await seedStorefrontSettings(trx, tenant);
  const defaultMarkupRule = await seedDefaultMarkupRule(trx, options.now);
  const notificationTemplates = await seedNotificationTemplates(trx, {
    now: options.now,
    templatesDir: options.templatesDir,
  });
  return Object.freeze({ storefrontSettings, defaultMarkupRule, notificationTemplates });
}

export { DEFAULT_MARKUP_RULE, seedDefaultMarkupRule } from "./markup-rules.seed";
export {
  seedStorefrontSettings,
  seedTimeZoneOf,
  STOREFRONT_SETTINGS_0002_COLUMNS,
  STOREFRONT_SETTINGS_DEFAULTS,
  STOREFRONT_SETTINGS_ID,
  storefrontSettingsColumns,
} from "./storefront-settings.seed";
export { seedNotificationTemplates, type SeedTemplatesOptions } from "./templates.seed";
