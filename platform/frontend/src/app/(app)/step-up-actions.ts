"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { z } from "zod";

import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { setSession } from "@/lib/session";
import { STEP_UP_STRINGS } from "@/lib/strings";

/**
 * The step-up server action of `StepUpDialog` (README §5, PADR-0008). Sensitive operations answer
 * `401 REAUTH_REQUIRED` without a TOTP verification in the last 15 minutes; the action that called one returns
 * `StepUpRequired`, the dialog asks for a code, `stepUp` exchanges it for a new session, and the dialog
 * re-submits the original action, which then carries the new access token.
 */

/**
 * What a server action returns (or includes in its state) when its API call answered `REAUTH_REQUIRED`. The
 * action's other state fields stay as they were.
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
      /** Any other problem (rate limit, MFA not set up, session ended): shown above the field. */
      readonly message?: string;
    };

/** A TOTP code as `TotpCode` of the platform document defines it; spaces a person typed are dropped. */
const TOTP_CODE = z
  .string()
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().regex(/^[0-9]{6}$/));

/** Codes that are about the typed code, so the message belongs at the field. */
const FIELD_CODES: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "VALIDATION_FAILED",
  "MFA_CODE_INVALID",
]);

/**
 * Exchanges the TOTP code of the form field `code` for a new session of the same family (`POST
 * /v1/auth/step-up`) and stores its tokens in the session cookies, so the next request (the re-submitted action)
 * sends the new access token with `mfa_at` now. The code is never logged or returned.
 */
export async function stepUp(_previous: StepUpState, formData: FormData): Promise<StepUpState> {
  const parsed = TOTP_CODE.safeParse(formData.get("code") ?? "");
  if (!parsed.success) {
    return { status: "failed", code: "VALIDATION_FAILED", fieldError: STEP_UP_STRINGS.codeFormat };
  }
  const api = await platformApi();
  const result = await api.POST("/v1/auth/step-up", { body: { code: parsed.data } });
  if (result.error !== undefined) {
    const message = errorMessage(result.error);
    return FIELD_CODES.has(result.error.code)
      ? { status: "failed", code: result.error.code, fieldError: message }
      : { status: "failed", code: result.error.code, message };
  }
  await setSession(result.data);
  return { status: "verified" };
}
