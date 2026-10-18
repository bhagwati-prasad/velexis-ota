// The tenant-event consumer and the post-step bookkeeping without a database or Redis (PBE-022; flows/provisioning.md
// §3, PADR-0001 item 5): the attempt of an event from its BullMQ id, which `tenant.provisioned` events run the
// post-steps and which are ignored, the step log the runner resumes from, when a run stops, and the error a failed step
// leaves in the log. The integration test (test/integration/provisioning/post-steps.int.test.ts) runs the whole chain
// on PostgreSQL and Redis with the fake OTA worker.
import provisionedFixture from "@velexis/api-types/fixtures/jobs/tenant-provisioned.json";
import { validateJob, type TenantProvisionedEvent } from "@velexis/api-types/jobs";
import type { Job } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  completedPostSteps,
  POST_STEP_NAMES,
  postStepsFinished,
  stepErrorOf,
  stepLog,
  stopReason,
  type PostStepsRunner,
} from "./post-steps/post-steps.runner";
import type { PostStepJobRow, ProvisioningJobsRepository } from "./provisioning-jobs.repository";
import { eventAttempt, provisionedEventIgnoreReason, TenantEventsProcessor } from "./tenant-events.processor";

const JOB_ID = "job_01M4T9HVE0355QAKGD2AVSQWH2";
const AT = "2026-01-15T10:00:00.000Z";

let event: TenantProvisionedEvent;

beforeAll(() => {
  // validateJob compiles every message schema with Ajv on its first call: once here, not inside a test. 30 s covers a
  // slow CI runner.
  event = validateJob("tenant.provisioned", provisionedFixture);
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
    const runner = { run: vi.fn(() => Promise.resolve({ outcome: "completed" as const, steps: [] })) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return {
      runner,
      logger,
      instance: new TenantEventsProcessor(
        jobs as unknown as ProvisioningJobsRepository,
        runner as unknown as PostStepsRunner,
        logger as unknown as PinoLogger,
      ),
    };
  }

  function bullmqJob(name: string, data: unknown, id = `${event.jobId}-1`): Job {
    return { id, name, data } as Job;
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

  it("completes the events of later tasks without effect", async () => {
    const { instance, runner } = processor(job());
    const resumed = { ...event, name: "tenant.resumed", payload: {} };

    await expect(instance.process(bullmqJob("tenant.resumed", resumed))).resolves.toEqual({
      outcome: "ignored",
      reason: "not_handled",
    });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
