// The pricing mode of a checkout (OBE-050; ota/docs/data-model.md §3.2, OADR-0004 point 4, OADR-0005 point 9): the
// selling price of the markup and fee engine for Stripe methods, the airline's price for the airline card, with the
// engine bypassed (no OTA markup, no OTA fee, the Amadeus card fee alone). Pure functions, decimal strings only.
import { describe, expect, it } from "vitest";
import {
  baseAmountsFor,
  baseTotalOf,
  cardFeeFor,
  checkoutTotalOf,
  isPricingMode,
  PRICING_MODES,
  pricingModeOf,
} from "./pricing-mode";

/** A priced offer of 400.00 EUR at Amadeus sold at 431.50 (markup and the OTA's booking fee). */
const PRICED = { sellingTotal: "431.50", netTotal: "400.00" } as const;
/** Two extras: a bag (35.00 at Amadeus, sold 38.00) and a seat (12.30, sold 14.30). */
const SELECTIONS = [
  { priceAmount: "38.00", netAmount: "35.00" },
  { priceAmount: "14.30", netAmount: "12.30" },
] as const;
/** A card-fee quote: the Amadeus fee 1.20 plus the OTA's 0.50 surcharge. */
const QUOTE = { amadeusFee: "1.20", total: "1.70" } as const;

describe("the pricing mode of a payment method", () => {
  it("is net for the airline card and markup_rules for every other method [OBE-050 AC1]", () => {
    expect(PRICING_MODES).toEqual(["markup_rules", "net"]);
    expect(pricingModeOf("airline_card")).toBe("net");
    for (const method of ["card", "apple_pay", "google_pay", "paypal"]) {
      expect([method, pricingModeOf(method)]).toEqual([method, "markup_rules"]);
    }
    expect(["markup_rules", "net", "override", "", null].map(isPricingMode)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("the checkout's amounts in a pricing mode", () => {
  it("are the Amadeus total and the Amadeus prices of the extras in net mode, the engine bypassed [OBE-050 AC1]", () => {
    const amounts = baseAmountsFor("net", PRICED, SELECTIONS, 2);
    const fee = cardFeeFor("net", QUOTE, 2);

    expect(amounts).toEqual({ offer: "400.00", ancillaries: "47.30" });
    // The Amadeus card fee alone: no OTA `payment_card` surcharge on the airline's price.
    expect(fee).toBe("1.20");
    expect(checkoutTotalOf(amounts, fee, 2)).toBe("448.50");
  });

  it("are the selling amounts with the OTA's card surcharge in markup_rules mode (choosing a card again)", () => {
    const amounts = baseAmountsFor("markup_rules", PRICED, SELECTIONS, 2);
    const fee = cardFeeFor("markup_rules", QUOTE, 2);

    expect(amounts).toEqual({ offer: "431.50", ancillaries: "52.30" });
    expect(fee).toBe("1.70");
    expect(checkoutTotalOf(amounts, fee, 2)).toBe("485.50");
    expect(baseTotalOf(amounts)).toBe("483.8");
  });

  it("have no card fee without a quote, no extras without selections, and the currency's minor units", () => {
    expect(cardFeeFor("net", undefined, 2)).toBe("0.00");
    expect(cardFeeFor("markup_rules", undefined, 0)).toBe("0");
    expect(baseAmountsFor("net", { sellingTotal: "51000", netTotal: "48000" }, [], 0)).toEqual({
      offer: "48000",
      ancillaries: "0",
    });
    expect(checkoutTotalOf({ offer: "48000", ancillaries: "0" }, "350", 0)).toBe("48350");
    expect(baseAmountsFor("net", { sellingTotal: "10.555", netTotal: "9.995" }, [], 3)).toEqual({
      offer: "9.995",
      ancillaries: "0.000",
    });
  });

  it("add up exactly in decimals, never with binary floating point", () => {
    const amounts = baseAmountsFor(
      "net",
      { sellingTotal: "0.30", netTotal: "0.10" },
      [{ priceAmount: "0.25", netAmount: "0.20" }],
      2,
    );

    // 0.1 + 0.2 is 0.30000000000000004 as JavaScript numbers.
    expect(amounts).toEqual({ offer: "0.10", ancillaries: "0.20" });
    expect(checkoutTotalOf(amounts, "0.00", 2)).toBe("0.30");
  });
});
