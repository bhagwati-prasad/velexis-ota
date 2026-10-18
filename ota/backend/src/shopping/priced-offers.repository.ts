// The tenant repository of priced offers (OBE-023; OADR-0002 point 3, OADR-0005 point 8, db README §2.1 and §6):
// `priced_offers` rows with the search their offers belong to (their environment and channel), the settings a
// pricing reads from `storefront_settings`, and the later loads of flights.getAncillaries and flights.getFareRules,
// written into the stored pricing snapshot once. Like every tenant repository it takes the `tenantTx` transaction
// first, never opens one and never names a tenant schema. Amounts are read as text (`numeric::text`) and the
// `date` column through `to_char`, never as JavaScript numbers or local-time dates.
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** What a pricing reads of `storefront_settings`. */
export interface PricingSettingsRow {
  readonly offerTtlMinutes: number;
  readonly features: unknown;
}

/** A `priced_offers` row with the search of its offers. */
export interface PricedOfferRow {
  readonly id: string;
  readonly environment: string;
  readonly offerId: string;
  readonly offerIds: readonly string[];
  readonly forceClass: boolean;
  readonly response: unknown;
  readonly priceChanged: boolean;
  readonly currency: string;
  readonly netTotal: string;
  readonly markupAmount: string;
  readonly feeAmount: string;
  readonly sellingTotal: string;
  readonly markupRuleId: string | null;
  /** `YYYY-MM-DD`. */
  readonly lastTicketingDate: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  /** The search of the priced offers (through the first offer). */
  readonly searchId: string;
  readonly searchEnvironment: string;
}

/** The later loads of the pricing snapshot (`response.velexis.loads.<kind>`). */
export type PricedOfferLoad = "ancillaries" | "fareRules";

@Injectable()
export class PricedOffersRepository {
  /** `offer_ttl_minutes` and `features` of the storefront settings; `undefined` without a settings row. */
  async settings(trx: TenantTransaction): Promise<PricingSettingsRow | undefined> {
    return await trx
      .selectFrom("storefront_settings")
      .select(["offer_ttl_minutes as offerTtlMinutes", "features"])
      .executeTakeFirst();
  }

  /** Inserts a priced offer (its offers exist: `offer_id` references the first of them). */
  async insert(trx: TenantTransaction, row: Insertable<TenantDatabase["priced_offers"]>): Promise<void> {
    await trx.insertInto("priced_offers").values(row).execute();
  }

  /** The priced offer with the search of its offers, or `undefined` for an unknown id. */
  async byId(trx: TenantTransaction, id: string): Promise<PricedOfferRow | undefined> {
    return await trx
      .selectFrom("priced_offers as p")
      .innerJoin("flight_offers as o", "o.id", "p.offer_id")
      .innerJoin("flight_searches as s", "s.id", "o.search_id")
      .select([
        "p.id as id",
        "p.environment as environment",
        "p.offer_id as offerId",
        "p.offer_ids as offerIds",
        "p.force_class as forceClass",
        "p.response as response",
        "p.price_changed as priceChanged",
        "p.markup_rule_id as markupRuleId",
        "p.expires_at as expiresAt",
        "p.created_at as createdAt",
        "s.id as searchId",
        "s.environment as searchEnvironment",
        sql<string>`p.currency::text`.as("currency"),
        sql<string>`p.net_total::text`.as("netTotal"),
        sql<string>`p.markup_amount::text`.as("markupAmount"),
        sql<string>`p.fee_amount::text`.as("feeAmount"),
        sql<string>`p.selling_total::text`.as("sellingTotal"),
        sql<string | null>`to_char(p.last_ticketing_date, 'YYYY-MM-DD')`.as("lastTicketingDate"),
      ])
      .where("p.id", "=", id)
      .executeTakeFirst();
  }

  /**
   * Stores what flights.getAncillaries or flights.getFareRules loaded (`load`, JSON) into the priced offer's snapshot,
   * unless a load of that kind is already stored: the first one wins, so the options' `anc_` ids never change once
   * answered. Answers whether this call stored it.
   */
  async storeLoad(
    trx: TenantTransaction,
    id: string,
    kind: PricedOfferLoad,
    load: string,
    now: Date,
  ): Promise<boolean> {
    const path = `{velexis,loads,${kind}}`;
    const result = await trx
      .updateTable("priced_offers")
      .set({
        response: sql`jsonb_set(response, ${path}::text[], ${load}::jsonb, true)`,
        updated_at: now,
      })
      .where("id", "=", id)
      .where(sql<boolean>`response #> ${path}::text[] IS NULL`)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
