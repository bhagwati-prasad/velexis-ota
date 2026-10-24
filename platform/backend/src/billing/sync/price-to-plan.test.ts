// The plan of a Stripe subscription (PBE-045; subscription-billing flow §D and "Failure handling", PADR-0002 item 2):
// the price of its one item mapped back to the plan it is linked to, and the failures of an unlinked price or a
// subscription of another shape. The read of the links runs against PostgreSQL in billing-events.int.test.ts.
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import type { PlatformTransaction } from "../../audit/audit.repository";
import { StripeEventFailure } from "../../common/stripe/stripe-inbox.service";
import type { PlanPriceLinkRow, PlansRepository } from "../plans.repository";
import { planOfPrice, priceIdOf, PriceToPlan } from "./price-to-plan";

const LINKS: PlanPriceLinkRow[] = [
  { code: "starter", stripe_price_id_month: "price_StarterMonth", stripe_price_id_year: "price_StarterYear" },
  { code: "growth", stripe_price_id_month: "price_GrowthMonth", stripe_price_id_year: null },
  { code: "legacy", stripe_price_id_month: null, stripe_price_id_year: null },
];

/** A subscription with one item per price (a price object, as Stripe expands it, or a bare id). */
function subscriptionOf(
  ...prices: Array<string | { id: string }>
): Pick<Stripe.Subscription, "id" | "items"> {
  return {
    id: "sub_TestPbe045",
    items: {
      object: "list",
      data: prices.map((price) => ({ price }) as unknown as Stripe.SubscriptionItem),
      has_more: false,
      url: "/v1/subscription_items",
    },
  };
}

const TRX = {} as PlatformTransaction;
const TENANT_ID = "ten_01JB0000000000000000000045";

/** PriceToPlan over a repository that answers the links of `LINKS` that name the price. */
function priceToPlan(links: readonly PlanPriceLinkRow[] = LINKS): PriceToPlan {
  const plans = {
    findByStripePrice: (priceId: string) =>
      Promise.resolve(
        links.filter(
          (link) => link.stripe_price_id_month === priceId || link.stripe_price_id_year === priceId,
        ),
      ),
  } as unknown as PlansRepository;
  return new PriceToPlan(plans);
}

describe("planOfPrice", () => {
  it("maps a monthly and a yearly price to their plan and interval", () => {
    expect(planOfPrice("price_StarterMonth", LINKS)).toEqual({
      kind: "plan",
      planCode: "starter",
      interval: "month",
    });
    expect(planOfPrice("price_StarterYear", LINKS)).toEqual({
      kind: "plan",
      planCode: "starter",
      interval: "year",
    });
    expect(planOfPrice("price_GrowthMonth", LINKS)).toEqual({
      kind: "plan",
      planCode: "growth",
      interval: "month",
    });
  });

  it("knows no plan for a price nobody linked", () => {
    expect(planOfPrice("price_Unlinked", LINKS)).toEqual({ kind: "unknown" });
    expect(planOfPrice("price_Unlinked", [])).toEqual({ kind: "unknown" });
  });

  it("refuses to choose between two plans that link the same price", () => {
    const links: PlanPriceLinkRow[] = [
      { code: "zeta", stripe_price_id_month: "price_Shared", stripe_price_id_year: null },
      { code: "alpha", stripe_price_id_month: null, stripe_price_id_year: "price_Shared" },
    ];
    expect(planOfPrice("price_Shared", links)).toEqual({ kind: "ambiguous", planCodes: ["alpha", "zeta"] });
  });
});

describe("priceIdOf", () => {
  it("reads the price of the one item, expanded or not", () => {
    expect(priceIdOf(subscriptionOf({ id: "price_StarterMonth" }))).toBe("price_StarterMonth");
    expect(priceIdOf(subscriptionOf("price_StarterYear"))).toBe("price_StarterYear");
  });

  it("has no price for a subscription without exactly one item", () => {
    expect(priceIdOf(subscriptionOf())).toBeUndefined();
    expect(
      priceIdOf(subscriptionOf({ id: "price_StarterMonth" }, { id: "price_GrowthMonth" })),
    ).toBeUndefined();
  });
});

describe("PriceToPlan.planOf", () => {
  it("answers the price, the plan and the interval", async () => {
    await expect(
      priceToPlan().planOf(TRX, subscriptionOf({ id: "price_StarterYear" }), TENANT_ID),
    ).resolves.toEqual({
      priceId: "price_StarterYear",
      planCode: "starter",
      interval: "year",
    });
  });

  it("[PBE-045] fails an unlinked price for good with UNKNOWN_PRICE, resolved to the tenant", async () => {
    const failure = await priceToPlan()
      .planOf(TRX, subscriptionOf({ id: "price_Unlinked" }), TENANT_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StripeEventFailure);
    expect(failure).toMatchObject({
      code: "UNKNOWN_PRICE",
      message: "price_Unlinked is linked to no plan",
      options: { retryable: false, tenantId: TENANT_ID },
    });
  });

  it("fails a price linked to two plans with UNKNOWN_PRICE, naming the plans", async () => {
    const links: PlanPriceLinkRow[] = [
      { code: "growth", stripe_price_id_month: "price_Shared", stripe_price_id_year: null },
      { code: "starter", stripe_price_id_month: null, stripe_price_id_year: "price_Shared" },
    ];

    await expect(
      priceToPlan(links).planOf(TRX, subscriptionOf({ id: "price_Shared" }), TENANT_ID),
    ).rejects.toMatchObject({
      code: "UNKNOWN_PRICE",
      message: "price_Shared is linked to more than one plan (growth, starter)",
      options: { retryable: false },
    });
  });

  it("fails a price id of another shape without quoting it, and a subscription of several items", async () => {
    await expect(
      priceToPlan().planOf(TRX, subscriptionOf({ id: "price_with spaces; and more" }), TENANT_ID),
    ).rejects.toMatchObject({
      code: "UNKNOWN_PRICE",
      message: "the subscription's price is linked to no plan",
    });
    await expect(
      priceToPlan().planOf(
        TRX,
        subscriptionOf({ id: "price_StarterMonth" }, { id: "price_GrowthMonth" }),
        TENANT_ID,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_SUBSCRIPTION",
      message: "2 items on the subscription; a Velexis subscription has one",
      options: { retryable: false, tenantId: TENANT_ID },
    });
  });
});
