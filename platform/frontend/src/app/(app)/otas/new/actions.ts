"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage, isPlatformErrorCode } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { ERROR_MESSAGES, WIZARD_STRINGS } from "@/lib/strings";

/**
 * The server actions of the create-OTA wizard (README §2 `/otas/new`; flow signup-and-create-ota.md steps 5–7;
 * PF-10).
 *
 * - `checkKeyAvailability` is the live key check of `KeyAvailabilityField` (`checkTenantKey`, debounced in the
 *   browser): it answers whether a key is free, and the storefront host it gets.
 * - `createOta` validates the wizard with Zod and calls `createTenant` with the `Idempotency-Key` the wizard made
 *   when it opened, so a double click or a retry creates one OTA (PF-10 AC2). Success continues to the set-up page
 *   of the new OTA; `TENANT_KEY_UNAVAILABLE` returns to step 1 with the message at the key, the tenant limit shows
 *   its message on the review step (PF-10 AC4), and other failures show the portal's message for their code.
 *   From M5 (PFE-020, PF-71) the wizard also sends the billing interval, and the answer's `checkoutUrl` is where the
 *   browser goes: Stripe Checkout, a URL of the API's answer and never one built here (README §5, external
 *   navigations). Without one (Stripe failed after the OTA was created) the set-up page offers "Continue to payment".
 *
 * Both call the API with the session's bearer token and the end-user headers (`platformApi()`); neither returns
 * anything but the portal's own text.
 */

// ---- The key check ---------------------------------------------------------------------------------------------

/** The `TenantKey` of the platform document: lower-case letters and digits, starting with a letter, 3–30. */
const TENANT_KEY = /^[a-z][a-z0-9]{2,29}$/;

/** The longest key `checkTenantKey` accepts (its `key` parameter). */
const KEY_CHECK_MAX = 64;

/**
 * The result of one key check: `available`, or why not (`invalid`, `reserved`, `taken`, the reasons of
 * `KeyAvailability`), or `unchecked` when the API could not answer (rate limit, unavailable). `createTenant` checks
 * the key again in any case.
 */
export type KeyCheckStatus = "available" | "invalid" | "reserved" | "taken" | "unchecked";

export interface KeyCheck {
  /** The key as checked. */
  readonly key: string;
  readonly status: KeyCheckStatus;
  /** The storefront host the key gets (`<key>.<STOREFRONT_BASE_DOMAIN>`), when the API answered. */
  readonly storefrontHost?: string;
}

/**
 * Checks whether `key` can be used for a new OTA (`GET /v1/tenants/key-availability`). A key that breaks the key
 * rules is `invalid` without a call, so typing does not spend the API's 30 checks per minute on keys that cannot be
 * used. The input comes from the browser, so it is checked to be a string first.
 */
export async function checkKeyAvailability(key: unknown): Promise<KeyCheck> {
  if (typeof key !== "string" || key.length > KEY_CHECK_MAX) {
    return { key: "", status: "invalid" };
  }
  if (!TENANT_KEY.test(key)) {
    return { key, status: "invalid" };
  }
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/key-availability", { params: { query: { key } } });
  if (result.error !== undefined) {
    return { key, status: "unchecked" };
  }
  const answer = result.data;
  const status: KeyCheckStatus = answer.available ? "available" : (answer.reason ?? "taken");
  return { key, status, storefrontHost: answer.storefrontHost };
}

// ---- Creating the OTA --------------------------------------------------------------------------------------------

/** The steps of the wizard, in order. */
export type WizardStep = "details" | "plan" | "review";

/**
 * The fields of the wizard that the person fills in. `billingInterval` exists from M5 only (the "Annual billing"
 * switch); before M5 the form has no such field and the request no such property.
 */
export type CreateOtaField =
  "name" | "key" | "countryCode" | "defaultCurrency" | "timeZone" | "planCode" | "billingInterval";

/** The step of each field. */
const FIELD_STEPS: Readonly<Record<CreateOtaField, WizardStep>> = {
  name: "details",
  key: "details",
  countryCode: "details",
  defaultCurrency: "details",
  timeZone: "details",
  planCode: "plan",
  billingInterval: "plan",
};

const FIELDS = Object.keys(FIELD_STEPS) as CreateOtaField[];

function isField(value: unknown): value is CreateOtaField {
  return typeof value === "string" && Object.hasOwn(FIELD_STEPS, value);
}

/** What the wizard shows after a submission that did not create the OTA. */
export interface CreateOtaState {
  readonly status: "idle" | "failed";
  /** The error code of the failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** The step to show the problems on: the step of the first field with a problem, otherwise the review. */
  readonly step?: WizardStep;
  /** Messages per field, in the portal's own words. */
  readonly fieldErrors: Readonly<Partial<Record<CreateOtaField, string>>>;
  /** A problem that belongs to no field (tenant limit, rate limit, API unavailable). */
  readonly message?: string;
}

/** The length of a text as the API's JSON Schema counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

/** `TenantName`, `CountryCode`, `CurrencyCode`, `TimeZone`, `PlanCode` and `IdempotencyKey` of the document. */
const NAME_MAX = 100;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const TIME_ZONE_MAX = 64;
const PLAN_CODE = /^[a-z][a-z0-9_]{1,39}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

const CREATE_OTA_FORM = z.object({
  name: z
    .string()
    .trim()
    .min(1, WIZARD_STRINGS.nameRequired)
    .refine((value) => codePoints(value) <= NAME_MAX, WIZARD_STRINGS.nameTooLong),
  key: z.string().min(1, WIZARD_STRINGS.keyRequired).regex(TENANT_KEY, WIZARD_STRINGS.keyInvalid),
  countryCode: z
    .string()
    .min(1, WIZARD_STRINGS.countryRequired)
    .regex(/^[A-Z]{2}$/, WIZARD_STRINGS.countryUnknown),
  defaultCurrency: z
    .string()
    .min(1, WIZARD_STRINGS.currencyRequired)
    .regex(/^[A-Z]{3}$/, WIZARD_STRINGS.currencyUnknown),
  timeZone: z
    .string()
    .min(1, WIZARD_STRINGS.timeZoneRequired)
    .max(TIME_ZONE_MAX, WIZARD_STRINGS.timeZoneUnknown)
    .regex(TIME_ZONE, WIZARD_STRINGS.timeZoneUnknown),
  planCode: z.string().min(1, WIZARD_STRINGS.planRequired).regex(PLAN_CODE, WIZARD_STRINGS.planRequired),
  // `BillingInterval`; empty when the form has no such field (before M5), and then not sent.
  billingInterval: z.enum(["", "month", "year"], { error: WIZARD_STRINGS.intervalInvalid }),
});

/** The portal's message for an API field error of each field (the API's own text is never shown). */
const API_FIELD_MESSAGES: Readonly<Record<CreateOtaField, string>> = {
  name: WIZARD_STRINGS.nameTooLong,
  key: WIZARD_STRINGS.keyInvalid,
  countryCode: WIZARD_STRINGS.countryUnknown,
  defaultCurrency: WIZARD_STRINGS.currencyUnknown,
  timeZone: WIZARD_STRINGS.timeZoneUnknown,
  planCode: WIZARD_STRINGS.planRequired,
  billingInterval: WIZARD_STRINGS.intervalInvalid,
};

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The step to show `fieldErrors` on: the step of the first field (in wizard order) with a problem. */
function stepOf(fieldErrors: Partial<Record<CreateOtaField, string>>): WizardStep {
  const first = FIELDS.find((field) => fieldErrors[field] !== undefined);
  return first === undefined ? "review" : FIELD_STEPS[first];
}

/** A refused submission with problems at fields. */
function fieldFailure(
  code: PlatformErrorCode,
  fieldErrors: Partial<Record<CreateOtaField, string>>,
): CreateOtaState {
  return { status: "failed", code, step: stepOf(fieldErrors), fieldErrors };
}

/** A refused submission with a problem of no field, shown on the review step. */
function messageFailure(code: PlatformErrorCode, message: string): CreateOtaState {
  return { status: "failed", code, step: "review", fieldErrors: {}, message };
}

/** The form fields of the API's field errors (`path` is a JSON pointer into the request body). */
function apiFieldErrors(error: ApiError): Partial<Record<CreateOtaField, string>> {
  const fieldErrors: Partial<Record<CreateOtaField, string>> = {};
  for (const fieldError of error.fieldErrors) {
    const field = fieldError.path.replace(/^\//, "");
    if (isField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] =
        field === "name" && fieldError.code === "minLength"
          ? WIZARD_STRINGS.nameRequired
          : API_FIELD_MESSAGES[field];
    }
  }
  return fieldErrors;
}

/** The limit of a `tenant_limit` answer, when the API sent a usable one. */
function tenantLimitOf(details: Readonly<Record<string, unknown>>): number | undefined {
  const { limit } = details;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0 ? limit : undefined;
}

/** What the wizard shows for a failed `createTenant`. */
function failureOf(error: ApiError): CreateOtaState {
  const { code } = error;
  if (code === "TENANT_KEY_UNAVAILABLE") {
    // Taken between the live check and the submit, or reserved: back to step 1 with the message at the key.
    return fieldFailure(code, { key: WIZARD_STRINGS.keyUnavailable });
  }
  if (code === "VALIDATION_FAILED") {
    const fieldErrors = apiFieldErrors(error);
    if (Object.keys(fieldErrors).length > 0) {
      return fieldFailure(code, fieldErrors);
    }
    // A problem of no field the person can change (the Idempotency-Key header): the page is stale.
    return messageFailure(
      code,
      error.fieldErrors.length > 0 ? WIZARD_STRINGS.formExpired : ERROR_MESSAGES.VALIDATION_FAILED,
    );
  }
  if (code === "PLAN_NOT_AVAILABLE") {
    return fieldFailure(code, { planCode: ERROR_MESSAGES.PLAN_NOT_AVAILABLE });
  }
  if (code === "UNPROCESSABLE" && error.details["reason"] === "tenant_limit") {
    // PF-10 AC4: the account owns MAX_TENANTS_PER_ACCOUNT OTAs that are not failed.
    return messageFailure(code, WIZARD_STRINGS.tenantLimit(tenantLimitOf(error.details)));
  }
  if (code === "RATE_LIMITED") {
    return messageFailure(code, WIZARD_STRINGS.rateLimited);
  }
  // IDEMPOTENCY_KEY_REUSED, SERVICE_UNAVAILABLE, INTERNAL_ERROR and the rest: the portal's message for the code.
  return messageFailure(code, errorMessage(error));
}

/**
 * The URL of a Checkout answer when it can be followed: an absolute `https:` URL without credentials, exactly as the
 * API answered it (Stripe's Checkout URLs carry a fragment the page needs). Anything else is never followed.
 */
function checkoutTarget(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" ? value : undefined;
}

/**
 * The set-up page of a new OTA whose Checkout did not open: `?payment=<code>` names why (a code of the catalogue),
 * and the page shows the portal's words for it above "Continue to payment".
 */
function setupWithoutCheckout(tenantId: string, code: string): string {
  const payment = isPlatformErrorCode(code) ? code : "PROVIDER_ERROR";
  return `${otaPath(tenantId, "/setup")}?${new URLSearchParams({ payment }).toString()}`;
}

/**
 * Creates the OTA (`POST /v1/tenants`) from the wizard's fields `name`, `key`, `countryCode`, `defaultCurrency`,
 * `timeZone`, `planCode` and, from M5, `billingInterval`, with the hidden field `idempotencyKey` as the
 * `Idempotency-Key` header. Otherwise returns the problems and the step to show them on.
 *
 * On success: before M5 (the API puts every OTA on `early_access`, whatever the plan says, and answers `checkoutUrl:
 * null`) the browser goes to `/otas/<id>/setup`. From M5 it goes to the answer's `checkoutUrl`, Stripe Checkout
 * (PF-71 AC1): the URL is the API's, followed only when it is an `https:` URL, and never assembled here. When Stripe
 * failed after the OTA was created (`checkoutUrl: null`, `checkoutError`), the browser goes to the set-up page, which
 * offers "Continue to payment" (flow signup-and-create-ota.md, "Failure handling").
 */
export async function createOta(_previous: CreateOtaState, formData: FormData): Promise<CreateOtaState> {
  const idempotencyKey = text(formData, "idempotencyKey");
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    // The wizard always sends the key it was opened with; without it the submission is not safe to retry.
    return messageFailure("VALIDATION_FAILED", WIZARD_STRINGS.formExpired);
  }
  const parsed = CREATE_OTA_FORM.safeParse(
    Object.fromEntries(FIELDS.map((field) => [field, text(formData, field)])),
  );
  if (!parsed.success) {
    const fieldErrors: Partial<Record<CreateOtaField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (isField(field) && fieldErrors[field] === undefined) {
        fieldErrors[field] = issue.message;
      }
    }
    return fieldFailure("VALIDATION_FAILED", fieldErrors);
  }

  // Before M5 the form has no interval: the request then has no such property, as in M1.
  const { billingInterval, ...fields } = parsed.data;
  const body = billingInterval === "" ? fields : { ...fields, billingInterval };

  const api = await platformApi();
  const result = await api.POST("/v1/tenants", {
    params: { header: { "Idempotency-Key": idempotencyKey } },
    body,
  });
  if (result.error !== undefined) {
    if (result.error.code === "UNAUTHENTICATED" || result.error.code === "TOKEN_EXPIRED") {
      // The session ended (the middleware renews an access token that is only expired): sign in again.
      redirect(`/sign-in?${new URLSearchParams({ next: "/otas/new" }).toString()}`);
    }
    if (result.error.code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
    return failureOf(result.error);
  }
  const { tenant, checkoutUrl, checkoutError } = result.data;
  if (checkoutUrl !== null) {
    // M5: Stripe Checkout, at the URL the API answered (PF-71 AC1); one that cannot be followed is not.
    const target = checkoutTarget(checkoutUrl);
    redirect(target ?? setupWithoutCheckout(tenant.id, "INTERNAL_ERROR"));
  }
  if (checkoutError !== undefined) {
    // M5, Stripe failed after the OTA was created: the set-up page offers "Continue to payment".
    redirect(setupWithoutCheckout(tenant.id, checkoutError.code));
  }
  redirect(otaPath(tenant.id, "/setup"));
}
