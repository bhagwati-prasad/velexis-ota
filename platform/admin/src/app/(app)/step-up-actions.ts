"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { z } from "zod";

import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { setSession, type AdminSession } from "@/lib/session";
import { STEP_UP_STRINGS } from "@/lib/strings";

/**
 * The step-up server action of `StepUpDialog` (README §2 "step-up", §4; PADR-0006). Admin operations marked
 * `x-mfa-step-up` answer `401 REAUTH_REQUIRED` without a TOTP verification in the last 15 minutes; the server action
 * that called one returns `StepUpRequired`, the dialog asks for a code, `stepUp` exchanges it for a new session of the
 * same family (`adminStepUp`), and the dialog re-submits the original action, which then carries the new access
 * token.
 */

/**
 * What a server action returns (or includes in its state) when its API call answered `REAUTH_REQUIRED`. The action's
 * other state fields stay as they were.
 */
export interface StepUpRequired {
  readonly stepUp: true;
}

/** The state of the step-up form. */
export type StepUpState =
  | { readonly status: "idle" }
  | { readonly status: "verified" }
  | {
      readonly status: "failed";
      /** The error code, for tests and logs; never shown. */
      readonly code: PlatformErrorCode;
      /** A problem with the code itself (format, wrong code): shown at the field. */
      readonly fieldError?: string;
      /** Any other problem (rate limit, session ended, API unavailable): shown above the field. */
      readonly message?: string;
    };

/** `TotpCode` of the platform document; spaces an admin typed are dropped. */
const TOTP_CODE = z
  .string()
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().regex(/^[0-9]{6}$/));

/** Codes that are about the typed code, so the message belongs at the field. */
const FIELD_CODES: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "VALIDATION_FAILED",
  "MFA_CODE_INVALID",
]);

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
 * Exchanges the TOTP code of the form field `code` for a new session of the same family (`POST
 * /v1/admin/auth/step-up`, with the current admin bearer token) and stores its tokens in `__Host-vxa_at` and
 * `__Host-vxa_rt`, so the next request (the re-submitted action) sends the new access token with `mfa_at` now. The
 * code is never logged, kept or returned.
 */
export async function stepUp(_previous: StepUpState, formData: FormData): Promise<StepUpState> {
  const parsed = TOTP_CODE.safeParse(formData.get("code") ?? "");
  if (!parsed.success) {
    return { status: "failed", code: "VALIDATION_FAILED", fieldError: STEP_UP_STRINGS.codeFormat };
  }
  const api = await platformApi();
  const result = await api.POST("/v1/admin/auth/step-up", { body: { code: parsed.data } });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (FIELD_CODES.has(code)) {
      return {
        status: "failed",
        code,
        fieldError: code === "VALIDATION_FAILED" ? STEP_UP_STRINGS.codeFormat : errorMessage(code),
      };
    }
    if (code === "RATE_LIMITED" && result.error.retryAfterSeconds !== undefined) {
      return {
        status: "failed",
        code,
        message: STEP_UP_STRINGS.rateLimitedFor(result.error.retryAfterSeconds),
      };
    }
    return { status: "failed", code, message: errorMessage(code) };
  }
  if (!isSession(result.data)) {
    return { status: "failed", code: "INTERNAL_ERROR", message: errorMessage("INTERNAL_ERROR") };
  }
  await setSession(result.data);
  return { status: "verified" };
}
