// The customer bookings answers (OBE-046, bookings.mapper.ts): the Amadeus order as customer scope sees it (no net
// price, office, card, staff remark or full document number), fare rules without the net refund preview, events
// without their actor, list cards and tabs, the ticketing status's polling, and the keyset cursors. Pure functions over
// the Amadeus stub's synthetic order (test/builders/bookings.ts); no service is called.
import { isAppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { buildCreatedOrderBody } from "../../test/builders/bookings";
import { newDocumentNumber } from "../../test/builders/checkouts";
import type {
  BookingEventRow,
  BookingListRow,
  BookingRefundRow,
  BookingRow,
  SummarySegmentRow,
} from "./bookings.repository";
import {
  cancellationOf,
  cancelReasonParts,
  customerOrderOf,
  decodeListCursor,
  encodeListCursor,
  listFingerprint,
  orderRecordsOf,
  pageOf,
  pollAfterSecondsOf,
  snapshotOffersOf,
  timeframeOf,
  toBookingEvent,
  toBookingFareRules,
  toBookingSummary,
  toTicketingStatus,
  type CancellationInput,
  type StoredFareRules,
} from "./bookings.mapper";
import {
  CANCELLATION_EVENTS,
  cancellationStateOf,
  type CancellationEventRow,
  type CancellationFacts,
} from "./cancellation-state";

type JsonObject = Record<string, unknown>;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const now = new Date();
const at = (offsetMs: number): Date => new Date(now.getTime() + offsetMs);

/** A stored order snapshot: the stub's order of offer 2 with everything customer scope must not see added. */
function snapshotWith(documentNumber: string, cardNumber: string): JsonObject {
  const data = buildCreatedOrderBody({ tickets: "full" })["data"] as JsonObject;
  data["ownerOfficeId"] = "NCE1A0955";
  data["commissions"] = [{ controls: ["MANUAL"], values: [{ commissionType: "NEW", percentage: 5 }] }];
  data["formOfPayments"] = [
    { other: { method: "ACCOUNT", flightOfferIds: ["2"] } },
    { creditCard: { brand: "VISA", holder: "ALEX TESTER", number: cardNumber, expiryDate: "2099-12" } },
  ];
  data["remarks"] = {
    general: [
      { subType: "GENERAL_MISCELLANEOUS", text: "VEGETARIAN MEAL PLEASE" },
      { subType: "BACKOFFICE", text: "VELEXIS VX7K2M9Q" },
    ],
    airline: [{ subType: "OTHER_SERVICE_INFORMATION", airlineCode: "IB", text: "STAFF ONLY" }],
  };
  data["formOfIdentifications"] = [
    { identificationType: "PASSPORT", number: documentNumber, travelerIds: ["1"] },
  ];
  const travelers = data["travelers"] as JsonObject[];
  travelers[0] = {
    ...travelers[0],
    documents: [
      {
        documentType: "PASSPORT",
        number: documentNumber,
        expiryDate: "2099-01-01",
        issuanceCountry: "SE",
        nationality: "SE",
        holder: true,
      },
    ],
  };
  const offer = (data["flightOffers"] as JsonObject[])[0] as JsonObject;
  offer["fareRules"] = {
    currency: "EUR",
    rules: [
      {
        category: "REFUND",
        notApplicable: false,
        maxPenaltyAmount: "40.00",
        refundingPreview: { totalRefund: { amount: "58.47", currencyCode: "EUR" } },
      },
    ],
  };
  return data;
}

describe("the Amadeus order in customer scope", () => {
  const documentNumber = newDocumentNumber();
  const cardNumber = "4111111111111111";

  it("folds the markup into the prices and drops offices, commissions, cards, staff remarks and full numbers", () => {
    const amadeus = customerOrderOf({
      snapshot: snapshotWith(documentNumber, cardNumber),
      dictionaries: {
        locations: { MAD: { cityCode: "MAD", countryCode: "ES" } },
        carriers: { IB: "IBERIA" },
        currencies: { EUR: "EURO" },
      },
      markupAmount: "12.00",
      minorUnits: 2,
      visibleRemarks: ["Vegetarian meal please"],
    });

    expect(amadeus).not.toBeNull();
    const order = amadeus?.order as unknown as JsonObject;
    const offer = (order["flightOffers"] as JsonObject[])[0] as JsonObject;
    // Net 98.47 plus the markup, as a priced offer shows it.
    expect(offer["price"]).toMatchObject({ base: "68.00", total: "110.47", grandTotal: "110.47" });
    const pricing = (offer["travelerPricings"] as JsonObject[])[0] as JsonObject;
    expect(pricing["price"]).toMatchObject({ total: "110.47" });
    for (const field of ["queuingOfficeId", "ownerOfficeId", "automatedProcess", "commissions"]) {
      expect(order).not.toHaveProperty(field);
    }
    expect(order["formOfPayments"]).toEqual([
      { other: { method: "ACCOUNT", flightOfferIds: ["2"] } },
      { creditCard: { brand: "VISA" } },
    ]);
    expect(order["remarks"]).toEqual({
      general: [{ subType: "GENERAL_MISCELLANEOUS", text: "VEGETARIAN MEAL PLEASE" }],
    });
    const rule = ((offer["fareRules"] as JsonObject)["rules"] as JsonObject[])[0];
    expect(rule).not.toHaveProperty("refundingPreview");
    const text = JSON.stringify(amadeus);
    expect(text).not.toContain(documentNumber);
    expect(text).toContain(documentNumber.slice(-4));
    expect(text).not.toContain(cardNumber.slice(0, 12));
    expect(text).not.toContain("98.47");
    expect(amadeus?.flightOrderId).toBe(order["id"]);
    // Only the maps the document's AmadeusDictionaries can validate (its location and currency entries require `key`).
    expect(amadeus?.dictionaries).toEqual({ carriers: { IB: "IBERIA" } });
  });

  it("shows no order rather than one whose offer cannot be read (its price could not be made a selling price)", () => {
    const snapshot = snapshotWith(documentNumber, cardNumber);
    (snapshot["flightOffers"] as JsonObject[]).push({ id: "3", price: { total: "10.00" } });

    expect(
      customerOrderOf({
        snapshot,
        dictionaries: null,
        markupAmount: "1.00",
        minorUnits: 2,
        visibleRemarks: [],
      }),
    ).toBeNull();
    expect(
      customerOrderOf({
        snapshot: {},
        dictionaries: null,
        markupAmount: "0",
        minorUnits: 2,
        visibleRemarks: [],
      }),
    ).toBeNull();
  });
});

describe("the fare rules of a booking", () => {
  it("lists the rules and never the net refund preview or an amount taken from it", () => {
    const snapshot = snapshotWith(newDocumentNumber(), "4111111111111111");
    const offer = (snapshot["flightOffers"] as JsonObject[])[0] as JsonObject;
    const stored: StoredFareRules = {
      loadedAt: now.toISOString(),
      types: ["rebooks", "refunds"],
      offers: [{ flightOfferId: "2", fareRules: offer["fareRules"] }],
    };

    const rules = toBookingFareRules({
      booking: { id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2", currency: "EUR" },
      stored,
      offers: snapshotOffersOf(snapshot),
      minorUnits: 2,
    });

    expect(rules).toMatchObject({
      bookingId: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
      currency: "EUR",
      available: true,
      types: ["rebooks", "refunds"],
      summary: {
        refundable: true,
        refundPenalty: { amount: "40.00", currency: "EUR" },
        source: "fare_rules",
      },
      rules: [
        {
          flightOfferId: "2",
          category: "REFUND",
          applicable: true,
          maxPenalty: { amount: "40.00", currency: "EUR" },
          refundEstimate: null,
        },
      ],
      loadedAt: now.toISOString(),
    });
    expect(JSON.stringify(rules)).not.toContain("refundingPreview");
    expect(JSON.stringify(rules)).not.toContain("58.47");
  });

  it("is unavailable when the airline returned no rule", () => {
    const rules = toBookingFareRules({
      booking: { id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2", currency: "EUR" },
      stored: { loadedAt: now.toISOString(), types: ["refunds"], offers: [] },
      offers: [],
      minorUnits: 2,
    });

    expect(rules).toMatchObject({ available: false, rules: [], amadeus: [], summary: { source: "unknown" } });
  });
});

describe("the associated records of a refreshed order", () => {
  it("keeps the records that can be stored, and a creation time only in the Amadeus form", () => {
    const records = orderRecordsOf({
      associatedRecords: [
        {
          reference: "QX8P4L",
          originSystemCode: "GDS",
          creationDate: "2026-01-02T03:04:05.000",
          flightOfferId: "1",
        },
        { reference: "K7M2PQ", originSystemCode: "IB", creationDate: "yesterday" },
        { reference: "not a locator", originSystemCode: "IB" },
        { reference: "ZZ9Y8X" },
        "QX8P4L",
      ],
    });

    expect(records).toEqual([
      {
        reference: "QX8P4L",
        originSystemCode: "GDS",
        creationDate: "2026-01-02T03:04:05.000",
        flightOfferId: "1",
      },
      { reference: "K7M2PQ", originSystemCode: "IB", creationDate: null, flightOfferId: null },
    ]);
    expect(orderRecordsOf(undefined)).toEqual([]);
  });
});

describe("the events of a booking", () => {
  it("shows the actor's type only, and the event's data through the shared redactor", () => {
    const row: BookingEventRow = {
      id: "evt_01JA4CG9E9H2L5P8S1W4Z7C0F3",
      bookingId: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
      type: "booking.ticketed",
      actorType: "system",
      statusFrom: "confirmed",
      statusTo: "ticketed",
      summary: null,
      data: { tickets: ["057-2412345678"], bookingToken: "should-never-show" },
      createdAt: now,
      sortKey: "2026-01-01T00:00:00.000000",
    };

    const event = toBookingEvent(row);

    expect(event).toEqual({
      id: row.id,
      bookingId: row.bookingId,
      type: "booking.ticketed",
      actorType: "system",
      summary: "booking.ticketed",
      statusFrom: "confirmed",
      statusTo: "ticketed",
      data: { tickets: ["057-2412345678"], bookingToken: "[REDACTED]" },
      createdAt: now.toISOString(),
    });
  });
});

describe("the list cards", () => {
  const base: BookingListRow = {
    id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
    reference: "VX7K2Q9M",
    status: "ticketed",
    recordLocator: "QX8P4L",
    tripType: "round_trip",
    originIata: "MAD",
    destinationIata: "ORY",
    firstDepartureAt: at(10 * DAY),
    lastArrivalAt: at(17 * DAY),
    firstDepartureLocal: "2030-01-10T07:15:00",
    travelersCount: 2,
    currency: "EUR",
    totalAmount: "220.9",
    ticketingStatus: "issued",
    leadLastName: "SAMPLE",
    hasScheduleChange: false,
    createdAt: at(-DAY),
    cancelledAt: null,
    sortKey: "2030-01-10T06:15:00.000000",
  };
  const segments: SummarySegmentRow[] = [
    {
      bookingId: base.id,
      itineraryIndex: 0,
      departureIata: "MAD",
      arrivalIata: "ORY",
      departureLocal: "2030-01-10T07:15:00",
      arrivalLocal: "2030-01-10T09:20:00",
      carrierCode: "IB",
    },
    {
      bookingId: base.id,
      itineraryIndex: 1,
      departureIata: "ORY",
      arrivalIata: "BCN",
      departureLocal: "2030-01-17T10:00:00",
      arrivalLocal: "2030-01-17T11:30:00",
      carrierCode: "VY",
    },
    {
      bookingId: base.id,
      itineraryIndex: 1,
      departureIata: "BCN",
      arrivalIata: "MAD",
      departureLocal: "2030-01-17T13:00:00",
      arrivalLocal: "2030-01-17T14:20:00",
      carrierCode: "IB",
    },
  ];

  it("shows the bounds, the return, the lead traveller and the selling total", () => {
    const card = toBookingSummary({
      row: base,
      segments,
      lead: { firstName: "TESTA", lastName: "SAMPLE" },
      cityName: "Paris",
      minorUnits: 2,
      now,
    });

    expect(card).toMatchObject({
      timeframe: "upcoming",
      originCode: "MAD",
      destinationCode: "ORY",
      destinationCityName: "Paris",
      departureAt: "2030-01-10T07:15:00",
      returnAt: "2030-01-17T10:00:00",
      leadTravelerName: "TESTA SAMPLE",
      total: { amount: "220.90", currency: "EUR" },
      legs: [
        { originCode: "MAD", destinationCode: "ORY", stops: 0, carrierCodes: ["IB"] },
        { originCode: "ORY", destinationCode: "MAD", stops: 1, carrierCodes: ["VY", "IB"] },
      ],
    });
  });

  it("shows a pending booking without segments by its stored trip and lead last name", () => {
    const card = toBookingSummary({
      row: { ...base, status: "pending", tripType: null, ticketingStatus: "pending" },
      segments: [],
      lead: undefined,
      cityName: undefined,
      minorUnits: 2,
      now,
    });

    expect(card).toMatchObject({
      tripType: "one_way",
      departureAt: base.firstDepartureLocal,
      returnAt: null,
      legs: [],
      leadTravelerName: "SAMPLE",
      destinationCityName: null,
    });
  });

  it("puts a booking on the tab db README §10 gives it", () => {
    expect(timeframeOf("confirmed", at(HOUR), now)).toBe("upcoming");
    expect(timeframeOf("confirmed", now, now)).toBe("upcoming");
    expect(timeframeOf("ticketed", at(-HOUR), now)).toBe("past");
    expect(timeframeOf("cancelled", at(DAY), now)).toBe("cancelled");
  });
});

describe("the ticketing status", () => {
  it("polls every 10 s while the create-order outcome is unknown, every 5 s while ticketing runs, never when final", () => {
    expect(pollAfterSecondsOf("pending", "pending")).toBe(10);
    expect(pollAfterSecondsOf("confirmed", "pending")).toBe(5);
    expect(pollAfterSecondsOf("confirmed", "in_progress")).toBe(5);
    expect(pollAfterSecondsOf("ticketed", "issued")).toBeNull();
    expect(pollAfterSecondsOf("confirmed", "manual_review")).toBeNull();
    expect(pollAfterSecondsOf("failed", "not_applicable")).toBeNull();
  });

  it("gives a failed booking's failure code and no polling", () => {
    const booking = {
      id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
      status: "failed",
      ticketingStatus: "not_applicable",
      ticketingDeadlineAt: null,
      issuedAt: null,
      ticketingNextAttemptAt: null,
      ticketingAttempts: 0,
      failureCode: "SUPPLIER_ERROR",
      lastSyncedAt: null,
    } as unknown as BookingRow;

    expect(
      toTicketingStatus({
        booking,
        policy: "issue_after_payment",
        requestedAt: null,
        lastAttemptAt: null,
        errorCode: null,
        tickets: [],
      }),
    ).toMatchObject({
      bookingStatus: "failed",
      status: "not_applicable",
      failureCode: "SUPPLIER_ERROR",
      pollAfterSeconds: null,
    });
  });
});

describe("the list cursors", () => {
  const fingerprint = listFingerprint({ list: "bookings", timeframe: "past", sort: "-departure" });
  const rows = [
    { id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2", sortKey: "2026-01-02T03:04:05.123456" },
    { id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T3", sortKey: "2026-01-01T03:04:05.000001" },
  ];

  it("starts the next page after the last row of this one, for the same filters only", () => {
    const { rows: page, page: info } = pageOf(rows, 1, fingerprint);

    expect(page).toEqual([rows[0]]);
    expect(info.limit).toBe(1);
    const cursor = info.nextCursor ?? "";
    expect(decodeListCursor(cursor, fingerprint)).toEqual({
      fingerprint,
      key: rows[0]?.sortKey,
      id: rows[0]?.id,
    });
    expect(pageOf(rows, 2, fingerprint).page.nextCursor).toBeNull();

    const other = listFingerprint({ list: "bookings", timeframe: "upcoming", sort: "departure" });
    for (const bad of [
      cursor,
      "",
      "not a cursor",
      Buffer.from("[1]").toString("base64url"),
      encodeListCursor({ fingerprint, key: "2026-01-01", id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2" }),
    ]) {
      const check = () => decodeListCursor(bad, bad === cursor ? other : fingerprint);
      expect(check).toThrow();
      try {
        check();
      } catch (error) {
        expect(isAppError(error) && error.code).toBe("VALIDATION_FAILED");
      }
    }
  });
});

describe("the cancellation of a booking (FIX-W28-CANCEL)", () => {
  const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3M6P9T2";
  const cancelledAt = at(-HOUR);
  const requestedAt = at(-HOUR - 60_000).toISOString();
  const event = (type: string, data: JsonObject, offsetMs = 0): CancellationEventRow => ({
    type,
    actorType: "customer",
    actorId: "cus_1",
    data,
    createdAt: at(-HOUR + offsetMs),
  });
  const refund = (patch: Partial<BookingRefundRow>): BookingRefundRow => ({
    id: "rfd_01JA4CG3S8W1Z4C7F0H3M6P9T2",
    paymentId: "pay_1",
    currency: "EUR",
    amount: "100.47",
    penaltyAmount: "25.00",
    reason: "customer_request",
    status: "succeeded",
    createdAt: cancelledAt,
    processedAt: cancelledAt,
    ...patch,
  });
  const facts = (patch: Partial<CancellationFacts> = {}): CancellationFacts => ({
    cancelled: undefined,
    state: { kind: "none" },
    claimPending: false,
    payments: new Map(),
    ...patch,
  });
  const input = (patch: Partial<CancellationInput> = {}): CancellationInput => ({
    booking: { id: BOOKING_ID, status: "cancelled", cancelledAt, amountPaid: "0.00" },
    cancelledBy: "customer",
    cancelReason: "illness",
    tickets: [],
    refunds: [],
    minorUnits: 2,
    facts: facts(),
    scope: "customer",
    ...patch,
  });
  /** The `booking.cancelled` event of a customer's cancellation that captured the kept amount of `pay_1`. */
  const captured = (extra: JsonObject = {}): CancellationEventRow =>
    event(CANCELLATION_EVENTS.cancelled, {
      cancelledBy: "customer",
      mode: "release",
      reasonCode: "illness",
      comment: "Sick",
      requestedAt,
      ticketsVoided: false,
      estimatedRefund: { amount: "100.47", currency: "EUR" },
      refundStatus: "pending",
      capturePaymentId: "pay_1",
      captureAmount: "25.00",
      releaseAmount: "100.47",
      ...extra,
    });

  it("[FIX-W28-CANCEL AC3] shows the customer's typed reason, comment, request time and estimate", () => {
    expect(cancellationOf(input({ facts: facts({ cancelled: captured() }) }))).toMatchObject({
      bookingId: BOOKING_ID,
      status: "cancelled",
      cancelledBy: "customer",
      reasonCode: "illness",
      comment: "Sick",
      requestedAt,
      cancelledAt: cancelledAt.toISOString(),
      estimatedRefund: { amount: "100.47", currency: "EUR" },
    });
    // An airline cancellation: its reason is the airline's (cancel_reason holds a text, not a code), no comment.
    expect(
      cancellationOf(
        input({
          cancelledBy: "airline",
          cancelReason: "Every segment of the order was cancelled by the airline.",
          facts: facts({ cancelled: event(CANCELLATION_EVENTS.cancelled, { cancelledBy: "airline" }) }),
        }),
      ),
    ).toMatchObject({ cancelledBy: "airline", reasonCode: "airline_request", comment: null, refund: null });
    expect(cancellationOf(input({ cancelReason: null }))?.reasonCode).toBe("other");
  });

  it("[FIX-W28-CANCEL AC1] shows a kept amount's capture pending, then the release as a succeeded refund", () => {
    const authorised = new Map([["pay_1", { status: "authorized", captureReviewed: false }]]);
    // Queued: pending, no refund yet.
    expect(
      cancellationOf(input({ facts: facts({ cancelled: captured(), payments: authorised }) })),
    ).toMatchObject({ refund: null, refundStatus: "pending" });
    // The payments queue gave up and alerted the staff.
    expect(
      cancellationOf(
        input({
          facts: facts({
            cancelled: captured(),
            payments: new Map([["pay_1", { status: "authorized", captureReviewed: true }]]),
          }),
        }),
      )?.refundStatus,
    ).toBe("manual_review");
    // Captured and released: the release is the refund, succeeded.
    const done = cancellationOf(
      input({
        refunds: [refund({})],
        facts: facts({
          cancelled: captured(),
          payments: new Map([["pay_1", { status: "captured", captureReviewed: false }]]),
        }),
      }),
    );
    expect(done).toMatchObject({
      refundStatus: "succeeded",
      refund: {
        id: "rfd_01JA4CG3S8W1Z4C7F0H3M6P9T2",
        paymentId: "pay_1",
        amount: { amount: "100.47", currency: "EUR" },
        penalty: { amount: "25.00", currency: "EUR" },
        status: "succeeded",
      },
    });
    // The authorisation lapsed or was cancelled before any capture: nothing was captured.
    expect(
      cancellationOf(
        input({
          facts: facts({
            cancelled: captured(),
            payments: new Map([["pay_1", { status: "canceled", captureReviewed: false }]]),
          }),
        }),
      )?.refundStatus,
    ).toBe("authorization_voided");
    // The whole authorisation kept: nothing goes back.
    expect(
      cancellationOf(input({ facts: facts({ cancelled: captured({ releaseAmount: "0.00" }) }) }))
        ?.refundStatus,
    ).toBe("not_applicable");
  });

  it("[FIX-W28-CANCEL AC1] says authorization_voided only once a void of an authorisation that kept nothing happened", () => {
    const voided = event(CANCELLATION_EVENTS.cancelled, {
      cancelledBy: "customer",
      reasonCode: "change_of_plans",
      refundStatus: "pending",
      voidPaymentId: "pay_2",
    });
    expect(
      cancellationOf(
        input({
          facts: facts({
            cancelled: voided,
            payments: new Map([["pay_2", { status: "canceled", captureReviewed: false }]]),
          }),
        }),
      ),
    ).toMatchObject({ refund: null, refundStatus: "authorization_voided" });
    expect(
      cancellationOf(
        input({
          facts: facts({
            cancelled: voided,
            payments: new Map([["pay_2", { status: "authorized", captureReviewed: false }]]),
          }),
        }),
      )?.refundStatus,
    ).toBe("pending");
  });

  it("[FIX-W28-CANCEL AC3] shows a request waiting for the staff and an undecided cancellation as pending", () => {
    const request = event(CANCELLATION_EVENTS.requested, {
      mode: "request_only",
      cause: "request_only",
      reasonCode: "duplicate_booking",
      comment: "Booked twice",
      requestedAt,
      amountPaid: "125.47",
      estimatedRefund: { amount: "0.00", currency: "EUR" },
    });
    const live = { id: BOOKING_ID, status: "ticketed", cancelledAt: null, amountPaid: "125.47" };
    expect(
      cancellationOf(
        input({ booking: live, cancelReason: null, facts: facts({ state: cancellationStateOf([request]) }) }),
      ),
    ).toEqual({
      bookingId: BOOKING_ID,
      status: "pending",
      requestedAt,
      cancelledAt: null,
      cancelledBy: "customer",
      reasonCode: "duplicate_booking",
      comment: "Booked twice",
      ticketsVoided: false,
      estimatedRefund: { amount: "0.00", currency: "EUR" },
      refund: null,
      refundStatus: "manual_review",
    });
    const flag = event(CANCELLATION_EVENTS.timeout, {
      mode: "release",
      reasonCode: "illness",
      comment: "Sick",
      estimate: { amountPaid: "125.47", estimatedRefund: "100.47", penalty: "0.00", otaFee: "25.00" },
      currency: "EUR",
      requestedAt,
      until: at(10 * 60_000).toISOString(),
      actor: { type: "customer", id: "cus_1" },
      requestId: "req_1",
    });
    expect(
      cancellationOf(input({ booking: live, facts: facts({ state: cancellationStateOf([flag]) }) })),
    ).toMatchObject({
      status: "pending",
      reasonCode: "illness",
      comment: "Sick",
      estimatedRefund: { amount: "100.47", currency: "EUR" },
      refundStatus: "pending",
    });
    // Nothing requested, or a DELETE the airline did not apply: no cancellation.
    expect(cancellationOf(input({ booking: live }))).toBeNull();
    expect(
      cancellationOf(
        input({
          booking: live,
          facts: facts({
            state: cancellationStateOf([event(CANCELLATION_EVENTS.notApplied, {}, 1), flag]),
          }),
        }),
      ),
    ).toBeNull();
  });

  it("[FIX-W28-CANCEL AC3] never shows staff text in customer scope, and shows a staff member's reason in console scope", () => {
    const staff = event(CANCELLATION_EVENTS.cancelled, {
      cancelledBy: "staff",
      reason: "Duplicate of another booking (internal note)",
    });
    const base = {
      cancelledBy: "staff",
      cancelReason: "duplicate",
      facts: facts({ cancelled: staff }),
    } as const;
    expect(cancellationOf(input(base))).toMatchObject({ reasonCode: "duplicate", comment: null });
    expect(cancellationOf(input({ ...base, scope: "console" }))?.comment).toBe(
      "Duplicate of another booking (internal note)",
    );
  });

  it("[OBE-063 AC3] reads a staff cancellation's `<reasonCode>: <reason>`: the code everywhere, the text in console scope only", () => {
    const staff = {
      cancelledBy: "staff",
      cancelReason: "fraud: Card reported stolen by the issuer",
      // The customer-visible event names the code and never the staff member's text.
      facts: facts({
        cancelled: event(CANCELLATION_EVENTS.cancelled, { cancelledBy: "staff", reasonCode: "fraud" }),
      }),
    } as const;
    expect(cancellationOf(input(staff))).toMatchObject({
      cancelledBy: "staff",
      reasonCode: "fraud",
      comment: null,
    });
    expect(cancellationOf(input({ ...staff, scope: "console" }))).toMatchObject({
      reasonCode: "fraud",
      comment: "Card reported stolen by the issuer",
    });
    expect(cancelReasonParts("no_payment: Unpaid after 3 reminders")).toEqual({
      code: "no_payment",
      text: "Unpaid after 3 reminders",
    });
    expect(cancelReasonParts("illness")).toEqual({ code: "illness", text: null });
    expect(cancelReasonParts("Every segment was cancelled: by the airline")).toEqual({
      code: null,
      text: "Every segment was cancelled: by the airline",
    });
    expect(cancelReasonParts(null)).toEqual({ code: null, text: null });
  });

  it("shows an undecided staff cancellation (a DELETE without an answer) as the staff's, without its text", () => {
    const live = { id: BOOKING_ID, status: "ticketed", cancelledAt: null, amountPaid: "125.47" };
    const flag = event(CANCELLATION_EVENTS.timeout, {
      mode: "void",
      reasonCode: "fraud",
      estimate: { amountPaid: "125.47", estimatedRefund: "125.47", penalty: "0.00", otaFee: "0.00" },
      currency: "EUR",
      requestedAt,
      until: at(10 * 60_000).toISOString(),
      actor: { type: "staff", id: "stf_1" },
      requestId: "req_1",
      cancelledBy: "staff",
      staff: { reason: "Card reported stolen", refundMode: "full", notifyCustomer: true },
    });
    for (const scope of ["customer", "console"] as const) {
      const pending = cancellationOf(
        input({ booking: live, scope, facts: facts({ state: cancellationStateOf([flag]) }) }),
      );
      expect(pending).toMatchObject({
        status: "pending",
        cancelledBy: "staff",
        reasonCode: "fraud",
        comment: null,
      });
      expect(JSON.stringify(pending)).not.toContain("Card reported stolen");
    }
  });
});
