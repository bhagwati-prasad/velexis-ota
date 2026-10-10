/**
 * @velexis/ota-sdk — `flights` namespace (area B2: flight shopping).
 *
 * Search → results (server-side filters, sort, facets, cursor pages) → offer details → branded-fare upsell
 * → pricing (confirmed price, taxes/fees, booking requirements, credit-card fees) → ancillary catalogue → fare rules,
 * plus the console seat-availability search.
 *
 * Every method maps 1:1 to an operation of the Velexis OTA Booking API (`x-sdk-method`), which is backed by the
 * Amadeus Enterprise APIs Flight Offers Search (GET + POST), Flight Availabilities Search, Branded Fares Upsell and
 * Flight Offers Price. Clients never send Amadeus offers back: they refer to `srch_…`, `off_…`, `prc_…` and `anc_…` ids.
 *
 * Keys, tokens and scope
 * - Publishable key (`pk_…`): every method except {@link FlightsApi.availability}; safe in client components. Customer scope.
 * - Secret key (`sk_…`): every method; server only (server components, route handlers, server actions). Also **customer
 *   scope** on every shopping method, with or without a customer token: selling amounts only (also inside `amadeus`), no
 *   `netPrice` / `markup` / `diagnostics`, ownership checks. Results can be handed to client components without leaking net cost.
 * - Customer token (optional): binds searches / priced offers to the signed-in customer (recent searches); afterwards only
 *   that customer's token (or console scope) can read them.
 * - Console scope (net prices, markup, verbatim Amadeus payloads, diagnostics, read access to every customer's searches,
 *   offers and priced offers): a **staff token**, or a secret key without customer token that opts in with the header
 *   `X-Velexis-Scope: console` (console backends, automation) — pass `{ headers: { "X-Velexis-Scope": "console" } }` per call
 *   or as client `headers`. The header with a publishable key or a customer token → `403 SCOPE_NOT_ALLOWED`; a staff token
 *   may send `X-Velexis-Scope: customer` to preview the shopper view. `availability` is console-only (staff token or secret key).
 *
 * Idempotency: the four POST methods (`search`, `upsell`, `availability`, `price`) create rows and require an
 * `Idempotency-Key`; the SDK generates one per call (override with `RequestOptions.idempotencyKey`) and its automatic
 * retries (503/504/network) replay the stored result instead of running and storing the call twice.
 *
 * Caching: everything here is live, priced or time-limited — the SDK sends `cache: "no-store"` by default.
 * Do not pass `next.revalidate` to these methods.
 */
import type { Schemas, RequestOptions, Page, ListParams, WithWarnings, Money } from "./shared";

declare module "./shared" {
  /**
   * `409 PRICE_CHANGED` thrown by {@link FlightsApi.price} (and by the checkout when it re-prices): the server stored a
   * priced offer at the new price. `pricedOfferId` is `details.pricedOfferId`, typed — continue with it once the
   * customer accepts `newPrice` (e.g. `checkout.create({ pricedOfferId: e.pricedOfferId })`); `undefined` only when the
   * error did not come from a pricing call.
   */
  interface PriceChangedError {
    readonly pricedOfferId: string | undefined;
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Schema aliases                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** A stored flight search (`srch_…`) with facets, highlights and (on creation) the first page of offers. */
export type FlightSearch = Schemas["FlightSearch"];
/** A bookable flight offer (`off_…`) with the tenant's selling price and the wrapped Amadeus offer. */
export type FlightOffer = Schemas["FlightOffer"];
/** Selling price of an offer or priced offer. */
export type SellingPrice = Schemas["SellingPrice"];
/** Facet groups for a filter sidebar. */
export type FlightFacets = Schemas["Facets"];
/** Display dictionaries (airports, cities, airlines, aircraft, currencies). */
export type FlightDictionaries = Schemas["Dictionaries"];
/** Result of a Branded Fares Upsell (`ups_…`): new offers + comparison table. */
export type UpsellResult = Schemas["UpsellResult"];
/** Console availability search result (booking classes and seats per class). */
export type FlightAvailabilitySearchResult = Schemas["FlightAvailabilitySearchResult"];
/** Priced offer (`prc_…`): confirmed price, booking requirements, card fees, ancillaries, conditions, expiry. */
export type PricedOffer = Schemas["PricedOffer"];
/** Normalised ancillary catalogue of a priced offer. */
export type AncillaryCatalogue = Schemas["AncillaryCatalogue"];
/** One purchasable ancillary option (`anc_…`). */
export type AncillaryOption = Schemas["AncillaryOption"];
/** Fare rules of a priced offer (UI shape + raw Amadeus data). */
export type FareRuleSet = Schemas["FareRuleSet"];
/** Booking requirements returned by pricing (contact and per-traveller data the airline needs). */
export type PricingBookingRequirements = Schemas["PricingBookingRequirements"];

/** Cabin (Amadeus travel class). */
export type CabinClass = "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
/** Result ordering. `best` = 60 % price, 30 % duration, 10 % stops. */
export type FlightOfferSort = "best" | "price" | "-price" | "duration" | "departure" | "-departure" | "arrival" | "-arrival";
/** `summary` (default for lists) omits `amadeus`, `travelerPricings` and `price.breakdown`; `full` includes them. */
export type FlightOfferView = "summary" | "full";
/** Amadeus pricing sub-resources (`include`). */
export type PricingInclude = "credit-card-fees" | "bags" | "other-services" | "detailed-fare-rules";
/** Card brands accepted by Amadeus for credit-card fees. */
export type PaymentCardBrand = Schemas["AmadeusPaymentBrand"];
/** Time window of one itinerary: `{itineraryIndex}:{HH:MM}-{HH:MM}`, e.g. `"0:06:00-11:59"`. */
export type ItineraryTimeWindow = `${number}:${string}-${string}`;
/** Lifecycle of a search: `pending` (async search running) → `completed` | `failed`; `completed` → `expired`. */
export type FlightSearchStatus = FlightSearch["status"];
/**
 * Value of the `X-Velexis-Scope` request header of the shopping methods. `customer` (default for keys) = selling amounts
 * only; `console` (default for staff tokens; opt-in for a secret key without customer token) = net prices, markup,
 * verbatim Amadeus payloads, diagnostics, read-any.
 */
export type FlightDataScope = "customer" | "console";

/* ------------------------------------------------------------------------------------------------------------ */
/* Parameters                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/** flights.search in SIMPLE mode — exactly the Amadeus `GET /v2/shopping/flight-offers` parameters (+ `resultOptions`). */
export type FlightSearchSimpleParams = Schemas["FlightSearchSimpleRequest"];
/**
 * flights.search in ADVANCED mode — the full Amadeus `POST /v2/shopping/flight-offers` body in `query` (+ `resultOptions`).
 * `query` is {@link FlightSearchAdvancedQuery}: every Amadeus field, including
 * `searchCriteria.flightFilters.connectionRestriction.nonStopPreferred` / `nonStopPreferredWeight`.
 */
export type FlightSearchAdvancedParams = Schemas["FlightSearchAdvancedRequest"];
/** The Amadeus getFlightOffersQuery accepted in ADVANCED mode (and echoed as `FlightSearch.criteria.amadeusBody`). */
export type FlightSearchAdvancedQuery = Schemas["FlightSearchAdvancedQuery"];
/** `resultOptions` of flights.search: `async` (202 + polling) and the embedded first page (`limit`, `sort`, `view`). */
export type FlightSearchResultOptions = Schemas["FlightSearchResultOptions"];
/** Parameters of {@link FlightsApi.search}: discriminated by `mode`. */
export type FlightSearchParams = FlightSearchSimpleParams | FlightSearchAdvancedParams;

/**
 * Server-side filters of {@link FlightsApi.listResults} (all optional, combined with AND). Array filters are sent
 * comma-separated (`?carriers=AF,KL`, OpenAPI `style: form, explode: false`) like every other list endpoint.
 */
export interface FlightResultFilters {
  /** Max stops of any itinerary: 0 = non-stop, 1, 2 = two or more. Several values are ORed. */
  stops?: Array<0 | 1 | 2>;
  /** Keep offers whose marketing carriers are all in this list (IATA codes). */
  carriers?: string[];
  /** Minimum selling total (all travellers), decimal string in the search currency. */
  minPrice?: string;
  /** Maximum selling total (all travellers), decimal string in the search currency. */
  maxPrice?: string;
  /**
   * Departure windows in local airport time, `{itineraryIndex}:{HH:MM}-{HH:MM}` (max 24). Several windows of the **same**
   * itinerary are ORed, windows of different itineraries are ANDed:
   * `["0:06:00-11:59", "0:18:00-23:59", "1:18:00-23:59"]` = outbound in the morning or evening, return in the evening.
   * Facet time bands map 1:1 (`${band.itineraryIndex}:${band.from}-${band.to}`), so bands can be multi-selected.
   */
  departureWindow?: ItineraryTimeWindow[];
  /** Arrival windows in local airport time; same format and combination rules as `departureWindow`. */
  arrivalWindow?: ItineraryTimeWindow[];
  /** Every itinerary at most this many minutes. */
  maxDurationMinutes?: number;
  /** Main cabin (cabin of the longest segment). */
  cabins?: CabinClass[];
  /** Included checked bags per adult on every segment, at least. */
  minIncludedCheckedBags?: 0 | 1 | 2 | 3;
  /** Only offers known to be refundable (`true`) / non-refundable (`false`); unknown ones are excluded when set. */
  refundable?: boolean;
  /** Only offers known to be changeable (`true`) / not changeable (`false`); unknown ones are excluded when set. */
  changeable?: boolean;
  /** Branded fare codes (from the `brandedFares` facet), e.g. `["LIGHT", "STANDARD"]`. */
  brandedFares?: string[];
}

/** Parameters of {@link FlightsApi.listResults}. */
export interface FlightResultsParams extends ListParams, FlightResultFilters {
  /** Search id (`srch_…`). */
  searchId: string;
  /** Sort order (default `best`). Changing sort or filters requires dropping `cursor`. */
  sort?: FlightOfferSort;
  /** `summary` (default) or `full`. */
  view?: FlightOfferView;
}

/** One page of offers with facets — a {@link Page} with extra fields for the results screen. */
export interface FlightResultsPage extends Page<FlightOffer>, WithWarnings {
  /** The search. */
  searchId: string;
  /** Currency of all prices. */
  currency: string;
  /** Offers matching all filters. */
  total: number;
  /** Applied sort. */
  sort?: FlightOfferSort;
  /** Facets (each group counts offers matching all *other* filters). */
  facets: FlightFacets;
  /** Dictionaries for the codes on this page. */
  dictionaries?: FlightDictionaries;
  /** When the offers expire (ISO-8601 UTC). */
  expiresAt: string;
}

/** Parameters of {@link FlightsApi.getSearch}. */
export interface GetFlightSearchParams {
  /** Search id (`srch_…`). */
  searchId: string;
}

/** Parameters of {@link FlightsApi.getOffer}. */
export interface GetFlightOfferParams {
  /** Offer id (`off_…`). */
  offerId: string;
}

/**
 * Card hint for credit-card fees: `brand` + optional `bin` (first 6 digits, sent to Amadeus as `binNumber`) + optional
 * `offerIds`. Same field names as the checkout's `PaymentCardHint`.
 */
export type OfferPaymentCard = Schemas["OfferPaymentCard"];

/** Parameters of {@link FlightsApi.upsell}. */
export interface FlightUpsellParams {
  /** Offer to upsell (`off_…`). */
  offerId: string;
  /** Other offers of the same search to upsell together (one-way combinations); max 5. */
  combineWithOfferIds?: string[];
  /** Card information so the airline can consider card-dependent fees (Amadeus `payments`). */
  payments?: OfferPaymentCard[];
}

/**
 * Parameters of {@link FlightsApi.availability} (console). `query` is {@link FlightAvailabilityQuery}: exactly the
 * Amadeus Flight Availabilities Search body (sources GDS | LTC | PYTON | EAC; no location subtypes, `fareOptions` or
 * `nonStopPreferred`, which only Flight Offers Search knows).
 */
export type FlightAvailabilityParams = Schemas["FlightAvailabilitySearchRequest"];
/** Amadeus getFlightAvailabilitiesQuery as the Flight Availabilities Search spec defines it. */
export type FlightAvailabilityQuery = Schemas["FlightAvailabilityQuery"];

/**
 * One ancillary to include when pricing: by `optionId` (from getAncillaries) or explicitly by `type`. Seats are chosen
 * by `seatNumber` (no seat map exists in the supplier scope); the airline validates the number when re-pricing.
 */
export type AncillarySelection = Schemas["AncillarySelection"];

/** Options shared by both forms of {@link FlightPriceParams}. */
export interface FlightPriceOptions {
  /** Amadeus `include` sub-resources. Default: bags + other-services (if the storefront sells ancillaries), detailed-fare-rules (if shown), credit-card-fees (if `payments`). */
  include?: PricingInclude[];
  /** Amadeus `forceClass`: price in the offer's booking class instead of the best available. Default false. */
  forceClass?: boolean;
  /** Card brand/BIN per offer for credit-card fees. */
  payments?: OfferPaymentCard[];
  /** Traveller data that influences the fare (discounts, loyalty, dates of birth); ids = `travelerPricings[].travelerId`. */
  travelers?: Schemas["AmadeusTraveler"][];
  /** Ancillaries to include in the price. */
  additionalServices?: AncillarySelection[];
  /** Ask Amadeus for fare rules (`additionalInformation.fareRules`). Default true. */
  fareRules?: boolean;
  /** Total the customer saw; a different confirmed total throws `PriceChangedError` (the priced offer is still stored). */
  expectedTotal?: Money;
}

/** Parameters of {@link FlightsApi.price}: `offerIds` (everyone) or raw `amadeusFlightOffers` (console only). */
export type FlightPriceParams = FlightPriceOptions &
  (
    | { /** 1–6 offers of the same search. */ offerIds: string[]; amadeusFlightOffers?: never }
    | { /** Console only: raw Amadeus offers. */ amadeusFlightOffers: Schemas["AmadeusFlightOffer"][]; offerIds?: never }
  );

/** Parameters of {@link FlightsApi.getPricedOffer}, {@link FlightsApi.getAncillaries} and {@link FlightsApi.getFareRules}. */
export interface PricedOfferParams {
  /** Priced offer id (`prc_…`). */
  pricedOfferId: string;
}

/**
 * `details` of a `409 PRICE_CHANGED` thrown by {@link FlightsApi.price}. Every field is also exposed, typed, on the error
 * itself: `PriceChangedError.oldPrice`, `.newPrice` and `.pricedOfferId` — no cast of `details` needed.
 */
export interface PriceChangedDetails {
  /** `expectedTotal` sent by the client. */
  oldPrice: Money;
  /** Confirmed selling total. */
  newPrice: Money;
  /** The stored priced offer with the new price — load it with getPricedOffer and continue once accepted. */
  pricedOfferId: string;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Namespace                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * `velexis.flights` — flight shopping.
 */
export interface FlightsApi {
  /**
   * Search flights: runs Amadeus Flight Offers Search, stores the search and every offer with the tenant's selling
   * price, and returns the search with the first page of offers, facets, highlights and dictionaries.
   *
   * - HTTP: `POST /v1/flight-searches` → `201` (synchronous, default) or `202` (`resultOptions.async: true`),
   *   both with `Location: /v1/flight-searches/{id}`.
   * - Amadeus: `mode: "simple"` → `GET /v2/shopping/flight-offers` (getFlightOffers, parameters 1:1);
   *   `mode: "advanced"` → `POST /v2/shopping/flight-offers` (searchFlightOffers, full `query` body incl.
   *   `connectionRestriction.nonStopPreferred` / `nonStopPreferredWeight`).
   * - Synchronous (default): resolves after the Amadeus call (typically 2–15 s, up to 60 s → pass `timeoutMs: 60_000`)
   *   with `status: "completed"` and the first page. Asynchronous (`resultOptions: { async: true }`): resolves at once
   *   with `status: "pending"` and `retryAfterSeconds`; poll {@link FlightsApi.getSearch} until `completed` / `failed`,
   *   then page with {@link FlightsApi.listResults}. Use it where function time limits are short (serverless) or for a
   *   progress screen. Validation / permission errors are still thrown by `search` itself.
   * - Keys: publishable or secret key (both customer scope: selling prices only); optional customer token (search saved
   *   to the customer). Staff token, or secret key + `X-Velexis-Scope: console`: console scope (adds `netPrice`,
   *   `markup`, `diagnostics`, verbatim Amadeus offers). Corporate/negotiated fares need console scope unless the storefront enables them.
   * - Where: client components (publishable key) or server components / server actions (secret key).
   * - Next.js caching: never cache (`no-store`, the SDK default). Results expire at `expiresAt` (≈30 min after completion).
   * - Idempotency-Key: required; generated by the SDK per call. Automatic retries replay the stored search (same ids)
   *   instead of storing a second one; a new call is a new search.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400), `UNPROCESSABLE` (422: past dates, infants > adults, > 9 seats)
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `FEATURE_DISABLED` (403)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` / `CONFLICT` (409: key reused with another body / first attempt still running)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504) — synchronous mode
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```ts
   * // app/flights/actions.ts — synchronous search
   * "use server";
   * import { redirect } from "next/navigation";
   * import { velexisServer } from "@/lib/velexis"; // createVelexisClient({ secretKey, accessToken }) — customer scope
   *
   * export async function searchFlights(form: FormData) {
   *   const search = await velexisServer().flights.search({
   *     mode: "simple",
   *     originLocationCode: String(form.get("from")),
   *     destinationLocationCode: String(form.get("to")),
   *     departureDate: String(form.get("depart")),
   *     returnDate: (form.get("return") as string) || undefined,
   *     adults: Number(form.get("adults") ?? 1),
   *     travelClass: "ECONOMY",
   *     resultOptions: { limit: 20, sort: "best" },
   *   }, { timeoutMs: 60_000 });
   *   redirect(`/flights/results/${search.id}`);
   * }
   * ```
   *
   * @example
   * ```ts
   * // Asynchronous search: the server action returns in ~100 ms; the results page polls getSearch.
   * const pending = await velexisServer().flights.search({ mode: "simple", originLocationCode: "PAR",
   *   destinationLocationCode: "NYC", departureDate: "2026-11-20", adults: 1, resultOptions: { async: true } });
   * redirect(`/flights/results/${pending.id}`); // pending.status === "pending"
   *
   * // results page (client component)
   * let s = await velexis.flights.getSearch({ searchId });
   * while (s.status === "pending") {
   *   await new Promise((r) => setTimeout(r, (s.retryAfterSeconds ?? 2) * 1000));
   *   s = await velexis.flights.getSearch({ searchId });
   * }
   * if (s.status === "failed") showError(s.error?.code); else setPage(await velexis.flights.listResults({ searchId }));
   * ```
   */
  search(params: FlightSearchParams, options?: RequestOptions): Promise<FlightSearch>;

  /**
   * Get a stored search (criteria, trip summary, status, result count, highlights, unfiltered facets) — without offers.
   * Also the polling endpoint of asynchronous searches: `status: "pending"` (wait `retryAfterSeconds`, also sent as
   * `Retry-After`) → `"completed"` (page with listResults) or `"failed"` (`error.code`, e.g. `SUPPLIER_TIMEOUT`).
   * After `expiresAt` it still resolves with `status: "expired"` so you can offer "search again" with `criteria.request`.
   *
   * - HTTP: `GET /v1/flight-searches/{searchId}`.
   * - Amadeus: none.
   * - Keys: publishable or secret key (customer scope); customer-bound searches need that customer's token, or console
   *   scope (staff token, or secret key + `X-Velexis-Scope: console`) — a plain secret key gets `404`.
   * - Where: server or client components. Next.js caching: `no-store`.
   *
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404: unknown, purged after 30 days, another customer's search, or an availability search id)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/flights/results/[searchId]/page.tsx (server component)
   * const search = await velexisServer().flights.getSearch({ searchId: params.searchId });
   * if (search.status === "expired") return <ExpiredBanner criteria={search.criteria.request} />;
   * if (search.status === "pending") return <SearchProgress searchId={search.id} retryAfterSeconds={search.retryAfterSeconds ?? 2} />;
   * if (search.status === "failed") return <SearchFailed code={search.error?.code} criteria={search.criteria.request} />;
   * ```
   */
  getSearch(params: GetFlightSearchParams, options?: RequestOptions): Promise<FlightSearch>;

  /**
   * List the offers of a search with server-side filters, sort, cursor pagination and facets (filter sidebar).
   * The returned page has `next()` and is async-iterable.
   *
   * - HTTP: `GET /v1/flight-searches/{searchId}/offers?stops=0,1&carriers=AF,KL&departureWindow=0:06:00-11:59,0:18:00-23:59&sort=price&limit=20`
   *   — array filters are comma-separated (`style: form, explode: false`), like every list endpoint.
   * - Amadeus: none (answered from stored offers).
   * - Keys: publishable or secret key (customer scope: selling prices only; + the customer's token for customer-bound
   *   searches). Console scope (staff token, or secret key + `X-Velexis-Scope: console`) adds `netPrice` / `markup` / verbatim `amadeus`.
   * - Where: ideal in a client component for live filtering (publishable key), or in a server component.
   * - Next.js caching: `no-store`; results disappear at `expiresAt`.
   * - Changing filters/sort invalidates the cursor (start without `cursor`).
   * - Time windows: several windows of one itinerary are ORed, different itineraries ANDed (see {@link FlightResultFilters.departureWindow}).
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400: bad filter, cursor from other filters)
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `SEARCH_NOT_COMPLETED` (409: async search still pending — `details.retryAfterSeconds` — or failed)
   * @throws ExpiredError `SEARCH_EXPIRED` (410) — search again
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * "use client";
   * const page = await velexis.flights.listResults({
   *   searchId, stops: [0, 1], carriers: ["AF", "KL"],
   *   departureWindow: ["0:06:00-11:59", "0:18:00-23:59"], // outbound morning OR evening
   *   maxPrice: "1500", sort: "price", limit: 20,
   * });
   * setOffers(page.data); setFacets(page.facets);
   * const more = await page.next(); // null on the last page
   * ```
   */
  listResults(params: FlightResultsParams, options?: RequestOptions): Promise<FlightResultsPage>;

  /**
   * Get one offer in full view: itineraries, segments (operating carrier, aircraft, stops, CO2), fare details by
   * traveller and segment (cabin, fare basis, branded fare + label, class, included bags, amenities), price breakdown
   * (taxes by code, fees), `lastTicketingDate`, `numberOfBookableSeats`, dictionaries and the wrapped Amadeus offer.
   * The price is the search price — confirm it with {@link FlightsApi.price}.
   *
   * - HTTP: `GET /v1/flight-offers/{offerId}`.
   * - Amadeus: none.
   * - Keys: publishable or secret key — both customer scope (selling amounts in `price` and `amadeus`, no `netPrice` /
   *   `markup`), so the offer can be passed to client components; + customer token for customer-bound searches.
   *   Net prices / markup / verbatim Amadeus offer: staff token, or secret key + `X-Velexis-Scope: console`.
   * - Where: server components (offer page) or client components. Next.js caching: `no-store`.
   *
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ExpiredError `OFFER_EXPIRED` (410) — search again
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/flights/offers/[offerId]/page.tsx — secret key = customer scope, safe to pass to a client component
   * const offer = await velexisServer().flights.getOffer({ offerId: params.offerId });
   * return <OfferDetails offer={offer} dictionaries={offer.dictionaries} />;
   * ```
   *
   * @example
   * ```ts
   * // console backend (secret key, no customer token): opt in to the console view
   * const offer = await consoleClient().flights.getOffer({ offerId }, { headers: { "X-Velexis-Scope": "console" } });
   * offer.netPrice; offer.markup; // present in console scope only
   * ```
   */
  getOffer(params: GetFlightOfferParams, options?: RequestOptions): Promise<FlightOffer>;

  /**
   * Branded Fares Upsell: the airline's alternative fare families on the same flights as new offers (`off_…`,
   * `origin: "upsell"`) plus a side-by-side comparison (price difference, bags, refund/change, amenities
   * included / chargeable / not offered). Empty `offers` when the airline publishes no fare families.
   *
   * - HTTP: `POST /v1/flight-offers/{offerId}/upsells` → `200`.
   * - Amadeus: `POST /v1/shopping/flight-offers/upselling` (upsellAirOffers) with the stored offer(s) and `payments`
   *   (`bin` → Amadeus `binNumber`).
   * - Keys: publishable or secret key (customer scope, + optional customer token); console scope (staff token, or secret
   *   key + `X-Velexis-Scope: console`) adds netPrice / markup. Requires the storefront feature `brandedFareUpsell` in customer scope.
   * - Where: client component (fare-family picker) or server action. Next.js caching: `no-store`.
   * - Idempotency-Key: required, generated by the SDK per call (retries replay the stored result). Independently,
   *   identical requests return the stored result (`cached: true`) during the offer's lifetime.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400), `OFFER_COMBINATION_INVALID` (422)
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `FEATURE_DISABLED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` / `CONFLICT` (409)
   * @throws SoldOutError `SOLD_OUT` (409)
   * @throws ExpiredError `OFFER_EXPIRED` (410)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * "use client";
   * const upsell = await velexis.flights.upsell({ offerId, payments: [{ brand: "VISA", bin: "411111" }] });
   * // upsell.comparison.columns → fare families; upsell.comparison.rows → features
   * ```
   */
  upsell(params: FlightUpsellParams, options?: RequestOptions): Promise<UpsellResult>;

  /**
   * Console: Flight Availabilities Search — schedules with open booking classes and bookable seats per class
   * (closed classes, waitlist status and allotments with `searchCriteria.includeClosedContent`). No prices, not stored
   * as offers; the search is recorded in `flight_searches` (`kind = availability`, returned as `searchId` for audit —
   * not readable through getSearch / listResults).
   *
   * - HTTP: `POST /v1/flight-availabilities` → `200`.
   * - Amadeus: `POST /v1/shopping/availability/flight-availabilities` (searchFlightAvailabilities), `query`
   *   ({@link FlightAvailabilityQuery}, exactly the Amadeus availability body) forwarded as-is. Flight Offers Search-only
   *   fields (location subtypes, `fareOptions`, `NDC`, `nonStopPreferred`) are rejected with `400`.
   * - Keys: **secret key** (console backend) or **staff token** with role owner/admin/agent. Publishable keys and customer
   *   tokens are rejected. Console-only operation: no `X-Velexis-Scope` header needed.
   * - Where: server only (route handler / server action / server component of the console). Next.js caching: `no-store`.
   * - Idempotency-Key: required, generated by the SDK per call (a retry returns the stored result, same `searchId`).
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400), `UNPROCESSABLE` (422)
   * @throws AuthenticationError `UNAUTHENTICATED` / `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `FORBIDDEN` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `FEATURE_DISABLED` (403)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` / `CONFLICT` (409)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```ts
   * // app/console/availability/actions.ts
   * "use server";
   * const result = await consoleClient().flights.availability({
   *   query: {
   *     originDestinations: [{ id: "1", originLocationCode: "CDG", destinationLocationCode: "JFK", departureDateTime: { date: "2026-11-20" } }],
   *     travelers: [{ id: "1", travelerType: "ADULT" }],
   *     sources: ["GDS"],
   *     searchCriteria: { includeClosedContent: true, flightFilters: { carrierRestrictions: { includedCarrierCodes: ["AF"] } } },
   *   },
   * }, { accessToken: staffToken });
   * ```
   */
  availability(params: FlightAvailabilityParams, options?: RequestOptions): Promise<FlightAvailabilitySearchResult>;

  /**
   * Price 1–6 offers: confirmed selling price with taxes and fees, price-change detection, booking requirements,
   * credit-card fees, selected ancillaries, fare conditions and expiry — stored as a priced offer (`prc_…`) to open a checkout from.
   * Re-price with `additionalServices` to include bags / services / seats.
   * With `include` containing `bags` / `other-services` the result embeds `ancillaryCatalogue`; with `detailed-fare-rules`
   * it embeds `fareRules` (otherwise load them later with getAncillaries / getFareRules).
   *
   * - HTTP: `POST /v1/priced-offers` → `201` + `Location: /v1/priced-offers/{id}`.
   * - Amadeus: `POST /v1/shopping/flight-offers/pricing` (quoteAirOffers) with `include`, `forceClass`, `payments`
   *   (`bin` → `binNumber`), `travelers`, `additionalInformation.fareRules` and the selections merged into
   *   `fareDetailsBySegment[].additionalServices`.
   * - Keys: publishable or secret key (customer scope: selling amounts only, safe to return to the browser; + optional
   *   customer token). `amadeusFlightOffers`, `netPrice` and `markup` need console scope (staff token, or secret key +
   *   `X-Velexis-Scope: console`).
   * - Where: server action / route handler (recommended) or client component. Next.js caching: never (`no-store`).
   * - Idempotency-Key: required, generated by the SDK per call — an automatic retry returns the same `prc_…` (or the same
   *   `PRICE_CHANGED`) instead of a second snapshot; every new call creates a new snapshot. Priced offers expire after ≈20 min.
   * - `priceChange.changed` tells whether the price moved; with `expectedTotal` a change throws `PriceChangedError`
   *   with typed `oldPrice`, `newPrice` and `pricedOfferId` (also in `details`, see {@link PriceChangedDetails}).
   * - Seats: `additionalServices[].seatNumber` is typed by the customer (no seat map); unknown / occupied seats throw
   *   `ANCILLARY_NOT_AVAILABLE` with `details.reason` `seat_unknown` / `seat_unavailable`.
   *
   * @throws ValidationError `VALIDATION_FAILED` / `INVALID_REQUEST` (400), `UNPROCESSABLE` / `TRAVELER_DATA_INVALID` / `OFFER_COMBINATION_INVALID` / `ANCILLARY_NOT_AVAILABLE` (422)
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws PriceChangedError `PRICE_CHANGED` (409, only with `expectedTotal`)
   * @throws ConflictError `IDEMPOTENCY_KEY_REUSED` / `CONFLICT` (409)
   * @throws SoldOutError `SOLD_OUT` (409)
   * @throws ExpiredError `OFFER_EXPIRED` (410)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```ts
   * "use server";
   * import { isVelexisError, PriceChangedError } from "@velexis/ota-sdk";
   * try {
   *   const priced = await velexisServer().flights.price({
   *     offerIds: [offerId],
   *     include: ["bags", "other-services", "detailed-fare-rules"],
   *     expectedTotal: shownTotal,
   *   });
   *   redirect(`/checkout/new?pricedOfferId=${priced.id}`);
   * } catch (e) {
   *   if (e instanceof PriceChangedError) return { priceChanged: e.newPrice, pricedOfferId: e.pricedOfferId }; // string | undefined
   *   if (isVelexisError(e, "OFFER_EXPIRED")) redirect("/flights?expired=1");
   *   throw e;
   * }
   * ```
   */
  price(params: FlightPriceParams, options?: RequestOptions): Promise<PricedOffer>;

  /**
   * Get a stored priced offer (e.g. after a reload, or after `PRICE_CHANGED` via `details.pricedOfferId`).
   *
   * - HTTP: `GET /v1/priced-offers/{pricedOfferId}`.
   * - Amadeus: none.
   * - Keys: publishable or secret key, customer scope (+ the customer's token when it was priced by a signed-in
   *   customer; a plain secret key gets `404` for it). Console scope (staff token, or secret key +
   *   `X-Velexis-Scope: console`) adds `netPrice`, `markup` and the verbatim Amadeus exchange.
   * - Where: server or client components. Next.js caching: `no-store`.
   *
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ExpiredError `OFFER_EXPIRED` (410) — price again
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws ServerError `INTERNAL_ERROR` (500)
   *
   * @example
   * ```tsx
   * // app/flights/review/[pricedOfferId]/page.tsx
   * const priced = await velexisServer().flights.getPricedOffer({ pricedOfferId: params.pricedOfferId });
   * ```
   */
  getPricedOffer(params: PricedOfferParams, options?: RequestOptions): Promise<PricedOffer>;

  /**
   * Ancillary catalogue of a priced offer: extra checked / cabin bags, other services (priority boarding, airport
   * check-in, fast track) and chargeable seats where the offer supports them — per traveller and segment, with selling
   * prices and the exact Amadeus `additionalServices` item each option maps to. Buy options by re-pricing:
   * `flights.price({ offerIds, additionalServices: [{ optionId, travelerId }] })`.
   *
   * Seats — known limitation: there is **no seat map** (Amadeus SeatMap Display is not one of the integrated supplier
   * APIs), so no seat list, availability or characteristics. A SEATS option (`requiresSeatNumber: true`, `price: null`)
   * only means the offer sells chargeable seats: collect a seat number (free text, `^[1-9][0-9]{0,2}[A-Z]?$`) and re-price
   * with `{ optionId, travelerId, seatNumber }` (or set it on the checkout). The airline validates it then: an unknown seat
   * throws `ANCILLARY_NOT_AVAILABLE` with `details.reason: "seat_unknown"`, an occupied / blocked one `"seat_unavailable"`
   * (plus `details.seatNumber`, `details.segmentId`); the seat price is known after that re-pricing. A seat-map method
   * (`flights.getSeatMap`) is planned for when SeatMap Display joins the supplier scope.
   *
   * - HTTP: `GET /v1/priced-offers/{pricedOfferId}/ancillaries`.
   * - Amadeus: none when the priced offer included `bags` + `other-services`; otherwise one Flight Offers Price
   *   call (quoteAirOffers, `include=bags,other-services`) whose result is stored.
   * - Keys: publishable or secret key, customer scope (+ customer token if bound). Requires the storefront feature
   *   `ancillaries` in customer scope. Console scope (staff token, or secret key + `X-Velexis-Scope: console`) adds `netPrice`.
   * - Where: server or client components. Next.js caching: `no-store`.
   *
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` / `FEATURE_DISABLED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ExpiredError `OFFER_EXPIRED` (410)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * const catalogue = await velexisServer().flights.getAncillaries({ pricedOfferId });
   * const bagFor = (travelerId: string) => catalogue.checkedBags.filter(o => o.travelerIds.includes(travelerId));
   * ```
   */
  getAncillaries(params: PricedOfferParams, options?: RequestOptions): Promise<AncillaryCatalogue>;

  /**
   * Fare rules of a priced offer: summary (refundable / changeable, max penalties), one entry per rule category
   * (REFUND, EXCHANGE, REVALIDATION, REISSUE, REBOOK, CANCELLATION), detailed fare notes per fare component, and the raw
   * Amadeus `fareRules` + `detailed-fare-rules`.
   *
   * - HTTP: `GET /v1/priced-offers/{pricedOfferId}/fare-rules`.
   * - Amadeus: none when priced with `detailed-fare-rules`; otherwise one Flight Offers Price call
   *   (quoteAirOffers, `include=detailed-fare-rules`, `additionalInformation.fareRules=true`) whose result is stored.
   * - Keys: publishable or secret key, customer scope (+ customer token if bound). Same content in console scope, plus
   *   the supplier details of Amadeus warnings.
   * - Where: server or client components (e.g. a "fare conditions" drawer). Next.js caching: `no-store`.
   *
   * @throws AuthenticationError `INVALID_API_KEY` / `TOKEN_EXPIRED` (401)
   * @throws PermissionError `ORIGIN_NOT_ALLOWED` / `SCOPE_NOT_ALLOWED` / `TENANT_SUSPENDED` (403)
   * @throws NotFoundError `NOT_FOUND` (404)
   * @throws ExpiredError `OFFER_EXPIRED` (410)
   * @throws RateLimitError `RATE_LIMITED` (429)
   * @throws SupplierError `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
   * @throws ServerError `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
   *
   * @example
   * ```tsx
   * const rules = await velexis.flights.getFareRules({ pricedOfferId });
   * rules.summary.refundable === false && <Badge>Non-refundable</Badge>;
   * ```
   */
  getFareRules(params: PricedOfferParams, options?: RequestOptions): Promise<FareRuleSet>;
}
