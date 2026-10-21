"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  ASSIGN_OFFICE_STRINGS,
  CONNECTION_STATUS_STRINGS,
  LIFECYCLE_STRINGS,
  MIGRATE_STRINGS,
  NOTES_STRINGS,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  REASON_STRINGS,
  TENANT_ACTION_STRINGS,
} from "@/lib/strings";

/**
 * The server actions of `/tenants/[tenantId]` (README §2 tenant key actions, §4; PADR-0014, PF-82): suspend and
 * resume (**reason**), migrate, disable or enable a connection (**reason**), edit the internal notes and the legal
 * name (`If-Match`), and assign an office of the pool to an OTA whose Amadeus connection waits for one.
 *
 * Every action checks its form with Zod before it calls the platform API, so an action called with made-up fields
 * sends nothing. A reason is checked as `AdminReason` counts it (5 to 500 code points after trimming), as
 * `ReasonDialog` does in the browser. An ended session goes to `/sign-in` and back to the tenant; `REAUTH_REQUIRED`
 * returns the previous state with `stepUp: true`, so `useStepUpAction` asks for a TOTP code and runs the action again
 * with the same form data. A success revalidates the tenant's page, so the page shows the new status, connection and
 * jobs (Next.js renders it again with the action's answer). The states carry only what the forms show, in the admin's
 * own words: never the API's message, and nothing of the answer the page does not show.
 */

type Schemas = components["schemas"];

/** What the forms show of the job an action created, as the jobs tab shows it. */
export interface JobOutcome {
  readonly id: string;
  readonly kind: Schemas["ProvisioningJobKind"];
  readonly status: Schemas["ProvisioningJobStatus"];
  readonly step: string | null;
}

/** A refused action, in the admin's words. */
export interface ActionFailure {
  readonly status: "failed";
  /** The error code, for tests and the `data-code` of the notice; never shown. */
  readonly code: PlatformErrorCode;
  readonly message: string;
}

/** The action's call answered `REAUTH_REQUIRED`: `useStepUpAction` asks for a TOTP code and runs it again. */
interface StepUpFlag {
  readonly stepUp?: true;
}

/** Nothing ran yet. */
interface Idle {
  readonly status: "idle";
}

/** The state of the suspend form and of the resume form. */
export type LifecycleState = StepUpFlag &
  (
    | Idle
    | {
        readonly status: "done";
        readonly action: "suspend" | "resume";
        /** The OTA's status after the change (`suspended`, `active`). */
        readonly tenantStatus: Schemas["TenantStatus"];
        /** The `suspend` or `resume` job that carries the OTA worker's part. */
        readonly job: JobOutcome;
      }
    | ActionFailure
  );

/** The state of the migrate form. */
export type MigrateState = StepUpFlag &
  (
    | Idle
    | { readonly status: "done"; readonly job: JobOutcome }
    | (ActionFailure & {
        /** A problem with the target version, shown at its field. */
        readonly fieldError?: string;
      })
  );

/** The connection kinds of `adminSetConnectionStatus`. */
export type ConnectionKind = "amadeus" | "payment";

/** The state of a connection's disable or enable form. */
export type ConnectionStatusState = StepUpFlag &
  (
    | Idle
    | {
        readonly status: "done";
        readonly kind: "amadeus";
        readonly connectionStatus: Schemas["AmadeusConnection"]["status"];
      }
    | {
        readonly status: "done";
        readonly kind: "payment";
        readonly connectionStatus: Schemas["PaymentConnection"]["status"];
      }
    | ActionFailure
  );

/** The fields of the notes form. */
export type NotesField = "notes" | "legalName";

/** The values of the notes form as typed; an empty field clears the value. */
export type NotesValues = Readonly<Record<NotesField, string>>;

/** The state of the notes form. */
export interface NotesState extends StepUpFlag {
  readonly status: "idle" | "saved" | "failed";
  /** The error code of a failure, for tests and the `data-code` of the notice; never shown. */
  readonly code?: PlatformErrorCode;
  /** The tenant version the next submission sends in `If-Match` (the saved one after a success). */
  readonly version: number;
  /** What the fields show: the saved values after a success, what was sent after a failure. */
  readonly values: NotesValues;
  /** Messages per field, in the admin's own words. */
  readonly fieldErrors: Readonly<Partial<Record<NotesField, string>>>;
  /** A problem that belongs to no field (stale version, rate limit, API unavailable). */
  readonly message?: string;
}

/** The state of the assign-an-office form. */
export type AssignOfficeState = StepUpFlag &
  (
    | Idle
    | {
        readonly status: "done";
        /** The 9-character Amadeus office id that was assigned. */
        readonly officeId: string;
        /** The status of the OTA's Amadeus connection of the office's environment, now `active`. */
        readonly connectionStatus: Schemas["AmadeusConnection"]["status"];
      }
    | ActionFailure
  );

// ---- Form fields ------------------------------------------------------------------------------------------------

/** `AdminTenantId`, `AmadeusOfficeRowId` and `TenantMigrationVersion` of the platform document. */
const TENANT_ID = z.string().regex(/^ten_[0-9A-HJKMNP-TV-Z]{26}$/);
const OFFICE_ROW_ID = z.string().regex(/^amo_[0-9A-HJKMNP-TV-Z]{26}$/);
const TARGET_VERSION = /^[0-9]{4,14}(_[a-z0-9_]+)?$/;
/** The longest `TenantMigrationVersion` the form accepts: a 14-digit number and a name (file names stay short). */
const TARGET_VERSION_MAX_LENGTH = 128;
/** `SuspendTenantRequest.suspensionReason`: `billing` is set by billing sync only (PADR-0014 item 1). */
const SUSPENSION_REASON = z.enum(["abuse", "request", "admin"]);
const CONNECTION_KIND = z.enum(["amadeus", "payment"]);
const ENVIRONMENT = z.enum(["test", "live"]);
/** `SetConnectionStatusRequest.status`. */
const CONNECTION_TARGET = z.enum(["active", "disabled"]);
/** A tenant version as the notes form carries it (`AdminTenant.version`, at least 1). */
const VERSION = /^[1-9][0-9]{0,14}$/;
/** `LegalName` and the notes of `UpdateAdminTenantRequest`. */
const LEGAL_NAME_MAX = 200;
const NOTES_MAX = 4000;

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
 * What is wrong with `value` as an `AdminReason` (5–500 code points after trimming), or `undefined`. The same rule as
 * `reasonProblem` of `ReasonDialog`, which a server module cannot import (it is a client module).
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

/** A form that cannot be sent as it is. */
function invalid(message: string): ActionFailure {
  return { status: "failed", code: "VALIDATION_FAILED", message };
}

// ---- Answers ------------------------------------------------------------------------------------------------------

/** The page of the tenant, which every action revalidates and an ended session returns to. */
function tenantPath(tenantId: string): string {
  return `/tenants/${tenantId}`;
}

/** The admin's message for a `CONFLICT` by its `details.reason`, and for other codes of one action. */
interface FailureMessages {
  readonly conflicts?: Readonly<Record<string, string>>;
  readonly codes?: Readonly<Partial<Record<PlatformErrorCode, string>>>;
}

/** The message for a failed call: the action's own for a known conflict or code, else the catalogue's. */
function messageOf(error: ApiError, messages: FailureMessages): string {
  const reason = error.details["reason"];
  if (error.code === "CONFLICT" && typeof reason === "string" && messages.conflicts !== undefined) {
    const conflict = Object.hasOwn(messages.conflicts, reason) ? messages.conflicts[reason] : undefined;
    if (conflict !== undefined) {
      return conflict;
    }
  }
  if (error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    return TENANT_ACTION_STRINGS.rateLimitedFor(error.retryAfterSeconds);
  }
  return messages.codes?.[error.code] ?? errorMessage(error);
}

/** An ended session signs in again and comes back to the tenant (the middleware renews a token that only expired). */
function signInIfEnded(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: tenantPath(tenantId) }).toString()}`);
  }
}

/**
 * The state after a failed call: sign-in for an ended session, a step-up request (the previous state with
 * `stepUp: true`) for `REAUTH_REQUIRED`, otherwise the failure in the admin's words.
 */
function failed<State extends object>(
  previous: State,
  error: ApiError,
  tenantId: string,
  messages: FailureMessages,
): State | ActionFailure {
  signInIfEnded(error, tenantId);
  if (error.code === "REAUTH_REQUIRED") {
    return { ...previous, stepUp: true };
  }
  return { status: "failed", code: error.code, message: messageOf(error, messages) };
}

/** The job of an answer, with only the fields the forms show. */
function jobOutcome(job: Schemas["AdminProvisioningJob"]): JobOutcome {
  return { id: job.id, kind: job.kind, status: job.status, step: job.step };
}

/** Codes every action of the page words the same way. */
const COMMON_CODES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  VALIDATION_FAILED: TENANT_ACTION_STRINGS.formExpired,
};

// ---- Suspend and resume -----------------------------------------------------------------------------------------

const LIFECYCLE_FAILURES: FailureMessages = {
  conflicts: {
    not_active: LIFECYCLE_STRINGS.notActive,
    not_suspended: LIFECYCLE_STRINGS.notSuspended,
    subscription_not_active: LIFECYCLE_STRINGS.subscriptionNotActive,
  },
  codes: { ...COMMON_CODES, NOT_FOUND: TENANT_ACTION_STRINGS.tenantGone },
};

/**
 * Suspends an active OTA (`adminSuspendTenant`, PADR-0014) from the fields `tenantId`, `suspensionReason` (`abuse`,
 * `request` or `admin`) and `reason` (5–500 characters, kept in the audit log). The answer is the OTA's new status and
 * the `suspend` job; the storefront and the OTA API answer `TENANT_SUSPENDED` within 60 seconds.
 */
export async function suspendTenant(previous: LifecycleState, formData: FormData): Promise<LifecycleState> {
  const tenantId = TENANT_ID.safeParse(text(formData, "tenantId"));
  if (!tenantId.success) {
    return invalid(TENANT_ACTION_STRINGS.formExpired);
  }
  const suspensionReason = SUSPENSION_REASON.safeParse(text(formData, "suspensionReason"));
  if (!suspensionReason.success) {
    return invalid(LIFECYCLE_STRINGS.suspensionReasonInvalid);
  }
  const reason = text(formData, "reason");
  const problem = reasonProblem(reason);
  if (problem !== undefined) {
    return invalid(problem);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/tenants/{tenantId}/suspend", {
    params: { path: { tenantId: tenantId.data } },
    body: { suspensionReason: suspensionReason.data, reason: reason.trim() },
  });
  if (result.error !== undefined) {
    return failed(previous, result.error, tenantId.data, LIFECYCLE_FAILURES);
  }
  revalidatePath(tenantPath(tenantId.data));
  return {
    status: "done",
    action: "suspend",
    tenantStatus: result.data.tenant.status,
    job: jobOutcome(result.data.job),
  };
}

/**
 * Resumes a suspended OTA (`adminResumeTenant`, PADR-0014 item 4) from the fields `tenantId` and `reason`. A billing
 * suspension resumes only while the subscription is `trialing` or `active` (`CONFLICT`, worded for the admin).
 */
export async function resumeTenant(previous: LifecycleState, formData: FormData): Promise<LifecycleState> {
  const tenantId = TENANT_ID.safeParse(text(formData, "tenantId"));
  if (!tenantId.success) {
    return invalid(TENANT_ACTION_STRINGS.formExpired);
  }
  const reason = text(formData, "reason");
  const problem = reasonProblem(reason);
  if (problem !== undefined) {
    return invalid(problem);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/tenants/{tenantId}/resume", {
    params: { path: { tenantId: tenantId.data } },
    body: { reason: reason.trim() },
  });
  if (result.error !== undefined) {
    return failed(previous, result.error, tenantId.data, LIFECYCLE_FAILURES);
  }
  revalidatePath(tenantPath(tenantId.data));
  return {
    status: "done",
    action: "resume",
    tenantStatus: result.data.tenant.status,
    job: jobOutcome(result.data.job),
  };
}

// ---- Migrate ------------------------------------------------------------------------------------------------------

const MIGRATE_FAILURES: FailureMessages = {
  conflicts: {
    migrate_job_active: MIGRATE_STRINGS.migrateJobActive,
    schema_missing: MIGRATE_STRINGS.schemaMissing,
  },
  codes: { ...COMMON_CODES, NOT_FOUND: TENANT_ACTION_STRINGS.tenantGone },
};

/**
 * Re-runs the tenant migrations of one OTA (`adminMigrateTenant`) from the fields `tenantId` and the optional
 * `targetVersion` (empty: every pending migration). The answer is the `migrate` job.
 */
export async function migrateTenant(previous: MigrateState, formData: FormData): Promise<MigrateState> {
  const tenantId = TENANT_ID.safeParse(text(formData, "tenantId"));
  if (!tenantId.success) {
    return invalid(TENANT_ACTION_STRINGS.formExpired);
  }
  const targetVersion = text(formData, "targetVersion").trim();
  if (
    targetVersion !== "" &&
    (targetVersion.length > TARGET_VERSION_MAX_LENGTH || !TARGET_VERSION.test(targetVersion))
  ) {
    return {
      ...invalid(MIGRATE_STRINGS.targetVersionInvalid),
      fieldError: MIGRATE_STRINGS.targetVersionInvalid,
    };
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/tenants/{tenantId}/migrate", {
    params: { path: { tenantId: tenantId.data } },
    body: targetVersion === "" ? {} : { targetVersion },
  });
  if (result.error !== undefined) {
    const { error } = result;
    if (
      error.code === "VALIDATION_FAILED" &&
      error.fieldErrors.some((field) => field.path === "/targetVersion")
    ) {
      return {
        status: "failed",
        code: error.code,
        message: MIGRATE_STRINGS.targetVersionInvalid,
        fieldError: MIGRATE_STRINGS.targetVersionInvalid,
      };
    }
    return failed(previous, error, tenantId.data, MIGRATE_FAILURES);
  }
  revalidatePath(tenantPath(tenantId.data));
  return { status: "done", job: jobOutcome(result.data.job) };
}

// ---- Connection status --------------------------------------------------------------------------------------------

const CONNECTION_FAILURES: FailureMessages = {
  conflicts: {
    not_disabled: CONNECTION_STATUS_STRINGS.notDisabled,
    no_office: CONNECTION_STATUS_STRINGS.noOffice,
    deauthorized: CONNECTION_STATUS_STRINGS.deauthorized,
  },
  codes: { ...COMMON_CODES, NOT_FOUND: CONNECTION_STATUS_STRINGS.connectionGone },
};

/**
 * Disables, or enables again, the Amadeus or payment connection of one environment (`adminSetConnectionStatus`) from
 * the fields `tenantId`, `kind` (`amadeus`, `payment`), `environment` (`test`, `live`), `status` (`disabled`,
 * `active`) and `reason`. The answer is the connection's new status; the OTA backend reloads the connection.
 */
export async function setConnectionStatus(
  previous: ConnectionStatusState,
  formData: FormData,
): Promise<ConnectionStatusState> {
  const tenantId = TENANT_ID.safeParse(text(formData, "tenantId"));
  const kind = CONNECTION_KIND.safeParse(text(formData, "kind"));
  const environment = ENVIRONMENT.safeParse(text(formData, "environment"));
  const status = CONNECTION_TARGET.safeParse(text(formData, "status"));
  if (!tenantId.success || !kind.success || !environment.success || !status.success) {
    return invalid(TENANT_ACTION_STRINGS.formExpired);
  }
  const reason = text(formData, "reason");
  const problem = reasonProblem(reason);
  if (problem !== undefined) {
    return invalid(problem);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/tenants/{tenantId}/connections/{kind}/{environment}/status", {
    params: { path: { tenantId: tenantId.data, kind: kind.data, environment: environment.data } },
    body: { status: status.data, reason: reason.trim() },
  });
  if (result.error !== undefined) {
    return failed(previous, result.error, tenantId.data, CONNECTION_FAILURES);
  }
  revalidatePath(tenantPath(tenantId.data));
  const connection = result.data;
  // `AdminConnection` is one of the two masked shapes; only the Amadeus one has a credential source.
  return "credentialSource" in connection
    ? { status: "done", kind: "amadeus", connectionStatus: connection.status }
    : { status: "done", kind: "payment", connectionStatus: connection.status };
}

// ---- Notes and legal name -----------------------------------------------------------------------------------------

/** The form fields of the API's field errors (`path` is a JSON pointer into the request body). */
function apiFieldErrors(error: ApiError): Partial<Record<NotesField, string>> {
  const fieldErrors: Partial<Record<NotesField, string>> = {};
  for (const { path } of error.fieldErrors) {
    if (path === "/notes") {
      fieldErrors.notes ??= NOTES_STRINGS.notesTooLong;
    } else if (path === "/legalName") {
      fieldErrors.legalName ??= NOTES_STRINGS.legalNameTooLong;
    }
  }
  return fieldErrors;
}

/** Messages of a failed `adminUpdateTenant` that belong to no field. */
const NOTES_FAILURES: FailureMessages = {
  codes: {
    ...COMMON_CODES,
    PRECONDITION_FAILED: NOTES_STRINGS.stale,
    NOT_FOUND: TENANT_ACTION_STRINGS.tenantGone,
  },
};

/**
 * Saves the internal notes and the legal name (`adminUpdateTenant`) from the fields `notes` and `legalName`, with the
 * hidden fields `tenantId` and `version`: the version the page was rendered with goes into `If-Match` (`"<version>"`),
 * so a change made in the meantime answers `412 PRECONDITION_FAILED` and the form asks to reload the page instead of
 * overwriting it. An empty field sends `null`, which clears the value. The answer is the saved values and the new
 * version.
 */
export async function saveTenantNotes(previous: NotesState, formData: FormData): Promise<NotesState> {
  const values: NotesValues = { notes: text(formData, "notes"), legalName: text(formData, "legalName") };
  const tenantId = TENANT_ID.safeParse(text(formData, "tenantId"));
  const version = text(formData, "version");
  const refused = (
    code: PlatformErrorCode,
    problems: { fieldErrors?: Partial<Record<NotesField, string>>; message?: string },
  ): NotesState => ({
    status: "failed",
    code,
    // A refused save changes nothing: the next one is checked against the same version.
    version: VERSION.test(version) ? Number(version) : previous.version,
    values,
    fieldErrors: problems.fieldErrors ?? {},
    ...(problems.message === undefined ? {} : { message: problems.message }),
  });

  if (!tenantId.success || !VERSION.test(version)) {
    // The form always carries both; without them a save could not be checked against the version shown.
    return refused("VALIDATION_FAILED", { message: TENANT_ACTION_STRINGS.formExpired });
  }
  const notes = values.notes.trim();
  const legalName = values.legalName.trim();
  const fieldErrors: Partial<Record<NotesField, string>> = {};
  if (codePoints(legalName) > LEGAL_NAME_MAX) {
    fieldErrors.legalName = NOTES_STRINGS.legalNameTooLong;
  }
  if (codePoints(notes) > NOTES_MAX) {
    fieldErrors.notes = NOTES_STRINGS.notesTooLong;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return refused("VALIDATION_FAILED", { fieldErrors });
  }

  const api = await platformApi();
  const result = await api.PATCH("/v1/admin/tenants/{tenantId}", {
    params: { path: { tenantId: tenantId.data }, header: { "If-Match": `"${version}"` } },
    body: { notes: notes === "" ? null : notes, legalName: legalName === "" ? null : legalName },
  });
  if (result.error !== undefined) {
    const { error } = result;
    signInIfEnded(error, tenantId.data);
    if (error.code === "REAUTH_REQUIRED") {
      // The fields keep what was typed while the step-up dialog asks for a code.
      return { ...previous, values, stepUp: true };
    }
    const apiFields = error.code === "VALIDATION_FAILED" ? apiFieldErrors(error) : {};
    return Object.keys(apiFields).length > 0
      ? refused(error.code, { fieldErrors: apiFields })
      : refused(error.code, { message: messageOf(error, NOTES_FAILURES) });
  }
  revalidatePath(tenantPath(tenantId.data));
  return {
    status: "saved",
    version: result.data.version,
    values: { notes: result.data.notes ?? "", legalName: result.data.legalName ?? "" },
    fieldErrors: {},
  };
}

// ---- Assign an office -------------------------------------------------------------------------------------------

const ASSIGN_FAILURES: FailureMessages = {
  conflicts: {
    tenant_credentials: ASSIGN_OFFICE_STRINGS.tenantCredentials,
    office_already_assigned: ASSIGN_OFFICE_STRINGS.officeAlreadyAssigned,
  },
  codes: {
    ...COMMON_CODES,
    AMADEUS_OFFICE_UNAVAILABLE: ASSIGN_OFFICE_STRINGS.officeUnavailable,
    NOT_FOUND: ASSIGN_OFFICE_STRINGS.notFound,
  },
};

/**
 * Assigns an available office of the pool to the OTA (`adminAssignAmadeusOffice`, PADR-0012) from the fields
 * `tenantId` and `officeRowId` (the pool entry `amo_…`). The API creates or completes the OTA's `velexis` Amadeus
 * connection of the office's environment and makes it `active`; the answer is the office id and that status.
 */
export async function assignAmadeusOffice(
  previous: AssignOfficeState,
  formData: FormData,
): Promise<AssignOfficeState> {
  const tenantId = TENANT_ID.safeParse(text(formData, "tenantId"));
  if (!tenantId.success) {
    return invalid(TENANT_ACTION_STRINGS.formExpired);
  }
  const officeRowId = OFFICE_ROW_ID.safeParse(text(formData, "officeRowId"));
  if (!officeRowId.success) {
    return invalid(ASSIGN_OFFICE_STRINGS.officeInvalid);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/admin/amadeus-offices/{officeRowId}/assign", {
    params: { path: { officeRowId: officeRowId.data } },
    body: { tenantId: tenantId.data },
  });
  if (result.error !== undefined) {
    return failed(previous, result.error, tenantId.data, ASSIGN_FAILURES);
  }
  revalidatePath(tenantPath(tenantId.data));
  return {
    status: "done",
    officeId: result.data.office.officeId,
    connectionStatus: result.data.connection.status,
  };
}
