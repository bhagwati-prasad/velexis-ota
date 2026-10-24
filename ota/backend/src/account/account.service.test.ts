// The pure parts of the customer account operations (OBE-035): the checks and normalisation of an account.update body,
// the placeholder address of a deleted customer, the environments whose bookings hold a deletion back, the error a
// deletion's transaction is run again for, the idempotency request hash of account.delete and the answers of the
// mapper. The operations themselves run against PostgreSQL,
// Redis and Mailpit in test/integration/account/account.int.test.ts.
import { randomBytes } from "node:crypto";
import { hmacSha256 } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { accountEtagOf, ERASURE_DUE_AFTER_MS, toAccountDeletion } from "./account.mapper";
import {
  AccountRetryLaterError,
  DeleteAccountIdempotencyHooks,
  deletedAddress,
  deletionEnvironments,
  isDeadlock,
  profileChangesOf,
} from "./account.service";

const TODAY = "2026-10-23";

/** The field errors of the `400 VALIDATION_FAILED` that `run` throws, as `[path, code]` pairs. */
function fieldErrorsOf(run: () => unknown): [string, string][] {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      return (error.fieldErrors ?? []).map((item) => [item.path, item.code]);
    }
    throw error;
  }
  throw new Error("expected a 400 VALIDATION_FAILED");
}

describe("profileChangesOf", () => {
  it("[OBE-035] trims names and the address, keeps the phone as customers stores it and passes null through", () => {
    expect(
      profileChangesOf(
        {
          firstName: "  Anna ",
          lastName: "Berg",
          phone: { deviceType: "MOBILE", countryCallingCode: "+44", number: "7700900123" },
          dateOfBirth: "1988-04-17",
          marketingConsent: false,
          email: " anna.new@example.com ",
          currentPassword: "not-read-here",
        },
        TODAY,
      ),
    ).toEqual({
      firstName: "Anna",
      lastName: "Berg",
      phone: { countryCallingCode: "44", number: "7700900123" },
      dateOfBirth: "1988-04-17",
      marketingConsent: false,
      email: "anna.new@example.com",
    });
    expect(profileChangesOf({ phone: null, dateOfBirth: null }, TODAY)).toEqual({
      phone: null,
      dateOfBirth: null,
    });
    expect(profileChangesOf({ dateOfBirth: TODAY }, TODAY)).toEqual({ dateOfBirth: TODAY });
  });

  it("[OBE-035] collects every problem into one 400 whose field errors name the paths, never the values", () => {
    const secretLike = "9".repeat(16);
    const errors = fieldErrorsOf(() =>
      profileChangesOf(
        {
          firstName: "   ",
          phone: { countryCallingCode: "0044x", number: secretLike },
          dateOfBirth: "2026-10-24",
          email: '"quoted"@example.com',
        },
        TODAY,
      ),
    );
    expect(errors).toEqual([
      ["/firstName", "blank"],
      ["/phone/countryCallingCode", "pattern"],
      ["/phone/number", "pattern"],
      ["/dateOfBirth", "in_future"],
      ["/email", "format"],
    ]);
    expect(fieldErrorsOf(() => profileChangesOf({ phone: {} }, TODAY))).toEqual([
      ["/phone/countryCallingCode", "required"],
      ["/phone/number", "required"],
    ]);
    try {
      profileChangesOf({ phone: { countryCallingCode: "44", number: `${secretLike}x` } }, TODAY);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(secretLike);
      expect(String((error as Error).message)).not.toContain(secretLike);
    }
  });
});

describe("deletedAddress", () => {
  it("[OBE-035] is the HMAC-SHA-256 of the normalised address at deleted.invalid, never the address", () => {
    const key = randomBytes(32);
    const placeholder = deletedAddress(" Anna.Berg@Example.com ", key);
    expect(placeholder).toBe(`${hmacSha256(key, "anna.berg@example.com")}@deleted.invalid`);
    expect(placeholder).toMatch(/^[0-9a-f]{64}@deleted\.invalid$/);
    expect(placeholder).not.toContain("anna");
    // A new key each time: two deletions of one address never share a placeholder.
    expect(deletedAddress("anna.berg@example.com", randomBytes(32))).not.toBe(placeholder);
  });
});

describe("deletionEnvironments", () => {
  it("[OBE-035] counts live bookings always and test bookings in the test environment only", () => {
    expect(deletionEnvironments("test")).toEqual(["test", "live"]);
    expect(deletionEnvironments("live")).toEqual(["live"]);
  });
});

describe("DeleteAccountIdempotencyHooks", () => {
  it("[OBE-035] leaves the current password out of the request hash", () => {
    const hooks = new DeleteAccountIdempotencyHooks();
    const hashed = hooks.hashInput({
      path: {},
      query: {},
      body: { currentPassword: "Fjord-secret-1", reason: "other", exportData: false },
    });
    expect(hashed).toEqual({
      path: {},
      query: {},
      body: { reason: "other", comment: null, exportData: false },
    });
    expect(JSON.stringify(hashed)).not.toContain("Fjord-secret-1");
  });
});

describe("isDeadlock", () => {
  it("[OBE-035] recognises PostgreSQL's deadlock (40P01) only: the one error a deletion runs again", () => {
    expect(isDeadlock(Object.assign(new Error("deadlock detected"), { code: "40P01" }))).toBe(true);
    expect(isDeadlock(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
    expect(isDeadlock(new AppError("CONFLICT"))).toBe(false);
    expect(isDeadlock(undefined)).toBe(false);
    expect(isDeadlock("40P01")).toBe(false);
  });
});

describe("AccountRetryLaterError", () => {
  it("[OBE-035] is a 429 RATE_LIMITED with its reason and the seconds of Retry-After", () => {
    const error = new AccountRetryLaterError(42, "verification_email");
    expect([error.code, error.status, error.retryAfterSeconds, error.details]).toEqual([
      "RATE_LIMITED",
      429,
      42,
      { reason: "verification_email" },
    ]);
  });
});

describe("account answers", () => {
  it("[OBE-035] quotes the version as the ETag", () => {
    expect(accountEtagOf(7)).toBe('"7"');
  });

  it("[OBE-035] answers a scheduled deletion due 30 days later, with the kept records only when there are bookings", () => {
    const requestedAt = new Date("2026-10-23T08:00:00.000Z");
    const withBookings = toAccountDeletion({ requestedAt, hasBookings: true });
    expect(withBookings).toMatchObject({
      status: "scheduled",
      requestedAt: "2026-10-23T08:00:00.000Z",
      erasureDueBy: new Date(requestedAt.getTime() + ERASURE_DUE_AFTER_MS).toISOString(),
      dataExport: null,
    });
    expect(withBookings.erasureDueBy).toBe("2026-11-22T08:00:00.000Z");
    expect(withBookings.retainedRecords.map((record) => record.category)).toEqual(["bookings", "payments"]);
    expect(toAccountDeletion({ requestedAt, hasBookings: false }).retainedRecords).toEqual([]);
  });
});
