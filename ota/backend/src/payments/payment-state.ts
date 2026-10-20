// The payment and refund states that Stripe's word may set (OBE-039; OADR-0010 point 5, db README §2.1). The webhook
// processor (stripe-events.processor.ts) never trusts an event body: it reads the PaymentIntent, charge or refund again
// from Stripe and asks this file what that state changes on the row. The rules are pure, so they are tested on their
// own (payment-state.test.ts):
//
//   - a payment that is not confirmed yet (`requires_payment_method`, `requires_action`, `processing`) takes any state
//     Stripe reports, a decline that sends it back to `requires_payment_method` included;
//   - `authorized` moves on to `captured` or `canceled` only (or stays `authorized` with new details);
//   - `captured`, `partially_refunded` and `refunded` never move back on a PaymentIntent's state (it stays `succeeded`
//     after refunds): their refunded amount and status come from the charge (`refundedState`);
//   - `canceled` and `failed` are final.
//
// The order matters because two events can be processed out of order: the state read for the older one may be applied
// after the state read for the newer one, and must not undo it (an `authorized` snapshot after a capture). Every change
// is applied with the row's `version` (PaymentsRepository.updatePayment), under the row lock of its transaction.
//
// Refund rows follow their own machine (tenant.sql: pending -> processing -> succeeded | failed; pending -> canceled):
// Stripe's `pending` and `requires_action` are `processing` here (submitted, not final), `succeeded`, `failed` and
// `canceled` are final; a `succeeded` refund can still fail later (Stripe reports it with charge.refund.updated).
import { Money } from "../pricing/pricing.types";
import type { GatewayPaymentStatus, GatewayState } from "./payment-gateway";
import type { PaymentRow, RefundRow } from "./payments.repository";
import { nextActionOf, stateValues } from "./payments.service";

/** The statuses of a payment that is not confirmed yet. */
const UNCONFIRMED: readonly string[] = ["requires_payment_method", "requires_action", "processing"];

/** Every PaymentIntent state a payment may take from each status (see the file header). */
const PROVIDER_TRANSITIONS: Readonly<Record<string, readonly GatewayPaymentStatus[]>> = Object.freeze({
  requires_payment_method: [
    "requires_payment_method",
    "requires_action",
    "processing",
    "authorized",
    "captured",
    "canceled",
  ],
  requires_action: [
    "requires_payment_method",
    "requires_action",
    "processing",
    "authorized",
    "captured",
    "canceled",
  ],
  processing: [
    "requires_payment_method",
    "requires_action",
    "processing",
    "authorized",
    "captured",
    "canceled",
  ],
  authorized: ["authorized", "captured", "canceled"],
  captured: ["captured"],
  partially_refunded: [],
  refunded: [],
  canceled: [],
  failed: [],
});

/** Whether a payment in `from` may take the PaymentIntent state `to`. */
export function canApplyProviderStatus(from: string, to: GatewayPaymentStatus): boolean {
  return PROVIDER_TRANSITIONS[from]?.includes(to) ?? false;
}

/** What a PaymentIntent state read from Stripe does to a payment row. */
export type ProviderStateUpdate =
  | {
      readonly kind: "apply";
      readonly status: GatewayPaymentStatus;
      /** The columns to set (`PaymentsRepository.updatePayment`; it bumps the `version`). */
      readonly values: Record<string, unknown>;
    }
  /** The row already shows this state. */
  | { readonly kind: "unchanged" }
  /** The row's status may not take this state (an older snapshot, or a final payment). */
  | { readonly kind: "refused"; readonly from: string; readonly to: GatewayPaymentStatus };

const sameAmount = (a: unknown, b: string): boolean =>
  (typeof a === "string" || typeof a === "number") && new Money(a).equals(b);

/** The update of `row` for the PaymentIntent state `state` read from Stripe at `now`. */
export function providerStateUpdate(row: PaymentRow, state: GatewayState, now: Date): ProviderStateUpdate {
  if (row.providerPaymentId !== null && row.providerPaymentId !== state.providerPaymentId) {
    return { kind: "refused", from: row.status, to: state.status };
  }
  if (!canApplyProviderStatus(row.status, state.status)) {
    return state.status === row.status ||
      (state.status === "captured" && (row.status === "partially_refunded" || row.status === "refunded"))
      ? { kind: "unchanged" }
      : { kind: "refused", from: row.status, to: state.status };
  }
  const { status, values } = stateValues(row, state, now);
  if (row.providerPaymentId === null) {
    values["provider_payment_id"] = state.providerPaymentId;
  }
  const changed =
    status !== row.status ||
    row.providerPaymentId === null ||
    ("amount_authorized" in values && !sameAmount(values["amount_authorized"], row.amountAuthorized)) ||
    ("amount_captured" in values && !sameAmount(values["amount_captured"], row.amountCaptured)) ||
    (state.card?.last4 ?? row.cardLast4) !== row.cardLast4 ||
    (state.failure?.code ?? null) !== row.failureCode ||
    (state.failure?.declineCode ?? null) !== row.failureMessage;
  return changed ? { kind: "apply", status, values } : { kind: "unchanged" };
}

/** Whether the status is one of a payment that is not confirmed yet. */
export function isUnconfirmed(status: string): boolean {
  return UNCONFIRMED.includes(status);
}

// ---- Refunds ---------------------------------------------------------------------------------------------------

/** `refunds.status`. */
export type RefundStatus = "pending" | "processing" | "succeeded" | "failed" | "canceled";

/** A Stripe refund status as `refunds.status` (see the file header); an unknown or missing one is `processing`. */
export function refundStatusOf(providerStatus: string | null | undefined): RefundStatus {
  return providerStatus === "succeeded" || providerStatus === "failed" || providerStatus === "canceled"
    ? providerStatus
    : "processing";
}

/** Every refund status a refund may take from each status, on Stripe's word. */
const REFUND_TRANSITIONS: Readonly<Record<string, readonly RefundStatus[]>> = Object.freeze({
  pending: ["processing", "succeeded", "failed", "canceled"],
  processing: ["succeeded", "failed", "canceled"],
  succeeded: ["failed"],
  failed: [],
  canceled: [],
});

/** Whether a refund in `from` may take the status `to`. */
export function canMoveRefund(from: string, to: RefundStatus): boolean {
  return REFUND_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A refund as Stripe reports it, amounts in decimal strings. */
export interface ProviderRefund {
  readonly providerRefundId: string;
  readonly status: string | null;
  readonly amount: string;
  /** Stripe's `failure_reason` (`expired_or_canceled_card`, …), a code, never a message. */
  readonly failureReason: string | null;
  /** The `refund_id` of the refund's metadata, when Velexis created it (`refund:<rfd_id>`, OBE-040). */
  readonly refundId: string | null;
}

/** What a refund read from Stripe does to its row, or `undefined` when it changes nothing. */
export function refundUpdate(
  row: RefundRow,
  refund: ProviderRefund,
  now: Date,
): { readonly status: RefundStatus; readonly values: Record<string, unknown> } | undefined {
  const status = refundStatusOf(refund.status);
  const values: Record<string, unknown> = {};
  if (row.providerRefundId === null) {
    values["provider_refund_id"] = refund.providerRefundId;
  }
  if (status !== row.status && canMoveRefund(row.status, status)) {
    values["status"] = status;
    if (status === "succeeded" || status === "failed" || status === "canceled") {
      values["processed_at"] = row.processedAt ?? now;
    }
    if (status === "failed") {
      values["failure_reason"] = refund.failureReason;
    }
  }
  if (Object.keys(values).length === 0) {
    return undefined;
  }
  values["updated_at"] = now;
  return { status: (values["status"] as RefundStatus | undefined) ?? (row.status as RefundStatus), values };
}

/** The refund row a Stripe refund belongs to: by its Stripe id, else by the `refund_id` Velexis wrote in it. */
export function matchRefund(rows: readonly RefundRow[], refund: ProviderRefund): RefundRow | undefined {
  return (
    rows.find((row) => row.providerRefundId === refund.providerRefundId) ??
    rows.find((row) => row.providerRefundId === null && row.id === refund.refundId)
  );
}

// ---- Refunded amounts of a payment -----------------------------------------------------------------------------

/** The statuses of a payment whose charge can be refunded. */
const REFUNDABLE: readonly string[] = ["authorized", "captured", "partially_refunded", "refunded"];

/** The payment status of a captured payment with `refunded` of `captured` refunded. */
export function refundedStatusOf(
  captured: string,
  refunded: string,
): "captured" | "partially_refunded" | "refunded" {
  const refundedAmount = new Money(refunded);
  if (refundedAmount.isZero()) {
    return "captured";
  }
  return refundedAmount.greaterThanOrEqualTo(captured) ? "refunded" : "partially_refunded";
}

/**
 * The update of a payment for its charge as Stripe reports it (`amountCaptured`, `amountRefunded`, decimal strings), or
 * `undefined` when nothing changes or the payment cannot have refunds (not captured, cancelled or failed). The captured
 * amount only grows (a refund proves the capture, also when its webhook was not processed yet), both stay within the
 * payment's amount, and the refunded amount within the captured one (`payments_amounts_ck`).
 */
export function refundedState(
  row: PaymentRow,
  charge: { readonly amountCaptured: string; readonly amountRefunded: string },
  now: Date,
): { readonly status: string; readonly values: Record<string, unknown> } | undefined {
  if (!REFUNDABLE.includes(row.status)) {
    return undefined;
  }
  const amount = new Money(row.amount);
  const captured = Money.min(
    Money.max(new Money(row.amountCaptured), new Money(charge.amountCaptured)),
    amount,
  );
  const refunded = Money.min(new Money(charge.amountRefunded), captured);
  if (captured.isZero()) {
    return undefined;
  }
  const status = refundedStatusOf(captured.toFixed(2), refunded.toFixed(2));
  if (status === row.status && captured.equals(row.amountCaptured) && refunded.equals(row.amountRefunded)) {
    return undefined;
  }
  const values: Record<string, unknown> = {
    status,
    amount_captured: captured.toFixed(2),
    amount_refunded: refunded.toFixed(2),
    amount_authorized: Money.max(new Money(row.amountAuthorized), captured).toFixed(2),
    authorized_at: row.authorizedAt ?? now,
    captured_at: row.capturedAt ?? now,
    next_action: JSON.stringify(nextActionOf(status)),
    updated_at: now,
  };
  return { status, values };
}
