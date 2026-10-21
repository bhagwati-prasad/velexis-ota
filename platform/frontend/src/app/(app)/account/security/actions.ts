"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { qrCode, QR_MAX_TEXT_LENGTH, type QrCode } from "@/lib/qr";
import {
  MFA_CHALLENGE_COOKIE,
  NEXT_PATH_COOKIE,
  clearedCookie,
  clearedSessionCookies,
  writeCookies,
} from "@/lib/session";
import { ERROR_MESSAGES, SECURITY_STRINGS, SIGN_UP_STRINGS } from "@/lib/strings";

/**
 * The server actions of `/account/security` (README §2 `/account/security` and §5; PF-04, PF-06; PADR-0008):
 *
 * - `changeAccountPassword` (`changePassword`): the current and a new password; the API signs out every other
 *   session of the account.
 * - `beginMfaSetup` (`startMfaSetup`) and `confirmMfaSetup` (`enableMfa`): the pending TOTP secret with its QR code,
 *   encoded here on the server (`lib/qr.ts`), then the ten recovery codes, answered once [PF-04 AC1].
 * - `turnOffMfa` (`disableMfa`) and `replaceRecoveryCodes` (`regenerateRecoveryCodes`): both need a TOTP step-up
 *   within 15 minutes; without one they answer `stepUp`, and `useStepUpAction` sends the same submission again after
 *   the code [PF-04 AC3].
 * - `revokeAccountSession` (`revokeSession`) and `signOutEverywhere` (`signOutEverywhere`) [PF-06].
 *
 * The TOTP secret, the recovery codes and the passwords leave the server only in an action's answer (which Next.js
 * sends with `Cache-Control: no-store`) and are never logged, stored, cached, or put in a cookie or a URL; the page
 * never reads them, so a reload never shows them again. Messages are the portal's own text, never the API's.
 */

/** Where an ended session signs in again and comes back to. */
const SIGN_IN_AND_BACK = `/sign-in?${new URLSearchParams({ next: "/account/security" }).toString()}`;

/** The page, rendered again after a change: the two-factor state and the sessions list follow it. */
const SECURITY_PATH = "/account/security";

/**
 * The answers of every action that end the session (sign in again and come back) or need a verified address (the
 * `portal` scope of changePassword, disableMfa and regenerateRecoveryCodes).
 */
function leaveOnSessionEnd(error: ApiError): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(SIGN_IN_AND_BACK);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The length of a password as the API counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

// ---- Password ---------------------------------------------------------------------------------------------------

/** The fields of the password form. */
export type PasswordField = "currentPassword" | "newPassword";

/** What the password form shows after a submission. It never holds a password. */
export interface PasswordState {
  readonly status: "idle" | "changed" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  readonly fieldErrors: Readonly<Partial<Record<PasswordField, string>>>;
  /** A problem that belongs to no field. */
  readonly message?: string;
}

/** The password rules of PF-01 AC2 the portal can check itself; the breached list is the API's. */
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 256;

const PASSWORD_FORM = z.object({
  currentPassword: z
    .string()
    .min(1, SECURITY_STRINGS.currentPasswordRequired)
    .refine((value) => codePoints(value) <= PASSWORD_MAX, SECURITY_STRINGS.currentPasswordTooLong),
  newPassword: z
    .string()
    .refine((value) => codePoints(value) >= PASSWORD_MIN, SIGN_UP_STRINGS.passwordTooShort)
    .refine((value) => codePoints(value) <= PASSWORD_MAX, SIGN_UP_STRINGS.passwordTooLong),
});

/** The message at the new-password field for the API's field error `code` on `/newPassword`. */
function newPasswordMessage(code: string | undefined): string {
  if (code === "too_short" || code === "minLength") {
    return SIGN_UP_STRINGS.passwordTooShort;
  }
  if (code === "breached") {
    return SIGN_UP_STRINGS.passwordBreached;
  }
  if (code === "maxLength") {
    return SIGN_UP_STRINGS.passwordTooLong;
  }
  return ERROR_MESSAGES.PASSWORD_TOO_WEAK;
}

/** The field error code of `error` at `pointer`, if any. */
function fieldErrorAt(error: ApiError, pointer: string): string | undefined {
  return error.fieldErrors.find((fieldError) => fieldError.path === pointer)?.code;
}

/** The form's problems of a refused `changePassword`. */
function passwordProblems(error: ApiError): Pick<PasswordState, "fieldErrors" | "message"> {
  if (error.code === "CURRENT_PASSWORD_INCORRECT") {
    return { fieldErrors: { currentPassword: SECURITY_STRINGS.currentPasswordIncorrect } };
  }
  if (error.code === "PASSWORD_TOO_WEAK") {
    return { fieldErrors: { newPassword: newPasswordMessage(fieldErrorAt(error, "/newPassword")) } };
  }
  if (error.code === "VALIDATION_FAILED") {
    const fieldErrors: Partial<Record<PasswordField, string>> = {};
    if (fieldErrorAt(error, "/currentPassword") !== undefined) {
      fieldErrors.currentPassword = SECURITY_STRINGS.currentPasswordTooLong;
    }
    const newPassword = fieldErrorAt(error, "/newPassword");
    if (newPassword !== undefined) {
      fieldErrors.newPassword = newPasswordMessage(newPassword);
    }
    return Object.keys(fieldErrors).length > 0
      ? { fieldErrors }
      : { fieldErrors, message: ERROR_MESSAGES.VALIDATION_FAILED };
  }
  return {
    fieldErrors: {},
    message: error.code === "RATE_LIMITED" ? SECURITY_STRINGS.passwordRateLimited : errorMessage(error),
  };
}

/**
 * Changes the password from the form fields `currentPassword` and `newPassword` (`POST /v1/me/password`). The API
 * revokes every other session of the account and the OTA admin sessions too (`staffdeny:acct`); this browser's session
 * stays, so the page is rendered again with the shorter sessions list. Neither password is returned, logged or kept.
 */
export async function changeAccountPassword(
  _previous: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const parsed = PASSWORD_FORM.safeParse({
    currentPassword: text(formData, "currentPassword"),
    newPassword: text(formData, "newPassword"),
  });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<PasswordField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if ((field === "currentPassword" || field === "newPassword") && fieldErrors[field] === undefined) {
        fieldErrors[field] = issue.message;
      }
    }
    return { status: "failed", code: "VALIDATION_FAILED", fieldErrors };
  }
  const api = await platformApi();
  const result = await api.POST("/v1/me/password", { body: parsed.data });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error);
    return { status: "failed", code: result.error.code, ...passwordProblems(result.error) };
  }
  revalidatePath(SECURITY_PATH);
  return { status: "changed", fieldErrors: {} };
}

// ---- Two-factor set-up ------------------------------------------------------------------------------------------

/** A pending TOTP set-up: the base32 secret, its QR code and the seconds until it expires. Shown once. */
export interface PendingMfaSetup {
  readonly secret: string;
  readonly qr: QrCode;
  readonly expiresIn: number;
}

/** What "Set up two-factor authentication" answers. */
export interface MfaSetupState {
  readonly status: "idle" | "started" | "failed";
  readonly code?: PlatformErrorCode;
  readonly message?: string;
  /** The pending set-up: in this state (React state in the browser) and nowhere else. */
  readonly setup?: PendingMfaSetup;
}

/** What confirming the set-up answers. */
export interface MfaEnableState {
  /** `expired`: the pending set-up is gone (10 minutes passed, or another set-up replaced it); start again. */
  readonly status: "idle" | "enabled" | "failed" | "expired";
  readonly code?: PlatformErrorCode;
  /** A problem with the typed code: shown at the field. */
  readonly fieldError?: string;
  /** A problem that belongs to no field. */
  readonly message?: string;
  /** The ten recovery codes, shown once. */
  readonly recoveryCodes?: readonly string[];
}

/** `MfaSetup.secret` and `otpauthUrl` of the platform document. */
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

/**
 * Starts the TOTP set-up (`POST /v1/me/mfa/setup`): a pending secret that lives for 10 minutes and replaces an earlier
 * one. The `otpauth://` URI becomes a QR code here, on the server; the browser gets the code's geometry and the base32
 * secret for manual entry, never the URI.
 */
export async function beginMfaSetup(_previous: MfaSetupState, _formData: FormData): Promise<MfaSetupState> {
  const api = await platformApi();
  const result = await api.POST("/v1/me/mfa/setup");
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error);
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
 * recovery codes come back once, in the state; the page is rendered again with MFA on, and never shows them.
 */
export async function confirmMfaSetup(
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
    leaveOnSessionEnd(result.error);
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
  revalidatePath(SECURITY_PATH);
  const recoveryCodes = recoveryCodesOf(result.data.recoveryCodes);
  if (recoveryCodes === undefined) {
    // MFA is on; the codes can be replaced from the page that follows.
    return { status: "enabled", code: MALFORMED.code, message: errorMessage(MALFORMED) };
  }
  return { status: "enabled", recoveryCodes };
}

// ---- Two-factor changes with a step-up -----------------------------------------------------------------------------

/** What turning MFA off answers. `stepUp` asks `StepUpDialog` for a code; the same submission then runs again. */
export interface MfaDisableState {
  readonly status: "idle" | "disabled" | "failed";
  readonly code?: PlatformErrorCode;
  readonly message?: string;
  readonly stepUp?: true;
}

/** What replacing the recovery codes answers. */
export interface RecoveryCodesState {
  readonly status: "idle" | "replaced" | "failed";
  readonly code?: PlatformErrorCode;
  readonly message?: string;
  /** The ten new recovery codes, shown once. */
  readonly recoveryCodes?: readonly string[];
  readonly stepUp?: true;
}

/** The messages of the refusals of disableMfa and regenerateRecoveryCodes. */
function mfaChangeMessage(error: ApiError, stepUpCancelled: string): string {
  if (error.code === "REAUTH_REQUIRED") {
    // Shown only when the person closes the step-up dialog without a code.
    return stepUpCancelled;
  }
  if (error.code === "FORBIDDEN" && error.details.reason === "platform_admin") {
    return SECURITY_STRINGS.platformAdminKeepsMfa;
  }
  if (error.code === "MFA_REQUIRED") {
    return SECURITY_STRINGS.mfaNotEnabled;
  }
  return error.code === "RATE_LIMITED" ? SECURITY_STRINGS.rateLimited : errorMessage(error);
}

/**
 * Turns MFA off (`POST /v1/me/mfa/disable`). Without a TOTP step-up in the last 15 minutes the API answers
 * `REAUTH_REQUIRED`: the state asks for one, and the same submission runs again with the stepped-up session
 * [PF-04 AC3]. A platform admin cannot turn MFA off (`FORBIDDEN`, `platform_admin`).
 */
export async function turnOffMfa(_previous: MfaDisableState, _formData: FormData): Promise<MfaDisableState> {
  const api = await platformApi();
  const result = await api.POST("/v1/me/mfa/disable");
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error);
    return {
      status: "failed",
      code: result.error.code,
      message: mfaChangeMessage(result.error, SECURITY_STRINGS.turnOffCancelled),
      ...(result.error.code === "REAUTH_REQUIRED" ? { stepUp: true as const } : {}),
    };
  }
  revalidatePath(SECURITY_PATH);
  return { status: "disabled", message: SECURITY_STRINGS.turnedOff };
}

/**
 * Replaces every recovery code with ten new ones (`POST /v1/me/mfa/recovery-codes`), with the same step-up as turning
 * MFA off. The new codes come back once, in the state.
 */
export async function replaceRecoveryCodes(
  _previous: RecoveryCodesState,
  _formData: FormData,
): Promise<RecoveryCodesState> {
  const api = await platformApi();
  const result = await api.POST("/v1/me/mfa/recovery-codes");
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error);
    return {
      status: "failed",
      code: result.error.code,
      message: mfaChangeMessage(result.error, SECURITY_STRINGS.replaceCancelled),
      ...(result.error.code === "REAUTH_REQUIRED" ? { stepUp: true as const } : {}),
    };
  }
  const recoveryCodes = recoveryCodesOf(result.data.recoveryCodes);
  if (recoveryCodes === undefined) {
    return { status: "failed", code: MALFORMED.code, message: errorMessage(MALFORMED) };
  }
  return { status: "replaced", message: SECURITY_STRINGS.codesReplaced, recoveryCodes };
}

// ---- Sessions -------------------------------------------------------------------------------------------------------

/** What revoking a session, or signing out everywhere, answers. */
export interface SessionsState {
  /** `gone`: the session had already ended (`NOT_FOUND`); the table drops it too. */
  readonly status: "idle" | "revoked" | "gone" | "failed";
  readonly code?: PlatformErrorCode;
  readonly message?: string;
  /** The session the answer is about. */
  readonly familyId?: string;
}

/** `SessionFamilyId` of the platform document. */
const FAMILY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Revokes the session `familyId` of the hidden field (`DELETE /v1/me/sessions/{familyId}`): its refresh token stops
 * working at once, so that browser is signed out within 15 minutes at most. The page offers it for the other sessions
 * only; this browser signs out with "Sign out". A session that had already ended (`NOT_FOUND`) leaves the list too.
 */
export async function revokeAccountSession(
  _previous: SessionsState,
  formData: FormData,
): Promise<SessionsState> {
  const familyId = text(formData, "familyId");
  if (!FAMILY_ID.test(familyId)) {
    return { status: "failed", code: "VALIDATION_FAILED", message: SECURITY_STRINGS.formExpired };
  }
  const api = await platformApi();
  const result = await api.DELETE("/v1/me/sessions/{familyId}", { params: { path: { familyId } } });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error);
    if (result.error.code === "NOT_FOUND") {
      return { status: "gone", code: result.error.code, familyId, message: SECURITY_STRINGS.alreadyEnded };
    }
    return {
      status: "failed",
      code: result.error.code,
      familyId,
      message:
        result.error.code === "RATE_LIMITED" ? SECURITY_STRINGS.rateLimited : errorMessage(result.error),
    };
  }
  revalidatePath(SECURITY_PATH);
  return { status: "revoked", familyId, message: SECURITY_STRINGS.revoked };
}

/**
 * Signs out every session of the account (`POST /v1/auth/sign-out-everywhere`): the portal, the platform admin and,
 * through `staffdeny:acct`, every OTA admin session [PF-06 AC2]. This browser's session ends too, so its cookies (and
 * a sign-in waiting for its second factor) are deleted and the browser goes to `/sign-in?signedOut=1`.
 */
export async function signOutEverywhere(
  _previous: SessionsState,
  _formData: FormData,
): Promise<SessionsState> {
  const api = await platformApi();
  const result = await api.POST("/v1/auth/sign-out-everywhere");
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error);
    return {
      status: "failed",
      code: result.error.code,
      message:
        result.error.code === "RATE_LIMITED" ? SECURITY_STRINGS.rateLimited : errorMessage(result.error),
    };
  }
  const cookieStore = await cookies();
  writeCookies(cookieStore, [
    ...clearedSessionCookies(),
    ...([MFA_CHALLENGE_COOKIE, NEXT_PATH_COOKIE] as const)
      .filter((name) => cookieStore.get(name) !== undefined)
      .map((name) => clearedCookie(name)),
  ]);
  redirect("/sign-in?signedOut=1");
}
