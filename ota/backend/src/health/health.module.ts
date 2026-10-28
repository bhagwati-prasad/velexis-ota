import { Module, type DynamicModule, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { API_APP, WORKER_APP, type SharedConfig } from "../config";
import { HealthController, HealthServer } from "./health.controller";
import {
  createPostgresProbe,
  createRedisProbe,
  HEALTH_PROBES,
  HealthService,
  type DependencyProbe,
} from "./health.service";
import { createQueueAgeReport, HEALTH_QUEUE_AGES, type QueueAgeSource } from "./queue-age";

/** The probes of `/health/ready`: PostgreSQL (DATABASE_URL) and Redis (REDIS_URL), named after the process. */
function probesProvider(app: string): FactoryProvider<readonly DependencyProbe[]> {
  return {
    provide: HEALTH_PROBES,
    inject: [ConfigService, PinoLogger],
    useFactory: (config: ConfigService<SharedConfig, true>, logger: PinoLogger) => {
      logger.setContext(HealthModule.name);
      const options = { connectionName: `${app}-health`, logger };
      return [
        createPostgresProbe(config.get("DATABASE_URL", { infer: true }), options),
        createRedisProbe(config.get("REDIS_URL", { infer: true }), options),
      ];
    },
  };
}

/**
 * The worker's queue part of `/health/ready` (OBE-025, queue-age.ts): its own Redis connection on REDIS_URL, read on
 * the process's Clock. The API has none.
 */
const queueAgesProvider: FactoryProvider<QueueAgeSource> = {
  provide: HEALTH_QUEUE_AGES,
  inject: [ConfigService, Clock],
  useFactory: (config: ConfigService<SharedConfig, true>, clock: Clock) =>
    createQueueAgeReport(config.get("REDIS_URL", { infer: true }), {
      connectionName: `${WORKER_APP}-health-queues`,
      clock,
    }),
};

/**
 * `/health/live` and `/health/ready` (ADR-0016). The API serves them through its Nest HTTP pipeline (`forApi`); the
 * worker has no HTTP adapter and serves them with `HealthServer` on HEALTH_PORT (`forWorker`), and its readiness also
 * reports the queues (OBE-025).
 */
@Module({})
export class HealthModule {
  static forApi(): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [probesProvider(API_APP), HealthService],
    };
  }

  static forWorker(): DynamicModule {
    return {
      module: HealthModule,
      providers: [probesProvider(WORKER_APP), queueAgesProvider, HealthService, HealthServer],
      exports: [HealthServer],
    };
  }
}
