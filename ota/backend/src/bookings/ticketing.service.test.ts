// The claim rules of the ticketing job (OBE-044; OADR-0014 point 6) that hold without a database: `claimSkip` and
// `ticketingClaimFresh`, and since FIX-W31-OTA (lead decision (1) of 2026-10-27) the hold of an undecided cancellation
// (cancellation-state.ts `cancellationHoldOf`), which console.bookings.issue reads too. Instants are built from
// FakeClock's fixed start, never from today.
import { FAKE_CLOCK_DEFAULT_START } from "@velexis/testing";
import { describe, expect, it } from "vitest";
import { CANCELLATION_CLAIM_TTL_MS, cancellationClaimFresh, cancellationHoldOf } from "./cancellation-state";
import {
  claimSkip,
  TICKETING_CLAIM_TTL_MS,
  ticketingClaimFresh,
  type TicketingBookingRow,
} from "./ticketing.service";

const MINUTE = 60_000;
const NOW = new Date(FAKE_CLOCK_DEFAULT_START);
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** A booking whose retry is due now and that nothing holds. */
function dueRow(overrides: Partial<TicketingBookingRow> = {}): TicketingBookingRow {
  return {
    id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
    environment: "test",
    reference: "VX7K2Q",
    status: "confirmed",
    customerId: null,
    amadeusOrderId: "eJzTd9cPcjQ",
    recordLocator: "ABC123",
    ownerOfficeId: "NCE1A0950",
    ticketingStatus: "failed",
    ticketingAttempts: 1,
    ticketingLastAttemptAt: ago(10 * MINUTE),
    ticketingNextAttemptAt: ago(MINUTE),
    ticketingDeadlineAt: null,
    ticketingErrorCode: "TICKETING_FAILED",
    issuedAt: null,
    contactEmail: "traveller@example.com",
    currency: "EUR",
    totalAmount: "125.47",
    amountPaid: "125.47",
    version: 3,
    paidByAirlineCard: false,
    cancellationClaimedAt: null,
    cancellationUndecided: false,
    ...overrides,
  };
}

describe("the ticketing job's claim", () => {
  it("claims a due retry, and an in_progress claim only once it is abandoned", () => {
    expect(claimSkip(dueRow(), NOW, "active")).toBeUndefined();
    expect(
      claimSkip(dueRow({ ticketingNextAttemptAt: new Date(NOW.getTime() + MINUTE) }), NOW, "active"),
    ).toBe("not_due");
    const claimed = (at: Date) => dueRow({ ticketingStatus: "in_progress", ticketingLastAttemptAt: at });
    expect(claimSkip(claimed(ago(MINUTE)), NOW, "active")).toBe("not_due");
    expect(ticketingClaimFresh(claimed(ago(TICKETING_CLAIM_TTL_MS)), NOW)).toBe(true);
    expect(claimSkip(claimed(ago(TICKETING_CLAIM_TTL_MS + 1)), NOW, "active")).toBeUndefined();
  });

  it("skips a booking it may not issue, whatever is due", () => {
    expect(claimSkip(dueRow({ status: "ticketed" }), NOW, "active")).toBe("not_confirmed");
    expect(claimSkip(dueRow({ amadeusOrderId: null }), NOW, "active")).toBe("no_order");
    expect(claimSkip(dueRow({ paidByAirlineCard: true }), NOW, "active")).toBe("airline_card");
    expect(claimSkip(dueRow({ amountPaid: "0.00" }), NOW, "suspended")).toBe("unpaid");
  });

  it("[FIX-W31-OTA AC1] skips a booking whose cancellation's DELETE is in flight, until the claim is 5 minutes old", () => {
    const claimedAt = (at: Date | null) => dueRow({ cancellationClaimedAt: at });
    // T1 committed a moment ago (its DELETE in flight), or exactly 5 minutes ago: held.
    expect(claimSkip(claimedAt(NOW), NOW, "active")).toBe("cancellation_pending");
    expect(claimSkip(claimedAt(ago(CANCELLATION_CLAIM_TTL_MS)), NOW, "active")).toBe("cancellation_pending");
    // An abandoned claim (a request that stopped mid-DELETE) holds nothing back: the attempt starts with its resync.
    expect(claimSkip(claimedAt(ago(CANCELLATION_CLAIM_TTL_MS + 1)), NOW, "active")).toBeUndefined();
    // Every outcome clears the column: the claim behaves as before.
    expect(claimSkip(claimedAt(null), NOW, "active")).toBeUndefined();
    // The hold lasts as long as a ticketing claim holds a cancellation back.
    expect(CANCELLATION_CLAIM_TTL_MS).toBe(TICKETING_CLAIM_TTL_MS);
  });

  it("[FIX-W31-OTA AC1] skips a booking whose DELETE got no answer while it is undecided, however old its flag", () => {
    expect(claimSkip(dueRow({ cancellationUndecided: true }), NOW, "active")).toBe("cancellation_pending");
    expect(
      claimSkip(
        dueRow({ cancellationUndecided: true, cancellationClaimedAt: ago(60 * MINUTE) }),
        NOW,
        "suspended",
      ),
    ).toBe("cancellation_pending");
    // A cancelled booking is skipped as before: it is no longer confirmed.
    expect(claimSkip(dueRow({ status: "cancelled", cancellationUndecided: true }), NOW, "active")).toBe(
      "not_confirmed",
    );
  });
});

describe("the hold of an undecided cancellation (cancellation-state.ts)", () => {
  it("[FIX-W31-OTA AC1] holds from the claim's commit for 5 minutes and while the flag is undecided, else nothing", () => {
    expect(
      cancellationHoldOf({ cancellationClaimedAt: null, cancellationUndecided: false }, NOW),
    ).toBeUndefined();
    expect(
      cancellationHoldOf({ cancellationClaimedAt: ago(MINUTE), cancellationUndecided: false }, NOW),
    ).toBe("claimed");
    expect(cancellationHoldOf({ cancellationClaimedAt: null, cancellationUndecided: true }, NOW)).toBe(
      "undecided",
    );
    expect(
      cancellationHoldOf(
        { cancellationClaimedAt: ago(CANCELLATION_CLAIM_TTL_MS + 1), cancellationUndecided: false },
        NOW,
      ),
    ).toBeUndefined();
    expect(cancellationClaimFresh(null, NOW)).toBe(false);
    // A clock that moved back (a claim written "in the future") still holds: it is not older than the TTL.
    expect(cancellationClaimFresh(new Date(NOW.getTime() + MINUTE), NOW)).toBe(true);
  });
});
