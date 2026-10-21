// The self-service actions of a booking (OBE-046, allowed-actions.ts): each action and the reason of each refusal,
// over bookings built relative to one `now` (no calendar date is fixed). Pure function; no service is called.
import { describe, expect, it } from "vitest";
import {
  allowedActionsOf,
  ANCILLARIES_CUTOFF_MS,
  BOOKING_ACTIONS,
  CANCEL_CUTOFF_MS,
  REFRESH_THROTTLE_MS,
  type AllowedActionsInput,
} from "./allowed-actions";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const now = new Date();
const at = (offsetMs: number): Date => new Date(now.getTime() + offsetMs);

/** A confirmed round trip 30 days ahead: out on day 30, back on day 37. */
function input(overrides: Partial<AllowedActionsInput> = {}): AllowedActionsInput {
  return {
    status: "confirmed",
    ticketingStatus: "pending",
    amadeusOrderId: "eJzTd9f3NjIJdgMADeQCtg",
    lastArrivalAt: at(37 * DAY + 3 * HOUR),
    segments: [
      { departureAt: at(30 * DAY), arrivalAt: at(30 * DAY + 2 * HOUR), isFlown: false },
      { departureAt: at(37 * DAY), arrivalAt: at(37 * DAY + 3 * HOUR), isFlown: false },
    ],
    documentsReady: false,
    features: { selfServiceCancellation: true, ancillaries: true },
    lastRefreshAt: null,
    now,
    ...overrides,
  };
}

describe("the allowed actions of a live booking", () => {
  it("allows cancelling, contacts, remarks and a refresh, and gives a reason for every action it refuses", () => {
    const actions = allowedActionsOf(input());

    expect(actions).toMatchObject({
      canCancel: true,
      canModifyContacts: true,
      canAddRemarks: true,
      canRefresh: true,
      canModifyTravelerDocuments: false,
      canModifyLoyaltyPrograms: false,
      canDownloadDocuments: false,
      canAddAncillaries: false,
    });
    // Traveller changes and post-booking extras are not offered in the MVP; nothing is ticketed yet.
    expect(actions.reasons).toEqual({
      canModifyTravelerDocuments: "disabled_by_ota",
      canModifyLoyaltyPrograms: "disabled_by_ota",
      canDownloadDocuments: "not_ticketed",
      canAddAncillaries: "disabled_by_ota",
    });
    for (const action of BOOKING_ACTIONS) {
      expect(action in actions.reasons).toBe(actions[action] === false);
    }
  });

  it("refuses cancellation when the OTA has not turned self-service cancellation on", () => {
    const actions = allowedActionsOf(
      input({ features: { selfServiceCancellation: false, ancillaries: true } }),
    );

    expect(actions.canCancel).toBe(false);
    expect(actions.reasons["canCancel"]).toBe("disabled_by_ota");
  });

  it("refuses cancellation within 3 hours of the first departure and extra bags within 24 hours", () => {
    const soon = (offsetMs: number) =>
      input({
        segments: [{ departureAt: at(offsetMs), arrivalAt: at(offsetMs + 2 * HOUR), isFlown: false }],
        lastArrivalAt: at(offsetMs + 2 * HOUR),
      });

    expect(allowedActionsOf(soon(CANCEL_CUTOFF_MS - 60_000)).reasons["canCancel"]).toBe(
      "too_close_to_departure",
    );
    expect(allowedActionsOf(soon(CANCEL_CUTOFF_MS + 60_000)).canCancel).toBe(true);
    expect(allowedActionsOf(soon(ANCILLARIES_CUTOFF_MS - 60_000)).reasons["canAddAncillaries"]).toBe(
      "too_close_to_departure",
    );
    // Further away, the extras are refused for the MVP's reason only.
    expect(allowedActionsOf(soon(ANCILLARIES_CUTOFF_MS + 60_000)).reasons["canAddAncillaries"]).toBe(
      "disabled_by_ota",
    );
  });

  it("refuses cancellation once a flight has departed, but keeps contacts and remarks until the last one landed", () => {
    const outboundFlown = input({
      segments: [
        { departureAt: at(-2 * DAY), arrivalAt: at(-2 * DAY + 2 * HOUR), isFlown: true },
        { departureAt: at(5 * DAY), arrivalAt: at(5 * DAY + 3 * HOUR), isFlown: false },
      ],
      lastArrivalAt: at(5 * DAY + 3 * HOUR),
    });

    const actions = allowedActionsOf(outboundFlown);

    expect(actions.reasons["canCancel"]).toBe("flown");
    expect(actions.reasons["canAddAncillaries"]).toBe("flown");
    expect(actions).toMatchObject({ canModifyContacts: true, canAddRemarks: true, canRefresh: true });
  });

  it("refuses every change of a trip whose last flight has landed, and still allows a refresh", () => {
    const flown = input({
      status: "ticketed",
      ticketingStatus: "issued",
      segments: [{ departureAt: at(-3 * DAY), arrivalAt: at(-3 * DAY + 2 * HOUR), isFlown: false }],
      lastArrivalAt: at(-3 * DAY + 2 * HOUR),
    });

    const actions = allowedActionsOf(flown);

    for (const action of ["canCancel", "canModifyContacts", "canAddRemarks", "canModifyTravelerDocuments"]) {
      expect(actions.reasons[action]).toBe("flown");
    }
    expect(actions.canRefresh).toBe(true);
    // Ticketed but no document generated yet.
    expect(actions.reasons["canDownloadDocuments"]).toBe("pending");
  });

  it("allows downloading once a document is ready", () => {
    expect(
      allowedActionsOf(input({ status: "ticketed", ticketingStatus: "issued", documentsReady: true })),
    ).toMatchObject({
      canDownloadDocuments: true,
    });
  });

  it("throttles a refresh for 60 s after the last one", () => {
    const recent = allowedActionsOf(input({ lastRefreshAt: at(-(REFRESH_THROTTLE_MS - 1000)) }));
    const older = allowedActionsOf(input({ lastRefreshAt: at(-REFRESH_THROTTLE_MS) }));

    expect(recent.canRefresh).toBe(false);
    expect(recent.reasons["canRefresh"]).toBe("throttled");
    expect(older.canRefresh).toBe(true);
  });
});

describe("the allowed actions of a booking that is not live", () => {
  it.each(["pending", "failed", "cancelled"] as const)(
    "allows nothing for a %s booking, with its state as the reason",
    (status) => {
      const actions = allowedActionsOf(
        input({ status, ticketingStatus: status === "pending" ? "pending" : "not_applicable" }),
      );

      for (const action of BOOKING_ACTIONS) {
        expect(actions[action]).toBe(false);
        expect(actions.reasons[action]).toBe(status);
      }
    },
  );

  it("allows nothing to refresh without an Amadeus order", () => {
    const actions = allowedActionsOf(input({ amadeusOrderId: null }));

    expect(actions.reasons["canRefresh"]).toBe("pending");
  });

  it("keeps the documents of a cancelled booking downloadable", () => {
    const actions = allowedActionsOf(
      input({ status: "cancelled", ticketingStatus: "not_applicable", documentsReady: true }),
    );

    expect(actions.canDownloadDocuments).toBe(true);
    expect(actions.reasons["canCancel"]).toBe("cancelled");
  });
});
