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

const DAY_SECONDS = 24 * 60 * 60;

/** Failed jobs are kept 30 days, for the admin queue views and investigations (ADR-0009 item 7). */
export const KEEP_FAILED_JOBS: KeepJobs = Object.freeze({ age: 30 * DAY_SECONDS });
/** Completed jobs are kept 1 day (ADR-0009 item 7). */
export const KEEP_COMPLETED_JOBS: KeepJobs = Object.freeze({ age: DAY_SECONDS });

/**
 * The options of every job this backend adds (ADR-0009 item 7): 5 attempts, exponential backoff from 30 s
 * (30 s, 60 s, 120 s, 240 s), failed jobs kept 30 days and completed ones 1 day. A producer overrides them only with
 * a reason (for example the job id of a provisioning report). An `UnrecoverableError` ends the attempts at once.
 */
export const DEFAULT_JOB_OPTIONS: Readonly<DefaultJobOptions> = Object.freeze({
  attempts: 5,
  backoff: Object.freeze({ type: "exponential", delay: 30_000 }),
  removeOnFail: KEEP_FAILED_JOBS,
  removeOnComplete: KEEP_COMPLETED_JOBS,
});

/** What a processor of this backend passes to `@Processor(queue, …)`. */
export interface OtaWorkerOptions {
  readonly concurrency: number;
  /** The retention of ADR-0009 also for jobs whose producer set none (the platform's `tenant.*` jobs). */
  readonly removeOnFail: KeepJobs;
  readonly removeOnComplete: KeepJobs;
}

/**
 * The worker options of a queue the OTA worker consumes: its concurrency and the retention of ADR-0009.
 *
 *   @Processor(OTA_QUEUE.tenantOps, otaWorkerOptions(OTA_QUEUE.tenantOps))
 */
export function otaWorkerOptions(queue: OtaQueueName): OtaWorkerOptions {
  return {
    concurrency: OTA_QUEUE_CONCURRENCY[queue],
    removeOnFail: KEEP_FAILED_JOBS,
    removeOnComplete: KEEP_COMPLETED_JOBS,
  };
}
