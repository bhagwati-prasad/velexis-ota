"use client";

// Capture and refund on a booking's Payments tab (OAD-008, routes.md §3.2 "Actions" and §7, flow console-operations.md
// §3 step 5): the confirmation dialogs of `console.payments.capture` (`capturePayment`) and `console.payments.refund`
// (`refundPayment`), each with the idempotency key the page rendered with it (Stripe captures once per key, the API
// asks for one refund per key), a required reason, the environment badge and, in live mode, the live warning.
//
// - Capture, for an `authorized` Stripe payment (`payments:capture`): `ifMatch` = the payment's version (from
//   `console.payments.get`), the whole authorisation or less (the rest is released). An authorisation that expired
//   answers "contact the traveller".
// - Refund, for a captured Stripe payment (`payments:refund`): an amount up to what is still refundable, a reason
//   category, and the dialog's reason as the refund's note. The API records it `pending`; Stripe completes it. An
//   airline-card payment has no refund dialog: the airline refunds its card (`refund_via_airline`).
import {
  AMOUNT_FIELD,
  BOOKING_ID_FIELD,
  CURRENCY_FIELD,
  PAYMENT_ID_FIELD,
  REFUND_REASON_FIELD,
  REFUND_REASONS,
  VERSION_FIELD,
} from "@/app/(console)/bookings/[bookingId]/action-rules";
import { capturePayment, refundPayment } from "@/app/(console)/bookings/[bookingId]/actions";
import { SelectField, TextField } from "@/app/(console)/bookings/[bookingId]/patch-form";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Money, type MoneyValue } from "@/components/money";
import { Button } from "@/components/ui/button";
import type { StaffEnvironment } from "@/lib/permissions";

export const PAYMENT_STRINGS = Object.freeze({
  capture: "Capture",
  captureTitle: (paymentId: string) => `Capture payment ${paymentId}?`,
  captureSummary: "Authorised and not captured yet:",
  captureDetail:
    "Leave the amount empty to capture the whole authorisation. A smaller amount releases the rest; nothing more can be captured afterwards.",
  captureAmount: (currency: string) => `Amount to capture (${currency})`,
  refund: "Refund",
  refundTitle: (paymentId: string) => `Refund payment ${paymentId}?`,
  refundSummary: "Still refundable:",
  refundDetail:
    "The refund is recorded at once and sent to Stripe by the payments queue; the traveller sees it as requested until Stripe confirms it.",
  refundAmount: (currency: string) => `Amount to refund (${currency})`,
  refundReason: "Reason category",
  amountHint: "Digits with at most two decimals, like 120.50.",
});

interface PaymentDialogBase {
  readonly paymentId: string;
  /** The booking whose page shows the payment (revalidated after a success). */
  readonly bookingId: string;
  readonly environment: StaffEnvironment;
  /** The idempotency key rendered with the page. */
  readonly idempotencyKey: string;
}

export interface CaptureDialogProps extends PaymentDialogBase {
  /** The payment's `version` from `console.payments.get` (`ifMatch`). */
  readonly version: number;
  /** What the authorisation holds (`amountAuthorized`). */
  readonly authorized: MoneyValue;
}

/** The "Capture" button of an authorised Stripe payment and its confirmation dialog. */
export function CaptureDialog({
  paymentId,
  bookingId,
  environment,
  idempotencyKey,
  version,
  authorized,
}: CaptureDialogProps) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline" size="sm">
          {PAYMENT_STRINGS.capture}
        </Button>
      }
      title={PAYMENT_STRINGS.captureTitle(paymentId)}
      summary={
        <div className="grid gap-2">
          <p>
            {PAYMENT_STRINGS.captureSummary} <Money value={authorized} />.
          </p>
          <p>{PAYMENT_STRINGS.captureDetail}</p>
        </div>
      }
      confirmLabel={PAYMENT_STRINGS.capture}
      environment={environment}
      action={capturePayment}
      idempotencyKey={idempotencyKey}
      destructive={false}
      fields={{
        [PAYMENT_ID_FIELD]: paymentId,
        [BOOKING_ID_FIELD]: bookingId,
        [VERSION_FIELD]: String(version),
        [CURRENCY_FIELD]: authorized.currency,
      }}
    >
      {(state) => (
        <TextField
          name={AMOUNT_FIELD}
          label={PAYMENT_STRINGS.captureAmount(authorized.currency)}
          hint={PAYMENT_STRINGS.amountHint}
          state={state}
          inputMode="decimal"
          placeholder={authorized.amount}
          maxLength={13}
        />
      )}
    </ConfirmDialog>
  );
}

export interface RefundDialogProps extends PaymentDialogBase {
  /** What is still refundable: captured less refunded (action-rules.ts `refundableOf`). */
  readonly refundable: MoneyValue;
}

/** The "Refund" button of a captured Stripe payment and its confirmation dialog. */
export function RefundDialog({
  paymentId,
  bookingId,
  environment,
  idempotencyKey,
  refundable,
}: RefundDialogProps) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline" size="sm">
          {PAYMENT_STRINGS.refund}
        </Button>
      }
      title={PAYMENT_STRINGS.refundTitle(paymentId)}
      summary={
        <div className="grid gap-2">
          <p>
            {PAYMENT_STRINGS.refundSummary} <Money value={refundable} />.
          </p>
          <p>{PAYMENT_STRINGS.refundDetail}</p>
        </div>
      }
      confirmLabel={PAYMENT_STRINGS.refund}
      environment={environment}
      action={refundPayment}
      idempotencyKey={idempotencyKey}
      fields={{
        [PAYMENT_ID_FIELD]: paymentId,
        [BOOKING_ID_FIELD]: bookingId,
        [CURRENCY_FIELD]: refundable.currency,
      }}
    >
      {(state) => (
        <>
          <TextField
            name={AMOUNT_FIELD}
            label={PAYMENT_STRINGS.refundAmount(refundable.currency)}
            hint={PAYMENT_STRINGS.amountHint}
            state={state}
            inputMode="decimal"
            maxLength={13}
          />
          <SelectField
            name={REFUND_REASON_FIELD}
            label={PAYMENT_STRINGS.refundReason}
            state={state}
            choices={REFUND_REASONS}
          />
        </>
      )}
    </ConfirmDialog>
  );
}
