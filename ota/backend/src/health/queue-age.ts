// The BullMQ queues in the worker's readiness (OBE-025; OADR-0014 point 8, ADR-0016 "Health", `queues` of healthReady):
// for every queue the OTA worker consumes (`OTA_QUEUES`), the jobs waiting to run, how long the oldest of them has
// waited and the jobs that failed in the last hour. HealthService adds them to /health/ready on HEALTH_PORT; the answer
// stays 200 however old a job is, since the on-VM check (X-030) decides the alert threshold (10 minutes).
//
// - `waiting`: BullMQ's wait list, a paused queue's list and the prioritized jobs, the states a job is in until a
//   worker takes it, plus the delayed jobs that are due. A delayed job waits for its time, not for a worker, until it
//   is due; BullMQ moves a due one to the wait list only when a worker asks for its next job, so while every worker of
//   the queue is busy or stuck it stays in the delayed set although it waits for a worker (the schedulers' next runs on
//   `ota-maintenance` and the retries in their backoff among them). Delayed jobs are read in due order, the first ones
//   until one is not due yet (`countRecent`): one read when none is due.
// - `oldestWaitingSeconds`: at the Clock's time, the longest wait among the next job of each of these lists (BullMQ
//   hands a list's jobs out in that order, so its next job has waited longest) and the first due delayed job. A job
//   waits since it was added, since its delay ended when it was added with one (`opts.delay`), and since its last
//   attempt started when it is tried again (`processedOn`: its backoff ended later, so a retried job looks older than it
//   is by its run and its backoff at most, a few minutes with the defaults of ADR-0009). A delayed job is due at the end
//   of its delay (`delay`, counted from when it was added, or from when its last attempt started for a retry in its
//   backoff, which makes the retry due early by the length of that attempt at most). `null` when no job waits.
// - `failedLastHour`: the jobs whose last attempt failed within the hour before the Clock's time (BullMQ's failed set,
//   newest first by `finishedOn`). Failed jobs are kept 30 days (ADR-0009 item 7), so the count does not read them all:
//   it reads the 1st, 2nd, 4th, 8th, … newest failure until one is older than an hour, then halves the last interval
//   (`countRecent`): about 2·log2(n) reads of one job for n failures in the hour, one read when none failed.
//
// Bounds (lead addition of 2026-10-27: the queue part never slows /health/ready). The report reads on a Redis
// connection of its own (`ota-worker-health-queues`) that never queues a command while it is disconnected and gives a
// command up after QUEUE_REPORT_TIMEOUT_MS, through read-only `Queue` objects (prefix `vx`) that skip BullMQ's wait for
// `ready`, its version check and its meta hash, so opening a queue sends nothing. HealthService waits for the whole
// report at most QUEUE_REPORT_TIMEOUT_MS, in parallel with its probes: a Redis that refuses, fails or does not answer
// in time makes the queue part unknown, and the readiness body then has no `queues`. Readiness checks that come while a
// report is being read share it, so a Redis that hangs never piles reads up.
//
// Nothing here adds, moves or removes a job, and nothing of a job but its times reaches the answer or a log line.
import type { components } from "@velexis/api-types";
import { Queue, type JobType } from "bullmq";
import { Redis } from "ioredis";
import { BULLMQ_PREFIX, OTA_QUEUES, type OtaQueueName } from "../common/queues/queue-names";

/** One queue in the readiness answer (`HealthQueue` of the OTA document). */
export type HealthQueue = components["schemas"]["HealthQueue"];

/** The queue part of the worker's readiness: every OTA queue by name, in the order of `OTA_QUEUES`. */
export type QueueAges = Readonly<Record<OtaQueueName, HealthQueue>>;

/** Injection token of the worker's `QueueAgeSource`; the API's health module provides none. */
export const HEALTH_QUEUE_AGES = "HEALTH_QUEUE_AGES";

/** How long the queue part may take, and one Redis command of it, before it counts as unknown. */
export const QUEUE_REPORT_TIMEOUT_MS = 1000;

/** The window of `failedLastHour`. */
export const FAILED_WINDOW_MS = 60 * 60 * 1000;

/** The states of a job that waits for a worker, in BullMQ's names. */
const WAITING_STATES: readonly JobType[] = Object.freeze(["wait", "paused", "prioritized"]);

/** What the report reads of a job: its times and its delays, never its data. */
export interface QueuedJob {
  /** When it was added (epoch ms). */
  readonly timestamp: number;
  /**
   * Its current delay (BullMQ's `delay` field): the one it was added with, or the backoff of a retry, while it is
   * delayed; 0 once BullMQ moved it to the wait list.
   */
  readonly delay?: number | undefined;
  /** When its last attempt started, if one did. */
  readonly processedOn?: number | undefined;
  /** When it completed or failed for good. */
  readonly finishedOn?: number | undefined;
  readonly opts: { readonly delay?: number | undefined };
}

/** The read-only part of a BullMQ `Queue` the report uses (a fake in unit tests). */
export interface InspectedQueue {
  getJobCounts(...types: JobType[]): Promise<Readonly<Record<string, number>>>;
  getJobs(types: JobType[], start: number, end: number, asc: boolean): Promise<readonly QueuedJob[]>;
}

/** The queue part as HealthService uses it: one report at a time, and the release of its connection. */
export interface QueueAgeSource {
  /** Reads every OTA queue; rejects when Redis does. HealthService bounds the wait (QUEUE_REPORT_TIMEOUT_MS). */
  read(): Promise<QueueAges>;
  /** Closes the queues and the connection of the report. */
  close(): Promise<void>;
}

/** Since when a job has waited (epoch ms): see the file header. */
export function waitingSince(job: QueuedJob): number {
  const delay = job.opts.delay;
  const ready = job.timestamp + (typeof delay === "number" && delay > 0 ? delay : 0);
  return Math.max(ready, job.processedOn ?? 0);
}

/** When a delayed job is due (epoch ms): see the file header. */
export function dueAt(job: QueuedJob): number {
  const delay = typeof job.delay === "number" && job.delay > 0 ? job.delay : 0;
  return (job.processedOn ?? job.timestamp) + delay;
}

/**
 * How many of `total` entries are recent, when `recent(index)` holds for the first ones (the newest failures, the
 * delayed jobs that are due) and for none after the first that is not: indices 0, 1, 3, 7, … until one is not recent
 * (or `total` is reached), then a binary search in the last interval. `recent` is never asked about an index at or
 * above `total`, and is asked about index 0 first whenever `total` is above 0.
 */
export async function countRecent(
  total: number,
  recent: (index: number) => Promise<boolean>,
): Promise<number> {
  // Every index below `low` is recent; no index from `high` on is.
  let low = 0;
  let high = Math.max(0, Math.floor(total));
  for (let probe = 0; probe < high; probe = probe * 2 + 1) {
    if (await recent(probe)) {
      low = probe + 1;
    } else {
      high = probe;
    }
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (await recent(middle)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Whole seconds from `since` (epoch ms) to `now`, never negative. */
function secondsSince(since: number, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since) / 1000));
}

/** The `HealthQueue` of one queue at `now`. Rejects when Redis does. */
export async function inspectQueue(queue: InspectedQueue, now: Date): Promise<HealthQueue> {
  const [counts, next] = await Promise.all([
    queue.getJobCounts(...WAITING_STATES, "delayed", "failed"),
    // The next job of each waiting list (ascending: the one a worker takes first).
    queue.getJobs([...WAITING_STATES], 0, 0, true),
  ]);
  const count = (state: string): number => counts[state] ?? 0;
  const cutoff = now.getTime() - FAILED_WINDOW_MS;
  const [failedLastHour, due] = await Promise.all([
    countRecent(count("failed"), async (index) => {
      const [job] = await queue.getJobs(["failed"], index, index, false);
      return typeof job?.finishedOn === "number" && job.finishedOn >= cutoff;
    }),
    dueDelayedJobs(queue, count("delayed"), now),
  ]);
  const since = [...next.map(waitingSince), ...(due.firstDueAt === undefined ? [] : [due.firstDueAt])];
  const oldest = since.length === 0 ? undefined : Math.min(...since);
  return {
    waiting: WAITING_STATES.reduce((sum, state) => sum + count(state), due.count),
    oldestWaitingSeconds: oldest === undefined ? null : secondsSince(oldest, now),
    failedLastHour,
  };
}

/**
 * How many of the queue's `total` delayed jobs are due at `now`, and when the first of them became due (`undefined`
 * when none is). The delayed set is in due order, so its first jobs are due and then none is (the file header);
 * `countRecent` asks about the first job first.
 */
async function dueDelayedJobs(
  queue: InspectedQueue,
  total: number,
  now: Date,
): Promise<{ readonly count: number; readonly firstDueAt: number | undefined }> {
  const dueTimes = new Map<number, number>();
  const count = await countRecent(total, async (index) => {
    const [job] = await queue.getJobs(["delayed"], index, index, true);
    if (job === undefined) {
      return false;
    }
    const due = dueAt(job);
    dueTimes.set(index, due);
    return due <= now.getTime();
  });
  return { count, firstDueAt: count > 0 ? dueTimes.get(0) : undefined };
}

/** What a report needs besides its queues. */
export interface QueueAgeReportOptions {
  /** The time of `oldestWaitingSeconds` and `failedLastHour`: the process's `Clock`, a `FakeClock` in tests. */
  readonly clock: { now(): Date };
  /** Runs before every read: connects the report's connection on the first one. */
  readonly prepare?: (() => Promise<void>) | undefined;
  /** Runs once on `close()`: releases the queues and the connection. */
  readonly release?: (() => Promise<void>) | undefined;
}

/** The queue part of the worker's readiness over `queues` (see the file header). */
export class QueueAgeReport implements QueueAgeSource {
  /** The report being read: readiness checks that come meanwhile wait for it instead of reading again. */
  private reading: Promise<QueueAges> | undefined;
  private closed = false;

  constructor(
    private readonly queues: Readonly<Record<OtaQueueName, InspectedQueue>>,
    private readonly options: QueueAgeReportOptions,
  ) {}

  read(): Promise<QueueAges> {
    this.reading ??= this.readAll().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.options.release?.();
    }
  }

  private async readAll(): Promise<QueueAges> {
    if (this.closed) {
      throw new Error("the queue report is closed");
    }
    await this.options.prepare?.();
    const now = this.options.clock.now();
    const entries = await Promise.all(
      OTA_QUEUES.map(async (name) => [name, await inspectQueue(this.queues[name], now)] as const),
    );
    return Object.freeze(Object.fromEntries(entries) as Record<OtaQueueName, HealthQueue>);
  }
}

/** How a report on its own connection is named and timed. */
export interface QueueAgeConnectionOptions {
  /** `CLIENT SETNAME` of the report's connection: `ota-worker-health-queues`. */
  readonly connectionName: string;
  readonly clock: { now(): Date };
}

/**
 * A report on a Redis connection of its own on `url`: it connects on the first read, never queues a command while it
 * is disconnected (a read then fails at once), gives a command up after QUEUE_REPORT_TIMEOUT_MS and keeps reconnecting
 * in the background while Redis is down. Its errors are not logged here: a failed read is HealthService's
 * `health.queues_unknown`, and the Redis probe logs the outage. The URL is never logged.
 */
export function createQueueAgeReport(url: string, options: QueueAgeConnectionOptions): QueueAgeReport {
  const client = new Redis(url, {
    connectionName: options.connectionName,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: QUEUE_REPORT_TIMEOUT_MS,
    commandTimeout: QUEUE_REPORT_TIMEOUT_MS,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  // Without a listener ioredis prints every connection error; a failed read reports it instead.
  client.on("error", () => undefined);
  const queues = Object.fromEntries(
    OTA_QUEUES.map((name) => {
      const queue = new Queue(name, {
        connection: client,
        prefix: BULLMQ_PREFIX,
        // Nothing is sent before the first read: no wait for `ready`, no version check (QueuesModule's queues do it),
        // and no meta hash (the queue's owner writes it, never a reader).
        skipWaitingForReady: true,
        skipVersionCheck: true,
        skipMetasUpdate: true,
      });
      // BullMQ forwards the connection's errors to every queue; an `error` event without a listener would throw.
      queue.on("error", () => undefined);
      return [name, queue] as const;
    }),
  ) as Record<OtaQueueName, Queue>;
  // Concurrent first reads share one connection attempt instead of failing on "already connecting".
  let connecting: Promise<void> | undefined;
  return new QueueAgeReport(queues, {
    clock: options.clock,
    async prepare() {
      if (client.status === "wait") {
        connecting ??= client.connect().finally(() => {
          connecting = undefined;
        });
      }
      if (connecting !== undefined) {
        await connecting;
      }
    },
    async release() {
      // The connection is shared: closing a queue only removes its listeners.
      await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
      client.disconnect();
    },
  });
}
