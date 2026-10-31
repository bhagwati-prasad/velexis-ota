"use client";

// "Cancel the booking" on a booking's page (OAD-008, routes.md §3.2 "Actions", OBE-063, FIX-W28-CANCEL): the
// confirmation dialog of `console.bookings.cancel` (`cancelBooking`), with `ifMatch` = the version the page displayed,
// the idempotency key the page rendered with it (a double click or a retry cancels and refunds once), the reason code and
// the required reason, the environment badge and, in live mode, the live warning.
//
// The dialog says what will happen before anything is sent (`CancelPlan` of action-rules.ts):
// - at Amadeus, as the API decides it (console.bookings.get's `cancellationMode`, by its own clock in the OTA's
//   storefront time zone; FIX-W35-OTA): the order is released (nothing ticketed), the tickets voided (all issued today,
//   in the OTA's time zone), or, for tickets of an earlier day, no DELETE: the API records a request to the airline and
//   the booking stays as it is, with no money moved (lead decision (2c) of 2026-10-30, third batch, FIX-W36-OTA);
//   without a mode in the answer no step is named;
// - to the money, per refund mode: a captured Stripe payment refunds nothing, everything still refundable or an amount;
//   an authorisation is released whole, released in part (the rest captured) or captured whole; an airline card and a
//   booking without payment are never refunded here (the airline refunds its card). A request to the airline
//   (`request_only`) offers no refund choice at all and posts `refund.mode = none`: the airline is asked first, and the
//   refund is made from the payment once it answers (lead decision (2b) of 2026-10-31, FIX-W37-OTA). When the API still
//   answers `refund_not_available` (the page showed a release or void, the API's refresh found a ticket of an earlier
//   day), the dialog shows that message and switches to the request's form, so a second confirmation sends the request.
import { useCallback, useState } from "react";

import {
  AMOUNT_FIELD,
  BOOKING_ID_FIELD,
  CANCEL_REASON_CODES,
  CURRENCY_FIELD,
  NOTIFY_FIELD,
  REASON_CODE_FIELD,
  REFUND_MODE_FIELD,
  REFUND_NOT_AVAILABLE_CODE,
  REQUEST_REFUND_MODES,
  VERSION_FIELD,
  type CancelMoney,
  type CancelPlan,
  type CancelSupplierStep,
  type Choice,
  type RefundMode,
} from "@/app/(console)/bookings/[bookingId]/action-rules";
import { cancelBooking } from "@/app/(console)/bookings/[bookingId]/actions";
import {
  CheckboxField,
  RadioField,
  SelectField,
  TextField,
} from "@/app/(console)/bookings/[bookingId]/patch-form";
import { ConfirmDialog, type ConfirmAction } from "@/components/confirm-dialog";
import { formatMoney, type MoneyValue } from "@/components/money";
import { Button } from "@/components/ui/button";
import type { StaffEnvironment } from "@/lib/permissions";

/** An amount as a sentence shows it. */
const moneyText = (value: MoneyValue): string => formatMoney(value) ?? `${value.amount} ${value.currency}`;

export const CANCEL_STRINGS = Object.freeze({
  trigger: "Cancel the booking",
  title: (reference: string) => `Cancel ${reference}?`,
  confirm: "Cancel the booking",
  supplier: {
    release: "Nothing is ticketed: Amadeus cancels the order and releases the seats.",
    void: "The tickets were issued today: Amadeus voids them while the void window is open (until midnight, the OTA's time).",
    request_only:
      "A ticket was issued before today (or at an unknown time): Amadeus is not asked to void the tickets. The booking records a request to the airline and stays as it is, and no money moves now: cancel it with the airline, resync the booking, then refund from the payment.",
  } satisfies Record<CancelSupplierStep, string>,
  /** The money of a request to the airline (`request_only`): no refund choice (FIX-W37-OTA). */
  requestMoney:
    "No refund now: the airline is asked first. Once it answers, refund the traveller from the payment (its Refund action).",
  reasonCode: "Reason category",
  money: "The money",
  amount: (currency: string) => `Amount (${currency})`,
  amountHint: "Digits with at most two decimals, like 120.50.",
  notify: "E-mail the cancellation to the traveller",
  timeout: "If Amadeus does not answer, resync the booking before you try again.",
});

/** The words of each refund mode for a payment, and what it does. */
function modeChoices(money: CancelMoney): { choices: Choice<RefundMode>[]; details: Record<string, string> } {
  switch (money.kind) {
    case "captured": {
      const refundable = moneyText(money.refundable);
      return {
        choices: [
          { value: "none", label: "Refund nothing" },
          { value: "full", label: `Refund everything still refundable (${refundable})` },
          { value: "amount", label: "Refund an amount" },
        ],
        details: {
          none: "The captured money stays with the OTA; a refund can still be made from the payment later.",
          full: `${refundable} is refunded to the traveller's card through Stripe.`,
          amount: "The amount is refunded through Stripe; the rest stays with the OTA.",
        },
      };
    }
    case "authorized": {
      const authorized = moneyText(money.authorized);
      return {
        choices: [
          { value: "full", label: `Release the whole authorisation (${authorized})` },
          { value: "amount", label: "Release an amount, capture the rest" },
          { value: "none", label: `Capture the whole authorisation (${authorized})` },
        ],
        details: {
          full: "The authorisation is voided: the traveller is not charged.",
          amount: `The amount is released; the rest of the ${authorized} authorised is captured.`,
          none: `${authorized} is captured: nothing goes back to the traveller.`,
        },
      };
    }
    case "airline":
      return {
        choices: [{ value: "none", label: "No refund from the console" }],
        details: {
          none: "The airline charged the traveller's card: a void reverses its charge, and any later refund is made by the airline.",
        },
      };
    case "none":
      return {
        choices: [{ value: "none", label: "Nothing to refund" }],
        details: { none: "The booking has no payment." },
      };
  }
}

export interface CancelDialogProps {
  readonly bookingId: string;
  readonly reference: string;
  /** The booking `version` the page displayed (`ifMatch`). */
  readonly version: number;
  readonly environment: StaffEnvironment;
  /** The idempotency key rendered with the page. */
  readonly idempotencyKey: string;
  /** What cancelling this booking does (action-rules.ts `cancelPlanOf`). */
  readonly plan: CancelPlan;
}

/** The "Cancel the booking" button and its confirmation dialog. */
export function CancelDialog({
  bookingId,
  reference,
  version,
  environment,
  idempotencyKey,
  plan,
}: CancelDialogProps) {
  // The API's `refund_not_available` after this page's step: its refresh found a request to the airline (FIX-W37-OTA).
  const [requestFound, setRequestFound] = useState(false);
  const requestOnly = plan.supplier === "request_only" || requestFound;
  const supplier = requestFound ? "request_only" : plan.supplier;
  const modes = requestOnly ? REQUEST_REFUND_MODES : plan.modes;
  const defaultMode = modes[0] ?? "none";
  const [mode, setMode] = useState<RefundMode>(defaultMode);
  const { choices, details } = modeChoices(plan.money);
  const offered = choices.filter((choice) => modes.includes(choice.value));
  const action = useCallback<ConfirmAction>(async (previous, form) => {
    const next = await cancelBooking(previous, form);
    if (next.code === REFUND_NOT_AVAILABLE_CODE) {
      setRequestFound(true);
      setMode("none");
    }
    return next;
  }, []);
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline" onClick={() => setMode(defaultMode)}>
          {CANCEL_STRINGS.trigger}
        </Button>
      }
      title={CANCEL_STRINGS.title(reference)}
      summary={
        <div className="grid gap-2">
          {supplier === null ? null : (
            <p data-supplier-step={supplier}>{CANCEL_STRINGS.supplier[supplier]}</p>
          )}
          {requestOnly ? (
            <p data-refund-mode="none">{CANCEL_STRINGS.requestMoney}</p>
          ) : (
            <p data-refund-mode={mode}>{details[mode]}</p>
          )}
          <p className="text-xs">{CANCEL_STRINGS.timeout}</p>
        </div>
      }
      confirmLabel={CANCEL_STRINGS.confirm}
      environment={environment}
      action={action}
      idempotencyKey={idempotencyKey}
      fields={{
        [BOOKING_ID_FIELD]: bookingId,
        [VERSION_FIELD]: String(version),
        [CURRENCY_FIELD]: plan.currency,
        // A request to the airline takes no refund: `none`, with no choice offered.
        ...(requestOnly ? { [REFUND_MODE_FIELD]: "none" } : {}),
      }}
    >
      {(state) => (
        <>
          <SelectField
            name={REASON_CODE_FIELD}
            label={CANCEL_STRINGS.reasonCode}
            state={state}
            choices={CANCEL_REASON_CODES}
          />
          {requestOnly ? null : (
            <RadioField
              name={REFUND_MODE_FIELD}
              label={CANCEL_STRINGS.money}
              state={state}
              choices={offered}
              value={mode}
              onChange={(value) => setMode(value as RefundMode)}
            />
          )}
          {!requestOnly && mode === "amount" ? (
            <TextField
              name={AMOUNT_FIELD}
              label={CANCEL_STRINGS.amount(plan.currency)}
              hint={CANCEL_STRINGS.amountHint}
              state={state}
              inputMode="decimal"
              maxLength={13}
            />
          ) : null}
          <CheckboxField name={NOTIFY_FIELD} label={CANCEL_STRINGS.notify} state={state} defaultChecked />
        </>
      )}
    </ConfirmDialog>
  );
}
