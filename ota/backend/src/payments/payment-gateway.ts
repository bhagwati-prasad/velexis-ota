// The payment gateway (ota/docs/architecture.md §5.1, ADR-0011 (D), OADR-0010; OBE-038): the one interface through
// which the OTA backend talks to a payment provider. The checkout's payment steps (payments.service.ts), and from
// OBE-039 to OBE-042 the webhook processor, the payments queue and the booking orchestration, depend on this interface
// only; `StripeGateway` (stripe/stripe.gateway.ts) implements it for the Stripe account modes, and OBE-050 adds the
// inert `AirlineCardGateway`. Provider secrets never leave the gateway: what it hands back holds ids, amounts, the
// card's brand and last 4, and the PaymentIntent's client secret for the browser (never stored, never logged).
//
// Since OBE-077 a payment carries the account it was created on (GatewayPaymentAccount, its connection snapshot in
// `payments.metadata`), so the calls for an existing payment never follow a later switch of the tenant's account mode.
//
// Amounts cross the interface as decimal strings with the currency's minor units (conventions §1); the gateway turns
// them into the provider's integer minor units and back. Every write carries an idempotency key of OADR-0010 point 3,
// built here (`idempotencyKeys`), so the SDK's single network retry and the jobs' retries can never charge twice.

/** The tenant and environment a provider call is made for, and the request or job it belongs to (ids only). */
export interface GatewayContext {
  /** `ten_…` */
  readonly tenantId: string;
  readonly environment: "test" | "live";
  /** `X-Request-Id` of the request, or the job's request id, for the logs. */
  readonly requestId: string;
}

/** The account modes of ADR-0011 (A). */
export type GatewayAccountMode = "velexis" | "connect_standard" | "api_keys";

/** The account modes, in the order of GatewayAccountMode. */
export const GATEWAY_ACCOUNT_MODES: readonly GatewayAccountMode[] = Object.freeze([
  "velexis",
  "connect_standard",
  "api_keys",
]);

/**
 * The provider account a payment was created on: its connection snapshot (PADR-0011 point 7; OBE-077). The platform
 * updates a tenant's connection row in place when the OTA switches mode, so `provider_connection_id` alone does not say
 * where a PaymentIntent lives: the mode and the OTA's account are recorded with the payment when its row is inserted
 * (`payments.metadata.connection`, `paymentMetadataFor`), and every later call for the payment (an update, a read, a
 * capture, a void, a refund) is made on that account, whatever the tenant's connection says by then. A switch never
 * moves a payment; it only decides where new ones go.
 */
export interface GatewayPaymentAccount {
  readonly accountMode: GatewayAccountMode;
  /** The OTA's own Stripe account (`acct_…`) in `connect_standard` and `api_keys` mode; `null` in `velexis` mode. */
  readonly accountReference: string | null;
}

/** The snapshot of a payment without one: written before OBE-077, when `velexis` was the only mode served (M3, M4). */
export const VELEXIS_PAYMENT_ACCOUNT: GatewayPaymentAccount = Object.freeze({
  accountMode: "velexis",
  accountReference: null,
});

/** `acct_` and letters and digits, as the platform's CHECK `payment_provider_connections_mode_ck` writes it. */
export const ACCOUNT_REFERENCE = /^acct_[A-Za-z0-9]+$/;

/** The snapshot of the account a new payment is created on. */
export function paymentAccountOf(
  account: Pick<GatewayAccount, "accountMode" | "accountReference">,
): GatewayPaymentAccount {
  return Object.freeze({
    accountMode: account.accountMode,
    accountReference: account.accountMode === "velexis" ? null : account.accountReference,
  });
}

/** Whether two snapshots name the same account (`null`: a payment without one, which is `velexis`). */
export function samePaymentAccount(
  left: GatewayPaymentAccount | null,
  right: GatewayPaymentAccount | null,
): boolean {
  const a = left ?? VELEXIS_PAYMENT_ACCOUNT;
  const b = right ?? VELEXIS_PAYMENT_ACCOUNT;
  return a.accountMode === b.accountMode && a.accountReference === b.accountReference;
}

/** `payments.metadata` of a new Stripe payment: its connection snapshot (no secret: a mode and an account id). */
export function paymentMetadataFor(account: Pick<GatewayAccount, "accountMode" | "accountReference">): {
  readonly connection: GatewayPaymentAccount;
} {
  return { connection: paymentAccountOf(account) };
}

/**
 * The connection snapshot of a stored payment (`payments.metadata`, as `paymentMetadataFor` wrote it), or `null` when
 * there is none: a payment written before OBE-077 (`velexis`), an airline-card payment, or a value this code did not
 * write.
 */
export function recordedPaymentAccount(metadata: unknown): GatewayPaymentAccount | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return null;
  }
  const connection: unknown = (metadata as Record<string, unknown>)["connection"];
  if (typeof connection !== "object" || connection === null || Array.isArray(connection)) {
    return null;
  }
  const { accountMode, accountReference } = connection as Record<string, unknown>;
  if (!GATEWAY_ACCOUNT_MODES.includes(accountMode as GatewayAccountMode)) {
    return null;
  }
  if (accountMode === "velexis") {
    return accountReference === null ? VELEXIS_PAYMENT_ACCOUNT : null;
  }
  return typeof accountReference === "string" && ACCOUNT_REFERENCE.test(accountReference)
    ? Object.freeze({ accountMode: accountMode as GatewayAccountMode, accountReference })
    : null;
}

/** The payment methods a gateway can take through `createSession` (PaymentCreateRequest.method). */
export type GatewayMethod = "card" | "apple_pay" | "google_pay" | "paypal";

/**
 * The provider account that serves a tenant's environment (OADR-0010 point 1), as far as the API and the storefront
 * may know it: no secret.
 */
export interface GatewayAccount {
  /** `platform.payment_provider_connections.id` (`ppc_…`), stored as `payments.provider_connection_id`. */
  readonly connectionId: string;
  readonly provider: "stripe";
  readonly accountMode: GatewayAccountMode;
  /** The publishable key the browser initialises Stripe.js with. */
  readonly publishableKey: string;
  /** The OTA's `acct_…` for Stripe.js `stripeAccount` (`connect_standard`), else `null`. */
  readonly accountId: string | null;
  /**
   * The OTA's own Stripe account (`acct_…`, `account_reference`) in `connect_standard` and `api_keys` mode, else
   * `null`: what a new payment records (`paymentAccountOf`). Only `connect_standard`'s reaches the browser
   * (`accountId`).
   */
  readonly accountReference: string | null;
  /** The card statement descriptor suffix (`velexis` mode), else `null`. */
  readonly statementDescriptor: string | null;
  /** The methods the account takes now, in the order of GatewayMethod. */
  readonly methods: readonly GatewayMethod[];
}

/** The internal payment states (`payments.status`, provider spelling `canceled`). */
export type GatewayPaymentStatus =
  | "requires_payment_method"
  | "requires_action"
  | "processing"
  | "authorized"
  | "captured"
  | "partially_refunded"
  | "refunded"
  | "canceled"
  | "failed";

/** A payment as the gateway reads it from its row (`payments`). */
export interface GatewayPayment {
  /** `pay_…`: the provider's `metadata.payment_id` and the key of every idempotency key. */
  readonly id: string;
  readonly checkoutId: string | null;
  /** `pi_…` once the session exists. */
  readonly providerPaymentId: string | null;
  /** ISO 4217, upper case. */
  readonly currency: string;
  /** Decimal string with at most `minorUnits` decimals. */
  readonly amount: string;
  /** The currency's minor units (`reference.currencies.minor_units`). */
  readonly minorUnits: number;
  /** `payments.version`: the key of an amount update (`pi:update:<pay_id>:<version>`). */
  readonly version: number;
  /**
   * The account the payment was created on (`recordedPaymentAccount(row.metadata)`), or `null` for a payment written
   * before the snapshot (`velexis`): every call for the payment is made on it.
   */
  readonly account: GatewayPaymentAccount | null;
  /**
   * `payments.provider_connection_id` (`ppc_…`), the connection the payment was created with: for the gateway's log
   * line of a call it refuses (FIX-W37-OTA, lead decision (2m) of 2026-10-31), never for choosing the account
   * (`account` does). Absent or `null`: none recorded.
   */
  readonly connectionId?: string | null;
}

/** What a new session needs besides the payment. */
export interface GatewaySessionInput {
  readonly checkoutId: string;
  /** `storefront_settings.require_3ds`: 3-D Secure on every payment (`any`) instead of when needed (`automatic`). */
  readonly requireThreeDSecure: boolean;
}

/** The card the provider reports after confirmation: no sensitive data. */
export interface GatewayCard {
  /** Amadeus PaymentBrand naming where one matches (`VISA`), else the provider's brand in upper case. */
  readonly brand: string;
  readonly last4: string | null;
  readonly expMonth: number | null;
  readonly expYear: number | null;
}

/** The 3-D Secure outcome, as PaymentThreeDSecure.status names it. */
export type GatewayThreeDSecureStatus =
  "not_required" | "pending" | "authenticated" | "attempted" | "failed" | "unknown";

/** Why a payment attempt failed: a public code, and the provider's decline code (no message from the provider). */
export interface GatewayFailure {
  /** `PAYMENT_DECLINED` or `PAYMENT_PROVIDER_ERROR`. */
  readonly code: "PAYMENT_DECLINED" | "PAYMENT_PROVIDER_ERROR";
  /** Provider decline code (`insufficient_funds`), or `null`. */
  readonly declineCode: string | null;
}

/** The provider's view of a payment (a PaymentIntent), read back after every call. */
export interface GatewayState {
  readonly providerPaymentId: string;
  readonly status: GatewayPaymentStatus;
  /** The amount requested, decimal string. */
  readonly amount: string;
  /** Decimal strings: what may still be captured, and what was captured. */
  readonly amountCapturable: string;
  readonly amountReceived: string;
  readonly card: GatewayCard | null;
  readonly threeDSecure: {
    readonly status: GatewayThreeDSecureStatus;
    readonly version: string | null;
  } | null;
  readonly failure: GatewayFailure | null;
  /**
   * The secret the browser confirms the payment with (Stripe.js), while it can still be confirmed; `null` after.
   * Never stored and never logged (the logger's redaction list has `clientSecret`).
   */
  readonly clientSecret: string | null;
}

/** A new session: the provider's payment and what the browser needs. */
export interface GatewaySession {
  readonly account: GatewayAccount;
  readonly state: GatewayState;
}

/** A refund as the gateway reads it from its row (`refunds`, OBE-040). */
export interface GatewayRefund {
  /** `rfd_…`: the idempotency key `refund:<rfd_id>`. */
  readonly id: string;
  readonly paymentId: string;
  readonly providerPaymentId: string;
  readonly currency: string;
  readonly amount: string;
  readonly minorUnits: number;
  /** The account of the refunded payment (GatewayPayment.account): the refund is made where the payment lives. */
  readonly account: GatewayPaymentAccount | null;
  /** The refunded payment's `provider_connection_id` (GatewayPayment.connectionId): for the logs only. */
  readonly connectionId?: string | null;
}

/** The provider's view of a refund. */
export interface GatewayRefundState {
  readonly providerRefundId: string;
  readonly status: "pending" | "succeeded" | "failed" | "canceled" | "requires_action";
  readonly amount: string;
}

/**
 * The cause a gateway gives the `502 PAYMENT_PROVIDER_ERROR` of a failed provider call: whether the provider keeps that
 * failure as the answer of the call's idempotency key.
 */
export interface GatewayCallFailure {
  /**
   * `true` when the provider answered with a failure it replays to every later request with the same idempotency key
   * (Stripe keeps a 5xx answer for 24 hours), so only a write with a new key can succeed; `false` when no answer came
   * (the write may have happened, and only the same key finds its result again) or the provider refused the request
   * before acting on it (nothing is kept for the key).
   */
  readonly failureKeptForKey: boolean;
}

/** Whether `error` is a provider failure whose idempotency key can only replay that failure (`GatewayCallFailure`). */
export function failureKeptForKey(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "failureKeptForKey" in cause &&
    cause.failureKeptForKey === true
  );
}

/**
 * What a capture is for, which names its idempotency key (OADR-0010 point 3): `booking`, the order of a booking
 * (`pi:capture:<pay_id>:<amount>`); `cancellation`, the amount a cancelled booking keeps of its authorisation, the rest
 * being released (lead decision (1) of 2026-10-23, second batch; FIX-W28-CANCEL: `pi:capture:<pay_id>:cancellation:
 * <amount>`, one key per booking cancellation, so it never meets the key of a capture of the order that failed).
 */
export type CapturePurpose = "booking" | "cancellation";

/**
 * The payment gateway. Every method resolves the account it calls first (`424 PAYMENT_PROVIDER_NOT_CONFIGURED` when it
 * cannot serve): the tenant's current account for `findAccount`, `account` and a new session, the payment's recorded
 * account (GatewayPayment.account) for every call on an existing payment (OBE-077). It maps every provider failure to
 * `502 PAYMENT_PROVIDER_ERROR` (nothing charged) whose cause is a `GatewayCallFailure`: the call can be sent again with
 * the same idempotency key, unless the provider keeps the failure for that key.
 */
export interface PaymentGateway {
  /** The account of the tenant's environment, or `null` when none can take payments (storefront.get). */
  findAccount(ctx: GatewayContext): Promise<GatewayAccount | null>;
  /** The account of the tenant's environment; `424 PAYMENT_PROVIDER_NOT_CONFIGURED` when none can take payments. */
  account(ctx: GatewayContext): Promise<GatewayAccount>;
  /**
   * Creates the provider payment (Stripe: a PaymentIntent with manual capture), idempotency `pi:create:<pay_id>`, on
   * the tenant's current account, which must be the one the payment recorded (`424` otherwise: the connection changed
   * between the row and the call).
   */
  createSession(
    ctx: GatewayContext,
    payment: GatewayPayment,
    session: GatewaySessionInput,
  ): Promise<GatewaySession>;
  /** Sets the amount of an unconfirmed provider payment, idempotency `pi:update:<pay_id>:<version>`. */
  updateAmount(ctx: GatewayContext, payment: GatewayPayment, amount: string): Promise<GatewayState>;
  /** Reads the provider payment again (its state, card, 3-D Secure outcome and client secret). */
  refresh(ctx: GatewayContext, payment: GatewayPayment): Promise<GatewayState>;
  /**
   * Captures `amount` of an authorised payment and releases the rest of the authorisation, idempotency
   * `pi:capture:<pay_id>:<amount>`, or for a cancellation's kept amount `pi:capture:<pay_id>:cancellation:<amount>`
   * (CapturePurpose).
   */
  capture(
    ctx: GatewayContext,
    payment: GatewayPayment,
    amount: string,
    purpose?: CapturePurpose,
  ): Promise<GatewayState>;
  /** Cancels (voids) a payment that is not captured, idempotency `pi:cancel:<pay_id>`. */
  void(ctx: GatewayContext, payment: GatewayPayment): Promise<GatewayState>;
  /** Refunds (part of) a captured payment, idempotency `refund:<rfd_id>`. */
  refund(ctx: GatewayContext, refund: GatewayRefund): Promise<GatewayRefundState>;
}

/** Injection token of the `PaymentGateway` (payments.module.ts). */
export const PAYMENT_GATEWAY = "PAYMENT_GATEWAY";

/** The idempotency keys of OADR-0010 point 3, one per provider write. */
export const idempotencyKeys = Object.freeze({
  create: (paymentId: string): string => `pi:create:${paymentId}`,
  update: (paymentId: string, version: number): string => `pi:update:${paymentId}:${version}`,
  capture: (paymentId: string, amount: string): string => `pi:capture:${paymentId}:${amount}`,
  /** The capture of the amount a cancellation keeps (CapturePurpose `cancellation`, FIX-W28-CANCEL). */
  captureKept: (paymentId: string, amount: string): string =>
    `pi:capture:${paymentId}:cancellation:${amount}`,
  cancel: (paymentId: string): string => `pi:cancel:${paymentId}`,
  refund: (refundId: string): string => `refund:${refundId}`,
});
