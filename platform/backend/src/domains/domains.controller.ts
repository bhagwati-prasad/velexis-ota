// The domain routes of the portal (platform/docs/api-inventory-resources.md §2): `listDomains` since PBE-027; adding,
// checking, making primary and removing a custom domain come with M5 (PBE-049, PBE-050). Thin: each handler binds its
// operation and makes one service call. Every member may list the domains (`viewOverview` of the role matrix);
// TenantRoleGuard answers `404` to non-members before the handler runs.
import { Controller, Get } from "@nestjs/common";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import { DomainsService, type DomainList } from "./domains.service";

@Controller("v1/tenants/:tenantId/domains")
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get()
  @OpenApiOperation("listDomains")
  @TenantRoles(...tenantRolesOf("listDomains"))
  listDomains(@CurrentMembership() membership: TenantMembership): Promise<DomainList> {
    return this.domains.list(membership);
  }
}
