// The API's module graph and application factory (README §2). `main.ts` starts it on 127.0.0.1:PORT; tests create it
// with their own logger destination and, for request pipeline tests, extra controllers around `AppModule.forRoot`.
import {
  Module,
  RequestMethod,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type Type,
} from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createLogger, pinoHttpOptions, resolveRequestId, type Logger } from "@velexis/logger";
import { ClsMiddleware, ClsModule } from "nestjs-cls";
import { LoggerModule, Logger as NestPinoLogger } from "nestjs-pino";
import type { DestinationStream } from "pino";
import { CommonModule } from "./common/common.module";
import { API_APP, type ApiConfig } from "./config";
import { HealthModule } from "./health/health.module";

/** Every route of the application (path-to-regexp 8 syntax of NestJS 11). */
const ALL_ROUTES = { path: "{*path}", method: RequestMethod.ALL };

/** The process logger of the API: JSON lines with `app: "ota-api"` and the redaction list of `@velexis/logger`. */
export function createApiLogger(config: ApiConfig, destination?: DestinationStream): Logger {
  return createLogger({ app: API_APP, env: config.APP_ENV, level: config.LOG_LEVEL, destination });
}

/**
 * The request id of the request context: the id pino-http has already set from a valid `X-Request-Id` or generated
 * (and returned in the response header). The fallback only runs if the middleware order were broken.
 */
function requestIdOf(req: { id?: unknown; headers: Record<string, string | string[] | undefined> }): string {
  return typeof req.id === "string" ? req.id : resolveRequestId(req.headers["x-request-id"]);
}

export interface AppModuleOptions {
  /** The process logger (`createApiLogger`). Every request line and every injected `PinoLogger` writes through it. */
  readonly logger: Logger;
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: ApiConfig, options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // The validated, frozen configuration is the only source: no .env file, no process.env fallback, so the
        // API's ConfigService never answers for a variable outside its schema (the provisioner or migrator DSN).
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validatePredefined: false,
          skipProcessEnv: true,
          load: [() => config],
        }),
        // One line per request with requestId, method, route, status and durationMs; never headers, query strings or
        // bodies; /health/* not logged (@velexis/logger, ADR-0016).
        LoggerModule.forRoot({
          pinoHttp: pinoHttpOptions({ app: API_APP, logger: options.logger }),
          forRoutes: [ALL_ROUTES],
        }),
        // The request context (AsyncLocalStorage). Its middleware is mounted by `configure` below, after pino-http.
        ClsModule.forRoot({
          global: true,
          middleware: { mount: false, generateId: true, idGenerator: requestIdOf },
        }),
        CommonModule,
        HealthModule.forApi(),
      ],
    };
  }

  /**
   * Mounts the request context on every route. Middleware of global modules (nestjs-pino's LoggerModule) runs before
   * the middleware of this module, so pino-http has set `req.id` when the context takes it as its id.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ClsMiddleware).forRoutes(ALL_ROUTES);
  }
}

/**
 * Creates the API application, not yet listening: nestjs-pino as the Nest logger, Express `trust proxy` from
 * TRUST_PROXY, no `X-Powered-By`, and shutdown hooks (SIGTERM from systemd closes the pools and connections).
 * `root` is `AppModule.forRoot(config, …)` or a test module that imports it.
 */
export async function createApiApp(
  config: ApiConfig,
  root: DynamicModule | Type,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(root, {
    bufferLogs: true,
    // Errors while the module graph is built are thrown to the caller, which logs them and exits non-zero.
    abortOnError: false,
  });
  app.useLogger(app.get(NestPinoLogger));
  // An HTTP application keeps Nest's own lines in the start-up buffer until listen() succeeds. Flush it now, so they
  // reach pino from here on (the exception handler's error lines included) also when only init() runs, as in
  // Supertest tests, or when listen() fails.
  app.flushLogs();
  app.set("trust proxy", [...config.TRUST_PROXY]);
  app.disable("x-powered-by");
  app.enableShutdownHooks();
  return app;
}
