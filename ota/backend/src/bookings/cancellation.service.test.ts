// The pure rules of bookings.cancel (OBE-049, cancellation.service.ts): which payment the money step acts on, how a
// Flight Order Management DELETE ended, the answers of errors that changed nothing, the state a booking's cancellation
// events give, the worker's reading of an order, and the facts the fee engine prices a booking's cancellation with.
// No service is called; the flows are proven in test/integration/bookings/cancel.int.test.ts.
import { AppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { AmadeusCallError } from "../amadeus/error-mapper";
import type { PaymentRow } from "../payments/payments.repository";
import type { BookingChildren, BookingRow } from "./bookings.repository";
import {
  authorisationSettlementOf,
  BOOKING_BUSY_RETRY_AFTER_SECONDS,
  BookingBusyError,
  CANCELLATION_EVENTS,
  cancellationCheckJob,
  cancellationStateOf,
  checkRunOf,
  deleteFailureOf,
  flagOf,
  moneyOf,
  orderCancelled,
  parseCancellationCheckJobData,
  pricingInputOfBooking,
  quoteValid,
  refundReasonOf,
  retryAfterOf,
  selfServiceCancellationOf,
  unsentAnswer,
  type CancellationEventRow,
  type CancellationQuote,
} from "./cancellation.service";

const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3M6P9T2";
const TENANT_ID = "ten_01JA4CG3S8W1Z4C7F0H3L6P9T2";

function payment(overrides: Partial<PaymentRow>): PaymentRow {
  return {
    id: "pay_1",
    environment: "test",
    checkoutId: null,
    bookingId: BOOKING_ID,
    customerId: null,
    provider: "stripe",
    providerConnectionId: null,
    providerPaymentId: "pi_1",
    method: "card",
    captureMethod: "manual",
    currency: "EUR",
    amount: "125.47",
    cardFeeAmount: "0",
    amountAuthorized: "125.47",
    amountCaptured: "125.47",
    amountRefunded: "0",
    status: "captured",
    cardBrand: "VISA",
    cardBin: null,
    cardLast4: "4242",
    cardExpMonth: null,
    cardExpYear: null,
    threeDs: null,
    nextAction: null,
    failureCode: null,
    failureMessage: null,
    authorizedAt: null,
    capturedAt: null,
    canceledAt: null,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    checkoutCustomerId: null,
    checkoutIsGuest: false,
    ...overrides,
  };
}

/** An Amadeus answer of `status` (none: no answer in time) as the client throws it, with the API code `code`. */
const amadeusError = (
  code: ConstructorParameters<typeof AppError>[0],
  status: number | undefined,
): AppError =>
  new AppError(code, {
    cause: new AmadeusCallError(
      "cancelFlightOrder",
      status === undefined ? { kind: "timeout" } : { kind: "http", status, issues: [] },
    ),
  });

describe("the payment of the money step", () => {
  it("refunds a captured Stripe payment while something is left, else voids an authorisation, else the airline's", () => {
    const captured = payment({ id: "pay_c" });
    const authorised = payment({ id: "pay_a", status: "authorized", amountCaptured: "0" });
    const airline = payment({
      id: "pay_x",
      provider: "airline",
      method: "airline_card",
      providerPaymentId: null,
    });
    expect(moneyOf([authorised, captured], new Map())).toEqual({
      row: captured,
      estimate: { kind: "stripe_captured", captured: "125.47", refundable: "125.47" },
    });
    // Partly refunded: what it captured, and what is left.
    expect(
      moneyOf(
        [payment({ status: "partially_refunded", amountRefunded: "25.47" })],
        new Map([["pay_1", "50.00"]]),
      )?.estimate,
    ).toEqual({ kind: "stripe_captured", captured: "125.47", refundable: "50.00" });
    // Refunded in full meanwhile (in flight counts): nothing to refund, the authorisation comes next.
    expect(moneyOf([captured, authorised], new Map([["pay_c", "125.47"]]))?.estimate.kind).toBe(
      "stripe_authorized",
    );
    expect(moneyOf([airline], new Map())).toEqual({
      row: airline,
      estimate: { kind: "airline", charged: "125.47" },
    });
    expect(
      moneyOf([payment({ status: "canceled" }), payment({ status: "failed" })], new Map()),
    ).toBeUndefined();
  });
});

describe("an authorisation the cancellation settles", () => {
  it("[FIX-W28-CANCEL AC1] captures the amount kept and releases the rest; voids it when nothing is kept", () => {
    // 125.47 authorised, 100.47 back: 25.00 captured (the fees kept), 100.47 released.
    expect(authorisationSettlementOf("125.47", "100.47", 2)).toEqual({
      kind: "capture",
      amount: "25.00",
      release: "100.47",
    });
    // Everything kept: the whole authorisation captured, nothing released.
    expect(authorisationSettlementOf("125.47", "0.00", 2)).toEqual({
      kind: "capture",
      amount: "125.47",
      release: "0.00",
    });
    // Nothing kept: only then a void.
    expect(authorisationSettlementOf("125.47", "125.47", 2)).toEqual({ kind: "void" });
    // An estimate above the authorisation releases no more than it holds.
    expect(authorisationSettlementOf("125.47", "200.00", 2)).toEqual({ kind: "void" });
    expect(authorisationSettlementOf("12000", "11500", 0)).toEqual({
      kind: "capture",
      amount: "500",
      release: "11500",
    });
  });
});

describe("how a DELETE ended", () => {
  it("tells an order Amadeus no longer has, a conflict, a refusal, a request never sent and an unknown outcome apart", () => {
    expect(deleteFailureOf(amadeusError("SUPPLIER_REJECTED", 404))).toEqual({ kind: "order_not_found" });
    expect(deleteFailureOf(amadeusError("VERSION_CONFLICT", 409)).kind).toBe("version_conflict");
    expect(deleteFailureOf(amadeusError("SUPPLIER_REJECTED", 400))).toEqual({
      kind: "refused",
      code: "SUPPLIER_REJECTED",
    });
    expect(deleteFailureOf(amadeusError("SUPPLIER_UNAVAILABLE", 429)).kind).toBe("not_sent");
    expect(deleteFailureOf(new AppError("RATE_LIMITED")).kind).toBe("not_sent");
    expect(deleteFailureOf(amadeusError("SUPPLIER_TIMEOUT", 504)).kind).toBe("unknown");
    expect(deleteFailureOf(amadeusError("SUPPLIER_ERROR", 500)).kind).toBe("unknown");
    expect(deleteFailureOf(amadeusError("SUPPLIER_TIMEOUT", undefined)).kind).toBe("unknown");
  });

  it("answers an error that changed nothing in the operation's codes, never with a 504", () => {
    expect((unsentAnswer(new AppError("SUPPLIER_TIMEOUT")) as AppError).code).toBe("SUPPLIER_UNAVAILABLE");
    expect((unsentAnswer(new AppError("OFFICE_NOT_ALLOWED")) as AppError).code).toBe(
      "SUPPLIER_NOT_CONFIGURED",
    );
    expect((unsentAnswer(new AppError("RATE_LIMITED")) as AppError).code).toBe("RATE_LIMITED");
    expect((unsentAnswer(new AppError("SUPPLIER_REJECTED")) as AppError).code).toBe("SUPPLIER_ERROR");
    const bug = new Error("a bug");
    expect(unsentAnswer(bug)).toBe(bug);
  });
});

describe("the state of a booking's cancellation", () => {
  const row = (type: string, data: unknown = {}, offsetMs = 0): CancellationEventRow => ({
    type,
    actorType: "customer",
    actorId: "cus_1",
    data,
    createdAt: new Date(Date.now() + offsetMs),
  });
  const flagData = {
    mode: "release",
    reasonCode: "illness",
    comment: "Sick",
    estimate: { amountPaid: "125.47", estimatedRefund: "100.47", penalty: "0.00", otaFee: "25.00" },
    currency: "EUR",
    requestedAt: new Date().toISOString(),
    until: new Date(Date.now() + 15 * 60_000).toISOString(),
    actor: { type: "customer", id: "cus_1" },
    requestId: "req_1",
  };

  it("reads the flag of a DELETE without an answer", () => {
    expect(flagOf(row(CANCELLATION_EVENTS.timeout, flagData))).toMatchObject({
      mode: "release",
      reasonCode: "illness",
      comment: "Sick",
      estimate: { estimatedRefund: "100.47" },
      actor: { type: "customer", id: "cus_1" },
    });
    expect(flagOf(row(CANCELLATION_EVENTS.timeout, { ...flagData, mode: "request_only" }))).toBeUndefined();
    expect(flagOf(row(CANCELLATION_EVENTS.timeout, { ...flagData, estimate: {} }))).toBeUndefined();
  });

  it("is undecided after a flag, decided by a later event, and pending while a request waits", () => {
    const flag = row(CANCELLATION_EVENTS.timeout, flagData);
    expect(cancellationStateOf([])).toEqual({ kind: "none" });
    expect(cancellationStateOf([flag]).kind).toBe("undecided");
    expect(cancellationStateOf([row(CANCELLATION_EVENTS.manualReview, {}, 1), flag]).kind).toBe("undecided");
    expect(cancellationStateOf([row(CANCELLATION_EVENTS.notApplied, {}, 1), flag])).toEqual({
      kind: "not_applied",
    });
    const request = row(CANCELLATION_EVENTS.requested);
    expect(cancellationStateOf([request])).toEqual({ kind: "requested", event: request });
    // A flag whose data cannot be read decides nothing.
    expect(cancellationStateOf([row(CANCELLATION_EVENTS.timeout, {})])).toEqual({ kind: "none" });
  });
});

describe("the worker's reading of an order", () => {
  const order = (...statuses: string[]) => ({
    flightOffers: [{ itineraries: [{ segments: statuses.map((bookingStatus) => ({ bookingStatus })) }] }],
  });

  it("counts an order cancelled only when every segment is", () => {
    expect(orderCancelled(order("CANCELLED", "CANCELLED"))).toBe(true);
    expect(orderCancelled(order("CANCELLED", "CONFIRMED"))).toBe(false);
    expect(orderCancelled(order())).toBe(false);
    expect(orderCancelled({})).toBe(false);
  });
});

describe("the check job", () => {
  it("has the two ids only and a deterministic id per flag and run, the first 30 s later", () => {
    const deadline = Date.now() + 15 * 60_000;
    expect(cancellationCheckJob(TENANT_ID, BOOKING_ID, deadline, 1)).toEqual({
      name: "booking.cancellation_check",
      data: { tenantId: TENANT_ID, bookingId: BOOKING_ID },
      opts: { jobId: `booking.cancellation_check:${BOOKING_ID}:${deadline}-1`, delay: 30_000 },
    });
    const later = cancellationCheckJob(TENANT_ID, BOOKING_ID, deadline, 4);
    expect(later.opts).toEqual({
      jobId: `booking.cancellation_check:${BOOKING_ID}:${deadline}-4`,
      delay: 60_000,
    });
    // BullMQ wants exactly three parts in a custom id with `:`.
    expect(later.opts.jobId.split(":")).toHaveLength(3);
    expect(checkRunOf({ id: later.opts.jobId })).toEqual({ deadlineMs: deadline, run: 4 });
    expect(checkRunOf({ id: "something-else" })).toEqual({ deadlineMs: 0, run: 1 });
    expect(parseCancellationCheckJobData({ tenantId: TENANT_ID, bookingId: BOOKING_ID })).toBeDefined();
    expect(
      parseCancellationCheckJobData({ tenantId: TENANT_ID, bookingId: BOOKING_ID, extra: 1 }),
    ).toBeUndefined();
    expect(parseCancellationCheckJobData({ tenantId: TENANT_ID, bookingId: "bkg_x" })).toBeUndefined();
  });
});

describe("small rules", () => {
  it("maps the customer's reason codes to refund reasons", () => {
    expect(refundReasonOf("schedule_change")).toBe("schedule_change");
    expect(refundReasonOf("duplicate_booking")).toBe("duplicate");
    expect(refundReasonOf("illness")).toBe("customer_request");
  });

  it("[FIX-W28-CANCEL AC5] gives Retry-After to the 503 of a booking another claim holds, and to no other error", () => {
    // The claim's own 503 (cancellation.service.ts bookingBusy) carries a BookingBusyError as its cause.
    const busy = new AppError("SERVICE_UNAVAILABLE", { cause: new BookingBusyError("held") });
    expect(retryAfterOf(busy)).toBe(BOOKING_BUSY_RETRY_AFTER_SECONDS);
    expect(BOOKING_BUSY_RETRY_AFTER_SECONDS).toBe(1);
    expect(retryAfterOf(new AppError("SERVICE_UNAVAILABLE"))).toBeUndefined();
    expect(retryAfterOf(new Error("x"))).toBeUndefined();
  });

  it("keeps self-service cancellation off unless the OTA turned it on", () => {
    expect(selfServiceCancellationOf({ selfServiceCancellation: true })).toBe(true);
    expect(selfServiceCancellationOf({})).toBe(false);
    expect(selfServiceCancellationOf(null)).toBe(false);
  });

  it("uses a cached quote for its version only, while it and its void window are valid", () => {
    const now = new Date();
    const quote = {
      bookingId: BOOKING_ID,
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      voidDeadlineAt: null,
    } as unknown as CancellationQuote;
    expect(quoteValid({ v: 1, version: 2, quote }, 2, now)).toBe(true);
    expect(quoteValid({ v: 1, version: 2, quote }, 3, now)).toBe(false);
    expect(quoteValid({ v: 1, version: 2, quote: { ...quote, expiresAt: now.toISOString() } }, 2, now)).toBe(
      false,
    );
    expect(
      quoteValid({ v: 1, version: 2, quote: { ...quote, voidDeadlineAt: now.toISOString() } }, 2, now),
    ).toBe(false);
    // A refusal is never reused: a cancellation undecided when it was made may be decided now, at the same version.
    expect(quoteValid({ v: 1, version: 2, quote: { ...quote, mode: "not_allowed" } }, 2, now)).toBe(false);
  });

  it("prices a booking's cancellation with the facts of its own rows", () => {
    const booking = {
      currency: "EUR",
      netAmount: "98.47",
      originIata: "MAD",
      destinationIata: "ORY",
      validatingCarrier: "IB",
      tripType: "one_way",
      originSystemCode: "GDS",
      channel: "storefront",
    } as BookingRow;
    const children = {
      travelers: [{ travelerType: "ADULT" }, { travelerType: "CHILD" }, { travelerType: "ADULT" }],
      segments: [
        { departureIata: "MAD", arrivalIata: "ORY", carrierCode: "IB", cabin: "ECONOMY" },
        { departureIata: "ORY", arrivalIata: "MAD", carrierCode: "UX", cabin: null },
      ],
    } as unknown as BookingChildren;
    const at = new Date();
    expect(
      pricingInputOfBooking({
        booking,
        children,
        countryOf: (code) => (code === "MAD" ? "ES" : "FR"),
        minorUnits: 2,
        at,
      }),
    ).toEqual({
      at,
      currency: "EUR",
      minorUnits: 2,
      netTotal: "98.47",
      origin: "MAD",
      destination: "ORY",
      originCountry: "ES",
      destinationCountry: "FR",
      validatingCarriers: ["IB"],
      marketingCarriers: ["IB", "UX"],
      cabins: ["ECONOMY"],
      travelers: { ADULT: 2, CHILD: 1 },
      segmentCount: 2,
      tripType: "one_way",
      source: "GDS",
      channel: "storefront",
    });
  });
});
