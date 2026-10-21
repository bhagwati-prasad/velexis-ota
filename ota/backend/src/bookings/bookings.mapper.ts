// Rows → the customer bookings answers of the OTA document (OBE-046; ota/docs/flows/my-bookings-and-guest-lookup.md
// §3 steps 4–5, db README §10 "My trips"): BookingSummary (bookings.list), Booking (bookings.get, built on
// order-recorder.ts `toBooking`), BookingTicketingStatus, BookingEvent and BookingFareRules, all in customer scope:
//
//   - amounts are selling amounts; net prices, markups, offices and staff data never appear;
//   - `amadeus.order` is the stored snapshot rewritten for the customer (`customerOrderOf`): the shared redactor again
//     (document, discount card and certificate numbers to their last 4, card data removed), the markup folded into the
//     offers' and travellers' prices as the priced offers do (`sellingAmadeusOffer`), forms of payment reduced to
//     their type and brand, `queuingOfficeId`, `ownerOfficeId`, `automatedProcess` and `commissions` removed, remarks
//     other than the customer's own requests removed, `refundingPreview` (net) removed from fare rules, and form of
//     identification numbers cut to their last 4. A snapshot whose offers cannot be read is not shown at all
//     (`amadeus: null`): an offer whose markup cannot be folded in would show a net price;
//   - `amadeus.included` (extra bag options at net prices) is never shown: post-booking extras are deferred; of the
//     dictionaries only `carriers` and `aircraft` (`dictionariesOf`);
//   - events show their actor's type, never its id, and their `data` through the shared redactor;
//   - fare rules show the rules, never the net `refundingPreview` nor an estimate derived from it alone (a fully
//     refundable fare's preview is the net price): `refundEstimate` is null until the cancellation quote (OBE-049).
//
// Lists use keyset cursors (`encodeListCursor`): the sort key of the last row in UTC with microseconds, its id, and a
// fingerprint of the filters and sort, so a cursor of other filters is refused (`400 VALIDATION_FAILED`).
import { createHash } from "node:crypto";
import type { components } from "@velexis/api-types";
import { redactPayload } from "@velexis/logger";
import { Money, type MoneyValue } from "../pricing/pricing.types";
import { invalidCursor } from "../reference/reference.mapper";
import { distribute, parseOffer, sellingAmadeusOffer, type ParsedOffer } from "../shopping/offers.mapper";
import { fareRuleSummaryOf } from "../shopping/priced-offers.mapper";
import type {
  BookingAncillaryRow,
  BookingDocumentRow,
  BookingEventRow,
  BookingListRow,
  BookingRefundRow,
  BookingRow,
  BookingTicketRow,
  BookingTravelerRow,
  SummarySegmentRow,
} from "./bookings.repository";
import {
  ticketingMessageOf,
  toBooking,
  type Booking,
  type BookingViewInput,
  type OrderRecord,
  type Warning,
} from "./order-recorder";

type Schemas = components["schemas"];
export type BookingSummary = Schemas["BookingSummary"];
export type BookingSummaryLeg = Schemas["BookingSummaryLeg"];
export type BookingEvent = Schemas["BookingEvent"];
export type BookingTicketingStatus = Schemas["BookingTicketingStatus"];
export type BookingFareRules = Schemas["BookingFareRules"];
export type BookingFareRule = Schemas["BookingFareRule"];
export type BookingAmadeus = Schemas["BookingAmadeus"];
export type FareRuleSummary = Schemas["FareRuleSummary"];
export type PageInfo = Schemas["PageInfo"];
type BookingAncillary = Schemas["BookingAncillary"];
type Refund = Schemas["Refund"];
type BookingDocument = Schemas["Document"];
type Cancellation = Schemas["Cancellation"];
type Ticket = Schemas["Ticket"];
type MoneyAmount = Schemas["Money"];
type AllowedActions = Schemas["BookingAllowedActions"];

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** `Cache-Control` of bookings.list, get, listEvents and getFareRules (personal data). */
export const BOOKING_CACHE_CONTROL = "private, no-store";

/** `Cache-Control` of bookings.getTicketingStatus. */
export const TICKETING_CACHE_CONTROL = "no-store";

/** The booking ETag: `"<version>"` (If-Match of bookings.update and bookings.cancel). */
export const bookingEtagOf = (version: number): string => `"${version}"`;

/** How long a synchronisation counts as fresh (Booking.syncStatus `fresh`, the background sync's period). */
export const FRESH_SYNC_MS = 6 * 60 * 60_000;

/** How long fare rules loaded from Amadeus are served from `bookings.order_included` (getFareRules). */
export const FARE_RULES_CACHE_MS = 60 * 60_000;

/** The polling interval while a booking's ticketing runs, and while its create-order outcome is unknown. */
export const POLL_AFTER_SECONDS = 5;
export const UNKNOWN_OUTCOME_POLL_AFTER_SECONDS = 10;

/** The fare-rule eligibility types (`fareRules` / `types`). */
export type FareRuleType = "rebooks" | "refunds";
export const FARE_RULE_TYPES: readonly FareRuleType[] = ["rebooks", "refunds"];

const money = (amount: MoneyValue | string, currency: string, minorUnits: number): MoneyAmount => ({
  amount: new Money(amount).toFixed(minorUnits),
  currency,
});

// ---- Cursors -------------------------------------------------------------------------------------------------------

/** Where the next page starts: after the row with this sort key (UTC, microseconds) and id, under one fingerprint. */
export interface ListCursor {
  readonly fingerprint: string;
  readonly key: string;
  readonly id: string;
}

const CURSOR_VERSION = 1;
const CURSOR_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const CURSOR_ID = /^(?:bkg|evt)_[0-9A-Za-z]{16,40}$/;
const MAX_CURSOR_LENGTH = 400;

/** The fingerprint of a list's filters and sort: a cursor is valid only for the list it was issued for. */
export function listFingerprint(parts: Readonly<Record<string, string | undefined>>): string {
  const canonical = JSON.stringify(
    Object.entries(parts)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}

/** The opaque cursor of `cursor` (base64url JSON). */
export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, cursor.fingerprint, cursor.key, cursor.id])).toString(
    "base64url",
  );
}

/**
 * The keyset position of `value` for the list of `fingerprint`; `400 VALIDATION_FAILED` (`/query/cursor`) for a value
 * this API did not write or a cursor of other filters.
 */
export function decodeListCursor(value: string, fingerprint: string): ListCursor {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw invalidCursor();
  }
  const [version, print, key, id] = parsed as unknown[];
  if (
    version !== CURSOR_VERSION ||
    print !== fingerprint ||
    typeof key !== "string" ||
    !CURSOR_KEY.test(key) ||
    typeof id !== "string" ||
    !CURSOR_ID.test(id)
  ) {
    throw invalidCursor();
  }
  return { fingerprint, key, id };
}

/** A page of `rows` read with one extra row: the page, and the cursor after its last row when there is more. */
export function pageOf<R extends { readonly id: string; readonly sortKey: string }>(
  rows: readonly R[],
  limit: number,
  fingerprint: string,
): { readonly rows: readonly R[]; readonly page: PageInfo } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    page: {
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeListCursor({ fingerprint, key: last.sortKey, id: last.id })
          : null,
      limit,
    },
  };
}

// ---- bookings.list -------------------------------------------------------------------------------------------------

/** The "My trips" tab of a booking at `now` (BookingSummary.timeframe; db README §10). */
export function timeframeOf(status: string, lastArrivalAt: Date, now: Date): BookingSummary["timeframe"] {
  if (status === "cancelled") {
    return "cancelled";
  }
  return lastArrivalAt.getTime() >= now.getTime() ? "upcoming" : "past";
}

/** The bounds of a list card from its segments (in bound and segment order). */
export function legsOf(segments: readonly SummarySegmentRow[]): BookingSummaryLeg[] {
  const byIndex = new Map<number, SummarySegmentRow[]>();
  for (const segment of segments) {
    byIndex.set(segment.itineraryIndex, [...(byIndex.get(segment.itineraryIndex) ?? []), segment]);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, bound]) => {
      const first = bound[0];
      const last = bound.at(-1);
      if (first === undefined || last === undefined) {
        return [];
      }
      return [
        {
          originCode: first.departureIata,
          destinationCode: last.arrivalIata,
          departureAt: first.departureLocal,
          arrivalAt: last.arrivalLocal,
          stops: bound.length - 1,
          carrierCodes: [...new Set(bound.map((segment) => segment.carrierCode))],
        },
      ];
    });
}

/** What a list card is built from. */
export interface SummaryInput {
  readonly row: BookingListRow;
  readonly segments: readonly SummarySegmentRow[];
  readonly lead: { readonly firstName: string; readonly lastName: string } | undefined;
  readonly cityName: string | undefined;
  readonly minorUnits: number;
  readonly now: Date;
}

/** A booking of bookings.list (BookingSummary). */
export function toBookingSummary(input: SummaryInput): BookingSummary {
  const { row } = input;
  const legs = legsOf(input.segments);
  const firstLeg = legs[0];
  const lastLeg = legs.at(-1);
  const origin = row.originIata ?? firstLeg?.originCode ?? "";
  const destination = row.destinationIata ?? firstLeg?.destinationCode ?? "";
  return {
    id: row.id,
    reference: row.reference,
    status: row.status as BookingSummary["status"],
    timeframe: timeframeOf(row.status, row.lastArrivalAt, input.now),
    recordLocator: row.recordLocator,
    tripType: (row.tripType ?? "one_way") as BookingSummary["tripType"],
    originCode: origin,
    destinationCode: destination,
    destinationCityName: input.cityName ?? null,
    departureAt: firstLeg?.departureAt ?? row.firstDepartureLocal,
    returnAt: legs.length > 1 && lastLeg !== undefined ? lastLeg.departureAt : null,
    legs,
    travelersCount: row.travelersCount,
    leadTravelerName:
      input.lead === undefined ? row.leadLastName : `${input.lead.firstName} ${input.lead.lastName}`.trim(),
    total: money(row.totalAmount, row.currency, input.minorUnits),
    ticketingStatus: row.ticketingStatus as BookingSummary["ticketingStatus"],
    hasScheduleChange: row.hasScheduleChange,
    createdAt: row.createdAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

// ---- The Amadeus order in customer scope ---------------------------------------------------------------------------

/** What the customer view of the stored order needs. */
export interface CustomerOrderInput {
  /** `bookings.order_snapshot` (the order's `data`, stored after the shared redactor). */
  readonly snapshot: unknown;
  readonly dictionaries: unknown;
  /** `bookings.markup_amount`, folded into the offers' prices. */
  readonly markupAmount: string;
  readonly minorUnits: number;
  /** The texts of the customer-visible remarks (`booking_remarks.visible_to_customer`), as sent to Amadeus. */
  readonly visibleRemarks: readonly string[];
}

/** A form of payment reduced to its type and brand (and the offers it pays). */
function redactedFormOfPayment(entry: JsonObject): JsonObject | undefined {
  for (const kind of ["creditCard", "other", "b2bWallet"] as const) {
    const value = entry[kind];
    if (!isRecord(value)) {
      continue;
    }
    const offerIds = strings(value["flightOfferIds"]);
    const kept: JsonObject = {};
    if (kind === "creditCard" && text(value["brand"]) !== undefined) {
      kept["brand"] = value["brand"];
    }
    if (kind === "other" && text(value["method"]) !== undefined) {
      kept["method"] = value["method"];
    }
    if (offerIds.length > 0) {
      kept["flightOfferIds"] = offerIds;
    }
    return { [kind]: kept };
  }
  return undefined;
}

/** Fare rules without the net `refundingPreview` of their rules. */
function withoutRefundingPreview(fareRules: unknown): unknown {
  if (!isRecord(fareRules)) {
    return fareRules;
  }
  const rules = Array.isArray(fareRules["rules"])
    ? fareRules["rules"].map((rule) => {
        if (!isRecord(rule)) {
          return rule;
        }
        const kept = { ...rule };
        delete kept["refundingPreview"];
        return kept;
      })
    : fareRules["rules"];
  return { ...fareRules, ...(rules === undefined ? {} : { rules }) };
}

/**
 * The stored order as customer scope sees it (see the file header), or `null` when there is none or one of its offers
 * cannot be read (its markup could not be folded in).
 */
export function customerOrderOf(input: CustomerOrderInput): BookingAmadeus | null {
  if (!isRecord(input.snapshot)) {
    return null;
  }
  const data = structuredClone(redactPayload(input.snapshot));
  const flightOrderId = text(data["id"]);
  const offers = Array.isArray(data["flightOffers"]) ? data["flightOffers"] : [];
  if (flightOrderId === undefined || offers.length === 0) {
    return null;
  }
  const parsed: ParsedOffer[] = [];
  for (const offer of offers) {
    const reading = parseOffer(offer);
    if (reading === undefined) {
      return null;
    }
    parsed.push(reading);
  }
  const shares = distribute(
    new Money(input.markupAmount),
    parsed.map((offer) => new Money(offer.price.grandTotal)),
    input.minorUnits,
  );
  data["flightOffers"] = offers.map((offer, index) => {
    const reading = parsed[index];
    const share = shares[index] ?? new Money(0);
    const selling =
      reading === undefined
        ? (offer as JsonObject)
        : (sellingAmadeusOffer(
            offer,
            reading,
            share.toFixed(input.minorUnits),
            input.minorUnits,
          ) as JsonObject);
    return "fareRules" in selling
      ? { ...selling, fareRules: withoutRefundingPreview(selling["fareRules"]) }
      : selling;
  });
  delete data["queuingOfficeId"];
  delete data["ownerOfficeId"];
  delete data["automatedProcess"];
  delete data["commissions"];
  const payments = records(data["formOfPayments"]).flatMap((entry) => redactedFormOfPayment(entry) ?? []);
  if (payments.length > 0) {
    data["formOfPayments"] = payments;
  } else {
    delete data["formOfPayments"];
  }
  const remarks = isRecord(data["remarks"]) ? data["remarks"] : undefined;
  if (remarks !== undefined) {
    const visible = new Set(input.visibleRemarks.map((remark) => remark.toUpperCase()));
    const general = records(remarks["general"]).filter((remark) => {
      const body = text(remark["text"]);
      return body !== undefined && visible.has(body.toUpperCase());
    });
    if (general.length > 0) {
      data["remarks"] = { general };
    } else {
      delete data["remarks"];
    }
  }
  const identifications = records(data["formOfIdentifications"]);
  if (identifications.length > 0) {
    data["formOfIdentifications"] = identifications.map((entry) => {
      const number = entry["number"];
      return typeof number === "string" ? { ...entry, number: number.slice(-4) } : entry;
    });
  }
  return {
    flightOrderId,
    order: data as BookingAmadeus["order"],
    dictionaries: dictionariesOf(input.dictionaries),
  };
}

/**
 * The Amadeus dictionaries a booking answer can carry: `carriers` and `aircraft`, or `null`. The document's
 * AmadeusLocationEntry and AmadeusCurrencyEntry require a member named `key` that Amadeus's maps by code never have,
 * so `locations` and `currencies` would make every answer invalid; the itineraries name the airports already.
 */
export function dictionariesOf(value: unknown): NonNullable<BookingAmadeus["dictionaries"]> | null {
  if (!isRecord(value)) {
    return null;
  }
  const kept: JsonObject = {};
  for (const name of ["carriers", "aircraft"]) {
    const map = value[name];
    if (isRecord(map)) {
      const names = Object.entries(map).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      if (names.length > 0) {
        kept[name] = Object.fromEntries(names);
      }
    }
  }
  return Object.keys(kept).length === 0 ? null : (kept as NonNullable<BookingAmadeus["dictionaries"]>);
}

// ---- Fare rules ----------------------------------------------------------------------------------------------------

/** One offer's Amadeus `fareRules` as `bookings.order_included.fareRules` keeps them (net amounts included). */
export interface StoredOfferFareRules {
  readonly flightOfferId: string;
  readonly fareRules: unknown;
}

/** `bookings.order_included.fareRules`: the last fare-rule eligibility read from Amadeus. */
export interface StoredFareRules {
  readonly loadedAt: string;
  readonly types: readonly FareRuleType[];
  readonly offers: readonly StoredOfferFareRules[];
}

/** The `fareRules` of the offers of an order's `data` (Flight Order Management GET with `fareRules`). */
export function offerFareRulesOf(data: unknown): StoredOfferFareRules[] {
  const offers = isRecord(data) ? records(data["flightOffers"]) : [];
  return offers.flatMap((offer) => {
    const id = text(offer["id"]);
    return id === undefined || !isRecord(offer["fareRules"])
      ? []
      : [{ flightOfferId: id, fareRules: offer["fareRules"] }];
  });
}

/** The stored fare rules of `order_included`, or `undefined` when there are none (or they cannot be read). */
export function storedFareRulesOf(orderIncluded: unknown): StoredFareRules | undefined {
  const stored = isRecord(orderIncluded) ? orderIncluded["fareRules"] : undefined;
  if (!isRecord(stored) || typeof stored["loadedAt"] !== "string" || !Array.isArray(stored["offers"])) {
    return undefined;
  }
  const loadedAt = new Date(stored["loadedAt"]);
  if (Number.isNaN(loadedAt.getTime())) {
    return undefined;
  }
  return {
    loadedAt: loadedAt.toISOString(),
    types: strings(stored["types"]).filter((type): type is FareRuleType =>
      (FARE_RULE_TYPES as readonly string[]).includes(type),
    ),
    offers: records(stored["offers"]).flatMap((offer) => {
      const id = text(offer["flightOfferId"]);
      return id === undefined ? [] : [{ flightOfferId: id, fareRules: offer["fareRules"] }];
    }),
  };
}

const FARE_RULE_CATEGORIES: ReadonlySet<string> = new Set([
  "REFUND",
  "EXCHANGE",
  "REVALIDATION",
  "REISSUE",
  "REBOOK",
  "CANCELLATION",
]);

/** An Amadeus amount (`maxPenaltyAmount`, an ElementaryPrice `amount`) as Money of `currency`, or `null`. */
function amountOf(value: unknown, currency: string, minorUnits: number): MoneyAmount | null {
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)
    ? money(value, currency, minorUnits)
    : null;
}

/** What BookingFareRules is built from. */
export interface FareRulesInput {
  readonly booking: Pick<BookingRow, "id" | "currency">;
  readonly stored: StoredFareRules;
  /** The order's offers (the snapshot's), for the summary's amenities fallback. */
  readonly offers: readonly ParsedOffer[];
  readonly minorUnits: number;
}

/** The fare rules of a booking in customer scope (BookingFareRules; see the file header). */
export function toBookingFareRules(input: FareRulesInput): BookingFareRules {
  const { booking, stored, minorUnits } = input;
  const penaltyCurrency =
    stored.offers
      .map((offer) => (isRecord(offer.fareRules) ? text(offer.fareRules["currency"]) : undefined))
      .find((code): code is string => code !== undefined && /^[A-Z]{3}$/.test(code)) ?? booking.currency;
  const rules: BookingFareRule[] = stored.offers.flatMap((offer) => {
    const fareRules = isRecord(offer.fareRules) ? offer.fareRules : {};
    const currency = text(fareRules["currency"]) ?? penaltyCurrency;
    return records(fareRules["rules"]).flatMap((rule): BookingFareRule[] => {
      const category = rule["category"];
      if (typeof category !== "string" || !FARE_RULE_CATEGORIES.has(category)) {
        return [];
      }
      const applicability = isRecord(rule["applicability"]) ? rule["applicability"] : {};
      const rebook = isRecord(rule["rebookConditions"]) ? rule["rebookConditions"] : undefined;
      return [
        {
          flightOfferId: offer.flightOfferId,
          category: category as BookingFareRule["category"],
          applicable: rule["notApplicable"] !== true,
          chargeable: typeof rule["isChargeable"] === "boolean" ? rule["isChargeable"] : null,
          maxPenalty: amountOf(rule["maxPenaltyAmount"], currency, minorUnits),
          circumstances: text(rule["circumstances"]) ?? null,
          travelerIds: isRecord(applicability) ? strings(applicability["travelerIds"]) : [],
          segmentIds: isRecord(applicability) ? strings(applicability["segmentIds"]) : [],
          texts: records(rule["descriptions"]).flatMap((description) => {
            const body = text(description["text"]);
            return body === undefined
              ? []
              : [{ descriptionType: text(description["descriptionType"]) ?? null, text: body }];
          }),
          rebookConditions:
            rebook === undefined
              ? null
              : {
                  reshopValidatingAirlineCodes: strings(rebook["reshopValidatingAirlineCodes"]),
                  waiverCode: text(rebook["waiverCode"]) ?? null,
                },
          // The preview's amounts are the airline's (net): a refund in selling amounts needs the OTA's fee rules and
          // markup policy, which the cancellation quote applies (OBE-049). Until then no estimate is shown.
          refundEstimate: null,
        },
      ];
    });
  });
  return {
    bookingId: booking.id,
    currency: penaltyCurrency,
    available: rules.length > 0,
    types: [...stored.types],
    summary: fareConditionsOf(stored.offers, input.offers, booking.currency),
    rules,
    amadeus: stored.offers
      .filter((offer) => isRecord(offer.fareRules))
      .map((offer) => ({
        flightOfferId: offer.flightOfferId,
        fareRules: withoutRefundingPreview(offer.fareRules) as NonNullable<
          BookingFareRules["amadeus"]
        >[number]["fareRules"],
      })),
    loadedAt: stored.loadedAt,
  };
}

/**
 * Refund and change conditions at a glance (FareRuleSummary, Booking.fareConditions): the fare rules when some were
 * loaded, else the branded-fare amenities of the booked offers, else unknown (priced-offers.mapper.ts's rules).
 */
export function fareConditionsOf(
  fareRules: readonly StoredOfferFareRules[],
  offers: readonly ParsedOffer[],
  currency: string,
): FareRuleSummary {
  const rulesById = new Map(fareRules.map((entry) => [entry.flightOfferId, entry.fareRules]));
  return fareRuleSummaryOf(
    {
      offers: offers.map((offer) => ({
        offerId: offer.amadeusId,
        fareRules: rulesById.get(offer.amadeusId),
        parsed: offer,
      })),
      detailedFareRules: undefined,
      loadedAt: new Date(0),
      warnings: undefined,
    },
    currency,
  );
}

const RECORD_REFERENCE = /^[A-Z0-9]{5,8}$/;
const ORIGIN_SYSTEM = /^[A-Z0-9]{2,3}$/;
const RECORD_CREATION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/;

/**
 * The `associatedRecords` of an order's `data` that can be stored (a record locator, its system, the local creation
 * time when it has the Amadeus form): a refresh adds the ones the booking does not have yet, such as an airline's
 * locator that appears after booking (online check-in uses it).
 */
export function orderRecordsOf(data: unknown): OrderRecord[] {
  return (isRecord(data) ? records(data["associatedRecords"]) : []).flatMap((raw) => {
    const reference = text(raw["reference"]);
    const originSystemCode = text(raw["originSystemCode"]);
    if (
      reference === undefined ||
      originSystemCode === undefined ||
      !RECORD_REFERENCE.test(reference) ||
      !ORIGIN_SYSTEM.test(originSystemCode)
    ) {
      return [];
    }
    const creationDate = text(raw["creationDate"]);
    return [
      {
        reference,
        originSystemCode,
        creationDate: creationDate !== undefined && RECORD_CREATION.test(creationDate) ? creationDate : null,
        flightOfferId: text(raw["flightOfferId"]) ?? null,
      },
    ];
  });
}

/** The offers of a stored order snapshot that can be read. */
export function snapshotOffersOf(snapshot: unknown): ParsedOffer[] {
  return (isRecord(snapshot) ? records(snapshot["flightOffers"]) : []).flatMap(
    (offer) => parseOffer(offer) ?? [],
  );
}

// ---- Tickets, ancillaries, refunds, documents, cancellation --------------------------------------------------------

/** A booking's tickets in customer scope (no Amadeus document: its fields are the ticket's own). */
export function customerTicketsOf(
  tickets: readonly BookingTicketRow[],
  travelers: readonly Pick<BookingTravelerRow, "amadeusTravelerId" | "firstName" | "lastName">[],
): Ticket[] {
  const names = new Map(travelers.map((row) => [row.amadeusTravelerId, `${row.firstName} ${row.lastName}`]));
  return tickets.map((row) => ({
    id: row.id,
    documentType: row.documentType as Ticket["documentType"],
    documentNumber: row.documentNumber,
    status: row.status as Ticket["status"],
    travelerId: row.amadeusTravelerId,
    travelerName: row.amadeusTravelerId === null ? null : (names.get(row.amadeusTravelerId) ?? null),
    segmentIds: [...row.segmentIds],
    issuedAt: row.issuedAt?.toISOString() ?? null,
    total: null,
  }));
}

const SERVICE_NAMES: ReadonlySet<string> = new Set(["PRIORITY_BOARDING", "AIRPORT_CHECKIN", "FAST_TRACK"]);

/** The display label of a booked service. */
function ancillaryLabelOf(row: BookingAncillaryRow): string {
  const pieces = (noun: string) => `${row.quantity} ${noun}${row.quantity === 1 ? "" : "s"}`;
  switch (row.type) {
    case "CHECKED_BAGS":
      return row.weight === null
        ? pieces("checked bag")
        : `${pieces("checked bag")} (${row.weight} ${row.weightUnit ?? "KG"})`;
    case "CABIN_BAGS":
      return pieces("cabin bag");
    case "SEATS":
      return row.seatNumber === null ? "Seat" : `Seat ${row.seatNumber}`;
    case "MEALS":
      return "Meal";
    default: {
      const code = row.serviceCode ?? "Service";
      return code.charAt(0).toUpperCase() + code.slice(1).toLowerCase().replace(/_/g, " ");
    }
  }
}

/** A booked service in customer scope (selling price). */
export function toBookingAncillary(
  row: BookingAncillaryRow,
  currency: string,
  minorUnits: number,
): BookingAncillary {
  return {
    id: row.id,
    type: row.type as BookingAncillary["type"],
    label: ancillaryLabelOf(row),
    travelerId: row.travelerId,
    segmentIds: row.segmentId === null ? [] : [row.segmentId],
    quantity: row.quantity,
    weight: row.weight,
    weightUnit: row.weightUnit,
    serviceName:
      row.type === "OTHER_SERVICES" && row.serviceCode !== null && SERVICE_NAMES.has(row.serviceCode)
        ? (row.serviceCode as NonNullable<BookingAncillary["serviceName"]>)
        : null,
    seatNumber: row.seatNumber,
    price: money(row.priceAmount, row.currency ?? currency, minorUnits),
    status: row.status as BookingAncillary["status"],
    source: row.source as NonNullable<BookingAncillary["source"]>,
    emdNumber: row.emdNumber,
  };
}

/** A refund (the table spells the withdrawn state `canceled`, the document `cancelled`). */
export function toRefund(row: BookingRefundRow, bookingId: string, minorUnits: number): Refund {
  return {
    id: row.id,
    paymentId: row.paymentId,
    bookingId,
    amount: money(row.amount, row.currency, minorUnits),
    penalty: row.penaltyAmount === null ? null : money(row.penaltyAmount, row.currency, minorUnits),
    reason: row.reason as Refund["reason"],
    status: (row.status === "canceled" ? "cancelled" : row.status) as Refund["status"],
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

/** A current document of the booking. */
export function toBookingDocument(row: BookingDocumentRow, bookingId: string): BookingDocument {
  return {
    id: row.id,
    bookingId,
    kind: row.kind as BookingDocument["kind"],
    status: row.status as BookingDocument["status"],
    locale: row.locale,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    ticketId: row.ticketId,
    invoiceNumber: row.invoiceNumber,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The cancellation of a cancelled booking as the stored rows tell it: who cancelled and when, whether a ticket was
 * voided, the newest refund. The customer's typed reason and comment come with bookings.cancel (OBE-049); until then
 * the reason is the airline's for an airline cancellation and `other` otherwise, and no staff text is ever shown.
 */
export function cancellationOf(input: {
  readonly booking: Pick<BookingRow, "id" | "status" | "cancelledAt" | "amountPaid">;
  readonly cancelledBy: string | null;
  readonly tickets: readonly Pick<BookingTicketRow, "status">[];
  readonly refunds: readonly Refund[];
}): Cancellation | null {
  const { booking } = input;
  if (booking.status !== "cancelled" || booking.cancelledAt === null) {
    return null;
  }
  const refund = input.refunds.at(-1) ?? null;
  const cancelledBy = (
    ["customer", "staff", "airline", "system"].includes(input.cancelledBy ?? "")
      ? input.cancelledBy
      : "system"
  ) as Cancellation["cancelledBy"];
  const refundStatus: Cancellation["refundStatus"] =
    refund === null
      ? new Money(booking.amountPaid).isZero()
        ? "not_applicable"
        : "manual_review"
      : refund.status === "cancelled"
        ? "failed"
        : refund.status;
  return {
    bookingId: booking.id,
    status: "cancelled",
    requestedAt: booking.cancelledAt.toISOString(),
    cancelledAt: booking.cancelledAt.toISOString(),
    cancelledBy,
    reasonCode: cancelledBy === "airline" ? "airline_request" : "other",
    comment: null,
    ticketsVoided: input.tickets.some((ticket) => ticket.status === "VOID"),
    estimatedRefund: null,
    refund,
    refundStatus,
  };
}

// ---- bookings.get --------------------------------------------------------------------------------------------------

/** Booking.syncStatus. */
export type SyncStatus = Booking["syncStatus"];

/** The sync status of a booking that this call did not refresh: `failed`, `fresh` or `stale`. */
export function storedSyncStatusOf(
  lastSyncedAt: Date | null,
  syncError: string | null,
  now: Date,
): SyncStatus {
  if (syncError !== null) {
    return "failed";
  }
  return lastSyncedAt !== null && now.getTime() - lastSyncedAt.getTime() < FRESH_SYNC_MS ? "fresh" : "stale";
}

/** Everything bookings.get answers besides what `toBooking` reads. */
export interface CustomerBookingInput extends BookingViewInput {
  readonly allowedActions: AllowedActions;
  readonly ancillaries: readonly BookingAncillaryRow[];
  readonly refunds: readonly BookingRefundRow[];
  readonly documents: readonly BookingDocumentRow[];
  readonly cancelledBy: string | null;
  readonly amadeus: BookingAmadeus | null;
  readonly fareConditions: FareRuleSummary | null;
  readonly fareRules: BookingFareRules | null;
  readonly syncStatus: SyncStatus;
  readonly warnings: readonly Warning[];
}

/** The booking of bookings.get in customer scope. */
export function toCustomerBooking(input: CustomerBookingInput): Booking {
  const base = toBooking(input);
  const { booking, minorUnits } = input;
  const refunds = input.refunds.map((row) => toRefund(row, booking.id, minorUnits));
  return {
    ...base,
    ancillaries: input.ancillaries.map((row) => toBookingAncillary(row, booking.currency, minorUnits)),
    refunds,
    documents: input.documents.map((row) => toBookingDocument(row, booking.id)),
    fareConditions: input.fareConditions,
    fareRules: input.fareRules,
    allowedActions: input.allowedActions,
    cancellation: cancellationOf({
      booking,
      cancelledBy: input.cancelledBy,
      tickets: input.children.tickets,
      refunds,
    }),
    syncStatus: input.syncStatus,
    amadeus: input.amadeus,
    ...(input.warnings.length > 0 ? { warnings: [...input.warnings] } : {}),
  };
}

// ---- bookings.getTicketingStatus -----------------------------------------------------------------------------------

/** What BookingTicketingStatus is built from. */
export interface TicketingStatusInput {
  readonly booking: BookingRow;
  readonly policy: BookingTicketingStatus["policy"];
  readonly requestedAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly errorCode: string | null;
  readonly tickets: readonly Ticket[];
}

/** The polling interval of a booking's ticketing state, `null` when final (BookingTicketingStatus.pollAfterSeconds). */
export function pollAfterSecondsOf(bookingStatus: string, ticketingStatus: string): number | null {
  if (bookingStatus === "pending") {
    return UNKNOWN_OUTCOME_POLL_AFTER_SECONDS;
  }
  if (bookingStatus === "failed" || bookingStatus === "cancelled") {
    return null;
  }
  return ticketingStatus === "pending" || ticketingStatus === "in_progress" ? POLL_AFTER_SECONDS : null;
}

/** The ticketing state is final: nothing more will happen without staff (no refresh needed). */
export function ticketingFinal(bookingStatus: string, ticketingStatus: string): boolean {
  return (
    bookingStatus === "failed" ||
    bookingStatus === "cancelled" ||
    ticketingStatus === "issued" ||
    ticketingStatus === "not_applicable"
  );
}

/** The ticketing progress of a booking (BookingTicketingStatus). */
export function toTicketingStatus(input: TicketingStatusInput): BookingTicketingStatus {
  const { booking } = input;
  const failed = booking.status === "failed";
  return {
    bookingId: booking.id,
    bookingStatus: booking.status as BookingTicketingStatus["bookingStatus"],
    status: booking.ticketingStatus as BookingTicketingStatus["status"],
    policy: input.policy,
    deadlineAt: booking.ticketingDeadlineAt?.toISOString() ?? null,
    requestedAt: input.requestedAt?.toISOString() ?? null,
    issuedAt: booking.issuedAt?.toISOString() ?? null,
    lastAttemptAt: input.lastAttemptAt?.toISOString() ?? null,
    nextAttemptAt: booking.ticketingNextAttemptAt?.toISOString() ?? null,
    attempts: booking.ticketingAttempts,
    failureCode: failed ? booking.failureCode : input.errorCode,
    message:
      booking.status === "pending"
        ? "We are confirming your booking with the airline. This can take a few minutes."
        : failed
          ? "Your booking could not be confirmed by the airline."
          : ticketingMessageOf(booking.status, booking.ticketingStatus),
    tickets: [...input.tickets],
    pollAfterSeconds: pollAfterSecondsOf(booking.status, booking.ticketingStatus),
    lastSyncedAt: booking.lastSyncedAt?.toISOString() ?? null,
  };
}

// ---- bookings.listEvents -------------------------------------------------------------------------------------------

const EVENT_ACTORS: ReadonlySet<string> = new Set([
  "customer",
  "guest",
  "staff",
  "system",
  "supplier",
  "api_key",
]);

/** A customer-visible event: its actor's type only, its data through the shared redactor. */
export function toBookingEvent(row: BookingEventRow): BookingEvent {
  const data = isRecord(row.data) ? redactPayload(row.data) : {};
  return {
    id: row.id,
    bookingId: row.bookingId,
    type: row.type,
    actorType: (EVENT_ACTORS.has(row.actorType) ? row.actorType : "system") as BookingEvent["actorType"],
    summary: row.summary ?? row.type,
    statusFrom: row.statusFrom,
    statusTo: row.statusTo,
    data,
    createdAt: row.createdAt.toISOString(),
  };
}
