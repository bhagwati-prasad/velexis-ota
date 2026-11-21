// The card-number detector of free text (ADR-0011, OADR-0004; FIX-W67-KI001, lead decision (36) of 2026-11-21): a
// payment card number never reaches storage, so the text a staff member types (a booking note, a reason, a remark) is
// refused when it holds one, before anything is written. The OTA API refuses it in every console free-text field
// (ota/backend/src/common/http/card-free-text.ts, and the review closure's note in
// ota/backend/src/console/review-closure.service.ts), and the OTA admin's server actions refuse it at the field before
// they call the API. It lives here, beside `maskPan`, so that both use one detector; it holds its own Luhn function,
// because a package never imports from an app (the airline-card path keeps its own in
// ota/backend/src/payments/airline-card/card-validation.ts).
//
// The detector answers a boolean and never keeps, logs or returns the text or the number it found.

/** A run of digit groups joined by single spaces or dashes (`4111 1111 1111 1111 123`), or one group alone. */
const DIGIT_RUN = /\d+(?:[ -]\d+)*/g;

/** The lengths of a payment card number (ISO/IEC 7812). */
const CARD_DIGITS = { min: 12, max: 19 } as const;

/** The first digit of a payment card's issuer number (ISO/IEC 7812: 2 to 6 for the card brands the OTAs take). */
const CARD_FIRST_DIGIT = /^[2-6]/;

/** True when `digits` (ASCII digits only, at least 2) passes the Luhn check (ISO/IEC 7812-1 annex B). */
function passesLuhn(digits: string): boolean {
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

/**
 * Whether `text` holds a card number: 12 to 19 digits, grouped by single spaces or dashes or not, that start as a card
 * brand's number does (2 to 6) and pass the Luhn check. Every span of whole consecutive groups of a run is tried, so a
 * number next to other digits (a security code or an expiry after it, a reference before it: `4111 1111 1111 1111
 * 123`) is found too; a tab, a line break or any other character between two groups ends the run. A free text never
 * keeps one (ADR-0011, OADR-0004). Amounts, dates, phones of up to 11 digits and the ticket numbers of the airline
 * codes that start with 0, 1 or 7 to 9 (`057-…`) are never taken for one; a ticket number of an airline code from 2 to
 * 6 (13 digits), or a phone of 12 digits or more written with a country code from 2 to 6 (`+44 20 …`), is refused
 * like a card number when its digits pass the Luhn check (one in ten of them).
 */
export function holdsCardNumber(text: string): boolean {
  for (const match of text.matchAll(DIGIT_RUN)) {
    const groups = match[0].split(/[ -]/);
    for (let start = 0; start < groups.length; start += 1) {
      let digits = "";
      for (let end = start; end < groups.length && digits.length < CARD_DIGITS.max; end += 1) {
        digits += groups[end] ?? "";
        if (
          digits.length >= CARD_DIGITS.min &&
          digits.length <= CARD_DIGITS.max &&
          CARD_FIRST_DIGIT.test(digits) &&
          passesLuhn(digits)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}
