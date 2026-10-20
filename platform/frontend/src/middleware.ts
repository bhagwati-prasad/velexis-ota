// Portal middleware (README §6 and §7): runs before every page, server action and route handler except the health
// routes and static files. It refreshes an expired access token before anything renders, moves the single-use token
// of an e-mail link (`/reset-password?token=…`, `/invitations/accept?token=…`) into its cookie, sends people without
// a session away from the signed-in area, and sets the per-request nonce-based Content-Security-Policy.
import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { createPlatformApi, requestIdOf } from "@/lib/api";
import { getConfig, type PortalConfig } from "@/lib/config";
import { NONCE_HEADER, contentSecurityPolicy, createNonce } from "@/lib/csp";
import {
  ACCESS_TOKEN_COOKIE,
  INVITATION_COOKIE,
  PASSWORD_RESET_COOKIE,
  REFRESH_TOKEN_COOKIE,
  accessTokenClaims,
  clearedCookie,
  clearedSessionCookies,
  invitationCookie,
  isAccessTokenFresh,
  passwordResetCookie,
  refresh,
  safeNextPath,
  sessionCookies,
  writeCookies,
  type AccessTokenClaims,
  type CookieWrite,
  type PortalCookieName,
} from "@/lib/session";
import { TOKEN_LINK_STRINGS } from "@/lib/strings";

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

/** A page whose e-mail link carries a single-use token in `?token=`, and the cookie the token moves into. */
interface TokenLink {
  readonly cookie: PortalCookieName;
  readonly write: (token: string) => CookieWrite;
}

/**
 * The pages opened from a link with `?token=` (README §6). Pages cannot set cookies in Next.js, so the middleware
 * moves the token before the page renders (`tokenLinkRedirect`).
 */
const TOKEN_LINKS: Readonly<Record<string, TokenLink>> = Object.freeze({
  "/reset-password": { cookie: PASSWORD_RESET_COOKIE, write: passwordResetCookie },
  "/invitations/accept": { cookie: INVITATION_COOKIE, write: invitationCookie },
});

/** `OpaqueToken` of the platform document: a longer token cannot be one Velexis issued. */
const TOKEN_MAX_LENGTH = 512;

const HTML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/** `value` as HTML text or attribute value. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * The page that takes the browser on to `target`, the token link without its token: a declarative refresh (with a
 * plain link for a browser that does not follow refreshes), no script and no form. It is not a `303` because a
 * browser sends a `SameSite=Strict` cookie only with a navigation that the portal itself started: a redirect keeps
 * the start of the navigation it continues, so after a `303` the page of a link clicked in web mail (a navigation
 * started by another site) would not get the cookie that was just set, and would say the link is missing. The
 * refresh is a new navigation started by this page, and it replaces this page in the history.
 */
function tokenLinkPage(target: URL): string {
  const href = escapeHtml(target.href);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0; url=${href}">`,
    `<title>${escapeHtml(TOKEN_LINK_STRINGS.title)}</title>`,
    "</head>",
    "<body>",
    `<main><p><a href="${href}">${escapeHtml(TOKEN_LINK_STRINGS.continue)}</a></p></main>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * The answer to `GET` or `HEAD` of a token link: the token of `?token=` goes into its httpOnly `__Host-` cookie
 * (`SameSite=Strict`, 15 minutes) and a page without script takes the browser on to the same URL without the token
 * (`tokenLinkPage`), so the token never stays in the address bar or the history and never reaches the rendered
 * page, a `Referer` (`Referrer-Policy: no-referrer`) or browser JavaScript. Other query parameters are kept. An empty
 * or over-long token deletes an older cookie instead, so the page says the link is no good rather than using an
 * older one. `undefined` for every other request.
 */
export function tokenLinkRedirect(request: NextRequest, portalUrl: string): NextResponse | undefined {
  const { pathname, searchParams } = request.nextUrl;
  const link = Object.hasOwn(TOKEN_LINKS, pathname) ? TOKEN_LINKS[pathname] : undefined;
  if (link === undefined || !searchParams.has("token") || !["GET", "HEAD"].includes(request.method)) {
    return undefined;
  }
  const token = searchParams.get("token") ?? "";
  const clean = new URL(pathname, portalUrl);
  for (const [name, value] of searchParams) {
    if (name !== "token") {
      clean.searchParams.append(name, value);
    }
  }
  const response = new NextResponse(tokenLinkPage(clean), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
  const usable = token !== "" && token.length <= TOKEN_MAX_LENGTH;
  writeCookies(response.cookies, [usable ? link.write(token) : clearedCookie(link.cookie)]);
  return response;
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
  const tokenLink = tokenLinkRedirect(request, settings.PUBLIC_PORTAL_URL);
  let response: NextResponse;
  if (tokenLink !== undefined) {
    response = tokenLink;
  } else if (appRoute && session.claims === undefined) {
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
