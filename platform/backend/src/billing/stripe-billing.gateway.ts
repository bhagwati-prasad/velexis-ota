// The Stripe Billing gateway (PBE-044; platform/docs/architecture.md §2.1 BillingModule, §2.3 `*.gateway.ts`, PADR-0002
// items 1, 3 and 10, subscription-billing flow §B and §F): the three Stripe calls of the portal's billing, on the
// StripeClient of common/stripe (the `stripe` 18 SDK, its pinned API version, 10-second timeout and one network
// retry):
//
//   createCustomer         customers.create({email, name, metadata.velexis_tenant_id})       key `customer:<tenantId>`
//   createCheckoutSession  checkout.sessions.create(checkoutSessionParams(…), see below)     key `checkout:<tenantId>:<…>`
//   createPortalSession    billingPortal.sessions.create({customer, return_url})             key `portal_session:<tenantId>:<uuid>`
//
// Every POST carries its idempotency key (architecture §7): one Stripe Customer per tenant (`customer:<tenantId>`, so
// two first Checkouts of one OTA at once get the same Customer), and one Checkout Session per request key
// (`checkout:<tenantId>:<Idempotency-Key>`, PADR-0002 item 3), so a retried request opens the same page. A Customer
// Portal session signs its holder in, so each call makes a new one; its key only covers the SDK's network retry.
//
// Callers never hold a transaction open across these calls (architecture §2.3). A Stripe failure, or an answer the
// platform cannot use (a Checkout Session without a URL), throws StripeBillingFailure: the operation, Stripe's error
// type, HTTP status and code, whether a retry may help, and never Stripe's message, which may quote a parameter such
// as the owner's e-mail address. `providerError(failure)` turns it into the API's `502 PROVIDER_ERROR`
// (`details.provider = stripe`). Nothing here logs; a Checkout or Customer Portal URL is never logged anywhere.
import { Injectable } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import Stripe from "stripe";
import { StripeClient, StripeNotConfiguredError, type StripeApi } from "../common/stripe/stripe.client";

/** A Stripe call of this gateway. */
export type StripeBillingOperation =
  "customers.create" | "checkout.sessions.create" | "billingPortal.sessions.create";

/** The Velexis metadata of a Checkout Session and of the subscription it creates (PADR-0002 item 3). */
export interface CheckoutMetadata {
  /** `ten_…`. */
  readonly velexis_tenant_id: string;
  /** `sub_…` of the `incomplete` row written before the Checkout, when there is one. */
  readonly velexis_subscription_id?: string;
  readonly velexis_plan_code: string;
}

/** What a Checkout Session is made of (subscription-billing flow §B item 3). */
export interface CheckoutSessionInput {
  readonly tenantId: string;
  /** `cus_…`: the OTA's Stripe Customer (`billing_customers`). */
  readonly customerId: string;
  /** `price_…`: the plan's Stripe Price for the chosen interval. */
  readonly priceId: string;
  readonly planCode: string;
  /** The pre-inserted `incomplete` subscription row, or `null` when the webhook will insert the Stripe row. */
  readonly subscriptionId: string | null;
  /** `plans.trial_days` on the tenant's first Stripe subscription; `null` for none. */
  readonly trialDays: number | null;
  /** `<PUBLIC_PORTAL_URL>/otas/<tenantId>/setup?checkout=success`. */
  readonly successUrl: string;
  /** `<PUBLIC_PORTAL_URL>/otas/<tenantId>/billing?checkout=canceled`. */
  readonly cancelUrl: string;
}

/** The parameters of `checkout.sessions.create`, fixed in code (PADR-0002 item 3). */
export type CheckoutSessionParams = Stripe.Checkout.SessionCreateParams;

/**
 * The parameters of the Checkout Session of `input`: subscription mode, the OTA's Customer, one line item, the OTA id
 * as `client_reference_id`, the Velexis metadata on the session and on the subscription, the trial only when
 * `trialDays` is a positive number, a payment method always collected (also during a trial), no promotion codes, no
 * automatic tax, and the portal's success and cancel URLs.
 */
export function checkoutSessionParams(input: CheckoutSessionInput): CheckoutSessionParams {
  const metadata: CheckoutMetadata = {
    velexis_tenant_id: input.tenantId,
    ...(input.subscriptionId === null ? {} : { velexis_subscription_id: input.subscriptionId }),
    velexis_plan_code: input.planCode,
  };
  const trial = input.trialDays !== null && input.trialDays > 0 ? { trial_period_days: input.trialDays } : {};
  return {
    mode: "subscription",
    customer: input.customerId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    client_reference_id: input.tenantId,
    metadata: { ...metadata },
    subscription_data: { metadata: { ...metadata }, ...trial },
    payment_method_collection: "always",
    allow_promotion_codes: false,
    automatic_tax: { enabled: false },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
}

/** The Stripe Customer of an OTA, as created. */
export interface CreatedCustomer {
  /** `cus_…`. */
  readonly id: string;
  readonly livemode: boolean;
}

/** A Checkout Session, as created. */
export interface CreatedCheckoutSession {
  /** `cs_…`. */
  readonly id: string;
  /** The Stripe Checkout page. Never logged. */
  readonly url: string;
  /** When Stripe expires the session (24 hours after its creation by default). */
  readonly expiresAt: Date;
}

/** A Customer Portal session, as created. */
export interface CreatedPortalSession {
  /** The Customer Portal URL; it signs its holder in for a few minutes, so it is never logged or stored. */
  readonly url: string;
}

/** A Stripe call of the gateway that failed, or answered something unusable (see the file header). */
export class StripeBillingFailure extends Error {
  override readonly name = "StripeBillingFailure";

  constructor(
    readonly operation: StripeBillingOperation,
    /** `<type> <status> (<code>)`, for example `api_error 503`; never Stripe's message. */
    readonly summary: string,
    /** True for a network failure, a rate limit or a 5xx: the same call may work later. */
    readonly retryable: boolean,
  ) {
    super(`Stripe ${operation} failed: ${summary}`);
  }
}

/** True when `value` is a short lower-case identifier of Stripe (an error type or code), safe to log. */
const isStripeIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z_]{1,60}$/.test(value);

/** The StripeBillingFailure of an error thrown by the SDK (or by StripeClient) during `operation`. */
export function stripeBillingFailureOf(
  operation: StripeBillingOperation,
  error: unknown,
): StripeBillingFailure {
  if (error instanceof StripeBillingFailure) {
    return error;
  }
  if (error instanceof StripeNotConfiguredError) {
    return new StripeBillingFailure(operation, "not_configured (STRIPE_SECRET_KEY is not set)", false);
  }
  if (error instanceof Stripe.errors.StripeError) {
    const status = error.statusCode;
    const connection = error instanceof Stripe.errors.StripeConnectionError;
    const retryable =
      connection ||
      error instanceof Stripe.errors.StripeRateLimitError ||
      error instanceof Stripe.errors.StripeAPIError ||
      status === 429 ||
      (status !== undefined && status >= 500);
    const rawType: unknown = error.rawType;
    const type = connection ? "connection_error" : isStripeIdentifier(rawType) ? rawType : "error";
    const code = isStripeIdentifier(error.code) ? ` (${error.code})` : "";
    return new StripeBillingFailure(
      operation,
      `${type} ${status === undefined ? "no_status" : String(status)}${code}`,
      retryable,
    );
  }
  const name = error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "Error";
  return new StripeBillingFailure(operation, `unexpected ${name}`, false);
}

/** The API's `502 PROVIDER_ERROR` for a Stripe failure: `details.provider = stripe`, the failure as the logged cause. */
export function providerError(failure: StripeBillingFailure): AppError {
  return new AppError("PROVIDER_ERROR", { details: { provider: "stripe" }, cause: failure });
}

@Injectable()
export class StripeBillingGateway {
  constructor(private readonly stripe: StripeClient) {}

  /**
   * Creates the Stripe Customer of `tenantId` (PADR-0002 item 1): the owner's e-mail address, the OTA's legal name or
   * name, and `metadata.velexis_tenant_id`, with the idempotency key `idempotencyKey`.
   */
  async createCustomer(
    input: { readonly tenantId: string; readonly email: string; readonly name: string },
    idempotencyKey: string,
  ): Promise<CreatedCustomer> {
    const customer = await this.call("customers.create", (api) =>
      api.customers.create(
        { email: input.email, name: input.name, metadata: { velexis_tenant_id: input.tenantId } },
        { idempotencyKey },
      ),
    );
    return { id: customer.id, livemode: customer.livemode };
  }

  /** Creates the Checkout Session of `params` with the idempotency key `idempotencyKey`. */
  async createCheckoutSession(
    params: CheckoutSessionParams,
    idempotencyKey: string,
  ): Promise<CreatedCheckoutSession> {
    const operation = "checkout.sessions.create";
    const session = await this.call(operation, (api) =>
      api.checkout.sessions.create(params, { idempotencyKey }),
    );
    if (typeof session.url !== "string" || session.url.length === 0) {
      throw new StripeBillingFailure(operation, "the session has no URL", false);
    }
    return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000) };
  }

  /** Creates a Customer Portal session of `customerId` that returns to `returnUrl`. */
  async createPortalSession(
    input: { readonly customerId: string; readonly returnUrl: string },
    idempotencyKey: string,
  ): Promise<CreatedPortalSession> {
    const operation = "billingPortal.sessions.create";
    const session = await this.call(operation, (api) =>
      api.billingPortal.sessions.create(
        { customer: input.customerId, return_url: input.returnUrl },
        { idempotencyKey },
      ),
    );
    if (typeof session.url !== "string" || session.url.length === 0) {
      throw new StripeBillingFailure(operation, "the session has no URL", false);
    }
    return { url: session.url };
  }

  /** Runs one Stripe call; any error becomes a StripeBillingFailure of `operation`. */
  private async call<T>(operation: StripeBillingOperation, run: (api: StripeApi) => Promise<T>): Promise<T> {
    try {
      return await run(this.stripe.api());
    } catch (error) {
      throw stripeBillingFailureOf(operation, error);
    }
  }
}
