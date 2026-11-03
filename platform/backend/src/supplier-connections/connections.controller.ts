// The Amadeus connection routes of the portal (platform/docs/api-inventory-resources.md §3; scope §1.2 "See Amadeus and
// payment connections (masked)", PF-51, PF-52, PF-53): `listAmadeusConnections` since PBE-027,
// `updateAmadeusConnection` since PBE-040, `submitAmadeusCredentials` since PBE-053 and `requestLiveAmadeus` since
// PBE-054. Thin: each handler binds its operation, reads the validated request and makes one service call.
//
// - `listAmadeusConnections`: owners, admins and finance members see the OTA's `test` and `live` connections. The rows
//   are read without the client secret's ciphertext and mapped by `toAmadeusConnection`, which answers the OTA's own
//   `clientId` but never a secret; `pendingSubmission` is the latest submission of own credentials of the environment
//   while it is open or after it failed (AmadeusCredentialsService.listConnections, PBE-053).
// - `updateAmadeusConnection` (`PATCH …/amadeus-connections/{environment}`, `If-Match`): owners and admins change the
//   office defaults, the ticketing defaults and the monitored queues (connections.service.ts); the answer is the
//   connection as the list maps it, with its `pendingSubmission` (AmadeusCredentialsService.connectionOf;
//   FIX-W39-PLATFORM, lead decision (2k) of 2026-11-02) and its new version in `ETag`.
// - `submitAmadeusCredentials` (`PUT …/amadeus-connections/{environment}/credentials`): owners and admins with a TOTP
//   step-up (RecentMfaGuard) while `FEATURE_OWN_AMADEUS` is on (FeatureGuard) submit the OTA's own client id, client
//   secret and offices; the answer is `202 {submission}`, `pending` until the worker verifies it
//   (amadeus-credentials.service.ts, amadeus-credentials.verifier.ts). The secret is never answered or logged.
// - `requestLiveAmadeus` (`POST …/amadeus-connections/live/request`, since PBE-054): owners ask Velexis for a live
//   office while `FEATURE_LIVE_SWITCH` is on (FeatureGuard); the answer is `202` with the live connection, waiting for
//   an office, with its `pendingSubmission` (live-office.service.ts). The optional body holds a note for ops.
//
// TenantRoleGuard answers `404` to non-members and `403` to the other roles before a handler runs.
import { Controller, Get, HttpCode, Patch, Post, Put, Res } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import type { AmadeusEnvironment } from "./amadeus-accounts.repository";
import {
  AmadeusCredentialsService,
  type CredentialSubmissionAccepted,
  type SubmitAmadeusCredentialsRequest,
} from "./amadeus-credentials.service";
import { ConnectionsService, type UpdateAmadeusConnectionRequest } from "./connections.service";
import { LiveOfficeService, type RequestLiveAmadeusRequest } from "./live-office.service";
import type { AmadeusConnection } from "./supplier-connections.repository";

export type AmadeusConnectionList = components["schemas"]["AmadeusConnectionList"];

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller("v1/tenants/:tenantId/amadeus-connections")
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly credentials: AmadeusCredentialsService,
    private readonly liveOffices: LiveOfficeService,
  ) {}

  @Get()
  @OpenApiOperation("listAmadeusConnections")
  @TenantRoles(...tenantRolesOf("listAmadeusConnections"))
  async listAmadeusConnections(
    @CurrentMembership() membership: TenantMembership,
  ): Promise<AmadeusConnectionList> {
    return { data: await this.credentials.listConnections(membership.tenantId) };
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
    return this.credentials.connectionOf(membership.tenantId, row);
  }

  @Put(":environment/credentials")
  @HttpCode(202)
  @OpenApiOperation("submitAmadeusCredentials")
  @TenantRoles(...tenantRolesOf("submitAmadeusCredentials"))
  submitAmadeusCredentials(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
    @Validated("body") body: SubmitAmadeusCredentialsRequest,
  ): Promise<CredentialSubmissionAccepted> {
    return this.credentials.submit(membership, path["environment"] as AmadeusEnvironment, body);
  }

  @Post("live/request")
  @HttpCode(202)
  @OpenApiOperation("requestLiveAmadeus")
  @TenantRoles(...tenantRolesOf("requestLiveAmadeus"))
  requestLiveAmadeus(
    @CurrentMembership() membership: TenantMembership,
    @Validated("body") body: RequestLiveAmadeusRequest | undefined,
  ): Promise<AmadeusConnection> {
    return this.liveOffices.requestLive(membership, body);
  }
}
