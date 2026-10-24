// The credit-card fee of a payment (OBE-038; flow §2 step 4, OADR-0005 point 7): the Amadeus fee of the brand from the
// priced offer or from a Flight Offers Price answer, the fare check of that answer, the OTA's `payment_card` rules on
// the engine input of the priced offer's offers, and the request of the quote. The Amadeus offer is the stub's priced
// Madrid–Paris Orly offer (tools/amadeus-stub/fixtures/flight-offers-price/success.json); no service is called.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@velexis/errors";
import { describe, expect, it, vi } from "vitest";
import type { AmadeusClient } from "../amadeus/amadeus.client";
import { APP_DIR } from "../config";
import { priceOffer } from "../pricing/pricing-engine";
import type { FeeLine, FeeRule } from "../pricing/pricing.types";
import type { RulesRepository } from "../pricing/rules.repository";
import { cardFeeLinesFor } from "../checkout/pricing-mode";
import { parseOffer, type ParsedOffer } from "../shopping/offers.mapper";
import {
  CardFees,
  cardFeeRequest,
  cardFeeTotal,
  changedFares,
  keptCardFeeOf,
  pricedOfferCardFee,
  pricingInputOfOffers,
  quotedCardFee,
  type CardFeePlan,
} from "./card-fees";
import type { PaymentsRepository } from "./payments.repository";

const PRICED = JSON.parse(
  readFileSync(join(APP_DIR, "../../tools/amadeus-stub/fixtures/flight-offers-price/success.json"), "utf8"),
) as { body: { data: { flightOffers: unknown[] } } };
const PAYLOAD = PRICED.body.data.flightOffers[0];
const OFFER = parseOffer(PAYLOAD) as ParsedOffer;
const AT = new Date("2026-10-19T08:00:00.000Z");
const COUNTRIES: Readonly<Record<string, string>> = { MAD: "ES", ORY: "FR" };
const CITIES: Readonly<Record<string, string>> = { MAD: "MAD", ORY: "PAR" };
const CONTEXT = {
  at: AT,
  minorUnits: 2,
  channel: "storefront" as const,
  countryOf: (code: string) => COUNTRIES[code] ?? null,
  cityOf: (code: string) => CITIES[code] ?? null,
};

/** A `payment_card` fee rule of `percentage` % plus `fixed` EUR for `brands` (all brands when empty). */
function cardRule(
  id: string,
  percentage: string,
  fixed: string,
  brands: string[] = [],
  priority = 100,
): FeeRule {
  return {
    id,
    name: `Card fee ${id}`,
    label: "Card fee",
    feeType: "payment_card",
    calculation: "percentage_plus_fixed",
    percentage,
    fixedAmount: fixed,
    fixedCurrency: "EUR",
    appliesPer: "booking",
    minAmount: null,
    maxAmount: null,
    priority,
    isActive: true,
    activeFrom: null,
    activeUntil: null,
    scope: brands.length === 0 ? {} : { cardBrands: brands },
    refundable: false,
  };
}

describe("the Amadeus fee of the priced offer", () => {
  const fees = [
    { brand: "VISA" as const, amount: { amount: "1.20", currency: "EUR" }, offerId: "off_A" },
    { brand: "VISA" as const, amount: { amount: "0.80", currency: "EUR" }, offerId: "off_B" },
    { brand: "MASTERCARD" as const, amount: { amount: "1.50", currency: "EUR" }, offerId: "off_A" },
  ];

  it("is the sum over the offers when every offer has an entry of the brand", () => {
    expect(pricedOfferCardFee(fees, "VISA", ["off_A", "off_B"], "EUR", 2)).toBe("2.00");
    expect(pricedOfferCardFee(fees, "VISA", ["off_A"], "EUR", 2)).toBe("1.20");
  });

  it("must be quoted when an offer has no entry of the brand, or one in another currency", () => {
    expect(pricedOfferCardFee(fees, "MASTERCARD", ["off_A", "off_B"], "EUR", 2)).toBeUndefined();
    expect(pricedOfferCardFee(fees, "AMERICAN_EXPRESS", ["off_A"], "EUR", 2)).toBeUndefined();
    expect(pricedOfferCardFee(fees, "VISA", ["off_A"], "USD", 2)).toBeUndefined();
    expect(pricedOfferCardFee([], "VISA", [], "EUR", 2)).toBeUndefined();
  });
});

describe("the Amadeus fee of a quote", () => {
  const included = {
    "credit-card-fees": {
      "1": { brand: "VISA", amount: "1.20", currency: "EUR", flightOfferId: "2" },
      "2": { brand: "VISA", amount: "0.30", currency: "EUR", flightOfferId: "3" },
      "3": { brand: "MASTERCARD", amount: "1.50", currency: "EUR", flightOfferId: "2" },
      "4": { brand: "VISA", amount: "9.99", currency: "EUR", flightOfferId: "7" },
    },
  };

  it("sums the brand's entries of the priced offers only", () => {
    expect(quotedCardFee(included, "VISA", ["2", "3"], "EUR", 2)).toBe("1.50");
    expect(quotedCardFee(included, "MASTERCARD", ["2"], "EUR", 2)).toBe("1.50");
  });

  it("is zero when the answer lists no fee for the brand, and unusable in another currency or form", () => {
    expect(quotedCardFee(included, "DINERS", ["2"], "EUR", 2)).toBe("0.00");
    expect(quotedCardFee({}, "VISA", ["2"], "EUR", 0)).toBe("0");
    expect(quotedCardFee(included, "VISA", ["2"], "USD", 2)).toBeUndefined();
    expect(
      quotedCardFee(
        {
          "credit-card-fees": { "1": { brand: "VISA", amount: "1,20", currency: "EUR", flightOfferId: "2" } },
        },
        "VISA",
        ["2"],
        "EUR",
        2,
      ),
    ).toBeUndefined();
  });

  it("finds the offers whose grand total moved since pricing", () => {
    const totals = new Map([
      ["2", "98.47"],
      ["3", "50.00"],
    ]);

    expect(
      changedFares(totals, [
        { id: "2", price: { grandTotal: "98.470" } },
        { id: "3", price: { grandTotal: "50.00" } },
      ]),
    ).toEqual([]);
    expect(
      changedFares(totals, [
        { id: "2", price: { grandTotal: "101.20" } },
        { id: "3", price: { grandTotal: "50.00" } },
      ]),
    ).toEqual(["2"]);
    expect(changedFares(totals, [{ id: "2", price: { grandTotal: "98.47" } }])).toEqual(["3"]);
  });
});

describe("the OTA's payment_card fees", () => {
  it("prices the priced offer's facts with the hint's brand on the amount before the fee", () => {
    const input = pricingInputOfOffers([OFFER], CONTEXT);
    expect(input).toMatchObject({
      currency: "EUR",
      netTotal: "98.47",
      origin: "MAD",
      destination: "ORY",
      originCountry: "ES",
      destinationCountry: "FR",
      tripType: "one_way",
      channel: "storefront",
    });

    const rules = [
      cardRule("fee_amex", "3.0000", "0.00", ["AMERICAN_EXPRESS"], 10),
      cardRule("fee_all", "1.0000", "0.50"),
    ];
    const lines = (brand: string): readonly FeeLine[] =>
      priceOffer(input!, [], rules, { kind: "payment_card", cardBrand: brand, baseAmount: "120.00" })
        .feeLines;

    // 1 % of 120.00 plus 0.50 for VISA; for AMERICAN_EXPRESS the AMEX rule, first by priority: 3 % of 120.00.
    expect(lines("VISA").map((line) => [line.ruleId, line.amount])).toEqual([["fee_all", "1.70"]]);
    expect(lines("AMERICAN_EXPRESS").map((line) => [line.ruleId, line.amount])).toEqual([
      ["fee_amex", "3.60"],
    ]);
    expect(cardFeeTotal("1.20", lines("VISA"), 2)).toBe("2.90");
    expect(cardFeeTotal("0.00", [], 0)).toBe("0");
  });

  it("combines several one-way offers as the priced offer's own fees were combined", () => {
    const back = parseOffer({
      ...(PAYLOAD as Record<string, unknown>),
      id: "5",
      itineraries: [
        {
          duration: "PT2H5M",
          segments: [
            {
              departure: { iataCode: "ORY", at: "2027-01-20T10:15:00" },
              arrival: { iataCode: "MAD", at: "2027-01-20T12:20:00" },
              carrierCode: "IB",
              number: "3437",
              duration: "PT2H5M",
              id: "3",
              numberOfStops: 0,
            },
          ],
        },
      ],
    }) as ParsedOffer;

    const input = pricingInputOfOffers([OFFER, back], CONTEXT);

    expect(input).toMatchObject({ netTotal: "196.94", segmentCount: 2, tripType: "round_trip" });
  });
});

describe("the card fee a cancellation keeps (FIX-W28-CANCEL)", () => {
  it("[FIX-W28-CANCEL AC2] stores each line with its rule's flag and keeps all but the refundable ones", () => {
    const input = pricingInputOfOffers([OFFER], CONTEXT);
    const quoteOf = (refundable: boolean) => {
      const feeLines = priceOffer(input!, [], [{ ...cardRule("fee_card", "1.0000", "0.50"), refundable }], {
        kind: "payment_card",
        cardBrand: "VISA",
        baseAmount: "120.00",
      }).feeLines;
      return { amadeusFee: "1.20", feeLines, total: cardFeeTotal("1.20", feeLines, 2) };
    };

    // A refundable rule: its line goes back, the Amadeus fee (never refundable) is kept.
    const refundable = quoteOf(true);
    const lines = cardFeeLinesFor("markup_rules", refundable, 2);
    expect(lines).toEqual([
      { source: "amadeus", ruleId: null, amount: "1.20", refundable: false },
      { source: "fee_rule", ruleId: "fee_card", amount: "1.70", refundable: true },
    ]);
    expect(keptCardFeeOf({ cardFeeAmount: refundable.total, cardFeeLines: lines }, 2)).toBe("1.20");

    // A rule that is not refundable: the whole card fee is kept.
    const kept = quoteOf(false);
    const keptLines = cardFeeLinesFor("markup_rules", kept, 2);
    expect(keptLines.map((line) => line.refundable)).toEqual([false, false]);
    expect(keptCardFeeOf({ cardFeeAmount: kept.total, cardFeeLines: keptLines }, 2)).toBe("2.90");

    // The airline card's price: the Amadeus fee alone, kept whole; no quote, no line.
    expect(cardFeeLinesFor("net", refundable, 2)).toEqual([
      { source: "amadeus", ruleId: null, amount: "1.20", refundable: false },
    ]);
    expect(cardFeeLinesFor("markup_rules", undefined, 2)).toEqual([]);
  });

  it("[FIX-W28-CANCEL AC2] keeps the whole fee of a payment without lines, and never an Amadeus line marked refundable", () => {
    // Payments of before tenant migration 0004 have no line: nothing is refundable.
    expect(keptCardFeeOf({ cardFeeAmount: "3.65", cardFeeLines: [] }, 2)).toBe("3.65");
    expect(keptCardFeeOf({ cardFeeAmount: "3.65" }, 2)).toBe("3.65");
    expect(
      keptCardFeeOf(
        {
          cardFeeAmount: "3.65",
          cardFeeLines: [
            { source: "amadeus", ruleId: null, amount: "1.20", refundable: true },
            { source: "fee_rule", ruleId: "fee_x", amount: "not money", refundable: true },
            "a line that cannot be read",
          ],
        },
        2,
      ),
    ).toBe("3.65");
    // Never below zero, in the currency's minor units.
    expect(
      keptCardFeeOf(
        {
          cardFeeAmount: "2",
          cardFeeLines: [{ source: "fee_rule", ruleId: "f", amount: "5", refundable: true }],
        },
        0,
      ),
    ).toBe("0");
    expect(keptCardFeeOf({ cardFeeAmount: "0" }, 2)).toBe("0.00");
  });
});

describe("the quote", () => {
  const hint = { brand: "VISA", bin: "424242" };
  const plan = (pricedOfferFee: string | undefined): CardFeePlan => ({
    hint,
    currency: "EUR",
    minorUnits: 2,
    feeLines: [
      {
        ruleId: "fee_all",
        feeType: "payment_card",
        label: "Card fee",
        refundable: false,
        extraRef: null,
        appliesPer: "booking",
        units: 1,
        fixedApplied: true,
        capped: null,
        amount: "1.70",
      },
    ],
    pricedOfferFee,
    amadeusOfferIds: ["2"],
    grandTotals: new Map([["2", "98.47"]]),
    request: cardFeeRequest([PAYLOAD], ["2"], hint, false),
    searchId: "srch_01JA4CE5H8K1M4P7R0T3V6Y9B2",
  });
  const ctx = {
    tenantId: "ten_01JA4CE5H8K1M4P7R0T3V6Y9B2",
    environment: "test" as const,
    requestId: "req-1",
  };

  function feesWith(answer: unknown): { fees: CardFees; quoteAirOffers: ReturnType<typeof vi.fn> } {
    const quoteAirOffers = vi.fn(() => Promise.resolve({ body: answer, call: {} }));
    const fees = new CardFees(
      { quoteAirOffers } as unknown as AmadeusClient,
      {} as RulesRepository,
      {} as PaymentsRepository,
    );
    return { fees, quoteAirOffers };
  }

  it("asks the Amadeus card fee of the hint's brand and BIN for the priced offer's confirmed offers", () => {
    expect(cardFeeRequest([PAYLOAD], ["2"], hint, true)).toEqual({
      body: {
        data: {
          type: "flight-offers-pricing",
          flightOffers: [PAYLOAD],
          payments: [{ brand: "VISA", binNumber: 424242, flightOfferIds: ["2"] }],
        },
      },
      query: { include: ["credit-card-fees"], forceClass: true },
    });
    expect(cardFeeRequest([PAYLOAD], ["2"], { brand: "VISA" }, false).body.data.payments).toEqual([
      { brand: "VISA", flightOfferIds: ["2"] },
    ]);
  });

  it("takes the priced offer's fee without calling Amadeus", async () => {
    const { fees, quoteAirOffers } = feesWith({});

    const quote = await fees.quote(ctx, plan("1.20"), "checkout.updatePayment");

    expect(quote).toEqual({
      brand: "VISA",
      bin: "424242",
      amadeusFee: "1.20",
      feeLines: plan("1.20").feeLines,
      total: "2.90",
      source: "priced_offer",
    });
    expect(quoteAirOffers).not.toHaveBeenCalled();
  });

  it("quotes the fee with Flight Offers Price (include=credit-card-fees) when the priced offer has none", async () => {
    const { fees, quoteAirOffers } = feesWith({
      data: { flightOffers: [PAYLOAD] },
      included: {
        "credit-card-fees": { "1": { brand: "VISA", amount: "1.20", currency: "EUR", flightOfferId: "2" } },
      },
    });

    const quote = await fees.quote(ctx, plan(undefined), "checkout.updatePayment");

    expect([quote.amadeusFee, quote.total, quote.source]).toEqual(["1.20", "2.90", "amadeus"]);
    expect(quoteAirOffers).toHaveBeenCalledWith(
      { ...ctx, operation: "checkout.updatePayment", searchId: "srch_01JA4CE5H8K1M4P7R0T3V6Y9B2" },
      { body: plan(undefined).request.body, query: { include: ["credit-card-fees"], forceClass: false } },
    );
  });

  it("answers 409 PRICE_CHANGED when the fare moved, and 502 for a fee it cannot read", async () => {
    const raised = {
      ...(PAYLOAD as Record<string, unknown>),
      price: { currency: "EUR", grandTotal: "120.00" },
    };
    const moved = feesWith({ data: { flightOffers: [raised] }, included: {} }).fees;
    const unreadable = feesWith({
      data: { flightOffers: [PAYLOAD] },
      included: {
        "credit-card-fees": { "1": { brand: "VISA", amount: "1.20", currency: "USD", flightOfferId: "2" } },
      },
    }).fees;

    await expect(moved.quote(ctx, plan(undefined), "checkout.updatePayment")).rejects.toMatchObject({
      code: "PRICE_CHANGED",
      details: { reason: "fare_changed" },
    });
    const error = await unreadable
      .quote(ctx, plan(undefined), "checkout.updatePayment")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("SUPPLIER_ERROR");
  });
});
