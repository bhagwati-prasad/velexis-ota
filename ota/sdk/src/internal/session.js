// The session modes of a client (ota/sdk/README.md §4, OADR-0006 points 3 and 5, OADR-0016 points 5 and 6): which
// credentials every request carries, how `fetch` treats cookies, and what happens when the API refuses a call because
// the session expired or the CSRF token is missing. internal/client.js picks the mode once, in `createCore`, and sends
// every call through `session.send`; internal/http.js does the transport (headers, timeouts, retries, errors).
//
// - Cookie mode (`session: "cookie"`, the hosted storefront): no key and no token ever reaches JavaScript. The mode
//   needs `document` and refuses every key, every token and `X-Api-Key` / `Authorization` headers, at construction
//   and per call, with a `TypeError`. `fetch` runs with `credentials: "same-origin"` and `mode: "same-origin"`. Writes
//   (`POST`, `PUT`, `PATCH`, `DELETE`) copy the `__Host-vx_csrf` cookie into `X-CSRF-Token`; without the cookie the
//   session first calls `GET /v1/storefront` (which issues it; with `cache: "no-store"`, since a cached copy sets no
//   cookie), and after `403 CSRF_TOKEN_INVALID` it calls it once more and sends the call once more. `401 TOKEN_EXPIRED` → one `POST /v1/auth/refresh` with an empty body (the
//   refresh token is the `__Host-vx_rt` cookie), then the call once more.
// - Token mode (a publishable key, or no key): `X-Api-Key`, `Authorization: Bearer` and `X-Booking-Token` from the
//   options (token sources are called before every request); `fetch` runs with `credentials: "omit"`.
// - Server mode (a secret or hosting key): the same headers; `fetch` keeps its default `credentials` (a server has no
//   cookie jar, and some edge runtimes refuse the field). `secretKey` is refused where `globalThis.document` exists.
//   `environment` sends `X-Velexis-Environment` on console operations (in any mode; internal/client.js adds it).
//
// Automatic refresh (token and server mode with `refreshToken`, always in cookie mode): a call refused with `401
// TOKEN_EXPIRED` waits for one refresh and is sent once more. Concurrent calls share one refresh (single flight); a call
// whose attempt went out before a refresh that has finished since is sent again without another one. Token and server
// mode refresh through `auth.refresh`, or `console.auth.refresh` with `sessionKind: "staff"`, report the new tokens to
// `onSessionRefreshed` (and the whole staff session to `onStaffSessionRefreshed`), and keep them: from then on the
// session sends the new tokens wherever a token source still gives a rotated one (a string source always does), so a
// rotated refresh token is never presented again by this client (reuse revokes the family). A refresh the API refuses
// with 401 (`REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED` …) calls `onSessionExpired` and throws that
// `AuthenticationError`. The refresh request carries the API key only (never the expired access token), plus the host
// and end user of the call that started it. A call with its own `options.accessToken` (or an `Authorization` header of
// the call or the client, which wins over the session's) is not the client's session and is not refreshed. Hook
// failures are ignored, as `onResponse`'s are.
//
// Session results (token and server mode, SDK-008): what `auth.signIn`, `auth.refresh` and `auth.changePassword`
// resolve with (an `AuthSessionResult` with tokens) becomes the client's session through `adopt`, as an automatic
// refresh's result does: the tokens the client held when the result arrived and the refresh token the call presented
// count as rotated, so the session sends the new tokens wherever a token source still gives a replaced one, and
// `onSessionRefreshed` gets the new tokens. A client without `accessToken` and `refreshToken` keeps nothing: it never
// starts sending a token it was not given, so a server client shared by every visitor holds no visitor's session. A
// call with its own credential (`options.accessToken`, or an `Authorization` header of the call or the client) is not
// the client's session, as for the automatic refresh: its result feeds nothing and calls no hook. Cookie mode stores
// nothing (the session is in httpOnly cookies, and the result carries no token).
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
 * What one call sent with its latest attempt: the session generation (the number of refreshes that had finished) and
 * the access token, read by the refresh that follows a `TOKEN_EXPIRED`.
 * @typedef {{ generation: number, accessToken: string | undefined }} Attempt
 */

/**
 * The session of a client.
 * @typedef {object} Session
 * @property {SessionMode} mode the mode chosen from the options
 * @property {() => Readonly<VelexisClientOptions>} options the client's options, with string tokens the session has
 *   rotated replaced by the current ones (what `withOptions` starts from)
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
/** How many rotated tokens of each kind a session remembers besides the configured strings. */
const ROTATED_TOKENS_KEPT = 16;

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
 * Creates the session of a client from its validated options.
 * @param {Readonly<VelexisClientOptions>} options
 * @param {TransportConfig} transport
 * @returns {Session}
 * @throws {TypeError} when the options do not fit their mode (see `sessionModeOf`)
 */
export function createSession(options, transport) {
  const mode = sessionModeOf(options);
  const fetchInit = FETCH_INIT[mode];
  const key = options.secretKey ?? options.publishableKey ?? options.hostingKey;
  const refreshOperation = options.sessionKind === "staff" ? op.console_auth_refresh : op.auth_refresh;
  /** The number of refreshes that have finished. */
  let generation = 0;
  /** @type {Promise<boolean> | undefined} the refresh in flight */
  let refreshing;
  /** @type {Promise<void> | undefined} the `GET /v1/storefront` in flight that issues the CSRF cookie */
  let fetchingCsrf;
  /** @type {{ accessToken: string, refreshToken: string } | undefined} the tokens of the latest refresh */
  let latest;
  /**
   * Tokens the session has rotated, besides the configured strings, oldest first.
   * @type {{ accessToken: Set<string>, refreshToken: Set<string> }}
   */
  const rotated = { accessToken: new Set(), refreshToken: new Set() };

  /**
   * The token to send for what a source gave: the latest refresh's when the value has been rotated (a string option
   * always has been after a refresh), else the value itself (a function source that moved on).
   * @param {"accessToken" | "refreshToken"} kind
   * @param {string | undefined} value
   * @returns {string | undefined}
   */
  function current(kind, value) {
    if (value === undefined || latest === undefined) {
      return value;
    }
    return value === options[kind] || rotated[kind].has(value) ? latest[kind] : value;
  }

  /**
   * Records the tokens of a refresh or a session result: the ones they replaced are rotated from now on.
   * @param {{ accessToken: (string | undefined)[], refreshToken: (string | undefined)[] }} replaced
   * @param {Schemas["Session"]} tokens
   */
  function rotate(replaced, tokens) {
    for (const kind of /** @type {const} */ (["accessToken", "refreshToken"])) {
      const set = rotated[kind];
      for (const value of replaced[kind]) {
        if (value !== undefined) {
          set.delete(value);
          set.add(value);
        }
      }
      set.delete(tokens[kind]);
      for (const oldest of set) {
        if (set.size <= ROTATED_TOKENS_KEPT) {
          break;
        }
        set.delete(oldest);
      }
    }
    latest = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
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
        attempt.generation = generation;
      }
      return headers;
    }
    if (key !== undefined) {
      headers["X-Api-Key"] = key;
    }
    if (attempt === null) {
      return headers;
    }
    const accessToken =
      requestOptions.accessToken ?? current("accessToken", await tokenOf(options.accessToken, "accessToken"));
    attempt.generation = generation;
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
   * @returns {HttpConfig}
   */
  const configOf = (request, attempt) => ({
    ...transport,
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
   * body when it takes one, and the API key as the only credential.
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
    return sendWithCsrf(configOf(request, null), request);
  }

  /**
   * Gets the CSRF cookie with `GET /v1/storefront`; concurrent calls share one request. The request bypasses the
   * browser's HTTP cache (`cache: "no-store"`): storefront.get is cacheable (`Cache-Control: public, max-age=60`), and
   * a copy from the cache carries no `Set-Cookie`, so only the API can issue the cookie.
   * @param {HttpRequest} request the call that needs the cookie
   * @returns {Promise<void>}
   */
  function fetchCsrf(request) {
    if (fetchingCsrf === undefined) {
      /** @type {Readonly<RequestOptions>} */
      const requestOptions = Object.freeze({ ...forwardedOptionsOf(request.options), cache: "no-store" });
      const started = sendOwn(op.storefront_get, {}, requestOptions).then(() => {});
      fetchingCsrf = started;
      const done = () => {
        if (fetchingCsrf === started) {
          fetchingCsrf = undefined;
        }
      };
      started.then(done, done);
    }
    return untilSettled(fetchingCsrf, request);
  }

  /**
   * One refresh of the session. Resolves `true` once the session has new tokens, `false` when there is no refresh
   * token to present; throws the API's error, after calling `onSessionExpired` when it is a 401.
   * @param {HttpRequest} request the call that started the refresh
   * @param {Attempt} attempt what that call sent
   * @returns {Promise<boolean>}
   */
  async function runRefresh(request, attempt) {
    const requestOptions = forwardedOptionsOf(request.options);
    try {
      if (mode === "cookie") {
        // The refresh token is the __Host-vx_rt cookie; a token in the body is refused (OADR-0006 point 5).
        await sendOwn(op.auth_refresh, {}, requestOptions);
        generation += 1;
        return true;
      }
      const refreshToken = current("refreshToken", await tokenOf(options.refreshToken, "refreshToken"));
      if (refreshToken === undefined) {
        return false;
      }
      const result = await sendOwn(refreshOperation, { refreshToken }, requestOptions);
      const tokens = tokensOf(result);
      rotate({ accessToken: [attempt.accessToken], refreshToken: [refreshToken] }, tokens);
      generation += 1;
      await callHook(options.onSessionRefreshed, tokens);
      if (refreshOperation === op.console_auth_refresh) {
        await callHook(
          options.onStaffSessionRefreshed,
          /** @type {Schemas["ConsoleStaffSession"]} */ (result),
        );
      }
      return true;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        await callHook(options.onSessionExpired);
      }
      throw error;
    }
  }

  /**
   * The refresh after a call failed with `TOKEN_EXPIRED`: joins the refresh in flight, skips it when one has finished
   * since the call's attempt went out, or starts one. Resolves whether the call has a session to be sent again with.
   * @param {HttpRequest} request
   * @param {Attempt} attempt
   * @returns {Promise<boolean>}
   */
  function refresh(request, attempt) {
    if (refreshing === undefined) {
      if (attempt.generation !== generation) {
        return Promise.resolve(true);
      }
      const started = runRefresh(request, attempt);
      refreshing = started;
      const done = () => {
        if (refreshing === started) {
          refreshing = undefined;
        }
      };
      started.then(done, done);
    }
    return untilSettled(refreshing, request);
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
   * The token a source gives now, as the session would send it. A source that throws gives nothing here: the call
   * whose result is being adopted has already succeeded, and its result must reach the caller.
   * @param {"accessToken" | "refreshToken"} kind
   * @returns {Promise<string | undefined>}
   */
  async function held(kind) {
    try {
      return current(kind, await tokenOf(options[kind], kind));
    } catch {
      return undefined;
    }
  }

  /**
   * Makes the tokens of a session result the client's session (token and server mode; see the file header): the
   * tokens the client holds now and the refresh token the call presented are rotated from now on, and
   * `onSessionRefreshed` gets the new tokens. A client without token sources keeps nothing, a staff client
   * (`sessionKind: "staff"`) keeps its staff session (a customer's result is not its session), a call with its own
   * credential changes nothing and calls no hook (its session is not the client's, as for the automatic refresh), and
   * cookie mode has nothing to keep.
   * @param {unknown} result what `auth.signIn`, `auth.refresh` or `auth.changePassword` resolved with
   * @param {string | undefined} presentedRefreshToken the refresh token the call sent (`auth.refresh`)
   * @param {RequestOptions} [requestOptions] the request options the call was sent with
   * @returns {Promise<void>}
   */
  async function adopt(result, presentedRefreshToken, requestOptions) {
    const tokens = mode === "cookie" || options.sessionKind === "staff" ? undefined : sessionTokensOf(result);
    if (tokens === undefined || presentsOwnCredential(requestOptions ?? {})) {
      return;
    }
    if (holdsTokens) {
      const accessToken = await held("accessToken");
      const refreshToken = await held("refreshToken");
      rotate({ accessToken: [accessToken], refreshToken: [refreshToken, presentedRefreshToken] }, tokens);
      generation += 1;
    }
    await callHook(options.onSessionRefreshed, tokens);
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
      if (latest === undefined) {
        return options;
      }
      /** @type {VelexisClientOptions} */
      const copy = { ...options };
      if (typeof options.accessToken === "string") {
        copy.accessToken = latest.accessToken;
      }
      if (typeof options.refreshToken === "string") {
        copy.refreshToken = latest.refreshToken;
      }
      return Object.freeze(copy);
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
      const attempt = { generation, accessToken: undefined };
      const config = configOf(call, attempt);
      try {
        return await sendWithCsrf(config, call);
      } catch (error) {
        if (!isRefusal(error, 401, "TOKEN_EXPIRED") || !refreshes(call)) {
          throw error;
        }
        if (!(await refresh(call, attempt)) || !mayResend(call)) {
          throw error;
        }
      }
      return sendWithCsrf(config, call);
    },
    environmentHeaders,
    adopt,
  };
}
