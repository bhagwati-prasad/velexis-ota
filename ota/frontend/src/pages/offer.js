// Entry module of the offer page (offer.html, ota/frontend/docs/pages.md §5, flow ota/docs/flows/search-and-price.md,
// SDK guide B2 §4–§5). The page arrives from a results card with `/offer.html?offer=off_…`:
//
// 1. `flights.getOffer({ offerId })`: the offer in full view (the operation has no `view` parameter: it always answers
//    the full view) with its bounds, flights, connections, baggage per traveller and fare conditions.
// 2. Only when `features.brandedFareUpsell` is on: `flights.upsell({ offerId })`, shown as fare-family cards
//    (src/components/fare-families.js). Upsell is optional: until it answers, when it fails, or when the airline has
//    no other fare, the page shows the original fare alone and no error banner.
// 3. "Continue with this fare": `flights.price({ offerIds: [chosen], include: ["bags", "other-services",
//    "detailed-fare-rules"] })` with a 60 s timeout, then `/price.html?priced=prc_…`. Without `expectedTotal` the call
//    always resolves; the price page shows a changed price (B2 §5).
//
// The chosen fare is kept in the address (`fare=off_…`, removed for the original fare), so a reload or a Retry keeps
// it. States (pages.md §5): `410 OFFER_EXPIRED` (also a `404` offer, which the purge removes after it expired) shows
// "This fare is no longer available" with a link to refreshed results; `409 SOLD_OUT` at pricing "This flight just
// sold out" with a link back to the results; `504 SUPPLIER_TIMEOUT`, `503 SUPPLIER_UNAVAILABLE` and the other
// passing failures at pricing a Retry next to the fares, which stay as chosen. Links to the results come from the
// results page this page was opened from (the same-origin referrer, its `search=` id dropped for refreshed results),
// else from the offer's search (`/search.html?search=srch_…`), else the home page. Prices are the API's own amounts.

import { boot, renderState } from "../boot.js";
import {
  bagText,
  familiesFromUpsell,
  familyFromOffer,
  mount as mountFareFamilies,
} from "../components/fare-families.js";
import { airlineLabel, itineraryTitle, renderItinerary, renderSegments } from "../components/itinerary.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { FEW_SEATS } from "../components/offer-card.js";
import { passengerSummary } from "../components/passenger-picker.js";
import { clone, fill } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatLocalDate, formatMoney } from "../lib/format.js";
import { withSubmitState } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import { replaceQuery, withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["FlightOffer"]} FlightOffer */
/** @typedef {import("@velexis/ota-sdk").Schemas["UpsellResult"]} UpsellResult */
/** @typedef {import("@velexis/ota-sdk").Schemas["PricedOffer"]} PricedOffer */
/** @typedef {import("@velexis/ota-sdk").Schemas["Dictionaries"]} Dictionaries */
/** @typedef {import("@velexis/ota-sdk").Schemas["OfferTravelerPricing"]} TravelerPricing */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {Pick<VelexisClient, "flights">} PageClient */
/** @typedef {{ back: string, refresh: string }} ResultsLinks */
/** @typedef {{ traveller: string, checked: string, cabin: string | null }} BaggageRow */

/** An offer id as the API writes it. */
export const OFFER_ID = /^off_[0-9A-Za-z]{16,40}$/;
/** A priced offer id as the API writes it. */
export const PRICED_OFFER_ID = /^prc_[0-9A-Za-z]{16,40}$/;
const SEARCH_ID = /^srch_[0-9A-Za-z]{16,40}$/;
/** How long `flights.price` may take (Amadeus Flight Offers Price, B2 §5). */
export const PRICE_TIMEOUT_MS = 60_000;
/** What the price page shows: bags and other services available, and the detailed fare rules. */
export const PRICE_INCLUDE = Object.freeze(["bags", "other-services", "detailed-fare-rules"]);
/** States after which the same call cannot do better: no Retry. */
const FINAL_STATES = new Set([
  "suspended",
  "unknown-host",
  "supplier-not-configured",
  "feature-disabled",
  "forbidden",
  "signed-out",
  "validation",
]);
/** Traveller types counted as adults, children and infants in the summary line. */
const ADULT_TYPES = new Set(["ADULT", "SENIOR", "YOUNG", "STUDENT"]);
const INFANT_TYPES = new Set(["HELD_INFANT", "SEATED_INFANT"]);

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
 * The links of the page to the results: `back` to the results as they were, `refresh` to results searched again with
 * the same trip, filters and sort. From the results page this page was opened from (a same-origin `referrer` at
 * `/search.html`), else from the offer's search id, else the home page.
 * @param {string} referrer `document.referrer`
 * @param {string} origin the page's own origin
 * @param {string | null | undefined} [searchId] the offer's search, once known
 * @returns {ResultsLinks}
 */
export function resultsLinks(referrer, origin, searchId) {
  const ownSearch =
    typeof searchId === "string" && SEARCH_ID.test(searchId)
      ? withQuery("/search.html", { search: searchId })
      : null;
  /** @type {URL | null} */
  let url = null;
  try {
    url = referrer ? new URL(referrer) : null;
  } catch {
    url = null;
  }
  if (url && url.origin === origin && url.pathname === "/search.html") {
    const params = new URLSearchParams(url.search);
    const back = withQuery("/search.html", params);
    params.delete("search");
    const hasTrip = params.has("legs") || (params.has("from") && params.has("to"));
    return { back, refresh: hasTrip ? withQuery("/search.html", params) : back };
  }
  return ownSearch ? { back: ownSearch, refresh: ownSearch } : { back: "/", refresh: "/" };
}

/**
 * The adults, children and infants of an offer's travellers (by their Amadeus types), or `null` without pricings.
 * @param {TravelerPricing[] | undefined} pricings
 */
export function travellersOf(pricings) {
  if (!Array.isArray(pricings) || pricings.length === 0) {
    return null;
  }
  const count = (/** @type {(type: string) => boolean} */ match) =>
    pricings.filter((pricing) => match(String(pricing.travelerType))).length;
  return {
    adults: count((type) => ADULT_TYPES.has(type)),
    children: count((type) => type === "CHILD"),
    infants: count((type) => INFANT_TYPES.has(type)),
    total: pricings.length,
  };
}

/**
 * The baggage of an offer, one row per traveller type: checked and cabin bags from the fare of each flight (one text
 * when every flight allows the same, else per flight). Without fare details, the summary's allowance of an adult.
 * @param {FlightOffer} offer
 * @param {(code: string) => string} [placeCode] how a flight's airports are named in a per-flight list
 * @returns {BaggageRow[]}
 */
export function baggageRows(offer, placeCode = (code) => code) {
  const pricings = Array.isArray(offer.travelerPricings) ? offer.travelerPricings : [];
  if (pricings.length === 0) {
    const checked = bagText(offer.summary.includedCheckedBags);
    const cabin = bagText(offer.summary.includedCabinBags);
    return checked === null && cabin === null
      ? []
      : [
          {
            traveller: t("baggage.eachAdult"),
            checked: t("baggage.checked", { allowance: checked ?? t("baggage.unknown") }),
            cabin: cabin === null ? null : t("baggage.cabin", { allowance: cabin }),
          },
        ];
  }
  /** @type {Map<string, string>} */
  const routes = new Map();
  for (const itinerary of offer.itineraries) {
    for (const segment of itinerary.segments) {
      routes.set(
        segment.id,
        t("baggage.route", {
          from: placeCode(segment.departure.iataCode),
          to: placeCode(segment.arrival.iataCode),
        }),
      );
    }
  }
  /**
   * @param {TravelerPricing} pricing
   * @param {"includedCheckedBags" | "includedCabinBags"} field
   */
  const allowance = (pricing, field) => {
    const texts = pricing.segments.map((segment) => bagText(segment[field]));
    if (texts.every((text) => text === null)) {
      return null;
    }
    if (new Set(texts).size === 1) {
      return /** @type {string} */ (texts[0]);
    }
    return pricing.segments
      .map((segment, index) =>
        t("baggage.segment", {
          route: routes.get(segment.segmentId) ?? segment.segmentId,
          allowance: texts[index] ?? t("baggage.unknown"),
        }),
      )
      .join(t("baggage.segmentSeparator"));
  };
  /** @type {Map<string, TravelerPricing>} */
  const byType = new Map();
  for (const pricing of pricings) {
    if (!byType.has(pricing.travelerType)) {
      byType.set(pricing.travelerType, pricing);
    }
  }
  return Array.from(byType, ([type, pricing]) => {
    const checked = allowance(pricing, "includedCheckedBags");
    const cabin = allowance(pricing, "includedCabinBags");
    return {
      traveller: t(`traveller.${type}`),
      checked: t("baggage.checked", { allowance: checked ?? t("baggage.unknown") }),
      cabin: cabin === null ? null : t("baggage.cabin", { allowance: cabin }),
    };
  });
}

/**
 * Runs the offer page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page has
 * no offer area, else `{ done, destroy }`: `done` settles once the offer (or a state) is shown.
 * @param {{ config: StorefrontConfig, client: PageClient }} context
 * @param {{ doc?: Document, location?: Location, history?: History, referrer?: string, navigate?: (url: string) => void }} [env]
 *   for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-offer-page]"));
  if (!main) {
    return null;
  }
  const location = env.location ?? doc.defaultView?.location ?? globalThis.location;
  const history = env.history ?? doc.defaultView?.history ?? globalThis.history;
  const referrer = env.referrer ?? doc.referrer;
  const navigate = env.navigate ?? ((/** @type {string} */ url) => location.assign(url));
  const { config, client } = context;
  const locale = config?.defaultLocale;
  const support = config?.support ?? null;
  const live = mountLiveRegion(doc.body);

  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (main.querySelector(selector));
  const el = {
    back: /** @type {HTMLAnchorElement | null} */ (main.querySelector("a[data-back-link]")),
    title: find("[data-offer-title]"),
    summary: find("[data-offer-summary]"),
    state: find("[data-offer-state]"),
    loading: find("[data-offer-loading]"),
    content: find("[data-offer-content]"),
    itineraries: find("[data-offer-itineraries]"),
    segments: find("[data-offer-segments]"),
    baggage: find("[data-offer-baggage]"),
    form: /** @type {HTMLFormElement} */ (main.querySelector("form[data-fare-form]")),
    faresStatus: find("[data-fares-status]"),
    families: find("[data-fare-families]"),
    priceState: find("[data-price-state]"),
    selectedFare: find("[data-selected-fare]"),
    price: find("[data-offer-price]"),
    priceNote: find("[data-offer-price-note]"),
    perAdult: find("[data-offer-per-adult]"),
    seats: find("[data-offer-seats]"),
  };

  const params = new URLSearchParams(location.search);
  const idParam = params.get("offer");
  const offerId = idParam !== null && OFFER_ID.test(idParam) ? idParam : null;
  /** The fare chosen before a reload (`fare=off_…`), applied once the upsell lists it. */
  const fareParam = params.get("fare");
  /** @type {FlightOffer | null} */
  let offer = null;
  let links = resultsLinks(referrer, location.origin);
  /** Airport and airline names by code, from the dictionaries and the flights. @type {Map<string, string>} */
  const places = new Map();
  /** @type {Map<string, string>} */
  const airlines = new Map();
  /** The running getOffer or upsell call (aborted by destroy). @type {AbortController | null} */
  let controller = null;
  let destroyed = false;

  /** @param {string} code */
  const place = (code) => {
    const name = places.get(code);
    return name ? t("results.place", { name, code }) : code;
  };
  /** @param {string} code */
  const airline = (code) => airlineLabel(code, airlines.get(code));

  const fares = mountFareFamilies(el.families, {
    ...(locale ? { locale } : {}),
    onChange(id) {
      replaceQuery({ fare: offer && id !== offer.id ? id : null }, { location, history });
      renderSelected(true);
    },
  });

  /** The line under the fares: the chosen fare and its total (announced when the traveller changed it). */
  const renderSelected = (announce = false) => {
    const family = fares.family(fares.selected());
    const text = family
      ? t("fares.selected", { name: family.name, price: formatMoney(family.price, locale) })
      : "";
    el.selectedFare.textContent = text;
    if (announce && text !== "") {
      live.announce(text);
    }
  };

  const renderBackLink = () => {
    if (el.back) {
      el.back.href = links.back;
      el.back.hidden = links.back === "/";
    }
  };
  renderBackLink();

  /** Learns place and airline names from dictionaries and flights. */
  const learn = (/** @type {Dictionaries | null | undefined} */ dictionaries, flights = offer) => {
    for (const [code, entry] of Object.entries(dictionaries?.locations ?? {})) {
      const name = entry?.airportName ?? entry?.cityName;
      if (typeof name === "string" && name !== "" && !places.has(code)) {
        places.set(code, name);
      }
    }
    for (const [code, carrier] of Object.entries(dictionaries?.carriers ?? {})) {
      if (typeof carrier?.name === "string" && carrier.name !== "" && !airlines.has(code)) {
        airlines.set(code, carrier.name);
      }
    }
    for (const segment of (flights?.itineraries ?? []).flatMap((itinerary) => itinerary.segments)) {
      if (
        typeof segment.carrierName === "string" &&
        segment.carrierName !== "" &&
        !airlines.has(segment.carrierCode)
      ) {
        airlines.set(segment.carrierCode, segment.carrierName);
      }
    }
  };

  /**
   * A link under a state: back to the results, refreshed results, or the home page.
   * @param {HTMLElement} element the state
   * @param {"back" | "refresh"} kind
   */
  const addLink = (element, kind) => {
    const href = links[kind];
    const label =
      href === "/"
        ? t("offerPage.searchFlights")
        : kind === "refresh"
          ? t("offerPage.searchAgain")
          : t("offerPage.backToResults");
    const link = fill(clone("tpl-state-link", doc), { label, href });
    const retry = element.querySelector('[data-action="retry"]')?.closest("p");
    if (retry) {
      retry.before(link);
    } else {
      element.append(link);
    }
  };

  /**
   * Replaces the offer with a state (the offer cannot be used any more, or never loaded).
   * @param {Pick<PageState, "name" | "message" | "scope"> & Partial<PageState>} state
   * @param {{ link?: "back" | "refresh", onRetry?: () => void, requestId?: string | null, focus?: boolean }} [options]
   */
  const showPageState = (state, { link, onRetry, requestId = null, focus = false } = {}) => {
    controller?.abort();
    el.loading.hidden = true;
    el.content.hidden = true;
    el.priceState.replaceChildren();
    doc.title = state.message;
    const element = renderState(el.state, state, {
      support,
      requestId,
      focus,
      ...(onRetry ? { onRetry } : {}),
    });
    if (link) {
      addLink(element, link);
    }
    live.announce(state.message);
  };

  /** "This fare is no longer available", with a link to refreshed results. */
  const showExpired = (focus = false) =>
    showPageState(
      { name: "offer-expired", scope: "inline", message: t("state.offer-expired") },
      { link: "refresh", focus },
    );

  /** @param {unknown} error */
  const requestIdOf = (error) =>
    error instanceof Error && "requestId" in error
      ? String(/** @type {{ requestId: unknown }} */ (error).requestId ?? "") || null
      : null;

  /** A state for a failure the page has no own state for: validation reads as "Something went wrong". */
  const stateOf = (/** @type {unknown} */ error) => {
    const state = pageStateFor(error);
    return state.name === "validation" ? { ...state, message: t("state.unexpected") } : state;
  };

  /** The page title and the trip line: route, the date of each bound, the travellers. */
  const renderHeading = (/** @type {FlightOffer} */ current) => {
    const { summary } = current;
    const from = place(summary.originCode);
    const to = place(summary.destinationCode);
    const title =
      summary.tripType === "multi_city"
        ? t("offerPage.titleMulti")
        : t(summary.tripType === "round_trip" ? "offerPage.titleReturn" : "offerPage.title", { from, to });
    el.title.textContent = title;
    doc.title = title;
    const parts = current.itineraries.map((itinerary) =>
      t("offerPage.boundDate", {
        title: itineraryTitle(itinerary.index, summary.tripType),
        date: formatLocalDate(itinerary.departureAt, locale),
      }),
    );
    const travellers = travellersOf(current.travelerPricings);
    if (travellers) {
      parts.push(passengerSummary(travellers));
    }
    el.summary.textContent = parts.join(t("results.separator"));
  };

  const renderBaggage = (/** @type {FlightOffer} */ current) => {
    const rows = baggageRows(current, place);
    el.baggage.replaceChildren(
      ...rows.map((row) => fill(clone("tpl-baggage", doc), { ...row, noCabin: row.cabin === null })),
    );
    el.baggage.hidden = rows.length === 0;
  };

  /** The search price: the API's total, the travellers it is for, the price per adult and the seats left. */
  const renderPrice = (/** @type {FlightOffer} */ current) => {
    const travellers = travellersOf(current.travelerPricings)?.total ?? null;
    el.price.textContent = formatMoney(current.price.total, locale);
    el.priceNote.textContent = travellers === null ? "" : t("offer.totalFor", { count: travellers });
    const perAdult =
      travellers !== null && travellers > 1 && current.price.perAdult
        ? t("offer.perAdult", { price: formatMoney(current.price.perAdult, locale) })
        : null;
    el.perAdult.textContent = perAdult ?? "";
    el.perAdult.hidden = perAdult === null;
    const seats = current.numberOfBookableSeats ?? current.summary.numberOfBookableSeats;
    const few = typeof seats === "number" && seats > 0 && seats <= FEW_SEATS;
    el.seats.textContent = few ? t("offer.seatsLeft", { count: seats }) : "";
    el.seats.hidden = !few;
  };

  const renderOffer = (/** @type {FlightOffer} */ current) => {
    learn(current.dictionaries, current);
    renderHeading(current);
    const context = { doc, locale, tripType: current.summary.tripType, airline, place };
    el.itineraries.replaceChildren(
      ...current.itineraries.map((itinerary) => renderItinerary(itinerary, context)),
    );
    el.segments.replaceChildren(
      ...current.itineraries.map((itinerary) => renderSegments(itinerary, context)),
    );
    renderBaggage(current);
    renderPrice(current);
    fares.update({ families: [familyFromOffer(current)], selected: current.id });
    renderSelected();
    el.state.replaceChildren();
    el.loading.hidden = true;
    el.content.hidden = false;
  };

  /**
   * The airline's other fare families on these flights. Optional: a failure or no other fare keeps the original fare
   * alone, without a message.
   * @param {FlightOffer} current
   */
  const loadUpsell = async (current) => {
    if (config?.features?.brandedFareUpsell !== true || typeof client.flights.upsell !== "function") {
      return;
    }
    const own = new AbortController();
    controller = own;
    el.faresStatus.textContent = t("fares.loading");
    /** @type {UpsellResult} */
    let upsell;
    try {
      upsell = await client.flights.upsell({ offerId: current.id }, { signal: own.signal });
    } catch {
      if (!destroyed && controller === own) {
        el.faresStatus.textContent = "";
      }
      return;
    }
    if (destroyed || controller !== own) {
      return;
    }
    const families = familiesFromUpsell(upsell);
    if (families.length < 2) {
      el.faresStatus.textContent = "";
      return;
    }
    learn(upsell.dictionaries, current);
    const chosen = fares.selected();
    const wanted =
      fareParam !== null && families.some((family) => family.offerId === fareParam) && chosen === current.id
        ? fareParam
        : chosen;
    fares.update({ families, selected: wanted });
    el.faresStatus.textContent = t("fares.choose");
    renderSelected();
    live.announce(t("fares.found", { count: families.length }));
  };

  /**
   * Loads the offer, then its fare families.
   * @param {{ focus?: boolean }} [options] `focus` moves the focus to a state that follows a Retry
   */
  const load = async ({ focus = false } = {}) => {
    const own = new AbortController();
    controller = own;
    el.state.replaceChildren();
    el.content.hidden = true;
    el.loading.hidden = false;
    live.announce(t("offerPage.loading"));
    /** @type {FlightOffer} */
    let current;
    try {
      current = await client.flights.getOffer(
        { offerId: /** @type {string} */ (offerId) },
        { signal: own.signal },
      );
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = stateOf(error);
      if (state.name === "offer-expired" || state.name === "not-found") {
        showExpired(focus);
        return;
      }
      showPageState(state, {
        ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => load({ focus: true }).catch(report) }),
        requestId: state.name === "unexpected" ? requestIdOf(error) : null,
        focus,
      });
      return;
    }
    if (destroyed) {
      return;
    }
    offer = current;
    links = resultsLinks(referrer, location.origin, current.searchId);
    renderBackLink();
    renderOffer(current);
    live.announce(el.title.textContent ?? "");
    if (focus) {
      el.title.tabIndex = -1;
      el.title.focus();
    }
    await loadUpsell(current);
  };

  /**
   * The state of a failed pricing. An expired, vanished or sold-out fare replaces the offer; anything that may pass
   * shows Retry next to the fares, which stay as chosen.
   * @param {unknown} error
   */
  const failPrice = (error) => {
    const state = stateOf(error);
    if (state.name === "offer-expired" || state.name === "not-found") {
      showExpired(true);
      return;
    }
    if (state.name === "sold-out") {
      showPageState(state, { link: "back", focus: true });
      return;
    }
    const element = renderState(el.priceState, state, {
      support,
      requestId: state.name === "unexpected" ? requestIdOf(error) : null,
      ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => submit().catch(report) }),
    });
    if (FINAL_STATES.has(state.name)) {
      addLink(element, "back");
    }
    live.announce(state.message);
  };

  /** "Continue with this fare": prices the chosen fare and opens the price page with the priced offer. */
  const submit = () =>
    withSubmitState(el.form, async () => {
      const current = offer;
      if (!current || destroyed) {
        return;
      }
      const chosen = fares.selected() ?? current.id;
      el.priceState.replaceChildren();
      live.announce(t("fares.pricing"));
      /** @type {PricedOffer} */
      let priced;
      try {
        priced = await client.flights.price(
          { offerIds: [chosen], include: [...PRICE_INCLUDE] },
          { timeoutMs: PRICE_TIMEOUT_MS },
        );
      } catch (error) {
        if (!destroyed && !isAborted(error)) {
          failPrice(error);
        }
        return;
      }
      if (destroyed) {
        return;
      }
      if (typeof priced?.id !== "string" || !PRICED_OFFER_ID.test(priced.id)) {
        failPrice(new Error("flights.price answered without a priced offer id"));
        return;
      }
      navigate(withQuery("/price.html", { priced: priced.id }));
    });

  /** @param {Event} event */
  const onSubmit = (event) => {
    event.preventDefault();
    submit().catch(report);
  };
  el.form.addEventListener("submit", onSubmit);

  const done = (async () => {
    if (offerId === null) {
      showPageState(
        { name: "not-found", scope: "inline", message: t("offerPage.missing") },
        { link: "back" },
      );
      return;
    }
    await load();
  })().catch(report);

  return {
    done,
    destroy() {
      destroyed = true;
      controller?.abort();
      el.form.removeEventListener("submit", onSubmit);
      fares.destroy();
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
