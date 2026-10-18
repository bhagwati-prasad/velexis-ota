// The reconciler without a database or Redis (PBE-023; flows/provisioning.md "Failure handling", PADR-0001 item 6 and
// its follow-up): what it does with a `running` job whose lease ended, from the BullMQ states of the attempt's message
// and answer, the one alert of a job running across two leases, and which due `queued` jobs it dispatches. The
// repositories, the queues, the dispatcher and the failure handler are stand-ins that record their calls; the
// integration test (test/integration/provisioning/failures.int.test.ts) runs it on PostgreSQL and Redis with the fake
// OTA worker.
import { FakeClock } from "@velexis/testing";
import type { Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../common/clock";
import type { PlatformDb } from "../common/database";
import type { OutboxService } from "../notifications/outbox.service";
import { DISPATCH_LEASE_MS, type DispatchResult, type ProvisioningDispatcher } from "./dispatcher";
import type { FailureOutcome, JobFailure, ProvisioningFailureHandler } from "./failure-handler";
import {
  LEASE_EXTENDED_BY,
  type DispatchCandidateRow,
  type ExpiredLeaseRow,
  type LockedJobRow,
  type ProvisioningJobsRepository,
} from "./provisioning-jobs.repository";
import {
  ATTEMPT_LOST_CODE,
  leaseDecision,
  ReconcilerScheduler,
  type BullmqJobState,
} from "./reconciler.scheduler";

const NOW = new Date("2026-01-15T10:30:00.000Z");
/** A lease that ended a minute ago. */
const ENDED = new Date(NOW.getTime() - 60_000);

function jobId(n: number): string {
  return `job_01M4T9HVE0355QAKGD2AVSQW${String(n).padStart(2, "0")}`;
}

function expired(n: number, overrides: Partial<ExpiredLeaseRow> = {}): ExpiredLeaseRow {
  return {
    id: jobId(n),
    tenant_id: "ten_01M4T9HVE0355QAKGD2AVSQWH3",
    kind: "provision",
    attempt: 1,
    locked_until: ENDED,
    ...overrides,
  };
}

function locked(row: ExpiredLeaseRow, overrides: Partial<LockedJobRow> = {}): LockedJobRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    kind: row.kind,
    status: "running",
    attempt: row.attempt,
    max_attempts: 5,
    locked_until: row.locked_until,
    locked_by: null,
    tenant_key: "acme",
    tenant_name: "Acme Travel",
    tenant_status: "provisioning",
    ...overrides,
  };
}

function candidate(n: number, overrides: Partial<DispatchCandidateRow> = {}): DispatchCandidateRow {
  return {
    id: jobId(n),
    tenant_id: "ten_01M4T9HVE0355QAKGD2AVSQWH3",
    kind: "provision",
    status: "queued",
    scheduled_at: ENDED,
    payload: {},
    tenant_status: "provisioning",
    subscription_status: "trialing",
    billing_provider: "manual",
    ...overrides,
  };
}

interface Setup {
  readonly expiredLeases?: readonly ExpiredLeaseRow[];
  /** The job as the transaction reads it under its lock, by id; default: as listed, `running`, not extended. */
  readonly lockedRows?: Readonly<Record<string, LockedJobRow | undefined>>;
  /** BullMQ states by queue and id; `unknown` when absent. */
  readonly messages?: Readonly<Record<string, BullmqJobState>>;
  readonly answers?: Readonly<Record<string, BullmqJobState>>;
  readonly due?: readonly DispatchCandidateRow[];
  readonly failure?: (failure: JobFailure) => Promise<FailureOutcome>;
}

function reconcilerWith(setup: Setup = {}) {
  const listed = setup.expiredLeases ?? [];
  const jobs = {
    listExpiredLeases: vi.fn((_now: Date, _limit: number) => Promise.resolve([...listed])),
    lockForLifecycle: vi.fn((_trx: unknown, id: string) => {
      if (setup.lockedRows !== undefined && id in setup.lockedRows) {
        return Promise.resolve(setup.lockedRows[id]);
      }
      const row = listed.find((job) => job.id === id);
      return Promise.resolve(row === undefined ? undefined : locked(row));
    }),
    extendLease: vi.fn((_trx: unknown, _lease: Record<string, unknown>) => Promise.resolve(true)),
    listDueQueued: vi.fn((_now: Date, _kinds: readonly string[], _limit: number, _after?: unknown) =>
      Promise.resolve([...(setup.due ?? [])]),
    ),
  };
  const queue = (states: Readonly<Record<string, BullmqJobState>> = {}) => ({
    getJobState: vi.fn((id: string) => Promise.resolve(states[id] ?? "unknown")),
  });
  const tenantOps = queue(setup.messages);
  const tenantEvents = queue(setup.answers);
  const dispatcher = {
    dispatch: vi.fn((id: string, _options: { requestId?: string }): Promise<DispatchResult> =>
      Promise.resolve({
        dispatched: true,
        jobId: id,
        tenantId: "ten_01M4T9HVE0355QAKGD2AVSQWH3",
        kind: "provision",
        attempt: 2,
        bullmqJobId: `${id}-2`,
        enqueued: true,
      }),
    ),
  };
  const failures = {
    handle: vi.fn(
      setup.failure ??
        ((failure: JobFailure): Promise<FailureOutcome> =>
          Promise.resolve({
            outcome: "requeued",
            jobId: failure.jobId,
            attempt: failure.attempt,
            scheduledAt: new Date(NOW.getTime() + 60_000),
          })),
    ),
  };
  const outbox = {
    queueOpsAlert: vi.fn((_trx: unknown, _alert: { title: string; idempotencyKey?: string }) =>
      Promise.resolve({ emailId: "eml_x", queued: true }),
    ),
  };
  const db = { transaction: () => ({ execute: <T>(fn: (t: unknown) => Promise<T>) => fn({}) }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const reconciler = new ReconcilerScheduler(
    jobs as unknown as ProvisioningJobsRepository,
    dispatcher as unknown as ProvisioningDispatcher,
    failures as unknown as ProvisioningFailureHandler,
    outbox as unknown as OutboxService,
    new FakeClock(NOW) as unknown as Clock,
    db as unknown as PlatformDb,
    tenantOps as unknown as Queue,
    tenantEvents as unknown as Queue,
    logger as unknown as PinoLogger,
  );
  return { reconciler, jobs, tenantOps, tenantEvents, dispatcher, failures, outbox, logger };
}

describe("leaseDecision", () => {
  it("extends the lease while the attempt's message or its answer is still to run or running", () => {
    for (const state of ["waiting", "active", "delayed", "prioritized", "waiting-children"] as const) {
      expect(leaseDecision(state, "unknown")).toEqual({ action: "extend", pending: "message" });
      expect(leaseDecision("failed", state)).toEqual({ action: "extend", pending: "answer" });
      expect(leaseDecision("completed", state)).toEqual({ action: "extend", pending: "answer" });
    }
  });

  it("[PBE-023 AC3] counts the attempt as lost when its message is missing, or failed without an answer", () => {
    expect(leaseDecision("unknown", "unknown")).toEqual({
      action: "lost",
      message:
        "Its message is missing from ota-tenant-ops without an answer; the attempt ended with its lease.",
    });
    expect(leaseDecision("failed", "unknown")).toEqual({
      action: "lost",
      message: "Its message failed without an answer; the attempt ended with its lease.",
    });
    expect(leaseDecision("completed", "failed")).toMatchObject({ action: "lost" });
    expect(leaseDecision("failed", "completed")).toMatchObject({ action: "lost" });
  });
});

describe("ReconcilerScheduler", () => {
  it("[PBE-023 AC3] hands a lost attempt of any kind to the failure handler as a retryable failure, and extends a pending one", async () => {
    const lost = [expired(1), expired(2, { kind: "suspend" }), expired(3, { kind: "migrate", attempt: 2 })];
    const pending = expired(4, { attempt: 3 });
    const { reconciler, jobs, failures, tenantOps, tenantEvents } = reconcilerWith({
      expiredLeases: [...lost, pending],
      messages: { [`${jobId(1)}-1`]: "failed", [`${jobId(4)}-3`]: "active" },
    });

    const result = await reconciler.run();

    expect(jobs.listExpiredLeases).toHaveBeenCalledWith(NOW, 100);
    expect(tenantOps.getJobState.mock.calls.map(([id]) => id)).toEqual([
      `${jobId(1)}-1`,
      `${jobId(2)}-1`,
      `${jobId(3)}-2`,
      `${jobId(4)}-3`,
    ]);
    expect(tenantEvents.getJobState).toHaveBeenCalledTimes(4);
    expect(failures.handle.mock.calls.map(([failure]) => failure)).toEqual(
      lost.map((job) =>
        expect.objectContaining({
          jobId: job.id,
          attempt: job.attempt,
          retryable: true,
          source: "reconciler",
          leaseEndedBy: NOW,
          error: expect.objectContaining({ code: ATTEMPT_LOST_CODE }) as unknown,
        }),
      ),
    );
    expect(jobs.extendLease).toHaveBeenCalledTimes(1);
    expect(jobs.extendLease).toHaveBeenCalledWith(expect.anything(), {
      jobId: pending.id,
      attempt: 3,
      lockedUntil: new Date(NOW.getTime() + DISPATCH_LEASE_MS),
      now: NOW,
    });
    expect(result).toEqual({ leasesExtended: 1, stuckAlerts: 0, attemptsLost: 3, dispatched: 0, errors: 0 });
  });

  it("extends the lease while the OTA worker's answer is still being processed", async () => {
    const job = expired(1);
    const { reconciler, jobs, failures } = reconcilerWith({
      expiredLeases: [job],
      messages: { [`${job.id}-1`]: "completed" },
      answers: { [`${job.id}-1`]: "delayed" },
    });

    await expect(reconciler.run()).resolves.toMatchObject({ leasesExtended: 1, attemptsLost: 0 });
    expect(jobs.extendLease).toHaveBeenCalledTimes(1);
    expect(failures.handle).not.toHaveBeenCalled();
  });

  it("looks up the answer only after the message, so an answer added as the message finished is not missed", async () => {
    const job = expired(1);
    const id = `${job.id}-1`;
    const { reconciler, jobs, failures, tenantOps, tenantEvents } = reconcilerWith({ expiredLeases: [job] });
    // The OTA worker adds its answer, then its message completes: an answer look-up made before the message's
    // finds nothing yet; one made after it finds the answer waiting.
    let messageSeen = false;
    tenantOps.getJobState.mockImplementation(async () => {
      await Promise.resolve();
      messageSeen = true;
      return "completed";
    });
    tenantEvents.getJobState.mockImplementation(() => Promise.resolve(messageSeen ? "waiting" : "unknown"));

    await expect(reconciler.run()).resolves.toMatchObject({ leasesExtended: 1, attemptsLost: 0 });
    expect(tenantEvents.getJobState).toHaveBeenCalledWith(id);
    expect(jobs.extendLease).toHaveBeenCalledTimes(1);
    expect(failures.handle).not.toHaveBeenCalled();
  });

  it("sends one ops.alert when a job stays running across two leases", async () => {
    const first = expired(1);
    const again = expired(2, { attempt: 2 });
    const { reconciler, jobs, outbox } = reconcilerWith({
      expiredLeases: [first, again],
      messages: { [`${first.id}-1`]: "waiting", [`${again.id}-2`]: "active" },
      // The second job's lease was extended by the reconciler once already, and has ended again.
      lockedRows: { [again.id]: locked(again, { locked_by: LEASE_EXTENDED_BY }) },
    });

    const result = await reconciler.run();

    expect(jobs.extendLease).toHaveBeenCalledTimes(2);
    expect(outbox.queueOpsAlert).toHaveBeenCalledTimes(1);
    expect(outbox.queueOpsAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "Provisioning job still running after two leases: provision of acme",
        idempotencyKey: `provisioning.reconcile.stuck:${again.id}:2`,
      }),
    );
    expect(result).toMatchObject({ leasesExtended: 2, stuckAlerts: 1 });
  });

  it("never touches a job that is inside its lease again, or moved on, when it is read under its lock", async () => {
    const extendedMeanwhile = expired(1);
    const succeeded = expired(2);
    const redispatched = expired(3);
    const { reconciler, jobs, outbox } = reconcilerWith({
      expiredLeases: [extendedMeanwhile, succeeded, redispatched],
      messages: Object.fromEntries(
        [extendedMeanwhile, succeeded, redispatched].map((job) => [`${job.id}-1`, "active" as const]),
      ),
      lockedRows: {
        [extendedMeanwhile.id]: locked(extendedMeanwhile, { locked_until: new Date(NOW.getTime() + 1) }),
        [succeeded.id]: locked(succeeded, { status: "succeeded", locked_until: null }),
        [redispatched.id]: locked(redispatched, { attempt: 2 }),
      },
    });

    await expect(reconciler.run()).resolves.toMatchObject({ leasesExtended: 0, stuckAlerts: 0 });
    expect(jobs.extendLease).not.toHaveBeenCalled();
    expect(outbox.queueOpsAlert).not.toHaveBeenCalled();
  });

  it("does not count a lost attempt the failure handler ignored (the job moved on meanwhile)", async () => {
    const job = expired(1);
    const { reconciler } = reconcilerWith({
      expiredLeases: [job],
      failure: (failure) =>
        Promise.resolve({ outcome: "ignored", jobId: failure.jobId, reason: "lease_active" }),
    });

    await expect(reconciler.run()).resolves.toMatchObject({ attemptsLost: 0, errors: 0 });
  });

  it("dispatches the due queued jobs whose gate is open, with the run's request id, and leaves the others", async () => {
    const open = candidate(1);
    const migrate = candidate(2, { kind: "migrate", tenant_status: "active", subscription_status: null });
    const unpaid = candidate(3, { subscription_status: "incomplete", billing_provider: "stripe" });
    const failedTenant = candidate(4, { tenant_status: "failed" });
    const { reconciler, jobs, dispatcher } = reconcilerWith({ due: [open, migrate, unpaid, failedTenant] });

    const result = await reconciler.run();

    expect(jobs.listDueQueued).toHaveBeenCalledWith(
      NOW,
      ["provision", "migrate", "suspend", "resume"],
      100,
      undefined,
    );
    expect(dispatcher.dispatch.mock.calls.map(([id]) => id)).toEqual([open.id, migrate.id]);
    const requestIds = new Set(dispatcher.dispatch.mock.calls.map(([, options]) => options.requestId));
    expect(requestIds.size).toBe(1);
    expect(result).toMatchObject({ dispatched: 2 });
  });

  it("goes on with the other jobs when one fails, and counts the error", async () => {
    const broken = expired(1);
    const fine = expired(2);
    const { reconciler, failures, logger } = reconcilerWith({
      expiredLeases: [broken, fine],
      failure: (failure) =>
        failure.jobId === broken.id
          ? Promise.reject(new Error("connection terminated unexpectedly"))
          : Promise.resolve({
              outcome: "requeued",
              jobId: failure.jobId,
              attempt: 1,
              scheduledAt: new Date(NOW.getTime() + 60_000),
            }),
    });

    await expect(reconciler.run()).resolves.toMatchObject({ attemptsLost: 1, errors: 1 });
    expect(failures.handle).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls.map(([, message]: unknown[]) => message)).toEqual([
      "provisioning.reconcile_failed",
    ]);
  });
});
