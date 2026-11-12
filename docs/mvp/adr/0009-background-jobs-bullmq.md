# ADR-0009: Background jobs with BullMQ

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (platform → OTA through a job queue), lead architect (BullMQ, queue layout, durability rules)
**Revisions:** 2026-10-12 (planning review): items 3 and 5 aligned with [PADR-0001](../../../platform/docs/adr/0001-tenant-provisioning-orchestration.md), [PADR-0014](../../../platform/docs/adr/0014-tenant-suspension-and-resume.md) and [OADR-0007](../../../ota/docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md): suspend and resume messages, a nullable `jobId` for deploy fan-out reports, one BullMQ job per attempt. 2026-11-11 (OBE-101, the bound it proposes under lead decision (17f) of 2026-11-11): item 7's completed jobs of `ota-maintenance`, the OTA schedulers' fan-outs and their per-tenant jobs, are kept 1 hour instead of 1 day, so Redis no longer holds a day of every active tenant's scheduled jobs; failed jobs and the other queues keep item 7 as it was (dated note under item 7).

## Context

[`decisions.md`](../decisions.md) §5 says the platform backend asks the OTA backend to provision or migrate a tenant schema **through a job queue**. The OTA side also has the scheduled and event-driven jobs listed in [db README §6](../../velexis-sdk/db/README.md):

- offer cache purge and checkout expiry;
- booking sync and the ticketing deadline monitor;
- the notification outbox and data exports;
- the queue poller and retention purges.

The platform side needs e-mails, Stripe Billing webhook processing, DNS checks for custom domains and reference data loading. Redis is already part of the stack.

## Decision

1. **BullMQ 5 on the single Redis 7** is the job system for both backends. Workers run in each backend's `worker.ts` process ([ADR-0003](0003-six-components-two-nestjs-backends.md)). The BullMQ key prefix is `vx`.
2. **Redis configuration** for BullMQ: `maxmemory-policy noeviction` and AOF with `appendfsync everysec`. Because nothing can be evicted, every cache key in the same Redis **must** have a TTL. A lint rule and code review check this.
3. **Cross-backend queues.** Their message contracts are versioned TypeScript types with JSON Schemas in `@velexis/api-types/jobs`, validated with Ajv on consumption.

   | Queue | Producer → consumer | Jobs |
   |---|---|---|
   | `ota-tenant-ops` | platform → OTA | `tenant.provision`, `tenant.migrate` (M1); `tenant.suspend`, `tenant.resume` (sent by the platform from M1, consumed by the OTA worker from M4, [PADR-0014](../../../platform/docs/adr/0014-tenant-suspension-and-resume.md)); `tenant.export`, `tenant.delete` (post-MVP) |
   | `platform-tenant-events` | OTA → platform | `tenant.provisioned`, `tenant.provision_failed`, `tenant.migrated`, `tenant.migration_failed` (M1); `tenant.suspended`, `tenant.resumed` (M4); usage events (post-MVP) |

   Every message carries `v` (contract version), `jobId`, `tenantId`, `requestedAt` and `requestId`. `jobId` is the `platform.provisioning_jobs.id` (`job_…`) of the request it answers. It is `null` only in the `tenant.migrated` and `tenant.migration_failed` reports that the deploy fan-out publishes (`tenants:report-migrations`), because no job row asked for them; the platform records those against the tenant ([OADR-0007](../../../ota/docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md) item 7).
4. **Internal queues** are owned by one backend and named `<owner>-<topic>`, for example `ota-notifications`, `ota-ticketing`, `ota-booking-sync`, `ota-maintenance`, `ota-stripe-events`, `platform-emails`, `platform-stripe-events`, `platform-domains`. The component plans fix the full list.
5. **Durability.** Redis is the transport, PostgreSQL is the record.
   - `platform.provisioning_jobs` is the durable state of provisioning, migration, suspension and resume requests. The platform backend inserts the row, and each dispatch attempt enqueues one BullMQ job with the id `<job_id>-<attempt>` ([PADR-0001](../../../platform/docs/adr/0001-tenant-provisioning-orchestration.md) items 3 and 6). A duplicate enqueue of the same attempt is a no-op; a retry after a reported failure is a new attempt and therefore a new BullMQ job.
   - A platform **reconciler** (every 5 minutes) dispatches due `queued` rows and checks `running` rows past `locked_until`: if BullMQ has no job `<job_id>-<attempt>` (or it failed without an event), the attempt counts as a retryable failure.
   - Webhook events are written to an inbox table before they are enqueued, and handlers look the event up by id ([ADR-0011](0011-payments-stripe-and-airline-card.md), [ADR-0013](0013-subscription-billing-stripe-billing.md)).
6. **Handlers are idempotent.**
   - Provisioning steps use `IF NOT EXISTS` and `ON CONFLICT DO NOTHING` (db README §3).
   - Event handlers check current state before applying a change.
7. **Retries.** The default is `attempts: 5`, exponential backoff from 30 s. Non-retryable errors (checksum mismatch, invalid input) throw an `UnrecoverableError`. Failed jobs are kept for 30 days (`removeOnFail: { age: 2592000 }`) and completed jobs for 1 day.
   - **2026-11-11 (OBE-101, the bound it proposes under lead decision (17f) of 2026-11-11): the completed jobs of `ota-maintenance` are kept 1 hour.** OBE-088 measured that the OTA schedulers' per-tenant jobs are most of what Redis keeps. A job holds 1 304 to 1 400 bytes, and every active tenant gets 5 258 of them a day from the 11 schedules (three run every minute): about 7 MiB a day per tenant. Kept a day, they fill `maxmemory` (512 MiB with `noeviction`, where Redis refuses BullMQ's writes) at about 60 active tenants ([`performance.md`](../../../ota/docs/performance.md) §6 item 4), against the ~300 tenants of [deployment §14](../deployment-single-vm.md#14-capacity-limits-of-one-vm).
     - **The bound.** Every job of `ota-maintenance` carries `removeOnComplete: { age: 3600 }` (`KEEP_COMPLETED_MAINTENANCE_JOBS` in `ota/backend/src/common/queues/queue-names.ts`): the scheduler iterations' `fan-out` jobs (their template), the per-tenant jobs and their continuations (`tenantJob`), and the worker's options for a job added without one. BullMQ removes a queue's completed jobs older than the age of each job that completes, at most 1 000 per completion. So the queue holds an hour of completed jobs: 219 per active tenant, about 0.3 MiB, and about 85 MiB for 300 tenants (measured by OBE-101: [`performance.md`](../../../ota/docs/performance.md) §7).
     - **The deduplication stays.** Only another run of the same scheduler iteration builds a per-tenant id `<task>:<tenantId>:<minute bucket>` (with `-<n>` for a continuation) again: a fan-out retried after it failed half-way, a stalled job run again, or a per-tenant job retried after it added its continuation. Those runs come within this item's backoffs (30 + 60 + 120 + 240 s = 7.5 minutes) and the waits for a worker, which the on-VM check alerts on above 10 minutes each ([OADR-0014](../../../ota/docs/adr/0014-per-tenant-workers-and-schedulers.md) point 8). That is at most 7.5 + 4 × 10 = 47.5 minutes after the jobs completed before an alert, within the hour. A bound by count would not keep this: the last 1 000 jobs of `ota-maintenance` are less than 7.5 minutes of its jobs once about 35 tenants are active. No scheduler builds an earlier iteration's ids, since each iteration has its own due minute, so an id the hour has removed comes back only from a run of its own iteration that waited longer than the alerts allow (a worker held up for more than an hour). That tenant's job then runs once more for the iteration, as one more iteration of its schedule would: harmless, because the handlers re-check their rows and exit when nothing is due (item 6, [OADR-0014](../../../ota/docs/adr/0014-per-tenant-workers-and-schedulers.md) point 5).
     - **Unchanged.** Failed jobs of every queue are kept 30 days: the platform admin's failed-job view, `/health/ready` (`failedLastHour`) and the on-VM check read them. The other OTA queues keep their completed jobs a day. Their jobs follow the bookings, e-mails, documents and Stripe events, not the number of tenants. Their fixed ids rely on the day: the Stripe event ids, the payments' `payment-void-<pay_id>`, `capture-retry-<pay_id>` and `refund-submit-<rfd_id>` (the safety nets are removed once completed, as before), the notifications' sweep and wake jobs (`notify:<tenantId>:<bucket>`, `notify:<tenantId>:w<step>`), and the ticketing and reconciliation jobs of a booking. The platform backend's queues keep this item as written.
     - **At the deploy that brings it,** the first maintenance jobs that complete remove the queue's older completed jobs, 1 000 per completion, so the day kept until then is gone within minutes.
8. **Schedules** use BullMQ job schedulers (`upsertJobScheduler`), declared in code at worker start-up. A scheduler job for a per-tenant task fans out one job per active tenant, as db README §6 describes.
9. **Fairness.** OSS BullMQ has no per-group concurrency. Workers use bounded concurrency per queue (default 4), and per-tenant work is enqueued as small, separate jobs, so one OTA cannot hold a queue for long. Amadeus calls also pass the per-tenant rate limiter ([ADR-0012](0012-amadeus-account-model.md)).
10. **Payload rules.** Messages carry ids and small parameters only. **Never secrets, card data, tokens or traveller documents.** The airline-card path is synchronous and never touches a queue ([ADR-0011](0011-payments-stripe-and-airline-card.md)).
11. **Visibility.**
    - The platform admin shows provisioning jobs and failed jobs of both backends (M1). It reads BullMQ state through the platform API, not by connecting a UI to Redis.
    - Queue depth and failure counts feed the health checks ([ADR-0016](0016-observability.md)).

## Consequences

### Positive

- One proven library and one Redis for queues, schedules, caches and handoffs.
- The platform-to-OTA boundary is explicit, typed and versioned.
- A lost Redis message cannot lose a provisioning request, because PostgreSQL holds the request and the reconciler replays it.

### Negative

- `noeviction` means a Redis memory leak stops writes instead of evicting keys. Memory alerts and TTL discipline are required.
- Contract changes on cross-backend queues must be backward compatible for one release, or both backends must deploy together. The deploy script restarts workers first, so new consumers are running before new producers.

### Follow-ups

- Decided during planning; revisit when job volume needs a separate Redis for queues (for example, when cache memory pressure appears), or when per-tenant fairness needs BullMQ Pro groups.

## Alternatives considered

- **PostgreSQL-only queues** (`FOR UPDATE SKIP LOCKED`, pg-boss, Graphile Worker). Fewer moving parts, and db README §3 sketches a lease query. But `decisions.md` §5 names a job queue between the backends, Redis is already present, and BullMQ has better tooling for schedules and retries. We keep `provisioning_jobs` as the durable record.
- **RabbitMQ or NATS.** Another service to run on the VM.
- **Cron + scripts.** No retries, no visibility, no event-driven jobs.

## References

- [`../decisions.md`](../decisions.md) §5
- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §3 (provisioning steps), §6 (jobs per tenant)
- [ADR-0003](0003-six-components-two-nestjs-backends.md), [ADR-0004](0004-postgresql-schema-per-tenant.md)
- [`../architecture.md`](../architecture.md), flow (a)
