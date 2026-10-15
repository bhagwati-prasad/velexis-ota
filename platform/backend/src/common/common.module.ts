// CommonModule (platform/docs/architecture.md §2.1, layer 0): the cross-cutting pieces of the API's request pipeline
// (§3) and the injectable time and ids every module uses. Global, so other modules inject `Clock`, `IdGenerator` and
// `RequestContext` without importing it; AppModule imports it once with `CommonModule.forApi()`. Later tasks add the
// Redis client, the queues, the idempotency store and the Stripe pieces here (PBE-009 and on).
import { Global, Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, DiscoveryModule } from "@nestjs/core";
import { ClsMiddleware } from "nestjs-cls";
import { Clock } from "./clock";
import { EndUserMiddleware } from "./http/end-user";
import { ErrorFilter } from "./http/error.filter";
import { OpenApiValidationInterceptor, PlatformOpenApi } from "./http/openapi-validation.interceptor";
import { jsonBodyParser } from "./http/raw-body";
import { RequestContext, requestContextModule } from "./http/request-context";
import { IdGenerator } from "./ids";

/**
 * The request middleware of the API, in order, mounted on every route by AppModule. pino-http (nestjs-pino's global
 * LoggerModule) runs before all of them, so even a request whose body cannot be read has a request id and a log line:
 *
 * 1. the JSON body parser, with the raw body kept on `/webhooks/*` only (raw-body.ts);
 * 2. the request context (nestjs-cls), whose id is pino-http's request id (request-context.ts);
 * 3. the end user's IP and user agent (end-user.ts, PADR-0019).
 *
 * `helmet` and `cookie-parser` run before pino-http (main.ts). Guards, the validation interceptor, the handler and
 * the error filter follow.
 */
export const API_REQUEST_MIDDLEWARE = [jsonBodyParser, ClsMiddleware, EndUserMiddleware] as const;

@Global()
@Module({})
export class CommonModule {
  /** The API's common providers, with the global error filter and validation interceptor. */
  static forApi(): DynamicModule {
    return {
      module: CommonModule,
      imports: [DiscoveryModule, requestContextModule()],
      providers: [
        Clock,
        IdGenerator,
        RequestContext,
        { provide: PlatformOpenApi, useFactory: () => PlatformOpenApi.load() },
        { provide: APP_INTERCEPTOR, useClass: OpenApiValidationInterceptor },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
      exports: [Clock, IdGenerator, RequestContext, PlatformOpenApi],
    };
  }
}
