// The pure rules of console.bookings.closeReview (OBE-099, review-closure.service.ts): what a closure request must
// carry for each outcome (the record locator of `order_found`, the note of `not_booked`, never a card number in a
// note), when a booking is in Reconciliation review (`pending` with `reconcile_outcome = manual_review`) and the
// refusals of one that is not, an order that does not carry the booking's remark or that another booking holds, the
// staff event of each outcome (the outcome and the record locator, nothing personal; the airline-card note), and the
// answer of a failed by-reference read or of one without an order. The field errors answer plain pointers into the
// body (`/recordLocator`, `/note`), as the document's own validation does (lead decision (20l) of 2026-11-13). The
// HTTP, database, Amadeus, Stripe and queue paths are in test/integration/console/review-closure.int.test.ts. Card
// numbers here are test data only (Visa's documented test PAN and Mastercard's).
import { AppError, isAppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { AmadeusCallError } from "../amadeus/error-mapper";
import {
  AIRLINE_CARD_CHARGE_NOTE,
  closureEventOf,
  closureSupplierAnswerOf,
  holdsCardNumber,
  inReview,
  notInReview,
  orderHeldBy,
  ordersOfReply,
  refuseClosureRequest,
  remarkMismatch,
  REVIEW_CLOSED_EVENT,
  type ReviewClosureRequest,
} from "./review-closure.service";

/** The field errors of a refused request, as `[path, code]`; `[]` when it passes. */
function refusals(body: ReviewClosureRequest): Array<[string, string]> {
  try {
    refuseClosureRequest(body);
    return [];
  } catch (error) {
    if (!isAppError(error) || error.code !== "VALIDATION_FAILED") {
      throw error;
    }
    return (error.fieldErrors ?? []).map((fieldError) => [fieldError.path, fieldError.code]);
  }
}

describe("a closure request", () => {
  it("[OBE-099] takes order_found with its record locator and an optional note, and not_booked with a note", () => {
    expect(refusals({ outcome: "order_found", recordLocator: "L2P9XC" })).toEqual([]);
    expect(refusals({ outcome: "order_found", recordLocator: "L2P9XC", note: "Found on queue 50." })).toEqual(
      [],
    );
    expect(refusals({ outcome: "not_booked", note: "Queue 50 checked for SAMPLE; no order." })).toEqual([]);
  });

  it("[OBE-099] refuses order_found without a record locator, and not_booked without a note or with a locator", () => {
    expect(refusals({ outcome: "order_found" })).toEqual([["/recordLocator", "required"]]);
    expect(refusals({ outcome: "not_booked" })).toEqual([["/note", "required"]]);
    // A note of blanks says nothing.
    expect(refusals({ outcome: "not_booked", note: "   " })).toEqual([["/note", "required"]]);
    expect(refusals({ outcome: "not_booked", recordLocator: "L2P9XC", note: "None." })).toEqual([
      ["/recordLocator", "not_allowed"],
    ]);
  });

  it("[OBE-099] refuses a note that holds a card number, grouped or not, and never names it", () => {
    for (const note of [
      "The traveller paid with 4111111111111111.",
      "Card 4111 1111 1111 1111 was charged by the airline",
      "Card 5555-5555-5555-4444, ask the airline",
      // Next to other digits: a security code or an expiry after it, a reference before it.
      "Card 4111 1111 1111 1111 123 was charged",
      "4111111111111111 12 28 per the traveller",
      "Ref 12 4111111111111111",
    ]) {
      let caught: unknown;
      try {
        refuseClosureRequest({ outcome: "not_booked", note });
      } catch (error) {
        caught = error;
      }
      expect(isAppError(caught) && caught.code).toBe("VALIDATION_FAILED");
      const error = caught as AppError;
      expect(error.fieldErrors?.map((fieldError) => [fieldError.path, fieldError.code])).toEqual([
        ["/note", "card_data"],
      ]);
      expect(JSON.stringify(error.fieldErrors)).not.toMatch(/4111|5555/);
    }
    expect(
      refusals({ outcome: "order_found", recordLocator: "L2P9XC", note: "PAN 4111111111111111" }),
    ).toEqual([["/note", "card_data"]]);
  });

  it("[OBE-099] keeps numbers that are no card number: phones, references, amounts, short runs", () => {
    for (const note of [
      "Called +46 70 123 45 67 about booking VX7K2Q.",
      "Ticket 057-2412345678 is not in the office.",
      "Amount held 1364.06 EUR, queue 50 category 0.",
      "Checked 2026-11-11 10:05 to 10:20.",
      // Twelve digits that fail the Luhn check, and a Luhn-valid run no card brand starts with.
      "Order id 412345678901",
      "Reference 0000000000000000",
    ]) {
      expect([note, holdsCardNumber(note)]).toEqual([note, false]);
      expect(refusals({ outcome: "not_booked", note })).toEqual([]);
    }
    expect(holdsCardNumber("4111111111111111")).toBe(true);
    expect(holdsCardNumber("4111 1111 1111 1111")).toBe(true);
  });
});

describe("the review of a booking", () => {
  it("[OBE-099 AC1] is open while the booking is pending with reconcile_outcome = manual_review", () => {
    expect(inReview({ status: "pending", reconcileOutcome: "manual_review" })).toBe(true);
  });

  it("[OBE-099 AC2] is closed or never opened otherwise: the reconciliation still decides, or it decided", () => {
    for (const state of [
      { status: "pending", reconcileOutcome: null },
      { status: "confirmed", reconcileOutcome: "found" },
      { status: "ticketed", reconcileOutcome: "found" },
      { status: "failed", reconcileOutcome: "not_found" },
      { status: "confirmed", reconcileOutcome: null },
      { status: "cancelled", reconcileOutcome: "manual_review" },
    ]) {
      expect([state, inReview(state)]).toEqual([state, false]);
    }
  });

  it("[OBE-099 AC2] refuses a booking not in review with 409 CONFLICT not_in_review, its status and outcome", () => {
    const error = notInReview({ status: "confirmed", reconcileOutcome: "found" });
    expect([error.code, error.status, error.details]).toEqual([
      "CONFLICT",
      409,
      { reason: "not_in_review", status: "confirmed", reconcileOutcome: "found" },
    ]);
  });

  it("[OBE-099 AC2] refuses an order without the booking's remark, and one another booking holds", () => {
    const mismatch = remarkMismatch("VX7K2Q");
    expect([mismatch.code, mismatch.status, mismatch.details]).toEqual([
      "CONFLICT",
      409,
      { reason: "remark_mismatch" },
    ]);
    expect(mismatch.message).toContain("VELEXIS VX7K2Q");
    const held = orderHeldBy({ id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2", reference: "K7M2QF" });
    expect([held.code, held.status, held.details]).toEqual([
      "ORDER_ALREADY_IMPORTED",
      409,
      { bookingId: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2", reference: "K7M2QF" },
    ]);
  });
});

describe("the staff event booking.reconcile_closed", () => {
  it("[OBE-099] of order_found names the outcome and the record locator, nothing else", () => {
    const event = closureEventOf({
      outcome: "order_found",
      reference: "VX7K2Q",
      recordLocator: "L2P9XC",
      airlineCard: false,
    });
    expect(event.type).toBe(REVIEW_CLOSED_EVENT);
    expect(event.data).toEqual({ outcome: "order_found", recordLocator: "L2P9XC" });
    expect(event.summary).toContain("L2P9XC");
  });

  it("[OBE-099] of not_booked names the outcome, and for an airline card that the agent asks the airline about a charge", () => {
    const stripe = closureEventOf({
      outcome: "not_booked",
      reference: "VX7K2Q",
      recordLocator: null,
      airlineCard: false,
    });
    expect(stripe.data).toEqual({ outcome: "not_booked", recordLocator: null });
    expect(stripe.summary).not.toContain(AIRLINE_CARD_CHARGE_NOTE);
    const airline = closureEventOf({
      outcome: "not_booked",
      reference: "VX7K2Q",
      recordLocator: null,
      airlineCard: true,
    });
    expect(airline.data).toEqual({
      outcome: "not_booked",
      recordLocator: null,
      airlineCard: true,
      airlineChargeCheck: "agent_asks_airline",
    });
    expect(airline.summary).toContain(AIRLINE_CARD_CHARGE_NOTE);
    // Never a card value: the note names no card number, brand or holder.
    expect(holdsCardNumber(airline.summary)).toBe(false);
  });
});

describe("a failed read of the order by record locator", () => {
  it("[OBE-099] answers Amadeus's 404 as 404 NOT_FOUND with the supplier error, and passes the supplier codes", () => {
    const supplier = { provider: "amadeus" as const, status: 404, code: 1797, title: "NOT FOUND" };
    const amadeus404 = new AppError("SUPPLIER_ERROR", {
      supplier,
      cause: new AmadeusCallError("getFlightOrderByReference", { kind: "http", status: 404, issues: [] }),
    });
    const answer = closureSupplierAnswerOf(amadeus404) as AppError;
    expect([answer.code, answer.status, answer.supplier]).toEqual(["NOT_FOUND", 404, supplier]);
    expect(answer.message).toBe("Amadeus has no order with this record locator.");
    for (const code of [
      "OFFICE_NOT_ALLOWED",
      "SUPPLIER_REJECTED",
      "SUPPLIER_NOT_CONFIGURED",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
      "SUPPLIER_ERROR",
      "SUPPLIER_UNAVAILABLE",
      "SUPPLIER_TIMEOUT",
    ] as const) {
      expect((closureSupplierAnswerOf(new AppError(code)) as AppError).code).toBe(code);
    }
    // Any other code of the client is not this operation's: a 502.
    expect((closureSupplierAnswerOf(new AppError("VERSION_CONFLICT")) as AppError).code).toBe(
      "SUPPLIER_ERROR",
    );
    const bug = new Error("a bug");
    expect(closureSupplierAnswerOf(bug)).toBe(bug);
  });
});

describe("an answer of the read by record locator", () => {
  const order = { type: "flight-order", id: "eJzTd9cPMQ0OCgI" };

  it("[OBE-099] takes the orders of data, a list or one order", () => {
    expect(ordersOfReply({ data: [order] }, 200).orders).toEqual([order]);
    expect(ordersOfReply({ data: order, dictionaries: {} }, 200)).toEqual({
      orders: [order],
      body: { data: order, dictionaries: {} },
    });
  });

  it("[OBE-099] answers a 200 without an order as Amadeus's own 404: 404 NOT_FOUND with the supplier marker", () => {
    // Lead decision (20l) of 2026-11-13: the same `error.supplier` mark as Amadeus's own 404, so the OTA admin shows
    // "Amadeus has no order" at the record locator for both.
    for (const body of [
      { data: [] },
      {},
      { data: null },
      { data: ["not an order"] },
      { meta: { count: 0 } },
    ]) {
      let caught: unknown;
      try {
        ordersOfReply(body, 200);
      } catch (error) {
        caught = error;
      }
      expect(isAppError(caught)).toBe(true);
      const error = caught as AppError;
      expect([body, error.code, error.status, error.supplier, error.message]).toEqual([
        body,
        "NOT_FOUND",
        404,
        { provider: "amadeus", status: 200 },
        "Amadeus has no order with this record locator.",
      ]);
    }
  });

  it("[OBE-099] answers a body that is no JSON object as the supplier's error, without the not-found mark", () => {
    for (const body of [undefined, "<html>", ["an order"]]) {
      let caught: unknown;
      try {
        ordersOfReply(body, 200);
      } catch (error) {
        caught = error;
      }
      expect(isAppError(caught) && [caught.code, caught.supplier]).toEqual(["SUPPLIER_ERROR", undefined]);
    }
  });
});
