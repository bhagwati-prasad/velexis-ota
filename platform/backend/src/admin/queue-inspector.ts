// The BullMQ queue inspector of the platform admin (PBE-031; platform/docs/api-inventory-admin.md §3, flows/platform-
// admin-operations.md §C, ADR-0009 item 11, scope PF-84): the admin reads BullMQ state through the platform API, never
// by connecting a UI to Redis. It knows every queue of both backends, by owner (ADR-0009 item 4): `PLATFORM_QUEUES`
// (`owner: platform`, consumed by the platform worker), then `OTA_QUEUES` (`owner: ota`, `ota-tenant-ops` among them,
// which the platform produces and the OTA worker consumes), from `@velexis/api-types/jobs`, in that order.
//
// - `listQueues()`: per queue, the counts `waiting` (the wait list, a paused queue's list and prioritized jobs),
//   `active`, `delayed` and `failed` (kept 30 days, ADR-0009 item 7), and `oldestWaitingSeconds`, the age at the
//   Clock's time of the job at the head of the wait list (the one added first, BullMQ hands them out in that order),
//   `null` when none waits.
// - `listFailed(queue, limit)`: the failed jobs of one queue, most recent failure first, with their reason, attempts,
//   failure time and data. Queue messages hold ids only by contract (ADR-0009 item 10); the data still passes through
//   the shared redactor of @velexis/logger before it is answered.
// - `failedJob(queue, id)` and `retry(job)`: the read and the move back to waiting (a new attempt budget,
//   `resetAttemptsMade`) behind adminRetryQueueJob; the service checks the owner first (`ota-*` queues are view-only).
// - `jobState(queue, id)`: the BullMQ state of one job (`unknown` when BullMQ does not hold it), for the provisioning
//   job detail's `<jobId>-<attempt>` on `ota-tenant-ops`.
//
// It reads with the process's command client (`REDIS_CLIENT` of RedisModule), not the BullMQ connection, on read-only
// `Queue` objects of its own (prefix `vx`, created on first use, closed at shutdown; the shared client stays open): the
// command client fails fast while Redis is down (one retry per command), where the BullMQ connection waits for Redis to
// come back. Every call is also bounded by QUEUE_INSPECTION_TIMEOUT_MS, and a Redis error or a timeout answers `503
// SERVICE_UNAVAILABLE` (logged as `admin.queue_unavailable`, with the queue and the error, never a job's data). The
// `Queue` objects skip BullMQ's wait for `ready` and its version check, so one created while Redis is down works once
// it is back, and they skip the meta hash a new `Queue` writes (`<prefix>:<queue>:meta`, the owning backend's), so
// opening a queue writes nothing. Nothing here adds a job or writes a key, and nothing but `retry` changes a job.
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { BULLMQ_PREFIX, OTA_QUEUES, PLATFORM_QUEUES, type QueueName } from "@velexis/api-types/jobs";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { Queue, type Job, type JobState } from "bullmq";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { REDIS_CLIENT } from "../common/redis/redis.module";

export type QueueCounts = components["schemas"]["QueueCounts"];
export type QueueList = components["schemas"]["QueueList"];
export type FailedQueueJob = components["schemas"]["FailedQueueJob"];
export type FailedQueueJobList = components["schemas"]["FailedQueueJobList"];

/** The backend whose worker consumes a queue: only `platform` queues can be retried from the admin. */
export type QueueOwner = QueueCounts["owner"];

/** The state of a BullMQ job by its id: one of BullMQ's, or `unknown` when BullMQ does not hold it. */
export type InspectedJobState = JobState | "unknown";

/** How long one inspection (all queues' counts, a failed list, a look-up or a retry) may take before it answers 503. */
export const QUEUE_INSPECTION_TIMEOUT_MS = 3000;

/** Every queue of both backends with its owner, platform queues first, each list in its own order. */
export const INSPECTED_QUEUES: ReadonlyArray<{ readonly name: QueueName; readonly owner: QueueOwner }> =
  Object.freeze([
    ...PLATFORM_QUEUES.map((name) => ({ name, owner: "platform" as const })),
    ...OTA_QUEUES.map((name) => ({ name, owner: "ota" as const })),
  ]);

const OWNERS: ReadonlyMap<string, QueueOwner> = new Map(
  INSPECTED_QUEUES.map(({ name, owner }) => [name, owner] as const),
);

/** The owner of queue `name`, or `undefined` when it is no queue of either backend. */
export function queueOwnerOf(name: string): QueueOwner | undefined {
  return OWNERS.get(name);
}

/** The BullMQ job counts the inspector asks for: the three waiting states, then the others of QueueCounts. */
const COUNTED_STATES = ["waiting", "paused", "prioritized", "active", "delayed", "failed"] as const;

/** The QueueCounts of a queue from BullMQ's counts and the timestamp of its oldest waiting job, at `now`. */
export function toQueueCounts(
  queue: { readonly name: QueueName; readonly owner: QueueOwner },
  counts: Readonly<Partial<Record<string, number>>>,
  oldestWaitingTimestamp: number | undefined,
  now: Date,
): QueueCounts {
  const count = (state: (typeof COUNTED_STATES)[number]): number => counts[state] ?? 0;
  return {
    name: queue.name,
    owner: queue.owner,
    waiting: count("waiting") + count("paused") + count("prioritized"),
    active: count("active"),
    delayed: count("delayed"),
    failed: count("failed"),
    oldestWaitingSeconds:
      oldestWaitingTimestamp === undefined
        ? null
        : Math.max(0, Math.floor((now.getTime() - oldestWaitingTimestamp) / 1000)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The FailedQueueJob of a failed BullMQ job: its data redacted (an object, `{}` for anything else). */
export function toFailedQueueJob(
  job: Pick<Job, "id" | "name" | "failedReason" | "attemptsMade" | "finishedOn" | "data">,
): FailedQueueJob {
  const data: unknown = job.data;
  return {
    id: job.id ?? "",
    name: job.name,
    failedReason: typeof job.failedReason === "string" ? job.failedReason : null,
    attemptsMade: job.attemptsMade,
    failedAt: typeof job.finishedOn === "number" ? new Date(job.finishedOn).toISOString() : null,
    data: isRecord(data) ? redactPayload(data) : {},
  };
}

/** Thrown inside the inspector when a call outlives QUEUE_INSPECTION_TIMEOUT_MS. */
class InspectionTimeoutError extends Error {
  override readonly name = "InspectionTimeoutError";
}

@Injectable()
export class QueueInspector implements OnApplicationShutdown {
  /** The read-only Queue objects, one per queue name, created on first use. */
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly clock: Clock,
    @InjectPinoLogger(QueueInspector.name) private readonly logger: PinoLogger,
  ) {}

  /** adminListQueues: the counts of every queue of both backends (see the file header). */
  async listQueues(): Promise<QueueList> {
    const data = await this.inspect("*", () =>
      Promise.all(
        INSPECTED_QUEUES.map(async (entry) => {
          const queue = this.queue(entry.name);
          const [counts, oldest] = await Promise.all([
            queue.getJobCounts(...COUNTED_STATES),
            queue.getWaiting(0, 0),
          ]);
          return toQueueCounts(entry, counts, oldest[0]?.timestamp, this.clock.now());
        }),
      ),
    );
    return { data };
  }

  /** adminListFailedQueueJobs: the failed jobs of a known queue, most recent failure first, at most `limit`. */
  async listFailed(name: QueueName, limit: number): Promise<FailedQueueJobList> {
    const jobs = await this.inspect(name, () => this.queue(name).getFailed(0, limit - 1));
    return { data: jobs.map(toFailedQueueJob) };
  }

  /** The job `id` of a known queue when it is `failed` there; `undefined` when BullMQ has no failed job of that id. */
  async failedJob(name: QueueName, id: string): Promise<Job | undefined> {
    return this.inspect(name, async () => {
      const queue = this.queue(name);
      if ((await queue.getJobState(id)) !== "failed") {
        return undefined;
      }
      return queue.getJob(id);
    });
  }

  /**
   * Moves a failed job of `failedJob` back to waiting with a new attempt budget. False when it is no longer failed (a
   * concurrent retry, or BullMQ removed it); a Redis error or a timeout answers `503 SERVICE_UNAVAILABLE`.
   */
  async retry(name: QueueName, job: Job): Promise<boolean> {
    return this.inspect(name, async () => {
      try {
        await job.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
        return true;
      } catch (error) {
        // BullMQ refuses a job that is not failed any more; tell that apart from Redis being gone by asking again.
        if ((await this.queue(name).getJobState(job.id ?? "")) !== "failed") {
          return false;
        }
        throw error;
      }
    });
  }

  /** The BullMQ state of job `id` on a known queue (`unknown` when BullMQ does not hold it). */
  async jobState(name: QueueName, id: string): Promise<InspectedJobState> {
    return this.inspect(name, () => this.queue(name).getJobState(id));
  }

  async onApplicationShutdown(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    // The client is shared: closing a Queue removes its listeners and leaves the connection to RedisModule.
    await Promise.allSettled(queues.map((queue) => queue.close()));
  }

  /** The read-only Queue of `name`, created on first use. */
  private queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (queue === undefined) {
      queue = new Queue(name, {
        connection: this.redis,
        prefix: BULLMQ_PREFIX,
        // RedisModule's client is connected, or connects on its first command; QueuesModule checked the version.
        skipWaitingForReady: true,
        skipVersionCheck: true,
        // The meta hash (options, BullMQ version) is written by the backend that owns the queue, never by the admin.
        skipMetasUpdate: true,
      });
      // RedisModule logs every outage of the client once; a listener keeps BullMQ's forwarded errors from throwing.
      queue.on("error", () => undefined);
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Runs `work` within QUEUE_INSPECTION_TIMEOUT_MS; a Redis error or a timeout becomes `503 SERVICE_UNAVAILABLE`. */
  private async inspect<T>(queue: string, work: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new InspectionTimeoutError(`no answer within ${QUEUE_INSPECTION_TIMEOUT_MS} ms`)),
        QUEUE_INSPECTION_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([work(), timedOut]);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      this.logger.warn({ queue, err: error }, "admin.queue_unavailable");
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
