// `flights.price`, `flights.getPricedOffer`, `flights.getAncillaries` and `flights.getFareRules` (priceFlightOffers,
// getPricedOffer, getPricedOfferAncillaries, getPricedOfferFareRules; `x-scope: both`; OBE-023): thin handlers over
// PricedOffersService. The global guards resolved the caller, the tenant and the scope (customer or console), the CSRF
// guard checked the edge's POST, the rate limits counted the pricing, the validation interceptor checked the input
// against the OTA document and the idempotency interceptor stores the pricing's answer (its `409 PRICE_CHANGED`
// included) under its `Idempotency-Key`. Every answer is `Cache-Control: no-store`: prices are live and a priced
// offer may belong to a customer.
import { Controller, Get, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import type { AncillaryCatalogue, FareRuleSet, PricedOffer } from "./priced-offers.mapper";
import { PricedOffersService } from "./priced-offers.service";

/** `Cache-Control` of every answer of these operations. */
export const PRICED_OFFER_CACHE_CONTROL = "no-store";

@Controller("v1/priced-offers")
export class PricedOffersController {
  constructor(private readonly pricedOffers: PricedOffersService) {}

  @Post()
  @OpenApiOperation("priceFlightOffers")
  async price(
    @OpenApiInput() input: ValidatedInput<"priceFlightOffers">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PricedOffer> {
    if (input.body === undefined) {
      // The validation interceptor refuses a request without its required body; this is never reached.
      throw new Error("priceFlightOffers without a validated body");
    }
    // A `409 PRICE_CHANGED` is an error answer: the error filter sends it with its own `Cache-Control: no-store`.
    const created = await this.pricedOffers.price({
      body: input.body,
      acceptLanguage: input.headers["Accept-Language"],
    });
    res.setHeader("Location", created.location);
    res.setHeader("Cache-Control", PRICED_OFFER_CACHE_CONTROL);
    return created.pricedOffer;
  }

  @Get(":pricedOfferId")
  @OpenApiOperation("getPricedOffer")
  async get(
    @OpenApiInput() input: ValidatedInput<"getPricedOffer">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PricedOffer> {
    const pricedOffer = await this.pricedOffers.get(
      input.path.pricedOfferId,
      input.headers?.["Accept-Language"],
    );
    res.setHeader("Cache-Control", PRICED_OFFER_CACHE_CONTROL);
    return pricedOffer;
  }

  @Get(":pricedOfferId/ancillaries")
  @OpenApiOperation("getPricedOfferAncillaries")
  async ancillaries(
    @OpenApiInput() input: ValidatedInput<"getPricedOfferAncillaries">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AncillaryCatalogue> {
    const catalogue = await this.pricedOffers.ancillaries(input.path.pricedOfferId);
    res.setHeader("Cache-Control", PRICED_OFFER_CACHE_CONTROL);
    return catalogue;
  }

  @Get(":pricedOfferId/fare-rules")
  @OpenApiOperation("getPricedOfferFareRules")
  async fareRules(
    @OpenApiInput() input: ValidatedInput<"getPricedOfferFareRules">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FareRuleSet> {
    const rules = await this.pricedOffers.fareRules(input.path.pricedOfferId);
    res.setHeader("Cache-Control", PRICED_OFFER_CACHE_CONTROL);
    return rules;
  }
}
