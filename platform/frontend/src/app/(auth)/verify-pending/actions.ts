"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createPlatformApi, platformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { clearedSessionCookies, refresh, sessionCookies, sessionTokens, writeCookies } from "@/lib/session";
import { SIGN_UP_STRINGS, VERIFICATION_STRINGS } from "@/lib/strings";

/**
 * The server actions of `/sign-up/check-email` and `/verify-pending` (README §2, platform/docs/flows/
 * signup-and-create-ota.md "Failure handling", PF-02 AC2 and AC3):
 *
 * - `resendVerificationLink` asks for a new verification link (`resendVerification`). A visitor without a session
 *   types the address (the form field `email`); for a signed-in, unverified account the address is the account's
 *   own, read with `getMe` on the server. The API answers `202` whatever the address, so the message never says
 *   whether an account exists; more than 3 links per address (or 10 calls per IP) in an hour answer `RATE_LIMITED`.
 * - `continueAfterVerification` takes an account that has verified its address meanwhile (in another tab or on
 *   another device) to the dashboard. Its access token still says `ev: false`, which `middleware.ts` would send
 *   back to `/verify-pending`, so the session is refreshed first: the new access token carries `ev: true`.
 */

/** The state of the "send a new link" form. */
export interface ResendState {
  readonly status: "idle" | "sent" | "failed";
  /** The error code of a failure, for tests and logs; never shown. */
  readonly code?: PlatformErrorCode;
  /** A problem with the typed address: shown at the field. */
  readonly fieldError?: string;
  /** The confirmation, or a problem that belongs to no field. */
  readonly message?: string;
  /** The typed address, so the form keeps it. */
  readonly email?: string;
}

/** `EmailAddress` of the platform document: trimmed, an address, at most 254 characters. */
const EMAIL = z.string().trim().min(1).max(254).email();

/**
 * Sends a new verification link. With the form field `email` (a visitor without a session) the link goes to that
 * address when it belongs to an unverified account; without it, to the signed-in account's own address.
 */
export async function resendVerificationLink(
  _previous: ResendState,
  formData: FormData,
): Promise<ResendState> {
  const api = await platformApi();
  const typed = formData.get("email");
  let email: string;
  let signedIn = false;
  if (typeof typed === "string") {
    const parsed = EMAIL.safeParse(typed);
    if (!parsed.success) {
      return {
        status: "failed",
        code: "VALIDATION_FAILED",
        fieldError: typed.trim() === "" ? SIGN_UP_STRINGS.emailRequired : SIGN_UP_STRINGS.emailInvalid,
        email: typed,
      };
    }
    email = parsed.data;
  } else {
    const me = await api.GET("/v1/me");
    if (me.error !== undefined) {
      return { status: "failed", code: me.error.code, message: errorMessage(me.error) };
    }
    email = me.data.email;
    signedIn = true;
  }

  const result = await api.POST("/v1/auth/resend-verification", { body: { email } });
  const kept = signedIn ? {} : { email };
  if (result.error === undefined) {
    return {
      status: "sent",
      message: signedIn ? VERIFICATION_STRINGS.resentSignedIn : VERIFICATION_STRINGS.resentAnonymous,
      ...kept,
    };
  }
  const { code } = result.error;
  if (code === "RATE_LIMITED") {
    return { status: "failed", code, message: VERIFICATION_STRINGS.resendRateLimited, ...kept };
  }
  if (code === "VALIDATION_FAILED" && !signedIn) {
    return { status: "failed", code, fieldError: SIGN_UP_STRINGS.emailInvalid, ...kept };
  }
  return { status: "failed", code, message: errorMessage(result.error), ...kept };
}

/**
 * Refreshes the session of an account whose address is verified now, so its access token says so, and continues
 * to the dashboard. A session that can no longer be refreshed goes to sign-in; a failure that may pass (rate
 * limit, API unavailable) back to `/verify-pending` with a message.
 */
export async function continueAfterVerification(): Promise<void> {
  const settings = getConfig();
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const { refreshToken } = sessionTokens(cookieStore);
  if (refreshToken === undefined) {
    redirect("/sign-in?verified=1");
  }
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders,
  });
  const outcome = await refresh(refreshToken, api);
  if (outcome.ok) {
    writeCookies(cookieStore, sessionCookies(outcome.session));
    redirect(outcome.session.account.emailVerified ? "/dashboard" : "/verify-pending");
  }
  if (outcome.final) {
    writeCookies(cookieStore, clearedSessionCookies());
    redirect("/sign-in?verified=1");
  }
  redirect("/verify-pending?error=session");
}
