// `POST /webhooks/stripe/c/{connectionId}` (receiveStripeConnectionWebhook, `x-internal`; OBE-078, OADR-0010 point 4):
// Stripe's deliveries for an OTA's own Stripe account in `api_keys` mode, at the URL the portal gave the OTA for its
// Stripe dashboard (`https://api.ota.example.com/webhooks/stripe/c/<ppc_id>`, PADR-0011 point 5). A thin handler over
// WebhookReceiverService.receiveConnection, which verifies the signature with that connection's own signing secret
// (decrypted in the receiver only) and takes the tenant only from the path's connection, never from the metadata. An
// unknown connection id, a connection that is not in `api_keys` mode or has no secret answer the same `400` as a wrong
// signature.
//
// As the Velexis endpoint's (stripe-velexis-webhook.controller.ts): no credential (`@WebhookRoute()`), the raw body
// (body-parsers.ts: a Buffer on `/webhooks/*`), the path's connection id (`ppc_` and a ULID) and `Stripe-Signature`
// checked against the OTA document by the validation interceptor, no rate limit and no idempotency key. Every verified
// delivery, also one acknowledged without effect, answers `200 {received: true}` with `Cache-Control: no-store`.
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
export class StripeConnectionWebhookController {
  constructor(private readonly receiver: WebhookReceiverService) {}

  @Post("c/:connectionId")
  @HttpCode(200)
  @WebhookRoute()
  @OpenApiOperation("receiveStripeConnectionWebhook")
  async receive(
    @OpenApiInput() input: ValidatedInput<"receiveStripeConnectionWebhook">,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebhookAcknowledgement> {
    // The raw bytes the signature covers, as the body parser left them (the validated input holds the same Buffer).
    const rawBody: unknown = req.body;
    await this.receiver.receiveConnection(
      input.path.connectionId,
      rawBody,
      input.headers["Stripe-Signature"],
    );
    res.setHeader("Cache-Control", "no-store");
    return { received: true };
  }
}
