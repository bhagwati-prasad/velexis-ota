// The worker's module graph and application context (README §2, §4). `worker.ts` creates it and serves /health/* on
// 127.0.0.1:HEALTH_PORT; the BullMQ processors and schedulers join here, never in the API: the `ota-tenant-ops`
// consumer of ProvisioningModule (OBE-005) is the first, the schedulers and the `ota-maintenance` consumer of
// JobsModule (OBE-024) the second, the `ota-notifications` consumer of NotificationsModule (OBE-030) the third, the
// `ota-stripe-events` consumer of PaymentsWorkerModule (OBE-039) the fourth.
import { Module, type DynamicModule, type INestApplicationContext, type Type } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { createLogger, type Logger } from "@velexis/logger";
import { ClsModule } from "nestjs-cls";
import { LoggerModule, Logger as NestPinoLogger } from "nestjs-pino";
import type { DestinationStream } from "pino";
import { CommonModule } from "./common/common.module";
import { QueuesModule } from "./common/queues/queues.module";
import { RedisModule } from "./common/redis/redis.module";
import { WORKER_APP, type WorkerConfig } from "./config";
import { HealthModule } from "./health/health.module";
import { JobsModule } from "./jobs/jobs.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { PaymentsWorkerModule } from "./payments/payments.module";
import { ProvisioningModule } from "./provisioning/provisioning.module";
import { TenancyModule } from "./tenancy/tenancy.module";

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
        // The request context (AsyncLocalStorage) without its HTTP middleware: a job opens one per run with
        // `TenantContext.run` (OBE-024, OADR-0014 point 5).
        ClsModule.forRoot({ global: true }),
        CommonModule,
        HealthModule.forWorker(),
        // The process's Redis connections and BullMQ queues (OBE-002), its velexis_ota_app pool and platform reads
        // (OBE-003). Each is built once, whichever modules import it again.
        RedisModule,
        QueuesModule,
        TenancyModule.forWorker(),
        // The ota-tenant-ops consumer, as velexis_provisioner (DATABASE_PROVISIONER_URL, worker only).
        ProvisioningModule,
        // The schedulers, the ota-maintenance consumer and the per-tenant scheduled jobs (OBE-024).
        JobsModule,
        // The e-mail outbox (global: OutboxService), the SMTP gateway, the ota-notifications consumer and the
        // notifications.sweep handler that JobsModule's runner finds (OBE-030).
        NotificationsModule.forWorker(),
        // The ota-stripe-events consumer: the webhook events read again from Stripe and applied (OBE-039).
        PaymentsWorkerModule,
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
