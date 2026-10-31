// The domain routes of the portal (platform/docs/api-inventory-resources.md §2): `listDomains` since PBE-027; adding,
// making primary and removing a custom domain since PBE-049; checking one comes with PBE-050. Thin: each handler binds
// its operation, reads the validated request and makes one service call. Every member may list the domains
// (`viewOverview` of the role matrix); owners and admins manage them (`manageDomains`). TenantRoleGuard answers `404`
// to non-members and `403` to the other roles before the handler runs, and FeatureGuard answers `403
// FEATURE_DISABLED` to `addDomain` (`x-feature: custom_domains`) while FEATURE_CUSTOM_DOMAINS is off.
import { Controller, Delete, Get, HttpCode, Post } from "@nestjs/common";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import { DomainsService, type AddDomainRequest, type Domain, type DomainList } from "./domains.service";

@Controller("v1/tenants/:tenantId/domains")
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get()
  @OpenApiOperation("listDomains")
  @TenantRoles(...tenantRolesOf("listDomains"))
  listDomains(@CurrentMembership() membership: TenantMembership): Promise<DomainList> {
    return this.domains.list(membership);
  }

  @Post()
  @OpenApiOperation("addDomain")
  @TenantRoles(...tenantRolesOf("addDomain"))
  addDomain(
    @CurrentMembership() membership: TenantMembership,
    @Validated("body") body: AddDomainRequest,
  ): Promise<Domain> {
    return this.domains.add(membership, body);
  }

  @Post(":domainId/make-primary")
  @HttpCode(200)
  @OpenApiOperation("makeDomainPrimary")
  @TenantRoles(...tenantRolesOf("makeDomainPrimary"))
  makeDomainPrimary(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
  ): Promise<Domain> {
    return this.domains.makePrimary(membership, path["domainId"] as string);
  }

  @Delete(":domainId")
  @HttpCode(204)
  @OpenApiOperation("removeDomain")
  @TenantRoles(...tenantRolesOf("removeDomain"))
  removeDomain(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.domains.remove(membership, path["domainId"] as string);
  }
}
