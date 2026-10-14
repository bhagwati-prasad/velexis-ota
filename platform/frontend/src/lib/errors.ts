import type { PlatformErrorCode } from "@velexis/errors";

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
