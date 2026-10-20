// The work limits of the OTA worker's scheduled jobs (OADR-0014 points 2 and 3, ota/docs/architecture.md §6; OBE-024).
// Everything here is a constant in code, never a variable (README §3): the per-job batch sizes of OADR-0014 point 2,
// how far one scheduler run lets a per-tenant job continue itself, and how the fan-out writes its jobs to Redis.
//
//   Work                          Per job   Who uses it
//   Booking sync                  20        bookings.sync_scan → booking.sync (M3)
//   Checkout expiry               50        checkouts.expire (M3)
//   Offer purge                   500       offers.purge (M2, shopping/offers-purge.processor.ts)
//   Notification outbox           100       notify (M3)
//
// A per-tenant job that filled its batch re-enqueues itself (fan-out.ts), at the back of `ota-maintenance`, so the
// other tenants' jobs run in between. MAX_CONTINUATIONS bounds how often one scheduler run does so for a tenant; what
// is left after that waits for the next run, as OADR-0014 says a backlog after an outage drains over several runs.

/** The largest batch of each kind of scheduled work, per job (OADR-0014 point 2). */
export const JOB_BATCH_LIMITS = Object.freeze({
  /** Bookings one `booking.sync` scan job enqueues per tenant (the 20 oldest synced active bookings). */
  bookingSync: 20,
  /** Checkouts one `checkouts.expire` job expires per tenant. */
  checkoutExpiry: 50,
  /** Expired searches one `offers.purge` job deletes per tenant (cascading to offers, upsells and priced offers). */
  searchPurge: 500,
  /** Outbox rows one `notify` job sends per tenant. */
  notificationOutbox: 100,
} as const);

/**
 * How many times one scheduler run lets a per-tenant job re-enqueue itself after a full batch: with the offer purge,
 * at most 500 × (1 + 20) searches per tenant per run (10,500 every 15 minutes). The next run continues from there.
 */
export const MAX_CONTINUATIONS = 20;

/** The fan-out adds its per-tenant jobs to Redis in chunks of this size (one `addBulk` round trip each). */
export const FAN_OUT_CHUNK = 100;
