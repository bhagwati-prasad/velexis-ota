// The default markup rule of a new tenant (OADR-0007 item 4, tenant provisioning flow §2 step 5): one active
// catch-all rule at 0 %, priority 1000, flagged `is_default`. OTAs set real markups in the OTA admin; the default
// rule cannot be deleted, narrowed, switched off, dated or moved from priority 1000 there (OADR-0005 point 3, revised
// 2026-10-30), so a tenant has exactly one and it always matches.
import { newId } from "../../common/ids";
import type { TenantSeedDb } from "./index";

/** The seeded rule: matches everything (`scope {}`), adds 0 % and is evaluated after every rule an OTA creates. */
export const DEFAULT_MARKUP_RULE = Object.freeze({
  name: "Default",
  calculation: "percentage",
  /** A decimal string, never a number (conventions §1). */
  percentage: "0",
  priority: 1000,
  scope: Object.freeze({}),
  stackable: false,
  isDefault: true,
  isActive: true,
});

/**
 * Inserts the default rule unless the tenant already has one (`is_default`), with ON CONFLICT DO NOTHING: one
 * `INSERT … SELECT … WHERE NOT EXISTS`, so a second run, or a rule the OTA has edited since, changes nothing. Its id
 * is a new `mkr_` ULID stamped with `now`. Returns true when it inserted the rule.
 *
 * It belongs in the provisioning transaction, which holds the advisory lock of the tenant schema: two runs on the
 * same schema then never race past the `NOT EXISTS` together.
 */
export async function seedDefaultMarkupRule(trx: TenantSeedDb, now?: Date): Promise<boolean> {
  const rule = DEFAULT_MARKUP_RULE;
  const inserted = await trx
    .insertInto("markup_rules")
    .columns([
      "id",
      "name",
      "scope",
      "calculation",
      "percentage",
      "priority",
      "stackable",
      "is_default",
      "is_active",
    ])
    .expression(
      // Parameters in the select list of an INSERT … SELECT get no type from the target columns: each is cast.
      trx
        .selectNoFrom((eb) => [
          eb.cast<string>(eb.val(newId("mkr", now)), "text").as("id"),
          eb.cast<string>(eb.val(rule.name), "text").as("name"),
          eb.cast<string>(eb.val(JSON.stringify(rule.scope)), "jsonb").as("scope"),
          eb.cast<string>(eb.val(rule.calculation), "text").as("calculation"),
          eb.cast<string>(eb.val(rule.percentage), "numeric").as("percentage"),
          eb.cast<number>(eb.val(rule.priority), "integer").as("priority"),
          eb.cast<boolean>(eb.val(rule.stackable), "boolean").as("stackable"),
          eb.cast<boolean>(eb.val(rule.isDefault), "boolean").as("is_default"),
          eb.cast<boolean>(eb.val(rule.isActive), "boolean").as("is_active"),
        ])
        .where((eb) =>
          eb.not(eb.exists(eb.selectFrom("markup_rules").select("id").where("is_default", "=", true))),
        ),
    )
    .onConflict((conflict) => conflict.doNothing())
    .returning("id")
    .execute();
  return inserted.length > 0;
}
