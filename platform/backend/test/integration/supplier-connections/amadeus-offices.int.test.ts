// The Amadeus office pool of the platform admin (PBE-020; platform/docs/api-inventory-admin.md §5,
// flows/amadeus-connection.md §A to §C, PADR-0012; scope PF-90) through the HTTP pipeline (createTestApp) on this
// file's database clone: bulk addition, the list with its filters and cursor, notes, assignment (with the OTA's
// `velexis` connection, the conflicts and two concurrent assignments of one office) and retirement, with their audit
// rows and invalidations; and the daily `amadeus.pool_level` job, run by the worker's module graph (WorkerModule, with
// the same FakeClock), whose `ops.alert` e-mail the worker sends through SMTP to Mailpit. OPS_ALERT_EMAIL is an address
// of this file only (`uniqueEmail`), so other test files' mail never counts here.
//
// Admin tokens come from the application's TokenService (admin sign-in comes with PBE-028). Every test starts without
// Amadeus accounts, offices or connections, and writes the rows it needs with the builders.
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import { mailpit, uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Job, Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import {
  AMADEUS_POOL_LEVEL_JOB,
  type PoolLevelResult,
} from "../../../src/supplier-connections/pool-level.scheduler";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertSupplierConnection,
  insertTenant,
  testId,
  velexisSource,
  type PlatformRow,
} from "../../builders/platform-rows";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/** Starting the API and the worker's module graph takes seconds; the bound allows for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker, an e-mail or an invalidation. */
const WAIT_MS = 20_000;
const FAMILY = testId("asn", 1);
const ADMIN_IP = "203.0.113.7";
const OPS_EMAIL = uniqueEmail("ops-amadeus-pool");

interface OfficeBody {
  readonly id: string;
  readonly amadeusAccountId: string;
  readonly officeId: string;
  readonly environment: string;
  readonly status: string;
  readonly assignedTenant: { readonly id: string; readonly key: string } | null;
  readonly assignedAt: string | null;
  readonly notes: string | null;
  readonly version: number;
}

interface ConnectionBody {
  readonly id: string;
  readonly environment: string;
  readonly credentialSource: string;
  readonly status: string;
  readonly officeIds: string[];
  readonly defaultOfficeId: string | null;
  readonly queuingOfficeId: string | null;
  readonly ownerOfficeId: string | null;
  readonly clientId: string | null;
  readonly version: number;
}

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let maintenance: Queue;
let subscriber: Redis;
let admin: string;
const workerLogs = new LogSink();
const events: InvalidationEvent[] = [];
/** Ids of this file's rows: audit rows stay between tests, so each test writes rows of its own. */
let next = 1;
const nextId = (prefix: string): string => testId(prefix, next++);

beforeAll(async () => {
  t = await createTestApp({ env: { OPS_ALERT_EMAIL: OPS_EMAIL } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .compile();
  await worker.init();
  maintenance = worker.get<Queue>(getQueueToken(PLATFORM_QUEUE.maintenance), { strict: false });
  admin = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    events.push(JSON.parse(message) as InvalidationEvent);
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(async () => {
  await pool.query("DELETE FROM platform.supplier_connections");
  await pool.query("DELETE FROM platform.amadeus_offices");
  await pool.query("DELETE FROM platform.amadeus_accounts");
  events.length = 0;
});

async function adminHeaders(): Promise<Record<string, string>> {
  const { token } = await t.app.get(TokenService).sign({
    aud: "platform_admin",
    sub: admin,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

function errorOf(res: { body: unknown }): { code: string; details?: Record<string, unknown> } {
  return (res.body as { error: { code: string; details?: Record<string, unknown> } }).error;
}

/** The Velexis account of `environment` (the `test` one on the stub's URL by default). */
async function account(environment: "test" | "live" = "test"): Promise<PlatformRow<"amadeus_accounts">> {
  return insertAmadeusAccount(pool, {
    id: nextId("ama"),
    environment,
    ...(environment === "live" ? { base_url: "https://travel.api.amadeus.com" } : {}),
  });
}

/** An office of the account's pool (`available` unless `overrides` says otherwise). */
async function office(
  owner: Pick<PlatformRow<"amadeus_accounts">, "id">,
  overrides: Parameters<typeof insertAmadeusOffice>[2] = {},
): Promise<PlatformRow<"amadeus_offices">> {
  return insertAmadeusOffice(pool, owner, { id: nextId("amo"), ...overrides });
}

async function tenant(): Promise<PlatformRow<"tenants">> {
  return insertTenant(pool, { id: nextId("ten"), key: `pool${next}` });
}

async function storedOffice(id: string): Promise<PlatformRow<"amadeus_offices">> {
  const { rows } = await pool.query("SELECT * FROM platform.amadeus_offices WHERE id = $1", [id]);
  return rows[0] as PlatformRow<"amadeus_offices">;
}

async function connectionsOf(tenantId: string): Promise<Array<PlatformRow<"supplier_connections">>> {
  const { rows } = await pool.query("SELECT * FROM platform.supplier_connections WHERE tenant_id = $1", [
    tenantId,
  ]);
  return rows as Array<PlatformRow<"supplier_connections">>;
}

async function auditOf(targetId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE target_id = $1 ORDER BY id",
    [targetId],
  );
  return rows as Array<Record<string, unknown>>;
}

/** Waits until the invalidation events `expected` have arrived (in any order, among others). */
async function invalidations(expected: readonly InvalidationEvent[]): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  const has = (event: InvalidationEvent): boolean =>
    events.some((received) => JSON.stringify(received) === JSON.stringify(event));
  while (!expected.every(has)) {
    expect(Date.now(), "the invalidation events").toBeLessThan(deadline);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** How many sessions of this file's database wait for a lock (row and advisory locks alike). */
async function waitingOnLocks(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(DISTINCT l.pid)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
      "WHERE NOT l.granted AND a.datname = current_database()",
  );
  return (rows[0] as { waiting: number }).waiting;
}

/**
 * Sends `requests` while a transaction of the test holds the lock `lockSql` takes, and lets them go once every request
 * waits for a lock, so the requests overlap however fast each one is. Answers in the order of `requests`.
 */
async function whileLockHeld<T>(
  lockSql: string,
  parameters: readonly unknown[],
  requests: ReadonlyArray<() => Promise<T>>,
): Promise<T[]> {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(lockSql, [...parameters]);
    const answers = Promise.all(requests.map((send) => send()));
    // Awaited below; a failure before then must not count as unhandled.
    void answers.catch(() => undefined);
    await expect.poll(waitingOnLocks, { timeout: WAIT_MS, interval: 20 }).toBe(requests.length);
    await holder.query("COMMIT");
    return await answers;
  } catch (error) {
    await holder.query("ROLLBACK");
    throw error;
  } finally {
    holder.release();
  }
}

async function assign(officeRowId: string, tenantId: string) {
  return t.http
    .post(`/v1/admin/amadeus-offices/${officeRowId}/assign`)
    .set(await adminHeaders())
    .send({ tenantId });
}

describe("adminAddAmadeusOffices", () => {
  it("[PBE-020 AC2] bulk add of NCE1A0955, nce1a0955, PAR1A0001 creates two offices and skips one", async () => {
    const pool0 = await account();

    const res = await t.http
      .post("/v1/admin/amadeus-offices")
      .set(await adminHeaders())
      .send({
        amadeusAccountId: pool0.id,
        officeIds: ["NCE1A0955", "nce1a0955", "PAR1A0001"],
        notes: "Ordered with the October batch.",
      });

    expect(res.status).toBe(201);
    expectResponseToMatch("adminAddAmadeusOffices", res, { document: "platform" });
    const body = res.body as { created: OfficeBody[]; skipped: string[] };
    expect(
      body.created.map((created) => [created.officeId, created.status, created.environment, created.notes]),
    ).toEqual([
      ["NCE1A0955", "available", "test", "Ordered with the October batch."],
      ["PAR1A0001", "available", "test", "Ordered with the October batch."],
    ]);
    expect(body.skipped).toEqual(["NCE1A0955"]);
    const { rows } = await pool.query(
      "SELECT office_id, status FROM platform.amadeus_offices WHERE amadeus_account_id = $1 ORDER BY office_id",
      [pool0.id],
    );
    expect(rows).toEqual([
      { office_id: "NCE1A0955", status: "available" },
      { office_id: "PAR1A0001", status: "available" },
    ]);
    expect(await auditOf(pool0.id)).toEqual([
      expect.objectContaining({
        action: "amadeus_office.added",
        actor_type: "platform_admin",
        actor_account_id: admin,
        target_type: "amadeus_account",
        details: {
          environment: "test",
          created: ["NCE1A0955", "PAR1A0001"],
          skipped: ["NCE1A0955"],
          notes: "Ordered with the October batch.",
        },
      }),
    ]);

    // Ids the pool holds already are skipped too, in request order; the rest is created.
    const again = await t.http
      .post("/v1/admin/amadeus-offices")
      .set(await adminHeaders())
      .send({ amadeusAccountId: pool0.id, officeIds: ["par1a0001", "LON1A0002", "NCE1A0955"] });
    expect(again.status).toBe(201);
    expect((again.body as { created: OfficeBody[] }).created.map((created) => created.officeId)).toEqual([
      "LON1A0002",
    ]);
    expect((again.body as { skipped: string[] }).skipped).toEqual(["PAR1A0001", "NCE1A0955"]);
  });

  it("refuses ids that are not 9 letters or digits, and an unknown account", async () => {
    const invalid = await t.http
      .post("/v1/admin/amadeus-offices")
      .set(await adminHeaders())
      .send({ amadeusAccountId: (await account()).id, officeIds: ["NCE1A0955", "NCE1A095"] });
    const unknown = await t.http
      .post("/v1/admin/amadeus-offices")
      .set(await adminHeaders())
      .send({ amadeusAccountId: testId("ama", 999), officeIds: ["NCE1A0955"] });

    expect(invalid.status).toBe(400);
    expect((invalid.body as { error: { fieldErrors: Array<{ path: string }> } }).error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/officeIds/1" }),
    ]);
    expect([unknown.status, errorOf(unknown).code]).toEqual([404, "NOT_FOUND"]);
    for (const res of [invalid, unknown]) {
      expectResponseToMatch("adminAddAmadeusOffices", res, { document: "platform" });
    }
  });
});

describe("adminListAmadeusOffices and adminUpdateAmadeusOffice", () => {
  it("lists the pool oldest first with filters and a cursor, naming the OTA of an assigned office", async () => {
    const testPool = await account();
    const livePool = await account("live");
    const ota = await tenant();
    const created: Array<PlatformRow<"amadeus_offices">> = [];
    for (const minutes of [1, 2, 3, 4]) {
      created.push(
        await office(testPool, {
          created_at: new Date(Date.UTC(2026, 0, 1, 9, minutes)),
          ...(minutes === 2
            ? { status: "assigned", assigned_tenant_id: ota.id, assigned_at: t.clock.now() }
            : {}),
        }),
      );
    }
    const live = await office(livePool, { created_at: new Date(Date.UTC(2026, 0, 1, 9, 0)) });

    const pages: OfficeBody[][] = [];
    let cursor: string | null = null;
    do {
      const res = await t.http
        .get("/v1/admin/amadeus-offices")
        .query({ limit: 2, ...(cursor === null ? {} : { cursor }) })
        .set(await adminHeaders());
      expect(res.status).toBe(200);
      expectResponseToMatch("adminListAmadeusOffices", res, { document: "platform" });
      const body = res.body as { data: OfficeBody[]; page: { nextCursor: string | null; limit: number } };
      expect(body.page.limit).toBe(2);
      pages.push(body.data);
      cursor = body.page.nextCursor;
    } while (cursor !== null);
    expect(pages.map((page) => page.map((row) => row.id))).toEqual([
      [live.id, created[0]?.id],
      [created[1]?.id, created[2]?.id],
      [created[3]?.id],
    ]);
    expect(pages[1]?.[0]).toMatchObject({ status: "assigned", assignedTenant: { id: ota.id, key: ota.key } });

    const byFilter = async (query: Record<string, string>): Promise<string[]> => {
      const res = await t.http
        .get("/v1/admin/amadeus-offices")
        .query(query)
        .set(await adminHeaders());
      expect(res.status).toBe(200);
      return (res.body as { data: OfficeBody[] }).data.map((row) => row.id);
    };
    expect(await byFilter({ environment: "live" })).toEqual([live.id]);
    expect(await byFilter({ accountId: testPool.id, status: "available" })).toEqual([
      created[0]?.id,
      created[2]?.id,
      created[3]?.id,
    ]);
    expect(await byFilter({ status: "assigned" })).toEqual([created[1]?.id]);

    const badCursor = await t.http
      .get("/v1/admin/amadeus-offices")
      .query({ cursor: "bm90LWEtY3Vyc29y" })
      .set(await adminHeaders());
    expect(badCursor.status).toBe(400);
    expect((badCursor.body as { error: { fieldErrors: unknown[] } }).error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/query/cursor", code: "cursor" }),
    ]);
  });

  it("replaces the notes with If-Match, clears them with null, and answers 412 for a stale version", async () => {
    const row = await office(await account());

    const set = await t.http
      .patch(`/v1/admin/amadeus-offices/${row.id}`)
      .set(await adminHeaders())
      .set("If-Match", '"1"')
      .send({ notes: "Live onboarding signed; ticketing agreement TA-118." });
    const stale = await t.http
      .patch(`/v1/admin/amadeus-offices/${row.id}`)
      .set(await adminHeaders())
      .set("If-Match", '"1"')
      .send({ notes: "Too late" });
    const cleared = await t.http
      .patch(`/v1/admin/amadeus-offices/${row.id}`)
      .set(await adminHeaders())
      .set("If-Match", '"2"')
      .send({ notes: null });

    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      notes: "Live onboarding signed; ticketing agreement TA-118.",
      version: 2,
    });
    expect(set.headers["etag"]).toBe('"2"');
    expect([stale.status, errorOf(stale).code]).toEqual([412, "PRECONDITION_FAILED"]);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ notes: null, version: 3 });
    for (const res of [set, stale, cleared]) {
      expectResponseToMatch("adminUpdateAmadeusOffice", res, { document: "platform" });
    }
    expect((await auditOf(row.id)).map((entry) => [entry["action"], entry["actor_type"]])).toEqual([
      ["amadeus_office.updated", "platform_admin"],
      ["amadeus_office.updated", "platform_admin"],
    ]);
  });
});

describe("adminAssignAmadeusOffice", () => {
  it("assigns an available office and creates the OTA's velexis connection, active, with the office in every office field", async () => {
    const testPool = await account();
    const row = await office(testPool);
    const ota = await tenant();

    const res = await assign(row.id, ota.id);

    expect(res.status).toBe(200);
    expectResponseToMatch("adminAssignAmadeusOffice", res, { document: "platform" });
    const body = res.body as { office: OfficeBody; connection: ConnectionBody };
    expect(body.office).toMatchObject({
      id: row.id,
      status: "assigned",
      assignedTenant: { id: ota.id, key: ota.key },
      assignedAt: t.clock.now().toISOString(),
      version: 2,
    });
    expect(body.connection).toMatchObject({
      environment: "test",
      credentialSource: "velexis",
      status: "active",
      officeIds: [row.office_id],
      defaultOfficeId: row.office_id,
      queuingOfficeId: row.office_id,
      ownerOfficeId: row.office_id,
      clientId: null,
      version: 1,
    });
    const [stored] = await connectionsOf(ota.id);
    expect(stored).toMatchObject({
      id: body.connection.id,
      credential_source: "velexis",
      amadeus_account_id: testPool.id,
      ticketing_defaults: {},
      monitored_queues: [],
      client_secret_ciphertext: null,
      created_by_account_id: admin,
    });
    expect(await auditOf(row.id)).toEqual([
      expect.objectContaining({
        action: "amadeus_office.assigned",
        actor_type: "platform_admin",
        actor_account_id: admin,
        tenant_id: ota.id,
        details: expect.objectContaining({
          officeId: row.office_id,
          connectionId: body.connection.id,
          connectionCreated: true,
        }) as unknown,
      }),
    ]);
    await invalidations([
      { v: 1, type: "connection", tenantId: ota.id },
      { v: 1, type: "amadeus_account", id: testPool.id },
    ]);
  });

  it("completes a velexis connection that waits for an office (an empty pool at provisioning)", async () => {
    const testPool = await account();
    const row = await office(testPool);
    const ota = await tenant();
    const waiting = await insertSupplierConnection(pool, ota, {
      ...velexisSource(testPool),
      id: nextId("sc"),
      status: "pending_verification",
      ticketing_defaults: { issue: false },
    });

    const res = await assign(row.id, ota.id);

    expect(res.status).toBe(200);
    expect((res.body as { connection: ConnectionBody }).connection).toMatchObject({
      id: waiting.id,
      status: "active",
      officeIds: [row.office_id],
      defaultOfficeId: row.office_id,
      version: 2,
    });
    expect(await connectionsOf(ota.id)).toEqual([
      expect.objectContaining({ id: waiting.id, status: "active", ticketing_defaults: { issue: false } }),
    ]);
  });

  it("[PBE-020 AC3] two concurrent assignments of one office: one succeeds, the other answers AMADEUS_OFFICE_UNAVAILABLE", async () => {
    const row = await office(await account());
    const first = await tenant();
    const second = await tenant();
    // Hold the office row, so both requests are in flight and wait for it at the same time.
    const answers = await whileLockHeld(
      "SELECT id FROM platform.amadeus_offices WHERE id = $1 FOR UPDATE",
      [row.id],
      [() => assign(row.id, first.id), () => assign(row.id, second.id)],
    );

    expect(answers.map((res) => res.status).sort()).toEqual([200, 409]);
    const winner = answers.find((res) => res.status === 200);
    const loser = answers.find((res) => res.status === 409);
    expect(loser && errorOf(loser).code).toBe("AMADEUS_OFFICE_UNAVAILABLE");
    for (const res of answers) {
      expectResponseToMatch("adminAssignAmadeusOffice", res, { document: "platform" });
    }
    const winnerId = (winner?.body as { office: OfficeBody }).office.assignedTenant?.id;
    const loserId = winnerId === first.id ? second.id : first.id;
    expect(await storedOffice(row.id)).toMatchObject({ status: "assigned", assigned_tenant_id: winnerId });
    expect(await connectionsOf(winnerId ?? "")).toHaveLength(1);
    expect(await connectionsOf(loserId)).toEqual([]);
    expect((await auditOf(row.id)).map((entry) => entry["action"])).toEqual(["amadeus_office.assigned"]);
  });

  it("answers 409 CONFLICT when the OTA uses its own credentials there or already has an assigned office, and 404 for unknown rows", async () => {
    const testPool = await account();
    const own = await tenant();
    await insertSupplierConnection(pool, own, { id: nextId("sc") });
    const served = await tenant();
    await office(testPool, { status: "assigned", assigned_tenant_id: served.id, assigned_at: t.clock.now() });
    const free = await office(testPool);
    const retired = await office(testPool, { status: "retired" });

    const ownCredentials = await assign(free.id, own.id);
    const alreadyServed = await assign(free.id, served.id);
    const notAvailable = await assign(retired.id, (await tenant()).id);
    const unknownTenant = await assign(free.id, testId("ten", 999));
    const unknownOffice = await assign(testId("amo", 999), own.id);

    expect([ownCredentials.status, errorOf(ownCredentials)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "tenant_credentials" } }),
    ]);
    expect([alreadyServed.status, errorOf(alreadyServed)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "office_already_assigned" } }),
    ]);
    expect([notAvailable.status, errorOf(notAvailable).code]).toEqual([409, "AMADEUS_OFFICE_UNAVAILABLE"]);
    expect([unknownTenant.status, errorOf(unknownTenant).code]).toEqual([404, "NOT_FOUND"]);
    expect([unknownOffice.status, errorOf(unknownOffice).code]).toEqual([404, "NOT_FOUND"]);
    for (const res of [ownCredentials, alreadyServed, notAvailable, unknownTenant, unknownOffice]) {
      expectResponseToMatch("adminAssignAmadeusOffice", res, { document: "platform" });
    }
    expect(await storedOffice(free.id)).toMatchObject({
      status: "available",
      assigned_tenant_id: null,
      version: 1,
    });
  });
});

describe("adminRetireAmadeusOffice", () => {
  it("retires an available office with the reason in the audit row, and only an available one", async () => {
    const testPool = await account();
    const row = await office(testPool);
    const ota = await tenant();
    const assigned = await office(testPool, {
      status: "assigned",
      assigned_tenant_id: ota.id,
      assigned_at: t.clock.now(),
    });
    const reason = "Amadeus closed this office id at the end of the contract year.";

    const retired = await t.http
      .post(`/v1/admin/amadeus-offices/${row.id}/retire`)
      .set(await adminHeaders())
      .send({ reason });
    const again = await t.http
      .post(`/v1/admin/amadeus-offices/${row.id}/retire`)
      .set(await adminHeaders())
      .send({ reason });
    const inUse = await t.http
      .post(`/v1/admin/amadeus-offices/${assigned.id}/retire`)
      .set(await adminHeaders())
      .send({ reason });
    const noReason = await t.http
      .post(`/v1/admin/amadeus-offices/${assigned.id}/retire`)
      .set(await adminHeaders())
      .send({ reason: "no" });

    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ id: row.id, status: "retired", version: 2 });
    expect([again.status, errorOf(again)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "not_available" } }),
    ]);
    expect([inUse.status, errorOf(inUse).code]).toEqual([409, "CONFLICT"]);
    expect([noReason.status, errorOf(noReason).code]).toEqual([400, "VALIDATION_FAILED"]);
    for (const res of [retired, again, inUse, noReason]) {
      expectResponseToMatch("adminRetireAmadeusOffice", res, { document: "platform" });
    }
    expect(await auditOf(row.id)).toEqual([
      expect.objectContaining({
        action: "amadeus_office.retired",
        actor_type: "platform_admin",
        details: expect.objectContaining({ reason, officeId: row.office_id }) as unknown,
      }),
    ]);
    expect(await storedOffice(assigned.id)).toMatchObject({ status: "assigned" });
    await invalidations([{ v: 1, type: "amadeus_account", id: testPool.id }]);
  });
});

describe("amadeus.pool_level", () => {
  /** Adds the job the 06:55 scheduler adds, and waits for the worker to complete it. */
  async function runPoolLevel(): Promise<PoolLevelResult> {
    const job: Job = await maintenance.add(AMADEUS_POOL_LEVEL_JOB, {});
    const deadline = Date.now() + WAIT_MS;
    while ((await job.getState()) !== "completed") {
      expect(Date.now(), "the pool level job to complete").toBeLessThan(deadline);
      await new Promise((done) => setTimeout(done, 50));
    }
    return ((await maintenance.getJob(job.id ?? "")) ?? job).returnvalue as PoolLevelResult;
  }

  it("[PBE-020 AC4] with two available test offices the daily job sends one ops.alert e-mail (Mailpit)", async () => {
    const testPool = await account();
    const livePool = await account("live");
    const ota = await tenant();
    await office(testPool);
    await office(testPool);
    await office(testPool, { status: "assigned", assigned_tenant_id: ota.id, assigned_at: t.clock.now() });
    await office(testPool, { status: "retired" });
    for (let index = 0; index < 3; index += 1) {
      await office(livePool);
    }

    const first = await runPoolLevel();
    expect(first).toEqual({
      levels: [
        { environment: "test", available: 2 },
        { environment: "live", available: 3 },
      ],
      alerted: ["test"],
    });
    const message = await waitForMessage({ to: OPS_EMAIL, timeoutMs: WAIT_MS });
    expect(message.Subject).toBe("[Velexis ops] Amadeus office pool low (test): 2 available");
    expect(message.Text).toContain(`Only 2 offices are available in the pool of the Velexis Amadeus account`);
    expect(message.Text).toContain(testPool.id);

    // A second run the same day (a retry, or the job run by hand) queues no second e-mail.
    const second = await runPoolLevel();
    expect(second.alerted).toEqual([]);
    const outbox = async (): Promise<unknown[]> =>
      (
        await pool.query(
          "SELECT status FROM platform.email_outbox WHERE template = 'ops.alert' AND to_email = $1",
          [OPS_EMAIL],
        )
      ).rows;
    // The worker marks the row sent once SMTP has taken the message, a moment after Mailpit shows it.
    const deadline = Date.now() + WAIT_MS;
    while (JSON.stringify(await outbox()) !== JSON.stringify([{ status: "sent" }])) {
      expect(Date.now(), "one sent ops.alert row").toBeLessThan(deadline);
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(await mailpit.search({ to: OPS_EMAIL })).toHaveLength(1);
  });
});
