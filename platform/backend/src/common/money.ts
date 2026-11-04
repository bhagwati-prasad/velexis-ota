// The money helpers of the platform backend (FIX-W41-PLATFORM, lead decision (2i) of 2026-11-04; conventions §1): one
// module for what Velexis's invoices to the OTAs (billing/minor-units.ts, PBE-046) and the settlement statements
// (settlements/settlement-formula.ts, PBE-059) both need, which each had a copy of until then. Pure functions on
// decimal.js values of PlatformMoney, never JavaScript numbers for money:
//
//   fromMinorUnits(4900, 2)              → 49.00     a Stripe amount (an integer in its currency's minor unit) as a
//   fromMinorUnits(5000, 0)              → 5000      decimal value, with the currency's exponent from
//                                                    `reference.currencies` (2 for EUR, 0 for JPY, 3 for KWD), never
//                                                    Stripe's own list of zero-decimal currencies
//   fitsStoredAmount(value)                          whether a `numeric(12,2)` column holds it exactly
//   toStoredAmount(value)                → "49.00"   the text of a `numeric(12,2)` column; never rounded
//   decimalOf("49.00")                   → 49.00     a decimal string as PostgreSQL prints `numeric`, and nothing else
//
// A value that cannot be converted or stored exactly throws MoneyError with its `reason`. The callers keep their own
// error classes and messages (billing's MinorUnitsError, settlements' SettlementDataError) by translating the reason in
// a thin wrapper, so moving the helpers here changed no result and no error of theirs. Nothing here logs.
import { Decimal } from "decimal.js";

/**
 * decimal.js for platform money, independent of the global `Decimal` settings: 40 significant digits (a 12-digit
 * amount times a fee in basis points stays exact) and half-even rounding (PADR-0003 item 5). Billing's `BillingMoney`
 * and settlements' `SettlementMoney` are this class.
 */
export const PlatformMoney = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** A decimal.js value of PlatformMoney. */
export type MoneyValue = Decimal;

/** The highest exponent `reference.currencies.minor_units` allows (`CHECK (minor_units BETWEEN 0 AND 4)`). */
export const MAX_CURRENCY_EXPONENT = 4;

/** The decimals of the `numeric(12,2)` amount columns (`invoices`, `settlements`, `settlement_lines`). */
export const STORED_DECIMALS = 2;

/** The largest absolute amount a `numeric(12,2)` column holds. */
export const MAX_STORED_AMOUNT = "9999999999.99";

/** A decimal string such as `"49.00"`, `"5000"` or `"-12.5"`, as PostgreSQL prints `numeric`. No exponent. */
const DECIMAL_STRING = /^-?\d+(?:\.\d+)?$/;

/** Why a value could not be converted or stored exactly. */
export type MoneyErrorReason =
  /** A Stripe amount that is not a safe integer. */
  | "amount_not_integer"
  /** A currency exponent that is not an integer from 0 to MAX_CURRENCY_EXPONENT. */
  | "exponent_out_of_range"
  /** A value that is not a decimal string. */
  | "not_decimal_string"
  /** An amount a `numeric(12,2)` column cannot hold exactly. */
  | "does_not_fit";

/** The default message of each reason. It names no amount. */
export const MONEY_ERROR_TEXT: Readonly<Record<MoneyErrorReason, string>> = Object.freeze({
  amount_not_integer: "a Stripe amount is not an integer",
  exponent_out_of_range: `a currency exponent is not an integer from 0 to ${MAX_CURRENCY_EXPONENT}`,
  not_decimal_string: "an amount is not a decimal string",
  does_not_fit: "an amount does not fit numeric(12,2) exactly",
});

/** A value that cannot be converted or stored exactly. The message names no amount. */
export class MoneyError extends Error {
  override readonly name = "MoneyError";

  constructor(readonly reason: MoneyErrorReason) {
    super(MONEY_ERROR_TEXT[reason]);
  }
}

/** True when `value` is a decimal string as PostgreSQL prints `numeric` (`"-12.50"`, `"5000"`); no exponent. */
export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_STRING.test(value);
}

/** `value` as a PlatformMoney value; throws MoneyError `not_decimal_string` when it is not a decimal string. */
export function decimalOf(value: string): MoneyValue {
  if (!isDecimalString(value)) {
    throw new MoneyError("not_decimal_string");
  }
  return new PlatformMoney(value);
}

/** Throws MoneyError `exponent_out_of_range` unless `exponent` is an integer from 0 to MAX_CURRENCY_EXPONENT. */
export function checkCurrencyExponent(exponent: number): void {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_CURRENCY_EXPONENT) {
    throw new MoneyError("exponent_out_of_range");
  }
}

/**
 * A Stripe amount `minor` (a safe integer in the minor unit of its currency; negative for a refund or a credit) as a
 * decimal value, with `exponent`, the currency's in `reference.currencies`: `fromMinorUnits(4900, 2)` is 49 (print it
 * with `toFixed(2)`), `fromMinorUnits(5000, 0)` is 5000. Throws MoneyError `amount_not_integer` for a `minor` that is
 * not a safe integer (checked first), then `exponent_out_of_range`.
 */
export function fromMinorUnits(minor: number, exponent: number): MoneyValue {
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError("amount_not_integer");
  }
  checkCurrencyExponent(exponent);
  return new PlatformMoney(minor).dividedBy(new PlatformMoney(10).pow(exponent));
}

/** True when `value` fits a `numeric(12,2)` column exactly: at most 2 significant decimals and 10 integer digits. */
export function fitsStoredAmount(value: MoneyValue): boolean {
  return value.decimalPlaces() <= STORED_DECIMALS && value.abs().lte(MAX_STORED_AMOUNT);
}

/**
 * `value` as the text of a `numeric(12,2)` column (`"-12.50"`, `"5000.00"`); trailing zeros beyond the second decimal
 * do not count. Throws MoneyError `does_not_fit` when it does not fit exactly: it is never rounded.
 */
export function toStoredAmount(value: MoneyValue): string {
  if (!fitsStoredAmount(value)) {
    throw new MoneyError("does_not_fit");
  }
  return value.toFixed(STORED_DECIMALS);
}
