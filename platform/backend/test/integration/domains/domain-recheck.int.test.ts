// The TLS probe and the daily DNS re-check of storefront hosts (PBE-051; platform/docs/flows/custom-domains.md steps 4
// and 6, PADR-0004 items 5 and 7, architecture §5 `domains.recheck_verified` and `domains.tls_probe`; scope PF-41 AC3).
// The worker's module graph (WorkerModule, as dist/worker.js builds it, with the API's FakeClock) runs `domain.tls_probe`,
// `domain.recheck` and the two daily handlers on this file's database clone and Redis database; the API
// (createTestApp) only provides them and the platform document.
//
// - The probe connects to TLS_PROBE_TARGET instead of Caddy on `127.0.0.1:443`: a local TLS server whose self-signed
//   certificate names `*.example.net` and `*.ota.example.com` (the hosts of this file), or a TCP server that closes every
//   connection before TLS (test/support/tls-server.ts). Each test points the target at the server it needs.
// - The worker's resolver is a fake (DNS_RESOLVER): each test writes the records its domains need, so no test asks a
//   real DNS server.
// - The `domain` events of `vx:invalidate` are read by a subscriber that keeps the events of this file's hosts and its
//   own markers (Redis pub/sub is not scoped to a database index). Owners have `uniqueEmail` addresses, and the worker's
//   e-mail processor sends to Mailpit.
//
// Jobs are added to `platform-domains` the way their producers add them, and each test waits for its jobs to complete
// before it looks at rows, so no test depends on the timing of another's jobs. The daily runs come last: they queue a
// job for every matching domain of the clone, and wait for all of them.
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { responseChecker } from "@velexis/testing";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Job, Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry, PLATFORM_SCHEDULES } from "../../../src/common/queues/scheduler.registry";
import { redisKeys } from "../../../src/common/redis/redis-keys";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { DNS_RESOLVER } from "../../../src/domains/dns.gateway";
import {
  DOMAIN_FAILURE_TEXT,
  DOMAIN_RECHECK_JOB,
  DOMAIN_TLS_PROBE_JOB,
  RECHECK_FAILURE_LIMIT,
  UTC_DAY_MS,
} from "../../../src/domains/domain-checks.processor";
import {
  DNS_CHECK_ERROR_TEXT,
  ownershipRecordName,
  type DnsResolver,
} from "../../../src/domains/domain-checks";
import {
  dailyJobId,
  DOMAINS_RECHECK_VERIFIED_JOB,
  DOMAINS_TLS_PROBE_JOB,
} from "../../../src/domains/recheck.scheduler";
import { TLS_PROBE_TARGET, type TlsProbeTarget } from "../../../src/domains/tls-probe";
import { WorkerModule } from "../../../src/worker.module";
import { insertAccount, insertPlan, insertTenantDomain, testId } from "../../builders/platform-rows";
import { insertOta, TEST_BASE_DOMAIN, type InsertedOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import {
  startRefusingServer,
  startTlsServer,
  type LocalServer,
  type LocalTlsServer,
} from "../../support/tls-server";

/**
 * The database clone, the API's and the worker's Nest module graphs, the platform document and the two local servers
 * (one `openssl` call); the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish a job (it takes milliseconds; under Vitest's 5 s). */
const WAIT = { timeout: 3_000, interval: 20 } as const;
/** How long a test waits for the worker's e-mail to reach Mailpit. */
const MAIL_WAIT_MS = 3_000;
/** How long a marker may take to come back on `vx:invalidate`: pub/sub on the loopback interface takes milliseconds. */
const MARKER_WAIT_MS = 3_000;
/** The storefront addresses of this application: the placeholders of `.env.example` (RFC 5737, RFC 3849). */
const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";
/** The value of the builder's custom domains (the shape addDomain gives). */
const TOKEN = "vx-verify-K7Q4M2XP9TRWH5ZDB3NV8QKE1MZT6RYC";
const HOUR_MS = 60 * 60 * 1000;

type Row = Record<string, unknown>;
type RecordType = "TXT" | "CNAME" | "A" | "AAAA";

/**
 * The worker's resolver in this file: a table of records (`TXT _velexis.<host>`, `CNAME <host>`, …) that the tests
 * write and clear. A question without records answers ENODATA when the name has records of another type, else
 * ENOTFOUND, as a public resolver does.
 */
class FakeResolver implements DnsResolver {
  private readonly records = new Map<string, unknown[]>();

  set(type: RecordType, name: string, values: unknown[]): void {
    this.records.set(`${type} ${name}`, values);
  }

  clear(type: RecordType, name: string): void {
    this.records.delete(`${type} ${name}`);
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
/** The worker's probe target: each test points it at the server it needs. */
const probeTarget: { host: string; port: number } = { host: "127.0.0.1", port: 0 };
const workerLogs = new LogSink();
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let domainsQueue: Queue;
let maintenanceQueue: Queue;
let subscriber: Redis;
let tlsServer: LocalTlsServer;
let refusingServer: LocalServer;
/** A plan with two custom domains. */
let planCode = "";

/** The host names of this file (and its markers): the subscriber keeps their `domain` events only. */
const watched = new Set<string>();
/** The kept events, in the order they arrived. */
const received: InvalidationEvent[] = [];

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs, the platform document and the local servers.
  t = await createTestApp({
    env: { FEATURE_CUSTOM_DOMAINS: "true", STOREFRONT_IPV4: IPV4, STOREFRONT_IPV6: IPV6 },
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  domainsQueue = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.domains), { strict: false });
  maintenanceQueue = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.maintenance), { strict: false });
  responseChecker("platform");
  planCode = (await insertPlan(pool, { limits: { staffSeats: 5, apiKeys: 10, customDomains: 2 } })).code;
  tlsServer = await startTlsServer(["*.example.net", `*.${TEST_BASE_DOMAIN}`]);
  refusingServer = await startRefusingServer();
  pointProbeAt(tlsServer);

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .overrideProvider(DNS_RESOLVER)
    .useValue(resolver)
    .overrideProvider(TLS_PROBE_TARGET)
    .useValue(probeTarget satisfies TlsProbeTarget)
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
  await refusingServer?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

// ---- Arrangement ---------------------------------------------------------------------------------------------------

function pointProbeAt(server: LocalServer): void {
  probeTarget.host = server.host;
  probeTarget.port = server.port;
}

/** An OTA of this file: two owners and an admin, on the plan with custom domains; its sub-domain is watched. */
interface Ota extends InsertedOta {
  readonly owners: ReadonlyArray<{ readonly id: string; readonly email: string }>;
}

async function arrangeOta(status = "active"): Promise<Ota> {
  const owner = await insertAccount(pool, { email: uniqueEmail("owner-pbe051"), full_name: "Ana Lima" });
  const coOwner = await insertAccount(pool, {
    email: uniqueEmail("co-owner-pbe051"),
    full_name: "Lena Holm",
  });
  const admin = await insertAccount(pool, { email: uniqueEmail("admin-pbe051") });
  const inserted = await insertOta(pool, {
    tenant: { plan_code: planCode, status },
    members: [
      [owner, "owner"],
      [coOwner, "owner"],
      [admin, "admin"],
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

/** A host name of this file: `<label>-<random>.example.net`, watched for `domain` events. */
function host(label: string): string {
  const hostname = `${label}-${randomBytes(4).toString("hex")}.example.net`;
  watched.add(hostname);
  return hostname;
}

/** A verified custom domain written by the builder (no event); primary when asked, the sub-domain then not. */
async function verifiedDomain(
  ota: Ota,
  hostname: string,
  overrides: { primary?: boolean; failures?: number; tlsStatus?: string } = {},
): Promise<string> {
  if (overrides.primary === true) {
    await pool.query("UPDATE platform.tenant_domains SET is_primary = false WHERE id = $1", [ota.domain.id]);
  }
  const row = await insertTenantDomain(pool, ota.tenant, {
    hostname,
    kind: "custom",
    is_primary: overrides.primary === true,
    verification_status: "verified",
    verification_token: TOKEN,
    verification_deadline_at: new Date(t.clock.now().getTime() - HOUR_MS),
    verified_at: t.clock.now(),
    check_failures: overrides.failures ?? 0,
    ...(overrides.tlsStatus === undefined ? {} : { tls_status: overrides.tlsStatus }),
  });
  return row.id;
}

/** Writes the records of a correctly configured domain: the TXT record and the CNAME to the OTA's sub-domain. */
function publishRecords(ota: Ota, hostname: string): void {
  resolver.set("TXT", ownershipRecordName(hostname), [[TOKEN]]);
  resolver.set("CNAME", hostname, [`${ota.tenant.key}.${TEST_BASE_DOMAIN}`]);
}

/** Removes the domain's CNAME: its routing proof fails (`cname_missing`), as when the owner moves the host away. */
function withdrawRouting(hostname: string): void {
  resolver.clear("CNAME", hostname);
}

// ---- Rows, jobs and events -----------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[] = []): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const domainRow = async (id: string): Promise<Row> =>
  (await rowsOf("SELECT * FROM platform.tenant_domains WHERE id = $1", [id]))[0] as Row;

const auditOf = (targetId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT action, actor_type, actor_label, tenant_id, details FROM platform.platform_audit_log " +
      "WHERE target_id = $1 ORDER BY id",
    [targetId],
  );

const emailsOf = (tenantId: string, template: string): Promise<Row[]> =>
  rowsOf(
    "SELECT template, to_email, account_id, data FROM platform.email_outbox " +
      "WHERE tenant_id = $1 AND template = $2 ORDER BY to_email",
    [tenantId, template],
  );

/**
 * Adds `name {domainId}` to `platform-domains` and answers what the finished job returned. The state is read before
 * the job, so the job read is one of a finished job (with its return value).
 */
async function runJob(name: string, domainId: string): Promise<unknown> {
  const job = await domainsQueue.add(name, { domainId });
  return vi.waitFor(async () => {
    expect(await domainsQueue.getJobState(job.id ?? "")).toBe("completed");
    return (await domainsQueue.getJob(job.id ?? ""))?.returnvalue as unknown;
  }, WAIT);
}

/** Runs a daily schedule's job through the `platform-maintenance` processor and answers its result. */
async function runSchedule(scheduleId: string): Promise<{ domains: number; queued: number }> {
  // What the job scheduler adds every day: a job named after the schedule, with an empty payload.
  const run = await maintenanceQueue.add(scheduleId, {});
  return vi.waitFor(async () => {
    expect(await maintenanceQueue.getJobState(run.id ?? "")).toBe("completed");
    return (await maintenanceQueue.getJob(run.id ?? ""))?.returnvalue as { domains: number; queued: number };
  }, WAIT);
}

/** Waits until every job of `ids` has completed on `platform-domains`. */
async function waitForJobs(ids: readonly string[]): Promise<Job[]> {
  return vi.waitFor(async () => {
    const jobs = await Promise.all(ids.map((id) => domainsQueue.getJob(id)));
    for (const job of jobs) {
      expect(await job?.getState()).toBe("completed");
    }
    return jobs as Job[];
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

/** The `domain` events received for `hostname`. */
const eventsFor = (hostname: string): InvalidationEvent[] =>
  received.filter((event) => event.type === "domain" && event.hostname === hostname);

// ---- domain.tls_probe ----------------------------------------------------------------------------------------------

describe("domain.tls_probe: the worker's TLS probe", () => {
  it("[PBE-051 AC1] stores issued and the certificate's expiry for a local TLS server, and announces the host only when tls_status changes", async () => {
    const ota = await arrangeOta();
    const hostname = host("probe");
    const domainId = await verifiedDomain(ota, hostname);
    pointProbeAt(tlsServer);

    const result = await runJob(DOMAIN_TLS_PROBE_JOB, domainId);

    expect(result).toEqual({ domainId, status: "issued", probed: true, changed: true });
    // The worker connected to the target's IP address with the host as SNI.
    expect(tlsServer.servernames).toContain(hostname);
    expect(await domainRow(domainId)).toMatchObject({
      tls_status: "issued",
      tls_expires_at: tlsServer.expiresAt,
      tls_checked_at: t.clock.now(),
      // The probe touches the TLS columns only.
      verification_status: "verified",
      check_failures: 0,
    });
    await settle();
    expect(eventsFor(hostname)).toEqual([{ v: 1, type: "domain", hostname }]);

    // The same outcome a day later: the check time moves, nothing is announced (lead decision (2d) of 2026-11-02).
    t.clock.advance(24 * HOUR_MS);
    expect(await runJob(DOMAIN_TLS_PROBE_JOB, domainId)).toEqual({
      domainId,
      status: "issued",
      probed: true,
      changed: false,
    });
    expect((await domainRow(domainId))["tls_checked_at"]).toEqual(t.clock.now());
    await settle();
    expect(eventsFor(hostname)).toHaveLength(1);
  });

  it("[PBE-051 AC1] stores failed on a handshake error, with no expiry, and announces the change", async () => {
    const ota = await arrangeOta();
    const hostname = host("broken");
    const domainId = await verifiedDomain(ota, hostname, { tlsStatus: "issued" });
    pointProbeAt(refusingServer);

    const result = await runJob(DOMAIN_TLS_PROBE_JOB, domainId);

    expect(result).toEqual({
      domainId,
      status: "failed",
      probed: true,
      changed: true,
      failure: "handshake_failed",
    });
    expect(await domainRow(domainId)).toMatchObject({
      tls_status: "failed",
      tls_expires_at: null,
      tls_checked_at: t.clock.now(),
    });
    await settle();
    expect(eventsFor(hostname)).toEqual([{ v: 1, type: "domain", hostname }]);
    expect(
      [...t.logs.lines, ...workerLogs.lines].filter((line) => line["msg"] === "domains.tls_probed"),
    ).toContainEqual(expect.objectContaining({ domainId, tlsStatus: "failed", failure: "handshake_failed" }));
  });

  it("[PBE-051 AC1] stores expired, with the expiry, once the Clock passes the certificate's valid_to", async () => {
    const ota = await arrangeOta();
    const hostname = host("old");
    const domainId = await verifiedDomain(ota, hostname, { tlsStatus: "issued" });
    pointProbeAt(tlsServer);
    const before = t.clock.now();
    t.clock.set(new Date(tlsServer.expiresAt.getTime() + HOUR_MS));
    try {
      const result = await runJob(DOMAIN_TLS_PROBE_JOB, domainId);

      expect(result).toEqual({ domainId, status: "expired", probed: true, changed: true });
      expect(await domainRow(domainId)).toMatchObject({
        tls_status: "expired",
        tls_expires_at: tlsServer.expiresAt,
        tls_checked_at: t.clock.now(),
      });
    } finally {
      t.clock.set(before);
    }
  });

  it("[PBE-051 AC1] probes the Velexis sub-domain too, and leaves a domain that is gone alone", async () => {
    const ota = await arrangeOta();
    pointProbeAt(tlsServer);
    const gone = testId("dom", 51_999);

    expect(await runJob(DOMAIN_TLS_PROBE_JOB, ota.domain.id)).toEqual({
      domainId: ota.domain.id,
      status: "issued",
      probed: true,
      changed: true,
    });
    expect(await runJob(DOMAIN_TLS_PROBE_JOB, gone)).toEqual({
      domainId: gone,
      status: "missing",
      probed: false,
    });
    expect(await domainRow(ota.domain.id)).toMatchObject({
      tls_status: "issued",
      tls_expires_at: tlsServer.expiresAt,
    });
  });
});

// ---- domain.recheck ------------------------------------------------------------------------------------------------

describe("domain.recheck: the daily DNS re-check", () => {
  it("[PBE-051 AC2] three failed re-checks fail the domain and move the primary flag back to the sub-domain; the owners are e-mailed and both hosts announced", async () => {
    const ota = await arrangeOta();
    const hostname = host("moved");
    const domainId = await verifiedDomain(ota, hostname, { primary: true });
    publishRecords(ota, hostname);
    withdrawRouting(hostname);
    await t.redis.client.set(redisKeys.tlsAsk(hostname).key, "1", "EX", 60);

    // The first two failures count, and nothing else happens.
    for (let failures = 1; failures < RECHECK_FAILURE_LIMIT; failures += 1) {
      expect(await runJob(DOMAIN_RECHECK_JOB, domainId)).toEqual({
        domainId,
        status: "verified",
        checked: true,
        checkFailures: failures,
        error: "cname_missing",
      });
      expect(await domainRow(domainId)).toMatchObject({
        verification_status: "verified",
        is_primary: true,
        check_failures: failures,
        last_check_error: "cname_missing",
        last_checked_at: t.clock.now(),
      });
      t.clock.advance(24 * HOUR_MS);
    }
    await settle();
    expect(eventsFor(hostname)).toEqual([]);
    expect(await emailsOf(ota.tenant.id, "domain.failed")).toEqual([]);

    // The third.
    const third = await runJob(DOMAIN_RECHECK_JOB, domainId);

    expect(third).toEqual({
      domainId,
      status: "failed",
      checked: true,
      checkFailures: RECHECK_FAILURE_LIMIT,
      error: "cname_missing",
      primaryHostname: ota.domain.hostname,
    });
    expect(await domainRow(domainId)).toMatchObject({
      verification_status: "failed",
      is_primary: false,
      check_failures: RECHECK_FAILURE_LIMIT,
      last_check_error: "cname_missing",
    });
    expect(await domainRow(ota.domain.id)).toMatchObject({ is_primary: true });
    const primaries = await rowsOf(
      "SELECT id FROM platform.tenant_domains WHERE tenant_id = $1 AND purpose = 'storefront' AND is_primary",
      [ota.tenant.id],
    );
    expect(primaries).toEqual([{ id: ota.domain.id }]);

    expect(await auditOf(domainId)).toEqual([
      {
        action: "domain.recheck_failed",
        actor_type: "system",
        actor_label: "domain.recheck",
        tenant_id: ota.tenant.id,
        details: {
          hostname,
          primaryHostname: ota.domain.hostname,
          before: { verificationStatus: "verified", isPrimary: true },
          after: {
            verificationStatus: "failed",
            isPrimary: false,
            lastCheckError: "cname_missing",
            checkFailures: RECHECK_FAILURE_LIMIT,
          },
        },
      },
    ]);
    // The token is published in DNS, but has no place in the audit trail.
    expect(JSON.stringify(await auditOf(domainId))).not.toContain(TOKEN);

    const emails = await emailsOf(ota.tenant.id, "domain.failed");
    expect(emails.map((email) => email["account_id"]).sort()).toEqual(ota.owners.map(({ id }) => id).sort());
    expect(emails[0]?.["data"]).toMatchObject({
      tenantName: ota.tenant.name,
      tenantKey: ota.tenant.key,
      hostname,
      failure: DOMAIN_FAILURE_TEXT.recheck,
      reason: DNS_CHECK_ERROR_TEXT.cname_missing,
      domainsUrl: `${t.config.PUBLIC_PORTAL_URL}/otas/${ota.tenant.id}/domains`,
    });
    const message = await waitForMessage({ to: ota.owners[1]?.email ?? "", timeoutMs: MAIL_WAIT_MS });
    expect(message.Subject).toBe(`${hostname} could not be verified for ${ota.tenant.name}`);

    await settle();
    expect(eventsFor(hostname)).toEqual([{ v: 1, type: "domain", hostname }]);
    expect(eventsFor(ota.domain.hostname)).toEqual([{ v: 1, type: "domain", hostname: ota.domain.hostname }]);
    // TLS `ask` stops answering 200 for the host at once (PADR-0004 item 6).
    expect(await t.redis.client.exists(redisKeys.tlsAsk(hostname).key)).toBe(0);

    // A failed domain is no longer re-checked.
    expect(await runJob(DOMAIN_RECHECK_JOB, domainId)).toEqual({
      domainId,
      status: "failed",
      checked: false,
    });
  });

  it("[PBE-051 AC2] one passing re-check resets the count of failures", async () => {
    const ota = await arrangeOta();
    const hostname = host("flaky");
    const domainId = await verifiedDomain(ota, hostname, { failures: RECHECK_FAILURE_LIMIT - 1 });
    publishRecords(ota, hostname);

    const result = await runJob(DOMAIN_RECHECK_JOB, domainId);

    expect(result).toEqual({ domainId, status: "verified", checked: true, checkFailures: 0 });
    expect(await domainRow(domainId)).toMatchObject({
      verification_status: "verified",
      check_failures: 0,
      last_check_error: null,
      last_checked_at: t.clock.now(),
    });
    // So the next failure is the first again.
    withdrawRouting(hostname);
    expect(await runJob(DOMAIN_RECHECK_JOB, domainId)).toMatchObject({
      status: "verified",
      checkFailures: 1,
    });
    await settle();
    expect(eventsFor(hostname)).toEqual([]);
    expect(await auditOf(domainId)).toEqual([]);
  });

  it("[FIX-W41-PLATFORM AC2] a second failing re-check the same UTC day stores its check and adds no strike; the next UTC day's counts", async () => {
    const ota = await arrangeOta();
    const hostname = host("twice");
    const domainId = await verifiedDomain(ota, hostname);
    publishRecords(ota, hostname);
    withdrawRouting(hostname);
    // 04:10 UTC of the next day, so both checks below fall on one UTC day whatever the earlier tests did to the clock.
    t.clock.set((Math.floor(t.clock.now().getTime() / UTC_DAY_MS) + 1) * UTC_DAY_MS + 250 * 60 * 1000);

    const first = await runJob(DOMAIN_RECHECK_JOB, domainId);
    // Later that day the TXT record goes too: the check and its error are stored, the count stays.
    resolver.clear("TXT", ownershipRecordName(hostname));
    t.clock.advance(19 * HOUR_MS);
    const second = await runJob(DOMAIN_RECHECK_JOB, domainId);

    expect(first).toEqual({
      domainId,
      status: "verified",
      checked: true,
      checkFailures: 1,
      error: "cname_missing",
    });
    expect(second).toEqual({
      domainId,
      status: "verified",
      checked: true,
      checkFailures: 1,
      counted: false,
      error: "txt_missing",
    });
    expect(await domainRow(domainId)).toMatchObject({
      verification_status: "verified",
      check_failures: 1,
      last_check_error: "txt_missing",
      last_checked_at: t.clock.now(),
    });

    // The next UTC day, a failure counts again.
    t.clock.advance(HOUR_MS);
    expect(await runJob(DOMAIN_RECHECK_JOB, domainId)).toEqual({
      domainId,
      status: "verified",
      checked: true,
      checkFailures: 2,
      error: "txt_missing",
    });
    await settle();
    expect(eventsFor(hostname)).toEqual([]);
    expect(await auditOf(domainId)).toEqual([]);
  });

  it("[PBE-051 AC2] a domain that was not primary fails without moving any flag; only its host is announced", async () => {
    const ota = await arrangeOta();
    const hostname = host("spare");
    const domainId = await verifiedDomain(ota, hostname, { failures: RECHECK_FAILURE_LIMIT - 1 });
    resolver.set("TXT", ownershipRecordName(hostname), [["vx-verify-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]]);
    resolver.set("CNAME", hostname, [`${ota.tenant.key}.${TEST_BASE_DOMAIN}`]);

    const result = await runJob(DOMAIN_RECHECK_JOB, domainId);

    expect(result).toEqual({
      domainId,
      status: "failed",
      checked: true,
      checkFailures: RECHECK_FAILURE_LIMIT,
      error: "txt_mismatch",
    });
    expect(await domainRow(ota.domain.id)).toMatchObject({ is_primary: true });
    expect((await auditOf(domainId))[0]?.["details"]).not.toHaveProperty("primaryHostname");
    await settle();
    expect(eventsFor(hostname)).toEqual([{ v: 1, type: "domain", hostname }]);
    expect(eventsFor(ota.domain.hostname)).toEqual([]);
  });

  it("[PBE-051 AC2] leaves pending domains, the sub-domain and domains that are gone alone", async () => {
    const ota = await arrangeOta();
    const pending = await insertTenantDomain(pool, ota.tenant, {
      hostname: host("waiting"),
      kind: "custom",
      verification_status: "pending",
      verification_token: TOKEN,
      verification_deadline_at: new Date(t.clock.now().getTime() + 72 * HOUR_MS),
      verified_at: null,
    });
    const gone = testId("dom", 51_998);

    expect(await runJob(DOMAIN_RECHECK_JOB, pending.id)).toEqual({
      domainId: pending.id,
      status: "pending",
      checked: false,
    });
    expect(await runJob(DOMAIN_RECHECK_JOB, ota.domain.id)).toEqual({
      domainId: ota.domain.id,
      status: "verified",
      checked: false,
    });
    expect(await runJob(DOMAIN_RECHECK_JOB, gone)).toEqual({
      domainId: gone,
      status: "missing",
      checked: false,
    });
    expect(await domainRow(pending.id)).toMatchObject({ last_checked_at: null, check_failures: 0 });
  });
});

// ---- The daily runs ------------------------------------------------------------------------------------------------

describe("the daily runs", () => {
  it("[PBE-051 AC2] domains.recheck_verified queues one domain.recheck per verified custom domain, once a day", async () => {
    const ota = await arrangeOta();
    const kept = host("kept");
    const keptId = await verifiedDomain(ota, kept);
    publishRecords(ota, kept);
    const failedId = (
      await insertTenantDomain(pool, ota.tenant, {
        hostname: host("dead"),
        kind: "custom",
        verification_status: "failed",
        verification_token: TOKEN,
        verified_at: null,
      })
    ).id;
    const ids = (
      await rowsOf(
        "SELECT id FROM platform.tenant_domains WHERE kind = 'custom' AND verification_status = 'verified' " +
          "ORDER BY created_at, id",
      )
    ).map((row) => row["id"] as string);
    expect(PLATFORM_SCHEDULES.find((schedule) => schedule.id === DOMAINS_RECHECK_VERIFIED_JOB)).toMatchObject(
      {
        pattern: "10 4 * * *",
        features: ["custom_domains"],
      },
    );

    const first = await runSchedule(DOMAINS_RECHECK_VERIFIED_JOB);
    const second = await runSchedule(DOMAINS_RECHECK_VERIFIED_JOB);

    expect(first).toEqual({ domains: ids.length, queued: ids.length });
    expect(second).toEqual({ domains: ids.length, queued: ids.length });
    const jobIds = ids.map((id) => dailyJobId(DOMAIN_RECHECK_JOB, id, t.clock.now()));
    const jobs = await waitForJobs(jobIds);
    // One job per domain and day: the second run of the same day found the first one's.
    expect(jobs.map((job) => job.name)).toEqual(ids.map(() => DOMAIN_RECHECK_JOB));
    expect(jobIds).toContain(dailyJobId(DOMAIN_RECHECK_JOB, keptId, t.clock.now()));
    // The run queued nothing for the failed domain or the sub-domain (the queue itself is asked, not the list above).
    expect(
      await domainsQueue.getJob(dailyJobId(DOMAIN_RECHECK_JOB, failedId, t.clock.now())),
    ).toBeUndefined();
    expect(
      await domainsQueue.getJob(dailyJobId(DOMAIN_RECHECK_JOB, ota.domain.id, t.clock.now())),
    ).toBeUndefined();
    expect(await domainRow(keptId)).toMatchObject({ check_failures: 0, last_checked_at: t.clock.now() });
    expect(await domainRow(failedId)).toMatchObject({ last_checked_at: null });
  });

  it("[PBE-051 AC1] domains.tls_probe queues one domain.tls_probe per verified storefront host of a served OTA, once a day", async () => {
    pointProbeAt(tlsServer);
    const ota = await arrangeOta("suspended");
    const customId = await verifiedDomain(ota, host("served"));
    const failedOta = await arrangeOta("failed");
    const pendingId = (
      await insertTenantDomain(pool, ota.tenant, {
        hostname: host("unproven"),
        kind: "custom",
        verification_status: "pending",
        verification_token: TOKEN,
        verified_at: null,
      })
    ).id;
    const ids = (
      await rowsOf(
        "SELECT d.id FROM platform.tenant_domains d JOIN platform.tenants t ON t.id = d.tenant_id " +
          "WHERE d.purpose = 'storefront' AND d.verification_status = 'verified' " +
          "AND t.status IN ('provisioning', 'active', 'suspended') ORDER BY d.created_at, d.id",
      )
    ).map((row) => row["id"] as string);
    expect(PLATFORM_SCHEDULES.find((schedule) => schedule.id === DOMAINS_TLS_PROBE_JOB)).toMatchObject({
      pattern: "40 4 * * *",
      features: ["custom_domains"],
    });

    const first = await runSchedule(DOMAINS_TLS_PROBE_JOB);
    const second = await runSchedule(DOMAINS_TLS_PROBE_JOB);

    expect(first).toEqual({ domains: ids.length, queued: ids.length });
    expect(second).toEqual({ domains: ids.length, queued: ids.length });
    const jobIds = ids.map((id) => dailyJobId(DOMAIN_TLS_PROBE_JOB, id, t.clock.now()));
    await waitForJobs(jobIds);
    // The suspended OTA's sub-domain and custom domain are probed; the failed OTA's host and the pending domain not.
    expect(jobIds).toEqual(
      expect.arrayContaining([
        dailyJobId(DOMAIN_TLS_PROBE_JOB, ota.domain.id, t.clock.now()),
        dailyJobId(DOMAIN_TLS_PROBE_JOB, customId, t.clock.now()),
      ]),
    );
    // The run queued nothing for the failed OTA's host or the pending domain (the queue itself is asked).
    expect(
      await domainsQueue.getJob(dailyJobId(DOMAIN_TLS_PROBE_JOB, failedOta.domain.id, t.clock.now())),
    ).toBeUndefined();
    expect(
      await domainsQueue.getJob(dailyJobId(DOMAIN_TLS_PROBE_JOB, pendingId, t.clock.now())),
    ).toBeUndefined();
    for (const domainId of [ota.domain.id, customId]) {
      expect(await domainRow(domainId)).toMatchObject({
        tls_status: "issued",
        tls_checked_at: t.clock.now(),
      });
    }
    expect(await domainRow(failedOta.domain.id)).toMatchObject({
      tls_status: "pending",
      tls_checked_at: null,
    });
    expect(await domainRow(pendingId)).toMatchObject({ tls_status: "pending", tls_checked_at: null });
  });
});
