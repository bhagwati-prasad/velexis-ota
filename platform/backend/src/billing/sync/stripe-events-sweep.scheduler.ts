// `stripe_events.sweep` (PBE-043; platform/docs/architecture.md §5, every 5 minutes, registered while
// FEATURE_STRIPE_BILLING or FEATURE_OWN_STRIPE is on; subscription-billing flow §C item 2): queues `stripe.event`
// again for the inbox rows whose job is missing, so an event is never lost between the receiver's commit and its
// enqueue (Redis down, a process stopped in between, architecture §9), nor between two attempts of a failed one, nor
// after an attempt that stopped half-way.
//
// The rows are `received` ones and retryable `failed` ones (an attempt failed and another one is due; see
// stripe-events.repository.ts) last changed more than SWEEP_AGE_MS ago, and `processing` ones unchanged for
// SWEEP_PROCESSING_AGE_MS (the attempt that claimed the row never recorded its end: the worker stopped, or the database
// failed during the last attempt, and BullMQ has given up the job), oldest first, at most SWEEP_BATCH_SIZE per run
// (the next run takes the rest). The age leaves a receiver's or an admin's own enqueue time to land. For each row:
//
// - BullMQ holds a job of that id that will still run (waiting, delayed, active, prioritized): it is left to it;
// - BullMQ holds a finished job (completed or failed) while the row says more work is due, for example after
//   `adminReprocessStripeEvent` lost the removal of the old job: that job is removed, and a new one queued;
// - no job: one is queued (`stripe.event {eventId}`, job id = event id).
//
// The run logs `stripe_events.sweep` when it queued any, with the counts (never a payload), and returns the counts,
// which BullMQ keeps with the job. A failure fails the job, and the next run comes anyway. The worker provides the
// handler (BillingSyncModule.forWorker()), and the one processor of `platform-maintenance` runs it.
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../../common/database";
import { MaintenanceJob, type MaintenanceJobHandler } from "../../common/queues/maintenance.processor";
import { PLATFORM_QUEUE } from "../../common/queues/queue-names";
import { StripeEventsRepository } from "../../common/stripe/stripe-events.repository";
import { addStripeEventJob } from "../../common/stripe/stripe-inbox.service";

/** The schedule and job name (scheduler.registry.ts). */
export const STRIPE_EVENTS_SWEEP_JOB = "stripe_events.sweep";

/** A row changed more recently than this is left alone (architecture §5: older than 2 minutes). */
export const SWEEP_AGE_MS = 2 * 60_000;

/**
 * A `processing` row unchanged for this long belongs to an attempt that never recorded its end: one attempt takes at
 * most the Stripe calls' 10-second timeouts and the database's statement timeout. Its job is checked like any other
 * row's, so an attempt that still runs (`active`) keeps its row (the e-mail outbox's sweep waits as long for `sending`).
 */
export const SWEEP_PROCESSING_AGE_MS = 10 * 60_000;

/** The most rows one run queues. */
export const SWEEP_BATCH_SIZE = 100;

/** The states in which a BullMQ job will still run: the sweep leaves its row to it. */
export const LIVE_JOB_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "delayed",
  "active",
  "prioritized",
  "waiting-children",
]);

/** What a finished run returns. */
export interface StripeEventsSweepResult {
  /** The rows found. */
  readonly candidates: number;
  /** The rows whose `stripe.event` was queued again. */
  readonly enqueued: number;
}

@Injectable()
@MaintenanceJob(STRIPE_EVENTS_SWEEP_JOB)
export class StripeEventsSweepScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly repository: StripeEventsRepository,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    private readonly clock: Clock,
    @InjectQueue(PLATFORM_QUEUE.stripeEvents) private readonly queue: Queue,
    @InjectPinoLogger(StripeEventsSweepScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<StripeEventsSweepResult> {
    const now = this.clock.now().getTime();
    const ids = await this.repository.sweepCandidates(this.db, {
      before: new Date(now - SWEEP_AGE_MS),
      processingBefore: new Date(now - SWEEP_PROCESSING_AGE_MS),
      limit: SWEEP_BATCH_SIZE,
    });
    let enqueued = 0;
    for (const eventId of ids) {
      const existing = await this.queue.getJob(eventId);
      if (existing !== undefined) {
        if (LIVE_JOB_STATES.has(await existing.getState())) {
          continue;
        }
        try {
          await existing.remove();
        } catch (error) {
          // Taken by a worker in the meantime: it runs now, and the next sweep looks again.
          this.logger.warn({ eventId, err: error }, "stripe_events.sweep_remove_failed");
          continue;
        }
      }
      await addStripeEventJob(this.queue, eventId);
      enqueued += 1;
    }
    const result: StripeEventsSweepResult = { candidates: ids.length, enqueued };
    if (enqueued > 0) {
      this.logger.info({ ...result }, "stripe_events.sweep");
    }
    return result;
  }
}
