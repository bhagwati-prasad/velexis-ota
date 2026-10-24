// The plan of a Stripe subscription (PBE-045; subscription-billing flow §D and "Failure handling", PADR-0002 item 2,
// ADR-0013 point 6): the subscription's one price, mapped back to the plan whose `stripe_price_id_month` or
// `stripe_price_id_year` it is. Stripe is the source of truth of what is charged, so the plan follows the price, and
// `tenants.plan_code` follows the plan (ADR-0013 point 6).
//
// - A Velexis subscription has one item (Checkout makes one line item, PADR-0002 item 3; the Customer Portal swaps the
//   price of that item). A subscription with no item or with several fails the event with `UNSUPPORTED_SUBSCRIPTION`.
// - A price linked to no plan, or to two plans (the month column of one and the year column of another, which the
//   admin's price check warns about), fails the event with `UNKNOWN_PRICE` until a platform admin links it and
//   reprocesses the event (adminReprocessStripeEvent, PBE-048).
// - The interval is the one the price is linked as (`month` or `year`), the only values `subscriptions` allows; a price
//   whose own interval differs from its link is a warning of the admin's price check (PBE-048), not a sync failure.
//
// Both failures are final for the event (`retryable: false`): retrying cannot link a price. Retired and non-public plans
// count: a tenant keeps a legacy plan's price until it changes plan.
import { Injectable } from "@nestjs/common";
import type Stripe from "stripe";
import type { PlatformTransaction } from "../../audit/audit.repository";
import { StripeEventFailure } from "../../common/stripe/stripe-inbox.service";
import { PlansRepository, type PlanPriceLinkRow } from "../plans.repository";

/** The billing intervals a plan links a price for. */
export type PlanInterval = "month" | "year";

/** The plan and interval a price is linked as. */
export interface PlanOfPrice {
  readonly planCode: string;
  readonly interval: PlanInterval;
}

/** What `planOfPrice` found: the one plan of the price, or why there is none. */
export type PriceMapping =
  | ({ readonly kind: "plan" } & PlanOfPrice)
  | { readonly kind: "unknown" }
  | { readonly kind: "ambiguous"; readonly planCodes: readonly string[] };

/** The plan links of `links` that name `priceId`, as `{planCode, interval}`. */
function linksOf(priceId: string, links: readonly PlanPriceLinkRow[]): PlanOfPrice[] {
  const found: PlanOfPrice[] = [];
  for (const link of links) {
    if (link.stripe_price_id_month === priceId) {
      found.push({ planCode: link.code, interval: "month" });
    }
    if (link.stripe_price_id_year === priceId) {
      found.push({ planCode: link.code, interval: "year" });
    }
  }
  return found;
}

/**
 * The plan of the Stripe Price `priceId` among the plans' `links`: `plan` when exactly one link names it, `unknown`
 * when none does, `ambiguous` when several do (the plans' codes, sorted).
 */
export function planOfPrice(priceId: string, links: readonly PlanPriceLinkRow[]): PriceMapping {
  const found = linksOf(priceId, links);
  const [only] = found;
  if (only === undefined) {
    return { kind: "unknown" };
  }
  if (found.length > 1) {
    return { kind: "ambiguous", planCodes: [...new Set(found.map((link) => link.planCode))].sort() };
  }
  return { kind: "plan", ...only };
}

/** The price of a subscription's items: its id when there is exactly one item, else `undefined`. */
export function priceIdOf(subscription: Pick<Stripe.Subscription, "items">): string | undefined {
  const items = subscription.items.data;
  if (items.length !== 1) {
    return undefined;
  }
  const price: unknown = items[0]?.price;
  if (typeof price === "string") {
    return price;
  }
  const id: unknown =
    typeof price === "object" && price !== null ? (price as { id?: unknown }).id : undefined;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** A Stripe Price id as the `plans` columns allow it (`price_` and letters and digits). */
const PRICE_ID = /^price_[A-Za-z0-9]+$/;

/** The price and the plan of a Stripe subscription. */
export interface SubscriptionPlan extends PlanOfPrice {
  /** `price_…`. */
  readonly priceId: string;
}

@Injectable()
export class PriceToPlan {
  constructor(private readonly plans: PlansRepository) {}

  /**
   * The price of `subscription` and its plan, read in `trx`. Throws StripeEventFailure (not retryable, resolved to
   * `tenantId`): `UNSUPPORTED_SUBSCRIPTION` for a subscription without exactly one item, `UNKNOWN_PRICE` for a price
   * linked to no plan or to several.
   */
  async planOf(
    trx: PlatformTransaction,
    subscription: Pick<Stripe.Subscription, "id" | "items">,
    tenantId: string,
  ): Promise<SubscriptionPlan> {
    const priceId = priceIdOf(subscription);
    if (priceId === undefined) {
      throw new StripeEventFailure(
        "UNSUPPORTED_SUBSCRIPTION",
        `${subscription.items.data.length} items on the subscription; a Velexis subscription has one`,
        { retryable: false, tenantId },
      );
    }
    // The id is quoted in `last_error` only when it has Stripe's shape, so the message never carries anything else.
    const shown = PRICE_ID.test(priceId) ? priceId : "the subscription's price";
    const mapping = PRICE_ID.test(priceId)
      ? planOfPrice(priceId, await this.plans.findByStripePrice(priceId, trx))
      : ({ kind: "unknown" } as const);
    if (mapping.kind === "unknown") {
      throw new StripeEventFailure("UNKNOWN_PRICE", `${shown} is linked to no plan`, {
        retryable: false,
        tenantId,
      });
    }
    if (mapping.kind === "ambiguous") {
      throw new StripeEventFailure(
        "UNKNOWN_PRICE",
        `${shown} is linked to more than one plan (${mapping.planCodes.join(", ")})`,
        { retryable: false, tenantId },
      );
    }
    return { priceId, planCode: mapping.planCode, interval: mapping.interval };
  }
}
