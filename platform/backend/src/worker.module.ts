// The worker's module graph (README §2 and §4). The worker is a Nest application context without HTTP routes; it
// serves /health/live and /health/ready from the node:http server of worker.ts. It holds the process's Redis
// connections (RedisModule, through QueuesModule), the eight queues of platform/docs/architecture.md §5
// (QueuesModule) and the job schedulers, which it registers when it starts (JobSchedulerRegistry, PBE-009). The
// processors join this graph with the modules that own their work.
import { Module, type DynamicModule } from "@nestjs/common";
import type { Logger } from "@velexis/logger";
import { LoggerModule } from "nestjs-pino";
import { QueuesModule } from "./common/queues/queues.module";
import { JobSchedulerRegistry, schedulerSwitchesProvider } from "./common/queues/scheduler.registry";
import { configModule, type PlatformBackendConfig } from "./config";
import { HealthModule } from "./health/health.module";

@Module({})
export class WorkerModule {
  static forRoot(config: PlatformBackendConfig, logger: Logger): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        configModule(config),
        // The Nest logger and PinoLogger write through the process logger. There is no HTTP middleware here: the
        // health server of worker.ts runs pino-http itself.
        LoggerModule.forRoot({ pinoHttp: { logger } }),
        HealthModule.forWorker(logger),
        QueuesModule,
      ],
      // The schedules of a milestone switch that is off are not registered (PADR-0015 item 2).
      providers: [schedulerSwitchesProvider, JobSchedulerRegistry],
      exports: [HealthModule],
    };
  }
}
