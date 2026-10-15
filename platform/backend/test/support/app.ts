// createTestApp(): the platform API for integration tests (platform/docs/plans/agent-tasks.md, "How to use this file"
// item 7). Every later integration test that calls an endpoint uses it, never shared mutable fixtures:
//
//   let t: TestApp;
//   beforeAll(async () => { t = await createTestApp({ controllers: [MyTestController] }); });
//   afterAll(() => t.close());
//   it("…", async () => {
//     const res = await t.http.post("/v1/auth/sign-up").set(t.bffHeaders("203.0.113.7")).send(body);
//     expectResponseToMatch("signUp", res, { document: "platform" });
//   });
//
// The application is the one main.ts builds (AppModule.forRoot, `configureApiApp`: helmet, cookie-parser, trust proxy,
// the request pipeline of CommonModule), compiled with @nestjs/testing so providers can be replaced, on this test
// file's own database clone (`createTestDatabase()`, role velexis_platform_app) and this worker's Redis database
// (`useRedis()`), with a JWT signing key of its own (a fresh Ed25519 key file, removed by `close()`). It listens on an
// ephemeral port of 127.0.0.1, so Supertest's requests come from loopback, as the portal's and the admin's do. `Clock`
// is a FakeClock unless an override replaces it; TokenService signs and checks tokens at its time.
import type { DynamicModule, ForwardReference, Provider, Type } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createTestDatabase, FakeClock, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { Clock } from "../../src/common/clock";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "../../src/common/http/end-user";
import {
  createProcessLogger,
  parseConfig,
  PLATFORM_PROCESSES,
  type PlatformBackendConfig,
} from "../../src/config";
import { API_APP_OPTIONS, API_HOST, configureApiApp } from "../../src/main";
import { createTestJwtKeyFile, type TestKeyFile } from "./jwt-key";

/** The PLATFORM_BFF_KEY of test applications: the development value of `.env.example` (a dummy). */
export const TEST_BFF_KEY = "dev_bff_key_change_me_0123456789abcdef";

/** A provider replaced in the application: `{ provide: Clock, useValue: clock }`, a class or a factory. */
export type ProviderOverride =
  | { readonly provide: unknown; readonly useValue: unknown }
  | { readonly provide: unknown; readonly useClass: Type }
  | {
      readonly provide: unknown;
      readonly useFactory: (...args: never[]) => unknown;
      readonly inject?: readonly unknown[];
    };

export interface CreateTestAppOptions {
  /** Providers to replace (`overrideProvider` of @nestjs/testing), applied after the FakeClock. */
  readonly overrides?: readonly ProviderOverride[];
  /** Test-only controllers, mounted behind the same pipeline as the API's own routes. */
  readonly controllers?: readonly Type[];
  /** Test-only providers and modules next to the controllers. */
  readonly providers?: readonly Provider[];
  readonly imports?: ReadonlyArray<Type | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  /**
   * Configuration variables over the test defaults (APP_ENV=test, the clone, the Redis database, TEST_BFF_KEY, a new
   * JWT key file; the FEATURE_* switches stay off unless set here).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** The clock the application sees; a new FakeClock (2026-01-15T10:00:00Z) by default. */
  readonly clock?: FakeClock;
}

/** The parsed JSON lines the application logged. */
export class LogSink {
  readonly lines: Array<Record<string, unknown>> = [];

  write(line: string): void {
    this.lines.push(JSON.parse(line) as Record<string, unknown>);
  }

  /** The lines with this `msg`. */
  withMessage(msg: string): Array<Record<string, unknown>> {
    return this.lines.filter((line) => line["msg"] === msg);
  }
}

export interface TestApp {
  readonly app: NestExpressApplication;
  /** Supertest bound to the listening application (`t.http.get("/health/live")`). */
  readonly http: ReturnType<typeof request>;
  /** This test file's database clone; `db.urlFor("platform")` is the application's DATABASE_URL. */
  readonly db: TestDatabase;
  /** This worker's Redis database, flushed when the application was created. */
  readonly redis: TestRedis;
  readonly clock: FakeClock;
  /** Everything the application logged (it writes nothing to stdout). */
  readonly logs: LogSink;
  readonly config: PlatformBackendConfig;
  /**
   * The headers of a call from the portal or admin server for an end user at `ip` (PADR-0019), with TEST_BFF_KEY.
   * `userAgent` defaults to a browser's.
   */
  bffHeaders(ip: string, userAgent?: string): Record<string, string>;
  /** Closes the application, then Redis, then drops the database and deletes the JWT key file. */
  close(): Promise<void>;
}

/**
 * Boots the platform API on a fresh database clone and this worker's Redis database. Call it once per test file, in
 * `beforeAll`: `useRedis()` empties the worker's Redis database, so a second application in the same file would wipe
 * what the first one stored.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const db = await createTestDatabase();
  let redis: TestRedis | undefined;
  let app: NestExpressApplication | undefined;
  let jwtKey: TestKeyFile | undefined;
  try {
    redis = await useRedis();
    jwtKey = createTestJwtKeyFile();
    const config = parseConfig({
      APP_ENV: "test",
      LOG_LEVEL: "info",
      DATABASE_URL: db.urlFor("platform"),
      REDIS_URL: redis.url,
      PLATFORM_BFF_KEY: TEST_BFF_KEY,
      JWT_PRIVATE_KEY_FILE: jwtKey.path,
      ...options.env,
    });
    const logs = new LogSink();
    const logger = createProcessLogger(PLATFORM_PROCESSES.api, config, logs);
    const clock = options.clock ?? new FakeClock();

    let builder = Test.createTestingModule({
      imports: [AppModule.forRoot(config, logger), ...(options.imports ?? [])],
      controllers: [...(options.controllers ?? [])],
      providers: [...(options.providers ?? [])],
    })
      .overrideProvider(Clock)
      .useValue(clock);
    for (const override of options.overrides ?? []) {
      const provider = builder.overrideProvider(override.provide);
      if ("useValue" in override) {
        builder = provider.useValue(override.useValue);
      } else if ("useClass" in override) {
        builder = provider.useClass(override.useClass);
      } else {
        builder = provider.useFactory({
          factory: override.useFactory as (...args: unknown[]) => unknown,
          inject: [...(override.inject ?? [])] as never[],
        });
      }
    }
    const moduleRef = await builder.compile();
    app = configureApiApp(
      moduleRef.createNestApplication<NestExpressApplication>({ ...API_APP_OPTIONS }),
      config,
    );
    await app.listen(0, API_HOST);

    const started = app;
    const startedRedis = redis;
    const startedKey = jwtKey;
    return {
      app: started,
      http: request(started.getHttpServer()),
      db,
      redis: startedRedis,
      clock,
      logs,
      config,
      bffHeaders: (ip, userAgent = "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0") => ({
        [BFF_KEY_HEADER]: TEST_BFF_KEY,
        [END_USER_IP_HEADER]: ip,
        [END_USER_AGENT_HEADER]: userAgent,
      }),
      close: async () => {
        await started.close();
        await startedRedis.close();
        await db.drop();
        startedKey.remove();
      },
    };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await redis?.close().catch(() => undefined);
    await db.drop();
    jwtKey?.remove();
    throw error;
  }
}
