// What billing sync copies of a Stripe subscription into its row (PBE-045; subscription-billing flow §D, PADR-0002
// item 5), on the X-028 fixture of `customer.subscription.updated`: the state, when a write changes the row, the audit
// view of a change, the Velexis metadata and billing sync's actor. The handlers run against PostgreSQL, Redis and the
// FakeStripe in test/integration/billing/billing-events.int.test.ts.
import { stripeFixture } from "@velexis/testing/stripe";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { StripeEventFailure } from "../../../common/stripe/stripe-inbox.service";
import type { StripeSubscriptionRecord } from "../../subscriptions.repository";
import type { SubscriptionPlan } from "../price-to-plan";
import {
  billingSyncActor,
  changedFields,
  stateDiffers,
  stripeIdOf,
  subscriptionStateOf,
  velexisSubscriptionIdOf,
  velexisTenantIdOf,
} from "./subscription-changed.handler";

const TENANT_ID = "ten_01JB00000000000000000000T1";
const ROW_ID = "sub_01JB00000000000000000000S1";
const PLAN: SubscriptionPlan = { priceId: "price_TestGrowthMonth", planCode: "growth", interval: "month" };

/** The fixture's subscription, with a Customer id of the shape `billing_customers` allows, and `changes`. */
function subscription(changes: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    ...stripeFixture("customer.subscription.updated").data.object,
    customer: "cus_TestAlpha",
    ...changes,
  };
}

const at = (seconds: number): Date => new Date(seconds * 1000);

/** The row of the fixture's subscription as billing sync writes it. */
function rowOf(changes: Partial<StripeSubscriptionRecord> = {}): StripeSubscriptionRecord {
  return {
    id: ROW_ID,
    tenant_id: TENANT_ID,
    plan_code: "growth",
    status: "active",
    billing_provider: "stripe",
    billing_interval: "month",
    provider_customer_id: "cus_TestAlpha",
    provider_subscription_id: "sub_test_alpha_1",
    provider_price_id: "price_TestGrowthMonth",
    trial_ends_at: null,
    current_period_start: at(1791795895),
    current_period_end: at(1794474295),
    cancel_at_period_end: true,
    canceled_at: at(1792402200),
    checkout_session_id: "cs_test_alpha_1",
    version: 2,
    ...changes,
  };
}

describe("subscriptionStateOf", () => {
  it("copies status, ids, plan, interval, the item's period, trial end and the cancellation", () => {
    expect(subscriptionStateOf(subscription(), PLAN, TENANT_ID)).toEqual({
      status: "active",
      planCode: "growth",
      billingInterval: "month",
      providerCustomerId: "cus_TestAlpha",
      providerSubscriptionId: "sub_test_alpha_1",
      providerPriceId: "price_TestGrowthMonth",
      trialEndsAt: null,
      currentPeriodStart: at(1791795895),
      currentPeriodEnd: at(1794474295),
      cancelAtPeriodEnd: true,
      canceledAt: at(1792402200),
    });
  });

  it("reads an expanded Customer and a trial end", () => {
    const state = subscriptionStateOf(
      subscription({
        status: "trialing",
        trial_end: 1792400000,
        customer: { id: "cus_TestExpanded" } as Stripe.Customer,
        cancel_at_period_end: false,
        canceled_at: null,
      }),
      PLAN,
      TENANT_ID,
    );

    expect(state).toMatchObject({
      status: "trialing",
      providerCustomerId: "cus_TestExpanded",
      trialEndsAt: at(1792400000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
  });

  it("fails for good on a status Velexis does not store and on a Customer of another shape", () => {
    const unknownStatus = subscription({ status: "frozen" as Stripe.Subscription.Status });
    expect(() => subscriptionStateOf(unknownStatus, PLAN, TENANT_ID)).toThrow(StripeEventFailure);
    expect(() => subscriptionStateOf(unknownStatus, PLAN, TENANT_ID)).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_SUBSCRIPTION",
        options: { retryable: false, tenantId: TENANT_ID },
      }),
    );
    expect(() => subscriptionStateOf(subscription({ customer: "cus_test_alpha" }), PLAN, TENANT_ID)).toThrow(
      expect.objectContaining({ code: "INVALID_CUSTOMER" }),
    );
  });
});

describe("stateDiffers and changedFields", () => {
  const state = subscriptionStateOf(subscription(), PLAN, TENANT_ID);

  it("[PBE-045 AC1] finds no change when the row holds the subscription already (a duplicate event)", () => {
    expect(stateDiffers(rowOf(), state, null)).toBe(false);
    expect(stateDiffers(rowOf(), state, "cs_test_alpha_1")).toBe(false);
  });

  it("finds a change of status, period, plan or Checkout Session", () => {
    expect(stateDiffers(rowOf({ status: "past_due" }), state, null)).toBe(true);
    expect(stateDiffers(rowOf({ current_period_end: at(1794474296) }), state, null)).toBe(true);
    expect(stateDiffers(rowOf({ plan_code: "starter" }), state, null)).toBe(true);
    expect(stateDiffers(rowOf({ checkout_session_id: null }), state, "cs_test_alpha_1")).toBe(true);
    // `null` keeps the stored Session.
    expect(stateDiffers(rowOf({ checkout_session_id: null }), state, null)).toBe(false);
  });

  it("keeps only the fields that changed, each side with its value", () => {
    expect(
      changedFields(
        { status: "active", planCode: "growth", canceledAt: null },
        { status: "unpaid", planCode: "growth", canceledAt: "2026-10-24T10:00:00.000Z" },
      ),
    ).toEqual({
      before: { status: "active", canceledAt: null },
      after: { status: "unpaid", canceledAt: "2026-10-24T10:00:00.000Z" },
    });
  });
});

describe("the Velexis metadata and billing sync's actor", () => {
  it("reads tenant and subscription ids of the platform's shape only", () => {
    expect(velexisTenantIdOf({ velexis_tenant_id: TENANT_ID })).toBe(TENANT_ID);
    expect(velexisSubscriptionIdOf({ velexis_subscription_id: ROW_ID })).toBe(ROW_ID);
    // The fixture's placeholders are not ids of the platform, and Stripe's own `sub_` ids are not either.
    expect(velexisTenantIdOf(subscription().metadata)).toBeUndefined();
    expect(velexisSubscriptionIdOf(subscription().metadata)).toBeUndefined();
    expect(velexisSubscriptionIdOf({ velexis_subscription_id: "sub_1PqRsTuVwXyZ" })).toBeUndefined();
    expect(velexisTenantIdOf(null)).toBeUndefined();
  });

  it("reads the id of a reference, expanded or not", () => {
    expect(stripeIdOf("cus_TestAlpha")).toBe("cus_TestAlpha");
    expect(stripeIdOf({ id: "cus_TestAlpha" })).toBe("cus_TestAlpha");
    expect(stripeIdOf(null)).toBeUndefined();
  });

  it("acts as the system, with the event id as request id when it has a request id's shape", () => {
    expect(billingSyncActor({ id: "evt_1PqRsTuVwXyZ" })).toEqual({
      type: "system",
      label: "billing.sync",
      requestId: "evt_1PqRsTuVwXyZ",
    });
    expect(billingSyncActor({ id: `evt_${"x".repeat(130)}` })).toEqual({
      type: "system",
      label: "billing.sync",
    });
  });
});
