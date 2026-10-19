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
// - AdminAccountsController, AdminAdminsController and AdminAccountsService: account support (search, detail,
//   disable, enable, unlock, MFA reset) and the platform admins (list, grant, revoke) (PBE-032), over AuthModule's
//   accounts and sessions, AccountsModule's recovery codes, NotificationsModule's outbox (the `auth.mfa_changed`
//   e-mail) and AuditModule.
// - AdminAuditController: the audit search and the CSV export (AuditModule.forApi()'s AuditQueryService, PBE-032).
// - AdminDashboardController and AdminDashboardService: the dashboard counters (PBE-029), with the read-only counts of
//   AdminDashboardRepository, the office pool of SupplierConnectionsModule's AmadeusAccountsRepository and the failed
//   counts of the platform queues (QueuesModule).
// - AdminTenantsController and AdminTenantsService: the OTA search, the control-plane view of one OTA and the edit of
//   its notes and legal name (PBE-029), over the exported repositories of TenantsModule, the global MembershipsModule
//   (members and invitations), BillingModule (the subscription), SupplierConnectionsModule and PaymentConnectionsModule
//   (the connections), DomainsModule, ProvisioningModule's jobs repository and AuditModule (the audit rows).
// - AdminJobsController and AdminJobsService: the tenant jobs (list, detail, retry, cancel) over ProvisioningModule's
//   repository and dispatcher and TenantsModule's repository, and the queues of both backends through QueueInspector
//   (BullMQ read-only on RedisModule's command client, but for the retry of a failed platform job) (PBE-031).
//   ProvisioningModule comes in as `ProvisioningModule.forApi()`, the very object AppModule imports, so the API has
//   one ProvisioningModule instance and exactly one ProvisioningDispatcher; its static part exports the jobs
//   repository the tenant detail reads too.
// - AdminBillingController: the plans (BillingModule's PlansService) and the subscriptions (PBE-033). The
//   subscriptions' SubscriptionsService (`billing/subscriptions.service.ts`) is provided here, not by BillingModule:
//   its manual edit also moves the tenant's plan through TenantsModule's repository, and BillingModule may not import
//   TenantsModule, a module of its own layer (architecture §2.2).
//
// Later tasks add the tenant lifecycle actions (PBE-030) and the other areas of platform/docs/api-inventory-admin.md,
// one controller per area. The admin bootstrap commands of dist/cli.js
// (`admin:grant`, `admin:reset-mfa`, admin-cli.commands.ts) run outside this module, in an application context of
// their own.
import { Module } from "@nestjs/common";
import { AccountsModule } from "../accounts/accounts.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { SubscriptionsService } from "../billing/subscriptions.service";
import { QueuesModule } from "../common/queues/queues.module";
import { DomainsModule } from "../domains/domains.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PaymentConnectionsModule } from "../payment-connections/payment-connections.module";
import { ProvisioningModule } from "../provisioning/provisioning.module";
import { SupplierConnectionsModule } from "../supplier-connections/supplier-connections.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AdminAccountsController } from "./admin-accounts.controller";
import { AdminAccountsService } from "./admin-accounts.service";
import { AdminAdminsController } from "./admin-admins.controller";
import { AdminAmadeusController } from "./admin-amadeus.controller";
import { AdminAuditController } from "./admin-audit.controller";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";
import { AdminBillingController } from "./admin-billing.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminDashboardRepository } from "./admin-dashboard.repository";
import { AdminDashboardService } from "./admin-dashboard.service";
import { AdminJobsController } from "./admin-jobs.controller";
import { AdminJobsService } from "./admin-jobs.service";
import { AdminTenantsController } from "./admin-tenants.controller";
import { AdminTenantsService } from "./admin-tenants.service";
import { QueueInspector } from "./queue-inspector";

@Module({
  imports: [
    AuthModule,
    AccountsModule,
    AuditModule.forApi(),
    NotificationsModule,
    QueuesModule,
    SupplierConnectionsModule.forApi(),
    // The very object AppModule imports (`forApi()` returns one object), so Nest builds the module once.
    ProvisioningModule.forApi(),
    TenantsModule,
    BillingModule,
    DomainsModule,
    PaymentConnectionsModule,
  ],
  controllers: [
    AdminAuthController,
    AdminAmadeusController,
    AdminAccountsController,
    AdminAdminsController,
    AdminAuditController,
    AdminDashboardController,
    AdminTenantsController,
    AdminJobsController,
    AdminBillingController,
  ],
  providers: [
    AdminAuthService,
    AdminAccountsService,
    AdminDashboardRepository,
    AdminDashboardService,
    AdminTenantsService,
    AdminJobsService,
    QueueInspector,
    SubscriptionsService,
  ],
})
export class AdminModule {}
