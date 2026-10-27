// The console actions of a booking (console-bookings.mapper.ts `consoleActionsOf`, OBE-061; FIX-W30-OTA): canCancel
// follows the departure rule console.bookings.cancel checks (bookings/allowed-actions.ts `cancelDepartureReasonOf`
// without the self-service window), so the OTA admin never offers a cancellation the API then refuses with `flown`.
// Before FIX-W30-OTA it waited for the last flight to land. Bookings are built relative to one `now`; pure function.
import { describe, expect, it } from "vitest";
import { CANCEL_CUTOFF_MS } from "../bookings/allowed-actions";
import { consoleActionsOf, type ConsoleActionsInput } from "./console-bookings.mapper";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const now = new Date();
const at = (offsetMs: number): Date => new Date(now.getTime() + offsetMs);

/** A confirmed round trip 30 days ahead, with an order, for a caller with every permission. */
function input(overrides: Partial<ConsoleActionsInput> = {}): ConsoleActionsInput {
  return {
    status: "confirmed",
    ticketingStatus: "pending",
    amadeusOrderId: "eJzTd9f3NjIJdgMADeQCtg",
    ticketingDeadlineAt: at(20 * DAY),
    lastArrivalAt: at(37 * DAY + 3 * HOUR),
    segments: [
      { departureAt: at(30 * DAY), isFlown: false },
      { departureAt: at(37 * DAY), isFlown: false },
    ],
    lastRefreshAt: null,
    now,
    can: () => true,
    ...overrides,
  };
}

describe("consoleActionsOf: canCancel (FIX-W30-OTA)", () => {
  it("[FIX-W30-OTA AC3] refuses a booking whose first flight departed but did not land, as console.bookings.cancel does", () => {
    for (const segments of [
      // Departed an hour ago and lands in an hour; the return is in 5 days.
      [
        { departureAt: at(-HOUR), isFlown: false },
        { departureAt: at(5 * DAY), isFlown: false },
      ],
      // Amadeus says the first flight is flown.
      [
        { departureAt: at(-DAY), isFlown: true },
        { departureAt: at(5 * DAY), isFlown: false },
      ],
    ]) {
      const actions = consoleActionsOf(input({ segments, lastArrivalAt: at(5 * DAY + 3 * HOUR) }));
      expect([actions.canCancel, actions.reasons["canCancel"]]).toEqual([false, "flown"]);
      // Nothing else depends on a departure: a patch and a note are still offered.
      expect(actions).toMatchObject({ canPatch: true, canAddNote: true });
    }
  });

  it("[FIX-W30-OTA AC3] offers it until the first departure: staff have no self-service window", () => {
    const soon = consoleActionsOf(
      input({
        segments: [{ departureAt: at(CANCEL_CUTOFF_MS - HOUR), isFlown: false }],
        lastArrivalAt: at(DAY),
      }),
    );
    expect([soon.canCancel, soon.reasons["canCancel"]]).toEqual([true, undefined]);
    expect(consoleActionsOf(input()).canCancel).toBe(true);
  });

  it("[FIX-W30-OTA AC3] gives the state and the permission first", () => {
    const departed = [{ departureAt: at(-HOUR), isFlown: false }];
    expect(consoleActionsOf(input({ segments: departed, status: "cancelled" })).reasons["canCancel"]).toBe(
      "cancelled",
    );
    expect(consoleActionsOf(input({ segments: departed, amadeusOrderId: null })).reasons["canCancel"]).toBe(
      "no_amadeus_order",
    );
    expect(
      consoleActionsOf(input({ segments: departed, can: (permission) => permission !== "bookings:cancel" }))
        .reasons["canCancel"],
    ).toBe("no_permission");
  });
});
