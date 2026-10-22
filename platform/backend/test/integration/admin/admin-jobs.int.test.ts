// The platform admin's tenant jobs and queues (PBE-031; scope PF-83 and PF-84, platform/docs/api-inventory-admin.md §3,
// flows/platform-admin-operations.md §C, PADR-0001 items 3, 7 and 8, ADR-0009 item 11) through the HTTP pipeline
// (createTestApp) on this file's database clone and Redis database. The worker's module graph (WorkerModule, with the
// API's FakeClock) consumes `platform-tenant-events` and runs the post-steps, and the fake OTA worker
// (test/support/fake-ota-worker.ts) answers `ota-tenant-ops`, so a retried setup runs end to end. Every answer is
// checked against the platform document.
//
// Rows come from the builders, with ids and tenant keys of this file only; jobs left active by a test are canceled
// after it, so no later dispatch takes them up. The queue tests use queues no process of this file consumes
// (`platform-domains` and `ota-bookings` for the counts, `platform-settlements` for the failed list,
// `platform-stripe-events` for the retry: the worker's own processor of that queue, PBE-043, is left out of the
// worker's module graph here), and fail or hold their jobs with BullMQ workers of their own (closed in their hooks), so
// the counts are exactly the jobs a group added. Waiting jobs carry a creation time relative to the
// FakeClock, so the age of the oldest is exact. Expensive work (a retried setup run end to end, jobs failed by a
// worker) runs in the set-up hooks of each group, with explicit bounds; the tests then check what happened.
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  BULLMQ_PREFIX,
  bullmqJobId,
  INVALIDATION_CHANNEL,
  OTA_QUEUES,
  OTA_TENANT_OPS,
  PLATFORM_QUEUES,
  validateJob,
  type InvalidationEvent,
} from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail } from "@velexis/testing/mailpit";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { StripeEventsProcessor } from "../../../src/billing/sync/stripe-events.processor";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { DISPATCH_LEASE_MS, ProvisioningDispatcher } from "../../../src/provisioning/dispatcher";
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

/**
 * Starting the API, the worker's module graph and the fake OTA worker takes seconds, and the platform document and
 * the job validators compile on first use; the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's set-up: a retried setup run end to end, or BullMQ workers failing and holding jobs; seconds at most. */
const GROUP_SETUP_TIMEOUT_MS = 60_000;
/** How long a hook or a test waits for the worker, the fake OTA worker or BullMQ. */
const WAIT_MS = 20_000;
/** How long a test waits for an invalidation published after a commit: under the 5-second bound of a test. */
const EVENT_WAIT_MS = 3000;
/** Documentation addresses (RFC 5737). */
const ADMIN_IP = "198.51.100.31";
const PORTAL_IP = "203.0.113.31";
const OPS_EMAIL = uniqueEmail("ops-admin-jobs");
const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;
/** The admin family of this file's tokens. */
const FAMILY = testId("asn", 3101);

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let fake: FakeOtaWorker;
let dispatcher: ProvisioningDispatcher;
let tenantOps: Queue;
/** This file's own BullMQ connection, for its queues and workers. */
let connection: Redis;
let subscriber: Redis;
const events: InvalidationEvent[] = [];
const workerLogs = new LogSink();
let admin: PlatformRow<"accounts">;
let portalUser: PlatformRow<"accounts">;
/** Ids of this file's rows: tenants, jobs and audit rows stay between tests, so each test writes rows of its own. */
let next = 1;

beforeAll(async () => {
  // Expensive set-up, once per file: the database clone, the API's and the worker's Nest module graphs, the fake OTA
  // worker, this file's Redis connections, and the platform document that expectResponseToMatch parses on first use.
  t = await createTestApp({ env: { OPS_ALERT_EMAIL: OPS_EMAIL } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  dispatcher = t.app.get(ProvisioningDispatcher, { strict: false });
  tenantOps = t.app.get<Queue>(getQueueToken(OTA_TENANT_OPS), { strict: false });
  responseChecker("platform");

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    // Not a processor any more (a plain value), so platform-stripe-events has no consumer in this file (see above).
    .overrideProvider(StripeEventsProcessor)
    .useValue({})
    .compile();
  await worker.init();

  fake = await FakeOtaWorker.start({
    redisUrl: t.redis.url,
    schemaNameOf: schemaNamesFrom(pool),
    now: () => t.clock.now(),
  });

  connection = new Redis(t.redis.url, { maxRetriesPerRequest: null });
  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    events.push(JSON.parse(message) as InvalidationEvent);
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);

  admin = await insertAccount(pool, {
    id: testId("acc", 3100),
    email: uniqueEmail("admin-jobs"),
    is_platform_admin: true,
    mfa_enabled: true,
  });
  portalUser = await insertAccount(pool, { id: testId("acc", 3099), email: uniqueEmail("portal-jobs") });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  connection?.disconnect();
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

// ---- Calls --------------------------------------------------------------------------------------------------------

async function adminHeaders(): Promise<Record<string, string>> {
  const { token } = await t.app.get(TokenService).sign({
    aud: "platform_admin",
    sub: admin.id,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

async function portalHeaders(): Promise<Record<string, string>> {
  const { token } = await t.app.get(TokenService).sign({
    aud: "portal",
    sub: portalUser.id,
    sid: testId("asn", 3102),
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PORTAL_IP) };
}

async function get(path: string): Promise<Response> {
  return t.http.get(path).set(await adminHeaders());
}

async function post(path: string, body?: object): Promise<Response> {
  const request = t.http.post(path).set(await adminHeaders());
  return body === undefined ? request : request.send(body);
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
async function arrangeTenant(
  options: { readonly tenant?: Partial<TenantRow>; readonly subscription?: Partial<SubscriptionRow> } = {},
): Promise<Arranged> {
  const n = next++;
  const owner = await insertAccount(pool, {
    id: testId("acc", 3200 + n),
    email: uniqueEmail(`jobs-owner${n}`),
    full_name: `Owner ${n}`,
  });
  const tenant = await insertTenant(pool, {
    id: testId("ten", 3200 + n),
    key: `adminjobs${n}`,
    name: `Admin Jobs ${n} Travel`,
    ...options.tenant,
  });
  await insertMember(pool, tenant, owner, "owner");
  await insertSubscription(pool, tenant, { id: testId("sub", 3200 + n), ...options.subscription });
  return { tenant, owner };
}

/** A job of `tenant`: a `provision` job, `queued` with no attempt and due now, unless `job` says otherwise. */
async function insertJob(
  tenant: { readonly id: string },
  job: Partial<PlatformInsert<"provisioning_jobs">> = {},
): Promise<PlatformRow<"provisioning_jobs">> {
  return insertRow(pool, "provisioning_jobs", {
    id: testId("job", 3200 + next++),
    tenant_id: tenant.id,
    kind: "provision",
    status: "queued",
    attempt: 0,
    scheduled_at: t.clock.now(),
    ...job,
  });
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

async function tenantRow(tenantId: string): Promise<PlatformRow<"tenants">> {
  const { rows } = await pool.query("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]);
  return rows[0] as PlatformRow<"tenants">;
}

/** The audit rows of `action` about `targetId`, oldest first. */
async function auditOf(action: string, targetId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
    [action, targetId],
  );
  return rows as Array<Record<string, unknown>>;
}

/** The time `ms` milliseconds before the FakeClock's now. */
function before(ms: number): Date {
  return new Date(t.clock.now().getTime() - ms);
}

/** A BullMQ queue of this file's connection (prefix `vx`), for queues the platform API does not open itself. */
function testQueue(name: string): Queue {
  const queue = new Queue(name, { connection, prefix: BULLMQ_PREFIX });
  queue.on("error", () => undefined);
  return queue;
}

/**
 * Resolves once `probe()` answers `expected`, asking every 20 ms; rejects with the last answer after WAIT_MS. For the
 * set-up hooks, where `expect.poll` is not available.
 */
async function until<T>(probe: () => Promise<T>, expected: T, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  let last: T | undefined;
  for (;;) {
    last = await probe();
    if (last === expected) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what}: still ${String(last)} after ${WAIT_MS} ms, expected ${String(expected)}`);
    }
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 20));
  }
}

/** Waits until `queue` holds `count` jobs in `state`. */
async function countReaches(queue: Queue, state: "failed" | "active", count: number): Promise<void> {
  await until(async () => (await queue.getJobCounts(state))[state], count, `${state} jobs of ${queue.name}`);
}

/**
 * Adds `jobs` to `queue` one after the other and fails each with a BullMQ worker of this file whose processor throws
 * `reason(job)`; one attempt each, so each failure is final, and the later job fails after the earlier one.
 */
async function failJobs(
  queue: Queue,
  jobs: ReadonlyArray<{ readonly name: string; readonly data: Record<string, unknown> }>,
  reason: (job: Job) => string,
): Promise<Job[]> {
  const failing = new Worker(
    queue.name,
    (job: Job) => {
      throw new Error(reason(job));
    },
    { connection, prefix: BULLMQ_PREFIX, concurrency: 1 },
  );
  failing.on("error", () => undefined);
  try {
    const added: Job[] = [];
    const failedBefore = (await queue.getJobCounts("failed"))["failed"] ?? 0;
    for (const job of jobs) {
      added.push(await queue.add(job.name, job.data, { attempts: 1 }));
      await countReaches(queue, "failed", failedBefore + added.length);
    }
    return added;
  } finally {
    await failing.close();
  }
}

// ---- Tests --------------------------------------------------------------------------------------------------------

describe("adminListProvisioningJobs", () => {
  let first: Arranged;
  let second: Arranged;
  /**
   * The jobs of `first` and the one of `second`, in states the cleanup after each test leaves alone (it cancels
   * `queued` and `running` jobs), so the tests of this group do not depend on their order.
   */
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    first = await arrangeTenant();
    second = await arrangeTenant();
    const rows = [
      [
        "provisionDone",
        first,
        { kind: "provision", status: "succeeded", attempt: 1, created_at: before(50 * HOUR_MS) },
      ],
      [
        "migrateFailed",
        first,
        { kind: "migrate", status: "failed", attempt: 5, created_at: before(40 * HOUR_MS) },
      ],
      [
        "suspendDone",
        first,
        {
          kind: "suspend",
          status: "succeeded",
          attempt: 1,
          payload: { reason: "admin" },
          created_at: before(30 * HOUR_MS),
        },
      ],
      ["resumeCanceled", first, { kind: "resume", status: "canceled", created_at: before(20 * HOUR_MS) }],
      ["migrateCanceled", first, { kind: "migrate", status: "canceled", created_at: before(10 * HOUR_MS) }],
      [
        "exportDone",
        first,
        { kind: "export", status: "succeeded", attempt: 1, created_at: before(5 * HOUR_MS) },
      ],
      [
        "otherFailed",
        second,
        { kind: "migrate", status: "failed", attempt: 5, created_at: before(45 * HOUR_MS) },
      ],
    ] as const;
    for (const [name, arranged, job] of rows) {
      ids[name] = (await insertJob(arranged.tenant, job)).id;
    }
  }, GROUP_SETUP_TIMEOUT_MS);

  /** The ids of the jobs of this group in `res`, in the answer's order. */
  function oursIn(res: Response): string[] {
    const ours = new Set(Object.values(ids));
    return (res.body as { data: Array<{ id: string }> }).data
      .map((job) => job.id)
      .filter((id) => ours.has(id));
  }

  it("[PBE-031 AC1] filters by status, kind and tenant return the right jobs, newest first, never a post-MVP kind [PF-83]", async () => {
    const byTenant = await get(`/v1/admin/provisioning-jobs?tenantId=${first.tenant.id}`);
    expect(byTenant.status).toBe(200);
    expectResponseToMatch("adminListProvisioningJobs", byTenant, { document: "platform" });
    expect((byTenant.body as { data: Array<{ id: string }> }).data.map((job) => job.id)).toEqual([
      ids["migrateCanceled"],
      ids["resumeCanceled"],
      ids["suspendDone"],
      ids["migrateFailed"],
      ids["provisionDone"],
    ]);
    expect((byTenant.body as { data: unknown[] }).data[2]).toEqual({
      id: ids["suspendDone"],
      tenantId: first.tenant.id,
      tenantKey: first.tenant.key,
      kind: "suspend",
      status: "succeeded",
      step: null,
      attempt: 1,
      maxAttempts: 5,
      error: null,
      scheduledAt: t.clock.now().toISOString(),
      startedAt: null,
      finishedAt: null,
    });
    expect(byTenant.body).toMatchObject({ page: { nextCursor: null, limit: 50 } });

    const failed = await get("/v1/admin/provisioning-jobs?status=failed");
    expect(failed.status).toBe(200);
    expectResponseToMatch("adminListProvisioningJobs", failed, { document: "platform" });
    expect(
      (failed.body as { data: Array<{ status: string }> }).data.every((job) => job.status === "failed"),
    ).toBe(true);
    expect(oursIn(failed)).toEqual([ids["migrateFailed"], ids["otherFailed"]]);

    const migrate = await get("/v1/admin/provisioning-jobs?kind=migrate");
    expect(
      (migrate.body as { data: Array<{ kind: string }> }).data.every((job) => job.kind === "migrate"),
    ).toBe(true);
    expect(oursIn(migrate)).toEqual([ids["migrateCanceled"], ids["migrateFailed"], ids["otherFailed"]]);

    const combined = await get(
      `/v1/admin/provisioning-jobs?status=canceled&kind=migrate&tenantId=${first.tenant.id}`,
    );
    expect((combined.body as { data: Array<{ id: string }> }).data.map((job) => job.id)).toEqual([
      ids["migrateCanceled"],
    ]);

    const everything = await get("/v1/admin/provisioning-jobs?limit=200");
    expect(oursIn(everything)).not.toContain(ids["exportDone"]);
  });

  it("[PBE-031 AC1] pages through the jobs with the cursor, each job exactly once, and refuses a cursor of another list", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const page = await get(`/v1/admin/provisioning-jobs?tenantId=${first.tenant.id}&limit=2${query}`);
      expect(page.status).toBe(200);
      expectResponseToMatch("adminListProvisioningJobs", page, { document: "platform" });
      const body = page.body as {
        data: Array<{ id: string }>;
        page: { nextCursor: string | null; limit: number };
      };
      expect(body.page.limit).toBe(2);
      seen.push(...body.data.map((job) => job.id));
      cursor = body.page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([
      ids["migrateCanceled"],
      ids["resumeCanceled"],
      ids["suspendDone"],
      ids["migrateFailed"],
      ids["provisionDone"],
    ]);

    const foreign = Buffer.from(JSON.stringify({ id: first.tenant.id })).toString("base64url");
    const refused = await get(`/v1/admin/provisioning-jobs?cursor=${foreign}`);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: [{ path: "/query/cursor", code: "cursor" }] },
    });
    expectResponseToMatch("adminListProvisioningJobs", refused, { document: "platform" });
  });

  it("refuses a portal token and a call without a token with 401", async () => {
    const portal = await t.http.get("/v1/admin/provisioning-jobs").set(await portalHeaders());
    expect(portal.status).toBe(401);
    const anonymous = await t.http.get("/v1/admin/provisioning-jobs").set(t.bffHeaders(ADMIN_IP));
    expect(anonymous.status).toBe(401);
    expectResponseToMatch("adminListProvisioningJobs", anonymous, { document: "platform" });
  });
});

describe("adminGetProvisioningJob", () => {
  it("[PBE-031 AC1] answers the step log, payload, result and lease, and never the reveal ciphertext [PF-83]", async () => {
    const { tenant } = await arrangeTenant();
    const ciphertext = Buffer.from("not an envelope: the bytes of a reveal ciphertext of this test");
    const steps = [
      {
        step: "create_schema",
        status: "succeeded",
        startedAt: "2026-01-15T09:00:01.000Z",
        finishedAt: "2026-01-15T09:00:02.000Z",
      },
      {
        step: "issue_api_keys",
        status: "succeeded",
        startedAt: "2026-01-15T09:00:03.000Z",
        finishedAt: "2026-01-15T09:00:04.000Z",
      },
    ];
    const result = {
      schemaVersion: "0002_add_mvp_tenant_deltas",
      apiKeyIds: [testId("key", 3301), testId("key", 3302)],
      officeId: null,
    };
    const job = await insertJob(tenant, {
      status: "succeeded",
      step: "notify",
      attempt: 1,
      steps,
      result,
      started_at: before(10 * SECOND_MS),
      finished_at: before(5 * SECOND_MS),
      reveal_ciphertext: ciphertext,
      reveal_encryption_key_id: "local:v1",
    });

    const res = await get(`/v1/admin/provisioning-jobs/${job.id}`);

    expect(res.status).toBe(200);
    expectResponseToMatch("adminGetProvisioningJob", res, { document: "platform" });
    expect(res.body).toEqual({
      id: job.id,
      tenantId: tenant.id,
      tenantKey: tenant.key,
      kind: "provision",
      status: "succeeded",
      step: "notify",
      attempt: 1,
      maxAttempts: 5,
      error: null,
      scheduledAt: t.clock.now().toISOString(),
      startedAt: before(10 * SECOND_MS).toISOString(),
      finishedAt: before(5 * SECOND_MS).toISOString(),
      steps,
      payload: {},
      result,
      lockedUntil: null,
      // Attempt 1 was never added to ota-tenant-ops in this test.
      bullmqState: "unknown",
    });
    const text = res.text.toLowerCase();
    expect(text).not.toContain("ciphertext");
    expect(text).not.toContain("reveal");
    expect(res.text).not.toContain(ciphertext.toString("base64"));
    expect(res.text).not.toContain(ciphertext.toString("hex"));
    expect(res.text).not.toContain("local:v1");
  });

  it("answers the lease and the BullMQ state of a running job's attempt, and null before the first dispatch", async () => {
    const { tenant } = await arrangeTenant({ tenant: { status: "provisioning", activated_at: null } });
    fake.setOutcome(tenant.id, { type: "silent" });
    const running = await insertJob(tenant);
    expect((await dispatcher.dispatch(running.id)).dispatched).toBe(true);
    const attempt = bullmqJobId(running.id, 1);
    await fake.waitForHandled((handled) => handled.some((entry) => entry.bullmqJobId === attempt));
    await expect
      .poll(() => tenantOps.getJobState(attempt), { timeout: WAIT_MS, interval: 20 })
      .toBe("failed");

    const res = await get(`/v1/admin/provisioning-jobs/${running.id}`);
    expect(res.status).toBe(200);
    expectResponseToMatch("adminGetProvisioningJob", res, { document: "platform" });
    expect(res.body).toMatchObject({
      status: "running",
      step: "dispatch",
      attempt: 1,
      lockedUntil: new Date(t.clock.now().getTime() + DISPATCH_LEASE_MS).toISOString(),
      bullmqState: "failed",
    });

    const { tenant: other } = await arrangeTenant();
    const queued = await insertJob(other, {
      kind: "migrate",
      payload: { targetVersion: "0002_add_mvp_tenant_deltas" },
    });
    const fresh = await get(`/v1/admin/provisioning-jobs/${queued.id}`);
    expect(fresh.body).toMatchObject({
      status: "queued",
      attempt: 0,
      payload: { targetVersion: "0002_add_mvp_tenant_deltas" },
      result: null,
      lockedUntil: null,
      bullmqState: null,
    });
  });

  it("answers 404 for an unknown job and for a job of a kind outside the API", async () => {
    const unknown = await get(`/v1/admin/provisioning-jobs/${testId("job", 3999)}`);
    expect(unknown.status).toBe(404);
    expectResponseToMatch("adminGetProvisioningJob", unknown, { document: "platform" });
    const { tenant } = await arrangeTenant();
    const exported = await insertJob(tenant, { kind: "export", status: "succeeded" });
    expect((await get(`/v1/admin/provisioning-jobs/${exported.id}`)).status).toBe(404);
  });
});

describe("adminRetryProvisioningJob", () => {
  /** A failed setup whose schema exists already, retried by the admin in the set-up below. */
  let failedSetup: Arranged & { readonly failedJobId: string };
  let retry: Response;
  let retriedJobId: string;

  beforeAll(async () => {
    // The OTA worker created the schema and the first post-step mirrored it, then the setup failed on a later
    // post-step: the tenant is failed, its schema exists. The fake answers `tenant.provisioned` again (the OTA run is a
    // no-op on an existing schema) and the worker runs the post-steps of the new job.
    const arranged = await arrangeTenant({
      tenant: { status: "failed", activated_at: null, schema_version: "0002_add_mvp_tenant_deltas" },
    });
    const failed = await insertJob(arranged.tenant, {
      status: "failed",
      step: "create_payment_connection",
      attempt: 1,
      error:
        "create_payment_connection failed: CRASH_INJECTED: The post-step failed on every try of the event.",
      steps: [
        {
          step: "create_schema",
          status: "succeeded",
          startedAt: "2026-01-15T09:00:01.000Z",
          finishedAt: "2026-01-15T09:00:02.000Z",
        },
        {
          step: "record_migrations",
          status: "succeeded",
          startedAt: "2026-01-15T09:00:03.000Z",
          finishedAt: "2026-01-15T09:00:03.000Z",
        },
        {
          step: "create_payment_connection",
          status: "failed",
          startedAt: "2026-01-15T09:00:04.000Z",
          finishedAt: "2026-01-15T09:00:04.000Z",
          error: { code: "CRASH_INJECTED", message: "The post-step failed on every try of the event." },
        },
      ],
      started_at: before(HOUR_MS),
      finished_at: before(HOUR_MS),
    });
    failedSetup = { ...arranged, failedJobId: failed.id };
    fake.setOutcome(arranged.tenant.id, { type: "provisioned" });
    events.length = 0;

    retry = await post(`/v1/admin/provisioning-jobs/${failed.id}/retry`);
    retriedJobId = (retry.body as { job?: { id: string } }).job?.id ?? "";
    await until(
      async () => {
        const job = await jobRow(retriedJobId);
        return `${job.status}/${job.step ?? ""}`;
      },
      "succeeded/notify",
      "the retried setup",
    );
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-031 AC2] retrying a failed setup with the fake worker set to succeed creates a new job and activates the tenant [PF-83]", async () => {
    const { tenant, failedJobId } = failedSetup;
    expect(retry.status).toBe(202);
    expectResponseToMatch("adminRetryProvisioningJob", retry, { document: "platform" });
    expect(retriedJobId).not.toBe(failedJobId);
    expect(retry.body).toEqual({
      job: {
        id: retriedJobId,
        tenantId: tenant.id,
        tenantKey: tenant.key,
        kind: "provision",
        status: "running",
        step: "dispatch",
        attempt: 1,
        maxAttempts: 5,
        error: null,
        scheduledAt: t.clock.now().toISOString(),
        startedAt: t.clock.now().toISOString(),
        finishedAt: null,
      },
    });

    expect(await tenantRow(tenant.id)).toMatchObject({ status: "active" });
    expect(await jobRow(retriedJobId)).toMatchObject({
      kind: "provision",
      attempt: 1,
      error: null,
      requested_by_account_id: admin.id,
      payload: {},
    });
    // The failed job stays as history.
    expect(await jobRow(failedJobId)).toMatchObject({ status: "failed", attempt: 1 });
    expect(await auditOf("provisioning_job.retried", retriedJobId)).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        tenant_id: tenant.id,
        target_type: "provisioning_job",
        details: expect.objectContaining({
          kind: "provision",
          previousJobId: failedJobId,
          before: { tenantStatus: "failed" },
          after: { tenantStatus: "provisioning" },
        }) as unknown,
      }),
    ]);
    expect(events).toContainEqual({ v: 1, type: "tenant", id: tenant.id });
    expect(fake.invalid).toEqual([]);
  });

  it("reopens the failed OTA of a retried setup and publishes its `tenant` invalidation before any post-step runs", async () => {
    // A silent fake never answers, so no post-step (notify publishes a `tenant` invalidation too) runs for this OTA.
    const { tenant } = await arrangeTenant({ tenant: { status: "failed", activated_at: null } });
    fake.setOutcome(tenant.id, { type: "silent" });
    const failed = await insertJob(tenant, { status: "failed", attempt: 5, finished_at: before(HOUR_MS) });

    const res = await post(`/v1/admin/provisioning-jobs/${failed.id}/retry`);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ job: { kind: "provision", status: "running", attempt: 1 } });
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "provisioning", version: tenant.version + 1 });
    await expect
      .poll(() => events.filter((event) => event.type === "tenant" && event.id === tenant.id).length, {
        timeout: EVENT_WAIT_MS,
        interval: 20,
      })
      .toBe(1);
  });

  it("retries a failed migrate job with a new job of the same kind and payload, leaving the tenant's status alone", async () => {
    const { tenant } = await arrangeTenant();
    fake.setOutcome(tenant.id, { type: "silent" });
    const failed = await insertJob(tenant, {
      kind: "migrate",
      status: "failed",
      attempt: 5,
      payload: { targetVersion: "0002_add_mvp_tenant_deltas" },
      error:
        "ATTEMPT_LOST: Its message is missing from ota-tenant-ops without an answer; the attempt ended with its lease.",
      finished_at: before(HOUR_MS),
    });

    const res = await post(`/v1/admin/provisioning-jobs/${failed.id}/retry`);

    expect(res.status).toBe(202);
    expectResponseToMatch("adminRetryProvisioningJob", res, { document: "platform" });
    const { job } = res.body as { job: { id: string } };
    expect(res.body).toMatchObject({ job: { kind: "migrate", status: "running", attempt: 1 } });
    expect(await jobRow(job.id)).toMatchObject({
      kind: "migrate",
      payload: { targetVersion: "0002_add_mvp_tenant_deltas" },
    });
    const handled = await fake.waitForHandled((all) =>
      all.some((entry) => entry.bullmqJobId === bullmqJobId(job.id, 1)),
    );
    const message = handled.find((entry) => entry.bullmqJobId === bullmqJobId(job.id, 1))?.message;
    expect(message).toMatchObject({
      name: "tenant.migrate",
      jobId: job.id,
      tenantId: tenant.id,
      payload: { targetVersion: "0002_add_mvp_tenant_deltas" },
    });
    expect(() => validateJob("tenant.migrate", message)).not.toThrow();
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "active", version: tenant.version });
    expect(await auditOf("provisioning_job.retried", job.id)).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        details: expect.objectContaining({ kind: "migrate", previousJobId: failed.id }) as unknown,
      }),
    ]);
  });

  it("answers 409 PROVISIONING_NOT_RETRYABLE for a job that is not failed, a setup of an OTA that is not failed and a kind already active, changing nothing", async () => {
    const { tenant } = await arrangeTenant();
    const succeeded = await insertJob(tenant, { status: "succeeded", attempt: 1 });
    const failedSetup = await insertJob(tenant, {
      status: "failed",
      attempt: 5,
      created_at: before(HOUR_MS),
    });
    const failedMigrate = await insertJob(tenant, { kind: "migrate", status: "failed", attempt: 5 });
    await insertJob(tenant, { kind: "migrate", status: "queued" });
    const jobsBefore = await jobsOf(tenant.id);

    for (const [jobId, reason] of [
      [succeeded.id, "not_failed"],
      [failedSetup.id, "tenant_not_failed"],
      [failedMigrate.id, "job_active"],
    ] as const) {
      const res = await post(`/v1/admin/provisioning-jobs/${jobId}/retry`);
      expect(res.status, reason).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: "PROVISIONING_NOT_RETRYABLE", details: { reason } });
      expectResponseToMatch("adminRetryProvisioningJob", res, { document: "platform" });
      expect(await auditOf("provisioning_job.retried", jobId)).toEqual([]);
    }
    expect(await jobsOf(tenant.id)).toEqual(jobsBefore);
    expect(await tenantRow(tenant.id)).toMatchObject({ status: "active", version: tenant.version });

    const unknown = await post(`/v1/admin/provisioning-jobs/${testId("job", 3998)}/retry`);
    expect(unknown.status).toBe(404);
  });
});

describe("adminCancelProvisioningJob", () => {
  const REASON = "The owner asked to stop the setup; the OTA will be created again under another key.";

  it("[PBE-031 AC2] cancelling a running job answers 409; a queued job is canceled with the reason audited and never dispatched", async () => {
    const { tenant } = await arrangeTenant({ tenant: { status: "provisioning", activated_at: null } });
    const running = await insertJob(tenant, {
      kind: "migrate",
      status: "running",
      attempt: 1,
      step: "dispatch",
      started_at: t.clock.now(),
      locked_until: new Date(t.clock.now().getTime() + DISPATCH_LEASE_MS),
    });

    const conflict = await post(`/v1/admin/provisioning-jobs/${running.id}/cancel`, { reason: REASON });

    expect(conflict.status).toBe(409);
    expect(errorOf(conflict)).toMatchObject({ code: "CONFLICT", details: { reason: "not_queued" } });
    expectResponseToMatch("adminCancelProvisioningJob", conflict, { document: "platform" });
    expect(await jobRow(running.id)).toMatchObject({ status: "running", attempt: 1 });
    expect(await auditOf("provisioning_job.canceled", running.id)).toEqual([]);

    // A setup waiting for its Checkout gate (M5: a Stripe subscription not paid yet) is `queued`.
    const { tenant: waiting } = await arrangeTenant({
      tenant: { status: "provisioning", activated_at: null },
      subscription: { status: "incomplete", billing_provider: "stripe" },
    });
    const queued = await insertJob(waiting);

    const res = await post(`/v1/admin/provisioning-jobs/${queued.id}/cancel`, { reason: REASON });

    expect(res.status).toBe(200);
    expectResponseToMatch("adminCancelProvisioningJob", res, { document: "platform" });
    expect(res.body).toMatchObject({
      job: { id: queued.id, status: "canceled", attempt: 0, finishedAt: t.clock.now().toISOString() },
    });
    expect(await auditOf("provisioning_job.canceled", queued.id)).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        tenant_id: waiting.id,
        details: expect.objectContaining({
          reason: REASON,
          before: { status: "queued" },
          after: { status: "canceled" },
        }) as unknown,
      }),
    ]);
    expect(await tenantRow(waiting.id)).toMatchObject({ status: "provisioning", version: waiting.version });
    expect(await dispatcher.dispatch(queued.id)).toMatchObject({ dispatched: false, reason: "not_queued" });

    const again = await post(`/v1/admin/provisioning-jobs/${queued.id}/cancel`, { reason: REASON });
    expect(again.status).toBe(409);
  });

  it("requires a reason of 5 to 500 characters", async () => {
    const { tenant } = await arrangeTenant();
    const queued = await insertJob(tenant, { kind: "migrate" });
    for (const body of [{}, { reason: "no" }, { reason: "x".repeat(501) }]) {
      const res = await post(`/v1/admin/provisioning-jobs/${queued.id}/cancel`, body);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe("VALIDATION_FAILED");
    }
    expect((await jobRow(queued.id)).status).toBe("queued");
  });
});

describe("adminListQueues", () => {
  let domains: Queue;
  let bookings: Queue;
  let holder: Worker;
  let release: () => void = () => undefined;

  beforeAll(async () => {
    domains = testQueue("platform-domains");
    bookings = testQueue("ota-bookings");
    // platform-domains: 2 failed, 1 active (held by a worker of this file), 3 waiting (40, 30 and 20 seconds old at
    // the FakeClock's time, added in that order) and 2 delayed by an hour of real time.
    await failJobs(
      domains,
      [
        { name: "domain.verify", data: { domainId: testId("dom", 3401) } },
        { name: "domain.verify", data: { domainId: testId("dom", 3402) } },
      ],
      () => "DNS lookup timed out",
    );
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    holder = new Worker(domains.name, () => gate, { connection, prefix: BULLMQ_PREFIX, concurrency: 1 });
    holder.on("error", () => undefined);
    await domains.add("domain.recheck", { domainId: testId("dom", 3403) });
    await countReaches(domains, "active", 1);
    for (const [index, age] of [40, 30, 20].entries()) {
      await domains.add(
        "domain.tls_probe",
        { domainId: testId("dom", 3410 + index) },
        { timestamp: before(age * SECOND_MS).getTime() },
      );
    }
    for (const index of [0, 1]) {
      await domains.add("domain.recheck", { domainId: testId("dom", 3420 + index) }, { delay: HOUR_MS });
    }
    // ota-bookings: 1 waiting, 5 seconds old, and 1 delayed.
    await bookings.add(
      "booking.sync",
      { bookingId: "bkg_01JATESTRW0000000000000001" },
      {
        timestamp: before(5 * SECOND_MS).getTime(),
      },
    );
    await bookings.add("booking.sync", { bookingId: "bkg_01JATESTRW0000000000000002" }, { delay: HOUR_MS });
  }, GROUP_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    // Closing first, then releasing the held job: the closing worker takes no further job.
    const closing = holder?.close();
    release();
    await closing;
    await domains?.close();
    await bookings?.close();
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-031 AC3] counts match the jobs added in the test, for every queue of both backends, platform queues first [PF-84]", async () => {
    const res = await get("/v1/admin/queues");

    expect(res.status).toBe(200);
    expectResponseToMatch("adminListQueues", res, { document: "platform" });
    const data = (res.body as { data: Array<{ name: string; owner: string }> }).data;
    expect(data.map(({ name, owner }) => ({ name, owner }))).toEqual([
      ...PLATFORM_QUEUES.map((name) => ({ name, owner: "platform" })),
      ...OTA_QUEUES.map((name) => ({ name, owner: "ota" })),
    ]);
    expect(data.find((queue) => queue.name === "platform-domains")).toEqual({
      name: "platform-domains",
      owner: "platform",
      waiting: 3,
      active: 1,
      delayed: 2,
      failed: 2,
      oldestWaitingSeconds: 40,
    });
    expect(data.find((queue) => queue.name === "ota-bookings")).toEqual({
      name: "ota-bookings",
      owner: "ota",
      waiting: 1,
      active: 0,
      delayed: 1,
      failed: 0,
      oldestWaitingSeconds: 5,
    });
    expect(data.find((queue) => queue.name === "ota-payments")).toEqual({
      name: "ota-payments",
      owner: "ota",
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      oldestWaitingSeconds: null,
    });
    // Read-only: no key of a queue that only the inspector opened in this file (no job, no meta hash of BullMQ's).
    for (const name of OTA_QUEUES.filter((queue) => queue !== OTA_TENANT_OPS && queue !== "ota-bookings")) {
      expect(await connection.keys(`${BULLMQ_PREFIX}:${name}:*`), name).toEqual([]);
    }
  });

  it("refuses a portal token with 401", async () => {
    const res = await t.http.get("/v1/admin/queues").set(await portalHeaders());
    expect(res.status).toBe(401);
    expectResponseToMatch("adminListQueues", res, { document: "platform" });
  });
});

describe("failed queue jobs", () => {
  /** Two failed jobs of platform-settlements for the list, one of platform-stripe-events for the retry. */
  let settlements: Queue;
  let stripeEvents: Queue;
  let failed: Job[];
  let toRetry: Job;
  /** A failed `tenant.provision` message of ota-tenant-ops (a silent fake: the attempt fails without an answer). */
  let otaFailedId: string;

  beforeAll(async () => {
    settlements = testQueue("platform-settlements");
    failed = await failJobs(
      settlements,
      [
        { name: "settlement.generate", data: { periodStart: "2026-09-01", tenantId: testId("ten", 3501) } },
        { name: "settlement.generate", data: { periodStart: "2026-09-01", tenantId: testId("ten", 3502) } },
      ],
      (job) => `settlement of ${String((job.data as { tenantId?: unknown }).tenantId)} has no closed period`,
    );
    stripeEvents = testQueue("platform-stripe-events");
    [toRetry] = (await failJobs(
      stripeEvents,
      [{ name: "stripe.event", data: { eventId: "evt_1QadminJobsTest00000001" } }],
      () => "the subscription of the event is unknown",
    )) as [Job];

    const { tenant } = await arrangeTenant({ tenant: { status: "provisioning", activated_at: null } });
    fake.setOutcome(tenant.id, { type: "silent" });
    const job = await insertJob(tenant);
    await dispatcher.dispatch(job.id);
    otaFailedId = bullmqJobId(job.id, 1);
    await until(() => tenantOps.getJobState(otaFailedId), "failed", "the silent setup's message");
  }, GROUP_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await settlements?.close();
    await stripeEvents?.close();
  });

  it("lists a queue's failed jobs with their reason and id-only data, most recent failure first, at most `limit`", async () => {
    const res = await get("/v1/admin/queues/platform-settlements/failed");

    expect(res.status).toBe(200);
    expectResponseToMatch("adminListFailedQueueJobs", res, { document: "platform" });
    const [older, newer] = failed as [Job, Job];
    const failedAt = async (job: Job): Promise<string> =>
      new Date((await settlements.getJob(job.id ?? ""))?.finishedOn ?? 0).toISOString();
    expect((res.body as { data: unknown[] }).data).toEqual([
      {
        id: newer.id,
        name: "settlement.generate",
        failedReason: `settlement of ${testId("ten", 3502)} has no closed period`,
        attemptsMade: 1,
        failedAt: await failedAt(newer),
        data: { periodStart: "2026-09-01", tenantId: testId("ten", 3502) },
      },
      {
        id: older.id,
        name: "settlement.generate",
        failedReason: `settlement of ${testId("ten", 3501)} has no closed period`,
        attemptsMade: 1,
        failedAt: await failedAt(older),
        data: { periodStart: "2026-09-01", tenantId: testId("ten", 3501) },
      },
    ]);

    const limited = await get("/v1/admin/queues/platform-settlements/failed?limit=1");
    expect((limited.body as { data: Array<{ id: string }> }).data.map((job) => job.id)).toEqual([newer.id]);

    const ota = await get(`/v1/admin/queues/${OTA_TENANT_OPS}/failed`);
    expect(ota.status).toBe(200);
    expectResponseToMatch("adminListFailedQueueJobs", ota, { document: "platform" });
    expect((ota.body as { data: unknown[] }).data).toContainEqual(
      expect.objectContaining({
        id: otaFailedId,
        name: "tenant.provision",
        data: expect.objectContaining({ name: "tenant.provision", payload: {} }) as unknown,
      }),
    );

    const unknown = await get("/v1/admin/queues/platform-unknown/failed");
    expect(unknown.status).toBe(404);
    expectResponseToMatch("adminListFailedQueueJobs", unknown, { document: "platform" });
    expect((await get("/v1/admin/queues/Not_A_Queue/failed")).status).toBe(400);
  });

  it("[PBE-031 AC3] retries a failed platform job with one audit row, and answers 403 for a job of ota-tenant-ops [PF-84]", async () => {
    const id = toRetry.id ?? "";

    const res = await post(`/v1/admin/queues/platform-stripe-events/jobs/${id}/retry`);

    expect(res.status).toBe(202);
    expectResponseToMatch("adminRetryQueueJob", res, { document: "platform" });
    expect(await stripeEvents.getJobState(id)).toBe("waiting");
    expect((await stripeEvents.getJob(id))?.attemptsMade).toBe(0);
    expect(await auditOf("queue_job.retried", `platform-stripe-events:${id}`)).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        target_type: "queue_job",
        details: expect.objectContaining({
          queue: "platform-stripe-events",
          jobId: id,
          name: "stripe.event",
          failedReason: "the subscription of the event is unknown",
        }) as unknown,
      }),
    ]);
    // It is waiting now, no longer failed.
    const again = await post(`/v1/admin/queues/platform-stripe-events/jobs/${id}/retry`);
    expect(again.status).toBe(404);
    expect(await auditOf("queue_job.retried", `platform-stripe-events:${id}`)).toHaveLength(1);

    const forbidden = await post(`/v1/admin/queues/${OTA_TENANT_OPS}/jobs/${otaFailedId}/retry`);
    expect(forbidden.status).toBe(403);
    expect(errorOf(forbidden)).toMatchObject({ code: "FORBIDDEN", details: { reason: "ota_queue" } });
    expectResponseToMatch("adminRetryQueueJob", forbidden, { document: "platform" });
    expect(await tenantOps.getJobState(otaFailedId)).toBe("failed");
    expect(await auditOf("queue_job.retried", `${OTA_TENANT_OPS}:${otaFailedId}`)).toEqual([]);

    expect((await post("/v1/admin/queues/ota-unknown/jobs/1/retry")).status).toBe(404);
    expect((await post("/v1/admin/queues/platform-settlements/jobs/no-such-job/retry")).status).toBe(404);
  });
});
