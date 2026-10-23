// When the background booking sync (OBE-045, booking-sync.service.ts) reads a booking's order again: the schedule the
// scan's query (BookingSyncRepository.dueBookingIds), the claim's check (syncClaimSkip) and the console's
// ConsoleSupplierSync.nextScheduledSyncAt (console/console-bookings.mapper.ts) share, without any I/O.
//
// A `confirmed`, `ticketed` or `partially_ticketed` booking with an Amadeus order whose trip is not over is due once it
// was last synchronised BOOKING_SYNC_INTERVAL_MS (6 hours: the document's "every 6 h for upcoming trips", Booking
// .syncStatus `fresh`) ago or more, or never; one that still waits for tickets (`confirmed`, `partially_ticketed`) is
// due BOOKING_SYNC_DEADLINE_INTERVAL_MS (1 hour) after its last synchronisation in the BOOKING_SYNC_DEADLINE_WINDOW_MS
// (24 hours) before its `ticketing_deadline_at` (the document's "hourly in the 24 h before the ticketing deadline").
// Either way not within BOOKING_SYNC_RETRY_MS (30 minutes) of the last claim of a synchronisation
// (`bookings.sync_claimed_at`, lead decision (3) of 2026-10-23: the sync's and the refreshes' claim, which was a
// `booking.sync_requested` event before FIX-W27-SYNC), so an attempt in progress is never doubled and a failed one is
// tried again half an hour later. A suspended tenant's unpaid bookings are left out by the scan (OADR-0008 point 8).
/** How long a synchronisation keeps a booking from being synchronised again (see the file header). */
export const BOOKING_SYNC_INTERVAL_MS = 6 * 60 * 60_000;

/** The same in the 24 h before the ticketing deadline of a booking that waits for tickets (see the file header). */
export const BOOKING_SYNC_DEADLINE_INTERVAL_MS = 60 * 60_000;

/** How long before its ticketing deadline a booking that waits for tickets is synchronised hourly. */
export const BOOKING_SYNC_DEADLINE_WINDOW_MS = 24 * 60 * 60_000;

/** How long a claim of a synchronisation (an attempt, in progress or failed) keeps the booking out (see the header). */
export const BOOKING_SYNC_RETRY_MS = 30 * 60_000;

/** The booking statuses the sync keeps current: those with an order that is not cancelled (`pending` is reconciled). */
export const BOOKING_SYNC_STATUSES = ["confirmed", "ticketed", "partially_ticketed"] as const;

/** The statuses among BOOKING_SYNC_STATUSES of a booking that still waits for (some of) its tickets. */
export const AWAITING_TICKETS_STATUSES = ["confirmed", "partially_ticketed"] as const;

/** Whether the sync keeps a booking of this status current. */
export const isSyncStatus = (status: string): boolean =>
  (BOOKING_SYNC_STATUSES as readonly string[]).includes(status);

const awaitsTickets = (status: string): boolean =>
  (AWAITING_TICKETS_STATUSES as readonly string[]).includes(status);

/** What the schedule reads of a booking. */
export interface SyncScheduleRow {
  readonly status: string;
  readonly amadeusOrderId: string | null;
  readonly lastArrivalAt: Date;
  readonly ticketingDeadlineAt: Date | null;
  readonly lastSyncedAt: Date | null;
  /** `bookings.sync_claimed_at`: the last claim of a synchronisation (the sync's or a refresh's). */
  readonly syncClaimedAt: Date | null;
}

/**
 * How long after its last synchronisation a booking is due again at `now` (see the file header): an hour for one that
 * waits for tickets (`confirmed`, `partially_ticketed`) whose ticketing deadline is in the next 24 hours, else 6 hours.
 * dueBookingIds runs the same rule in SQL.
 */
export function syncIntervalOf(
  row: Pick<SyncScheduleRow, "status" | "ticketingDeadlineAt">,
  now: Date,
): number {
  const left =
    row.ticketingDeadlineAt === null ? undefined : row.ticketingDeadlineAt.getTime() - now.getTime();
  return left !== undefined &&
    left > 0 &&
    left <= BOOKING_SYNC_DEADLINE_WINDOW_MS &&
    awaitsTickets(row.status)
    ? BOOKING_SYNC_DEADLINE_INTERVAL_MS
    : BOOKING_SYNC_INTERVAL_MS;
}

/**
 * When the background sync is due for the booking next, at `now` or later (ConsoleSupplierSync.nextScheduledSyncAt;
 * the scan of every 10 minutes then picks it up): the earliest instant at which the rules of the file header hold, or
 * `null` when the sync no longer reads the booking (no order, not active, the trip over by then). The scan leaves out a
 * suspended tenant's unpaid bookings, which this does not know.
 */
export function nextScheduledSyncOf(row: SyncScheduleRow, now: Date): Date | null {
  if (!isSyncStatus(row.status) || row.amadeusOrderId === null) {
    return null;
  }
  const end = row.lastArrivalAt.getTime();
  // Never before now, nor within 30 minutes of the last claim.
  const earliest = Math.max(
    now.getTime(),
    row.syncClaimedAt === null
      ? Number.NEGATIVE_INFINITY
      : row.syncClaimedAt.getTime() + BOOKING_SYNC_RETRY_MS,
  );
  const synced = row.lastSyncedAt?.getTime();
  // Every 6 hours (never synchronised: at once).
  const candidates = [
    Math.max(earliest, synced === undefined ? earliest : synced + BOOKING_SYNC_INTERVAL_MS),
  ];
  // Hourly in the 24 hours before the ticketing deadline, while tickets are awaited.
  if (row.ticketingDeadlineAt !== null && awaitsTickets(row.status)) {
    const deadline = row.ticketingDeadlineAt.getTime();
    const hourly = Math.max(
      earliest,
      deadline - BOOKING_SYNC_DEADLINE_WINDOW_MS,
      synced === undefined ? earliest : synced + BOOKING_SYNC_DEADLINE_INTERVAL_MS,
    );
    if (hourly < deadline) {
      candidates.push(hourly);
    }
  }
  const next = Math.min(...candidates);
  return next < end ? new Date(next) : null;
}
