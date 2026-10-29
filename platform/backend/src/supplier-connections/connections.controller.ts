// The Amadeus connection routes of the portal (platform/docs/api-inventory-resources.md §3; scope §1.2 "See Amadeus and
// payment connections (masked)", PF-53): `listAmadeusConnections` since PBE-027 and `updateAmadeusConnection` since
// PBE-040. Thin: each handler binds its operation, reads the validated request and makes one ConnectionsService call.
//
// - `listAmadeusConnections`: owners, admins and finance members see the OTA's `test` and `live` connections. The rows
//   are read without the client secret's ciphertext and mapped by `toAmadeusConnection`, which answers the OTA's own
//   `clientId` but never a secret; `pendingSubmission` stays `null` until the M5 credential submissions (PBE-052,
//   PBE-053).
// - `updateAmadeusConnection` (`PATCH …/amadeus-connections/{environment}`, `If-Match`): owners and admins change the
//   office defaults, the ticketing defaults and the monitored queues (connections.service.ts); the answer is the
//   connection as the list maps it, with its new version in `ETag`.
//
// TenantRoleGuard answers `404` to non-members and `403` to the other roles before a handler runs.
import { Controller, Get, Patch, Res } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import type { AmadeusEnvironment } from "./amadeus-accounts.repository";
import { ConnectionsService, type UpdateAmadeusConnectionRequest } from "./connections.service";
import { toAmadeusConnection, type AmadeusConnection } from "./supplier-connections.repository";

export type AmadeusConnectionList = components["schemas"]["AmadeusConnectionList"];

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller("v1/tenants/:tenantId/amadeus-connections")
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  @OpenApiOperation("listAmadeusConnections")
  @TenantRoles(...tenantRolesOf("listAmadeusConnections"))
  async listAmadeusConnections(
    @CurrentMembership() membership: TenantMembership,
  ): Promise<AmadeusConnectionList> {
    const rows = await this.connections.list(membership.tenantId);
    return { data: rows.map(toAmadeusConnection) };
  }

  @Patch(":environment")
  @OpenApiOperation("updateAmadeusConnection")
  @TenantRoles(...tenantRolesOf("updateAmadeusConnection"))
  async updateAmadeusConnection(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
    @Validated("header") header: Readonly<Record<string, unknown>>,
    @Validated("body") body: UpdateAmadeusConnectionRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AmadeusConnection> {
    const row = await this.connections.updateSettings(
      membership,
      path["environment"] as AmadeusEnvironment,
      versionOfIfMatch(header["if-match"] as string),
      body,
    );
    res.setHeader("ETag", etagOf(row.version));
    return toAmadeusConnection(row);
  }
}
