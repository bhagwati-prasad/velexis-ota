// The storefront hosts in the platform admin (PBE-051; platform/docs/api-inventory-admin.md §7 domain rows,
// flows/custom-domains.md step 8, flows/platform-admin-operations.md §G, scope PF-92), under `/v1/admin/domains`. Every
// operation is `x-scope: platform_admin`, so AdminAuthGuard checks the admin token and re-reads the account first. Thin:
// each handler binds its operation, reads the validated request and makes one call of DomainsModule's
// AdminDomainsService, which owns the rules.
//
// - `adminListDomains`: every host of every OTA, newest first, with the kind, verification status and TLS status
//   filters and a cursor.
// - `adminRecheckDomain` (`POST …/recheck`): queues the DNS check (by the host's status) and the TLS probe now and
//   answers `202` with no body before they run; `503 SERVICE_UNAVAILABLE` when a job cannot be queued.
// - `adminRemoveDomain` (`POST …/remove`, **reason**): removes an abusive custom domain of any OTA and answers `204`;
//   `409 CONFLICT` (`subdomain`) for an OTA's sub-domain. The request validation trims the reason before it counts its
//   5–500 characters (FIX-W35-PLATFORM).
import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  AdminDomainsService,
  type AdminDomainList,
  type ListAdminDomainsQuery,
} from "../domains/admin-domains.service";

type AdminReasonRequest = components["schemas"]["AdminReasonRequest"];

type RequestParameters = Readonly<Record<string, unknown>>;

@Controller("v1/admin/domains")
export class AdminDomainsController {
  constructor(private readonly domains: AdminDomainsService) {}

  @Get()
  @OpenApiOperation("adminListDomains")
  adminListDomains(@Validated("query") query: ListAdminDomainsQuery): Promise<AdminDomainList> {
    return this.domains.list(query);
  }

  @Post(":domainId/recheck")
  @HttpCode(202)
  @OpenApiOperation("adminRecheckDomain")
  async adminRecheckDomain(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
  ): Promise<void> {
    await this.domains.recheck(token, path["domainId"] as string);
  }

  @Post(":domainId/remove")
  @HttpCode(204)
  @OpenApiOperation("adminRemoveDomain")
  async adminRemoveDomain(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AdminReasonRequest,
  ): Promise<void> {
    await this.domains.remove(token, path["domainId"] as string, body.reason);
  }
}
