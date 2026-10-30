// The money of a settlement statement (PBE-059; PADR-0003 item 5, platform/docs/flows/stripe-payments-account.md §F
// item 3, platform/docs/data-model-migration-0002-part2.md `settlements` and `settlement_lines`). Pure functions on
// decimal.js values, never JavaScript numbers (conventions §1); the generator (settlement-generator.ts) and the review
// workflow (PBE-060) compute every stored total here, so `settlements_net_ck` always holds.
//
// Stripe gives amounts as integers in the minor unit of their currency (`fromMinorUnits`, with the currency's
// exponent from `reference.currencies`, architecture §2.1); the columns are `numeric(12,2)` (`toStoredAmount`). The
// totals of one statement, from its lines (`settlementTotals`):
//
//   gross        Σ amount of the `charge` lines (captured charges)
//   refunds      −Σ amount of the `refund` lines (a positive number; a failed refund's line is positive and lowers it)
//   disputes     −Σ (amount − Stripe fee) of the `dispute` and `dispute_reversal` lines: the disputed amounts and the
//                dispute fees, minus the reinstated amounts (and any dispute fee Stripe gives back)
//   stripe_fees  Σ Stripe fee of every other line: the processing fees Velexis passes through
//   velexis_fees round_half_even(fee_bps × max(gross − refunds, 0) / 10 000), to the currency's decimals (`velexisFee`)
//   adjustments  Σ amount of the `adjustment` and `carry_forward` lines (signed)
//   net          gross − refunds − disputes − stripe_fees − velexis_fees + adjustments
//
// Every Stripe fee of a line is counted once: in `disputes` for the dispute lines (PADR-0003 item 5 and the column's
// comment count the dispute fee there), in `stripe_fees` for the others, so `net` is the sum of the lines' amounts less
// their Stripe fees and the Velexis fee, and the CSV of the lines reconciles with the statement.
import { Decimal } from "decimal.js";

/**
 * decimal.js for settlements, independent of the global `Decimal` settings: 40 significant digits (a 12-digit amount
 * times a fee in basis points stays exact) and half-even rounding, the rounding of PADR-0003 item 5.
 */
export const SettlementMoney = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** A decimal.js value of SettlementMoney. */
export type MoneyValue = Decimal;

/** The line types of `settlement_lines.line_type`. */
export const SETTLEMENT_LINE_TYPES = Object.freeze([
  "charge",
  "refund",
  "dispute",
  "dispute_reversal",
  "adjustment",
  "carry_forward",
] as const);

/** One line type. */
export type SettlementLineType = (typeof SETTLEMENT_LINE_TYPES)[number];

/** The decimals of the `numeric(12,2)` amount columns. */
export const STORED_DECIMALS = 2;

/** The largest absolute amount a `numeric(12,2)` column holds. */
export const MAX_STORED_AMOUNT = "9999999999.99";

/** The highest fee in basis points (`plans.settlement_fee_bps BETWEEN 0 AND 10000`). */
export const MAX_FEE_BPS = 10_000;

/** A decimal string such as `"512.40"` or `"-5"`, as PostgreSQL prints `numeric`. No exponent. */
const DECIMAL_STRING = /^-?\d+(?:\.\d+)?$/;

/** Data that cannot become a statement: an amount the columns cannot hold, an unknown currency, a bad fee. */
export class SettlementDataError extends Error {
  override readonly name = "SettlementDataError";
}

/** `value` as a SettlementMoney value; throws SettlementDataError naming `field` when it is not a decimal string. */
export function toMoney(value: string, field: string): MoneyValue {
  if (typeof value !== "string" || !DECIMAL_STRING.test(value)) {
    throw new SettlementDataError(`${field} is not a decimal string`);
  }
  return new SettlementMoney(value);
}

/**
 * A Stripe amount (an integer in the minor unit, `1050` for 10.50 EUR, `-1050` for a refund) as a decimal value, with
 * `decimals`, the exponent of its currency (2 for EUR, 0 for JPY).
 */
export function fromMinorUnits(minor: number, decimals: number): MoneyValue {
  if (!Number.isSafeInteger(minor)) {
    throw new SettlementDataError("a Stripe amount is not an integer");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) {
    throw new SettlementDataError("a currency exponent is not between 0 and 4");
  }
  return new SettlementMoney(minor).dividedBy(new SettlementMoney(10).pow(decimals));
}

/** True when `value` fits a `numeric(12,2)` column exactly: at most 2 decimals and 10 integer digits. */
export function fitsStoredAmount(value: MoneyValue): boolean {
  return value.decimalPlaces() <= STORED_DECIMALS && value.abs().lte(MAX_STORED_AMOUNT);
}

/** `value` as the decimal string of a `numeric(12,2)` column (`"-12.50"`); throws when it does not fit exactly. */
export function toStoredAmount(value: MoneyValue): string {
  if (!fitsStoredAmount(value)) {
    throw new SettlementDataError("an amount does not fit numeric(12,2)");
  }
  return value.toFixed(STORED_DECIMALS);
}

/**
 * Velexis's fee of a statement (PADR-0003 item 5): `fee_bps × max(gross − refunds, 0) / 10 000`, rounded half-even to
 * `decimals` (the statement currency's, at most the columns' 2), never negative.
 */
export function velexisFee(
  feeBps: number,
  gross: MoneyValue,
  refunds: MoneyValue,
  decimals: number,
): MoneyValue {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new SettlementDataError("fee_bps is not an integer between 0 and 10000");
  }
  const base = SettlementMoney.max(gross.minus(refunds), 0);
  return base
    .times(feeBps)
    .dividedBy(MAX_FEE_BPS)
    .toDecimalPlaces(Math.min(decimals, STORED_DECIMALS), Decimal.ROUND_HALF_EVEN);
}

/** What the totals read of a line: its type, signed amount and Stripe fee, as stored. */
export interface SettlementLineAmounts {
  readonly line_type: string;
  readonly amount: string;
  readonly stripe_fee: string;
}

/** The stored totals of a statement, as `numeric(12,2)` decimal strings, and its line count. */
export interface SettlementTotals {
  readonly gross_amount: string;
  readonly refunds_amount: string;
  readonly disputes_amount: string;
  readonly stripe_fees_amount: string;
  readonly velexis_fees_amount: string;
  readonly adjustments_amount: string;
  readonly net_amount: string;
  readonly line_count: number;
}

/** What the totals need besides the lines. */
export interface SettlementTotalsOptions {
  /** `plans.settlement_fee_bps` copied to the statement. */
  readonly feeBps: number;
  /** The exponent of the statement currency (the Velexis fee is rounded to it, at most 2). */
  readonly decimals: number;
}

function isLineType(value: string): value is SettlementLineType {
  return (SETTLEMENT_LINE_TYPES as readonly string[]).includes(value);
}

/** The totals of a statement whose lines are `lines` (file header). Throws for an unknown line type. */
export function settlementTotals(
  lines: readonly SettlementLineAmounts[],
  options: SettlementTotalsOptions,
): SettlementTotals {
  let gross = new SettlementMoney(0);
  let refunds = new SettlementMoney(0);
  let disputes = new SettlementMoney(0);
  let stripeFees = new SettlementMoney(0);
  let adjustments = new SettlementMoney(0);
  for (const line of lines) {
    if (!isLineType(line.line_type)) {
      throw new SettlementDataError(`unknown line type ${JSON.stringify(line.line_type)}`);
    }
    const amount = toMoney(line.amount, "amount");
    const fee = toMoney(line.stripe_fee, "stripe_fee");
    switch (line.line_type) {
      case "charge":
        gross = gross.plus(amount);
        stripeFees = stripeFees.plus(fee);
        break;
      case "refund":
        refunds = refunds.minus(amount);
        stripeFees = stripeFees.plus(fee);
        break;
      case "dispute":
      case "dispute_reversal":
        disputes = disputes.minus(amount.minus(fee));
        break;
      case "adjustment":
      case "carry_forward":
        adjustments = adjustments.plus(amount);
        stripeFees = stripeFees.plus(fee);
        break;
    }
  }
  const velexis = velexisFee(options.feeBps, gross, refunds, options.decimals);
  const net = gross.minus(refunds).minus(disputes).minus(stripeFees).minus(velexis).plus(adjustments);
  return {
    gross_amount: toStoredAmount(gross),
    refunds_amount: toStoredAmount(refunds),
    disputes_amount: toStoredAmount(disputes),
    stripe_fees_amount: toStoredAmount(stripeFees),
    velexis_fees_amount: toStoredAmount(velexis),
    adjustments_amount: toStoredAmount(adjustments),
    net_amount: toStoredAmount(net),
    line_count: lines.length,
  };
}
