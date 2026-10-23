// The diff of the booking sync (OBE-045; ota/docs/flows/ticketing-and-documents.md §3 step 5, db README §6 "Booking
// sync", the document's consoleResyncBooking): what a Flight Order Management GET of a booking's order says changed
// since the booking was last recorded, without any I/O. booking-sync.service.ts reads the order and the stored rows and
// writes what this file decides, for the background sync and for every refresh (see "One diff for every path").
//
// Segments are matched by their Amadeus flight offer id and segment id (`booking_segments_amadeus_uq`, the keys the
// record step stored, order-recorder.ts `segmentPlansOf`):
//   - a matched segment whose times, airports, terminals, marketing flight or `bookingStatus` differ is **changed**
//     (SCHEDULE_FIELDS, local times compared as `YYYY-MM-DDTHH:MM:SS`, as the order and the table both keep them); a
//     `bookingStatus` the order leaves out keeps the stored one; `isFlown` alone is a **state** change, recorded
//     without a schedule change;
//   - a segment of the order the booking does not have is **added** (an airline's re-accommodation);
//   - a stored segment the order no longer has, and that is not `CANCELLED` already, is **removed**: it is recorded as
//     `CANCELLED`, never deleted (tickets and services name segment ids).
// A changed, added or removed segment is a schedule change (`booking.schedule_changed`, flagged in the console as
// `hasScheduleChange`); it is visible to the customer when times changed (a matched segment's local departure or
// arrival, or a segment added or removed), as the document's resync says, and staff-only otherwise (a status, a
// terminal, an airport or a flight number alone).
//
// **Cancellation by the airline**: every segment of the order is `CANCELLED` (the document's resync: "all segments
// cancelled by the airline → cancelled, cancelled_by = airline"). An order Amadeus no longer returns (404) is not a
// cancellation: it may be purged or cancelled outside Velexis, and is recorded as ORDER_NOT_FOUND for staff to check.
//
// Tickets are matched by document number: new ones are **added**, known ones whose `documentStatus` changed (VOID,
// REFUNDED, EXCHANGED …) are **status changes**; a booking whose travellers are now all or partly ticketed is upgraded
// (`ticketed`/`partially_ticketed`, `issued`/`partially_issued`).
//
// The event data (`scheduleChangeOf`) is customer-safe: segment ids, flights, airports, local times and statuses, never
// a price, an office or a person's data.
//
// **One diff for every path** (lead decision (3) of 2026-10-23, FIX-W27-SYNC): the background sync, the customer
// refresh, console.bookings.get with `refresh=true` and console.bookings.resync all record a fetched order through this
// diff (BookingSyncService's record step), so a schedule change is reported whichever path reads it first. What a
// record changed is also kept as `syncChangesOf`'s list (`bookings.sync_changes`, the console's
// ConsoleSupplierSync.differences): JSON pointers into the booking as the API answers it, with a label, the value before
// and the value after (the booking's and ticketing status, tickets, segments).
import type { BookingSegmentRow, BookingTicketRow } from "./bookings.repository";
import {
  segmentPlansOf,
  ticketCoverage,
  type CreatedOrder,
  type OrderTicket,
  type SegmentPlan,
} from "./order-recorder";

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** The `bookingStatus` values of an Amadeus FlightSegment (`booking_segments.status`). */
export const SEGMENT_STATUSES = ["CONFIRMED", "WAITLISTED", "CANCELLED", "PENDING", "DENIED"] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

const isSegmentStatus = (value: unknown): value is SegmentStatus =>
  typeof value === "string" && (SEGMENT_STATUSES as readonly string[]).includes(value);

/** A segment of the order as the sync compares it: its plan, and its Amadeus `bookingStatus` and `isFlown`. */
export interface OrderSegment extends SegmentPlan {
  /** `null` when the order does not say (the stored status is kept). */
  readonly status: SegmentStatus | null;
  /** `null` when the order does not say. */
  readonly isFlown: boolean | null;
}

/** The key of a segment: its Amadeus flight offer id and segment id. */
const keyOf = (offerId: string, segmentId: string): string => `${offerId}|${segmentId}`;

/** The segments of an order (its offers as `readCreatedOrder` read them, its raw `data` for status and `isFlown`). */
export function orderSegmentsOf(order: Pick<CreatedOrder, "offers" | "data">): OrderSegment[] {
  const raw = new Map<string, JsonObject>();
  for (const offer of records(order.data["flightOffers"])) {
    const offerId = typeof offer["id"] === "string" ? offer["id"] : "";
    for (const itinerary of records(offer["itineraries"])) {
      for (const segment of records(itinerary["segments"])) {
        if (typeof segment["id"] === "string" && segment["id"] !== "") {
          raw.set(keyOf(offerId, segment["id"]), segment);
        }
      }
    }
  }
  return segmentPlansOf(order.offers).map((plan) => {
    const segment = raw.get(keyOf(plan.amadeusFlightOfferId, plan.amadeusSegmentId));
    return {
      ...plan,
      status: isSegmentStatus(segment?.["bookingStatus"]) ? segment["bookingStatus"] : null,
      isFlown: typeof segment?.["isFlown"] === "boolean" ? segment["isFlown"] : null,
    };
  });
}

/** The fields of a segment whose change is a schedule change, as `booking_segments` keeps them. */
export const SCHEDULE_FIELDS = [
  "departureIata",
  "departureTerminal",
  "departureLocal",
  "arrivalIata",
  "arrivalTerminal",
  "arrivalLocal",
  "carrierCode",
  "flightNumber",
  "status",
] as const;
export type ScheduleField = (typeof SCHEDULE_FIELDS)[number];

/** The fields among SCHEDULE_FIELDS that are the segment's times. */
const TIME_FIELDS: ReadonlySet<ScheduleField> = new Set(["departureLocal", "arrivalLocal"]);

/** One field of a segment that changed. */
export interface SegmentFieldChange {
  readonly field: ScheduleField;
  readonly from: string | null;
  readonly to: string | null;
}

/** A stored segment that the order changed. */
export interface ChangedSegment {
  readonly stored: BookingSegmentRow;
  readonly order: OrderSegment;
  /** In SCHEDULE_FIELDS order; never empty. */
  readonly changes: readonly SegmentFieldChange[];
  /** The local departure or arrival changed. */
  readonly timesChanged: boolean;
}

/** What the order changed of the booking's segments (see the file header). */
export interface SegmentDiff {
  readonly changed: readonly ChangedSegment[];
  readonly added: readonly OrderSegment[];
  readonly removed: readonly BookingSegmentRow[];
  /** Matched segments whose `isFlown` changed (also those that changed otherwise). */
  readonly flown: ReadonlyArray<{ readonly stored: BookingSegmentRow; readonly isFlown: boolean }>;
}

/** The value of a schedule field of a stored segment. */
function storedValue(segment: BookingSegmentRow, field: ScheduleField): string | null {
  return segment[field];
}

/** The value of a schedule field of an order segment; a status the order leaves out is the stored one. */
function orderValue(segment: OrderSegment, field: ScheduleField, stored: BookingSegmentRow): string | null {
  if (field === "status") {
    return segment.status ?? stored.status;
  }
  return segment[field];
}

/** The diff of the booking's stored segments and the order's (see the file header). */
export function diffSegments(
  stored: readonly BookingSegmentRow[],
  order: readonly OrderSegment[],
): SegmentDiff {
  const storedByKey = new Map(
    stored.map((segment) => [keyOf(segment.amadeusFlightOfferId, segment.amadeusSegmentId), segment]),
  );
  const orderKeys = new Set(
    order.map((segment) => keyOf(segment.amadeusFlightOfferId, segment.amadeusSegmentId)),
  );
  const changed: ChangedSegment[] = [];
  const added: OrderSegment[] = [];
  const flown: Array<{ readonly stored: BookingSegmentRow; readonly isFlown: boolean }> = [];
  for (const segment of order) {
    const row = storedByKey.get(keyOf(segment.amadeusFlightOfferId, segment.amadeusSegmentId));
    if (row === undefined) {
      added.push(segment);
      continue;
    }
    const changes = SCHEDULE_FIELDS.flatMap((field): SegmentFieldChange[] => {
      const from = storedValue(row, field);
      const to = orderValue(segment, field, row);
      return from === to ? [] : [{ field, from, to }];
    });
    if (changes.length > 0) {
      changed.push({
        stored: row,
        order: segment,
        changes,
        timesChanged: changes.some((change) => TIME_FIELDS.has(change.field)),
      });
    }
    if (segment.isFlown !== null && segment.isFlown !== row.isFlown) {
      flown.push({ stored: row, isFlown: segment.isFlown });
    }
  }
  const removed = stored.filter(
    (segment) =>
      !orderKeys.has(keyOf(segment.amadeusFlightOfferId, segment.amadeusSegmentId)) &&
      segment.status !== "CANCELLED",
  );
  return { changed, added, removed, flown };
}

/** True when the airline cancelled the order: it has segments, and every one is `CANCELLED`. */
export function cancelledByAirline(order: readonly OrderSegment[]): boolean {
  return order.length > 0 && order.every((segment) => segment.status === "CANCELLED");
}

/** What the order changed of the booking's tickets. */
export interface TicketDiff {
  /** Document numbers the booking does not have yet. */
  readonly added: readonly OrderTicket[];
  /** Known tickets whose `documentStatus` changed. */
  readonly statusChanged: ReadonlyArray<{
    readonly stored: BookingTicketRow;
    readonly from: string;
    readonly to: string;
  }>;
}

/** The diff of the booking's stored tickets and the order's, by document number. */
export function diffTickets(stored: readonly BookingTicketRow[], order: readonly OrderTicket[]): TicketDiff {
  const known = new Map(stored.map((ticket) => [ticket.documentNumber, ticket]));
  const added: OrderTicket[] = [];
  const statusChanged: Array<{
    readonly stored: BookingTicketRow;
    readonly from: string;
    readonly to: string;
  }> = [];
  const seen = new Set<string>();
  for (const ticket of order) {
    if (seen.has(ticket.documentNumber)) {
      continue;
    }
    seen.add(ticket.documentNumber);
    const row = known.get(ticket.documentNumber);
    if (row === undefined) {
      added.push(ticket);
    } else if (row.status !== ticket.documentStatus) {
      statusChanged.push({ stored: row, from: row.status, to: ticket.documentStatus });
    }
  }
  return { added, statusChanged };
}

/** The booking's state once the order's tickets are stored, when they make it (more) ticketed. */
export interface TicketUpgrade {
  readonly status: "ticketed" | "partially_ticketed";
  readonly ticketingStatus: "issued" | "partially_issued";
}

/**
 * The upgrade of a `confirmed` or `partially_ticketed` booking whose stored and new tickets now cover every traveller
 * (`ticketed`), or some of a `confirmed` one (`partially_ticketed`); `undefined` when nothing changes. Stored tickets
 * the order no longer lists count as they are stored.
 */
export function ticketUpgradeOf(
  bookingStatus: string,
  travelerIds: readonly string[],
  stored: readonly BookingTicketRow[],
  order: readonly OrderTicket[],
): TicketUpgrade | undefined {
  const listed = new Set(order.map((ticket) => ticket.documentNumber));
  const all: OrderTicket[] = [
    ...stored
      .filter((row) => !listed.has(row.documentNumber))
      .map((row) => ({
        documentType: row.documentType,
        documentNumber: row.documentNumber,
        documentStatus: row.status,
        travelerId: row.amadeusTravelerId,
        segmentIds: row.segmentIds,
        raw: {},
      })),
    ...order,
  ];
  const coverage = ticketCoverage(travelerIds, all);
  if (coverage === "full" && (bookingStatus === "confirmed" || bookingStatus === "partially_ticketed")) {
    return { status: "ticketed", ticketingStatus: "issued" };
  }
  if (coverage === "partial" && bookingStatus === "confirmed") {
    return { status: "partially_ticketed", ticketingStatus: "partially_issued" };
  }
  return undefined;
}

/** The `booking.schedule_changed` event of a segment diff. */
export interface ScheduleChange {
  readonly visibleToCustomer: boolean;
  readonly summary: string;
  /** Customer-safe (see the file header). */
  readonly data: JsonObject;
}

/** The flight of a segment as people write it (`IB3436`). */
const flightOf = (segment: { readonly carrierCode: string; readonly flightNumber: string }): string =>
  `${segment.carrierCode}${segment.flightNumber}`;

/** The event names of SCHEDULE_FIELDS in the event data. */
const FIELD_NAMES: Readonly<Record<ScheduleField, string>> = Object.freeze({
  departureIata: "departureAirport",
  departureTerminal: "departureTerminal",
  departureLocal: "departureAt",
  arrivalIata: "arrivalAirport",
  arrivalTerminal: "arrivalTerminal",
  arrivalLocal: "arrivalAt",
  carrierCode: "carrierCode",
  flightNumber: "flightNumber",
  status: "status",
});

/** One difference a recorded synchronisation found (the document's ConsoleSyncChange). */
export interface SyncChange {
  /** JSON pointer into the booking as the API answers it (`/itineraries/0/segments/0/departure/at`). */
  readonly path: string;
  /** For people: `IB3436 departure time`. */
  readonly label: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** What `syncChangesOf` compares. */
export interface SyncChangesInput {
  readonly statusBefore: string;
  readonly statusAfter: string;
  readonly ticketingStatusBefore: string;
  readonly ticketingStatusAfter: string;
  /** The stored segments before the record, in their order (itinerary, then segment). */
  readonly segments: readonly BookingSegmentRow[];
  readonly segmentDiff: SegmentDiff;
  /** The stored tickets before the record. */
  readonly tickets: readonly BookingTicketRow[];
  readonly ticketDiff: TicketDiff;
}

/** The pointer and label suffix of each schedule field (BookingSegment of the document). */
const FIELD_POINTERS: Readonly<Record<ScheduleField, { readonly path: string; readonly label: string }>> =
  Object.freeze({
    departureIata: { path: "/departure/iataCode", label: "departure airport" },
    departureTerminal: { path: "/departure/terminal", label: "departure terminal" },
    departureLocal: { path: "/departure/at", label: "departure time" },
    arrivalIata: { path: "/arrival/iataCode", label: "arrival airport" },
    arrivalTerminal: { path: "/arrival/terminal", label: "arrival terminal" },
    arrivalLocal: { path: "/arrival/at", label: "arrival time" },
    carrierCode: { path: "/carrierCode", label: "carrier" },
    flightNumber: { path: "/number", label: "flight number" },
    status: { path: "/status", label: "status" },
  });

/**
 * The differences a record makes (see the file header), in the order the console's resync lists them: the booking's
 * status, its ticketing status, the tickets (by their place in the booking's list, ordered by document number), then the
 * segments (by their itinerary and place in it); an empty list when the record changes none of them.
 */
export function syncChangesOf(input: SyncChangesInput): SyncChange[] {
  const changes: SyncChange[] = [];
  if (input.statusBefore !== input.statusAfter) {
    changes.push({
      path: "/status",
      label: "Booking status",
      before: input.statusBefore,
      after: input.statusAfter,
    });
  }
  if (input.ticketingStatusBefore !== input.ticketingStatusAfter) {
    changes.push({
      path: "/ticketing/status",
      label: "Ticketing status",
      before: input.ticketingStatusBefore,
      after: input.ticketingStatusAfter,
    });
  }
  const numbers = [
    ...new Set([
      ...input.tickets.map((ticket) => ticket.documentNumber),
      ...input.ticketDiff.added.map((ticket) => ticket.documentNumber),
    ]),
  ].sort();
  for (const ticket of input.ticketDiff.added) {
    changes.push({
      path: `/tickets/${numbers.indexOf(ticket.documentNumber)}`,
      label: `Ticket ${ticket.documentNumber}`,
      before: null,
      after: {
        documentType: ticket.documentType,
        documentNumber: ticket.documentNumber,
        status: ticket.documentStatus,
        travelerId: ticket.travelerId,
      },
    });
  }
  for (const changed of input.ticketDiff.statusChanged) {
    changes.push({
      path: `/tickets/${numbers.indexOf(changed.stored.documentNumber)}/status`,
      label: `Ticket ${changed.stored.documentNumber} status`,
      before: changed.from,
      after: changed.to,
    });
  }
  // The place of each stored segment in the booking's itineraries (BookingItinerary.segments).
  const itineraries = [...new Set(input.segments.map((segment) => segment.itineraryIndex))].sort(
    (a, b) => a - b,
  );
  const pointerOf = (segment: BookingSegmentRow): string => {
    const bound = input.segments.filter((candidate) => candidate.itineraryIndex === segment.itineraryIndex);
    return `/itineraries/${itineraries.indexOf(segment.itineraryIndex)}/segments/${bound.indexOf(segment)}`;
  };
  const flown = new Map(input.segmentDiff.flown.map((entry) => [entry.stored.id, entry.isFlown]));
  for (const segment of input.segments) {
    const flight = flightOf(segment);
    const changed = input.segmentDiff.changed.find((entry) => entry.stored.id === segment.id);
    for (const change of changed?.changes ?? []) {
      const field = FIELD_POINTERS[change.field];
      changes.push({
        path: `${pointerOf(segment)}${field.path}`,
        label: `${flight} ${field.label}`,
        before: change.from,
        after: change.to,
      });
    }
    const isFlown = flown.get(segment.id);
    if (isFlown !== undefined) {
      changes.push({
        path: `${pointerOf(segment)}/isFlown`,
        label: `${flight} flown`,
        before: segment.isFlown,
        after: isFlown,
      });
    }
    if (input.segmentDiff.removed.includes(segment)) {
      changes.push({
        path: `${pointerOf(segment)}/status`,
        label: `${flight} status`,
        before: segment.status,
        after: "CANCELLED",
      });
    }
  }
  for (const segment of input.segmentDiff.added) {
    changes.push({
      path: `/itineraries/${segment.itineraryIndex}/segments/${segment.segmentIndex}`,
      label: `${flightOf(segment)} added`,
      before: null,
      after: {
        flight: flightOf(segment),
        origin: segment.departureIata,
        destination: segment.arrivalIata,
        departureAt: segment.departureLocal,
        arrivalAt: segment.arrivalLocal,
      },
    });
  }
  return changes;
}

/** The schedule change of `diff`, or `undefined` when no segment changed, was added or was removed. */
export function scheduleChangeOf(diff: SegmentDiff): ScheduleChange | undefined {
  if (diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
    return undefined;
  }
  const visibleToCustomer =
    diff.added.length > 0 || diff.removed.length > 0 || diff.changed.some((segment) => segment.timesChanged);
  return {
    visibleToCustomer,
    summary: visibleToCustomer
      ? "The airline changed the flight schedule of this booking; check the new times."
      : "The airline changed the status or details of a segment of this booking.",
    data: {
      changed: diff.changed.map((segment) => ({
        segmentId: segment.stored.amadeusSegmentId,
        flight: flightOf(segment.stored),
        origin: segment.stored.departureIata,
        destination: segment.stored.arrivalIata,
        changes: Object.fromEntries(
          segment.changes.map((change) => [FIELD_NAMES[change.field], { from: change.from, to: change.to }]),
        ),
      })),
      added: diff.added.map((segment) => ({
        segmentId: segment.amadeusSegmentId,
        flight: flightOf(segment),
        origin: segment.departureIata,
        destination: segment.arrivalIata,
        departureAt: segment.departureLocal,
        arrivalAt: segment.arrivalLocal,
      })),
      removed: diff.removed.map((segment) => ({
        segmentId: segment.amadeusSegmentId,
        flight: flightOf(segment),
        origin: segment.departureIata,
        destination: segment.arrivalIata,
        departureAt: segment.departureLocal,
      })),
    },
  };
}
