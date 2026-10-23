// MembershipsModule (platform/docs/architecture.md §2.1, layer 1): owns `tenant_memberships` and
// `tenant_invitations`, the role matrix (tenant-roles.ts), the team routes (members.controller.ts: list, role changes,
// removals, PBE-025), the invitations (invitations.controller.ts: invite, list, resend, revoke, look up and accept,
// PBE-026), and the console token of the OTA admin's single sign-on (ConsoleTokenController of members.controller.ts and
// console-token.service.ts, PBE-039; the token lives in Redis only). It imports AuditModule for the audit rows of its
// changes and NotificationsModule for the invitation e-mails (layer 0). The worker imports
// `MembershipsModule.forWorker()` (below).
//
// It is global for one reason: TenantRoleGuard, a global guard of CommonModule (layer 0) that must run between the
// auth guards and RecentMfaGuard (API_GUARDS), reads the caller's membership on every tenant request through the
// abstract `TenantMembershipLookup`, which this module provides with its repository. It also exports the two
// repositories for the modules of a higher layer, which import MembershipsModule for them (ProvisioningModule writes
// the owner membership of a new OTA, PBE-018; the platform admin's tenant detail reads the members and the pending
// invitations, PBE-029); modules of the same layer never use them (layering rule of architecture §2.2).
import { Global, Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { TenantMembershipLookup } from "../common/auth/tenant-role.guard";
import { NotificationsModule } from "../notifications/notifications.module";
import { InvitationsExpireScheduler } from "./invitations-expire.scheduler";
import { InvitationAcceptanceController, InvitationsController } from "./invitations.controller";
import { InvitationsRepository } from "./invitations.repository";
import { InvitationsService } from "./invitations.service";
import { ConsoleTokenService } from "./console-token.service";
import { ConsoleTokenController, MembersController } from "./members.controller";
import { MembersService } from "./members.service";
import { MembershipsRepository } from "./memberships.repository";

/**
 * The worker's part of MembershipsModule (`MembershipsModule.forWorker()`): the `invitations.expire` handler of the
 * `platform-maintenance` processor and the repository it needs, in a module of their own, so the worker gets none of
 * the portal routes, the e-mail queueing or the global membership lookup of the API.
 */
@Module({
  imports: [AuditModule],
  providers: [InvitationsRepository, InvitationsExpireScheduler],
})
export class MembershipsWorkerModule {}

@Global()
@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [
    MembersController,
    ConsoleTokenController,
    InvitationsController,
    InvitationAcceptanceController,
  ],
  providers: [
    MembershipsRepository,
    MembersService,
    ConsoleTokenService,
    InvitationsRepository,
    InvitationsService,
    { provide: TenantMembershipLookup, useExisting: MembershipsRepository },
  ],
  exports: [TenantMembershipLookup, MembershipsRepository, InvitationsRepository],
})
export class MembershipsModule {
  /** The module with the `invitations.expire` handler of the `platform-maintenance` processor, for WorkerModule. */
  static forWorker(): DynamicModule {
    return { module: MembershipsWorkerModule };
  }
}
