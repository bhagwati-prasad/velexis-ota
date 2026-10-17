// The team routes of the portal (platform/docs/api-inventory.md §8, PBE-025): the member list, role changes and
// removals. Thin: each handler binds its operation, reads the validated request and makes one service call. The roles
// come from the matrix (memberships/tenant-roles.ts): TenantRoleGuard answers `404` to non-members before a handler
// runs, and MembersService applies the rules finer than a role (who may touch owners and admins, leaving, the step-up
// of granting owner, the last owner). `If-Match` and `ETag` carry the member's version, with the helpers the tenant
// profile uses (common/http/if-match.ts), so this module imports nothing of TenantsModule (architecture §2.2).
import { Controller, Delete, Get, HttpCode, Patch, Res } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { MembersService, type Member, type MemberList, type UpdateMemberRequest } from "./members.service";
import { tenantRolesOf } from "./tenant-roles";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller("v1/tenants/:tenantId/members")
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @OpenApiOperation("listMembers")
  @TenantRoles(...tenantRolesOf("listMembers"))
  listMembers(@CurrentMembership() membership: TenantMembership): Promise<MemberList> {
    return this.members.list(membership);
  }

  @Patch(":memberId")
  @OpenApiOperation("updateMember")
  @TenantRoles(...tenantRolesOf("updateMember"))
  async updateMember(
    @CurrentMembership() membership: TenantMembership,
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: Readonly<Record<string, unknown>>,
    @Validated("header") header: Readonly<Record<string, unknown>>,
    @Validated("body") body: UpdateMemberRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<Member> {
    const member = await this.members.changeRole(
      membership,
      token,
      path["memberId"] as string,
      versionOfIfMatch(header["if-match"] as string),
      body.role,
    );
    res.setHeader("ETag", etagOf(member.version));
    return member;
  }

  @Delete(":memberId")
  @HttpCode(204)
  @OpenApiOperation("removeMember")
  @TenantRoles(...tenantRolesOf("removeMember"))
  removeMember(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.members.remove(membership, path["memberId"] as string);
  }
}
