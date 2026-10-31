"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  PAYOUT_ACCOUNT_STRINGS as P,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  REASON_STRINGS,
} from "@/lib/strings";

/**
 * The server actions of the payout account on `/tenants/[tenantId]` (README §2 and §4, PADR-0003 item 10, PADR-0006,
 * scope PF-64 AC2, PF-91), each sending exactly what its operation of the platform document requires:
 *
 * - `loadPayoutAccount` (`adminGetPayoutAccount`): the account masked, as the portal shows it, with its version. The
 *   panel asks for it when it is shown (the connections tab), so the tenant page itself stays one `adminGetTenant` call;
 * - `revealPayoutAccount` (`adminRevealPayoutAccount`, **reason** and **step-up**): the full bank identifiers, answered
 *   to the panel only, which shows them in `RevealPanel` for 60 seconds from React state. They are never logged, stored,
 *   put in a URL or a message; the API writes the audit row `payout_account.revealed` with the reason;
 * - `reviewPayoutAccount` (`adminReviewPayoutAccount`, `If-Match`): `verified`, or `rejected` with a note for the owner.
 *
 * `REAUTH_REQUIRED` returns `stepUp: true`, and `useStepUpAction` asks for a TOTP code and runs the action again with
 * the same form data (the same reason). Each action checks its form first (the tenant id and version by their patterns,
 * the reason as `AdminReason` counts it, the note's 1–1000 characters after trimming), so made-up fields send nothing.
 * An ended session goes to `/sign-in` and back to the OTA's connections tab. Refusals are worded for the admin, never
 * with the API's text.
 */

type Schemas = components["schemas"];

/** What the panel shows of a payout account: the masked fields of `PayoutAccount`, never a bank identifier. */
export interface PayoutAccountView {
  readonly accountHolderName: string;
  readonly countryCode: string;
  readonly currency: string;
  readonly scheme: Schemas["PayoutScheme"];
  readonly last4: string;
  readonly status: Schemas["PayoutAccountStatus"];
  readonly reviewNote: string | null;
  readonly updatedAt: string;
  readonly version: number;
}

/** The answer of `loadPayoutAccount`. */
export type PayoutLoadState =
  | { readonly status: "loaded"; readonly account: PayoutAccountView }
  | { readonly status: "none" }
  | { readonly status: "failed"; readonly code: PlatformErrorCode; readonly message: string };

/** One revealed bank identifier, labelled for `RevealPanel`. */
export interface RevealedDetail {
  readonly label: string;
  readonly value: string;
}

/** The state of the reveal. */
export type RevealState = { readonly stepUp?: true } & (
  | { readonly status: "idle" }
  | { readonly status: "revealed"; readonly fields: readonly RevealedDetail[] }
  | { readonly status: "failed"; readonly code: PlatformErrorCode; readonly message: string }
);

/** The state of the review (verify or reject). */
export type ReviewState = { readonly stepUp?: true } & (
  | { readonly status: "idle" }
  | {
      readonly status: "done";
      readonly decision: "verified" | "rejected";
      readonly account: PayoutAccountView;
    }
  | {
      readonly status: "failed";
      readonly code: PlatformErrorCode;
      /** A problem with the rejection note, shown at its field. */
      readonly noteError?: string;
      /** Any other problem, shown below the actions. */
      readonly message?: string;
    }
);

/** `TenantId` of the platform document. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;
/** An account version, as the panel renders it into the form. */
const VERSION = /^[1-9][0-9]{0,9}$/;

const NOTE_MAX = 1000;

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

/** The page of the payout account: the OTA's connections tab. */
function payoutPath(tenantId: string): string {
  return `/tenants/${tenantId}?tab=connections`;
}

/** Sends an ended session to `/sign-in`, back to the OTA's connections tab afterwards. */
function signInIfEnded(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: payoutPath(tenantId) }).toString()}`);
  }
}

/** Codes the actions word their own way; the others get the catalogue's message. */
const ACTION_CODES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  PRECONDITION_FAILED: P.stale,
  NOT_FOUND: P.gone,
  // The fields are checked before the call, so the API refusing the request means the form is out of date.
  VALIDATION_FAILED: P.formExpired,
};

/** The admin's message for a refused call. */
function messageOf(error: ApiError): string {
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return P.rateLimitedFor(error.retryAfterSeconds);
  }
  return ACTION_CODES[error.code] ?? errorMessage(error);
}

/** The masked fields of an answer; nothing else of it reaches the browser. */
function viewOf(account: Schemas["PayoutAccount"]): PayoutAccountView {
  return {
    accountHolderName: account.accountHolderName,
    countryCode: account.countryCode,
    currency: account.currency,
    scheme: account.scheme,
    last4: account.last4,
    status: account.status,
    reviewNote: account.reviewNote,
    updatedAt: account.updatedAt,
    version: account.version,
  };
}

/** An IBAN in groups of four characters, as banks print it, so it reads off the screen without mistakes. */
function grouped(iban: string): string {
  return iban.replace(/(.{4})(?=.)/g, "$1 ");
}

/** The labelled identifiers of a reveal answer (an IBAN account, or a local one); any other shape gives none. */
function revealedFields(answer: unknown): RevealedDetail[] | undefined {
  if (typeof answer !== "object" || answer === null) {
    return undefined;
  }
  const { iban, bic, accountNumber, routingNumber } = answer as Record<string, unknown>;
  if (typeof iban === "string" && iban !== "") {
    return [
      { label: P.iban, value: grouped(iban) },
      ...(typeof bic === "string" && bic !== "" ? [{ label: P.bic, value: bic }] : []),
    ];
  }
  if (typeof accountNumber === "string" && accountNumber !== "" && typeof routingNumber === "string") {
    return [
      { label: P.accountNumber, value: accountNumber },
      { label: P.routingNumber, value: routingNumber },
    ];
  }
  return undefined;
}

/**
 * The OTA's payout account, masked (`adminGetPayoutAccount`): `none` when the OTA has not entered one (`404`), the
 * failure in the admin's words otherwise. Called by the panel when it is shown.
 */
export async function loadPayoutAccount(tenantId: string): Promise<PayoutLoadState> {
  if (!TENANT_ID.test(tenantId)) {
    return { status: "failed", code: "VALIDATION_FAILED", message: P.formExpired };
  }
  const api = await platformApi();
  const result = await api.GET("/v1/admin/tenants/{tenantId}/payout-account", {
    params: { path: { tenantId } },
  });
  if (result.error !== undefined) {
    signInIfEnded(result.error, tenantId);
    if (result.error.code === "NOT_FOUND") {
      return { status: "none" };
    }
    return { status: "failed", code: result.error.code, message: errorMessage(result.error) };
  }
  return { status: "loaded", account: viewOf(result.data) };
}

/**
 * Reveals the bank identifiers of the OTA `tenantId` with the field `reason` (`adminRevealPayoutAccount`, **reason**
 * and **step-up**). The answer goes to the panel only, in memory, for `RevealPanel`; a refusal or a step-up request
 * carries no identifiers, not even those of an earlier reveal.
 */
export async function revealPayoutAccount(_previous: RevealState, formData: FormData): Promise<RevealState> {
  const tenantId = text(formData, "tenantId");
  if (!TENANT_ID.test(tenantId)) {
    return { status: "failed", code: "VALIDATION_FAILED", message: P.formExpired };
  }
  const reason = text(formData, "reason");
  const problem = reasonProblem(reason);
  if (problem !== undefined) {
    return { status: "failed", code: "VALIDATION_FAILED", message: problem };
  }
  const api = await platformApi();
  const result = await api.POST("/v1/admin/tenants/{tenantId}/payout-account/reveal", {
    params: { path: { tenantId } },
    body: { reason: reason.trim() },
  });
  if (result.error !== undefined) {
    signInIfEnded(result.error, tenantId);
    if (result.error.code === "REAUTH_REQUIRED") {
      // Not `{ ...previous, stepUp: true }` as the other actions answer: a step-up request carries no earlier reveal,
      // so details revealed before are dropped now (the panel hides them during the step-up anyway) and are not kept
      // in memory when the admin cancels the dialog, after which no `RevealPanel` would count their 60 seconds.
      return { status: "idle", stepUp: true };
    }
    return { status: "failed", code: result.error.code, message: messageOf(result.error) };
  }
  const fields = revealedFields(result.data);
  return fields === undefined
    ? { status: "failed", code: "INTERNAL_ERROR", message: errorMessage("INTERNAL_ERROR") }
    : { status: "revealed", fields };
}

/**
 * Records the review of the OTA's payout account (`adminReviewPayoutAccount`): the field `decision` (`verified`, or
 * `rejected` with the field `note`, 1–1000 characters after trimming, which the owner sees), with the version the
 * panel shows in `If-Match` (the hidden field `version`): an account the owner changed meanwhile answers `412`. The
 * answer is the reviewed account, masked; the owners are e-mailed.
 */
export async function reviewPayoutAccount(previous: ReviewState, formData: FormData): Promise<ReviewState> {
  const tenantId = text(formData, "tenantId");
  const version = text(formData, "version");
  const decision = text(formData, "decision");
  if (
    !TENANT_ID.test(tenantId) ||
    !VERSION.test(version) ||
    (decision !== "verified" && decision !== "rejected")
  ) {
    return { status: "failed", code: "VALIDATION_FAILED", message: P.formExpired };
  }
  const note = text(formData, "note").trim();
  if (decision === "rejected") {
    if (note === "") {
      return { status: "failed", code: "VALIDATION_FAILED", noteError: P.noteRequired };
    }
    if (codePoints(note) > NOTE_MAX) {
      return { status: "failed", code: "VALIDATION_FAILED", noteError: P.noteTooLong };
    }
  }
  const api = await platformApi();
  const result = await api.POST("/v1/admin/tenants/{tenantId}/payout-account/review", {
    params: { path: { tenantId }, header: { "If-Match": `"${version}"` } },
    body: decision === "verified" ? { decision } : { decision, note },
  });
  if (result.error !== undefined) {
    const { error } = result;
    signInIfEnded(error, tenantId);
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    if (error.code === "VALIDATION_FAILED" && error.fieldErrors.some((field) => field.path === "/note")) {
      return { status: "failed", code: error.code, noteError: P.noteRequired };
    }
    return { status: "failed", code: error.code, message: messageOf(error) };
  }
  revalidatePath(`/tenants/${tenantId}`);
  return { status: "done", decision, account: viewOf(result.data) };
}
