// Failed provisioning attempts, the reconciler and the owner's retry (PBE-023; platform/docs/flows/provisioning.md
// "Failure handling", PADR-0001 items 4, 6 and 7, scope PF-11 AC2) on this file's database clone and Redis database:
// the API (createTestApp) dispatches and answers the portal, the fake OTA worker (test/support/fake-ota-worker.ts)
// answers `tenant.provision_failed`, `tenant.provisioned` or nothing, and the worker's module graph (WorkerModule, as
// dist/worker.js builds it, with the API's FakeClock) consumes `platform-tenant-events` and holds the reconciler, which
// the tests run themselves (`ReconcilerScheduler.run`) after moving the FakeClock past a backoff or a lease, as the
// `provisioning.reconcile` schedule would every 5 minutes.
//
// Every test arranges its own OTA (an owner with an address of this test only, a manual trial, a `provision` job) with
// the builders. After each test the jobs still active are canceled, so a later run of the reconciler, at a later time
// of the shared FakeClock, never takes them up. OPS_ALERT_EMAIL is this file's own (`uniqueEmail`).
import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  bullmqJobId,
  OTA_PROVISIONING_STEPS,
  OTA_TENANT_OPS,
  PLATFORM_TENANT_EVENTS,
  validateJob,
  type TenantProvisionFailedEvent,
} from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Job, Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import {
  DISPATCH_LEASE_MS,
  ProvisioningDispatcher,
  tenantOpsMessage,
} from "../../../src/provisioning/dispatcher";
import { retryDelayMs } from "../../../src/provisioning/failure-handler";
import { CreatePaymentConnectionStep } from "../../../src/provisioning/post-steps/create-payment-connection.step";
import { POST_STEP_NAMES } from "../../../src/provisioning/post-steps/post-steps.runner";
import { LEASE_EXTENDED_BY } from "../../../src/provisioning/provisioning-jobs.repository";
import { ATTEMPT_LOST_CODE, ReconcilerScheduler } from "../../../src/provisioning/reconciler.scheduler";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertRow,
  insertSubscription,
  insertTenant,
  testId,
  type PlatformInsert,
  type PlatformRow,
  type SubscriptionRow,
  type TenantRow,
} from "../../builders/platform-rows";
import { insertMember } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FakeOtaWorker, schemaNamesFrom } from "../../support/fake-ota-worker";

/** Starting the API, the worker's module graph and the fake OTA worker takes seconds; bounded for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker or an e-mail. */
const WAIT_MS = 20_000;
/** Documentation address (RFC 5737). */
const PERSON_IP = "203.0.113.7";
const OPS_EMAIL = uniqueEmail("ops-failures");
/** The error the fake OTA worker reports for a retryable failure, as the job keeps it. */
const LOCK_TIMEOUT_ERROR = "run_migrations failed: LOCK_TIMEOUT: canceling statement due to lock timeout";

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let fake: FakeOtaWorker;
let dispatcher: ProvisioningDispatcher;
let reconciler: ReconcilerScheduler;
let tenantOps: Queue;
let tenantEvents: Queue;
const workerLogs = new LogSink();
/** Ids of this file's rows: audit rows and tenants stay between tests, so each test writes rows of its own. */
let next = 1;

beforeAll(async () => {
  // Expensive set-up, once per file: the database clone, the API's and the worker's Nest module graphs, the fake OTA
  // worker's Redis connections, the platform document that expectResponseToMatch parses on its first use, and the Ajv
  // validators of the job messages (validateJob compiles them on its first call). 60 s covers a slow CI runner.
  t = await createTestApp({ env: { OPS_ALERT_EMAIL: OPS_EMAIL } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  dispatcher = t.app.get(ProvisioningDispatcher, { strict: false });
  tenantOps = t.app.get<Queue>(getQueueToken(OTA_TENANT_OPS), { strict: false });
  tenantEvents = t.app.get<Queue>(getQueueToken(PLATFORM_TENANT_EVENTS), { strict: false });
  responseChecker("platform");
  tenantOpsMessage({
    name: "tenant.provision",
    jobId: testId("job", 1),
    tenantId: testId("ten", 1),
    payload: {},
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
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
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

// ---- Arrangement --------------------------------------------------------------------------------------------------

interface ArrangeOptions {
  readonly tenant?: Partial<TenantRow>;
  readonly subscription?: Partial<SubscriptionRow>;
  readonly job?: Partial<PlatformInsert<"provisioning_jobs">>;
}

interface Arranged {
  readonly tenant: PlatformRow<"tenants">;
  readonly owner: PlatformRow<"accounts">;
  readonly jobId: string;
}

/**
 * A `provisioning` OTA with its owner (an address of this test only), a manual trial and a `provision` job, `queued`
 * with no attempt made and due now, unless `options` say otherwise.
 */
async function arrange(options: ArrangeOptions = {}): Promise<Arranged> {
  const n = next++;
  const owner = await insertAccount(pool, {
    id: testId("acc", 2000 + n),
    email: uniqueEmail(`owner${n}`),
    full_name: `Owner ${n}`,
  });
  const tenant = await insertTenant(pool, {
    id: testId("ten", 2000 + n),
    key: `failures${n}`,
    name: `Failures ${n} Travel`,
    status: "provisioning",
    activated_at: null,
    ...options.tenant,
  });
  await insertMember(pool, tenant, owner, "owner");
  await insertSubscription(pool, tenant, { id: testId("sub", 2000 + n), ...options.subscription });
  const jobId = testId("job", 2000 + n);
  await insertRow(pool, "provisioning_jobs", {
    id: jobId,
    tenant_id: tenant.id,
    kind: "provision",
    status: "queued",
    attempt: 0,
    scheduled_at: t.clock.now(),
    ...options.job,
  });
  return { tenant, owner, jobId };
}

async function tokenFor(account: { readonly id: string }): Promise<string> {
  const { token } = await t.app.get(TokenService).sign({
    aud: "portal",
    sub: account.id,
    sid: testId("asn", 2000 + next++),
    ev: true,
    amr: ["pwd"],
  });
  return token;
}

async function headersFor(account: { readonly id: string }): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await tokenFor(account)}`, ...t.bffHeaders(PERSON_IP) };
}

async function jobRow(jobId: string): Promise<PlatformRow<"provisioning_jobs">> {
  const { rows } = await pool.query("SELECT * FROM platform.provisioning_jobs WHERE id = $1", [jobId]);
  return rows[0] as PlatformRow<"provisioning_jobs">;
}

async function tenantRow(tenantId: string): Promise<PlatformRow<"tenants">> {
  const { rows } = await pool.query("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]);
  return rows[0] as PlatformRow<"tenants">;
}

/** Waits until the job is `status` at `attempt`, and returns its row. */
async function jobReaches(
  jobId: string,
  status: string,
  attempt: number,
): Promise<PlatformRow<"provisioning_jobs">> {
  await expect
    .poll(
      async () => {
        const job = await jobRow(jobId);
        return `${job.status}/${job.attempt}`;
      },
      { timeout: WAIT_MS, interval: 20 },
    )
    .toBe(`${status}/${attempt}`);
  return jobRow(jobId);
}

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

/** `step:status` of every entry of the job's log, in order. */
function stepsOf(job: PlatformRow<"provisioning_jobs">): string[] {
  return (job.steps as Array<{ step: string; status: string }>).map(
    ({ step, status }) => `${step}:${status}`,
  );
}

/** The lines with `msg` of both sinks (README §8: the worker's lines may land in the API's sink). */
function logLines(msg: string): Array<Record<string, unknown>> {
  return [...t.logs.withMessage(msg), ...workerLogs.withMessage(msg)];
}

/** The BullMQ job `id` of `queue` once it is finished (completed or failed). */
async function finished(queue: Queue, id: string): Promise<Job> {
  await expect
    .poll(
      async () => {
        const state = await queue.getJobState(id);
        return state === "completed" || state === "failed";
      },
      { timeout: WAIT_MS, interval: 20 },
    )
    .toBe(true);
  const found = await queue.getJob(id);
  if (found === undefined) {
    throw new Error(`no BullMQ job ${id}`);
  }
  return found;
}

// ---- Tests --------------------------------------------------------------------------------------------------------

describe("retryable failures of the OTA worker", () => {
  it("[PBE-023 AC2] after 5 retryable failures from the fake worker the tenant is failed; an owner retry creates a new job and the tenant becomes active [PF-11 AC2]", async () => {
    const { tenant, owner, jobId } = await arrange();
    fake.setOutcome(tenant.id, { type: "failed", retryable: true });

    expect((await dispatcher.dispatch(jobId)).dispatched).toBe(true);
    for (let attempt = 1; attempt < 5; attempt += 1) {
      // The answer puts the job back to `queued` with the backoff; the reconciler dispatches it once it is due.
      const queued = await jobReaches(jobId, "queued", attempt);
      expect(queued).toMatchObject({
        scheduled_at: new Date(t.clock.now().getTime() + retryDelayMs(attempt)),
        locked_until: null,
        error: LOCK_TIMEOUT_ERROR,
      });
      await reconciler.run();
      expect((await jobRow(jobId)).status).toBe("queued");
      t.clock.advance(retryDelayMs(attempt));
      await reconciler.run();
      expect(await jobRow(jobId)).toMatchObject({ status: "running", attempt: attempt + 1 });
    }

    const failed = await jobReaches(jobId, "failed", 5);
    expect(failed).toMatchObject({
      finished_at: t.clock.now(),
      locked_until: null,
      error: LOCK_TIMEOUT_ERROR,
    });
    expect(stepsOf(failed)).toEqual(
      Array.from({ length: 5 }, () => ["create_schema:succeeded", "run_migrations:failed"]).flat(),
    );
    expect((await tenantRow(tenant.id)).status).toBe("failed");
    expect(await auditOf(tenant.id, "tenant.provisioning_failed")).toEqual([
      expect.objectContaining({
        actor_type: "system",
        target_type: "tenant",
        details: expect.objectContaining({
          jobId,
          attempt: 5,
          code: "LOCK_TIMEOUT",
          before: { status: "provisioning" },
          after: { status: "failed" },
        }) as unknown,
      }),
    ]);
    const ownerMail = await waitForMessage({ to: owner.email, timeoutMs: WAIT_MS });
    expect(ownerMail.Subject).toBe(`We could not set up ${tenant.name}`);
    await waitForMessage({
      to: OPS_EMAIL,
      subject: `[Velexis ops] Provisioning job failed: provision of ${tenant.key}`,
      timeoutMs: WAIT_MS,
    });

    // The setup page shows the failure to the owner, who retries.
    const headers = await headersFor(owner);
    const progress = await t.http.get(`/v1/tenants/${tenant.id}/provisioning`).set(headers);
    expect(progress.status).toBe(200);
    expectResponseToMatch("getProvisioning", progress, { document: "platform" });
    expect(progress.body).toMatchObject({
      tenantStatus: "failed",
      job: { id: jobId, status: "failed", attempt: 5, maxAttempts: 5, error: LOCK_TIMEOUT_ERROR },
      initialKeysAvailable: false,
    });

    fake.setOutcome(tenant.id, { type: "provisioned" });
    const retry = await t.http.post(`/v1/tenants/${tenant.id}/provisioning/retry`).set(headers);

    expect(retry.status).toBe(202);
    expectResponseToMatch("retryProvisioning", retry, { document: "platform" });
    const { job } = retry.body as { job: { id: string } };
    expect(job.id).not.toBe(jobId);
    expect(retry.body).toEqual({
      job: {
        id: job.id,
        kind: "provision",
        status: "running",
        step: "dispatch",
        steps: [],
        attempt: 1,
        maxAttempts: 5,
        error: null,
      },
      checkoutUrl: null,
    });
    expect(await auditOf(tenant.id, "provisioning_job.retried")).toEqual([
      expect.objectContaining({
        actor_type: "account",
        actor_account_id: owner.id,
        target_type: "provisioning_job",
        target_id: job.id,
        details: expect.objectContaining({
          previousJobId: jobId,
          before: { tenantStatus: "failed" },
          after: { tenantStatus: "provisioning" },
        }) as unknown,
      }),
    ]);
    await expect
      .poll(
        async () => {
          const retried = await jobRow(job.id);
          return `${retried.status}/${retried.step ?? ""}`;
        },
        { timeout: WAIT_MS, interval: 20 },
      )
      .toBe("succeeded/notify");
    expect((await tenantRow(tenant.id)).status).toBe("active");
    const retried = await jobRow(job.id);
    expect(retried).toMatchObject({ attempt: 1, requested_by_account_id: owner.id, error: null });
    // Every step of the OTA worker and of the platform, once and none failed (the test pool decides whether the
    // Amadeus step assigned an office or was skipped).
    expect(stepsOf(retried).map((entry) => entry.split(":")[0])).toEqual([
      ...OTA_PROVISIONING_STEPS,
      ...POST_STEP_NAMES,
    ]);
    expect(stepsOf(retried).filter((entry) => entry.endsWith(":failed"))).toEqual([]);
    // The failed job stays as history.
    expect(await jobRow(jobId)).toMatchObject({ status: "failed", attempt: 5 });
    expect(fake.invalid).toEqual([]);
  });

  it("fails the job and the tenant at once on an answer that is not retryable", async () => {
    const { tenant, owner, jobId } = await arrange();
    fake.setOutcome(tenant.id, { type: "failed", retryable: false });

    await dispatcher.dispatch(jobId);

    const failed = await jobReaches(jobId, "failed", 1);
    expect(failed.error).toBe(
      "run_migrations failed: CHECKSUM_MISMATCH: a tenant migration was changed after it was applied",
    );
    expect(failed.step).toBe("run_migrations");
    expect((await tenantRow(tenant.id)).status).toBe("failed");
    expect(await emailsOf(tenant.id, "tenant.provisioning_failed")).toHaveLength(1);
    expect(await emailsOf(tenant.id, "ops.alert")).toHaveLength(1);
    await waitForMessage({ to: owner.email, timeoutMs: WAIT_MS });
  });

  it("ignores a late tenant.provision_failed of an attempt the reconciler counted as lost already", async () => {
    const leaseEnd = t.clock.now();
    const { tenant, jobId } = await arrange({
      job: { status: "running", attempt: 1, step: "dispatch", started_at: leaseEnd, locked_until: leaseEnd },
    });

    await reconciler.run();
    const requeued = await jobReaches(jobId, "queued", 1);
    expect(requeued.error).toMatch(new RegExp(`^${ATTEMPT_LOST_CODE}: Its message is missing`));

    const at = t.clock.now().toISOString();
    const late: TenantProvisionFailedEvent = validateJob("tenant.provision_failed", {
      v: 1,
      name: "tenant.provision_failed",
      jobId,
      tenantId: tenant.id,
      requestedAt: at,
      requestId: `failures-${randomUUID()}`,
      payload: {
        error: { code: "LOCK_TIMEOUT", message: "canceling statement due to lock timeout" },
        retryable: true,
        steps: [{ step: "create_schema", status: "succeeded", startedAt: at, finishedAt: at }],
      },
    });
    const id = bullmqJobId(jobId, 1);
    await tenantEvents.add(late.name, late, { jobId: id });
    const done = await finished(tenantEvents, id);

    expect(done.returnvalue).toEqual({ outcome: "ignored", reason: "not_running" });
    expect(await jobRow(jobId)).toEqual(requeued);
  });
});

describe("the reconciler", () => {
  it("[PBE-023 AC3] with a silent fake worker and the clock moved past the lease, the reconciler re-dispatches as attempt 2", async () => {
    const { tenant, jobId } = await arrange();
    fake.setOutcome(tenant.id, { type: "silent" });

    await dispatcher.dispatch(jobId);
    const first = bullmqJobId(jobId, 1);
    await fake.waitForHandled((handled) => handled.some((entry) => entry.bullmqJobId === first));
    expect(await (await finished(tenantOps, first)).getState()).toBe("failed");
    const dispatched = await jobRow(jobId);

    // Inside the lease nothing happens, however dead the attempt looks.
    t.clock.advance(DISPATCH_LEASE_MS - 1);
    await reconciler.run();
    expect(await jobRow(jobId)).toEqual(dispatched);

    // Past the lease: a lost attempt, re-queued with the backoff of attempt 1.
    t.clock.advance(1);
    await reconciler.run();
    expect(await jobRow(jobId)).toMatchObject({
      status: "queued",
      attempt: 1,
      locked_until: null,
      scheduled_at: new Date(t.clock.now().getTime() + retryDelayMs(1)),
      error: `${ATTEMPT_LOST_CODE}: Its message failed without an answer; the attempt ended with its lease.`,
    });
    expect(logLines("provisioning.attempt_lost").find((line) => line["jobId"] === jobId)).toMatchObject({
      message: "failed",
      answer: "unknown",
      outcome: "requeued",
    });

    // Once due, the next run dispatches attempt 2.
    t.clock.advance(retryDelayMs(1));
    await reconciler.run();
    expect(await jobRow(jobId)).toMatchObject({ status: "running", attempt: 2, step: "dispatch" });
    const second = bullmqJobId(jobId, 2);
    await fake.waitForHandled((handled) => handled.some((entry) => entry.bullmqJobId === second));
    expect((await tenantRow(tenant.id)).status).toBe("provisioning");
  });

  it("extends the lease while the attempt's message waits, and alerts ops once when the job stays running across two leases", async () => {
    const leaseEnd = t.clock.now();
    const { tenant, jobId } = await arrange({
      job: { status: "running", attempt: 1, step: "dispatch", started_at: leaseEnd, locked_until: leaseEnd },
    });
    // The attempt's message waits on ota-tenant-ops (delayed for an hour of real time: the fake does not take it).
    const id = bullmqJobId(jobId, 1);
    const message = tenantOpsMessage({
      name: "tenant.provision",
      jobId,
      tenantId: tenant.id,
      payload: {},
      requestedAt: leaseEnd,
      requestId: `failures-${randomUUID()}`,
    });
    await tenantOps.add(message.name, message, { jobId: id, delay: 60 * 60 * 1000 });
    try {
      await reconciler.run();
      expect(await jobRow(jobId)).toMatchObject({
        status: "running",
        attempt: 1,
        locked_until: new Date(t.clock.now().getTime() + DISPATCH_LEASE_MS),
        locked_by: LEASE_EXTENDED_BY,
      });
      expect(await emailsOf(tenant.id, "ops.alert")).toEqual([]);

      // The extended lease ends too: the job has been running across two leases.
      for (let lease = 0; lease < 2; lease += 1) {
        t.clock.advance(DISPATCH_LEASE_MS);
        await reconciler.run();
        expect(await jobRow(jobId)).toMatchObject({
          status: "running",
          attempt: 1,
          locked_until: new Date(t.clock.now().getTime() + DISPATCH_LEASE_MS),
        });
      }
      expect(await emailsOf(tenant.id, "ops.alert")).toHaveLength(1);
      await waitForMessage({
        to: OPS_EMAIL,
        subject: `[Velexis ops] Provisioning job still running after two leases: provision of ${tenant.key}`,
        timeoutMs: WAIT_MS,
      });
    } finally {
      await (await tenantOps.getJob(id))?.remove();
    }
  });

  it("[PBE-023 AC4] fails exhausted suspend and migrate jobs without changing the tenants' status, e-mailing ops only", async () => {
    const leaseEnd = new Date(t.clock.now().getTime() - 1);
    const running = {
      status: "running",
      attempt: 5,
      step: "dispatch",
      started_at: leaseEnd,
      locked_until: leaseEnd,
    };
    const suspend = await arrange({
      tenant: {
        status: "suspended",
        suspension_reason: "admin",
        suspended_at: leaseEnd,
        activated_at: leaseEnd,
      },
      job: { kind: "suspend", payload: { reason: "admin" }, ...running },
    });
    const migrate = await arrange({
      tenant: { status: "active", activated_at: leaseEnd },
      job: { kind: "migrate", ...running },
    });

    await reconciler.run();

    for (const [arranged, status] of [
      [suspend, "suspended"],
      [migrate, "active"],
    ] as const) {
      expect(await jobRow(arranged.jobId)).toMatchObject({ status: "failed", attempt: 5 });
      expect(await tenantRow(arranged.tenant.id)).toMatchObject({ status, version: arranged.tenant.version });
      expect(await auditOf(arranged.tenant.id, "tenant.provisioning_failed")).toEqual([]);
      expect(await emailsOf(arranged.tenant.id, "tenant.provisioning_failed")).toEqual([]);
      expect(await emailsOf(arranged.tenant.id, "ops.alert")).toHaveLength(1);
    }
  });

  it("dispatches a due queued job whose gate is open, and leaves one whose gate is closed or that is not due", async () => {
    const open = await arrange();
    const unpaid = await arrange({ subscription: { status: "incomplete", billing_provider: "stripe" } });
    const later = await arrange({ job: { scheduled_at: new Date(t.clock.now().getTime() + 60_000) } });
    for (const { tenant } of [open, unpaid, later]) {
      fake.setOutcome(tenant.id, { type: "silent" });
    }

    await reconciler.run();

    expect(await jobRow(open.jobId)).toMatchObject({ status: "running", attempt: 1 });
    expect(await jobRow(unpaid.jobId)).toMatchObject({ status: "queued", attempt: 0 });
    expect(await jobRow(later.jobId)).toMatchObject({ status: "queued", attempt: 0 });
  });
});

describe("post-steps that fail on the event's last try", () => {
  it("fail the job with the step's name, and with it the tenant", async () => {
    const { tenant, jobId } = await arrange();
    vi.spyOn(worker.get(CreatePaymentConnectionStep, { strict: false }), "run").mockRejectedValue(
      Object.assign(new Error("the worker's database connection broke"), { code: "CRASH_INJECTED" }),
    );

    // The fake adds its answer without `attempts`: one try, so the first failure is the last.
    await dispatcher.dispatch(jobId);

    const failed = await jobReaches(jobId, "failed", 1);
    expect(failed).toMatchObject({
      step: "create_payment_connection",
      error:
        "create_payment_connection failed: CRASH_INJECTED: The post-step failed on every try of the event; the job " +
        "failed. A retry runs the post-steps again.",
    });
    expect(stepsOf(failed)).toContain("create_payment_connection:failed");
    expect((await tenantRow(tenant.id)).status).toBe("failed");
    expect(await auditOf(tenant.id, "tenant.provisioning_failed")).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          step: "create_payment_connection",
          source: "post_steps",
        }) as unknown,
      }),
    ]);
  });
});

describe("retryProvisioning", () => {
  it("answers 409 PROVISIONING_NOT_RETRYABLE for a tenant that is not failed, 403 to an admin and 404 to a non-member", async () => {
    const { tenant, owner, jobId } = await arrange();
    const admin = await insertAccount(pool, { id: testId("acc", 2900 + next++) });
    await insertMember(pool, tenant, admin, "admin");
    const stranger = await insertAccount(pool, { id: testId("acc", 2900 + next++) });
    const path = `/v1/tenants/${tenant.id}/provisioning/retry`;

    const provisioning = await t.http.post(path).set(await headersFor(owner));
    expect(provisioning.status).toBe(409);
    expect(provisioning.body).toMatchObject({ error: { code: "PROVISIONING_NOT_RETRYABLE" } });
    expectResponseToMatch("retryProvisioning", provisioning, { document: "platform" });

    const byAdmin = await t.http.post(path).set(await headersFor(admin));
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body).toMatchObject({ error: { code: "FORBIDDEN" } });

    const byStranger = await t.http.post(path).set(await headersFor(stranger));
    expect(byStranger.status).toBe(404);

    // Nothing changed: the tenant is still provisioning with its one job.
    expect((await tenantRow(tenant.id)).status).toBe("provisioning");
    const { rows } = await pool.query("SELECT id FROM platform.provisioning_jobs WHERE tenant_id = $1", [
      tenant.id,
    ]);
    expect(rows).toEqual([{ id: jobId }]);
  });
});
