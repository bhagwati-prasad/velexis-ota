"use server";

import { revalidatePath } from "next/cache";
import { toActionError } from "@velexis/ota-sdk/next";
import type { Schemas } from "@velexis/ota-sdk";
import { consoleApi, mustBeStaff } from "@/lib/velexis";
import type { FormState } from "@/lib/action-state";

// Every console server action re-checks the staff session and permission: server actions are public endpoints.

/** Issue tickets (Amadeus Flight Order Issue). One idempotency key per click (generated in the form). */
export async function issueAction(bookingId: string, version: number, _prev: FormState, form: FormData): Promise<FormState> {
  await mustBeStaff({ permissions: ["bookings:issue"] });
  const fop = String(form.get("formOfPayment") ?? "");
  try {
    await (await consoleApi()).bookings.issue(
      {
        bookingId,
        ifMatch: version,
        formOfPayments: fop ? [{ other: { method: fop as NonNullable<NonNullable<Schemas["AmadeusOtherMethod"]>["method"]> } }] : undefined,
        capturePayment: form.get("capture") !== "off",
        allowUnpaid: form.get("allowUnpaid") === "on",
        notifyCustomer: form.get("notify") === "on",
        reason: String(form.get("reason") ?? "") || undefined,
      },
      { idempotencyKey: String(form.get("clickId")), timeoutMs: 90_000 },
    );
  } catch (e) {
    return { error: toActionError(e) }; // TICKETING_FAILED → error.details / supplier code (e.g. 9112)
  }
  revalidatePath(`/console/bookings/${bookingId}`);
  return { ok: true, message: "Issued." };
}

/** Cancel the order (Flight Order Management DELETE) and refund per the chosen mode. */
export async function cancelAction(bookingId: string, version: number, _prev: FormState, form: FormData): Promise<FormState> {
  await mustBeStaff({ permissions: ["bookings:cancel"] });
  const mode = String(form.get("refund") ?? "none") as "none" | "full" | "amount";
  try {
    await (await consoleApi()).bookings.cancel(
      {
        bookingId,
        ifMatch: version,
        reasonCode: String(form.get("reasonCode") ?? "customer_request") as Schemas["ConsoleBookingCancelRequest"]["reasonCode"],
        reason: String(form.get("reason") ?? ""),
        refund: mode === "amount" ? { mode, amount: { amount: String(form.get("amount")), currency: String(form.get("currency")) } } : { mode },
        notifyCustomer: form.get("notify") === "on",
      },
      { idempotencyKey: String(form.get("clickId")), timeoutMs: 90_000 },
    );
  } catch (e) {
    return { error: toActionError(e) };
  }
  revalidatePath(`/console/bookings/${bookingId}`);
  return { ok: true, message: "Cancelled." };
}

/**
 * Flight Order Management PATCH: ticketing agreement (`option` + `delay`) and a new general remark. Velexis merges
 * remarks with the stored order (`mergeRemarks`, default true), so only the new remark is sent.
 */
export async function patchAction(bookingId: string, version: number, _prev: FormState, form: FormData): Promise<FormState> {
  await mustBeStaff({ permissions: ["bookings:write"] });
  const option = String(form.get("ticketingOption") ?? "");
  const remark = String(form.get("remark") ?? "").trim().toUpperCase();
  const patch: Omit<Schemas["ConsoleBookingPatchRequest"], "reason"> = {};
  if (option) {
    patch.ticketingAgreement = {
      option: option as NonNullable<Schemas["AmadeusTicketingAgreement"]["option"]>,
      delay: String(form.get("delay") ?? "") || undefined, // dateTime is read-only (derived by Amadeus)
    };
  }
  if (remark) patch.remarks = { general: [{ subType: (String(form.get("remarkType")) || "GENERAL_MISCELLANEOUS") as Schemas["AmadeusGeneralRemarkType"], text: remark }] };
  if (!patch.ticketingAgreement && !patch.remarks) return { message: "Nothing to change." };
  try {
    await (await consoleApi()).bookings.patch({ bookingId, ifMatch: version, ...patch, notifyCustomer: false, reason: String(form.get("reason") ?? "") || undefined });
  } catch (e) {
    return { error: toActionError(e) }; // VERSION_CONFLICT (Amadeus 2552) / PRECONDITION_FAILED → reload; SUPPLIER_TIMEOUT → resync first
  }
  revalidatePath(`/console/bookings/${bookingId}`);
  return { ok: true, message: "Order updated." };
}

/** Internal note (never sent to Amadeus). */
export async function addNoteAction(bookingId: string, _prev: FormState, form: FormData): Promise<FormState> {
  await mustBeStaff({ permissions: ["bookings:read"] });
  try {
    await (await consoleApi()).bookings.addNote({ bookingId, text: String(form.get("text") ?? ""), visibleToCustomer: form.get("visible") === "on" });
  } catch (e) {
    return { error: toActionError(e) };
  }
  revalidatePath(`/console/bookings/${bookingId}`);
  return { ok: true, message: "Note added." };
}

/** Re-synchronise with Amadeus (status, tickets, schedule changes). */
export async function resyncAction(bookingId: string, _prev: FormState): Promise<FormState> {
  await mustBeStaff({ permissions: ["bookings:write"] });
  try {
    const r = await (await consoleApi()).bookings.resync({ bookingId, include: ["bags"], fareRules: ["refunds"] });
    revalidatePath(`/console/bookings/${bookingId}`);
    return { ok: true, message: r.changes.length ? `Changes: ${r.changes.map((c) => c.label).join(", ")}` : "Already in sync." };
  } catch (e) {
    return { error: toActionError(e) };
  }
}
