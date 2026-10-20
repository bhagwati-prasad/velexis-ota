// The tenancy module (ota/docs/architecture.md §2.1, OADR-0009): the process's pool of velexis_ota_app, `platformDb`
// over it and the read-only platform repository. The API's module also classifies callers (OBE-011): the API key
// verifier with the pepper of API_KEY_PEPPER_FILE, the caller resolver and the caller's request context, which the
// global `CallerGuard` of app.module.ts uses. And it resolves tenants (OBE-012): the Redis caches of the platform rows
// (on the process's Redis client), the vx:invalidate subscriber, the tenant resolver and the tenant context that the
// global `TenantGuard` uses, and `TenantTx` over the same pool.
//
// The worker's module has the platform repository, and since OBE-024 the same caches, subscriber, tenant context and
// `TenantTx` for its jobs (OADR-0014 point 5): a job resolves its tenant through `tenant:<id>` as the API does and
// opens its context with `TenantContext.run`. Caller classification and tenant resolution stay the API's.
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
import { createPlatformDb, createPool, createTenantDb, type TenantDb } from "@velexis/db";
import { PinoLogger } from "nestjs-pino";
import { RedisModule } from "../common/redis/redis.module";
import { API_APP, WORKER_APP, type ApiConfig, type SharedConfig } from "../config";
import { API_KEY_PEPPER, API_KEY_ROWS, ApiKeyVerifier } from "./api-key.verifier";
import { CallerContext, CallerResolver } from "./caller-resolver";
import { InvalidationSubscriber } from "./invalidation.subscriber";
import { PlatformCache } from "./platform-cache";
import { PLATFORM_DB, PlatformReadRepository, type PlatformDb } from "./platform-read.repository";
import { TenantContext } from "./tenant-context";
import { TenantResolver } from "./tenant-resolver";
import { TENANT_DB, TenantTx } from "./tenant-tx";

/** The `pg.Pool` of velexis_ota_app (DATABASE_URL). */
export type OtaPool = ReturnType<typeof createPool>;

/** Injection token of the process's `OtaPool`: platform reads, and `tenantTx` in the API (OBE-012). */
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

/** `tenantTx` over the same pool; the search_path leak guard runs outside production (@velexis/db). */
const tenantDbProvider: FactoryProvider<TenantDb> = {
  provide: TENANT_DB,
  inject: [OTA_POOL, ConfigService],
  useFactory: (pool: OtaPool, config: ConfigService<SharedConfig, true>) =>
    createTenantDb(pool, { appEnv: config.get("APP_ENV", { infer: true }) }),
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

  /** The API's module: the platform repository, caller classification (OBE-011) and tenant resolution (OBE-012). */
  static forApi(): DynamicModule {
    return TenancyModule.forApp(API_APP);
  }

  /** The worker's module: the platform repository, and the caches, tenant context and `TenantTx` of its jobs. */
  static forWorker(): DynamicModule {
    return TenancyModule.forApp(WORKER_APP);
  }

  private static forApp(app: OtaApp): DynamicModule {
    let dynamicModule = TenancyModule.modules.get(app);
    if (dynamicModule === undefined) {
      // Caller classification and tenant resolution need the API's configuration (the edge secret, the pepper file,
      // the storefront base domain) and its request context; the key rows come through the platform cache.
      const api = app === API_APP;
      const requests = api
        ? [
            apiKeyPepperProvider,
            { provide: API_KEY_ROWS, useExisting: PlatformCache },
            ApiKeyVerifier,
            CallerResolver,
            CallerContext,
            TenantResolver,
          ]
        : [];
      dynamicModule = {
        module: TenancyModule,
        imports: [RedisModule],
        providers: [
          { provide: TENANCY_APP, useValue: app },
          poolProvider,
          platformDbProvider,
          OtaPoolCloser,
          PlatformReadRepository,
          PlatformCache,
          InvalidationSubscriber,
          TenantContext,
          tenantDbProvider,
          TenantTx,
          ...requests,
        ],
        exports: [
          PlatformReadRepository,
          PlatformCache,
          TenantContext,
          TenantTx,
          ...(api ? [CallerResolver, CallerContext, TenantResolver] : []),
        ],
      };
      TenancyModule.modules.set(app, dynamicModule);
    }
    return dynamicModule;
  }
}
