// The money of a settlement statement (PBE-059; PADR-0003 item 5): Stripe's minor units as decimals, the
// `numeric(12,2)` columns, the Velexis fee rounded half-even and never negative, and the totals of a statement from its
// lines, which always satisfy `settlements_net_ck`.
import { describe, expect, it } from "vitest";
import {
  fitsStoredAmount,
  fromMinorUnits,
  SettlementDataError,
  SettlementMoney,
  settlementTotals,
  toMoney,
  toStoredAmount,
  velexisFee,
  type SettlementLineAmounts,
  type SettlementTotals,
} from "./settlement-formula";

const money = (value: string) => new SettlementMoney(value);

/** A line as the repository reads it back. */
function line(lineType: string, amount: string, stripeFee = "0.00"): SettlementLineAmounts {
  return { line_type: lineType, amount, stripe_fee: stripeFee };
}

/** `settlements_net_ck`: net = gross − refunds − disputes − stripe fees − Velexis fees + adjustments. */
function satisfiesNetCheck(totals: SettlementTotals): boolean {
  return money(totals.gross_amount)
    .minus(totals.refunds_amount)
    .minus(totals.disputes_amount)
    .minus(totals.stripe_fees_amount)
    .minus(totals.velexis_fees_amount)
    .plus(totals.adjustments_amount)
    .eq(totals.net_amount);
}

describe("Stripe amounts and the numeric(12,2) columns", () => {
  it("[PBE-059] turns Stripe's minor units into decimals with the currency's exponent", () => {
    expect(fromMinorUnits(1050, 2).toFixed(2)).toBe("10.50");
    expect(fromMinorUnits(-1050, 2).toFixed(2)).toBe("-10.50");
    expect(fromMinorUnits(0, 2).toFixed(2)).toBe("0.00");
    // A zero-decimal currency (JPY): the minor unit is the unit.
    expect(fromMinorUnits(1500, 0).toFixed(2)).toBe("1500.00");
    // A three-decimal currency (KWD).
    expect(fromMinorUnits(12_345, 3).toString()).toBe("12.345");
  });

  it("refuses an amount that is not an integer and an exponent outside 0–4", () => {
    expect(() => fromMinorUnits(10.5, 2)).toThrow(SettlementDataError);
    expect(() => fromMinorUnits(Number.MAX_SAFE_INTEGER + 2, 2)).toThrow(SettlementDataError);
    expect(() => fromMinorUnits(100, 5)).toThrow(SettlementDataError);
    expect(() => fromMinorUnits(100, -1)).toThrow(SettlementDataError);
  });

  it("writes an amount as numeric(12,2) only when it fits exactly", () => {
    expect(toStoredAmount(money("12.5"))).toBe("12.50");
    expect(toStoredAmount(money("-0"))).toBe("0.00");
    expect(toStoredAmount(money("9999999999.99"))).toBe("9999999999.99");
    expect(fitsStoredAmount(money("12.345"))).toBe(false);
    expect(() => toStoredAmount(money("12.345"))).toThrow(SettlementDataError);
    expect(() => toStoredAmount(money("10000000000.00"))).toThrow(SettlementDataError);
  });

  it("reads decimal strings as PostgreSQL prints numeric, and nothing else", () => {
    expect(toMoney("-12.50", "amount").toFixed(2)).toBe("-12.50");
    for (const value of ["", "1e3", "12,50", " 1", "NaN", "Infinity"]) {
      expect(() => toMoney(value, "amount"), value).toThrow(SettlementDataError);
    }
  });
});

describe("velexisFee (PADR-0003 item 5)", () => {
  it("[PBE-059 AC1] is fee_bps of gross − refunds, rounded half-even to the currency's decimals", () => {
    // 1.5 % of 1 300.00 = 19.50.
    expect(velexisFee(150, money("1500.00"), money("200.00"), 2).toFixed(2)).toBe("19.50");
    // Ties go to the even cent: 1 % of 150.50 = 1.505 → 1.50, of 151.50 = 1.515 → 1.52.
    expect(velexisFee(100, money("150.50"), money("0"), 2).toFixed(2)).toBe("1.50");
    expect(velexisFee(100, money("151.50"), money("0"), 2).toFixed(2)).toBe("1.52");
    // Not a tie: 1.5 % of 376.40 = 5.646 → 5.65.
    expect(velexisFee(150, money("376.40"), money("0"), 2).toFixed(2)).toBe("5.65");
    // A zero-decimal currency rounds to whole units: 1 % of 1 550 = 15.5 → 16, of 1 450 = 14.5 → 14.
    expect(velexisFee(100, money("1550"), money("0"), 0).toFixed(2)).toBe("16.00");
    expect(velexisFee(100, money("1450"), money("0"), 0).toFixed(2)).toBe("14.00");
    // A three-decimal currency still rounds to the columns' 2 decimals.
    expect(velexisFee(100, money("150.500"), money("0"), 3).toFixed(2)).toBe("1.50");
  });

  it("[PBE-059 AC1] is never negative, and 0 with fee_bps 0", () => {
    expect(velexisFee(150, money("100.00"), money("250.00"), 2).toFixed(2)).toBe("0.00");
    expect(velexisFee(0, money("1500.00"), money("0"), 2).toFixed(2)).toBe("0.00");
    expect(velexisFee(10_000, money("80.00"), money("30.00"), 2).toFixed(2)).toBe("50.00");
  });

  it("refuses a fee outside plans.settlement_fee_bps's range", () => {
    for (const feeBps of [-1, 10_001, 1.5, Number.NaN]) {
      expect(() => velexisFee(feeBps, money("1"), money("0"), 2), String(feeBps)).toThrow(
        SettlementDataError,
      );
    }
  });
});

describe("settlementTotals", () => {
  it("[PBE-059 AC1] adds charges, refunds, a lost and a won dispute and a carried-forward negative balance", () => {
    const totals = settlementTotals(
      [
        line("charge", "1000.00", "14.75"),
        line("charge", "500.00", "7.75"),
        line("refund", "-200.00"),
        // Lost: the amount and the 15.00 dispute fee are withdrawn.
        line("dispute", "-500.00", "15.00"),
        // Won: withdrawn with its fee, then the amount reinstated (the fee stays with Stripe).
        line("dispute", "-300.00", "15.00"),
        line("dispute_reversal", "300.00"),
        line("carry_forward", "-45.50"),
      ],
      { feeBps: 150, decimals: 2 },
    );

    expect(totals).toEqual({
      gross_amount: "1500.00",
      refunds_amount: "200.00",
      // 500 + 15 + 300 + 15 − 300: the disputed amounts and dispute fees minus the reinstated amount.
      disputes_amount: "530.00",
      // The processing fees only: the dispute fees are in disputes, never counted twice.
      stripe_fees_amount: "22.50",
      velexis_fees_amount: "19.50",
      adjustments_amount: "-45.50",
      net_amount: "682.50",
      line_count: 7,
    });
    expect(satisfiesNetCheck(totals)).toBe(true);
  });

  it("[PBE-059 AC1] makes net the sum of the lines less their Stripe fees and the Velexis fee", () => {
    const lines = [
      line("charge", "250.00", "7.55"),
      line("charge", "126.40", "4.10"),
      line("refund", "-26.40", "-0.30"),
      line("refund", "6.40"),
      line("dispute", "-100.00", "15.00"),
      line("dispute_reversal", "100.00", "-15.00"),
      line("adjustment", "12.34"),
    ];
    const totals = settlementTotals(lines, { feeBps: 250, decimals: 2 });
    const amounts = lines.reduce((sum, each) => sum.plus(each.amount), money("0"));
    const fees = lines.reduce((sum, each) => sum.plus(each.stripe_fee), money("0"));

    // A refund that failed comes back as a positive refund line and lowers the refunds; a dispute fee Stripe gives
    // back with a won dispute lowers the disputes.
    expect(totals.refunds_amount).toBe("20.00");
    expect(totals.disputes_amount).toBe("0.00");
    expect(totals.stripe_fees_amount).toBe("11.35");
    expect(totals.velexis_fees_amount).toBe("8.91");
    expect(money(totals.net_amount).eq(amounts.minus(fees).minus(totals.velexis_fees_amount))).toBe(true);
    expect(satisfiesNetCheck(totals)).toBe(true);
  });

  it("[PBE-059 AC1] lets a month of refunds and disputes end negative, with no Velexis fee", () => {
    const totals = settlementTotals(
      [line("charge", "100.00", "1.65"), line("refund", "-150.00"), line("carry_forward", "-20.00")],
      { feeBps: 150, decimals: 2 },
    );

    expect(totals.velexis_fees_amount).toBe("0.00");
    expect(totals.net_amount).toBe("-71.65");
    expect(satisfiesNetCheck(totals)).toBe(true);
  });

  it("is all zeros for a statement without lines", () => {
    expect(settlementTotals([], { feeBps: 150, decimals: 2 })).toEqual({
      gross_amount: "0.00",
      refunds_amount: "0.00",
      disputes_amount: "0.00",
      stripe_fees_amount: "0.00",
      velexis_fees_amount: "0.00",
      adjustments_amount: "0.00",
      net_amount: "0.00",
      line_count: 0,
    });
  });

  it("refuses a line of another type or with an amount that is not a decimal string", () => {
    expect(() => settlementTotals([line("payout", "10.00")], { feeBps: 0, decimals: 2 })).toThrow(
      SettlementDataError,
    );
    expect(() => settlementTotals([line("charge", "ten")], { feeBps: 0, decimals: 2 })).toThrow(
      SettlementDataError,
    );
  });
});
