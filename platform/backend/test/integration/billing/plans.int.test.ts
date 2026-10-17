// The plan and subscription reads of the portal (PBE-017; platform/docs/api-inventory.md §6, api-inventory-resources.md
// §6, scope PF-70 AC1 and §1.2) through the HTTP pipeline (createTestApp) on this file's database clone: the public
// plan list of the pricing page and the create-OTA wizard, and the subscription of an OTA for its owners and finance
// members. The Stripe Billing switch is replaced by a stand-in this file turns on and off, so one application shows
// both milestones. Every answer is checked against the platform document.
import { expectResponseToMatch } from "@velexis/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURE_VARIABLES,
  FeatureSwitches,
  FEATURES,
  featuresFor,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import { insertAccount, insertPlan, insertSubscription, testId } from "../../builders/platform-rows";
import { insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** The milestone switches of this application: all off, as FEATURE_* default, until a test turns one on. */
class TestSwitches {
  readonly on = new Set<Feature>();

  isEnabled(feature: Feature): boolean {
    return this.on.has(feature);
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(
        FEATURES.map((feature) => [FEATURE_VARIABLES[feature], this.on.has(feature)]),
      ) as FeatureConfig,
    );
  }
}

let t: TestApp;
let pool: PlatformPool;
const switches = new TestSwitches();

beforeAll(async () => {
  t = await createTestApp({ overrides: [{ provide: FeatureSwitches, useValue: switches }] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

afterEach(() => {
  switches.on.clear();
});

/** `Authorization: Bearer` with a fresh portal token of `accountId`, at the FakeClock's time. */
async function bearer(accountId: string, ev = true): Promise<Record<string, string>> {
  const { token } = await t.app
    .get(TokenService)
    .sign({ aud: "portal", sub: accountId, sid: testId("asn", 1), ev, amr: ["pwd"] });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders("203.0.113.7") };
}

/** The error code of an envelope answer, with the request id in the body and the header. */
function errorOf(res: { body: unknown; headers: Record<string, string> }): string {
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return error.code;
}

describe("listPlans", () => {
  beforeAll(async () => {
    await insertPlan(pool, {
      code: "growth",
      name: "Growth",
      description: null,
      monthly_price: "149.00",
      annual_price: "1490.00",
      sort_order: 20,
      stripe_product_id: "prod_TestGrowth",
      stripe_price_id_month: "price_TestGrowthMonth",
      stripe_price_id_year: "price_TestGrowthYear",
      limits: { staffSeats: 15, apiKeys: 25, customDomains: 3, liveMode: true },
      features: { queues: true, advancedSearch: false, note: "not a flag" },
    });
    await insertPlan(pool, {
      code: "starter",
      name: "Starter",
      description: "For a first OTA.",
      monthly_price: "49.00",
      annual_price: null,
      sort_order: 10,
      stripe_price_id_month: "price_TestStarterMonth",
      limits: { staffSeats: 5 },
    });
    await insertPlan(pool, { code: "private_deal", is_public: false, sort_order: 5 });
    await insertPlan(pool, { code: "legacy", is_active: false, sort_order: 6 });
  });

  it("[PBE-017 AC3] lists only the public, active plans in sort_order, without a token", async () => {
    const res = await t.http.get("/v1/plans");

    expect(res.status).toBe(200);
    expectResponseToMatch("listPlans", res, { document: "platform" });
    const plans = (res.body as { data: Array<{ code: string }> }).data;
    expect(plans.map(({ code }) => code)).toEqual(["early_access", "starter", "growth"]);
    expect(plans[0]).toEqual({
      code: "early_access",
      name: "Early access",
      description: "Free plan for OTAs created before paid plans open. Test mode only.",
      monthlyPrice: { amount: "0.00", currency: "EUR" },
      annualPrice: null,
      trialDays: 90,
      limits: { staffSeats: 5, apiKeys: 10, customDomains: 0, liveMode: false },
      features: {},
      checkoutAvailable: { month: false, year: false },
    });
    expect(plans[2]).toEqual({
      code: "growth",
      name: "Growth",
      description: null,
      monthlyPrice: { amount: "149.00", currency: "EUR" },
      annualPrice: { amount: "1490.00", currency: "EUR" },
      trialDays: 14,
      limits: { staffSeats: 15, apiKeys: 25, customDomains: 3, liveMode: true },
      features: { queues: true, advancedSearch: false },
      checkoutAvailable: { month: false, year: false },
    });
    // A quota the plan does not set is none, never more.
    expect(plans[1]).toMatchObject({
      annualPrice: null,
      limits: { staffSeats: 5, apiKeys: 0, customDomains: 0, liveMode: false },
    });
  });

  it("offers Checkout only with Stripe Billing on, and only for an interval with a Stripe price", async () => {
    switches.on.add("stripe_billing");

    const res = await t.http.get("/v1/plans").set(await bearer((await insertAccount(pool)).id));

    expect(res.status).toBe(200);
    expectResponseToMatch("listPlans", res, { document: "platform" });
    const available = Object.fromEntries(
      (res.body as { data: Array<{ code: string; checkoutAvailable: unknown }> }).data.map(
        ({ code, checkoutAvailable }) => [code, checkoutAvailable],
      ),
    );
    expect(available).toEqual({
      early_access: { month: false, year: false },
      starter: { month: true, year: false },
      growth: { month: true, year: true },
    });
  });
});

describe("getSubscription", () => {
  const people: Record<string, string> = {};

  beforeAll(async () => {
    for (const role of ["owner", "admin", "agent", "finance", "viewer", "stranger"]) {
      people[role] = (await insertAccount(pool)).id;
    }
  });

  /** An OTA with the five members above and the subscriptions given, oldest first. */
  async function otaWith(...subscriptions: Array<Parameters<typeof insertSubscription>[2]>) {
    const { tenant } = await insertOta(pool, {
      members: (["owner", "admin", "agent", "finance", "viewer"] as const).map((role) => [
        { id: people[role] ?? "" },
        role,
      ]),
    });
    const rows = [];
    for (const subscription of subscriptions) {
      rows.push(await insertSubscription(pool, tenant, subscription));
    }
    return { tenant, rows };
  }

  const get = async (tenantId: string, who: string) =>
    t.http.get(`/v1/tenants/${tenantId}/subscription`).set(await bearer(people[who] ?? who));

  it("shows the manual trial to owners and finance members, without a banner and outside Stripe", async () => {
    const { tenant, rows } = await otaWith({ trial_ends_at: new Date("2027-01-12T08:20:11Z") });

    for (const who of ["owner", "finance"]) {
      const res = await get(tenant.id, who);

      expect(res.status, who).toBe(200);
      expectResponseToMatch("getSubscription", res, { document: "platform" });
      expect(res.body).toEqual({
        id: rows[0]?.id,
        planCode: "early_access",
        planName: "Early access",
        status: "trialing",
        billingProvider: "manual",
        billingInterval: "month",
        trialEndsAt: "2027-01-12T08:20:11.000Z",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        banner: null,
        canManageInStripe: false,
      });
    }
  });

  it("answers 403 FORBIDDEN to admins, agents and viewers, and 404 NOT_FOUND to non-members", async () => {
    const { tenant } = await otaWith({});

    for (const who of ["admin", "agent", "viewer"]) {
      const res = await get(tenant.id, who);
      expect([res.status, errorOf(res)], who).toEqual([403, "FORBIDDEN"]);
      expectResponseToMatch("getSubscription", res, { document: "platform" });
    }
    const stranger = await get(tenant.id, "stranger");
    expect([stranger.status, errorOf(stranger)]).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("getSubscription", stranger, { document: "platform" });
  });

  it("answers 404 NOT_FOUND for an OTA without a subscription", async () => {
    const { tenant } = await otaWith();

    const res = await get(tenant.id, "owner");

    expect([res.status, errorOf(res)]).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("getSubscription", res, { document: "platform" });
  });

  it("takes the banner from the tenant's billing notice and from a past-due or canceled status", async () => {
    const trialEnding = await otaWith({});
    await pool.query("UPDATE platform.tenants SET billing_notice = 'trial_ending' WHERE id = $1", [
      trialEnding.tenant.id,
    ]);
    const pastDue = await otaWith({ status: "past_due", billing_provider: "stripe" });
    const canceled = await otaWith({
      status: "canceled",
      billing_provider: "stripe",
      canceled_at: new Date("2026-12-01T00:00:00Z"),
      current_period_end: new Date("2026-12-01T00:00:00Z"),
    });
    await pool.query("UPDATE platform.tenants SET billing_notice = 'past_due' WHERE id = $1", [
      canceled.tenant.id,
    ]);

    const banners = [];
    for (const { tenant } of [trialEnding, pastDue, canceled]) {
      const res = await get(tenant.id, "finance");
      expect(res.status).toBe(200);
      expectResponseToMatch("getSubscription", res, { document: "platform" });
      banners.push(res.body as { banner: unknown; canManageInStripe: unknown; status: unknown });
    }

    expect(banners.map(({ banner, canManageInStripe }) => ({ banner, canManageInStripe }))).toEqual([
      { banner: "trial_ending", canManageInStripe: false },
      { banner: "past_due", canManageInStripe: true },
      { banner: "canceled", canManageInStripe: true },
    ]);
    expect(banners[2]).toMatchObject({ status: "canceled", currentPeriodEnd: "2026-12-01T00:00:00.000Z" });
  });

  it("shows the current subscription over older canceled ones, and the latest canceled one when none is current", async () => {
    const resubscribed = await otaWith(
      { status: "canceled", created_at: new Date("2026-03-01T00:00:00Z") },
      { status: "trialing", created_at: new Date("2026-02-01T00:00:00Z") },
      { status: "canceled", created_at: new Date("2026-04-01T00:00:00Z") },
    );
    const lapsed = await otaWith(
      { status: "canceled", created_at: new Date("2026-03-01T00:00:00Z") },
      { status: "canceled", created_at: new Date("2026-05-01T00:00:00Z") },
    );

    const current = await get(resubscribed.tenant.id, "owner");
    const latest = await get(lapsed.tenant.id, "owner");

    expect(current.body).toMatchObject({ id: resubscribed.rows[1]?.id, status: "trialing" });
    expect(latest.body).toMatchObject({ id: lapsed.rows[1]?.id, status: "canceled", banner: "canceled" });
  });
});
