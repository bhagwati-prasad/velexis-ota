// The card statement descriptor suffix of a `velexis`-mode payment connection (ADR-0011, Velexis mode;
// platform/docs/flows/stripe-payments-account.md §A, provisioning.md §3 `create_payment_connection`): payments on the
// Velexis Stripe account show the OTA's brand on the customer's card statement. Provisioning derives the suffix from the
// OTA's name (PBE-022); owners and admins edit it later (`updatePaymentConnection`, PBE-038) under the rules of a typed
// suffix at the end of this header.
//
// A derived suffix is ASCII letters, digits and single spaces, starts with a letter or a digit, holds at least one
// letter, and has 2 to 22 characters: the stricter subset of the column's CHECK (`^[A-Za-z0-9][A-Za-z0-9 .&-]{1,21}$`)
// that a derivation can always produce. `statementDescriptorSuffix(name, fallback)` makes one from a name:
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
//
// A **typed** suffix is what an owner or admin sends to `updatePaymentConnection` (PBE-038 step 1). It is stored as
// sent, so `statementDescriptorSuffixProblems(value)` checks Stripe's rules for a suffix and the column's CHECK: only
// ASCII letters, digits and spaces; at least one letter; none of Stripe's forbidden characters (`<`, `>`, `\`, `'`,
// `"`, `*`); at most 22 characters; and, for the CHECK, at least 2 characters, the first a letter or a digit. These are
// the rules of the OpenAPI document's `StatementDescriptorSuffix`, value for value (descriptor.test.ts compares them),
// so the request validation refuses a broken rule first; the service checks again before it writes, because the
// column must never receive anything else. Spaces are kept as typed: unlike a derived suffix, a typed one may hold two
// spaces in a row or end with a space, as the document allows. Every derived suffix is a valid typed one. A problem
// names its rule, never the value.

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

/** The characters Stripe forbids in a statement descriptor, and so in a typed suffix. */
export const STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS: readonly string[] = Object.freeze([
  "<",
  ">",
  "\\",
  "'",
  '"',
  "*",
]);

/**
 * A rule of a typed suffix, the `code` of its field error: `type` (not a string), `minLength` (fewer than 2
 * characters), `maxLength` (more than 22), `forbiddenCharacter` (one of Stripe's forbidden characters), `characters` (any
 * other character that is not an ASCII letter, a digit or a space), `letter` (no letter) and `start` (a space first;
 * other characters are refused by their own rules wherever they stand).
 */
export type DescriptorSuffixRule =
  "type" | "minLength" | "maxLength" | "forbiddenCharacter" | "characters" | "letter" | "start";

/** One rule a typed suffix breaks, with a message that never holds the value. */
export interface DescriptorSuffixProblem {
  readonly code: DescriptorSuffixRule;
  readonly message: string;
}

const RULE_MESSAGES: Readonly<Record<DescriptorSuffixRule, string>> = Object.freeze({
  type: "Must be a string.",
  minLength: `Must have at least ${STATEMENT_DESCRIPTOR_SUFFIX_MIN_LENGTH} characters.`,
  maxLength: `Must have at most ${STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH} characters.`,
  forbiddenCharacter: `Must not contain any of ${STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS.join(" ")}.`,
  characters: "May contain only ASCII letters, digits and spaces.",
  letter: "Must contain at least one letter.",
  start: "Must start with a letter or a digit.",
});

const FORBIDDEN: ReadonlySet<string> = new Set(STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS);

/** An ASCII letter, a digit or a space: the characters of a typed suffix. */
const TYPED_CHARACTER = /^[A-Za-z0-9 ]$/;

/**
 * The rules that `value`, a suffix as an owner or admin typed it, breaks (see the file header), in the order of
 * DescriptorSuffixRule; an empty list for a suffix that may be stored as it is. Lengths count Unicode code points, as
 * the OpenAPI document's `minLength` and `maxLength` do.
 */
export function statementDescriptorSuffixProblems(value: unknown): DescriptorSuffixProblem[] {
  if (typeof value !== "string") {
    return [{ code: "type", message: RULE_MESSAGES.type }];
  }
  const characters = [...value];
  const broken: DescriptorSuffixRule[] = [];
  if (characters.length < STATEMENT_DESCRIPTOR_SUFFIX_MIN_LENGTH) {
    broken.push("minLength");
  }
  if (characters.length > STATEMENT_DESCRIPTOR_SUFFIX_MAX_LENGTH) {
    broken.push("maxLength");
  }
  if (characters.some((character) => FORBIDDEN.has(character))) {
    broken.push("forbiddenCharacter");
  }
  if (characters.some((character) => !FORBIDDEN.has(character) && !TYPED_CHARACTER.test(character))) {
    broken.push("characters");
  }
  if (!/[A-Za-z]/.test(value)) {
    broken.push("letter");
  }
  if (characters[0] === " ") {
    broken.push("start");
  }
  return broken.map((code) => ({ code, message: RULE_MESSAGES[code] }));
}
