// Responses and failures to the contract's error classes (ota/sdk/README.md §5.3, OADR-0016 point 6). The API answers
// every error with one envelope, `{ error: { code, message, status, requestId, details, fieldErrors, supplier } }`
// (conventions §6); the class follows from the status and the code, as `fromErrorData` of react.d.ts lists them.
// A response without that envelope (a proxy's 502 page, for example) gets a generic code from its status and is never
// blamed on the supplier. Failures before a response are `ConnectionError`s with status 0. No error ever holds the
// request: its headers carry keys and tokens and its body may carry card data.
import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  ExpiredError,
  NotFoundError,
  PaymentError,
  PermissionError,
  PriceChangedError,
  RateLimitError,
  ServerError,
  SoldOutError,
  SupplierError,
  ValidationError,
  VelexisError,
} from "../shared.js";

/** @typedef {import("../shared.js").ApiError} ApiError */
/** @typedef {import("../shared.js").ClientErrorCode} ClientErrorCode */

/** The shape of a public error code (the `Error` schema's `code` pattern). */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/;

/**
 * The class of an API error, by status and code: 400 and 422 `ValidationError`, 401 `AuthenticationError`, 402
 * `PaymentError`, 403 `PermissionError`, 404 `NotFoundError`, 409 `ConflictError` (`PRICE_CHANGED`
 * `PriceChangedError`, `SOLD_OUT` `SoldOutError`), 410 `ExpiredError`, 429 `RateLimitError`, 424, 502, 504 and
 * `SUPPLIER_UNAVAILABLE` `SupplierError`, 500, 501 and other 5xx `ServerError`. Statuses without a class of their
 * own (412 `PRECONDITION_FAILED`, 423 `ACCOUNT_LOCKED`) give a plain `VelexisError`. Without the API's envelope a
 * 424, 502 or 504 came from a proxy, not from the supplier, and is a `ServerError`.
 * @param {number} status the HTTP status
 * @param {string} code the public error code
 * @param {boolean} [fromApi] whether the body was the API's error envelope; default `true`
 * @returns {typeof VelexisError}
 */
export function errorClassFor(status, code, fromApi = true) {
  if (code === "PRICE_CHANGED") {
    return PriceChangedError;
  }
  if (code === "SOLD_OUT") {
    return SoldOutError;
  }
  if (code === "SUPPLIER_UNAVAILABLE") {
    return SupplierError;
  }
  switch (status) {
    case 400:
    case 422:
      return ValidationError;
    case 401:
      return AuthenticationError;
    case 402:
      return PaymentError;
    case 403:
      return PermissionError;
    case 404:
      return NotFoundError;
    case 409:
      return ConflictError;
    case 410:
      return ExpiredError;
    case 429:
      return RateLimitError;
    case 424:
    case 502:
    case 504:
      return fromApi ? SupplierError : ServerError;
    default:
      return status >= 500 ? ServerError : VelexisError;
  }
}

/**
 * The code of a response without the API's envelope, from its status alone.
 * @param {number} status
 * @returns {string}
 */
function fallbackCode(status) {
  switch (status) {
    case 401:
      return "UNAUTHENTICATED";
    case 402:
      return "PAYMENT_REQUIRED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 412:
      return "PRECONDITION_FAILED";
    case 422:
      return "UNPROCESSABLE";
    case 429:
      return "RATE_LIMITED";
    case 501:
      return "NOT_IMPLEMENTED";
    case 502:
    case 503:
    case 504:
      return "SERVICE_UNAVAILABLE";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST";
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The `error` object of the API's envelope, with only the fields of the `Error` schema, or `undefined` when the body
 * is not the envelope.
 * @param {unknown} body the parsed response body
 * @returns {Omit<ApiError, "status" | "requestId"> & { requestId?: string } | undefined}
 */
function envelopeOf(body) {
  const error = isRecord(body) ? body["error"] : undefined;
  if (!isRecord(error) || typeof error["code"] !== "string" || !CODE_PATTERN.test(error["code"])) {
    return undefined;
  }
  const { code, message, requestId, details, fieldErrors, supplier } = error;
  return {
    code,
    message: typeof message === "string" ? message : code,
    ...(typeof requestId === "string" ? { requestId } : {}),
    ...(isRecord(details) ? { details } : {}),
    ...(Array.isArray(fieldErrors)
      ? {
          fieldErrors: fieldErrors.filter(
            /** @returns {item is import("../shared.js").Schemas["FieldError"]} */
            (item) => isRecord(item) && typeof item["path"] === "string" && typeof item["code"] === "string",
          ),
        }
      : {}),
    ...(isRecord(supplier)
      ? { supplier: /** @type {import("../shared.js").Schemas["SupplierIssue"]} */ (supplier) }
      : {}),
  };
}

/**
 * A `Retry-After` header in seconds: delay-seconds, or an HTTP date relative to `nowMs`. `undefined` when the header
 * is absent or unreadable.
 * @param {string | null} value
 * @param {number} nowMs the current time, in ms since the epoch
 * @returns {number | undefined}
 */
export function parseRetryAfter(value, nowMs) {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - nowMs) / 1000));
}

/**
 * The error of a response that is not 2xx.
 * @param {{ status: number, statusText: string, headers: Headers }} response
 * @param {unknown} body the parsed body (`undefined` when it was empty or not JSON)
 * @param {number} nowMs the current time, for an HTTP-date `Retry-After`
 * @returns {VelexisError}
 */
export function errorFromResponse(response, body, nowMs) {
  const { status } = response;
  const headerRequestId = response.headers.get("x-request-id");
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), nowMs);
  const options = retryAfterSeconds === undefined ? {} : { retryAfterSeconds };
  const envelope = envelopeOf(body);
  if (envelope !== undefined) {
    const ErrorClass = errorClassFor(status, envelope.code);
    return new ErrorClass({ ...envelope, status, requestId: envelope.requestId ?? headerRequestId }, options);
  }
  const code = fallbackCode(status);
  const ErrorClass = errorClassFor(status, code, false);
  const reason = response.statusText ? ` ${response.statusText}` : "";
  return new ErrorClass(
    {
      code,
      message: `The API answered ${status}${reason} without an error body`,
      status,
      requestId: headerRequestId,
    },
    options,
  );
}

/**
 * A failure before a response: `NETWORK_ERROR`, `TIMEOUT` or `ABORTED`, status 0.
 * @param {ClientErrorCode} code
 * @param {string} message
 * @param {unknown} [cause] the underlying failure
 * @returns {ConnectionError}
 */
export function connectionError(code, message, cause) {
  return new ConnectionError(
    { code, message, status: 0, requestId: null },
    cause === undefined ? {} : { cause },
  );
}
