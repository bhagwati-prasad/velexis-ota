// The Amadeus token check (platform/docs/architecture.md §7, ADR-0012, flows/amadeus-connection.md §A step 2): the
// only Amadeus call of the platform. It proves that a client id and secret work by requesting an OAuth token,
//
//   POST {baseUrl}/v1/security/oauth2/token
//   Content-Type: application/x-www-form-urlencoded
//   grant_type=client_credentials&client_id=…&client_secret=…
//
// with a 10-second timeout, and discards the token: the platform never calls a flight API (the OTA backend does).
//
// What leaves this class is a classified outcome and a short error text of the HTTP status and the Amadeus error
// (`HTTP 401 invalid_client (Amadeus code 38187)`), never the provider's body, the secret or the token:
//
// - `verified`: a 2xx answer with an `access_token`;
// - `rejected`: the credentials or the host are wrong: 4xx other than 408 and 429, a 2xx without a token, a redirect
//   (never followed, so the secret is sent to `baseUrl` only);
// - `unavailable`: Amadeus could not answer now: 5xx, 408, 429, a timeout or a network error. The caller may try
//   again later.
//
// The body is read up to 64 KiB, enough for any token or error answer, so a host that streams without end cannot
// hold the worker. `fetch` is Node's built-in one, looked up at each call (a test may wrap it).
import { Inject, Injectable, Optional } from "@nestjs/common";

/** The path of the token endpoint below the account's base URL. */
export const AMADEUS_TOKEN_PATH = "/v1/security/oauth2/token";

/** How long the token request may take, connection and body included. */
export const AMADEUS_TOKEN_TIMEOUT_MS = 10_000;

/** The most of an answer's body that is read. */
export const AMADEUS_TOKEN_MAX_BODY_BYTES = 64 * 1024;

/** The longest error text (the OpenAPI document's `lastError` allows 500 characters). */
const MAX_ERROR_LENGTH = 200;

/** What the token check needs: the account's host, client id and decrypted secret. Never log it. */
export interface AmadeusClientCredentials {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The outcome of one token request. */
export type AmadeusTokenCheck =
  | { readonly outcome: "verified"; readonly httpStatus: number }
  | {
      readonly outcome: "rejected" | "unavailable";
      /** The HTTP status, or `null` when no answer came (timeout, network error). */
      readonly httpStatus: number | null;
      /** The short error text for `last_error`: status and Amadeus code, never the body. */
      readonly error: string;
    };

/** The `fetch` the gateway calls (Node's built-in one by default). */
export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

/** Options of the gateway, for tests: another `fetch` and a shorter timeout. */
export interface AmadeusOAuthGatewayOptions {
  readonly fetch?: FetchFunction;
  readonly timeoutMs?: number;
}

/** Injection token of the gateway's options; nothing provides it outside tests. */
export const AMADEUS_OAUTH_GATEWAY_OPTIONS = Symbol("AMADEUS_OAUTH_GATEWAY_OPTIONS");

/** The token endpoint of a base URL: the URL without trailing slashes, then AMADEUS_TOKEN_PATH. */
export function tokenUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${AMADEUS_TOKEN_PATH}`;
}

/** An OAuth error code such as `invalid_client`: lower-case letters and underscores only. */
const OAUTH_ERROR = /^[a-z_]{1,50}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An Amadeus error code: a whole number of at most 9 digits. */
function amadeusCode(value: unknown): number | undefined {
  const code = typeof value === "string" && /^[0-9]{1,9}$/.test(value) ? Number(value) : value;
  return typeof code === "number" && Number.isSafeInteger(code) && code >= 0 && code < 1e9 ? code : undefined;
}

/**
 * The short error text of an answer that is not a token: `HTTP <status>`, the OAuth error code and the Amadeus error
 * code when the body names them (`{error, code}` of the token endpoint, `{errors: [{code}]}` of the APIs). Nothing else
 * of the body is used, so no description, title or echoed value reaches `last_error`.
 */
export function describeAnswer(httpStatus: number, body: unknown): string {
  const parts = [`HTTP ${httpStatus}`];
  if (isRecord(body)) {
    const error = body["error"];
    if (typeof error === "string" && OAUTH_ERROR.test(error)) {
      parts.push(error);
    }
    const errors = body["errors"];
    const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
    const code = amadeusCode(body["code"]) ?? (isRecord(first) ? amadeusCode(first["code"]) : undefined);
    if (code !== undefined) {
      parts.push(`(Amadeus code ${code})`);
    }
  }
  return parts.join(" ").slice(0, MAX_ERROR_LENGTH);
}

/** `rejected` for an answer that says the credentials or the host are wrong, `unavailable` for one worth retrying. */
export function classifyStatus(httpStatus: number): "rejected" | "unavailable" {
  return httpStatus >= 500 || httpStatus === 408 || httpStatus === 429 ? "unavailable" : "rejected";
}

/** The text of a failed request without an answer: a timeout, or the network error's code (`ECONNREFUSED`). */
export function describeFailure(error: unknown, timeoutMs: number): string {
  // An abort is a DOMException, which is not an Error in every runtime: read the name as a plain property.
  const name: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "name") : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return `timeout after ${Math.max(1, Math.round(timeoutMs / 1000))} s`;
  }
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code: unknown = typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)
    ? `network error (${code})`
    : "network error";
}

/** Reads at most `maxBytes` of the body (the rest is cancelled) and parses it as JSON; `undefined` if it is not. */
async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) {
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      size += value.byteLength;
      if (size >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

@Injectable()
export class AmadeusOAuthGateway {
  private readonly fetchFunction: FetchFunction | undefined;
  private readonly timeoutMs: number;

  constructor(@Optional() @Inject(AMADEUS_OAUTH_GATEWAY_OPTIONS) options?: AmadeusOAuthGatewayOptions) {
    this.fetchFunction = options?.fetch;
    this.timeoutMs = options?.timeoutMs ?? AMADEUS_TOKEN_TIMEOUT_MS;
  }

  /** Requests a token with `credentials` and discards it (see the file header). Never throws for a failed request. */
  async checkCredentials(credentials: AmadeusClientCredentials): Promise<AmadeusTokenCheck> {
    const url = tokenUrl(credentials.baseUrl);
    if (!/^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(url)) {
      // The database CHECK allows nothing else; refuse before the secret goes anywhere.
      return { outcome: "rejected", httpStatus: null, error: "base URL is not https" };
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    const fetchFunction = this.fetchFunction ?? ((input: string, init: RequestInit) => fetch(input, init));
    try {
      const response = await fetchFunction(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }).toString(),
        // A redirect is never followed: fetch would send the form, secret included, to the new location.
        redirect: "manual",
        signal,
      });
      const body = await readJson(response, AMADEUS_TOKEN_MAX_BODY_BYTES);
      const httpStatus = response.status;
      if (httpStatus >= 200 && httpStatus < 300) {
        const token = isRecord(body) ? body["access_token"] : undefined;
        // The token is only looked at: it is not kept, returned or logged.
        return typeof token === "string" && token.length > 0
          ? { outcome: "verified", httpStatus }
          : { outcome: "rejected", httpStatus, error: `HTTP ${httpStatus} without an access token` };
      }
      return { outcome: classifyStatus(httpStatus), httpStatus, error: describeAnswer(httpStatus, body) };
    } catch (error) {
      return { outcome: "unavailable", httpStatus: null, error: describeFailure(error, this.timeoutMs) };
    }
  }
}
