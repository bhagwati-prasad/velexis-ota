// CommonModule (platform/docs/architecture.md §2.1, layer 0): the cross-cutting pieces of the API's request pipeline
// (§3) and the injectable time and ids every module uses. Global, so other modules inject `Clock`, `IdGenerator`,
// `RequestContext`, `TokenService`, `FeatureSwitches` and the database (`PLATFORM_DB`) without importing it; AppModule
// imports it once with `CommonModule.forApi()`. It brings the process's Redis connections and the
// InvalidationPublisher (RedisModule, global), the rate limits and the idempotency interceptor (PBE-009). Later tasks
// add the queues and the Stripe pieces here.
import { Global, Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from "@nestjs/core";
import { ClsMiddleware } from "nestjs-cls";
import { TokenService } from "../auth/token.service";
import { AccountAuthStates, AdminAuthGuard } from "./auth/admin-auth.guard";
import { OperationPolicies } from "./auth/decorators";
import { FeatureGuard } from "./auth/feature.guard";
import { InternalOnlyGuard } from "./auth/internal-only.guard";
import { PortalAuthGuard } from "./auth/portal-auth.guard";
import { RecentMfaGuard } from "./auth/recent-mfa.guard";
import { Clock } from "./clock";
import { PLATFORM_DB, platformDatabaseProviders } from "./database";
import { FeatureSwitches } from "./features";
import { EndUserMiddleware } from "./http/end-user";
import { ErrorFilter } from "./http/error.filter";
import { IdempotencyInterceptor } from "./http/idempotency.interceptor";
import { OpenApiValidationInterceptor, PlatformOpenApi } from "./http/openapi-validation.interceptor";
import { jsonBodyParser } from "./http/raw-body";
import { RequestContext, requestContextModule } from "./http/request-context";
import { AccountRateLimitGuard, RateLimitGuard, throttlerModule } from "./http/throttler.config";
import { IdGenerator } from "./ids";
import { RedisModule } from "./redis/redis.module";

/**
 * The request middleware of the API, in order, mounted on every route by AppModule. pino-http (nestjs-pino's global
 * LoggerModule) runs before all of them, so even a request whose body cannot be read has a request id and a log line:
 *
 * 1. the JSON body parser, with the raw body kept on `/webhooks/*` only (raw-body.ts);
 * 2. the request context (nestjs-cls), whose id is pino-http's request id (request-context.ts);
 * 3. the end user's IP and user agent (end-user.ts, PADR-0019).
 *
 * `helmet` and `cookie-parser` run before pino-http (main.ts). The guards of API_GUARDS, the validation interceptor,
 * the handler and the error filter follow.
 */
export const API_REQUEST_MIDDLEWARE = [jsonBodyParser, ClsMiddleware, EndUserMiddleware] as const;

/**
 * The global guards of the API, in the order they run (architecture §3, steps 4 to 8). Each acts only on the
 * handlers whose operation's policy names it (common/auth/decorators.ts, http/throttler.config.ts) and lets every
 * other one through:
 *
 * 1. RateLimitGuard: the `ip`, `email` and `domain` rate limits (step 4, PBE-009);
 * 2. the auth guard of the operation's `x-scope`: InternalOnlyGuard (`internal`), PortalAuthGuard
 *    (`portal_unverified`, `portal`) or AdminAuthGuard (`platform_admin`); `public` has none;
 * 3. AccountRateLimitGuard: the per-account rate limits, which need the account the auth guards put into the
 *    request context (PBE-009);
 * 4. RecentMfaGuard for `x-mfa-step-up`;
 * 5. FeatureGuard for `x-feature`.
 *
 * TenantRoleGuard (step 6, PBE-017) goes between 3 and 4, and the Stripe signature guard of the `webhook` scope (M5)
 * with the auth guards.
 */
export const API_GUARDS = [
  RateLimitGuard,
  InternalOnlyGuard,
  PortalAuthGuard,
  AdminAuthGuard,
  AccountRateLimitGuard,
  RecentMfaGuard,
  FeatureGuard,
] as const;

@Global()
@Module({})
export class CommonModule {
  /** The API's common providers, with the global guards, interceptors and error filter. */
  static forApi(): DynamicModule {
    return {
      module: CommonModule,
      imports: [DiscoveryModule, requestContextModule(), RedisModule, throttlerModule()],
      providers: [
        Clock,
        IdGenerator,
        RequestContext,
        ...platformDatabaseProviders(),
        { provide: PlatformOpenApi, useFactory: () => PlatformOpenApi.load() },
        {
          provide: OperationPolicies,
          inject: [PlatformOpenApi],
          useFactory: (api: PlatformOpenApi) => new OperationPolicies(api),
        },
        TokenService,
        FeatureSwitches,
        AccountAuthStates,
        // Nest runs global guards in the order they are provided (API_GUARDS above).
        ...API_GUARDS.map((guard) => ({ provide: APP_GUARD, useClass: guard })),
        // Global interceptors run in the order they are provided: validation (step 9), then idempotency (step 10).
        { provide: APP_INTERCEPTOR, useClass: OpenApiValidationInterceptor },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
      exports: [
        Clock,
        IdGenerator,
        RequestContext,
        PLATFORM_DB,
        PlatformOpenApi,
        OperationPolicies,
        TokenService,
        FeatureSwitches,
        AccountAuthStates,
      ],
    };
  }
}
