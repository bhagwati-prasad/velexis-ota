// The server's checks of the airline card of checkout.completeWithAirlineCard (OBE-051; ota/docs/api-changes.md §3.2,
// ota/docs/flows/checkout-airline-card.md §3 step 4 and §4, OADR-0004 point 2). The request validation (the OTA
// document's AirlineCardCompletionRequest, Ajv) already checked the shape: digits, lengths, the month, the year range,
// the brand's enum. What the schema cannot say is checked here, on the card of the body, once, in the controller:
//
//   - the Luhn check digit of the number (`fieldErrors[].code = "luhn"`, path `/card/number`);
//   - an expiry in the past (`"expired"`, path `/card/expiryYear`): a card is valid until the end of its expiry month,
//     so only a month that has ended in UTC is refused;
//   - a holder name that is blank once trimmed (`"pattern"`, path `/card/holderName`: SensitiveCard needs 2 to 64
//     letters, spaces, `.`, `'` or `-` after trimming).
//
// A card without such an error is wrapped in a SensitiveCard (sensitive-card.ts) at once; the plain card object is never
// passed on. The accepted brands of the storefront are the completion service's check (`422 UNPROCESSABLE`), as they
// need the tenant's settings. Field errors name the field and the rule, never the value (a message never quotes a
// digit), so a `400 VALIDATION_FAILED` and its log line carry nothing of the card.
import type { FieldError } from "@velexis/errors";
import { SensitiveCard, type AirlineCardInput } from "./sensitive-card";

/** The field errors' JSON pointers into the request body (the validation interceptor's pointers). */
export const CARD_FIELD_PATHS = Object.freeze({
  holderName: "/card/holderName",
  number: "/card/number",
  expiry: "/card/expiryYear",
} as const);

/** The holder name as SensitiveCard keeps it: 2 to 64 letters, spaces, `.`, `'` and `-` once trimmed. */
const HOLDER = /^[A-Za-z .'-]{2,64}$/;

/** True when `digits` (only digits) passes the Luhn check (ISO/IEC 7812-1 annex B). */
export function luhnValid(digits: string): boolean {
  if (!/^[0-9]{2,}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True when a card of `month`/`year` expired before `now`: its month ended (UTC) before now. */
export function cardExpired(month: number, year: number, now: Date): boolean {
  const thisYear = now.getUTCFullYear();
  const thisMonth = now.getUTCMonth() + 1;
  return year < thisYear || (year === thisYear && month < thisMonth);
}

/** The field errors of a card the request validation accepted (see the file header); empty when it is good. */
export function cardFieldErrors(card: AirlineCardInput, now: Date): FieldError[] {
  const errors: FieldError[] = [];
  if (typeof card.holderName !== "string" || !HOLDER.test(card.holderName.trim())) {
    errors.push({
      path: CARD_FIELD_PATHS.holderName,
      code: "pattern",
      message: "The name on the card must have 2 to 64 letters, spaces, dots, apostrophes or hyphens.",
    });
  }
  if (typeof card.number !== "string" || !luhnValid(card.number)) {
    errors.push({
      path: CARD_FIELD_PATHS.number,
      code: "luhn",
      message: "The card number is not valid. Check the digits.",
    });
  }
  if (cardExpired(card.expiryMonth, card.expiryYear, now)) {
    errors.push({ path: CARD_FIELD_PATHS.expiry, code: "expired", message: "The card has expired." });
  }
  return errors;
}

/**
 * The checked card of a request: the field errors of the card (`cardFieldErrors`), or, when there are none, the card
 * wrapped in a SensitiveCard. The completion service answers the errors in its order of checks (after the switches and
 * the limits), so the controller can let go of the plain card object at once.
 */
export type CheckedCard =
  | { readonly ok: true; readonly card: SensitiveCard }
  | { readonly ok: false; readonly fieldErrors: readonly FieldError[] };

/** Checks the card and wraps it (see `CheckedCard`); never keeps or returns a value of the plain object. */
export function checkAirlineCard(card: AirlineCardInput, now: Date): CheckedCard {
  const fieldErrors = cardFieldErrors(card, now);
  if (fieldErrors.length > 0) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, card: SensitiveCard.from(card) };
}
