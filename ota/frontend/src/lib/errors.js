// From an SDK error to the state a page shows (ota/frontend/README.md §5.2, ota/frontend/docs/pages.md §2 and the
// state table of each page, conventions §4). Pages never branch on HTTP statuses or messages: they ask
// `pageStateFor(error)` and render the state by its name, with the English text of lib/i18n.js.
//
// - `scope: "page"` states replace the whole page (an unknown or suspended storefront); the others are shown inline.
// - `retry` says whether the same call may succeed later (the SDK's `retryable`); a page still decides whether it
//   offers Retry (a payment is never resubmitted after `SUPPLIER_TIMEOUT`).
// - `ABORTED` (a call the page cancelled itself, such as a superseded autocomplete request) is the `aborted` state,
//   which pages ignore.

import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  ExpiredError,
  NotFoundError,
  PaymentError,
  PermissionError,
  RateLimitError,
  SupplierError,
  ValidationError,
  VelexisError,
} from "@velexis/ota-sdk";

import { t } from "./i18n.js";

/**
 * The page states. Every name has a text `state.<name>` in lib/i18n.js.
 * @typedef {(
 *   | "suspended" | "unknown-host" | "unavailable" | "rate-limited" | "supplier-not-configured"
 *   | "supplier-unavailable" | "supplier-timeout" | "supplier-error" | "search-expired" | "offer-expired"
 *   | "checkout-expired" | "expired" | "price-changed" | "sold-out" | "stale" | "conflict" | "payment-failed"
 *   | "not-found" | "signed-out" | "email-not-verified" | "feature-disabled" | "forbidden" | "validation" | "aborted"
 *   | "unexpected"
 * )} PageStateName
 */

/**
 * What a page shows for an error.
 * @typedef {object} PageState
 * @property {PageStateName} name the state to render
 * @property {"page" | "inline"} scope `page` replaces the page content (boot's full-page states), `inline` sits in it
 * @property {string} message the English text of the state (lib/i18n.js), set with `textContent`
 * @property {string} code the API's error code (`NETWORK_ERROR`, `TIMEOUT`, `ABORTED` for client failures;
 *   `UNEXPECTED` for an error that did not come from the SDK)
 * @property {number} status the HTTP status (0 when no response arrived)
 * @property {boolean} retry whether the same call may succeed later
 * @property {number | undefined} retryAfterSeconds for `rate-limited`: when Retry may be enabled again
 * @property {import("@velexis/ota-sdk").Schemas["FieldError"][]} fieldErrors for `validation`: for lib/forms.js
 * @property {Record<string, unknown> | undefined} details code-specific details (`newPrice`, `bookingId`, …)
 */

/** Error codes with their own state. */
const STATE_BY_CODE = /** @type {const} */ ({
  TENANT_SUSPENDED: "suspended",
  HOST_NOT_ALLOWED: "unknown-host",
  SERVICE_UNAVAILABLE: "unavailable",
  NETWORK_ERROR: "unavailable",
  TIMEOUT: "unavailable",
  ABORTED: "aborted",
  RATE_LIMITED: "rate-limited",
  SUPPLIER_NOT_CONFIGURED: "supplier-not-configured",
  SUPPLIER_UNAVAILABLE: "supplier-unavailable",
  SUPPLIER_TIMEOUT: "supplier-timeout",
  SUPPLIER_ERROR: "supplier-error",
  SUPPLIER_REJECTED: "supplier-error",
  SEARCH_EXPIRED: "search-expired",
  OFFER_EXPIRED: "offer-expired",
  CHECKOUT_EXPIRED: "checkout-expired",
  PRICE_CHANGED: "price-changed",
  SOLD_OUT: "sold-out",
  PRECONDITION_FAILED: "stale",
  VERSION_CONFLICT: "stale",
  PAYMENT_REQUIRED: "payment-failed",
  PAYMENT_DECLINED: "payment-failed",
  NOT_FOUND: "not-found",
  UNAUTHENTICATED: "signed-out",
  TOKEN_EXPIRED: "signed-out",
  REFRESH_TOKEN_INVALID: "signed-out",
  REFRESH_TOKEN_REUSED: "signed-out",
  EMAIL_NOT_VERIFIED: "email-not-verified",
  FEATURE_DISABLED: "feature-disabled",
  VALIDATION_FAILED: "validation",
  INVALID_REQUEST: "validation",
  UNPROCESSABLE: "validation",
  TRAVELER_DATA_INVALID: "validation",
  CONTACT_DATA_INVALID: "validation",
});

/**
 * Other codes by the SDK's error class (the HTTP status family). Server errors (`INTERNAL_ERROR`, `NOT_IMPLEMENTED`)
 * and anything else are `unexpected`.
 * @type {ReadonlyArray<[typeof VelexisError, PageStateName]>}
 */
const STATE_BY_CLASS = [
  [ValidationError, "validation"],
  [AuthenticationError, "signed-out"],
  [PermissionError, "forbidden"],
  [NotFoundError, "not-found"],
  [ConflictError, "conflict"],
  [ExpiredError, "expired"],
  [PaymentError, "payment-failed"],
  [SupplierError, "supplier-error"],
  [ConnectionError, "unavailable"],
  [RateLimitError, "rate-limited"],
];

/** States that replace the whole page. */
const FULL_PAGE_STATES = new Set(["suspended", "unknown-host"]);

/**
 * The state of a VelexisError: by its code, else by its class.
 * @param {VelexisError} error
 * @returns {PageStateName}
 */
function stateNameOf(error) {
  if (Object.hasOwn(STATE_BY_CODE, error.code)) {
    return STATE_BY_CODE[/** @type {keyof typeof STATE_BY_CODE} */ (error.code)];
  }
  const byClass = STATE_BY_CLASS.find(([errorClass]) => error instanceof errorClass);
  return byClass ? byClass[1] : "unexpected";
}

/**
 * The page state for an error thrown by an SDK call (or anything else a page caught: a non-SDK error is
 * `unexpected`, never retried automatically).
 * @param {unknown} error
 * @returns {PageState}
 */
export function pageStateFor(error) {
  if (!(error instanceof VelexisError)) {
    return {
      name: "unexpected",
      scope: "inline",
      message: t("state.unexpected"),
      code: "UNEXPECTED",
      status: 0,
      retry: false,
      retryAfterSeconds: undefined,
      fieldErrors: [],
      details: undefined,
    };
  }
  const name = stateNameOf(error);
  const retryAfter = /** @type {{ retryAfterSeconds?: unknown }} */ (error).retryAfterSeconds;
  return {
    name,
    scope: FULL_PAGE_STATES.has(name) ? "page" : "inline",
    message: t(`state.${name}`),
    code: error.code,
    status: error.status,
    retry: error.retryable,
    retryAfterSeconds: typeof retryAfter === "number" ? retryAfter : undefined,
    fieldErrors: error.fieldErrors,
    details: error.details,
  };
}

/**
 * Whether an error only means the page cancelled the call itself (nothing to show).
 * @param {unknown} error
 */
export const isAborted = (error) => error instanceof VelexisError && error.code === "ABORTED";
