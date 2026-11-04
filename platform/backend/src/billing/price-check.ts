// The comparison of a plan with its Stripe prices (PBE-048; subscription-billing flow §A item 2, PADR-0002 item 2,
// platform/docs/api-inventory-admin.md §4, scope PF-88): `adminUpdatePlan`, when it links or changes a price or changes
// a price of a plan with a linked one, and `adminCheckPlanPrices` retrieve every Stripe Price the plan links
// (`prices.retrieve`, before any transaction: architecture §2.3) and answer one warning per difference. Stripe is the
// source of truth of what is charged; the warnings show where the plan says something else, and never block a save.
//
// For each linked price, in the order month then year, and for each price in the order of the attributes:
//
//   amount    the plan's price for the interval (`monthly_price`, `annual_price`; `null` when the plan has no yearly
//             option) against the price's `unit_amount`, both in the minor unit of the plan's currency with that
//             currency's exponent from `reference.currencies` (2 for EUR, 0 for JPY; never Stripe's own list), compared
//             exactly with decimal.js; `unit_amount_decimal` when Stripe gives no whole `unit_amount`, and `null` for a
//             price without a unit amount (tiered, or chosen by the customer). Shown as decimal strings with the
//             currency's decimals (`"149.00"`, `"5000"`), never JavaScript numbers (conventions §1).
//   currency  the plan's currency against the price's (upper case: Stripe answers `eur`).
//   interval  `month` for `stripePriceIdMonth`, `year` for `stripePriceIdYear`, against the price's `recurring.interval`
//             (`"3 month"` when its `interval_count` is not 1; `null` for a one-time price).
//   active    `"true"` against the price's `active`. A price Stripe does not know (404 `resource_missing`, for example
//             one of the other mode) answers this warning alone, with `actual: null`.
//
// Warnings are `{field, expected, actual}` (`PlanPriceWarning`): `field` is `<link>.<attribute>`, for example
// `stripePriceIdMonth.currency`. A price linked as both month and year is retrieved once. A Stripe failure (5xx, no
// answer, a rate limit, a refused key, STRIPE_SECRET_KEY unset) throws `502 PROVIDER_ERROR` (`details.provider =
// stripe`), so the caller saves nothing. Nothing here logs; a price carries no personal data.
import { Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { Decimal } from "decimal.js";
import Stripe from "stripe";
import { PlatformMoney, STORED_DECIMALS } from "../common/money";
import { StripeClient, StripeNotConfiguredError } from "../common/stripe/stripe.client";
import { PlansRepository } from "./plans.repository";
import { providerError, stripeBillingFailureOf } from "./stripe-billing.gateway";

export type PlanPriceWarning = components["schemas"]["PlanPriceWarning"];

/** The two price links of a plan, in the order of the warnings. */
export const PRICE_LINKS = Object.freeze(["stripePriceIdMonth", "stripePriceIdYear"] as const);
export type PriceLink = (typeof PRICE_LINKS)[number];

/** The interval each link stands for. */
const LINK_INTERVAL: Readonly<Record<PriceLink, "month" | "year">> = Object.freeze({
  stripePriceIdMonth: "month",
  stripePriceIdYear: "year",
});

/** What the comparison reads of a plan. */
export interface PlanPriceTerms {
  /** ISO 4217, upper case. */
  readonly currency: string;
  /** The `numeric(12,2)` text of `monthly_price` (`"149.00"`). */
  readonly monthlyPrice: string;
  /** The `numeric(12,2)` text of `annual_price`; `null` when the plan has no yearly option. */
  readonly annualPrice: string | null;
  readonly stripePriceIdMonth: string | null;
  readonly stripePriceIdYear: string | null;
}

/** What the comparison reads of a Stripe Price. */
export interface StripePriceView {
  readonly active: boolean;
  /** ISO 4217, upper case. */
  readonly currency: string;
  /** The amount in the minor unit, as a decimal string; `null` when the price has none (tiered, customer's choice). */
  readonly unitAmount: string | null;
  /** `month`, `year`, `week` or `day`; `null` for a one-time price. */
  readonly interval: string | null;
  /** How many intervals a period lasts; `null` for a one-time price. */
  readonly intervalCount: number | null;
}

/** A decimal string of a minor-unit amount (Stripe's `unit_amount_decimal`: `"4900"`, `"4900.5"`). */
const DECIMAL_STRING = /^\d+(?:\.\d+)?$/;

/** The StripePriceView of a retrieved Stripe Price. */
export function priceViewOf(price: Stripe.Price): StripePriceView {
  const whole = price.unit_amount;
  const decimal = price.unit_amount_decimal;
  const unitAmount =
    typeof whole === "number" && Number.isSafeInteger(whole)
      ? String(whole)
      : typeof decimal === "string" && DECIMAL_STRING.test(decimal)
        ? decimal
        : null;
  return {
    active: price.active,
    currency: price.currency.toUpperCase(),
    unitAmount,
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? null,
  };
}

/** The linked prices of `terms`, in the order of PRICE_LINKS. */
export function linkedPrices(
  terms: Pick<PlanPriceTerms, PriceLink>,
): Array<{ readonly link: PriceLink; readonly priceId: string }> {
  const links: Array<{ readonly link: PriceLink; readonly priceId: string }> = [];
  for (const link of PRICE_LINKS) {
    const priceId = terms[link];
    if (priceId !== null) {
      links.push({ link, priceId });
    }
  }
  return links;
}

/** `minor` (a value in the minor unit) as a decimal string with at least `exponent` decimals (`4900`, 2 → `"49.00"`). */
function majorOf(minor: Decimal, exponent: number): string {
  const value = minor.dividedBy(new PlatformMoney(10).pow(exponent));
  return value.toFixed(Math.max(exponent, value.decimalPlaces()));
}

/** The interval of a price as a warning shows it: `month`, `3 month`, or `null` for a one-time price. */
function intervalOf(price: StripePriceView): string | null {
  if (price.interval === null) {
    return null;
  }
  return price.intervalCount === null || price.intervalCount === 1
    ? price.interval
    : `${price.intervalCount} ${price.interval}`;
}

/** The warnings of one linked price (see the file header). */
function warningsOf(
  link: PriceLink,
  terms: PlanPriceTerms,
  price: StripePriceView | null,
  exponent: number,
): PlanPriceWarning[] {
  const field = (attribute: string): string => `${link}.${attribute}`;
  if (price === null) {
    return [{ field: field("active"), expected: "true", actual: null }];
  }
  const warnings: PlanPriceWarning[] = [];

  const planAmount = link === "stripePriceIdMonth" ? terms.monthlyPrice : terms.annualPrice;
  const scale = new PlatformMoney(10).pow(exponent);
  const expectedMinor = planAmount === null ? null : new PlatformMoney(planAmount).times(scale);
  const actualMinor = price.unitAmount === null ? null : new PlatformMoney(price.unitAmount);
  const sameAmount =
    expectedMinor === null || actualMinor === null
      ? expectedMinor === actualMinor
      : expectedMinor.equals(actualMinor);
  if (!sameAmount) {
    warnings.push({
      field: field("amount"),
      expected: expectedMinor === null ? null : majorOf(expectedMinor, exponent),
      actual: actualMinor === null ? null : majorOf(actualMinor, exponent),
    });
  }
  if (price.currency !== terms.currency) {
    warnings.push({ field: field("currency"), expected: terms.currency, actual: price.currency });
  }
  const interval = intervalOf(price);
  if (interval !== LINK_INTERVAL[link]) {
    warnings.push({ field: field("interval"), expected: LINK_INTERVAL[link], actual: interval });
  }
  if (!price.active) {
    warnings.push({ field: field("active"), expected: "true", actual: "false" });
  }
  return warnings;
}

/**
 * The warnings of the plan `terms` against the retrieved `prices` (by price id; `null` for a price Stripe does not
 * know), with `exponent` the plan currency's exponent from `reference.currencies` (see the file header). Empty when
 * they agree or no price is linked.
 */
export function comparePlanPrices(
  terms: PlanPriceTerms,
  prices: ReadonlyMap<string, StripePriceView | null>,
  exponent: number,
): PlanPriceWarning[] {
  return linkedPrices(terms).flatMap(({ link, priceId }) => {
    const price = prices.get(priceId);
    if (price === undefined) {
      throw new Error(`comparePlanPrices: the price ${priceId} was not retrieved`);
    }
    return warningsOf(link, terms, price, exponent);
  });
}

/** True for the SDK's answer to a price Stripe does not have: 404 `resource_missing`. */
function isMissingPrice(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeInvalidRequestError &&
    (error.statusCode === 404 || error.code === "resource_missing")
  );
}

/** The comparison with the prices retrieved from Stripe (see the file header). */
@Injectable()
export class PriceCheck {
  constructor(
    private readonly stripe: StripeClient,
    private readonly plans: PlansRepository,
  ) {}

  /**
   * Retrieves every price `terms` links and answers the warnings; calls nothing when no price is linked. Throws
   * `502 PROVIDER_ERROR` when Stripe fails. Never call it inside a transaction (architecture §2.3).
   */
  async compare(terms: PlanPriceTerms): Promise<PlanPriceWarning[]> {
    const links = linkedPrices(terms);
    if (links.length === 0) {
      return [];
    }
    const prices = new Map<string, StripePriceView | null>();
    for (const { priceId } of links) {
      if (!prices.has(priceId)) {
        prices.set(priceId, await this.retrieve(priceId));
      }
    }
    // The plan's currency is one of `reference.currencies` (adminCreatePlan checks it); two decimals otherwise, as the
    // `numeric(12,2)` columns hold.
    const exponent = (await this.plans.currencyExponent(terms.currency)) ?? STORED_DECIMALS;
    return comparePlanPrices(terms, prices, exponent);
  }

  /** The Stripe Price `priceId`, `null` when Stripe does not know it; `502 PROVIDER_ERROR` for any other failure. */
  private async retrieve(priceId: string): Promise<StripePriceView | null> {
    try {
      return priceViewOf(await this.stripe.api().prices.retrieve(priceId));
    } catch (error) {
      if (isMissingPrice(error)) {
        return null;
      }
      if (error instanceof Stripe.errors.StripeError || error instanceof StripeNotConfiguredError) {
        throw providerError(stripeBillingFailureOf("prices.retrieve", error));
      }
      throw error;
    }
  }
}
