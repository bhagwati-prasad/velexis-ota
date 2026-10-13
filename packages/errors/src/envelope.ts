// toErrorEnvelope: the HTTP answer of any thrown value, in the error envelope of both APIs (conventions §6, the
// `ErrorResponse` and `Error` schemas of the OTA document, task X-009). Each backend calls it from its own NestJS
// exception filter; the filter logs unknown errors with their stack, and this function never returns either.
import type { components } from "@velexis/api-types";
import {
  isAppError,
  isErrorCode,
  isFieldErrorCode,
  type FieldError,
  type SupplierIssue,
} from "./app-error.js";
import { ERROR_CATALOGUE } from "./generated/catalogue.js";

/** The `error` object of the envelope (the `Error` schema). */
export type ErrorBody = components["schemas"]["Error"];

/** The body of every error answer: `{ error: ErrorBody }` (the `ErrorResponse` schema). */
export type ErrorResponse = components["schemas"]["ErrorResponse"];

/** The HTTP status and the JSON body of an error answer. */
export interface ErrorEnvelope {
  readonly status: number;
  readonly body: ErrorResponse;
}

export interface ErrorEnvelopeOptions {
  /**
   * True only for a request in console scope (OTA staff and secret keys): then `supplier`, the raw Amadeus
   * error, is part of the body. Customer scope never sees it (conventions §6).
   */
  readonly exposeSupplier: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A copy of the fields the `FieldError` schema defines, so nothing else an item carries (a rejected value, for
 * example) reaches the client. Items without a string `path` and `code` are dropped.
 */
function copyFieldErrors(items: readonly FieldError[]): FieldError[] {
  return items.flatMap((item: unknown) => {
    if (!isObject(item) || typeof item["path"] !== "string" || typeof item["code"] !== "string") {
      return [];
    }
    const copy: FieldError = { path: item["path"], code: item["code"] };
    if (typeof item["message"] === "string") {
      copy.message = item["message"];
    }
    return [copy];
  });
}

/**
 * A copy of the fields the `SupplierIssue` schema defines, with their schema types: `status` and `code` are
 * integers there, so `NaN` (which JSON writes as `null`) or a fraction is dropped rather than sent.
 */
function copySupplierIssue(issue: SupplierIssue): SupplierIssue {
  const copy: SupplierIssue = { provider: "amadeus" };
  if (typeof issue.status === "number" && Number.isInteger(issue.status)) {
    copy.status = issue.status;
  }
  if (typeof issue.code === "number" && Number.isInteger(issue.code)) {
    copy.code = issue.code;
  }
  if (typeof issue.title === "string") {
    copy.title = issue.title;
  }
  if (typeof issue.detail === "string") {
    copy.detail = issue.detail;
  }
  if (isObject(issue.source)) {
    const source: NonNullable<SupplierIssue["source"]> = {};
    for (const key of ["parameter", "pointer", "example"] as const) {
      const value = issue.source[key];
      if (typeof value === "string") {
        source[key] = value;
      }
    }
    copy.source = source;
  }
  return copy;
}

/**
 * The envelope of a thrown value:
 *
 * - an AppError gives its catalogue status and `{ code, message, status, requestId }`, plus `details` when it has
 *   them, `fieldErrors` only for a code of FIELD_ERROR_CODES, and `supplier` only when `exposeSupplier` is true;
 * - anything else (a TypeError, a string, an object that looks like an error) gives `500 INTERNAL_ERROR` with the
 *   catalogue's generic message and nothing from the thrown value;
 * - the body never holds a stack trace or a `cause`.
 */
export function toErrorEnvelope(
  err: unknown,
  requestId: string,
  options: ErrorEnvelopeOptions,
): ErrorEnvelope {
  if (!isAppError(err) || !isErrorCode(err.code)) {
    const { status, description } = ERROR_CATALOGUE.INTERNAL_ERROR;
    return { status, body: { error: { code: "INTERNAL_ERROR", message: description, status, requestId } } };
  }
  // The status always comes from the catalogue; a missing or empty message falls back to its description.
  const { status, description } = ERROR_CATALOGUE[err.code];
  const message = typeof err.message === "string" && err.message !== "" ? err.message : description;
  const error: ErrorBody = { code: err.code, message, status, requestId };
  if (isObject(err.details)) {
    error.details = { ...err.details };
  }
  if (Array.isArray(err.fieldErrors) && isFieldErrorCode(err.code)) {
    error.fieldErrors = copyFieldErrors(err.fieldErrors);
  }
  if (options.exposeSupplier && isObject(err.supplier)) {
    error.supplier = copySupplierIssue(err.supplier);
  }
  return { status, body: { error } };
}
