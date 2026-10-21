"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { PLAN_FORM_STRINGS as F } from "@/lib/strings";

/**
 * The server actions of `/plans` and `/plans/[planCode]` (README §2 and §4; subscription-billing flow §A): create a
 * plan (`adminCreatePlan`), edit one (`adminUpdatePlan` with `If-Match`), and retire it or make it active again
 * (`isActive` of the same operation).
 *
 * The forms send structured fields, never raw JSON: the limits as four fields, the features as rows of a name and an
 * on/off switch. Each action checks every field as the platform document does (`CreatePlanRequest`,
 * `UpdatePlanRequest`) before it calls the API, so a form with made-up or invalid fields sends nothing, and money
 * stays a decimal string from the field to the request (conventions §1). An ended session goes to `/sign-in` and back;
 * `REAUTH_REQUIRED` returns the previous state with `stepUp: true`, so `useStepUpAction` asks for a TOTP code and runs
 * the action again with the same form data. A success revalidates the plan's page and the list. The states carry only
 * what the forms show, in the admin's own words: never the API's message.
 */

type Schemas = components["schemas"];
type AdminPlan = Schemas["AdminPlan"];
type CreatePlanRequest = Schemas["CreatePlanRequest"];
type UpdatePlanRequest = Schemas["UpdatePlanRequest"];

/** The plan fields a form shows: what `/plans/[planCode]` hands its forms and what a save answers. */
export interface EditablePlan {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly currency: string;
  /** The amounts only: both prices are in `currency`. */
  readonly monthlyPrice: string;
  readonly annualPrice: string | null;
  readonly trialDays: number;
  readonly limits: Schemas["PlanLimits"];
  readonly features: Readonly<Record<string, boolean>>;
  readonly isPublic: boolean;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly settlementFeeBps: number;
  /** The version for `If-Match` (`AdminPlan.version`). */
  readonly version: number;
}

/** The fields of the plan form that can show a message. */
export type PlanField =
  | "code"
  | "name"
  | "description"
  | "currency"
  | "monthlyPrice"
  | "annualPrice"
  | "trialDays"
  | "staffSeats"
  | "apiKeys"
  | "customDomains"
  | "features"
  | "sortOrder"
  | "settlementFeeBps";

/** One feature flag of the form: a name and its switch. */
export interface FeatureRow {
  readonly name: string;
  readonly on: boolean;
}

/** The plan form as typed. Numbers and amounts stay text until they are checked; money never becomes a number. */
export interface PlanFormValues {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly currency: string;
  readonly monthlyPrice: string;
  readonly annualPrice: string;
  readonly trialDays: string;
  readonly staffSeats: string;
  readonly apiKeys: string;
  readonly customDomains: string;
  readonly liveMode: boolean;
  readonly features: readonly FeatureRow[];
  readonly isPublic: boolean;
  readonly sortOrder: string;
  readonly settlementFeeBps: string;
}

/** The action's call answered `REAUTH_REQUIRED`: `useStepUpAction` asks for a TOTP code and runs it again. */
interface StepUpFlag {
  readonly stepUp?: true;
}

/** The state of the create form and of the edit form. */
export interface PlanFormState extends StepUpFlag {
  readonly status: "idle" | "saved" | "failed";
  /** The error code of a failure, for tests and the `data-code` of the notice; never shown. */
  readonly code?: PlatformErrorCode;
  /** The plan version the next edit sends in `If-Match` (the saved one after a success); 0 for a new plan. */
  readonly version: number;
  /** What the fields show: what was sent after a failure. */
  readonly values: PlanFormValues;
  /** Messages per field, in the admin's own words. */
  readonly fieldErrors: Readonly<Partial<Record<PlanField, string>>>;
  /** A problem that belongs to no field (stale version, rate limit, API unavailable). */
  readonly message?: string;
  /** The plan as saved: the new plan after a create, the changed one after an edit. */
  readonly plan?: EditablePlan;
}

/** A refused action, in the admin's words. */
export interface ActionFailure {
  readonly status: "failed";
  /** The error code, for tests and the `data-code` of the notice; never shown. */
  readonly code: PlatformErrorCode;
  readonly message: string;
}

/** The state of the retire form (`isActive: false`) and of the reactivate form (`isActive: true`). */
export type PlanStatusState = StepUpFlag &
  (
    | { readonly status: "idle" }
    | { readonly status: "done"; readonly isActive: boolean; readonly version: number }
    | ActionFailure
  );

// ---- Form fields ------------------------------------------------------------------------------------------------

/** `PlanCode`, `CurrencyCode` and the amount of `PlanPrice` of the platform document. */
const PLAN_CODE = /^[a-z][a-z0-9_]{1,39}$/;
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
/** The feature names of `PlanFeatures` and its `maxProperties`. */
const FEATURE_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
const FEATURES_MAX = 50;
/** A whole number as a form carries it; at most nine digits, so it is always a safe integer. */
const WHOLE = /^[0-9]{1,9}$/;
/** A plan version as the edit forms carry it (`AdminPlan.version`, at least 1). */
const VERSION = /^[1-9][0-9]{0,14}$/;
/** The lengths of `CreatePlanRequest.name` and `.description`, in code points. */
const NAME_MAX = 100;
const DESCRIPTION_MAX = 2000;

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Every text value of a repeated field, in order. */
function texts(formData: FormData, name: string): string[] {
  return formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));
}

/** The length of a text as the API's JSON Schema counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

/**
 * The form as submitted. The feature rows are the repeated `featureName` fields; a row is on when its position is
 * among the `featureOn` values (a checkbox sends its value only when it is checked).
 */
function valuesOf(formData: FormData): PlanFormValues {
  const on = new Set(texts(formData, "featureOn"));
  return {
    code: text(formData, "code"),
    name: text(formData, "name"),
    description: text(formData, "description"),
    currency: text(formData, "currency"),
    monthlyPrice: text(formData, "monthlyPrice"),
    annualPrice: text(formData, "annualPrice"),
    trialDays: text(formData, "trialDays"),
    staffSeats: text(formData, "staffSeats"),
    apiKeys: text(formData, "apiKeys"),
    customDomains: text(formData, "customDomains"),
    liveMode: text(formData, "liveMode") === "on",
    features: texts(formData, "featureName").map((name, index) => ({ name, on: on.has(String(index)) })),
    isPublic: text(formData, "isPublic") === "on",
    sortOrder: text(formData, "sortOrder"),
    settlementFeeBps: text(formData, "settlementFeeBps"),
  };
}

/** The fields both requests share, checked; `undefined` with the field errors when one is not valid. */
interface CheckedPlan {
  readonly name: string;
  readonly description: string | null;
  readonly currency: string;
  readonly monthlyPrice: string;
  readonly annualPrice: string | null;
  readonly trialDays: number;
  readonly limits: Schemas["PlanLimits"];
  readonly features: Record<string, boolean>;
  readonly isPublic: boolean;
  readonly sortOrder: number;
  readonly settlementFeeBps: number;
}

/** A whole number from `min` to `max`, or `undefined`. */
function whole(value: string, max: number): number | undefined {
  const trimmed = value.trim();
  if (!WHOLE.test(trimmed)) {
    return undefined;
  }
  const number = Number(trimmed);
  return number <= max ? number : undefined;
}

/** The feature flags of the rows, or the problem with them. Rows without a name are ignored. */
function featuresOf(rows: readonly FeatureRow[]): Record<string, boolean> | string {
  const features = new Map<string, boolean>();
  for (const row of rows) {
    const name = row.name.trim();
    if (name === "") {
      continue;
    }
    if (!FEATURE_NAME.test(name)) {
      return F.featureNameInvalid;
    }
    if (features.has(name)) {
      return F.featureDuplicate;
    }
    features.set(name, row.on);
  }
  return features.size > FEATURES_MAX ? F.featuresTooMany : Object.fromEntries(features);
}

/**
 * The shared fields of `values`, checked as `CreatePlanRequest` and `UpdatePlanRequest` check them (the API checks
 * them again, and the currency against `reference.currencies`).
 */
function checkPlan(
  values: PlanFormValues,
  fieldErrors: Partial<Record<PlanField, string>>,
): CheckedPlan | undefined {
  const name = values.name.trim();
  if (name === "") {
    fieldErrors.name = F.nameRequired;
  } else if (codePoints(name) > NAME_MAX) {
    fieldErrors.name = F.nameTooLong;
  }
  const description = values.description.trim();
  if (codePoints(description) > DESCRIPTION_MAX) {
    fieldErrors.description = F.descriptionTooLong;
  }
  const currency = values.currency.trim().toUpperCase();
  if (!CURRENCY.test(currency)) {
    fieldErrors.currency = F.currencyInvalid;
  }
  const monthlyPrice = values.monthlyPrice.trim();
  if (monthlyPrice === "") {
    fieldErrors.monthlyPrice = F.priceRequired;
  } else if (!AMOUNT.test(monthlyPrice)) {
    fieldErrors.monthlyPrice = F.priceInvalid;
  }
  const annualPrice = values.annualPrice.trim();
  if (annualPrice !== "" && !AMOUNT.test(annualPrice)) {
    fieldErrors.annualPrice = F.priceInvalid;
  }
  const trialDays = whole(values.trialDays, 365);
  if (trialDays === undefined) {
    fieldErrors.trialDays = F.trialDaysInvalid;
  }
  const staffSeats = whole(values.staffSeats, Number.MAX_SAFE_INTEGER);
  const apiKeys = whole(values.apiKeys, Number.MAX_SAFE_INTEGER);
  const customDomains = whole(values.customDomains, Number.MAX_SAFE_INTEGER);
  if (staffSeats === undefined) {
    fieldErrors.staffSeats = F.countInvalid;
  }
  if (apiKeys === undefined) {
    fieldErrors.apiKeys = F.countInvalid;
  }
  if (customDomains === undefined) {
    fieldErrors.customDomains = F.countInvalid;
  }
  const features = featuresOf(values.features);
  if (typeof features === "string") {
    fieldErrors.features = features;
  }
  const sortOrder = whole(values.sortOrder, 10_000);
  if (sortOrder === undefined) {
    fieldErrors.sortOrder = F.sortOrderInvalid;
  }
  const settlementFeeBps = whole(values.settlementFeeBps, 10_000);
  if (settlementFeeBps === undefined) {
    fieldErrors.settlementFeeBps = F.settlementFeeInvalid;
  }
  if (
    Object.keys(fieldErrors).length > 0 ||
    trialDays === undefined ||
    staffSeats === undefined ||
    apiKeys === undefined ||
    customDomains === undefined ||
    typeof features === "string" ||
    sortOrder === undefined ||
    settlementFeeBps === undefined
  ) {
    return undefined;
  }
  return {
    name,
    description: description === "" ? null : description,
    currency,
    monthlyPrice,
    annualPrice: annualPrice === "" ? null : annualPrice,
    trialDays,
    limits: { staffSeats, apiKeys, customDomains, liveMode: values.liveMode },
    features,
    isPublic: values.isPublic,
    sortOrder,
    settlementFeeBps,
  };
}

// ---- Answers ------------------------------------------------------------------------------------------------------

/** The fields of a plan the forms show. */
function editableOf(plan: AdminPlan): EditablePlan {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    currency: plan.currency,
    monthlyPrice: plan.monthlyPrice.amount,
    annualPrice: plan.annualPrice === null ? null : plan.annualPrice.amount,
    trialDays: plan.trialDays,
    limits: {
      staffSeats: plan.limits.staffSeats,
      apiKeys: plan.limits.apiKeys,
      customDomains: plan.limits.customDomains,
      liveMode: plan.limits.liveMode,
    },
    features: { ...plan.features },
    isPublic: plan.isPublic,
    isActive: plan.isActive,
    sortOrder: plan.sortOrder,
    settlementFeeBps: plan.settlementFeeBps,
    version: plan.version,
  };
}

/** The page of a plan; `/plans` for a new one. */
function planPath(code: string | undefined): string {
  return code === undefined ? "/plans" : `/plans/${code}`;
}

/** An ended session signs in again and comes back (the middleware renews a token that only expired). */
function signInIfEnded(error: ApiError, code: string | undefined): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: planPath(code) }).toString()}`);
  }
}

/** The plan forms' own words for the codes of a failed save that belong to no field. */
const FAILURE_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  PRECONDITION_FAILED: F.stale,
  NOT_FOUND: F.planGone,
  VALIDATION_FAILED: F.formExpired,
};

/** The message of a failure that belongs to no field. */
function messageOf(error: ApiError): string {
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return F.rateLimitedFor(error.retryAfterSeconds);
  }
  return FAILURE_MESSAGES[error.code] ?? errorMessage(error);
}

/**
 * The form field and message of one field error of the API, by the first segment of its JSON pointer and, for the
 * prices and the limits, the second; `undefined` for a pointer no field of the form shows.
 */
const FIELD_ERRORS: Readonly<
  Record<string, (nested: string | undefined, code: string) => [PlanField, string] | undefined>
> = {
  code: () => ["code", F.codeInvalid],
  name: () => ["name", F.nameTooLong],
  description: () => ["description", F.descriptionTooLong],
  currency: (_nested, code) => ["currency", code === "unknown" ? F.currencyUnknown : F.currencyInvalid],
  monthlyPrice: (nested) => ["monthlyPrice", nested === "currency" ? F.priceCurrency : F.priceInvalid],
  annualPrice: (nested) => ["annualPrice", nested === "currency" ? F.priceCurrency : F.priceInvalid],
  trialDays: () => ["trialDays", F.trialDaysInvalid],
  limits: (nested) =>
    nested === "staffSeats" || nested === "apiKeys" || nested === "customDomains"
      ? [nested, F.countInvalid]
      : undefined,
  features: () => ["features", F.featureNameInvalid],
  sortOrder: () => ["sortOrder", F.sortOrderInvalid],
  settlementFeeBps: () => ["settlementFeeBps", F.settlementFeeInvalid],
};

/** The form fields of the API's field errors (`path` is a JSON pointer into the request body). */
function apiFieldErrors(error: ApiError): Partial<Record<PlanField, string>> {
  const fieldErrors: Partial<Record<PlanField, string>> = {};
  for (const { path, code } of error.fieldErrors) {
    const [, top = "", nested] = path.split("/");
    const mapped = Object.hasOwn(FIELD_ERRORS, top) ? FIELD_ERRORS[top]?.(nested, code) : undefined;
    if (mapped !== undefined) {
      fieldErrors[mapped[0]] ??= mapped[1];
    }
  }
  return fieldErrors;
}

/** A refused save: the typed values stay, the version is unchanged, the problems are in the admin's words. */
function refused(
  version: number,
  values: PlanFormValues,
  code: PlatformErrorCode,
  problems: { readonly fieldErrors?: Partial<Record<PlanField, string>>; readonly message?: string },
): PlanFormState {
  return {
    status: "failed",
    code,
    version,
    values,
    fieldErrors: problems.fieldErrors ?? {},
    ...(problems.message === undefined ? {} : { message: problems.message }),
  };
}

/**
 * The state after a failed save: sign-in for an ended session, a step-up request for `REAUTH_REQUIRED` (the typed
 * values stay), field errors where the API names a field, otherwise the failure in the admin's words.
 */
function failedSave(
  previous: PlanFormState,
  version: number,
  values: PlanFormValues,
  error: ApiError,
  code: string | undefined,
): PlanFormState {
  signInIfEnded(error, code);
  if (error.code === "REAUTH_REQUIRED") {
    return { ...previous, values, stepUp: true };
  }
  if (error.code === "CONFLICT" && error.details["reason"] === "code_taken") {
    return refused(version, values, error.code, { fieldErrors: { code: F.codeTaken } });
  }
  const fieldErrors = error.code === "VALIDATION_FAILED" ? apiFieldErrors(error) : {};
  return Object.keys(fieldErrors).length > 0
    ? refused(version, values, error.code, { fieldErrors })
    : refused(version, values, error.code, { message: messageOf(error) });
}

// ---- Create ---------------------------------------------------------------------------------------------------------

/**
 * Creates a plan (`adminCreatePlan`) from the fields `code`, `name`, `description` (empty: none), `currency`,
 * `monthlyPrice`, `annualPrice` (empty: no yearly option), `trialDays`, the limits `staffSeats`, `apiKeys`,
 * `customDomains` and `liveMode`, the feature rows (`featureName`, `featureOn`), `isPublic`, `sortOrder` and
 * `settlementFeeBps`. The plan is active at once: when it is public, the portal's pricing page and its create-OTA
 * wizard offer it (`listPlans` answers the public, active plans). A taken code is shown at the code field.
 */
export async function createPlan(previous: PlanFormState, formData: FormData): Promise<PlanFormState> {
  const values = valuesOf(formData);
  const fieldErrors: Partial<Record<PlanField, string>> = {};
  const code = values.code.trim();
  if (!PLAN_CODE.test(code)) {
    fieldErrors.code = F.codeInvalid;
  }
  const plan = checkPlan(values, fieldErrors);
  if (plan === undefined || fieldErrors.code !== undefined) {
    return refused(0, values, "VALIDATION_FAILED", { fieldErrors });
  }

  const body: CreatePlanRequest = {
    code,
    name: plan.name,
    description: plan.description,
    currency: plan.currency,
    monthlyPrice: { amount: plan.monthlyPrice, currency: plan.currency },
    ...(plan.annualPrice === null
      ? {}
      : { annualPrice: { amount: plan.annualPrice, currency: plan.currency } }),
    limits: plan.limits,
    features: plan.features,
    isPublic: plan.isPublic,
    trialDays: plan.trialDays,
    settlementFeeBps: plan.settlementFeeBps,
    sortOrder: plan.sortOrder,
  };
  const api = await platformApi();
  const result = await api.POST("/v1/admin/plans", { body });
  if (result.error !== undefined) {
    return failedSave(previous, 0, values, result.error, undefined);
  }
  revalidatePath("/plans");
  return {
    status: "saved",
    version: result.data.version,
    values,
    fieldErrors: {},
    plan: editableOf(result.data),
  };
}

// ---- Edit -----------------------------------------------------------------------------------------------------------

/**
 * Saves the plan of the hidden field `planCode` (`adminUpdatePlan`) with the fields of `createPlan` except the code;
 * the hidden `currency` is the plan's, for its prices. The hidden `version` the page was rendered with goes into
 * `If-Match` (`"<version>"`), so a change made in the meantime answers `412 PRECONDITION_FAILED` and the form asks to
 * reload the page instead of overwriting it. An empty yearly price removes the yearly option (`null`). The API stores
 * only what changed and, for new limits or features, tells both backends to reload the plan.
 */
export async function updatePlan(previous: PlanFormState, formData: FormData): Promise<PlanFormState> {
  const values = valuesOf(formData);
  const code = text(formData, "planCode");
  const version = text(formData, "version");
  if (!PLAN_CODE.test(code) || !VERSION.test(version)) {
    // The form always carries both; without them a save could not be checked against the version shown.
    return refused(previous.version, values, "VALIDATION_FAILED", { message: F.formExpired });
  }
  const fieldErrors: Partial<Record<PlanField, string>> = {};
  const plan = checkPlan(values, fieldErrors);
  if (plan === undefined) {
    // The edit form carries the currency as a hidden field and shows no currency field, so a problem with it would
    // show nowhere: it means the form was not sent as the page rendered it.
    const { currency, ...shown } = fieldErrors;
    return refused(
      Number(version),
      values,
      "VALIDATION_FAILED",
      currency === undefined ? { fieldErrors } : { fieldErrors: shown, message: F.formExpired },
    );
  }

  const body: UpdatePlanRequest = {
    name: plan.name,
    description: plan.description,
    monthlyPrice: { amount: plan.monthlyPrice, currency: plan.currency },
    annualPrice: plan.annualPrice === null ? null : { amount: plan.annualPrice, currency: plan.currency },
    limits: plan.limits,
    features: plan.features,
    isPublic: plan.isPublic,
    trialDays: plan.trialDays,
    settlementFeeBps: plan.settlementFeeBps,
    sortOrder: plan.sortOrder,
  };
  const api = await platformApi();
  const result = await api.PATCH("/v1/admin/plans/{planCode}", {
    params: { path: { planCode: code }, header: { "If-Match": `"${version}"` } },
    body,
  });
  if (result.error !== undefined) {
    return failedSave(previous, Number(version), values, result.error, code);
  }
  revalidatePath(planPath(code));
  revalidatePath("/plans");
  return {
    status: "saved",
    version: result.data.version,
    values,
    fieldErrors: {},
    plan: editableOf(result.data),
  };
}

// ---- Retire and reactivate ----------------------------------------------------------------------------------------

/**
 * Retires the plan of the hidden field `planCode` (`isActive` = `false`) or makes it active again (`true`) with
 * `adminUpdatePlan` and the hidden `version` in `If-Match`. A retired plan leaves the pricing page and the create-OTA
 * wizard; its OTAs and subscriptions keep it.
 */
export async function setPlanActive(previous: PlanStatusState, formData: FormData): Promise<PlanStatusState> {
  const code = text(formData, "planCode");
  const version = text(formData, "version");
  const isActive = text(formData, "isActive");
  if (!PLAN_CODE.test(code) || !VERSION.test(version) || (isActive !== "true" && isActive !== "false")) {
    return { status: "failed", code: "VALIDATION_FAILED", message: F.formExpired };
  }

  const api = await platformApi();
  const result = await api.PATCH("/v1/admin/plans/{planCode}", {
    params: { path: { planCode: code }, header: { "If-Match": `"${version}"` } },
    body: { isActive: isActive === "true" },
  });
  if (result.error !== undefined) {
    const { error } = result;
    signInIfEnded(error, code);
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    return { status: "failed", code: error.code, message: messageOf(error) };
  }
  revalidatePath(planPath(code));
  revalidatePath("/plans");
  return { status: "done", isActive: result.data.isActive, version: result.data.version };
}
