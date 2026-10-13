// The worker's module graph and application context (README §2, §4). `worker.ts` creates it and serves /health/* on
// 127.0.0.1:HEALTH_PORT; later tasks add the BullMQ processors and schedulers here, never to the API.
import { Module, type DynamicModule, type INestApplicationContext, type Type } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { createLogger, type Logger } from "@velexis/logger";
import { LoggerModule, Logger as NestPinoLogger } from "nestjs-pino";
import type { DestinationStream } from "pino";
import { CommonModule } from "./common/common.module";
import { WORKER_APP, type WorkerConfig } from "./config";
import { HealthModule } from "./health/health.module";

/** The process logger of the worker: JSON lines with `app: "ota-worker"` and the redaction list. */
export function createWorkerLogger(config: WorkerConfig, destination?: DestinationStream): Logger {
  return createLogger({ app: WORKER_APP, env: config.APP_ENV, level: config.LOG_LEVEL, destination });
}

export interface WorkerModuleOptions {
  /** The process logger (`createWorkerLogger`); every injected `PinoLogger` writes through it. */
  readonly logger: Logger;
}

@Module({})
export class WorkerModule {
  static forRoot(config: WorkerConfig, options: WorkerModuleOptions): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        // As in the API: the validated configuration only, no .env file and no process.env fallback.
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validatePredefined: false,
          skipProcessEnv: true,
          load: [() => config],
        }),
        // No HTTP pipeline here: only the logger that `PinoLogger` injections and Nest's own messages write to.
        LoggerModule.forRoot({ pinoHttp: { logger: options.logger } }),
        CommonModule,
        HealthModule.forWorker(),
      ],
    };
  }
}

/**
 * Creates the worker's Nest application context (no HTTP adapter): nestjs-pino as the Nest logger and shutdown hooks,
 * so SIGTERM from systemd stops the health server and closes the connections. `root` is `WorkerModule.forRoot(…)`.
 */
export async function createWorkerApp(root: DynamicModule | Type): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(root, { bufferLogs: true, abortOnError: false });
  app.useLogger(app.get(NestPinoLogger));
  app.enableShutdownHooks();
  return app;
}
