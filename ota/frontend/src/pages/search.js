// Entry module of the results page (search.html, ota/frontend/docs/pages.md §4, flow ota/docs/flows/search-and-price.md,
// SDK guide B2 §2–§3). The page arrives with the search form's query string (`/search.html?trip=return&from=PAR&…`,
// src/components/search-form.js) and, once searched, the search id (`&search=srch_…`):
//
// 1. Without a search id: `flights.search` (`mode: "simple"`, or `"advanced"` with the Amadeus body for multi-city;
//    60 s timeout; `resultOptions.limit: 0`, the first page comes from step 2), then `history.replaceState` adds
//    `search=srch_…`, so reload and Back never search again. With one: `flights.getSearch` rebuilds the summary bar
//    (and tells an expired or failed search), while step 2 runs alongside.
// 2. `flights.listResults({ searchId, sort, ...filters, limit: 20 })` for the first page and after every filter or sort
//    change (the cursor dropped, the previous call aborted); "Show more flights" calls `page.next()`.
// 3. Filters and sort live in the query string (src/components/filters.js, sort.js), so a filtered view survives a
//    reload within the search's lifetime. Airline names for the filters come from `reference.airlines.list`.
//
// States (pages.md §4): searching (summary, skeleton cards, "Searching airlines…" in the live region); no offers ("No
// flights found", the search form opened and pre-filled, nearby dates and airports as links); filters that exclude
// everything ("No flights match these filters" with "Clear filters"); `410 SEARCH_EXPIRED` ("Prices have expired",
// Refresh runs the same search again); `504 SUPPLIER_TIMEOUT` / `503 SUPPLIER_UNAVAILABLE` ("Airlines are not
// answering right now", Retry); `400 VALIDATION_FAILED` (back to the form with field errors); the shared states of
// lib/errors.js for everything else. Prices are the API's totals only (src/components/offer-card.js).

import { CURRENCY_CHANGE_EVENT, boot, renderState } from "../boot.js";
import { todayIso } from "../components/date-range.js";
import { filtersToQuery, hasFilters, mount as mountFilters, readFilters } from "../components/filters.js";
import { airlineLabel } from "../components/itinerary.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { mount as mountLoadMore } from "../components/load-more.js";
import { renderOfferCard, renderSkeletons } from "../components/offer-card.js";
import { passengerSummary } from "../components/passenger-picker.js";
import {
  MIN_LEGS,
  formatLegs,
  mount as mountSearchForm,
  readSearchQuery,
} from "../components/search-form.js";
import { mount as mountSort, readSort, sortParam } from "../components/sort.js";
import { clone, fill } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatLocalDate } from "../lib/format.js";
import { clearFieldErrors, showFieldErrors } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import { replaceQuery, toQuery, withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").FlightSearch} FlightSearch */
/** @typedef {import("@velexis/ota-sdk").FlightSearchParams} FlightSearchParams */
/** @typedef {import("@velexis/ota-sdk").FlightResultsPage} FlightResultsPage */
/** @typedef {import("@velexis/ota-sdk").FlightResultFilters} FlightResultFilters */
/** @typedef {import("@velexis/ota-sdk").FlightOffer} FlightOffer */
/** @typedef {import("@velexis/ota-sdk").FlightDictionaries} FlightDictionaries */
/** @typedef {import("@velexis/ota-sdk").Schemas["FlightSearchSummary"]} TripSummary */
/** @typedef {import("@velexis/ota-sdk").Schemas["Facets"]} Facets */
/** @typedef {import("../components/search-form.js").SearchQuery} SearchQuery */
/** @typedef {import("../components/sort.js").ResultSort} ResultSort */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {Pick<VelexisClient, "flights" | "reference">} PageClient */
/** @typedef {{ label: string, href: string }} Suggestion */

/** Offers per page (README §9). */
export const RESULTS_LIMIT = 20;
/** How long `flights.search` may take (Amadeus can take seconds, B2 §1). */
export const SEARCH_TIMEOUT_MS = 60_000;
/** A search id as the API writes it. */
export const SEARCH_ID = /^srch_[0-9A-Za-z]{16,40}$/;
/** The Amadeus content source of the storefront's multi-city searches (the API intersects it with the OTA's). */
const ADVANCED_SOURCES = ["GDS"];
/** `reference.airlines.list` resolves at most this many codes per call. */
const MAX_AIRLINE_CODES = 100;
const AIRLINE_CODE = /^[A-Z0-9]{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** States after which the same call cannot do better: no Retry. */
const FINAL_STATES = new Set([
  "suspended",
  "unknown-host",
  "supplier-not-configured",
  "feature-disabled",
  "forbidden",
  "not-found",
  "signed-out",
]);
/** The state of a search that failed at the supplier (`FlightSearch.error.code`). */
const FAILED_SEARCH_STATES = /** @type {Record<string, "supplier-timeout" | "supplier-unavailable">} */ ({
  SUPPLIER_TIMEOUT: "supplier-timeout",
  SUPPLIER_UNAVAILABLE: "supplier-unavailable",
});

/**
 * Reports an error of the page (the browser's console and `error` event) without breaking it.
 * @param {unknown} error
 */
function report(error) {
  try {
    globalThis.reportError?.(error);
  } catch {
    // Nothing else to do.
  }
}

/**
 * The trip of a search query in the shape of `FlightSearch.summary`, or `null` when the query does not describe a
 * search (no route or date, fewer than two multi-city flights). A return trip without a return date is one way.
 * @param {SearchQuery} query from `readSearchQuery`
 * @returns {TripSummary | null}
 */
export function summaryFromQuery(query) {
  const travelers = {
    adults: query.adults,
    children: query.children,
    infants: query.infants,
    total: query.adults + query.children + query.infants,
  };
  if (query.trip === "multi") {
    if (query.legs.length < MIN_LEGS) {
      return null;
    }
    return {
      tripType: "multi_city",
      legs: query.legs.map((leg, index) => ({
        originDestinationId: String(index + 1),
        originCode: leg.from,
        destinationCode: leg.to,
        departureDate: leg.date,
      })),
      travelers,
      travelClass: query.cabin,
    };
  }
  if (!query.from || !query.to || !query.depart) {
    return null;
  }
  const legs = [
    {
      originDestinationId: "1",
      originCode: query.from,
      destinationCode: query.to,
      departureDate: query.depart,
    },
  ];
  if (query.trip === "return" && query.return) {
    legs.push({
      originDestinationId: "2",
      originCode: query.to,
      destinationCode: query.from,
      departureDate: query.return,
    });
  }
  return { tripType: legs.length > 1 ? "round_trip" : "one_way", legs, travelers, travelClass: query.cabin };
}

/**
 * The `flights.search` parameters of a trip (without `resultOptions`): SIMPLE mode for one-way and return trips,
 * ADVANCED mode with the Amadeus body for multi-city (one traveller entry per person, each infant on an adult's lap,
 * the cabin for most segments of every flight).
 * @param {TripSummary} summary
 * @returns {FlightSearchParams}
 */
export function searchRequestFor(summary) {
  const { adults, children, infants } = summary.travelers;
  const cabin = summary.travelClass ?? null;
  if (summary.tripType === "multi_city") {
    const ids = summary.legs.map((_leg, index) => String(index + 1));
    /** @type {Array<{ id: string, travelerType: "ADULT" | "CHILD" | "HELD_INFANT", associatedAdultId?: string }>} */
    const travelers = [];
    for (let index = 0; index < adults; index += 1) {
      travelers.push({ id: String(travelers.length + 1), travelerType: "ADULT" });
    }
    for (let index = 0; index < children; index += 1) {
      travelers.push({ id: String(travelers.length + 1), travelerType: "CHILD" });
    }
    for (let index = 0; index < infants; index += 1) {
      travelers.push({
        id: String(travelers.length + 1),
        travelerType: "HELD_INFANT",
        associatedAdultId: String(index + 1),
      });
    }
    return /** @type {FlightSearchParams} */ ({
      mode: "advanced",
      query: {
        originDestinations: summary.legs.map((leg, index) => ({
          id: ids[index],
          originLocationCode: leg.originCode,
          destinationLocationCode: leg.destinationCode,
          departureDateTimeRange: { date: leg.departureDate },
        })),
        travelers,
        sources: [...ADVANCED_SOURCES],
        ...(cabin
          ? {
              searchCriteria: {
                flightFilters: {
                  cabinRestrictions: [{ cabin, coverage: "MOST_SEGMENTS", originDestinationIds: ids }],
                },
              },
            }
          : {}),
      },
    });
  }
  const [outbound, inbound] = summary.legs;
  const first = /** @type {TripSummary["legs"][number]} */ (outbound);
  return /** @type {FlightSearchParams} */ ({
    mode: "simple",
    originLocationCode: first.originCode,
    destinationLocationCode: first.destinationCode,
    departureDate: first.departureDate,
    ...(summary.tripType === "round_trip" && inbound ? { returnDate: inbound.departureDate } : {}),
    adults,
    children,
    infants,
    ...(cabin ? { travelClass: cabin } : {}),
  });
}

/**
 * The query of the search form for a trip, in the form's own order (pages.md §3), for links and the form.
 * @param {TripSummary} summary
 * @returns {Array<[string, string | number | null]>}
 */
export function searchQueryFor(summary) {
  const { adults, children, infants } = summary.travelers;
  const people = /** @type {Array<[string, string | number | null]>} */ ([
    ["adults", adults],
    ["children", children],
    ["infants", infants],
    ["cabin", summary.travelClass ?? null],
  ]);
  if (summary.tripType === "multi_city") {
    const legs = summary.legs.map((leg) => ({
      from: leg.originCode,
      to: leg.destinationCode,
      date: leg.departureDate,
    }));
    return [["trip", "multi"], ["legs", formatLegs(legs)], ...people];
  }
  const [outbound, inbound] = summary.legs;
  return [
    ["trip", summary.tripType === "round_trip" ? "return" : "oneway"],
    ["from", outbound?.originCode ?? null],
    ["to", outbound?.destinationCode ?? null],
    ["depart", outbound?.departureDate ?? null],
    ["return", summary.tripType === "round_trip" ? (inbound?.departureDate ?? null) : null],
    ...people,
  ];
}

/**
 * A link that starts a new search for a trip.
 * @param {TripSummary} summary
 */
export const searchHref = (summary) => withQuery("/search.html", searchQueryFor(summary));

/**
 * A `YYYY-MM-DD` date moved by whole days, or `null` for an unreadable date.
 * @param {string} date
 * @param {number} days
 */
export function shiftDate(date, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return null;
  }
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * MS_PER_DAY;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The dates of a trip as text: "Fri 20 Nov – Fri 27 Nov" for a return trip, the dates of every flight otherwise.
 * @param {TripSummary} summary
 * @param {string | undefined} locale
 */
function datesText(summary, locale) {
  const dates = summary.legs.map((leg) => formatLocalDate(leg.departureDate, locale));
  return summary.tripType === "round_trip" && dates.length === 2
    ? t("results.dates", { depart: dates[0], return: dates[1] })
    : dates.join(", ");
}

/**
 * The same trip one day earlier and one day later (never before today), as links to new searches.
 * @param {TripSummary} summary
 * @param {string} today `YYYY-MM-DD`
 * @param {string | undefined} locale
 * @returns {Suggestion[]}
 */
export function nearbyDates(summary, today, locale) {
  return [-1, 1].flatMap((days) => {
    const legs = summary.legs.map((leg) => ({ ...leg, departureDate: shiftDate(leg.departureDate, days) }));
    if (legs.some((leg) => leg.departureDate === null || leg.departureDate < today)) {
      return [];
    }
    const moved = { ...summary, legs: /** @type {TripSummary["legs"]} */ (legs) };
    return [
      {
        label: t(days < 0 ? "results.earlier" : "results.later", { dates: datesText(moved, locale) }),
        href: searchHref(moved),
      },
    ];
  });
}

/**
 * The summary line of a trip: route, dates, travellers and cabin.
 * @param {TripSummary} summary
 * @param {{ locale: string | undefined, place: (code: string) => string }} context
 */
export function summaryText(summary, { locale, place }) {
  /** @type {string[]} */
  const parts = [];
  if (summary.tripType === "multi_city") {
    parts.push(
      summary.legs
        .map((leg) =>
          t("results.leg", {
            route: t("results.route", { from: place(leg.originCode), to: place(leg.destinationCode) }),
            date: formatLocalDate(leg.departureDate, locale),
          }),
        )
        .join(t("results.legSeparator")),
    );
  } else {
    const [outbound] = summary.legs;
    if (outbound) {
      parts.push(
        t("results.route", { from: place(outbound.originCode), to: place(outbound.destinationCode) }),
      );
    }
    parts.push(datesText(summary, locale));
  }
  parts.push(passengerSummary(summary.travelers));
  if (summary.travelClass) {
    parts.push(t(`cabin.${summary.travelClass}`));
  }
  return parts.filter((part) => part !== "").join(t("results.separator"));
}

/**
 * The page heading of a trip.
 * @param {TripSummary | null} summary
 * @param {(code: string) => string} place
 */
export function titleText(summary, place) {
  const [outbound] = summary?.legs ?? [];
  if (!summary || !outbound) {
    return t("results.titleNone");
  }
  return summary.tripType === "multi_city"
    ? t("results.titleMulti")
    : t("results.title", { from: place(outbound.originCode), to: place(outbound.destinationCode) });
}

/**
 * A trip with the origin or the destination of its first flight (and the matching end of a return) replaced.
 * @param {TripSummary} summary
 * @param {"originCode" | "destinationCode"} end
 * @param {string} code
 * @returns {TripSummary}
 */
function withEnd(summary, end, code) {
  const other = end === "originCode" ? "destinationCode" : "originCode";
  const legs = summary.legs.map((leg, index) =>
    index === 0 ? { ...leg, [end]: code } : index === 1 ? { ...leg, [other]: code } : leg,
  );
  return { ...summary, legs: /** @type {TripSummary["legs"]} */ (legs) };
}

/**
 * Runs the results page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page
 * has no results area, else `{ done, destroy }`: `done` settles once the first results (or a state) are shown.
 * @param {{ config: StorefrontConfig, client: PageClient }} context
 * @param {{ doc?: Document, location?: Location, history?: History, today?: string }} [env] for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-results-page]"));
  if (!main) {
    return null;
  }
  const location = env.location ?? doc.defaultView?.location ?? globalThis.location;
  const history = env.history ?? doc.defaultView?.history ?? globalThis.history;
  const today = env.today ?? todayIso();
  const { config } = context;
  const locale = config?.defaultLocale;
  const support = config?.support ?? null;
  let client = context.client;
  const live = mountLiveRegion(doc.body);

  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (main.querySelector(selector));
  const el = {
    title: find("[data-results-title]"),
    summary: find("[data-search-summary]"),
    panel: /** @type {HTMLDetailsElement | null} */ (main.querySelector("details[data-search-panel]")),
    form: /** @type {HTMLFormElement | null} */ (main.querySelector("form[data-search-form]")),
    state: find("[data-results-state]"),
    layout: find("[data-results-layout]"),
    filters: /** @type {HTMLFormElement | null} */ (main.querySelector("form[data-filters]")),
    count: find("[data-results-count]"),
    sort: /** @type {HTMLSelectElement | null} */ (main.querySelector("select[data-sort]")),
    message: find("[data-results-message]"),
    list: find("[data-offers]"),
    loadMore: /** @type {HTMLElement | null} */ (main.querySelector("[data-load-more]")),
  };

  const params = new URLSearchParams(location.search);
  const idParam = params.get("search");
  /** @type {string | null} */
  let searchId = idParam !== null && SEARCH_ID.test(idParam) ? idParam : null;
  /** @type {TripSummary | null} */
  let summary = summaryFromQuery(readSearchQuery(params));
  /** @type {FlightSearchParams | null} */
  let request = summary ? searchRequestFor(summary) : null;
  /** @type {FlightResultFilters} */
  let filters = readFilters(params);
  /** @type {ResultSort} */
  let sort = readSort(params);
  /** Display names by code, from the dictionaries and reference.airlines.list. */
  const places = new Map();
  /** @type {Map<string, string>} */
  const airlines = new Map();
  /** Airline codes already asked of reference.airlines.list. */
  const listedAirlines = new Set();
  /** @type {FlightResultsPage | null} */
  let page = null;
  let shown = 0;
  /** How many offers the search stored (`resultCount`), once known: 0 means "no flights", whatever the filters. */
  /** @type {number | null} */
  let stored = null;
  /** The running listResults call (aborted when filters or sort change). @type {AbortController | null} */
  let controller = null;
  let destroyed = false;
  /** @type {{ destroy: () => void } | null} */
  let formView = null;

  /** @param {string} code */
  const place = (code) => {
    const name = places.get(code);
    return name ? t("results.place", { name, code }) : code;
  };
  /** @param {string} code */
  const airline = (code) => airlineLabel(code, airlines.get(code));
  /** @param {string} code */
  const carrierName = (code) => airlines.get(code) ?? null;

  /** Learns place and airline names from dictionaries (reference.airlines.list names win). */
  const learn = (/** @type {FlightDictionaries | null | undefined} */ dictionaries) => {
    for (const [code, location] of Object.entries(dictionaries?.locations ?? {})) {
      const name = location?.airportName ?? location?.cityName;
      if (typeof name === "string" && name !== "" && !places.has(code)) {
        places.set(code, name);
      }
    }
    for (const [code, carrier] of Object.entries(dictionaries?.carriers ?? {})) {
      if (typeof carrier?.name === "string" && carrier.name !== "" && !airlines.has(code)) {
        airlines.set(code, carrier.name);
      }
    }
  };

  const renderSummary = () => {
    const title = titleText(summary, place);
    el.title.textContent = title;
    doc.title = title;
    el.summary.textContent = summary ? summaryText(summary, { locale, place }) : t("results.chooseSearch");
  };

  /** Mounts the search form once, pre-filled with the trip (the panel is closed until it is needed). */
  const ensureForm = () => {
    if (formView || !el.form) {
      return;
    }
    try {
      formView = mountSearchForm(el.form, {
        client: /** @type {import("../components/location-combobox.js").ReferenceClient} */ (client),
        params: summary ? new URLSearchParams(toQuery(searchQueryFor(summary))) : params,
        announce: live.announce,
        today,
      });
    } catch (error) {
      report(error);
    }
  };
  const openForm = () => {
    if (el.panel) {
      el.panel.open = true;
    }
    ensureForm();
  };
  const onToggle = () => {
    if (el.panel?.open) {
      ensureForm();
    }
  };
  el.panel?.addEventListener("toggle", onToggle);

  const mirror = () =>
    replaceQuery({ ...filtersToQuery(filters), sort: sortParam(sort) }, { location, history });

  /** Asks reference.airlines.list once for the names of airline codes not asked yet (failures keep the codes). */
  const listAirlines = (
    /** @type {Facets | null | undefined} */ facets,
    offers = /** @type {FlightOffer[]} */ ([]),
  ) => {
    const codes = [
      ...new Set([
        ...(facets?.carriers ?? []).map((bucket) => bucket.value),
        ...offers.flatMap((offer) => offer.summary.marketingCarriers ?? []),
      ]),
    ]
      .filter((code) => AIRLINE_CODE.test(code) && !listedAirlines.has(code))
      .slice(0, MAX_AIRLINE_CODES);
    if (codes.length === 0 || typeof client.reference?.airlines?.list !== "function") {
      return;
    }
    for (const code of codes) {
      listedAirlines.add(code);
    }
    client.reference.airlines.list({ iataCodes: codes, limit: MAX_AIRLINE_CODES }).then(
      (answer) => {
        if (destroyed) {
          return;
        }
        for (const entry of answer?.data ?? []) {
          if (typeof entry?.iataCode === "string" && typeof entry.name === "string" && entry.name !== "") {
            airlines.set(entry.iataCode, entry.name);
          }
        }
        filtersView?.update({ carrierName });
      },
      () => {
        // The names stay those of the dictionaries, or the codes.
      },
    );
  };

  const clearStates = () => {
    el.state.replaceChildren();
    el.message.replaceChildren();
  };
  /** @param {boolean} visible */
  const showLayout = (visible) => {
    el.layout.hidden = !visible;
  };

  /** @param {"results.searching" | "results.loading"} key */
  const showSearching = (key) => {
    clearStates();
    showLayout(true);
    el.list.replaceChildren(...renderSkeletons(doc));
    el.list.setAttribute("aria-busy", "true");
    el.count.textContent = t(key);
    loadMoreView?.update({ shown: 0, total: 0, hasMore: false });
    live.announce(t(key));
  };

  /**
   * Shows a page state in place of the results.
   * @param {Pick<PageState, "name" | "message" | "scope"> & Partial<PageState>} state
   * @param {{ onRetry?: () => void, retryLabel?: string, requestId?: string | null, focus?: boolean }} [options]
   */
  const showState = (state, { onRetry, retryLabel, requestId = null, focus = false } = {}) => {
    // The focus follows the traveller into the state when the part of the page they were using goes away.
    const active = doc.activeElement;
    const moveFocus = focus || (active !== null && (el.layout.contains(active) || el.state.contains(active)));
    clearStates();
    showLayout(false);
    el.list.replaceChildren();
    el.list.setAttribute("aria-busy", "false");
    const element = renderState(el.state, state, {
      support,
      requestId,
      focus: moveFocus,
      ...(onRetry ? { onRetry } : {}),
    });
    const button = element.querySelector('[data-action="retry"]');
    if (button && retryLabel) {
      button.textContent = retryLabel;
    }
    live.announce(state.message);
  };

  /** "Prices have expired", with Refresh running the same search again (when the page knows it). */
  const showExpired = () => {
    showState(
      { name: "search-expired", scope: "inline", message: t("state.search-expired") },
      request
        ? {
            onRetry: () =>
              runSearch(/** @type {FlightSearchParams} */ (request), { focus: true }).catch(report),
            retryLabel: t("results.refresh"),
          }
        : {},
    );
    if (!request) {
      openForm();
    }
  };

  /** Back to the form with the API's field errors (`/query/…` pointers of an advanced search lose the prefix). */
  const showValidation = (/** @type {PageState} */ state) => {
    clearStates();
    showLayout(false);
    openForm();
    const errors = state.fieldErrors.map((error) => ({
      ...error,
      path: String(error.path ?? "").replace(/^\/query(?=\/)/, ""),
    }));
    if (el.form && errors.length > 0) {
      clearFieldErrors(el.form);
      showFieldErrors(el.form, errors);
    } else {
      renderState(el.state, state);
    }
    live.announce(state.message);
  };

  /**
   * The state of a failed search call: back to the form for a validation error, else the state with Retry.
   * @param {unknown} error
   * @param {() => void} retry
   * @param {boolean} focus
   */
  const failSearch = (error, retry, focus) => {
    if (isAborted(error)) {
      return;
    }
    const state = pageStateFor(error);
    if (state.name === "validation") {
      showValidation(state);
      return;
    }
    if (state.name === "search-expired") {
      showExpired();
      return;
    }
    const requestId =
      state.name === "unexpected" && error instanceof Error && "requestId" in error
        ? String(/** @type {{ requestId: unknown }} */ (error).requestId ?? "") || null
        : null;
    showState(state, { ...(FINAL_STATES.has(state.name) ? {} : { onRetry: retry }), requestId, focus });
  };

  /** "No flights found": the form opened, nearby dates and airports as new searches. */
  const showNoOffers = () => {
    clearStates();
    showLayout(false);
    const section = fill(clone("tpl-no-offers", doc), {
      title: t("results.noOffers"),
      hint: t("results.noOffersHint"),
    });
    el.state.replaceChildren(section);
    const list = section.querySelector("[data-suggestions]");
    /** @param {Suggestion} suggestion */
    const add = (suggestion) => list?.append(fill(clone("tpl-suggestion", doc), { ...suggestion }));
    const trip = summary;
    if (trip) {
      nearbyDates(trip, today, locale).forEach(add);
      nearbyAirports(trip).then((suggestions) => {
        if (section.isConnected) {
          suggestions.forEach(add);
        }
      }, report);
    }
    openForm();
    live.announce(t("results.noOffers"));
  };

  /**
   * "From any airport in London (LON)": for an airport of a city with several, the same search from or to the city.
   * One reference.locations.search per end; a failure gives no suggestion.
   * @param {TripSummary} trip
   * @returns {Promise<Suggestion[]>}
   */
  const nearbyAirports = async (trip) => {
    const [outbound] = trip.legs;
    if (
      trip.tripType === "multi_city" ||
      !outbound ||
      typeof client.reference?.locations?.search !== "function"
    ) {
      return [];
    }
    const ends = /** @type {const} */ ([
      ["originCode", "results.fromCity"],
      ["destinationCode", "results.toCity"],
    ]);
    const found = await Promise.all(
      ends.map(async ([end, key]) => {
        const code = outbound[end];
        try {
          const answer = await client.reference.locations.search({
            keyword: code,
            subType: ["AIRPORT", "CITY"],
            limit: 8,
          });
          const match = (answer?.data ?? []).find(
            (location) => location.iataCode === code && location.subType === "AIRPORT",
          );
          const city = match?.cityCode;
          if (typeof city !== "string" || !/^[A-Z]{3}$/.test(city) || city === code) {
            return null;
          }
          const name = match?.cityName;
          const label =
            typeof name === "string" && name !== "" ? t("results.place", { name, code: city }) : city;
          return { label: t(key, { place: label }), href: searchHref(withEnd(trip, end, city)) };
        } catch {
          return null;
        }
      }),
    );
    return found.filter((suggestion) => suggestion !== null);
  };

  /** "No flights match these filters" with "Clear filters"; the filters stay visible. */
  const showNoMatch = () => {
    el.message.replaceChildren();
    const box = fill(clone("tpl-no-match", doc), {
      title: t("results.noMatch"),
      hint: t("results.noMatchHint"),
      clear: t("results.clearFilters"),
    });
    box.querySelector('[data-action="clear-filters"]')?.addEventListener("click", () => {
      filtersView?.clear();
      el.count.focus();
    });
    el.message.append(box);
    live.announce(t("results.noMatch"));
  };

  /** @param {FlightOffer} offer */
  const card = (offer) =>
    renderOfferCard(offer, {
      doc,
      locale,
      tripType: summary?.tripType ?? offer.summary.tripType,
      airline,
      place,
      travellers: summary?.travelers?.total ?? null,
    });

  /**
   * Shows a first page of results (replacing the list).
   * @param {FlightResultsPage} result
   * @param {boolean} focus moves the focus to the results heading (after a Retry)
   */
  const renderResults = (result, focus) => {
    page = result;
    clearStates();
    showLayout(true);
    learn(result.dictionaries);
    renderSummary();
    el.list.replaceChildren(...result.data.map(card));
    el.list.setAttribute("aria-busy", "false");
    shown = result.data.length;
    el.count.textContent = t("results.count", { count: result.total });
    filtersView?.update({
      facets: result.facets,
      filters,
      carrierName,
      tripType: summary?.tripType ?? "one_way",
    });
    sortView?.update({ sort });
    loadMoreView?.update({ shown, total: result.total, hasMore: result.page.nextCursor !== null });
    listAirlines(result.facets, result.data);
    if (focus) {
      el.count.focus();
    }
    if (result.total === 0 || result.data.length === 0) {
      if (hasFilters(filters) && stored !== 0) {
        showNoMatch();
      } else {
        showNoOffers();
      }
      return;
    }
    live.announce(el.count.textContent);
  };

  /** A new listResults call; the previous one is aborted. */
  const newController = () => {
    controller?.abort();
    controller = new AbortController();
    return controller;
  };
  /** @param {AbortController} own */
  const listCall = (own) =>
    client.flights.listResults(
      { searchId: /** @type {string} */ (searchId), sort, ...filters, limit: RESULTS_LIMIT },
      { signal: own.signal },
    );

  /**
   * The state of a failed results call. An expired or vanished search offers Refresh; filters the API refuses (an
   * old or edited address) are dropped once.
   * @param {unknown} error
   * @param {boolean} retried
   */
  const failResults = (error, retried) => {
    const state = pageStateFor(error);
    if (state.name === "search-expired" || state.name === "not-found") {
      showExpired();
      return;
    }
    if (state.name === "validation" && hasFilters(filters) && !retried) {
      filters = {};
      filtersView?.update({ filters });
      mirror();
      loadResults({ retried: true }).catch(report);
      return;
    }
    failSearch(error, () => loadResults({ focus: true }).catch(report), false);
  };

  /**
   * Loads the first page for the current filters and sort (or awaits one already started).
   * @param {{ started?: Promise<FlightResultsPage>, own?: AbortController, focus?: boolean, retried?: boolean }} [options]
   */
  const loadResults = async ({ started, own, focus = false, retried = false } = {}) => {
    const mine = own ?? newController();
    el.list.setAttribute("aria-busy", "true");
    /** @type {FlightResultsPage} */
    let result;
    try {
      result = await (started ?? listCall(mine));
    } catch (error) {
      if (mine === controller && !destroyed && !isAborted(error)) {
        failResults(error, retried);
      }
      return;
    }
    if (mine === controller && !destroyed) {
      renderResults(result, focus);
    }
  };

  /** "Show more flights": the next page, appended; the focus moves to its first card. */
  const loadMore = async () => {
    const current = page;
    const mine = controller;
    if (!current || current.page.nextCursor === null) {
      return;
    }
    /** @type {FlightResultsPage | null} */
    let next;
    try {
      next = /** @type {FlightResultsPage | null} */ (await current.next());
    } catch (error) {
      if (mine === controller && !destroyed && !isAborted(error)) {
        failResults(error, true);
      }
      return;
    }
    if (!next || page !== current || mine !== controller || destroyed) {
      return;
    }
    page = next;
    learn(next.dictionaries);
    const cards = next.data.map(card);
    el.list.append(...cards);
    shown += cards.length;
    const total = typeof next.total === "number" ? next.total : current.total;
    loadMoreView?.update({ shown, total, hasMore: next.page.nextCursor !== null });
    listAirlines(null, next.data);
    /** @type {HTMLElement | null} */ (cards[0]?.querySelector("article") ?? null)?.focus();
    live.announce(t("results.showing", { shown, total }));
  };

  /** Adopts a search (created or read): its trip, request, names and airlines. */
  const adopt = (/** @type {FlightSearch} */ search) => {
    summary = search.summary ?? summary;
    request = /** @type {FlightSearchParams | null} */ (search.criteria?.request ?? request);
    stored = typeof search.resultCount === "number" ? search.resultCount : null;
    learn(search.dictionaries);
    renderSummary();
    listAirlines(search.facets);
  };

  /**
   * Runs a new search, puts its id into the address and loads the first page.
   * @param {FlightSearchParams} searchRequest
   * @param {{ focus?: boolean }} [options]
   */
  const runSearch = async (searchRequest, { focus = false } = {}) => {
    request = searchRequest;
    // Until the new search answers there is no search to list (a sort change waits for it).
    searchId = null;
    controller?.abort();
    controller = null;
    showSearching("results.searching");
    /** @type {FlightSearch} */
    let search;
    try {
      search = await client.flights.search(
        /** @type {FlightSearchParams} */ ({ ...searchRequest, resultOptions: { limit: 0 } }),
        { timeoutMs: SEARCH_TIMEOUT_MS },
      );
    } catch (error) {
      if (!destroyed) {
        failSearch(error, () => runSearch(searchRequest, { focus: true }).catch(report), focus);
      }
      return;
    }
    if (destroyed) {
      return;
    }
    searchId = search.id;
    replaceQuery({ search: search.id }, { location, history });
    adopt(search);
    await loadResults({ focus });
  };

  /**
   * Opens a stored search: `getSearch` for the summary while the first page loads alongside.
   * @param {string} id
   * @param {{ focus?: boolean }} [options]
   */
  const openSearch = async (id, { focus = false } = {}) => {
    showSearching("results.loading");
    const own = newController();
    const firstPage = listCall(own);
    // Settled below, or abandoned when the search turns out expired, failed or unknown.
    firstPage.catch(() => {});
    /** @type {FlightSearch} */
    let search;
    try {
      search = await client.flights.getSearch({ searchId: id });
    } catch (error) {
      own.abort();
      if (destroyed || isAborted(error)) {
        return;
      }
      if (pageStateFor(error).name === "not-found") {
        // Purged after it expired: the address still holds the search to run again.
        showExpired();
        return;
      }
      failSearch(error, () => openSearch(id, { focus: true }).catch(report), focus);
      return;
    }
    if (destroyed) {
      return;
    }
    adopt(search);
    if (search.status === "expired") {
      own.abort();
      showExpired();
      return;
    }
    if (search.status === "failed") {
      own.abort();
      const name = FAILED_SEARCH_STATES[String(search.error?.code)] ?? "supplier-error";
      showState(
        { name, scope: "inline", message: t(`state.${name}`) },
        request
          ? {
              onRetry: () =>
                runSearch(/** @type {FlightSearchParams} */ (request), { focus: true }).catch(report),
            }
          : {},
      );
      return;
    }
    await loadResults({ started: firstPage, own, focus });
  };

  /** After a filter or sort change: the first page again, unless a search is still running (it loads it). */
  const reload = () => {
    mirror();
    if (searchId !== null) {
      loadResults().catch(report);
    }
  };
  const filtersView = el.filters
    ? mountFilters(el.filters, {
        ...(locale ? { locale } : {}),
        onChange(next) {
          filters = next;
          reload();
        },
      })
    : null;
  filtersView?.update({ filters, carrierName, tripType: summary?.tripType ?? "one_way" });
  const sortView = el.sort
    ? mountSort(el.sort, {
        sort,
        onChange(next) {
          sort = next;
          reload();
        },
      })
    : null;
  const loadMoreView = el.loadMore ? mountLoadMore(el.loadMore, { onLoad: loadMore }) : null;

  /** A new currency applies to the next search (README §7): Refresh, Retry and new searches use it. */
  const onCurrencyChange = (/** @type {Event} */ event) => {
    const next = /** @type {CustomEvent<{ client?: PageClient }>} */ (event).detail?.client;
    if (next) {
      client = next;
    }
  };
  doc.addEventListener(CURRENCY_CHANGE_EVENT, onCurrencyChange);

  const done = (async () => {
    renderSummary();
    if (searchId) {
      await openSearch(searchId);
    } else if (request) {
      await runSearch(request);
    } else {
      showLayout(false);
      openForm();
    }
  })().catch(report);

  return {
    done,
    destroy() {
      destroyed = true;
      controller?.abort();
      doc.removeEventListener(CURRENCY_CHANGE_EVENT, onCurrencyChange);
      el.panel?.removeEventListener("toggle", onToggle);
      formView?.destroy();
      filtersView?.destroy();
      sortView?.destroy();
      loadMoreView?.destroy();
      live.clear();
    },
  };
}

document.documentElement.dataset.js = "on";

boot().then((context) => {
  try {
    start(/** @type {{ config: StorefrontConfig, client: PageClient }} */ (/** @type {unknown} */ (context)));
  } catch (error) {
    report(error);
  }
});
