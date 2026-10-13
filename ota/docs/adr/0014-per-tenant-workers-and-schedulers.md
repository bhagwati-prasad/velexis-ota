# OADR-0014: Per-tenant workers and schedulers

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when more than about 300 active tenants make the per-tenant fan-out slow, or when per-group fairness needs BullMQ Pro.

## Context

The OTA worker runs the jobs of [db README §6](../../../docs/velexis-sdk/db/README.md): checkout expiry, offer purge, booking sync, ticketing retries, notification outbox, queue polling, retention purges, plus the MVP's reconciliation and Stripe event processing. [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md) fixes BullMQ on the single Redis, job schedulers declared at start-up, small per-tenant jobs for fairness, bounded concurrency, ids-only payloads and idempotent handlers. Suspended tenants keep obligations to paid travellers ([PADR-0014](../../../platform/docs/adr/0014-tenant-suspension-and-resume.md)). The worker has a 512 MB memory budget ([architecture §3](../../../docs/mvp/architecture.md#3-hosts-ports-and-the-vm)).

## Decision

1. **Schedulers fan out, jobs do the work.** Each scheduler (`upsertJobScheduler`, declared in `jobs/schedulers.ts`) runs one small job that lists target tenants from the cached platform data (`status IN ('active','suspended')`), filters by what applies, and enqueues one job per tenant (or per booking) with a deterministic job id (`<task>:<tenantId>:<minute bucket>`), so overlapping runs do not duplicate work.
2. **Work per job is bounded**: at most 20 bookings for sync, 50 checkouts for expiry, 500 searches for purge, 100 outbox rows for notifications. A job that finds more re-enqueues itself.
3. **Queues and concurrency** are those of [`../architecture.md`](../architecture.md) §6 (2 to 4 per queue). Total concurrent jobs stay below the worker's database pool (10 connections) and memory budget.
4. **Suspended tenants**: checkout expiry, ticketing, sync, reconciliation, refunds, Stripe events and notifications for existing bookings continue; the queue poller and anything that starts new supplier activity skip them. `provisioning`, `failed` tenants are skipped entirely.
5. **Every processor** opens `tenantTx` itself (the job's tenant id is resolved to the schema through the same cache as the API), re-checks the current state of its rows, and exits early when nothing is due. Handlers never trust the payload beyond ids.
6. **Claims instead of long locks.** Work on one booking (ticketing, sync, reconcile, cancel money step) first claims it in a short transaction with `SELECT … FOR UPDATE SKIP LOCKED`, by writing an in-progress marker (for example `ticketing_status = 'in_progress'` and `ticketing_last_attempt_at = now()`, or `reconcile_attempts + 1`), and commits before any external call. Other workers and API requests (such as `console.bookings.issue`) skip or refuse a booking with a fresh claim; a claim older than 5 minutes counts as abandoned. The booking's `version` detects concurrent changes when the result is written.
7. **Failures**: default `attempts: 5`, exponential backoff from 30 s; failed jobs kept 30 days; the platform admin's failed-job view and the on-VM check read their counts ([ADR-0016](../../../docs/mvp/adr/0016-observability.md)).
8. **Health**: `/health/ready` on port 4001 reports PostgreSQL, Redis and the age of the oldest waiting job per queue; the on-VM check alerts above 10 minutes.

## Consequences

### Positive

- One busy OTA cannot hold a queue for long; work is spread in small jobs.
- Overlapping scheduler runs and restarts are harmless.
- Suspension does not hurt travellers who already paid.

### Negative

- Fan-out jobs read the tenant list every minute; with hundreds of tenants this is many small jobs and Redis writes.
- Bounded batches mean a backlog drains over several runs after an outage.

### Follow-ups

- Measure queue latency in the M6 performance sanity check; split the worker into two processes (booking-critical and housekeeping) if one blocks the other.

## Alternatives considered

- **One job per scheduler run for all tenants.** Simpler, but one large tenant delays all others and a crash restarts everything.
- **Cron scripts outside the worker.** No retries, no visibility ([ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md)).
- **PostgreSQL `LISTEN/NOTIFY` triggers.** Ties work to database connections and does not survive restarts.

## References

- [db README §6](../../../docs/velexis-sdk/db/README.md), [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md), [ADR-0016](../../../docs/mvp/adr/0016-observability.md), [PADR-0014](../../../platform/docs/adr/0014-tenant-suspension-and-resume.md)
- [`../architecture.md`](../architecture.md) §6, [`../flows/ticketing-and-documents.md`](../flows/ticketing-and-documents.md)
