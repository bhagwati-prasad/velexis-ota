// The server actions of a payment's page `/payments/[paymentId]` (OAD-011; routes.md §7, README §7, OADR-0018 points 4,
// 5 and 8): capture and refund, the same dialogs and the same calls as on a booking's Payments tab (OAD-008).
//
//   capturePayment   console.payments.capture   payments:capture   `ifMatch` = the payment's version, idempotency key
//   refundPayment    console.payments.refund    payments:refund    idempotency key; never an airline card
//
// Each runs the booking page's action of the same name (`bookings/[bookingId]/actions.ts`), so a payment is captured or
// refunded one way wherever staff start: `requireStaff(permission)` first (a forged POST from an agent gets "You do
// not have permission to do this (payments:refund)" before any call), the same Zod schema, one SDK call with the
// dialog's idempotency key (`actionKey`, rendered once with the page, so a double submit or a retry replays the
// capture or refund instead of repeating it), and the API's known codes as the dialog's state, on the server, never
// thrown to `error.tsx`: a refund above what is still refundable (`422 UNPROCESSABLE`, `amount_exceeds_captured`)
// shows its message on the amount with the request id, an airline-card payment's refund (`refund_via_airline`) says
// the airline refunds it, `402 PAYMENT_DECLINED` that the authorisation expired, `412` asks for a reload. Only
// redirects (an ended session) and bugs are thrown. The state goes back to the dialog as the shared action answers
// it, so what it says about the key of the next submission (OADR-0018 point 5) reaches `ConfirmDialog` unchanged.
//
// What this page adds is where a success shows: the payment's page and the payments list are revalidated (the new
// render brings new idempotency keys and the payment's new version), and the booking's page when the payment has one
// (the shared action revalidates it from the dialog's `bookingId`). No card data: neither action reads a card field.
"use server";

import { revalidatePath } from "next/cache";

import { BOOKING_ID_FIELD, PAYMENT_ID_FIELD } from "@/app/(console)/bookings/[bookingId]/action-rules";
import {
  capturePayment as captureBookingPayment,
  refundPayment as refundBookingPayment,
} from "@/app/(console)/bookings/[bookingId]/actions";
import type { ActionState } from "@/lib/action-state";

/** The list of payments (`/payments`). */
const PAYMENTS_PATH = "/payments";
/** A payment id as the API writes it, the only value this module puts into a path. */
const PAYMENT_ID = /^pay_[0-9A-Za-z]{16,40}$/;
/** A booking id as the API writes it. */
const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;

/** A text field of the form, when it has the shape `pattern` describes. */
function idOf(form: FormData, name: string, pattern: RegExp): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/**
 * After a success: the payment's page, the payments list and, when the dialog posted one, the booking's page (every
 * tab), whose next renders show the captured or refunded payment.
 */
function revalidatePayment(form: FormData): void {
  const paymentId = idOf(form, PAYMENT_ID_FIELD, PAYMENT_ID);
  if (paymentId !== undefined) {
    revalidatePath(`${PAYMENTS_PATH}/${paymentId}`);
  }
  revalidatePath(PAYMENTS_PATH);
  const bookingId = idOf(form, BOOKING_ID_FIELD, BOOKING_ID);
  if (bookingId !== undefined) {
    revalidatePath(`/bookings/${bookingId}`);
  }
}

/**
 * Capture an authorised Stripe payment from its page (`payments:capture`): `ifMatch` = the payment's version, the
 * dialog's idempotency key, the amount (empty: the whole authorisation; less releases the rest) and the reason.
 */
export async function capturePayment(previous: ActionState, form: FormData): Promise<ActionState> {
  const state = await captureBookingPayment(previous, form);
  if (state.ok === true) {
    revalidatePayment(form);
  }
  return state;
}

/**
 * Refund a captured Stripe payment from its page (`payments:refund`: owner, admin and finance; never an agent): the
 * amount, at most what is still refundable, the reason category, the dialog's reason as the refund's note and the
 * dialog's idempotency key. The API records the refund `pending` and the payments queue sends it to Stripe.
 */
export async function refundPayment(previous: ActionState, form: FormData): Promise<ActionState> {
  const state = await refundBookingPayment(previous, form);
  if (state.ok === true) {
    revalidatePayment(form);
  }
  return state;
}
