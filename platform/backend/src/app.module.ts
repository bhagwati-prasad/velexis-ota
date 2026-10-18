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
import { AccountsModule } from "./accounts/accounts.module";
import { AdminModule } from "./admin/admin.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AuthModule } from "./auth/auth.module";
import { BillingModule } from "./billing/billing.module";
import { API_REQUEST_MIDDLEWARE, CommonModule } from "./common/common.module";
import { configModule, PLATFORM_PROCESSES, type PlatformBackendConfig } from "./config";
import { DomainsModule } from "./domains/domains.module";
import { HealthModule } from "./health/health.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { PaymentConnectionsModule } from "./payment-connections/payment-connections.module";
import { ProvisioningModule } from "./provisioning/provisioning.module";
import { TenantsModule } from "./tenants/tenants.module";

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
        // Global: provides TenantRoleGuard's membership read (TenantMembershipLookup) to CommonModule's guards.
        MembershipsModule,
        HealthModule.forApi(logger),
        AuthModule,
        // Global: provides AuthController's MFA steps (MfaVerification) with its MfaService.
        AccountsModule,
        TenantsModule,
        BillingModule,
        ApiKeysModule.forApi(),
        // The domain list and Caddy's TLS `ask` endpoint, whose cache listens to `vx:invalidate` (PBE-027).
        DomainsModule.forApi(),
        PaymentConnectionsModule.forApi(),
        ProvisioningModule.forApi(),
        // The platform admin's controllers over the services of the modules above (layer 4).
        AdminModule,
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
