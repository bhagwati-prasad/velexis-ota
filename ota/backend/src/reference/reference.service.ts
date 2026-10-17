// The reference use cases (OBE-015; ota/docs/scope.md §3.1): the six `reference.*` operations of the SDK, read from
// the shared `reference` schema in one `tenantTx` transaction each. The tenant guard has resolved the caller's tenant
// (an edge host or an API key) before; the transaction's search_path is `<tenant schema>, reference`, and the
// repository reads only `reference.*` tables, so no tenant row is ever touched. Nothing here calls Amadeus.
import { Injectable } from "@nestjs/common";
import type { operations } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import { TenantTx } from "../tenancy/tenant-tx";
import {
  AIRLINE_CODES_DEFAULT_LIMIT,
  airportLocation,
  cityLocation,
  decodeKeysetCursor,
  decodeOffsetCursor,
  displayLanguage,
  encodeCursor,
  LOCATION_SEARCH_MAX_LIMIT,
  locationKeyword,
  locationSubTypes,
  pageLimit,
  ReferenceNames,
  toAirline,
  toAirport,
  toCountry,
  toCurrency,
  type Airline,
  type AirlinePage,
  type Airport,
  type CountryPage,
  type CurrencyPage,
  type Location,
  type LocationPage,
} from "./reference.mapper";
import { ReferenceRepository } from "./reference.repository";

type Query<Id extends keyof operations> = operations[Id]["parameters"]["query"];
export type SearchLocationsQuery = NonNullable<Query<"searchLocations">>;
export type ListAirlinesQuery = NonNullable<Query<"listAirlines">>;
export type ListCountriesQuery = NonNullable<Query<"listCountries">>;
export type ListCurrenciesQuery = NonNullable<Query<"listCurrencies">>;

@Injectable()
export class ReferenceService {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: ReferenceRepository,
  ) {}

  /** `reference.locations.search`: exact IATA code first, then prefix matches by rank; at most 20 per page. */
  async searchLocations(query: SearchLocationsQuery): Promise<LocationPage> {
    const limit = pageLimit(query.limit, LOCATION_SEARCH_MAX_LIMIT, LOCATION_SEARCH_MAX_LIMIT);
    const offset = decodeOffsetCursor(query.cursor);
    const keyword = locationKeyword(query.keyword);
    if (keyword === undefined) {
      return { data: [], page: { nextCursor: null, limit } };
    }
    return await this.tx.run(async (trx) => {
      const matches = await this.repository.matchingLocations(trx, {
        ...keyword,
        subTypes: locationSubTypes(query.subType),
        countryCode: query.countryCode,
        limit: limit + 1,
        offset,
      });
      const page = matches.slice(0, limit);
      const cityCodes = page.filter((match) => match.subType === "CITY").map((match) => match.iataCode);
      const airportCodes = page.filter((match) => match.subType === "AIRPORT").map((match) => match.iataCode);
      const cities = new Map(
        (await this.repository.citiesByCodes(trx, cityCodes)).map((row) => [row.iataCode, row]),
      );
      const airports = new Map(
        (await this.repository.airportsByCodes(trx, airportCodes)).map((row) => [row.iataCode, row]),
      );
      const cityAirports = await this.repository.airportsOfCities(trx, cityCodes);
      const data = page.flatMap((match): Location[] => {
        const location =
          match.subType === "CITY"
            ? withRow(cities.get(match.iataCode), (row) => cityLocation(row, cityAirports))
            : withRow(airports.get(match.iataCode), airportLocation);
        return location === undefined ? [] : [location];
      });
      return {
        data,
        page: {
          nextCursor: matches.length > limit ? encodeCursor({ o: offset + limit }) : null,
          limit,
        },
      };
    });
  }

  /** `reference.airports.get`: an open airport; unknown and closed codes are `404 NOT_FOUND`. */
  async getAirport(iataCode: string, acceptLanguage: string | undefined): Promise<Airport> {
    const names = new ReferenceNames(displayLanguage(acceptLanguage));
    const [row] = await this.tx.run((trx) => this.repository.airportsByCodes(trx, [iataCode]));
    const airport = row?.isActive === true ? toAirport(row, names) : undefined;
    if (airport === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return airport;
  }

  /**
   * `reference.airlines.list`: with `iataCodes` exactly those airlines (active or not, by code; unknown codes are
   * absent; one page of up to 100 unless `limit` asks for fewer), else the active airlines alphabetically.
   */
  async listAirlines(query: ListAirlinesQuery): Promise<AirlinePage> {
    const codes = query.iataCodes;
    if (codes !== undefined && codes.length > 0) {
      const limit = pageLimit(query.limit, AIRLINE_CODES_DEFAULT_LIMIT);
      const after = query.cursor === undefined ? undefined : decodeKeysetCursor(query.cursor, ["c"]).c;
      const rows = await this.tx.run((trx) => this.repository.airlinesByCodes(trx, codes, after, limit + 1));
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map(toAirline),
        page: {
          nextCursor: rows.length > limit && last !== undefined ? encodeCursor({ c: last.iataCode }) : null,
          limit,
        },
      };
    }
    const limit = pageLimit(query.limit);
    const position = query.cursor === undefined ? undefined : decodeKeysetCursor(query.cursor, ["n", "c"]);
    const rows = await this.tx.run((trx) =>
      this.repository.activeAirlines(
        trx,
        position === undefined ? undefined : { sortName: position.n, iataCode: position.c },
        limit + 1,
      ),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAirline),
      page: {
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor({ n: last.sortName, c: last.iataCode })
            : null,
        limit,
      },
    };
  }

  /** `reference.airlines.get`: any airline of the data, with `active`; unknown designators are `404 NOT_FOUND`. */
  async getAirline(iataCode: string): Promise<Airline> {
    const row = await this.tx.run((trx) => this.repository.airlineByCode(trx, iataCode));
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return toAirline(row);
  }

  /** `reference.countries.list`: every country, sorted by its name in the display language. */
  async listCountries(query: ListCountriesQuery, acceptLanguage: string | undefined): Promise<CountryPage> {
    const limit = pageLimit(query.limit);
    const offset = decodeOffsetCursor(query.cursor);
    const names = new ReferenceNames(displayLanguage(acceptLanguage));
    const rows = await this.tx.run((trx) => this.repository.countries(trx));
    const countries = rows
      .flatMap((row) => {
        const country = toCountry(row, names);
        return country === undefined ? [] : [country];
      })
      .sort((a, b) => names.compare(a.name, b.name) || (a.code < b.code ? -1 : 1));
    return {
      data: countries.slice(offset, offset + limit),
      page: {
        nextCursor: countries.length > offset + limit ? encodeCursor({ o: offset + limit }) : null,
        limit,
      },
    };
  }

  /** `reference.currencies.list`: the active currencies by code, names in the display language. */
  async listCurrencies(
    query: ListCurrenciesQuery,
    acceptLanguage: string | undefined,
  ): Promise<CurrencyPage> {
    const limit = pageLimit(query.limit);
    const after = query.cursor === undefined ? undefined : decodeKeysetCursor(query.cursor, ["c"]).c;
    const names = new ReferenceNames(displayLanguage(acceptLanguage));
    const rows = await this.tx.run((trx) => this.repository.activeCurrencies(trx, after, limit + 1));
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => toCurrency(row, names)),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor({ c: last.code }) : null,
        limit,
      },
    };
  }
}

/** `map(row)` for a row that is there; `undefined` for one that is not (a code that vanished between two reads). */
function withRow<R, T>(row: R | undefined, map: (row: R) => T | undefined): T | undefined {
  return row === undefined ? undefined : map(row);
}
