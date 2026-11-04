// The platform admin's billing endpoints of M5 (PBE-048; platform/docs/api-inventory-admin.md §4, subscription-billing
// flow §A and §D, PADR-0002 items 2 and 5, scope PF-88 and PF-89) through the HTTP pipeline (createTestApp,
// FEATURE_STRIPE_BILLING on) on this file's database clone and Redis database:
//
// - `adminUpdatePlan` with the Stripe ids and `adminCheckPlanPrices`: the comparison with the prices of the FakeStripe
//   (test/support/fake-stripe.ts), its warnings stored in the plan's row (`plans.price_warnings`, FIX-W42-PLATFORM)
//   and recorded by its audit row, a price of another plan refused, nothing saved when Stripe fails; the warnings
//   outlive a purge of the plan's audit rows (deleted as velexis_migrator, as a retention purge would: PADR-0006,
//   Audit item 3) and stay as they were when Stripe fails;
// - `adminResyncSubscription`: a drifted Stripe row brought back to Stripe's state through billing sync's update path,
//   under the subscription's lock, with the admin's audit row; the refusals;
// - `adminListInvoices` (and the invoices of `adminGetSubscription`): every OTA's invoices with the decimals of their
//   currency (lead decision (2g) of 2026-11-04), the filters and the cursor;
// - `adminListStripeEvents` and `adminReprocessStripeEvent`: the inbox with failed and ignored events first, and a
//   failed event run again by the worker's module graph (WorkerModule, as dist/worker.js builds it, with the API's
//   FakeClock) once its cause is fixed: a subscription event whose price no plan linked, an invoice event whose
//   subscription's row did not exist yet.
//
// Events are signed with a secret made for this file and posted to `POST /webhooks/stripe/billing`, or written into the
// inbox directly when only their state matters. Admin tokens come from the application's TokenService, for an account
// written with the builders as an active platform admin with MFA. Every answer is checked against the platform
// document. The job schedulers are not registered. The Stripe keys are the development values of `.env.example`.
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { createPool } from "@velexis/db";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { signedStripeEvent, stripeFixture } from "@velexis/testing/stripe";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import type Stripe from "stripe";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { redisKeys } from "../../../src/common/redis/redis-keys";
import { StripeClient } from "../../../src/common/stripe/stripe.client";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import { insertAccount, insertPlan, insertRow, testId, type PlatformRow } from "../../builders/platform-rows";
import { insertOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FakeStripe } from "../../support/fake-stripe";

/**
 * The database clone, the API's and the worker's Nest module graphs, the platform document and the fixtures; the bound
 * allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish an event (it takes milliseconds; under Vitest's 5 s). */
const WAIT = { timeout: 4_000, interval: 20 } as const;

/** The signing secret of `/webhooks/stripe/billing` in this file only. */
const SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
const PATH = "/webhooks/stripe/billing";
/** The switched-on application: the development Stripe key of `.env.example` (nothing reaches Stripe). */
const STRIPE_ENV = Object.freeze({
  FEATURE_STRIPE_BILLING: "true",
  STRIPE_SECRET_KEY: "sk_test_replace_me",
  STRIPE_BILLING_WEBHOOK_SECRET: SECRET,
});
/** The first number of this file's ids (`testId`), away from the other test files'. */
const FIRST_ID = 48_000;
const FAMILY = testId("asn", FIRST_ID);
const ADMIN_IP = "203.0.113.48";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The plan of the Stripe subscriptions of this file and its monthly Stripe Price, linked in `beforeAll`. */
const GROWTH = { code: "growth", month: "price_TestPbe048GrowthMonth" };

type Row = Record<string, unknown>;

const stripe = new FakeStripe();
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let tokens: TokenService;
let redis: Redis;
let stripeEvents: Queue;
let admin: string;
/** velexis_migrator on this file's clone: the role a retention purge of platform_audit_log runs as (PADR-0006). */
let migrator: ReturnType<typeof createPool>;
const workerLogs = new LogSink();
let next = FIRST_ID + 1;

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs, the Redis client, the platform document of
  // expectResponseToMatch and the fixtures.
  t = await createTestApp({ env: STRIPE_ENV, overrides: [{ provide: StripeClient, useValue: stripe }] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  stripeEvents = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.stripeEvents), { strict: false });
  responseChecker("platform");
  stripeFixture("customer.subscription.updated");
  stripeFixture("invoice.paid");

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .overrideProvider(StripeClient)
    .useValue(stripe)
    .compile();
  await worker.init();

  redis = new Redis(t.redis.url, { lazyConnect: true });
  await redis.connect();
  migrator = createPool(t.db.urlFor("migrator"), {
    applicationName: "platform-int-admin-billing-migrator",
    logger: { error: () => undefined },
    max: 1,
  });
  admin = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;
  await insertPlan(pool, { code: GROWTH.code, name: "Growth", stripe_price_id_month: GROWTH.month });
  // The yen (no minor unit), as the reference loader writes it; the test clones hold EUR, GBP and USD only.
  await pool.query(
    `INSERT INTO reference.currencies (code, numeric_code, name, symbol, minor_units)
     VALUES ('JPY', '392', 'Japanese Yen', '¥', 0)
     ON CONFLICT (code) DO NOTHING`,
  );
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await migrator?.end();
  await redis?.quit();
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

// ---- Calls -------------------------------------------------------------------------------------------------------

/** The headers of an admin call: a `platform_admin` token at the FakeClock's time. */
async function adminHeaders(): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: admin,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

function errorOf(res: Response): { code: string; details?: Row; fieldErrors?: unknown } {
  return (res.body as { error: { code: string; details?: Row; fieldErrors?: unknown } }).error;
}

/** The plans of `adminListPlans`, by code. */
async function listedPlan(code: string): Promise<Row> {
  const res = await t.http.get("/v1/admin/plans").set(await adminHeaders());
  expect(res.status).toBe(200);
  const plan = (res.body as { data: Row[] }).data.find((row) => row["code"] === code);
  if (plan === undefined) {
    throw new Error(`plan ${code} is not listed`);
  }
  return plan;
}

async function patchPlan(code: string, version: number, body: Row): Promise<Response> {
  return t.http
    .patch(`/v1/admin/plans/${code}`)
    .set(await adminHeaders())
    .set("If-Match", `"${version}"`)
    .send(body);
}

async function checkPrices(code: string): Promise<Response> {
  return t.http.post(`/v1/admin/plans/${code}/check-prices`).set(await adminHeaders());
}

async function resync(subscriptionId: string): Promise<Response> {
  return t.http.post(`/v1/admin/subscriptions/${subscriptionId}/resync`).set(await adminHeaders());
}

async function reprocess(eventId: string): Promise<Response> {
  return t.http.post(`/v1/admin/stripe-events/${eventId}/reprocess`).set(await adminHeaders());
}

// ---- Rows ----------------------------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[]): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const one = async (text: string, values: unknown[]): Promise<Row> => {
  const [row] = await rowsOf(text, values);
  if (row === undefined) {
    throw new Error(`no row for ${text}`);
  }
  return row;
};

const planRow = (code: string): Promise<Row> => one("SELECT * FROM platform.plans WHERE code = $1", [code]);
const subscriptionRow = (id: string): Promise<Row> =>
  one("SELECT * FROM platform.subscriptions WHERE id = $1", [id]);
const tenantRow = (id: string): Promise<Row> => one("SELECT * FROM platform.tenants WHERE id = $1", [id]);
const eventRow = (id: string): Promise<Row> =>
  one("SELECT * FROM platform.stripe_events WHERE id = $1", [id]);

const auditOf = (targetType: string, targetId: string, action: string): Promise<Row[]> =>
  rowsOf(
    "SELECT * FROM platform.platform_audit_log WHERE target_type = $1 AND target_id = $2 AND action = $3 ORDER BY id",
    [targetType, targetId, action],
  );

/**
 * Deletes every audit row about the plan `code` as velexis_migrator, as a reviewed retention purge would (PADR-0006,
 * Audit item 3: velexis_platform_app may not delete them); answers how many it deleted.
 */
async function purgePlanAuditRows(code: string): Promise<number> {
  const { rowCount } = await migrator.query(
    "DELETE FROM platform.platform_audit_log WHERE target_type = 'plan' AND target_id = $1",
    [code],
  );
  return rowCount ?? 0;
}

/** The version of a plan as `adminListPlans` answers it (`updated_at` in epoch milliseconds). */
const versionOf = async (code: string): Promise<number> => (await listedPlan(code))["version"] as number;

/** A plan of this test: 149.00 EUR a month and 1490.00 a year, without Stripe links. */
async function newPlan(): Promise<string> {
  const code = `pbe048_${next++}`;
  await insertPlan(pool, { code, name: `Plan ${code}`, monthly_price: "149.00", annual_price: "1490.00" });
  return code;
}

/** A Stripe Price id of this file (letters and digits after `price_`, as the `plans` columns allow). */
const newPriceId = (label: string): string => `price_TestPbe048${label}${next++}`;

/** A recurring Stripe Price as the FakeStripe answers `prices.retrieve`. */
function stripePrice(
  id: string,
  price: {
    readonly currency?: string;
    readonly unitAmount?: number;
    readonly interval?: Stripe.Price.Recurring.Interval;
    readonly active?: boolean;
  } = {},
): Stripe.Price & { id: string } {
  return {
    id,
    object: "price",
    active: price.active ?? true,
    billing_scheme: "per_unit",
    created: Math.floor(t.clock.now().getTime() / 1000),
    currency: price.currency ?? "eur",
    custom_unit_amount: null,
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: null,
    product: "prod_TestPbe048",
    recurring: {
      interval: price.interval ?? "month",
      interval_count: 1,
      meter: null,
      trial_period_days: null,
      usage_type: "licensed",
    },
    tax_behavior: "exclusive",
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: price.unitAmount ?? 14900,
    unit_amount_decimal: String(price.unitAmount ?? 14900),
  } as Stripe.Price & { id: string };
}

/** The Stripe ids of one subscription of this file. */
interface StripeIds {
  readonly subscriptionId: string;
  readonly customerId: string;
}

function stripeIds(): StripeIds {
  const n = next++;
  return { subscriptionId: `sub_TestPbe048N${n}`, customerId: `cus_TestPbe048N${n}` };
}

/** The fixture's subscription as Stripe answers a retrieve: `ids`, the OTA's metadata, `status` and `priceId`. */
function stripeSubscription(
  ids: StripeIds,
  tenantId: string,
  status: Stripe.Subscription.Status,
  priceId: string = GROWTH.month,
): Stripe.Subscription {
  const base = stripeFixture("customer.subscription.updated").data.object;
  const [item] = base.items.data;
  if (item === undefined) {
    throw new Error("the subscription fixture has no item");
  }
  return {
    ...base,
    id: ids.subscriptionId,
    customer: ids.customerId,
    status,
    trial_end: null,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    latest_invoice: null,
    metadata: { velexis_tenant_id: tenantId, velexis_plan_code: GROWTH.code },
    items: {
      ...base.items,
      data: [
        {
          ...item,
          subscription: ids.subscriptionId,
          price: { ...item.price, id: priceId },
          plan: { ...item.plan, id: priceId },
        },
      ],
      url: `/v1/subscription_items?subscription=${ids.subscriptionId}`,
    },
  };
}

/** What a billed OTA of this file has. */
interface BilledOta {
  readonly tenant: PlatformRow<"tenants">;
  readonly subscription: PlatformRow<"subscriptions">;
  readonly ids: StripeIds;
}

/**
 * An active OTA on `growth` that pays the Stripe subscription of its `ids` (the row `status`, the price of `growth`),
 * whose Stripe Customer `billing_customers` holds; Stripe answers the subscription with `stripeStatus`.
 */
async function arrangeBilledOta(
  status: string,
  stripeStatus: Stripe.Subscription.Status,
  priceId: string = GROWTH.month,
): Promise<BilledOta> {
  const ids = stripeIds();
  const n = next++;
  const ota = await insertOta(pool, {
    tenant: { id: testId("ten", n), key: `pbe${n}`, name: `Agency ${n} Travel`, plan_code: GROWTH.code },
    subscription: {
      id: testId("sub", n),
      plan_code: GROWTH.code,
      status,
      billing_provider: "stripe",
      trial_ends_at: null,
      provider_customer_id: ids.customerId,
      provider_subscription_id: ids.subscriptionId,
      provider_price_id: GROWTH.month,
      created_at: new Date(t.clock.now().getTime() - DAY_MS),
    },
  });
  if (ota.subscription === undefined) {
    throw new Error("arrangeBilledOta: the subscription was not written");
  }
  await insertRow(pool, "billing_customers", {
    tenant_id: ota.tenant.id,
    provider_customer_id: ids.customerId,
    livemode: false,
    billing_email: `billing-${n}@example.com`,
  });
  stripe.put(
    stripeSubscription(ids, ota.tenant.id, stripeStatus, priceId) as Stripe.Subscription & { id: string },
  );
  return { tenant: ota.tenant, subscription: ota.subscription, ids };
}

/** An inbox row of this file, as the receivers store it, in `status` and received `minutesAgo` minutes ago. */
async function insertEvent(event: {
  readonly status: string;
  readonly type?: string;
  readonly minutesAgo?: number;
  readonly tenantId?: string | null;
  readonly objectType?: string;
  readonly objectId?: string | null;
  readonly attempts?: number;
  readonly lastError?: string | null;
  readonly final?: boolean;
}): Promise<PlatformRow<"stripe_events">> {
  const receivedAt = new Date(t.clock.now().getTime() - (event.minutesAgo ?? 0) * 60_000);
  const done = event.status === "processed" || event.status === "ignored" || event.final === true;
  return insertRow(pool, "stripe_events", {
    id: `evt_test_pbe048_${next++}`,
    endpoint: "billing",
    type: event.type ?? "customer.subscription.updated",
    livemode: false,
    object_type: event.objectType ?? "subscription",
    object_id: event.objectId ?? "sub_test_pbe048_none",
    stripe_created_at: receivedAt,
    status: event.status,
    attempts: event.attempts ?? (event.status === "received" ? 0 : 1),
    last_error: event.lastError ?? null,
    tenant_id: event.tenantId ?? null,
    received_at: receivedAt,
    processed_at: done ? receivedAt : null,
    updated_at: receivedAt,
  });
}

/** Waits until the worker is done with the inbox row `eventId` (after its claim: `received` no more). */
async function doneWith(eventId: string, attempts: number): Promise<Row> {
  return vi.waitFor(async () => {
    const row = await eventRow(eventId);
    expect(row["attempts"]).toBe(attempts);
    expect(["processed", "ignored", "failed"]).toContain(row["status"]);
    return row;
  }, WAIT);
}

// ---- Plans and Stripe prices (PF-88) --------------------------------------------------------------------------------

describe("adminUpdatePlan with Stripe prices", () => {
  it("[PBE-048 AC1] links a monthly price of another currency: the plan is saved and the answer warns", async () => {
    const code = await newPlan();
    const month = newPriceId("Usd");
    stripe.put(stripePrice(month, { currency: "usd" }));
    const version = await versionOf(code);
    const calls = stripe.callsOf("prices.retrieve").length;

    const res = await patchPlan(code, version, {
      stripeProductId: "prod_TestPbe048",
      stripePriceIdMonth: month,
    });

    expect(res.status).toBe(200);
    expectResponseToMatch("adminUpdatePlan", res, { document: "platform" });
    const warnings = [{ field: "stripePriceIdMonth.currency", expected: "EUR", actual: "USD" }];
    expect(res.body).toMatchObject({
      code,
      stripeProductId: "prod_TestPbe048",
      stripePriceIdMonth: month,
      stripePriceIdYear: null,
      checkoutAvailable: { month: true, year: false },
      priceWarnings: warnings,
    });
    const saved = res.body as { version: number };
    expect(saved.version).toBeGreaterThan(version);
    expect(res.headers["etag"]).toBe(`"${saved.version}"`);
    expect(await planRow(code)).toMatchObject({
      stripe_product_id: "prod_TestPbe048",
      stripe_price_id_month: month,
    });
    expect(
      stripe
        .callsOf("prices.retrieve")
        .slice(calls)
        .map((call) => call.id),
    ).toEqual([month]);
    // The warnings are the plan's from now on, and the audit row of the change records them.
    expect((await listedPlan(code))["priceWarnings"]).toEqual(warnings);
    const [audit] = await auditOf("plan", code, "plan.updated");
    expect(audit).toMatchObject({ actor_type: "platform_admin", actor_account_id: admin });
    expect(audit?.["details"]).toMatchObject({
      changed: ["stripeProductId", "stripePriceIdMonth", "priceWarnings"],
      priceWarnings: warnings,
      before: { stripePriceIdMonth: null, priceWarnings: [] },
      after: { stripePriceIdMonth: month, priceWarnings: warnings },
    });
  });

  it("compares both prices when a price of a linked plan changes, and calls nothing for a change of another field", async () => {
    const code = await newPlan();
    const [month, year] = [newPriceId("M"), newPriceId("Y")];
    stripe.put(stripePrice(month), stripePrice(year, { interval: "year", unitAmount: 149000 }));
    const linked = await patchPlan(code, await versionOf(code), {
      stripePriceIdMonth: month,
      stripePriceIdYear: year,
    });
    expect(linked.status).toBe(200);
    expect((linked.body as Row)["priceWarnings"]).toEqual([]);

    // A new monthly price of the plan: Stripe still charges 149.00.
    const calls = stripe.callsOf("prices.retrieve").length;
    const repriced = await patchPlan(code, (linked.body as { version: number }).version, {
      monthlyPrice: { amount: "159.00", currency: "EUR" },
    });
    expect(repriced.status).toBe(200);
    expect((repriced.body as Row)["priceWarnings"]).toEqual([
      { field: "stripePriceIdMonth.amount", expected: "159.00", actual: "149.00" },
    ]);
    expect(
      stripe
        .callsOf("prices.retrieve")
        .slice(calls)
        .map((call) => call.id),
    ).toEqual([month, year]);

    // A new name compares nothing and keeps the stored warnings.
    const renamed = await patchPlan(code, (repriced.body as { version: number }).version, {
      name: "Renamed",
    });
    expect(renamed.status).toBe(200);
    expect((renamed.body as Row)["priceWarnings"]).toEqual([
      { field: "stripePriceIdMonth.amount", expected: "159.00", actual: "149.00" },
    ]);
    expect(stripe.callsOf("prices.retrieve")).toHaveLength(calls + 2);
  });

  it("refuses a price that another plan links, in either column (409 stripe_price_taken), and calls nothing", async () => {
    const [first, second] = [await newPlan(), await newPlan()];
    const month = newPriceId("Shared");
    stripe.put(stripePrice(month));
    expect((await patchPlan(first, await versionOf(first), { stripePriceIdMonth: month })).status).toBe(200);
    const calls = stripe.calls.length;
    const version = await versionOf(second);

    for (const body of [{ stripePriceIdMonth: month }, { stripePriceIdYear: month }]) {
      const res = await patchPlan(second, version, body);
      expect(res.status).toBe(409);
      expectResponseToMatch("adminUpdatePlan", res, { document: "platform" });
      expect(errorOf(res)).toMatchObject({ code: "CONFLICT", details: { reason: "stripe_price_taken" } });
    }
    expect(await planRow(second)).toMatchObject({ stripe_price_id_month: null, stripe_price_id_year: null });
    expect(stripe.calls).toHaveLength(calls);
    expect(await auditOf("plan", second, "plan.updated")).toEqual([]);
  });

  it("refuses one price for both intervals (400 same_price), before any call", async () => {
    const code = await newPlan();
    const price = newPriceId("Both");
    const calls = stripe.calls.length;

    const res = await patchPlan(code, await versionOf(code), {
      stripePriceIdMonth: price,
      stripePriceIdYear: price,
    });

    expect(res.status).toBe(400);
    expectResponseToMatch("adminUpdatePlan", res, { document: "platform" });
    expect(errorOf(res)).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [expect.objectContaining({ path: "/stripePriceIdYear", code: "same_price" })],
    });
    expect(stripe.calls).toHaveLength(calls);
  });

  it("saves nothing when Stripe fails (502 PROVIDER_ERROR), nor for a stale version (412) before any call", async () => {
    const code = await newPlan();
    const month = newPriceId("Down");
    stripe.put(stripePrice(month)).failNext("prices.retrieve", FakeStripe.apiError(503));
    const version = await versionOf(code);

    const failed = await patchPlan(code, version, { stripePriceIdMonth: month, name: "Not saved" });
    expect(failed.status).toBe(502);
    expectResponseToMatch("adminUpdatePlan", failed, { document: "platform" });
    expect(errorOf(failed)).toMatchObject({ code: "PROVIDER_ERROR", details: { provider: "stripe" } });
    expect(await planRow(code)).toMatchObject({ stripe_price_id_month: null, name: `Plan ${code}` });
    expect(await versionOf(code)).toBe(version);

    const calls = stripe.calls.length;
    const stale = await patchPlan(code, version - 1, { stripePriceIdMonth: month });
    expect(stale.status).toBe(412);
    expect(stripe.calls).toHaveLength(calls);
  });

  it("unlinking every price clears the warnings without a call", async () => {
    const code = await newPlan();
    const month = newPriceId("Gone");
    stripe.put(stripePrice(month, { active: false }));
    const linked = await patchPlan(code, await versionOf(code), { stripePriceIdMonth: month });
    expect((linked.body as Row)["priceWarnings"]).toEqual([
      { field: "stripePriceIdMonth.active", expected: "true", actual: "false" },
    ]);
    const calls = stripe.calls.length;

    const unlinked = await patchPlan(code, (linked.body as { version: number }).version, {
      stripePriceIdMonth: null,
    });

    expect(unlinked.status).toBe(200);
    expect(unlinked.body).toMatchObject({ stripePriceIdMonth: null, priceWarnings: [] });
    expect(stripe.calls).toHaveLength(calls);
  });
});

describe("adminCheckPlanPrices", () => {
  it("[PBE-048 AC1] runs the comparison again and stores its warnings, without changing the plan's version", async () => {
    const code = await newPlan();
    const month = newPriceId("Fixed");
    stripe.put(stripePrice(month, { currency: "usd" }));
    const linked = await patchPlan(code, await versionOf(code), { stripePriceIdMonth: month });
    const version = (linked.body as { version: number }).version;
    const before = [{ field: "stripePriceIdMonth.currency", expected: "EUR", actual: "USD" }];
    expect((linked.body as Row)["priceWarnings"]).toEqual(before);

    // The price is corrected in the Stripe dashboard: the check finds no difference any more.
    stripe.put(stripePrice(month));
    const fixed = await checkPrices(code);
    expect(fixed.status).toBe(200);
    expectResponseToMatch("adminCheckPlanPrices", fixed, { document: "platform" });
    expect(fixed.body).toEqual({ warnings: [] });
    expect(await listedPlan(code)).toMatchObject({ priceWarnings: [], version });

    // Then archived: the next check says so.
    stripe.put(stripePrice(month, { active: false }));
    const archived = await checkPrices(code);
    expect(archived.body).toEqual({
      warnings: [{ field: "stripePriceIdMonth.active", expected: "true", actual: "false" }],
    });
    expect(await listedPlan(code)).toMatchObject({
      priceWarnings: (archived.body as { warnings: unknown }).warnings,
      version,
    });

    const audits = await auditOf("plan", code, "plan.prices_checked");
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ actor_type: "platform_admin", actor_account_id: admin });
    expect(audits[0]?.["details"]).toMatchObject({
      priceIds: [month],
      priceWarnings: [],
      before: { priceWarnings: before },
      after: { priceWarnings: [] },
    });
  });

  it("answers no warning for a plan without a linked price, calls nothing and writes no audit row", async () => {
    const code = await newPlan();
    const calls = stripe.calls.length;

    const res = await checkPrices(code);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warnings: [] });
    expect(stripe.calls).toHaveLength(calls);
    expect(await auditOf("plan", code, "plan.prices_checked")).toEqual([]);
  });

  it("answers 404 for an unknown plan, and 502 when Stripe fails, keeping the stored warnings", async () => {
    const unknown = await checkPrices("pbe048_unknown");
    expect(unknown.status).toBe(404);
    expectResponseToMatch("adminCheckPlanPrices", unknown, { document: "platform" });

    const code = await newPlan();
    const month = newPriceId("Kept");
    stripe.put(stripePrice(month, { unitAmount: 15900 }));
    const linked = await patchPlan(code, await versionOf(code), { stripePriceIdMonth: month });
    const warnings = (linked.body as Row)["priceWarnings"];
    expect(warnings).toEqual([{ field: "stripePriceIdMonth.amount", expected: "149.00", actual: "159.00" }]);

    stripe.failNext("prices.retrieve", FakeStripe.connectionError());
    const failed = await checkPrices(code);
    expect(failed.status).toBe(502);
    expectResponseToMatch("adminCheckPlanPrices", failed, { document: "platform" });
    expect((await listedPlan(code))["priceWarnings"]).toEqual(warnings);
    expect(await auditOf("plan", code, "plan.prices_checked")).toEqual([]);
  });
});

describe("the stored price warnings of a plan", () => {
  it("[FIX-W42-PLATFORM AC3] outlive a purge of the plan's audit rows: every plan read takes them from the plans row", async () => {
    const code = await newPlan();
    const [month, year] = [newPriceId("Kept"), newPriceId("KeptYear")];
    stripe.put(
      stripePrice(month, { currency: "usd" }),
      stripePrice(year, { interval: "year", unitAmount: 149000 }),
    );
    const linked = await patchPlan(code, await versionOf(code), {
      stripePriceIdMonth: month,
      stripePriceIdYear: year,
    });
    expect(linked.status).toBe(200);
    // Then the yearly price is archived in the Stripe dashboard, and a check finds it.
    stripe.put(stripePrice(year, { interval: "year", unitAmount: 149000, active: false }));
    const checked = await checkPrices(code);
    expect(checked.status).toBe(200);
    expectResponseToMatch("adminCheckPlanPrices", checked, { document: "platform" });
    const warnings = [
      { field: "stripePriceIdMonth.currency", expected: "EUR", actual: "USD" },
      { field: "stripePriceIdYear.active", expected: "true", actual: "false" },
    ];
    expect(checked.body).toEqual({ warnings });
    expect((await planRow(code))["price_warnings"]).toEqual(warnings);

    // A retention purge removes the comparisons' audit rows (plan.updated, plan.prices_checked).
    expect(await purgePlanAuditRows(code)).toBe(2);
    expect(await auditOf("plan", code, "plan.prices_checked")).toEqual([]);

    const res = await t.http.get("/v1/admin/plans").set(await adminHeaders());
    expect(res.status).toBe(200);
    expectResponseToMatch("adminListPlans", res, { document: "platform" });
    expect(await listedPlan(code)).toMatchObject({ priceWarnings: warnings });
    // An update that compares nothing answers them too, from the row it saved.
    const renamed = await patchPlan(code, (linked.body as { version: number }).version, { name: "Renamed" });
    expect(renamed.status).toBe(200);
    expectResponseToMatch("adminUpdatePlan", renamed, { document: "platform" });
    expect((renamed.body as Row)["priceWarnings"]).toEqual(warnings);
    expect((await planRow(code))["price_warnings"]).toEqual(warnings);
  });

  it("[FIX-W42-PLATFORM AC3] stay as they were when Stripe fails, in adminUpdatePlan and adminCheckPlanPrices", async () => {
    const code = await newPlan();
    const month = newPriceId("Steady");
    stripe.put(stripePrice(month, { unitAmount: 15900 }));
    const linked = await patchPlan(code, await versionOf(code), { stripePriceIdMonth: month });
    expect(linked.status).toBe(200);
    const warnings = [{ field: "stripePriceIdMonth.amount", expected: "149.00", actual: "159.00" }];
    expect((linked.body as Row)["priceWarnings"]).toEqual(warnings);
    // Without its audit rows, so what the reads answer can come from the plans row only.
    expect(await purgePlanAuditRows(code)).toBe(1);
    const before = await planRow(code);
    expect(before["price_warnings"]).toEqual(warnings);

    // The price is corrected in Stripe, but Stripe cannot be reached: nothing is saved or stored.
    stripe.put(stripePrice(month)).failNext("prices.retrieve", FakeStripe.apiError(503));
    const update = await patchPlan(code, (linked.body as { version: number }).version, {
      monthlyPrice: { amount: "159.00", currency: "EUR" },
    });
    expect(update.status).toBe(502);
    expectResponseToMatch("adminUpdatePlan", update, { document: "platform" });
    expect(await planRow(code)).toEqual(before);
    expect(await auditOf("plan", code, "plan.updated")).toEqual([]);

    stripe.failNext("prices.retrieve", FakeStripe.connectionError());
    const check = await checkPrices(code);
    expect(check.status).toBe(502);
    expectResponseToMatch("adminCheckPlanPrices", check, { document: "platform" });
    expect(await planRow(code)).toEqual(before);
    expect(await listedPlan(code)).toMatchObject({ priceWarnings: warnings });
    expect(await auditOf("plan", code, "plan.prices_checked")).toEqual([]);
  });
});

// ---- Subscriptions (PF-89) ----------------------------------------------------------------------------------------

describe("adminResyncSubscription", () => {
  it("[PBE-048 AC2] updates a drifted row from Stripe, applies the status rules and audits the admin's resync", async () => {
    const ota = await arrangeBilledOta("active", "past_due");

    const res = await resync(ota.subscription.id);

    expect(res.status).toBe(200);
    expectResponseToMatch("adminResyncSubscription", res, { document: "platform" });
    expect(res.body).toMatchObject({
      id: ota.subscription.id,
      status: "past_due",
      billingProvider: "stripe",
    });
    expect(res.headers["etag"]).toBe(`"${(res.body as { version: number }).version}"`);
    expect(await subscriptionRow(ota.subscription.id)).toMatchObject({ status: "past_due" });
    expect(await tenantRow(ota.tenant.id)).toMatchObject({ billing_notice: "past_due" });
    const [audit, ...more] = await auditOf("subscription", ota.subscription.id, "subscription.resynced");
    expect(more).toEqual([]);
    expect(audit).toMatchObject({
      actor_type: "platform_admin",
      actor_account_id: admin,
      tenant_id: ota.tenant.id,
    });
    expect(audit?.["details"]).toMatchObject({
      providerSubscriptionId: ota.ids.subscriptionId,
      before: { status: "active", billingNotice: null },
      after: { status: "past_due", billingNotice: "past_due" },
    });
    // Billing sync's own row is not written: the change is the admin's.
    expect(await auditOf("subscription", ota.subscription.id, "subscription.updated")).toEqual([]);
  });

  it("suspends an active OTA whose subscription Stripe has as unpaid, as billing sync does", async () => {
    const ota = await arrangeBilledOta("active", "unpaid");

    const res = await resync(ota.subscription.id);

    expect(res.status).toBe(200);
    expect(await tenantRow(ota.tenant.id)).toMatchObject({
      status: "suspended",
      suspension_reason: "billing",
    });
    const [suspended] = await rowsOf(
      "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = 'tenant.suspended'",
      [ota.tenant.id],
    );
    expect(suspended).toMatchObject({ actor_type: "system", actor_label: "billing.sync" });
  });

  it("writes the admin's audit row also when the row already holds Stripe's state, and changes nothing else", async () => {
    const ota = await arrangeBilledOta("active", "active");
    const first = await resync(ota.subscription.id);
    expect(first.status).toBe(200);
    const synced = await subscriptionRow(ota.subscription.id);

    const again = await resync(ota.subscription.id);

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "active", version: synced["version"] });
    expect(await subscriptionRow(ota.subscription.id)).toMatchObject({
      version: synced["version"],
      updated_at: synced["updated_at"],
    });
    const audits = await auditOf("subscription", ota.subscription.id, "subscription.resynced");
    expect(audits).toHaveLength(2);
    expect(audits[1]?.["details"]).not.toHaveProperty("before");
  });

  it("waits for the lock that an event of the subscription holds, and re-fetches after it", async () => {
    const ota = await arrangeBilledOta("active", "past_due");
    const lock = redisKeys.stripeSubscriptionLock(ota.ids.subscriptionId);
    await redis.set(lock.key, "an-event-holds-it", "EX", lock.ttlSeconds);
    const retrieves = () =>
      stripe.callsOf("subscriptions.retrieve").filter((call) => call.id === ota.ids.subscriptionId);

    const pending = resync(ota.subscription.id);
    await vi.waitFor(() => {
      expect(
        t.logs
          .withMessage("billing.sync_lock_waiting")
          .some((line) => line["resyncOf"] === ota.subscription.id),
      ).toBe(true);
    }, WAIT);
    expect(retrieves()).toEqual([]);
    await redis.del(lock.key);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "past_due" });
    expect(retrieves()).toHaveLength(1);
    expect(await redis.exists(lock.key)).toBe(0);
  });

  it("answers 404 for an unknown row, 409 for a manual one or one without a Stripe subscription", async () => {
    const unknown = await resync(testId("sub", 99_999));
    expect(unknown.status).toBe(404);

    const manual = await insertOta(pool, { subscription: { id: testId("sub", next++) } });
    const manualRes = await resync(manual.subscription?.id ?? "");
    expect(manualRes.status).toBe(409);
    expectResponseToMatch("adminResyncSubscription", manualRes, { document: "platform" });
    expect(errorOf(manualRes)).toMatchObject({ code: "CONFLICT", details: { reason: "manual" } });

    const pending = await insertOta(pool, {
      tenant: { status: "provisioning", activated_at: null },
      subscription: { id: testId("sub", next++), status: "incomplete", billing_provider: "stripe" },
    });
    const pendingRes = await resync(pending.subscription?.id ?? "");
    expect(pendingRes.status).toBe(409);
    expect(errorOf(pendingRes)).toMatchObject({ code: "CONFLICT", details: { reason: "not_linked" } });
  });

  it("writes nothing for a price no plan links (409 unknown_price) or when Stripe fails (502)", async () => {
    const unlinked = await arrangeBilledOta("active", "past_due", newPriceId("Unlinked"));
    const before = await subscriptionRow(unlinked.subscription.id);

    const conflict = await resync(unlinked.subscription.id);
    expect(conflict.status).toBe(409);
    expectResponseToMatch("adminResyncSubscription", conflict, { document: "platform" });
    expect(errorOf(conflict)).toMatchObject({ code: "CONFLICT", details: { reason: "unknown_price" } });
    expect(await subscriptionRow(unlinked.subscription.id)).toEqual(before);

    const down = await arrangeBilledOta("active", "past_due");
    stripe.failNext("subscriptions.retrieve", FakeStripe.apiError(503));
    const failed = await resync(down.subscription.id);
    expect(failed.status).toBe(502);
    expectResponseToMatch("adminResyncSubscription", failed, { document: "platform" });
    expect(await subscriptionRow(down.subscription.id)).toMatchObject({ status: "active" });
    expect(await auditOf("subscription", down.subscription.id, "subscription.resynced")).toEqual([]);
  });
});

// ---- Invoices (PF-89, lead decision (2g) of 2026-11-04) ----------------------------------------------------------

describe("adminListInvoices", () => {
  /** An invoice of `ota` issued `daysAgo` days before the FakeClock, of `total` in `currency`, stored with 2 decimals. */
  async function insertInvoice(
    ota: BilledOta,
    invoice: {
      readonly currency: string;
      readonly total: string;
      readonly status: string;
      readonly daysAgo: number;
    },
  ): Promise<string> {
    const n = next++;
    const issuedAt = new Date(t.clock.now().getTime() - invoice.daysAgo * DAY_MS);
    await insertRow(pool, "invoices", {
      id: testId("inv", n),
      tenant_id: ota.tenant.id,
      subscription_id: ota.subscription.id,
      number: `VXTEST-PBE048-${n}`,
      status: invoice.status,
      currency: invoice.currency,
      subtotal: invoice.total,
      tax_amount: "0.00",
      total: invoice.total,
      amount_paid: invoice.status === "paid" ? invoice.total : "0.00",
      amount_due: invoice.status === "paid" ? "0.00" : invoice.total,
      issued_at: issuedAt,
      provider_invoice_id: `in_TestPbe048N${n}`,
      hosted_invoice_url: `https://invoice.stripe.com/i/acct_test_velexis/test_${n}`,
      invoice_pdf_url: `https://pay.stripe.com/invoice/acct_test_velexis/test_${n}/pdf`,
      created_at: issuedAt,
    });
    return testId("inv", n);
  }

  it("[PBE-048] lists every OTA's invoices newest first, with the decimals of their currency: 5000 JPY, 49.00 EUR", async () => {
    await pool.query("DELETE FROM platform.invoices");
    const yen = await arrangeBilledOta("active", "active");
    const euro = await arrangeBilledOta("active", "active");
    const yenInvoice = await insertInvoice(yen, {
      currency: "JPY",
      total: "5000.00",
      status: "paid",
      daysAgo: 1,
    });
    const euroInvoice = await insertInvoice(euro, {
      currency: "EUR",
      total: "49.00",
      status: "open",
      daysAgo: 2,
    });
    const older = await insertInvoice(euro, { currency: "EUR", total: "49.00", status: "paid", daysAgo: 40 });

    const all = await t.http.get("/v1/admin/invoices").set(await adminHeaders());
    expect(all.status).toBe(200);
    expectResponseToMatch("adminListInvoices", all, { document: "platform" });
    const body = all.body as { data: Row[]; page: Row };
    expect(body.data.map((row) => row["id"])).toEqual([yenInvoice, euroInvoice, older]);
    expect(body.data[0]).toMatchObject({
      tenantId: yen.tenant.id,
      subscriptionId: yen.subscription.id,
      total: { amount: "5000", currency: "JPY" },
      amountPaid: { amount: "5000", currency: "JPY" },
      amountDue: { amount: "0", currency: "JPY" },
    });
    expect(body.data[1]).toMatchObject({ total: { amount: "49.00", currency: "EUR" }, status: "open" });
    expect(body.page).toEqual({ nextCursor: null, limit: 50 });

    // The detail of a subscription answers its invoices the same way.
    const detail = await t.http
      .get(`/v1/admin/subscriptions/${yen.subscription.id}`)
      .set(await adminHeaders());
    expect(detail.status).toBe(200);
    expectResponseToMatch("adminGetSubscription", detail, { document: "platform" });
    expect((detail.body as { invoices: Row[] }).invoices).toEqual([
      expect.objectContaining({ id: yenInvoice, total: { amount: "5000", currency: "JPY" } }),
    ]);

    // The filters, and a page at a time.
    const byTenant = await t.http
      .get(`/v1/admin/invoices?tenantId=${euro.tenant.id}&status=paid`)
      .set(await adminHeaders());
    expect((byTenant.body as { data: Row[] }).data.map((row) => row["id"])).toEqual([older]);
    const first = await t.http.get("/v1/admin/invoices?limit=2").set(await adminHeaders());
    const firstBody = first.body as { data: Row[]; page: { nextCursor: string | null } };
    expect(firstBody.data.map((row) => row["id"])).toEqual([yenInvoice, euroInvoice]);
    expect(firstBody.page.nextCursor).not.toBeNull();
    const second = await t.http
      .get(`/v1/admin/invoices?limit=2&cursor=${firstBody.page.nextCursor ?? ""}`)
      .set(await adminHeaders());
    expectResponseToMatch("adminListInvoices", second, { document: "platform" });
    expect(second.body).toMatchObject({
      data: [expect.objectContaining({ id: older })],
      page: { nextCursor: null },
    });
  });

  it("answers 400 for a cursor that is not one of this list, and 401 without an admin token", async () => {
    const res = await t.http.get("/v1/admin/invoices?cursor=bm90LWEtY3Vyc29y").set(await adminHeaders());
    expect(res.status).toBe(400);
    expectResponseToMatch("adminListInvoices", res, { document: "platform" });
    expect(errorOf(res)).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [expect.objectContaining({ path: "/query/cursor" })],
    });
    const anonymous = await t.http.get("/v1/admin/invoices").set(t.bffHeaders(ADMIN_IP));
    expect(anonymous.status).toBe(401);
  });
});

// ---- The Stripe webhook inbox (PF-89) -------------------------------------------------------------------------------

describe("adminListStripeEvents", () => {
  it("[PBE-048] lists failed and ignored events first, each group newest first, with the filters and the cursor", async () => {
    await pool.query("DELETE FROM platform.stripe_events");
    const ota = await arrangeBilledOta("active", "active");
    const processed = await insertEvent({ status: "processed", minutesAgo: 1, tenantId: ota.tenant.id });
    const failed = await insertEvent({
      status: "failed",
      minutesAgo: 30,
      lastError: "UNKNOWN_PRICE: price_TestPbe048X is linked to no plan",
      final: true,
      tenantId: ota.tenant.id,
    });
    const ignored = await insertEvent({ status: "ignored", minutesAgo: 10, type: "invoice.created" });
    const received = await insertEvent({ status: "received", minutesAgo: 5 });

    const all = await t.http.get("/v1/admin/stripe-events").set(await adminHeaders());
    expect(all.status).toBe(200);
    expectResponseToMatch("adminListStripeEvents", all, { document: "platform" });
    const body = all.body as { data: Row[] };
    expect(body.data.map((row) => row["id"])).toEqual([ignored.id, failed.id, processed.id, received.id]);
    expect(body.data[1]).toMatchObject({
      endpoint: "billing",
      type: "customer.subscription.updated",
      status: "failed",
      attempts: 1,
      lastError: "UNKNOWN_PRICE: price_TestPbe048X is linked to no plan",
      tenantId: ota.tenant.id,
    });

    const filtered = await t.http
      .get(
        `/v1/admin/stripe-events?tenantId=${ota.tenant.id}&type=customer.subscription.updated&status=failed`,
      )
      .set(await adminHeaders());
    expect((filtered.body as { data: Row[] }).data.map((row) => row["id"])).toEqual([failed.id]);

    const first = await t.http.get("/v1/admin/stripe-events?limit=3").set(await adminHeaders());
    const firstBody = first.body as { data: Row[]; page: { nextCursor: string | null } };
    expect(firstBody.data.map((row) => row["id"])).toEqual([ignored.id, failed.id, processed.id]);
    const second = await t.http
      .get(`/v1/admin/stripe-events?limit=3&cursor=${firstBody.page.nextCursor ?? ""}`)
      .set(await adminHeaders());
    expectResponseToMatch("adminListStripeEvents", second, { document: "platform" });
    expect(second.body).toMatchObject({
      data: [expect.objectContaining({ id: received.id })],
      page: { nextCursor: null },
    });

    const badCursor = await t.http.get("/v1/admin/stripe-events?cursor=e30").set(await adminHeaders());
    expect(badCursor.status).toBe(400);
  });
});

describe("adminReprocessStripeEvent", () => {
  it("[PBE-048 AC2] a subscription event that failed for an unlinked price is processed once the price is linked and the event reprocessed", async () => {
    const proCode = await newPlan();
    const proPrice = newPriceId("Pro");
    stripe.put(stripePrice(proPrice));
    const ota = await arrangeBilledOta("active", "active", proPrice);
    const eventId = `evt_test_pbe048_unlinked_${next++}`;
    const { payload, header } = signedStripeEvent(
      "customer.subscription.updated",
      { id: eventId, data: { object: { id: ota.ids.subscriptionId } } },
      SECRET,
      { timestamp: t.clock.now() },
    );
    const posted = await t.http
      .post(PATH)
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", header)
      .send(payload);
    expect(posted.status).toBe(200);
    const failed = await doneWith(eventId, 1);
    expect(failed).toMatchObject({ status: "failed", tenant_id: ota.tenant.id });
    expect(String(failed["last_error"])).toMatch(/^UNKNOWN_PRICE: /);
    expect(await subscriptionRow(ota.subscription.id)).toMatchObject({ plan_code: GROWTH.code });

    // The admin links the price to its plan, then runs the event again.
    const linked = await patchPlan(proCode, await versionOf(proCode), { stripePriceIdMonth: proPrice });
    expect(linked.status).toBe(200);
    const res = await reprocess(eventId);
    expect(res.status).toBe(202);
    expectResponseToMatch("adminReprocessStripeEvent", res, { document: "platform" });

    const done = await doneWith(eventId, 2);
    expect(done).toMatchObject({ status: "processed", last_error: null });
    expect(await subscriptionRow(ota.subscription.id)).toMatchObject({
      plan_code: proCode,
      provider_price_id: proPrice,
    });
    expect(await tenantRow(ota.tenant.id)).toMatchObject({ plan_code: proCode });
    const [audit] = await auditOf("stripe_event", eventId, "stripe_event.reprocessed");
    expect(audit).toMatchObject({
      actor_type: "platform_admin",
      actor_account_id: admin,
      tenant_id: ota.tenant.id,
    });
    expect(audit?.["details"]).toMatchObject({
      endpoint: "billing",
      type: "customer.subscription.updated",
      attempts: 1,
      before: { status: "failed" },
      after: { status: "received" },
    });
  });

  it("[PBE-048 AC2] a failed invoice event links its invoice to the subscription's row written since", async () => {
    const ota = await arrangeBilledOta("active", "active");
    const invoiceId = `in_TestPbe048Late${next++}`;
    const base = stripeFixture("invoice.paid").data.object;
    stripe.put({
      ...base,
      id: invoiceId,
      number: `VXTEST-PBE048-LATE-${next++}`,
      customer: ota.ids.customerId,
      currency: "eur",
      parent: {
        type: "subscription_details",
        quote_details: null,
        subscription_details: { metadata: {}, subscription: ota.ids.subscriptionId },
      },
    } as Stripe.Invoice & { id: string });
    // The event failed for good while the subscription had no row yet (lead decision (2h) of 2026-11-04).
    const event = await insertEvent({
      status: "failed",
      type: "invoice.paid",
      objectType: "invoice",
      objectId: invoiceId,
      attempts: 5,
      lastError: "SUBSCRIPTION_NOT_FOUND: no row of the invoice's subscription yet",
      final: true,
    });

    const res = await reprocess(event.id);

    expect(res.status).toBe(202);
    expect(await doneWith(event.id, 6)).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    expect(
      await one("SELECT subscription_id, tenant_id FROM platform.invoices WHERE provider_invoice_id = $1", [
        invoiceId,
      ]),
    ).toEqual({ subscription_id: ota.subscription.id, tenant_id: ota.tenant.id });
  });

  it("runs an ignored event again too, replacing the job BullMQ keeps for it", async () => {
    const event = await insertEvent({
      status: "ignored",
      type: "invoice.created",
      lastError: "UNHANDLED_EVENT_TYPE: …",
    });
    await stripeEvents.add("stripe.event", { eventId: event.id }, { jobId: event.id });
    const kept = await stripeEvents.getJob(event.id);
    await vi.waitFor(async () => expect(await kept?.getState()).toBe("completed"), WAIT);

    const res = await reprocess(event.id);

    expect(res.status).toBe(202);
    // The new attempt ran (attempts + 1): the completed job was removed and a new one queued.
    expect(await doneWith(event.id, 2)).toMatchObject({ status: "ignored" });
  });

  it("answers 409 with the status of an event that is not failed or ignored, 404 for an unknown one, and changes nothing", async () => {
    for (const status of ["processed", "received", "processing"]) {
      const event = await insertEvent({ status, minutesAgo: status === "processing" ? 1 : 0 });
      const res = await reprocess(event.id);
      expect(res.status).toBe(409);
      expectResponseToMatch("adminReprocessStripeEvent", res, { document: "platform" });
      expect(errorOf(res)).toMatchObject({ code: "CONFLICT", details: { reason: status } });
      expect(await eventRow(event.id)).toMatchObject({ status, attempts: event.attempts });
      expect(await auditOf("stripe_event", event.id, "stripe_event.reprocessed")).toEqual([]);
    }
    const unknown = await reprocess("evt_test_pbe048_unknown");
    expect(unknown.status).toBe(404);
  });
});
