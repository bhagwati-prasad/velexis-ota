// `POST /webhooks/stripe/connect-accounts` (receiveStripeConnectAccountEvent, `x-scope: webhook`, `x-internal`; PBE-056,
// Stripe payments flow §C item 5, PADR-0011 item 3, api-inventory-admin.md §8): the Connect endpoint of the Velexis
// Stripe platform, subscribed in the Stripe dashboard to `account.updated` and `account.application.deauthorized` of
// the OTAs' connected Standard accounts only. The same inbox handling as the billing receiver
// (billing-webhook.controller.ts, PBE-043), with the inbox endpoint `connect_accounts` (the name of the CHECK of
// `stripe_events.endpoint`; the URL spells it `connect-accounts`):
//
// 1. StripeSignatureGuard("connect_accounts") checks `Stripe-Signature` on the raw body with
//    STRIPE_CONNECT_WEBHOOK_SECRET (`400 WEBHOOK_SIGNATURE_INVALID`, a security event);
// 2. the validation interceptor checks the event against the open `StripeConnectAccountEvent` schema, whose `account`
//    (the connected `acct_…`) is required: a body that is not a Connect event answers `400 VALIDATION_FAILED`;
// 3. StripeInboxService refuses a `livemode` of the other mode (`400 VALIDATION_FAILED`, `livemode_mismatch`), stores
//    the event once in `stripe_events` with its `account` (a database failure answers `500`, so Stripe retries) and
//    queues `stripe.event` once (the `stripe_events.sweep` scheduler queues a lost enqueue).
//
// The answer is `200 {received: true}` with `Cache-Control: no-store`, for a new event and a duplicate alike. Stripe is
// never called here: the worker's ConnectAccountEventsHandler (connect-account-events.handler.ts) re-fetches the account
// and updates the OTA's connections. Events are received whatever FEATURE_OWN_STRIPE says (PADR-0015 item 4); the
// processor ends them `ignored` while it is off.
import { Controller, HttpCode, Post, Res, UseGuards } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import type { Response } from "express";
import type Stripe from "stripe";
import { OpenApiOperation } from "../common/http/openapi-operation.decorator";
import { StripeInboxService } from "../common/stripe/stripe-inbox.service";
import { StripeSignatureGuard, VerifiedStripeEvent } from "../common/stripe/stripe-signature.guard";

/** The body of every `200`. */
export type StripeEventReceived = components["schemas"]["StripeEventReceived"];

@Controller("webhooks/stripe")
@UseGuards(StripeSignatureGuard("connect_accounts"))
export class ConnectWebhookController {
  constructor(private readonly inbox: StripeInboxService) {}

  @Post("connect-accounts")
  @HttpCode(200)
  @OpenApiOperation("receiveStripeConnectAccountEvent")
  async receive(
    @VerifiedStripeEvent() event: Stripe.Event,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StripeEventReceived> {
    await this.inbox.receive("connect_accounts", event);
    res.setHeader("Cache-Control", "no-store");
    return { received: true };
  }
}
