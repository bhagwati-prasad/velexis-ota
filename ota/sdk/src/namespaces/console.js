// The `console` namespace (docs/velexis-sdk/sdk/src/console.d.ts `ConsoleApi`, guide B4, ota/sdk/README.md §4.3 and
// §5.2, OADR-0016 points 1–3, OADR-0018 points 1 and 3): the OTA's staff console. The 32 methods of the contract in six
// sub-namespaces, each one line through the generated route table (internal/operations.js): `auth` (4), `bookings`
// (11, `create` deferred), `queues` (2), `customers` (2), `supplierRequests` (1) and the raw Amadeus pass-through
// `amadeus` (12; `createFlightOrders`, `issueFlightOrder`, `patchFlightOrder` and `cancelFlightOrder` deferred). The
// table gives the long staff actions their 60 s timeout (`bookings.issue`, `.cancel`, `.import`, `.retrieve`), every
// state-changing POST its generated `Idempotency-Key`, and every method its `X-Velexis-Environment` flag; `ConsoleApi`
// in console.js is inferred from this factory. SDK-012 adds `settings` and `payments`. The lists (`bookings.list`,
// `queues.list`, `queues.listSnapshots`, `customers.list`, `supplierRequests.list`) resolve with a `Page` (`next()`,
// `for await` across pages) that keeps the response's extra fields (`totalCount`, `snapshot`, `warnings`). Deferred
// methods surface the API's `501 NOT_IMPLEMENTED` as a `ServerError` that is not retryable.
//
// - Keys and where it runs: a secret key (or the OTA admin's service key) and, except for `auth.signIn`,
//   `auth.refresh` and a key-only `auth.signOut`, a staff access token, or a key scoped `console:automation` that
//   lists the method's permission (key-only calls); server-side only. The SDK adds no rule of its own: the API refuses
//   a publishable key or a key scoped `storefront` (`403 SCOPE_NOT_ALLOWED`).
// - Environment: with the client option `environment` (`"test"` | `"live"`), every console request carries
//   `X-Velexis-Environment` (internal/client.js reads the route table's flag), customer requests never do, and a
//   call's own `headers` cannot replace it. Only the OTA admin's service key takes the header (any other key's
//   environment is the key's, and the API refuses the header); `live` needs a live OTA and a role other than `viewer`
//   (`403 ENVIRONMENT_NOT_ALLOWED`, ota/sdk/docs/extensions.md §1).
// - Staff sessions: a client with `sessionKind: "staff"` and a `refreshToken` refreshes an expired staff token through
//   `console.auth.refresh` and retries the call once (internal/session.js, README §4.3).
// - `If-Match`: `bookings.patch`, `.issue` and `.cancel` require `ifMatch`, the booking `version` (a number, sent as its
//   ETag `"<version>"`) or the ETag itself (a string, sent as it is). A missing or malformed `ifMatch` is a `TypeError`
//   before any request, like a missing path parameter.
// - Record locators: `bookings.findByRecordLocator` and `amadeus.getFlightOrderByReference` send `originSystemCode:
//   "GDS"` when the call leaves it out (the contract's default, the only value Amadeus supports today).
//
// Console data is personal, priced or live supplier data, so every method sends `cache: "no-store"` to `fetch` unless
// the call sets `cache` or `next` itself (console.d.ts "Caching", B4 §1).

import { op } from "../internal/operations.js";

/** @typedef {import("../internal/client.js").Core} Core */
/** @typedef {import("../internal/operations.js").Operation} Operation */
/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @template T @typedef {import("../shared.js").Page<T>} Page */
/** @typedef {import("../console.js").ConsoleIfMatch} ConsoleIfMatch */
/** @typedef {import("../console.js").ConsoleStaffSession} ConsoleStaffSession */
/** @typedef {import("../console.js").ConsoleStaffProfile} ConsoleStaffProfile */
/** @typedef {import("../console.js").ConsoleSignInParams} ConsoleSignInParams */
/** @typedef {import("../console.js").ConsoleRefreshParams} ConsoleRefreshParams */
/** @typedef {import("../console.js").ConsoleSignOutParams} ConsoleSignOutParams */
/** @typedef {import("../console.js").ConsoleMeParams} ConsoleMeParams */
/** @typedef {import("../console.js").ConsoleBooking} ConsoleBooking */
/** @typedef {import("../console.js").ConsoleBookingPage} ConsoleBookingPage */
/** @typedef {import("../console.js").ConsoleBookingNote} ConsoleBookingNote */
/** @typedef {import("../console.js").ConsoleBookingResyncResult} ConsoleBookingResyncResult */
/** @typedef {import("../console.js").ConsoleFlightOrderRetrieval} ConsoleFlightOrderRetrieval */
/** @typedef {import("../console.js").PnrLookupResult} PnrLookupResult */
/** @typedef {import("../console.js").ConsoleListBookingsParams} ConsoleListBookingsParams */
/** @typedef {import("../console.js").ConsoleGetBookingParams} ConsoleGetBookingParams */
/** @typedef {import("../console.js").ConsoleFindByRecordLocatorParams} ConsoleFindByRecordLocatorParams */
/** @typedef {import("../console.js").ConsoleImportBookingParams} ConsoleImportBookingParams */
/** @typedef {import("../console.js").ConsoleRetrieveFlightOrderParams} ConsoleRetrieveFlightOrderParams */
/** @typedef {import("../console.js").ConsoleCreateBookingParams} ConsoleCreateBookingParams */
/** @typedef {import("../console.js").ConsolePatchBookingParams} ConsolePatchBookingParams */
/** @typedef {import("../console.js").ConsoleIssueBookingParams} ConsoleIssueBookingParams */
/** @typedef {import("../console.js").ConsoleCancelBookingParams} ConsoleCancelBookingParams */
/** @typedef {import("../console.js").ConsoleResyncBookingParams} ConsoleResyncBookingParams */
/** @typedef {import("../console.js").ConsoleAddBookingNoteParams} ConsoleAddBookingNoteParams */
/** @typedef {import("../console.js").ConsoleListQueueParams} ConsoleListQueueParams */
/** @typedef {import("../console.js").ConsoleQueuePage} ConsoleQueuePage */
/** @typedef {import("../console.js").ConsoleListQueueSnapshotsParams} ConsoleListQueueSnapshotsParams */
/** @typedef {import("../console.js").QueueSnapshot} QueueSnapshot */
/** @typedef {import("../console.js").ConsoleListCustomersParams} ConsoleListCustomersParams */
/** @typedef {import("../console.js").ConsoleCustomerSummary} ConsoleCustomerSummary */
/** @typedef {import("../console.js").ConsoleGetCustomerParams} ConsoleGetCustomerParams */
/** @typedef {import("../console.js").ConsoleCustomer} ConsoleCustomer */
/** @typedef {import("../console.js").ConsoleListSupplierRequestsParams} ConsoleListSupplierRequestsParams */
/** @typedef {import("../console.js").ConsoleSupplierRequest} ConsoleSupplierRequest */
/** @typedef {import("../console.js").ConsoleAmadeusSearchFlightOffersParams} ConsoleAmadeusSearchFlightOffersParams */
/** @typedef {import("../console.js").ConsoleAmadeusGetFlightOffersParams} ConsoleAmadeusGetFlightOffersParams */
/** @typedef {import("../console.js").ConsoleAmadeusFlightOffersResult} ConsoleAmadeusFlightOffersResult */
/** @typedef {import("../console.js").ConsoleAmadeusSearchFlightAvailabilitiesParams} ConsoleAmadeusSearchFlightAvailabilitiesParams */
/** @typedef {import("../console.js").ConsoleAmadeusAvailabilitiesResult} ConsoleAmadeusAvailabilitiesResult */
/** @typedef {import("../console.js").ConsoleAmadeusUpsellAirOffersParams} ConsoleAmadeusUpsellAirOffersParams */
/** @typedef {import("../console.js").ConsoleAmadeusUpsellResult} ConsoleAmadeusUpsellResult */
/** @typedef {import("../console.js").ConsoleAmadeusQuoteAirOffersParams} ConsoleAmadeusQuoteAirOffersParams */
/** @typedef {import("../console.js").ConsoleAmadeusPricingResult} ConsoleAmadeusPricingResult */
/** @typedef {import("../console.js").ConsoleAmadeusCreateFlightOrdersParams} ConsoleAmadeusCreateFlightOrdersParams */
/** @typedef {import("../console.js").ConsoleAmadeusIssueFlightOrderParams} ConsoleAmadeusIssueFlightOrderParams */
/** @typedef {import("../console.js").ConsoleAmadeusGetFlightOrderParams} ConsoleAmadeusGetFlightOrderParams */
/** @typedef {import("../console.js").ConsoleAmadeusPatchFlightOrderParams} ConsoleAmadeusPatchFlightOrderParams */
/** @typedef {import("../console.js").ConsoleAmadeusFlightOrderResult} ConsoleAmadeusFlightOrderResult */
/** @typedef {import("../console.js").ConsoleAmadeusCancelFlightOrderParams} ConsoleAmadeusCancelFlightOrderParams */
/** @typedef {import("../console.js").ConsoleAmadeusCancelResult} ConsoleAmadeusCancelResult */
/** @typedef {import("../console.js").ConsoleAmadeusGetFlightOrderByReferenceParams} ConsoleAmadeusGetFlightOrderByReferenceParams */
/** @typedef {import("../console.js").ConsoleAmadeusFlightOrdersByReferenceResult} ConsoleAmadeusFlightOrdersByReferenceResult */
/** @typedef {import("../console.js").ConsoleAmadeusGetQueueParams} ConsoleAmadeusGetQueueParams */
/** @typedef {import("../console.js").ConsoleAmadeusQueueResult} ConsoleAmadeusQueueResult */
/** @typedef {import("../shared.js").ValidationError} ValidationError */
/** @typedef {import("../shared.js").AuthenticationError} AuthenticationError */
/** @typedef {import("../shared.js").PaymentError} PaymentError */
/** @typedef {import("../shared.js").PermissionError} PermissionError */
/** @typedef {import("../shared.js").NotFoundError} NotFoundError */
/** @typedef {import("../shared.js").ConflictError} ConflictError */
/** @typedef {import("../shared.js").PriceChangedError} PriceChangedError */
/** @typedef {import("../shared.js").SoldOutError} SoldOutError */
/** @typedef {import("../shared.js").ExpiredError} ExpiredError */
/** @typedef {import("../shared.js").VelexisError} VelexisError */
/** @typedef {import("../shared.js").RateLimitError} RateLimitError */
/** @typedef {import("../shared.js").SupplierError} SupplierError */
/** @typedef {import("../shared.js").ServerError} ServerError */

/** The Amadeus `originSystemCode` the record-locator methods send when the call leaves it out. */
const DEFAULT_ORIGIN_SYSTEM_CODE = "GDS";

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
 * The request options of one `console.*` call with the contract's default fetch cache mode, `no-store`: console data
 * is personal, priced and changes constantly. A call that sets `cache` or `next` keeps its own choice. Options that are
 * not a plain object are passed on unchanged, so `core.call` refuses them with its usual `TypeError` (a copy would
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

/**
 * A character that cannot be part of a header value as `ifMatch` sends it: anything but tab and visible ASCII with
 * spaces (CR, LF and NUL would make `Headers` throw, other characters are not an ETag).
 */
const NOT_HEADER_TEXT = /[^\t\x20-\x7e]/;

/**
 * Sends a call whose operation requires `If-Match` (`bookings.patch`, `.issue`, `.cancel`), with `ifMatch` as the
 * header value: a version number becomes its ETag `"<version>"`, a non-blank string of visible ASCII is an ETag and is
 * sent as it is. A missing or malformed `ifMatch` rejects with a `TypeError` before any request (naming the parameter,
 * never its value). Params that are not a plain object are passed on unchanged, so `core.call` refuses them with its
 * usual `TypeError`.
 * @template T
 * @param {Core} core
 * @param {Operation} operation
 * @param {{ ifMatch: ConsoleIfMatch }} params
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
 * Sends a record-locator lookup (`bookings.findByRecordLocator`, `amadeus.getFlightOrderByReference`) with the
 * contract's default `originSystemCode` (`"GDS"`) when the call leaves it out (`undefined` or `null`). Params that are
 * not a plain object are passed on unchanged, so `core.call` refuses them with its usual `TypeError`.
 * @template T
 * @param {Core} core
 * @param {Operation} operation
 * @param {{ reference: string, originSystemCode?: string }} params
 * @param {RequestOptions | undefined} options
 * @returns {Promise<T>}
 */
function byRecordLocator(core, operation, params, options) {
  if (!isPlainObject(params)) {
    return core.call(operation, params, live(options));
  }
  const originSystemCode = params.originSystemCode ?? DEFAULT_ORIGIN_SYSTEM_CODE;
  return core.call(operation, { ...params, originSystemCode }, live(options));
}

/**
 * `client.console.auth`: staff sessions of the console.
 * @param {Core} core
 */
function createConsoleAuthApi(core) {
  return {
    /**
     * Signs a portal account in to this OTA's console and returns a tenant-scoped staff session (tokens, staff member,
     * tenant, permissions). The MVP grant is `{ grantType: "portal_token", portalToken }`, the one-time token of the
     * Velexis portal's "Open console" button (60 s, single use); `grantType: "password"` answers `403
     * FEATURE_DISABLED` in the MVP. Keep `session.accessToken` and `session.refreshToken` in httpOnly cookies, never in
     * the browser. `POST /v1/console/auth/sign-in` with a generated `Idempotency-Key` (a same-key retry replays the
     * session instead of failing on the used token); secret key only, no token. No Amadeus call.
     * @param {ConsoleSignInParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleStaffSession>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400)
     * @throws {AuthenticationError} `PORTAL_TOKEN_INVALID`, `INVALID_CREDENTIALS`, `STAFF_MFA_REQUIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `STAFF_MEMBERSHIP_INACTIVE`, `MFA_REQUIRED`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {VelexisError} `ACCOUNT_LOCKED` (423)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    signIn: (params, options) => core.call(op.console_auth_signIn, params, live(options)),

    /**
     * Rotates a staff refresh token: a new access token, a new refresh token (the old one is revoked; presenting it
     * again revokes the whole family) and the current role and permissions. A client with `sessionKind: "staff"` and
     * a `refreshToken` calls this by itself on `TOKEN_EXPIRED` and reports the result to `onSessionRefreshed`
     * (`result.session`) and `onStaffSessionRefreshed`; an explicit call does not change the client's tokens.
     * `POST /v1/console/auth/refresh` with a generated `Idempotency-Key`; secret key only, no access token.
     * @param {ConsoleRefreshParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleStaffSession>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`, `INVALID_API_KEY` (401: sign the staff member out)
     * @throws {PermissionError} `STAFF_MEMBERSHIP_INACTIVE`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    refresh: (params, options) => core.call(op.console_auth_refresh, params, live(options)),

    /**
     * Revokes the current staff session (`scope: "current"`, the default) or every session of the account in this OTA
     * (`scope: "all"`); works with an expired access token when `refreshToken` is passed. Idempotent; resolves with
     * nothing (`204`). Delete the staff cookies after. `POST /v1/console/auth/sign-out` with a generated
     * `Idempotency-Key`; secret key with a staff token, or with `refreshToken` alone.
     * @param {ConsoleSignOutParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<void>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    signOut: (params, options) => core.call(op.console_auth_signOut, params, live(options)),

    /**
     * The signed-in staff member, the OTA (environment, Amadeus offices), the effective permissions and the current
     * session: build the console navigation from it and hide the actions the role cannot perform.
     * `GET /v1/console/auth/me`; secret key and a staff token (required).
     * @param {ConsoleMeParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleStaffProfile>}
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401: redirect to sign-in)
     * @throws {PermissionError} `STAFF_MEMBERSHIP_INACTIVE`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    me: (params, options) => core.call(op.console_auth_me, params, live(options)),
  };
}

/**
 * `client.console.bookings`: all bookings of the OTA, PNR lookup and Amadeus order management.
 * @param {Core} core
 */
function createConsoleBookingsApi(core) {
  return {
    /**
     * Lists every booking of the OTA (all channels, customers and guests, all statuses including `failed`) with
     * filters (statuses, ticketing deadline, record locator, reference, customer, e-mail, traveller, dates, payment
     * status, source, carrier, staff, tag, free text), sort and cursor pages. Each row carries the net amount, the
     * markup and the sync state. Resolves with a `Page` that keeps `totalCount` (exact up to 10 000), has `next()` and
     * is async-iterable; list filters are sent comma-separated. `GET /v1/console/bookings`; `bookings:read`.
     * @param {ConsoleListBookingsParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleBookingPage>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    list: (params, options) => core.call(op.console_bookings_list, params, live(options)),

    /**
     * Gets the full console detail of a booking: what the customer sees plus environment, Amadeus order, offices, net
     * prices and markup (`pricing`), payment state, sync state, ticketing agreement, redacted forms of payment, remarks,
     * notes, timeline, the last Amadeus calls and staff actions, `consoleActions` and the failure reason. `refresh:
     * true` synchronises with Amadeus Flight Order Management GET first (`include` and `fareRules` comma-separated).
     * `booking.version` is the `ifMatch` of `patch`, `issue` and `cancel`. `GET /v1/console/bookings/{bookingId}`;
     * `bookings:read`.
     * @param {ConsoleGetBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleBooking>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} only with `refresh`: `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504); retry without `refresh`
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    get: (params, options) => core.call(op.console_bookings_get, params, live(options)),

    /**
     * PNR lookup: Amadeus Get Flight Order By Record Locator with the OTA's connection. Resolves with every matching
     * order (verbatim, with a normalised summary) and its link to this OTA (`bookingId` when attached, `importable`
     * otherwise: see `import`). `originSystemCode` defaults to `"GDS"`. Audited.
     * `GET /v1/console/bookings/by-record-locator`; owner, admin and agent.
     * @param {ConsoleFindByRecordLocatorParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<PnrLookupResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400: malformed record locator), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404: no order, `error.supplier` set)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    findByRecordLocator: (params, options) =>
      byRecordLocator(core, op.console_bookings_findByRecordLocator, params, options),

    /**
     * Attaches an existing Amadeus order (made in a GDS terminal or another tool) to the OTA's tables as a booking
     * (channel `import`), optionally for a customer, with a selling price (`pricing`: markup rules, net or override);
     * pass `flightOrderId` when several orders match the record locator. Same-key retries replay the import.
     * `POST /v1/console/bookings/imports` with a generated `Idempotency-Key`; 60 s timeout; `bookings:write`.
     * @param {ConsoleImportBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleBooking>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `UNPROCESSABLE` (422: several matches, no contact e-mail), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404: no such order)
     * @throws {ConflictError} `ORDER_ALREADY_IMPORTED` (409, `details.bookingId`), `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    import: (params, options) => core.call(op.console_bookings_import, params, live(options)),

    /**
     * Retrieves the verbatim Amadeus order of a booking (Flight Order Management GET with `include` and `fareRules`,
     * comma-separated): net prices, traveller documents, tickets, remarks, ticketing agreement, commissions,
     * `included.bags`, `dictionaries` and `warnings`, wrapped with the call info. Refreshes the stored order snapshot
     * unless `updateSnapshot: false`. Audited. `GET /v1/console/bookings/{bookingId}/amadeus-order`; 60 s timeout;
     * owner, admin, agent and finance.
     * @param {ConsoleRetrieveFlightOrderParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleFlightOrderRetrieval>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404: booking or Amadeus order)
     * @throws {ConflictError} `BOOKING_NOT_MODIFIABLE` (409: the booking has no Amadeus order)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    retrieve: (params, options) => core.call(op.console_bookings_retrieve, params, live(options)),

    /**
     * Books a priced offer (`prc_…`) on behalf of a customer or as a guest booking with the full Flight Create Orders
     * data (travellers, contacts, remarks, ticketing agreement, automated process, forms of payment, offices,
     * commissions, forms of identification, `issue`). No payment is taken. After `504 SUPPLIER_TIMEOUT` the order may
     * exist: open the pending booking of `error.details.bookingId` and never book again with a new idempotency key.
     * `POST /v1/console/bookings` with a generated `Idempotency-Key`; `bookings:write`. Deferred: the API answers
     * `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {ConsoleCreateBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleBooking>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID`, `UNPROCESSABLE`, `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `OFFICE_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404: priced offer or customer)
     * @throws {PriceChangedError} `PRICE_CHANGED` (409)
     * @throws {SoldOutError} `SOLD_OUT` (409)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {ExpiredError} `OFFER_EXPIRED` (410, with `repriceIfExpired: false`)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR`, `TICKETING_FAILED` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504: retry only with the same idempotency key)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    create: (params, options) => core.call(op.console_bookings_create, params, live(options)),

    /**
     * Modifies the booking's Amadeus order with Flight Order Management PATCH: travellers (merged by `id`), contacts
     * (by `purpose`), remarks (added), and the elements sent as given (forms of payment, ticketing agreement, automated
     * process, offices, associated records, commissions, forms of identification, tickets, partial flight offers for
     * seats and bags); `tags` and `metadata` are local only. Requires `ifMatch`; `version` increases. Not retried; after
     * `SUPPLIER_TIMEOUT` call `resync` first. `PATCH /v1/console/bookings/{bookingId}` with `If-Match`;
     * `bookings:write`.
     * @param {ConsolePatchBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleBooking>}
     * @throws {TypeError} without a valid `ifMatch`, before any request
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID`, `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `OFFICE_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `VERSION_CONFLICT`, `BOOKING_NOT_MODIFIABLE`, `BOOKING_ALREADY_CANCELLED` (409)
     * @throws {VelexisError} `PRECONDITION_FAILED` (412: stale `ifMatch`, reload)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    patch: (params, options) => withIfMatch(core, op.console_bookings_patch, params, options),

    /**
     * Issues the tickets of a booking with Amadeus Flight Order Issue (optional `formOfPayments`); an authorised
     * storefront payment is captured first (`capturePayment`, default true), an unpaid storefront booking needs
     * `allowUnpaid: true` (owner, admin). Requires `ifMatch`. Pass one `options.idempotencyKey` per click: a same-key
     * retry never issues twice; after a timeout call `resync`. `POST /v1/console/bookings/{bookingId}/issuance` with
     * `If-Match` and `Idempotency-Key`; 60 s timeout; `bookings:issue`.
     * @param {ConsoleIssueBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleBooking>}
     * @throws {TypeError} without a valid `ifMatch`, before any request
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PaymentError} `PAYMENT_REQUIRED`, `PAYMENT_DECLINED` (402)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `ALREADY_ISSUED`, `BOOKING_ALREADY_CANCELLED`, `BOOKING_NOT_MODIFIABLE`, `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {VelexisError} `PRECONDITION_FAILED` (412)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `TICKETING_FAILED`, `SUPPLIER_ERROR` (502, `supplier.code`), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    issue: (params, options) => withIfMatch(core, op.console_bookings_issue, params, options),

    /**
     * Cancels a booking: refreshes the order, cancels it with Flight Order Management DELETE, marks the booking
     * `cancelled` (`reasonCode`, `reason` audited) and refunds captured payments per `refund` (`none` by default,
     * `full`, `amount`). Requires `ifMatch`; a same-key retry never cancels or refunds twice.
     * `POST /v1/console/bookings/{bookingId}/cancellation` with `If-Match` and `Idempotency-Key`; 60 s timeout;
     * `bookings:cancel`.
     * @param {ConsoleCancelBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleBooking>}
     * @throws {TypeError} without a valid `ifMatch`, before any request
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `UNPROCESSABLE` (422: refund above the captured amount), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `BOOKING_ALREADY_CANCELLED`, `BOOKING_NOT_MODIFIABLE`, `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {VelexisError} `PRECONDITION_FAILED` (412)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    cancel: (params, options) => withIfMatch(core, op.console_bookings_cancel, params, options),

    /**
     * Re-synchronises a booking with Amadeus (Flight Order Management GET): status, segments and schedule changes,
     * tickets, travellers, contacts, remarks and ticketing agreement; resolves with the booking and its `changes`. Use
     * it after `SUPPLIER_TIMEOUT`, when a PNR shows up on a queue, or before acting on stale data. Throttled to one call
     * per 10 s per booking. `POST /v1/console/bookings/{bookingId}/resync` (safe to repeat); `bookings:write`.
     * @param {ConsoleResyncBookingParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleBookingResyncResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `BOOKING_NOT_MODIFIABLE` (409: no Amadeus order)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    resync: (params, options) => core.call(op.console_bookings_resync, params, live(options)),

    /**
     * Adds an internal note to the booking timeline (never sent to Amadeus; shown to the customer only with
     * `visibleToCustomer: true`); the booking `version` does not change. `POST /v1/console/bookings/{bookingId}/notes`
     * with a generated `Idempotency-Key`; `bookings:write`.
     * @param {ConsoleAddBookingNoteParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleBookingNote>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    addNote: (params, options) => core.call(op.console_bookings_addNote, params, live(options)),
  };
}

/**
 * `client.console.queues`: Amadeus office queues.
 * @param {Core} core
 */
function createConsoleQueuesApi(core) {
  return {
    /**
     * Reads an Amadeus office queue (Queue List): PNRs with record locator, creation time, traveller names and air
     * segments, each linked to this OTA's booking when there is one, wrapping the verbatim Amadeus item. A call without
     * `cursor` reads Amadeus and stores a snapshot (`page.snapshot`); `next()` and `for await` page through that stored
     * snapshot without calling Amadeus again. Resolves with a `Page` that keeps `snapshot` and `warnings`.
     * `GET /v1/console/queues/{queueId}`; `queues:read`.
     * @param {ConsoleListQueueParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleQueuePage>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400: bad cursor), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `OFFICE_NOT_ALLOWED`, `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    list: (params, options) => core.call(op.console_queues_list, params, live(options)),

    /**
     * Lists stored queue snapshots, newest first: reads by staff, raw `getQueue` calls and the scheduled queue poller
     * (`fetchedBy: null`); `include: ["items"]` adds the PNR items. Retained 30 days. Resolves with a `Page`.
     * `GET /v1/console/queue-snapshots`; `queues:read`. No Amadeus call.
     * @param {ConsoleListQueueSnapshotsParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<Page<QueueSnapshot>>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    listSnapshots: (params, options) => core.call(op.console_queues_listSnapshots, params, live(options)),
  };
}

/**
 * `client.console.customers`: the OTA's customer accounts.
 * @param {Core} core
 */
function createConsoleCustomersApi(core) {
  return {
    /**
     * Lists the OTA's customer accounts with booking statistics (bookings, upcoming, total spent, last booking).
     * Guests are not customers: find their bookings with `bookings.list({ customerEmail })`. Resolves with a `Page`.
     * `GET /v1/console/customers`; `customers:read`.
     * @param {ConsoleListCustomersParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<Page<ConsoleCustomerSummary>>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    list: (params, options) => core.call(op.console_customers_list, params, live(options)),

    /**
     * Gets a customer account (as the customer sees it) with statistics, the 10 most recent bookings and the
     * saved-traveller and active-session counts. Viewing is audited (GDPR access log); page through all bookings with
     * `bookings.list({ customerId })`. `GET /v1/console/customers/{customerId}`; `customers:read`.
     * @param {ConsoleGetCustomerParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleCustomer>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    get: (params, options) => core.call(op.console_customers_get, params, live(options)),
  };
}

/**
 * `client.console.supplierRequests`: the redacted Amadeus call log.
 * @param {Core} core
 */
function createConsoleSupplierRequestsApi(core) {
  return {
    /**
     * Lists logged Amadeus calls, newest first (90-day retention): operation, Amadeus API and operationId, method,
     * path, office, status, outcome, Amadeus error codes, latency, `correlationId` (quote it to Amadeus support), the
     * Velexis `requestId` and the related booking, search and staff member. `includeBodies: true` adds the redacted
     * bodies (cards, security codes, documents, e-mails and phones masked). Filter by `requestId` to troubleshoot a
     * failed call (`VelexisError.requestId`). Resolves with a `Page`. `GET /v1/console/supplier-requests`;
     * `supplier_requests:read`.
     * @param {ConsoleListSupplierRequestsParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<Page<ConsoleSupplierRequest>>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    list: (params, options) => core.call(op.console_supplierRequests_list, params, live(options)),
  };
}

/**
 * `client.console.amadeus`: the raw Amadeus pass-through. Every method runs with the OTA's own Amadeus connection of
 * the environment, sends the Amadeus request verbatim (an `amadeus` body or the Amadeus query parameters) and resolves
 * with the verbatim response (`result.amadeus`) and the call info (`result.call`). Prices are net (no markup): never
 * show them to customers. Amadeus 4xx → `ValidationError` `SUPPLIER_REJECTED` (422, `error.details.errors`,
 * `error.supplier`); 404 → `NotFoundError`; 2552 → `ConflictError` `VERSION_CONFLICT`; 5xx → `SupplierError`. Logged
 * in supplier_requests (pass `bookingId` to link a call) and audited in staff_actions (`reason`). `amadeus:read` for
 * searches and reads, `amadeus:write` for the writes (deferred in the MVP); raw access can be disabled per OTA (`403
 * FEATURE_DISABLED`); 30 calls per minute per staff member.
 * @param {Core} core
 */
function createConsoleAmadeusApi(core) {
  return {
    /**
     * Raw Flight Offers Search POST with the complete getFlightOffersQuery (`amadeus`: currency, origin-destinations
     * with date and time windows, travellers, sources, search criteria with pricing options and flight filters).
     * Nothing is stored as an offer. `POST /v1/console/amadeus/v2/shopping/flight-offers` (safe to repeat);
     * `amadeus:read`.
     * @param {ConsoleAmadeusSearchFlightOffersParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusFlightOffersResult>}
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED`, `STAFF_MEMBERSHIP_INACTIVE` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    searchFlightOffers: (params, options) =>
      core.call(op.console_amadeus_searchFlightOffers, params, live(options)),

    /**
     * Raw Flight Offers Search GET with every Amadeus query parameter (origin, destination, dates, travellers, cabin,
     * included and excluded airlines, non-stop, currency, maximum price, maximum offers); airline lists may be arrays,
     * sent comma-separated. `GET /v1/console/amadeus/v2/shopping/flight-offers`; `amadeus:read`.
     * @param {ConsoleAmadeusGetFlightOffersParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusFlightOffersResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    getFlightOffers: (params, options) =>
      core.call(op.console_amadeus_getFlightOffers, params, live(options)),

    /**
     * Raw Flight Availabilities Search (seat availability per booking class) with the complete
     * getFlightAvailabilitiesQuery in `amadeus`. `POST /v1/console/amadeus/v1/shopping/availability/flight-availabilities`
     * (safe to repeat); `amadeus:read`.
     * @param {ConsoleAmadeusSearchFlightAvailabilitiesParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusAvailabilitiesResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    searchFlightAvailabilities: (params, options) =>
      core.call(op.console_amadeus_searchFlightAvailabilities, params, live(options)),

    /**
     * Raw Branded Fares Upsell: `{ amadeus: { data: { type: "flight-offer-upsell", flightOffers, payments } } }` → the
     * upsold offers per branded fare. `POST /v1/console/amadeus/v1/shopping/flight-offers/upselling` (safe to repeat);
     * `amadeus:read`.
     * @param {ConsoleAmadeusUpsellAirOffersParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusUpsellResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    upsellAirOffers: (params, options) =>
      core.call(op.console_amadeus_upsellAirOffers, params, live(options)),

    /**
     * Raw Flight Offers Price: body `{ amadeus: { data: { type: "flight-offer-pricing", flightOffers, payments?,
     * travelers?, additionalInformation? } } }` with the Amadeus query `include` (credit-card fees, bags, other
     * services, detailed fare rules; sent comma-separated) and `forceClass` → confirmed offers, `bookingRequirements`
     * and the `included` maps. `POST /v1/console/amadeus/v1/shopping/flight-offers/pricing` (safe to repeat);
     * `amadeus:read`.
     * @param {ConsoleAmadeusQuoteAirOffersParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusPricingResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    quoteAirOffers: (params, options) => core.call(op.console_amadeus_quoteAirOffers, params, live(options)),

    /**
     * Raw Flight Create Orders: `{ amadeus: { data: FlightOrder } }` with every Amadeus field and the Amadeus `issue`
     * flag; not attached to the OTA's tables unless `importAsBooking: true`. A same-key retry replays a stored 504 and
     * never calls Amadeus again. `POST /v1/console/amadeus/v1/booking/flight-orders` with a generated
     * `Idempotency-Key`; `amadeus:write`. Deferred: the API answers `501 NOT_IMPLEMENTED`, thrown as a `ServerError`
     * that is not retryable.
     * @param {ConsoleAmadeusCreateFlightOrdersParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusFlightOrderResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `OFFICE_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {SoldOutError} `SOLD_OUT` (409)
     * @throws {PriceChangedError} `PRICE_CHANGED` (409)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR`, `TICKETING_FAILED` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    createFlightOrders: (params, options) =>
      core.call(op.console_amadeus_createFlightOrders, params, live(options)),

    /**
     * Raw Flight Order Issue of any order: `{ flightOrderId, amadeus?: { data: { formOfPayments } } }`; an attached
     * booking is re-synchronised but no payment is captured (prefer `bookings.issue`). Never issues twice for one
     * idempotency key. `POST /v1/console/amadeus/v1/booking/flight-orders/{flightOrderId}/issuance` with a generated
     * `Idempotency-Key`; `amadeus:write`. Deferred: the API answers `501 NOT_IMPLEMENTED`, thrown as a `ServerError`
     * that is not retryable.
     * @param {ConsoleAmadeusIssueFlightOrderParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusFlightOrderResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `VERSION_CONFLICT` (409: Amadeus 2552), `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `TICKETING_FAILED`, `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    issueFlightOrder: (params, options) =>
      core.call(op.console_amadeus_issueFlightOrder, params, live(options)),

    /**
     * Raw Flight Order Management GET of any order the OTA's credentials can read, with `include` and `fareRules`
     * (comma-separated); does not modify an attached booking (`result.bookingId`).
     * `GET /v1/console/amadeus/v1/booking/flight-orders/{flightOrderId}`; `amadeus:read`.
     * @param {ConsoleAmadeusGetFlightOrderParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusFlightOrderResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    getFlightOrder: (params, options) => core.call(op.console_amadeus_getFlightOrder, params, live(options)),

    /**
     * Raw Flight Order Management PATCH: `{ flightOrderId, amadeus: { data: { type: "flight-order", …elements } } }`
     * sent verbatim (no merge: every element sent replaces the order's element); an attached booking is
     * re-synchronised from the response (prefer `bookings.patch`). Not retried; after a timeout read the order first.
     * `PATCH /v1/console/amadeus/v1/booking/flight-orders/{flightOrderId}`; `amadeus:write`. Deferred: the API answers
     * `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {ConsoleAmadeusPatchFlightOrderParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusFlightOrderResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `OFFICE_NOT_ALLOWED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {ConflictError} `VERSION_CONFLICT` (409: Amadeus 2552)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    patchFlightOrder: (params, options) =>
      core.call(op.console_amadeus_patchFlightOrder, params, live(options)),

    /**
     * Raw Flight Order Management DELETE (`reason` required, sent in the query); an attached booking is marked
     * cancelled without refund or notification (prefer `bookings.cancel`).
     * `DELETE /v1/console/amadeus/v1/booking/flight-orders/{flightOrderId}`; `amadeus:write`. Deferred: the API answers
     * `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {ConsoleAmadeusCancelFlightOrderParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusCancelResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404: unknown or already cancelled)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    cancelFlightOrder: (params, options) =>
      core.call(op.console_amadeus_cancelFlightOrder, params, live(options)),

    /**
     * Raw Get Flight Order By Record Locator (`reference`, `originSystemCode` defaulting to `"GDS"`, `include`):
     * verbatim orders and their `matches` with this OTA's bookings (prefer `bookings.findByRecordLocator` for lookup
     * and import). `GET /v1/console/amadeus/v1/booking/flight-orders/by-reference`; `amadeus:read`.
     * @param {ConsoleAmadeusGetFlightOrderByReferenceParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusFlightOrdersByReferenceResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    getFlightOrderByReference: (params, options) =>
      byRecordLocator(core, op.console_amadeus_getFlightOrderByReference, params, options),

    /**
     * Raw Queue List (`queueId`, `max`, `category`, `officeId` verbatim) → the verbatim PNR list; the read is also
     * stored as a queue snapshot (`result.queueSnapshotId`). Prefer `queues.list` for PNRs linked to bookings.
     * `GET /v1/console/amadeus/office/queues/{queueId}`; `amadeus:read`.
     * @param {ConsoleAmadeusGetQueueParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<ConsoleAmadeusQueueResult>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400), `SUPPLIER_REJECTED` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `OFFICE_NOT_ALLOWED`, `FORBIDDEN`, `FEATURE_DISABLED`, `SCOPE_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {SupplierError} `SUPPLIER_NOT_CONFIGURED` (424), `SUPPLIER_ERROR` (502), `SUPPLIER_UNAVAILABLE` (503), `SUPPLIER_TIMEOUT` (504)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    getQueue: (params, options) => core.call(op.console_amadeus_getQueue, params, live(options)),
  };
}

/**
 * The `console` namespace of a client: the contract's six sub-namespaces (SDK-012 adds `settings` and `payments`).
 * @param {Core} core the client's request core
 */
export function createConsoleApi(core) {
  return {
    /** Staff sign-in (portal token), refresh, sign-out, me. */
    auth: createConsoleAuthApi(core),
    /** All bookings of the OTA, PNR lookup and import, Amadeus order retrieve, create, patch, issue, cancel, resync, notes. */
    bookings: createConsoleBookingsApi(core),
    /** Amadeus office queues and stored queue snapshots. */
    queues: createConsoleQueuesApi(core),
    /** Customers of the OTA with statistics and bookings. */
    customers: createConsoleCustomersApi(core),
    /** The redacted Amadeus call log. */
    supplierRequests: createConsoleSupplierRequestsApi(core),
    /** Raw Amadeus pass-through (verbatim request and response), one method per Amadeus operation. */
    amadeus: createConsoleAmadeusApi(core),
  };
}
