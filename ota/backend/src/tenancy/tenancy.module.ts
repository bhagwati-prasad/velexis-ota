// The tenancy module (ota/docs/architecture.md §2.1, OADR-0009): the process's pool of velexis_ota_app, `platformDb`
// over it and the read-only platform repository. The caller and tenant resolution, the Redis caches, the vx:invalidate
// subscriber, the tenant context and the `tenantTx` wrapper join it in M2 (OBE-011, OBE-012), on the same pool.
//
// The API imports `TenancyModule.forApi()`, the worker `TenancyModule.forWorker()`. A module that needs the repository
// imports the same call again. Each call returns the same module object, and Nest 11 tells dynamic modules apart by
// reference, so a process builds the module once and holds one pool however many modules import it.
import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type FactoryProvider,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPlatformDb, createPool } from "@velexis/db";
import { PinoLogger } from "nestjs-pino";
import { API_APP, WORKER_APP, type SharedConfig } from "../config";
import { PLATFORM_DB, PlatformReadRepository, type PlatformDb } from "./platform-read.repository";

/** The `pg.Pool` of velexis_ota_app (DATABASE_URL). */
export type OtaPool = ReturnType<typeof createPool>;

/** Injection token of the process's `OtaPool`: platform reads now, `tenantTx` from OBE-012. */
export const OTA_POOL = "OTA_POOL";

/**
 * Connections per process, as `deploy/postgres/velexis.conf` budgets them (`max_connections = 100`): the API 20, the
 * worker 10. The readiness probes have pools of their own (health module).
 */
export const OTA_POOL_MAX = Object.freeze({ [API_APP]: 20, [WORKER_APP]: 10 });

/** The process the module serves: `ota-api` or `ota-worker`. */
type OtaApp = keyof typeof OTA_POOL_MAX;

/** Injection token of the `OtaApp` of the module. */
const TENANCY_APP = "TENANCY_APP";

/**
 * The pool: `application_name` is the process name, so `pg_stat_activity` tells the API and the worker apart.
 * Connections open on the first query, not at start-up. Errors of idle connections are logged without the URL.
 */
const poolProvider: FactoryProvider<OtaPool> = {
  provide: OTA_POOL,
  inject: [TENANCY_APP, ConfigService, PinoLogger],
  useFactory: (app: OtaApp, config: ConfigService<SharedConfig, true>, logger: PinoLogger) => {
    logger.setContext(TenancyModule.name);
    return createPool(config.get("DATABASE_URL", { infer: true }), {
      applicationName: app,
      logger,
      max: OTA_POOL_MAX[app],
    });
  },
};

const platformDbProvider: FactoryProvider<PlatformDb> = {
  provide: PLATFORM_DB,
  inject: [OTA_POOL],
  // Never `destroy()` it: that would end the pool, which OtaPoolCloser ends once.
  useFactory: (pool: OtaPool) => createPlatformDb(pool),
};

/** Ends the pool when the process shuts down (SIGTERM from systemd, `app.close()` in tests). */
@Injectable()
class OtaPoolCloser implements OnApplicationShutdown {
  constructor(@Inject(OTA_POOL) private readonly pool: OtaPool) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.pool.ended) {
      await this.pool.end();
    }
  }
}

@Module({})
export class TenancyModule {
  /** One module object per process kind; a new object on each call would be a new module with a pool of its own. */
  private static readonly modules = new Map<OtaApp, DynamicModule>();

  static forApi(): DynamicModule {
    return TenancyModule.forApp(API_APP);
  }

  static forWorker(): DynamicModule {
    return TenancyModule.forApp(WORKER_APP);
  }

  private static forApp(app: OtaApp): DynamicModule {
    let dynamicModule = TenancyModule.modules.get(app);
    if (dynamicModule === undefined) {
      dynamicModule = {
        module: TenancyModule,
        providers: [
          { provide: TENANCY_APP, useValue: app },
          poolProvider,
          platformDbProvider,
          OtaPoolCloser,
          PlatformReadRepository,
        ],
        exports: [PlatformReadRepository],
      };
      TenancyModule.modules.set(app, dynamicModule);
    }
    return dynamicModule;
  }
}
