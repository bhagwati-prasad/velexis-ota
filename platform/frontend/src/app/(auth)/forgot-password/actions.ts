"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { headers } from "next/headers";
import { z } from "zod";

import { createPlatformApi } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { PASSWORD_RESET_STRINGS, SIGN_IN_STRINGS } from "@/lib/strings";

/**
 * The server action of `/forgot-password` (README §2 Auth, PF-05 AC1). `requestPasswordReset` asks the API to
 * e-mail a reset link (`POST /v1/auth/password-reset`, public, with the end-user headers of PADR-0019). The API
 * answers `202` whatever the address, so the confirmation is always the same and never says whether an account
 * exists. More than 3 links per address or 10 calls per IP in an hour answer `RATE_LIMITED`, for any address.
 */

/** The state of the form. */
export interface ForgotPasswordState {
  readonly status: "idle" | "sent" | "failed";
  /** The error code of a failure, for tests and logs; never shown. */
  readonly code?: PlatformErrorCode;
  /** A problem with the typed address: shown at the field. */
  readonly fieldError?: string;
  /** The confirmation, or a problem that belongs to no field. */
  readonly message?: string;
  /** The typed address, so the form keeps it. */
  readonly email: string;
}

/** `EmailAddress` of the platform document: trimmed, an address, at most 254 characters. */
const EMAIL = z.string().trim().min(1).max(254).email();

/** Asks for a reset link for the form field `email`. */
export async function requestPasswordReset(
  _previous: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const typed = formData.get("email");
  const email = typeof typed === "string" ? typed : "";
  const parsed = EMAIL.safeParse(email);
  if (!parsed.success) {
    return {
      status: "failed",
      code: "VALIDATION_FAILED",
      fieldError: email.trim() === "" ? SIGN_IN_STRINGS.emailRequired : SIGN_IN_STRINGS.emailInvalid,
      email,
    };
  }

  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  const result = await api.POST("/v1/auth/password-reset", { body: { email: parsed.data } });
  if (result.error === undefined) {
    return { status: "sent", message: PASSWORD_RESET_STRINGS.sent, email };
  }
  const { code } = result.error;
  if (code === "RATE_LIMITED") {
    return { status: "failed", code, message: PASSWORD_RESET_STRINGS.requestRateLimited, email };
  }
  if (code === "VALIDATION_FAILED") {
    return { status: "failed", code, fieldError: SIGN_IN_STRINGS.emailInvalid, email };
  }
  return { status: "failed", code, message: errorMessage(result.error), email };
}
