// The PNR lookup and import of the console (OBE-064; ota/docs/flows/console-operations.md §2 "PNR lookup and import",
// §3 step 4 and §4, OADR-0005 point 10, ADR-0012 "Office isolation on the shared account", scope.md OF-09 AC3, the
// document's consoleFindBookingByRecordLocator and consoleImportBooking): what OTA staff (or a `console:automation` key
// with the operation's permission) do with an Amadeus order that Velexis did not create, a booking made in a GDS
// terminal or found late by the staff (OADR-0003 point 8). The permission guard checked `bookings:read` or
// `bookings:write` and the environment before this runs (OBE-060). No transaction is open during an Amadeus call.
//
// Office isolation (ADR-0012, OF-09 AC3). On the shared Velexis account every OTA's offices answer to the same
// credentials, so Get Flight Order By Record Locator can return an order of another OTA. An order is the tenant's when
// its office is one of the offices of the tenant's supplier connection (`officeIds`): its owner office, which is the
// office that holds it, or, when Amadeus gives no owner office (its by-reference answers often have the queuing office
// only), its queuing office (`orderOfficeOf`; ADR-0012 says "owned by one of the tenant's offices", the plan "owner or
// queuing office": the owner office decides when there is one, as every later call on the order acts for it). Another
// office's orders are left out of the answer, and of the tenant's `supplier_requests` row of the call too (its
// response keeps their id and a `withheld` marker only, without the answer's `included` and `dictionaries`, which
// describe every order of the answer: `withheldBody`), so that the supplier log never shows another OTA's PNR or its
// route either; when no order is left, the answer is `403 OFFICE_NOT_ALLOWED` and the staff action is `denied`.
//
// - `findByRecordLocator` (`bookings:read`): the local bookings of the environment with this record locator (the
//   unique index `bookings_record_locator_uq` and `booking_associated_records`, "local index first"), then Get Flight
//   Order By Record Locator (the connection's retrieval office; `include=bags` passed through), the office isolation
//   above, and each order of the tenant wrapped with its summary (PnrOrderSummary) and its link to a booking of this
//   environment (matched on `bookings.amadeus_order_id`, else on an associated record): `importable` when there is
//   none. Amadeus 404 answers `404 NOT_FOUND` with `error.supplier`. The PNR lookup is an audited read (OADR-0011 point 8
//   as decided on 2026-10-21): the use case writes its `pnr.lookup` row (target: the record locator) in a transaction
//   of its own, and its handler opts in with `@AuditedRead` (the interceptor then writes no second row).
// - `import` (`bookings:write`, `Idempotency-Key`): the request's checks first (`pricing.sellingTotal` with `override`
//   only and required there, `400`); T1: a booking of the environment with this record locator answers `409
//   ORDER_ALREADY_IMPORTED` before Amadeus is called, the customer must be one of the tenant's (`404`), not deleted or
//   disabled (`409 CONFLICT`, `details.reason` `customer_deleted` / `customer_disabled`, as a console checkout answers
//   it). Then Get Flight Order By Record Locator (`include=bags`), the office isolation, the order (`flightOrderId`
//   among several matches, otherwise `422 UNPROCESSABLE` with the tenant's `details.flightOrderIds`), Flight Order
//   Management GET of that order for its office (`include=bags`: the complete order). T2, one transaction: the order
//   known by its id or one of its records (or the unique indexes on a concurrent import) answers `409
//   ORDER_ALREADY_IMPORTED`; the customer is read again after the booking's insert (an account.delete that committed
//   meanwhile refuses it); the booking (`channel = import`, a new Velexis reference, `created_by_staff_id`, the
//   connection, the offices, the status from the segments and tickets: `cancelled` when the airline cancelled every
//   segment, else `ticketed`, `partially_ticketed` or `confirmed`, the ticketing status `issued`, `partially_issued`
//   or `manual_review` (nothing was paid through Velexis, so the ticketing job leaves it to the staff:
//   console.bookings.issue), the ticketing deadline of the record step in the OTA's time zone, the net amounts of the
//   order's prices and the selling amounts of `pricing`, below), its children from the order (associated records,
//   travellers with their documents sealed, contacts, segments, remarks, tickets), the staff-only event
//   `booking.imported` (which asks for the itinerary and the e-ticket receipts, DOCUMENT_TRIGGERS), the staff note
//   (`staff.note`) when one is given, the link of the two `supplier_requests` rows to the booking, the outbox
//   `booking.confirmed` with `sendConfirmation`, and the `booking.import` staff action with the reason. No payment is
//   recorded (`paymentStatus = not_applicable`) and Flight Create Orders is never called. The answer is the console
//   booking, `201` with `Location` and `ETag` (with CONFIRMATION_REFUSED_WARNING when the outbox refused the
//   confirmation); the idempotency interceptor replays it for the same key.
//
// Pricing (OADR-0005 point 10, `importPricingOf`): the net amounts are the order's (`net_amount` the sum of the offers'
// `grandTotal`, services included; base, Amadeus fees, taxes and services split as a storefront booking's are), and
// the booked services are sold at net (`ancillaries_amount`, so the customer's totals add up). `markup_rules` (default)
// prices each offer's flights (`price.total`) with the tenant's markup rules at the engine's `search` step and the
// offers together at its `pricing` step for the `booking_service` and `ticketing` fees, channel `console`, as a priced
// offer is priced; `net` sells at net; `override` sells at `sellingTotal` (same currency, at least the net, at most the
// currency's minor units) and stores the difference as markup.
//
// Neither operation writes `booking_ancillaries` (the services stay in the order's price, as for every booking) or a
// booking access token (a guest finds the booking with bookings.lookup): see the document's descriptions. Neither
// changes the order at Amadeus either: the import only reads it, so the order gets no `VELEXIS <reference>` remark (the
// remark Velexis puts on the orders it creates, for the reconciliation of a lost answer, which an import never needs).
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components, operations } from "@velexis/api-types";
import type { Insertable, TenantDatabase } from "@velexis/db";
import { AppError, isAppError, type OtaErrorCode } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AmadeusClient, requestPath, type AmadeusCallInfo } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import {
  AMADEUS_OFFICE_ID,
  ConnectionResolver,
  type ResolvedAmadeusConnection,
} from "../amadeus/connection-resolver";
import { AmadeusCallError } from "../amadeus/error-mapper";
import { AMADEUS_OPERATIONS, type AmadeusOperationName } from "../amadeus/limits";
import { supplierRequestBody } from "../amadeus/supplier-requests.repository";
import { newBookingReference } from "../bookings/booking-reference";
import { AIRLINE_CANCEL_REASON } from "../bookings/booking-sync.service";
import { dictionariesOf } from "../bookings/bookings.mapper";
import { BookingsRepository } from "../bookings/bookings.repository";
import { maskedIdentifications } from "../bookings/identifications";
import { orderSegmentsOf, type OrderSegment } from "../bookings/order-diff";
import {
  BookingTravelerDocuments,
  deadlineLocalOf,
  eventActorOf,
  lastTicketingDateOf,
  OrderRecorder,
  readCreatedOrder,
  ticketCoverage,
  ticketingStateOf,
  type CreatedOrder,
} from "../bookings/order-recorder";
import type { AmadeusDiscount, StoredDocument } from "../checkout/traveler-documents";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import type { SharedConfig } from "../config";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { storefrontUrl } from "../notifications/renderer";
import { priceOffer } from "../pricing/pricing-engine";
import {
  Money,
  PricingInputError,
  type FeeRule,
  type MarkupRule,
  type MoneyValue,
  type PricingInput,
} from "../pricing/pricing.types";
import { RulesRepository } from "../pricing/rules.repository";
import { offerColumns, pricingInputOf, tripTypeOf, type ParsedOffer } from "../shopping/offers.mapper";
import { warningsOf } from "../shopping/priced-offers.mapper";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { contactValuesOf, keptOrderDataOf, orderRemarksOf } from "./console-booking-actions.service";
import type { ConsoleBooking } from "./console-bookings.mapper";
import { STAFF_NOTE_EVENT } from "./console-bookings.repository";
import { ConsoleBookingsService } from "./console-bookings.service";
import { consoleAction, StaffActionsWriter } from "./staff-actions.writer";

type Schemas = components["schemas"];
export type PnrLookupQuery = operations["consoleFindBookingByRecordLocator"]["parameters"]["query"];
export type PnrLookupResult = Schemas["PnrLookupResult"];
export type PnrMatch = Schemas["PnrMatch"];
export type PnrOrderSummary = Schemas["PnrOrderSummary"];
export type ConsoleImportRequest = Schemas["ConsoleBookingImportRequest"];
export type ConsolePricingRequest = Schemas["ConsolePricingInput"];
type ConsoleAmadeusCall = Schemas["ConsoleAmadeusCall"];
type MoneyAmount = Schemas["Money"];
type BookingStatus = Schemas["BookingStatus"];

type Db = TenantDatabase;
type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

// ---- Names ----------------------------------------------------------------------------------------------------------

/** The `staff_actions.action` of the two operations' successful calls (the document's names). */
export const PNR_ACTIONS = Object.freeze({ lookup: "pnr.lookup", import: "booking.import" });

/** The staff-only booking event of an import. */
export const BOOKING_IMPORTED_EVENT = "booking.imported";

/** `supplier_requests.operation` of the operations' Amadeus calls (their SDK methods). */
const OPERATIONS = Object.freeze({
  lookup: "console.bookings.findByRecordLocator",
  import: "console.bookings.import",
});

/** The operations, for the action of a refused call (`consoleAction`). */
const OPERATION_IDS = Object.freeze({
  lookup: "consoleFindBookingByRecordLocator",
  import: "consoleImportBooking",
});

/** The default `originSystemCode` of an import (the only one Amadeus supports). */
export const DEFAULT_ORIGIN_SYSTEM_CODE = "GDS";

/** The `staff_actions.target_type` of a record locator. */
export const RECORD_LOCATOR_TARGET = "record_locator";

/** The marker of an order of another office in the tenant's `supplier_requests` row. */
export const WITHHELD_ORDER = "office_not_allowed";

/**
 * The warning of an import with `sendConfirmation` whose `booking.confirmed` e-mail the outbox refused (an address or
 * data it cannot send; lead decision (6) of 2026-10-24, as console.bookings.patch warns): the booking is imported, the
 * traveller was not told.
 */
export const CONFIRMATION_REFUSED_WARNING: Schemas["Warning"] = Object.freeze({
  title: "CUSTOMER NOT NOTIFIED",
  detail:
    "The booking confirmation could not be queued for the booking's contact address: tell the traveller yourself.",
});

/** The ticketing policy of an imported order without tickets (see the file header). */
const IMPORT_TICKETING_POLICY = "manual_review";

/** The unique indexes an import can hit. */
const ORDER_UNIQUE = new Set(["bookings_amadeus_order_uq", "bookings_record_locator_uq"]);
const REFERENCE_UNIQUE = "bookings_reference_key";

/**
 * The client's errors a use case passes on: the codes its operation documents (`x-error-codes`), plus `503
 * SERVICE_UNAVAILABLE` (the client's rate limiter without Redis, the `503` every operation documents); any other
 * becomes `502 SUPPLIER_ERROR`. `OFFICE_NOT_ALLOWED` is Amadeus's own refusal of an office (`403`).
 */
const SUPPLIER_CODES: ReadonlySet<string> = new Set<OtaErrorCode>([
  "OFFICE_NOT_ALLOWED",
  "SUPPLIER_REJECTED",
  "SUPPLIER_NOT_CONFIGURED",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "SUPPLIER_ERROR",
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_TIMEOUT",
]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TRAVELER_TYPES: ReadonlySet<string> = new Set([
  "ADULT",
  "CHILD",
  "SENIOR",
  "YOUNG",
  "HELD_INFANT",
  "SEATED_INFANT",
  "STUDENT",
]);
const GENDERS: ReadonlySet<string> = new Set(["MALE", "FEMALE", "UNSPECIFIED", "UNDISCLOSED"]);
const DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "VISA",
  "PASSPORT",
  "IDENTITY_CARD",
  "KNOWN_TRAVELER",
  "REDRESS",
]);
/** The optional text fields of a sealed document (StoredDocument), in its order. */
const DOCUMENT_FIELDS = [
  "issuanceDate",
  "expiryDate",
  "issuanceCountry",
  "issuanceLocation",
  "nationality",
  "birthPlace",
  "validityCountry",
  "birthCountry",
] as const;

// ---- Office isolation -----------------------------------------------------------------------------------------------

/** The office that holds an order: its owner office, else its queuing office; `null` when Amadeus gives neither. */
export function orderOfficeOf(order: JsonObject): string | null {
  return text(order["ownerOfficeId"]) ?? text(order["queuingOfficeId"]) ?? null;
}

/** Whether an order is the tenant's: the office that holds it is one of the connection's (see the file header). */
export function isTenantOrder(order: JsonObject, officeIds: readonly string[]): boolean {
  const office = orderOfficeOf(order);
  return office !== null && officeIds.includes(office);
}

/** The orders of an Amadeus answer, split into the tenant's and the others (`withheld`), each in Amadeus's order. */
export function partitionOrders(
  orders: readonly JsonObject[],
  officeIds: readonly string[],
): { readonly allowed: JsonObject[]; readonly withheld: JsonObject[] } {
  const allowed: JsonObject[] = [];
  const withheld: JsonObject[] = [];
  for (const order of orders) {
    (isTenantOrder(order, officeIds) ? allowed : withheld).push(order);
  }
  return { allowed, withheld };
}

/**
 * An answer as the tenant's `supplier_requests` row may keep it: the orders of other offices reduced to their id and
 * the WITHHELD_ORDER marker, and `included` (their bag options, with net prices) and `dictionaries` (their airports
 * with city and country, their carriers and aircraft: the other OTA's route) left out when any order was withheld.
 */
export function withheldBody(body: JsonObject, withheld: readonly JsonObject[]): JsonObject {
  if (withheld.length === 0) {
    return body;
  }
  const ids = new Set(withheld.map((order) => order["id"]));
  const reduce = (order: JsonObject): JsonObject =>
    ids.has(order["id"])
      ? { type: "flight-order", id: order["id"] ?? null, withheld: WITHHELD_ORDER }
      : order;
  const { included: _included, dictionaries: _dictionaries, ...rest } = body;
  if (Array.isArray(body["data"])) {
    return { ...rest, data: records(body["data"]).map(reduce) };
  }
  return isRecord(body["data"]) ? { ...rest, data: reduce(body["data"]) } : rest;
}

// ---- The lookup's answer --------------------------------------------------------------------------------------------

/** The sum of decimal strings with the most decimals among them (at most 4), or `null` when one is not a decimal. */
function decimalSum(amounts: readonly string[]): string | null {
  if (amounts.length === 0 || amounts.some((amount) => !/^-?\d+(?:\.\d{1,4})?$/.test(amount))) {
    return null;
  }
  const places = Math.max(...amounts.map((amount) => amount.split(".")[1]?.length ?? 0));
  return amounts.reduce((sum, amount) => sum.plus(amount), new Money(0)).toFixed(places);
}

/** The flight offers' prices of an order: `{currency, total, grandTotal}` of each offer that has them. */
function offerPricesOf(order: JsonObject): Array<{ currency: string; total: string; grandTotal: string }> {
  return records(order["flightOffers"]).flatMap((offer) => {
    const price = isRecord(offer["price"]) ? offer["price"] : {};
    const currency = text(price["currency"]);
    const total = text(price["total"]);
    const grandTotal = text(price["grandTotal"]) ?? total;
    return currency === undefined || total === undefined || grandTotal === undefined
      ? []
      : [{ currency, total, grandTotal }];
  });
}

/** The normalised summary of an Amadeus order for the lookup screen (PnrOrderSummary). */
export function pnrSummaryOf(order: JsonObject): PnrOrderSummary {
  const associated = records(order["associatedRecords"]);
  const offers = records(order["flightOffers"]);
  const prices = offerPricesOf(order);
  const currencies = new Set(prices.map((price) => price.currency));
  const total =
    prices.length > 0 && prices.length === offers.length && currencies.size === 1
      ? decimalSum(prices.map((price) => price.grandTotal))
      : null;
  const lastTicketingDates = offers
    .map((offer) => text(offer["lastTicketingDate"]))
    .filter((value): value is string => value !== undefined && DATE.test(value))
    .sort();
  return {
    recordLocators: associated.flatMap((record, index) => {
      const reference = text(record["reference"]);
      const originSystemCode = text(record["originSystemCode"]);
      if (
        reference === undefined ||
        originSystemCode === undefined ||
        originSystemCode.length < 2 ||
        originSystemCode.length > 3
      ) {
        return [];
      }
      return [
        {
          reference,
          originSystemCode,
          flightOfferId: text(record["flightOfferId"]) ?? null,
          creationDate: text(record["creationDate"]) ?? text(record["creationDateTime"]) ?? null,
          primary: index === 0,
        },
      ];
    }),
    travelers: records(order["travelers"]).map((traveler) => {
      const name = isRecord(traveler["name"]) ? traveler["name"] : {};
      return {
        travelerId: text(traveler["id"]) ?? "",
        firstName: text(name["firstName"]) ?? null,
        lastName: text(name["lastName"]) ?? null,
      };
    }),
    segments: offers.flatMap((offer) =>
      records(offer["itineraries"]).flatMap((itinerary) =>
        records(itinerary["segments"]).map((segment) => {
          const departure = isRecord(segment["departure"]) ? segment["departure"] : {};
          const arrival = isRecord(segment["arrival"]) ? segment["arrival"] : {};
          return {
            segmentId: text(segment["id"]) ?? "",
            carrierCode: text(segment["carrierCode"]) ?? "",
            number: text(segment["number"]) ?? "",
            originCode: text(departure["iataCode"]) ?? "",
            destinationCode: text(arrival["iataCode"]) ?? "",
            departureAt: text(departure["at"]) ?? "",
            bookingStatus: text(segment["bookingStatus"]) ?? null,
          };
        }),
      ),
    ),
    ticketNumbers: records(order["tickets"]).flatMap((ticket) => strings([ticket["documentNumber"]])),
    lastTicketingDate: lastTicketingDates[0] ?? null,
    queuingOfficeId: text(order["queuingOfficeId"]) ?? null,
    grandTotal: total === null ? null : { amount: total, currency: [...currencies][0] ?? "" },
  };
}

/** An order as the console answers it verbatim: its forms of payment through the shared redactor (no card number). */
export function consoleOrderOf(order: JsonObject): JsonObject {
  return order["formOfPayments"] === undefined
    ? { ...order }
    : { ...order, formOfPayments: redactPayload(order["formOfPayments"]) };
}

/** A booking of the environment that an order may be attached to. */
export interface AttachedBooking {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly amadeusOrderId: string | null;
  /** The main record locator and the associated records, as `reference|originSystemCode`. */
  readonly records: readonly string[];
}

const recordKey = (reference: string, originSystemCode: string): string => `${reference}|${originSystemCode}`;

/** The booking an order is attached to: by `amadeus_order_id`, else by one of its records; `undefined` for none. */
export function attachedBookingOf(
  order: JsonObject,
  bookings: readonly AttachedBooking[],
): AttachedBooking | undefined {
  const id = text(order["id"]);
  const byId = id === undefined ? undefined : bookings.find((booking) => booking.amadeusOrderId === id);
  if (byId !== undefined) {
    return byId;
  }
  const keys = new Set(
    records(order["associatedRecords"]).flatMap((record) => {
      const reference = text(record["reference"]);
      const originSystemCode = text(record["originSystemCode"]);
      return reference === undefined || originSystemCode === undefined
        ? []
        : [recordKey(reference, originSystemCode)];
    }),
  );
  return bookings.find(
    // A booking of another order is never attached to this one, whatever its records say.
    (booking) =>
      (booking.amadeusOrderId === null || booking.amadeusOrderId === id) &&
      booking.records.some((key) => keys.has(key)),
  );
}

/** One match of the lookup (PnrMatch). */
export function pnrMatchOf(order: JsonObject, bookings: readonly AttachedBooking[]): PnrMatch {
  const booking = attachedBookingOf(order, bookings);
  return {
    flightOrderId: text(order["id"]) ?? "",
    bookingId: booking?.id ?? null,
    bookingReference: booking?.reference ?? null,
    bookingStatus: (booking?.status ?? null) as BookingStatus | null,
    importable: booking === undefined,
    summary: pnrSummaryOf(order),
    amadeus: consoleOrderOf(order) as PnrMatch["amadeus"],
  };
}

// ---- The import's rules ---------------------------------------------------------------------------------------------

/**
 * The refusals of an import request that need nothing else (`400 VALIDATION_FAILED`): `pricing.sellingTotal` is
 * required with `override` and refused with any other mode.
 */
export function refuseImportRequest(body: ConsoleImportRequest): void {
  const pricing = body.pricing;
  if (pricing === undefined) {
    return;
  }
  if (pricing.mode === "override" && pricing.sellingTotal === undefined) {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [
        {
          path: "/pricing/sellingTotal",
          code: "required",
          message: "An override needs the selling total.",
        },
      ],
    });
  }
  if (pricing.mode !== "override" && pricing.sellingTotal !== undefined) {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [
        {
          path: "/pricing/sellingTotal",
          code: "not_allowed",
          message: "A selling total is given with the override mode only.",
        },
      ],
    });
  }
}

/**
 * The order to import among the tenant's matches: the one `flightOrderId` names, else the only one. Another office's
 * order named by `flightOrderId` is `403 OFFICE_NOT_ALLOWED`; an id among none of them, or several matches without
 * one, is `422 UNPROCESSABLE` with the tenant's `details.flightOrderIds`.
 */
export function chooseImportOrder(
  allowed: readonly JsonObject[],
  withheld: readonly JsonObject[],
  flightOrderId: string | undefined,
): JsonObject {
  const flightOrderIds = allowed.map((order) => text(order["id"]) ?? "");
  if (flightOrderId !== undefined) {
    const chosen = allowed.find((order) => order["id"] === flightOrderId);
    if (chosen !== undefined) {
      return chosen;
    }
    if (withheld.some((order) => order["id"] === flightOrderId)) {
      throw new AppError("OFFICE_NOT_ALLOWED");
    }
    throw new AppError("UNPROCESSABLE", {
      message: "No order with this id has this record locator.",
      details: { reason: "flight_order_not_found", flightOrderIds },
    });
  }
  const [only, ...others] = allowed;
  if (only === undefined) {
    throw new AppError("OFFICE_NOT_ALLOWED");
  }
  if (others.length > 0) {
    throw new AppError("UNPROCESSABLE", {
      message: "Several orders have this record locator: name the one to import.",
      details: { reason: "several_orders", flightOrderIds },
    });
  }
  return only;
}

/** The booking and ticketing status of an imported order (see the file header). */
export function importStateOf(
  order: Pick<CreatedOrder, "travelerIds" | "tickets">,
  segments: readonly Pick<OrderSegment, "status">[],
): {
  readonly status: string;
  readonly ticketingStatus: string;
  readonly ticketed: boolean;
  readonly cancelled: boolean;
} {
  const coverage = ticketCoverage(order.travelerIds, order.tickets);
  const state = ticketingStateOf(coverage, { issueRequested: false, policy: IMPORT_TICKETING_POLICY });
  const cancelled = segments.length > 0 && segments.every((segment) => segment.status === "CANCELLED");
  if (cancelled) {
    return {
      status: "cancelled",
      ticketingStatus: coverage === "none" ? "not_applicable" : state.ticketingStatus,
      ticketed: coverage !== "none",
      cancelled: true,
    };
  }
  return {
    status: state.status,
    ticketingStatus: state.ticketingStatus,
    ticketed: coverage !== "none",
    cancelled: false,
  };
}

/** The net amounts of an order, each with the currency's minor units (see the file header). */
export interface ImportNet {
  readonly currency: string;
  /** Σ `grandTotal`: the flights and the booked services. */
  readonly net: string;
  /** Σ `total`: the flights (base, taxes, Amadeus fees). */
  readonly flights: string;
  readonly base: string;
  readonly fees: string;
  readonly taxes: string;
  /** Σ (`grandTotal` − `total`): the booked services. */
  readonly services: string;
}

const unprocessable = (reason: string, message: string, details: JsonObject = {}): AppError =>
  new AppError("UNPROCESSABLE", { message, details: { reason, ...details } });

/** The net amounts of the order's offers; `422 UNPROCESSABLE` for offers in several currencies or unusable amounts. */
export function importNetOf(offers: readonly ParsedOffer[], minorUnits: number): ImportNet {
  const currencies = new Set(offers.map((offer) => offer.price.currency));
  const [currency] = [...currencies];
  if (currency === undefined || currencies.size !== 1) {
    throw unprocessable("order_currencies", "The order's offers are priced in several currencies.");
  }
  let net = new Money(0);
  let flights = new Money(0);
  let base = new Money(0);
  let fees = new Money(0);
  for (const offer of offers) {
    const offerFees = offer.price.fees.reduce((sum, fee) => sum.plus(fee.amount), new Money(0));
    net = net.plus(offer.price.grandTotal);
    flights = flights.plus(offer.price.total);
    base = base.plus(offer.price.base);
    fees = fees.plus(offerFees);
  }
  const services = net.minus(flights);
  const taxes = flights.minus(base).minus(fees);
  const amounts = [net, flights, base, fees, taxes, services];
  if (
    amounts.some((amount) => amount.isNegative() || amount.decimalPlaces() > minorUnits) ||
    net.gte(new Money("1e10"))
  ) {
    throw unprocessable("order_amounts", "The order's price cannot be recorded as a booking.");
  }
  const fixed = (value: MoneyValue): string => value.toFixed(minorUnits);
  return {
    currency,
    net: fixed(net),
    flights: fixed(flights),
    base: fixed(base),
    fees: fixed(fees),
    taxes: fixed(taxes),
    services: fixed(services),
  };
}

/** The selling amounts of an import (the `bookings` columns of OADR-0005 point 10). */
export interface ImportSelling {
  readonly pricingMode: "markup_rules" | "net" | "override";
  readonly markup: string;
  readonly fees: string;
  readonly total: string;
  readonly markupRuleId: string | null;
}

/** What the `markup_rules` mode needs besides the offers: the engine's facts and the tenant's rules. */
export interface ImportRulesContext {
  readonly at: Date;
  readonly minorUnits: number;
  readonly markupRules: readonly MarkupRule[];
  readonly feeRules: readonly FeeRule[];
  readonly countryOf: (code: string) => string | null;
  readonly cityOf: (code: string) => string | null;
}

/**
 * The engine input of the offers together (the fees' `pricing` step): flights' totals summed, the first offer's route,
 * travellers and source, every offer's carriers, cabins and segments, the trip type of all their itineraries.
 */
function combinedPricingInput(
  inputs: readonly PricingInput[],
  offers: readonly ParsedOffer[],
  cityOf: (code: string) => string | null,
): PricingInput {
  const [first] = inputs;
  if (first === undefined) {
    throw new PricingInputError("offers", "is empty");
  }
  if (inputs.length === 1) {
    return first;
  }
  const distinct = (values: readonly string[]): string[] => [...new Set(values)];
  return {
    ...first,
    netTotal: inputs
      .reduce((total, input) => total.plus(input.netTotal), new Money(0))
      .toFixed(first.minorUnits),
    validatingCarriers: distinct(inputs.flatMap((input) => input.validatingCarriers)),
    marketingCarriers: distinct(inputs.flatMap((input) => input.marketingCarriers)),
    cabins: distinct(inputs.flatMap((input) => input.cabins)),
    segmentCount: inputs.reduce((total, input) => total + input.segmentCount, 0),
    tripType: tripTypeOf(
      offers.flatMap((offer) =>
        offer.itineraries.map((itinerary) => ({
          origin: itinerary.segments[0]?.departure.iataCode ?? "",
          destination: itinerary.segments.at(-1)?.arrival.iataCode ?? "",
        })),
      ),
      cityOf,
    ),
  };
}

/**
 * The selling amounts of an import for its `pricing` (see the file header): `markup_rules` with `rules`, `net`, or
 * `override` with its `sellingTotal` (`422 UNPROCESSABLE` `currency_mismatch` or `selling_below_net`; `400` at
 * `/pricing/sellingTotal/amount` for more decimals than the currency has).
 */
export function importPricingOf(
  pricing: ConsolePricingRequest | undefined,
  offers: readonly ParsedOffer[],
  net: ImportNet,
  rules: ImportRulesContext,
): ImportSelling {
  const units = rules.minorUnits;
  const mode = pricing?.mode ?? "markup_rules";
  if (mode === "net") {
    return {
      pricingMode: "net",
      markup: (0).toFixed(units),
      fees: (0).toFixed(units),
      total: net.net,
      markupRuleId: null,
    };
  }
  if (mode === "override") {
    const selling = pricing?.sellingTotal;
    if (selling === undefined) {
      // refuseImportRequest refused it before anything else.
      throw new Error("importPricingOf: an override without its selling total");
    }
    if (selling.currency !== net.currency) {
      throw unprocessable("currency_mismatch", "The selling total must be in the order's currency.", {
        currency: net.currency,
      });
    }
    const amount = new Money(selling.amount);
    if (amount.decimalPlaces() > units) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          {
            path: "/pricing/sellingTotal/amount",
            code: "precision",
            message: `The currency has ${units} decimal places.`,
          },
        ],
      });
    }
    if (amount.lt(net.net)) {
      throw unprocessable("selling_below_net", "The selling total cannot be below the order's net price.", {
        net: { amount: net.net, currency: net.currency },
      });
    }
    return {
      pricingMode: "override",
      markup: amount.minus(net.net).toFixed(units),
      fees: (0).toFixed(units),
      total: amount.toFixed(units),
      markupRuleId: null,
    };
  }
  const inputs = offers.map((offer) =>
    pricingInputOf(offer, offerColumns(offer, rules.cityOf), {
      at: rules.at,
      minorUnits: units,
      netTotal: new Money(offer.price.total).toFixed(units),
      channel: "console",
      countryOf: rules.countryOf,
    }),
  );
  const markups = inputs.map((input) =>
    priceOffer(input, rules.markupRules, rules.feeRules, { kind: "search" }),
  );
  const fees = priceOffer(
    combinedPricingInput(inputs, offers, rules.cityOf),
    rules.markupRules,
    rules.feeRules,
    {
      kind: "pricing",
    },
  );
  const markup = markups.reduce((sum, result) => sum.plus(result.markupTotal), new Money(0));
  return {
    pricingMode: "markup_rules",
    markup: markup.toFixed(units),
    fees: new Money(fees.feeTotal).toFixed(units),
    total: new Money(net.net).plus(markup).plus(fees.feeTotal).toFixed(units),
    markupRuleId: markups[0]?.markupRuleId ?? null,
  };
}

/**
 * The booking's contact e-mail (the document's order): the request's `contactEmail`, the order's primary contact, the
 * first traveller's contact, the customer's address; `undefined` when there is none.
 */
export function importContactEmailOf(input: {
  readonly requested: string | undefined;
  readonly orderContacts: readonly { readonly isPrimary: boolean; readonly email: string | null }[];
  readonly travelers: readonly JsonObject[];
  readonly customerEmail: string | null;
}): string | undefined {
  const travelerEmail = records(input.travelers).flatMap((traveler) => {
    const contact = isRecord(traveler["contact"]) ? traveler["contact"] : {};
    return text(contact["emailAddress"]) ?? [];
  })[0];
  return (
    text(input.requested) ??
    input.orderContacts.find((contact) => contact.isPrimary && contact.email !== null)?.email ??
    input.orderContacts.find((contact) => contact.email !== null)?.email ??
    travelerEmail ??
    input.customerEmail ??
    undefined
  );
}

/** A document of an Amadeus traveller as `booking_travelers` seals it, or `undefined` for one without a number. */
export function storedDocumentOf(document: JsonObject): StoredDocument | undefined {
  const type = text(document["documentType"]);
  const number = text(document["number"]);
  if (type === undefined || number === undefined || !DOCUMENT_TYPES.has(type)) {
    return undefined;
  }
  const stored: Record<string, unknown> = { documentType: type, number };
  for (const field of DOCUMENT_FIELDS) {
    const value = text(document[field]);
    if (value !== undefined) {
      stored[field] = value;
    }
  }
  stored["holder"] = document["holder"] !== false;
  return stored as unknown as StoredDocument;
}

/** The city of an airport in an order's Amadeus `dictionaries.locations`, `null` when it does not say. */
export function cityLookupOf(dictionaries: unknown): (code: string) => string | null {
  const locations =
    isRecord(dictionaries) && isRecord(dictionaries["locations"]) ? dictionaries["locations"] : {};
  return (code) => {
    const location = locations[code];
    return isRecord(location) ? (text(location["cityCode"]) ?? null) : null;
  };
}

/** The main document of a traveller (the first one the traveller holds, else the first), for the readable columns. */
function mainDocumentOf(documents: readonly StoredDocument[]): StoredDocument | undefined {
  return documents.find((document) => document.holder) ?? documents[0];
}

const dateOrNull = (value: unknown): string | null =>
  typeof value === "string" && DATE.test(value) ? value : null;
const countryOrNull = (value: string | undefined): string | null =>
  value !== undefined && /^[A-Z]{2}$/.test(value) ? value : null;

/** True for an Amadeus `404` (no order with this record locator or id). */
const isNotFound = (error: unknown): error is AppError =>
  isAppError(error) && error.cause instanceof AmadeusCallError && error.cause.httpStatus === 404;

/** A supplier error a use case passes on (SUPPLIER_CODES; an Amadeus 404 as `404 NOT_FOUND`). */
function supplierAnswerOf(error: unknown, notFound: string): unknown {
  if (isNotFound(error)) {
    return new AppError("NOT_FOUND", {
      message: notFound,
      ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
      cause: error,
    });
  }
  if (!isAppError(error) || SUPPLIER_CODES.has(error.code)) {
    return error;
  }
  return new AppError("SUPPLIER_ERROR", {
    ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
    cause: error,
  });
}

/** The PostgreSQL unique violation of one of `constraints`. */
function uniqueViolation(error: unknown, constraints: ReadonlySet<string>): boolean {
  return (
    isRecord(error) &&
    error["code"] === "23505" &&
    typeof error["constraint"] === "string" &&
    constraints.has(error["constraint"])
  );
}

const orderAlreadyImported = (booking: { readonly id: string; readonly reference: string }): AppError =>
  new AppError("ORDER_ALREADY_IMPORTED", {
    message: `This order is already booking ${booking.reference}.`,
    details: { bookingId: booking.id, reference: booking.reference },
  });

/** `409 CONFLICT` for a customer who may not get a booking (as a console checkout answers it, FIX-W30-OTA). */
export function importCustomerUnavailable(customer: ImportCustomerRow | undefined): AppError {
  const disabled = customer?.status === "disabled" && customer.deletedAt === null;
  return new AppError("CONFLICT", {
    message: disabled
      ? "This customer is disabled: no booking can be attached to them."
      : "This customer deleted their account: no booking can be attached to them.",
    details: { reason: disabled ? "customer_disabled" : "customer_deleted" },
  });
}

/** Whether a customer may get an imported booking: present, neither deleted nor disabled. */
export const importableCustomer = (customer: ImportCustomerRow | undefined): customer is ImportCustomerRow =>
  customer !== undefined &&
  customer.deletedAt === null &&
  customer.status !== "deleted" &&
  customer.status !== "disabled";

// ---- The repository ---------------------------------------------------------------------------------------------------

/** Where an airport is (`reference.airports`). */
export interface AirportPlace {
  readonly country: string;
  readonly city: string | null;
}

/** What an import reads of a customer. */
export interface ImportCustomerRow {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly deletedAt: Date | null;
}

/** The tenant rows the lookup and the import read and write besides the bookings module's (ADR-0004: `tenantTx`). */
@Injectable()
export class PnrImportRepository {
  /**
   * The bookings of `environment` with one of `refs` as their main record or an associated record, or one of the
   * order ids, each with its records (`reference|originSystemCode`).
   */
  async attachedBookings(
    trx: TenantTransaction,
    environment: string,
    refs: readonly { readonly reference: string; readonly originSystemCode: string }[],
    orderIds: readonly string[],
  ): Promise<AttachedBooking[]> {
    if (refs.length === 0 && orderIds.length === 0) {
      return [];
    }
    const rows = await trx
      .selectFrom("bookings as b")
      .select([
        "b.id",
        "b.reference",
        "b.status",
        "b.amadeus_order_id as amadeusOrderId",
        "b.record_locator as recordLocator",
        "b.origin_system_code as originSystemCode",
      ])
      .where("b.environment", "=", environment)
      .where((eb) =>
        eb.or([
          ...refs.flatMap((ref) => [
            eb.and([
              eb("b.record_locator", "=", ref.reference),
              eb("b.origin_system_code", "=", ref.originSystemCode),
            ]),
            eb.exists(
              eb
                .selectFrom("booking_associated_records as r")
                .select("r.id")
                .whereRef("r.booking_id", "=", "b.id")
                .where("r.reference", "=", ref.reference)
                .where("r.origin_system_code", "=", ref.originSystemCode),
            ),
          ]),
          ...(orderIds.length === 0 ? [] : [eb("b.amadeus_order_id", "in", [...orderIds])]),
        ]),
      )
      .orderBy("b.created_at")
      .orderBy("b.id")
      .execute();
    if (rows.length === 0) {
      return [];
    }
    const associated = await trx
      .selectFrom("booking_associated_records")
      .select(["booking_id as bookingId", "reference", "origin_system_code as originSystemCode"])
      .where(
        "booking_id",
        "in",
        rows.map((row) => row.id),
      )
      .execute();
    return rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      status: row.status,
      amadeusOrderId: row.amadeusOrderId,
      records: [
        ...(row.recordLocator === null || row.originSystemCode === null
          ? []
          : [recordKey(row.recordLocator, row.originSystemCode)]),
        ...associated
          .filter((record) => record.bookingId === row.id)
          .map((record) => recordKey(record.reference, record.originSystemCode)),
      ],
    }));
  }

  /** The customer `id`, or `undefined`. */
  async customer(trx: TenantTransaction, id: string): Promise<ImportCustomerRow | undefined> {
    return await trx
      .selectFrom("customers")
      .select(["id", "email", "status", "deleted_at as deletedAt"])
      .where("id", "=", id)
      .executeTakeFirst();
  }

  /** The ISO country and the IATA city of the airports of `codes` (`reference.airports`). */
  async airportPlaces(trx: TenantTransaction, codes: readonly string[]): Promise<Map<string, AirportPlace>> {
    const wanted = [...new Set(codes.filter((code) => /^[A-Z]{3}$/.test(code)))];
    if (wanted.length === 0) {
      return new Map();
    }
    const rows = await trx
      .selectFrom("reference.airports")
      .select(["iata_code", "country_code", "city_code"])
      .where("iata_code", "in", wanted)
      .execute();
    return new Map(
      rows.map((row) => [row.iata_code, { country: row.country_code, city: row.city_code ?? null }]),
    );
  }

  /** Replaces the stored response of a `supplier_requests` row (`withheldBody`), through the table's storage rules. */
  async replaceSupplierResponse(trx: TenantTransaction, id: string, body: unknown): Promise<void> {
    const stored = supplierRequestBody(body);
    await trx
      .updateTable("supplier_requests")
      .set({ response_body: stored.json, ...(stored.truncated ? { truncated: true } : {}) })
      .where("id", "=", id)
      .execute();
  }

  /** Links the import's `supplier_requests` rows to its booking (written before the booking existed). */
  async linkSupplierRequests(
    trx: TenantTransaction,
    ids: readonly string[],
    bookingId: string,
  ): Promise<void> {
    if (ids.length > 0) {
      await trx
        .updateTable("supplier_requests")
        .set({ booking_id: bookingId })
        .where("id", "in", [...ids])
        .execute();
    }
  }
}

// ---- The service -------------------------------------------------------------------------------------------------------

/** An Amadeus answer with its call. */
interface Reply {
  readonly body: JsonObject;
  readonly call: AmadeusCallInfo;
}

/** What T1 of an import read. */
interface ImportClaim {
  readonly customer: ImportCustomerRow | undefined;
}

/** The order an import records, read and checked. */
interface ImportOrder {
  readonly order: CreatedOrder;
  readonly included: JsonObject;
  readonly lookupRequestId: string | null;
  readonly orderRequestId: string | null;
  readonly connection: ResolvedAmadeusConnection;
}

@Injectable()
export class PnrImportService {
  private readonly baseDomain: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly repository: PnrImportRepository,
    private readonly bookings: BookingsRepository,
    private readonly consoleBookings: ConsoleBookingsService,
    private readonly travelerDocuments: BookingTravelerDocuments,
    private readonly recorder: OrderRecorder,
    private readonly rules: RulesRepository,
    private readonly amadeus: AmadeusClient,
    private readonly connections: ConnectionResolver,
    private readonly audit: StaffActionsWriter,
    private readonly outbox: OutboxService,
    private readonly tenants: TenantContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    config: ConfigService<SharedConfig, true>,
    @InjectPinoLogger(PnrImportService.name) private readonly logger: PinoLogger,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  // ---- console.bookings.findByRecordLocator ------------------------------------------------------------------------

  /** The tenant's orders with this record locator, each linked to its booking (see the file header). */
  async findByRecordLocator(query: PnrLookupQuery): Promise<PnrLookupResult> {
    const tenant = this.tenants.require();
    const ref = { reference: query.reference, originSystemCode: query.originSystemCode };
    const include: "bags"[] = [...(query.include ?? [])];
    // The local index first: the bookings that already hold this record locator.
    const local = await this.tx.run((trx) =>
      this.repository.attachedBookings(trx, tenant.environment, [ref], []),
    );
    const amadeusQuery = { ...ref, ...(include.length > 0 ? { include: [...include] } : {}) };
    const reply = await this.byReference(tenant, OPERATIONS.lookup, amadeusQuery);
    const orders = await this.tenantOrders(tenant, "lookup", query.reference, reply);
    const unlinked = orders.allowed.filter((order) => attachedBookingOf(order, local) === undefined);
    const byOrder =
      unlinked.length === 0
        ? []
        : await this.tx.run((trx) =>
            this.repository.attachedBookings(
              trx,
              tenant.environment,
              [],
              unlinked.flatMap((order) => text(order["id"]) ?? []),
            ),
          );
    const attached = [...local, ...byOrder];
    const matches = orders.allowed.map((order) => pnrMatchOf(order, attached));
    const supplierRequestId = this.requireRecorded(reply.call, OPERATIONS.lookup);
    await this.audit.recordAlone({
      action: PNR_ACTIONS.lookup,
      targetType: RECORD_LOCATOR_TARGET,
      targetId: query.reference,
      after: {
        originSystemCode: query.originSystemCode,
        flightOrderIds: matches.map((match) => match.flightOrderId),
        attachedBookingIds: matches.flatMap((match) => match.bookingId ?? []),
        withheldOrders: orders.withheld.length,
        supplierRequestId,
      },
    });
    const included = isRecord(reply.body["included"]) ? reply.body["included"] : undefined;
    const complete = orders.withheld.length === 0;
    return {
      reference: query.reference,
      originSystemCode: query.originSystemCode,
      retrievedAt: this.clock.now().toISOString(),
      matches,
      // Another office's bag options and dictionaries are not shown (withheldBody).
      included:
        complete && included !== undefined && isRecord(included["bags"])
          ? ({ bags: included["bags"] } as PnrLookupResult["included"])
          : null,
      dictionaries: complete ? dictionariesOf(reply.body["dictionaries"]) : null,
      warnings: warningsOf(reply.body["warnings"]),
      call: this.callOf(tenant, "getFlightOrderByReference", reply.call, supplierRequestId, {}, amadeusQuery),
    };
  }

  // ---- console.bookings.import -------------------------------------------------------------------------------------

  /** Imports the tenant's Amadeus order with this record locator as a booking; answers the console booking. */
  async import(body: ConsoleImportRequest): Promise<ConsoleBooking> {
    refuseImportRequest(body);
    const tenant = this.tenants.require();
    const ref = {
      reference: body.reference,
      originSystemCode: body.originSystemCode ?? DEFAULT_ORIGIN_SYSTEM_CODE,
    };
    const claim = await this.tx.run((trx) => this.claimImport(trx, tenant, ref, body.customerId));
    const read = await this.readImportOrder(tenant, ref, body.flightOrderId);
    const recorded = await this.recordImport(tenant, body, ref, claim, read);
    const booking = await this.consoleBookings.get(recorded.bookingId, { refresh: false });
    return recorded.confirmation === "refused"
      ? { ...booking, warnings: [...(booking.warnings ?? []), CONFIRMATION_REFUSED_WARNING] }
      : booking;
  }

  /** T1 of an import: the record locator unknown here, the customer one of the tenant's who may get a booking. */
  private async claimImport(
    trx: TenantTransaction,
    tenant: RequestTenant,
    ref: { readonly reference: string; readonly originSystemCode: string },
    customerId: string | undefined,
  ): Promise<ImportClaim> {
    const [known] = await this.repository.attachedBookings(trx, tenant.environment, [ref], []);
    if (known !== undefined) {
      throw orderAlreadyImported(known);
    }
    if (customerId === undefined) {
      return { customer: undefined };
    }
    const customer = await this.repository.customer(trx, customerId);
    if (customer === undefined) {
      throw new AppError("NOT_FOUND", { message: "No customer with this id." });
    }
    if (!importableCustomer(customer)) {
      throw importCustomerUnavailable(customer);
    }
    return { customer };
  }

  /** The order to import: by record locator, the tenant's only, then its complete Management GET (no transaction). */
  private async readImportOrder(
    tenant: RequestTenant,
    ref: { readonly reference: string; readonly originSystemCode: string },
    flightOrderId: string | undefined,
  ): Promise<ImportOrder> {
    const reply = await this.byReference(tenant, OPERATIONS.import, { ...ref, include: ["bags"] });
    const orders = await this.tenantOrders(tenant, "import", ref.reference, reply);
    let chosen: JsonObject;
    try {
      chosen = chooseImportOrder(orders.allowed, orders.withheld, flightOrderId);
    } catch (error) {
      if (isAppError(error) && error.code === "OFFICE_NOT_ALLOWED") {
        await this.denyOffice("import", ref.reference, orders.withheld.length);
      }
      throw error;
    }
    const orderId = text(chosen["id"]);
    const office = orderOfficeOf(chosen);
    if (orderId === undefined || office === null || !AMADEUS_OFFICE_ID.test(office)) {
      throw unprocessable("order_not_importable", "Amadeus gave this order without an id or an office.");
    }
    let full: Reply;
    try {
      full = await this.objectReply(() =>
        this.amadeus.getFlightOrder(this.context(tenant, OPERATIONS.import, office), {
          flightOrderId: orderId,
          query: { include: ["bags"] },
        }),
      );
    } catch (error) {
      throw supplierAnswerOf(error, "Amadeus no longer has this order.");
    }
    const data = isRecord(full.body["data"]) ? full.body["data"] : undefined;
    if (data === undefined) {
      throw new AppError("SUPPLIER_ERROR", { message: "Amadeus answered without the order." });
    }
    if (!isTenantOrder(data, orders.connection.officeIds)) {
      // The complete order names another office than its by-reference answer did: never recorded, nor kept.
      await this.withhold(full, [data]);
      await this.denyOffice("import", ref.reference, 1);
      throw new AppError("OFFICE_NOT_ALLOWED");
    }
    const order = readCreatedOrder(full.body);
    if (order === undefined) {
      throw unprocessable(
        "order_not_importable",
        "The order has no record locator or flights that a booking can hold.",
      );
    }
    return {
      order,
      included: isRecord(full.body["included"]) ? full.body["included"] : {},
      lookupRequestId: orders.supplierRequestId,
      orderRequestId: full.call.supplierRequestId,
      connection: orders.connection,
    };
  }

  /** T2 of an import (see the file header), drawn again on the rare collision of a new booking reference. */
  private async recordImport(
    tenant: RequestTenant,
    body: ConsoleImportRequest,
    ref: { readonly reference: string; readonly originSystemCode: string },
    claim: ImportClaim,
    read: ImportOrder,
  ): Promise<RecordedImport> {
    // The documents are sealed before the transaction (the row ids are their associated data).
    const travelers = await this.travelerRows(tenant, read.order);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.tx.run((trx) => this.recordIn(trx, tenant, body, ref, claim, read, travelers));
      } catch (error) {
        if (uniqueViolation(error, new Set([REFERENCE_UNIQUE])) && attempt < 3) {
          continue;
        }
        if (uniqueViolation(error, ORDER_UNIQUE)) {
          // A concurrent import of the same order committed first.
          const [known] = await this.tx.run((trx) => this.knownBookings(trx, tenant, ref, read.order));
          throw known === undefined ? error : orderAlreadyImported(known);
        }
        throw error;
      }
    }
  }

  private async knownBookings(
    trx: TenantTransaction,
    tenant: RequestTenant,
    ref: { readonly reference: string; readonly originSystemCode: string },
    order: CreatedOrder,
  ): Promise<AttachedBooking[]> {
    return await this.repository.attachedBookings(
      trx,
      tenant.environment,
      [
        ref,
        ...order.records.map((record) => ({
          reference: record.reference,
          originSystemCode: record.originSystemCode,
        })),
      ],
      [order.id],
    );
  }

  private async recordIn(
    trx: TenantTransaction,
    tenant: RequestTenant,
    body: ConsoleImportRequest,
    ref: { readonly reference: string; readonly originSystemCode: string },
    claim: ImportClaim,
    read: ImportOrder,
    travelers: readonly SealedTraveler[],
  ): Promise<RecordedImport> {
    const { order } = read;
    const now = this.clock.now();
    const [known] = await this.knownBookings(trx, tenant, ref, order);
    if (known !== undefined) {
      throw orderAlreadyImported(known);
    }
    const settings = await this.bookings.settings(trx);
    const minorUnits = (await this.rules.currencyMinorUnits(trx, order.offers[0]?.price.currency ?? "")) ?? 2;
    const net = importNetOf(order.offers, minorUnits);
    const places = await this.repository.airportPlaces(
      trx,
      order.offers.flatMap((offer) =>
        offer.itineraries.flatMap((itinerary) =>
          itinerary.segments.flatMap((segment) => [segment.departure.iataCode, segment.arrival.iataCode]),
        ),
      ),
    );
    const dictionaryCity = cityLookupOf(order.dictionaries);
    const cityOf = (code: string): string | null => places.get(code)?.city ?? dictionaryCity(code);
    const selling = await this.selling(trx, body, order, net, {
      at: now,
      minorUnits,
      markupRules: [],
      feeRules: [],
      countryOf: (code) => places.get(code)?.country ?? null,
      cityOf,
    });
    const segments = await this.segmentRows(trx, order, now);
    const state = importStateOf(order, orderSegmentsOf(order));
    const contacts = contactValuesOf(records(order.data["contacts"]), "STANDARD");
    const contactEmail = importContactEmailOf({
      requested: body.contactEmail,
      orderContacts: contacts,
      travelers: records(order.data["travelers"]),
      customerEmail: claim.customer?.email ?? null,
    });
    if (contactEmail === undefined) {
      throw unprocessable(
        "contact_email_required",
        "The order has no e-mail address: give the booking's contact e-mail.",
      );
    }
    const id = this.ids.newId("bkg");
    const reference = newBookingReference();
    const lastTicketingDate = lastTicketingDateOf(order.offers);
    const deadlineLocal = deadlineLocalOf(lastTicketingDate, order.ticketingAgreement);
    const [deadline] =
      deadlineLocal === null
        ? [undefined]
        : await this.bookings.instants(trx, [{ local: deadlineLocal, zone: settings?.timeZone ?? "UTC" }]);
    const first = segments.reduce<Date | undefined>(
      (earliest, row) =>
        earliest === undefined || row.departure_at < earliest ? row.departure_at : earliest,
      undefined,
    );
    const last = segments.reduce<Date | undefined>(
      (latest, row) => (latest === undefined || row.arrival_at > latest ? row.arrival_at : latest),
      undefined,
    );
    if (first === undefined || last === undefined) {
      throw unprocessable("order_not_importable", "The order has no flights that a booking can hold.");
    }
    const lead = travelers.find((traveler) => traveler.row.traveler_type !== "HELD_INFANT") ?? travelers[0];
    const firstItinerary = segments.filter((row) => row.itinerary_index === 0);
    const staffId = tenant.actor.type === "staff" ? tenant.actor.id : null;
    const validating = order.offers[0]?.validatingAirlineCodes[0];
    const included: JsonObject = { bags: read.included["bags"] ?? {}, bagsLoadedAt: now.toISOString() };
    await this.bookings.insertBooking(trx, {
      id,
      environment: tenant.environment,
      reference,
      channel: "import",
      customer_id: claim.customer?.id ?? null,
      created_by_staff_id: staffId,
      status: state.status,
      amadeus_order_id: order.id,
      record_locator: order.records[0]?.reference ?? null,
      origin_system_code: order.records[0]?.originSystemCode ?? null,
      supplier_connection_id: read.connection.connectionId,
      queuing_office_id: order.queuingOfficeId,
      owner_office_id: order.ownerOfficeId,
      last_ticketing_date: lastTicketingDate,
      ticketing_deadline_at: deadline ?? null,
      ticketing_agreement:
        order.ticketingAgreement === null ? null : JSON.stringify(order.ticketingAgreement),
      automated_process: JSON.stringify(order.automatedProcess),
      issue_requested: false,
      issued_at: state.ticketed ? now : null,
      ticketing_status: state.ticketingStatus,
      trip_type: tripTypeOf(
        order.offers.flatMap((offer) =>
          offer.itineraries.map((itinerary) => ({
            origin: itinerary.segments[0]?.departure.iataCode ?? "",
            destination: itinerary.segments.at(-1)?.arrival.iataCode ?? "",
          })),
        ),
        cityOf,
      ),
      origin_iata: segments[0]?.departure_iata ?? null,
      destination_iata: firstItinerary.at(-1)?.arrival_iata ?? segments.at(-1)?.arrival_iata ?? null,
      first_departure_at: first,
      last_arrival_at: last,
      validating_carrier: validating !== undefined && /^[A-Z0-9]{2}$/.test(validating) ? validating : null,
      travelers_count: Math.min(18, Math.max(1, travelers.length)),
      currency: net.currency,
      pricing_mode: selling.pricingMode,
      markup_rule_id: selling.markupRuleId,
      net_amount: net.net,
      net_base_amount: net.base,
      net_fees_amount: net.fees,
      net_services_amount: net.services,
      markup_amount: selling.markup,
      fees_amount: selling.fees,
      card_fee_amount: "0",
      // The booked services are sold at their net price (see the file header).
      ancillaries_amount: net.services,
      taxes_amount: net.taxes,
      total_amount: selling.total,
      contact_email: contactEmail,
      lead_last_name: (lead?.row.last_name ?? "").toUpperCase(),
      commissions: JSON.stringify(records(order.data["commissions"])),
      form_of_payments: JSON.stringify(redactPayload(order.formOfPayments)),
      form_of_identifications: JSON.stringify(maskedIdentifications(order.data["formOfIdentifications"])),
      order_snapshot: JSON.stringify(keptOrderDataOf(order.data)),
      order_included: JSON.stringify(redactPayload(included)),
      order_dictionaries: order.dictionaries === undefined ? null : JSON.stringify(order.dictionaries),
      last_synced_at: now,
      tags: [...(body.tags ?? [])],
      ...(state.cancelled
        ? { cancelled_at: now, cancelled_by: "airline", cancel_reason: AIRLINE_CANCEL_REASON }
        : {}),
      version: 1,
      created_at: now,
      updated_at: now,
    });
    if (claim.customer !== undefined) {
      // Read again after the insert, whose foreign key waited for a deletion that held the customer: an account.delete
      // that committed meanwhile refuses the import, and nothing is written.
      const current = await this.repository.customer(trx, claim.customer.id);
      if (!importableCustomer(current)) {
        throw importCustomerUnavailable(current);
      }
    }
    const travelerRowIds = new Map(
      travelers.map((traveler) => [traveler.amadeusTravelerId, traveler.row.id]),
    );
    await this.bookings.insertChildren(trx, {
      associatedRecords: order.records.map((record, index) => ({
        id: this.ids.newId("bar"),
        booking_id: id,
        reference: record.reference,
        origin_system_code: record.originSystemCode,
        creation_date: record.creationDate,
        flight_offer_id: record.flightOfferId,
        is_primary: index === 0,
        created_at: now,
        updated_at: now,
      })),
      travelers: travelers.map((traveler) => ({
        ...traveler.row,
        booking_id: id,
        created_at: now,
        updated_at: now,
      })),
      contacts: contacts.map((contact, index) => ({
        id: this.ids.newId("bco"),
        booking_id: id,
        purpose: contact.purpose,
        is_primary: contact.isPrimary,
        first_name: contact.firstName,
        last_name: contact.lastName,
        company_name: contact.companyName,
        email: contact.email,
        phones: JSON.stringify(contact.phones),
        address: contact.address === null ? null : JSON.stringify(contact.address),
        language: contact.language,
        // The order's order, one millisecond apart: the table has no position column.
        created_at: new Date(now.getTime() + index),
        updated_at: now,
      })),
      segments: segments.map((row) => ({ ...row, booking_id: id })),
      remarks: orderRemarksOf(order.data["remarks"]).map((entry, index) => ({
        id: this.ids.newId("rmk"),
        booking_id: id,
        kind: entry.kind,
        sub_type: entry.subType,
        category: entry.category,
        airline_code: entry.airlineCode,
        keyword: entry.keyword,
        text: entry.text,
        traveler_ids: entry.travelerIds,
        flight_offer_ids: entry.flightOfferIds,
        // Remarks made outside Velexis are the staff's to show (none is customer-visible by default).
        visible_to_customer: false,
        created_at: new Date(now.getTime() + index),
        updated_at: now,
      })),
      tickets: this.recorder.ticketRows(id, order, travelerRowIds, now),
    });
    const supplierRequestIds = [read.lookupRequestId, read.orderRequestId].filter(
      (value): value is string => value !== null,
    );
    await this.repository.linkSupplierRequests(trx, supplierRequestIds, id);
    const actor = eventActorOf(tenant.actor);
    const recordLocator = order.records[0]?.reference ?? ref.reference;
    await this.recorder.event(trx, id, {
      type: BOOKING_IMPORTED_EVENT,
      actor,
      statusTo: state.status,
      summary: `Amadeus order ${recordLocator} imported.`,
      data: {
        recordLocator,
        flightOrderId: order.id,
        pricingMode: selling.pricingMode,
        ticketingStatus: state.ticketingStatus,
      },
      visibleToCustomer: false,
      supplierRequestId: read.orderRequestId,
      requestId: this.requestId(tenant),
      now,
    });
    if (body.note !== undefined && body.note.trim() !== "") {
      await this.bookings.insertEvent(trx, {
        id: this.ids.newId("evt"),
        booking_id: id,
        type: STAFF_NOTE_EVENT,
        actor_type: actor.type,
        actor_id: actor.id,
        summary: body.note,
        data: JSON.stringify(redactPayload({ text: body.note })),
        visible_to_customer: false,
        request_id: this.requestId(tenant),
        created_at: new Date(now.getTime() + 1),
        updated_at: now,
      });
    }
    const confirmation =
      body.sendConfirmation === true
        ? await this.confirmationEmail(trx, tenant, {
            id,
            reference,
            recordLocator,
            customerId: claim.customer?.id ?? null,
            contactEmail,
            total: { amount: selling.total, currency: net.currency },
            contact: contacts.find((contact) => contact.isPrimary),
            travelers,
            segments,
            locale: settings?.defaultLocale ?? "en",
          })
        : "not_requested";
    await this.audit.record(trx, {
      action: PNR_ACTIONS.import,
      targetType: "booking",
      targetId: id,
      bookingId: id,
      reason: body.reason ?? null,
      after: {
        recordLocator,
        flightOrderId: order.id,
        status: state.status,
        ticketingStatus: state.ticketingStatus,
        pricingMode: selling.pricingMode,
        total: { amount: selling.total, currency: net.currency },
        customerId: claim.customer?.id ?? null,
        confirmation,
        supplierRequestIds,
      },
    });
    return { bookingId: id, confirmation };
  }

  /**
   * The selling amounts of the request's `pricing`; for `markup_rules` with the tenant's active rules, loaded only
   * then (`context` gives the engine's other facts).
   */
  private async selling(
    trx: TenantTransaction,
    body: ConsoleImportRequest,
    order: CreatedOrder,
    net: ImportNet,
    context: ImportRulesContext,
  ): Promise<ImportSelling> {
    if ((body.pricing?.mode ?? "markup_rules") !== "markup_rules") {
      return importPricingOf(body.pricing, order.offers, net, context);
    }
    const active = await this.rules.loadActiveRules(trx);
    if (active.invalidRules.length > 0) {
      this.logger.warn(
        { invalidRules: active.invalidRules.map(({ table, id, reason }) => ({ table, id, reason })) },
        "pricing.pricing_rules_skipped",
      );
    }
    try {
      return importPricingOf(body.pricing, order.offers, net, {
        ...context,
        markupRules: active.markupRules,
        feeRules: active.feeRules,
      });
    } catch (error) {
      if (error instanceof PricingInputError) {
        throw unprocessable("order_amounts", "The order's price cannot be priced with the markup rules.");
      }
      throw error;
    }
  }

  /** The segment rows of the order, their instants read in the airports' time zones (UTC when unknown). */
  private async segmentRows(
    trx: TenantTransaction,
    order: CreatedOrder,
    now: Date,
  ): Promise<Array<Omit<Insertable<Db["booking_segments"]>, "booking_id"> & SegmentTimes>> {
    const segments = orderSegmentsOf(order);
    const zones = await this.bookings.airportTimeZones(
      trx,
      segments.flatMap((segment) => [segment.departureIata, segment.arrivalIata]),
    );
    const instants = await this.bookings.instants(
      trx,
      segments.flatMap((segment) => [
        { local: segment.departureLocal, zone: zones.get(segment.departureIata) ?? "UTC" },
        { local: segment.arrivalLocal, zone: zones.get(segment.arrivalIata) ?? "UTC" },
      ]),
    );
    return segments.map((plan, index) => {
      const departureAt = instants[index * 2] ?? now;
      const arrival = instants[index * 2 + 1] ?? departureAt;
      // An arrival before the departure (unknown zones) would break `booking_segments_time_ck`.
      const arrivalAt = arrival.getTime() < departureAt.getTime() ? departureAt : arrival;
      return {
        id: this.ids.newId("seg"),
        amadeus_flight_offer_id: plan.amadeusFlightOfferId,
        amadeus_segment_id: plan.amadeusSegmentId,
        itinerary_index: plan.itineraryIndex,
        segment_index: plan.segmentIndex,
        carrier_code: plan.carrierCode,
        flight_number: plan.flightNumber,
        operating_carrier_code: plan.operatingCarrierCode,
        aircraft_code: plan.aircraftCode,
        departure_iata: plan.departureIata,
        departure_terminal: plan.departureTerminal,
        departure_local: plan.departureLocal,
        departure_at: departureAt,
        arrival_iata: plan.arrivalIata,
        arrival_terminal: plan.arrivalTerminal,
        arrival_local: plan.arrivalLocal,
        arrival_at: arrivalAt,
        duration_minutes: plan.durationMinutes,
        number_of_stops: plan.numberOfStops,
        stops: plan.stops.length === 0 ? null : JSON.stringify(plan.stops),
        cabin: plan.cabin,
        booking_class: plan.bookingClass,
        fare_basis: plan.fareBasis,
        branded_fare: plan.brandedFare,
        included_checked_bags:
          plan.includedCheckedBags === null ? null : JSON.stringify(plan.includedCheckedBags),
        fare_details: JSON.stringify(plan.fareDetails),
        co2_emissions: plan.co2Emissions.length === 0 ? null : JSON.stringify(plan.co2Emissions),
        ...(plan.status === null ? {} : { status: plan.status }),
        ...(plan.isFlown === null ? {} : { is_flown: plan.isFlown }),
        created_at: now,
        updated_at: now,
      };
    });
  }

  /** The order's travellers as booking rows, their documents and discount cards sealed (decrypted data in memory). */
  private async travelerRows(tenant: RequestTenant, order: CreatedOrder): Promise<SealedTraveler[]> {
    const pricings = new Map(
      order.offers.flatMap((offer) =>
        offer.travelerPricings.map((pricing) => [pricing.travelerId, pricing] as const),
      ),
    );
    const sealed: SealedTraveler[] = [];
    for (const traveler of records(order.data["travelers"])) {
      const amadeusTravelerId = text(traveler["id"]);
      if (amadeusTravelerId === undefined) {
        continue;
      }
      const pricing = pricings.get(amadeusTravelerId);
      const name = isRecord(traveler["name"]) ? traveler["name"] : {};
      const documents = records(traveler["documents"]).flatMap(
        (document) => storedDocumentOf(document) ?? [],
      );
      const discounts = records(traveler["discountEligibility"]) as AmadeusDiscount[];
      const id = this.ids.newId("btr");
      const sealedDocuments = await this.travelerDocuments.seal(tenant.schemaName, id, documents, discounts);
      const main = mainDocumentOf(documents);
      const gender = text(traveler["gender"]);
      const type = pricing?.travelerType;
      sealed.push({
        amadeusTravelerId,
        row: {
          id,
          amadeus_traveler_id: amadeusTravelerId,
          traveler_type: type !== undefined && TRAVELER_TYPES.has(type) ? type : "ADULT",
          fare_option: pricing?.fareOption ?? null,
          associated_adult_id: pricing?.associatedAdultId ?? null,
          first_name: text(name["firstName"]) ?? "",
          middle_name: text(name["middleName"]) ?? null,
          last_name: text(name["lastName"]) ?? "",
          second_last_name: text(name["secondLastName"]) ?? null,
          date_of_birth: dateOrNull(traveler["dateOfBirth"]),
          gender: gender !== undefined && GENDERS.has(gender) ? gender : null,
          contact: isRecord(traveler["contact"]) ? JSON.stringify(traveler["contact"]) : null,
          documents_ciphertext: sealedDocuments.documentsCiphertext,
          discount_eligibility_ciphertext: sealedDocuments.discountEligibilityCiphertext,
          encryption_key_id: sealedDocuments.encryptionKeyId,
          document_type: main?.documentType ?? null,
          document_last4: main === undefined ? null : main.number.slice(-4),
          document_expiry_date: dateOrNull(main?.expiryDate),
          document_issuance_country: countryOrNull(main?.issuanceCountry),
          document_nationality: countryOrNull(main?.nationality),
          loyalty_programs: JSON.stringify(records(traveler["loyaltyPrograms"])),
          emergency_contact: isRecord(traveler["emergencyContact"])
            ? JSON.stringify(traveler["emergencyContact"])
            : null,
        },
      });
    }
    return sealed;
  }

  /**
   * The outbox `booking.confirmed` of an import with `sendConfirmation`, as the record step queues it (dedupe key
   * `booking.confirmed:<bkg_…>`). An e-mail the outbox refuses is logged and answered `refused`: the booking is
   * recorded all the same, and the staff action says so.
   */
  private async confirmationEmail(
    trx: TenantTransaction,
    tenant: RequestTenant,
    input: {
      readonly id: string;
      readonly reference: string;
      readonly recordLocator: string;
      readonly customerId: string | null;
      readonly contactEmail: string;
      readonly total: MoneyAmount;
      readonly contact: { readonly firstName: string | null; readonly lastName: string | null } | undefined;
      readonly travelers: readonly SealedTraveler[];
      readonly segments: readonly Omit<Insertable<Db["booking_segments"]>, "booking_id">[];
      readonly locale: string;
    },
  ): Promise<"queued" | "refused"> {
    try {
      await this.outbox.enqueue(trx, {
        templateKey: "booking.confirmed",
        to: input.contactEmail,
        locale: input.locale,
        customerId: input.customerId,
        bookingId: input.id,
        dedupeKey: `booking.confirmed:${input.id}`,
        data: {
          booking: {
            reference: input.reference,
            recordLocator: input.recordLocator,
            url: `${storefrontUrl(tenant.key, this.baseDomain)}/booking.html?id=${input.id}`,
            total: input.total,
            contact: { firstName: input.contact?.firstName ?? "", lastName: input.contact?.lastName ?? "" },
            travellers: input.travelers.map((traveler) => ({
              firstName: traveler.row.first_name,
              lastName: traveler.row.last_name,
            })),
            segments: input.segments.map((segment) => ({
              origin: segment.departure_iata,
              destination: segment.arrival_iata,
              departureAt: segment.departure_local,
              arrivalAt: segment.arrival_local,
              carrierCode: segment.carrier_code,
              flightNumber: segment.flight_number,
            })),
          },
        },
      });
      return "queued";
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.error({ bookingId: input.id, err: error }, "console.import_confirmation_invalid");
      return "refused";
    }
  }

  // ---- Amadeus and the office isolation ------------------------------------------------------------------------------

  /** Get Flight Order By Record Locator (no transaction open). */
  private async byReference(
    tenant: RequestTenant,
    operation: string,
    query: { readonly reference: string; readonly originSystemCode: string; readonly include?: "bags"[] },
  ): Promise<Reply> {
    try {
      return await this.objectReply(() =>
        this.amadeus.getFlightOrderByReference(this.context(tenant, operation, null), {
          query: { ...query, ...(query.include === undefined ? {} : { include: [...query.include] }) },
        }),
      );
    } catch (error) {
      throw supplierAnswerOf(error, "Amadeus has no order with this record locator.");
    }
  }

  /** A call whose answer must be a JSON object (`502 SUPPLIER_ERROR` otherwise). */
  private async objectReply(
    send: () => Promise<{ readonly body: unknown; readonly call: AmadeusCallInfo }>,
  ): Promise<Reply> {
    const reply = await send();
    if (!isRecord(reply.body)) {
      throw new AppError("SUPPLIER_ERROR", {
        message: "Amadeus answered with something that is not an order.",
      });
    }
    return { body: reply.body, call: reply.call };
  }

  /**
   * The tenant's orders of a by-reference answer (see the file header): another office's are withheld from the
   * answer and from the tenant's `supplier_requests` row; none left is `403 OFFICE_NOT_ALLOWED`, `denied`. An answer
   * without any order is `404 NOT_FOUND`.
   */
  private async tenantOrders(
    tenant: RequestTenant,
    kind: "lookup" | "import",
    reference: string,
    reply: Reply,
  ): Promise<{
    readonly allowed: JsonObject[];
    readonly withheld: JsonObject[];
    readonly connection: ResolvedAmadeusConnection;
    readonly supplierRequestId: string | null;
  }> {
    const orders = records(reply.body["data"]);
    if (orders.length === 0) {
      throw new AppError("NOT_FOUND", { message: "Amadeus has no order with this record locator." });
    }
    const connection = await this.connections.resolve(tenant.tenantId, tenant.environment);
    const { allowed, withheld } = partitionOrders(orders, connection.officeIds);
    if (withheld.length > 0) {
      await this.withhold(reply, withheld);
      this.logger.warn(
        { operation: OPERATIONS[kind], withheldOrders: withheld.length, allowedOrders: allowed.length },
        "console.pnr_office_not_allowed",
      );
    }
    if (allowed.length === 0) {
      await this.denyOffice(kind, reference, withheld.length);
      throw new AppError("OFFICE_NOT_ALLOWED", {
        message: "This record locator belongs to an office outside this OTA.",
      });
    }
    return { allowed, withheld, connection, supplierRequestId: reply.call.supplierRequestId };
  }

  /** Keeps the orders of other offices out of the tenant's `supplier_requests` row of `reply` (`withheldBody`). */
  private async withhold(reply: Reply, withheld: readonly JsonObject[]): Promise<void> {
    const id = reply.call.supplierRequestId;
    if (id !== null && withheld.length > 0) {
      await this.tx.run((trx) =>
        this.repository.replaceSupplierResponse(trx, id, withheldBody(reply.body, withheld)),
      );
    }
  }

  /**
   * The `denied` staff action of a call refused for another office's order, with the record locator as its target
   * (in a transaction of its own; the audit interceptor then writes no second row).
   */
  private async denyOffice(
    kind: "lookup" | "import",
    reference: string,
    withheldOrders: number,
  ): Promise<void> {
    await this.audit.recordAlone({
      action: consoleAction(OPERATION_IDS[kind]),
      outcome: "denied",
      targetType: RECORD_LOCATOR_TARGET,
      targetId: reference,
      after: { code: "OFFICE_NOT_ALLOWED", withheldOrders },
    });
  }

  /** The `supplier_requests` id of a call the answer names; a call whose row could not be written fails the request. */
  private requireRecorded(call: AmadeusCallInfo, operation: string): string {
    if (call.supplierRequestId === null) {
      // The answer names its supplier_requests row, which could not be written (the client's log line says why).
      throw new Error(`${operation}: the Amadeus call could not be recorded`);
    }
    return call.supplierRequestId;
  }

  /** The call information of an answer (ConsoleAmadeusCall). */
  private callOf(
    tenant: RequestTenant,
    name: AmadeusOperationName,
    call: AmadeusCallInfo,
    supplierRequestId: string,
    pathParams: Readonly<Record<string, string>>,
    query: Readonly<Record<string, unknown>>,
  ): ConsoleAmadeusCall {
    const spec = AMADEUS_OPERATIONS[name];
    return {
      supplierRequestId,
      environment: tenant.environment,
      officeId: call.officeId,
      amadeusApi: spec.api,
      amadeusOperationId: spec.operationId,
      httpMethod: spec.method,
      path: requestPath(spec.path, pathParams, query),
      httpStatus: call.status,
      durationMs: call.durationMs,
      correlationId: call.correlationId,
    };
  }

  private context(tenant: RequestTenant, operation: string, office: string | null): AmadeusCallContext {
    return {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation,
      requestId: this.requestId(tenant),
      ...(tenant.actor.type === "staff" && tenant.actor.id !== null ? { staffId: tenant.actor.id } : {}),
      ...(office === null ? {} : { orderOffice: office }),
    };
  }

  private requestId(tenant: RequestTenant): string {
    return this.tenants.requestId() ?? tenant.requestId;
  }
}

/** What T2 of an import recorded. */
interface RecordedImport {
  readonly bookingId: string;
  readonly confirmation: "queued" | "refused" | "not_requested";
}

/** The instants of a segment row. */
interface SegmentTimes {
  readonly departure_at: Date;
  readonly arrival_at: Date;
}

/** A traveller row of an import, its documents sealed, without its booking. */
interface SealedTraveler {
  readonly amadeusTravelerId: string;
  readonly row: Omit<Insertable<Db["booking_travelers"]>, "booking_id"> & {
    readonly id: string;
    readonly traveler_type: string;
    readonly first_name: string;
    readonly last_name: string;
  };
}
