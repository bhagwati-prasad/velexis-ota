// The tenant-event consumer and the post-step bookkeeping without a database or Redis (PBE-022; flows/provisioning.md
// §3, PADR-0001 item 5): the attempt of an event from its BullMQ id, which `tenant.provisioned` events run the
// post-steps and which are ignored, the step log the runner resumes from, when a run stops, and the error a failed step
// leaves in the log; (PBE-023) which `tenant.provision_failed` events go to the failure handler, and when failed
// post-steps fail the job; and (PBE-030) where the migrate, suspend and resume answers go. The integration tests
// (test/integration/provisioning/post-steps.int.test.ts, failures.int.test.ts, suspension.int.test.ts and
// migrate.int.test.ts) run the whole chain on PostgreSQL and Redis with the fake OTA worker.
import migratedFanOutFixture from "@velexis/api-types/fixtures/jobs/tenant-migrated-fanout.json";
import provisionFailedFixture from "@velexis/api-types/fixtures/jobs/tenant-provision-failed.json";
import provisionedFixture from "@velexis/api-types/fixtures/jobs/tenant-provisioned.json";
import {
  validateJob,
  type TenantMigratedEvent,
  type TenantProvisionedEvent,
  type TenantProvisionFailedEvent,
} from "@velexis/api-types/jobs";
import type { Job } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FailureOutcome, JobFailure, ProvisioningFailureHandler } from "./failure-handler";
import type { MigrateJobAnswer, MigratedOutcome, MigrateService } from "./migrate.service";
import {
  completedPostSteps,
  POST_STEP_NAMES,
  PostStepError,
  postStepsFinished,
  stepErrorOf,
  stepLog,
  stopReason,
  type PostStepsRunner,
} from "./post-steps/post-steps.runner";
import type { PostStepJobRow, ProvisioningJobsRepository } from "./provisioning-jobs.repository";
import type { AnswerOutcome, SuspensionService } from "./suspension.service";
import {
  answerAttemptIgnoreReason,
  eventAttempt,
  failedOtaStep,
  isLastTry,
  POST_STEPS_EXHAUSTED_MESSAGE,
  provisionedEventIgnoreReason,
  provisionFailedEventIgnoreReason,
  TenantEventsProcessor,
} from "./tenant-events.processor";

const JOB_ID = "job_01M4T9HVE0355QAKGD2AVSQWH2";
const AT = "2026-01-15T10:00:00.000Z";

let event: TenantProvisionedEvent;
let failedEvent: TenantProvisionFailedEvent;
let fanOutEvent: TenantMigratedEvent;

beforeAll(() => {
  // validateJob compiles every message schema with Ajv on its first call: once here, not inside a test. 30 s covers a
  // slow CI runner.
  event = validateJob("tenant.provisioned", provisionedFixture);
  // The failure of the same job and tenant as the success fixture.
  failedEvent = validateJob("tenant.provision_failed", {
    ...provisionFailedFixture,
    tenantId: event.tenantId,
  });
  fanOutEvent = validateJob("tenant.migrated", migratedFanOutFixture);
}, 30_000);

/** A log entry of `step` with `status`. */
function entry(step: string, status: "succeeded" | "failed" | "skipped") {
  return { step, status, startedAt: AT, finishedAt: AT };
}

/** The log after the OTA run and the post-steps up to `last` (included), all succeeded. */
function logUpTo(last: (typeof POST_STEP_NAMES)[number]) {
  const steps = POST_STEP_NAMES.slice(0, POST_STEP_NAMES.indexOf(last) + 1);
  return [
    entry("create_schema", "succeeded"),
    entry("run_migrations", "succeeded"),
    entry("seed_defaults", "succeeded"),
    ...steps.map((step) => entry(step, "succeeded")),
  ];
}

function job(overrides: Partial<PostStepJobRow> = {}): PostStepJobRow {
  return {
    id: event.jobId,
    tenant_id: event.tenantId,
    kind: "provision",
    status: "running",
    attempt: 1,
    steps: [],
    result: null,
    tenant_key: "acme",
    tenant_name: "Acme Travel",
    tenant_status: "provisioning",
    tenant_schema_name: event.payload.schemaName,
    ...overrides,
  };
}

describe("eventAttempt", () => {
  it("reads the attempt of <jobId>-<attempt> when the id names the event's own job", () => {
    expect(eventAttempt(`${JOB_ID}-1`, JOB_ID)).toBe(1);
    expect(eventAttempt(`${JOB_ID}-12`, JOB_ID)).toBe(12);
  });

  it("has none for another job's id, an id BullMQ generated, no id, or a fan-out report without a job", () => {
    expect(eventAttempt("job_01M4T9HVE0355QAKGD2AVSQWH3-1", JOB_ID)).toBeUndefined();
    expect(eventAttempt("42", JOB_ID)).toBeUndefined();
    expect(eventAttempt(undefined, JOB_ID)).toBeUndefined();
    expect(eventAttempt(`${JOB_ID}-1`, null)).toBeUndefined();
  });
});

describe("provisionedEventIgnoreReason", () => {
  it("[PBE-022 AC2] runs the post-steps for the job's current attempt while it is queued or running", () => {
    expect(provisionedEventIgnoreReason(job(), 1)).toBeUndefined();
    expect(provisionedEventIgnoreReason(job({ status: "queued", attempt: 2 }), 2)).toBeUndefined();
  });

  it("[PBE-022 AC2] ignores an event of an older attempt, and one of an attempt no dispatch made", () => {
    expect(provisionedEventIgnoreReason(job({ attempt: 2 }), 1)).toBe("stale_attempt");
    expect(provisionedEventIgnoreReason(job({ attempt: 2 }), 3)).toBe("unknown_attempt");
  });

  it("[PBE-022 AC2] ignores the events of failed and canceled jobs, and of succeeded jobs whose post-steps are done", () => {
    expect(provisionedEventIgnoreReason(job({ status: "failed" }), 1)).toBe("finished");
    expect(provisionedEventIgnoreReason(job({ status: "canceled" }), 1)).toBe("finished");
    expect(provisionedEventIgnoreReason(job({ status: "succeeded", steps: logUpTo("notify") }), 1)).toBe(
      "finished",
    );
  });

  it("[PBE-022 AC4] resumes a succeeded job whose notify step has not run (a crash between activate and notify)", () => {
    expect(
      provisionedEventIgnoreReason(job({ status: "succeeded", steps: logUpTo("activate") }), 1),
    ).toBeUndefined();
  });

  it("ignores the event of a job of another kind", () => {
    expect(provisionedEventIgnoreReason(job({ kind: "migrate" }), 1)).toBe("other_kind");
  });
});

describe("the step log", () => {
  it("[PBE-022 AC4] counts a post-step as done once it succeeded or was skipped, also after a failed try", () => {
    const steps = [
      ...logUpTo("issue_api_keys").map((item) =>
        item.step === "assign_amadeus_office" ? { ...item, status: "skipped" } : item,
      ),
      {
        ...entry("activate", "failed"),
        error: { code: "40001", message: "The step failed (DatabaseError)." },
      },
    ];

    expect([...completedPostSteps(steps)]).toEqual([
      "record_migrations",
      "assign_amadeus_office",
      "create_payment_connection",
      "issue_api_keys",
    ]);
    expect(postStepsFinished(steps)).toBe(false);
    expect(completedPostSteps([...steps, entry("activate", "succeeded")]).has("activate")).toBe(true);
    expect(postStepsFinished(logUpTo("notify"))).toBe(true);
  });

  it("reads only entries of the step record's shape from a stored log", () => {
    expect(stepLog(null)).toEqual([]);
    expect(stepLog({ step: "activate" })).toEqual([]);
    expect(
      stepLog([entry("activate", "succeeded"), { step: "notify", status: "done" }, "notify", null]),
    ).toEqual([entry("activate", "succeeded")]);
  });

  it("[PBE-022 AC2] stops a run when the job's attempt changed or the job is no longer active, except notify after activate", () => {
    expect(stopReason({ status: "running", attempt: 1 }, "record_migrations", 1)).toBeUndefined();
    expect(stopReason({ status: "running", attempt: 2 }, "record_migrations", 1)).toBe("superseded");
    expect(stopReason({ status: "succeeded", attempt: 1 }, "activate", 1)).toBe("finished");
    expect(stopReason({ status: "succeeded", attempt: 1 }, "notify", 1)).toBeUndefined();
    expect(stopReason({ status: "failed", attempt: 1 }, "notify", 1)).toBe("finished");
  });

  it("logs a failed step with the error's code, never its message", () => {
    const database = Object.assign(new Error("duplicate key value: Key (prefix)=(sk_test_AbCdEf) exists"), {
      code: "23505",
    });
    expect(stepErrorOf(database)).toEqual({
      code: "23505",
      message: "The step failed (Error); the event is tried again.",
    });
    expect(stepErrorOf(new TypeError("value 42 is wrong"))).toEqual({
      code: "POST_STEP_FAILED",
      message: "The step failed (TypeError); the event is tried again.",
    });
    expect(JSON.stringify(stepErrorOf(database))).not.toContain("sk_test");
  });
});

describe("TenantEventsProcessor", () => {
  function processor(found: PostStepJobRow | undefined) {
    const jobs = { findForEvent: vi.fn(() => Promise.resolve(found)) };
    const runner = {
      run: vi.fn((_event: TenantProvisionedEvent, _attempt: number): Promise<unknown> =>
        Promise.resolve({ outcome: "completed" as const, steps: [] }),
      ),
    };
    const failures = {
      handle: vi.fn((failure: JobFailure): Promise<FailureOutcome> =>
        Promise.resolve({
          outcome: "requeued",
          jobId: failure.jobId,
          attempt: failure.attempt,
          scheduledAt: new Date("2026-01-15T10:01:00.000Z"),
        }),
      ),
    };
    const migrations = {
      recordMigrated: vi.fn(
        (_event: TenantMigratedEvent, _answer?: MigrateJobAnswer): Promise<MigratedOutcome> =>
          Promise.resolve({
            outcome: "mirrored",
            schemaVersion: "0001_baseline",
            versionChanged: true,
            jobSucceeded: false,
          }),
      ),
      recordFanOutFailure: vi.fn(() => Promise.resolve({ outcome: "alerted" as const, queued: true })),
    };
    const suspensions = {
      markAnswered: vi.fn((): Promise<AnswerOutcome> => Promise.resolve({ outcome: "succeeded" })),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return {
      runner,
      failures,
      migrations,
      suspensions,
      logger,
      instance: new TenantEventsProcessor(
        jobs as unknown as ProvisioningJobsRepository,
        runner as unknown as PostStepsRunner,
        failures as unknown as ProvisioningFailureHandler,
        migrations as unknown as MigrateService,
        suspensions as unknown as SuspensionService,
        logger as unknown as PinoLogger,
      ),
    };
  }

  function bullmqJob(name: string, data: unknown, id = `${event.jobId}-1`, tries?: Partial<Job>): Job {
    return { id, name, data, ...tries } as Job;
  }

  it("[PBE-022 AC2] fails an invalid message at once, naming paths and rules only", async () => {
    const { instance, runner, logger } = processor(job());
    const data = { ...event, payload: { ...event.payload, clientSecret: "not-a-real-secret" } };

    await expect(instance.process(bullmqJob("tenant.provisioned", data))).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    await expect(instance.process(bullmqJob("tenant.exploded", event))).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("not-a-real-secret");
  });

  it("[PBE-022 AC2] ignores an event of an older attempt without running a step", async () => {
    const { instance, runner } = processor(job({ attempt: 2 }));

    await expect(instance.process(bullmqJob("tenant.provisioned", event))).resolves.toEqual({
      outcome: "ignored",
      reason: "stale_attempt",
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("runs the post-steps of the current attempt", async () => {
    const { instance, runner } = processor(job());

    await expect(instance.process(bullmqJob("tenant.provisioned", event))).resolves.toEqual({
      outcome: "completed",
      steps: [],
    });
    expect(runner.run).toHaveBeenCalledWith(event, 1);
  });

  it("fails an event about another tenant or schema than its job's at once", async () => {
    const other = processor(job({ tenant_schema_name: "tenant_other" }));

    await expect(other.instance.process(bullmqJob("tenant.provisioned", event))).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    expect(other.runner.run).not.toHaveBeenCalled();
  });

  it("[PBE-023 AC2] hands tenant.provision_failed of the current attempt to the failure handler, with the OTA worker's steps", async () => {
    const { instance, failures, runner } = processor(job());

    await expect(instance.process(bullmqJob("tenant.provision_failed", failedEvent))).resolves.toEqual({
      outcome: "requeued",
      scheduledAt: "2026-01-15T10:01:00.000Z",
    });
    expect(failures.handle).toHaveBeenCalledWith({
      jobId: failedEvent.jobId,
      attempt: 1,
      error: failedEvent.payload.error,
      retryable: true,
      source: "event",
      steps: failedEvent.payload.steps,
      step: "run_migrations",
      requestId: failedEvent.requestId,
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("ignores tenant.provision_failed of an older attempt or another kind, and fails one about another tenant", async () => {
    const stale = processor(job({ attempt: 2 }));
    await expect(stale.instance.process(bullmqJob("tenant.provision_failed", failedEvent))).resolves.toEqual({
      outcome: "ignored",
      reason: "stale_attempt",
    });
    expect(stale.failures.handle).not.toHaveBeenCalled();

    expect(provisionFailedEventIgnoreReason(job({ kind: "migrate" }), 1)).toBe("other_kind");
    expect(provisionFailedEventIgnoreReason(job({ attempt: 1 }), 2)).toBe("unknown_attempt");

    const other = processor(job({ tenant_id: "ten_01M4T9E68084G7ZWYRD6Z1RV0X" }));
    await expect(
      other.instance.process(bullmqJob("tenant.provision_failed", failedEvent)),
    ).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    expect(other.failures.handle).not.toHaveBeenCalled();
  });

  it("passes the failure handler's ignored reason on: the attempt was counted as lost already", async () => {
    const { instance, failures } = processor(job());
    failures.handle.mockResolvedValueOnce({ outcome: "ignored", jobId: event.jobId, reason: "not_running" });

    await expect(instance.process(bullmqJob("tenant.provision_failed", failedEvent))).resolves.toEqual({
      outcome: "ignored",
      reason: "not_running",
    });
  });

  it("fails the job with the step's name when the post-steps fail on the event's last try, and not before", async () => {
    const { instance, runner, failures } = processor(job());
    const stepFailure = new PostStepError(
      "create_payment_connection",
      { code: "23505", message: "The step failed (Error); the event is tried again." },
      { cause: new Error("duplicate key") },
    );
    runner.run.mockRejectedValue(stepFailure);

    // Try 4 of 5: BullMQ tries again, so the job stays as it is.
    await expect(
      instance.process(
        bullmqJob("tenant.provisioned", event, undefined, { attemptsMade: 3, opts: { attempts: 5 } }),
      ),
    ).rejects.toBe(stepFailure);
    expect(failures.handle).not.toHaveBeenCalled();

    // Try 5 of 5: the last one.
    await expect(
      instance.process(
        bullmqJob("tenant.provisioned", event, undefined, { attemptsMade: 4, opts: { attempts: 5 } }),
      ),
    ).rejects.toBe(stepFailure);
    expect(failures.handle).toHaveBeenCalledWith({
      jobId: event.jobId,
      attempt: 1,
      error: { code: "23505", message: POST_STEPS_EXHAUSTED_MESSAGE },
      retryable: false,
      source: "post_steps",
      step: "create_payment_connection",
      requestId: event.requestId,
    });
  });

  it("knows the last try of a BullMQ job and the OTA worker's failed step", () => {
    expect(isLastTry({ attemptsMade: 0 })).toBe(true);
    expect(isLastTry({ attemptsMade: 0, opts: { attempts: 5 } })).toBe(false);
    expect(isLastTry({ attemptsMade: 4, opts: { attempts: 5 } })).toBe(true);
    expect(failedOtaStep(failedEvent.payload.steps)).toBe("run_migrations");
    expect(failedOtaStep([])).toBeUndefined();
  });

  it("marks a resume job's current attempt answered, and ignores a stale attempt or another kind", async () => {
    const resumed = { ...event, name: "tenant.resumed", payload: {} };
    const current = processor(job({ kind: "resume", status: "running" }));

    await expect(current.instance.process(bullmqJob("tenant.resumed", resumed))).resolves.toEqual({
      outcome: "succeeded",
    });
    expect(current.suspensions.markAnswered).toHaveBeenCalledWith({
      jobId: event.jobId,
      attempt: 1,
      kind: "resume",
    });
    expect(current.runner.run).not.toHaveBeenCalled();

    const stale = processor(job({ kind: "resume", attempt: 2 }));
    await expect(stale.instance.process(bullmqJob("tenant.resumed", resumed))).resolves.toEqual({
      outcome: "ignored",
      reason: "stale_attempt",
    });
    const otherKind = processor(job({ kind: "suspend" }));
    await expect(otherKind.instance.process(bullmqJob("tenant.resumed", resumed))).resolves.toEqual({
      outcome: "ignored",
      reason: "other_kind",
    });
    expect(stale.suspensions.markAnswered).not.toHaveBeenCalled();
    expect(otherKind.suspensions.markAnswered).not.toHaveBeenCalled();
  });

  it("mirrors a fan-out tenant.migrated without a job, and finishes a migrate job's current attempt", async () => {
    const fanOut = processor(undefined);
    await expect(fanOut.instance.process(bullmqJob("tenant.migrated", fanOutEvent, "42"))).resolves.toEqual({
      outcome: "mirrored",
      schemaVersion: "0001_baseline",
      versionChanged: true,
      jobSucceeded: false,
    });
    expect(fanOut.migrations.recordMigrated).toHaveBeenCalledWith(fanOutEvent, undefined);

    const migrated = { ...fanOutEvent, jobId: event.jobId, tenantId: event.tenantId };
    const answered = processor(job({ kind: "migrate" }));
    await answered.instance.process(bullmqJob("tenant.migrated", migrated));
    expect(answered.migrations.recordMigrated).toHaveBeenCalledWith(migrated, {
      jobId: event.jobId,
      attempt: 1,
    });

    // A stale answer still mirrors the ledger, but leaves the job alone.
    const stale = processor(job({ kind: "migrate", attempt: 2 }));
    await stale.instance.process(bullmqJob("tenant.migrated", migrated));
    expect(stale.migrations.recordMigrated).toHaveBeenCalledWith(migrated, undefined);
  });

  it("hands a migrate job's tenant.migration_failed to the failure handler, and alerts ops for a fan-out one", async () => {
    const failed = {
      ...event,
      name: "tenant.migration_failed",
      payload: { version: "0002_add_mvp_tenant_deltas", error: { code: "LOCK_TIMEOUT", message: "timeout" } },
    };
    const { instance, failures } = processor(job({ kind: "migrate" }));

    await expect(instance.process(bullmqJob("tenant.migration_failed", failed))).resolves.toEqual({
      outcome: "requeued",
      scheduledAt: "2026-01-15T10:01:00.000Z",
    });
    expect(failures.handle).toHaveBeenCalledWith({
      jobId: event.jobId,
      attempt: 1,
      error: { code: "LOCK_TIMEOUT", message: "timeout" },
      // No `retryable` in the answer counts as not retryable.
      retryable: false,
      source: "event",
      step: "run_migrations",
      requestId: event.requestId,
    });

    const fanOut = processor(undefined);
    await expect(
      fanOut.instance.process(bullmqJob("tenant.migration_failed", { ...failed, jobId: null }, "43")),
    ).resolves.toEqual({ outcome: "alerted", queued: true });
    expect(fanOut.migrations.recordFanOutFailure).toHaveBeenCalledTimes(1);
    expect(fanOut.failures.handle).not.toHaveBeenCalled();
  });

  it("fails an answer about another tenant than its job's at once", async () => {
    const resumed = { ...event, name: "tenant.resumed", payload: {} };
    const other = processor(job({ kind: "resume", tenant_id: "ten_01M4T9E68084G7ZWYRD6Z1RV0X" }));

    await expect(other.instance.process(bullmqJob("tenant.resumed", resumed))).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    expect(other.suspensions.markAnswered).not.toHaveBeenCalled();
  });

  it("reads an answer's attempt as current, stale or unknown", () => {
    expect(answerAttemptIgnoreReason({ attempt: 2 }, 2)).toBeUndefined();
    expect(answerAttemptIgnoreReason({ attempt: 2 }, 1)).toBe("stale_attempt");
    expect(answerAttemptIgnoreReason({ attempt: 2 }, 3)).toBe("unknown_attempt");
    expect(answerAttemptIgnoreReason({ attempt: 2 }, undefined)).toBe("unknown_attempt");
  });
});
