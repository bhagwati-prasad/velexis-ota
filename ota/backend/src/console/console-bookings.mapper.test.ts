// The console actions of a booking (console-bookings.mapper.ts `consoleActionsOf`, OBE-061; FIX-W30-OTA): canCancel
// follows the departure rule console.bookings.cancel checks (bookings/allowed-actions.ts `cancelDepartureReasonOf`
// without the self-service window), so the OTA admin never offers a cancellation the API then refuses with `flown`.
// Before FIX-W30-OTA it waited for the last flight to land. Bookings are built relative to one `now`; pure function.
//
// The cancellation mode of console.bookings.get (`consoleCancellationModeOf`, lead decision (2a) of 2026-10-30,
// FIX-W35-OTA): what console.bookings.cancel would ask Amadeus for, decided from the stored tickets in the OTA's
// `storefront_settings.time_zone`, the API's own clock, per mode and per zone; `null` where the cancellation refuses
// the booking whoever asks. Instants are built from the OTA's day around `now`, never a fixed calendar date.
import { describe, expect, it } from "vitest";
import { CANCEL_CUTOFF_MS } from "../bookings/allowed-actions";
import { localDayOf, type ModeTicket } from "../bookings/cancellation-mode";
import {
  consoleActionsOf,
  consoleCancellationModeOf,
  type ConsoleActionsInput,
  type ConsoleCancellationModeInput,
} from "./console-bookings.mapper";

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

describe("consoleActionsOf: a cancellation in progress (FIX-W33-OTA)", () => {
  it("[FIX-W33-OTA] [OBE-061] refuses canCancel with pending while a cancellation is undecided or another one's DELETE is in flight", () => {
    const pending = consoleActionsOf(input({ cancellationPending: true }));
    expect([pending.canCancel, pending.reasons["canCancel"]]).toEqual([false, "pending"]);
    // Nothing else waits for it: a patch, a note and a resync are still offered.
    expect(pending).toMatchObject({ canPatch: true, canAddNote: true, canRetrieve: true });
    // console.bookings.cancel's order of checks: the state and the permission, then pending, then the departure rule.
    const departed = [{ departureAt: at(-HOUR), isFlown: false }];
    expect(
      consoleActionsOf(input({ cancellationPending: true, segments: departed })).reasons["canCancel"],
    ).toBe("pending");
    expect(
      consoleActionsOf(input({ cancellationPending: true, status: "cancelled" })).reasons["canCancel"],
    ).toBe("cancelled");
    expect(
      consoleActionsOf(
        input({ cancellationPending: true, can: (permission) => permission !== "bookings:cancel" }),
      ).reasons["canCancel"],
    ).toBe("no_permission");
    expect(consoleActionsOf(input({ cancellationPending: false })).canCancel).toBe(true);
  });
});

describe("consoleCancellationModeOf: the API's clock for a same-day void (FIX-W35-OTA)", () => {
  /** The booking of `input()` as the cancellation mode reads it, unticketed, in `timeZone`. */
  function modeInput(overrides: Partial<ConsoleCancellationModeInput> = {}): ConsoleCancellationModeInput {
    return {
      status: "confirmed",
      amadeusOrderId: "eJzTd9f3NjIJdgMADeQCtg",
      segments: input().segments,
      ticketingStatus: "pending",
      tickets: [],
      timeZone: "UTC",
      now,
      ...overrides,
    };
  }

  /** The booking ticketed at `issuedAt` (one ticket per instant). */
  const ticketed = (...issuedAt: Array<Date | null>): Partial<ConsoleCancellationModeInput> => ({
    status: "ticketed",
    ticketingStatus: "issued",
    tickets: issuedAt.map((date): ModeTicket => ({ status: "ISSUED", issuedAt: date })),
  });

  it("[FIX-W35-OTA AC1] releases a booking without a ticket that holds a seat", () => {
    expect(consoleCancellationModeOf(modeInput())).toEqual({ mode: "release", voidDeadlineAt: null });
    expect(
      consoleCancellationModeOf(
        modeInput({
          ticketingStatus: "failed",
          tickets: [
            { status: "VOID", issuedAt: at(-3 * DAY) },
            { status: "REFUNDED", issuedAt: at(-3 * DAY) },
          ],
        }),
      ),
    ).toEqual({ mode: "release", voidDeadlineAt: null });
  });

  it("[FIX-W35-OTA AC1] voids tickets of today in the storefront's zone, until the next midnight there, in every zone", () => {
    for (const timeZone of [
      "UTC",
      "Europe/Oslo",
      "America/Los_Angeles",
      "Asia/Tokyo",
      "Pacific/Kiritimati",
    ]) {
      const today = localDayOf(now, timeZone);
      expect(consoleCancellationModeOf(modeInput({ ...ticketed(now, today.startsAt), timeZone }))).toEqual({
        mode: "void",
        voidDeadlineAt: today.endsAt.toISOString(),
      });
      // A ticket of the zone's yesterday, even an instant before its midnight, is a request to the airline.
      expect(
        consoleCancellationModeOf(
          modeInput({ ...ticketed(now, new Date(today.startsAt.getTime() - 1)), timeZone }),
        ),
      ).toEqual({ mode: "request_only", voidDeadlineAt: null });
    }
  });

  it("[FIX-W35-OTA AC1] decides by the storefront's zone, not by UTC: one instant is today in one zone and yesterday in another", () => {
    // The first instant of the day in Tokyo (UTC+9, no summer time) is still the previous day in Los Angeles.
    const tokyo = localDayOf(now, "Asia/Tokyo");
    const issuedAt = tokyo.startsAt;
    const inTokyo = consoleCancellationModeOf(modeInput({ ...ticketed(issuedAt), timeZone: "Asia/Tokyo" }));
    expect(inTokyo).toEqual({ mode: "void", voidDeadlineAt: tokyo.endsAt.toISOString() });
    const laDay = localDayOf(now, "America/Los_Angeles");
    const expected =
      issuedAt.getTime() >= laDay.startsAt.getTime() && issuedAt.getTime() < laDay.endsAt.getTime()
        ? { mode: "void", voidDeadlineAt: laDay.endsAt.toISOString() }
        : { mode: "request_only", voidDeadlineAt: null };
    expect(
      consoleCancellationModeOf(modeInput({ ...ticketed(issuedAt), timeZone: "America/Los_Angeles" })),
    ).toEqual(expected);
    // An unknown zone reads the day in UTC, as the cancellation does.
    const utc = localDayOf(now, "UTC");
    expect(
      consoleCancellationModeOf(modeInput({ ...ticketed(utc.startsAt), timeZone: "Mars/Olympus_Mons" })),
    ).toEqual({ mode: "void", voidDeadlineAt: utc.endsAt.toISOString() });
  });

  it("[FIX-W35-OTA AC1] makes a ticket of unknown issue time, or a ticketed state without tickets, a request", () => {
    expect(consoleCancellationModeOf(modeInput(ticketed(now, null)))).toEqual({
      mode: "request_only",
      voidDeadlineAt: null,
    });
    expect(consoleCancellationModeOf(modeInput({ status: "ticketed", ticketingStatus: "issued" }))).toEqual({
      mode: "request_only",
      voidDeadlineAt: null,
    });
  });

  it("[FIX-W35-OTA AC1] is null where console.bookings.cancel refuses the booking, and canCancel's reason agrees", () => {
    const departed = [{ departureAt: at(-HOUR), isFlown: false }];
    for (const refused of [
      { status: "cancelled" },
      { amadeusOrderId: null },
      { status: "pending", amadeusOrderId: null },
      { status: "failed", amadeusOrderId: null },
      { cancellationPending: true },
      { segments: departed },
    ] satisfies Partial<ConsoleCancellationModeInput>[]) {
      expect(consoleCancellationModeOf(modeInput({ ...ticketed(now), ...refused }))).toBeNull();
      expect(consoleActionsOf(input(refused)).canCancel).toBe(false);
    }
    // No self-service window: a booking 2 hours before its departure is still cancelled by the staff.
    const soon = [{ departureAt: at(CANCEL_CUTOFF_MS - HOUR), isFlown: false }];
    expect(consoleCancellationModeOf(modeInput({ segments: soon }))).toEqual({
      mode: "release",
      voidDeadlineAt: null,
    });
  });
});
