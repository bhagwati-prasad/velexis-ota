// The fan-out of the OTA worker's schedules and the consumer of `ota-maintenance` (OBE-024; OADR-0014 points 1, 2, 4
// and 5, ota/docs/architecture.md §6, ADR-0009 items 8–10). Schedulers do not do the work, they fan it out:
//
//   scheduler `offers.purge` (schedulers.ts, every 15 min)
//     → job `fan-out` {task: "offers.purge"}                              FanOutService
//         lists the target tenants: platform.tenants with a status of the schedule (`active`, `suspended`)
//     → one job `offers.purge` {tenantId, bucket, continuation: 0} per tenant, id `offers.purge:<tenantId>:<bucket>`
//         TenantJobRunner: resolves the tenant through the platform cache, re-checks its status, opens its tenant
//         context and runs the schedule's handler (`@TenantJob("offers.purge")`, shopping/offers-purge.processor.ts)
//     → a handler that filled its batch asks for more: the same job again, id `<…>:<bucket>-<n>`, at the back of the
//       queue, at most MAX_CONTINUATIONS times per run (limits.ts)
//
// Deterministic ids: `<bucket>` is the minute (epoch minutes, UTC) at which the scheduler iteration was due, which
// BullMQ keeps with the iteration's job (`opts.prevMillis`); a fan-out job added by other means uses the current
// minute of `Clock`. Two runs of one iteration (a fan-out retried after it failed half-way, a duplicate) therefore
// build the same ids, and BullMQ ignores a job whose id it holds already (completed jobs are kept 1 day, ADR-0009), so
// each tenant gets one job per iteration. Job ids have exactly three `:`-separated parts, which BullMQ allows.
//
// One processor consumes the queue (concurrency 2): BullMQ hands any job of a queue to any of its workers, whatever its
// name, so the fan-out and every schedule's per-tenant jobs share it. A module that owns scheduled work marks an
// injectable class with `@TenantJob("<schedule id>")`, implements `run(tenant, job)` and is provided in the worker
// only; the runner finds the handlers among the worker's providers (DiscoveryService) when it takes its first job.
// Payloads carry ids and small counters only, and handlers trust nothing in them beyond the tenant id (point 5): the
// runner reads the tenant again (`tenant:<id>`, the cache the API uses), skips it unless its status is still one of
// the schedule's (a tenant that became `failed` or `provisioning` meanwhile, or was deleted), and the handler re-reads
// its rows inside `tenantTx`. A job that is not well formed fails at once (`UnrecoverableError`); a failing handler
// fails the job, and BullMQ tries it again with the defaults of ADR-0009; the next scheduler run comes anyway.
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, SetMetadata } from "@nestjs/common";
import { DiscoveryService, Reflector } from "@nestjs/core";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { OTA_QUEUE, otaWorkerOptions } from "../common/queues/queue-names";
import { PlatformCache } from "../tenancy/platform-cache";
import { PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { FAN_OUT_CHUNK, MAX_CONTINUATIONS } from "./limits";
import { FAN_OUT_JOB, scheduleById, type FanOutJobData, type ScheduleDefinition } from "./schedulers";

const MINUTE_MS = 60_000;

/** A tenant id as the platform writes it (`ten_` and a ULID). */
const TENANT_ID = /^ten_[0-9A-Za-z]{1,60}$/;

/** The minute bucket of an instant: whole minutes since the epoch, UTC. */
export function minuteBucket(instant: Date): number {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError("minuteBucket: not a valid instant");
  }
  return Math.floor(ms / MINUTE_MS);
}

/**
 * The BullMQ id of a per-tenant job: `<task>:<tenantId>:<bucket>` for the job of a fan-out, and
 * `<task>:<tenantId>:<bucket>-<n>` for its n-th continuation.
 */
export function tenantJobId(task: string, tenantId: string, bucket: number, continuation = 0): string {
  const id = `${task}:${tenantId}:${bucket}`;
  return continuation === 0 ? id : `${id}-${continuation}`;
}

/** The payload of a per-tenant job: the tenant, the fan-out's minute bucket and how often it continued itself. */
export interface TenantJobData {
  readonly tenantId: string;
  readonly bucket: number;
  readonly continuation: number;
}

/** A per-tenant job as `Queue.add`/`addBulk` take it. */
export interface TenantJobSpec {
  readonly name: string;
  readonly data: TenantJobData;
  readonly opts: { readonly jobId: string };
}

/** The per-tenant job of `task` for `tenantId`: its name is the task, its id `tenantJobId(…)`. */
export function tenantJob(task: string, tenantId: string, bucket: number, continuation = 0): TenantJobSpec {
  return {
    name: task,
    data: { tenantId, bucket, continuation },
    opts: { jobId: tenantJobId(task, tenantId, bucket, continuation) },
  };
}

/**
 * When the fan-out job's scheduler iteration was due: BullMQ's `opts.prevMillis` of a scheduler's job, else (a job
 * added by hand) the current instant of `clock`.
 */
export function scheduledAt(job: Pick<Job, "opts">, clock: Pick<Clock, "now">): Date {
  const due = job.opts.prevMillis;
  return typeof due === "number" && Number.isFinite(due) && due > 0 ? new Date(due) : clock.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/** The payload of a `fan-out` job, or `undefined` when it is not one (extra fields included). */
export function parseFanOutJobData(data: unknown): FanOutJobData | undefined {
  if (!isRecord(data) || Object.keys(data).length !== 1 || typeof data["task"] !== "string") {
    return undefined;
  }
  return { task: data["task"] };
}

/** The payload of a per-tenant job, or `undefined` when it is not one (extra fields included). */
export function parseTenantJobData(data: unknown): TenantJobData | undefined {
  if (!isRecord(data) || Object.keys(data).length !== 3) {
    return undefined;
  }
  const { tenantId, bucket, continuation } = data;
  if (
    typeof tenantId !== "string" ||
    !TENANT_ID.test(tenantId) ||
    !isCount(bucket, Number.MAX_SAFE_INTEGER) ||
    !isCount(continuation, MAX_CONTINUATIONS)
  ) {
    return undefined;
  }
  return { tenantId, bucket, continuation };
}

/** What a fan-out did (kept with the fan-out job): counts, never more. */
export interface FanOutResult {
  readonly task: string;
  readonly bucket: number;
  /** Target tenants, one job each (BullMQ ignored those it held already). */
  readonly tenants: number;
}

/** Lists the target tenants of a schedule and enqueues one job per tenant on `ota-maintenance`. */
@Injectable()
export class FanOutService {
  constructor(
    @InjectQueue(OTA_QUEUE.maintenance) private readonly queue: Queue,
    private readonly platform: PlatformReadRepository,
    @InjectPinoLogger(FanOutService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * The fan-out of `schedule` for the iteration due at `at`: the tenants whose status is one of the schedule's
   * (one read-only query of platform.tenants; the per-tenant jobs resolve each one through the cache), and one job
   * `tenantJob(schedule.id, tenantId, minuteBucket(at))` each, added in chunks of FAN_OUT_CHUNK.
   */
  async fanOut(schedule: ScheduleDefinition, at: Date): Promise<FanOutResult> {
    const bucket = minuteBucket(at);
    const tenantIds = await this.platform.tenantIdsByStatus(schedule.statuses);
    for (let start = 0; start < tenantIds.length; start += FAN_OUT_CHUNK) {
      await this.queue.addBulk(
        tenantIds
          .slice(start, start + FAN_OUT_CHUNK)
          .map((tenantId) => tenantJob(schedule.id, tenantId, bucket)),
      );
    }
    const result: FanOutResult = { task: schedule.id, bucket, tenants: tenantIds.length };
    this.logger.debug({ ...result }, "jobs.fanned_out");
    return result;
  }
}

/** The metadata key of `@TenantJob(…)`. */
export const TENANT_JOB_METADATA = "velexis:tenant-job";

/** What a handler's run did. */
export interface TenantJobOutcome {
  /** True when the run filled its batch and more is due: the runner enqueues the job again. */
  readonly more: boolean;
  /** Counts for the job's result and log line (rows deleted, sent, …), never ids of people or values. */
  readonly counts: Readonly<Record<string, number>>;
}

/** The work of one schedule for one tenant, run inside the tenant's context (`TenantTx` works there). */
export interface TenantJobHandler {
  run(tenant: PlatformTenant, job: Job): Promise<TenantJobOutcome>;
}

/**
 * Marks an injectable class as the per-tenant handler of the schedule `scheduleId` (an id of OTA_SCHEDULES, which is
 * also the name of its per-tenant jobs). Throws when the class is defined for an id that is not a schedule.
 */
export function TenantJob(scheduleId: string): ClassDecorator {
  if (scheduleById(scheduleId) === undefined) {
    throw new TypeError(`@TenantJob(): ${JSON.stringify(scheduleId)} is not a schedule of OTA_SCHEDULES`);
  }
  return SetMetadata(TENANT_JOB_METADATA, scheduleId);
}

function isHandler(value: unknown): value is TenantJobHandler {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<TenantJobHandler>).run === "function"
  );
}

/**
 * The handlers among `providers` (instances of classes marked with `@TenantJob`), by schedule id. Throws for a marked
 * class without `run` and for two handlers of one schedule.
 */
export function tenantJobHandlers(
  providers: ReadonlyArray<{ readonly instance: unknown; readonly metatype: unknown }>,
  reflector: Pick<Reflector, "get">,
): Map<string, TenantJobHandler> {
  const handlers = new Map<string, TenantJobHandler>();
  for (const { instance, metatype } of providers) {
    if (typeof metatype !== "function") {
      continue;
    }
    const scheduleId: unknown = reflector.get(TENANT_JOB_METADATA, metatype);
    if (typeof scheduleId !== "string") {
      continue;
    }
    if (!isHandler(instance)) {
      throw new TypeError(`@TenantJob("${scheduleId}"): the class has no run(tenant, job) method`);
    }
    if (handlers.has(scheduleId) && handlers.get(scheduleId) !== instance) {
      throw new TypeError(`@TenantJob("${scheduleId}"): two handlers for one schedule`);
    }
    handlers.set(scheduleId, instance);
  }
  return handlers;
}

/**
 * The tenant context of a job (OADR-0014 point 5): the platform row's tenant and schema, the tenant's storefront
 * environment, no request caller (`anonymous`) and the `system` actor; the BullMQ job id is the request id of its log
 * lines.
 */
export function jobTenant(tenant: PlatformTenant, job: Pick<Job, "id" | "name">): RequestTenant {
  return {
    tenantId: tenant.id,
    key: tenant.key,
    schemaName: tenant.schemaName,
    environment: tenant.storefrontEnvironment,
    caller: { type: "anonymous", id: "anonymous" },
    actor: { type: "system", id: null },
    requestId: job.id ?? job.name,
  };
}

/** Why a per-tenant job did nothing. */
export type TenantJobSkip = "tenant_not_found" | `tenant_${TenantStatus}`;

/** What a per-tenant job completes with (BullMQ keeps it with the job): ids and counts, never more. */
export type TenantJobResult =
  | {
      readonly task: string;
      readonly tenantId: string;
      readonly outcome: "done";
      readonly counts: Readonly<Record<string, number>>;
      /** True when the job enqueued its continuation. */
      readonly continued: boolean;
    }
  | {
      readonly task: string;
      readonly tenantId: string;
      readonly outcome: "skipped";
      readonly reason: TenantJobSkip;
    }
  | { readonly task: string; readonly outcome: "unhandled" };

/** What the runner and the processor log a refused job with. */
export const JOB_INVALID_LOG = "jobs.job_invalid";

/** Job names come from this backend; longer ones are shortened in a log line all the same. */
const MAX_NAME_IN_LOG = 64;

function shortened(value: string): string {
  return value.length > MAX_NAME_IN_LOG ? `${value.slice(0, MAX_NAME_IN_LOG)}…` : value;
}

/** Runs the per-tenant jobs of the schedules (see the file header). */
@Injectable()
export class TenantJobRunner {
  private handlers: Map<string, TenantJobHandler> | undefined;
  /** The schedules without a handler that were logged already. */
  private readonly unhandled = new Set<string>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    @InjectQueue(OTA_QUEUE.maintenance) private readonly queue: Queue,
    @InjectPinoLogger(TenantJobRunner.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Runs one per-tenant job: refuses a job whose name is not a schedule or whose payload is not well formed
   * (`UnrecoverableError`), skips a tenant that is gone or no longer has one of the schedule's statuses, runs the
   * handler in the tenant's context, and enqueues the continuation when the handler asks for more.
   */
  async run(job: Job): Promise<TenantJobResult> {
    const schedule = scheduleById(job.name);
    const data = parseTenantJobData(job.data);
    if (schedule === undefined || data === undefined) {
      this.logger.error(
        { queue: job.queueName, jobId: job.id, jobName: shortened(String(job.name)) },
        JOB_INVALID_LOG,
      );
      throw new UnrecoverableError(
        schedule === undefined
          ? "the job name is not a schedule of OTA_SCHEDULES"
          : "the payload is not {tenantId, bucket, continuation}",
      );
    }
    // Found on the first job, not at module init: the BullMQ worker may take a job before this module's init hooks.
    this.handlers ??= tenantJobHandlers(this.discovery.getProviders(), this.reflector);
    const handler = this.handlers.get(schedule.id);
    if (handler === undefined) {
      if (!this.unhandled.has(schedule.id)) {
        this.unhandled.add(schedule.id);
        this.logger.warn({ queue: job.queueName, task: schedule.id }, "jobs.no_handler");
      }
      return { task: schedule.id, outcome: "unhandled" };
    }

    const tenant = await this.cache.tenantById(data.tenantId);
    if (tenant === null || !(schedule.statuses as readonly string[]).includes(tenant.status)) {
      const reason: TenantJobSkip = tenant === null ? "tenant_not_found" : `tenant_${tenant.status}`;
      this.logger.debug({ task: schedule.id, tenantId: data.tenantId, reason }, "jobs.tenant_skipped");
      return { task: schedule.id, tenantId: data.tenantId, outcome: "skipped", reason };
    }

    const outcome = await this.tenants.run(jobTenant(tenant, job), () => handler.run(tenant, job));
    let continued = false;
    if (outcome.more) {
      if (data.continuation < MAX_CONTINUATIONS) {
        const next = tenantJob(schedule.id, tenant.id, data.bucket, data.continuation + 1);
        await this.queue.add(next.name, next.data, next.opts);
        continued = true;
      } else {
        this.logger.warn(
          { task: schedule.id, tenantId: tenant.id, continuations: data.continuation },
          "jobs.continuations_exhausted",
        );
      }
    }
    return { task: schedule.id, tenantId: tenant.id, outcome: "done", counts: outcome.counts, continued };
  }
}

/** The error code of a failed job for its log line: the code of an `AppError` or PostgreSQL error, else its name. */
function errorCodeOf(error: Error): string {
  const code: unknown = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && code.length <= MAX_NAME_IN_LOG ? code : error.name;
}

/**
 * The consumer of `ota-maintenance` (architecture §6, concurrency 2): `fan-out` jobs go to FanOutService, the jobs
 * named after a schedule to TenantJobRunner; anything else fails at once.
 */
@Processor(OTA_QUEUE.maintenance, otaWorkerOptions(OTA_QUEUE.maintenance))
export class MaintenanceProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly fanOut: FanOutService,
    private readonly runner: TenantJobRunner,
    private readonly clock: Clock,
    @InjectPinoLogger(MaintenanceProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<FanOutResult | TenantJobResult> {
    if (job.name !== FAN_OUT_JOB) {
      return this.runner.run(job);
    }
    const data = parseFanOutJobData(job.data);
    const schedule = data === undefined ? undefined : scheduleById(data.task);
    if (schedule === undefined) {
      this.logger.error({ queue: job.queueName, jobId: job.id, jobName: FAN_OUT_JOB }, JOB_INVALID_LOG);
      throw new UnrecoverableError("the payload is not {task} with a schedule of OTA_SCHEDULES");
    }
    return this.fanOut.fanOut(schedule, scheduledAt(job, this.clock));
  }

  /**
   * A job failed: logged with its name, id, attempt and the error's code, so the failure is seen before the retries
   * run out. Never the error itself: it may quote SQL (BullMQ keeps its message as the job's `failedReason`).
   */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      {
        queue: OTA_QUEUE.maintenance,
        jobName: job === undefined ? undefined : shortened(String(job.name)),
        jobId: job?.id,
        attempt: job?.attemptsMade,
        code: errorCodeOf(error),
      },
      "jobs.job_failed",
    );
  }

  /** Errors of the worker itself (its Redis connections); job failures are the `failed` events above. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: OTA_QUEUE.maintenance, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}
