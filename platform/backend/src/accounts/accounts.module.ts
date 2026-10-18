// AccountsModule (platform/docs/architecture.md §2.1, layer 1, next to AuthModule): the signed-in account's own
// settings. PBE-015 brings the MFA settings (mfa.controller.ts: set-up, enable, disable, recovery codes; MfaService,
// RecoveryCodesRepository) and the MFA steps of the sign-in and the step-up, which AuthController binds; PBE-016 adds
// the profile, the password change and the session list.
//
// It imports AuthModule for the account's repository, the MFA challenges, the sign-in and the sessions (AuthModule
// exports them for this module), AuditModule and NotificationsModule (layer 0). It is global for one reason:
// AuthController's verifyMfa and stepUp reach MfaService through the abstract `MfaVerification` of
// auth/mfa-challenge.store.ts, which this module provides, so AuthModule never imports AccountsModule (architecture
// §2.2, as MembershipsModule provides TenantMembershipLookup). Nothing else uses it as a global.
import { Global, Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { MfaVerification } from "../auth/mfa-challenge.store";
import { NotificationsModule } from "../notifications/notifications.module";
import { MfaController } from "./mfa.controller";
import { MfaService } from "./mfa.service";
import { RecoveryCodesRepository } from "./recovery-codes.repository";

@Global()
@Module({
  imports: [AuthModule, AuditModule, NotificationsModule],
  controllers: [MfaController],
  providers: [RecoveryCodesRepository, MfaService, { provide: MfaVerification, useExisting: MfaService }],
  exports: [MfaVerification],
})
export class AccountsModule {}
