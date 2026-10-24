// The status rules of billing sync (PBE-045; subscription-billing flow §E, PADR-0002 item 7, PADR-0014 items 1 and 4,
// scope PF-74): the effect of each status of a tenant's shown subscription on the tenant, as a table. The rules run in
// the transaction of each billing event against PostgreSQL in test/integration/billing/billing-events.int.test.ts.
import { describe, expect, it } from "vitest";
import {
  billingEffects,
  PAST_DUE_STATUSES,
  RESUMING_STATUSES,
  SUSPENDING_STATUSES,
  type RulesSubscription,
  type RulesTenant,
} from "./status-rules";

const stripe = (status: string): RulesSubscription => ({ status, billingProvider: "stripe" });

const ACTIVE: RulesTenant = { status: "active", suspensionReason: null, billingNotice: null };
const ACTIVE_PAST_DUE: RulesTenant = { status: "active", suspensionReason: null, billingNotice: "past_due" };
const BILLING_SUSPENDED: RulesTenant = {
  status: "suspended",
  suspensionReason: "billing",
  billingNotice: "past_due",
};

/** Every status Stripe gives a subscription. */
const STRIPE_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
] as const;

describe("billingEffects", () => {
  it("covers each Stripe status with exactly one rule, or none for incomplete", () => {
    for (const status of STRIPE_STATUSES) {
      const rules = [RESUMING_STATUSES, PAST_DUE_STATUSES, SUSPENDING_STATUSES].filter((set) =>
        set.has(status),
      );
      expect(rules.length, status).toBe(status === "incomplete" ? 0 : 1);
    }
  });

  it.each(["trialing", "active"])(
    "[PBE-045 AC3] %s clears the banner of an active tenant and resumes nothing",
    (status) => {
      expect(billingEffects(stripe(status), ACTIVE_PAST_DUE)).toEqual({
        billingNotice: null,
        lifecycle: null,
      });
      expect(
        billingEffects(stripe(status), {
          status: "active",
          suspensionReason: null,
          billingNotice: "trial_ending",
        }),
      ).toEqual({ billingNotice: null, lifecycle: null });
    },
  );

  it.each(["trialing", "active"])(
    "[PBE-045 AC3] %s resumes a billing suspension and clears the banner",
    (status) => {
      expect(billingEffects(stripe(status), BILLING_SUSPENDED)).toEqual({
        billingNotice: null,
        lifecycle: "resume",
      });
    },
  );

  it.each(["abuse", "request", "admin"])(
    "[PBE-045 AC3] active never resumes a suspension for %s",
    (reason) => {
      expect(
        billingEffects(stripe("active"), {
          status: "suspended",
          suspensionReason: reason,
          billingNotice: null,
        }),
      ).toEqual({ billingNotice: null, lifecycle: null });
    },
  );

  it.each(["past_due", "paused"])(
    "[PBE-045 AC3] %s sets the past_due banner and suspends nothing",
    (status) => {
      expect(billingEffects(stripe(status), ACTIVE)).toEqual({ billingNotice: "past_due", lifecycle: null });
      expect(billingEffects(stripe(status), ACTIVE_PAST_DUE)).toEqual({
        billingNotice: "past_due",
        lifecycle: null,
      });
      // A tenant suspended for billing stays suspended while the subscription is in dunning.
      expect(billingEffects(stripe(status), BILLING_SUSPENDED)).toEqual({
        billingNotice: "past_due",
        lifecycle: null,
      });
    },
  );

  it.each(["canceled", "unpaid", "incomplete_expired"])(
    "[PBE-045 AC3] %s suspends an active tenant with the banner kept",
    (status) => {
      expect(billingEffects(stripe(status), ACTIVE)).toEqual({ billingNotice: null, lifecycle: "suspend" });
      expect(billingEffects(stripe(status), ACTIVE_PAST_DUE)).toEqual({
        billingNotice: "past_due",
        lifecycle: "suspend",
      });
    },
  );

  it.each(["provisioning", "failed", "suspended"])(
    "canceled, unpaid and incomplete_expired never suspend a tenant that is %s",
    (tenantStatus) => {
      for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
        const tenant: RulesTenant = {
          status: tenantStatus,
          suspensionReason: tenantStatus === "suspended" ? "abuse" : null,
          billingNotice: null,
        };
        expect(billingEffects(stripe(status), tenant), status).toEqual({
          billingNotice: null,
          lifecycle: null,
        });
      }
    },
  );

  it("incomplete changes nothing (the Checkout is not paid yet)", () => {
    expect(billingEffects(stripe("incomplete"), ACTIVE_PAST_DUE)).toEqual({
      billingNotice: "past_due",
      lifecycle: null,
    });
    expect(
      billingEffects(stripe("incomplete"), {
        status: "provisioning",
        suspensionReason: null,
        billingNotice: null,
      }),
    ).toEqual({ billingNotice: null, lifecycle: null });
  });

  it("changes nothing for a manual subscription or a tenant without one (the manual-trial schedule's business)", () => {
    const trialEnding: RulesTenant = {
      status: "active",
      suspensionReason: null,
      billingNotice: "trial_ending",
    };
    for (const status of STRIPE_STATUSES) {
      expect(billingEffects({ status, billingProvider: "manual" }, trialEnding), status).toEqual({
        billingNotice: "trial_ending",
        lifecycle: null,
      });
    }
    expect(billingEffects(undefined, BILLING_SUSPENDED)).toEqual({
      billingNotice: "past_due",
      lifecycle: null,
    });
  });
});
