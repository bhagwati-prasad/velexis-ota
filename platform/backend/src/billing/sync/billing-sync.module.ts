// BillingSyncModule (platform/docs/architecture.md §2.1, layer 3; PADR-0002, subscription-billing flow §C and §D): the
// Stripe Billing webhook and the processing of the Stripe event inbox.
//
// - The static module (AppModule) carries the receiver `POST /webhooks/stripe/billing` (BillingWebhookController, over
//   the inbox of common/stripe: StripeSignatureGuard, StripeInboxService, StripeEventsRepository), which stores and
//   queues events and never calls Stripe (PBE-043).
// - `BillingSyncModule.forWorker()` (WorkerModule) adds the worker's side: the one processor of
//   `platform-stripe-events` (StripeEventsProcessor, for the events of both receivers; it finds the
//   `@HandlesStripeEvents` handlers among the worker's providers), the `stripe_events.sweep` handler of the
//   `platform-maintenance` processor, the milestone switches it reads and the Stripe client the handlers re-fetch with.
//   PBE-045 adds the handlers of `checkout.session.completed` and `customer.subscription.*` (handlers/), the price-to-
//   plan map and the status rules. They write through BillingModule's repositories (`subscriptions`,
//   `billing_customers`, read `plans`) and TenantsRepository, provided here on their own because those modules carry
//   the portal's routes, and suspend, resume and dispatch through ProvisioningModule's worker part (layer 2), whose one
//   module object WorkerModule imports too. The handlers re-fetch and write a Stripe subscription under its lock
//   (SubscriptionSyncLock, subscription-lock.ts, FIX-W30-PLATFORM). PBE-046 adds the handler of the invoice events
//   (handlers/invoice.handler.ts), which writes through BillingModule's InvoicesRepository, provided here on its own
//   too, takes the lock of the invoice's subscription and queues the owners' `billing.payment_failed` e-mail through
//   NotificationsModule (layer 0). The dunning and the trial schedules join it.
//
// It uses the global CommonModule (Clock, IdGenerator, PLATFORM_DB), the global RedisModule (InvalidationPublisher,
// and REDIS_CLIENT for the subscription lock), the queues of QueuesModule, AuditModule and NotificationsModule.
import { Module, type DynamicModule } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { AuditModule } from "../../audit/audit.module";
import { FeatureSwitches } from "../../common/features";
import { NotificationsModule } from "../../notifications/notifications.module";
import { QueuesModule } from "../../common/queues/queues.module";
import { stripeClientProvider } from "../../common/stripe/stripe.client";
import { StripeEventsRepository } from "../../common/stripe/stripe-events.repository";
import { StripeInboxService } from "../../common/stripe/stripe-inbox.service";
import { ProvisioningModule } from "../../provisioning/provisioning.module";
import { TenantsRepository } from "../../tenants/tenants.repository";
import { BillingCustomersRepository } from "../billing-customers.repository";
import { InvoicesRepository } from "../invoices.repository";
import { PlansRepository } from "../plans.repository";
import { SubscriptionsRepository } from "../subscriptions.repository";
import { BillingWebhookController } from "./billing-webhook.controller";
import { CheckoutSessionCompletedHandler } from "./handlers/checkout-session-completed.handler";
import { InvoiceHandler } from "./handlers/invoice.handler";
import { SubscriptionChangedHandler } from "./handlers/subscription-changed.handler";
import { PriceToPlan } from "./price-to-plan";
import { BillingStatusRules } from "./status-rules";
import { StripeEventsProcessor } from "./stripe-events.processor";
import { StripeEventsSweepScheduler } from "./stripe-events-sweep.scheduler";
import { SubscriptionSyncLock } from "./subscription-lock";

/** The worker's part of BillingSyncModule (`BillingSyncModule.forWorker()`). */
@Module({
  imports: [QueuesModule, DiscoveryModule, AuditModule, NotificationsModule, ProvisioningModule.forWorker()],
  providers: [
    StripeEventsRepository,
    FeatureSwitches,
    stripeClientProvider,
    StripeEventsProcessor,
    StripeEventsSweepScheduler,
    PlansRepository,
    SubscriptionsRepository,
    BillingCustomersRepository,
    TenantsRepository,
    PriceToPlan,
    BillingStatusRules,
    SubscriptionSyncLock,
    SubscriptionChangedHandler,
    CheckoutSessionCompletedHandler,
    InvoicesRepository,
    InvoiceHandler,
  ],
})
export class BillingSyncWorkerModule {}

@Module({
  imports: [QueuesModule],
  controllers: [BillingWebhookController],
  providers: [StripeEventsRepository, StripeInboxService],
})
export class BillingSyncModule {
  /** The processor of the inbox, its sweep and the billing event handlers, for WorkerModule. */
  static forWorker(): DynamicModule {
    return { module: BillingSyncWorkerModule };
  }
}
