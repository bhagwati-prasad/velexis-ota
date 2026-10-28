// The console customers' answers and cursors (customers.service.ts, OBE-066): a deleted account is shown without the
// names, phone, date of birth and pending address its row keeps until the erasure job (the contract's "null for deleted
// accounts"), a pending verification counts as `active`, and the keyset cursors are bound to the environment, filters
// and sort, a `name` cursor carrying no key at all (no name in the OTA admin's URLs). Pure functions.
import { describe, expect, it } from "vitest";
import type { CustomerRecord } from "../identity/customers.repository";
import type { ConsoleCustomerListRow } from "./customers.repository";
import { foldedPrefix } from "./customers.repository";
import {
  consoleCustomersFingerprint,
  consoleStatusOf,
  customerFiltersOf,
  decodeCustomerCursor,
  encodeCustomerCursor,
  toConsoleCustomerAccount,
  toConsoleCustomerStats,
  toConsoleCustomerSummary,
  withoutDeletedName,
  type ConsoleCustomerSummary,
} from "./customers.service";

const CREATED = new Date("2025-05-14T18:02:11.000Z");
const CUSTOMER_ID = "cus_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const PLACEHOLDER = `${"ab".repeat(32)}@deleted.invalid`;

function listRow(overrides: Partial<ConsoleCustomerListRow> = {}): ConsoleCustomerListRow {
  return {
    id: CUSTOMER_ID,
    email: "anna.berg@example.com",
    firstName: "Anna",
    lastName: "Berg",
    status: "active",
    emailVerifiedAt: CREATED,
    phoneCountryCode: "46",
    phoneNumber: "701234567",
    lastSignInAt: null,
    createdAt: CREATED,
    bookingsCount: 2,
    upcomingBookingsCount: 1,
    cancelledBookingsCount: 0,
    lastBookingAt: CREATED,
    totalSpent: "2890.4",
    totalRefunded: "0.00",
    sortKey: null,
    ...overrides,
  };
}

function record(overrides: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: CUSTOMER_ID,
    email: "anna.berg@example.com",
    email_verified_at: CREATED,
    pending_email: null,
    first_name: "Anna",
    last_name: "Berg",
    date_of_birth: "1988-04-12",
    phone_country_code: "46",
    phone_number: "701234567",
    status: "active",
    marketing_consent: true,
    marketing_consent_updated_at: CREATED,
    marketing_consent_source: "sign_up",
    terms_accepted_version: "2025-03",
    last_sign_in_at: null,
    deleted_at: null,
    created_at: CREATED,
    updated_at: CREATED,
    version: 3,
    ...overrides,
  };
}

describe("console customers: the answers", () => {
  it("[OBE-066 AC1] shows a deleted account's summary without its kept names and phone", () => {
    const summary = toConsoleCustomerSummary(
      listRow({ status: "deleted", email: PLACEHOLDER, totalSpent: null }),
      "EUR",
      2,
    );

    expect(summary).toMatchObject({
      email: PLACEHOLDER,
      firstName: null,
      lastName: null,
      phone: null,
      status: "deleted",
      totalSpent: null,
      bookingsCount: 2,
    });
    expect(JSON.stringify(summary)).not.toMatch(/Anna|Berg|701234567/);
  });

  it("[OBE-066 AC1] shows a deleted account without names, phone, date of birth or pending address", () => {
    const account = toConsoleCustomerAccount(
      record({ status: "deleted", email: PLACEHOLDER, deleted_at: CREATED, marketing_consent: false }),
    );

    expect(account).toMatchObject({
      email: PLACEHOLDER,
      firstName: "",
      lastName: "",
      phone: null,
      dateOfBirth: null,
      pendingEmail: null,
      status: "deleted",
      version: 3,
    });
    expect(JSON.stringify(account)).not.toMatch(/Anna|Berg|701234567|1988-04-12/);
  });

  it("[OBE-066 AC1] shows the customer of a deleted account's booking without a name", () => {
    const booking = {
      customer: { id: CUSTOMER_ID, email: PLACEHOLDER, firstName: "Anna", lastName: "Berg" },
    } as unknown as Parameters<typeof withoutDeletedName>[0];

    expect(withoutDeletedName(booking).customer).toEqual({
      id: CUSTOMER_ID,
      email: PLACEHOLDER,
      firstName: null,
      lastName: null,
    });
    const guest = { customer: null } as unknown as Parameters<typeof withoutDeletedName>[0];
    expect(withoutDeletedName(guest)).toBe(guest);
  });

  it("shows an active account as account.get does, and its amounts in the currency's minor units", () => {
    expect(toConsoleCustomerAccount(record())).toMatchObject({
      firstName: "Anna",
      lastName: "Berg",
      phone: { countryCallingCode: "46", number: "701234567" },
      dateOfBirth: "1988-04-12",
    });
    const summary: ConsoleCustomerSummary = toConsoleCustomerSummary(listRow(), "EUR", 2);
    expect(summary).toMatchObject({
      firstName: "Anna",
      phone: { countryCallingCode: "46", number: "701234567" },
      totalSpent: { amount: "2890.40", currency: "EUR" },
      emailVerified: true,
      lastBookingAt: CREATED.toISOString(),
    });
    expect(
      toConsoleCustomerStats(
        { ...listRow(), totalSpent: "1500", totalRefunded: null, cancelledBookingsCount: 1 },
        "JPY",
        0,
      ),
    ).toEqual({
      bookingsCount: 2,
      upcomingBookingsCount: 1,
      cancelledBookingsCount: 1,
      totalSpent: { amount: "1500", currency: "JPY" },
      totalRefunded: null,
      lastBookingAt: CREATED.toISOString(),
    });
  });

  it("counts a pending verification as active and refuses a status the contract does not know", () => {
    expect(consoleStatusOf("pending_verification")).toBe("active");
    expect(consoleStatusOf("active")).toBe("active");
    expect(consoleStatusOf("disabled")).toBe("disabled");
    expect(consoleStatusOf("deleted")).toBe("deleted");
    expect(() => consoleStatusOf("archived")).toThrow(TypeError);
  });

  it("lists active and disabled accounts unless the request names statuses", () => {
    expect(customerFiltersOf({}).status).toEqual(["active", "disabled"]);
    expect(customerFiltersOf({ status: ["deleted"] }).status).toEqual(["deleted"]);
  });

  it("folds the search as the names are compared: lower case, no accents, ß as ss", () => {
    expect(foldedPrefix("Élodie")).toBe("elodie");
    expect(foldedPrefix("ŁUKASZ Øster")).toBe("lukasz oster");
    // The SQL side keeps `ß` through lower() and NFD, so both sides fold it to `ss` (not only the search).
    for (const spelling of ["Strauß", "STRAUSS", "strauss", "STRAUẞ"]) {
      expect(foldedPrefix(spelling)).toBe("strauss");
    }
    expect(foldedPrefix("İlkay Đorđe")).toBe("ilkay dorde");
    expect(foldedPrefix("50%_off")).toBe("50%_off");
  });
});

describe("console customers: cursors", () => {
  const fingerprint = consoleCustomersFingerprint("test", "-created", customerFiltersOf({ q: "anna" }));
  const instant = "2026-10-10T09:20:41.123456";

  it("reads back the position it wrote, for the list it was written for only", () => {
    const cursor = encodeCustomerCursor(fingerprint, instant, CUSTOMER_ID);

    expect(decodeCustomerCursor(cursor, fingerprint, "-created")).toEqual({ key: instant, id: CUSTOMER_ID });
    const other = consoleCustomersFingerprint("live", "-created", customerFiltersOf({ q: "anna" }));
    for (const [value, print] of [
      [cursor, other],
      [cursor, consoleCustomersFingerprint("test", "-created", customerFiltersOf({ q: "ann" }))],
      [
        cursor,
        consoleCustomersFingerprint(
          "test",
          "-created",
          customerFiltersOf({ q: "anna", status: ["deleted"] }),
        ),
      ],
      ["not-a-cursor", fingerprint],
      ["", fingerprint],
    ] as const) {
      expect(() => decodeCustomerCursor(value, print, "-created")).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    }
  });

  it("takes the key each sort writes: none for a name cursor, an instant or none for the last booking", () => {
    const name = consoleCustomersFingerprint("test", "name", customerFiltersOf({}));
    expect(decodeCustomerCursor(encodeCustomerCursor(name, null, CUSTOMER_ID), name, "name")).toEqual({
      key: null,
      id: CUSTOMER_ID,
    });
    expect(() => decodeCustomerCursor(encodeCustomerCursor(name, "Berg", CUSTOMER_ID), name, "name")).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    const last = consoleCustomersFingerprint("test", "-lastBooking", customerFiltersOf({}));
    for (const key of [null, instant]) {
      expect(
        decodeCustomerCursor(encodeCustomerCursor(last, key, CUSTOMER_ID), last, "-lastBooking").key,
      ).toBe(key);
    }
    const spent = consoleCustomersFingerprint("test", "-totalSpent", customerFiltersOf({}));
    expect(
      decodeCustomerCursor(encodeCustomerCursor(spent, "120.00", CUSTOMER_ID), spent, "-totalSpent").key,
    ).toBe("120.00");
    expect(() =>
      decodeCustomerCursor(encodeCustomerCursor(spent, instant, CUSTOMER_ID), spent, "-totalSpent"),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
