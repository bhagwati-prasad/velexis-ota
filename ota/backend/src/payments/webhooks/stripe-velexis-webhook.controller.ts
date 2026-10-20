// `POST /webhooks/stripe/velexis/{environment}` (receiveStripeVelexisWebhook, `x-internal`; OBE-039, OADR-0010 point
// 4): Stripe's deliveries for the Velexis account. A thin handler over WebhookReceiverService.
//
// The request reaches it without a credential (`@WebhookRoute()`: the caller guard classifies the anonymous caller,
// and the tenant, scope and customer guards leave it alone), with its body as raw bytes (body-parsers.ts: a Buffer on
// `/webhooks/*`, never parsed as JSON before the signature check). The validation interceptor checks the path's
// environment (`test` or `live`) and the presence of `Stripe-Signature` against the OTA document, and passes the Buffer
// through untouched. No rate limit counts it (rate-limits.ts: the anonymous caller of a webhook route) and no
// idempotency key applies (Stripe's event id de-duplicates). The answer is `200 {received: true}` for every verified
// delivery, also one acknowledged without effect, so Stripe stops sending it; `Cache-Control: no-store`.
import { Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import type { Request, Response } from "express";
import { WebhookRoute } from "../../common/auth/caller.guard";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../../common/http/openapi-operation.decorator";
import { WebhookReceiverService } from "./webhook-receiver.service";

/** The body of every `200`. */
export type WebhookAcknowledgement = components["schemas"]["WebhookAcknowledgement"];

@Controller("webhooks/stripe")
export class StripeVelexisWebhookController {
  constructor(private readonly receiver: WebhookReceiverService) {}

  @Post("velexis/:environment")
  @HttpCode(200)
  @WebhookRoute()
  @OpenApiOperation("receiveStripeVelexisWebhook")
  async receive(
    @OpenApiInput() input: ValidatedInput<"receiveStripeVelexisWebhook">,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebhookAcknowledgement> {
    // The raw bytes the signature covers, as the body parser left them (the validated input holds the same Buffer).
    const rawBody: unknown = req.body;
    await this.receiver.receiveVelexis(input.path.environment, rawBody, input.headers["Stripe-Signature"]);
    res.setHeader("Cache-Control", "no-store");
    return { received: true };
  }
}
