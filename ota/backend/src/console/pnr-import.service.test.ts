// The pure rules of the console PNR lookup and import (OBE-064, pnr-import.service.ts): the office isolation of the
// shared Amadeus account (ADR-0012, OF-09 AC3), what the tenant's supplier log keeps of another office's order, the
// lookup's summary and booking link, the order an import takes, its status, net and selling amounts for the three
// pricing modes (OADR-0005 point 10) and its contact e-mail. The orders are the Amadeus stub's synthetic fixture
// (test/builders/bookings.ts); the HTTP, database and Amadeus paths are in
// test/integration/console/pnr-import.int.test.ts.
import { isAppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { buildCreatedOrderBody } from "../../test/builders/bookings";
import { orderSegmentsOf } from "../bookings/order-diff";
import { readCreatedOrder, type CreatedOrder } from "../bookings/order-recorder";
import type { FeeRule, MarkupRule } from "../pricing/pricing.types";
import {
  attachedBookingOf,
  chooseImportOrder,
  importableCustomer,
  importContactEmailOf,
  importCustomerUnavailable,
  importNetOf,
  importPricingOf,
  importStateOf,
  isTenantOrder,
  orderOfficeOf,
  partitionOrders,
  pnrMatchOf,
  pnrSummaryOf,
  refuseImportRequest,
  storedDocumentOf,
  WITHHELD_ORDER,
  withheldBody,
  withheldResponseOf,
  type AttachedBooking,
  type ImportRulesContext,
} from "./pnr-import.service";

type JsonObject = Record<string, unknown>;

const OWN = "NCE1A0001";
const OWN_SECOND = "NCE1A0002";
const OTHER = "PAR1A0950";
const OFFICES = [OWN, OWN_SECOND];
const AT = new Date("2026-11-01T12:00:00.000Z");

/** The fixture's order (Madrid–Paris Orly, one adult, net 98.47 EUR) with `fields` over its data. */
function orderData(
  fields: JsonObject = {},
  options: Parameters<typeof buildCreatedOrderBody>[0] = {},
): JsonObject {
  const body = buildCreatedOrderBody(options);
  return { ...(body["data"] as JsonObject), ...fields };
}

/** The fixture's order as the record step reads it. */
function createdOrder(
  fields: JsonObject = {},
  options: Parameters<typeof buildCreatedOrderBody>[0] = {},
): CreatedOrder {
  const body = buildCreatedOrderBody(options);
  const order = readCreatedOrder({ ...body, data: { ...(body["data"] as JsonObject), ...fields } });
  if (order === undefined) {
    throw new Error("the fixture's order cannot be read");
  }
  return order;
}

/** The error a call throws, or a failure when it throws none. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

const codeOf = (error: unknown): unknown =>
  isAppError(error) ? [error.status, error.code, error.details] : error;

/** A percentage markup rule matching everything. */
function markupRule(id: string, percentage: string): MarkupRule {
  return {
    id,
    name: `Rule ${id}`,
    scope: {},
    calculation: "percentage",
    percentage,
    fixedAmount: null,
    fixedCurrency: null,
    appliesPer: "booking",
    minAmount: null,
    maxAmount: null,
    priority: 100,
    stackable: false,
    isDefault: false,
    isActive: true,
    activeFrom: null,
    activeUntil: null,
  };
}

/** A fixed fee per booking in EUR. */
function feeRule(id: string, feeType: FeeRule["feeType"], amount: string): FeeRule {
  return {
    id,
    name: `Fee ${id}`,
    label: `Label ${id}`,
    feeType,
    scope: {},
    calculation: "fixed",
    percentage: null,
    fixedAmount: amount,
    fixedCurrency: "EUR",
    appliesPer: "booking",
    minAmount: null,
    maxAmount: null,
    refundable: false,
    priority: 100,
    isActive: true,
    activeFrom: null,
    activeUntil: null,
  };
}

const NO_RULES: ImportRulesContext = {
  at: AT,
  minorUnits: 2,
  markupRules: [],
  feeRules: [],
  countryOf: () => null,
  cityOf: () => null,
};

describe("the office isolation of the shared account (ADR-0012)", () => {
  it("[OBE-064 AC1] takes the owner office, else the queuing office, as the office that holds an order", () => {
    expect(orderOfficeOf({ ownerOfficeId: OWN, queuingOfficeId: OTHER })).toBe(OWN);
    expect(orderOfficeOf({ queuingOfficeId: OTHER })).toBe(OTHER);
    expect(orderOfficeOf({ ownerOfficeId: "", queuingOfficeId: OWN })).toBe(OWN);
    expect(orderOfficeOf({})).toBeNull();
  });

  it("[OBE-064 AC1] keeps only the orders of the tenant's offices: another OTA's order is never the tenant's", () => {
    expect(isTenantOrder({ ownerOfficeId: OWN_SECOND }, OFFICES)).toBe(true);
    expect(isTenantOrder({ queuingOfficeId: OWN }, OFFICES)).toBe(true);
    // Owned by another office: queuing it at the tenant's office does not make it the tenant's.
    expect(isTenantOrder({ ownerOfficeId: OTHER, queuingOfficeId: OWN }, OFFICES)).toBe(false);
    expect(isTenantOrder({ queuingOfficeId: OTHER }, OFFICES)).toBe(false);
    expect(isTenantOrder({}, OFFICES)).toBe(false);

    const mine = { id: "a", ownerOfficeId: OWN };
    const theirs = { id: "b", queuingOfficeId: OTHER };
    expect(partitionOrders([theirs, mine], OFFICES)).toEqual({ allowed: [mine], withheld: [theirs] });
  });

  it("[OBE-064 AC1] keeps another office's order out of the tenant's supplier log, its id and a marker only", () => {
    const mine = orderData({ ownerOfficeId: OWN });
    const theirs = orderData({
      ownerOfficeId: OTHER,
      travelers: [{ id: "1", name: { firstName: "OTHERA", lastName: "TRAVELLER" } }],
    });
    const body = {
      data: [mine, theirs],
      included: { bags: { "1": { quantity: 1 } } },
      // The dictionaries describe every order of the answer: the other OTA's airports and carriers too.
      dictionaries: {
        locations: { BCN: { cityCode: "BCN", countryCode: "ES" } },
        carriers: { ZZ: "ZED AIR" },
      },
      warnings: [{ code: 1, title: "W" }],
    };

    const kept = withheldBody(body, [theirs]);

    expect(kept).toEqual({
      data: [mine, { type: "flight-order", id: theirs["id"], withheld: WITHHELD_ORDER }],
      warnings: [{ code: 1, title: "W" }],
    });
    // Quoted: a JSON key or value, never part of a base64url order id.
    for (const secret of ["TRAVELLER", '"BCN"', "ZED AIR"]) {
      expect(JSON.stringify(kept)).not.toContain(secret);
    }
    // Nothing withheld: the answer is kept whole.
    expect(withheldBody(body, [])).toEqual(body);
    // A Management GET answer (one order) is reduced the same way.
    expect(withheldBody({ data: theirs }, [theirs])).toEqual({
      data: { type: "flight-order", id: theirs["id"], withheld: WITHHELD_ORDER },
    });
  });

  it("[FIX-W32-OTA AC4] gives the client a recorded response that withholds another office's orders, and keeps every other answer", () => {
    const recorded = withheldResponseOf(OFFICES);
    const mine = orderData({ ownerOfficeId: OWN });
    const theirs = orderData({ ownerOfficeId: OTHER });
    const listed = { data: [mine, theirs], dictionaries: { carriers: { ZZ: "ZED AIR" } } };

    expect(recorded(listed)).toEqual(withheldBody(listed, [theirs]));
    expect(recorded({ data: theirs })).toEqual({
      data: { type: "flight-order", id: theirs["id"], withheld: WITHHELD_ORDER },
    });
    // The tenant's orders, an error answer, no answer: as they are.
    expect(recorded({ data: [mine], dictionaries: { carriers: { ZZ: "ZED AIR" } } })).toEqual({
      data: [mine],
      dictionaries: { carriers: { ZZ: "ZED AIR" } },
    });
    const error = { errors: [{ status: 404, code: 1797, title: "NOT FOUND" }] };
    expect(recorded(error)).toBe(error);
    expect(recorded(undefined)).toBeUndefined();
    expect(recorded("not json")).toBe("not json");
    // An order without any office is not the tenant's either.
    expect(recorded({ data: { type: "flight-order", id: "x" } })).toEqual({
      data: { type: "flight-order", id: "x", withheld: WITHHELD_ORDER },
    });
  });
});

describe("the lookup's answer", () => {
  it("summarises an order: records, travellers, flights, tickets, last ticketing date and grand total", () => {
    const order = orderData(
      {
        associatedRecords: [
          {
            reference: "SYN001",
            originSystemCode: "GDS",
            flightOfferId: "2",
            creationDate: "2026-10-15T09:00:00.000",
          },
          { reference: "8HJK2Q", originSystemCode: "IB" },
        ],
      },
      { tickets: "full" },
    );

    const summary = pnrSummaryOf(order);

    expect(summary.recordLocators).toEqual([
      {
        reference: "SYN001",
        originSystemCode: "GDS",
        flightOfferId: "2",
        creationDate: "2026-10-15T09:00:00.000",
        primary: true,
      },
      {
        reference: "8HJK2Q",
        originSystemCode: "IB",
        flightOfferId: null,
        creationDate: null,
        primary: false,
      },
    ]);
    expect(summary.travelers).toEqual([{ travelerId: "1", firstName: "ALEX", lastName: "TESTER" }]);
    expect(summary.segments).toHaveLength(1);
    expect(summary.segments[0]).toMatchObject({ segmentId: "3", originCode: "MAD", destinationCode: "ORY" });
    expect(summary.ticketNumbers).toEqual(["000-0000000001"]);
    expect(summary.queuingOfficeId).toBe("NCE1A0955");
    expect(summary.grandTotal).toEqual({ amount: "98.47", currency: "EUR" });
  });

  it("links an order to its booking by order id, else by a record, never to another order's booking", () => {
    const order = orderData();
    const id = order["id"] as string;
    const reference = (order["associatedRecords"] as JsonObject[])[0]?.["reference"] as string;
    const byId: AttachedBooking = {
      id: "bkg_1",
      reference: "VXAAAAAA",
      status: "confirmed",
      amadeusOrderId: id,
      records: [],
    };
    const byRecord: AttachedBooking = {
      id: "bkg_2",
      reference: "VXBBBBBB",
      status: "failed",
      amadeusOrderId: null,
      records: [`${reference}|GDS`],
    };
    const otherOrder: AttachedBooking = { ...byRecord, id: "bkg_3", amadeusOrderId: "another-order" };

    expect(attachedBookingOf(order, [byRecord, byId])?.id).toBe("bkg_1");
    expect(attachedBookingOf(order, [byRecord])?.id).toBe("bkg_2");
    expect(attachedBookingOf(order, [otherOrder])).toBeUndefined();

    const match = pnrMatchOf(order, [byId]);
    expect(match).toMatchObject({
      flightOrderId: id,
      bookingId: "bkg_1",
      bookingReference: "VXAAAAAA",
      bookingStatus: "confirmed",
      importable: false,
    });
    expect(pnrMatchOf(order, [])).toMatchObject({ bookingId: null, importable: true });
  });

  it("answers the order verbatim with its forms of payment through the shared redactor", () => {
    const order = orderData({
      formOfPayments: [{ creditCard: { brand: "VISA", number: "4111111111111111", flightOfferIds: ["2"] } }],
    });

    const match = pnrMatchOf(order, []);

    expect(JSON.stringify(match.amadeus)).not.toContain("4111111111111111");
    expect((match.amadeus as JsonObject)["travelers"]).toEqual(order["travelers"]);
  });
});

describe("the import's request and order", () => {
  it("refuses an override without its selling total, and a selling total without an override", () => {
    expect(
      codeOf(thrown(() => refuseImportRequest({ reference: "ABC123", pricing: { mode: "override" } }))),
    ).toEqual([400, "VALIDATION_FAILED", undefined]);
    const error = thrown(() =>
      refuseImportRequest({
        reference: "ABC123",
        pricing: { mode: "net", sellingTotal: { amount: "100.00", currency: "EUR" } },
      }),
    );
    expect(isAppError(error) && error.fieldErrors?.[0]?.path).toBe("/pricing/sellingTotal");
    expect(() => refuseImportRequest({ reference: "ABC123" })).not.toThrow();
  });

  it("[OBE-064 AC1] takes the tenant's only order, and refuses another office's even when named", () => {
    const mine = { id: "mine", ownerOfficeId: OWN };
    const second = { id: "second", ownerOfficeId: OWN };
    const theirs = { id: "theirs", ownerOfficeId: OTHER };

    expect(chooseImportOrder([mine], [theirs], undefined)).toBe(mine);
    expect(chooseImportOrder([mine, second], [], "second")).toBe(second);
    expect(codeOf(thrown(() => chooseImportOrder([mine], [theirs], "theirs")))).toEqual([
      403,
      "OFFICE_NOT_ALLOWED",
      undefined,
    ]);
    expect(codeOf(thrown(() => chooseImportOrder([], [theirs], undefined)))).toEqual([
      403,
      "OFFICE_NOT_ALLOWED",
      undefined,
    ]);
    // Several matches need an id; the ids offered are the tenant's only.
    expect(codeOf(thrown(() => chooseImportOrder([mine, second], [theirs], undefined)))).toEqual([
      422,
      "UNPROCESSABLE",
      { reason: "several_orders", flightOrderIds: ["mine", "second"] },
    ]);
    expect(codeOf(thrown(() => chooseImportOrder([mine], [], "unknown")))).toEqual([
      422,
      "UNPROCESSABLE",
      { reason: "flight_order_not_found", flightOrderIds: ["mine"] },
    ]);
  });

  it("imports an order without tickets for the staff to issue, and one with tickets as ticketed", () => {
    const pending = createdOrder();
    expect(importStateOf(pending, orderSegmentsOf(pending))).toEqual({
      status: "confirmed",
      ticketingStatus: "manual_review",
      ticketed: false,
      cancelled: false,
    });
    const issued = createdOrder({}, { tickets: "full" });
    expect(importStateOf(issued, orderSegmentsOf(issued))).toMatchObject({
      status: "ticketed",
      ticketingStatus: "issued",
    });
    const partly = createdOrder({}, { tickets: "partial", travelerIds: ["1", "2"] });
    expect(importStateOf(partly, orderSegmentsOf(partly))).toMatchObject({
      status: "partially_ticketed",
      ticketingStatus: "partially_issued",
    });
  });

  it("imports an order whose every segment the airline cancelled as cancelled", () => {
    const order = createdOrder();
    const cancelled = orderSegmentsOf(order).map((segment) => ({ ...segment, status: "CANCELLED" as const }));
    expect(importStateOf(order, cancelled)).toEqual({
      status: "cancelled",
      ticketingStatus: "not_applicable",
      ticketed: false,
      cancelled: true,
    });
  });

  it("splits the order's net price: services sold at net, taxes as the record step counts them", () => {
    const order = createdOrder();
    const [offer] = order.offers;
    if (offer === undefined) {
      throw new Error("no offer");
    }
    const withServices = { ...offer, price: { ...offer.price, grandTotal: "133.47" } };

    expect(importNetOf([withServices], 2)).toEqual({
      currency: "EUR",
      net: "133.47",
      flights: "98.47",
      base: "56.00",
      fees: "0.00",
      taxes: "42.47",
      services: "35.00",
    });
    expect(
      codeOf(thrown(() => importNetOf([offer, { ...offer, price: { ...offer.price, currency: "USD" } }], 2))),
    ).toEqual([422, "UNPROCESSABLE", { reason: "order_currencies" }]);
    expect(codeOf(thrown(() => importNetOf([offer], 0)))).toEqual([
      422,
      "UNPROCESSABLE",
      { reason: "order_amounts" },
    ]);
  });
});

describe("the import's selling price (OADR-0005 point 10)", () => {
  const order = createdOrder();
  const net = importNetOf(order.offers, 2);

  it("sells at net", () => {
    expect(importPricingOf({ mode: "net" }, order.offers, net, NO_RULES)).toEqual({
      pricingMode: "net",
      markup: "0.00",
      fees: "0.00",
      total: "98.47",
      markupRuleId: null,
    });
  });

  it("sells at an override, the difference stored as markup", () => {
    expect(
      importPricingOf(
        { mode: "override", sellingTotal: { amount: "120.00", currency: "EUR" } },
        order.offers,
        net,
        NO_RULES,
      ),
    ).toEqual({
      pricingMode: "override",
      markup: "21.53",
      fees: "0.00",
      total: "120.00",
      markupRuleId: null,
    });
  });

  it("refuses an override below net, in another currency or with more decimals than the currency", () => {
    const override =
      (amount: string, currency = "EUR") =>
      () =>
        importPricingOf(
          { mode: "override", sellingTotal: { amount, currency } },
          order.offers,
          net,
          NO_RULES,
        );
    expect(codeOf(thrown(override("98.46")))).toEqual([
      422,
      "UNPROCESSABLE",
      { reason: "selling_below_net", net: { amount: "98.47", currency: "EUR" } },
    ]);
    expect(codeOf(thrown(override("120.00", "USD")))).toEqual([
      422,
      "UNPROCESSABLE",
      { reason: "currency_mismatch", currency: "EUR" },
    ]);
    const precision = thrown(override("120.001"));
    expect(isAppError(precision) && [precision.code, precision.fieldErrors?.[0]?.path]).toEqual([
      "VALIDATION_FAILED",
      "/pricing/sellingTotal/amount",
    ]);
  });

  it("prices with the tenant's markup rules and the booking's fees, channel console (the default mode)", () => {
    const rules: ImportRulesContext = {
      ...NO_RULES,
      markupRules: [markupRule("mkr_ten", "10.0000")],
      feeRules: [
        feeRule("fee_service", "booking_service", "5.00"),
        feeRule("fee_card", "payment_card", "3.00"),
      ],
    };

    // 10 % of 98.47 = 9.847 → 9.85; the booking service fee 5.00; the card fee belongs to another step.
    expect(importPricingOf(undefined, order.offers, net, rules)).toEqual({
      pricingMode: "markup_rules",
      markup: "9.85",
      fees: "5.00",
      total: "113.32",
      markupRuleId: "mkr_ten",
    });
  });

  it("puts the markup on the flights only: booked services are sold at net", () => {
    const [offer] = order.offers;
    if (offer === undefined) {
      throw new Error("no offer");
    }
    const withServices = [{ ...offer, price: { ...offer.price, grandTotal: "133.47" } }];
    const rules: ImportRulesContext = { ...NO_RULES, markupRules: [markupRule("mkr_ten", "10.0000")] };

    expect(
      importPricingOf({ mode: "markup_rules" }, withServices, importNetOf(withServices, 2), rules),
    ).toEqual({
      pricingMode: "markup_rules",
      markup: "9.85",
      fees: "0.00",
      total: "143.32",
      markupRuleId: "mkr_ten",
    });
  });
});

describe("the import's contact, customer and documents", () => {
  const contacts = [
    { isPrimary: false, email: "invoice@example.com" },
    { isPrimary: true, email: "primary@example.com" },
  ];
  const travelers = [{ id: "1", contact: { emailAddress: "traveller@example.com" } }];

  it("takes the contact e-mail from the request, the order's contacts, a traveller or the customer", () => {
    const of = (input: Partial<Parameters<typeof importContactEmailOf>[0]>) =>
      importContactEmailOf({
        requested: undefined,
        orderContacts: [],
        travelers: [],
        customerEmail: null,
        ...input,
      });
    expect(of({ requested: "staff@example.com", orderContacts: contacts })).toBe("staff@example.com");
    expect(of({ orderContacts: contacts, travelers })).toBe("primary@example.com");
    expect(of({ orderContacts: [{ isPrimary: true, email: null }, contacts[0] ?? contacts[1]!] })).toBe(
      "invoice@example.com",
    );
    expect(of({ travelers, customerEmail: "customer@example.com" })).toBe("traveller@example.com");
    expect(of({ customerEmail: "customer@example.com" })).toBe("customer@example.com");
    expect(of({})).toBeUndefined();
  });

  it("refuses a deleted or disabled customer as a console checkout does", () => {
    const row = { id: "cus_1", email: "a@example.com", status: "active", deletedAt: null };
    expect(importableCustomer(row)).toBe(true);
    expect(importableCustomer({ ...row, status: "pending_verification" })).toBe(true);
    expect(importableCustomer(undefined)).toBe(false);
    expect(importableCustomer({ ...row, status: "disabled" })).toBe(false);
    expect(importableCustomer({ ...row, status: "deleted", deletedAt: AT })).toBe(false);
    expect(codeOf(importCustomerUnavailable({ ...row, status: "disabled" }))).toEqual([
      409,
      "CONFLICT",
      { reason: "customer_disabled" },
    ]);
    expect(codeOf(importCustomerUnavailable({ ...row, status: "deleted", deletedAt: AT }))).toEqual([
      409,
      "CONFLICT",
      { reason: "customer_deleted" },
    ]);
    expect(codeOf(importCustomerUnavailable(undefined))).toEqual([
      409,
      "CONFLICT",
      { reason: "customer_deleted" },
    ]);
  });

  it("seals an Amadeus document with its full number, and leaves out one without a number", () => {
    expect(
      storedDocumentOf({
        documentType: "PASSPORT",
        number: "X1234567",
        expiryDate: "2031-01-01",
        issuanceCountry: "ES",
        holder: true,
        unknown: "ignored",
      }),
    ).toEqual({
      documentType: "PASSPORT",
      number: "X1234567",
      expiryDate: "2031-01-01",
      issuanceCountry: "ES",
      holder: true,
    });
    expect(storedDocumentOf({ documentType: "PASSPORT" })).toBeUndefined();
    expect(storedDocumentOf({ documentType: "LIBRARY_CARD", number: "1" })).toBeUndefined();
  });
});
