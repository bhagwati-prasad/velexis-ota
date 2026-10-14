// The OTA worker's reports on `platform-tenant-events` (OBE-005; OADR-0007 item 5, PADR-0001 items 4–5, platform
// architecture §6.1). Each event answers one `ota-tenant-ops` message: same `jobId` and `tenantId`, the message's
// `requestId` for log correlation, and `requestedAt` from the injected Clock. It is validated with `validateJob` of
// `@velexis/api-types/jobs` before `queue.add`, so a malformed event is a bug here and never reaches the platform.
//
// BullMQ job id: the dispatch attempt's id `<jobId>-<attempt>` (`bullmqJobId`), the id the message itself came
// with. The platform reads the attempt from it and ignores events of older attempts (PADR-0001 item 5), and a
// second report of the same attempt, after BullMQ ran the message again, adds nothing. A message whose BullMQ id has
// another shape gets an event with an id BullMQ generates.
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import {
  bullmqJobId,
  JOB_CONTRACT_VERSION,
  parseBullmqJobId,
  validateJob,
  type TenantEvent,
  type TenantOpsJob,
  type TenantProvisionedEvent,
  type TenantProvisionedPayload,
  type TenantProvisionFailedEvent,
  type TenantProvisionFailedPayload,
} from "@velexis/api-types/jobs";
import type { JobsOptions, Queue } from "bullmq";
import { Clock } from "../common/clock";
import { PLATFORM_TENANT_EVENTS } from "../common/queues/queue-names";

/** The message an event answers, and the dispatch attempt it came with. */
export interface TenantEventSource {
  readonly message: Pick<TenantOpsJob, "jobId" | "tenantId" | "requestId">;
  /** The attempt of the message's BullMQ id `<jobId>-<attempt>`; `undefined` when its id has another shape. */
  readonly attempt: number | undefined;
}

/**
 * The dispatch attempt of a message from its BullMQ job id: `2` for `job_01J…-2` when the id names the message's own
 * `jobId`, otherwise `undefined`.
 */
export function dispatchAttempt(bullmqId: string | undefined, jobId: string): number | undefined {
  const parsed = bullmqId === undefined ? null : parseBullmqJobId(bullmqId);
  return parsed !== null && parsed.jobId === jobId ? parsed.attempt : undefined;
}

/** The BullMQ options of an event: the attempt's job id when known; everything else from the queue defaults. */
export function eventJobOptions(source: TenantEventSource): JobsOptions {
  return source.attempt === undefined ? {} : { jobId: bullmqJobId(source.message.jobId, source.attempt) };
}

@Injectable()
export class TenantEventsProducer {
  constructor(
    @InjectQueue(PLATFORM_TENANT_EVENTS) private readonly queue: Queue,
    private readonly clock: Clock,
  ) {}

  /** Publishes `tenant.provisioned`: the schema is complete; the platform mirrors the ledger and runs its steps. */
  async provisioned(
    source: TenantEventSource,
    payload: TenantProvisionedPayload,
  ): Promise<TenantProvisionedEvent> {
    return this.publish({ ...this.envelope(source), name: "tenant.provisioned", payload }, source);
  }

  /** Publishes `tenant.provision_failed`: the attempt failed for good (`retryable: false`) or after its retries. */
  async provisionFailed(
    source: TenantEventSource,
    payload: TenantProvisionFailedPayload,
  ): Promise<TenantProvisionFailedEvent> {
    return this.publish({ ...this.envelope(source), name: "tenant.provision_failed", payload }, source);
  }

  private envelope(source: TenantEventSource) {
    const { jobId, tenantId, requestId } = source.message;
    return {
      v: JOB_CONTRACT_VERSION,
      jobId,
      tenantId,
      requestedAt: this.clock.now().toISOString(),
      requestId,
    } as const;
  }

  /** Validates the event against its JSON Schema, then adds it. Resolves once Redis has it. */
  private async publish<E extends TenantEvent>(event: E, source: TenantEventSource): Promise<E> {
    validateJob(event.name, event);
    await this.queue.add(event.name, event, eventJobOptions(source));
    return event;
  }
}
