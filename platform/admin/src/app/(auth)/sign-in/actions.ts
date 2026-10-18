"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createPlatformApi, type ApiError } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { mfaChallengeCookie, safeNextPath, writeCookies } from "@/lib/session";
import { ERROR_MESSAGES, SIGN_IN_STRINGS } from "@/lib/strings";

/**
 * The first step of every admin sign-in (README §2 `/sign-in`, §4; PADR-0006 item 2, PF-80). It validates the form
 * with Zod and calls `adminSignIn` without a bearer token (a public operation) but with the end-user headers of
 * PADR-0019, so the API's lock-out and per-IP limits count the admin, not the admin server.
 *
 * - The answer is always an MFA challenge: it is stored in `__Host-vxa_mfa` (`HttpOnly; Secure; SameSite=Strict`,
 *   at most 5 minutes) and the browser continues to `/sign-in/mfa`, with the validated return path in its query.
 *   **No session is ever created here**: only `adminVerifyMfa` (`/sign-in/mfa`) writes the session cookies, so the
 *   TOTP or recovery code step happens on every sign-in.
 * - `MFA_REQUIRED` (a platform admin without MFA) explains that MFA must be turned on in the portal and links to
 *   `PUBLIC_PORTAL_URL/account/security`.
 * - `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` (with the wait of `Retry-After`), `RATE_LIMITED` and the other failures
 *   come back as the admin's own messages. The password is never returned, logged or kept.
 */

/** The fields of the sign-in form. */
export type SignInField = "email" | "password";

/** A link the form shows with its message. */
export interface SignInLink {
  readonly href: string;
  readonly text: string;
}

/** What the form shows after a submission that did not continue to the MFA step. */
export interface SignInState {
  readonly status: "idle" | "failed";
  /** The error code of the failure, for tests and logs; never shown. */
  readonly code?: PlatformErrorCode;
  /** Messages per field, in the admin's own words. */
  readonly fieldErrors: Readonly<Partial<Record<SignInField, string>>>;
  /** A problem that belongs to no field (wrong credentials, lock-out, no MFA, rate limit, API unavailable). */
  readonly message?: string;
  /** A link that goes with `message`: the portal's security page for `MFA_REQUIRED`. */
  readonly link?: SignInLink;
  /** What the admin typed, so the form keeps it; never the password. */
  readonly values: { readonly email: string };
}

/** Where the second step of every admin sign-in happens. */
const MFA_PATH = "/sign-in/mfa";

/** The portal page where an account turns MFA on (platform/frontend/README.md §2). */
const PORTAL_SECURITY_PATH = "/account/security";

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

/** The message above the form for a failed `adminSignIn`. */
function failureMessage(error: ApiError): string {
  if (error.code === "ACCOUNT_LOCKED") {
    // The API says how long the lock lasts in `Retry-After`.
    return error.retryAfterSeconds === undefined
      ? ERROR_MESSAGES.ACCOUNT_LOCKED
      : SIGN_IN_STRINGS.lockedFor(error.retryAfterSeconds);
  }
  if (error.code === "RATE_LIMITED") {
    return SIGN_IN_STRINGS.rateLimited;
  }
  // INVALID_CREDENTIALS, MFA_REQUIRED and the rest: the admin's message for the code.
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

/** The answer of a call that cannot be an `AdminMfaChallenge`: never a session, whatever it holds. */
const NOT_A_CHALLENGE: PlatformErrorCode = "INTERNAL_ERROR";

/** The challenge of an `adminSignIn` answer, or `undefined` when the answer is not one. */
function challengeOf(answer: unknown): { token: string; expiresIn: number } | undefined {
  if (typeof answer !== "object" || answer === null) {
    return undefined;
  }
  const { mfaChallengeToken, expiresIn } = answer as { mfaChallengeToken?: unknown; expiresIn?: unknown };
  if (typeof mfaChallengeToken !== "string" || mfaChallengeToken === "") {
    return undefined;
  }
  return {
    token: mfaChallengeToken,
    expiresIn: typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : 300,
  };
}

/** `/sign-in/mfa`, with the validated return path in `next` when there is one. */
function mfaPath(next: string | undefined): string {
  return next === undefined ? MFA_PATH : `${MFA_PATH}?${new URLSearchParams({ next }).toString()}`;
}

/**
 * Checks e-mail and password (`POST /v1/admin/auth/sign-in`) with the fields `email` and `password`; the hidden
 * field `next` is the return path, kept only when it is a safe relative path. Redirects to the MFA step on success;
 * otherwise returns the problems for the form.
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

  // adminSignIn is public: no bearer token, even when an older admin session cookie is still there.
  const settings = getConfig();
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders,
  });
  const result = await api.POST("/v1/admin/auth/sign-in", {
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
      ...(result.error.code === "MFA_REQUIRED"
        ? {
            link: {
              href: new URL(PORTAL_SECURITY_PATH, settings.PUBLIC_PORTAL_URL).toString(),
              text: SIGN_IN_STRINGS.enableMfa,
            },
          }
        : {}),
      values,
    };
  }

  const challenge = challengeOf(result.data);
  if (challenge === undefined) {
    // The admin surface answers a challenge to every correct password; anything else is never taken as a session.
    return {
      status: "failed",
      code: NOT_A_CHALLENGE,
      fieldErrors: {},
      message: errorMessage(NOT_A_CHALLENGE),
      values,
    };
  }
  // A new challenge replaces any older one; the session cookies come only with the second step.
  writeCookies(cookieStore, [mfaChallengeCookie(challenge.token, challenge.expiresIn)]);
  redirect(mfaPath(next));
}
