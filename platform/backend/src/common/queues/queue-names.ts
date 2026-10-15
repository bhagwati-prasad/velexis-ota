// The queues of the platform backend (PBE-009; platform/docs/architecture.md §5, ADR-0009). The names come from
// `@velexis/api-types/jobs`, where both backends read them (`PLATFORM_QUEUES`, `OTA_TENANT_OPS`); this file adds what
// only the platform decides: the worker concurrency of each queue it consumes and the job defaults of ADR-0009.
import {
  BULLMQ_PREFIX,
  OTA_TENANT_OPS,
  PLATFORM_QUEUES,
  PLATFORM_TENANT_EVENTS,
  type PlatformQueueName,
} from "@velexis/api-types/jobs";
import type { DefaultJobOptions, KeepJobs } from "bullmq";

export { BULLMQ_PREFIX, OTA_TENANT_OPS, PLATFORM_QUEUES, PLATFORM_TENANT_EVENTS, type PlatformQueueName };

/** The queues of architecture §5 by topic, so code never spells a queue name. */
export const PLATFORM_QUEUE = Object.freeze({
  /** Platform API and worker → OTA worker: `tenant.provision`, `tenant.migrate`, `tenant.suspend`, `tenant.resume`. */
  tenantOps: OTA_TENANT_OPS,
  /** OTA worker → platform worker: `tenant.provisioned`, `tenant.provision_failed`, `tenant.migrated`, … */
  tenantEvents: PLATFORM_TENANT_EVENTS,
  /** API, worker → worker: `email.send {emailId}`. */
  emails: "platform-emails",
  /** Webhook receivers → worker: `stripe.event {eventId}` (job id = Stripe event id). */
  stripeEvents: "platform-stripe-events",
  /** API, schedulers → worker: `domain.verify`, `domain.recheck`, `domain.tls_probe` `{domainId}`. */
  domains: "platform-domains",
  /** API, admin → worker: `amadeus_account.verify {amadeusAccountId}`, `credentials.verify {submissionId}`. */
  connections: "platform-connections",
  /** Scheduler, admin → worker: `settlement.generate {periodStart, tenantId?}`. */
  settlements: "platform-settlements",
  /** Schedulers → worker: the job schedulers of scheduler.registry.ts. */
  maintenance: "platform-maintenance",
} as const);

/** Worker concurrency of each queue the platform worker consumes (architecture §5). */
export const PLATFORM_QUEUE_CONCURRENCY: Readonly<Record<PlatformQueueName, number>> = Object.freeze({
  "platform-tenant-events": 4,
  "platform-emails": 4,
  "platform-stripe-events": 2,
  "platform-domains": 4,
  "platform-connections": 2,
  "platform-settlements": 1,
  "platform-maintenance": 1,
});

/**
 * The eight queues of architecture §5, in the order of its table: `ota-tenant-ops`, which this backend produces for
 * the OTA worker, then the seven it consumes. QueuesModule registers them all.
 */
export const PLATFORM_BACKEND_QUEUES = Object.freeze([OTA_TENANT_OPS, ...PLATFORM_QUEUES] as const);

/** A queue this backend opens. */
export type PlatformBackendQueueName = (typeof PLATFORM_BACKEND_QUEUES)[number];

const DAY_SECONDS = 24 * 60 * 60;

/** Failed jobs are kept 30 days, for the admin queue views and investigations (ADR-0009 item 7). */
export const KEEP_FAILED_JOBS: KeepJobs = Object.freeze({ age: 30 * DAY_SECONDS });
/** Completed jobs are kept 1 day (ADR-0009 item 7). */
export const KEEP_COMPLETED_JOBS: KeepJobs = Object.freeze({ age: DAY_SECONDS });

/**
 * The options of every job this backend adds (ADR-0009 item 7, architecture §5): 5 attempts, exponential backoff from
 * 30 s (30 s, 60 s, 120 s, 240 s), failed jobs kept 30 days and completed ones 1 day. A producer overrides them only
 * with a reason (the attempts of `tenant.provision`, the job id of a dispatch attempt). An `UnrecoverableError` ends
 * the attempts at once.
 */
export const DEFAULT_JOB_OPTIONS: Readonly<DefaultJobOptions> = Object.freeze({
  attempts: 5,
  backoff: Object.freeze({ type: "exponential", delay: 30_000 }),
  removeOnFail: KEEP_FAILED_JOBS,
  removeOnComplete: KEEP_COMPLETED_JOBS,
});

/** What a processor of this backend passes to `@Processor(queue, …)`. */
export interface PlatformWorkerOptions {
  readonly concurrency: number;
  /** The retention of ADR-0009 also for jobs whose producer set none (the OTA worker's `tenant.*` reports). */
  readonly removeOnFail: KeepJobs;
  readonly removeOnComplete: KeepJobs;
}

/**
 * The worker options of a queue the platform worker consumes: its concurrency and the retention of ADR-0009.
 *
 *   @Processor(PLATFORM_QUEUE.emails, platformWorkerOptions(PLATFORM_QUEUE.emails))
 */
export function platformWorkerOptions(queue: PlatformQueueName): PlatformWorkerOptions {
  return {
    concurrency: PLATFORM_QUEUE_CONCURRENCY[queue],
    removeOnFail: KEEP_FAILED_JOBS,
    removeOnComplete: KEEP_COMPLETED_JOBS,
  };
}
