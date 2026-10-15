// The API's PostgreSQL access (platform/docs/architecture.md §4): one `pg.Pool` of role velexis_platform_app
// (DATABASE_URL) and `platformDb`, Kysely over it, for the repositories of every module (ADR-0005). Table names are
// always schema-qualified (`platform.accounts`); the role has no privileges on tenant schemas (ADR-0004). CommonModule
// provides both to the whole API; the readiness probe keeps its own small pool (HealthModule).
import { Inject, Injectable, type FactoryProvider, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createPlatformDb,
  createPool,
  type Kysely,
  type PlatformDatabase,
  type ReferenceDatabase,
} from "@velexis/db";
import { PinoLogger } from "nestjs-pino";
import { PLATFORM_PROCESSES, type PlatformBackendConfig } from "../config";

/** The `pg.Pool` of velexis_platform_app. */
export type PlatformPool = ReturnType<typeof createPool>;

/** Kysely over the platform pool: the `platform` and `reference` schemas. */
export type PlatformDb = Kysely<PlatformDatabase & ReferenceDatabase>;

/** Injection token of the API's PlatformPool. */
export const PLATFORM_POOL = "PLATFORM_POOL";

/** Injection token of the API's PlatformDb. */
export const PLATFORM_DB = "PLATFORM_DB";

/**
 * Connections of the API's pool, as `deploy/postgres/velexis.conf` budgets them (`max_connections = 100`: platform API
 * 10, worker 5). The readiness probe's pool of 2 comes on top.
 */
export const PLATFORM_API_POOL_MAX = 10;

/**
 * The pool: `application_name` is the process name, so `pg_stat_activity` tells the API from the worker. Connections
 * open on the first query, not at start-up. Errors of idle connections are logged without the URL.
 */
const poolProvider: FactoryProvider<PlatformPool> = {
  provide: PLATFORM_POOL,
  inject: [ConfigService, PinoLogger],
  useFactory: (config: ConfigService<PlatformBackendConfig, true>, logger: PinoLogger) => {
    logger.setContext("PlatformDatabase");
    return createPool(config.get("DATABASE_URL", { infer: true }), {
      applicationName: PLATFORM_PROCESSES.api,
      logger,
      max: PLATFORM_API_POOL_MAX,
    });
  },
};

const platformDbProvider: FactoryProvider<PlatformDb> = {
  provide: PLATFORM_DB,
  inject: [PLATFORM_POOL],
  // Never `destroy()` it: that would end the pool, which PlatformPoolCloser ends once.
  useFactory: (pool: PlatformPool) => createPlatformDb<PlatformDatabase & ReferenceDatabase>(pool),
};

/** Ends the pool when the application shuts down (SIGTERM from systemd, `app.close()` in tests). */
@Injectable()
export class PlatformPoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PLATFORM_POOL) private readonly pool: PlatformPool) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.pool.ended) {
      await this.pool.end();
    }
  }
}

/** The providers of the API's database access, for CommonModule. */
export function platformDatabaseProviders(): [
  FactoryProvider<PlatformPool>,
  FactoryProvider<PlatformDb>,
  typeof PlatformPoolCloser,
] {
  return [poolProvider, platformDbProvider, PlatformPoolCloser];
}
