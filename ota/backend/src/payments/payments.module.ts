// The payments context (ota/docs/architecture.md §2.1 and §5.1, OADR-0010, ADR-0011 (A) and (D); OBE-038): the
// PaymentGateway with `StripeGateway` (`velexis` mode in M3), and the payment steps of the checkout,
// checkout.createPayment, checkout.getPayment and checkout.updatePayment, on the tenant's `payments` and
// `payment_events` through the tenancy module's `TenantTx`.
//
// Three modules:
//   - `PaymentGatewayModule` (payment-gateway.module.ts, re-exported here): the Stripe clients and the gateway (behind
//     PAYMENT_GATEWAY), with the tenant's payment connection read through the platform caches. Small on purpose: the
//     storefront imports it for its payment configuration (`storefront.get`, OADR-0010 point 1), BookingsModule for
//     the capture and the void (OBE-042), and the webhook receiver for the Velexis Stripe clients (OBE-039).
//   - `PaymentsModule`: the controller and the service of the payment steps, which read the checkout
//     (CheckoutModule's `CheckoutService`, its access rules and progress), the priced offer (ShoppingModule), the
//     `payment_card` fee rules (PricingModule) and, for an Amadeus card fee, the Amadeus client (AmadeusModule); and the
//     receiver of the Velexis Stripe account's webhooks (OBE-039, webhooks/), which stores each event and queues it on
//     `ota-stripe-events`.
//   - `PaymentsWorkerModule` (worker only, OBE-039): the `ota-stripe-events` consumer (stripe-events.processor.ts),
//     which reads each stored event's object again from Stripe with the Velexis keys (StripeClientFactory) and applies
//     it to the tenant's payments and refunds; its staff alerts go through the worker's global OutboxService. It builds
//     on the worker's tenancy module, so it never imports `PaymentGatewayModule` (the API's tenancy module).
//
// The API imports `PaymentsModule`, the worker `PaymentsWorkerModule`; the payments queue of OBE-040 joins the latter.
import { Module } from "@nestjs/common";
import { AmadeusModule } from "../amadeus/amadeus.module";
import { CheckoutModule } from "../checkout/checkout.module";
import { RequestContext } from "../common/http/request-context";
import { QueuesModule } from "../common/queues/queues.module";
import { IdentityModule } from "../identity/identity.module";
import { PricingModule } from "../pricing/pricing.module";
import { ShoppingModule } from "../shopping/shopping.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { CardFees } from "./card-fees";
import { PaymentGatewayModule } from "./payment-gateway.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsRepository } from "./payments.repository";
import { PaymentsService } from "./payments.service";
import { StripeEventHandler, StripeEventsProcessor } from "./stripe-events.processor";
import { StripeClientFactory } from "./stripe/stripe-client.factory";
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
  ],
  controllers: [PaymentsController, StripeVelexisWebhookController],
  // RequestContext only reads the request context (nestjs-cls): this module's instance sees the scope the guards set.
  providers: [PaymentsService, PaymentsRepository, CardFees, RequestContext, WebhookReceiverService],
})
export class PaymentsModule {}

@Module({
  imports: [TenancyModule.forWorker(), QueuesModule],
  providers: [StripeClientFactory, PaymentsRepository, StripeEventHandler, StripeEventsProcessor],
})
export class PaymentsWorkerModule {}
