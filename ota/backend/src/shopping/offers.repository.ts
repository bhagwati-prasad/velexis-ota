// The tenant repository of stored offers and upsells (OBE-022; OADR-0002, db README §2.1 and §6): `flight_offers` read
// by id with the search that owns them (access follows the search) and the upsell that produced them, the
// `offer_upsells` rows of Branded Fares Upsell with their upsold offers (`origin = 'upsell'`), and the two settings an
// upsell reads. Like every tenant repository it takes the `tenantTx` transaction first, never opens one and never
// names a tenant schema; `reference.currencies` is named with its schema (the transaction's search_path is
// `tenant_<key>, reference`). Amounts are read as text (`numeric::text`), never as JavaScript numbers.
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import type { StoredOffer } from "./offers.mapper";

/** A `flight_offers` row with what its answers need of its search and upsell. */
export interface OfferRow extends StoredOffer {
  readonly environment: string;
  /** `search` or `upsell` (`raw` console offers have no search and are never read here). */
  readonly origin: string;
  readonly amadeusOfferId: string;
  /** Rank in the supplier answer. */
  readonly position: number | null;
  /** `ups_…` of the upsell that returned it (`origin = 'upsell'`). */
  readonly upsellId: string | null;
  /** The offer that was upsold, for an upsell offer. */
  readonly baseOfferId: string | null;
  /** The owning search: the customer it is bound to, its environment, channel and expiry. */
  readonly searchCustomerId: string | null;
  readonly searchEnvironment: string;
  readonly searchChannel: string;
  readonly searchExpiresAt: Date;
  /** The Amadeus dictionaries of the search answer and of the upsell answer (upsell offers). */
  readonly searchDictionaries: unknown;
  readonly upsellDictionaries: unknown;
  /** The search's cheapest / fastest / best offers (the offer's tags). */
  readonly searchHighlights: unknown;
}

/** An `offer_upsells` row. */
export interface UpsellRow {
  readonly id: string;
  readonly baseOfferId: string;
  readonly amadeusRequest: unknown;
  readonly warnings: unknown;
  readonly dictionaries: unknown;
  readonly status: string;
  readonly resultCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

const OFFER_COLUMNS = [
  "o.id as id",
  "o.environment as environment",
  "o.origin as origin",
  "o.amadeus_offer_id as amadeusOfferId",
  "o.position as position",
  "o.upsell_id as upsellId",
  "u.base_offer_id as baseOfferId",
  "o.source as source",
  "o.payload as payload",
  "o.markup_rule_id as markupRuleId",
  "r.name as markupRuleName",
  "o.expires_at as expiresAt",
  "o.created_at as createdAt",
  "s.id as searchId",
  "s.customer_id as searchCustomerId",
  "s.environment as searchEnvironment",
  "s.channel as searchChannel",
  "s.expires_at as searchExpiresAt",
  "s.dictionaries as searchDictionaries",
  "s.highlights as searchHighlights",
  "u.dictionaries as upsellDictionaries",
] as const;

@Injectable()
export class OffersRepository {
  /** The offers of `ids` that have a search (in no particular order); unknown ids are simply missing. */
  async offersByIds(trx: TenantTransaction, ids: readonly string[]): Promise<OfferRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return await this.offers(trx)
      .where("o.id", "in", [...ids])
      .execute();
  }

  /** The upsold offers of an upsell, in the order of the Amadeus answer. */
  async upsellOffers(trx: TenantTransaction, upsellId: string): Promise<OfferRow[]> {
    return await this.offers(trx)
      .where("o.upsell_id", "=", upsellId)
      .where("o.origin", "=", "upsell")
      .orderBy("o.position")
      .orderBy("o.id")
      .execute();
  }

  /** Amadeus offer id → `off_…` of the offers a search returned (an offer's `upsellFlightOfferIds`). */
  async searchOfferIds(trx: TenantTransaction, searchId: string): Promise<Map<string, string>> {
    const rows = await trx
      .selectFrom("flight_offers")
      .select(["id", "amadeus_offer_id as amadeusOfferId"])
      .where("search_id", "=", searchId)
      .where("origin", "=", "search")
      .execute();
    return new Map(rows.map((row) => [row.amadeusOfferId, row.id]));
  }

  /** `storefront_settings.features` (the upsell switch); `undefined` without a settings row. */
  async features(trx: TenantTransaction): Promise<unknown> {
    const row = await trx.selectFrom("storefront_settings").select("features").executeTakeFirst();
    return row?.features;
  }

  /** The minor units of a `reference.currencies` code, or `undefined` for an unknown code. */
  async minorUnits(trx: TenantTransaction, currency: string): Promise<number | undefined> {
    const row = await trx
      .selectFrom("reference.currencies")
      .select("minor_units as minorUnits")
      .where("code", "=", currency)
      .executeTakeFirst();
    return row?.minorUnits;
  }

  /**
   * The latest upsell of `baseOfferId` that sent exactly `amadeusRequest` (jsonb equality: the same offers and
   * payments) and has not expired at `now`: an identical request answers it again without calling Amadeus.
   */
  async reusableUpsell(
    trx: TenantTransaction,
    baseOfferId: string,
    amadeusRequest: string,
    now: Date,
  ): Promise<UpsellRow | undefined> {
    return await trx
      .selectFrom("offer_upsells")
      .select([
        "id",
        "base_offer_id as baseOfferId",
        "amadeus_request as amadeusRequest",
        "warnings",
        "dictionaries",
        "status",
        "result_count as resultCount",
        "expires_at as expiresAt",
        "created_at as createdAt",
      ])
      .where("base_offer_id", "=", baseOfferId)
      .where("status", "in", ["completed", "no_upsell"])
      .where("expires_at", ">", now)
      .where(sql<boolean>`amadeus_request = ${amadeusRequest}::jsonb`)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
  }

  /** Inserts an upsell; its offers follow in the same transaction (`flight_offers.upsell_id` references it). */
  async insertUpsell(
    trx: TenantTransaction,
    row: Insertable<TenantDatabase["offer_upsells"]>,
  ): Promise<void> {
    await trx.insertInto("offer_upsells").values(row).execute();
  }

  /** Inserts the upsold offers of an upsell in one multi-row statement. */
  async insertOffers(
    trx: TenantTransaction,
    rows: ReadonlyArray<Insertable<TenantDatabase["flight_offers"]>>,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await trx
      .insertInto("flight_offers")
      .values([...rows])
      .execute();
  }

  /** Offers joined with their search (inner: an offer without a search is not readable here) and upsell. */
  private offers(trx: TenantTransaction) {
    return trx
      .selectFrom("flight_offers as o")
      .innerJoin("flight_searches as s", "s.id", "o.search_id")
      .leftJoin("offer_upsells as u", "u.id", "o.upsell_id")
      .leftJoin("markup_rules as r", "r.id", "o.markup_rule_id")
      .select(OFFER_COLUMNS)
      .select([
        sql<string>`o.currency::text`.as("currency"),
        sql<string>`o.net_total::text`.as("netTotal"),
        sql<string>`o.markup_amount::text`.as("markupAmount"),
        sql<string>`o.selling_total::text`.as("sellingTotal"),
      ]);
  }
}
