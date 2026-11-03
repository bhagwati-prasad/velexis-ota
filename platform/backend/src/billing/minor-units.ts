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
import { Decimal } from "decimal.js";

/** decimal.js for billing amounts, independent of the global `Decimal` settings: exact for every stored amount. */
export const BillingMoney = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** The highest exponent `reference.currencies.minor_units` allows (`CHECK (minor_units BETWEEN 0 AND 4)`). */
export const MAX_CURRENCY_EXPONENT = 4;

/** The decimals of the `numeric(12,2)` amount columns of `invoices`. */
export const STORED_DECIMALS = 2;

/** The largest absolute amount a `numeric(12,2)` column holds. */
export const MAX_STORED_AMOUNT = "9999999999.99";

/** A decimal string such as `"49.00"`, `"5000"` or `"-12.5"`, as PostgreSQL prints `numeric`. No exponent. */
const DECIMAL_STRING = /^-?\d+(?:\.\d+)?$/;

/** An amount that cannot be converted or stored exactly. The message names no amount. */
export class MinorUnitsError extends Error {
  override readonly name = "MinorUnitsError";
}

/** Throws MinorUnitsError unless `exponent` is an exponent of `reference.currencies` (an integer from 0 to 4). */
function checkExponent(exponent: number): void {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_CURRENCY_EXPONENT) {
    throw new MinorUnitsError(`a currency exponent is not an integer from 0 to ${MAX_CURRENCY_EXPONENT}`);
  }
}

/**
 * A Stripe amount `minor` (a safe integer in the minor unit of its currency; negative for a credit) as a decimal string
 * with exactly `exponent` decimals: `fromMinorUnits(4900, 2)` is `"49.00"`, `fromMinorUnits(5000, 0)` is `"5000"`.
 * Throws MinorUnitsError for a `minor` that is not a safe integer or an exponent outside 0 to 4.
 */
export function fromMinorUnits(minor: number, exponent: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new MinorUnitsError("a Stripe amount is not an integer");
  }
  checkExponent(exponent);
  return new BillingMoney(minor).dividedBy(new BillingMoney(10).pow(exponent)).toFixed(exponent);
}

/** `amount` as a BillingMoney value; throws MinorUnitsError when it is not a decimal string. */
function moneyOf(amount: string): Decimal {
  if (typeof amount !== "string" || !DECIMAL_STRING.test(amount)) {
    throw new MinorUnitsError("an amount is not a decimal string");
  }
  return new BillingMoney(amount);
}

/** True when `amount` fits a `numeric(12,2)` column exactly: at most 2 significant decimals and 10 integer digits. */
export function fitsStoredAmount(amount: string): boolean {
  const value = moneyOf(amount);
  return value.decimalPlaces() <= STORED_DECIMALS && value.abs().lte(MAX_STORED_AMOUNT);
}

/**
 * `amount` (a decimal string) as the text of a `numeric(12,2)` column, `"5000.00"`; trailing zeros beyond the second
 * decimal do not count (`"1.230"` is `"1.23"`). Throws MinorUnitsError when it does not fit exactly: it is never rounded.
 */
export function toStoredAmount(amount: string): string {
  if (!fitsStoredAmount(amount)) {
    throw new MinorUnitsError("an amount does not fit numeric(12,2) exactly");
  }
  return moneyOf(amount).toFixed(STORED_DECIMALS);
}

/**
 * A stored amount (`"5000.00"`, as PostgreSQL prints `numeric(12,2)`) with the decimals of its currency, for the API's
 * `Money.amount`: `toCurrencyAmount("5000.00", 0)` is `"5000"`, `toCurrencyAmount("49.00", 2)` is `"49.00"`,
 * `toCurrencyAmount("1.23", 3)` is `"1.230"`. A stored amount with more significant decimals than the currency has
 * keeps them (money is never rounded on the way out). Throws MinorUnitsError for a value that is not a decimal string
 * or an exponent outside 0 to 4.
 */
export function toCurrencyAmount(stored: string, exponent: number): string {
  checkExponent(exponent);
  const value = moneyOf(stored);
  return value.toFixed(Math.max(exponent, value.decimalPlaces()));
}
