// The consumer of `ota-tenant-ops` (OBE-005; OADR-0007 item 1, PADR-0001, tenant provisioning flow §1–§3). It runs
// in the worker only (WorkerModule imports ProvisioningModule; the API never does), with the queue's concurrency of
// 2 and the retention of ADR-0009. Every job is validated first (`validateTenantOpsJob`, OBE-002): a name that is not
// a message of the queue, or a payload outside its contract, fails at once as `UnrecoverableError`. Then it
// dispatches on the name:
//
// - `tenant.provision`: `ProvisioningService.provisionTenant`, then, after the provisioning transaction committed,
//   `tenant.provisioned` or `tenant.provision_failed {retryable: false}` (followed by `UnrecoverableError`, so BullMQ
//   does not retry it). Any other error is thrown as it is: BullMQ retries it within the attempt (OBE-006 reports
//   the final one);
// - `tenant.migrate`, `tenant.suspend`, `tenant.resume`: not handled by this release (OBE-006, M4–M5); they fail
//   as unrecoverable, and the platform's reconciler counts the job as failed (PADR-0001 item 7).
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import type { TenantOpsJob, TenantProvisionJob } from "@velexis/api-types/jobs";
import { UnrecoverableError, type Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { validateTenantOpsJob } from "../common/queues/job-validation";
import { OTA_QUEUE, otaWorkerOptions } from "../common/queues/queue-names";
import { ProvisioningService } from "./provisioning.service";
import { dispatchAttempt, TenantEventsProducer, type TenantEventSource } from "./tenant-events.producer";

/** What a completed job returns (stored by BullMQ with the job): names and versions only. */
export interface TenantOpsJobResult {
  readonly event: "tenant.provisioned";
  readonly schemaName: string;
  readonly schemaVersion: string;
}

/** The message names of `ota-tenant-ops` this release does not handle yet. */
export type UnhandledTenantOpsJobName = Exclude<TenantOpsJob["name"], "tenant.provision">;

@Processor(OTA_QUEUE.tenantOps, otaWorkerOptions(OTA_QUEUE.tenantOps))
export class TenantOpsProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly provisioning: ProvisioningService,
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
      case "tenant.suspend":
      case "tenant.resume":
        throw this.unhandled(job, message.name);
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
    const source: TenantEventSource = { message, attempt: dispatchAttempt(job.id, message.jobId) };
    const context = {
      queue: job.queueName,
      jobId: job.id,
      tenantId: message.tenantId,
      requestId: message.requestId,
    };
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
    const { error } = result.payload;
    await this.events.provisionFailed(source, result.payload);
    this.logger.warn({ ...context, code: error.code, retryable: false }, "tenant_ops.provision_failed");
    throw new UnrecoverableError(`${error.code}: ${error.message}`);
  }

  private unhandled(job: Job, name: UnhandledTenantOpsJobName): UnrecoverableError {
    this.logger.error({ queue: job.queueName, jobId: job.id, jobName: name }, "tenant_ops.unhandled");
    return new UnrecoverableError(`${name} is not handled by this release of the OTA worker`);
  }
}
