// What staff may still refund of a payment (action-rules.ts `refundableOf`; FIX-W32-OTA, lead decision (1h) of
// 2026-10-28): captured less refunded less the refunds still on their way to Stripe, as the API counts it, on the
// booking page and on the payment's own page alike.
//
// The cancel dialog's Amadeus step (`cancelPlanOf`, lead decision (2a) of 2026-10-30, FIX-W35-OTA): the API's own
// `cancellationMode`, whatever the tickets' issue times look like in another zone, and no step without one.
import type { ConsoleBooking, ConsolePayment } from "@velexis/ota-sdk";
import { describe, expect, it } from "vitest";

import { cancelPlanOf, issuePlanOf, refundableOf, refundsInFlightOf } from "./action-rules";

const eur = (amount: string) => ({ amount, currency: "EUR" });

type Refund = ConsolePayment["refunds"][number];

/** A refund of the payment in `status` (the fields the rules read; the rest as the API writes them). */
function refund(amount: string, status: Refund["status"], currency = "EUR"): Refund {
  return {
    id: "rfd_01JA6B2C4D6E8F0G2H4J6K8M0N",
    paymentId: "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1",
    bookingId: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
    amount: { amount, currency },
    penalty: null,
    reason: "goodwill",
    status,
    createdAt: "2026-10-12T08:00:00Z",
    processedAt: null,
    reasonNote: null,
    requestedBy: { type: "staff", id: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y" },
    providerRefundId: null,
    failureReason: null,
    updatedAt: "2026-10-12T08:00:00Z",
  } as Refund;
}

/** A captured Stripe payment of 1,414.06 EUR with 100.00 refunded, and `refunds`. */
function payment(refunds: readonly Refund[], overrides: Partial<ConsolePayment> = {}): ConsolePayment {
  return {
    id: "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1",
    provider: "stripe",
    method: "card",
    status: "partially_refunded",
    amount: eur("1414.06"),
    amountAuthorized: eur("1414.06"),
    amountCaptured: eur("1414.06"),
    amountRefunded: eur("100.00"),
    refunds: [...refunds],
    ...overrides,
  } as unknown as ConsolePayment;
}

describe("refundableOf", () => {
  it("[FIX-W32-OTA AC7] subtracts the refunds still pending or processing, never the succeeded or failed ones", () => {
    const refunds = [
      refund("100.00", "succeeded"),
      refund("300.00", "pending"),
      refund("14.06", "processing"),
      refund("50.00", "failed"),
    ];
    expect(refundsInFlightOf(payment(refunds))).toEqual(eur("314.06"));
    expect(refundableOf(payment(refunds))).toEqual(eur("1000.00"));
    // Without a refund in flight: captured less refunded, as before.
    expect(refundableOf(payment([refund("100.00", "succeeded")]))).toEqual(eur("1314.06"));
  });

  it("[FIX-W32-OTA AC7] offers nothing once the refunds in flight take what is left", () => {
    expect(refundableOf(payment([refund("1314.06", "pending")]))).toBeUndefined();
    expect(refundableOf(payment([refund("1400.00", "processing")]))).toBeUndefined();
  });

  it("[FIX-W32-OTA AC7] shows captured less refunded when a refund in flight cannot be counted (the API decides)", () => {
    expect(refundableOf(payment([refund("12.5x", "pending")]))).toEqual(eur("1314.06"));
    expect(refundableOf(payment([refund("10.00", "pending", "USD")]))).toEqual(eur("1314.06"));
  });

  it("never offers an airline-card payment or one that captured nothing", () => {
    expect(
      refundableOf(payment([], { provider: "airline", method: "airline_card" } as never)),
    ).toBeUndefined();
    expect(refundableOf(payment([], { status: "authorized" }))).toBeUndefined();
  });
});

describe("issuePlanOf", () => {
  /** A booking of one flight offer with `payments` (the fields the plan reads). */
  const booking = (payments: readonly Partial<ConsoleBooking["payments"][number]>[]): ConsoleBooking =>
    ({
      itineraries: [{ segments: [{ flightOfferId: "1" }] }],
      recordLocators: [],
      formOfPayments: [],
      paymentStatus: "unpaid",
      payments,
    }) as unknown as ConsoleBooking;

  it("[OAD-016 AC1] counts an airline card the airline did not charge as unpaid, as the API does", () => {
    // No ticket came back: the payment stays `processing` (backend settleAirlineCardOrder), and only an owner or an
    // admin may issue the booking, with allowUnpaid and the OTA's settlement (console-operations.md §2 step 8).
    expect(
      issuePlanOf(booking([{ method: "airline_card", provider: "airline", status: "processing" }])),
    ).toEqual({
      kind: "airline_card",
      flightOfferIds: ["1"],
      charged: false,
    });
    expect(
      issuePlanOf(booking([{ method: "airline_card", provider: "airline", status: "captured" }])),
    ).toEqual({
      kind: "airline_card",
      flightOfferIds: ["1"],
      charged: true,
    });
  });
});

describe("cancelPlanOf: the API's cancellation mode (FIX-W35-OTA)", () => {
  const DAY = 24 * 60 * 60_000;
  /** A ticketed booking without payment whose one ticket was issued at `issuedAt`, with the API's `cancellationMode`. */
  function ticketedBooking(
    issuedAt: string,
    cancellationMode: ConsoleBooking["cancellationMode"],
  ): ConsoleBooking {
    return {
      tickets: [{ status: "ISSUED", issuedAt }],
      payments: [],
      totals: { currency: "EUR" },
      ...(cancellationMode === undefined ? {} : { cancellationMode }),
    } as unknown as ConsoleBooking;
  }

  it("[FIX-W35-OTA AC2] shows the step the API decided, not one computed from the tickets' issue times", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * DAY).toISOString();
    const deadline = new Date(Date.now() + DAY).toISOString();
    // The API's day (the storefront's zone) still has these tickets as today's: void, as the API says.
    expect(
      cancelPlanOf(ticketedBooking(twoDaysAgo, { mode: "void", voidDeadlineAt: deadline })).supplier,
    ).toBe("void");
    // And the other way round: tickets issued a moment ago that the API finds outside its void window.
    const justNow = new Date().toISOString();
    expect(
      cancelPlanOf(ticketedBooking(justNow, { mode: "request_only", voidDeadlineAt: null })).supplier,
    ).toBe("request_only");
    expect(cancelPlanOf(ticketedBooking(justNow, { mode: "release", voidDeadlineAt: null })).supplier).toBe(
      "release",
    );
  });

  it("[FIX-W35-OTA AC2] names no step when the answer has no mode (null, or an answer from before the field)", () => {
    const justNow = new Date().toISOString();
    expect(cancelPlanOf(ticketedBooking(justNow, null))).toEqual({
      supplier: null,
      money: { kind: "none" },
      modes: ["none"],
      currency: "EUR",
    });
    expect(cancelPlanOf(ticketedBooking(justNow, undefined)).supplier).toBeNull();
  });

  it("[FIX-W37-OTA AC1] offers a request to the airline no refund, whatever the payment, and every mode to a void", () => {
    const justNow = new Date().toISOString();
    const captured = (cancellationMode: ConsoleBooking["cancellationMode"]): ConsoleBooking =>
      ({
        ...ticketedBooking(justNow, cancellationMode),
        payments: [
          {
            provider: "stripe",
            method: "card",
            status: "captured",
            amountCaptured: { amount: "125.47", currency: "EUR" },
            amountRefunded: { amount: "0.00", currency: "EUR" },
          },
        ],
      }) as unknown as ConsoleBooking;
    // Lead decision (2b) of 2026-10-31: the airline is asked first; the refund follows from the payment.
    expect(cancelPlanOf(captured({ mode: "request_only", voidDeadlineAt: null }))).toEqual({
      supplier: "request_only",
      money: { kind: "captured", refundable: { amount: "125.47", currency: "EUR" } },
      modes: ["none"],
      currency: "EUR",
    });
    const tonight = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(cancelPlanOf(captured({ mode: "void", voidDeadlineAt: tonight })).modes).toEqual([
      "none",
      "full",
      "amount",
    ]);
  });
});
