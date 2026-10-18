// The shopping context (ota/docs/architecture.md §2.1, ota/docs/flows/search-and-price.md; OBE-021): flight searches
// and their results, priced with the markup and fee engine (PricingModule) from Flight Offers Search answers
// (AmadeusModule), stored in the tenant's `flight_searches` and `flight_offers` through the tenancy module's `TenantTx`.
// Offers, upsell and pricing join with OBE-022 and OBE-023. API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { AmadeusModule } from "../amadeus/amadeus.module";
import { RequestContext } from "../common/http/request-context";
import { PricingModule } from "../pricing/pricing.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { SearchesController } from "./searches.controller";
import { SearchesRepository } from "./searches.repository";
import { SearchesService } from "./searches.service";

@Module({
  imports: [TenancyModule.forApi(), AmadeusModule, PricingModule],
  controllers: [SearchesController],
  // RequestContext only reads the request context (nestjs-cls): this module's instance sees the scope the guards set.
  providers: [SearchesService, SearchesRepository, RequestContext],
})
export class ShoppingModule {}
