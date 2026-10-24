// The `refunds.sweep` handler (FIX-W27-FOLLOWUPS, refunds-sweep.processor.ts) with doubles of its transaction, its
// repository and the payments queue: the queue double ignores a job id it holds already, as BullMQ does, so the tests
// show that the sweep adds the producers' own `refund.submit` job (`paymentJob`, job id `refund-submit-<rfd_id>`) and
// that a refund is queued once however often the sweep finds it, and that a full batch continues with the next one
// (OADR-0014 point 2). Since FIX-W28-FOLLOWUPS (lead decision (7) of 2026-10-23, second batch) the double also keeps
// each job's state, as BullMQ keeps a finished job (completed a day, failed 30 days): the sweep removes the finished job
// of a refund that is still unclaimed and queues it again under the same id, once, and leaves a job that will still
// run, or one whose refund was claimed meanwhile. Which rows the sweep finds (pending and unclaimed, asked for 5 minutes
// ago or more) and the submission that follows run against PostgreSQL, Redis and the fake Stripe API in
// test/integration/payments/payments-queue.int.test.ts.
import { FakeClock } from "@velexis/testing";
import type { Job, Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../common/clock";
import { tenantJob } from "../jobs/fan-out";
import { scheduleById } from "../jobs/schedulers";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import { PAYMENT_JOB, paymentJob } from "./payments.processor";
import { NEW_REFUND_VERSION, type RefundsRepository } from "./refunds.repository";
import {
  FINISHED_JOB_STATES,
  REFUND_SWEEP_AFTER_MS,
  REFUND_SWEEP_BATCH,
  REFUNDS_SWEEP_JOB,
  RefundsSweep,
} from "./refunds-sweep.processor";

const TENANT = { id: "ten_01JBSWEEP00000000000000000" } as PlatformTenant;
/** The sweep's run: a minute of the past (no calendar date matters). */
const NOW = new Date(Date.UTC(2026, 0, 15, 10, 20));

/** The `n`-th refund's id (zero-padded, so the ids sort as the numbers do). */
const refundId = (n: number): string => `rfd_01JBSWEEP${String(n).padStart(17, "0")}`;

interface QueuedJob {
  readonly name: string;
  readonly data: unknown;
  readonly id: string;
}

/** The states of a job the double holds (BullMQ's names). */
type JobState = "waiting" | "delayed" | "active" | "completed" | "failed";

/**
 * `addBulk`, `add`, `getJobState` and `remove` as BullMQ behaves for them: a job whose id the queue holds already is
 * not added again, whatever its state (a finished job is kept), a job it does not hold is `unknown`, and an active job
 * (locked by its worker) is not removed (`remove` answers 0).
 */
class QueueDouble {
  readonly jobs = new Map<string, QueuedJob>();
  readonly states = new Map<string, JobState>();
  readonly bulks: number[] = [];
  readonly removed: string[] = [];

  getJobState(jobId: string): Promise<JobState | "unknown"> {
    return Promise.resolve(this.states.get(jobId) ?? "unknown");
  }

  remove(jobId: string): Promise<number> {
    if (this.states.get(jobId) === "active") {
      return Promise.resolve(0);
    }
    this.jobs.delete(jobId);
    this.states.delete(jobId);
    this.removed.push(jobId);
    return Promise.resolve(1);
  }

  /** Puts the job `jobId` (added before) in `state`, as a worker moves it. */
  move(jobId: string, state: JobState): void {
    if (!this.jobs.has(jobId)) {
      throw new Error(`the queue holds no job ${jobId}`);
    }
    this.states.set(jobId, state);
  }

  addBulk(
    jobs: ReadonlyArray<{ name: string; data: unknown; opts?: { jobId?: string } }>,
  ): Promise<unknown[]> {
    this.bulks.push(jobs.length);
    return Promise.resolve(jobs.map((job) => this.store(job.name, job.data, job.opts?.jobId)));
  }

  add(name: string, data: unknown, opts?: { jobId?: string }): Promise<unknown> {
    return Promise.resolve(this.store(name, data, opts?.jobId));
  }

  private store(name: string, data: unknown, jobId: string | undefined): QueuedJob {
    if (jobId === undefined) {
      throw new Error("every refund.submit job has its deterministic id");
    }
    const existing = this.jobs.get(jobId);
    if (existing !== undefined) {
      return existing;
    }
    const job = { name, data, id: jobId };
    this.jobs.set(jobId, job);
    this.states.set(jobId, "waiting");
    return job;
  }
}

/** The `continuation`-th job of one scheduler run for the tenant, as the fan-out and the runner add it. */
function jobOf(continuation = 0): Job {
  const spec = tenantJob(REFUNDS_SWEEP_JOB, TENANT.id, 29_434_820, continuation);
  return { name: spec.name, data: spec.data, id: spec.opts.jobId } as unknown as Job;
}

/**
 * The handler with doubles; the repository answers the batch of `found` that a call asks for, every run, and the ones
 * of `found` that are not in `claimed` when it is asked again which are still unclaimed.
 */
function sweep(found: readonly string[], claimed: ReadonlySet<string> = new Set()) {
  const trx = {} as TenantTransaction;
  const unclaimedRefundIds = vi.fn(
    (_trx: TenantTransaction, _requestedBefore: Date, limit: number, offset: number) =>
      Promise.resolve(found.slice(offset, offset + limit)),
  );
  const stillUnclaimed = vi.fn((_trx: TenantTransaction, ids: readonly string[]) =>
    Promise.resolve(ids.filter((id) => found.includes(id) && !claimed.has(id))),
  );
  const queue = new QueueDouble();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const instance = new RefundsSweep(
    {
      run: <T>(fn: (transaction: TenantTransaction) => Promise<T>): Promise<T> => fn(trx),
    } as unknown as TenantTx,
    { unclaimedRefundIds, stillUnclaimed } as unknown as RefundsRepository,
    new FakeClock(NOW) as unknown as Clock,
    queue as unknown as Queue,
    logger as unknown as PinoLogger,
  );
  return { instance, trx, unclaimedRefundIds, stillUnclaimed, queue, logger };
}

describe("refunds.sweep", () => {
  it("is a schedule every 5 minutes for active and suspended tenants, and a new refund's version marks it unclaimed", () => {
    expect(scheduleById(REFUNDS_SWEEP_JOB)).toMatchObject({
      pattern: "*/5 * * * *",
      milestone: "M3",
      statuses: ["active", "suspended"],
    });
    expect(REFUND_SWEEP_AFTER_MS).toBe(5 * 60_000);
    expect(REFUND_SWEEP_BATCH).toBe(100);
    expect(NEW_REFUND_VERSION).toBe(1);
  });

  it("[FIX-W27-FOLLOWUPS AC1] queues the producers' refund.submit job for each refund it finds, once however often it runs", async () => {
    const found = [refundId(1), refundId(2)];
    const { instance, trx, unclaimedRefundIds, queue } = sweep(found);
    // The console's enqueue of the second refund came through after all: its job is in the queue already.
    const queued = paymentJob(PAYMENT_JOB.refundSubmit, TENANT.id, refundId(2));
    await queue.add(queued.name, queued.data, queued.opts);

    const first = await instance.run(TENANT, jobOf());
    const second = await instance.run(TENANT, jobOf());

    expect(first).toEqual({ more: false, counts: { refunds: 2, resent: 0 } });
    expect(second).toEqual({ more: false, counts: { refunds: 2, resent: 0 } });
    // The rows asked for 5 minutes or more before the run, the first batch of them.
    expect(unclaimedRefundIds).toHaveBeenCalledWith(
      trx,
      new Date(NOW.getTime() - REFUND_SWEEP_AFTER_MS),
      REFUND_SWEEP_BATCH,
      0,
    );
    // One job per refund, the one its producer adds (name, payload and job id): a second never comes. The second
    // refund keeps the producer's job, which the queue held first.
    expect([...queue.jobs.values()]).toEqual([
      {
        name: "refund.submit",
        data: { tenantId: TENANT.id, id: refundId(2) },
        id: `refund-submit-${refundId(2)}`,
      },
      {
        name: "refund.submit",
        data: { tenantId: TENANT.id, id: refundId(1) },
        id: `refund-submit-${refundId(1)}`,
      },
    ]);
    expect(queue.bulks).toEqual([2, 2]);
  });

  it("[FIX-W27-FOLLOWUPS AC1] asks for more after a full batch, and its continuation queues the batch after it (OADR-0014 point 2)", async () => {
    // A full batch of refunds whose jobs BullMQ holds unclaimed (a backlog, or jobs that failed before their claim),
    // which every run finds first, and behind them a refund whose enqueue was lost.
    const held = Array.from({ length: REFUND_SWEEP_BATCH }, (_, n) => refundId(n + 1));
    const lost = refundId(REFUND_SWEEP_BATCH + 1);
    const { instance, trx, unclaimedRefundIds, queue } = sweep([...held, lost]);
    for (const id of held) {
      const queued = paymentJob(PAYMENT_JOB.refundSubmit, TENANT.id, id);
      await queue.add(queued.name, queued.data, queued.opts);
    }

    const first = await instance.run(TENANT, jobOf(0));
    const continued = await instance.run(TENANT, jobOf(1));

    expect(first).toEqual({ more: true, counts: { refunds: REFUND_SWEEP_BATCH, resent: 0 } });
    expect(continued).toEqual({ more: false, counts: { refunds: 1, resent: 0 } });
    const requestedBefore = new Date(NOW.getTime() - REFUND_SWEEP_AFTER_MS);
    expect(unclaimedRefundIds.mock.calls).toEqual([
      [trx, requestedBefore, REFUND_SWEEP_BATCH, 0],
      [trx, requestedBefore, REFUND_SWEEP_BATCH, REFUND_SWEEP_BATCH],
    ]);
    expect(queue.jobs.get(`refund-submit-${lost}`)).toEqual({
      name: "refund.submit",
      data: { tenantId: TENANT.id, id: lost },
      id: `refund-submit-${lost}`,
    });
    expect(queue.jobs.size).toBe(REFUND_SWEEP_BATCH + 1);
  });

  it("adds nothing and logs nothing when every refund was claimed or its enqueue came through", async () => {
    const { instance, queue, logger } = sweep([]);

    expect(await instance.run(TENANT, jobOf())).toEqual({ more: false, counts: { refunds: 0, resent: 0 } });
    expect(queue.bulks).toEqual([]);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs the tenant and the count only, never a refund id or an amount", async () => {
    const { instance, logger } = sweep([refundId(7)]);

    await instance.run(TENANT, jobOf());

    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      { tenantId: TENANT.id, refunds: 1, resent: 0 },
      "payments.refunds_swept",
    );
  });
});

describe("refunds.sweep and the finished jobs of unclaimed refunds (FIX-W28-FOLLOWUPS)", () => {
  /** Adds the producers' job of refund `id`, as its producer did, and puts it in `state`. */
  async function held(queue: QueueDouble, id: string, state: JobState): Promise<string> {
    const queued = paymentJob(PAYMENT_JOB.refundSubmit, TENANT.id, id);
    await queue.add(queued.name, queued.data, queued.opts);
    queue.move(queued.opts.jobId, state);
    return queued.opts.jobId;
  }

  it("[FIX-W28-FOLLOWUPS AC1] queues again, under its own job id and once, a refund whose job failed for good or completed before its claim", async () => {
    const failed = refundId(1);
    const completed = refundId(2);
    const { instance, trx, stillUnclaimed, queue, logger } = sweep([failed, completed]);
    // The database was down through every attempt of the first job (BullMQ keeps it 30 days); the second one completed
    // without a claim (a tenant the platform cache did not list then; BullMQ keeps it a day).
    const failedJob = await held(queue, failed, "failed");
    const completedJob = await held(queue, completed, "completed");

    const first = await instance.run(TENANT, jobOf());
    // The jobs are queued again, and wait for the worker: the next run leaves them to it.
    const second = await instance.run(TENANT, jobOf());

    expect(first).toEqual({ more: false, counts: { refunds: 2, resent: 2 } });
    expect(second).toEqual({ more: false, counts: { refunds: 2, resent: 0 } });
    // The rows were read again, after the jobs' states, before their jobs were removed.
    expect(stillUnclaimed).toHaveBeenCalledExactlyOnceWith(trx, [failed, completed]);
    expect(queue.removed).toEqual([failedJob, completedJob]);
    expect([...queue.jobs.values()]).toEqual([
      { name: "refund.submit", data: { tenantId: TENANT.id, id: failed }, id: failedJob },
      { name: "refund.submit", data: { tenantId: TENANT.id, id: completed }, id: completedJob },
    ]);
    expect([queue.states.get(failedJob), queue.states.get(completedJob)]).toEqual(["waiting", "waiting"]);
    expect(logger.info.mock.calls).toEqual([
      [{ tenantId: TENANT.id, refunds: 2, resent: 2 }, "payments.refunds_swept"],
      [{ tenantId: TENANT.id, refunds: 2, resent: 0 }, "payments.refunds_swept"],
    ]);
  });

  it("[FIX-W28-FOLLOWUPS AC2] keeps the finished job of a refund claimed meanwhile, and leaves a job that will still run", async () => {
    // The first refund's job claimed it and finished between the sweep's read and its look at the job: the second read
    // finds it claimed. The others' jobs will still run.
    const claimedMeanwhile = refundId(1);
    const others = { waiting: refundId(2), delayed: refundId(3), active: refundId(4) } as const;
    const { instance, stillUnclaimed, queue } = sweep(
      [claimedMeanwhile, ...Object.values(others)],
      new Set([claimedMeanwhile]),
    );
    const finishedJob = await held(queue, claimedMeanwhile, "completed");
    for (const [state, id] of Object.entries(others)) {
      await held(queue, id, state as JobState);
    }
    const before = new Map(queue.states);

    expect(await instance.run(TENANT, jobOf())).toEqual({ more: false, counts: { refunds: 4, resent: 0 } });
    expect(stillUnclaimed).toHaveBeenCalledExactlyOnceWith(expect.anything(), [claimedMeanwhile]);
    expect(queue.removed).toEqual([]);
    // Every job is the one its producer added, in the state it was: nothing queued again, nothing sent twice.
    expect(queue.states).toEqual(before);
    expect(queue.states.get(finishedJob)).toBe("completed");
    expect(queue.jobs.size).toBe(4);
  });

  it("[FIX-W28-FOLLOWUPS AC2] counts no job a worker holds when the sweep would remove it", async () => {
    const id = refundId(1);
    const { instance, queue } = sweep([id]);
    const jobId = await held(queue, id, "failed");
    // Taken by a worker between the sweep's look at its state and the removal (another sweep queued it again).
    const remove = queue.remove.bind(queue);
    vi.spyOn(queue, "remove").mockImplementation((target: string) => {
      queue.move(target, "active");
      return remove(target);
    });

    expect(await instance.run(TENANT, jobOf())).toEqual({ more: false, counts: { refunds: 1, resent: 0 } });
    expect(queue.removed).toEqual([]);
    expect(queue.states.get(jobId)).toBe("active");
    expect(queue.jobs.size).toBe(1);
  });

  it("knows the finished states of BullMQ", () => {
    expect([...FINISHED_JOB_STATES].sort()).toEqual(["completed", "failed"]);
  });
});
