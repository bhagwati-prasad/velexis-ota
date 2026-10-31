// Tenant resolution (OADR-0009 point 2, ota/docs/architecture.md §3.1, ADR-0018): the tenant and the environment of a
// classified caller, read through the platform caches (platform-cache.ts). The tenant guard (common/auth/
// tenant.guard.ts) runs it for every operation an edge, key or service caller reaches.
//
//   edge  X-Velexis-Host = <key>.<STOREFRONT_BASE_DOMAIN>  → tenantkey:<key> → the tenant, whatever its status:
//                                                            active is served; any other status is
//                                                            403 TENANT_SUSPENDED (the storefront shows its
//                                                            "temporarily unavailable" page, PADR-0014 point 5)
//         any other host                                   → host:<hostname> → a verified tenant_domains row with
//                                                            purpose storefront, of an active tenant only
//         environment: tenants.storefront_environment
//   key   the key's tenant (tenant:<id>), active only       environment: the key's
//   service the tenant the guard located (the staff token's tid, the portal token's or the refresh token's family's
//         tenant; OBE-060), tenant:<id>, active only          environment: X-Velexis-Environment (the permission
//                                                            guard checks that live is open to the tenant)
//
// An unknown host, an unverified or other-purpose domain, and a custom domain of a tenant that is not active all
// answer `403 HOST_NOT_ALLOWED` (`details.reason: unknown`), so nothing about the tenant behind a host leaks. A host
// that cannot be a host name is refused without a lookup. Unknown hosts and keys are cached as such for 10 s.
//
// The live environment (OBE-081, ADR-0018 "Environment"): the edge's environment is read with the tenant row itself
// (`tenant:<id>`; `tenantkey:` and `host:` hold only the id), so when the platform's goLive (PBE-061) sets
// `storefront_environment = live` and publishes the `tenant` invalidation, the next edge request of every host of the
// tenant is live, within a second, and at the latest when the cached row expires (60 s). From then on the edge's
// searches, prices, checkouts, payments and bookings are `live` rows made through the live Amadeus connection and the
// live payment connection (`conn:<kind>:<tenantId>:live`), and the storefront's reads (searches, priced offers,
// checkouts, payments, the booking access guard, the guest lookup, a customer's trips) filter by the request's
// environment, so the test rows answer `404` there. The console's `live` (the OTA admin's header) is open only to a
// live tenant and a role other than viewer: the permission guard checks it (common/auth/permission.guard.ts).
// test/integration/tenancy/live-environment.int.test.ts proves the switch end to end.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isTenantSchema } from "@velexis/db";
import { AppError } from "@velexis/errors";
import { PinoLogger } from "nestjs-pino";
import type { ApiConfig } from "../config";
import type { EdgeCaller, KeyCaller, ServiceCaller } from "./caller-resolver";
import { PlatformCache } from "./platform-cache";
import { STOREFRONT_HOST_PATTERN } from "./platform-read.repository";
import type { PlatformTenant } from "./platform-read.types";
import type { TenantEnvironment } from "./tenant-context";

/** The tenant of a request and the environment it acts in. */
export interface ResolvedTenant {
  readonly tenant: PlatformTenant;
  readonly environment: TenantEnvironment;
}

/** Why an edge host was refused (debug log only). */
type HostRefusal = "not_a_host_name" | "not_a_tenant_key" | "unknown" | "tenant_not_active";

@Injectable()
export class TenantResolver {
  /** `.<STOREFRONT_BASE_DOMAIN>`: the suffix of the tenants' storefront sub-domains. */
  private readonly subdomainSuffix: string;

  constructor(
    config: ConfigService<ApiConfig, true>,
    private readonly cache: PlatformCache,
    private readonly logger: PinoLogger,
  ) {
    this.subdomainSuffix = `.${config.get("STOREFRONT_BASE_DOMAIN", { infer: true })}`;
    logger.setContext(TenantResolver.name);
  }

  /**
   * The tenant and environment of an edge or key caller. Throws `AppError` `HOST_NOT_ALLOWED` (403),
   * `TENANT_SUSPENDED` (403), `INVALID_API_KEY` (401, a key whose tenant row is gone) or `SERVICE_UNAVAILABLE` (503,
   * PostgreSQL unreachable on a cache miss).
   */
  async resolve(caller: EdgeCaller | KeyCaller): Promise<ResolvedTenant> {
    return caller.type === "edge" ? this.resolveHost(caller.host) : this.resolveKey(caller);
  }

  /**
   * The tenant `tenantId` of a service request (OBE-060) in `environment`: active only (`403 TENANT_SUSPENDED`); a
   * tenant that is not there is `401 UNAUTHENTICATED` (the staff credential that named it cannot be of this platform),
   * `503 SERVICE_UNAVAILABLE` when PostgreSQL cannot be read on a cache miss.
   */
  async resolveService(
    _caller: ServiceCaller,
    tenantId: string,
    environment: TenantEnvironment,
  ): Promise<ResolvedTenant> {
    const tenant = await this.cache.tenantById(tenantId);
    if (tenant === null) {
      this.logger.warn({ tenantId }, "tenant.service_tenant_missing");
      throw new AppError("UNAUTHENTICATED");
    }
    if (tenant.status !== "active") {
      throw new AppError("TENANT_SUSPENDED");
    }
    return { tenant, environment };
  }

  private async resolveHost(host: string): Promise<ResolvedTenant> {
    if (host.endsWith(this.subdomainSuffix)) {
      const tenantKey = host.slice(0, -this.subdomainSuffix.length);
      // One label that can be a tenant key; `a.b.<base>` and `<base>` itself are no tenant's sub-domain.
      if (!isTenantSchema(`tenant_${tenantKey}`)) {
        throw this.refuseHost("not_a_tenant_key");
      }
      const tenant = await this.cache.tenantByKey(tenantKey);
      if (tenant === null) {
        throw this.refuseHost("unknown");
      }
      if (tenant.status !== "active") {
        throw new AppError("TENANT_SUSPENDED");
      }
      return { tenant, environment: tenant.storefrontEnvironment };
    }
    if (!STOREFRONT_HOST_PATTERN.test(host)) {
      throw this.refuseHost("not_a_host_name");
    }
    const tenant = await this.cache.tenantByStorefrontHost(host);
    if (tenant === null) {
      throw this.refuseHost("unknown");
    }
    // Custom domains are served for active tenants only (PADR-0014 point 5).
    if (tenant.status !== "active") {
      throw this.refuseHost("tenant_not_active");
    }
    return { tenant, environment: tenant.storefrontEnvironment };
  }

  private async resolveKey(caller: KeyCaller): Promise<ResolvedTenant> {
    const tenant = await this.cache.tenantById(caller.tenantId);
    if (tenant === null) {
      // api_keys.tenant_id references tenants: a key without its tenant is a platform inconsistency.
      this.logger.warn({ keyId: caller.keyId }, "tenant.key_tenant_missing");
      throw new AppError("INVALID_API_KEY");
    }
    if (tenant.status !== "active") {
      throw new AppError("TENANT_SUSPENDED");
    }
    return { tenant, environment: caller.environment };
  }

  private refuseHost(reason: HostRefusal): AppError {
    // Debug only: hosts come from clients (Caddy forwards their Host header), and scans would flood the log.
    this.logger.debug({ reason }, "tenant.host_refused");
    return new AppError("HOST_NOT_ALLOWED", {
      message: "X-Velexis-Host is not a storefront host of an active OTA.",
      details: { reason: "unknown" },
    });
  }
}
