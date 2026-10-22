import "server-only";

import { createHash } from "node:crypto";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { cookies } from "next/headers";

import type { ApiError, PlatformApi } from "@/lib/api";

/**
 * The portal session (README §6, ADR-0008): the platform tokens live only in `__Host-` cookies that browser
 * JavaScript cannot read, written and read on the server. `refresh()` rotates the refresh token once per token,
 * however many requests present it at the same time.
 */

/** A session as `signIn`, `verifyMfa` and `refreshSession` answer it. */
export type PortalSession = components["schemas"]["PortalSession"];

/** The platform access token (JWT, 15 minutes). */
export const ACCESS_TOKEN_COOKIE = "__Host-vxp_at";
/** The refresh token, until it stops working (at most the family's 30 days). */
export const REFRESH_TOKEN_COOKIE = "__Host-vxp_rt";
/** The MFA challenge of a sign-in in progress (5 minutes). */
export const MFA_CHALLENGE_COOKIE = "__Host-vxp_mfa";
/** A password reset token moved out of the URL (15 minutes). */
export const PASSWORD_RESET_COOKIE = "__Host-vxp_reset";
/** An invitation token moved out of the URL (15 minutes). */
export const INVITATION_COOKIE = "__Host-vxp_invite";
/** A validated relative return path (15 minutes). */
export const NEXT_PATH_COOKIE = "__Host-vxp_next";

const MINUTE = 60;
const ACCESS_TOKEN_MAX_AGE = 15 * MINUTE;
const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * MINUTE;
const MFA_CHALLENGE_MAX_AGE = 5 * MINUTE;
const TOKEN_MOVE_MAX_AGE = 15 * MINUTE;

/**
 * `SameSite=Strict` for the cookies of a flow that starts from a link in an e-mail or another site (MFA, reset,
 * invitation): they are never sent with a cross-site request. The session and return-path cookies are `Lax`, so a
 * person who follows a link to the portal arrives signed in.
 */
const SAME_SITE = {
  [ACCESS_TOKEN_COOKIE]: "lax",
  [REFRESH_TOKEN_COOKIE]: "lax",
  [MFA_CHALLENGE_COOKIE]: "strict",
  [PASSWORD_RESET_COOKIE]: "strict",
  [INVITATION_COOKIE]: "strict",
  [NEXT_PATH_COOKIE]: "lax",
} as const;

/** The name of one portal cookie. */
export type PortalCookieName = keyof typeof SAME_SITE;

/** The attributes of every portal cookie: the `__Host-` prefix requires `Secure`, `Path=/` and no `Domain`. */
export interface PortalCookieOptions {
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "lax" | "strict";
  readonly path: "/";
  /** Seconds; 0 deletes the cookie. */
  readonly maxAge: number;
}

/** One cookie to set (or, with `maxAge` 0 and an empty value, to delete). */
export interface CookieWrite {
  readonly name: PortalCookieName;
  readonly value: string;
  readonly options: PortalCookieOptions;
}

/** Where cookies are written: `NextResponse#cookies` in middleware, `cookies()` in actions and route handlers. */
export interface CookieSink {
  set(name: string, value: string, options: PortalCookieOptions): unknown;
}

/** Where cookies are read: `NextRequest#cookies` in middleware, `cookies()` elsewhere. */
export interface CookieSource {
  get(name: string): { value: string } | undefined;
}

function portalCookie(name: PortalCookieName, value: string, maxAge: number): CookieWrite {
  return {
    name,
    value,
    options: { httpOnly: true, secure: true, sameSite: SAME_SITE[name], path: "/", maxAge },
  };
}

/** Whole seconds from `now` until `isoTime`, kept within `[1, max]`; `max` when the time cannot be read. */
function secondsUntil(isoTime: string, now: number, max: number): number {
  const seconds = Math.floor((Date.parse(isoTime) - now) / 1000);
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), max) : max;
}

/** The two session cookies of a new or refreshed session, each living as long as its token. */
export function sessionCookies(session: PortalSession, now: number = Date.now()): CookieWrite[] {
  return [
    portalCookie(
      ACCESS_TOKEN_COOKIE,
      session.accessToken,
      secondsUntil(session.accessTokenExpiresAt, now, ACCESS_TOKEN_MAX_AGE),
    ),
    portalCookie(
      REFRESH_TOKEN_COOKIE,
      session.refreshToken,
      secondsUntil(session.refreshTokenExpiresAt, now, REFRESH_TOKEN_MAX_AGE),
    ),
  ];
}

/**
 * Deletes a cookie. `cookies().delete()` would write `Path=/` without `Secure`, which a browser refuses for a
 * `__Host-` cookie, so the cookie is overwritten with an empty value, the same attributes and `Max-Age=0`.
 */
export function clearedCookie(name: PortalCookieName): CookieWrite {
  return portalCookie(name, "", 0);
}

/** Deletes both session cookies (sign-out, a refresh token that can no longer work). */
export function clearedSessionCookies(): CookieWrite[] {
  return [clearedCookie(ACCESS_TOKEN_COOKIE), clearedCookie(REFRESH_TOKEN_COOKIE)];
}

/** The MFA challenge of `signIn`, for at most 5 minutes (less when the challenge expires sooner). */
export function mfaChallengeCookie(
  challengeToken: string,
  expiresInSeconds = MFA_CHALLENGE_MAX_AGE,
): CookieWrite {
  const maxAge = Math.min(Math.max(Math.floor(expiresInSeconds), 1), MFA_CHALLENGE_MAX_AGE);
  return portalCookie(MFA_CHALLENGE_COOKIE, challengeToken, maxAge);
}

/** A password reset token moved out of the URL, for 15 minutes. */
export function passwordResetCookie(token: string): CookieWrite {
  return portalCookie(PASSWORD_RESET_COOKIE, token, TOKEN_MOVE_MAX_AGE);
}

/** An invitation token moved out of the URL, for 15 minutes. */
export function invitationCookie(token: string): CookieWrite {
  return portalCookie(INVITATION_COOKIE, token, TOKEN_MOVE_MAX_AGE);
}

/** The return path after sign-in, for 15 minutes; `undefined` when `next` is not a safe relative path. */
export function nextPathCookie(next: string | null | undefined): CookieWrite | undefined {
  const path = safeNextPath(next);
  return path === undefined ? undefined : portalCookie(NEXT_PATH_COOKIE, path, TOKEN_MOVE_MAX_AGE);
}

/** Writes `writes` to `sink`. */
export function writeCookies(sink: CookieSink, writes: readonly CookieWrite[]): void {
  for (const write of writes) {
    sink.set(write.name, write.value, write.options);
  }
}

/** The session tokens of a request; an empty cookie counts as absent. */
export function sessionTokens(source: CookieSource): { accessToken?: string; refreshToken?: string } {
  const accessToken = source.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = source.get(REFRESH_TOKEN_COOKIE)?.value;
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
  };
}

/** Sets the cookies of a new session, in a server action or a route handler. */
export async function setSession(session: PortalSession): Promise<void> {
  writeCookies(await cookies(), sessionCookies(session));
}

/** Deletes the session cookies, in a server action or a route handler. */
export async function clearSession(): Promise<void> {
  writeCookies(await cookies(), clearedSessionCookies());
}

// ---- Access token claims ---------------------------------------------------------------------------------

/** What the portal reads from its access token (platform architecture §3.1). */
export interface AccessTokenClaims {
  /** Expiry, epoch seconds. */
  readonly exp: number;
  /** The `ev` claim: the account's e-mail address is verified. */
  readonly emailVerified: boolean;
}

/**
 * The claims of an access token, or `undefined` when it is not a readable JWT. The signature is **not** checked:
 * the API checks it on every call. The portal only uses the claims to decide when to refresh and where to
 * redirect, and a forged cookie gets no further than pages whose API calls all answer 401.
 */
export function accessTokenClaims(token: string): AccessTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const { exp, ev } = payload as { exp?: unknown; ev?: unknown };
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return undefined;
  }
  return { exp, emailVerified: ev === true };
}

/** An access token this close to its expiry is refreshed first, so it does not expire while a page renders. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 30_000;

/** The access token can be sent: it has claims and does not expire within the next 30 seconds. */
export function isAccessTokenFresh(
  claims: AccessTokenClaims | undefined,
  now: number = Date.now(),
): claims is AccessTokenClaims {
  return claims !== undefined && claims.exp * 1000 - now > ACCESS_TOKEN_REFRESH_MARGIN_MS;
}

// ---- Return path --------------------------------------------------------------------------------------------

const NEXT_PATH_MAX_LENGTH = 2048;
const NEXT_PATH_BASE = "https://portal.invalid";
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
const NEXT_PATH_UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/** A path on this origin: one leading `/` but not two (`//host` is protocol-relative), no control character or `\`. */
function isOwnOriginPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !NEXT_PATH_UNSAFE_CHARACTERS.test(path);
}

/**
 * `next` when it is a relative path on the portal, otherwise `undefined`: absolute URLs (`https://evil.example/x`),
 * protocol-relative ones (`//evil.example`, `/\evil.example`), anything with a control character or a backslash,
 * and values longer than 2 048 characters are dropped. The result is the path, query and fragment as the URL
 * parser normalises them, and it is checked again after that (FIX-W26-SECURITY, as OAD-002 does in the OTA admin):
 * dot segments (`/.//evil.example`, `/a/..//evil.example`, `/%2e//evil.example`, `/%2E%2E//evil.example`) normalise
 * to the protocol-relative `//evil.example`, which a browser would follow to another host.
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

/** `EmailAddress` of the platform document. */
const PREFILL_EMAIL_MAX_LENGTH = 254;

/**
 * The address of `?email=` that the sign-in and sign-up pages prefill (the links of an invitation, PFE-012): the
 * trimmed value when it has 1 to 254 characters and no control character, otherwise `undefined`. It only fills a
 * field; the person can change it, and the API checks what is sent.
 */
export function prefillEmail(value: string | null | undefined): string | undefined {
  const email = typeof value === "string" ? value.trim() : "";
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (email === "" || email.length > PREFILL_EMAIL_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(email)) {
    return undefined;
  }
  return email;
}

// ---- Refresh ------------------------------------------------------------------------------------------------

/** How long the outcome of a refresh is reused for the same refresh token after it settled. */
export const REFRESH_REUSE_MS = 10_000;

/**
 * Error codes after which the refresh token can never work again: the session cookies are deleted. Any other
 * failure (rate limit, API unavailable) keeps them, so a later request can try again.
 */
const FINAL_REFRESH_ERRORS: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "REFRESH_TOKEN_INVALID",
  "REFRESH_TOKEN_REUSED",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
]);

/** The outcome of a refresh. `final` failures mean the person has to sign in again. */
export type RefreshOutcome =
  | { readonly ok: true; readonly session: PortalSession }
  | { readonly ok: false; readonly final: boolean; readonly error: ApiError };

/** Refreshes the session of `refreshToken` with `api` (a client for the request, without an access token). */
export type Refresh = (refreshToken: string, api: PlatformApi) => Promise<RefreshOutcome>;

/** The map key of a refresh token: its SHA-256, so the map never holds a token as a key. */
export function refreshTokenKey(refreshToken: string): string {
  return createHash("sha256").update(refreshToken, "utf8").digest("hex");
}

interface Flight {
  readonly outcome: Promise<RefreshOutcome>;
  /** Epoch ms after which the flight is forgotten; infinite while the call is pending. */
  expiresAt: number;
}

async function callRefresh(refreshToken: string, api: PlatformApi): Promise<RefreshOutcome> {
  const result = await api.POST("/v1/auth/refresh", { body: { refreshToken } });
  if (result.error === undefined) {
    return { ok: true, session: result.data };
  }
  return { ok: false, final: FINAL_REFRESH_ERRORS.has(result.error.code), error: result.error };
}

/**
 * A single-flight refresh (README §6). The first request that presents a refresh token calls `refreshSession`;
 * every request that presents the same token while that call is pending, or within 10 seconds after it
 * succeeded or failed for good, gets the same outcome without a second call. A rotated refresh token presented
 * twice would revoke the whole family (`REFRESH_TOKEN_REUSED`), and a page load sends several requests at once.
 * A failure that may pass (rate limit, API unavailable) is forgotten at once, so the next request tries again.
 *
 * The map lives in the one portal process (ADR-0007: one VM, one process per app); `now` is injectable for tests.
 */
export function createRefresh(now: () => number = Date.now): Refresh {
  const flights = new Map<string, Flight>();

  function forgetExpired(at: number): void {
    for (const [key, flight] of flights) {
      if (flight.expiresAt <= at) {
        flights.delete(key);
      }
    }
  }

  return (refreshToken, api) => {
    forgetExpired(now());
    const key = refreshTokenKey(refreshToken);
    const existing = flights.get(key);
    if (existing !== undefined) {
      return existing.outcome;
    }
    const outcome = callRefresh(refreshToken, api);
    const flight: Flight = { outcome, expiresAt: Number.POSITIVE_INFINITY };
    flights.set(key, flight);
    const forget = () => {
      if (flights.get(key) === flight) {
        flights.delete(key);
      }
    };
    outcome.then((settled) => {
      if (settled.ok || settled.final) {
        flight.expiresAt = now() + REFRESH_REUSE_MS;
      } else {
        forget();
      }
    }, forget);
    return outcome;
  };
}

/** The refresh of this portal process, used by `middleware.ts`. */
export const refresh: Refresh = createRefresh();
