// checkout.createPayment, checkout.getPayment and checkout.updatePayment (createCheckoutPayment, getPayment,
// updatePayment; `x-scope: both`; OBE-038; ota/docs/flows/checkout-stripe.md §2 steps 3–4, OADR-0010 points 1–3, 7,
// 8, ADR-0011 (A)). Card payments on Stripe in `velexis` mode through the PaymentGateway; every provider write carries
// its idempotency key (payment-gateway.ts) and no transaction stays open across a Stripe or Amadeus call
// (architecture §4).
//
// createPayment {method: "card", termsAccepted: true, card?}:
//   1. checks without data: only `card` is taken in this release (`airline_card`: `403 FEATURE_DISABLED`,
//      `details.feature = "airlineCard"`, until OBE-050; the wallets and PayPal: `403 FEATURE_DISABLED`), and only
//      Stripe (`provider` naming another: `424 PAYMENT_PROVIDER_NOT_CONFIGURED`);
//   2. the checkout as checkout.get answers it (access as the checkout's own, `404` otherwise): completed `409
//      CHECKOUT_ALREADY_COMPLETED`, expired or abandoned `410 CHECKOUT_EXPIRED`, travellers or contacts missing `422
//      CHECKOUT_INCOMPLETE` with the missing fields as `fieldErrors` (money is never taken before the data is valid);
//      the tenant's Stripe account (`424 PAYMENT_PROVIDER_NOT_CONFIGURED`, the gateway); a card hint's brand must be
//      accepted (`422 UNPROCESSABLE`) and its fee is quoted (card-fees.ts; Amadeus between transactions);
//   3. one transaction locks the checkout (a checkout changed since step 2 starts again), cancels the checkout's
//      payments that are not confirmed yet (`requires_payment_method`, `requires_action`), inserts the `payments` row
//      (`requires_payment_method`, `capture_method = manual`, the checkout total with the card fee, the hint) with
//      its `payment_events` row, and sets the checkout `payment_pending`, `terms_accepted_at`, the card fee and the
//      total, and its expiry 15 minutes later (`expires_at + 15 min` on the first payment, at least `now + 15 min`
//      on a later one); it **commits before** the PaymentIntent exists (OADR-0010 point 2), so a webhook always finds
//      the row through `metadata.payment_id`. A row left by an earlier attempt whose Stripe call failed (no
//      PaymentIntent, same amounts and hint) is used again instead, so its `pi:create:<pay_id>` key is sent again and
//      a PaymentIntent Stripe did create for the lost answer is the one that comes back;
//   4. the gateway creates the PaymentIntent (`pi:create:<pay_id>`); a Stripe failure is `502 PAYMENT_PROVIDER_ERROR`
//      (nothing charged; the idempotency interceptor releases the request's key, so the same key can be sent again).
//      A 5xx that Stripe keeps as the answer of `pi:create:<pay_id>` makes the row `failed` instead (that key would
//      only replay the failure), so the retry inserts a payment with a key of its own;
//   5. the PaymentIntents of the cancelled payments, and of an authorised one, are cancelled at Stripe, also when step 4
//      failed (best effort: a failure is logged; the payments queue of OBE-040 voids what is left), and a second
//      transaction stores the new PaymentIntent id; the answer is `201` with the client secret and the publishable key.
//
// getPayment: the payment of a checkout the caller may read (access as the checkout's, in the request's environment,
// `404` otherwise, another tenant's id included). A payment that is not final is read again from Stripe first
// (`requires_payment_method` and `requires_action` always, which also gives their client secret; `processing` when its
// last change is older than 5 seconds), and the state is applied with the row's `version`; a Stripe outage answers
// the stored state. `clientSecret` is given only while the payment can still be confirmed, never stored.
//
// updatePayment {card: {brand, bin?}}: only an unconfirmed Stripe card payment (`409 PAYMENT_NOT_UPDATABLE` with
// `details.status`) of a checkout that is neither completed (`409`) nor expired (`410`), a brand the storefront accepts
// (`422 UNPROCESSABLE`). The same hint again changes nothing (no quote, no provider call). Otherwise the fee is quoted
// for the hint (card-fees.ts), the PaymentIntent's amount is set (`pi:update:<pay_id>:<version>`), and one transaction
// stores the amount, the fee and the hint with a `payment_events` row (`payment.amount_updated`), and the checkout's
// card fee, total and brand (its `version` + 1). A row that changed meanwhile starts the step again. A failed Stripe
// update moves the payment's `version` on (`payment.provider_error`), so the next update never sends a key that Stripe
// may have used for another amount, or keeps a 5xx for.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { PinoLogger } from "nestjs-pino";
import { effectiveStatus, type Checkout } from "../checkout/checkout.mapper";
import { CheckoutService } from "../checkout/checkout.service";
import { CustomerContext } from "../common/auth/customer.guard";
import { Clock } from "../common/clock";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { Money } from "../pricing/pricing.types";
import { PricedOffersService, type CheckoutPricedOffer } from "../shopping/priced-offers.service";
import { CallerContext } from "../tenancy/caller-resolver";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { CardFees, type CardFeePlan, type CardFeeQuote, type CardHint } from "./card-fees";
import {
  failureKeptForKey,
  PAYMENT_GATEWAY,
  type GatewayAccount,
  type GatewayContext,
  type GatewayPayment,
  type GatewayPaymentStatus,
  type GatewaySession,
  type GatewayState,
  type PaymentGateway,
} from "./payment-gateway";
import {
  PaymentsRepository,
  REPLACEABLE_STATUSES,
  type PaymentCheckoutRow,
  type PaymentRow,
  type PaymentSettingsRow,
} from "./payments.repository";

type Schemas = components["schemas"];
export type Payment = Schemas["Payment"];
export type PaymentCreateRequest = Schemas["PaymentCreateRequest"];
export type PaymentUpdateRequest = Schemas["PaymentUpdateRequest"];
type MoneyAmount = Schemas["Money"];

/** `Cache-Control` of every payment answer. */
export const PAYMENT_CACHE_CONTROL = "no-store";

/** How much longer a checkout lives once a payment is created (flow §2 step 8). */
export const PAYMENT_EXPIRY_EXTENSION_MS = 15 * 60_000;

/** A `processing` payment is read again from Stripe once its last change is older than this. */
export const PAYMENT_REFRESH_AFTER_MS = 5_000;

/** How often a payment step starts again when its checkout or payment changed meanwhile. */
const STEP_ATTEMPTS = 3;

/** The `fieldErrors` of a `422 CHECKOUT_INCOMPLETE`, at most. */
const MAX_FIELD_ERRORS = 50;

/** The states in which a payment can still be confirmed (and has a client secret). */
const CONFIRMABLE: ReadonlySet<string> = new Set(["requires_payment_method", "requires_action"]);
/** The states a refresh reads again. */
const NOT_FINAL: ReadonlySet<string> = new Set(["requires_payment_method", "requires_action", "processing"]);

/** The safe messages of PaymentFailure, per public code. */
const FAILURE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PAYMENT_DECLINED: "The card was declined. Try another card.",
  PAYMENT_PROVIDER_ERROR: "The payment could not be processed. Try again.",
});

/** The input of checkout.createPayment. */
export interface CreatePaymentInput {
  readonly checkoutId: string;
  readonly body: PaymentCreateRequest;
  readonly acceptLanguage?: string | undefined;
}

/** The input of checkout.updatePayment. */
export interface UpdatePaymentInput {
  readonly paymentId: string;
  readonly body: PaymentUpdateRequest;
  readonly acceptLanguage?: string | undefined;
}

/** What `toPayment` adds to the row. */
export interface PaymentView {
  readonly minorUnits: number;
  /** The client secret read from Stripe in this request, or `null`. */
  readonly clientSecret: string | null;
  /** The publishable key of the account that serves the payment, or `null`. */
  readonly publishableKey: string | null;
}

// ---- The answer ------------------------------------------------------------------------------------------------

const money = (amount: string, currency: string, minorUnits: number): MoneyAmount => ({
  amount: new Money(amount).toFixed(minorUnits),
  currency,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `payments.status` → Payment.status (the API spells `cancelled`). */
export function apiStatusOf(status: string): Payment["status"] {
  return (status === "canceled" ? "cancelled" : status) as Payment["status"];
}

/** What the front end does next in a state (PaymentNextAction). */
export function nextActionOf(status: string): NonNullable<Payment["nextAction"]> {
  if (CONFIRMABLE.has(status)) {
    return { type: "confirm_with_provider_sdk", redirectUrl: null };
  }
  return { type: status === "processing" ? "wait" : "none", redirectUrl: null };
}

const THREE_DS_STATUSES: readonly Payment["threeDSecure"]["status"][] = [
  "not_required",
  "pending",
  "authenticated",
  "attempted",
  "failed",
  "unknown",
];

/**
 * The brands a card hint can name (AmadeusPaymentBrand, the enum of PaymentCardHint.brand). `payments.card_brand` also
 * holds the provider's brand of a card paid without a hint (`stateValues`), which can be one Amadeus does not name
 * (`JCB`): such a payment has no card hint and no card fee, only its `card`.
 */
const HINT_BRANDS: Readonly<Record<Schemas["AmadeusPaymentBrand"], true>> = Object.freeze({
  VISA: true,
  AMERICAN_EXPRESS: true,
  MASTERCARD: true,
  VISA_ELECTRON: true,
  VISA_DEBIT: true,
  MASTERCARD_DEBIT: true,
  MAESTRO: true,
  DINERS: true,
  MASTERCARD_IXARIS: true,
  VISA_IXARIS: true,
  MASTERCARD_AIRPLUS: true,
  UATP_AIRPLUS: true,
  PYTON: true,
});

function isHintBrand(brand: string | null): brand is Schemas["AmadeusPaymentBrand"] {
  return brand !== null && Object.hasOwn(HINT_BRANDS, brand);
}

/** `payments.three_ds` as PaymentThreeDSecure. */
function threeDSecureOf(value: unknown): Payment["threeDSecure"] {
  const stored = isRecord(value) ? value : {};
  const status = THREE_DS_STATUSES.find((entry) => entry === stored["status"]) ?? "unknown";
  return {
    required: stored["required"] === true,
    status,
    version: typeof stored["version"] === "string" ? stored["version"] : null,
  };
}

/** A payment row as Payment (see the file header for `clientSecret`). */
export function toPayment(row: PaymentRow, view: PaymentView): Payment {
  const { currency } = row;
  const units = view.minorUnits;
  const at = (date: Date | null): string | null => date?.toISOString() ?? null;
  const confirmable = CONFIRMABLE.has(row.status);
  const hintBrand = isHintBrand(row.cardBrand) ? row.cardBrand : null;
  const payment: Payment = {
    id: row.id,
    checkoutId: row.checkoutId,
    bookingId: row.bookingId,
    purpose: "booking",
    provider: row.provider as Payment["provider"],
    method: row.method as Payment["method"],
    status: apiStatusOf(row.status),
    captureMethod: row.captureMethod === "automatic" ? "automatic" : "manual",
    amount: money(row.amount, currency, units),
    cardFee: hintBrand === null ? null : money(row.cardFeeAmount, currency, units),
    cardHint:
      hintBrand === null ? null : { brand: hintBrand, ...(row.cardBin === null ? {} : { bin: row.cardBin }) },
    amountAuthorized: money(row.amountAuthorized, currency, units),
    amountCaptured: money(row.amountCaptured, currency, units),
    amountRefunded: money(row.amountRefunded, currency, units),
    clientSecret: confirmable ? view.clientSecret : null,
    providerPublicKey: view.publishableKey,
    providerPaymentId: row.providerPaymentId,
    redirectUrl: null,
    nextAction: nextActionOf(row.status),
    card:
      row.cardLast4 === null
        ? null
        : {
            brand: row.cardBrand ?? "UNKNOWN",
            last4: row.cardLast4,
            bin: row.cardBin,
            expMonth: row.cardExpMonth,
            expYear: row.cardExpYear,
          },
    threeDSecure: threeDSecureOf(row.threeDs),
    failure:
      row.failureCode === null
        ? null
        : {
            code: row.failureCode,
            message: FAILURE_MESSAGES[row.failureCode] ?? FAILURE_MESSAGES["PAYMENT_PROVIDER_ERROR"] ?? "",
            declineCode: row.failureMessage,
          },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    authorizedAt: at(row.authorizedAt),
    capturedAt: at(row.capturedAt),
    cancelledAt: at(row.canceledAt),
    canceledAt: at(row.canceledAt),
  };
  return payment;
}

/** The new expiry of a checkout that gets a payment (see the file header, step 3). */
export function extendedExpiry(checkout: Pick<PaymentCheckoutRow, "status" | "expiresAt">, now: Date): Date {
  const minimum = now.getTime() + PAYMENT_EXPIRY_EXTENSION_MS;
  const extended =
    checkout.status === "open"
      ? Math.max(checkout.expiresAt.getTime(), now.getTime()) + PAYMENT_EXPIRY_EXTENSION_MS
      : Math.max(checkout.expiresAt.getTime(), minimum);
  return new Date(extended);
}

/** The values a provider state writes into a payment row (refresh, void). */
export function stateValues(
  row: PaymentRow,
  state: GatewayState,
  now: Date,
): {
  readonly status: GatewayPaymentStatus;
  readonly values: Record<string, unknown>;
} {
  const amount = new Money(row.amount);
  const capped = (value: string): string => Money.min(new Money(value), amount).toFixed(2);
  const values: Record<string, unknown> = {
    status: state.status,
    next_action: JSON.stringify(nextActionOf(state.status)),
    updated_at: now,
  };
  if (state.status === "authorized") {
    values["amount_authorized"] = capped(state.amountCapturable);
    values["authorized_at"] = row.authorizedAt ?? now;
  }
  if (state.status === "captured") {
    values["amount_authorized"] = Money.max(
      new Money(row.amountAuthorized),
      new Money(capped(state.amountReceived)),
    ).toFixed(2);
    values["amount_captured"] = capped(state.amountReceived);
    values["authorized_at"] = row.authorizedAt ?? now;
    values["captured_at"] = row.capturedAt ?? now;
  }
  if (state.status === "canceled") {
    values["canceled_at"] = row.canceledAt ?? now;
  }
  if (state.card !== null) {
    values["card_last4"] = state.card.last4;
    values["card_exp_month"] = state.card.expMonth;
    values["card_exp_year"] = state.card.expYear;
    // The hint's brand is what the fee was quoted for; the provider's names the card when there was no hint.
    if (row.cardBrand === null) {
      values["card_brand"] = state.card.brand;
    }
  }
  if (state.threeDSecure !== null) {
    const stored = isRecord(row.threeDs) ? row.threeDs : {};
    values["three_ds"] = JSON.stringify({
      required: stored["required"] === true,
      status: state.threeDSecure.status,
      version: state.threeDSecure.version,
    });
  }
  values["failure_code"] = state.failure?.code ?? null;
  values["failure_message"] = state.failure?.declineCode ?? null;
  return { status: state.status, values };
}

// ---- The service -----------------------------------------------------------------------------------------------

const notFound = (): AppError => new AppError("NOT_FOUND", { message: "No payment with this id." });

/** The prepared first transaction of createPayment. */
interface CreatePlan {
  readonly settings: PaymentSettingsRow;
  readonly quote: CardFeeQuote | undefined;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly callers: CallerContext,
    private readonly requestContext: RequestContext,
    private readonly customers: CustomerContext,
    private readonly checkouts: CheckoutService,
    private readonly pricedOffers: PricedOffersService,
    private readonly repository: PaymentsRepository,
    private readonly cardFees: CardFees,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(PaymentsService.name);
  }

  // ---- checkout.createPayment ------------------------------------------------------------------------------------

  async create(input: CreatePaymentInput): Promise<Payment> {
    const tenant = this.tenants.require();
    const ctx = this.gatewayContext(tenant);
    const body = input.body;
    if (body.method === "airline_card") {
      throw new AppError("FEATURE_DISABLED", {
        message: "The airline card is not enabled for this storefront.",
        details: { feature: "airlineCard" },
      });
    }
    if (body.method !== "card") {
      throw new AppError("FEATURE_DISABLED", {
        message: "This payment method is not enabled for this storefront.",
        details: { feature: body.method },
      });
    }
    if (body.provider !== undefined && body.provider !== "stripe") {
      throw new AppError("PAYMENT_PROVIDER_NOT_CONFIGURED");
    }
    const hint: CardHint | undefined =
      body.card === undefined ? undefined : { brand: body.card.brand, bin: body.card.bin };
    for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt += 1) {
      const view = await this.checkouts.get(input.checkoutId, input.acceptLanguage);
      this.checkPayable(view);
      const account = await this.gateway.account(ctx);
      if (!account.methods.includes("card")) {
        throw new AppError("FEATURE_DISABLED", {
          message: "Card payments are not enabled for this storefront.",
          details: { feature: "card" },
        });
      }
      const { settings, cardPlan } = await this.tx.run(
        async (trx): Promise<{ settings: PaymentSettingsRow; cardPlan?: CardFeePlan }> => {
          const settings = await this.settingsOf(trx, tenant);
          if (hint === undefined) {
            return { settings };
          }
          this.checkBrand(settings, hint.brand);
          const checkout = await this.checkoutOf(trx, view.id);
          const priced = await this.pricedOfferOf(trx, checkout.pricedOfferId, input.acceptLanguage);
          const now = this.clock.now();
          return {
            settings,
            cardPlan: await this.cardFees.prepare(trx, priced, hint, this.baseAmount(checkout), now),
          };
        },
      );
      const quote =
        cardPlan === undefined
          ? undefined
          : await this.cardFees.quote(ctx, cardPlan, "checkout.createPayment");
      const created = await this.tx.run((trx) =>
        this.insertPayment(trx, tenant, view, account, { settings, quote }),
      );
      if (created === undefined) {
        continue;
      }
      let session: GatewaySession;
      try {
        session = await this.createSession(ctx, created.payment, view.id, settings);
      } finally {
        // The replaced payments' PaymentIntents go, whether or not the new one could be created.
        await this.cancelAtProvider(ctx, created.replaced);
      }
      const payment = await this.tx.run(async (trx) => {
        const now = this.clock.now();
        const stored = await this.repository.payment(trx, created.payment.id, true);
        if (stored === undefined) {
          throw new Error("a payment of this request is not readable");
        }
        if (
          stored.providerPaymentId !== null &&
          stored.providerPaymentId !== session.state.providerPaymentId
        ) {
          throw new AppError("CONFLICT", { message: "The payment changed meanwhile; create it again." });
        }
        if (stored.providerPaymentId === null) {
          await this.repository.updatePayment(trx, stored.id, stored.version, {
            provider_payment_id: session.state.providerPaymentId,
            next_action: JSON.stringify(nextActionOf(stored.status)),
            updated_at: now,
          });
          await this.event(trx, stored, {
            type: "payment.session_created",
            payload: { providerPaymentId: session.state.providerPaymentId },
            now,
          });
        }
        const row = await this.repository.payment(trx, stored.id);
        if (row === undefined) {
          throw new Error("a payment of this request is not readable");
        }
        return toPayment(row, {
          minorUnits: created.payment.minorUnits,
          clientSecret: session.state.clientSecret,
          publishableKey: session.account.publishableKey,
        });
      });
      this.logger.info(
        {
          paymentId: payment.id,
          checkoutId: view.id,
          providerPaymentId: payment.providerPaymentId,
          cardFeeSource: quote?.source ?? null,
          replaced: created.replaced.length,
        },
        "payments.created",
      );
      return payment;
    }
    throw new AppError("CONFLICT", {
      message: "The checkout changed while the payment was created; try again.",
    });
  }

  /** The checkout must be open or payment pending, not expired, with its travellers and contacts complete. */
  private checkPayable(view: Checkout): void {
    if (view.status === "completed") {
      throw new AppError(
        "CHECKOUT_ALREADY_COMPLETED",
        view.bookingId === null ? {} : { details: { bookingId: view.bookingId } },
      );
    }
    if (view.status === "expired" || view.status === "abandoned") {
      throw new AppError("CHECKOUT_EXPIRED");
    }
    if (!view.progress.travelersComplete || !view.progress.contactsComplete) {
      throw new AppError("CHECKOUT_INCOMPLETE", {
        message: "Complete the traveller and contact details before paying.",
        fieldErrors: view.progress.missing.slice(0, MAX_FIELD_ERRORS),
      });
    }
  }

  /** Step 3 (see the file header); `undefined` when the checkout changed since it was read. */
  private async insertPayment(
    trx: TenantTransaction,
    tenant: RequestTenant,
    view: Checkout,
    account: GatewayAccount,
    plan: CreatePlan,
  ): Promise<{ readonly payment: GatewayPayment; readonly replaced: readonly PaymentRow[] } | undefined> {
    const now = this.clock.now();
    const checkout = await this.repository.checkout(trx, view.id, true);
    if (checkout === undefined || checkout.version !== view.version) {
      return undefined;
    }
    const status = effectiveStatus(checkout, now);
    if (status === "completed") {
      throw new AppError("CHECKOUT_ALREADY_COMPLETED");
    }
    if (status !== "open" && status !== "payment_pending") {
      throw new AppError("CHECKOUT_EXPIRED");
    }
    const minorUnits = await this.minorUnitsOf(trx, checkout.currency);
    const { quote, settings } = plan;
    const fee = new Money(quote?.total ?? "0").toFixed(minorUnits);
    const total = new Money(this.baseAmount(checkout)).plus(fee).toFixed(minorUnits);
    if (!new Money(total).isPositive()) {
      throw new AppError("UNPROCESSABLE", {
        message: "The checkout has nothing to pay.",
        details: { reason: "nothing_to_pay" },
      });
    }
    const brand = quote?.brand ?? null;
    const bin = quote?.bin ?? null;
    const open = await this.repository.paymentsOfCheckout(trx, checkout.id, [
      ...REPLACEABLE_STATUSES,
      "authorized",
    ]);
    // A row of an earlier attempt whose Stripe call failed, for exactly this payment: its key is sent again.
    const reusable = open.find(
      (row) =>
        row.status === "requires_payment_method" &&
        row.providerPaymentId === null &&
        row.provider === "stripe" &&
        row.method === "card" &&
        row.providerConnectionId === account.connectionId &&
        row.currency === checkout.currency &&
        new Money(row.amount).equals(total) &&
        new Money(row.cardFeeAmount).equals(fee) &&
        row.cardBrand === brand &&
        row.cardBin === bin,
    );
    const replaced: PaymentRow[] = [];
    for (const row of open) {
      if (row === reusable) {
        continue;
      }
      replaced.push(row);
      if (row.status === "authorized") {
        // Cancelled once Stripe voided it (`cancelAtProvider`).
        continue;
      }
      await this.repository.updatePayment(trx, row.id, row.version, {
        status: "canceled",
        canceled_at: now,
        next_action: JSON.stringify(nextActionOf("canceled")),
        updated_at: now,
      });
      await this.event(trx, row, {
        type: "payment.replaced",
        statusFrom: row.status,
        statusTo: "canceled",
        payload: { replacedBy: reusable?.id ?? null },
        now,
      });
    }
    let payment: GatewayPayment;
    if (reusable !== undefined) {
      payment = this.gatewayPaymentOf(reusable, minorUnits);
      await this.event(trx, reusable, { type: "payment.retried", now });
    } else {
      const id = this.ids.newId("pay");
      await this.repository.insertPayment(trx, {
        id,
        environment: tenant.environment,
        checkout_id: checkout.id,
        customer_id: checkout.customerId,
        provider: "stripe",
        provider_connection_id: account.connectionId,
        method: "card",
        capture_method: "manual",
        currency: checkout.currency,
        amount: total,
        card_fee_amount: fee,
        status: "requires_payment_method",
        card_brand: brand,
        card_bin: bin,
        three_ds: JSON.stringify({
          required: settings.require3ds,
          status: settings.require3ds ? "pending" : "not_required",
          version: null,
        }),
        next_action: JSON.stringify(nextActionOf("requires_payment_method")),
        metadata: JSON.stringify({}),
        version: 1,
        created_at: now,
        updated_at: now,
      });
      const row = await this.repository.payment(trx, id);
      if (row === undefined) {
        throw new Error("a payment of this transaction is not readable");
      }
      payment = this.gatewayPaymentOf(row, minorUnits);
      await this.event(trx, row, {
        type: "payment.created",
        statusTo: "requires_payment_method",
        payload: {
          checkoutId: checkout.id,
          cardBrand: brand,
          cardFee: fee,
          cardFeeSource: quote?.source ?? null,
          replaced: replaced.map((entry) => entry.id),
        },
        now,
      });
    }
    await this.repository.updateCheckout(trx, checkout.id, {
      status: "payment_pending",
      terms_accepted_at: now,
      fees_amount: fee,
      total_amount: total,
      payment_brand: brand,
      expires_at: extendedExpiry(checkout, now),
      updated_at: now,
    });
    return { payment, replaced };
  }

  /**
   * Step 4: the PaymentIntent; a provider failure is recorded on the payment (no PaymentIntent) and answered 502. The
   * row stays ready for a retry with its key, unless Stripe keeps the failure as the answer of `pi:create:<pay_id>`
   * (a 5xx, `failureKeptForKey`): that key can never succeed, so the row is `failed` and the retry creates a payment
   * of its own.
   */
  private async createSession(
    ctx: GatewayContext,
    payment: GatewayPayment,
    checkoutId: string,
    settings: PaymentSettingsRow,
  ): Promise<GatewaySession> {
    try {
      return await this.gateway.createSession(ctx, payment, {
        checkoutId,
        requireThreeDSecure: settings.require3ds,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "PAYMENT_PROVIDER_ERROR") {
        const kept = failureKeptForKey(error);
        await this.tx
          .run(async (trx) => {
            const row = await this.repository.payment(trx, payment.id, true);
            if (row === undefined) {
              return;
            }
            const now = this.clock.now();
            const failed = kept && row.status === "requires_payment_method" && row.providerPaymentId === null;
            if (failed) {
              await this.repository.updatePayment(trx, row.id, row.version, {
                status: "failed",
                failure_code: "PAYMENT_PROVIDER_ERROR",
                failure_message: null,
                next_action: JSON.stringify(nextActionOf("failed")),
                updated_at: now,
              });
            }
            await this.event(trx, row, {
              type: "payment.provider_error",
              statusFrom: failed ? row.status : undefined,
              statusTo: failed ? "failed" : undefined,
              payload: { operation: "createSession", keyReusable: !kept },
              now,
            });
          })
          .catch((recordError: unknown) => {
            this.logger.warn(
              { err: recordError, paymentId: payment.id },
              "payments.provider_error_not_recorded",
            );
          });
      }
      throw error;
    }
  }

  /** Cancels the PaymentIntents of replaced payments at Stripe (best effort; OBE-040 voids what is left). */
  private async cancelAtProvider(ctx: GatewayContext, rows: readonly PaymentRow[]): Promise<void> {
    for (const row of rows) {
      if (row.providerPaymentId === null || row.provider !== "stripe") {
        continue;
      }
      try {
        const minorUnits = await this.tx.run((trx) => this.minorUnitsOf(trx, row.currency));
        const state = await this.gateway.void(ctx, this.gatewayPaymentOf(row, minorUnits));
        if (row.status === "authorized" && state.status === "canceled") {
          await this.tx.run(async (trx) => {
            const current = await this.repository.payment(trx, row.id, true);
            if (current?.status === "authorized") {
              const now = this.clock.now();
              const { values } = stateValues(current, state, now);
              await this.repository.updatePayment(trx, current.id, current.version, values);
              await this.event(trx, current, {
                type: "payment.voided",
                statusFrom: current.status,
                statusTo: "canceled",
                payload: { reason: "replaced" },
                now,
              });
            }
          });
        }
      } catch (error) {
        this.logger.warn(
          { err: error instanceof AppError ? error.cause : error, paymentId: row.id },
          "payments.replaced_payment_not_cancelled",
        );
      }
    }
  }

  // ---- checkout.getPayment ---------------------------------------------------------------------------------------

  async get(paymentId: string): Promise<Payment> {
    const tenant = this.tenants.require();
    const ctx = this.gatewayContext(tenant);
    const read = await this.tx.run(async (trx) => {
      const row = await this.readable(trx, tenant, paymentId);
      return { row, minorUnits: await this.minorUnitsOf(trx, row.currency) };
    });
    let row = read.row;
    let clientSecret: string | null = null;
    if (this.needsRefresh(row, this.clock.now())) {
      try {
        const state = await this.gateway.refresh(ctx, this.gatewayPaymentOf(row, read.minorUnits));
        clientSecret = state.clientSecret;
        row = await this.tx.run((trx) => this.applyState(trx, row, state));
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          (error.code !== "PAYMENT_PROVIDER_ERROR" && error.code !== "PAYMENT_PROVIDER_NOT_CONFIGURED")
        ) {
          throw error;
        }
        // Provider outages answer the stored state (the error is logged by the gateway).
        this.logger.warn({ paymentId: row.id, code: error.code }, "payments.refresh_failed");
      }
    }
    return toPayment(row, {
      minorUnits: read.minorUnits,
      clientSecret,
      publishableKey: await this.publishableKeyOf(ctx, row),
    });
  }

  private needsRefresh(row: PaymentRow, now: Date): boolean {
    if (row.provider !== "stripe" || row.providerPaymentId === null || !NOT_FINAL.has(row.status)) {
      return false;
    }
    return CONFIRMABLE.has(row.status) || now.getTime() - row.updatedAt.getTime() > PAYMENT_REFRESH_AFTER_MS;
  }

  /** Applies a refreshed state to the payment, if it is still not final; answers the row as it is then. */
  private async applyState(
    trx: TenantTransaction,
    read: PaymentRow,
    state: GatewayState,
  ): Promise<PaymentRow> {
    const now = this.clock.now();
    const current = await this.repository.payment(trx, read.id, true);
    if (current === undefined) {
      throw notFound();
    }
    if (!NOT_FINAL.has(current.status) || current.providerPaymentId !== state.providerPaymentId) {
      return current;
    }
    if (!new Money(state.amount).equals(current.amount)) {
      this.logger.warn({ paymentId: current.id }, "payments.provider_amount_differs");
    }
    const { status, values } = stateValues(current, state, now);
    const changed =
      status !== current.status ||
      (state.card?.last4 ?? null) !== current.cardLast4 ||
      (state.failure?.code ?? null) !== current.failureCode;
    if (!changed) {
      return current;
    }
    await this.repository.updatePayment(trx, current.id, current.version, values);
    await this.event(trx, current, {
      type: `payment.${status}`,
      statusFrom: current.status,
      statusTo: status,
      amount: status === "authorized" ? String(values["amount_authorized"]) : undefined,
      payload: {
        source: "refresh",
        cardBrand: state.card?.brand ?? null,
        cardLast4: state.card?.last4 ?? null,
        threeDSecure: state.threeDSecure?.status ?? null,
        failureCode: state.failure?.code ?? null,
        declineCode: state.failure?.declineCode ?? null,
      },
      now,
    });
    const updated = await this.repository.payment(trx, current.id);
    if (updated === undefined) {
      throw notFound();
    }
    return updated;
  }

  // ---- checkout.updatePayment ------------------------------------------------------------------------------------

  async update(input: UpdatePaymentInput): Promise<Payment> {
    const tenant = this.tenants.require();
    const ctx = this.gatewayContext(tenant);
    const hint: CardHint = { brand: input.body.card.brand, bin: input.body.card.bin };
    for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt += 1) {
      const first = await this.tx.run(async (trx) => {
        const now = this.clock.now();
        const row = await this.readable(trx, tenant, input.paymentId);
        if (row.provider !== "stripe" || row.method !== "card" || row.checkoutId === null) {
          throw new AppError("PAYMENT_NOT_UPDATABLE", { details: { status: apiStatusOf(row.status) } });
        }
        if (row.status !== "requires_payment_method") {
          throw new AppError("PAYMENT_NOT_UPDATABLE", {
            message: "The payment can no longer be changed: create a new payment.",
            details: { status: apiStatusOf(row.status) },
          });
        }
        const checkout = await this.checkoutOf(trx, row.checkoutId);
        const status = effectiveStatus(checkout, now);
        if (status === "completed") {
          throw new AppError("CHECKOUT_ALREADY_COMPLETED");
        }
        if (status !== "open" && status !== "payment_pending") {
          throw new AppError("CHECKOUT_EXPIRED");
        }
        this.checkBrand(await this.settingsOf(trx, tenant), hint.brand);
        const minorUnits = await this.minorUnitsOf(trx, row.currency);
        if (row.cardBrand === hint.brand && row.cardBin === (hint.bin ?? null)) {
          return { kind: "same" as const, row, minorUnits };
        }
        const priced = await this.pricedOfferOf(trx, checkout.pricedOfferId, input.acceptLanguage);
        const plan = await this.cardFees.prepare(trx, priced, hint, this.baseAmount(checkout), now);
        return { kind: "quote" as const, row, checkout, plan, minorUnits };
      });
      if (first.kind === "same") {
        return toPayment(first.row, {
          minorUnits: first.minorUnits,
          clientSecret: null,
          publishableKey: await this.publishableKeyOf(ctx, first.row),
        });
      }
      const { row, checkout, plan, minorUnits } = first;
      const quote = await this.cardFees.quote(ctx, plan, "checkout.updatePayment");
      const fee = new Money(quote.total).toFixed(minorUnits);
      const total = new Money(this.baseAmount(checkout)).plus(fee).toFixed(minorUnits);
      if (row.providerPaymentId !== null && !new Money(total).equals(row.amount)) {
        try {
          await this.gateway.updateAmount(ctx, this.gatewayPaymentOf(row, minorUnits), total);
        } catch (error) {
          if (error instanceof AppError && error.code === "PAYMENT_PROVIDER_ERROR") {
            await this.afterUpdateFailure(row);
          }
          throw error;
        }
      }
      const updated = await this.tx.run(async (trx) => {
        const now = this.clock.now();
        const lockedCheckout = await this.repository.checkout(trx, checkout.id, true);
        const locked = await this.repository.payment(trx, row.id, true);
        if (
          lockedCheckout === undefined ||
          locked === undefined ||
          lockedCheckout.version !== checkout.version ||
          locked.version !== row.version
        ) {
          return undefined;
        }
        await this.repository.updatePayment(trx, locked.id, locked.version, {
          amount: total,
          card_fee_amount: fee,
          card_brand: quote.brand,
          card_bin: quote.bin,
          updated_at: now,
        });
        await this.event(trx, locked, {
          type: "payment.amount_updated",
          amount: total,
          payload: {
            oldAmount: locked.amount,
            newAmount: total,
            cardBrand: quote.brand,
            cardFee: fee,
            amadeusCardFee: quote.amadeusFee,
            cardFeeSource: quote.source,
          },
          now,
        });
        await this.repository.updateCheckout(trx, lockedCheckout.id, {
          fees_amount: fee,
          total_amount: total,
          payment_brand: quote.brand,
          updated_at: now,
        });
        return await this.repository.payment(trx, locked.id);
      });
      if (updated === undefined) {
        continue;
      }
      this.logger.info(
        { paymentId: updated.id, cardBrand: quote.brand, cardFeeSource: quote.source },
        "payments.amount_updated",
      );
      return toPayment(updated, {
        minorUnits,
        clientSecret: null,
        publishableKey: await this.publishableKeyOf(ctx, updated),
      });
    }
    throw new AppError("CONFLICT", { message: "The payment changed while it was updated; try again." });
  }

  /**
   * After a failed PaymentIntent update the payment's `version` moves on, with a `payment.provider_error` event, so the
   * next update sends a key of its own: Stripe may have set the amount for an answer that was lost, keeps a 5xx as the
   * answer of `pi:update:<pay_id>:<version>`, and refuses that key with another amount (the customer's next card), so
   * the key is not sent again. Setting an amount twice is harmless. Best effort: a failure to record it is logged.
   */
  private async afterUpdateFailure(row: PaymentRow): Promise<void> {
    await this.tx
      .run(async (trx) => {
        const locked = await this.repository.payment(trx, row.id, true);
        if (locked === undefined || locked.version !== row.version) {
          return;
        }
        const now = this.clock.now();
        await this.repository.updatePayment(trx, locked.id, locked.version, { updated_at: now });
        await this.event(trx, locked, {
          type: "payment.provider_error",
          payload: { operation: "updateAmount", keyReusable: false },
          now,
        });
      })
      .catch((recordError: unknown) => {
        this.logger.warn({ err: recordError, paymentId: row.id }, "payments.provider_error_not_recorded");
      });
  }

  // ---- Shared ----------------------------------------------------------------------------------------------------

  private gatewayContext(tenant: RequestTenant): GatewayContext {
    return {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      requestId: this.tenants.requestId() ?? tenant.requestId,
    };
  }

  private gatewayPaymentOf(row: PaymentRow, minorUnits: number): GatewayPayment {
    return {
      id: row.id,
      checkoutId: row.checkoutId,
      providerPaymentId: row.providerPaymentId,
      currency: row.currency,
      amount: new Money(row.amount).toFixed(minorUnits),
      minorUnits,
      version: row.version,
    };
  }

  /** The amount charged before the card fee: the offer and the extras. */
  private baseAmount(checkout: PaymentCheckoutRow): string {
    return new Money(checkout.offerAmount).plus(checkout.ancillariesAmount).toString();
  }

  /** The publishable key for a payment's front end: the current account's, when it is the payment's connection. */
  private async publishableKeyOf(ctx: GatewayContext, row: PaymentRow): Promise<string | null> {
    if (row.provider !== "stripe") {
      return null;
    }
    const account = await this.gateway.findAccount(ctx);
    return account !== null && account.connectionId === row.providerConnectionId
      ? account.publishableKey
      : null;
  }

  /** The payment if the request may read it (its checkout's access rules), in its environment; `404` otherwise. */
  private async readable(
    trx: TenantTransaction,
    tenant: RequestTenant,
    paymentId: string,
  ): Promise<PaymentRow> {
    const row = await this.repository.payment(trx, paymentId);
    if (row === undefined || row.environment !== tenant.environment || !this.mayAccess(row)) {
      throw notFound();
    }
    return row;
  }

  /** As a checkout's access (checkout.service.ts): console scope, a guest checkout's id, its customer, a secret key. */
  private mayAccess(row: PaymentRow): boolean {
    if (this.requestContext.isConsoleScope()) {
      return true;
    }
    const caller = this.callers.get();
    const secretKey = caller?.type === "key" && caller.kind === "secret";
    if (row.checkoutId === null) {
      return secretKey;
    }
    if (row.checkoutCustomerId === null && row.checkoutIsGuest) {
      return true;
    }
    const customer = this.customers.get();
    if (customer !== undefined) {
      return row.checkoutCustomerId !== null && row.checkoutCustomerId === customer.customerId;
    }
    return secretKey;
  }

  private async checkoutOf(trx: TenantTransaction, checkoutId: string): Promise<PaymentCheckoutRow> {
    const checkout = await this.repository.checkout(trx, checkoutId);
    if (checkout === undefined) {
      throw new AppError("NOT_FOUND", { message: "No checkout with this id." });
    }
    return checkout;
  }

  private async pricedOfferOf(
    trx: TenantTransaction,
    pricedOfferId: string,
    acceptLanguage: string | undefined,
  ): Promise<CheckoutPricedOffer> {
    const priced = await this.pricedOffers.forCheckout(trx, pricedOfferId, acceptLanguage);
    if (priced === undefined) {
      throw new Error("the priced offer of a checkout is missing");
    }
    return priced;
  }

  private async settingsOf(trx: TenantTransaction, tenant: RequestTenant): Promise<PaymentSettingsRow> {
    const settings = await this.repository.settings(trx);
    if (settings === undefined) {
      this.logger.warn({ tenantId: tenant.tenantId }, "payments.settings_missing");
      throw new AppError("TENANT_SUSPENDED", { message: "The storefront of this OTA is not ready yet." });
    }
    return settings;
  }

  /** A card hint's brand must be one the storefront accepts (`storefront_settings.accepted_card_brands`). */
  private checkBrand(settings: PaymentSettingsRow, brand: string): void {
    if (!settings.acceptedCardBrands.includes(brand)) {
      throw new AppError("UNPROCESSABLE", {
        message: "This card brand is not accepted.",
        details: { reason: "card_brand_not_accepted", acceptedCardBrands: [...settings.acceptedCardBrands] },
      });
    }
  }

  private async minorUnitsOf(trx: TenantTransaction, currency: string): Promise<number> {
    return (await this.repository.currencyMinorUnits(trx, currency)) ?? 2;
  }

  /** Appends a `payment_events` row (`source = api`), its payload through the shared redactor. */
  private async event(
    trx: TenantTransaction,
    row: PaymentRow,
    event: {
      readonly type: string;
      readonly statusFrom?: string | undefined;
      readonly statusTo?: string | undefined;
      readonly amount?: string | undefined;
      readonly payload?: Record<string, unknown>;
      readonly now: Date;
    },
  ): Promise<void> {
    await this.repository.insertEvent(trx, {
      id: this.ids.newId("pev"),
      payment_id: row.id,
      type: event.type,
      source: "api",
      status_from: event.statusFrom ?? null,
      status_to: event.statusTo ?? null,
      amount: event.amount ?? null,
      currency: event.amount === undefined ? null : row.currency,
      payload: JSON.stringify(redactPayload(event.payload ?? {})),
      created_at: event.now,
      updated_at: event.now,
    });
  }
}
