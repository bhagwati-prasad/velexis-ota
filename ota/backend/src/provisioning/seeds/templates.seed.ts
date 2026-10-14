// The notification templates of a new tenant (OADR-0007 item 4, OADR-0013 item 3): one `notification_templates` row
// per MVP key whose English code default exists (`notifications/templates/<key>.{subject,html,txt}.hbs`), inserted
// with ON CONFLICT DO NOTHING on (key, channel, locale). A key without a row, because its files came in a later
// release or the OTA reset it, uses the code default at send time; nothing is ever backfilled.
import {
  DEFAULT_TEMPLATE_LOCALE,
  DEFAULT_TEMPLATES_DIR,
  loadTemplateDefaults,
  TEMPLATE_CHANNEL,
  TEMPLATE_REGISTRY,
  type TemplateKey,
} from "../../notifications/templates/registry";
import { newId } from "../../common/ids";
import type { TenantSeedDb } from "./index";

export interface SeedTemplatesOptions {
  /** Timestamp of the new `ntt_` ids. */
  readonly now?: Date | undefined;
  /** Where the code defaults are read. Default: the registry's folder. */
  readonly templatesDir?: string | undefined;
}

/**
 * Inserts the English code defaults that exist as system templates (`is_system`, active, channel `email`, locale
 * `en`, the key's sample data), keeping every row the tenant already has. Returns the keys it inserted, in registry
 * order. Without default files it sends no query.
 */
export async function seedNotificationTemplates(
  trx: TenantSeedDb,
  options: SeedTemplatesOptions = {},
): Promise<readonly TemplateKey[]> {
  const defaults = await loadTemplateDefaults(options.templatesDir ?? DEFAULT_TEMPLATES_DIR);
  if (defaults.length === 0) {
    return [];
  }
  const inserted = await trx
    .insertInto("notification_templates")
    .values(
      defaults.map((source) => ({
        id: newId("ntt", options.now),
        key: source.key,
        channel: TEMPLATE_CHANNEL,
        locale: DEFAULT_TEMPLATE_LOCALE,
        subject: source.subject,
        body_html: source.html,
        body_text: source.text,
        // jsonb is written as JSON text, so an array would never be sent as a PostgreSQL array literal.
        sample_data: JSON.stringify(TEMPLATE_REGISTRY[source.key].sampleData),
        is_system: true,
        is_active: true,
      })),
    )
    .onConflict((conflict) => conflict.columns(["key", "channel", "locale"]).doNothing())
    .returning("key")
    .execute();
  const keys = new Set(inserted.map((row) => row.key));
  return Object.freeze(defaults.map((source) => source.key).filter((key) => keys.has(key)));
}
