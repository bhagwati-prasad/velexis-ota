// Rule matching of the markup and fee engine (OADR-0005 point 3): scope parsing, validity windows, evaluation order,
// "any of" lists, net bounds, card brands, and which markup and fee rules a priced offer gets. The amounts are in
// pricing-engine.test.ts.
import { describe, expect, it } from "vitest";
import {
  compareRules,
  isActiveAt,
  matchingTravelerCount,
  offerFacts,
  parseRuleScope,
  scopeMatches,
  selectFeeRule,
  selectMarkupRules,
} from "./rule-matcher";
import { Money, type FeeRule, type FeeScope, type MarkupRule, type PricingInput } from "./pricing.types";

const AT = new Date("2026-11-01T12:00:00.000Z");

const INPUT: PricingInput = Object.freeze({
  at: AT,
  currency: "EUR",
  minorUnits: 2,
  netTotal: "1000.00",
  origin: "CDG",
  destination: "JFK",
  originCountry: "FR",
  destinationCountry: "US",
  validatingCarriers: ["AF"],
  marketingCarriers: ["AF", "KL"],
  cabins: ["ECONOMY"],
  travelers: { ADULT: 2, CHILD: 1, HELD_INFANT: 0 },
  segmentCount: 2,
  tripType: "round_trip",
  source: "GDS",
  channel: "storefront",
});

function markupRule(id: string, overrides: Partial<MarkupRule> = {}): MarkupRule {
  return {
    id,
    name: id,
    scope: {},
    calculation: "percentage",
    percentage: "1",
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

function feeRule(id: string, overrides: Partial<FeeRule> = {}): FeeRule {
  return {
    ...markupRule(id),
    label: id,
    feeType: "booking_service",
    refundable: false,
    ...overrides,
  };
}

const facts = (input: Partial<PricingInput> = {}, cardBrand: string | null = null) => {
  const merged = { ...INPUT, ...input };
  return offerFacts(merged, new Money(merged.netTotal), cardBrand);
};
const matches = (scope: FeeScope, input: Partial<PricingInput> = {}, cardBrand: string | null = null) =>
  scopeMatches(scope, facts(input, cardBrand));

describe("parseRuleScope", () => {
  it("accepts the empty scope, which matches everything", () => {
    expect(parseRuleScope({}, "markup")).toEqual({ ok: true, scope: {} });
  });

  it("normalises codes to upper case and keeps decimal net bounds", () => {
    const parsed = parseRuleScope(
      {
        origins: [" cdg", "ORY"],
        destinations: ["jfk"],
        originCountries: ["fr"],
        destinationCountries: ["us"],
        carriers: ["af"],
        cabins: ["economy"],
        travelerTypes: ["child"],
        tripTypes: ["round_trip"],
        sources: ["gds"],
        channels: ["storefront"],
        minNet: "100.00",
        maxNet: null,
      },
      "markup",
    );

    expect(parsed).toEqual({
      ok: true,
      scope: {
        origins: ["CDG", "ORY"],
        destinations: ["JFK"],
        originCountries: ["FR"],
        destinationCountries: ["US"],
        carriers: ["AF"],
        cabins: ["ECONOMY"],
        travelerTypes: ["CHILD"],
        tripTypes: ["ROUND_TRIP"],
        sources: ["GDS"],
        channels: ["STOREFRONT"],
        minNet: "100.00",
      },
    });
    expect(parsed.ok && Object.isFrozen(parsed.scope)).toBe(true);
  });

  it("allows cardBrands in fee scopes only", () => {
    expect(parseRuleScope({ cardBrands: ["visa"] }, "fee")).toEqual({
      ok: true,
      scope: { cardBrands: ["VISA"] },
    });
    expect(parseRuleScope({ cardBrands: ["VISA"] }, "markup")).toEqual({
      ok: false,
      reason: 'scope has the unknown field "cardBrands"',
    });
  });

  it.each([
    ["null", null, "scope is not an object"],
    ["an array", ["CDG"], "scope is not an object"],
    ["a string", "{}", "scope is not an object"],
    ["a list field that is a string", { origins: "CDG" }, "scope.origins is not a list of codes"],
    ["a list with a number", { carriers: ["AF", 7] }, "scope.carriers is not a list of codes"],
    ["a list with an empty code", { cabins: [" "] }, "scope.cabins is not a list of codes"],
    ["a net bound that is a number", { minNet: 100 }, "scope.minNet is not a decimal string"],
    ["a net bound with an exponent", { maxNet: "1e3" }, "scope.maxNet is not a decimal string"],
    ["an unknown field", { routes: ["CDG-JFK"] }, 'scope has the unknown field "routes"'],
  ])("refuses %s, so the rule is never applied more broadly than written", (_name, scope, reason) => {
    expect(parseRuleScope(scope, "fee")).toEqual({ ok: false, reason });
  });

  it("shortens a long unknown field name in the reason", () => {
    const parsed = parseRuleScope({ ["x".repeat(100)]: [] }, "markup");

    expect(parsed).toEqual({ ok: false, reason: `scope has the unknown field "${"x".repeat(64)}…"` });
  });
});

describe("isActiveAt", () => {
  const second = 1000;
  const before = new Date(AT.getTime() - second);
  const after = new Date(AT.getTime() + second);

  it.each([
    ["an enabled rule without a window", {}, true],
    ["a disabled rule", { isActive: false }, false],
    ["a window that starts at the instant (inclusive)", { activeFrom: AT }, true],
    ["a window that starts later", { activeFrom: after }, false],
    ["a window that ends at the instant (exclusive)", { activeUntil: AT }, false],
    ["a window that ends later", { activeFrom: before, activeUntil: after }, true],
  ])("%s → %s", (_name, overrides: Partial<MarkupRule>, expected) => {
    expect(isActiveAt(markupRule("mkr_a", overrides), AT)).toBe(expected);
  });
});

describe("compareRules", () => {
  it("orders by priority ascending, then by id", () => {
    const rules = [
      markupRule("mkr_c", { priority: 10 }),
      markupRule("mkr_b", { priority: 5 }),
      markupRule("mkr_a", { priority: 10 }),
    ];

    expect([...rules].sort(compareRules).map((rule) => rule.id)).toEqual(["mkr_b", "mkr_a", "mkr_c"]);
    expect(compareRules(rules[0] as MarkupRule, rules[0] as MarkupRule)).toBe(0);
  });
});

describe("scopeMatches", () => {
  it("matches the empty scope and empty lists", () => {
    expect(matches({})).toBe(true);
    expect(matches({ origins: [], carriers: [] })).toBe(true);
  });

  it.each([
    ["origins", { origins: ["ORY", "CDG"] }, { origins: ["ORY"] }],
    ["destinations", { destinations: ["JFK"] }, { destinations: ["LHR"] }],
    ["originCountries", { originCountries: ["FR"] }, { originCountries: ["GB"] }],
    ["destinationCountries", { destinationCountries: ["US"] }, { destinationCountries: ["GB"] }],
    ["cabins", { cabins: ["ECONOMY", "BUSINESS"] }, { cabins: ["FIRST"] }],
    ["tripTypes", { tripTypes: ["ROUND_TRIP"] }, { tripTypes: ["ONE_WAY"] }],
    ["sources", { sources: ["GDS"] }, { sources: ["NDC"] }],
    ["channels", { channels: ["STOREFRONT"] }, { channels: ["CONSOLE"] }],
  ])("matches %s as an 'any of' list", (_field, listed: FeeScope, notListed: FeeScope) => {
    expect(matches(listed)).toBe(true);
    expect(matches(notListed)).toBe(false);
  });

  it("matches carriers against the validating and the marketing carriers", () => {
    expect(matches({ carriers: ["AF"] })).toBe(true);
    expect(matches({ carriers: ["KL"] })).toBe(true);
    expect(matches({ carriers: ["BA", "LH"] })).toBe(false);
  });

  it("matches traveller types that have at least one traveller", () => {
    expect(matches({ travelerTypes: ["CHILD"] })).toBe(true);
    expect(matches({ travelerTypes: ["HELD_INFANT"] })).toBe(false);
  });

  it("compares codes without regard to case", () => {
    expect(matches({ origins: ["cdg"], channels: ["storefront"] }, { origin: "Cdg" })).toBe(true);
  });

  it("never matches a country list when the airport's country is unknown", () => {
    expect(matches({ originCountries: ["FR"] }, { originCountry: null })).toBe(false);
    expect(matches({}, { originCountry: null })).toBe(true);
  });

  it("requires every non-empty field to match", () => {
    expect(matches({ origins: ["CDG"], destinations: ["JFK"], cabins: ["ECONOMY"] })).toBe(true);
    expect(matches({ origins: ["CDG"], destinations: ["JFK"], cabins: ["BUSINESS"] })).toBe(false);
  });

  it("bounds the net total with minNet and maxNet, both inclusive", () => {
    expect(matches({ minNet: "1000.00", maxNet: "1000" })).toBe(true);
    expect(matches({ minNet: "1000.01" })).toBe(false);
    expect(matches({ maxNet: "999.99" })).toBe(false);
    expect(matches({ minNet: null, maxNet: null })).toBe(true);
  });

  it("matches cardBrands only when the card brand is known and listed", () => {
    expect(matches({ cardBrands: ["VISA"] })).toBe(false);
    expect(matches({ cardBrands: ["VISA"] }, {}, "visa")).toBe(true);
    expect(matches({ cardBrands: ["AMERICAN_EXPRESS"] }, {}, "VISA")).toBe(false);
    expect(matches({}, {}, "VISA")).toBe(true);
  });
});

describe("matchingTravelerCount", () => {
  it("counts every traveller when the scope lists no traveller type", () => {
    expect(matchingTravelerCount({}, INPUT.travelers)).toBe(3);
  });

  it("counts the travellers of the listed types only", () => {
    expect(matchingTravelerCount({ travelerTypes: ["child", "HELD_INFANT"] }, INPUT.travelers)).toBe(1);
    expect(matchingTravelerCount({ travelerTypes: ["ADULT", "CHILD"] }, INPUT.travelers)).toBe(3);
  });
});

describe("selectMarkupRules", () => {
  const ids = (selection: ReturnType<typeof selectMarkupRules>) => ({
    base: selection.base?.id ?? null,
    stacked: selection.stacked.map((rule) => rule.id),
  });

  it("takes the first matching non-stackable rule by priority, then id, as the base", () => {
    const rules = [
      markupRule("mkr_default", { priority: 1000, isDefault: true }),
      markupRule("mkr_b", { priority: 50 }),
      markupRule("mkr_a", { priority: 50 }),
      markupRule("mkr_lhr", { priority: 10, scope: { destinations: ["LHR"] } }),
    ];

    expect(ids(selectMarkupRules(rules, facts()))).toEqual({ base: "mkr_a", stacked: [] });
  });

  it("falls back to the default rule when nothing else matches", () => {
    const rules = [
      markupRule("mkr_lhr", { priority: 10, scope: { destinations: ["LHR"] } }),
      markupRule("mkr_default", { priority: 1000, isDefault: true }),
    ];

    expect(ids(selectMarkupRules(rules, facts()))).toEqual({ base: "mkr_default", stacked: [] });
  });

  it("adds stackable rules with a lower priority number than the base, and only those", () => {
    const rules = [
      markupRule("mkr_base", { priority: 50 }),
      markupRule("mkr_s10", { priority: 10, stackable: true }),
      markupRule("mkr_s20", { priority: 20, stackable: true }),
      markupRule("mkr_s50", { priority: 50, stackable: true }),
      markupRule("mkr_s60", { priority: 60, stackable: true }),
      markupRule("mkr_s5_lhr", { priority: 5, stackable: true, scope: { destinations: ["LHR"] } }),
      markupRule("mkr_s1_off", { priority: 1, stackable: true, isActive: false }),
    ];

    expect(ids(selectMarkupRules(rules, facts()))).toEqual({
      base: "mkr_base",
      stacked: ["mkr_s10", "mkr_s20"],
    });
  });

  it("adds every matching stackable rule when no non-stackable rule matches", () => {
    const rules = [
      markupRule("mkr_s2000", { priority: 2000, stackable: true }),
      markupRule("mkr_s10", { priority: 10, stackable: true }),
      markupRule("mkr_lhr", { priority: 5, scope: { destinations: ["LHR"] } }),
    ];

    expect(ids(selectMarkupRules(rules, facts()))).toEqual({ base: null, stacked: ["mkr_s10", "mkr_s2000"] });
  });

  it("returns no rule for an empty rule list", () => {
    expect(ids(selectMarkupRules([], facts()))).toEqual({ base: null, stacked: [] });
  });
});

describe("selectFeeRule", () => {
  const fees = [
    feeRule("fee_service_lhr", { priority: 10, scope: { destinations: ["LHR"] } }),
    feeRule("fee_service_b", { priority: 20 }),
    feeRule("fee_service_a", { priority: 20 }),
    feeRule("fee_ticketing", { priority: 1, feeType: "ticketing" }),
    feeRule("fee_card_visa", { priority: 10, feeType: "payment_card", scope: { cardBrands: ["VISA"] } }),
    feeRule("fee_card_any", { priority: 20, feeType: "payment_card" }),
  ];

  it("takes the first matching rule of the fee type", () => {
    expect(selectFeeRule(fees, facts(), "booking_service")?.id).toBe("fee_service_a");
    expect(selectFeeRule(fees, facts(), "ticketing")?.id).toBe("fee_ticketing");
  });

  it("matches card brands at the payment_card step only", () => {
    expect(selectFeeRule(fees, facts({}, "VISA"), "payment_card")?.id).toBe("fee_card_visa");
    expect(selectFeeRule(fees, facts({}, "MASTERCARD"), "payment_card")?.id).toBe("fee_card_any");
    expect(selectFeeRule(fees, facts(), "payment_card")?.id).toBe("fee_card_any");
  });

  it("returns null when no rule of the type matches", () => {
    expect(selectFeeRule(fees, facts(), "cancellation")).toBeNull();
  });
});
