// The queues of the OTA backend (OBE-002; ota/docs/architecture.md §6, ADR-0009). The names come from
// `@velexis/api-types/jobs`, where both backends read them (`OTA_QUEUES`, `PLATFORM_TENANT_EVENTS`); this file adds what
// only the OTA backend decides: the worker concurrency of each queue it consumes and the job defaults of ADR-0009.
import {
  BULLMQ_PREFIX,
  OTA_QUEUES,
  OTA_TENANT_OPS,
  PLATFORM_TENANT_EVENTS,
  type OtaQueueName,
} from "@velexis/api-types/jobs";
import type { DefaultJobOptions, KeepJobs } from "bullmq";

export { BULLMQ_PREFIX, OTA_QUEUES, OTA_TENANT_OPS, PLATFORM_TENANT_EVENTS, type OtaQueueName };

/** The queues the OTA worker consumes, by topic, so code never spells a queue name. */
export const OTA_QUEUE = Object.freeze({
  /** Platform → OTA worker: `tenant.provision`, `tenant.migrate`, `tenant.suspend`, `tenant.resume`. */
  tenantOps: OTA_TENANT_OPS,
  /** Webhook receiver → worker: `stripe.event {tenantId, paymentEventId}`. */
  stripeEvents: "ota-stripe-events",
  /** API, schedulers → worker: `payment.void`, `payment.capture_retry`, `refund.submit`. */
  payments: "ota-payments",
  /** API, schedulers → worker: `booking.reconcile`, `booking.sync`, `booking.cancellation_check`. */
  bookings: "ota-bookings",
  /** API, schedulers → worker: `ticketing.issue`. */
  ticketing: "ota-ticketing",
  /** API (after commit), sweep → worker: `notify {tenantId}` drains that tenant's outbox. */
  notifications: "ota-notifications",
  /** Bookings → worker: `document.render`. */
  documents: "ota-documents",
  /** Schedulers → worker: per-tenant fan-out and purge jobs. */
  maintenance: "ota-maintenance",
} as const satisfies Record<string, OtaQueueName>);

/** Worker concurrency of each queue the OTA worker consumes (architecture §6). */
export const OTA_QUEUE_CONCURRENCY: Readonly<Record<OtaQueueName, number>> = Object.freeze({
  "ota-tenant-ops": 2,
  "ota-stripe-events": 4,
  "ota-payments": 4,
  "ota-bookings": 4,
  "ota-ticketing": 2,
  "ota-notifications": 4,
  "ota-documents": 2,
  "ota-maintenance": 2,
});

/**
 * Every queue a process of this backend opens: the eight it consumes and `platform-tenant-events`, which the worker
 * produces for the platform (the provisioning reports). QueuesModule registers them all.
 */
export const OTA_BACKEND_QUEUES = Object.freeze([...OTA_QUEUES, PLATFORM_TENANT_EVENTS] as const);

/** A queue this backend opens. */
export type OtaBackendQueueName = (typeof OTA_BACKEND_QUEUES)[number];

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/** Failed jobs are kept 30 days, for the admin queue views and investigations (ADR-0009 item 7). */
export const KEEP_FAILED_JOBS: KeepJobs = Object.freeze({ age: 30 * DAY_SECONDS });
/** Completed jobs are kept 1 day (ADR-0009 item 7); those of `ota-maintenance` 1 hour (below). */
export const KEEP_COMPLETED_JOBS: KeepJobs = Object.freeze({ age: DAY_SECONDS });

/**
 * The completed jobs of `ota-maintenance`, the schedulers' `fan-out` jobs and their per-tenant jobs, are kept 1 hour
 * (ADR-0009 item 7, revision of 2026-11-11, OBE-101). Every active tenant adds about 5 260 of them a day, so a day of
 * them grew Redis's memory with the tenants (ota/docs/performance.md §6 item 4); an hour of them keeps a tenant's at
 * about 0.3 MiB. The hour keeps the deduplication of their deterministic ids (`<task>:<tenantId>:<bucket>`,
 * jobs/fan-out.ts): only a run of the same scheduler iteration builds an id again (a retried fan-out, a stalled job, a
 * retried job that adds its continuation again), and it comes within the backoffs (RETRY_BACKOFF_TOTAL_SECONDS,
 * 7.5 minutes) and the waits for a worker, which the on-VM check alerts on above 10 minutes each: 47.5 minutes at most
 * before an alert. BullMQ removes a queue's completed jobs older than the age of each job that completes, so every
 * job of the queue carries this one.
 */
export const KEEP_COMPLETED_MAINTENANCE_JOBS: KeepJobs = Object.freeze({ age: HOUR_SECONDS });

/** The attempts of a job and the first delay of their exponential backoff (ADR-0009 item 7). */
const ATTEMPTS = 5;
const BACKOFF_DELAY_MS = 30_000;

/**
 * The backoffs of a job's retries added up: 30 + 60 + 120 + 240 s = 7.5 minutes. A job's last attempt is due this long
 * after its first failed, plus the time the attempts ran and waited for a worker.
 */
export const RETRY_BACKOFF_TOTAL_SECONDS =
  Array.from({ length: ATTEMPTS - 1 }, (_, retry) => BACKOFF_DELAY_MS * 2 ** retry).reduce(
    (a, b) => a + b,
    0,
  ) / 1000;

/**
 * The options of every job this backend adds (ADR-0009 item 7): 5 attempts, exponential backoff from 30 s
 * (30 s, 60 s, 120 s, 240 s), failed jobs kept 30 days and completed ones 1 day. A producer overrides them only with
 * a reason (for example the job id of a provisioning report, or the hour of `ota-maintenance`'s completed jobs). An
 * `UnrecoverableError` ends the attempts at once.
 */
export const DEFAULT_JOB_OPTIONS: Readonly<DefaultJobOptions> = Object.freeze({
  attempts: ATTEMPTS,
  backoff: Object.freeze({ type: "exponential", delay: BACKOFF_DELAY_MS }),
  removeOnFail: KEEP_FAILED_JOBS,
  removeOnComplete: KEEP_COMPLETED_JOBS,
});

/** How long the completed jobs of `queue` are kept: 1 hour for `ota-maintenance`, 1 day for the others. */
export function keepCompletedJobs(queue: OtaQueueName): KeepJobs {
  return queue === OTA_QUEUE.maintenance ? KEEP_COMPLETED_MAINTENANCE_JOBS : KEEP_COMPLETED_JOBS;
}

/** What a processor of this backend passes to `@Processor(queue, …)`. */
export interface OtaWorkerOptions {
  readonly concurrency: number;
  /** The retention of ADR-0009 also for jobs whose producer set none (the platform's `tenant.*` jobs). */
  readonly removeOnFail: KeepJobs;
  readonly removeOnComplete: KeepJobs;
}

/**
 * The worker options of a queue the OTA worker consumes: its concurrency and the retention of ADR-0009
 * (`keepCompletedJobs`). BullMQ applies them only to a job added without its own `removeOnFail` or
 * `removeOnComplete`.
 *
 *   @Processor(OTA_QUEUE.tenantOps, otaWorkerOptions(OTA_QUEUE.tenantOps))
 */
export function otaWorkerOptions(queue: OtaQueueName): OtaWorkerOptions {
  return {
    concurrency: OTA_QUEUE_CONCURRENCY[queue],
    removeOnFail: KEEP_FAILED_JOBS,
    removeOnComplete: keepCompletedJobs(queue),
  };
}
