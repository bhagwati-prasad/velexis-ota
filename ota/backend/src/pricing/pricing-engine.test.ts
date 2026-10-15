// The markup and fee engine (OADR-0005), table-driven: every case prices one offer and checks its lines, its selling
// total and the invariant `selling = net + Σ markup lines + Σ fee lines` that the flight_offers and priced_offers
// CHECKs rely on. Matching details are in rule-matcher.test.ts; loading the rules of a tenant is in
// test/integration/pricing/rules.int.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { priceOffer } from "./pricing-engine";
import {
  Money,
  PricingInputError,
  type FeeLine,
  type FeeRule,
  type MarkupLine,
  type MarkupRule,
  type PricingInput,
  type PricingResult,
  type PricingStep,
} from "./pricing.types";

const AT = new Date("2026-11-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** Paris to New York and back, 2 adults and 1 child, 2 segments, net 1000.00 EUR. */
const INPUT: PricingInput = Object.freeze({
  at: AT,
  currency: "EUR",
  minorUnits: 2,
  netTotal: "1000.00",
  origin: "CDG",
  destination: "JFK",
  originCountry: "FR",
  destinationCountry: "US",
  validatingCarriers: Object.freeze(["AF"]),
  marketingCarriers: Object.freeze(["AF", "KL"]),
  cabins: Object.freeze(["ECONOMY"]),
  travelers: Object.freeze({ ADULT: 2, CHILD: 1 }),
  segmentCount: 2,
  tripType: "round_trip",
  source: "GDS",
  channel: "storefront",
});

const SEARCH: PricingStep = { kind: "search" };
const PRICING: PricingStep = { kind: "pricing" };

/** A percentage markup rule of priority 100 matching everything; overrides change it. */
function mk(id: string, overrides: Partial<MarkupRule> = {}): MarkupRule {
  return {
    id,
    name: `Rule ${id}`,
    scope: {},
    calculation: "percentage",
    percentage: "0",
    fixedAmount: null,
    fixedCurrency: null,
    appliesPer: "booking",
    minAmount: null,
    maxAmount: null,
    priority: 100,
    stackable: false,
    isDefault: false,
    isActive: true,
    activeFrom: null,
    activeUntil: null,
    ...overrides,
  };
}

/** A fixed markup rule in EUR. */
const fixedMk = (id: string, amount: string, overrides: Partial<MarkupRule> = {}): MarkupRule =>
  mk(id, { calculation: "fixed", percentage: null, fixedAmount: amount, fixedCurrency: "EUR", ...overrides });

/** A fixed `booking_service` fee of priority 100 in EUR; overrides change it. */
function fee(id: string, overrides: Partial<FeeRule> = {}): FeeRule {
  return {
    id,
    name: `Fee ${id}`,
    label: `Label ${id}`,
    feeType: "booking_service",
    scope: {},
    calculation: "fixed",
    percentage: null,
    fixedAmount: "0",
    fixedCurrency: "EUR",
    appliesPer: "booking",
    minAmount: null,
    maxAmount: null,
    refundable: false,
    priority: 100,
    isActive: true,
    activeFrom: null,
    activeUntil: null,
    ...overrides,
  };
}

/** A percentage fee rule. */
const pctFee = (id: string, percentage: string, overrides: Partial<FeeRule> = {}): FeeRule =>
  fee(id, { calculation: "percentage", percentage, fixedAmount: null, fixedCurrency: null, ...overrides });

/** The seeded default rule (OADR-0007 item 4): priority 1000, 0 %, scope {}. */
const DEFAULT = mk("mkr_default", { name: "Default", priority: 1000, isDefault: true });

interface EngineCase {
  readonly name: string;
  readonly input?: Partial<PricingInput>;
  readonly rules?: readonly MarkupRule[];
  readonly fees?: readonly FeeRule[];
  readonly step?: PricingStep;
  /** `[ruleId, amount]` per markup line, in order. */
  readonly markup: readonly (readonly [string, string])[];
  /** `[ruleId, amount]` per fee line (`ruleId:extraRef` for an extra), in order. */
  readonly feeLines?: readonly (readonly [string, string])[];
  readonly selling: string;
  /** The base rule; by default the rule of the line whose role is `base`, or null. */
  readonly base?: string | null;
  readonly floored?: boolean;
  /** Matched against the markup lines in order. */
  readonly lines?: readonly Partial<MarkupLine>[];
  /** Matched against the fee lines in order. */
  readonly feeDetails?: readonly Partial<FeeLine>[];
}

const CASES: readonly EngineCase[] = [
  // Matching and the default rule
  {
    name: "the default rule alone adds 0 %: selling is the net total",
    rules: [DEFAULT],
    markup: [["mkr_default", "0.00"]],
    base: "mkr_default",
    selling: "1000.00",
  },
  {
    name: "no matching rule: no markup line and no base rule",
    rules: [mk("mkr_lhr", { scope: { destinations: ["LHR"] }, percentage: "9" })],
    markup: [],
    base: null,
    selling: "1000.00",
  },
  {
    name: "the first matching non-stackable rule by priority is the base",
    rules: [
      mk("mkr_p50", { priority: 50, percentage: "5" }),
      mk("mkr_p10", { priority: 10, percentage: "8" }),
      DEFAULT,
    ],
    markup: [["mkr_p10", "80.00"]],
    selling: "1080.00",
  },
  {
    name: "equal priorities: the lower id wins",
    rules: [mk("mkr_b", { priority: 50, percentage: "7" }), mk("mkr_a", { priority: 50, percentage: "3" })],
    markup: [["mkr_a", "30.00"]],
    selling: "1030.00",
  },
  {
    name: "carriers are any of the validating and marketing carriers",
    rules: [mk("mkr_kl", { priority: 10, scope: { carriers: ["KL"] }, percentage: "2" }), DEFAULT],
    markup: [["mkr_kl", "20.00"]],
    selling: "1020.00",
  },
  {
    name: "a rule with one non-matching scope field is skipped",
    rules: [
      mk("mkr_biz", { priority: 10, scope: { origins: ["CDG"], cabins: ["BUSINESS"] }, percentage: "4" }),
      DEFAULT,
    ],
    markup: [["mkr_default", "0.00"]],
    selling: "1000.00",
  },
  {
    name: "minNet and maxNet are inclusive bounds of the net total",
    rules: [
      mk("mkr_over", { priority: 10, scope: { minNet: "1000.01" }, percentage: "9" }),
      mk("mkr_band", { priority: 20, scope: { minNet: "500.00", maxNet: "1000.00" }, percentage: "3" }),
      DEFAULT,
    ],
    markup: [["mkr_band", "30.00"]],
    selling: "1030.00",
  },
  {
    name: "disabled rules and rules outside their validity window are skipped",
    rules: [
      mk("mkr_off", { priority: 1, isActive: false, percentage: "50" }),
      mk("mkr_later", { priority: 2, activeFrom: new Date(AT.getTime() + DAY), percentage: "40" }),
      mk("mkr_ended", { priority: 3, activeUntil: AT, percentage: "30" }),
      mk("mkr_now", { priority: 4, activeFrom: AT, percentage: "2" }),
      DEFAULT,
    ],
    markup: [["mkr_now", "20.00"]],
    selling: "1020.00",
  },
  // Stacking
  {
    name: "stacking: a stackable rule with a lower priority number adds to the base",
    rules: [
      fixedMk("mkr_plus5", "5.00", { priority: 10, stackable: true }),
      mk("mkr_base", { priority: 50, percentage: "5" }),
      DEFAULT,
    ],
    markup: [
      ["mkr_plus5", "5.00"],
      ["mkr_base", "50.00"],
    ],
    base: "mkr_base",
    lines: [{ role: "stacked" }, { role: "base" }],
    selling: "1055.00",
  },
  {
    name: "stacking: a stackable rule evaluated after the base is ignored",
    rules: [
      mk("mkr_base", { priority: 50, percentage: "5" }),
      mk("mkr_late", { priority: 60, stackable: true, percentage: "1" }),
    ],
    markup: [["mkr_base", "50.00"]],
    selling: "1050.00",
  },
  {
    name: "stacking: without a base rule every matching stackable rule adds",
    rules: [
      mk("mkr_s2", { priority: 2000, stackable: true, percentage: "2" }),
      mk("mkr_s1", { priority: 10, stackable: true, percentage: "1" }),
    ],
    markup: [
      ["mkr_s1", "10.00"],
      ["mkr_s2", "20.00"],
    ],
    base: null,
    selling: "1030.00",
  },
  {
    name: "stacking: a stackable rule adds to the default rule",
    rules: [mk("mkr_s", { priority: 10, stackable: true, percentage: "1.5" }), DEFAULT],
    markup: [
      ["mkr_s", "15.00"],
      ["mkr_default", "0.00"],
    ],
    base: "mkr_default",
    selling: "1015.00",
  },
  // Units: per booking, traveller, segment
  {
    name: "a fixed amount per traveller is multiplied by the travellers",
    rules: [fixedMk("mkr_pax", "7.50", { appliesPer: "traveler" })],
    markup: [["mkr_pax", "22.50"]],
    lines: [{ appliesPer: "traveler", units: 3, fixedApplied: true, capped: null }],
    selling: "1022.50",
  },
  {
    name: "a per-traveller rule for children counts the children only",
    rules: [fixedMk("mkr_child", "10.00", { appliesPer: "traveler", scope: { travelerTypes: ["CHILD"] } })],
    markup: [["mkr_child", "10.00"]],
    lines: [{ units: 1 }],
    selling: "1010.00",
  },
  {
    name: "a per-traveller percentage takes the per-traveller net share",
    rules: [
      mk("mkr_child_pct", { appliesPer: "traveler", scope: { travelerTypes: ["CHILD"] }, percentage: "3" }),
    ],
    markup: [["mkr_child_pct", "10.00"]],
    selling: "1010.00",
  },
  {
    name: "per segment: a fixed amount is multiplied by the segments",
    rules: [fixedMk("mkr_seg", "3.00", { appliesPer: "segment" })],
    markup: [["mkr_seg", "6.00"]],
    lines: [{ appliesPer: "segment", units: 2 }],
    selling: "1006.00",
  },
  {
    name: "percentage plus fixed per traveller",
    rules: [
      mk("mkr_ppf", {
        calculation: "percentage_plus_fixed",
        percentage: "1",
        fixedAmount: "2.00",
        fixedCurrency: "EUR",
        appliesPer: "traveler",
      }),
    ],
    markup: [["mkr_ppf", "16.00"]],
    selling: "1016.00",
  },
  // Caps
  {
    name: "caps: the upper cap limits the amount per traveller",
    rules: [
      mk("mkr_max", { percentage: "10", appliesPer: "traveler", maxAmount: "25.00", fixedCurrency: "EUR" }),
    ],
    markup: [["mkr_max", "75.00"]],
    lines: [{ capped: "max", units: 3 }],
    selling: "1075.00",
  },
  {
    name: "caps: the lower cap raises a small booking markup",
    rules: [mk("mkr_min", { percentage: "1", minAmount: "15.00", fixedCurrency: "EUR" })],
    markup: [["mkr_min", "15.00"]],
    lines: [{ capped: "min" }],
    selling: "1015.00",
  },
  {
    name: "caps: per segment, the cap applies to each segment's share",
    rules: [
      mk("mkr_seg_max", { percentage: "2", appliesPer: "segment", maxAmount: "8.00", fixedCurrency: "EUR" }),
    ],
    markup: [["mkr_seg_max", "16.00"]],
    lines: [{ capped: "max", units: 2 }],
    selling: "1016.00",
  },
  {
    name: "caps: when the caps cross, the upper cap wins",
    rules: [
      mk("mkr_crossed", { percentage: "1", minAmount: "30.00", maxAmount: "20.00", fixedCurrency: "EUR" }),
    ],
    markup: [["mkr_crossed", "20.00"]],
    lines: [{ capped: "max" }],
    selling: "1020.00",
  },
  // Currency of fixed amounts and caps
  {
    name: "foreign fixed currency: the fixed part is skipped, the percentage still applies",
    rules: [
      mk("mkr_usd", {
        calculation: "percentage_plus_fixed",
        percentage: "2",
        fixedAmount: "10.00",
        fixedCurrency: "USD",
      }),
    ],
    markup: [["mkr_usd", "20.00"]],
    lines: [{ fixedApplied: false }],
    selling: "1020.00",
  },
  {
    name: "foreign fixed currency: a fixed-only rule adds nothing but keeps its line",
    rules: [fixedMk("mkr_usd_fixed", "10.00", { fixedCurrency: "USD" })],
    markup: [["mkr_usd_fixed", "0.00"]],
    lines: [{ fixedApplied: false }],
    selling: "1000.00",
  },
  {
    name: "foreign fixed currency: caps in another currency are not applied",
    rules: [mk("mkr_usd_cap", { percentage: "10", maxAmount: "25.00", fixedCurrency: "USD" })],
    markup: [["mkr_usd_cap", "100.00"]],
    lines: [{ capped: null }],
    selling: "1100.00",
  },
  {
    name: "a fixed amount without a currency is never applied",
    rules: [fixedMk("mkr_no_currency", "10.00", { fixedCurrency: null })],
    markup: [["mkr_no_currency", "0.00"]],
    lines: [{ fixedApplied: false }],
    selling: "1000.00",
  },
  // Rounding
  {
    name: "rounding: half-up per line (0.505 → 0.51)",
    input: { netTotal: "101.00" },
    rules: [mk("mkr_half", { percentage: "0.5" })],
    markup: [["mkr_half", "0.51"]],
    selling: "101.51",
  },
  {
    name: "rounding: each line is rounded before the lines are summed",
    input: { netTotal: "101.00" },
    rules: [
      mk("mkr_s", { priority: 10, stackable: true, percentage: "0.5" }),
      mk("mkr_b", { priority: 20, percentage: "0.5" }),
    ],
    markup: [
      ["mkr_s", "0.51"],
      ["mkr_b", "0.51"],
    ],
    selling: "102.02",
  },
  {
    name: "rounding: a non-terminating per-traveller share is rounded once, on the line",
    input: { netTotal: "100.01" },
    rules: [mk("mkr_share", { percentage: "50", appliesPer: "traveler" })],
    markup: [["mkr_share", "50.01"]],
    selling: "150.02",
  },
  {
    name: "rounding: a currency without minor units (JPY)",
    input: { currency: "JPY", minorUnits: 0, netTotal: "51240" },
    rules: [mk("mkr_jpy", { percentage: "1.25" })],
    markup: [["mkr_jpy", "641"]],
    selling: "51881",
  },
  {
    name: "rounding: a currency with three minor units (KWD)",
    input: { currency: "KWD", minorUnits: 3, netTotal: "120.500" },
    rules: [mk("mkr_kwd", { percentage: "0.25" })],
    markup: [["mkr_kwd", "0.301"]],
    selling: "120.801",
  },
  // Negative markup
  {
    name: "negative markup: a negative percentage is a discount",
    rules: [mk("mkr_discount", { percentage: "-5" })],
    markup: [["mkr_discount", "-50.00"]],
    selling: "950.00",
  },
  {
    name: "negative markup: the lower cap limits a discount",
    rules: [mk("mkr_discount_cap", { percentage: "-10", minAmount: "-30.00", fixedCurrency: "EUR" })],
    markup: [["mkr_discount_cap", "-30.00"]],
    lines: [{ capped: "min" }],
    selling: "970.00",
  },
  {
    name: "negative markup: ties round away from zero (-0.505 → -0.51)",
    input: { netTotal: "101.00" },
    rules: [mk("mkr_neg_half", { percentage: "-0.5" })],
    markup: [["mkr_neg_half", "-0.51"]],
    selling: "100.49",
  },
  {
    name: "negative markup: -100 % sells at zero without flooring",
    rules: [mk("mkr_free", { percentage: "-100" })],
    markup: [["mkr_free", "-1000.00"]],
    floored: false,
    selling: "0.00",
  },
  {
    name: "negative markup: stacked discounts below -net are floored on the last line",
    rules: [
      mk("mkr_s", { priority: 10, stackable: true, percentage: "-60" }),
      mk("mkr_b", { priority: 20, percentage: "-70" }),
    ],
    markup: [
      ["mkr_s", "-600.00"],
      ["mkr_b", "-400.00"],
    ],
    floored: true,
    selling: "0.00",
  },
  {
    name: "negative markup: a fixed discount larger than the net total is floored",
    rules: [fixedMk("mkr_huge", "-1500.00")],
    markup: [["mkr_huge", "-1000.00"]],
    floored: true,
    selling: "0.00",
  },
  // Fees by step
  {
    name: "fees: search results carry no fees",
    rules: [DEFAULT],
    fees: [fee("fee_service", { fixedAmount: "10.00" })],
    step: SEARCH,
    markup: [["mkr_default", "0.00"]],
    feeLines: [],
    selling: "1000.00",
  },
  {
    name: "fees: pricing adds booking_service and ticketing fees, no other type",
    rules: [mk("mkr_base", { percentage: "5" })],
    fees: [
      fee("fee_service", { fixedAmount: "10.00" }),
      fee("fee_ticket", { feeType: "ticketing", fixedAmount: "2.00", appliesPer: "traveler" }),
      fee("fee_card", { feeType: "payment_card", fixedAmount: "3.00" }),
      fee("fee_cancel", { feeType: "cancellation", fixedAmount: "50.00" }),
      fee("fee_change", { feeType: "change", fixedAmount: "40.00" }),
    ],
    step: PRICING,
    markup: [["mkr_base", "50.00"]],
    feeLines: [
      ["fee_service", "10.00"],
      ["fee_ticket", "6.00"],
    ],
    feeDetails: [
      { feeType: "booking_service", label: "Label fee_service", units: 1, extraRef: null },
      { feeType: "ticketing", units: 3 },
    ],
    selling: "1066.00",
  },
  {
    name: "fees: a percentage fee applies to the price after markup",
    rules: [mk("mkr_base", { percentage: "10" })],
    fees: [pctFee("fee_service", "1")],
    step: PRICING,
    markup: [["mkr_base", "100.00"]],
    feeLines: [["fee_service", "11.00"]],
    selling: "1111.00",
  },
  {
    name: "fees: only the first matching rule of a fee type applies",
    rules: [DEFAULT],
    fees: [
      fee("fee_lhr", { priority: 10, scope: { destinations: ["LHR"] }, fixedAmount: "30.00" }),
      fee("fee_general", { priority: 20, fixedAmount: "15.00" }),
      fee("fee_low", { priority: 30, fixedAmount: "5.00" }),
    ],
    step: PRICING,
    markup: [["mkr_default", "0.00"]],
    feeLines: [["fee_general", "15.00"]],
    selling: "1015.00",
  },
  {
    name: "fees: caps apply, a fixed fee in another currency is skipped",
    rules: [DEFAULT],
    fees: [
      pctFee("fee_service", "2", { maxAmount: "15.00", fixedCurrency: "EUR" }),
      fee("fee_ticket", { feeType: "ticketing", fixedAmount: "5.00", fixedCurrency: "USD" }),
    ],
    step: PRICING,
    markup: [["mkr_default", "0.00"]],
    feeLines: [
      ["fee_service", "15.00"],
      ["fee_ticket", "0.00"],
    ],
    feeDetails: [{ capped: "max" }, { fixedApplied: false }],
    selling: "1015.00",
  },
  {
    name: "fees: ancillary_service applies once per extra on the extra's amount",
    rules: [DEFAULT],
    fees: [
      fee("fee_anc", {
        feeType: "ancillary_service",
        calculation: "percentage_plus_fixed",
        percentage: "5",
        fixedAmount: "1.00",
        appliesPer: "segment",
      }),
    ],
    step: {
      kind: "pricing",
      extras: [
        { ref: "anc_bag", amount: "40.00", travelers: 1, segments: 2 },
        { ref: "anc_seat", amount: "15.00", travelers: 1, segments: 1 },
      ],
    },
    markup: [["mkr_default", "0.00"]],
    feeLines: [
      ["fee_anc:anc_bag", "4.00"],
      ["fee_anc:anc_seat", "1.75"],
    ],
    feeDetails: [{ units: 2 }, { units: 1 }],
    selling: "1005.75",
  },
  {
    name: "fees: payment_card applies the rule listing the known brand, on the amount charged",
    rules: [DEFAULT],
    fees: [
      pctFee("fee_amex", "3", {
        feeType: "payment_card",
        priority: 10,
        scope: { cardBrands: ["AMERICAN_EXPRESS"] },
      }),
      pctFee("fee_visa", "1.5", {
        feeType: "payment_card",
        priority: 20,
        scope: { cardBrands: ["VISA", "MASTERCARD"] },
      }),
      pctFee("fee_card", "2", { feeType: "payment_card", priority: 30 }),
      fee("fee_service", { fixedAmount: "10.00" }),
    ],
    step: { kind: "payment_card", cardBrand: "VISA", baseAmount: "1066.00" },
    markup: [["mkr_default", "0.00"]],
    feeLines: [["fee_visa", "15.99"]],
    selling: "1015.99",
  },
  {
    name: "fees: payment_card falls back to the general card rule for an unlisted brand",
    rules: [DEFAULT],
    fees: [
      pctFee("fee_visa", "1.5", { feeType: "payment_card", priority: 20, scope: { cardBrands: ["VISA"] } }),
      pctFee("fee_card", "2", { feeType: "payment_card", priority: 30 }),
    ],
    step: { kind: "payment_card", cardBrand: "DINERS", baseAmount: "1066.00" },
    markup: [["mkr_default", "0.00"]],
    feeLines: [["fee_card", "21.32"]],
    selling: "1021.32",
  },
  {
    name: "fees: cancellation applies the cancellation rule per traveller and keeps its refundable flag",
    rules: [DEFAULT],
    fees: [
      fee("fee_cancel", { feeType: "cancellation", fixedAmount: "50.00", appliesPer: "traveler" }),
      fee("fee_service", { fixedAmount: "10.00", refundable: true }),
    ],
    step: { kind: "cancellation", baseAmount: "1066.00" },
    markup: [["mkr_default", "0.00"]],
    feeLines: [["fee_cancel", "150.00"]],
    feeDetails: [{ feeType: "cancellation", refundable: false, units: 3 }],
    selling: "1150.00",
  },
  {
    name: "fees: a percentage cancellation fee applies to the booking total",
    rules: [DEFAULT],
    fees: [pctFee("fee_cancel", "10", { feeType: "cancellation", refundable: true })],
    step: { kind: "cancellation", baseAmount: "1066.00" },
    markup: [["mkr_default", "0.00"]],
    feeLines: [["fee_cancel", "106.60"]],
    feeDetails: [{ refundable: true }],
    selling: "1106.60",
  },
  {
    name: "fees: a rule with card brands never applies before the brand is known",
    rules: [DEFAULT],
    fees: [fee("fee_visa_service", { scope: { cardBrands: ["VISA"] }, fixedAmount: "10.00" })],
    step: PRICING,
    markup: [["mkr_default", "0.00"]],
    feeLines: [],
    selling: "1000.00",
  },
  {
    name: "fees: a fee line is never negative, even with a negative upper cap",
    rules: [DEFAULT],
    fees: [fee("fee_bad_cap", { fixedAmount: "5.00", maxAmount: "-1.00" })],
    step: PRICING,
    markup: [["mkr_default", "0.00"]],
    feeLines: [["fee_bad_cap", "0.00"]],
    feeDetails: [{ capped: "max" }],
    selling: "1000.00",
  },
];

function price(testCase: EngineCase): PricingResult {
  return priceOffer(
    { ...INPUT, ...testCase.input },
    testCase.rules ?? [],
    testCase.fees ?? [],
    testCase.step ?? SEARCH,
  );
}

/** What `call` threw, or `undefined` when it returned. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

const sumOf = (amounts: readonly string[]) =>
  amounts.reduce((total, amount) => total.plus(new Money(amount)), new Money(0));

describe("priceOffer", () => {
  it("has at least 25 cases covering stacking, caps, rounding, negative markup, foreign fixed currency and per-segment [OBE-020 AC1]", () => {
    const names = CASES.map((testCase) => testCase.name);
    expect(CASES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(names).size).toBe(names.length);
    for (const topic of [
      "stacking:",
      "caps:",
      "rounding:",
      "negative markup:",
      "foreign fixed currency:",
      "per segment",
    ]) {
      expect(names.some((name) => name.includes(topic))).toBe(true);
    }
  });

  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    "%s [OBE-020 AC1]",
    (_name, testCase) => {
      const result = price(testCase);
      const minorUnits = testCase.input?.minorUnits ?? INPUT.minorUnits;

      expect(result.markupLines.map((line) => [line.ruleId, line.amount])).toEqual(testCase.markup);
      expect(
        result.feeLines.map((line) => [
          line.extraRef === null ? line.ruleId : `${line.ruleId}:${line.extraRef}`,
          line.amount,
        ]),
      ).toEqual(testCase.feeLines ?? []);
      expect(result.selling).toBe(testCase.selling);
      const base =
        testCase.base !== undefined
          ? testCase.base
          : (result.markupLines.find((line) => line.role === "base")?.ruleId ?? null);
      expect(result.markupRuleId).toBe(base);
      expect(result.markupFloored).toBe(testCase.floored ?? false);
      for (const [index, expected] of (testCase.lines ?? []).entries()) {
        expect(result.markupLines[index]).toMatchObject(expected);
      }
      for (const [index, expected] of (testCase.feeDetails ?? []).entries()) {
        expect(result.feeLines[index]).toMatchObject(expected);
      }

      // The invariant behind the database CHECKs: selling = net + Σ markup lines + Σ fee lines, exactly.
      const markupTotal = sumOf(result.markupLines.map((line) => line.amount));
      const feeTotal = sumOf(result.feeLines.map((line) => line.amount));
      expect(result.markupTotal).toBe(markupTotal.toFixed(minorUnits));
      expect(result.feeTotal).toBe(feeTotal.toFixed(minorUnits));
      expect(new Money(result.net).plus(markupTotal).plus(feeTotal).eq(new Money(result.selling))).toBe(true);
      expect(new Money(result.selling).isNegative() && !new Money(result.selling).isZero()).toBe(false);

      // Every amount is a decimal string with exactly the currency's minor units.
      const amountPattern = minorUnits === 0 ? /^-?\d+$/ : new RegExp(`^-?\\d+\\.\\d{${minorUnits}}$`);
      const amounts = [
        result.net,
        result.markupTotal,
        result.feeTotal,
        result.selling,
        ...result.markupLines.map((line) => line.amount),
        ...result.feeLines.map((line) => line.amount),
      ];
      for (const amount of amounts) {
        expect(typeof amount).toBe("string");
        expect(amount).toMatch(amountPattern);
      }
    },
  );

  it("returns the step, the currency and the net total with the currency's minor units", () => {
    const result = priceOffer({ ...INPUT, netTotal: "512.4" }, [DEFAULT], [], SEARCH);

    expect(result).toMatchObject({ step: "search", currency: "EUR", net: "512.40", selling: "512.40" });
  });

  it("never writes -0: a discount that rounds to zero is 0.00", () => {
    const result = priceOffer(
      { ...INPUT, netTotal: "0.10" },
      [mk("mkr_tiny", { percentage: "-1" })],
      [],
      SEARCH,
    );

    expect(result.markupLines[0]?.amount).toBe("0.00");
    expect(result.markupTotal).toBe("0.00");
    expect(result.selling).toBe("0.10");
  });

  it("is pure: frozen inputs are not changed, the order of the rules does not matter, and results repeat", () => {
    const rules = [
      mk("mkr_s", { priority: 10, stackable: true, percentage: "1" }),
      mk("mkr_b", { priority: 20, percentage: "-70" }),
      mk("mkr_c", { priority: 30, percentage: "9" }),
      DEFAULT,
    ].map((rule) => Object.freeze({ ...rule, scope: Object.freeze({ ...rule.scope }) }));
    const fees = [
      Object.freeze(fee("fee_service", { fixedAmount: "10.00" })),
      Object.freeze(fee("fee_ticket", { feeType: "ticketing", fixedAmount: "1.00" })),
    ];
    const step: PricingStep = Object.freeze({ kind: "pricing" });

    const first = priceOffer(INPUT, Object.freeze(rules), Object.freeze(fees), step);
    const reversed = priceOffer(INPUT, [...rules].reverse(), [...fees].reverse(), step);
    const again = priceOffer(INPUT, rules, fees, step);

    expect(reversed).toEqual(first);
    expect(again).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.markupLines)).toBe(true);
    expect(Object.isFrozen(first.feeLines[0])).toBe(true);
    expect(first.markupLines.map((line) => line.ruleId)).toEqual(["mkr_s", "mkr_b"]);
  });

  it("names the rule and the field when a rule holds a malformed amount", () => {
    const call = () => priceOffer(INPUT, [mk("mkr_bad", { percentage: "5%" })], [], SEARCH);

    expect(call).toThrow(PricingInputError);
    expect(call).toThrow("markupRules[mkr_bad].percentage is not a decimal string");
  });

  it.each([
    ["an invalid date", { at: new Date("not a date") }, "at"],
    ["a lower-case currency", { currency: "eur" }, "currency"],
    ["minor units that are not an integer", { minorUnits: 2.5 }, "minorUnits"],
    ["more than 4 minor units", { minorUnits: 5 }, "minorUnits"],
    ["a net total with an exponent", { netTotal: "1e3" }, "netTotal"],
    ["a negative net total", { netTotal: "-1.00" }, "netTotal"],
    ["a net total with more decimals than the currency", { netTotal: "10.001" }, "netTotal"],
    ["an empty origin", { origin: " " }, "origin"],
    ["a country that is an empty string", { destinationCountry: "" }, "destinationCountry"],
    [
      "a carrier list with a number",
      { marketingCarriers: ["AF", 7] as unknown as string[] },
      "marketingCarriers",
    ],
    ["an unknown trip type", { tripType: "open_jaw" as PricingInput["tripType"] }, "tripType"],
    ["an unknown channel", { channel: "import" as PricingInput["channel"] }, "channel"],
    ["no segment", { segmentCount: 0 }, "segmentCount"],
    ["no traveller", { travelers: { ADULT: 0 } }, "travelers"],
    ["a negative traveller count", { travelers: { ADULT: 2, CHILD: -1 } }, "travelers"],
  ])("refuses %s with a PricingInputError naming the field", (_name, input: Partial<PricingInput>, field) => {
    const error = thrownBy(() => priceOffer({ ...INPUT, ...input }, [DEFAULT], [], SEARCH));

    expect(error).toBeInstanceOf(PricingInputError);
    expect(error).toMatchObject({ field });
  });

  it.each([
    ["a negative base amount", { kind: "cancellation", baseAmount: "-5.00" }, "step.baseAmount"],
    [
      "a base amount with too many decimals",
      { kind: "payment_card", cardBrand: "VISA", baseAmount: "1.001" },
      "step.baseAmount",
    ],
    ["an empty card brand", { kind: "payment_card", cardBrand: "", baseAmount: "1.00" }, "step.cardBrand"],
    [
      "an extra without a reference",
      { kind: "pricing", extras: [{ ref: "", amount: "1.00", travelers: 1, segments: 1 }] },
      "step.extras[0].ref",
    ],
    [
      "an extra for no segment",
      { kind: "pricing", extras: [{ ref: "anc_1", amount: "1.00", travelers: 1, segments: 0 }] },
      "step.extras[0]",
    ],
    [
      "an extra with a malformed amount",
      { kind: "pricing", extras: [{ ref: "anc_1", amount: "one", travelers: 1, segments: 1 }] },
      "step.extras[0].amount",
    ],
    ["an unknown step", { kind: "quote" } as unknown as PricingStep, "step.kind"],
  ])("refuses a step with %s, whether or not a fee rule would use it", (_name, step, field) => {
    const error = thrownBy(() => priceOffer(INPUT, [DEFAULT], [], step as PricingStep));

    expect(error).toBeInstanceOf(PricingInputError);
    expect(error).toMatchObject({ field });
  });
});

describe("money in src/pricing", () => {
  const PRICING_DIR = __dirname;
  // Built from parts, so this file does not match itself.
  const FORBIDDEN = [
    ["Num", "ber("],
    ["parse", "Float"],
    ["parse", "Int"],
    ["Math", "."],
    [".toNum", "ber("],
  ].map((parts) => parts.join(""));

  it("never turns money into a JavaScript number: no number conversion, number parsing or Math call [OBE-020 AC2]", () => {
    const files = readdirSync(PRICING_DIR).filter((name) => name.endsWith(".ts"));
    expect(files).toEqual(
      expect.arrayContaining([
        "pricing-engine.ts",
        "rule-matcher.ts",
        "pricing.types.ts",
        "rules.repository.ts",
      ]),
    );

    const hits = files.flatMap((name) => {
      const source = readFileSync(join(PRICING_DIR, name), "utf8");
      return FORBIDDEN.filter((needle) => source.includes(needle)).map((needle) => `${name}: ${needle}`);
    });
    expect(hits).toEqual([]);
  });

  it("computes with decimal.js, configured locally with half-up rounding [OBE-020 AC2]", () => {
    const types = readFileSync(join(PRICING_DIR, "pricing.types.ts"), "utf8");
    expect(types).toContain('import { Decimal } from "decimal.js";');
    expect(Money.rounding).toBe(Money.ROUND_HALF_UP);
    expect(new Money("0.1").plus("0.2").toFixed(20)).toBe("0.30000000000000000000");
  });
});
