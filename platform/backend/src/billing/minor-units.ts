// The money of Velexis's invoices to the OTAs (PBE-046; subscription-billing flow §D, invoice row, PADR-0002 item 8,
// conventions §1, scope PF-73 AC2). Stripe gives every amount as an integer in the minor unit of its currency (`4900`
// for 49.00 EUR, `5000` for 5000 JPY); Velexis converts it with the currency's exponent from `reference.currencies`
// (`minor_units`: 2 for EUR, 0 for JPY, 3 for KWD), never with Stripe's own list of zero-decimal currencies. Pure
// functions on decimal.js values and decimal strings, never JavaScript numbers for money:
//
//   fromMinorUnits(4900, 2)          → "49.00"     the amount, with exactly the currency's decimals
//   fromMinorUnits(5000, 0)          → "5000"
//   toStoredAmount("5000")           → "5000.00"   the `numeric(12,2)` columns of `invoices`
//   toCurrencyAmount("5000.00", 0)   → "5000"      what the API answers (`Money.amount`): the currency's decimals
//   toCurrencyAmount("49.00", 2)     → "49.00"
//
// The `invoices` columns hold two decimals. An amount that needs more (a three-decimal currency whose last digit is
// not 0, which Stripe does not charge) or more than ten integer digits does not fit: `toStoredAmount` throws
// MinorUnitsError and the invoice event fails for good, instead of a rounded amount being stored. Nothing here logs.
//
// The conversions themselves live in common/money.ts, shared with the settlement statements since FIX-W41-PLATFORM
// (lead decision (2i) of 2026-11-04); this module keeps billing's shape around them: decimal strings in and out, and
// MinorUnitsError with billing's messages.
import {
  checkCurrencyExponent,
  decimalOf,
  fitsStoredAmount as fitsStoredValue,
  fromMinorUnits as fromMinorUnitsValue,
  MAX_CURRENCY_EXPONENT,
  MAX_STORED_AMOUNT,
  MoneyError,
  PlatformMoney,
  STORED_DECIMALS,
  toStoredAmount as toStoredValue,
  type MoneyErrorReason,
  type MoneyValue,
} from "../common/money";

export { MAX_CURRENCY_EXPONENT, MAX_STORED_AMOUNT, STORED_DECIMALS };

/** decimal.js for billing amounts, independent of the global `Decimal` settings: common/money.ts's PlatformMoney. */
export const BillingMoney = PlatformMoney;

/** An amount that cannot be converted or stored exactly. The message names no amount. */
export class MinorUnitsError extends Error {
  override readonly name = "MinorUnitsError";
}

/** Billing's message of each reason of common/money.ts. */
const MINOR_UNITS_TEXT: Readonly<Record<MoneyErrorReason, string>> = Object.freeze({
  amount_not_integer: "a Stripe amount is not an integer",
  exponent_out_of_range: `a currency exponent is not an integer from 0 to ${MAX_CURRENCY_EXPONENT}`,
  not_decimal_string: "an amount is not a decimal string",
  does_not_fit: "an amount does not fit numeric(12,2) exactly",
});

/** Runs `compute`, turning common/money.ts's MoneyError into MinorUnitsError with billing's message. */
function billing<T>(compute: () => T): T {
  try {
    return compute();
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new MinorUnitsError(MINOR_UNITS_TEXT[error.reason]);
    }
    throw error;
  }
}

/**
 * A Stripe amount `minor` (a safe integer in the minor unit of its currency; negative for a credit) as a decimal string
 * with exactly `exponent` decimals: `fromMinorUnits(4900, 2)` is `"49.00"`, `fromMinorUnits(5000, 0)` is `"5000"`.
 * Throws MinorUnitsError for a `minor` that is not a safe integer or an exponent outside 0 to 4.
 */
export function fromMinorUnits(minor: number, exponent: number): string {
  return billing(() => fromMinorUnitsValue(minor, exponent).toFixed(exponent));
}

/** `amount` as a BillingMoney value; throws MinorUnitsError when it is not a decimal string. */
function moneyOf(amount: string): MoneyValue {
  return billing(() => decimalOf(amount));
}

/** True when `amount` fits a `numeric(12,2)` column exactly: at most 2 significant decimals and 10 integer digits. */
export function fitsStoredAmount(amount: string): boolean {
  return fitsStoredValue(moneyOf(amount));
}

/**
 * `amount` (a decimal string) as the text of a `numeric(12,2)` column, `"5000.00"`; trailing zeros beyond the second
 * decimal do not count (`"1.230"` is `"1.23"`). Throws MinorUnitsError when it does not fit exactly: it is never rounded.
 */
export function toStoredAmount(amount: string): string {
  const value = moneyOf(amount);
  return billing(() => toStoredValue(value));
}

/**
 * A stored amount (`"5000.00"`, as PostgreSQL prints `numeric(12,2)`) with the decimals of its currency, for the API's
 * `Money.amount`: `toCurrencyAmount("5000.00", 0)` is `"5000"`, `toCurrencyAmount("49.00", 2)` is `"49.00"`,
 * `toCurrencyAmount("1.23", 3)` is `"1.230"`. A stored amount with more significant decimals than the currency has
 * keeps them (money is never rounded on the way out). Throws MinorUnitsError for a value that is not a decimal string
 * or an exponent outside 0 to 4.
 */
export function toCurrencyAmount(stored: string, exponent: number): string {
  billing(() => checkCurrencyExponent(exponent));
  const value = moneyOf(stored);
  return value.toFixed(Math.max(exponent, value.decimalPlaces()));
}
