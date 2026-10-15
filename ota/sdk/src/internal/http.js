// The transport of every SDK call (ota/sdk/README.md §5.3, OADR-0016 point 6): headers, `fetch`, timeouts linked to the
// caller's signal, retries with back-off and `Retry-After`, the idempotency key of a call, response parsing and the
// `onResponse` hook. internal/client.js turns a method's params into an `HttpRequest`; this module sends it.
//
// Retry rules (README §5.3):
// - only requests whose retry class is `safe` (GET) or `idempotent` (PUT, DELETE, an `Idempotency-Key`, or a POST the
//   document marks `x-idempotent-by-design`) are retried; `never` (`checkout.completeWithAirlineCard`, a POST or PATCH
//   without a key) is never retried, whatever `maxRetries` says;
// - at most `maxRetries` times, on 429, 503, 504 and network errors; never after a client-side timeout or an abort;
// - the n-th retry waits 0.5 s × 2^(n-1), capped at 8 s, ± 20 % jitter; a `Retry-After` header replaces that wait,
//   and a `Retry-After` above 30 s ends the call at once with the response's error (`RateLimitError` for a 429);
// - one `Idempotency-Key` per call, the same on every retry of that call.

import { ServerError } from "../shared.js";
import { connectionError, errorFromResponse, parseRetryAfter } from "./errors.js";
import { uuidV4 } from "./ids.js";

/** @typedef {import("../shared.js").RequestOptions} RequestOptions */
/** @typedef {import("../shared.js").ResponseInfo} ResponseInfo */
/** @typedef {import("../shared.js").EndUserSource} EndUserSource */
/** @typedef {import("../shared.js").EndUserContext} EndUserContext */
/** @typedef {import("../shared.js").VelexisError} VelexisError */
/** @typedef {import("./operations.js").HttpMethod} HttpMethod */

/**
 * The client settings the transport reads, validated by internal/client.js.
 * @typedef {object} HttpConfig
 * @property {string} baseUrl the API base URL without a trailing slash (`https://…` or a same-origin path such as `/api`)
 * @property {number} timeoutMs the client's timeout per request
 * @property {number} maxRetries the client's retry budget per call
 * @property {typeof fetch | undefined} fetch a custom fetch; `globalThis.fetch` (looked up per request) when undefined
 * @property {string | undefined} locale the default `Accept-Language`
 * @property {string | undefined} currency the default `X-Currency`
 * @property {string | undefined} host the default `X-Velexis-Host`
 * @property {EndUserSource | undefined} endUser the default `X-Velexis-End-User-IP` / `-Agent`
 * @property {Readonly<Record<string, string>>} headers extra headers of every request
 * @property {((info: ResponseInfo) => void) | undefined} onResponse called for every response
 * @property {(options: RequestOptions) => Promise<Record<string, string>>} credentials the headers that identify
 *   the caller (`X-Api-Key`, `Authorization`, `X-Booking-Token`), asked before every attempt
 * @property {RequestInit} fetchInit `fetch` settings of the session mode (`credentials`, `mode`)
 */

/**
 * A request body: a JSON value, or a `multipart/form-data` form.
 * @typedef {{ kind: "json", value: unknown } | { kind: "multipart", value: FormData }} HttpBody
 */

/**
 * One call, ready to send.
 * @typedef {object} HttpRequest
 * @property {HttpMethod} method the HTTP method
 * @property {string} path the API path with its parameters filled in (`/v1/bookings/bkg_1`)
 * @property {string} query the encoded query string without `?`, or `""`
 * @property {Readonly<Record<string, string>>} headers the operation's header params (`If-Match`)
 * @property {HttpBody | null} body the request body, or `null`
 * @property {"none" | "optional" | "required"} idempotency whether the call gets a generated `Idempotency-Key`
 *   (`optional`, `required`) or only the caller's (`none`)
 * @property {"safe" | "idempotent" | "never"} retry the retry class
 * @property {number | null} timeoutMs the operation's reviewed timeout, or `null` for the client's
 * @property {Readonly<RequestOptions>} options the validated options of the call
 */

/** Statuses that are retried (with network errors). */
const RETRY_STATUSES = [429, 503, 504];
/** The first back-off wait and its cap, in ms. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
/** A `Retry-After` above this many seconds ends the call instead of waiting. */
const MAX_RETRY_AFTER_SECONDS = 30;

/**
 * The outcome of one attempt: the parsed body, or the error with the response's `Retry-After`.
 * @typedef {{ ok: true, body: unknown } | { ok: false, error: VelexisError, retryAfterSeconds: number | undefined }} Attempt
 */

/**
 * Sends a call: one attempt, plus the retries its retry class and the client's `maxRetries` allow.
 * @param {HttpConfig} config
 * @param {HttpRequest} request
 * @returns {Promise<unknown>} the parsed response body (`undefined` for an empty body)
 * @throws {VelexisError} the mapped error of the last attempt, or a `ConnectionError`
 */
export async function send(config, request) {
  const { options } = request;
  const idempotencyKey = idempotencyKeyOf(request);
  const body = encodeBody(request.body);
  const timeoutMs = options.timeoutMs ?? request.timeoutMs ?? config.timeoutMs;
  const maxRetries = request.retry === "never" ? 0 : config.maxRetries;
  for (let retry = 0; ; retry += 1) {
    const attempt = await sendOnce(config, request, { idempotencyKey, body, timeoutMs });
    if (attempt.ok) {
      return attempt.body;
    }
    const { error, retryAfterSeconds } = attempt;
    if (retry >= maxRetries || !isRetried(error)) {
      throw error;
    }
    if (retryAfterSeconds !== undefined && retryAfterSeconds > MAX_RETRY_AFTER_SECONDS) {
      throw error;
    }
    const waitMs = retryAfterSeconds === undefined ? backoffMs(retry + 1) : retryAfterSeconds * 1000;
    await sleep(waitMs, request);
  }
}

/**
 * The wait before the n-th retry (1-based): 0.5 s, 1 s, 2 s, 4 s, 8 s, 8 s …, each ± 20 % jitter, never above 8 s.
 * @param {number} retry
 * @returns {number} milliseconds
 */
export function backoffMs(retry) {
  const nominal = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (retry - 1));
  return Math.min(BACKOFF_CAP_MS, Math.round(nominal * (0.8 + 0.4 * Math.random())));
}

/**
 * Whether a failed attempt may be retried: 429, 503, 504 or a network error. A timeout or an abort never is.
 * @param {VelexisError} error
 */
const isRetried = (error) =>
  error.status === 0 ? error.code === "NETWORK_ERROR" : RETRY_STATUSES.includes(error.status);

/**
 * The `Idempotency-Key` of a call: `options.idempotencyKey`, else an `Idempotency-Key` in the call's headers, else a
 * new UUID v4 when the operation takes one. The same key goes with every retry of the call.
 * @param {HttpRequest} request
 * @returns {string | undefined}
 */
function idempotencyKeyOf(request) {
  const { options } = request;
  const fromHeaders = Object.entries(options.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "idempotency-key",
  )?.[1];
  return options.idempotencyKey ?? fromHeaders ?? (request.idempotency === "none" ? undefined : uuidV4());
}

/**
 * The body as `fetch` takes it.
 * @param {HttpBody | null} body
 * @returns {string | FormData | undefined}
 */
function encodeBody(body) {
  if (body === null) {
    return undefined;
  }
  return body.kind === "json" ? JSON.stringify(body.value) : body.value;
}

/**
 * The headers of one attempt, later entries winning: `Accept`; locale, currency, host and end user (the call's,
 * else the client's); the credentials; the client's `headers`; the call's `headers`; the operation's header params
 * (`If-Match`); then the call's `Idempotency-Key` and the body's `Content-Type`, which nothing overrides.
 * @param {HttpConfig} config
 * @param {HttpRequest} request
 * @param {string | undefined} idempotencyKey
 * @returns {Promise<Headers>}
 */
async function headersOf(config, request, idempotencyKey) {
  const { options } = request;
  const headers = new Headers({ Accept: "application/json" });
  /** @param {string} name @param {string | undefined} value */
  const setIf = (name, value) => {
    if (value !== undefined && value !== "") {
      headers.set(name, value);
    }
  };
  setIf("Accept-Language", options.locale ?? config.locale);
  setIf("X-Currency", options.currency ?? config.currency);
  setIf("X-Velexis-Host", options.host ?? config.host);
  const endUser = options.endUser ?? (await endUserOf(config.endUser));
  setIf("X-Velexis-End-User-IP", endUser?.ip);
  setIf("X-Velexis-End-User-Agent", endUser?.userAgent);
  for (const set of [
    await config.credentials(options),
    config.headers,
    options.headers ?? {},
    request.headers,
  ]) {
    for (const [name, value] of Object.entries(set)) {
      headers.set(name, value);
    }
  }
  if (idempotencyKey === undefined) {
    headers.delete("Idempotency-Key");
  } else {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  // A multipart body gets its Content-Type, with the boundary, from fetch.
  headers.delete("Content-Type");
  if (request.body?.kind === "json") {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

/**
 * The end user of the client, from a fixed context or a function called before every request.
 * @param {EndUserSource | undefined} source
 * @returns {Promise<EndUserContext | null | undefined>}
 */
async function endUserOf(source) {
  const value = typeof source === "function" ? await source() : source;
  if (value !== null && value !== undefined && (typeof value !== "object" || Array.isArray(value))) {
    throw new TypeError('Velexis SDK: the "endUser" function must return an object, null or undefined');
  }
  return value;
}

/**
 * One HTTP exchange, bounded by the timeout and the caller's signal.
 * @param {HttpConfig} config
 * @param {HttpRequest} request
 * @param {{ idempotencyKey: string | undefined, body: string | FormData | undefined, timeoutMs: number }} call
 * @returns {Promise<Attempt>}
 * @throws {VelexisError} a `ConnectionError` with `ABORTED` when the caller's signal aborts
 */
async function sendOnce(config, request, { idempotencyKey, body, timeoutMs }) {
  const { method, path, options } = request;
  const what = `${method} ${path}`;
  const headers = await headersOf(config, request, idempotencyKey);
  const signal = options.signal;
  if (signal?.aborted) {
    throw connectionError("ABORTED", `Request aborted (${what})`, signal.reason);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Timed out after ${timeoutMs} ms`, "TimeoutError"));
  }, timeoutMs);

  /** @type {RequestInit & { next?: RequestOptions["next"] }} */
  const init = { ...config.fetchInit, method, headers, signal: controller.signal };
  if (body !== undefined) {
    init.body = body;
  }
  if (options.cache !== undefined) {
    init.cache = options.cache;
  }
  if (options.next !== undefined) {
    init.next = options.next;
  }
  const url = `${config.baseUrl}${path}${request.query === "" ? "" : `?${request.query}`}`;
  const fetchFn = config.fetch ?? globalThis.fetch;
  // The timeout and the caller's signal bound the whole exchange, body included, whatever the fetch in use does
  // with its signal (a standard fetch also aborts the body stream on it).
  /** @type {Promise<never>} */
  const stopped = new Promise((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  stopped.catch(() => {});
  const startedAt = Date.now();
  /** @type {Response} */
  let response;
  /** @type {string} */
  let text;
  try {
    response = await Promise.race([fetchFn(url, init), stopped]);
    text = await Promise.race([response.text(), stopped]);
  } catch (cause) {
    if (timedOut) {
      return {
        ok: false,
        error: connectionError("TIMEOUT", `Request timed out after ${timeoutMs} ms (${what})`, cause),
        retryAfterSeconds: undefined,
      };
    }
    if (signal?.aborted) {
      throw connectionError("ABORTED", `Request aborted (${what})`, signal.reason);
    }
    return {
      ok: false,
      error: connectionError("NETWORK_ERROR", `Network error (${what})`, cause),
      retryAfterSeconds: undefined,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  const { status } = response;
  const requestId = response.headers.get("x-request-id");
  notify(config.onResponse, { method, path, status, requestId, durationMs: Date.now() - startedAt });
  const parsed = parseJson(text);
  if (response.ok) {
    if (text === "") {
      return { ok: true, body: undefined };
    }
    if (parsed.ok) {
      return { ok: true, body: parsed.value };
    }
    if (!/json/i.test(response.headers.get("content-type") ?? "")) {
      return { ok: true, body: text };
    }
    const message = `The API answered ${what} with a body that is not valid JSON`;
    return {
      ok: false,
      error: new ServerError({ code: "INTERNAL_ERROR", message, status, requestId }),
      retryAfterSeconds: undefined,
    };
  }
  const now = Date.now();
  return {
    ok: false,
    error: errorFromResponse(response, parsed.ok ? parsed.value : undefined, now),
    retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"), now),
  };
}

/**
 * Parses a JSON text; an empty text is no value.
 * @param {string} text
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
function parseJson(text) {
  if (text === "") {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Calls the `onResponse` hook. Its failures are ignored, a rejected promise included: a logging or metrics bug never
 * fails a call (and the SDK never logs).
 * @param {((info: ResponseInfo) => void) | undefined} hook
 * @param {ResponseInfo} info
 */
function notify(hook, info) {
  if (hook === undefined) {
    return;
  }
  try {
    /** @type {unknown} */
    const result = hook(info);
    if (result instanceof Promise) {
      result.catch(() => {});
    }
  } catch {
    // Ignored on purpose (see above).
  }
}

/**
 * Waits before a retry; the caller's signal ends the wait (and the call) at once.
 * @param {number} ms
 * @param {HttpRequest} request
 * @returns {Promise<void>}
 */
function sleep(ms, request) {
  const { signal } = request.options;
  const aborted = () =>
    connectionError("ABORTED", `Request aborted (${request.method} ${request.path})`, signal?.reason);
  if (signal?.aborted) {
    return Promise.reject(aborted());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
