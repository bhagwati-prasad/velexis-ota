"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { adjustmentDecimals, amountProblem } from "@/app/(app)/settlements/[settlementId]/adjustment-amount";
import { platformApi, type ApiError, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  REASON_STRINGS,
  SETTLEMENT_ACTION_STRINGS as A,
} from "@/lib/strings";

/**
 * The server actions of `/settlements/[settlementId]` (README §2, §4; flows/platform-admin-operations.md "Sequence:
 * settlement review and payout", PADR-0003 items 5 to 11, PF-91). Each sends exactly what its operation of the platform
 * document requires:
 *
 * - `addSettlementAdjustment` (`adminAddSettlementAdjustment`, **reason**): a signed amount in the statement's currency
 *   with no more decimals than the currency has minor units (checked here before the call; the API's `422
 *   UNPROCESSABLE` `amount_precision` lands at the same field), the line's description and the trimmed reason;
 * - `approveSettlement` (`adminApproveSettlement`, **step-up**, `If-Match`);
 * - `markSettlementPaid` (`adminMarkSettlementPaid`, **step-up**, `If-Match`): the transfer date and the bank reference;
 * - `voidSettlement` (`adminVoidSettlement`, **reason**).
 *
 * A step-up operation answers `REAUTH_REQUIRED` without a TOTP verification in the last 15 minutes: the action returns
 * `stepUp: true`, and `useStepUpAction` asks for a code and runs it again with the same form data. Each action checks
 * its form first (the statement id and version by their patterns, the reason as `AdminReason` counts it: 5 to 500 code
 * points after trimming), so made-up fields send nothing. A success revalidates the statement's page and the list, so
 * the totals, lines and buttons follow the new status. An ended session goes to `/sign-in` and back to the statement.
 * The states carry only what the forms show, in the admin's own words: never the API's message.
 */

type Schemas = components["schemas"];
type AdminSettlement = Schemas["AdminSettlement"];

/** The four actions of the page. */
export type SettlementActionKind = "adjust" | "approve" | "markPaid" | "void";

/** The fields of the forms that can show a problem. */
export type SettlementField = "amount" | "description" | "reason" | "paidOn" | "payoutReference";

/** What the forms show of the statement after an action. */
export interface SettlementOutcome {
  readonly status: Schemas["AdminSettlementStatus"];
  readonly version: number;
  readonly netAmount: Schemas["Money"];
}

/** A refused action, in the admin's words. */
export interface SettlementActionFailure {
  readonly status: "failed";
  /** The error code, for tests and the `data-code` of the notice; never shown. */
  readonly code: PlatformErrorCode;
  /** A problem that belongs to no field (stale version, wrong status, rate limit, API unavailable). */
  readonly message?: string;
  readonly fieldErrors: Readonly<Partial<Record<SettlementField, string>>>;
}

/** The state of one action form of the page. */
export type SettlementActionState = { readonly stepUp?: true } & (
  | { readonly status: "idle" }
  | { readonly status: "done"; readonly action: SettlementActionKind; readonly settlement: SettlementOutcome }
  | SettlementActionFailure
);

/** `SettlementId` of the platform document. */
const SETTLEMENT_ID = /^stl_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A statement version, as the page renders it into the form. */
const VERSION = /^[1-9][0-9]{0,9}$/;
/** `CurrencyCode`. */
const CURRENCY = /^[A-Z]{3}$/;
/** A calendar day of a date field. */
const DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

const DESCRIPTION_MAX = 500;
const REFERENCE_MAX = 200;

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The length of `value` as JSON Schema counts it (code points). */
function codePoints(value: string): number {
  return [...value].length;
}

/**
 * What is wrong with `value` as an `AdminReason` (5–500 code points after trimming), or `undefined`: the rule of
 * `reasonProblem` in `ReasonDialog`, which a server module cannot import (it is a client module).
 */
function reasonProblem(value: string): string | undefined {
  const length = codePoints(value.trim());
  if (length === 0) {
    return REASON_STRINGS.required;
  }
  if (length < REASON_MIN_LENGTH) {
    return REASON_STRINGS.tooShort;
  }
  return length > REASON_MAX_LENGTH ? REASON_STRINGS.tooLong : undefined;
}

function invalid(
  fieldErrors: Partial<Record<SettlementField, string>>,
  message?: string,
): SettlementActionFailure {
  return {
    status: "failed",
    code: "VALIDATION_FAILED",
    fieldErrors,
    ...(message === undefined ? {} : { message }),
  };
}

function expired(): SettlementActionFailure {
  return invalid({}, A.formExpired);
}

/** The message of an amount the API would refuse, or `undefined`. */
function amountMessage(typed: string, currency: string): string | undefined {
  const problem = amountProblem(typed, currency);
  switch (problem?.kind) {
    case undefined:
      return undefined;
    case "required":
      return A.amountRequired;
    case "format":
      return A.amountFormat;
    case "zero":
      return A.amountZero;
    case "decimals":
      return A.amountDecimals(currency, problem.decimals);
  }
}

function settlementPath(settlementId: string): string {
  return `/settlements/${settlementId}`;
}

/** Codes the actions word their own way; the others get the catalogue's message. */
const ACTION_CODES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  PRECONDITION_FAILED: A.stale,
  PAYOUT_ACCOUNT_REQUIRED: A.payoutRequired,
  NOT_FOUND: A.statementGone,
  // The fields are checked before the call, so the API refusing the request means the form is out of date.
  VALIDATION_FAILED: A.formExpired,
};

/** The form fields of the API's field errors (`path` is a JSON pointer into the request body). */
function apiFieldErrors(error: ApiError): Partial<Record<SettlementField, string>> {
  const fieldErrors: Partial<Record<SettlementField, string>> = {};
  for (const { path, code } of error.fieldErrors) {
    if (path === "/amount/amount" || path === "/amount") {
      fieldErrors.amount ??= A.amountFormat;
    } else if (path === "/description") {
      fieldErrors.description ??= code === "maxLength" ? A.descriptionTooLong : A.descriptionRequired;
    } else if (path === "/reason") {
      fieldErrors.reason ??= code === "maxLength" ? REASON_STRINGS.tooLong : REASON_STRINGS.tooShort;
    } else if (path === "/paidAt") {
      fieldErrors.paidOn ??= code === "future" ? A.paidOnFuture : A.paidOnInvalid;
    } else if (path === "/payoutReference") {
      fieldErrors.payoutReference ??= code === "maxLength" ? A.referenceTooLong : A.referenceRequired;
    }
  }
  return fieldErrors;
}

/** The admin's message for a refused call that belongs to no field. */
function messageOf(error: ApiError, action: SettlementActionKind): string {
  if (error.code === "SETTLEMENT_STATE_INVALID") {
    if (error.details["reason"] === "carry_forward_changed") {
      return A.carryForwardChanged;
    }
    return action === "markPaid" ? A.notApproved : A.notDraft;
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return A.rateLimitedFor(error.retryAfterSeconds);
  }
  return ACTION_CODES[error.code] ?? errorMessage(error);
}

/**
 * The state after an answer: sign-in (and back to the statement) for an ended session, a step-up request for
 * `REAUTH_REQUIRED`, the failure in the admin's words (at its field when it has one), or the statement as it is now
 * (the pages revalidated).
 */
function settled(
  previous: SettlementActionState,
  result: ApiResult<AdminSettlement>,
  settlementId: string,
  action: SettlementActionKind,
  fieldsOf: (error: ApiError) => Partial<Record<SettlementField, string>> = apiFieldErrors,
): SettlementActionState {
  if (result.error !== undefined) {
    const { error } = result;
    if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: settlementPath(settlementId) }).toString()}`);
    }
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    const fieldErrors = fieldsOf(error);
    return Object.keys(fieldErrors).length > 0
      ? { status: "failed", code: error.code, fieldErrors }
      : { status: "failed", code: error.code, fieldErrors: {}, message: messageOf(error, action) };
  }
  revalidatePath(settlementPath(settlementId));
  revalidatePath("/settlements");
  const { status, version, netAmount } = result.data;
  return { status: "done", action, settlement: { status, version, netAmount } };
}

/** The statement id of the form, or `undefined` when it is not one. */
function settlementIdOf(formData: FormData): string | undefined {
  const settlementId = text(formData, "settlementId");
  return SETTLEMENT_ID.test(settlementId) ? settlementId : undefined;
}

/** The statement id and the `If-Match` value of a versioned action, or `undefined`. */
function versionedForm(formData: FormData): { settlementId: string; ifMatch: string } | undefined {
  const settlementId = settlementIdOf(formData);
  const version = text(formData, "version");
  return settlementId === undefined || !VERSION.test(version)
    ? undefined
    : { settlementId, ifMatch: `"${version}"` };
}

/**
 * Adds a manual `adjustment` line to the draft `settlementId` (`adminAddSettlementAdjustment`, **reason**): the field
 * `amount` (signed: positive is owed to the OTA) in the statement's currency (`currency`, which the page renders into
 * the form), the field `description` (the line's text, which the OTA sees) and the field `reason` (kept in the audit
 * row). The amount is checked as the API checks it, its decimals against the currency's minor units included; the API
 * recomputes the totals and answers the draft with its new version.
 */
export async function addSettlementAdjustment(
  previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const settlementId = settlementIdOf(formData);
  const currency = text(formData, "currency");
  if (settlementId === undefined || !CURRENCY.test(currency)) {
    return expired();
  }
  const amount = text(formData, "amount").trim();
  const description = text(formData, "description").trim();
  const reason = text(formData, "reason");
  const fieldErrors: Partial<Record<SettlementField, string>> = {};
  const amountError = amountMessage(amount, currency);
  if (amountError !== undefined) {
    fieldErrors.amount = amountError;
  }
  if (description === "") {
    fieldErrors.description = A.descriptionRequired;
  } else if (codePoints(description) > DESCRIPTION_MAX) {
    fieldErrors.description = A.descriptionTooLong;
  }
  const reasonError = reasonProblem(reason);
  if (reasonError !== undefined) {
    fieldErrors.reason = reasonError;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return invalid(fieldErrors);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/settlements/{settlementId}/adjustments", {
    params: { path: { settlementId } },
    body: { amount: { amount, currency }, description, reason: reason.trim() },
  });
  return settled(previous, result, settlementId, "adjust", (error) => {
    // `422 UNPROCESSABLE` `amount_precision` (FIX-W37-PLATFORM): the amount has more decimals than the currency's minor
    // units; its message names the currency and its exponent as the API answered them.
    if (error.code === "UNPROCESSABLE" && error.details["reason"] === "amount_precision") {
      const answered = error.details["decimals"];
      const decimals =
        typeof answered === "number" && Number.isInteger(answered) && answered >= 0
          ? Math.min(answered, adjustmentDecimals(currency))
          : adjustmentDecimals(currency);
      return { amount: A.amountDecimals(currency, decimals) };
    }
    if (
      error.code === "VALIDATION_FAILED" &&
      error.fieldErrors.some((field) => field.path === "/amount/currency")
    ) {
      return {};
    }
    return apiFieldErrors(error);
  });
}

/**
 * Approves the draft `settlementId` (`adminApproveSettlement`, **step-up**) with the version the page was rendered
 * with in `If-Match`: a positive net becomes `approved` (it needs a verified payout account, `422
 * PAYOUT_ACCOUNT_REQUIRED`), a net of zero or less `carried_forward`. A stale version answers `412`, and a draft whose
 * carried balance changed since it was generated `409` `carry_forward_changed`.
 */
export async function approveSettlement(
  previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const form = versionedForm(formData);
  if (form === undefined) {
    return expired();
  }
  const api = await platformApi();
  const result = await api.POST("/v1/admin/settlements/{settlementId}/approve", {
    params: { path: { settlementId: form.settlementId }, header: { "If-Match": form.ifMatch } },
  });
  return settled(previous, result, form.settlementId, "approve");
}

/**
 * Records the bank transfer of the approved statement `settlementId` (`adminMarkSettlementPaid`, **step-up**,
 * `If-Match`): the field `paidOn` (the transfer's calendar day, sent as its first instant in UTC and not in the future)
 * and the field `payoutReference` (trimmed, 1–200 characters). The OTA's owners and finance members are e-mailed.
 */
export async function markSettlementPaid(
  previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const form = versionedForm(formData);
  if (form === undefined) {
    return expired();
  }
  const paidOn = text(formData, "paidOn").trim();
  const payoutReference = text(formData, "payoutReference").trim();
  const fieldErrors: Partial<Record<SettlementField, string>> = {};
  const day = DAY.exec(paidOn);
  if (paidOn === "") {
    fieldErrors.paidOn = A.paidOnRequired;
  } else if (day === null) {
    fieldErrors.paidOn = A.paidOnInvalid;
  } else {
    const instant = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    if (new Date(instant).toISOString().slice(0, 10) !== paidOn) {
      fieldErrors.paidOn = A.paidOnInvalid;
    } else if (instant > Date.now()) {
      fieldErrors.paidOn = A.paidOnFuture;
    }
  }
  if (payoutReference === "") {
    fieldErrors.payoutReference = A.referenceRequired;
  } else if (codePoints(payoutReference) > REFERENCE_MAX) {
    fieldErrors.payoutReference = A.referenceTooLong;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return invalid(fieldErrors);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/settlements/{settlementId}/mark-paid", {
    params: { path: { settlementId: form.settlementId }, header: { "If-Match": form.ifMatch } },
    body: { paidAt: `${paidOn}T00:00:00Z`, payoutReference },
  });
  return settled(previous, result, form.settlementId, "markPaid");
}

/**
 * Voids the draft `settlementId` with the field `reason` (`adminVoidSettlement`, **reason**): it keeps its totals for
 * the record and loses its lines, so a new draft can settle them again.
 */
export async function voidSettlement(
  previous: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const settlementId = settlementIdOf(formData);
  if (settlementId === undefined) {
    return expired();
  }
  const reason = text(formData, "reason");
  const reasonError = reasonProblem(reason);
  if (reasonError !== undefined) {
    return invalid({ reason: reasonError }, reasonError);
  }
  const api = await platformApi();
  const result = await api.POST("/v1/admin/settlements/{settlementId}/void", {
    params: { path: { settlementId } },
    body: { reason: reason.trim() },
  });
  return settled(previous, result, settlementId, "void");
}
