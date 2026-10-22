// `POST /sso`: the portal's hand-off to the OTA admin (README §3, OADR-0018 point 2, PADR-0007 §4, architecture flow
// (c)). The portal's launch page posts a form with a one-time `portalToken` (60 s, single use); the admin exchanges
// it for a staff session with `console.auth.signIn({ grantType: "portal_token" })`, sets the four `__Host-` cookies and
// answers `303 See Other` to `/bookings`, so the browser continues with a GET that carries the new cookies
// (`SameSite=Lax` allows a top-level navigation).
//
// - Only a form (`application/x-www-form-urlencoded`, at most 1 KiB) with one `portalToken` matching
//   `^ptk_[A-Za-z0-9]{24,64}$` (the contract's pattern) is accepted, and only with `Origin` = `PUBLIC_PORTAL_URL`
//   (login-CSRF defence: no other site can sign a browser in to someone else's console session).
// - The sign-in goes out with the service key only (no access token) and `X-Velexis-Environment: test`, which every
//   session allows; a new session starts in the test environment, and the switch moves it to live.
// - The token never appears in a URL, a log line or an answer: the redirect has no query and no body, and an error
//   answers the short page of lib/auth-routes.ts with a message by code and "Back to the portal".
import type { ConsoleStaffSession } from "@velexis/ota-sdk";
import { NextResponse, type NextRequest } from "next/server";

import { getConfig } from "@/config";
import {
  SSO_LANDING_PATH,
  authPageResponse,
  mediaTypeOf,
  originMatches,
  readCappedText,
} from "@/lib/auth-routes";
import { errorMessage, isVelexisErrorLike } from "@/lib/errors";
import { portalConsoleUrl, readSessionCookies, staffSessionCookies, writeCookies } from "@/lib/session";
import { REFRESH_ENVIRONMENT, createConsoleClient } from "@/lib/velexis";

export const dynamic = "force-dynamic";

/** The contract's `ConsolePortalTokenSignIn.portalToken`. */
const PORTAL_TOKEN = /^ptk_[A-Za-z0-9]{24,64}$/;
/** The only body this handler reads: the portal's hand-off form. */
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";
/** The hand-off form is one field of at most 80 characters; anything much longer is not it. */
const MAX_FORM_BYTES = 1024;

const ERROR_TITLE = "The console could not be opened";
const FOREIGN_ORIGIN_MESSAGE =
  "This sign-in did not come from the portal. Open the console again from the portal.";
const NOT_A_HAND_OFF_MESSAGE = "This was not a valid console link. Open the console again from the portal.";

/** The portal's security page, where the staff member turns on two-factor authentication (`MFA_REQUIRED`). */
function portalSecurityUrl(portalUrl: string): string {
  const url = new URL(portalUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/account/security`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The error page with "Back to the portal" (the tenant's console page when the tenant cookie names one). */
function errorPage(
  request: NextRequest,
  status: number,
  message: string,
  options: { readonly requestId?: string | null; readonly securityLink?: boolean } = {},
): Response {
  const portalUrl = getConfig().PUBLIC_PORTAL_URL;
  const tenantId = readSessionCookies(request.cookies).tenantId;
  return authPageResponse({
    status,
    title: ERROR_TITLE,
    message,
    requestId: options.requestId,
    links: [
      ...(options.securityLink === true
        ? [{ href: portalSecurityUrl(portalUrl), label: "Turn on two-factor authentication" }]
        : []),
      { href: portalConsoleUrl(portalUrl, tenantId), label: "Back to the portal" },
    ],
  });
}

/** The page for a refused or failed sign-in: the API's status for a refusal, `503` when the API is unavailable. */
function signInErrorPage(request: NextRequest, error: unknown): Response {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  const status = error.status >= 400 && error.status < 500 ? error.status : 503;
  return errorPage(request, status, errorMessage(error), {
    requestId: error.requestId,
    securityLink: error.code === "MFA_REQUIRED",
  });
}

/** The portal token of the form, or `undefined` when the form does not hold exactly one valid token. */
function portalTokenOf(form: string): string | undefined {
  const tokens = new URLSearchParams(form).getAll("portalToken");
  const [token] = tokens;
  return tokens.length === 1 && token !== undefined && PORTAL_TOKEN.test(token) ? token : undefined;
}

export async function POST(request: NextRequest): Promise<Response> {
  const config = getConfig();
  if (!originMatches(request.headers, config.PUBLIC_PORTAL_URL)) {
    return errorPage(request, 403, FOREIGN_ORIGIN_MESSAGE);
  }
  if (mediaTypeOf(request.headers) !== FORM_MEDIA_TYPE) {
    return errorPage(request, 415, NOT_A_HAND_OFF_MESSAGE);
  }
  const form = await readCappedText(request, MAX_FORM_BYTES);
  const portalToken = form === undefined ? undefined : portalTokenOf(form);
  if (portalToken === undefined) {
    return errorPage(request, 400, NOT_A_HAND_OFF_MESSAGE);
  }

  const client = createConsoleClient({
    accessToken: null,
    environment: REFRESH_ENVIRONMENT,
    incoming: request.headers,
  });
  let result: ConsoleStaffSession;
  try {
    result = await client.auth.signIn({ grantType: "portal_token", portalToken });
  } catch (error) {
    return signInErrorPage(request, error);
  }

  const response = NextResponse.redirect(new URL(SSO_LANDING_PATH, config.PUBLIC_OTA_ADMIN_URL), 303);
  response.headers.set("Cache-Control", "no-store");
  // A new session starts in test (no `environment`): live is the switch's deliberate choice (README §4).
  writeCookies(response.cookies, staffSessionCookies(result));
  return response;
}
