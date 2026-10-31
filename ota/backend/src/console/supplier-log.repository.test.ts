// The supplier log's answers, page size and cursors (supplier-log.repository.ts, OBE-066): a stored body passes the
// shared redactor once more on the way out (a row written before FIX-W29-SECURITY never shows a card holder or expiry,
// one written before FIX-W26-SECURITY no full form of identification number), bodies are answered only when asked for
// and then at most 20 rows a page, and the cursor is bound to the environment and the filters. Pure functions.
import { describe, expect, it } from "vitest";
import {
  answeredBody,
  decodeSupplierLogCursor,
  encodeSupplierLogCursor,
  supplierLogFiltersOf,
  supplierLogFingerprint,
  supplierLogLimitOf,
  toSupplierLogEntry,
  type SupplierLogRow,
} from "./supplier-log.repository";

const ID = "sreq_01JA4E1B6D9G2J5M8P1S4V7Y0B";
const KEY = "2026-10-10T09:58:21.123456";

function row(overrides: Partial<SupplierLogRow> = {}): SupplierLogRow {
  return {
    id: ID,
    environment: "test",
    operation: "console.bookings.issue",
    amadeusApi: "FlightOrderIssue",
    amadeusOperationId: "issueFlightOrder",
    httpMethod: "POST",
    path: "/v1/booking/flight-orders/eJzT/issuance",
    officeId: "NCE1A0950",
    httpStatus: 400,
    outcome: "client_error",
    errorCodes: [9112],
    durationMs: 2841,
    correlationId: "0004P2ZCLM4LXY",
    requestId: null,
    bookingId: null,
    searchId: null,
    staffId: null,
    redacted: true,
    truncated: false,
    createdAt: new Date("2026-10-10T09:58:21.123Z"),
    requestBody: null,
    responseBody: null,
    sortKey: KEY,
    ...overrides,
  };
}

describe("supplier log: bodies", () => {
  it("[OBE-066 AC2] redacts a stored body once more: no card holder, expiry or full document number", () => {
    const legacy = {
      data: {
        formOfPayments: [
          {
            creditCard: {
              brand: "VISA",
              number: "4111111111111111",
              holder: "ANNA BERG",
              expiryDate: "2030-12",
            },
          },
        ],
        formOfIdentifications: [{ identificationType: "PASSPORT", number: "X12345678" }],
        travelers: [{ documents: [{ number: "Y87654321", expiryDate: "2034-02-01" }] }],
      },
    };

    expect(answeredBody(legacy)).toEqual({
      data: {
        formOfPayments: [{ creditCard: { brand: "VISA", number: "1111" } }],
        formOfIdentifications: [{ identificationType: "PASSPORT", number: "5678" }],
        travelers: [{ documents: [{ number: "4321", expiryDate: "2034-02-01" }] }],
      },
    });
  });

  it("[OBE-066 AC2] changes nothing on a body the writer redacted, answers none as null and wraps a non-object", () => {
    const stored = {
      data: { formOfPayments: [{ creditCard: { brand: "VISA", number: "1111" } }] },
      contact: { emailAddress: "a***@example.com" },
    };
    expect(answeredBody(stored)).toEqual(stored);
    expect(answeredBody(null)).toBeNull();
    expect(answeredBody(undefined)).toBeNull();
    expect(answeredBody([{ documents: [{ number: "X12345678" }] }])).toEqual({
      value: [{ documents: [{ number: "5678" }] }],
    });
  });

  it("answers the bodies only when asked for", () => {
    const entry = toSupplierLogEntry(row({ requestBody: { a: 1 }, responseBody: { b: 2 } }), false);
    expect(entry).not.toHaveProperty("requestBody");
    expect(entry).not.toHaveProperty("responseBody");
    expect(toSupplierLogEntry(row({ requestBody: { a: 1 } }), true)).toMatchObject({
      requestBody: { a: 1 },
      responseBody: null,
      createdAt: "2026-10-10T09:58:21.123Z",
    });
  });
});

describe("supplier log: page size and cursors", () => {
  it("serves at most 20 rows with bodies, and the document's limits without", () => {
    expect(supplierLogLimitOf({})).toBe(20);
    expect(supplierLogLimitOf({ includeBodies: true })).toBe(20);
    expect(supplierLogLimitOf({ includeBodies: true, limit: 5 })).toBe(5);
    expect(supplierLogLimitOf({ includeBodies: false, limit: 100 })).toBe(100);
    expect(() => supplierLogLimitOf({ includeBodies: true, limit: 21 })).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        fieldErrors: [expect.objectContaining({ path: "/query/limit" })],
      }),
    );
  });

  it("reads back the position it wrote, for the log of the same environment and filters only", () => {
    const filters = supplierLogFiltersOf({ outcome: ["timeout", "client_error"], errorCode: 9112 });
    const fingerprint = supplierLogFingerprint("test", filters);
    const cursor = encodeSupplierLogCursor(fingerprint, KEY, ID);

    expect(decodeSupplierLogCursor(cursor, fingerprint)).toEqual({ key: KEY, id: ID });
    // The order of a list filter's values does not matter.
    expect(
      decodeSupplierLogCursor(
        cursor,
        supplierLogFingerprint(
          "test",
          supplierLogFiltersOf({ outcome: ["client_error", "timeout"], errorCode: 9112 }),
        ),
      ),
    ).toEqual({ key: KEY, id: ID });
    for (const print of [
      supplierLogFingerprint("live", filters),
      supplierLogFingerprint("test", supplierLogFiltersOf({ outcome: ["timeout"], errorCode: 9112 })),
      supplierLogFingerprint("test", supplierLogFiltersOf({ outcome: ["timeout", "client_error"] })),
    ]) {
      expect(() => decodeSupplierLogCursor(cursor, print)).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    }
    for (const value of ["", "%%%", encodeSupplierLogCursor(fingerprint, "yesterday", ID)]) {
      expect(() => decodeSupplierLogCursor(value, fingerprint)).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    }
  });
});
