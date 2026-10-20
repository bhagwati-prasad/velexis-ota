// The platform admin's plans (PBE-033; platform/docs/api-inventory-admin.md §4, flows/subscription-billing.md §A,
// flows/platform-admin-operations.md §D, PADR-0002 item 2) through the HTTP pipeline (createTestApp) on this file's
// database clone: the list with tenant counts, the creation and the edit with `If-Match`, their audit rows and the
// `plan` invalidations on `vx:invalidate`, which this file receives with a subscriber of its own. Admin tokens come
// from the application's TokenService, for an account written with the builders as an active platform admin with
// MFA. Every answer is checked against the platform document.
//
// The version of a plan is its `updated_at` in epoch milliseconds (plans.repository.ts); the FakeClock stands still,
// so the tests also show that every change moves it forward anyway.
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  insertAccount,
  insertPlan,
  insertTenant,
  SEEDED_PLAN_CODE,
  testId,
} from "../../builders/platform-rows";
import { createTestApp, type TestApp } from "../../support/app";

/** Starting the API on a fresh clone takes seconds; the bound allows for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for an invalidation event (pub/sub is asynchronous). */
const WAIT_MS = 10_000;
const FAMILY = testId("asn", 1);
const ADMIN_IP = "203.0.113.9";

interface PlanBody {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly currency: string;
  readonly monthlyPrice: { readonly amount: string; readonly currency: string };
  readonly annualPrice: { readonly amount: string; readonly currency: string } | null;
  readonly trialDays: number;
  readonly limits: Record<string, unknown>;
  readonly features: Record<string, boolean>;
  readonly checkoutAvailable: { readonly month: boolean; readonly year: boolean };
  readonly isPublic: boolean;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly settlementFeeBps: number;
  readonly stripeProductId: string | null;
  readonly priceWarnings: unknown[];
  readonly tenantCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

let t: TestApp;
let pool: PlatformPool;
let admin: string;
let subscriber: Redis;
/** Every event received on `vx:invalidate`, in order. */
const events: InvalidationEvent[] = [];

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  admin = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;
  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    events.push(JSON.parse(message) as InvalidationEvent);
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
}, SETUP_TIMEOUT_MS);

/** The headers of an admin call: a `platform_admin` token of `sub` (the admin by default) at the FakeClock's time. */
async function adminHeaders(sub = admin): Promise<Record<string, string>> {
  const { token } = await t.app
    .get(TokenService)
    .sign({ aud: "platform_admin", sub, sid: FAMILY, ev: true, amr: ["pwd", "otp"] });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

function errorOf(res: { body: unknown }): {
  code: string;
  details?: Record<string, unknown>;
  fieldErrors?: unknown;
} {
  return (res.body as { error: { code: string; details?: Record<string, unknown> } }).error;
}

/** A valid adminCreatePlan body for `code`. */
function newPlan(code: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code,
    name: `Plan ${code}`,
    description: "For OTAs selling live with up to 15 staff.",
    currency: "EUR",
    monthlyPrice: { amount: "149.00", currency: "EUR" },
    annualPrice: { amount: "1490.00", currency: "EUR" },
    limits: { staffSeats: 15, apiKeys: 25, customDomains: 1, liveMode: true },
    features: { queues: true },
    isPublic: false,
    trialDays: 14,
    settlementFeeBps: 150,
    sortOrder: 20,
    ...overrides,
  };
}

async function createPlan(code: string, overrides: Record<string, unknown> = {}): Promise<PlanBody> {
  const res = await t.http
    .post("/v1/admin/plans")
    .set(await adminHeaders())
    .send(newPlan(code, overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as PlanBody;
}

async function patchPlan(code: string, version: number | string, body: Record<string, unknown>) {
  return t.http
    .patch(`/v1/admin/plans/${code}`)
    .set(await adminHeaders())
    .set("If-Match", `"${version}"`)
    .send(body);
}

async function auditOf(code: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE target_type = 'plan' AND target_id = $1 ORDER BY id",
    [code],
  );
  return rows as Array<Record<string, unknown>>;
}

async function storedPlan(code: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query("SELECT * FROM platform.plans WHERE code = $1", [code]);
  return rows[0] as Record<string, unknown> | undefined;
}

/** Waits until `predicate` holds for an event received after index `from`, and returns its index. */
async function eventAfter(from: number, predicate: (event: InvalidationEvent) => boolean): Promise<number> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const index = events.findIndex((event, i) => i >= from && predicate(event));
    if (index >= 0) {
      return index;
    }
    expect(Date.now(), "the expected invalidation event").toBeLessThan(deadline);
    await new Promise((done) => setTimeout(done, 20));
  }
}

const isPlanEvent =
  (code: string) =>
  (event: InvalidationEvent): boolean =>
    event.type === "plan" && event.code === code;

describe("adminListPlans", () => {
  it("answers every plan, public or not, active or retired, in sort order, with its tenant count and version", async () => {
    await insertPlan(pool, { code: "list_hidden", is_public: false, sort_order: 500 });
    await insertPlan(pool, { code: "list_retired", is_active: false, sort_order: 501 });
    await insertPlan(pool, { code: "list_used", sort_order: 502 });
    await insertTenant(pool, { plan_code: "list_used" });
    await insertTenant(pool, { plan_code: "list_used", status: "suspended" });

    const res = await t.http.get("/v1/admin/plans").set(await adminHeaders());
    expect(res.status).toBe(200);
    expectResponseToMatch("adminListPlans", res, { document: "platform" });
    const plans = (res.body as { data: PlanBody[] }).data;
    const codes = plans.map((plan) => plan.code);
    expect(codes).toEqual(
      expect.arrayContaining([SEEDED_PLAN_CODE, "list_hidden", "list_retired", "list_used"]),
    );
    expect(codes.indexOf("list_hidden")).toBeLessThan(codes.indexOf("list_retired"));
    expect(codes.indexOf("list_retired")).toBeLessThan(codes.indexOf("list_used"));
    const byCode = new Map(plans.map((plan) => [plan.code, plan]));
    expect(byCode.get("list_hidden")).toMatchObject({ isPublic: false, isActive: true, tenantCount: 0 });
    expect(byCode.get("list_retired")).toMatchObject({ isActive: false, tenantCount: 0 });
    expect(byCode.get("list_used")).toMatchObject({
      tenantCount: 2,
      stripeProductId: null,
      priceWarnings: [],
      checkoutAvailable: { month: false, year: false },
    });
    for (const plan of plans) {
      expect(plan.version).toBe(Date.parse(plan.updatedAt));
    }
  });

  it("refuses a portal token and the token of an account that is no longer a platform admin (401)", async () => {
    const formerAdmin = (await insertAccount(pool, { is_platform_admin: false, mfa_enabled: true })).id;
    const res = await t.http.get("/v1/admin/plans").set(await adminHeaders(formerAdmin));
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe("UNAUTHENTICATED");

    const { token } = await t.app
      .get(TokenService)
      .sign({ aud: "portal", sub: admin, sid: FAMILY, ev: true, amr: ["pwd", "otp"] });
    const portal = await t.http
      .get("/v1/admin/plans")
      .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) });
    expect(portal.status).toBe(401);
  });
});

describe("adminCreatePlan", () => {
  it("[PBE-033 AC1] creating a plan with an existing code answers 409 CONFLICT (code_taken) and changes nothing", async () => {
    const seededBefore = await storedPlan(SEEDED_PLAN_CODE);
    const seeded = await t.http
      .post("/v1/admin/plans")
      .set(await adminHeaders())
      .send(newPlan(SEEDED_PLAN_CODE));
    expect(seeded.status).toBe(409);
    expectResponseToMatch("adminCreatePlan", seeded, { document: "platform" });
    expect(errorOf(seeded)).toMatchObject({ code: "CONFLICT", details: { reason: "code_taken" } });
    expect(await storedPlan(SEEDED_PLAN_CODE)).toEqual(seededBefore);

    const first = await createPlan("dup_code");
    const again = await t.http
      .post("/v1/admin/plans")
      .set(await adminHeaders())
      .send(newPlan("dup_code", { name: "Another name", monthlyPrice: { amount: "1.00", currency: "EUR" } }));
    expect(again.status).toBe(409);
    expect(errorOf(again)).toMatchObject({ code: "CONFLICT", details: { reason: "code_taken" } });
    expect(await storedPlan("dup_code")).toMatchObject({ name: first.name, monthly_price: "149.00" });
    expect((await auditOf("dup_code")).map((row) => row["action"])).toEqual(["plan.created"]);
  });

  it("creates an active plan in its currency with one plan.created audit row and its version in ETag", async () => {
    const res = await t.http
      .post("/v1/admin/plans")
      .set(await adminHeaders())
      .send(newPlan("growth_new", { monthlyPrice: { amount: "0149.5", currency: "EUR" }, isPublic: true }));
    expect(res.status).toBe(201);
    expectResponseToMatch("adminCreatePlan", res, { document: "platform" });
    const plan = res.body as PlanBody;
    expect(plan).toMatchObject({
      code: "growth_new",
      currency: "EUR",
      monthlyPrice: { amount: "149.50", currency: "EUR" },
      annualPrice: { amount: "1490.00", currency: "EUR" },
      limits: { staffSeats: 15, apiKeys: 25, customDomains: 1, liveMode: true },
      features: { queues: true },
      isPublic: true,
      isActive: true,
      trialDays: 14,
      settlementFeeBps: 150,
      sortOrder: 20,
      tenantCount: 0,
      stripeProductId: null,
      priceWarnings: [],
    });
    expect(res.headers["etag"]).toBe(`"${plan.version}"`);
    expect(plan.version).toBe(Date.parse(plan.updatedAt));

    const audit = await auditOf("growth_new");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "plan.created",
      actor_type: "platform_admin",
      actor_account_id: admin,
    });
    expect((audit[0]?.["details"] as { after: Record<string, unknown> }).after).toMatchObject({
      currency: "EUR",
      monthlyPrice: "149.50",
      isActive: true,
    });

    // A public, active plan is on the pricing page at once.
    const pricing = await t.http.get("/v1/plans");
    expect((pricing.body as { data: Array<{ code: string }> }).data.map((p) => p.code)).toContain(
      "growth_new",
    );
  });

  it("creates a plan without a yearly option when annualPrice is left out", async () => {
    const plan = await createPlan("monthly_only", { annualPrice: undefined });
    expect(plan.annualPrice).toBeNull();
    expect(await storedPlan("monthly_only")).toMatchObject({ annual_price: null });
  });

  it("refuses prices in another currency and an unknown currency (400) and writes nothing", async () => {
    const otherCurrency = await t.http
      .post("/v1/admin/plans")
      .set(await adminHeaders())
      .send(
        newPlan("bad_price", {
          monthlyPrice: { amount: "149.00", currency: "USD" },
          annualPrice: { amount: "1490.00", currency: "GBP" },
        }),
      );
    expect(otherCurrency.status).toBe(400);
    expectResponseToMatch("adminCreatePlan", otherCurrency, { document: "platform" });
    expect(errorOf(otherCurrency)).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [
        { path: "/monthlyPrice/currency", code: "currency" },
        { path: "/annualPrice/currency", code: "currency" },
      ],
    });

    const unknown = await t.http
      .post("/v1/admin/plans")
      .set(await adminHeaders())
      .send(
        newPlan("bad_currency", {
          currency: "XTS",
          monthlyPrice: { amount: "1.00", currency: "XTS" },
          annualPrice: undefined,
        }),
      );
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown)).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [{ path: "/currency", code: "unknown" }],
    });
    expect(await storedPlan("bad_price")).toBeUndefined();
    expect(await storedPlan("bad_currency")).toBeUndefined();
  });
});

describe("adminUpdatePlan", () => {
  it("[PBE-033 AC1] changing a plan's limits publishes {type: plan, code} after the commit, with one audit row", async () => {
    const plan = await createPlan("limits_plan");
    const from = events.length;
    const res = await patchPlan("limits_plan", plan.version, {
      limits: { staffSeats: 20, apiKeys: 25, customDomains: 1, liveMode: true },
    });
    expect(res.status).toBe(200);
    expectResponseToMatch("adminUpdatePlan", res, { document: "platform" });
    const updated = res.body as PlanBody;
    expect(updated.limits).toEqual({ staffSeats: 20, apiKeys: 25, customDomains: 1, liveMode: true });
    expect(updated.version).toBeGreaterThan(plan.version);
    expect(res.headers["etag"]).toBe(`"${updated.version}"`);

    const index = await eventAfter(from, isPlanEvent("limits_plan"));
    expect(events[index]).toEqual({ v: 1, type: "plan", code: "limits_plan" });
    expect(await storedPlan("limits_plan")).toMatchObject({
      limits: { staffSeats: 20, apiKeys: 25, customDomains: 1, liveMode: true },
    });
    const audit = await auditOf("limits_plan");
    expect(audit.map((row) => row["action"])).toEqual(["plan.created", "plan.updated"]);
    expect(audit[1]).toMatchObject({ actor_type: "platform_admin", actor_account_id: admin });
    expect(audit[1]?.["details"]).toMatchObject({
      changed: ["limits"],
      before: { limits: { staffSeats: 15 } },
      after: { limits: { staffSeats: 20 } },
    });
  });

  it("publishes the plan invalidation for a change of features, and none for a change of other fields", async () => {
    const quiet = await createPlan("quiet_plan");
    const loud = await createPlan("loud_plan");
    const from = events.length;

    const renamed = await patchPlan("quiet_plan", quiet.version, {
      name: "Renamed",
      monthlyPrice: { amount: "99", currency: "EUR" },
      annualPrice: null,
      isPublic: true,
      trialDays: 30,
      settlementFeeBps: 200,
      sortOrder: 7,
      description: null,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: "Renamed",
      description: null,
      monthlyPrice: { amount: "99.00", currency: "EUR" },
      annualPrice: null,
      isPublic: true,
      trialDays: 30,
      settlementFeeBps: 200,
      sortOrder: 7,
    });

    const features = await patchPlan("loud_plan", loud.version, {
      features: { queues: false, reports: true },
    });
    expect(features.status).toBe(200);
    expect((features.body as PlanBody).features).toEqual({ queues: false, reports: true });

    // Both changes were published, if at all, on the API's one command connection, in order: once the event of the
    // second has arrived, an event of the first would have arrived before it.
    const index = await eventAfter(from, isPlanEvent("loud_plan"));
    expect(events.slice(from, index).some(isPlanEvent("quiet_plan"))).toBe(false);
    expect((await auditOf("quiet_plan")).at(-1)?.["details"]).toMatchObject({
      changed: [
        "name",
        "description",
        "monthlyPrice",
        "annualPrice",
        "isPublic",
        "trialDays",
        "settlementFeeBps",
        "sortOrder",
      ],
    });
  });

  it("answers 412 for a stale If-Match, also for two changes within the same millisecond, and accepts the new ETag", async () => {
    const plan = await createPlan("locked_plan");
    // The FakeClock stands still: both changes happen at the same instant.
    const first = await patchPlan("locked_plan", plan.version, { name: "First" });
    expect(first.status).toBe(200);
    const firstVersion = (first.body as PlanBody).version;
    expect(firstVersion).toBeGreaterThan(plan.version);

    const stale = await patchPlan("locked_plan", plan.version, { name: "Second" });
    expect(stale.status).toBe(412);
    expectResponseToMatch("adminUpdatePlan", stale, { document: "platform" });
    expect(errorOf(stale).code).toBe("PRECONDITION_FAILED");

    const second = await patchPlan("locked_plan", firstVersion, { name: "Second" });
    expect(second.status).toBe(200);
    expect((second.body as PlanBody).version).toBeGreaterThan(firstVersion);
    expect(await storedPlan("locked_plan")).toMatchObject({ name: "Second" });
    expect((await auditOf("locked_plan")).map((row) => row["action"])).toEqual([
      "plan.created",
      "plan.updated",
      "plan.updated",
    ]);
  });

  it("retires a plan with isActive: false: it leaves the pricing page and stays in the admin list", async () => {
    const plan = await createPlan("retire_me", { isPublic: true });
    const res = await patchPlan("retire_me", plan.version, { isActive: false });
    expect(res.status).toBe(200);
    expect((res.body as PlanBody).isActive).toBe(false);
    const pricing = await t.http.get("/v1/plans");
    expect((pricing.body as { data: Array<{ code: string }> }).data.map((p) => p.code)).not.toContain(
      "retire_me",
    );
    const list = await t.http.get("/v1/admin/plans").set(await adminHeaders());
    expect((list.body as { data: PlanBody[] }).data.find((p) => p.code === "retire_me")?.isActive).toBe(
      false,
    );
  });

  it("writes nothing for a request that changes nothing: same version, no audit row, no event", async () => {
    const plan = await createPlan("same_plan");
    const marker = await createPlan("marker_plan");
    const from = events.length;
    const res = await patchPlan("same_plan", plan.version, {
      name: plan.name,
      monthlyPrice: { amount: "149", currency: "EUR" },
      limits: { liveMode: true, customDomains: 1, apiKeys: 25, staffSeats: 15 },
      features: { queues: true },
    });
    expect(res.status).toBe(200);
    expect((res.body as PlanBody).version).toBe(plan.version);
    expect((await auditOf("same_plan")).map((row) => row["action"])).toEqual(["plan.created"]);
    const marked = await patchPlan("marker_plan", marker.version, { features: {} });
    expect(marked.status).toBe(200);
    const index = await eventAfter(from, isPlanEvent("marker_plan"));
    expect(events.slice(from, index).some(isPlanEvent("same_plan"))).toBe(false);
  });

  it("answers 404 for an unknown plan, 400 for a price in another currency and for code or currency in the body", async () => {
    const missing = await patchPlan("no_such_plan", 1, { name: "Ghost" });
    expect(missing.status).toBe(404);
    expectResponseToMatch("adminUpdatePlan", missing, { document: "platform" });

    const plan = await createPlan("strict_plan");
    const price = await patchPlan("strict_plan", plan.version, {
      annualPrice: { amount: "10.00", currency: "USD" },
    });
    expect(price.status).toBe(400);
    expect(errorOf(price)).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [{ path: "/annualPrice/currency", code: "currency" }],
    });
    for (const body of [{ code: "renamed_code" }, { currency: "USD" }, {}]) {
      const refused = await patchPlan("strict_plan", plan.version, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(refused).code).toBe("VALIDATION_FAILED");
    }
    expect(await storedPlan("strict_plan")).toMatchObject({ currency: "EUR", annual_price: "1490.00" });
    expect((await auditOf("strict_plan")).map((row) => row["action"])).toEqual(["plan.created"]);
  });
});
