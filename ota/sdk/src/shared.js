// Shared types and the error classes of every namespace (mirrors docs/velexis-sdk/sdk/src/shared.d.ts, ADR-0019).
// The typedefs carry the same names, in the same order, as the contract file; the client and request options also
// carry the members that identity.d.ts and console.d.ts add to them with `declare module "./shared"`, and the two
// options of ota/sdk/docs/extensions.md §1, because JavaScript cannot augment a typedef. Schema types come only
// from `@velexis/api-types` through ./types.js. The errors are built from the API's error envelope by
// ./internal/errors.js; `toJSON()` never contains keys, tokens or request bodies (OADR-0016 point 6).

export { Page } from "./internal/pagination.js";

/** @typedef {import("./types.js").Schemas} Schemas */

/** Money as returned by the API: decimal string amount + ISO 4217 currency. @typedef {Schemas["Money"]} Money */
/** Amadeus warning passed through on a successful response. @typedef {Schemas["Warning"]} Warning */
/** Error body returned by the API. @typedef {Schemas["Error"]} ApiError */

/**
 * Public error codes of the API (the `x-error-catalogue` of the OpenAPI document). Open: a code the catalogue gains
 * later is still a string.
 * @typedef {(
 *   | "VALIDATION_FAILED" | "INVALID_REQUEST" | "UNAUTHENTICATED" | "INVALID_API_KEY" | "TOKEN_EXPIRED"
 *   | "INVALID_CREDENTIALS" | "FORBIDDEN" | "SCOPE_NOT_ALLOWED" | "ORIGIN_NOT_ALLOWED" | "EMAIL_NOT_VERIFIED"
 *   | "TENANT_SUSPENDED" | "FEATURE_DISABLED" | "NOT_FOUND" | "CONFLICT" | "IDEMPOTENCY_KEY_REUSED"
 *   | "VERSION_CONFLICT" | "EMAIL_ALREADY_REGISTERED" | "PRICE_CHANGED" | "SOLD_OUT" | "BOOKING_NOT_MODIFIABLE"
 *   | "BOOKING_ALREADY_CANCELLED" | "ALREADY_ISSUED" | "SEARCH_EXPIRED" | "OFFER_EXPIRED" | "CHECKOUT_EXPIRED"
 *   | "PRECONDITION_FAILED" | "PAYMENT_REQUIRED" | "PAYMENT_DECLINED" | "UNPROCESSABLE" | "TRAVELER_DATA_INVALID"
 *   | "ACCOUNT_LOCKED" | "SUPPLIER_NOT_CONFIGURED" | "RATE_LIMITED" | "INTERNAL_ERROR" | "SUPPLIER_ERROR"
 *   | "TICKETING_FAILED" | "SERVICE_UNAVAILABLE" | "SUPPLIER_UNAVAILABLE" | "SUPPLIER_TIMEOUT"
 *   | "ACCOUNT_DELETION_BLOCKED" | "ANCILLARY_NOT_AVAILABLE" | "CHECKOUT_ALREADY_COMPLETED" | "CHECKOUT_INCOMPLETE"
 *   | "CONTACT_DATA_INVALID" | "CURRENT_PASSWORD_INCORRECT" | "DOCUMENT_NOT_READY" | "HOST_NOT_ALLOWED"
 *   | "OFFER_COMBINATION_INVALID" | "OFFICE_NOT_ALLOWED" | "ORDER_ALREADY_IMPORTED" | "PASSWORD_RESET_TOKEN_INVALID"
 *   | "PASSWORD_TOO_WEAK" | "PAYMENT_AMOUNT_MISMATCH" | "PAYMENT_NOT_UPDATABLE" | "PAYMENT_PROVIDER_ERROR"
 *   | "PAYMENT_PROVIDER_NOT_CONFIGURED" | "PORTAL_TOKEN_INVALID" | "REFRESH_TOKEN_INVALID" | "REFRESH_TOKEN_REUSED"
 *   | "REFUND_AMOUNT_CHANGED" | "SAVED_TRAVELER_LIMIT_REACHED" | "SEARCH_NOT_COMPLETED" | "STAFF_MEMBERSHIP_INACTIVE"
 *   | "STAFF_MFA_REQUIRED" | "SUPPLIER_REJECTED" | "VERIFICATION_TOKEN_INVALID"
 *   | (string & {})
 * )} ErrorCode
 */

/**
 * Where the access token for a call comes from: a value, or a function called before every request.
 * @typedef {string | null | undefined | (() => string | null | undefined | Promise<string | null | undefined>)} TokenSource
 */

/**
 * The visitor on whose behalf a server makes a call (`X-Velexis-End-User-IP` / `X-Velexis-End-User-Agent`). Declared
 * in identity.d.ts; it lives here because the options below need it. identity.js (SDK-005) must not declare it again:
 * with `export *` of both modules in index.js the name would be ambiguous (TS2308) unless index.js names one.
 * @typedef {object} EndUserContext
 * @property {string} [ip] visitor IP (IPv4 or IPv6)
 * @property {string} [userAgent] the visitor's `User-Agent` (the API cuts it to 512 characters)
 */

/**
 * Client-level end-user source: a fixed context or a function called before every request (identity.d.ts).
 * @typedef {EndUserContext | (() => EndUserContext | null | undefined | Promise<EndUserContext | null | undefined>)} EndUserSource
 */

/**
 * Information about one HTTP response, for logging and metrics. Never contains headers or bodies.
 * @typedef {object} ResponseInfo
 * @property {string} method the HTTP method
 * @property {string} path the API path (`/v1/…`), without the base URL and the query string
 * @property {number} status the HTTP status
 * @property {string | null} requestId the API's `X-Request-Id`, when it sent one
 * @property {number} durationMs from sending the request to reading the whole response
 */

/**
 * Options for `createVelexisClient`. The contract's options with its defaults, the augmentations of identity.d.ts
 * (`hostingKey`, `host`, `endUser`) and console.d.ts (`sessionKind`, `onStaffSessionRefreshed`), and the extensions
 * `session` and `environment` (ota/sdk/docs/extensions.md §1).
 * @typedef {object} VelexisClientOptions
 * @property {string} [publishableKey] publishable key (`pk_test_…` / `pk_live_…`); customer-scope operations only
 * @property {string} [secretKey] secret key (`sk_…`); server-only, never shipped to a browser
 * @property {string} [baseUrl] API base URL; default `https://api.ota.example.com` (cookie mode: `/api`)
 * @property {TokenSource} [accessToken] customer or staff access token, or a function returning it
 * @property {TokenSource} [bookingToken] guest booking token (`X-Booking-Token`)
 * @property {(session: Schemas["Session"]) => void | Promise<void>} [onSessionRefreshed] called after the SDK refreshed the session
 * @property {() => void | Promise<void>} [onSessionExpired] called when the refresh token is rejected
 * @property {TokenSource} [refreshToken] refresh token source; when set, an expired access token is refreshed once
 * @property {string} [locale] default locale (`Accept-Language`)
 * @property {string} [currency] default display currency (`X-Currency`)
 * @property {typeof fetch} [fetch] custom fetch; default `globalThis.fetch`, looked up at each request
 * @property {number} [timeoutMs] per-request timeout in ms; default 30000 (the route table gives long operations more)
 * @property {number} [maxRetries] automatic retries of idempotent requests on 429/503/504/network errors; default 2
 * @property {Record<string, string>} [headers] extra headers sent with every request
 * @property {(info: ResponseInfo) => void} [onResponse] called for every response, retries included
 * @property {string} [hostingKey] hosting key (`hk_…`), server-only (identity.d.ts)
 * @property {string} [host] default storefront host for every call (`X-Velexis-Host`, identity.d.ts)
 * @property {EndUserSource} [endUser] default end user for every call (identity.d.ts)
 * @property {"customer" | "staff"} [sessionKind] which session the tokens belong to; default `"customer"` (console.d.ts)
 * @property {(result: Schemas["ConsoleStaffSession"]) => void | Promise<void>} [onStaffSessionRefreshed] called after an automatic staff refresh (console.d.ts)
 * @property {"token" | "cookie"} [session] extension: `"cookie"` selects the hosted storefront's cookie mode; default `"token"`
 * @property {"test" | "live"} [environment] extension: sends `X-Velexis-Environment` on console operations
 */

/**
 * Options accepted by every SDK method as the last argument, with the augmentation of identity.d.ts (`endUser`, `host`).
 * @typedef {object} RequestOptions
 * @property {AbortSignal} [signal] aborts the request (and its retries)
 * @property {string} [idempotencyKey] idempotency key for state-changing calls (16 to 128 characters); generated when omitted
 * @property {number} [timeoutMs] overrides the timeout of this call
 * @property {Record<string, string>} [headers] extra headers for this call
 * @property {string} [accessToken] overrides the access token for this call
 * @property {string} [bookingToken] overrides the booking token for this call
 * @property {string} [locale] overrides the locale of this call
 * @property {string} [currency] overrides the currency of this call
 * @property {{ revalidate?: number | false, tags?: string[] }} [next] Next.js fetch cache options, passed to `fetch`
 * @property {RequestCache} [cache] the fetch cache mode, passed to `fetch`
 * @property {EndUserContext} [endUser] the visitor this server-side call is made for (identity.d.ts)
 * @property {string} [host] storefront host of this call (`X-Velexis-Host`, identity.d.ts)
 */

/** Common list parameters. @typedef {{ cursor?: string, limit?: number }} ListParams */
/** A response that may carry Amadeus warnings. @typedef {{ warnings?: Warning[] }} WithWarnings */

/** The client-side failure codes of `ConnectionError`. @typedef {"NETWORK_ERROR" | "TIMEOUT" | "ABORTED"} ClientErrorCode */

/**
 * What a `VelexisError` is built from: the API's error body, or a client-side failure.
 * @typedef {ApiError | { code: string, message: string, status: number, requestId?: string | null }} VelexisErrorInit
 */

/**
 * Facts about the failure that are not part of the error body (an addition to the contract's constructor).
 * @typedef {object} VelexisErrorOptions
 * @property {number} [retryAfterSeconds] the response's `Retry-After`, in seconds (read by `RateLimitError`)
 * @property {unknown} [cause] the underlying failure of a `ConnectionError`
 */

/** Key names whose values `toJSON()` drops from `details`: tokens, keys, passwords, card numbers and codes. */
const SECRET_KEY_NAME =
  /token|secret|password|api[-_]?key|authorization|cookie|card[-_]?number|security[-_]?code|cvc|cvv/i;
/** API keys (`pk_…`, `sk_…`, `hk_…`, `rk_…`), bearer credentials and JWTs inside a text. */
const SECRET_IN_TEXT = /\b(?:pk|sk|hk|rk)_[\w-]*|\bBearer\s+\S+|\beyJ[\w-]*\.[\w-]*\.?[\w-]*/g;
const REDACTED = "[redacted]";

/**
 * A text with every API key, bearer credential and JWT replaced by `[redacted]`.
 * @param {string} text
 */
const redactText = (text) => text.replace(SECRET_IN_TEXT, REDACTED);

/**
 * A deep copy of a JSON-like value without secrets: texts redacted, secret-named keys dropped.
 * @param {unknown} value
 * @returns {unknown}
 */
function redact(value) {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      if (!SECRET_KEY_NAME.test(key)) {
        copy[key] = redact(item);
      }
    }
    return copy;
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A money object from `details`, or `undefined` when the value is not one.
 * @param {unknown} value
 * @returns {Money | undefined}
 */
function moneyOf(value) {
  if (isRecord(value) && typeof value["amount"] === "string" && typeof value["currency"] === "string") {
    return { amount: value["amount"], currency: value["currency"] };
  }
  return undefined;
}

/**
 * A non-negative number of seconds, or `undefined`.
 * @param {unknown} value
 */
const secondsOf = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Whether retrying the same call later may succeed: client-side failures except an abort, rate limits, server
 * and supplier failures (429, 500, 502, 503, 504), and the codes that say "try later" (`ACCOUNT_LOCKED`,
 * `DOCUMENT_NOT_READY`). Never `NOT_IMPLEMENTED` (501): a deferred operation stays deferred.
 * @param {number} status
 * @param {string} code
 */
function isRetryable(status, code) {
  if (status === 0) {
    return code !== "ABORTED";
  }
  if (code === "ACCOUNT_LOCKED" || code === "DOCUMENT_NOT_READY") {
    return true;
  }
  return [429, 500, 502, 503, 504].includes(status);
}

/** Base class of every error thrown by the SDK. */
export class VelexisError extends Error {
  /** @override @readonly @type {string} */
  name = "VelexisError";

  /**
   * @param {VelexisErrorInit} error the API's error body, or a client-side failure
   * @param {VelexisErrorOptions} [options]
   */
  constructor(error, options = {}) {
    super(redactText(String(error.message)), "cause" in options ? { cause: options.cause } : undefined);
    /** @type {{ requestId?: unknown, details?: unknown, fieldErrors?: unknown, supplier?: unknown }} */
    const body = error;
    /**
     * Public error code from the API (or `NETWORK_ERROR` / `TIMEOUT` / `ABORTED` for client-side failures).
     * @readonly @type {ErrorCode | ClientErrorCode}
     */
    this.code = error.code;
    /** HTTP status (0 for client-side failures). @readonly @type {number} */
    this.status = error.status;
    /** @readonly @type {string | null} */
    this.requestId = typeof body.requestId === "string" ? body.requestId : null;
    /** @readonly @type {Record<string, unknown> | undefined} */
    this.details = isRecord(body.details) ? body.details : undefined;
    /** @readonly @type {Schemas["FieldError"][]} */
    this.fieldErrors = Array.isArray(body.fieldErrors) ? [...body.fieldErrors] : [];
    /** Underlying Amadeus error when exposed (console scope). @readonly @type {Schemas["SupplierIssue"] | undefined} */
    this.supplier = isRecord(body.supplier)
      ? /** @type {Schemas["SupplierIssue"]} */ (body.supplier)
      : undefined;
    /** True when retrying the same call later may succeed. @readonly @type {boolean} */
    this.retryable = isRetryable(this.status, this.code);
  }

  /**
   * Plain, serialisable form (safe to return from a server action or to log). Never contains keys or tokens:
   * secret-named entries of `details` (`bookingToken`, …) are dropped, and API keys and JWTs in texts redacted.
   * @returns {{ name: string, code: string, message: string, status: number, requestId: string | null, details?: Record<string, unknown>, fieldErrors: Schemas["FieldError"][], retryable: boolean }}
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: redactText(this.message),
      status: this.status,
      requestId: this.requestId,
      ...(this.details === undefined
        ? {}
        : { details: /** @type {Record<string, unknown>} */ (redact(this.details)) }),
      fieldErrors: /** @type {Schemas["FieldError"][]} */ (redact(this.fieldErrors)),
      retryable: this.retryable,
    };
  }
}

/** 400 VALIDATION_FAILED / INVALID_REQUEST, 422 UNPROCESSABLE / TRAVELER_DATA_INVALID. */
export class ValidationError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "ValidationError";
}

/** 401 UNAUTHENTICATED / INVALID_API_KEY / TOKEN_EXPIRED / INVALID_CREDENTIALS. */
export class AuthenticationError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "AuthenticationError";
}

/** 403 FORBIDDEN / SCOPE_NOT_ALLOWED / ORIGIN_NOT_ALLOWED / EMAIL_NOT_VERIFIED / TENANT_SUSPENDED / FEATURE_DISABLED. */
export class PermissionError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "PermissionError";
}

/** 404 NOT_FOUND. */
export class NotFoundError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "NotFoundError";
}

/** 409 CONFLICT / VERSION_CONFLICT / IDEMPOTENCY_KEY_REUSED / BOOKING_NOT_MODIFIABLE / … */
export class ConflictError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "ConflictError";
}

/**
 * 409 PRICE_CHANGED: `details.newPrice` holds the new selling price; re-confirm to continue. `pricedOfferId` is
 * `details.pricedOfferId` (the flights.d.ts augmentation): continue with it once the customer accepts `newPrice`.
 */
export class PriceChangedError extends ConflictError {
  /** @override @readonly @type {string} */
  name = "PriceChangedError";

  /**
   * @param {VelexisErrorInit} error
   * @param {VelexisErrorOptions} [options]
   */
  constructor(error, options) {
    super(error, options);
    /** @type {Record<string, unknown>} */
    const details = this.details ?? {};
    /** @readonly @type {Money | undefined} */
    this.newPrice = moneyOf(details["newPrice"]);
    /** @readonly @type {Money | undefined} */
    this.oldPrice = moneyOf(details["oldPrice"]);
    /** @readonly @type {string | undefined} */
    this.pricedOfferId = typeof details["pricedOfferId"] === "string" ? details["pricedOfferId"] : undefined;
  }
}

/** 409 SOLD_OUT. */
export class SoldOutError extends ConflictError {
  /** @override @readonly @type {string} */
  name = "SoldOutError";
}

/** 410 OFFER_EXPIRED / SEARCH_EXPIRED / CHECKOUT_EXPIRED. */
export class ExpiredError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "ExpiredError";
}

/** 402 PAYMENT_REQUIRED / PAYMENT_DECLINED. */
export class PaymentError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "PaymentError";
}

/** 429 RATE_LIMITED: `retryAfterSeconds` from `Retry-After` (or `details.retryAfterSeconds`). */
export class RateLimitError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "RateLimitError";

  /**
   * @param {VelexisErrorInit} error
   * @param {VelexisErrorOptions} [options]
   */
  constructor(error, options = {}) {
    super(error, options);
    /** @readonly @type {number | undefined} */
    this.retryAfterSeconds =
      secondsOf(options.retryAfterSeconds) ?? secondsOf(this.details?.["retryAfterSeconds"]);
  }
}

/** 424 SUPPLIER_NOT_CONFIGURED, 502 SUPPLIER_ERROR / TICKETING_FAILED, 503 SUPPLIER_UNAVAILABLE, 504 SUPPLIER_TIMEOUT. */
export class SupplierError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "SupplierError";
}

/** Network failure, timeout or abort before a response was received (status 0). */
export class ConnectionError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "ConnectionError";
}

/** 500 / 503 from Velexis, and 501 NOT_IMPLEMENTED for deferred operations (`retryable: false`). */
export class ServerError extends VelexisError {
  /** @override @readonly @type {string} */
  name = "ServerError";
}

/**
 * Type guard for SDK errors, optionally with a given code.
 * @param {unknown} e
 * @param {ErrorCode} [code]
 * @returns {e is VelexisError}
 */
export function isVelexisError(e, code) {
  return e instanceof VelexisError && (code === undefined || e.code === code);
}
