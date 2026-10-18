// The tenant repository of flight searches (OBE-021; OADR-0002, db README §2.1 and §6): `flight_searches` and the
// `flight_offers` of a search, the settings the search reads from `storefront_settings`, and the `reference` rows of
// the dictionaries. Like every tenant repository it takes the `tenantTx` transaction first, never opens one and never
// names a tenant schema; the reference tables are named `reference.<table>` (the transaction's search_path is
// `tenant_<key>, reference`).
//
// flights.listResults filters, sorts and pages in SQL on the summary columns filled at insert (`listOffers`), with the
// semantics of facets.ts `matchesFilters`; keyset pagination continues after the sort keys and the id of the last row
// of the previous page. `timestamp` and `date` columns are read as text (`to_char`), never through node-pg's local-time
// Date parsing.
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase, type Transaction } from "@velexis/db";
import type { FacetRow, ResultFilters, ResultSort, SortKeyValue, TimeWindow } from "./facets";
import { windowsByItinerary } from "./facets";
import type { StoredOffer } from "./offers.mapper";

/** The open tenant transaction of the request (`TenantTx.run`). */
type TenantTransaction = Transaction<TenantDatabase>;
/** A piece of SQL (`sql\`…\``). */
type Fragment = ReturnType<typeof sql.join>;

/** What a search reads of `storefront_settings`. */
export interface SearchSettingsRow {
  readonly defaultCurrency: string;
  readonly offerTtlMinutes: number;
  readonly searchDefaults: unknown;
}

/** A `flight_searches` row of kind `offers`. */
export interface SearchRow {
  readonly id: string;
  readonly environment: string;
  readonly mode: string;
  readonly channel: string;
  readonly customerId: string | null;
  readonly criteria: unknown;
  readonly amadeusRequest: unknown;
  readonly currency: string | null;
  readonly status: string;
  readonly resultCount: number;
  readonly dictionaries: unknown;
  readonly warnings: unknown;
  readonly facets: unknown;
  readonly highlights: unknown;
  readonly oneWayCombinations: unknown;
  readonly errorCode: string | null;
  readonly durationMs: number | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The fields written when a search completes. */
export interface SearchCompletion {
  readonly resultCount: number;
  readonly dictionaries: unknown;
  readonly warnings: unknown;
  readonly facets: unknown;
  readonly highlights: unknown;
  readonly oneWayCombinations: unknown;
  readonly durationMs: number;
  readonly expiresAt: Date;
  readonly completedAt: Date;
}

/** An offer of a listing page: the stored offer and the values of its sort keys. */
export interface ListedOffer extends StoredOffer {
  readonly bestScore: string | null;
  readonly totalDurationMinutes: number | null;
  readonly firstDepartureLocal: string;
  readonly lastArrivalLocal: string | null;
}

/** A facet row with the Amadeus offer id (for upsellOfferIds). */
export interface SearchOfferSummary extends FacetRow {
  readonly amadeusOfferId: string;
}

export interface AirportRow {
  readonly iataCode: string;
  readonly name: string;
  readonly cityCode: string | null;
  readonly cityName: string | null;
  readonly countryCode: string;
  readonly countryName: string;
  readonly timeZone: string | null;
}

export interface CityRow {
  readonly iataCode: string;
  readonly name: string;
  readonly countryCode: string;
  readonly countryName: string;
  readonly timeZone: string | null;
}

export interface AirlineRow {
  readonly iataCode: string;
  readonly name: string;
  readonly logoUrl: string | null;
}

export interface CurrencyRow {
  readonly code: string;
  readonly name: string;
  readonly minorUnits: number;
}

/** The supplier call of a search, for console diagnostics. */
export interface SearchSupplierRequest {
  readonly id: string;
  readonly amadeusOperationId: string;
  readonly environment: string;
  readonly durationMs: number | null;
}

/** One sort key: the column, its direction, and how its value is read for the cursor. */
interface SortKey {
  readonly column: string;
  readonly descending: boolean;
  readonly read: (row: ListedOffer) => SortKeyValue | null;
}

const SELLING: SortKey = { column: "o.selling_total", descending: false, read: (row) => row.sellingTotal };

/** The keys of each sort before the id (FlightOfferSort: ties by price, then id). */
const SORT_KEYS: Readonly<Record<ResultSort, readonly SortKey[]>> = Object.freeze({
  best: [{ column: "o.best_score", descending: false, read: (row) => row.bestScore }, SELLING],
  price: [SELLING],
  "-price": [{ ...SELLING, descending: true }],
  duration: [
    { column: "o.total_duration_minutes", descending: false, read: (row) => row.totalDurationMinutes },
    SELLING,
  ],
  departure: [
    { column: "o.first_departure_local", descending: false, read: (row) => row.firstDepartureLocal },
    SELLING,
  ],
  "-departure": [
    { column: "o.first_departure_local", descending: true, read: (row) => row.firstDepartureLocal },
    SELLING,
  ],
  arrival: [
    { column: "o.last_arrival_local", descending: false, read: (row) => row.lastArrivalLocal },
    SELLING,
  ],
  "-arrival": [
    { column: "o.last_arrival_local", descending: true, read: (row) => row.lastArrivalLocal },
    SELLING,
  ],
});

/** The values of the sort keys of `row` under `sort`, for its cursor. */
export function sortKeysOf(row: ListedOffer, sort: ResultSort): SortKeyValue[] {
  return SORT_KEYS[sort].map((key) => key.read(row) ?? "");
}

/** The largest PostgreSQL `int`. */
const INT_MAX = 2_147_483_647;
/** A `numeric` sort key as this API writes it (`selling_total::text`, `best_score::text`). */
const CURSOR_DECIMAL = /^-?\d{1,12}(?:\.\d{1,4})?$/;
/** A `timestamp` sort key as this API writes it (`to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS')`). */
const CURSOR_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** True when `value` can be compared with the column of `column` (its cast in `castOf`). */
function validKeyValue(column: string, value: SortKeyValue | undefined): boolean {
  switch (column) {
    case "o.selling_total":
    case "o.best_score":
      return typeof value === "string" && CURSOR_DECIMAL.test(value);
    case "o.total_duration_minutes":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= INT_MAX;
    default:
      // A real date and time: PostgreSQL refuses `2027-02-30T25:00:00` with an error, not with no rows.
      return (
        typeof value === "string" &&
        CURSOR_LOCAL.test(value) &&
        !Number.isNaN(Date.parse(`${value}Z`)) &&
        new Date(`${value}Z`).toISOString().slice(0, 19) === value
      );
  }
}

/**
 * True when `keys` hold one value of the right type for every sort key of `sort`. A cursor comes back from the client:
 * one it changed must be refused (`400`), never reach the SQL casts (a `500`) or silently match no row.
 */
export function validCursorKeys(sort: ResultSort, keys: readonly SortKeyValue[]): boolean {
  const columns = SORT_KEYS[sort];
  return (
    keys.length === columns.length && columns.every((key, index) => validKeyValue(key.column, keys[index]))
  );
}

/** The windows of one itinerary as one condition (ORed): inclusive, wrapping midnight when the end is earlier. */
function windowCondition(
  column: "itinerary_departure_minutes" | "itinerary_arrival_minutes",
  index: number,
  windows: readonly TimeWindow[],
): Fragment {
  const minutes = sql`o.${sql.ref(column)}[${index + 1}::int]`;
  return sql.join(
    windows.map((window) =>
      window.from <= window.to
        ? sql`(${minutes} BETWEEN ${window.from}::int AND ${window.to}::int)`
        : sql`(${minutes} >= ${window.from}::int OR ${minutes} <= ${window.to}::int)`,
    ),
    sql` OR `,
  );
}

/** The SQL conditions of the active filters (facets.ts `matchesFilters`). */
export function filterConditions(filters: ResultFilters): Fragment[] {
  const conditions: Fragment[] = [];
  if (filters.stops !== undefined) {
    const exact = filters.stops.filter((value) => value < 2);
    const twoOrMore = filters.stops.some((value) => value >= 2);
    conditions.push(
      sql`(o.max_stops = ANY(${exact}::int[]) OR (${twoOrMore}::boolean AND o.max_stops >= 2))`,
    );
  }
  if (filters.carriers !== undefined) {
    conditions.push(sql`o.marketing_carriers <@ ${filters.carriers}::text[]`);
  }
  if (filters.minPrice !== undefined) {
    conditions.push(sql`o.selling_total >= ${filters.minPrice}::numeric`);
  }
  if (filters.maxPrice !== undefined) {
    conditions.push(sql`o.selling_total <= ${filters.maxPrice}::numeric`);
  }
  for (const [kind, windows] of [
    ["itinerary_departure_minutes", filters.departureWindows],
    ["itinerary_arrival_minutes", filters.arrivalWindows],
  ] as const) {
    for (const [index, list] of windowsByItinerary(windows ?? [])) {
      conditions.push(sql`(${windowCondition(kind, index, list)})`);
    }
  }
  if (filters.maxDurationMinutes !== undefined) {
    conditions.push(sql`${filters.maxDurationMinutes}::int >= ALL(o.itinerary_duration_minutes)`);
  }
  if (filters.cabins !== undefined) {
    conditions.push(sql`o.main_cabin = ANY(${filters.cabins}::text[])`);
  }
  if (filters.minIncludedCheckedBags !== undefined) {
    conditions.push(sql`o.min_checked_bags >= ${filters.minIncludedCheckedBags}::int`);
  }
  if (filters.refundable !== undefined) {
    conditions.push(sql`o.refundable = ${filters.refundable}::boolean`);
  }
  if (filters.changeable !== undefined) {
    conditions.push(sql`o.changeable = ${filters.changeable}::boolean`);
  }
  if (filters.brandedFares !== undefined) {
    conditions.push(sql`o.branded_fares && ${filters.brandedFares}::text[]`);
  }
  return conditions;
}

/** The type a sort key's cursor value is compared as. */
function castOf(column: string): Fragment {
  switch (column) {
    case "o.selling_total":
    case "o.best_score":
      return sql`numeric`;
    case "o.total_duration_minutes":
      return sql`int`;
    default:
      return sql`timestamp`;
  }
}

/** Rows after the cursor position: lexicographic over the sort keys (each in its direction), then the id. */
function afterCondition(sort: ResultSort, keys: readonly SortKeyValue[], id: string): Fragment {
  const columns = SORT_KEYS[sort];
  const branches: Fragment[] = [];
  for (let index = 0; index <= columns.length; index += 1) {
    const equal = columns
      .slice(0, index)
      .map((key, position) => sql`${sql.ref(key.column)} = ${keys[position] ?? null}::${castOf(key.column)}`);
    const key = columns[index];
    const step =
      key === undefined
        ? sql`o.id > ${id}`
        : key.descending
          ? sql`${sql.ref(key.column)} < ${keys[index] ?? null}::${castOf(key.column)}`
          : sql`${sql.ref(key.column)} > ${keys[index] ?? null}::${castOf(key.column)}`;
    branches.push(sql`(${sql.join([...equal, step], sql` AND `)})`);
  }
  return sql`(${sql.join(branches, sql` OR `)})`;
}

function orderBy(sort: ResultSort): Fragment {
  return sql.join(
    [
      ...SORT_KEYS[sort].map((key) =>
        key.descending ? sql`${sql.ref(key.column)} DESC` : sql`${sql.ref(key.column)} ASC`,
      ),
      sql`o.id ASC`,
    ],
    sql`, `,
  );
}

const AMOUNTS_AS_TEXT = {
  netTotal: sql<string>`o.net_total::text`,
  markupAmount: sql<string>`o.markup_amount::text`,
  sellingTotal: sql<string>`o.selling_total::text`,
};

@Injectable()
export class SearchesRepository {
  /** The settings a search needs; `undefined` when the tenant has no settings row. */
  async settings(trx: TenantTransaction): Promise<SearchSettingsRow | undefined> {
    return await trx
      .selectFrom("storefront_settings")
      .select([
        "default_currency as defaultCurrency",
        "offer_ttl_minutes as offerTtlMinutes",
        "search_defaults as searchDefaults",
      ])
      .executeTakeFirst();
  }

  /** Inserts a search (pending). */
  async insertSearch(
    trx: TenantTransaction,
    row: Insertable<TenantDatabase["flight_searches"]>,
  ): Promise<void> {
    await trx.insertInto("flight_searches").values(row).execute();
  }

  /** Marks a pending search failed with its public error code. */
  async failSearch(
    trx: TenantTransaction,
    id: string,
    errorCode: string,
    durationMs: number,
    at: Date,
  ): Promise<void> {
    await trx
      .updateTable("flight_searches")
      .set({ status: "failed", error_code: errorCode, duration_ms: durationMs, updated_at: at })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .execute();
  }

  /** Completes a pending search; its offers are inserted in the same transaction. */
  async completeSearch(trx: TenantTransaction, id: string, completion: SearchCompletion): Promise<void> {
    await trx
      .updateTable("flight_searches")
      .set({
        status: "completed",
        result_count: completion.resultCount,
        dictionaries: JSON.stringify(completion.dictionaries ?? {}),
        warnings: JSON.stringify(completion.warnings ?? []),
        facets: JSON.stringify(completion.facets),
        highlights: JSON.stringify(completion.highlights),
        one_way_combinations: JSON.stringify(completion.oneWayCombinations ?? []),
        duration_ms: completion.durationMs,
        expires_at: completion.expiresAt,
        updated_at: completion.completedAt,
      })
      .where("id", "=", id)
      .execute();
  }

  /** Inserts the offers of a search in one multi-row statement (at most 250). */
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

  /** The search `id` of kind `offers`, or `undefined`. */
  async searchById(trx: TenantTransaction, id: string): Promise<SearchRow | undefined> {
    return await trx
      .selectFrom("flight_searches")
      .select([
        "id",
        "environment",
        "mode",
        "channel",
        "customer_id as customerId",
        "criteria",
        "amadeus_request as amadeusRequest",
        sql<string | null>`currency::text`.as("currency"),
        "status",
        "result_count as resultCount",
        "dictionaries",
        "warnings",
        "facets",
        "highlights",
        "one_way_combinations as oneWayCombinations",
        "error_code as errorCode",
        "duration_ms as durationMs",
        "expires_at as expiresAt",
        "created_at as createdAt",
        "updated_at as updatedAt",
      ])
      .where("id", "=", id)
      .where("kind", "=", "offers")
      .executeTakeFirst();
  }

  /**
   * One page of the offers of a search: the active filters, the sort, after `after` (the sort keys and id of the
   * last row of the previous page), at most `limit` rows.
   */
  async listOffers(
    trx: TenantTransaction,
    searchId: string,
    filters: ResultFilters,
    sort: ResultSort,
    after: { readonly keys: readonly SortKeyValue[]; readonly id: string } | undefined,
    limit: number,
  ): Promise<ListedOffer[]> {
    const conditions = [
      sql`o.search_id = ${searchId}`,
      sql`o.origin = 'search'`,
      ...filterConditions(filters),
      ...(after === undefined ? [] : [afterCondition(sort, after.keys, after.id)]),
    ];
    const { rows } = await sql<{
      id: string;
      search_id: string;
      source: string;
      payload: unknown;
      currency: string;
      net_total: string;
      markup_amount: string;
      selling_total: string;
      markup_rule_id: string | null;
      markup_rule_name: string | null;
      expires_at: Date;
      created_at: Date;
      best_score: string | null;
      total_duration_minutes: number | null;
      first_departure_local: string;
      last_arrival_local: string | null;
    }>`
      SELECT o.id, o.search_id, o.source, o.payload, o.currency::text AS currency,
             ${AMOUNTS_AS_TEXT.netTotal} AS net_total, ${AMOUNTS_AS_TEXT.markupAmount} AS markup_amount,
             ${AMOUNTS_AS_TEXT.sellingTotal} AS selling_total, o.markup_rule_id, r.name AS markup_rule_name,
             o.expires_at, o.created_at, o.best_score::text AS best_score, o.total_duration_minutes,
             to_char(o.first_departure_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS first_departure_local,
             to_char(o.last_arrival_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS last_arrival_local
      FROM flight_offers AS o
      LEFT JOIN markup_rules AS r ON r.id = o.markup_rule_id
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ${orderBy(sort)}
      LIMIT ${limit}::int
    `.execute(trx);
    return rows.map((row) => ({
      id: row.id,
      searchId: row.search_id,
      source: row.source,
      payload: row.payload,
      currency: row.currency,
      netTotal: row.net_total,
      markupAmount: row.markup_amount,
      sellingTotal: row.selling_total,
      markupRuleId: row.markup_rule_id,
      markupRuleName: row.markup_rule_name,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      bestScore: row.best_score,
      totalDurationMinutes: row.total_duration_minutes,
      firstDepartureLocal: row.first_departure_local,
      lastArrivalLocal: row.last_arrival_local,
    }));
  }

  /** The summary columns of every offer of a search (facets, upsell ids), without payloads. */
  async offerSummaries(trx: TenantTransaction, searchId: string): Promise<SearchOfferSummary[]> {
    const rows = await trx
      .selectFrom("flight_offers")
      .select([
        "id",
        "amadeus_offer_id as amadeusOfferId",
        sql<string>`selling_total::text`.as("sellingTotal"),
        "max_stops as maxStops",
        "marketing_carriers as marketingCarriers",
        "itinerary_departure_minutes as departureMinutes",
        "itinerary_arrival_minutes as arrivalMinutes",
        "itinerary_duration_minutes as durationMinutes",
        "total_duration_minutes as totalDurationMinutes",
        "main_cabin as mainCabin",
        "min_checked_bags as minCheckedBags",
        "refundable",
        "changeable",
        "branded_fares as brandedFares",
      ])
      .where("search_id", "=", searchId)
      .where("origin", "=", "search")
      .orderBy("id")
      .execute();
    return rows.map((row) => ({ ...row, totalDurationMinutes: row.totalDurationMinutes ?? 0 }));
  }

  /** The latest supplier call recorded for a search. */
  async latestSupplierRequest(
    trx: TenantTransaction,
    searchId: string,
  ): Promise<SearchSupplierRequest | undefined> {
    return await trx
      .selectFrom("supplier_requests")
      .select([
        "id",
        "amadeus_operation_id as amadeusOperationId",
        "environment",
        "duration_ms as durationMs",
      ])
      .where("search_id", "=", searchId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
  }

  // ---- Reference rows (dictionaries, rule countries, currency units) ------------------------------------------

  async airports(trx: TenantTransaction, codes: readonly string[]): Promise<AirportRow[]> {
    if (codes.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("reference.airports as a")
      .innerJoin("reference.countries as co", "co.code", "a.country_code")
      .leftJoin("reference.cities as c", "c.iata_code", "a.city_code")
      .select([
        sql<string>`a.iata_code::text`.as("iataCode"),
        "a.name as name",
        sql<string | null>`a.city_code::text`.as("cityCode"),
        sql<string | null>`coalesce(c.name, a.city_name)`.as("cityName"),
        sql<string>`a.country_code::text`.as("countryCode"),
        "co.name as countryName",
        "a.time_zone as timeZone",
      ])
      .where("a.iata_code", "in", [...codes])
      .execute();
  }

  async cities(trx: TenantTransaction, codes: readonly string[]): Promise<CityRow[]> {
    if (codes.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("reference.cities as c")
      .innerJoin("reference.countries as co", "co.code", "c.country_code")
      .select([
        sql<string>`c.iata_code::text`.as("iataCode"),
        "c.name as name",
        sql<string>`c.country_code::text`.as("countryCode"),
        "co.name as countryName",
        "c.time_zone as timeZone",
      ])
      .where("c.iata_code", "in", [...codes])
      .execute();
  }

  async airlines(trx: TenantTransaction, codes: readonly string[]): Promise<AirlineRow[]> {
    if (codes.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("reference.airlines")
      .select([
        sql<string>`iata_code::text`.as("iataCode"),
        sql<string>`coalesce(common_name, name)`.as("name"),
        "logo_url as logoUrl",
      ])
      .where("iata_code", "in", [...codes])
      .execute();
  }

  async aircraft(
    trx: TenantTransaction,
    codes: readonly string[],
  ): Promise<Array<{ iataCode: string; name: string }>> {
    if (codes.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("reference.aircraft")
      .select([sql<string>`iata_code::text`.as("iataCode"), "name"])
      .where("iata_code", "in", [...codes])
      .execute();
  }

  async currencies(trx: TenantTransaction, codes: readonly string[]): Promise<CurrencyRow[]> {
    if (codes.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("reference.currencies")
      .select([sql<string>`code::text`.as("code"), "name", "minor_units as minorUnits"])
      .where("code", "in", [...codes])
      .execute();
  }
}
