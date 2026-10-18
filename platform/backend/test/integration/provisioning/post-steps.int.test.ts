// The tenant-event consumer and the provisioning post-steps (PBE-022; platform/docs/flows/provisioning.md §3, PADR-0001
// items 1 and 5, PADR-0012 item 2; scope PF-50 and PF-60) on this file's database clone and Redis database: the API
// (createTestApp) creates and dispatches an OTA, the fake OTA worker (test/support/fake-ota-worker.ts) answers
// `tenant.provisioned`, and the worker's module graph (WorkerModule, as dist/worker.js builds it, with the API's
// FakeClock) consumes `platform-tenant-events`, runs the six post-steps and sends the e-mails through SMTP to Mailpit.
// Other tests write the job and the event themselves (builders, the platform's own `platform-tenant-events` queue) to
// deliver an event twice, from an older attempt, for two tenants at the same moment, or with a crash in a step.
//
// Concurrency is made deterministic as in the other provisioning tests: a transaction of the test holds a lock the
// steps need, and lets it go once every run waits for it. OPS_ALERT_EMAIL and the owners' addresses are this file's
// own (`uniqueEmail`), so no other test file's mail counts here.
import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import provisionedFixture from "@velexis/api-types/fixtures/jobs/tenant-provisioned.json";
import {
  bullmqJobId,
  INVALIDATION_CHANNEL,
  OTA_PROVISIONING_STEPS,
  OTA_TENANT_OPS,
  PLATFORM_TENANT_EVENTS,
  validateJob,
  type InvalidationEvent,
  type TenantProvisionedEvent,
} from "@velexis/api-types/jobs";
import { hashApiKey } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { mailpit, uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Job, JobsOptions, Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { API_KEY_PEPPER } from "../../../src/api-keys/api-key-generator";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_DB, PLATFORM_POOL, type PlatformDb, type PlatformPool } from "../../../src/common/database";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { runInTransaction } from "../../../src/common/redis/invalidation.publisher";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { ProvisioningDispatcher } from "../../../src/provisioning/dispatcher";
import { ActivateStep } from "../../../src/provisioning/post-steps/activate.step";
import {
  revealPlace,
  type InitialKeys,
  IssueApiKeysStep,
} from "../../../src/provisioning/post-steps/issue-api-keys.step";
import { NotifyStep } from "../../../src/provisioning/post-steps/notify.step";
import {
  POST_STEP_NAMES,
  PostStepsRunner,
  type PostStep,
  type PostStepOutcome,
} from "../../../src/provisioning/post-steps/post-steps.runner";
import { ProvisioningJobsRepository } from "../../../src/provisioning/provisioning-jobs.repository";
import {
  TenantEventsProcessor,
  type TenantEventOutcome,
} from "../../../src/provisioning/tenant-events.processor";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertRow,
  insertSubscription,
  insertTenant,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FAKE_TENANT_LEDGER, FakeOtaWorker, schemaNamesFrom } from "../../support/fake-ota-worker";

/** Starting the API, the worker's module graph and the fake OTA worker takes seconds; bounded for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker, an e-mail or an invalidation. */
const WAIT_MS = 20_000;
/** Documentation address (RFC 5737). */
const PERSON_IP = "203.0.113.7";
/** A zone of the reference data for createTenant; the fixture of @velexis/testing has none, beforeAll adds it. */
const TIME_ZONE = "Europe/Paris";
const OPS_EMAIL = uniqueEmail("ops-provisioning");
/** The last migration of the fake ledger: the schema version of every tenant the fake provisions. */
const FAKE_SCHEMA_VERSION = "0002_add_mvp_tenant_deltas";

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let fake: FakeOtaWorker;
let dispatcher: ProvisioningDispatcher;
let tenantEvents: Queue;
let tenantOps: Queue;
let subscriber: Redis;
const workerLogs = new LogSink();
const invalidations: InvalidationEvent[] = [];
/** Ids of this file's rows: audit rows and tenants stay between tests, so each test writes rows of its own. */
let next = 1;
const nextId = (prefix: string): string => testId(prefix, 1000 + next++);

beforeAll(async () => {
  // Expensive set-up, once per file: the database clone, the API's and the worker's Nest module graphs, the fake OTA
  // worker's Redis connections, the platform document that expectResponseToMatch parses on its first use, and the Ajv
  // validators of the job messages (validateJob compiles them on its first call). 60 s covers a slow CI runner.
  t = await createTestApp({ env: { OPS_ALERT_EMAIL: OPS_EMAIL } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  dispatcher = t.app.get(ProvisioningDispatcher, { strict: false });
  tenantEvents = t.app.get<Queue>(getQueueToken(PLATFORM_TENANT_EVENTS), { strict: false });
  tenantOps = t.app.get<Queue>(getQueueToken(OTA_TENANT_OPS), { strict: false });
  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ($1, 'FR', 60, 120)",
    [TIME_ZONE],
  );
  responseChecker("platform");
  validateJob("tenant.provisioned", provisionedFixture);

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

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    invalidations.push(JSON.parse(message) as InvalidationEvent);
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await fake?.close();
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(async () => {
  // One Velexis Amadeus account per environment: every test sets up the pool it needs.
  await pool.query("DELETE FROM platform.supplier_connections");
  await pool.query("DELETE FROM platform.amadeus_offices");
  await pool.query("DELETE FROM platform.amadeus_accounts");
  invalidations.length = 0;
});

// ---- Arrangement --------------------------------------------------------------------------------------------------

/** The Velexis `test` account (active unless `status` says otherwise) and `offices` available offices, oldest first. */
async function testPool(
  offices: number,
  status = "active",
): Promise<{ account: PlatformRow<"amadeus_accounts">; offices: Array<PlatformRow<"amadeus_offices">> }> {
  const account = await insertAmadeusAccount(pool, { id: nextId("ama"), status });
  const rows: Array<PlatformRow<"amadeus_offices">> = [];
  for (let index = 0; index < offices; index += 1) {
    const n = next++;
    rows.push(
      await insertAmadeusOffice(pool, account, {
        id: testId("amo", 1000 + n),
        office_id: `PAR1A${String(n).padStart(4, "0")}`,
        // Oldest first: the first office is the one provisioning takes.
        created_at: new Date(Date.UTC(2026, 0, 1, 0, index)),
      }),
    );
  }
  return { account, offices: rows };
}

interface Arranged {
  readonly tenant: PlatformRow<"tenants">;
  readonly owner: PlatformRow<"accounts">;
  readonly jobId: string;
}

/**
 * A `provisioning` OTA with its owner (an address of this test only), a manual trial and a `provision` job: `running`
 * at `attempt` (as a dispatch leaves it), or `queued` with no attempt made when `attempt` is 0.
 */
async function arrange(attempt = 1): Promise<Arranged> {
  const n = next++;
  const owner = await insertAccount(pool, {
    id: testId("acc", 1000 + n),
    email: uniqueEmail(`owner${n}`),
    full_name: `Owner ${n}`,
  });
  const tenant = await insertTenant(pool, {
    id: testId("ten", 1000 + n),
    key: `poststeps${n}`,
    name: `Post Steps ${n} Travel`,
    status: "provisioning",
    activated_at: null,
  });
  await insertMember(pool, tenant, owner, "owner");
  await insertSubscription(pool, tenant, { id: testId("sub", 1000 + n) });
  const jobId = testId("job", 1000 + n);
  const now = t.clock.now();
  await insertRow(pool, "provisioning_jobs", {
    id: jobId,
    tenant_id: tenant.id,
    kind: "provision",
    status: attempt === 0 ? "queued" : "running",
    attempt,
    scheduled_at: now,
    ...(attempt === 0
      ? {}
      : { step: "dispatch", started_at: now, locked_until: new Date(now.getTime() + 15 * 60_000) }),
  });
  return { tenant, owner, jobId };
}

/** The `tenant.provisioned` event the OTA worker sends for `arranged`: the fake ledger and the three OTA steps. */
function provisionedEvent({ tenant, jobId }: Arranged): TenantProvisionedEvent {
  const at = t.clock.now().toISOString();
  return validateJob("tenant.provisioned", {
    v: 1,
    name: "tenant.provisioned",
    jobId,
    tenantId: tenant.id,
    requestedAt: at,
    requestId: `post-steps-${randomUUID()}`,
    payload: {
      schemaName: tenant.schema_name,
      schemaVersion: FAKE_SCHEMA_VERSION,
      migrations: FAKE_TENANT_LEDGER.map((entry) => ({ ...entry, appliedAt: at })),
      steps: OTA_PROVISIONING_STEPS.map((step) => ({
        step,
        status: "succeeded",
        startedAt: at,
        finishedAt: at,
      })),
    },
  });
}

/** Adds `event` to `platform-tenant-events` as the OTA worker does, with the BullMQ id of `attempt`. */
async function deliver(
  event: TenantProvisionedEvent,
  attempt: number,
  options: JobsOptions = {},
): Promise<string> {
  const id = bullmqJobId(event.jobId, attempt);
  await tenantEvents.add(event.name, event, { ...options, jobId: id });
  return id;
}

/** The BullMQ job `id` of `platform-tenant-events` once the worker is done with it (completed or failed). */
async function finished(id: string): Promise<Job> {
  await expect
    .poll(
      async () => {
        const state = await tenantEvents.getJobState(id);
        return state === "completed" || state === "failed";
      },
      { timeout: WAIT_MS, interval: 20 },
    )
    .toBe(true);
  // Read once the state is final: a job read before it holds the return value and tries of that moment.
  const found = await tenantEvents.getJob(id);
  if (found === undefined) {
    throw new Error(`no BullMQ job ${id}`);
  }
  return found;
}

async function jobRow(jobId: string): Promise<PlatformRow<"provisioning_jobs">> {
  const { rows } = await pool.query("SELECT * FROM platform.provisioning_jobs WHERE id = $1", [jobId]);
  return rows[0] as PlatformRow<"provisioning_jobs">;
}

async function tenantRow(tenantId: string): Promise<PlatformRow<"tenants">> {
  const { rows } = await pool.query("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]);
  return rows[0] as PlatformRow<"tenants">;
}

/** Waits until the job's post-steps are all done: `succeeded` with `notify` as its last step. */
async function provisioned(jobId: string): Promise<PlatformRow<"provisioning_jobs">> {
  await expect
    .poll(
      async () => {
        const job = await jobRow(jobId);
        return `${job.status}/${job.step ?? ""}`;
      },
      { timeout: WAIT_MS, interval: 20 },
    )
    .toBe("succeeded/notify");
  return jobRow(jobId);
}

/** The rows of `table` of the tenant. */
async function rowsOf<T>(table: string, tenantId: string, order = "created_at, 1"): Promise<T[]> {
  const { rows } = await pool.query(
    `SELECT * FROM platform.${table} WHERE tenant_id = $1 ORDER BY ${order}`,
    [tenantId],
  );
  return rows as T[];
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

/** The full log of a provisioning that went through on the first try. */
const ALL_SUCCEEDED = [...OTA_PROVISIONING_STEPS, ...POST_STEP_NAMES].map((step) => `${step}:succeeded`);

/** How many sessions of this file's database wait for a lock (row and advisory locks alike). */
async function waitingOnLocks(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(DISTINCT l.pid)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
      "WHERE NOT l.granted AND a.datname = current_database()",
  );
  return (rows[0] as { waiting: number }).waiting;
}

/** Waits until the invalidation events `expected` have arrived (in any order, among others). */
async function invalidated(expected: readonly InvalidationEvent[]): Promise<void> {
  const has = (event: InvalidationEvent): boolean =>
    invalidations.some((received) => JSON.stringify(received) === JSON.stringify(event));
  await expect.poll(() => expected.every(has), { timeout: WAIT_MS, interval: 20 }).toBe(true);
}

/** Every line the API and the worker logged, as one text. */
function allLogs(): string {
  return JSON.stringify([...t.logs.lines, ...workerLogs.lines]);
}

/**
 * The lines with `msg` of both sinks: nestjs-pino keeps one logger per process for lines written outside a request, so
 * the worker's lines may land in the API's sink (README §8).
 */
function logLines(msg: string): Array<Record<string, unknown>> {
  return [...t.logs.withMessage(msg), ...workerLogs.withMessage(msg)];
}

// ---- Tests --------------------------------------------------------------------------------------------------------

describe("a new OTA with the fake OTA worker", () => {
  it("[PBE-022 AC1] becomes active with one test office, a velexis test payment connection, two keys and the mirrored ledger [PF-50 AC1, PF-60 AC1]", async () => {
    const { account, offices } = await testPool(2);
    const founder = await insertAccount(pool, {
      id: nextId("acc"),
      email: uniqueEmail("founder"),
      full_name: "Camille Martin",
    });
    const { token } = await t.app.get(TokenService).sign({
      aud: "portal",
      sub: founder.id,
      sid: testId("asn", 1),
      ev: true,
      amr: ["pwd"],
    });
    const now = t.clock.now();

    const res = await t.http
      .post("/v1/tenants")
      .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) })
      .set("Idempotency-Key", randomUUID())
      .send({
        key: "cafevoyages",
        name: "Café Voyages Paris",
        countryCode: "FR",
        defaultCurrency: "EUR",
        timeZone: TIME_ZONE,
      });

    expect(res.status).toBe(202);
    expectResponseToMatch("createTenant", res, { document: "platform" });
    const { tenant: created, provisioningJob } = res.body as {
      tenant: { id: string };
      provisioningJob: { id: string };
    };
    const tenantId = created.id;
    const jobId = provisioningJob.id;
    const job = await provisioned(jobId);

    // The tenant: active, with the schema version of the ledger.
    expect(await tenantRow(tenantId)).toMatchObject({
      status: "active",
      activated_at: now,
      schema_version: FAKE_SCHEMA_VERSION,
      version: 2,
    });
    // The mirrored ledger: the two migrations of the fake OTA worker, applied.
    const ledger = await rowsOf<PlatformRow<"tenant_schema_migrations">>(
      "tenant_schema_migrations",
      tenantId,
      "version",
    );
    expect(ledger).toEqual(
      FAKE_TENANT_LEDGER.map((entry) =>
        expect.objectContaining({
          version: entry.version,
          schema_name: "tenant_cafevoyages",
          checksum: entry.checksum,
          phase: entry.phase,
          status: "applied",
          runner_id: jobId,
          duration_ms: entry.durationMs,
          finished_at: now,
          error: null,
        }),
      ),
    );
    // One test office, the oldest of the pool, and its active `velexis` connection.
    const [first, second] = offices;
    const connections = await rowsOf<PlatformRow<"supplier_connections">>("supplier_connections", tenantId);
    expect(connections).toEqual([
      expect.objectContaining({
        environment: "test",
        credential_source: "velexis",
        amadeus_account_id: account.id,
        office_ids: [first?.office_id],
        default_office_id: first?.office_id,
        queuing_office_id: first?.office_id,
        owner_office_id: first?.office_id,
        status: "active",
        client_secret_ciphertext: null,
      }),
    ]);
    const { rows: officeRows } = await pool.query(
      "SELECT id, status, assigned_tenant_id FROM platform.amadeus_offices ORDER BY created_at",
    );
    expect(officeRows).toEqual([
      { id: first?.id, status: "assigned", assigned_tenant_id: tenantId },
      { id: second?.id, status: "available", assigned_tenant_id: null },
    ]);
    // The Velexis Stripe test connection, without secrets, with the descriptor suffix of the OTA's name.
    expect(await rowsOf("payment_provider_connections", tenantId)).toEqual([
      expect.objectContaining({
        provider: "stripe",
        environment: "test",
        account_mode: "velexis",
        capture_mode: "manual",
        is_default: true,
        status: "active",
        statement_descriptor_suffix: "Cafe Voyages Paris",
        account_reference: null,
        publishable_key: null,
        secret_ciphertext: null,
        webhook_secret_ciphertext: null,
        created_by_account_id: null,
      }),
    ]);
    // The two initial test keys.
    const keys = await rowsOf<PlatformRow<"api_keys">>("api_keys", tenantId, "kind");
    expect(keys.map((key) => [key.kind, key.environment, key.allowed_origins, key.scopes])).toEqual([
      ["publishable", "test", [], []],
      ["secret", "test", [], ["storefront"]],
    ]);
    // The job: succeeded, its log, its result, and the keys kept encrypted for one reveal.
    expect(job).toMatchObject({
      status: "succeeded",
      step: "notify",
      finished_at: now,
      locked_until: null,
      error: null,
      result: {
        schemaVersion: FAKE_SCHEMA_VERSION,
        officeId: first?.office_id,
        apiKeyIds: [keys[0]?.id, keys[1]?.id],
      },
    });
    expect(stepsOf(job)).toEqual(ALL_SUCCEEDED);
    expect(job.reveal_ciphertext).not.toBeNull();
    expect(job.reveal_encryption_key_id).not.toBeNull();
    const revealed = (await t.app
      .get(EnvelopeService)
      .decryptJson(job.reveal_ciphertext as Buffer, revealPlace(jobId))) as InitialKeys;
    const pepper = t.app.get<Buffer>(API_KEY_PEPPER, { strict: false });
    expect(
      revealed.keys.map(({ id, kind, environment, prefix }) => ({ id, kind, environment, prefix })),
    ).toEqual(keys.map(({ id, kind, environment, prefix }) => ({ id, kind, environment, prefix })));
    expect(revealed.keys.map(({ key }) => hashApiKey(key, pepper))).toEqual(keys.map((key) => key.key_hash));
    // The audit rows of the system.
    expect(await auditOf(tenantId, "tenant.activated")).toEqual([
      expect.objectContaining({
        actor_type: "system",
        actor_label: "provisioning",
        target_type: "tenant",
        target_id: tenantId,
        tenant_key: "cafevoyages",
        request_id: res.headers["x-request-id"],
        details: expect.objectContaining({
          jobId,
          schemaVersion: FAKE_SCHEMA_VERSION,
          officeId: first?.office_id,
          before: { status: "provisioning" },
          after: { status: "active" },
        }) as unknown,
      }),
    ]);
    expect(await auditOf(tenantId, "amadeus_office.assigned")).toEqual([
      expect.objectContaining({ actor_type: "system", target_id: first?.id }),
    ]);
    expect(await auditOf(tenantId, "api_key.created")).toHaveLength(2);
    // After the commits: the invalidations and the welcome e-mail to the owner.
    await invalidated([
      { v: 1, type: "tenant", id: tenantId },
      { v: 1, type: "connection", tenantId },
      { v: 1, type: "amadeus_account", id: account.id },
    ]);
    const welcome = await waitForMessage({ to: founder.email, timeoutMs: WAIT_MS });
    expect(welcome.Subject).toBe("Café Voyages Paris is ready on Velexis");
    // The raw keys are nowhere but in the ciphertext: no log line, job result, audit row or e-mail holds them.
    const stored = JSON.stringify([
      job.result,
      job.steps,
      await auditOf(tenantId, "api_key.created"),
      await emailsOf(tenantId, "tenant.welcome"),
    ]);
    for (const { key } of revealed.keys) {
      expect(allLogs()).not.toContain(key);
      expect(stored).not.toContain(key);
      expect(welcome.Text).not.toContain(key);
    }
    expect(fake.invalid).toEqual([]);
  });
});

describe("events delivered twice or late", () => {
  it("[PBE-022 AC2] delivering tenant.provisioned twice creates no duplicate row and sends one welcome e-mail", async () => {
    await testPool(2);
    const arranged = await arrange(0);
    const { tenant, owner, jobId } = arranged;
    await tenantOps.drain(true);

    expect((await dispatcher.dispatch(jobId)).dispatched).toBe(true);
    const job = await provisioned(jobId);
    await waitForMessage({ to: owner.email, timeoutMs: WAIT_MS });

    // The OTA worker reports the same attempt again: the BullMQ job is gone, so the event is a new delivery.
    const id = bullmqJobId(jobId, 1);
    const first = await finished(id);
    const data = first.data as TenantProvisionedEvent;
    await first.remove();
    await deliver(data, 1);
    const second = await finished(id);

    expect(second.returnvalue).toEqual({
      outcome: "ignored",
      reason: "finished",
    } satisfies TenantEventOutcome);
    const after = await jobRow(jobId);
    expect(after).toMatchObject({ status: "succeeded", updated_at: job.updated_at });
    expect(stepsOf(after)).toEqual(ALL_SUCCEEDED);
    expect(await rowsOf("supplier_connections", tenant.id)).toHaveLength(1);
    expect(await rowsOf("payment_provider_connections", tenant.id)).toHaveLength(1);
    expect(await rowsOf("api_keys", tenant.id)).toHaveLength(2);
    expect(await rowsOf("tenant_schema_migrations", tenant.id)).toHaveLength(2);
    expect(await auditOf(tenant.id, "tenant.activated")).toHaveLength(1);
    expect(await emailsOf(tenant.id, "tenant.welcome")).toHaveLength(1);
    expect(await mailpit.search({ to: owner.email })).toHaveLength(1);
    expect(
      logLines("provisioning.event_ignored").map((line) => [line["jobId"], line["reason"]]),
    ).toContainEqual([jobId, "finished"]);
  });

  it("[PBE-022 AC2] two deliveries of tenant.provisioned at the same time run every step once", async () => {
    const { offices } = await testPool(2);
    const arranged = await arrange(1);
    const { tenant, owner, jobId } = arranged;
    const event = provisionedEvent(arranged);
    const processor = worker.get(TenantEventsProcessor, { strict: false });
    const job = { id: bullmqJobId(jobId, 1), name: event.name, data: event } as Job;

    const outcomes = await Promise.all([processor.process(job), processor.process(job)]);

    // The runs take turns at the job's row lock; whichever finds a step done passes it, and one that finds the job
    // succeeded before its turn at `activate` stops. Every step is in the log exactly once.
    expect(outcomes.map(({ outcome }) => outcome)).toContain("completed");
    const after = await jobRow(jobId);
    expect(after.status).toBe("succeeded");
    expect(stepsOf(after)).toEqual(ALL_SUCCEEDED);
    expect((await tenantRow(tenant.id)).status).toBe("active");
    expect(await rowsOf<PlatformRow<"supplier_connections">>("supplier_connections", tenant.id)).toEqual([
      expect.objectContaining({ office_ids: [offices[0]?.office_id], status: "active" }),
    ]);
    expect(await rowsOf("payment_provider_connections", tenant.id)).toHaveLength(1);
    expect(await rowsOf("api_keys", tenant.id)).toHaveLength(2);
    expect(await rowsOf("tenant_schema_migrations", tenant.id)).toHaveLength(2);
    expect(await auditOf(tenant.id, "tenant.activated")).toHaveLength(1);
    expect(await emailsOf(tenant.id, "tenant.welcome")).toHaveLength(1);
    await waitForMessage({ to: owner.email, timeoutMs: WAIT_MS });
    expect(await mailpit.search({ to: owner.email })).toHaveLength(1);
  });

  it("[PBE-022 AC2] every step is idempotent on its own: run again on the job without the log, it writes no second row", async () => {
    await testPool(2);
    const arranged = await arrange(1);
    const { tenant, owner, jobId } = arranged;
    const event = provisionedEvent(arranged);
    await deliver(event, 1);
    await provisioned(jobId);
    // The welcome e-mail's row reaches its final status before the comparison starts.
    await expect
      .poll(async () => (await emailsOf(tenant.id, "tenant.welcome")).map((row) => row["status"]), {
        timeout: WAIT_MS,
        interval: 20,
      })
      .toEqual(["sent"]);
    /** The tenant's rows of each table, by key column. */
    const tables: ReadonlyArray<readonly [string, string]> = [
      ["tenant_schema_migrations", "version"],
      ["supplier_connections", "id"],
      ["payment_provider_connections", "id"],
      ["api_keys", "id"],
      ["email_outbox", "id"],
      ["platform_audit_log", "id"],
    ];
    const snapshot = async (): Promise<unknown> => {
      const job = await jobRow(jobId);
      const rows: Record<string, unknown> = {};
      for (const [table, key] of tables) {
        // Keys and statuses: a second run may write the same row again (an upsert), never another one.
        rows[table] = (await rowsOf<Record<string, unknown>>(table, tenant.id, key)).map((row) => [
          row[key],
          row["status"],
        ]);
      }
      const { rows: offices } = await pool.query(
        "SELECT id, status, assigned_tenant_id FROM platform.amadeus_offices ORDER BY id",
      );
      return {
        tenant: (await tenantRow(tenant.id)).status,
        job: [job.status, job.result, job.reveal_ciphertext],
        offices,
        rows,
      };
    };
    const before = await snapshot();
    const db = worker.get<PlatformDb>(PLATFORM_DB, { strict: false });
    const jobs = worker.get(ProvisioningJobsRepository, { strict: false });
    const runAgain = (step: PostStep): Promise<PostStepOutcome> =>
      runInTransaction(db, async (trx) => {
        const job = await jobs.lockForPostStep(trx, jobId);
        if (job === undefined) {
          throw new Error(`no job ${jobId}`);
        }
        return step.run({ trx, job, event, now: t.clock.now() });
      });

    // The runner never runs a step the log holds; this is the steps' own guard (flows/provisioning.md §3, the
    // Idempotency column), for a log that lost an entry.
    for (const step of worker.get(PostStepsRunner, { strict: false }).steps) {
      if (step.name === "activate") {
        // The conditional update finds the job succeeded: the step refuses and its transaction rolls back.
        await expect(runAgain(step), step.name).rejects.toMatchObject({ code: "ACTIVATION_REFUSED" });
      } else {
        await expect(runAgain(step), step.name).resolves.toMatchObject({ status: "succeeded" });
      }
    }

    expect(await snapshot()).toEqual(before);
    expect(stepsOf(await jobRow(jobId))).toEqual(ALL_SUCCEEDED);
    expect(await mailpit.search({ to: owner.email })).toHaveLength(1);
  });

  it("[PBE-022 AC2] ignores an event of an older attempt: the job, the tenant and the pool stay as they are", async () => {
    const { offices } = await testPool(1);
    const arranged = await arrange(2);
    const { tenant, jobId } = arranged;
    const before = await jobRow(jobId);

    const id = await deliver(provisionedEvent(arranged), 1);
    const done = await finished(id);

    expect(await done.getState()).toBe("completed");
    expect(done.returnvalue).toEqual({
      outcome: "ignored",
      reason: "stale_attempt",
    } satisfies TenantEventOutcome);
    expect(await jobRow(jobId)).toEqual(before);
    expect((await tenantRow(tenant.id)).status).toBe("provisioning");
    expect(await rowsOf("supplier_connections", tenant.id)).toEqual([]);
    expect(await rowsOf("payment_provider_connections", tenant.id)).toEqual([]);
    expect(await rowsOf("api_keys", tenant.id)).toEqual([]);
    expect(await rowsOf("tenant_schema_migrations", tenant.id, "version")).toEqual([]);
    const { rows } = await pool.query("SELECT status FROM platform.amadeus_offices WHERE id = $1", [
      offices[0]?.id,
    ]);
    expect(rows).toEqual([{ status: "available" }]);
    expect(logLines("provisioning.event_ignored").find((line) => line["jobId"] === jobId)).toMatchObject({
      reason: "stale_attempt",
      attempt: 1,
      jobAttempt: 2,
      status: "running",
    });
  });
});

describe("the Amadeus office pool", () => {
  it("[PBE-022 AC3] gives two tenants provisioned at the same moment different offices", async () => {
    const { offices } = await testPool(3);
    const one = await arrange(1);
    const two = await arrange(1);

    // Both runs wait at the tenant's connection lock of assign_amadeus_office, right before they pick an office, and
    // pick at the same moment once the test lets them go.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      for (const { tenant } of [one, two]) {
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `platform.supplier_connections:${tenant.id}:amadeus:test`,
        ]);
      }
      await deliver(provisionedEvent(one), 1);
      await deliver(provisionedEvent(two), 1);
      await expect.poll(waitingOnLocks, { timeout: WAIT_MS, interval: 20 }).toBe(2);
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK");
      throw error;
    } finally {
      holder.release();
    }
    await provisioned(one.jobId);
    await provisioned(two.jobId);

    const officeOf = async ({ tenant }: Arranged): Promise<string[]> =>
      (await rowsOf<PlatformRow<"supplier_connections">>("supplier_connections", tenant.id)).flatMap(
        (row) => row.office_ids,
      );
    const assigned = [...(await officeOf(one)), ...(await officeOf(two))];
    expect(assigned).toHaveLength(2);
    expect(new Set(assigned).size).toBe(2);
    expect(assigned.sort()).toEqual([offices[0]?.office_id, offices[1]?.office_id].sort());
    const { rows } = await pool.query(
      "SELECT office_id, status, assigned_tenant_id FROM platform.amadeus_offices ORDER BY created_at",
    );
    expect(rows.map((row) => (row as { status: string }).status)).toEqual([
      "assigned",
      "assigned",
      "available",
    ]);
    expect(
      new Set(rows.slice(0, 2).map((row) => (row as { assigned_tenant_id: string }).assigned_tenant_id)),
    ).toEqual(new Set([one.tenant.id, two.tenant.id]));
  });

  it("[PBE-022 AC3] passes over an office another transaction holds instead of waiting for it (FOR UPDATE SKIP LOCKED)", async () => {
    const { offices } = await testPool(2);
    const arranged = await arrange(1);
    const [held, free] = offices;

    // Another provisioning is assigning the oldest office: the test's transaction holds its row until the end.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM platform.amadeus_offices WHERE id = $1 FOR UPDATE", [held?.id]);
      await deliver(provisionedEvent(arranged), 1);
      // Done while the lock is still held: the step never waited for it.
      await provisioned(arranged.jobId);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }

    expect(
      await rowsOf<PlatformRow<"supplier_connections">>("supplier_connections", arranged.tenant.id),
    ).toEqual([expect.objectContaining({ office_ids: [free?.office_id], status: "active" })]);
    const { rows } = await pool.query("SELECT id, status FROM platform.amadeus_offices ORDER BY created_at");
    expect(rows).toEqual([
      { id: held?.id, status: "available" },
      { id: free?.id, status: "assigned" },
    ]);
  });

  it("[PBE-022 AC3] activates the tenant with a pending_verification connection and e-mails ops when the pool is empty [PF-50 AC2]", async () => {
    const { account } = await testPool(0);
    // The only office of the pool is taken.
    const other = await insertTenant(pool, { id: nextId("ten"), key: `pooltaken${next}` });
    await insertAmadeusOffice(pool, account, {
      id: nextId("amo"),
      office_id: "PAR1A9999",
      status: "assigned",
      assigned_tenant_id: other.id,
      assigned_at: t.clock.now(),
    });
    const arranged = await arrange(1);
    const { tenant, jobId } = arranged;

    await deliver(provisionedEvent(arranged), 1);
    const job = await provisioned(jobId);

    expect((await tenantRow(tenant.id)).status).toBe("active");
    expect(stepsOf(job)).toEqual(ALL_SUCCEEDED);
    expect(job.result).not.toHaveProperty("officeId");
    expect(await rowsOf("supplier_connections", tenant.id)).toEqual([
      expect.objectContaining({
        credential_source: "velexis",
        amadeus_account_id: account.id,
        office_ids: [],
        default_office_id: null,
        status: "pending_verification",
      }),
    ]);
    expect(await auditOf(tenant.id, "amadeus_office.assigned")).toEqual([]);
    const alert = await waitForMessage({
      to: OPS_EMAIL,
      subject: `[Velexis ops] No Amadeus test office for the new OTA ${tenant.key}`,
      timeoutMs: WAIT_MS,
    });
    expect(alert.Text).toContain("No test office is available in the pool");
    expect(await emailsOf(tenant.id, "ops.alert")).toHaveLength(1);
  });

  it("waits for an office when the test account is not active, and skips the step without any account, e-mailing ops both times", async () => {
    await testPool(1, "invalid_credentials");
    const inactive = await arrange(1);
    await deliver(provisionedEvent(inactive), 1);
    await provisioned(inactive.jobId);

    expect(await rowsOf("supplier_connections", inactive.tenant.id)).toEqual([
      expect.objectContaining({ office_ids: [], status: "pending_verification" }),
    ]);
    const { rows } = await pool.query("SELECT status FROM platform.amadeus_offices");
    expect(rows).toEqual([{ status: "available" }]);

    await pool.query("DELETE FROM platform.supplier_connections");
    await pool.query("DELETE FROM platform.amadeus_offices");
    await pool.query("DELETE FROM platform.amadeus_accounts");
    const none = await arrange(1);
    await deliver(provisionedEvent(none), 1);
    const job = await provisioned(none.jobId);

    expect((await tenantRow(none.tenant.id)).status).toBe("active");
    expect(stepsOf(job)).toContain("assign_amadeus_office:skipped");
    expect(await rowsOf("supplier_connections", none.tenant.id)).toEqual([]);
    for (const { tenant } of [inactive, none]) {
      await waitForMessage({
        to: OPS_EMAIL,
        subject: `[Velexis ops] No Amadeus test office for the new OTA ${tenant.key}`,
        timeoutMs: WAIT_MS,
      });
    }
  });
});

describe("a crash between two steps", () => {
  it("[PBE-022 AC4] a crash injected after issue_api_keys resumes at activate on retry", async () => {
    await testPool(1);
    const arranged = await arrange(1);
    const { tenant, owner, jobId } = arranged;
    const activate = worker.get(ActivateStep, { strict: false });
    const issueApiKeys = worker.get(IssueApiKeysStep, { strict: false });
    const activateRun = vi
      .spyOn(activate, "run")
      .mockRejectedValueOnce(Object.assign(new Error("the worker process died"), { code: "CRASH_INJECTED" }));
    const issueRun = vi.spyOn(issueApiKeys, "run");

    // BullMQ tries the event again at once (the OTA worker's own options back off from 30 s).
    const id = await deliver(provisionedEvent(arranged), 1, {
      attempts: 2,
      backoff: { type: "fixed", delay: 0 },
    });
    const done = await finished(id);

    expect(await done.getState()).toBe("completed");
    // Two tries of the one BullMQ job: the first failed at activate, the second finished.
    expect(done.attemptsStarted).toBe(2);
    expect(done.returnvalue).toMatchObject({
      outcome: "completed",
      steps: [
        { step: "record_migrations", status: "done" },
        { step: "assign_amadeus_office", status: "done" },
        { step: "create_payment_connection", status: "done" },
        { step: "issue_api_keys", status: "done" },
        { step: "activate", status: "succeeded" },
        { step: "notify", status: "succeeded" },
      ],
    });
    expect(activateRun).toHaveBeenCalledTimes(2);
    expect(issueRun).toHaveBeenCalledTimes(1);
    const job = await provisioned(jobId);
    expect(stepsOf(job)).toEqual([
      ...OTA_PROVISIONING_STEPS.map((step) => `${step}:succeeded`),
      "record_migrations:succeeded",
      "assign_amadeus_office:succeeded",
      "create_payment_connection:succeeded",
      "issue_api_keys:succeeded",
      "activate:failed",
      "activate:succeeded",
      "notify:succeeded",
    ]);
    const failedEntry = (job.steps as Array<Record<string, unknown>>).find(
      (entry) => entry["status"] === "failed",
    );
    expect(failedEntry?.["error"]).toEqual({
      code: "CRASH_INJECTED",
      message: "The step failed (Error); the event is tried again.",
    });
    expect(job.error).toBeNull();
    const keys = await rowsOf<PlatformRow<"api_keys">>("api_keys", tenant.id, "kind");
    expect(keys).toHaveLength(2);
    expect(job.result).toMatchObject({ apiKeyIds: keys.map((key) => key.id) });
    expect((await tenantRow(tenant.id)).status).toBe("active");
    expect(await auditOf(tenant.id, "tenant.activated")).toHaveLength(1);
    expect(logLines("provisioning.post_step_failed").find((line) => line["jobId"] === jobId)).toMatchObject({
      step: "activate",
      code: "CRASH_INJECTED",
      attempt: 1,
    });
    await waitForMessage({ to: owner.email, timeoutMs: WAIT_MS });
  });

  it("[PBE-022 AC4] a crash injected after activate resumes at notify on retry: the welcome e-mail and the invalidations still go out", async () => {
    await testPool(1);
    const arranged = await arrange(1);
    const { tenant, owner, jobId } = arranged;
    const activateRun = vi.spyOn(worker.get(ActivateStep, { strict: false }), "run");
    // The job is `succeeded` once activate has committed; the crash comes before notify's transaction commits.
    const notifyRun = vi
      .spyOn(worker.get(NotifyStep, { strict: false }), "run")
      .mockRejectedValueOnce(Object.assign(new Error("the worker process died"), { code: "CRASH_INJECTED" }));

    const id = await deliver(provisionedEvent(arranged), 1, {
      attempts: 2,
      backoff: { type: "fixed", delay: 0 },
    });
    const done = await finished(id);

    expect(await done.getState()).toBe("completed");
    expect(done.attemptsStarted).toBe(2);
    // The second try passes the five steps the log holds and runs notify on the succeeded job.
    expect(done.returnvalue).toEqual({
      outcome: "completed",
      steps: [
        { step: "record_migrations", status: "done" },
        { step: "assign_amadeus_office", status: "done" },
        { step: "create_payment_connection", status: "done" },
        { step: "issue_api_keys", status: "done" },
        { step: "activate", status: "done" },
        { step: "notify", status: "succeeded" },
      ],
    } satisfies TenantEventOutcome);
    expect(activateRun).toHaveBeenCalledTimes(1);
    expect(notifyRun).toHaveBeenCalledTimes(2);
    const job = await provisioned(jobId);
    expect(stepsOf(job)).toEqual([...ALL_SUCCEEDED.slice(0, -1), "notify:failed", "notify:succeeded"]);
    // The failure is history once notify went through: the succeeded job shows no error.
    expect(job).toMatchObject({ status: "succeeded", error: null });
    expect((await tenantRow(tenant.id)).status).toBe("active");
    expect(await auditOf(tenant.id, "tenant.activated")).toHaveLength(1);
    await invalidated([
      { v: 1, type: "tenant", id: tenant.id },
      { v: 1, type: "connection", tenantId: tenant.id },
    ]);
    expect(await emailsOf(tenant.id, "tenant.welcome")).toHaveLength(1);
    await waitForMessage({ to: owner.email, timeoutMs: WAIT_MS });
  });
});
