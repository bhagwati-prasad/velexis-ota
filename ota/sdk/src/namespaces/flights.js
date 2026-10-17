// The `flights` namespace (docs/velexis-sdk/sdk/src/flights.d.ts `FlightsApi`, guide B2, ota/sdk/README.md §5.2,
// OADR-0016 points 1–3): search → results (server-side filters, sort, facets, cursor pages) → offer → branded-fare
// upsell → pricing → ancillaries and fare rules, plus the console's seat-availability search (deferred). Each method
// is one line through the generated route table (internal/operations.js), which also gives `search`, `upsell` and
// `price` their 60 s timeout and the four POSTs their generated `Idempotency-Key`; `FlightsApi` in flights.js is
// inferred from this factory. Clients never send Amadeus offers back: they refer to `srch_…`, `off_…` and `prc_…` ids.
//
// Everything here is live, priced or time-limited, so every method sends `cache: "no-store"` to `fetch` unless the
// call sets `cache` or `next` itself (flights.d.ts "Caching", B2 §1).

import { op } from "../internal/operations.js";

/** @typedef {import("../internal/client.js").Core} Core */
/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @typedef {import("../flights.js").FlightSearch} FlightSearch */
/** @typedef {import("../flights.js").FlightSearchParams} FlightSearchParams */
/** @typedef {import("../flights.js").GetFlightSearchParams} GetFlightSearchParams */
/** @typedef {import("../flights.js").FlightResultsParams} FlightResultsParams */
/** @typedef {import("../flights.js").FlightResultsPage} FlightResultsPage */
/** @typedef {import("../flights.js").GetFlightOfferParams} GetFlightOfferParams */
/** @typedef {import("../flights.js").FlightOffer} FlightOffer */
/** @typedef {import("../flights.js").FlightUpsellParams} FlightUpsellParams */
/** @typedef {import("../flights.js").UpsellResult} UpsellResult */
/** @typedef {import("../flights.js").FlightAvailabilityParams} FlightAvailabilityParams */
/** @typedef {import("../flights.js").FlightAvailabilitySearchResult} FlightAvailabilitySearchResult */
/** @typedef {import("../flights.js").FlightPriceParams} FlightPriceParams */
/** @typedef {import("../flights.js").PricedOffer} PricedOffer */
/** @typedef {import("../flights.js").PricedOfferParams} PricedOfferParams */
/** @typedef {import("../flights.js").AncillaryCatalogue} AncillaryCatalogue */
/** @typedef {import("../flights.js").FareRuleSet} FareRuleSet */
/** @typedef {import("../shared.js").ValidationError} ValidationError */
/** @typedef {import("../shared.js").AuthenticationError} AuthenticationError */
/** @typedef {import("../shared.js").PermissionError} PermissionError */
/** @typedef {import("../shared.js").NotFoundError} NotFoundError */
/** @typedef {import("../shared.js").ConflictError} ConflictError */
/** @typedef {import("../shared.js").PriceChangedError} PriceChangedError */
/** @typedef {import("../shared.js").SoldOutError} SoldOutError */
/** @typedef {import("../shared.js").ExpiredError} ExpiredError */
/** @typedef {import("../shared.js").RateLimitError} RateLimitError */
/** @typedef {import("../shared.js").SupplierError} SupplierError */
/** @typedef {import("../shared.js").ServerError} ServerError */

/**
 * Whether a value is a plain object, the only kind of options `core.call` accepts.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * The request options of one `flights.*` call with the contract's default fetch cache mode, `no-store`: offers and
 * prices are live, and a cached copy would show a stale price or an expired offer. A call that sets `cache` or `next`
 * keeps its own choice. Options that are not a plain object are passed on unchanged, so `core.call` refuses them with
 * its usual `TypeError` (a copy would accept them and drop what they inherit).
 * @param {RequestOptions | undefined} options
 * @returns {RequestOptions | undefined}
 */
function live(options) {
  if (
    options !== undefined &&
    (!isPlainObject(options) || options.cache !== undefined || options.next !== undefined)
  ) {
    return options;
  }
  return { ...options, cache: "no-store" };
}

/**
 * The `flights` namespace of a client.
 * @param {Core} core the client's request core
 */
export function createFlightsApi(core) {
  return {
    /**
     * Searches flights (Amadeus Flight Offers Search: `mode: "simple"` takes the GET parameters, `"advanced"` the full
     * POST body in `query`), stores the search and its offers with the tenant's selling prices, and returns the search
     * with the first page of offers, facets, highlights and dictionaries. `POST /v1/flight-searches`; 60 s timeout and a
     * generated `Idempotency-Key`, so an automatic retry replays the stored search. With `resultOptions.async: true` it
     * resolves at once with `status: "pending"`: poll `getSearch`.
     * @param {FlightSearchParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<FlightSearch>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `UNPROCESSABLE` (422: past dates, infants > adults, more than 9 seats)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `FEATURE_DISABLED`
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`, `CONFLICT` (first attempt still running)
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
     */
    search: (params, options) => core.call(op.flights_search, params, live(options)),

    /**
     * Gets a stored search (criteria, trip summary, status, result count, highlights, unfiltered facets) without its
     * offers; also the polling endpoint of an asynchronous search (`pending` → `completed` or `failed`), and still
     * readable after `expiresAt` with `status: "expired"`. `GET /v1/flight-searches/{searchId}`.
     * @param {GetFlightSearchParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<FlightSearch>}
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND` (unknown, purged, another customer's search, or an availability search id)
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    getSearch: (params, options) => core.call(op.flights_getSearch, params, live(options)),

    /**
     * Lists the offers of a search with server-side filters, sort, cursor pages and facets. Resolves with a page that
     * keeps `searchId`, `currency`, `total`, `facets`, `dictionaries` and `expiresAt`, has `next()` and is
     * async-iterable. `GET /v1/flight-searches/{searchId}/offers`; array filters are sent comma-separated. Changing
     * filters or sort invalidates the cursor.
     * @param {FlightResultsParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<FlightResultsPage>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (bad filter, a cursor from other filters)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {ConflictError} `SEARCH_NOT_COMPLETED` (an asynchronous search still pending, or failed)
     * @throws {ExpiredError} `SEARCH_EXPIRED` (search again)
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    listResults: (params, options) => core.call(op.flights_listResults, params, live(options)),

    /**
     * Gets one offer in full view: itineraries, segments, fare details per traveller and segment, price breakdown,
     * ticketing deadline, bookable seats, dictionaries and the wrapped Amadeus offer (selling amounts in customer
     * scope). The price is the search price; confirm it with `price`. `GET /v1/flight-offers/{offerId}`.
     * @param {GetFlightOfferParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<FlightOffer>}
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {ExpiredError} `OFFER_EXPIRED` (search again)
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    getOffer: (params, options) => core.call(op.flights_getOffer, params, live(options)),

    /**
     * Branded Fares Upsell: the airline's other fare families on the same flights as new offers, with a side-by-side
     * comparison; empty `offers` when the airline publishes none. `POST /v1/flight-offers/{offerId}/upsells`; 60 s
     * timeout and a generated `Idempotency-Key`.
     * @param {FlightUpsellParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<UpsellResult>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `OFFER_COMBINATION_INVALID` (422)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `FEATURE_DISABLED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {SoldOutError} `SOLD_OUT`
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`, `CONFLICT`
     * @throws {ExpiredError} `OFFER_EXPIRED`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
     */
    upsell: (params, options) => core.call(op.flights_upsell, params, live(options)),

    /**
     * Console only (secret key or staff token): Amadeus Flight Availabilities Search, the open booking classes and
     * bookable seats per class, without prices. `POST /v1/flight-availabilities` with a generated `Idempotency-Key`;
     * the client's `environment` is sent as `X-Velexis-Environment`. Deferred: the API answers `501 NOT_IMPLEMENTED`,
     * thrown as a `ServerError` that is not retryable.
     * @param {FlightAvailabilityParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<FlightAvailabilitySearchResult>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `UNPROCESSABLE` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `FEATURE_DISABLED`
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`, `CONFLICT`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
     */
    availability: (params, options) => core.call(op.flights_availability, params, live(options)),

    /**
     * Prices 1–6 offers of one search: the confirmed selling price with taxes and fees, booking requirements,
     * credit-card fees, selected ancillaries, fare conditions and expiry, stored as a priced offer (`prc_…`) to open a
     * checkout from. With `expectedTotal`, a different confirmed total throws `PriceChangedError` (the priced offer is
     * stored anyway: `error.pricedOfferId`). `POST /v1/priced-offers`; 60 s timeout and a generated `Idempotency-Key`.
     * @param {FlightPriceParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<PricedOffer>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `UNPROCESSABLE`, `TRAVELER_DATA_INVALID`, `OFFER_COMBINATION_INVALID`, `ANCILLARY_NOT_AVAILABLE` (422)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {PriceChangedError} `PRICE_CHANGED` (only with `expectedTotal`)
     * @throws {SoldOutError} `SOLD_OUT`
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`, `CONFLICT`
     * @throws {ExpiredError} `OFFER_EXPIRED`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
     */
    price: (params, options) => core.call(op.flights_price, params, live(options)),

    /**
     * Gets a stored priced offer, for example after a reload or after `PRICE_CHANGED`.
     * `GET /v1/priced-offers/{pricedOfferId}`.
     * @param {PricedOfferParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<PricedOffer>}
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {ExpiredError} `OFFER_EXPIRED` (price again)
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    getPricedOffer: (params, options) => core.call(op.flights_getPricedOffer, params, live(options)),

    /**
     * Gets the ancillary catalogue of a priced offer: extra bags, other services and chargeable seats per traveller and
     * segment, with selling prices. Buy options by pricing again with `additionalServices`. There is no seat map.
     * `GET /v1/priced-offers/{pricedOfferId}/ancillaries`.
     * @param {PricedOfferParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<AncillaryCatalogue>}
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `FEATURE_DISABLED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {ExpiredError} `OFFER_EXPIRED`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
     */
    getAncillaries: (params, options) => core.call(op.flights_getAncillaries, params, live(options)),

    /**
     * Gets the fare rules of a priced offer: a summary (refundable, changeable, maximum penalties), one entry per rule
     * category, detailed fare notes and the raw Amadeus rules. `GET /v1/priced-offers/{pricedOfferId}/fare-rules`.
     * @param {PricedOfferParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<FareRuleSet>}
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {ExpiredError} `OFFER_EXPIRED`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
     */
    getFareRules: (params, options) => core.call(op.flights_getFareRules, params, live(options)),
  };
}
