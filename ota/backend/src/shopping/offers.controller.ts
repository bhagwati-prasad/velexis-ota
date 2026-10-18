// `flights.getOffer` and `flights.upsell` (getFlightOffer, upsellFlightOffer; `x-scope: both`; OBE-022): thin handlers
// over OffersService and UpsellService. The global guards resolved the caller, the tenant and the scope (customer or
// console), the CSRF guard checked the edge's POST, the rate limits counted the upsell, the validation interceptor
// checked the input against the OTA document and the idempotency interceptor stores the upsell's answer under its
// `Idempotency-Key`. Every answer is `Cache-Control: no-store`: prices are live and an offer may belong to a customer.
import { Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import type { FlightOffer } from "./offers.mapper";
import { OffersService } from "./offers.service";
import { UpsellService, type UpsellResult } from "./upsell.service";

/** `Cache-Control` of every answer of these operations. */
export const OFFER_CACHE_CONTROL = "no-store";

@Controller("v1/flight-offers")
export class OffersController {
  constructor(
    private readonly offers: OffersService,
    private readonly upsells: UpsellService,
  ) {}

  @Get(":offerId")
  @OpenApiOperation("getFlightOffer")
  async get(
    @OpenApiInput() input: ValidatedInput<"getFlightOffer">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FlightOffer> {
    const offer = await this.offers.get(input.path.offerId, input.headers?.["Accept-Language"]);
    res.setHeader("Cache-Control", OFFER_CACHE_CONTROL);
    return offer;
  }

  @Post(":offerId/upsells")
  @HttpCode(200)
  @OpenApiOperation("upsellFlightOffer")
  async upsell(
    @OpenApiInput() input: ValidatedInput<"upsellFlightOffer">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UpsellResult> {
    const result = await this.upsells.upsell({
      offerId: input.path.offerId,
      body: input.body,
      acceptLanguage: input.headers["Accept-Language"],
    });
    res.setHeader("Cache-Control", OFFER_CACHE_CONTROL);
    return result;
  }
}
