// The comparison of a plan with its Stripe prices without a database (PBE-048; subscription-billing flow §A item 2,
// PADR-0002 item 2, scope PF-88): the warnings of each attribute as a table (amount in the minor unit of the plan's
// currency with its exponent, currency, interval, active), a price Stripe does not know, the view of a retrieved Stripe
// Price, and what PriceCheck asks Stripe and answers when it fails, over the FakeStripe of test/support/fake-stripe.ts
// and a stand-in of the currencies' exponents. test/integration/admin/admin-billing.int.test.ts runs the same rules
// through adminUpdatePlan and adminCheckPlanPrices.
import { isAppError } from "@velexis/errors";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { FakeStripe } from "../../test/support/fake-stripe";
import type { PlansRepository } from "./plans.repository";
import {
  comparePlanPrices,
  linkedPrices,
  PriceCheck,
  priceViewOf,
  type PlanPriceTerms,
  type StripePriceView,
} from "./price-check";

const MONTH = "price_TestPbe048Month";
const YEAR = "price_TestPbe048Year";

/** A plan of 149.00 EUR a month and 1490.00 a year, linked to MONTH and YEAR. */
const PLAN: PlanPriceTerms = Object.freeze({
  currency: "EUR",
  monthlyPrice: "149.00",
  annualPrice: "1490.00",
  stripePriceIdMonth: MONTH,
  stripePriceIdYear: YEAR,
});

/** The monthly and the yearly price that agree with PLAN. */
const MONTH_VIEW: StripePriceView = Object.freeze({
  active: true,
  currency: "EUR",
  unitAmount: "14900",
  interval: "month",
  intervalCount: 1,
});
const YEAR_VIEW: StripePriceView = Object.freeze({
  active: true,
  currency: "EUR",
  unitAmount: "149000",
  interval: "year",
  intervalCount: 1,
});

/** The retrieved prices: MONTH_VIEW and YEAR_VIEW with `month` and `year` laid over them. */
function prices(
  month: Partial<StripePriceView> | null = {},
  year: Partial<StripePriceView> | null = {},
): Map<string, StripePriceView | null> {
  return new Map<string, StripePriceView | null>([
    [MONTH, month === null ? null : { ...MONTH_VIEW, ...month }],
    [YEAR, year === null ? null : { ...YEAR_VIEW, ...year }],
  ]);
}

/** The recurring part of a Stripe Price billed every `interval`. */
function recurring(interval: Stripe.Price.Recurring.Interval): Stripe.Price.Recurring {
  return { interval, interval_count: 1, meter: null, trial_period_days: null, usage_type: "licensed" };
}

/** A Stripe Price as the SDK answers `prices.retrieve`. */
function stripePrice(id: string, overrides: Partial<Stripe.Price> = {}): Stripe.Price & { id: string } {
  return {
    id,
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created: 1_767_225_600,
    currency: "eur",
    custom_unit_amount: null,
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: null,
    product: "prod_TestPbe048",
    recurring: recurring("month"),
    tax_behavior: "exclusive",
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: 14900,
    unit_amount_decimal: "14900",
    ...overrides,
  } as Stripe.Price & { id: string };
}

/** A stand-in of the plans' repository that knows the exponents of EUR, JPY and KWD. */
const EXPONENTS = { EUR: 2, JPY: 0, KWD: 3 } as Record<string, number>;
const plansWithExponents = {
  currencyExponent: (currency: string) => Promise.resolve(EXPONENTS[currency]),
} as unknown as PlansRepository;

describe("comparePlanPrices", () => {
  it("[PBE-048 AC1] answers no warning when every linked price agrees with the plan", () => {
    expect(comparePlanPrices(PLAN, prices(), 2)).toEqual([]);
  });

  it("[PBE-048 AC1] warns about a price of another currency, and only about the currency when its amount is the same", () => {
    expect(comparePlanPrices(PLAN, prices({ currency: "USD" }), 2)).toEqual([
      { field: "stripePriceIdMonth.currency", expected: "EUR", actual: "USD" },
    ]);
  });

  it.each([
    {
      name: "a monthly amount of 159.00 instead of 149.00",
      month: { unitAmount: "15900" },
      year: {},
      warnings: [{ field: "stripePriceIdMonth.amount", expected: "149.00", actual: "159.00" }],
    },
    {
      name: "a yearly price billed monthly",
      month: {},
      year: { interval: "month" },
      warnings: [{ field: "stripePriceIdYear.interval", expected: "year", actual: "month" }],
    },
    {
      name: "a monthly price billed every 3 months",
      month: { intervalCount: 3 },
      year: {},
      warnings: [{ field: "stripePriceIdMonth.interval", expected: "month", actual: "3 month" }],
    },
    {
      name: "a one-time price",
      month: { interval: null, intervalCount: null },
      year: {},
      warnings: [{ field: "stripePriceIdMonth.interval", expected: "month", actual: null }],
    },
    {
      name: "an archived yearly price",
      month: {},
      year: { active: false },
      warnings: [{ field: "stripePriceIdYear.active", expected: "true", actual: "false" }],
    },
    {
      name: "a tiered price without a unit amount",
      month: { unitAmount: null },
      year: {},
      warnings: [{ field: "stripePriceIdMonth.amount", expected: "149.00", actual: null }],
    },
    {
      name: "a monthly price that Stripe does not know",
      month: null,
      year: {},
      warnings: [{ field: "stripePriceIdMonth.active", expected: "true", actual: null }],
    },
    {
      name: "every attribute of the monthly price",
      month: { unitAmount: "990", currency: "USD", interval: "year", active: false },
      year: {},
      warnings: [
        { field: "stripePriceIdMonth.amount", expected: "149.00", actual: "9.90" },
        { field: "stripePriceIdMonth.currency", expected: "EUR", actual: "USD" },
        { field: "stripePriceIdMonth.interval", expected: "month", actual: "year" },
        { field: "stripePriceIdMonth.active", expected: "true", actual: "false" },
      ],
    },
  ])("[PBE-048 AC1] warns about $name", ({ month, year, warnings }) => {
    expect(comparePlanPrices(PLAN, prices(month, year), 2)).toEqual(warnings);
  });

  it("compares the amount in the minor unit of the plan's currency: 5000 JPY is 5000 minor units", () => {
    const yen: PlanPriceTerms = {
      ...PLAN,
      currency: "JPY",
      monthlyPrice: "5000.00",
      stripePriceIdYear: null,
    };
    const answer = new Map([[MONTH, { ...MONTH_VIEW, currency: "JPY", unitAmount: "5000" }]]);
    expect(comparePlanPrices(yen, answer, 0)).toEqual([]);
    const other = new Map([[MONTH, { ...MONTH_VIEW, currency: "JPY", unitAmount: "500000" }]]);
    expect(comparePlanPrices(yen, other, 0)).toEqual([
      { field: "stripePriceIdMonth.amount", expected: "5000", actual: "500000" },
    ]);
  });

  it("compares fractional minor units exactly, never as JavaScript numbers", () => {
    const answer = prices({ unitAmount: "14900.0000000001" });
    expect(comparePlanPrices(PLAN, answer, 2)).toEqual([
      { field: "stripePriceIdMonth.amount", expected: "149.00", actual: "149.000000000001" },
    ]);
  });

  it("warns about a yearly price of a plan without a yearly option, whose expected amount is null", () => {
    const monthly: PlanPriceTerms = { ...PLAN, annualPrice: null };
    expect(comparePlanPrices(monthly, prices(), 2)).toEqual([
      { field: "stripePriceIdYear.amount", expected: null, actual: "1490.00" },
    ]);
  });

  it("answers no warning for a plan without a linked price", () => {
    const unlinked: PlanPriceTerms = { ...PLAN, stripePriceIdMonth: null, stripePriceIdYear: null };
    expect(linkedPrices(unlinked)).toEqual([]);
    expect(comparePlanPrices(unlinked, new Map(), 2)).toEqual([]);
  });
});

describe("priceViewOf", () => {
  it("reads Stripe's amount in the minor unit, its currency in upper case and its interval", () => {
    expect(priceViewOf(stripePrice(MONTH))).toEqual(MONTH_VIEW);
  });

  it("reads `unit_amount_decimal` when Stripe gives no whole `unit_amount`, and nothing for a tiered price", () => {
    expect(
      priceViewOf(stripePrice(MONTH, { unit_amount: null, unit_amount_decimal: "14900.5" })).unitAmount,
    ).toBe("14900.5");
    expect(
      priceViewOf(
        stripePrice(MONTH, { unit_amount: null, unit_amount_decimal: null, billing_scheme: "tiered" }),
      ).unitAmount,
    ).toBeNull();
  });

  it("reads a one-time price without an interval", () => {
    expect(priceViewOf(stripePrice(MONTH, { recurring: null, type: "one_time" }))).toMatchObject({
      interval: null,
      intervalCount: null,
    });
  });
});

describe("PriceCheck", () => {
  it("[PBE-048 AC1] retrieves each linked price once and answers the warnings", async () => {
    const stripe = new FakeStripe();
    stripe.put(stripePrice(MONTH, { currency: "usd" }));
    const check = new PriceCheck(stripe, plansWithExponents);
    const linkedTwice: PlanPriceTerms = { ...PLAN, stripePriceIdYear: MONTH };
    expect(await check.compare(linkedTwice)).toEqual([
      { field: "stripePriceIdMonth.currency", expected: "EUR", actual: "USD" },
      { field: "stripePriceIdYear.amount", expected: "1490.00", actual: "149.00" },
      { field: "stripePriceIdYear.currency", expected: "EUR", actual: "USD" },
      { field: "stripePriceIdYear.interval", expected: "year", actual: "month" },
    ]);
    expect(stripe.callsOf("prices.retrieve").map((call) => call.id)).toEqual([MONTH]);
  });

  it("calls nothing for a plan without a linked price", async () => {
    const stripe = new FakeStripe();
    const check = new PriceCheck(stripe, plansWithExponents);
    expect(await check.compare({ ...PLAN, stripePriceIdMonth: null, stripePriceIdYear: null })).toEqual([]);
    expect(stripe.calls).toEqual([]);
  });

  it("answers the `active` warning for a price Stripe does not know (404)", async () => {
    const stripe = new FakeStripe();
    stripe.put(stripePrice(YEAR, { unit_amount: 149000, recurring: recurring("year") }));
    const check = new PriceCheck(stripe, plansWithExponents);
    expect(await check.compare(PLAN)).toEqual([
      { field: "stripePriceIdMonth.active", expected: "true", actual: null },
    ]);
  });

  it.each([
    { name: "a 5xx", error: FakeStripe.apiError(503) },
    { name: "no answer", error: FakeStripe.connectionError() },
    { name: "a rate limit", error: FakeStripe.apiError(429) },
  ])("throws 502 PROVIDER_ERROR when Stripe fails with $name", async ({ error }) => {
    const stripe = new FakeStripe();
    stripe.put(stripePrice(MONTH)).failNext("prices.retrieve", error);
    const check = new PriceCheck(stripe, plansWithExponents);
    const failure = await check.compare(PLAN).catch((caught: unknown) => caught);
    expect(isAppError(failure) && failure.code).toBe("PROVIDER_ERROR");
    expect(isAppError(failure) && failure.details).toEqual({ provider: "stripe" });
  });

  it("throws 502 PROVIDER_ERROR without STRIPE_SECRET_KEY", async () => {
    const check = new PriceCheck(new FakeStripe().notConfigured(), plansWithExponents);
    const failure = await check.compare(PLAN).catch((caught: unknown) => caught);
    expect(isAppError(failure) && failure.code).toBe("PROVIDER_ERROR");
  });
});
