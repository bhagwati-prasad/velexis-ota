// The API's module graph (README §2, platform/docs/architecture.md §2.1). main.ts creates it with the validated
// configuration and the process logger; tests create it the same way, with their own log destination and, for
// request pipeline tests, extra controllers in a module that imports `AppModule.forRoot(…)` (test/support/app.ts).
import {
  Module,
  RequestMethod,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { pinoHttpOptions, type Logger } from "@velexis/logger";
import { LoggerModule } from "nestjs-pino";
import { API_REQUEST_MIDDLEWARE, CommonModule } from "./common/common.module";
import { configModule, PLATFORM_PROCESSES, type PlatformBackendConfig } from "./config";
import { HealthModule } from "./health/health.module";

/** Every route of the application, in the path-to-regexp 8 syntax of NestJS 11 (`*` alone is deprecated). */
export const ALL_ROUTES = { path: "{*path}", method: RequestMethod.ALL };

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
        // The request pipeline (body parser, request context, end-user IP, validation, error filter), Clock and ids.
        CommonModule.forApi(),
        HealthModule.forApi(logger),
      ],
    };
  }

  /**
   * Mounts the request middleware of CommonModule on every route, in its order. The middleware of global modules
   * (nestjs-pino's LoggerModule) runs before the middleware of this root module, so pino-http has set `req.id` when
   * the request context takes it.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(...API_REQUEST_MIDDLEWARE).forRoutes(ALL_ROUTES);
  }
}
