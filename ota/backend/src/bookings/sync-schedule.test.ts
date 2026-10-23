// The schedule of the background booking sync (OBE-045, FIX-W27-SYNC; sync-schedule.ts): when a booking is due again,
// which the console shows as ConsoleSupplierSync.nextScheduledSyncAt. The scan's SQL of the same rules runs against
// PostgreSQL in test/integration/bookings/sync.int.test.ts.
import { describe, expect, it } from "vitest";
import {
  BOOKING_SYNC_DEADLINE_INTERVAL_MS,
  BOOKING_SYNC_INTERVAL_MS,
  BOOKING_SYNC_RETRY_MS,
  nextScheduledSyncOf,
  syncIntervalOf,
  type SyncScheduleRow,
} from "./sync-schedule";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date("2026-03-02T10:00:00.000Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

/** A confirmed booking with an order, flying in 10 days, synchronised an hour ago, never claimed since. */
const row = (overrides: Partial<SyncScheduleRow> = {}): SyncScheduleRow => ({
  status: "confirmed",
  amadeusOrderId: "eJzTd9f",
  lastArrivalAt: at(240 * HOUR),
  ticketingDeadlineAt: null,
  lastSyncedAt: at(-HOUR),
  syncClaimedAt: null,
  ...overrides,
});

describe("nextScheduledSyncOf", () => {
  it("is 6 hours after the last synchronisation for an upcoming trip [FIX-W27-SYNC AC5]", () => {
    expect(nextScheduledSyncOf(row(), NOW)).toEqual(at(BOOKING_SYNC_INTERVAL_MS - HOUR));
    expect(nextScheduledSyncOf(row({ status: "ticketed" }), NOW)).toEqual(
      at(BOOKING_SYNC_INTERVAL_MS - HOUR),
    );
    // Overdue, or never synchronised: now (the next scan picks it up).
    expect(nextScheduledSyncOf(row({ lastSyncedAt: at(-7 * HOUR) }), NOW)).toEqual(NOW);
    expect(nextScheduledSyncOf(row({ lastSyncedAt: null }), NOW)).toEqual(NOW);
  });

  it("is hourly in the 24 hours before the ticketing deadline of a booking that waits for tickets [FIX-W27-SYNC AC5]", () => {
    const near = row({ ticketingDeadlineAt: at(20 * HOUR), lastSyncedAt: at(-10 * MINUTE) });
    expect(nextScheduledSyncOf(near, NOW)).toEqual(at(BOOKING_SYNC_DEADLINE_INTERVAL_MS - 10 * MINUTE));
    expect(syncIntervalOf(near, NOW)).toBe(BOOKING_SYNC_DEADLINE_INTERVAL_MS);
    // The deadline 30 hours away: 6-hourly until 24 hours before it, then hourly.
    const far = row({ ticketingDeadlineAt: at(30 * HOUR), lastSyncedAt: at(-10 * MINUTE) });
    expect(nextScheduledSyncOf(far, NOW)).toEqual(at(BOOKING_SYNC_INTERVAL_MS - 10 * MINUTE));
    const later = row({ ticketingDeadlineAt: at(26 * HOUR), lastSyncedAt: at(-10 * MINUTE) });
    expect(nextScheduledSyncOf(later, NOW)).toEqual(at(2 * HOUR));
    // A ticketed booking waits for no ticket: 6-hourly.
    const ticketed = row({
      status: "ticketed",
      ticketingDeadlineAt: at(20 * HOUR),
      lastSyncedAt: at(-10 * MINUTE),
    });
    expect(nextScheduledSyncOf(ticketed, NOW)).toEqual(at(BOOKING_SYNC_INTERVAL_MS - 10 * MINUTE));
  });

  it("is never within 30 minutes of the last claim, and null once the sync no longer reads the booking [FIX-W27-SYNC AC5]", () => {
    expect(
      nextScheduledSyncOf(row({ lastSyncedAt: at(-7 * HOUR), syncClaimedAt: at(-10 * MINUTE) }), NOW),
    ).toEqual(at(BOOKING_SYNC_RETRY_MS - 10 * MINUTE));
    expect(nextScheduledSyncOf(row({ status: "pending" }), NOW)).toBeNull();
    expect(nextScheduledSyncOf(row({ status: "cancelled" }), NOW)).toBeNull();
    expect(nextScheduledSyncOf(row({ amadeusOrderId: null }), NOW)).toBeNull();
    // The trip is over before the next synchronisation would come.
    expect(nextScheduledSyncOf(row({ lastArrivalAt: at(2 * HOUR) }), NOW)).toBeNull();
    expect(nextScheduledSyncOf(row({ lastArrivalAt: at(-HOUR) }), NOW)).toBeNull();
  });
});
