// Errors of the OTA API as the OTA admin shows them (README §10, routes.md §1, conventions §3 and §6): the code of a
// `VelexisError` becomes a message in the admin's own words, the API's `fieldErrors` (JSON pointers into the
// request) become messages per form field, and the request id stays beside the message so staff can quote it. The
// error envelope's own `message`, stacks and supplier payloads are never shown from here. A field error keeps the
// API's field message when it has one: the backend builds it from the schema, never from the rejected value
// (conventions §6); without one the field gets a message by its code.
//
// No server-only import and no SDK runtime import (OADR-0018 point 1): `error.tsx` boundaries and forms, which are
// client components, use this module too. An error is recognised by its shape, which the SDK's `VelexisError`
// classes have on the server and their `toJSON()` form keeps.
import type { OtaErrorCode } from "@velexis/errors";
import type { ClientErrorCode } from "@velexis/ota-sdk";

import { actionFailure, type ActionState, type FieldErrors } from "@/lib/action-state";
import { isStaffPermission } from "@/lib/permissions";

/** A code this module has a message for: the OTA catalogue's, or the SDK's client-side ones. */
export type KnownErrorCode = OtaErrorCode | ClientErrorCode;

/** The API's `FieldError`: a JSON pointer into the request, a code and an optional message. */
export interface FieldErrorLike {
  readonly path: string;
  readonly code: string;
  readonly message?: string | undefined;
}

/** What this module reads of an SDK `VelexisError` (or of its `toJSON()` form). */
export interface VelexisErrorLike {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly details?: Record<string, unknown> | undefined;
  readonly fieldErrors: readonly FieldErrorLike[];
  readonly retryable: boolean;
  /** `RateLimitError`: the response's `Retry-After`, in seconds. */
  readonly retryAfterSeconds?: number | undefined;
}

/**
 * Messages per code for what the console can answer (console.d.ts `@throws`, the OTA catalogue's console codes and
 * routes.md §1). A code without an entry gets the message of its HTTP status class.
 */
export const ERROR_MESSAGES: Readonly<Partial<Record<KnownErrorCode, string>>> = Object.freeze({
  VALIDATION_FAILED: "Some values were not accepted. Check the highlighted fields and try again.",
  INVALID_REQUEST: "The request was not accepted. Reload the page and try again.",
  UNAUTHENTICATED: "Your console session has ended. Open the console again from the portal.",
  INVALID_API_KEY:
    "The OTA admin could not authenticate with the OTA API. Contact the platform administrator.",
  TOKEN_EXPIRED: "Your session expired. Reload the page to continue.",
  FORBIDDEN: "You do not have permission to do this.",
  SCOPE_NOT_ALLOWED: "The OTA admin may not call this operation. Contact the platform administrator.",
  TENANT_SUSPENDED: "This OTA is suspended. The portal says why and what to do.",
  FEATURE_DISABLED: "This feature is not enabled for this OTA.",
  NOT_FOUND: "Not found. It may have been removed, or the link is wrong.",
  CONFLICT: "This conflicts with the current state. Reload the page and try again.",
  IDEMPOTENCY_KEY_REUSED:
    "This form was already sent with other values. Reload the page and fill it in again.",
  VERSION_CONFLICT: "This record changed; reload to see the latest version.",
  PRECONDITION_FAILED: "This record changed; reload to see the latest version.",
  BOOKING_NOT_MODIFIABLE: "This booking can no longer be changed.",
  BOOKING_ALREADY_CANCELLED: "This booking is already cancelled.",
  ALREADY_ISSUED: "The tickets of this booking are already issued.",
  PRICE_CHANGED: "The price changed. Review the new price before you continue.",
  SOLD_OUT: "This flight is no longer available.",
  SEARCH_EXPIRED: "These search results expired. Search again.",
  OFFER_EXPIRED: "This offer expired. Search again.",
  PAYMENT_REQUIRED: "This booking is not paid yet.",
  PAYMENT_DECLINED: "The payment was declined.",
  UNPROCESSABLE: "The request could not be processed with these values.",
  TRAVELER_DATA_INVALID: "Amadeus refused the traveller details. Check names, dates of birth and documents.",
  CONTACT_DATA_INVALID: "Amadeus refused the contact details. Check the e-mail address and the phone number.",
  ACCOUNT_LOCKED: "This account is locked for a few minutes after too many attempts.",
  SUPPLIER_NOT_CONFIGURED: "No Amadeus connection is active for this environment. Set it up in the portal.",
  RATE_LIMITED: "Too many requests. Try again in a moment.",
  INTERNAL_ERROR:
    "The OTA API had an unexpected problem. Try again, and quote the request id if it persists.",
  SUPPLIER_ERROR: "Amadeus answered with an error.",
  TICKETING_FAILED: "Amadeus could not issue the tickets.",
  SERVICE_UNAVAILABLE: "The OTA API is unavailable right now. Try again in a moment.",
  SUPPLIER_UNAVAILABLE: "Amadeus is unavailable right now. Try again in a moment.",
  SUPPLIER_TIMEOUT: "Amadeus did not answer. Resync before retrying.",
  SUPPLIER_REJECTED: "Amadeus refused the request.",
  REFRESH_TOKEN_INVALID: "Your console session has ended. Open the console again from the portal.",
  REFRESH_TOKEN_REUSED: "Your console session has ended. Open the console again from the portal.",
  PORTAL_TOKEN_INVALID:
    "This console link expired or was already used. Open the console again from the portal.",
  STAFF_MEMBERSHIP_INACTIVE: "Your access to this OTA is not active. Ask the OTA's owner.",
  STAFF_MFA_REQUIRED: "Two-factor authentication is required to open the console.",
  MFA_REQUIRED:
    "This OTA is live: turn on two-factor authentication in the portal first, then open the console again.",
  OFFICE_NOT_ALLOWED: "This Amadeus office is not one of this OTA's offices.",
  ORDER_ALREADY_IMPORTED: "This Amadeus order is already imported.",
  NOT_IMPLEMENTED: "This function is not available yet.",
  ENVIRONMENT_NOT_ALLOWED: "Live is not available for this OTA or role.",
  TEMPLATE_INVALID: "The template does not compile. Check the highlighted parts.",
  PAYMENT_PROVIDER_ERROR: "The payment provider answered with an error.",
  PAYMENT_PROVIDER_NOT_CONFIGURED: "No payment provider is set up for this environment.",
  PAYMENT_AMOUNT_MISMATCH: "The amount does not match the payment.",
  PAYMENT_NOT_UPDATABLE: "This payment can no longer be changed.",
  REFUND_AMOUNT_CHANGED: "The refundable amount changed. Reload the page and review it.",
  DOCUMENT_NOT_READY: "The document is not ready yet. Try again in a moment.",
  CHECKOUT_BEING_COMPLETED: "This booking is being completed. Check its status again in a moment.",
  NETWORK_ERROR: "The OTA API could not be reached. Try again in a moment.",
  TIMEOUT: "The OTA API did not answer in time. Check the result before you try again.",
  ABORTED: "The request was cancelled.",
});

/** The message of an error without a code of its own here, by HTTP status class. */
export const GENERIC_ERROR_MESSAGE =
  "Something went wrong. Try again, and quote the request id if it persists.";

const STATUS_MESSAGES: ReadonlyArray<readonly [(status: number) => boolean, string]> = [
  [(status) => status === 0, ERROR_MESSAGES.NETWORK_ERROR ?? GENERIC_ERROR_MESSAGE],
  [
    (status) => status === 400 || status === 422,
    "The request was not accepted. Check the values and try again.",
  ],
  [(status) => status === 401, ERROR_MESSAGES.UNAUTHENTICATED ?? GENERIC_ERROR_MESSAGE],
  [(status) => status === 403, ERROR_MESSAGES.FORBIDDEN ?? GENERIC_ERROR_MESSAGE],
  [(status) => status === 404, ERROR_MESSAGES.NOT_FOUND ?? GENERIC_ERROR_MESSAGE],
  [(status) => status === 409, ERROR_MESSAGES.CONFLICT ?? GENERIC_ERROR_MESSAGE],
  [(status) => status === 410, "This has expired. Reload the page and start again."],
  [(status) => status === 412, ERROR_MESSAGES.PRECONDITION_FAILED ?? GENERIC_ERROR_MESSAGE],
  [(status) => status === 429, ERROR_MESSAGES.RATE_LIMITED ?? GENERIC_ERROR_MESSAGE],
  [(status) => status >= 500, ERROR_MESSAGES.SERVICE_UNAVAILABLE ?? GENERIC_ERROR_MESSAGE],
];

/** The message of a field error without a message of its own, by its code (Ajv keywords and the API's codes). */
const FIELD_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  required: "Required.",
  format: "Not in the expected format.",
  pattern: "Not in the expected format.",
  enum: "Not one of the allowed values.",
  type: "Not the expected kind of value.",
  minLength: "Too short.",
  maxLength: "Too long.",
  minimum: "Too small.",
  maximum: "Too large.",
  minItems: "Add at least one more.",
  maxItems: "Too many entries.",
});

const GENERIC_FIELD_MESSAGE = "This value was not accepted.";

/** `code` has a message of its own here. */
export function isKnownErrorCode(code: unknown): code is KnownErrorCode {
  return typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code);
}

/**
 * `value` has the shape of an SDK `VelexisError` (or of its `toJSON()` form). Next.js's `redirect()` and
 * `notFound()` errors, and any other error, do not.
 */
export function isVelexisErrorLike(value: unknown): value is VelexisErrorLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { code, status, requestId, fieldErrors, retryable } = value as Partial<Record<string, unknown>>;
  return (
    typeof code === "string" &&
    typeof status === "number" &&
    (requestId === null || typeof requestId === "string") &&
    Array.isArray(fieldErrors) &&
    typeof retryable === "boolean"
  );
}

/** The message of a status without a code of its own here. */
function statusMessage(status: number): string {
  return STATUS_MESSAGES.find(([matches]) => matches(status))?.[1] ?? GENERIC_ERROR_MESSAGE;
}

/** A whole number of seconds from `value`, or `undefined`. */
function wholeSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

/**
 * The message for an error code, or for an error (with what its details add: the permission a `403 FORBIDDEN`
 * names, the wait of a `429 RATE_LIMITED`). Never the API's own message.
 */
export function errorMessage(error: string | VelexisErrorLike): string {
  if (typeof error === "string") {
    return isKnownErrorCode(error) ? (ERROR_MESSAGES[error] ?? GENERIC_ERROR_MESSAGE) : GENERIC_ERROR_MESSAGE;
  }
  const required = error.details?.["requiredPermission"];
  if (error.code === "FORBIDDEN" && isStaffPermission(required)) {
    return `You do not have permission to do this (${required}).`;
  }
  if (error.code === "RATE_LIMITED") {
    const seconds =
      wholeSeconds(error.retryAfterSeconds) ?? wholeSeconds(error.details?.["retryAfterSeconds"]);
    if (seconds !== undefined) {
      return `Too many requests, retry in ${seconds} s.`;
    }
  }
  return isKnownErrorCode(error.code)
    ? (ERROR_MESSAGES[error.code] ?? GENERIC_ERROR_MESSAGE)
    : statusMessage(error.status);
}

/** A message with the request id appended, for places that show plain text only. */
export function withRequestId(message: string, requestId: string | null | undefined): string {
  return requestId === null || requestId === undefined || requestId === ""
    ? message
    : `${message} (request id ${requestId})`;
}

/** One JSON pointer segment (RFC 6901): `~1` is `/`, `~0` is `~`. */
function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** A header parameter as the SDK names it: `If-Match` → `ifMatch`. */
function headerParamName(header: string): string {
  const [first = "", ...rest] = header.split("-").filter((part) => part !== "");
  return [
    first.toLowerCase(),
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()),
  ].join("");
}

/** Where a parameter's pointer starts (`/<in>/<name>`, conventions: field errors). */
const PARAMETER_LOCATIONS: readonly string[] = ["path", "query", "header", "cookie"];

/**
 * The form field name of a field error's JSON pointer: a parameter's name (`/path/bookingId` → `bookingId`,
 * `/header/If-Match` → `ifMatch`), or the body pointer's segments joined with dots (`/contacts/0/email` →
 * `contacts.0.email`, the names of nested inputs). `undefined` for the request itself (`""`) or a value that is
 * not a pointer.
 */
export function fieldNameOfPointer(pointer: string): string | undefined {
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  const segments = pointer.slice(1).split("/").map(unescapePointerSegment);
  const [location, name, ...rest] = segments;
  if (
    location !== undefined &&
    PARAMETER_LOCATIONS.includes(location) &&
    name !== undefined &&
    rest.length === 0
  ) {
    return location === "header" ? headerParamName(name) : name;
  }
  return segments.join(".");
}

/**
 * The API's field errors as form state: one message per form field (the first), the API's field message or one by
 * its code. `fields` maps a pointer, or a field name derived from one, to the form's own name (for example
 * `{ ifMatch: "version" }`). Errors of the request itself belong to no field and are left to the form's message.
 */
export function fieldErrorsToForm(
  fieldErrors: readonly FieldErrorLike[],
  fields: Readonly<Record<string, string>> = {},
): FieldErrors {
  const result: Record<string, string> = {};
  for (const fieldError of fieldErrors) {
    const derived = fieldNameOfPointer(fieldError.path);
    const name = Object.hasOwn(fields, fieldError.path)
      ? fields[fieldError.path]
      : derived !== undefined && Object.hasOwn(fields, derived)
        ? fields[derived]
        : derived;
    if (name === undefined || name === "" || Object.hasOwn(result, name)) {
      continue;
    }
    const message = fieldError.message?.trim();
    result[name] =
      message !== undefined && message !== ""
        ? message
        : (FIELD_MESSAGES[fieldError.code] ?? GENERIC_FIELD_MESSAGE);
  }
  return Object.freeze(result);
}

/** Options of `fromVelexisError`. */
export interface FromVelexisErrorOptions {
  /** Pointer or derived name → the form's field name (see `fieldErrorsToForm`). */
  readonly fields?: Readonly<Record<string, string>>;
}

/**
 * The action state of a failed SDK call in a server action (README §7): the message for its code, its request id
 * and its field errors. Anything that is not an SDK error (a bug, or Next.js's `redirect()`) is thrown again, so the
 * error boundary or the redirect still happens.
 */
export function fromVelexisError(error: unknown, options: FromVelexisErrorOptions = {}): ActionState {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  return actionFailure(errorMessage(error), {
    code: error.code,
    requestId: error.requestId,
    fieldErrors: fieldErrorsToForm(error.fieldErrors, options.fields),
  });
}

/** What an error page shows: the message, and the code and request id when the error has them. */
export interface ErrorDescription {
  readonly message: string;
  readonly code?: string;
  readonly requestId?: string;
}

/** The description of any error for an error page; other errors than the SDK's get the generic message. */
export function describeError(error: unknown): ErrorDescription {
  if (!isVelexisErrorLike(error)) {
    return { message: GENERIC_ERROR_MESSAGE };
  }
  return {
    message: errorMessage(error),
    code: error.code,
    ...(error.requestId === null || error.requestId === "" ? {} : { requestId: error.requestId }),
  };
}
