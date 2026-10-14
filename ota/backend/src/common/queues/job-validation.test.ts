// Validation of queued `tenant.*` messages (OBE-002): the PBE-004 fixtures pass and come back typed; anything else is
// refused with BullMQ's UnrecoverableError (no further attempts) and logged as `queue.job_invalid` without the payload.
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import provisionedFixture from "@velexis/api-types/fixtures/jobs/tenant-provisioned.json";
import { TENANT_OPS_JOB_NAMES, bullmqJobId } from "@velexis/api-types/jobs";
import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  JOB_INVALID_LOG,
  validateQueuedJob,
  validateTenantEventJob,
  validateTenantOpsJob,
  type JobValidationLogger,
  type QueuedJob,
} from "./job-validation";
import { OTA_TENANT_OPS, PLATFORM_TENANT_EVENTS } from "./queue-names";

/** A value that must never reach a log line or an error message. */
const MARKER = "marker-value-that-must-not-be-logged";

class RecordingLogger implements JobValidationLogger {
  readonly lines: Array<{ readonly object: Record<string, unknown>; readonly message: string }> = [];

  error(object: Record<string, unknown>, message: string): void {
    this.lines.push({ object, message });
  }

  text(): string {
    return JSON.stringify(this.lines);
  }
}

function queued(
  data: unknown,
  name = (data as { name: string }).name,
  queueName = OTA_TENANT_OPS,
): QueuedJob {
  return { id: bullmqJobId(provisionFixture.jobId, 1), name, data, queueName };
}

/** The error `validate` throws, or a failure when it throws nothing. */
function thrownBy(validate: () => unknown): unknown {
  try {
    validate();
  } catch (error) {
    return error;
  }
  throw new Error("expected the job to be refused");
}

/** A valid message of every `ota-tenant-ops` name, on the envelope of the PBE-004 fixture. */
const OPS_MESSAGES = {
  "tenant.provision": provisionFixture,
  "tenant.migrate": {
    ...provisionFixture,
    name: "tenant.migrate",
    payload: { targetVersion: "0002_add_mvp_tenant_deltas" },
  },
  "tenant.suspend": { ...provisionFixture, name: "tenant.suspend", payload: { reason: "billing" } },
  "tenant.resume": { ...provisionFixture, name: "tenant.resume", payload: {} },
} as const;

describe("validateTenantOpsJob", () => {
  it("accepts the tenant.provision fixture of PBE-004 and returns it typed [OBE-002 AC2]", () => {
    const logger = new RecordingLogger();

    const message = validateTenantOpsJob(queued(provisionFixture), logger);

    expect(message).toEqual(provisionFixture);
    // Typed by its name: a `tenant.provision` has an empty payload, a `tenant.migrate` an optional target.
    expect(message.name === "tenant.migrate" ? message.payload.targetVersion : "none").toBe("none");
    expect(logger.lines).toEqual([]);
  });

  it("accepts a valid message of every ota-tenant-ops name", () => {
    expect(Object.keys(OPS_MESSAGES)).toEqual([...TENANT_OPS_JOB_NAMES]);
    for (const message of Object.values(OPS_MESSAGES)) {
      expect(validateTenantOpsJob(queued(message), new RecordingLogger()), message.name).toEqual(message);
    }
  });

  it("refuses a tenant.provision with an extra field as unrecoverable, logged without the payload [OBE-002 AC2]", () => {
    const logger = new RecordingLogger();
    const job = queued({ ...provisionFixture, payload: { note: MARKER } });

    const error = thrownBy(() => validateTenantOpsJob(job, logger));

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe(
      "invalid tenant.provision message: /payload/note is not allowed (additionalProperties: false)",
    );
    expect(logger.lines).toEqual([
      {
        message: JOB_INVALID_LOG,
        object: {
          queue: OTA_TENANT_OPS,
          jobId: `${provisionFixture.jobId}-1`,
          jobName: "tenant.provision",
          issues: [
            {
              path: "/payload/note",
              keyword: "additionalProperties",
              message: "is not allowed (additionalProperties: false)",
            },
          ],
        },
      },
    ]);
    // Nothing of the message is logged: not the stray value, not the tenant or request id of the envelope.
    for (const value of [MARKER, provisionFixture.tenantId, provisionFixture.requestId]) {
      expect(logger.text()).not.toContain(value);
      expect(String(error)).not.toContain(value);
    }
  });

  it("refuses broken envelopes, names that do not match and names of another queue as unrecoverable", () => {
    const { jobId: _jobId, ...withoutJobId } = provisionFixture;
    const cases: Array<[string, QueuedJob, string]> = [
      ["no jobId", queued(withoutJobId), "/jobId is required"],
      ["another version", queued({ ...provisionFixture, v: 2 }), "/v must be 1"],
      ["a bad tenant id", queued({ ...provisionFixture, tenantId: MARKER }), "/tenantId must match pattern"],
      ["a top-level extra field", queued({ ...provisionFixture, secret: MARKER }), "/secret is not allowed"],
      ["data of another name", queued(provisionFixture, "tenant.resume"), '/name must be "tenant.resume"'],
      ["no object", queued(MARKER, "tenant.provision"), "(message) must be object"],
      ["an event on the ops queue", queued(provisionedFixture), "is not a message of queue ota-tenant-ops"],
      [
        "an unknown name",
        queued(provisionFixture, `tenant.${MARKER}`),
        "is not a message of queue ota-tenant-ops",
      ],
    ];
    for (const [label, job, reason] of cases) {
      const logger = new RecordingLogger();

      const error = thrownBy(() => validateTenantOpsJob(job, logger));

      expect(error, label).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message, label).toContain(reason);
      expect(
        logger.lines.map((line) => line.message),
        label,
      ).toEqual([JOB_INVALID_LOG]);
      expect(logger.lines[0]?.object["jobId"], label).toBe(job.id);
      if (label !== "an unknown name") {
        expect(logger.text(), label).not.toContain(MARKER);
        expect(String(error), label).not.toContain(MARKER);
      }
    }
  });

  it("shortens a long job name in the log line", () => {
    const logger = new RecordingLogger();
    const name = `tenant.${"x".repeat(200)}`;

    thrownBy(() => validateTenantOpsJob(queued(provisionFixture, name), logger));

    const logged = logger.lines[0]?.object["jobName"];
    expect(logged).toBe(`${name.slice(0, 64)}…`);
  });
});

describe("validateTenantEventJob and validateQueuedJob", () => {
  it("accepts the tenant.provisioned fixture on platform-tenant-events and refuses an ops message there", () => {
    expect(
      validateTenantEventJob(
        queued(provisionedFixture, undefined, PLATFORM_TENANT_EVENTS),
        new RecordingLogger(),
      ),
    ).toEqual(provisionedFixture);

    const logger = new RecordingLogger();
    const error = thrownBy(() =>
      validateTenantEventJob(queued(provisionFixture, undefined, PLATFORM_TENANT_EVENTS), logger),
    );
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toContain("is not a message of queue platform-tenant-events");
  });

  it("accepts only the names it is given", () => {
    const logger = new RecordingLogger();

    expect(validateQueuedJob(queued(provisionFixture), ["tenant.provision"], logger).name).toBe(
      "tenant.provision",
    );
    expect(() =>
      validateQueuedJob(queued(OPS_MESSAGES["tenant.resume"]), ["tenant.provision"], logger),
    ).toThrow(UnrecoverableError);
  });
});
