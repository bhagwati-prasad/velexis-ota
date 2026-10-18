// The failure handler without a database or Redis (PBE-023; flows/provisioning.md "Failure handling", PADR-0001 items 4
// and 7): what a failed attempt does to the job (re-queue with the backoff, or fail), and what a job that failed for
// good does besides, by kind. The repositories, the outbox and the audit are stand-ins that record their calls; the
// integration test (test/integration/provisioning/failures.int.test.ts) runs the same paths on PostgreSQL and Redis
// with the fake OTA worker.
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { AuditService } from "../audit/audit.service";
import type { Clock } from "../common/clock";
import type { PlatformDb } from "../common/database";
import type { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import type { MembershipsRepository } from "../memberships/memberships.repository";
import type { OutboxService } from "../notifications/outbox.service";
import type { TenantsRepository } from "../tenants/tenants.repository";
import {
  failureDecision,
  failureEffects,
  jobErrorText,
  ProvisioningFailureHandler,
  retryDelayMs,
  type JobFailure,
} from "./failure-handler";
import type {
  LockedJobRow,
  ProvisioningJobKind,
  ProvisioningJobsRepository,
} from "./provisioning-jobs.repository";

const JOB_ID = "job_01M4T9HVE0355QAKGD2AVSQWH2";
const TENANT_ID = "ten_01M4T9HVE0355QAKGD2AVSQWH3";

function lockedJob(overrides: Partial<LockedJobRow> = {}): LockedJobRow {
  return {
    id: JOB_ID,
    tenant_id: TENANT_ID,
    kind: "provision",
    status: "running",
    attempt: 1,
    max_attempts: 5,
    locked_until: new Date("2026-01-15T10:15:00.000Z"),
    locked_by: null,
    tenant_key: "acme",
    tenant_name: "Acme Travel",
    tenant_status: "provisioning",
    ...overrides,
  };
}

function failure(overrides: Partial<JobFailure> = {}): JobFailure {
  return {
    jobId: JOB_ID,
    attempt: 1,
    error: { code: "LOCK_TIMEOUT", message: "canceling statement due to lock timeout" },
    retryable: true,
    source: "event",
    ...overrides,
  };
}

/** A member of the tenant, as `listActive` returns it. */
function member(n: number, role: string) {
  return {
    id: `stf_01M4T9HVE0355QAKGD2AVSQWH${n}`,
    tenant_id: TENANT_ID,
    account_id: `acc_01M4T9HVE0355QAKGD2AVSQWH${n}`,
    role,
    status: "active",
    version: 1,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    full_name: `Person ${n}`,
    email: `person${n}@example.com`,
    mfa_enabled: false,
  };
}

interface HandlerOptions {
  readonly job?: LockedJobRow | undefined;
  /** What `tenants.failProvisioning` answers: true while the tenant is `provisioning`. */
  readonly tenantProvisioning?: boolean;
  /** What the conditional job updates answer: false when the job changed under the handler. */
  readonly jobUpdated?: boolean;
}

/** The handler over stand-ins that record their calls; the transaction is one plain object. */
function handlerWith(options: HandlerOptions = {}) {
  const trx = { transaction: "stand-in" };
  const job = "job" in options ? options.job : lockedJob();
  const jobs = {
    lockForLifecycle: vi.fn(() => Promise.resolve(job)),
    requeue: vi.fn(() => Promise.resolve(options.jobUpdated ?? true)),
    markFailed: vi.fn(() => Promise.resolve(options.jobUpdated ?? true)),
  };
  const tenants = { failProvisioning: vi.fn(() => Promise.resolve(options.tenantProvisioning ?? true)) };
  const memberships = {
    listActive: vi.fn(() => Promise.resolve([member(4, "owner"), member(5, "viewer"), member(6, "owner")])),
  };
  const outbox = {
    queue: vi.fn((_trx: unknown, _email: Record<string, unknown>) =>
      Promise.resolve({ emailId: "eml_x", queued: true }),
    ),
    queueOpsAlert: vi.fn((_trx: unknown, _alert: { title: string; message: string }) =>
      Promise.resolve({ emailId: "eml_y", queued: true }),
    ),
  };
  const audit = { record: vi.fn(() => Promise.resolve({ id: "1" })) };
  const invalidations = { publishAfterCommit: vi.fn() };
  const db = { transaction: () => ({ execute: <T>(fn: (t: unknown) => Promise<T>) => fn(trx) }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = new FakeClock("2026-01-15T10:20:00.000Z");
  const handler = new ProvisioningFailureHandler(
    jobs as unknown as ProvisioningJobsRepository,
    tenants as unknown as TenantsRepository,
    memberships as unknown as MembershipsRepository,
    outbox as unknown as OutboxService,
    audit as unknown as AuditService,
    invalidations as unknown as InvalidationPublisher,
    clock as unknown as Clock,
    db as unknown as PlatformDb,
    logger as unknown as PinoLogger,
  );
  return { handler, jobs, tenants, memberships, outbox, audit, invalidations, clock, logger, trx };
}

describe("failureDecision", () => {
  const now = new Date("2026-01-15T10:20:00.000Z");

  it("re-queues a retryable failure with 30 s × 2^attempt while attempts are left", () => {
    for (const attempt of [1, 2, 3, 4]) {
      expect(failureDecision(lockedJob({ attempt }), failure({ attempt }), now)).toEqual({
        action: "requeue",
        scheduledAt: new Date(now.getTime() + 30_000 * 2 ** attempt),
      });
    }
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
  });

  it("fails the job after the last attempt, and at once for an error that is not retried", () => {
    expect(failureDecision(lockedJob({ attempt: 5 }), failure({ attempt: 5 }), now)).toEqual({
      action: "fail",
    });
    expect(failureDecision(lockedJob(), failure({ retryable: false }), now)).toEqual({ action: "fail" });
  });

  it("changes nothing for an unknown job, another attempt, a job that is not running, or a lease that was extended", () => {
    expect(failureDecision(undefined, failure(), now)).toEqual({ action: "ignore", reason: "unknown_job" });
    expect(failureDecision(lockedJob({ attempt: 2 }), failure(), now)).toEqual({
      action: "ignore",
      reason: "stale_attempt",
    });
    for (const status of ["queued", "succeeded", "failed", "canceled"] as const) {
      expect(failureDecision(lockedJob({ status }), failure(), now)).toEqual({
        action: "ignore",
        reason: "not_running",
      });
    }
    const extended = lockedJob({ locked_until: new Date(now.getTime() + 1) });
    expect(failureDecision(extended, failure({ leaseEndedBy: now }), now)).toEqual({
      action: "ignore",
      reason: "lease_active",
    });
    expect(
      failureDecision(lockedJob({ locked_until: now }), failure({ leaseEndedBy: now }), now),
    ).toMatchObject({
      action: "requeue",
    });
  });
});

describe("failureEffects and the job's error", () => {
  it("[PBE-023 AC4] lets only a provision job touch the tenant's status; ops hear of every kind", () => {
    const kinds: ProvisioningJobKind[] = ["provision", "migrate", "suspend", "resume", "export", "delete"];
    expect(kinds.map((kind) => [kind, failureEffects(kind)])).toEqual([
      ["provision", { failTenant: true, opsAlert: true }],
      ["migrate", { failTenant: false, opsAlert: true }],
      ["suspend", { failTenant: false, opsAlert: true }],
      ["resume", { failTenant: false, opsAlert: true }],
      ["export", { failTenant: false, opsAlert: true }],
      ["delete", { failTenant: false, opsAlert: true }],
    ]);
  });

  it("names the step and the code, and keeps at most 1,000 characters", () => {
    expect(jobErrorText(failure({ step: "run_migrations" }))).toBe(
      "run_migrations failed: LOCK_TIMEOUT: canceling statement due to lock timeout",
    );
    expect(jobErrorText(failure())).toBe("LOCK_TIMEOUT: canceling statement due to lock timeout");
    expect(jobErrorText(failure({ error: { code: "X1", message: "y".repeat(2000) } }))).toHaveLength(1000);
  });
});

describe("ProvisioningFailureHandler", () => {
  it("re-queues a retryable failure with the backoff, the OTA worker's steps and the error, and nothing else", async () => {
    const { handler, jobs, tenants, outbox, audit, invalidations, clock } = handlerWith();
    const steps = [
      { step: "create_schema", status: "succeeded" as const, startedAt: "x", finishedAt: "x" },
      {
        step: "run_migrations",
        status: "failed" as const,
        startedAt: "x",
        finishedAt: "x",
        error: { code: "LOCK_TIMEOUT", message: "canceling statement due to lock timeout" },
      },
    ];

    const outcome = await handler.handle(failure({ step: "run_migrations", steps }));

    const scheduledAt = new Date(clock.now().getTime() + 60_000);
    expect(outcome).toEqual({ outcome: "requeued", jobId: JOB_ID, attempt: 1, scheduledAt });
    expect(jobs.requeue).toHaveBeenCalledWith(expect.anything(), {
      jobId: JOB_ID,
      attempt: 1,
      error: "run_migrations failed: LOCK_TIMEOUT: canceling statement due to lock timeout",
      entries: steps,
      step: "run_migrations",
      now: clock.now(),
      scheduledAt,
    });
    expect(jobs.markFailed).not.toHaveBeenCalled();
    expect(tenants.failProvisioning).not.toHaveBeenCalled();
    expect(outbox.queue).not.toHaveBeenCalled();
    expect(outbox.queueOpsAlert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(invalidations.publishAfterCommit).not.toHaveBeenCalled();
  });

  it.each(["suspend", "resume", "migrate"] as const)(
    "[PBE-023 AC4] an exhausted %s job leaves tenants.status unchanged and sends only ops.alert",
    async (kind) => {
      const tenantStatus = kind === "resume" ? "suspended" : "active";
      const { handler, jobs, tenants, memberships, outbox, audit, invalidations } = handlerWith({
        job: lockedJob({ kind, attempt: 5, tenant_status: tenantStatus }),
      });

      const outcome = await handler.handle(failure({ attempt: 5, source: "reconciler" }));

      expect(outcome).toEqual({ outcome: "failed", jobId: JOB_ID, kind, attempt: 5, tenantFailed: false });
      expect(jobs.markFailed).toHaveBeenCalledTimes(1);
      expect(jobs.requeue).not.toHaveBeenCalled();
      expect(tenants.failProvisioning).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(memberships.listActive).not.toHaveBeenCalled();
      expect(outbox.queue).not.toHaveBeenCalled();
      expect(invalidations.publishAfterCommit).not.toHaveBeenCalled();
      expect(outbox.queueOpsAlert).toHaveBeenCalledTimes(1);
      expect(outbox.queueOpsAlert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          title: `Provisioning job failed: ${kind} of acme`,
          tenantId: TENANT_ID,
          idempotencyKey: `provisioning.failed:${JOB_ID}`,
        }),
      );
      expect(outbox.queueOpsAlert.mock.calls[0]?.[1].message).toContain(`a ${kind} job never changes it`);
    },
  );

  it("[PBE-023 AC4] a suspend, resume or migrate job that fails at once (not retryable) leaves the tenant alone too", async () => {
    for (const kind of ["suspend", "resume", "migrate"] as const) {
      const { handler, tenants, outbox } = handlerWith({ job: lockedJob({ kind, tenant_status: "active" }) });

      await expect(handler.handle(failure({ retryable: false }))).resolves.toMatchObject({
        outcome: "failed",
        tenantFailed: false,
      });
      expect(tenants.failProvisioning).not.toHaveBeenCalled();
      expect(outbox.queue).not.toHaveBeenCalled();
      expect(outbox.queueOpsAlert).toHaveBeenCalledTimes(1);
    }
  });

  it("[PBE-023 AC4] only an exhausted provision job of a provisioning tenant sets the tenant failed, audits it and tells the owners", async () => {
    const { handler, jobs, tenants, outbox, audit, invalidations, clock } = handlerWith({
      job: lockedJob({ attempt: 5 }),
    });

    const outcome = await handler.handle(failure({ attempt: 5, requestId: "req-provision-failed-1" }));

    expect(outcome).toEqual({
      outcome: "failed",
      jobId: JOB_ID,
      kind: "provision",
      attempt: 5,
      tenantFailed: true,
    });
    expect(jobs.markFailed).toHaveBeenCalledWith(expect.anything(), {
      jobId: JOB_ID,
      attempt: 5,
      error: "LOCK_TIMEOUT: canceling statement due to lock timeout",
      now: clock.now(),
    });
    expect(tenants.failProvisioning).toHaveBeenCalledWith(expect.anything(), TENANT_ID, clock.now());
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "system",
        action: "tenant.provisioning_failed",
        targetType: "tenant",
        targetId: TENANT_ID,
        before: { status: "provisioning" },
        after: { status: "failed" },
        requestId: "req-provision-failed-1",
      }),
    );
    // The two owners, not the viewer, each once for this job.
    expect(outbox.queue.mock.calls.map(([, email]) => email)).toEqual([
      expect.objectContaining({
        templateKey: "tenant.provisioning_failed",
        to: "person4@example.com",
        data: { fullName: "Person 4", tenantName: "Acme Travel", tenantKey: "acme" },
        idempotencyKey: JOB_ID,
      }),
      expect.objectContaining({ templateKey: "tenant.provisioning_failed", to: "person6@example.com" }),
    ]);
    expect(invalidations.publishAfterCommit).toHaveBeenCalledWith(expect.anything(), {
      v: 1,
      type: "tenant",
      id: TENANT_ID,
    });
    expect(outbox.queueOpsAlert).toHaveBeenCalledTimes(1);
    expect(outbox.queueOpsAlert.mock.calls[0]?.[1].message).toContain("The OTA is now failed");
  });

  it("[PBE-023 AC4] fails a provision job without touching a tenant that is no longer provisioning: ops.alert only", async () => {
    const { handler, outbox, audit, invalidations } = handlerWith({
      job: lockedJob({ tenant_status: "suspended" }),
      tenantProvisioning: false,
    });

    await expect(handler.handle(failure({ retryable: false }))).resolves.toMatchObject({
      outcome: "failed",
      tenantFailed: false,
    });
    expect(audit.record).not.toHaveBeenCalled();
    expect(outbox.queue).not.toHaveBeenCalled();
    expect(invalidations.publishAfterCommit).not.toHaveBeenCalled();
    expect(outbox.queueOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("names a failed post-step in the job's error and step", async () => {
    const { handler, jobs } = handlerWith({ job: lockedJob({ attempt: 2 }) });

    await handler.handle(
      failure({
        attempt: 2,
        retryable: false,
        source: "post_steps",
        step: "create_payment_connection",
        error: { code: "23505", message: "The post-step failed on every try." },
      }),
    );

    expect(jobs.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "create_payment_connection",
        error: "create_payment_connection failed: 23505: The post-step failed on every try.",
      }),
    );
  });

  it("changes nothing and sends nothing when the job moved on: another attempt, not running, or changed under the lock", async () => {
    const stale = handlerWith({ job: lockedJob({ attempt: 2 }) });
    await expect(stale.handler.handle(failure())).resolves.toEqual({
      outcome: "ignored",
      jobId: JOB_ID,
      reason: "stale_attempt",
    });
    expect(stale.jobs.requeue).not.toHaveBeenCalled();

    const requeued = handlerWith({ job: lockedJob({ status: "queued" }) });
    await expect(requeued.handler.handle(failure())).resolves.toMatchObject({ reason: "not_running" });

    const unknown = handlerWith({ job: undefined });
    await expect(unknown.handler.handle(failure())).resolves.toMatchObject({ reason: "unknown_job" });

    const raced = handlerWith({ job: lockedJob({ attempt: 5 }), jobUpdated: false });
    await expect(raced.handler.handle(failure({ attempt: 5 }))).resolves.toMatchObject({
      outcome: "ignored",
      reason: "not_running",
    });
    for (const { tenants, outbox } of [stale, requeued, unknown, raced]) {
      expect(tenants.failProvisioning).not.toHaveBeenCalled();
      expect(outbox.queueOpsAlert).not.toHaveBeenCalled();
    }
  });
});
