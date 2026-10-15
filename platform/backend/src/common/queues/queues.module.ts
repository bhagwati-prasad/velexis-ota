// The BullMQ queues of a platform backend process (PBE-009; platform/docs/architecture.md §5, ADR-0009). QueuesModule
// is a static module: Nest builds it once per process, however many modules import it. It configures BullMQ once (the
// process's BullMQ connection from RedisModule, prefix `vx`, the job defaults of ADR-0009) and opens the eight queues
// of queue-names.ts, so a module that imports it can inject any of them:
//
//   constructor(@InjectQueue(PLATFORM_QUEUE.tenantOps) private readonly tenantOps: Queue) {}
//
// Processors run in the worker only: a worker module imports QueuesModule and declares
//
//   @Processor(PLATFORM_QUEUE.emails, platformWorkerOptions(PLATFORM_QUEUE.emails))
//   class EmailProcessor extends WorkerHost { … }
//
// and the API never declares one, so it only produces. Queues are registered here and nowhere else: RedisModule comes
// first in the imports below, so its connections are closed after BullMQ has closed every worker and queue.
//
// A process that shuts down right after it started (a test, or SIGTERM during start-up) first lets its queues and
// workers finish connecting (`BullmqStartupSettler`), as in the OTA backend (OBE-005): BullMQ 5 lets a queue closed
// during its connection set-up report a failure afterwards on an emitter without listeners, an unhandled rejection.
import { BullModule, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Module, type BeforeApplicationShutdown } from "@nestjs/common";
import { DiscoveryModule, DiscoveryService } from "@nestjs/core";
import { Queue, type Worker } from "bullmq";
import type { Redis } from "ioredis";
import { REDIS_BULLMQ_CONNECTION, RedisModule } from "../redis/redis.module";
import { BULLMQ_PREFIX, DEFAULT_JOB_OPTIONS, PLATFORM_BACKEND_QUEUES } from "./queue-names";

/** The queues of queue-names.ts, as injectable `Queue` providers (`@InjectQueue(name)`). */
const QUEUES = BullModule.registerQueue(...PLATFORM_BACKEND_QUEUES.map((name) => ({ name })));

/** How long a shutting-down process waits at most for queues and workers that are still connecting to Redis. */
export const BULLMQ_STARTUP_SETTLE_MS = 1000;

/**
 * Waits until the connection set-up of every queue and worker in `targets` has settled, at most `timeoutMs`. A
 * reachable Redis settles in milliseconds; with an unreachable Redis the set-up never settles, and the wait ends
 * after `timeoutMs`.
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
