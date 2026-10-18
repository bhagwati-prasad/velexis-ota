// The shopping context (ota/docs/architecture.md §2.1, ota/docs/flows/search-and-price.md; OBE-021): flight searches
// and their results, priced with the markup and fee engine (PricingModule) from Flight Offers Search answers
// (AmadeusModule), stored in the tenant's `flight_searches` and `flight_offers` through the tenancy module's `TenantTx`;
// one offer and its Branded Fares Upsell alternatives (`offer_upsells`, OBE-022); priced offers from Flight Offers
// Price with their ancillary catalogue and fare rules (`priced_offers`, OBE-023). API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { AmadeusModule } from "../amadeus/amadeus.module";
import { RequestContext } from "../common/http/request-context";
import { PricingModule } from "../pricing/pricing.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { OffersController } from "./offers.controller";
import { OffersRepository } from "./offers.repository";
import { OffersService } from "./offers.service";
import { PricedOffersController } from "./priced-offers.controller";
import { PricedOffersRepository } from "./priced-offers.repository";
import { PricedOffersService } from "./priced-offers.service";
import { SearchesController } from "./searches.controller";
import { SearchesRepository } from "./searches.repository";
import { SearchesService } from "./searches.service";
import { UpsellService } from "./upsell.service";

@Module({
  imports: [TenancyModule.forApi(), AmadeusModule, PricingModule],
  controllers: [SearchesController, OffersController, PricedOffersController],
  // RequestContext only reads the request context (nestjs-cls): this module's instance sees the scope the guards set.
  providers: [
    SearchesService,
    SearchesRepository,
    OffersService,
    OffersRepository,
    UpsellService,
    PricedOffersService,
    PricedOffersRepository,
    RequestContext,
  ],
})
export class ShoppingModule {}
