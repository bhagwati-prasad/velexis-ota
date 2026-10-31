// The platform admin's subscriptions (PBE-033; platform/docs/api-inventory-admin.md §4, flows/subscription-billing.md
// §G, flows/platform-admin-operations.md §D, PADR-0002 items 6 and 9; scope PF-75) through the HTTP pipeline
// (createTestApp) on this file's database clone: the list with its filters and cursor, the detail with invoices and
// Stripe events, and the edit of a manual subscription with a reason, its audit row, the tenant's plan and the
// `tenant` invalidation on `vx:invalidate`, which this file receives with a subscriber of its own. Admin tokens come
// from the application's TokenService, for an account written with the builders as an active platform admin with
// MFA. Every answer is checked against the platform document. Times are relative to the application's FakeClock.
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  insertAccount,
  insertPlan,
  insertRow,
  insertSubscription,
  insertTenant,
  SEEDED_PLAN_CODE,
  testId,
} from "../../builders/platform-rows";
import { insertOta, type InsertedOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** Starting the API on a fresh clone takes seconds; the bound allows for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for an invalidation event (pub/sub is asynchronous). */
const WAIT_MS = 10_000;
const FAMILY = testId("asn", 1);
const ADMIN_IP = "203.0.113.10";
const DAY_MS = 24 * 60 * 60 * 1000;
const REASON = "Pilot extended by one month as agreed with the owner on the phone.";

interface SubscriptionBody {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly tenantName: string;
  readonly planCode: string;
  readonly planName: string;
  readonly status: string;
  readonly billingProvider: string;
  readonly trialEndsAt: string | null;
  readonly canceledAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

interface ListBody {
  readonly data: SubscriptionBody[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

let t: TestApp;
let pool: PlatformPool;
let admin: string;
let subscriber: Redis;
/** Every event received on `vx:invalidate`, in order. */
const events: InvalidationEvent[] = [];
/** A sequence for the subscription ids of this file (the builder's own sequence is per insert). */
let nextSubscription = 1000;

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  admin = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;
  await insertPlan(pool, { code: "growth", name: "Growth", is_public: false });
  await insertPlan(pool, { code: "legacy", name: "Legacy", is_active: false });
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

beforeEach(async () => {
  // Every test starts without subscriptions, invoices or Stripe events, so lists and filters see its own rows only.
  await pool.query("DELETE FROM platform.invoices");
  await pool.query("DELETE FROM platform.stripe_events");
  await pool.query("DELETE FROM platform.subscriptions");
});

/** The headers of an admin call: a `platform_admin` token at the FakeClock's time. */
async function adminHeaders(): Promise<Record<string, string>> {
  const { token } = await t.app
    .get(TokenService)
    .sign({ aud: "platform_admin", sub: admin, sid: FAMILY, ev: true, amr: ["pwd", "otp"] });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

function errorOf(res: { body: unknown }): {
  code: string;
  details?: Record<string, unknown>;
  fieldErrors?: unknown;
} {
  return (res.body as { error: { code: string; details?: Record<string, unknown> } }).error;
}

/** `days` days after the application's FakeClock, as a Date. */
const daysFromNow = (days: number): Date => new Date(t.clock.now().getTime() + days * DAY_MS);

/** An OTA with a manual trial on early access (or the subscription of `subscription`). */
async function otaWith(subscription: Record<string, unknown> = {}): Promise<InsertedOta & { sub: string }> {
  nextSubscription += 1;
  const ota = await insertOta(pool, {
    subscription: { id: testId("sub", nextSubscription), trial_ends_at: daysFromNow(60), ...subscription },
  });
  return { ...ota, sub: ota.subscription?.id ?? "" };
}

async function patchSubscription(id: string, version: number | string, body: Record<string, unknown>) {
  return t.http
    .patch(`/v1/admin/subscriptions/${id}`)
    .set(await adminHeaders())
    .set("If-Match", `"${version}"`)
    .send(body);
}

async function storedSubscription(id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query("SELECT * FROM platform.subscriptions WHERE id = $1", [id]);
  return rows[0] as Record<string, unknown>;
}

async function storedTenant(id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query("SELECT * FROM platform.tenants WHERE id = $1", [id]);
  return rows[0] as Record<string, unknown>;
}

async function auditOf(id: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE target_type = 'subscription' AND target_id = $1 ORDER BY id",
    [id],
  );
  return rows as Array<Record<string, unknown>>;
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

const isTenantEvent =
  (id: string) =>
  (event: InvalidationEvent): boolean =>
    event.type === "tenant" && event.id === id;

describe("adminListSubscriptions", () => {
  it("filters by status, provider and plan, newest first, naming the OTA and the plan", async () => {
    const trial = await otaWith({ created_at: daysFromNow(-3) });
    const canceled = await otaWith({
      status: "canceled",
      canceled_at: daysFromNow(-1),
      created_at: daysFromNow(-2),
    });
    const stripe = await otaWith({
      plan_code: "growth",
      status: "active",
      billing_provider: "stripe",
      provider_customer_id: "cus_TestAdminList1",
      provider_subscription_id: "sub_TestAdminList1",
      trial_ends_at: null,
      current_period_start: daysFromNow(-5),
      current_period_end: daysFromNow(25),
      created_at: daysFromNow(-1),
    });

    const all = await t.http.get("/v1/admin/subscriptions").set(await adminHeaders());
    expect(all.status).toBe(200);
    expectResponseToMatch("adminListSubscriptions", all, { document: "platform" });
    const body = all.body as ListBody;
    expect(body.data.map((row) => row.id)).toEqual([stripe.sub, canceled.sub, trial.sub]);
    expect(body.page).toEqual({ nextCursor: null, limit: 50 });
    expect(body.data[0]).toMatchObject({
      tenantId: stripe.tenant.id,
      tenantKey: stripe.tenant.key,
      tenantName: stripe.tenant.name,
      planCode: "growth",
      planName: "Growth",
      billingProvider: "stripe",
      providerCustomerId: "cus_TestAdminList1",
    });
    expect(body.data[2]).toMatchObject({
      planName: "Early access",
      billingProvider: "manual",
      providerCustomerId: null,
    });

    const filtered = async (query: string): Promise<string[]> => {
      const res = await t.http.get(`/v1/admin/subscriptions?${query}`).set(await adminHeaders());
      expect(res.status, query).toBe(200);
      expectResponseToMatch("adminListSubscriptions", res, { document: "platform" });
      return (res.body as ListBody).data.map((row) => row.id);
    };
    expect(await filtered("status=canceled")).toEqual([canceled.sub]);
    expect(await filtered("provider=manual")).toEqual([canceled.sub, trial.sub]);
    expect(await filtered("provider=stripe")).toEqual([stripe.sub]);
    expect(await filtered(`planCode=${SEEDED_PLAN_CODE}`)).toEqual([canceled.sub, trial.sub]);
    expect(await filtered("status=trialing&provider=manual&planCode=growth")).toEqual([]);
  });

  it("pages with an opaque cursor that returns every subscription exactly once, and refuses a foreign cursor (400)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      // Two pairs share their creation time, so the id breaks the tie.
      ids.push((await otaWith({ created_at: daysFromNow(-Math.floor(i / 2)) })).sub);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? "limit=2" : `limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await t.http.get(`/v1/admin/subscriptions?${query}`).set(await adminHeaders());
      expect(res.status).toBe(200);
      expectResponseToMatch("adminListSubscriptions", res, { document: "platform" });
      const body = res.body as ListBody;
      expect(body.page.limit).toBe(2);
      seen.push(...body.data.map((row) => row.id));
      cursor = body.page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);

    for (const foreign of [
      "not-a-cursor!",
      Buffer.from('{"id":"amo_01JATESTRW0000000000000001"}').toString("base64url"),
    ]) {
      const res = await t.http
        .get(`/v1/admin/subscriptions?cursor=${encodeURIComponent(foreign)}`)
        .set(await adminHeaders());
      expect(res.status).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: "VALIDATION_FAILED",
        fieldErrors: [{ path: "/query/cursor" }],
      });
    }
  });
});

describe("adminGetSubscription", () => {
  it("answers a manual trial with no invoices and no Stripe events before M5, and its version in ETag", async () => {
    const ota = await otaWith();
    const res = await t.http.get(`/v1/admin/subscriptions/${ota.sub}`).set(await adminHeaders());
    expect(res.status).toBe(200);
    expectResponseToMatch("adminGetSubscription", res, { document: "platform" });
    const body = res.body as { subscription: SubscriptionBody; invoices: unknown[]; events: unknown[] };
    expect(body.subscription).toMatchObject({ id: ota.sub, status: "trialing", billingProvider: "manual" });
    expect(body.invoices).toEqual([]);
    expect(body.events).toEqual([]);
    expect(res.headers["etag"]).toBe(`"${body.subscription.version}"`);
  });

  it("answers the subscription's invoices and its OTA's Stripe events, newest first, and nothing of another OTA", async () => {
    const ota = await otaWith({
      plan_code: "growth",
      status: "active",
      billing_provider: "stripe",
      provider_customer_id: "cus_TestAdminDetail",
      provider_subscription_id: "sub_TestAdminDetail",
      trial_ends_at: null,
    });
    const other = await otaWith();
    const invoice = (n: number, subscriptionId: string, tenantId: string, createdDaysAgo: number) =>
      insertRow(pool, "invoices", {
        id: testId("inv", n),
        tenant_id: tenantId,
        subscription_id: subscriptionId,
        number: `VX-TEST-${n}`,
        status: "paid",
        currency: "EUR",
        subtotal: "149.00",
        tax_amount: "0.00",
        total: "149.00",
        amount_paid: "149.00",
        amount_due: "0.00",
        issued_at: daysFromNow(-createdDaysAgo),
        paid_at: daysFromNow(-createdDaysAgo),
        hosted_invoice_url: "https://invoice.stripe.com/i/acct_test/test_invoice",
        provider_invoice_id: `in_TestAdmin${n}`,
        created_at: daysFromNow(-createdDaysAgo),
      });
    await invoice(1, ota.sub, ota.tenant.id, 40);
    await invoice(2, ota.sub, ota.tenant.id, 10);
    await invoice(3, other.sub, other.tenant.id, 5);
    const event = (id: string, tenantId: string, receivedDaysAgo: number) =>
      insertRow(pool, "stripe_events", {
        id,
        endpoint: "billing",
        type: "invoice.paid",
        livemode: false,
        object_type: "invoice",
        object_id: "in_TestAdmin1",
        stripe_created_at: daysFromNow(-receivedDaysAgo),
        status: "failed",
        attempts: 5,
        last_error: "x".repeat(1200),
        tenant_id: tenantId,
        received_at: daysFromNow(-receivedDaysAgo),
      });
    await event("evt_TestAdminOld", ota.tenant.id, 9);
    await event("evt_TestAdminNew", ota.tenant.id, 1);
    await event("evt_TestAdminOther", other.tenant.id, 1);

    const res = await t.http.get(`/v1/admin/subscriptions/${ota.sub}`).set(await adminHeaders());
    expect(res.status).toBe(200);
    expectResponseToMatch("adminGetSubscription", res, { document: "platform" });
    const body = res.body as {
      invoices: Array<{ id: string; total: unknown; subscriptionId: string }>;
      events: Array<{ id: string; lastError: string; status: string }>;
    };
    expect(body.invoices.map((row) => row.id)).toEqual([testId("inv", 2), testId("inv", 1)]);
    expect(body.invoices[0]).toMatchObject({
      subscriptionId: ota.sub,
      total: { amount: "149.00", currency: "EUR" },
      hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_test/test_invoice",
    });
    expect(body.events.map((row) => row.id)).toEqual(["evt_TestAdminNew", "evt_TestAdminOld"]);
    expect(body.events[0]).toMatchObject({ status: "failed", attempts: 5, endpoint: "billing" });
    expect(body.events[0]?.lastError).toHaveLength(1000);
  });

  it("answers 404 for an unknown subscription", async () => {
    const res = await t.http
      .get(`/v1/admin/subscriptions/${testId("sub", 999_999)}`)
      .set(await adminHeaders());
    expect(res.status).toBe(404);
    expectResponseToMatch("adminGetSubscription", res, { document: "platform" });
  });
});

describe("adminUpdateManualSubscription", () => {
  it("[PBE-033 AC2] an admin moves a manual trial's end date with a reason, and the audit row holds the reason [PF-75]", async () => {
    const ota = await otaWith();
    const before = await storedSubscription(ota.sub);
    const trialEndsAt = daysFromNow(90);
    const from = events.length;

    const res = await patchSubscription(ota.sub, before["version"] as number, {
      trialEndsAt: trialEndsAt.toISOString(),
      reason: REASON,
    });
    expect(res.status).toBe(200);
    expectResponseToMatch("adminUpdateManualSubscription", res, { document: "platform" });
    const body = res.body as SubscriptionBody;
    expect(body).toMatchObject({
      id: ota.sub,
      status: "trialing",
      billingProvider: "manual",
      trialEndsAt: trialEndsAt.toISOString(),
      version: (before["version"] as number) + 1,
    });
    expect(res.headers["etag"]).toBe(`"${body.version}"`);
    expect((await storedSubscription(ota.sub))["trial_ends_at"]).toEqual(trialEndsAt);

    const audit = await auditOf(ota.sub);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "subscription.manually_updated",
      actor_type: "platform_admin",
      actor_account_id: admin,
      tenant_id: ota.tenant.id,
      ip_address: ADMIN_IP,
    });
    expect(audit[0]?.["details"]).toEqual({
      reason: REASON,
      before: { trialEndsAt: (before["trial_ends_at"] as Date).toISOString() },
      after: { trialEndsAt: trialEndsAt.toISOString() },
    });
    // The plan did not change: the tenant is untouched and no tenant invalidation follows.
    expect(await storedTenant(ota.tenant.id)).toMatchObject({
      plan_code: SEEDED_PLAN_CODE,
      version: ota.tenant.version,
    });
    const marker = await otaWith();
    const moved = await patchSubscription(marker.sub, 1, { planCode: "growth", reason: REASON });
    expect(moved.status).toBe(200);
    const index = await eventAfter(from, isTenantEvent(marker.tenant.id));
    expect(events.slice(from, index).some(isTenantEvent(ota.tenant.id))).toBe(false);
  });

  it("[PBE-033 AC3] editing a Stripe-billed subscription answers 409 CONFLICT (stripe_billed) and changes nothing", async () => {
    const ota = await otaWith({
      plan_code: "growth",
      status: "active",
      billing_provider: "stripe",
      provider_customer_id: "cus_TestAdminStripe",
      provider_subscription_id: "sub_TestAdminStripe",
      trial_ends_at: null,
    });
    const before = await storedSubscription(ota.sub);
    for (const body of [
      { trialEndsAt: daysFromNow(30).toISOString(), reason: REASON },
      { planCode: SEEDED_PLAN_CODE, reason: REASON },
      { status: "canceled", reason: REASON },
    ]) {
      const res = await patchSubscription(ota.sub, before["version"] as number, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expectResponseToMatch("adminUpdateManualSubscription", res, { document: "platform" });
      expect(errorOf(res)).toMatchObject({ code: "CONFLICT", details: { reason: "stripe_billed" } });
    }
    expect(await storedSubscription(ota.sub)).toEqual(before);
    expect(await auditOf(ota.sub)).toEqual([]);
  });

  it("moves the tenant to a new plan of its current manual subscription and publishes a tenant invalidation", async () => {
    const ota = await otaWith();
    const from = events.length;
    const res = await patchSubscription(ota.sub, 1, { planCode: "growth", reason: REASON });
    expect(res.status).toBe(200);
    expectResponseToMatch("adminUpdateManualSubscription", res, { document: "platform" });
    expect(res.body).toMatchObject({ planCode: "growth", planName: "Growth", version: 2 });

    expect(await storedTenant(ota.tenant.id)).toMatchObject({
      plan_code: "growth",
      version: ota.tenant.version + 1,
    });
    const index = await eventAfter(from, isTenantEvent(ota.tenant.id));
    expect(events[index]).toEqual({ v: 1, type: "tenant", id: ota.tenant.id });
    const audit = await auditOf(ota.sub);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.["details"]).toEqual({
      reason: REASON,
      tenantPlan: { before: SEEDED_PLAN_CODE, after: "growth" },
      before: { planCode: SEEDED_PLAN_CODE },
      after: { planCode: "growth" },
    });
  });

  it("answers 422 UNPROCESSABLE (plan_not_active) for a retired or unknown plan and changes nothing", async () => {
    const ota = await otaWith();
    for (const planCode of ["legacy", "no_such_plan"]) {
      const res = await patchSubscription(ota.sub, 1, { planCode, reason: REASON });
      expect(res.status, planCode).toBe(422);
      expectResponseToMatch("adminUpdateManualSubscription", res, { document: "platform" });
      expect(errorOf(res)).toMatchObject({ code: "UNPROCESSABLE", details: { reason: "plan_not_active" } });
    }
    expect(await storedSubscription(ota.sub)).toMatchObject({ plan_code: SEEDED_PLAN_CODE, version: 1 });
    expect(await auditOf(ota.sub)).toEqual([]);
  });

  it("cancels with canceled_at, reopens as trialing, and refuses to reopen next to another current subscription (409)", async () => {
    const ota = await otaWith();
    const canceled = await patchSubscription(ota.sub, 1, { status: "canceled", reason: REASON });
    expect(canceled.status).toBe(200);
    expect(canceled.body).toMatchObject({
      status: "canceled",
      canceledAt: t.clock.now().toISOString(),
      version: 2,
    });

    const reopened = await patchSubscription(ota.sub, 2, { status: "trialing", reason: REASON });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: "trialing", canceledAt: null, version: 3 });

    // A canceled manual row next to the OTA's current one cannot be reopened.
    const tenant = await insertTenant(pool);
    const old = await insertSubscription(pool, tenant, {
      id: testId("sub", 5000),
      status: "canceled",
      canceled_at: daysFromNow(-10),
    });
    await insertSubscription(pool, tenant, { id: testId("sub", 5001), status: "trialing" });
    const refused = await patchSubscription(old.id, old.version, { status: "trialing", reason: REASON });
    expect(refused.status).toBe(409);
    expectResponseToMatch("adminUpdateManualSubscription", refused, { document: "platform" });
    expect(errorOf(refused)).toMatchObject({ code: "CONFLICT", details: { reason: "current_exists" } });
    expect(await storedSubscription(old.id)).toMatchObject({ status: "canceled", version: old.version });
    expect(await auditOf(old.id)).toEqual([]);
    expect((await auditOf(ota.sub)).map((row) => row["details"])).toEqual([
      { reason: REASON, before: { status: "trialing" }, after: { status: "canceled" } },
      { reason: REASON, before: { status: "canceled" }, after: { status: "trialing" } },
    ]);
  });

  it("changes only the plan of a canceled subscription, and moves the tenant to it when the subscription is reopened", async () => {
    const ota = await otaWith({ status: "canceled", canceled_at: daysFromNow(-1) });
    const res = await patchSubscription(ota.sub, 1, { planCode: "growth", reason: REASON });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ planCode: "growth", status: "canceled" });
    expect(await storedTenant(ota.tenant.id)).toMatchObject({
      plan_code: SEEDED_PLAN_CODE,
      version: ota.tenant.version,
    });
    expect((await auditOf(ota.sub))[0]?.["details"]).toEqual({
      reason: REASON,
      before: { planCode: SEEDED_PLAN_CODE },
      after: { planCode: "growth" },
    });

    // Reopened, the subscription is current again, so the tenant follows its plan.
    const from = events.length;
    const reopened = await patchSubscription(ota.sub, 2, { status: "trialing", reason: REASON });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ planCode: "growth", status: "trialing", canceledAt: null });
    expect(await storedTenant(ota.tenant.id)).toMatchObject({
      plan_code: "growth",
      version: ota.tenant.version + 1,
    });
    const index = await eventAfter(from, isTenantEvent(ota.tenant.id));
    expect(events[index]).toEqual({ v: 1, type: "tenant", id: ota.tenant.id });
    expect((await auditOf(ota.sub))[1]?.["details"]).toEqual({
      reason: REASON,
      tenantPlan: { before: SEEDED_PLAN_CODE, after: "growth" },
      before: { status: "canceled" },
      after: { status: "trialing" },
    });
  });

  it("answers 409 current_exists when another current subscription of the OTA commits during the edit", async () => {
    const tenant = await insertTenant(pool);
    const first = await insertSubscription(pool, tenant, {
      id: testId("sub", 6000),
      status: "canceled",
      canceled_at: daysFromNow(-20),
    });
    const second = await insertSubscription(pool, tenant, {
      id: testId("sub", 6001),
      status: "canceled",
      canceled_at: daysFromNow(-10),
    });
    // A transaction of this test reopens the first subscription and stays open: the edit of the second does not see
    // it, passes its own check and waits on `subscriptions_current_uq` until this transaction commits.
    const holder = await pool.connect();
    let pending: ReturnType<typeof patchSubscription>;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "UPDATE platform.subscriptions SET status = 'trialing', canceled_at = NULL WHERE id = $1",
        [first.id],
      );
      const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = rows[0]?.pid;
      pending = patchSubscription(second.id, second.version, { status: "trialing", reason: REASON });
      // Awaited below; a failure before then must not count as unhandled.
      void pending.catch(() => undefined);
      /** How many sessions wait for this test's transaction. */
      const waitingOnHolder = async (): Promise<number> => {
        const waiting = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))",
          [holderPid],
        );
        return waiting.rows[0]?.n ?? 0;
      };
      await expect.poll(waitingOnHolder, { timeout: WAIT_MS, interval: 20 }).toBe(1);
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK");
      throw error;
    } finally {
      holder.release();
    }

    const res = await pending;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expectResponseToMatch("adminUpdateManualSubscription", res, { document: "platform" });
    expect(errorOf(res)).toMatchObject({ code: "CONFLICT", details: { reason: "current_exists" } });
    expect(await storedSubscription(second.id)).toMatchObject({
      status: "canceled",
      version: second.version,
    });
    expect(await storedSubscription(first.id)).toMatchObject({ status: "trialing" });
    expect(await auditOf(second.id)).toEqual([]);
  });

  it("[FIX-W30-PLATFORM AC2] locks the tenant's row before the subscription's, as billing sync does: while a transaction holds the tenant, the edit waits holding no lock on the subscription", async () => {
    const ota = await otaWith();
    // A transaction of this test takes billing sync's first lock (flow §D): the tenant's row.
    const holder = await pool.connect();
    let pending: ReturnType<typeof patchSubscription>;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM platform.tenants WHERE id = $1 FOR UPDATE", [ota.tenant.id]);
      const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = rows[0]?.pid;
      pending = patchSubscription(ota.sub, 1, { planCode: "growth", reason: REASON });
      // Awaited below; a failure before then must not count as unhandled.
      void pending.catch(() => undefined);
      /** How many sessions wait for this test's transaction. */
      const waitingOnHolder = async (): Promise<number> => {
        const waiting = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))",
          [holderPid],
        );
        return waiting.rows[0]?.n ?? 0;
      };
      await expect.poll(waitingOnHolder, { timeout: WAIT_MS, interval: 20 }).toBe(1);
      // Then billing sync's next lock, the subscription's row: free, because the edit waits for the tenant first. An
      // edit that held it while it waited would make this fail at once (55P03), where billing sync would deadlock.
      const probe = await holder.query(
        "SELECT id FROM platform.subscriptions WHERE id = $1 FOR UPDATE NOWAIT",
        [ota.sub],
      );
      expect(probe.rowCount).toBe(1);
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK");
      throw error;
    } finally {
      holder.release();
    }

    const res = await pending;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ planCode: "growth", version: 2 });
    expect(await storedTenant(ota.tenant.id)).toMatchObject({ plan_code: "growth" });
  });

  it("answers 412 for a stale If-Match, 404 for an unknown subscription, and writes nothing for no change", async () => {
    const ota = await otaWith();
    const stale = await patchSubscription(ota.sub, 7, { status: "canceled", reason: REASON });
    expect(stale.status).toBe(412);
    expectResponseToMatch("adminUpdateManualSubscription", stale, { document: "platform" });

    const missing = await patchSubscription(testId("sub", 999_998), 1, {
      status: "canceled",
      reason: REASON,
    });
    expect(missing.status).toBe(404);
    expectResponseToMatch("adminUpdateManualSubscription", missing, { document: "platform" });

    const same = await patchSubscription(ota.sub, 1, {
      planCode: SEEDED_PLAN_CODE,
      status: "trialing",
      trialEndsAt: (ota.subscription?.trial_ends_at as Date).toISOString(),
      reason: REASON,
    });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ version: 1 });
    expect(await auditOf(ota.sub)).toEqual([]);
  });

  it("requires a reason of 5 to 500 characters and at least one change (400)", async () => {
    const ota = await otaWith();
    for (const body of [
      { trialEndsAt: daysFromNow(10).toISOString() },
      { trialEndsAt: daysFromNow(10).toISOString(), reason: "four" },
      { trialEndsAt: daysFromNow(10).toISOString(), reason: "x".repeat(501) },
      { reason: REASON },
      { status: "past_due", reason: REASON },
    ]) {
      const res = await patchSubscription(ota.sub, 1, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res).code).toBe("VALIDATION_FAILED");
    }
    expect(await storedSubscription(ota.sub)).toMatchObject({ version: 1 });
    expect(await auditOf(ota.sub)).toEqual([]);
  });
});
