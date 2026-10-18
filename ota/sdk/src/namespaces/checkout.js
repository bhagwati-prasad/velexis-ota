// The `checkout` namespace (docs/velexis-sdk/sdk/src/bookings.d.ts `CheckoutApi`, guide B3 §2, ota/sdk/README.md §5.2,
// ota/sdk/docs/extensions.md §3.1, OADR-0016 points 1–3 and 6, OADR-0017 point 6): a priced offer (`prc_…`) becomes a
// checkout (`chk_…`) that collects travellers, contacts, extras and special requests, gets a payment (`pay_…`) and is
// completed into a booking. The ten methods of the contract and the MVP addition `completeWithAirlineCard`, each one
// call through the generated route table (internal/operations.js; `completeWithAirlineCard` also rebuilds its errors,
// below). The table gives `complete` and `completeWithAirlineCard` their 90 s timeout, the four POSTs their generated
// `Idempotency-Key` and `completeWithAirlineCard` its `retry: "never"`; `CheckoutApi` in bookings.js is inferred from
// this factory. The checkout steps take an optional `ifMatch`, the checkout `version` (sent as `If-Match: "<version>"`)
// or its ETag.
//
// Everything here is personal, priced or time-limited, so every method sends `cache: "no-store"` to `fetch` unless the
// call sets `cache` or `next` itself (bookings.d.ts "Caching", B3 §1).
//
// `completeWithAirlineCard` carries the traveller's card (hosted storefront only, OADR-0017). The card is sent once per
// call: never retried, not even after `TOKEN_EXPIRED` or `CSRF_TOKEN_INVALID` (internal/session.js). Its arguments
// never reach an error or a hook: the transport keeps no request in an error, and `onResponse` gets the method, the
// API path, the status, the request id and the duration only. On top of that, an error of the call is rebuilt without
// anything of the card that the API or a proxy might have echoed, or the `fetch` in use kept in its failure
// (`withoutCard`).

import { op } from "../internal/operations.js";
import { RateLimitError, VelexisError } from "../shared.js";

/** @typedef {import("../internal/client.js").Core} Core */
/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @typedef {import("../shared.js").VelexisErrorInit} VelexisErrorInit */
/** @typedef {import("../shared.js").VelexisErrorOptions} VelexisErrorOptions */
/** @typedef {import("../types.js").Schemas} Schemas */
/** @typedef {import("../bookings.js").Checkout} Checkout */
/** @typedef {import("../bookings.js").CheckoutCompletion} CheckoutCompletion */
/** @typedef {import("../bookings.js").Payment} Payment */
/** @typedef {import("../bookings.js").CreateCheckoutParams} CreateCheckoutParams */
/** @typedef {import("../bookings.js").CheckoutRefParams} CheckoutRefParams */
/** @typedef {import("../bookings.js").SetCheckoutTravelersParams} SetCheckoutTravelersParams */
/** @typedef {import("../bookings.js").SetCheckoutContactsParams} SetCheckoutContactsParams */
/** @typedef {import("../bookings.js").SetCheckoutAncillariesParams} SetCheckoutAncillariesParams */
/** @typedef {import("../bookings.js").SetCheckoutRemarksParams} SetCheckoutRemarksParams */
/** @typedef {import("../bookings.js").CreateCheckoutPaymentParams} CreateCheckoutPaymentParams */
/** @typedef {import("../bookings.js").UpdatePaymentParams} UpdatePaymentParams */
/** @typedef {import("../bookings.js").GetPaymentParams} GetPaymentParams */
/** @typedef {import("../bookings.js").CompleteCheckoutParams} CompleteCheckoutParams */
/** @typedef {import("../bookings.js").CompleteWithAirlineCardParams} CompleteWithAirlineCardParams */
/** @typedef {import("../shared.js").ValidationError} ValidationError */
/** @typedef {import("../shared.js").AuthenticationError} AuthenticationError */
/** @typedef {import("../shared.js").PaymentError} PaymentError */
/** @typedef {import("../shared.js").PermissionError} PermissionError */
/** @typedef {import("../shared.js").NotFoundError} NotFoundError */
/** @typedef {import("../shared.js").ConflictError} ConflictError */
/** @typedef {import("../shared.js").PriceChangedError} PriceChangedError */
/** @typedef {import("../shared.js").SoldOutError} SoldOutError */
/** @typedef {import("../shared.js").ExpiredError} ExpiredError */
/** @typedef {import("../shared.js").SupplierError} SupplierError */
/** @typedef {import("../shared.js").ServerError} ServerError */

/**
 * Whether a value is a plain object, the only kind of params and options `core.call` accepts.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * The request options of one `checkout.*` call with the contract's default fetch cache mode, `no-store`: checkouts and
 * payments are personal, priced and time-limited. A call that sets `cache` or `next` keeps its own choice. Options that
 * are not a plain object are passed on unchanged, so `core.call` refuses them with its usual `TypeError` (a copy would
 * accept them and drop what they inherit).
 * @param {RequestOptions | undefined} options
 * @returns {RequestOptions | undefined}
 */
function live(options) {
  if (
    options !== undefined &&
    (!isPlainObject(options) || options.cache !== undefined || options.next !== undefined)
  ) {
    return options;
  }
  return { ...options, cache: "no-store" };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Errors of the airline-card completion                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

/** What replaces a card value in the texts of an error. */
const REDACTED = "[redacted]";

/**
 * Keys whose values an error of `completeWithAirlineCard` never keeps in `details` and `supplier`: the request's `card`
 * and its fields, and the names Amadeus gives them in `formOfPayments[].creditCard`.
 */
const CARD_KEYS = new Set([
  "card",
  "creditCard",
  "number",
  "holderName",
  "holder",
  "securityCode",
  "expiryMonth",
  "expiryYear",
  "expiryDate",
]);

/** How many levels deep an error's `cause` (its own fields, its causes, their fields …) is checked for card values. */
const MAX_CAUSE_DEPTH = 8;

/**
 * A text for a regular expression that matches it literally.
 * @param {string} text
 */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern of a run of digits, also with a space or a dash between two of them (`4242 4242 4242 4242`).
 * @param {string} digits
 */
const digitRun = (digits) => new RegExp(digits.split("").join("[ -]?"), "g");

/**
 * A pattern of a text as a whole word: `\b` on each side that starts or ends with a word character. (No lookbehind,
 * which older Safari versions cannot compile.)
 * @param {string} source the pattern of the text
 * @param {string} text the text itself
 * @param {string} flags
 */
const wholeWord = (source, text, flags) =>
  new RegExp(`${/^\w/.test(text) ? "\\b" : ""}${source}${/\w$/.test(text) ? "\\b" : ""}`, flags);

/**
 * The patterns of the card values that must never appear in the texts of an error: the number (with or without
 * separators) and its last 12 digits (only the last 4 may be shown), the security code and the holder name (as whole
 * words, in any case and with any spacing). A number of fewer than 5 digits is at most the last 4 and stays. The card
 * may be any object (a class instance or an object of another realm is sent with its own fields too).
 * @param {unknown} params the params of the call
 * @returns {RegExp[]}
 */
function cardPatterns(params) {
  const value = isPlainObject(params) ? params["card"] : undefined;
  if (value === null || typeof value !== "object") {
    return [];
  }
  const card = /** @type {Record<string, unknown>} */ (value);
  /** @param {unknown} value */
  const textOf = (value) =>
    typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  /** @type {RegExp[]} */
  const patterns = [];
  const digits = textOf(card["number"]).replace(/\D/g, "");
  if (digits.length >= 5) {
    patterns.push(digitRun(digits));
  }
  if (digits.length > 12) {
    patterns.push(digitRun(digits.slice(-12)));
  }
  const securityCode = textOf(card["securityCode"]);
  if (securityCode !== "") {
    patterns.push(wholeWord(literal(securityCode), securityCode, "g"));
  }
  const holderName = textOf(card["holderName"]);
  if (holderName !== "") {
    patterns.push(wholeWord(holderName.split(/\s+/).map(literal).join("\\s+"), holderName, "gi"));
  }
  return patterns;
}

/**
 * Whether a value holds no card value and no card-named key, a few levels deep: texts and numbers the card's patterns
 * do not match, arrays and plain objects of such values, and `Error`s whose name, message, stack and own fields are
 * such values (their `cause`, an `AggregateError`'s `errors` and fields such as a fetch library's `options` or
 * `request` included). Anything that cannot be checked without running its code (a getter, a `Request`, a `Buffer`,
 * a class instance) counts as holding the card.
 * @param {unknown} value
 * @param {(text: string) => string} scrub
 * @param {number} [depth]
 * @returns {boolean}
 */
function holdsNoCard(value, scrub, depth = 0) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "function") {
    return true;
  }
  if (typeof value !== "object") {
    // A string, a number, a bigint or a symbol: as `inspect` and `JSON.stringify` would print it.
    const text = String(value);
    return scrub(text) === text;
  }
  if (depth >= MAX_CAUSE_DEPTH) {
    return false;
  }
  const isError = value instanceof Error;
  if (!isError && !Array.isArray(value) && !isPlainObject(value)) {
    return false;
  }
  if (isError && ![value.name, value.message, value.stack].every((text) => holdsNoCard(text, scrub))) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key === "string" && CARD_KEYS.has(key)) {
      return false;
    }
    // V8 gives every error an own `stack` accessor, read above; any other getter could compute anything.
    if (isError && key === "stack") {
      return true;
    }
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(value, key));
    return "value" in descriptor && holdsNoCard(descriptor.value, scrub, depth + 1);
  });
}

/**
 * The error of a `completeWithAirlineCard` call without anything of the card, whatever the API or a proxy echoed:
 * a new error of the same class with the same code, status, request id and retry facts, whose message and texts have
 * the card's values redacted (texts and numbers), whose `details` and `supplier` lose every card-named field, whose
 * field errors keep their `path`, `code` and `message` only (never a value), and whose `cause` stays only when nothing
 * in it, its fields and its own causes included, holds a card value or a card-named field (`holdsNoCard`). Anything
 * that is not a `VelexisError` (the `TypeError` of an invalid param) is the SDK's own and holds no value.
 * @param {unknown} error what the call threw
 * @param {unknown} params the params of the call
 * @returns {unknown}
 */
function withoutCard(error, params) {
  if (!(error instanceof VelexisError)) {
    return error;
  }
  const patterns = cardPatterns(params);
  /** @param {string} text */
  const scrub = (text) => patterns.reduce((result, pattern) => result.replace(pattern, REDACTED), text);
  /**
   * @param {unknown} value
   * @returns {unknown}
   */
  const clean = (value) => {
    if (typeof value === "string") {
      return scrub(value);
    }
    // A JSON number can hold the card number (below 2^53) or the security code.
    if (typeof value === "number") {
      return scrub(String(value)) === String(value) ? value : REDACTED;
    }
    if (Array.isArray(value)) {
      return value.map(clean);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !CARD_KEYS.has(key))
          .map(([key, item]) => [key, clean(item)]),
      );
    }
    return value;
  };
  /** @type {VelexisErrorInit} */
  const init = {
    code: error.code,
    message: scrub(error.message),
    status: error.status,
    requestId: error.requestId === null ? null : scrub(error.requestId),
    fieldErrors: error.fieldErrors.map(({ path, code, message }) => ({
      path: scrub(path),
      code: scrub(code),
      ...(typeof message === "string" ? { message: scrub(message) } : {}),
    })),
    ...(error.details === undefined
      ? {}
      : { details: /** @type {Record<string, unknown>} */ (clean(error.details)) }),
    ...(error.supplier === undefined
      ? {}
      : { supplier: /** @type {Schemas["SupplierIssue"]} */ (clean(error.supplier)) }),
  };
  /** @type {VelexisErrorOptions} */
  const options = {};
  if (error instanceof RateLimitError && error.retryAfterSeconds !== undefined) {
    options.retryAfterSeconds = error.retryAfterSeconds;
  }
  if (error.cause !== undefined && holdsNoCard(error.cause, scrub)) {
    options.cause = error.cause;
  }
  // Every class of shared.js takes the same arguments; the new error is of the class the call threw.
  const ErrorClass = /** @type {typeof VelexisError} */ (/** @type {unknown} */ (error.constructor));
  return new ErrorClass(init, options);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Namespace                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The `checkout` namespace of a client.
 * @param {Core} core the client's request core
 */
export function createCheckoutApi(core) {
  return {
    /**
     * Opens a checkout for a priced offer (`prc_…` from `flights.price`): one empty traveller slot per Amadeus
     * traveller, `requirements` from the priced offer's booking requirements and, for a signed-in customer, the
     * primary contact prefilled from the profile. `POST /v1/checkouts` with a generated `Idempotency-Key` (pass
     * `options.idempotencyKey` to control it); no Amadeus call.
     * @param {CreateCheckoutParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Checkout>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED` (guest checkout disabled: sign in), `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `FEATURE_DISABLED`, `EMAIL_NOT_VERIFIED`
     * @throws {NotFoundError} `NOT_FOUND` (unknown priced offer, or another customer's)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`
     * @throws {ExpiredError} `OFFER_EXPIRED` (price again with `flights.price`)
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    create: (params, options) => core.call(op.checkout_create, params, live(options)),

    /**
     * Gets the whole checkout: status, totals, price change, requirements, progress, travellers (document numbers
     * masked), contacts, ancillaries, special requests, the active payment without `clientSecret`, itineraries,
     * ticketing policy and, once completed, `bookingId`. Expired and completed checkouts stay readable.
     * `GET /v1/checkouts/{checkoutId}` (`ETag` = `"<version>"`).
     * @param {CheckoutRefParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Checkout>}
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    get: (params, options) => core.call(op.checkout_get, params, live(options)),

    /**
     * Stores travellers keyed by `travelerId` (the Amadeus id `"1"`, `"2"`, …): name, date of birth, gender, contact,
     * documents, loyalty programmes, discounts, emergency contact; `savedTravelerId` copies a saved traveller of the
     * signed-in customer. Each listed traveller is replaced, the others are kept; validated against the requirements,
     * all or nothing. A document without `number` keeps the stored number. `PUT /v1/checkouts/{checkoutId}/travelers`
     * with the optional `ifMatch` as `If-Match`; no Amadeus call.
     * @param {SetCheckoutTravelersParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Checkout>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `TRAVELER_DATA_INVALID` (422, `fieldErrors` with paths such as `/travelers/0/documents/0/expiryDate`)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {ConflictError} `CHECKOUT_ALREADY_COMPLETED`
     * @throws {ExpiredError} `CHECKOUT_EXPIRED`
     * @throws {VelexisError} `PRECONDITION_FAILED` (412, stale `ifMatch`)
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    setTravelers: (params, options) => core.call(op.checkout_setTravelers, params, live(options)),

    /**
     * Replaces the booking contacts (1–3, Amadeus `Contact`: purpose, addressee or company name, e-mail, phones,
     * address, language) and marks the primary contact, who receives the confirmation, the documents and, for a
     * guest, the booking token. Validated against `requirements.contact`. `PUT /v1/checkouts/{checkoutId}/contacts`
     * with the optional `ifMatch` as `If-Match`; no Amadeus call.
     * @param {SetCheckoutContactsParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Checkout>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `CONTACT_DATA_INVALID` (422, `fieldErrors` such as `PRIMARY_CONTACT_REQUIRED`, `MOBILE_PHONE_REQUIRED`)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {ConflictError} `CHECKOUT_ALREADY_COMPLETED`
     * @throws {ExpiredError} `CHECKOUT_EXPIRED`
     * @throws {VelexisError} `PRECONDITION_FAILED` (412, stale `ifMatch`)
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    setContacts: (params, options) => core.call(op.checkout_setContacts, params, live(options)),

    /**
     * Selects ancillaries per traveller and segment (`optionId` from `flights.getAncillaries`, or an explicit type)
     * and re-prices the checkout with Amadeus Flight Offers Price; `selections: []` removes them all without an Amadeus
     * call. With `expectedTotal`, a different re-priced total throws `PriceChangedError` and leaves the checkout
     * unchanged. A payment not confirmed yet follows the new amount; an authorised one is voided (create a new one).
     * `PUT /v1/checkouts/{checkoutId}/ancillaries` with the optional `ifMatch` as `If-Match`.
     * @param {SetCheckoutAncillariesParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Checkout>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `ANCILLARY_NOT_AVAILABLE` (422, `details.selectionIndex`, `details.reason`)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `FEATURE_DISABLED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {PriceChangedError} `PRICE_CHANGED` (checkout unchanged: call again with `expectedTotal` = `newPrice`)
     * @throws {SoldOutError} `SOLD_OUT`
     * @throws {ConflictError} `CHECKOUT_ALREADY_COMPLETED`
     * @throws {ExpiredError} `CHECKOUT_EXPIRED`, `OFFER_EXPIRED`
     * @throws {VelexisError} `PRECONDITION_FAILED` (412, stale `ifMatch`)
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504, nothing changed)
     * @throws {ServerError} `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
     */
    setAncillaries: (params, options) => core.call(op.checkout_setAncillaries, params, live(options)),

    /**
     * Replaces the customer's special requests (at most 5 of 110 characters), which become Amadeus general remarks at
     * completion for the OTA's staff (not sent to the airline). `remarks: []` removes them.
     * `PUT /v1/checkouts/{checkoutId}/remarks` with the optional `ifMatch` as `If-Match`; no Amadeus call.
     * @param {SetCheckoutRemarksParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Checkout>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {ConflictError} `CHECKOUT_ALREADY_COMPLETED`
     * @throws {ExpiredError} `CHECKOUT_EXPIRED`
     * @throws {VelexisError} `PRECONDITION_FAILED` (412, stale `ifMatch`)
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    setRemarks: (params, options) => core.call(op.checkout_setRemarks, params, live(options)),

    /**
     * Creates the payment of the checkout total (`termsAccepted: true`, complete travellers and contacts). With
     * `method: "card"` the OTA's provider gets a payment session: `clientSecret` and `providerPublicKey` for its
     * front-end SDK, or a `redirectUrl`. With `method: "airline_card"` (hosted storefront only, when the OTA allows it)
     * the checkout moves to the airline's price, no provider is called and `nextAction.type` is `airline_card_form`:
     * collect the card on the card page and call `completeWithAirlineCard`. The card brand and BIN are usually unknown
     * here; send them with `updatePayment`. `POST /v1/checkouts/{checkoutId}/payments` with a generated
     * `Idempotency-Key` (the same key is used at the provider).
     * @param {CreateCheckoutPaymentParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Payment>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `CHECKOUT_INCOMPLETE` (422, `fieldErrors`), `UNPROCESSABLE` (422, card brand not accepted)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `FEATURE_DISABLED` (method not enabled), `SCOPE_NOT_ALLOWED` (`airline_card` from a key caller)
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {PriceChangedError} `PRICE_CHANGED` (the fare moved while the card fee was fetched; checkout updated)
     * @throws {ConflictError} `CHECKOUT_ALREADY_COMPLETED`, `IDEMPOTENCY_KEY_REUSED`
     * @throws {ExpiredError} `CHECKOUT_EXPIRED`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {SupplierError} `PAYMENT_PROVIDER_NOT_CONFIGURED`, `SUPPLIER_NOT_CONFIGURED` (424), `PAYMENT_PROVIDER_ERROR`, `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
     */
    createPayment: (params, options) => core.call(op.checkout_createPayment, params, live(options)),

    /**
     * Sets or replaces the card hint (brand and BIN) of a payment that is still `requires_payment_method` and
     * re-quotes the credit-card fee: the same payment (same `clientSecret`) gets the new `amount` and `cardFee`, and
     * the checkout its `totals.cardFee` and `total`. Call it when the card form reports the brand, then show the new
     * amount before the customer confirms. Never send more of the card than brand and BIN.
     * `PATCH /v1/payments/{paymentId}`; the same hint again changes nothing. Not retried automatically (a `PATCH`
     * without an idempotency key).
     * @param {UpdatePaymentParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Payment>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `UNPROCESSABLE` (422, card brand not accepted)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {ConflictError} `PAYMENT_NOT_UPDATABLE` (`details.status`: create a new payment), `CHECKOUT_ALREADY_COMPLETED`
     * @throws {PriceChangedError} `PRICE_CHANGED` (checkout moved to the new price and this payment was cancelled)
     * @throws {ExpiredError} `CHECKOUT_EXPIRED`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `PAYMENT_PROVIDER_ERROR`, `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504); nothing changed
     * @throws {ServerError} `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
     */
    updatePayment: (params, options) => core.call(op.checkout_updatePayment, params, live(options)),

    /**
     * Gets a payment: status, amounts, card summary (brand and last 4 only), 3-D Secure state and failure. Non-final
     * statuses are refreshed from the provider when older than 5 s, so polling every 2 s is fine. Final statuses:
     * `authorized` and `captured` (complete the checkout), `failed` and `cancelled` (create a new payment).
     * `GET /v1/payments/{paymentId}`.
     * @param {GetPaymentParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Payment>}
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {ServerError} `INTERNAL_ERROR`
     */
    getPayment: (params, options) => core.call(op.checkout_getPayment, params, live(options)),

    /**
     * Completes the checkout: verifies the payment, re-prices when needed, creates the Amadeus flight order, captures
     * the payment and issues tickets per the OTA's ticketing policy. Resolves with the booking and, for a guest with a
     * key, the one-time `bookingToken` (`null` in cookie mode, where it is the `__Host-vx_bt` cookie).
     * `POST /v1/checkouts/{checkoutId}/complete` with a 90 s timeout and an `Idempotency-Key`: pass a stable
     * `options.idempotencyKey` per attempt (for example `complete-<checkoutId>-<paymentId>`). A same-key request
     * replays the stored outcome and never books twice, so the automatic retries on 429, 503, 504 and network errors
     * send the same key. After `504 SUPPLIER_TIMEOUT` the order may exist: poll the booking (`details.bookingId`) and
     * never complete again with a new key.
     * @param {CompleteCheckoutParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<CheckoutCompletion>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `CHECKOUT_INCOMPLETE`, `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID`, `UNPROCESSABLE` (422; `details.reason = "use_airline_card_completion"` for an airline-card payment)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PaymentError} `PAYMENT_REQUIRED` (payment not authorised yet), `PAYMENT_DECLINED` (402)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `EMAIL_NOT_VERIFIED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {PriceChangedError} `PRICE_CHANGED` (authorisation voided, checkout moved to the new price: create a new payment)
     * @throws {SoldOutError} `SOLD_OUT` (nothing booked, payment voided)
     * @throws {ConflictError} `CHECKOUT_ALREADY_COMPLETED` (`details.bookingId`), `PAYMENT_AMOUNT_MISMATCH`, `IDEMPOTENCY_KEY_REUSED`
     * @throws {ExpiredError} `CHECKOUT_EXPIRED`, `OFFER_EXPIRED`
     * @throws {RateLimitError} `RATE_LIMITED`
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED`, `PAYMENT_PROVIDER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR`, `TICKETING_FAILED`, `PAYMENT_PROVIDER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504, `CheckoutTimeoutDetails`: the order may exist)
     * @throws {ServerError} `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
     */
    complete: (params, options) => core.call(op.checkout_complete, params, live(options)),

    /**
     * MVP addition (hosted storefront only, `x-edge-only`): completes the checkout in one request with the traveller's
     * card, which the airline charges (Amadeus Flight Create Orders with `issue = true` and the card as the form of
     * payment). `paymentId` is the checkout's active `airline_card` payment and `expectedTotal` its amount. Resolves
     * like `complete`: the booking (normally `ticketed`) and its payment (`captured`, card brand and last 4 only).
     * `POST /v1/checkouts/{checkoutId}/airline-card-completion` with a 90 s timeout and a new `Idempotency-Key` per
     * call, sent **once**: never retried, whatever `maxRetries` says, and not sent again after `TOKEN_EXPIRED` or
     * `CSRF_TOKEN_INVALID` in cookie mode (the session is renewed for the next submit). The card never appears in an
     * error, its `toJSON()` or a hook. After any error ask for the card again; after `504 SUPPLIER_TIMEOUT` (or a
     * timeout or network error) the order may exist: show the pending booking (`details.bookingId`, or `bookingId` of
     * `checkout.get`) and never send the card again. Key callers (`pk_`, `sk_`, `hk_`) get `403 SCOPE_NOT_ALLOWED`.
     * @param {CompleteWithAirlineCardParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<CheckoutCompletion>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400; `fieldErrors[].code` `luhn` or `expired`, never the value), `INVALID_REQUEST`, `CHECKOUT_INCOMPLETE`, `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID`, `UNPROCESSABLE` (422, card brand not accepted)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`
     * @throws {PaymentError} `PAYMENT_DECLINED` (402; the attempt is counted)
     * @throws {PermissionError} `SCOPE_NOT_ALLOWED` (not the storefront edge), `FEATURE_DISABLED` (`details.feature = "airlineCard"`), `PAYMENT_ATTEMPTS_EXCEEDED` (three declines), `CSRF_TOKEN_INVALID`, `TENANT_SUSPENDED`, `HOST_NOT_ALLOWED`, `EMAIL_NOT_VERIFIED`
     * @throws {NotFoundError} `NOT_FOUND`
     * @throws {PriceChangedError} `PRICE_CHANGED`
     * @throws {SoldOutError} `SOLD_OUT`
     * @throws {ConflictError} `CHECKOUT_ALREADY_COMPLETED`, `PAYMENT_AMOUNT_MISMATCH`, `IDEMPOTENCY_KEY_REUSED`
     * @throws {ExpiredError} `CHECKOUT_EXPIRED`, `OFFER_EXPIRED`
     * @throws {RateLimitError} `RATE_LIMITED` (5 per minute per visitor, 60 per hour per OTA)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR`, `TICKETING_FAILED` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504, `details.bookingId`: the order may exist)
     * @throws {ServerError} `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE` (503, also when the abuse limits are unavailable)
     */
    completeWithAirlineCard: async (params, options) => {
      try {
        return await core.call(op.checkout_completeWithAirlineCard, params, live(options));
      } catch (error) {
        throw withoutCard(error, params);
      }
    },
  };
}
