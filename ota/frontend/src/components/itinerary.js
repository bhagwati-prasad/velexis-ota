// One bound of an offer on the results page (ota/frontend/docs/pages.md §4): the row of an offer card (times,
// airports, duration, stops, airlines) and its flight details (segments and connections). Rows are clones of the
// `tpl-itinerary`, `tpl-segment-group`, `tpl-segment` and `tpl-layover` templates (partials/templates/offer-card.html
// and segment.html) filled with `fill()`, so API data only ever becomes text.
//
// - Times are airport-local wall-clock strings, formatted from their parts (lib/format.js): no time-zone shift.
// - Airlines show their name and IATA code ("Air France (AF)"); there are no airline logos (no external images under
//   the CSP, README §6).
// - Durations, stops and the "+1 day" arrival come from the API's own fields (`durationMinutes`, `stops`,
//   `arrivalDayOffset`); nothing is computed from times.

import { clone, fill } from "../lib/dom.js";
import { formatLocalDateTime, formatLocalTime, formatMinutes } from "../lib/format.js";
import { t } from "../lib/i18n.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["Itinerary"]} Itinerary */
/** @typedef {import("@velexis/ota-sdk").Schemas["Segment"]} Segment */
/** @typedef {import("@velexis/ota-sdk").Schemas["SegmentEndpoint"]} SegmentEndpoint */
/** @typedef {"one_way" | "round_trip" | "multi_city"} TripType */
/**
 * What rendering needs besides the data.
 * @typedef {object} RenderContext
 * @property {string | undefined} locale the OTA's `defaultLocale`
 * @property {TripType} tripType names the bounds ("Outbound", "Return", "Flight 2")
 * @property {(code: string) => string} airline the label of an airline code, "Air France (AF)"
 * @property {(code: string) => string} place the label of an airport or city code, "Amsterdam (AMS)" or the code
 * @property {Document} doc the page
 */

/**
 * "Air France (AF)" from a name, or the code alone without one.
 * @param {string} code
 * @param {string | null | undefined} name
 */
export const airlineLabel = (code, name) =>
  typeof name === "string" && name.trim() !== "" ? t("airline.label", { name: name.trim(), code }) : code;

/**
 * The title of a bound: "Outbound" and "Return" for one-way and return trips, "Flight 2" for multi-city.
 * @param {number} index 0 = outbound
 * @param {TripType | string | undefined} tripType
 */
export function itineraryTitle(index, tripType) {
  if (tripType === "multi_city") {
    return t("itinerary.leg", { number: index + 1 });
  }
  return index === 0 ? t("itinerary.outbound") : t("itinerary.return");
}

/**
 * "Direct", "1 stop via AMS" or "2 stops via AMS, CDG" (codes from `stopAirports`, else the count alone).
 * @param {Pick<Itinerary, "stops" | "stopAirports">} itinerary
 */
export function stopsText({ stops, stopAirports }) {
  if (stops === 0) {
    return t("itinerary.direct");
  }
  const airports = Array.isArray(stopAirports) ? stopAirports.filter((code) => code !== "") : [];
  return airports.length > 0
    ? t("itinerary.stops", { count: stops, airports: airports.join(", ") })
    : t("itinerary.stopCount", { count: stops });
}

/**
 * The card row of one bound: departure and arrival times and airports, duration, stops and airlines.
 * @param {Itinerary} itinerary
 * @param {RenderContext} context
 * @returns {HTMLElement}
 */
export function renderItinerary(itinerary, context) {
  const element = clone("tpl-itinerary", context.doc);
  const dayOffset = typeof itinerary.arrivalDayOffset === "number" ? itinerary.arrivalDayOffset : 0;
  const carriers = Array.isArray(itinerary.marketingCarriers) ? itinerary.marketingCarriers : [];
  return fill(element, {
    title: itineraryTitle(itinerary.index, context.tripType),
    departureTime: formatLocalTime(itinerary.departureAt, context.locale),
    departureAt: itinerary.departureAt,
    originCode: itinerary.originCode,
    arrivalTime: formatLocalTime(itinerary.arrivalAt, context.locale),
    arrivalAt: itinerary.arrivalAt,
    destinationCode: itinerary.destinationCode,
    dayOffset: dayOffset > 0 ? t("itinerary.dayOffset", { count: dayOffset }) : null,
    noDayOffset: dayOffset <= 0,
    duration: formatMinutes(itinerary.durationMinutes),
    stops: stopsText(itinerary),
    carriers: carriers.map((code) => context.airline(code)).join(", "),
  });
}

/**
 * "20 Nov 2026, 08:35 Charles de Gaulle (CDG), terminal 2E".
 * @param {SegmentEndpoint} endpoint
 * @param {RenderContext} context
 */
function endpointText(endpoint, context) {
  const name = endpoint.airportName ?? endpoint.cityName;
  const place =
    typeof name === "string" && name !== ""
      ? t("results.place", { name, code: endpoint.iataCode })
      : context.place(endpoint.iataCode);
  const where =
    typeof endpoint.terminal === "string" && endpoint.terminal !== ""
      ? t("segment.terminal", { place, terminal: endpoint.terminal })
      : place;
  return t("segment.endpoint", { time: formatLocalDateTime(endpoint.at, context.locale), place: where });
}

/**
 * One flight of a bound.
 * @param {Segment} segment
 * @param {RenderContext} context
 */
function renderSegment(segment, context) {
  const operating =
    segment.operating && segment.operating.carrierCode !== segment.carrierCode ? segment.operating : null;
  const cabin = typeof segment.cabin === "string" ? t(`cabin.${segment.cabin}`) : null;
  const details = [
    typeof segment.durationMinutes === "number" ? formatMinutes(segment.durationMinutes) : null,
    cabin,
    segment.aircraft?.name ?? segment.aircraft?.code ?? null,
  ].filter((part) => typeof part === "string" && part !== "");
  return fill(clone("tpl-segment", context.doc), {
    flight: t("segment.flight", {
      airline: context.airline(segment.carrierCode),
      flightNumber: segment.flightNumber,
    }),
    operatedBy: operating
      ? t("segment.operatedBy", { airline: airlineLabel(operating.carrierCode, operating.carrierName) })
      : null,
    noOperatedBy: operating === null,
    departure: endpointText(segment.departure, context),
    arrival: endpointText(segment.arrival, context),
    details: details.join(t("results.separator")),
  });
}

/**
 * The connection after a flight: its duration and airport, a change of airport, an overnight connection.
 * @param {NonNullable<Segment["layoverAfter"]>} layover
 * @param {Segment} segment the flight before it
 * @param {RenderContext} context
 */
function renderLayover(layover, segment, context) {
  const next = layover.nextDepartureCode ?? segment.arrival.iataCode;
  return fill(clone("tpl-layover", context.doc), {
    text: t("segment.layover", {
      duration: formatMinutes(layover.durationMinutes),
      place: context.place(segment.arrival.iataCode),
    }),
    airportChange: layover.airportChange ? t("segment.airportChange", { place: context.place(next) }) : null,
    noAirportChange: !layover.airportChange,
    overnight: layover.overnight ? t("segment.overnight") : null,
    noOvernight: !layover.overnight,
  });
}

/**
 * The flight details of one bound: its title, then each flight and the connections between them.
 * @param {Itinerary} itinerary
 * @param {RenderContext} context
 * @returns {HTMLElement}
 */
export function renderSegments(itinerary, context) {
  const group = fill(clone("tpl-segment-group", context.doc), {
    title: itineraryTitle(itinerary.index, context.tripType),
  });
  const list = group.querySelector("[data-segments]") ?? group;
  for (const segment of itinerary.segments) {
    list.append(renderSegment(segment, context));
    if (segment.layoverAfter) {
      list.append(renderLayover(segment.layoverAfter, segment, context));
    }
  }
  return group;
}
