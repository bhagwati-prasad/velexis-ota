// The payments context (ota/docs/architecture.md §2.1 and §5.1, OADR-0010, ADR-0011 (A) and (D); OBE-038): the
// PaymentGateway with `StripeGateway` (`velexis` mode in M3), and the payment steps of the checkout,
// checkout.createPayment, checkout.getPayment and checkout.updatePayment, on the tenant's `payments` and
// `payment_events` through the tenancy module's `TenantTx`.
//
// Two modules:
//   - `PaymentGatewayModule`: the Stripe clients and the gateway (behind PAYMENT_GATEWAY), with the tenant's payment
//     connection read through the platform caches. Small on purpose: the storefront imports it for its payment
//     configuration (`storefront.get`, OADR-0010 point 1), and the webhook processor and the payments queue of the
//     worker build on it (OBE-039, OBE-040).
//   - `PaymentsModule`: the controller and the service of the payment steps, which read the checkout
//     (CheckoutModule's `CheckoutService`, its access rules and progress), the priced offer (ShoppingModule), the
//     `payment_card` fee rules (PricingModule) and, for an Amadeus card fee, the Amadeus client (AmadeusModule).
//
// API only so far; the worker joins with OBE-039.
import { Module } from "@nestjs/common";
import { AmadeusModule } from "../amadeus/amadeus.module";
import { CheckoutModule } from "../checkout/checkout.module";
import { RequestContext } from "../common/http/request-context";
import { IdentityModule } from "../identity/identity.module";
import { PricingModule } from "../pricing/pricing.module";
import { ShoppingModule } from "../shopping/shopping.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { CardFees } from "./card-fees";
import { PaymentGatewayModule } from "./payment-gateway.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsRepository } from "./payments.repository";
import { PaymentsService } from "./payments.service";

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
  ],
  controllers: [PaymentsController],
  // RequestContext only reads the request context (nestjs-cls): this module's instance sees the scope the guards set.
  providers: [PaymentsService, PaymentsRepository, CardFees, RequestContext],
})
export class PaymentsModule {}
