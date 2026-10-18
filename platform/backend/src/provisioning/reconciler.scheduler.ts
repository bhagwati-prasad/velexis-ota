// `provisioning.reconcile` (PBE-023; platform/docs/architecture.md §5, every 5 minutes; flows/provisioning.md "Failure
// handling", PADR-0001 item 6 and its follow-up): the safety net of provisioning. Lost Redis messages, crashed workers
// and dispatches whose add failed after the commit all end here. One run, in this order:
//
// 1. **Ended leases.** The `running` jobs whose lease has ended (`locked_until <= now`, the longest ended first, at
//    most RECONCILE_BATCH_SIZE per run; a job inside its lease is never touched). For each, BullMQ is asked about the
//    attempt's id `<jobId>-<attempt>` on both queues: the message on `ota-tenant-ops` and the answer on
//    `platform-tenant-events` (`leaseDecision`):
//    - either is still `waiting`, `active`, `delayed` (or `prioritized`, `waiting-children`): the attempt is under way,
//      so the lease is extended by DISPATCH_LEASE_MS (`locked_by = 'reconciler'`). A lease that ends again after such an
//      extension means the job stayed `running` across two leases: ops get one `ops.alert` per attempt (keyed
//      `provisioning.reconcile.stuck:<jobId>:<attempt>`), and the lease is extended again (PADR-0001 follow-up);
//    - otherwise the attempt is lost: its message is missing, or it failed (or completed) without an answer the
//      platform could act on. That counts as a retryable failure of the job, whatever its kind, through the failure
//      handler (failure-handler.ts), which re-queues it with the backoff or, after the last attempt, fails it.
//    The BullMQ look-ups run outside any transaction, the message's before the answer's (the OTA worker adds its answer
//    before its message finishes, so a finished message's answer is never missed); the change then re-reads the job
//    under its row lock and acts only while it is still `running` at that attempt with its lease ended.
// 2. **Due jobs.** The `queued` jobs that are due (`scheduled_at <= now`) and have a message (`provision`, `migrate`,
//    `suspend`, `resume`), oldest first, page by page, at most RECONCILE_DISPATCH_LIMIT per run: those whose gate is
//    open (`checkDispatch` of dispatcher.ts) are dispatched (`ProvisioningDispatcher.dispatch`, which checks again under
//    the job's lock). A `provision` job whose gate is closed (M5: a Checkout not paid yet) waits without a log line.
//
// Every run uses one request id for its dispatches and log lines. A job whose handling throws (a database error) is
// logged (`provisioning.reconcile_failed`) and left for the next run; the others go on. The run returns counts only.
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { bullmqJobId } from "@velexis/api-types/jobs";
import { resolveRequestId } from "@velexis/logger";
import type { JobState, Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { MaintenanceJob, type MaintenanceJobHandler } from "../common/queues/maintenance.processor";
import { PLATFORM_QUEUE } from "../common/queues/queue-names";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { OutboxService } from "../notifications/outbox.service";
import {
  checkDispatch,
  DISPATCH_LEASE_MS,
  ProvisioningDispatcher,
  TENANT_OPS_MESSAGE_OF_KIND,
} from "./dispatcher";
import { ProvisioningFailureHandler, type FailureOutcome } from "./failure-handler";
import {
  LEASE_EXTENDED_BY,
  ProvisioningJobsRepository,
  type ExpiredLeaseRow,
  type LockedJobRow,
  type ProvisioningJobKind,
} from "./provisioning-jobs.repository";

/** The schedule and job name (scheduler.registry.ts). */
export const RECONCILE_JOB = "provisioning.reconcile";

/** The jobs with an ended lease one run looks at; the next run takes the rest. */
export const RECONCILE_BATCH_SIZE = 100;

/** The due `queued` jobs one run looks at, read in pages of RECONCILE_BATCH_SIZE. */
export const RECONCILE_DISPATCH_LIMIT = 1000;

/** The code of a lost attempt in the job's error. */
export const ATTEMPT_LOST_CODE = "ATTEMPT_LOST";

/** The state of a BullMQ job by its id: one of BullMQ's, or `unknown` for none. */
export type BullmqJobState = JobState | "unknown";

/** The BullMQ states of a job that is still to run, or running. */
const PENDING_STATES: ReadonlySet<BullmqJobState> = new Set<BullmqJobState>([
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
]);

/** The kinds that have a message, which the reconciler dispatches. */
const DISPATCHABLE_KINDS = Object.keys(TENANT_OPS_MESSAGE_OF_KIND) as ProvisioningJobKind[];

/** What to do with a job whose lease ended, from the BullMQ states of its attempt's message and answer. */
export type LeaseDecision =
  | { readonly action: "extend"; readonly pending: "message" | "answer" }
  | { readonly action: "lost"; readonly message: string };

/**
 * The decision of step 1 of the file header: extend while the attempt's message (`ota-tenant-ops`) or its answer
 * (`platform-tenant-events`) is still to run or running; otherwise the attempt is lost.
 */
export function leaseDecision(message: BullmqJobState, answer: BullmqJobState): LeaseDecision {
  if (PENDING_STATES.has(message)) {
    return { action: "extend", pending: "message" };
  }
  if (PENDING_STATES.has(answer)) {
    return { action: "extend", pending: "answer" };
  }
  const what =
    message === "unknown" ? "Its message is missing from ota-tenant-ops" : `Its message ${message}`;
  const how = answer === "unknown" ? "without an answer" : `and its answer ${answer} without ending the job`;
  return { action: "lost", message: `${what} ${how}; the attempt ended with its lease.` };
}

/** The `ops.alert` of a job that stayed `running` across two leases. */
export function stuckJobAlert(
  job: Pick<LockedJobRow, "id" | "kind" | "tenant_id" | "tenant_key" | "attempt">,
  pending: "message" | "answer",
): { title: string; message: string } {
  const where =
    pending === "message"
      ? "its message is still waiting or running on ota-tenant-ops (the OTA worker)"
      : "the OTA worker's answer is still waiting or running on platform-tenant-events (the platform worker)";
  return {
    title: `Provisioning job still running after two leases: ${job.kind} of ${job.tenant_key}`,
    message:
      `The ${job.kind} job ${job.id} of the OTA ${job.tenant_key} (${job.tenant_id}) has been running its attempt ` +
      `${job.attempt} for more than two leases of ${DISPATCH_LEASE_MS / 60_000} minutes: ${where}. ` +
      "The reconciler keeps extending the lease while BullMQ holds the job. Check the workers and the queues in the " +
      "platform admin (Queues).",
  };
}

/** What one run did (BullMQ keeps it with the job): counts only. */
export interface ReconcileResult {
  /** Jobs with an ended lease whose lease was extended. */
  readonly leasesExtended: number;
  /** `ops.alert` e-mails queued for jobs running across two leases. */
  readonly stuckAlerts: number;
  /** Lost attempts handed to the failure handler. */
  readonly attemptsLost: number;
  /** Due `queued` jobs dispatched. */
  readonly dispatched: number;
  /** Jobs whose handling threw; the next run tries them again. */
  readonly errors: number;
}

type MutableResult = { -readonly [K in keyof ReconcileResult]: ReconcileResult[K] };

@Injectable()
@MaintenanceJob(RECONCILE_JOB)
export class ReconcilerScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly jobs: ProvisioningJobsRepository,
    private readonly dispatcher: ProvisioningDispatcher,
    private readonly failures: ProvisioningFailureHandler,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectQueue(PLATFORM_QUEUE.tenantOps) private readonly tenantOps: Queue,
    @InjectQueue(PLATFORM_QUEUE.tenantEvents) private readonly tenantEvents: Queue,
    @InjectPinoLogger(ReconcilerScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<ReconcileResult> {
    const requestId = resolveRequestId(undefined);
    const result: MutableResult = {
      leasesExtended: 0,
      stuckAlerts: 0,
      attemptsLost: 0,
      dispatched: 0,
      errors: 0,
    };
    const now = this.clock.now();
    for (const job of await this.jobs.listExpiredLeases(now, RECONCILE_BATCH_SIZE)) {
      try {
        await this.reconcileLease(job, now, requestId, result);
      } catch (error) {
        result.errors += 1;
        this.logger.error(
          { jobId: job.id, attempt: job.attempt, requestId, err: error },
          "provisioning.reconcile_failed",
        );
      }
    }
    await this.dispatchDue(requestId, result);
    if (Object.values(result).some((count) => count > 0)) {
      this.logger.info({ ...result, requestId }, "provisioning.reconciled");
    }
    return { ...result };
  }

  /** Step 1 of the file header for one job. */
  private async reconcileLease(
    job: ExpiredLeaseRow,
    now: Date,
    requestId: string,
    result: MutableResult,
  ): Promise<void> {
    const id = bullmqJobId(job.id, job.attempt);
    // The message first, then the answer, one after the other: the OTA worker adds its answer before its message
    // finishes, so a message seen finished has its answer in place by the second look-up. Looked up together, an
    // attempt whose message finished in between could read as finished without an answer, and count as lost.
    const message = await this.tenantOps.getJobState(id);
    const answer = await this.tenantEvents.getJobState(id);
    const decision = leaseDecision(message, answer);
    const context = { jobId: job.id, kind: job.kind, attempt: job.attempt, message, answer, requestId };
    if (decision.action === "lost") {
      const outcome: FailureOutcome = await this.failures.handle({
        jobId: job.id,
        attempt: job.attempt,
        error: { code: ATTEMPT_LOST_CODE, message: decision.message },
        retryable: true,
        source: "reconciler",
        leaseEndedBy: now,
        requestId,
      });
      if (outcome.outcome !== "ignored") {
        result.attemptsLost += 1;
        this.logger.warn({ ...context, outcome: outcome.outcome }, "provisioning.attempt_lost");
      }
      return;
    }
    const extended = await runInTransaction(this.db, async (trx) => {
      const locked = await this.jobs.lockForLifecycle(trx, job.id);
      if (
        locked === undefined ||
        locked.status !== "running" ||
        locked.attempt !== job.attempt ||
        locked.locked_until === null ||
        locked.locked_until.getTime() > now.getTime()
      ) {
        return undefined;
      }
      const stuck = locked.locked_by === LEASE_EXTENDED_BY;
      await this.jobs.extendLease(trx, {
        jobId: job.id,
        attempt: job.attempt,
        lockedUntil: new Date(now.getTime() + DISPATCH_LEASE_MS),
        now,
      });
      const alerted = stuck
        ? (
            await this.outbox.queueOpsAlert(trx, {
              ...stuckJobAlert(locked, decision.pending),
              tenantId: locked.tenant_id,
              idempotencyKey: `${RECONCILE_JOB}.stuck:${job.id}:${job.attempt}`,
            })
          ).queued
        : false;
      return { stuck, alerted };
    });
    if (extended === undefined) {
      return;
    }
    result.leasesExtended += 1;
    if (extended.alerted) {
      result.stuckAlerts += 1;
    }
    this.logger.info(
      { ...context, pending: decision.pending, stuck: extended.stuck },
      "provisioning.lease_extended",
    );
  }

  /** Step 2 of the file header. */
  private async dispatchDue(requestId: string, result: MutableResult): Promise<void> {
    const now = this.clock.now();
    let seen = 0;
    let after: { scheduledAt: Date; id: string } | undefined;
    while (seen < RECONCILE_DISPATCH_LIMIT) {
      const page = await this.jobs.listDueQueued(now, DISPATCHABLE_KINDS, RECONCILE_BATCH_SIZE, after);
      for (const job of page) {
        seen += 1;
        if ("dispatched" in checkDispatch(job, now)) {
          continue;
        }
        try {
          const dispatched = await this.dispatcher.dispatch(job.id, { requestId });
          if (dispatched.dispatched) {
            result.dispatched += 1;
          }
        } catch (error) {
          result.errors += 1;
          this.logger.error({ jobId: job.id, requestId, err: error }, "provisioning.reconcile_failed");
        }
      }
      const last = page[page.length - 1];
      if (page.length < RECONCILE_BATCH_SIZE || last === undefined) {
        return;
      }
      after = { scheduledAt: last.scheduled_at, id: last.id };
    }
  }
}
