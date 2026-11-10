import "server-only";

import type { components } from "@velexis/api-types/platform";
import { z } from "zod";

import type { ApiError } from "@/lib/api";
import { qrCode, QR_MAX_TEXT_LENGTH, type QrCode } from "@/lib/qr";

/**
 * The checks of the two-factor set-up, shared by the security page (`account/security/actions.ts`) and the MFA
 * enrolment page (`mfa-enrolment/actions.ts`, PFE-030), so both accept and refuse the same answers (FIX-W46-PLATFORM,
 * lead decision (11c) of 2026-11-06): the code a person types (`TOTP_CODE`), the answer of `startMfaSetup`
 * (`pendingSetupOf`: the base32 secret and the `otpauth://` URI of the platform document's `MfaSetup`) and the
 * recovery codes of `enableMfa` and `regenerateRecoveryCodes` (`recoveryCodesOf`: the document's `RecoveryCodes`). An
 * answer that is not the document's is refused whole and nothing of it is shown: the actions answer
 * `MALFORMED_ANSWER`'s general message instead. Server only: the secret, the URI and the codes never reach a module the
 * browser loads, except in an action's answer.
 */

/** A pending TOTP set-up: the base32 secret, its QR code and the seconds until it expires. Shown once. */
export interface PendingMfaSetup {
  readonly secret: string;
  readonly qr: QrCode;
  readonly expiresIn: number;
}

/** `MfaSetup.secret` of the platform document: base32, padded with `=`. */
export const TOTP_SECRET = /^[A-Z2-7]+=*$/;

/** `MfaSetup.otpauthUrl` of the platform document: a TOTP URI. */
export const OTPAUTH_URL = /^otpauth:\/\/totp\//;

/** `TotpCode` of the platform document; spaces a person typed are dropped. */
export const TOTP_CODE = z
  .string()
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().regex(/^[0-9]{6}$/));

/** One recovery code as `RecoveryCodes` answers it: four groups of four Crockford base32 characters. */
export const RECOVERY_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

/** How many recovery codes `RecoveryCodes` holds. */
export const RECOVERY_CODE_COUNT = 10;

/** A failure of an answer that is not what the document describes; nothing of it is shown. */
export const MALFORMED_ANSWER: ApiError = Object.freeze({
  code: "INTERNAL_ERROR",
  status: 500,
  fieldErrors: Object.freeze([]),
  details: Object.freeze({}),
});

/**
 * The pending set-up of a `startMfaSetup` answer, its URI encoded as a QR code here on the server (`lib/qr.ts`), or
 * `undefined` when the answer is not the document's `MfaSetup`: no object, a secret that is no base32 string, a URI that
 * is no TOTP URI string or is longer than `QR_MAX_TEXT_LENGTH`, or an `expiresIn` that is not a whole number of seconds
 * from 1. Answers are not validated at run time, so each field's type is checked here too (a regular expression would
 * accept the number 234567 as a secret, or a one-element array as a URI).
 */
export function pendingSetupOf(answer: components["schemas"]["MfaSetup"]): PendingMfaSetup | undefined {
  if (typeof answer !== "object" || (answer as unknown) === null) {
    return undefined;
  }
  const { secret, otpauthUrl, expiresIn } = answer as Readonly<
    Record<keyof components["schemas"]["MfaSetup"], unknown>
  >;
  if (
    typeof secret !== "string" ||
    !TOTP_SECRET.test(secret) ||
    typeof otpauthUrl !== "string" ||
    !OTPAUTH_URL.test(otpauthUrl) ||
    otpauthUrl.length > QR_MAX_TEXT_LENGTH ||
    typeof expiresIn !== "number" ||
    !Number.isInteger(expiresIn) ||
    expiresIn < 1
  ) {
    return undefined;
  }
  return { secret, qr: qrCode(otpauthUrl), expiresIn };
}

/** The recovery codes of an answer, frozen, or `undefined` when the answer is not the document's `RecoveryCodes`. */
export function recoveryCodesOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length !== RECOVERY_CODE_COUNT) {
    return undefined;
  }
  const codes = value.filter((code): code is string => typeof code === "string" && RECOVERY_CODE.test(code));
  return codes.length === RECOVERY_CODE_COUNT ? Object.freeze(codes) : undefined;
}
