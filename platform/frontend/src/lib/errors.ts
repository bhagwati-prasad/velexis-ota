import type { PlatformErrorCode } from "@velexis/errors";
import { redirect } from "next/navigation";

import { ERROR_MESSAGES, UNKNOWN_ERROR_MESSAGE } from "@/lib/strings";

/**
 * Error code → user message (README §5, conventions §3). Pages and actions show these messages, keyed by the
 * code of the API's error envelope, never the API's own `message` or a stack trace. Plain data without secrets,
 * so `error.tsx` boundaries (client components) may use it too.
 */

/** `code` is a code of the platform catalogue that has a message. */
export function isPlatformErrorCode(code: unknown): code is PlatformErrorCode {
  return typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code);
}

/** The message for an error code, or for an error with a code (`ApiError`); a generic one for unknown codes. */
export function errorMessage(error: string | { readonly code: string }): string {
  const code = typeof error === "string" ? error : error.code;
  return isPlatformErrorCode(code) ? ERROR_MESSAGES[code] : UNKNOWN_ERROR_MESSAGE;
}

// ---- The MFA enrolment gate (PFE-030; PADR-0008, revision of 2026-11-05; scope PF-04 AC4) -------------------------
//
// An active owner or admin of a live OTA without MFA turns MFA on before any other portal page. The rule is the API's
// alone (PBE-071's MfaEnrolmentGuard): the portal reads `Account.mfaEnrolmentRequired` of `getMe` in the `(app)`
// layout, and the API's answer `403 MFA_REQUIRED` with `details.reason = enrolment_required` everywhere else. Both send
// the browser to `/mfa-enrolment?next=<the page>` (`mfaEnrolmentPath`); the page keeps `next` only when
// `safeNextPath()` accepts it, as the sign-in does.

/** The enrolment page, outside the signed-in shell (`(auth)/mfa-enrolment/page.tsx`). */
export const MFA_ENROLMENT_PATH = "/mfa-enrolment";

/** `details.reason` of the API's `403 MFA_REQUIRED` for an account that must enrol (the document's example). */
export const MFA_ENROLMENT_REASON = "enrolment_required";

/** An error envelope's code and details, as `ApiError` of `lib/api.ts` carries them. */
interface CodedError {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** `error` is the API's MFA enrolment gate: `MFA_REQUIRED` with `details.reason = enrolment_required`. */
export function isMfaEnrolmentRequired(error: CodedError): boolean {
  return error.code === "MFA_REQUIRED" && error.details?.["reason"] === MFA_ENROLMENT_REASON;
}

/** `/mfa-enrolment`, with `next` when there is one (the page checks it with `safeNextPath()` again). */
export function mfaEnrolmentPath(next?: string): string {
  return next === undefined || next === ""
    ? MFA_ENROLMENT_PATH
    : `${MFA_ENROLMENT_PATH}?${new URLSearchParams({ next }).toString()}`;
}

/**
 * Sends the browser to the enrolment page, and back to `next` afterwards, when `error` is the API's enrolment gate
 * (`redirect()`: a `303` from a server action, a `307` from a server component or a `GET` route handler); returns
 * otherwise. `platformApi()` of `lib/api.ts` calls it for every refused call, with the page of the request, so every
 * page, server action and route handler that uses `platformApi()` leaves for the enrolment the same way. A route handler
 * with a client of its own (the console launch, Stripe Connect's callback) answers its own `303` to `mfaEnrolmentPath()`.
 */
export function leaveForMfaEnrolment(error: CodedError, next?: string): void {
  if (isMfaEnrolmentRequired(error)) {
    redirect(mfaEnrolmentPath(next));
  }
}
