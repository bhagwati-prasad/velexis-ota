// The amount of a manual adjustment line (`SettlementAdjustmentAmount` of the platform document), checked the same way
// by the form in the browser (settlement-actions.tsx) and by the server action before it calls the API (actions.ts):
// a plain module, neither a client nor a server one, so both can import it.
//
// The API takes a signed decimal string, not zero, with at most ten digits before the point and two after it
// (`numeric(12,2)`), and since FIX-W37-PLATFORM (lead decision (2j) of 2026-10-31) no more decimals than the
// statement's currency has minor units (its exponent in `reference.currencies`: 2 for EUR, 0 for JPY, 3 for KWD;
// trailing zeros do not count, so `1500.00` JPY is 1500 yen); a finer amount answers `422 UNPROCESSABLE` with
// `details.reason = amount_precision`. The form refuses it at the field before anything is sent, and the API's answer
// lands at the same field.

/** The most decimals any adjustment has: the schema's two (`numeric(12,2)`), whatever the currency's exponent. */
export const ADJUSTMENT_MAX_DECIMALS = 2;

/**
 * The exponent of every currency of `reference.currencies` whose exponent is not 2, as
 * `tools/reference-data/data/currencies.csv` (the file `pnpm db:seed:reference` loads into `reference.currencies`)
 * holds it; every other code has 2. `settlements.test.tsx` fails when this copy and the file differ. A copy, not
 * `Intl`: the browser's and Node's CLDR data differ from the vendored file for a few currencies (COP, HUF, IDR, PKR,
 * RSD), and the API counts with the file.
 */
export const MINOR_UNITS_OTHER_THAN_TWO: Readonly<Record<string, number>> = Object.freeze({
  ADP: 0,
  AFN: 0,
  ALL: 0,
  BHD: 3,
  BIF: 0,
  BYR: 0,
  CLF: 4,
  CLP: 0,
  COP: 0,
  DJF: 0,
  ESP: 0,
  GNF: 0,
  HUF: 0,
  IDR: 0,
  IQD: 0,
  IRR: 0,
  ISK: 0,
  ITL: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KPW: 0,
  KRW: 0,
  KWD: 3,
  LAK: 0,
  LBP: 0,
  LUF: 0,
  LYD: 3,
  MGA: 0,
  MGF: 0,
  MMK: 0,
  MRO: 0,
  OMR: 3,
  PKR: 0,
  PYG: 0,
  RWF: 0,
  SLL: 0,
  SOS: 0,
  STD: 0,
  SYP: 0,
  TMM: 0,
  TND: 3,
  TRL: 0,
  UGX: 0,
  UYI: 0,
  UYW: 4,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  YER: 0,
  ZMK: 0,
  ZWD: 0,
});

/** The exponent of `currency` in `reference.currencies` (2 unless the copy above says otherwise). */
export function currencyExponent(currency: string): number {
  return Object.hasOwn(MINOR_UNITS_OTHER_THAN_TWO, currency)
    ? (MINOR_UNITS_OTHER_THAN_TWO[currency] ?? 2)
    : 2;
}

/**
 * The decimals an adjustment in `currency` may have: the currency's exponent, and never more than the schema's two
 * (so 0 for JPY, 2 for EUR and for KWD).
 */
export function adjustmentDecimals(currency: string): number {
  return Math.min(currencyExponent(currency), ADJUSTMENT_MAX_DECIMALS);
}

/** A signed decimal string with at most ten digits before the point and two after it, as the schema's pattern. */
const AMOUNT = /^-?([0-9]{1,10})(?:\.([0-9]{1,2}))?$/;

/** What is wrong with a typed amount, or `undefined` for one the API takes. */
export type AmountProblem =
  | { readonly kind: "required" }
  | { readonly kind: "format" }
  | { readonly kind: "zero" }
  | { readonly kind: "decimals"; readonly decimals: number };

/**
 * What is wrong with `typed` (white space at either end ignored) as the amount of an adjustment in `currency`, or
 * `undefined`: empty, not a decimal string the schema takes, zero, or more significant decimals than
 * `adjustmentDecimals(currency)` (trailing zeros do not count, as the API counts them).
 */
export function amountProblem(typed: string, currency: string): AmountProblem | undefined {
  const value = typed.trim();
  if (value === "") {
    return { kind: "required" };
  }
  const match = AMOUNT.exec(value);
  if (match === null) {
    return { kind: "format" };
  }
  const whole = match[1] ?? "";
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (/^0+$/.test(whole) && fraction === "") {
    return { kind: "zero" };
  }
  const decimals = adjustmentDecimals(currency);
  return fraction.length > decimals ? { kind: "decimals", decimals } : undefined;
}
