// `checkout.create`, `checkout.get`, `checkout.setTravelers`, `checkout.setContacts` and `checkout.setRemarks`
// (createCheckout, getCheckout, setCheckoutTravelers, setCheckoutContacts, setCheckoutRemarks; `x-scope: both`;
// OBE-036): thin handlers over CheckoutService. The global guards resolved the caller, the tenant, the scope and the
// signed-in customer (optional on every checkout operation), the CSRF guard checked the edge's POST and PUTs, the
// validation interceptor checked the input against the OTA document, and the idempotency interceptor stores
// checkout.create's `201` under its `Idempotency-Key` (the `PUT`s are idempotent by themselves). Every answer is the
// whole checkout with `ETag: "<version>"` and `Cache-Control: no-store`; `If-Match` goes to the service.
//
// `checkout.setAncillaries` (setCheckoutAncillaries, `x-scope: both`; OBE-037) is AncillariesService's: the extras
// re-priced with Amadeus into a child priced offer, answered like the other steps.
//
// `checkout.complete` (completeCheckout, `x-scope: both`; OBE-042) hands the checkout to the bookings module's
// BookingOrchestrator; its `Idempotency-Key` is required (the OTA document's IdempotencyKey parameter, checked by the
// validation interceptor), and the idempotency interceptor replays a same-key retry without a second order. The answer
// is `201` CheckoutCompletion with `Location: /v1/bookings/<bkg_…>` and `Cache-Control: no-store`.
import { Controller, Get, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import { BookingOrchestrator } from "../bookings/booking-orchestrator.service";
import type { CheckoutCompletion } from "../bookings/order-recorder";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import { AncillariesService } from "./ancillaries.service";
import { CHECKOUT_CACHE_CONTROL, etagOf, type Checkout } from "./checkout.mapper";
import { CheckoutService } from "./checkout.service";

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: string, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

/** The headers of every checkout answer. */
function answer(res: Response, checkout: Checkout): Checkout {
  res.setHeader("ETag", etagOf(checkout.version));
  res.setHeader("Cache-Control", CHECKOUT_CACHE_CONTROL);
  return checkout;
}

@Controller("v1/checkouts")
export class CheckoutController {
  constructor(
    private readonly checkouts: CheckoutService,
    private readonly bookings: BookingOrchestrator,
    private readonly ancillaries: AncillariesService,
  ) {}

  @Post()
  @OpenApiOperation("createCheckout")
  async create(
    @OpenApiInput() input: ValidatedInput<"createCheckout">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Checkout> {
    const checkout = await this.checkouts.create({
      body: bodyOf("createCheckout", input.body),
      acceptLanguage: input.headers["Accept-Language"],
    });
    res.setHeader("Location", `/v1/checkouts/${checkout.id}`);
    return answer(res, checkout);
  }

  @Get(":checkoutId")
  @OpenApiOperation("getCheckout")
  async get(
    @OpenApiInput() input: ValidatedInput<"getCheckout">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Checkout> {
    return answer(res, await this.checkouts.get(input.path.checkoutId, input.headers?.["Accept-Language"]));
  }

  @Put(":checkoutId/travelers")
  @OpenApiOperation("setCheckoutTravelers")
  async setTravelers(
    @OpenApiInput() input: ValidatedInput<"setCheckoutTravelers">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Checkout> {
    const checkout = await this.checkouts.setTravelers({
      checkoutId: input.path.checkoutId,
      ifMatch: input.headers?.["If-Match"],
      acceptLanguage: input.headers?.["Accept-Language"],
      body: bodyOf("setCheckoutTravelers", input.body),
    });
    return answer(res, checkout);
  }

  @Put(":checkoutId/contacts")
  @OpenApiOperation("setCheckoutContacts")
  async setContacts(
    @OpenApiInput() input: ValidatedInput<"setCheckoutContacts">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Checkout> {
    const checkout = await this.checkouts.setContacts({
      checkoutId: input.path.checkoutId,
      ifMatch: input.headers?.["If-Match"],
      acceptLanguage: input.headers?.["Accept-Language"],
      body: bodyOf("setCheckoutContacts", input.body),
    });
    return answer(res, checkout);
  }

  @Put(":checkoutId/ancillaries")
  @OpenApiOperation("setCheckoutAncillaries")
  async setAncillaries(
    @OpenApiInput() input: ValidatedInput<"setCheckoutAncillaries">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Checkout> {
    const checkout = await this.ancillaries.setAncillaries({
      checkoutId: input.path.checkoutId,
      ifMatch: input.headers?.["If-Match"],
      acceptLanguage: input.headers?.["Accept-Language"],
      body: bodyOf("setCheckoutAncillaries", input.body),
    });
    return answer(res, checkout);
  }

  @Put(":checkoutId/remarks")
  @OpenApiOperation("setCheckoutRemarks")
  async setRemarks(
    @OpenApiInput() input: ValidatedInput<"setCheckoutRemarks">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Checkout> {
    const checkout = await this.checkouts.setRemarks({
      checkoutId: input.path.checkoutId,
      ifMatch: input.headers?.["If-Match"],
      acceptLanguage: input.headers?.["Accept-Language"],
      body: bodyOf("setCheckoutRemarks", input.body),
    });
    return answer(res, checkout);
  }

  @Post(":checkoutId/complete")
  @OpenApiOperation("completeCheckout")
  async complete(
    @OpenApiInput() input: ValidatedInput<"completeCheckout">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CheckoutCompletion> {
    const completion = await this.bookings.complete({
      checkoutId: input.path.checkoutId,
      body: bodyOf("completeCheckout", input.body),
      acceptLanguage: input.headers["Accept-Language"],
    });
    res.setHeader("Location", `/v1/bookings/${completion.booking.id}`);
    res.setHeader("Cache-Control", CHECKOUT_CACHE_CONTROL);
    return completion;
  }
}
