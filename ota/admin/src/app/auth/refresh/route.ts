// `GET /auth/refresh?next=<path>`: the refresh of server components (README §4 point 3, OADR-0018 point 3). A server
// component cannot write cookies, so when its call fails with `TOKEN_EXPIRED` (or it finds no access token), it
// redirects here; this handler refreshes through the process-wide de-duplication (`refreshStaffSession`, the same as
// the middleware's and `requireStaff()`'s), writes the four cookies and answers `303 See Other` to `next`.
//
// - `next` is kept only when lib/session.ts's `safeNextPath` accepts it (a relative path on the admin); anything else
//   goes to the dashboard, so the handler is never an open redirect.
// - It always refreshes when there is a refresh token, even with an access token that looks fresh: the page came here
//   because the API refused that token, and redirecting back without a new one would loop.
// - A refused refresh (README §4 point 4) clears the access, refresh and environment cookies and sends the staff
//   member to the portal; the tenant cookie stays for that redirect. Without a refresh token the session is over too.
// - A failure that may pass (rate limit, API unavailable, network) keeps the cookies and answers a short page with
//   "Try again" and "Back to the portal", never a redirect back to the page, which would only come here again.
import { NextResponse, type NextRequest } from "next/server";

import { getConfig } from "@/config";
import { DEFAULT_NEXT_PATH, authPageResponse } from "@/lib/auth-routes";
import { errorMessage, isVelexisErrorLike } from "@/lib/errors";
import {
  clearedSessionCookies,
  portalConsoleUrl,
  readSessionCookies,
  refreshPath,
  safeNextPath,
  staffSessionCookies,
  writeCookies,
} from "@/lib/session";
import { refreshStaffSession } from "@/lib/velexis";

export const dynamic = "force-dynamic";

/** A `303 See Other` that is never cached. */
function seeOther(url: string | URL): NextResponse {
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest): Promise<Response> {
  const config = getConfig();
  const next = safeNextPath(request.nextUrl.searchParams.get("next")) ?? DEFAULT_NEXT_PATH;
  const session = readSessionCookies(request.cookies);
  const portal = portalConsoleUrl(config.PUBLIC_PORTAL_URL, session.tenantId);

  if (session.refreshToken === undefined) {
    const response = seeOther(portal);
    writeCookies(response.cookies, clearedSessionCookies());
    return response;
  }

  const now = Date.now();
  const outcome = await refreshStaffSession(session.refreshToken, request.headers);
  if (outcome.ok) {
    const response = seeOther(new URL(next, config.PUBLIC_OTA_ADMIN_URL));
    writeCookies(
      response.cookies,
      staffSessionCookies(outcome.session, { environment: session.environment, now }),
    );
    return response;
  }
  if (outcome.final) {
    const response = seeOther(portal);
    writeCookies(response.cookies, clearedSessionCookies());
    return response;
  }

  const { error } = outcome;
  const known = isVelexisErrorLike(error);
  return authPageResponse({
    status: known && error.status === 429 ? 429 : 503,
    title: "Your session could not be renewed",
    message: known ? errorMessage(error) : errorMessage("SERVICE_UNAVAILABLE"),
    requestId: known ? error.requestId : undefined,
    links: [
      { href: refreshPath(next), label: "Try again" },
      { href: portal, label: "Back to the portal" },
    ],
  });
}
