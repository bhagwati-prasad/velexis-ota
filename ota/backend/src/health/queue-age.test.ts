import { createServer, type AddressInfo, type Socket } from "node:net";
import { FakeClock, responseChecker, type ResponseChecker } from "@velexis/testing";
import type { JobType } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freePort } from "../../test/helpers/ports";
import { OTA_QUEUES, type OtaQueueName } from "../common/queues/queue-names";
import { HealthService, READINESS_TIMEOUT_MS, type DependencyProbe } from "./health.service";
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

/** One fake queue per OTA queue. */
function fakeQueues(): Record<OtaQueueName, FakeQueue> {
  return Object.fromEntries(OTA_QUEUES.map((name) => [name, new FakeQueue()])) as Record<
    OtaQueueName,
    FakeQueue
  >;
}

const EMPTY = { waiting: 0, oldestWaitingSeconds: null, failedLastHour: 0 } as const;

const up = (): Promise<void> => Promise.resolve();
const probes = (): DependencyProbe[] => [
  { name: "postgres", check: up, close: up },
  { name: "redis", check: up, close: up },
];

function serviceWith(source: QueueAgeSource | undefined): {
  service: HealthService;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  // Only `warn` is used by the service; the rest of PinoLogger is not needed here.
  const logger = { warn } as unknown as PinoLogger;
  return { service: new HealthService(probes(), logger, source), warn };
}

/** A queue source whose reads never settle. */
function hangingSource(): QueueAgeSource & { readonly reads: () => number } {
  let reads = 0;
  return {
    read: () => {
      reads += 1;
      return new Promise(() => undefined);
    },
    close: up,
    reads: () => reads,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the worker's readiness with its queues", () => {
  it("[OBE-025 AC1] reports oldestWaitingSeconds ≥ 120 for a queue whose job has waited 2 minutes, and stays 200", async () => {
    const clock = new FakeClock();
    const queues = fakeQueues();
    queues["ota-payments"].lists.wait.push(jobAt(clock.now(), 2 * MINUTE));
    const { service } = serviceWith(new QueueAgeReport(queues, { clock }));

    const readiness = await service.ready();

    expect(readiness.ready).toBe(true);
    expect(readiness.body.status).toBe("ok");
    expect(readiness.body.queues?.["ota-payments"]).toEqual({
      waiting: 1,
      oldestWaitingSeconds: 120,
      failedLastHour: 0,
    });
    expect(readiness.body.queues?.["ota-payments"]?.oldestWaitingSeconds).toBeGreaterThanOrEqual(120);
    // Every OTA queue, in the order of OTA_QUEUES; the others are empty.
    expect(Object.keys(readiness.body.queues ?? {})).toEqual([...OTA_QUEUES]);
    for (const name of OTA_QUEUES.filter((queue) => queue !== "ota-payments")) {
      expect([name, readiness.body.queues?.[name]]).toEqual([name, EMPTY]);
    }
  });

  it("stays ready however old a waiting job is: the on-VM check decides the alert threshold", async () => {
    const clock = new FakeClock();
    const queues = fakeQueues();
    queues["ota-ticketing"].lists.wait.push(jobAt(clock.now(), 6 * 60 * MINUTE));
    for (let index = 0; index < 50; index += 1) {
      queues["ota-ticketing"].lists.failed.push(failedAt(clock.now(), index * 1000));
    }
    const { service } = serviceWith(new QueueAgeReport(queues, { clock }));

    const readiness = await service.ready();

    expect(readiness).toMatchObject({ ready: true, body: { status: "ok" } });
    expect(readiness.body.queues?.["ota-ticketing"]).toEqual({
      waiting: 1,
      oldestWaitingSeconds: 6 * 60 * 60,
      failedLastHour: 50,
    });
  });

  it("reports the scheduler runs no worker took: due jobs in the delayed set count as waiting, from when they became due", async () => {
    // ota-maintenance's jobs are the schedulers' runs, added to the delayed set until their time; BullMQ moves a due
    // one to the wait list only when a worker asks for its next job, which a busy or stuck worker does not do.
    const clock = new FakeClock();
    const queues = fakeQueues();
    queues["ota-maintenance"].lists.delayed.push(
      delayedJob(clock.now(), 13 * MINUTE, MINUTE),
      delayedJob(clock.now(), 2 * MINUTE, MINUTE),
      delayedJob(clock.now(), 0, MINUTE),
    );
    const { service } = serviceWith(new QueueAgeReport(queues, { clock }));

    const readiness = await service.ready();

    expect(readiness).toMatchObject({ ready: true, body: { status: "ok" } });
    expect(readiness.body.queues?.["ota-maintenance"]).toEqual({
      waiting: 2,
      oldestWaitingSeconds: 12 * 60,
      failedLastHour: 0,
    });
  });

  it("has no queues in the API's readiness, which has no queue source", async () => {
    const { service } = serviceWith(undefined);

    await expect(service.ready()).resolves.toEqual({
      ready: true,
      body: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
    });
  });

  it("leaves the queues out (unknown) when they do not answer within QUEUE_REPORT_TIMEOUT_MS, without delaying the answer", async () => {
    vi.useFakeTimers();
    const source = hangingSource();
    const { service, warn } = serviceWith(source);

    const readiness = service.ready();
    await vi.advanceTimersByTimeAsync(QUEUE_REPORT_TIMEOUT_MS);

    await expect(readiness).resolves.toEqual({
      ready: true,
      body: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
    });
    expect(QUEUE_REPORT_TIMEOUT_MS).toBeLessThan(READINESS_TIMEOUT_MS);
    expect(warn).toHaveBeenCalledWith({ part: "queues", status: "timeout" }, "health.queues_unknown");
  });

  it("leaves the queues out (unknown) when Redis refuses them, and logs the error without values", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const { service, warn } = serviceWith({ read: () => Promise.reject(refused), close: up });

    await expect(service.ready()).resolves.toEqual({
      ready: true,
      body: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
    });
    expect(warn).toHaveBeenCalledWith(
      { part: "queues", status: "down", err: refused },
      "health.queues_unknown",
    );
  });

  it("closes the queue source at shutdown, with the probes", async () => {
    const close = vi.fn(up);
    const { service } = serviceWith({ read: () => Promise.reject(new Error("unused")), close });

    await service.onApplicationShutdown();

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("the readiness body against the OTA document", () => {
  let checker: ResponseChecker;

  // Parsing the OTA document and compiling its response schemas is a one-time cost of a few seconds on a loaded
  // runner: paid here, with its own budget, so the test below keeps the default bound.
  beforeAll(() => {
    checker = responseChecker("ota");
  }, 60_000);

  it("matches healthReady (HealthReadiness with HealthQueue) with every queue reported", async () => {
    const clock = new FakeClock();
    const queues = fakeQueues();
    queues["ota-bookings"].lists.prioritized.push(jobAt(clock.now(), 90_000));
    queues["ota-bookings"].lists.failed.push(failedAt(clock.now(), MINUTE));
    const { service } = serviceWith(new QueueAgeReport(queues, { clock }));

    const readiness = await service.ready();

    expect(readiness.body.queues?.["ota-bookings"]).toEqual({
      waiting: 1,
      oldestWaitingSeconds: 90,
      failedLastHour: 1,
    });
    expect(checker.check("healthReady", { status: 200, body: readiness.body })).toEqual([]);
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

describe("waitingSince", () => {
  const added = Date.parse("2026-01-15T10:00:00.000Z");

  it("is the time the job was added", () => {
    expect(waitingSince({ timestamp: added, opts: {} })).toBe(added);
  });

  it("is the end of its delay for a job added with one, once the delay is over", () => {
    expect(waitingSince({ timestamp: added, opts: { delay: 5 * MINUTE } })).toBe(added + 5 * MINUTE);
    expect(waitingSince({ timestamp: added, opts: { delay: 0 } })).toBe(added);
  });

  it("is the start of its last attempt for a job tried again", () => {
    expect(waitingSince({ timestamp: added, processedOn: added + 7 * MINUTE, opts: {} })).toBe(
      added + 7 * MINUTE,
    );
    expect(waitingSince({ timestamp: added, processedOn: added + MINUTE, opts: { delay: 5 * MINUTE } })).toBe(
      added + 5 * MINUTE,
    );
  });
});

describe("dueAt", () => {
  const added = Date.parse("2026-01-15T10:00:00.000Z");

  it("is the end of the delay a job was added with", () => {
    expect(dueAt({ timestamp: added, delay: 5 * MINUTE, opts: { delay: 5 * MINUTE } })).toBe(
      added + 5 * MINUTE,
    );
    expect(dueAt({ timestamp: added, delay: 0, opts: {} })).toBe(added);
  });

  it("is the end of the backoff after the last attempt started, for a retry", () => {
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
      expect.objectContaining({ "ota-payments": EMPTY }),
      expect.objectContaining({ "ota-payments": EMPTY }),
    ]);
    expect(prepared).toBe(1);
    expect(queues["ota-payments"].counts).toBe(1);

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
    const port = await freePort();
    const report = createQueueAgeReport(`redis://:dummy-redis-password@127.0.0.1:${port}/0`, {
      connectionName: "ota-test-health-queues",
      clock: new FakeClock(),
    });
    const warn = vi.fn();
    const service = new HealthService(probes(), { warn } as unknown as PinoLogger, report);

    try {
      await expect(report.read()).rejects.toThrow();
      // A second read while the connection is down fails as well: no command waits for a reconnection.
      await expect(report.read()).rejects.toThrow();
      await expect(service.ready()).resolves.toEqual({
        ready: true,
        body: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ part: "queues", status: "down" }),
        "health.queues_unknown",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("dummy-redis-password");
    } finally {
      await service.onApplicationShutdown();
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
      connectionName: "ota-test-health-queues",
      clock: new FakeClock(),
    });
    const warn = vi.fn();
    const service = new HealthService(probes(), { warn } as unknown as PinoLogger, report);

    try {
      await expect(service.ready()).resolves.toEqual({
        ready: true,
        body: { status: "ok", checks: { postgres: "ok", redis: "ok" } },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ part: "queues", status: expect.stringMatching(/^(timeout|down)$/) }),
        "health.queues_unknown",
      );
    } finally {
      await service.onApplicationShutdown();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolveClose) => silent.close(() => resolveClose()));
    }
  });
});
