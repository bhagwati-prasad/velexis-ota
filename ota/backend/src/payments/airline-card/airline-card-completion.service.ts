// checkout.completeWithAirlineCard (completeCheckoutWithAirlineCard, `x-scope: customer`, `x-edge-only`; OBE-051;
// ota/docs/api-changes.md §3.2, OADR-0004 points 1–3, 5–7, ota/docs/flows/checkout-airline-card.md §1–§4,
// architecture-booking.md §3 and §5.1 point 4). The controller (airline-card-completion.controller.ts) checked the card
// against what the schema cannot say (card-validation.ts) and wrapped it in a SensitiveCard; this service runs the
// route's checks in their order and hands the booking to the BookingOrchestrator:
//
//   1. the caller is the storefront edge (the scope guard refuses every other caller with `403 SCOPE_NOT_ALLOWED`
//      before the handler; checked again here);
//   2. the global switch `AIRLINE_CARD_ENABLED` and `storefront_settings.airline_card_enabled_<env>` (`403
//      FEATURE_DISABLED`, `details.feature = "airlineCard"`, AirlineCardGateway);
//   3. Redis and the limits (abuse-limits.ts): `503 SERVICE_UNAVAILABLE` without Redis, `403 FEATURE_DISABLED`
//      (`details.reason = "suspended"`) while 20 declines of the hour suspend the method, `403
//      PAYMENT_ATTEMPTS_EXCEEDED` once the checkout has three declined attempts. The 5 per minute per IP and 60 per
//      hour per tenant are the rate-limit guard's (`429 RATE_LIMITED`), counted before the handler;
//   4. the card: `400 VALIDATION_FAILED` for the Luhn digit (`luhn`), a past expiry (`expired`) or a blank holder,
//      with paths only (not an attempt); a brand the storefront does not accept is `422 UNPROCESSABLE`
//      (`details.reason = "card_brand_not_accepted"`);
//   5. the booking (BookingOrchestrator.completeWithAirlineCard). Right before the card is sent, once the claim has
//      committed, the limits of step 3 are checked again (`beforeSend`): a decline of a concurrent completion of the
//      checkout counted since step 3, or a suspension since, refuses the request with nothing sent. A card the airline
//      declined (Amadeus 1304) comes back through `declined` before the booking and the payment are `failed` (failing
//      the booking frees the checkout for the next completion): the attempt is counted (abuse-limits.ts);
//      the third answers `403 PAYMENT_ATTEMPTS_EXCEEDED` and alerts the OTA's staff (`staff.airline_card_alert`, kind
//      `repeated_declines`, to `ops_alert_email`, else the owners, else OPS_ALERT_EMAIL: StaffRecipients) and Velexis
//      ops (the same e-mail to OPS_ALERT_EMAIL when the process has one, and the error line
//      `payments.airline_card_attempts_exceeded`); the others `402 PAYMENT_DECLINED`. The decline that suspends the
//      method alerts both too (kind `method_suspended`, `payments.airline_card_suspended`). A decline Redis cannot
//      count is logged and answered `402`: the next request meets the outage in step 3.
//
// Idempotency (AirlineCardCompletionIdempotencyHooks): the request hash covers the body with `card` replaced by
// `{brand, last4}` (OADR-0004 point 3: no hash of a card number is stored), and a stored `504 SUPPLIER_TIMEOUT` is
// linked to its pending booking and answered from it on a same-key retry, as checkout.complete's (OBE-043): the card is
// never sent twice. The handler never retries anything itself; the SDK method has no retries either.
//
// Nothing here logs, stores, queues or throws a value of the card: log lines carry ids, codes and counts; the alerts
// name the booking and the checkout.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import { AppError, type FieldError } from "@velexis/errors";
import { PinoLogger } from "nestjs-pino";
import {
  BookingOrchestrator,
  pendingBookingOf,
  type DeclinedBooking,
} from "../../bookings/booking-orchestrator.service";
import type { CheckoutCompletion } from "../../bookings/order-recorder";
import { Clock } from "../../common/clock";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotencyRecord,
  type IdempotencyResource,
  type IdempotencyResponse,
  type IdempotentInput,
} from "../../common/http/idempotency.service";
import { EMAIL_ADDRESS } from "../../config";
import { InvalidNotificationError, OutboxService } from "../../notifications/outbox.service";
import { StaffRecipients } from "../../notifications/staff-recipients";
import { CallerContext } from "../../tenancy/caller-resolver";
import { TenantContext, type RequestTenant } from "../../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../../tenancy/tenant-tx";
import { PaymentsRepository } from "../payments.repository";
import { AirlineCardLimits, attemptsExceeded, type AirlineCardScope } from "./abuse-limits";
import { AirlineCardGateway } from "./airline-card.gateway";
import type { CheckedCard } from "./card-validation";

type Schemas = components["schemas"];
type MoneyAmount = Schemas["Money"];

/** The template of the airline card's abuse alerts (OADR-0013 item 4, OADR-0004 point 6). */
export const AIRLINE_CARD_ALERT_TEMPLATE = "staff.airline_card_alert";

/** The kinds of the abuse alerts (`alert.kind` of the template, the dedupe key's part). */
export const AIRLINE_CARD_ALERT_KINDS = Object.freeze({
  repeatedDeclines: "repeated_declines",
  methodSuspended: "method_suspended",
} as const);

/** The input of checkout.completeWithAirlineCard, from the controller. */
export interface AirlineCardCompletionRequest {
  readonly checkoutId: string;
  readonly paymentId: string;
  readonly expectedTotal: MoneyAmount;
  /** The card, checked and wrapped by the controller; the controller discards it once this returns. */
  readonly card: CheckedCard;
  readonly acceptLanguage?: string | undefined;
}

/** `403 SCOPE_NOT_ALLOWED` of a caller other than the storefront edge (as the scope guard answers it). */
const edgeOnly = (): AppError =>
  new AppError("SCOPE_NOT_ALLOWED", {
    message: "This operation is available on the hosted storefront only.",
    details: { reason: "edge_only" },
  });

/** `400 VALIDATION_FAILED` of a card the server refused (card-validation.ts): paths and codes only. */
const cardRefused = (fieldErrors: readonly FieldError[]): AppError =>
  new AppError("VALIDATION_FAILED", { message: "Check the card details.", fieldErrors });

@Injectable()
export class AirlineCardCompletionService {
  /** Velexis ops (OPS_ALERT_EMAIL), when the process has it; the abuse alerts go there too. */
  private readonly opsEmail: string | null;
  private readonly baseDomain: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly callers: CallerContext,
    private readonly gateway: AirlineCardGateway,
    private readonly payments: PaymentsRepository,
    private readonly limits: AirlineCardLimits,
    private readonly orchestrator: BookingOrchestrator,
    private readonly staffRecipients: StaffRecipients,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(AirlineCardCompletionService.name);
    // OPS_ALERT_EMAIL is optional (a shared variable since lead decision (4) of 2026-10-23): read untyped, as
    // StaffRecipients reads it.
    const ops: unknown = config.get("OPS_ALERT_EMAIL");
    this.opsEmail = typeof ops === "string" && EMAIL_ADDRESS.test(ops) ? ops : null;
    const domain: unknown = config.get("STOREFRONT_BASE_DOMAIN");
    if (typeof domain !== "string") {
      throw new Error("STOREFRONT_BASE_DOMAIN is not configured");
    }
    this.baseDomain = domain;
  }

  /** Completes the checkout with the airline card (see the file header). */
  async complete(input: AirlineCardCompletionRequest): Promise<CheckoutCompletion> {
    const tenant = this.tenants.require();
    if (this.callers.get()?.type !== "edge") {
      throw edgeOnly();
    }
    this.gateway.assertGloballyEnabled();
    const settings = await this.tx.run((trx) => this.payments.settings(trx));
    if (settings === undefined) {
      this.logger.warn({ tenantId: tenant.tenantId }, "payments.settings_missing");
      throw new AppError("TENANT_SUSPENDED", { message: "The storefront of this OTA is not ready yet." });
    }
    this.gateway.assertEnabled(tenant.environment, settings);
    const scope: AirlineCardScope = {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      checkoutId: input.checkoutId,
    };
    await this.limits.assertAvailable(scope);
    if (!input.card.ok) {
      throw cardRefused(input.card.fieldErrors);
    }
    const card = input.card.card;
    if (!settings.acceptedCardBrands.includes(card.brand())) {
      throw new AppError("UNPROCESSABLE", {
        message: "This card brand is not accepted.",
        details: { reason: "card_brand_not_accepted", acceptedCardBrands: [...settings.acceptedCardBrands] },
      });
    }
    return await this.orchestrator.completeWithAirlineCard({
      checkoutId: input.checkoutId,
      paymentId: input.paymentId,
      expectedTotal: input.expectedTotal,
      card,
      acceptLanguage: input.acceptLanguage,
      beforeSend: () => this.limits.assertAvailable(scope),
      declined: (booking, error) => this.declined(tenant, scope, booking, error),
    });
  }

  /**
   * A card the airline declined (see the file header, step 5): counts the attempt, alerts on the third and on a
   * suspension, and answers `403 PAYMENT_ATTEMPTS_EXCEEDED` on the third, else the decline.
   */
  private async declined(
    tenant: RequestTenant,
    scope: AirlineCardScope,
    booking: DeclinedBooking,
    error: AppError,
  ): Promise<AppError> {
    let counted: Awaited<ReturnType<AirlineCardLimits["countDecline"]>>;
    try {
      counted = await this.limits.countDecline(scope);
    } catch (failure) {
      this.logger.error(
        { tenantId: tenant.tenantId, checkoutId: scope.checkoutId, bookingId: booking.id, err: failure },
        "payments.airline_card_decline_not_counted",
      );
      return error;
    }
    this.logger.warn(
      {
        tenantId: tenant.tenantId,
        checkoutId: scope.checkoutId,
        bookingId: booking.id,
        attempts: counted.attempts,
        declines: counted.declines,
      },
      "payments.airline_card_declined",
    );
    if (counted.suspendedNow) {
      this.logger.error(
        { tenantId: tenant.tenantId, environment: tenant.environment, declines: counted.declines },
        "payments.airline_card_suspended",
      );
      await this.alert(tenant, booking, AIRLINE_CARD_ALERT_KINDS.methodSuspended, {
        dedupe: `${tenant.environment}:${this.clock.now().toISOString().slice(0, 16)}`,
        message:
          `The airline declined ${counted.declines} airline-card payments of the ${tenant.environment} storefront ` +
          "within an hour: paying with the airline card is suspended there for an hour. Check the checkouts and " +
          "bookings concerned in the OTA admin.",
      });
    }
    if (!counted.locked) {
      return error;
    }
    this.logger.error(
      { tenantId: tenant.tenantId, checkoutId: scope.checkoutId, attempts: counted.attempts },
      "payments.airline_card_attempts_exceeded",
    );
    await this.alert(tenant, booking, AIRLINE_CARD_ALERT_KINDS.repeatedDeclines, {
      dedupe: scope.checkoutId,
      message:
        `The airline declined ${counted.attempts} airline-card payments of checkout ${scope.checkoutId} (last ` +
        `booking ${booking.reference}); the checkout takes no more airline-card attempts.`,
    });
    return attemptsExceeded();
  }

  /**
   * One abuse alert (`staff.airline_card_alert`): to the OTA's staff (StaffRecipients) and to Velexis ops
   * (OPS_ALERT_EMAIL, unless StaffRecipients already chose it), once per dedupe key, in a transaction of its own. A
   * failure is logged: the answer to the traveller never depends on it.
   */
  private async alert(
    tenant: RequestTenant,
    booking: DeclinedBooking,
    kind: string,
    alert: { readonly dedupe: string; readonly message: string },
  ): Promise<void> {
    const dedupeKey = `${AIRLINE_CARD_ALERT_TEMPLATE}:${kind}:${alert.dedupe}`;
    const input = {
      templateKey: AIRLINE_CARD_ALERT_TEMPLATE,
      locale: booking.locale,
      bookingId: booking.id,
      data: {
        booking: {
          reference: booking.reference,
          recordLocator: "",
          consoleUrl: `https://admin.${this.baseDomain}/bookings/${booking.id}`,
        },
        alert: { kind, message: alert.message, occurredAt: this.clock.now().toISOString() },
      },
    } as const;
    try {
      await this.tx.run(async (trx: TenantTransaction) => {
        const sent = await this.staffRecipients.enqueue(trx, { ...input, dedupeKey });
        const opsHadIt = sent.recipients.some((recipient) => recipient.source === "velexis_ops");
        if (this.opsEmail !== null && !opsHadIt) {
          await this.outbox.enqueue(trx, {
            ...input,
            to: this.opsEmail,
            recipientType: "staff",
            dedupeKey: `${dedupeKey}:ops`,
          });
        }
      });
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        this.logger.error(
          { tenantId: tenant.tenantId, bookingId: booking.id, kind, err: error },
          "payments.airline_card_alert_failed",
        );
        return;
      }
      this.logger.warn(
        { tenantId: tenant.tenantId, bookingId: booking.id, kind },
        "payments.airline_card_alert_invalid",
      );
    }
  }
}

/**
 * The idempotency hooks of checkout.completeWithAirlineCard (idempotency.service.ts; see the file header): the hash
 * input with `card` as `{brand, last4}`, and the `504` of a pending booking linked to it and answered from it.
 */
@Injectable()
@IdempotencyHooksFor(["completeCheckoutWithAirlineCard"])
export class AirlineCardCompletionIdempotencyHooks implements IdempotencyHooks {
  constructor(private readonly orchestrator: BookingOrchestrator) {}

  hashInput(input: IdempotentInput): unknown {
    return { ...input, body: hashableBody(input.body) };
  }

  resourceOf(response: IdempotencyResponse): IdempotencyResource | undefined {
    return pendingBookingOf(response);
  }

  resolveReplay(record: IdempotencyRecord): Promise<IdempotencyResponse | undefined> {
    return this.orchestrator.replay(record);
  }
}

/** The body as the request hash covers it: `card` as its brand and last 4 digits, nothing else of it (OADR-0004). */
export function hashableBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return body;
  }
  const { card, ...rest } = body as Record<string, unknown>;
  if (typeof card !== "object" || card === null || Array.isArray(card)) {
    return rest;
  }
  const { brand, number } = card as Record<string, unknown>;
  return {
    ...rest,
    card: {
      brand: typeof brand === "string" ? brand : null,
      last4: typeof number === "string" ? number.slice(-4) : null,
    },
  };
}
