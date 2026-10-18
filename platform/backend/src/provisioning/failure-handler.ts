// The failure handler of provisioning jobs (PBE-023; platform/docs/flows/provisioning.md "Failure handling", PADR-0001
// items 4, 6 and 7): the one entry point through which a failed attempt of any job kind ends, whoever noticed it:
//
// - the tenant-event consumer, for a `tenant.provision_failed` answer of the OTA worker (`source: "event"`, retryable
//   as the OTA worker says) and for post-steps whose BullMQ tries are exhausted (`source: "post_steps"`, never
//   retryable: the job fails with the step's name, and an admin or owner retry runs the post-steps again);
// - the reconciler, for an attempt whose lease ended without an answer: its BullMQ job is missing, or failed without an
//   event (`source: "reconciler"`, always retryable, whatever the kind).
//
// `handle(failure)` runs one transaction that locks the job's row (`FOR UPDATE OF j`) and changes it only while it is
// still `running` at the failed attempt (and, for the reconciler, while its lease is still over), so a late event, a
// second reconciler run or a dispatch meanwhile never count one attempt twice. Then (`failureDecision`):
//
// - a retryable failure with `attempt < max_attempts`: the job goes back to `queued`, due at
//   `now + 30 s × 2^attempt` (60 s after the first attempt, 8 minutes after the fourth), without a lease, with the error;
//   the reconciler dispatches it when it is due, as attempt + 1 (BullMQ id `<jobId>-<attempt + 1>`);
// - otherwise the job becomes `failed` (`finished_at`, the error), and the effect depends on the kind
//   (`failureEffects`, PADR-0001 item 7):
//   - `provision`: the tenant becomes `failed`, only from `provisioning` (a conditional update); when it did, the audit
//     row `tenant.provisioning_failed` (actor `system`), the e-mail `tenant.provisioning_failed` to every active owner
//     (keyed by the job id, so one per owner and job) and, after the commit, the `tenant` invalidation;
//   - `migrate`, `suspend`, `resume` (and the post-MVP kinds): `tenants.status` never changes;
//   - every kind: one `ops.alert` to OPS_ALERT_EMAIL (keyed `provisioning.failed:<jobId>`).
//
// The error the job keeps is `<step> failed: <CODE>: <message>` (or `<CODE>: <message>` without a step), at most 1,000
// characters: the OTA worker's codes and messages carry no values or secrets by contract (ADR-0009 item 10), and the
// platform's own are written here. A `tenant.provision_failed` event also appends the OTA worker's steps of the attempt
// to the job's step log, so the setup page shows which step failed.
//
// "Now" is the injected Clock's time, as in the other provisioning code, so backoffs follow the FakeClock in tests.
import { Inject, Injectable } from "@nestjs/common";
import type { ProvisioningStepRecord, TenantJobError } from "@velexis/api-types/jobs";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { MembershipsRepository } from "../memberships/memberships.repository";
import { OutboxService } from "../notifications/outbox.service";
import { TenantsRepository } from "../tenants/tenants.repository";
import { PROVISIONING_ACTOR_LABEL } from "./post-steps/activate.step";
import {
  MAX_JOB_ERROR_LENGTH,
  ProvisioningJobsRepository,
  type LockedJobRow,
  type ProvisioningJobKind,
} from "./provisioning-jobs.repository";

/** The backoff of the first re-queue; each later attempt doubles it (PADR-0001 item 4). */
export const RETRY_BASE_DELAY_MS = 30_000;

/** How long a job waits after its failed attempt `attempt` before the reconciler dispatches it again. */
export function retryDelayMs(attempt: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** attempt;
}

/** Who noticed the failure (see the file header). */
export type FailureSource = "event" | "post_steps" | "reconciler";

/** One failed attempt of a job. */
export interface JobFailure {
  readonly jobId: string;
  /** The attempt that failed. */
  readonly attempt: number;
  readonly error: TenantJobError;
  /** True: another attempt may succeed (the OTA worker's word, or a lost attempt); false fails the job at once. */
  readonly retryable: boolean;
  readonly source: FailureSource;
  /** The step that failed: a post-step, or the OTA worker's failed step. */
  readonly step?: string;
  /** Entries for the job's step log: the OTA worker's steps of the attempt. */
  readonly steps?: readonly ProvisioningStepRecord[];
  /**
   * The reconciler's condition: the job's lease must have ended by this time. A job whose lease was extended meanwhile
   * is left alone.
   */
  readonly leaseEndedBy?: Date;
  /** The request id of what caused the failure (the event's), for the audit row and the log lines. */
  readonly requestId?: string;
}

/** Why a failure changed nothing. */
export type FailureIgnoredReason = "unknown_job" | "stale_attempt" | "not_running" | "lease_active";

/** What `handle` did. */
export type FailureOutcome =
  | {
      readonly outcome: "requeued";
      readonly jobId: string;
      readonly attempt: number;
      readonly scheduledAt: Date;
    }
  | {
      readonly outcome: "failed";
      readonly jobId: string;
      readonly kind: ProvisioningJobKind;
      readonly attempt: number;
      /** True when this failure set the tenant `failed` (a `provision` job of a `provisioning` tenant). */
      readonly tenantFailed: boolean;
    }
  | { readonly outcome: "ignored"; readonly jobId: string; readonly reason: FailureIgnoredReason };

/** What `failureDecision` decided for a job as read under its lock. */
export type FailureDecision =
  | { readonly action: "requeue"; readonly scheduledAt: Date }
  | { readonly action: "fail" }
  | { readonly action: "ignore"; readonly reason: FailureIgnoredReason };

/**
 * What a failure does to `job` (read under its row lock) at `now`: nothing when the job is unknown, at another attempt,
 * not `running`, or (for the reconciler) inside a lease again; a re-queue with the backoff when the failure is
 * retryable and attempts are left; otherwise the job fails.
 */
export function failureDecision(
  job: Pick<LockedJobRow, "status" | "attempt" | "max_attempts" | "locked_until"> | undefined,
  failure: Pick<JobFailure, "attempt" | "retryable" | "leaseEndedBy">,
  now: Date,
): FailureDecision {
  if (job === undefined) {
    return { action: "ignore", reason: "unknown_job" };
  }
  if (job.attempt !== failure.attempt) {
    return { action: "ignore", reason: "stale_attempt" };
  }
  if (job.status !== "running") {
    return { action: "ignore", reason: "not_running" };
  }
  if (
    failure.leaseEndedBy !== undefined &&
    (job.locked_until === null || job.locked_until.getTime() > failure.leaseEndedBy.getTime())
  ) {
    return { action: "ignore", reason: "lease_active" };
  }
  if (failure.retryable && job.attempt < job.max_attempts) {
    return { action: "requeue", scheduledAt: new Date(now.getTime() + retryDelayMs(job.attempt)) };
  }
  return { action: "fail" };
}

/** What a job that failed for good does besides its own row (PADR-0001 item 7). */
export interface FailureEffects {
  /** Try `provisioning → failed` on the tenant (only a `provision` job ever does). */
  readonly failTenant: boolean;
  /** Always: ops hear of every job that failed for good. */
  readonly opsAlert: true;
}

/** The effects of a failed job of kind `kind`: only `provision` touches the tenant's status. */
export function failureEffects(kind: ProvisioningJobKind): FailureEffects {
  return { failTenant: kind === "provision", opsAlert: true };
}

/** The job's `error` for `failure`: `<step> failed: <CODE>: <message>`, at most MAX_JOB_ERROR_LENGTH characters. */
export function jobErrorText(failure: Pick<JobFailure, "error" | "step">): string {
  const prefix = failure.step === undefined ? "" : `${failure.step} failed: `;
  return `${prefix}${failure.error.code}: ${failure.error.message}`.slice(0, MAX_JOB_ERROR_LENGTH);
}

/** The `ops.alert` of a job that failed for good. */
export function jobFailedAlert(
  job: Pick<LockedJobRow, "id" | "kind" | "tenant_id" | "tenant_key" | "attempt" | "max_attempts">,
  failure: Pick<JobFailure, "error" | "step" | "retryable" | "source">,
  tenantFailed: boolean,
): { title: string; message: string } {
  const why = failure.retryable
    ? `Its attempt ${job.attempt} of ${job.max_attempts} failed and no attempt is left.`
    : `Its attempt ${job.attempt} failed with an error that is not retried.`;
  const effect =
    job.kind === "provision"
      ? tenantFailed
        ? "The OTA is now failed: its owners were told by e-mail and can retry the setup in the portal."
        : "The OTA was not provisioning any more, so its status did not change."
      : `The OTA's status did not change (a ${job.kind} job never changes it).`;
  return {
    title: `Provisioning job failed: ${job.kind} of ${job.tenant_key}`,
    message:
      `The ${job.kind} job ${job.id} of the OTA ${job.tenant_key} (${job.tenant_id}) failed. ${why} ` +
      `Error: ${jobErrorText(failure)} (noticed by: ${failure.source}). ${effect} ` +
      "See the job in the platform admin (Provisioning jobs) and the logs of the OTA worker.",
  };
}

@Injectable()
export class ProvisioningFailureHandler {
  constructor(
    private readonly jobs: ProvisioningJobsRepository,
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(ProvisioningFailureHandler.name) private readonly logger: PinoLogger,
  ) {}

  /** Ends the failed attempt `failure` (see the file header). Rejects only when the transaction fails. */
  async handle(failure: JobFailure): Promise<FailureOutcome> {
    const outcome = await runInTransaction(this.db, async (trx): Promise<FailureOutcome> => {
      const now = this.clock.now();
      const job = await this.jobs.lockForLifecycle(trx, failure.jobId);
      const decision = failureDecision(job, failure, now);
      if (job === undefined || decision.action === "ignore") {
        return {
          outcome: "ignored",
          jobId: failure.jobId,
          reason: decision.action === "ignore" ? decision.reason : "unknown_job",
        };
      }
      const write = {
        jobId: job.id,
        attempt: job.attempt,
        error: jobErrorText(failure),
        ...(failure.steps === undefined ? {} : { entries: failure.steps }),
        ...(failure.step === undefined ? {} : { step: failure.step }),
        now,
      };
      if (decision.action === "requeue") {
        if (!(await this.jobs.requeue(trx, { ...write, scheduledAt: decision.scheduledAt }))) {
          return { outcome: "ignored", jobId: job.id, reason: "not_running" };
        }
        return {
          outcome: "requeued",
          jobId: job.id,
          attempt: job.attempt,
          scheduledAt: decision.scheduledAt,
        };
      }
      if (!(await this.jobs.markFailed(trx, write))) {
        return { outcome: "ignored", jobId: job.id, reason: "not_running" };
      }
      const tenantFailed = await this.applyEffects(trx, job, failure, now);
      return { outcome: "failed", jobId: job.id, kind: job.kind, attempt: job.attempt, tenantFailed };
    });
    this.log(failure, outcome);
    return outcome;
  }

  /** The effects of a job that failed for good, in its transaction; true when the tenant became `failed`. */
  private async applyEffects(
    trx: PlatformTransaction,
    job: LockedJobRow,
    failure: JobFailure,
    now: Date,
  ): Promise<boolean> {
    const effects = failureEffects(job.kind);
    const tenantFailed = effects.failTenant && (await this.tenants.failProvisioning(trx, job.tenant_id, now));
    if (tenantFailed) {
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: PROVISIONING_ACTOR_LABEL,
        action: "tenant.provisioning_failed",
        targetType: "tenant",
        targetId: job.tenant_id,
        tenantId: job.tenant_id,
        tenantKey: job.tenant_key,
        before: { status: "provisioning" },
        after: { status: "failed" },
        details: {
          jobId: job.id,
          attempt: job.attempt,
          maxAttempts: job.max_attempts,
          code: failure.error.code,
          ...(failure.step === undefined ? {} : { step: failure.step }),
          source: failure.source,
        },
        ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      });
      const owners = (await this.memberships.listActive(job.tenant_id, trx)).filter(
        (member) => member.role === "owner",
      );
      for (const owner of owners) {
        await this.outbox.queue(trx, {
          templateKey: "tenant.provisioning_failed",
          to: owner.email,
          accountId: owner.account_id,
          tenantId: job.tenant_id,
          data: { fullName: owner.full_name, tenantName: job.tenant_name, tenantKey: job.tenant_key },
          idempotencyKey: job.id,
        });
      }
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: job.tenant_id });
    }
    await this.outbox.queueOpsAlert(trx, {
      ...jobFailedAlert(job, failure, tenantFailed),
      tenantId: job.tenant_id,
      idempotencyKey: `provisioning.failed:${job.id}`,
    });
    return tenantFailed;
  }

  private log(failure: JobFailure, outcome: FailureOutcome): void {
    const context = {
      jobId: failure.jobId,
      attempt: failure.attempt,
      source: failure.source,
      code: failure.error.code,
      ...(failure.step === undefined ? {} : { step: failure.step }),
      ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
    };
    switch (outcome.outcome) {
      case "requeued":
        this.logger.info(
          { ...context, scheduledAt: outcome.scheduledAt.toISOString() },
          "provisioning.retry_scheduled",
        );
        return;
      case "failed":
        this.logger.warn(
          { ...context, kind: outcome.kind, tenantFailed: outcome.tenantFailed },
          "provisioning.job_failed",
        );
        return;
      case "ignored":
        this.logger.info({ ...context, reason: outcome.reason }, "provisioning.failure_ignored");
        return;
    }
  }
}
