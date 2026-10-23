// The `account` namespace (docs/velexis-sdk/sdk/src/identity.d.ts `AccountApi`, guide B1 §4–§6, ota/sdk/README.md
// §5.2, OADR-0016 points 1–3): the signed-in customer's own data. The twelve methods of the contract in the namespace
// and its three sub-namespaces (`preferences`, `savedTravelers`, `dataExports`), each one line through the generated
// route table (internal/operations.js), which also gives the POSTs their generated `Idempotency-Key`; `AccountApi` in
// identity.js is inferred from this factory. `savedTravelers.list` resolves with a `Page` (`next()`, `for await`
// across pages). Nine methods are deferred until after the MVP (`preferences.*`, `savedTravelers.*`, `dataExports.*`;
// ota/docs/scope.md §3): the API answers `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
//
// - Every method needs the customer's access token (cookie mode: the session cookie) and acts on that customer.
// - `If-Match`: `update`, `preferences.update` and `savedTravelers.update` require `ifMatch`, the resource `version`
//   of the last read (a number, sent as its ETag `"<version>"`) or the ETag itself (a string, sent as it is). A missing
//   or malformed `ifMatch` is a `TypeError` before any request, like a missing path parameter, and so is a call
//   without params (FIX-W27-FOLLOWUPS: `update()` and `preferences.update()` have no path parameter, and went out
//   without `If-Match` before); the check is the one of `console` and `bookings` (internal/if-match.js). A stale one
//   is the API's `412 PRECONDITION_FAILED`.
//
// The responses are personal, so every method sends `cache: "no-store"` to `fetch` unless the call sets `cache` or
// `next` itself (identity.d.ts `AccountApi`: never cache them).

import { requireIfMatch } from "../internal/if-match.js";
import { op } from "../internal/operations.js";

/** @typedef {import("../internal/client.js").Core} Core */
/** @typedef {import("../internal/operations.js").Operation} Operation */
/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @template T @typedef {import("../shared.js").Page<T>} Page */
/** @typedef {import("../types.js").Schemas} Schemas */
/** @typedef {import("../identity.js").AccountGetParams} AccountGetParams */
/** @typedef {import("../identity.js").AccountIfMatch} AccountIfMatch */
/** @typedef {import("../identity.js").AccountUpdateParams} AccountUpdateParams */
/** @typedef {import("../identity.js").AccountPreferencesGetParams} AccountPreferencesGetParams */
/** @typedef {import("../identity.js").AccountPreferencesUpdateParams} AccountPreferencesUpdateParams */
/** @typedef {import("../identity.js").AccountDataExportGetParams} AccountDataExportGetParams */
/** @typedef {import("../identity.js").SavedTravelerListParams} SavedTravelerListParams */
/** @typedef {import("../identity.js").SavedTravelerRefParams} SavedTravelerRefParams */
/** @typedef {import("../identity.js").SavedTravelerUpdateParams} SavedTravelerUpdateParams */
/** @typedef {import("../shared.js").ValidationError} ValidationError */
/** @typedef {import("../shared.js").AuthenticationError} AuthenticationError */
/** @typedef {import("../shared.js").PermissionError} PermissionError */
/** @typedef {import("../shared.js").NotFoundError} NotFoundError */
/** @typedef {import("../shared.js").ConflictError} ConflictError */
/** @typedef {import("../shared.js").VelexisError} VelexisError */
/** @typedef {import("../shared.js").RateLimitError} RateLimitError */
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
 * The request options of one `account.*` call with the fetch cache mode `no-store`: the account is personal, and a
 * cached copy would show another customer's data or a stale version. A call that sets `cache` or `next` keeps its own
 * choice. Options that are not a plain object are passed on unchanged, so `core.call` refuses them with its usual
 * `TypeError` (a copy would accept them and drop what they inherit).
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
 * Sends a call whose operation requires `If-Match` (`update`, `preferences.update`, `savedTravelers.update`), with
 * `ifMatch` as the header value: a version number becomes its ETag `"<version>"`, a non-blank string of visible ASCII
 * is an ETag and is sent as it is (`requireIfMatch`, internal/if-match.js). A missing or malformed `ifMatch`, also in
 * a call without params, rejects with a `TypeError` before any request, also before the CSRF request of cookie mode,
 * naming the parameter and whose version it is (`resource`), never its value. Other params that are not a plain object
 * are passed on unchanged, so `core.call` refuses them with its usual `TypeError`.
 * @template T
 * @param {Core} core
 * @param {Operation} operation
 * @param {string} resource what the version belongs to, as the message names it: `account`, `preferences` …
 * @param {AccountIfMatch | undefined} params
 * @param {RequestOptions | undefined} options
 * @returns {Promise<T>}
 */
async function withIfMatch(core, operation, resource, params, options) {
  return core.call(operation, requireIfMatch(operation, resource, params), live(options));
}

/**
 * `client.account.preferences`: travel and notification preferences (deferred).
 * @param {Core} core
 */
function createAccountPreferencesApi(core) {
  return {
    /**
     * Gets the customer's preferences: locale, currency, home airport, default cabin (`travelClass`), seat and meal
     * preference, optional notifications. `GET /v1/account/preferences` (`ETag` = the quoted `version`). Deferred: the
     * API answers `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {AccountPreferencesGetParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["CustomerPreferences"]>}
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    get: (params, options) => core.call(op.account_preferences_get, params, live(options)),

    /**
     * Updates preferences partially (`notifications.email` and `.sms` are merged key by key; `null` clears);
     * `currency` and `locale` must be offered by the storefront, `homeAirport` must exist. `ifMatch` is required:
     * `preferences.version`. `PATCH /v1/account/preferences` with `If-Match`. Deferred: the API answers
     * `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {AccountPreferencesUpdateParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["CustomerPreferences"]>}
     * @throws {TypeError} without a valid `ifMatch`, before any request
     * @throws {ValidationError} `VALIDATION_FAILED` (field codes `unsupported_currency`, `unsupported_locale`, `unknown_airport`, `phone_required`)
     * @throws {VelexisError} `PRECONDITION_FAILED` (412: stale `ifMatch`; reload and retry)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    update: (params, options) =>
      withIfMatch(core, op.account_preferences_update, "preferences", params, options),
  };
}

/**
 * `client.account.savedTravelers`: saved travellers with documents and loyalty programmes (deferred).
 * @param {Core} core
 */
function createAccountSavedTravelersApi(core) {
  return {
    /**
     * Lists saved travellers (the account holder first, then the most recently used); documents carry `numberMasked`
     * only. Resolves with a `Page` that has `next()` and is async-iterable across pages.
     * `GET /v1/account/saved-travelers?cursor&limit`. Deferred: the API answers `501 NOT_IMPLEMENTED`, thrown as a
     * `ServerError` that is not retryable.
     * @param {SavedTravelerListParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<Page<Schemas["SavedTraveler"]>>}
     * @throws {ValidationError} `VALIDATION_FAILED` (bad cursor or limit)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `FEATURE_DISABLED`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    list: (params, options) => core.call(op.account_savedTravelers_list, params, live(options)),

    /**
     * Saves a traveller (Amadeus `Traveler` field names, documents with Amadeus identity-document names) and resolves
     * with the full traveller, `amadeus` projection included. `POST /v1/account/saved-travelers` (201) with a generated
     * `Idempotency-Key`. Deferred: the API answers `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not
     * retryable.
     * @param {Schemas["SavedTravelerCreateRequest"]} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["SavedTraveler"]>}
     * @throws {ValidationError} `TRAVELER_DATA_INVALID` (422, see `fieldErrors`), `SAVED_TRAVELER_LIMIT_REACHED` (422, at most 20), `VALIDATION_FAILED`
     * @throws {PermissionError} `FEATURE_DISABLED`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    create: (params, options) => core.call(op.account_savedTravelers_create, params, live(options)),

    /**
     * Gets one saved traveller with full document numbers and the `amadeus` (`Traveler`) projection.
     * `GET /v1/account/saved-travelers/{savedTravelerId}` (`ETag`). Deferred: the API answers `501 NOT_IMPLEMENTED`,
     * thrown as a `ServerError` that is not retryable.
     * @param {SavedTravelerRefParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["SavedTraveler"]>}
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    get: (params, options) => core.call(op.account_savedTravelers_get, params, live(options)),

    /**
     * Updates a saved traveller partially; `documents`, `loyaltyPrograms` and `discountEligibility` replace the stored
     * lists (documents with an existing `id` are updated in place). `ifMatch` is required: `traveler.version`.
     * `PATCH /v1/account/saved-travelers/{savedTravelerId}` with `If-Match`. Deferred: the API answers
     * `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {SavedTravelerUpdateParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["SavedTraveler"]>}
     * @throws {TypeError} without a valid `ifMatch`, before any request
     * @throws {ValidationError} `TRAVELER_DATA_INVALID` (422), `VALIDATION_FAILED`
     * @throws {VelexisError} `PRECONDITION_FAILED` (412)
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    update: (params, options) =>
      withIfMatch(core, op.account_savedTravelers_update, "saved traveler", params, options),

    /**
     * Deletes a saved traveller and its documents (existing bookings keep their own copies). Resolves with nothing
     * (`204`). `DELETE /v1/account/saved-travelers/{savedTravelerId}`. Deferred: the API answers
     * `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {SavedTravelerRefParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<void>}
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    delete: (params, options) => core.call(op.account_savedTravelers_delete, params, live(options)),
  };
}

/**
 * `client.account.dataExports`: personal-data exports (deferred).
 * @param {Core} core
 */
function createAccountDataExportsApi(core) {
  return {
    /**
     * Requests an export of all personal data (profile, preferences, consents, saved travellers, optionally bookings)
     * as a ZIP of JSON or CSV files; resolves with the queued job (or the one in progress). `POST
     * /v1/account/data-exports` (202) with a generated `Idempotency-Key`. Deferred: the API answers
     * `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {Schemas["AccountDataExportInput"]} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["AccountDataExport"]>}
     * @throws {RateLimitError} `RATE_LIMITED` (429: one new export per 24 h, `retryAfterSeconds`)
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    create: (params, options) => core.call(op.account_dataExports_create, params, live(options)),

    /**
     * Gets an export's status; when `status` is `ready`, `downloadUrl` is a signed URL valid 15 minutes (each call
     * signs a new one) until `expiresAt`. `GET /v1/account/data-exports/{dataExportId}`. Deferred: the API answers
     * `501 NOT_IMPLEMENTED`, thrown as a `ServerError` that is not retryable.
     * @param {AccountDataExportGetParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["AccountDataExport"]>}
     * @throws {NotFoundError} `NOT_FOUND` (404)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `NOT_IMPLEMENTED` (501, deferred), `INTERNAL_ERROR` (500)
     */
    get: (params, options) => core.call(op.account_dataExports_get, params, live(options)),
  };
}

/**
 * The `account` namespace of a client.
 * @param {Core} core the client's request core
 */
export function createAccountApi(core) {
  return {
    /**
     * Gets the signed-in customer's profile (also the source for pre-filling the checkout contact and first
     * traveller). `customer.version` is the `ifMatch` of `update`. `GET /v1/account` (`ETag` = the quoted `version`).
     * @param {AccountGetParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["Customer"]>}
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    get: (params, options) => core.call(op.account_get, params, live(options)),

    /**
     * Updates the profile partially (names, phone, date of birth, marketing consent; the e-mail with
     * `currentPassword`, which becomes `pendingEmail` until confirmed with `auth.verifyEmail`). `ifMatch` is required:
     * `customer.version`. `PATCH /v1/account` with `If-Match`.
     * @param {AccountUpdateParams} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["Customer"]>}
     * @throws {TypeError} without a valid `ifMatch`, before any request
     * @throws {VelexisError} `PRECONDITION_FAILED` (412: stale `ifMatch`; reload and retry)
     * @throws {ConflictError} `EMAIL_ALREADY_REGISTERED` (409)
     * @throws {ValidationError} `VALIDATION_FAILED`, `CURRENT_PASSWORD_INCORRECT` (422)
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    update: (params, options) => withIfMatch(core, op.account_update, "account", params, options),

    /**
     * Deletes the account, re-authenticated with `currentPassword`: signs the customer out everywhere at once and
     * erases personal data; bookings and payments are kept as the law requires (`retainedRecords`). Delete the session
     * cookies afterwards (cookie mode: the API clears them). `POST /v1/account/deletion` (202) with a generated
     * `Idempotency-Key`.
     * @param {Schemas["AccountDeletionInput"]} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["AccountDeletion"]>}
     * @throws {ConflictError} `ACCOUNT_DELETION_BLOCKED` (`details.bookingIds` awaiting payment, ticketing or a refund), `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {ValidationError} `CURRENT_PASSWORD_INCORRECT` (422), `VALIDATION_FAILED`
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    delete: (params, options) => core.call(op.account_delete, params, live(options)),

    /** Travel and notification preferences (deferred). */
    preferences: createAccountPreferencesApi(core),
    /** Saved travellers with documents and loyalty programmes, usable in checkout (deferred). */
    savedTravelers: createAccountSavedTravelersApi(core),
    /** Personal-data exports (deferred). */
    dataExports: createAccountDataExportsApi(core),
  };
}
