// `StripeGateway`: the PaymentGateway of Stripe (OADR-0010 points 1–3, 7, 8; ADR-0011 (A); OBE-038).
//
// Mode selection is data (OADR-0010 point 1). The gateway reads the tenant's default `payment_provider_connections` row
// of the environment through the platform cache (`conn:payment:<tenantId>:<env>`, 60 s, dropped on the platform's
// `connection` invalidation; PlatformCache) and serves it when it is a Stripe connection, `active`, of that
// environment, in a mode this release serves:
//
//   account_mode       API key                              Publishable key to the storefront     Since
//   velexis            STRIPE_SECRET_KEY_<ENV>              STRIPE_PUBLISHABLE_KEY_<ENV>          M3 (this task)
//   connect_standard   the same, with Stripe-Account        Velexis's, with accountId             M5 (OBE-077)
//   api_keys           the connection's decrypted secret    the connection's                      M5 (OBE-077)
//
// Anything else (no row, another provider, a connection that is not active, an M5 mode, or a `velexis` connection of an
// environment whose keys the environment file does not have) answers `424 PAYMENT_PROVIDER_NOT_CONFIGURED`, with the
// reason as the error's cause for the logs (`PaymentAccountUnusableError`).
//
// PaymentIntents (points 2, 3, 7, 8): `capture_method: manual` (captured after the Amadeus order exists, OBE-042), card
// only, 3-D Secure `automatic`, or `any` when the storefront requires it, the metadata `velexis_tenant_id`,
// `velexis_environment`, `checkout_id` and `payment_id` on every one (the webhook receiver of OBE-039 finds the tenant
// and the payment through them), the connection's statement descriptor suffix with the OTA's brand, and the idempotency
// keys of point 3. Card data never reaches this code: Stripe.js collects it in the browser. A PaymentIntent read back
// whose metadata names another tenant or payment is refused (a security event in the logs, `502` to the caller).
//
// Failures. A Stripe error of any kind (connection, timeout, API, rate limit, idempotency) is `502
// PAYMENT_PROVIDER_ERROR`; the caller's row stays as it was, so the same call can be sent again with the same key,
// except after a 5xx, which Stripe keeps as the key's answer (`failureKeptForKey`, payment-gateway.ts). The error's
// cause is a `StripeCallError` with Stripe's error type, code, HTTP status and request id only: Stripe's own error
// objects can carry the PaymentIntent (with its client secret), so they are never logged or passed on.
import { Injectable } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { Money } from "../../pricing/pricing.types";
import { PlatformCache, type CacheParser } from "../../tenancy/platform-cache";
import {
  AMADEUS_ENVIRONMENTS,
  PAYMENT_ACCOUNT_MODES,
  PAYMENT_CAPTURE_MODES,
  PAYMENT_CONNECTION_STATUSES,
  PAYMENT_PROVIDERS,
  PlatformReadRepository,
  type PlatformPaymentConnection,
} from "../../tenancy/platform-read.repository";
import {
  idempotencyKeys,
  type GatewayAccount,
  type GatewayCallFailure,
  type GatewayCard,
  type GatewayContext,
  type GatewayFailure,
  type GatewayMethod,
  type GatewayPayment,
  type GatewayPaymentStatus,
  type GatewayRefund,
  type GatewayRefundState,
  type GatewaySession,
  type GatewaySessionInput,
  type GatewayState,
  type GatewayThreeDSecureStatus,
  type PaymentGateway,
} from "../payment-gateway";
import { StripeClientFactory } from "./stripe-client.factory";

/** Why a tenant's environment cannot take payments: the cause of the `424`. */
export type PaymentAccountUnusableReason =
  | "no_connection"
  | "provider_not_supported"
  | "connection_not_active"
  | "connection_environment"
  | "account_mode_not_supported"
  | "no_velexis_keys";

/** The cause of a `424 PAYMENT_PROVIDER_NOT_CONFIGURED`: the reason, with ids only. */
export class PaymentAccountUnusableError extends Error {
  override readonly name = "PaymentAccountUnusableError";

  constructor(
    readonly reason: PaymentAccountUnusableReason,
    readonly tenantId: string,
    readonly environment: string,
  ) {
    super(`The payment connection of ${tenantId} (${environment}) cannot take payments: ${reason}`);
  }
}

/**
 * The cause of a `502 PAYMENT_PROVIDER_ERROR`: what Stripe said, without its payload. Stripe keeps the answer of a
 * request its API began to execute as the answer of its idempotency key, a 5xx included, and replays it to every
 * request with that key for 24 hours; a request refused before (validation, another request with the key in flight, a
 * rate limit, a bad key) keeps nothing, and neither does one whose answer never came back. So a 5xx is a failure kept
 * for the key (`failureKeptForKey`): the same key can never succeed, only a new one can.
 */
export class StripeCallError extends Error implements GatewayCallFailure {
  override readonly name = "StripeCallError";
  readonly failureKeptForKey: boolean;

  constructor(
    readonly operation: string,
    readonly type: string,
    readonly stripeCode: string | null,
    readonly statusCode: number | null,
    readonly requestId: string | null,
  ) {
    super(
      `Stripe ${operation} failed: ${type}${stripeCode === null ? "" : ` (${stripeCode})`}` +
        `${statusCode === null ? "" : `, HTTP ${statusCode}`}${requestId === null ? "" : `, ${requestId}`}`,
    );
    this.failureKeptForKey = statusCode !== null && statusCode >= 500;
  }
}

/** A PaymentIntent whose metadata does not name the payment it was read for. */
export class StripeMetadataMismatchError extends Error implements GatewayCallFailure {
  override readonly name = "StripeMetadataMismatchError";
  readonly failureKeptForKey = false;

  constructor(readonly paymentId: string) {
    super(`The PaymentIntent read for ${paymentId} names another tenant or payment`);
  }
}

// ---- Cached connection rows ------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** A cached `PlatformPaymentConnection` (`conn:payment:<tenantId>:<env>`); anything else is a miss. */
export const parsePaymentConnection: CacheParser<PlatformPaymentConnection> = (value) => {
  if (!isRecord(value)) {
    return undefined;
  }
  const {
    id,
    tenantId,
    provider,
    environment,
    accountMode,
    accountReference,
    publishableKey,
    supportedMethods,
    captureMode,
    status,
    statementDescriptorSuffix,
  } = value;
  if (
    typeof id !== "string" ||
    typeof tenantId !== "string" ||
    !isOneOf(provider, PAYMENT_PROVIDERS) ||
    !isOneOf(environment, AMADEUS_ENVIRONMENTS) ||
    !isOneOf(accountMode, PAYMENT_ACCOUNT_MODES) ||
    !nullableString(accountReference) ||
    !nullableString(publishableKey) ||
    !Array.isArray(supportedMethods) ||
    !supportedMethods.every((method) => typeof method === "string") ||
    !isOneOf(captureMode, PAYMENT_CAPTURE_MODES) ||
    !isOneOf(status, PAYMENT_CONNECTION_STATUSES) ||
    !nullableString(statementDescriptorSuffix)
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    tenantId,
    provider,
    environment,
    accountMode,
    accountReference,
    publishableKey,
    supportedMethods: Object.freeze([...(supportedMethods as string[])]),
    captureMode,
    status,
    statementDescriptorSuffix,
  });
};

// ---- Amounts ---------------------------------------------------------------------------------------------------

/** A decimal amount in the provider's integer minor units (`"1414.06"`, 2 → 141406); a fraction left over throws. */
export function toMinorUnits(amount: string, minorUnits: number): number {
  const value = new Money(amount).times(new Money(10).pow(minorUnits));
  if (!value.isInteger() || value.isNegative() || !value.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`toMinorUnits: the amount does not fit ${minorUnits} minor units`);
  }
  return value.toNumber();
}

/** The provider's integer minor units as a decimal string with `minorUnits` decimals (141406, 2 → `"1414.06"`). */
export function fromMinorUnits(value: number, minorUnits: number): string {
  return new Money(value).div(new Money(10).pow(minorUnits)).toFixed(minorUnits);
}

// ---- PaymentIntents → GatewayState ------------------------------------------------------------------------------

/** Stripe's PaymentIntent statuses → `payments.status`. */
const STATUSES: Readonly<Record<Stripe.PaymentIntent.Status, GatewayPaymentStatus>> = Object.freeze({
  requires_payment_method: "requires_payment_method",
  // Not confirmed yet: for the storefront the same step as `requires_payment_method`.
  requires_confirmation: "requires_payment_method",
  requires_action: "requires_action",
  processing: "processing",
  requires_capture: "authorized",
  succeeded: "captured",
  canceled: "canceled",
});

/**
 * Stripe's card brand ids → Amadeus PaymentBrand names: the main Amadeus brand of each Stripe id that the storefront's
 * `pspCardBrands` offers (storefront.mapper's STRIPE_CARD_BRANDS, reversed; the gateway's test keeps the two equal).
 * Kept here so the payments module does not depend on the storefront module (architecture §2.2).
 */
const AMADEUS_BRANDS: Readonly<Record<string, string>> = Object.freeze({
  visa: "VISA",
  mastercard: "MASTERCARD",
  amex: "AMERICAN_EXPRESS",
  diners: "DINERS",
});

/** A Stripe brand id as an Amadeus brand where one matches, else in upper case. */
export function amadeusBrandOf(stripeBrand: string): string {
  return AMADEUS_BRANDS[stripeBrand] ?? stripeBrand.toUpperCase();
}

const CONFIRMABLE: ReadonlySet<Stripe.PaymentIntent.Status> = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

function cardOf(paymentMethod: Stripe.PaymentIntent["payment_method"]): GatewayCard | null {
  if (paymentMethod === null || typeof paymentMethod === "string" || paymentMethod.card === undefined) {
    return null;
  }
  const card = paymentMethod.card;
  return {
    brand: amadeusBrandOf(card.brand),
    last4: /^[0-9]{4}$/.test(card.last4) ? card.last4 : null,
    expMonth: Number.isInteger(card.exp_month) ? card.exp_month : null,
    expYear: Number.isInteger(card.exp_year) ? card.exp_year : null,
  };
}

/** Stripe's 3-D Secure results → PaymentThreeDSecure.status. */
const THREE_DS_RESULTS: Readonly<Record<string, GatewayThreeDSecureStatus>> = Object.freeze({
  authenticated: "authenticated",
  attempt_acknowledged: "attempted",
  exempted: "not_required",
  not_supported: "not_required",
  failed: "failed",
  processing_error: "failed",
});

function threeDSecureOf(charge: Stripe.PaymentIntent["latest_charge"]): GatewayState["threeDSecure"] {
  if (charge === null || typeof charge === "string") {
    return null;
  }
  const secure = charge.payment_method_details?.card?.three_d_secure;
  if (secure === undefined || secure === null) {
    return null;
  }
  return {
    status: (secure.result === null ? undefined : THREE_DS_RESULTS[secure.result]) ?? "unknown",
    version: secure.version ?? null,
  };
}

function failureOf(intent: Stripe.PaymentIntent): GatewayFailure | null {
  const error = intent.last_payment_error;
  if (error === null || error === undefined) {
    return null;
  }
  const declineCode = error.decline_code ?? error.code ?? null;
  return {
    code: error.type === "card_error" ? "PAYMENT_DECLINED" : "PAYMENT_PROVIDER_ERROR",
    declineCode:
      typeof declineCode === "string" && /^[a-z0-9_]{1,64}$/.test(declineCode) ? declineCode : null,
  };
}

/** The gateway's view of a PaymentIntent. */
export function stateOfPaymentIntent(intent: Stripe.PaymentIntent, minorUnits: number): GatewayState {
  return {
    providerPaymentId: intent.id,
    status: STATUSES[intent.status],
    amount: fromMinorUnits(intent.amount, minorUnits),
    amountCapturable: fromMinorUnits(intent.amount_capturable, minorUnits),
    amountReceived: fromMinorUnits(intent.amount_received, minorUnits),
    card: cardOf(intent.payment_method),
    threeDSecure: threeDSecureOf(intent.latest_charge),
    failure: failureOf(intent),
    clientSecret: CONFIRMABLE.has(intent.status) ? intent.client_secret : null,
  };
}

/** Stripe's refund statuses → GatewayRefundState.status. */
function refundStatusOf(status: string | null): GatewayRefundState["status"] {
  switch (status) {
    case "succeeded":
    case "failed":
    case "canceled":
    case "requires_action":
      return status;
    case null:
    default:
      return "pending";
  }
}

/** The resolved account and the client that serves it. */
interface Resolved {
  readonly account: GatewayAccount;
  readonly client: Stripe;
}

/** The methods a Stripe account takes in this release: cards only, when the connection enables them. */
function methodsOf(connection: PlatformPaymentConnection): GatewayMethod[] {
  return connection.supportedMethods.includes("card") ? ["card"] : [];
}

@Injectable()
export class StripeGateway implements PaymentGateway {
  constructor(
    private readonly clients: StripeClientFactory,
    private readonly cache: PlatformCache,
    private readonly platform: PlatformReadRepository,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(StripeGateway.name);
  }

  async findAccount(ctx: GatewayContext): Promise<GatewayAccount | null> {
    const resolved = await this.resolve(ctx);
    return resolved instanceof PaymentAccountUnusableError ? null : resolved.account;
  }

  async account(ctx: GatewayContext): Promise<GatewayAccount> {
    return (await this.resolveOrThrow(ctx)).account;
  }

  async createSession(
    ctx: GatewayContext,
    payment: GatewayPayment,
    session: GatewaySessionInput,
  ): Promise<GatewaySession> {
    const { account, client } = await this.resolveOrThrow(ctx);
    const params: Stripe.PaymentIntentCreateParams = {
      amount: toMinorUnits(payment.amount, payment.minorUnits),
      currency: payment.currency.toLowerCase(),
      capture_method: "manual",
      payment_method_types: ["card"],
      payment_method_options: {
        card: { request_three_d_secure: session.requireThreeDSecure ? "any" : "automatic" },
      },
      metadata: {
        velexis_tenant_id: ctx.tenantId,
        velexis_environment: ctx.environment,
        checkout_id: session.checkoutId,
        payment_id: payment.id,
      },
      ...(account.statementDescriptor === null
        ? {}
        : { statement_descriptor_suffix: account.statementDescriptor }),
    };
    const intent = await this.call("paymentIntents.create", ctx, () =>
      client.paymentIntents.create(params, { idempotencyKey: idempotencyKeys.create(payment.id) }),
    );
    this.checkMetadata(ctx, payment, intent);
    return { account, state: stateOfPaymentIntent(intent, payment.minorUnits) };
  }

  async updateAmount(ctx: GatewayContext, payment: GatewayPayment, amount: string): Promise<GatewayState> {
    const { client } = await this.resolveOrThrow(ctx);
    const intentId = this.intentIdOf(payment);
    const intent = await this.call("paymentIntents.update", ctx, () =>
      client.paymentIntents.update(
        intentId,
        { amount: toMinorUnits(amount, payment.minorUnits) },
        { idempotencyKey: idempotencyKeys.update(payment.id, payment.version) },
      ),
    );
    this.checkMetadata(ctx, payment, intent);
    return stateOfPaymentIntent(intent, payment.minorUnits);
  }

  async refresh(ctx: GatewayContext, payment: GatewayPayment): Promise<GatewayState> {
    const { client } = await this.resolveOrThrow(ctx);
    const intentId = this.intentIdOf(payment);
    const intent = await this.call("paymentIntents.retrieve", ctx, () =>
      client.paymentIntents.retrieve(intentId, { expand: ["payment_method", "latest_charge"] }),
    );
    this.checkMetadata(ctx, payment, intent);
    return stateOfPaymentIntent(intent, payment.minorUnits);
  }

  async capture(ctx: GatewayContext, payment: GatewayPayment, amount: string): Promise<GatewayState> {
    const { client } = await this.resolveOrThrow(ctx);
    const intentId = this.intentIdOf(payment);
    const intent = await this.call("paymentIntents.capture", ctx, () =>
      client.paymentIntents.capture(
        intentId,
        { amount_to_capture: toMinorUnits(amount, payment.minorUnits) },
        { idempotencyKey: idempotencyKeys.capture(payment.id, amount) },
      ),
    );
    this.checkMetadata(ctx, payment, intent);
    return stateOfPaymentIntent(intent, payment.minorUnits);
  }

  async void(ctx: GatewayContext, payment: GatewayPayment): Promise<GatewayState> {
    const { client } = await this.resolveOrThrow(ctx);
    const intentId = this.intentIdOf(payment);
    const intent = await this.call("paymentIntents.cancel", ctx, () =>
      client.paymentIntents.cancel(intentId, {}, { idempotencyKey: idempotencyKeys.cancel(payment.id) }),
    );
    this.checkMetadata(ctx, payment, intent);
    return stateOfPaymentIntent(intent, payment.minorUnits);
  }

  async refund(ctx: GatewayContext, refund: GatewayRefund): Promise<GatewayRefundState> {
    const { client } = await this.resolveOrThrow(ctx);
    const created = await this.call("refunds.create", ctx, () =>
      client.refunds.create(
        {
          payment_intent: refund.providerPaymentId,
          amount: toMinorUnits(refund.amount, refund.minorUnits),
          metadata: {
            velexis_tenant_id: ctx.tenantId,
            velexis_environment: ctx.environment,
            payment_id: refund.paymentId,
            refund_id: refund.id,
          },
        },
        { idempotencyKey: idempotencyKeys.refund(refund.id) },
      ),
    );
    return {
      providerRefundId: created.id,
      status: refundStatusOf(created.status),
      amount: fromMinorUnits(created.amount, refund.minorUnits),
    };
  }

  // ---- Shared ----------------------------------------------------------------------------------------------------

  /** The account and client of the tenant's environment, or the reason none serves it. */
  private async resolve(ctx: GatewayContext): Promise<Resolved | PaymentAccountUnusableError> {
    const unusable = (reason: PaymentAccountUnusableReason) =>
      new PaymentAccountUnusableError(reason, ctx.tenantId, ctx.environment);
    const connection = await this.cache.connection(
      "payment",
      ctx.tenantId,
      ctx.environment,
      () => this.platform.paymentConnection(ctx.tenantId, ctx.environment),
      parsePaymentConnection,
    );
    if (connection === null) {
      return unusable("no_connection");
    }
    if (connection.provider !== "stripe") {
      return unusable("provider_not_supported");
    }
    if (connection.tenantId !== ctx.tenantId || connection.environment !== ctx.environment) {
      return unusable("connection_environment");
    }
    if (connection.status !== "active") {
      return unusable("connection_not_active");
    }
    if (connection.accountMode !== "velexis") {
      // connect_standard and api_keys: M5 (OBE-077).
      return unusable("account_mode_not_supported");
    }
    const client = this.clients.velexisClient(ctx.environment);
    const publishableKey = this.clients.velexisPublishableKey(ctx.environment);
    if (client === undefined || publishableKey === undefined) {
      return unusable("no_velexis_keys");
    }
    return {
      client,
      account: Object.freeze({
        connectionId: connection.id,
        provider: "stripe",
        accountMode: "velexis",
        publishableKey,
        accountId: null,
        statementDescriptor: connection.statementDescriptorSuffix,
        methods: Object.freeze(methodsOf(connection)),
      }),
    };
  }

  private async resolveOrThrow(ctx: GatewayContext): Promise<Resolved> {
    const resolved = await this.resolve(ctx);
    if (resolved instanceof PaymentAccountUnusableError) {
      throw new AppError("PAYMENT_PROVIDER_NOT_CONFIGURED", { cause: resolved });
    }
    return resolved;
  }

  private intentIdOf(payment: GatewayPayment): string {
    if (payment.providerPaymentId === null) {
      throw new Error(`the payment ${payment.id} has no PaymentIntent yet`);
    }
    return payment.providerPaymentId;
  }

  /** A PaymentIntent must carry this tenant's and this payment's ids (OADR-0010 point 8). */
  private checkMetadata(ctx: GatewayContext, payment: GatewayPayment, intent: Stripe.PaymentIntent): void {
    const metadata = intent.metadata;
    if (
      metadata["payment_id"] !== payment.id ||
      metadata["velexis_tenant_id"] !== ctx.tenantId ||
      metadata["velexis_environment"] !== ctx.environment ||
      (payment.providerPaymentId !== null && intent.id !== payment.providerPaymentId)
    ) {
      // A security event: never the PaymentIntent itself, ids only.
      this.logger.warn(
        {
          securityEvent: "payments.provider_metadata_mismatch",
          paymentId: payment.id,
          tenantId: ctx.tenantId,
        },
        "payments.provider_metadata_mismatch",
      );
      throw new AppError("PAYMENT_PROVIDER_ERROR", { cause: new StripeMetadataMismatchError(payment.id) });
    }
  }

  /** Runs one Stripe call; any Stripe failure is `502 PAYMENT_PROVIDER_ERROR` with a payload-free cause. */
  private async call<T>(operation: string, ctx: GatewayContext, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        const cause = new StripeCallError(
          operation,
          error.type,
          typeof error.code === "string" ? error.code : null,
          typeof error.statusCode === "number" ? error.statusCode : null,
          typeof error.requestId === "string" ? error.requestId : null,
        );
        this.logger.warn(
          {
            operation,
            tenantId: ctx.tenantId,
            environment: ctx.environment,
            stripeErrorType: cause.type,
            stripeCode: cause.stripeCode,
            statusCode: cause.statusCode,
            stripeRequestId: cause.requestId,
          },
          "payments.stripe_call_failed",
        );
        throw new AppError("PAYMENT_PROVIDER_ERROR", { cause });
      }
      throw error;
    }
  }
}
