// `StripeGateway`: the PaymentGateway of Stripe (OADR-0010 points 1–3, 7, 8; ADR-0011 (A); OBE-038, OBE-077).
//
// Mode selection is data (OADR-0010 point 1; OF-12 AC1): one code path serves the three account modes. The gateway
// reads the tenant's default `payment_provider_connections` row of the environment through the platform cache
// (`conn:payment:<tenantId>:<env>`, 60 s, dropped on the platform's `connection` invalidation; PlatformCache), and the
// row decides the account (StripeClientFactory.withAccount makes the calls):
//
//   account_mode       API key                                Extra header                Publishable key (storefront)
//   velexis            STRIPE_SECRET_KEY_<ENV>                —                           STRIPE_PUBLISHABLE_KEY_<ENV>
//   connect_standard   STRIPE_SECRET_KEY_<ENV>                Stripe-Account: <acct_…>    Velexis's, with accountId
//   api_keys           the connection's key, decrypted in     —                           the connection's
//                      the factory for one call only
//
// The tenant's current account (`findAccount`, `account`, a new session) is the row when it is a Stripe connection,
// `active`, of that environment and complete for its mode (an `acct_…` reference in `connect_standard` and `api_keys`
// mode, the connection's publishable key of the environment and its key's ciphertext in `api_keys` mode), and the
// Velexis keys exist for the modes that use them. Anything else (no row, another provider, a connection that is not
// active, an incomplete row, a `velexis` or `connect_standard` connection of an environment whose keys the environment
// file does not have) answers `424 PAYMENT_PROVIDER_NOT_CONFIGURED`, with the reason as the error's cause for the logs
// (`PaymentAccountUnusableError`). `findAccount` never decrypts anything: storefront.get needs the publishable key
// only.
//
// Existing payments keep their account (PADR-0011 point 7; OBE-077 step 3). A payment records the account it was
// created on (GatewayPayment.account, `payments.metadata.connection`; payment-gateway.ts), and every call for it (an
// amount update, a read, a capture, a void, a refund) is made on that account, whatever the tenant's connection says by
// then: a `velexis` payment with the Velexis key, a `connect_standard` one with the Velexis key and its own
// `Stripe-Account`, an `api_keys` one with the key of the tenant's current connection while that connection is still
// `api_keys` on the same `acct_…` (any status: the key of that account is what is stored), or through the Connect path
// (the Velexis key and `Stripe-Account:` that same `acct_…`) once the tenant's connection is `connect_standard` on that
// account (any status: the OTA connected the account its keys belonged to; lead decision (2i) of 2026-10-30, third
// batch, FIX-W36-OTA: before, such a payment answered `424`), else `424` (`payment_account_unavailable`: no connection
// of the tenant holds that account any more, or it holds another). A payment without a record was
// written before OBE-077, when only `velexis` was served. A new session is created on the tenant's current account,
// which must be the one its payment row recorded (`payment_account_changed` otherwise: the connection switched between
// the row and the call). So a mode switch never moves a payment, and a connection change reaches new payments within 60
// s (at once after the invalidation).
//
// PaymentIntents (points 2, 3, 7, 8): `capture_method: manual` (captured after the Amadeus order exists, OBE-042), card
// only, 3-D Secure `automatic`, or `any` when the storefront requires it, the metadata `velexis_tenant_id`,
// `velexis_environment`, `checkout_id` and `payment_id` on every one (the webhook receiver of OBE-039 finds the tenant
// and the payment through them), the connection's statement descriptor suffix with the OTA's brand in `velexis` mode
// only (ADR-0011 (A); none on the OTA's own account), and the idempotency keys of point 3. Card data never reaches this
// code: Stripe.js collects it in the browser. A PaymentIntent read back whose metadata names another tenant or payment
// is refused (a security event in the logs, `502` to the caller).
//
// Failures. A Stripe error of any kind (connection, timeout, API, rate limit, idempotency, authentication) is `502
// PAYMENT_PROVIDER_ERROR`; the caller's row stays as it was, so the same call can be sent again with the same key,
// except after a 5xx, which Stripe keeps as the key's answer (`failureKeptForKey`, payment-gateway.ts). The error's
// cause is a `StripeCallError` with Stripe's error type, code, HTTP status and request id only: Stripe's own error
// objects can carry the PaymentIntent (with its client secret), so they are never logged or passed on. An `api_keys`
// key that cannot be decrypted or is not a key of the environment is `424` (`connection_secret_unreadable`,
// `connection_secret_invalid`), logged with the connection id only; the decrypted key never appears in a log line or an
// error.
import { Injectable } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { STRIPE_KEY_PATTERNS } from "../../config";
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
  ACCOUNT_REFERENCE,
  idempotencyKeys,
  paymentAccountOf,
  samePaymentAccount,
  VELEXIS_PAYMENT_ACCOUNT,
  type CapturePurpose,
  type GatewayAccount,
  type GatewayCallFailure,
  type GatewayCard,
  type GatewayContext,
  type GatewayFailure,
  type GatewayMethod,
  type GatewayPayment,
  type GatewayPaymentAccount,
  type GatewayPaymentStatus,
  type GatewayRefund,
  type GatewayRefundState,
  type GatewaySession,
  type GatewaySessionInput,
  type GatewayState,
  type GatewayThreeDSecureStatus,
  type PaymentGateway,
} from "../payment-gateway";
import {
  StripeAccountUnavailableError,
  StripeClientFactory,
  type StripeAccountTarget,
  type StripeAccountUnavailableReason,
  type StripeRequestScope,
} from "./stripe-client.factory";

/** Why a tenant's environment, or a payment's account, cannot be called: the cause of the `424`. */
export type PaymentAccountUnusableReason =
  | "no_connection"
  | "provider_not_supported"
  | "connection_not_active"
  | "connection_environment"
  | "connection_incomplete"
  | "no_velexis_keys"
  | "connection_secret_unreadable"
  | "connection_secret_invalid"
  | "payment_account_changed"
  | "payment_account_unavailable";

/** The factory's reasons as the gateway names them. */
const UNAVAILABLE_REASONS: Readonly<Record<StripeAccountUnavailableReason, PaymentAccountUnusableReason>> =
  Object.freeze({
    no_velexis_keys: "no_velexis_keys",
    secret_unreadable: "connection_secret_unreadable",
    secret_key_invalid: "connection_secret_invalid",
  });

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
    secretCiphertext,
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
    !nullableString(statementDescriptorSuffix) ||
    !nullableString(secretCiphertext)
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
    secretCiphertext,
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

/** The resolved account and the target the factory calls it through. */
interface Resolved {
  readonly account: GatewayAccount;
  readonly target: StripeAccountTarget;
}

/** The methods a Stripe account takes in this release: cards only, when the connection enables them. */
function methodsOf(connection: PlatformPaymentConnection): GatewayMethod[] {
  return connection.supportedMethods.includes("card") ? ["card"] : [];
}

/**
 * The target of an `api_keys` connection, when the row is complete for that mode (its `acct_…`, its publishable key of
 * the environment and its key's ciphertext, which only the factory decrypts), else `undefined`. Status and tenant are
 * the caller's checks.
 */
function apiKeysTargetOf(
  connection: PlatformPaymentConnection,
): Extract<StripeAccountTarget, { accountMode: "api_keys" }> | undefined {
  const { accountReference, publishableKey, secretCiphertext, environment } = connection;
  if (
    connection.accountMode !== "api_keys" ||
    accountReference === null ||
    !ACCOUNT_REFERENCE.test(accountReference) ||
    publishableKey === null ||
    !STRIPE_KEY_PATTERNS.publishable[environment].test(publishableKey) ||
    secretCiphertext === null ||
    secretCiphertext === ""
  ) {
    return undefined;
  }
  return Object.freeze({
    accountMode: "api_keys",
    environment,
    connectionId: connection.id,
    secretCiphertext,
  });
}

/**
 * The target of an `api_keys` payment recorded on `account` (lead decision (2i) of 2026-10-30, third batch; file
 * header): the tenant's `connection` of the environment must hold that same `acct_…` (any status). Still `api_keys`:
 * the connection's key of that account (`apiKeysTargetOf`). Now `connect_standard`: the Connect path, the Velexis key
 * with `Stripe-Account:` that account. `undefined` (the gateway's `424 payment_account_unavailable`) for no connection,
 * another tenant, provider or environment, another account, a `velexis` connection, or an `api_keys` row without its
 * key.
 */
export function apiKeysPaymentTargetOf(
  ctx: Pick<GatewayContext, "tenantId" | "environment">,
  account: GatewayPaymentAccount,
  connection: PlatformPaymentConnection | null,
): StripeAccountTarget | undefined {
  const accountReference = account.accountReference;
  if (
    connection === null ||
    connection.provider !== "stripe" ||
    connection.tenantId !== ctx.tenantId ||
    connection.environment !== ctx.environment ||
    accountReference === null ||
    !ACCOUNT_REFERENCE.test(accountReference) ||
    connection.accountReference !== accountReference
  ) {
    return undefined;
  }
  switch (connection.accountMode) {
    case "api_keys":
      return apiKeysTargetOf(connection);
    case "connect_standard":
      return Object.freeze({
        accountMode: "connect_standard",
        environment: ctx.environment,
        accountReference,
      });
    case "velexis":
      return undefined;
  }
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
    const { account, target } = await this.resolveOrThrow(ctx);
    // A new PaymentIntent goes to the tenant's current account, which must be the one the payment row recorded when it
    // was inserted (the connection may have switched since).
    if (!samePaymentAccount(payment.account, paymentAccountOf(account))) {
      throw this.unusable(ctx, "payment_account_changed");
    }
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
    const intent = await this.call("paymentIntents.create", ctx, target, (client, scope) =>
      client.paymentIntents.create(params, { ...scope, idempotencyKey: idempotencyKeys.create(payment.id) }),
    );
    this.checkMetadata(ctx, payment, intent);
    return { account, state: stateOfPaymentIntent(intent, payment.minorUnits) };
  }

  async updateAmount(ctx: GatewayContext, payment: GatewayPayment, amount: string): Promise<GatewayState> {
    const target = await this.targetOfPayment(ctx, payment.account);
    const intentId = this.intentIdOf(payment);
    const intent = await this.call("paymentIntents.update", ctx, target, (client, scope) =>
      client.paymentIntents.update(
        intentId,
        { amount: toMinorUnits(amount, payment.minorUnits) },
        { ...scope, idempotencyKey: idempotencyKeys.update(payment.id, payment.version) },
      ),
    );
    this.checkMetadata(ctx, payment, intent);
    return stateOfPaymentIntent(intent, payment.minorUnits);
  }

  async refresh(ctx: GatewayContext, payment: GatewayPayment): Promise<GatewayState> {
    const target = await this.targetOfPayment(ctx, payment.account);
    const intentId = this.intentIdOf(payment);
    const params: Stripe.PaymentIntentRetrieveParams = { expand: ["payment_method", "latest_charge"] };
    const intent = await this.call("paymentIntents.retrieve", ctx, target, (client, scope) =>
      // The SDK refuses an empty options object: a read sends options only for a connected account.
      scope.stripeAccount === undefined
        ? client.paymentIntents.retrieve(intentId, params)
        : client.paymentIntents.retrieve(intentId, params, scope),
    );
    this.checkMetadata(ctx, payment, intent);
    return stateOfPaymentIntent(intent, payment.minorUnits);
  }

  async capture(
    ctx: GatewayContext,
    payment: GatewayPayment,
    amount: string,
    purpose: CapturePurpose = "booking",
  ): Promise<GatewayState> {
    const target = await this.targetOfPayment(ctx, payment.account);
    const intentId = this.intentIdOf(payment);
    // `amount_to_capture` below the authorisation captures that much and releases the rest (a cancellation's kept
    // amount, FIX-W28-CANCEL).
    const idempotencyKey =
      purpose === "cancellation"
        ? idempotencyKeys.captureKept(payment.id, amount)
        : idempotencyKeys.capture(payment.id, amount);
    const intent = await this.call("paymentIntents.capture", ctx, target, (client, scope) =>
      client.paymentIntents.capture(
        intentId,
        { amount_to_capture: toMinorUnits(amount, payment.minorUnits) },
        { ...scope, idempotencyKey },
      ),
    );
    this.checkMetadata(ctx, payment, intent);
    return stateOfPaymentIntent(intent, payment.minorUnits);
  }

  async void(ctx: GatewayContext, payment: GatewayPayment): Promise<GatewayState> {
    const target = await this.targetOfPayment(ctx, payment.account);
    const intentId = this.intentIdOf(payment);
    const intent = await this.call("paymentIntents.cancel", ctx, target, (client, scope) =>
      client.paymentIntents.cancel(
        intentId,
        {},
        { ...scope, idempotencyKey: idempotencyKeys.cancel(payment.id) },
      ),
    );
    this.checkMetadata(ctx, payment, intent);
    return stateOfPaymentIntent(intent, payment.minorUnits);
  }

  async refund(ctx: GatewayContext, refund: GatewayRefund): Promise<GatewayRefundState> {
    const target = await this.targetOfPayment(ctx, refund.account);
    const created = await this.call("refunds.create", ctx, target, (client, scope) =>
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
        { ...scope, idempotencyKey: idempotencyKeys.refund(refund.id) },
      ),
    );
    return {
      providerRefundId: created.id,
      status: refundStatusOf(created.status),
      amount: fromMinorUnits(created.amount, refund.minorUnits),
    };
  }

  // ---- Shared ----------------------------------------------------------------------------------------------------

  /** The tenant's default payment connection of the environment, through the 60-second platform cache. */
  private async connectionOf(ctx: GatewayContext): Promise<PlatformPaymentConnection | null> {
    return await this.cache.connection(
      "payment",
      ctx.tenantId,
      ctx.environment,
      () => this.platform.paymentConnection(ctx.tenantId, ctx.environment),
      parsePaymentConnection,
    );
  }

  /** The tenant's current account and its target, or the reason none serves the environment (file header). */
  private async resolve(ctx: GatewayContext): Promise<Resolved | PaymentAccountUnusableError> {
    const unusable = (reason: PaymentAccountUnusableReason) =>
      new PaymentAccountUnusableError(reason, ctx.tenantId, ctx.environment);
    const connection = await this.connectionOf(ctx);
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
    const base = {
      connectionId: connection.id,
      provider: "stripe",
      accountMode: connection.accountMode,
      methods: Object.freeze(methodsOf(connection)),
    } as const;
    switch (connection.accountMode) {
      case "velexis": {
        // Both Velexis keys of the environment, or neither (StripeClientFactory).
        const publishableKey = this.clients.velexisPublishableKey(ctx.environment);
        if (publishableKey === undefined) {
          return unusable("no_velexis_keys");
        }
        return {
          target: Object.freeze({ accountMode: "velexis", environment: ctx.environment }),
          account: Object.freeze({
            ...base,
            publishableKey,
            accountId: null,
            accountReference: null,
            statementDescriptor: connection.statementDescriptorSuffix,
          }),
        };
      }
      case "connect_standard": {
        const accountReference = connection.accountReference;
        if (accountReference === null || !ACCOUNT_REFERENCE.test(accountReference)) {
          return unusable("connection_incomplete");
        }
        // Both Velexis keys of the environment, or neither (StripeClientFactory).
        const publishableKey = this.clients.velexisPublishableKey(ctx.environment);
        if (publishableKey === undefined) {
          return unusable("no_velexis_keys");
        }
        return {
          target: Object.freeze({
            accountMode: "connect_standard",
            environment: ctx.environment,
            accountReference,
          }),
          // Direct charges on the OTA's account: Velexis's publishable key with the account for Stripe.js, no
          // statement descriptor suffix (the OTA's own account settings name it).
          account: Object.freeze({
            ...base,
            publishableKey,
            accountId: accountReference,
            accountReference,
            statementDescriptor: null,
          }),
        };
      }
      case "api_keys": {
        const target = apiKeysTargetOf(connection);
        if (target === undefined || connection.publishableKey === null) {
          return unusable("connection_incomplete");
        }
        // Nothing is decrypted here: the key is decrypted by the factory when a call is made.
        return {
          target,
          account: Object.freeze({
            ...base,
            publishableKey: connection.publishableKey,
            accountId: null,
            accountReference: connection.accountReference,
            statementDescriptor: null,
          }),
        };
      }
    }
  }

  private async resolveOrThrow(ctx: GatewayContext): Promise<Resolved> {
    const resolved = await this.resolve(ctx);
    if (resolved instanceof PaymentAccountUnusableError) {
      throw new AppError("PAYMENT_PROVIDER_NOT_CONFIGURED", { cause: resolved });
    }
    return resolved;
  }

  /**
   * The target of an existing payment: the account it recorded (`null`: written before OBE-077, `velexis`), whatever
   * the tenant's connection says now (file header). Only an `api_keys` payment reads the connection: for its account's
   * key, or for the Connect path on that same account once the tenant connected it (`apiKeysPaymentTargetOf`).
   */
  private async targetOfPayment(
    ctx: GatewayContext,
    recorded: GatewayPaymentAccount | null,
  ): Promise<StripeAccountTarget> {
    const account = recorded ?? VELEXIS_PAYMENT_ACCOUNT;
    switch (account.accountMode) {
      case "velexis":
        return Object.freeze({ accountMode: "velexis", environment: ctx.environment });
      case "connect_standard":
        if (account.accountReference === null) {
          throw this.unusable(ctx, "payment_account_unavailable");
        }
        return Object.freeze({
          accountMode: "connect_standard",
          environment: ctx.environment,
          accountReference: account.accountReference,
        });
      case "api_keys": {
        const target = apiKeysPaymentTargetOf(ctx, account, await this.connectionOf(ctx));
        if (target === undefined) {
          // The tenant left that account (velexis, or another account): no connection of its holds it any more.
          throw this.unusable(ctx, "payment_account_unavailable");
        }
        return target;
      }
    }
  }

  /** `424 PAYMENT_PROVIDER_NOT_CONFIGURED` with the reason as its cause. */
  private unusable(ctx: GatewayContext, reason: PaymentAccountUnusableReason): AppError {
    return new AppError("PAYMENT_PROVIDER_NOT_CONFIGURED", {
      cause: new PaymentAccountUnusableError(reason, ctx.tenantId, ctx.environment),
    });
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

  /**
   * Runs one Stripe call on `target` (StripeClientFactory.withAccount). An account the factory cannot reach is `424
   * PAYMENT_PROVIDER_NOT_CONFIGURED` (logged with ids only); any Stripe failure is `502 PAYMENT_PROVIDER_ERROR` with a
   * payload-free cause.
   */
  private async call<T>(
    operation: string,
    ctx: GatewayContext,
    target: StripeAccountTarget,
    run: (client: Stripe, scope: StripeRequestScope) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.clients.withAccount(target, run);
    } catch (error) {
      if (error instanceof StripeAccountUnavailableError) {
        const reason = UNAVAILABLE_REASONS[error.reason];
        this.logger.warn(
          {
            operation,
            tenantId: ctx.tenantId,
            environment: ctx.environment,
            accountMode: target.accountMode,
            connectionId: error.connectionId,
            reason,
          },
          "payments.stripe_account_unavailable",
        );
        throw this.unusable(ctx, reason);
      }
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
            accountMode: target.accountMode,
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
