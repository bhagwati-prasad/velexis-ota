// AdminModule (platform/docs/architecture.md §2.1, layer 4): the thin controllers of the platform admin's API over the
// services of the modules below it (PADR-0006). It owns no table. Every route is `x-scope: platform_admin`
// (AdminAuthGuard), except the admin's sign-in steps, and every change is audited by the service it calls, with
// `actor_type = 'platform_admin'`.
//
// - AdminAuthController and AdminAuthService: the admin's sign-in with mandatory MFA, its own refresh families
//   (`audience = 'platform_admin'`, 12 hours), the step-up, sign-out and adminGetMe (PBE-028). They build on
//   AuthModule (the password step, the challenges, the accounts and the session rows), AccountsModule's MfaService
//   (global: the code checks) and AuditModule.
// - AdminAmadeusController: the Velexis Amadeus accounts and the office pool (SupplierConnectionsModule, PBE-020).
//
// Later tasks add the dashboard, tenants, jobs and queues (PBE-029 to PBE-031) and the other areas of
// platform/docs/api-inventory-admin.md, one controller per area. The admin bootstrap commands of dist/cli.js
// (`admin:grant`, `admin:reset-mfa`, admin-cli.commands.ts) run outside this module, in an application context of
// their own.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { SupplierConnectionsModule } from "../supplier-connections/supplier-connections.module";
import { AdminAmadeusController } from "./admin-amadeus.controller";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";

@Module({
  imports: [AuthModule, AuditModule, SupplierConnectionsModule.forApi()],
  controllers: [AdminAuthController, AdminAmadeusController],
  providers: [AdminAuthService],
})
export class AdminModule {}
