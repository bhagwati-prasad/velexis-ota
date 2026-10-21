"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ADMIN_LIST_STRINGS, REASON_MAX_LENGTH, REASON_MIN_LENGTH, REASON_STRINGS } from "@/lib/strings";

/**
 * The server actions of `/admins` (README §2, §4; PADR-0006 items 4 and 5, PF-86):
 *
 * - `grantAdmin` (`adminGrantAdmin`): the e-mail address of an existing account and a **reason**, with a **step-up**;
 * - `revokeAdmin` (`adminRevokeAdmin`): a **step-up** and no reason (the API's reason is optional, and PADR-0006 item
 *   5 asks for none).
 *
 * Both operations are `x-mfa-step-up`: without a TOTP verification in the last 15 minutes the API answers
 * `REAUTH_REQUIRED`, the action returns `stepUp: true`, and `useStepUpAction` asks for a code and runs it again with
 * the same form data. Each action checks its form before it calls the API, so an action called with made-up fields
 * sends nothing. An ended session goes to `/sign-in` and back to `/admins`. A success revalidates `/admins` and the
 * account's page. The states carry only what the page shows, in the admin's own words: never the API's message.
 */

/** A refused action, in the admin's words. */
export interface AdminActionFailure {
  readonly status: "failed";
  /** The error code, for tests and the `data-code` of the notice; never shown. */
  readonly code: PlatformErrorCode;
  readonly message: string;
}

/** The state of the grant and revoke forms. */
export type AdminActionState = { readonly stepUp?: true } & (
  | { readonly status: "idle" }
  | {
      readonly status: "done";
      readonly action: "grant" | "revoke";
      /** The account whose rights changed, as the page names it. */
      readonly accountId: string;
      readonly name: string;
    }
  | AdminActionFailure
);

/** `AccountId` of the platform document. */
const ACCOUNT_ID = /^acc_[0-9A-HJKMNP-TV-Z]{26}$/;

/** `EmailAddress` of the platform document: at most 254 characters; spaces around it are dropped. */
const EMAIL = z.string().trim().min(1).max(254).email();

/**
 * The longest name a revoke form carries back (only to word its outcome): the `maxLength` of an account's name in the
 * platform document.
 */
const NAME_MAX_LENGTH = 200;

const ADMINS_PATH = "/admins";

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** What is wrong with `value` as an `AdminReason` (5–500 code points after trimming), or `undefined`. */
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

function invalid(message: string): AdminActionFailure {
  return { status: "failed", code: "VALIDATION_FAILED", message };
}

/** The `details.reason` of each code, worded. */
const REASONS: Readonly<Partial<Record<PlatformErrorCode, Readonly<Record<string, string>>>>> = {
  FORBIDDEN: { self: ADMIN_LIST_STRINGS.self, last_admin: ADMIN_LIST_STRINGS.lastAdmin },
  CONFLICT: { already_admin: ADMIN_LIST_STRINGS.alreadyAdmin },
  UNPROCESSABLE: {
    account_not_active: ADMIN_LIST_STRINGS.accountNotActive,
    email_not_verified: ADMIN_LIST_STRINGS.emailNotVerified,
    mfa_not_enabled: ADMIN_LIST_STRINGS.mfaNotEnabled,
  },
};

/** The admin's message for a failed call; `notFound` words `NOT_FOUND`, which differs between the two actions. */
function messageOf(error: ApiError, notFound: string): string {
  const reason = error.details["reason"];
  const reasons = REASONS[error.code];
  if (reasons !== undefined && typeof reason === "string" && Object.hasOwn(reasons, reason)) {
    return reasons[reason] ?? errorMessage(error);
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return ADMIN_LIST_STRINGS.rateLimitedFor(error.retryAfterSeconds);
  }
  if (error.code === "NOT_FOUND") {
    return notFound;
  }
  if (error.code !== "VALIDATION_FAILED") {
    return errorMessage(error);
  }
  // The address is checked before the call, but the API's `EmailAddress` (`format: email`) has the last word: its
  // refusal is about what the admin typed, not an out-of-date form.
  return error.fieldErrors.some((field) => field.path === "/email")
    ? ADMIN_LIST_STRINGS.emailInvalid
    : ADMIN_LIST_STRINGS.formExpired;
}

/** The state after a failed call: sign-in for an ended session, a step-up request, or the failure. */
function failed(previous: AdminActionState, error: ApiError, notFound: string): AdminActionState {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: ADMINS_PATH }).toString()}`);
  }
  if (error.code === "REAUTH_REQUIRED") {
    return { ...previous, stepUp: true };
  }
  return { status: "failed", code: error.code, message: messageOf(error, notFound) };
}

/**
 * Grants platform admin rights to the account of the field `email`, with the field `reason` (`adminGrantAdmin`). The
 * account must be active, with a verified address and MFA on (`UNPROCESSABLE` by reason otherwise); no account with
 * the address answers `NOT_FOUND`, an admin already `CONFLICT` (`already_admin`).
 */
export async function grantAdmin(previous: AdminActionState, formData: FormData): Promise<AdminActionState> {
  const email = EMAIL.safeParse(text(formData, "email"));
  if (!email.success) {
    return invalid(ADMIN_LIST_STRINGS.emailInvalid);
  }
  const reason = text(formData, "reason");
  const problem = reasonProblem(reason);
  if (problem !== undefined) {
    return invalid(problem);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/admins", {
    body: { email: email.data, reason: reason.trim() },
  });
  if (result.error !== undefined) {
    return failed(previous, result.error, ADMIN_LIST_STRINGS.noAccount);
  }
  revalidatePath(ADMINS_PATH);
  revalidatePath(`/accounts/${result.data.accountId}`);
  return { status: "done", action: "grant", accountId: result.data.accountId, name: result.data.fullName };
}

/**
 * Revokes the platform admin rights of the account of the field `accountId` (`adminRevokeAdmin`); the field `name`
 * only words the outcome. Never the admin's own rights (`FORBIDDEN`, `self`) nor the last active admin's
 * (`last_admin`): the page does not offer them, and the API refuses them. An account that is no admin answers
 * `NOT_FOUND`.
 */
export async function revokeAdmin(previous: AdminActionState, formData: FormData): Promise<AdminActionState> {
  const accountId = text(formData, "accountId");
  const name = text(formData, "name").trim();
  // Counted in code points, as the document's `maxLength` of a name counts them.
  if (!ACCOUNT_ID.test(accountId) || name === "" || [...name].length > NAME_MAX_LENGTH) {
    return invalid(ADMIN_LIST_STRINGS.formExpired);
  }

  const api = await platformApi();
  const result = await api.DELETE("/v1/admin/admins/{accountId}", { params: { path: { accountId } } });
  if (result.error !== undefined) {
    return failed(previous, result.error, ADMIN_LIST_STRINGS.notAdmin);
  }
  revalidatePath(ADMINS_PATH);
  revalidatePath(`/accounts/${accountId}`);
  return { status: "done", action: "revoke", accountId, name };
}
