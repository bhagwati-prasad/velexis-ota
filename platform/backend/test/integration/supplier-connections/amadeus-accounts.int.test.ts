// The Velexis Amadeus accounts of the platform admin (PBE-020; platform/docs/api-inventory-admin.md §5,
// flows/amadeus-connection.md §A, ADR-0012, PADR-0012; scope PF-90) end to end: the API (createTestApp) on this file's
// database clone takes the admin's create, update, verify and list, and the worker's module graph (WorkerModule, as
// dist/worker.js builds it, with the same FakeClock) runs the `amadeus_account.verify` jobs against the Amadeus stub of
// @velexis/testing, started in this process on a free port. Admin tokens come from the application's TokenService
// (admin sign-in comes with PBE-028), for an account written with the builders as an active platform admin with MFA.
//
// A failed attempt is not waited for: the test promotes the delayed BullMQ job, which is what the 30-second backoff
// would do. Every test starts with no Amadeus account, office or connection (one account per environment), and every
// line both processes log, at every level, is kept, so "the secret never reaches a log line" covers them all. The
// tokens the stub issues are read from the answers through a wrapper of `fetch`, so the test can look for them too.
import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import { OAUTH_TOKEN_PATH, startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import type { Job, Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import {
  AMADEUS_ACCOUNT_VERIFY_JOB,
  clientSecretPlace,
} from "../../../src/supplier-connections/verification.processor";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertTenant,
  testId,
} from "../../builders/platform-rows";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/** Starting the API, the worker's module graph and the stub takes seconds; the bound allows for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker's jobs and the invalidation events. */
const WAIT_MS = 20_000;
const FAMILY = testId("asn", 1);
const ADMIN_IP = "203.0.113.7";
/** The stub's accepted pair of the rejection tests (not a secret: a value of this file). */
const ACCEPTED = { clientId: "velexis-strict-client", clientSecret: `accepted-${randomUUID()}` };

interface AccountBody {
  readonly id: string;
  readonly name: string;
  readonly environment: string;
  readonly baseUrl: string;
  readonly clientId: string;
  readonly status: string;
  readonly lastVerifiedAt: string | null;
  readonly lastError: string | null;
  readonly officeCounts: Record<string, number>;
  readonly createdAt: string;
  readonly version: number;
}

interface StoredAccount {
  readonly id: string;
  readonly status: string;
  readonly last_verified_at: Date | null;
  readonly last_error: string | null;
  readonly client_secret_ciphertext: Buffer;
  readonly version: number;
}

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let connections: Queue;
let stub: AmadeusStub;
let strictStub: AmadeusStub;
let subscriber: Redis;
let admin: string;
let plainAdmin: string;
const workerLogs = new LogSink();
/** Every client secret this file sent, and every token the stubs issued, to look for them afterwards. */
const secrets: string[] = [];
const issuedTokens: string[] = [];
/** The `amadeus_account` invalidations received, by account id. */
const invalidated: string[] = [];

beforeAll(async () => {
  stub = await startAmadeusStub();
  strictStub = await startAmadeusStub({ credentials: ACCEPTED });
  secrets.push(ACCEPTED.clientSecret);
  // Every line at every level is captured, so "no log line holds the secret" covers the debug and trace lines too.
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .compile();
  await worker.init();
  connections = worker.get<Queue>(getQueueToken(PLATFORM_QUEUE.connections), { strict: false });
  admin = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;
  plainAdmin = (await insertAccount(pool, { is_platform_admin: true })).id;

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (event.type === "amadeus_account") {
      invalidated.push(event.id);
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await worker?.close();
  await t?.close();
  await stub?.stop();
  await strictStub?.stop();
}, SETUP_TIMEOUT_MS);

beforeEach(async () => {
  // One account per environment: every test starts without Amadeus rows (connections and offices refer to accounts).
  await pool.query("DELETE FROM platform.supplier_connections");
  await pool.query("DELETE FROM platform.amadeus_offices");
  await pool.query("DELETE FROM platform.amadeus_accounts");
  stub.setDefaultScenario("success");
  stub.clearRequests();
  strictStub.clearRequests();
  // Node's fetch, wrapped to keep the access token of every answer of a token endpoint (the gateway discards it).
  const original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await original(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith(OAUTH_TOKEN_PATH) && response.ok) {
      const body = (await response.clone().json()) as { access_token?: unknown };
      if (typeof body.access_token === "string") {
        issuedTokens.push(body.access_token);
      }
    }
    return response;
  });
});

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

/** The headers of an admin call: a `platform_admin` token, with a TOTP step-up now unless `stepUp` is false. */
async function adminHeaders(
  options: { readonly stepUp?: boolean; readonly sub?: string } = {},
): Promise<Record<string, string>> {
  const { token } = await t.app.get(TokenService).sign({
    aud: "platform_admin",
    sub: options.sub ?? admin,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
    ...(options.stepUp === false ? {} : { mfa_at: nowSeconds() }),
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

/** A client secret of this file (random; not a real one), remembered to look for it afterwards. */
function newSecret(): string {
  const secret = `stub-secret-${randomUUID()}`;
  secrets.push(secret);
  return secret;
}

function errorOf(res: { body: unknown }): { code: string; details?: Record<string, unknown> } {
  return (res.body as { error: { code: string; details?: Record<string, unknown> } }).error;
}

async function stored(id: string): Promise<StoredAccount> {
  const { rows } = await pool.query("SELECT * FROM platform.amadeus_accounts WHERE id = $1", [id]);
  return rows[0] as StoredAccount;
}

async function auditOf(id: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE target_id = $1 ORDER BY id",
    [id],
  );
  return rows as Array<Record<string, unknown>>;
}

/** The verification jobs of an account, in any state. */
async function jobsOf(id: string): Promise<Job[]> {
  const jobs = await connections.getJobs([
    "waiting",
    "active",
    "delayed",
    "prioritized",
    "completed",
    "failed",
  ]);
  return jobs.filter(
    (job): job is Job =>
      job !== undefined && (job.data as { amadeusAccountId?: string }).amadeusAccountId === id,
  );
}

/**
 * Waits until every verification job of the account has finished (completed, or failed for good), promoting each
 * delayed retry at once instead of waiting for its backoff, and returns the jobs.
 */
async function settle(id: string, expectedJobs = 1): Promise<Job[]> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const jobs = await jobsOf(id);
    const states = await Promise.all(jobs.map((job) => job.getState()));
    if (jobs.length >= expectedJobs && states.every((state) => state === "completed" || state === "failed")) {
      return Promise.all(jobs.map(async (job) => (await connections.getJob(job.id ?? "")) ?? job));
    }
    for (const [index, state] of states.entries()) {
      if (state === "delayed") {
        await jobs[index]?.promote();
      }
    }
    expect(Date.now(), "the verification jobs to finish").toBeLessThan(deadline);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** Waits for an `amadeus_account` invalidation of `id` (pub/sub is asynchronous). */
async function invalidationOf(id: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!invalidated.includes(id)) {
    expect(Date.now(), `an amadeus_account invalidation of ${id}`).toBeLessThan(deadline);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** The texts where a secret or a token must never be: every log line, the rows, the audit rows and the jobs. */
async function everywhere(id: string): Promise<string> {
  const jobs = await jobsOf(id);
  const hashes = await Promise.all(
    jobs.map((job) =>
      t.redis.client.hgetall(`${connections.opts.prefix ?? "bull"}:${connections.name}:${job.id ?? ""}`),
    ),
  );
  // The jobs' own hashes in Redis (data, return value, failure, stack trace), so the look is not at copies only.
  expect(hashes.length).toBe(jobs.length);
  expect(hashes.every((hash) => typeof hash["data"] === "string")).toBe(true);
  const account = await stored(id);
  return JSON.stringify([
    t.logs.lines,
    workerLogs.lines,
    { ...account, client_secret_ciphertext: account.client_secret_ciphertext.toString("latin1") },
    await auditOf(id),
    jobs.map((job) => ({ data: job.data, returnvalue: job.returnvalue, failedReason: job.failedReason })),
    hashes,
  ]);
}

async function create(
  body: Partial<Record<"name" | "environment" | "baseUrl" | "clientId" | "clientSecret", string>> = {},
) {
  return t.http
    .post("/v1/admin/amadeus-accounts")
    .set(await adminHeaders())
    .send({
      name: "Velexis test",
      environment: "test",
      baseUrl: stub.url,
      clientId: "velexis-test-client",
      clientSecret: newSecret(),
      ...body,
    });
}

describe("adminCreateAmadeusAccount and the amadeus_account.verify job", () => {
  it("[PBE-020 AC1] verifies the account against the Amadeus stub; neither the secret nor the token appears in logs, rows or job data [PF-90]", async () => {
    const secret = newSecret();
    const res = await create({ clientSecret: secret });

    expect(res.status).toBe(201);
    expectResponseToMatch("adminCreateAmadeusAccount", res, { document: "platform" });
    const account = res.body as AccountBody;
    expect(account).toMatchObject({
      environment: "test",
      baseUrl: stub.url,
      clientId: "velexis-test-client",
      status: "pending_verification",
      lastVerifiedAt: null,
      lastError: null,
      officeCounts: { available: 0, assigned: 0, releasing: 0, retired: 0 },
      version: 1,
    });
    expect(res.headers["etag"]).toBe('"1"');

    const [job, ...others] = await settle(account.id);
    expect(others).toEqual([]);
    expect(job?.name).toBe(AMADEUS_ACCOUNT_VERIFY_JOB);
    expect(job?.data).toEqual({ amadeusAccountId: account.id });
    expect(job?.returnvalue).toEqual({ amadeusAccountId: account.id, status: "active" });
    const row = await stored(account.id);
    expect(row).toMatchObject({
      status: "active",
      last_verified_at: t.clock.now(),
      last_error: null,
      version: 1,
    });
    // The secret is stored as an envelope of its own place only.
    const decrypted = await t.app
      .get(EnvelopeService)
      .decrypt(row.client_secret_ciphertext, clientSecretPlace(account.id));
    expect(decrypted.toString("utf8")).toBe(secret);
    expect(
      stub
        .requests()
        .filter((request) => request.operation === "oauth2Token")
        .at(-1),
    ).toMatchObject({
      method: "POST",
      path: OAUTH_TOKEN_PATH,
      status: 200,
    });
    await invalidationOf(account.id);

    const audit = await auditOf(account.id);
    expect(audit.map((entry) => [entry["action"], entry["actor_type"], entry["actor_account_id"]])).toEqual([
      ["amadeus_account.created", "platform_admin", admin],
      ["amadeus_account.verified", "system", null],
    ]);
    expect(issuedTokens.length).toBeGreaterThan(0);
    const texts = await everywhere(account.id);
    for (const value of [secret, ...issuedTokens]) {
      expect(texts.includes(value), "a secret or token in a log line, row or job").toBe(false);
    }

    const list = await t.http.get("/v1/admin/amadeus-accounts").set(await adminHeaders({ stepUp: false }));
    expect(list.status).toBe(200);
    expectResponseToMatch("adminListAmadeusAccounts", list, { document: "platform" });
    expect((list.body as { data: AccountBody[] }).data).toEqual([
      expect.objectContaining({
        id: account.id,
        status: "active",
        lastVerifiedAt: t.clock.now().toISOString(),
      }),
    ]);
  });

  it("[PBE-020 AC1] fails with the stub's server-error: retried, then invalid_credentials with the HTTP status and Amadeus code, never the body or the secret", async () => {
    stub.setDefaultScenario("server-error");
    const secret = newSecret();
    const res = await create({ clientSecret: secret });
    expect(res.status).toBe(201);
    const { id } = res.body as AccountBody;

    const [job] = await settle(id);
    expect(await job?.getState()).toBe("failed");
    expect(job?.attemptsMade).toBe(5);
    expect(await stored(id)).toMatchObject({
      status: "invalid_credentials",
      last_verified_at: null,
      last_error: "HTTP 500 (Amadeus code 141)",
    });
    const tokenRequests = stub.requests().filter((request) => request.operation === "oauth2Token");
    expect(tokenRequests.slice(-5).map((request) => request.status)).toEqual([500, 500, 500, 500, 500]);
    expect((await auditOf(id)).map((entry) => entry["action"])).toEqual([
      "amadeus_account.created",
      "amadeus_account.verification_failed",
    ]);
    await invalidationOf(id);
    // nestjs-pino keeps one logger per process for lines outside a request: the worker's lines land in t.logs too.
    const failures = [...t.logs.lines, ...workerLogs.lines].filter(
      (line) => line["msg"] === "amadeus_account.verification_failed" && line["amadeusAccountId"] === id,
    );
    expect(failures.map((line) => line["final"])).toEqual([false, false, false, false, true]);

    const texts = await everywhere(id);
    for (const value of [secret, "SYSTEM ERROR HAS OCCURRED", "Stub scenario server-error"]) {
      expect(
        texts.includes(value),
        `${value === secret ? "the secret" : value} in a log line, row or job`,
      ).toBe(false);
    }

    const list = await t.http.get("/v1/admin/amadeus-accounts").set(await adminHeaders({ stepUp: false }));
    expect((list.body as { data: AccountBody[] }).data[0]).toMatchObject({
      status: "invalid_credentials",
      lastError: "HTTP 500 (Amadeus code 141)",
    });
  });

  it("keeps an account pending while Amadeus is unavailable, and verifies it at a later attempt", async () => {
    stub.setDefaultScenario("server-error");
    const { id } = (await create()).body as AccountBody;
    // The first attempt fails; the account waits for the retry with the error of the attempt.
    const deadline = Date.now() + WAIT_MS;
    while ((await stored(id)).last_error === null) {
      expect(Date.now(), "the first attempt").toBeLessThan(deadline);
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(await stored(id)).toMatchObject({
      status: "pending_verification",
      last_error: "HTTP 500 (Amadeus code 141)",
    });

    stub.setDefaultScenario("success");
    const [job] = await settle(id);
    expect(await job?.getState()).toBe("completed");
    expect(await stored(id)).toMatchObject({ status: "active", last_error: null });
  });

  it("makes the account invalid_credentials at once when Amadeus refuses the client, and a rotated secret verifies it again", async () => {
    const res = await create({ baseUrl: strictStub.url, clientId: ACCEPTED.clientId });
    const account = res.body as AccountBody;
    const [refused] = await settle(account.id);

    // A refusal is an answer: no retry.
    expect(await refused?.getState()).toBe("completed");
    expect(strictStub.requests().filter((request) => request.operation === "oauth2Token")).toHaveLength(1);
    expect(refused?.returnvalue).toEqual({ amadeusAccountId: account.id, status: "invalid_credentials" });
    expect(await stored(account.id)).toMatchObject({
      status: "invalid_credentials",
      last_error: "HTTP 401 invalid_client (Amadeus code 38187)",
    });

    invalidated.length = 0;
    const rotated = await t.http
      .patch(`/v1/admin/amadeus-accounts/${account.id}`)
      .set(await adminHeaders())
      .set("If-Match", '"1"')
      .send({ clientSecret: ACCEPTED.clientSecret });

    expect(rotated.status).toBe(200);
    expectResponseToMatch("adminUpdateAmadeusAccount", rotated, { document: "platform" });
    expect(rotated.body).toMatchObject({ status: "pending_verification", lastError: null, version: 2 });
    expect(rotated.headers["etag"]).toBe('"2"');
    await invalidationOf(account.id);
    await settle(account.id, 2);
    expect(await stored(account.id)).toMatchObject({ status: "active", last_error: null, version: 2 });
    const update = (await auditOf(account.id)).find((entry) => entry["action"] === "amadeus_account.updated");
    expect(update).toMatchObject({
      actor_type: "platform_admin",
      actor_account_id: admin,
      details: {
        before: { status: "invalid_credentials" },
        after: { status: "pending_verification" },
        environment: "test",
        changed: ["status", "clientSecret"],
      },
    });
    expect((await everywhere(account.id)).includes(ACCEPTED.clientSecret)).toBe(false);
  });

  it("answers 409 CONFLICT for a second account of an environment, and takes the other environment", async () => {
    await insertAmadeusAccount(pool, { id: testId("ama", 1), base_url: stub.url });

    const second = await create();
    const live = await create({ name: "Velexis live", environment: "live" });

    expect(second.status).toBe(409);
    expect(errorOf(second)).toMatchObject({ code: "CONFLICT", details: { reason: "environment_exists" } });
    expectResponseToMatch("adminCreateAmadeusAccount", second, { document: "platform" });
    expect(live.status).toBe(201);
    expect((live.body as AccountBody).environment).toBe("live");
    await settle((live.body as AccountBody).id);
  });

  it("needs a TOTP step-up to enter credentials, and refuses a portal token and an admin who is not one", async () => {
    const noStepUp = await t.http
      .post("/v1/admin/amadeus-accounts")
      .set(await adminHeaders({ stepUp: false }))
      .send({ name: "x", environment: "test", baseUrl: stub.url, clientId: "c", clientSecret: newSecret() });
    const noMfa = await t.http
      .post("/v1/admin/amadeus-accounts")
      .set(await adminHeaders({ sub: plainAdmin }))
      .send({ name: "x", environment: "test", baseUrl: stub.url, clientId: "c", clientSecret: newSecret() });
    const { token: portalToken } = await t.app
      .get(TokenService)
      .sign({ aud: "portal", sub: admin, sid: FAMILY, ev: true, amr: ["pwd", "otp"], mfa_at: nowSeconds() });
    const portal = await t.http
      .get("/v1/admin/amadeus-accounts")
      .set({ Authorization: `Bearer ${portalToken}` });

    expect([noStepUp.status, errorOf(noStepUp).code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect([noMfa.status, errorOf(noMfa).code]).toEqual([403, "MFA_REQUIRED"]);
    expect([portal.status, errorOf(portal).code]).toEqual([401, "UNAUTHENTICATED"]);
    const { rows } = await pool.query("SELECT count(*)::int AS count FROM platform.amadeus_accounts");
    expect(rows[0]).toEqual({ count: 0 });
  });

  it("validates the request without echoing the secret", async () => {
    const secret = newSecret();
    const res = await t.http
      .post("/v1/admin/amadeus-accounts")
      .set(await adminHeaders())
      .send({
        name: "Velexis test",
        environment: "test",
        baseUrl: "http://amadeus.example.com",
        clientId: "c",
        clientSecret: secret,
        extra: secret,
      });

    expect(res.status).toBe(400);
    expectResponseToMatch("adminCreateAmadeusAccount", res, { document: "platform" });
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(JSON.stringify(t.logs.lines)).not.toContain(secret);
  });
});

describe("adminUpdateAmadeusAccount, adminVerifyAmadeusAccount and adminListAmadeusAccounts", () => {
  /** The sequence of the accounts these tests write (audit rows stay, so each test has accounts of its own). */
  let nextAccount = 100;

  /** An active test account on the stub, as the verification leaves it, with a real envelope of `secret`. */
  async function activeAccount(secret = newSecret()): Promise<string> {
    const id = testId("ama", nextAccount++);
    const encrypted = await t.app.get(EnvelopeService).encrypt(secret, clientSecretPlace(id));
    await insertAmadeusAccount(pool, {
      id,
      base_url: stub.url,
      client_secret_ciphertext: Buffer.from(encrypted.ciphertext),
      encryption_key_id: encrypted.kekId,
      status: "active",
      last_verified_at: new Date("2026-01-14T10:00:00.000Z"),
    });
    return id;
  }

  it("renames without a step-up, but needs one for a new secret, client id or host; a stale version answers 412", async () => {
    const id = await activeAccount();

    const rename = await t.http
      .patch(`/v1/admin/amadeus-accounts/${id}`)
      .set(await adminHeaders({ stepUp: false }))
      .set("If-Match", '"1"')
      .send({ name: "Velexis shared test" });
    const rotate = await t.http
      .patch(`/v1/admin/amadeus-accounts/${id}`)
      .set(await adminHeaders({ stepUp: false }))
      .set("If-Match", '"2"')
      .send({ clientSecret: newSecret() });
    const host = await t.http
      .patch(`/v1/admin/amadeus-accounts/${id}`)
      .set(await adminHeaders({ stepUp: false }))
      .set("If-Match", '"2"')
      .send({ baseUrl: "https://amadeus.example.com" });
    const stale = await t.http
      .patch(`/v1/admin/amadeus-accounts/${id}`)
      .set(await adminHeaders())
      .set("If-Match", '"1"')
      .send({ name: "Too late" });
    const unknown = await t.http
      .patch(`/v1/admin/amadeus-accounts/${testId("ama", 999)}`)
      .set(await adminHeaders())
      .set("If-Match", '"1"')
      .send({ name: "Nobody" });

    expect(rename.status).toBe(200);
    expect(rename.body).toMatchObject({ name: "Velexis shared test", status: "active", version: 2 });
    expect(rename.headers["etag"]).toBe('"2"');
    expect([rotate.status, errorOf(rotate).code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect([host.status, errorOf(host).code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect([stale.status, errorOf(stale).code]).toEqual([412, "PRECONDITION_FAILED"]);
    expect([unknown.status, errorOf(unknown).code]).toEqual([404, "NOT_FOUND"]);
    for (const res of [rename, rotate, stale, unknown]) {
      expectResponseToMatch("adminUpdateAmadeusAccount", res, { document: "platform" });
    }
    await invalidationOf(id);
    // A rename queues no verification.
    expect(await jobsOf(id)).toEqual([]);
    expect(await stored(id)).toMatchObject({ status: "active", version: 2 });
  });

  it("disables an account without a verification, and adminVerifyAmadeusAccount makes it active again", async () => {
    const id = await activeAccount();
    invalidated.length = 0;

    const disabled = await t.http
      .patch(`/v1/admin/amadeus-accounts/${id}`)
      .set(await adminHeaders({ stepUp: false }))
      .set("If-Match", '"1"')
      .send({ status: "disabled" });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ status: "disabled", version: 2 });
    await invalidationOf(id);
    expect(await jobsOf(id)).toEqual([]);
    // A secret rotated while disabled stays disabled, unverified, until the admin verifies the account.
    const rotated = await t.http
      .patch(`/v1/admin/amadeus-accounts/${id}`)
      .set(await adminHeaders())
      .set("If-Match", '"2"')
      .send({ clientSecret: newSecret(), status: "disabled" });
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({ status: "disabled", version: 3 });
    expect(await jobsOf(id)).toEqual([]);

    invalidated.length = 0;
    const verify = await t.http
      .post(`/v1/admin/amadeus-accounts/${id}/verify`)
      .set(await adminHeaders({ stepUp: false }));
    expect(verify.status).toBe(202);
    expect(verify.text).toBe("");
    expectResponseToMatch("adminVerifyAmadeusAccount", verify, { document: "platform" });
    await settle(id);
    await invalidationOf(id);
    expect(await stored(id)).toMatchObject({ status: "active", last_verified_at: t.clock.now(), version: 3 });
    expect((await auditOf(id)).map((entry) => [entry["action"], entry["actor_type"]])).toEqual([
      ["amadeus_account.updated", "platform_admin"],
      ["amadeus_account.updated", "platform_admin"],
      ["amadeus_account.verification_requested", "platform_admin"],
      ["amadeus_account.verified", "system"],
    ]);

    const unknown = await t.http
      .post(`/v1/admin/amadeus-accounts/${testId("ama", 999)}/verify`)
      .set(await adminHeaders({ stepUp: false }));
    expect([unknown.status, errorOf(unknown).code]).toEqual([404, "NOT_FOUND"]);
  });

  it("keeps an account disabled when a verification queued before the disable runs later, and sends no secret for it", async () => {
    stub.setDefaultScenario("server-error");
    const { id } = (await create()).body as AccountBody;
    // The first attempt fails; the job waits for its retry while the admin disables the account.
    const deadline = Date.now() + WAIT_MS;
    while ((await stored(id)).last_error === null) {
      expect(Date.now(), "the first attempt").toBeLessThan(deadline);
      await new Promise((done) => setTimeout(done, 50));
    }
    const disabled = await t.http
      .patch(`/v1/admin/amadeus-accounts/${id}`)
      .set(await adminHeaders({ stepUp: false }))
      .set("If-Match", '"1"')
      .send({ status: "disabled" });
    expect(disabled.status).toBe(200);
    stub.setDefaultScenario("success");
    const tokenRequests = (): number =>
      stub.requests().filter((request) => request.operation === "oauth2Token").length;
    const before = tokenRequests();

    const [job] = await settle(id);

    expect(await job?.getState()).toBe("completed");
    expect(job?.returnvalue).toEqual({ amadeusAccountId: id, status: "superseded" });
    expect(await stored(id)).toMatchObject({ status: "disabled", version: 2 });
    expect(tokenRequests()).toBe(before);
    expect((await auditOf(id)).map((entry) => entry["action"])).toEqual([
      "amadeus_account.created",
      "amadeus_account.updated",
    ]);
  });

  it("lists the accounts test before live with the office counts of their pools, never a secret", async () => {
    const secret = newSecret();
    const testAccount = await activeAccount(secret);
    const liveAccount = await insertAmadeusAccount(pool, {
      id: testId("ama", nextAccount++),
      environment: "live",
      base_url: "https://travel.api.amadeus.com",
      status: "pending_verification",
    });
    const tenant = await insertTenant(pool);
    await insertAmadeusOffice(pool, { id: testAccount }, { id: testId("amo", 1) });
    await insertAmadeusOffice(pool, { id: testAccount }, { id: testId("amo", 2) });
    await insertAmadeusOffice(
      pool,
      { id: testAccount },
      {
        id: testId("amo", 3),
        status: "assigned",
        assigned_tenant_id: tenant.id,
        assigned_at: t.clock.now(),
      },
    );
    await insertAmadeusOffice(pool, { id: testAccount }, { id: testId("amo", 4), status: "retired" });

    const res = await t.http.get("/v1/admin/amadeus-accounts").set(await adminHeaders({ stepUp: false }));

    expect(res.status).toBe(200);
    expectResponseToMatch("adminListAmadeusAccounts", res, { document: "platform" });
    const { data } = res.body as { data: AccountBody[] };
    expect(data.map((account) => [account.id, account.environment, account.officeCounts])).toEqual([
      [testAccount, "test", { available: 2, assigned: 1, releasing: 0, retired: 1 }],
      [liveAccount.id, "live", { available: 0, assigned: 0, releasing: 0, retired: 0 }],
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/[Ss]ecret|[Cc]iphertext/);
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });
});
