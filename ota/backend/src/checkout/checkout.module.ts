// The checkout context (ota/docs/architecture.md §2.1, ota/docs/flows/checkout-stripe.md; OBE-036): the checkout
// aggregate opened from a priced offer (ShoppingModule's PricedOffersService) for a signed-in customer (IdentityModule's
// CustomerContext) or a guest, with its travellers (documents and discount cards sealed with the KEKs of
// MASTER_KEY_DIR, traveller-documents.ts), contacts and special requests, in the tenant's `checkouts` and
// `checkout_*` tables through the tenancy module's `TenantTx`. The extras (AncillariesService, OBE-037) are re-priced
// with Amadeus (AmadeusModule's AmadeusClient) into child priced offers (PricedOffersService); checkout.complete
// (OBE-042) is the bookings module's BookingOrchestrator behind this module's route (BookingsModule never imports this
// module); the payment steps (PaymentsModule, OBE-038) read a checkout through the exported `CheckoutService`, with its
// access rules and progress. API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { AmadeusModule } from "../amadeus/amadeus.module";
import { BookingsModule } from "../bookings/bookings.module";
import { RequestContext } from "../common/http/request-context";
import { IdentityModule } from "../identity/identity.module";
import { ShoppingModule } from "../shopping/shopping.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AncillariesService } from "./ancillaries.service";
import { CheckoutController } from "./checkout.controller";
import { CheckoutRepository } from "./checkout.repository";
import { CheckoutService } from "./checkout.service";
import { checkoutKeyProvider, TravelerDocuments } from "./traveler-documents";

@Module({
  imports: [TenancyModule.forApi(), IdentityModule, ShoppingModule, AmadeusModule, BookingsModule],
  controllers: [CheckoutController],
  // RequestContext only reads the request context (nestjs-cls): this module's instance sees the scope the guards set.
  providers: [
    checkoutKeyProvider,
    TravelerDocuments,
    CheckoutRepository,
    CheckoutService,
    AncillariesService,
    RequestContext,
  ],
  exports: [CheckoutService],
})
export class CheckoutModule {}
