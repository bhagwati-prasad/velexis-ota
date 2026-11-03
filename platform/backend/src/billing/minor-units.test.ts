// The money of Velexis's invoices (PBE-046; minor-units.ts): Stripe's minor units with the currency's exponent of
// `reference.currencies`, the `numeric(12,2)` columns and the API's amounts, as decimal strings only.
import { describe, expect, it } from "vitest";
import {
  fitsStoredAmount,
  fromMinorUnits,
  MAX_STORED_AMOUNT,
  MinorUnitsError,
  toCurrencyAmount,
  toStoredAmount,
} from "./minor-units";

describe("fromMinorUnits", () => {
  it("[PBE-046 AC1] converts 5000 minor units of JPY (exponent 0) to 5000 and 4900 of EUR (exponent 2) to 49.00", () => {
    expect(fromMinorUnits(5000, 0)).toBe("5000");
    expect(fromMinorUnits(4900, 2)).toBe("49.00");
  });

  it.each([
    [0, 2, "0.00"],
    [1, 2, "0.01"],
    [-4900, 2, "-49.00"],
    [1230, 3, "1.230"],
    [12_345, 4, "1.2345"],
    [7, 0, "7"],
    [Number.MAX_SAFE_INTEGER, 2, "90071992547409.91"],
  ])("gives %s minor units with exponent %s as %s", (minor, exponent, expected) => {
    expect(fromMinorUnits(minor, exponent)).toBe(expected);
  });

  it.each([[1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.MAX_SAFE_INTEGER + 1]])(
    "refuses %s minor units: Stripe's amounts are safe integers",
    (minor) => {
      expect(() => fromMinorUnits(minor, 2)).toThrow(MinorUnitsError);
    },
  );

  it.each([[-1], [5], [1.5], [Number.NaN]])(
    "refuses the exponent %s, which reference.currencies cannot hold",
    (exponent) => {
      expect(() => fromMinorUnits(100, exponent)).toThrow(MinorUnitsError);
    },
  );
});

describe("toStoredAmount", () => {
  it("[PBE-046 AC1] stores 5000 JPY as 5000.00 and 49.00 EUR as 49.00 in the numeric(12,2) columns", () => {
    expect(toStoredAmount(fromMinorUnits(5000, 0))).toBe("5000.00");
    expect(toStoredAmount(fromMinorUnits(4900, 2))).toBe("49.00");
  });

  it("keeps a three-decimal amount whose last digit is 0, and the sign of a credit", () => {
    expect(toStoredAmount(fromMinorUnits(1230, 3))).toBe("1.23");
    expect(toStoredAmount("-12.5")).toBe("-12.50");
    expect(toStoredAmount(MAX_STORED_AMOUNT)).toBe(MAX_STORED_AMOUNT);
  });

  it.each([["1.235"], ["0.001"], ["10000000000.00"], ["-10000000000"]])(
    "refuses %s rather than rounding it: it does not fit numeric(12,2) exactly",
    (amount) => {
      expect(fitsStoredAmount(amount)).toBe(false);
      expect(() => toStoredAmount(amount)).toThrow(MinorUnitsError);
    },
  );

  it.each([["49,00"], ["1e3"], [""], [" 49.00"], ["49."], ["+49"]])(
    "refuses %j, which is not a decimal string",
    (amount) => {
      expect(() => toStoredAmount(amount)).toThrow(MinorUnitsError);
    },
  );
});

describe("toCurrencyAmount", () => {
  it("[PBE-046 AC1] answers a stored 5000.00 JPY as 5000 and 49.00 EUR as 49.00", () => {
    expect(toCurrencyAmount("5000.00", 0)).toBe("5000");
    expect(toCurrencyAmount("49.00", 2)).toBe("49.00");
  });

  it.each([
    ["0.00", 2, "0.00"],
    ["-12.50", 2, "-12.50"],
    ["1.23", 3, "1.230"],
    ["1.20", 4, "1.2000"],
    // Never rounded on the way out: a stored amount keeps its significant decimals.
    ["12.50", 0, "12.5"],
  ])("answers the stored %s with exponent %s as %s", (stored, exponent, expected) => {
    expect(toCurrencyAmount(stored, exponent)).toBe(expected);
  });

  it("refuses a value that is not a decimal string, and an exponent outside 0 to 4", () => {
    expect(() => toCurrencyAmount("abc", 2)).toThrow(MinorUnitsError);
    expect(() => toCurrencyAmount("1.00", 7)).toThrow(MinorUnitsError);
  });
});
