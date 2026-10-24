// BillingModule (platform/docs/architecture.md §2.1, layer 1): owns `plans`, `billing_customers`, `subscriptions` and
// `invoices`. M1 brings the public plan list and the subscription read (PBE-017), the manual trial of a new OTA
// (PBE-018) and the admin's plans (PlansService, PBE-033); M5 the Stripe Billing gateway on the Stripe client of
// common/stripe, the OTAs' Stripe Customers, Checkout and the Customer Portal (CheckoutService and BillingController,
// PBE-044). ProvisioningModule, AdminModule and BillingSyncModule import it for the repositories, PlansService and
// CheckoutService (the Checkout of createTenant and retryProvisioning). The admin's subscription edit
// (`subscriptions.service.ts`, PBE-033) also moves the tenant's plan, a write of TenantsModule (same layer), so
// AdminModule provides that service.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { stripeClientProvider } from "../common/stripe/stripe.client";
import { BillingController } from "./billing.controller";
import { BillingCustomersRepository } from "./billing-customers.repository";
import { CheckoutService } from "./checkout.service";
import { PlansController } from "./plans.controller";
import { PlansRepository } from "./plans.repository";
import { PlansService } from "./plans.service";
import { StripeBillingGateway } from "./stripe-billing.gateway";
import { SubscriptionsController } from "./subscriptions.controller";
import { SubscriptionsRepository } from "./subscriptions.repository";

@Module({
  imports: [AuditModule],
  controllers: [PlansController, SubscriptionsController, BillingController],
  providers: [
    PlansRepository,
    SubscriptionsRepository,
    PlansService,
    BillingCustomersRepository,
    stripeClientProvider,
    StripeBillingGateway,
    CheckoutService,
  ],
  exports: [PlansRepository, SubscriptionsRepository, PlansService, CheckoutService],
})
export class BillingModule {}
