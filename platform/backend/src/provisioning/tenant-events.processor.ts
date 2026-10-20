// The consumer of `platform-tenant-events` (PBE-022; platform/docs/architecture.md §5, concurrency 4; flows/
// provisioning.md §3 and "Failure handling", PADR-0001 items 4, 5 and 7): the OTA worker's answers to the
// `ota-tenant-ops` messages. BullMQ hands any job of a queue to any of its workers, so this is the queue's one
// processor; it dispatches on the event's name.
//
// For every job:
//
// 1. The message is checked with `validateJob` of `@velexis/api-types/jobs` (the PBE-004 JSON Schemas). An invalid one
//    is a bug of the other side and is not retried: it fails at once (`UnrecoverableError`), logged with the failing
//    paths and rules, never the values.
// 2. `tenant.provisioned` runs the post-steps (PostStepsRunner). `tenant.provision_failed` goes to the failure handler
//    (failure-handler.ts, PBE-023), which re-queues the job with a backoff when the OTA worker says the failure is
//    retryable and attempts are left, and otherwise fails it (and the tenant). PBE-030 adds the other answers:
//    - `tenant.migrated` mirrors the ledger and `tenants.schema_version` (MigrateService.recordMigrated), also for a
//      report of the deploy fan-out (`jobId: null`); the answer of a `migrate` job's current attempt also finishes the
//      job. A stale or unknown attempt of a known `migrate` job still mirrors (the ledger is the schema's, and the
//      version never goes back), but leaves the job alone;
//    - `tenant.migration_failed` of a `migrate` job goes to the failure handler (retryable as the OTA worker says,
//      absent counting as not retryable; the job fails with an `ops.alert`, never the tenant's status, PADR-0001 item
//      7); one of the deploy fan-out alerts ops (MigrateService.recordFanOutFailure);
//    - `tenant.suspended` and `tenant.resumed` mark their `suspend` or `resume` job `succeeded`
//      (SuspensionService.markAnswered), whatever the tenant's status is now (PADR-0014 item 7).
// 3. The event's dispatch attempt is read from its BullMQ id `<jobId>-<attempt>` (`parseBullmqJobId`), the id the OTA
//    worker gives every answer. The job is loaded with its tenant, and the event is ignored (the BullMQ job completes,
//    `provisioning.event_ignored` with the reason) when:
//    - its id has another shape or names another job (`unknown_attempt`), or no such job exists (`unknown_job`);
//    - the job is not of the event's kind (`other_kind`: `provision` for the provisioning answers, `migrate`,
//      `suspend`, `resume` for the others);
//    - its attempt is older than the job's (`stale_attempt`: a late answer of a re-dispatched job) or newer
//      (`unknown_attempt`: no dispatch made it);
//    - for `tenant.provisioned`: the job is `failed` or `canceled`, or `succeeded` with every post-step done
//      (`finished`). A `succeeded` job whose `notify` step has not run yet (a crash between `activate` and `notify`) is
//      not finished: the run resumes at `notify`;
//    - for `tenant.provision_failed` and `tenant.migration_failed`: the job is not `running` at that attempt any more
//      (`not_running`: the reconciler counted the attempt as lost already, or it finished), which the failure handler
//      checks under the job's lock; for `tenant.suspended` and `tenant.resumed`: the job is no longer active
//      (`finished`, checked under the job's lock);
//    - a fan-out report names no tenant the platform has (`unknown_tenant`).
//    An event about another tenant than its job's, or with another schema name, breaks the contract: it fails at once
//    (`UnrecoverableError`), like an invalid message.
// 4. The runner re-checks the job under its row lock before each step (two deliveries of one event, a re-dispatch
//    meanwhile) and resumes at the first step not done. A failed step fails the BullMQ job, and BullMQ tries it again
//    with the producer's options (5 attempts, backoff from 30 s, ADR-0009). When the failed try is the BullMQ job's
//    last one, the failure handler marks the provisioning job `failed` with the step's name first (not retryable: the
//    attempt's schema exists, and a retry by an owner or an admin runs the post-steps again).
//
// The result BullMQ keeps is what happened (`{outcome, reason?, steps?}`): ids, step names and statuses, never a key.
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import {
  MessageValidationError,
  parseBullmqJobId,
  TENANT_EVENT_NAMES,
  validateJob,
  type ProvisioningStepRecord,
  type TenantEvent,
  type TenantMigratedEvent,
  type TenantMigrationFailedEvent,
  type TenantProvisionedEvent,
  type TenantProvisionFailedEvent,
  type TenantResumedEvent,
  type TenantSuspendedEvent,
} from "@velexis/api-types/jobs";
import { UnrecoverableError, type Job, type JobsOptions } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PLATFORM_QUEUE, platformWorkerOptions } from "../common/queues/queue-names";
import {
  ProvisioningFailureHandler,
  type FailureIgnoredReason,
  type FailureOutcome,
} from "./failure-handler";
import { MIGRATE_OTA_STEP, MigrateService } from "./migrate.service";
import {
  PostStepError,
  PostStepsRunner,
  postStepsFinished,
  type PostStepRun,
  type PostStepsRunResult,
  type PostStepsStopReason,
} from "./post-steps/post-steps.runner";
import {
  ProvisioningJobsRepository,
  type PostStepJobRow,
  type ProvisioningJobKind,
} from "./provisioning-jobs.repository";
import { SuspensionService } from "./suspension.service";

/** Why an event was ignored. */
export type TenantEventIgnoreReason =
  | "unknown_attempt"
  | "unknown_job"
  | "unknown_tenant"
  | "other_kind"
  | "stale_attempt"
  | "finished"
  | PostStepsStopReason
  | FailureIgnoredReason;

/** What a finished job of `platform-tenant-events` returns (BullMQ keeps it). */
export type TenantEventOutcome =
  | { readonly outcome: "ignored"; readonly reason: TenantEventIgnoreReason }
  | { readonly outcome: "completed"; readonly steps: readonly PostStepRun[] }
  /** A `…_failed` answer: the job went back to `queued` for another attempt. */
  | { readonly outcome: "requeued"; readonly scheduledAt: string }
  /** A `…_failed` answer: the job failed for good; `tenantFailed` when the tenant became `failed` with it. */
  | { readonly outcome: "failed"; readonly tenantFailed: boolean }
  /** `tenant.migrated`: the ledger is mirrored; `jobSucceeded` when the answer finished its `migrate` job. */
  | {
      readonly outcome: "mirrored";
      readonly schemaVersion: string;
      readonly versionChanged: boolean;
      readonly jobSucceeded: boolean;
    }
  /** `tenant.migration_failed` of the deploy fan-out: ops were alerted (`queued: false` for a second delivery). */
  | { readonly outcome: "alerted"; readonly queued: boolean }
  /** `tenant.suspended`, `tenant.resumed`: the job succeeded. */
  | { readonly outcome: "succeeded" };

/** The job kind of each answer that is not about provisioning. */
export const ANSWER_JOB_KIND = Object.freeze({
  "tenant.migrated": "migrate",
  "tenant.migration_failed": "migrate",
  "tenant.suspended": "suspend",
  "tenant.resumed": "resume",
} as const satisfies Record<string, ProvisioningJobKind>);

/**
 * Whether an answer of dispatch attempt `attempt` (`undefined`: its BullMQ id names no attempt of the job) is for the
 * job's current attempt: `undefined` when it is, else `stale_attempt` or `unknown_attempt`.
 */
export function answerAttemptIgnoreReason(
  job: Pick<PostStepJobRow, "attempt">,
  attempt: number | undefined,
): TenantEventIgnoreReason | undefined {
  if (attempt === undefined || attempt > job.attempt) {
    return "unknown_attempt";
  }
  return attempt < job.attempt ? "stale_attempt" : undefined;
}

/** The error message of post-steps whose BullMQ tries are exhausted (the step's code goes with it). */
export const POST_STEPS_EXHAUSTED_MESSAGE =
  "The post-step failed on every try of the event; the job failed. A retry runs the post-steps again.";

/**
 * True when the current try of `job` is its last: BullMQ does not try it again after a failure (its `attempts` are
 * used up; one try without `attempts`), so what is not done now stays undone.
 */
export function isLastTry(job: { readonly attemptsMade?: number; readonly opts?: JobsOptions }): boolean {
  const attempts = job.opts?.attempts ?? 1;
  return (job.attemptsMade ?? 0) + 1 >= attempts;
}

/** The OTA worker's failed step of a `tenant.provision_failed` event: the last `failed` entry of its steps. */
export function failedOtaStep(steps: readonly ProvisioningStepRecord[]): string | undefined {
  return [...steps].reverse().find((entry) => entry.status === "failed")?.step;
}

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

/**
 * Whether the `tenant.provision_failed` event of dispatch attempt `attempt` is for `job`: `undefined` when the failure
 * handler takes it (it checks the job's status under the row lock), else why it is ignored (step 3 of the file header).
 */
export function provisionFailedEventIgnoreReason(
  job: Pick<PostStepJobRow, "kind" | "attempt">,
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
  return undefined;
}

@Processor(PLATFORM_QUEUE.tenantEvents, platformWorkerOptions(PLATFORM_QUEUE.tenantEvents))
export class TenantEventsProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly jobs: ProvisioningJobsRepository,
    private readonly runner: PostStepsRunner,
    private readonly failures: ProvisioningFailureHandler,
    private readonly migrations: MigrateService,
    private readonly suspensions: SuspensionService,
    @InjectPinoLogger(TenantEventsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<TenantEventOutcome> {
    const event = this.validEvent(job);
    switch (event.name) {
      case "tenant.provisioned":
        return this.provisioned(event, eventAttempt(job.id, event.jobId), isLastTry(job));
      case "tenant.provision_failed":
        return this.provisionFailed(event, eventAttempt(job.id, event.jobId));
      case "tenant.migrated":
        return this.migrated(event, eventAttempt(job.id, event.jobId));
      case "tenant.migration_failed":
        return this.migrationFailed(event, eventAttempt(job.id, event.jobId));
      case "tenant.suspended":
      case "tenant.resumed":
        return this.housekeepingDone(event, eventAttempt(job.id, event.jobId));
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

  /**
   * `tenant.provisioned` (steps 3 and 4 of the file header). `lastTry`: the event's BullMQ job is on its last try, so a
   * failed post-step fails the provisioning job.
   */
  async provisioned(
    event: TenantProvisionedEvent,
    attempt: number | undefined,
    lastTry = false,
  ): Promise<TenantEventOutcome> {
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
    let run: PostStepsRunResult;
    try {
      run = await this.runner.run(event, attempt);
    } catch (error) {
      if (error instanceof PostStepError && lastTry) {
        await this.postStepsExhausted(event, attempt, error);
      }
      throw error;
    }
    if (run.outcome === "stopped") {
      return this.ignored(context, run.reason);
    }
    this.logger.info(
      { ...context, requestId: event.requestId, steps: run.steps },
      "provisioning.post_steps_done",
    );
    return { outcome: "completed", steps: run.steps };
  }

  /** `tenant.provision_failed` (steps 2 and 3 of the file header): the failure handler ends the attempt. */
  async provisionFailed(
    event: TenantProvisionFailedEvent,
    attempt: number | undefined,
  ): Promise<TenantEventOutcome> {
    const context = { event: event.name, jobId: event.jobId, tenantId: event.tenantId, attempt };
    if (attempt === undefined) {
      return this.ignored(context, "unknown_attempt");
    }
    const job = await this.jobs.findForEvent(event.jobId);
    if (job === undefined) {
      return this.ignored(context, "unknown_job");
    }
    if (job.tenant_id !== event.tenantId) {
      this.logger.error({ ...context, jobTenantId: job.tenant_id }, "provisioning.event_mismatch");
      throw new UnrecoverableError("tenant.provision_failed names another tenant than its job");
    }
    const reason = provisionFailedEventIgnoreReason(job, attempt);
    if (reason !== undefined) {
      return this.ignored({ ...context, status: job.status, jobAttempt: job.attempt }, reason);
    }
    const step = failedOtaStep(event.payload.steps);
    const outcome = await this.failures.handle({
      jobId: job.id,
      attempt,
      error: event.payload.error,
      retryable: event.payload.retryable,
      source: "event",
      steps: event.payload.steps,
      ...(step === undefined ? {} : { step }),
      requestId: event.requestId,
    });
    return this.failureOutcome({ ...context, status: job.status, jobAttempt: job.attempt }, outcome);
  }

  /**
   * `tenant.migrated` (step 2 of the file header): the ledger is mirrored, and the answer of the `migrate` job's
   * current attempt also finishes the job.
   */
  async migrated(event: TenantMigratedEvent, attempt: number | undefined): Promise<TenantEventOutcome> {
    const context = { event: event.name, jobId: event.jobId, tenantId: event.tenantId, attempt };
    let answer: { readonly jobId: string; readonly attempt: number } | undefined;
    if (event.jobId !== null) {
      const job = await this.answeredJob(event.name, event.jobId, event.tenantId, context);
      if ("outcome" in job) {
        return job;
      }
      const reason = answerAttemptIgnoreReason(job, attempt);
      if (reason === undefined && attempt !== undefined) {
        answer = { jobId: job.id, attempt };
      } else {
        this.logger.info(
          { ...context, status: job.status, jobAttempt: job.attempt, reason },
          "provisioning.migrated_without_job",
        );
      }
    }
    const outcome = await this.migrations.recordMigrated(event, answer);
    if (outcome.outcome === "ignored") {
      return this.ignored(context, outcome.reason);
    }
    this.logger.info(
      { ...context, requestId: event.requestId, ...outcome },
      "provisioning.migrations_mirrored",
    );
    return outcome;
  }

  /**
   * `tenant.migration_failed` (step 2 of the file header): a `migrate` job's answer goes to the failure handler, a
   * report of the deploy fan-out alerts ops.
   */
  async migrationFailed(
    event: TenantMigrationFailedEvent,
    attempt: number | undefined,
  ): Promise<TenantEventOutcome> {
    const context = { event: event.name, jobId: event.jobId, tenantId: event.tenantId, attempt };
    if (event.jobId === null) {
      const outcome = await this.migrations.recordFanOutFailure(event);
      if (outcome.outcome === "ignored") {
        return this.ignored(context, outcome.reason);
      }
      this.logger.warn(
        {
          ...context,
          requestId: event.requestId,
          version: event.payload.version,
          code: event.payload.error.code,
          queued: outcome.queued,
        },
        "provisioning.fan_out_migration_failed",
      );
      return outcome;
    }
    const job = await this.answeredJob(event.name, event.jobId, event.tenantId, context);
    if ("outcome" in job) {
      return job;
    }
    const reason = answerAttemptIgnoreReason(job, attempt);
    if (reason !== undefined || attempt === undefined) {
      return this.ignored(
        { ...context, status: job.status, jobAttempt: job.attempt },
        reason ?? "unknown_attempt",
      );
    }
    const outcome = await this.failures.handle({
      jobId: job.id,
      attempt,
      error: event.payload.error,
      // The contract: an absent `retryable` counts as false.
      retryable: event.payload.retryable === true,
      source: "event",
      step: MIGRATE_OTA_STEP,
      requestId: event.requestId,
    });
    return this.failureOutcome({ ...context, status: job.status, jobAttempt: job.attempt }, outcome);
  }

  /** `tenant.suspended` and `tenant.resumed` (step 2 of the file header): the job succeeds. */
  async housekeepingDone(
    event: TenantSuspendedEvent | TenantResumedEvent,
    attempt: number | undefined,
  ): Promise<TenantEventOutcome> {
    const context = { event: event.name, jobId: event.jobId, tenantId: event.tenantId, attempt };
    if (attempt === undefined) {
      return this.ignored(context, "unknown_attempt");
    }
    const job = await this.answeredJob(event.name, event.jobId, event.tenantId, context);
    if ("outcome" in job) {
      return job;
    }
    const reason = answerAttemptIgnoreReason(job, attempt);
    if (reason !== undefined) {
      return this.ignored({ ...context, status: job.status, jobAttempt: job.attempt }, reason);
    }
    const outcome = await this.suspensions.markAnswered({
      jobId: job.id,
      attempt,
      kind: ANSWER_JOB_KIND[event.name],
    });
    if (outcome.outcome === "ignored") {
      return this.ignored({ ...context, status: job.status, jobAttempt: job.attempt }, outcome.reason);
    }
    this.logger.info({ ...context, requestId: event.requestId, kind: job.kind }, "provisioning.job_answered");
    return outcome;
  }

  /**
   * The job an answer of `name` names, when it exists and is of the answer's kind; otherwise the ignored outcome. An
   * answer about another tenant than its job's fails at once (step 3 of the file header).
   */
  private async answeredJob(
    name: keyof typeof ANSWER_JOB_KIND,
    jobId: string,
    tenantId: string,
    context: Record<string, unknown>,
  ): Promise<PostStepJobRow | TenantEventOutcome> {
    const job = await this.jobs.findForEvent(jobId);
    if (job === undefined) {
      return this.ignored(context, "unknown_job");
    }
    if (job.tenant_id !== tenantId) {
      this.logger.error({ ...context, jobTenantId: job.tenant_id }, "provisioning.event_mismatch");
      throw new UnrecoverableError(`${name} names another tenant than its job`);
    }
    if (job.kind !== ANSWER_JOB_KIND[name]) {
      return this.ignored({ ...context, kind: job.kind }, "other_kind");
    }
    return job;
  }

  /** The outcome of an answer the failure handler took. */
  private failureOutcome(context: Record<string, unknown>, outcome: FailureOutcome): TenantEventOutcome {
    switch (outcome.outcome) {
      case "ignored":
        return this.ignored(context, outcome.reason);
      case "requeued":
        return { outcome: "requeued", scheduledAt: outcome.scheduledAt.toISOString() };
      case "failed":
        return { outcome: "failed", tenantFailed: outcome.tenantFailed };
    }
  }

  /**
   * The post-steps failed on the event's last BullMQ try: the provisioning job fails with the step's name (step 4 of the
   * file header). A failure here is logged and dropped: the step's own error is what the event's job fails with, and
   * the reconciler finds the job once its lease has ended.
   */
  private async postStepsExhausted(
    event: TenantProvisionedEvent,
    attempt: number,
    error: PostStepError,
  ): Promise<void> {
    try {
      await this.failures.handle({
        jobId: event.jobId,
        attempt,
        error: { code: error.error.code, message: POST_STEPS_EXHAUSTED_MESSAGE },
        retryable: false,
        source: "post_steps",
        step: error.step,
        requestId: event.requestId,
      });
    } catch (failure) {
      this.logger.error(
        { jobId: event.jobId, attempt, step: error.step, err: failure },
        "provisioning.post_steps_failure_not_recorded",
      );
    }
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
