// The tenant routes of the platform admin (platform/docs/api-inventory-admin.md §3, flows/platform-admin-operations.md
// §B; scope PF-81 and PF-82): the OTA search, the control-plane view of one OTA and the edit of its internal notes and
// legal name (PBE-029, AdminTenantsService), and the lifecycle actions (PBE-030): suspend and resume
// (ProvisioningModule's SuspensionService, PADR-0014), migrate (MigrateService) and the switch of a connection
// (SuspensionService). Every operation is `x-scope: platform_admin`, so AdminAuthGuard checks the admin token and
// re-reads the account first; the reasons of the **reason** operations were checked by the validation interceptor.
// Thin: each handler binds its operation, reads the validated request, makes one service call and maps its rows with
// the admin's mappers (`toAdminTenant`, `toAdminProvisioningJob`) or the portal's masked connection shapes
// (`toAmadeusConnection`, `toPaymentConnection`), as the tenant detail shows them. The versioned answers of the tenant
// views carry the tenant's version in `ETag`, which adminUpdateTenant takes back in `If-Match`.
import { Controller, Get, HttpCode, Patch, Post, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import type { PlatformBackendConfig } from "../config";
import { toPaymentConnection } from "../payment-connections/payment-connections.controller";
import { MigrateService } from "../provisioning/migrate.service";
import {
  SuspensionService,
  type ConnectionKind,
  type ConnectionTargetStatus,
  type TenantLifecycleResult,
} from "../provisioning/suspension.service";
import { toAmadeusConnection } from "../supplier-connections/supplier-connections.repository";
import { toAdminProvisioningJob, toAdminTenant } from "./admin-tenants.mapper";
import {
  AdminTenantsService,
  type AdminTenant,
  type AdminTenantDetail,
  type AdminTenantList,
  type ListAdminTenantsQuery,
  type UpdateAdminTenantRequest,
} from "./admin-tenants.service";

export type SuspendTenantRequest = components["schemas"]["SuspendTenantRequest"];
export type AdminReasonRequest = components["schemas"]["AdminReasonRequest"];
export type MigrateTenantRequest = components["schemas"]["MigrateTenantRequest"];
export type SetConnectionStatusRequest = components["schemas"]["SetConnectionStatusRequest"];
export type TenantLifecycleAccepted = components["schemas"]["TenantLifecycleAccepted"];
export type AdminProvisioningJobResult = components["schemas"]["AdminProvisioningJobResult"];
export type AdminConnection = components["schemas"]["AdminConnection"];

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

type RequestParameters = Readonly<Record<string, unknown>>;

@Controller("v1/admin/tenants")
export class AdminTenantsController {
  private readonly baseDomain: string;

  constructor(
    private readonly tenants: AdminTenantsService,
    private readonly suspensions: SuspensionService,
    private readonly migrations: MigrateService,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  @Get()
  @OpenApiOperation("adminListTenants")
  adminListTenants(@Validated("query") query: ListAdminTenantsQuery): Promise<AdminTenantList> {
    return this.tenants.list(query);
  }

  @Get(":tenantId")
  @OpenApiOperation("adminGetTenant")
  async adminGetTenant(
    @Validated("path") path: RequestParameters,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminTenantDetail> {
    const detail = await this.tenants.get(path["tenantId"] as string);
    res.setHeader("ETag", etagOf(detail.tenant.version));
    return detail;
  }

  @Patch(":tenantId")
  @OpenApiOperation("adminUpdateTenant")
  async adminUpdateTenant(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("header") header: RequestParameters,
    @Validated("body") body: UpdateAdminTenantRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminTenant> {
    const tenant = await this.tenants.update(
      token,
      path["tenantId"] as string,
      versionOfIfMatch(header["if-match"] as string),
      body,
    );
    res.setHeader("ETag", etagOf(tenant.version));
    return tenant;
  }

  @Post(":tenantId/suspend")
  @HttpCode(202)
  @OpenApiOperation("adminSuspendTenant")
  async adminSuspendTenant(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: SuspendTenantRequest,
  ): Promise<TenantLifecycleAccepted> {
    const result = await this.suspensions.suspend(path["tenantId"] as string, body.suspensionReason, {
      type: "platform_admin",
      accountId: token.sub,
      reason: body.reason,
    });
    return this.accepted(result);
  }

  @Post(":tenantId/resume")
  @HttpCode(202)
  @OpenApiOperation("adminResumeTenant")
  async adminResumeTenant(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AdminReasonRequest,
  ): Promise<TenantLifecycleAccepted> {
    const result = await this.suspensions.resume(path["tenantId"] as string, {
      type: "platform_admin",
      accountId: token.sub,
      reason: body.reason,
    });
    return this.accepted(result);
  }

  @Post(":tenantId/migrate")
  @HttpCode(202)
  @OpenApiOperation("adminMigrateTenant")
  async adminMigrateTenant(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: MigrateTenantRequest | undefined,
  ): Promise<AdminProvisioningJobResult> {
    const job = await this.migrations.request(path["tenantId"] as string, body?.targetVersion, token.sub);
    return { job: toAdminProvisioningJob(job) };
  }

  @Post(":tenantId/connections/:kind/:environment/status")
  @HttpCode(200)
  @OpenApiOperation("adminSetConnectionStatus")
  async adminSetConnectionStatus(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: SetConnectionStatusRequest,
  ): Promise<AdminConnection> {
    const result = await this.suspensions.setConnectionStatus(
      path["tenantId"] as string,
      {
        kind: path["kind"] as ConnectionKind,
        environment: path["environment"] as "test" | "live",
        status: body.status as ConnectionTargetStatus,
        reason: body.reason,
      },
      token.sub,
    );
    return result.kind === "amadeus"
      ? toAmadeusConnection(result.connection)
      : toPaymentConnection(result.connection);
  }

  /** The `202` answer of a suspend or resume. */
  private accepted(result: TenantLifecycleResult): TenantLifecycleAccepted {
    return {
      tenant: toAdminTenant(result.tenant, this.baseDomain),
      job: toAdminProvisioningJob(result.job),
    };
  }
}
