// The invitation routes of the portal (platform/docs/api-inventory.md §8, PBE-026): the invitations of an OTA under
// `/v1/tenants/{tenantId}/invitations` (list, create, resend, revoke; owners and admins, `manageStaff` of the role
// matrix, so TenantRoleGuard answers `404` to non-members before a handler runs), and the two routes of the accept page
// under `/v1/invitations`: `lookupInvitation` (public, 20 per end-user IP per hour, the operation's throttler) and
// `acceptInvitation` (a verified portal account). Thin: each handler binds its operation, reads the validated request
// and makes one service call. The token travels in the body only, never in a URL, and nothing here logs a body.
import { Controller, Delete, Get, HttpCode, Post } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  InvitationsService,
  type CreateInvitationRequest,
  type Invitation,
  type InvitationAccepted,
  type InvitationList,
  type InvitationPreview,
  type InvitationTokenRequest,
} from "./invitations.service";
import { tenantRolesOf } from "./tenant-roles";

@Controller("v1/tenants/:tenantId/invitations")
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @OpenApiOperation("listInvitations")
  @TenantRoles(...tenantRolesOf("listInvitations"))
  listInvitations(@CurrentMembership() membership: TenantMembership): Promise<InvitationList> {
    return this.invitations.list(membership);
  }

  @Post()
  @HttpCode(201)
  @OpenApiOperation("createInvitation")
  @TenantRoles(...tenantRolesOf("createInvitation"))
  createInvitation(
    @CurrentMembership() membership: TenantMembership,
    @Validated("body") body: CreateInvitationRequest,
  ): Promise<Invitation> {
    return this.invitations.create(membership, body);
  }

  /** `202` without a body: the e-mail with the new link is queued. */
  @Post(":invitationId/resend")
  @HttpCode(202)
  @OpenApiOperation("resendInvitation")
  @TenantRoles(...tenantRolesOf("resendInvitation"))
  resendInvitation(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.invitations.resend(membership, path["invitationId"] as string);
  }

  @Delete(":invitationId")
  @HttpCode(204)
  @OpenApiOperation("revokeInvitation")
  @TenantRoles(...tenantRolesOf("revokeInvitation"))
  revokeInvitation(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.invitations.revoke(membership, path["invitationId"] as string);
  }
}

@Controller("v1/invitations")
export class InvitationAcceptanceController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post("lookup")
  @HttpCode(200)
  @OpenApiOperation("lookupInvitation")
  lookupInvitation(@Validated("body") body: InvitationTokenRequest): Promise<InvitationPreview> {
    return this.invitations.lookup(body.token);
  }

  @Post("accept")
  @HttpCode(200)
  @OpenApiOperation("acceptInvitation")
  acceptInvitation(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: InvitationTokenRequest,
  ): Promise<InvitationAccepted> {
    return this.invitations.accept(token.sub, body.token);
  }
}
