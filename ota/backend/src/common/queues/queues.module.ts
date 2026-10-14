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
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS_BULLMQ_CONNECTION, RedisModule } from "../redis/redis.module";
import { BULLMQ_PREFIX, DEFAULT_JOB_OPTIONS, OTA_BACKEND_QUEUES } from "./queue-names";

/** The queues of queue-names.ts, as injectable `Queue` providers (`@InjectQueue(name)`). */
const QUEUES = BullModule.registerQueue(...OTA_BACKEND_QUEUES.map((name) => ({ name })));

@Module({
  imports: [
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
  exports: [QUEUES],
})
export class QueuesModule {}
