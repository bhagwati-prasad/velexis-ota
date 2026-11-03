// The rules of go-live without a database (PBE-061; platform/docs/api-inventory.md §7 `goLive`, scope PF-14 AC1,
// flows/stripe-payments-account.md §A item 2): which connection gives the live payment mode and what go-live writes
// for it, which preconditions are missing, and the capabilities a copied Connect connection keeps. The integration
// test test/integration/provisioning/go-live.int.test.ts runs the operation through the HTTP pipeline on PostgreSQL
// and Redis.
import { describe, expect, it } from "vitest";
import {
  LIVE_PRECONDITIONS,
  livePaymentPlan,
  missingPreconditions,
  storedConnectCapabilities,
  subscriptionAllowsGoLive,
  type GoLiveState,
  type PaymentConnectionState,
} from "./go-live.service";

const connection = (account_mode: string, status = "active"): PaymentConnectionState => ({
  account_mode,
  status,
});

/** A state with every precondition met: the live Velexis payments of a verified payout account on a live plan. */
const READY: GoLiveState = {
  amadeusLiveActive: true,
  payment: { mode: "velexis", usable: true },
  payoutAccountStatus: "verified",
  planLimits: { staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode: true },
  subscription: { billingProvider: "stripe", status: "active", linked: true },
  mfaEnabled: true,
};

describe("livePaymentPlan", () => {
  it("[PBE-061 AC1] takes the live connection when there is one, in any of the three modes, and writes nothing", () => {
    for (const mode of ["velexis", "connect_standard", "api_keys"]) {
      expect(livePaymentPlan(connection("velexis"), connection(mode))).toEqual({
        mode,
        usable: true,
        write: "none",
      });
      // The live connection decides even when the test one could not take payments.
      expect(livePaymentPlan(connection("api_keys", "disabled"), connection(mode))).toEqual({
        mode,
        usable: true,
        write: "none",
      });
    }
  });

  it("[PBE-061 AC1] creates the live Velexis connection, or copies a Connect one, from an active test connection", () => {
    expect(livePaymentPlan(connection("velexis"), undefined)).toEqual({
      mode: "velexis",
      usable: true,
      write: "insert_velexis",
    });
    expect(livePaymentPlan(connection("connect_standard"), undefined)).toEqual({
      mode: "connect_standard",
      usable: true,
      write: "copy_connect_standard",
    });
  });

  it("[PBE-061 AC1] gives no usable mode for test API keys, a connection that cannot charge, or none at all", () => {
    // Test API keys cannot take live payments: the live keys are submitted for the live environment.
    expect(livePaymentPlan(connection("api_keys"), undefined)).toEqual({
      mode: "api_keys",
      usable: false,
      write: "none",
    });
    // A connected account whose charges are not enabled yet, or a connection a platform admin or Stripe disabled.
    for (const status of ["pending", "disabled"]) {
      expect(livePaymentPlan(connection("connect_standard", status), undefined)).toEqual({
        mode: "connect_standard",
        usable: false,
        write: "none",
      });
      expect(livePaymentPlan(connection("velexis"), connection("api_keys", status))).toEqual({
        mode: "api_keys",
        usable: false,
        write: "none",
      });
    }
    expect(livePaymentPlan(connection("velexis", "disabled"), undefined)).toEqual({
      mode: "velexis",
      usable: false,
      write: "none",
    });
    expect(livePaymentPlan(undefined, undefined)).toEqual({ mode: null, usable: false, write: "none" });
  });
});

describe("subscriptionAllowsGoLive", () => {
  it("[FIX-W40-PLATFORM AC3] accepts a Stripe subscription that is trialing or active, and a manual one that is active", () => {
    for (const status of ["trialing", "active"]) {
      expect(subscriptionAllowsGoLive({ billingProvider: "stripe", status, linked: true }), status).toBe(
        true,
      );
    }
    expect(subscriptionAllowsGoLive({ billingProvider: "manual", status: "active", linked: false })).toBe(
      true,
    );
    // A manual row has no Stripe subscription; one that carries an id anyway is judged by its status alone.
    expect(subscriptionAllowsGoLive({ billingProvider: "manual", status: "active", linked: true })).toBe(
      true,
    );
  });

  it("[FIX-W40-PLATFORM AC3] refuses a manual trial, a Stripe row without its Stripe subscription, other statuses and none", () => {
    // A manual trial still counts as no subscription: nobody pays for it yet.
    expect(subscriptionAllowsGoLive({ billingProvider: "manual", status: "trialing", linked: false })).toBe(
      false,
    );
    expect(subscriptionAllowsGoLive({ billingProvider: "stripe", status: "active", linked: false })).toBe(
      false,
    );
    expect(subscriptionAllowsGoLive({ billingProvider: "stripe", status: "trialing", linked: false })).toBe(
      false,
    );
    for (const status of ["past_due", "paused", "incomplete", "canceled"]) {
      expect(subscriptionAllowsGoLive({ billingProvider: "stripe", status, linked: true }), status).toBe(
        false,
      );
      expect(subscriptionAllowsGoLive({ billingProvider: "manual", status, linked: false }), status).toBe(
        false,
      );
    }
    expect(subscriptionAllowsGoLive({ billingProvider: "invoice", status: "active", linked: true })).toBe(
      false,
    );
    expect(subscriptionAllowsGoLive(null)).toBe(false);
  });

  it("[FIX-W40-PLATFORM AC3] names the subscription missing for a manual trial and not for an active manual subscription", () => {
    expect(
      missingPreconditions({
        ...READY,
        subscription: { billingProvider: "manual", status: "active", linked: false },
      }),
    ).toEqual([]);
    expect(
      missingPreconditions({
        ...READY,
        subscription: { billingProvider: "manual", status: "trialing", linked: false },
      }),
    ).toEqual(["subscription"]);
  });
});

describe("missingPreconditions", () => {
  it("[PBE-061 AC1] finds nothing missing when every precondition is met", () => {
    expect(missingPreconditions(READY)).toEqual([]);
    // Payments on the OTA's own account need no payout account.
    expect(
      missingPreconditions({
        ...READY,
        payment: { mode: "connect_standard", usable: true },
        payoutAccountStatus: undefined,
      }),
    ).toEqual([]);
    expect(
      missingPreconditions({
        ...READY,
        payment: { mode: "api_keys", usable: true },
        payoutAccountStatus: "rejected",
      }),
    ).toEqual([]);
  });

  it("[PBE-061 AC1] names each missing precondition on its own", () => {
    const cases: Array<[Partial<GoLiveState>, string]> = [
      [{ amadeusLiveActive: false }, "amadeus_live"],
      [{ payment: { mode: "api_keys", usable: false } }, "payments_live"],
      [{ payoutAccountStatus: "pending_review" }, "payout_account"],
      [{ planLimits: { staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode: false } }, "plan_live_mode"],
      [{ subscription: null }, "subscription"],
      [{ mfaEnabled: false }, "mfa"],
    ];
    for (const [change, missing] of cases) {
      expect([missing, missingPreconditions({ ...READY, ...change })]).toEqual([missing, [missing]]);
    }
  });

  it("[PBE-061 AC1] lists every missing precondition at once, in the inventory's order", () => {
    expect(
      missingPreconditions({
        amadeusLiveActive: false,
        payment: { mode: "velexis", usable: false },
        payoutAccountStatus: undefined,
        planLimits: null,
        subscription: null,
        mfaEnabled: false,
      }),
    ).toEqual([...LIVE_PRECONDITIONS]);
    expect(LIVE_PRECONDITIONS).toEqual([
      "amadeus_live",
      "payments_live",
      "payout_account",
      "plan_live_mode",
      "subscription",
      "mfa",
    ]);
  });

  it("asks for a verified payout account only while the live payments stay on the Velexis account", () => {
    for (const status of [undefined, "pending_review", "rejected"]) {
      expect(missingPreconditions({ ...READY, payoutAccountStatus: status })).toEqual(["payout_account"]);
      expect(
        missingPreconditions({
          ...READY,
          payment: { mode: "connect_standard", usable: true },
          payoutAccountStatus: status,
        }),
      ).toEqual([]);
    }
    // No payment connection at all: the payments are missing, the payout account is not asked for.
    expect(
      missingPreconditions({
        ...READY,
        payment: { mode: null, usable: false },
        payoutAccountStatus: undefined,
      }),
    ).toEqual(["payments_live"]);
  });

  it("reads live mode from the plan's limits as listPlans shows them: only `liveMode: true` counts", () => {
    for (const limits of [null, undefined, {}, [], "liveMode", { liveMode: "true" }, { liveMode: 1 }]) {
      expect([limits, missingPreconditions({ ...READY, planLimits: limits })]).toEqual([
        limits,
        ["plan_live_mode"],
      ]);
    }
  });
});

describe("storedConnectCapabilities", () => {
  it("keeps the three flags of a stored Connect connection, false where one is missing or not true", () => {
    expect(
      storedConnectCapabilities({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true }),
    ).toEqual({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
    expect(storedConnectCapabilities({ chargesEnabled: true, payoutsEnabled: "yes" })).toEqual({
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: false,
    });
    for (const stored of [null, undefined, {}, [], "chargesEnabled"]) {
      expect(storedConnectCapabilities(stored)).toEqual({
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      });
    }
  });
});
