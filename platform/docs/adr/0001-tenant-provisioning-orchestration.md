# PADR-0001: Tenant provisioning orchestration

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when provisioning needs more steps on the OTA side than one transaction, or when more than one platform worker process runs.
**Revisions:** 2026-10-12 (planning review): the OTA worker provisions as `velexis_provisioner` ([ADR-0004](../../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md) revision); point 7 makes the effect of a failure depend on the job kind, so only a `provision` job can set a tenant `failed`. 2026-10-29 (lead decision (1m), recording FIX-W33-OTA): a dated note under point 7, the OTA worker handles `tenant.suspend` and `tenant.resume` since OBE-074, so the interim case of point 7 (no OTA consumer yet) is over. Docs only.

## Context

[`decisions.md`](../../../docs/mvp/decisions.md) §5 says the platform backend never writes tenant schemas and asks the OTA backend to provision or migrate one through a job queue. [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md) fixes the queues (`ota-tenant-ops`, `platform-tenant-events`), PostgreSQL as the durable record (`platform.provisioning_jobs`) and a reconciler. [db README §3](../../../docs/velexis-sdk/db/README.md) describes the provisioning steps for a single app. ADR-0013 adds that, from M5, provisioning starts only after Checkout. What remained open: who dispatches, how attempts and retries are counted across two backends, which steps run where, and how the platform knows a job is lost.

## Decision

1. **Ownership of steps.**

   | Steps | Runs in | Why |
   |---|---|---|
   | `create_schema`, `run_migrations`, `seed_defaults` | OTA worker, one transaction as `velexis_provisioner` | The OTA backend owns tenant schemas |
   | `record_migrations`, `assign_amadeus_office`, `create_payment_connection`, `issue_api_keys`, `activate`, `notify` | Platform worker, after `tenant.provisioned` | They write platform tables |

2. **Dispatch gate.** A `provision` job is dispatched only when the tenant is `provisioning` and its current subscription is `trialing`, `active` or manual. The job row is created with the tenant (as architecture flow (a) shows) and waits `queued` until the gate opens.
3. **Dispatch** is a conditional update (`queued` → `running`, `attempt + 1`, `locked_until = now() + 15 min`) followed, after commit, by `queue.add` with BullMQ job id `<job_id>-<attempt>`. A concurrent second dispatch updates no row and enqueues nothing. A re-dispatch after a failure is a new BullMQ job; a duplicate add of the same attempt is a no-op.
4. **Two retry layers, one budget.** BullMQ retries transient errors inside one attempt (3 tries, 30 s exponential). The OTA worker reports only the final result of the attempt. The platform counts **attempts** (`max_attempts = 5`) and re-queues with `scheduled_at = now() + 30 s × 2^attempt` when the OTA reports `retryable = true`.
5. **Events are idempotent and ordered by attempt.** The consumer ignores events for finished jobs and for attempts older than the current one. Post-steps are individually idempotent and logged in `provisioning_jobs.steps`; a crash resumes at the first unfinished step.
6. **Reconciler** (every 5 minutes): dispatch due `queued` jobs whose gate is open; for `running` jobs past `locked_until`, ask BullMQ for `<job_id>-<attempt>`: waiting, active or delayed → extend the lease; missing or failed without an event → treat as a retryable failure. It never touches jobs younger than their lease.
7. **Failure.** Non-retryable errors or an exhausted budget mark the **job** `failed`. What happens next depends on the job kind:

   | Kind | Effect on the tenant | Notices |
   |---|---|---|
   | `provision` | Tenant `failed` (it was `provisioning`) | `ops.alert`, owner e-mail `tenant.provisioning_failed` |
   | `migrate` | None; `tenants.status` and `schema_version` stay as they are | `ops.alert` |
   | `suspend`, `resume` | None; the status switch already took effect ([PADR-0014](0014-tenant-suspension-and-resume.md)) | `ops.alert` |

   Only a `provision` job ever writes `tenants.status = 'failed'`, and only from `provisioning`, so a lost or rejected `tenant.suspend` can never turn a suspended tenant into a failed one. This matters until the OTA consumer for `tenant.suspend` and `tenant.resume` exists: the OTA worker rejects unknown job names as unrecoverable, and the reconciler then counts the job as failed. Retries by owners (portal) or admins create a **new** job row; failed rows stay as history. A failed tenant's schema is never dropped automatically (db README §3).

   **2026-10-29 (lead decision (1m), FIX-W33-OTA): the OTA consumer exists.** Since OBE-074 the OTA worker handles `tenant.suspend` and `tenant.resume` on `ota-tenant-ops` ([OADR-0007](../../../ota/docs/adr/0007-tenant-migration-runner-and-provisioning-worker.md) point 8, `ota/backend/src/provisioning/housekeeping.service.ts`): it re-reads the tenant, expires the open checkouts and writes the staff cut-off on a suspension, removes the cut-off on a resume, and answers `tenant.suspended` and `tenant.resumed`; a message that no longer matches the tenant's status is a no-op it still answers ([PADR-0014](0014-tenant-suspension-and-resume.md) item 7). Such a job is no longer rejected as an unknown job name. It still ends `failed` with an `ops.alert` when the OTA worker is down through every attempt or its housekeeping keeps failing, and the table above still holds: the tenant keeps its status, since only a `provision` job writes `failed`.
8. **Other job kinds** reuse the same machinery: `migrate` (admin), `suspend` and `resume` ([PADR-0014](0014-tenant-suspension-and-resume.md)). `export` and `delete` stay post-MVP.
9. **Message contracts** live in `@velexis/api-types/jobs` with JSON Schemas: every message has `v`, `jobId`, `tenantId`, `requestedAt`, `requestId`; payloads carry ids only ([`../architecture.md`](../architecture.md) §6.1).

## Consequences

### Positive

- One durable record (`provisioning_jobs`) explains every tenant's setup, retries and failures, and feeds the admin and the portal progress page.
- Lost Redis messages, crashed workers and duplicate events all converge to the same result.
- The M5 Checkout gate needs no new job state.

### Negative

- Provisioning crosses two processes and two queues; a bug in either shows up as a stuck `running` job until the lease ends (15 minutes).
- The OTA side must keep its transaction idempotent and report `retryable` honestly.

### Follow-ups

- The OTA plan implements the `tenant.provision` consumer and the event producer; the platform plan implements dispatch, consumer, post-steps and reconciler (M1).
- Add an alert when a job stays `running` across two leases.

## Alternatives considered

- **Platform worker leases jobs from PostgreSQL (`FOR UPDATE SKIP LOCKED`) and calls the OTA by HTTP.** Rejected: no synchronous HTTP between backends ([ADR-0003](../../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md)).
- **OTA worker writes `provisioning_jobs` directly.** Rejected: the OTA role is read-only on platform tables.
- **One BullMQ job id per job (no attempt suffix).** A failed BullMQ job kept for 30 days would block every re-dispatch.
- **Creating the job only after Checkout.** Possible, but the job row at creation time gives the portal and admin one place to see "waiting for payment".

## References

- [ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md), [ADR-0013](../../../docs/mvp/adr/0013-subscription-billing-stripe-billing.md), [ADR-0004](../../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md)
- [db README §3](../../../docs/velexis-sdk/db/README.md)
- [`../flows/provisioning.md`](../flows/provisioning.md), [`../architecture.md`](../architecture.md) §5–§6
