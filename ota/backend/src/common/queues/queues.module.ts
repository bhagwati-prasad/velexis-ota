// The BullMQ queues of an OTA backend process (OBE-002; ota/docs/architecture.md §6, ADR-0009). QueuesModule is a
// static module: Nest builds it once per process, however many modules import it. It configures BullMQ once (the
// process's BullMQ connection from RedisModule, prefix `vx`, the job defaults of ADR-0009) and opens every queue of
// queue-names.ts, so a module that imports it can inject any of them:
//
//   constructor(@InjectQueue(OTA_QUEUE.notifications) private readonly notifications: Queue) {}
//
// Processors run in the worker only: a worker module imports QueuesModule and declares
//
//   @Processor(OTA_QUEUE.tenantOps, otaWorkerOptions(OTA_QUEUE.tenantOps))
//   class TenantOpsProcessor extends WorkerHost { … validateTenantOpsJob(job, logger) … }
//
// and the API never declares one, so it only produces. Queues are registered here and nowhere else: RedisModule comes
// first in the imports below, so its connections are closed after BullMQ has closed every worker and queue.
//
// A process that shuts down right after it started (a test, or SIGTERM during start-up) first lets its queues and
// workers finish connecting: `BullmqStartupSettler` below (OBE-005).
import { BullModule, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Module, type BeforeApplicationShutdown } from "@nestjs/common";
import { DiscoveryModule, DiscoveryService } from "@nestjs/core";
import { Queue, type Worker } from "bullmq";
import type { Redis } from "ioredis";
import { REDIS_BULLMQ_CONNECTION, RedisModule } from "../redis/redis.module";
import { BULLMQ_PREFIX, DEFAULT_JOB_OPTIONS, OTA_BACKEND_QUEUES } from "./queue-names";

/** The queues of queue-names.ts, as injectable `Queue` providers (`@InjectQueue(name)`). */
const QUEUES = BullModule.registerQueue(...OTA_BACKEND_QUEUES.map((name) => ({ name })));

/** How long a shutting-down process waits at most for queues and workers that are still connecting to Redis. */
export const BULLMQ_STARTUP_SETTLE_MS = 1000;

/**
 * Waits until the connection set-up of every queue and worker in `targets` has settled, at most `timeoutMs`.
 *
 * BullMQ 5 lets a queue or worker that is closed while its Redis connection is still being set up finish that set-up
 * afterwards, and report a failure on an emitter whose listeners `close()` has already removed: an unhandled
 * rejection, which stops a Node.js process. Waiting first lets a reachable Redis finish in milliseconds. With an
 * unreachable Redis the set-up waits for a reconnection that the shutdown never allows, so it never settles and
 * never rejects; the wait then ends after `timeoutMs`.
 */
export async function settleBullmqStartup(
  targets: ReadonlyArray<{ waitUntilReady(): Promise<unknown> }>,
  timeoutMs: number = BULLMQ_STARTUP_SETTLE_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(resolveTimeout, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled(targets.map((target) => target.waitUntilReady())), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `settleBullmqStartup` for every queue and every processor's worker of the process before shutdown
 * (`beforeApplicationShutdown`), that is before @nestjs/bullmq closes them in `onApplicationShutdown`.
 */
@Injectable()
export class BullmqStartupSettler implements BeforeApplicationShutdown {
  constructor(private readonly discovery: DiscoveryService) {}

  async beforeApplicationShutdown(): Promise<void> {
    const targets = this.discovery.getProviders().flatMap((wrapper): Array<Queue | Worker> => {
      const instance: unknown = wrapper.instance;
      if (instance instanceof Queue) {
        return [instance];
      }
      if (instance instanceof WorkerHost) {
        // `worker` throws while @nestjs/bullmq has not created it (a start-up that failed before).
        try {
          return [instance.worker];
        } catch {
          return [];
        }
      }
      return [];
    });
    await settleBullmqStartup(targets);
  }
}

@Module({
  imports: [
    DiscoveryModule,
    RedisModule,
    // One shared configuration for every queue and worker of the process: the BullMQ connection (BullMQ duplicates
    // it for each worker's blocking connection), the `vx` key prefix and the job defaults of ADR-0009 item 7.
    BullModule.forRootAsync({
      imports: [RedisModule],
      inject: [REDIS_BULLMQ_CONNECTION],
      useFactory: (connection: Redis) => ({
        connection,
        prefix: BULLMQ_PREFIX,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
    }),
    QUEUES,
  ],
  providers: [BullmqStartupSettler],
  exports: [QUEUES],
})
export class QueuesModule {}
