// The consumer of `platform-maintenance` (platform/docs/architecture.md §5): one BullMQ worker for the queue, with its
// concurrency of 1, that runs each job of the schedules of scheduler.registry.ts with the handler of the module that
// owns the work. BullMQ hands any job of a queue to any of its workers, whatever its name, so the schedules share
// this one processor instead of one processor per module: a module marks an injectable class with
// `@MaintenanceJob("<schedule id>")` and implements `run(job)`, and provides it in the worker only:
//
//   @Injectable()
//   @MaintenanceJob("api_keys.flush_usage")
//   export class UsageFlushProcessor implements MaintenanceJobHandler {
//     async run(): Promise<UsageFlushResult> { … }
//   }
//
// The processor finds the handlers among the providers of the worker's module graph (DiscoveryService) when it takes
// its first job. A schedule id that is not in PLATFORM_SCHEDULES, or one with two handlers, is a programming error and
// fails the job. A job whose schedule has no handler yet (the module that owns it comes with a later task) completes
// without doing anything, with one `maintenance.no_handler` warning per name and process. A handler that throws fails
// the job, and BullMQ tries it again with the defaults of ADR-0009 (5 attempts, backoff from 30 s); the next run of
// the schedule comes anyway.
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { SetMetadata } from "@nestjs/common";
import { DiscoveryService, Reflector } from "@nestjs/core";
import type { Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PLATFORM_QUEUE, platformWorkerOptions } from "./queue-names";
import { PLATFORM_SCHEDULES } from "./scheduler.registry";

/** The metadata key of `@MaintenanceJob(…)`. */
export const MAINTENANCE_JOB_METADATA = "velexis:maintenance-job";

/** The work of one schedule of `platform-maintenance`. */
export interface MaintenanceJobHandler {
  /** Runs one job of the schedule; what it resolves to is kept with the job (counts, never a secret). */
  run(job: Job): Promise<unknown>;
}

/** What a job without a handler completes with. */
export interface UnhandledMaintenanceJob {
  readonly handled: false;
}

const SCHEDULE_IDS: ReadonlySet<string> = new Set(PLATFORM_SCHEDULES.map((schedule) => schedule.id));

/**
 * Marks an injectable class as the handler of the schedule `scheduleId` (an id of PLATFORM_SCHEDULES, which is also
 * the name of its jobs). Throws when the class is defined for an id that is not a schedule.
 */
export function MaintenanceJob(scheduleId: string): ClassDecorator {
  if (!SCHEDULE_IDS.has(scheduleId)) {
    throw new TypeError(
      `@MaintenanceJob(): ${JSON.stringify(scheduleId)} is not a schedule of PLATFORM_SCHEDULES`,
    );
  }
  return SetMetadata(MAINTENANCE_JOB_METADATA, scheduleId);
}

function isHandler(value: unknown): value is MaintenanceJobHandler {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<MaintenanceJobHandler>).run === "function"
  );
}

/**
 * The handlers among `providers` (instances of classes marked with `@MaintenanceJob`), by schedule id. Throws for a
 * marked class without `run` and for two handlers of one schedule.
 */
export function maintenanceHandlers(
  providers: ReadonlyArray<{ readonly instance: unknown; readonly metatype: unknown }>,
  reflector: Pick<Reflector, "get">,
): Map<string, MaintenanceJobHandler> {
  const handlers = new Map<string, MaintenanceJobHandler>();
  for (const { instance, metatype } of providers) {
    if (typeof metatype !== "function") {
      continue;
    }
    const scheduleId: unknown = reflector.get(MAINTENANCE_JOB_METADATA, metatype);
    if (typeof scheduleId !== "string") {
      continue;
    }
    if (!isHandler(instance)) {
      throw new TypeError(`@MaintenanceJob("${scheduleId}"): the class has no run(job) method`);
    }
    if (handlers.has(scheduleId) && handlers.get(scheduleId) !== instance) {
      throw new TypeError(`@MaintenanceJob("${scheduleId}"): two handlers for one schedule`);
    }
    handlers.set(scheduleId, instance);
  }
  return handlers;
}

@Processor(PLATFORM_QUEUE.maintenance, platformWorkerOptions(PLATFORM_QUEUE.maintenance))
export class MaintenanceProcessor extends WorkerHost {
  private handlers: Map<string, MaintenanceJobHandler> | undefined;
  /** The job names without a handler that were logged already. */
  private readonly unhandled = new Set<string>();
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    @InjectPinoLogger(MaintenanceProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    // Found on the first job, not at module init: the BullMQ worker may take a job before this module's init hooks.
    this.handlers ??= maintenanceHandlers(this.discovery.getProviders(), this.reflector);
    const handler = this.handlers.get(job.name);
    if (handler === undefined) {
      if (!this.unhandled.has(job.name)) {
        this.unhandled.add(job.name);
        this.logger.warn({ queue: PLATFORM_QUEUE.maintenance, job: job.name }, "maintenance.no_handler");
      }
      const result: UnhandledMaintenanceJob = { handled: false };
      return result;
    }
    return handler.run(job);
  }

  /** A job failed: logged with its name and attempt, so the failure is seen before the retries run out. */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      { queue: PLATFORM_QUEUE.maintenance, job: job?.name, attempt: job?.attemptsMade, err: error },
      "maintenance.job_failed",
    );
  }

  /** Errors of the worker itself (its Redis connections). */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: PLATFORM_QUEUE.maintenance, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}
