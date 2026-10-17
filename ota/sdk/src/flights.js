// The `flights` namespace, flight shopping (mirrors docs/velexis-sdk/sdk/src/flights.d.ts, ADR-0019, OADR-0016
// point 1): the typedefs of flights.d.ts with the same names, in the same order, and the factory of the namespace.
// `FlightsApi` is inferred from the factory in ./namespaces/flights.js, where each method is documented once.
//
// flights.d.ts also augments `PriceChangedError` with `pricedOfferId`; JavaScript cannot augment a class from another
// module, so the field is part of the class in shared.js. Schema types come only from `@velexis/api-types` through
// ./types.js; nothing here declares a name that shared.js exports, because index.js re-exports both with `export *`.

export { createFlightsApi } from "./namespaces/flights.js";

/* ------------------------------------------------------------------------------------------------------------ */
/* Schema aliases                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** A stored flight search (`srch_…`) with facets, highlights and (on creation) the first page of offers. @typedef {import("./types.js").Schemas["FlightSearch"]} FlightSearch */
/** A bookable flight offer (`off_…`) with the tenant's selling price and the wrapped Amadeus offer. @typedef {import("./types.js").Schemas["FlightOffer"]} FlightOffer */
/** Selling price of an offer or priced offer. @typedef {import("./types.js").Schemas["SellingPrice"]} SellingPrice */
/** Facet groups for a filter sidebar. @typedef {import("./types.js").Schemas["Facets"]} FlightFacets */
/** Display dictionaries (airports, cities, airlines, aircraft, currencies). @typedef {import("./types.js").Schemas["Dictionaries"]} FlightDictionaries */
/** Result of a Branded Fares Upsell (`ups_…`): new offers and a comparison table. @typedef {import("./types.js").Schemas["UpsellResult"]} UpsellResult */
/** Console availability search result (booking classes and seats per class). @typedef {import("./types.js").Schemas["FlightAvailabilitySearchResult"]} FlightAvailabilitySearchResult */
/** Priced offer (`prc_…`): confirmed price, booking requirements, card fees, ancillaries, conditions, expiry. @typedef {import("./types.js").Schemas["PricedOffer"]} PricedOffer */
/** Normalised ancillary catalogue of a priced offer. @typedef {import("./types.js").Schemas["AncillaryCatalogue"]} AncillaryCatalogue */
/** One purchasable ancillary option (`anc_…`). @typedef {import("./types.js").Schemas["AncillaryOption"]} AncillaryOption */
/** Fare rules of a priced offer (UI shape and raw Amadeus data). @typedef {import("./types.js").Schemas["FareRuleSet"]} FareRuleSet */
/** Booking requirements returned by pricing (contact and per-traveller data the airline needs). @typedef {import("./types.js").Schemas["PricingBookingRequirements"]} PricingBookingRequirements */

/** Cabin (Amadeus travel class). @typedef {"ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST"} CabinClass */
/** Result ordering; `best` = 60 % price, 30 % duration, 10 % stops. @typedef {"best" | "price" | "-price" | "duration" | "departure" | "-departure" | "arrival" | "-arrival"} FlightOfferSort */
/** `summary` (default for lists) omits `amadeus`, `travelerPricings` and `price.breakdown`; `full` includes them. @typedef {"summary" | "full"} FlightOfferView */
/** Amadeus pricing sub-resources (`include`). @typedef {"credit-card-fees" | "bags" | "other-services" | "detailed-fare-rules"} PricingInclude */
/** Card brands accepted by Amadeus for credit-card fees. @typedef {import("./types.js").Schemas["AmadeusPaymentBrand"]} PaymentCardBrand */
/** Time window of one itinerary, `{itineraryIndex}:{HH:MM}-{HH:MM}`, for example `"0:06:00-11:59"`. @typedef {`${number}:${string}-${string}`} ItineraryTimeWindow */
/** Lifecycle of a search: `pending` → `completed` | `failed`; `completed` → `expired`. @typedef {FlightSearch["status"]} FlightSearchStatus */

/**
 * Value of the `X-Velexis-Scope` request header of the shopping methods: `customer` (default for keys) = selling
 * amounts only; `console` (default for staff tokens; opt-in for a secret key without customer token) = net prices,
 * markup, verbatim Amadeus payloads, diagnostics, read-any.
 * @typedef {"customer" | "console"} FlightDataScope
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Parameters                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/** `flights.search` in SIMPLE mode: exactly the Amadeus `GET /v2/shopping/flight-offers` parameters (+ `resultOptions`). @typedef {import("./types.js").Schemas["FlightSearchSimpleRequest"]} FlightSearchSimpleParams */
/** `flights.search` in ADVANCED mode: the full Amadeus `POST /v2/shopping/flight-offers` body in `query` (+ `resultOptions`). @typedef {import("./types.js").Schemas["FlightSearchAdvancedRequest"]} FlightSearchAdvancedParams */
/** The Amadeus getFlightOffersQuery accepted in ADVANCED mode. @typedef {import("./types.js").Schemas["FlightSearchAdvancedQuery"]} FlightSearchAdvancedQuery */
/** `resultOptions` of `flights.search`: `async` (202 and polling) and the embedded first page (`limit`, `sort`, `view`). @typedef {import("./types.js").Schemas["FlightSearchResultOptions"]} FlightSearchResultOptions */
/** Parameters of `FlightsApi.search`, discriminated by `mode`. @typedef {FlightSearchSimpleParams | FlightSearchAdvancedParams} FlightSearchParams */

/**
 * Server-side filters of `FlightsApi.listResults` (all optional, combined with AND). Array filters are sent
 * comma-separated (`?carriers=AF,KL`).
 * @typedef {object} FlightResultFilters
 * @property {Array<0 | 1 | 2>} [stops] max stops of any itinerary: 0 = non-stop, 1, 2 = two or more; values are ORed
 * @property {string[]} [carriers] keep offers whose marketing carriers are all in this list (IATA codes)
 * @property {string} [minPrice] minimum selling total (all travellers), a decimal string in the search currency
 * @property {string} [maxPrice] maximum selling total (all travellers), a decimal string in the search currency
 * @property {ItineraryTimeWindow[]} [departureWindow] departure windows in local airport time (at most 24); windows of
 *   the same itinerary are ORed, windows of different itineraries ANDed
 * @property {ItineraryTimeWindow[]} [arrivalWindow] arrival windows in local airport time; same rules as
 *   `departureWindow`
 * @property {number} [maxDurationMinutes] every itinerary at most this many minutes
 * @property {CabinClass[]} [cabins] main cabin (the cabin of the longest segment)
 * @property {0 | 1 | 2 | 3} [minIncludedCheckedBags] included checked bags per adult on every segment, at least
 * @property {boolean} [refundable] only offers known to be refundable (`true`) or non-refundable (`false`)
 * @property {boolean} [changeable] only offers known to be changeable (`true`) or not changeable (`false`)
 * @property {string[]} [brandedFares] branded fare codes from the `brandedFares` facet, for example `["LIGHT"]`
 */

/**
 * Parameters of `FlightsApi.listResults`.
 * @typedef {import("./shared.js").ListParams & FlightResultFilters & { searchId: string, sort?: FlightOfferSort, view?: FlightOfferView }} FlightResultsParams
 */

/**
 * One page of offers with facets: a `Page` with the extra fields of the results screen (`searchId`, `currency`,
 * `total`, `sort`, `facets`, `dictionaries`, `expiresAt`, `warnings`).
 * @typedef {import("./shared.js").Page<FlightOffer> & import("./shared.js").WithWarnings & { searchId: string, currency: string, total: number, sort?: FlightOfferSort, facets: FlightFacets, dictionaries?: FlightDictionaries, expiresAt: string }} FlightResultsPage
 */

/** Parameters of `FlightsApi.getSearch`. @typedef {{ searchId: string }} GetFlightSearchParams */
/** Parameters of `FlightsApi.getOffer`. @typedef {{ offerId: string }} GetFlightOfferParams */

/**
 * Card hint for credit-card fees: `brand`, optional `bin` (first 6 digits, sent to Amadeus as `binNumber`) and
 * optional `offerIds`.
 * @typedef {import("./types.js").Schemas["OfferPaymentCard"]} OfferPaymentCard
 */

/**
 * Parameters of `FlightsApi.upsell`.
 * @typedef {object} FlightUpsellParams
 * @property {string} offerId the offer to upsell (`off_…`)
 * @property {string[]} [combineWithOfferIds] other offers of the same search to upsell together (at most 5)
 * @property {OfferPaymentCard[]} [payments] card information for card-dependent fees (Amadeus `payments`)
 */

/** Parameters of `FlightsApi.availability` (console): the Amadeus Flight Availabilities Search body in `query`. @typedef {import("./types.js").Schemas["FlightAvailabilitySearchRequest"]} FlightAvailabilityParams */
/** Amadeus getFlightAvailabilitiesQuery as the Flight Availabilities Search spec defines it. @typedef {import("./types.js").Schemas["FlightAvailabilityQuery"]} FlightAvailabilityQuery */
/** One ancillary to include when pricing: by `optionId` or explicitly by `type`; seats by `seatNumber`. @typedef {import("./types.js").Schemas["AncillarySelection"]} AncillarySelection */

/**
 * Options shared by both forms of `FlightPriceParams`.
 * @typedef {object} FlightPriceOptions
 * @property {PricingInclude[]} [include] Amadeus `include` sub-resources
 * @property {boolean} [forceClass] Amadeus `forceClass`: price in the offer's booking class; default false
 * @property {OfferPaymentCard[]} [payments] card brand and BIN per offer for credit-card fees
 * @property {import("./types.js").Schemas["AmadeusTraveler"][]} [travelers] traveller data that influences the fare;
 *   ids = `travelerPricings[].travelerId`
 * @property {AncillarySelection[]} [additionalServices] ancillaries to include in the price
 * @property {boolean} [fareRules] ask Amadeus for fare rules; default true
 * @property {import("./shared.js").Money} [expectedTotal] the total the customer saw; a different confirmed total
 *   throws `PriceChangedError` (the priced offer is still stored)
 */

/**
 * Parameters of `FlightsApi.price`: `offerIds` (1–6 offers of the same search, everyone) or raw `amadeusFlightOffers`
 * (console only).
 * @typedef {FlightPriceOptions & ({ offerIds: string[], amadeusFlightOffers?: never } | { amadeusFlightOffers: import("./types.js").Schemas["AmadeusFlightOffer"][], offerIds?: never })} FlightPriceParams
 */

/**
 * Parameters of `FlightsApi.getPricedOffer`, `FlightsApi.getAncillaries` and `FlightsApi.getFareRules`.
 * @typedef {{ pricedOfferId: string }} PricedOfferParams
 */

/**
 * `details` of a `409 PRICE_CHANGED` thrown by `FlightsApi.price`. Every field is also on the error itself, typed:
 * `PriceChangedError.oldPrice`, `.newPrice` and `.pricedOfferId`.
 * @typedef {object} PriceChangedDetails
 * @property {import("./shared.js").Money} oldPrice the `expectedTotal` sent by the client
 * @property {import("./shared.js").Money} newPrice the confirmed selling total
 * @property {string} pricedOfferId the stored priced offer with the new price
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Namespace                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** `client.flights`: flight shopping. @typedef {ReturnType<typeof import("./namespaces/flights.js").createFlightsApi>} FlightsApi */
