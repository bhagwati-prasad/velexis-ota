"use server";

import { completeCheckout, toActionError } from "@velexis/ota-sdk/next";
import type { Checkout, CompleteCheckoutParams, ContactInput, TravelerInput } from "@velexis/ota-sdk";
import { customerClient, velexisConfig } from "@/lib/velexis";
import type { ActionResult } from "@/lib/action-state";

// Customer / anonymous server clients get customer scope from the API (selling amounts only), so results go to the
// client components as they are.

/**
 * Travellers are saved through a server action (passport data never passes through third-party browser scripts or
 * the proxy). `ifMatch` = the checkout version the form was rendered with.
 */
export async function saveTravelersAction(checkoutId: string, version: number, travelers: TravelerInput[]): Promise<ActionResult<Checkout>> {
  try {
    const vx = await customerClient();
    return { ok: true, data: await vx.checkout.setTravelers({ checkoutId, ifMatch: version, travelers }) };
  } catch (e) {
    return { ok: false, error: toActionError(e) }; // TRAVELER_DATA_INVALID → error.fieldErrors (/travelers/0/documents/0/expiryDate …)
  }
}

/** Booking contacts (primary contact receives confirmations and — for guests — the booking reference). */
export async function saveContactsAction(checkoutId: string, version: number, contacts: ContactInput[]): Promise<ActionResult<Checkout>> {
  try {
    const vx = await customerClient();
    return { ok: true, data: await vx.checkout.setContacts({ checkoutId, ifMatch: version, contacts }) };
  } catch (e) {
    return { ok: false, error: toActionError(e) }; // CONTACT_DATA_INVALID → PRIMARY_CONTACT_REQUIRED, MOBILE_PHONE_REQUIRED …
  }
}

/**
 * Complete the checkout: Amadeus Flight Create Orders (+ issuance per the OTA's policy). `completeCheckout` uses a
 * stable idempotency key per (checkout, payment), so a retried call replays the stored result instead of booking twice,
 * and stores guest booking tokens in httpOnly cookies — of the new booking, and of the pending booking after a
 * SUPPLIER_TIMEOUT (so the guest can follow it on the booking page) — never in the action result.
 */
export async function completeCheckoutAction(params: CompleteCheckoutParams) {
  return completeCheckout(params, { config: velexisConfig });
}
