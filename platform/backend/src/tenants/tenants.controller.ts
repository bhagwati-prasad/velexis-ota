// The tenant routes of the portal (platform/docs/api-inventory.md §7, PBE-017): the key check of the create-OTA
// wizard, the caller's OTAs, the OTA overview and the profile update. Thin: each handler binds its operation, reads
// the validated request and makes one service call. Tenant routes declare their roles from the matrix
// (memberships/tenant-roles.ts); TenantRoleGuard answers `404` to non-members before the handler runs.
import { Controller, Get, Patch, Res } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import {
  etagOf,
  TenantsService,
  versionOfIfMatch,
  type KeyAvailability,
  type Tenant,
  type TenantList,
  type UpdateTenantRequest,
} from "./tenants.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller("v1/tenants")
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  // Declared before `:tenantId`, so Express never takes `key-availability` for a tenant id.
  @Get("key-availability")
  @OpenApiOperation("checkTenantKey")
  checkTenantKey(@Validated("query") query: Readonly<Record<string, unknown>>): Promise<KeyAvailability> {
    return this.tenants.checkKey(query["key"] as string);
  }

  @Get()
  @OpenApiOperation("listTenants")
  listTenants(@AccessToken() token: AccessTokenClaims): Promise<TenantList> {
    return this.tenants.list(token.sub);
  }

  @Get(":tenantId")
  @OpenApiOperation("getTenant")
  @TenantRoles(...tenantRolesOf("getTenant"))
  async getTenant(
    @CurrentMembership() membership: TenantMembership,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<Tenant> {
    const tenant = await this.tenants.get(membership);
    res.setHeader("ETag", etagOf(tenant.version));
    return tenant;
  }

  @Patch(":tenantId")
  @OpenApiOperation("updateTenant")
  @TenantRoles(...tenantRolesOf("updateTenant"))
  async updateTenant(
    @CurrentMembership() membership: TenantMembership,
    @Validated("header") header: Readonly<Record<string, unknown>>,
    @Validated("body") body: UpdateTenantRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<Tenant> {
    const tenant = await this.tenants.update(
      membership,
      versionOfIfMatch(header["if-match"] as string),
      body,
    );
    res.setHeader("ETag", etagOf(tenant.version));
    return tenant;
  }
}
