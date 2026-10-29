// Which cancellation in progress refuses a second one (cancellation-state.ts `cancellationPendingOf` and
// `staffCancellationPendingOf`; FIX-W33-OTA, lead decision (1e) of 2026-10-29): what bookings.cancel and
// console.bookings.cancel refuse with `pending`, and what bookings.quoteCancellation, the customer's canCancel and the
// console's canCancel show. Pure functions; the reads behind `claimPending` are the integration tests'
// (test/integration/bookings/cancel.int.test.ts, test/integration/console/issue-cancel.int.test.ts).
import { describe, expect, it } from "vitest";
import {
  cancellationPendingOf,
  staffCancellationPendingOf,
  type CancellationFlag,
  type CancellationState,
} from "./cancellation-state";

const FLAG: CancellationFlag = {
  mode: "void",
  reasonCode: "change_of_plans",
  comment: null,
  estimate: { amountPaid: "120.00", estimatedRefund: "120.00", penalty: "0.00", otaFee: "0.00" },
  currency: "EUR",
  requestedAt: "2026-10-18T09:00:00.000Z",
  until: "2026-10-18T09:15:00.000Z",
  actor: { type: "customer", id: "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1X" },
  requestId: "req_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
  cancelledBy: "customer",
};

const NONE: CancellationState = { kind: "none" };
const REQUESTED: CancellationState = { kind: "requested" };
const UNDECIDED: CancellationState = {
  kind: "undecided",
  flag: FLAG,
  flaggedAt: new Date("2026-10-18T09:00:00.000Z"),
};

describe("a cancellation in progress (cancellation-state.ts)", () => {
  it("[FIX-W33-OTA] [OBE-049] refuses a customer's second cancellation while one is undecided, waits for the staff, or has its DELETE in flight", () => {
    expect(cancellationPendingOf({ state: NONE, claimPending: false })).toBe(false);
    // Another cancellation's fresh claim: its DELETE is in flight (the check bookings.cancel refuses with).
    expect(cancellationPendingOf({ state: NONE, claimPending: true })).toBe(true);
    expect(cancellationPendingOf({ state: UNDECIDED, claimPending: false })).toBe(true);
    expect(cancellationPendingOf({ state: REQUESTED, claimPending: false })).toBe(true);
  });

  it("[FIX-W33-OTA] [OBE-063] refuses a staff cancellation while one is undecided or has its DELETE in flight, not for a customer's request", () => {
    expect(staffCancellationPendingOf({ state: NONE, claimPending: false })).toBe(false);
    expect(staffCancellationPendingOf({ state: NONE, claimPending: true })).toBe(true);
    expect(staffCancellationPendingOf({ state: UNDECIDED, claimPending: false })).toBe(true);
    // A customer's request waiting for the staff is what the staff finish (console.bookings.cancel `staffCheck`).
    expect(staffCancellationPendingOf({ state: REQUESTED, claimPending: false })).toBe(false);
  });
});
