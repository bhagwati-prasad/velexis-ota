// CORS of the OTA API (OBE-097; decisions.md §5: third-party frontends call api.ota.example.com from the browser with
// a publishable key; lead decision (15h) of 2026-11-11). The document's `info.description` (Browsers on other
// origins) is the contract; this file is its two halves:
//
// - Preflights (`corsPreflight`, mounted by http.module.ts after helmet, before the body parsers): an `OPTIONS` with a
//   serialized `Origin` and `Access-Control-Request-Method`, on any path, answers `204` with the request's origin, the
//   methods and headers below, `Access-Control-Max-Age` and `Vary: Origin`, before any guard: a preflight carries no
//   key, so the answer is the same for every origin and says nothing about any key. Requests that carry the edge
//   credential (`X-Velexis-Edge`: the hosted storefront's same-origin `/api/*`, which Caddy sets and strips from
//   `api.ota`) are never answered here: the edge's answers do not change (ADR-0018).
// - Actual answers (`allowCorsAnswer`, called by the caller guard once the caller is known): a publishable key whose
//   allowed origins list the request's `Origin` (the key verifier refuses any other origin with `403
//   ORIGIN_NOT_ALLOWED` before this runs) gets `Access-Control-Allow-Origin` with that origin, the exposed headers
//   below and `Vary: Origin`, on the answer whatever it becomes: the later guards' refusals and the operation's own
//   errors stay readable to the page. Secret keys, the service, the edge, anonymous callers and requests without an
//   `Origin` get none, and so does everything answered before the key is checked (a refused key, a body the parsers
//   refuse, a path that is no operation).
//
// `Access-Control-Allow-Credentials` is never sent: no cookie travels cross-origin (the API ignores cookies of key and
// bearer callers anyway, and the SDK's token mode fetches with `credentials: "omit"`).
import type { NextFunction, Request, Response } from "express";
import type { Caller } from "../../tenancy/caller-resolver";

/** The methods of the document's operations (`Access-Control-Allow-Methods` of a preflight). */
export const CORS_ALLOWED_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"] as const);

/**
 * `Access-Control-Allow-Headers` of a preflight: every request header a browser may send to the API. They are the
 * header parameters and header credentials of the OTA document but the two no browser sends (`Stripe-Signature` of the
 * webhook receivers, the edge's `X-Velexis-Edge`), `Authorization` of its bearer schemes, every header the SDK's
 * transport sets (ota/sdk/src/internal/http.js and session.js), and a client's own `X-Request-Id` (ADR-0016).
 * cors.test.ts checks the list against the document and the SDK's source.
 */
export const CORS_ALLOWED_HEADERS = Object.freeze([
  "Accept",
  "Accept-Language",
  "Authorization",
  "Content-Type",
  "Idempotency-Key",
  "If-Match",
  "If-None-Match",
  "X-Api-Key",
  "X-Booking-Token",
  "X-CSRF-Token",
  "X-Currency",
  "X-Request-Id",
  "X-Velexis-End-User-Agent",
  "X-Velexis-End-User-IP",
  "X-Velexis-Environment",
  "X-Velexis-Host",
  "X-Velexis-Scope",
] as const);

/**
 * `Access-Control-Expose-Headers` of an actual answer: the response headers of the document (`components.headers`) a
 * page may read, which a browser hides from a cross-origin page unless they are listed: the request id the SDK puts on
 * every error, `Retry-After` of `429` and `503`, `ETag` for `If-Match`, and `Location` of a created resource.
 * `Set-Cookie` is never readable by a page; `Content-Type` and `Cache-Control` are readable without being listed.
 */
export const CORS_EXPOSED_HEADERS = Object.freeze([
  "X-Request-Id",
  "Retry-After",
  "ETag",
  "Location",
] as const);

/**
 * How long a browser may reuse a preflight's answer, in seconds: two hours, the most Chromium keeps one. A browser
 * asks again before a request whose method or headers the kept answer does not allow, so a header added later costs
 * one more preflight, not a refused call.
 */
export const CORS_MAX_AGE_SECONDS = 7200;

/** The edge credential that Caddy sets on the storefronts' `/api/*` only (caller-resolver.ts `CALLER_HEADERS.edge`). */
const EDGE_HEADER = "x-velexis-edge";

/** The headers of every preflight's answer but the origin, which echoes the request's. */
const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS.join(", "),
  "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS.join(", "),
  "Access-Control-Max-Age": String(CORS_MAX_AGE_SECONDS),
});

const EXPOSE_HEADERS = CORS_EXPOSED_HEADERS.join(", ");

/** The request headers CORS reads, lower case as Node gives them. */
type HeaderSource = Readonly<Record<string, string | string[] | undefined>>;

/** A header's single value, or `undefined` when it is missing or repeated (an `Origin` is one origin or nothing). */
function single(headers: HeaderSource, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * True when `value` is an origin as a browser serializes it into `Origin`: `http` or `https`, a host in lower case and
 * an optional port, nothing else (no path, no user, no trailing slash). `null` (an opaque origin) is not one: no key
 * can list it.
 */
export function isSerializedOrigin(value: string): boolean {
  if (!/^https?:\/\/[^/?#@\s]+$/.test(value)) {
    return false;
  }
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/**
 * The origin a preflight is answered for, or `undefined` when the request is no CORS preflight the API answers: not
 * `OPTIONS`, no `Access-Control-Request-Method`, no serialized `Origin`, or a request of the storefront edge.
 */
export function preflightOrigin(method: string, headers: HeaderSource): string | undefined {
  if (method !== "OPTIONS" || headers[EDGE_HEADER] !== undefined) {
    return undefined;
  }
  const origin = single(headers, "origin");
  const requestedMethod = single(headers, "access-control-request-method");
  if (
    origin === undefined ||
    !isSerializedOrigin(origin) ||
    requestedMethod === undefined ||
    requestedMethod === ""
  ) {
    return undefined;
  }
  return origin;
}

/**
 * Middleware: answers a CORS preflight (`preflightOrigin`) with `204` and the preflight headers; every other request
 * goes on unchanged, an `OPTIONS` that is no preflight included (it meets the router like any other method).
 */
export function corsPreflight(req: Request, res: Response, next: NextFunction): void {
  const origin = preflightOrigin(req.method, req.headers);
  if (origin === undefined) {
    next();
    return;
  }
  res.status(204);
  res.setHeader("Access-Control-Allow-Origin", origin);
  for (const [name, value] of Object.entries(PREFLIGHT_HEADERS)) {
    res.setHeader(name, value);
  }
  res.vary("Origin");
  res.end();
}

/**
 * The origin an actual answer to `caller` is opened to, or `undefined` for none: a publishable key with the request's
 * `Origin`. The caller guard runs this only for a caller the key verifier let through, which for a publishable key
 * with an `Origin` means one of the key's allowed origins (`ORIGIN_NOT_ALLOWED` otherwise).
 */
export function corsAnswerOrigin(caller: Caller, origin: string | undefined): string | undefined {
  if (caller.type !== "key" || caller.kind !== "publishable" || origin === undefined || origin === "") {
    return undefined;
  }
  return origin;
}

/** The part of Express' response the CORS answer writes. */
export type CorsAnswerTarget = Pick<Response, "setHeader" | "vary" | "writeHead">;

/**
 * Opens the answer of `caller`'s request to the page on the request's `Origin` (`corsAnswerOrigin`): the origin, the
 * exposed headers and `Vary: Origin`, set now so that whatever answers the request later keeps them. Nothing for any
 * other caller or request.
 *
 * A handler may still replace `Vary` after the guard (Nest's `@Header("Vary", "Accept-Language")` of the reference
 * operations sets the header anew, and their answers are cacheable), so `Origin` is added to `Vary` once more as the
 * headers are written: an answer opened to one origin is never reused from a cache for another.
 */
export function allowCorsAnswer(res: CorsAnswerTarget, caller: Caller, origin: string | undefined): void {
  const allowed = corsAnswerOrigin(caller, origin);
  if (allowed === undefined) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  res.vary("Origin");
  const writeHead = res.writeHead.bind(res) as unknown as (...args: unknown[]) => unknown;
  res.writeHead = ((...args: unknown[]) => {
    res.vary("Origin");
    return writeHead(...args);
  }) as unknown as CorsAnswerTarget["writeHead"];
}
