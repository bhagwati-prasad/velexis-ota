// lib/errors.js (ota/frontend/README.md §5.2, ota/frontend/docs/pages.md §2 and the pages' state tables): an SDK
// error becomes a named page state with its English text, its scope (full page or inline), whether it may be retried
// and the details a page needs (`retryAfterSeconds`, `fieldErrors`, `details`).
import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  ExpiredError,
  NotFoundError,
  PermissionError,
  PriceChangedError,
  RateLimitError,
  ServerError,
  SoldOutError,
  SupplierError,
  ValidationError,
} from "@velexis/ota-sdk";
import { describe, expect, it } from "vitest";

import { isAborted, pageStateFor } from "../src/lib/errors.js";
import { hasString } from "../src/lib/i18n.js";

/**
 * An SDK error as the SDK builds it from the API's error body.
 * @param {new (init: { code: string, message: string, status: number, requestId: string }, options?: object) => Error} ErrorClass
 * @param {string} code
 * @param {number} status
 * @param {Record<string, unknown>} [extra] more of the body (`details`, `fieldErrors`)
 * @param {object} [options]
 */
const sdkError = (ErrorClass, code, status, extra = {}, options = {}) =>
  new ErrorClass({ code, message: `${code} message`, status, requestId: "req_ofe002", ...extra }, options);

describe("pageStateFor", () => {
  it("[OFE-002 AC1] renders the shared full-page states for a suspended or unknown storefront", () => {
    const suspended = pageStateFor(sdkError(PermissionError, "TENANT_SUSPENDED", 403));
    const unknown = pageStateFor(sdkError(PermissionError, "HOST_NOT_ALLOWED", 403));

    expect(suspended).toMatchObject({
      name: "suspended",
      scope: "page",
      message: "This travel site is temporarily unavailable",
      code: "TENANT_SUSPENDED",
      status: 403,
      retry: false,
    });
    expect(unknown).toMatchObject({
      name: "unknown-host",
      scope: "page",
      message: "This storefront does not exist",
    });
  });

  it("[OFE-002 AC1] maps every dedicated code of pages.md to its inline state", () => {
    const cases = /** @type {const} */ ([
      [ServerError, "SERVICE_UNAVAILABLE", 503, "unavailable", true],
      [ConnectionError, "NETWORK_ERROR", 0, "unavailable", true],
      [ConnectionError, "TIMEOUT", 0, "unavailable", true],
      [SupplierError, "SUPPLIER_NOT_CONFIGURED", 424, "supplier-not-configured", false],
      [SupplierError, "SUPPLIER_TIMEOUT", 504, "supplier-timeout", true],
      [SupplierError, "SUPPLIER_UNAVAILABLE", 503, "supplier-unavailable", true],
      [ExpiredError, "SEARCH_EXPIRED", 410, "search-expired", false],
      [ExpiredError, "OFFER_EXPIRED", 410, "offer-expired", false],
      [ExpiredError, "CHECKOUT_EXPIRED", 410, "checkout-expired", false],
      [PriceChangedError, "PRICE_CHANGED", 409, "price-changed", false],
      [SoldOutError, "SOLD_OUT", 409, "sold-out", false],
      [ConflictError, "PRECONDITION_FAILED", 412, "stale", false],
      [PermissionError, "EMAIL_NOT_VERIFIED", 403, "email-not-verified", false],
      [PermissionError, "FEATURE_DISABLED", 403, "feature-disabled", false],
      [AuthenticationError, "TOKEN_EXPIRED", 401, "signed-out", false],
      [NotFoundError, "NOT_FOUND", 404, "not-found", false],
      [ValidationError, "TRAVELER_DATA_INVALID", 422, "validation", false],
    ]);
    for (const [ErrorClass, code, status, name, retry] of cases) {
      expect(pageStateFor(sdkError(ErrorClass, code, status)), code).toMatchObject({
        name,
        scope: "inline",
        code,
        status,
        retry,
      });
    }
  });

  it("[OFE-002 AC1] carries Retry-After, field errors and details to the page", () => {
    const limited = pageStateFor(sdkError(RateLimitError, "RATE_LIMITED", 429, {}, { retryAfterSeconds: 7 }));
    const invalid = pageStateFor(
      sdkError(ValidationError, "VALIDATION_FAILED", 400, {
        fieldErrors: [{ path: "/departureDate", code: "format" }],
      }),
    );
    const changed = pageStateFor(
      sdkError(PriceChangedError, "PRICE_CHANGED", 409, {
        details: { newPrice: { amount: "420.00", currency: "EUR" }, pricedOfferId: "prc_02" },
      }),
    );

    expect(limited).toMatchObject({
      name: "rate-limited",
      message: "Busy, try again in a few seconds",
      retry: true,
      retryAfterSeconds: 7,
    });
    expect(invalid).toMatchObject({
      name: "validation",
      fieldErrors: [{ path: "/departureDate", code: "format" }],
    });
    expect(changed.details).toEqual({
      newPrice: { amount: "420.00", currency: "EUR" },
      pricedOfferId: "prc_02",
    });
  });

  it("[OFE-002 AC1] falls back on the error class, then on the unexpected state", () => {
    expect(pageStateFor(sdkError(ConflictError, "BOOKING_NOT_MODIFIABLE", 409)).name).toBe("conflict");
    expect(pageStateFor(sdkError(ExpiredError, "SOMETHING_EXPIRED", 410)).name).toBe("expired");
    expect(pageStateFor(sdkError(PermissionError, "SCOPE_NOT_ALLOWED", 403)).name).toBe("forbidden");
    expect(pageStateFor(sdkError(SupplierError, "SUPPLIER_ERROR", 502)).name).toBe("supplier-error");
    expect(pageStateFor(sdkError(ServerError, "INTERNAL_ERROR", 500))).toMatchObject({
      name: "unexpected",
      retry: true,
    });
    // A deferred operation stays deferred: never retried.
    expect(pageStateFor(sdkError(ServerError, "NOT_IMPLEMENTED", 501))).toMatchObject({
      name: "unexpected",
      retry: false,
    });
    expect(pageStateFor(new TypeError("bug"))).toMatchObject({
      name: "unexpected",
      scope: "inline",
      code: "UNEXPECTED",
      status: 0,
      retry: false,
      message: "Something went wrong. Please try again.",
      fieldErrors: [],
    });
  });

  it("[OFE-002 AC1] tells a call the page aborted itself apart, and has a text for every state", () => {
    const aborted = sdkError(ConnectionError, "ABORTED", 0);

    expect(isAborted(aborted)).toBe(true);
    expect(isAborted(sdkError(ConnectionError, "TIMEOUT", 0))).toBe(false);
    expect(isAborted(new Error("ABORTED"))).toBe(false);
    expect(pageStateFor(aborted)).toMatchObject({ name: "aborted", retry: false });
    for (const name of [
      "suspended",
      "unknown-host",
      "unavailable",
      "rate-limited",
      "supplier-not-configured",
      "supplier-unavailable",
      "supplier-timeout",
      "supplier-error",
      "search-expired",
      "offer-expired",
      "checkout-expired",
      "expired",
      "price-changed",
      "sold-out",
      "stale",
      "conflict",
      "payment-failed",
      "not-found",
      "signed-out",
      "email-not-verified",
      "feature-disabled",
      "forbidden",
      "validation",
      "aborted",
      "unexpected",
    ]) {
      expect(hasString(`state.${name}`), name).toBe(true);
    }
  });
});
