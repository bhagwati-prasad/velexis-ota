"use client";

// "Issue tickets" on a booking's page (OAD-008, routes.md §3.2 "Actions" and "State", OADR-0008, OADR-0018 point 8): the
// confirmation dialog of `console.bookings.issue` (`issueTickets`), with `ifMatch` = the version the page displayed, the
// idempotency key the page rendered with it (a double click or a retry issues once), a required reason, the
// environment badge and, in live mode, the live warning.
//
// - What the issuance takes is said before anything is sent (`IssuePlan` of action-rules.ts): the authorised payment that
//   is captured first, a booking already paid, a booking without payment, or one that is not paid, which only an owner
//   or an admin may issue anyway (`allowUnpaid`, the checkbox is shown to them only).
// - An airline-card booking (its tickets did not all come back): the airline card cannot be charged again, so the
//   dialog offers only the OTA's own settlement with the airline, `CASH` or `ACCOUNT`, as an `other` form of payment
//   for the booking's flight offers. There is no card input here or anywhere in the admin; the other way out is Cancel.
//   When the airline did not charge the card, the API counts the booking as unpaid (console-operations.md §2 step 8):
//   the dialog says so and offers `allowUnpaid` to an owner or an admin, as for any unpaid booking (OAD-016).
// - The trigger is highlighted when ticketing failed or waits in manual review.
import {
  ALLOW_UNPAID_FIELD,
  FLIGHT_OFFERS_FIELD,
  NOTIFY_FIELD,
  SETTLEMENT_FIELD,
  SETTLEMENT_METHODS,
  VERSION_FIELD,
  BOOKING_ID_FIELD,
  type IssuePlan,
} from "@/app/(console)/bookings/[bookingId]/action-rules";
import { issueTickets } from "@/app/(console)/bookings/[bookingId]/actions";
import { CheckboxField, RadioField } from "@/app/(console)/bookings/[bookingId]/patch-form";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import type { StaffEnvironment } from "@/lib/permissions";

export const ISSUE_STRINGS = Object.freeze({
  trigger: "Issue tickets",
  title: (reference: string) => `Issue the tickets of ${reference}?`,
  confirm: "Issue tickets",
  amadeus: "Amadeus issues the tickets (Flight Order Issue); the traveller gets the e-ticket receipts.",
  capture: "The authorised payment is captured first:",
  paid: "The booking is paid.",
  notApplicable: "The booking has no payment to take.",
  unpaid: "The payment is not captured.",
  unpaidAllowed: "Issue anyway only when the OTA takes the risk of the unpaid fare.",
  unpaidRefused: "Only an owner or an admin can issue it unpaid: capture the payment first.",
  airlineCard:
    "The airline card cannot be charged again. Issue with the OTA's own settlement with the airline, or cancel the booking. No card is ever entered in the console.",
  airlineUncharged: "The airline has not charged the card, so the booking is not paid.",
  airlineUnpaidRefused: "Only an owner or an admin can issue it unpaid; you can cancel it.",
  settlement: "Settlement with the airline",
  allowUnpaid: "Issue although the payment is not captured",
  allowUnpaidHint: "Owner and admin only.",
  notify: "E-mail the e-ticket receipts to the traveller",
  timeout: "If Amadeus does not answer, resync the booking before you try again.",
});

export interface IssueDialogProps {
  readonly bookingId: string;
  readonly reference: string;
  /** The booking `version` the page displayed (`ifMatch`). */
  readonly version: number;
  readonly environment: StaffEnvironment;
  /** The idempotency key rendered with the page. */
  readonly idempotencyKey: string;
  /** What issuing this booking takes (action-rules.ts `issuePlanOf`). */
  readonly plan: IssuePlan;
  /** The staff member may send `allowUnpaid` (owner and admin). */
  readonly canAllowUnpaid: boolean;
  /** Ticketing failed or waits in manual review: the trigger stands out. */
  readonly urgent?: boolean;
}

/** What the issuance does, before the inputs. */
function IssueSummary({ plan, canAllowUnpaid }: Pick<IssueDialogProps, "plan" | "canAllowUnpaid">) {
  switch (plan.kind) {
    case "airline_card":
      return (
        <>
          <p>{ISSUE_STRINGS.airlineCard}</p>
          {plan.charged ? null : (
            <p>
              {ISSUE_STRINGS.airlineUncharged}{" "}
              {canAllowUnpaid ? ISSUE_STRINGS.unpaidAllowed : ISSUE_STRINGS.airlineUnpaidRefused}
            </p>
          )}
        </>
      );
    case "capture":
      return (
        <p>
          {ISSUE_STRINGS.capture} <Money value={plan.amount} />. {ISSUE_STRINGS.amadeus}
        </p>
      );
    case "paid":
      return (
        <p>
          {ISSUE_STRINGS.paid} {ISSUE_STRINGS.amadeus}
        </p>
      );
    case "not_applicable":
      return (
        <p>
          {ISSUE_STRINGS.notApplicable} {ISSUE_STRINGS.amadeus}
        </p>
      );
    case "unpaid":
      return (
        <p>
          {ISSUE_STRINGS.unpaid} {canAllowUnpaid ? ISSUE_STRINGS.unpaidAllowed : ISSUE_STRINGS.unpaidRefused}
        </p>
      );
  }
}

/** The "Issue tickets" button and its confirmation dialog. */
export function IssueDialog({
  bookingId,
  reference,
  version,
  environment,
  idempotencyKey,
  plan,
  canAllowUnpaid,
  urgent = false,
}: IssueDialogProps) {
  const airline = plan.kind === "airline_card";
  // Not paid: a booking without a captured payment, or an airline card the airline did not charge.
  const unpaid = plan.kind === "unpaid" || (plan.kind === "airline_card" && !plan.charged);
  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button"
          variant={urgent ? "default" : "outline"}
          data-urgent={urgent ? "true" : undefined}
        >
          {ISSUE_STRINGS.trigger}
        </Button>
      }
      title={ISSUE_STRINGS.title(reference)}
      summary={
        <div className="grid gap-2">
          <IssueSummary plan={plan} canAllowUnpaid={canAllowUnpaid} />
          <p className="text-xs">{ISSUE_STRINGS.timeout}</p>
        </div>
      }
      confirmLabel={ISSUE_STRINGS.confirm}
      environment={environment}
      action={issueTickets}
      idempotencyKey={idempotencyKey}
      destructive={false}
      fields={{
        [BOOKING_ID_FIELD]: bookingId,
        [VERSION_FIELD]: String(version),
        ...(airline ? { [FLIGHT_OFFERS_FIELD]: plan.flightOfferIds.join(",") } : {}),
      }}
    >
      {(state) => (
        <>
          {airline ? (
            <RadioField
              name={SETTLEMENT_FIELD}
              label={ISSUE_STRINGS.settlement}
              state={state}
              choices={SETTLEMENT_METHODS}
            />
          ) : null}
          {unpaid && canAllowUnpaid ? (
            <CheckboxField
              name={ALLOW_UNPAID_FIELD}
              label={ISSUE_STRINGS.allowUnpaid}
              hint={ISSUE_STRINGS.allowUnpaidHint}
              state={state}
            />
          ) : null}
          <CheckboxField name={NOTIFY_FIELD} label={ISSUE_STRINGS.notify} state={state} defaultChecked />
        </>
      )}
    </ConfirmDialog>
  );
}
