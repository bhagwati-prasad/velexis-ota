// `POST /v1/checkouts/{checkoutId}/airline-card-completion` (completeCheckoutWithAirlineCard, `x-edge-only`; OBE-051;
// ota/docs/api-changes.md §3.2, OADR-0004 point 2). The route has its own JSON body limit of 10 KB (`JSON_BODY_LIMITS` of
// main.ts, body-parsers.ts); request bodies are logged nowhere (pino-http logs method, route, status and duration only,
// @velexis/logger), and the API sends no breadcrumbs anywhere (it has no Sentry client; ADR-0016): the card's paths are
// on the redaction list of @velexis/logger all the same. The global guards resolved the caller (the scope guard
// refuses every caller but the storefront edge), the tenant and the CSRF header; the validation interceptor checked the
// body against AirlineCardCompletionRequest (its field errors are paths and rules, never values); the idempotency
// interceptor claimed the `Idempotency-Key` with the card hashed as its brand and last 4 (AirlineCardCompletionIdempotency
// Hooks).
//
// The card of the body is checked (card-validation.ts) and wrapped in a SensitiveCard here, before anything else
// touches it; the plain `card` object is then taken off the request body, so nothing that reads the request later (the
// error filter, the interceptors after the handler) can reach it; and the SensitiveCard is discarded in `finally`,
// whatever the outcome. The answer is `201` CheckoutCompletion with `Location: /v1/bookings/<bkg_…>` and
// `Cache-Control: no-store`; a guest's booking token goes to the `__Host-vx_bt` cookie (GuestAccessService).
import { Controller, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { CheckoutCompletion } from "../../bookings/order-recorder";
import { CHECKOUT_CACHE_CONTROL } from "../../checkout/checkout.mapper";
import { Clock } from "../../common/clock";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../../common/http/openapi-operation.decorator";
import { AirlineCardCompletionService } from "./airline-card-completion.service";
import { checkAirlineCard, type CheckedCard } from "./card-validation";

/** Takes the plain `card` off a parsed body, so that only the SensitiveCard holds the card from here on. */
export function forgetCard(body: unknown): void {
  if (typeof body === "object" && body !== null && !Array.isArray(body) && Object.hasOwn(body, "card")) {
    Reflect.deleteProperty(body, "card");
  }
}

@Controller("v1/checkouts")
export class AirlineCardCompletionController {
  constructor(
    private readonly completion: AirlineCardCompletionService,
    private readonly clock: Clock,
  ) {}

  @Post(":checkoutId/airline-card-completion")
  @OpenApiOperation("completeCheckoutWithAirlineCard")
  async complete(
    @OpenApiInput() input: ValidatedInput<"completeCheckoutWithAirlineCard">,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CheckoutCompletion> {
    const body = input.body;
    if (body === undefined) {
      // The validation interceptor refuses a request without its body; never reached.
      throw new Error("completeCheckoutWithAirlineCard without a validated body");
    }
    const { paymentId, expectedTotal } = body;
    let checked: CheckedCard;
    try {
      checked = checkAirlineCard(body.card, this.clock.now());
    } finally {
      // Off the body whatever the check gave, a card it could not wrap included.
      forgetCard(body);
      forgetCard(req.body);
    }
    try {
      const completion = await this.completion.complete({
        checkoutId: input.path.checkoutId,
        paymentId,
        expectedTotal,
        card: checked,
        acceptLanguage: input.headers["Accept-Language"],
      });
      res.setHeader("Location", `/v1/bookings/${completion.booking.id}`);
      res.setHeader("Cache-Control", CHECKOUT_CACHE_CONTROL);
      return completion;
    } finally {
      // The card of this request ends here, whatever the outcome (OADR-0004 point 2).
      if (checked.ok) {
        checked.card.discard();
      }
    }
  }
}
