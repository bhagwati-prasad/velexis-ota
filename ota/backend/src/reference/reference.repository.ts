// The repository of the reference context (ota/docs/architecture.md §2.1, ADR-0024): read-only queries on the shared
// `reference` schema (docs/velexis-sdk/db/reference.sql) inside the request's `tenantTx` transaction, whose
// search_path is `tenant_<key>, reference`. The tables are named `reference.<table>`, as the pricing repository reads
// `reference.currencies`: a tenant table can never shadow them, and no query here names a tenant table. Like every
// repository it takes the transaction first and never opens one.
//
// Rows the API document cannot represent are left out here, so pages stay full and the cursors stay stable:
// locations without a time zone or coordinates (`Location.timeZone` and `geoCode` are required), closed airports in
// the search, countries without an alpha-3 code, a calling code or a continent. The vendored snapshot has none of the
// first kind; the countries without a calling code are Antarctica and four uninhabited territories, and Kosovo has no
// alpha-3 code (tools/reference-data/README.md).
import { Injectable } from "@nestjs/common";
import { sql, type TenantDatabase, type Transaction } from "@velexis/db";

/** The open tenant transaction of the request (`TenantTx.run`). */
type ReferenceTransaction = Transaction<TenantDatabase>;

/** The location types of the search (`AmadeusLocationSubtype`). */
export type LocationSubType = "AIRPORT" | "CITY";

/** One match of the location search, in ranking order. */
export interface LocationMatch {
  readonly subType: LocationSubType;
  readonly iataCode: string;
}

/** What the location search looks for (reference.mapper.ts `locationKeyword` builds the patterns). */
export interface LocationSearch {
  /** The keyword with LIKE wildcards escaped: `lower(name) LIKE lower(<namePrefix>) || '%'` (reference.sql). */
  readonly namePrefix: string;
  /** The keyword as an IATA code (3 letters, upper case), for the exact-code match; absent otherwise. */
  readonly exactCode?: string | undefined;
  readonly subTypes: ReadonlySet<LocationSubType>;
  readonly countryCode?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

/** A city with its country's English name. */
export interface CityRow {
  readonly iataCode: string;
  readonly name: string;
  readonly countryCode: string;
  readonly countryName: string;
  readonly stateCode: string | null;
  readonly timeZone: string | null;
  /** `numeric(9,6)` as a decimal string. */
  readonly latitude: string | null;
  readonly longitude: string | null;
}

/** An airport (any location of `reference.airports`) with its served city and its country's English name. */
export interface AirportRow {
  readonly iataCode: string;
  readonly icaoCode: string | null;
  readonly name: string;
  readonly cityCode: string | null;
  /** `airports.city_name`, the denormalised name of the served city. */
  readonly cityName: string | null;
  /** `cities.name` of `city_code`, when the city is in the reference data. */
  readonly servedCityName: string | null;
  /** `cities.state_code` of `city_code`. */
  readonly stateCode: string | null;
  readonly countryCode: string;
  readonly countryName: string;
  readonly timeZone: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly isActive: boolean;
}

/** An airport of a city result (`Location.airports`). */
export interface CityAirportRow {
  readonly cityCode: string;
  readonly iataCode: string;
  readonly name: string;
}

export interface AirlineRow {
  readonly iataCode: string;
  readonly icaoCode: string | null;
  /** `common_name` when the data has one, else `name`. */
  readonly name: string;
  readonly alliance: string | null;
  readonly countryCode: string | null;
  readonly logoUrl: string | null;
  readonly isActive: boolean;
}

/** Where a page of the alphabetical airline list starts: after this sort key and code. */
export interface AirlineListPosition {
  /** `lower(COALESCE(common_name, name))` of the last airline of the previous page. */
  readonly sortName: string;
  readonly iataCode: string;
}

export interface CountryRow {
  readonly code: string;
  readonly alpha3: string;
  readonly name: string;
  readonly continentCode: string;
  readonly currencyCode: string | null;
  readonly callingCode: string;
}

export interface CurrencyRow {
  readonly code: string;
  readonly name: string;
  readonly symbol: string | null;
  readonly minorUnits: number;
}

/** Only the kind `airport` is offered by the search: rail and bus stations, heliports and seaplane bases are not. */
const SEARCHABLE_AIRPORT_KIND = "airport";

@Injectable()
export class ReferenceRepository {
  /**
   * The locations matching a keyword, best first: the exact IATA code (a city before an airport of the same code),
   * then the prefix matches on city names, airport names and the airports' city names by `search_rank`, a city before
   * an airport of the same rank, then by code. Inactive airports and other kinds than `airport` are left out. The
   * name conditions are `lower(name) LIKE …`, which the `text_pattern_ops` indexes of reference.sql serve.
   */
  async matchingLocations(trx: ReferenceTransaction, search: LocationSearch): Promise<LocationMatch[]> {
    const country = (column: string) =>
      search.countryCode === undefined ? sql`true` : sql`${sql.ref(column)} = ${search.countryCode}`;
    const exact = (column: string) =>
      search.exactCode === undefined ? sql`false` : sql`${sql.ref(column)} = ${search.exactCode}`;
    const prefix = sql`lower(${search.namePrefix}) || '%'`;
    const parts = [];
    if (search.subTypes.has("CITY")) {
      parts.push(sql`
        SELECT 'CITY' AS sub_type, c.iata_code, c.search_rank, ${exact("c.iata_code")} AS exact
        FROM reference.cities AS c
        WHERE c.time_zone IS NOT NULL AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL
          AND ${country("c.country_code")}
          AND (lower(c.name) LIKE ${prefix} OR ${exact("c.iata_code")})`);
    }
    if (search.subTypes.has("AIRPORT")) {
      parts.push(sql`
        SELECT 'AIRPORT' AS sub_type, a.iata_code, a.search_rank, ${exact("a.iata_code")} AS exact
        FROM reference.airports AS a
        WHERE a.is_active AND a.kind = ${SEARCHABLE_AIRPORT_KIND}
          AND a.time_zone IS NOT NULL AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL
          AND ${country("a.country_code")}
          AND (lower(a.name) LIKE ${prefix} OR lower(a.city_name) LIKE ${prefix} OR ${exact("a.iata_code")})`);
    }
    if (parts.length === 0) {
      return [];
    }
    const { rows } = await sql<{ sub_type: LocationSubType; iata_code: string }>`
      SELECT m.sub_type, m.iata_code
      FROM (${sql.join(parts, sql` UNION ALL `)}) AS m
      ORDER BY m.exact DESC, m.search_rank DESC, m.sub_type DESC, m.iata_code
      LIMIT ${search.limit} OFFSET ${search.offset}
    `.execute(trx);
    return rows.map((row) => ({ subType: row.sub_type, iataCode: row.iata_code }));
  }

  /** The cities of `codes` with their countries, in no particular order; unknown codes are absent. */
  async citiesByCodes(trx: ReferenceTransaction, codes: readonly string[]): Promise<CityRow[]> {
    if (codes.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("reference.cities as c")
      .innerJoin("reference.countries as co", "co.code", "c.country_code")
      .select([
        "c.iata_code as iataCode",
        "c.name as name",
        "c.country_code as countryCode",
        "co.name as countryName",
        "c.state_code as stateCode",
        "c.time_zone as timeZone",
        "c.latitude as latitude",
        "c.longitude as longitude",
      ])
      .where("c.iata_code", "in", codes)
      .execute();
  }

  /**
   * The airports of `codes` (any kind, open or closed) with their served city and country, in no particular order;
   * unknown codes are absent.
   */
  async airportsByCodes(trx: ReferenceTransaction, codes: readonly string[]): Promise<AirportRow[]> {
    if (codes.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("reference.airports as a")
      .innerJoin("reference.countries as co", "co.code", "a.country_code")
      .leftJoin("reference.cities as c", "c.iata_code", "a.city_code")
      .select([
        "a.iata_code as iataCode",
        "a.icao_code as icaoCode",
        "a.name as name",
        "a.city_code as cityCode",
        "a.city_name as cityName",
        "c.name as servedCityName",
        "c.state_code as stateCode",
        "a.country_code as countryCode",
        "co.name as countryName",
        "a.time_zone as timeZone",
        "a.latitude as latitude",
        "a.longitude as longitude",
        "a.is_active as isActive",
      ])
      .where("a.iata_code", "in", codes)
      .execute();
  }

  /** The open airports of the cities `cityCodes` that the search offers, by `search_rank` within each city. */
  async airportsOfCities(trx: ReferenceTransaction, cityCodes: readonly string[]): Promise<CityAirportRow[]> {
    if (cityCodes.length === 0) {
      return [];
    }
    const rows = await trx
      .selectFrom("reference.airports")
      .select(["city_code as cityCode", "iata_code as iataCode", "name"])
      .where("city_code", "in", cityCodes)
      .where("is_active", "=", true)
      .where("kind", "=", SEARCHABLE_AIRPORT_KIND)
      .orderBy("search_rank", "desc")
      .orderBy("iata_code")
      .execute();
    return rows.flatMap((row) => (row.cityCode === null ? [] : [{ ...row, cityCode: row.cityCode }]));
  }

  /** The airlines of `codes` (active or not), by code, from after `afterCode`, at most `limit`. */
  async airlinesByCodes(
    trx: ReferenceTransaction,
    codes: readonly string[],
    afterCode: string | undefined,
    limit: number,
  ): Promise<AirlineRow[]> {
    if (codes.length === 0) {
      return [];
    }
    let query = this.airlines(trx).where("iata_code", "in", codes);
    if (afterCode !== undefined) {
      query = query.where("iata_code", ">", afterCode);
    }
    return await query.orderBy("iata_code").limit(limit).execute();
  }

  /** A page of the active airlines in alphabetical order (lower-cased name, then code), from after `after`. */
  async activeAirlines(
    trx: ReferenceTransaction,
    after: AirlineListPosition | undefined,
    limit: number,
  ): Promise<Array<AirlineRow & { readonly sortName: string }>> {
    const sortName = sql<string>`lower(coalesce(common_name, name))`;
    let query = this.airlines(trx).select(sortName.as("sortName")).where("is_active", "=", true);
    if (after !== undefined) {
      query = query.where(
        sql<boolean>`(lower(coalesce(common_name, name)), iata_code) > (${after.sortName}, ${after.iataCode})`,
      );
    }
    return await query.orderBy(sortName).orderBy("iata_code").limit(limit).execute();
  }

  /** The airline `code`, active or not. */
  async airlineByCode(trx: ReferenceTransaction, code: string): Promise<AirlineRow | undefined> {
    return await this.airlines(trx).where("iata_code", "=", code).executeTakeFirst();
  }

  /** Every country the API can show (an alpha-3 code, a calling code and a continent), in no particular order. */
  async countries(trx: ReferenceTransaction): Promise<CountryRow[]> {
    const rows = await trx
      .selectFrom("reference.countries")
      .select([
        "code",
        "alpha3",
        "name",
        "continent_code as continentCode",
        "currency_code as currencyCode",
        "calling_code as callingCode",
      ])
      .where("alpha3", "is not", null)
      .where("calling_code", "is not", null)
      .where("continent_code", "is not", null)
      .execute();
    return rows.flatMap(({ alpha3, callingCode, continentCode, ...row }) =>
      alpha3 === null || callingCode === null || continentCode === null
        ? []
        : [{ ...row, alpha3, callingCode, continentCode }],
    );
  }

  /** A page of the active currencies by code, from after `afterCode`. */
  async activeCurrencies(
    trx: ReferenceTransaction,
    afterCode: string | undefined,
    limit: number,
  ): Promise<CurrencyRow[]> {
    let query = trx
      .selectFrom("reference.currencies")
      .select(["code", "name", "symbol", "minor_units as minorUnits"])
      .where("is_active", "=", true);
    if (afterCode !== undefined) {
      query = query.where("code", ">", afterCode);
    }
    return await query.orderBy("code").limit(limit).execute();
  }

  private airlines(trx: ReferenceTransaction) {
    return trx
      .selectFrom("reference.airlines")
      .select([
        "iata_code as iataCode",
        "icao_code as icaoCode",
        sql<string>`coalesce(common_name, name)`.as("name"),
        "alliance",
        "country_code as countryCode",
        "logo_url as logoUrl",
        "is_active as isActive",
      ]);
  }
}
