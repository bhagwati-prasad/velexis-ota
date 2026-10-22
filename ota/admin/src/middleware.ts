// OTA admin middleware (README §4 and §10, OADR-0018 point 3): runs in the Node.js runtime before every page, server
// action and route handler except Next.js's own files, the favicon and the health routes. It lives in `src/`, next to
// `app/`: Next.js ignores a `middleware.ts` at the app root when the app uses `src/`.
//
// 1. Session. An access token that is missing or expires within 60 s is refreshed through the process-wide
//    de-duplication (`refreshStaffSession`, lib/refresh-dedup.ts), so parallel requests that carry the same rotating
//    refresh token make one call and all get the same new tokens. The response sets the new cookies, and the request
//    goes on with them in its own `Cookie` header, so the page or the server action of this request already uses them.
//    - No session (no token at all, nothing left to refresh with, or a refresh the API refused for good): the access,
//      refresh and environment cookies are cleared where needed and the request goes to the portal's console page,
//      `${PUBLIC_PORTAL_URL}/console?tenant=<id>` when the tenant cookie names the OTA (PADR-0007 §5). Deny by
//      default: every path is the signed-in console except the four session routes (`/sso`, `/auth/refresh`,
//      `/auth/sign-out`, `/signed-out`), which handle sessions themselves and are never refreshed here.
//    - A refresh that failed for a reason that may pass (rate limit, API unavailable) keeps the cookies. A still valid
//      access token goes on; an expired one is left out of the request, so a server component goes to
//      `/auth/refresh` (which tries again) and a server action's `requireStaff()` tries again itself.
// 2. Content-Security-Policy with a fresh nonce on every answer (README §10, ADR-0014): Next.js reads the policy from
//    the request headers and puts the nonce on the scripts it renders; `x-nonce` hands it to a server component that
//    renders a script of its own. It replaces the static `frame-ancestors 'none'` policy of next.config.ts, which
//    stays for the answers the middleware does not see (static files, health routes).
import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { getConfig } from "@/config";
import { SIGNED_OUT_PATH, SIGN_OUT_PATH, SSO_PATH } from "@/lib/auth-routes";
import {
  REFRESH_PATH,
  STAFF_ACCESS_TOKEN_COOKIE,
  accessTokenExpiry,
  accessTokenNeedsRefresh,
  clearedSessionCookies,
  portalConsoleUrl,
  readSessionCookies,
  staffSessionCookies,
  writeCookies,
  type CookieWrite,
} from "@/lib/session";
import { refreshStaffSession } from "@/lib/velexis";

export const config = {
  // The Node.js runtime: the de-duplication map must live in the admin process itself (one process on the single VM,
  // ADR-0007), shared with the app's bundles through `globalThis`, and the configuration is read with node:fs.
  runtime: "nodejs",
  // Everything but Next.js's own files (`/_next/…`: static chunks, images, the development server's HMR), the favicon
  // and the health routes, which deploy.sh polls without a session.
  matcher: ["/((?!_next/|favicon.ico|health/).*)"],
};

/**
 * The routes that work without a staff session, by exact path. Every other path needs one, including paths that do
 * not exist yet, so a new page is never public by accident.
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  SSO_PATH,
  REFRESH_PATH,
  SIGN_OUT_PATH,
  SIGNED_OUT_PATH,
]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

// ---- Content-Security-Policy ---------------------------------------------------------------------------------

/** The request header that hands the nonce to server components that render their own `<script>`. */
export const NONCE_HEADER = "x-nonce";

/** A base64 nonce: only these characters may go into the header. */
const NONCE = /^[A-Za-z0-9+/]{22,}={0,2}$/;

/** A fresh nonce of 128 random bits, base64-encoded. */
export function createNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

/**
 * The admin's policy (README §10):
 * - scripts only from the admin and with this response's nonce; no inline script without it (`'unsafe-eval'` is
 *   added for `next dev` only, which evaluates its modules);
 * - styles from the admin; inline styles are allowed (`style` attributes of components), scripts are not;
 * - images from the admin and `data:` URLs; fonts and everything else from the admin only;
 * - `connect-src 'self'`: the browser talks to the admin only (server actions), never to the OTA API;
 * - `form-action 'self'`: forms post to the admin only (the sign-out button, server actions);
 * - the admin is never framed (`frame-ancestors 'none'`), `<base>` cannot point elsewhere, no plugins.
 */
export function contentSecurityPolicy(options: { nonce: string; development: boolean }): string {
  if (!NONCE.test(options.nonce)) {
    throw new TypeError("The CSP nonce must be a base64 string of at least 128 bits");
  }
  const scriptSources = [
    "'self'",
    `'nonce-${options.nonce}'`,
    ...(options.development ? ["'unsafe-eval'"] : []),
  ];
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    ["script-src", ...scriptSources],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:"],
    ["font-src", "'self'"],
    ["connect-src", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
    ["base-uri", "'self'"],
    ["object-src", "'none'"],
  ];
  return directives.map((directive) => directive.join(" ")).join("; ");
}

// ---- Session ----------------------------------------------------------------------------------------------

interface SessionState {
  /** The request may go on: it has a usable session, or one that a later step may still renew. */
  readonly signedIn: boolean;
  /** Cookies the response sets: the new session after a refresh, or deletions when the session is over. */
  readonly writes: readonly CookieWrite[];
  /** Session cookies of the request as the page or the action must see them (`undefined`: left out). */
  readonly forward: ReadonlyMap<string, string | undefined>;
  /** The tenant of the tenant cookie, for the redirect to the portal. */
  readonly tenantId?: string | undefined;
}

/** `token` is a readable access token that has not expired yet. */
function stillValid(token: string | undefined, now: number): boolean {
  const expiry = token === undefined ? undefined : accessTokenExpiry(token);
  return expiry !== undefined && expiry > now;
}

/** The session of the request, refreshed when the access token is missing or expires within 60 s. */
async function resolveSession(request: NextRequest, now: number): Promise<SessionState> {
  const session = readSessionCookies(request.cookies);
  const { accessToken, refreshToken, tenantId } = session;
  const unchanged: SessionState = { signedIn: true, writes: [], forward: new Map(), tenantId };
  if (!accessTokenNeedsRefresh(accessToken, now)) {
    return unchanged;
  }
  if (refreshToken === undefined) {
    if (stillValid(accessToken, now)) {
      return unchanged;
    }
    // Nothing left to refresh with: the session is over.
    return {
      signedIn: false,
      writes: accessToken === undefined ? [] : clearedSessionCookies(),
      forward: new Map(),
      tenantId,
    };
  }

  const outcome = await refreshStaffSession(refreshToken, request.headers);
  if (outcome.ok) {
    const writes = staffSessionCookies(outcome.session, { environment: session.environment, now });
    return {
      signedIn: true,
      writes,
      forward: new Map(writes.map((write) => [write.name, write.value])),
      tenantId,
    };
  }
  if (outcome.final) {
    return { signedIn: false, writes: clearedSessionCookies(), forward: new Map(), tenantId };
  }
  // A failure that may pass: keep the cookies for the next attempt.
  if (stillValid(accessToken, now)) {
    return unchanged;
  }
  return {
    signedIn: true,
    writes: [],
    forward: new Map([[STAFF_ACCESS_TOKEN_COOKIE, undefined]]),
    tenantId,
  };
}

/** The `Cookie` header of the request with the session cookies replaced as `forward` says. */
function cookieHeader(request: NextRequest, forward: ReadonlyMap<string, string | undefined>): string {
  const cookies = new Map(request.cookies.getAll().map((cookie) => [cookie.name, cookie.value]));
  for (const [name, value] of forward) {
    if (value === undefined) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const settings = getConfig();
  const nonce = createNonce();
  const csp = contentSecurityPolicy({ nonce, development: settings.APP_ENV === "development" });

  const session: SessionState = isPublicPath(request.nextUrl.pathname)
    ? { signedIn: true, writes: [], forward: new Map() }
    : await resolveSession(request, Date.now());

  let response: NextResponse;
  if (session.signedIn) {
    const forwarded = new Headers(request.headers);
    if (session.forward.size > 0) {
      const cookies = cookieHeader(request, session.forward);
      if (cookies === "") {
        forwarded.delete("cookie");
      } else {
        forwarded.set("cookie", cookies);
      }
    }
    // Next.js reads the policy from the request headers and puts its nonce on the scripts it renders.
    forwarded.set(NONCE_HEADER, nonce);
    forwarded.set("content-security-policy", csp);
    response = NextResponse.next({ request: { headers: forwarded } });
  } else {
    // A `303 See Other`: a form post (or a server action) continues with a GET of the portal's console page.
    response = NextResponse.redirect(portalConsoleUrl(settings.PUBLIC_PORTAL_URL, session.tenantId), 303);
    response.headers.set("Cache-Control", "no-store");
  }
  writeCookies(response.cookies, session.writes);
  response.headers.set("Content-Security-Policy", csp);
  return response;
}
