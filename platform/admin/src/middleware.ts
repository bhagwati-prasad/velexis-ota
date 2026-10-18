// Platform admin middleware (README §4): runs before every page, server action and route handler except the health
// routes and Next.js's own files. It refreshes an expired access token before anything renders, sends everyone
// without an admin session from every page of the console to `/sign-in` (deny by default: only the sign-in steps and
// `/sign-out` are public), and sets the per-request nonce-based Content-Security-Policy and `X-Robots-Tag: noindex`.
import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { createPlatformApi, requestIdOf } from "@/lib/api";
import { getConfig, type AdminConfig } from "@/lib/config";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  accessTokenClaims,
  clearedSessionCookies,
  isAccessTokenFresh,
  refresh,
  safeNextPath,
  sessionCookies,
  writeCookies,
  type AccessTokenClaims,
  type CookieWrite,
} from "@/lib/session";

export const config = {
  // The Node.js runtime: the single-flight refresh map must live in the admin process itself, and the
  // configuration is read with node:fs (`getConfig`).
  runtime: "nodejs",
  // Everything but Next.js's own files (`/_next/…`: static chunks, images, the development server's HMR), the
  // favicon and the health routes, which deploy.sh polls without a session.
  matcher: ["/((?!_next/|favicon.ico|health/).*)"],
};

export const SIGN_IN_PATH = "/sign-in";
export const SIGN_OUT_PATH = "/sign-out";

/**
 * The routes that work without an admin session, by exact path: the two sign-in steps (`/sign-in`, `/sign-in/mfa`)
 * and the `/sign-out` route handler. Every other path is the `(app)` area of README §2 and needs a session,
 * including paths that do not exist yet (`/sign-in/anything-else` too), so a new page is never public by accident.
 * Next.js redirects a trailing slash (`/sign-in/`) to the path without it before the middleware runs.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([SIGN_IN_PATH, `${SIGN_IN_PATH}/mfa`, SIGN_OUT_PATH]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/**
 * `/sign-in` on the admin's public URL, with `next` set to the requested path and query when they form a safe
 * relative path (`lib/session.ts` `safeNextPath`) other than the dashboard. A path such as `//evil.example/x` gets
 * no `next` at all.
 */
export function signInUrl(request: NextRequest, adminUrl: string): URL {
  const url = new URL(SIGN_IN_PATH, adminUrl);
  const next = safeNextPath(`${request.nextUrl.pathname}${request.nextUrl.search}`);
  if (next !== undefined && next !== "/") {
    url.searchParams.set("next", next);
  }
  return url;
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
 * The admin's policy (README §4), the portal's without its SSO hand-off:
 * - scripts only from the admin and with this response's nonce; no inline script without it (`'unsafe-eval'` is
 *   added for `next dev` only, which evaluates its modules);
 * - styles from the admin; inline styles are allowed (`style` attributes of components), scripts are not;
 * - images from the admin and `data:` URLs; fonts and everything else from the admin only;
 * - `connect-src 'self'`: the browser talks to the admin only (server actions), never to the API;
 * - `form-action 'self'`: forms post to the admin only;
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
  /** Claims of a usable access token (refreshed when needed); `undefined` without a session. */
  readonly claims?: AccessTokenClaims;
  /** Cookies the response sets: new tokens after a refresh, or deletions when the session is over. */
  readonly writes: readonly CookieWrite[];
  /** Session cookies of the request as the rendered page must see them (`undefined`: removed). */
  readonly forward: ReadonlyMap<string, string | undefined>;
}

/**
 * The session of the request. A fresh access token is used as it is. An expired, unreadable or missing one is
 * never passed on; it is refreshed with the refresh token (`adminRefresh`, single-flighted in `lib/session.ts`),
 * and the new tokens replace the old ones in the request's own cookies too, so the page rendered for this request
 * already uses them. A refresh token that can never work again deletes both cookies; a failure that may pass
 * (rate limit, API unavailable) keeps them for the next request.
 */
async function resolveSession(
  request: NextRequest,
  forwarded: Headers,
  settings: AdminConfig,
): Promise<SessionState> {
  const accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  const claims = accessToken ? accessTokenClaims(accessToken) : undefined;
  if (isAccessTokenFresh(claims)) {
    return { claims, writes: [], forward: new Map() };
  }
  const forward = new Map<string, string | undefined>([[ACCESS_TOKEN_COOKIE, undefined]]);
  if (!refreshToken) {
    return { writes: accessToken ? clearedSessionCookies() : [], forward };
  }
  // adminRefresh is public: no bearer token, but the end-user headers of PADR-0019 like every other call.
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: forwarded,
  });
  const outcome = await refresh(refreshToken, api);
  if (outcome.ok) {
    const writes = sessionCookies(outcome.session);
    for (const write of writes) {
      forward.set(write.name, write.value);
    }
    const refreshed = accessTokenClaims(outcome.session.accessToken);
    return { ...(isAccessTokenFresh(refreshed) ? { claims: refreshed } : {}), writes, forward };
  }
  if (outcome.final) {
    forward.set(REFRESH_TOKEN_COOKIE, undefined);
    return { writes: clearedSessionCookies(), forward };
  }
  return { writes: [], forward };
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

  // Caddy sets a request id on every request (ADR-0016); without a valid one (development) the request gets a fresh
  // one, so the API calls of one page share it.
  const forwarded = new Headers(request.headers);
  if (requestIdOf(forwarded) === undefined) {
    forwarded.set("x-request-id", crypto.randomUUID());
  }
  const session = await resolveSession(request, forwarded, settings);

  let response: NextResponse;
  if (session.claims === undefined && !isPublicPath(request.nextUrl.pathname)) {
    // A `303 See Other`: a form post (or a server action) to a page continues with a GET of the sign-in page.
    response = NextResponse.redirect(signInUrl(request, settings.PUBLIC_PLATFORM_ADMIN_URL), 303);
    response.headers.set("Cache-Control", "no-store");
  } else {
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
  }
  writeCookies(response.cookies, session.writes);
  response.headers.set("Content-Security-Policy", csp);
  // next.config.ts sends it on every response too; the middleware's own answers (redirects) carry it themselves.
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}
