-- velexis:phase expand
-- Bookings: the synchronisation claim as a column (no more booking.sync_requested events) and the last sync's changes.

-- Lead decision (3) of 2026-10-23 (FIX-W27-SYNC, OADR-0003 follow-ups, OADR-0014 point 6): the background sync and the
-- refreshes (bookings.get with refresh, console.bookings.get with refresh, console.bookings.resync) claimed a booking by
-- appending a staff-only `booking.sync_requested` event, about four a day per upcoming booking and one an hour near the
-- ticketing deadline, which filled the console's timeline of 100 events. The claim is this column now; the events
-- written before stay as they are (no backfill: a claim recorded as an event in the half hour before the upgrade is not
-- seen, so a booking may be synchronised once more right after it).
ALTER TABLE bookings ADD COLUMN sync_claimed_at timestamptz;

-- The diff of the last synchronisation that recorded an order (order-diff.ts), whichever path read it: the console's
-- ConsoleSupplierSync.differences.
ALTER TABLE bookings ADD COLUMN sync_changes jsonb NOT NULL DEFAULT '[]'::jsonb
  CONSTRAINT bookings_sync_changes_ck CHECK (jsonb_typeof(sync_changes) = 'array');

COMMENT ON COLUMN bookings.sync_claimed_at IS 'When a synchronisation with Flight Order Management was last claimed (background sync, refresh, console resync): the sync skips the booking for 30 minutes after it, a refresh is throttled by it; replaces the booking.sync_requested events.';
COMMENT ON COLUMN bookings.sync_changes IS 'What the last recorded synchronisation changed ([{path, label, before, after}], JSON pointers into the booking): ConsoleSupplierSync.differences.';
