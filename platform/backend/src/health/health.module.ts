// HealthModule (platform/docs/architecture.md §2.1, layer 0): /health/live and /health/ready for both processes.
// It owns the PostgreSQL pool (`createPool` of @velexis/db, role velexis_platform_app) and the Redis client that the
// readiness check probes, and closes them when the application shuts down. The API gets the HTTP controller; the
// worker serves the same two paths from its node:http health server (worker.ts).
import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Type,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPool } from "@velexis/db";
import type { Logger } from "@velexis/logger";
import { Redis } from "ioredis";
import { PLATFORM_PROCESSES, type PlatformBackendConfig, type PlatformProcess } from "../config";
import { HealthController } from "./health.controller";
import { HEALTH_POSTGRES, HEALTH_REDIS, HealthService } from "./health.service";

type PostgresPool = ReturnType<typeof createPool>;

/** The configuration as ConfigModule holds it (the validated object of config.ts). */
type PlatformConfigService = ConfigService<PlatformBackendConfig, true>;

/** Connections of the readiness check: one is enough, a second covers a check that overlaps a slow one. */
const HEALTH_POOL_MAX = 2;

/**
 * The Redis client of the readiness check. A command waits for the connection (start-up) but fails after one
 * reconnection attempt instead of queueing while Redis is down; the client keeps reconnecting in the background
 * (ioredis' default back-off, at most 2 s apart). Connection errors are logged once per outage, not per attempt.
 */
function createRedisClient(url: string, app: PlatformProcess, logger: Logger): Redis {
  const client = new Redis(url, { connectionName: app, maxRetriesPerRequest: 1 });
  let down = false;
  client.on("error", (err: unknown) => {
    if (!down) {
      down = true;
      // `err` keeps type, message, stack and code only: never the command arguments (AUTH carries the password).
      logger.warn({ err }, "redis.connection_error");
    }
  });
  client.on("ready", () => {
    if (down) {
      down = false;
      logger.info("redis.ready");
    }
  });
  return client;
}

/** Ends the pool and disconnects Redis when the application closes (SIGTERM through the shutdown hooks). */
@Injectable()
class HealthConnections implements OnApplicationShutdown {
  constructor(
    @Inject(HEALTH_POSTGRES) private readonly pool: PostgresPool,
    @Inject(HEALTH_REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.pool.end();
  }
}

@Module({})
export class HealthModule {
  /** The API's health module: the HTTP routes of HealthController. */
  static forApi(logger: Logger): DynamicModule {
    return HealthModule.create(PLATFORM_PROCESSES.api, logger, [HealthController]);
  }

  /** The worker's health module: HealthService for the health server of worker.ts, no controller. */
  static forWorker(logger: Logger): DynamicModule {
    return HealthModule.create(PLATFORM_PROCESSES.worker, logger, []);
  }

  private static create(app: PlatformProcess, logger: Logger, controllers: Type[]): DynamicModule {
    return {
      module: HealthModule,
      controllers,
      providers: [
        {
          provide: HEALTH_POSTGRES,
          inject: [ConfigService],
          useFactory: (config: PlatformConfigService): PostgresPool =>
            createPool(config.get("DATABASE_URL", { infer: true }), {
              applicationName: app,
              logger,
              max: HEALTH_POOL_MAX,
            }),
        },
        {
          provide: HEALTH_REDIS,
          inject: [ConfigService],
          useFactory: (config: PlatformConfigService): Redis =>
            createRedisClient(config.get("REDIS_URL", { infer: true }), app, logger),
        },
        HealthConnections,
        HealthService,
      ],
      exports: [HealthService],
    };
  }
}
