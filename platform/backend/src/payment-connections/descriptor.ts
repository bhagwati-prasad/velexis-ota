// The card statement descriptor suffix of a `velexis`-mode payment connection (ADR-0011, Velexis mode;
// platform/docs/flows/stripe-payments-account.md §A, provisioning.md §3 `create_payment_connection`): payments on the
// Velexis Stripe account show the OTA's brand on the customer's card statement. Provisioning derives the suffix from the
// OTA's name (PBE-022); owners edit it later (`updatePaymentConnection`, PBE-038, which adds Stripe's own character
// rules for what a person types).
//
// A suffix is ASCII letters, digits and single spaces, starts with a letter or a digit, holds at least one letter, and
// has 2 to 22 characters: the stricter subset of the column's CHECK (`^[A-Za-z0-9][A-Za-z0-9 .&-]{1,21}$`) that a
// derivation can always produce. `statementDescriptorSuffix(name, fallback)` makes one from a name:
//
// 1. Latin letters lose their accents (NFKD, combining marks dropped: `Café` → `Cafe`), and the letters NFKD does not
//    decompose are spelled in ASCII (`ß` → `ss`, `Æ` → `AE`, `Ø` → `O`, `Ł` → `L`, …).
// 2. Every run of other characters (punctuation, symbols, other scripts, white space) becomes one space; the ends are
//    trimmed. The letter case is kept.
// 3. A text longer than 22 characters is cut after the last whole word that fits, or at 22 characters when its first
//    word is longer.
// 4. When the name gives no valid suffix (fewer than 2 characters, or no letter: `東京トラベル`, `24/7`), the fallback
//    (the tenant key, with `_` as spaces) is tried the same way; when that fails too, the answer is `null` and the
//    connection has no suffix (the column is nullable; Stripe then shows the account's own descriptor).

/** The longest suffix, in characters (Stripe's limit for the full descriptor is 22 too). */
export const STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH = 22;

/** The shortest suffix the column's CHECK accepts. */
export const STATEMENT_DESCRIPTOR_SUFFIX_MIN_LENGTH = 2;

/** ASCII letters, digits and single spaces, starting and ending with a letter or a digit, 2 to 22 characters. */
const SUFFIX_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]| (?=[A-Za-z0-9])){1,21}$/;

/** Latin letters that NFKD leaves alone, spelled in ASCII. */
const ASCII_SPELLING: Readonly<Record<string, string>> = Object.freeze({
  ß: "ss",
  ẞ: "SS",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ø: "o",
  Ø: "O",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "Th",
  ı: "i",
});

const NOT_ASCII_SPELLED = new RegExp(`[${Object.keys(ASCII_SPELLING).join("")}]`, "gu");

/**
 * True when `value` is a statement descriptor suffix of this module: ASCII letters, digits and single spaces, starting
 * and ending with a letter or a digit, at least one letter, 2 to 22 characters.
 */
export function isStatementDescriptorSuffix(value: unknown): value is string {
  return typeof value === "string" && SUFFIX_PATTERN.test(value) && /[A-Za-z]/.test(value);
}

/** `text` in ASCII letters, digits and single spaces (steps 1 and 2 of the file header). */
export function asciiDescriptorText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(NOT_ASCII_SPELLED, (letter) => ASCII_SPELLING[letter] ?? " ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
}

/** `text` cut to at most 22 characters after its last whole word that fits (step 3 of the file header). */
export function cutDescriptorText(text: string): string {
  if (text.length <= STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH) {
    return text;
  }
  // One character more than fits: when it is a space, the whole 22 characters are words.
  const window = text.slice(0, STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH + 1);
  const lastSpace = window.lastIndexOf(" ");
  const cut =
    lastSpace > 0 ? window.slice(0, lastSpace) : text.slice(0, STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH);
  return cut.trimEnd();
}

/** The suffix made from one text, or `undefined` when it gives none. */
function suffixOf(text: string): string | undefined {
  const suffix = cutDescriptorText(asciiDescriptorText(text));
  return isStatementDescriptorSuffix(suffix) ? suffix : undefined;
}

/**
 * The statement descriptor suffix derived from the OTA's `name`, else from `fallback` (the tenant key), else `null`
 * (see the file header).
 */
export function statementDescriptorSuffix(name: string, fallback?: string): string | null {
  return suffixOf(name) ?? (fallback === undefined ? undefined : suffixOf(fallback)) ?? null;
}
