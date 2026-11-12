// The scheduler framework without Redis or PostgreSQL (OBE-024; OADR-0014 points 1, 2, 4 and 5): the schedules and
// their registration, the deterministic per-tenant job ids, the fan-out of overlapping runs into a queue double that
// ignores a job id it holds already (as BullMQ does), the per-tenant runner (status re-check, tenant context,
// continuations, refused payloads) and the discovery of the `@TenantJob` handlers. The same paths run against the real
// BullMQ, Redis and PostgreSQL in test/integration/jobs/offers-purge.int.test.ts. Since OBE-101 every job of
// `ota-maintenance` is kept an hour once completed (ADR-0009 item 7, revision of 2026-11-11), which a second double
// that removes completed jobs as BullMQ does shows to keep the deduplication of a retried iteration.
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { Injectable } from "@nestjs/common";
import type { DiscoveryService } from "@nestjs/core";
import { Reflector } from "@nestjs/core";
import { FakeClock } from "@velexis/testing";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import { ClsService } from "nestjs-cls";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import { OffersPurgeProcessor } from "../shopping/offers-purge.processor";
import type { PlatformCache } from "../tenancy/platform-cache";
import { PlatformReadRepository, type PlatformDb } from "../tenancy/platform-read.repository";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import { TenantContext } from "../tenancy/tenant-context";
import {
  FanOutService,
  MaintenanceProcessor,
  minuteBucket,
  parseTenantJobData,
  scheduledAt,
  TenantJob,
  tenantJob,
  tenantJobHandlers,
  tenantJobId,
  TenantJobRunner,
  type TenantJobHandler,
  type TenantJobOutcome,
} from "./fan-out";
import { KEEP_COMPLETED_MAINTENANCE_JOBS, RETRY_BACKOFF_TOTAL_SECONDS } from "../common/queues/queue-names";
import { FAN_OUT_CHUNK, JOB_BATCH_LIMITS, MAX_CONTINUATIONS } from "./limits";
import {
  FAN_OUT_JOB,
  firstAttempt,
  OTA_SCHEDULES,
  registerSchedules,
  scheduleById,
  SCHEDULE_TIME_ZONE,
  type SchedulerQueue,
} from "./schedulers";

const PURGE = "offers.purge";
/** The outbox sweep of OBE-030. */
const SWEEP = "notifications.sweep";
/** The authorisation watch of OBE-040. */
const WATCH = "payments.authorisation_watch";
/** The ticketing scan of OBE-044. */
const TICKETING = "ticketing.scan";
/** The reconciliation scan of OBE-043. */
const RECONCILE = "bookings.reconcile_scan";
/** The booking sync scan of OBE-045. */
const SYNC = "bookings.sync_scan";
/** The sweep of the refunds whose enqueue was lost (FIX-W27-FOLLOWUPS). */
const REFUNDS = "refunds.sweep";
/** The checkout expiry of OBE-056. */
const EXPIRE = "checkouts.expire";
/** The retention purge of OBE-056. */
const RETENTION = "retention.daily";
/** The queue poller of OBE-065. */
const POLL = "queues.poll";
/** The erasure of deleted customers of OBE-087. */
const ERASE = "customers.erase";
const ALPHA = "ten_01JALPHA0000000000000000AA";
const BETA = "ten_01JBETA00000000000000000BB";
/** The 15-minute iteration of the tests: 2026-01-15T10:15:00Z (FakeClock's day). */
const DUE = new Date("2026-01-15T10:15:00.000Z");
/** How long BullMQ keeps a completed job of `ota-maintenance`, in ms: an hour (OBE-101). */
const KEPT_MS = ("age" in KEEP_COMPLETED_MAINTENANCE_JOBS ? KEEP_COMPLETED_MAINTENANCE_JOBS.age : 0) * 1000;
/** The on-VM check's alert on a job that waits for a worker (`QUEUE_AGE_MAX` of deploy/scripts/healthcheck.sh). */
const QUEUE_AGE_ALERT_MS = 10 * 60_000;

interface QueuedJob {
  readonly name: string;
  readonly data: unknown;
  readonly id: string;
}

/** `addBulk` and `add` as BullMQ behaves for them: a job whose id the queue holds already is not added again. */
class QueueDouble {
  readonly jobs = new Map<string, QueuedJob>();
  /** The options each job was added with, by id. */
  readonly options = new Map<string, unknown>();
  readonly calls: number[] = [];

  addBulk(
    jobs: ReadonlyArray<{ name: string; data: unknown; opts?: { jobId?: string } }>,
  ): Promise<unknown[]> {
    this.calls.push(jobs.length);
    return Promise.resolve(jobs.map((job) => this.store(job.name, job.data, job.opts)));
  }

  add(name: string, data: unknown, opts?: { jobId?: string }): Promise<unknown> {
    return Promise.resolve(this.store(name, data, opts));
  }

  private store(name: string, data: unknown, opts: { jobId?: string } | undefined): QueuedJob {
    const jobId = opts?.jobId;
    if (jobId === undefined) {
      throw new Error("every job of the fan-out has an id");
    }
    const existing = this.jobs.get(jobId);
    if (existing !== undefined) {
      return existing;
    }
    const job = { name, data, id: jobId };
    this.jobs.set(jobId, job);
    this.options.set(jobId, opts);
    return job;
  }
}

/** What a job of the retaining double carries of its options. */
interface RetainedJob {
  readonly name: string;
  /** `removeOnComplete.age` of its options, in seconds; `undefined` keeps it. */
  readonly age: number | undefined;
  finishedOn?: number;
}

/**
 * `add` and `addBulk` as BullMQ behaves for them, with the retention of completed jobs: a job whose id the queue holds,
 * waiting or completed, is not added again, and a job that completes removes every completed job of the queue that
 * finished more than its own `removeOnComplete.age` ago (BullMQ's moveToFinished: the age of the job that completes
 * trims the whole queue).
 */
class RetainingQueueDouble {
  /** The ids added, in order: an id that was refused is not in it. */
  readonly added: string[] = [];
  readonly held = new Map<string, RetainedJob>();

  constructor(private readonly clock: FakeClock) {}

  addBulk(
    jobs: ReadonlyArray<{
      name: string;
      data: unknown;
      opts?: { jobId?: string; removeOnComplete?: { age?: number } };
    }>,
  ): Promise<unknown[]> {
    return Promise.resolve(jobs.map((job) => this.add(job.name, job.data, job.opts)));
  }

  add(name: string, _data: unknown, opts?: { jobId?: string; removeOnComplete?: { age?: number } }): unknown {
    if (opts?.jobId === undefined) {
      throw new Error("every job of the fan-out has an id");
    }
    if (!this.held.has(opts.jobId)) {
      this.held.set(opts.jobId, { name, age: opts.removeOnComplete?.age });
      this.added.push(opts.jobId);
    }
    return { id: opts.jobId };
  }

  /** Completes every job that has not completed yet, at the clock's time, one after the other. */
  completeAll(): void {
    const now = this.clock.now().getTime();
    for (const job of [...this.held.values()]) {
      if (job.finishedOn !== undefined) {
        continue;
      }
      job.finishedOn = now;
      if (job.age === undefined) {
        continue;
      }
      for (const [id, other] of this.held) {
        if (other.finishedOn !== undefined && other.finishedOn <= now - job.age * 1000) {
          this.held.delete(id);
        }
      }
    }
  }
}

const silentLogger = (): PinoLogger =>
  ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as PinoLogger;

/** The platform repository's tenant list: ids by status, recording what was asked. */
function tenantList(rows: ReadonlyArray<readonly [string, TenantStatus]>) {
  const asked: Array<readonly TenantStatus[]> = [];
  const repository = {
    tenantIdsByStatus: (statuses: readonly TenantStatus[]) => {
      asked.push(statuses);
      return Promise.resolve(rows.filter(([, status]) => statuses.includes(status)).map(([id]) => id));
    },
  };
  return { asked, repository: repository as unknown as PlatformReadRepository };
}

function tenantRow(id: string, key: string, status: TenantStatus): PlatformTenant {
  return Object.freeze({
    id,
    key,
    name: `${key} Travel`,
    status,
    schemaName: `tenant_${key}` as PlatformTenant["schemaName"],
    storefrontEnvironment: "test",
    defaultCurrency: "EUR",
    defaultLocale: "en",
    billingNotice: null,
  });
}

/** A BullMQ job as the processor reads it. */
function job(name: string, data: unknown, extra: { id?: string; prevMillis?: number } = {}): Job {
  return {
    id: extra.id ?? `${name}-1`,
    name,
    data,
    queueName: "ota-maintenance",
    attemptsMade: 0,
    opts: extra.prevMillis === undefined ? {} : { prevMillis: extra.prevMillis },
  } as unknown as Job;
}

const purgeSchedule = () => {
  const schedule = scheduleById(PURGE);
  if (schedule === undefined) {
    throw new Error("offers.purge is a schedule");
  }
  return schedule;
};

describe("the schedules", () => {
  it("declare offers.purge every 15 minutes for active and suspended tenants, in UTC", () => {
    expect(OTA_SCHEDULES.map((schedule) => schedule.id)).toEqual([
      PURGE,
      SWEEP,
      WATCH,
      TICKETING,
      RECONCILE,
      SYNC,
      REFUNDS,
      EXPIRE,
      RETENTION,
      POLL,
      ERASE,
    ]);
    expect(purgeSchedule()).toMatchObject({
      pattern: "*/15 * * * *",
      milestone: "M2",
      statuses: ["active", "suspended"],
    });
    // OBE-030: the outbox sweep every minute, for suspended tenants too (OADR-0014 point 4).
    expect(scheduleById(SWEEP)).toMatchObject({
      pattern: "* * * * *",
      milestone: "M3",
      statuses: ["active", "suspended"],
    });
    // OBE-040: the authorisation watch at 06:15 UTC every day, for suspended tenants too (OADR-0014 point 4).
    expect(scheduleById(WATCH)).toMatchObject({
      pattern: "15 6 * * *",
      milestone: "M3",
      statuses: ["active", "suspended"],
    });
    // OBE-044: the ticketing scan every 5 minutes, for suspended tenants too (OADR-0008 point 8).
    expect(scheduleById(TICKETING)).toMatchObject({
      pattern: "*/5 * * * *",
      milestone: "M3",
      statuses: ["active", "suspended"],
    });
    // OBE-043: the reconciliation scan every minute, for suspended tenants too (OADR-0003 point 5).
    expect(scheduleById(RECONCILE)).toMatchObject({
      pattern: "* * * * *",
      milestone: "M3",
      statuses: ["active", "suspended"],
    });
    // OBE-045: the booking sync scan every 10 minutes, for suspended tenants too (OADR-0008 point 8).
    expect(scheduleById(SYNC)).toMatchObject({
      pattern: "*/10 * * * *",
      milestone: "M3",
      statuses: ["active", "suspended"],
    });
    // FIX-W27-FOLLOWUPS: the refund sweep every 5 minutes, for suspended tenants too (OADR-0014 point 4).
    expect(scheduleById(REFUNDS)).toMatchObject({
      pattern: "*/5 * * * *",
      milestone: "M3",
      statuses: ["active", "suspended"],
    });
    // OBE-056: the checkout expiry every minute and the retention purge at 03:35 UTC every day, both for suspended
    // tenants too (OADR-0014 point 4).
    expect(scheduleById(EXPIRE)).toMatchObject({
      pattern: "* * * * *",
      milestone: "M3",
      statuses: ["active", "suspended"],
    });
    expect(scheduleById(RETENTION)).toMatchObject({
      pattern: "35 3 * * *",
      milestone: "M3",
      statuses: ["active", "suspended"],
    });
    // OBE-065: the queue poller every 15 minutes, for active tenants only: a Queue List read is new supplier activity,
    // which a suspended OTA does not get (OADR-0014 point 4).
    expect(scheduleById(POLL)).toMatchObject({
      pattern: "*/15 * * * *",
      milestone: "M4",
      statuses: ["active"],
    });
    // OBE-087: the erasure of deleted customers at minute 50 of every hour (lead decision (5f) of 2026-11-05,
    // FIX-W43-OTA: before the erasureDueBy the deletion promised), for suspended tenants too: it starts no supplier
    // activity, and the erasure is owed to the customers (OADR-0014 point 4).
    expect(scheduleById(ERASE)).toMatchObject({
      pattern: "50 * * * *",
      milestone: "M6",
      statuses: ["active", "suspended"],
    });
    for (const schedule of OTA_SCHEDULES) {
      // Job ids `<task>:<tenantId>:<bucket>` and `repeat:<id>:<millis>` must keep exactly three parts.
      expect(schedule.id).not.toContain(":");
      expect(schedule.id).not.toBe(FAN_OUT_JOB);
    }
  });

  it("are registered with upsertJobScheduler, and schedulers that are no longer declared are removed", async () => {
    // The `fan-out` job of each iteration, kept an hour once completed as every job of ota-maintenance (OBE-101).
    const fanOutTemplate = (task: string) => ({
      name: FAN_OUT_JOB,
      data: { task },
      opts: { removeOnComplete: { age: 3_600 } },
    });
    const upsertJobScheduler = vi.fn(() => Promise.resolve(undefined));
    const removeJobScheduler = vi.fn(() => Promise.resolve(true));
    const getJobSchedulers = vi.fn(() => Promise.resolve([{ key: PURGE }, { key: "offers.legacy_sweep" }]));
    const queue = { upsertJobScheduler, removeJobScheduler, getJobSchedulers } as unknown as SchedulerQueue;

    const result = await registerSchedules(queue, OTA_SCHEDULES);

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      PURGE,
      { pattern: "*/15 * * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(PURGE),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      SWEEP,
      { pattern: "* * * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(SWEEP),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      WATCH,
      { pattern: "15 6 * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(WATCH),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      TICKETING,
      { pattern: "*/5 * * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(TICKETING),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      RECONCILE,
      { pattern: "* * * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(RECONCILE),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      SYNC,
      { pattern: "*/10 * * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(SYNC),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      REFUNDS,
      { pattern: "*/5 * * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(REFUNDS),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      EXPIRE,
      { pattern: "* * * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(EXPIRE),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      RETENTION,
      { pattern: "35 3 * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(RETENTION),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      POLL,
      { pattern: "*/15 * * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(POLL),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      ERASE,
      { pattern: "50 * * * *", tz: SCHEDULE_TIME_ZONE },
      fanOutTemplate(ERASE),
    );
    expect(removeJobScheduler).toHaveBeenCalledExactlyOnceWith("offers.legacy_sweep");
    expect(result).toEqual({
      registered: [PURGE, SWEEP, WATCH, TICKETING, RECONCILE, SYNC, REFUNDS, EXPIRE, RETENTION, POLL, ERASE],
      removed: ["offers.legacy_sweep"],
    });
  });

  it("wait at start-up only for a BullMQ connection that is still making its first attempt", async () => {
    const connection = (status: string) =>
      Object.assign(new EventEmitter(), { status }) as unknown as Pick<Redis, "status" | "once" | "off">;

    await expect(firstAttempt(connection("ready"))).resolves.toBe("ready");
    await expect(firstAttempt(connection("reconnecting"))).resolves.toBe("failed");
    const connecting = connection("connecting");
    const failed = firstAttempt(connecting);
    (connecting as unknown as EventEmitter).emit("error", new Error("WRONGPASS"));
    await expect(failed).resolves.toBe("failed");
    const answering = connection("connect");
    const ready = firstAttempt(answering);
    (answering as unknown as EventEmitter).emit("ready");
    await expect(ready).resolves.toBe("ready");
    expect((answering as unknown as EventEmitter).listenerCount("error")).toBe(0);
    await expect(firstAttempt(connection("wait"), 5)).resolves.toBe("failed");
  });
});

describe("per-tenant job ids", () => {
  it("are <task>:<tenantId>:<minute bucket>, with -<n> for the n-th continuation", () => {
    const bucket = minuteBucket(DUE);

    expect(bucket).toBe(Math.floor(DUE.getTime() / 60_000));
    expect(minuteBucket(new Date(DUE.getTime() + 59_999))).toBe(bucket);
    expect(minuteBucket(new Date(DUE.getTime() + 60_000))).toBe(bucket + 1);
    expect(tenantJobId(PURGE, ALPHA, bucket)).toBe(`offers.purge:${ALPHA}:${bucket}`);
    expect(tenantJobId(PURGE, ALPHA, bucket, 2)).toBe(`offers.purge:${ALPHA}:${bucket}-2`);
    expect(tenantJob(PURGE, ALPHA, bucket)).toEqual({
      name: PURGE,
      data: { tenantId: ALPHA, bucket, continuation: 0 },
      opts: { jobId: `offers.purge:${ALPHA}:${bucket}`, removeOnComplete: { age: 3_600 } },
    });
    // BullMQ accepts a custom id with a `:` only when it has exactly three parts.
    expect(tenantJobId(PURGE, ALPHA, bucket, 1).split(":")).toHaveLength(3);
  });

  it("take the bucket from the scheduler iteration's due time, else from the clock", () => {
    const clock = new FakeClock(new Date(DUE.getTime() + 3 * 60_000));

    expect(scheduledAt(job(FAN_OUT_JOB, { task: PURGE }, { prevMillis: DUE.getTime() }), clock)).toEqual(DUE);
    expect(scheduledAt(job(FAN_OUT_JOB, { task: PURGE }), clock)).toEqual(clock.now());
  });

  it("refuse payloads that are not exactly {tenantId, bucket, continuation}", () => {
    const bucket = minuteBucket(DUE);
    expect(parseTenantJobData({ tenantId: ALPHA, bucket, continuation: 0 })).toEqual({
      tenantId: ALPHA,
      bucket,
      continuation: 0,
    });
    for (const data of [
      null,
      { tenantId: ALPHA, bucket },
      { tenantId: ALPHA, bucket, continuation: 0, schemaName: "tenant_alpha" },
      { tenantId: "tenant_alpha", bucket, continuation: 0 },
      { tenantId: ALPHA, bucket: -1, continuation: 0 },
      { tenantId: ALPHA, bucket, continuation: MAX_CONTINUATIONS + 1 },
      { tenantId: ALPHA, bucket: "1", continuation: 0 },
    ]) {
      expect(parseTenantJobData(data)).toBeUndefined();
    }
  });
});

describe("the fan-out", () => {
  it("[OBE-024 AC1] enqueues one job per tenant for two overlapping runs of one iteration (deterministic ids)", async () => {
    const queue = new QueueDouble();
    const { repository } = tenantList([
      [ALPHA, "active"],
      [BETA, "suspended"],
    ]);
    const fanOut = new FanOutService(queue as unknown as Queue, repository, silentLogger());
    const clock = new FakeClock(DUE);
    const processor = new MaintenanceProcessor(
      fanOut,
      {} as unknown as TenantJobRunner,
      clock,
      silentLogger(),
    );
    const iteration = { prevMillis: DUE.getTime() };

    // The iteration's job, and a second run of the same iteration three minutes later (a retry, a duplicate).
    const first = await processor.process(job(FAN_OUT_JOB, { task: PURGE }, iteration));
    clock.advance(3 * 60_000);
    const second = await processor.process(job(FAN_OUT_JOB, { task: PURGE }, iteration));
    // Two runs started by hand within the same minute.
    const third = await fanOut.fanOut(purgeSchedule(), new Date(DUE.getTime() + 40_000));

    const bucket = minuteBucket(DUE);
    expect([first, second, third]).toEqual([
      { task: PURGE, bucket, tenants: 2 },
      { task: PURGE, bucket, tenants: 2 },
      { task: PURGE, bucket, tenants: 2 },
    ]);
    expect([...queue.jobs.keys()]).toEqual([
      `offers.purge:${ALPHA}:${bucket}`,
      `offers.purge:${BETA}:${bucket}`,
    ]);
    expect([...queue.jobs.values()].map((queued) => queued.data)).toEqual([
      { tenantId: ALPHA, bucket, continuation: 0 },
      { tenantId: BETA, bucket, continuation: 0 },
    ]);

    // The next iteration is a new set of jobs.
    await fanOut.fanOut(purgeSchedule(), new Date(DUE.getTime() + 15 * 60_000));
    expect(queue.jobs.size).toBe(4);
  });

  it("[OBE-101 AC1] keeps every per-tenant job an hour once completed, the queue's defaults for the rest", async () => {
    const queue = new QueueDouble();
    const { repository } = tenantList([
      [ALPHA, "active"],
      [BETA, "suspended"],
    ]);

    await new FanOutService(queue as unknown as Queue, repository, silentLogger()).fanOut(
      purgeSchedule(),
      DUE,
    );

    // Only the id and the retention: attempts, backoff and the 30 days of a failed job are the queue's defaults.
    const bucket = minuteBucket(DUE);
    expect([...queue.options.values()]).toEqual(
      [ALPHA, BETA].map((tenant) => ({
        jobId: tenantJobId(PURGE, tenant, bucket),
        removeOnComplete: { age: 3_600 },
      })),
    );
    expect(tenantJob(PURGE, ALPHA, bucket, 3).opts).toEqual({
      jobId: tenantJobId(PURGE, ALPHA, bucket, 3),
      removeOnComplete: KEEP_COMPLETED_MAINTENANCE_JOBS,
    });
  });

  it("[OBE-101 AC1] adds a tenant's job once when the iteration's fan-out runs again at its last retry, and keeps an hour of jobs", async () => {
    const clock = new FakeClock(new Date(DUE.getTime() + 1_000));
    const queue = new RetainingQueueDouble(clock);
    const { repository } = tenantList([
      [ALPHA, "active"],
      [BETA, "suspended"],
    ]);
    const fanOut = new FanOutService(queue as unknown as Queue, repository, silentLogger());
    const processor = new MaintenanceProcessor(
      fanOut,
      {} as unknown as TenantJobRunner,
      clock,
      silentLogger(),
    );
    const iteration = (due: number) => job(FAN_OUT_JOB, { task: SWEEP }, { prevMillis: due });
    const first = [ALPHA, BETA].map((tenant) => tenantJobId(SWEEP, tenant, minuteBucket(DUE)));
    /** Runs the sweep's iteration of every minute after `due` up to `until`, each completed a second after its due. */
    const everyMinute = async (due: number, until: number): Promise<number> => {
      let next = due;
      while (next + 60_000 <= until) {
        next += 60_000;
        clock.set(next + 1_000);
        await processor.process(iteration(next));
        queue.completeAll();
      }
      return next;
    };

    // The iteration's fan-out adds both jobs, which the worker completes at once.
    await processor.process(iteration(DUE.getTime()));
    queue.completeAll();
    // Its last retry (it failed after the add) comes after the 7.5 minutes of backoffs and four waits for a worker
    // just below the on-VM check's alert, while the next iterations' jobs completed every minute.
    const lastRetry = DUE.getTime() + RETRY_BACKOFF_TOTAL_SECONDS * 1000 + 4 * QUEUE_AGE_ALERT_MS;
    const due = await everyMinute(DUE.getTime(), lastRetry - 1_000);
    clock.set(lastRetry);
    await processor.process(iteration(DUE.getTime()));
    queue.completeAll();

    expect(queue.added.filter((id) => first.includes(id))).toEqual(first);
    expect(first.every((id) => queue.held.has(id))).toBe(true);

    // An hour after they completed, the first iteration's jobs are gone, and the queue holds an hour of jobs.
    await everyMinute(due, DUE.getTime() + KEPT_MS);
    expect(first.some((id) => queue.held.has(id))).toBe(false);
    expect(queue.held.size).toBe(2 * (KEPT_MS / 60_000));
  });

  it("[OBE-024 AC3] lists only the schedule's statuses: provisioning and failed tenants get no job", async () => {
    const queue = new QueueDouble();
    const { asked, repository } = tenantList([
      [ALPHA, "active"],
      [BETA, "suspended"],
      ["ten_01JGAMMA000000000000000CC", "provisioning"],
      ["ten_01JDELTA000000000000000DD", "failed"],
      ["ten_01JEPSILON0000000000000EE", "deleted"],
    ]);
    const fanOut = new FanOutService(queue as unknown as Queue, repository, silentLogger());

    await fanOut.fanOut(purgeSchedule(), DUE);

    expect(asked).toEqual([["active", "suspended"]]);
    expect([...queue.jobs.values()].map((queued) => (queued.data as { tenantId: string }).tenantId)).toEqual([
      ALPHA,
      BETA,
    ]);
  });

  it("asks the platform repository for no status without a query, and refuses one platform.tenants does not have", async () => {
    // A database that is never reached: both answers come before any query.
    const repository = new PlatformReadRepository({} as PlatformDb);

    await expect(repository.tenantIdsByStatus([])).resolves.toEqual([]);
    await expect(repository.tenantIdsByStatus(["dormant" as TenantStatus])).rejects.toThrow(TypeError);
  });

  it("adds the jobs of many tenants in chunks", async () => {
    const queue = new QueueDouble();
    const ids = Array.from(
      { length: FAN_OUT_CHUNK * 2 + 1 },
      (_, n) => `ten_01JTENANT${String(n).padStart(17, "0")}`,
    );
    const { repository } = tenantList(ids.map((id) => [id, "active"] as const));
    const fanOut = new FanOutService(queue as unknown as Queue, repository, silentLogger());

    const result = await fanOut.fanOut(purgeSchedule(), DUE);

    expect(result.tenants).toBe(ids.length);
    expect(queue.calls).toEqual([FAN_OUT_CHUNK, FAN_OUT_CHUNK, 1]);
    expect(queue.jobs.size).toBe(ids.length);
  });

  it("fails a fan-out job without a known task at once", async () => {
    const processor = new MaintenanceProcessor(
      {} as unknown as FanOutService,
      {} as unknown as TenantJobRunner,
      new FakeClock(DUE),
      silentLogger(),
    );

    for (const data of [{ task: "offers.unknown" }, { task: PURGE, tenantId: ALPHA }, "offers.purge"]) {
      await expect(processor.process(job(FAN_OUT_JOB, data))).rejects.toBeInstanceOf(UnrecoverableError);
    }
  });
});

/** A handler double of offers.purge that records the tenant context it ran in. */
function recordingHandler(outcome: TenantJobOutcome, tenants: TenantContext) {
  const runs: Array<{ tenantId: string; schemaName: string; actor: string; requestId: string }> = [];
  const handler: TenantJobHandler = {
    run: (tenant) => {
      const context = tenants.require();
      runs.push({
        tenantId: tenant.id,
        schemaName: context.schemaName,
        actor: context.actor.type,
        requestId: context.requestId,
      });
      return Promise.resolve(outcome);
    },
  };
  return { runs, handler };
}

function runnerWith(options: {
  readonly handler?: TenantJobHandler;
  readonly tenants?: Readonly<Record<string, PlatformTenant>>;
  readonly queue?: QueueDouble;
  readonly context?: TenantContext;
  readonly logger?: PinoLogger;
}) {
  const reflector = new Reflector();
  @Injectable()
  @TenantJob(PURGE)
  class PurgeDouble {
    run(...args: Parameters<TenantJobHandler["run"]>): Promise<TenantJobOutcome> {
      if (options.handler === undefined) {
        throw new Error("no handler in this test");
      }
      return options.handler.run(...args);
    }
  }
  const discovery = {
    getProviders: () =>
      options.handler === undefined ? [] : [{ instance: new PurgeDouble(), metatype: PurgeDouble }],
  } as unknown as DiscoveryService;
  const cache = {
    tenantById: (id: string) => Promise.resolve(options.tenants?.[id] ?? null),
  } as unknown as PlatformCache;
  const context = options.context ?? new TenantContext(new ClsService(new AsyncLocalStorage()));
  const queue = options.queue ?? new QueueDouble();
  return {
    queue,
    runner: new TenantJobRunner(
      discovery,
      reflector,
      cache,
      context,
      queue as unknown as Queue,
      options.logger ?? silentLogger(),
    ),
  };
}

describe("the per-tenant runner", () => {
  const bucket = minuteBucket(DUE);
  const data = (continuation = 0) => ({ tenantId: ALPHA, bucket, continuation });

  it("runs the handler in the tenant's context, as the system actor, with the job id as request id", async () => {
    const context = new TenantContext(new ClsService(new AsyncLocalStorage()));
    const { runs, handler } = recordingHandler({ more: false, counts: { searches: 3 } }, context);
    const { runner, queue } = runnerWith({
      handler,
      context,
      tenants: { [ALPHA]: tenantRow(ALPHA, "alpha", "suspended") },
    });

    const result = await runner.run(job(PURGE, data(), { id: tenantJobId(PURGE, ALPHA, bucket) }));

    expect(runs).toEqual([
      {
        tenantId: ALPHA,
        schemaName: "tenant_alpha",
        actor: "system",
        requestId: `offers.purge:${ALPHA}:${bucket}`,
      },
    ]);
    expect(result).toEqual({
      task: PURGE,
      tenantId: ALPHA,
      outcome: "done",
      counts: { searches: 3 },
      continued: false,
    });
    expect(queue.jobs.size).toBe(0);
    expect(context.get()).toBeUndefined();
  });

  it("[OBE-024 AC3] skips a tenant that is provisioning, failed or gone by the time its job runs", async () => {
    const context = new TenantContext(new ClsService(new AsyncLocalStorage()));
    const { runs, handler } = recordingHandler({ more: false, counts: {} }, context);
    const { runner } = runnerWith({
      handler,
      context,
      tenants: {
        [ALPHA]: tenantRow(ALPHA, "alpha", "provisioning"),
        [BETA]: tenantRow(BETA, "beta", "failed"),
      },
    });

    const results = [
      await runner.run(job(PURGE, data())),
      await runner.run(job(PURGE, { ...data(), tenantId: BETA })),
      await runner.run(job(PURGE, { ...data(), tenantId: "ten_01JGONE00000000000000000GG" })),
    ];

    expect(results.map((result) => (result.outcome === "skipped" ? result.reason : result.outcome))).toEqual([
      "tenant_provisioning",
      "tenant_failed",
      "tenant_not_found",
    ]);
    expect(runs).toEqual([]);
  });

  it("enqueues the job again after a full batch, at most MAX_CONTINUATIONS times per run", async () => {
    const context = new TenantContext(new ClsService(new AsyncLocalStorage()));
    const { handler } = recordingHandler(
      { more: true, counts: { searches: JOB_BATCH_LIMITS.searchPurge } },
      context,
    );
    const logger = silentLogger();
    const { runner, queue } = runnerWith({
      handler,
      context,
      logger,
      tenants: { [ALPHA]: tenantRow(ALPHA, "alpha", "active") },
    });

    const first = await runner.run(job(PURGE, data()));
    // A retry of the same job enqueues the same continuation, which the queue already holds.
    await runner.run(job(PURGE, data()));
    const last = await runner.run(job(PURGE, data(MAX_CONTINUATIONS)));

    expect(first).toMatchObject({ outcome: "done", continued: true });
    expect([...queue.jobs.values()]).toEqual([
      { name: PURGE, data: data(1), id: `offers.purge:${ALPHA}:${bucket}-1` },
    ]);
    // [OBE-101 AC1] A continuation is kept an hour once completed, as its first job.
    expect(queue.options.get(`offers.purge:${ALPHA}:${bucket}-1`)).toEqual({
      jobId: `offers.purge:${ALPHA}:${bucket}-1`,
      removeOnComplete: { age: 3_600 },
    });
    expect(last).toMatchObject({ outcome: "done", continued: false });
    expect(logger.warn).toHaveBeenCalledWith(
      { task: PURGE, tenantId: ALPHA, continuations: MAX_CONTINUATIONS },
      "jobs.continuations_exhausted",
    );
  });

  it("fails a job whose name is not a schedule or whose payload is not well formed at once, without its values", async () => {
    const logger = silentLogger();
    const { runner } = runnerWith({ logger });

    await expect(runner.run(job("offers.unknown", data()))).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(runner.run(job(PURGE, { ...data(), schemaName: "tenant_other" }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("tenant_other");
  });

  it("completes a schedule's job without a handler as unhandled, warning once", async () => {
    const logger = silentLogger();
    const { runner } = runnerWith({ logger, tenants: { [ALPHA]: tenantRow(ALPHA, "alpha", "active") } });

    await expect(runner.run(job(PURGE, data()))).resolves.toEqual({ task: PURGE, outcome: "unhandled" });
    await runner.run(job(PURGE, data()));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("@TenantJob handlers", () => {
  it("are found among the providers by schedule; offers.purge is the purge processor's", () => {
    const reflector = new Reflector();
    const purge = Object.create(OffersPurgeProcessor.prototype) as OffersPurgeProcessor;

    const handlers = tenantJobHandlers(
      [
        { instance: purge, metatype: OffersPurgeProcessor },
        { instance: {}, metatype: class Unrelated {} },
        { instance: undefined, metatype: undefined },
      ],
      reflector,
    );

    expect([...handlers]).toEqual([[PURGE, purge]]);
  });

  it("refuse a schedule id that is not declared, a class without run and two handlers of one schedule", () => {
    expect(() => TenantJob("offers.unknown")).toThrow(TypeError);

    @TenantJob(PURGE)
    class WithoutRun {}
    const reflector = new Reflector();
    expect(() =>
      tenantJobHandlers([{ instance: new WithoutRun(), metatype: WithoutRun }], reflector),
    ).toThrow(/no run/);
    const first = Object.create(OffersPurgeProcessor.prototype) as OffersPurgeProcessor;
    const second = Object.create(OffersPurgeProcessor.prototype) as OffersPurgeProcessor;
    expect(() =>
      tenantJobHandlers(
        [
          { instance: first, metatype: OffersPurgeProcessor },
          { instance: second, metatype: OffersPurgeProcessor },
        ],
        reflector,
      ),
    ).toThrow(/two handlers/);
  });
});
