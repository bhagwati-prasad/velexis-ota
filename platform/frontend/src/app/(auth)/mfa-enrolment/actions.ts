"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { MfaEnableState, MfaSetupState } from "@/app/(app)/account/security/actions";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { MALFORMED_ANSWER, pendingSetupOf, recoveryCodesOf, TOTP_CODE } from "@/lib/mfa-checks";
import { REQUESTED_PAGE_HEADER, safeNextPath } from "@/lib/session";
import { MFA_ENROLMENT_STRINGS, SECURITY_STRINGS } from "@/lib/strings";

/**
 * The server actions of `/mfa-enrolment` (PFE-030; PF-04 AC1 and AC4; PADR-0008, revision of 2026-11-05): the TOTP
 * set-up of the security page for an owner or admin of a live OTA without MFA, who may open no other page first.
 *
 * - `beginEnrolment` (`startMfaSetup`): the pending secret and its QR code, encoded here on the server (`lib/qr.ts`);
 *   the browser gets the code's geometry and the base32 secret, never the `otpauth://` URI.
 * - `confirmEnrolment` (`enableMfa`): turns MFA on with the typed code and answers the ten recovery codes, once.
 *
 * Both operations are `portal_unverified` ones, which the API's enrolment gate leaves open (PBE-071). Unlike the
 * security page's actions they revalidate nothing: rendering the page again would send an account that no longer needs
 * the enrolment on to `next` at once, before it has seen its recovery codes; the page's "Continue" leaves instead. The
 * answers' checks are the security page's, from the one module both import (`lib/mfa-checks.ts`, FIX-W46-PLATFORM): an
 * answer that is not the document's shows the general error and nothing of it. The secret, the QR code and the recovery
 * codes leave the server only in an action's answer (`Cache-Control: no-store`) and are never logged, stored, cached,
 * or put in a cookie or a URL.
 */

/**
 * Where an ended session signs in again: back to this page as it was asked for (the middleware's
 * `REQUESTED_PAGE_HEADER`, which keeps its `next`), and from there on to `next` once no enrolment is needed.
 */
async function signInAgain(): Promise<never> {
  const back = safeNextPath((await headers()).get(REQUESTED_PAGE_HEADER));
  redirect(back === undefined ? "/sign-in" : `/sign-in?${new URLSearchParams({ next: back }).toString()}`);
}

/** The answers of both actions that end the session. */
async function leaveOnSessionEnd(error: ApiError): Promise<void> {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    await signInAgain();
  }
}

const SETUP_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  MFA_ALREADY_ENABLED: SECURITY_STRINGS.mfaAlreadyEnabled,
  RATE_LIMITED: SECURITY_STRINGS.rateLimited,
};

/** The text field `name` of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Starts the TOTP set-up (`POST /v1/me/mfa/setup`): a pending secret that lives for 10 minutes and replaces an earlier
 * one. `MFA_ALREADY_ENABLED` (turned on in another tab) lets the page offer "Continue".
 */
export async function beginEnrolment(_previous: MfaSetupState, _formData: FormData): Promise<MfaSetupState> {
  const api = await platformApi();
  const result = await api.POST("/v1/me/mfa/setup");
  if (result.error !== undefined) {
    await leaveOnSessionEnd(result.error);
    return {
      status: "failed",
      code: result.error.code,
      message: SETUP_MESSAGES[result.error.code] ?? errorMessage(result.error),
    };
  }
  const setup = pendingSetupOf(result.data);
  if (setup === undefined) {
    return { status: "failed", code: MALFORMED_ANSWER.code, message: errorMessage(MALFORMED_ANSWER) };
  }
  return { status: "started", setup };
}

/**
 * Confirms the pending set-up with the form field `code` (`POST /v1/me/mfa/enable`) and turns MFA on. The answer's ten
 * recovery codes come back once, in the state; nothing is revalidated (see above).
 */
export async function confirmEnrolment(
  _previous: MfaEnableState,
  formData: FormData,
): Promise<MfaEnableState> {
  const parsed = TOTP_CODE.safeParse(text(formData, "code"));
  if (!parsed.success) {
    return { status: "failed", code: "VALIDATION_FAILED", fieldError: SECURITY_STRINGS.mfaCodeFormat };
  }
  const api = await platformApi();
  const result = await api.POST("/v1/me/mfa/enable", { body: { code: parsed.data } });
  if (result.error !== undefined) {
    await leaveOnSessionEnd(result.error);
    const { code } = result.error;
    if (code === "MFA_CODE_INVALID") {
      return { status: "failed", code, fieldError: SECURITY_STRINGS.mfaCodeInvalid };
    }
    if (code === "VALIDATION_FAILED") {
      return { status: "failed", code, fieldError: SECURITY_STRINGS.mfaCodeFormat };
    }
    if (code === "MFA_SETUP_EXPIRED") {
      return { status: "expired", code, message: SECURITY_STRINGS.mfaSetupExpired };
    }
    return {
      status: "failed",
      code,
      message: code === "RATE_LIMITED" ? SECURITY_STRINGS.mfaRateLimited : errorMessage(result.error),
    };
  }
  const recoveryCodes = recoveryCodesOf(result.data.recoveryCodes);
  if (recoveryCodes === undefined) {
    // MFA is on, so the general "try again" would mislead: the page says to replace the codes on the security page.
    return {
      status: "enabled",
      code: MALFORMED_ANSWER.code,
      message: MFA_ENROLMENT_STRINGS.codesUnavailable,
    };
  }
  return { status: "enabled", recoveryCodes };
}
