// Portal middleware (README §6 and §7): runs before every page, server action and route handler except the health
// routes and static files. It refreshes an expired access token before anything renders, sends people without a
// session away from the signed-in area, and sets the per-request nonce-based Content-Security-Policy.
import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { createPlatformApi, requestIdOf } from "@/lib/api";
import { getConfig, type PortalConfig } from "@/lib/config";
import { NONCE_HEADER, contentSecurityPolicy, createNonce } from "@/lib/csp";
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
  // The Node.js runtime: the single-flight refresh map must live in the portal process itself, and the
  // configuration is read with node:fs (`getConfig`).
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico|health/).*)"],
};

/** URL prefixes of the `(app)` route group: they need the session of a verified account. */
export const APP_ROUTE_PREFIXES = ["/dashboard", "/otas", "/console", "/account"] as const;

export const SIGN_IN_PATH = "/sign-in";
export const VERIFY_PENDING_PATH = "/verify-pending";

export function isAppRoute(pathname: string): boolean {
  return APP_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * `/sign-in` on the portal's public URL, with `next` set to the requested path and query when they form a safe
 * relative path (`lib/session.ts` `safeNextPath`). A path such as `//evil.example/x` gets no `next` at all.
 */
export function signInUrl(request: NextRequest, portalUrl: string): URL {
  const url = new URL(SIGN_IN_PATH, portalUrl);
  const next = safeNextPath(`${request.nextUrl.pathname}${request.nextUrl.search}`);
  if (next !== undefined) {
    url.searchParams.set("next", next);
  }
  return url;
}

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
 * never passed on; it is refreshed with the refresh token (single-flighted, `lib/session.ts`), and the new tokens
 * replace the old ones in the request's own cookies too, so the page rendered for this request already uses
 * them. A refresh token that can never work again deletes both cookies; a failure that may pass (rate limit, API
 * unavailable) keeps them for the next request.
 */
async function resolveSession(
  request: NextRequest,
  forwarded: Headers,
  settings: PortalConfig,
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

/** A `303 See Other`: a form post (or a server action) to a page continues with a GET of the target. */
function redirectTo(url: URL): NextResponse {
  return NextResponse.redirect(url, 303);
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const settings = getConfig();
  const nonce = createNonce();
  const csp = contentSecurityPolicy({
    nonce,
    otaAdminUrl: settings.PUBLIC_OTA_ADMIN_URL,
    development: settings.APP_ENV === "development",
  });

  // Caddy sets a request id on every request (ADR-0016); without a valid one (development) the request gets a fresh
  // one, so the API calls of one page share it.
  const forwarded = new Headers(request.headers);
  if (requestIdOf(forwarded) === undefined) {
    forwarded.set("x-request-id", crypto.randomUUID());
  }
  const session = await resolveSession(request, forwarded, settings);

  const appRoute = isAppRoute(request.nextUrl.pathname);
  let response: NextResponse;
  if (appRoute && session.claims === undefined) {
    response = redirectTo(signInUrl(request, settings.PUBLIC_PORTAL_URL));
  } else if (appRoute && session.claims?.emailVerified !== true) {
    response = redirectTo(new URL(VERIFY_PENDING_PATH, settings.PUBLIC_PORTAL_URL));
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
  return response;
}
