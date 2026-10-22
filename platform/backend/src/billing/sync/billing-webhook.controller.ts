// `POST /webhooks/stripe/billing` (receiveStripeBillingEvent, `x-scope: webhook`, `x-internal`; PBE-043,
// subscription-billing flow §C, PADR-0002 item 4): the endpoint of the Velexis Stripe account for subscription billing.
// A thin handler over the inbox of common/stripe:
//
// 1. StripeSignatureGuard("billing") checks `Stripe-Signature` on the raw body with STRIPE_BILLING_WEBHOOK_SECRET
//    (`400 WEBHOOK_SIGNATURE_INVALID`, a security event);
// 2. the validation interceptor checks the event against the open `StripeEvent` schema (`400 VALIDATION_FAILED`);
// 3. StripeInboxService refuses a `livemode` of the other mode (`400 VALIDATION_FAILED`, `livemode_mismatch`), stores
//    the event once in `stripe_events` (a database failure answers `500`, so Stripe retries) and queues
//    `stripe.event` once (a lost enqueue is queued by the `stripe_events.sweep` scheduler).
//
// The answer is `200 {received: true}`, for a new event and a duplicate alike, with `Cache-Control: no-store`. No rate
// limit and no idempotency key apply: Stripe is the only caller, its event id de-duplicates, and the signature check
// comes first. Stripe is never called here; the worker re-fetches the object (stripe-events.processor.ts). The events
// are received whatever FEATURE_STRIPE_BILLING says (PADR-0015 item 4).
import { Controller, HttpCode, Post, Res, UseGuards } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import type { Response } from "express";
import type Stripe from "stripe";
import { OpenApiOperation } from "../../common/http/openapi-operation.decorator";
import { StripeInboxService } from "../../common/stripe/stripe-inbox.service";
import { StripeSignatureGuard, VerifiedStripeEvent } from "../../common/stripe/stripe-signature.guard";

/** The body of every `200`. */
export type StripeEventReceived = components["schemas"]["StripeEventReceived"];

@Controller("webhooks/stripe")
@UseGuards(StripeSignatureGuard("billing"))
export class BillingWebhookController {
  constructor(private readonly inbox: StripeInboxService) {}

  @Post("billing")
  @HttpCode(200)
  @OpenApiOperation("receiveStripeBillingEvent")
  async receive(
    @VerifiedStripeEvent() event: Stripe.Event,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StripeEventReceived> {
    await this.inbox.receive("billing", event);
    res.setHeader("Cache-Control", "no-store");
    return { received: true };
  }
}
