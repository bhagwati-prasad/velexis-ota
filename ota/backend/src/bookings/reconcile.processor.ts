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
// `ota-bookings` has one consumer per process: this processor. `booking.sync` (OBE-045) joins it here: those jobs go to
// BookingSyncJobs (booking-sync.processor.ts); `booking.cancellation_check` (OBE-049) to CancellationChecks
// (cancellation.service.ts); any other job name fails at once.
//
// `bookings.reconcile_scan` (every minute, jobs/schedulers.ts) runs per tenant on `ota-maintenance`, for `active` and
// `suspended` tenants. In one transaction it first adopts the stale claims (ReconcileRepository.adoptStaleClaims, lead
// decision of 2026-10-21: `pending` bookings without `reconcile_until` whose create-order attempt started more than 2
// minutes ago, because their process died or their unknown-outcome write failed; each gets `reconcile_until = now + 15
// minutes` and the event `booking.reconcile_adopted`, once), then lists the bookings still to decide
// (ReconcileRepository.dueBookingIds: `pending` with `reconcile_until` and no outcome, the order sent at least 30
// seconds ago, the adopted ones included), at most RECONCILE_SCAN_BATCH of each, the earliest deadline first, and
// after the commit enqueues `booking.reconcile` for each with the deterministic id
// `booking.reconcile:<bkg_…>:<minute bucket>`, so two runs of one scheduler iteration add each booking once.
//
// The same scan sweeps the lost checks of a cancellation (FIX-W28-CANCEL, OBE-049): bookings.cancel queues the first
// `booking.cancellation_check` of a DELETE without an answer after its commit and never fails its request when Redis
// does not answer, so a lost enqueue left the booking flagged, its cancellation undecided and the same key replaying
// the `504`, until the staff acted. The scan lists the live bookings whose newest cancellation event is a flag written
// a minute ago or more (CancellationRepository.undecidedFlags: of the bookings changed in the last day, at most
// RECONCILE_SCAN_BATCH, the oldest flag first; a flag handed to the staff or decided is not one of them) and adds the
// first check of each flag again, at once, with its own job id `booking.cancellation_check:<bkg_…>:<deadline>-1`:
// BullMQ ignores it while it holds that job (waiting, delayed, running, or finished within the day it keeps finished
// jobs), so a flag whose check was queued is never checked twice, and a lost one is checked once, within about a
// minute. A flag still undecided CANCELLATION_SWEEP_FINAL_AFTER_MS after its deadline lost a later check of its chain
// (a reschedule whose enqueue failed, a job that failed for good, a chain that gave up): every check after the deadline
// that claims the booking decides it (the order cancelled, still active, or the staff's review), so none is waiting any
// more. For such a flag the scan adds the chain's last check instead, `…:<deadline>-<CANCELLATION_CHECK_MAX_RUNS>`,
// which decides it once (it never reschedules: a booking another transaction holds then makes it give up) and is just
// as single by its id.
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
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { BOOKING_SYNC_JOB, BookingSyncJobs, type BookingSyncJobResult } from "./booking-sync.processor";
import {
  CANCELLATION_CHECK_JOB,
  CANCELLATION_CHECK_MAX_RUNS,
  cancellationCheckJob,
  CancellationChecks,
  CancellationRepository,
  type CancellationCheckResult,
} from "./cancellation.service";
import { OrderRecorder } from "./order-recorder";
import {
  parseReconcileJobData,
  RECONCILE_ADOPT_AFTER_MS,
  RECONCILE_ADOPTED_EVENT,
  RECONCILE_JOB,
  RECONCILE_SCAN_JOB,
  reconcileJob,
  ReconcileRepository,
  ReconcileService,
  type AdoptedClaim,
  type ReconcileOutcome,
} from "./reconcile.service";
import { jobRequestId } from "./ticketing.processor";

export { RECONCILE_JOB, RECONCILE_SCAN_JOB };

/** The tenant statuses whose pending bookings are reconciled (OADR-0014 point 4). */
export const RECONCILE_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** Bookings one scan job enqueues per tenant at most; the next run (a minute later) takes the rest. */
export const RECONCILE_SCAN_BATCH = 100;

/** A cancellation flag is swept once it is this old: its own first check was queued 30 s after it. */
export const CANCELLATION_SWEEP_AFTER_MS = 60_000;
/** How far back the sweep looks for flagged bookings (their `updated_at`): a minute's scan sees each flag many times. */
export const CANCELLATION_SWEEP_WINDOW_MS = 24 * 60 * 60_000;
/**
 * A flag still undecided this long after its deadline lost a later check of its chain (see the file header): the
 * checks come a minute apart and the first one after the deadline decides, so a healthy chain is done well before.
 */
export const CANCELLATION_SWEEP_FINAL_AFTER_MS = 5 * 60_000;

/**
 * The run of the check the sweep adds for an undecided flag at `now`: the first one, or once the deadline is
 * CANCELLATION_SWEEP_FINAL_AFTER_MS behind, the chain's last one (see the file header).
 */
export function sweptCheckRunOf(until: Date, now: Date): number {
  return now.getTime() >= until.getTime() + CANCELLATION_SWEEP_FINAL_AFTER_MS
    ? CANCELLATION_CHECK_MAX_RUNS
    : 1;
}

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
 * reconciliation attempt (see the file header), `booking.sync {tenantId, bookingId}` one booking sync (OBE-045,
 * BookingSyncJobs); any other job fails at once.
 */
@Processor(OTA_QUEUE.bookings, otaWorkerOptions(OTA_QUEUE.bookings))
export class ReconcileProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly reconcile: ReconcileService,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    private readonly sync: BookingSyncJobs,
    private readonly cancellations: CancellationChecks,
    @InjectPinoLogger(ReconcileProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<ReconcileJobResult | BookingSyncJobResult | CancellationCheckResult> {
    if (job.name === BOOKING_SYNC_JOB) {
      return await this.sync.process(job);
    }
    if (job.name === CANCELLATION_CHECK_JOB) {
      return await this.cancellations.process(job);
    }
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
      job?.name === BOOKING_SYNC_JOB
        ? "bookings.sync_job_failed"
        : job?.name === CANCELLATION_CHECK_JOB
          ? "bookings.cancellation_check_job_failed"
          : "bookings.reconcile_job_failed",
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
 * `bookings.reconcile_scan` for one tenant (every minute, fanned out by jobs/fan-out.ts): adopts the stale claims, then
 * enqueues `booking.reconcile` for each booking still to decide (see the file header).
 */
@Injectable()
@TenantJob(RECONCILE_SCAN_JOB)
export class ReconcileScan implements TenantJobHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: ReconcileRepository,
    private readonly recorder: OrderRecorder,
    private readonly cancellations: CancellationRepository,
    private readonly clock: Clock,
    @InjectQueue(OTA_QUEUE.bookings) private readonly queue: Queue,
    @InjectPinoLogger(ReconcileScan.name) private readonly logger: PinoLogger,
  ) {}

  async run(tenant: PlatformTenant, job: Job): Promise<TenantJobOutcome> {
    const now = this.clock.now();
    const requestId = jobRequestId(job);
    const { adopted, due, flags } = await this.tx.run(async (trx) => {
      const claims = await this.adopt(trx, now, requestId);
      return {
        adopted: claims,
        due: await this.repository.dueBookingIds(trx, { now, limit: RECONCILE_SCAN_BATCH }),
        flags: await this.cancellations.undecidedFlags(trx, {
          changedSince: new Date(now.getTime() - CANCELLATION_SWEEP_WINDOW_MS),
          flaggedBefore: new Date(now.getTime() - CANCELLATION_SWEEP_AFTER_MS),
          limit: RECONCILE_SCAN_BATCH,
        }),
      };
    });
    for (const claim of adopted) {
      this.logger.warn(
        { tenantId: tenant.id, bookingId: claim.id, startedAt: claim.createOrderStartedAt.toISOString() },
        "bookings.reconcile_adopted",
      );
    }
    if (due.length > 0) {
      // The runner validated the payload; the bucket of the fan-out makes the ids of this run's jobs.
      const bucket = parseTenantJobData(job.data)?.bucket ?? minuteBucket(now);
      await this.queue.addBulk(due.map((bookingId) => reconcileJob(tenant.id, bookingId, bucket)));
    }
    if (flags.length > 0) {
      // The first check of each flag (the chain's last one once its deadline is well past) under its own job id, at
      // once (see the file header).
      await this.queue.addBulk(
        flags.map((flag) => {
          const check = cancellationCheckJob(
            tenant.id,
            flag.bookingId,
            flag.until.getTime(),
            sweptCheckRunOf(flag.until, now),
          );
          return { name: check.name, data: check.data, opts: { jobId: check.opts.jobId } };
        }),
      );
    }
    return {
      more: false,
      counts: { adopted: adopted.length, due: due.length, cancellationChecks: flags.length },
    };
  }

  /**
   * Adopts the stale claims of `now` in `trx` (ReconcileRepository.adoptStaleClaims, see the file header), with the
   * event `booking.reconcile_adopted` of each, as the system; `requestId` names the scan job. Answers the claims adopted.
   */
  async adopt(trx: TenantTransaction, now: Date, requestId: string): Promise<AdoptedClaim[]> {
    const adopted = await this.repository.adoptStaleClaims(trx, { now, limit: RECONCILE_SCAN_BATCH });
    for (const claim of adopted) {
      await this.recorder.event(trx, claim.id, {
        type: RECONCILE_ADOPTED_EVENT,
        actor: { type: "system", id: null },
        statusFrom: "pending",
        statusTo: "pending",
        summary:
          `Booking ${claim.reference} was claimed more than ${RECONCILE_ADOPT_AFTER_MS / 60_000} minutes ago without ` +
          `an outcome; the order is looked for until ${claim.reconcileUntil.toISOString()}.`,
        data: {
          reason: "stale_claim",
          createOrderStartedAt: claim.createOrderStartedAt.toISOString(),
          reconcileUntil: claim.reconcileUntil.toISOString(),
        },
        visibleToCustomer: false,
        requestId,
        now,
      });
    }
    return adopted;
  }
}
