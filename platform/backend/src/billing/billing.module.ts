// BillingModule (platform/docs/architecture.md §2.1, layer 1): owns `plans`, `billing_customers`, `subscriptions` and
// `invoices`. M1 brings the public plan list and the subscription read (PBE-017), the manual trial of a new OTA
// (PBE-018) and the admin's plans (PlansService, PBE-033); the Stripe Billing gateway (M5) follows. ProvisioningModule,
// AdminModule and BillingSyncModule import it for the repositories and PlansService. The admin's subscription edit
// (`subscriptions.service.ts`, PBE-033) also moves the tenant's plan, a write of TenantsModule (same layer), so
// AdminModule provides that service.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { PlansController } from "./plans.controller";
import { PlansRepository } from "./plans.repository";
import { PlansService } from "./plans.service";
import { SubscriptionsController } from "./subscriptions.controller";
import { SubscriptionsRepository } from "./subscriptions.repository";

@Module({
  imports: [AuditModule],
  controllers: [PlansController, SubscriptionsController],
  providers: [PlansRepository, SubscriptionsRepository, PlansService],
  exports: [PlansRepository, SubscriptionsRepository, PlansService],
})
export class BillingModule {}
