import { SIGN_UP_STRINGS } from "@/lib/strings";

/**
 * The password rule of every portal account, as the portal checks it before the API (README §2; ADR-0008, revisions of
 * 2026-11-10 and 2026-11-11: PCI DSS 8.3.6, the owner's decision (15e), FIX-W48-PLATFORM): at least 12 characters with
 * at least one letter and one digit, at most 256 (the document's `Password`), counted in Unicode code points as the
 * API counts them. The breached-password list is the API's alone (its field code `breached`). The sign-up, the reset
 * and the change of a password use the same rule, an invited person included (they sign up first), so the three
 * actions check it with `meetsPasswordRule` and read the API's field codes with `passwordFieldMessage`, and the three
 * forms take `PASSWORD_MIN_LENGTH` as their `minlength`. No Zod here: the forms are client components.
 */

/** The shortest password, in characters (code points). */
export const PASSWORD_MIN_LENGTH = 12;
/** The longest password the document takes (`Password.maxLength`). */
export const PASSWORD_MAX_LENGTH = 256;

/** A letter of any script, and a decimal digit, as the API's rule reads them. */
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

/** The length of a password as the API counts it: Unicode code points, so an emoji counts once. */
export function codePoints(value: string): number {
  return [...value].length;
}

/** True when `value` meets the rule's length, letter and digit (the API still checks the breached list). */
export function meetsPasswordRule(value: string): boolean {
  return codePoints(value) >= PASSWORD_MIN_LENGTH && LETTER.test(value) && DIGIT.test(value);
}

/**
 * The portal's message for the API's field error `code` on a new password, or `undefined` for a code it does not know
 * (the caller then shows its general message): `password_rule` and the schema's `minLength` (an empty password) name
 * the rule, `breached` the list, `maxLength` the upper bound.
 */
export function passwordFieldMessage(code: string | undefined): string | undefined {
  if (code === "password_rule" || code === "minLength") {
    return SIGN_UP_STRINGS.passwordRule;
  }
  if (code === "breached") {
    return SIGN_UP_STRINGS.passwordBreached;
  }
  return code === "maxLength" ? SIGN_UP_STRINGS.passwordTooLong : undefined;
}
