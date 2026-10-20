"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { platformApi, type ApiError } from "@/lib/api";
import { otaPath } from "@/lib/roles";
import {
  INVITATION_COOKIE,
  clearedCookie,
  clearedSessionCookies,
  sessionTokens,
  writeCookies,
} from "@/lib/session";

/**
 * The server actions of `/invitations/accept` (README §2 Auth and §6; platform/docs/flows/team-and-ota-admin-sso.md
 * §A; PF-20 AC3). The invitation token never travels through the browser's JavaScript, a URL or a form field:
 * `middleware.ts` moved it from the link (`?token=`) into the httpOnly `__Host-vxp_invite` cookie (15 minutes), and
 * these actions read it there, on the server.
 *
 * - `acceptInvitation` joins the OTA with the signed-in account (`POST /v1/invitations/accept`) and continues to the
 *   OTA's dashboard. A refusal returns to the page with its code in `?error=` (never the token): the page shows the
 *   portal's message for it, and for `INVITATION_EMAIL_MISMATCH` the address the invitation was sent to.
 * - `signOutForInvitation` ends the session of an account with another address and continues to sign-in with the
 *   invited address prefilled and `next` back to the page; the invitation cookie stays.
 */

/** The accept page, without its token. */
const ACCEPT_PATH = "/invitations/accept";

/** The accept page showing the portal's message for `code`. */
function acceptPathWith(code: PlatformErrorCode): string {
  return `${ACCEPT_PATH}?${new URLSearchParams({ error: code }).toString()}`;
}

/** `/sign-in` with `next` back to the accept page and, when known, the invited address prefilled. */
function signInPath(email?: string): string {
  const query = new URLSearchParams({ next: ACCEPT_PATH });
  if (email !== undefined) {
    query.set("email", email);
  }
  return `/sign-in?${query.toString()}`;
}

/** The token is no good: the API refused it, or refused its shape. */
function tokenRefused(error: ApiError): boolean {
  return (
    error.code === "INVITATION_INVALID" ||
    (error.code === "VALIDATION_FAILED" &&
      error.fieldErrors.some((fieldError) => fieldError.path === "/token"))
  );
}

/**
 * Accepts the invitation of `__Host-vxp_invite` with the signed-in account (`acceptInvitation`). Success deletes the
 * cookie and continues to the OTA's dashboard; an ended session goes to sign-in and back; an unusable token deletes
 * the cookie. Every other refusal returns to the page with its code.
 */
export async function acceptInvitation(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(INVITATION_COOKIE)?.value;
  if (!token) {
    // The 15 minutes passed (or the page was opened without the link): the page asks to open the link again.
    redirect(ACCEPT_PATH);
  }
  const api = await platformApi();
  const result = await api.POST("/v1/invitations/accept", { body: { token } });
  if (result.error !== undefined) {
    const { error } = result;
    if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
      redirect(signInPath());
    }
    if (tokenRefused(error)) {
      writeCookies(cookieStore, [clearedCookie(INVITATION_COOKIE)]);
      redirect(acceptPathWith("INVITATION_INVALID"));
    }
    redirect(acceptPathWith(error.code));
  }
  writeCookies(cookieStore, [clearedCookie(INVITATION_COOKIE)]);
  redirect(otaPath(result.data.tenant.id));
}

/** The invited address as the page sends it back: the address of `lookupInvitation`. */
const INVITED_EMAIL = z.string().trim().min(1).max(254).email();

/**
 * Signs the current account out (`signOut`, as `/sign-out` does) and continues to sign-in with the invited address of
 * the field `email` prefilled and `next` back to the accept page, for a person signed in with another address
 * (`INVITATION_EMAIL_MISMATCH`). The session cookies go whatever the API answered; the invitation cookie stays.
 */
export async function signOutForInvitation(formData: FormData): Promise<void> {
  const typed = formData.get("email");
  const email = INVITED_EMAIL.safeParse(typeof typed === "string" ? typed : "");
  const cookieStore = await cookies();
  const { accessToken, refreshToken } = sessionTokens(cookieStore);
  if (accessToken !== undefined && refreshToken !== undefined) {
    // Its answer does not change what follows: a family that could not be revoked ends with its refresh token.
    const api = await platformApi();
    await api.POST("/v1/auth/sign-out", { body: { refreshToken } });
  }
  writeCookies(cookieStore, clearedSessionCookies());
  redirect(signInPath(email.success ? email.data : undefined));
}
