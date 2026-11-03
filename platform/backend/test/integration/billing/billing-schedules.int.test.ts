// The two daily billing schedules (PBE-047; subscription-billing flow §G and §H, PADR-0002 item 9, ADR-0013 point 4 and
// "Negative", scope PF-71 AC2 and PF-75 AC1): `billing.abandoned_checkouts` and `billing.manual_trials`, run the way
// their job schedulers run them, as a job named after the schedule on `platform-maintenance`, which the worker's module
// graph (WorkerModule, as dist/worker.js builds it, with the API's FakeClock) hands to their `@MaintenanceJob`
// handlers, on this file's database clone and Redis database. The API (createTestApp, FEATURE_STRIPE_BILLING on, the
// FakeStripe of test/support/fake-stripe.ts in place of the Stripe client) creates the OTAs of the abandoned Checkouts
// as an owner would (createTenant with a paid plan: the `incomplete` row, the Checkout, the closed gate), shows that
// their keys stay reserved, and retries them; the other OTAs are written with the builders.
//
// The FakeClock only moves forward in this file: each test sets it to its own instants, later than the previous test's.
// A run handles every due row of the clone, so a test that counts what a run did first runs the schedule once at its
// own instant ("settle"), which handles what earlier tests left due by then, and only then arranges its own rows.
// Nothing answers `ota-tenant-ops`: a dispatched suspension stays `running` and its message waits in the queue, where
// the tests find it. The job schedulers are not registered (JobSchedulerRegistry replaced), so nothing runs behind the
// tests' backs; the last test checks the registration itself on a queue double. To show that each OTA is checked again
// under its lock, two tests wrap the run's list read in a spy (one call) that commits a concurrent change (a completed
// Checkout) right after the list is read; one runs the abandoned-Checkout handler directly, with one OTA's transaction
// failing, to see the run go on and then fail. The Stripe keys are the development values of `.env.example`; owners
// have `uniqueEmail` addresses, and the worker's e-mail processor sends to Mailpit.
import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { DiscoveryService, Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import {
  bullmqJobId,
  INVALIDATION_CHANNEL,
  OTA_TENANT_OPS,
  validateJob,
  type InvalidationEvent,
} from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { SubscriptionsRepository } from "../../../src/billing/subscriptions.repository";
import {
  ABANDONED_CHECKOUTS_ACTOR,
  ABANDONED_CHECKOUTS_JOB,
  AbandonedCheckoutsError,
  AbandonedCheckoutsScheduler,
  CHECKOUT_ABANDONED_ERROR,
  type AbandonedCheckoutsResult,
} from "../../../src/billing/sync/abandoned-checkouts.scheduler";
import {
  MANUAL_TRIALS_ACTOR,
  MANUAL_TRIALS_JOB,
  TRIAL_ENDING_NOTICE,
  type ManualTrialsResult,
} from "../../../src/billing/sync/manual-trials.scheduler";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { maintenanceHandlers } from "../../../src/common/queues/maintenance.processor";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import {
  configuredSwitches,
  JobSchedulerRegistry,
  PLATFORM_SCHEDULES,
  registerSchedules,
  type SchedulerQueue,
} from "../../../src/common/queues/scheduler.registry";
import { StripeClient } from "../../../src/common/stripe/stripe.client";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { TenantsRepository } from "../../../src/tenants/tenants.repository";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertPlan,
  insertRow,
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
/** How long a test waits for the worker to finish a run (it takes milliseconds; under Vitest's 5 s). */
const WAIT = { timeout: 3_000, interval: 20 } as const;
/** How long a test waits for an invalidation published after a commit. */
const EVENT_WAIT = { timeout: 3_000, interval: 20 } as const;
/** How long a test waits for the worker's e-mail to reach Mailpit. */
const MAIL_WAIT_MS = 3_000;

/** The switched-on application: the development Stripe values of `.env.example` (nothing reaches Stripe). */
const STRIPE_ENV = Object.freeze({
  FEATURE_STRIPE_BILLING: "true",
  STRIPE_SECRET_KEY: "sk_test_replace_me",
  STRIPE_BILLING_WEBHOOK_SECRET: "whsec_replace_me",
});
/** A public plan with a monthly Stripe Price and a 14-day trial. */
const STARTER = { code: "starter", month: "price_TestPbe047StarterMonth" };
/** A zone of the reference data for createTenant; the fixture of @velexis/testing has none, beforeAll adds it. */
const TIME_ZONE = "Europe/Paris";
/** Documentation addresses (RFC 5737) only. */
const PERSON_IP = "203.0.113.47";
/** The first number of this file's ids (`testId`), away from the other test files'. */
const FIRST_ID = 47_000;
const FAMILY = testId("asn", FIRST_ID);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Row = Record<string, unknown>;

interface Response {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

const stripe = new FakeStripe();
const workerLogs = new LogSink();
const invalidations: InvalidationEvent[] = [];
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let maintenance: Queue;
let tenantOps: Queue;
let subscriber: Redis;
let tokens: TokenService;
let next = FIRST_ID + 1;

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs, the invalidation subscriber, the platform
  // document of expectResponseToMatch, the job validators a dispatch compiles on its first call and the reference data.
  t = await createTestApp({ env: STRIPE_ENV, overrides: [{ provide: StripeClient, useValue: stripe }] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  maintenance = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.maintenance), { strict: false });
  tenantOps = t.app.get<Queue>(getQueueToken(OTA_TENANT_OPS), { strict: false });
  tokens = t.app.get(TokenService);
  responseChecker("platform");
  validateJob("tenant.provision", provisionFixture);
  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ($1, 'FR', 60, 120) ON CONFLICT DO NOTHING",
    [TIME_ZONE],
  );
  await insertPlan(pool, { code: STARTER.code, trial_days: 14, stripe_price_id_month: STARTER.month });

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
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

// ---- Runs and requests ---------------------------------------------------------------------------------------------

/** Runs a daily schedule as its job scheduler does (a job named after it, empty payload) and answers its result. */
async function runSchedule<T>(scheduleId: string): Promise<T> {
  const run = await maintenance.add(scheduleId, {});
  return vi.waitFor(async () => {
    expect(await maintenance.getJobState(run.id ?? "")).toBe("completed");
    return (await maintenance.getJob(run.id ?? ""))?.returnvalue as T;
  }, WAIT);
}

const runAbandoned = (): Promise<AbandonedCheckoutsResult> => runSchedule(ABANDONED_CHECKOUTS_JOB);
const runManualTrials = (): Promise<ManualTrialsResult> => runSchedule(MANUAL_TRIALS_JOB);

/** The headers of a portal call by `accountId`: a fresh portal token and the portal server's headers. */
async function headersOf(accountId: string): Promise<Record<string, string>> {
  const { token } = await tokens.sign({ aud: "portal", sub: accountId, sid: FAMILY, ev: true, amr: ["pwd"] });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** createTenant by `accountId` for `key` on the starter plan, as the portal's wizard sends it. */
async function createTenant(accountId: string, key: string): Promise<Response> {
  return t.http
    .post("/v1/tenants")
    .set(await headersOf(accountId))
    .set("Idempotency-Key", randomUUID())
    .send({
      key,
      name: "Nordic Fares",
      countryCode: "FR",
      defaultCurrency: "EUR",
      timeZone: TIME_ZONE,
      planCode: STARTER.code,
      billingInterval: "month",
    });
}

/** `<status> <code>` of an answer; `<status>` alone for a success. */
function outcomeOf(res: Response): string {
  const { error } = (res.body ?? {}) as { error?: { code: string } };
  return error === undefined ? String(res.status) : `${res.status} ${error.code}`;
}

// ---- Rows, messages and events -------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[]): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const tenantOf = async (tenantId: string): Promise<Row> =>
  (await rowsOf("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]))[0] as Row;

const subscriptionsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf("SELECT * FROM platform.subscriptions WHERE tenant_id = $1 ORDER BY created_at, id", [tenantId]);

const jobsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT id, kind, status, attempt, error, finished_at, requested_by_account_id, payload " +
      "FROM platform.provisioning_jobs WHERE tenant_id = $1 ORDER BY created_at, id",
    [tenantId],
  );

const auditOf = (tenantId: string, action: string): Promise<Row[]> =>
  rowsOf(
    "SELECT action, actor_type, actor_label, actor_account_id, target_type, target_id, details " +
      "FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id",
    [tenantId, action],
  );

const emailsOf = (tenantId: string, template: string): Promise<Row[]> =>
  rowsOf(
    "SELECT template, to_email, account_id, data FROM platform.email_outbox " +
      "WHERE tenant_id = $1 AND template = $2 ORDER BY created_at, to_email",
    [tenantId, template],
  );

/** The `ota-tenant-ops` messages of the job `jobId` (one per dispatched attempt), by attempt. */
async function messagesOf(jobId: string): Promise<Array<{ name: string; attempt: number; data: unknown }>> {
  const found: Array<{ name: string; attempt: number; data: unknown }> = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const job = await tenantOps.getJob(bullmqJobId(jobId, attempt));
    if (job !== undefined) {
      found.push({ name: job.name, attempt, data: job.data });
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

/**
 * The log lines `msg` of both processes: nestjs-pino's loggers write through the first application's logger, so the
 * worker's lines may land in the API's sink.
 */
const logLines = (msg: string): Array<Record<string, unknown>> =>
  [...t.logs.lines, ...workerLogs.lines].filter((line) => line["msg"] === msg);

/** The number of `tenant` invalidations of `tenantId` received so far. */
const invalidationCount = (tenantId: string): number =>
  invalidations.filter((event) => event.type === "tenant" && event.id === tenantId).length;

// ---- Arrangement ---------------------------------------------------------------------------------------------------

/** An account of this file with an address of this test only. */
const newAccount = (label: string, fullName = "Ana Lima"): Promise<PlatformRow<"accounts">> =>
  insertAccount(pool, { id: testId("acc", next++), email: uniqueEmail(label), full_name: fullName });

/** A `provision` job of `tenantId`: `queued` and due at the FakeClock's time, unless `job` says otherwise. */
function insertProvisionJob(
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

/** An OTA of this file with the members of `members` and `subscription`. */
async function arrangeOta(
  tenant: Partial<TenantRow>,
  subscription: Partial<SubscriptionRow>,
  members: ReadonlyArray<readonly [PlatformRow<"accounts">, "owner" | "admin"]> = [],
): Promise<{ readonly tenant: PlatformRow<"tenants">; readonly subscription: PlatformRow<"subscriptions"> }> {
  const n = next++;
  const ota = await insertOta(pool, {
    tenant: { id: testId("ten", n), key: `pbe${n}`, ...tenant },
    subscription: { id: testId("sub", n), ...subscription },
    members,
  });
  if (ota.subscription === undefined) {
    throw new Error("arrangeOta: the subscription was not written");
  }
  return { tenant: ota.tenant, subscription: ota.subscription };
}

/** An instant `days` days and `hours` hours after `from`. */
const after = (from: Date, days: number, hours = 0): Date =>
  new Date(from.getTime() + days * DAY_MS + hours * HOUR_MS);

// ---- billing.abandoned_checkouts -----------------------------------------------------------------------------------

describe("billing.abandoned_checkouts", () => {
  it("[PBE-047 AC1] a 49-hour-old abandoned Checkout fails the tenant and keeps its key reserved [PF-71 AC2]", async () => {
    const start = t.clock.now();
    const owner = await newAccount("owner-pbe047-abandon");
    const created = await createTenant(owner.id, "polarfares");
    expect(outcomeOf(created)).toBe("202");
    const tenantId = (created.body as { tenant: { id: string } }).tenant.id;
    const [pending] = await subscriptionsOf(tenantId);
    const [job] = await jobsOf(tenantId);
    // As createTenant leaves an OTA created in M5: provisioning, the `incomplete` row with its Checkout, the job queued.
    expect(pending).toMatchObject({
      status: "incomplete",
      billing_provider: "stripe",
      checkout_session_id: expect.stringMatching(/^cs_/),
    });
    expect(job).toMatchObject({ kind: "provision", status: "queued" });
    // A second OTA whose Checkout started two hours later.
    t.clock.set(after(start, 0, 2));
    const later = await newAccount("owner-pbe047-later");
    const laterCreated = await createTenant(later.id, "fjordtrips");
    const laterId = (laterCreated.body as { tenant: { id: string } }).tenant.id;
    const tenantBefore = await tenantOf(tenantId);

    t.clock.set(after(start, 2, 1));
    const result = await runAbandoned();

    expect(result).toEqual({ found: 1, tenantsFailed: 1, skipped: 0 });
    expect(await tenantOf(tenantId)).toMatchObject({
      status: "failed",
      key: "polarfares",
      version: Number(tenantBefore["version"]) + 1,
    });
    expect(await subscriptionsOf(tenantId)).toEqual([
      expect.objectContaining({
        id: pending?.["id"],
        status: "incomplete_expired",
        version: Number(pending?.["version"]) + 1,
        updated_at: t.clock.now(),
      }),
    ]);
    expect(await jobsOf(tenantId)).toEqual([
      expect.objectContaining({
        id: job?.["id"],
        status: "canceled",
        error: CHECKOUT_ABANDONED_ERROR,
        finished_at: t.clock.now(),
      }),
    ]);
    expect(await auditOf(tenantId, "tenant.provisioning_failed")).toEqual([
      {
        action: "tenant.provisioning_failed",
        actor_type: "system",
        actor_label: ABANDONED_CHECKOUTS_ACTOR,
        actor_account_id: null,
        target_type: "tenant",
        target_id: tenantId,
        details: {
          before: { status: "provisioning" },
          after: { status: "failed" },
          code: "CHECKOUT_ABANDONED",
          subscriptionId: pending?.["id"],
          subscriptionStatus: { before: "incomplete", after: "incomplete_expired" },
          checkoutSessionId: pending?.["checkout_session_id"],
          waitingSince: start.toISOString(),
          canceledJobIds: [job?.["id"]],
        },
      },
    ]);
    await expectTenantInvalidation(tenantId);
    // No e-mail: the owner sees the failed setup in the portal.
    expect(
      await rowsOf("SELECT template FROM platform.email_outbox WHERE tenant_id = $1", [tenantId]),
    ).toEqual([]);
    // The OTA whose Checkout is 47 hours old waits on.
    expect(await tenantOf(laterId)).toMatchObject({ status: "provisioning" });
    expect(await subscriptionsOf(laterId)).toEqual([expect.objectContaining({ status: "incomplete" })]);
    expect(await jobsOf(laterId)).toEqual([expect.objectContaining({ status: "queued" })]);

    // The key stays reserved: the key check says taken, and createTenant refuses it.
    const check = await t.http
      .get("/v1/tenants/key-availability")
      .query({ key: "polarfares" })
      .set(await headersOf(later.id));
    expect(check.status).toBe(200);
    expectResponseToMatch("checkTenantKey", check, { document: "platform" });
    expect(check.body).toMatchObject({ key: "polarfares", available: false, reason: "taken" });
    const other = await newAccount("other-pbe047");
    expect(outcomeOf(await createTenant(other.id, "polarfares"))).toBe("409 TENANT_KEY_UNAVAILABLE");

    // A second run the same day changes nothing more.
    expect(await runAbandoned()).toEqual({ found: 0, tenantsFailed: 0, skipped: 0 });
    expect(await auditOf(tenantId, "tenant.provisioning_failed")).toHaveLength(1);

    // The owner retries from the portal: a new `incomplete` row and a new Checkout (PBE-044).
    const retry = await t.http
      .post(`/v1/tenants/${tenantId}/provisioning/retry`)
      .set(await headersOf(owner.id))
      .send();
    expect(outcomeOf(retry)).toBe("202");
    expect((retry.body as { checkoutUrl: string | null }).checkoutUrl).toMatch(
      /^https:\/\/checkout\.stripe\.com\//,
    );
    expect((await subscriptionsOf(tenantId)).map((row) => row["status"])).toEqual([
      "incomplete_expired",
      "incomplete",
    ]);
    expect(await tenantOf(tenantId)).toMatchObject({ status: "provisioning" });

    // Two hours later the second OTA's Checkout is 49 hours old too.
    t.clock.set(after(start, 2, 3));
    expect(await runAbandoned()).toEqual({ found: 1, tenantsFailed: 1, skipped: 0 });
    expect(await tenantOf(laterId)).toMatchObject({ status: "failed" });
    expect(await tenantOf(tenantId)).toMatchObject({ status: "provisioning" });
    // Never a name, a key or an e-mail address in the run's log line.
    const lines = logLines("billing.abandoned_checkouts");
    expect(lines.at(-1)).toMatchObject({ found: 1, tenantsFailed: 1, skipped: 0, errors: 0, capped: false });
    expect(JSON.stringify(lines)).not.toMatch(/@|polarfares|fjordtrips/);
  });

  it("[PBE-047] counts 48 hours from the latest Checkout, fails an OTA whose Stripe subscription expired, and leaves paid, manual and dispatched OTAs alone", async () => {
    const base = t.clock.set(after(t.clock.now(), 10));
    await runAbandoned(); // settle what earlier tests left due by now
    const owner = await newAccount("owner-pbe047-restart");
    const created = await createTenant(owner.id, "auroratours");
    const restartedId = (created.body as { tenant: { id: string } }).tenant.id;
    const [restartedRow] = await subscriptionsOf(restartedId);
    const old = after(base, -3);
    const stripeRow = {
      plan_code: STARTER.code,
      billing_provider: "stripe",
      trial_ends_at: null,
      created_at: old,
      updated_at: old,
    } satisfies Partial<SubscriptionRow>;
    // Stripe expired the subscription of a Checkout whose first payment never succeeded (billing sync wrote it).
    const expired = await arrangeOta(
      { status: "provisioning", activated_at: null, plan_code: STARTER.code },
      { ...stripeRow, status: "incomplete_expired", provider_subscription_id: "sub_TestPbe047Expired" },
    );
    const expiredJob = await insertProvisionJob(expired.tenant.id);
    // A paid Checkout whose job waits for its dispatch, a pre-M5 OTA on a manual trial, and an OTA whose job runs.
    const paid = await arrangeOta(
      { status: "provisioning", activated_at: null, plan_code: STARTER.code },
      { ...stripeRow, status: "trialing" },
    );
    await insertProvisionJob(paid.tenant.id);
    const manual = await arrangeOta(
      { status: "provisioning", activated_at: null },
      { created_at: old, updated_at: old },
    );
    await insertProvisionJob(manual.tenant.id);
    const running = await arrangeOta(
      { status: "provisioning", activated_at: null, plan_code: STARTER.code },
      { ...stripeRow, status: "incomplete" },
    );
    await insertProvisionJob(running.tenant.id, { status: "running", attempt: 1 });

    // 40 hours after createTenant the owner opens a new Checkout: the Session is recorded on the pending row.
    t.clock.set(after(base, 1, 16));
    const reopened = await t.http
      .post(`/v1/tenants/${restartedId}/billing/checkout-session`)
      .set(await headersOf(owner.id))
      .set("Idempotency-Key", randomUUID())
      .send({ planCode: STARTER.code, billingInterval: "month" });
    expect(outcomeOf(reopened)).toBe("201");
    const [recorded] = await subscriptionsOf(restartedId);
    expect(recorded?.["checkout_session_id"]).not.toBe(restartedRow?.["checkout_session_id"]);

    // 50 hours after createTenant, 10 after the new Checkout.
    t.clock.set(after(base, 2, 2));
    const result = await runAbandoned();

    // Found: the expired one and the running one; the restarted Checkout is not 48 hours old.
    expect(result).toEqual({ found: 2, tenantsFailed: 1, skipped: 1 });
    expect(await tenantOf(restartedId)).toMatchObject({ status: "provisioning" });
    expect(await tenantOf(expired.tenant.id)).toMatchObject({ status: "failed" });
    // Stripe's status is kept as billing sync wrote it; the job is canceled.
    expect(await subscriptionsOf(expired.tenant.id)).toEqual([
      expect.objectContaining({ status: "incomplete_expired", version: expired.subscription.version }),
    ]);
    expect(await jobsOf(expired.tenant.id)).toEqual([
      expect.objectContaining({ id: expiredJob.id, status: "canceled", error: CHECKOUT_ABANDONED_ERROR }),
    ]);
    expect(await auditOf(expired.tenant.id, "tenant.provisioning_failed")).toEqual([
      expect.objectContaining({
        actor_label: ABANDONED_CHECKOUTS_ACTOR,
        details: expect.objectContaining({
          subscriptionStatus: { before: "incomplete_expired", after: "incomplete_expired" },
          canceledJobIds: [expiredJob.id],
        }),
      }),
    ]);
    for (const ota of [paid, manual, running]) {
      expect(await tenantOf(ota.tenant.id)).toMatchObject({ status: "provisioning" });
      expect(await subscriptionsOf(ota.tenant.id)).toEqual([
        expect.objectContaining({ status: ota.subscription.status, version: ota.subscription.version }),
      ]);
      expect(await auditOf(ota.tenant.id, "tenant.provisioning_failed")).toEqual([]);
    }
    expect(logLines("billing.abandoned_checkout_skipped")).toContainEqual(
      expect.objectContaining({ tenantId: running.tenant.id, reason: "job_running" }),
    );

    // 48 hours after the new Checkout, the restarted OTA fails too.
    t.clock.set(after(base, 3, 17));
    await runAbandoned();
    expect(await tenantOf(restartedId)).toMatchObject({ status: "failed" });
    expect(await subscriptionsOf(restartedId)).toEqual([
      expect.objectContaining({
        status: "incomplete_expired",
        checkout_session_id: recorded?.["checkout_session_id"],
      }),
    ]);
  });

  it("[PBE-047] checks each OTA again under its lock, and goes on after an OTA it could not handle, then fails", async () => {
    const base = t.clock.set(after(t.clock.now(), 10));
    // Settle what earlier tests left due by now; what it skips (an OTA whose job runs) every run skips again.
    const { skipped: alwaysSkipped } = await runAbandoned();
    const old = after(base, -3);
    const abandoned = (): ReturnType<typeof arrangeOta> =>
      arrangeOta(
        { status: "provisioning", activated_at: null, plan_code: STARTER.code },
        {
          plan_code: STARTER.code,
          billing_provider: "stripe",
          status: "incomplete",
          trial_ends_at: null,
          created_at: old,
          updated_at: old,
        },
      );
    const paidMeanwhile = await abandoned();
    await insertProvisionJob(paidMeanwhile.tenant.id);
    const broken = await abandoned();
    const brokenJob = await insertProvisionJob(broken.tenant.id);
    const healthy = await abandoned();
    await insertProvisionJob(healthy.tenant.id);

    // The run reads its list; then one OTA's Checkout completes (billing sync writes its row `trialing`) before the
    // run locks that OTA, and the transaction of another OTA fails half-way.
    const findOriginal = SubscriptionsRepository.prototype.findAbandonedCheckouts;
    const list = vi
      .spyOn(SubscriptionsRepository.prototype, "findAbandonedCheckouts")
      .mockImplementationOnce(async function (this: SubscriptionsRepository, db, filter) {
        const rows = await findOriginal.call(this, db, filter);
        await pool.query(
          "UPDATE platform.subscriptions SET status = 'trialing', version = version + 1, updated_at = $2 WHERE id = $1",
          [paidMeanwhile.subscription.id, t.clock.now()],
        );
        return rows;
      });
    const failOriginal = TenantsRepository.prototype.failProvisioning;
    const fail = vi.spyOn(TenantsRepository.prototype, "failProvisioning").mockImplementation(async function (
      this: TenantsRepository,
      trx,
      tenantId,
      now,
    ) {
      if (tenantId === broken.tenant.id) {
        throw new Error("the connection was lost");
      }
      return failOriginal.call(this, trx, tenantId, now);
    });
    try {
      await expect(worker.get(AbandonedCheckoutsScheduler, { strict: false }).run()).rejects.toBeInstanceOf(
        AbandonedCheckoutsError,
      );
    } finally {
      list.mockRestore();
      fail.mockRestore();
    }

    // The OTA paid meanwhile is left alone; the broken one is rolled back whole; the healthy one is failed.
    expect(await tenantOf(paidMeanwhile.tenant.id)).toMatchObject({ status: "provisioning" });
    expect(await subscriptionsOf(paidMeanwhile.tenant.id)).toEqual([
      expect.objectContaining({ status: "trialing" }),
    ]);
    expect(await jobsOf(paidMeanwhile.tenant.id)).toEqual([expect.objectContaining({ status: "queued" })]);
    expect(await auditOf(paidMeanwhile.tenant.id, "tenant.provisioning_failed")).toEqual([]);
    expect(await tenantOf(broken.tenant.id)).toMatchObject({ status: "provisioning" });
    expect(await subscriptionsOf(broken.tenant.id)).toEqual([
      expect.objectContaining({ status: "incomplete", version: broken.subscription.version }),
    ]);
    expect(await jobsOf(broken.tenant.id)).toEqual([
      expect.objectContaining({ id: brokenJob.id, status: "queued", error: null }),
    ]);
    expect(await auditOf(broken.tenant.id, "tenant.provisioning_failed")).toEqual([]);
    expect(await tenantOf(healthy.tenant.id)).toMatchObject({ status: "failed" });
    expect(logLines("billing.abandoned_checkout_skipped")).toContainEqual(
      expect.objectContaining({ tenantId: paidMeanwhile.tenant.id, reason: "not_a_candidate" }),
    );
    expect(logLines("billing.abandoned_checkout_failed")).toContainEqual(
      expect.objectContaining({ tenantId: broken.tenant.id, subscriptionId: broken.subscription.id }),
    );
    expect(logLines("billing.abandoned_checkouts").at(-1)).toMatchObject({
      found: alwaysSkipped + 3,
      tenantsFailed: 1,
      skipped: alwaysSkipped + 1,
      errors: 1,
    });

    // BullMQ's next attempt fails the OTA it could not handle, and only that one.
    expect(await runAbandoned()).toEqual({
      found: alwaysSkipped + 1,
      tenantsFailed: 1,
      skipped: alwaysSkipped,
    });
    expect(await tenantOf(broken.tenant.id)).toMatchObject({ status: "failed" });
    expect(await jobsOf(broken.tenant.id)).toEqual([
      expect.objectContaining({ id: brokenJob.id, status: "canceled", error: CHECKOUT_ABANDONED_ERROR }),
    ]);
  });
});

// ---- billing.manual_trials -----------------------------------------------------------------------------------------

/** The end of the manual trials of the tests below: 2027-03-20 at 15:00 UTC. */
const TRIAL_END = new Date("2027-03-20T15:00:00.000Z");

/** The daily run at 08:10 UTC, `offset` days from the trial's end day (negative before). */
const runDay = (offset: number): Date => new Date(Date.UTC(2027, 2, 20 + offset, 8, 10));

/** An active OTA on a manual trial ending at TRIAL_END (unless `subscription` says otherwise): two owners and an admin. */
async function arrangeTrial(
  label: string,
  tenant: Partial<TenantRow> = {},
  subscription: Partial<SubscriptionRow> = {},
) {
  const owner = await newAccount(`owner-${label}`, "Ana Lima");
  const coOwner = await newAccount(`co-owner-${label}`, "Lena Holm");
  const admin = await newAccount(`admin-${label}`, "Ola Berg");
  const ota = await arrangeOta(
    { name: "Arctic Trails", ...tenant },
    {
      trial_ends_at: TRIAL_END,
      created_at: after(TRIAL_END, -90),
      updated_at: after(TRIAL_END, -90),
      ...subscription,
    },
    [
      [owner, "owner"],
      [coOwner, "owner"],
      [admin, "admin"],
    ],
  );
  return { ...ota, owners: [owner, coOwner], admin };
}

describe("billing.manual_trials", () => {
  it("[PBE-047 AC2] with FakeClock, a manual trial gets the two notices, then past_due, then suspension 14 days after the end [PF-75 AC1]", async () => {
    t.clock.set(runDay(-15));
    await runManualTrials(); // settle what earlier tests left due by now
    const trial = await arrangeTrial("pbe047-trial");
    const tenantId = trial.tenant.id;
    const subscriptionId = trial.subscription.id;
    const billingUrl = `${t.config.PUBLIC_PORTAL_URL.replace(/\/+$/, "")}/otas/${tenantId}/billing`;
    const ownerEmails = trial.owners.map((owner) => owner.email).sort();
    const noticesOf = async () =>
      (await emailsOf(tenantId, "billing.trial_ending")).map((email) => ({
        to: email["to_email"],
        timeLeft: (email["data"] as Row)["timeLeft"],
      }));

    // 15 days before the end: nothing yet.
    expect(await runManualTrials()).toEqual({
      trials: 0,
      emails: 0,
      banners: 0,
      pastDue: 0,
      suspended: 0,
      skipped: 0,
    });

    // 14 days before: the first notice to both owners (never the admin) and the banner.
    t.clock.set(runDay(-14));
    expect(await runManualTrials()).toEqual({
      trials: 1,
      emails: 2,
      banners: 1,
      pastDue: 0,
      suspended: 0,
      skipped: 0,
    });
    const notices = await emailsOf(tenantId, "billing.trial_ending");
    expect(notices.map((email) => email["to_email"]).sort()).toEqual(ownerEmails);
    expect(notices.map((email) => email["account_id"]).sort()).toEqual(
      trial.owners.map((owner) => owner.id).sort(),
    );
    expect(notices[0]?.["data"]).toEqual({
      fullName: expect.stringMatching(/^(Ana Lima|Lena Holm)$/),
      tenantName: "Arctic Trails",
      tenantKey: trial.tenant.key,
      trialEndsOn: "2027-03-20",
      timeLeft: "in 14 days",
      suspensionOn: "2027-04-03",
      billingUrl,
    });
    expect(await tenantOf(tenantId)).toMatchObject({
      status: "active",
      billing_notice: TRIAL_ENDING_NOTICE,
      version: trial.tenant.version + 1,
    });
    await expectTenantInvalidation(tenantId);
    const message = await waitForMessage({ to: trial.owners[0]?.email ?? "", timeoutMs: MAIL_WAIT_MS });
    expect(message.Subject).toBe("The Velexis trial of Arctic Trails ends in 14 days");
    expect(message.Text).toContain(billingUrl);
    expect(message.Text).toContain("on 2027-03-20 (UTC)");

    // The same day again, and the days after: no second first notice.
    expect(await runManualTrials()).toMatchObject({ trials: 1, emails: 0, banners: 0 });
    t.clock.set(runDay(-10));
    expect(await runManualTrials()).toMatchObject({ trials: 1, emails: 0, banners: 0, pastDue: 0 });

    // 3 days before: the second notice.
    t.clock.set(runDay(-3));
    expect(await runManualTrials()).toMatchObject({ trials: 1, emails: 2, banners: 0, pastDue: 0 });
    t.clock.set(runDay(-1));
    expect(await runManualTrials()).toMatchObject({ trials: 1, emails: 0, pastDue: 0 });
    expect(await noticesOf()).toEqual(
      expect.arrayContaining([
        { to: ownerEmails[0], timeLeft: "in 14 days" },
        { to: ownerEmails[1], timeLeft: "in 14 days" },
        { to: ownerEmails[0], timeLeft: "in 3 days" },
        { to: ownerEmails[1], timeLeft: "in 3 days" },
      ]),
    );
    expect(await noticesOf()).toHaveLength(4);
    expect(await subscriptionsOf(tenantId)).toEqual([
      expect.objectContaining({ status: "trialing", version: trial.subscription.version }),
    ]);

    // The end day (before the trial's own time of day): the row becomes past due, the OTA keeps running.
    t.clock.set(runDay(0));
    expect(await runManualTrials()).toMatchObject({ trials: 1, emails: 0, pastDue: 1, suspended: 0 });
    expect(await subscriptionsOf(tenantId)).toEqual([
      expect.objectContaining({
        id: subscriptionId,
        status: "past_due",
        billing_provider: "manual",
        version: trial.subscription.version + 1,
      }),
    ]);
    expect(await tenantOf(tenantId)).toMatchObject({ status: "active", billing_notice: TRIAL_ENDING_NOTICE });

    // 13 days after the end: still past due.
    t.clock.set(runDay(13));
    expect(await runManualTrials()).toMatchObject({ trials: 1, pastDue: 0, suspended: 0 });
    expect(await tenantOf(tenantId)).toMatchObject({ status: "active" });

    // 14 days after the end: the row is canceled and the OTA suspended with reason billing.
    t.clock.set(runDay(14));
    const invalidationsBefore = invalidationCount(tenantId);
    expect(await runManualTrials()).toMatchObject({ trials: 1, emails: 0, pastDue: 0, suspended: 1 });
    expect(await subscriptionsOf(tenantId)).toEqual([
      expect.objectContaining({ status: "canceled", canceled_at: t.clock.now() }),
    ]);
    expect(await tenantOf(tenantId)).toMatchObject({ status: "suspended", suspension_reason: "billing" });
    const [suspend] = await jobsOf(tenantId);
    expect(suspend).toMatchObject({
      kind: "suspend",
      status: "running",
      attempt: 1,
      requested_by_account_id: null,
      payload: { reason: "billing" },
    });
    expect(await messagesOf(String(suspend?.["id"]))).toEqual([
      {
        name: "tenant.suspend",
        attempt: 1,
        data: expect.objectContaining({ payload: { reason: "billing" } }),
      },
    ]);
    expect(await auditOf(tenantId, "tenant.suspended")).toEqual([
      expect.objectContaining({
        actor_type: "system",
        actor_label: MANUAL_TRIALS_ACTOR,
        details: expect.objectContaining({ after: { status: "suspended", suspensionReason: "billing" } }),
      }),
    ]);
    expect((await emailsOf(tenantId, "tenant.suspended")).map((email) => email["to_email"]).sort()).toEqual(
      ownerEmails,
    );
    await vi.waitFor(() => {
      expect(invalidationCount(tenantId)).toBeGreaterThan(invalidationsBefore);
    }, EVENT_WAIT);

    // Every change is audited on the subscription: the banner, the end, the suspension.
    expect(await auditOf(tenantId, "subscription.updated")).toEqual([
      {
        action: "subscription.updated",
        actor_type: "system",
        actor_label: MANUAL_TRIALS_ACTOR,
        actor_account_id: null,
        target_type: "subscription",
        target_id: subscriptionId,
        details: {
          before: { billingNotice: null },
          after: { billingNotice: TRIAL_ENDING_NOTICE },
          reason: "trial_ending",
          billingProvider: "manual",
          trialEndsAt: TRIAL_END.toISOString(),
          notice: 14,
          emailsQueued: 2,
        },
      },
      expect.objectContaining({
        details: {
          before: { status: "trialing" },
          after: { status: "past_due" },
          reason: "trial_ended",
          billingProvider: "manual",
          trialEndsAt: TRIAL_END.toISOString(),
        },
      }),
      expect.objectContaining({
        details: {
          before: { status: "past_due" },
          after: { status: "canceled" },
          reason: "grace_period_ended",
          billingProvider: "manual",
          trialEndsAt: TRIAL_END.toISOString(),
        },
      }),
    ]);

    // The next day there is nothing left to do.
    t.clock.set(runDay(15));
    expect(await runManualTrials()).toMatchObject({ trials: 0, suspended: 0 });
    expect(await jobsOf(tenantId)).toHaveLength(1);
    const lines = logLines("billing.manual_trials");
    expect(JSON.stringify(lines)).not.toMatch(/@/);
  });

  it("[PBE-047] suspends a trial that ended before the first run only 14 days after it became past due, clears the banner of a trial moved later, and leaves the rest alone", async () => {
    const base = t.clock.set(runDay(60));
    // Ended 30 days ago, before the switch went on: no notice was ever sent.
    const ended = await arrangeTrial("pbe047-ended", {}, { trial_ends_at: after(TRIAL_END, 30) });
    // An admin moved the end 40 days later after the first notice.
    const moved = await arrangeTrial(
      "pbe047-moved",
      { billing_notice: TRIAL_ENDING_NOTICE },
      { trial_ends_at: after(base, 40) },
    );
    // In the notice window, but: suspended for abuse; paying Velexis by invoice (manual, active); a Stripe trial.
    const suspended = await arrangeTrial(
      "pbe047-abuse",
      { status: "suspended", suspension_reason: "abuse", suspended_at: base },
      { trial_ends_at: after(base, 5) },
    );
    const invoiced = await arrangeTrial(
      "pbe047-invoiced",
      {},
      { status: "active", trial_ends_at: after(base, 5) },
    );
    const stripeTrial = await arrangeTrial(
      "pbe047-stripe",
      {},
      {
        billing_provider: "stripe",
        trial_ends_at: after(base, 5),
        provider_subscription_id: "sub_TestPbe047Trial",
      },
    );
    // An admin set the trial `active` after its first notice (paid by invoice): the trial's banner goes.
    const paid = await arrangeTrial(
      "pbe047-paid",
      { billing_notice: TRIAL_ENDING_NOTICE },
      { status: "active", trial_ends_at: after(base, 5) },
    );

    await runManualTrials();

    expect(await subscriptionsOf(ended.tenant.id)).toEqual([expect.objectContaining({ status: "past_due" })]);
    expect(await tenantOf(ended.tenant.id)).toMatchObject({
      status: "active",
      billing_notice: TRIAL_ENDING_NOTICE,
    });
    expect(await emailsOf(ended.tenant.id, "billing.trial_ending")).toEqual([]);
    expect(await tenantOf(moved.tenant.id)).toMatchObject({
      billing_notice: null,
      version: moved.tenant.version + 1,
    });
    expect(await auditOf(moved.tenant.id, "subscription.updated")).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          before: { billingNotice: TRIAL_ENDING_NOTICE },
          after: { billingNotice: null },
          reason: "trial_not_ending",
        }),
      }),
    ]);
    await expectTenantInvalidation(moved.tenant.id);
    expect(await tenantOf(paid.tenant.id)).toMatchObject({
      status: "active",
      billing_notice: null,
      version: paid.tenant.version + 1,
    });
    expect(await subscriptionsOf(paid.tenant.id)).toEqual([
      expect.objectContaining({ status: "active", version: paid.subscription.version }),
    ]);
    expect(await auditOf(paid.tenant.id, "subscription.updated")).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          before: { billingNotice: TRIAL_ENDING_NOTICE },
          after: { billingNotice: null },
          reason: "subscription_active",
        }),
      }),
    ]);
    expect(await emailsOf(paid.tenant.id, "billing.trial_ending")).toEqual([]);
    await expectTenantInvalidation(paid.tenant.id);
    for (const ota of [suspended, invoiced, stripeTrial]) {
      expect(await tenantOf(ota.tenant.id)).toMatchObject({
        status: ota.tenant.status,
        billing_notice: null,
      });
      expect(await subscriptionsOf(ota.tenant.id)).toEqual([
        expect.objectContaining({ status: ota.subscription.status, version: ota.subscription.version }),
      ]);
      expect(await emailsOf(ota.tenant.id, "billing.trial_ending")).toEqual([]);
    }

    // 44 days after its end, but 14 days after it became past due: only now the OTA is suspended.
    t.clock.set(after(base, 13));
    await runManualTrials();
    expect(await tenantOf(ended.tenant.id)).toMatchObject({ status: "active" });
    expect(await subscriptionsOf(ended.tenant.id)).toEqual([expect.objectContaining({ status: "past_due" })]);
    t.clock.set(after(base, 14));
    await runManualTrials();
    expect(await tenantOf(ended.tenant.id)).toMatchObject({
      status: "suspended",
      suspension_reason: "billing",
    });
    expect(await subscriptionsOf(ended.tenant.id)).toEqual([expect.objectContaining({ status: "canceled" })]);
  });

  it("[PBE-047] leaves a trial alone that a completed Checkout replaced after the run read its list", async () => {
    const base = t.clock.set(runDay(80));
    await runManualTrials(); // settle what earlier tests left due by now
    const replaced = await arrangeTrial("pbe047-replaced", {}, { trial_ends_at: after(base, 5) });

    // The run reads its list; then the OTA's completed Checkout cancels the manual row (billing sync) before the run
    // locks the OTA.
    const findOriginal = SubscriptionsRepository.prototype.findManualTrials;
    const list = vi
      .spyOn(SubscriptionsRepository.prototype, "findManualTrials")
      .mockImplementationOnce(async function (this: SubscriptionsRepository, filter) {
        const rows = await findOriginal.call(this, filter);
        await pool.query(
          "UPDATE platform.subscriptions SET status = 'canceled', canceled_at = $2, version = version + 1 WHERE id = $1",
          [replaced.subscription.id, t.clock.now()],
        );
        return rows;
      });
    try {
      expect(await runManualTrials()).toEqual({
        trials: 1,
        emails: 0,
        banners: 0,
        pastDue: 0,
        suspended: 0,
        skipped: 1,
      });
    } finally {
      list.mockRestore();
    }
    expect(await tenantOf(replaced.tenant.id)).toMatchObject({
      status: "active",
      billing_notice: null,
      version: replaced.tenant.version,
    });
    expect(await emailsOf(replaced.tenant.id, "billing.trial_ending")).toEqual([]);
    expect(await auditOf(replaced.tenant.id, "subscription.updated")).toEqual([]);
  });
});

// ---- Registration --------------------------------------------------------------------------------------------------

describe("the schedules", () => {
  it("[PBE-047] are registered only with FEATURE_STRIPE_BILLING on, through the scheduler registry, and handled by the worker", async () => {
    const ids = [ABANDONED_CHECKOUTS_JOB, MANUAL_TRIALS_JOB];
    expect(PLATFORM_SCHEDULES.filter((schedule) => ids.includes(schedule.id))).toEqual([
      expect.objectContaining({
        id: ABANDONED_CHECKOUTS_JOB,
        pattern: "20 3 * * *",
        features: ["stripe_billing"],
      }),
      expect.objectContaining({ id: MANUAL_TRIALS_JOB, pattern: "10 8 * * *", features: ["stripe_billing"] }),
    ]);
    const registered = async (feature: boolean): Promise<string[]> => {
      const upserted: string[] = [];
      const queue: SchedulerQueue = {
        upsertJobScheduler: (id: string) => {
          upserted.push(id);
          return Promise.resolve(undefined as never);
        },
        removeJobScheduler: () => Promise.resolve(true),
        getJobSchedulers: () => Promise.resolve([]),
      };
      // The application's configuration, with FEATURE_STRIPE_BILLING as `feature`.
      const config = t.app.get(ConfigService);
      const get = ((name: string): unknown =>
        name === "FEATURE_STRIPE_BILLING" ? feature : config.get<unknown>(name)) as ConfigService["get"];
      const switches = configuredSwitches({ get });
      await registerSchedules(queue, PLATFORM_SCHEDULES, switches);
      return upserted.filter((id) => ids.includes(id));
    };

    // This file's application has the switch on, as configured.
    expect(t.config.FEATURE_STRIPE_BILLING).toBe(true);
    expect(await registered(true)).toEqual(ids);
    expect(await registered(false)).toEqual([]);
    // The worker's maintenance processor finds a handler for each.
    const handlers = maintenanceHandlers(worker.get(DiscoveryService).getProviders(), worker.get(Reflector));
    expect(ids.every((id) => handlers.has(id))).toBe(true);
  });
});
