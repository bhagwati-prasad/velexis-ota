// Tenant migrations seen from the platform (PBE-030; platform/docs/flows/provisioning.md §5, architecture.md §6.1,
// PADR-0001 item 7, OADR-0007 items 5 and 7) on this file's database clone and Redis database: the platform admin's
// adminMigrateTenant through the HTTP pipeline (createTestApp), the fake OTA worker (test/support/fake-ota-worker.ts)
// answering `tenant.migrate` with `tenant.migrated` or `tenant.migration_failed`, and the worker's module graph
// (WorkerModule, with the API's FakeClock) consuming `platform-tenant-events`, including the deploy fan-out's reports
// (`jobId: null`), which the tests add to the queue themselves as `tenants:report-migrations` does.
//
// Every test arranges its own OTA with the builders; the jobs a test leaves active are canceled after it.
// OPS_ALERT_EMAIL is this file's own (`uniqueEmail`).
import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  PLATFORM_TENANT_EVENTS,
  validateJob,
  type TenantMigratedEvent,
  type TenantMigrationFailedEvent,
} from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Job, Queue } from "bullmq";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { retryDelayMs } from "../../../src/provisioning/failure-handler";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertRow,
  insertSubscription,
  insertTenant,
  testId,
  type PlatformRow,
  type TenantRow,
} from "../../builders/platform-rows";
import { insertMember } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FAKE_TENANT_LEDGER, FakeOtaWorker, schemaNamesFrom } from "../../support/fake-ota-worker";

/**
 * Starting the API, the worker's module graph and the fake OTA worker takes seconds, and the platform document and the
 * job validators compile on first use; the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker, the fake OTA worker, BullMQ or an e-mail. */
const WAIT_MS = 20_000;
/** Documentation address (RFC 5737). */
const ADMIN_IP = "198.51.100.32";
const OPS_EMAIL = uniqueEmail("ops-migrate");
/** The admin family of this file's tokens. */
const FAMILY = testId("asn", 3301);
const BASELINE = "0001_baseline";
const SECOND = "0002_add_mvp_tenant_deltas";

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let fake: FakeOtaWorker;
let tenantEvents: Queue;
const workerLogs = new LogSink();
let admin: PlatformRow<"accounts">;
/** Ids of this file's rows: tenants, jobs and audit rows stay between tests, so each test writes rows of its own. */
let next = 1;

beforeAll(async () => {
  // Expensive set-up, once per file: the database clone, the API's and the worker's Nest module graphs, the fake OTA
  // worker, the platform document that expectResponseToMatch parses on its first use, and the Ajv validators of the
  // job messages (validateJob compiles them on its first call).
  t = await createTestApp({ env: { OPS_ALERT_EMAIL: OPS_EMAIL } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tenantEvents = t.app.get<Queue>(getQueueToken(PLATFORM_TENANT_EVENTS), { strict: false });
  responseChecker("platform");
  migratedReport(testId("ten", 1), [BASELINE]);

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .compile();
  await worker.init();

  fake = await FakeOtaWorker.start({
    redisUrl: t.redis.url,
    schemaNameOf: schemaNamesFrom(pool),
    now: () => t.clock.now(),
  });

  admin = await insertAccount(pool, {
    id: testId("acc", 3300),
    email: uniqueEmail("admin-migrate"),
    is_platform_admin: true,
    mfa_enabled: true,
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fake?.close();
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  // A job a test left active must not be dispatched by a later test.
  await pool.query(
    "UPDATE platform.provisioning_jobs SET status = 'canceled', locked_until = NULL WHERE status IN ('queued', 'running')",
  );
});

// ---- Calls and messages -------------------------------------------------------------------------------------------

async function migrate(tenantId: string, body?: object): Promise<Response> {
  const { token } = await t.app.get(TokenService).sign({
    aud: "platform_admin",
    sub: admin.id,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
  });
  const request = t.http
    .post(`/v1/admin/tenants/${tenantId}/migrate`)
    .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) });
  return body === undefined ? request : request.send(body);
}

function errorOf(res: Response): { code: string; details?: Record<string, unknown> } {
  return (res.body as { error: { code: string; details?: Record<string, unknown> } }).error;
}

/** A deploy fan-out id, as `tenants:report-migrations` sends it: unique per run. */
function deployRequestId(): string {
  return `deploy-${randomUUID().slice(0, 12)}`;
}

/** The fan-out's `tenant.migrated` report of `tenantId` with the fake ledger up to the last of `versions`. */
function migratedReport(
  tenantId: string,
  versions: readonly string[],
  requestId: string = deployRequestId(),
): TenantMigratedEvent {
  const at = t.clock.now().toISOString();
  return validateJob("tenant.migrated", {
    v: 1,
    name: "tenant.migrated",
    jobId: null,
    tenantId,
    requestedAt: at,
    requestId,
    payload: {
      schemaVersion: versions[versions.length - 1],
      migrations: FAKE_TENANT_LEDGER.filter((entry) => versions.includes(entry.version)).map((entry) => ({
        ...entry,
        appliedAt: at,
      })),
    },
  });
}

/** Adds `event` to `platform-tenant-events` as the deploy fan-out does (an id of BullMQ's own) and waits for it. */
async function deliver(event: TenantMigratedEvent | TenantMigrationFailedEvent): Promise<Job> {
  const added = await tenantEvents.add(event.name, event);
  const id = added.id;
  if (id === undefined) {
    throw new Error("BullMQ gave the report no id");
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

// ---- Arrangement --------------------------------------------------------------------------------------------------

/** An active OTA of this test with its owner, a manual trial and `schemaVersion` mirrored (unless `null`). */
async function arrange(
  schemaVersion: string | null = BASELINE,
  tenantRow: Partial<TenantRow> = {},
): Promise<PlatformRow<"tenants">> {
  const n = next++;
  const owner = await insertAccount(pool, {
    id: testId("acc", 3400 + n),
    email: uniqueEmail(`migrate-owner${n}`),
  });
  const tenant = await insertTenant(pool, {
    id: testId("ten", 3400 + n),
    key: `migrate${n}`,
    name: `Migrate ${n} Travel`,
    schema_version: schemaVersion,
    ...tenantRow,
  });
  await insertMember(pool, tenant, owner, "owner");
  await insertSubscription(pool, tenant, { id: testId("sub", 3400 + n) });
  if (schemaVersion !== null) {
    const ledger = FAKE_TENANT_LEDGER.find((entry) => entry.version === schemaVersion);
    await insertRow(pool, "tenant_schema_migrations", {
      tenant_id: tenant.id,
      version: schemaVersion,
      schema_name: `tenant_${tenant.key}`,
      checksum: ledger?.checksum ?? "0".repeat(64),
      status: "applied",
      runner_id: testId("job", 3400 + n),
    });
  }
  return tenant;
}

async function tenantOf(tenantId: string): Promise<PlatformRow<"tenants">> {
  const { rows } = await pool.query("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]);
  return rows[0] as PlatformRow<"tenants">;
}

async function jobRow(jobId: string): Promise<PlatformRow<"provisioning_jobs">> {
  const { rows } = await pool.query("SELECT * FROM platform.provisioning_jobs WHERE id = $1", [jobId]);
  return rows[0] as PlatformRow<"provisioning_jobs">;
}

/** The mirror of the tenant's ledger, `version:status:runner` in version order. */
async function mirrorOf(tenantId: string): Promise<string[]> {
  const { rows } = await pool.query(
    "SELECT version, status, runner_id FROM platform.tenant_schema_migrations WHERE tenant_id = $1 ORDER BY version",
    [tenantId],
  );
  return (rows as Array<{ version: string; status: string; runner_id: string }>).map(
    (row) => `${row.version}:${row.status}:${row.runner_id}`,
  );
}

async function auditOf(tenantId: string, action: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id",
    [tenantId, action],
  );
  return rows as Array<Record<string, unknown>>;
}

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

// ---- Tests --------------------------------------------------------------------------------------------------------

describe("the deploy fan-out's reports", () => {
  it("[PBE-030 AC3] a fan-out tenant.migrated with jobId null updates the mirror and schema_version", async () => {
    const tenant = await arrange(BASELINE);
    const requestId = deployRequestId();
    // The baseline as the setup's job mirrored it.
    const [baseline] = await mirrorOf(tenant.id);
    expect(baseline?.startsWith(`${BASELINE}:applied:job_`)).toBe(true);

    const done = await deliver(migratedReport(tenant.id, [BASELINE, SECOND], requestId));

    expect(await done.getState()).toBe("completed");
    expect(done.returnvalue).toEqual({
      outcome: "mirrored",
      schemaVersion: SECOND,
      versionChanged: true,
      jobSucceeded: false,
    });
    expect((await tenantOf(tenant.id)).schema_version).toBe(SECOND);
    // The whole ledger is mirrored: the new version with the deploy run as its runner, the baseline still with the job
    // that applied it.
    expect(await mirrorOf(tenant.id)).toEqual([baseline, `${SECOND}:applied:${requestId}`]);
    expect(await auditOf(tenant.id, "tenant.migrated")).toEqual([
      expect.objectContaining({
        actor_type: "system",
        actor_label: "deploy",
        request_id: requestId,
        details: expect.objectContaining({
          jobId: null,
          before: { schemaVersion: BASELINE },
          after: { schemaVersion: SECOND },
        }) as unknown,
      }),
    ]);
  });

  it("never moves schema_version back for a late report of an older ledger, and ignores an unknown tenant", async () => {
    const tenant = await arrange(SECOND);

    const late = await deliver(migratedReport(tenant.id, [BASELINE]));
    expect(late.returnvalue).toMatchObject({
      outcome: "mirrored",
      schemaVersion: SECOND,
      versionChanged: false,
    });
    expect((await tenantOf(tenant.id)).schema_version).toBe(SECOND);
    expect(await auditOf(tenant.id, "tenant.migrated")).toEqual([]);

    const unknown = await deliver(migratedReport(testId("ten", 3499), [BASELINE]));
    expect(unknown.returnvalue).toEqual({ outcome: "ignored", reason: "unknown_tenant" });
  });

  it("alerts ops once for a fan-out tenant.migration_failed, leaving the status and the schema version", async () => {
    const tenant = await arrange(BASELINE);
    const requestId = deployRequestId();
    const report: TenantMigrationFailedEvent = validateJob("tenant.migration_failed", {
      v: 1,
      name: "tenant.migration_failed",
      jobId: null,
      tenantId: tenant.id,
      requestedAt: t.clock.now().toISOString(),
      requestId,
      payload: {
        version: SECOND,
        error: { code: "CHECKSUM_MISMATCH", message: "a tenant migration was changed after it was applied" },
      },
    });

    const first = await deliver(report);
    const second = await deliver(report);

    expect(first.returnvalue).toEqual({ outcome: "alerted", queued: true });
    expect(second.returnvalue).toEqual({ outcome: "alerted", queued: false });
    expect(await emailsOf(tenant.id, "ops.alert")).toHaveLength(1);
    expect(await auditOf(tenant.id, "tenant.migration_failed")).toEqual([
      expect.objectContaining({
        actor_type: "system",
        actor_label: "deploy",
        details: expect.objectContaining({ version: SECOND, code: "CHECKSUM_MISMATCH" }) as unknown,
      }),
    ]);
    expect(await tenantOf(tenant.id)).toMatchObject({
      status: "active",
      schema_version: BASELINE,
      version: tenant.version,
    });
    await waitForMessage({
      to: OPS_EMAIL,
      subject: `[Velexis ops] Tenant migration failed: ${tenant.key}`,
      timeoutMs: WAIT_MS,
    });
  });
});

describe("adminMigrateTenant", () => {
  it("queues a migrate job, dispatches tenant.migrate and, on the answer, mirrors the ledger and finishes the job", async () => {
    const tenant = await arrange(BASELINE);
    const [baseline] = await mirrorOf(tenant.id);

    const res = await migrate(tenant.id, { targetVersion: SECOND });

    expect(res.status).toBe(202);
    expectResponseToMatch("adminMigrateTenant", res, { document: "platform" });
    const { job } = res.body as { job: { id: string; kind: string; status: string; attempt: number } };
    expect(job).toMatchObject({ kind: "migrate", attempt: 1, tenantId: tenant.id, tenantKey: tenant.key });
    expect(await auditOf(tenant.id, "tenant.migration_requested")).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        details: expect.objectContaining({
          jobId: job.id,
          schemaVersion: BASELINE,
          targetVersion: SECOND,
        }) as unknown,
      }),
    ]);
    const all = await fake.waitForHandled(
      (handled) => handled.some((entry) => entry.message.jobId === job.id),
      WAIT_MS,
    );
    expect(all.find((entry) => entry.message.jobId === job.id)?.message).toMatchObject({
      name: "tenant.migrate",
      tenantId: tenant.id,
      payload: { targetVersion: SECOND },
    });

    const succeeded = await jobReaches(job.id, "succeeded");
    expect(succeeded).toMatchObject({ step: "record_migrations", error: null, locked_until: null });
    expect(succeeded.result).toEqual({ schemaVersion: SECOND });
    expect(succeeded.payload).toEqual({ targetVersion: SECOND });
    expect((succeeded.steps as Array<{ step: string; status: string }>).map((entry) => entry.step)).toEqual([
      "record_migrations",
    ]);
    expect(await tenantOf(tenant.id)).toMatchObject({ status: "active", schema_version: SECOND });
    // The version the job applied names it as its runner; the baseline keeps the setup's job.
    expect(await mirrorOf(tenant.id)).toEqual([baseline, `${SECOND}:applied:${job.id}`]);
    expect(await auditOf(tenant.id, "tenant.migrated")).toEqual([
      expect.objectContaining({ actor_type: "system", actor_label: "provisioning" }),
    ]);
    expect(fake.invalid).toEqual([]);
  });

  it("answers 409 while a migrate job is active and for an OTA without a schema, and 404 for an unknown OTA", async () => {
    const waiting = await arrange(BASELINE);
    fake.setOutcome(waiting.id, { type: "silent" });
    const withoutSchema = await arrange(null, { status: "provisioning", activated_at: null });

    const first = await migrate(waiting.id);
    expect(first.status).toBe(202);
    const { job } = first.body as { job: { id: string } };
    expect((await jobRow(job.id)).payload).toEqual({});

    const active = await migrate(waiting.id, {});
    expect(active.status).toBe(409);
    expectResponseToMatch("adminMigrateTenant", active, { document: "platform" });
    expect(errorOf(active)).toMatchObject({ code: "CONFLICT", details: { reason: "migrate_job_active" } });

    const missing = await migrate(withoutSchema.id);
    expect(missing.status).toBe(409);
    expect(errorOf(missing)).toMatchObject({ code: "CONFLICT", details: { reason: "schema_missing" } });

    const unknown = await migrate(testId("ten", 3498));
    expect(unknown.status).toBe(404);
    expectResponseToMatch("adminMigrateTenant", unknown, { document: "platform" });

    expect(await auditOf(waiting.id, "tenant.migration_requested")).toHaveLength(1);
    expect(await auditOf(withoutSchema.id, "tenant.migration_requested")).toEqual([]);
  });

  it("fails the job on a tenant.migration_failed that is not retryable, alerting ops and leaving the tenant as it is", async () => {
    const tenant = await arrange(BASELINE);
    fake.setOutcome(tenant.id, { type: "failed", retryable: false });

    const res = await migrate(tenant.id);
    const { job } = res.body as { job: { id: string } };

    const failed = await jobReaches(job.id, "failed");
    expect(failed).toMatchObject({
      attempt: 1,
      step: "run_migrations",
      error: "run_migrations failed: CHECKSUM_MISMATCH: a tenant migration was changed after it was applied",
    });
    expect(await tenantOf(tenant.id)).toMatchObject({
      status: "active",
      schema_version: BASELINE,
      version: tenant.version,
    });
    expect(await emailsOf(tenant.id, "ops.alert")).toHaveLength(1);
    expect(await auditOf(tenant.id, "tenant.provisioning_failed")).toEqual([]);
    await waitForMessage({
      to: OPS_EMAIL,
      subject: `[Velexis ops] Provisioning job failed: migrate of ${tenant.key}`,
      timeoutMs: WAIT_MS,
    });
  });

  it("re-queues the job with the backoff on a retryable tenant.migration_failed", async () => {
    const tenant = await arrange(BASELINE);
    fake.setOutcome(tenant.id, { type: "failed", retryable: true });

    const res = await migrate(tenant.id);
    const { job } = res.body as { job: { id: string } };

    const queued = await jobReaches(job.id, "queued");
    expect(queued).toMatchObject({
      attempt: 1,
      locked_until: null,
      scheduled_at: new Date(t.clock.now().getTime() + retryDelayMs(1)),
      error: "run_migrations failed: LOCK_TIMEOUT: canceling statement due to lock timeout",
    });
    expect(await emailsOf(tenant.id, "ops.alert")).toEqual([]);
  });
});
