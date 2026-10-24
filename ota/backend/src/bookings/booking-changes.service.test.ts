// bookings.update (OBE-048; ota/docs/flows/change-and-cancel.md §1, §3 steps 1–2, §4): the pure rules of
// booking-changes.service.ts (the refusal of traveller changes, the contact requirements, the PATCH's contacts and
// remarks, the projection of an order's contacts, the error mapping, the snapshot after a PATCH) and the service over
// fakes (what is checked before Amadeus is called, what a refusal or a timeout leaves, what a PATCH that answered
// records). The use case against PostgreSQL, Redis, the Amadeus stub and Mailpit is in
// test/integration/bookings/update.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import type { TenantSchema } from "@velexis/db";
import { AppError } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { AmadeusClient } from "../amadeus/amadeus.client";
import { mapAmadeusError } from "../amadeus/error-mapper";
import type { BookingAccessContext } from "../common/auth/booking-access.guard";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import type { OutboxService } from "../notifications/outbox.service";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type { TenantTx } from "../tenancy/tenant-tx";
import {
  amadeusContactsOf,
  BookingChangesService,
  contactRequirementOf,
  contactsMatch,
  contactValuesOf,
  CONTACTS_UPDATED_EVENT,
  flightOfferRefsOf,
  newRemarksOf,
  orderHasRemark,
  patchOutcomeUnknown,
  patchRemarksOf,
  refuseTravelerChanges,
  remarkInputErrors,
  snapshotAfter,
  storedRemarksOf,
  TRAVELER_CHANGES_FEATURE,
  updateErrorOf,
  type BookingChangesRepository,
  type BookingUpdateRequest,
} from "./booking-changes.service";
import { BOOKING_UPDATED_TEMPLATE, BookingUpdatedEmails } from "./booking-updated-emails";
import type {
  BookingChildren,
  BookingRemarkRow,
  BookingRow,
  BookingSegmentRow,
  BookingsRepository,
} from "./bookings.repository";
import type { CustomerBookingsService } from "./customer-bookings.service";
import type { OrderRecorder } from "./order-recorder";

type JsonObject = Record<string, unknown>;
type ContactInput = components["schemas"]["ContactInput"];

const DAY_MS = 24 * 60 * 60_000;

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("the promise resolved");
}

const remarkRow = (values: Partial<BookingRemarkRow>): BookingRemarkRow => ({
  id: "rmk_01JA4CG3S8W1Z4C7F0H3L6P9T2",
  kind: "general",
  subType: "GENERAL_MISCELLANEOUS",
  text: "VEGETARIAN MEAL PLEASE",
  travelerIds: ["1"],
  visibleToCustomer: true,
  createdByStaffId: null,
  createdAt: new Date(),
  ...values,
});

const newContact = (email: string, extra: Partial<ContactInput> = {}): ContactInput => ({
  purpose: "STANDARD",
  addresseeName: { firstName: "TESTA", lastName: "SAMPLE" },
  emailAddress: email,
  phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "709876543" }],
  ...extra,
});

describe("the request rules", () => {
  it("[OBE-048 AC1] refuses traveller changes with 403 FEATURE_DISABLED travelerChanges, and lets contacts and remarks through", () => {
    let refused: unknown;
    try {
      refuseTravelerChanges({
        contacts: [newContact("new@example.com")],
        travelers: [{ travelerId: "1", loyaltyPrograms: [{ programOwner: "AF", id: "2099887766" }] }],
      } as BookingUpdateRequest);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AppError);
    expect([(refused as AppError).code, (refused as AppError).details]).toEqual([
      "FEATURE_DISABLED",
      { feature: TRAVELER_CHANGES_FEATURE },
    ]);
    expect(() =>
      refuseTravelerChanges({ contacts: [newContact("new@example.com")], remarks: [{ text: "Wheelchair" }] }),
    ).not.toThrow();
  });

  it("reads the contact flags of the booked offer's bookingRequirements, and asks for an e-mail only without them", () => {
    expect(contactRequirementOf(undefined)).toEqual({
      emailRequired: true,
      mobilePhoneRequired: false,
      phoneRequired: false,
      phoneCountryCodeRequired: false,
      invoiceAddressRequired: false,
      mailingAddressRequired: false,
      postalCodeRequired: false,
      maxContacts: 3,
    });
    expect(
      contactRequirementOf({
        mobilePhoneNumberRequired: true,
        postalCodeRequired: true,
        travelerRequirements: [],
      }),
    ).toMatchObject({ mobilePhoneRequired: true, postalCodeRequired: true, phoneRequired: false });
  });

  it("refuses remarks naming a traveller the booking does not have, with JSON pointers into the request", () => {
    expect(
      remarkInputErrors(
        [
          { text: "Wheelchair", travelerIds: ["1"] },
          { text: "Vegan meal", travelerIds: ["1", "3"] },
        ],
        new Set(["1", "2"]),
      ),
    ).toEqual([
      {
        path: "/remarks/1/travelerIds/1",
        code: "enum",
        message: "This traveller is not part of the booking.",
      },
    ]);
  });

  it("refuses a remark of blanks only, which the document's pattern allows and Amadeus would get empty", () => {
    expect(
      remarkInputErrors(
        [
          { text: "Wheelchair", travelerIds: ["1"] },
          { text: "   ", travelerIds: ["1"] },
        ],
        new Set(["1"]),
      ),
    ).toEqual([{ path: "/remarks/1/text", code: "minLength", message: "Enter the text of the request." }]);
  });

  it("sends each contact with the fields Amadeus knows, STANDARD by default and without the OTA's isPrimary", () => {
    expect(
      amadeusContactsOf([
        { isPrimary: true, emailAddress: "new@example.com", language: "sv" },
        { purpose: "INVOICE", companyName: "ACME AB", address: { countryCode: "SE", cityName: "Stockholm" } },
      ]),
    ).toEqual([
      { purpose: "STANDARD", emailAddress: "new@example.com", language: "sv" },
      { purpose: "INVOICE", companyName: "ACME AB", address: { countryCode: "SE", cityName: "Stockholm" } },
    ]);
  });
});

describe("the remarks of the PATCH", () => {
  const stored = {
    general: [
      { subType: "GENERAL_MISCELLANEOUS", text: "VEGETARIAN MEAL PLEASE", travelerIds: ["1"] },
      { subType: "BACKOFFICE", text: "VELEXIS VXK7M2Q9" },
    ],
    airline: [{ subType: "OTHER_SERVICE_INFORMATION", text: "VIP", airlineCode: "IB" }],
  };

  it("adds the new special requests upper-cased, once, and never one the order already has", () => {
    expect(
      newRemarksOf(stored, [
        { text: "Vegetarian meal please", travelerIds: ["1"] },
        { text: "vegetarian meal please", travelerIds: ["2"] },
        { text: " Wheelchair at arrival ", travelerIds: ["2", "2"] },
        { text: "Wheelchair at arrival", travelerIds: ["2"] },
      ]),
    ).toEqual([
      { text: "VEGETARIAN MEAL PLEASE", travelerIds: ["2"] },
      { text: "WHEELCHAIR AT ARRIVAL", travelerIds: ["2"] },
    ]);
  });

  it("resends the stored general and airline remarks with the new ones, and the Velexis remark when it was lost", () => {
    const added = [{ text: "WHEELCHAIR AT ARRIVAL", travelerIds: [] }];
    expect(patchRemarksOf(stored, added, "VXK7M2Q9")).toEqual({
      general: [...stored.general, { subType: "GENERAL_MISCELLANEOUS", text: "WHEELCHAIR AT ARRIVAL" }],
      airline: stored.airline,
    });
    expect(patchRemarksOf({ general: [stored.general[0]] }, added, "VXK7M2Q9")).toEqual({
      general: [
        stored.general[0],
        { subType: "GENERAL_MISCELLANEOUS", text: "WHEELCHAIR AT ARRIVAL" },
        { subType: "BACKOFFICE", text: "VELEXIS VXK7M2Q9" },
      ],
    });
  });

  it("reads the stored remarks from the snapshot, else from the booking's general remark rows", () => {
    expect(storedRemarksOf({ remarks: stored }, [])).toBe(stored);
    expect(
      storedRemarksOf({}, [
        remarkRow({}),
        remarkRow({ subType: "BACKOFFICE", text: "VELEXIS VXK7M2Q9", travelerIds: [] }),
        remarkRow({ kind: "airline", subType: "OTHER_SERVICE_INFORMATION", text: "VIP" }),
      ]),
    ).toEqual({ general: stored.general });
  });

  it("finds a special request in an order's remarks by text and travellers", () => {
    expect(orderHasRemark(stored, { text: "VEGETARIAN MEAL PLEASE", travelerIds: ["1"] })).toBe(true);
    expect(orderHasRemark(stored, { text: "VEGETARIAN MEAL PLEASE", travelerIds: ["2"] })).toBe(false);
    expect(orderHasRemark(undefined, { text: "VEGETARIAN MEAL PLEASE", travelerIds: ["1"] })).toBe(false);
  });

  it("names the order's flight offers by id: the snapshot's, else the segments'", () => {
    expect(flightOfferRefsOf({ flightOffers: [{ id: "2" }, { id: "3" }] }, [])).toEqual([
      { type: "flight-offer", id: "2" },
      { type: "flight-offer", id: "3" },
    ]);
    expect(
      flightOfferRefsOf({}, [
        { amadeusFlightOfferId: "4" },
        { amadeusFlightOfferId: "4" },
      ] as BookingSegmentRow[]),
    ).toEqual([{ type: "flight-offer", id: "4" }]);
    expect(flightOfferRefsOf(undefined, [])).toEqual([{ type: "flight-offer", id: "1" }]);
  });
});

describe("the contacts of an order", () => {
  const order: JsonObject[] = [
    { purpose: "INVOICE", companyName: "ACME AB", emailAddress: "billing@example.com" },
    { purpose: "STANDARD", emailAddress: "other@example.com" },
    {
      purpose: "STANDARD",
      addresseeName: { firstName: "TESTA", lastName: "SAMPLE" },
      emailAddress: "New@Example.com",
      phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "709876543" }],
      language: "sv",
    },
  ];

  it("makes the STANDARD contact with the requested primary e-mail the primary one, else the first STANDARD one", () => {
    expect(contactValuesOf(order, "new@example.com").map((contact) => contact.isPrimary)).toEqual([
      false,
      false,
      true,
    ]);
    expect(contactValuesOf(order, null).map((contact) => contact.isPrimary)).toEqual([false, true, false]);
    expect(contactValuesOf(order, "new@example.com")[2]).toEqual({
      purpose: "STANDARD",
      isPrimary: true,
      firstName: "TESTA",
      lastName: "SAMPLE",
      companyName: null,
      email: "New@Example.com",
      phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "709876543" }],
      address: null,
      language: "sv",
    });
  });

  it("recognises the contacts sent in an order read back, in any order and any case, and nothing else", () => {
    const sent = amadeusContactsOf([
      newContact("new@example.com"),
      { purpose: "INVOICE", emailAddress: "b@x.io" },
    ]);
    expect(contactsMatch([...sent].reverse(), sent)).toBe(true);
    expect(
      contactsMatch(
        [
          {
            ...sent[0],
            emailAddress: "NEW@example.com",
            addresseeName: { firstName: "testa", lastName: "sample" },
          },
          sent[1] as JsonObject,
        ],
        sent,
      ),
    ).toBe(true);
    expect(contactsMatch([sent[0] as JsonObject], sent)).toBe(false);
    expect(
      contactsMatch([{ ...sent[0], emailAddress: "old@example.com" }, sent[1] as JsonObject], sent),
    ).toBe(false);
  });
});

describe("the answer of a failed PATCH", () => {
  const amadeus = (status: number, issues: JsonObject[]) =>
    mapAmadeusError("patchFlightOrder", { kind: "http", status, issues });

  it("[OBE-048 AC2] passes Amadeus 2552 on as 409 VERSION_CONFLICT, and the timeout as 504", () => {
    const conflict = updateErrorOf(amadeus(409, [{ status: 409, code: 2552, title: "SIMULTANEOUS UPDATE" }]));
    expect((conflict as AppError).code).toBe("VERSION_CONFLICT");
    expect((updateErrorOf(new AppError("SUPPLIER_TIMEOUT")) as AppError).code).toBe("SUPPLIER_TIMEOUT");
  });

  it("answers a refusal pointing at the contacts as 422 CONTACT_DATA_INVALID, and other undocumented codes as 502", () => {
    const refused = updateErrorOf(
      amadeus(400, [
        {
          status: 400,
          code: 4926,
          title: "INVALID DATA RECEIVED",
          source: { pointer: "/data/contacts[0]/phones[0]/number" },
        },
      ]),
    ) as AppError;
    expect([refused.code, refused.fieldErrors]).toEqual([
      "CONTACT_DATA_INVALID",
      [{ path: "/contacts/0/phones/0/number", code: "invalid", message: "INVALID DATA RECEIVED" }],
    ]);
    const other = updateErrorOf(amadeus(400, [{ status: 400, code: 4926, title: "INVALID DATA RECEIVED" }]));
    expect((other as AppError).code).toBe("SUPPLIER_ERROR");
    expect((updateErrorOf(new AppError("OFFICE_NOT_ALLOWED")) as AppError).code).toBe("SUPPLIER_ERROR");
    const bug = new Error("not an AppError");
    expect(updateErrorOf(bug)).toBe(bug);
  });

  it("counts a timeout, an Amadeus 5xx and a cut connection as unknown outcomes, never a refusal or an unsent request", () => {
    expect(patchOutcomeUnknown(new AppError("SUPPLIER_TIMEOUT"))).toBe(true);
    expect(patchOutcomeUnknown(mapAmadeusError("patchFlightOrder", { kind: "timeout" }))).toBe(true);
    expect(patchOutcomeUnknown(amadeus(500, [{ status: 500, code: 141, title: "SYSTEM ERROR" }]))).toBe(true);
    expect(patchOutcomeUnknown(amadeus(503, []))).toBe(true);
    expect(
      patchOutcomeUnknown(mapAmadeusError("patchFlightOrder", { kind: "network", code: "ECONNRESET" })),
    ).toBe(true);

    expect(
      patchOutcomeUnknown(amadeus(409, [{ status: 409, code: 2552, title: "SIMULTANEOUS UPDATE" }])),
    ).toBe(false);
    expect(
      patchOutcomeUnknown(amadeus(400, [{ status: 400, code: 4926, title: "INVALID DATA RECEIVED" }])),
    ).toBe(false);
    expect(patchOutcomeUnknown(amadeus(429, []))).toBe(false);
    expect(
      patchOutcomeUnknown(mapAmadeusError("patchFlightOrder", { kind: "network", code: "ECONNREFUSED" })),
    ).toBe(false);
    expect(patchOutcomeUnknown(new AppError("SUPPLIER_UNAVAILABLE"))).toBe(false);
    expect(patchOutcomeUnknown(new Error("a bug before the call"))).toBe(false);
  });
});

describe("the snapshot after a PATCH", () => {
  it("is the answer, or the stored snapshot with the answer's contacts and remarks when the booking moved meanwhile", () => {
    const stored = {
      id: "ORDER-1",
      tickets: [{ documentNumber: "0751234567890" }],
      contacts: [{ emailAddress: "a@x.io" }],
    };
    const reply = { id: "ORDER-1", contacts: [{ emailAddress: "b@x.io" }], remarks: { general: [] } };
    expect(snapshotAfter(stored, reply, false, { contacts: true, remarks: false })).toEqual(reply);
    expect(snapshotAfter(stored, reply, true, { contacts: true, remarks: false })).toEqual({
      ...stored,
      contacts: [{ emailAddress: "b@x.io" }],
    });
  });
});

// ---- The service over fakes -----------------------------------------------------------------------------------------

const TENANT = {
  tenantId: "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1A",
  key: "alpha",
  schemaName: "tenant_alpha" as TenantSchema,
  environment: "test",
  caller: { type: "edge", id: "edge" },
  actor: { type: "customer", id: "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1C" },
  requestId: "req-booking-update-1",
} as unknown as RequestTenant;

const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";

function bookingRow(values: Partial<BookingRow> = {}): BookingRow {
  return {
    id: BOOKING_ID,
    environment: "test",
    reference: "VXK7M2Q9",
    customerId: "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1C",
    pricedOfferId: null,
    status: "confirmed",
    ticketingStatus: "pending",
    amadeusOrderId: "eJzTd9f",
    recordLocator: "ABC123",
    ownerOfficeId: "NCE1A0950",
    lastArrivalAt: new Date(Date.now() + 10 * DAY_MS),
    contactEmail: "old@example.com",
    totalAmount: "110.47",
    currency: "EUR",
    version: 3,
    ...values,
  } as unknown as BookingRow;
}

function children(): BookingChildren {
  const departure = new Date(Date.now() + 10 * DAY_MS - 2 * 60 * 60_000);
  return {
    travelers: [{ amadeusTravelerId: "1", firstName: "TESTA", lastName: "SAMPLE" }],
    contacts: [
      {
        id: "bco_01JA4CG3S8W1Z4C7F0H3L6P9T2",
        purpose: "STANDARD",
        isPrimary: true,
        firstName: "TESTA",
        lastName: "SAMPLE",
        companyName: null,
        email: "old@example.com",
        phones: [],
        address: null,
        language: null,
      },
    ],
    segments: [
      {
        amadeusFlightOfferId: "2",
        departureAt: departure,
        arrivalAt: new Date(departure.getTime() + 2 * 60 * 60_000),
        isFlown: false,
        departureIata: "MAD",
        arrivalIata: "ORY",
        departureLocal: departure.toISOString().slice(0, 19),
        arrivalLocal: new Date(departure.getTime() + 2 * 60 * 60_000).toISOString().slice(0, 19),
        carrierCode: "IB",
        flightNumber: "3436",
      },
    ],
    tickets: [],
    remarks: [remarkRow({}), remarkRow({ subType: "BACKOFFICE", text: "VELEXIS VXK7M2Q9", travelerIds: [] })],
    associatedRecords: [],
  } as unknown as BookingChildren;
}

const ORDER_SNAPSHOT = {
  id: "eJzTd9f",
  flightOffers: [{ id: "2" }],
  remarks: {
    general: [
      { subType: "GENERAL_MISCELLANEOUS", text: "VEGETARIAN MEAL PLEASE", travelerIds: ["1"] },
      { subType: "BACKOFFICE", text: "VELEXIS VXK7M2Q9" },
    ],
  },
};

/**
 * The service over fakes: one booking with the snapshot ORDER_SNAPSHOT (`recordBooking` and `recordSnapshot` are what
 * the reads after the first one see: another writer, or the refresh after an unknown outcome, may have changed them
 * since T1), an Amadeus client that answers `patch` as told, a refresh that answers `refresh`, and the recorded writes.
 */
function setup(
  options: {
    readonly booking?: BookingRow;
    readonly recordBooking?: BookingRow;
    readonly recordSnapshot?: JsonObject;
    readonly patch?: () => Promise<unknown>;
    readonly refresh?: () => Promise<unknown>;
  } = {},
) {
  const booking = options.booking ?? bookingRow();
  let bookingReads = 0;
  let detailsReads = 0;
  const transactions: string[] = [];
  const writes: string[] = [];
  const amadeus = {
    patchFlightOrder: vi.fn(
      options.patch ??
        ((_context: unknown, request: { body: { data: JsonObject } }) =>
          Promise.resolve({ body: { data: request.body.data }, call: { supplierRequestId: null } })),
    ),
  };
  const repository = {
    bookingRequirements: vi.fn(() => Promise.resolve(undefined)),
    replaceContacts: vi.fn(() => {
      writes.push("contacts");
      return Promise.resolve();
    }),
    insertRemarks: vi.fn((_trx: unknown, rows: unknown[]) => {
      if (rows.length > 0) {
        writes.push("remarks");
      }
      return Promise.resolve();
    }),
  };
  const bookings = {
    booking: vi.fn(() =>
      Promise.resolve(bookingReads++ === 0 ? booking : (options.recordBooking ?? booking)),
    ),
    bookingDetails: vi.fn(() =>
      Promise.resolve({
        orderSnapshot: detailsReads++ === 0 ? ORDER_SNAPSHOT : (options.recordSnapshot ?? ORDER_SNAPSHOT),
      }),
    ),
    children: vi.fn(() => Promise.resolve(children())),
    settings: vi.fn(() => Promise.resolve({ defaultLocale: "en" })),
    updateBooking: vi.fn((_trx: unknown, _id: string, _values: JsonObject) => {
      writes.push("booking");
      return Promise.resolve();
    }),
  };
  const recorder = {
    event: vi.fn((_trx: unknown, _id: string, event: { type: string }) => {
      writes.push(event.type);
      return Promise.resolve();
    }),
  };
  const outbox = {
    enqueue: vi.fn((_trx: unknown, input: { to: string }) => {
      writes.push(`mail:${input.to}`);
      return Promise.resolve({ notificationId: "ntf_1", queued: true });
    }),
  };
  const customerBookings = {
    get: vi.fn(() => Promise.resolve({ id: BOOKING_ID, version: booking.version + 1 })),
    refresh: vi.fn(options.refresh ?? (() => Promise.resolve({ kind: "skipped" as const }))),
  };
  const service = new BookingChangesService(
    {
      run: (work: (trx: unknown) => Promise<unknown>) => {
        transactions.push("run");
        return work({});
      },
    } as unknown as TenantTx,
    bookings as unknown as BookingsRepository,
    repository as unknown as BookingChangesRepository,
    recorder as unknown as OrderRecorder,
    customerBookings as unknown as CustomerBookingsService,
    amadeus as unknown as AmadeusClient,
    new BookingUpdatedEmails(
      outbox as unknown as OutboxService,
      bookings as unknown as BookingsRepository,
      { get: () => "ota.example.com" } as unknown as ConfigService<never, true>,
      { error: vi.fn() } as unknown as PinoLogger,
    ),
    { require: () => TENANT, requestId: () => TENANT.requestId } as unknown as TenantContext,
    { require: () => ({ bookingId: BOOKING_ID, via: "customer" }) } as unknown as BookingAccessContext,
    new IdGenerator(new Clock()),
    new Clock(),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PinoLogger,
  );
  return { service, amadeus, bookings, repository, recorder, outbox, customerBookings, transactions, writes };
}

/** The PATCH `data` the fake client was sent. */
function sentData(amadeus: { patchFlightOrder: { mock: { calls: unknown[][] } } }): JsonObject {
  const call = amadeus.patchFlightOrder.mock.calls[0] as [unknown, { body: { data: JsonObject } }];
  return call[1].body.data;
}

describe("BookingChangesService.update: before Amadeus", () => {
  it("[OBE-048 AC1] refuses traveller changes before it opens a transaction or calls Amadeus", async () => {
    const { service, amadeus, transactions } = setup();

    const error = await rejectionOf(
      service.update(BOOKING_ID, '"3"', {
        travelers: [{ travelerId: "1", loyaltyPrograms: [{ programOwner: "AF", id: "2099887766" }] }],
      } as BookingUpdateRequest),
    );

    expect([error.code, error.details]).toEqual(["FEATURE_DISABLED", { feature: "travelerChanges" }]);
    expect(transactions).toEqual([]);
    expect(amadeus.patchFlightOrder).not.toHaveBeenCalled();
  });

  it("answers 412 for a stale If-Match, 409 for a cancelled or flown booking, and changes nothing", async () => {
    const body = { contacts: [newContact("new@example.com")] };
    const stale = setup();
    expect((await rejectionOf(stale.service.update(BOOKING_ID, '"2"', body))).code).toBe(
      "PRECONDITION_FAILED",
    );
    const cancelled = setup({ booking: bookingRow({ status: "cancelled" }) });
    expect((await rejectionOf(cancelled.service.update(BOOKING_ID, '"3"', body))).code).toBe(
      "BOOKING_ALREADY_CANCELLED",
    );
    const flown = setup({ booking: bookingRow({ lastArrivalAt: new Date(Date.now() - DAY_MS) }) });
    const error = await rejectionOf(
      flown.service.update(BOOKING_ID, '"3"', { remarks: [{ text: "Wheelchair" }] }),
    );
    expect([error.code, error.details]).toEqual([
      "BOOKING_NOT_MODIFIABLE",
      { reason: "flown", action: "canAddRemarks" },
    ]);
    for (const { amadeus, writes } of [stale, cancelled, flown]) {
      expect(amadeus.patchFlightOrder).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    }
  });

  it("checks the contacts as checkout.setContacts does (422) and the remarks' travellers (400)", async () => {
    const { service, amadeus } = setup();

    const contacts = await rejectionOf(
      service.update(BOOKING_ID, '"3"', { contacts: [newContact("not-an-address")] }),
    );
    const twoPrimaries = await rejectionOf(
      service.update(BOOKING_ID, '"3"', {
        contacts: [
          newContact("a@example.com", { isPrimary: true }),
          newContact("b@example.com", { isPrimary: true }),
        ],
      }),
    );
    const remarks = await rejectionOf(
      service.update(BOOKING_ID, '"3"', { remarks: [{ text: "Wheelchair", travelerIds: ["2"] }] }),
    );

    expect([contacts.code, contacts.fieldErrors?.map((entry) => [entry.path, entry.code])]).toEqual([
      "CONTACT_DATA_INVALID",
      [["/contacts/0/emailAddress", "EMAIL_INVALID"]],
    ]);
    expect(twoPrimaries.code).toBe("CONTACT_DATA_INVALID");
    expect([remarks.code, remarks.fieldErrors?.map((entry) => entry.path)]).toEqual([
      "VALIDATION_FAILED",
      ["/remarks/0/travelerIds/0"],
    ]);
    expect(amadeus.patchFlightOrder).not.toHaveBeenCalled();
  });

  it("makes no Amadeus call for special requests the order already has, and answers the booking as it is", async () => {
    const { service, amadeus, writes, customerBookings } = setup();

    await service.update(BOOKING_ID, '"3"', {
      remarks: [{ text: "vegetarian meal please", travelerIds: ["1"] }],
    });

    expect(amadeus.patchFlightOrder).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(customerBookings.get).toHaveBeenCalledWith(BOOKING_ID, { refresh: false });
  });
});

describe("BookingChangesService.update: the PATCH and the record", () => {
  it("[OBE-048 AC1] sends the offers by id, every contact and the order's remarks with the new request", async () => {
    const { service, amadeus } = setup();

    await service.update(BOOKING_ID, 'W/"3"', {
      contacts: [newContact("new@example.com", { isPrimary: true })],
      remarks: [{ text: "Wheelchair at arrival" }],
    });

    expect(sentData(amadeus)).toEqual({
      type: "flight-order",
      id: "eJzTd9f",
      flightOffers: [{ type: "flight-offer", id: "2" }],
      contacts: [
        {
          purpose: "STANDARD",
          addresseeName: { firstName: "TESTA", lastName: "SAMPLE" },
          emailAddress: "new@example.com",
          phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "709876543" }],
        },
      ],
      remarks: {
        general: [
          ...ORDER_SNAPSHOT.remarks.general,
          { subType: "GENERAL_MISCELLANEOUS", text: "WHEELCHAIR AT ARRIVAL" },
        ],
      },
    });
    const context = amadeus.patchFlightOrder.mock.calls[0]?.[0] as JsonObject;
    expect(context).toMatchObject({
      operation: "bookings.update",
      bookingId: BOOKING_ID,
      orderOffice: "NCE1A0950",
    });
  });

  it("[OBE-048 AC1] [FIX-W28-NOTIFY AC1] records the contacts, the request, a new version, the events and both e-mails", async () => {
    const { service, writes, bookings, repository, outbox } = setup();

    await service.update(BOOKING_ID, '"3"', {
      contacts: [newContact("new@example.com")],
      remarks: [{ text: "Wheelchair at arrival" }],
    });

    expect(writes).toEqual([
      "contacts",
      "remarks",
      "booking",
      CONTACTS_UPDATED_EVENT,
      "booking.remark_added",
      "mail:new@example.com",
      "mail:old@example.com",
    ]);
    const rows = repository.replaceContacts.mock.calls[0] as unknown as [unknown, string, JsonObject[]];
    expect(rows[2].map((row) => [row["email"], row["is_primary"]])).toEqual([["new@example.com", true]]);
    const update = bookings.updateBooking.mock.calls[0] as unknown as [unknown, string, JsonObject];
    expect(update[2]).toMatchObject({
      contact_email: "new@example.com",
      sync_error: null,
    });
    const mails = outbox.enqueue.mock.calls.map((call) => call[1] as unknown as JsonObject);
    expect(mails.map((mail) => [mail["templateKey"], mail["to"], mail["dedupeKey"]])).toEqual([
      [BOOKING_UPDATED_TEMPLATE, "new@example.com", `booking.contacts_updated:${BOOKING_ID}:v4:new`],
      [BOOKING_UPDATED_TEMPLATE, "old@example.com", `booking.contacts_updated:${BOOKING_ID}:v4:old`],
    ]);
    // The new address gets the booking as it is now; the old one the reference and nothing else of the booking.
    expect(mails[0]?.["data"]).toMatchObject({
      booking: {
        contact: { firstName: "TESTA", lastName: "SAMPLE" },
        travellers: [{ firstName: "TESTA", lastName: "SAMPLE" }],
        url: `https://alpha.ota.example.com/booking.html?id=${BOOKING_ID}`,
      },
      update: { contactNotice: false, contactsChanged: true },
    });
    expect(mails[1]?.["data"]).toEqual({
      booking: {
        reference: "VXK7M2Q9",
        recordLocator: "",
        url: "",
        total: { amount: "", currency: "" },
        contact: { firstName: "", lastName: "" },
        travellers: [],
        segments: [],
      },
      update: { contactNotice: true, contactsChanged: true },
    });
  });

  it("[OBE-048 AC2] answers Amadeus 2552 as 409 VERSION_CONFLICT and records nothing", async () => {
    const { service, writes, customerBookings } = setup({
      patch: () =>
        Promise.reject(
          mapAmadeusError("patchFlightOrder", {
            kind: "http",
            status: 409,
            issues: [{ status: 409, code: 2552, title: "SIMULTANEOUS UPDATE" }],
          }),
        ),
    });

    const error = await rejectionOf(
      service.update(BOOKING_ID, '"3"', { contacts: [newContact("new@example.com")] }),
    );

    expect(error.code).toBe("VERSION_CONFLICT");
    expect(writes).toEqual([]);
    expect(customerBookings.refresh).not.toHaveBeenCalled();
  });

  it("resyncs after a timed-out PATCH, without the throttle, then answers the 504", async () => {
    const { service, customerBookings, writes } = setup({
      patch: () => Promise.reject(new AppError("SUPPLIER_TIMEOUT")),
    });

    const error = await rejectionOf(
      service.update(BOOKING_ID, '"3"', { contacts: [newContact("new@example.com")] }),
    );

    expect(error.code).toBe("SUPPLIER_TIMEOUT");
    expect(customerBookings.refresh).toHaveBeenCalledWith(
      TENANT,
      BOOKING_ID,
      "bookings.update",
      {},
      { throttleMs: 0 },
    );
    // The refresh skipped (nothing read): nothing is recorded.
    expect(writes).toEqual([]);
  });

  it("records nothing after a timeout when the order read back does not hold the change", async () => {
    const { service, customerBookings, writes } = setup({
      patch: () => Promise.reject(new AppError("SUPPLIER_TIMEOUT")),
      refresh: () => Promise.resolve({ kind: "refreshed", warnings: [] }),
    });

    const error = await rejectionOf(
      service.update(BOOKING_ID, '"3"', {
        contacts: [newContact("new@example.com")],
        remarks: [{ text: "Wheelchair at arrival" }],
      }),
    );

    expect(error.code).toBe("SUPPLIER_TIMEOUT");
    expect(customerBookings.refresh).toHaveBeenCalledTimes(1);
    // The stored order (ORDER_SNAPSHOT, as the refresh read it) has neither the contact nor the request.
    expect(writes).toEqual([]);
  });

  it("resyncs after an Amadeus 5xx, whose outcome is unknown, records what the order holds and answers the 502", async () => {
    const sent = amadeusContactsOf([newContact("new@example.com")]);
    const { service, customerBookings, writes, recorder, bookings } = setup({
      patch: () =>
        Promise.reject(
          mapAmadeusError("patchFlightOrder", {
            kind: "http",
            status: 500,
            issues: [{ status: 500, code: 141, title: "SYSTEM ERROR" }],
          }),
        ),
      refresh: () => Promise.resolve({ kind: "refreshed", warnings: [] }),
      // The order as the refresh stored it: Amadeus applied the PATCH before its 500.
      recordSnapshot: {
        ...ORDER_SNAPSHOT,
        contacts: sent,
        remarks: {
          general: [
            ...ORDER_SNAPSHOT.remarks.general,
            { subType: "GENERAL_MISCELLANEOUS", text: "WHEELCHAIR AT ARRIVAL" },
          ],
        },
      },
    });

    const error = await rejectionOf(
      service.update(BOOKING_ID, '"3"', {
        contacts: [newContact("new@example.com")],
        remarks: [{ text: "Wheelchair at arrival" }],
      }),
    );

    expect(error.code).toBe("SUPPLIER_ERROR");
    expect(customerBookings.refresh).toHaveBeenCalledWith(
      TENANT,
      BOOKING_ID,
      "bookings.update",
      {},
      { throttleMs: 0 },
    );
    expect(writes).toEqual([
      "contacts",
      "remarks",
      "booking",
      CONTACTS_UPDATED_EVENT,
      "booking.remark_added",
      "mail:new@example.com",
      "mail:old@example.com",
    ]);
    const data = recorder.event.mock.calls.map((call) => (call[2] as unknown as { data: JsonObject }).data);
    expect(data).toEqual([
      { cause: "resync_after_supplier_error", contacts: 1 },
      { cause: "resync_after_supplier_error", remarks: 1 },
    ]);
    // The refresh stored the snapshot: the record step leaves it.
    const update = bookings.updateBooking.mock.calls[0] as unknown as [unknown, string, JsonObject];
    expect(update[2]).not.toHaveProperty("order_snapshot");
    expect(update[2]).toMatchObject({ contact_email: "new@example.com" });
  });

  it("does not resync after a connection that was never made: the PATCH did not reach Amadeus", async () => {
    const { service, customerBookings } = setup({
      patch: () =>
        Promise.reject(mapAmadeusError("patchFlightOrder", { kind: "network", code: "ECONNREFUSED" })),
    });

    const error = await rejectionOf(
      service.update(BOOKING_ID, '"3"', { contacts: [newContact("new@example.com")] }),
    );

    expect(error.code).toBe("SUPPLIER_UNAVAILABLE");
    expect(customerBookings.refresh).not.toHaveBeenCalled();
  });

  it("merges only the answer's contacts and remarks into the snapshot when another writer changed the booking since T1", async () => {
    const { service, bookings, outbox } = setup({ recordBooking: bookingRow({ version: 4 }) });

    await service.update(BOOKING_ID, '"3"', {
      contacts: [newContact("new@example.com")],
      remarks: [{ text: "Wheelchair at arrival" }],
    });

    const update = bookings.updateBooking.mock.calls[0] as unknown as [unknown, string, JsonObject];
    const snapshot = JSON.parse(update[2]["order_snapshot"] as string) as JsonObject;
    // The stored offers stay (the echo of the fake PATCH names them by id only); contacts and remarks are the answer's.
    expect(snapshot).toEqual({
      ...ORDER_SNAPSHOT,
      contacts: amadeusContactsOf([newContact("new@example.com")]),
      remarks: {
        general: [
          ...ORDER_SNAPSHOT.remarks.general,
          { subType: "GENERAL_MISCELLANEOUS", text: "WHEELCHAIR AT ARRIVAL" },
        ],
      },
    });
    expect(update[2]).not.toHaveProperty("last_synced_at");
    expect(update[2]).not.toHaveProperty("order_dictionaries");
    const mails = outbox.enqueue.mock.calls.map((call) => (call[1] as unknown as JsonObject)["dedupeKey"]);
    expect(mails).toEqual([
      `booking.contacts_updated:${BOOKING_ID}:v5:new`,
      `booking.contacts_updated:${BOOKING_ID}:v5:old`,
    ]);
  });
});
