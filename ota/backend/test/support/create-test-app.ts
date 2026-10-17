// Test support: the API's module graph in process, for Supertest (OBE-010). The application is `AppModule.forRoot`
// exactly as `main.ts` builds it (the same request pipeline, the JSON body limits of main.ts), with optional extra
// controllers around it, and its log lines in a MemorySink. It is initialised, not listening: Supertest drives
// `app.getHttpServer()`.
//
// Unit and contract tests pass no services: the configuration then holds dummy DSNs, and nothing connects (the health
// probes connect on the first readiness check only). The dummy Redis is a port where nothing listens: the API connects
// its vx:invalidate subscriber at start-up and reads the platform caches (OBE-012), and on CI's Redis, which has no
// password, a dummy password would not keep it away, so tests would share cached rows there and nowhere else. Every
// cache lookup then falls back to the (spied or failing) platform repository, the same everywhere. Integration tests
// pass this file's own database and Redis from @velexis/testing:
//
//   db = await createTestDatabase();
//   redis = await useRedis();
//   api = await createTestApp({ database: db, redis });
//   const res = await request(api.server).get("/v1/storefront").set(headers);
//   expectResponseToMatch("getStorefront", res);
//   await api.close(); await redis.close(); await db.drop();
import { Module, type ModuleMetadata, type Type } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { TestDatabase, TestRedis } from "@velexis/testing";
import { AppModule, createApiApp, createApiLogger } from "../../src/app.module";
import type { JsonBodyLimits } from "../../src/common/http/body-parsers";
import { loadApiConfig, type ApiConfig } from "../../src/config";
import { JSON_BODY_LIMITS } from "../../src/main";
import { testApiVariables } from "../helpers/api-env";
import { MemorySink } from "../helpers/log-sink";
import { unreachableRedisUrl } from "../helpers/ports";

/**
 * Dummy service values of the shape the VM uses: nothing here is a secret, and nothing connects to them. REDIS_URL is
 * `unreachableRedisUrl()` (test/helpers/ports.ts), a new port for each application.
 */
export const DUMMY_SERVICES: Readonly<Record<string, string>> = Object.freeze({
  DATABASE_URL: "postgres://velexis_ota_app:dummy@127.0.0.1:5432/velexis",
});

export interface TestAppOptions {
  /** The test's database (`createTestDatabase()`): DATABASE_URL becomes its `velexis_ota_app` DSN. */
  readonly database?: Pick<TestDatabase, "urlFor"> | undefined;
  /** The test's Redis (`useRedis()`): REDIS_URL becomes its database. */
  readonly redis?: Pick<TestRedis, "url"> | undefined;
  /** More variables, over `APP_ENV=test` and the services. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Extra controllers (probes) next to the application's; they are registered before its own routes. */
  readonly controllers?: readonly Type<unknown>[] | undefined;
  /** Extra imports and providers of the test root module. */
  readonly imports?: ModuleMetadata["imports"];
  readonly providers?: ModuleMetadata["providers"];
  /** The per-route JSON body limits; main.ts' `JSON_BODY_LIMITS` by default. */
  readonly jsonBodyLimits?: JsonBodyLimits | undefined;
}

export interface TestApp {
  readonly app: NestExpressApplication;
  /** The HTTP server for Supertest: `request(api.server)`. */
  readonly server: ReturnType<NestExpressApplication["getHttpServer"]>;
  readonly config: ApiConfig;
  /** Every log line of the application. */
  readonly sink: MemorySink;
  close(): Promise<void>;
}

/** Builds and initialises the API application of a test. Close it in `afterAll`/`afterEach`. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const config = loadApiConfig({
    APP_ENV: "test",
    ...DUMMY_SERVICES,
    ...testApiVariables(),
    ...(options.database === undefined ? {} : { DATABASE_URL: options.database.urlFor("ota") }),
    REDIS_URL: options.redis === undefined ? await unreachableRedisUrl() : options.redis.url,
    ...options.env,
  });
  const sink = new MemorySink();
  const appModule = AppModule.forRoot(config, {
    logger: createApiLogger(config, sink),
    jsonBodyLimits: options.jsonBodyLimits ?? JSON_BODY_LIMITS,
  });

  @Module({
    imports: [...(options.imports ?? []), appModule],
    controllers: [...(options.controllers ?? [])],
    providers: [...(options.providers ?? [])],
  })
  class TestRootModule {}

  const app = await createApiApp(config, TestRootModule);
  try {
    await app.init();
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  return { app, server: app.getHttpServer(), config, sink, close: () => app.close() };
}
