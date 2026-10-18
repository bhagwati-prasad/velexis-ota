// The setup progress and the one-time reveal of the initial test keys (PBE-023; platform/docs/flows/provisioning.md §4,
// scope PF-11 AC1 and AC3, PADR-0005) on this file's database clone and Redis database: an owner creates an OTA through
// the API (createTestApp), the fake OTA worker (test/support/fake-ota-worker.ts) answers `tenant.provisioned`, and the
// worker's module graph (WorkerModule with the API's FakeClock) runs the post-steps that issue the two test keys and
// keep them envelope-encrypted for their reveal. The portal then reads the progress and reveals the keys; the hourly
// purge (`PurgeRevealsScheduler.run`, run by the tests) erases what was not revealed in time.
//
// Every test creates OTAs of its own with founders of its own (`uniqueEmail`). The FakeClock only moves forward, so a
// test that moves it 24 hours ahead mints its tokens afterwards.
import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { OTA_PROVISIONING_STEPS, validateJob } from "@velexis/api-types/jobs";
import { hashApiKey } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail } from "@velexis/testing/mailpit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY_PEPPER } from "../../../src/api-keys/api-key-generator";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { POST_STEP_NAMES } from "../../../src/provisioning/post-steps/post-steps.runner";
import { PurgeRevealsScheduler, REVEAL_WINDOW_MS } from "../../../src/provisioning/purge-reveals.scheduler";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertRow,
  insertSubscription,
  insertTenant,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FakeOtaWorker, schemaNamesFrom } from "../../support/fake-ota-worker";

/** Starting the API, the worker's module graph and the fake OTA worker takes seconds; bounded for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker. */
const WAIT_MS = 20_000;
/** Documentation address (RFC 5737). */
const PERSON_IP = "203.0.113.7";
/** A zone of the reference data for createTenant; the fixture of @velexis/testing has none, beforeAll adds it. */
const TIME_ZONE = "Europe/Paris";

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let fake: FakeOtaWorker;
let purge: PurgeRevealsScheduler;
const workerLogs = new LogSink();
let next = 1;

beforeAll(async () => {
  // Expensive set-up, once per file: the database clone, the API's and the worker's Nest module graphs, the fake OTA
  // worker's Redis connections, the platform document that expectResponseToMatch parses on its first use, and the Ajv
  // validators of the job messages (validateJob compiles them on its first call). 60 s covers a slow CI runner.
  t = await createTestApp({ env: { OPS_ALERT_EMAIL: uniqueEmail("ops-reveal") } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ($1, 'FR', 60, 120)",
    [TIME_ZONE],
  );
  responseChecker("platform");
  validateJob("tenant.provision", {
    v: 1,
    name: "tenant.provision",
    jobId: testId("job", 1),
    tenantId: testId("ten", 1),
    requestedAt: t.clock.now().toISOString(),
    requestId: "warm-up-request-id",
    payload: {},
  });

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .compile();
  await worker.init();
  purge = worker.get(PurgeRevealsScheduler, { strict: false });

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

// ---- Arrangement --------------------------------------------------------------------------------------------------

async function headersFor(account: { readonly id: string }): Promise<Record<string, string>> {
  const { token } = await t.app.get(TokenService).sign({
    aud: "portal",
    sub: account.id,
    sid: testId("asn", 3000 + next++),
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

interface Provisioned {
  readonly owner: PlatformRow<"accounts">;
  readonly tenantId: string;
  readonly jobId: string;
}

/** An OTA that an owner of its own created through the API, once its setup has finished (the job is `succeeded`). */
async function provisionedOta(): Promise<Provisioned> {
  const n = next++;
  const owner = await insertAccount(pool, {
    id: testId("acc", 3000 + n),
    email: uniqueEmail(`reveal-owner${n}`),
    full_name: `Owner ${n}`,
  });
  const res = await t.http
    .post("/v1/tenants")
    .set(await headersFor(owner))
    .set("Idempotency-Key", randomUUID())
    .send({
      key: `revealota${n}`,
      name: `Reveal ${n} Travel`,
      countryCode: "FR",
      defaultCurrency: "EUR",
      timeZone: TIME_ZONE,
    });
  expect(res.status).toBe(202);
  const { tenant, provisioningJob } = res.body as { tenant: { id: string }; provisioningJob: { id: string } };
  await expect
    .poll(
      async () => {
        const job = await jobRow(provisioningJob.id);
        return `${job.status}/${job.step ?? ""}`;
      },
      { timeout: WAIT_MS, interval: 20 },
    )
    .toBe("succeeded/notify");
  return { owner, tenantId: tenant.id, jobId: provisioningJob.id };
}

async function jobRow(jobId: string): Promise<PlatformRow<"provisioning_jobs">> {
  const { rows } = await pool.query("SELECT * FROM platform.provisioning_jobs WHERE id = $1", [jobId]);
  return rows[0] as PlatformRow<"provisioning_jobs">;
}

async function keysOf(tenantId: string): Promise<Array<PlatformRow<"api_keys">>> {
  const { rows } = await pool.query("SELECT * FROM platform.api_keys WHERE tenant_id = $1 ORDER BY kind", [
    tenantId,
  ]);
  return rows as Array<PlatformRow<"api_keys">>;
}

async function auditOf(tenantId: string, action: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id",
    [tenantId, action],
  );
  return rows as Array<Record<string, unknown>>;
}

function reveal(tenantId: string, headers: Record<string, string>) {
  return t.http.post(`/v1/tenants/${tenantId}/initial-keys/reveal`).set(headers);
}

function progress(tenantId: string, headers: Record<string, string>) {
  return t.http.get(`/v1/tenants/${tenantId}/provisioning`).set(headers);
}

// ---- Tests --------------------------------------------------------------------------------------------------------

describe("getProvisioning", () => {
  it("[PBE-023 AC1] the progress endpoint shows the steps and active once done [PF-11 AC1]", async () => {
    const { owner, tenantId, jobId } = await provisionedOta();
    const viewer = await insertAccount(pool, { id: testId("acc", 3500 + next++) });
    await insertMember(pool, { id: tenantId }, viewer, "viewer");

    for (const member of [owner, viewer]) {
      const res = await progress(tenantId, await headersFor(member));

      expect(res.status).toBe(200);
      expectResponseToMatch("getProvisioning", res, { document: "platform" });
      const body = res.body as { job: { steps: Array<{ step: string; status: string }> } };
      expect(res.body).toMatchObject({
        tenantStatus: "active",
        job: {
          id: jobId,
          kind: "provision",
          status: "succeeded",
          step: "notify",
          attempt: 1,
          maxAttempts: 5,
          error: null,
        },
        initialKeysAvailable: true,
      });
      expect(body.job.steps.map(({ step }) => step)).toEqual([...OTA_PROVISIONING_STEPS, ...POST_STEP_NAMES]);
      expect(body.job.steps.filter(({ status }) => status === "failed")).toEqual([]);
    }
  });

  it("[PBE-023 AC1] shows a setup under way, step by step, and answers 404 to a non-member", async () => {
    const n = next++;
    const owner = await insertAccount(pool, { id: testId("acc", 3000 + n) });
    const tenant = await insertTenant(pool, {
      id: testId("ten", 3000 + n),
      key: `underway${n}`,
      status: "provisioning",
      activated_at: null,
    });
    await insertMember(pool, tenant, owner, "owner");
    await insertSubscription(pool, tenant, { id: testId("sub", 3000 + n) });
    const now = t.clock.now();
    const at = now.toISOString();
    const jobId = testId("job", 3000 + n);
    await insertRow(pool, "provisioning_jobs", {
      id: jobId,
      tenant_id: tenant.id,
      kind: "provision",
      status: "running",
      attempt: 2,
      step: "record_migrations",
      steps: [
        { step: "create_schema", status: "succeeded", startedAt: at, finishedAt: at },
        {
          step: "run_migrations",
          status: "failed",
          startedAt: at,
          finishedAt: at,
          error: { code: "LOCK_TIMEOUT", message: "canceling statement due to lock timeout" },
        },
        ...OTA_PROVISIONING_STEPS.map((step) => ({
          step,
          status: "succeeded",
          startedAt: at,
          finishedAt: at,
        })),
        { step: "record_migrations", status: "succeeded", startedAt: at, finishedAt: at },
      ],
      error: "run_migrations failed: LOCK_TIMEOUT: canceling statement due to lock timeout",
      scheduled_at: now,
      started_at: now,
      locked_until: new Date(now.getTime() + 15 * 60_000),
    });

    const res = await progress(tenant.id, await headersFor(owner));

    expect(res.status).toBe(200);
    expectResponseToMatch("getProvisioning", res, { document: "platform" });
    expect(res.body).toEqual({
      tenantStatus: "provisioning",
      job: {
        id: jobId,
        kind: "provision",
        status: "running",
        step: "record_migrations",
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "run_migrations",
            status: "failed",
            error: expect.any(Object) as unknown,
          }),
        ]) as unknown,
        attempt: 2,
        maxAttempts: 5,
        error: "run_migrations failed: LOCK_TIMEOUT: canceling statement due to lock timeout",
      },
      initialKeysAvailable: false,
    });
    expect((res.body as { job: { steps: unknown[] } }).job.steps).toHaveLength(6);

    // Nothing to reveal yet.
    expect((await reveal(tenant.id, await headersFor(owner))).status).toBe(404);

    const stranger = await insertAccount(pool, { id: testId("acc", 3500 + next++) });
    const hidden = await progress(tenant.id, await headersFor(stranger));
    expect(hidden.status).toBe(404);
    expect(hidden.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("revealInitialKeys", () => {
  it("[PBE-023 AC5] the keys are revealed once; a second reveal answers 410 [PF-11 AC3]", async () => {
    const { owner, tenantId, jobId } = await provisionedOta();
    const headers = await headersFor(owner);

    const res = await reveal(tenantId, headers);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectResponseToMatch("revealInitialKeys", res, { document: "platform" });
    const { keys } = res.body as { keys: Array<{ id: string; kind: string; prefix: string; key: string }> };
    const rows = await keysOf(tenantId);
    expect(keys.map(({ id, kind, prefix }) => ({ id, kind, prefix }))).toEqual(
      rows.map(({ id, kind, prefix }) => ({ id, kind, prefix })),
    );
    const pepper = t.app.get<Buffer>(API_KEY_PEPPER, { strict: false });
    expect(keys.map(({ key }) => hashApiKey(key, pepper))).toEqual(rows.map((row) => row.key_hash));
    // In the same update: who revealed them and when, and the ciphertext is gone.
    expect(await jobRow(jobId)).toMatchObject({
      revealed_at: t.clock.now(),
      revealed_by_account_id: owner.id,
      reveal_ciphertext: null,
      reveal_encryption_key_id: null,
    });
    const audit = await auditOf(tenantId, "tenant.initial_keys_revealed");
    expect(audit).toEqual([
      expect.objectContaining({
        actor_type: "account",
        actor_account_id: owner.id,
        target_type: "tenant",
        target_id: tenantId,
        details: {
          jobId,
          keys: rows.map(({ id, kind, environment, prefix }) => ({ id, kind, environment, prefix })),
        },
      }),
    ]);
    // The keys are nowhere but in the one answer: no log line or audit row holds them.
    const stored = JSON.stringify([audit, t.logs.lines, workerLogs.lines]);
    for (const { key } of keys) {
      expect(stored).not.toContain(key);
    }

    const again = await reveal(tenantId, headers);
    expect(again.status).toBe(410);
    expect(again.body).toMatchObject({ error: { code: "KEYS_ALREADY_REVEALED" } });
    expectResponseToMatch("revealInitialKeys", again, { document: "platform" });
    expect((await progress(tenantId, headers)).body).toMatchObject({ initialKeysAvailable: false });
  });

  it("[PBE-023 AC5] a reveal 24 hours after the setup finished answers 410, and the hourly purge erases what was not revealed", async () => {
    const early = await provisionedOta();
    const late = await provisionedOta();
    const finishedAt = (await jobRow(late.jobId)).finished_at as Date;

    // One millisecond before the window closes the keys can still be revealed.
    t.clock.set(new Date(finishedAt.getTime() + REVEAL_WINDOW_MS - 1));
    expect((await progress(early.tenantId, await headersFor(early.owner))).body).toMatchObject({
      initialKeysAvailable: true,
    });
    expect((await reveal(early.tenantId, await headersFor(early.owner))).status).toBe(200);

    // From 24 hours on they cannot, whether or not the purge has run yet.
    t.clock.advance(1);
    const lateHeaders = await headersFor(late.owner);
    expect((await progress(late.tenantId, lateHeaders)).body).toMatchObject({ initialKeysAvailable: false });
    const gone = await reveal(late.tenantId, lateHeaders);
    expect(gone.status).toBe(410);
    expect(gone.body).toMatchObject({ error: { code: "KEYS_ALREADY_REVEALED" } });
    expect((await jobRow(late.jobId)).reveal_ciphertext).not.toBeNull();

    // A setup that finished now keeps its keys through the purge; the late one's are erased, never revealed.
    const fresh = await provisionedOta();
    // At least the late one (an OTA of an earlier test of this file may be due as well).
    expect((await purge.run()).purged).toBeGreaterThanOrEqual(1);
    expect(await jobRow(late.jobId)).toMatchObject({
      reveal_ciphertext: null,
      reveal_encryption_key_id: null,
      revealed_at: null,
      revealed_by_account_id: null,
    });
    expect((await jobRow(fresh.jobId)).reveal_ciphertext).not.toBeNull();
    expect((await reveal(late.tenantId, lateHeaders)).status).toBe(410);
    // The keys themselves stay valid.
    expect((await keysOf(late.tenantId)).map((key) => key.revoked_at)).toEqual([null, null]);
  });

  it("answers 403 to a member who is not an owner and 404 to a non-member, revealing nothing", async () => {
    const { tenantId, jobId } = await provisionedOta();
    const admin = await insertAccount(pool, { id: testId("acc", 3500 + next++) });
    await insertMember(pool, { id: tenantId }, admin, "admin");
    const stranger = await insertAccount(pool, { id: testId("acc", 3500 + next++) });

    const byAdmin = await reveal(tenantId, await headersFor(admin));
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect((await reveal(tenantId, await headersFor(stranger))).status).toBe(404);

    expect(await jobRow(jobId)).toMatchObject({ revealed_at: null, revealed_by_account_id: null });
    expect((await jobRow(jobId)).reveal_ciphertext).not.toBeNull();
  });
});
