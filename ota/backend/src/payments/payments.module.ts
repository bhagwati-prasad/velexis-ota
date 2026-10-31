// The payments context (ota/docs/architecture.md §2.1 and §5.1, OADR-0010, ADR-0011 (A) and (D); OBE-038): the
// PaymentGateway with `StripeGateway` (`velexis` mode in M3; `connect_standard` and `api_keys` since OBE-077, whose
// key is decrypted with STRIPE_KEY_PROVIDER, provided wherever the Stripe clients are), and the payment steps of the
// checkout, checkout.createPayment, checkout.getPayment and checkout.updatePayment, on the tenant's `payments` and
// `payment_events` through the tenancy module's `TenantTx`.
//
// Three modules:
//   - `PaymentGatewayModule` (payment-gateway.module.ts, re-exported here): the Stripe clients and the gateway (behind
//     PAYMENT_GATEWAY), with the tenant's payment connection read through the platform caches. Small on purpose: the
//     storefront imports it for its payment configuration (`storefront.get`, OADR-0010 point 1), BookingsModule for
//     the capture and the void (OBE-042), and the webhook receiver for the Velexis Stripe clients (OBE-039).
//   - `PaymentsModule`: the controller and the service of the payment steps, which read the checkout
//     (CheckoutModule's `CheckoutService`, its access rules and progress), the priced offer (ShoppingModule), the
//     `payment_card` fee rules (PricingModule) and, for an Amadeus card fee, the Amadeus client (AmadeusModule); the
//     inert `AirlineCardGateway` of the airline-card method (OBE-050; API only: it reads AIRLINE_CARD_ENABLED); and the
//     receiver of the Velexis Stripe account's webhooks (OBE-039, webhooks/), which stores each event and queues it on
//     `ota-stripe-events`, since OBE-078 also for the Connect endpoint and each `api_keys` connection's own endpoint
//     (whose signing secret it decrypts with STRIPE_KEY_PROVIDER, provided here too); and
//     checkout.completeWithAirlineCard (OBE-051, airline-card/airline-card-completion.*): its controller, service and
//     idempotency hooks, with the abuse limits (Redis) of PaymentGatewayModule, which hand the booking to
//     BookingsModule's BookingOrchestrator.
//   - `PaymentsWorkerModule` (worker only, OBE-039): the `ota-stripe-events` consumer (stripe-events.processor.ts),
//     which reads each stored event's object again from Stripe on the payment's account (StripeClientFactory: the
//     Velexis keys, `Stripe-Account` or an `api_keys` connection's key, OBE-078) and applies it to the tenant's
//     payments and refunds; its staff alerts go through the worker's global OutboxService. Since OBE-040 also the
//     `ota-payments` consumer (payments.processor.ts: voids, capture retries, refund submissions through
//     the PaymentGateway, with the refunds' claims of refunds.repository.ts) and the `payments.authorisation_watch`
//     handler (authorisation-watch.processor.ts, `@TenantJob`, found by the jobs module's runner), and since
//     FIX-W27-FOLLOWUPS the `refunds.sweep` handler (refunds-sweep.processor.ts), which queues `refund.submit` again
//     for the refunds whose enqueue was lost. It builds on the worker's tenancy module, so it never imports
//     `PaymentGatewayModule` (the API's tenancy module): it provides the gateway itself, on the worker's platform
//     caches.
//
// The API imports `PaymentsModule`, the worker `PaymentsWorkerModule`.
import { Module } from "@nestjs/common";
import { AmadeusModule } from "../amadeus/amadeus.module";
import { CheckoutModule } from "../checkout/checkout.module";
import { RequestContext } from "../common/http/request-context";
import { QueuesModule } from "../common/queues/queues.module";
import { IdentityModule } from "../identity/identity.module";
import { PricingModule } from "../pricing/pricing.module";
import { ShoppingModule } from "../shopping/shopping.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { BookingsModule } from "../bookings/bookings.module";
import { AirlineCardCompletionController } from "./airline-card/airline-card-completion.controller";
import {
  AirlineCardCompletionIdempotencyHooks,
  AirlineCardCompletionService,
} from "./airline-card/airline-card-completion.service";
import { AirlineCardGateway } from "./airline-card/airline-card.gateway";
import { AuthorisationWatchProcessor } from "./authorisation-watch.processor";
import { CardFees } from "./card-fees";
import { PAYMENT_GATEWAY } from "./payment-gateway";
import { PaymentGatewayModule } from "./payment-gateway.module";
import { PaymentsController } from "./payments.controller";
import { PaymentAlerts, PaymentJobsHandler, PaymentsProcessor } from "./payments.processor";
import { PaymentsRepository } from "./payments.repository";
import { PaymentsService } from "./payments.service";
import { RefundsSweep } from "./refunds-sweep.processor";
import { RefundsRepository } from "./refunds.repository";
import { StripeEventHandler, StripeEventsProcessor } from "./stripe-events.processor";
import { StripeClientFactory, stripeKeyProvider } from "./stripe/stripe-client.factory";
import { StripeGateway } from "./stripe/stripe.gateway";
import { StripeConnectWebhookController } from "./webhooks/stripe-connect-webhook.controller";
import { StripeConnectionWebhookController } from "./webhooks/stripe-connection-webhook.controller";
import { StripeVelexisWebhookController } from "./webhooks/stripe-velexis-webhook.controller";
import { WebhookReceiverService } from "./webhooks/webhook-receiver.service";

// PaymentGatewayModule has a file of its own (payment-gateway.module.ts): BookingsModule imports it, and CheckoutModule
// imports BookingsModule, so this file (which imports CheckoutModule) must not be on that path (OBE-042).
export { PaymentGatewayModule };

@Module({
  imports: [
    TenancyModule.forApi(),
    PaymentGatewayModule,
    CheckoutModule,
    ShoppingModule,
    PricingModule,
    AmadeusModule,
    IdentityModule,
    QueuesModule,
    // checkout.completeWithAirlineCard's booking (OBE-051); BookingsModule never imports this module.
    BookingsModule,
  ],
  controllers: [
    PaymentsController,
    StripeVelexisWebhookController,
    // The Connect and API-key endpoints (OBE-078).
    StripeConnectWebhookController,
    StripeConnectionWebhookController,
    AirlineCardCompletionController,
  ],
  // RequestContext only reads the request context (nestjs-cls): this module's instance sees the scope the guards set.
  providers: [
    PaymentsService,
    PaymentsRepository,
    CardFees,
    AirlineCardGateway,
    AirlineCardCompletionService,
    AirlineCardCompletionIdempotencyHooks,
    RequestContext,
    // The KEKs that decrypt an `api_keys` connection's webhook signing secret in the receiver (OBE-078).
    stripeKeyProvider,
    WebhookReceiverService,
  ],
})
export class PaymentsModule {}

@Module({
  imports: [TenancyModule.forWorker(), QueuesModule],
  providers: [
    // The KEKs that decrypt an `api_keys` connection's key (OBE-077).
    stripeKeyProvider,
    StripeClientFactory,
    PaymentsRepository,
    StripeEventHandler,
    StripeEventsProcessor,
    // The payments queue and the authorisation watch (OBE-040).
    StripeGateway,
    { provide: PAYMENT_GATEWAY, useExisting: StripeGateway },
    RefundsRepository,
    PaymentAlerts,
    PaymentJobsHandler,
    PaymentsProcessor,
    AuthorisationWatchProcessor,
    // The sweep of the refunds whose refund.submit enqueue was lost (FIX-W27-FOLLOWUPS).
    RefundsSweep,
  ],
})
export class PaymentsWorkerModule {}
