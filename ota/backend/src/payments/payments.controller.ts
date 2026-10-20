// `checkout.createPayment`, `checkout.getPayment` and `checkout.updatePayment` (createCheckoutPayment, getPayment,
// updatePayment; `x-scope: both`; OBE-038): thin handlers over PaymentsService. The global guards resolved the caller,
// the tenant, the scope and the signed-in customer, the CSRF guard checked the edge's POST and PATCH, the rate limit
// counts createPayment (10 per minute per IP, architecture §8), the validation interceptor checked the input against
// the OTA document, and the idempotency interceptor stores createPayment's `201` under its `Idempotency-Key` (a `502
// PAYMENT_PROVIDER_ERROR` is released, so the key can be sent again). Every answer says `Cache-Control: no-store`.
import { Controller, Get, Patch, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import { PAYMENT_CACHE_CONTROL, PaymentsService, type Payment } from "./payments.service";

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: string, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

@Controller("v1")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post("checkouts/:checkoutId/payments")
  @OpenApiOperation("createCheckoutPayment")
  async create(
    @OpenApiInput() input: ValidatedInput<"createCheckoutPayment">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Payment> {
    const payment = await this.payments.create({
      checkoutId: input.path.checkoutId,
      body: bodyOf("createCheckoutPayment", input.body),
      acceptLanguage: input.headers["Accept-Language"],
    });
    res.setHeader("Location", `/v1/payments/${payment.id}`);
    res.setHeader("Cache-Control", PAYMENT_CACHE_CONTROL);
    return payment;
  }

  @Get("payments/:paymentId")
  @OpenApiOperation("getPayment")
  async get(
    @OpenApiInput() input: ValidatedInput<"getPayment">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Payment> {
    const payment = await this.payments.get(input.path.paymentId);
    res.setHeader("Cache-Control", PAYMENT_CACHE_CONTROL);
    return payment;
  }

  @Patch("payments/:paymentId")
  @OpenApiOperation("updatePayment")
  async update(
    @OpenApiInput() input: ValidatedInput<"updatePayment">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Payment> {
    const payment = await this.payments.update({
      paymentId: input.path.paymentId,
      body: bodyOf("updatePayment", input.body),
      acceptLanguage: input.headers?.["Accept-Language"],
    });
    res.setHeader("Cache-Control", PAYMENT_CACHE_CONTROL);
    return payment;
  }
}
