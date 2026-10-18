// The outcome rules of `amadeus_account.verify` (PBE-020, flows/amadeus-connection.md §A step 2): what each answer of
// the token check writes, when BullMQ tries again, and the job payload it accepts.
import { describe, expect, it } from "vitest";
import { amadeusAccountIdOf, verificationOutcome } from "./verification.processor";

const NOW = new Date("2026-01-15T10:00:00.000Z");
const ACCOUNT_ID = "ama_01JATESTRW0000000000000001";

describe("verificationOutcome", () => {
  it("makes any account active with last_verified_at and no error when a token came", () => {
    for (const status of ["pending_verification", "active", "invalid_credentials", "disabled"]) {
      expect(verificationOutcome({ outcome: "verified", httpStatus: 200 }, status, false, NOW)).toEqual({
        fields: { status: "active", last_error: null, last_verified_at: NOW },
        retry: false,
      });
    }
  });

  it("makes the account invalid_credentials at once when Amadeus refused, or the secret does not decrypt", () => {
    const error = "HTTP 401 invalid_client (Amadeus code 38187)";
    expect(
      verificationOutcome({ outcome: "rejected", httpStatus: 401, error }, "active", false, NOW),
    ).toEqual({
      fields: { status: "invalid_credentials", last_error: error },
      retry: false,
    });
    expect(
      verificationOutcome(
        { outcome: "undecryptable", error: "cannot be decrypted" },
        "pending_verification",
        false,
        NOW,
      ),
    ).toEqual({ fields: { status: "invalid_credentials", last_error: "cannot be decrypted" }, retry: false });
  });

  it("keeps the status and retries while Amadeus is unavailable; the last attempt fails a new account, never an active one", () => {
    const check = { outcome: "unavailable", httpStatus: 500, error: "HTTP 500 (Amadeus code 141)" } as const;
    expect(verificationOutcome(check, "pending_verification", false, NOW)).toEqual({
      fields: { status: "pending_verification", last_error: check.error },
      retry: true,
    });
    expect(verificationOutcome(check, "pending_verification", true, NOW)).toEqual({
      fields: { status: "invalid_credentials", last_error: check.error },
      retry: false,
    });
    expect(verificationOutcome(check, "active", true, NOW)).toEqual({
      fields: { status: "active", last_error: check.error },
      retry: false,
    });
  });
});

describe("amadeusAccountIdOf", () => {
  it("accepts exactly { amadeusAccountId: ama_… }", () => {
    expect(amadeusAccountIdOf({ amadeusAccountId: ACCOUNT_ID })).toBe(ACCOUNT_ID);
    expect(amadeusAccountIdOf({ amadeusAccountId: ACCOUNT_ID, clientSecret: "x" })).toBeUndefined();
    expect(amadeusAccountIdOf({ amadeusAccountId: "acc_01JATESTRW0000000000000001" })).toBeUndefined();
    expect(amadeusAccountIdOf([ACCOUNT_ID])).toBeUndefined();
    expect(amadeusAccountIdOf(null)).toBeUndefined();
  });
});
