"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  MANUAL_SUBSCRIPTION_STRINGS as M,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  REASON_STRINGS,
  RESYNC_STRINGS as R,
} from "@/lib/strings";

/**
 * The server actions of `/subscriptions/[subscriptionId]` (README §2 and §4; subscription-billing flow §G, PF-75):
 * "Edit manual subscription" (`adminUpdateManualSubscription`, **reason**, `If-Match`). Before Stripe Billing (M5)
 * every OTA runs on a manual trial; an admin moves its end date, changes its plan, or cancels or reopens it, and the
 * reason is kept in the audit log. Stripe-billed rows are never edited here: the page offers no form for them, and the
 * API refuses them (`409`, `stripe_billed`). Since PAD-012 (M5, PF-89) a Stripe-billed row is resynced from Stripe
 * instead ("Resync from Stripe", `adminResyncSubscription`, at the end of this file).
 *
 * The action checks every field with Zod before it calls the API (the reason as `AdminReason` counts it: 5 to 500 code
 * points after trimming), so made-up fields send nothing. An ended session goes to `/sign-in` and back;
 * `REAUTH_REQUIRED` returns the previous state with `stepUp: true`, so `useStepUpAction` asks for a TOTP code and runs
 * the action again with the same form data (the same reason). A success revalidates the subscription, the list and
 * the OTA's page. The state carries only what the form shows, in the admin's own words.
 */

type Schemas = components["schemas"];

/** The fields of the form that can show a message. */
export type ManualSubscriptionField = "planCode" | "trialEndsAt" | "status";

/** What the form shows of a saved subscription. */
export interface SavedManualSubscription {
  readonly planCode: string;
  readonly planName: string;
  readonly status: Schemas["SubscriptionStatus"];
  readonly trialEndsAt: string | null;
  readonly version: number;
}

/** The state of the form. */
export type ManualSubscriptionState = {
  /** The call answered `REAUTH_REQUIRED`: `useStepUpAction` asks for a TOTP code and runs the action again. */
  readonly stepUp?: true;
} & (
  | { readonly status: "idle" }
  | { readonly status: "done"; readonly subscription: SavedManualSubscription }
  | {
      readonly status: "failed";
      /** The error code, for tests and the `data-code` of the notice; never shown. */
      readonly code: PlatformErrorCode;
      readonly message: string;
      /** The field the problem belongs to, when it belongs to one. */
      readonly field?: ManualSubscriptionField;
    }
);

/** `SubscriptionId` and `PlanCode` of the platform document, the version of `If-Match`, and the editable statuses. */
const SUBSCRIPTION_ID = z.string().regex(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/);
/** `TenantId`: the OTA's page a resync revalidates. */
const TENANT_ID = z.string().regex(/^ten_[0-9A-HJKMNP-TV-Z]{26}$/);
const PLAN_CODE = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const VERSION = z.string().regex(/^[1-9][0-9]{0,14}$/);
/**
 * An RFC 3339 instant in UTC, as the form writes it (`2027-02-12T08:20:11.000Z`; fractions of a second optional). Its
 * seconds are required, as the API's `format: date-time` requires them: Zod 3 also took `2027-02-12T08:20Z`, which the
 * API then refused with the same message at the same field, and which the form never writes.
 */
const INSTANT = z.iso.datetime();
const STATUS = z.enum(["trialing", "active", "canceled"]);

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * What is wrong with `value` as an `AdminReason` (5–500 code points after trimming), or `undefined`. The same rule as
 * `reasonProblem` of `ReasonDialog`, which a server module cannot import (it is a client module).
 */
function reasonProblem(value: string): string | undefined {
  const length = [...value.trim()].length;
  if (length === 0) {
    return REASON_STRINGS.required;
  }
  if (length < REASON_MIN_LENGTH) {
    return REASON_STRINGS.tooShort;
  }
  return length > REASON_MAX_LENGTH ? REASON_STRINGS.tooLong : undefined;
}

function invalid(message: string, field?: ManualSubscriptionField): ManualSubscriptionState {
  return { status: "failed", code: "VALIDATION_FAILED", message, ...(field === undefined ? {} : { field }) };
}

/** A failure's message in the admin's words, and the field it belongs to when it belongs to one. */
interface Failure {
  readonly message: string;
  readonly field?: ManualSubscriptionField;
}

/** `409 CONFLICT` and `422 UNPROCESSABLE` by their `details.reason`. */
const REFUSALS: Readonly<Record<string, Failure>> = {
  "CONFLICT:stripe_billed": { message: M.stripeBilled },
  "CONFLICT:current_exists": { message: M.currentExists, field: "status" },
  "UNPROCESSABLE:plan_not_active": { message: M.planNotActive, field: "planCode" },
};

/** Codes the form words itself; the others take the catalogue's message. */
const CODE_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  PRECONDITION_FAILED: M.stale,
  NOT_FOUND: M.subscriptionGone,
  VALIDATION_FAILED: M.formExpired,
};

/** The message of a failed call, and the field it belongs to. */
function failureOf(error: ApiError): Failure {
  const refusal = `${error.code}:${String(error.details["reason"])}`;
  if (Object.hasOwn(REFUSALS, refusal)) {
    return REFUSALS[refusal] ?? { message: errorMessage(error) };
  }
  if (error.code === "VALIDATION_FAILED") {
    const paths = new Set(error.fieldErrors.map(({ path }) => path));
    if (paths.has("/trialEndsAt")) {
      return { message: M.trialEndInvalid, field: "trialEndsAt" };
    }
    if (paths.has("/planCode")) {
      return { message: M.planNotActive, field: "planCode" };
    }
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return { message: M.rateLimitedFor(error.retryAfterSeconds) };
  }
  return { message: CODE_MESSAGES[error.code] ?? errorMessage(error) };
}

/**
 * Edits the manual subscription of the hidden field `subscriptionId` (`adminUpdateManualSubscription`) with the
 * changes the form carries, each only when the admin changed it: `planCode` (an active plan), `trialEndsAt` (the new
 * end of the trial, an instant in UTC) and `status` (`trialing`, `active`: paid outside Stripe, or `canceled`), and
 * the mandatory `reason`. The hidden
 * `version` the page was rendered with goes into `If-Match` (`"<version>"`), so a change made in the meantime answers
 * `412` and the form asks to reload instead of overwriting it. The answer is the subscription as saved.
 */
export async function updateManualSubscription(
  previous: ManualSubscriptionState,
  formData: FormData,
): Promise<ManualSubscriptionState> {
  const subscriptionId = SUBSCRIPTION_ID.safeParse(text(formData, "subscriptionId"));
  const version = VERSION.safeParse(text(formData, "version"));
  if (!subscriptionId.success || !version.success) {
    return invalid(M.formExpired);
  }
  const body: Schemas["UpdateManualSubscriptionRequest"] = { reason: "" };
  const planCode = text(formData, "planCode");
  if (planCode !== "") {
    const parsed = PLAN_CODE.safeParse(planCode);
    if (!parsed.success) {
      return invalid(M.planNotActive, "planCode");
    }
    body.planCode = parsed.data;
  }
  const trialEndsAt = text(formData, "trialEndsAt");
  if (trialEndsAt !== "") {
    const parsed = INSTANT.safeParse(trialEndsAt);
    if (!parsed.success) {
      return invalid(M.trialEndInvalid, "trialEndsAt");
    }
    body.trialEndsAt = parsed.data;
  }
  const status = text(formData, "status");
  if (status !== "") {
    const parsed = STATUS.safeParse(status);
    if (!parsed.success) {
      return invalid(M.formExpired, "status");
    }
    body.status = parsed.data;
  }
  if (body.planCode === undefined && body.trialEndsAt === undefined && body.status === undefined) {
    return invalid(M.noChange);
  }
  const reason = text(formData, "reason");
  const problem = reasonProblem(reason);
  if (problem !== undefined) {
    return invalid(problem);
  }
  body.reason = reason.trim();

  const api = await platformApi();
  const result = await api.PATCH("/v1/admin/subscriptions/{subscriptionId}", {
    params: {
      path: { subscriptionId: subscriptionId.data },
      header: { "If-Match": `"${version.data}"` },
    },
    body,
  });
  if (result.error !== undefined) {
    const { error } = result;
    if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
      redirect(
        `/sign-in?${new URLSearchParams({ next: `/subscriptions/${subscriptionId.data}` }).toString()}`,
      );
    }
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    const failure = failureOf(error);
    return { status: "failed", code: error.code, ...failure };
  }
  const saved = result.data;
  revalidatePath(`/subscriptions/${saved.id}`);
  revalidatePath("/subscriptions");
  revalidatePath(`/tenants/${saved.tenantId}`);
  return {
    status: "done",
    subscription: {
      planCode: saved.planCode,
      planName: saved.planName,
      status: saved.status,
      trialEndsAt: saved.trialEndsAt,
      version: saved.version,
    },
  };
}

// ---- Resync from Stripe (PAD-012, M5) -------------------------------------------------------------------------------

/** What the resync's outcome shows of the subscription as Stripe has it now. */
export interface ResyncedSubscription {
  readonly status: Schemas["SubscriptionStatus"];
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly version: number;
}

/** The state of "Resync from Stripe". */
export type ResyncState = {
  /** The call answered `REAUTH_REQUIRED`: `useStepUpAction` asks for a TOTP code and runs the action again. */
  readonly stepUp?: true;
} & (
  | { readonly status: "idle" }
  | { readonly status: "done"; readonly subscription: ResyncedSubscription }
  | {
      readonly status: "failed";
      /** The error code, for tests and the `data-code` of the notice; never shown. */
      readonly code: PlatformErrorCode;
      readonly message: string;
    }
);

/** The resync's own words for the codes that are not a `409` with a known `details.reason`. */
const RESYNC_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  CONFLICT: R.otherConflict,
  NOT_FOUND: R.subscriptionGone,
  PROVIDER_ERROR: R.providerError,
  VALIDATION_FAILED: R.formExpired,
};

/**
 * Re-fetches the Stripe subscription of the hidden field `subscriptionId` from Stripe now (`adminResyncSubscription`,
 * PF-89, subscription-billing flow §D note of PBE-048): the API applies it as `customer.subscription.updated` would
 * (status, periods, cancellation, price and plan, then the status rules, which may set or clear the billing notice and
 * suspend or resume the OTA for billing) under the lock the subscription's events take, and writes the admin's
 * `subscription.resynced` audit row. The page offers it on Stripe rows with a Stripe subscription only; the API's
 * `409 CONFLICT` reasons (`manual`, `not_linked` and billing sync's failure codes in lower case, such as
 * `unknown_price` or `subscription_busy`) and a Stripe failure (`502`, nothing changed) are worded. The operation asks
 * for neither a reason nor a step-up. A success revalidates the subscription, the list, the OTA's page and the
 * dashboard (its past-due count).
 */
export async function resyncSubscription(previous: ResyncState, formData: FormData): Promise<ResyncState> {
  const subscriptionId = SUBSCRIPTION_ID.safeParse(text(formData, "subscriptionId"));
  const tenantId = TENANT_ID.safeParse(text(formData, "tenantId"));
  if (!subscriptionId.success || !tenantId.success) {
    return { status: "failed", code: "VALIDATION_FAILED", message: R.formExpired };
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/subscriptions/{subscriptionId}/resync", {
    params: { path: { subscriptionId: subscriptionId.data } },
  });
  if (result.error !== undefined) {
    const { error } = result;
    if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
      redirect(
        `/sign-in?${new URLSearchParams({ next: `/subscriptions/${subscriptionId.data}` }).toString()}`,
      );
    }
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    const reason = error.details["reason"];
    const conflict =
      error.code === "CONFLICT" && typeof reason === "string" && Object.hasOwn(R.conflicts, reason)
        ? R.conflicts[reason]
        : undefined;
    const message =
      conflict ??
      (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined
        ? R.rateLimitedFor(error.retryAfterSeconds)
        : (RESYNC_MESSAGES[error.code] ?? errorMessage(error)));
    return { status: "failed", code: error.code, message };
  }
  const resynced = result.data;
  revalidatePath(`/subscriptions/${resynced.id}`);
  revalidatePath("/subscriptions");
  revalidatePath(`/tenants/${tenantId.data}`);
  revalidatePath("/");
  return {
    status: "done",
    subscription: {
      status: resynced.status,
      currentPeriodEnd: resynced.currentPeriodEnd,
      cancelAtPeriodEnd: resynced.cancelAtPeriodEnd,
      version: resynced.version,
    },
  };
}
