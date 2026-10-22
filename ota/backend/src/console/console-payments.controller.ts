// `console.payments.list`, `.get`, `.capture` and `.refund` (consoleListPayments, consoleGetPayment,
// consoleCapturePayment, consoleRefundPayment; `x-scope: console`, `x-permission` `payments:read`, `payments:capture`
// and `payments:refund`; OBE-068): thin handlers over ConsolePaymentsService (console-payments.service.ts). The global
// guards resolved the caller (the OTA admin's service key with a staff token, a secret key with a staff token, or a
// `console:automation` key), the tenant and its environment, the staff member, the rate limits and the permission
// (OADR-0011 points 3 to 6); the validation interceptor checked the input against the OTA document, and the
// idempotency interceptor holds the `Idempotency-Key` of capture and refund. Every answer is `Cache-Control: private,
// no-store`; get and capture carry `ETag: "<version>"` (the If-Match of capture), refund answers `201` with `Location`
// (the payment, where the refund's status can be followed) and the payment's `ETag`. The reads opt in to no audit:
// they return no personal data of one person (OADR-0011 point 8 as decided on 2026-10-21).
import { Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  CONSOLE_PAYMENT_CACHE_CONTROL,
  ConsolePaymentsService,
  paymentEtagOf,
  type ConsolePayment,
  type ConsolePaymentPage,
} from "./console-payments.service";

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: string, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

@Controller("v1/console/payments")
export class ConsolePaymentsController {
  constructor(private readonly payments: ConsolePaymentsService) {}

  @Get()
  @OpenApiOperation("consoleListPayments")
  async list(
    @OpenApiInput() input: ValidatedInput<"consoleListPayments">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsolePaymentPage> {
    res.setHeader("Cache-Control", CONSOLE_PAYMENT_CACHE_CONTROL);
    return await this.payments.list(input.query ?? {});
  }

  @Get(":paymentId")
  @OpenApiOperation("consoleGetPayment")
  async get(
    @OpenApiInput() input: ValidatedInput<"consoleGetPayment">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsolePayment> {
    const payment = await this.payments.get(input.path.paymentId, { refresh: input.query?.refresh === true });
    res.setHeader("ETag", paymentEtagOf(payment.version));
    res.setHeader("Cache-Control", CONSOLE_PAYMENT_CACHE_CONTROL);
    return payment;
  }

  @Post(":paymentId/capture")
  @HttpCode(200)
  @OpenApiOperation("consoleCapturePayment")
  async capture(
    @OpenApiInput() input: ValidatedInput<"consoleCapturePayment">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsolePayment> {
    const payment = await this.payments.capture(
      input.path.paymentId,
      input.headers["If-Match"],
      bodyOf("consoleCapturePayment", input.body),
    );
    res.setHeader("ETag", paymentEtagOf(payment.version));
    res.setHeader("Cache-Control", CONSOLE_PAYMENT_CACHE_CONTROL);
    return payment;
  }

  @Post(":paymentId/refunds")
  @OpenApiOperation("consoleRefundPayment")
  async refund(
    @OpenApiInput() input: ValidatedInput<"consoleRefundPayment">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsolePayment> {
    const payment = await this.payments.refund(
      input.path.paymentId,
      bodyOf("consoleRefundPayment", input.body),
    );
    res.setHeader("Location", `/v1/console/payments/${payment.id}`);
    res.setHeader("ETag", paymentEtagOf(payment.version));
    res.setHeader("Cache-Control", CONSOLE_PAYMENT_CACHE_CONTROL);
    return payment;
  }
}
