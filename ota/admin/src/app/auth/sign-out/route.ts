// `POST /auth/sign-out`: the shell's sign-out button (README §3, OADR-0018 point 2). Only a request whose `Origin` is
// the admin's own (`PUBLIC_OTA_ADMIN_URL`) is served, so no other site can sign a staff member out. It ends the
// session in the OTA API with `console.auth.signOut({ scope: "current" })`, clears the access, refresh and
// environment cookies (the tenant cookie stays, for the "Back to the portal" link) and answers `303 See Other` to
// `/signed-out`.
//
// - The call carries the refresh token in its body, which names the session even when the access token has expired,
//   and the access token only while it is still valid (an expired one counts as none for the API anyway).
// - The cookies are cleared whatever the API answers: a failed sign-out (rate limit, API unavailable) leaves the
//   session to expire in the OTA API, but the browser holds no token of it any more. "Sign out everywhere" belongs to
//   the portal (`staffdeny:acct:*`, PADR-0007 §6).
import { NextResponse, type NextRequest } from "next/server";

import { getConfig } from "@/config";
import { SIGNED_OUT_PATH, authPageResponse, originMatches } from "@/lib/auth-routes";
import { accessTokenExpiry, clearedSessionCookies, readSessionCookies, writeCookies } from "@/lib/session";
import { REFRESH_ENVIRONMENT, createConsoleClient } from "@/lib/velexis";

export const dynamic = "force-dynamic";

/** `token` is a readable access token that has not expired yet. */
function stillValid(token: string | undefined, now: number): token is string {
  const expiry = token === undefined ? undefined : accessTokenExpiry(token);
  return expiry !== undefined && expiry > now;
}

export async function POST(request: NextRequest): Promise<Response> {
  const config = getConfig();
  if (!originMatches(request.headers, config.PUBLIC_OTA_ADMIN_URL)) {
    return authPageResponse({
      status: 403,
      title: "You are still signed in",
      message: "This sign-out did not come from the OTA admin. Use the Sign out button of the console.",
      links: [{ href: "/", label: "Back to the console" }],
    });
  }

  const session = readSessionCookies(request.cookies);
  const accessToken = stillValid(session.accessToken, Date.now()) ? session.accessToken : null;
  if (accessToken !== null || session.refreshToken !== undefined) {
    // The environment of a key-only session call, as for a refresh: every session allows `test`.
    const client = createConsoleClient({
      accessToken,
      environment: REFRESH_ENVIRONMENT,
      incoming: request.headers,
    });
    try {
      await client.auth.signOut({
        scope: "current",
        ...(session.refreshToken === undefined ? {} : { refreshToken: session.refreshToken }),
      });
    } catch {
      // The API's answer is in the response log line of lib/velexis.ts; the cookies are cleared all the same.
    }
  }

  const response = NextResponse.redirect(new URL(SIGNED_OUT_PATH, config.PUBLIC_OTA_ADMIN_URL), 303);
  response.headers.set("Cache-Control", "no-store");
  writeCookies(response.cookies, clearedSessionCookies());
  return response;
}
