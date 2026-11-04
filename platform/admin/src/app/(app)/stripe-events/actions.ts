"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { STRIPE_EVENT_ACTION_STRINGS as S } from "@/lib/strings";

/**
 * The server action of `/stripe-events` (README §2 and §4; subscription-billing flow, failure handling and the §D
 * note of PBE-048; PF-89, PAD-012): "Reprocess" runs a `failed` or `ignored` event of the Stripe webhook inbox again
 * (`adminReprocessStripeEvent`), once its cause is fixed. The table offers it on those two statuses only; the API
 * answers any other status with `409 CONFLICT` and the status as `details.reason` (`processing`, `received`,
 * `processed`), which is worded, as are an event that is gone and a rate limit. The operation asks for neither a reason
 * nor a step-up.
 *
 * The action checks the event id before it calls the API, so a made-up field sends nothing. An ended session goes to
 * `/sign-in` and back to the inbox; `REAUTH_REQUIRED` returns the previous state with `stepUp: true`, so
 * `useStepUpAction` asks for a TOTP code and runs the action again (the operation asks for none today; the console
 * handles it the same way everywhere). A success revalidates the inbox and the dashboard (its count of failed events).
 * The state carries only the event id and the admin's own words, never the API's message.
 */

/** The state of "Reprocess". */
export type ReprocessState = {
  /** The call answered `REAUTH_REQUIRED`: `useStepUpAction` asks for a TOTP code and runs the action again. */
  readonly stepUp?: true;
} & (
  | { readonly status: "idle" }
  | { readonly status: "done"; readonly eventId: string }
  | {
      readonly status: "failed";
      /** The error code, for tests and the `data-code` of the notice; never shown. */
      readonly code: PlatformErrorCode;
      readonly message: string;
    }
);

/** `StripeEventId` of the platform document. */
const EVENT_ID = z
  .string()
  .max(255)
  .regex(/^evt_[A-Za-z0-9_]+$/);

const STRIPE_EVENTS_PATH = "/stripe-events";

/** The action's own words for the codes that are not a `409` with a known `details.reason`. */
const MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  CONFLICT: S.otherConflict,
  NOT_FOUND: S.eventGone,
  VALIDATION_FAILED: S.formExpired,
};

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Reprocesses the event of the field `eventId` (`adminReprocessStripeEvent`): the API takes the event back to
 * `received` with its attempts and last error kept, writes the `stripe_event.reprocessed` audit row and, after the
 * commit, queues it on `platform-stripe-events` again; it answers `202` before the worker ran, so the outcome says the
 * event is queued and to reload later.
 */
export async function reprocessStripeEvent(
  previous: ReprocessState,
  formData: FormData,
): Promise<ReprocessState> {
  const eventId = EVENT_ID.safeParse(text(formData, "eventId"));
  if (!eventId.success) {
    return { status: "failed", code: "VALIDATION_FAILED", message: S.formExpired };
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/stripe-events/{eventId}/reprocess", {
    params: { path: { eventId: eventId.data } },
  });
  if (result.error !== undefined) {
    const { error } = result;
    if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: STRIPE_EVENTS_PATH }).toString()}`);
    }
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    const reason = error.details["reason"];
    const conflict =
      error.code === "CONFLICT" && typeof reason === "string" && Object.hasOwn(S.conflicts, reason)
        ? S.conflicts[reason]
        : undefined;
    const message =
      conflict ??
      (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined
        ? S.rateLimitedFor(error.retryAfterSeconds)
        : (MESSAGES[error.code] ?? errorMessage(error)));
    return { status: "failed", code: error.code, message };
  }
  // The worker changes the event after this answer; the revalidated inbox shows it as received until it ran.
  revalidatePath(STRIPE_EVENTS_PATH);
  revalidatePath("/");
  return { status: "done", eventId: eventId.data };
}
