"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createPlatformApi, type ApiError } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import {
  MFA_CHALLENGE_COOKIE,
  NEXT_PATH_COOKIE,
  clearedCookie,
  mfaChallengeCookie,
  nextPathCookie,
  safeNextPath,
  sessionCookies,
  writeCookies,
  type CookieWrite,
} from "@/lib/session";
import { ERROR_MESSAGES, SIGN_IN_STRINGS } from "@/lib/strings";

/**
 * The sign-in server action (README §2 `/sign-in`, §6; PF-03, PF-04 AC2). It validates the form with Zod and calls
 * `signIn` without a bearer token (a public operation) but with the end-user headers of PADR-0019, so the API's
 * lock-out and per-IP limits count the person, not the portal.
 *
 * - A `PortalSession` becomes the two session cookies, and the browser continues to the validated `next` (a
 *   relative path, `safeNextPath`) or to `/dashboard` (`/verify-pending` for an account that still has to verify
 *   its address).
 * - An `MfaChallenge` is stored in `__Host-vxp_mfa` (`SameSite=Strict`, at most 5 minutes) with the validated
 *   `next` in `__Host-vxp_next`, and the browser continues to `/sign-in/mfa`.
 * - `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` (with the wait of `Retry-After`), `ACCOUNT_DISABLED` and the other
 *   failures come back as the portal's own messages. The password is never returned, logged or kept.
 */

/** The fields of the sign-in form. */
export type SignInField = "email" | "password";

/** What the form shows after a submission that did not sign in. */
export interface SignInState {
  readonly status: "idle" | "failed";
  /** The error code of the failure, for tests and logs; never shown. */
  readonly code?: PlatformErrorCode;
  /** Messages per field, in the portal's own words. */
  readonly fieldErrors: Readonly<Partial<Record<SignInField, string>>>;
  /** A problem that belongs to no field (wrong credentials, lock-out, rate limit, API unavailable). */
  readonly message?: string;
  /** What the person typed, so the form keeps it; never the password. */
  readonly values: { readonly email: string };
}

/** Where the second step of an MFA sign-in happens. */
const MFA_PATH = "/sign-in/mfa";

/** `EmailAddress` and `Password` of the platform document. */
const EMAIL_MAX = 254;
const PASSWORD_MAX = 256;

/** The length of a password as the API counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

const SIGN_IN_FORM = z.object({
  email: z
    .string()
    .trim()
    .min(1, SIGN_IN_STRINGS.emailRequired)
    .max(EMAIL_MAX, SIGN_IN_STRINGS.emailInvalid)
    .email(SIGN_IN_STRINGS.emailInvalid),
  // Only the bounds of the document: the password rules apply when a password is chosen, not when it is used.
  password: z
    .string()
    .min(1, SIGN_IN_STRINGS.passwordRequired)
    .refine((value) => codePoints(value) <= PASSWORD_MAX, SIGN_IN_STRINGS.passwordTooLong),
});

const FIELDS: readonly SignInField[] = ["email", "password"];

function isField(value: unknown): value is SignInField {
  return typeof value === "string" && (FIELDS as readonly string[]).includes(value);
}

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The message above the form for a failed `signIn`. */
function failureMessage(error: ApiError): string {
  if (error.code === "ACCOUNT_LOCKED") {
    // PF-03 AC2: the API says how long the lock lasts in `Retry-After`.
    return error.retryAfterSeconds === undefined
      ? ERROR_MESSAGES.ACCOUNT_LOCKED
      : SIGN_IN_STRINGS.lockedFor(error.retryAfterSeconds);
  }
  if (error.code === "RATE_LIMITED") {
    return SIGN_IN_STRINGS.rateLimited;
  }
  // INVALID_CREDENTIALS, ACCOUNT_DISABLED and the rest: the portal's message for the code.
  return errorMessage(error);
}

/** The form fields of the API's field errors (`path` is a JSON pointer into the request body). */
function apiFieldErrors(error: ApiError): Partial<Record<SignInField, string>> {
  const fieldErrors: Partial<Record<SignInField, string>> = {};
  for (const fieldError of error.fieldErrors) {
    const field = fieldError.path.replace(/^\//, "");
    if (isField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] =
        field === "email"
          ? SIGN_IN_STRINGS.emailInvalid
          : fieldError.code === "maxLength"
            ? SIGN_IN_STRINGS.passwordTooLong
            : SIGN_IN_STRINGS.passwordRequired;
    }
  }
  return fieldErrors;
}

/** The deletion of `name` when the request carries it; nothing otherwise. */
function clearedIfPresent(
  store: { get(name: string): { value: string } | undefined },
  name: typeof MFA_CHALLENGE_COOKIE | typeof NEXT_PATH_COOKIE,
): CookieWrite[] {
  return store.get(name) === undefined ? [] : [clearedCookie(name)];
}

/**
 * Signs in (`POST /v1/auth/sign-in`) with the fields `email` and `password`; the hidden field `next` is the return
 * path, kept only when it is a safe relative path. Redirects on success or when MFA is needed; otherwise returns
 * the problems for the form.
 */
export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
  const values = { email: text(formData, "email") };
  const next = safeNextPath(text(formData, "next"));
  const parsed = SIGN_IN_FORM.safeParse({ ...values, password: text(formData, "password") });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<SignInField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (isField(field) && fieldErrors[field] === undefined) {
        fieldErrors[field] = issue.message;
      }
    }
    return { status: "failed", code: "VALIDATION_FAILED", fieldErrors, values };
  }

  // signIn is public: no bearer token, even when an old session cookie is still there.
  const settings = getConfig();
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders,
  });
  const result = await api.POST("/v1/auth/sign-in", {
    body: { email: parsed.data.email, password: parsed.data.password },
  });
  if (result.error !== undefined) {
    const fieldErrors = result.error.code === "VALIDATION_FAILED" ? apiFieldErrors(result.error) : {};
    const hasFieldErrors = Object.keys(fieldErrors).length > 0;
    return {
      status: "failed",
      code: result.error.code,
      fieldErrors,
      ...(hasFieldErrors ? {} : { message: failureMessage(result.error) }),
      values,
    };
  }

  const answer = result.data;
  if ("mfaRequired" in answer) {
    // The challenge waits in a SameSite=Strict cookie; the return path waits next to it for the second step.
    const nextCookie = nextPathCookie(next);
    writeCookies(cookieStore, [
      mfaChallengeCookie(answer.mfaChallengeToken, answer.expiresIn),
      ...(nextCookie === undefined ? clearedIfPresent(cookieStore, NEXT_PATH_COOKIE) : [nextCookie]),
    ]);
    redirect(MFA_PATH);
  }

  writeCookies(cookieStore, [
    ...sessionCookies(answer),
    ...clearedIfPresent(cookieStore, MFA_CHALLENGE_COOKIE),
    ...clearedIfPresent(cookieStore, NEXT_PATH_COOKIE),
  ]);
  redirect(next ?? (answer.account.emailVerified ? "/dashboard" : "/verify-pending"));
}
