// The platform worker's queue report (FIX-W46-PLATFORM, lead decision (11d)) against fake BullMQ queues: the rules of
// the OTA worker's report (ota/backend/src/health/queue-age.test.ts, OBE-025) on the platform's queues, the readiness
// body with and without them, and the bounds. test/integration/health/health.int.test.ts reads real queues.
import { createServer, type AddressInfo, type Socket } from "node:net";
import { FakeClock, responseChecker, type ResponseChecker } from "@velexis/testing";
import type { JobType } from "bullmq";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PLATFORM_QUEUES, type PlatformQueueName } from "../common/queues/queue-names";
import {
  HEALTH_CHECK_TIMEOUT_MS,
  HealthService,
  type PostgresProbeTarget,
  type RedisProbeTarget,
} from "./health.service";
import {
  countRecent,
  createQueueAgeReport,
  dueAt,
  FAILED_WINDOW_MS,
  inspectQueue,
  QUEUE_REPORT_TIMEOUT_MS,
  QueueAgeReport,
  waitingSince,
  type InspectedQueue,
  type QueueAgeSource,
  type QueuedJob,
} from "./queue-age";

const MINUTE = 60_000;

/**
 * A BullMQ queue in memory: each waiting list holds its jobs in the order a worker takes them, `delayed` in due order,
 * `failed` newest first. It answers `getJobCounts` and `getJobs` as BullMQ does for those orders, and counts the
 * reads.
 */
class FakeQueue implements InspectedQueue {
  readonly lists: Record<"wait" | "paused" | "prioritized" | "delayed" | "failed", QueuedJob[]> = {
    wait: [],
    paused: [],
    prioritized: [],
    delayed: [],
    failed: [],
  };
  counts = 0;
  failedReads = 0;
  delayedReads = 0;

  private list(type: JobType): QueuedJob[] {
    if (
      type === "wait" ||
      type === "paused" ||
      type === "prioritized" ||
      type === "delayed" ||
      type === "failed"
    ) {
      return this.lists[type];
    }
    throw new Error(`the fake queue does not hold ${type} jobs`);
  }

  getJobCounts(...types: JobType[]): Promise<Readonly<Record<string, number>>> {
    this.counts += 1;
    return Promise.resolve(Object.fromEntries(types.map((type) => [type, this.list(type).length])));
  }

  getJobs(types: JobType[], start: number, end: number, asc: boolean): Promise<readonly QueuedJob[]> {
    const ascending = types.every((type) => type !== "failed");
    // The report reads the waiting lists in the order a worker takes them, the delayed set in due order (one job at a
    // time, never with another state) and the failed set newest first.
    expect(asc).toBe(ascending);
    if (types.includes("delayed")) {
      expect(types).toEqual(["delayed"]);
      this.delayedReads += 1;
    }
    if (!ascending) {
      this.failedReads += 1;
    }
    return Promise.resolve(types.flatMap((type) => this.list(type).slice(start, end + 1)));
  }
}

/** A job added `ageMs` before `now`, with optional delay and attempt times. */
function jobAt(now: Date, ageMs: number, extra: Partial<QueuedJob> = {}): QueuedJob {
  return { timestamp: now.getTime() - ageMs, opts: {}, ...extra };
}

/** A job added `ageMs` before `now` with a delay of `delayMs`, still in the delayed set. */
function delayedJob(now: Date, ageMs: number, delayMs: number): QueuedJob {
  return { timestamp: now.getTime() - ageMs, delay: delayMs, opts: { delay: delayMs } };
}

/** A failed job that failed `ageMs` before `now`. */
function failedAt(now: Date, ageMs: number): QueuedJob {
  return { timestamp: now.getTime() - ageMs - MINUTE, finishedOn: now.getTime() - ageMs, opts: {} };
}

/** One fake queue per platform queue. */
function fakeQueues(): Record<PlatformQueueName, FakeQueue> {
  return Object.fromEntries(PLATFORM_QUEUES.map((name) => [name, new FakeQueue()])) as Record<
    PlatformQueueName,
    FakeQueue
  >;
}

const EMPTY = { waiting: 0, oldestWaitingSeconds: null, failedLastHour: 0 } as const;

const up = (): Promise<void> => Promise.resolve();
const postgres = (): PostgresProbeTarget => ({ query: () => Promise.resolve({ rows: [{}] }) });
const redis = (): RedisProbeTarget => ({ ping: () => Promise.resolve("PONG") });

/** The health service of a worker whose PostgreSQL and Redis answer, with `source` as its queue report. */
function serviceWith(source: QueueAgeSource | undefined): HealthService {
  return new HealthService(postgres(), redis(), source);
}

/** A queue source whose reads never settle. */
function hangingSource(): QueueAgeSource {
  return { read: () => new Promise(() => undefined), close: up };
}

const READY = { status: "ok", checks: { postgres: "ok", redis: "ok" } } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("the platform worker's readiness with its queues", () => {
  it("[FIX-W46-PLATFORM AC4] reports every platform queue in the OTA worker's shape, a job waiting 2 minutes as 120 s, and stays ready", async () => {
    const clock = new FakeClock();
    const queues = fakeQueues();
    queues["platform-emails"].lists.wait.push(jobAt(clock.now(), 2 * MINUTE));
    queues["platform-emails"].lists.failed.push(failedAt(clock.now(), MINUTE));

    const readiness = await serviceWith(new QueueAgeReport(queues, { clock })).ready();

    expect(readiness.report.status).toBe("ok");
    expect(readiness.failures).toEqual([]);
    expect(readiness.queuesUnknown).toBeUndefined();
    expect(readiness.report.queues?.["platform-emails"]).toEqual({
      waiting: 1,
      oldestWaitingSeconds: 120,
      failedLastHour: 1,
    });
    // Every queue the platform worker consumes, in the order of PLATFORM_QUEUES; the others are empty.
    expect(Object.keys(readiness.report.queues ?? {})).toEqual([...PLATFORM_QUEUES]);
    for (const name of PLATFORM_QUEUES.filter((queue) => queue !== "platform-emails")) {
      expect([name, readiness.report.queues?.[name]]).toEqual([name, EMPTY]);
    }
  });

  it("[FIX-W46-PLATFORM AC4] stays ready however old a waiting job is and however many failed: the on-VM check decides", async () => {
    const clock = new FakeClock();
    const queues = fakeQueues();
    queues["platform-tenant-events"].lists.wait.push(jobAt(clock.now(), 6 * 60 * MINUTE));
    for (let index = 0; index < 50; index += 1) {
      queues["platform-tenant-events"].lists.failed.push(failedAt(clock.now(), index * 1000));
    }

    const readiness = await serviceWith(new QueueAgeReport(queues, { clock })).ready();

    expect(readiness.report.status).toBe("ok");
    expect(readiness.report.queues?.["platform-tenant-events"]).toEqual({
      waiting: 1,
      oldestWaitingSeconds: 6 * 60 * 60,
      failedLastHour: 50,
    });
  });

  it("reports the scheduler runs no worker took: due jobs in the delayed set count as waiting, from when they became due", async () => {
    // platform-maintenance's jobs are the schedulers' runs, added to the delayed set until their time; BullMQ moves a
    // due one to the wait list only when a worker asks for its next job, which a busy or stuck worker does not do.
    const clock = new FakeClock();
    const queues = fakeQueues();
    queues["platform-maintenance"].lists.delayed.push(
      delayedJob(clock.now(), 13 * MINUTE, MINUTE),
      delayedJob(clock.now(), 2 * MINUTE, MINUTE),
      delayedJob(clock.now(), 0, MINUTE),
    );

    const readiness = await serviceWith(new QueueAgeReport(queues, { clock })).ready();

    expect(readiness.report.queues?.["platform-maintenance"]).toEqual({
      waiting: 2,
      oldestWaitingSeconds: 12 * 60,
      failedLastHour: 0,
    });
  });

  it("keeps a dependency that is down apart from the queues: 503 with the queues it could read", async () => {
    const clock = new FakeClock();
    const cause = new Error("pool ended");
    const service = new HealthService(
      { query: () => Promise.reject(cause) },
      redis(),
      new QueueAgeReport(fakeQueues(), { clock }),
    );

    const readiness = await service.ready();

    expect(readiness.report).toMatchObject({
      status: "unavailable",
      checks: { postgres: "down", redis: "ok" },
    });
    expect(Object.keys(readiness.report.queues ?? {})).toEqual([...PLATFORM_QUEUES]);
    expect(readiness.failures).toEqual([{ dependency: "postgres", error: cause }]);
  });

  it("has no queues in the API's readiness, which has no queue source", async () => {
    await expect(serviceWith(undefined).ready()).resolves.toEqual({ report: READY, failures: [] });
  });

  it("[FIX-W46-PLATFORM AC4] leaves the queues out (unknown) when they do not answer within QUEUE_REPORT_TIMEOUT_MS, without delaying the answer", async () => {
    vi.useFakeTimers();

    const readiness = serviceWith(hangingSource()).ready();
    await vi.advanceTimersByTimeAsync(QUEUE_REPORT_TIMEOUT_MS);

    await expect(readiness).resolves.toEqual({
      report: READY,
      failures: [],
      queuesUnknown: { status: "timeout" },
    });
    expect(QUEUE_REPORT_TIMEOUT_MS).toBeLessThan(HEALTH_CHECK_TIMEOUT_MS);
  });

  it("[FIX-W46-PLATFORM AC4] leaves the queues out (unknown) when Redis refuses them, with the error for the log only", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

    const readiness = await serviceWith({ read: () => Promise.reject(refused), close: up }).ready();

    expect(readiness).toEqual({
      report: READY,
      failures: [],
      queuesUnknown: { status: "down", error: refused },
    });
    expect(JSON.stringify(readiness.report)).not.toContain("ECONNREFUSED");
  });
});

describe("the readiness body against the platform document", () => {
  let checker: ResponseChecker;

  // Parsing the platform document and compiling its response schemas is a one-time cost of a few seconds on a loaded
  // runner: paid here, with its own budget, so the test below keeps the default bound.
  beforeAll(() => {
    checker = responseChecker("platform");
  }, 60_000);

  it("[FIX-W46-PLATFORM AC4] matches healthReady (HealthReady with HealthQueue) with every queue reported", async () => {
    const clock = new FakeClock();
    const queues = fakeQueues();
    queues["platform-domains"].lists.prioritized.push(jobAt(clock.now(), 90_000));
    queues["platform-domains"].lists.failed.push(failedAt(clock.now(), MINUTE));

    const readiness = await serviceWith(new QueueAgeReport(queues, { clock })).ready();

    expect(readiness.report.queues?.["platform-domains"]).toEqual({
      waiting: 1,
      oldestWaitingSeconds: 90,
      failedLastHour: 1,
    });
    expect(checker.check("healthReady", { status: 200, body: readiness.report })).toEqual([]);
    // The API's answer, without queues, still matches.
    expect(checker.check("healthReady", { status: 200, body: READY })).toEqual([]);
  });
});

describe("inspectQueue", () => {
  it("counts the wait list, a paused queue's list and the prioritized jobs, and takes the longest wait of their next jobs", async () => {
    const now = new FakeClock().now();
    const queue = new FakeQueue();
    queue.lists.wait.push(jobAt(now, 30_000), jobAt(now, 10_000));
    queue.lists.paused.push(jobAt(now, 45_000));
    queue.lists.prioritized.push(jobAt(now, 200_000), jobAt(now, 5_000));

    await expect(inspectQueue(queue, now)).resolves.toEqual({
      waiting: 5,
      oldestWaitingSeconds: 200,
      failedLastHour: 0,
    });
  });

  it("counts the delayed jobs that are due, a retry from the end of its backoff, and never one that is not due yet", async () => {
    const now = new FakeClock().now();
    const queue = new FakeQueue();
    queue.lists.wait.push(jobAt(now, MINUTE));
    // In due order: added 5 minutes ago with a 1-minute delay (due 4 minutes ago); a retry whose last attempt started
    // 3 minutes ago, with a 1-minute backoff (due 2 minutes ago); due right now; due in 10 minutes.
    queue.lists.delayed.push(
      delayedJob(now, 5 * MINUTE, MINUTE),
      {
        timestamp: now.getTime() - 60 * MINUTE,
        processedOn: now.getTime() - 3 * MINUTE,
        delay: MINUTE,
        opts: {},
      },
      delayedJob(now, MINUTE, MINUTE),
      delayedJob(now, 0, 10 * MINUTE),
    );

    await expect(inspectQueue(queue, now)).resolves.toEqual({
      waiting: 4,
      oldestWaitingSeconds: 4 * 60,
      failedLastHour: 0,
    });
  });

  it("reads one delayed job when none is due, and none when nothing is delayed", async () => {
    const now = new FakeClock().now();
    const queue = new FakeQueue();

    await expect(inspectQueue(queue, now)).resolves.toEqual(EMPTY);
    expect(queue.delayedReads).toBe(0);

    for (let index = 0; index < 1000; index += 1) {
      queue.lists.delayed.push(delayedJob(now, 0, (index + 1) * MINUTE));
    }
    await expect(inspectQueue(queue, now)).resolves.toEqual(EMPTY);
    expect(queue.delayedReads).toBe(1);
  });

  it("answers null when no job waits, and never a negative age for a job stamped after the clock", async () => {
    const now = new FakeClock().now();
    const queue = new FakeQueue();

    await expect(inspectQueue(queue, now)).resolves.toEqual(EMPTY);

    queue.lists.wait.push(jobAt(now, -5_000));
    await expect(inspectQueue(queue, now)).resolves.toMatchObject({ waiting: 1, oldestWaitingSeconds: 0 });
  });

  it("counts the failures of the hour before the clock: one at the edge counts, one a millisecond older does not", async () => {
    const now = new FakeClock().now();
    const queue = new FakeQueue();
    queue.lists.failed.push(
      failedAt(now, 0),
      failedAt(now, 30 * MINUTE),
      failedAt(now, FAILED_WINDOW_MS),
      failedAt(now, FAILED_WINDOW_MS + 1),
      failedAt(now, 3 * FAILED_WINDOW_MS),
    );

    await expect(inspectQueue(queue, now)).resolves.toEqual({
      waiting: 0,
      oldestWaitingSeconds: null,
      failedLastHour: 3,
    });
  });

  it("reads one failed job when the newest failure is older than an hour, and none when nothing failed", async () => {
    const now = new FakeClock().now();
    const queue = new FakeQueue();

    await inspectQueue(queue, now);
    expect(queue.failedReads).toBe(0);

    for (let index = 0; index < 1000; index += 1) {
      queue.lists.failed.push(failedAt(now, 2 * FAILED_WINDOW_MS + index * MINUTE));
    }
    await expect(inspectQueue(queue, now)).resolves.toMatchObject({ failedLastHour: 0 });
    expect(queue.failedReads).toBe(1);
  });
});

describe("waitingSince and dueAt", () => {
  const added = new FakeClock().now().getTime();

  it("waits since the job was added, the end of its delay, or the start of its last attempt", () => {
    expect(waitingSince({ timestamp: added, opts: {} })).toBe(added);
    expect(waitingSince({ timestamp: added, opts: { delay: 5 * MINUTE } })).toBe(added + 5 * MINUTE);
    expect(waitingSince({ timestamp: added, opts: { delay: 0 } })).toBe(added);
    expect(waitingSince({ timestamp: added, processedOn: added + 7 * MINUTE, opts: {} })).toBe(
      added + 7 * MINUTE,
    );
    expect(waitingSince({ timestamp: added, processedOn: added + MINUTE, opts: { delay: 5 * MINUTE } })).toBe(
      added + 5 * MINUTE,
    );
  });

  it("is due at the end of its delay, or of its backoff after the last attempt started", () => {
    expect(dueAt({ timestamp: added, delay: 5 * MINUTE, opts: { delay: 5 * MINUTE } })).toBe(
      added + 5 * MINUTE,
    );
    expect(dueAt({ timestamp: added, delay: 0, opts: {} })).toBe(added);
    expect(
      dueAt({ timestamp: added, processedOn: added + 7 * MINUTE, delay: 30_000, opts: { delay: MINUTE } }),
    ).toBe(added + 7 * MINUTE + 30_000);
  });
});

describe("countRecent", () => {
  it("finds the number of recent entries for every total up to 64 and every split, asking only about indices below the total", async () => {
    for (let total = 0; total <= 64; total += 1) {
      for (let recentCount = 0; recentCount <= total; recentCount += 1) {
        const asked: number[] = [];
        const count = await countRecent(total, (index) => {
          asked.push(index);
          return Promise.resolve(index < recentCount);
        });

        expect([total, recentCount, count]).toEqual([total, recentCount, recentCount]);
        expect(asked.every((index) => index >= 0 && index < total)).toBe(true);
        // About 2·log2(k) questions for k recent entries: never a read of every failure.
        expect(asked.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(recentCount + 2)) + 1);
      }
    }
  });

  it("asks a handful of questions for a large failed set", async () => {
    let asked = 0;
    const count = await countRecent(1_000_000, (index) => {
      asked += 1;
      return Promise.resolve(index < 25);
    });

    expect(count).toBe(25);
    expect(asked).toBeLessThanOrEqual(12);
  });
});

describe("QueueAgeReport", () => {
  it("lets readiness checks that come during a read share it", async () => {
    const clock = new FakeClock();
    const queues = fakeQueues();
    let prepared = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    const report = new QueueAgeReport(queues, {
      clock,
      prepare: async () => {
        prepared += 1;
        await gate;
      },
    });

    const first = report.read();
    const second = report.read();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ "platform-emails": EMPTY }),
      expect.objectContaining({ "platform-emails": EMPTY }),
    ]);
    expect(prepared).toBe(1);
    expect(queues["platform-emails"].counts).toBe(1);

    // A read after the first one ended reads again.
    await report.read();
    expect(prepared).toBe(2);
  });

  it("releases its connection once, and refuses to read afterwards", async () => {
    const release = vi.fn(up);
    const report = new QueueAgeReport(fakeQueues(), { clock: new FakeClock(), release });

    await report.close();
    await report.close();

    expect(release).toHaveBeenCalledTimes(1);
    await expect(report.read()).rejects.toThrow("closed");
  });

  it("on its own connection to a port where nothing listens, fails a read at once and closes cleanly", async () => {
    // A loopback port bound once by the OS, then released: nothing listens there.
    const free = createServer();
    await new Promise<void>((resolveListen) => free.listen(0, "127.0.0.1", () => resolveListen()));
    const { port } = free.address() as AddressInfo;
    await new Promise<void>((resolveClose) => free.close(() => resolveClose()));
    const report = createQueueAgeReport(`redis://:dummy-redis-password@127.0.0.1:${port}/0`, {
      connectionName: "platform-test-health-queues",
      clock: new FakeClock(),
    });
    const service = serviceWith(report);

    try {
      await expect(report.read()).rejects.toThrow();
      // A second read while the connection is down fails as well: no command waits for a reconnection.
      await expect(report.read()).rejects.toThrow();
      const readiness = await service.ready();
      expect(readiness).toMatchObject({ report: READY, queuesUnknown: { status: "down" } });
      expect(readiness.report.queues).toBeUndefined();
      expect(JSON.stringify(readiness.report)).not.toContain("dummy-redis-password");
    } finally {
      await report.close();
    }
  });

  it("on its own connection to a server that never answers, leaves the queues out after QUEUE_REPORT_TIMEOUT_MS instead of hanging", async () => {
    // A TCP server that accepts connections and never says a word: a Redis that hangs.
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolveListen) => silent.listen(0, "127.0.0.1", () => resolveListen()));
    const { port } = silent.address() as AddressInfo;
    const report = createQueueAgeReport(`redis://:dummy-redis-password@127.0.0.1:${port}/0`, {
      connectionName: "platform-test-health-queues",
      clock: new FakeClock(),
    });

    try {
      const readiness = await serviceWith(report).ready();
      expect(readiness.report).toEqual(READY);
      expect(readiness.queuesUnknown?.status).toMatch(/^(timeout|down)$/);
    } finally {
      await report.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolveClose) => silent.close(() => resolveClose()));
    }
  });
});
