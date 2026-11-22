"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createPlatformApi, platformApi, type ApiError } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import {
  codePoints,
  meetsPasswordRule,
  PASSWORD_MAX_LENGTH,
  passwordFieldMessage,
} from "@/lib/password-rule";
import {
  INVITATION_COOKIE,
  VERIFY_NEXT_COOKIE,
  clearedCookie,
  keptInvitationCookie,
  safeNextPath,
  verifyNextCookie,
  writeCookies,
  type CookieWrite,
} from "@/lib/session";
import { ERROR_MESSAGES, SIGN_UP_STRINGS } from "@/lib/strings";
import { termsVersion } from "@/lib/terms";

/**
 * The sign-up server action (README §2 `/sign-up`, platform/docs/flows/signup-and-create-ota.md step 1, PF-01).
 * It validates the form with Zod, calls `signUp` with the current `termsVersion`, maps the API's field errors back
 * to the form, and on `202` keeps the form's return path for the e-mail verification (`keepReturnPath`) and redirects
 * to `/sign-up/check-email`. The answer is the same for a new and a known address, so the next page is too. The
 * password is never returned in the state, logged or kept anywhere.
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

/** The invitation acceptance (`invitations/accept/page.tsx`), whose sign-up link sets `next` to this path. */
const INVITATION_ACCEPT_PATH = "/invitations/accept";

/** The bounds of the platform document (`SignUpRequest`, `EmailAddress`, `Password`). */
const FULL_NAME_MAX = 200;
const EMAIL_MAX = 254;

const SIGN_UP_FORM = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, SIGN_UP_STRINGS.fullNameRequired)
    // UTF-16 units, as the field's `maxLength` counts them and Zod 3's `.max()` did (Zod 4 counts code points).
    .refine((value) => value.length <= FULL_NAME_MAX, SIGN_UP_STRINGS.fullNameTooLong),
  email: z
    .string()
    .trim()
    .min(1, SIGN_UP_STRINGS.emailRequired)
    .max(EMAIL_MAX, SIGN_UP_STRINGS.emailInvalid)
    // The address rule after the trim (`z.email()` on its own would check the untrimmed text first).
    .check(z.email({ error: SIGN_UP_STRINGS.emailInvalid })),
  // The password rule of every portal account (`lib/password-rule.ts`, PF-01 AC2); the breached list is the API's.
  password: z
    .string()
    .refine(meetsPasswordRule, SIGN_UP_STRINGS.passwordRule)
    .refine((value) => codePoints(value) <= PASSWORD_MAX_LENGTH, SIGN_UP_STRINGS.passwordTooLong),
  acceptTerms: z.literal(true, { error: SIGN_UP_STRINGS.termsRequired }),
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

/** The message for an API field error of `field` (`code` is the field error's code, e.g. `password_rule`). */
function apiFieldMessage(field: SignUpField, code: string, envelope: PlatformErrorCode): string {
  switch (field) {
    case "fullName":
      return code === "maxLength" ? SIGN_UP_STRINGS.fullNameTooLong : SIGN_UP_STRINGS.fullNameRequired;
    case "email":
      return SIGN_UP_STRINGS.emailInvalid;
    case "password":
      return (
        passwordFieldMessage(code) ??
        ERROR_MESSAGES[envelope === "PASSWORD_TOO_WEAK" ? "PASSWORD_TOO_WEAK" : "VALIDATION_FAILED"]
      );
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
 * The invitation cookie of this browser kept until the invitation expires (at most 24 hours, `keptInvitationCookie`),
 * so its invitee can still accept after the e-mail verification and the sign-in (KI-008); `undefined` without the
 * cookie or when `lookupInvitation` refuses the token or cannot be reached, which leaves the cookie as it is. The
 * lookup is public: no bearer token, only the end-user headers (as on the accept page). The token is never logged and
 * never leaves its httpOnly `SameSite=Strict` cookie.
 */
async function keptInvitation(token: string | undefined): Promise<CookieWrite | undefined> {
  if (!token) {
    return undefined;
  }
  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  const preview = await api.POST("/v1/invitations/lookup", { body: { token } });
  return preview.error === undefined ? keptInvitationCookie(token, preview.data.expiresAt) : undefined;
}

/**
 * Keeps the return path of a successful sign-up for the e-mail verification in this browser (FIX-W69-SIGNUP, KI-008,
 * KI-009): `__Host-vxp_verify_next` (httpOnly, `SameSite=Lax`, 24 hours, `verifyNextCookie`) with the path that
 * `safeNextPath()` accepts, which `/verify-email` continues to. A sign-up from an invitation (`/invitations/accept`)
 * also keeps the invitation's own cookie as long (`keptInvitation`). Without a safe path an older return path of this
 * browser is deleted, so the latest sign-up decides where its verification leads.
 */
async function keepReturnPath(next: string | undefined): Promise<void> {
  const cookieStore = await cookies();
  const returnCookie = verifyNextCookie(next);
  if (returnCookie === undefined) {
    if (cookieStore.get(VERIFY_NEXT_COOKIE) !== undefined) {
      writeCookies(cookieStore, [clearedCookie(VERIFY_NEXT_COOKIE)]);
    }
    return;
  }
  const writes: CookieWrite[] = [returnCookie];
  if (returnCookie.value.split(/[?#]/, 1)[0] === INVITATION_ACCEPT_PATH) {
    const invitation = await keptInvitation(cookieStore.get(INVITATION_COOKIE)?.value);
    if (invitation !== undefined) {
      writes.push(invitation);
    }
  }
  writeCookies(cookieStore, writes);
}

/**
 * Creates an account (`POST /v1/auth/sign-up`) from the fields `fullName`, `email`, `password` and `acceptTerms`
 * (a checkbox); the hidden field `next` is the return path after the e-mail verification, kept only when it is a safe
 * relative path. Redirects to `/sign-up/check-email` on success; otherwise returns the problems for the form.
 */
export async function signUp(_previous: SignUpState, formData: FormData): Promise<SignUpState> {
  const values = {
    fullName: text(formData, "fullName"),
    email: text(formData, "email"),
    acceptTerms: formData.get("acceptTerms") === "on",
  };
  const next = safeNextPath(text(formData, "next"));
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
  await keepReturnPath(next);
  redirect(CHECK_EMAIL_PATH);
}
