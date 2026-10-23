// The diff of the booking sync (OBE-045, order-diff.ts) on the Amadeus stub's synthetic order of priced offer 2
// (Madrid–Paris Orly, segment 3, one adult; test/builders/bookings.ts): the segments as the record step stored them,
// then what a later Flight Order Management GET may say. The writes, the claim and the retries run against PostgreSQL
// and the stub in test/integration/bookings/sync.int.test.ts.
import { describe, expect, it } from "vitest";
import { buildCreatedOrderBody } from "../../test/builders/bookings";
import type { BookingSegmentRow, BookingTicketRow } from "./bookings.repository";
import {
  cancelledByAirline,
  diffSegments,
  diffTickets,
  orderSegmentsOf,
  scheduleChangeOf,
  syncChangesOf,
  ticketUpgradeOf,
  type OrderSegment,
} from "./order-diff";
import { readCreatedOrder, type CreatedOrder, type OrderTicket } from "./order-recorder";

type JsonObject = Record<string, unknown>;

/** The stub's order of offer 2, after `change` edits its answer's `data`. */
function order(change: (data: JsonObject) => void = () => undefined): CreatedOrder {
  const body = buildCreatedOrderBody();
  change(body["data"] as JsonObject);
  const read = readCreatedOrder(body);
  if (read === undefined) {
    throw new Error("the builder's order cannot be read");
  }
  return read;
}

/** The segments of an order's `data`, to edit them. */
function rawSegments(data: JsonObject): JsonObject[] {
  return (data["flightOffers"] as JsonObject[]).flatMap((offer) =>
    (offer["itineraries"] as JsonObject[]).flatMap((itinerary) => itinerary["segments"] as JsonObject[]),
  );
}

/** A stored segment as the record step writes it from an order segment. */
function storedOf(
  segment: OrderSegment,
  index: number,
  overrides: Partial<BookingSegmentRow> = {},
): BookingSegmentRow {
  return {
    id: `seg_01JSYNCDIFF00000000000000${index}`,
    amadeusFlightOfferId: segment.amadeusFlightOfferId,
    amadeusSegmentId: segment.amadeusSegmentId,
    itineraryIndex: segment.itineraryIndex,
    segmentIndex: segment.segmentIndex,
    carrierCode: segment.carrierCode,
    flightNumber: segment.flightNumber,
    operatingCarrierCode: segment.operatingCarrierCode,
    aircraftCode: segment.aircraftCode,
    departureIata: segment.departureIata,
    departureTerminal: segment.departureTerminal,
    departureLocal: segment.departureLocal,
    departureAt: new Date(`${segment.departureLocal}Z`),
    arrivalIata: segment.arrivalIata,
    arrivalTerminal: segment.arrivalTerminal,
    arrivalLocal: segment.arrivalLocal,
    arrivalAt: new Date(`${segment.arrivalLocal}Z`),
    durationMinutes: segment.durationMinutes,
    numberOfStops: segment.numberOfStops,
    cabin: segment.cabin,
    bookingClass: segment.bookingClass,
    fareBasis: segment.fareBasis,
    brandedFare: segment.brandedFare,
    includedCheckedBags: segment.includedCheckedBags,
    status: "CONFIRMED",
    isFlown: false,
    ...overrides,
  };
}

/** The booking's segments as recorded from the unchanged order. */
const recorded = (overrides: Partial<BookingSegmentRow> = {}): BookingSegmentRow[] =>
  orderSegmentsOf(order()).map((segment, index) => storedOf(segment, index, overrides));

function ticketRow(documentNumber: string, overrides: Partial<BookingTicketRow> = {}): BookingTicketRow {
  return {
    id: `tkt_01JSYNCDIFF0000000000000${documentNumber.slice(-1)}`,
    amadeusTravelerId: "1",
    documentType: "ETICKET",
    documentNumber,
    status: "ISSUED",
    segmentIds: ["3"],
    issuedAt: null,
    details: {},
    ...overrides,
  };
}

function orderTicket(documentNumber: string, overrides: Partial<OrderTicket> = {}): OrderTicket {
  return {
    documentType: "ETICKET",
    documentNumber,
    documentStatus: "ISSUED",
    travelerId: "1",
    segmentIds: ["3"],
    raw: {},
    ...overrides,
  };
}

describe("orderSegmentsOf", () => {
  it("reads each segment's plan with the Amadeus bookingStatus and isFlown of the order's data [OBE-045]", () => {
    expect(orderSegmentsOf(order())).toEqual([
      expect.objectContaining({
        amadeusFlightOfferId: "2",
        amadeusSegmentId: "3",
        carrierCode: "IB",
        flightNumber: "3436",
        departureIata: "MAD",
        departureLocal: "2027-01-15T07:15:00",
        arrivalIata: "ORY",
        arrivalLocal: "2027-01-15T09:20:00",
        // The fixture's order says neither: the stored values are kept.
        status: null,
        isFlown: null,
      }),
    ]);
    const flown = order((data) => {
      for (const segment of rawSegments(data)) {
        segment["bookingStatus"] = "WAITLISTED";
        segment["isFlown"] = true;
      }
    });
    expect(orderSegmentsOf(flown)).toEqual([
      expect.objectContaining({ status: "WAITLISTED", isFlown: true }),
    ]);
    // A value outside the specification's enum is not read.
    const odd = order((data) => {
      for (const segment of rawSegments(data)) {
        segment["bookingStatus"] = "HX";
      }
    });
    expect(orderSegmentsOf(odd)).toEqual([expect.objectContaining({ status: null })]);
  });
});

describe("diffSegments and scheduleChangeOf", () => {
  it("finds nothing when the order says what the booking holds [OBE-045 AC1]", () => {
    const diff = diffSegments(recorded(), orderSegmentsOf(order()));
    expect(diff).toEqual({ changed: [], added: [], removed: [], flown: [] });
    expect(scheduleChangeOf(diff)).toBeUndefined();
    // A bookingStatus the order states as stored is no change either.
    const confirmed = order((data) => {
      for (const segment of rawSegments(data)) {
        segment["bookingStatus"] = "CONFIRMED";
      }
    });
    expect(scheduleChangeOf(diffSegments(recorded(), orderSegmentsOf(confirmed)))).toBeUndefined();
  });

  it("finds a segment time change, visible to the customer, with the times before and after [OBE-045 AC1]", () => {
    const stored = recorded();
    const later = order((data) => {
      const [segment] = rawSegments(data);
      (segment?.["departure"] as JsonObject)["at"] = "2027-01-15T08:45";
      (segment?.["arrival"] as JsonObject)["at"] = "2027-01-15T10:50:00";
    });
    const diff = diffSegments(stored, orderSegmentsOf(later));

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({
      stored: { id: stored[0]?.id },
      timesChanged: true,
      changes: [
        { field: "departureLocal", from: "2027-01-15T07:15:00", to: "2027-01-15T08:45:00" },
        { field: "arrivalLocal", from: "2027-01-15T09:20:00", to: "2027-01-15T10:50:00" },
      ],
    });
    expect(scheduleChangeOf(diff)).toEqual({
      visibleToCustomer: true,
      summary: expect.stringContaining("schedule") as unknown,
      data: {
        changed: [
          {
            segmentId: "3",
            flight: "IB3436",
            origin: "MAD",
            destination: "ORY",
            changes: {
              departureAt: { from: "2027-01-15T07:15:00", to: "2027-01-15T08:45:00" },
              arrivalAt: { from: "2027-01-15T09:20:00", to: "2027-01-15T10:50:00" },
            },
          },
        ],
        added: [],
        removed: [],
      },
    });
  });

  it("finds a status or terminal change without a time change, for staff only [OBE-045 AC1]", () => {
    const waitlisted = order((data) => {
      const [segment] = rawSegments(data);
      if (segment !== undefined) {
        segment["bookingStatus"] = "WAITLISTED";
        (segment["departure"] as JsonObject)["terminal"] = "2";
      }
    });
    const change = scheduleChangeOf(diffSegments(recorded(), orderSegmentsOf(waitlisted)));
    expect(change).toMatchObject({
      visibleToCustomer: false,
      data: {
        changed: [
          {
            segmentId: "3",
            changes: {
              departureTerminal: { from: "4", to: "2" },
              status: { from: "CONFIRMED", to: "WAITLISTED" },
            },
          },
        ],
      },
    });
  });

  it("records isFlown alone as a state change, never a schedule change [OBE-045]", () => {
    const stored = recorded();
    const flown = order((data) => {
      for (const segment of rawSegments(data)) {
        segment["isFlown"] = true;
      }
    });
    const diff = diffSegments(stored, orderSegmentsOf(flown));
    expect(diff.flown).toEqual([{ stored: stored[0], isFlown: true }]);
    expect(diff.changed).toEqual([]);
    expect(scheduleChangeOf(diff)).toBeUndefined();
  });

  it("finds a segment the airline added and one it removed; a removed one already cancelled is not reported [OBE-045 AC1]", () => {
    const [segment] = recorded();
    if (segment === undefined) {
      throw new Error("no segment");
    }
    const gone = { ...segment, id: "seg_01JSYNCDIFF0000000000000GONE", amadeusSegmentId: "9" };
    const alreadyCancelled = {
      ...gone,
      id: "seg_01JSYNCDIFF000000000000GONE2",
      amadeusSegmentId: "8",
      status: "CANCELLED",
    };
    const reaccommodated = order((data) => {
      const [raw] = rawSegments(data);
      if (raw !== undefined) {
        raw["id"] = "4";
        raw["number"] = "3438";
      }
      for (const offer of data["flightOffers"] as JsonObject[]) {
        for (const pricing of offer["travelerPricings"] as JsonObject[]) {
          for (const detail of pricing["fareDetailsBySegment"] as JsonObject[]) {
            detail["segmentId"] = "4";
          }
        }
      }
    });
    const diff = diffSegments([segment, gone, alreadyCancelled], orderSegmentsOf(reaccommodated));

    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([
      expect.objectContaining({ amadeusSegmentId: "4", flightNumber: "3438", cabin: "ECONOMY" }),
    ]);
    expect(diff.removed.map((row) => row.amadeusSegmentId)).toEqual(["3", "9"]);
    expect(scheduleChangeOf(diff)).toMatchObject({
      visibleToCustomer: true,
      data: {
        changed: [],
        added: [{ segmentId: "4", flight: "IB3438", departureAt: "2027-01-15T07:15:00" }],
        removed: [
          { segmentId: "3", flight: "IB3436" },
          { segmentId: "9", flight: "IB3436" },
        ],
      },
    });
  });
});

describe("cancelledByAirline", () => {
  it("is true when every segment of the order is CANCELLED, and only then [OBE-045 AC2]", () => {
    const withStatuses = (...statuses: string[]): OrderSegment[] => {
      const [segment] = orderSegmentsOf(order());
      if (segment === undefined) {
        throw new Error("no segment");
      }
      return statuses.map((status, index) => ({
        ...segment,
        amadeusSegmentId: String(index + 1),
        status: status === "-" ? null : (status as OrderSegment["status"]),
      }));
    };
    expect(cancelledByAirline(withStatuses("CANCELLED"))).toBe(true);
    expect(cancelledByAirline(withStatuses("CANCELLED", "CANCELLED"))).toBe(true);
    expect(cancelledByAirline(withStatuses("CANCELLED", "CONFIRMED"))).toBe(false);
    expect(cancelledByAirline(withStatuses("CANCELLED", "-"))).toBe(false);
    expect(cancelledByAirline(withStatuses("DENIED"))).toBe(false);
    expect(cancelledByAirline([])).toBe(false);

    const cancelled = order((data) => {
      for (const segment of rawSegments(data)) {
        segment["bookingStatus"] = "CANCELLED";
      }
    });
    expect(cancelledByAirline(orderSegmentsOf(cancelled))).toBe(true);
  });
});

describe("diffTickets and ticketUpgradeOf", () => {
  it("finds new tickets and changed statuses by document number, each number once [OBE-045]", () => {
    const stored = [ticketRow("000-0000000001"), ticketRow("000-0000000002", { amadeusTravelerId: "2" })];
    const diff = diffTickets(stored, [
      orderTicket("000-0000000001"),
      orderTicket("000-0000000002", { travelerId: "2", documentStatus: "VOID" }),
      orderTicket("000-0000000003", { travelerId: "3" }),
      orderTicket("000-0000000003", { travelerId: "3" }),
    ]);
    expect(diff.added.map((ticket) => ticket.documentNumber)).toEqual(["000-0000000003"]);
    expect(diff.statusChanged).toEqual([{ stored: stored[1], from: "ISSUED", to: "VOID" }]);
    expect(diffTickets(stored, [])).toEqual({ added: [], statusChanged: [] });
  });

  it("upgrades a booking whose travellers are now all or partly ticketed, as the refresh does [OBE-045]", () => {
    const travelers = ["1", "2"];
    expect(ticketUpgradeOf("confirmed", travelers, [], [orderTicket("000-0000000001")])).toEqual({
      status: "partially_ticketed",
      ticketingStatus: "partially_issued",
    });
    // A stored ticket the order no longer lists still counts.
    expect(
      ticketUpgradeOf(
        "partially_ticketed",
        travelers,
        [ticketRow("000-0000000001")],
        [orderTicket("000-0000000002", { travelerId: "2" })],
      ),
    ).toEqual({ status: "ticketed", ticketingStatus: "issued" });
    expect(ticketUpgradeOf("confirmed", travelers, [], [])).toBeUndefined();
    expect(ticketUpgradeOf("ticketed", travelers, [], [orderTicket("000-0000000001")])).toBeUndefined();
    expect(
      ticketUpgradeOf("partially_ticketed", travelers, [], [orderTicket("000-0000000001")]),
    ).toBeUndefined();
    // A voided ticket covers nobody.
    expect(
      ticketUpgradeOf("confirmed", ["1"], [], [orderTicket("000-0000000001", { documentStatus: "VOID" })]),
    ).toBeUndefined();
  });
});

describe("syncChangesOf", () => {
  it("lists what a record changes as JSON pointers into the booking, with labels, before and after [FIX-W27-SYNC AC5]", () => {
    const stored = recorded();
    const later = order((data) => {
      const [segment] = rawSegments(data);
      (segment?.["departure"] as JsonObject)["at"] = "2027-01-15T08:45:00";
      if (segment !== undefined) {
        segment["isFlown"] = true;
      }
    });
    const storedTickets = [ticketRow("000-0000000002")];
    const tickets = diffTickets(storedTickets, [
      orderTicket("000-0000000001"),
      orderTicket("000-0000000002", { documentStatus: "VOID" }),
    ]);

    expect(
      syncChangesOf({
        statusBefore: "confirmed",
        statusAfter: "ticketed",
        ticketingStatusBefore: "pending",
        ticketingStatusAfter: "issued",
        segments: stored,
        segmentDiff: diffSegments(stored, orderSegmentsOf(later)),
        tickets: storedTickets,
        ticketDiff: tickets,
      }),
    ).toEqual([
      { path: "/status", label: "Booking status", before: "confirmed", after: "ticketed" },
      { path: "/ticketing/status", label: "Ticketing status", before: "pending", after: "issued" },
      // Tickets by their place in the booking's list (ordered by document number).
      {
        path: "/tickets/0",
        label: "Ticket 000-0000000001",
        before: null,
        after: {
          documentType: "ETICKET",
          documentNumber: "000-0000000001",
          status: "ISSUED",
          travelerId: "1",
        },
      },
      { path: "/tickets/1/status", label: "Ticket 000-0000000002 status", before: "ISSUED", after: "VOID" },
      {
        path: "/itineraries/0/segments/0/departure/at",
        label: "IB3436 departure time",
        before: "2027-01-15T07:15:00",
        after: "2027-01-15T08:45:00",
      },
      { path: "/itineraries/0/segments/0/isFlown", label: "IB3436 flown", before: false, after: true },
    ]);
  });

  it("names a removed segment's cancellation and an added segment, and nothing when nothing changed [FIX-W27-SYNC AC5]", () => {
    const [segment] = recorded();
    if (segment === undefined) {
      throw new Error("no segment");
    }
    const reaccommodated = order((data) => {
      const [raw] = rawSegments(data);
      if (raw !== undefined) {
        raw["id"] = "4";
        raw["number"] = "3438";
      }
    });
    const diff = diffSegments([segment], orderSegmentsOf(reaccommodated));
    const unchanged = {
      statusBefore: "confirmed",
      statusAfter: "confirmed",
      ticketingStatusBefore: "pending",
      ticketingStatusAfter: "pending",
      segments: [segment],
      tickets: [],
      ticketDiff: { added: [], statusChanged: [] },
    };

    expect(syncChangesOf({ ...unchanged, segmentDiff: diff })).toEqual([
      {
        path: "/itineraries/0/segments/0/status",
        label: "IB3436 status",
        before: "CONFIRMED",
        after: "CANCELLED",
      },
      {
        path: "/itineraries/0/segments/0",
        label: "IB3438 added",
        before: null,
        after: {
          flight: "IB3438",
          origin: "MAD",
          destination: "ORY",
          departureAt: "2027-01-15T07:15:00",
          arrivalAt: "2027-01-15T09:20:00",
        },
      },
    ]);
    expect(
      syncChangesOf({ ...unchanged, segmentDiff: diffSegments([segment], orderSegmentsOf(order())) }),
    ).toEqual([]);
  });
});
