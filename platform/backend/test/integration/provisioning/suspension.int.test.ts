// Suspension, resume and the connection switch of an OTA (PBE-030; PADR-0014, scope PF-82, platform/docs/
// api-inventory-admin.md §3, flows/platform-admin-operations.md §B and "Failure handling", PADR-0001 item 7) through
// the platform admin's routes (createTestApp) on this file's database clone and Redis database. The worker's module
// graph (WorkerModule, with the API's FakeClock) consumes `platform-tenant-events`, sends the e-mails and holds the
// reconciler, which the tests run themselves (`ReconcilerScheduler.run`) after moving the FakeClock past a lease or a
// backoff; the fake OTA worker (test/support/fake-ota-worker.ts) answers `tenant.suspend` and `tenant.resume`, or
// stays silent like the real OTA worker before its consumer exists (OBE-074). Every answer is checked against the
// platform document. Billing sync's `system` actor (M5) has no route yet, so its tests call SuspensionService of the
// API's module graph directly.
//
// Every test arranges its own OTA (an owner with an address of this test only, a subscription) with the builders, and
// the jobs a test leaves active are canceled after it, so a later reconciler run never takes them up. The expensive
// part of the reconciler group (five attempts of two jobs) runs in its set-up hook, with an explicit bound.
import { isDeepStrictEqual } from "node:util";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  bullmqJobId,
  INVALIDATION_CHANNEL,
  OTA_TENANT_OPS,
  PLATFORM_TENANT_EVENTS,
  validateJob,
  type InvalidationEvent,
  type TenantSuspendedEvent,
} from "@velexis/api-types/jobs";
import { AppError } from "@velexis/errors";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Job, Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { DISPATCH_LEASE_MS, tenantOpsMessage } from "../../../src/provisioning/dispatcher";
import { retryDelayMs } from "../../../src/provisioning/failure-handler";
import { PROVISION_MAX_ATTEMPTS } from "../../../src/provisioning/provisioning-jobs.repository";
import { ReconcilerScheduler } from "../../../src/provisioning/reconciler.scheduler";
import { SuspensionService, type LifecycleActor } from "../../../src/provisioning/suspension.service";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertAmadeusAccount,
  insertPaymentConnection,
  insertSubscription,
  insertSupplierConnection,
  insertTenant,
  testId,
  velexisSource,
  type PlatformRow,
  type SubscriptionRow,
  type TenantRow,
} from "../../builders/platform-rows";
import { insertMember } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FakeOtaWorker, schemaNamesFrom } from "../../support/fake-ota-worker";

/**
 * Starting the API, the worker's module graph and the fake OTA worker takes seconds, and the platform document and the
 * job validators compile on first use; the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** The reconciler group's set-up: five dispatched attempts of two jobs, each answered (silently) by the fake. */
const RECONCILER_SETUP_TIMEOUT_MS = 60_000;
/** How long a hook or a test waits for the worker, the fake OTA worker, BullMQ or an e-mail. */
const WAIT_MS = 20_000;
/** How long a test waits for an invalidation published after a commit: under the 5-second bound of a test. */
const EVENT_WAIT_MS = 3000;
/** Documentation address (RFC 5737). */
const ADMIN_IP = "198.51.100.30";
const OPS_EMAIL = uniqueEmail("ops-suspension");
/** The admin family of this file's tokens. */
const FAMILY = testId("asn", 3001);
/** A written reason of an admin action (5–500 characters). */
const REASON = "Card testing from the storefront reported by Stripe.";

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let fake: FakeOtaWorker;
let reconciler: ReconcilerScheduler;
let tenantOps: Queue;
let tenantEvents: Queue;
let subscriber: Redis;
const events: InvalidationEvent[] = [];
const workerLogs = new LogSink();
let admin: PlatformRow<"accounts">;
let amadeusAccount: PlatformRow<"amadeus_accounts">;
/** Ids of this file's rows: tenants, jobs and audit rows stay between tests, so each test writes rows of its own. */
let next = 1;

beforeAll(async () => {
  // Expensive set-up, once per file: the database clone, the API's and the worker's Nest module graphs, the fake OTA
  // worker, the invalidation subscriber, the platform document that expectResponseToMatch parses on its first use,
  // and the Ajv validators of the job messages (validateJob compiles them on its first call).
  t = await createTestApp({ env: { OPS_ALERT_EMAIL: OPS_EMAIL } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tenantOps = t.app.get<Queue>(getQueueToken(OTA_TENANT_OPS), { strict: false });
  tenantEvents = t.app.get<Queue>(getQueueToken(PLATFORM_TENANT_EVENTS), { strict: false });
  responseChecker("platform");
  tenantOpsMessage({
    name: "tenant.suspend",
    jobId: testId("job", 1),
    tenantId: testId("ten", 1),
    payload: { reason: "admin" },
    requestedAt: t.clock.now(),
    requestId: "warm-up-request-id",
  });

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .compile();
  await worker.init();
  reconciler = worker.get(ReconcilerScheduler, { strict: false });

  fake = await FakeOtaWorker.start({
    redisUrl: t.redis.url,
    schemaNameOf: schemaNamesFrom(pool),
    now: () => t.clock.now(),
  });

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    events.push(JSON.parse(message) as InvalidationEvent);
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);

  admin = await insertAccount(pool, {
    id: testId("acc", 3000),
    email: uniqueEmail("admin-suspension"),
    is_platform_admin: true,
    mfa_enabled: true,
  });
  amadeusAccount = await insertAmadeusAccount(pool, { id: testId("ama", 3000) });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await fake?.close();
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  // A job a test left active must not be dispatched or reconciled by a later test's reconciler run.
  await pool.query(
    "UPDATE platform.provisioning_jobs SET status = 'canceled', locked_until = NULL WHERE status IN ('queued', 'running')",
  );
});

// ---- Calls --------------------------------------------------------------------------------------------------------

async function post(path: string, body: object): Promise<Response> {
  const { token } = await t.app.get(TokenService).sign({
    aud: "platform_admin",
    sub: admin.id,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
  });
  return t.http
    .post(path)
    .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) })
    .send(body);
}

function errorOf(res: Response): { code: string; details?: Record<string, unknown> } {
  return (res.body as { error: { code: string; details?: Record<string, unknown> } }).error;
}

// ---- Arrangement --------------------------------------------------------------------------------------------------

interface Arranged {
  readonly tenant: PlatformRow<"tenants">;
  readonly owner: PlatformRow<"accounts">;
}

/** An OTA of this test (active unless `tenant` says otherwise) with its owner and a manual trial. */
async function arrange(
  options: { readonly tenant?: Partial<TenantRow>; readonly subscription?: Partial<SubscriptionRow> } = {},
): Promise<Arranged> {
  const n = next++;
  const owner = await insertAccount(pool, {
    id: testId("acc", 3100 + n),
    email: uniqueEmail(`suspension-owner${n}`),
    full_name: `Owner ${n}`,
  });
  const tenant = await insertTenant(pool, {
    id: testId("ten", 3100 + n),
    key: `suspension${n}`,
    name: `Suspension ${n} Travel`,
    ...options.tenant,
  });
  await insertMember(pool, tenant, owner, "owner");
  await insertSubscription(pool, tenant, { id: testId("sub", 3100 + n), ...options.subscription });
  return { tenant, owner };
}

async function tenantRow(tenantId: string): Promise<PlatformRow<"tenants">> {
  const { rows } = await pool.query("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]);
  return rows[0] as PlatformRow<"tenants">;
}

async function jobRow(jobId: string): Promise<PlatformRow<"provisioning_jobs">> {
  const { rows } = await pool.query("SELECT * FROM platform.provisioning_jobs WHERE id = $1", [jobId]);
  return rows[0] as PlatformRow<"provisioning_jobs">;
}

async function jobsOf(tenantId: string): Promise<Array<PlatformRow<"provisioning_jobs">>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.provisioning_jobs WHERE tenant_id = $1 ORDER BY created_at, id",
    [tenantId],
  );
  return rows as Array<PlatformRow<"provisioning_jobs">>;
}

/** The audit rows of `action` about the tenant, oldest first. */
async function auditOf(tenantId: string, action: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id",
    [tenantId, action],
  );
  return rows as Array<Record<string, unknown>>;
}

/** The `email_outbox` rows of `template` about the tenant. */
async function emailsOf(tenantId: string, template: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.email_outbox WHERE tenant_id = $1 AND template = $2 ORDER BY created_at",
    [tenantId, template],
  );
  return rows as Array<Record<string, unknown>>;
}

/** Waits until the job has `status`, and returns its row. */
async function jobReaches(jobId: string, status: string): Promise<PlatformRow<"provisioning_jobs">> {
  await expect
    .poll(async () => (await jobRow(jobId)).status, { timeout: WAIT_MS, interval: 20 })
    .toBe(status);
  return jobRow(jobId);
}

/** Waits until an invalidation equal to `event` was published. */
async function published(event: InvalidationEvent): Promise<void> {
  await expect
    .poll(() => events.some((seen) => isDeepStrictEqual(seen, event)), {
      timeout: EVENT_WAIT_MS,
      interval: 20,
    })
    .toBe(true);
}

/**
 * Adds the OTA worker's answer `event` of attempt `attempt` to `platform-tenant-events` (with the BullMQ id the OTA
 * worker gives it) and waits until the worker's consumer finished it.
 */
async function answer(event: TenantSuspendedEvent, attempt: number): Promise<Job> {
  const added = await tenantEvents.add(event.name, event, { jobId: bullmqJobId(event.jobId, attempt) });
  const id = added.id;
  if (id === undefined) {
    throw new Error("BullMQ gave the answer no id");
  }
  await expect
    .poll(async () => ["completed", "failed"].includes(await tenantEvents.getJobState(id)), {
      timeout: WAIT_MS,
      interval: 20,
    })
    .toBe(true);
  const done = await tenantEvents.getJob(id);
  if (done === undefined) {
    throw new Error(`no BullMQ job ${id}`);
  }
  return done;
}

/** The AppError a call rejected with (fails the test when it resolved or threw something else). */
async function rejectionOf(call: Promise<unknown>): Promise<AppError> {
  const error = await call.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AppError)) {
    throw new Error(`expected an AppError, got ${String(error)}`);
  }
  return error;
}

/**
 * Waits until the fake OTA worker took attempt `attempt` of `jobId` and BullMQ finished its message. Usable in hooks
 * (expect.poll is not): it polls every 20 ms and rejects after WAIT_MS.
 */
async function handled(jobId: string, attempt: number): Promise<void> {
  const id = bullmqJobId(jobId, attempt);
  await fake.waitForHandled((all) => all.some((entry) => entry.bullmqJobId === id), WAIT_MS);
  const deadline = Date.now() + WAIT_MS;
  while (!["completed", "failed"].includes(await tenantOps.getJobState(id))) {
    if (Date.now() > deadline) {
      throw new Error(`the BullMQ job ${id} did not finish within ${WAIT_MS} ms`);
    }
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 20));
  }
}

// ---- Tests --------------------------------------------------------------------------------------------------------

describe("adminSuspendTenant", () => {
  it("[PBE-030 AC1] sets the status, writes one platform_admin audit row, publishes the tenant invalidation, sends tenant.suspend and e-mails the owners [PF-82]", async () => {
    const { tenant, owner } = await arrange();
    // A member who is not an owner gets no e-mail.
    const member = await insertAccount(pool, {
      id: testId("acc", 3190),
      email: uniqueEmail("suspension-admin"),
    });
    await insertMember(pool, tenant, member, "admin");
    const now = t.clock.now();

    const res = await post(`/v1/admin/tenants/${tenant.id}/suspend`, {
      suspensionReason: "abuse",
      reason: REASON,
    });

    expect(res.status).toBe(202);
    expectResponseToMatch("adminSuspendTenant", res, { document: "platform" });
    const body = res.body as {
      tenant: Record<string, unknown>;
      job: { id: string; kind: string; status: string; attempt: number };
    };
    expect(body.tenant).toMatchObject({
      id: tenant.id,
      status: "suspended",
      suspensionReason: "abuse",
      suspendedAt: now.toISOString(),
      version: tenant.version + 1,
    });
    expect(body.job).toMatchObject({ kind: "suspend", attempt: 1 });
    // The fake answers at once, so the job may have succeeded already.
    expect(["running", "succeeded"]).toContain(body.job.status);
    expect(await tenantRow(tenant.id)).toMatchObject({
      status: "suspended",
      suspension_reason: "abuse",
      suspended_at: now,
      version: tenant.version + 1,
    });

    const audit = await auditOf(tenant.id, "tenant.suspended");
    expect(audit).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        target_type: "tenant",
        target_id: tenant.id,
        details: expect.objectContaining({
          jobId: body.job.id,
          suspensionReason: "abuse",
          reason: REASON,
          before: { status: "active" },
          after: { status: "suspended", suspensionReason: "abuse" },
        }) as unknown,
      }),
    ]);
    await published({ v: 1, type: "tenant", id: tenant.id });

    const all = await fake.waitForHandled(
      (handledSoFar) => handledSoFar.some((entry) => entry.message.jobId === body.job.id),
      WAIT_MS,
    );
    const sent = all.find((entry) => entry.message.jobId === body.job.id);
    expect(sent?.message).toMatchObject({
      name: "tenant.suspend",
      jobId: body.job.id,
      tenantId: tenant.id,
      payload: { reason: "abuse" },
    });
    expect(sent?.bullmqJobId).toBe(bullmqJobId(body.job.id, 1));

    const mail = await waitForMessage({ to: owner.email, timeoutMs: WAIT_MS });
    expect(mail.Subject).toBe(`${tenant.name} has been suspended`);
    expect((await emailsOf(tenant.id, "tenant.suspended")).map((row) => row["to_email"])).toEqual([
      owner.email,
    ]);

    // The fake's `tenant.suspended` answer ends the job (PADR-0014 item 7); the tenant stays suspended.
    const succeeded = await jobReaches(body.job.id, "succeeded");
    expect(succeeded).toMatchObject({ kind: "suspend", attempt: 1, error: null, locked_until: null });
    expect(succeeded.payload).toEqual({ reason: "abuse" });
    expect(succeeded.requested_by_account_id).toBe(admin.id);
    expect((await tenantRow(tenant.id)).status).toBe("suspended");
    expect(fake.invalid).toEqual([]);
  });

  it("answers 409 CONFLICT for an OTA that is not active, 404 for an unknown one and 400 for a billing reason, writing nothing", async () => {
    const { tenant } = await arrange({ tenant: { status: "provisioning", activated_at: null } });
    const path = `/v1/admin/tenants/${tenant.id}/suspend`;

    const notActive = await post(path, { suspensionReason: "admin", reason: REASON });
    expect(notActive.status).toBe(409);
    expectResponseToMatch("adminSuspendTenant", notActive, { document: "platform" });
    expect(errorOf(notActive)).toMatchObject({
      code: "CONFLICT",
      details: { reason: "not_active", status: "provisioning" },
    });

    const unknown = await post(`/v1/admin/tenants/${testId("ten", 3199)}/suspend`, {
      suspensionReason: "admin",
      reason: REASON,
    });
    expect(unknown.status).toBe(404);
    expectResponseToMatch("adminSuspendTenant", unknown, { document: "platform" });

    // `billing` is billing sync's reason only (PADR-0014 item 1).
    const billing = await post(path, { suspensionReason: "billing", reason: REASON });
    expect(billing.status).toBe(400);
    expectResponseToMatch("adminSuspendTenant", billing, { document: "platform" });

    expect(await tenantRow(tenant.id)).toMatchObject({ status: "provisioning", version: tenant.version });
    expect(await jobsOf(tenant.id)).toEqual([]);
    expect(await auditOf(tenant.id, "tenant.suspended")).toEqual([]);
  });

  it("supersedes the suspend job that still waits for its answer when the OTA is suspended again", async () => {
    const { tenant } = await arrange();
    fake.setOutcome(tenant.id, { type: "silent" });

    const first = await post(`/v1/admin/tenants/${tenant.id}/suspend`, {
      suspensionReason: "admin",
      reason: REASON,
    });
    expect(first.status).toBe(202);
    const firstJob = (first.body as { job: { id: string } }).job.id;
    await handled(firstJob, 1);
    expect((await jobRow(firstJob)).status).toBe("running");
    expect((await post(`/v1/admin/tenants/${tenant.id}/resume`, { reason: REASON })).status).toBe(202);

    const again = await post(`/v1/admin/tenants/${tenant.id}/suspend`, {
      suspensionReason: "request",
      reason: REASON,
    });

    expect(again.status).toBe(202);
    const secondJob = (again.body as { job: { id: string; status: string } }).job;
    expect(secondJob).toMatchObject({ status: "running" });
    expect(await jobRow(firstJob)).toMatchObject({
      status: "canceled",
      locked_until: null,
      error: `SUPERSEDED: The suspend job ${secondJob.id} replaced this job before its answer.`,
    });
    const audit = await auditOf(tenant.id, "tenant.suspended");
    expect(audit).toHaveLength(2);
    expect(audit[1]?.["details"]).toMatchObject({ jobId: secondJob.id, supersededJobIds: [firstJob] });
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "suspended", suspension_reason: "request" });

    // A late answer of the superseded job leaves it canceled; the new job still waits for its own answer.
    const late = await answer(
      validateJob("tenant.suspended", {
        v: 1,
        name: "tenant.suspended",
        jobId: firstJob,
        tenantId: tenant.id,
        requestedAt: t.clock.now().toISOString(),
        requestId: "late-suspended-answer",
        payload: {},
      }),
      1,
    );
    expect(late.returnvalue).toEqual({ outcome: "ignored", reason: "finished" });
    expect((await jobRow(firstJob)).status).toBe("canceled");
    expect((await jobRow(secondJob.id)).status).toBe("running");
  });
});

describe("adminResumeTenant", () => {
  it("[PBE-030 AC2] answers 409 for a billing suspension without a valid subscription, and resumes an admin suspension", async () => {
    const suspendedAt = new Date(t.clock.now().getTime() - 60 * 60 * 1000);
    const billing = await arrange({
      tenant: { status: "suspended", suspension_reason: "billing", suspended_at: suspendedAt },
      subscription: { status: "past_due", billing_provider: "stripe" },
    });
    const byAdmin = await arrange({
      tenant: { status: "suspended", suspension_reason: "admin", suspended_at: suspendedAt },
    });

    const refused = await post(`/v1/admin/tenants/${billing.tenant.id}/resume`, { reason: REASON });

    expect(refused.status).toBe(409);
    expectResponseToMatch("adminResumeTenant", refused, { document: "platform" });
    expect(errorOf(refused)).toMatchObject({
      code: "CONFLICT",
      details: { reason: "subscription_not_active", subscriptionStatus: "past_due" },
    });
    expect(await tenantRow(billing.tenant.id)).toMatchObject({
      status: "suspended",
      suspension_reason: "billing",
      version: billing.tenant.version,
    });
    expect(await jobsOf(billing.tenant.id)).toEqual([]);
    expect(await auditOf(billing.tenant.id, "tenant.resumed")).toEqual([]);

    const resumed = await post(`/v1/admin/tenants/${byAdmin.tenant.id}/resume`, { reason: REASON });

    expect(resumed.status).toBe(202);
    expectResponseToMatch("adminResumeTenant", resumed, { document: "platform" });
    const body = resumed.body as { tenant: Record<string, unknown>; job: { id: string; kind: string } };
    expect(body.tenant).toMatchObject({
      status: "active",
      suspensionReason: null,
      suspendedAt: null,
      version: byAdmin.tenant.version + 1,
    });
    expect(body.job.kind).toBe("resume");
    expect(await tenantRow(byAdmin.tenant.id)).toMatchObject({
      status: "active",
      suspension_reason: null,
      suspended_at: null,
    });
    expect(await auditOf(byAdmin.tenant.id, "tenant.resumed")).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        details: expect.objectContaining({
          jobId: body.job.id,
          reason: REASON,
          before: { status: "suspended", suspensionReason: "admin", suspendedAt: suspendedAt.toISOString() },
          after: { status: "active" },
        }) as unknown,
      }),
    ]);
    await published({ v: 1, type: "tenant", id: byAdmin.tenant.id });
    const mail = await waitForMessage({ to: byAdmin.owner.email, timeoutMs: WAIT_MS });
    expect(mail.Subject).toBe(`${byAdmin.tenant.name} is active again`);
    await fake.waitForHandled(
      (all) =>
        all.some((entry) => entry.message.jobId === body.job.id && entry.message.name === "tenant.resume"),
      WAIT_MS,
    );
    expect((await jobReaches(body.job.id, "succeeded")).kind).toBe("resume");
  });

  it("resumes a billing suspension once the subscription is active, and answers 409 for an OTA that is not suspended", async () => {
    const paid = await arrange({
      tenant: { status: "suspended", suspension_reason: "billing", suspended_at: t.clock.now() },
      subscription: { status: "active", billing_provider: "stripe" },
    });
    const active = await arrange();

    const resumed = await post(`/v1/admin/tenants/${paid.tenant.id}/resume`, { reason: REASON });
    expect(resumed.status).toBe(202);
    expect((await tenantRow(paid.tenant.id)).status).toBe("active");

    const notSuspended = await post(`/v1/admin/tenants/${active.tenant.id}/resume`, { reason: REASON });
    expect(notSuspended.status).toBe(409);
    expectResponseToMatch("adminResumeTenant", notSuspended, { document: "platform" });
    expect(errorOf(notSuspended)).toMatchObject({
      code: "CONFLICT",
      details: { reason: "not_suspended", status: "active" },
    });
  });
});

describe("billing sync's suspensions (SuspensionService with the system actor)", () => {
  const billingSync: LifecycleActor = { type: "system", label: "billing", requestId: "billing-sync-request" };

  it("suspends for billing as the system, and lifts only a billing suspension once the subscription is paid again", async () => {
    const suspensions = t.app.get(SuspensionService, { strict: false });
    const { tenant, owner } = await arrange({
      subscription: { status: "past_due", billing_provider: "stripe" },
    });

    const suspended = await suspensions.suspend(tenant.id, "billing", billingSync);

    expect(suspended.tenant).toMatchObject({ status: "suspended", suspension_reason: "billing" });
    expect(suspended.job).toMatchObject({ kind: "suspend" });
    const job = await jobRow(suspended.job.id);
    expect(job.requested_by_account_id).toBeNull();
    expect(job.payload).toEqual({ reason: "billing" });
    expect(await auditOf(tenant.id, "tenant.suspended")).toEqual([
      expect.objectContaining({
        actor_type: "system",
        actor_account_id: null,
        actor_label: "billing",
        request_id: "billing-sync-request",
        details: expect.objectContaining({ suspensionReason: "billing" }) as unknown,
      }),
    ]);
    expect((await emailsOf(tenant.id, "tenant.suspended")).map((row) => row["to_email"])).toEqual([
      owner.email,
    ]);

    // Still past due: the suspension stays.
    const unpaid = await rejectionOf(suspensions.resume(tenant.id, billingSync));
    expect(unpaid).toMatchObject({
      code: "CONFLICT",
      details: { reason: "subscription_not_active", subscriptionStatus: "past_due" },
    });
    expect((await tenantRow(tenant.id)).status).toBe("suspended");

    await pool.query("UPDATE platform.subscriptions SET status = 'active' WHERE tenant_id = $1", [tenant.id]);
    const resumed = await suspensions.resume(tenant.id, billingSync);

    expect(resumed.tenant).toMatchObject({ status: "active", suspension_reason: null, suspended_at: null });
    expect(await auditOf(tenant.id, "tenant.resumed")).toEqual([
      expect.objectContaining({ actor_type: "system", actor_label: "billing" }),
    ]);
  });

  it("never lifts a suspension for another reason, and refuses billing as a platform admin's reason", async () => {
    const suspensions = t.app.get(SuspensionService, { strict: false });
    const { tenant } = await arrange({
      tenant: { status: "suspended", suspension_reason: "abuse", suspended_at: t.clock.now() },
    });

    const refused = await rejectionOf(suspensions.resume(tenant.id, billingSync));
    expect(refused).toMatchObject({
      code: "CONFLICT",
      details: { reason: "not_billing_suspension", suspensionReason: "abuse" },
    });
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "suspended", version: tenant.version });

    const active = await arrange();
    await expect(
      suspensions.suspend(active.tenant.id, "billing", {
        type: "platform_admin",
        accountId: admin.id,
        reason: REASON,
      }),
    ).rejects.toThrow(/billing sync only/);
    expect(await tenantRow(active.tenant.id)).toMatchObject({
      status: "active",
      version: active.tenant.version,
    });
    expect(await jobsOf(tenant.id)).toEqual([]);
    expect(await jobsOf(active.tenant.id)).toEqual([]);
  });
});

describe("adminSetConnectionStatus", () => {
  it("[PBE-030 AC4] disabling the test Amadeus connection publishes {type: connection, tenantId}, and only a disabled one is enabled again", async () => {
    const { tenant } = await arrange();
    const office = `NCE1A${String(3000 + next).padStart(4, "0")}`;
    const connection = await insertSupplierConnection(pool, tenant, {
      ...velexisSource(amadeusAccount),
      id: testId("sc", 3100 + next),
      office_ids: [office],
      default_office_id: office,
      status: "active",
    });
    const path = `/v1/admin/tenants/${tenant.id}/connections/amadeus/test/status`;

    const disabled = await post(path, { status: "disabled", reason: REASON });

    expect(disabled.status).toBe(200);
    expectResponseToMatch("adminSetConnectionStatus", disabled, { document: "platform" });
    expect(disabled.body).toMatchObject({
      id: connection.id,
      environment: "test",
      credentialSource: "velexis",
      status: "disabled",
      officeIds: [office],
      version: connection.version + 1,
    });
    await published({ v: 1, type: "connection", tenantId: tenant.id });
    expect(await auditOf(tenant.id, "connection.status_changed")).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        target_type: "supplier_connection",
        target_id: connection.id,
        details: expect.objectContaining({
          kind: "amadeus",
          environment: "test",
          reason: REASON,
          before: { status: "active" },
          after: { status: "disabled" },
        }) as unknown,
      }),
    ]);

    // Disabling it again changes nothing and writes nothing.
    const again = await post(path, { status: "disabled", reason: REASON });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "disabled", version: connection.version + 1 });
    expect(await auditOf(tenant.id, "connection.status_changed")).toHaveLength(1);

    const enabled = await post(path, { status: "active", reason: REASON });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({ status: "active", version: connection.version + 2 });

    const notDisabled = await post(path, { status: "active", reason: REASON });
    expect(notDisabled.status).toBe(409);
    expectResponseToMatch("adminSetConnectionStatus", notDisabled, { document: "platform" });
    expect(errorOf(notDisabled)).toMatchObject({
      code: "CONFLICT",
      details: { reason: "not_disabled", status: "active" },
    });
    expect(await auditOf(tenant.id, "connection.status_changed")).toHaveLength(2);
  });

  it("switches the payment connection, answers 404 without a connection and 409 for an Amadeus connection without an office", async () => {
    const { tenant } = await arrange();
    const payment = await insertPaymentConnection(pool, tenant, { id: testId("ppc", 3100 + next) });
    await insertSupplierConnection(pool, tenant, {
      ...velexisSource(amadeusAccount),
      id: testId("sc", 3100 + next),
      status: "disabled",
    });

    const disabled = await post(`/v1/admin/tenants/${tenant.id}/connections/payment/test/status`, {
      status: "disabled",
      reason: REASON,
    });
    expect(disabled.status).toBe(200);
    expectResponseToMatch("adminSetConnectionStatus", disabled, { document: "platform" });
    expect(disabled.body).toMatchObject({
      id: payment.id,
      provider: "stripe",
      accountMode: "velexis",
      status: "disabled",
    });
    expect(await auditOf(tenant.id, "connection.status_changed")).toEqual([
      expect.objectContaining({ target_type: "payment_connection", target_id: payment.id }),
    ]);

    const none = await post(`/v1/admin/tenants/${tenant.id}/connections/payment/live/status`, {
      status: "disabled",
      reason: REASON,
    });
    expect(none.status).toBe(404);
    expectResponseToMatch("adminSetConnectionStatus", none, { document: "platform" });

    const noOffice = await post(`/v1/admin/tenants/${tenant.id}/connections/amadeus/test/status`, {
      status: "active",
      reason: REASON,
    });
    expect(noOffice.status).toBe(409);
    expect(errorOf(noOffice)).toMatchObject({ code: "CONFLICT", details: { reason: "no_office" } });
  });
});

describe("suspend and resume jobs without an OTA consumer", () => {
  let suspended: Arranged;
  let resumed: Arranged;
  let suspendJobId: string;
  let resumeJobId: string;

  beforeAll(async () => {
    // Expensive: both jobs run through every attempt the reconciler gives them (PROVISION_MAX_ATTEMPTS), each one
    // dispatched, taken silently by the fake (as the real OTA worker rejects the unknown names) and counted as lost
    // once the FakeClock passes its lease. Bounded by RECONCILER_SETUP_TIMEOUT_MS for a loaded CI runner.
    suspended = await arrange();
    resumed = await arrange({
      tenant: { status: "suspended", suspension_reason: "admin", suspended_at: t.clock.now() },
    });
    for (const { tenant } of [suspended, resumed]) {
      fake.setOutcome(tenant.id, { type: "silent" });
    }
    const suspend = await post(`/v1/admin/tenants/${suspended.tenant.id}/suspend`, {
      suspensionReason: "admin",
      reason: REASON,
    });
    const resume = await post(`/v1/admin/tenants/${resumed.tenant.id}/resume`, { reason: REASON });
    if (suspend.status !== 202 || resume.status !== 202) {
      throw new Error(`suspend answered ${suspend.status} and resume ${resume.status}, not 202`);
    }
    suspendJobId = (suspend.body as { job: { id: string } }).job.id;
    resumeJobId = (resume.body as { job: { id: string } }).job.id;

    for (let attempt = 1; attempt <= PROVISION_MAX_ATTEMPTS; attempt += 1) {
      await handled(suspendJobId, attempt);
      await handled(resumeJobId, attempt);
      t.clock.advance(DISPATCH_LEASE_MS);
      await reconciler.run();
      if (attempt < PROVISION_MAX_ATTEMPTS) {
        t.clock.advance(retryDelayMs(attempt));
        await reconciler.run();
      }
    }
  }, RECONCILER_SETUP_TIMEOUT_MS);

  it("[PBE-030 AC5] with a silent fake worker, a suspend job ends failed after the reconciler's attempts and the tenant stays suspended; the same holds for a resume job and an active tenant [PADR-0001 item 7]", async () => {
    for (const [arranged, jobId, kind, status] of [
      [suspended, suspendJobId, "suspend", "suspended"],
      [resumed, resumeJobId, "resume", "active"],
    ] as const) {
      expect(await jobRow(jobId)).toMatchObject({
        kind,
        status: "failed",
        attempt: PROVISION_MAX_ATTEMPTS,
        locked_until: null,
      });
      expect((await jobRow(jobId)).error).toMatch(/^ATTEMPT_LOST: /);
      // The status switch of the HTTP call is the effect; the failed job never changes it.
      expect(await tenantRow(arranged.tenant.id)).toMatchObject({
        status,
        version: arranged.tenant.version + 1,
      });
      expect(await auditOf(arranged.tenant.id, "tenant.provisioning_failed")).toEqual([]);
      expect(await emailsOf(arranged.tenant.id, "ops.alert")).toHaveLength(1);
    }
    await waitForMessage({
      to: OPS_EMAIL,
      subject: `[Velexis ops] Provisioning job failed: suspend of ${suspended.tenant.key}`,
      timeoutMs: WAIT_MS,
    });
  });
});
