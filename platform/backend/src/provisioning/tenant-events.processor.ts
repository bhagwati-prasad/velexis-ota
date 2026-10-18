// The consumer of `platform-tenant-events` (PBE-022; platform/docs/architecture.md §5, concurrency 4; flows/
// provisioning.md §3, PADR-0001 item 5): the OTA worker's answers to the `ota-tenant-ops` messages. BullMQ hands any job
// of a queue to any of its workers, so this is the queue's one processor; it dispatches on the event's name.
//
// For every job:
//
// 1. The message is checked with `validateJob` of `@velexis/api-types/jobs` (the PBE-004 JSON Schemas). An invalid one
//    is a bug of the other side and is not retried: it fails at once (`UnrecoverableError`), logged with the failing
//    paths and rules, never the values.
// 2. `tenant.provisioned` runs the post-steps (PostStepsRunner). The other events wait for their tasks: the failures
//    (`tenant.provision_failed`, PBE-023's failure handler) and the migrate, suspend and resume answers (PBE-030); until
//    then they complete without effect (`provisioning.event_not_handled`).
// 3. The event's dispatch attempt is read from its BullMQ id `<jobId>-<attempt>` (`parseBullmqJobId`), the id the OTA
//    worker gives every answer. The job is loaded with its tenant, and the event is ignored (the BullMQ job completes,
//    `provisioning.event_ignored` with the reason) when:
//    - its id has another shape or names another job (`unknown_attempt`), or no such job exists (`unknown_job`);
//    - the job is not a `provision` job (`other_kind`);
//    - its attempt is older than the job's (`stale_attempt`: a late answer of a re-dispatched job) or newer
//      (`unknown_attempt`: no dispatch made it);
//    - the job is `failed` or `canceled`, or `succeeded` with every post-step done (`finished`). A `succeeded` job
//      whose `notify` step has not run yet (a crash between `activate` and `notify`) is not finished: the run resumes
//      at `notify`.
//    An event about another tenant than its job's, or with another schema name, breaks the contract: it fails at once
//    (`UnrecoverableError`), like an invalid message.
// 4. The runner re-checks the job under its row lock before each step (two deliveries of one event, a re-dispatch
//    meanwhile) and resumes at the first step not done. A failed step fails the BullMQ job, and BullMQ tries it again
//    with the producer's options (5 attempts, backoff from 30 s, ADR-0009).
//
// The result BullMQ keeps is what happened (`{outcome, reason?, steps?}`): ids, step names and statuses, never a key.
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import {
  MessageValidationError,
  parseBullmqJobId,
  TENANT_EVENT_NAMES,
  validateJob,
  type TenantEvent,
  type TenantProvisionedEvent,
} from "@velexis/api-types/jobs";
import { UnrecoverableError, type Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PLATFORM_QUEUE, platformWorkerOptions } from "../common/queues/queue-names";
import {
  PostStepsRunner,
  postStepsFinished,
  type PostStepRun,
  type PostStepsStopReason,
} from "./post-steps/post-steps.runner";
import { ProvisioningJobsRepository, type PostStepJobRow } from "./provisioning-jobs.repository";

/** Why an event was ignored. */
export type TenantEventIgnoreReason =
  | "not_handled"
  | "unknown_attempt"
  | "unknown_job"
  | "other_kind"
  | "stale_attempt"
  | "finished"
  | PostStepsStopReason;

/** What a finished job of `platform-tenant-events` returns (BullMQ keeps it). */
export type TenantEventOutcome =
  | { readonly outcome: "ignored"; readonly reason: TenantEventIgnoreReason }
  | { readonly outcome: "completed"; readonly steps: readonly PostStepRun[] };

/** The dispatch attempt of an event from its BullMQ id, when the id is `<jobId>-<attempt>` of the event's own job. */
export function eventAttempt(bullmqId: string | undefined, jobId: string | null): number | undefined {
  if (bullmqId === undefined || jobId === null) {
    return undefined;
  }
  const parsed = parseBullmqJobId(bullmqId);
  return parsed !== null && parsed.jobId === jobId ? parsed.attempt : undefined;
}

/**
 * Whether the `tenant.provisioned` event of dispatch attempt `attempt` is for `job` now: `undefined` when the
 * post-steps run, else why it is ignored (step 3 of the file header).
 */
export function provisionedEventIgnoreReason(
  job: Pick<PostStepJobRow, "kind" | "status" | "attempt" | "steps">,
  attempt: number,
): TenantEventIgnoreReason | undefined {
  if (job.kind !== "provision") {
    return "other_kind";
  }
  if (attempt < job.attempt) {
    return "stale_attempt";
  }
  if (attempt > job.attempt) {
    return "unknown_attempt";
  }
  if (job.status === "failed" || job.status === "canceled") {
    return "finished";
  }
  if (job.status === "succeeded" && postStepsFinished(job.steps)) {
    return "finished";
  }
  return undefined;
}

@Processor(PLATFORM_QUEUE.tenantEvents, platformWorkerOptions(PLATFORM_QUEUE.tenantEvents))
export class TenantEventsProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly jobs: ProvisioningJobsRepository,
    private readonly runner: PostStepsRunner,
    @InjectPinoLogger(TenantEventsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<TenantEventOutcome> {
    const event = this.validEvent(job);
    switch (event.name) {
      case "tenant.provisioned":
        return this.provisioned(event, eventAttempt(job.id, event.jobId));
      case "tenant.provision_failed":
      case "tenant.migrated":
      case "tenant.migration_failed":
      case "tenant.suspended":
      case "tenant.resumed":
        this.logger.warn(
          { event: event.name, jobId: event.jobId, tenantId: event.tenantId, requestId: event.requestId },
          "provisioning.event_not_handled",
        );
        return { outcome: "ignored", reason: "not_handled" };
    }
  }

  /** Errors of the worker itself (its Redis connections); job failures are logged by the job. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: PLATFORM_QUEUE.tenantEvents, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }

  /** `tenant.provisioned` (steps 3 and 4 of the file header). */
  async provisioned(event: TenantProvisionedEvent, attempt: number | undefined): Promise<TenantEventOutcome> {
    const context = { event: event.name, jobId: event.jobId, tenantId: event.tenantId, attempt };
    if (attempt === undefined) {
      return this.ignored(context, "unknown_attempt");
    }
    const job = await this.jobs.findForEvent(event.jobId);
    if (job === undefined) {
      return this.ignored(context, "unknown_job");
    }
    if (job.tenant_id !== event.tenantId || job.tenant_schema_name !== event.payload.schemaName) {
      this.logger.error(
        {
          ...context,
          jobTenantId: job.tenant_id,
          schemaMatches: job.tenant_schema_name === event.payload.schemaName,
        },
        "provisioning.event_mismatch",
      );
      throw new UnrecoverableError("tenant.provisioned names another tenant or schema than its job");
    }
    const reason = provisionedEventIgnoreReason(job, attempt);
    if (reason !== undefined) {
      return this.ignored({ ...context, status: job.status, jobAttempt: job.attempt }, reason);
    }
    const run = await this.runner.run(event, attempt);
    if (run.outcome === "stopped") {
      return this.ignored(context, run.reason);
    }
    this.logger.info(
      { ...context, requestId: event.requestId, steps: run.steps },
      "provisioning.post_steps_done",
    );
    return { outcome: "completed", steps: run.steps };
  }

  /** The job's message, checked against its JSON Schema; an invalid one fails at once (step 1 of the file header). */
  private validEvent(job: Job): TenantEvent {
    try {
      if (!(TENANT_EVENT_NAMES as readonly string[]).includes(job.name)) {
        throw new MessageValidationError(JSON.stringify(job.name.slice(0, 64)), [
          { path: "/name", keyword: "name", message: "is not a message of platform-tenant-events" },
        ]);
      }
      return validateJob(job.name as TenantEvent["name"], job.data) as TenantEvent;
    } catch (error) {
      if (error instanceof MessageValidationError) {
        this.logger.error(
          {
            queue: PLATFORM_QUEUE.tenantEvents,
            bullmqJobId: job.id,
            issues: error.issues.map((issue) => `${issue.path} ${issue.keyword}`),
          },
          "provisioning.event_invalid",
        );
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  private ignored(context: Record<string, unknown>, reason: TenantEventIgnoreReason): TenantEventOutcome {
    this.logger.info({ ...context, reason }, "provisioning.event_ignored");
    return { outcome: "ignored", reason };
  }
}
