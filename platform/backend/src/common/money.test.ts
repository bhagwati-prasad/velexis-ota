// The shared money helpers (common/money.ts; FIX-W41-PLATFORM, lead decision (2i) of 2026-11-04): every case of the
// helpers that billing/minor-units.ts (PBE-046) and settlements/settlement-formula.ts (PBE-059) each had, here on the
// one module, with its reasons. billing/minor-units.test.ts and settlements/settlement-formula.test.ts keep every case
// of their own on the thin wrappers, so both callers' results and errors are proven unchanged.
import { describe, expect, it } from "vitest";
import {
  checkCurrencyExponent,
  decimalOf,
  fitsStoredAmount,
  fromMinorUnits,
  isDecimalString,
  MAX_CURRENCY_EXPONENT,
  MAX_STORED_AMOUNT,
  MONEY_ERROR_TEXT,
  MoneyError,
  PlatformMoney,
  STORED_DECIMALS,
  toStoredAmount,
  type MoneyErrorReason,
} from "./money";

const money = (value: string) => new PlatformMoney(value);

/** The reason of the MoneyError `compute` throws; fails the test when it throws something else or nothing. */
function reasonOf(compute: () => unknown): MoneyErrorReason {
  try {
    compute();
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyError);
    return (error as MoneyError).reason;
  }
  throw new Error("expected a MoneyError");
}

describe("the columns and exponents", () => {
  it("[FIX-W41-PLATFORM AC5] keeps the bounds both callers had", () => {
    expect(STORED_DECIMALS).toBe(2);
    expect(MAX_STORED_AMOUNT).toBe("9999999999.99");
    expect(MAX_CURRENCY_EXPONENT).toBe(4);
    // 40 significant digits and half-even rounding (PADR-0003 item 5).
    expect(PlatformMoney.precision).toBe(40);
    expect(PlatformMoney.rounding).toBe(PlatformMoney.ROUND_HALF_EVEN);
  });
});

describe("fromMinorUnits", () => {
  it("[FIX-W41-PLATFORM AC5] converts 5000 minor units of JPY (exponent 0) to 5000 and 4900 of EUR (exponent 2) to 49.00", () => {
    expect(fromMinorUnits(5000, 0).toFixed(0)).toBe("5000");
    expect(fromMinorUnits(4900, 2).toFixed(2)).toBe("49.00");
  });

  it.each([
    [0, 2, "0.00"],
    [1, 2, "0.01"],
    [-4900, 2, "-49.00"],
    [1230, 3, "1.230"],
    [12_345, 4, "1.2345"],
    [7, 0, "7"],
    [Number.MAX_SAFE_INTEGER, 2, "90071992547409.91"],
    // The settlements' cases: a charge, a refund, nothing, JPY and KWD.
    [1050, 2, "10.50"],
    [-1050, 2, "-10.50"],
    [1500, 0, "1500"],
    [12_345, 3, "12.345"],
  ])("gives %s minor units with exponent %s as %s", (minor, exponent, expected) => {
    expect(fromMinorUnits(minor, exponent).toFixed(exponent)).toBe(expected);
  });

  it.each([
    [1.5],
    [10.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.MAX_SAFE_INTEGER + 1],
    [Number.MAX_SAFE_INTEGER + 2],
  ])("refuses %s minor units: Stripe's amounts are safe integers", (minor) => {
    expect(reasonOf(() => fromMinorUnits(minor, 2))).toBe("amount_not_integer");
  });

  it.each([[-1], [5], [1.5], [Number.NaN]])(
    "refuses the exponent %s, which reference.currencies cannot hold",
    (exponent) => {
      expect(reasonOf(() => fromMinorUnits(100, exponent))).toBe("exponent_out_of_range");
      expect(reasonOf(() => checkCurrencyExponent(exponent))).toBe("exponent_out_of_range");
    },
  );

  it("checks the amount before the exponent", () => {
    expect(reasonOf(() => fromMinorUnits(1.5, 7))).toBe("amount_not_integer");
  });
});

describe("fitsStoredAmount and toStoredAmount", () => {
  it("[FIX-W41-PLATFORM AC5] stores 5000 JPY as 5000.00 and 49.00 EUR as 49.00 in the numeric(12,2) columns", () => {
    expect(toStoredAmount(fromMinorUnits(5000, 0))).toBe("5000.00");
    expect(toStoredAmount(fromMinorUnits(4900, 2))).toBe("49.00");
  });

  it.each([
    ["12.5", "12.50"],
    ["-12.5", "-12.50"],
    ["-0", "0.00"],
    ["1.230", "1.23"],
    [MAX_STORED_AMOUNT, MAX_STORED_AMOUNT],
  ])("writes %s as %s", (value, expected) => {
    expect(fitsStoredAmount(money(value))).toBe(true);
    expect(toStoredAmount(money(value))).toBe(expected);
  });

  it.each([["1.235"], ["0.001"], ["12.345"], ["10000000000.00"], ["-10000000000"]])(
    "refuses %s rather than rounding it: it does not fit numeric(12,2) exactly",
    (value) => {
      expect(fitsStoredAmount(money(value))).toBe(false);
      expect(reasonOf(() => toStoredAmount(money(value)))).toBe("does_not_fit");
    },
  );
});

describe("decimal strings", () => {
  it("reads decimal strings as PostgreSQL prints numeric, and nothing else", () => {
    expect(decimalOf("-12.50").toFixed(2)).toBe("-12.50");
    expect(isDecimalString("5000")).toBe(true);
    for (const value of [
      "",
      "1e3",
      "12,50",
      "49,00",
      " 1",
      " 49.00",
      "49.",
      "+49",
      "NaN",
      "Infinity",
      "abc",
    ]) {
      expect(isDecimalString(value), value).toBe(false);
      expect(reasonOf(() => decimalOf(value))).toBe("not_decimal_string");
    }
    expect(isDecimalString(49)).toBe(false);
  });

  it("gives every reason its message, and the error its reason", () => {
    for (const [reason, text] of Object.entries(MONEY_ERROR_TEXT)) {
      const error = new MoneyError(reason as MoneyErrorReason);
      expect([error.name, error.reason, error.message]).toEqual(["MoneyError", reason, text]);
    }
  });
});
