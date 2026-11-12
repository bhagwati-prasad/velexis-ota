"use client";

// "Close the review" on a booking's page (OAD-022, routes.md §3.2 "Actions", OBE-099; runbook §4.3 of
// ota/docs/runbooks/supplier-timeout-and-reconciliation.md): the confirmation dialog of `console.bookings.closeReview`
// (`closeBookingReview`, `bookings:cancel`) for a booking the reconciliation handed to the staff (Reconciliation review:
// `pending`, `reconcile_outcome = manual_review`). The page renders it only when `consoleActions.canCloseReview` allows
// it and the staff member holds `bookings:cancel` (action-rules.ts `closeReviewOffered`).
//
// Two choices, each saying what follows before anything is sent (`ReviewClosurePlan`):
// - "Order found": the order's record locator, which the API reads in the booking's queuing office and accepts only with
//   the remark `VELEXIS {reference}` of this booking; the order is recorded, the booking confirmed, a Stripe
//   authorisation captured and the tickets issued as the ticketing policy says (an airline-card order: the payment
//   recorded as the airline charged it). The note is optional.
// - "Not booked": a required note of what was looked for; the booking fails, a Stripe authorisation is released and the
//   traveller told; an airline-card booking has nothing to release, and the agent asks the airline whether it charged
//   the card and contacts the traveller (the API sends that traveller no e-mail).
//
// The closure takes no `reason`: its note is the staff action's reason, up to 2,000 characters, so the dialog asks for
// the note instead of the confirmation dialog's 500-character reason (`askReason={false}`). The hidden fields are the
// booking, `version` (`ifMatch`, the booking's ETag) and the idempotency key the page rendered (a double click or a retry
// closes once). The API's refusals stay in the dialog: `not_in_review`, `remark_mismatch` and `ORDER_ALREADY_IMPORTED` at
// the record locator, a card number in the note at the note, a stale version's `412`. No input asks for a card.
import { useId, useState } from "react";

import {
  BOOKING_ID_FIELD,
  RECORD_LOCATOR_FIELD,
  RECORD_LOCATOR_MAX_LENGTH,
  REVIEW_NOTE_FIELD,
  REVIEW_NOTE_MAX_LENGTH,
  REVIEW_OUTCOME_FIELD,
  REVIEW_OUTCOMES,
  VERSION_FIELD,
  type ReviewClosurePlan,
  type ReviewMoney,
  type ReviewOutcome,
} from "@/app/(console)/bookings/[bookingId]/action-rules";
import { closeBookingReview } from "@/app/(console)/bookings/[bookingId]/actions";
import { RadioField, TextField } from "@/app/(console)/bookings/[bookingId]/patch-form";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { formatMoney, type MoneyValue } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fieldError, type ActionState } from "@/lib/action-state";
import type { StaffEnvironment } from "@/lib/permissions";

/** An amount as a sentence shows it. */
const moneyText = (value: MoneyValue): string => formatMoney(value) ?? `${value.amount} ${value.currency}`;

export const REVIEW_STRINGS = Object.freeze({
  trigger: "Close the review",
  title: (reference: string) => `Close the reconciliation review of ${reference}?`,
  confirm: "Close the review",
  summary: (reference: string) =>
    `Amadeus did not confirm this order and the reconciliation could not decide. Look in the queuing office for an order with the remark VELEXIS ${reference}, then say what you found. Amadeus is never asked to create the order again.`,
  outcome: "What you found",
  recordLocator: "Record locator",
  recordLocatorHint:
    "5 to 8 letters and digits, as Amadeus shows it (like L2P9XC). The API reads the order in the booking's office and accepts it only with this booking's remark.",
  note: "Note",
  noteRequired: "Note (required)",
  noteHint:
    "What you looked for and found. Kept as a staff-only note on the booking and with the staff action. Never write card details here.",
  noteCounter: (length: number, max: number) => `${length} / ${max}`,
  /** What follows "Order found", by the payment the review held. */
  found: {
    authorized: (amount: string) =>
      `The order is recorded and the booking confirmed; the traveller gets the confirmation. The authorised ${amount} is captured, then the tickets are issued as the ticketing policy says.`,
    airline:
      "The order is recorded and the booking confirmed; the traveller gets the confirmation. Paid by airline card: when every ticket came back, the airline charged the card and the payment is recorded as captured; otherwise ticketing waits for staff review.",
    captured:
      "The order is recorded and the booking confirmed; the traveller gets the confirmation. The payment is already captured.",
    none: "The order is recorded and the booking confirmed; the traveller gets the confirmation.",
  } satisfies Record<ReviewMoney["kind"], string | ((amount: string) => string)>,
  /** What follows "Not booked", by the payment the review held. */
  notBooked: {
    authorized: (amount: string) =>
      `The booking fails and the authorised ${amount} is released: the traveller is not charged and is told by e-mail that the booking was not confirmed.`,
    airline:
      "The booking fails. Paid by airline card: Velexis never charged the card and sends the traveller no e-mail, so ask the airline whether it charged the card, have any charge refunded and contact the traveller.",
    captured:
      "The booking fails and the traveller is told by e-mail. The captured payment is not refunded here: refund it from the payment.",
    none: "The booking fails and the traveller is told by e-mail that the booking was not confirmed.",
  } satisfies Record<ReviewMoney["kind"], string | ((amount: string) => string)>,
});

/** What follows `outcome` for the payment of `money`. */
export function reviewEffectOf(outcome: ReviewOutcome, money: ReviewMoney): string {
  const texts = outcome === "order_found" ? REVIEW_STRINGS.found : REVIEW_STRINGS.notBooked;
  return money.kind === "authorized" ? texts.authorized(moneyText(money.authorized)) : texts[money.kind];
}

export interface ReviewDialogProps {
  readonly bookingId: string;
  readonly reference: string;
  /** The booking `version` the page displayed (`ifMatch`). */
  readonly version: number;
  readonly environment: StaffEnvironment;
  /** The idempotency key rendered with the page. */
  readonly idempotencyKey: string;
  /** What closing this booking's review does to its money (action-rules.ts `reviewClosurePlanOf`). */
  readonly plan: ReviewClosurePlan;
}

/** The note of the closure: a text area with its label, hint, counter and error. */
function NoteField({ state, required }: { readonly state: ActionState; readonly required: boolean }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [text, setText] = useState("");
  const error = fieldError(state, REVIEW_NOTE_FIELD);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{required ? REVIEW_STRINGS.noteRequired : REVIEW_STRINGS.note}</Label>
      <p id={hintId} className="text-xs text-muted-foreground">
        {REVIEW_STRINGS.noteHint}
      </p>
      <Textarea
        id={id}
        name={REVIEW_NOTE_FIELD}
        value={text}
        rows={3}
        maxLength={REVIEW_NOTE_MAX_LENGTH}
        autoComplete="off"
        aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
        {...(required ? { "aria-required": true } : {})}
        {...(error === undefined ? {} : { "aria-invalid": true })}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <p className="text-xs text-muted-foreground tabular-nums" aria-hidden="true">
        {REVIEW_STRINGS.noteCounter([...text].length, REVIEW_NOTE_MAX_LENGTH)}
      </p>
      {error === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The "Close the review" button and its confirmation dialog. */
export function ReviewDialog({
  bookingId,
  reference,
  version,
  environment,
  idempotencyKey,
  plan,
}: ReviewDialogProps) {
  const [outcome, setOutcome] = useState<ReviewOutcome | undefined>(undefined);
  const details = Object.fromEntries(
    REVIEW_OUTCOMES.map((choice) => [choice.value, reviewEffectOf(choice.value, plan.money)]),
  );
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline" onClick={() => setOutcome(undefined)}>
          {REVIEW_STRINGS.trigger}
        </Button>
      }
      title={REVIEW_STRINGS.title(reference)}
      summary={<p>{REVIEW_STRINGS.summary(reference)}</p>}
      confirmLabel={REVIEW_STRINGS.confirm}
      environment={environment}
      action={closeBookingReview}
      idempotencyKey={idempotencyKey}
      // The closure's note is its reason (up to 2,000 characters): the note field below, not the dialog's reason.
      askReason={false}
      fields={{ [BOOKING_ID_FIELD]: bookingId, [VERSION_FIELD]: String(version) }}
    >
      {(state) => (
        <>
          <RadioField
            name={REVIEW_OUTCOME_FIELD}
            label={REVIEW_STRINGS.outcome}
            state={state}
            choices={REVIEW_OUTCOMES}
            value={outcome ?? ""}
            onChange={(value) => setOutcome(value as ReviewOutcome)}
            details={details}
          />
          {outcome === "order_found" ? (
            <TextField
              name={RECORD_LOCATOR_FIELD}
              label={REVIEW_STRINGS.recordLocator}
              hint={REVIEW_STRINGS.recordLocatorHint}
              state={state}
              maxLength={RECORD_LOCATOR_MAX_LENGTH}
            />
          ) : null}
          <NoteField state={state} required={outcome === "not_booked"} />
        </>
      )}
    </ConfirmDialog>
  );
}
