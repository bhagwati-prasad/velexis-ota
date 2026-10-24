// The console payments (OBE-068; ota/docs/api-changes-console-and-internal.md §3, ota/docs/flows/console-operations.md
// §3 step 5, OADR-0010 points 1, 3, 5 and 6, the document's consoleListPayments, consoleGetPayment,
// consoleCapturePayment and consoleRefundPayment): what OTA staff (or a `console:automation` key listing the
// operation's permission) see and do of the OTA's payments, in the request's environment only. The permission guard
// checked `payments:read`, `payments:capture` or `payments:refund` and the environment before this runs (OBE-060); a
// payment of the other environment, or an unknown id, answers `404 NOT_FOUND`, the same answer. No transaction is open
// during a Stripe call (architecture §4).
//
// - `list` (`payments:read`): the payments of the environment, newest first (`created_at`, then `id`, descending) with
//   a keyset cursor bound to the environment and the filters (`status` in the API's spelling, `cancelled` for the
//   stored `canceled`; `provider`, `method`, `bookingId`, `createdFrom` at or after, `createdTo` before). No Stripe call.
// - `get` (`payments:read`, `ETag: "<version>"`): one payment as a ConsolePayment. `refresh=true` first reads the
//   PaymentIntent again through the PaymentGateway (the Velexis account of the payment's environment: the only mode
//   served before M5) and applies it under the row's lock and `version` with payment-state.ts's rules, as the webhook
//   processor does, with a `payment_events` row (`source = staff`); an airline-card payment, or one without a
//   PaymentIntent, is answered as stored. A Stripe failure answers `502 PAYMENT_PROVIDER_ERROR` and changes nothing.
// - `capture` (`payments:capture`, `If-Match`, `Idempotency-Key`; plan step 2): T1 reads the payment (`412` when the
//   `If-Match` is stale; `409 CONFLICT` `payment_not_capturable` unless it is a Stripe payment in `authorized`; the
//   amount in the payment's currency (`422` `currency_mismatch`), positive with at most the currency's minor units
//   (`400` at `/amount/amount`), at most the authorised amount (`422` `amount_exceeds_authorized`); none: the whole
//   authorisation). Then the gateway captures with `pi:capture:<pay_id>:<amount>` outside any transaction (a partial
//   capture releases the rest at Stripe). T2 locks the booking (`FOR UPDATE`), then the payment (OADR-0003 point 11),
//   applies the PaymentIntent's state (`captured`, `amountCaptured`, `capturedAt`) with the `payment.captured` event
//   (`source = staff`), shows the capture on the booking (`amount_paid` and the customer-visible `payment.captured`
//   booking event, once) and writes the `payment.capture` staff action with the reason. A failed capture reads the
//   PaymentIntent again: captured with this amount (an answer that was lost) is recorded as above; cancelled (the
//   authorisation expired or was voided) is applied and answers `402 PAYMENT_DECLINED`; captured with another amount
//   is applied and answers `409` `payment_not_capturable`; anything else, or no answer, is `502
//   PAYMENT_PROVIDER_ERROR` (the idempotency interceptor releases the key, so the same key, and with it the same Stripe
//   key, can be sent again). The idempotency interceptor stores the `200`: the same key captures once.
// - `refund` (`payments:refund`, `Idempotency-Key`; plan step 3): one transaction checks the payment (an airline-card
//   payment `422` `refund_via_airline`; anything but a Stripe payment in `captured` or `partially_refunded` `409`
//   `payment_not_refundable`; the amount's currency and format as for a capture), asks RefundsRepository.create for the
//   `pending` row (it locks the booking, then the payment, and checks the amount against the captured amount less the
//   refunded one and the refunds in flight: `422` `amount_exceeds_captured` with `details.refundable`; it writes the
//   `refund.requested` payment event), writes the booking's customer-visible `refund.requested` event (lead decision 6
//   of 2026-10-22: worded as asked for; only Stripe's answer makes it refunded, the webhook's `refund.succeeded`) and
//   the `payment.refund` staff action, and queues `refund.submit` on `ota-payments` after the commit. The request makes
//   no Stripe call: `201` with the payment and its `pending` refund, read in that transaction (so the answer never
//   races the payments queue, which may claim the refund as soon as it is queued). The enqueue never fails the request
//   (a Redis outage is logged and the row stays `pending`).
//
// No successful read writes a `staff_actions` row (OADR-0011 point 8 as decided on 2026-10-21): the capture and the
// refund write theirs in their own transaction, the audit interceptor the refused and failed calls. The answers never
// carry a client secret (`clientSecret` is always `null` in console scope), card data beyond the brand, BIN, last 4 and
// expiry, or a token; event payloads pass the shared redactor again on the way out.
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { components, operations } from "@velexis/api-types";
import { AppError, isAppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { listFingerprint } from "../bookings/bookings.mapper";
import { eventActorOf } from "../bookings/order-recorder";
import { ifMatchSatisfied } from "../checkout/checkout.mapper";
import { invalidCursor } from "../reference/reference.mapper";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { OTA_QUEUE } from "../common/queues/queue-names";
import { AIRLINE_PROVIDER } from "../payments/airline-card/airline-card.gateway";
import {
  PAYMENT_GATEWAY,
  type GatewayContext,
  type GatewayPayment,
  type GatewayState,
  type PaymentGateway,
} from "../payments/payment-gateway";
import { providerStateUpdate } from "../payments/payment-state";
import { PAYMENT_JOB, paymentJob } from "../payments/payments.processor";
import {
  PaymentsRepository,
  type ConsolePaymentEventRow,
  type ConsoleRefundRow,
  type PaymentBookingSummaryRow,
  type PaymentRow,
} from "../payments/payments.repository";
import { apiStatusOf, toPayment } from "../payments/payments.service";
import {
  REFUNDABLE_PAYMENT_STATUSES,
  RefundsRepository,
  type CreateRefundResult,
} from "../payments/refunds.repository";
import { StripeMetadataMismatchError } from "../payments/stripe/stripe.gateway";
import { Money } from "../pricing/pricing.types";
import { PlatformReadRepository, type PaymentAccountMode } from "../tenancy/platform-read.repository";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { afterCommit, TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { DEFAULT_CONSOLE_PAGE_LIMIT } from "./console-bookings.service";
import { StaffActionsWriter } from "./staff-actions.writer";

type Schemas = components["schemas"];
type MoneyAmount = Schemas["Money"];
export type ConsolePayment = Schemas["ConsolePayment"];
export type ConsolePaymentPage = Schemas["ConsolePaymentPage"];
export type ConsolePaymentEvent = Schemas["ConsolePaymentEvent"];
export type ConsolePaymentRefund = Schemas["ConsolePaymentRefund"];
export type ConsoleListPaymentsQuery = NonNullable<operations["consoleListPayments"]["parameters"]["query"]>;
export type ConsoleCaptureRequest = Schemas["ConsolePaymentCaptureRequest"];
export type ConsoleRefundRequest = Schemas["ConsolePaymentRefundRequest"];

/** `Cache-Control` of every console payment answer. */
export const CONSOLE_PAYMENT_CACHE_CONTROL = "private, no-store";

/** The `staff_actions.action` of the two changes. */
export const CONSOLE_PAYMENT_ACTIONS = Object.freeze({
  capture: "payment.capture",
  refund: "payment.refund",
} as const);

/** How long the request waits for the `refund.submit` enqueue after the commit (Redis down: logged, not failed). */
export const REFUND_ENQUEUE_TIMEOUT_MS = 2_000;

/** The `ETag` of a payment: its version, quoted. */
export function paymentEtagOf(version: number): string {
  return `"${version}"`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const money = (amount: string, currency: string, minorUnits: number): MoneyAmount => ({
  amount: new Money(amount).toFixed(minorUnits),
  currency,
});

/** A status as the API spells it (`cancelled`); the tables store the provider's `canceled`. */
const apiSpelling = (status: string): string => (status === "canceled" ? "cancelled" : status);

/** The stored statuses (`payments.status`) of the list's `status` filter, in the API's spelling. */
export function storedStatusesOf(statuses: readonly string[] | undefined): string[] | undefined {
  return statuses?.map((status) => (status === "cancelled" ? "canceled" : status));
}

// ---- Cursors -------------------------------------------------------------------------------------------------------

const CURSOR_VERSION = 1;
const CURSOR_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const PAYMENT_ID = /^pay_[0-9A-Za-z]{16,40}$/;
const MAX_CURSOR_LENGTH = 400;

/** The fingerprint of a console payments list: the environment and every filter. */
export function consolePaymentsFingerprint(environment: string, query: ConsoleListPaymentsQuery): string {
  const sorted = (values: readonly string[] | undefined): string | undefined =>
    values === undefined ? undefined : [...values].sort().join(",");
  const instant = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : new Date(value).toISOString();
  return listFingerprint({
    list: "console.payments",
    environment,
    status: sorted(query.status),
    provider: sorted(query.provider),
    method: sorted(query.method),
    bookingId: query.bookingId,
    createdFrom: instant(query.createdFrom),
    createdTo: instant(query.createdTo),
  });
}

/** The opaque cursor after the row with this sort key (`created_at`, UTC with microseconds) and id. */
export function encodePaymentCursor(fingerprint: string, key: string, id: string): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, fingerprint, key, id])).toString("base64url");
}

/**
 * The keyset position of `value` for the list of `fingerprint`; `400 VALIDATION_FAILED` (`/query/cursor`) for a value
 * this API did not write or a cursor of another list.
 */
export function decodePaymentCursor(
  value: string,
  fingerprint: string,
): { readonly key: string; readonly id: string } {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw invalidCursor();
  }
  const [version, print, key, id] = parsed as unknown[];
  if (
    version !== CURSOR_VERSION ||
    print !== fingerprint ||
    typeof key !== "string" ||
    !CURSOR_KEY.test(key) ||
    typeof id !== "string" ||
    !PAYMENT_ID.test(id)
  ) {
    throw invalidCursor();
  }
  return { key, id };
}

// ---- Rules ---------------------------------------------------------------------------------------------------------

/** A decimal amount as a capture or refund may give it: digits, at most two decimals, no sign (`numeric(12,2)`). */
const DECIMAL = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/;

/**
 * The amount of a capture or refund in the payment's currency, with `minorUnits` decimals: `422 UNPROCESSABLE`
 * (`currency_mismatch`, `details.currency`) for another currency, `400 VALIDATION_FAILED` at `/amount/amount` for an
 * amount that is not positive, has more than two decimals or more than the currency's minor units.
 */
export function requestedAmountOf(
  amount: MoneyAmount,
  payment: Pick<PaymentRow, "currency">,
  minorUnits: number,
): string {
  if (amount.currency !== payment.currency) {
    throw new AppError("UNPROCESSABLE", {
      message: `The amount must be in the payment's currency (${payment.currency}).`,
      details: { reason: "currency_mismatch", currency: payment.currency },
    });
  }
  const value = DECIMAL.test(amount.amount) ? new Money(amount.amount) : undefined;
  if (value === undefined || !value.greaterThan(0) || value.decimalPlaces() > minorUnits) {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [
        {
          path: "/amount/amount",
          code: "amount",
          message: `must be a positive amount with at most ${Math.min(minorUnits, 2)} decimals`,
        },
      ],
    });
  }
  return value.toFixed(minorUnits);
}

/** What a capture may take at most: the authorised amount (the payment's amount before Stripe reported one). */
export function authorizedCeilingOf(payment: Pick<PaymentRow, "amount" | "amountAuthorized">): string {
  const authorized = new Money(payment.amountAuthorized);
  return (authorized.greaterThan(0) ? authorized : new Money(payment.amount)).toFixed(2);
}

/** `409 CONFLICT` of a payment that is not in a state the action takes (`payment_not_capturable`, `_refundable`). */
export function paymentConflict(
  reason: "payment_not_capturable" | "payment_not_refundable",
  payment: Pick<PaymentRow, "provider" | "status">,
): AppError<"CONFLICT"> {
  const status = apiStatusOf(payment.status);
  return new AppError("CONFLICT", {
    message:
      reason === "payment_not_capturable"
        ? `Only an authorised Stripe payment can be captured; this one is ${status}.`
        : `Only a captured Stripe payment can be refunded; this one is ${status}.`,
    details: { reason, status, provider: payment.provider },
  });
}

/** Whether a payment can be captured from the console: a Stripe payment in `authorized` with its PaymentIntent. */
export function isCapturable(
  payment: Pick<PaymentRow, "provider" | "status" | "providerPaymentId">,
): boolean {
  return (
    payment.provider === "stripe" && payment.status === "authorized" && payment.providerPaymentId !== null
  );
}

/** How a capture whose call failed ends, from the PaymentIntent read again (`undefined`: it could not be read). */
export type CaptureFailureOutcome = "captured" | "declined" | "conflict" | "provider_error";

/**
 * The outcome of a failed capture call of `amount` (see the file header): `captured` when Stripe holds this capture
 * (an answer that was lost), `declined` when the PaymentIntent is cancelled (the authorisation expired or was voided),
 * `conflict` when it was captured with another amount, `provider_error` otherwise (still authorised, or unread).
 */
export function captureFailureOutcome(
  state: GatewayState | undefined,
  amount: string,
): CaptureFailureOutcome {
  if (state === undefined) {
    return "provider_error";
  }
  if (state.status === "canceled") {
    return "declined";
  }
  if (state.status === "captured") {
    return new Money(state.amountReceived).equals(amount) ? "captured" : "conflict";
  }
  return "provider_error";
}

/** The `502 PAYMENT_PROVIDER_ERROR` of a failed Stripe call, with the gateway's error as its cause (logs only). */
export function providerError(cause: unknown): AppError<"PAYMENT_PROVIDER_ERROR"> {
  return new AppError("PAYMENT_PROVIDER_ERROR", {
    message: "Stripe is not responding; try again.",
    details: { provider: "stripe" },
    cause,
  });
}

/** Whether `error` is a failure of the payment gateway (Stripe failed or is out of reach, or no account serves). */
function isGatewayFailure(error: unknown): boolean {
  return (
    isAppError(error) &&
    (error.code === "PAYMENT_PROVIDER_ERROR" || error.code === "PAYMENT_PROVIDER_NOT_CONFIGURED")
  );
}

// ---- The answer ----------------------------------------------------------------------------------------------------

/** A `payment_events` row as ConsolePaymentEvent: statuses in the API's spelling, the payload redacted again. */
export function toConsolePaymentEvent(
  row: ConsolePaymentEventRow,
  payment: Pick<PaymentRow, "currency">,
  minorUnits: number,
): ConsolePaymentEvent {
  return {
    id: row.id,
    type: row.type,
    source: row.source as ConsolePaymentEvent["source"],
    statusFrom: row.statusFrom === null ? null : apiSpelling(row.statusFrom),
    statusTo: row.statusTo === null ? null : apiSpelling(row.statusTo),
    amount: row.amount === null ? null : money(row.amount, row.currency ?? payment.currency, minorUnits),
    providerEventId: row.providerEventId,
    payload: isRecord(row.payload) ? (redactPayload(row.payload) as Record<string, unknown>) : {},
    createdAt: row.createdAt.toISOString(),
  };
}

const REQUESTER_ID = /^(?:cus_[0-9A-Za-z]{12,40}|stf_[0-9A-Za-z]{16,40})$/;

/** A `refunds` row as ConsolePaymentRefund (the stored `canceled` as `cancelled`). */
export function toConsolePaymentRefund(row: ConsoleRefundRow, minorUnits: number): ConsolePaymentRefund {
  const requester = (
    ["customer", "staff", "system"].includes(row.requestedByType) ? row.requestedByType : "system"
  ) as ConsolePaymentRefund["requestedBy"]["type"];
  return {
    id: row.id,
    paymentId: row.paymentId,
    bookingId: row.bookingId,
    amount: money(row.amount, row.currency, minorUnits),
    penalty: row.penaltyAmount === null ? null : money(row.penaltyAmount, row.currency, minorUnits),
    reason: row.reason as ConsolePaymentRefund["reason"],
    status: apiSpelling(row.status) as ConsolePaymentRefund["status"],
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
    reasonNote: row.reasonNote,
    requestedBy: {
      type: requester,
      id: row.requestedById !== null && REQUESTER_ID.test(row.requestedById) ? row.requestedById : null,
    },
    providerRefundId: row.providerRefundId,
    failureReason: row.failureReason,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Everything a ConsolePayment is built from. */
export interface ConsolePaymentParts {
  readonly row: PaymentRow;
  readonly minorUnits: number;
  readonly events: readonly ConsolePaymentEventRow[];
  readonly refunds: readonly ConsoleRefundRow[];
  readonly booking: PaymentBookingSummaryRow | undefined;
  /** The account mode of the payment's connection; `undefined` without one (or one the platform no longer has). */
  readonly accountMode: PaymentAccountMode | undefined;
}

/** A payment in console scope (see the file header): never a client secret or a publishable key. */
export function toConsolePayment(parts: ConsolePaymentParts): ConsolePayment {
  const { row, minorUnits } = parts;
  return {
    ...toPayment(row, { minorUnits, clientSecret: null, publishableKey: null }),
    environment: row.environment === "live" ? "live" : "test",
    version: row.version,
    events: parts.events.map((event) => toConsolePaymentEvent(event, row, minorUnits)),
    refunds: parts.refunds.map((refund) => toConsolePaymentRefund(refund, minorUnits)),
    booking:
      parts.booking === undefined
        ? null
        : {
            id: parts.booking.id,
            reference: parts.booking.reference,
            status: parts.booking.status as Schemas["BookingStatus"],
          },
    providerConnection: parts.accountMode === undefined ? null : { accountMode: parts.accountMode },
  };
}

/** The payment and what its capture needs, read in T1. */
interface CapturePlan {
  readonly row: PaymentRow;
  readonly providerPaymentId: string;
  readonly minorUnits: number;
  /** The amount to capture, with the currency's minor units: the key of `pi:capture:<pay_id>:<amount>`. */
  readonly amount: string;
}

@Injectable()
export class ConsolePaymentsService {
  constructor(
    private readonly tx: TenantTx,
    private readonly payments: PaymentsRepository,
    private readonly refunds: RefundsRepository,
    private readonly platform: PlatformReadRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @InjectQueue(OTA_QUEUE.payments) private readonly paymentsQueue: Queue,
    private readonly audit: StaffActionsWriter,
    private readonly tenants: TenantContext,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    @InjectPinoLogger(ConsolePaymentsService.name) private readonly logger: PinoLogger,
  ) {}

  // ---- console.payments.list ---------------------------------------------------------------------------------------

  /** One page of the OTA's payments in the request's environment (see the file header). */
  async list(query: ConsoleListPaymentsQuery): Promise<ConsolePaymentPage> {
    const tenant = this.tenants.require();
    const limit = query.limit ?? DEFAULT_CONSOLE_PAGE_LIMIT;
    const fingerprint = consolePaymentsFingerprint(tenant.environment, query);
    const after = query.cursor === undefined ? undefined : decodePaymentCursor(query.cursor, fingerprint);
    const read = await this.tx.run(async (trx) => {
      const rows = await this.payments.consolePayments(trx, {
        environment: tenant.environment,
        statuses: storedStatusesOf(query.status),
        providers: query.provider,
        methods: query.method,
        bookingId: query.bookingId,
        createdFrom: query.createdFrom === undefined ? undefined : new Date(query.createdFrom),
        createdTo: query.createdTo === undefined ? undefined : new Date(query.createdTo),
        after,
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      return { more: rows.length > limit, page, parts: await this.partsOf(trx, page) };
    });
    const modes = await this.accountModes(tenant, read.page);
    const last = read.page.at(-1);
    return {
      data: read.parts.map((parts) =>
        toConsolePayment({ ...parts, accountMode: this.modeOf(parts.row, modes) }),
      ),
      page: {
        nextCursor:
          read.more && last !== undefined ? encodePaymentCursor(fingerprint, last.sortKey, last.id) : null,
        limit,
      },
    };
  }

  // ---- console.payments.get ----------------------------------------------------------------------------------------

  /** One payment of the request's environment, after a refresh from Stripe when asked (see the file header). */
  async get(paymentId: string, options: { readonly refresh: boolean }): Promise<ConsolePayment> {
    const tenant = this.tenants.require();
    const found = await this.tx.run(async (trx) => {
      const row = await this.paymentOfEnvironment(trx, tenant, paymentId);
      return { row, minorUnits: await this.minorUnitsOf(trx, row.currency) };
    });
    const { row } = found;
    if (options.refresh && row.provider === "stripe" && row.providerPaymentId !== null) {
      let state: GatewayState;
      try {
        state = await this.gateway.refresh(
          this.context(tenant, row),
          this.gatewayPayment(row, found.minorUnits),
        );
      } catch (error) {
        if (!isGatewayFailure(error)) {
          throw error;
        }
        this.logger.warn({ paymentId, code: (error as AppError).code }, "console.payments.refresh_failed");
        throw providerError(error);
      }
      await this.tx.run((trx) => this.applyState(trx, paymentId, state, { refresh: true }));
    }
    return await this.read(tenant, paymentId);
  }

  // ---- console.payments.capture ------------------------------------------------------------------------------------

  /** Captures an authorised Stripe payment (see the file header). */
  async capture(paymentId: string, ifMatch: string, body: ConsoleCaptureRequest): Promise<ConsolePayment> {
    const tenant = this.tenants.require();
    const plan = await this.tx.run((trx) => this.planCapture(trx, tenant, paymentId, ifMatch, body));
    await this.captureAndRecord(tenant, plan, body.reason);
    return await this.read(tenant, paymentId);
  }

  /**
   * The capture of console.bookings.issue (OBE-063: an authorised Stripe payment is captured before the order is
   * issued): the whole authorisation of payment `paymentId` of the request's environment, as `capture` without an
   * amount (`pi:capture:<pay_id>:<amount>`, the same checks, failures and record, its `payment.capture` staff action
   * with `reason`), without the payment's `If-Match` (the issuance's is the booking's).
   */
  async captureForIssue(paymentId: string, reason: string): Promise<void> {
    const tenant = this.tenants.require();
    const plan = await this.tx.run(async (trx) => {
      const row = await this.paymentOfEnvironment(trx, tenant, paymentId);
      return await this.planCapture(trx, tenant, paymentId, paymentEtagOf(row.version), { reason });
    });
    await this.captureAndRecord(tenant, plan, reason);
  }

  /** The capture of a planned payment with no transaction open, then its record (T2; see the file header). */
  private async captureAndRecord(tenant: RequestTenant, plan: CapturePlan, reason: string): Promise<void> {
    const ctx = this.context(tenant, plan.row);
    let state: GatewayState;
    try {
      state = await this.gateway.capture(ctx, this.gatewayPayment(plan.row, plan.minorUnits), plan.amount);
    } catch (error) {
      state = await this.afterCaptureFailure(ctx, plan, error);
    }
    await this.tx.run((trx) => this.recordCapture(trx, tenant, plan, state, reason));
  }

  /** T1 of a capture: the checks of the file header, and the amount. */
  private async planCapture(
    trx: TenantTransaction,
    tenant: RequestTenant,
    paymentId: string,
    ifMatch: string,
    body: ConsoleCaptureRequest,
  ): Promise<CapturePlan> {
    const row = await this.paymentOfEnvironment(trx, tenant, paymentId);
    if (!ifMatchSatisfied(ifMatch, row.version)) {
      throw new AppError("PRECONDITION_FAILED", { details: { currentVersion: row.version } });
    }
    if (!isCapturable(row) || row.providerPaymentId === null) {
      throw paymentConflict("payment_not_capturable", row);
    }
    const minorUnits = await this.minorUnitsOf(trx, row.currency);
    const ceiling = authorizedCeilingOf(row);
    const amount =
      body.amount === undefined
        ? new Money(ceiling).toFixed(minorUnits)
        : requestedAmountOf(body.amount, row, minorUnits);
    if (new Money(amount).greaterThan(ceiling)) {
      throw new AppError("UNPROCESSABLE", {
        message: "The capture is above the authorised amount.",
        details: {
          reason: "amount_exceeds_authorized",
          authorized: money(ceiling, row.currency, minorUnits),
        },
      });
    }
    return { row, providerPaymentId: row.providerPaymentId, minorUnits, amount };
  }

  /**
   * After a failed capture call: the PaymentIntent read again decides (`captureFailureOutcome`). Answers the state to
   * record for `captured`; otherwise applies what Stripe holds and throws the answer.
   */
  private async afterCaptureFailure(
    ctx: GatewayContext,
    plan: CapturePlan,
    error: unknown,
  ): Promise<GatewayState> {
    if (!isGatewayFailure(error)) {
      throw error;
    }
    const paymentId = plan.row.id;
    this.logger.warn({ paymentId, code: (error as AppError).code }, "console.payments.capture_failed");
    if (error instanceof AppError && error.cause instanceof StripeMetadataMismatchError) {
      // The gateway logged the security event: the PaymentIntent is not this payment's, nothing is applied.
      throw providerError(error);
    }
    let state: GatewayState | undefined;
    try {
      state = await this.gateway.refresh(ctx, this.gatewayPayment(plan.row, plan.minorUnits));
    } catch (refreshError) {
      if (!isGatewayFailure(refreshError)) {
        throw refreshError;
      }
      state = undefined;
    }
    const outcome = captureFailureOutcome(state, plan.amount);
    if (outcome === "captured" && state !== undefined) {
      return state;
    }
    if (state !== undefined && outcome !== "provider_error") {
      const read = state;
      await this.tx.run((trx) => this.applyState(trx, paymentId, read, { afterCaptureFailure: true }));
    }
    if (outcome === "declined") {
      throw new AppError("PAYMENT_DECLINED", {
        message: "The authorisation expired or was cancelled at Stripe; nothing was captured.",
        cause: error,
      });
    }
    if (outcome === "conflict") {
      throw paymentConflict("payment_not_capturable", { provider: "stripe", status: "captured" });
    }
    throw providerError(error);
  }

  /**
   * T2 of a capture: the booking (`FOR UPDATE`), then the payment; the state, the payment event, the booking's
   * amount paid and event, and the staff action (see the file header).
   */
  private async recordCapture(
    trx: TenantTransaction,
    tenant: RequestTenant,
    plan: CapturePlan,
    state: GatewayState,
    reason: string,
  ): Promise<void> {
    const now = this.clock.now();
    const bookingId = plan.row.bookingId;
    const [booking] = bookingId === null ? [] : await this.payments.lockBookings(trx, [bookingId], "update");
    const current = await this.payments.payment(trx, plan.row.id, true);
    if (current === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const update = providerStateUpdate(current, state, now);
    if (update.kind === "refused" || state.status !== "captured") {
      throw paymentConflict("payment_not_capturable", current);
    }
    const captured = Money.min(new Money(state.amountReceived), new Money(current.amount)).toFixed(2);
    if (update.kind === "apply") {
      if (!(await this.payments.updatePayment(trx, current.id, current.version, update.values))) {
        throw new Error("the payment changed while its locked row was updated");
      }
      await this.payments.insertEvent(trx, {
        id: this.ids.newId("pev"),
        payment_id: current.id,
        type: "payment.captured",
        source: "staff",
        status_from: current.status,
        status_to: "captured",
        amount: captured,
        currency: current.currency,
        payload: JSON.stringify({ providerPaymentId: plan.providerPaymentId }),
        created_at: now,
        updated_at: now,
      });
    }
    if (booking !== undefined && new Money(captured).greaterThan(booking.amountPaid)) {
      await this.payments.setAmountPaid(trx, booking.id, captured, now);
      await this.payments.insertBookingEvent(trx, {
        id: this.ids.newId("evt"),
        booking_id: booking.id,
        type: "payment.captured",
        actor_type: eventActorOf(tenant.actor).type,
        actor_id: eventActorOf(tenant.actor).id,
        summary: "Payment received.",
        data: JSON.stringify({ paymentId: current.id, amount: captured }),
        visible_to_customer: true,
        request_id: this.requestId(tenant),
        created_at: now,
        updated_at: now,
      });
    }
    await this.audit.record(trx, {
      action: CONSOLE_PAYMENT_ACTIONS.capture,
      targetType: "payment",
      targetId: current.id,
      bookingId: booking?.id ?? null,
      reason,
      before: {
        status: apiStatusOf(current.status),
        amountAuthorized: current.amountAuthorized,
        amountCaptured: current.amountCaptured,
        version: current.version,
      },
      after: {
        status: "captured",
        amountCaptured: captured,
        version: update.kind === "apply" ? current.version + 1 : current.version,
      },
    });
  }

  // ---- console.payments.refund -------------------------------------------------------------------------------------

  /** Asks for a refund of a captured Stripe payment (see the file header); `201` with the `pending` refund. */
  async refund(paymentId: string, body: ConsoleRefundRequest): Promise<ConsolePayment> {
    const tenant = this.tenants.require();
    const refundId = this.ids.newId("rfd");
    const parts = await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const row = await this.paymentOfEnvironment(trx, tenant, paymentId);
      if (row.provider === AIRLINE_PROVIDER) {
        throw refundRefusal("refund_via_airline", row, null);
      }
      if (
        row.provider !== "stripe" ||
        row.providerPaymentId === null ||
        !REFUNDABLE_PAYMENT_STATUSES.includes(row.status)
      ) {
        throw paymentConflict("payment_not_refundable", row);
      }
      const minorUnits = await this.minorUnitsOf(trx, row.currency);
      const amount = requestedAmountOf(body.amount, row, minorUnits);
      const actor = tenant.actor;
      const created = await this.refunds.create(trx, {
        id: refundId,
        paymentId: row.id,
        amount,
        reason: body.reason,
        reasonNote: body.reasonNote ?? null,
        // A key-only call has no staff member: its staff action names the key.
        requestedBy: { type: "staff", id: actor.type === "staff" ? actor.id : null },
        now,
      });
      if (!created.ok) {
        throw refundRefusal(
          created.reason,
          row,
          created.refundable === null ? null : money(created.refundable, row.currency, minorUnits),
        );
      }
      const refund = created.refund;
      if (refund.bookingId !== null) {
        // The booking's FOR KEY SHARE lock was taken by create(), before the payment's.
        await this.payments.insertRefundBookingEvent(trx, {
          id: this.ids.newId("evt"),
          kind: "requested",
          bookingId: refund.bookingId,
          refundId: refund.id,
          paymentId: row.id,
          amount: refund.amount,
          currency: refund.currency,
          actor: eventActorOf(actor),
          requestId: this.requestId(tenant),
          now,
        });
      }
      await this.audit.record(trx, {
        action: CONSOLE_PAYMENT_ACTIONS.refund,
        targetType: "payment",
        targetId: row.id,
        bookingId: refund.bookingId,
        reason: body.reasonNote ?? body.reason,
        before: {
          status: apiStatusOf(row.status),
          amountCaptured: row.amountCaptured,
          amountRefunded: row.amountRefunded,
        },
        after: {
          refundId: refund.id,
          amount: refund.amount,
          currency: refund.currency,
          reason: body.reason,
          status: refund.status,
        },
      });
      afterCommit(trx, () => this.enqueueRefund(tenant, refund.id));
      // The answer is read here, before the commit queues refund.submit: the payment with its new `pending` refund,
      // whatever the payments queue has done with the refund by the time the answer is sent.
      return await this.partsOfPayment(trx, tenant, paymentId);
    });
    return await this.answerOf(tenant, parts);
  }

  /** Queues `refund.submit` for the refund (its deterministic job id); never throws (see the file header). */
  private async enqueueRefund(tenant: RequestTenant, refundId: string): Promise<void> {
    const job = paymentJob(PAYMENT_JOB.refundSubmit, tenant.tenantId, refundId);
    let timer: NodeJS.Timeout | undefined;
    const added = this.paymentsQueue.add(job.name, job.data, job.opts).then(
      () => true,
      (error: unknown) => {
        this.logger.warn({ refundId, err: error }, "console.payments.refund_enqueue_failed");
        return false;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), REFUND_ENQUEUE_TIMEOUT_MS);
    });
    try {
      if ((await Promise.race([added, timedOut])) === "timeout") {
        this.logger.warn({ refundId }, "console.payments.refund_enqueue_timeout");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Shared --------------------------------------------------------------------------------------------------------

  /** The payment `paymentId` of the request's environment; `404 NOT_FOUND` for another environment's or an unknown id. */
  private async paymentOfEnvironment(
    trx: TenantTransaction,
    tenant: RequestTenant,
    paymentId: string,
  ): Promise<PaymentRow> {
    const row = await this.payments.payment(trx, paymentId);
    if (row === undefined || row.environment !== tenant.environment) {
      throw new AppError("NOT_FOUND");
    }
    return row;
  }

  /**
   * Applies a PaymentIntent state read from Stripe under the payment's lock and `version` (payment-state.ts), with a
   * `payment_events` row (`source = staff`), as the webhook processor does; a state the row may not take changes nothing.
   */
  private async applyState(
    trx: TenantTransaction,
    paymentId: string,
    state: GatewayState,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const now = this.clock.now();
    const current = await this.payments.payment(trx, paymentId, true);
    if (current === undefined) {
      return;
    }
    const update = providerStateUpdate(current, state, now);
    if (update.kind !== "apply") {
      return;
    }
    if (!(await this.payments.updatePayment(trx, current.id, current.version, update.values))) {
      throw new Error("the payment changed while its locked row was updated");
    }
    const amount =
      update.status === "authorized"
        ? update.values["amount_authorized"]
        : update.status === "captured"
          ? update.values["amount_captured"]
          : undefined;
    await this.payments.insertEvent(trx, {
      id: this.ids.newId("pev"),
      payment_id: current.id,
      type: `payment.${update.status}`,
      source: "staff",
      status_from: current.status,
      status_to: update.status,
      amount: typeof amount === "string" ? amount : null,
      currency: typeof amount === "string" ? current.currency : null,
      payload: JSON.stringify(
        redactPayload({
          ...payload,
          cardBrand: state.card?.brand ?? null,
          cardLast4: state.card?.last4 ?? null,
          failureCode: state.failure?.code ?? null,
          declineCode: state.failure?.declineCode ?? null,
        }),
      ),
      created_at: now,
      updated_at: now,
    });
  }

  /** The console view of payment `paymentId` as it is now (no lock). */
  private async read(tenant: RequestTenant, paymentId: string): Promise<ConsolePayment> {
    const parts = await this.tx.run((trx) => this.partsOfPayment(trx, tenant, paymentId));
    return await this.answerOf(tenant, parts);
  }

  /** The events, refunds, booking and minor units of payment `paymentId` of the request's environment, read in `trx`. */
  private async partsOfPayment(
    trx: TenantTransaction,
    tenant: RequestTenant,
    paymentId: string,
  ): Promise<Omit<ConsolePaymentParts, "accountMode">> {
    const row = await this.paymentOfEnvironment(trx, tenant, paymentId);
    const [first] = await this.partsOf(trx, [row]);
    if (first === undefined) {
      throw new Error("the payment read in this transaction has no parts");
    }
    return first;
  }

  /** The ConsolePayment of `parts`, with its connection's account mode (a platform read, after the transaction). */
  private async answerOf(
    tenant: RequestTenant,
    parts: Omit<ConsolePaymentParts, "accountMode">,
  ): Promise<ConsolePayment> {
    const modes = await this.accountModes(tenant, [parts.row]);
    return toConsolePayment({ ...parts, accountMode: this.modeOf(parts.row, modes) });
  }

  /** The events, refunds, booking and minor units of each payment of `rows`, in `rows`' order. */
  private async partsOf(
    trx: TenantTransaction,
    rows: readonly PaymentRow[],
  ): Promise<Omit<ConsolePaymentParts, "accountMode">[]> {
    const ids = rows.map((row) => row.id);
    const events = await this.payments.consoleEvents(trx, ids);
    const refunds = await this.payments.consoleRefunds(trx, ids);
    const bookings = await this.payments.bookingSummaries(
      trx,
      rows.flatMap((row) => (row.bookingId === null ? [] : [row.bookingId])),
    );
    const units = new Map<string, number>();
    for (const currency of new Set(rows.map((row) => row.currency))) {
      units.set(currency, await this.minorUnitsOf(trx, currency));
    }
    return rows.map((row) => ({
      row,
      minorUnits: units.get(row.currency) ?? 2,
      events: events.filter((event) => event.paymentId === row.id),
      refunds: refunds.filter((refund) => refund.paymentId === row.id),
      booking: row.bookingId === null ? undefined : bookings.get(row.bookingId),
    }));
  }

  /** The account modes of the payments' connections (one platform read, outside any tenant transaction). */
  private async accountModes(
    tenant: RequestTenant,
    rows: readonly PaymentRow[],
  ): Promise<ReadonlyMap<string, PaymentAccountMode>> {
    const ids = rows.flatMap((row) => (row.providerConnectionId === null ? [] : [row.providerConnectionId]));
    return ids.length === 0 ? new Map() : await this.platform.paymentConnectionModes(tenant.tenantId, ids);
  }

  /** The account mode of a payment's connection; none for an airline-card payment or a connection not found. */
  private modeOf(
    row: PaymentRow,
    modes: ReadonlyMap<string, PaymentAccountMode>,
  ): PaymentAccountMode | undefined {
    return row.provider === AIRLINE_PROVIDER || row.providerConnectionId === null
      ? undefined
      : modes.get(row.providerConnectionId);
  }

  private async minorUnitsOf(trx: TenantTransaction, currency: string): Promise<number> {
    return (await this.payments.currencyMinorUnits(trx, currency)) ?? 2;
  }

  /** The gateway context of a console call: the tenant, the payment's environment and the request id. */
  private context(tenant: RequestTenant, row: Pick<PaymentRow, "environment">): GatewayContext {
    return {
      tenantId: tenant.tenantId,
      environment: row.environment === "live" ? "live" : "test",
      requestId: this.requestId(tenant),
    };
  }

  private gatewayPayment(row: PaymentRow, minorUnits: number): GatewayPayment {
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

  private requestId(tenant: RequestTenant): string {
    return this.tenants.requestId() ?? tenant.requestId;
  }
}

/** The answer of a refund that RefundsRepository.create (or the checks before it) refused. */
export function refundRefusal(
  reason: Extract<CreateRefundResult, { ok: false }>["reason"],
  payment: Pick<PaymentRow, "provider" | "status">,
  refundable: MoneyAmount | null,
): AppError {
  switch (reason) {
    case "payment_not_found":
      return new AppError("NOT_FOUND");
    case "refund_via_airline":
      return new AppError("UNPROCESSABLE", {
        message:
          "The airline charged this card; it is refunded by the airline when the booking is cancelled.",
        details: { reason: "refund_via_airline" },
      });
    case "payment_not_refundable":
      return paymentConflict("payment_not_refundable", payment);
    case "amount_invalid":
      return new AppError("VALIDATION_FAILED", {
        fieldErrors: [{ path: "/amount/amount", code: "amount", message: "must be a positive amount" }],
      });
    case "amount_exceeds_captured":
      return new AppError("UNPROCESSABLE", {
        message: "The refund is above what can still be refunded.",
        details: { reason: "amount_exceeds_captured", ...(refundable === null ? {} : { refundable }) },
      });
  }
}
