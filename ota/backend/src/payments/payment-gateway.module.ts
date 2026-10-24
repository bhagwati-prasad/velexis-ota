// `PaymentGatewayModule` (OBE-038; payments.module.ts describes both payment modules): the Stripe clients and the
// gateway behind PAYMENT_GATEWAY, with the tenant's payment connection read through the platform caches. It has a
// file of its own so that a module on CheckoutModule's import path (BookingsModule, OBE-042) can import it without
// importing payments.module.ts, which imports CheckoutModule: that cycle of files would leave one of the module
// classes undefined when Nest scans the graph. payments.module.ts re-exports it for its other importers.
//
// It also provides the airline card's abuse limits (AirlineCardLimits, on the global Redis client), so the storefront
// (storefront.get leaves the method out while it is suspended) and the payment steps (checkout.createPayment refuses it
// then, checkout.completeWithAirlineCard counts its declines) share one instance (FIX-W29-OTA).
import { Module } from "@nestjs/common";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AirlineCardLimits } from "./airline-card/abuse-limits";
import { PAYMENT_GATEWAY } from "./payment-gateway";
import { StripeClientFactory } from "./stripe/stripe-client.factory";
import { StripeGateway } from "./stripe/stripe.gateway";

@Module({
  imports: [TenancyModule.forApi()],
  providers: [
    StripeClientFactory,
    StripeGateway,
    { provide: PAYMENT_GATEWAY, useExisting: StripeGateway },
    AirlineCardLimits,
  ],
  // The client factory too: the webhook receiver reads a dispute's PaymentIntent with the endpoint's Velexis key (OBE-039).
  exports: [PAYMENT_GATEWAY, StripeClientFactory, AirlineCardLimits],
})
export class PaymentGatewayModule {}
