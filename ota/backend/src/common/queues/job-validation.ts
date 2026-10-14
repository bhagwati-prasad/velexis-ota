// Validation of the cross-backend messages a processor takes from a queue (OBE-002; ADR-0009 item 3). It wraps
// `validateJob` of `@velexis/api-types/jobs`: a message that does not match its contract, or that does not belong to
// the queue it came from, is a bug of the producer and retrying cannot fix it, so it fails the job at once with
// BullMQ's `UnrecoverableError` (no further attempts) and is logged without the payload: the log line names the queue,
// the BullMQ job id, the job name and the failing paths and rules, never a value of the message.
import {
  MessageValidationError,
  TENANT_EVENT_NAMES,
  TENANT_OPS_JOB_NAMES,
  validateJob,
  type TenantEvent,
  type TenantJobMessageMap,
  type TenantJobName,
  type TenantOpsJob,
} from "@velexis/api-types/jobs";
import { UnrecoverableError, type Job } from "bullmq";

/** The parts of a BullMQ job the validation reads: `Job` itself, or a plain object in tests. */
export type QueuedJob = Pick<Job, "id" | "name" | "data" | "queueName">;

/** What the validation logs with: pino's call shape, so `PinoLogger` and a pino logger both fit. */
export interface JobValidationLogger {
  error(object: Record<string, unknown>, message: string): void;
}

/** The log message of a refused job. */
export const JOB_INVALID_LOG = "queue.job_invalid";

/** Job names longer than this are shortened in the log line; they come from the producer. */
const MAX_NAME_IN_LOG = 64;

function shortened(value: string): string {
  return value.length > MAX_NAME_IN_LOG ? `${value.slice(0, MAX_NAME_IN_LOG)}…` : value;
}

/** Logs the refusal without the payload and turns it into the error that ends the job without a retry. */
function refuse(
  job: QueuedJob,
  error: MessageValidationError,
  logger: JobValidationLogger,
): UnrecoverableError {
  logger.error(
    {
      queue: job.queueName,
      jobId: job.id,
      jobName: shortened(String(job.name)),
      issues: error.issues,
    },
    JOB_INVALID_LOG,
  );
  // The message names paths and rules only (MessageValidationError), so BullMQ may store it as `failedReason`.
  return new UnrecoverableError(error.message);
}

/**
 * Validates the message of a job taken from a queue against the contract of its name and returns it, typed.
 * `accepted` lists the message names the queue carries; any other name, a payload that does not match its schema
 * (a missing or extra field, a wrong id, a `data.name` other than the job name) or a name that is not a message at
 * all is logged as `queue.job_invalid` and thrown as `UnrecoverableError`.
 *
 * @throws {UnrecoverableError} when the job is refused; BullMQ then fails it without further attempts.
 */
export function validateQueuedJob<TName extends TenantJobName>(
  job: QueuedJob,
  accepted: readonly TName[],
  logger: JobValidationLogger,
): TenantJobMessageMap[TName] {
  const name: unknown = job.name;
  if (!(accepted as readonly unknown[]).includes(name)) {
    throw refuse(
      job,
      new MessageValidationError(JSON.stringify(shortened(String(name))), [
        {
          path: "/name",
          keyword: "name",
          message: `is not a message of queue ${job.queueName}: use one of ${accepted.join(", ")}`,
        },
      ]),
      logger,
    );
  }
  try {
    return validateJob(name as TName, job.data);
  } catch (error) {
    if (error instanceof MessageValidationError) {
      throw refuse(job, error, logger);
    }
    throw error;
  }
}

/** A job of `ota-tenant-ops`: `tenant.provision`, `tenant.migrate`, `tenant.suspend` or `tenant.resume`. */
export function validateTenantOpsJob(job: QueuedJob, logger: JobValidationLogger): TenantOpsJob {
  return validateQueuedJob(job, TENANT_OPS_JOB_NAMES, logger);
}

/** A job of `platform-tenant-events` (the OTA only produces them; its tests read them back). */
export function validateTenantEventJob(job: QueuedJob, logger: JobValidationLogger): TenantEvent {
  return validateQueuedJob(job, TENANT_EVENT_NAMES, logger);
}
