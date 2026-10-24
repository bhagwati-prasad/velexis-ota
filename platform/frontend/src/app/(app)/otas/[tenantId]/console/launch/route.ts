// `POST /otas/{tenantId}/console/launch` (README §2 route handlers, platform/docs/flows/team-and-ota-admin-sso.md §C,
// PADR-0007 point 4): the target of the "Open console" forms (`OpenConsoleButton`). A route handler is not covered by
// the Origin check Next.js applies to server actions, so it checks `Origin` itself: only the portal's own origin
// (`PUBLIC_PORTAL_URL`) may mint a console token; a foreign, `null` or missing `Origin` answers `403` without a call.
// Then it calls `createConsoleToken` with the session (the middleware has renewed an expired access token) and answers
// a minimal HTML page whose form posts the token as `portalToken` to the OTA admin's `/sso`, submitted at once by a
// nonce-allowed script, with a visible "Continue" button for browsers without JavaScript.
//
// - The token is only ever in that form's body: never in a URL, a header, a cookie, a log line or a redirect.
// - The page carries `Cache-Control: no-store` and `Referrer-Policy: strict-origin` (next.config.ts sets the same for
//   this path, because Next.js keeps its configured headers over a route handler's; also as `<meta name="referrer">`).
//   Not `no-referrer`: under it browsers send `Origin: null` with the cross-origin form post, and the OTA admin's
//   `/sso` accepts only `Origin` = `PUBLIC_PORTAL_URL` (PADR-0007 point 4 as revised on 2026-10-23, OADR-0018 point
//   2). `strict-origin` sends the portal's origin and nothing of this URL's path.
// - Its Content-Security-Policy lets forms post to the origin of `PUBLIC_OTA_ADMIN_URL` alone (`lib/csp.ts`
//   `handOff`; the middleware sets the same policy for this path, and Next.js keeps the middleware's), and its script
//   carries the request's nonce (`x-nonce`, set by the middleware).
// - Refusals go back with `303`: `TENANT_NOT_ACTIVE` to the OTA dashboard with an explanation (and the billing link
//   for a billing suspension), `MFA_REQUIRED` to `/account/security` with a message, an ended session to sign-in and
//   then the console picker, `NOT_FOUND` to the picker, anything else to the OTA dashboard with the portal's message.
// - `GET` (a typed URL, or the return from sign-in) mints nothing: it answers `303` to the console picker.
import type { PlatformErrorCode } from "@velexis/errors";
import { NextResponse, type NextRequest } from "next/server";

import {
  consolePickerPath,
  consoleProblemPath,
  type ConsoleLaunchFailure,
  type ConsoleProblem,
} from "@/components/open-console-button";
import { createPlatformApi, type ApiError } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { NONCE_HEADER, contentSecurityPolicy, createNonce, isNonce } from "@/lib/csp";
import { sessionTokens } from "@/lib/session";
import { CONSOLE_STRINGS } from "@/lib/strings";
import { isTenantId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ tenantId: string }>;
}

/** The `PortalToken` pattern of the platform document: anything else is never put into the page. */
const PORTAL_TOKEN = /^ptk_[0-9A-Za-z]{43}$/;

/** The id of the hand-off form, which the script submits. */
const HAND_OFF_FORM_ID = "console-hand-off";

/** `origin` is the portal's own origin. `null` (an opaque origin) and a missing header never are. */
function isPortalOrigin(origin: string | null, portalUrl: string): boolean {
  return origin !== null && origin !== "null" && origin === new URL(portalUrl).origin;
}

/** A plain-text answer that changes nothing (`403`, `404`). */
function refusal(status: number, text: string): NextResponse {
  return new NextResponse(text, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** A `303 See Other` to `path` on the portal's public URL: the browser continues with a GET of it. */
function seeOther(path: string, portalUrl: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, portalUrl), 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** `TENANT_NOT_ACTIVE`'s `details.status` (and reason) as the OTA dashboard's notice names it. */
function notActiveFailure(details: ApiError["details"]): ConsoleLaunchFailure {
  const status = details.status;
  if (status === "suspended") {
    const reason = details.suspensionReason;
    return reason === "billing" || reason === "abuse" || reason === "request" || reason === "admin"
      ? { problem: "suspended", reason }
      : { problem: "suspended" };
  }
  const problem: ConsoleProblem = status === "provisioning" || status === "failed" ? status : "not_active";
  return { problem };
}

/** Answers that mean the session is over: a sign-in cannot come back to a POST, so it continues on the picker. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/**
 * No membership of this OTA (the API never says whether it exists), or an id the API does not accept: the picker says
 * so and lists the account's OTAs.
 */
const NOT_A_MEMBER: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "NOT_FOUND",
  "VALIDATION_FAILED",
]);

/** The path a refused `createConsoleToken` sends the browser to (flow §C step 2, README §2). */
function refusedLaunchPath(error: ApiError, tenantId: string): string {
  if (error.code === "TENANT_NOT_ACTIVE") {
    return consoleProblemPath(tenantId, notActiveFailure(error.details));
  }
  if (error.code === "MFA_REQUIRED") {
    return consoleProblemPath(tenantId, { problem: "mfa_required" });
  }
  if (SESSION_ENDED.has(error.code)) {
    return `/sign-in?${new URLSearchParams({ next: consolePickerPath(tenantId) }).toString()}`;
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    return "/verify-pending";
  }
  if (NOT_A_MEMBER.has(error.code)) {
    return consolePickerPath(tenantId);
  }
  // The rate limit has its own message; anything else (the API or Redis unavailable) the general one.
  return consoleProblemPath(tenantId, {
    problem: error.code === "RATE_LIMITED" ? "rate_limited" : "unavailable",
  });
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
 * The hand-off page: one form posting `portalToken` to `ssoUrl` (`application/x-www-form-urlencoded`, the only body
 * the OTA admin's `/sso` reads), the visible "Continue" button, and the nonce script that submits the form while the
 * page is still loading. A form submitted before its page has finished loading replaces that page in the session
 * history (HTML, form submission), so "Back" from the OTA admin returns to the portal page, not to this post.
 */
function handOffPage(ssoUrl: string, portalToken: string, nonce: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="strict-origin">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(CONSOLE_STRINGS.handOffTitle)}</title>`,
    "<style>body{font-family:system-ui,sans-serif;margin:0;padding:4rem 1rem;color:#111}main{max-width:32rem;margin:0 auto}button{font:inherit;padding:.5rem 1rem}</style>",
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(CONSOLE_STRINGS.handOffHeading)}</h1>`,
    `<form id="${HAND_OFF_FORM_ID}" method="post" action="${escapeHtml(ssoUrl)}" enctype="application/x-www-form-urlencoded">`,
    `<input type="hidden" name="portalToken" value="${escapeHtml(portalToken)}">`,
    `<p>${escapeHtml(CONSOLE_STRINGS.handOffFallback)}</p>`,
    `<button type="submit">${escapeHtml(CONSOLE_STRINGS.handOffContinue)}</button>`,
    "</form>",
    "</main>",
    `<script nonce="${escapeHtml(nonce)}">document.getElementById("${HAND_OFF_FORM_ID}").submit();</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * The OTA admin's sign-on URL of the answer, when it is a URL at the origin of `PUBLIC_OTA_ADMIN_URL` without
 * credentials or query (the form-action of the page's policy allows that origin only); `undefined` otherwise.
 */
function ssoUrlOf(consoleSsoUrl: string, otaAdminUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(consoleSsoUrl);
  } catch {
    return undefined;
  }
  const clean = url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  return clean && url.origin === new URL(otaAdminUrl).origin ? url.href : undefined;
}

/** A `GET` of the launch URL mints nothing: it continues on the console picker, with this OTA pre-selected. */
export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { tenantId } = await context.params;
  return seeOther(
    consolePickerPath(isTenantId(tenantId) ? tenantId : undefined),
    getConfig().PUBLIC_PORTAL_URL,
  );
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const settings = getConfig();
  const portalUrl = settings.PUBLIC_PORTAL_URL;
  if (!isPortalOrigin(request.headers.get("origin"), portalUrl)) {
    return refusal(403, "Forbidden");
  }
  const { tenantId } = await context.params;
  if (!isTenantId(tenantId)) {
    return refusal(404, "Not Found");
  }
  const { accessToken } = sessionTokens(request.cookies);
  if (accessToken === undefined) {
    // The middleware sends a request without a session to sign-in first; this is the same answer.
    return seeOther(
      refusedLaunchPath({ code: "UNAUTHENTICATED", status: 401, fieldErrors: [], details: {} }, tenantId),
      portalUrl,
    );
  }

  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: request.headers,
    accessToken,
  });
  const issued = await api.POST("/v1/tenants/{tenantId}/console-token", {
    params: { path: { tenantId } },
  });
  if (issued.error !== undefined) {
    return seeOther(refusedLaunchPath(issued.error, tenantId), portalUrl);
  }
  const { portalToken, consoleSsoUrl } = issued.data;
  const ssoUrl = ssoUrlOf(consoleSsoUrl, settings.PUBLIC_OTA_ADMIN_URL);
  if (ssoUrl === undefined || !PORTAL_TOKEN.test(portalToken)) {
    // An answer the page cannot use: the token is dropped unused (it expires within 60 seconds).
    return seeOther(consoleProblemPath(tenantId, { problem: "unavailable" }), portalUrl);
  }

  const forwardedNonce = request.headers.get(NONCE_HEADER);
  const nonce = isNonce(forwardedNonce) ? forwardedNonce : createNonce();
  return new NextResponse(handOffPage(ssoUrl, portalToken, nonce), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "strict-origin",
      "Content-Security-Policy": contentSecurityPolicy({
        nonce,
        otaAdminUrl: settings.PUBLIC_OTA_ADMIN_URL,
        development: settings.APP_ENV === "development",
        handOff: true,
      }),
    },
  });
}
