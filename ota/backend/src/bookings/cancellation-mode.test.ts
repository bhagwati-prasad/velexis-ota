// The cancellation mode and refund estimate (OBE-049, cancellation-mode.ts; ota/docs/flows/change-and-cancel.md §3
// steps 3 and 5, §7): fixture bookings built relative to one `now` and the OTA's day around it (unticketed, ticketed
// today, ticketed yesterday, flown, and the other refusals), the void window in a time zone with summer time, and the
// money of each payment kind. Pure functions; no service is called and no calendar date is asserted.
import { describe, expect, it } from "vitest";
import { CANCEL_CUTOFF_MS } from "./allowed-actions";
import {
  cancellationModeOf,
  expectedRefundMatches,
  keptFeesOf,
  localDayOf,
  refundEstimateOf,
  refundLinesOf,
  type CancellationModeInput,
  type RefundEstimateInput,
} from "./cancellation-mode";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const ZONE = "Europe/Paris";
const now = new Date();
const at = (offsetMs: number): Date => new Date(now.getTime() + offsetMs);
const today = localDayOf(now, ZONE);

/** A fixture booking: a confirmed round trip 30 days ahead, nothing ticketed, self-service cancellation on. */
function booking(overrides: Partial<CancellationModeInput> = {}): CancellationModeInput {
  return {
    status: "confirmed",
    ticketingStatus: "pending",
    amadeusOrderId: "eJzTd9f3NjIJdgMADeQCtg",
    lastArrivalAt: at(37 * DAY + 3 * HOUR),
    segments: [
      { departureAt: at(30 * DAY), arrivalAt: at(30 * DAY + 2 * HOUR), isFlown: false },
      { departureAt: at(37 * DAY), arrivalAt: at(37 * DAY + 3 * HOUR), isFlown: false },
    ],
    tickets: [],
    selfServiceCancellation: true,
    timeZone: ZONE,
    now,
    ...overrides,
  };
}

/** The fixture booking ticketed for two travellers at `issuedAt`. */
const ticketed = (...issuedAt: Array<Date | null>): Partial<CancellationModeInput> => ({
  status: "ticketed",
  ticketingStatus: "issued",
  tickets: issuedAt.map((date) => ({ status: "ISSUED", issuedAt: date })),
});

describe("the cancellation mode of a fixture booking", () => {
  it("[OBE-049 AC2] releases an unticketed booking", () => {
    expect(cancellationModeOf(booking())).toEqual({
      mode: "release",
      notAllowedReason: null,
      voidDeadlineAt: null,
    });
    // A partly paid or still issuing booking without a ticket is released too, and so is one whose tickets are gone.
    expect(cancellationModeOf(booking({ ticketingStatus: "in_progress" })).mode).toBe("release");
    expect(
      cancellationModeOf(
        booking({
          ticketingStatus: "failed",
          tickets: [
            { status: "VOID", issuedAt: at(-3 * DAY) },
            { status: "REFUNDED", issuedAt: at(-3 * DAY) },
          ],
        }),
      ).mode,
    ).toBe("release");
  });

  it("[OBE-049 AC2] voids a booking ticketed today in the OTA's time zone, until the next midnight there", () => {
    const result = cancellationModeOf(booking(ticketed(now, today.startsAt)));
    expect(result).toEqual({ mode: "void", notAllowedReason: null, voidDeadlineAt: today.endsAt });
    expect(today.endsAt.getTime()).toBeGreaterThan(now.getTime());
    // A partly ticketed booking whose tickets are all of today is voided as well.
    expect(
      cancellationModeOf(
        booking({
          status: "partially_ticketed",
          ticketingStatus: "partially_issued",
          tickets: [{ status: "ISSUED", issuedAt: now }],
        }),
      ).mode,
    ).toBe("void");
  });

  it("[OBE-049 AC2] makes a booking ticketed yesterday a request for the staff (outside the void window)", () => {
    const yesterday = new Date(today.startsAt.getTime() - 1);
    expect(cancellationModeOf(booking(ticketed(yesterday)))).toEqual({
      mode: "request_only",
      notAllowedReason: null,
      voidDeadlineAt: null,
    });
    // One ticket of yesterday among today's is enough, and so is a ticket whose issue time is unknown.
    expect(cancellationModeOf(booking(ticketed(now, at(-2 * DAY)))).mode).toBe("request_only");
    expect(cancellationModeOf(booking(ticketed(now, null))).mode).toBe("request_only");
    // A ticketing state that says ticketed without stored tickets cannot be voided safely.
    expect(cancellationModeOf(booking({ ticketingStatus: "issued", status: "ticketed" })).mode).toBe(
      "request_only",
    );
  });

  it("[OBE-049 AC2] does not allow cancelling a flown booking", () => {
    const flown = booking({
      ...ticketed(at(-10 * DAY)),
      lastArrivalAt: at(5 * DAY),
      segments: [
        { departureAt: at(-2 * DAY), arrivalAt: at(-2 * DAY + 2 * HOUR), isFlown: true },
        { departureAt: at(5 * DAY - 3 * HOUR), arrivalAt: at(5 * DAY), isFlown: false },
      ],
    });
    expect(cancellationModeOf(flown)).toEqual({
      mode: "not_allowed",
      notAllowedReason: "flown",
      voidDeadlineAt: null,
    });
    // A departure that has passed counts as flown before Amadeus says so.
    expect(
      cancellationModeOf(
        booking({
          segments: [{ departureAt: at(-HOUR), arrivalAt: at(HOUR), isFlown: false }],
          lastArrivalAt: at(HOUR),
        }),
      ).notAllowedReason,
    ).toBe("flown");
  });

  it("does not allow cancelling within 3 hours of departure, when the OTA switched it off, or a booking that is not live", () => {
    const soon = (offsetMs: number) =>
      booking({
        segments: [{ departureAt: at(offsetMs), arrivalAt: at(offsetMs + 2 * HOUR), isFlown: false }],
        lastArrivalAt: at(offsetMs + 2 * HOUR),
      });
    expect(cancellationModeOf(soon(CANCEL_CUTOFF_MS)).notAllowedReason).toBe("too_close_to_departure");
    expect(cancellationModeOf(soon(CANCEL_CUTOFF_MS + 60_000)).mode).toBe("release");
    expect(cancellationModeOf(booking({ selfServiceCancellation: false })).notAllowedReason).toBe(
      "disabled_by_ota",
    );
    expect(cancellationModeOf(booking({ status: "cancelled" })).notAllowedReason).toBe("cancelled");
    for (const status of ["pending", "failed", "unknown"]) {
      expect(cancellationModeOf(booking({ status })).notAllowedReason).toBe("pending");
    }
    expect(cancellationModeOf(booking({ amadeusOrderId: null })).notAllowedReason).toBe("pending");
  });
});

describe("the OTA's day", () => {
  it("starts at midnight in the zone and ends at the next one, a day later on an ordinary day", () => {
    const day = localDayOf(now, "UTC");
    expect(day.startsAt.getTime() % DAY).toBe(0);
    expect(day.endsAt.getTime() - day.startsAt.getTime()).toBe(DAY);
    expect(day.startsAt.toISOString().slice(0, 10)).toBe(day.date);
    expect(now.getTime()).toBeGreaterThanOrEqual(day.startsAt.getTime());
    expect(now.getTime()).toBeLessThan(day.endsAt.getTime());
  });

  it("is 23 or 25 hours long on the days the clocks change, and its bounds are midnights in the zone", () => {
    // The European Union changes its clocks on the last Sundays of March and October: find them around now.
    const lengths = new Set<number>();
    for (let offset = 0; offset < 400; offset += 1) {
      const day = localDayOf(at(offset * DAY), ZONE);
      const length = day.endsAt.getTime() - day.startsAt.getTime();
      if (length !== DAY) {
        lengths.add(length);
        expect(localDayOf(day.startsAt, ZONE).date).toBe(day.date);
        expect(localDayOf(new Date(day.startsAt.getTime() - 1), ZONE).date).not.toBe(day.date);
        expect(localDayOf(new Date(day.endsAt.getTime() - 1), ZONE).date).toBe(day.date);
        expect(localDayOf(day.endsAt, ZONE).date).not.toBe(day.date);
      }
    }
    expect([...lengths].sort()).toEqual([23 * HOUR, 25 * HOUR]);
  });

  it("falls back to UTC for a time zone the runtime does not know", () => {
    expect(localDayOf(now, "Not/AZone")).toEqual(localDayOf(now, "UTC"));
  });

  it("voids a ticket issued at the first instant of the day, not one issued a millisecond before", () => {
    expect(cancellationModeOf(booking(ticketed(today.startsAt))).mode).toBe("void");
    expect(cancellationModeOf(booking(ticketed(new Date(today.startsAt.getTime() - 1)))).mode).toBe(
      "request_only",
    );
  });
});

describe("the refund estimate", () => {
  const input = (overrides: Partial<RefundEstimateInput>): RefundEstimateInput => ({
    mode: "release",
    minorUnits: 2,
    payment: { kind: "stripe_captured", captured: "736.78", refundable: "736.78" },
    keptFees: "22.50",
    cancellationFees: ["15.00"],
    ...overrides,
  });

  it("refunds a captured payment less the non-refundable fees and the cancellation fee", () => {
    expect(refundEstimateOf(input({}))).toEqual({
      amountPaid: "736.78",
      estimatedRefund: "699.28",
      penalty: "0.00",
      otaFee: "37.50",
    });
    expect(refundEstimateOf(input({ mode: "void", keptFees: "0", cancellationFees: [] }))).toEqual({
      amountPaid: "736.78",
      estimatedRefund: "736.78",
      penalty: "0.00",
      otaFee: "0.00",
    });
  });

  it("never estimates below zero nor keeps more than was paid", () => {
    expect(
      refundEstimateOf(
        input({ payment: { kind: "stripe_captured", captured: "30.00", refundable: "30.00" } }),
      ),
    ).toEqual({
      amountPaid: "30.00",
      estimatedRefund: "0.00",
      penalty: "0.00",
      otaFee: "30.00",
    });
  });

  it("shows what was captured as paid, and refunds only what is left of a partly refunded payment", () => {
    expect(
      refundEstimateOf(
        input({ payment: { kind: "stripe_captured", captured: "736.78", refundable: "500.00" } }),
      ),
    ).toEqual({
      amountPaid: "736.78",
      estimatedRefund: "462.50",
      penalty: "0.00",
      otaFee: "37.50",
    });
    expect(
      refundEstimateOf(
        input({ payment: { kind: "stripe_captured", captured: "736.78", refundable: "20.00" } }),
      ),
    ).toEqual({
      amountPaid: "736.78",
      estimatedRefund: "0.00",
      penalty: "0.00",
      otaFee: "20.00",
    });
  });

  it("gives the whole authorisation back (a void) and the airline's whole charge (a void reverses it)", () => {
    expect(refundEstimateOf(input({ payment: { kind: "stripe_authorized", authorized: "736.78" } }))).toEqual(
      {
        amountPaid: "736.78",
        estimatedRefund: "736.78",
        penalty: "0.00",
        otaFee: "0.00",
      },
    );
    expect(
      refundEstimateOf(input({ mode: "void", payment: { kind: "airline", charged: "714.28" } })),
    ).toMatchObject({ amountPaid: "714.28", estimatedRefund: "714.28", otaFee: "0.00" });
  });

  it("estimates nothing for a request, a refusal or a booking without a payment", () => {
    for (const mode of ["request_only", "not_allowed"] as const) {
      expect(refundEstimateOf(input({ mode }))).toEqual({
        amountPaid: "736.78",
        estimatedRefund: "0.00",
        penalty: "0.00",
        otaFee: "0.00",
      });
    }
    expect(refundEstimateOf(input({ payment: { kind: "none" } }))).toMatchObject({
      amountPaid: "0.00",
      estimatedRefund: "0.00",
    });
  });

  it("uses the currency's minor units", () => {
    expect(
      refundEstimateOf(
        input({
          minorUnits: 0,
          payment: { kind: "stripe_captured", captured: "12000", refundable: "12000" },
          keptFees: "500",
          cancellationFees: [],
        }),
      ),
    ).toEqual({ amountPaid: "12000", estimatedRefund: "11500", penalty: "0", otaFee: "500" });
  });
});

describe("the kept fees of a priced offer's snapshot", () => {
  it("sums the lines whose rule was not refundable, the extras' fees included", () => {
    const response = {
      data: { flightOffers: [] },
      velexis: {
        feeLines: [
          { feeType: "booking_service", amount: "12.50", refundable: false },
          { feeType: "ticketing", amount: "10.00", refundable: true },
          { feeType: "booking_service", amount: "3.00" },
        ],
        extras: { feeLines: [{ feeType: "ancillary_service", amount: "4.25", refundable: false }] },
      },
    };
    expect(keptFeesOf(response, 2)).toBe("19.75");
    expect(keptFeesOf({ velexis: { feeLines: [] } }, 2)).toBe("0.00");
  });

  it("cannot say for a snapshot it cannot read", () => {
    expect(keptFeesOf(undefined, 2)).toBeUndefined();
    expect(keptFeesOf({ velexis: {} }, 2)).toBeUndefined();
    expect(keptFeesOf({ velexis: { feeLines: [{ amount: 12 }] } }, 2)).toBeUndefined();
  });
});

describe("the refund lines", () => {
  it("split the estimate over the travellers by their share, summing exactly to it", () => {
    const lines = refundLinesOf(
      [
        { travelerId: "1", travelerName: "ANNA BERG", ticketNumber: "057-2412345678", weight: "400.00" },
        { travelerId: "2", travelerName: "LEO BERG", ticketNumber: null, weight: "200.00" },
      ],
      { amountPaid: "100.00", estimatedRefund: "50.01", penalty: "0.00", otaFee: "49.99" },
      2,
    );
    expect(lines).toEqual([
      {
        travelerId: "1",
        travelerName: "ANNA BERG",
        ticketNumber: "057-2412345678",
        paid: "66.67",
        refund: "33.34",
        penalty: "0.00",
      },
      {
        travelerId: "2",
        travelerName: "LEO BERG",
        ticketNumber: null,
        paid: "33.33",
        refund: "16.67",
        penalty: "0.00",
      },
    ]);
  });
});

describe("the expected refund", () => {
  it("matches the quote's amount in its currency only", () => {
    const quoted = { amount: "275.12", currency: "EUR" };
    expect(expectedRefundMatches({ amount: "275.12", currency: "EUR" }, quoted)).toBe(true);
    expect(expectedRefundMatches({ amount: "275.120", currency: "EUR" }, quoted)).toBe(true);
    expect(expectedRefundMatches({ amount: "275.11", currency: "EUR" }, quoted)).toBe(false);
    expect(expectedRefundMatches({ amount: "275.12", currency: "USD" }, quoted)).toBe(false);
    expect(expectedRefundMatches({ amount: "-275.12", currency: "EUR" }, quoted)).toBe(false);
    expect(expectedRefundMatches(undefined, quoted)).toBe(false);
  });
});
