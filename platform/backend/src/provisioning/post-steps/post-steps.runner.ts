// The platform's post-steps of a provisioned tenant (PBE-022; platform/docs/flows/provisioning.md §3, PADR-0001 items 1
// and 5). When the OTA worker reports `tenant.provisioned`, the tenant schema exists; the platform then writes its own
// tables in six steps, in this order:
//
//   record_migrations          mirror the schema's ledger in tenant_schema_migrations, tenants.schema_version
//   assign_amadeus_office      the oldest free test office and the `velexis` Amadeus connection (or a pending one)
//   create_payment_connection  the `velexis` Stripe test connection with the statement descriptor suffix
//   issue_api_keys             pk_test and sk_test, the raw keys envelope-encrypted for one reveal
//   activate                   tenant `active`, job `succeeded`, audit `tenant.activated`
//   notify                     after that commit: `tenant` and `connection` invalidations, `tenant.welcome` e-mails
//
// `PostStepsRunner.run(event, attempt)` runs them for the event's job. Each step runs in its own short transaction
// (`runInTransaction`), which:
//
// 1. locks the job's row (`FOR UPDATE OF j`), so two deliveries of one event never run a step at the same time: the
//    second waits, then reads the log the first one left;
// 2. stops the run when the job's attempt changed (a newer dispatch owns it); otherwise skips the step when the log
//    holds it as `succeeded` or `skipped` (a crash or a failed step resumes at the first step not done, and a second
//    delivery does nothing), and stops before a step not done when the job is not active any more (`queued` and
//    `running` are; after `activate` only `notify` may still run on the `succeeded` job, so a retry after a failed or
//    crashed `notify` passes the five steps done and still sends the e-mails and the invalidations);
// 3. runs the step, merges what it returns into `provisioning_jobs.result` (`schemaVersion`, `officeId`, `apiKeyIds`),
//    appends `{step, status, startedAt, finishedAt}` to `provisioning_jobs.steps`, sets `step` and clears `error`. The
//    first step also appends the OTA worker's own steps from the event (`create_schema`, `run_migrations`,
//    `seed_defaults`) before its entry, so the log shows the run the platform accepted, once.
//
// A step that throws rolls its transaction back. The runner then appends `{step, status: "failed", error}` and the
// job's `error` in a transaction of its own (the error is a code, the SQLSTATE when there is one, and a message without
// values) and throws a `PostStepError`, so the event's BullMQ job fails and BullMQ tries it again (ADR-0009 defaults of
// the producer); the next try resumes at the failed step. What happens when the tries are exhausted is PBE-023's
// failure handler.
//
// "Now" is the injected Clock's time, as in the other repositories, so tests read the log at the FakeClock's time.
import { Inject, Injectable } from "@nestjs/common";
import {
  PROVISIONING_STEP_STATUSES,
  type ProvisioningStepRecord,
  type ProvisioningStepStatus,
  type TenantJobError,
  type TenantProvisionedEvent,
} from "@velexis/api-types/jobs";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../../audit/audit.repository";
import { Clock } from "../../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../../common/database";
import { runInTransaction } from "../../common/redis/invalidation.publisher";
import {
  ProvisioningJobsRepository,
  type PostStepJobRow,
  type ProvisioningJobStatus,
} from "../provisioning-jobs.repository";
import { ActivateStep } from "./activate.step";
import { AssignAmadeusOfficeStep } from "./assign-amadeus-office.step";
import { CreatePaymentConnectionStep } from "./create-payment-connection.step";
import { IssueApiKeysStep } from "./issue-api-keys.step";
import { NotifyStep } from "./notify.step";
import { RecordMigrationsStep } from "./record-migrations.step";

/** The platform's post-steps, in the order they run (PADR-0001 item 1). */
export const POST_STEP_NAMES = [
  "record_migrations",
  "assign_amadeus_office",
  "create_payment_connection",
  "issue_api_keys",
  "activate",
  "notify",
] as const;

/** A post-step's name. */
export type PostStepName = (typeof POST_STEP_NAMES)[number];

/** What a step gets: its transaction, the job (locked) with its tenant, the event, and the step's start. */
export interface PostStepContext {
  readonly trx: PlatformTransaction;
  readonly job: PostStepJobRow;
  readonly event: TenantProvisionedEvent;
  /** The step's start time (the Clock's now). */
  readonly now: Date;
}

/** How a step ended, and the fields it adds to the job's `result`. */
export interface PostStepOutcome {
  readonly status: Extract<ProvisioningStepStatus, "succeeded" | "skipped">;
  readonly result?: Readonly<Record<string, unknown>>;
}

/** One post-step: idempotent, inside the transaction it is given (see the file header). */
export interface PostStep {
  readonly name: PostStepName;
  run(context: PostStepContext): Promise<PostStepOutcome>;
}

/** Why a run stopped before its last step: the job is no longer the event's. */
export type PostStepsStopReason = "unknown_job" | "superseded" | "finished";

/** What one step did in this run. */
export interface PostStepRun {
  readonly step: PostStepName;
  /** `done`: the log held it already, so it did not run again. */
  readonly status: Extract<ProvisioningStepStatus, "succeeded" | "skipped"> | "done";
}

/** What `run` did. */
export type PostStepsRunResult =
  | { readonly outcome: "completed"; readonly steps: readonly PostStepRun[] }
  | {
      readonly outcome: "stopped";
      readonly reason: PostStepsStopReason;
      readonly steps: readonly PostStepRun[];
    };

/** The job statuses in which post-steps run; after `activate`, `notify` also runs on the `succeeded` job. */
const ACTIVE_JOB_STATUSES: ReadonlySet<ProvisioningJobStatus> = new Set(["queued", "running"]);

/** A post-step failed: the event's BullMQ job fails with this, and BullMQ tries it again. */
export class PostStepError extends Error {
  override readonly name = "PostStepError";

  constructor(
    readonly step: PostStepName,
    readonly error: TenantJobError,
    options: { readonly cause: unknown },
  ) {
    // The message names the step and the code, never a value of the failing statement.
    super(`provisioning post-step ${step} failed (${error.code})`, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The entries of a stored step log that have the shape of a step record; anything else is left out. */
export function stepLog(value: unknown): ProvisioningStepRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is ProvisioningStepRecord =>
      isRecord(entry) &&
      typeof entry["step"] === "string" &&
      typeof entry["status"] === "string" &&
      (PROVISIONING_STEP_STATUSES as readonly string[]).includes(entry["status"]) &&
      typeof entry["startedAt"] === "string" &&
      typeof entry["finishedAt"] === "string",
  );
}

/** The post-steps the log holds as done: `succeeded` or `skipped` (a later `failed` entry never follows one). */
export function completedPostSteps(steps: unknown): Set<PostStepName> {
  const names = new Set<string>(POST_STEP_NAMES);
  return new Set(
    stepLog(steps)
      .filter((entry) => names.has(entry.step) && entry.status !== "failed")
      .map((entry) => entry.step as PostStepName),
  );
}

/** True when every post-step is done: the event's work is finished, whatever the job's status says. */
export function postStepsFinished(steps: unknown): boolean {
  const done = completedPostSteps(steps);
  return POST_STEP_NAMES.every((name) => done.has(name));
}

/**
 * Why step `step` of the run for `attempt` may not run on `job` now, or `undefined` when it may: the job's attempt
 * changed (`superseded`), or the job is not active any more (`finished`), except `notify` on the job `activate` made
 * `succeeded`.
 */
export function stopReason(
  job: Pick<PostStepJobRow, "status" | "attempt">,
  step: PostStepName,
  attempt: number,
): Exclude<PostStepsStopReason, "unknown_job"> | undefined {
  if (job.attempt !== attempt) {
    return "superseded";
  }
  if (ACTIVE_JOB_STATUSES.has(job.status) || (job.status === "succeeded" && step === "notify")) {
    return undefined;
  }
  return "finished";
}

/** A code for an error the step log may show: the error's own code (a SQLSTATE, `ECONNRESET`), else a generic one. */
export function stepErrorOf(error: unknown): TenantJobError {
  const code = isRecord(error) ? error["code"] : undefined;
  const name = error instanceof Error ? error.name : "Error";
  return {
    code: typeof code === "string" && /^[A-Z0-9][A-Z0-9_]{1,63}$/.test(code) ? code : "POST_STEP_FAILED",
    // No error message: a database error's text can hold values of the statement.
    message: `The step failed (${name.slice(0, 64)}); the event is tried again.`,
  };
}

@Injectable()
export class PostStepsRunner {
  /** The steps, in the order of POST_STEP_NAMES. */
  readonly steps: readonly PostStep[];

  constructor(
    recordMigrations: RecordMigrationsStep,
    assignAmadeusOffice: AssignAmadeusOfficeStep,
    createPaymentConnection: CreatePaymentConnectionStep,
    issueApiKeys: IssueApiKeysStep,
    activate: ActivateStep,
    notify: NotifyStep,
    private readonly jobs: ProvisioningJobsRepository,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(PostStepsRunner.name) private readonly logger: PinoLogger,
  ) {
    this.steps = [
      recordMigrations,
      assignAmadeusOffice,
      createPaymentConnection,
      issueApiKeys,
      activate,
      notify,
    ];
    const order = this.steps.map((step) => step.name);
    if (order.join() !== POST_STEP_NAMES.join()) {
      throw new Error(`PostStepsRunner: the steps run in the order ${POST_STEP_NAMES.join(", ")}`);
    }
  }

  /**
   * Runs the post-steps of the event's job for dispatch attempt `attempt` (see the file header). Rejects with a
   * `PostStepError` when a step fails.
   */
  async run(event: TenantProvisionedEvent, attempt: number): Promise<PostStepsRunResult> {
    const ran: PostStepRun[] = [];
    for (const step of this.steps) {
      const outcome = await this.runStep(step, event, attempt);
      if ("reason" in outcome) {
        this.logger.info(
          { jobId: event.jobId, tenantId: event.tenantId, step: step.name, attempt, reason: outcome.reason },
          "provisioning.post_steps_stopped",
        );
        return { outcome: "stopped", reason: outcome.reason, steps: ran };
      }
      ran.push(outcome);
    }
    return { outcome: "completed", steps: ran };
  }

  private async runStep(
    step: PostStep,
    event: TenantProvisionedEvent,
    attempt: number,
  ): Promise<PostStepRun | { readonly reason: PostStepsStopReason }> {
    const context = { jobId: event.jobId, tenantId: event.tenantId, step: step.name, attempt };
    let startedAt = this.clock.now();
    try {
      const run = await runInTransaction(
        this.db,
        async (trx): Promise<PostStepRun | { readonly reason: PostStepsStopReason }> => {
          const job = await this.jobs.lockForPostStep(trx, event.jobId);
          if (job === undefined) {
            return { reason: "unknown_job" };
          }
          // A newer attempt owns the job; otherwise a step the log holds is passed whatever the job's status, so a
          // retry on the job that `activate` made `succeeded` reaches `notify` (item 2 of the file header).
          const stop = stopReason(job, step.name, attempt);
          if (stop === "superseded") {
            return { reason: stop };
          }
          if (completedPostSteps(job.steps).has(step.name)) {
            return { step: step.name, status: "done" };
          }
          if (stop !== undefined) {
            return { reason: stop };
          }
          startedAt = this.clock.now();
          const outcome = await step.run({ trx, job, event, now: startedAt });
          const finishedAt = this.clock.now();
          if (outcome.result !== undefined) {
            await this.jobs.mergeResult(trx, job.id, outcome.result, finishedAt);
          }
          const entry: ProvisioningStepRecord = {
            step: step.name,
            status: outcome.status,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
          };
          await this.jobs.appendSteps(trx, {
            jobId: job.id,
            entries: step.name === "record_migrations" ? [...event.payload.steps, entry] : [entry],
            step: step.name,
            // A step that went through clears the error an earlier failed try left (activate clears it too).
            error: null,
            now: finishedAt,
          });
          return { step: step.name, status: outcome.status };
        },
      );
      if ("status" in run && run.status !== "done") {
        this.logger.info(
          { ...context, status: run.status, requestId: event.requestId },
          "provisioning.post_step",
        );
      }
      return run;
    } catch (error) {
      const stepError = stepErrorOf(error);
      this.logger.warn({ ...context, code: stepError.code, err: error }, "provisioning.post_step_failed");
      await this.recordFailure(step.name, event, attempt, startedAt, stepError);
      throw new PostStepError(step.name, stepError, { cause: error });
    }
  }

  /**
   * Appends the failed step to the log and sets the job's `error`, while the job is still the event's. A failure here
   * is logged and dropped: the step's own error is what the event's job fails with.
   */
  private async recordFailure(
    step: PostStepName,
    event: TenantProvisionedEvent,
    attempt: number,
    startedAt: Date,
    error: TenantJobError,
  ): Promise<void> {
    try {
      await runInTransaction(this.db, async (trx) => {
        const job = await this.jobs.lockForPostStep(trx, event.jobId);
        if (job === undefined || stopReason(job, step, attempt) !== undefined) {
          return;
        }
        const now = this.clock.now();
        await this.jobs.appendSteps(trx, {
          jobId: job.id,
          entries: [
            {
              step,
              status: "failed",
              startedAt: startedAt.toISOString(),
              finishedAt: now.toISOString(),
              error,
            },
          ],
          step,
          error: `${step} failed: ${error.code}`,
          now,
        });
      });
    } catch (failure) {
      this.logger.warn(
        { jobId: event.jobId, step, attempt, err: failure },
        "provisioning.post_step_failure_not_recorded",
      );
    }
  }
}
