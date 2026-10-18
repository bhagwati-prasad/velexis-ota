// CommonModule (platform/docs/architecture.md §2.1, layer 0): the cross-cutting pieces of the API's request pipeline
// (§3) and the injectable time and ids every module uses. Global, so other modules inject `Clock`, `IdGenerator`,
// `RequestContext`, `TokenService`, `FeatureSwitches`, the database (`PLATFORM_DB`) and the envelope encryption
// (`EnvelopeService`, PBE-011) without importing it; AppModule imports it once with `CommonModule.forApi()`. It brings
// the process's Redis connections and the InvalidationPublisher (RedisModule, global), the rate limits and the
// idempotency interceptor (PBE-009), and the API's `vx:invalidate` subscriber, which hands each event to the caches of
// the API marked `@InvalidationListener()` (PBE-027). The worker imports `CommonModule.forWorker()`: Clock, ids, the
// worker's own pool and the envelope encryption, without the request pipeline; a CLI command `CommonModule.forCli()`,
// the same with the CLI's own small pool (PBE-028). Later tasks add the Stripe pieces here. TenantRoleGuard's
// membership read (`TenantMembershipLookup`) comes from the global MembershipsModule, which AppModule imports next to
// it (PBE-017).
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
import { TenantRoleGuard } from "./auth/tenant-role.guard";
import { Clock } from "./clock";
import { cryptoProviders, EnvelopeService } from "./crypto.provider";
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
import { InvalidationSubscriber } from "./redis/invalidation.subscriber";
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
 * 4. TenantRoleGuard for `@TenantRoles(...)`: the caller's active membership of `{tenantId}` (step 6, PBE-017), so a
 *    non-member gets `404` before any step-up or switch says anything about the operation;
 * 5. RecentMfaGuard for `x-mfa-step-up`;
 * 6. FeatureGuard for `x-feature`.
 *
 * The Stripe signature guard of the `webhook` scope (M5) goes with the auth guards.
 */
export const API_GUARDS = [
  RateLimitGuard,
  InternalOnlyGuard,
  PortalAuthGuard,
  AdminAuthGuard,
  AccountRateLimitGuard,
  TenantRoleGuard,
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
        ...platformDatabaseProviders("api"),
        ...cryptoProviders(),
        { provide: PlatformOpenApi, useFactory: () => PlatformOpenApi.load() },
        {
          provide: OperationPolicies,
          inject: [PlatformOpenApi],
          useFactory: (api: PlatformOpenApi) => new OperationPolicies(api),
        },
        TokenService,
        FeatureSwitches,
        AccountAuthStates,
        InvalidationSubscriber,
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
        EnvelopeService,
        PlatformOpenApi,
        OperationPolicies,
        TokenService,
        FeatureSwitches,
        AccountAuthStates,
      ],
    };
  }

  /**
   * The worker's common providers (WorkerModule): Clock, ids, the worker's pool of velexis_platform_app (5
   * connections, `application_name` platform-worker) and the envelope encryption. No request pipeline: the worker
   * serves no API.
   */
  static forWorker(): DynamicModule {
    return {
      module: CommonModule,
      imports: [RedisModule],
      providers: [Clock, IdGenerator, ...platformDatabaseProviders("worker"), ...cryptoProviders()],
      exports: [Clock, IdGenerator, PLATFORM_DB, EnvelopeService],
    };
  }

  /**
   * The common providers of a CLI command's application context (dist/cli.js, PBE-028): those of the worker, with a
   * pool of 2 connections whose `application_name` is platform-cli.
   */
  static forCli(): DynamicModule {
    return {
      module: CommonModule,
      imports: [RedisModule],
      providers: [Clock, IdGenerator, ...platformDatabaseProviders("cli"), ...cryptoProviders()],
      exports: [Clock, IdGenerator, PLATFORM_DB, EnvelopeService],
    };
  }
}
