# OADR-0014: Per-tenant workers and schedulers

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when more than about 300 active tenants make the per-tenant fan-out slow, or when per-group fairness needs BullMQ Pro.
**Revisions:** 2026-10-22 (lead decision (1), recording FIX-W26-BOOKINGS): point 6's claims lock the booking with `FOR NO KEY UPDATE SKIP LOCKED`, never `FOR UPDATE SKIP LOCKED`, and the booking documents serialise their own writes without a row lock on the booking (dated note under point 6). 2026-10-23 (lead decision (3), recording FIX-W27-SYNC): the in-progress marker of the booking sync's claim, which the refreshes share, is a column of the booking, not a booking event (dated note under point 6).

## Context

The OTA worker runs the jobs of [db README §6](../../../docs/velexis-sdk/db/README.md): checkout expiry, offer purge, booking sync, ticketing retries, notification outbox, queue polling, retention purges, plus the MVP's reconciliation and Stripe event processing. [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md) fixes BullMQ on the single Redis, job schedulers declared at start-up, small per-tenant jobs for fairness, bounded concurrency, ids-only payloads and idempotent handlers. Suspended tenants keep obligations to paid travellers ([PADR-0014](../../../platform/docs/adr/0014-tenant-suspension-and-resume.md)). The worker has a 512 MB memory budget ([architecture §3](../../../docs/mvp/architecture.md#3-hosts-ports-and-the-vm)).

## Decision

1. **Schedulers fan out, jobs do the work.** Each scheduler (`upsertJobScheduler`, declared in `jobs/schedulers.ts`) runs one small job that lists target tenants from the cached platform data (`status IN ('active','suspended')`), filters by what applies, and enqueues one job per tenant (or per booking) with a deterministic job id (`<task>:<tenantId>:<minute bucket>`), so overlapping runs do not duplicate work.
2. **Work per job is bounded**: at most 20 bookings for sync, 50 checkouts for expiry, 500 searches for purge, 100 outbox rows for notifications. A job that finds more re-enqueues itself.
3. **Queues and concurrency** are those of [`../architecture.md`](../architecture.md) §6 (2 to 4 per queue). Total concurrent jobs stay below the worker's database pool (10 connections) and memory budget.
4. **Suspended tenants**: checkout expiry, ticketing, sync, reconciliation, refunds, Stripe events and notifications for existing bookings continue; the queue poller and anything that starts new supplier activity skip them. `provisioning`, `failed` tenants are skipped entirely.
5. **Every processor** opens `tenantTx` itself (the job's tenant id is resolved to the schema through the same cache as the API), re-checks the current state of its rows, and exits early when nothing is due. Handlers never trust the payload beyond ids.
6. **Claims instead of long locks.** Work on one booking (ticketing, sync, reconcile, cancel money step) first claims it in a short transaction with `SELECT … FOR UPDATE SKIP LOCKED`, by writing an in-progress marker (for example `ticketing_status = 'in_progress'` and `ticketing_last_attempt_at = now()`, or `reconcile_attempts + 1`), and commits before any external call. Other workers and API requests (such as `console.bookings.issue`) skip or refuse a booking with a fresh claim; a claim older than 5 minutes counts as abandoned. The booking's `version` detects concurrent changes when the result is written.

   **2026-10-22 (lead decision (1), FIX-W26-BOOKINGS): the claim's lock mode.** Every claim of a booking (the ticketing job's and the reconciliation's inline issuance, the reconciliation's claim and the scan's adoption of stale claims, the booking sync of OBE-045, and any later `SKIP LOCKED` on `bookings`) locks it with `SELECT … FOR NO KEY UPDATE SKIP LOCKED`, never `FOR UPDATE SKIP LOCKED`. The insert of a row that references a booking (a booking event, an outbox row, a booking document, a ticket, a guest token, a refund) takes the booking's `FOR KEY SHARE` through its foreign key; `FOR UPDATE` conflicts with it, so a claim made in that moment skipped the booking and left it to the next scan (the ticketing scan runs every 5 minutes: a booking whose itinerary was being written stayed `confirmed` that long, commit 16c3ea9). `FOR NO KEY UPDATE` does not conflict with `FOR KEY SHARE`, and still conflicts with itself, `FOR SHARE` and `FOR UPDATE`, so a claim still skips a booking another claim or a writer that locked the booking holds. No claim's correctness relies on excluding key-share holders: a key-share holder can only add rows that reference the booking (or point a row at it), never change the booking row a claim reads and writes (it would need `FOR NO KEY UPDATE` or more, which waits for the claim); the ticketing and reconciliation results are written later in a transaction that locks the booking `FOR UPDATE` again, waits for such inserts and checks the claim's fencing token, and the adoption writes only the booking row and its own event. The claim's own update must leave the booking's key columns (`id`, `reference`, `checkout_id`) alone, or it would take `FOR UPDATE` itself. The booking documents never lock a booking `FOR UPDATE` (nor `FOR NO KEY UPDATE` or `FOR SHARE`): their writes of one booking are serialised by a transaction-level advisory lock keyed on the booking id (`pg_advisory_xact_lock`), and they read the booking's `version` `FOR KEY SHARE` and compare it with the version they rendered ([`../architecture-booking.md`](../architecture-booking.md) §1.1).

   **2026-10-23 (lead decision (3), FIX-W27-SYNC): the sync's in-progress marker.** The booking sync's claim, and the refreshes' (bookings.get with a refresh, console.bookings.get with `refresh=true`, console.bookings.resync), write their in-progress marker in a column, `bookings.sync_claimed_at`, as the ticketing job writes `ticketing_last_attempt_at`: never a booking event (until then a staff-only `booking.sync_requested`, about four a day per upcoming booking and one an hour near the ticketing deadline, which filled the console's timeline). The sync skips a booking claimed in the last 30 minutes (a failed read is tried again then), a refresh is throttled by the same column; the claim's update leaves `version`, `updated_at` and the key columns alone.
7. **Failures**: default `attempts: 5`, exponential backoff from 30 s; failed jobs kept 30 days; the platform admin's failed-job view and the on-VM check read their counts ([ADR-0016](../../../docs/mvp/adr/0016-observability.md)).
8. **Health**: `/health/ready` on port 4001 reports PostgreSQL, Redis and the age of the oldest waiting job per queue; the on-VM check alerts above 10 minutes.

## Consequences

### Positive

- One busy OTA cannot hold a queue for long; work is spread in small jobs.
- Overlapping scheduler runs and restarts are harmless.
- Suspension does not hurt travellers who already paid.
- Since 2026-10-22 a claim is never put off by a document being written or an event being inserted for its booking: only another claim or a writer of the booking makes it skip.

### Negative

- Fan-out jobs read the tenant list every minute; with hundreds of tenants this is many small jobs and Redis writes.
- Bounded batches mean a backlog drains over several runs after an outage.

### Follow-ups

- Measure queue latency in the M6 performance sanity check; split the worker into two processes (booking-critical and housekeeping) if one blocks the other.

## Alternatives considered

- **One job per scheduler run for all tenants.** Simpler, but one large tenant delays all others and a crash restarts everything.
- **Cron scripts outside the worker.** No retries, no visibility ([ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md)).
- **PostgreSQL `LISTEN/NOTIFY` triggers.** Ties work to database connections and does not survive restarts.
- **Claims with `FOR UPDATE SKIP LOCKED`** (the rule before 2026-10-22). It also skips a booking whose `FOR KEY SHARE` another transaction holds, the foreign-key lock of any insert of a child row, so a booking could wait a whole scan interval for a reason that does not concern the claim.
- **Keep `FOR UPDATE` in the documents' write and retry the skipped claims sooner.** The race stays, only shorter; a lock the documents do not need for their own rows would still hold up the booking's claims.

## References

- [db README §6](../../../docs/velexis-sdk/db/README.md), [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md), [ADR-0016](../../../docs/mvp/adr/0016-observability.md), [PADR-0014](../../../platform/docs/adr/0014-tenant-suspension-and-resume.md)
- [`../architecture.md`](../architecture.md) §6, [`../flows/ticketing-and-documents.md`](../flows/ticketing-and-documents.md)
