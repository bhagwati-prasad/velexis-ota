// The API's module graph (README §2, platform/docs/architecture.md §2.1). main.ts creates it with the validated
// configuration and the process logger; tests create it the same way, with their own log destination and, for
// request pipeline tests, extra controllers in a module that imports `AppModule.forRoot(…)`.
import {
  Module,
  RequestMethod,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { pinoHttpOptions, REQUEST_ID_HEADER, resolveRequestId, type Logger } from "@velexis/logger";
import { ClsMiddleware, ClsModule } from "nestjs-cls";
import { LoggerModule } from "nestjs-pino";
import { configModule, PLATFORM_PROCESSES, type PlatformBackendConfig } from "./config";
import { HealthModule } from "./health/health.module";

/** Every route of the application, in the path-to-regexp 8 syntax of NestJS 11 (`*` alone is deprecated). */
export const ALL_ROUTES = { path: "{*path}", method: RequestMethod.ALL };

interface RequestWithId {
  readonly id?: unknown;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/**
 * The id of the request context: the one pino-http has already taken from a valid `X-Request-Id` or generated (and
 * returned in the response header), so the context, the log lines and the response agree. The fallback only runs if
 * the middleware order were broken; the integration test proves it is not.
 */
export function requestIdOf(req: RequestWithId): string {
  return typeof req.id === "string" ? req.id : resolveRequestId(req.headers[REQUEST_ID_HEADER]);
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: PlatformBackendConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        configModule(config),
        // One line per request with requestId, method, route, status and durationMs; never headers, query strings
        // or bodies; /health/* not logged (@velexis/logger, ADR-0016). PinoLogger writes through the request's
        // logger inside a request, so app lines carry the requestId too.
        LoggerModule.forRoot({
          pinoHttp: pinoHttpOptions({ app: PLATFORM_PROCESSES.api, logger }),
          forRoutes: [ALL_ROUTES],
        }),
        // The request context (AsyncLocalStorage, nestjs-cls). Its middleware is mounted by `configure` below, after
        // pino-http, so the context id is the request id.
        ClsModule.forRoot({
          global: true,
          middleware: { mount: false, generateId: true, idGenerator: requestIdOf },
        }),
        HealthModule.forApi(logger),
      ],
    };
  }

  /**
   * Mounts the request context on every route. The middleware of global modules (nestjs-pino's LoggerModule) runs
   * before the middleware of this module, so pino-http has set `req.id` when the context takes it.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ClsMiddleware).forRoutes(ALL_ROUTES);
  }
}
