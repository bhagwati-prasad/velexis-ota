// The tenancy module (ota/docs/architecture.md §2.1, OADR-0009): the process's pool of velexis_ota_app, `platformDb`
// over it and the read-only platform repository. The API's module also classifies callers (OBE-011): the API key
// verifier with the pepper of API_KEY_PEPPER_FILE, the caller resolver and the caller's request context, which the
// global `CallerGuard` of app.module.ts uses. The tenant resolution, the Redis caches, the vx:invalidate subscriber,
// the tenant context and the `tenantTx` wrapper join it in M2 (OBE-012), on the same pool.
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
import { readKeyFile } from "@velexis/config";
import { API_KEY_PEPPER_MIN_BYTES } from "@velexis/crypto";
import { createPlatformDb, createPool } from "@velexis/db";
import { PinoLogger } from "nestjs-pino";
import { API_APP, WORKER_APP, type ApiConfig, type SharedConfig } from "../config";
import { API_KEY_PEPPER, ApiKeyVerifier } from "./api-key.verifier";
import { CallerContext, CallerResolver } from "./caller-resolver";
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

/**
 * The decoded API key pepper (PADR-0005 item 3), read once from API_KEY_PEPPER_FILE, which the configuration checked
 * at start-up. It stays in this process's memory; it is never logged or passed on.
 */
const apiKeyPepperProvider: FactoryProvider<Buffer> = {
  provide: API_KEY_PEPPER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<ApiConfig, true>) => {
    const pepper = readKeyFile(config.get("API_KEY_PEPPER_FILE", { infer: true }), {
      minBytes: API_KEY_PEPPER_MIN_BYTES,
    });
    if (!Buffer.isBuffer(pepper)) {
      throw new TypeError("API_KEY_PEPPER_FILE must be a base64 key file");
    }
    return pepper;
  },
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

  /** The API's module: the platform repository and the caller classification of OBE-011. */
  static forApi(): DynamicModule {
    return TenancyModule.forApp(API_APP);
  }

  static forWorker(): DynamicModule {
    return TenancyModule.forApp(WORKER_APP);
  }

  private static forApp(app: OtaApp): DynamicModule {
    let dynamicModule = TenancyModule.modules.get(app);
    if (dynamicModule === undefined) {
      // Caller classification needs the API's configuration (the edge secret and the pepper file).
      const callers =
        app === API_APP ? [apiKeyPepperProvider, ApiKeyVerifier, CallerResolver, CallerContext] : [];
      dynamicModule = {
        module: TenancyModule,
        providers: [
          { provide: TENANCY_APP, useValue: app },
          poolProvider,
          platformDbProvider,
          OtaPoolCloser,
          PlatformReadRepository,
          ...callers,
        ],
        exports: [PlatformReadRepository, ...(app === API_APP ? [CallerResolver, CallerContext] : [])],
      };
      TenancyModule.modules.set(app, dynamicModule);
    }
    return dynamicModule;
  }
}
