"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { AMADEUS_ACCOUNT_FORM_STRINGS as S } from "@/lib/strings";

/**
 * The server actions of `/amadeus/accounts` (README §2 and §4; flows/amadeus-connection.md §A; ADR-0012, PADR-0006
 * item 4, PADR-0012 item 7; PF-90): create the Velexis Amadeus account of an environment (`adminCreateAmadeusAccount`,
 * step-up), edit its name, host or client id and rotate its client secret (`adminUpdateAmadeusAccount`, `If-Match`;
 * a new host, client id or secret needs a step-up), disable it, and verify it again (`adminVerifyAmadeusAccount`).
 *
 * Every action checks its form with Zod before it calls the platform API, so made-up fields send nothing. The client
 * secret travels from the form to the API in the request body only: it is never logged, never part of a state, a
 * message or a field error, so the browser never gets it back. An ended session goes to `/sign-in` and back to the
 * page; `REAUTH_REQUIRED` returns the previous state with `stepUp: true`, so `useStepUpAction` asks for a TOTP code and
 * runs the action again with the same form data. A success revalidates the page, so it shows the account as it is
 * now (a new or changed account `pending_verification` until the verification job has run).
 */

type Schemas = components["schemas"];

/** The fields of the account forms. The secret has one too, for its own messages; its value never comes back. */
export type AccountField = "name" | "baseUrl" | "clientId" | "clientSecret";

/** A refused action, in the admin's words. */
export interface AccountFailure {
  readonly status: "failed";
  /** The error code, for tests and the `data-code` of the notice; never shown. */
  readonly code: PlatformErrorCode;
  /** A problem that belongs to no field; absent when the problems are all at their fields. */
  readonly message?: string;
  /** Messages per field, in the admin's own words. */
  readonly fieldErrors: Readonly<Partial<Record<AccountField, string>>>;
}

/** The state of every account form. */
export type AccountActionState = { readonly stepUp?: true } & (
  | { readonly status: "idle" }
  | {
      readonly status: "done";
      /** The account's status after the action; `null` for a verification, which only queues the job. */
      readonly accountStatus: Schemas["AmadeusAccountStatus"] | null;
    }
  | AccountFailure
);

// ---- Form fields ------------------------------------------------------------------------------------------------

/** `AmadeusAccountId` of the platform document. */
const ACCOUNT_ID = z.string().regex(/^ama_[0-9A-HJKMNP-TV-Z]{26}$/);
/** An account version as the forms carry it (`AdminAmadeusAccount.version`, at least 1). */
const VERSION = z.string().regex(/^[1-9][0-9]{0,14}$/);
const ENVIRONMENT = z.enum(["test", "live"]);
/** `AmadeusBaseUrl`: an `https` host, or the loopback Amadeus stub (the API refuses it in production). */
const BASE_URL_PATTERN = /^(https:\/\/[^\s/?#]+(\/[^\s?#]*)?|http:\/\/127\.0\.0\.1(:[0-9]{1,5})?)$/;
const NO_WHITE_SPACE = /^\S+$/;

/** The length of a text as the API's JSON Schema counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

const NAME = z
  .string()
  .trim()
  .min(1, S.nameRequired)
  .refine((value) => codePoints(value) <= 100, S.nameTooLong);
const BASE_URL = z
  .string()
  .trim()
  .refine((value) => value.length <= 300 && BASE_URL_PATTERN.test(value), S.baseUrlInvalid);
const CLIENT_ID = z
  .string()
  .trim()
  .min(1, S.clientIdRequired)
  .refine((value) => codePoints(value) <= 200 && NO_WHITE_SPACE.test(value), S.clientIdInvalid);
/** Trimmed: a pasted secret often carries a line break; Amadeus secrets hold no white space. */
const CLIENT_SECRET = z
  .string()
  .trim()
  .min(1, S.clientSecretRequired)
  .refine((value) => codePoints(value) <= 512, S.clientSecretTooLong);

const CREATE_FIELDS = z.object({
  name: NAME,
  baseUrl: BASE_URL,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
});
/** An empty client id keeps the current one. */
const DETAIL_FIELDS = z.object({
  name: NAME,
  baseUrl: BASE_URL,
  clientId: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || (codePoints(value) <= 200 && NO_WHITE_SPACE.test(value)),
      S.clientIdInvalid,
    ),
});
const SECRET_FIELDS = z.object({ clientSecret: CLIENT_SECRET });

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function isAccountField(value: unknown): value is AccountField {
  return value === "name" || value === "baseUrl" || value === "clientId" || value === "clientSecret";
}

/** A form that cannot be sent as it is: a hidden field the admin cannot change is missing or invalid. */
function expired(): AccountFailure {
  return { status: "failed", code: "VALIDATION_FAILED", message: S.formExpired, fieldErrors: {} };
}

/** The messages of a refused form, per field: only the messages of this module, never a submitted value. */
function fieldFailure(error: z.ZodError): AccountFailure {
  const fieldErrors: Partial<Record<AccountField, string>> = {};
  for (const issue of error.issues) {
    const [field] = issue.path;
    if (isAccountField(field)) {
      fieldErrors[field] ??= issue.message;
    }
  }
  return { status: "failed", code: "VALIDATION_FAILED", fieldErrors };
}

// ---- Answers ------------------------------------------------------------------------------------------------------

const ACCOUNTS_PATH = "/amadeus/accounts";

/** The message of a field the API refused (`path` is a JSON pointer into the request body). */
const API_FIELD_MESSAGES: Readonly<Record<string, readonly [AccountField, string]>> = {
  "/name": ["name", S.nameTooLong],
  "/baseUrl": ["baseUrl", S.baseUrlInvalid],
  "/clientId": ["clientId", S.clientIdInvalid],
  "/clientSecret": ["clientSecret", S.clientSecretTooLong],
};

/** Codes every account action words its own way; the others get the catalogue's message. */
const ACCOUNT_CODES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  PRECONDITION_FAILED: S.stale,
  NOT_FOUND: S.accountGone,
  // The fields are checked before the call, so a refusal of anything else means the form is out of date.
  VALIDATION_FAILED: S.formExpired,
};

/** The admin's message for a failed call that belongs to no field; `codes` words some codes for one action. */
function messageOf(error: ApiError, codes: Readonly<Partial<Record<PlatformErrorCode, string>>>): string {
  if (error.code === "CONFLICT" && error.details["reason"] === "environment_exists") {
    return S.environmentExists;
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return S.rateLimitedFor(error.retryAfterSeconds);
  }
  return codes[error.code] ?? ACCOUNT_CODES[error.code] ?? errorMessage(error);
}

/**
 * The state after a failed call: sign-in (and back to the page) for an ended session, a step-up request (the previous
 * state with `stepUp: true`) for `REAUTH_REQUIRED`, the API's field errors at their fields, otherwise the failure in
 * the admin's words.
 */
function failed(
  previous: AccountActionState,
  error: ApiError,
  codes: Readonly<Partial<Record<PlatformErrorCode, string>>> = {},
): AccountActionState {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: ACCOUNTS_PATH }).toString()}`);
  }
  if (error.code === "REAUTH_REQUIRED") {
    return { ...previous, stepUp: true };
  }
  if (error.code === "VALIDATION_FAILED") {
    const fieldErrors: Partial<Record<AccountField, string>> = {};
    for (const { path } of error.fieldErrors) {
      const known = Object.hasOwn(API_FIELD_MESSAGES, path) ? API_FIELD_MESSAGES[path] : undefined;
      if (known !== undefined) {
        fieldErrors[known[0]] ??= known[1];
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      return { status: "failed", code: error.code, fieldErrors };
    }
  }
  return { status: "failed", code: error.code, message: messageOf(error, codes), fieldErrors: {} };
}

/** After a change: the accounts page, and the pages that list the accounts or their pools. */
function revalidateAccounts(): void {
  revalidatePath(ACCOUNTS_PATH);
  revalidatePath("/amadeus/offices");
  revalidatePath("/");
}

// ---- Create -------------------------------------------------------------------------------------------------------

/**
 * Creates the Velexis Amadeus account of one environment (`adminCreateAmadeusAccount`, step-up) from the fields
 * `environment`, `name`, `baseUrl`, `clientId` and `clientSecret`. The API encrypts the secret at once and answers the
 * account `pending_verification`; the verification job then makes it `active` or `invalid_credentials`. An
 * environment that already has an account answers `CONFLICT` (`environment_exists`).
 */
export async function createAmadeusAccount(
  previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const environment = ENVIRONMENT.safeParse(text(formData, "environment"));
  if (!environment.success) {
    return expired();
  }
  const fields = CREATE_FIELDS.safeParse({
    name: text(formData, "name"),
    baseUrl: text(formData, "baseUrl"),
    clientId: text(formData, "clientId"),
    clientSecret: text(formData, "clientSecret"),
  });
  if (!fields.success) {
    return fieldFailure(fields.error);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/amadeus-accounts", {
    body: { environment: environment.data, ...fields.data },
  });
  if (result.error !== undefined) {
    return failed(previous, result.error);
  }
  revalidateAccounts();
  return { status: "done", accountStatus: result.data.status };
}

// ---- Update: details, secret, disable -----------------------------------------------------------------------------

/** The account and the version of the page, which goes into `If-Match`; `undefined` when either is invalid. */
function target(formData: FormData): { accountId: string; version: string } | undefined {
  const accountId = ACCOUNT_ID.safeParse(text(formData, "accountId"));
  const version = VERSION.safeParse(text(formData, "version"));
  return accountId.success && version.success
    ? { accountId: accountId.data, version: version.data }
    : undefined;
}

/** `adminUpdateAmadeusAccount` with the page's version in `If-Match` (`"<version>"`). */
async function updateAccount(
  previous: AccountActionState,
  account: { accountId: string; version: string },
  body: Schemas["UpdateAmadeusAccountRequest"],
): Promise<AccountActionState> {
  const api = await platformApi();
  const result = await api.PATCH("/v1/admin/amadeus-accounts/{accountId}", {
    params: { path: { accountId: account.accountId }, header: { "If-Match": `"${account.version}"` } },
    body,
  });
  if (result.error !== undefined) {
    return failed(previous, result.error);
  }
  revalidateAccounts();
  return { status: "done", accountStatus: result.data.status };
}

/**
 * Saves the name, the host and the client id of an account from the fields `accountId`, `version`, `name`, `baseUrl`
 * and `clientId` (empty keeps the current one). A new host or client id needs a step-up, and the API sets the account
 * `pending_verification` and verifies it again; a new name changes nothing else.
 */
export async function updateAmadeusAccountDetails(
  previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const account = target(formData);
  if (account === undefined) {
    return expired();
  }
  const fields = DETAIL_FIELDS.safeParse({
    name: text(formData, "name"),
    baseUrl: text(formData, "baseUrl"),
    clientId: text(formData, "clientId"),
  });
  if (!fields.success) {
    return fieldFailure(fields.error);
  }
  const { name, baseUrl, clientId } = fields.data;
  return updateAccount(previous, account, { name, baseUrl, ...(clientId === "" ? {} : { clientId }) });
}

/**
 * Rotates the client secret of an account from the fields `accountId`, `version` and `clientSecret` (step-up). The API
 * encrypts the new secret as on creation, sets the account `pending_verification`, verifies it again and tells the
 * OTA backend to drop its cached account; office assignments are unaffected (PADR-0012 item 7).
 */
export async function rotateAmadeusAccountSecret(
  previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const account = target(formData);
  if (account === undefined) {
    return expired();
  }
  const fields = SECRET_FIELDS.safeParse({ clientSecret: text(formData, "clientSecret") });
  if (!fields.success) {
    return fieldFailure(fields.error);
  }
  return updateAccount(previous, account, { clientSecret: fields.data.clientSecret });
}

/**
 * Disables an account (`status: disabled`) from the fields `accountId` and `version`: every OTA on the shared account
 * of that environment loses Amadeus access until a verification makes it active again.
 */
export async function disableAmadeusAccount(
  previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const account = target(formData);
  if (account === undefined) {
    return expired();
  }
  return updateAccount(previous, account, { status: "disabled" });
}

// ---- Verify -------------------------------------------------------------------------------------------------------

/**
 * Queues the verification of an account again (`adminVerifyAmadeusAccount`) from the field `accountId`. The answer
 * comes before the job runs; a disabled account becomes `pending_verification` first, and active once Amadeus accepts
 * its credentials. `SERVICE_UNAVAILABLE` when Redis does not take the job.
 */
export async function verifyAmadeusAccount(
  previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const accountId = ACCOUNT_ID.safeParse(text(formData, "accountId"));
  if (!accountId.success) {
    return expired();
  }
  const api = await platformApi();
  const result = await api.POST("/v1/admin/amadeus-accounts/{accountId}/verify", {
    params: { path: { accountId: accountId.data } },
  });
  if (result.error !== undefined) {
    // The job is the whole effect of a verification: Redis not taking it fails the action.
    return failed(previous, result.error, { SERVICE_UNAVAILABLE: S.verifyUnavailable });
  }
  revalidatePath(ACCOUNTS_PATH);
  return { status: "done", accountStatus: null };
}
