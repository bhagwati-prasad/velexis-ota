"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { GENERATE_SETTLEMENTS_STRINGS as G } from "@/lib/strings";

/**
 * The server action of `/settlements` (README §2, flows/stripe-payments-account.md §F, PF-91): "Generate drafts", which
 * asks `adminGenerateSettlements` to (re)build the drafts of a calendar month that has ended, for every OTA or for one.
 * The operation needs neither a reason nor a step-up (no `x-reason-required`, no `x-mfa-step-up`): it queues the job
 * `settlement.generate` and answers `202` before the job runs, so the list shows the drafts once it has run.
 *
 * The action checks its form before it calls the API (the month as `YYYY-MM` and ended in UTC, the optional OTA by its
 * id), so made-up fields send nothing. `period_not_closed` lands at the month; an unknown OTA, a rate limit and an
 * unreachable Redis (`503`) are worded for the admin, never with the API's text. An ended session goes to `/sign-in`
 * and back to the list.
 */

/** The state of the "Generate drafts" form. */
export type GenerateSettlementsState =
  | { readonly status: "idle" }
  | {
      readonly status: "queued";
      /** The month asked for (`YYYY-MM`), for the outcome's link to its drafts. */
      readonly period: string;
      readonly tenantId: string | null;
    }
  | {
      readonly status: "failed";
      /** The error code, for tests and the `data-code` of the notice; never shown. */
      readonly code: PlatformErrorCode;
      /** A problem with the month, shown at its field. */
      readonly monthError?: string;
      /** Any other problem, shown above the form. */
      readonly message?: string;
    };

/** A month of the form: `YYYY-MM`. */
const PERIOD = /^([0-9]{4})-(0[1-9]|1[0-2])$/;

/** `TenantId` of the platform document. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Whether the month `period` (`YYYY-MM`) has ended by `now`, in UTC, as the API requires. */
function hasEnded(period: string, now: Date): boolean {
  const match = PERIOD.exec(period);
  if (match === null) {
    return false;
  }
  const nextMonth = Date.UTC(Number(match[1]), Number(match[2]), 1);
  return nextMonth <= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function failed(
  code: PlatformErrorCode,
  problem: { monthError?: string; message?: string },
): GenerateSettlementsState {
  return { status: "failed", code, ...problem };
}

/** The state of a refused call, in the admin's words. */
function refused(error: ApiError): GenerateSettlementsState {
  if (error.code === "VALIDATION_FAILED") {
    return error.fieldErrors.some((field) => field.path === "/periodStart")
      ? failed(error.code, { monthError: G.periodNotClosed })
      : failed(error.code, { message: G.formExpired });
  }
  if (error.code === "NOT_FOUND") {
    return failed(error.code, { message: G.tenantGone });
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return failed(error.code, { message: G.rateLimitedFor(error.retryAfterSeconds) });
  }
  return failed(error.code, { message: errorMessage(error) });
}

/**
 * Asks the API to (re)build the drafts of the month `period` (`YYYY-MM`, ended in UTC) for every OTA, or only for the
 * OTA of the field `tenantId` when the form sends one (`adminGenerateSettlements`). Existing drafts of that month are
 * rebuilt from scratch; approved, paid and carried-forward statements are never touched. The answer comes before the
 * job runs.
 */
export async function generateSettlements(
  _previous: GenerateSettlementsState,
  formData: FormData,
): Promise<GenerateSettlementsState> {
  const period = text(formData, "period");
  if (!PERIOD.test(period)) {
    return failed("VALIDATION_FAILED", { monthError: G.monthInvalid });
  }
  if (!hasEnded(period, new Date())) {
    return failed("VALIDATION_FAILED", { monthError: G.periodNotClosed });
  }
  const tenantId = text(formData, "tenantId");
  if (tenantId !== "" && !TENANT_ID.test(tenantId)) {
    return failed("VALIDATION_FAILED", { message: G.formExpired });
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/settlements/generate", {
    body: { periodStart: `${period}-01T00:00:00Z`, ...(tenantId === "" ? {} : { tenantId }) },
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: "/settlements" }).toString()}`);
    }
    return refused(result.error);
  }
  revalidatePath("/settlements");
  return { status: "queued", period, tenantId: tenantId === "" ? null : tenantId };
}
