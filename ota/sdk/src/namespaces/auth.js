// The `auth` namespace (docs/velexis-sdk/sdk/src/identity.d.ts `AuthApi`, guide B1 §3, ota/sdk/README.md §4 and §5.2,
// OADR-0016 points 1–3, OADR-0006 points 4 and 5): customer sign-up, e-mail verification, sign-in, the rotating
// refresh, sign-out, the password reset and change, and the current session. The ten methods of the contract, each one
// line through the generated route table (internal/operations.js), which also gives every POST its generated
// `Idempotency-Key`; `AuthApi` in identity.js is inferred from this factory. None of them calls Amadeus.
//
// - Session results: `signIn`, `refresh` and `changePassword` resolve with `AuthSessionResult` (the tokens) in token and
//   server mode and with `AuthSessionInfo` (no token fields) in cookie mode, where the session lives in httpOnly
//   cookies; the SDK types them as the union, the approved deviation of OADR-0006 (test/contract/deviations.ts,
//   ota/sdk/docs/extensions.md §6). In token and server mode the result becomes the client's session
//   (internal/session.js `adopt`): `onSessionRefreshed` gets `result.session`, and the client sends the new tokens
//   wherever its token sources still give the replaced ones, so it never presents a rotated refresh token again
//   (reuse revokes the family). A client without token options only reports them: a server client shared by every
//   visitor never starts sending one visitor's token. A call with its own credential (`options.accessToken`, or an
//   `Authorization` header of the call or the client) is not the client's session and feeds nothing. Cookie mode
//   stores nothing.
// - Cookie mode hands page code no token, whatever a response says: `signIn`, `refresh` and `changePassword` resolve
//   without `session.accessToken` and `session.refreshToken`, `signUp` and `resetPassword` with `session: null`
//   (OADR-0006 point 4). `refresh` sends an empty body there (the refresh token is the `__Host-vx_rt` cookie), and a
//   `refreshToken` in the params of `refresh` or `signOut` is a `TypeError` before any request: page code never holds
//   one (OADR-0006 point 5). In token and server mode `refresh` sends the `refreshToken` of its params.
//
// Everything here opens, rotates, ends or reads a session, so every method sends `cache: "no-store"` to `fetch` unless
// the call sets `cache` or `next` itself (identity.d.ts: never cached; `getSession` always `no-store`).

import { op } from "../internal/operations.js";

/** @typedef {import("../internal/client.js").Core} Core */
/** @typedef {import("../internal/operations.js").Operation} Operation */
/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @typedef {import("../types.js").Schemas} Schemas */
/** @typedef {import("../identity.js").AuthGetSessionParams} AuthGetSessionParams */
/** @typedef {Schemas["AuthSessionResult"] | Schemas["AuthSessionInfo"]} AuthSessionOutcome */
/** @typedef {import("../shared.js").ValidationError} ValidationError */
/** @typedef {import("../shared.js").AuthenticationError} AuthenticationError */
/** @typedef {import("../shared.js").PermissionError} PermissionError */
/** @typedef {import("../shared.js").ConflictError} ConflictError */
/** @typedef {import("../shared.js").VelexisError} VelexisError */
/** @typedef {import("../shared.js").RateLimitError} RateLimitError */
/** @typedef {import("../shared.js").ServerError} ServerError */

/** The token fields of a `Session` that cookie mode never hands to page code. */
const SESSION_TOKEN_FIELDS = ["accessToken", "refreshToken"];

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
 * The request options of one `auth.*` call with the fetch cache mode `no-store`: these calls open, rotate, end or read
 * a session, and a cached copy would show another visitor's session or a stale one. A call that sets `cache` or `next`
 * keeps its own choice. Options that are not a plain object are passed on unchanged, so `core.call` refuses them with
 * its usual `TypeError` (a copy would accept them and drop what they inherit).
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
 * Refuses a refresh token in the params of `refresh` and `signOut` in cookie mode, before any request (also before
 * the CSRF request): the refresh token is the httpOnly `__Host-vx_rt` cookie, which page code cannot read, and the API
 * refuses a token in an edge request's body (OADR-0006 point 5). The message names the parameter, never its value.
 * @param {Core} core
 * @param {Operation} operation
 * @param {unknown} params
 * @throws {TypeError}
 */
function refuseTokenInCookieMode(core, operation, params) {
  if (core.mode === "cookie" && isPlainObject(params) && params["refreshToken"] !== undefined) {
    throw new TypeError(
      `Velexis SDK: ${operation.method} ${operation.path} takes no "refreshToken" with session "cookie"; the browser sends the __Host-vx_rt cookie`,
    );
  }
}

/**
 * A session result as cookie mode hands it to page code: without `session.accessToken` and `session.refreshToken`,
 * whatever the response says (the API answers the edge `AuthSessionInfo`, OADR-0006 point 4).
 * @param {AuthSessionOutcome} result
 * @returns {AuthSessionOutcome}
 */
function withoutSessionTokens(result) {
  const session = isPlainObject(result) ? result["session"] : undefined;
  if (!isPlainObject(session) || !SESSION_TOKEN_FIELDS.some((name) => Object.hasOwn(session, name))) {
    return result;
  }
  const kept = Object.entries(session).filter(([name]) => !SESSION_TOKEN_FIELDS.includes(name));
  return /** @type {AuthSessionOutcome} */ ({ ...result, session: Object.fromEntries(kept) });
}

/**
 * Sends a call that resolves with a session (`signIn`, `refresh`, `changePassword`). Token and server mode: the result
 * becomes the client's session (`core.adoptSession`: `onSessionRefreshed`, and the tokens the client sends from now
 * on) before the call resolves with it, unless the call presents its own credential (`options.accessToken`, an
 * `Authorization` header). Cookie mode stores nothing and resolves without token fields.
 * @param {Core} core
 * @param {Operation} operation
 * @param {object | undefined} params
 * @param {RequestOptions | undefined} options
 * @param {string | undefined} presentedRefreshToken the refresh token the call sends (`refresh`)
 * @returns {Promise<AuthSessionOutcome>}
 */
async function sessionCall(core, operation, params, options, presentedRefreshToken) {
  const callOptions = live(options);
  /** @type {AuthSessionOutcome} */
  const result = await core.call(operation, params, callOptions);
  if (core.mode === "cookie") {
    return withoutSessionTokens(result);
  }
  await core.adoptSession(result, presentedRefreshToken, callOptions);
  return result;
}

/**
 * Sends a call whose result may open a session that the client does not adopt (`signUp`, `resetPassword`): its
 * `session` is `null` in cookie mode whatever the response says (the session went into httpOnly cookies).
 * @template {{ session: Schemas["Session"] | null }} T
 * @param {Core} core
 * @param {Operation} operation
 * @param {object | undefined} params
 * @param {RequestOptions | undefined} options
 * @returns {Promise<T>}
 */
async function withSessionInCookies(core, operation, params, options) {
  /** @type {T} */
  const result = await core.call(operation, params, live(options));
  return core.mode === "cookie" && isPlainObject(result) ? { ...result, session: null } : result;
}

/**
 * The refresh token that `refresh` sends: the one of its params, when it is a string.
 * @param {unknown} params
 * @returns {string | undefined}
 */
function presentedRefreshTokenOf(params) {
  const refreshToken = isPlainObject(params) ? params["refreshToken"] : undefined;
  return typeof refreshToken === "string" ? refreshToken : undefined;
}

/**
 * The `auth` namespace of a client.
 * @param {Core} core the client's request core
 */
export function createAuthApi(core) {
  return {
    /**
     * Creates a customer account (e-mail, password, name, marketing consent, the accepted `termsVersion`) and queues a
     * verification e-mail. Resolves with the customer, the verification state and a session, which is `null` when the
     * OTA requires verification before sign-in, and always `null` in cookie mode (the session went into httpOnly
     * cookies). In token and server mode the session holds tokens: call it from a server action or route handler and
     * put them into httpOnly cookies; the client does not adopt them. `POST /v1/auth/sign-up` (201) with a generated
     * `Idempotency-Key`; key only, anonymous.
     * @param {Schemas["SignUpRequest"]} params
     * @param {RequestOptions} [options] pass `endUser` from server code (per-IP limits)
     * @returns {Promise<Schemas["AuthSignUpResult"]>}
     * @throws {ValidationError} `VALIDATION_FAILED` (see `fieldErrors`, for example `/email` or an outdated `/termsVersion`), `PASSWORD_TOO_WEAK` (422, `details.violations`)
     * @throws {ConflictError} `EMAIL_ALREADY_REGISTERED` (offer sign-in or a password reset), `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {PermissionError} `FEATURE_DISABLED` (customer accounts off), `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {AuthenticationError} `INVALID_API_KEY` (401)
     * @throws {RateLimitError} `RATE_LIMITED` (429: 5 sign-ups per hour per end-user IP and per e-mail)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    signUp: (params, options) => withSessionInCookies(core, op.auth_signUp, params, options),

    /**
     * Confirms an e-mail address with the one-time token of the verification link (a first verification or a pending
     * e-mail change) and attaches earlier guest bookings with the same address to the account. Opens no session.
     * `POST /v1/auth/email-verification/confirm` with a generated `Idempotency-Key`; key only (the token is the proof).
     * @param {Schemas["EmailVerificationConfirmRequest"]} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["EmailVerificationResult"]>}
     * @throws {ValidationError} `VERIFICATION_TOKEN_INVALID` (`details.reason`: `unknown`, `used` or `expired`; offer `resendVerification`), `VALIDATION_FAILED`
     * @throws {ConflictError} `EMAIL_ALREADY_REGISTERED` (the new address was taken meanwhile), `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {AuthenticationError} `INVALID_API_KEY` (401)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    verifyEmail: (params, options) => core.call(op.auth_verifyEmail, params, live(options)),

    /**
     * Sends a new verification e-mail: signed in, omit `email` (it goes to the unverified or pending address);
     * anonymous, pass `email`. Always resolves with the same `accepted` result (no account enumeration).
     * `POST /v1/auth/email-verification/resend` (202) with a generated `Idempotency-Key`; customer token optional.
     * @param {Schemas["EmailVerificationResendRequest"]} params
     * @param {RequestOptions} [options] pass `endUser` from server code (per-IP limits)
     * @returns {Promise<Schemas["AuthAcceptedResult"]>}
     * @throws {ValidationError} `VALIDATION_FAILED` (no `email` when anonymous)
     * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED` (401)
     * @throws {PermissionError} `FEATURE_DISABLED`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429: 20 per hour per end-user IP)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    resendVerification: (params, options) => core.call(op.auth_resendVerification, params, live(options)),

    /**
     * Signs a customer in with e-mail and password (`rememberMe`, default true: a 30-day session, else 12 hours).
     * Token and server mode: resolves with `AuthSessionResult` (the 15-minute access token, the rotating refresh token
     * and the customer), which becomes the client's session: `onSessionRefreshed` gets `result.session`, and a client
     * with token options sends the new tokens from now on. Call it from a server action or route handler and keep the
     * tokens in httpOnly cookies. Cookie mode: resolves with `AuthSessionInfo`, without token fields (the session is in
     * httpOnly cookies, the CSRF cookie is rotated). `POST /v1/auth/sign-in` with a generated `Idempotency-Key`; key
     * only, anonymous.
     * @param {Schemas["SignInRequest"]} params
     * @param {RequestOptions} [options] pass `endUser` from server code (lockouts and limits per visitor)
     * @returns {Promise<Schemas["AuthSessionResult"] | Schemas["AuthSessionInfo"]>}
     * @throws {AuthenticationError} `INVALID_CREDENTIALS` (`details.remainingAttempts`), `INVALID_API_KEY` (401)
     * @throws {PermissionError} `EMAIL_NOT_VERIFIED` (a fresh link was sent, `details.verificationSentTo`), `FEATURE_DISABLED`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {VelexisError} `ACCOUNT_LOCKED` (423, `details.lockedUntil`; offer a password reset)
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429, `retryAfterSeconds`)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    signIn: (params, options) => sessionCall(core, op.auth_signIn, params, options, undefined),

    /**
     * Rotates the session: a new access and refresh token pair (the presented refresh token stops working; presenting
     * it again revokes the whole family). Token and server mode: send `refreshToken`; resolves with `AuthSessionResult`,
     * which becomes the client's session like `signIn`'s (the client never presents the rotated refresh token again).
     * Cookie mode: call it without params; it sends an empty body (the refresh token is the `__Host-vx_rt` cookie),
     * refuses a `refreshToken` with a `TypeError` before any request and resolves with `AuthSessionInfo`. The SDK also
     * calls it by itself on `401 TOKEN_EXPIRED` when the client can refresh (README §4). `POST /v1/auth/refresh` with a
     * generated `Idempotency-Key`; key only, no access token.
     * @param {Schemas["AuthRefreshRequest"]} [params] `refreshToken` in token and server mode; none in cookie mode
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["AuthSessionResult"] | Schemas["AuthSessionInfo"]>}
     * @throws {AuthenticationError} `REFRESH_TOKEN_INVALID` (expired or revoked), `REFRESH_TOKEN_REUSED` (the family is revoked): sign the customer out; `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {ValidationError} `VALIDATION_FAILED`, `INVALID_REQUEST` (400)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    refresh: async (params, options) => {
      refuseTokenInCookieMode(core, op.auth_refresh, params);
      return sessionCall(core, op.auth_refresh, params, options, presentedRefreshTokenOf(params));
    },

    /**
     * Signs out of the current session (`scope: "current"`, the default) or of every session of the customer
     * (`scope: "all"`); revoked sessions stop working at once. Token and server mode: with the customer token, or pass
     * `refreshToken` when the access token may have expired. Cookie mode: the session cookies say which session, and
     * the API clears them; a `refreshToken` is a `TypeError` before any request. Resolves with nothing (`204`).
     * `POST /v1/auth/sign-out` with a generated `Idempotency-Key`.
     * @param {Schemas["AuthSignOutRequest"]} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<void>}
     * @throws {AuthenticationError} `UNAUTHENTICATED` (neither a token nor a refresh token), `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    signOut: async (params, options) => {
      refuseTokenInCookieMode(core, op.auth_signOut, params);
      return core.call(op.auth_signOut, params, live(options));
    },

    /**
     * Requests a password-reset e-mail (the link is valid 60 minutes). Always resolves with the same `accepted` result
     * (no account enumeration). `POST /v1/auth/password-resets` (202) with a generated `Idempotency-Key`; key only.
     * @param {Schemas["PasswordResetRequest"]} params
     * @param {RequestOptions} [options] pass `endUser` from server code (per-IP limits)
     * @returns {Promise<Schemas["AuthAcceptedResult"]>}
     * @throws {ValidationError} `VALIDATION_FAILED` (400)
     * @throws {PermissionError} `FEATURE_DISABLED`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {AuthenticationError} `INVALID_API_KEY` (401)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429: 10 per hour per end-user IP)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    requestPasswordReset: (params, options) => core.call(op.auth_requestPasswordReset, params, live(options)),

    /**
     * Sets a new password with the token of the reset link: revokes every session of the customer, unlocks the
     * account and marks the e-mail verified; with `signIn: true` (the default) it opens a new session, which is `null`
     * in cookie mode (the session went into httpOnly cookies) and holds tokens in token and server mode (the client
     * does not adopt them; put them into httpOnly cookies). `POST /v1/auth/password-resets/confirm` with a generated
     * `Idempotency-Key`; key only (the token is the proof).
     * @param {Schemas["PasswordResetConfirmRequest"]} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["PasswordResetResult"]>}
     * @throws {ValidationError} `PASSWORD_RESET_TOKEN_INVALID` (`details.reason`), `PASSWORD_TOO_WEAK` (422), `VALIDATION_FAILED`
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {AuthenticationError} `INVALID_API_KEY` (401)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    resetPassword: (params, options) => withSessionInCookies(core, op.auth_resetPassword, params, options),

    /**
     * Changes the signed-in customer's password (re-checks `currentPassword`). The current session is rotated (its
     * old refresh token stops working) and, with `signOutOtherSessions: true` (the default), every other session is
     * revoked. Token and server mode: resolves with `AuthSessionResult`, which becomes the client's session like
     * `signIn`'s, so the client never presents the rotated refresh token again. Cookie mode: resolves with
     * `AuthSessionInfo` (the rotated session is in the cookies). `POST /v1/auth/password/change` with a generated
     * `Idempotency-Key`; customer token required.
     * @param {Schemas["PasswordChangeRequest"]} params
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["AuthSessionResult"] | Schemas["AuthSessionInfo"]>}
     * @throws {ValidationError} `CURRENT_PASSWORD_INCORRECT` (422), `PASSWORD_TOO_WEAK` (422), `VALIDATION_FAILED`
     * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY` (401)
     * @throws {VelexisError} `ACCOUNT_LOCKED` (423 after repeated wrong current passwords)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`, `CSRF_TOKEN_INVALID` (403)
     * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED` (409)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    changePassword: (params, options) =>
      sessionCall(core, op.auth_changePassword, params, options, undefined),

    /**
     * Gets the signed-in customer and the metadata of the current session ("me"); never any token. Cheap: use it to
     * render signed-in UI (`401 UNAUTHENTICATED` means signed out). Personal, so always `no-store` unless the call
     * chooses a cache mode. `GET /v1/auth/session`; customer token required (cookie mode: the session cookie).
     * @param {AuthGetSessionParams} [params]
     * @param {RequestOptions} [options]
     * @returns {Promise<Schemas["AuthSessionInfo"]>}
     * @throws {AuthenticationError} `UNAUTHENTICATED` (render signed-out UI), `TOKEN_EXPIRED` (the SDK refreshes and retries once when it can), `INVALID_API_KEY` (401)
     * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED` (403)
     * @throws {RateLimitError} `RATE_LIMITED` (429)
     * @throws {ServerError} `INTERNAL_ERROR` (500)
     */
    getSession: (params, options) => core.call(op.auth_getSession, params, live(options)),
  };
}
