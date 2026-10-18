// The `bookings` namespace (docs/velexis-sdk/sdk/src/bookings.d.ts `BookingsApi`, guide B3 §3–§5, ota/sdk/README.md
// §4.1 and §5.2, OADR-0016 points 1–3, OADR-0006 point 4): "My trips", the booking page, the guest lookup, customer
// changes, extra bags after booking (deferred), cancellation, documents, the timeline and the ticketing progress.
// The fourteen methods of the contract, each one line through the generated route table (internal/operations.js),
// which also gives the four POSTs their generated `Idempotency-Key`; `BookingsApi` in bookings.js is inferred from
// this factory. The lists (`list`, `listDocuments`, `listEvents`) resolve with a `Page` (`next()`, `for await` across
// pages). Three methods are deferred until after the MVP (`getAncillaries`, `createPayment`, `addAncillaries`): the API
// answers `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
//
// - `If-Match`: `update`, `addAncillaries` and `cancel` require `ifMatch`, the booking `version` (a number, sent as
//   its ETag `"<version>"`) or the ETag itself (a string, sent as it is). A missing or malformed `ifMatch` is a
//   `TypeError` before any request, like a missing path parameter.
// - Guest booking token: per call in token and server mode with `options.bookingToken` (`X-Booking-Token`; it wins
//   over the client's `bookingToken`). In cookie mode the token is the httpOnly `__Host-vx_bt` cookie, so a booking
//   token in the options is refused with a `TypeError` before any request (internal/session.js), and `lookup`
//   resolves with `bookingToken: null` (OADR-0006 point 4, the approved nullable `BookingLookupResult.bookingToken`):
//   the SDK hands page code no guest token, whatever a response says.
//
// Everything here is personal, priced or time-limited, so every method sends `cache: "no-store"` to `fetch` unless the
// call sets `cache` or `next` itself (bookings.d.ts "Caching", B3 §1).

import { op } from "../internal/operations.js";

/** @typedef {import("../internal/client.js").Core} Core */
/** @typedef {import("../internal/operations.js").Operation} Operation */
/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @template T @typedef {import("../shared.js").Page<T>} Page */
/** @typedef {import("../bookings.js").IfMatchValue} IfMatchValue */
/** @typedef {import("../bookings.js").Booking} Booking */
/** @typedef {import("../bookings.js").BookingSummary} BookingSummary */
/** @typedef {import("../bookings.js").BookingLookupResult} BookingLookupResult */
/** @typedef {import("../bookings.js").BookingAncillaryOptions} BookingAncillaryOptions */
/** @typedef {import("../bookings.js").Payment} Payment */
/** @typedef {import("../bookings.js").CancellationQuote} CancellationQuote */
/** @typedef {import("../bookings.js").CancellationResult} CancellationResult */
/** @typedef {import("../bookings.js").BookingFareRules} BookingFareRules */
/** @typedef {import("../bookings.js").BookingDocument} BookingDocument */
/** @typedef {import("../bookings.js").DocumentDownloadUrl} DocumentDownloadUrl */
/** @typedef {import("../bookings.js").BookingEvent} BookingEvent */
/** @typedef {import("../bookings.js").BookingTicketingStatus} BookingTicketingStatus */
/** @typedef {import("../bookings.js").ListBookingsParams} ListBookingsParams */
/** @typedef {import("../bookings.js").BookingRefParams} BookingRefParams */
/** @typedef {import("../bookings.js").GetBookingParams} GetBookingParams */
/** @typedef {import("../bookings.js").LookupBookingParams} LookupBookingParams */
/** @typedef {import("../bookings.js").UpdateBookingParams} UpdateBookingParams */
/** @typedef {import("../bookings.js").CancelBookingParams} CancelBookingParams */
/** @typedef {import("../bookings.js").CreateBookingPaymentParams} CreateBookingPaymentParams */
/** @typedef {import("../bookings.js").AddBookingAncillariesParams} AddBookingAncillariesParams */
/** @typedef {import("../bookings.js").GetBookingFareRulesParams} GetBookingFareRulesParams */
/** @typedef {import("../bookings.js").GetTicketingStatusParams} GetTicketingStatusParams */
/** @typedef {import("../bookings.js").ListBookingDocumentsParams} ListBookingDocumentsParams */
/** @typedef {import("../bookings.js").GetDocumentDownloadUrlParams} GetDocumentDownloadUrlParams */
/** @typedef {import("../bookings.js").ListBookingEventsParams} ListBookingEventsParams */
/** @typedef {import("../shared.js").ValidationError} ValidationError */
/** @typedef {import("../shared.js").AuthenticationError} AuthenticationError */
/** @typedef {import("../shared.js").PaymentError} PaymentError */
/** @typedef {import("../shared.js").PermissionError} PermissionError */
/** @typedef {import("../shared.js").NotFoundError} NotFoundError */
/** @typedef {import("../shared.js").ConflictError} ConflictError */
/** @typedef {import("../shared.js").PriceChangedError} PriceChangedError */
/** @typedef {import("../shared.js").VelexisError} VelexisError */
/** @typedef {import("../shared.js").RateLimitError} RateLimitError */
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
 * The request options of one `bookings.*` call with the contract's default fetch cache mode, `no-store`: bookings are
 * personal, and a cached copy would show a stale status, price or document. A call that sets `cache` or `next` keeps
 * its own choice. Options that are not a plain object are passed on unchanged, so `core.call` refuses them with its
 * usual `TypeError` (a copy would accept them and drop what they inherit).
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

/**
 * A character that cannot be part of a header value as `ifMatch` sends it: anything but tab and visible ASCII with
 * spaces (CR, LF and NUL would make `Headers` throw, other characters are not an ETag).
 */
const NOT_HEADER_TEXT = /[^\t\x20-\x7e]/;

/**
 * Sends a call whose operation requires `If-Match` (`update`, `addAncillaries`, `cancel`), with `ifMatch` as the
 * header value: a version number becomes its ETag `"<version>"`, a non-blank string of visible ASCII is an ETag and is
 * sent as it is. A missing or malformed `ifMatch` rejects with a `TypeError` before any request, also before the CSRF
 * request of cookie mode (naming the parameter, never its value). Params that are not a plain object are passed on
 * unchanged, so `core.call` refuses them with its usual `TypeError`.
 * @template T
 * @param {Core} core
 * @param {Operation} operation
 * @param {{ ifMatch: IfMatchValue }} params
 * @param {RequestOptions | undefined} options
 * @returns {Promise<T>}
 */
async function withIfMatch(core, operation, params, options) {
  if (!isPlainObject(params)) {
    return core.call(operation, params, live(options));
  }
  const { ifMatch } = params;
  if (typeof ifMatch === "number" && Number.isSafeInteger(ifMatch) && ifMatch >= 0) {
    return core.call(operation, { ...params, ifMatch: `"${ifMatch}"` }, live(options));
  }
  if (typeof ifMatch !== "string" || ifMatch.trim() === "" || NOT_HEADER_TEXT.test(ifMatch)) {
    throw new TypeError(
      `Velexis SDK: ${operation.method} ${operation.path} needs "ifMatch", the booking version (a whole number) or its ETag (a string)`,
    );
  }
  return core.call(operation, params, live(options));
}

/**
 * `bookings.lookup`: in cookie mode the guest token is the httpOnly `__Host-vx_bt` cookie and the API answers
 * `bookingToken: null` (OADR-0006 point 4); the result keeps `null` there whatever the response says, so page code
 * never holds a guest token. Token and server mode resolve with the response as it is.
 * @param {Core} core
 * @param {LookupBookingParams} params
 * @param {RequestOptions | undefined} options
 * @returns {Promise<BookingLookupResult>}
 */
async function lookup(core, params, options) {
  /** @type {BookingLookupResult} */
  const result = await core.call(op.bookings_lookup, params, live(options));
  return core.mode === "cookie" && isPlainObject(result) ? { ...result, bookingToken: null } : result;
}

/**
 * The `bookings` namespace of a client.
 * @param {Core} core the client's request core
 */
export function createBookingsApi(core) {
  return {
    /**
     * Lists the signed-in customer's bookings for the "My trips" tabs (`timeframe`: `upcoming` by default, `past`,
     * `cancelled`, `all`) with date filters, sort and cursor pages. Resolves with a `Page` that has `next()` and is
     * async-iterable across pages with the same filters. Only bookings of the key's environment are listed; guests have
     * no list (they use `lookup`). `GET /v1/bookings`; needs a customer token (cookie mode: the session cookie).
     * @param {ListBookingsParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<Page<BookingSummary>>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    list: (params, options) => core.call(op.bookings_list, params, live(options)),

    /**
     * Gets a booking: status, record locators, itineraries with segment status and schedule changes, travellers
     * (documents with `numberMasked` only), contacts, ancillaries, tickets, payments, refunds, remarks, documents,
     * totals, ticketing, fare conditions, `allowedActions`, cancellation, `lastSyncedAt` and the wrapped Amadeus order
     * (selling amounts, document numbers masked). `refresh: true` synchronises with Amadeus Flight Order Management
     * first (`include` and `fareRules` are passed through, comma-separated). `GET /v1/bookings/{bookingId}`; customer
     * token or guest booking token. `booking.version` is the `ifMatch` of `update`, `addAncillaries` and `cancel`.
     * @param {GetBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Booking>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} only with `refresh`: `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504); retry without `refresh`
     * @throws {ServerError} `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
     */
    get: (params, options) => core.call(op.bookings_get, params, live(options)),

    /**
     * "Manage my booking" for guests: finds a booking by booking reference (or airline / Amadeus record locator) and the
     * last name of any traveller, and returns a guest booking token (24 h) with the booking card. A wrong reference or
     * name is the same `404`. In token and server mode keep `bookingToken` server-side (an httpOnly cookie) and pass it
     * as `options.bookingToken` to the booking's calls; in cookie mode it resolves with `bookingToken: null` because the
     * token went into the httpOnly `__Host-vx_bt` cookie. `POST /v1/bookings/lookup` with a generated
     * `Idempotency-Key`; key only, no user token.
     * @param {LookupBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<BookingLookupResult>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400)
     * @throws {AuthenticationError} `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404: no booking with this reference and last name)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429: 5 failed attempts per 15 min per IP and reference; `retryAfterSeconds`)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    lookup: (params, options) => lookup(core, params, options),

    /**
     * Customer-allowed changes applied at the airline: replaces the contacts, traveller identity / APIS documents,
     * traveller contact and emergency contact, loyalty numbers, and adds special requests (names, dates of birth and
     * gender cannot change). Travellers are keyed by `travelerId`; `documents` replaces the list, and an entry without
     * `number` keeps its stored number. Requires `ifMatch`, the booking `version` the customer saw.
     * `PATCH /v1/bookings/{bookingId}` with `If-Match`; customer token or guest booking token. Not retried.
     * @param {UpdateBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Booking>}
     * @throws {TypeError} without a valid `ifMatch`, before any request
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID` (422, `fieldErrors`)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `VERSION_CONFLICT` (409: reload with `get({ refresh: true })` and retry), `BOOKING_NOT_MODIFIABLE`, `BOOKING_ALREADY_CANCELLED` (409)
     * @throws {VelexisError} `PRECONDITION_FAILED` (412, stale `ifMatch`)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
     */
    update: (params, options) => withIfMatch(core, op.bookings_update, params, options),

    /**
     * Extra checked bags the customer can still buy for this booking, with selling prices (`available: false` and
     * `notAvailableReason` when nothing can be bought); the first step of "add a bag" (`getAncillaries` →
     * `createPayment` → the provider confirms → `addAncillaries`). `GET /v1/bookings/{bookingId}/ancillaries`.
     * Deferred: the API answers `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {BookingRefParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<BookingAncillaryOptions>}
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
     */
    getAncillaries: (params, options) => core.call(op.bookings_getAncillaries, params, live(options)),

    /**
     * Creates the payment (`purpose: "ancillaries"`) for extras to add to the booking: the selections of
     * `getAncillaries` and the `expectedTotal` the customer saw; returns the provider's client data like
     * `checkout.createPayment`. Authorised only, captured when the airline accepted the extras.
     * `POST /v1/bookings/{bookingId}/payments` with a generated `Idempotency-Key`. Deferred: the API answers
     * `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {CreateBookingPaymentParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Payment>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `ANCILLARY_NOT_AVAILABLE`, `UNPROCESSABLE` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `FEATURE_DISABLED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {PriceChangedError} `PRICE_CHANGED` (409: the extras' price moved; no payment created)
     * @throws {ConflictError} `BOOKING_NOT_MODIFIABLE`, `BOOKING_ALREADY_CANCELLED`, `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `PAYMENT_PROVIDER_NOT_CONFIGURED`, `SUPPLIER_NOT_CONFIGURED` (424), `PAYMENT_PROVIDER_ERROR`, `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
     */
    createPayment: (params, options) => core.call(op.bookings_createPayment, params, live(options)),

    /**
     * Adds paid extras to the booking (Flight Order Management PATCH, capture of the `ancillaries` payment, EMD issuance
     * when already ticketed). Requires `ifMatch` and the authorised `paymentId` of `createPayment` for the same
     * selections. A same-key retry never patches twice; pass a stable `options.idempotencyKey` (for example
     * `extras-${paymentId}`). `POST /v1/bookings/{bookingId}/ancillaries` with `If-Match` and `Idempotency-Key`.
     * Deferred: the API answers `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {AddBookingAncillariesParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Booking>}
     * @throws {TypeError} without a valid `ifMatch`, before any request
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `ANCILLARY_NOT_AVAILABLE` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PaymentError} `PAYMENT_REQUIRED` (402: not authorised yet), `PAYMENT_DECLINED` (402)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `FEATURE_DISABLED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {PriceChangedError} `PRICE_CHANGED` (409: authorisation voided; show the new price and pay again)
     * @throws {ConflictError} `PAYMENT_AMOUNT_MISMATCH`, `VERSION_CONFLICT`, `BOOKING_NOT_MODIFIABLE`, `BOOKING_ALREADY_CANCELLED`, `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {VelexisError} `PRECONDITION_FAILED` (412, stale `ifMatch`)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED`, `PAYMENT_PROVIDER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR`, `PAYMENT_PROVIDER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504: outcome unknown; same-key retries replay)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
     */
    addAncillaries: (params, options) => withIfMatch(core, op.bookings_addAncillaries, params, options),

    /**
     * Previews a cancellation: mode (`release`, `void`, `refund`, `request_only`, `not_allowed`), estimated refund,
     * airline penalties, OTA fee, per-traveller lines and the rules behind it; valid 10 minutes (`expiresAt`). Net
     * amounts are never exposed in customer scope. `GET /v1/bookings/{bookingId}/cancellation-quote`.
     * @param {BookingRefParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<CancellationQuote>}
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `BOOKING_ALREADY_CANCELLED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
     */
    quoteCancellation: (params, options) => core.call(op.bookings_quoteCancellation, params, live(options)),

    /**
     * Cancels the booking (self-service): pass the booking `version` as `ifMatch`, the customer's `reasonCode`, an
     * optional `comment` and the quote's `estimatedRefund` as `expectedRefund`. Resolves with
     * `cancellation.status = "cancelled"` (200) or `"pending"` (202, the OTA completes it). A same-key retry after
     * `504 SUPPLIER_TIMEOUT` never repeats the Amadeus DELETE, so automatic retries are safe; pass a stable
     * `options.idempotencyKey`. `POST /v1/bookings/{bookingId}/cancellation` with `If-Match` and `Idempotency-Key`.
     * @param {CancelBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<CancellationResult>}
     * @throws {TypeError} without a valid `ifMatch`, before any request
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `FEATURE_DISABLED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `REFUND_AMOUNT_CHANGED` (409, `details.newRefund`: show it and confirm again), `BOOKING_NOT_MODIFIABLE`, `BOOKING_ALREADY_CANCELLED`, `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {VelexisError} `PRECONDITION_FAILED` (412)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504: outcome unknown; `get({ refresh: true })` before retrying with the same key)
     * @throws {ServerError} `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
     */
    cancel: (params, options) => withIfMatch(core, op.bookings_cancel, params, options),

    /**
     * Rebooking (change) and refund eligibility of the booked fares: per category applicability, penalties,
     * circumstances, airline texts, rebook conditions and a refund estimate, plus a summary; cached 1 h server-side
     * (`refresh: true` bypasses it). `GET /v1/bookings/{bookingId}/fare-rules`; `types` is sent comma-separated.
     * @param {GetBookingFareRulesParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<BookingFareRules>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
     */
    getFareRules: (params, options) => core.call(op.bookings_getFareRules, params, live(options)),

    /**
     * Lists the booking's ready documents (e-ticket receipts, EMD receipts, itinerary, invoices, credit notes), newest
     * first, as a `Page`. `GET /v1/bookings/{bookingId}/documents`; `kind` is sent comma-separated.
     * @param {ListBookingDocumentsParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Page<BookingDocument>>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    listDocuments: (params, options) => core.call(op.bookings_listDocuments, params, live(options)),

    /**
     * Gets a 5-minute signed download URL for one document (PDF, `Content-Disposition: attachment`): a same-origin
     * path in cookie mode, an absolute URL for key callers. Do not cache or store it; request a new one per click.
     * `GET /v1/bookings/{bookingId}/documents/{documentId}/download-url`.
     * @param {GetDocumentDownloadUrlParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<DocumentDownloadUrl>}
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `DOCUMENT_NOT_READY` (409, `details.retryAfterSeconds`; retryable)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    getDocumentDownloadUrl: (params, options) =>
      core.call(op.bookings_getDocumentDownloadUrl, params, live(options)),

    /**
     * Lists the customer-visible booking timeline (created, payment, ticketed, changes, schedule changes, cancellation,
     * refunds, documents), newest first, as a `Page`. `GET /v1/bookings/{bookingId}/events`.
     * @param {ListBookingEventsParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Page<BookingEvent>>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    listEvents: (params, options) => core.call(op.bookings_listEvents, params, live(options)),

    /**
     * Ticketing progress: booking status (always present), ticketing status, policy, deadline, attempts, message,
     * issued tickets and a polling hint (`pollAfterSeconds`, `null` when polling should stop). Poll it after
     * `checkout.complete` while `status` is `pending` or `in_progress`, and after a `SUPPLIER_TIMEOUT` of
     * `checkout.complete` until `bookingStatus` leaves `pending`. `GET /v1/bookings/{bookingId}/ticketing`; `refresh`
     * reads tickets from Amadeus when the status is not final (throttled to once per 60 s).
     * @param {GetTicketingStatusParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<BookingTicketingStatus>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500), `SERVICE_UNAVAILABLE` (503)
     */
    getTicketingStatus: (params, options) => core.call(op.bookings_getTicketingStatus, params, live(options)),
  };
}
