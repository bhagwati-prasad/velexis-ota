// BillingModule (platform/docs/architecture.md §2.1, layer 1): owns `plans`, `billing_customers`, `subscriptions` and
// `invoices`. M1 brings the public plan list and the subscription read (PBE-017); the manual trial of a new OTA
// (PBE-018), the admin's plans and subscriptions and the Stripe Billing gateway (M5) follow. ProvisioningModule and
// BillingSyncModule import it for the repositories.
import { Module } from "@nestjs/common";
import { PlansController } from "./plans.controller";
import { PlansRepository } from "./plans.repository";
import { SubscriptionsController } from "./subscriptions.controller";
import { SubscriptionsRepository } from "./subscriptions.repository";

@Module({
  controllers: [PlansController, SubscriptionsController],
  providers: [PlansRepository, SubscriptionsRepository],
  exports: [PlansRepository, SubscriptionsRepository],
})
export class BillingModule {}
