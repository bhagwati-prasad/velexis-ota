"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createPlatformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import {
  MFA_CHALLENGE_COOKIE,
  clearedCookie,
  safeNextPath,
  sessionCookies,
  writeCookies,
  type AdminSession,
  type CookieWrite,
} from "@/lib/session";
import { ERROR_MESSAGES, MFA_STRINGS } from "@/lib/strings";

/**
 * The second step of every admin sign-in (README §2 `/sign-in/mfa`, §4; PADR-0006 item 2, PF-80). `verifyMfa` sends
 * the challenge of `__Host-vxa_mfa` with either a TOTP code or one recovery code to `POST /v1/admin/auth/mfa/verify`
 * (public, no bearer token, the end-user headers of PADR-0019). This is the only place that creates an admin
 * session: success stores it in `__Host-vxa_at` and `__Host-vxa_rt` (`HttpOnly; Secure; SameSite=Strict`), deletes
 * the challenge and continues to the validated `next` or the dashboard. A challenge that is missing, expired or used
 * up (`MFA_CHALLENGE_INVALID`, also after five wrong codes) sends the admin back to `/sign-in?mfa=expired`. Codes
 * are never returned, logged or kept.
 */

/** How the admin proves the second factor. */
export type MfaMethod = "totp" | "recovery";

/** What the form shows after a submission that did not sign in. */
export interface MfaState {
  readonly status: "idle" | "failed";
  /** The error code of the failure, for tests and logs; never shown. */
  readonly code?: PlatformErrorCode;
  /** The method of the submission, so the form shows the field it was about. */
  readonly method: MfaMethod;
  /** A problem with the typed code: shown at the field. */
  readonly fieldError?: string;
  /** A problem that belongs to no field (rate limit, API unavailable). */
  readonly message?: string;
}

/** Where the admin lands after signing in without a return path: the dashboard. */
const DASHBOARD_PATH = "/";

/** `TotpCode` of the platform document; spaces an admin typed are dropped. */
const TOTP_CODE = z
  .string()
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().regex(/^[0-9]{6}$/));

/** `recoveryCode` of `VerifyMfaWithRecoveryCode`: 16 to 24 letters, digits, dashes and spaces, any case. */
const RECOVERY_CODE = z
  .string()
  .trim()
  .min(16)
  .max(24)
  .regex(/^[0-9A-Za-z -]+$/);

/** Where a sign-in starts again: with the notice of an expired challenge, and the return path when there is one. */
function signInAgainPath(next: string | undefined): string {
  const query = new URLSearchParams({ mfa: "expired" });
  if (next !== undefined) {
    query.set("next", next);
  }
  return `/sign-in?${query.toString()}`;
}

/** Deletes the challenge cookie when the request still carries it. */
function challengeCleared(store: { get(name: string): { value: string } | undefined }): CookieWrite[] {
  return store.get(MFA_CHALLENGE_COOKIE) === undefined ? [] : [clearedCookie(MFA_CHALLENGE_COOKIE)];
}

/** The answer is an `AdminSession` with both tokens (anything else is never stored). */
function isSession(answer: unknown): answer is AdminSession {
  if (typeof answer !== "object" || answer === null) {
    return false;
  }
  const { accessToken, refreshToken } = answer as { accessToken?: unknown; refreshToken?: unknown };
  return (
    typeof accessToken === "string" &&
    accessToken !== "" &&
    typeof refreshToken === "string" &&
    refreshToken !== ""
  );
}

/**
 * Completes the MFA challenge of `__Host-vxa_mfa` with the form field `code` (method `totp`) or `recoveryCode`
 * (method `recovery`, chosen with the hidden field `method`); the hidden field `next` is the return path, kept only
 * when it is a safe relative path. Redirects on success and when the challenge is over; otherwise returns the
 * problem for the form.
 */
export async function verifyMfa(_previous: MfaState, formData: FormData): Promise<MfaState> {
  const method: MfaMethod = formData.get("method") === "recovery" ? "recovery" : "totp";
  const nextField = formData.get("next");
  const next = safeNextPath(typeof nextField === "string" ? nextField : undefined);
  const cookieStore = await cookies();
  const challenge = cookieStore.get(MFA_CHALLENGE_COOKIE)?.value;
  if (!challenge) {
    redirect(signInAgainPath(next));
  }

  let credential: { code: string } | { recoveryCode: string };
  if (method === "totp") {
    const parsed = TOTP_CODE.safeParse(formData.get("code") ?? "");
    if (!parsed.success) {
      return { status: "failed", code: "VALIDATION_FAILED", method, fieldError: MFA_STRINGS.codeFormat };
    }
    credential = { code: parsed.data };
  } else {
    const parsed = RECOVERY_CODE.safeParse(formData.get("recoveryCode") ?? "");
    if (!parsed.success) {
      return { status: "failed", code: "VALIDATION_FAILED", method, fieldError: MFA_STRINGS.recoveryFormat };
    }
    credential = { recoveryCode: parsed.data };
  }

  // adminVerifyMfa is public: no bearer token, only the end-user headers.
  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  const result = await api.POST("/v1/admin/auth/mfa/verify", {
    body: { mfaChallengeToken: challenge, ...credential },
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "MFA_CHALLENGE_INVALID") {
      writeCookies(cookieStore, challengeCleared(cookieStore));
      redirect(signInAgainPath(next));
    }
    if (code === "MFA_CODE_INVALID" || code === "VALIDATION_FAILED") {
      const fieldError =
        method === "totp"
          ? code === "MFA_CODE_INVALID"
            ? ERROR_MESSAGES.MFA_CODE_INVALID
            : MFA_STRINGS.codeFormat
          : code === "MFA_CODE_INVALID"
            ? MFA_STRINGS.recoveryInvalid
            : MFA_STRINGS.recoveryFormat;
      return { status: "failed", code, method, fieldError };
    }
    if (code === "RATE_LIMITED" && result.error.retryAfterSeconds !== undefined) {
      return {
        status: "failed",
        code,
        method,
        message: MFA_STRINGS.rateLimitedFor(result.error.retryAfterSeconds),
      };
    }
    return { status: "failed", code, method, message: errorMessage(result.error) };
  }
  if (!isSession(result.data)) {
    return { status: "failed", code: "INTERNAL_ERROR", method, message: errorMessage("INTERNAL_ERROR") };
  }

  writeCookies(cookieStore, [...sessionCookies(result.data), ...challengeCleared(cookieStore)]);
  redirect(next ?? DASHBOARD_PATH);
}
