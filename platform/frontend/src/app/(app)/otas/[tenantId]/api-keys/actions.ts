"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  MAX_ALLOWED_ORIGINS,
  originMessage,
  originProblem,
  type OriginEnvironment,
} from "@/components/origins-field";
import {
  isConsoleScope,
  isPermission,
  scopeMessage,
  scopeProblem,
  scopesOf,
  STAFF_PERMISSIONS,
} from "@/components/scope-picker";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { API_KEYS_STRINGS } from "@/lib/strings";
import { isTenantId } from "@/lib/tenant";

/**
 * The server actions of the API keys page (README §2 `/otas/[tenantId]/api-keys` and §5; flow api-keys.md; PADR-0005;
 * PF-30): `createKey` (`createApiKey`), `updateKey` (`updateApiKey`: name and origins), `rollKey` (`rollApiKey`) and
 * `revokeKey` (`revokeApiKey`). Each checks the form first (with the origin and scope rules of `OriginsField` and
 * `ScopePicker`, which the API checks again), calls the API with the session and the end-user headers
 * (`platformApi()`), maps the API's field errors to the form's fields, and revalidates the page after a change, so its
 * list shows the change.
 *
 * The full key of a create or a roll leaves the server only in the action's answer: it is never logged, stored,
 * cached, put in a cookie or in a URL (README §5, PADR-0005 item 4), and the page never reads it, so a reload no
 * longer shows it. Messages are the portal's own text, never the API's. `createKey` and `rollKey` answer `stepUp`
 * when the API asks for a TOTP step-up (`REAUTH_REQUIRED`: a live secret key), and `useStepUpAction` re-submits.
 */

type Schemas = components["schemas"];

/** An API key as `listApiKeys` answers it: never the key itself. */
export type ApiKey = Schemas["ApiKey"];
/** `publishable` or `secret`. */
export type ApiKeyKind = Schemas["ApiKeyKind"];
/** `test` or `live`. */
export type ApiKeyEnvironment = Schemas["Environment"];
/** When the old key stops working after a roll. */
export type ExpireOldIn = Schemas["RollApiKeyRequest"]["expireOldIn"];
/** The optional expiry of a new key, from now. */
export type KeyExpiry = "never" | "7d" | "30d" | "90d" | "365d";

/** The problems of the create and edit forms, in the portal's words. */
export interface KeyFieldErrors {
  readonly name?: string;
  readonly kind?: string;
  /** A problem of the origins as a whole (too many). */
  readonly allowedOrigins?: string;
  /** Problems of single origins, by their row in the form (`"0"` is the first row). */
  readonly origins?: Readonly<Record<string, string>>;
  readonly scopes?: string;
  readonly expiresIn?: string;
}

/** The state of the create form. */
export interface CreateKeyState {
  readonly status: "idle" | "created" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  readonly fieldErrors: KeyFieldErrors;
  /** A problem that belongs to no field. */
  readonly message?: string;
  /** The new key, shown once: it lives in this state (React state in the browser) and nowhere else. */
  readonly created?: { readonly apiKey: ApiKey; readonly key: string };
  /** The API asked for a TOTP step-up (`StepUpRequired`). */
  readonly stepUp?: true;
}

/** The state of an edit form. */
export interface UpdateKeyState {
  readonly status: "idle" | "saved" | "failed";
  readonly code?: PlatformErrorCode;
  readonly fieldErrors: KeyFieldErrors;
  readonly message?: string;
}

/** The new key of a roll, shown once, and when the old key stops working. */
export interface RolledKey {
  readonly apiKey: ApiKey;
  readonly key: string;
  readonly expireOldIn: ExpireOldIn;
  /** The old key and its new expiry (`previous` of the answer). */
  readonly previous: { readonly id: string; readonly expiresAt: string };
  /**
   * The old key no longer works: rolled with `now`, or its expiry had already passed. The API never moves an expiry
   * later (an expired key keeps its past `expiresAt`, one that ends sooner keeps its own), so `expireOldIn` alone
   * does not say it.
   */
  readonly oldKeyStopped: boolean;
}

/** The state of a roll form. */
export interface RollKeyState {
  readonly status: "idle" | "rolled" | "failed";
  readonly code?: PlatformErrorCode;
  readonly message?: string;
  readonly rolled?: RolledKey;
  /** The API asked for a TOTP step-up (`StepUpRequired`). */
  readonly stepUp?: true;
}

/** The state of a revoke. */
export interface RevokeKeyState {
  readonly status: "idle" | "revoked" | "failed";
  readonly code?: PlatformErrorCode;
  readonly message?: string;
}

/** An API key id (`ApiKeyId` of the platform document: `key_` + ULID). */
const KEY_ID = /^key_[0-9A-HJKMNP-TV-Z]{26}$/;

const NAME_MAX = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRY_DAYS: Readonly<Record<Exclude<KeyExpiry, "never">, number>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

const EXPIRE_OLD_IN: readonly ExpireOldIn[] = ["now", "1h", "24h", "7d"];

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Every text value of a repeated field, in form order. */
function texts(formData: FormData, name: string): string[] {
  return formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));
}

function isEnvironment(value: string): value is ApiKeyEnvironment {
  return value === "test" || value === "live";
}

function isKind(value: string): value is ApiKeyKind {
  return value === "publishable" || value === "secret";
}

function isKeyExpiry(value: string): value is KeyExpiry {
  return value === "never" || Object.hasOwn(EXPIRY_DAYS, value);
}

function isExpireOldIn(value: string): value is ExpireOldIn {
  return (EXPIRE_OLD_IN as readonly string[]).includes(value);
}

/** The problem of a key's name (trimmed), counted in code points as the API's JSON Schema counts them. */
function nameProblem(name: string): string | undefined {
  if (name === "") {
    return API_KEYS_STRINGS.nameRequired;
  }
  return [...name].length > NAME_MAX ? API_KEYS_STRINGS.nameTooLong : undefined;
}

/** The origins the form sends: the non-empty rows, trimmed, each with the row it came from. */
interface SentOrigins {
  readonly origins: string[];
  /** The form row of each sent origin, so the API's `/allowedOrigins/<n>` lands at the right input. */
  readonly rows: number[];
}

function sentOrigins(formData: FormData): SentOrigins {
  const origins: string[] = [];
  const rows: number[] = [];
  texts(formData, "allowedOrigins").forEach((value, row) => {
    const origin = value.trim();
    if (origin !== "") {
      origins.push(origin);
      rows.push(row);
    }
  });
  return { origins, rows };
}

/** The portal's checks of the origins (PADR-0005 item 5): each origin, duplicates, and the count. */
function originErrors(sent: SentOrigins, environment: OriginEnvironment): KeyFieldErrors {
  const origins: Record<string, string> = {};
  const seen = new Set<string>();
  sent.origins.forEach((origin, index) => {
    const row = String(sent.rows[index]);
    const problem = originProblem(origin, environment);
    if (problem !== undefined) {
      origins[row] = originMessage(problem, environment);
    } else if (seen.has(origin)) {
      origins[row] = API_KEYS_STRINGS.originDuplicate;
    }
    seen.add(origin);
  });
  return {
    ...(sent.origins.length > MAX_ALLOWED_ORIGINS ? { allowedOrigins: API_KEYS_STRINGS.originsTooMany } : {}),
    ...(Object.keys(origins).length > 0 ? { origins } : {}),
  };
}

function hasErrors(errors: KeyFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The form fields of the API's field errors (`path` is a JSON pointer into the request body); the origins of
 * `/allowedOrigins/<n>` go to the row they were typed in. Paths outside the form (the environment, the path
 * parameters) are not the person's to fix and are left out: the caller then says the form has expired.
 */
function apiFieldErrors(
  error: ApiError,
  environment: OriginEnvironment,
  rows: readonly number[] = [],
): KeyFieldErrors {
  const errors: {
    -readonly [Field in keyof KeyFieldErrors]: KeyFieldErrors[Field];
  } = {};
  const origins: Record<string, string> = {};
  for (const fieldError of error.fieldErrors) {
    const { path, code } = fieldError;
    const origin = /^\/allowedOrigins\/(\d+)$/.exec(path);
    if (path === "/name") {
      errors.name ??= code === "minLength" ? API_KEYS_STRINGS.nameRequired : API_KEYS_STRINGS.nameTooLong;
    } else if (path === "/kind") {
      errors.kind ??= API_KEYS_STRINGS.kindRequired;
    } else if (origin !== null) {
      const row = String(rows[Number(origin[1])] ?? Number(origin[1]));
      origins[row] ??= originMessage(code, environment);
    } else if (path === "/allowedOrigins") {
      // `notAllowed` (origins for a secret key) is nothing the form sends: it reads as an expired form.
      if (code === "uniqueItems") {
        errors.allowedOrigins ??= API_KEYS_STRINGS.originDuplicate;
      } else if (code === "maxItems") {
        errors.allowedOrigins ??= API_KEYS_STRINGS.originsTooMany;
      }
    } else if (/^\/scopes(\/\d+)?$/.test(path) && code !== "notAllowed") {
      // `notAllowed` (scopes for a publishable key) is nothing the form sends either.
      errors.scopes ??= scopeMessage(code);
    } else if (path === "/expiresAt") {
      errors.expiresIn ??= API_KEYS_STRINGS.expiryInvalid;
    }
  }
  if (Object.keys(origins).length > 0) {
    errors.origins = origins;
  }
  return errors;
}

/** Messages of failures that belong to no field; other codes get the portal's message for the code. */
const FAILURE_MESSAGES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  CONFLICT: API_KEYS_STRINGS.revokedMeanwhile,
  TENANT_NOT_ACTIVE: API_KEYS_STRINGS.notActive,
  FORBIDDEN: API_KEYS_STRINGS.forbidden,
  NOT_FOUND: API_KEYS_STRINGS.removed,
  RATE_LIMITED: API_KEYS_STRINGS.rateLimited,
  VALIDATION_FAILED: API_KEYS_STRINGS.formExpired,
};

/** A whole number of `details`, or `undefined`. */
function detailNumber(error: ApiError, name: string): number | undefined {
  const value = error.details[name];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function failureMessage(error: ApiError): string {
  if (error.code === "PLAN_LIMIT_REACHED") {
    return API_KEYS_STRINGS.planLimit(detailNumber(error, "limit"), detailNumber(error, "used"));
  }
  return FAILURE_MESSAGES[error.code] ?? errorMessage(error);
}

/**
 * Ends the request when the session is over: sign in again and come back to the API keys page; an unverified account
 * goes to `/verify-pending` (the middleware renews an access token that is only expired).
 */
function leaveOnSessionEnd(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/api-keys") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

/** Renders the API keys page again, so its list shows the change. */
function refreshKeys(tenantId: string): void {
  revalidatePath(otaPath(tenantId, "/api-keys"));
}

/**
 * Creates a key from the fields `name`, `kind`, `allowedOrigins` (publishable: one per row), `scope` and
 * `permissions` (secret) and `expiresIn`, with the hidden `tenantId` and `environment`. Answers the new key once.
 */
export async function createKey(_previous: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const tenantId = text(formData, "tenantId");
  const environment = text(formData, "environment");
  const failed = (
    code: PlatformErrorCode,
    problems: { fieldErrors?: KeyFieldErrors; message?: string; stepUp?: true },
  ): CreateKeyState => ({
    status: "failed",
    code,
    fieldErrors: problems.fieldErrors ?? {},
    ...(problems.message === undefined ? {} : { message: problems.message }),
    ...(problems.stepUp === undefined ? {} : { stepUp: problems.stepUp }),
  });
  if (!isTenantId(tenantId) || !isEnvironment(environment)) {
    // The form always carries both.
    return failed("VALIDATION_FAILED", { message: API_KEYS_STRINGS.formExpired });
  }

  const name = text(formData, "name").trim();
  const kind = text(formData, "kind");
  const expiresIn = text(formData, "expiresIn") || "never";
  const sent = sentOrigins(formData);
  const scope = text(formData, "scope");
  const permissions = texts(formData, "permissions");

  const errors: { -readonly [Field in keyof KeyFieldErrors]: KeyFieldErrors[Field] } = {};
  const nameError = nameProblem(name);
  if (nameError !== undefined) {
    errors.name = nameError;
  }
  let access: { allowedOrigins: string[] } | { scopes: string[] } | undefined;
  if (!isKind(kind)) {
    errors.kind = API_KEYS_STRINGS.kindRequired;
  } else if (kind === "publishable") {
    // A publishable key has customer scope only: the form sends no scopes for it.
    Object.assign(errors, originErrors(sent, environment));
    access = { allowedOrigins: sent.origins };
  } else if (!isConsoleScope(scope)) {
    errors.scopes = scopeMessage(scope === "" ? "scopeRequired" : "unknownScope");
  } else if (!permissions.every(isPermission)) {
    errors.scopes = scopeMessage("unknownScope");
  } else {
    // In the order of the OTA document, each once.
    const chosen = STAFF_PERMISSIONS.filter((permission) => permissions.includes(permission));
    const scopes = scopesOf({ scope, permissions: chosen });
    const problem = scopeProblem(scopes);
    if (problem !== undefined) {
      errors.scopes = scopeMessage(problem);
    }
    access = { scopes };
  }
  if (!isKeyExpiry(expiresIn)) {
    errors.expiresIn = API_KEYS_STRINGS.expiryInvalid;
  }
  if (hasErrors(errors) || access === undefined || !isKind(kind) || !isKeyExpiry(expiresIn)) {
    return failed("VALIDATION_FAILED", { fieldErrors: errors });
  }

  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/api-keys", {
    params: { path: { tenantId } },
    body: {
      name,
      kind,
      environment,
      ...access,
      ...(expiresIn === "never"
        ? {}
        : { expiresAt: new Date(Date.now() + EXPIRY_DAYS[expiresIn] * DAY_MS).toISOString() }),
    },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    if (result.error.code === "REAUTH_REQUIRED") {
      return failed("REAUTH_REQUIRED", { stepUp: true });
    }
    const fieldErrors =
      result.error.code === "VALIDATION_FAILED" ? apiFieldErrors(result.error, environment, sent.rows) : {};
    return hasErrors(fieldErrors)
      ? failed(result.error.code, { fieldErrors })
      : failed(result.error.code, { message: failureMessage(result.error) });
  }
  refreshKeys(tenantId);
  return {
    status: "created",
    fieldErrors: {},
    created: { apiKey: result.data.apiKey, key: result.data.key },
  };
}

/** The key of a row's form: the hidden `tenantId` and `keyId`, checked before any call. */
function keyOf(formData: FormData): { tenantId: string; keyId: string } | undefined {
  const tenantId = text(formData, "tenantId");
  const keyId = text(formData, "keyId");
  return isTenantId(tenantId) && KEY_ID.test(keyId) ? { tenantId, keyId } : undefined;
}

/**
 * Renames a key and, for a publishable key, replaces its origins (`updateApiKey`), from the fields `name` and
 * `allowedOrigins` with the hidden `tenantId`, `keyId`, `kind` and `environment`. Kind, environment and scopes never
 * change.
 */
export async function updateKey(_previous: UpdateKeyState, formData: FormData): Promise<UpdateKeyState> {
  const target = keyOf(formData);
  const kind = text(formData, "kind");
  const environment = text(formData, "environment");
  const failed = (
    code: PlatformErrorCode,
    problems: { fieldErrors?: KeyFieldErrors; message?: string },
  ): UpdateKeyState => ({
    status: "failed",
    code,
    fieldErrors: problems.fieldErrors ?? {},
    ...(problems.message === undefined ? {} : { message: problems.message }),
  });
  if (target === undefined || !isKind(kind) || !isEnvironment(environment)) {
    return failed("VALIDATION_FAILED", { message: API_KEYS_STRINGS.formExpired });
  }

  const name = text(formData, "name").trim();
  const sent = sentOrigins(formData);
  const nameError = nameProblem(name);
  const errors: KeyFieldErrors = {
    ...(nameError === undefined ? {} : { name: nameError }),
    ...(kind === "publishable" ? originErrors(sent, environment) : {}),
  };
  if (hasErrors(errors)) {
    return failed("VALIDATION_FAILED", { fieldErrors: errors });
  }

  const api = await platformApi();
  const result = await api.PATCH("/v1/tenants/{tenantId}/api-keys/{keyId}", {
    params: { path: target },
    // A secret key has no origins; the API refuses them for it.
    body: kind === "publishable" ? { name, allowedOrigins: sent.origins } : { name },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, target.tenantId);
    const fieldErrors =
      result.error.code === "VALIDATION_FAILED" ? apiFieldErrors(result.error, environment, sent.rows) : {};
    return hasErrors(fieldErrors)
      ? failed(result.error.code, { fieldErrors })
      : failed(result.error.code, { message: failureMessage(result.error) });
  }
  refreshKeys(target.tenantId);
  return { status: "saved", fieldErrors: {} };
}

/**
 * Rolls a key (`rollApiKey`) from the field `expireOldIn` (`now`, `1h`, `24h`, `7d`) with the hidden `tenantId` and
 * `keyId`: a new key with the same settings, answered once, and the old key's new expiry.
 */
export async function rollKey(_previous: RollKeyState, formData: FormData): Promise<RollKeyState> {
  const target = keyOf(formData);
  const expireOldIn = text(formData, "expireOldIn");
  const failed = (code: PlatformErrorCode, message: string | undefined, stepUp?: true): RollKeyState => ({
    status: "failed",
    code,
    ...(message === undefined ? {} : { message }),
    ...(stepUp === undefined ? {} : { stepUp }),
  });
  if (target === undefined || !isExpireOldIn(expireOldIn)) {
    return failed("VALIDATION_FAILED", API_KEYS_STRINGS.formExpired);
  }

  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/api-keys/{keyId}/roll", {
    params: { path: target },
    body: { expireOldIn },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, target.tenantId);
    if (result.error.code === "REAUTH_REQUIRED") {
      return failed("REAUTH_REQUIRED", undefined, true);
    }
    const message =
      result.error.code === "PLAN_LIMIT_REACHED"
        ? API_KEYS_STRINGS.rollPlanLimit(detailNumber(result.error, "limit"))
        : failureMessage(result.error);
    return failed(result.error.code, message);
  }
  refreshKeys(target.tenantId);
  const { apiKey, key, previous } = result.data;
  return {
    status: "rolled",
    rolled: {
      apiKey,
      key,
      expireOldIn,
      previous: { id: previous.id, expiresAt: previous.expiresAt },
      oldKeyStopped: expireOldIn === "now" || Date.parse(previous.expiresAt) <= Date.now(),
    },
  };
}

/** Revokes a key at once (`revokeApiKey`), from the hidden `tenantId` and `keyId`. */
export async function revokeKey(_previous: RevokeKeyState, formData: FormData): Promise<RevokeKeyState> {
  const target = keyOf(formData);
  if (target === undefined) {
    return { status: "failed", code: "VALIDATION_FAILED", message: API_KEYS_STRINGS.formExpired };
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/api-keys/{keyId}/revoke", {
    params: { path: target },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, target.tenantId);
    return { status: "failed", code: result.error.code, message: failureMessage(result.error) };
  }
  refreshKeys(target.tenantId);
  return { status: "revoked" };
}
