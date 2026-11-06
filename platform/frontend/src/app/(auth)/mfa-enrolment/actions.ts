"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import type { MfaEnableState, MfaSetupState } from "@/app/(app)/account/security/actions";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { qrCode, QR_MAX_TEXT_LENGTH } from "@/lib/qr";
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
 * answers' checks are the security page's (`account/security/actions.ts`): an answer that is not the document's shows
 * the general error and nothing of it. The secret, the QR code and the recovery codes leave the server only in an
 * action's answer (`Cache-Control: no-store`) and are never logged, stored, cached, or put in a cookie or a URL.
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

/** `MfaSetup.secret` and `otpauthUrl` of the platform document (as the security page checks them). */
const TOTP_SECRET = /^[A-Z2-7]+=*$/;
const OTPAUTH_URL = /^otpauth:\/\/totp\//;

/** `TotpCode` of the platform document; spaces a person typed are dropped. */
const TOTP_CODE = z
  .string()
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().regex(/^[0-9]{6}$/));

/** One recovery code as `RecoveryCodes` answers it: four groups of four Crockford base32 characters. */
const RECOVERY_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
const RECOVERY_CODE_COUNT = 10;

/** The recovery codes of an answer, or `undefined` when the answer is not the document's `RecoveryCodes`. */
function recoveryCodesOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length !== RECOVERY_CODE_COUNT) {
    return undefined;
  }
  const codes = value.filter((code): code is string => typeof code === "string" && RECOVERY_CODE.test(code));
  return codes.length === RECOVERY_CODE_COUNT ? Object.freeze(codes) : undefined;
}

/** A failure of an answer that is not what the document describes; nothing of it is shown. */
const MALFORMED: ApiError = Object.freeze({
  code: "INTERNAL_ERROR",
  status: 500,
  fieldErrors: Object.freeze([]),
  details: Object.freeze({}),
});

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
  const { secret, otpauthUrl, expiresIn } = result.data;
  if (
    !TOTP_SECRET.test(secret) ||
    !OTPAUTH_URL.test(otpauthUrl) ||
    otpauthUrl.length > QR_MAX_TEXT_LENGTH ||
    !Number.isInteger(expiresIn) ||
    expiresIn < 1
  ) {
    return { status: "failed", code: MALFORMED.code, message: errorMessage(MALFORMED) };
  }
  return { status: "started", setup: { secret, qr: qrCode(otpauthUrl), expiresIn } };
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
    return { status: "enabled", code: MALFORMED.code, message: MFA_ENROLMENT_STRINGS.codesUnavailable };
  }
  return { status: "enabled", recoveryCodes };
}
