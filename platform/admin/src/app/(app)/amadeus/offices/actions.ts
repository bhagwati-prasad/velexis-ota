"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError, type PlatformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  ADD_OFFICES_STRINGS as ADD,
  ASSIGN_OFFICE_STRINGS,
  OFFICE_ACTION_STRINGS as S,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  REASON_STRINGS,
} from "@/lib/strings";

/**
 * The server actions of `/amadeus/offices` (README §2 and §4; flows/amadeus-connection.md §A; PADR-0012; PF-90): add
 * offices to the pool of an account in bulk (`adminAddAmadeusOffices`), assign an available office to an OTA
 * (`adminAssignAmadeusOffice`), retire an available office (`adminRetireAmadeusOffice`, **reason**), and edit the notes
 * of an office (`adminUpdateAmadeusOffice`, `If-Match`). Releasing an office comes with PAD-014 (M5).
 *
 * Every action checks its form with Zod before it calls the platform API, so made-up fields send nothing. An ended
 * session goes to `/sign-in` and back to the pool; `REAUTH_REQUIRED` returns the previous state with `stepUp: true`, so
 * `useStepUpAction` asks for a TOTP code and runs the action again with the same form data. A success revalidates the
 * pool, the accounts page (its office counts) and the dashboard (the pool levels), and an assignment the OTA's page.
 * The states carry only what the forms show, in the admin's own words: never the API's message.
 */

type Schemas = components["schemas"];

/** A refused action, in the admin's words. */
export interface OfficeActionFailure {
  readonly status: "failed";
  /** The error code, for tests and the `data-code` of the notice; never shown. */
  readonly code: PlatformErrorCode;
  readonly message: string;
}

interface StepUpFlag {
  readonly stepUp?: true;
}

interface Idle {
  readonly status: "idle";
}

/** The fields of the bulk form. */
export type AddOfficesField = "amadeusAccountId" | "officeIds" | "notes";

/** The state of the bulk form. */
export type AddOfficesState = StepUpFlag &
  (
    | Idle
    | {
        readonly status: "done";
        /** The created offices' ids, in request order. */
        readonly created: readonly string[];
        /** The upper-cased ids skipped (already in the pool, or repeated in the request), in request order. */
        readonly skipped: readonly string[];
      }
    | (OfficeActionFailure & {
        /** Messages per field; the message above the form repeats nothing of them. */
        readonly fieldErrors: Readonly<Partial<Record<AddOfficesField, string>>>;
      })
  );

/** The state of the assign form of an office. */
export type AssignOfficeState = StepUpFlag &
  (
    | Idle
    | {
        readonly status: "done";
        readonly officeRowId: string;
        readonly officeId: string;
        readonly tenantId: string;
        readonly tenantKey: string;
        /** The status of the OTA's Amadeus connection of the office's environment, now `active`. */
        readonly connectionStatus: Schemas["AmadeusConnection"]["status"];
      }
    | (OfficeActionFailure & {
        readonly officeRowId: string;
        /** A problem with the OTA field, shown at the field. */
        readonly fieldError?: string;
      })
  );

/** The state of the retire action. */
export type RetireOfficeState = StepUpFlag &
  (
    | Idle
    | { readonly status: "done"; readonly officeRowId: string; readonly officeId: string }
    | (OfficeActionFailure & { readonly officeRowId: string })
  );

/** The state of the notes form of an office. */
export type OfficeNotesState = StepUpFlag &
  (
    | Idle
    | { readonly status: "done"; readonly officeRowId: string; readonly officeId: string }
    | (OfficeActionFailure & {
        readonly officeRowId: string;
        /** A problem with the notes, shown at the field. */
        readonly fieldError?: string;
      })
  );

// ---- Form fields ------------------------------------------------------------------------------------------------

/** `AmadeusAccountId`, `AmadeusOfficeRowId`, `TenantId` and `TenantKey` of the platform document. */
const ACCOUNT_ID = z.string().regex(/^ama_[0-9A-HJKMNP-TV-Z]{26}$/);
const OFFICE_ROW_ID = z.string().regex(/^amo_[0-9A-HJKMNP-TV-Z]{26}$/);
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;
const TENANT_KEY = /^[a-z][a-z0-9]{2,29}$/;
/** An office version as the notes form carries it (`AdminAmadeusOffice.version`, at least 1). */
const VERSION = z.string().regex(/^[1-9][0-9]{0,14}$/);
/** An item of `AddAmadeusOfficesRequest.officeIds`: 9 letters or digits, upper-cased by the API. */
const OFFICE_ID = /^[A-Za-z0-9]{9}$/;
/** `maxItems` of `officeIds`. */
const OFFICE_IDS_MAX = 500;
/** The `maxLength` of office notes (`AddAmadeusOfficesRequest.notes`, `UpdateAmadeusOfficeRequest.notes`). */
const NOTES_MAX = 2000;
/** The page size of a key lookup (the largest `limit` of `adminListTenants`). */
const TENANT_LOOKUP_LIMIT = 200;
/**
 * The most pages a key lookup reads (1,000 OTAs whose key, name or owner's e-mail address contains the key). Beyond
 * them the admin enters the tenant id; amadeus.test.tsx asserts this number, since a "use server" module exports
 * nothing but async functions.
 */
const TENANT_LOOKUP_PAGES = 5;

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The length of a text as the API's JSON Schema counts it: Unicode code points. */
function codePoints(value: string): number {
  return [...value].length;
}

/**
 * What is wrong with `value` as an `AdminReason` (5–500 code points after trimming), or `undefined`: the rule of
 * `reasonProblem` in `ReasonDialog`, which a server module cannot import (it is a client module).
 */
function reasonProblem(value: string): string | undefined {
  const length = codePoints(value.trim());
  if (length === 0) {
    return REASON_STRINGS.required;
  }
  if (length < REASON_MIN_LENGTH) {
    return REASON_STRINGS.tooShort;
  }
  return length > REASON_MAX_LENGTH ? REASON_STRINGS.tooLong : undefined;
}

// ---- Answers ------------------------------------------------------------------------------------------------------

const OFFICES_PATH = "/amadeus/offices";

/** An ended session signs in again and comes back to the pool (the middleware renews a token that only expired). */
function signInIfEnded(error: ApiError): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: OFFICES_PATH }).toString()}`);
  }
}

/** The admin's message for a failed call: the action's own for a code or a `CONFLICT` reason, else the catalogue's. */
function messageOf(
  error: ApiError,
  codes: Readonly<Partial<Record<PlatformErrorCode, string>>>,
  conflicts: Readonly<Record<string, string>> = {},
): string {
  const reason = error.details["reason"];
  if (error.code === "CONFLICT" && typeof reason === "string" && Object.hasOwn(conflicts, reason)) {
    return conflicts[reason] ?? errorMessage(error);
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return S.rateLimitedFor(error.retryAfterSeconds);
  }
  return codes[error.code] ?? errorMessage(error);
}

/** After a change of the pool: the pool, the accounts page (office counts) and the dashboard (pool levels). */
function revalidatePool(): void {
  revalidatePath(OFFICES_PATH);
  revalidatePath("/amadeus/accounts");
  revalidatePath("/");
}

// ---- Add in bulk --------------------------------------------------------------------------------------------------

/**
 * The office ids of the textarea: one per line, white space around each trimmed, empty lines dropped. `invalid` holds
 * the numbers (from 1) of the lines that are no office id; the API upper-cases the valid ones and skips repeats.
 */
function officeIdsOf(value: string): { ids: string[]; invalid: number[] } {
  const ids: string[] = [];
  const invalid: number[] = [];
  value.split(/\r\n|\r|\n/).forEach((line, index) => {
    const id = line.trim();
    if (id === "") {
      return;
    }
    if (OFFICE_ID.test(id)) {
      ids.push(id);
    } else {
      invalid.push(index + 1);
    }
  });
  return { ids, invalid };
}

function addRefused(
  code: PlatformErrorCode,
  fieldErrors: Partial<Record<AddOfficesField, string>>,
  message = "",
): AddOfficesState {
  return { status: "failed", code, message, fieldErrors };
}

/**
 * Adds offices to the pool of one account (`adminAddAmadeusOffices`) from the fields `amadeusAccountId`, `officeIds`
 * (a textarea, one id per line) and the optional `notes`. Every office is `available` at once. The answer lists the
 * created offices and the skipped ids, as the API answers them: an id the pool already holds, or one repeated in the
 * list, is skipped rather than refused.
 */
export async function addOffices(previous: AddOfficesState, formData: FormData): Promise<AddOfficesState> {
  const accountId = ACCOUNT_ID.safeParse(text(formData, "amadeusAccountId"));
  const { ids, invalid } = officeIdsOf(text(formData, "officeIds"));
  const notes = text(formData, "notes").trim();
  const fieldErrors: Partial<Record<AddOfficesField, string>> = {};
  if (!accountId.success) {
    fieldErrors.amadeusAccountId = ADD.accountInvalid;
  }
  if (invalid.length > 0) {
    fieldErrors.officeIds = ADD.officeIdsInvalid(invalid);
  } else if (ids.length === 0) {
    fieldErrors.officeIds = ADD.officeIdsRequired;
  } else if (ids.length > OFFICE_IDS_MAX) {
    fieldErrors.officeIds = ADD.tooMany;
  }
  if (codePoints(notes) > NOTES_MAX) {
    fieldErrors.notes = ADD.notesTooLong;
  }
  if (!accountId.success || Object.keys(fieldErrors).length > 0) {
    return addRefused("VALIDATION_FAILED", fieldErrors);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/amadeus-offices", {
    body: { amadeusAccountId: accountId.data, officeIds: ids, ...(notes === "" ? {} : { notes }) },
  });
  if (result.error !== undefined) {
    const { error } = result;
    signInIfEnded(error);
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    if (error.code === "VALIDATION_FAILED") {
      const paths = error.fieldErrors.map((field) => field.path);
      if (paths.some((path) => path.startsWith("/officeIds"))) {
        return addRefused(error.code, { officeIds: ADD.officeIdsRequired });
      }
      if (paths.includes("/notes")) {
        return addRefused(error.code, { notes: ADD.notesTooLong });
      }
    }
    return addRefused(
      error.code,
      {},
      messageOf(error, { NOT_FOUND: ADD.accountGone, VALIDATION_FAILED: ADD.formExpired }),
    );
  }
  revalidatePool();
  return {
    status: "done",
    created: result.data.created.map((office) => office.officeId),
    skipped: [...result.data.skipped],
  };
}

// ---- Assign to an OTA -------------------------------------------------------------------------------------------

/** The OTA field: a tenant id as it is, or the OTA of a key (`adminListTenants`, exact key); a refusal otherwise. */
type TenantLookup =
  | { readonly tenantId: string; readonly key?: string }
  | { readonly fieldError: string; readonly code: PlatformErrorCode }
  | { readonly error: ApiError };

async function tenantOf(api: PlatformApi, value: string): Promise<TenantLookup> {
  if (value === "") {
    return { fieldError: S.tenantRequired, code: "VALIDATION_FAILED" };
  }
  if (TENANT_ID.test(value)) {
    return { tenantId: value };
  }
  const key = value.toLowerCase();
  if (!TENANT_KEY.test(key)) {
    return { fieldError: S.tenantInvalid, code: "VALIDATION_FAILED" };
  }
  // `q` matches part of the key, the name or an owner's e-mail address, newest first: only the OTA with exactly this
  // key counts, and it may come after many newer OTAs that merely contain the key, so the lookup follows the pages.
  let cursor: string | undefined;
  for (let page = 0; page < TENANT_LOOKUP_PAGES; page += 1) {
    const result = await api.GET("/v1/admin/tenants", {
      params: {
        query: { q: key, limit: TENANT_LOOKUP_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
      },
    });
    if (result.error !== undefined) {
      return { error: result.error };
    }
    const tenant = result.data.data.find((row) => row.key === key);
    if (tenant !== undefined) {
      return { tenantId: tenant.id, key: tenant.key };
    }
    if (result.data.page.nextCursor === null) {
      return { fieldError: S.tenantUnknown, code: "NOT_FOUND" };
    }
    cursor = result.data.page.nextCursor;
  }
  return { fieldError: S.tenantTooManyMatches, code: "VALIDATION_FAILED" };
}

const ASSIGN_CODES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  AMADEUS_OFFICE_UNAVAILABLE: ASSIGN_OFFICE_STRINGS.officeUnavailable,
  NOT_FOUND: ASSIGN_OFFICE_STRINGS.notFound,
  VALIDATION_FAILED: S.formExpired,
};
const ASSIGN_CONFLICTS: Readonly<Record<string, string>> = {
  tenant_credentials: ASSIGN_OFFICE_STRINGS.tenantCredentials,
  office_already_assigned: ASSIGN_OFFICE_STRINGS.officeAlreadyAssigned,
};

/**
 * Assigns an available office to an OTA (`adminAssignAmadeusOffice`, PADR-0012) from the fields `officeRowId` and
 * `tenant`: the OTA's key (looked up with `adminListTenants`) or its tenant id. The API creates or completes the OTA's
 * `velexis` connection of the office's environment and makes it `active`; its owners get an e-mail. The answer is the
 * office, the OTA and the connection's status.
 */
export async function assignOfficeToTenant(
  previous: AssignOfficeState,
  formData: FormData,
): Promise<AssignOfficeState> {
  const officeRowId = OFFICE_ROW_ID.safeParse(text(formData, "officeRowId"));
  if (!officeRowId.success) {
    return { status: "failed", code: "VALIDATION_FAILED", message: S.formExpired, officeRowId: "" };
  }
  const api = await platformApi();
  const refused = (error: ApiError): AssignOfficeState => {
    signInIfEnded(error);
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    return {
      status: "failed",
      code: error.code,
      message: messageOf(error, ASSIGN_CODES, ASSIGN_CONFLICTS),
      officeRowId: officeRowId.data,
    };
  };

  const tenant = await tenantOf(api, text(formData, "tenant").trim());
  if ("fieldError" in tenant) {
    return {
      status: "failed",
      code: tenant.code,
      message: tenant.fieldError,
      fieldError: tenant.fieldError,
      officeRowId: officeRowId.data,
    };
  }
  if ("error" in tenant) {
    return refused(tenant.error);
  }
  const result = await api.POST("/v1/admin/amadeus-offices/{officeRowId}/assign", {
    params: { path: { officeRowId: officeRowId.data } },
    body: { tenantId: tenant.tenantId },
  });
  if (result.error !== undefined) {
    return refused(result.error);
  }
  const { office, connection } = result.data;
  revalidatePool();
  revalidatePath(`/tenants/${tenant.tenantId}`);
  return {
    status: "done",
    officeRowId: office.id,
    officeId: office.officeId,
    tenantId: tenant.tenantId,
    // An assigned office names its OTA; the fallbacks only serve an answer that breaks the contract.
    tenantKey: office.assignedTenant?.key ?? tenant.key ?? tenant.tenantId,
    connectionStatus: connection.status,
  };
}

// ---- Retire -------------------------------------------------------------------------------------------------------

/**
 * Retires an available office for good (`adminRetireAmadeusOffice`) from the fields `officeRowId`, `officeId` (for the
 * outcome's words) and `reason` (5–500 characters, kept in the audit log). An office in another status answers
 * `CONFLICT` (`not_available`).
 */
export async function retireOffice(
  previous: RetireOfficeState,
  formData: FormData,
): Promise<RetireOfficeState> {
  const officeRowId = OFFICE_ROW_ID.safeParse(text(formData, "officeRowId"));
  if (!officeRowId.success) {
    return { status: "failed", code: "VALIDATION_FAILED", message: S.formExpired, officeRowId: "" };
  }
  const reason = text(formData, "reason");
  const problem = reasonProblem(reason);
  if (problem !== undefined) {
    return { status: "failed", code: "VALIDATION_FAILED", message: problem, officeRowId: officeRowId.data };
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/amadeus-offices/{officeRowId}/retire", {
    params: { path: { officeRowId: officeRowId.data } },
    body: { reason: reason.trim() },
  });
  if (result.error !== undefined) {
    const { error } = result;
    signInIfEnded(error);
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    return {
      status: "failed",
      code: error.code,
      message: messageOf(
        error,
        { NOT_FOUND: S.officeGone, VALIDATION_FAILED: S.formExpired },
        { not_available: S.notAvailable },
      ),
      officeRowId: officeRowId.data,
    };
  }
  revalidatePool();
  return { status: "done", officeRowId: result.data.id, officeId: result.data.officeId };
}

// ---- Notes --------------------------------------------------------------------------------------------------------

/**
 * Replaces the notes of an office (`adminUpdateAmadeusOffice`) from the fields `officeRowId`, `version` and `notes`
 * (empty clears them): the version the page was rendered with goes into `If-Match` (`"<version>"`), so a change made
 * in the meantime answers `412 PRECONDITION_FAILED` and the form asks to reload instead of overwriting it.
 */
export async function saveOfficeNotes(
  previous: OfficeNotesState,
  formData: FormData,
): Promise<OfficeNotesState> {
  const officeRowId = OFFICE_ROW_ID.safeParse(text(formData, "officeRowId"));
  const version = VERSION.safeParse(text(formData, "version"));
  if (!officeRowId.success || !version.success) {
    return {
      status: "failed",
      code: "VALIDATION_FAILED",
      message: S.formExpired,
      officeRowId: officeRowId.data ?? "",
    };
  }
  const notes = text(formData, "notes").trim();
  if (codePoints(notes) > NOTES_MAX) {
    return {
      status: "failed",
      code: "VALIDATION_FAILED",
      message: S.notesTooLong,
      fieldError: S.notesTooLong,
      officeRowId: officeRowId.data,
    };
  }

  const api = await platformApi();
  const result = await api.PATCH("/v1/admin/amadeus-offices/{officeRowId}", {
    params: { path: { officeRowId: officeRowId.data }, header: { "If-Match": `"${version.data}"` } },
    body: { notes: notes === "" ? null : notes },
  });
  if (result.error !== undefined) {
    const { error } = result;
    signInIfEnded(error);
    if (error.code === "REAUTH_REQUIRED") {
      return { ...previous, stepUp: true };
    }
    if (error.code === "VALIDATION_FAILED" && error.fieldErrors.some((field) => field.path === "/notes")) {
      return {
        status: "failed",
        code: error.code,
        message: S.notesTooLong,
        fieldError: S.notesTooLong,
        officeRowId: officeRowId.data,
      };
    }
    return {
      status: "failed",
      code: error.code,
      message: messageOf(error, {
        PRECONDITION_FAILED: S.stale,
        NOT_FOUND: S.officeGone,
        VALIDATION_FAILED: S.formExpired,
      }),
      officeRowId: officeRowId.data,
    };
  }
  revalidatePath(OFFICES_PATH);
  return { status: "done", officeRowId: result.data.id, officeId: result.data.officeId };
}
