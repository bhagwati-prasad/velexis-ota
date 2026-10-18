"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ERROR_MESSAGES, SIGN_UP_STRINGS } from "@/lib/strings";
import { termsVersion } from "@/lib/terms";

/**
 * The sign-up server action (README §2 `/sign-up`, platform/docs/flows/signup-and-create-ota.md step 1, PF-01).
 * It validates the form with Zod, calls `signUp` with the current `termsVersion`, maps the API's field errors back
 * to the form, and on `202` redirects to `/sign-up/check-email`. The answer is the same for a new and a known
 * address, so the next page is too. The password is never returned in the state, logged or kept anywhere.
 */

/** The fields of the sign-up form. */
export type SignUpField = "fullName" | "email" | "password" | "acceptTerms";

/** What the form shows after a submission that did not create an account. */
export interface SignUpState {
  readonly status: "idle" | "failed";
  /** The error code of the failure, for tests and logs; never shown. */
  readonly code?: PlatformErrorCode;
  /** Messages per field, in the portal's own words. */
  readonly fieldErrors: Readonly<Partial<Record<SignUpField, string>>>;
  /** A problem that belongs to no field (rate limit, API unavailable). */
  readonly message?: string;
  /** What the person typed, so the form keeps it; never the password. */
  readonly values: {
    readonly fullName: string;
    readonly email: string;
    readonly acceptTerms: boolean;
  };
}

/** Where a successful sign-up continues. */
const CHECK_EMAIL_PATH = "/sign-up/check-email";

/** The bounds of the platform document (`SignUpRequest`, `EmailAddress`, `Password`). */
const FULL_NAME_MAX = 200;
const EMAIL_MAX = 254;
/** The password rule of PF-01 AC2 that the portal can check itself; the breached list is the API's. */
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 256;

/** The length of a password as the API counts it: Unicode code points, so an emoji counts once. */
function codePoints(value: string): number {
  return [...value].length;
}

const SIGN_UP_FORM = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, SIGN_UP_STRINGS.fullNameRequired)
    .max(FULL_NAME_MAX, SIGN_UP_STRINGS.fullNameTooLong),
  email: z
    .string()
    .trim()
    .min(1, SIGN_UP_STRINGS.emailRequired)
    .max(EMAIL_MAX, SIGN_UP_STRINGS.emailInvalid)
    .email(SIGN_UP_STRINGS.emailInvalid),
  password: z
    .string()
    .refine((value) => codePoints(value) >= PASSWORD_MIN, SIGN_UP_STRINGS.passwordTooShort)
    .refine((value) => codePoints(value) <= PASSWORD_MAX, SIGN_UP_STRINGS.passwordTooLong),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: SIGN_UP_STRINGS.termsRequired }) }),
});

const FIELDS: readonly SignUpField[] = ["fullName", "email", "password", "acceptTerms"];

function isField(value: unknown): value is SignUpField {
  return typeof value === "string" && (FIELDS as readonly string[]).includes(value);
}

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The message for an API field error of `field` (`code` is the field error's code, e.g. `too_short`). */
function apiFieldMessage(field: SignUpField, code: string, envelope: PlatformErrorCode): string {
  switch (field) {
    case "fullName":
      return code === "maxLength" ? SIGN_UP_STRINGS.fullNameTooLong : SIGN_UP_STRINGS.fullNameRequired;
    case "email":
      return SIGN_UP_STRINGS.emailInvalid;
    case "password":
      if (code === "too_short" || code === "minLength") {
        return SIGN_UP_STRINGS.passwordTooShort;
      }
      if (code === "breached") {
        return SIGN_UP_STRINGS.passwordBreached;
      }
      if (code === "maxLength") {
        return SIGN_UP_STRINGS.passwordTooLong;
      }
      return ERROR_MESSAGES[envelope === "PASSWORD_TOO_WEAK" ? "PASSWORD_TOO_WEAK" : "VALIDATION_FAILED"];
    case "acceptTerms":
      return SIGN_UP_STRINGS.termsRequired;
  }
}

/** The form fields of the API's field errors (`path` is a JSON pointer into the request body). */
function apiFieldErrors(error: ApiError): Partial<Record<SignUpField, string>> {
  const fieldErrors: Partial<Record<SignUpField, string>> = {};
  for (const fieldError of error.fieldErrors) {
    const field = fieldError.path.replace(/^\//, "");
    if (isField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] = apiFieldMessage(field, fieldError.code, error.code);
    }
  }
  if (error.code === "PASSWORD_TOO_WEAK" && fieldErrors.password === undefined) {
    fieldErrors.password = ERROR_MESSAGES.PASSWORD_TOO_WEAK;
  }
  return fieldErrors;
}

/** The message above the form for an API failure; none when the field errors say it all. */
function apiMessage(error: ApiError, fieldErrors: Partial<Record<SignUpField, string>>): string | undefined {
  if (error.code === "RATE_LIMITED") {
    return SIGN_UP_STRINGS.rateLimited;
  }
  if ((error.code === "VALIDATION_FAILED" || error.code === "PASSWORD_TOO_WEAK") && hasAny(fieldErrors)) {
    return undefined;
  }
  return errorMessage(error);
}

function hasAny(fieldErrors: Partial<Record<SignUpField, string>>): boolean {
  return Object.keys(fieldErrors).length > 0;
}

/**
 * Creates an account (`POST /v1/auth/sign-up`) from the fields `fullName`, `email`, `password` and `acceptTerms`
 * (a checkbox). Redirects to `/sign-up/check-email` on success; otherwise returns the problems for the form.
 */
export async function signUp(_previous: SignUpState, formData: FormData): Promise<SignUpState> {
  const values = {
    fullName: text(formData, "fullName"),
    email: text(formData, "email"),
    acceptTerms: formData.get("acceptTerms") === "on",
  };
  const parsed = SIGN_UP_FORM.safeParse({ ...values, password: text(formData, "password") });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<SignUpField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (isField(field) && fieldErrors[field] === undefined) {
        fieldErrors[field] = issue.message;
      }
    }
    return { status: "failed", code: "VALIDATION_FAILED", fieldErrors, values };
  }

  const api = await platformApi();
  const result = await api.POST("/v1/auth/sign-up", {
    body: {
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      password: parsed.data.password,
      acceptTerms: true,
      termsVersion,
    },
  });
  if (result.error !== undefined) {
    const fieldErrors = apiFieldErrors(result.error);
    const message = apiMessage(result.error, fieldErrors);
    return {
      status: "failed",
      code: result.error.code,
      fieldErrors,
      ...(message === undefined ? {} : { message }),
      values,
    };
  }
  redirect(CHECK_EMAIL_PATH);
}
