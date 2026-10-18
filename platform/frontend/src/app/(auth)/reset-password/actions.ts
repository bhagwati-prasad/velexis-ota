"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createPlatformApi, type ApiError } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import {
  ACCESS_TOKEN_COOKIE,
  PASSWORD_RESET_COOKIE,
  REFRESH_TOKEN_COOKIE,
  clearedCookie,
  writeCookies,
} from "@/lib/session";
import { ERROR_MESSAGES, SIGN_UP_STRINGS } from "@/lib/strings";

/**
 * The server action of `/reset-password` (README §2 Auth and §6, PF-05). The reset token never travels through the
 * browser's JavaScript or a form field: `middleware.ts` moved it from the link (`?token=`) into the httpOnly
 * `__Host-vxp_reset` cookie (15 minutes), and `confirmPasswordReset` reads it from there on the server.
 *
 * - Success (`204`): the API revoked every session of the account (PF-05 AC2), so the reset cookie and any session
 *   cookies of this browser are deleted, and the person signs in again on `/sign-in?reset=1`.
 * - An unknown, used or expired token (`PASSWORD_RESET_TOKEN_INVALID`): the cookie is deleted and the page offers a
 *   new link.
 * - `PASSWORD_TOO_WEAK`: the message at the field; the token stays usable.
 * The password is never returned, logged or kept.
 */

/** The state of the form. */
export interface ResetPasswordState {
  /** `expired`: no usable reset token any more; the page offers a new link instead of the form. */
  readonly status: "idle" | "failed" | "expired";
  /** The error code of the failure, for tests and logs; never shown. */
  readonly code?: PlatformErrorCode;
  /** A problem with the new password: shown at the field. */
  readonly fieldError?: string;
  /** A problem that belongs to no field. */
  readonly message?: string;
}

/** The password rules of PF-01 AC2 the portal can check itself; the breached list is the API's. */
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 256;

/** The length of a password as the API counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

const NEW_PASSWORD = z
  .string()
  .refine((value) => codePoints(value) >= PASSWORD_MIN, SIGN_UP_STRINGS.passwordTooShort)
  .refine((value) => codePoints(value) <= PASSWORD_MAX, SIGN_UP_STRINGS.passwordTooLong);

/** The message at the password field for the API's field error `code` on `/newPassword`. */
function passwordMessage(code: string | undefined, envelope: PlatformErrorCode): string {
  if (code === "too_short" || code === "minLength") {
    return SIGN_UP_STRINGS.passwordTooShort;
  }
  if (code === "breached") {
    return SIGN_UP_STRINGS.passwordBreached;
  }
  if (code === "maxLength") {
    return SIGN_UP_STRINGS.passwordTooLong;
  }
  return envelope === "PASSWORD_TOO_WEAK"
    ? ERROR_MESSAGES.PASSWORD_TOO_WEAK
    : ERROR_MESSAGES.VALIDATION_FAILED;
}

/** The field error of `error` on `pointer`, if any. */
function fieldErrorAt(error: ApiError, pointer: string): string | undefined {
  return error.fieldErrors.find((fieldError) => fieldError.path === pointer)?.code;
}

/** The token is no good: the API refused it, or refused its shape. */
function tokenRefused(error: ApiError): boolean {
  return (
    error.code === "PASSWORD_RESET_TOKEN_INVALID" ||
    (error.code === "VALIDATION_FAILED" && fieldErrorAt(error, "/token") !== undefined)
  );
}

const EXPIRED: ResetPasswordState = Object.freeze({
  status: "expired",
  code: "PASSWORD_RESET_TOKEN_INVALID",
  message: ERROR_MESSAGES.PASSWORD_RESET_TOKEN_INVALID,
});

/**
 * Sets the new password of the form field `newPassword` with the reset token of `__Host-vxp_reset`
 * (`POST /v1/auth/password-reset/confirm`). Redirects to `/sign-in?reset=1` on success; otherwise returns the
 * problem for the form.
 */
export async function confirmPasswordReset(
  _previous: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const cookieStore = await cookies();
  const token = cookieStore.get(PASSWORD_RESET_COOKIE)?.value;
  if (!token) {
    return EXPIRED;
  }
  const typed = formData.get("newPassword");
  const parsed = NEW_PASSWORD.safeParse(typeof typed === "string" ? typed : "");
  if (!parsed.success) {
    return {
      status: "failed",
      code: "VALIDATION_FAILED",
      fieldError: parsed.error.issues[0]?.message ?? SIGN_UP_STRINGS.passwordTooShort,
    };
  }

  // confirmPasswordReset is public: no bearer token, only the end-user headers.
  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  const result = await api.POST("/v1/auth/password-reset/confirm", {
    body: { token, newPassword: parsed.data },
  });
  if (result.error !== undefined) {
    const { error } = result;
    if (tokenRefused(error)) {
      writeCookies(cookieStore, [clearedCookie(PASSWORD_RESET_COOKIE)]);
      return EXPIRED;
    }
    if (error.code === "PASSWORD_TOO_WEAK" || error.code === "VALIDATION_FAILED") {
      return {
        status: "failed",
        code: error.code,
        fieldError: passwordMessage(fieldErrorAt(error, "/newPassword"), error.code),
      };
    }
    if (error.code === "RATE_LIMITED") {
      return { status: "failed", code: error.code, message: ERROR_MESSAGES.RATE_LIMITED };
    }
    return { status: "failed", code: error.code, message: errorMessage(error) };
  }

  // Every session of the account is revoked (PF-05 AC2): this browser's cookies of one are deleted too.
  const sessionCookieNames = [ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE] as const;
  writeCookies(cookieStore, [
    clearedCookie(PASSWORD_RESET_COOKIE),
    ...sessionCookieNames
      .filter((name) => cookieStore.get(name) !== undefined)
      .map((name) => clearedCookie(name)),
  ]);
  redirect("/sign-in?reset=1");
}
