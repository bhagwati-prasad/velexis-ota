// The bank identifiers of a payout account (PBE-058; platform/docs/flows/stripe-payments-account.md §B item 1,
// PADR-0003 item 10, scope PF-64): plain functions over the values an owner sends to `setPayoutAccount`, used before
// anything is encrypted or stored. Every problem names its rule (a `code` and a message for the person), never the
// value: the service turns them into `400 VALIDATION_FAILED` field errors that never echo a bank number.
//
// - **IBAN** (ISO 13616). The request validation has checked the typed form (`Iban` of the OpenAPI document: two
//   letters, two digits, then 11 to 38 letters, digits and spaces). `normaliseIban` removes every space and upper-cases
//   the rest; the normalised IBAN must have the shape `^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$` (15 to 34 characters, the
//   `RevealedIbanPayoutAccount` pattern; `iban_format` otherwise), check digits from 02 to 98 (ISO 7064 MOD 97-10 never
//   gives 00, 01 or 99), and pass the mod-97 check: the first four characters moved to the end, every letter replaced
//   by two digits (A = 10 … Z = 35), the number modulo 97 must be 1 (`iban_checksum` otherwise). The country's own IBAN
//   length is not checked: the checksum catches every single-character error and almost every transposition, and a
//   registry of lengths would refuse a valid IBAN of a country it does not know yet.
// - **BIC** (ISO 9362): upper-cased; the request validation has checked its form (8 or 11 characters).
// - **Local account**: the account and routing numbers are kept as the owner typed them (`RevealedLocalPayoutAccount`:
//   "as the owner entered them"); the account number must hold at least 4 letters or digits besides its spaces and
//   hyphens (`account_number_format`), since its last 4 are shown.
// - **last4** (`PayoutAccount.last4`, `^[A-Z0-9]{4}$`): the last 4 letters or digits of the normalised IBAN or of the
//   account number without its spaces and hyphens, upper-cased. It is the only part of a bank number that is ever
//   stored in clear, answered, audited or shown.

/** A rule a value breaks, for a field error: what the person reads, never the value. */
export interface BankDetailProblem {
  readonly code: "iban_format" | "iban_checksum" | "account_number_format";
  readonly message: string;
}

/** A normalised IBAN: country code, check digits and 11 to 30 letters or digits (15 to 34 characters in all). */
export const NORMALISED_IBAN_PATTERN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;

/** The IBAN as stored: without spaces (or other white space), upper case. */
export function normaliseIban(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/**
 * The remainder modulo 97 of an IBAN's number (ISO 7064 MOD 97-10): the first four characters moved to the end and
 * each letter replaced by its two-digit value (A = 10 … Z = 35), read digit by digit so no big number is built.
 * `value` must be a normalised IBAN (letters A–Z and digits only).
 */
export function ibanRemainder(value: string): number {
  const rearranged = `${value.slice(4)}${value.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const code = character.charCodeAt(0);
    // "0"–"9" are 48–57, "A"–"Z" 65–90: a letter adds two digits (10–35), a digit one.
    const digits = code <= 57 ? String(code - 48) : String(code - 55);
    for (const digit of digits) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder;
}

/**
 * The rules a typed IBAN breaks, after `normaliseIban`: none for a valid IBAN; `iban_format` for a value whose
 * normalised form is not an IBAN's shape; `iban_checksum` for check digits outside 02–98 or a failed mod-97 check.
 */
export function ibanProblems(value: string): BankDetailProblem[] {
  const iban = normaliseIban(value);
  if (!NORMALISED_IBAN_PATTERN.test(iban)) {
    return [
      {
        code: "iban_format",
        message:
          "Enter the IBAN as two letters, two check digits and 11 to 30 letters or digits (spaces are allowed).",
      },
    ];
  }
  const checkDigits = Number(iban.slice(2, 4));
  if (checkDigits < 2 || checkDigits > 98 || ibanRemainder(iban) !== 1) {
    return [{ code: "iban_checksum", message: "Check the IBAN; its check digits do not match." }];
  }
  return [];
}

/** True when `value` is a valid IBAN (its normalised form has the shape and passes the mod-97 check). */
export function isValidIban(value: string): boolean {
  return ibanProblems(value).length === 0;
}

/** The BIC as stored: upper case (the request validation has checked its 8 or 11 characters). */
export function normaliseBic(value: string): string {
  return value.toUpperCase();
}

/** The letters and digits of an account number, upper-cased: without its spaces and hyphens. */
function accountNumberCharacters(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** The rules an account number breaks: it must hold at least 4 letters or digits besides spaces and hyphens. */
export function accountNumberProblems(value: string): BankDetailProblem[] {
  if (accountNumberCharacters(value).length < 4) {
    return [
      {
        code: "account_number_format",
        message: "Enter the account number with at least 4 letters or digits.",
      },
    ];
  }
  return [];
}

/**
 * The last 4 letters or digits of an IBAN or account number, upper-cased (`PayoutAccount.last4`): spaces, hyphens
 * and any other character are left out first. Throws for a value with fewer than 4, which the problems above refuse.
 */
export function lastFour(value: string): string {
  const characters = accountNumberCharacters(value);
  if (characters.length < 4) {
    throw new RangeError("lastFour(): the value has fewer than 4 letters or digits");
  }
  return characters.slice(-4);
}
