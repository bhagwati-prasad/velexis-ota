// The Amadeus connection routes of the portal (platform/docs/api-inventory-resources.md §3; scope §1.2 "See Amadeus and
// payment connections (masked)"): `listAmadeusConnections` since PBE-027. Owners, admins and finance members see the
// OTA's `test` and `live` connections; TenantRoleGuard answers `404` to non-members and `403` to the other roles before
// the handler runs. The rows are read without the client secret's ciphertext and mapped by `toAmadeusConnection`,
// which answers the OTA's own `clientId` but never a secret; `pendingSubmission` stays `null` until the M5 credential
// submissions (PBE-052, PBE-053). The settings update comes with M4 (PBE-040).
import { Controller, Get } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import { SupplierConnectionsRepository, toAmadeusConnection } from "./supplier-connections.repository";

export type AmadeusConnectionList = components["schemas"]["AmadeusConnectionList"];

@Controller("v1/tenants/:tenantId/amadeus-connections")
export class ConnectionsController {
  constructor(private readonly connections: SupplierConnectionsRepository) {}

  @Get()
  @OpenApiOperation("listAmadeusConnections")
  @TenantRoles(...tenantRolesOf("listAmadeusConnections"))
  async listAmadeusConnections(
    @CurrentMembership() membership: TenantMembership,
  ): Promise<AmadeusConnectionList> {
    const rows = await this.connections.listForTenant(membership.tenantId);
    return { data: rows.map(toAmadeusConnection) };
  }
}
