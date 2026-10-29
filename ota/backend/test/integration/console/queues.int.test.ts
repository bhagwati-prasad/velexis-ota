// The console queues and the queue poller (OBE-065; ota/docs/flows/console-operations.md §2 "Queues", architecture §6
// `queues.poll`, OADR-0014 point 4, OADR-0003's booking queue view): console.queues.list and listSnapshots through the
// API's whole pipeline (guards, validation, the audit interceptor), and `queues.poll` through the worker's fan-out
// and job runner, against PostgreSQL 16, Redis 7 and the Amadeus stub.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: alpha active in test, beta suspended, both on the Velexis test Amadeus account, whose
// `base_url` is the stub's (the worker has no AMADEUS_BASE_URL_* override), each with an office of its own and
// monitored queues (alpha: its booking queue 50 and queue 8; beta: its queue 50). Staff of alpha sign in through the
// OTA admin's service key with portal tokens; a `console:automation` key lists `queues:read`. Orders are placed on
// alpha's booking queue by creating them in the stub through its own HTTP API (Flight Create Orders with the
// `automatedProcess` the booking orchestration sends), with synthetic travellers and flights relative to now; a local
// booking is written for some of them, as the record step writes its main columns. Every answer is checked against the
// OTA document. The last describe is the isolation test of the new tenant repository (conventions §12): snapshots and
// bookings of beta, and of alpha's live mode, written directly, never reach alpha's test-mode reads.
//
// The worker's schedulers are removed after start-up, so no iteration fires while the file runs; the file plays the
// scheduler with a `fan-out` job of `queues.poll` that carries the iteration's `prevMillis` (the current minute).
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Module, type INestApplicationContext } from "@nestjs/common";
import { encryptValue, hashApiKey, sha256Hex, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
  type TenantSchema,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import type { Job, Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { loadWorkerConfig } from "../../../src/config";
import { QUEUE_POLL_MAX, QUEUES_POLL_JOB } from "../../../src/console/queue-poller.processor";
import {
  encodeQueueCursor,
  QUEUE_LIST_OPERATION,
  QUEUE_POLL_OPERATION,
} from "../../../src/console/queues.service";
import { minuteBucket, tenantJob, tenantJobId, type TenantJobResult } from "../../../src/jobs/fan-out";
import { FAN_OUT_JOB } from "../../../src/jobs/schedulers";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderRequestInput, buildOrderTraveler } from "../../builders/bookings";
import { newApiKey, testApiCredentials, testKeyProvider, testWorkerVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type Role = "owner" | "admin" | "agent" | "finance" | "viewer";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SCHEMAS = { alpha: "tenant_alpha", beta: "tenant_beta" } as const satisfies Record<string, string>;
/** How long a test waits at most for the worker to finish a job it added (they take milliseconds). */
const JOB_WAIT = { timeout: 4000, interval: 20 } as const;
/** The worker's log lines. */
const workerSink = new MemorySink();
/** The booking queue of the tenants (the provisioning seed's queue 50, category 0) and alpha's second queue. */
const BOOKING_QUEUE = 50;
const OTHER_QUEUE = 8;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let worker: INestApplicationContext;
let maintenance: Queue;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let amadeusAccountId: string;
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };
const tenants = { alpha: "", beta: "" };
const offices = { alpha: "", beta: "", other: "" };
let automationKey: string;
let automationKeyId: string;

// ---- Platform rows -------------------------------------------------------------------------------------------------

async function insertAmadeusAccount(): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(stubCredentials.clientSecret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${id}`,
    keys,
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id,
      name: "Velexis test",
      environment: "test",
      base_url: stub.url,
      client_id: stubCredentials.clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

/** A tenant with its test Amadeus connection (the stub) and the queues the poller reads for it. */
async function insertTenant(
  key: "alpha" | "beta",
  status: "active" | "suspended",
  office: string,
  monitoredQueues: readonly JsonObject[],
  officeIds: readonly string[] = [office],
): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status, plan_code: "early_access" })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: id,
      environment: "test",
      credential_source: "velexis",
      amadeus_account_id: amadeusAccountId,
      office_ids: [...officeIds],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      monitored_queues: JSON.stringify(monitoredQueues),
      status: "active",
    })
    .execute();
  return id;
}

/** A `console:automation` key of alpha listing `queues:read`, as the platform issues it. */
async function issueAutomationKey(): Promise<{ key: string; id: string }> {
  const key = newApiKey("sk", "test");
  const id = newId("key");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id,
      tenant_id: tenants.alpha,
      name: "Automation (queues)",
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      scopes: ["console:automation", "queues:read"],
    })
    .execute();
  return { key, id };
}

interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly email: string;
  readonly role: Role;
}

async function insertMember(role: Role): Promise<Member> {
  const email = `staff.${randomBytes(4).toString("hex")}@example.com`;
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email,
      full_name: "Maria Lopez",
      status: "active",
      email_verified_at: new Date(),
      locale: "en-GB",
      time_zone: "Europe/Paris",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: tenants.alpha, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, email, role };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stores a portal token for `member` as the platform's API does (PADR-0007 item 1). */
async function portalTokenFor(member: Member): Promise<string> {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: tenants.alpha,
    membershipId: member.staffId,
    role: member.role,
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 60, "NX")).toBe(
    "OK",
  );
  return token;
}

let ipCounter = 0;

/** A staff member signed in through the OTA admin (its service key, the staff member's IP, the test environment). */
class AdminSession {
  readonly ip: string;
  accessToken = "";

  constructor(readonly member: Member) {
    ipCounter += 1;
    this.ip = `198.51.100.${ipCounter}`;
  }

  headers(): Record<string, string> {
    return {
      "X-Api-Key": testApiCredentials().serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": "Mozilla/5.0 (OTA admin test)",
      "X-Velexis-Environment": "test",
      ...(this.accessToken === "" ? {} : { Authorization: `Bearer ${this.accessToken}` }),
    };
  }

  async signIn(): Promise<this> {
    const res = await request(api.server)
      .post("/v1/console/auth/sign-in")
      .set({ ...this.headers(), "Idempotency-Key": randomUUID() })
      .send({ grantType: "portal_token", portalToken: await portalTokenFor(this.member) });
    expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
    this.accessToken = (res.body.session as { accessToken: string }).accessToken;
    return this;
  }

  get(path: string) {
    return request(api.server).get(path).set(this.headers());
  }
}

const sessions = new Map<Role, AdminSession>();

/** The signed-in staff member of `role` (one per role and file). */
async function staff(role: Role): Promise<AdminSession> {
  let session = sessions.get(role);
  if (session === undefined) {
    session = await new AdminSession(await insertMember(role)).signIn();
    sessions.set(role, session);
  }
  return session;
}

// ---- Tenant rows and orders ----------------------------------------------------------------------------------------

const inTenant = <T>(key: keyof typeof SCHEMAS, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, SCHEMAS[key] as TenantSchema, run);

async function stubToken(): Promise<string> {
  const res = await fetch(`${stub.url}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: stubCredentials.clientId,
      client_secret: stubCredentials.clientSecret,
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

/** An order on alpha's booking queue: Flight Create Orders as the orchestration sends it, through the stub's API. */
interface QueuedOrder {
  readonly recordLocator: string;
  readonly lastName: string;
}

async function placeOrder(): Promise<QueuedOrder> {
  const lastName = `QUEUE${randomBytes(3)
    .toString("hex")
    .toUpperCase()
    .replace(/[^A-Z]/g, "Q")}`;
  const input = buildOrderRequestInput({
    travelers: [buildOrderTraveler({ travelerId: "1", lastName })],
    queue: { number: BOOKING_QUEUE, category: 0 },
    offices: { queuing: offices.alpha, owner: offices.alpha },
  });
  const built = buildCreateOrderRequest(input);
  const res = await fetch(`${stub.url}/v1/booking/flight-orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await stubToken()}`, "Content-Type": "application/vnd.amadeus+json" },
    body: JSON.stringify(built.body),
  });
  expect(res.status).toBe(201);
  const data = ((await res.json()) as { data: JsonObject }).data;
  const records = data["associatedRecords"] as JsonObject[];
  return { recordLocator: records[0]?.["reference"] as string, lastName };
}

/** A local booking of `order` (its main columns as the record step writes them), in alpha's test mode by default. */
async function seedBooking(
  order: QueuedOrder,
  status = "confirmed",
  where: { readonly tenant: keyof typeof SCHEMAS; readonly environment: "test" | "live" } = {
    tenant: "alpha",
    environment: "test",
  },
): Promise<{ id: string; reference: string }> {
  const id = newId("bkg");
  const reference = newBookingReference();
  const departure = new Date(Date.now() + 10 * DAY);
  await inTenant(where.tenant, (trx) =>
    trx
      .insertInto("bookings")
      .values({
        id,
        environment: where.environment,
        reference,
        status,
        record_locator: order.recordLocator,
        origin_system_code: "GDS",
        queuing_office_id: offices.alpha,
        owner_office_id: offices.alpha,
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 2 * 60 * MINUTE),
        currency: "EUR",
        net_amount: "98.47",
        total_amount: "110.47",
        contact_email: `${id.toLowerCase()}@example.com`,
        lead_last_name: order.lastName,
        cancelled_at: status === "cancelled" ? new Date() : null,
      })
      .execute(),
  );
  return { id, reference };
}

interface SnapshotRow {
  readonly id: string;
  readonly environment: string;
  readonly office_id: string;
  readonly queue_id: number;
  readonly category: number;
  readonly max_requested: number | null;
  readonly item_count: number;
  readonly fetched_by_staff_id: string | null;
  readonly supplier_request_id: string | null;
  readonly operation: string | null;
  readonly request_staff_id: string | null;
}

/** The queue snapshots of a tenant with their supplier request's operation, oldest first. */
async function snapshotsOf(key: keyof typeof SCHEMAS): Promise<SnapshotRow[]> {
  return await inTenant(key, (trx) =>
    trx
      .selectFrom("queue_snapshots as s")
      .leftJoin("supplier_requests as r", "r.id", "s.supplier_request_id")
      .select([
        "s.id",
        "s.environment",
        "s.office_id",
        "s.queue_id",
        "s.category",
        "s.max_requested",
        "s.item_count",
        "s.fetched_by_staff_id",
        "s.supplier_request_id",
        "r.operation",
        "r.staff_id as request_staff_id",
      ])
      .orderBy("s.fetched_at")
      .orderBy("s.id")
      .execute(),
  );
}

/** The staff actions of alpha written since `since` (an instant before the request). */
async function staffActionsSince(since: Date) {
  return await inTenant("alpha", (trx) =>
    trx
      .selectFrom("staff_actions")
      .select(["action", "outcome", "actor_type", "actor_id", "target_type", "target_id"])
      .where("created_at", ">=", since)
      .execute(),
  );
}

/** Queue List requests the stub received for `office`. */
function queueReads(office: string) {
  return stub
    .requests()
    .filter((recorded) => recorded.operation === "listQueue" && recorded.query["officeId"] === office);
}

// ---- The worker's side -----------------------------------------------------------------------------------------

/** The job with this id once the worker has finished it, completed. */
async function finished(id: string): Promise<Job> {
  let found: Job | undefined;
  await vi.waitFor(async () => {
    found = await maintenance.getJob(id);
    expect(
      found?.finishedOn,
      `job ${id} is finished; ${found?.failedReason ?? "no attempt failed"}`,
    ).toBeDefined();
  }, JOB_WAIT);
  if (found === undefined) {
    throw new Error(`job ${id} not found`);
  }
  expect(await found.getState(), `job ${id}: ${found.failedReason ?? ""}`).toBe("completed");
  return found;
}

/** One iteration of `queues.poll` due at `due`: its fan-out job, then alpha's job. */
async function pollIteration(due: Date): Promise<TenantJobResult> {
  const fanOut = await maintenance.add(FAN_OUT_JOB, { task: QUEUES_POLL_JOB }, { prevMillis: due.getTime() });
  await finished(fanOut.id ?? "");
  const job = await finished(tenantJobId(QUEUES_POLL_JOB, tenants.alpha, minuteBucket(due)));
  return job.returnvalue as TenantJobResult;
}

beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["consoleListQueue", [200, 400, 403]],
    ["consoleListQueueSnapshots", [200, 400]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, keys] = await Promise.all([createTestDatabase(), useRedis(), testKeyProvider()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  stubCredentials = {
    clientId: `velexis-test-${randomBytes(4).toString("hex")}`,
    clientSecret: randomBytes(24).toString("base64url"),
  };
  stub = await startAmadeusStub({
    credentials: stubCredentials,
    // The `timeout` scenario holds an answer for 100 ms, then gives up with its 504 (Amadeus's gateway), as after 30 s.
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 100)),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  const officeOf = (prefix: string): string => `${prefix}${randomBytes(2).toString("hex").toUpperCase()}`;
  offices.alpha = officeOf("NCE1A");
  offices.beta = officeOf("MAD1A");
  offices.other = officeOf("PAR1A");
  amadeusAccountId = await insertAmadeusAccount();
  tenants.alpha = await insertTenant("alpha", "active", offices.alpha, [
    { officeId: offices.alpha, queueId: BOOKING_QUEUE, category: 0 },
    { officeId: offices.alpha, queueId: OTHER_QUEUE, category: 0 },
  ]);
  tenants.beta = await insertTenant("beta", "suspended", offices.beta, [
    { officeId: offices.beta, queueId: BOOKING_QUEUE, category: 0 },
  ]);
  ({ key: automationKey, id: automationKeyId } = await issueAutomationKey());

  api = await createTestApp({ database: db, redis });
  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  @Module({
    imports: [WorkerModule.forRoot(config, { logger: createWorkerLogger(config, workerSink) })],
  })
  class WorkerRootModule {}
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(WorkerRootModule);
  await worker.init();
  maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  // From here on the file plays the scheduler: no iteration of the real one may fire during a test.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
  // The first sign-ins and console calls of a process open the pools' connections and warm the token, validation and
  // Amadeus code; done once here, so that no test pays for it.
  for (const role of ["owner", "agent", "finance"] as const) {
    await staff(role);
  }
  expect((await (await staff("owner")).get(`/v1/console/queues/${OTHER_QUEUE}`)).status).toBe(200);
  expect((await (await staff("owner")).get("/v1/console/queue-snapshots?limit=1")).status).toBe(200);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

// ---- console.queues.list ---------------------------------------------------------------------------------------

describe("console.queues.list", () => {
  let linked: QueuedOrder;
  let orphan: QueuedOrder;
  let booking: { id: string; reference: string };

  beforeAll(async () => {
    linked = await placeOrder();
    orphan = await placeOrder();
    booking = await seedBooking(linked);
  });

  it("[OBE-065 AC2] shows an order on the booking queue without a local booking as an orphan", async () => {
    const agent = await staff("agent");
    const since = new Date();

    const res = await agent.get(`/v1/console/queues/${BOOKING_QUEUE}?limit=100`);

    expect(res.status).toBe(200);
    expectResponseToMatch("consoleListQueue", res);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const items = res.body.data as JsonObject[];
    const itemOf = (order: QueuedOrder) =>
      items.find((item) => item["recordLocator"] === order.recordLocator);
    expect(itemOf(orphan)).toMatchObject({
      bookingId: null,
      bookingReference: null,
      bookingStatus: null,
      travelers: [expect.objectContaining({ lastName: orphan.lastName })],
      amadeus: expect.objectContaining({ type: "pnrList" }),
    });
    expect(itemOf(linked)).toMatchObject({
      bookingId: booking.id,
      bookingReference: booking.reference,
      bookingStatus: "confirmed",
    });
    // The read is stored as a snapshot of the staff member, with its Amadeus call; the answer names the reader.
    expect(res.body.snapshot).toMatchObject({
      environment: "test",
      officeId: offices.alpha,
      queueId: BOOKING_QUEUE,
      category: 0,
      maxRequested: null,
      itemCount: items.length,
      fetchedBy: { type: "staff", id: agent.member.staffId, email: agent.member.email, role: "agent" },
    });
    const stored = (await snapshotsOf("alpha")).find((row) => row.id === res.body.snapshot.id);
    expect(stored).toMatchObject({
      fetched_by_staff_id: agent.member.staffId,
      item_count: items.length,
      supplier_request_id: res.body.snapshot.supplierRequestId,
      operation: QUEUE_LIST_OPERATION,
      request_staff_id: agent.member.staffId,
    });
    // A queue is a list, not one person's data: the read writes no staff action (OADR-0011 point 8).
    expect(await staffActionsSince(since)).toEqual([]);
  });

  it("pages through the stored snapshot without reading the queue again", async () => {
    const agent = await staff("agent");
    const first = await agent.get(`/v1/console/queues/${BOOKING_QUEUE}?limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    const cursor = first.body.page.nextCursor as string;
    expect(cursor).toEqual(expect.any(String));
    const reads = queueReads(offices.alpha).length;

    const second = await agent.get(`/v1/console/queues/${BOOKING_QUEUE}?limit=100&cursor=${cursor}`);

    expect(second.status).toBe(200);
    expectResponseToMatch("consoleListQueue", second);
    expect(second.body.snapshot.id).toBe(first.body.snapshot.id);
    expect(second.body.data).toHaveLength(first.body.snapshot.itemCount - 1);
    expect(second.body.page.nextCursor).toBeNull();
    expect(queueReads(offices.alpha)).toHaveLength(reads);
    // The cursor belongs to its queue.
    const other = await agent.get(`/v1/console/queues/${OTHER_QUEUE}?cursor=${cursor}`);
    expect(other.status).toBe(400);
    expect(other.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/query/cursor" })]);
  });

  it("refuses an office of another OTA before any Amadeus call, as a denied staff action", async () => {
    const agent = await staff("agent");
    const since = new Date();
    stub.clearRequests();

    const res = await agent.get(`/v1/console/queues/${BOOKING_QUEUE}?officeId=${offices.beta}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("OFFICE_NOT_ALLOWED");
    expectResponseToMatch("consoleListQueue", res);
    expect(stub.requests().filter((recorded) => recorded.operation === "listQueue")).toEqual([]);
    expect(await staffActionsSince(since)).toEqual([
      expect.objectContaining({
        action: "queues.list",
        outcome: "denied",
        actor_id: agent.member.staffId,
        target_type: "queue",
        target_id: String(BOOKING_QUEUE),
      }),
    ]);
  });

  it("needs queues:read: a finance user gets 403 FORBIDDEN", async () => {
    const res = await (await staff("finance")).get(`/v1/console/queues/${BOOKING_QUEUE}`);

    expect(res.status).toBe(403);
    expectResponseToMatch("consoleListQueue", res);
    expect(res.body.error).toMatchObject({
      code: "FORBIDDEN",
      details: { requiredPermission: "queues:read" },
    });
  });

  it("serves a console:automation key listing queues:read, the read stored as the key's", async () => {
    const res = await request(api.server)
      .get(`/v1/console/queues/${OTHER_QUEUE}`)
      .set({ "X-Api-Key": automationKey });

    expect(res.status).toBe(200);
    expectResponseToMatch("consoleListQueue", res);
    expect(res.body).toMatchObject({
      data: [],
      page: { nextCursor: null, limit: 20 },
      snapshot: { queueId: OTHER_QUEUE, itemCount: 0, fetchedBy: { type: "api_key", id: automationKeyId } },
    });
    expect((await snapshotsOf("alpha")).find((row) => row.id === res.body.snapshot.id)).toMatchObject({
      fetched_by_staff_id: null,
      operation: QUEUE_LIST_OPERATION,
    });
  });
});

// ---- queues.poll and console.queues.listSnapshots --------------------------------------------------------------

describe("the queue poller", () => {
  let orphan: QueuedOrder;
  let result: TenantJobResult;
  let polled: SnapshotRow[];
  /** The iteration of the file: the current minute when the describe starts (BullMQ's `prevMillis` of it). */
  let due: Date;

  beforeAll(async () => {
    due = new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
    orphan = await placeOrder();
    stub.clearRequests();
    const before = new Set((await snapshotsOf("alpha")).map((row) => row.id));
    result = await pollIteration(due);
    polled = (await snapshotsOf("alpha")).filter((row) => !before.has(row.id));
  });

  it("[OBE-065 AC1] stores a snapshot per monitored queue of an active tenant and skips suspended tenants", async () => {
    expect(result).toEqual({
      task: QUEUES_POLL_JOB,
      tenantId: tenants.alpha,
      outcome: "done",
      counts: { queues: 2, snapshots: 2, alreadyPolled: 0, failed: 0, skipped: 0, inactive: 0, invalid: 0 },
      continued: false,
    });
    expect(polled).toEqual([
      expect.objectContaining({
        environment: "test",
        office_id: offices.alpha,
        queue_id: BOOKING_QUEUE,
        category: 0,
        max_requested: QUEUE_POLL_MAX,
        fetched_by_staff_id: null,
        operation: QUEUE_POLL_OPERATION,
        request_staff_id: null,
      }),
      expect.objectContaining({ queue_id: OTHER_QUEUE, item_count: 0, operation: QUEUE_POLL_OPERATION }),
    ]);
    expect(polled[0]?.item_count).toBeGreaterThanOrEqual(1);
    // Beta is suspended: the fan-out lists active tenants only, so it got no job, no read and no snapshot.
    expect(
      await maintenance.getJob(tenantJobId(QUEUES_POLL_JOB, tenants.beta, minuteBucket(due))),
    ).toBeUndefined();
    expect(queueReads(offices.beta)).toEqual([]);
    expect(await snapshotsOf("beta")).toEqual([]);
  });

  it("[OBE-065 AC1] skips a suspended tenant whose job was queued before its suspension", async () => {
    const queued = tenantJob(QUEUES_POLL_JOB, tenants.beta, minuteBucket(due));
    await maintenance.add(queued.name, queued.data, queued.opts);

    const job = await finished(queued.opts.jobId);

    expect(job.returnvalue).toEqual({
      task: QUEUES_POLL_JOB,
      tenantId: tenants.beta,
      outcome: "skipped",
      reason: "tenant_suspended",
    });
    expect(queueReads(offices.beta)).toEqual([]);
    expect(await snapshotsOf("beta")).toEqual([]);
  });

  it("reads each queue once per iteration: a second run adds no job, a job run again reads nothing", async () => {
    const reads = queueReads(offices.alpha).length;
    const pollerSnapshots = async () =>
      (await snapshotsOf("alpha")).filter(
        (row) => row.fetched_by_staff_id === null && row.operation === QUEUE_POLL_OPERATION,
      );

    // A second run of the iteration: BullMQ holds alpha's job of the iteration, so it adds none.
    const fanOut = await maintenance.add(
      FAN_OUT_JOB,
      { task: QUEUES_POLL_JOB },
      { prevMillis: due.getTime() },
    );
    await finished(fanOut.id ?? "");
    // The same job run again (as after a failed attempt): the iteration's snapshots are there, nothing is read.
    const bucket = minuteBucket(due);
    const again = await maintenance.add(
      QUEUES_POLL_JOB,
      { tenantId: tenants.alpha, bucket, continuation: 0 },
      { jobId: `${tenantJobId(QUEUES_POLL_JOB, tenants.alpha, bucket)}-again` },
    );
    const rerun = await finished(again.id ?? "");

    expect(rerun.returnvalue).toMatchObject({
      outcome: "done",
      counts: { queues: 2, snapshots: 0, alreadyPolled: 2, failed: 0 },
    });
    expect(queueReads(offices.alpha)).toHaveLength(reads);
    expect(await pollerSnapshots()).toHaveLength(2);
  });

  it("lists the poller's snapshots next to the staff's, newest first, the PNRs with include=items", async () => {
    const owner = await staff("owner");

    const res = await owner.get(
      `/v1/console/queue-snapshots?queueId=${BOOKING_QUEUE}&officeId=${offices.alpha}&include=items`,
    );

    expect(res.status).toBe(200);
    expectResponseToMatch("consoleListQueueSnapshots", res);
    const snapshots = res.body.data as JsonObject[];
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    expect(snapshots.every((snapshot) => snapshot["queueId"] === BOOKING_QUEUE)).toBe(true);
    const fetched = snapshots.map((snapshot) => snapshot["fetchedAt"] as string);
    expect([...fetched].sort().reverse()).toEqual(fetched);
    const latest = snapshots[0];
    expect(latest).toMatchObject({ id: polled[0]?.id, fetchedBy: null, maxRequested: QUEUE_POLL_MAX });
    expect(
      (latest?.["items"] as JsonObject[]).find((item) => item["recordLocator"] === orphan.recordLocator),
    ).toMatchObject({
      bookingId: null,
    });
    // An earlier read of the agent is the staff member's, known by id.
    expect(
      snapshots.find((snapshot) => (snapshot["fetchedBy"] as JsonObject | null)?.["type"] === "staff"),
    ).toMatchObject({
      fetchedBy: { type: "staff", id: (await staff("agent")).member.staffId, name: null },
    });
  });

  it("pages the snapshots with a cursor bound to the filters", async () => {
    const owner = await staff("owner");
    const first = await owner.get(`/v1/console/queue-snapshots?queueId=${BOOKING_QUEUE}&limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.data[0]).not.toHaveProperty("items");
    const cursor = first.body.page.nextCursor as string;

    const second = await owner.get(
      `/v1/console/queue-snapshots?queueId=${BOOKING_QUEUE}&limit=1&cursor=${cursor}`,
    );
    const other = await owner.get(
      `/v1/console/queue-snapshots?queueId=${OTHER_QUEUE}&limit=1&cursor=${cursor}`,
    );

    expect(second.status).toBe(200);
    expectResponseToMatch("consoleListQueueSnapshots", second);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(second.body.data[0].fetchedAt <= first.body.data[0].fetchedAt).toBe(true);
    expect(other.status).toBe(400);
    expectResponseToMatch("consoleListQueueSnapshots", other);
    expect(other.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/query/cursor" })]);
  });

  it("[FIX-W32-OTA AC6] asks a connection that timed out nothing more in the job: one call (and its retry), not one per queue", async () => {
    // An iteration of its own, later than the others of the file, so neither of alpha's queues counts as polled.
    const later = new Date(due.getTime() + 50 * MINUTE);
    const client = worker.get(AmadeusClient, { strict: false });
    const listQueue = client.listQueue.bind(client);
    // Every Queue List read of the worker meets the stub's `timeout` scenario (its 504 after the hold).
    const calls: number[] = [];
    const spy = vi.spyOn(client, "listQueue").mockImplementation((context, request, options) => {
      calls.push(request.queueId);
      return listQueue({ ...context, stubScenario: "timeout" }, request, options);
    });
    stub.clearRequests();
    const logged = workerSink.lines.length;
    let outcome: TenantJobResult;
    try {
      outcome = await pollIteration(later);
    } finally {
      spy.mockRestore();
    }

    expect(outcome).toMatchObject({
      outcome: "done",
      counts: { queues: 2, snapshots: 0, alreadyPolled: 0, failed: 1, skipped: 1 },
    });
    // One call of the client for the first queue (a read is sent once more after a 5xx), none for the second.
    expect(calls).toEqual([BOOKING_QUEUE]);
    const reads = queueReads(offices.alpha);
    expect(reads.map((read) => [read.path, read.status])).toEqual([
      [`/v1/office/queues/${BOOKING_QUEUE}`, 504],
      [`/v1/office/queues/${BOOKING_QUEUE}`, 504],
    ]);
    // The skip is logged with its connection, code and count; the next iteration reads both queues again.
    const lines = workerSink.lines.slice(logged).map((line) => JSON.parse(line) as JsonObject);
    expect(lines.filter((line) => line["msg"] === "queues.poll_skipped")).toEqual([
      expect.objectContaining({
        tenantId: tenants.alpha,
        environment: "test",
        code: "SUPPLIER_TIMEOUT",
        skipped: 1,
      }),
    ]);
    stub.clearRequests();
    const next = await pollIteration(new Date(later.getTime() + MINUTE));
    expect(next).toMatchObject({ counts: { queues: 2, snapshots: 2, failed: 0, skipped: 0 } });
    expect(queueReads(offices.alpha)).toHaveLength(2);
  });
});

// ---- Tenant and environment isolation (conventions §12: every new tenant repository) --------------------------

describe("isolation", () => {
  /** A snapshot of alpha's booking queue, stored as `tenant` in `environment`, newer than any read of the file. */
  async function storeSnapshot(tenant: keyof typeof SCHEMAS, environment: "test" | "live"): Promise<string> {
    const id = newId("qsn");
    const fetchedAt = new Date(Date.now() + MINUTE);
    await inTenant(tenant, (trx) =>
      trx
        .insertInto("queue_snapshots")
        .values({
          id,
          environment,
          office_id: offices.alpha,
          queue_id: BOOKING_QUEUE,
          category: 0,
          max_requested: null,
          item_count: 0,
          response: JSON.stringify({ meta: { count: 0 }, data: [] }),
          fetched_by_staff_id: null,
          supplier_request_id: null,
          fetched_at: fetchedAt,
          created_at: fetchedAt,
          updated_at: fetchedAt,
        })
        .execute(),
    );
    return id;
  }

  it("never shows another tenant's or the other environment's snapshots or bookings", async () => {
    const agent = await staff("agent");
    const order = await placeOrder();
    // The order's record locator has a booking in beta and one in alpha's live mode, but none in alpha's test mode.
    await seedBooking(order, "confirmed", { tenant: "beta", environment: "test" });
    await seedBooking(order, "confirmed", { tenant: "alpha", environment: "live" });
    const foreign = [await storeSnapshot("beta", "test"), await storeSnapshot("alpha", "live")];

    const queue = await agent.get(`/v1/console/queues/${BOOKING_QUEUE}?limit=100`);
    const listed = await agent.get(
      `/v1/console/queue-snapshots?queueId=${BOOKING_QUEUE}&officeId=${offices.alpha}&limit=100`,
    );
    const paged = await Promise.all(
      foreign.map((id) =>
        agent.get(`/v1/console/queues/${BOOKING_QUEUE}?cursor=${encodeQueueCursor(id, 1)}`),
      ),
    );

    expect(queue.status).toBe(200);
    expect(
      (queue.body.data as JsonObject[]).find((item) => item["recordLocator"] === order.recordLocator),
    ).toMatchObject({ bookingId: null, bookingReference: null, bookingStatus: null });
    expect(listed.status).toBe(200);
    expectResponseToMatch("consoleListQueueSnapshots", listed);
    const ids = (listed.body.data as JsonObject[]).map((snapshot) => snapshot["id"]);
    expect(ids).toContain(queue.body.snapshot.id);
    for (const id of foreign) {
      expect(ids).not.toContain(id);
    }
    for (const res of paged) {
      expect(res.status).toBe(400);
      expectResponseToMatch("consoleListQueue", res);
      expect(res.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/query/cursor" })]);
    }
  });
});
