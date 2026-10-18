// `POST /sign-out` (README §2 route handlers and §6, ADR-0008): the target of the "Sign out" forms of the app shell
// and of /verify-pending, plain HTML form posts. A route handler is not covered by the Origin check Next.js applies
// to server actions, so it checks `Origin` itself: only the portal's own origin (`PUBLIC_PORTAL_URL`) may sign a
// person out; a foreign, `null` or missing `Origin` answers `403` and changes nothing. Then it revokes the session's
// refresh family (`signOut`, with the access token the middleware has just renewed when needed) and deletes the
// session cookies, whatever the API answered, and answers `303` to `/sign-in?signedOut=1`. Only `POST` exists:
// Next.js answers `405` to other methods, so a link or an image cannot sign anyone out.
import { NextResponse, type NextRequest } from "next/server";

import { createPlatformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import {
  MFA_CHALLENGE_COOKIE,
  NEXT_PATH_COOKIE,
  clearedCookie,
  clearedSessionCookies,
  sessionTokens,
  writeCookies,
} from "@/lib/session";

export const dynamic = "force-dynamic";

/** Where the browser goes after signing out. */
const SIGNED_OUT_PATH = "/sign-in?signedOut=1";

/** `origin` is the portal's own origin. `null` (an opaque origin) and a missing header never are. */
function isPortalOrigin(origin: string | null, portalUrl: string): boolean {
  return origin !== null && origin !== "null" && origin === new URL(portalUrl).origin;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const settings = getConfig();
  if (!isPortalOrigin(request.headers.get("origin"), settings.PUBLIC_PORTAL_URL)) {
    return new NextResponse("Forbidden", {
      status: 403,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const { accessToken, refreshToken } = sessionTokens(request.cookies);
  if (accessToken !== undefined && refreshToken !== undefined) {
    // signOut needs the bearer token (scope portal_unverified). Its answer does not change what follows: the
    // cookies go in any case, and a family that could not be revoked now ends with its refresh token's expiry.
    const api = createPlatformApi({
      baseUrl: settings.PLATFORM_API_URL,
      bffKey: settings.PLATFORM_BFF_KEY,
      requestHeaders: request.headers,
      accessToken,
    });
    await api.POST("/v1/auth/sign-out", { body: { refreshToken } });
  }

  const response = NextResponse.redirect(new URL(SIGNED_OUT_PATH, settings.PUBLIC_PORTAL_URL), 303);
  response.headers.set("Cache-Control", "no-store");
  writeCookies(response.cookies, [
    ...clearedSessionCookies(),
    // A sign-in that was waiting for its second factor ends too.
    ...([MFA_CHALLENGE_COOKIE, NEXT_PATH_COOKIE] as const)
      .filter((name) => request.cookies.has(name))
      .map((name) => clearedCookie(name)),
  ]);
  return response;
}
