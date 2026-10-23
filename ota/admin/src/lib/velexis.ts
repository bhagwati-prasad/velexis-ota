// The OTA admin's one way to the OTA API (OADR-0018 points 1, 3 and 10, README §2 and §7): `@velexis/ota-sdk` in
// server mode, a client per request with the first-party service key (`OTA_ADMIN_SERVICE_KEY`) on the direct
// loopback connection (`OTA_API_URL`), the staff access token of the request, `sessionKind: "staff"` and the
// environment of the switch (`X-Velexis-Environment`). No other module calls the OTA API, and no client component may
// import this one: `server-only` makes such an import a build error.
//
// - Every request forwards the staff member's address (OADR-0011 points 8 and 9): `X-Velexis-End-User-IP` is the
//   right-most `X-Forwarded-For` entry of the incoming request, which Caddy writes whatever the browser sent (every
//   entry to its left may come from the browser and is never used), or `127.0.0.1` without one (local development
//   without a proxy); `X-Velexis-End-User-Agent` is the browser's `User-Agent`, cut to 512 characters. The backend
//   honours them only for the service caller, for the sign-in throttle, the lockout and `staff_actions`.
// - `onResponse` logs one line per response (method, API path without the query, status, request id, duration),
//   never a body, a header, a cookie or a token.
// - Server components never refresh (they cannot write cookies): their client has the access token only, and
//   `getStaff()` sends an expired session to `/auth/refresh`. Refreshes go through `refreshStaffSession`, which is
//   de-duplicated per refresh token (lib/refresh-dedup.ts).
import "server-only";

import { createLogger, type Logger } from "@velexis/logger";
import {
  createVelexisClient,
  type ConsoleApi,
  type ConsoleStaffProfile,
  type VelexisClientOptions,
} from "@velexis/ota-sdk";
import { headers } from "next/headers";
import { cache } from "react";

import { getConfig } from "@/config";
import { isVelexisErrorLike } from "@/lib/errors";
import { canOpenEnvironment, type StaffEnvironment } from "@/lib/permissions";
import { dedupRefresh, type DedupRefresh, type StaffRefreshOutcome } from "@/lib/refresh-dedup";
import { readSession, redirectOnSessionError, redirectToRefresh } from "@/lib/session";

// ---- End user ---------------------------------------------------------------------------------------------------

/** The header that carries the staff member's IP address. */
export const END_USER_IP_HEADER = "X-Velexis-End-User-IP";
/** The header that carries the staff member's user agent. */
export const END_USER_AGENT_HEADER = "X-Velexis-End-User-Agent";
/** The address used when the request did not come through Caddy (local development without a proxy). */
export const FALLBACK_END_USER_IP = "127.0.0.1";
/** The longest user agent forwarded, in characters. */
export const MAX_USER_AGENT_LENGTH = 512;

/** The incoming request headers this module reads (`headers()` of Next.js, or `NextRequest#headers`). */
export interface IncomingHeaders {
  get(name: string): string | null;
}

/** Characters a forwarded header value keeps: visible ASCII and the space (no control or non-ASCII character). */
const NOT_HEADER_TEXT = /[^\x20-\x7e]/g;

/**
 * The right-most `X-Forwarded-For` entry, which Caddy writes, or `127.0.0.1` without one. Every entry to its left may
 * come from the browser and is ignored. The value is passed on as it is: the API refuses a malformed address with
 * `400 VALIDATION_FAILED`, so a proxy misconfiguration shows at once.
 */
export function endUserIp(incoming: IncomingHeaders): string {
  const entries = (incoming.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.replace(NOT_HEADER_TEXT, "").trim())
    .filter((entry) => entry !== "");
  return entries.at(-1) ?? FALLBACK_END_USER_IP;
}

/** The browser's `User-Agent`, cut to 512 characters; empty when the browser sent none. */
export function endUserAgent(incoming: IncomingHeaders): string {
  return (incoming.get("user-agent") ?? "")
    .replace(NOT_HEADER_TEXT, "")
    .trim()
    .slice(0, MAX_USER_AGENT_LENGTH);
}

/** The two end-user headers of every SDK request made for the request with `incoming` headers. */
export function endUserHeaders(incoming: IncomingHeaders): Record<string, string> {
  return {
    [END_USER_IP_HEADER]: endUserIp(incoming),
    [END_USER_AGENT_HEADER]: endUserAgent(incoming),
  };
}

// ---- Clients ----------------------------------------------------------------------------------------------------

/** What a console client of one request is built from. */
export interface ConsoleClientInput {
  /**
   * The staff access token; `null` only for the key-only staff-session calls (`console.auth.refresh`, and the
   * sign-in and sign-out of OAD-003), so a console call never goes out with the service key alone by mistake.
   */
  readonly accessToken: string | null;
  /** `X-Velexis-Environment` of every console request. */
  readonly environment: StaffEnvironment;
  /** The incoming request's headers, for the end-user headers. */
  readonly incoming: IncomingHeaders;
}

/** Replacements for tests (OADR-0018 point 10: a fake `fetch` in the real SDK) and for the de-duplication. */
export interface ConsoleClientDeps {
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  readonly dedup?: DedupRefresh;
}

/** The message of the response log line. */
export const RESPONSE_LOG_MESSAGE = "ota_api.response";

let defaultLogger: Logger | undefined;

/** The logger of this process, created on first use from the configuration. */
function sdkLogger(): Logger {
  if (defaultLogger === undefined) {
    const config = getConfig();
    defaultLogger = createLogger({ app: "ota-admin", env: config.APP_ENV, level: config.LOG_LEVEL });
  }
  return defaultLogger;
}

type ResponseHook = NonNullable<VelexisClientOptions["onResponse"]>;

/** `onResponse`: one line per response with the call's facts only, never a body, a header or a token. */
function logResponse(logger: Logger): ResponseHook {
  return ({ method, path, status, requestId, durationMs }) => {
    const line = { method, path, status, requestId, durationMs };
    if (status >= 500) {
      logger.warn(line, RESPONSE_LOG_MESSAGE);
    } else {
      logger.info(line, RESPONSE_LOG_MESSAGE);
    }
  };
}

/**
 * A server-mode console client for one request: the service key, the OTA API on loopback, the staff access token,
 * `sessionKind: "staff"`, the environment, the end-user headers and the response log. It never gets a refresh token
 * (refreshes go through `refreshStaffSession`).
 */
export function createConsoleClient(input: ConsoleClientInput, deps: ConsoleClientDeps = {}): ConsoleApi {
  const config = getConfig();
  const options: VelexisClientOptions = {
    secretKey: config.OTA_ADMIN_SERVICE_KEY,
    baseUrl: config.OTA_API_URL,
    sessionKind: "staff",
    environment: input.environment,
    headers: endUserHeaders(input.incoming),
    onResponse: logResponse(deps.logger ?? sdkLogger()),
    ...(input.accessToken === null ? {} : { accessToken: input.accessToken }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  };
  return createVelexisClient(options).console;
}

/**
 * The environment of a refresh. A refresh rotates the token whatever the environment, but `live` is refused for a
 * role or an OTA that does not allow it (`403 ENVIRONMENT_NOT_ALLOWED`, the family left as it was), so the admin
 * refreshes in `test`, which every session allows; the environment cookie keeps the staff member's choice.
 */
export const REFRESH_ENVIRONMENT: StaffEnvironment = "test";

/**
 * Refreshes the staff session of `refreshToken` with `console.auth.refresh`, de-duplicated per token: requests that
 * present the same token at the same time, or within 30 s, share one call and its new tokens (OADR-0018 point 3).
 * The caller writes the cookies (`staffSessionCookies` of lib/session.ts) or clears them on a `final` refusal.
 */
export function refreshStaffSession(
  refreshToken: string,
  incoming: IncomingHeaders,
  deps: ConsoleClientDeps = {},
): Promise<StaffRefreshOutcome> {
  const dedup = deps.dedup ?? dedupRefresh;
  return dedup(refreshToken, (token) =>
    createConsoleClient({ accessToken: null, environment: REFRESH_ENVIRONMENT, incoming }, deps).auth.refresh(
      {
        refreshToken: token,
      },
    ),
  );
}

/** What the server components of one request work with (README §4 "Environment switch", routes.md §1). */
export interface ConsoleRequest {
  /** The console client of the request, in `environment`. */
  readonly console: ConsoleApi;
  /** `console.auth.me` in `environment`: the staff member, the OTA, the permissions and the environments. */
  readonly staff: ConsoleStaffProfile;
  /** The environment every call of the request is sent in. */
  readonly environment: StaffEnvironment;
  /**
   * The environment cookie asked for `live`, which the OTA or the role does not allow (any more): the API refused it
   * (`403 ENVIRONMENT_NOT_ALLOWED`) or the session no longer lists it. The request then works in `test`, and the shell
   * shows "Live is not available for this OTA or role" and resets the cookie (OAD-004).
   */
  readonly liveRefused: boolean;
}

/**
 * The console of this request (React `cache`: once per server request), for server components: the client, the staff
 * profile and the environment the request works in. Without a session it redirects to the portal; with a refresh
 * token only (the middleware could not refresh) it redirects to `/auth/refresh`, because a server component cannot
 * write the rotated tokens.
 *
 * `console.auth.me` runs first, in the environment of the cookie. When that is `live` and the API refuses it
 * (`403 ENVIRONMENT_NOT_ALLOWED`: the OTA is no longer live, or the role became one that never opens live), or the
 * profile no longer allows it, the request asks again in `test` and every call of the request goes there: a server
 * component cannot reset the cookie, and Next.js would hide the refusal from the error boundary in production. The
 * layout shows the banner of routes.md §1 and resets the cookie with a server action. Other refusals keep the rules of
 * `redirectOnSessionError`: an expired token goes to `/auth/refresh`, an ended session to the portal, anything else is
 * thrown for the page to handle.
 */
export const getConsoleRequest = cache(async (): Promise<ConsoleRequest> => {
  const session = await readSession();
  const { accessToken } = session;
  if (accessToken === undefined) {
    redirectToRefresh();
  }
  const incoming = await headers();
  const clientIn = (environment: StaffEnvironment): ConsoleApi =>
    createConsoleClient({ accessToken, environment, incoming });

  const wanted = session.environment;
  const client = clientIn(wanted);
  let staff: ConsoleStaffProfile | undefined;
  try {
    staff = await client.auth.me();
  } catch (error) {
    if (wanted !== "live" || !isVelexisErrorLike(error) || error.code !== "ENVIRONMENT_NOT_ALLOWED") {
      return redirectOnSessionError(error);
    }
  }
  if (staff !== undefined && canOpenEnvironment(staff, wanted)) {
    return { console: client, staff, environment: wanted, liveRefused: false };
  }

  const testClient = clientIn("test");
  try {
    staff = await testClient.auth.me();
  } catch (error) {
    return redirectOnSessionError(error);
  }
  return { console: testClient, staff, environment: "test", liveRefused: true };
});

/**
 * The console client of this request (React `cache`), for server components, in the environment the request works
 * in (`getConsoleRequest`).
 */
export const getConsole = cache(async (): Promise<ConsoleApi> => (await getConsoleRequest()).console);

/**
 * `console.auth.me` once per request (React `cache`): the staff member, the OTA, the permissions that drive the
 * navigation and the buttons (`can()`), and the environments of the switch. An expired session redirects to
 * `/auth/refresh`, an ended one to the portal.
 */
export const getStaff = cache(async (): Promise<ConsoleStaffProfile> => (await getConsoleRequest()).staff);
