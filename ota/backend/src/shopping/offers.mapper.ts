// Flight offers and searches between Amadeus, the tenant tables and the API (OBE-021; ota/docs/flows/search-and-price.md
// §2 steps 2–5, OADR-0002 points 1, 5, 8, OADR-0005 point 2). Pure functions: no I/O, no clock (the caller passes
// `now`), money in decimal.js (`Money` of the pricing context), never a JavaScript number.
//
// Request side:
//   flights.search body → the Amadeus Flight Offers Search request: SIMPLE mode becomes the GET query (airline lists
//   comma-separated), ADVANCED mode the POST body, both with the storefront defaults (`search_defaults`) and the
//   currency (body → X-Currency → default currency) filled in (`buildAmadeusSearch`), and the normalised trip
//   description of FlightSearchSummary (`searchSummaryOf`).
//
// Storage side:
//   an Amadeus offer → `parseOffer` (a checked, normalised reading of the verbatim payload) → `offerColumns` (the
//   summary columns of `flight_offers` that filters, sorting, facets and the best score use) and `pricingInputOf`
//   (the facts the markup and fee engine matches rules against).
//
// Response side (`toFlightOffer`): the stored row → FlightOffer. The verbatim Amadeus offer holds net amounts:
//   - customer scope (the edge, publishable keys and secret keys without console scope) gets selling amounts only: the
//     offer's markup is folded into the base fare (`price.base`, `total`, `grandTotal`) and distributed over the
//     travellers' `price.base`/`total` in proportion to their net totals (largest remainder, so the shares add up to
//     the markup exactly); Amadeus `margins` are removed; `netPrice` and `markup` are absent;
//   - console scope gets the verbatim Amadeus offer plus `netPrice` and `markup`.
//   `view=summary` leaves out `amadeus`, `travelerPricings` and `price.breakdown`.
import type { components } from "@velexis/api-types";
import {
  Money,
  type MoneyValue,
  type PricingChannel,
  type PricingInput,
  type TripType,
} from "../pricing/pricing.types";
import { tagsOf, type FacetRow, type FlightSearchHighlights } from "./facets";

type Schemas = components["schemas"];
export type FlightOffer = Schemas["FlightOffer"];
export type FlightSearchCreateRequest = Schemas["FlightSearchCreateRequest"];
export type FlightSearchSimpleRequest = Schemas["FlightSearchSimpleRequest"];
export type FlightSearchAdvancedRequest = Schemas["FlightSearchAdvancedRequest"];
export type FlightSearchAdvancedQuery = Schemas["FlightSearchAdvancedQuery"];
export type FlightSearchSummary = Schemas["FlightSearchSummary"];
export type FlightSearchCriteria = Schemas["FlightSearchCriteria"];
export type TravelClass = Schemas["AmadeusTravelClass"];
export type TravelerType = Schemas["AmadeusTravelerType"];
export type OfferSource = Schemas["AmadeusFlightOfferSource"];
type FareOption = Schemas["AmadeusTravelerPricingFareOption"];
type AmenityType = Schemas["AmadeusAmenityType"];
type MoneyAmount = Schemas["Money"];
type SellingPrice = Schemas["SellingPrice"];
type OfferSummary = Schemas["OfferSummary"];
type Itinerary = Schemas["Itinerary"];
type Segment = Schemas["Segment"];
type SegmentEndpoint = Schemas["SegmentEndpoint"];
type OfferTravelerPricing = Schemas["OfferTravelerPricing"];
type SegmentFareDetail = Schemas["SegmentFareDetail"];
type BagAllowance = Schemas["BagAllowance"];
type PriceBreakdown = Schemas["PriceBreakdown"];
type PriceBreakdownFee = Schemas["PriceBreakdownFee"];
type AmadeusFlightOffer = Schemas["AmadeusFlightOffer"];

/** Who reads an offer: customer scope (selling amounts only) or console scope (net amounts and supplier data). */
export type OfferScope = "customer" | "console";
/** `summary` omits `amadeus`, `travelerPricings` and `price.breakdown`; `full` returns everything. */
export type OfferView = "summary" | "full";

// ---- Enumerations of the document ---------------------------------------------------------------------------------

export const TRAVEL_CLASSES: readonly TravelClass[] = Object.freeze([
  "ECONOMY",
  "PREMIUM_ECONOMY",
  "BUSINESS",
  "FIRST",
]);
export const OFFER_SOURCES: readonly OfferSource[] = Object.freeze(["GDS", "LTC", "PYTON", "EAC", "NDC"]);
const TRAVELER_TYPES: readonly TravelerType[] = Object.freeze([
  "ADULT",
  "CHILD",
  "SENIOR",
  "YOUNG",
  "HELD_INFANT",
  "SEATED_INFANT",
  "STUDENT",
]);
/** Traveller types that count as adults (FlightSearchSummary.travelers, the "per adult" price). */
const ADULT_TYPES: ReadonlySet<string> = new Set(["ADULT", "SENIOR", "YOUNG", "STUDENT"]);
const INFANT_TYPES: ReadonlySet<string> = new Set(["HELD_INFANT", "SEATED_INFANT"]);
const FARE_OPTIONS: readonly FareOption[] = Object.freeze([
  "STANDARD",
  "INCLUSIVE_TOUR",
  "SPANISH_MELILLA_RESIDENT",
  "SPANISH_CEUTA_RESIDENT",
  "SPANISH_CANARY_RESIDENT",
  "SPANISH_BALEARIC_RESIDENT",
  "AIR_FRANCE_METROPOLITAN_DISCOUNT_PASS",
  "AIR_FRANCE_DOM_DISCOUNT_PASS",
  "AIR_FRANCE_COMBINED_DISCOUNT_PASS",
  "AIR_FRANCE_FAMILY",
  "ADULT_WITH_COMPANION",
  "COMPANION",
  "VISIT_FRIENDS_RELATIVES",
  "CONTRACT_BULK",
]);
const AMENITY_TYPES: readonly AmenityType[] = Object.freeze([
  "BUNDLED_SERVICE",
  "BRANDED_FARES",
  "BAGGAGE",
  "CARBON_OFFSET",
  "FREQUENT_FLYER",
  "GROUND",
  "ENTERTAINMENT",
  "LOUNGE",
  "MEDICAL",
  "MEAL",
  "PETS",
  "RULE_OVERRIDE",
  "STANDBY",
  "STORE",
  "TRAVEL_SERVICES",
  "UNACCOMPANIED_TRAVEL",
  "UPGRADES",
  "UNACCOMPANIED_TRAVEL_UNESCORTED",
  "PRE_RESERVED_SEAT",
  "WIFI",
  "BEVERAGE",
  "POWER",
  "SEAT",
  "LAYOUT",
]);
/** Amadeus fee types → PriceBreakdownFee.type. */
const FEE_TYPES: Readonly<Record<string, PriceBreakdownFee["type"]>> = Object.freeze({
  TICKETING: "ticketing",
  FORM_OF_PAYMENT: "form_of_payment",
  SUPPLIER: "supplier",
});

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

// ---- Loose JSON readers (the payload is stored jsonb, read defensively) ---------------------------------------

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;
const flag = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const decimal = (value: unknown): string | undefined =>
  typeof value === "string" && DECIMAL.test(value) ? value : undefined;
const IATA_LOCATION = /^[A-Z]{3}$/;
const CARRIER = /^[A-Z0-9]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const distinctSorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// ---- Times ---------------------------------------------------------------------------------------------------------

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?/;
const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * An Amadeus local date-time (`2027-01-15T06:00:00`, fractions and offsets dropped) as `YYYY-MM-DDTHH:MM:SS`, or
 * `undefined` when it names no real time (`24:00`, 30 February): the minutes and `timestamp` columns could not hold it.
 */
export function localDateTime(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = LOCAL_DATE_TIME.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second] = match;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}`;
  const parsed = Date.parse(`${local}Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 19) === local ? local : undefined;
}

/** Minutes after midnight of a normalised local date-time. */
export function minutesOfDay(local: string): number {
  return Number.parseInt(local.slice(11, 13), 10) * 60 + Number.parseInt(local.slice(14, 16), 10);
}

/** Minutes since the epoch of a local date-time read as UTC: differences of times in one place are exact. */
function localEpochMinutes(local: string): number {
  return Math.floor(Date.parse(`${local}Z`) / 60_000);
}

/** Days between the dates of two local date-times. */
function dayDifference(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000,
  );
}

/** Minutes of an ISO 8601 duration (`PT5H45M`, `P1DT2H`), seconds rounded down; `undefined` when malformed. */
export function parseIsoDuration(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "P" || value.endsWith("T")) {
    return undefined;
  }
  const match = ISO_DURATION.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  const part = (digits: string | undefined): number =>
    digits === undefined ? 0 : Number.parseInt(digits, 10);
  return (
    part(days) * 1440 + part(hours) * 60 + part(minutes) + Math.floor(Number.parseFloat(seconds ?? "0") / 60)
  );
}

/** `PT{h}H{m}M` of a number of minutes. */
export function isoDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `PT${rest}M`;
  }
  return rest === 0 ? `PT${hours}H` : `PT${hours}H${rest}M`;
}

// ---- Parsed offers -------------------------------------------------------------------------------------------------

export interface ParsedEndpoint {
  readonly iataCode: string;
  readonly terminal: string | null;
  /** `YYYY-MM-DDTHH:MM:SS`, local time of the airport. */
  readonly at: string;
}

export interface ParsedSegment {
  readonly id: string;
  readonly departure: ParsedEndpoint;
  readonly arrival: ParsedEndpoint;
  readonly carrierCode: string;
  readonly number: string;
  readonly operatingCarrier: string | null;
  readonly aircraft: string | null;
  readonly duration: string | null;
  readonly durationMinutes: number | null;
  readonly numberOfStops: number;
  readonly stops: readonly JsonObject[];
  readonly co2Emissions: readonly JsonObject[];
  readonly blacklistedInEU: boolean | undefined;
}

export interface ParsedItinerary {
  readonly duration: string | null;
  readonly durationMinutes: number;
  readonly segments: readonly ParsedSegment[];
}

export interface ParsedBags {
  readonly quantity: number | null;
  readonly weight: number | null;
  readonly weightUnit: string | null;
}

export interface ParsedFareDetail {
  readonly segmentId: string;
  readonly cabin: TravelClass | null;
  readonly fareBasis: string | null;
  readonly brandedFare: string | null;
  readonly brandedFareLabel: string | null;
  readonly bookingClass: string | null;
  readonly isAllotment: boolean | undefined;
  readonly checkedBags: ParsedBags | null;
  readonly cabinBags: ParsedBags | null;
  readonly amenities: readonly JsonObject[];
}

export interface ParsedTravelerPricing {
  readonly travelerId: string;
  readonly travelerType: TravelerType;
  readonly fareOption: string;
  readonly associatedAdultId: string | null;
  /** Net traveller total (taxes included), a decimal string; `null` when Amadeus gave none. */
  readonly total: string | null;
  readonly base: string | null;
  readonly taxes: ReadonlyArray<{ readonly code: string; readonly amount: string }>;
  readonly fareDetails: readonly ParsedFareDetail[];
}

export interface ParsedFee {
  readonly type: string;
  readonly amount: string;
}

export interface ParsedPrice {
  readonly currency: string;
  /** Amadeus `total`: base + taxes + supplier fees (net). */
  readonly total: string;
  readonly base: string;
  /** Amadeus `grandTotal`: `total` + additional services (net); `total` when absent. */
  readonly grandTotal: string;
  readonly fees: readonly ParsedFee[];
}

/** A checked, normalised reading of a verbatim Amadeus flight offer. */
export interface ParsedOffer {
  readonly amadeusId: string;
  readonly source: OfferSource;
  readonly itineraries: readonly ParsedItinerary[];
  readonly travelerPricings: readonly ParsedTravelerPricing[];
  readonly price: ParsedPrice;
  readonly validatingAirlineCodes: readonly string[];
  readonly lastTicketingDate: string | null;
  readonly lastTicketingDateTime: string | null;
  readonly numberOfBookableSeats: number | null;
  readonly instantTicketingRequired: boolean;
  readonly paymentCardRequired: boolean | undefined;
  readonly oneWay: boolean | undefined;
  readonly isUpsellOffer: boolean | undefined;
  readonly upsellFlightOfferIds: readonly string[];
  /** Known refundability from the fare rules or the branded-fare amenities, `null` when unknown. */
  readonly refundable: boolean | null;
  readonly changeable: boolean | null;
}

function parseEndpoint(value: unknown): ParsedEndpoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const iataCode = text(value["iataCode"]);
  const at = localDateTime(value["at"]);
  if (iataCode === undefined || !IATA_LOCATION.test(iataCode) || at === undefined) {
    return undefined;
  }
  return { iataCode, terminal: text(value["terminal"]) ?? null, at };
}

function parseSegment(value: JsonObject): ParsedSegment | undefined {
  const departure = parseEndpoint(value["departure"]);
  const arrival = parseEndpoint(value["arrival"]);
  const carrierCode = text(value["carrierCode"]);
  const number = text(value["number"]);
  const id = text(value["id"]);
  if (departure === undefined || arrival === undefined || carrierCode === undefined || number === undefined) {
    return undefined;
  }
  const operating = isRecord(value["operating"]) ? text(value["operating"]["carrierCode"]) : undefined;
  const aircraft = isRecord(value["aircraft"]) ? text(value["aircraft"]["code"]) : undefined;
  const duration = text(value["duration"]) ?? null;
  return {
    id: id ?? "",
    departure,
    arrival,
    carrierCode,
    number,
    operatingCarrier: operating ?? null,
    aircraft: aircraft ?? null,
    duration,
    durationMinutes: parseIsoDuration(duration) ?? null,
    numberOfStops: integer(value["numberOfStops"]) ?? 0,
    stops: records(value["stops"]),
    co2Emissions: records(value["co2Emissions"]),
    blacklistedInEU: flag(value["blacklistedInEU"]),
  };
}

function parseItinerary(value: JsonObject): ParsedItinerary | undefined {
  const segments: ParsedSegment[] = [];
  for (const raw of records(value["segments"])) {
    const segment = parseSegment(raw);
    if (segment === undefined) {
      return undefined;
    }
    segments.push(segment);
  }
  const first = segments[0];
  const last = segments.at(-1);
  if (first === undefined || last === undefined) {
    return undefined;
  }
  const duration = text(value["duration"]) ?? null;
  const fromSegments = segments.every((segment) => segment.durationMinutes !== null)
    ? segments.reduce((sum, segment) => sum + (segment.durationMinutes ?? 0), 0) +
      segments.slice(1).reduce((sum, segment, index) => {
        const previous = segments[index];
        return previous === undefined
          ? sum
          : sum +
              Math.max(0, localEpochMinutes(segment.departure.at) - localEpochMinutes(previous.arrival.at));
      }, 0)
    : Math.max(0, localEpochMinutes(last.arrival.at) - localEpochMinutes(first.departure.at));
  return { duration, durationMinutes: parseIsoDuration(duration) ?? fromSegments, segments };
}

function parseBags(value: unknown): ParsedBags | null {
  if (!isRecord(value)) {
    return null;
  }
  // A negative allowance is no allowance anyone can read (and `min_checked_bags` must be at least 0): unknown.
  const count = (field: string): number | null => {
    const read = integer(value[field]);
    return read === undefined || read < 0 ? null : read;
  };
  const quantity = count("quantity");
  const weight = count("weight");
  if (quantity === null && weight === null) {
    return null;
  }
  return { quantity, weight, weightUnit: text(value["weightUnit"]) ?? null };
}

function parseFareDetail(value: JsonObject): ParsedFareDetail | undefined {
  const segmentId = text(value["segmentId"]);
  if (segmentId === undefined) {
    return undefined;
  }
  const cabin = value["cabin"];
  return {
    segmentId,
    cabin: oneOf(cabin, TRAVEL_CLASSES) ? cabin : null,
    fareBasis: text(value["fareBasis"]) ?? null,
    brandedFare: text(value["brandedFare"]) ?? null,
    brandedFareLabel: text(value["brandedFareLabel"]) ?? null,
    bookingClass: text(value["class"]) ?? null,
    isAllotment: flag(value["isAllotment"]),
    checkedBags: parseBags(value["includedCheckedBags"]),
    cabinBags: parseBags(value["includedCabinBags"]),
    amenities: records(value["amenities"]),
  };
}

function parseTravelerPricing(value: JsonObject): ParsedTravelerPricing | undefined {
  const travelerId = text(value["travelerId"]);
  const travelerType = value["travelerType"];
  if (travelerId === undefined || !oneOf(travelerType, TRAVELER_TYPES)) {
    return undefined;
  }
  const price = isRecord(value["price"]) ? value["price"] : {};
  return {
    travelerId,
    travelerType,
    fareOption: text(value["fareOption"]) ?? "STANDARD",
    associatedAdultId: text(value["associatedAdultId"]) ?? null,
    total: decimal(price["total"]) ?? null,
    base: decimal(price["base"]) ?? null,
    taxes: records(price["taxes"]).flatMap((tax) => {
      const code = text(tax["code"]);
      const amount = decimal(tax["amount"]);
      return code === undefined || amount === undefined ? [] : [{ code, amount }];
    }),
    fareDetails: records(value["fareDetailsBySegment"]).flatMap((detail) => parseFareDetail(detail) ?? []),
  };
}

function parsePrice(value: unknown): ParsedPrice | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const currency = text(value["currency"]);
  const total = decimal(value["total"]);
  const base = decimal(value["base"]);
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency) || total === undefined || base === undefined) {
    return undefined;
  }
  return {
    currency,
    total,
    base,
    grandTotal: decimal(value["grandTotal"]) ?? total,
    fees: records(value["fees"]).flatMap((fee) => {
      const type = text(fee["type"]);
      const amount = decimal(fee["amount"]);
      return type === undefined || amount === undefined ? [] : [{ type, amount }];
    }),
  };
}

/** An amenity naming a refund or a change, and one negating it (`NON REFUNDABLE`, `NO CHANGE`, `REFUND NOT …`). */
const amenityPatterns = (word: string): { readonly names: RegExp; readonly negates: RegExp } => ({
  names: new RegExp(word, "i"),
  negates: new RegExp(`\\b(?:NON|NOT|NO)[\\s-]*${word}|${word}\\w*\\s+NOT\\b`, "i"),
});
const REFUND = amenityPatterns("REFUND");
const CHANGE = amenityPatterns("(?:CHANGE|EXCHANGE|REBOOK)");

/**
 * Known refundability and changeability: the fare rules (`fareRules.rules[]`, category REFUND or EXCHANGE, not
 * applicable = no) decide; otherwise a branded-fare amenity naming a refund or a change (included or chargeable)
 * says yes, and one negating it (`NON REFUNDABLE TICKET`) says no; otherwise unknown. Missing amenities never say no.
 */
function conditionsOf(
  offer: JsonObject,
  pricings: readonly ParsedTravelerPricing[],
): { refundable: boolean | null; changeable: boolean | null } {
  const rules = isRecord(offer["fareRules"]) ? records(offer["fareRules"]["rules"]) : [];
  const fromRules = (categories: readonly string[]): boolean | null => {
    const matching = rules.filter((rule) => categories.includes(String(rule["category"])));
    if (matching.length === 0) {
      return null;
    }
    return matching.some((rule) => rule["notApplicable"] !== true);
  };
  const descriptions = pricings.flatMap((pricing) =>
    pricing.fareDetails.flatMap((detail) =>
      detail.amenities.flatMap((amenity) => text(amenity["description"]) ?? []),
    ),
  );
  const fromAmenities = (pattern: { readonly names: RegExp; readonly negates: RegExp }): boolean | null => {
    if (
      descriptions.some(
        (description) => pattern.names.test(description) && !pattern.negates.test(description),
      )
    ) {
      return true;
    }
    return descriptions.some((description) => pattern.negates.test(description)) ? false : null;
  };
  return {
    refundable: fromRules(["REFUND"]) ?? fromAmenities(REFUND),
    changeable: fromRules(["EXCHANGE", "REBOOK", "REISSUE"]) ?? fromAmenities(CHANGE),
  };
}

/**
 * A checked reading of an Amadeus flight offer, or `undefined` when it cannot be shown or priced: no id, an itinerary
 * without segments, a segment without its airports, real local times, carrier or flight number, a price without a
 * currency, total and base, or a traveller pricing without its traveller id and type (or a traveller id twice).
 */
export function parseOffer(payload: unknown): ParsedOffer | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const amadeusId = text(payload["id"]);
  const price = parsePrice(payload["price"]);
  const rawItineraries = records(payload["itineraries"]);
  if (amadeusId === undefined || price === undefined || rawItineraries.length === 0) {
    return undefined;
  }
  const itineraries: ParsedItinerary[] = [];
  for (const raw of rawItineraries) {
    const itinerary = parseItinerary(raw);
    if (itinerary === undefined) {
      return undefined;
    }
    itineraries.push(itinerary);
  }
  const source = payload["source"] ?? "GDS";
  if (!oneOf(source, OFFER_SOURCES)) {
    return undefined;
  }
  // Every traveller pricing must be read: customer scope rewrites the prices of the ones it reads (by traveller id),
  // so one it skipped would keep its net amounts inside `amadeus`.
  const rawPricings: unknown[] = Array.isArray(payload["travelerPricings"])
    ? payload["travelerPricings"]
    : [];
  const travelerPricings: ParsedTravelerPricing[] = [];
  for (const raw of rawPricings) {
    const pricing = isRecord(raw) ? parseTravelerPricing(raw) : undefined;
    if (pricing === undefined || travelerPricings.some((other) => other.travelerId === pricing.travelerId)) {
      return undefined;
    }
    travelerPricings.push(pricing);
  }
  const lastTicketingDate = text(payload["lastTicketingDate"]);
  const seats = integer(payload["numberOfBookableSeats"]);
  return {
    amadeusId,
    source,
    itineraries,
    travelerPricings,
    price,
    validatingAirlineCodes: strings(payload["validatingAirlineCodes"]),
    lastTicketingDate:
      lastTicketingDate !== undefined && DATE.test(lastTicketingDate.slice(0, 10))
        ? lastTicketingDate.slice(0, 10)
        : null,
    lastTicketingDateTime: localDateTime(payload["lastTicketingDateTime"]) ?? null,
    numberOfBookableSeats: seats !== undefined && seats >= 1 && seats <= 9 ? seats : null,
    instantTicketingRequired: payload["instantTicketingRequired"] === true,
    paymentCardRequired: flag(payload["paymentCardRequired"]),
    oneWay: flag(payload["oneWay"]),
    isUpsellOffer: flag(payload["isUpsellOffer"]),
    upsellFlightOfferIds: strings(payload["upsellFlightOfferIds"]),
    ...conditionsOf(payload, travelerPricings),
  };
}

// ---- Summary columns -----------------------------------------------------------------------------------------------

/** The traveller pricing whose fare details stand for the offer (the first adult, else the first traveller). */
export function leadPricing(offer: ParsedOffer): ParsedTravelerPricing | undefined {
  return (
    offer.travelerPricings.find((pricing) => ADULT_TYPES.has(pricing.travelerType)) ??
    offer.travelerPricings[0]
  );
}

function fareDetailOf(
  pricing: ParsedTravelerPricing | undefined,
  segmentId: string,
): ParsedFareDetail | undefined {
  return pricing?.fareDetails.find((detail) => detail.segmentId === segmentId);
}

/** Included checked bags as a count: pieces, or 1 for a weight-only allowance above 0. */
function bagCount(bags: ParsedBags | null): number | null {
  if (bags === null) {
    return null;
  }
  if (bags.quantity !== null) {
    return bags.quantity;
  }
  return bags.weight !== null && bags.weight > 0 ? 1 : 0;
}

/** The lowest allowance of the lead traveller over every segment, or `null` when one segment's is unknown. */
function lowestBags(
  offer: ParsedOffer,
  read: (detail: ParsedFareDetail) => ParsedBags | null,
): ParsedBags | null {
  const lead = leadPricing(offer);
  let lowest: ParsedBags | null = null;
  for (const segment of offer.itineraries.flatMap((itinerary) => itinerary.segments)) {
    const detail = fareDetailOf(lead, segment.id);
    const bags = detail === undefined ? null : read(detail);
    if (bags === null) {
      return null;
    }
    if (lowest === null || (bagCount(bags) ?? 0) < (bagCount(lowest) ?? 0)) {
      lowest = bags;
    }
  }
  return lowest;
}

/** The trip type of an offer: one itinerary, a return to the origin (airport or city), or several legs. */
export function tripTypeOf(
  itineraries: ReadonlyArray<{ readonly origin: string; readonly destination: string }>,
  cityOf: (code: string) => string | null,
): TripType {
  if (itineraries.length === 1) {
    return "one_way";
  }
  const [outbound, inbound] = itineraries;
  if (itineraries.length === 2 && outbound !== undefined && inbound !== undefined) {
    const same = (a: string, b: string): boolean =>
      a === b || (cityOf(a) !== null && cityOf(a) === cityOf(b));
    if (same(outbound.origin, inbound.destination) && same(outbound.destination, inbound.origin)) {
      return "round_trip";
    }
  }
  return "multi_city";
}

/** The summary columns of one offer (`flight_offers`), without its id and prices. */
export interface OfferColumns extends Omit<FacetRow, "id" | "sellingTotal"> {
  readonly originIata: string;
  readonly destinationIata: string;
  readonly firstDepartureLocal: string;
  readonly lastArrivalLocal: string;
  readonly validatingCarrier: string | null;
  readonly operatingCarriers: readonly string[];
  readonly cabins: readonly TravelClass[];
  readonly tripType: TripType;
  readonly segmentCount: number;
  /** Traveller counts by Amadeus traveller type. */
  readonly travelers: Readonly<Record<string, number>>;
  readonly bookableSeats: number | null;
  readonly lastTicketingDate: string | null;
  readonly instantTicketingRequired: boolean;
}

/** The summary columns of a parsed offer. `cityOf` maps an airport to its city (Amadeus dictionaries). */
export function offerColumns(offer: ParsedOffer, cityOf: (code: string) => string | null): OfferColumns {
  const segments = offer.itineraries.flatMap((itinerary) => itinerary.segments);
  const legs = offer.itineraries.map((itinerary) => {
    const first = itinerary.segments[0];
    const last = itinerary.segments.at(-1);
    // parseOffer guarantees at least one segment per itinerary.
    return { first: first as ParsedSegment, last: last as ParsedSegment, itinerary };
  });
  const [outbound] = legs;
  const final = legs.at(-1);
  const lead = leadPricing(offer);
  const leadDetails = segments.map((segment) => fareDetailOf(lead, segment.id));
  // The main cabin is the cabin of the longest segment (the first one of equal length).
  let longest: ParsedSegment | undefined;
  for (const segment of segments) {
    if (longest === undefined || (segment.durationMinutes ?? 0) > (longest.durationMinutes ?? 0)) {
      longest = segment;
    }
  }
  const travelers: Record<string, number> = {};
  for (const pricing of offer.travelerPricings) {
    travelers[pricing.travelerType] = (travelers[pricing.travelerType] ?? 0) + 1;
  }
  const validating = offer.validatingAirlineCodes[0];
  return {
    originIata: outbound?.first.departure.iataCode ?? "",
    destinationIata: outbound?.last.arrival.iataCode ?? "",
    firstDepartureLocal: outbound?.first.departure.at ?? "",
    lastArrivalLocal: final?.last.arrival.at ?? "",
    maxStops: Math.max(...legs.map((leg) => leg.itinerary.segments.length - 1)),
    marketingCarriers: distinctSorted(segments.map((segment) => segment.carrierCode)),
    operatingCarriers: distinctSorted(segments.flatMap((segment) => segment.operatingCarrier ?? [])),
    validatingCarrier: validating !== undefined && CARRIER.test(validating) ? validating : null,
    departureMinutes: legs.map((leg) => minutesOfDay(leg.first.departure.at)),
    arrivalMinutes: legs.map((leg) => minutesOfDay(leg.last.arrival.at)),
    durationMinutes: legs.map((leg) => leg.itinerary.durationMinutes),
    totalDurationMinutes: legs.reduce((sum, leg) => sum + leg.itinerary.durationMinutes, 0),
    mainCabin: longest === undefined ? null : (fareDetailOf(lead, longest.id)?.cabin ?? null),
    cabins: TRAVEL_CLASSES.filter((cabin) => leadDetails.some((detail) => detail?.cabin === cabin)),
    minCheckedBags: bagCount(lowestBags(offer, (detail) => detail.checkedBags)),
    refundable: offer.refundable,
    changeable: offer.changeable,
    brandedFares: distinctSorted(leadDetails.flatMap((detail) => detail?.brandedFare ?? [])),
    tripType: tripTypeOf(
      legs.map((leg) => ({ origin: leg.first.departure.iataCode, destination: leg.last.arrival.iataCode })),
      cityOf,
    ),
    segmentCount: segments.length,
    travelers,
    bookableSeats: offer.numberOfBookableSeats,
    lastTicketingDate: offer.lastTicketingDate,
    instantTicketingRequired: offer.instantTicketingRequired,
  };
}

/** The amounts `flight_offers.net_total` (`numeric(12,2)`) holds stay below this. */
const MAX_STORED_AMOUNT = new Money("1e10");

/**
 * The net total the engine prices: Amadeus `grandTotal` in the currency's minor units, or `undefined` if finer,
 * negative or too large for the `numeric(12,2)` columns.
 */
export function netTotalOf(offer: ParsedOffer, minorUnits: number): string | undefined {
  const net = new Money(offer.price.grandTotal);
  return net.decimalPlaces() > minorUnits || net.isNegative() || net.gte(MAX_STORED_AMOUNT)
    ? undefined
    : net.toFixed(minorUnits);
}

/** The facts of one offer for the markup and fee engine (OADR-0005 point 2). */
export function pricingInputOf(
  offer: ParsedOffer,
  columns: OfferColumns,
  context: {
    readonly at: Date;
    readonly minorUnits: number;
    readonly netTotal: string;
    readonly channel: PricingChannel;
    readonly countryOf: (code: string) => string | null;
  },
): PricingInput {
  const segments = offer.itineraries.flatMap((itinerary) => itinerary.segments);
  return {
    at: context.at,
    currency: offer.price.currency,
    minorUnits: context.minorUnits,
    netTotal: context.netTotal,
    origin: columns.originIata,
    destination: columns.destinationIata,
    originCountry: context.countryOf(columns.originIata),
    destinationCountry: context.countryOf(columns.destinationIata),
    validatingCarriers: offer.validatingAirlineCodes,
    marketingCarriers: columns.marketingCarriers,
    cabins: columns.cabins,
    travelers: Object.keys(columns.travelers).length === 0 ? { ADULT: 1 } : columns.travelers,
    segmentCount: Math.max(1, segments.length),
    tripType: columns.tripType,
    source: offer.source,
    channel: context.channel,
  };
}

// ---- Selling amounts -----------------------------------------------------------------------------------------------

/**
 * `total` split over `weights` (in proportion; equally when they are all zero), each share in the currency's minor
 * units, by the largest-remainder method: the shares add up to `total` exactly and have its sign.
 */
export function distribute(
  total: MoneyValue,
  weights: readonly MoneyValue[],
  minorUnits: number,
): MoneyValue[] {
  if (weights.length === 0) {
    return [];
  }
  const unit = new Money(10).pow(-minorUnits);
  const sign = total.isNegative() ? -1 : 1;
  const units = total.abs().div(unit).toDecimalPlaces(0, Money.ROUND_DOWN);
  const positive = weights.map((weight) => (weight.isNegative() ? new Money(0) : weight));
  const sum = positive.reduce((acc, weight) => acc.plus(weight), new Money(0));
  const shares = sum.isZero() ? positive.map(() => new Money(1)) : positive;
  const shareSum = sum.isZero() ? new Money(shares.length) : sum;
  const exact = shares.map((share) => units.times(share).div(shareSum));
  const floors = exact.map((value) => value.toDecimalPlaces(0, Money.ROUND_DOWN));
  // The units the floors leave over (fewer than the number of shares) go to the largest remainders.
  let left = units.minus(floors.reduce((acc, value) => acc.plus(value), new Money(0)));
  const order = exact
    .map((value, index) => ({ index, remainder: value.minus(floors[index] ?? 0) }))
    .sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index);
  const result = [...floors];
  for (const { index } of order) {
    if (left.lte(0)) {
      break;
    }
    result[index] = (result[index] ?? new Money(0)).plus(1);
    left = left.minus(1);
  }
  return result.map((value) => value.times(unit).times(sign));
}

/** The markup share of every traveller pricing, in their order (by net traveller total). */
export function travelerMarkupShares(
  offer: ParsedOffer,
  markup: MoneyValue,
  minorUnits: number,
): MoneyValue[] {
  return distribute(
    markup,
    offer.travelerPricings.map((pricing) => new Money(pricing.total ?? 0)),
    minorUnits,
  );
}

const money = (amount: MoneyValue | string, currency: string, minorUnits: number): MoneyAmount => ({
  amount: new Money(amount).toFixed(minorUnits),
  currency,
});

/** Sum of the Amadeus fees of an offer. */
function feesTotal(price: ParsedPrice): MoneyValue {
  return price.fees.reduce((sum, fee) => sum.plus(fee.amount), new Money(0));
}

/** The selling price of an offer (SellingPrice): the markup folded into the base fare. */
export function sellingPriceOf(
  offer: ParsedOffer,
  stored: { readonly markupAmount: string; readonly sellingTotal: string; readonly currency: string },
  minorUnits: number,
  withBreakdown: boolean,
): SellingPrice {
  const { currency } = stored;
  const markup = new Money(stored.markupAmount);
  const price = offer.price;
  const fees = feesTotal(price);
  const taxes = new Money(price.total).minus(price.base).minus(fees);
  const additional = new Money(price.grandTotal).minus(price.total);
  const shares = travelerMarkupShares(offer, markup, minorUnits);
  const leadIndex = offer.travelerPricings.findIndex((pricing) => ADULT_TYPES.has(pricing.travelerType));
  const lead = offer.travelerPricings[leadIndex];
  const selling: SellingPrice = {
    currency,
    total: money(stored.sellingTotal, currency, minorUnits),
    base: money(new Money(price.base).plus(markup), currency, minorUnits),
    taxes: money(taxes, currency, minorUnits),
    fees: money(fees, currency, minorUnits),
    additionalServices: additional.isZero() ? null : money(additional, currency, minorUnits),
    perAdult:
      lead?.total === null || lead === undefined
        ? null
        : money(new Money(lead.total).plus(shares[leadIndex] ?? 0), currency, minorUnits),
  };
  if (!withBreakdown) {
    return selling;
  }
  const breakdown: PriceBreakdown = {
    travelers: offer.travelerPricings.flatMap((pricing, index) => {
      if (pricing.total === null || pricing.base === null) {
        return [];
      }
      const share = shares[index] ?? new Money(0);
      return [
        {
          travelerId: pricing.travelerId,
          travelerType: pricing.travelerType,
          base: money(new Money(pricing.base).plus(share), currency, minorUnits),
          taxes: money(new Money(pricing.total).minus(pricing.base), currency, minorUnits),
          fees: money("0", currency, minorUnits),
          total: money(new Money(pricing.total).plus(share), currency, minorUnits),
          taxDetails: pricing.taxes.map((tax) => ({
            code: tax.code,
            amount: money(tax.amount, currency, minorUnits),
          })),
        },
      ];
    }),
    fees: price.fees.flatMap((fee) => {
      const type = FEE_TYPES[fee.type];
      return type === undefined || new Money(fee.amount).isZero()
        ? []
        : [{ type, amount: money(fee.amount, currency, minorUnits), description: null }];
    }),
  };
  return { ...selling, breakdown };
}

/** Adds `delta` to a decimal string field of `target` when it holds one, in the currency's minor units. */
function addTo(target: JsonObject, field: string, delta: MoneyValue, minorUnits: number): void {
  const value = decimal(target[field]);
  if (value !== undefined) {
    target[field] = new Money(value).plus(delta).toFixed(minorUnits);
  }
}

/**
 * The Amadeus offer as customer scope sees it: a copy with the markup folded into `price.base`, `total` and
 * `grandTotal` and distributed over the travellers' `price.base` and `total`, without Amadeus `margins`.
 */
export function sellingAmadeusOffer(
  payload: unknown,
  offer: ParsedOffer,
  markupAmount: string,
  minorUnits: number,
): AmadeusFlightOffer {
  const copy = structuredClone(payload) as JsonObject;
  const markup = new Money(markupAmount);
  const price = copy["price"];
  if (isRecord(price)) {
    for (const field of ["base", "total", "grandTotal"]) {
      addTo(price, field, markup, minorUnits);
    }
    delete price["margins"];
  }
  const shares = travelerMarkupShares(offer, markup, minorUnits);
  const pricings = Array.isArray(copy["travelerPricings"]) ? copy["travelerPricings"] : [];
  // parseOffer keeps the traveller pricings it can read, in order: match them by traveller id.
  offer.travelerPricings.forEach((parsed, index) => {
    const raw = pricings.find(
      (candidate): candidate is JsonObject =>
        isRecord(candidate) && candidate["travelerId"] === parsed.travelerId,
    );
    const travelerPrice = raw?.["price"];
    if (isRecord(travelerPrice)) {
      addTo(travelerPrice, "base", shares[index] ?? new Money(0), minorUnits);
      addTo(travelerPrice, "total", shares[index] ?? new Money(0), minorUnits);
      delete travelerPrice["margins"];
    }
  });
  return copy as AmadeusFlightOffer;
}

// ---- Display data --------------------------------------------------------------------------------------------------

/** What the response knows of a location (reference schema, else the Amadeus dictionaries). */
export interface LocationInfo {
  readonly cityCode: string | null;
  readonly countryCode: string | null;
  readonly airportName: string | null;
  readonly cityName: string | null;
  readonly countryName: string | null;
  readonly timeZone: string | null;
}

/** Display names for the codes of a response. */
export interface DisplayNames {
  location(code: string): LocationInfo | undefined;
  carrierName(code: string): string | null;
  aircraftName(code: string): string | null;
}

/** Every location, carrier and aircraft code of an offer, for the dictionary lookups. */
export function codesOf(offer: ParsedOffer): {
  locations: string[];
  carriers: string[];
  aircraft: string[];
} {
  const segments = offer.itineraries.flatMap((itinerary) => itinerary.segments);
  return {
    locations: distinctSorted(
      segments.flatMap((segment) => [segment.departure.iataCode, segment.arrival.iataCode]),
    ),
    carriers: distinctSorted([
      ...segments.flatMap((segment) => [
        segment.carrierCode,
        ...(segment.operatingCarrier === null ? [] : [segment.operatingCarrier]),
      ]),
      ...offer.validatingAirlineCodes,
    ]),
    aircraft: distinctSorted(segments.flatMap((segment) => segment.aircraft ?? [])),
  };
}

function endpoint(point: ParsedEndpoint, names: DisplayNames): SegmentEndpoint {
  const location = names.location(point.iataCode);
  return {
    iataCode: point.iataCode,
    terminal: point.terminal,
    at: point.at,
    cityCode: location?.cityCode ?? null,
    countryCode: location?.countryCode ?? null,
    airportName: location?.airportName ?? null,
    cityName: location?.cityName ?? null,
  };
}

function bags(value: ParsedBags | null): BagAllowance | null {
  return value === null
    ? null
    : { quantity: value.quantity, weight: value.weight, weightUnit: value.weightUnit };
}

type Co2Emission = NonNullable<Segment["co2Emissions"]>[number];

function co2(values: readonly JsonObject[]): Co2Emission[] {
  return values.flatMap((value) => {
    const weight = integer(value["weight"]);
    if (weight === undefined) {
      return [];
    }
    const emission: Co2Emission = { weight };
    const weightUnit = text(value["weightUnit"]);
    if (weightUnit !== undefined) {
      emission.weightUnit = weightUnit;
    }
    const cabin = value["cabin"];
    if (oneOf(cabin, TRAVEL_CLASSES)) {
      emission.cabin = cabin;
    }
    return [emission];
  });
}

function segmentOf(
  segment: ParsedSegment,
  next: ParsedSegment | undefined,
  lead: ParsedTravelerPricing | undefined,
  names: DisplayNames,
): Segment {
  const fare = fareDetailOf(lead, segment.id);
  const layoverMinutes =
    next === undefined
      ? 0
      : Math.max(0, localEpochMinutes(next.departure.at) - localEpochMinutes(segment.arrival.at));
  return {
    id: segment.id,
    departure: endpoint(segment.departure, names),
    arrival: endpoint(segment.arrival, names),
    carrierCode: segment.carrierCode,
    carrierName: names.carrierName(segment.carrierCode),
    number: segment.number,
    flightNumber: `${segment.carrierCode}${segment.number}`,
    operating:
      segment.operatingCarrier === null
        ? null
        : { carrierCode: segment.operatingCarrier, carrierName: names.carrierName(segment.operatingCarrier) },
    aircraft:
      segment.aircraft === null
        ? null
        : { code: segment.aircraft, name: names.aircraftName(segment.aircraft) },
    duration: segment.duration,
    durationMinutes: segment.durationMinutes,
    numberOfStops: segment.numberOfStops,
    stops: segment.stops.flatMap((stop) => {
      const iataCode = text(stop["iataCode"]);
      return iataCode === undefined
        ? []
        : [
            {
              iataCode,
              duration: text(stop["duration"]) ?? null,
              arrivalAt: localDateTime(stop["arrivalAt"]) ?? null,
              departureAt: localDateTime(stop["departureAt"]) ?? null,
            },
          ];
    }),
    co2Emissions: co2(segment.co2Emissions),
    ...(segment.blacklistedInEU === undefined ? {} : { blacklistedInEU: segment.blacklistedInEU }),
    cabin: fare?.cabin ?? null,
    bookingClass: fare?.bookingClass ?? null,
    brandedFare: fare?.brandedFare ?? null,
    brandedFareLabel: fare?.brandedFareLabel ?? null,
    layoverAfter:
      next === undefined
        ? null
        : {
            duration: isoDuration(layoverMinutes),
            durationMinutes: layoverMinutes,
            airportChange: next.departure.iataCode !== segment.arrival.iataCode,
            overnight: next.departure.at.slice(0, 10) !== segment.arrival.at.slice(0, 10),
            nextDepartureCode: next.departure.iataCode,
          },
  };
}

function itineraryOf(
  itinerary: ParsedItinerary,
  index: number,
  lead: ParsedTravelerPricing | undefined,
  names: DisplayNames,
): Itinerary {
  const segments = itinerary.segments;
  const first = segments[0] as ParsedSegment;
  const last = segments.at(-1) as ParsedSegment;
  return {
    index,
    originCode: first.departure.iataCode,
    destinationCode: last.arrival.iataCode,
    departureAt: first.departure.at,
    arrivalAt: last.arrival.at,
    duration: itinerary.duration,
    durationMinutes: itinerary.durationMinutes,
    stops: segments.length - 1,
    stopAirports: segments.slice(0, -1).map((segment) => segment.arrival.iataCode),
    arrivalDayOffset: Math.max(0, dayDifference(first.departure.at, last.arrival.at)),
    marketingCarriers: distinctSorted(segments.map((segment) => segment.carrierCode)),
    segments: segments.map((segment, position) => segmentOf(segment, segments[position + 1], lead, names)),
  };
}

function fareDetail(detail: ParsedFareDetail): SegmentFareDetail {
  return {
    segmentId: detail.segmentId,
    cabin: detail.cabin,
    fareBasis: detail.fareBasis,
    brandedFare: detail.brandedFare,
    brandedFareLabel: detail.brandedFareLabel,
    class: detail.bookingClass,
    ...(detail.isAllotment === undefined ? {} : { isAllotment: detail.isAllotment }),
    includedCheckedBags: bags(detail.checkedBags),
    includedCabinBags: bags(detail.cabinBags),
    amenities: detail.amenities.flatMap((amenity) => {
      const description = text(amenity["description"]);
      if (description === undefined) {
        return [];
      }
      const amenityType = amenity["amenityType"];
      const provider = isRecord(amenity["amenityProvider"])
        ? text(amenity["amenityProvider"]["name"])
        : undefined;
      return [
        {
          code: text(amenity["code"]) ?? null,
          description,
          amenityType: oneOf(amenityType, AMENITY_TYPES) ? amenityType : null,
          status: amenity["isChargeable"] === true ? ("chargeable" as const) : ("included" as const),
          provider: provider ?? null,
        },
      ];
    }),
  };
}

function travelerPricingOf(pricing: ParsedTravelerPricing): OfferTravelerPricing[] {
  if (!oneOf(pricing.fareOption, FARE_OPTIONS)) {
    return [];
  }
  return [
    {
      travelerId: pricing.travelerId,
      travelerType: pricing.travelerType,
      fareOption: pricing.fareOption,
      associatedAdultId: pricing.associatedAdultId,
      segments: pricing.fareDetails.map(fareDetail),
    },
  ];
}

/** The summary of an offer (OfferSummary) from its parsed payload and summary columns. */
export function offerSummaryOf(
  offer: ParsedOffer,
  columns: OfferColumns,
  tags: NonNullable<OfferSummary["tags"]>,
): OfferSummary {
  const lead = leadPricing(offer);
  const co2Total = offer.itineraries
    .flatMap((itinerary) => itinerary.segments)
    .map((segment) => co2(segment.co2Emissions)?.[0]?.weight);
  const last = offer.itineraries.at(-1)?.segments[0];
  return {
    tripType: columns.tripType,
    originCode: columns.originIata,
    destinationCode: columns.destinationIata,
    departureAt: columns.firstDepartureLocal,
    returnAt: offer.itineraries.length > 1 && last !== undefined ? last.departure.at : null,
    totalDurationMinutes: columns.totalDurationMinutes,
    maxStops: columns.maxStops,
    marketingCarriers: [...columns.marketingCarriers],
    operatingCarriers: [...columns.operatingCarriers],
    validatingCarrier: columns.validatingCarrier,
    cabins: [...columns.cabins],
    brandedFares: offer.itineraries.flatMap((itinerary, index) => {
      const first = itinerary.segments[0];
      const fare = first === undefined ? undefined : fareDetailOf(lead, first.id);
      return fare?.brandedFare === null || fare === undefined
        ? []
        : [{ itineraryIndex: index, code: fare.brandedFare, label: fare.brandedFareLabel }];
    }),
    includedCheckedBags: bags(lowestBags(offer, (detail) => detail.checkedBags)),
    includedCabinBags: bags(lowestBags(offer, (detail) => detail.cabinBags)),
    refundable: columns.refundable,
    changeable: columns.changeable,
    co2Kg: co2Total.every((weight) => weight !== undefined)
      ? co2Total.reduce<number>((sum, weight) => sum + (weight ?? 0), 0)
      : null,
    numberOfBookableSeats: columns.bookableSeats,
    lastTicketingDate: columns.lastTicketingDate,
    tags,
  };
}

/** A stored `flight_offers` row as the mapper reads it. */
export interface StoredOffer {
  readonly id: string;
  readonly searchId: string;
  readonly source: string;
  readonly payload: unknown;
  readonly currency: string;
  readonly netTotal: string;
  readonly markupAmount: string;
  readonly sellingTotal: string;
  readonly markupRuleId: string | null;
  readonly markupRuleName: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface OfferMappingContext {
  readonly scope: OfferScope;
  readonly view: OfferView;
  readonly now: Date;
  readonly minorUnits: number;
  readonly highlights: FlightSearchHighlights | null;
  /** Amadeus offer id → `off_…` id of the same search (upsellFlightOfferIds). */
  readonly offerIds: ReadonlyMap<string, string>;
  readonly names: DisplayNames;
  /** Airport → city (Amadeus dictionaries), for the trip type. */
  readonly cityOf: (code: string) => string | null;
}

/** A stored offer as FlightOffer, or `undefined` when its payload cannot be read (it is then left out). */
export function toFlightOffer(row: StoredOffer, context: OfferMappingContext): FlightOffer | undefined {
  const offer = parseOffer(row.payload);
  if (offer === undefined) {
    return undefined;
  }
  const columns = offerColumns(offer, context.cityOf);
  const full = context.view === "full";
  const lead = leadPricing(offer);
  const result: FlightOffer = {
    id: row.id,
    searchId: row.searchId,
    origin: "search",
    baseOfferId: null,
    upsellId: null,
    status: row.expiresAt.getTime() <= context.now.getTime() ? "expired" : "active",
    source: offer.source,
    expiresAt: row.expiresAt.toISOString(),
    price: sellingPriceOf(offer, row, context.minorUnits, full),
    summary: offerSummaryOf(offer, columns, tagsOf(row.id, context.highlights)),
    itineraries: offer.itineraries.map((itinerary, index) =>
      itineraryOf(itinerary, index, lead, context.names),
    ),
    validatingAirlineCodes: offer.validatingAirlineCodes.filter((code) => CARRIER.test(code)),
    lastTicketingDate: offer.lastTicketingDate,
    lastTicketingDateTime: offer.lastTicketingDateTime,
    numberOfBookableSeats: offer.numberOfBookableSeats,
    instantTicketingRequired: offer.instantTicketingRequired,
    ...(offer.paymentCardRequired === undefined ? {} : { paymentCardRequired: offer.paymentCardRequired }),
    ...(offer.oneWay === undefined ? {} : { oneWay: offer.oneWay }),
    ...(offer.isUpsellOffer === undefined ? {} : { isUpsellOffer: offer.isUpsellOffer }),
    upsellOfferIds: offer.upsellFlightOfferIds.flatMap((id) => context.offerIds.get(id) ?? []),
    createdAt: row.createdAt.toISOString(),
  };
  if (full) {
    result.travelerPricings = offer.travelerPricings.flatMap(travelerPricingOf);
    result.amadeus =
      context.scope === "console"
        ? (row.payload as AmadeusFlightOffer)
        : sellingAmadeusOffer(row.payload, offer, row.markupAmount, context.minorUnits);
  }
  if (context.scope === "console") {
    result.netPrice = money(row.netTotal, row.currency, context.minorUnits);
    result.markup = {
      amount: money(row.markupAmount, row.currency, context.minorUnits),
      ruleId: row.markupRuleId,
      ruleName: row.markupRuleName,
      serviceFee: null,
    };
  }
  return result;
}

// ---- Search requests -----------------------------------------------------------------------------------------------

/** The storefront's search defaults (`storefront_settings.search_defaults`), as far as they are well-formed. */
export interface SearchDefaults {
  /** The storefront limit of `max` / `maxFlightOffers` (1–250); 250 when not set. */
  readonly maxResults: number;
  /** `nonStop` of a SIMPLE search that does not send it. */
  readonly nonStop?: boolean | undefined;
  /** `travelClass` of a SIMPLE search that does not send it. */
  readonly cabin?: TravelClass | undefined;
  /** The sources an ADVANCED search may use; any when not set. */
  readonly sources?: readonly OfferSource[] | undefined;
}

/** The most offers a search stores (OADR-0002 point 1, `maxFlightOffers` ≤ 250). */
export const MAX_OFFERS_PER_SEARCH = 250;

/**
 * `search_defaults` read leniently: `{ maxResults, nonStop, cabin, sources }` (the column's "max results, nonStop,
 * cabin, sources"); a key with a value of the wrong type is ignored.
 */
export function parseSearchDefaults(value: unknown): SearchDefaults {
  const raw = isRecord(value) ? value : {};
  const max = integer(raw["maxResults"]);
  const cabin = raw["cabin"];
  const sources = strings(raw["sources"]).filter((source): source is OfferSource =>
    oneOf(source, OFFER_SOURCES),
  );
  return {
    maxResults: max !== undefined && max >= 1 && max <= MAX_OFFERS_PER_SEARCH ? max : MAX_OFFERS_PER_SEARCH,
    nonStop: flag(raw["nonStop"]),
    cabin: oneOf(cabin, TRAVEL_CLASSES) ? cabin : undefined,
    sources: Array.isArray(raw["sources"]) && sources.length > 0 ? sources : undefined,
  };
}

/** The Amadeus request of a search: the GET query (SIMPLE) or the POST body (ADVANCED), defaults applied. */
export type AmadeusSearchRequest =
  | {
      readonly operationId: "getFlightOffers";
      readonly query: Readonly<Record<string, string | number | boolean>>;
    }
  | { readonly operationId: "searchFlightOffers"; readonly body: FlightSearchAdvancedQuery };

/** Why a search request cannot be sent, as a field error of the body (pointer into the request body). */
export interface SearchRequestProblem {
  readonly path: string;
  readonly code: string;
  readonly message: string;
  /** `403 FEATURE_DISABLED` (no allowed source) or `403 SCOPE_NOT_ALLOWED` (negotiated fares) instead of a 400. */
  readonly kind: "validation" | "sources" | "negotiated";
}

/** The most travellers older than two years one search may hold (Amadeus; SIMPLE `adults + children`). */
const MAX_SEATED_TRAVELERS = 9;

/** The fare types and codes a customer-scope ADVANCED search may not send (negotiated fares are not enabled). */
const NEGOTIATED_FARE_TYPES: ReadonlySet<string> = new Set(["NEGOTIATED", "CORPORATE"]);

/**
 * The Amadeus request of `request` in `currency`, or the first problem: SIMPLE checks the traveller counts, the
 * airline lists and the dates; ADVANCED fills `currencyCode`, intersects `sources` with the storefront's, caps
 * `maxFlightOffers` and defaults the three `additionalInformation` flags to `true`; customer scope may not send
 * corporate codes or negotiated fare types.
 */
export function buildAmadeusSearch(
  request: FlightSearchCreateRequest,
  currency: string,
  defaults: SearchDefaults,
  scope: OfferScope,
): AmadeusSearchRequest | SearchRequestProblem {
  if (request.mode === "simple") {
    return simpleQuery(request, currency, defaults);
  }
  return advancedBody(request.query, currency, defaults, scope);
}

function problem(path: string, code: string, message: string): SearchRequestProblem {
  return { path, code, message, kind: "validation" };
}

function simpleQuery(
  request: FlightSearchSimpleRequest,
  currency: string,
  defaults: SearchDefaults,
): AmadeusSearchRequest | SearchRequestProblem {
  const children = request.children ?? 0;
  const infants = request.infants ?? 0;
  if (request.adults + children > MAX_SEATED_TRAVELERS) {
    return problem("/children", "range", "Adults and children together may be at most 9.");
  }
  if (infants > request.adults) {
    return problem(
      "/infants",
      "range",
      "Each infant travels on the lap of an adult: no more infants than adults.",
    );
  }
  if (request.includedAirlineCodes !== undefined && request.excludedAirlineCodes !== undefined) {
    return problem(
      "/excludedAirlineCodes",
      "conflict",
      "includedAirlineCodes and excludedAirlineCodes cannot be combined.",
    );
  }
  if (request.returnDate !== undefined && request.returnDate < request.departureDate) {
    return problem("/returnDate", "range", "The return date must be on or after the departure date.");
  }
  const query: Record<string, string | number | boolean> = {
    originLocationCode: request.originLocationCode,
    destinationLocationCode: request.destinationLocationCode,
    departureDate: request.departureDate,
    adults: request.adults,
  };
  if (request.returnDate !== undefined) {
    query["returnDate"] = request.returnDate;
  }
  if (children > 0) {
    query["children"] = children;
  }
  if (infants > 0) {
    query["infants"] = infants;
  }
  const travelClass = request.travelClass ?? defaults.cabin;
  if (travelClass !== undefined) {
    query["travelClass"] = travelClass;
  }
  if (request.includedAirlineCodes !== undefined) {
    query["includedAirlineCodes"] = request.includedAirlineCodes.join(",");
  }
  if (request.excludedAirlineCodes !== undefined) {
    query["excludedAirlineCodes"] = request.excludedAirlineCodes.join(",");
  }
  const nonStop = request.nonStop ?? defaults.nonStop;
  if (nonStop !== undefined) {
    query["nonStop"] = nonStop;
  }
  query["currencyCode"] = currency;
  if (request.maxPrice !== undefined) {
    query["maxPrice"] = request.maxPrice;
  }
  query["max"] = Math.min(request.max ?? defaults.maxResults, defaults.maxResults);
  return { operationId: "getFlightOffers", query };
}

function advancedBody(
  query: FlightSearchAdvancedQuery,
  currency: string,
  defaults: SearchDefaults,
  scope: OfferScope,
): AmadeusSearchRequest | SearchRequestProblem {
  for (const [index, od] of query.originDestinations.entries()) {
    const date = od.departureDateTimeRange?.date ?? od.arrivalDateTimeRange?.date;
    for (const field of ["originLocationCode", "destinationLocationCode"] as const) {
      const code = od[field];
      if (code === undefined || !IATA_LOCATION.test(code)) {
        return problem(`/query/originDestinations/${index}/${field}`, "required", `${field} is required.`);
      }
    }
    if (date === undefined) {
      return problem(
        `/query/originDestinations/${index}/departureDateTimeRange`,
        "required",
        "Each origin and destination needs a departure (or arrival) date.",
      );
    }
  }
  // Amadeus: at most 9 travellers older than two, and one infant per adult (the 18 of `maxItems`). The search row's
  // traveller counts (`smallint`, 0–9 each) hold every request that passes.
  const infants = query.travelers.filter((traveler) => INFANT_TYPES.has(traveler.travelerType)).length;
  const adults = query.travelers.filter((traveler) => ADULT_TYPES.has(traveler.travelerType)).length;
  if (query.travelers.length - infants > MAX_SEATED_TRAVELERS) {
    return problem("/query/travelers", "range", "At most 9 travellers older than two years.");
  }
  if (infants > adults) {
    return problem(
      "/query/travelers",
      "range",
      "Each infant travels with an adult: no more infants than adults.",
    );
  }
  const criteria = query.searchCriteria ?? {};
  const pricing = criteria.pricingOptions;
  if (
    scope === "customer" &&
    ((pricing?.corporateCodes?.length ?? 0) > 0 ||
      (pricing?.fareType ?? []).some((type) => NEGOTIATED_FARE_TYPES.has(type)))
  ) {
    return {
      path: "/query/searchCriteria/pricingOptions",
      code: "not_allowed",
      message: "Negotiated and corporate fares are not enabled for this storefront.",
      kind: "negotiated",
    };
  }
  const allowed = defaults.sources;
  const sources =
    allowed === undefined ? query.sources : query.sources.filter((source) => allowed.includes(source));
  if (sources.length === 0) {
    return {
      path: "/query/sources",
      code: "not_allowed",
      message: "None of the requested sources is enabled.",
      kind: "sources",
    };
  }
  const information = criteria.additionalInformation ?? {};
  return {
    operationId: "searchFlightOffers",
    body: {
      ...query,
      currencyCode: query.currencyCode ?? currency,
      sources,
      searchCriteria: {
        ...criteria,
        maxFlightOffers: Math.min(criteria.maxFlightOffers ?? defaults.maxResults, defaults.maxResults),
        additionalInformation: {
          ...information,
          brandedFares: information.brandedFares ?? true,
          chargeableCheckedBags: information.chargeableCheckedBags ?? true,
          fareRules: information.fareRules ?? true,
        },
      },
    },
  };
}

/** The request without `resultOptions` (FlightSearchCriteria.request: "re-submit it to search again"). */
export function criteriaRequestOf(request: FlightSearchCreateRequest): FlightSearchCreateRequest {
  if (request.mode === "simple") {
    const { resultOptions: _resultOptions, ...simple } = request;
    return simple;
  }
  const { resultOptions: _resultOptions, ...advanced } = request;
  return advanced;
}

/** The currency a request asks for in its body, if any. */
export function requestedCurrencyOf(request: FlightSearchCreateRequest): string | undefined {
  return request.mode === "simple" ? request.currencyCode : request.query.currencyCode;
}

/** FlightSearchCriteria of a stored search: the request as received and what was sent to Amadeus. */
export function searchCriteriaOf(
  request: FlightSearchCreateRequest,
  amadeus: AmadeusSearchRequest,
): FlightSearchCriteria {
  return {
    mode: request.mode,
    request: criteriaRequestOf(request),
    amadeusOperationId: amadeus.operationId,
    amadeusQuery:
      amadeus.operationId === "getFlightOffers"
        ? Object.fromEntries(Object.entries(amadeus.query).map(([key, value]) => [key, String(value)]))
        : null,
    amadeusBody: amadeus.operationId === "searchFlightOffers" ? amadeus.body : null,
  };
}

/** The normalised trip of a search (FlightSearchSummary) from its request. */
export function searchSummaryOf(request: FlightSearchCreateRequest): FlightSearchSummary {
  if (request.mode === "simple") {
    const legs = [
      {
        originDestinationId: "1",
        originCode: request.originLocationCode,
        destinationCode: request.destinationLocationCode,
        departureDate: request.departureDate,
      },
    ];
    if (request.returnDate !== undefined) {
      legs.push({
        originDestinationId: "2",
        originCode: request.destinationLocationCode,
        destinationCode: request.originLocationCode,
        departureDate: request.returnDate,
      });
    }
    const children = request.children ?? 0;
    const infants = request.infants ?? 0;
    return {
      tripType: request.returnDate === undefined ? "one_way" : "round_trip",
      legs,
      travelers: { adults: request.adults, children, infants, total: request.adults + children + infants },
      travelClass: request.travelClass ?? null,
      nonStop: request.nonStop ?? false,
    };
  }
  const query = request.query;
  const legs = query.originDestinations.map((od, index) => ({
    originDestinationId: od.id ?? String(index + 1),
    originCode: od.originLocationCode ?? "",
    destinationCode: od.destinationLocationCode ?? "",
    departureDate: od.departureDateTimeRange?.date ?? od.arrivalDateTimeRange?.date ?? "",
  }));
  const count = (types: ReadonlySet<string>): number =>
    query.travelers.filter((traveler) => types.has(traveler.travelerType)).length;
  const adults = count(ADULT_TYPES);
  const infants = count(INFANT_TYPES);
  const children = query.travelers.length - adults - infants;
  const filters = query.searchCriteria?.flightFilters;
  const allLegs = new Set(legs.map((leg) => leg.originDestinationId));
  const covering = (filters?.cabinRestrictions ?? []).find(
    (restriction) =>
      restriction.cabin !== undefined &&
      (restriction.originDestinationIds === undefined ||
        [...allLegs].every((id) => restriction.originDestinationIds?.includes(id))),
  );
  return {
    tripType: tripTypeOf(
      legs.map((leg) => ({ origin: leg.originCode, destination: leg.destinationCode })),
      () => null,
    ),
    legs,
    travelers: { adults, children, infants, total: query.travelers.length },
    travelClass: covering?.cabin ?? null,
    nonStop: filters?.connectionRestriction?.maxNumberOfConnections === 0,
  };
}
