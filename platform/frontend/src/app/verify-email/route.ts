// `GET /verify-email?token=…` (README §2 Auth, platform/docs/flows/signup-and-create-ota.md step 3, PF-02 AC1,
// PADR-0008 item 4): the target of the link in the verification e-mail. It consumes the token on the server
// (`verifyEmail`) and answers `303` to a clean URL, so the token neither stays in the address bar nor reaches a
// `Referer`: `/sign-in?verified=1`, `/dashboard` for a signed-in account, or `/verify-pending?error=token` for an
// expired, used or unknown link. The answer carries `Referrer-Policy: no-referrer` (next.config.ts sets the same
// for this path, because Next.js keeps its configured headers over a route handler's) and `Cache-Control: no-store`.
// `HEAD` never consumes the token (see `HEAD` below).
//
// A sign-up in this browser may have kept a return path (`__Host-vxp_verify_next`, FIX-W69-SIGNUP, KI-008, KI-009:
// the invitation's `/invitations/accept`, or `/otas/new?plan=<code>` for the plan chosen on `/pricing`). After a
// successful verification it is checked with `safeNextPath()` again and deleted, and the browser continues to
// `/sign-in?verified=1&next=<path>` without a session, or to the path itself with one (a page that refreshes to it,
// `continuePage`). A missing or unsafe value changes no target; a refused or unchecked link leaves the cookie for the
// next link. A link opened in another browser has no such cookie and keeps the targets above.
import { NextResponse, type NextRequest } from "next/server";

import { createPlatformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import {
  REFRESH_TOKEN_COOKIE,
  VERIFY_NEXT_COOKIE,
  clearedCookie,
  clearedSessionCookies,
  refresh,
  safeNextPath,
  sessionCookies,
  writeCookies,
  type CookieWrite,
} from "@/lib/session";
import { TOKEN_LINK_STRINGS } from "@/lib/strings";

export const dynamic = "force-dynamic";

/** `OpaqueToken` of the platform document: a token longer than this cannot be one Velexis issued. */
const TOKEN_MAX_LENGTH = 512;

/**
 * Where the handler sends the browser. None of them carries the token. (Not exported: a route module may only
 * export its handlers and route segment options.)
 */
const VERIFY_EMAIL_TARGETS = Object.freeze({
  /** Verified, without a session: sign in to continue. */
  signIn: "/sign-in?verified=1",
  /** Verified, with a session that now says so. */
  dashboard: "/dashboard",
  /** Verified, but the session could not be renewed yet: the page offers "Continue" (or the account's own state). */
  pending: "/verify-pending",
  /** The link expired, was used or is unknown: the page offers "send a new link". */
  tokenInvalid: "/verify-pending?error=token",
  /** The API could not check the link (rate limit, unavailable): the link may still work later. */
  unavailable: "/verify-pending?error=unavailable",
});

/** The answers of `verifyEmail` that mean the link itself is no good. */
const TOKEN_REFUSED: ReadonlySet<string> = new Set(["VERIFICATION_TOKEN_INVALID", "VALIDATION_FAILED"]);

/** `response` with the headers of a page whose URL carries a token: no `Referer`, no copy in any cache. */
function withTokenPageHeaders(response: NextResponse): NextResponse {
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** A `303 See Other` to `path` on the portal's public URL, with the token-page headers and `cookies`. */
function redirectTo(path: string, portalUrl: string, cookies: readonly CookieWrite[] = []): NextResponse {
  const response = withTokenPageHeaders(NextResponse.redirect(new URL(path, portalUrl), 303));
  writeCookies(response.cookies, cookies);
  return response;
}

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
 * The answer that takes a signed-in browser on to the sign-up's return path `path`: a page without script or form
 * whose declarative refresh (and a plain link for a browser that does not follow refreshes) opens `path` on the
 * portal's public URL, with the token-page headers and `cookies`. It is not a `303` for the reason `middleware.ts`
 * gives for its token links: the verification link is opened from a mail client, and a redirect keeps the start of
 * the navigation it continues, so a `SameSite=Strict` cookie (the invitation's, which `/invitations/accept` needs)
 * would not be sent; the refresh is a new navigation this page starts, and it replaces this page in the history.
 */
function continuePage(path: string, portalUrl: string, cookies: readonly CookieWrite[]): NextResponse {
  const href = escapeHtml(new URL(path, portalUrl).href);
  const body = [
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
  const response = withTokenPageHeaders(
    new NextResponse(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
  );
  writeCookies(response.cookies, cookies);
  return response;
}

/** `/sign-in?verified=1`, with the sign-up's return path as `next` when there is one. */
function signInTarget(returnPath: string | undefined): string {
  return returnPath === undefined
    ? VERIFY_EMAIL_TARGETS.signIn
    : `/sign-in?${new URLSearchParams({ verified: "1", next: returnPath }).toString()}`;
}

/**
 * `HEAD /verify-email` answers `204` without calling the API, so the token stays unused. Without this handler
 * Next.js answers `HEAD` by running `GET`, and link checkers and mail scanners send `HEAD` to the links they find:
 * that would use up the single-use token before the person opens the link. Only `GET` consumes it.
 */
export function HEAD(): NextResponse {
  return withTokenPageHeaders(new NextResponse(null, { status: 204 }));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const settings = getConfig();
  const portalUrl = settings.PUBLIC_PORTAL_URL;
  const token = request.nextUrl.searchParams.get("token");
  if (token === null || token === "" || token.length > TOKEN_MAX_LENGTH) {
    return redirectTo(VERIFY_EMAIL_TARGETS.tokenInvalid, portalUrl);
  }

  // verifyEmail is public: the client carries no access token, only the end-user headers (PADR-0019).
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: request.headers,
  });
  const verified = await api.POST("/v1/auth/verify-email", { body: { token } });
  if (verified.error !== undefined) {
    return redirectTo(
      TOKEN_REFUSED.has(verified.error.code)
        ? VERIFY_EMAIL_TARGETS.tokenInvalid
        : VERIFY_EMAIL_TARGETS.unavailable,
      portalUrl,
    );
  }

  // The sign-up's return path, read once the link worked: checked again, and deleted whatever comes next, so it leads
  // one verification only. A value safeNextPath() refuses is deleted too and changes no target.
  const kept = request.cookies.get(VERIFY_NEXT_COOKIE);
  const returnPath = safeNextPath(kept?.value);
  const consumed: CookieWrite[] = kept === undefined ? [] : [clearedCookie(VERIFY_NEXT_COOKIE)];

  // Signed in (an unverified account may sign in, PADR-0008 item 2): its access token still says `ev: false`, which
  // the middleware would send back to /verify-pending, so the session is renewed first. The refresh re-reads the
  // account, and the single-flight `refresh()` never presents one refresh token twice.
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  if (!refreshToken) {
    return redirectTo(signInTarget(returnPath), portalUrl, consumed);
  }
  const outcome = await refresh(refreshToken, api);
  if (outcome.ok) {
    const renewed = [...sessionCookies(outcome.session), ...consumed];
    // A session of another, still unverified account stays on its own verify-pending page.
    if (!outcome.session.account.emailVerified) {
      return redirectTo(VERIFY_EMAIL_TARGETS.pending, portalUrl, renewed);
    }
    return returnPath === undefined
      ? redirectTo(VERIFY_EMAIL_TARGETS.dashboard, portalUrl, renewed)
      : continuePage(returnPath, portalUrl, renewed);
  }
  if (outcome.final) {
    return redirectTo(signInTarget(returnPath), portalUrl, [...clearedSessionCookies(), ...consumed]);
  }
  return redirectTo(VERIFY_EMAIL_TARGETS.pending, portalUrl, consumed);
}
