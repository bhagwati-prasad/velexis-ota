"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { TIME_ZONE_PATTERN } from "@/lib/reference-options";
import { otaPath } from "@/lib/roles";
import { SETTINGS_STRINGS } from "@/lib/strings";
import { ifMatchOf, isTenantId } from "@/lib/tenant";

/**
 * The server action of the OTA settings (README §2 `/otas/[tenantId]/settings`; PF-13). `saveOtaProfile` checks the
 * form with Zod and calls `updateTenant` (`PATCH /v1/tenants/{tenantId}`) with the version the form was rendered
 * with in `If-Match`, so a change made in the meantime by someone else answers `412 PRECONDITION_FAILED` instead of
 * being overwritten. The key and the default currency are not part of the form: they never change. The action
 * returns the portal's own text only, never the API's.
 */

type Tenant = components["schemas"]["Tenant"];

/** The fields of the form, in form order. */
export type SettingsField = "name" | "legalName" | "supportEmail" | "countryCode" | "timeZone";

const FIELDS: readonly SettingsField[] = ["name", "legalName", "supportEmail", "countryCode", "timeZone"];

function isField(value: unknown): value is SettingsField {
  return typeof value === "string" && (FIELDS as readonly string[]).includes(value);
}

/** The values of the form as typed; an empty legal name or support address means "none". */
export type SettingsValues = Readonly<Record<SettingsField, string>>;

/** What the form shows after a submission. */
export interface SettingsState {
  readonly status: "idle" | "saved" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** The tenant version the next submission sends in `If-Match` (the saved one after a success). */
  readonly version: number;
  /** The values the fields show: the saved profile after a success, what was sent after a failure. */
  readonly values: SettingsValues;
  /** Messages per field, in the portal's own words. */
  readonly fieldErrors: Readonly<Partial<Record<SettingsField, string>>>;
  /** A problem that belongs to no field (stale version, OTA not active, rate limit, API unavailable). */
  readonly message?: string;
}

/** The form values of the profile `updateTenant` answered (`settings-form.tsx` does the same for `getTenant`). */
function valuesOf(tenant: Pick<Tenant, SettingsField>): SettingsValues {
  return {
    name: tenant.name,
    legalName: tenant.legalName ?? "",
    supportEmail: tenant.supportEmail ?? "",
    countryCode: tenant.countryCode ?? "",
    timeZone: tenant.timeZone,
  };
}

/** The length of a text as the API's JSON Schema counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

/** `TenantName`, `LegalName`, `EmailAddress`, `CountryCode` and `TimeZone` of the platform document. */
const NAME_MAX = 100;
const LEGAL_NAME_MAX = 200;
const EMAIL_MAX = 254;
const TIME_ZONE_MAX = 64;
/** A tenant version as the form carries it (`Tenant.version`, at least 1). */
const VERSION = /^[1-9][0-9]{0,14}$/;

/** An optional text: trimmed, and `null` (clears the value) when empty. */
const optional = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .refine((value) => codePoints(value) <= max, tooLong)
    .transform((value) => (value === "" ? null : value));

const SETTINGS_FORM = z.object({
  name: z
    .string()
    .trim()
    .min(1, SETTINGS_STRINGS.nameRequired)
    .refine((value) => codePoints(value) <= NAME_MAX, SETTINGS_STRINGS.nameTooLong),
  legalName: optional(LEGAL_NAME_MAX, SETTINGS_STRINGS.legalNameTooLong),
  supportEmail: optional(EMAIL_MAX, SETTINGS_STRINGS.supportEmailInvalid).refine(
    (value) => value === null || z.string().email().safeParse(value).success,
    SETTINGS_STRINGS.supportEmailInvalid,
  ),
  countryCode: z
    .string()
    .min(1, SETTINGS_STRINGS.countryRequired)
    .regex(/^[A-Z]{2}$/, SETTINGS_STRINGS.countryUnknown),
  timeZone: z
    .string()
    .min(1, SETTINGS_STRINGS.timeZoneRequired)
    .max(TIME_ZONE_MAX, SETTINGS_STRINGS.timeZoneUnknown)
    .regex(TIME_ZONE_PATTERN, SETTINGS_STRINGS.timeZoneUnknown),
});

/** The portal's message for an API field error of each field (the API's own text is never shown). */
const API_FIELD_MESSAGES: Readonly<Record<SettingsField, string>> = {
  name: SETTINGS_STRINGS.nameTooLong,
  legalName: SETTINGS_STRINGS.legalNameTooLong,
  supportEmail: SETTINGS_STRINGS.supportEmailInvalid,
  countryCode: SETTINGS_STRINGS.countryUnknown,
  timeZone: SETTINGS_STRINGS.timeZoneUnknown,
};

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The form fields of the API's field errors (`path` is a JSON pointer into the request body). */
function apiFieldErrors(error: ApiError): Partial<Record<SettingsField, string>> {
  const fieldErrors: Partial<Record<SettingsField, string>> = {};
  for (const fieldError of error.fieldErrors) {
    const field = fieldError.path.replace(/^\//, "");
    if (isField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] =
        field === "name" && fieldError.code === "minLength"
          ? SETTINGS_STRINGS.nameRequired
          : API_FIELD_MESSAGES[field];
    }
  }
  return fieldErrors;
}

/**
 * The messages of a failed `updateTenant` that belong to no field. `VALIDATION_FAILED` without a field of the form
 * is a problem the person cannot fix (the If-Match header, the path): the page is stale. Other codes get the
 * portal's message for the code.
 */
const FAILURE_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  PRECONDITION_FAILED: SETTINGS_STRINGS.stale,
  TENANT_NOT_ACTIVE: SETTINGS_STRINGS.notActive,
  FORBIDDEN: SETTINGS_STRINGS.forbidden,
  NOT_FOUND: SETTINGS_STRINGS.removed,
  RATE_LIMITED: SETTINGS_STRINGS.rateLimited,
  VALIDATION_FAILED: SETTINGS_STRINGS.formExpired,
};

function failureMessage(error: ApiError): string {
  return FAILURE_MESSAGES[error.code] ?? errorMessage(error);
}

/**
 * Saves the OTA profile from the form's fields `name`, `legalName`, `supportEmail`, `countryCode` and `timeZone`,
 * with the hidden fields `tenantId` and `version` (the `If-Match` version). Returns the saved profile and its new
 * version, or the problems; the page is revalidated after a save, so the shell and the overview show the new name.
 */
export async function saveOtaProfile(previous: SettingsState, formData: FormData): Promise<SettingsState> {
  const values = Object.fromEntries(FIELDS.map((field) => [field, text(formData, field)])) as Record<
    SettingsField,
    string
  >;
  const tenantId = text(formData, "tenantId");
  const version = text(formData, "version");
  const failed = (
    code: PlatformErrorCode,
    problems: { fieldErrors?: Partial<Record<SettingsField, string>>; message?: string },
  ): SettingsState => ({
    status: "failed",
    code,
    // A refused save changes nothing: the next one is checked against the same version.
    version: VERSION.test(version) ? Number(version) : previous.version,
    values,
    fieldErrors: problems.fieldErrors ?? {},
    ...(problems.message === undefined ? {} : { message: problems.message }),
  });

  if (!isTenantId(tenantId) || !VERSION.test(version)) {
    // The form always carries both; without them a save could not be checked against the version shown.
    return failed("VALIDATION_FAILED", { message: SETTINGS_STRINGS.formExpired });
  }
  const parsed = SETTINGS_FORM.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<SettingsField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (isField(field) && fieldErrors[field] === undefined) {
        fieldErrors[field] = issue.message;
      }
    }
    return failed("VALIDATION_FAILED", { fieldErrors });
  }

  const api = await platformApi();
  const result = await api.PATCH("/v1/tenants/{tenantId}", {
    params: { path: { tenantId }, header: { "If-Match": ifMatchOf(Number(version)) } },
    body: parsed.data,
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      // The session ended (the middleware renews an access token that is only expired): sign in again.
      redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/settings") }).toString()}`);
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
    const fieldErrors = code === "VALIDATION_FAILED" ? apiFieldErrors(result.error) : {};
    return Object.keys(fieldErrors).length > 0
      ? failed(code, { fieldErrors })
      : failed(code, { message: failureMessage(result.error) });
  }

  // The OTA's name shows in the shell (switcher, navigation) and on its pages: render them again.
  revalidatePath(otaPath(tenantId), "layout");
  return {
    status: "saved",
    version: result.data.version,
    values: valuesOf(result.data),
    fieldErrors: {},
  };
}
