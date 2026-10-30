// The Stripe client of the platform backend (PBE-043; platform/docs/architecture.md §7 "Stripe", PADR-0002 item 10,
// ADR-0013). Every Stripe call of the platform goes through `StripeClient.api()`: the `stripe` Node SDK 18 with the
// secret key of the Velexis account (STRIPE_SECRET_KEY) and always
//
//   apiVersion          STRIPE_API_VERSION, pinned here: an SDK upgrade never changes the API version silently, and the
//                       webhook endpoints in the Stripe dashboard are created with the same version (an upgrade is a
//                       task with fixture updates, PADR-0002 item 10)
//   timeout             10 s per attempt
//   maxNetworkRetries   1 (safe: every POST carries an idempotency key)
//   telemetry           off (no request timings sent to Stripe)
//
// Every POST passes `{ idempotencyKey: idempotencyKey(purpose, rowId) }`, `<purpose>:<rowId>` (for example
// `checkout:<tenantId>:<Idempotency-Key>`), so a retried job or request never creates a second Stripe object.
// `test/support/fake-stripe.ts` refuses a POST without one.
//
// `StripeApi` names the few calls the platform makes, so tests replace the whole client with the injectable fake of
// `test/support/fake-stripe.ts` (`{ provide: StripeClient, useValue: new FakeStripe() }`) and nothing reaches Stripe.
// The tasks that add calls (Connect, settlements) add them to StripeApi and to the fake. Webhook signatures are
// checked without the client (`Stripe.webhooks`, stripe-signature.guard.ts): they need no key and no network.
//
// Without STRIPE_SECRET_KEY (every switch that needs Stripe off, config.ts) the client is not configured and `api()`
// throws StripeNotConfiguredError. The key stays in this file: no getter returns it and nothing logs it.
import { Injectable, type ClassProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import type { PlatformBackendConfig } from "../../config";

/** The Stripe API version of every request: the version the installed `stripe` 18 SDK is typed for. */
export const STRIPE_API_VERSION = "2025-08-27.basil" satisfies Stripe.LatestApiVersion;

/** Per-attempt timeout of a Stripe request (architecture §7). */
export const STRIPE_TIMEOUT_MS = 10_000;

/** Network retries of the SDK, each with the request's own idempotency key. */
export const STRIPE_MAX_NETWORK_RETRIES = 1;

/** Stripe refuses idempotency keys longer than this. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** A purpose: lower-case words with `_`, `.` or `-` (`checkout`, `customer`, `portal_session`). */
const PURPOSE = /^[a-z][a-z0-9_.-]{0,62}$/;
/** A row id (or ids joined by `:`): printable ASCII without spaces. */
const ROW_ID = /^[\x21-\x7e]+$/;

/**
 * The Stripe idempotency key of a POST: `<purpose>:<rowId>`, the row being the platform row the call is made for
 * (architecture §7). The same purpose and row always give the same key, so Stripe answers a repeated call with the
 * object of the first one. Throws for a purpose or row id of another shape, or a key over 255 characters.
 */
export function idempotencyKey(purpose: string, rowId: string): string {
  if (!PURPOSE.test(purpose)) {
    throw new TypeError("idempotencyKey: the purpose must be lower-case words such as `checkout`");
  }
  if (!ROW_ID.test(rowId)) {
    throw new TypeError("idempotencyKey: the row id must be printable ASCII without spaces");
  }
  const key = `${purpose}:${rowId}`;
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new RangeError(`idempotencyKey: the key is longer than ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  }
  return key;
}

/**
 * The Stripe calls the platform makes (subscription-billing flow §A, §B, §D, §F; the settlements of the Stripe
 * payments flow §F: the balance transactions, and the charges and PaymentIntents their tenant is read from, PBE-059):
 * the SDK's own method types, so the real client is a StripeApi as it is and the fake of a test implements exactly
 * these.
 */
export interface StripeApi {
  readonly customers: Pick<Stripe.CustomersResource, "create" | "retrieve" | "search">;
  readonly checkout: { readonly sessions: Pick<Stripe.Checkout.SessionsResource, "create" | "retrieve"> };
  readonly billingPortal: { readonly sessions: Pick<Stripe.BillingPortal.SessionsResource, "create"> };
  readonly subscriptions: Pick<Stripe.SubscriptionsResource, "retrieve">;
  readonly invoices: Pick<Stripe.InvoicesResource, "retrieve">;
  readonly prices: Pick<Stripe.PricesResource, "retrieve">;
  readonly balanceTransactions: Pick<Stripe.BalanceTransactionsResource, "list">;
  readonly charges: Pick<Stripe.ChargesResource, "retrieve">;
  readonly paymentIntents: Pick<Stripe.PaymentIntentsResource, "retrieve">;
}

/** The options every SDK client is created with (exported for the client's test). */
export function stripeClientOptions(): Stripe.StripeConfig {
  return {
    apiVersion: STRIPE_API_VERSION,
    timeout: STRIPE_TIMEOUT_MS,
    maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
    telemetry: false,
    appInfo: { name: "velexis-platform-backend" },
  };
}

/** `api()` without STRIPE_SECRET_KEY: a programming or configuration error, never a Stripe answer. */
export class StripeNotConfiguredError extends Error {
  override readonly name = "StripeNotConfiguredError";

  constructor() {
    super("STRIPE_SECRET_KEY is not set: the platform has no Stripe client");
  }
}

/**
 * The Stripe client of a process (the injection token, too). The application provides SdkStripeClient
 * (`stripeClientProvider`); tests provide the FakeStripe of `test/support/fake-stripe.ts`.
 */
export abstract class StripeClient {
  /** True when STRIPE_SECRET_KEY is set, so `api()` works. */
  abstract isConfigured(): boolean;

  /** The calls on the Velexis account; throws StripeNotConfiguredError when STRIPE_SECRET_KEY is unset. */
  abstract api(): StripeApi;
}

/** The SDK client on STRIPE_SECRET_KEY, created on first use and kept for the process. */
@Injectable()
export class SdkStripeClient extends StripeClient {
  readonly #secretKey: string | undefined;
  #client: Stripe | undefined;

  constructor(config: ConfigService<PlatformBackendConfig, true>) {
    super();
    this.#secretKey = config.get("STRIPE_SECRET_KEY", { infer: true });
  }

  isConfigured(): boolean {
    return this.#secretKey !== undefined;
  }

  api(): StripeApi {
    if (this.#secretKey === undefined) {
      throw new StripeNotConfiguredError();
    }
    this.#client ??= new Stripe(this.#secretKey, stripeClientOptions());
    return this.#client;
  }
}

/** The provider of StripeClient for the modules that call Stripe. */
export const stripeClientProvider: ClassProvider<StripeClient> = {
  provide: StripeClient,
  useClass: SdkStripeClient,
};
