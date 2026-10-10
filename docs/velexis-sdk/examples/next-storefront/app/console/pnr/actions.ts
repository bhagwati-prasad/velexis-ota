"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { toActionError } from "@velexis/ota-sdk/next";
import { isVelexisError } from "@velexis/ota-sdk";
import { consoleApi, mustBeStaff } from "@/lib/velexis";
import type { FormState } from "@/lib/action-state";

/** Attach an existing Amadeus order (GDS terminal, other tool) to the OTA's bookings, optionally for a customer. */
export async function importPnrAction(reference: string, flightOrderId: string, _prev: FormState, form: FormData): Promise<FormState> {
  await mustBeStaff({ permissions: ["bookings:write"] });
  let bookingId: string;
  const mode = String(form.get("pricing") ?? "markup_rules") as "markup_rules" | "net" | "override";
  try {
    const booking = await (await consoleApi()).bookings.import(
      {
        reference,
        originSystemCode: "GDS",
        flightOrderId,
        customerId: String(form.get("customerId") ?? "") || undefined,
        contactEmail: String(form.get("contactEmail") ?? "") || undefined,
        pricing: mode === "override" ? { mode, sellingTotal: { amount: String(form.get("sellingAmount")), currency: String(form.get("currency")) } } : { mode },
        sendConfirmation: form.get("sendConfirmation") === "on",
        tags: String(form.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
        note: String(form.get("note") ?? "") || undefined,
        reason: String(form.get("reason") ?? "") || "Imported from PNR lookup",
      },
      { idempotencyKey: `import-${flightOrderId}` },
    );
    bookingId = booking.id;
  } catch (e) {
    if (isVelexisError(e, "ORDER_ALREADY_IMPORTED") && typeof e.details?.bookingId === "string") redirect(`/console/bookings/${e.details.bookingId}`);
    return { error: toActionError(e) };
  }
  revalidatePath("/console/bookings");
  redirect(`/console/bookings/${bookingId}`);
}
