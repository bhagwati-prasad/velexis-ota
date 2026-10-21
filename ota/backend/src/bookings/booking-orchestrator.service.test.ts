// The decisions of the booking orchestrator (OBE-042, booking-orchestrator.service.ts and order-recorder.ts) that do
// not need a service: how a Flight Create Orders failure is classified (refused → void, not sent → keep the
// authorisation, unknown → pending; OADR-0003), what the client is answered, how a created order is read, which
// booking and ticketing status its tickets give for each ticketing policy, the ticketing deadline and the segments
// recorded. The Amadeus errors are the client's own (error-mapper.ts), the answers the Amadeus stub's synthetic
// fixtures. The flow itself, with PostgreSQL, Redis, the stub and the fake Stripe API, is test/integration/bookings.
import { AppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { amadeusFixtureBody, buildCreatedOrderBody } from "../../test/builders/bookings";
import { AmadeusCallError, mapAmadeusError } from "../amadeus/error-mapper";
import { parseOffer, type ParsedOffer } from "../shopping/offers.mapper";
import {
  CAPTURE_RETRY_DELAY_MS,
  createFailureKind,
  notSentAnswer,
  PAYMENT_JOBS,
  REPRICE_AFTER_MS,
  rejectionAnswer,
} from "./booking-orchestrator.service";
import {
  deadlineLocalOf,
  FIRST_TICKETING_RETRY_MS,
  lastTicketingDateOf,
  readCreatedOrder,
  segmentPlansOf,
  ticketCoverage,
  ticketingMessageOf,
  ticketingStateOf,
  ticketsOf,
} from "./order-recorder";

/** The client's error for an Amadeus 4xx with these issue codes (Flight Create Orders). */
const httpError = (status: number, ...codes: number[]): AppError =>
  mapAmadeusError("createFlightOrders", {
    kind: "http",
    status,
    issues: codes.map((code) => ({ status, code, title: `CODE ${code}` })),
  });

const offerOf = (body: Record<string, unknown>): ParsedOffer => {
  const data = body["data"] as { flightOffers: unknown[] };
  const parsed = parseOffer(data.flightOffers[0]);
  if (parsed === undefined) {
    throw new Error("the fixture's offer does not parse");
  }
  return parsed;
};

describe("a failed Flight Create Orders", () => {
  // OADR-0003 (FIX-W22): only an Amadeus 4xx business refusal proves that no order was created. An Amadeus 5xx (141
  // SYSTEM ERROR included) and a 502 or 503 were counted as a refusal and as "not sent" before; they are unknown now.
  it("[OBE-042 AC2] counts an Amadeus 4xx business refusal as refused: the authorisation is voided", () => {
    for (const error of [
      httpError(400, 34651),
      httpError(400, 37200),
      httpError(400, 4926),
      httpError(400, 9112),
      httpError(400, 2552),
      httpError(400),
      httpError(404),
    ]) {
      expect([error.code, createFailureKind(error)]).toEqual([error.code, "rejected"]);
    }
  });

  it("[FIX-W22 AC4] counts every answer that does not prove a refusal as unknown: the order may exist, the booking stays pending", () => {
    for (const error of [
      mapAmadeusError("createFlightOrders", { kind: "timeout" }),
      mapAmadeusError("createFlightOrders", { kind: "network", code: "ECONNRESET" }),
      mapAmadeusError("createFlightOrders", { kind: "network", code: "UND_ERR_SOCKET" }),
      mapAmadeusError("createFlightOrders", { kind: "network" }),
      httpError(504),
      httpError(500, 141),
      httpError(500),
      httpError(502),
      httpError(503),
      // A 2xx whose body is not JSON, and a status Amadeus never gives: the request was received.
      httpError(201),
      httpError(302),
    ]) {
      expect([error.code, createFailureKind(error)]).toEqual([error.code, "unknown"]);
    }
  });

  it("counts what never reached the order, or was refused before it was processed, as not sent: the authorisation is kept", () => {
    const tokenTimeout = new AppError("SUPPLIER_TIMEOUT", { cause: new Error("token request failed") });
    for (const error of [
      mapAmadeusError("createFlightOrders", { kind: "network", code: "ECONNREFUSED" }),
      mapAmadeusError("createFlightOrders", { kind: "network", code: "ENOTFOUND" }),
      httpError(429),
      httpError(401),
      httpError(403),
      tokenTimeout,
      new AppError("RATE_LIMITED"),
      new AppError("SERVICE_UNAVAILABLE"),
      new AppError("SUPPLIER_NOT_CONFIGURED"),
      new TypeError("a bug before the call"),
    ]) {
      expect(createFailureKind(error)).toBe("not_sent");
    }
    expect(new AmadeusCallError("createFlightOrders", { kind: "timeout" }).outcome).toBe("timeout");
  });

  it("[OBE-042 AC2] answers 409 SOLD_OUT, 422 TRAVELER_DATA_INVALID and 502 TICKETING_FAILED as Amadeus gave them, any other refusal as 502 SUPPLIER_ERROR", () => {
    const priceDetails = { oldPrice: { amount: "98.47", currency: "EUR" }, pricedOfferId: "pro_x" };
    const soldOut = httpError(400, 34651);
    expect(rejectionAnswer(soldOut, priceDetails)).toBe(soldOut);
    const travellers = mapAmadeusError("createFlightOrders", {
      kind: "http",
      status: 400,
      issues: [{ status: 400, code: 4926, source: { pointer: "/data/travelers/0/documents/0/number" } }],
    });
    expect(rejectionAnswer(travellers, priceDetails)).toMatchObject({
      code: "TRAVELER_DATA_INVALID",
      fieldErrors: [{ path: "/travelers/0/documents/0/number", code: "invalid" }],
    });
    expect(rejectionAnswer(httpError(400, 9112), priceDetails).code).toBe("TICKETING_FAILED");
    const price = rejectionAnswer(httpError(400, 37200), priceDetails);
    expect(price).toMatchObject({ code: "PRICE_CHANGED", details: priceDetails });
    const rejected = rejectionAnswer(httpError(400, 4926), priceDetails);
    expect(rejected).toMatchObject({ code: "SUPPLIER_ERROR", supplier: { provider: "amadeus", code: 4926 } });
    expect(rejectionAnswer(httpError(400, 2552), priceDetails).code).toBe("SUPPLIER_ERROR");
  });

  it("answers what was not sent in the operation's codes: a timeout before the order is 503, an office 424", () => {
    const tokenTimeout = new AppError("SUPPLIER_TIMEOUT", { cause: new Error("token request failed") });
    expect(notSentAnswer(tokenTimeout)).toMatchObject({ code: "SUPPLIER_UNAVAILABLE", cause: tokenTimeout });
    expect(notSentAnswer(new AppError("OFFICE_NOT_ALLOWED"))).toMatchObject({
      code: "SUPPLIER_NOT_CONFIGURED",
    });
    expect(notSentAnswer(httpError(400))).toMatchObject({ code: "SUPPLIER_ERROR" });
    const unavailable = httpError(503);
    expect(notSentAnswer(unavailable)).toBe(unavailable);
    const bug = new TypeError("a bug");
    expect(notSentAnswer(bug)).toBe(bug);
  });
});

describe("the created order", () => {
  it("[OBE-042 AC1] reads the id, the record locator, the offers, the travellers, the tickets and the warnings", () => {
    const body = buildCreatedOrderBody({
      tickets: "full",
      recordLocator: "AB12CD",
      warnings: [{ status: 200, code: 9112, title: "TICKETING" }],
    });

    const order = readCreatedOrder(body);

    expect(order).toMatchObject({
      records: [{ reference: "AB12CD", originSystemCode: "GDS", flightOfferId: "2" }],
      queuingOfficeId: "NCE1A0955",
      travelerIds: ["1"],
      tickets: [{ documentType: "ETICKET", documentStatus: "ISSUED", travelerId: "1", segmentIds: ["3"] }],
      warnings: [{ code: 9112, title: "TICKETING" }],
    });
    expect(order?.id).toBe((body["data"] as { id: string }).id);
    expect(order?.offers.map((offer) => offer.amadeusId)).toEqual(["2"]);
  });

  it("is unreadable without an id, a record locator of the stored form or readable offers", () => {
    const withoutId = buildCreatedOrderBody();
    delete (withoutId["data"] as Record<string, unknown>)["id"];
    const badLocator = buildCreatedOrderBody({ recordLocator: "ab-12" });
    const badOffer = buildCreatedOrderBody();
    (badOffer["data"] as Record<string, unknown>)["flightOffers"] = [{ id: "2" }];
    const noOffer = buildCreatedOrderBody();
    (noOffer["data"] as Record<string, unknown>)["flightOffers"] = [];

    for (const body of [withoutId, badLocator, badOffer, noOffer, {}, null, "text"]) {
      expect(readCreatedOrder(body)).toBeUndefined();
    }
  });

  it("keeps only travel documents with a known type and a ticket number", () => {
    expect(
      ticketsOf({
        tickets: [
          { documentType: "ETICKET", documentNumber: "000-0000000001", travelerId: "1" },
          { documentType: "ETICKET", documentNumber: "not a number", travelerId: "2" },
          { documentType: "BOARDING_PASS", documentNumber: "000-0000000003" },
          { documentType: "EMD", documentNumber: "0001234567890", documentStatus: "VOID" },
        ],
      }).map((ticket) => [
        ticket.documentType,
        ticket.documentNumber,
        ticket.documentStatus,
        ticket.travelerId,
      ]),
    ).toEqual([
      ["ETICKET", "000-0000000001", "ISSUED", "1"],
      ["EMD", "0001234567890", "VOID", null],
    ]);
  });
});

describe("the booking and ticketing status after the order", () => {
  it("[OBE-042 AC1] is ticketed when every traveller has an e-ticket, partially ticketed when some have", () => {
    const full = readCreatedOrder(buildCreatedOrderBody({ tickets: "full", travelerIds: ["1", "2"] }));
    const partial = readCreatedOrder(buildCreatedOrderBody({ tickets: "partial", travelerIds: ["1", "2"] }));
    const none = readCreatedOrder(buildCreatedOrderBody({ travelerIds: ["1", "2"] }));

    expect(ticketCoverage(full?.travelerIds ?? [], full?.tickets ?? [])).toBe("full");
    expect(ticketCoverage(partial?.travelerIds ?? [], partial?.tickets ?? [])).toBe("partial");
    expect(ticketCoverage(none?.travelerIds ?? [], none?.tickets ?? [])).toBe("none");
    expect(ticketCoverage([], [])).toBe("none");
    expect(ticketingStateOf("full", { issueRequested: true, policy: "issue_at_booking" })).toEqual({
      status: "ticketed",
      ticketingStatus: "issued",
      issueFailed: false,
    });
    expect(ticketingStateOf("partial", { issueRequested: true, policy: "issue_at_booking" })).toMatchObject({
      status: "partially_ticketed",
      ticketingStatus: "partially_issued",
    });
  });

  it("[OBE-042 AC1] is confirmed without tickets: pending for issue_after_payment, manual_review for manual_review, failed when issue=true gave none", () => {
    expect(ticketingStateOf("none", { issueRequested: false, policy: "issue_after_payment" })).toEqual({
      status: "confirmed",
      ticketingStatus: "pending",
      issueFailed: false,
    });
    expect(ticketingStateOf("none", { issueRequested: false, policy: "manual_review" })).toMatchObject({
      status: "confirmed",
      ticketingStatus: "manual_review",
    });
    expect(ticketingStateOf("none", { issueRequested: true, policy: "issue_at_booking" })).toEqual({
      status: "confirmed",
      ticketingStatus: "failed",
      issueFailed: true,
    });
    expect(ticketingMessageOf("confirmed", "manual_review")).toMatch(/our team will issue/i);
    expect(ticketingMessageOf("failed", "not_applicable")).toBeNull();
  });

  it("has its ticketing deadline at the start of the last ticketing day, or the order's earlier agreement date", () => {
    expect(deadlineLocalOf("2027-01-15", null)).toBe("2027-01-15T00:00:00");
    expect(deadlineLocalOf("2027-01-15", { option: "DELAY_TO_CANCEL", dateTime: "2027-01-10T18:30" })).toBe(
      "2027-01-10T18:30:00",
    );
    expect(deadlineLocalOf("2027-01-15", { dateTime: "2027-01-20" })).toBe("2027-01-15T00:00:00");
    expect(deadlineLocalOf(null, { dateTime: "not a date" })).toBeNull();
    const offer = offerOf(amadeusFixtureBody("flight-create-orders"));
    expect(lastTicketingDateOf([offer])).toBe(offer.lastTicketingDate);
    expect(lastTicketingDateOf([])).toBeNull();
  });

  it("retries a failed issuance first after five minutes and a failed capture after ten (OADR-0008 points 4 and 7)", () => {
    expect(FIRST_TICKETING_RETRY_MS).toBe(5 * 60_000);
    expect(CAPTURE_RETRY_DELAY_MS).toBe(10 * 60_000);
    expect(REPRICE_AFTER_MS).toBe(10 * 60_000);
    expect(PAYMENT_JOBS).toEqual({ captureRetry: "payment.capture_retry", void: "payment.void" });
  });
});

describe("the segments recorded", () => {
  it("numbers the itineraries across the offers and takes the lead traveller's fare", () => {
    const offer = offerOf(amadeusFixtureBody("flight-create-orders"));
    const second = parseOffer({
      ...(
        amadeusFixtureBody("flight-create-orders")["data"] as { flightOffers: Array<Record<string, unknown>> }
      ).flightOffers[0],
      id: "7",
    });

    const plans = segmentPlansOf(second === undefined ? [offer] : [offer, second]);

    expect(
      plans.map((plan) => [
        plan.amadeusFlightOfferId,
        plan.amadeusSegmentId,
        plan.itineraryIndex,
        plan.segmentIndex,
        plan.carrierCode,
        plan.flightNumber,
        plan.departureIata,
        plan.arrivalIata,
        plan.cabin,
        plan.bookingClass,
        plan.fareBasis,
        plan.brandedFare,
      ]),
    ).toEqual([
      ["2", "3", 0, 0, "IB", "3436", "MAD", "ORY", "ECONOMY", "A", "ADNNALB4", "BASIC"],
      ["7", "3", 1, 0, "IB", "3436", "MAD", "ORY", "ECONOMY", "A", "ADNNALB4", "BASIC"],
    ]);
    expect(plans[0]?.includedCheckedBags).toMatchObject({ quantity: 0 });
    expect(plans[0]?.fareDetails).toEqual([
      { travelerId: "1", cabin: "ECONOMY", fareBasis: "ADNNALB4", brandedFare: "BASIC", class: "A" },
    ]);
  });
});
