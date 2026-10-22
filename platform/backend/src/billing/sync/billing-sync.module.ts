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
//   The handlers of the billing events (PBE-045, PBE-046), the dunning and the trial schedules join it.
//
// It uses the global CommonModule (Clock, PLATFORM_DB) and the queues of QueuesModule.
import { Module, type DynamicModule } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { FeatureSwitches } from "../../common/features";
import { QueuesModule } from "../../common/queues/queues.module";
import { stripeClientProvider } from "../../common/stripe/stripe.client";
import { StripeEventsRepository } from "../../common/stripe/stripe-events.repository";
import { StripeInboxService } from "../../common/stripe/stripe-inbox.service";
import { BillingWebhookController } from "./billing-webhook.controller";
import { StripeEventsProcessor } from "./stripe-events.processor";
import { StripeEventsSweepScheduler } from "./stripe-events-sweep.scheduler";

/** The worker's part of BillingSyncModule (`BillingSyncModule.forWorker()`). */
@Module({
  imports: [QueuesModule, DiscoveryModule],
  providers: [
    StripeEventsRepository,
    FeatureSwitches,
    stripeClientProvider,
    StripeEventsProcessor,
    StripeEventsSweepScheduler,
  ],
})
export class BillingSyncWorkerModule {}

@Module({
  imports: [QueuesModule],
  controllers: [BillingWebhookController],
  providers: [StripeEventsRepository, StripeInboxService],
})
export class BillingSyncModule {
  /** The processor of the inbox and its sweep, for WorkerModule. */
  static forWorker(): DynamicModule {
    return { module: BillingSyncWorkerModule };
  }
}
