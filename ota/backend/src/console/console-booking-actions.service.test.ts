// The console booking actions (OBE-062): the rules of console.bookings.patch (card data, elements, read-only fields,
// the merges of travellers, contacts and remarks), the projection of an order's remarks and contacts on a booking, the
// differences a resync answers and the retrieve's answer, then ConsoleBookingActionsService over fakes: a refused patch
// reaches neither the database nor Amadeus, a stale If-Match makes no Amadeus call, and a timed-out PATCH is followed
// by a resync before its 504. Against PostgreSQL and the Amadeus stub: test/integration/console/
// bookings-actions.int.test.ts. Every number here is made up on the spot.
import { AppError } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { AmadeusClient } from "../amadeus/amadeus.client";
import type {
  BookingChildren,
  BookingRemarkRow,
  BookingRow,
  BookingsRepository,
} from "../bookings/bookings.repository";
import type { CustomerBookingsService } from "../bookings/customer-bookings.service";
import type { BookingTravelerDocuments } from "../bookings/order-recorder";
import type { StaffContext } from "../common/auth/staff.guard";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type { TenantSchema } from "@velexis/db";
import type { TenantTx } from "../tenancy/tenant-tx";
import {
  canonicalJson,
  carriesCardData,
  ConsoleBookingActionsService,
  consoleOrderReplyOf,
  consoleSyncChanges,
  contactValuesOf,
  flightOfferRefsOf,
  keptOrderDataOf,
  mergeContacts,
  mergeRemarks,
  mergeTraveler,
  orderRemarksOf,
  patchElementsOf,
  planRemarks,
  refusePatchRequest,
  type ConsolePatchRequest,
} from "./console-booking-actions.service";
import type { ConsoleBooking } from "./console-bookings.mapper";
import type { ConsoleBookingsRepository } from "./console-bookings.repository";
import type { ConsoleBookingsService } from "./console-bookings.service";
import type { StaffActionsWriter } from "./staff-actions.writer";

type JsonObject = Record<string, unknown>;

/** The AppError a call throws (or fails the test). */
function errorOf(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an AppError");
}

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an AppError");
}

// Stripe's documented Visa test number.
const TEST_CARD = "4242424242424242";

describe("refusePatchRequest", () => {
  it("[OBE-062 AC1] refuses a creditCard form of payment, and a B2B wallet's virtual card, as consoleCardPayment", () => {
    const card = errorOf(() =>
      refusePatchRequest({
        formOfPayments: [{ other: { method: "CASH" } }, { creditCard: { brand: "VISA", number: TEST_CARD } }],
      } as ConsolePatchRequest),
    );
    const virtualCard = errorOf(() =>
      refusePatchRequest({
        formOfPayments: [{ b2bWallet: { virtualCreditCardDetails: { number: TEST_CARD } } }],
      } as unknown as ConsolePatchRequest),
    );

    for (const error of [card, virtualCard]) {
      expect([error.code, error.details]).toEqual(["FEATURE_DISABLED", { feature: "consoleCardPayment" }]);
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(TEST_CARD);
    }
    expect(carriesCardData([{ other: { method: "ACCOUNT" } }, { b2bWallet: { cardId: "1" } }])).toBe(false);
  });

  it("refuses the elements the MVP does not patch, the ticketing agreement's outputs and a body without an element", () => {
    const services = errorOf(() =>
      refusePatchRequest({ flightOffers: [{}], tickets: [{}] } as unknown as ConsolePatchRequest),
    );
    const readOnly = errorOf(() =>
      refusePatchRequest({ ticketingAgreement: { option: "CONFIRM", segmentIds: ["1"] } }),
    );
    const empty = errorOf(() => refusePatchRequest({ reason: "Nothing", notifyCustomer: true }));

    expect([services.code, services.details]).toEqual([
      "FEATURE_DISABLED",
      { feature: "consolePatchElements", elements: ["flightOffers", "tickets"] },
    ]);
    expect([readOnly.code, readOnly.fieldErrors]).toEqual([
      "VALIDATION_FAILED",
      [expect.objectContaining({ path: "/ticketingAgreement/segmentIds", code: "read_only" })],
    ]);
    expect(empty.code).toBe("VALIDATION_FAILED");
    expect(() => refusePatchRequest({ tags: [] })).not.toThrow();
    expect(patchElementsOf({ contacts: [{}], tags: ["vip"], ownerOfficeId: "NCE1A0950" })).toEqual({
      amadeus: ["contacts", "ownerOfficeId"],
      local: ["tags"],
      unsupported: [],
    });
  });
});

describe("the merges of a patch", () => {
  const standard = { purpose: "STANDARD", emailAddress: "old@example.com" };
  const invoice = { purpose: "INVOICE", emailAddress: "billing@example.com" };

  it("replaces the stored contact of each purpose sent and keeps the others, or sends the list as given", () => {
    const sent = [{ emailAddress: "new@example.com" }];

    expect(mergeContacts([standard, invoice], sent, true)).toEqual([
      { emailAddress: "new@example.com" },
      invoice,
    ]);
    expect(mergeContacts([invoice], sent, true)).toEqual([invoice, { emailAddress: "new@example.com" }]);
    expect(mergeContacts([standard, invoice], sent, false)).toEqual(sent);
  });

  it("adds the remarks sent to the stored ones without duplicates, keeps both lists and always the Velexis remark", () => {
    const stored = {
      general: [
        { subType: "GENERAL_MISCELLANEOUS", text: "VEGETARIAN MEAL PLEASE" },
        { subType: "BACKOFFICE", text: "VELEXIS VXK7M2Q9" },
      ],
      airline: [{ subType: "OTHER_SERVICE_INFORMATION", airlineCode: "IB", text: "UMNR" }],
    };

    const merged = mergeRemarks(
      stored,
      {
        general: [
          { subType: "GENERAL_MISCELLANEOUS", text: "vegetarian meal please" },
          { subType: "CONFIDENTIAL", text: "CALL FIRST" },
        ],
      },
      true,
      "VXK7M2Q9",
    );
    const replaced = mergeRemarks(
      stored,
      { general: [{ subType: "CONFIDENTIAL", text: "ONLY" }] },
      false,
      "VXK7M2Q9",
    );
    const fromNothing = mergeRemarks(undefined, { general: [] }, false, "VXK7M2Q9");

    expect(merged).toEqual({
      general: [...stored.general, { subType: "CONFIDENTIAL", text: "CALL FIRST" }],
      airline: stored.airline,
    });
    // The list sent replaces its kind; the airline remarks stay; the Velexis remark is kept.
    expect(replaced).toEqual({
      general: [
        { subType: "CONFIDENTIAL", text: "ONLY" },
        { subType: "BACKOFFICE", text: "VELEXIS VXK7M2Q9" },
      ],
      airline: stored.airline,
    });
    expect(fromNothing).toEqual({ general: [{ subType: "BACKOFFICE", text: "VELEXIS VXK7M2Q9" }] });
  });

  it("merges a traveller field by field: a document sent without a number keeps the stored one's", () => {
    const stored = {
      id: "1",
      name: { firstName: "TESTA", lastName: "SAMPLE" },
      dateOfBirth: "1988-04-12",
      documents: [
        { documentType: "PASSPORT", number: "PX1234567", expiryDate: "2030-01-01", issuanceCountry: "SE" },
        { documentType: "VISA", number: "V998877" },
      ],
    };

    const merged = mergeTraveler(
      stored,
      {
        id: "1",
        name: { lastName: "SAMPLE-JONES" },
        documents: [{ documentType: "PASSPORT", expiryDate: "2034-06-30" }],
      },
      true,
    );
    const asSent = mergeTraveler(stored, { id: "1", documents: [{ documentType: "IDENTITY_CARD" }] }, false);

    expect(merged.missing).toEqual([]);
    expect(merged.traveler).toEqual({
      id: "1",
      name: { firstName: "TESTA", lastName: "SAMPLE-JONES" },
      dateOfBirth: "1988-04-12",
      documents: [
        { documentType: "PASSPORT", number: "PX1234567", expiryDate: "2034-06-30", issuanceCountry: "SE" },
        { documentType: "VISA", number: "V998877" },
      ],
    });
    expect(asSent.missing).toEqual([{ index: 0 }]);
    expect(asSent.traveler).toEqual({ id: "1", documents: [] });
  });

  it("names the order's flight offers by id only", () => {
    const children = {
      segments: [{ amadeusFlightOfferId: "2" }, { amadeusFlightOfferId: "2" }],
    } as unknown as Pick<BookingChildren, "segments">;

    expect(flightOfferRefsOf({ flightOffers: [{ id: "1", price: {} }, { id: "3" }] }, children)).toEqual([
      { type: "flight-offer", id: "1" },
      { type: "flight-offer", id: "3" },
    ]);
    expect(flightOfferRefsOf({}, children)).toEqual([{ type: "flight-offer", id: "2" }]);
  });
});

describe("the projection of an order", () => {
  const row = (
    id: string,
    kind: string,
    subType: string,
    text: string,
    extra: Partial<BookingRemarkRow> = {},
  ) =>
    ({
      id,
      kind,
      subType,
      text,
      travelerIds: [],
      visibleToCustomer: false,
      createdByStaffId: null,
      createdAt: new Date(0),
      ...extra,
    }) as BookingRemarkRow;

  it("keeps the remarks the order has, adds the new ones, removes the others but never the Velexis remark", () => {
    const rows = [
      row("rmk_1", "general", "GENERAL_MISCELLANEOUS", "VEGETARIAN MEAL PLEASE", { visibleToCustomer: true }),
      row("rmk_2", "general", "BACKOFFICE", "VELEXIS VXK7M2Q9"),
      row("rmk_3", "general", "CONFIDENTIAL", "OLD NOTE"),
    ];
    const order = orderRemarksOf({
      general: [
        { subType: "GENERAL_MISCELLANEOUS", text: "Vegetarian meal please" },
        { subType: "QUALITY_CONTROL", text: "CHECKED" },
        { subType: "NOT_A_TYPE", text: "SKIPPED" },
      ],
      airline: [{ subType: "OTHER_SERVICE_INFORMATION", text: "UMNR", travelerIds: ["2"] }],
    });

    const plan = planRemarks(rows, order);

    expect(order.map((entry) => [entry.kind, entry.subType, entry.airlineCode])).toEqual([
      ["general", "GENERAL_MISCELLANEOUS", null],
      ["general", "QUALITY_CONTROL", null],
      ["airline", "OTHER_SERVICE_INFORMATION", "YY"],
    ]);
    expect(plan.insert.map((entry) => entry.text)).toEqual(["CHECKED", "UMNR"]);
    expect(plan.remove.map((entry) => entry.id)).toEqual(["rmk_3"]);
  });

  it("makes the first contact of the old primary's purpose with an e-mail the primary one", () => {
    const contacts = contactValuesOf(
      [
        { purpose: "INVOICE", emailAddress: "billing@example.com" },
        { purpose: "BOGUS", addresseeName: { firstName: "TESTA" }, phones: [{ number: "701234567" }] },
        { emailAddress: "new@example.com" },
      ],
      "STANDARD",
    );

    expect(contacts.map((contact) => [contact.purpose, contact.isPrimary, contact.email])).toEqual([
      ["INVOICE", false, "billing@example.com"],
      ["STANDARD", false, null],
      ["STANDARD", true, "new@example.com"],
    ]);
    expect(contacts[1]?.firstName).toBe("TESTA");
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});

describe("consoleOrderReplyOf", () => {
  it("passes the answer through, card numbers cut to their last 4 and the dictionaries a booking answer can carry", () => {
    const reply = consoleOrderReplyOf({
      data: {
        id: "eJzT",
        travelers: [{ documents: [{ number: "PX1234567" }] }],
        formOfPayments: [{ creditCard: { number: TEST_CARD, securityCode: "123" } }],
      },
      dictionaries: { locations: { MAD: { cityCode: "MAD" } }, carriers: { IB: "IBERIA" } },
      included: { bags: {} },
    });

    expect(reply).toEqual({
      data: {
        id: "eJzT",
        travelers: [{ documents: [{ number: "PX1234567" }] }],
        formOfPayments: [{ creditCard: { number: TEST_CARD.slice(-4) } }],
      },
      dictionaries: { carriers: { IB: "IBERIA" } },
      included: { bags: {} },
    });
  });
});

describe("keptOrderDataOf", () => {
  it("cuts document and form of identification numbers to their last 4 and drops card data, leaving the input alone", () => {
    const data = {
      id: "eJzT",
      travelers: [{ id: "1", documents: [{ documentType: "PASSPORT", number: "PX1234567" }] }],
      formOfIdentifications: [{ identificationType: "PASSPORT", number: "XN0019390", travelerIds: ["1"] }],
      formOfPayments: [{ creditCard: { number: TEST_CARD, securityCode: "123" } }],
    };

    const kept = keptOrderDataOf(data);

    expect(kept).toEqual({
      id: "eJzT",
      travelers: [{ id: "1", documents: [{ documentType: "PASSPORT", number: "4567" }] }],
      formOfIdentifications: [{ identificationType: "PASSPORT", number: "9390", travelerIds: ["1"] }],
      formOfPayments: [{ creditCard: { number: TEST_CARD.slice(-4) } }],
    });
    expect(data.formOfIdentifications[0]?.number).toBe("XN0019390");
    expect(keptOrderDataOf({ id: "eJzT" })).toEqual({ id: "eJzT" });
  });
});

describe("consoleSyncChanges", () => {
  const view = (overrides: JsonObject): ConsoleBooking =>
    ({
      status: "confirmed",
      ticketing: { status: "pending" },
      tickets: [],
      itineraries: [
        {
          segments: [
            {
              id: "3",
              flightOfferId: "2",
              flightNumber: "IB3436",
              status: "CONFIRMED",
              isFlown: false,
              departure: { at: "2027-01-15T07:15:00" },
              arrival: { at: "2027-01-15T09:15:00" },
            },
          ],
        },
      ],
      recordLocators: [{ reference: "QX8P4L", originSystemCode: "GDS" }],
      contacts: [{ id: "bco_1", purpose: "STANDARD", isPrimary: true, emailAddress: "old@example.com" }],
      remarks: [],
      ticketingAgreement: null,
      automatedProcess: [],
      formOfPayments: [],
      queuingOfficeId: "NCE1A0950",
      ownerOfficeId: "NCE1A0950",
      ...overrides,
    }) as unknown as ConsoleBooking;

  it("lists what changed as JSON pointers into the booking, and nothing for an unchanged booking", () => {
    const before = view({});
    const after = view({
      status: "ticketed",
      ticketing: { status: "issued" },
      tickets: [
        { documentType: "ETICKET", documentNumber: "000-0000000001", status: "ISSUED", travelerId: "1" },
      ],
      itineraries: [
        {
          segments: [
            {
              id: "3",
              flightOfferId: "2",
              flightNumber: "IB3436",
              status: "CONFIRMED",
              isFlown: false,
              departure: { at: "2027-01-15T08:05:00" },
              arrival: { at: "2027-01-15T09:15:00" },
            },
          ],
        },
      ],
      contacts: [{ id: "bco_2", purpose: "STANDARD", isPrimary: true, emailAddress: "old@example.com" }],
    });

    expect(consoleSyncChanges(before, before)).toEqual([]);
    expect(consoleSyncChanges(before, after)).toEqual([
      { path: "/status", label: "Booking status", before: "confirmed", after: "ticketed" },
      { path: "/ticketing/status", label: "Ticketing status", before: "pending", after: "issued" },
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
      {
        path: "/itineraries/0/segments/0/departure/at",
        label: "IB3436 departure time",
        before: "2027-01-15T07:15:00",
        after: "2027-01-15T08:05:00",
      },
    ]);
  });
});

// ---- The service over fakes -----------------------------------------------------------------------------------------

const TENANT: RequestTenant = {
  tenantId: "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1A",
  key: "alpha",
  schemaName: "tenant_alpha" as TenantSchema,
  environment: "test",
  caller: { type: "service", id: "service" },
  actor: { type: "staff", id: "stf_01JA2Z9W5K7Q3M8N4P6R2T0V1D" },
  requestId: "req-console-actions-1",
} as unknown as RequestTenant;

const BOOKING = {
  id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
  environment: "test",
  reference: "VXK7M2Q9",
  status: "confirmed",
  amadeusOrderId: "eJzTd9f",
  ownerOfficeId: "NCE1A0950",
  queuingOfficeId: "NCE1A0950",
  lastTicketingDate: null,
  metadata: {},
  version: 3,
} as unknown as BookingRow;

/** The service over fakes: one booking, an Amadeus client that answers `patch` as told, and recorded calls. */
function setup(patch: () => Promise<unknown> = () => Promise.resolve({ body: {}, call: {} })) {
  const transactions: string[] = [];
  const amadeus = { patchFlightOrder: vi.fn(patch), getFlightOrder: vi.fn() };
  const refresh = vi.fn(() => Promise.resolve({ kind: "not_found" as const }));
  const service = new ConsoleBookingActionsService(
    {
      run: (work: (trx: unknown) => Promise<unknown>) => {
        transactions.push("run");
        return work({});
      },
    } as unknown as TenantTx,
    {
      booking: () => Promise.resolve(BOOKING),
      bookingDetails: () => Promise.resolve({ orderSnapshot: { flightOffers: [{ id: "2" }] } }),
      children: () =>
        Promise.resolve({
          travelers: [],
          contacts: [],
          segments: [],
          tickets: [],
          remarks: [],
          associatedRecords: [],
        }),
    } as unknown as BookingsRepository,
    {
      details: () => Promise.resolve({ tags: [], ticketingAgreement: null }),
    } as unknown as ConsoleBookingsRepository,
    {} as BookingTravelerDocuments,
    { refresh } as unknown as CustomerBookingsService,
    {} as ConsoleBookingsService,
    amadeus as unknown as AmadeusClient,
    { record: vi.fn() } as unknown as StaffActionsWriter,
    { require: () => TENANT, requestId: () => TENANT.requestId } as unknown as TenantContext,
    { get: () => undefined } as unknown as StaffContext,
    new IdGenerator(new Clock()),
    new Clock(),
    { info: vi.fn(), warn: vi.fn() } as unknown as PinoLogger,
  );
  return { service, amadeus, refresh, transactions };
}

describe("ConsoleBookingActionsService.retrieve", () => {
  it("answers a client error the operation does not document as 502 SUPPLIER_ERROR, and those it documents as mapped", async () => {
    const { service, amadeus } = setup();
    amadeus.getFlightOrder
      .mockRejectedValueOnce(new AppError("OFFICE_NOT_ALLOWED"))
      .mockRejectedValueOnce(new AppError("SUPPLIER_TIMEOUT"));

    const office = await rejectionOf(service.retrieve(BOOKING.id, {}));
    const timeout = await rejectionOf(service.retrieve(BOOKING.id, {}));

    expect([office.code, office.cause]).toEqual(["SUPPLIER_ERROR", expect.any(AppError)]);
    expect(timeout.code).toBe("SUPPLIER_TIMEOUT");
  });
});

describe("ConsoleBookingActionsService.patch", () => {
  it("[OBE-062 AC1] refuses a creditCard before it opens a transaction or calls Amadeus", async () => {
    const { service, amadeus, transactions } = setup();

    const error = await rejectionOf(
      service.patch(BOOKING.id, '"3"', {
        formOfPayments: [{ creditCard: { brand: "VISA", number: TEST_CARD } }],
      } as ConsolePatchRequest),
    );

    expect(error.code).toBe("FEATURE_DISABLED");
    expect(transactions).toEqual([]);
    expect(amadeus.patchFlightOrder).not.toHaveBeenCalled();
  });

  it("[OBE-062 AC1] answers 412 for a stale If-Match without calling Amadeus", async () => {
    const { service, amadeus } = setup();

    const error = await rejectionOf(
      service.patch(BOOKING.id, '"2"', { contacts: [{ emailAddress: "new@example.com" }] }),
    );

    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(amadeus.patchFlightOrder).not.toHaveBeenCalled();
  });

  it("resyncs after a timed-out PATCH, without the throttle, then answers the 504", async () => {
    const { service, amadeus, refresh } = setup(() => Promise.reject(new AppError("SUPPLIER_TIMEOUT")));

    const error = await rejectionOf(
      service.patch(BOOKING.id, 'W/"3"', { contacts: [{ emailAddress: "new@example.com" }] }),
    );

    expect(error.code).toBe("SUPPLIER_TIMEOUT");
    expect(amadeus.patchFlightOrder).toHaveBeenCalledOnce();
    const sent = amadeus.patchFlightOrder.mock.calls[0] as unknown as [
      unknown,
      { body: { data: JsonObject } },
    ];
    expect(sent[1].body.data).toEqual({
      type: "flight-order",
      id: "eJzTd9f",
      flightOffers: [{ type: "flight-offer", id: "2" }],
      contacts: [{ emailAddress: "new@example.com" }],
    });
    expect(refresh).toHaveBeenCalledWith(TENANT, BOOKING.id, "console.bookings.patch", {}, { throttleMs: 0 });
  });
});
