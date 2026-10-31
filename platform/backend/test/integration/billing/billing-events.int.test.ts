// Billing events with re-fetch and the status rules (PBE-045; subscription-billing flow §D and §E, PADR-0002 items 1,
// 5, 6 and 7, PADR-0014, scope PF-73 AC1 and PF-74, lead decision (5) of 2026-10-24): the X-028 fixtures of
// `checkout.session.completed` and `customer.subscription.updated`, signed with a secret made for this file, are
// posted to `POST /webhooks/stripe/billing` of the API (createTestApp, FEATURE_STRIPE_BILLING on), and the worker's
// module graph (WorkerModule, as dist/worker.js builds it, with the API's FakeClock) processes them on this file's
// database clone and Redis database. Stripe is the FakeStripe of test/support/fake-stripe.ts: the handlers re-fetch
// the Checkout Session and the subscription from it, so each test puts there what Stripe would answer, and the event
// payloads carry only the fixture (the handlers never read them).
//
// Each test arranges OTAs of its own with the builders (ids of this file's range, so the invalidations of other test
// files on the same Redis server never match), delivers one event at a time and waits until its inbox row is done.
// The tests of FIX-W30-PLATFORM (the last block) deliver two events at once, which the worker (concurrency 2) runs
// together, and hold one of them at a barrier: a re-fetch whose answer reaches the handler only when the test says,
// or a repository call inside a transaction; the admin's manual edit runs through the API at the same time. The tests
// of FIX-W31-PLATFORM (after them) run the API's CheckoutService.start beside a `checkout.session.completed` of the same
// pending row, one of them held at a barrier inside its transaction.
// Nothing answers `ota-tenant-ops` here: a dispatched job stays `running`, and its message waits in the queue, where
// the tests count it. The job schedulers are not registered (JobSchedulerRegistry replaced), so the reconciler never
// dispatches anything behind the tests' backs. The Stripe keys are the development values of `.env.example`.
import { randomBytes, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { DiscoveryService } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import {
  bullmqJobId,
  INVALIDATION_CHANNEL,
  OTA_TENANT_OPS,
  validateJob,
  type InvalidationEvent,
} from "@velexis/api-types/jobs";
import { sql } from "@velexis/db";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail } from "@velexis/testing/mailpit";
import { signedStripeEvent, stripeFixture } from "@velexis/testing/stripe";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PlatformTransaction } from "../../../src/audit/audit.repository";
import { TokenService } from "../../../src/auth/token.service";
import { CheckoutService, type CheckoutPlan } from "../../../src/billing/checkout.service";
import { SubscriptionsRepository } from "../../../src/billing/subscriptions.repository";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { StripeClient } from "../../../src/common/stripe/stripe.client";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { ProvisioningDispatcher } from "../../../src/provisioning/dispatcher";
import { ReconcilerScheduler } from "../../../src/provisioning/reconciler.scheduler";
import { SuspensionService } from "../../../src/provisioning/suspension.service";
import { TenantEventsProcessor } from "../../../src/provisioning/tenant-events.processor";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertPlan,
  insertRow,
  insertSubscription,
  testId,
  type PlatformRow,
  type SubscriptionRow,
  type TenantRow,
} from "../../builders/platform-rows";
import { insertOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FakeStripe } from "../../support/fake-stripe";

/**
 * The database clone, the API's and the worker's Nest module graphs, the platform document and the job validators;
 * the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish an event (it takes milliseconds; under Vitest's 5 s). */
const WAIT = { timeout: 4_000, interval: 20 } as const;
/** How long a test waits for an invalidation published after a commit. */
const EVENT_WAIT = { timeout: 3_000, interval: 20 } as const;

/** The signing secret of `/webhooks/stripe/billing` in this file only. */
const SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
const PATH = "/webhooks/stripe/billing";
/** The switched-on application: the development Stripe key of `.env.example` (nothing reaches Stripe). */
const STRIPE_ENV = Object.freeze({
  FEATURE_STRIPE_BILLING: "true",
  STRIPE_SECRET_KEY: "sk_test_replace_me",
  STRIPE_BILLING_WEBHOOK_SECRET: SECRET,
});
/** The plans of this file and their Stripe Prices (Stripe's id shape, as the `plans` columns allow it). */
const GROWTH = { code: "growth", month: "price_TestPbe045GrowthMonth", year: "price_TestPbe045GrowthYear" };
const STARTER = { code: "starter", month: "price_TestPbe045StarterMonth" };
/** A price no plan links. */
const UNLINKED_PRICE = "price_TestPbe045Unlinked";
/** The first number of this file's ids (`testId`), away from the other test files'. */
const FIRST_ID = 45_000;
const DAY_S = 24 * 60 * 60;
const DAY_MS = DAY_S * 1000;
const FAMILY = testId("asn", FIRST_ID);

type Row = Record<string, unknown>;

const stripe = new FakeStripe();
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let tenantOps: Queue;
let subscriber: Redis;
let tokens: TokenService;
const invalidations: InvalidationEvent[] = [];
const workerLogs = new LogSink();
let next = FIRST_ID;

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs, the invalidation subscriber, the platform
  // document of expectResponseToMatch, the job validators a dispatch compiles on its first call and the fixtures.
  t = await createTestApp({ env: STRIPE_ENV, overrides: [{ provide: StripeClient, useValue: stripe }] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tenantOps = t.app.get<Queue>(getQueueToken(OTA_TENANT_OPS), { strict: false });
  tokens = t.app.get(TokenService);
  responseChecker("platform");
  validateJob("tenant.provision", provisionFixture);
  stripeFixture("checkout.session.completed");
  stripeFixture("customer.subscription.updated");

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

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    invalidations.push(JSON.parse(message) as InvalidationEvent);
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);

  await insertPlan(pool, {
    code: GROWTH.code,
    stripe_price_id_month: GROWTH.month,
    stripe_price_id_year: GROWTH.year,
  });
  await insertPlan(pool, { code: STARTER.code, stripe_price_id_month: STARTER.month });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

// ---- Stripe objects and events -----------------------------------------------------------------------------------

/** The Stripe ids of one Checkout of this file. */
interface StripeIds {
  readonly sessionId: string;
  readonly subscriptionId: string;
  /** As `billing_customers` allows it: `cus_`, letters and digits. */
  readonly customerId: string;
}

function stripeIds(): StripeIds {
  const n = next++;
  return {
    sessionId: `cs_test_pbe045_${n}`,
    subscriptionId: `sub_test_pbe045_${n}`,
    customerId: `cus_TestPbe045N${n}`,
  };
}

/** What a subscription of a test is, besides its ids. */
interface SubscriptionShape {
  readonly status: Stripe.Subscription.Status;
  readonly priceId?: string;
  /** `metadata.velexis_subscription_id`: the pre-inserted row of an OTA created in M5. */
  readonly pendingRowId?: string;
  readonly trialEnd?: number | null;
}

/** The fixture's subscription as Stripe answers a retrieve: `ids`, the OTA's metadata and `shape`. */
function stripeSubscription(ids: StripeIds, tenantId: string, shape: SubscriptionShape): Stripe.Subscription {
  const base = stripeFixture("customer.subscription.updated").data.object;
  const [item] = base.items.data;
  if (item === undefined) {
    throw new Error("the subscription fixture has no item");
  }
  const priceId = shape.priceId ?? GROWTH.month;
  const canceled = shape.status === "canceled";
  return {
    ...base,
    id: ids.subscriptionId,
    customer: ids.customerId,
    status: shape.status,
    trial_end: shape.trialEnd ?? null,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: canceled ? base.created + 30 * DAY_S : null,
    latest_invoice: null,
    metadata: {
      velexis_tenant_id: tenantId,
      velexis_plan_code: GROWTH.code,
      ...(shape.pendingRowId === undefined ? {} : { velexis_subscription_id: shape.pendingRowId }),
    },
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

/** The fixture's completed Checkout Session of `ids` for `tenantId`, as Stripe answers a retrieve. */
function checkoutSession(
  ids: StripeIds,
  tenantId: string,
  options: {
    readonly pendingRowId?: string;
    readonly email: string;
    readonly mode?: "subscription" | "payment";
  },
): Stripe.Checkout.Session {
  const base = stripeFixture("checkout.session.completed").data.object;
  return {
    ...base,
    id: ids.sessionId,
    mode: options.mode ?? "subscription",
    client_reference_id: tenantId,
    customer: ids.customerId,
    customer_details:
      base.customer_details === null ? null : { ...base.customer_details, email: options.email },
    invoice: null,
    subscription: options.mode === "payment" ? null : ids.subscriptionId,
    metadata: {
      velexis_tenant_id: tenantId,
      velexis_plan_code: GROWTH.code,
      ...(options.pendingRowId === undefined ? {} : { velexis_subscription_id: options.pendingRowId }),
    },
    cancel_url: `https://platform.example.com/otas/${tenantId}/billing?checkout=canceled`,
    success_url: `https://platform.example.com/otas/${tenantId}/setup?checkout=success`,
  };
}

/** A new event id of the fixtures' shape. */
const newEventId = (label: string): string => `evt_test_pbe045_${label}_${next++}`;

/** A signed delivery: the fixture of `type` whose object is `objectId`, with the event id `eventId`. */
interface Delivery {
  readonly eventId: string;
  readonly payload: string;
  readonly header: string;
}

function checkoutEvent(sessionId: string, eventId = newEventId("checkout")): Delivery {
  const { payload, header } = signedStripeEvent(
    "checkout.session.completed",
    { id: eventId, data: { object: { id: sessionId } } },
    SECRET,
    { timestamp: t.clock.now() },
  );
  return { eventId, payload, header };
}

function subscriptionEvent(
  subscriptionId: string,
  eventId = newEventId("subscription"),
  type: "customer.subscription.updated" | "customer.subscription.deleted" = "customer.subscription.updated",
): Delivery {
  const { payload, header } = signedStripeEvent(
    "customer.subscription.updated",
    // The `…deleted` event is the fixture of `…updated` under the other type: its payload is never read.
    { id: eventId, type: type as "customer.subscription.updated", data: { object: { id: subscriptionId } } },
    SECRET,
    { timestamp: t.clock.now() },
  );
  return { eventId, payload, header };
}

/** Posts `delivery` as Stripe does and waits until the worker is done with it; answers its inbox row. */
async function deliver(delivery: Delivery): Promise<Row> {
  const res = await t.http
    .post(PATH)
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", delivery.header)
    .send(delivery.payload);
  expect(res.status).toBe(200);
  return vi.waitFor(async () => {
    const row = (await rowsOf("SELECT * FROM platform.stripe_events WHERE id = $1", [delivery.eventId]))[0];
    expect(["processed", "ignored", "failed"]).toContain(row?.["status"]);
    return row as Row;
  }, WAIT);
}

// ---- Rows ----------------------------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[]): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const tenantOf = async (tenantId: string): Promise<Row> =>
  (await rowsOf("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]))[0] as Row;

const subscriptionsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf("SELECT * FROM platform.subscriptions WHERE tenant_id = $1 ORDER BY created_at, id", [tenantId]);

const jobsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT id, kind, status, attempt, requested_by_account_id, payload FROM platform.provisioning_jobs " +
      "WHERE tenant_id = $1 ORDER BY created_at, id",
    [tenantId],
  );

const auditOf = (tenantId: string, action: string): Promise<Row[]> =>
  rowsOf("SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id", [
    tenantId,
    action,
  ]);

const emailsOf = (tenantId: string, template: string): Promise<Row[]> =>
  rowsOf("SELECT template, to_email FROM platform.email_outbox WHERE tenant_id = $1 AND template = $2", [
    tenantId,
    template,
  ]);

/** The `ota-tenant-ops` messages of the job `jobId` (one per dispatched attempt), by attempt. */
async function messagesOf(jobId: string): Promise<Array<{ name: string; attempt: number }>> {
  const found: Array<{ name: string; attempt: number }> = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const job = await tenantOps.getJob(bullmqJobId(jobId, attempt));
    if (job !== undefined) {
      found.push({ name: job.name, attempt });
    }
  }
  return found;
}

/** Waits for the `tenant` invalidation of `tenantId`. */
async function expectTenantInvalidation(tenantId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(invalidations).toContainEqual({ v: 1, type: "tenant", id: tenantId });
  }, EVENT_WAIT);
}

/** An owner of this file (an address of this test only). */
const newOwner = (): Promise<PlatformRow<"accounts">> =>
  insertAccount(pool, { id: testId("acc", next++), email: uniqueEmail("owner-pbe045") });

/** An OTA of this file with `owner` and `subscription`. */
async function arrangeOta(
  owner: PlatformRow<"accounts">,
  tenant: Partial<TenantRow>,
  subscription: Partial<SubscriptionRow>,
): Promise<{ readonly tenant: PlatformRow<"tenants">; readonly subscription: PlatformRow<"subscriptions"> }> {
  const n = next++;
  const ota = await insertOta(pool, {
    tenant: { id: testId("ten", n), key: `pbe${n}`, ...tenant },
    // A day before the FakeClock's now, so it sorts before the rows billing sync writes at that time.
    subscription: {
      id: testId("sub", n),
      created_at: new Date(t.clock.now().getTime() - DAY_MS),
      ...subscription,
    },
    members: [[owner, "owner"]],
  });
  if (ota.subscription === undefined) {
    throw new Error("arrangeOta: the subscription was not written");
  }
  return { tenant: ota.tenant, subscription: ota.subscription };
}

/** A `provision` job of `tenantId`: `queued` and due at the FakeClock's time, unless `job` says otherwise. */
async function insertProvisionJob(
  tenantId: string,
  job: Readonly<Record<string, unknown>> = {},
): Promise<PlatformRow<"provisioning_jobs">> {
  const now = t.clock.now();
  return insertRow(pool, "provisioning_jobs", {
    id: testId("job", next++),
    tenant_id: tenantId,
    kind: "provision",
    status: "queued",
    attempt: 0,
    scheduled_at: now,
    created_at: now,
    updated_at: now,
    ...job,
  });
}

/** The trial end of this file's Checkouts: 14 days after the FakeClock's now, in Stripe's Unix seconds. */
const trialEndOf = (): number => Math.floor(t.clock.now().getTime() / 1000) + 14 * DAY_S;

/**
 * An OTA created in M5 that waits for its Checkout (PBE-044): `provisioning` on `growth`, the pre-inserted `incomplete`
 * Stripe row with the Session's id, a `queued` provision job, an owner; and the Session and the subscription Stripe
 * answers once the owner has paid (`status`, the Customer of `ids`).
 */
async function arrangeNewOta(ids: StripeIds, status: Stripe.Subscription.Status = "trialing") {
  const owner = await newOwner();
  const { tenant, subscription } = await arrangeOta(
    owner,
    { status: "provisioning", plan_code: GROWTH.code, activated_at: null },
    {
      plan_code: GROWTH.code,
      status: "incomplete",
      billing_provider: "stripe",
      trial_ends_at: null,
      checkout_session_id: ids.sessionId,
    },
  );
  const job = await insertProvisionJob(tenant.id);
  const trialEnd = trialEndOf();
  stripe.put(
    checkoutSession(ids, tenant.id, { pendingRowId: subscription.id, email: owner.email }),
    stripeSubscription(ids, tenant.id, { status, pendingRowId: subscription.id, trialEnd }),
  );
  return { owner, tenant, row: subscription, job };
}

/**
 * An active OTA that pays the Stripe subscription of `ids` (`active`, unless `subscription` says otherwise), with the
 * row billing sync wrote for it.
 */
async function arrangePayingOta(
  ids: StripeIds,
  tenant: Partial<TenantRow> = {},
  subscription: Partial<SubscriptionRow> = {},
) {
  const owner = await newOwner();
  const ota = await arrangeOta(
    owner,
    { plan_code: GROWTH.code, ...tenant },
    {
      plan_code: GROWTH.code,
      status: "active",
      billing_provider: "stripe",
      trial_ends_at: null,
      provider_customer_id: ids.customerId,
      provider_subscription_id: ids.subscriptionId,
      provider_price_id: GROWTH.month,
      checkout_session_id: ids.sessionId,
      ...subscription,
    },
  );
  return { owner, ...ota };
}

/** Puts the subscription of `ids` with `status` into the FakeStripe, as Stripe would answer a re-fetch now. */
function stripeNow(ids: StripeIds, tenantId: string, shape: SubscriptionShape): void {
  stripe.put(stripeSubscription(ids, tenantId, shape));
}

/** The headers of a portal call by `accountId`. */
async function portalHeaders(accountId: string): Promise<Record<string, string>> {
  const { token } = await tokens.sign({ aud: "portal", sub: accountId, sid: FAMILY, ev: true, amr: ["pwd"] });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders("203.0.113.45") };
}

// ---- Tests ---------------------------------------------------------------------------------------------------------

describe("checkout.session.completed and customer.subscription.* (worker)", () => {
  it("[PBE-045 AC1] gives the same final rows when the fixture events come twice and in reverse order [PF-73 AC1]", async () => {
    const forwardIds = stripeIds();
    const reverseIds = stripeIds();
    const forward = await arrangeNewOta(forwardIds);
    const reverse = await arrangeNewOta(reverseIds);
    const checkoutCalls = stripe.callsOf("checkout.sessions.retrieve").length;

    // Forward: the Checkout, then the subscription; each delivered twice (Stripe's retry of one event id) and once more
    // under a new event id (another event about the same object), which is processed again.
    const forwardEvents = [checkoutEvent(forwardIds.sessionId), subscriptionEvent(forwardIds.subscriptionId)];
    for (const delivery of [
      ...forwardEvents,
      ...forwardEvents,
      checkoutEvent(forwardIds.sessionId),
      subscriptionEvent(forwardIds.subscriptionId),
    ]) {
      expect(await deliver(delivery)).toMatchObject({ status: "processed", tenant_id: forward.tenant.id });
    }
    // Reverse: the subscription first, then the Checkout, the same way.
    const reverseEvents = [subscriptionEvent(reverseIds.subscriptionId), checkoutEvent(reverseIds.sessionId)];
    for (const delivery of [
      ...reverseEvents,
      ...reverseEvents,
      subscriptionEvent(reverseIds.subscriptionId),
      checkoutEvent(reverseIds.sessionId),
    ]) {
      expect(await deliver(delivery)).toMatchObject({ status: "processed", tenant_id: reverse.tenant.id });
    }

    // The handlers re-fetched: the Checkout Session, and its subscription under the subscription's lock
    // (FIX-W30-PLATFORM: no longer expanded with the session, which is fetched before the lock).
    expect(stripe.callsOf("checkout.sessions.retrieve").slice(checkoutCalls)).toEqual(
      [forwardIds.sessionId, forwardIds.sessionId, reverseIds.sessionId, reverseIds.sessionId].map((id) =>
        expect.objectContaining({ id, params: undefined }),
      ),
    );
    for (const ids of [forwardIds, reverseIds]) {
      // Four re-fetches of the subscription: two by its own events and two by the Checkout's.
      expect(
        stripe.callsOf("subscriptions.retrieve").filter((call) => call.id === ids.subscriptionId),
      ).toHaveLength(4);
    }
    const finalRows = async (ota: typeof forward, ids: StripeIds) => {
      const values = new Map<string, string>([
        [ota.tenant.id, "<tenant>"],
        [ota.row.id, "<row>"],
        [ota.job.id, "<job>"],
        [ids.sessionId, "<session>"],
        [ids.subscriptionId, "<subscription>"],
        [ids.customerId, "<customer>"],
        [ota.owner.email, "<email>"],
      ]);
      const normalise = (rows: Row[]): Row[] =>
        rows.map((row) =>
          Object.fromEntries(
            Object.entries(row)
              // `created_at` of the rows the builders wrote is the database's time, not the FakeClock's.
              .filter(([column]) => column !== "created_at")
              .map(([column, value]) => [
                column,
                typeof value === "string" ? (values.get(value) ?? value) : value,
              ]),
          ),
        );
      const tenant = await tenantOf(ota.tenant.id);
      return {
        tenant: {
          status: tenant["status"],
          plan_code: tenant["plan_code"],
          billing_notice: tenant["billing_notice"],
          suspension_reason: tenant["suspension_reason"],
          version: tenant["version"],
        },
        subscriptions: normalise(await subscriptionsOf(ota.tenant.id)),
        customers: normalise(
          await rowsOf("SELECT * FROM platform.billing_customers WHERE tenant_id = $1", [ota.tenant.id]),
        ),
        jobs: normalise(await jobsOf(ota.tenant.id)),
        messages: await messagesOf(ota.job.id),
      };
    };
    const forwardRows = await finalRows(forward, forwardIds);
    const reverseRows = await finalRows(reverse, reverseIds);

    expect(reverseRows).toEqual(forwardRows);
    // And they are the paid Checkout's: the row filled once (version 2), the Customer stored, provisioning started once.
    const trialEnd = new Date(trialEndOf() * 1000);
    expect(forwardRows.subscriptions).toEqual([
      expect.objectContaining({
        id: "<row>",
        status: "trialing",
        plan_code: GROWTH.code,
        billing_interval: "month",
        billing_provider: "stripe",
        provider_customer_id: "<customer>",
        provider_subscription_id: "<subscription>",
        provider_price_id: GROWTH.month,
        checkout_session_id: "<session>",
        trial_ends_at: trialEnd,
        current_period_start: new Date(1791795895 * 1000),
        current_period_end: new Date(1794474295 * 1000),
        cancel_at_period_end: false,
        canceled_at: null,
        provider_synced_at: t.clock.now(),
        version: 2,
      }),
    ]);
    expect(forwardRows.customers).toEqual([
      expect.objectContaining({
        tenant_id: "<tenant>",
        provider_customer_id: "<customer>",
        livemode: false,
        billing_email: "<email>",
      }),
    ]);
    expect(forwardRows.tenant).toEqual({
      status: "provisioning",
      plan_code: GROWTH.code,
      billing_notice: null,
      suspension_reason: null,
      version: 1,
    });
    expect(forwardRows.jobs).toEqual([
      expect.objectContaining({ id: "<job>", kind: "provision", status: "running", attempt: 1 }),
    ]);
    expect(forwardRows.messages).toEqual([{ name: "tenant.provision", attempt: 1 }]);
  });

  it("[PBE-045 AC2] dispatches provisioning exactly once for a completed Checkout delivered again and again", async () => {
    const ids = stripeIds();
    const { tenant, row, job } = await arrangeNewOta(ids, "active");
    const first = checkoutEvent(ids.sessionId);

    expect(await deliver(first)).toMatchObject({ status: "processed", tenant_id: tenant.id, attempts: 1 });
    expect(await deliver(first)).toMatchObject({ status: "processed", attempts: 1 });
    expect(await deliver(checkoutEvent(ids.sessionId))).toMatchObject({ status: "processed" });

    expect(await jobsOf(tenant.id)).toEqual([
      expect.objectContaining({ id: job.id, status: "running", attempt: 1 }),
    ]);
    expect(await messagesOf(job.id)).toEqual([{ name: "tenant.provision", attempt: 1 }]);
    const message = await tenantOps.getJob(bullmqJobId(job.id, 1));
    expect(message?.data).toMatchObject({ name: "tenant.provision", jobId: job.id, tenantId: tenant.id });
    // The message carries the Stripe event that caused it as its request id.
    expect((message?.data as { requestId?: string } | undefined)?.requestId).toBe(first.eventId);
    expect(await subscriptionsOf(tenant.id)).toEqual([
      expect.objectContaining({ id: row.id, status: "active", provider_subscription_id: ids.subscriptionId }),
    ]);
    // One audit row for the one change, by billing sync, with the event as request id.
    expect(await auditOf(tenant.id, "subscription.updated")).toEqual([
      expect.objectContaining({
        actor_type: "system",
        actor_label: "billing.sync",
        target_type: "subscription",
        target_id: row.id,
        request_id: first.eventId,
        details: expect.objectContaining({
          eventId: first.eventId,
          eventType: "checkout.session.completed",
          checkoutSessionId: ids.sessionId,
          customerId: ids.customerId,
          before: expect.objectContaining({ status: "incomplete", providerSubscriptionId: null }),
          after: expect.objectContaining({ status: "active", providerSubscriptionId: ids.subscriptionId }),
        }),
      }),
    ]);
  });

  it("[PBE-045 AC2] replaces the manual trial of an existing OTA with the Checkout's Stripe row in one transaction", async () => {
    const ids = stripeIds();
    const owner = await newOwner();
    const { tenant, subscription: manual } = await arrangeOta(
      owner,
      { billing_notice: "trial_ending" },
      { status: "trialing", billing_provider: "manual" },
    );
    // createCheckoutSession of an existing OTA writes no row and no `velexis_subscription_id` (flow §B item 2).
    stripe.put(
      checkoutSession(ids, tenant.id, { email: owner.email }),
      stripeSubscription(ids, tenant.id, { status: "active", priceId: STARTER.month }),
    );

    // Stripe sends the subscription's creation first: no row is its yet, so the event waits for the Checkout's.
    expect(await deliver(subscriptionEvent(ids.subscriptionId))).toMatchObject({
      status: "ignored",
      last_error: `UNKNOWN_SUBSCRIPTION: no row of ${ids.subscriptionId} yet; the completed Checkout writes it`,
      tenant_id: tenant.id,
    });
    const delivery = checkoutEvent(ids.sessionId);
    expect(await deliver(delivery)).toMatchObject({ status: "processed", tenant_id: tenant.id });

    const [manualAfter, stripeRow] = await subscriptionsOf(tenant.id);
    expect(manualAfter).toMatchObject({
      id: manual.id,
      billing_provider: "manual",
      status: "canceled",
      canceled_at: t.clock.now(),
      version: manual.version + 1,
    });
    expect(stripeRow).toMatchObject({
      billing_provider: "stripe",
      status: "active",
      plan_code: STARTER.code,
      provider_subscription_id: ids.subscriptionId,
      provider_price_id: STARTER.month,
      checkout_session_id: ids.sessionId,
      version: 1,
    });
    // The plan follows the price, the banner of the manual trial goes, and the active OTA is not provisioned again.
    expect(await tenantOf(tenant.id)).toMatchObject({
      status: "active",
      plan_code: STARTER.code,
      billing_notice: null,
      version: tenant.version + 2,
    });
    expect(await jobsOf(tenant.id)).toEqual([]);
    expect(await auditOf(tenant.id, "subscription.updated")).toEqual([
      expect.objectContaining({
        target_id: stripeRow?.["id"],
        details: expect.objectContaining({
          created: true,
          supersededSubscriptionIds: [manual.id],
          before: { tenantPlanCode: "early_access", billingNotice: "trial_ending" },
          after: expect.objectContaining({
            status: "active",
            planCode: STARTER.code,
            tenantPlanCode: STARTER.code,
            billingNotice: null,
          }),
        }),
      }),
    ]);
    await expectTenantInvalidation(tenant.id);
    // The subscription's later event finds the row now and changes nothing.
    expect(await deliver(subscriptionEvent(ids.subscriptionId))).toMatchObject({ status: "processed" });
    expect((await subscriptionsOf(tenant.id))[1]).toMatchObject({ version: 1 });
  });

  it("[PBE-045 AC3] past_due sets the banner, which the portal shows [PF-74 AC1]", async () => {
    const ids = stripeIds();
    const { owner, tenant, subscription } = await arrangePayingOta(ids);
    stripeNow(ids, tenant.id, { status: "past_due" });

    const delivery = subscriptionEvent(ids.subscriptionId);
    expect(await deliver(delivery)).toMatchObject({ status: "processed", tenant_id: tenant.id });

    expect(await tenantOf(tenant.id)).toMatchObject({
      status: "active",
      billing_notice: "past_due",
      version: tenant.version + 1,
    });
    expect(await subscriptionsOf(tenant.id)).toEqual([
      expect.objectContaining({ id: subscription.id, status: "past_due", version: subscription.version + 1 }),
    ]);
    await expectTenantInvalidation(tenant.id);
    expect(await auditOf(tenant.id, "subscription.updated")).toEqual([
      expect.objectContaining({
        request_id: delivery.eventId,
        details: expect.objectContaining({
          before: expect.objectContaining({ status: "active", billingNotice: null }),
          after: expect.objectContaining({ status: "past_due", billingNotice: "past_due" }),
        }),
      }),
    ]);
    // The portal's banner: the tenant's billing notice and the subscription's banner.
    const headers = await portalHeaders(owner.id);
    const ota = await t.http.get(`/v1/tenants/${tenant.id}`).set(headers);
    expect(ota.status).toBe(200);
    expectResponseToMatch("getTenant", ota, { document: "platform" });
    expect(ota.body).toMatchObject({ status: "active", billingNotice: "past_due" });
    const res = await t.http.get(`/v1/tenants/${tenant.id}/subscription`).set(headers);
    expect(res.status).toBe(200);
    expectResponseToMatch("getSubscription", res, { document: "platform" });
    expect(res.body).toMatchObject({ status: "past_due", banner: "past_due", canManageInStripe: true });
  });

  it("[PBE-045 AC3] unpaid suspends with reason billing and e-mails the owners, and active resumes it [PF-74 AC2]", async () => {
    const ids = stripeIds();
    const { owner, tenant } = await arrangePayingOta(ids, { billing_notice: "past_due" });

    stripeNow(ids, tenant.id, { status: "unpaid" });
    const unpaid = subscriptionEvent(ids.subscriptionId);
    expect(await deliver(unpaid)).toMatchObject({ status: "processed", tenant_id: tenant.id });

    expect(await tenantOf(tenant.id)).toMatchObject({
      status: "suspended",
      suspension_reason: "billing",
      suspended_at: t.clock.now(),
      billing_notice: "past_due",
    });
    const [suspendJob] = await jobsOf(tenant.id);
    expect(suspendJob).toMatchObject({
      kind: "suspend",
      status: "running",
      attempt: 1,
      requested_by_account_id: null,
      payload: { reason: "billing" },
    });
    expect(await messagesOf(String(suspendJob?.["id"]))).toEqual([{ name: "tenant.suspend", attempt: 1 }]);
    expect(await auditOf(tenant.id, "tenant.suspended")).toEqual([
      expect.objectContaining({
        actor_type: "system",
        actor_label: "billing.sync",
        request_id: unpaid.eventId,
        details: expect.objectContaining({ suspensionReason: "billing", jobId: suspendJob?.["id"] }),
      }),
    ]);
    expect(await emailsOf(tenant.id, "tenant.suspended")).toEqual([
      { template: "tenant.suspended", to_email: owner.email },
    ]);
    await expectTenantInvalidation(tenant.id);

    // The owner pays: Stripe's retry succeeds and the subscription is active again.
    stripeNow(ids, tenant.id, { status: "active" });
    expect(await deliver(subscriptionEvent(ids.subscriptionId))).toMatchObject({ status: "processed" });

    expect(await tenantOf(tenant.id)).toMatchObject({
      status: "active",
      suspension_reason: null,
      suspended_at: null,
      billing_notice: null,
    });
    const resumeJob = (await jobsOf(tenant.id)).find((job) => job["kind"] === "resume");
    expect(resumeJob).toMatchObject({ status: "running", attempt: 1, payload: {} });
    expect(await messagesOf(String(resumeJob?.["id"]))).toEqual([{ name: "tenant.resume", attempt: 1 }]);
    expect(await auditOf(tenant.id, "tenant.resumed")).toEqual([
      expect.objectContaining({ actor_type: "system", actor_label: "billing.sync" }),
    ]);
    expect(await emailsOf(tenant.id, "tenant.resumed")).toEqual([
      { template: "tenant.resumed", to_email: owner.email },
    ]);
  });

  it("[PBE-045 AC3] a canceled subscription (customer.subscription.deleted) suspends, and a later active never resumes an abuse suspension [PF-74 AC2]", async () => {
    const ids = stripeIds();
    const { tenant } = await arrangePayingOta(ids);
    stripeNow(ids, tenant.id, { status: "canceled" });

    const deleted = subscriptionEvent(
      ids.subscriptionId,
      newEventId("deleted"),
      "customer.subscription.deleted",
    );
    expect(await deliver(deleted)).toMatchObject({ status: "processed" });
    expect(await tenantOf(tenant.id)).toMatchObject({ status: "suspended", suspension_reason: "billing" });

    const abuseIds = stripeIds();
    const abused = await arrangePayingOta(abuseIds, {
      status: "suspended",
      suspension_reason: "abuse",
      suspended_at: t.clock.now(),
    });
    stripeNow(abuseIds, abused.tenant.id, { status: "active" });
    await pool.query("UPDATE platform.subscriptions SET status = 'unpaid' WHERE id = $1", [
      abused.subscription.id,
    ]);

    expect(await deliver(subscriptionEvent(abuseIds.subscriptionId))).toMatchObject({ status: "processed" });

    expect(await tenantOf(abused.tenant.id)).toMatchObject({
      status: "suspended",
      suspension_reason: "abuse",
    });
    expect(await subscriptionsOf(abused.tenant.id)).toEqual([expect.objectContaining({ status: "active" })]);
    expect(await jobsOf(abused.tenant.id)).toEqual([]);
    expect(await auditOf(abused.tenant.id, "tenant.resumed")).toEqual([]);
  });

  it("[PBE-045] re-dispatches a failed OTA whose owner paid through createCheckoutSession, once (lead decision 5)", async () => {
    const ids = stripeIds();
    const owner = await newOwner();
    // An abandoned Checkout (billing flow §H): the tenant failed, its row expired, its job canceled.
    const { tenant, subscription: expired } = await arrangeOta(
      owner,
      { status: "failed", plan_code: GROWTH.code, activated_at: null },
      {
        plan_code: GROWTH.code,
        status: "incomplete_expired",
        billing_provider: "stripe",
        trial_ends_at: null,
      },
    );
    const abandoned = await insertProvisionJob(tenant.id, {
      status: "canceled",
      error: "CHECKOUT_ABANDONED",
    });
    // createCheckoutSession: no current row, so no `velexis_subscription_id`.
    stripe.put(
      checkoutSession(ids, tenant.id, { email: owner.email }),
      stripeSubscription(ids, tenant.id, { status: "active" }),
    );

    const delivery = checkoutEvent(ids.sessionId);
    expect(await deliver(delivery)).toMatchObject({ status: "processed", tenant_id: tenant.id });
    expect(await deliver(checkoutEvent(ids.sessionId))).toMatchObject({ status: "processed" });

    expect(await tenantOf(tenant.id)).toMatchObject({ status: "provisioning", version: tenant.version + 1 });
    const [first, second] = await subscriptionsOf(tenant.id);
    expect(first).toMatchObject({ id: expired.id, status: "incomplete_expired", version: expired.version });
    expect(second).toMatchObject({ status: "active", provider_subscription_id: ids.subscriptionId });
    const jobs = await jobsOf(tenant.id);
    expect(jobs).toEqual([
      expect.objectContaining({ id: abandoned.id, status: "canceled" }),
      expect.objectContaining({
        kind: "provision",
        status: "running",
        attempt: 1,
        requested_by_account_id: null,
      }),
    ]);
    const retried = String(jobs[1]?.["id"]);
    expect(await messagesOf(retried)).toEqual([{ name: "tenant.provision", attempt: 1 }]);
    expect(await auditOf(tenant.id, "provisioning_job.retried")).toEqual([
      expect.objectContaining({
        actor_type: "system",
        actor_label: "billing.sync",
        target_id: retried,
        request_id: delivery.eventId,
        details: expect.objectContaining({
          kind: "provision",
          reason: "checkout_completed",
          checkoutSessionId: ids.sessionId,
          subscriptionId: second?.["id"],
          previousJobId: abandoned.id,
          previousError: "CHECKOUT_ABANDONED",
          before: { tenantStatus: "failed" },
          after: { tenantStatus: "provisioning" },
        }),
      }),
    ]);
    await expectTenantInvalidation(tenant.id);
  });

  it("[PBE-045] fails an event whose price is linked to no plan with UNKNOWN_PRICE, for good, and writes nothing", async () => {
    const ids = stripeIds();
    const { tenant, subscription } = await arrangePayingOta(ids);
    stripeNow(ids, tenant.id, { status: "past_due", priceId: UNLINKED_PRICE });

    expect(await deliver(subscriptionEvent(ids.subscriptionId))).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error: `UNKNOWN_PRICE: ${UNLINKED_PRICE} is linked to no plan`,
      tenant_id: tenant.id,
      processed_at: t.clock.now(),
    });
    expect(await subscriptionsOf(tenant.id)).toEqual([
      expect.objectContaining({ status: "active", version: subscription.version }),
    ]);
    expect(await tenantOf(tenant.id)).toMatchObject({ billing_notice: null, version: tenant.version });
  });

  it("[PBE-045 AC3] leaves an OTA that pays a newer subscription alone when a late event about its earlier, canceled one arrives", async () => {
    const earlierIds = stripeIds();
    const ids = stripeIds();
    const { tenant } = await arrangePayingOta(ids);
    // The OTA's earlier Stripe subscription, canceled before the current one began (its row a month older).
    const earlier = await insertSubscription(pool, tenant, {
      id: testId("sub", next++),
      plan_code: GROWTH.code,
      status: "canceled",
      billing_provider: "stripe",
      trial_ends_at: null,
      provider_customer_id: ids.customerId,
      provider_subscription_id: earlierIds.subscriptionId,
      provider_price_id: GROWTH.month,
      cancel_at_period_end: true,
      canceled_at: new Date(t.clock.now().getTime() - 31 * DAY_MS),
      created_at: new Date(t.clock.now().getTime() - 60 * DAY_MS),
    });
    stripeNow({ ...earlierIds, customerId: ids.customerId }, tenant.id, { status: "canceled" });

    const late = subscriptionEvent(
      earlierIds.subscriptionId,
      newEventId("late"),
      "customer.subscription.deleted",
    );
    expect(await deliver(late)).toMatchObject({ status: "processed", tenant_id: tenant.id });

    // The earlier row takes Stripe's state; the rules read the shown (current, active) subscription, not the event's.
    const rows = await subscriptionsOf(tenant.id);
    expect(rows.find((row) => row["id"] === earlier.id)).toMatchObject({
      status: "canceled",
      cancel_at_period_end: false,
      version: earlier.version + 1,
    });
    expect(rows.find((row) => row["provider_subscription_id"] === ids.subscriptionId)).toMatchObject({
      status: "active",
    });
    expect(await tenantOf(tenant.id)).toMatchObject({
      status: "active",
      suspension_reason: null,
      billing_notice: null,
      version: tenant.version,
    });
    expect(await jobsOf(tenant.id)).toEqual([]);
    expect(await auditOf(tenant.id, "tenant.suspended")).toEqual([]);
  });

  it("[PBE-045] fails for good and writes nothing on a second current Stripe subscription or a Customer, row or metadata of another OTA", async () => {
    const holderIds = stripeIds();
    const holder = await arrangePayingOta(holderIds);
    await insertRow(pool, "billing_customers", {
      tenant_id: holder.tenant.id,
      provider_customer_id: holderIds.customerId,
      livemode: false,
    });
    const failedFor = (code: string) =>
      expect.objectContaining({
        status: "failed",
        attempts: 1,
        last_error: expect.stringMatching(new RegExp(`^${code}: `)),
        processed_at: t.clock.now(),
      });

    // A Checkout of a second Stripe subscription while the OTA pays one already: an admin resolves it in Stripe.
    const secondIds = stripeIds();
    stripe.put(
      checkoutSession(secondIds, holder.tenant.id, { email: holder.owner.email }),
      stripeSubscription(secondIds, holder.tenant.id, { status: "active" }),
    );
    expect(await deliver(checkoutEvent(secondIds.sessionId))).toEqual(failedFor("SUBSCRIPTION_CONFLICT"));
    expect(await subscriptionsOf(holder.tenant.id)).toEqual([
      expect.objectContaining({
        id: holder.subscription.id,
        status: "active",
        version: holder.subscription.version,
      }),
    ]);
    // The Customer stored before stays the OTA's: the failed transaction wrote nothing.
    expect(
      await rowsOf("SELECT provider_customer_id FROM platform.billing_customers WHERE tenant_id = $1", [
        holder.tenant.id,
      ]),
    ).toEqual([{ provider_customer_id: holderIds.customerId }]);

    // Another OTA's Checkout paid with the holder's Customer, or naming the holder in its metadata.
    const owner = await newOwner();
    const { tenant } = await arrangeOta(owner, {}, {});
    const borrowedIds = { ...stripeIds(), customerId: holderIds.customerId };
    stripe.put(
      checkoutSession(borrowedIds, tenant.id, { email: owner.email }),
      stripeSubscription(borrowedIds, tenant.id, { status: "active" }),
    );
    expect(await deliver(checkoutEvent(borrowedIds.sessionId))).toEqual(failedFor("CUSTOMER_CONFLICT"));
    const namingIds = stripeIds();
    const naming: Stripe.Checkout.Session = {
      ...checkoutSession(namingIds, tenant.id, { email: owner.email }),
      metadata: { velexis_tenant_id: holder.tenant.id },
    };
    stripe.put(naming, stripeSubscription(namingIds, tenant.id, { status: "active" }));
    expect(await deliver(checkoutEvent(namingIds.sessionId))).toEqual(failedFor("TENANT_MISMATCH"));
    expect(await subscriptionsOf(tenant.id)).toEqual([
      expect.objectContaining({ billing_provider: "manual", status: "trialing" }),
    ]);
    expect(
      await rowsOf("SELECT 1 FROM platform.billing_customers WHERE tenant_id = $1", [tenant.id]),
    ).toEqual([]);

    // A subscription whose row is another OTA's than its metadata or its Customer names.
    const payingIds = stripeIds();
    const paying = await arrangePayingOta(payingIds);
    stripeNow(payingIds, holder.tenant.id, { status: "past_due" });
    expect(await deliver(subscriptionEvent(payingIds.subscriptionId))).toEqual(failedFor("TENANT_MISMATCH"));
    stripeNow({ ...payingIds, customerId: holderIds.customerId }, paying.tenant.id, { status: "past_due" });
    expect(await deliver(subscriptionEvent(payingIds.subscriptionId))).toEqual(
      failedFor("CUSTOMER_CONFLICT"),
    );
    expect(await subscriptionsOf(paying.tenant.id)).toEqual([
      expect.objectContaining({ status: "active", version: paying.subscription.version }),
    ]);
    expect(await tenantOf(paying.tenant.id)).toMatchObject({
      billing_notice: null,
      version: paying.tenant.version,
    });
  });

  it("[PBE-045] keeps one instance of the provisioning worker's processor and services, which billing sync imports too", () => {
    // ProvisioningModule.forWorker() is one module object: a second one would start a second platform-tenant-events
    // worker and reconciler in the process.
    const providers = worker.get(DiscoveryService, { strict: false }).getProviders();
    for (const type of [
      TenantEventsProcessor,
      ReconcilerScheduler,
      ProvisioningDispatcher,
      SuspensionService,
    ]) {
      expect(providers.filter((wrapper) => wrapper.metatype === type).length, type.name).toBe(1);
    }
  });

  it("ignores a Checkout that is not a subscription's and a subscription of no OTA", async () => {
    const ids = stripeIds();
    const owner = await newOwner();
    const { tenant } = await arrangeOta(owner, {}, {});
    stripe.put(checkoutSession(ids, tenant.id, { email: owner.email, mode: "payment" }));

    expect(await deliver(checkoutEvent(ids.sessionId))).toMatchObject({
      status: "ignored",
      last_error: "NOT_SUBSCRIPTION_MODE: the session is in payment mode",
    });
    const stranger = stripeIds();
    const strangers: Stripe.Subscription = {
      ...stripeSubscription(stranger, tenant.id, { status: "active" }),
      metadata: {},
    };
    stripe.put(strangers);
    expect(await deliver(subscriptionEvent(stranger.subscriptionId))).toMatchObject({
      status: "ignored",
      tenant_id: null,
    });
    expect(await subscriptionsOf(tenant.id)).toEqual([
      expect.objectContaining({ billing_provider: "manual" }),
    ]);
  });
});

// ---- FIX-W30-PLATFORM: overlapping events of one subscription, and the lock order of the manual edit ----------------

/** A gate a test opens once: `opened` resolves when `open()` is called. */
interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return { opened, open };
}

/**
 * Holds the next `subscriptions.retrieve`: Stripe answers the state it has when the call is made, and the answer
 * reaches the handler only once `release` is opened (a slow answer). `answered` opens when Stripe has answered.
 */
function holdNextSubscriptionRetrieve(): { readonly answered: Gate; readonly release: Gate } {
  const answered = gate();
  const release = gate();
  const resource = stripe.api().subscriptions;
  const retrieve = resource.retrieve.bind(resource) as (id: string) => Promise<Stripe.Subscription>;
  const held = async (id: string): Promise<Stripe.Subscription> => {
    const answer = await retrieve(id);
    answered.open();
    await release.opened;
    return answer;
  };
  vi.spyOn(resource, "retrieve").mockImplementationOnce(held as unknown as typeof resource.retrieve);
  return { answered, release };
}

/** Posts `delivery` as Stripe does, without waiting for the worker. */
async function post(delivery: Delivery): Promise<void> {
  const res = await t.http
    .post(PATH)
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", delivery.header)
    .send(delivery.payload);
  expect(res.status).toBe(200);
}

/** Waits until the worker is done with `delivery`; answers its inbox row. */
function doneWith(delivery: Delivery): Promise<Row> {
  return vi.waitFor(async () => {
    const row = (await rowsOf("SELECT * FROM platform.stripe_events WHERE id = $1", [delivery.eventId]))[0];
    expect(["processed", "ignored", "failed"]).toContain(row?.["status"]);
    return row as Row;
  }, WAIT);
}

/**
 * The worker's `billing.sync_lock_waiting` lines of the event of `delivery`: it waited for the lock of its
 * subscription. nestjs-pino keeps one root logger per process, so a line of the worker's module graph may land in
 * either sink.
 */
function lockWaitsOf(delivery: Delivery): Array<Record<string, unknown>> {
  return [...t.logs.lines, ...workerLogs.lines].filter(
    (line) => line["msg"] === "billing.sync_lock_waiting" && line["eventId"] === delivery.eventId,
  );
}

/**
 * Waits until the event of `delivery`, delivered while another event of its subscription is held, has run beside it
 * (worker concurrency 2): it waits for the subscription's lock, or, were there no lock, it is done already.
 */
async function ranBeside(delivery: Delivery): Promise<void> {
  await vi.waitFor(async () => {
    const row = (
      await rowsOf("SELECT status FROM platform.stripe_events WHERE id = $1", [delivery.eventId])
    )[0];
    expect(
      lockWaitsOf(delivery).length > 0 ||
        ["processed", "ignored", "failed"].includes(String(row?.["status"])),
    ).toBe(true);
  }, WAIT);
}

/** Waits until a session of this file's database waits for a lock another session holds. */
async function aSessionWaitsForALock(): Promise<void> {
  await vi.waitFor(async () => {
    const waiting = await rowsOf(
      "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0",
      [],
    );
    expect(waiting.length).toBeGreaterThanOrEqual(1);
  }, WAIT);
}

/** One `subscription.updated` audit row: its event and the row's status before and after (none when unchanged). */
interface StatusStep {
  readonly eventId: unknown;
  readonly before: unknown;
  readonly after: unknown;
}

/** The `subscription.updated` audit rows of the row `subscriptionId`, in the order they were written. */
async function statusTrail(tenantId: string, subscriptionId: string): Promise<StatusStep[]> {
  return (await auditOf(tenantId, "subscription.updated"))
    .filter((row) => row["target_id"] === subscriptionId)
    .map((row) => {
      const details = row["details"] as {
        eventId?: unknown;
        before?: { status?: unknown };
        after?: { status?: unknown };
      };
      return { eventId: details.eventId, before: details.before?.status, after: details.after?.status };
    });
}

/** The answer of the admin's manual edit of `subscriptionId` (adminUpdateManualSubscription) with `body`. */
async function adminPatch(
  adminId: string,
  subscriptionId: string,
  version: number,
  body: Record<string, unknown>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: adminId,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
  });
  const res = await t.http
    .patch(`/v1/admin/subscriptions/${subscriptionId}`)
    .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders("203.0.113.46") })
    .set("If-Match", `"${version}"`)
    .send(body);
  return { status: res.status, body: res.body as unknown };
}

const REASON = "FIX-W30-PLATFORM: the pilot moves to another plan.";

/**
 * Both directions of one Stripe change for two `customer.subscription.updated` events: the row's state before them,
 * the older state Stripe answers the first re-fetch, Stripe's newest state that the second event is about, and the
 * tenant's banner the newest state leaves.
 */
const DIRECTIONS = [
  // The renewal failed, then the owner paid.
  { start: "active", older: "past_due", newest: "active", notice: null },
  // The owner had paid, then the next renewal failed.
  { start: "past_due", older: "active", newest: "past_due", notice: "past_due" },
] as const;

describe("events of one subscription at once, and the manual edit beside billing sync (FIX-W30-PLATFORM)", () => {
  for (const { start, older, newest, notice } of DIRECTIONS) {
    it(`[FIX-W30-PLATFORM AC1] two events of one subscription processed at once end in its newest state (${older}, then ${newest}), though the first re-fetch is answered before the change and held until the second event runs`, async () => {
      const ids = stripeIds();
      const { tenant, subscription } = await arrangePayingOta(
        ids,
        { billing_notice: start === "past_due" ? "past_due" : null },
        { status: start },
      );
      // Stripe's state when the first event re-fetches.
      stripeNow(ids, tenant.id, { status: older });
      const hold = holdNextSubscriptionRetrieve();
      const first = subscriptionEvent(ids.subscriptionId);
      await post(first);
      await hold.answered.opened;

      // Stripe's newest state, which the second event is about.
      stripeNow(ids, tenant.id, { status: newest });
      const second = subscriptionEvent(ids.subscriptionId);
      await post(second);
      await ranBeside(second);
      hold.release.open();

      expect(await doneWith(first)).toMatchObject({ status: "processed", attempts: 1 });
      expect(await doneWith(second)).toMatchObject({ status: "processed", attempts: 1 });
      // The older answer committed first, then the second event re-fetched the newest state and wrote it.
      expect(await subscriptionsOf(tenant.id)).toEqual([
        expect.objectContaining({ id: subscription.id, status: newest, version: subscription.version + 2 }),
      ]);
      expect(await tenantOf(tenant.id)).toMatchObject({ status: "active", billing_notice: notice });
      expect(await statusTrail(tenant.id, subscription.id)).toEqual([
        { eventId: first.eventId, before: start, after: older },
        { eventId: second.eventId, before: older, after: newest },
      ]);
      // The second event had waited for the subscription's lock: it re-fetched once, after the first one's commit.
      expect(lockWaitsOf(second)).toEqual([
        expect.objectContaining({ providerSubscriptionId: ids.subscriptionId }),
      ]);
      expect(
        stripe.callsOf("subscriptions.retrieve").filter((call) => call.id === ids.subscriptionId),
      ).toHaveLength(2);
    });
  }

  for (const order of ["the Checkout's", "the subscription's"] as const) {
    it(`[FIX-W30-PLATFORM AC1] a completed Checkout and its subscription's event processed at once end in the newest state when ${order} re-fetch is held`, async () => {
      const ids = stripeIds();
      // A new OTA whose Checkout is paid but whose first payment Stripe still confirms: `incomplete`.
      const { tenant, row, job } = await arrangeNewOta(ids, "incomplete");
      const checkout = checkoutEvent(ids.sessionId);
      const update = subscriptionEvent(ids.subscriptionId);
      const [held, other] = order === "the Checkout's" ? [checkout, update] : [update, checkout];
      const hold = holdNextSubscriptionRetrieve();
      await post(held);
      await hold.answered.opened;

      // The payment is confirmed: the subscription is `trialing` now.
      stripe.put(
        stripeSubscription(ids, tenant.id, {
          status: "trialing",
          pendingRowId: row.id,
          trialEnd: trialEndOf(),
        }),
      );
      await post(other);
      await ranBeside(other);
      hold.release.open();

      expect(await doneWith(held)).toMatchObject({ status: "processed", tenant_id: tenant.id });
      expect(await doneWith(other)).toMatchObject({ status: "processed", tenant_id: tenant.id });
      expect(await subscriptionsOf(tenant.id)).toEqual([
        expect.objectContaining({
          id: row.id,
          status: "trialing",
          provider_subscription_id: ids.subscriptionId,
          checkout_session_id: ids.sessionId,
        }),
      ]);
      // The held event wrote the older answer first (the Stripe ids, the row still `incomplete`), then the other one
      // re-fetched and wrote the newest state.
      expect(await statusTrail(tenant.id, row.id)).toEqual([
        { eventId: held.eventId, before: undefined, after: undefined },
        { eventId: other.eventId, before: "incomplete", after: "trialing" },
      ]);
      // The gate opened with `trialing`: provisioning started once, after the newest state was written.
      expect(await jobsOf(tenant.id)).toEqual([
        expect.objectContaining({ id: job.id, status: "running", attempt: 1 }),
      ]);
      expect(await messagesOf(job.id)).toEqual([{ name: "tenant.provision", attempt: 1 }]);
      expect(lockWaitsOf(other)).toHaveLength(1);
    });
  }

  it("[FIX-W30-PLATFORM AC2] the manual edit waits for a billing-sync write that holds the tenant, and the write that replaces the manual trial never deadlocks with it", async () => {
    const ids = stripeIds();
    const owner = await newOwner();
    const admin = await insertAccount(pool, {
      id: testId("acc", next++),
      is_platform_admin: true,
      mfa_enabled: true,
    });
    const { tenant, subscription: manual } = await arrangeOta(
      owner,
      {},
      { status: "trialing", billing_provider: "manual" },
    );
    stripe.put(
      checkoutSession(ids, tenant.id, { email: owner.email }),
      stripeSubscription(ids, tenant.id, { status: "active" }),
    );
    // Billing sync stops inside its transaction, holding the tenant's row, before it locks the manual trial it
    // replaces.
    const syncHolds = gate();
    const syncGoes = gate();
    const lockOtherCurrent = SubscriptionsRepository.prototype.lockOtherCurrent;
    vi.spyOn(SubscriptionsRepository.prototype, "lockOtherCurrent").mockImplementationOnce(async function (
      this: SubscriptionsRepository,
      ...args: Parameters<SubscriptionsRepository["lockOtherCurrent"]>
    ) {
      syncHolds.open();
      await syncGoes.opened;
      return lockOtherCurrent.apply(this, args);
    });
    const delivery = checkoutEvent(ids.sessionId);
    await post(delivery);
    await syncHolds.opened;

    // The admin moves the trial to another plan meanwhile: the edit waits for the tenant's row, holding nothing.
    const edit = adminPatch(admin.id, manual.id, manual.version, { planCode: STARTER.code, reason: REASON });
    await aSessionWaitsForALock();
    syncGoes.open();

    expect(await doneWith(delivery)).toMatchObject({ status: "processed", attempts: 1 });
    // Then the edit finds the trial replaced (its version moved) and answers 412; it wrote nothing.
    const answer = await edit;
    expect(answer.status, JSON.stringify(answer.body)).toBe(412);
    const [manualAfter, stripeRow] = await subscriptionsOf(tenant.id);
    expect(manualAfter).toMatchObject({ id: manual.id, status: "canceled", version: manual.version + 1 });
    expect(stripeRow).toMatchObject({ status: "active", provider_subscription_id: ids.subscriptionId });
    expect(await tenantOf(tenant.id)).toMatchObject({ plan_code: GROWTH.code });
    expect(await auditOf(tenant.id, "subscription.manually_updated")).toEqual([]);
  });

  it("[FIX-W30-PLATFORM AC2] a billing-sync write waits for a manual edit that holds the tenant and its trial, and runs after it without a deadlock", async () => {
    const ids = stripeIds();
    const owner = await newOwner();
    const admin = await insertAccount(pool, {
      id: testId("acc", next++),
      is_platform_admin: true,
      mfa_enabled: true,
    });
    const { tenant, subscription: manual } = await arrangeOta(
      owner,
      {},
      { status: "trialing", billing_provider: "manual" },
    );
    stripe.put(
      checkoutSession(ids, tenant.id, { email: owner.email }),
      stripeSubscription(ids, tenant.id, { status: "active" }),
    );
    // The edit stops once it holds its locks: the tenant's row, then the trial's.
    const editHolds = gate();
    const editGoes = gate();
    const lockForUpdate = SubscriptionsRepository.prototype.lockForUpdate;
    vi.spyOn(SubscriptionsRepository.prototype, "lockForUpdate").mockImplementationOnce(async function (
      this: SubscriptionsRepository,
      ...args: Parameters<SubscriptionsRepository["lockForUpdate"]>
    ) {
      const locked = await lockForUpdate.apply(this, args);
      editHolds.open();
      await editGoes.opened;
      return locked;
    });
    const edit = adminPatch(admin.id, manual.id, manual.version, { planCode: STARTER.code, reason: REASON });
    await editHolds.opened;

    // The completed Checkout comes meanwhile: billing sync waits for the tenant's row.
    const delivery = checkoutEvent(ids.sessionId);
    await post(delivery);
    await aSessionWaitsForALock();
    editGoes.open();

    const answer = await edit;
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ planCode: STARTER.code, version: manual.version + 1 });
    expect(await doneWith(delivery)).toMatchObject({ status: "processed", attempts: 1 });
    // The edit committed first; billing sync then replaced the edited trial and moved the tenant to the paid plan.
    const [manualAfter, stripeRow] = await subscriptionsOf(tenant.id);
    expect(manualAfter).toMatchObject({
      id: manual.id,
      plan_code: STARTER.code,
      status: "canceled",
      version: manual.version + 2,
    });
    expect(stripeRow).toMatchObject({ status: "active", provider_subscription_id: ids.subscriptionId });
    expect(await tenantOf(tenant.id)).toMatchObject({ plan_code: GROWTH.code });
    expect(await auditOf(tenant.id, "subscription.manually_updated")).toEqual([
      expect.objectContaining({ target_id: manual.id }),
    ]);
  });
});

// ---- FIX-W31-PLATFORM: the Checkout's start beside billing sync, on the same pending row --------------------------

/** The new Checkout of the tests below: the plan of `arrangeNewOta`, monthly, as `createCheckoutSession` starts it. */
const GROWTH_MONTHLY: CheckoutPlan = Object.freeze({
  code: GROWTH.code,
  interval: "month",
  priceId: GROWTH.month,
  trialDays: 14,
});

/** How `CheckoutService.start` ended: its Session, or what it threw. */
type StartOutcome = { readonly session: { readonly id: string } } | { readonly error: unknown };

/**
 * An OTA created in M5 whose owner paid the Checkout of `ids` (its subscription `trialing` at Stripe, the pending row
 * still `incomplete`), with the Customer that Checkout made stored (`billing_customers`), so a new Checkout reuses it.
 */
async function arrangePaidPendingOta(ids: StripeIds) {
  const ota = await arrangeNewOta(ids, "trialing");
  await insertRow(pool, "billing_customers", {
    tenant_id: ota.tenant.id,
    provider_customer_id: ids.customerId,
    livemode: false,
  });
  return ota;
}

/**
 * The owner starts a new Checkout of the pending row meanwhile (a second tab: `createCheckoutSession` carries the
 * `incomplete` row it read): the API's CheckoutService.start, settled so that a failure is the test's to report.
 */
function startCheckout(ota: Awaited<ReturnType<typeof arrangePaidPendingOta>>): Promise<StartOutcome> {
  return t.app
    .get(CheckoutService)
    .start({
      tenantId: ota.tenant.id,
      accountId: ota.owner.id,
      plan: GROWTH_MONTHLY,
      subscriptionId: ota.row.id,
      requestKey: randomUUID(),
    })
    .then(
      (session) => ({ session }),
      (error: unknown) => ({ error }),
    );
}

/** The PostgreSQL backend of the transaction `trx`: the session whose locks the tests below wait on. */
async function backendOf(trx: PlatformTransaction): Promise<number> {
  const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
  const pid = rows[0]?.pid;
  if (pid === undefined) {
    throw new Error("backendOf: pg_backend_pid() answered nothing");
  }
  return pid;
}

/**
 * Waits until a session of this database waits for a lock that the session `holder` holds: the other side of the test
 * has reached it (not any session left waiting by an earlier test).
 */
async function aSessionWaitsFor(holder: number): Promise<void> {
  await vi.waitFor(async () => {
    const waiting = await rowsOf("SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))", [
      holder,
    ]);
    expect(waiting.length).toBeGreaterThanOrEqual(1);
  }, WAIT);
}

/** The `billing.checkout_started` audit rows of `tenantId`: the Session each one names. */
async function checkoutsStarted(tenantId: string): Promise<unknown[]> {
  return (await auditOf(tenantId, "billing.checkout_started")).map(
    (row) => (row["details"] as { checkoutSessionId?: unknown }).checkoutSessionId,
  );
}

describe("the Checkout's start beside a completed Checkout of the same pending row (FIX-W31-PLATFORM)", () => {
  it("[FIX-W31-PLATFORM AC1] a new Checkout waits for billing sync that holds the tenant, holding nothing, and neither deadlocks", async () => {
    const ids = stripeIds();
    const ota = await arrangePaidPendingOta(ids);
    // Billing sync stops inside its transaction, holding the tenant's row (and the OTA's Customer row), before it locks
    // the pending row.
    const syncHolds = gate();
    const syncGoes = gate();
    let syncBackend = 0;
    const lockPendingStripe = SubscriptionsRepository.prototype.lockPendingStripe;
    vi.spyOn(SubscriptionsRepository.prototype, "lockPendingStripe").mockImplementationOnce(async function (
      this: SubscriptionsRepository,
      ...args: Parameters<SubscriptionsRepository["lockPendingStripe"]>
    ) {
      syncBackend = await backendOf(args[0]);
      syncHolds.open();
      await syncGoes.opened;
      return lockPendingStripe.apply(this, args);
    });
    const delivery = checkoutEvent(ids.sessionId);
    await post(delivery);
    await syncHolds.opened;

    // The owner starts a new Checkout meanwhile: its transaction waits for the tenant's row first, so the pending row
    // stays free for billing sync. A start that wrote the row before it (the reverse order) would hold it here, and
    // this probe would fail at once (55P03) where billing sync would deadlock.
    const started = startCheckout(ota);
    let probed: number | null;
    try {
      await aSessionWaitsFor(syncBackend);
      probed = (
        await pool.query("SELECT id FROM platform.subscriptions WHERE id = $1 FOR UPDATE NOWAIT", [
          ota.row.id,
        ])
      ).rowCount;
    } finally {
      // Billing sync goes on whatever the probe found, so a failure here leaves no transaction behind.
      syncGoes.open();
    }
    expect(probed).toBe(1);

    expect(await doneWith(delivery)).toMatchObject({
      status: "processed",
      attempts: 1,
      tenant_id: ota.tenant.id,
    });
    const outcome = await started;
    expect(outcome).toEqual({ session: expect.objectContaining({ id: expect.stringMatching(/^cs_/) }) });
    const newSessionId = "session" in outcome ? outcome.session.id : "";
    expect(newSessionId).not.toBe(ids.sessionId);
    // Billing sync committed first and filled the row with the paid Checkout; the new Checkout found it filled and
    // left it as it was (only a pending row records a Session). Its start is audited all the same.
    expect(await subscriptionsOf(ota.tenant.id)).toEqual([
      expect.objectContaining({
        id: ota.row.id,
        status: "trialing",
        provider_subscription_id: ids.subscriptionId,
        checkout_session_id: ids.sessionId,
        version: ota.row.version + 1,
      }),
    ]);
    expect(await statusTrail(ota.tenant.id, ota.row.id)).toEqual([
      { eventId: delivery.eventId, before: "incomplete", after: "trialing" },
    ]);
    expect(await checkoutsStarted(ota.tenant.id)).toEqual([newSessionId]);
    // Provisioning started once, on the paid Checkout.
    expect(await jobsOf(ota.tenant.id)).toEqual([
      expect.objectContaining({ id: ota.job.id, status: "running", attempt: 1 }),
    ]);
    expect(await messagesOf(ota.job.id)).toEqual([{ name: "tenant.provision", attempt: 1 }]);
  });

  it("[FIX-W31-PLATFORM AC1] billing sync waits for a new Checkout that holds the tenant and the pending row, then fills the row, and neither deadlocks", async () => {
    const ids = stripeIds();
    const ota = await arrangePaidPendingOta(ids);
    // The new Checkout stops inside its transaction once it has recorded its Session on the pending row: it holds the
    // tenant's row and the pending row, and its audit row is still to come.
    const startHolds = gate();
    const startGoes = gate();
    let startBackend = 0;
    const recordCheckoutSession = SubscriptionsRepository.prototype.recordCheckoutSession;
    vi.spyOn(SubscriptionsRepository.prototype, "recordCheckoutSession").mockImplementationOnce(
      async function (
        this: SubscriptionsRepository,
        ...args: Parameters<SubscriptionsRepository["recordCheckoutSession"]>
      ) {
        const recorded = await recordCheckoutSession.apply(this, args);
        startBackend = await backendOf(args[0]);
        startHolds.open();
        await startGoes.opened;
        return recorded;
      },
    );
    const started = startCheckout(ota);
    await startHolds.opened;

    // The paid Checkout's event comes meanwhile: billing sync waits for the tenant's row, holding no row of its own. A
    // start that had not locked the tenant first would let it lock the tenant, and its audit row would then wait for
    // billing sync while billing sync waits for the pending row: a deadlock.
    const delivery = checkoutEvent(ids.sessionId);
    let keyShareProbe: unknown;
    try {
      // The start holds the tenant's row in billing sync's mode, FOR UPDATE: the one row lock that refuses even a
      // KEY SHARE (FOR NO KEY UPDATE, FOR SHARE or FOR KEY SHARE would let this probe through).
      keyShareProbe = await pool
        .query("SELECT id FROM platform.tenants WHERE id = $1 FOR KEY SHARE NOWAIT", [ota.tenant.id])
        .then(
          () => "locked without waiting",
          (error: unknown) => error,
        );
      await post(delivery);
      await aSessionWaitsFor(startBackend);
    } finally {
      // The new Checkout goes on whatever happened, so a failure here leaves no transaction behind.
      startGoes.open();
    }
    expect(keyShareProbe).toMatchObject({ code: "55P03" });

    const outcome = await started;
    expect(outcome).toEqual({ session: expect.objectContaining({ id: expect.stringMatching(/^cs_/) }) });
    const newSessionId = "session" in outcome ? outcome.session.id : "";
    expect(await doneWith(delivery)).toMatchObject({
      status: "processed",
      attempts: 1,
      tenant_id: ota.tenant.id,
    });
    // The new Checkout committed first (its Session on the pending row); billing sync then filled the row with the
    // paid Checkout's subscription and Session.
    expect(await subscriptionsOf(ota.tenant.id)).toEqual([
      expect.objectContaining({
        id: ota.row.id,
        status: "trialing",
        provider_subscription_id: ids.subscriptionId,
        checkout_session_id: ids.sessionId,
        version: ota.row.version + 2,
      }),
    ]);
    const [synced] = (await auditOf(ota.tenant.id, "subscription.updated")).filter(
      (row) => row["target_id"] === ota.row.id,
    );
    expect(synced?.["details"]).toMatchObject({
      eventId: delivery.eventId,
      before: { status: "incomplete", checkoutSessionId: newSessionId },
      after: { status: "trialing", checkoutSessionId: ids.sessionId },
    });
    expect(await checkoutsStarted(ota.tenant.id)).toEqual([newSessionId]);
    expect(await jobsOf(ota.tenant.id)).toEqual([
      expect.objectContaining({ id: ota.job.id, status: "running", attempt: 1 }),
    ]);
    expect(await messagesOf(ota.job.id)).toEqual([{ name: "tenant.provision", attempt: 1 }]);
  });
});
