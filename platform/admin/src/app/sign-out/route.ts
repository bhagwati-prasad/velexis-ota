// `POST /sign-out` (README §2 route handlers and §4, ADR-0008): the target of the "Sign out" form of the admin shell,
// a plain HTML form post. A route handler is not covered by the Origin check Next.js applies to server actions, so it
// checks `Origin` itself: only the admin's own origin (`PUBLIC_PLATFORM_ADMIN_URL`) may sign an admin out; a foreign,
// `null` or missing `Origin` answers `403` and changes nothing. Then it revokes the session's refresh family
// (`adminSignOut`, with the access token the middleware has just renewed when needed) and deletes the session
// cookies, whatever the API answered, and answers `303` to `/sign-in?signedOut=1`. Only `POST` exists: Next.js
// answers `405` to other methods, so a link or an image cannot sign anyone out.
import { NextResponse, type NextRequest } from "next/server";

import { createPlatformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import {
  MFA_CHALLENGE_COOKIE,
  clearedCookie,
  clearedSessionCookies,
  sessionTokens,
  writeCookies,
} from "@/lib/session";

export const dynamic = "force-dynamic";

/** Where the browser goes after signing out. */
const SIGNED_OUT_PATH = "/sign-in?signedOut=1";

/** `origin` is the admin's own origin. `null` (an opaque origin) and a missing header never are. */
function isAdminOrigin(origin: string | null, adminUrl: string): boolean {
  return origin !== null && origin !== "null" && origin === new URL(adminUrl).origin;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const settings = getConfig();
  if (!isAdminOrigin(request.headers.get("origin"), settings.PUBLIC_PLATFORM_ADMIN_URL)) {
    return new NextResponse("Forbidden", {
      status: 403,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const { accessToken, refreshToken } = sessionTokens(request.cookies);
  if (accessToken !== undefined && refreshToken !== undefined) {
    // adminSignOut needs the admin bearer token. Its answer does not change what follows: the cookies go in any
    // case, and a family that could not be revoked now ends with its refresh token's expiry (2 idle hours).
    const api = createPlatformApi({
      baseUrl: settings.PLATFORM_API_URL,
      bffKey: settings.PLATFORM_BFF_KEY,
      requestHeaders: request.headers,
      accessToken,
    });
    await api.POST("/v1/admin/auth/sign-out", { body: { refreshToken } });
  }

  const response = NextResponse.redirect(new URL(SIGNED_OUT_PATH, settings.PUBLIC_PLATFORM_ADMIN_URL), 303);
  response.headers.set("Cache-Control", "no-store");
  writeCookies(response.cookies, [
    ...clearedSessionCookies(),
    // A sign-in that was waiting for its second factor ends too.
    ...(request.cookies.has(MFA_CHALLENGE_COOKIE) ? [clearedCookie(MFA_CHALLENGE_COOKIE)] : []),
  ]);
  return response;
}
