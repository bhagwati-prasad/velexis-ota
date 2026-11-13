// The session modes of a client (ota/sdk/README.md §4, OADR-0006 points 3 and 5, OADR-0016 points 5 and 6): which
// credentials every request carries, how `fetch` treats cookies, and what happens when the API refuses a call because
// the session expired or the CSRF token is missing. internal/client.js picks the mode once, in `createCore`, and sends
// every call through `session.send`; internal/http.js does the transport (headers, timeouts, retries, errors).
//
// A family is the client `createVelexisClient` made (its root) and every client derived from it with `withOptions`, at
// any depth (`Family`, `createSession`'s third argument). What the clients of a family share is below; two families
// share nothing.
//
// - Cookie mode (`session: "cookie"`, the hosted storefront): no key and no token ever reaches JavaScript. The mode
//   needs `document` and refuses every key, every token and `X-Api-Key` / `Authorization` headers, at construction
//   and per call, with a `TypeError`. `fetch` runs with `credentials: "same-origin"` and `mode: "same-origin"`. Writes
//   (`POST`, `PUT`, `PATCH`, `DELETE`) copy the `__Host-vx_csrf` cookie into `X-CSRF-Token`; without the cookie the
//   session first calls `GET /v1/storefront` (which issues it; with `cache: "no-store"`, since a cached copy sets no
//   cookie), and after `403 CSRF_TOKEN_INVALID` it calls it once more and sends the call once more. `401 TOKEN_EXPIRED` → one `POST /v1/auth/refresh` with an empty body (the
//   refresh token is the `__Host-vx_rt` cookie), then the call once more. The cookie-mode clients of a family share
//   one refresh state (`RefreshState`: the refresh in flight, the number of finished refreshes and the CSRF re-fetch
//   in flight, SDK-016): they all send the same cookies, and a refresh cookie the API has rotated is refused as
//   reused, which revokes the session's family (OADR-0006), so one family of clients sends one refresh at a time. The
//   refresh and the CSRF fetch go out with the transport settings of the family's root (its `baseUrl`, `maxRetries`,
//   `timeoutMs`, `headers`, `fetch`, `onResponse` and the rest of what `createCore` hands this module; `CookieFamily`,
//   SDK-017), whichever client's call started them, so their outcome never depends on which call came first. A
//   refused refresh calls the `onSessionExpired` of the client whose call started it, once, and rejects every call
//   waiting for it. Everything else (`maxRetries`, `timeoutMs`, `currency`, headers, hooks) stays each client's own
//   for its own calls.
// - Token mode (a publishable key, or no key): `X-Api-Key`, `Authorization: Bearer` and `X-Booking-Token` from the
//   options (token sources are called before every request); `fetch` runs with `credentials: "omit"`.
// - Server mode (a secret or hosting key): the same headers; `fetch` keeps its default `credentials` (a server has no
//   cookie jar, and some edge runtimes refuse the field). `secretKey` is refused where `globalThis.document` exists.
//   `environment` sends `X-Velexis-Environment` on console operations (in any mode; internal/client.js adds it).
//
// Automatic refresh (token and server mode with `refreshToken`, always in cookie mode): a call refused with `401
// TOKEN_EXPIRED` waits for one refresh and is sent once more; a call whose attempt went out before its session moved
// on (in cookie mode: a refresh of the family has finished since; in token and server mode: the client now sends
// another access token than the attempt did) is sent again without another one. In token and server mode the clients
// of a family share refreshes by refresh-token value (SDK-017, lead decision (20f) of 2026-11-13): one refresh in
// flight per refresh token (`Family.refreshing`), which every call of the family that presents that token joins,
// whichever client made it, until the family has recorded the rotation; and the tokens that replaced each refresh
// token the API rotated for a client of the family (`Family.replaced`, the last `FAMILY_TOKENS_KEPT` values, each with
// the time and the order of its rotation). Who takes those tokens instead of presenting a rotated refresh token
// (`resolveRefresh`; lead decision (21d) of 2026-11-13, FIX-W52-SDK):
// - a client that held the value as its own string `refreshToken` before the family recorded its rotation (the string
//   it was made or derived with, or the refresh token it took from a refresh or session result it took part in, or
//   from an earlier rotation it followed), at any later time and along any chain of later rotations, so a client
//   derived before a refresh, or derived with the same string before it, never presents the rotated token;
// - any client, a token function's value included, within `ROTATION_WINDOW_MS` (10 s) of the rotation, the window of
//   the build-your-own-frontend guide's §8.2 (a late request of the same visitor that still carries the old token).
// Any other client that presents a rotated refresh token later (a server's per-request client made with a visitor's
// rotated cookie after the window, a token function that still gives it) sends it to the API as it is: the API's
// reuse detection answers `401 REFRESH_TOKEN_REUSED` and revokes the session, and the SDK reports it as any refused
// refresh. So a stolen rotated refresh token trips the reuse detection instead of reaching the session's newest tokens.
// The family is reached through refresh tokens only. An access token leads to newer tokens only together with the
// refresh token of the same session (`resolveAccess`; lead decision (21e)): a client's own record of the access
// tokens it replaced (`latest` for a string `accessToken`, else `own`) gives the newer access token only when the
// call's refresh-token source gives that session's newest refresh token, or a value that leads to it under the rules
// above; an old access token presented with no refresh token, with another session's or with an unknown one is sent
// as it is (the API answers `401 TOKEN_EXPIRED`), so a client whose token functions serve several visitors never
// turns one visitor's expired access token into a valid one. Everything is keyed by the token's value, so clients with
// different tokens (a server's per-visitor clients, or one client whose token functions give each request's visitor)
// never share a refresh or a token. A token function's value is read before every request (the refresh token's only
// where the access token sent depends on it) and at every refresh. Token and server mode refresh through
// `auth.refresh`, or `console.auth.refresh` with `sessionKind: "staff"`, with the settings, host and end user of the
// client and the call that started the refresh, and the API key only (never the expired access token). The result is
// reported once, by the client whose call started the refresh: its `onSessionRefreshed` gets the new tokens (and its
// `onStaffSessionRefreshed` the whole staff session), or, for a refresh the API refuses with 401
// (`REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED` …), its `onSessionExpired` is called, and every call waiting for
// that refresh throws its `AuthenticationError`. Every client that took part keeps the new tokens: a string source
// sends them from then on; a token function that still gives the tokens they replaced gets the new ones within the
// window (the integrator stores the new tokens through `onSessionRefreshed`). A call with its own
// `options.accessToken` (or an `Authorization` header of the call or the client, which wins over the session's) is not
// the client's session and is not refreshed. Hook failures are ignored, as `onResponse`'s are.
//
// Session results (token and server mode, SDK-008): what `auth.signIn`, `auth.refresh` and `auth.changePassword`
// resolve with (an `AuthSessionResult` with tokens) becomes the client's session through `adopt`, as an automatic
// refresh's result does: the tokens the client held when the result arrived and the refresh token the call presented
// count as replaced for this client, so it sends the new tokens wherever a token source still gives a replaced one
// (a token function within the window; an access token together with the session's refresh token, as above), and
// `onSessionRefreshed` gets the new tokens. A client without `accessToken` and `refreshToken` keeps nothing: it
// never starts sending a token it was not given, so a server client shared by every visitor holds no visitor's
// session. A call with its own credential (`options.accessToken`, or an `Authorization` header of the call or the
// client) is not the client's session, as for the automatic refresh: its result feeds nothing and calls no hook. What
// the API rotated for such a result is also recorded in the family (`noteRotation`, SDK-017) when the client holds
// tokens: the refresh token `auth.refresh` and `console.auth.refresh` presented, and the refresh token of the session
// `auth.changePassword` rotated (the client's own, or the newest the family knows for it when the client presents a
// rotated one as it is), so no client that follows them presents them again; `auth.signIn` rotates nothing, and its
// session stays the calling client's. Cookie mode stores nothing (the session is in httpOnly cookies, and the result
// carries no token).
//
// A call is sent again after `TOKEN_EXPIRED` or `CSRF_TOKEN_INVALID` (the API refused it before doing anything) with
// the same `Idempotency-Key`. The one exception is an operation the route table marks `retry: "never"` although it
// takes a key, the reviewed override of `checkout.completeWithAirlineCard`: its card is sent once per submit (OADR-0017
// point 6), so the session refreshes or re-fetches the CSRF cookie for the next submit and throws the refusal.

import { AuthenticationError, ServerError, VelexisError } from "../shared.js";
import { connectionError } from "./errors.js";
import { send as sendHttp } from "./http.js";
import { uuidV4 } from "./ids.js";
import { op } from "./operations.js";

/** @typedef {import("../shared.js").VelexisClientOptions} VelexisClientOptions */
/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @typedef {import("../shared.js").TokenSource} TokenSource */
/** @typedef {import("../shared.js").Schemas} Schemas */
/** @typedef {import("./http.js").HttpConfig} HttpConfig */
/** @typedef {import("./http.js").HttpRequest} HttpRequest */
/** @typedef {import("./operations.js").Operation} Operation */

/**
 * The session mode: `cookie` (hosted storefront), `token` (publishable key or none), `server` (secret or hosting key).
 * @typedef {"cookie" | "token" | "server"} SessionMode
 */

/**
 * The transport settings of a client, without what the session decides (`credentials`, `fetchInit`).
 * @typedef {Omit<HttpConfig, "credentials" | "fetchInit">} TransportConfig
 */

/**
 * What one call sent with its latest attempt, read by the refresh that follows a `TOKEN_EXPIRED`: in cookie mode the
 * session generation (the number of refreshes of the family that had finished), in token and server mode the access
 * token.
 * @typedef {{ generation: number, accessToken: string | undefined }} Attempt
 */

/**
 * The refresh state of a cookie-mode session: what its calls share so that they send one refresh at a time (single
 * flight). The cookie-mode clients of a family share one (`CookieFamily`, SDK-016); token and server mode share their
 * refreshes by token value through the `Family` instead.
 * @typedef {object} RefreshState
 * @property {number} generation the number of refreshes that have finished
 * @property {Promise<boolean> | undefined} refreshing cookie mode: the refresh in flight
 * @property {Promise<void> | undefined} fetchingCsrf cookie mode: the `GET /v1/storefront` in flight that issues the
 *   CSRF cookie
 */

/**
 * An access token and the refresh token of the same session.
 * @typedef {{ readonly accessToken: string, readonly refreshToken: string }} Tokens
 */

/**
 * One replaced token value: the newest tokens of its session, and when and in which order the value itself was
 * replaced (a later replacement of the tokens it led to changes `tokens` only).
 * @typedef {object} Replacement
 * @property {Tokens} tokens the newest tokens of the session the value led to
 * @property {number} at when the value was replaced (`Date.now()`), for `ROTATION_WINDOW_MS`
 * @property {number} seq the order of the replacement in its record: 1 for the first, then 2, …
 */

/**
 * Which tokens replaced each token value: every replaced token leads to the newest tokens of its session, at most
 * `limit` values, the oldest forgotten first (`createReplacements`). A client's own record holds the access and refresh
 * tokens it replaced; the family's holds refresh tokens only.
 * @typedef {object} Replacements
 * @property {(value: string) => Replacement | undefined} get the replacement of a value, if it was replaced
 * @property {(replaced: (string | undefined)[], tokens: Tokens) => void} record notes that `tokens` replaced the given
 *   values now, and every value that led to one of them
 * @property {() => number} count how many replacements have been recorded (the `seq` of the last one; 0 before any)
 */

/**
 * What the cookie-mode clients of a family share (SDK-016, SDK-017): the refresh state of the session cookies they all
 * send, and the transport settings of the family's root, which the shared refresh and CSRF fetch go out with.
 * @typedef {object} CookieFamily
 * @property {RefreshState} state
 * @property {TransportConfig} transport the transport settings of the family's first cookie-mode client: the root
 *   (`createVelexisClient`), unless the family switched to cookie mode in a derived client
 */

/**
 * What the clients of one family share: the client `createVelexisClient` made and every client derived from it with
 * `withOptions` (`createFamily`; see the file header).
 * @typedef {object} Family
 * @property {CookieFamily | undefined} cookie cookie mode: set by the family's first cookie-mode client
 * @property {Map<string, Promise<Tokens>>} refreshing token and server mode: the refreshes in flight, by the refresh
 *   token they present, until the family has recorded the rotation
 * @property {Replacements} replaced token and server mode: the tokens that replaced each refresh token the API rotated
 *   for a client of the family (automatic refreshes, and the session results of `noteRotation`), with the time and
 *   order of each rotation, keyed by refresh tokens only; who may take them is `resolveRefresh`'s rule (lead decision
 *   (21d) of 2026-11-13)
 */

/**
 * The session of a client.
 * @typedef {object} Session
 * @property {SessionMode} mode the mode chosen from the options
 * @property {() => Readonly<VelexisClientOptions>} options the client's options, with string tokens that have been
 *   replaced (by this client, or, for the client's string refresh token, by a rotation the API made for any client of
 *   the family that this client follows, `resolveRefresh`) replaced by the current ones (what `withOptions` starts
 *   from); a string access token only together with the string refresh token of its session (`resolveAccess`)
 * @property {(options: Readonly<RequestOptions>) => void} checkCall throws a `TypeError` on a per-call option the mode
 *   refuses (cookie mode: tokens and credential headers)
 * @property {(request: HttpRequest) => Promise<unknown>} send sends one call with the mode's credentials, the CSRF
 *   handling and the automatic refresh
 * @property {(takesEnvironment: boolean) => Record<string, string>} environmentHeaders `X-Velexis-Environment` for an
 *   operation that takes it (console operations) when the client has `environment`, else no header
 * @property {(result: unknown, presentedRefreshToken: string | undefined, requestOptions?: RequestOptions) => Promise<void>} adopt
 *   token and server mode: makes the tokens of a session result (`auth.signIn`, `auth.refresh`, `auth.changePassword`)
 *   the client's session and reports them to `onSessionRefreshed`; nothing for a result without tokens, for a call
 *   with its own credential (`requestOptions`) or in cookie mode; never throws (the API has already rotated the
 *   session, so the caller must get the result)
 */

/** The CSRF cookie of cookie mode (OADR-0006 point 2), not httpOnly: its value goes into `X-CSRF-Token`. */
export const CSRF_COOKIE = "__Host-vx_csrf";
/** The methods that change state, so carry `X-CSRF-Token` in cookie mode (OADR-0006 point 3). */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
/** Options refused in cookie mode: every key and every token (OADR-0016 point 5). */
const COOKIE_REFUSED_OPTIONS = /** @type {const} */ ([
  "publishableKey",
  "secretKey",
  "hostingKey",
  "accessToken",
  "refreshToken",
  "bookingToken",
]);
/** Request options refused in cookie mode. */
const COOKIE_REFUSED_CALL_OPTIONS = /** @type {const} */ (["accessToken", "bookingToken"]);
/** Headers refused in cookie mode (client `headers` and per call), by lower-case name. */
const COOKIE_REFUSED_HEADERS = new Map([
  ["x-api-key", "X-Api-Key"],
  ["authorization", "Authorization"],
]);
/** The headers of a call that its refresh or CSRF request carries too, by lower-case name. */
const FORWARDED_HEADERS = ["x-velexis-host", "x-velexis-end-user-ip", "x-velexis-end-user-agent"];
/** The two token options a session can replace. */
const TOKEN_KINDS = /** @type {const} */ (["accessToken", "refreshToken"]);
/** How many replaced token values a client remembers for itself (session results), besides the configured strings. */
const CLIENT_TOKENS_KEPT = 32;
/**
 * How many rotated refresh tokens a family remembers (one per refresh): enough for a page's clients over days of
 * refreshes, and for the concurrent requests of a server's visitors.
 */
export const FAMILY_TOKENS_KEPT = 512;
/**
 * For how long after the API rotated a refresh token any client of the family that presents it still takes the newest
 * tokens of its session instead, in ms, inclusive (lead decision (21d) of 2026-11-13): the 10 s for which the
 * build-your-own-frontend guide's §8.2 sample shares a refresh, for a late request of the same visitor that still
 * carries the old token. After it only a client that held the token as its own string before the rotation follows it
 * (`resolveRefresh`); any other presents it, and the API's reuse detection answers.
 */
export const ROTATION_WINDOW_MS = 10_000;
/** The paths of the operations that rotate the refresh token in their body (`auth.refresh`, `console.auth.refresh`). */
const REFRESH_PATHS = [op.auth_refresh.path, op.console_auth_refresh.path];

/** `fetch` settings per mode. */
const FETCH_INIT = Object.freeze({
  cookie: Object.freeze(/** @type {RequestInit} */ ({ credentials: "same-origin", mode: "same-origin" })),
  token: Object.freeze(/** @type {RequestInit} */ ({ credentials: "omit" })),
  server: Object.freeze(/** @type {RequestInit} */ ({})),
});

/** @param {string} message */
const optionError = (message) => new TypeError(`Velexis SDK: ${message}`);

/** Whether this runtime is a browser page. */
const hasDocument = () => typeof globalThis.document !== "undefined" && globalThis.document !== null;

/**
 * Whether headers set a header, whatever the case of its name.
 * @param {Readonly<Record<string, string>> | undefined} headers
 * @param {string} name the header name in lower case
 */
const hasHeader = (headers, name) => Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name);

/**
 * Throws a `TypeError` when `headers` set `X-Api-Key` or `Authorization` (cookie mode).
 * @param {Readonly<Record<string, string>> | undefined} headers
 * @param {string} label the option, for the message
 */
function refuseCredentialHeaders(headers, label) {
  for (const name of Object.keys(headers ?? {})) {
    const refused = COOKIE_REFUSED_HEADERS.get(name.toLowerCase());
    if (refused !== undefined) {
      throw optionError(
        `${label} cannot set ${refused} with session "cookie"; the browser sends the session cookies`,
      );
    }
  }
}

/**
 * The session mode of validated client options. Throws a `TypeError` for a combination the mode refuses: in cookie
 * mode a key, a token, an `X-Api-Key` or `Authorization` header, or a runtime without `document`; a secret key in a
 * runtime with `document`.
 * @param {Readonly<VelexisClientOptions>} options
 * @returns {SessionMode}
 * @throws {TypeError}
 */
export function sessionModeOf(options) {
  if (options.session === "cookie") {
    for (const name of COOKIE_REFUSED_OPTIONS) {
      if (Object.hasOwn(options, name)) {
        throw optionError(
          `option "${name}" cannot be used with session "cookie"; the browser sends the session cookies`,
        );
      }
    }
    refuseCredentialHeaders(options.headers, 'option "headers"');
    if (!hasDocument()) {
      throw optionError('session "cookie" needs a browser page (document); use a key on servers');
    }
    return "cookie";
  }
  if (options.secretKey !== undefined) {
    if (hasDocument()) {
      throw optionError('option "secretKey" belongs on servers only and cannot be used in a browser page');
    }
    return "server";
  }
  return options.hostingKey === undefined ? "token" : "server";
}

/**
 * The value of a token source: the string, or what its function returns (called before every request).
 * @param {TokenSource} source
 * @param {string} name the option, for the error message
 * @returns {Promise<string | undefined>}
 */
async function tokenOf(source, name) {
  const value = typeof source === "function" ? await source() : source;
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw optionError(`the "${name}" function must return a string, null or undefined`);
  }
  return value === null || value === "" ? undefined : value;
}

/**
 * The value of the `__Host-vx_csrf` cookie, or `undefined` without one (or where cookies cannot be read, such as a
 * sandboxed frame).
 * @returns {string | undefined}
 */
export function readCsrfCookie() {
  /** @type {string} */
  let cookies;
  try {
    cookies = String(globalThis.document?.cookie ?? "");
  } catch {
    return undefined;
  }
  for (const part of cookies.split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === CSRF_COOKIE) {
      const value = part.slice(index + 1).trim();
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

/**
 * Whether an error is the API's refusal with this status and code.
 * @param {unknown} error
 * @param {number} status
 * @param {string} code
 */
const isRefusal = (error, status, code) =>
  error instanceof VelexisError && error.status === status && error.code === code;

/**
 * Whether the session may send a call again after the API refused it before doing anything (`TOKEN_EXPIRED`,
 * `CSRF_TOKEN_INVALID`): every call except one the route table marks `retry: "never"` although it takes an
 * `Idempotency-Key`, which only the reviewed overrides of scripts/operation-overrides.json do (today
 * `checkout.completeWithAirlineCard`, sent once per submit, OADR-0017 point 6).
 * @param {HttpRequest} request
 */
const mayResend = (request) => !(request.retry === "never" && request.idempotency !== "none");

/**
 * The call with its `Idempotency-Key` fixed, so the call sends the same key after a refresh or a CSRF re-fetch as on
 * its first attempt: the caller's key, else a new UUID v4 when the operation takes one.
 * @param {HttpRequest} request
 * @returns {HttpRequest}
 */
function withFixedIdempotencyKey(request) {
  const { options } = request;
  const callerKey = options.idempotencyKey !== undefined || hasHeader(options.headers, "idempotency-key");
  if (request.idempotency === "none" || callerKey) {
    return request;
  }
  return { ...request, options: Object.freeze({ ...options, idempotencyKey: uuidV4() }) };
}

/**
 * The options of a request the session makes for a call (refresh, CSRF cookie): the call's storefront host and end
 * user (`host`, `endUser` and the matching `X-Velexis-*` headers), which the API needs from servers; nothing else of
 * the call (its signal, key or tokens).
 * @param {Readonly<RequestOptions>} options
 * @returns {Readonly<RequestOptions>}
 */
function forwardedOptionsOf(options) {
  /** @type {RequestOptions} */
  const forwarded = {};
  if (options.host !== undefined) {
    forwarded.host = options.host;
  }
  if (options.endUser !== undefined) {
    forwarded.endUser = options.endUser;
  }
  const headers = Object.entries(options.headers ?? {}).filter(([name]) =>
    FORWARDED_HEADERS.includes(name.toLowerCase()),
  );
  if (headers.length > 0) {
    forwarded.headers = Object.fromEntries(headers);
  }
  return Object.freeze(forwarded);
}

/**
 * Waits for a promise the session shares between calls (a refresh, a CSRF re-fetch); the call's signal ends its own
 * wait, not the shared promise.
 * @template T
 * @param {Promise<T>} promise
 * @param {HttpRequest} request
 * @returns {Promise<T>}
 */
function untilSettled(promise, request) {
  const { signal } = request.options;
  if (signal === undefined) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(
        connectionError("ABORTED", `Request aborted (${request.method} ${request.path})`, signal.reason),
      );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Calls a session hook and waits for it. What it throws or rejects with is ignored: the session keeps the new tokens
 * itself, and a storage bug never fails the call.
 * @template {unknown[]} A
 * @param {((...args: A) => void | Promise<void>) | undefined} hook
 * @param {A} args
 */
async function callHook(hook, ...args) {
  if (hook === undefined) {
    return;
  }
  try {
    await hook(...args);
  } catch {
    // Ignored on purpose (see above).
  }
}

/**
 * The tokens of a session result (`AuthSessionResult` or `ConsoleStaffSession`: `session.accessToken` and
 * `session.refreshToken`), or `undefined` when it has none (cookie mode's `AuthSessionInfo`).
 * @param {unknown} result
 * @returns {Schemas["Session"] | undefined}
 */
function sessionTokensOf(result) {
  const session = /** @type {{ session?: Partial<Schemas["Session"]> | null } | null | undefined} */ (result)
    ?.session;
  return typeof session?.accessToken === "string" && typeof session.refreshToken === "string"
    ? /** @type {Schemas["Session"]} */ (session)
    : undefined;
}

/**
 * The tokens of a refresh response (`AuthSessionResult` or `ConsoleStaffSession`: `session.accessToken` and
 * `session.refreshToken`).
 * @param {unknown} result
 * @returns {Schemas["Session"]}
 * @throws {ServerError} when the response has no tokens
 */
function tokensOf(result) {
  const session = sessionTokensOf(result);
  if (session === undefined) {
    throw new ServerError({
      code: "INTERNAL_ERROR",
      message: "The API answered the session refresh without tokens",
      status: 200,
      requestId: null,
    });
  }
  return session;
}

/**
 * The two tokens of a session, nothing else of it (what a session and its family keep).
 * @param {Tokens} session a `Session` of the API, or tokens
 * @returns {Tokens}
 */
const pairOf = (session) =>
  Object.freeze({ accessToken: session.accessToken, refreshToken: session.refreshToken });

/**
 * Whether a token value is there.
 * @param {string | undefined} value
 * @returns {value is string}
 */
const isToken = (value) => value !== undefined;

/**
 * Whether a replacement happened at most `ROTATION_WINDOW_MS` ago. A clock that went back gives a negative age, which
 * counts as outside: the window never grows.
 * @param {Replacement} replacement
 */
function withinWindow(replacement) {
  const age = Date.now() - replacement.at;
  return age >= 0 && age <= ROTATION_WINDOW_MS;
}

/**
 * A record of which tokens replaced each token value (`Replacements`). A value leads straight to the newest tokens of
 * its session: when tokens are replaced again, every value that led to them leads to the new ones, and keeps the time
 * and order of its own replacement. Keys are token values, so the tokens of one session are never reached from another
 * session's token.
 * @param {number} limit how many replaced values it keeps; the oldest are forgotten first
 * @returns {Replacements}
 */
function createReplacements(limit) {
  /** @type {Map<string, Replacement>} */
  const newest = new Map();
  let count = 0;
  return {
    get: (value) => newest.get(value),
    count: () => count,
    record(replaced, tokens) {
      const values = new Set(
        replaced
          .filter(isToken)
          .filter((value) => value !== tokens.accessToken && value !== tokens.refreshToken),
      );
      if (values.size === 0) {
        return;
      }
      const pair = pairOf(tokens);
      for (const [value, known] of newest) {
        if (values.has(known.tokens.accessToken) || values.has(known.tokens.refreshToken)) {
          newest.set(value, Object.freeze({ ...known, tokens: pair }));
        }
      }
      count += 1;
      /** @type {Replacement} */
      const replacement = Object.freeze({ tokens: pair, at: Date.now(), seq: count });
      for (const value of values) {
        newest.delete(value);
        newest.set(value, replacement);
      }
      newest.delete(pair.accessToken);
      newest.delete(pair.refreshToken);
      for (const value of newest.keys()) {
        if (newest.size <= limit) {
          break;
        }
        newest.delete(value);
      }
    },
  };
}

/**
 * A new family: what `createVelexisClient` starts, and every client derived from its client with `withOptions` joins.
 * @returns {Family}
 */
export function createFamily() {
  return { cookie: undefined, refreshing: new Map(), replaced: createReplacements(FAMILY_TOKENS_KEPT) };
}

/**
 * Creates the session of a client from its validated options.
 * @param {Readonly<VelexisClientOptions>} options
 * @param {TransportConfig} transport
 * @param {Family} family the family of the client (`createFamily` for the root, the parent's for `withOptions`)
 * @returns {Session}
 * @throws {TypeError} when the options do not fit their mode (see `sessionModeOf`)
 */
export function createSession(options, transport, family) {
  const mode = sessionModeOf(options);
  const fetchInit = FETCH_INIT[mode];
  const key = options.secretKey ?? options.publishableKey ?? options.hostingKey;
  const refreshOperation = options.sessionKind === "staff" ? op.console_auth_refresh : op.auth_refresh;
  /** @type {RefreshState} */
  let state = { generation: 0, refreshing: undefined, fetchingCsrf: undefined };
  /** The transport settings of the requests the session makes itself (refresh, CSRF cookie). */
  let ownRequests = transport;
  if (mode === "cookie") {
    family.cookie ??= { state, transport };
    ({ state, transport: ownRequests } = family.cookie);
  }
  /** @type {Tokens | undefined} the newest tokens of this client's session (a refresh, a session result) */
  let latest;
  /**
   * The family's count of rotations (`Replacements.count`) when this client began to hold the refresh token it holds
   * as its own string: `latest.refreshToken` since the client took it, else the configured string since the client was
   * made or derived. A rotation of that value recorded later (a greater `seq`) is followed at any time
   * (`resolveRefresh`).
   */
  let heldSince = family.replaced.count();
  /**
   * The tokens that replaced token values of this client's own: the access and refresh tokens its calls sent before a
   * refresh they took part in, and those a session result replaced (see `adopt`). Per client, so the access tokens in
   * it never reach another client.
   */
  const own = createReplacements(CLIENT_TOKENS_KEPT);

  /**
   * Makes tokens this client's newest: from a refresh it started or joined, a session result, or a rotation of the
   * family it follows (`resolveRefresh`). The values the client's call sent (`replaced`) lead to them from now on, for
   * this client only, and the client holds their refresh token from now on.
   * @param {Tokens} tokens
   * @param {(string | undefined)[]} replaced
   */
  function take(tokens, replaced) {
    own.record(replaced, tokens);
    latest = pairOf(tokens);
    heldSince = family.replaced.count();
  }

  /**
   * The refresh token to present for what the refresh-token source gave, and the newest tokens of its session when
   * the client takes them instead of presenting a replaced value (`newer`; lead decision (21d) of 2026-11-13, see the
   * file header):
   * - a string `refreshToken`: the client's own session (`latest`, else the string); a rotation of that value that the
   *   family recorded after the client began to hold it (`heldSince`) is followed at any later time, another one within
   *   `ROTATION_WINDOW_MS` of it, and a followed rotation becomes the client's session (`take`);
   * - a token function's value: the family's rotation of it within the window only; for a value the family never
   *   rotated (one a session result replaced), this client's own replacement of it within the window, then the
   *   family's rotation of that one within its window.
   * Anything else is presented as it is: a rotated one is refused by the API as reused. Synchronous, so a caller that
   * has read the sources decides without another await.
   * @param {string | undefined} value what the source gave
   * @returns {{ refreshToken: string | undefined, newer: Tokens | undefined }}
   */
  function resolveRefresh(value) {
    if (value === undefined) {
      return { refreshToken: undefined, newer: undefined };
    }
    const ownString = value === options.refreshToken;
    let held = value;
    /** @type {Tokens | undefined} */
    let newer;
    if (ownString) {
      held = latest?.refreshToken ?? value;
    } else if (family.replaced.get(value) === undefined) {
      const mine = own.get(value);
      if (mine !== undefined && withinWindow(mine)) {
        newer = mine.tokens;
        held = newer.refreshToken;
      }
    }
    const rotation = family.replaced.get(held);
    if (rotation === undefined || !((ownString && rotation.seq > heldSince) || withinWindow(rotation))) {
      return { refreshToken: held, newer };
    }
    if (ownString) {
      take(rotation.tokens, []);
    }
    return { refreshToken: rotation.tokens.refreshToken, newer: rotation.tokens };
  }

  /**
   * The access token to send for what the access-token source gave, with the refresh token the call presents
   * (`resolveRefresh`; lead decision (21e) of 2026-11-13): the newer access token of the session this client replaced
   * the value in (`latest` for its string `accessToken`, else its own record), followed to that session's newest
   * tokens, only when `refreshToken` is that session's newest refresh token; else the value as it is. So an old access
   * token never leads to newer tokens without the same session's refresh token: alone, with another session's refresh
   * token or with an unknown one it is sent as it is.
   * @param {string | undefined} value what the source gave
   * @param {string | undefined} refreshToken the refresh token the call presents
   * @returns {string | undefined}
   */
  function resolveAccess(value, refreshToken) {
    if (value === undefined || refreshToken === undefined) {
      return value;
    }
    const replacement = (value === options.accessToken ? latest : undefined) ?? own.get(value)?.tokens;
    if (replacement === undefined) {
      return value;
    }
    const newest = family.replaced.get(replacement.refreshToken)?.tokens ?? replacement;
    return newest.refreshToken === refreshToken ? newest.accessToken : value;
  }

  /**
   * Whether this client may send another access token than its source gives for `value`: it replaced the value
   * (`resolveAccess`).
   * @param {string} value
   */
  const replaces = (value) =>
    (value === options.accessToken && latest !== undefined) || own.get(value) !== undefined;

  /**
   * The access token a call of the client's session sends now: what the access-token source gives, as
   * `resolveAccess` replaces it for the refresh token the call would present. A string refresh token is resolved
   * before every request (so the client follows its family's rotations from its next call on); a refresh-token
   * function is read only when this client replaced the access token, so its result can change what is sent.
   * @returns {Promise<string | undefined>}
   */
  async function sessionAccessToken() {
    const value = await tokenOf(options.accessToken, "accessToken");
    if (typeof options.refreshToken === "string") {
      return resolveAccess(value, resolveRefresh(options.refreshToken).refreshToken);
    }
    if (value === undefined || !replaces(value)) {
      return value;
    }
    const refreshValue = await tokenOf(options.refreshToken, "refreshToken");
    return resolveAccess(value, resolveRefresh(refreshValue).refreshToken);
  }

  /**
   * The credential headers of each attempt of a request, asked by the transport before the attempt.
   * @param {HttpRequest} request
   * @param {Attempt | null} attempt where a call notes what it sent; `null` for the session's own requests, which
   *   carry the API key only (a refresh must not present the expired access token)
   * @returns {HttpConfig["credentials"]}
   */
  const credentialsOf = (request, attempt) => async (requestOptions) => {
    /** @type {Record<string, string>} */
    const headers = {};
    if (mode === "cookie") {
      const csrf = WRITE_METHODS.includes(request.method) ? readCsrfCookie() : undefined;
      if (csrf !== undefined) {
        headers["X-CSRF-Token"] = csrf;
      }
      if (attempt !== null) {
        attempt.generation = state.generation;
      }
      return headers;
    }
    if (key !== undefined) {
      headers["X-Api-Key"] = key;
    }
    if (attempt === null) {
      return headers;
    }
    const accessToken = requestOptions.accessToken ?? (await sessionAccessToken());
    attempt.generation = state.generation;
    attempt.accessToken = accessToken;
    if (accessToken !== undefined) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }
    const bookingToken = requestOptions.bookingToken ?? (await tokenOf(options.bookingToken, "bookingToken"));
    if (bookingToken !== undefined) {
      headers["X-Booking-Token"] = bookingToken;
    }
    return headers;
  };

  /**
   * The transport settings of one request.
   * @param {HttpRequest} request
   * @param {Attempt | null} attempt
   * @param {TransportConfig} [settings] the client's own, or, for the session's own requests, `ownRequests`
   * @returns {HttpConfig}
   */
  const configOf = (request, attempt, settings = transport) => ({
    ...settings,
    fetchInit,
    credentials: credentialsOf(request, attempt),
  });

  /**
   * Sends a request through the transport; in cookie mode a write first gets the CSRF cookie when it is missing, and
   * after `403 CSRF_TOKEN_INVALID` the cookie is fetched once more and the request sent once more.
   * @param {HttpConfig} config
   * @param {HttpRequest} request
   * @returns {Promise<unknown>}
   */
  async function sendWithCsrf(config, request) {
    if (mode !== "cookie" || !WRITE_METHODS.includes(request.method)) {
      return sendHttp(config, request);
    }
    if (readCsrfCookie() === undefined) {
      await fetchCsrf(request);
    }
    try {
      return await sendHttp(config, request);
    } catch (error) {
      if (!isRefusal(error, 403, "CSRF_TOKEN_INVALID")) {
        throw error;
      }
      await fetchCsrf(request);
      if (!mayResend(request)) {
        throw error;
      }
    }
    return sendHttp(config, request);
  }

  /**
   * One request the session makes itself (the refresh, the CSRF cookie): the operation's route-table entry with a JSON
   * body when it takes one, and the API key as the only credential. It goes out with `ownRequests`: in cookie mode the
   * family root's transport settings, whichever client's call needs it (SDK-017); in token and server mode this
   * client's own.
   * @param {Operation} operation
   * @param {Record<string, unknown>} body
   * @param {Readonly<RequestOptions>} requestOptions
   * @returns {Promise<unknown>}
   */
  function sendOwn(operation, body, requestOptions) {
    const request = withFixedIdempotencyKey({
      method: operation.method,
      path: operation.path,
      query: "",
      headers: environmentHeaders(operation.environment),
      body: operation.body === "json" ? { kind: "json", value: body } : null,
      idempotency: operation.idempotency,
      retry: operation.retry,
      timeoutMs: operation.timeoutMs,
      options: requestOptions,
    });
    return sendWithCsrf(configOf(request, null, ownRequests), request);
  }

  /**
   * Gets the CSRF cookie with `GET /v1/storefront`; concurrent calls share one request (in cookie mode those of every
   * client of the family too). The request bypasses the browser's HTTP cache (`cache: "no-store"`): storefront.get is
   * cacheable (`Cache-Control: public, max-age=60`), and a copy from the cache carries no `Set-Cookie`, so only the API
   * can issue the cookie.
   * @param {HttpRequest} request the call that needs the cookie
   * @returns {Promise<void>}
   */
  function fetchCsrf(request) {
    if (state.fetchingCsrf === undefined) {
      /** @type {Readonly<RequestOptions>} */
      const requestOptions = Object.freeze({ ...forwardedOptionsOf(request.options), cache: "no-store" });
      const started = sendOwn(op.storefront_get, {}, requestOptions).then(() => {});
      state.fetchingCsrf = started;
      const done = () => {
        if (state.fetchingCsrf === started) {
          state.fetchingCsrf = undefined;
        }
      };
      started.then(done, done);
    }
    return untilSettled(state.fetchingCsrf, request);
  }

  /**
   * Cookie mode: one refresh of the session cookies, the one of every client of the family. It goes out with the
   * family root's transport settings (`sendOwn`) and calls this client's `onSessionExpired` when the API refuses it
   * with a 401. Resolves `true` once the session has new cookies; throws the API's error.
   * @param {HttpRequest} request the call that started the refresh
   * @returns {Promise<boolean>}
   */
  async function runCookieRefresh(request) {
    try {
      // The refresh token is the __Host-vx_rt cookie; a token in the body is refused (OADR-0006 point 5).
      await sendOwn(op.auth_refresh, {}, forwardedOptionsOf(request.options));
      state.generation += 1;
      return true;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        await callHook(options.onSessionExpired);
      }
      throw error;
    }
  }

  /**
   * Cookie mode: the refresh after a call failed with `TOKEN_EXPIRED`: joins the family's refresh in flight, skips it
   * when one has finished since the call's attempt went out, or starts one. Resolves whether the call has a session to
   * be sent again with.
   * @param {HttpRequest} request
   * @param {Attempt} attempt
   * @returns {Promise<boolean>}
   */
  function refreshCookies(request, attempt) {
    if (state.refreshing === undefined) {
      if (attempt.generation !== state.generation) {
        return Promise.resolve(true);
      }
      const started = runCookieRefresh(request);
      state.refreshing = started;
      const done = () => {
        if (state.refreshing === started) {
          state.refreshing = undefined;
        }
      };
      started.then(done, done);
    }
    return untilSettled(state.refreshing, request);
  }

  /**
   * Token and server mode: one refresh of a refresh token, started by this client's call. It goes out with this
   * client's settings, records in the family that the new tokens replaced the refresh token presented (and then calls
   * `recorded`), and reports them to this client's `onSessionRefreshed` (and `onStaffSessionRefreshed`), once for every
   * client that waits for it; a 401 calls this client's `onSessionExpired`, once, and the error reaches every waiting
   * call. Every waiting call, this one's included, takes the new tokens (`refreshTokens`).
   * @param {HttpRequest} request the call that started the refresh
   * @param {string} presented the refresh token to present
   * @param {() => void} recorded called once the family has recorded the rotation, before the hooks
   * @returns {Promise<Tokens>}
   */
  async function runRefresh(request, presented, recorded) {
    try {
      const result = await sendOwn(
        refreshOperation,
        { refreshToken: presented },
        forwardedOptionsOf(request.options),
      );
      const session = tokensOf(result);
      const tokens = pairOf(session);
      family.replaced.record([presented], tokens);
      recorded();
      await callHook(options.onSessionRefreshed, session);
      if (refreshOperation === op.console_auth_refresh) {
        await callHook(
          options.onStaffSessionRefreshed,
          /** @type {Schemas["ConsoleStaffSession"]} */ (result),
        );
      }
      return tokens;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        await callHook(options.onSessionExpired);
      }
      throw error;
    }
  }

  /**
   * Starts the refresh of a refresh token as the family's refresh of it in flight (`Family.refreshing`), which every
   * call of the family that presents the token joins until the family has recorded the rotation. From then on a call
   * that presents the token follows the rotation or presents it as `resolveRefresh` decides, and never joins the
   * refresh that rotated it (whose hooks may still be running).
   * @param {HttpRequest} request the call that starts the refresh
   * @param {string} presented the refresh token to present
   * @returns {Promise<Tokens>}
   */
  function startRefresh(request, presented) {
    // `runRefresh` calls `leave` only after its first await, once `started` is set.
    const leave = () => {
      if (family.refreshing.get(presented) === started) {
        family.refreshing.delete(presented);
      }
    };
    const started = runRefresh(request, presented, leave);
    family.refreshing.set(presented, started);
    started.then(leave, leave);
    return started;
  }

  /**
   * Token and server mode: the refresh after a call failed with `TOKEN_EXPIRED` (see the file header). Reads the
   * client's refresh token and then its access token as they are now, and sends the call again without a refresh when
   * the client now sends another access token than the attempt did (it took newer tokens, or its source moved on);
   * else takes the newer tokens of the session its refresh token leads to (`resolveRefresh`: a rotation the client
   * follows), or presents the refresh token `resolveRefresh` gives: joins the family's refresh of it in flight, or
   * starts it. Resolves whether the call has a session to be sent again with (`false` when the source gives no refresh
   * token). Everything is decided by the values this call's sources give, so calls of one client for two visitors
   * (token functions that read each request's visitor) never decide for each other.
   * @param {HttpRequest} request
   * @param {Attempt} attempt
   * @returns {Promise<boolean>}
   */
  async function refreshTokens(request, attempt) {
    // The refresh token first: a source that moves on between the two reads gives the new access token, which ends
    // here without a refresh.
    const refreshValue = await tokenOf(options.refreshToken, "refreshToken");
    const accessValue = await tokenOf(options.accessToken, "accessToken");
    // From here on nothing awaits until the refresh is taken, found or registered, so a refresh that finished while
    // the sources answered is seen, and two calls never start two refreshes of one token.
    const { refreshToken: held, newer } = resolveRefresh(refreshValue);
    if (resolveAccess(accessValue, held) !== attempt.accessToken) {
      return true;
    }
    if (held === undefined) {
      return false;
    }
    if (newer !== undefined && newer.accessToken !== attempt.accessToken) {
      take(newer, [attempt.accessToken, refreshValue]);
      return true;
    }
    const flight = family.refreshing.get(held) ?? startRefresh(request, held);
    take(await untilSettled(flight, request), [attempt.accessToken, refreshValue, held]);
    return true;
  }

  /**
   * Whether a call presents a credential of its own instead of the session's access token: `options.accessToken`, or
   * an `Authorization` header of the call or the client (which wins over the session's). Such a call is not the
   * client's session: it is not refreshed, and its session result does not become the client's session.
   * @param {Readonly<RequestOptions>} requestOptions
   */
  const presentsOwnCredential = (requestOptions) =>
    requestOptions.accessToken !== undefined ||
    hasHeader(requestOptions.headers, "authorization") ||
    hasHeader(transport.headers, "authorization");

  /**
   * Whether a call that failed with `TOKEN_EXPIRED` is refreshed: always in cookie mode; in token and server mode when
   * the client has a refresh token and the call sent the session's access token, not its own.
   * @param {HttpRequest} request
   */
  const refreshes = (request) =>
    mode === "cookie" ||
    (options.refreshToken !== undefined &&
      options.refreshToken !== null &&
      !presentsOwnCredential(request.options));

  /** Whether the client has token sources of its own, which a session result can replace. */
  const holdsTokens = [options.accessToken, options.refreshToken].some(
    (source) => source !== undefined && source !== null,
  );

  /**
   * The value a token source gives now; a source that throws gives nothing here: the call whose result is being
   * adopted has already succeeded, and its result must reach the caller.
   * @param {"accessToken" | "refreshToken"} kind
   * @returns {Promise<string | undefined>}
   */
  async function sourceValue(kind) {
    try {
      return await tokenOf(options[kind], kind);
    } catch {
      return undefined;
    }
  }

  /**
   * The tokens the client holds now: what its sources give, and what the session sends and presents for them
   * (`resolveRefresh`, `resolveAccess`).
   * @returns {Promise<{ accessValue: string | undefined, accessToken: string | undefined, refreshValue: string | undefined, refreshToken: string | undefined }>}
   */
  async function heldTokens() {
    const refreshValue = await sourceValue("refreshToken");
    const accessValue = await sourceValue("accessToken");
    const { refreshToken } = resolveRefresh(refreshValue);
    return { accessValue, accessToken: resolveAccess(accessValue, refreshToken), refreshValue, refreshToken };
  }

  /**
   * Records in the family which refresh token a call the API answered with a rotated session replaced (token and
   * server mode, a client that holds tokens; see the file header): for `auth.refresh` and `console.auth.refresh` the
   * refresh token in their body, for `auth.changePassword` of a customer client the session's current refresh token:
   * the client's own, or the newest the family knows for it (unless the call presents its own credential, whose session
   * is not the client's). So no client that follows a rotation presents a replaced refresh token again. `auth.signIn`
   * and every other call rotate nothing. Never throws: the call has succeeded.
   * @param {HttpRequest} request
   * @param {unknown} result
   * @returns {Promise<void>}
   */
  async function noteRotation(request, result) {
    if (mode === "cookie" || !holdsTokens || request.method !== "POST") {
      return;
    }
    const session = sessionTokensOf(result);
    if (session === undefined) {
      return;
    }
    if (REFRESH_PATHS.includes(request.path)) {
      const body = request.body?.kind === "json" ? request.body.value : undefined;
      const presented = /** @type {{ refreshToken?: unknown } | null | undefined} */ (body)?.refreshToken;
      if (typeof presented === "string") {
        family.replaced.record([presented], pairOf(session));
      }
    } else if (
      request.path === op.auth_changePassword.path &&
      options.sessionKind !== "staff" &&
      !presentsOwnCredential(request.options)
    ) {
      // The API rotated the session's current refresh token: the newest one the family knows for the token the client
      // holds. A rotated token this client presents as it is (`resolveRefresh`) is never recorded again, so its own
      // rotation keeps its time and order, and its window does not open again.
      const held = (await heldTokens()).refreshToken;
      const current =
        held === undefined ? undefined : (family.replaced.get(held)?.tokens.refreshToken ?? held);
      family.replaced.record([current], pairOf(session));
    }
  }

  /**
   * Makes the tokens of a session result the client's session (token and server mode; see the file header): the
   * tokens the client holds now and the refresh token the call presented are replaced for this client from now on,
   * and `onSessionRefreshed` gets the new tokens. A client without token sources keeps nothing, a staff client
   * (`sessionKind: "staff"`) keeps its staff session (a customer's result is not its session), a call with its own
   * credential changes nothing and calls no hook (its session is not the client's, as for the automatic refresh), and
   * cookie mode has nothing to keep. What the API rotated is recorded in the family by `noteRotation`, not here.
   * @param {unknown} result what `auth.signIn`, `auth.refresh` or `auth.changePassword` resolved with
   * @param {string | undefined} presentedRefreshToken the refresh token the call sent (`auth.refresh`)
   * @param {RequestOptions} [requestOptions] the request options the call was sent with
   * @returns {Promise<void>}
   */
  async function adopt(result, presentedRefreshToken, requestOptions) {
    const session =
      mode === "cookie" || options.sessionKind === "staff" ? undefined : sessionTokensOf(result);
    if (session === undefined || presentsOwnCredential(requestOptions ?? {})) {
      return;
    }
    if (holdsTokens) {
      const held = await heldTokens();
      take(session, [
        held.accessValue,
        held.accessToken,
        held.refreshValue,
        held.refreshToken,
        presentedRefreshToken,
      ]);
    }
    await callHook(options.onSessionRefreshed, session);
  }

  /**
   * `X-Velexis-Environment` for an operation that takes it (console operations), when the client has `environment`.
   * @param {boolean} takesEnvironment
   * @returns {Record<string, string>}
   */
  function environmentHeaders(takesEnvironment) {
    return takesEnvironment && options.environment !== undefined
      ? { "X-Velexis-Environment": options.environment }
      : {};
  }

  return {
    mode,
    options() {
      // A string access token is replaced only together with the string refresh token of its session.
      const refreshToken =
        typeof options.refreshToken === "string"
          ? resolveRefresh(options.refreshToken).refreshToken
          : undefined;
      const now = {
        refreshToken,
        accessToken:
          typeof options.accessToken === "string"
            ? resolveAccess(options.accessToken, refreshToken)
            : undefined,
      };
      /** @type {VelexisClientOptions} */
      const copy = { ...options };
      let replaced = false;
      for (const kind of TOKEN_KINDS) {
        if (now[kind] !== undefined && now[kind] !== options[kind]) {
          copy[kind] = now[kind];
          replaced = true;
        }
      }
      return replaced ? Object.freeze(copy) : options;
    },
    checkCall(requestOptions) {
      if (mode !== "cookie") {
        return;
      }
      for (const name of COOKIE_REFUSED_CALL_OPTIONS) {
        if (requestOptions[name] !== undefined) {
          throw optionError(
            `request option "${name}" cannot be used with session "cookie"; the browser sends the session cookies`,
          );
        }
      }
      refuseCredentialHeaders(requestOptions.headers, 'request option "headers"');
    },
    async send(request) {
      const call = withFixedIdempotencyKey(request);
      /** @type {Attempt} */
      const attempt = { generation: state.generation, accessToken: undefined };
      const config = configOf(call, attempt);
      /** @type {unknown} */
      let result;
      try {
        result = await sendWithCsrf(config, call);
      } catch (error) {
        if (!isRefusal(error, 401, "TOKEN_EXPIRED") || !refreshes(call)) {
          throw error;
        }
        const refreshed = mode === "cookie" ? refreshCookies(call, attempt) : refreshTokens(call, attempt);
        if (!(await refreshed) || !mayResend(call)) {
          throw error;
        }
        result = await sendWithCsrf(config, call);
      }
      await noteRotation(call, result);
      return result;
    },
    environmentHeaders,
    adopt,
  };
}
