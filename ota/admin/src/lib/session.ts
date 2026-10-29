// The staff session of the OTA admin (README §4, OADR-0018 points 2–4, OADR-0011 points 2 and 5): four `__Host-`
// cookies that browser JavaScript cannot read, written and read on the server only, and `requireStaff()` for server
// actions.
//
//   __Host-vx_staff_at   the staff access token (JWT), until it expires (15 min)
//   __Host-vx_staff_rt   the rotating refresh token, until the family's absolute end (at most 12 h)
//   __Host-vx_env        `test` or `live`, the environment of the switch (12 h)
//   __Host-vx_tenant     the tenant id, only for the redirect back to the portal (12 h, kept after a sign-out)
//
// All are `HttpOnly; Secure; SameSite=Lax; Path=/`: `Lax` because the session starts with a cross-site POST from the
// portal, and the redirected first page load must carry the cookies. Without a session the admin sends people to
// `${PUBLIC_PORTAL_URL}/console?tenant=<tenantId>` (PADR-0007 §5).
//
// Refreshes happen only where cookies can be written (middleware, route handlers, server actions) and always through
// the de-duplicated `refreshStaffSession` (lib/velexis.ts, lib/refresh-dedup.ts). Server components never refresh:
// they redirect to `/auth/refresh?next=…`. This module and lib/velexis.ts import each other; both use the other's
// exports only inside functions.
import "server-only";

import {
  PermissionError,
  type ConsoleApi,
  type ConsoleStaffProfile,
  type ConsoleStaffSession,
  type StaffPermission,
} from "@velexis/ota-sdk";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getConfig } from "@/config";
import { can, type StaffEnvironment } from "@/lib/permissions";
import { createConsoleClient, refreshStaffSession } from "@/lib/velexis";

/** The staff access token (JWT, 15 minutes). */
export const STAFF_ACCESS_TOKEN_COOKIE = "__Host-vx_staff_at";
/** The staff refresh token, until the family's absolute end (at most 12 hours). */
export const STAFF_REFRESH_TOKEN_COOKIE = "__Host-vx_staff_rt";
/** The environment of the switch, `test` or `live`. */
export const ENVIRONMENT_COOKIE = "__Host-vx_env";
/** The tenant id, for the redirect back to the portal. */
export const TENANT_COOKIE = "__Host-vx_tenant";

/** The name of one OTA admin cookie. */
export type StaffCookieName =
  | typeof STAFF_ACCESS_TOKEN_COOKIE
  | typeof STAFF_REFRESH_TOKEN_COOKIE
  | typeof ENVIRONMENT_COOKIE
  | typeof TENANT_COOKIE;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
/** The longest life of each cookie, in seconds (README §4). */
export const COOKIE_MAX_AGE: Readonly<Record<StaffCookieName, number>> = Object.freeze({
  [STAFF_ACCESS_TOKEN_COOKIE]: 15 * MINUTE,
  [STAFF_REFRESH_TOKEN_COOKIE]: 12 * HOUR,
  [ENVIRONMENT_COOKIE]: 12 * HOUR,
  [TENANT_COOKIE]: 12 * HOUR,
});

/** The attributes of every OTA admin cookie: the `__Host-` prefix needs `Secure`, `Path=/` and no `Domain`. */
export interface StaffCookieOptions {
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "lax";
  readonly path: "/";
  /** Seconds; 0 deletes the cookie. */
  readonly maxAge: number;
}

/** One cookie to set (or, with `maxAge` 0 and an empty value, to delete). */
export interface CookieWrite {
  readonly name: StaffCookieName;
  readonly value: string;
  readonly options: StaffCookieOptions;
}

/** Where cookies are written: `NextResponse#cookies` in middleware, `cookies()` in actions and route handlers. */
export interface CookieSink {
  set(name: string, value: string, options: StaffCookieOptions): unknown;
}

/** Where cookies are read: `NextRequest#cookies` in middleware, `cookies()` elsewhere. */
export interface CookieSource {
  get(name: string): { readonly value: string } | undefined;
}

/** One cookie with the attributes of OADR-0018 point 2. */
export function staffCookie(name: StaffCookieName, value: string, maxAge: number): CookieWrite {
  return { name, value, options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge } };
}

/** Whole seconds from `now` until `isoTime`, kept within `[1, max]`; `max` when the time cannot be read. */
function secondsUntil(isoTime: string, now: number, max: number): number {
  const seconds = Math.floor((Date.parse(isoTime) - now) / 1000);
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), max) : max;
}

/**
 * The environment to keep after a sign-in or a refresh: the wanted one when the session allows it, else `test`
 * (always allowed). OADR-0018 point 6: `__Host-vx_env` only ever holds a value of `session.environments`.
 */
export function allowedEnvironment(
  wanted: StaffEnvironment | undefined,
  allowed: readonly StaffEnvironment[],
): StaffEnvironment {
  return wanted !== undefined && allowed.includes(wanted) ? wanted : "test";
}

/** The `__Host-vx_env` cookie for an environment (the switch's server action checks it against the session). */
export function environmentCookie(environment: StaffEnvironment): CookieWrite {
  return staffCookie(ENVIRONMENT_COOKIE, environment, COOKIE_MAX_AGE[ENVIRONMENT_COOKIE]);
}

/** Options of `staffSessionCookies`. */
export interface StaffSessionCookieOptions {
  /** The environment to keep (the current cookie's); `test` when the session does not allow it. */
  readonly environment?: StaffEnvironment | undefined;
  /** The clock, epoch ms. */
  readonly now?: number;
}

/**
 * The four cookies of a new or refreshed staff session (`console.auth.signIn` or `.refresh`): each token lives as
 * long as it is valid, the environment and the tenant 12 hours.
 */
export function staffSessionCookies(
  result: ConsoleStaffSession,
  options: StaffSessionCookieOptions = {},
): CookieWrite[] {
  const now = options.now ?? Date.now();
  const { session } = result;
  return [
    staffCookie(
      STAFF_ACCESS_TOKEN_COOKIE,
      session.accessToken,
      secondsUntil(session.accessTokenExpiresAt, now, COOKIE_MAX_AGE[STAFF_ACCESS_TOKEN_COOKIE]),
    ),
    staffCookie(
      STAFF_REFRESH_TOKEN_COOKIE,
      session.refreshToken,
      secondsUntil(session.refreshTokenExpiresAt, now, COOKIE_MAX_AGE[STAFF_REFRESH_TOKEN_COOKIE]),
    ),
    environmentCookie(allowedEnvironment(options.environment, result.environments)),
    staffCookie(TENANT_COOKIE, result.tenant.id, COOKIE_MAX_AGE[TENANT_COOKIE]),
  ];
}

/**
 * Deletes a cookie. `cookies().delete()` would write `Path=/` without `Secure`, which a browser refuses for a
 * `__Host-` cookie, so the cookie is overwritten with an empty value, the same attributes and `Max-Age=0`.
 */
export function clearedCookie(name: StaffCookieName): CookieWrite {
  return staffCookie(name, "", 0);
}

/**
 * Deletes the session (sign-out, a refresh token that can never work again): the two tokens and the environment.
 * The tenant cookie stays, so the next visit still goes back to this OTA in the portal.
 */
export function clearedSessionCookies(): CookieWrite[] {
  return [
    clearedCookie(STAFF_ACCESS_TOKEN_COOKIE),
    clearedCookie(STAFF_REFRESH_TOKEN_COOKIE),
    clearedCookie(ENVIRONMENT_COOKIE),
  ];
}

/** Writes `writes` to `sink`. */
export function writeCookies(sink: CookieSink, writes: readonly CookieWrite[]): void {
  for (const write of writes) {
    sink.set(write.name, write.value, write.options);
  }
}

/** A tenant id as the platform writes it: `ten_` and a ULID (db README §2.1). */
const TENANT_ID_PATTERN = /^ten_[0-9A-Za-z]{26}$/;

/** The environment of a cookie value: `live` only when it says exactly that, `test` otherwise. */
export function parseEnvironment(value: string | undefined): StaffEnvironment {
  return value === "live" ? "live" : "test";
}

/** The tenant id of a cookie value, or `undefined` when it is not one. */
export function parseTenantId(value: string | undefined): string | undefined {
  return value !== undefined && TENANT_ID_PATTERN.test(value) ? value : undefined;
}

/** What the cookies of a request hold; an empty cookie counts as absent. */
export interface StaffSessionCookies {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly environment: StaffEnvironment;
  readonly tenantId?: string;
}

/** The session cookies of a request. */
export function readSessionCookies(source: CookieSource): StaffSessionCookies {
  const accessToken = source.get(STAFF_ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = source.get(STAFF_REFRESH_TOKEN_COOKIE)?.value;
  const tenantId = parseTenantId(source.get(TENANT_COOKIE)?.value);
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    environment: parseEnvironment(source.get(ENVIRONMENT_COOKIE)?.value),
    ...(tenantId === undefined ? {} : { tenantId }),
  };
}

// ---- Access token expiry ------------------------------------------------------------------------------------

/** An access token this close to its expiry is refreshed first (OADR-0018 point 3), in ms. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * The expiry of a staff access token (its `exp` claim), epoch ms, or `undefined` when it is not a readable JWT. The
 * signature is **not** checked: the API checks it on every call. The admin reads the claim only to decide when to
 * refresh, and a forged cookie gets no further than calls that the API answers with 401.
 */
export function accessTokenExpiry(token: string): number | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    return undefined;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const exp = typeof claims === "object" && claims !== null ? (claims as { exp?: unknown }).exp : undefined;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

/** The access token is missing, unreadable or expires within the next 60 seconds. */
export function accessTokenNeedsRefresh(token: string | undefined, now: number = Date.now()): boolean {
  const expiry = token === undefined ? undefined : accessTokenExpiry(token);
  return expiry === undefined || expiry - now <= ACCESS_TOKEN_REFRESH_MARGIN_MS;
}

/** The access token can still be sent: it is readable and has not expired. */
function accessTokenUsable(token: string | undefined, now: number): token is string {
  const expiry = token === undefined ? undefined : accessTokenExpiry(token);
  return expiry !== undefined && expiry > now;
}

// ---- Redirects ----------------------------------------------------------------------------------------------

/** The route handler that refreshes for server components (OAD-003). */
export const REFRESH_PATH = "/auth/refresh";

const NEXT_PATH_MAX_LENGTH = 2048;
const NEXT_PATH_BASE = "https://admin.invalid";
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
const NEXT_PATH_UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/** A path on this origin: one leading `/` but not two (`//host` is protocol-relative), no control character or `\`. */
function isOwnOriginPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !NEXT_PATH_UNSAFE_CHARACTERS.test(path);
}

/**
 * `next` when it is a relative path on the admin, otherwise `undefined`: absolute URLs, protocol-relative ones
 * (`//evil.example`, `/\evil.example`), anything with a control character or a backslash, and values longer than
 * 2 048 characters are dropped. The result is the path, query and fragment as the URL parser normalises them, and
 * it is checked again after that, with the same rule (FIX-W26-SECURITY): dot segments (`/.//evil.example`,
 * `/a/..//evil.example`, `/%2e%2e//evil.example`) normalise to the protocol-relative `//evil.example`, which a browser
 * would follow to another host.
 */
export function safeNextPath(next: string | null | undefined): string | undefined {
  if (typeof next !== "string" || next.length === 0 || next.length > NEXT_PATH_MAX_LENGTH) {
    return undefined;
  }
  if (!isOwnOriginPath(next)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(next, NEXT_PATH_BASE);
  } catch {
    return undefined;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  return url.origin === NEXT_PATH_BASE && isOwnOriginPath(path) ? path : undefined;
}

/**
 * The request header the middleware sets on every request it lets through: the page's path and query as the browser
 * asked for it (`pagePathOfUrl`), so a server component that sends the staff member to `/auth/refresh` comes back to
 * the same page (`pagePathOf`; FIX-W33-OTA, lead decision (1l) of 2026-10-29). The middleware always overwrites it, so
 * a value the browser sent never reaches a page; it is still read through `safeNextPath`.
 */
export const PAGE_PATH_HEADER = "x-velexis-page-path";

/** Next.js's own query parameter of a client navigation's server-component request: not part of the page's address. */
const RSC_QUERY_PARAMETER = "_rsc";

/** The path and query of `url` as the page's address (`PAGE_PATH_HEADER`), without Next.js's `_rsc` parameter. */
export function pagePathOfUrl(url: Pick<URL, "pathname" | "searchParams">): string {
  const query = new URLSearchParams(url.searchParams);
  query.delete(RSC_QUERY_PARAMETER);
  const search = query.toString();
  return search === "" ? url.pathname : `${url.pathname}?${search}`;
}

/** The page of this request (`PAGE_PATH_HEADER`) when it is a safe path on the admin (`safeNextPath`), else `undefined`. */
export function pagePathOf(incoming: Pick<Headers, "get">): string | undefined {
  return safeNextPath(incoming.get(PAGE_PATH_HEADER));
}

/** `/auth/refresh`, with `?next=` when `next` is a safe relative path. */
export function refreshPath(next?: string | null): string {
  const path = safeNextPath(next);
  return path === undefined
    ? REFRESH_PATH
    : `${REFRESH_PATH}?${new URLSearchParams({ next: path }).toString()}`;
}

/**
 * The portal's console page (PADR-0007 §5): `${PUBLIC_PORTAL_URL}/console`, with `?tenant=<tenantId>` when the tenant
 * is known, so the staff member lands on this OTA's "Open console" button.
 */
export function portalConsoleUrl(portalUrl: string, tenantId?: string): string {
  const url = new URL(portalUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/console`;
  url.search = "";
  url.hash = "";
  const tenant = parseTenantId(tenantId);
  if (tenant !== undefined) {
    url.searchParams.set("tenant", tenant);
  }
  return url.toString();
}

/** Sends the staff member to the portal's console page (no session, or one that ended). */
export function redirectToPortal(tenantId?: string): never {
  redirect(portalConsoleUrl(getConfig().PUBLIC_PORTAL_URL, tenantId));
}

/** Sends a server component's request to the refresh route handler, which comes back to `next`. */
export function redirectToRefresh(next?: string | null): never {
  redirect(refreshPath(next));
}

/** The session cookies of this request; redirects to the portal when it carries neither token. */
export async function readSession(): Promise<StaffSessionCookies> {
  const session = readSessionCookies(await cookies());
  if (session.accessToken === undefined && session.refreshToken === undefined) {
    redirectToPortal(session.tenantId);
  }
  return session;
}

/** Codes of the API after which the session is over: the staff member signs in again through the portal. */
const SESSION_ENDED_CODES: ReadonlySet<string> = new Set([
  "UNAUTHENTICATED",
  "REFRESH_TOKEN_INVALID",
  "REFRESH_TOKEN_REUSED",
  "STAFF_MEMBERSHIP_INACTIVE",
]);

/** The error code of an SDK error, or `undefined`. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/**
 * For server components (routes.md §1): an expired access token goes to `/auth/refresh?next=…`, a session that
 * ended goes to the portal, and every other error is thrown again for the error boundary.
 */
export async function redirectOnSessionError(error: unknown, next?: string | null): Promise<never> {
  const code = codeOf(error);
  if (code === "TOKEN_EXPIRED") {
    redirectToRefresh(next);
  }
  if (code !== undefined && SESSION_ENDED_CODES.has(code)) {
    redirectToPortal(readSessionCookies(await cookies()).tenantId);
  }
  throw error;
}

/** Sets the cookies of a new or refreshed session, in a server action or a route handler. */
export async function setStaffSession(
  result: ConsoleStaffSession,
  environment?: StaffEnvironment,
): Promise<void> {
  writeCookies(await cookies(), staffSessionCookies(result, { environment }));
}

/** Deletes the session cookies, in a server action or a route handler. */
export async function clearStaffSession(): Promise<void> {
  writeCookies(await cookies(), clearedSessionCookies());
}

// ---- requireStaff -------------------------------------------------------------------------------------------

/** What a server action gets from `requireStaff`. */
export interface StaffContext {
  /** The console client of this request, with the current access token. */
  readonly console: ConsoleApi;
  /** `console.auth.me`: the staff member, the OTA, the permissions and the environments. */
  readonly staff: ConsoleStaffProfile;
  /** The environment the client sends. */
  readonly environment: StaffEnvironment;
}

/** The local refusal of `requireStaff`, shaped as the API's `403 FORBIDDEN` (`details.requiredPermission`). */
function forbidden(permission: StaffPermission): PermissionError {
  return new PermissionError({
    code: "FORBIDDEN",
    message: "The staff member's role does not allow this action.",
    status: 403,
    requestId: null,
    details: { requiredPermission: permission },
  });
}

/**
 * The first line of every server action (README §7, OADR-0018 point 4): the staff session of the request, refreshed
 * through the de-duplication when its access token is missing or expires within 60 s (the new cookies are written),
 * `console.auth.me`, and a clear early refusal when the role lacks `permission`. The API still decides and audits.
 *
 * - No session, a refresh that can never work again, or a session the API ended → the cookies are cleared where
 *   needed and the staff member goes to the portal (`redirect`).
 * - A refresh that failed for another reason (rate limit, API unavailable) is thrown when there is no access token
 *   left to try; with a usable one the action goes on with it.
 * - A missing permission throws a `PermissionError` `FORBIDDEN` with `details.requiredPermission`, before any call
 *   that changes something.
 * - A live environment the API refuses (`403 ENVIRONMENT_NOT_ALLOWED`) resets `__Host-vx_env` to `test` and is
 *   thrown, so the action answers "Live is not available for this OTA or role" (routes.md §1).
 *
 * Use the returned `console` (built with the fresh token), not `getConsole()`, inside the action.
 */
export async function requireStaff(permission: StaffPermission): Promise<StaffContext> {
  const context = await requireStaffSession();
  if (!can(context.staff, permission)) {
    throw forbidden(permission);
  }
  return context;
}

/**
 * `requireStaff` without the permission check, for the server actions that every signed-in staff member may run
 * (the environment switch of OAD-004, which weighs `session.environments` instead): the refreshed session and
 * `console.auth.me`, with the same redirects and errors.
 */
export async function requireStaffSession(): Promise<StaffContext> {
  const jar = await cookies();
  const incoming = await headers();
  const session = readSessionCookies(jar);
  let { accessToken, environment } = session;
  const now = Date.now();
  if (accessTokenNeedsRefresh(accessToken, now)) {
    if (session.refreshToken === undefined) {
      if (!accessTokenUsable(accessToken, now)) {
        // Nothing left to refresh with: the session is over.
        writeCookies(jar, clearedSessionCookies());
        redirectToPortal(session.tenantId);
      }
    } else {
      const outcome = await refreshStaffSession(session.refreshToken, incoming);
      if (outcome.ok) {
        writeCookies(jar, staffSessionCookies(outcome.session, { environment, now }));
        accessToken = outcome.session.session.accessToken;
        environment = allowedEnvironment(environment, outcome.session.environments);
      } else if (outcome.final) {
        writeCookies(jar, clearedSessionCookies());
        redirectToPortal(session.tenantId);
      } else if (!accessTokenUsable(accessToken, now)) {
        throw outcome.error;
      }
    }
  }
  if (accessToken === undefined) {
    redirectToPortal(session.tenantId);
  }
  const client = createConsoleClient({ accessToken, environment, incoming });
  let staff: ConsoleStaffProfile;
  try {
    staff = await client.auth.me();
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined && SESSION_ENDED_CODES.has(code)) {
      writeCookies(jar, clearedSessionCookies());
      redirectToPortal(session.tenantId);
    }
    if (code === "ENVIRONMENT_NOT_ALLOWED" && environment === "live") {
      // routes.md §1: the OTA or the role no longer opens live. A server action can write cookies, so the environment
      // goes back to test here; the action is still refused (never re-run in another environment than the page's),
      // and the re-render of the page after the action shows the shell in test.
      writeCookies(jar, [environmentCookie("test")]);
    }
    throw error;
  }
  return { console: client, staff, environment };
}
