// `StripeSignatureGuard(endpoint)` (PBE-043; platform/docs/architecture.md §3 step 5, the `webhook` scope; PADR-0002
// item 4, AGENTS.md §8 "Webhooks verify signatures on the raw body"): the auth guard of a Stripe webhook receiver.
//
//   @Controller("webhooks/stripe")
//   @UseGuards(StripeSignatureGuard("billing"))
//   export class BillingWebhookController { … @VerifiedStripeEvent() event: Stripe.Event … }
//
// It checks `Stripe-Signature` on the raw body that the JSON parser keeps on `/webhooks/*` (raw-body.ts), with the
// endpoint's signing secret (STRIPE_WEBHOOK_SECRET_VARIABLES) and Stripe's tolerance of 5 minutes measured on the
// process's Clock, with `Stripe.webhooks.constructEvent`: no key, no network. It runs before the validation
// interceptor, so nothing of an unsigned body is read. A missing secret, body or header, a signature of another secret,
// a body changed after signing, or a timestamp outside the tolerance answers `400 WEBHOOK_SIGNATURE_INVALID` and is
// logged as a security event (`stripe.webhook_signature_invalid` with the endpoint, the reason and the caller's IP;
// never the body, the header or the secret: Stripe's own error quotes them, so only its kind is kept). The verified
// event stays on the request for the handler (`@VerifiedStripeEvent()`).
import {
  createParamDecorator,
  Injectable,
  mixin,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import type { Request } from "express";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import type { PlatformBackendConfig } from "../../config";
import { Clock } from "../clock";
import { rawBodyOf } from "../http/raw-body";
import { RequestContext } from "../http/request-context";
import { STRIPE_ENDPOINTS, type StripeEndpoint } from "./stripe-events.repository";

/** The signing secret of each endpoint (config.ts). */
export const STRIPE_WEBHOOK_SECRET_VARIABLES = Object.freeze({
  billing: "STRIPE_BILLING_WEBHOOK_SECRET",
  connect_accounts: "STRIPE_CONNECT_WEBHOOK_SECRET",
} as const satisfies Record<StripeEndpoint, keyof PlatformBackendConfig>);

/** Stripe's default tolerance between the signature's timestamp and the receipt. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The longest `Stripe-Signature` header read (the OpenAPI parameter's maxLength). */
export const STRIPE_SIGNATURE_MAX_LENGTH = 4096;

/** Why a delivery was refused, as the security event says. */
export type SignatureRefusal =
  "secret_missing" | "no_body" | "no_signature" | "signature_mismatch" | "unreadable";

/** The verified event on the request. */
const VERIFIED_EVENT = Symbol("velexis:verified-stripe-event");

/** The event StripeSignatureGuard verified on this request, or `undefined`. */
export function verifiedStripeEventOf(request: object): Stripe.Event | undefined {
  const event: unknown = Reflect.get(request, VERIFIED_EVENT);
  return event === undefined ? undefined : (event as Stripe.Event);
}

/**
 * The verified event of a webhook handler: `@VerifiedStripeEvent() event: Stripe.Event`. Throws on a handler whose
 * route has no StripeSignatureGuard.
 */
export const VerifiedStripeEvent = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Stripe.Event => {
    const event = verifiedStripeEventOf(context.switchToHttp().getRequest<object>());
    if (event === undefined) {
      throw new Error("@VerifiedStripeEvent(): no StripeSignatureGuard verified this request");
    }
    return event;
  },
);

/** The error of every refused delivery. */
function signatureInvalid(): AppError {
  return new AppError("WEBHOOK_SIGNATURE_INVALID");
}

const guards = new Map<StripeEndpoint, Type<CanActivate>>();

/** The guard of `endpoint` (one class per endpoint, so Nest builds each once). */
export function StripeSignatureGuard(endpoint: StripeEndpoint): Type<CanActivate> {
  if (!(STRIPE_ENDPOINTS as readonly string[]).includes(endpoint)) {
    throw new TypeError("StripeSignatureGuard(): not a Stripe webhook endpoint");
  }
  const existing = guards.get(endpoint);
  if (existing !== undefined) {
    return existing;
  }

  @Injectable()
  class EndpointSignatureGuard implements CanActivate {
    private readonly secret: string | undefined;

    constructor(
      config: ConfigService<PlatformBackendConfig, true>,
      private readonly clock: Clock,
      private readonly requestContext: RequestContext,
      @InjectPinoLogger("StripeSignatureGuard") private readonly logger: PinoLogger,
    ) {
      this.secret = config.get(STRIPE_WEBHOOK_SECRET_VARIABLES[endpoint], { infer: true });
    }

    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<Request>();
      const raw = rawBodyOf(request);
      const header = request.headers["stripe-signature"];
      if (this.secret === undefined) {
        this.logger.error(
          { endpoint, variable: STRIPE_WEBHOOK_SECRET_VARIABLES[endpoint] },
          "stripe.webhook_secret_missing",
        );
        return this.refuse("secret_missing");
      }
      if (raw === undefined || raw.length === 0) {
        return this.refuse("no_body");
      }
      if (typeof header !== "string" || header.length === 0 || header.length > STRIPE_SIGNATURE_MAX_LENGTH) {
        return this.refuse("no_signature");
      }
      let event: Stripe.Event;
      try {
        event = Stripe.webhooks.constructEvent(
          raw,
          header,
          this.secret,
          STRIPE_SIGNATURE_TOLERANCE_SECONDS,
          undefined,
          this.clock.now().getTime(),
        );
      } catch (error) {
        return this.refuse(
          error instanceof Stripe.errors.StripeSignatureVerificationError
            ? "signature_mismatch"
            : "unreadable",
        );
      }
      Reflect.set(request, VERIFIED_EVENT, event);
      return true;
    }

    /** Logs the security event and throws `400 WEBHOOK_SIGNATURE_INVALID`. */
    private refuse(reason: SignatureRefusal): never {
      this.logger.warn(
        {
          securityEvent: "stripe.webhook_signature_invalid",
          endpoint,
          reason,
          ip: this.requestContext.ip,
        },
        "stripe.webhook_signature_invalid",
      );
      throw signatureInvalid();
    }
  }

  const guard = mixin(EndpointSignatureGuard);
  guards.set(endpoint, guard);
  return guard;
}
