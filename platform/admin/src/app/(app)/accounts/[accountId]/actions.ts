"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { platformApi, type ApiError, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ACCOUNT_ACTION_STRINGS, REASON_MAX_LENGTH, REASON_MIN_LENGTH, REASON_STRINGS } from "@/lib/strings";

/**
 * The server actions of `/accounts/[accountId]` (README §2, §4; PADR-0006 items 4 and 5, PF-87). Each asks the API for
 * exactly what its operation requires:
 *
 * - `unlockAccount` (`adminUnlockAccount`): no reason, no step-up;
 * - `disableAccount` and `enableAccount` (`adminDisableAccount`, `adminEnableAccount`): a **reason**;
 * - `resetAccountMfa` (`adminResetAccountMfa`): a **reason** and a **step-up**: the API answers `REAUTH_REQUIRED`
 *   without a TOTP verification in the last 15 minutes, the action returns `stepUp: true`, and `useStepUpAction` asks
 *   for a code and runs it again with the same form data (the same reason).
 *
 * Each action checks its form before it calls the API (the account id by its pattern, the reason as `AdminReason`
 * counts it: 5 to 500 code points after trimming), so an action called with made-up fields sends nothing. An ended
 * session goes to `/sign-in` and back to the account. A success revalidates the account's page and the list, so they
 * show the account as it is now. The states carry only what the form shows, in the admin's own words: never the API's
 * message.
 */

type Schemas = components["schemas"];
type AdminAccount = Schemas["AdminAccount"];

/** The four actions of the page. */
export type AccountActionKind = "unlock" | "disable" | "enable" | "resetMfa";

/** What the form shows of the account after an action. */
export interface AccountOutcome {
  readonly status: Schemas["AccountStatus"];
  readonly mfaEnabled: boolean;
}

/** A refused action, in the admin's words. */
export interface AccountActionFailure {
  readonly status: "failed";
  /** The error code, for tests and the `data-code` of the notice; never shown. */
  readonly code: PlatformErrorCode;
  readonly message: string;
}

/** The state of one action form of the page. */
export type AccountActionState = { readonly stepUp?: true } & (
  | { readonly status: "idle" }
  | { readonly status: "done"; readonly action: AccountActionKind; readonly account: AccountOutcome }
  | AccountActionFailure
);

/** `AccountId` of the platform document. */
const ACCOUNT_ID = /^acc_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * What is wrong with `value` as an `AdminReason` (5–500 code points after trimming), or `undefined`: the rule of
 * `reasonProblem` in `ReasonDialog`, which a server module cannot import (it is a client module).
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

function invalid(message: string): AccountActionFailure {
  return { status: "failed", code: "VALIDATION_FAILED", message };
}

function accountPath(accountId: string): string {
  return `/accounts/${accountId}`;
}

/** `FORBIDDEN` and `CONFLICT` by their `details.reason`. */
const REASONS: Readonly<Partial<Record<PlatformErrorCode, Readonly<Record<string, string>>>>> = {
  FORBIDDEN: {
    self: ACCOUNT_ACTION_STRINGS.self,
    last_admin: ACCOUNT_ACTION_STRINGS.lastAdmin,
    platform_admin: ACCOUNT_ACTION_STRINGS.platformAdmin,
  },
  CONFLICT: {
    not_enabled: ACCOUNT_ACTION_STRINGS.notEnabled,
    not_disabled: ACCOUNT_ACTION_STRINGS.notDisabled,
    mfa_not_enabled: ACCOUNT_ACTION_STRINGS.mfaNotEnabled,
  },
};

/** Codes the actions word their own way; the others get the catalogue's message. */
const ACTION_CODES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  NOT_FOUND: ACCOUNT_ACTION_STRINGS.accountGone,
  // The fields are checked before the call, so the API refusing the request means the form is out of date.
  VALIDATION_FAILED: ACCOUNT_ACTION_STRINGS.formExpired,
};

/** The admin's message for a failed call. */
function messageOf(error: ApiError): string {
  const reason = error.details["reason"];
  const reasons = REASONS[error.code];
  if (reasons !== undefined && typeof reason === "string" && Object.hasOwn(reasons, reason)) {
    return reasons[reason] ?? errorMessage(error);
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return ACCOUNT_ACTION_STRINGS.rateLimitedFor(error.retryAfterSeconds);
  }
  return ACTION_CODES[error.code] ?? errorMessage(error);
}

/**
 * The state after an answer: sign-in (and back to the account) for an ended session, a step-up request for
 * `REAUTH_REQUIRED`, the failure in the admin's words, or the account as it is now (the pages revalidated).
 */
function settled(
  previous: AccountActionState,
  result: ApiResult<AdminAccount>,
  accountId: string,
  action: AccountActionKind,
): AccountActionState {
  if (result.error !== undefined) {
    const { error } = result;
    if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: accountPath(accountId) }).toString()}`);
    }
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    return { status: "failed", code: error.code, message: messageOf(error) };
  }
  revalidatePath(accountPath(accountId));
  revalidatePath("/accounts");
  return {
    status: "done",
    action,
    account: { status: result.data.status, mfaEnabled: result.data.mfaEnabled },
  };
}

/** The account id of the form, or `undefined` when it is not one. */
function accountIdOf(formData: FormData): string | undefined {
  const accountId = text(formData, "accountId");
  return ACCOUNT_ID.test(accountId) ? accountId : undefined;
}

/**
 * Clears the sign-in lockout of the account `accountId` (`adminUnlockAccount`): the failed sign-in count and
 * `locked_until`. No reason and no step-up; an account that is not locked keeps its state.
 */
export async function unlockAccount(
  previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const accountId = accountIdOf(formData);
  if (accountId === undefined) {
    return invalid(ACCOUNT_ACTION_STRINGS.formExpired);
  }
  const api = await platformApi();
  const result = await api.POST("/v1/admin/accounts/{accountId}/unlock", {
    params: { path: { accountId } },
  });
  return settled(previous, result, accountId, "unlock");
}

/** The account id and the trimmed reason of a **reason** action, or the failure of the form. */
function reasonForm(formData: FormData): { accountId: string; reason: string } | AccountActionFailure {
  const accountId = accountIdOf(formData);
  if (accountId === undefined) {
    return invalid(ACCOUNT_ACTION_STRINGS.formExpired);
  }
  const reason = text(formData, "reason");
  const problem = reasonProblem(reason);
  return problem === undefined ? { accountId, reason: reason.trim() } : invalid(problem);
}

/**
 * Disables the account `accountId` with `reason` (`adminDisableAccount`): it can no longer sign in anywhere and every
 * session ends. Never the admin's own account (`FORBIDDEN`, `self`) nor the last active platform admin
 * (`last_admin`); an account already disabled or deleted answers `CONFLICT` (`not_enabled`).
 */
export async function disableAccount(
  previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const form = reasonForm(formData);
  if ("status" in form) {
    return form;
  }
  const api = await platformApi();
  const result = await api.POST("/v1/admin/accounts/{accountId}/disable", {
    params: { path: { accountId: form.accountId } },
    body: { reason: form.reason },
  });
  return settled(previous, result, form.accountId, "disable");
}

/**
 * Enables the disabled account `accountId` with `reason` (`adminEnableAccount`); anything but a disabled account
 * answers `CONFLICT` (`not_disabled`).
 */
export async function enableAccount(
  previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const form = reasonForm(formData);
  if ("status" in form) {
    return form;
  }
  const api = await platformApi();
  const result = await api.POST("/v1/admin/accounts/{accountId}/enable", {
    params: { path: { accountId: form.accountId } },
    body: { reason: form.reason },
  });
  return settled(previous, result, form.accountId, "enable");
}

/**
 * Turns off the two-factor authentication of the account `accountId` after an identity check, with `reason` saying
 * how (`adminResetAccountMfa`, **step-up**): the secret is erased, the recovery codes deleted, every session ended and
 * the person e-mailed. A platform admin cannot be the target (`FORBIDDEN`, `platform_admin`); an account without MFA
 * answers `CONFLICT` (`mfa_not_enabled`).
 */
export async function resetAccountMfa(
  previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const form = reasonForm(formData);
  if ("status" in form) {
    return form;
  }
  const api = await platformApi();
  const result = await api.POST("/v1/admin/accounts/{accountId}/reset-mfa", {
    params: { path: { accountId: form.accountId } },
    body: { reason: form.reason },
  });
  return settled(previous, result, form.accountId, "resetMfa");
}
