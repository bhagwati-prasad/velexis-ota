"use server";

import { revalidatePath } from "next/cache";
import { toActionError } from "@velexis/ota-sdk/next";
import type { Booking, CancellationQuote, CancellationReason, CancellationResult, ContactInput, Money } from "@velexis/ota-sdk";
import { customerClient } from "@/lib/velexis";
import type { ActionResult } from "@/lib/action-state";

/** Replace the booking contacts at the airline (Flight Order Management PATCH). Customer token or guest booking token. */
export async function updateContactsAction(bookingId: string, version: number, contacts: ContactInput[]): Promise<ActionResult<Booking>> {
  try {
    const vx = await customerClient({ bookingId });
    const booking = await vx.bookings.update({ bookingId, ifMatch: version, contacts });
    revalidatePath(`/bookings/${bookingId}`);
    return { ok: true, data: booking };
  } catch (e) {
    return { ok: false, error: toActionError(e) }; // VERSION_CONFLICT / PRECONDITION_FAILED → reload
  }
}

/** Refund preview (valid 10 minutes). */
export async function quoteCancellationAction(bookingId: string): Promise<ActionResult<CancellationQuote>> {
  try {
    const vx = await customerClient({ bookingId });
    return { ok: true, data: await vx.bookings.quoteCancellation({ bookingId }) };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/**
 * Cancel with the refund the customer saw (`expectedRefund`); REFUND_AMOUNT_CHANGED returns the new amount in
 * `error.details.newRefund`. One idempotency key per (booking, version) so a double click never cancels twice.
 */
export async function cancelBookingAction(
  bookingId: string,
  version: number,
  reasonCode: CancellationReason,
  expectedRefund: Money,
  comment?: string,
): Promise<ActionResult<CancellationResult["cancellation"]>> {
  try {
    const vx = await customerClient({ bookingId });
    const { cancellation } = await vx.bookings.cancel(
      { bookingId, ifMatch: version, reasonCode, expectedRefund, comment },
      { idempotencyKey: `cancel-${bookingId}-${version}`, timeoutMs: 90_000 },
    );
    revalidatePath(`/bookings/${bookingId}`);
    revalidatePath("/bookings");
    return { ok: true, data: cancellation };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
