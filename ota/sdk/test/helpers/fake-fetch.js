// A fake `fetch` for the SDK's unit tests (ota/sdk/README.md §8): a queue of canned answers, used in call order,
// that records every request (method, URL, headers, body) for assertions. Tests pass `fake.fetch` as the client's
// `fetch` option, so no test touches the network (ADR-0015). Answers become real `Response` objects of the
// runtime (Node 22, or happy-dom in cookie-mode tests), and delays use `setTimeout`, so fake timers drive them.
//
//   const fake = createFakeFetch([{ status: 200, body: { data: [] } }, errorResponse(404, "NOT_FOUND")]);
//   const client = createVelexisClient({ publishableKey: "pk_test_x", fetch: fake.fetch });
//   ...
//   expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/v1/storefront" });
//   expect(fake.remaining).toBe(0);

/**
 * A request as the SDK made it. Every call is recorded, also one that is rejected.
 * @typedef {object} RecordedRequest
 * @property {string} method upper case; `GET` when none was given
 * @property {string} url the URL as passed to `fetch` (relative in cookie mode)
 * @property {string} path the URL's path, without the query string
 * @property {URLSearchParams} searchParams the URL's query parameters, decoded
 * @property {Record<string, string>} headers every header, by lower-case name
 * @property {unknown} body the body as passed (a string, `FormData`, `Blob`, ...), or `null` without one
 * @property {unknown} json the body parsed as JSON when it is a JSON string, else `undefined`
 * @property {AbortSignal | null} signal the signal of the call, if any
 * @property {RequestInit} init the second argument of the call, as passed (`credentials`, `mode`, ...)
 */

/**
 * A canned answer. `body` is sent as is when it is a string and as JSON (with `content-type: application/json`
 * unless `headers` names one) otherwise; leave it out for an empty body.
 * @typedef {object} CannedResponse
 * @property {number} [status] the HTTP status, 200 by default
 * @property {string} [statusText]
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body]
 * @property {number} [delayMs] answer after this many milliseconds; `Infinity` answers only by rejecting on abort
 * @property {unknown} [error] reject the call with this value (a network failure) instead of answering
 */

/**
 * One queued answer: a canned response, a ready `Response` (used once), or a function of the request that
 * returns either (for answers that depend on the request).
 * @typedef {CannedResponse | Response | ((request: RecordedRequest) => CannedResponse | Response | Promise<CannedResponse | Response>)} Answer
 */

/**
 * @typedef {object} FakeFetch
 * @property {typeof globalThis.fetch} fetch the function to pass as the client's `fetch` option
 * @property {RecordedRequest[]} requests every call so far, in call order
 * @property {(...answers: Answer[]) => FakeFetch} enqueue adds answers to the end of the queue
 * @property {number} remaining the number of answers not used yet
 * @property {RecordedRequest | undefined} lastRequest the latest call
 */

/** Statuses whose responses never have a body (the Fetch standard's null body statuses). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Base for reading relative URLs (cookie mode calls `/api/...`); only the path and query are used. */
const RELATIVE_BASE = "http://relative.invalid";

/**
 * Creates a fake `fetch` that answers from a queue, in call order, and records every request.
 * A call when the queue is empty rejects with an error that names the request, so a test fails loudly.
 * A call whose signal is already aborted rejects with the abort reason and uses no answer.
 * @param {Answer[]} [answers] the first answers of the queue
 * @returns {FakeFetch}
 */
export function createFakeFetch(answers = []) {
  /** @type {Answer[]} */
  const queue = [];
  /** @type {RecordedRequest[]} */
  const requests = [];

  /** @type {typeof globalThis.fetch} */
  const fakeFetch = async (input, init) => {
    const request = record(input, init);
    requests.push(request);
    // Take the answer before the first await, so concurrent calls get the answers in call order.
    const aborted = request.signal?.aborted ?? false;
    const answer = aborted ? undefined : queue.shift();
    if (input instanceof Request && input.body !== null && request.body === null) {
      request.body = await input.clone().text();
      request.json = parseJson(request.body);
    }
    if (aborted && request.signal) {
      throw abortReason(request.signal);
    }
    if (answer === undefined) {
      throw new Error(`fake fetch: no answer queued for ${request.method} ${request.url}`);
    }
    const resolved = typeof answer === "function" ? await answer(request) : answer;
    if (resolved instanceof Response) {
      return resolved;
    }
    checkCanned(resolved);
    await wait(resolved.delayMs, request.signal);
    if ("error" in resolved) {
      throw resolved.error;
    }
    return toResponse(resolved);
  };

  /** @type {FakeFetch} */
  const fake = {
    fetch: fakeFetch,
    requests,
    enqueue(...more) {
      for (const answer of more) {
        if (typeof answer !== "function" && !(answer instanceof Response)) {
          checkCanned(answer);
        }
        queue.push(answer);
      }
      return fake;
    },
    get remaining() {
      return queue.length;
    },
    get lastRequest() {
      return requests.at(-1);
    },
  };
  fake.enqueue(...answers);
  return fake;
}

/**
 * The API's error envelope (`{ error: { code, message, status, requestId, ... } }`, schema `ErrorResponse`) as a
 * canned answer, with the `X-Request-Id` header the API sends.
 * @param {number} status
 * @param {string} code a public error code, for example `TOKEN_EXPIRED`
 * @param {{ message?: string, requestId?: string, headers?: Record<string, string>, details?: Record<string, unknown>, fieldErrors?: unknown[], supplier?: Record<string, unknown> }} [extra]
 * @returns {CannedResponse}
 */
export function errorResponse(status, code, extra = {}) {
  const { message = `Fake ${code}`, requestId = "req_fake", headers = {}, ...rest } = extra;
  return {
    status,
    headers: { "x-request-id": requestId, ...headers },
    body: { error: { code, message, status, requestId, ...rest } },
  };
}

/**
 * A network failure, as `fetch` reports it: a `TypeError`.
 * @param {string} [message]
 * @returns {CannedResponse}
 */
export function networkError(message = "fetch failed") {
  return { error: new TypeError(message) };
}

/**
 * @param {RequestInfo | URL} input
 * @param {RequestInit | undefined} init
 * @returns {RecordedRequest}
 */
function record(input, init = {}) {
  const fromRequest = input instanceof Request ? input : undefined;
  const url = fromRequest ? fromRequest.url : String(input);
  const parsed = new URL(url, RELATIVE_BASE);
  /** @type {Record<string, string>} */
  const headers = {};
  // Lower-cased here: Node's Headers yields lower-case names, but happy-dom's keeps the case the caller used.
  new Headers(init.headers ?? fromRequest?.headers).forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const body = init.body ?? null;
  return {
    method: (init.method ?? fromRequest?.method ?? "GET").toUpperCase(),
    url,
    path: parsed.pathname,
    searchParams: parsed.searchParams,
    headers,
    body,
    json: parseJson(body),
    signal: init.signal ?? fromRequest?.signal ?? null,
    init,
  };
}

/** @param {unknown} body */
function parseJson(body) {
  if (typeof body !== "string" || body === "") {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Refuses a canned response that the `Response` constructor would refuse, with a message that names the mistake
 * (inside `fetch` the constructor's error would look like a network failure to the SDK).
 * @param {CannedResponse} canned
 */
function checkCanned(canned) {
  if (canned === null || typeof canned !== "object") {
    throw new TypeError("fake fetch: an answer is a canned response object, a Response or a function");
  }
  const status = canned.status ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RangeError(`fake fetch: status ${status} is not a final HTTP status (200-599)`);
  }
  if (NULL_BODY_STATUSES.has(status) && canned.body !== undefined) {
    throw new TypeError(`fake fetch: a ${status} response has no body`);
  }
}

/**
 * @param {CannedResponse} canned
 * @returns {Response}
 */
function toResponse(canned) {
  const status = canned.status ?? 200;
  const headers = new Headers(canned.headers);
  /** @type {string | null} */
  let body = null;
  if (typeof canned.body === "string") {
    body = canned.body;
  } else if (canned.body !== undefined) {
    body = JSON.stringify(canned.body);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }
  return new Response(body, { status, statusText: canned.statusText ?? "", headers });
}

/**
 * Waits `delayMs` (none when undefined), rejecting with the abort reason as soon as `signal` aborts.
 * @param {number | undefined} delayMs
 * @param {AbortSignal | null} signal
 * @returns {Promise<void>}
 */
function wait(delayMs, signal) {
  if (delayMs === undefined) {
    return Promise.resolve();
  }
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(/** @type {AbortSignal} */ (signal)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (delayMs !== Infinity) {
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
    }
  });
}

/**
 * What `fetch` rejects with on abort: the signal's reason, or an `AbortError` without one.
 * @param {AbortSignal} signal
 */
function abortReason(signal) {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}
