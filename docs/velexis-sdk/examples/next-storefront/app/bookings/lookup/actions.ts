"use server";

import { redirect } from "next/navigation";
import { captureBookingToken, toActionError } from "@velexis/ota-sdk/next";
import { isVelexisError } from "@velexis/ota-sdk";
import { anonymousClient, velexisConfig } from "@/lib/velexis";
import type { FormState } from "@/lib/action-state";

/**
 * Guest "manage my booking": booking reference (or record locator) + last name → guest booking token (24 h), stored in
 * an httpOnly cookie — never in localStorage. Wrong reference and wrong name give the same answer (no enumeration).
 */
export async function lookupBookingAction(_prev: FormState, form: FormData): Promise<FormState> {
  const bookingReference = String(form.get("reference") ?? "").trim().toUpperCase();
  const lastName = String(form.get("lastName") ?? "").trim();
  if (!bookingReference || !lastName) return { message: "Enter your booking reference and last name." };

  let bookingId: string;
  try {
    const vx = await anonymousClient();
    const r = await vx.bookings.lookup({ bookingReference, lastName }); // per-visitor rate limit: the client sends the visitor IP
    await captureBookingToken(r, { config: velexisConfig }); // httpOnly vx_bt_<bookingId>, expires with the token
    bookingId = r.bookingId;
  } catch (e) {
    if (isVelexisError(e, "NOT_FOUND")) return { message: "We could not find a booking with these details." };
    if (isVelexisError(e, "RATE_LIMITED")) return { message: "Too many attempts. Please try again in 15 minutes." };
    return { ok: false, error: toActionError(e) };
  }
  redirect(`/bookings/${bookingId}`);
}
