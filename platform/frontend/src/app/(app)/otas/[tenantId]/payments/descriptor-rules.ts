/**
 * The rules of a card statement descriptor suffix as an owner or admin types it (PFE-016; flows/stripe-payments-account.md
 * §A item 3; PF-60), shared by the form in the browser (`descriptor-form.tsx`, live and before a submit) and the server
 * action (`actions.ts`, whose Zod schema applies them again before any call). They are the rules of the platform
 * document's `StatementDescriptorSuffix` and of the API's `statementDescriptorSuffixProblems`
 * (platform/backend/src/payment-connections/descriptor.ts): 2 to 22 characters (Unicode code points, as JSON Schema
 * counts them), only the ASCII letters A to Z, digits and spaces, starting with a letter or a digit, at least one letter,
 * and none of Stripe's forbidden characters (`<`, `>`, `\`, `'`, `"`, `*`). The form trims the ends first, so a stray
 * space typed before or after the brand is never refused or sent; inside the suffix spaces stay as typed, as the API
 * stores them. A module without a directive and without Zod: the client form and the `"use server"` action both import
 * it (a `"use client"` module would reach the action only as client references), and Zod stays out of the browser.
 */

/** The shortest suffix the API accepts. */
export const DESCRIPTOR_SUFFIX_MIN_LENGTH = 2;

/** The longest suffix the API accepts. */
export const DESCRIPTOR_SUFFIX_MAX_LENGTH = 22;

/** The longest line a card statement shows: Stripe cuts the suffix of a longer `PREFIX* SUFFIX` line. */
export const STATEMENT_LINE_MAX_LENGTH = 22;

/**
 * The shortened descriptor of the Velexis Stripe account, which Stripe puts before the suffix of a Velexis-mode payment
 * (`VELEXIS* ACME TRAVEL`, the `calculated_statement_descriptor` of the Stripe fixtures in `@velexis/testing`). It is
 * set in the Velexis Stripe account, not by the portal; the preview only shows it.
 */
export const STATEMENT_DESCRIPTOR_PREFIX = "VELEXIS";

/** The characters Stripe forbids in a statement descriptor. */
export const STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS: readonly string[] = Object.freeze([
  "<",
  ">",
  "\\",
  "'",
  '"',
  "*",
]);

/**
 * A rule a suffix breaks, in the order the form reports them: `required` (nothing typed), `forbiddenCharacter` (one of
 * Stripe's forbidden characters), `characters` (any other character that is not an ASCII letter, a digit or a space),
 * `minLength`, `maxLength` and `letter` (no letter at all). A trimmed suffix never starts with a space, so the API's
 * `start` rule cannot break here; its message still exists for an answer of the API.
 */
export type DescriptorProblem =
  "required" | "forbiddenCharacter" | "characters" | "minLength" | "maxLength" | "letter";

const FORBIDDEN: ReadonlySet<string> = new Set(STRIPE_FORBIDDEN_DESCRIPTOR_CHARACTERS);

/** An ASCII letter, a digit or a space: the characters of a typed suffix. */
const TYPED_CHARACTER = /^[A-Za-z0-9 ]$/;

/**
 * The character rule `suffix` breaks (`forbiddenCharacter` before `characters`), or `null`. The form shows it while the
 * person types: these are the problems no further typing fixes.
 */
export function characterProblem(suffix: string): "forbiddenCharacter" | "characters" | null {
  const characters = [...suffix];
  if (characters.some((character) => FORBIDDEN.has(character))) {
    return "forbiddenCharacter";
  }
  if (characters.some((character) => !TYPED_CHARACTER.test(character))) {
    return "characters";
  }
  return null;
}

/** The first rule `suffix` (already trimmed) breaks, in the order of `DescriptorProblem`, or `null` when it may be sent. */
export function descriptorSuffixProblem(suffix: string): DescriptorProblem | null {
  if (suffix === "") {
    return "required";
  }
  const characters = characterProblem(suffix);
  if (characters !== null) {
    return characters;
  }
  // Only ASCII is left, so the length in code points is the string's length.
  if (suffix.length < DESCRIPTOR_SUFFIX_MIN_LENGTH) {
    return "minLength";
  }
  if (suffix.length > DESCRIPTOR_SUFFIX_MAX_LENGTH) {
    return "maxLength";
  }
  if (!/[A-Za-z]/.test(suffix)) {
    return "letter";
  }
  return null;
}

/** The longest suffix a statement shows in full after `PREFIX* `. */
export const SUFFIX_SHOWN_IN_FULL = STATEMENT_LINE_MAX_LENGTH - STATEMENT_DESCRIPTOR_PREFIX.length - 2;

/** The card statement line of a suffix, as the preview shows it. */
export interface StatementLine {
  /** `PREFIX* SUFFIX` in capital letters, cut after 22 characters. */
  readonly line: string;
  /** The end of the suffix does not fit on the line. */
  readonly cut: boolean;
}

/**
 * The line a card statement shows for a payment with this suffix (already trimmed): the Velexis account's prefix, `* `,
 * the suffix, in capital letters as most banks print it, and no more than 22 characters, as Stripe cuts a longer suffix.
 * `null` for a suffix the API would refuse: the preview never shows a line no payment can have.
 */
export function statementLine(suffix: string): StatementLine | null {
  if (descriptorSuffixProblem(suffix) !== null) {
    return null;
  }
  const full = `${STATEMENT_DESCRIPTOR_PREFIX}* ${suffix.toUpperCase()}`;
  return full.length > STATEMENT_LINE_MAX_LENGTH
    ? { line: full.slice(0, STATEMENT_LINE_MAX_LENGTH).trimEnd(), cut: true }
    : { line: full, cut: false };
}
