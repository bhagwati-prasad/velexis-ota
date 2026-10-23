// `refunds.sweep` (FIX-W27-FOLLOWUPS, lead decision (4) of 2026-10-23; OADR-0010 point 6, OADR-0014 points 1, 4 and 5,
// ota/docs/architecture.md §6): every 5 minutes, per tenant (`active` and `suspended`: a suspended OTA's refunds go out
// all the same, OADR-0014 point 4; jobs/schedulers.ts fans it out), one job queues `refund.submit` again for the refunds
// whose own enqueue was lost. A producer (the console's refund of OBE-068, the cancellation of OBE-049) inserts the
// `pending` row in its transaction and queues `refund.submit {tenantId, id}` after the commit, never failing the request
// when Redis does not answer; before this sweep such a row stayed `pending` for good, since nothing else queued it.
//
// What it queues: the refunds that are still `pending` and unclaimed (RefundsRepository.unclaimedRefundIds: at the
// version of a new row, without a Stripe id; a claim and the release of a claim both bump the version) and were asked
// for REFUND_SWEEP_AFTER_MS ago or more, REFUND_SWEEP_BATCH per job, the oldest first, read without a lock. Each one
// gets the producers' own job (`paymentJob`: `refund.submit`, job id `refund-submit-<rfd_id>`), so BullMQ ignores it
// while it holds that job (waiting, delayed, active, or finished: completed ones are kept a day, failed ones 30 days,
// ADR-0009), and a refund is queued once however often the sweep finds it. The job itself claims the row before it
// calls Stripe with the refund's idempotency key `refund:<rfd_id>` (payments.processor.ts), so even a second job of one
// row never sends it twice. Left alone: a refund being sent (`processing`, claimed: its job, or BullMQ's retry of a
// stalled one, owns it), one already sent (Stripe's id recorded) or final, and one whose claim was released after an
// answer that never came (`pending` again at a later version: BullMQ retries its job, and after the last attempt the
// staff were alerted to check the payment before refunding again, so a later sweep must not send it again once Stripe
// has forgotten the key).
//
// A full batch asks for more (OADR-0014 point 2), and the runner's n-th continuation of a run reads the n-th batch
// after the first (an offset of n × REFUND_SWEEP_BATCH): the oldest rows can be ones whose job BullMQ holds without
// having claimed them (a backlog of waiting jobs, or a job that failed for good before its claim, kept 30 days), which
// every run finds again, so a run that stopped at its first batch would never reach a lost enqueue behind a full batch
// of those. The rows are not locked, so a batch read after rows were claimed meanwhile starts a little further on; the
// next run takes what it passed over. The job logs counts only.
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { OTA_QUEUE } from "../common/queues/queue-names";
import { parseTenantJobData, TenantJob, type TenantJobHandler, type TenantJobOutcome } from "../jobs/fan-out";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { TenantTx } from "../tenancy/tenant-tx";
import { PAYMENT_JOB, paymentJob } from "./payments.processor";
import { RefundsRepository } from "./refunds.repository";

/** The schedule and job name (jobs/schedulers.ts). */
export const REFUNDS_SWEEP_JOB = "refunds.sweep";

/**
 * How long after its request a refund that is still `pending` and unclaimed counts as lost: its producer queues
 * `refund.submit` within seconds of the commit (2 s at most for the console), and a job that is only waiting behind
 * others keeps its id, so the sweep's job for it is ignored.
 */
export const REFUND_SWEEP_AFTER_MS = 5 * 60_000;

/**
 * The refunds one sweep job queues at most for a tenant; a full batch continues with the next ones (OADR-0014 point 2,
 * at most MAX_CONTINUATIONS times per run), and the next run (5 minutes later) takes what is left.
 */
export const REFUND_SWEEP_BATCH = 100;

/** What one run did: the unclaimed refunds found, each queued (or already held by BullMQ under its job id). */
export interface RefundsSweepCounts extends Readonly<Record<string, number>> {
  readonly refunds: number;
}

/**
 * `refunds.sweep` for one tenant (every 5 minutes, fanned out by jobs/fan-out.ts): queues `refund.submit` for the
 * refunds whose enqueue was lost (see the file header).
 */
@Injectable()
@TenantJob(REFUNDS_SWEEP_JOB)
export class RefundsSweep implements TenantJobHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly refunds: RefundsRepository,
    private readonly clock: Clock,
    @InjectQueue(OTA_QUEUE.payments) private readonly queue: Queue,
    @InjectPinoLogger(RefundsSweep.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * One batch for the job's tenant (the runner opened its context): the first job of a run reads the oldest refunds,
   * its n-th continuation the n-th batch after them; a full batch asks for more.
   */
  async run(tenant: PlatformTenant, job: Job): Promise<TenantJobOutcome> {
    // The runner validated the payload before it called the handler.
    const continuation = parseTenantJobData(job.data)?.continuation ?? 0;
    const requestedBefore = new Date(this.clock.now().getTime() - REFUND_SWEEP_AFTER_MS);
    const ids = await this.tx.run((trx) =>
      this.refunds.unclaimedRefundIds(
        trx,
        requestedBefore,
        REFUND_SWEEP_BATCH,
        continuation * REFUND_SWEEP_BATCH,
      ),
    );
    if (ids.length > 0) {
      // The producers' job and job id: BullMQ adds nothing for a refund whose job it holds already.
      await this.queue.addBulk(ids.map((id) => paymentJob(PAYMENT_JOB.refundSubmit, tenant.id, id)));
      this.logger.info({ tenantId: tenant.id, refunds: ids.length }, "payments.refunds_swept");
    }
    const counts: RefundsSweepCounts = { refunds: ids.length };
    return { more: ids.length >= REFUND_SWEEP_BATCH, counts };
  }
}
