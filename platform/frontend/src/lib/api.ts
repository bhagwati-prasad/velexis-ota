import "server-only";

import type { paths } from "@velexis/api-types/platform";
import { PLATFORM_ERROR_CODES, type PlatformErrorCode } from "@velexis/errors";
import { cookies, headers } from "next/headers";
import createClient, {
  type Client,
  type ClientPathsWithMethod,
  type FetchResponse,
  type MaybeOptionalInit,
} from "openapi-fetch";

import { getConfig } from "@/lib/config";
import { endUserHeaders, type IncomingHeaders } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";

/**
 * The platform API client of the portal (README §5, ADR-0014, PADR-0009 item 12): `openapi-fetch` typed by
 * `@velexis/api-types/platform`. Server code only; tokens never reach the browser.
 *
 * Every call carries the bearer token of the request (when there is one), the request id, and the three end-user
 * headers of PADR-0019 (`lib/end-user.ts`). Every call uses `cache: "no-store"`, so nothing of a person's data
 * lands in the Next.js data cache, and never follows a redirect, so the bearer token only ever goes to
 * `PLATFORM_API_URL`. A call answers `{ data }` or `{ error }`; it never throws for an API error or an
 * unreachable API.
 */

/** One failed field of a request, as the error envelope carries it (`path` is a JSON pointer into the body). */
export interface ApiFieldError {
  readonly path: string;
  readonly code: string;
}

/**
 * A failed call. `code` is always a code of the platform catalogue: an answer without a valid error envelope
 * becomes `SERVICE_UNAVAILABLE` (502, 503, 504, or the API could not be reached) or `INTERNAL_ERROR`. The API's
 * `message` is left out on purpose: pages show the portal's own text for the code (`lib/errors.ts`).
 */
export interface ApiError {
  readonly code: PlatformErrorCode;
  /** The HTTP status of the answer; 503 when the API could not be reached. */
  readonly status: number;
  /** Field errors of `VALIDATION_FAILED` and the password codes; empty otherwise. */
  readonly fieldErrors: readonly ApiFieldError[];
  /** Code-specific details (`reason`, `limit`, `missing`, …); empty when the answer had none. */
  readonly details: Readonly<Record<string, unknown>>;
  /** The request id of the answer, for support. */
  readonly requestId?: string;
  /** Seconds from `Retry-After` (`ACCOUNT_LOCKED`, `RATE_LIMITED`), when the answer had a valid one. */
  readonly retryAfterSeconds?: number;
}

/** The answer of one call: the response body, or a normalised error. */
export type ApiResult<T> = { data: T; error?: undefined } | { data?: undefined; error: ApiError };

type HttpMethod = "get" | "put" | "post" | "delete" | "patch";
type RawClient = Client<paths>;
type RequiredKeys<T> = { [K in keyof T]: Record<never, never> extends Pick<T, K> ? never : K }[keyof T];
type RequiredKeysOf<T> = RequiredKeys<T> extends undefined ? never : RequiredKeys<T>;
type InitArgs<Init> =
  RequiredKeysOf<Init> extends never
    ? [(Init & { [key: string]: unknown })?]
    : [Init & { [key: string]: unknown }];
type SuccessData<Operation, Init> =
  Operation extends Record<string | number, unknown>
    ? Extract<FetchResponse<Operation, Init, `${string}/${string}`>, { error?: never }>["data"]
    : never;

/** A typed call of one HTTP method, as `openapi-fetch` types it, answering an `ApiResult`. */
export type ApiMethod<Method extends HttpMethod> = <
  Path extends ClientPathsWithMethod<RawClient, Method>,
  Init extends MaybeOptionalInit<paths[Path], Method>,
>(
  url: Path,
  ...init: InitArgs<Init>
) => Promise<ApiResult<SuccessData<paths[Path][Method], Init>>>;

/** The platform API for one incoming request. */
export interface PlatformApi {
  readonly GET: ApiMethod<"get">;
  readonly POST: ApiMethod<"post">;
  readonly PUT: ApiMethod<"put">;
  readonly PATCH: ApiMethod<"patch">;
  readonly DELETE: ApiMethod<"delete">;
}

export interface PlatformApiOptions {
  /** `PLATFORM_API_URL`. */
  readonly baseUrl: string;
  /** `PLATFORM_BFF_KEY`. */
  readonly bffKey: string;
  /** The headers of the incoming request: the end-user IP, user agent and request id come from them. */
  readonly requestHeaders: IncomingHeaders;
  /** The portal access token of the request, sent as `Authorization: Bearer`; none for public operations. */
  readonly accessToken?: string | undefined;
}

/** The request id Caddy sets on every request (ADR-0016), or a valid one the client sent. */
const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** The forwarded request id: the incoming one when it is valid, otherwise none (the API then makes one). */
export function requestIdOf(requestHeaders: IncomingHeaders): string | undefined {
  const value = requestHeaders.get("x-request-id");
  return value !== null && REQUEST_ID.test(value) ? value : undefined;
}

const PLATFORM_CODES: ReadonlySet<string> = new Set(PLATFORM_ERROR_CODES);

function isPlatformCode(value: unknown): value is PlatformErrorCode {
  return typeof value === "string" && PLATFORM_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldErrorsOf(value: unknown): ApiFieldError[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) =>
    isRecord(item) && typeof item.path === "string" && typeof item.code === "string"
      ? [{ path: item.path, code: item.code }]
      : [],
  );
}

function retryAfterOf(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  return value !== null && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

/** The code of an answer without a usable error envelope. */
function codeForStatus(status: number): PlatformErrorCode {
  return status === 502 || status === 503 || status === 504 ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR";
}

/** Turns an error answer of the API into an `ApiError`. Only fields of the envelope schema are kept. */
export function toApiError(response: Response, body: unknown): ApiError {
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const requestId =
    typeof envelope?.requestId === "string" ? envelope.requestId : requestIdOf(response.headers);
  const retryAfterSeconds = retryAfterOf(response);
  return {
    code: isPlatformCode(envelope?.code) ? envelope.code : codeForStatus(response.status),
    status: response.status,
    fieldErrors: fieldErrorsOf(envelope?.fieldErrors),
    details: isRecord(envelope?.details) ? { ...envelope.details } : {},
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/** The error of a call whose request never got an answer (refused, reset, DNS, aborted). */
const UNREACHABLE: ApiError = Object.freeze({
  code: "SERVICE_UNAVAILABLE",
  status: 503,
  fieldErrors: Object.freeze([]),
  details: Object.freeze({}),
});

/** What an `openapi-fetch` method resolves to, before its answer is normalised. */
type RawAnswer = { data?: unknown; error?: unknown; response: Response };
type RawMethod = (url: string, init?: Record<string, unknown>) => Promise<RawAnswer>;

/**
 * Per-call options of `openapi-fetch` that a caller may not set, because they would send the request (and its
 * bearer token) somewhere other than `PLATFORM_API_URL`, follow a redirect, or cache a person's data. They are
 * dropped, so the client's own values always apply.
 */
const FIXED_OPTIONS: ReadonlySet<string> = new Set(["baseUrl", "fetch", "Request", "cache", "redirect"]);

/** The caller's options without the fixed ones. */
function callerOptions(init: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return init === undefined
    ? undefined
    : Object.fromEntries(Object.entries(init).filter(([name]) => !FIXED_OPTIONS.has(name)));
}

async function settle(pending: Promise<RawAnswer>): Promise<ApiResult<unknown>> {
  let answer: RawAnswer;
  try {
    answer = await pending;
  } catch {
    // The cause (connection refused, reset, timeout) is not exposed; the API's own logs have the details.
    return { error: UNREACHABLE };
  }
  const { response } = answer;
  if (response.ok) {
    return { data: answer.data };
  }
  return { error: toApiError(response, answer.error) };
}

/**
 * A platform API client for one incoming request. Middleware uses it directly (the session refresh); server
 * components, server actions and route handlers use `platformApi()`.
 */
export function createPlatformApi(options: PlatformApiOptions): PlatformApi {
  const client = createClient<paths>({ baseUrl: options.baseUrl, cache: "no-store", redirect: "manual" });
  const forwarded = endUserHeaders(options.requestHeaders, options.bffKey);
  const requestId = requestIdOf(options.requestHeaders);
  client.use({
    onRequest({ request }) {
      // Set last, over anything a caller passed: every call carries these, and only these, values.
      for (const [name, value] of Object.entries(forwarded)) {
        request.headers.set(name, value);
      }
      if (requestId === undefined) {
        request.headers.delete("x-request-id");
      } else {
        request.headers.set("x-request-id", requestId);
      }
      if (options.accessToken === undefined || options.accessToken === "") {
        request.headers.delete("authorization");
      } else {
        request.headers.set("authorization", `Bearer ${options.accessToken}`);
      }
      return request;
    },
  });
  // The methods take openapi-fetch's parameters, less the fixed options; the answer is normalised (typed by
  // ApiMethod).
  const wrap =
    (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE") => (url: string, init?: Record<string, unknown>) =>
      settle((client[method] as RawMethod)(url, callerOptions(init)));
  return {
    GET: wrap("GET") as ApiMethod<"get">,
    POST: wrap("POST") as ApiMethod<"post">,
    PUT: wrap("PUT") as ApiMethod<"put">,
    PATCH: wrap("PATCH") as ApiMethod<"patch">,
    DELETE: wrap("DELETE") as ApiMethod<"delete">,
  };
}

/**
 * The platform API for the request being rendered: base URL and key from the configuration, the access token
 * from `__Host-vxp_at`, the end-user headers from the request. For server components, server actions and route
 * handlers; `middleware.ts` has already refreshed an expired access token.
 */
export async function platformApi(): Promise<PlatformApi> {
  const config = getConfig();
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  return createPlatformApi({
    baseUrl: config.PLATFORM_API_URL,
    bffKey: config.PLATFORM_BFF_KEY,
    requestHeaders,
    accessToken: cookieStore.get(ACCESS_TOKEN_COOKIE)?.value,
  });
}
