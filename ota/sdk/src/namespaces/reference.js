// The `reference` namespace (docs/velexis-sdk/sdk/src/identity.d.ts `ReferenceApi`, ota/sdk/README.md §5.2,
// OADR-0016 points 1–3): read-only reference data (airports, cities, airlines, countries, currencies) from the shared
// `reference` schema. Public: a publishable key is enough and no user token is needed. Each method is one line
// through the generated route table (internal/operations.js); `ReferenceApi` in identity.js is inferred from this
// factory. The list methods resolve with a `Page` (`next()`, `for await` across pages).
//
// Responses are cacheable (the API sends `Cache-Control: public, max-age=86400` or longer), so the SDK leaves the
// fetch cache mode to the caller (`options.next` / `options.cache`).

import { op } from "../internal/operations.js";

/** @typedef {import("../internal/client.js").Core} Core */
/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @typedef {import("../types.js").Schemas} Schemas */
/** @template T @typedef {import("../shared.js").Page<T>} Page */
/** @typedef {import("../identity.js").LocationSearchParams} LocationSearchParams */
/** @typedef {import("../identity.js").AirportGetParams} AirportGetParams */
/** @typedef {import("../identity.js").AirlineListParams} AirlineListParams */
/** @typedef {import("../identity.js").AirlineGetParams} AirlineGetParams */
/** @typedef {import("../identity.js").CountryListParams} CountryListParams */
/** @typedef {import("../identity.js").CurrencyListParams} CurrencyListParams */
/** @typedef {import("../shared.js").AuthenticationError} AuthenticationError */
/** @typedef {import("../shared.js").PermissionError} PermissionError */
/** @typedef {import("../shared.js").ValidationError} ValidationError */
/** @typedef {import("../shared.js").NotFoundError} NotFoundError */
/** @typedef {import("../shared.js").RateLimitError} RateLimitError */
/** @typedef {import("../shared.js").ServerError} ServerError */
/** @typedef {import("../shared.js").ConnectionError} ConnectionError */

/**
 * The `reference` namespace of a client.
 * @param {Core} core the client's request core
 */
export function createReferenceApi(core) {
  return {
    /** Airport and city autocomplete. */
    locations: {
      /**
       * Autocompletes airports and cities by keyword, best match first (exact IATA code, then name prefixes ranked by
       * popularity); city results include their airports. `GET /v1/reference/locations`; `subType` is sent
       * comma-separated. Debounce and pass `options.signal` from a search field.
       * @param {LocationSearchParams} params
       * @param {RequestOptions} [options]
       * @returns {Promise<Page<Schemas["Location"]>>}
       * @throws {ValidationError} `VALIDATION_FAILED` (keyword shorter than 2 characters, bad `countryCode`)
       * @throws {AuthenticationError} `INVALID_API_KEY`
       * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
       * @throws {RateLimitError} `RATE_LIMITED`
       * @throws {ServerError} `INTERNAL_ERROR`
       * @throws {ConnectionError} `ABORTED` when `options.signal` cancels a stale request
       */
      search: (params, options) => core.call(op.reference_locations_search, params, options),
    },

    /** Airports by IATA code. */
    airports: {
      /**
       * Gets an airport by its IATA code: name, city, country, time zone and coordinates.
       * `GET /v1/reference/airports/{iataCode}`.
       * @param {AirportGetParams} params
       * @param {RequestOptions} [options]
       * @returns {Promise<Schemas["Airport"]>}
       * @throws {NotFoundError} `NOT_FOUND` (unknown code)
       * @throws {AuthenticationError} `INVALID_API_KEY`
       * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
       * @throws {RateLimitError} `RATE_LIMITED`
       * @throws {ServerError} `INTERNAL_ERROR`
       */
      get: (params, options) => core.call(op.reference_airports_get, params, options),
    },

    /** Airline names and logos. */
    airlines: {
      /**
       * Lists airlines, or resolves up to 100 IATA designators at once (names, alliance, logo URLs); unknown codes are
       * omitted. `GET /v1/reference/airlines`; `iataCodes` is sent comma-separated.
       * @param {AirlineListParams} [params]
       * @param {RequestOptions} [options]
       * @returns {Promise<Page<Schemas["Airline"]>>}
       * @throws {ValidationError} `VALIDATION_FAILED` (more than 100 codes, bad code format)
       * @throws {AuthenticationError} `INVALID_API_KEY`
       * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
       * @throws {RateLimitError} `RATE_LIMITED`
       * @throws {ServerError} `INTERNAL_ERROR`
       */
      list: (params, options) => core.call(op.reference_airlines_list, params, options),

      /**
       * Gets one airline by its IATA designator. `GET /v1/reference/airlines/{iataCode}`.
       * @param {AirlineGetParams} params
       * @param {RequestOptions} [options]
       * @returns {Promise<Schemas["Airline"]>}
       * @throws {NotFoundError} `NOT_FOUND`
       * @throws {AuthenticationError} `INVALID_API_KEY`
       * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
       * @throws {RateLimitError} `RATE_LIMITED`
       * @throws {ServerError} `INTERNAL_ERROR`
       */
      get: (params, options) => core.call(op.reference_airlines_get, params, options),
    },

    /** Countries (nationality, issuing country, phone calling codes). */
    countries: {
      /**
       * Lists countries (ISO codes, localised name, calling code, main currency, flag) sorted by localised name.
       * `GET /v1/reference/countries`; the names follow `options.locale`.
       * @param {CountryListParams} [params]
       * @param {RequestOptions} [options]
       * @returns {Promise<Page<Schemas["Country"]>>}
       * @throws {ValidationError} `VALIDATION_FAILED`
       * @throws {AuthenticationError} `INVALID_API_KEY`
       * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
       * @throws {RateLimitError} `RATE_LIMITED`
       * @throws {ServerError} `INTERNAL_ERROR`
       */
      list: (params, options) => core.call(op.reference_countries_list, params, options),
    },

    /** Currencies (codes, symbols, decimals). */
    currencies: {
      /**
       * Lists currencies (ISO 4217 code, localised name, symbol, decimals) sorted by code. The currencies the OTA sells
       * in are `storefront.get().currencies`. `GET /v1/reference/currencies`.
       * @param {CurrencyListParams} [params]
       * @param {RequestOptions} [options]
       * @returns {Promise<Page<Schemas["Currency"]>>}
       * @throws {ValidationError} `VALIDATION_FAILED`
       * @throws {AuthenticationError} `INVALID_API_KEY`
       * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
       * @throws {RateLimitError} `RATE_LIMITED`
       * @throws {ServerError} `INTERNAL_ERROR`
       */
      list: (params, options) => core.call(op.reference_currencies_list, params, options),
    },
  };
}
