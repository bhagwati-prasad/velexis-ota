// MembershipsModule (platform/docs/architecture.md §2.1, layer 1): owns `tenant_memberships` and
// `tenant_invitations`, the role matrix (tenant-roles.ts), the team routes (members.controller.ts: list, role changes,
// removals, PBE-025), and later the invitations and console token (PBE-026, PBE-036). It imports AuditModule for the
// audit rows of its changes.
//
// It is global for one reason: TenantRoleGuard, a global guard of CommonModule (layer 0) that must run between the
// auth guards and RecentMfaGuard (API_GUARDS), reads the caller's membership on every tenant request through the
// abstract `TenantMembershipLookup`, which this module provides with its repository. The module exports only that
// lookup; a module of a higher layer that needs the repository itself imports MembershipsModule (PBE-018), and
// modules of the same layer never use it (layering rule of architecture §2.2).
import { Global, Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { TenantMembershipLookup } from "../common/auth/tenant-role.guard";
import { MembersController } from "./members.controller";
import { MembersService } from "./members.service";
import { MembershipsRepository } from "./memberships.repository";

@Global()
@Module({
  imports: [AuditModule],
  controllers: [MembersController],
  providers: [
    MembershipsRepository,
    MembersService,
    { provide: TenantMembershipLookup, useExisting: MembershipsRepository },
  ],
  exports: [TenantMembershipLookup],
})
export class MembershipsModule {}
