// The worker's module graph (README §2 and §4). The worker is a Nest application context without HTTP routes; it
// serves /health/live and /health/ready from the node:http server of worker.ts. BullMQ processors and schedulers
// join this graph in later tasks (PBE-009 onwards).
import { Module, type DynamicModule } from "@nestjs/common";
import type { Logger } from "@velexis/logger";
import { LoggerModule } from "nestjs-pino";
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
      ],
      exports: [HealthModule],
    };
  }
}
