// The tenant routes of the platform admin (platform/docs/api-inventory-admin.md §3, flows/platform-admin-operations.md
// §B; scope PF-81): the OTA search, the control-plane view of one OTA and the edit of its internal notes and legal name
// (PBE-029). The lifecycle actions (suspend, resume, migrate, connection status) join them with PBE-030. Every
// operation is `x-scope: platform_admin`, so AdminAuthGuard checks the admin token and re-reads the account first.
// Thin: each handler binds its operation, reads the validated request and makes one AdminTenantsService call; the
// versioned answers carry the tenant's version in `ETag`, which adminUpdateTenant takes back in `If-Match`.
import { Controller, Get, Patch, Res } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  AdminTenantsService,
  type AdminTenant,
  type AdminTenantDetail,
  type AdminTenantList,
  type ListAdminTenantsQuery,
  type UpdateAdminTenantRequest,
} from "./admin-tenants.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

type RequestParameters = Readonly<Record<string, unknown>>;

@Controller("v1/admin/tenants")
export class AdminTenantsController {
  constructor(private readonly tenants: AdminTenantsService) {}

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
}
