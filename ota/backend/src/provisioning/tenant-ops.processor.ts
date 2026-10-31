// The consumer of `ota-tenant-ops` (OBE-005, OBE-006, OBE-074; OADR-0007 items 1, 5, 6 and 8, PADR-0001 item 4,
// PADR-0014 items 3, 4 and 7, tenant provisioning flow §1–§3 and §5). It runs in the worker only (WorkerModule
// imports ProvisioningModule; the API never does), with the queue's concurrency of 2 and the retention of ADR-0009.
// Every job is validated first (`validateTenantOpsJob`, OBE-002): a name that is not a message of the queue, or a
// payload outside its contract, fails at once as `UnrecoverableError`. Then it dispatches on the name:
//
// - `tenant.provision`: `ProvisioningService.provisionTenant`, then `tenant.provisioned` or
//   `tenant.provision_failed`;
// - `tenant.migrate`: `ProvisioningService.migrateTenant(tenantId, targetVersion)`, then `tenant.migrated` or
//   `tenant.migration_failed`;
// - `tenant.suspend`: `HousekeepingService.suspend` (the staff cut-off, the expiry of open checkouts and their voids),
//   then `tenant.suspended`; `tenant.resume`: `HousekeepingService.resume` (the cut-off removed), then
//   `tenant.resumed`. Both are answered also when the message no longer matches the tenant's status (a no-op,
//   PADR-0014 item 7). A failure of the housekeeping (PostgreSQL, Redis) is thrown back to BullMQ, which tries the
//   message again (the platform dispatches with `attempts: 3`); there is no failure event for these messages, so a
//   job that fails for good is the platform reconciler's (PADR-0001 item 7).
//
// Results are published after the transaction ended. A failure is reported once per dispatch attempt
// (failure-classifier.ts): a non-retryable one at once, and the job then fails with `UnrecoverableError`, so BullMQ
// does not try again; a retryable one (lock timeout, serialization failure, deadlock, lost connection) is thrown back
// to BullMQ as long as the job has tries left (the platform dispatches with `attempts: 3`), and only its last try
// publishes the failure with `retryable: true`, after which the platform re-dispatches with backoff. Log lines carry
// the error code, never the error itself (it may quote SQL).
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import type {
  TenantJobError,
  TenantMigrateJob,
  TenantOpsJob,
  TenantProvisionJob,
  TenantResumeJob,
  TenantSuspendJob,
} from "@velexis/api-types/jobs";
import { UnrecoverableError, type Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { validateTenantOpsJob } from "../common/queues/job-validation";
import { OTA_QUEUE, otaWorkerOptions } from "../common/queues/queue-names";
import { HousekeepingService, type ResumeOutcome, type SuspendOutcome } from "./housekeeping.service";
import { ProvisioningService } from "./provisioning.service";
import { dispatchAttempt, TenantEventsProducer, type TenantEventSource } from "./tenant-events.producer";

/** What a completed job returns (stored by BullMQ with the job): names, versions and counts only. */
export type TenantOpsJobResult =
  | {
      readonly event: "tenant.provisioned" | "tenant.migrated";
      readonly schemaName: string;
      readonly schemaVersion: string;
    }
  | { readonly event: "tenant.suspended"; readonly outcome: SuspendOutcome }
  | { readonly event: "tenant.resumed"; readonly outcome: ResumeOutcome };

/** The parts of a BullMQ job that say whether BullMQ tries it again after a failure. */
export type JobTries = Pick<Job, "attemptsMade"> & { readonly opts: Pick<Job["opts"], "attempts"> };

/**
 * True when this is the job's last try: BullMQ moves a failed job to `failed` instead of retrying it once
 * `attemptsMade + 1` reaches `opts.attempts` (a job without `attempts` has one try).
 */
export function isLastTry(job: JobTries): boolean {
  return job.attemptsMade + 1 >= Math.max(1, job.opts.attempts ?? 1);
}

/** A failed result of the provisioning service: the event's payload and the error the run threw, if any. */
interface FailedRun<P> {
  readonly payload: P;
  readonly cause?: unknown;
}

/** The error a retryable failure is thrown back to BullMQ with: the run's own error, so BullMQ records it. */
function retryError(error: TenantJobError, cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(`${error.code}: ${error.message}`);
}

/** The code of a thrown error for a log line: its `code` (a SQLSTATE, an `AppError` code) or its name; never more. */
function errorCodeOf(error: unknown): string {
  const code: unknown =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && code.length <= 64) {
    return code;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}

@Processor(OTA_QUEUE.tenantOps, otaWorkerOptions(OTA_QUEUE.tenantOps))
export class TenantOpsProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly housekeeping: HousekeepingService,
    private readonly events: TenantEventsProducer,
    @InjectPinoLogger(TenantOpsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<TenantOpsJobResult> {
    const message = validateTenantOpsJob(job, this.logger);
    switch (message.name) {
      case "tenant.provision":
        return this.provision(job, message);
      case "tenant.migrate":
        return this.migrate(job, message);
      case "tenant.suspend":
        return this.suspend(job, message);
      case "tenant.resume":
        return this.resume(job, message);
    }
  }

  /** Errors of the worker itself (its Redis connections); job failures are BullMQ's `failed` events. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: OTA_QUEUE.tenantOps, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }

  private async provision(job: Job, message: TenantProvisionJob): Promise<TenantOpsJobResult> {
    const source = this.source(job, message);
    const context = this.context(job, message);
    const result = await this.provisioning.provisionTenant(message.tenantId);
    if (result.status === "provisioned") {
      const { schemaName, schemaVersion, migrations, steps } = result.payload;
      await this.events.provisioned(source, result.payload);
      this.logger.info(
        {
          ...context,
          schemaName,
          schemaVersion,
          migrations: migrations.length,
          steps: steps.map((done) => `${done.step}:${done.status}`),
        },
        "tenant_ops.provisioned",
      );
      return { event: "tenant.provisioned", schemaName, schemaVersion };
    }
    return this.fail(job, context, result, "tenant_ops.provision_failed", (payload) =>
      this.events.provisionFailed(source, payload),
    );
  }

  private async migrate(job: Job, message: TenantMigrateJob): Promise<TenantOpsJobResult> {
    const source = this.source(job, message);
    const { targetVersion } = message.payload;
    const context = { ...this.context(job, message), targetVersion: targetVersion ?? null };
    const result = await this.provisioning.migrateTenant(message.tenantId, targetVersion);
    if (result.status === "migrated") {
      const { schemaName, applied } = result;
      const { schemaVersion, migrations } = result.payload;
      await this.events.migrated(source, result.payload);
      this.logger.info(
        { ...context, schemaName, schemaVersion, migrations: migrations.length, applied },
        "tenant_ops.migrated",
      );
      return { event: "tenant.migrated", schemaName, schemaVersion };
    }
    return this.fail(job, context, result, "tenant_ops.migration_failed", (payload) =>
      this.events.migrationFailed(source, payload),
    );
  }

  /** `tenant.suspend`: the housekeeping, then `tenant.suspended`, also for a no-op. */
  private async suspend(job: Job, message: TenantSuspendJob): Promise<TenantOpsJobResult> {
    const source = this.source(job, message);
    const context = { ...this.context(job, message), reason: message.payload.reason };
    const outcome = await this.housekeep(context, "tenant_ops.suspend_failed", () =>
      this.housekeeping.suspend(this.request(job, message)),
    );
    await this.events.suspended(source);
    this.logger.info({ ...context, ...outcome }, "tenant_ops.suspended");
    return { event: "tenant.suspended", outcome };
  }

  /** `tenant.resume`: the housekeeping, then `tenant.resumed`, also for a no-op. */
  private async resume(job: Job, message: TenantResumeJob): Promise<TenantOpsJobResult> {
    const source = this.source(job, message);
    const context = this.context(job, message);
    const outcome = await this.housekeep(context, "tenant_ops.resume_failed", () =>
      this.housekeeping.resume(this.request(job, message)),
    );
    await this.events.resumed(source);
    this.logger.info({ ...context, ...outcome }, "tenant_ops.resumed");
    return { event: "tenant.resumed", outcome };
  }

  /** Runs a housekeeping step; a failure is logged with its code (never the error) and thrown back to BullMQ. */
  private async housekeep<T>(
    context: Record<string, unknown>,
    logMessage: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.logger.warn({ ...context, code: errorCodeOf(error) }, logMessage);
      throw error;
    }
  }

  /**
   * Reports a failed run, or hands it back to BullMQ: a retryable failure with tries left is thrown as it is, for
   * BullMQ to retry; otherwise the failure event is published, and the job fails with the run's error (retryable, on
   * its last try) or with `UnrecoverableError` (not retryable, so BullMQ stops at once).
   */
  private async fail<P extends { readonly error: TenantJobError; readonly retryable?: boolean }>(
    job: Job,
    context: Record<string, unknown>,
    run: FailedRun<P>,
    logMessage: string,
    publish: (payload: P) => Promise<unknown>,
  ): Promise<never> {
    const { error } = run.payload;
    if (run.payload.retryable !== true) {
      await publish(run.payload);
      this.logger.warn({ ...context, code: error.code, retryable: false }, logMessage);
      throw new UnrecoverableError(`${error.code}: ${error.message}`);
    }
    const tries = { attempt: job.attemptsMade + 1, attempts: job.opts.attempts ?? 1 };
    if (!isLastTry(job)) {
      this.logger.warn({ ...context, ...tries, code: error.code, retryable: true }, "tenant_ops.retrying");
      throw retryError(error, run.cause);
    }
    await publish(run.payload);
    this.logger.warn({ ...context, ...tries, code: error.code, retryable: true }, logMessage);
    throw retryError(error, run.cause);
  }

  private source(job: Job, message: TenantOpsJob): TenantEventSource {
    return { message, attempt: dispatchAttempt(job.id, message.jobId) };
  }

  private context(job: Job, message: TenantOpsJob): Record<string, unknown> {
    return { queue: job.queueName, jobId: job.id, tenantId: message.tenantId, requestId: message.requestId };
  }

  /** The housekeeping's request: the tenant, and the BullMQ job id (else the message's job id) as request id. */
  private request(job: Job, message: TenantOpsJob): { tenantId: string; requestId: string } {
    return { tenantId: message.tenantId, requestId: job.id ?? message.jobId };
  }
}
