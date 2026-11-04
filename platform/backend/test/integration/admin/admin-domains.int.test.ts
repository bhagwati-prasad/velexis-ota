// The storefront hosts in the platform admin (PBE-051; platform/docs/api-inventory-admin.md §7 domain rows,
// flows/custom-domains.md step 8, flows/platform-admin-operations.md §G, PADR-0004, PADR-0006; scope PF-92):
// `adminListDomains`, `adminRecheckDomain` and `adminRemoveDomain` through the HTTP pipeline (createTestApp), every
// answer checked against the platform document. The worker's module graph (WorkerModule, with the API's FakeClock) runs
// the jobs the re-check queues and sends the owners' e-mails to Mailpit, on the same database clone and Redis database;
// its resolver is a fake (DNS_RESOLVER) and its TLS probe connects to a local TLS server (TLS_PROBE_TARGET,
// test/support/tls-server.ts) whose certificate names `*.example.net` and `*.ota.example.com`.
//
// Rows are written with the builders; admin and portal tokens come from the application's TokenService. The `domain`
// events of `vx:invalidate` are read by a subscriber that keeps the events of this file's hosts and its own markers.
// Lists are checked for what this file added, so the order of the tests never matters.
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Job, Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { redisKeys } from "../../../src/common/redis/redis-keys";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { DNS_RESOLVER } from "../../../src/domains/dns.gateway";
import {
  DOMAIN_RECHECK_JOB,
  DOMAIN_TLS_PROBE_JOB,
  DOMAIN_VERIFY_JOB,
  DomainJobs,
} from "../../../src/domains/domain-checks.processor";
import { ownershipRecordName, type DnsResolver } from "../../../src/domains/domain-checks";
import { adminRecheckJobId } from "../../../src/domains/admin-domains.service";
import { DAILY_SLOT_MS, dailyJobId } from "../../../src/domains/recheck.scheduler";
import { TLS_PROBE_TARGET } from "../../../src/domains/tls-probe";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertPlan,
  insertTenantDomain,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertOta, TEST_BASE_DOMAIN, type InsertedOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { startTlsServer, type LocalTlsServer } from "../../support/tls-server";

/**
 * The database clone, the API's and the worker's Nest module graphs, the platform document and the local TLS server
 * (one `openssl` call); the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish a job (it takes milliseconds; under Vitest's 5 s). */
const WAIT = { timeout: 3_000, interval: 20 } as const;
/** How long a test waits for the worker's e-mail to reach Mailpit. */
const MAIL_WAIT_MS = 3_000;
/** How long a marker may take to come back on `vx:invalidate`: pub/sub on the loopback interface takes milliseconds. */
const MARKER_WAIT_MS = 3_000;
// Documentation addresses (RFC 5737, RFC 3849) only.
const ADMIN_IP = "203.0.113.51";
const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";
/** The value of the builder's custom domains (the shape addDomain gives). */
const TOKEN = "vx-verify-K7Q4M2XP9TRWH5ZDB3NV8QKE1MZT6RYC";
/** An admin's written reason, with the white space the API trims (5–500 characters once trimmed). */
const REASON = "Phishing pages reported by the registrar (case 88231).";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

type Row = Record<string, unknown>;
type RecordType = "TXT" | "CNAME" | "A" | "AAAA";

/** The worker's resolver in this file: a table of records that the tests write; anything else is NXDOMAIN. */
class FakeResolver implements DnsResolver {
  private readonly records = new Map<string, unknown[]>();

  set(type: RecordType, name: string, values: unknown[]): void {
    this.records.set(`${type} ${name}`, values);
  }

  private answer<T>(type: RecordType, name: string): Promise<T[]> {
    const values = this.records.get(`${type} ${name}`);
    if (values !== undefined) {
      return Promise.resolve(values as T[]);
    }
    const exists = [...this.records.keys()].some((entry) => entry.endsWith(` ${name}`));
    const code = exists ? "ENODATA" : "ENOTFOUND";
    return Promise.reject(Object.assign(new Error(`query failed: ${code}`), { code }));
  }

  resolveTxt(hostname: string): Promise<string[][]> {
    return this.answer("TXT", hostname);
  }

  resolveCname(hostname: string): Promise<string[]> {
    return this.answer("CNAME", hostname);
  }

  resolve4(hostname: string): Promise<string[]> {
    return this.answer("A", hostname);
  }

  resolve6(hostname: string): Promise<string[]> {
    return this.answer("AAAA", hostname);
  }
}

const resolver = new FakeResolver();
const workerLogs = new LogSink();
let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let worker: TestingModule;
let domainsQueue: Queue;
let subscriber: Redis;
let tlsServer: LocalTlsServer;
let admin: PlatformRow<"accounts">;
/** A plan with two custom domains. */
let planCode = "";

/** The host names of this file (and its markers): the subscriber keeps their `domain` events only. */
const watched = new Set<string>();
/** The kept events, in the order they arrived. */
const received: InvalidationEvent[] = [];

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs, the platform document and the TLS server.
  t = await createTestApp({
    env: { FEATURE_CUSTOM_DOMAINS: "true", STOREFRONT_IPV4: IPV4, STOREFRONT_IPV6: IPV6 },
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  domainsQueue = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.domains), { strict: false });
  responseChecker("platform");
  planCode = (await insertPlan(pool, { limits: { staffSeats: 5, apiKeys: 10, customDomains: 2 } })).code;
  admin = await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true });
  tlsServer = await startTlsServer(["*.example.net", `*.${TEST_BASE_DOMAIN}`]);

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .overrideProvider(DNS_RESOLVER)
    .useValue(resolver)
    .overrideProvider(TLS_PROBE_TARGET)
    .useValue({ host: tlsServer.host, port: tlsServer.port })
    .compile();
  await worker.init();

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (event.type === "domain" && watched.has(event.hostname)) {
      received.push(event);
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await worker?.close();
  await tlsServer?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---- Arrangement ---------------------------------------------------------------------------------------------------

async function adminHeaders(): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: admin.id,
    sid: testId("asn", 51),
    ev: true,
    amr: ["pwd", "otp"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

/** An OTA of this file with two owners; its sub-domain is watched. */
interface Ota extends InsertedOta {
  readonly owners: ReadonlyArray<{ readonly id: string; readonly email: string }>;
}

async function arrangeOta(status = "active"): Promise<Ota> {
  const owner = await insertAccount(pool, { email: uniqueEmail("owner-admin-dom"), full_name: "Ana Lima" });
  const coOwner = await insertAccount(pool, {
    email: uniqueEmail("co-owner-admin-dom"),
    full_name: "Lena Holm",
  });
  const inserted = await insertOta(pool, {
    tenant: { plan_code: planCode, status },
    members: [
      [owner, "owner"],
      [coOwner, "owner"],
    ],
  });
  watched.add(inserted.domain.hostname);
  return {
    ...inserted,
    owners: [
      { id: owner.id, email: owner.email },
      { id: coOwner.id, email: coOwner.email },
    ],
  };
}

/**
 * Moves the shared FakeClock forward to `hour`:`minute` UTC of the next UTC day, so a test's re-checks of one day stay
 * in that day whatever the earlier tests did to the clock.
 */
function nextUtcDayAt(hour: number, minute: number): void {
  const day = Math.floor(t.clock.now().getTime() / DAILY_SLOT_MS) + 1;
  t.clock.set(day * DAILY_SLOT_MS + hour * HOUR_MS + minute * MINUTE_MS);
}

/** A host name of this file: `<label>-<random>.example.net`, watched for `domain` events. */
function host(label: string): string {
  const hostname = `${label}-${randomBytes(4).toString("hex")}.example.net`;
  watched.add(hostname);
  return hostname;
}

/** A custom domain written by the builder (no event); a verified one may be primary (the sub-domain then is not). */
async function customDomain(
  ota: Ota,
  hostname: string,
  status: "pending" | "verified" | "failed",
  primary = false,
): Promise<string> {
  if (primary) {
    await pool.query("UPDATE platform.tenant_domains SET is_primary = false WHERE id = $1", [ota.domain.id]);
  }
  const row = await insertTenantDomain(pool, ota.tenant, {
    hostname,
    kind: "custom",
    is_primary: primary,
    verification_status: status,
    verification_token: TOKEN,
    verification_deadline_at: new Date(t.clock.now().getTime() + (status === "pending" ? 72 : -1) * HOUR_MS),
    verified_at: status === "verified" ? t.clock.now() : null,
  });
  return row.id;
}

/** Writes the records of a correctly configured domain. */
function publishRecords(ota: Ota, hostname: string): void {
  resolver.set("TXT", ownershipRecordName(hostname), [[TOKEN]]);
  resolver.set("CNAME", hostname, [`${ota.tenant.key}.${TEST_BASE_DOMAIN}`]);
}

// ---- Rows, jobs and events -----------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[] = []): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const domainRow = async (id: string): Promise<Row | undefined> =>
  (await rowsOf("SELECT * FROM platform.tenant_domains WHERE id = $1", [id]))[0];

const auditOf = (targetId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT action, actor_type, actor_account_id, tenant_id, details FROM platform.platform_audit_log " +
      "WHERE target_id = $1 ORDER BY id",
    [targetId],
  );

const emailsOf = (tenantId: string, template: string): Promise<Row[]> =>
  rowsOf(
    "SELECT template, to_email, account_id, data FROM platform.email_outbox " +
      "WHERE tenant_id = $1 AND template = $2 ORDER BY to_email",
    [tenantId, template],
  );

/** The jobs of `platform-domains` for the domain, in any state, oldest first. */
async function jobsFor(domainId: string): Promise<Job[]> {
  const jobs = await domainsQueue.getJobs(["waiting", "active", "delayed", "completed", "failed", "paused"]);
  return jobs
    .filter((job) => (job.data as { domainId?: string }).domainId === domainId)
    .sort((a, b) => a.timestamp - b.timestamp || Number(a.id) - Number(b.id));
}

/** Waits until every job of the domain has completed; answers their names. */
async function completedJobsFor(domainId: string, count: number): Promise<string[]> {
  return vi.waitFor(async () => {
    const jobs = await jobsFor(domainId);
    expect(jobs).toHaveLength(count);
    for (const job of jobs) {
      expect(await job.getState()).toBe("completed");
    }
    return jobs.map((job) => job.name).sort();
  }, WAIT);
}

/** Waits until a marker published now comes back: every event published before it has arrived. */
async function settle(): Promise<void> {
  const marker = host("marker");
  await t.redis.client.publish(
    INVALIDATION_CHANNEL,
    JSON.stringify({ v: 1, type: "domain", hostname: marker }),
  );
  const deadline = Date.now() + MARKER_WAIT_MS;
  while (!received.some((event) => event.type === "domain" && event.hostname === marker)) {
    if (Date.now() > deadline) {
      throw new Error(`the marker did not come back on ${INVALIDATION_CHANNEL} within ${MARKER_WAIT_MS} ms`);
    }
    await delay(10);
  }
}

const eventsFor = (hostname: string): InvalidationEvent[] =>
  received.filter((event) => event.type === "domain" && event.hostname === hostname);

function errorOf(res: Response): { code: string; details?: unknown; fieldErrors?: Array<{ path: string }> } {
  return (res.body as { error: { code: string; details?: unknown; fieldErrors?: Array<{ path: string }> } })
    .error;
}

interface AdminDomainBody {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly hostname: string;
  readonly kind: string;
  readonly verificationStatus: string;
  readonly tlsStatus: string;
  readonly checkFailures: number;
}

interface ListBody {
  readonly data: AdminDomainBody[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

async function list(query: Record<string, string | number>): Promise<Response> {
  const res = await t.http
    .get("/v1/admin/domains")
    .query(query)
    .set(await adminHeaders());
  expectResponseToMatch("adminListDomains", res, { document: "platform" });
  return res;
}

async function recheck(domainId: string): Promise<Response> {
  const res = await t.http.post(`/v1/admin/domains/${domainId}/recheck`).set(await adminHeaders());
  expectResponseToMatch("adminRecheckDomain", res, { document: "platform" });
  return res;
}

async function remove(domainId: string, reason: string): Promise<Response> {
  const res = await t.http
    .post(`/v1/admin/domains/${domainId}/remove`)
    .set(await adminHeaders())
    .send({ reason });
  expectResponseToMatch("adminRemoveDomain", res, { document: "platform" });
  return res;
}

// ---- adminListDomains ----------------------------------------------------------------------------------------------

describe("adminListDomains", () => {
  it("[PBE-051 AC3] lists every OTA's hosts with their state, filters them, and pages through each exactly once", async () => {
    const ota = await arrangeOta();
    const other = await arrangeOta("suspended");
    const pendingId = await customDomain(ota, host("waiting"), "pending");
    const verifiedId = await customDomain(other, host("live"), "verified");
    await pool.query(
      "UPDATE platform.tenant_domains SET tls_status = 'issued', check_failures = 1 WHERE id = $1",
      [verifiedId],
    );

    const all = await list({ limit: 200 });

    expect(all.status).toBe(200);
    const listed = (all.body as ListBody).data;
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ota.domain.id,
          tenantId: ota.tenant.id,
          tenantKey: ota.tenant.key,
          kind: "subdomain",
        }),
        expect.objectContaining({ id: pendingId, kind: "custom", verificationStatus: "pending" }),
        expect.objectContaining({
          id: verifiedId,
          tenantId: other.tenant.id,
          verificationStatus: "verified",
          tlsStatus: "issued",
          checkFailures: 1,
        }),
      ]),
    );
    // Newest first: the custom domains were added after the sub-domains.
    const position = (id: string): number => listed.findIndex((domain) => domain.id === id);
    expect(position(verifiedId)).toBeLessThan(position(pendingId));
    expect(position(pendingId)).toBeLessThan(position(ota.domain.id));
    // No verification value or DNS record: they are the portal's business.
    expect(JSON.stringify(all.body)).not.toContain(TOKEN);

    // The filters.
    const pending = (await list({ kind: "custom", verificationStatus: "pending", limit: 200 }))
      .body as ListBody;
    expect(pending.data.map(({ id }) => id)).toContain(pendingId);
    expect(
      pending.data.every((domain) => domain.kind === "custom" && domain.verificationStatus === "pending"),
    ).toBe(true);
    const issued = (await list({ tlsStatus: "issued", limit: 200 })).body as ListBody;
    expect(issued.data.map(({ id }) => id)).toEqual(expect.arrayContaining([verifiedId]));
    expect(issued.data.every((domain) => domain.tlsStatus === "issued")).toBe(true);

    // Pages of 2 hold every host exactly once, in the same order.
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await list({ limit: 2, ...(cursor === null ? {} : { cursor }) })).body as ListBody;
      expect(page.page.limit).toBe(2);
      expect(page.data.length).toBeLessThanOrEqual(2);
      paged.push(...page.data.map(({ id }) => id));
      cursor = page.page.nextCursor;
    } while (cursor !== null);
    expect(paged).toEqual(listed.map(({ id }) => id));
  });

  it("[PBE-051 AC3] a page boundary between two hosts created in the same millisecond skips neither", async () => {
    // Two hosts newer than every other host of the clone, 200 microseconds apart within one millisecond: PostgreSQL
    // keeps the microseconds, a JavaScript Date would not, so the cursor's position must be read in SQL.
    const ota = await arrangeOta();
    const older = await customDomain(ota, host("same-ms-a"), "pending");
    const newer = await customDomain(ota, host("same-ms-b"), "pending");
    await pool.query("UPDATE platform.tenant_domains SET created_at = $2::timestamptz WHERE id = $1", [
      older,
      "2099-01-01T00:00:00.123400Z",
    ]);
    await pool.query("UPDATE platform.tenant_domains SET created_at = $2::timestamptz WHERE id = $1", [
      newer,
      "2099-01-01T00:00:00.123600Z",
    ]);

    const first = (await list({ limit: 1 })).body as ListBody;
    expect(first.data.map(({ id }) => id)).toEqual([newer]);
    expect(first.page.nextCursor).not.toBeNull();
    const second = (await list({ limit: 1, cursor: first.page.nextCursor ?? "" })).body as ListBody;

    expect(second.data.map(({ id }) => id)).toEqual([older]);
  });

  it("[PBE-051 AC3] refuses a cursor of no host, and answers 401 to a portal token", async () => {
    const bad = await list({
      cursor: Buffer.from(JSON.stringify({ id: testId("dom", 51_997) })).toString("base64url"),
    });
    expect([bad.status, errorOf(bad).code, errorOf(bad).fieldErrors?.[0]?.path]).toEqual([
      400,
      "VALIDATION_FAILED",
      "/query/cursor",
    ]);

    const owner = await insertAccount(pool, { email: uniqueEmail("portal-admin-dom") });
    const { token } = await tokens.sign({
      aud: "portal",
      sub: owner.id,
      sid: testId("asn", 52),
      ev: true,
      amr: ["pwd"],
    });
    const portal = await t.http
      .get("/v1/admin/domains")
      .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) });
    expect([portal.status, errorOf(portal).code]).toEqual([401, "UNAUTHENTICATED"]);
  });
});

// ---- adminRecheckDomain --------------------------------------------------------------------------------------------

describe("adminRecheckDomain", () => {
  it("[PBE-051 AC3] a verified custom domain gets its daily DNS re-check and a TLS probe now, audited", async () => {
    const ota = await arrangeOta();
    const hostname = host("checked");
    const domainId = await customDomain(ota, hostname, "verified");
    publishRecords(ota, hostname);

    const res = await recheck(domainId);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
    expect(await completedJobsFor(domainId, 2)).toEqual([DOMAIN_RECHECK_JOB, DOMAIN_TLS_PROBE_JOB].sort());
    expect(await domainRow(domainId)).toMatchObject({
      verification_status: "verified",
      check_failures: 0,
      last_checked_at: t.clock.now(),
      tls_status: "issued",
      tls_expires_at: tlsServer.expiresAt,
      tls_checked_at: t.clock.now(),
    });
    expect(await auditOf(domainId)).toEqual([
      {
        action: "domain.recheck_requested",
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        tenant_id: ota.tenant.id,
        details: { hostname, jobs: [DOMAIN_RECHECK_JOB, DOMAIN_TLS_PROBE_JOB] },
      },
    ]);
  });

  it("[FIX-W41-PLATFORM AC2] an admin re-check after the day's daily run queues and runs DNS under its own job id, and its pass resets the strikes", async () => {
    const ota = await arrangeOta();
    const hostname = host("after-daily");
    const domainId = await customDomain(ota, hostname, "verified");
    nextUtcDayAt(4, 10);
    // The day's 04:10 run queues the domain's check in the daily slot; DNS has no records yet, so it fails.
    const dailyId = dailyJobId(DOMAIN_RECHECK_JOB, domainId, t.clock.now());
    expect(await t.app.get(DomainJobs, { strict: false }).enqueueRecheck(domainId, dailyId)).toBe(true);
    expect(await completedJobsFor(domainId, 1)).toEqual([DOMAIN_RECHECK_JOB]);
    expect(await domainRow(domainId)).toMatchObject({ check_failures: 1, last_check_error: "txt_missing" });

    // The owner publishes the records, and later that day a platform admin re-checks.
    publishRecords(ota, hostname);
    t.clock.advance(5 * HOUR_MS);
    expect((await recheck(domainId)).status).toBe(202);

    expect(await completedJobsFor(domainId, 3)).toEqual(
      [DOMAIN_RECHECK_JOB, DOMAIN_RECHECK_JOB, DOMAIN_TLS_PROBE_JOB].sort(),
    );
    const dnsJobs = (await jobsFor(domainId)).filter((job) => job.name === DOMAIN_RECHECK_JOB);
    expect(dnsJobs.map((job) => job.id)).toEqual([dailyId, adminRecheckJobId(domainId, t.clock.now())]);
    expect(dnsJobs[1]?.returnvalue).toEqual({
      domainId,
      status: "verified",
      checked: true,
      checkFailures: 0,
    });
    expect(await domainRow(domainId)).toMatchObject({
      verification_status: "verified",
      check_failures: 0,
      last_check_error: null,
      last_checked_at: t.clock.now(),
    });
  });

  it("[FIX-W41-PLATFORM AC2] three failing admin re-checks the same UTC day leave one strike, a double click queues one DNS check, and the next UTC day's counts again", async () => {
    // Replaces FIX-W40-PLATFORM AC6's check that the re-checks shared the daily job (lead decision (2b) of
    // 2026-11-04): every re-check now runs DNS, and the worker counts one strike per domain and UTC day.
    const ota = await arrangeOta();
    const hostname = host("strikes");
    const domainId = await customDomain(ota, hostname, "verified");
    // No records: every DNS check of the host fails (`txt_missing`).
    nextUtcDayAt(10, 0);

    // A double click within the slot: one DNS check, and a TLS probe per click.
    expect((await recheck(domainId)).status).toBe(202);
    expect((await recheck(domainId)).status).toBe(202);
    expect(await completedJobsFor(domainId, 3)).toEqual(
      [DOMAIN_RECHECK_JOB, ...Array<string>(2).fill(DOMAIN_TLS_PROBE_JOB)].sort(),
    );
    expect(await domainRow(domainId)).toMatchObject({
      verification_status: "verified",
      check_failures: 1,
      last_check_error: "txt_missing",
      last_checked_at: t.clock.now(),
    });

    // Two more re-checks later that day: each runs DNS, which still fails, and neither adds a strike.
    for (const [click, minutes] of [
      [1, 1],
      [2, 30],
    ] as const) {
      t.clock.advance(minutes * MINUTE_MS);
      expect((await recheck(domainId)).status).toBe(202);
      expect(await completedJobsFor(domainId, 3 + 2 * click)).toHaveLength(3 + 2 * click);
      expect(await domainRow(domainId)).toMatchObject({
        verification_status: "verified",
        check_failures: 1,
        last_check_error: "txt_missing",
        last_checked_at: t.clock.now(),
      });
    }
    const dnsJobs = (await jobsFor(domainId)).filter((job) => job.name === DOMAIN_RECHECK_JOB);
    expect(dnsJobs).toHaveLength(3);
    expect(dnsJobs.every((job) => job.id?.startsWith(`${DOMAIN_RECHECK_JOB}.admin.${domainId}.`))).toBe(true);
    expect(dnsJobs.map((job) => job.returnvalue as unknown)).toEqual([
      { domainId, status: "verified", checked: true, checkFailures: 1, error: "txt_missing" },
      { domainId, status: "verified", checked: true, checkFailures: 1, counted: false, error: "txt_missing" },
      { domainId, status: "verified", checked: true, checkFailures: 1, counted: false, error: "txt_missing" },
    ]);
    // Every click is audited with the jobs it asked for.
    expect(
      (await auditOf(domainId)).filter((row) => row["action"] === "domain.recheck_requested"),
    ).toHaveLength(4);

    // The next UTC day, a failure counts again.
    t.clock.advance(DAILY_SLOT_MS);
    expect((await recheck(domainId)).status).toBe(202);

    expect(await completedJobsFor(domainId, 9)).toHaveLength(9);
    expect(await domainRow(domainId)).toMatchObject({ verification_status: "verified", check_failures: 2 });
  });

  it("[FIX-W41-PLATFORM AC2] the daily run's strike and a later failing admin re-check the same UTC day count once", async () => {
    const ota = await arrangeOta();
    const domainId = await customDomain(ota, host("daily-strike"), "verified");
    nextUtcDayAt(4, 10);
    const dailyId = dailyJobId(DOMAIN_RECHECK_JOB, domainId, t.clock.now());
    expect(await t.app.get(DomainJobs, { strict: false }).enqueueRecheck(domainId, dailyId)).toBe(true);
    expect(await completedJobsFor(domainId, 1)).toEqual([DOMAIN_RECHECK_JOB]);
    expect(await domainRow(domainId)).toMatchObject({ check_failures: 1, last_check_error: "txt_missing" });

    t.clock.advance(8 * HOUR_MS);
    expect((await recheck(domainId)).status).toBe(202);

    expect(await completedJobsFor(domainId, 3)).toHaveLength(3);
    const [daily, admin] = (await jobsFor(domainId)).filter((job) => job.name === DOMAIN_RECHECK_JOB);
    expect([daily?.id, admin?.id]).toEqual([dailyId, adminRecheckJobId(domainId, t.clock.now())]);
    expect(admin?.returnvalue).toMatchObject({ checked: true, checkFailures: 1, counted: false });
    expect(await domainRow(domainId)).toMatchObject({
      verification_status: "verified",
      check_failures: 1,
      last_check_error: "txt_missing",
      last_checked_at: t.clock.now(),
    });
  });

  it("[PBE-051 AC3] a pending domain gets its verification, the sub-domain and a failed domain the probe only", async () => {
    const ota = await arrangeOta();
    const pendingHost = host("new");
    const pendingId = await customDomain(ota, pendingHost, "pending");
    publishRecords(ota, pendingHost);
    const failedId = await customDomain(ota, host("lapsed"), "failed");

    for (const domainId of [pendingId, ota.domain.id, failedId]) {
      expect((await recheck(domainId)).status).toBe(202);
    }

    // The verification of the pending domain succeeds and queues its own probe one minute later.
    await vi.waitFor(async () => {
      expect((await domainRow(pendingId))?.["verification_status"]).toBe("verified");
    }, WAIT);
    expect(
      (await auditOf(pendingId)).find((row) => row["action"] === "domain.recheck_requested"),
    ).toMatchObject({
      details: { hostname: pendingHost, jobs: [DOMAIN_VERIFY_JOB, DOMAIN_TLS_PROBE_JOB] },
    });
    expect(await completedJobsFor(ota.domain.id, 1)).toEqual([DOMAIN_TLS_PROBE_JOB]);
    expect(await domainRow(ota.domain.id)).toMatchObject({ tls_status: "issued" });
    expect((await auditOf(ota.domain.id))[0]).toMatchObject({
      details: { hostname: ota.domain.hostname, jobs: [DOMAIN_TLS_PROBE_JOB] },
    });
    expect(await completedJobsFor(failedId, 1)).toEqual([DOMAIN_TLS_PROBE_JOB]);
    expect(await domainRow(failedId)).toMatchObject({ verification_status: "failed", last_checked_at: null });
  });

  it("[PBE-051 AC3] answers 404 for an unknown host and 503 when a job cannot be queued, with no audit row", async () => {
    const ota = await arrangeOta();
    const domainId = await customDomain(ota, host("redis"), "verified");
    const unknown = testId("dom", 51_996);
    vi.spyOn(t.app.get(DomainJobs, { strict: false }), "enqueueTlsProbe").mockResolvedValueOnce(false);

    const unavailable = await recheck(domainId);
    const missing = await recheck(unknown);

    expect([unavailable.status, errorOf(unavailable).code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect([missing.status, errorOf(missing).code]).toEqual([404, "NOT_FOUND"]);
    expect(await auditOf(domainId)).toEqual([]);
    expect(await auditOf(unknown)).toEqual([]);
  });
});

// ---- adminRemoveDomain ---------------------------------------------------------------------------------------------

describe("adminRemoveDomain", () => {
  it("[PBE-051 AC3] removes an abusive custom domain of a suspended OTA with a reason: the sub-domain is primary again, the hosts are announced and the owners e-mailed", async () => {
    const ota = await arrangeOta("suspended");
    const hostname = host("phish");
    const domainId = await customDomain(ota, hostname, "verified", true);
    await t.redis.client.set(redisKeys.tlsAsk(hostname).key, "1", "EX", 60);

    const res = await remove(domainId, `  ${REASON}  `);

    expect(res.status).toBe(204);
    expect(await domainRow(domainId)).toBeUndefined();
    expect(await domainRow(ota.domain.id)).toMatchObject({ is_primary: true });
    expect(await auditOf(domainId)).toEqual([
      {
        action: "domain.removed",
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        tenant_id: ota.tenant.id,
        details: {
          reason: REASON,
          primaryHostname: ota.domain.hostname,
          before: { hostname, verificationStatus: "verified", isPrimary: true },
        },
      },
    ]);

    const emails = await emailsOf(ota.tenant.id, "domain.removed");
    expect(emails.map((email) => email["account_id"]).sort()).toEqual(ota.owners.map(({ id }) => id).sort());
    expect(emails[0]?.["data"]).toEqual({
      fullName: expect.any(String),
      tenantName: ota.tenant.name,
      tenantKey: ota.tenant.key,
      hostname,
      domainsUrl: `${t.config.PUBLIC_PORTAL_URL}/otas/${ota.tenant.id}/domains`,
    });
    const message = await waitForMessage({ to: ota.owners[0]?.email ?? "", timeoutMs: MAIL_WAIT_MS });
    expect(message.Subject).toBe(`${hostname} was removed from ${ota.tenant.name}`);
    // The reason stays in the audit trail and out of the e-mail.
    expect(JSON.stringify(emails)).not.toContain("88231");

    await settle();
    expect(eventsFor(hostname)).toEqual([{ v: 1, type: "domain", hostname }]);
    expect(eventsFor(ota.domain.hostname)).toEqual([{ v: 1, type: "domain", hostname: ota.domain.hostname }]);
    expect(await t.redis.client.exists(redisKeys.tlsAsk(hostname).key)).toBe(0);
  });

  it("[PBE-051 AC3] removes a pending domain that is not primary without moving any flag", async () => {
    const ota = await arrangeOta();
    const hostname = host("squat");
    const domainId = await customDomain(ota, hostname, "pending");

    expect((await remove(domainId, REASON)).status).toBe(204);

    expect(await domainRow(domainId)).toBeUndefined();
    expect((await auditOf(domainId))[0]?.["details"]).toEqual({
      reason: REASON,
      before: { hostname, verificationStatus: "pending", isPrimary: false },
    });
    await settle();
    expect(eventsFor(hostname)).toEqual([{ v: 1, type: "domain", hostname }]);
    expect(eventsFor(ota.domain.hostname)).toEqual([]);
  });

  it("[PBE-051 AC3] refuses the sub-domain with 409 CONFLICT, a reason of only spaces with 400, and an unknown host with 404; nothing is written", async () => {
    const ota = await arrangeOta();
    const domainId = await customDomain(ota, host("kept"), "verified");
    const unknown = testId("dom", 51_995);

    const subdomain = await remove(ota.domain.id, REASON);
    const blank = await remove(domainId, "        ");
    const short = await remove(domainId, " abc ");
    const missing = await remove(unknown, REASON);

    expect([subdomain.status, errorOf(subdomain)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "subdomain" } }),
    ]);
    expect([blank.status, errorOf(blank).code, errorOf(blank).fieldErrors?.[0]?.path]).toEqual([
      400,
      "VALIDATION_FAILED",
      "/reason",
    ]);
    expect([short.status, errorOf(short).code]).toEqual([400, "VALIDATION_FAILED"]);
    expect([missing.status, errorOf(missing).code]).toEqual([404, "NOT_FOUND"]);
    expect(await domainRow(ota.domain.id)).toMatchObject({ is_primary: true });
    expect(await domainRow(domainId)).toMatchObject({ verification_status: "verified" });
    expect(await auditOf(ota.domain.id)).toEqual([]);
    expect(await auditOf(domainId)).toEqual([]);
    expect(await emailsOf(ota.tenant.id, "domain.removed")).toEqual([]);
  });
});
