/** Shortest card number (ISO/IEC 7812 payment cards) for which the BIN may be shown next to the last 4. */
const MIN_PAN_DIGITS_FOR_BIN = 12;
const BIN_DIGITS = 6;
const LAST_DIGITS = 4;
const MASK_CHAR = "*";

function digitsOf(value: string | number): string {
  return String(value).replace(/\D/g, "");
}

/**
 * Masks a card number to its BIN (first 6 digits) and last 4 digits, the most PCI DSS truncation allows
 * (ADR-0011): `maskPan("4111111111111111")` is `"411111******1111"`. Spaces and dashes are ignored.
 * A value too short to be a card number keeps only its last 4 digits, and one of 4 digits or fewer is
 * masked completely, so the result never shows more than a truncated card number.
 */
export function maskPan(pan: string | number): string {
  const digits = digitsOf(pan);
  if (digits.length >= MIN_PAN_DIGITS_FOR_BIN) {
    const hidden = digits.length - BIN_DIGITS - LAST_DIGITS;
    return digits.slice(0, BIN_DIGITS) + MASK_CHAR.repeat(hidden) + digits.slice(-LAST_DIGITS);
  }
  if (digits.length > LAST_DIGITS) {
    return MASK_CHAR.repeat(digits.length - LAST_DIGITS) + digits.slice(-LAST_DIGITS);
  }
  return MASK_CHAR.repeat(digits.length);
}

/** The last 4 digits of a card number, the only part `redactPayload` keeps (db README §8). */
export function lastFourDigits(pan: string | number): string {
  return digitsOf(pan).slice(-LAST_DIGITS);
}

/** The last 4 characters of a document, resident card or certificate number (db README §8). */
export function lastFourChars(value: string | number): string {
  return String(value).trim().slice(-LAST_DIGITS);
}
