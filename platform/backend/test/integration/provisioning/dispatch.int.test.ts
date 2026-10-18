// The dispatch of provisioning jobs (PBE-019; platform/docs/flows/provisioning.md §1, PADR-0001 items 2 to 4 and 8) on
// this file's database clone and Redis database (createTestApp): one `running` row and one BullMQ job however many
// dispatches race, nothing while the gate is closed, the message on `ota-tenant-ops` valid against the PBE-004 schema,
// createTenant dispatching right after its commit, and the fake OTA worker (test/support/fake-ota-worker.ts, PADR-0017
// item 1) answering every message with events that are valid too. Jobs and tenants are written with the builders;
// "now" is the application's FakeClock, which the dispatch reads.
//
// Concurrency is made deterministic as in create-tenant.int.test.ts: a transaction of the test holds the job's row
// while the dispatches start, and lets it go once every dispatch waits for the lock.
import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import {
  OTA_TENANT_OPS,
  PLATFORM_TENANT_EVENTS,
  validateJob,
  type TenantEvent,
  type TenantOpsJob,
} from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker, TEST_TENANTS } from "@velexis/testing";
import type { Job, Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  DISPATCH_LEASE_MS,
  ProvisioningDispatcher,
  type DispatchResult,
} from "../../../src/provisioning/dispatcher";
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
import { createTestApp, type TestApp } from "../../support/app";
import {
  FAKE_TENANT_LEDGER,
  FakeOtaWorker,
  schemaNamesFrom,
  type FakeOtaHandled,
  type FakeOtaOutcome,
} from "../../support/fake-ota-worker";

/** Starting the API on a database clone (Nest module graph, Ajv validators) takes seconds; bounded for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** Documentation address (RFC 5737). */
const PERSON_IP = "203.0.113.7";
/** A zone of the reference data for createTenant; the fixture of @velexis/testing has none, beforeAll adds it. */
const TIME_ZONE = "Europe/Paris";
/** Every state a BullMQ job can be in. */
const ALL_STATES = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "paused",
  "waiting-children",
  "completed",
  "failed",
] as const;

let t: TestApp;
let pool: PlatformPool;
let dispatcher: ProvisioningDispatcher;
let tenantOps: Queue;
let tenantEvents: Queue;
let nextJob = 1;

beforeAll(async () => {
  // Expensive set-up, once per file: the database clone, the Nest module graph, the platform document that
  // expectResponseToMatch parses on its first use, and the Ajv validators of the job messages (validateJob compiles
  // them on its first call). 60 s covers a slow CI runner.
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  dispatcher = t.app.get(ProvisioningDispatcher, { strict: false });
  tenantOps = t.app.get<Queue>(getQueueToken(OTA_TENANT_OPS), { strict: false });
  tenantEvents = t.app.get<Queue>(getQueueToken(PLATFORM_TENANT_EVENTS), { strict: false });
  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ($1, 'FR', 60, 120)",
    [TIME_ZONE],
  );
  responseChecker("platform");
  validateJob("tenant.provision", provisionFixture);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

interface ArrangeOptions {
  readonly tenant?: Partial<TenantRow>;
  /** The tenant's subscription; `null` for none. Default: a manual trial. */
  readonly subscription?: Partial<SubscriptionRow> | null;
  readonly job?: Partial<PlatformInsert<"provisioning_jobs">>;
}

interface Arranged {
  readonly tenant: PlatformRow<"tenants">;
  readonly jobId: string;
}

/**
 * A `provisioning` tenant with a manual trial and a `provision` job, `queued` with no attempt made and due at the
 * FakeClock's time, unless `options` say otherwise.
 */
async function arrange(options: ArrangeOptions = {}): Promise<Arranged> {
  const tenant = await insertTenant(pool, { status: "provisioning", activated_at: null, ...options.tenant });
  if (options.subscription !== null) {
    await insertSubscription(pool, tenant, options.subscription ?? {});
  }
  const jobId = testId("job", nextJob);
  nextJob += 1;
  await insertRow(pool, "provisioning_jobs", {
    id: jobId,
    tenant_id: tenant.id,
    kind: "provision",
    status: "queued",
    attempt: 0,
    scheduled_at: t.clock.now(),
    ...options.job,
  });
  return { tenant, jobId };
}

async function jobRow(jobId: string): Promise<PlatformRow<"provisioning_jobs">> {
  const { rows } = await pool.query("SELECT * FROM platform.provisioning_jobs WHERE id = $1", [jobId]);
  expect(rows).toHaveLength(1);
  return rows[0] as PlatformRow<"provisioning_jobs">;
}

/** The BullMQ jobs on `ota-tenant-ops` of provisioning job `jobId`, in any state, by id. */
async function bullmqJobsOf(jobId: string): Promise<Job[]> {
  const jobs = await tenantOps.getJobs([...ALL_STATES]);
  return jobs
    .filter((job) => job.id?.startsWith(`${jobId}-`) === true)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** How many sessions of this file's database wait for a lock. */
async function waitingOnLocks(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(DISTINCT l.pid)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
      "WHERE NOT l.granted AND a.datname = current_database()",
  );
  return (rows[0] as { waiting: number }).waiting;
}

/**
 * Runs `count` dispatches of `jobId` while a transaction of the test holds the job's row (`FOR UPDATE`), and lets it
 * go once every dispatch waits for the lock, so they overlap however fast each one is.
 */
async function concurrentDispatches(jobId: string, count: number): Promise<DispatchResult[]> {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM platform.provisioning_jobs WHERE id = $1 FOR UPDATE", [jobId]);
    const results = Promise.all(Array.from({ length: count }, () => dispatcher.dispatch(jobId)));
    // Awaited below; a failure before then must not count as unhandled.
    void results.catch(() => undefined);
    await expect.poll(waitingOnLocks, { timeout: 10_000, interval: 20 }).toBe(count);
    await holder.query("COMMIT");
    return await results;
  } catch (error) {
    await holder.query("ROLLBACK");
    throw error;
  } finally {
    holder.release();
  }
}

/** `dispatched <attempt>` or the reason a dispatch changed nothing. */
function outcomeOf(result: DispatchResult): string {
  return result.dispatched ? `dispatched ${result.attempt}` : result.reason;
}

describe("dispatch", () => {
  it("[PBE-019 AC1] gives one running row and one BullMQ job <jobId>-1 for two concurrent dispatches", async () => {
    const { tenant, jobId } = await arrange();
    const now = t.clock.now();

    const results = await concurrentDispatches(jobId, 2);

    expect(results.map(outcomeOf).sort()).toEqual(["dispatched 1", "not_queued"]);
    expect(results.find((result) => result.dispatched)).toEqual({
      dispatched: true,
      jobId,
      tenantId: tenant.id,
      kind: "provision",
      attempt: 1,
      bullmqJobId: `${jobId}-1`,
      enqueued: true,
    });
    expect(await jobRow(jobId)).toMatchObject({
      status: "running",
      attempt: 1,
      step: "dispatch",
      started_at: now,
      locked_until: new Date(now.getTime() + DISPATCH_LEASE_MS),
      updated_at: now,
      finished_at: null,
    });
    const jobs = await bullmqJobsOf(jobId);
    expect(jobs.map((job) => [job.id, job.name])).toEqual([[`${jobId}-1`, "tenant.provision"]]);
    expect(jobs[0]?.opts).toMatchObject({
      jobId: `${jobId}-1`,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
    });

    // A later dispatch of the running job adds nothing either.
    expect(outcomeOf(await dispatcher.dispatch(jobId))).toBe("not_queued");
    expect((await bullmqJobsOf(jobId)).map((job) => job.id)).toEqual([`${jobId}-1`]);
  });

  it("[PBE-019 AC1] dispatches a job re-queued after a failed attempt as attempt 2, BullMQ job <jobId>-2, keeping its first start", async () => {
    const firstStart = new Date(t.clock.now().getTime() - 60 * 60 * 1000);
    const { jobId } = await arrange({
      job: {
        attempt: 1,
        started_at: firstStart,
        scheduled_at: new Date(t.clock.now().getTime() - 1000),
        error: "LOCK_TIMEOUT",
      },
    });

    const results = await concurrentDispatches(jobId, 3);

    expect(results.map(outcomeOf).sort()).toEqual(["dispatched 2", "not_queued", "not_queued"]);
    expect(await jobRow(jobId)).toMatchObject({ status: "running", attempt: 2, started_at: firstStart });
    expect((await bullmqJobsOf(jobId)).map((job) => job.id)).toEqual([`${jobId}-2`]);
  });

  it("[PBE-019 AC2] dispatches nothing while the gate is closed: a Stripe subscription incomplete or past due, none at all, or a tenant that is not provisioning", async () => {
    const closed = [
      await arrange({ subscription: { status: "incomplete", billing_provider: "stripe" } }),
      await arrange({ subscription: { status: "past_due", billing_provider: "stripe" } }),
      await arrange({ subscription: null }),
      await arrange({ subscription: { status: "canceled", billing_provider: "stripe" } }),
      await arrange({ tenant: { status: "failed" } }),
    ];

    const results = [];
    for (const { jobId } of closed) {
      results.push(outcomeOf(await dispatcher.dispatch(jobId)));
    }

    expect(results).toEqual(["gate_closed", "gate_closed", "gate_closed", "gate_closed", "gate_closed"]);
    for (const { jobId } of closed) {
      expect(await jobRow(jobId)).toMatchObject({
        status: "queued",
        attempt: 0,
        step: null,
        started_at: null,
        locked_until: null,
      });
      expect(await bullmqJobsOf(jobId)).toEqual([]);
    }
    expect(t.logs.withMessage("provisioning.not_dispatched").map((line) => line["reason"])).toContain(
      "gate_closed",
    );
  });

  it("[PBE-019 AC2] opens the gate for a Stripe subscription that is trialing or active, as the Checkout webhook will leave it", async () => {
    const open = [
      await arrange({ subscription: { status: "trialing", billing_provider: "stripe" } }),
      await arrange({ subscription: { status: "active", billing_provider: "stripe" } }),
    ];

    for (const { jobId } of open) {
      expect(outcomeOf(await dispatcher.dispatch(jobId))).toBe("dispatched 1");
      expect((await bullmqJobsOf(jobId)).map((job) => job.id)).toEqual([`${jobId}-1`]);
    }
  });

  it("waits until the job is due: scheduled_at after now dispatches nothing, and the same job goes out once the clock has passed it", async () => {
    const { jobId } = await arrange({ job: { scheduled_at: new Date(t.clock.now().getTime() + 60_000) } });

    expect(outcomeOf(await dispatcher.dispatch(jobId))).toBe("not_due");
    expect(await bullmqJobsOf(jobId)).toEqual([]);

    t.clock.advance(60_000);

    expect(outcomeOf(await dispatcher.dispatch(jobId))).toBe("dispatched 1");
    expect((await jobRow(jobId)).status).toBe("running");
  });

  it("[PBE-019 AC3] puts a tenant.provision message on ota-tenant-ops that validates against the PBE-004 schema", async () => {
    const { tenant, jobId } = await arrange();
    const requestId = `dispatch-${randomUUID()}`;

    await dispatcher.dispatch(jobId, { requestId });

    const [job] = await bullmqJobsOf(jobId);
    expect(job?.name).toBe("tenant.provision");
    const message = validateJob("tenant.provision", job?.data);
    expect(message).toEqual({
      v: 1,
      name: "tenant.provision",
      jobId,
      tenantId: tenant.id,
      requestedAt: t.clock.now().toISOString(),
      requestId,
      payload: {},
    });
  });

  it("[PBE-019 AC3] sends the migrate, suspend and resume jobs of an active tenant with their payloads, valid messages too, without a gate", async () => {
    const migrate = await arrange({
      tenant: { status: "active" },
      subscription: { status: "incomplete", billing_provider: "stripe" },
      job: { kind: "migrate", payload: { targetVersion: "0002_add_mvp_tenant_deltas" } },
    });
    const suspend = await arrange({
      tenant: { status: "suspended", suspension_reason: "admin", suspended_at: t.clock.now() },
      job: { kind: "suspend", payload: { reason: "admin" } },
    });
    const resume = await arrange({
      tenant: { status: "active" },
      subscription: null,
      job: { kind: "resume" },
    });

    const messages: TenantOpsJob[] = [];
    for (const { jobId } of [migrate, suspend, resume]) {
      expect(outcomeOf(await dispatcher.dispatch(jobId))).toBe("dispatched 1");
      const [job] = await bullmqJobsOf(jobId);
      messages.push(validateJob(String(job?.name) as TenantOpsJob["name"], job?.data) as TenantOpsJob);
    }

    expect(messages.map((message) => [message.name, message.payload])).toEqual([
      ["tenant.migrate", { targetVersion: "0002_add_mvp_tenant_deltas" }],
      ["tenant.suspend", { reason: "admin" }],
      ["tenant.resume", {}],
    ]);
  });

  it("refuses a job whose payload is not a valid message, and leaves it queued", async () => {
    const { jobId } = await arrange({ job: { payload: { clientSecret: "not-a-real-secret" } } });

    await expect(dispatcher.dispatch(jobId)).rejects.toThrow(/\/payload\/clientSecret/);

    expect(await jobRow(jobId)).toMatchObject({ status: "queued", attempt: 0, step: null });
    expect(await bullmqJobsOf(jobId)).toEqual([]);
  });
});

describe("createTenant", () => {
  let tokens: TokenService;

  beforeAll(() => {
    tokens = t.app.get(TokenService);
  });

  async function create(
    key: string,
  ): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    const founder = await insertAccount(pool);
    const { token } = await tokens.sign({
      aud: "portal",
      sub: founder.id,
      sid: testId("asn", 1),
      ev: true,
      amr: ["pwd"],
    });
    return t.http
      .post("/v1/tenants")
      .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) })
      .set("Idempotency-Key", randomUUID())
      .send({ key, name: "Acme Travel", countryCode: "FR", defaultCurrency: "EUR", timeZone: TIME_ZONE });
  }

  it("dispatches the provision job right after the commit: the answer shows it running, and tenant.provision carries the request's id", async () => {
    const now = t.clock.now();

    const res = await create("dispatchedota");

    expect(res.status).toBe(202);
    expectResponseToMatch("createTenant", res, { document: "platform" });
    const { tenant, provisioningJob } = res.body as {
      tenant: { id: string };
      provisioningJob: { id: string; status: string };
    };
    expect(provisioningJob.status).toBe("running");
    expect(await jobRow(provisioningJob.id)).toMatchObject({
      tenant_id: tenant.id,
      status: "running",
      attempt: 1,
      step: "dispatch",
      started_at: now,
      locked_until: new Date(now.getTime() + DISPATCH_LEASE_MS),
    });
    const jobs = await bullmqJobsOf(provisioningJob.id);
    expect(jobs.map((job) => job.id)).toEqual([`${provisioningJob.id}-1`]);
    expect(validateJob("tenant.provision", jobs[0]?.data)).toMatchObject({
      jobId: provisioningJob.id,
      tenantId: tenant.id,
      requestId: res.headers["x-request-id"],
    });
  });

  it("answers 202 with the job queued for the reconciler when the dispatch fails after the commit", async () => {
    vi.spyOn(dispatcher, "dispatch").mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    const res = await create("undispatchedota");

    expect(res.status).toBe(202);
    expectResponseToMatch("createTenant", res, { document: "platform" });
    const { provisioningJob } = res.body as { provisioningJob: { id: string; status: string } };
    expect(provisioningJob.status).toBe("queued");
    expect(await jobRow(provisioningJob.id)).toMatchObject({ status: "queued", attempt: 0 });
    expect(await bullmqJobsOf(provisioningJob.id)).toEqual([]);
    expect(
      t.logs.withMessage("provisioning.dispatch_failed").map((line) => [line["level"], line["jobId"]]),
    ).toEqual([[40, provisioningJob.id]]);
  });

  it("answers 202 with the job running when Redis refuses the add: the reconciler finds it after the lease", async () => {
    vi.spyOn(tenantOps, "add").mockRejectedValueOnce(new Error("Connection is closed."));

    const res = await create("unqueuedota");

    expect(res.status).toBe(202);
    const { provisioningJob } = res.body as { provisioningJob: { id: string; status: string } };
    expect(provisioningJob.status).toBe("running");
    expect(await jobRow(provisioningJob.id)).toMatchObject({ status: "running", attempt: 1 });
    expect(await bullmqJobsOf(provisioningJob.id)).toEqual([]);
    expect(
      t.logs.withMessage("provisioning.enqueue_failed").map((line) => [line["level"], line["bullmqJobId"]]),
    ).toEqual([[40, `${provisioningJob.id}-1`]]);
  });
});

describe("with the fake OTA worker", () => {
  let fake: FakeOtaWorker;

  beforeAll(async () => {
    // Earlier tests left messages nobody took; the fake starts on an empty queue so it answers this block's only.
    await tenantOps.drain(true);
    // Connecting the worker and its event queue to Redis; bounded for a loaded CI runner.
    fake = await FakeOtaWorker.start({
      redisUrl: t.redis.url,
      schemaNameOf: schemaNamesFrom(pool),
      now: () => t.clock.now(),
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await fake?.close();
  }, SETUP_TIMEOUT_MS);

  /** Waits until the fake has taken the message of BullMQ job `bullmqJobId`, and returns what it did. */
  async function handledFor(bullmqJobId: string): Promise<FakeOtaHandled> {
    const handled = await fake.waitForHandled((all) =>
      all.some((entry) => entry.bullmqJobId === bullmqJobId),
    );
    const entry = handled.find((candidate) => candidate.bullmqJobId === bullmqJobId);
    if (entry === undefined) {
      throw new Error(`the fake OTA worker did not take ${bullmqJobId}`);
    }
    return entry;
  }

  /** The event on `platform-tenant-events` with BullMQ id `id`, checked against its JSON Schema. */
  async function eventOf(id: string): Promise<TenantEvent | undefined> {
    const job = await tenantEvents.getJob(id);
    return job === undefined
      ? undefined
      : (validateJob(job.name as TenantEvent["name"], job.data) as TenantEvent);
  }

  /** The state of BullMQ job `id` on `ota-tenant-ops` once the fake is done with it. */
  async function finalState(id: string): Promise<string> {
    let state = "unknown";
    await expect
      .poll(
        async () => {
          state = String(await (await tenantOps.getJob(id))?.getState());
          return state === "completed" || state === "failed";
        },
        { timeout: 10_000, interval: 20 },
      )
      .toBe(true);
    return state;
  }

  async function dispatchWith(outcome: FakeOtaOutcome, options: ArrangeOptions = {}): Promise<Arranged> {
    const arranged = await arrange(options);
    fake.setOutcome(arranged.tenant.id, outcome);
    expect(outcomeOf(await dispatcher.dispatch(arranged.jobId))).toBe("dispatched 1");
    return arranged;
  }

  it("[PBE-019 AC3] answers a provisioned tenant with tenant.provisioned and a fake ledger of two migrations, valid against the PBE-004 schema", async () => {
    const { tenant, jobId } = await dispatchWith({ type: "provisioned" });

    const handled = await handledFor(`${jobId}-1`);
    const event = await eventOf(`${jobId}-1`);

    expect(event).toEqual(handled.answer);
    expect(event).toEqual({
      v: 1,
      name: "tenant.provisioned",
      jobId,
      tenantId: tenant.id,
      requestedAt: t.clock.now().toISOString(),
      requestId: handled.message.requestId,
      payload: {
        schemaName: tenant.schema_name,
        schemaVersion: "0002_add_mvp_tenant_deltas",
        migrations: FAKE_TENANT_LEDGER.map((entry) => ({ ...entry, appliedAt: t.clock.now().toISOString() })),
        steps: ["create_schema", "run_migrations", "seed_defaults"].map((step) => ({
          step,
          status: "succeeded",
          startedAt: t.clock.now().toISOString(),
          finishedAt: t.clock.now().toISOString(),
        })),
      },
    });
    expect(event?.name === "tenant.provisioned" ? event.payload.migrations : []).toHaveLength(2);
    expect(await finalState(`${jobId}-1`)).toBe("completed");
  });

  it("[PBE-019 AC3] answers tenant.provision_failed with retryable true or false, valid events, and fails the BullMQ job", async () => {
    const retryable = await dispatchWith({ type: "failed", retryable: true });
    const permanent = await dispatchWith({ type: "failed", retryable: false });

    const answers = [];
    for (const { jobId } of [retryable, permanent]) {
      await handledFor(`${jobId}-1`);
      const event = await eventOf(`${jobId}-1`);
      expect(event?.name).toBe("tenant.provision_failed");
      answers.push(event?.name === "tenant.provision_failed" ? event.payload : undefined);
      expect(await finalState(`${jobId}-1`)).toBe("failed");
    }

    expect(answers.map((payload) => [payload?.retryable, payload?.error.code])).toEqual([
      [true, "LOCK_TIMEOUT"],
      [false, "CHECKSUM_MISMATCH"],
    ]);
    expect(answers[0]?.steps.map(({ step, status }) => `${step}:${status}`)).toEqual([
      "create_schema:succeeded",
      "run_migrations:failed",
    ]);
  });

  it("stays silent when told to: no event, and the BullMQ job fails without one, as a lost message looks to the reconciler", async () => {
    const { jobId } = await dispatchWith({ type: "silent" });

    const handled = await handledFor(`${jobId}-1`);

    expect(handled.answer).toBeNull();
    expect(await finalState(`${jobId}-1`)).toBe("failed");
    expect(await tenantEvents.getJob(`${jobId}-1`)).toBeUndefined();
  });

  it("[PBE-019 AC3] answers migrate, suspend and resume with tenant.migrated, tenant.suspended and tenant.resumed, and a failed migrate with tenant.migration_failed, all valid", async () => {
    const migrated = await dispatchWith(
      { type: "provisioned" },
      { tenant: { status: "active" }, job: { kind: "migrate", payload: { targetVersion: "0001_baseline" } } },
    );
    const migrationFailed = await dispatchWith(
      { type: "failed", retryable: true },
      { tenant: { status: "active" }, job: { kind: "migrate" } },
    );
    const suspended = await dispatchWith(
      { type: "provisioned" },
      {
        tenant: { status: "suspended", suspension_reason: "admin" },
        job: { kind: "suspend", payload: { reason: "admin" } },
      },
    );
    const resumed = await dispatchWith(
      { type: "provisioned" },
      { tenant: { status: "active" }, job: { kind: "resume" } },
    );

    const events: Array<TenantEvent | undefined> = [];
    for (const { jobId } of [migrated, migrationFailed, suspended, resumed]) {
      await handledFor(`${jobId}-1`);
      events.push(await eventOf(`${jobId}-1`));
    }

    expect(events.map((event) => event?.name)).toEqual([
      "tenant.migrated",
      "tenant.migration_failed",
      "tenant.suspended",
      "tenant.resumed",
    ]);
    expect(events[0]?.payload).toMatchObject({
      schemaVersion: "0001_baseline",
      migrations: [expect.objectContaining({ version: "0001_baseline" })],
    });
    expect(events[1]?.payload).toMatchObject({
      version: "0002_add_mvp_tenant_deltas",
      error: { code: "LOCK_TIMEOUT" },
      retryable: true,
    });
  });

  it("answers the job of a new OTA from createTenant end to end, never touching a tenant schema, and finds no invalid message", async () => {
    const founder = await insertAccount(pool);
    const { token } = await t.app.get(TokenService).sign({
      aud: "portal",
      sub: founder.id,
      sid: testId("asn", 2),
      ev: true,
      amr: ["pwd"],
    });

    const res = await t.http
      .post("/v1/tenants")
      .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) })
      .set("Idempotency-Key", randomUUID())
      .send({
        key: "fakeworkerota",
        name: "Acme Travel",
        countryCode: "FR",
        defaultCurrency: "EUR",
        timeZone: TIME_ZONE,
      });

    expect(res.status).toBe(202);
    const { provisioningJob } = res.body as { provisioningJob: { id: string } };
    const handled = await handledFor(`${provisioningJob.id}-1`);
    expect(handled.message.requestId).toBe(res.headers["x-request-id"]);
    expect(await eventOf(`${provisioningJob.id}-1`)).toMatchObject({
      name: "tenant.provisioned",
      jobId: provisioningJob.id,
      requestId: res.headers["x-request-id"],
      payload: { schemaName: "tenant_fakeworkerota" },
    });

    // The only tenant schemas are the two of the test database's template: the fake created none.
    const { rows } = await pool.query(
      "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%' ORDER BY nspname",
    );
    expect(rows.map((row) => (row as { nspname: string }).nspname)).toEqual([...TEST_TENANTS]);
    expect(fake.invalid).toEqual([]);
    expect(fake.errors).toEqual([]);
  });
});
