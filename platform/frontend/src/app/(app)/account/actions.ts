"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { TIME_ZONE_PATTERN } from "@/lib/reference-options";
import { ACCOUNT_STRINGS } from "@/lib/strings";

/**
 * The server action of `/account` (README §2 `/account`; PF-07). `saveProfile` checks the form with Zod and calls
 * `updateMe` (`PATCH /v1/me`) with the account version the page was rendered with in `If-Match` (`"<version>"`, the
 * `ETag` of `getMe`), so a change made in the meantime in another tab or session answers `412 PRECONDITION_FAILED`
 * instead of being overwritten, and the person is asked to reload [PF-07 AC1]. The e-mail address is not part of the
 * form: it cannot change here (PADR-0008 item 5). The action returns the portal's own text only, never the API's.
 */

type Account = components["schemas"]["Account"];

/** The fields of the form, in form order. */
export type ProfileField = "fullName" | "locale" | "timeZone";

const FIELDS: readonly ProfileField[] = ["fullName", "locale", "timeZone"];

function isField(value: unknown): value is ProfileField {
  return typeof value === "string" && (FIELDS as readonly string[]).includes(value);
}

/** The values of the form as typed. */
export type ProfileValues = Readonly<Record<ProfileField, string>>;

/** What the form shows after a submission. */
export interface ProfileState {
  readonly status: "idle" | "saved" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** The account version the next submission sends in `If-Match` (the saved one after a success). */
  readonly version: number;
  /** The values the fields show: the saved profile after a success, what was sent after a failure. */
  readonly values: ProfileValues;
  /** Messages per field, in the portal's own words. */
  readonly fieldErrors: Readonly<Partial<Record<ProfileField, string>>>;
  /** A problem that belongs to no field (stale version, rate limit, API unavailable). */
  readonly message?: string;
}

/** The form values of the account `updateMe` answered (`profile-form.tsx` does the same for `getMe`). */
function valuesOf(account: Pick<Account, ProfileField>): ProfileValues {
  return { fullName: account.fullName, locale: account.locale, timeZone: account.timeZone };
}

/** The length of a text as the API's JSON Schema counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

/** `fullName` (1 to 200), `Locale` and `TimeZone` of the platform document's `UpdateMeRequest`. */
const FULL_NAME_MAX = 200;
const LOCALE_MAX = 35;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const TIME_ZONE_MAX = 64;
/** An account version as the form carries it (`Account.version`, at least 1). */
const VERSION = /^[1-9][0-9]{0,14}$/;

const PROFILE_FORM = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, ACCOUNT_STRINGS.fullNameRequired)
    .refine((value) => codePoints(value) <= FULL_NAME_MAX, ACCOUNT_STRINGS.fullNameTooLong),
  locale: z
    .string()
    .min(1, ACCOUNT_STRINGS.localeUnknown)
    .max(LOCALE_MAX, ACCOUNT_STRINGS.localeUnknown)
    .regex(LOCALE_PATTERN, ACCOUNT_STRINGS.localeUnknown),
  timeZone: z
    .string()
    .min(1, ACCOUNT_STRINGS.timeZoneRequired)
    .max(TIME_ZONE_MAX, ACCOUNT_STRINGS.timeZoneUnknown)
    .regex(TIME_ZONE_PATTERN, ACCOUNT_STRINGS.timeZoneUnknown),
});

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The portal's message for an API field error of each field (the API's own text is never shown). */
function apiFieldMessage(field: ProfileField, code: string): string {
  if (field === "fullName") {
    return code === "minLength" || code === "blank"
      ? ACCOUNT_STRINGS.fullNameRequired
      : ACCOUNT_STRINGS.fullNameTooLong;
  }
  return field === "locale" ? ACCOUNT_STRINGS.localeUnknown : ACCOUNT_STRINGS.timeZoneUnknown;
}

/** The form fields of the API's field errors (`path` is a JSON pointer into the request body). */
function apiFieldErrors(error: ApiError): Partial<Record<ProfileField, string>> {
  const fieldErrors: Partial<Record<ProfileField, string>> = {};
  for (const fieldError of error.fieldErrors) {
    const field = fieldError.path.replace(/^\//, "");
    if (isField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] = apiFieldMessage(field, fieldError.code);
    }
  }
  return fieldErrors;
}

/**
 * The messages of a failed `updateMe` that belong to no field. `VALIDATION_FAILED` without a field of the form is a
 * problem the person cannot fix (the `If-Match` header): the page is stale.
 */
const FAILURE_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  PRECONDITION_FAILED: ACCOUNT_STRINGS.stale,
  RATE_LIMITED: ACCOUNT_STRINGS.rateLimited,
  VALIDATION_FAILED: ACCOUNT_STRINGS.formExpired,
};

/**
 * Saves the profile from the form's fields `fullName`, `locale` and `timeZone`, with the hidden field `version` (the
 * `If-Match` version). Returns the saved profile and its new version, or the problems. After a save the signed-in
 * area is rendered again, because the shell shows the account's name on every page.
 */
export async function saveProfile(previous: ProfileState, formData: FormData): Promise<ProfileState> {
  const values = Object.fromEntries(FIELDS.map((field) => [field, text(formData, field)])) as Record<
    ProfileField,
    string
  >;
  const version = text(formData, "version");
  const failed = (
    code: PlatformErrorCode,
    problems: { fieldErrors?: Partial<Record<ProfileField, string>>; message?: string },
  ): ProfileState => ({
    status: "failed",
    code,
    // A refused save changes nothing: the next one is checked against the same version.
    version: VERSION.test(version) ? Number(version) : previous.version,
    values,
    fieldErrors: problems.fieldErrors ?? {},
    ...(problems.message === undefined ? {} : { message: problems.message }),
  });

  if (!VERSION.test(version)) {
    // The form always carries it; without it a save could not be checked against the version shown.
    return failed("VALIDATION_FAILED", { message: ACCOUNT_STRINGS.formExpired });
  }
  const parsed = PROFILE_FORM.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<ProfileField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (isField(field) && fieldErrors[field] === undefined) {
        fieldErrors[field] = issue.message;
      }
    }
    return failed("VALIDATION_FAILED", { fieldErrors });
  }

  const api = await platformApi();
  const result = await api.PATCH("/v1/me", {
    // The `ETag` of getMe is the version in quotes.
    params: { header: { "If-Match": `"${Number(version)}"` } },
    body: parsed.data,
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      // The session ended (the middleware renews an access token that is only expired): sign in again.
      redirect(`/sign-in?${new URLSearchParams({ next: "/account" }).toString()}`);
    }
    const fieldErrors = code === "VALIDATION_FAILED" ? apiFieldErrors(result.error) : {};
    return Object.keys(fieldErrors).length > 0
      ? failed(code, { fieldErrors })
      : failed(code, { message: FAILURE_MESSAGES[code] ?? errorMessage(result.error) });
  }

  // The shell shows the account's name on every signed-in page: render the signed-in area again.
  revalidatePath("/", "layout");
  return {
    status: "saved",
    version: result.data.version,
    values: valuesOf(result.data),
    fieldErrors: {},
  };
}
