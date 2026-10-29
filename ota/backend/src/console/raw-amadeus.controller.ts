// The eight raw Amadeus reads of the console (`console.amadeus.*`, `x-scope: console`, `x-permission: amadeus:read`:
// owner, admin and agent, or a `console:automation` key listing it; OBE-067, OADR-0011 point 7): thin handlers over
// RawAmadeusService (raw-amadeus.service.ts). The global guards resolved the caller, the tenant and its environment,
// the staff member, the rate limits and the permission (OADR-0011 points 3 to 6), and the validation interceptor
// checked the input against the OTA document. The POST searches are reads (`x-idempotent-by-design`, no
// `Idempotency-Key`) and answer `200`. Every answer is `Cache-Control: private, no-store` (net prices, travellers).
//
// Each read is an audited read (OADR-0011 point 8 as decided on 2026-10-21): its handler opts in with `@AuditedRead`
// (the action `amadeus.<operation>`), and its use case writes the row with the request's reason, so the interceptor
// writes no second one; a refused or failed call has its row as any console call.
//
// The four raw writes (createFlightOrders, issueFlightOrder, patchFlightOrder, cancelFlightOrder) are not here: they
// stay `deferred` in pending-operations.ts and answer `501 NOT_IMPLEMENTED`. The by-reference route is declared before
// the `{flightOrderId}` one: Express tries routes in registration order, and `by-reference` matches the id's pattern.
import { Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  RAW_AMADEUS_CACHE_CONTROL,
  RawAmadeusService,
  type RawAvailabilitiesResult,
  type RawFlightOffersResult,
  type RawFlightOrderResult,
  type RawFlightOrdersByReferenceResult,
  type RawPricingResult,
  type RawQueueResult,
  type RawUpsellResult,
} from "./raw-amadeus.service";
import { AuditedRead } from "./staff-actions.writer";

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: string, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

@Controller("v1/console/amadeus")
export class RawAmadeusController {
  constructor(private readonly raw: RawAmadeusService) {}

  @Post("v2/shopping/flight-offers")
  @HttpCode(200)
  @OpenApiOperation("consoleAmadeusSearchFlightOffers")
  @AuditedRead()
  async searchFlightOffers(
    @OpenApiInput() input: ValidatedInput<"consoleAmadeusSearchFlightOffers">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RawFlightOffersResult> {
    res.setHeader("Cache-Control", RAW_AMADEUS_CACHE_CONTROL);
    return await this.raw.searchFlightOffers(bodyOf(input.operationId, input.body));
  }

  @Get("v2/shopping/flight-offers")
  @OpenApiOperation("consoleAmadeusGetFlightOffers")
  @AuditedRead()
  async getFlightOffers(
    @OpenApiInput() input: ValidatedInput<"consoleAmadeusGetFlightOffers">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RawFlightOffersResult> {
    res.setHeader("Cache-Control", RAW_AMADEUS_CACHE_CONTROL);
    return await this.raw.getFlightOffers(input.query);
  }

  @Post("v1/shopping/availability/flight-availabilities")
  @HttpCode(200)
  @OpenApiOperation("consoleAmadeusSearchFlightAvailabilities")
  @AuditedRead()
  async searchFlightAvailabilities(
    @OpenApiInput() input: ValidatedInput<"consoleAmadeusSearchFlightAvailabilities">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RawAvailabilitiesResult> {
    res.setHeader("Cache-Control", RAW_AMADEUS_CACHE_CONTROL);
    return await this.raw.searchFlightAvailabilities(bodyOf(input.operationId, input.body));
  }

  @Post("v1/shopping/flight-offers/upselling")
  @HttpCode(200)
  @OpenApiOperation("consoleAmadeusUpsellAirOffers")
  @AuditedRead()
  async upsellAirOffers(
    @OpenApiInput() input: ValidatedInput<"consoleAmadeusUpsellAirOffers">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RawUpsellResult> {
    res.setHeader("Cache-Control", RAW_AMADEUS_CACHE_CONTROL);
    return await this.raw.upsellAirOffers(bodyOf(input.operationId, input.body));
  }

  @Post("v1/shopping/flight-offers/pricing")
  @HttpCode(200)
  @OpenApiOperation("consoleAmadeusQuoteAirOffers")
  @AuditedRead()
  async quoteAirOffers(
    @OpenApiInput() input: ValidatedInput<"consoleAmadeusQuoteAirOffers">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RawPricingResult> {
    res.setHeader("Cache-Control", RAW_AMADEUS_CACHE_CONTROL);
    return await this.raw.quoteAirOffers(input.query ?? {}, bodyOf(input.operationId, input.body));
  }

  @Get("v1/booking/flight-orders/by-reference")
  @OpenApiOperation("consoleAmadeusGetFlightOrderByReference")
  @AuditedRead()
  async getFlightOrderByReference(
    @OpenApiInput() input: ValidatedInput<"consoleAmadeusGetFlightOrderByReference">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RawFlightOrdersByReferenceResult> {
    res.setHeader("Cache-Control", RAW_AMADEUS_CACHE_CONTROL);
    return await this.raw.getFlightOrderByReference(input.query);
  }

  @Get("v1/booking/flight-orders/:flightOrderId")
  @OpenApiOperation("consoleAmadeusGetFlightOrder")
  @AuditedRead()
  async getFlightOrder(
    @OpenApiInput() input: ValidatedInput<"consoleAmadeusGetFlightOrder">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RawFlightOrderResult> {
    res.setHeader("Cache-Control", RAW_AMADEUS_CACHE_CONTROL);
    return await this.raw.getFlightOrder(input.path.flightOrderId, input.query ?? {});
  }

  @Get("office/queues/:queueId")
  @OpenApiOperation("consoleAmadeusGetQueue")
  @AuditedRead()
  async getQueue(
    @OpenApiInput() input: ValidatedInput<"consoleAmadeusGetQueue">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RawQueueResult> {
    res.setHeader("Cache-Control", RAW_AMADEUS_CACHE_CONTROL);
    return await this.raw.getQueue(input.path.queueId, input.query ?? {});
  }
}
