// The request core of a client (ota/sdk/README.md §3 and §5.1, OADR-0016 points 2 and 5): option validation with
// the contract's defaults, and the core handed to the namespaces. `core.call(op, params, options)` turns the params of
// one SDK method into an HTTP request by its route-table entry (internal/operations.js): names in `pathParams` fill
// the path template (URI-encoded), names in `queryParams` become the query string (arrays comma-separated,
// `undefined` and `null` dropped), `headerParams` become headers (`ifMatch` → `If-Match`, a version number as its
// ETag `"<n>"`), and every other param is the JSON body (or the `multipart/form-data` form; an operation without a
// body ignores them). The generator refuses name collisions, so this split never guesses. A list operation (one with
// a `cursor` query param) resolves with a `Page`. `core.request` is the low-level escape hatch with the same headers,
// retries and error mapping.
//
// The session mode is chosen here, once, from the validated options (internal/session.js, README §4): cookie mode
// (`session: "cookie"`), token mode (a publishable key) or server mode (a secret or hosting key). The session refuses
// the options its mode does not allow, at construction and per call, decides the credentials of every request and
// handles CSRF and the automatic refresh; internal/http.js sends the requests. `environment` adds
// `X-Velexis-Environment` to console operations (the route table's `environment` flag; `/v1/console/…` paths for
// `request`).

import { isPageBody, Page } from "./pagination.js";
import { createSession } from "./session.js";

/** @typedef {import("../shared.js").VelexisClientOptions} VelexisClientOptions */
/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @typedef {import("./operations.js").Operation} Operation */
/** @typedef {import("./operations.js").HttpMethod} HttpMethod */
/** @typedef {import("./http.js").HttpBody} HttpBody */

/** The contract's default base URL (a placeholder host; the contract's doc comment names another, README §5.1). */
export const DEFAULT_BASE_URL = "https://api.ota.example.com";
/** The default base URL of cookie mode: the hosted storefront's same-origin API path (README §5.1). */
export const COOKIE_BASE_URL = "/api";
/** The contract's default timeout per request, in ms. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** The contract's default number of automatic retries. */
export const DEFAULT_MAX_RETRIES = 2;
/** The longest timeout `setTimeout` can wait for (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** The HTTP methods of `request` (index.d.ts `HttpMethod`). */
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Query values `request` accepts (index.d.ts).
 * @typedef {Record<string, string | number | boolean | string[] | undefined>} QueryParams
 */

/**
 * The third argument of `request` (index.d.ts).
 * @typedef {{ query?: QueryParams, body?: unknown, options?: RequestOptions }} RawRequestInit
 */

/**
 * The request core handed to the namespace factories.
 * @typedef {object} Core
 * @property {Readonly<VelexisClientOptions>} options the client's validated options (what `withOptions` starts from),
 *   with string tokens that an automatic refresh has rotated replaced by the current ones
 * @property {"cookie" | "token" | "server"} mode the session mode (README §4)
 * @property {(overrides: unknown) => VelexisClientOptions} derive the options of `withOptions(overrides)`: these
 *   options with the overrides applied (validated when the new client is created); a cookie-mode client cannot be
 *   switched to another mode
 * @property {<T = unknown>(operation: Operation, params?: object, options?: RequestOptions) => Promise<T>} call
 *   one SDK method: params split by the route-table entry; list operations resolve with a `Page`
 * @property {<T = unknown>(method: HttpMethod, path: string, init?: RawRequestInit) => Promise<T>} request
 *   the low-level escape hatch for an API path (`/v1/…`)
 */

/** @param {string} message */
const optionError = (message) => new TypeError(`Velexis SDK: ${message}`);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * A check of one option: throws a `TypeError` naming the option (never its value, which may be a key). `label` is
 * the option as the message names it, for example `option "timeoutMs"` or `request option "timeoutMs"`.
 * @typedef {(value: unknown, label: string) => void} Check
 */

/** @param {string} what @returns {Check} */
const must = (what) => (_value, label) => {
  throw optionError(`${label} must be ${what}`);
};

/** @type {Check} */
const nonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") {
    must("a non-empty string")(value, label);
  }
};

/** @type {Check} */
const aFunction = (value, label) => {
  if (typeof value !== "function") {
    must("a function")(value, label);
  }
};

/** @param {string} prefix @returns {Check} */
const apiKey = (prefix) => (value, label) => {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.length <= prefix.length ||
    /\s/.test(value)
  ) {
    must(`a key that starts with "${prefix}"`)(value, label);
  }
};

/** @type {Check} */
const tokenSource = (value, label) => {
  if (value !== null && typeof value !== "string" && typeof value !== "function") {
    must("a string, null or a function")(value, label);
  }
};

/** @type {Check} */
const timeout = (value, label) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    must(`an integer number of milliseconds from 1 to ${MAX_TIMEOUT_MS}`)(value, label);
  }
};

/** @type {Check} */
const retries = (value, label) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    must("an integer of 0 or more")(value, label);
  }
};

/** @type {Check} */
const currency = (value, label) => {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    must("an ISO 4217 code such as EUR")(value, label);
  }
};

/** @type {Check} */
const headerRecord = (value, label) => {
  if (!isPlainObject(value) || Object.values(value).some((item) => typeof item !== "string")) {
    must("an object of header names to string values")(value, label);
  }
  try {
    new Headers(/** @type {Record<string, string>} */ (value));
  } catch {
    must("an object of valid header names and values")(value, label);
  }
};

/** @type {Check} */
const endUserContext = (value, label) => {
  if (
    !isPlainObject(value) ||
    Object.entries(value).some(
      ([key, item]) => !["ip", "userAgent"].includes(key) || (item !== undefined && typeof item !== "string"),
    )
  ) {
    must("an object with the strings ip and userAgent")(value, label);
  }
};

/** @type {Check} */
const endUserSource = (value, label) => {
  if (typeof value !== "function") {
    endUserContext(value, label);
  }
};

/** @param {readonly string[]} values @returns {Check} */
const oneOf = (values) => (value, label) => {
  if (typeof value !== "string" || !values.includes(value)) {
    must(`one of ${values.map((item) => `"${item}"`).join(", ")}`)(value, label);
  }
};

/** @type {Check} */
const baseUrl = (value, label) => {
  if (typeof value !== "string") {
    must("a string")(value, label);
    return;
  }
  if (value.startsWith("/")) {
    // A browser reads a backslash as a slash, so `/\host` would be another origin, like `//host`.
    if (value.startsWith("//") || /[?#\s\\]/.test(value)) {
      must("an absolute http(s) URL or a same-origin path such as /api")(value, label);
    }
    return;
  }
  /** @type {URL | undefined} */
  let url;
  try {
    url = new URL(value);
  } catch {
    must("an absolute http(s) URL or a same-origin path such as /api")(value, label);
    return;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    must("an http(s) URL without credentials, query or fragment")(value, label);
  }
};

/** @type {Check} */
const abortSignal = (value, label) => {
  const signal = /** @type {{ aborted?: unknown, addEventListener?: unknown } | null} */ (value);
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function"
  ) {
    must("an AbortSignal")(value, label);
  }
};

/** @type {Check} */
const idempotencyKey = (value, label) => {
  if (typeof value !== "string" || value.length < 16 || value.length > 128 || /[^\x21-\x7e]/.test(value)) {
    must("a string of 16 to 128 visible ASCII characters")(value, label);
  }
};

/** @type {Check} */
const anObject = (value, label) => {
  if (!isPlainObject(value)) {
    must("an object")(value, label);
  }
};

/**
 * The checks of every client option (shared.js `VelexisClientOptions`).
 * @satisfies {Record<keyof VelexisClientOptions, Check>}
 */
const CLIENT_OPTIONS = {
  publishableKey: apiKey("pk_"),
  secretKey: apiKey("sk_"),
  baseUrl,
  accessToken: tokenSource,
  bookingToken: tokenSource,
  onSessionRefreshed: aFunction,
  onSessionExpired: aFunction,
  refreshToken: tokenSource,
  locale: nonEmptyString,
  currency,
  fetch: aFunction,
  timeoutMs: timeout,
  maxRetries: retries,
  headers: headerRecord,
  onResponse: aFunction,
  hostingKey: apiKey("hk_"),
  host: nonEmptyString,
  endUser: endUserSource,
  sessionKind: oneOf(["customer", "staff"]),
  onStaffSessionRefreshed: aFunction,
  session: oneOf(["token", "cookie"]),
  environment: oneOf(["test", "live"]),
};

/**
 * The checks of every request option (shared.js `RequestOptions`).
 * @satisfies {Record<keyof RequestOptions, Check>}
 */
const REQUEST_OPTIONS = {
  signal: abortSignal,
  idempotencyKey,
  timeoutMs: timeout,
  headers: headerRecord,
  accessToken: nonEmptyString,
  bookingToken: nonEmptyString,
  locale: nonEmptyString,
  currency,
  next: anObject,
  cache: nonEmptyString,
  endUser: endUserContext,
  host: nonEmptyString,
};

/**
 * Checks options against a table: a plain object whose every defined entry is a known, valid option. Returns a copy
 * without the `undefined` entries, with copies of the nested objects, so the caller's later changes reach nothing.
 * @template {object} T
 * @param {unknown} options
 * @param {Record<string, Check>} checks
 * @param {string} what
 * @returns {T}
 */
function checkOptions(options, checks, what) {
  if (options === undefined) {
    return /** @type {T} */ ({});
  }
  if (!isPlainObject(options)) {
    throw optionError(`${what} must be an object`);
  }
  /** @type {Record<string, unknown>} */
  const copy = {};
  for (const [name, value] of Object.entries(options)) {
    const check = Object.hasOwn(checks, name) ? checks[name] : undefined;
    if (check === undefined) {
      throw optionError(`unknown ${what} "${name}"`);
    }
    if (value !== undefined) {
      check(value, `${what} "${name}"`);
      copy[name] = isPlainObject(value) ? { ...value } : value;
    }
  }
  return /** @type {T} */ (copy);
}

/**
 * Validates the options of `createVelexisClient` (`TypeError` on the first problem, before any request) and returns
 * a frozen copy.
 * @param {unknown} options
 * @returns {Readonly<VelexisClientOptions>}
 */
export function validateClientOptions(options) {
  if (options === undefined) {
    throw optionError("createVelexisClient needs an options object");
  }
  /** @type {VelexisClientOptions} */
  const copy = checkOptions(options, CLIENT_OPTIONS, "option");
  const keys = ["publishableKey", "secretKey", "hostingKey"].filter((name) => Object.hasOwn(copy, name));
  if (keys.length > 1) {
    throw optionError(`set only one of ${keys.map((name) => `"${name}"`).join(", ")}`);
  }
  if (copy.fetch === undefined && typeof globalThis.fetch !== "function") {
    throw optionError('this runtime has no global fetch; pass the "fetch" option');
  }
  return Object.freeze(copy);
}

/**
 * Validates the options of one call (`TypeError` before any request) and returns a frozen copy.
 * @param {unknown} options
 * @returns {Readonly<RequestOptions>}
 */
export function validateRequestOptions(options) {
  /** @type {RequestOptions} */
  const copy = checkOptions(options, REQUEST_OPTIONS, "request option");
  return Object.freeze(copy);
}

/**
 * One query value as text: strings, finite numbers and booleans; `undefined` for nothing to send.
 * @param {string} name
 * @param {unknown} value
 * @returns {string | undefined}
 */
function queryText(name, value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => queryText(name, item)).filter((item) => item !== undefined);
    // Arrays are comma-separated (style form, explode false); each item is encoded, so its own commas stay data.
    return items.length === 0 ? undefined : items.join(",");
  }
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return encodeURIComponent(String(value));
  }
  throw optionError(
    `query parameter "${name}" must be a string, a finite number, a boolean or an array of them`,
  );
}

/**
 * The query string of named values, in the given order, without `?`.
 * @param {Iterable<[string, unknown]>} entries
 * @returns {string}
 */
export function encodeQuery(entries) {
  const parts = [];
  for (const [name, value] of entries) {
    const text = queryText(name, value);
    if (text !== undefined) {
      parts.push(`${encodeURIComponent(name)}=${text}`);
    }
  }
  return parts.join("&");
}

/**
 * The path template of an operation with its path params filled in, URI-encoded.
 * @param {Operation} operation
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
function fillPath(operation, params) {
  let path = operation.path;
  for (const name of operation.pathParams) {
    const value = params[name];
    if (
      !(typeof value === "string" && value !== "") &&
      !(typeof value === "number" && Number.isFinite(value))
    ) {
      throw optionError(`${operation.method} ${operation.path} needs the path parameter "${name}"`);
    }
    // URI encoding keeps `.` and `..`, and the URL would then lead to another path (`/v1/bookings/..` is `/v1/`).
    if (value === "." || value === "..") {
      throw optionError(
        `${operation.method} ${operation.path}: the path parameter "${name}" cannot be "." or ".."`,
      );
    }
    const encoded = encodeURIComponent(String(value));
    path = path.replace(`{${name}}`, () => encoded);
  }
  return path;
}

/**
 * A `multipart/form-data` form of the remaining params: a `Blob` or `File` as a file, strings, numbers and booleans as
 * fields, arrays as repeated fields.
 * @param {[string, unknown][]} entries
 * @returns {FormData}
 */
function formOf(entries) {
  const form = new FormData();
  for (const [name, value] of entries) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null) {
        continue;
      }
      if (item instanceof Blob) {
        form.append(name, item);
      } else if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        form.append(name, String(item));
      } else {
        throw optionError(`form field "${name}" must be a Blob, a string, a number or a boolean`);
      }
    }
  }
  return form;
}

/**
 * Builds the request core of a client.
 * @param {unknown} options the options of `createVelexisClient`
 * @returns {Core}
 * @throws {TypeError} on an invalid option
 */
export function createCore(options) {
  const validated = validateClientOptions(options);
  const defaultBaseUrl = validated.session === "cookie" ? COOKIE_BASE_URL : DEFAULT_BASE_URL;
  const session = createSession(validated, {
    baseUrl: (validated.baseUrl ?? defaultBaseUrl).replace(/\/+$/, ""),
    timeoutMs: validated.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: validated.maxRetries ?? DEFAULT_MAX_RETRIES,
    fetch: validated.fetch,
    locale: validated.locale,
    currency: validated.currency,
    host: validated.host,
    endUser: validated.endUser,
    headers: Object.freeze({ ...validated.headers }),
    onResponse: validated.onResponse,
  });

  /**
   * One SDK method: the params split by the operation's route-table entry.
   * @template [T=unknown]
   * @param {Operation} operation
   * @param {object} [params]
   * @param {RequestOptions} [requestOptions]
   * @returns {Promise<T>}
   */
  async function call(operation, params, requestOptions) {
    const callOptions = validateRequestOptions(requestOptions);
    session.checkCall(callOptions);
    if (params !== undefined && !isPlainObject(params)) {
      throw optionError(`the params of ${operation.method} ${operation.path} must be an object`);
    }
    const values = /** @type {Record<string, unknown>} */ (params ?? {});
    const path = fillPath(operation, values);
    const query = encodeQuery(operation.queryParams.map((name) => [name, values[name]]));
    /** @type {Record<string, string>} */
    const headers = session.environmentHeaders(operation.environment);
    for (const [param, header] of Object.entries(operation.headerParams)) {
      const value = values[param];
      if (value !== undefined && value !== null) {
        // `ifMatch` is the contract's IfMatchValue: a number is the resource `version`, sent as its ETag `"<n>"`; a
        // string is the ETag itself and is sent as it is.
        headers[header] = header === "If-Match" && typeof value === "number" ? `"${value}"` : String(value);
      }
    }
    const used = new Set([
      ...operation.pathParams,
      ...operation.queryParams,
      ...Object.keys(operation.headerParams),
    ]);
    const rest = Object.entries(values).filter(([name]) => !used.has(name));
    /** @type {HttpBody | null} */
    let body = null;
    if (operation.body === "json") {
      body = { kind: "json", value: Object.fromEntries(rest) };
    } else if (operation.body === "multipart") {
      body = { kind: "multipart", value: formOf(rest) };
    }
    const result = await session.send({
      method: operation.method,
      path,
      query,
      headers,
      body,
      idempotency: operation.idempotency,
      retry: operation.retry,
      timeoutMs: operation.timeoutMs,
      options: callOptions,
    });
    if (operation.queryParams.includes("cursor") && isPageBody(result)) {
      return /** @type {T} */ (
        new Page(result, (cursor) => call(operation, { ...values, cursor }, callOptions))
      );
    }
    return /** @type {T} */ (result);
  }

  /**
   * The low-level escape hatch: any API path, with the same headers, retries and error mapping. `GET`, `PUT` and
   * `DELETE` are retried; `POST` and `PATCH` only with the caller's `idempotencyKey` (the SDK cannot know whether the
   * endpoint honours a generated one).
   * @template [T=unknown]
   * @param {HttpMethod} method
   * @param {string} path an API path such as `/v1/storefront`, optionally with a query string
   * @param {RawRequestInit} [init]
   * @returns {Promise<T>}
   */
  async function request(method, path, init) {
    if (!HTTP_METHODS.includes(method)) {
      throw optionError(`request method must be one of ${HTTP_METHODS.join(", ")}`);
    }
    // `//host` and `/\host` (a backslash is a slash to a browser) would leave the base URL's origin.
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[#\s\\]/.test(path)) {
      throw optionError('request path must be an API path that starts with "/", such as /v1/storefront');
    }
    if (init !== undefined && !isPlainObject(init)) {
      throw optionError("request init must be an object");
    }
    const unknown = Object.keys(init ?? {}).find((name) => !["query", "body", "options"].includes(name));
    if (unknown !== undefined) {
      throw optionError(`unknown request init "${unknown}"`);
    }
    // fetch refuses a GET with a body; caught here, it would look like a network error and be retried.
    if (method === "GET" && init?.body !== undefined) {
      throw optionError("a GET request cannot have a body; send its values in query");
    }
    const callOptions = validateRequestOptions(init?.options);
    session.checkCall(callOptions);
    if (init?.query !== undefined && !isPlainObject(init.query)) {
      throw optionError("request query must be an object");
    }
    const [pathname = path, ownQuery = ""] = path.split(/\?(.*)/s);
    const query = [ownQuery, encodeQuery(Object.entries(init?.query ?? {}))]
      .filter((part) => part !== "")
      .join("&");
    const hasKey =
      callOptions.idempotencyKey !== undefined ||
      Object.keys(callOptions.headers ?? {}).some((name) => name.toLowerCase() === "idempotency-key");
    const retry =
      method === "GET" ? "safe" : method === "PUT" || method === "DELETE" || hasKey ? "idempotent" : "never";
    const result = await session.send({
      method,
      path: pathname,
      query,
      headers: session.environmentHeaders(pathname === "/v1/console" || pathname.startsWith("/v1/console/")),
      body: init?.body === undefined ? null : { kind: "json", value: init.body },
      idempotency: "none",
      retry,
      timeoutMs: null,
      options: callOptions,
    });
    return /** @type {T} */ (result);
  }

  /**
   * The options of `withOptions(overrides)`: the current options with the overrides applied.
   * @param {unknown} overrides
   * @returns {VelexisClientOptions}
   */
  function derive(overrides) {
    if (!isPlainObject(overrides)) {
      throw optionError("withOptions needs an options object");
    }
    // `session: undefined` would drop the mode too: validation leaves undefined options out.
    if (
      session.mode === "cookie" &&
      Object.hasOwn(overrides, "session") &&
      overrides["session"] !== "cookie"
    ) {
      throw optionError('withOptions cannot switch a client with session "cookie" to another mode');
    }
    return { ...session.options(), ...overrides };
  }

  return {
    get options() {
      return session.options();
    },
    mode: session.mode,
    derive,
    call,
    request,
  };
}
