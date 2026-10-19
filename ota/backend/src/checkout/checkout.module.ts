// The checkout context (ota/docs/architecture.md §2.1, ota/docs/flows/checkout-stripe.md; OBE-036): the checkout
// aggregate opened from a priced offer (ShoppingModule's PricedOffersService) for a signed-in customer (IdentityModule's
// CustomerContext) or a guest, with its travellers (documents and discount cards sealed with the KEKs of
// MASTER_KEY_DIR, traveller-documents.ts), contacts and special requests, in the tenant's `checkouts` and
// `checkout_*` tables through the tenancy module's `TenantTx`. The extras (OBE-037), the payment steps (OBE-038) and
// checkout.complete (OBE-042) join it. API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { RequestContext } from "../common/http/request-context";
import { IdentityModule } from "../identity/identity.module";
import { ShoppingModule } from "../shopping/shopping.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { CheckoutController } from "./checkout.controller";
import { CheckoutRepository } from "./checkout.repository";
import { CheckoutService } from "./checkout.service";
import { checkoutKeyProvider, TravelerDocuments } from "./traveler-documents";

@Module({
  imports: [TenancyModule.forApi(), IdentityModule, ShoppingModule],
  controllers: [CheckoutController],
  // RequestContext only reads the request context (nestjs-cls): this module's instance sees the scope the guards set.
  providers: [checkoutKeyProvider, TravelerDocuments, CheckoutRepository, CheckoutService, RequestContext],
})
export class CheckoutModule {}
