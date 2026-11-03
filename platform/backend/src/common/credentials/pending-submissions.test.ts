import { describe, expect, it } from "vitest";
import { pendingSubmissionOf, toPendingSubmission, type PendingSubmissions } from "./pending-submissions";

const SUBMISSION_ID = "crs_01JATESTRW0000000000000001";

describe("toPendingSubmission", () => {
  it("[FIX-W39-PLATFORM AC7] shows an open submission without an error code and a failed one with its code", () => {
    for (const status of ["pending", "verifying"]) {
      expect(toPendingSubmission({ id: SUBMISSION_ID, status, error_code: null })).toEqual({
        id: SUBMISSION_ID,
        status,
        errorCode: null,
      });
    }
    expect(
      toPendingSubmission({ id: SUBMISSION_ID, status: "failed", error_code: "AMADEUS_CREDENTIALS_INVALID" }),
    ).toEqual({ id: SUBMISSION_ID, status: "failed", errorCode: "AMADEUS_CREDENTIALS_INVALID" });
  });

  it("[FIX-W39-PLATFORM AC7] shows nothing once the submission was applied or superseded, or without one", () => {
    for (const status of ["applied", "superseded"]) {
      expect(toPendingSubmission({ id: SUBMISSION_ID, status, error_code: "STALE_CODE" }), status).toBeNull();
    }
    expect(toPendingSubmission(undefined)).toBeNull();
  });
});

describe("pendingSubmissionOf", () => {
  it("[FIX-W39-PLATFORM AC7] picks the connection's environment and nothing else", () => {
    const failed = { id: SUBMISSION_ID, status: "failed" as const, errorCode: "STRIPE_KEY_INVALID" };
    const pending: PendingSubmissions = { live: failed };

    expect(pendingSubmissionOf(pending, "live")).toEqual(failed);
    expect(pendingSubmissionOf(pending, "test")).toBeNull();
    expect(pendingSubmissionOf(pending, "toString")).toBeNull();
    expect(pendingSubmissionOf({}, "live")).toBeNull();
  });
});
