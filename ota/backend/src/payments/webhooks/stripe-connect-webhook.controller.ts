// `POST /webhooks/stripe/connect/{environment}` (receiveStripeConnectWebhook, `x-internal`; OBE-078, OADR-0010 point
// 4): Stripe's deliveries for the OTAs' accounts connected to the Velexis platform with Stripe Connect Standard
// (`connect_standard` mode), signed with STRIPE_WEBHOOK_SECRET_CONNECT_<ENV>. A thin handler over
// WebhookReceiverService.receiveConnect, which takes the tenant only from `event.account` (the `connect_standard`
// connection of the environment with that `account_reference`), never from the metadata.
//
// As the Velexis endpoint's (stripe-velexis-webhook.controller.ts): no credential (`@WebhookRoute()`), the raw body
// (body-parsers.ts: a Buffer on `/webhooks/*`, never parsed before the signature check), the path's environment and
// `Stripe-Signature` checked against the OTA document by the validation interceptor, no rate limit and no idempotency
// key (Stripe's event id de-duplicates). Every verified delivery, also one acknowledged without effect, answers `200
// {received: true}` with `Cache-Control: no-store`, so Stripe stops sending it.
import { Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { WebhookRoute } from "../../common/auth/caller.guard";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../../common/http/openapi-operation.decorator";
import type { WebhookAcknowledgement } from "./stripe-velexis-webhook.controller";
import { WebhookReceiverService } from "./webhook-receiver.service";

@Controller("webhooks/stripe")
export class StripeConnectWebhookController {
  constructor(private readonly receiver: WebhookReceiverService) {}

  @Post("connect/:environment")
  @HttpCode(200)
  @WebhookRoute()
  @OpenApiOperation("receiveStripeConnectWebhook")
  async receive(
    @OpenApiInput() input: ValidatedInput<"receiveStripeConnectWebhook">,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebhookAcknowledgement> {
    // The raw bytes the signature covers, as the body parser left them (the validated input holds the same Buffer).
    const rawBody: unknown = req.body;
    await this.receiver.receiveConnect(input.path.environment, rawBody, input.headers["Stripe-Signature"]);
    res.setHeader("Cache-Control", "no-store");
    return { received: true };
  }
}
