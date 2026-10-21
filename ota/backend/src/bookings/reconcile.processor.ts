// The consumer of `ota-bookings` and the `bookings.reconcile_scan` schedule (OBE-043; OADR-0003 points 4–6, OADR-0014
// points 1, 4 and 5, ota/docs/architecture.md §6, ota/docs/architecture-booking.md §4). They run in the worker only
// (BookingsWorkerModule).
//
// `booking.reconcile {tenantId, bookingId}` (concurrency 4): checkout.complete queues the first one 30 seconds after a
// Flight Create Orders whose outcome is unknown (`booking.reconcile:<bkg_…>:first`), the scan the others. The payload
// is checked (exactly the two ids, else the job fails at once with `UnrecoverableError`), the tenant is resolved through
// the platform cache and skipped unless it is `active` or `suspended` (a suspended OTA's pending bookings are still
// decided: their authorisation is captured or released either way), and ReconcileService.attempt runs in the tenant's
// job context. The job trusts nothing but the two ids: the attempt claims the booking and checks everything again. A
// database error fails the job, which BullMQ retries with the defaults of ADR-0009; Amadeus and Stripe failures never
// do (the attempt waits for the next one or records them).
//
// `ota-bookings` has one consumer per process: this processor. `booking.sync` (OBE-045) joins it here; any other job
// name fails at once.
//
// `bookings.reconcile_scan` (every minute, jobs/schedulers.ts) runs per tenant on `ota-maintenance`, for `active` and
// `suspended` tenants: it lists the bookings still to decide (ReconcileRepository.dueBookingIds: `pending` with
// `reconcile_until` and no outcome, the order sent at least 30 seconds ago), at most RECONCILE_SCAN_BATCH, the earliest
// deadline first, and enqueues `booking.reconcile` for each with the deterministic id
// `booking.reconcile:<bkg_…>:<minute bucket>`, so two runs of one scheduler iteration add each booking once.
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { OTA_QUEUE, otaWorkerOptions } from "../common/queues/queue-names";
import {
  jobTenant,
  minuteBucket,
  parseTenantJobData,
  TenantJob,
  type TenantJobHandler,
  type TenantJobOutcome,
} from "../jobs/fan-out";
import { PlatformCache } from "../tenancy/platform-cache";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx } from "../tenancy/tenant-tx";
import {
  parseReconcileJobData,
  RECONCILE_JOB,
  RECONCILE_SCAN_JOB,
  reconcileJob,
  ReconcileRepository,
  ReconcileService,
  type ReconcileOutcome,
} from "./reconcile.service";
import { jobRequestId } from "./ticketing.processor";

export { RECONCILE_JOB, RECONCILE_SCAN_JOB };

/** The tenant statuses whose pending bookings are reconciled (OADR-0014 point 4). */
export const RECONCILE_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** Bookings one scan job enqueues per tenant at most; the next run (a minute later) takes the rest. */
export const RECONCILE_SCAN_BATCH = 100;

/** What a finished `booking.reconcile` job returns (BullMQ keeps it with the job). */
export type ReconcileJobResult =
  | ({ readonly tenantId: string; readonly bookingId: string } & ReconcileOutcome)
  | {
      readonly tenantId: string;
      readonly bookingId: string;
      readonly outcome: "tenant_skipped";
      readonly reason: string;
    };

/**
 * The consumer of `ota-bookings` (architecture §6, concurrency 4): `booking.reconcile {tenantId, bookingId}` runs one
 * reconciliation attempt (see the file header); any other job fails at once.
 */
@Processor(OTA_QUEUE.bookings, otaWorkerOptions(OTA_QUEUE.bookings))
export class ReconcileProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly reconcile: ReconcileService,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    @InjectPinoLogger(ReconcileProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<ReconcileJobResult> {
    const data = job.name === RECONCILE_JOB ? parseReconcileJobData(job.data) : undefined;
    if (data === undefined) {
      this.logger.error(
        { queue: job.queueName, jobId: job.id, jobName: String(job.name).slice(0, 64) },
        "bookings.reconcile_job_invalid",
      );
      throw new UnrecoverableError("the job is not booking.reconcile {tenantId, bookingId}");
    }
    const tenant = await this.cache.tenantById(data.tenantId);
    if (tenant === null || !RECONCILE_TENANT_STATUSES.includes(tenant.status)) {
      const reason = tenant === null ? "tenant_not_found" : `tenant_${tenant.status}`;
      this.logger.debug({ tenantId: data.tenantId, reason }, "bookings.reconcile_tenant_skipped");
      return { ...data, outcome: "tenant_skipped", reason };
    }
    const requestId = jobRequestId(job);
    const outcome = await this.tenants.run({ ...jobTenant(tenant, job), requestId }, () =>
      this.reconcile.attempt(tenant, data.bookingId, requestId),
    );
    return { ...data, ...outcome };
  }

  /** A job failed: logged with its id and attempt and the error's name, never the error (it may quote SQL). */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      { queue: OTA_QUEUE.bookings, jobId: job?.id, attempt: job?.attemptsMade, code: error.name },
      "bookings.reconcile_job_failed",
    );
  }

  /** Errors of the worker itself (its Redis connections); job failures are the `failed` events above. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: OTA_QUEUE.bookings, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}

/**
 * `bookings.reconcile_scan` for one tenant (every minute, fanned out by jobs/fan-out.ts): enqueues `booking.reconcile`
 * for each booking still to decide (see the file header).
 */
@Injectable()
@TenantJob(RECONCILE_SCAN_JOB)
export class ReconcileScan implements TenantJobHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: ReconcileRepository,
    private readonly clock: Clock,
    @InjectQueue(OTA_QUEUE.bookings) private readonly queue: Queue,
  ) {}

  async run(tenant: PlatformTenant, job: Job): Promise<TenantJobOutcome> {
    const now = this.clock.now();
    const due = await this.tx.run((trx) =>
      this.repository.dueBookingIds(trx, { now, limit: RECONCILE_SCAN_BATCH }),
    );
    if (due.length > 0) {
      // The runner validated the payload; the bucket of the fan-out makes the ids of this run's jobs.
      const bucket = parseTenantJobData(job.data)?.bucket ?? minuteBucket(now);
      await this.queue.addBulk(due.map((bookingId) => reconcileJob(tenant.id, bookingId, bucket)));
    }
    return { more: false, counts: { due: due.length } };
  }
}
