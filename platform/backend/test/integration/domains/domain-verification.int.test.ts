// The DNS verification of custom domains (PBE-050; platform/docs/flows/custom-domains.md step 2 and "Failure handling",
// PADR-0004 items 2 to 4, api-inventory-resources.md §2 `checkDomain`; scope PF-41 AC2). The API (createTestApp) adds
// and checks domains through the HTTP pipeline; the worker's module graph (WorkerModule, as dist/worker.js builds it,
// with the API's FakeClock) runs `domain.verify` and the `domains.verify_pending` handler from the same Redis database
// and database clone. The worker's resolver is a fake (DNS_RESOLVER): each test writes the records it needs into its
// record table, so no test asks a real DNS server. Every answer is checked against the platform document.
//
// The `domain` events of `vx:invalidate` are read by a subscriber that keeps the events of this file's hosts and its
// own markers (Redis pub/sub is not scoped to a database index). Every address is a `uniqueEmail` of this file, and
// the worker's e-mail processor sends to Mailpit. Host names are documentation names (RFC 2606) with a random label.
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
import { JobSchedulerRegistry, PLATFORM_SCHEDULES } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { DNS_RESOLVER } from "../../../src/domains/dns.gateway";
import {
  DOMAIN_TLS_PROBE_JOB,
  DOMAIN_VERIFY_JOB,
  DomainJobs,
  TLS_PROBE_DELAY_MS,
} from "../../../src/domains/domain-checks.processor";
import {
  DNS_CHECK_ERROR_TEXT,
  ownershipRecordName,
  type DnsCheckError,
  type DnsResolver,
} from "../../../src/domains/domain-checks";
import { VERIFICATION_WINDOW_MS } from "../../../src/domains/domains.service";
import {
  DOMAINS_VERIFY_PENDING_JOB,
  verifyPendingJobId,
  VerifyPendingScheduler,
} from "../../../src/domains/verify-pending.scheduler";
import { WorkerModule } from "../../../src/worker.module";
import { insertAccount, insertPlan, insertTenantDomain, testId } from "../../builders/platform-rows";
import { insertOta, TEST_BASE_DOMAIN, type InsertedOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/**
 * The database clone, the API's and the worker's Nest module graphs and the platform document of
 * expectResponseToMatch; the bound allows for the parallel load of a 4-CPU CI runner.
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
/** A documentation address (RFC 5737) of the people. */
const PERSON_IP = "203.0.113.50";
const FAMILY = testId("asn", 50_001);
/** The value of the builder's custom domains (the shape addDomain gives). */
const BUILDER_TOKEN = "vx-verify-K7Q4M2XP9TRWH5ZDB3NV8QKE1MZT6RYC";
const HOUR_MS = 60 * 60 * 1000;

type Row = Record<string, unknown>;
type RecordType = "TXT" | "CNAME" | "A" | "AAAA";

/**
 * The worker's resolver in this file: a table of records (`TXT _velexis.<host>`, `CNAME <host>`, …) that the tests
 * write. A question without records answers ENODATA when the name has records of another type, else ENOTFOUND, as a
 * public resolver does; `failures` makes a question fail with another `dns` code; `hold` keeps the next answer to a
 * question back until the test releases it.
 */
class FakeResolver implements DnsResolver {
  private readonly records = new Map<string, unknown[]>();
  private readonly failures = new Map<string, string>();
  private readonly held = new Map<string, { readonly asked: () => void; readonly released: Promise<void> }>();

  set(type: RecordType, name: string, values: unknown[]): void {
    this.records.set(`${type} ${name}`, values);
  }

  fail(type: RecordType, name: string, code: string): void {
    this.failures.set(`${type} ${name}`, code);
  }

  /** Holds the next answer to the question: `asked` settles when it is asked, `release` lets it answer. */
  hold(type: RecordType, name: string): { readonly asked: Promise<void>; readonly release: () => void } {
    let release = (): void => undefined;
    let asked = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wasAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    this.held.set(`${type} ${name}`, { asked, released });
    return { asked: wasAsked, release };
  }

  private async answer<T>(type: RecordType, name: string): Promise<T[]> {
    const key = `${type} ${name}`;
    const held = this.held.get(key);
    if (held !== undefined) {
      this.held.delete(key);
      held.asked();
      await held.released;
    }
    const failure = this.failures.get(key);
    if (failure !== undefined) {
      throw Object.assign(new Error(`query failed: ${failure}`), { code: failure });
    }
    const values = this.records.get(key);
    if (values !== undefined) {
      return values as T[];
    }
    const exists = [...this.records.keys()].some((entry) => entry.endsWith(` ${name}`));
    const code = exists ? "ENODATA" : "ENOTFOUND";
    throw Object.assign(new Error(`query failed: ${code}`), { code });
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
let maintenanceQueue: Queue;
let subscriber: Redis;
/** A plan with two custom domains. */
let planCode = "";

/** The host names of this file (and its markers): the subscriber keeps their `domain` events only. */
const watched = new Set<string>();
/** The kept events, in the order they arrived. */
const received: InvalidationEvent[] = [];

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs and the platform document of expectResponseToMatch.
  t = await createTestApp({
    env: { FEATURE_CUSTOM_DOMAINS: "true", STOREFRONT_IPV4: IPV4, STOREFRONT_IPV6: IPV6 },
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  domainsQueue = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.domains), { strict: false });
  maintenanceQueue = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.maintenance), { strict: false });
  responseChecker("platform");
  planCode = (await insertPlan(pool, { limits: { staffSeats: 5, apiKeys: 10, customDomains: 2 } })).code;

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .overrideProvider(DNS_RESOLVER)
    .useValue(resolver)
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
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---- Arrangement ---------------------------------------------------------------------------------------------------

/** An OTA of this file and its people: two owners, an admin, an agent; active and on the plan with custom domains. */
interface Ota extends InsertedOta {
  readonly owners: ReadonlyArray<{ readonly id: string; readonly email: string }>;
  readonly admin: string;
  readonly agent: string;
}

async function arrangeOta(status = "active"): Promise<Ota> {
  const owner = await insertAccount(pool, { email: uniqueEmail("owner-pbe050"), full_name: "Ana Lima" });
  const coOwner = await insertAccount(pool, {
    email: uniqueEmail("co-owner-pbe050"),
    full_name: "Lena Holm",
  });
  const admin = await insertAccount(pool, { email: uniqueEmail("admin-pbe050") });
  const agent = await insertAccount(pool, { email: uniqueEmail("agent-pbe050") });
  const inserted = await insertOta(pool, {
    tenant: { plan_code: planCode, status },
    members: [
      [owner, "owner"],
      [coOwner, "owner"],
      [admin, "admin"],
      [agent, "agent"],
    ],
  });
  watched.add(inserted.domain.hostname);
  return {
    ...inserted,
    owners: [
      { id: owner.id, email: owner.email },
      { id: coOwner.id, email: coOwner.email },
    ],
    admin: admin.id,
    agent: agent.id,
  };
}

/** A host name of this file: `<label>-<random>.example.net`, watched for `domain` events. */
function host(label: string): string {
  const hostname = `${label}-${randomBytes(4).toString("hex")}.example.net`;
  watched.add(hostname);
  return hostname;
}

/** `Authorization: Bearer` with a fresh portal token of `accountId`, at the FakeClock's time. */
async function bearer(accountId: string): Promise<Record<string, string>> {
  const { token } = await tokens.sign({ aud: "portal", sub: accountId, sid: FAMILY, ev: true, amr: ["pwd"] });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

const domainsUrl = (tenantId: string): string => `/v1/tenants/${tenantId}/domains`;

/** The Domain of the platform document, as the tests read it. */
interface DomainBody {
  readonly id: string;
  readonly hostname: string;
  readonly verificationStatus: string;
  readonly dnsRecords: Array<{ type: string; name: string; value: string }>;
  readonly verificationDeadlineAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckError: string | null;
}

/** `addDomain` by the first owner; answers the new domain. */
async function addDomain(ota: Ota, hostname: string): Promise<DomainBody> {
  const res = await t.http
    .post(domainsUrl(ota.tenant.id))
    .set(await bearer(ota.owners[0]?.id ?? ""))
    .send({ hostname });
  expectResponseToMatch("addDomain", res, { document: "platform" });
  expect(res.status).toBe(201);
  return res.body as DomainBody;
}

/** `checkDomain` by `accountId`, checked against the document. */
async function check(ota: Pick<Ota, "tenant">, domainId: string, accountId: string): Promise<Response> {
  const res = await t.http
    .post(`${domainsUrl(ota.tenant.id)}/${domainId}/check`)
    .set(await bearer(accountId));
  expectResponseToMatch("checkDomain", res, { document: "platform" });
  return res;
}

/** A custom domain written by the builder (no event): `pending` with a deadline 72 hours ahead unless said otherwise. */
async function customDomain(
  ota: Pick<Ota, "tenant">,
  hostname: string,
  overrides: { status?: "pending" | "verified" | "failed"; deadline?: Date } = {},
): Promise<string> {
  const status = overrides.status ?? "pending";
  const row = await insertTenantDomain(pool, ota.tenant, {
    hostname,
    kind: "custom",
    verification_status: status,
    verification_token: BUILDER_TOKEN,
    verification_deadline_at: overrides.deadline ?? new Date(t.clock.now().getTime() + 72 * HOUR_MS),
    verified_at: status === "verified" ? t.clock.now() : null,
  });
  return row.id;
}

/** Writes the records of a correctly configured domain: the TXT record and the CNAME to the OTA's sub-domain. */
function publishCname(ota: Pick<Ota, "tenant">, hostname: string, token: string): void {
  resolver.set("TXT", ownershipRecordName(hostname), [[token]]);
  resolver.set("CNAME", hostname, [`${ota.tenant.key}.${TEST_BASE_DOMAIN}`]);
}

// ---- Rows, jobs and events -----------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[]): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const domainRow = async (id: string): Promise<Row> =>
  (await rowsOf("SELECT * FROM platform.tenant_domains WHERE id = $1", [id]))[0] as Row;

const auditOf = (targetId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT action, actor_type, actor_label, actor_account_id, tenant_id, details " +
      "FROM platform.platform_audit_log WHERE target_id = $1 ORDER BY id",
    [targetId],
  );

const emailsOf = (tenantId: string, template: string): Promise<Row[]> =>
  rowsOf(
    "SELECT template, to_email, account_id, data FROM platform.email_outbox " +
      "WHERE tenant_id = $1 AND template = $2 ORDER BY to_email",
    [tenantId, template],
  );

/** Waits until the domain row satisfies `ready`; answers it. */
async function waitForRow(id: string, ready: (row: Row) => boolean): Promise<Row> {
  return vi.waitFor(async () => {
    const row = await domainRow(id);
    expect(ready(row), `the row of ${id}`).toBe(true);
    return row;
  }, WAIT);
}

/** Waits until the domain's last check is stored (`last_checked_at` set); answers the row. */
const waitForCheck = (id: string): Promise<Row> => waitForRow(id, (row) => row["last_checked_at"] !== null);

/** The jobs of the queue named `name` for the domain, in any state. */
async function jobsFor(name: string, domainId: string): Promise<Job[]> {
  const jobs = await domainsQueue.getJobs(["waiting", "active", "delayed", "completed", "failed", "paused"]);
  return jobs.filter((job) => job.name === name && (job.data as { domainId?: string }).domainId === domainId);
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

/**
 * The lines of both processes with this `msg`. nestjs-pino keeps one root logger per process, so the worker graph built
 * after the API may write through the API's sink: the tests read both.
 */
const logsWithMessage = (msg: string): Array<Record<string, unknown>> =>
  [...t.logs.lines, ...workerLogs.lines].filter((line) => line["msg"] === msg);

/** The error code of an envelope answer. */
function errorOf(res: Response): { code: string; details?: unknown } {
  return (res.body as { error: { code: string; details?: unknown } }).error;
}

// ---- domain.verify -------------------------------------------------------------------------------------------------

describe("domain.verify: the worker's DNS check", () => {
  it("[PBE-050 AC1] correct records verify an added domain: verified, audited, the owners e-mailed, the host announced, the TLS probe queued a minute later", async () => {
    const ota = await arrangeOta();
    const hostname = host("travel");
    const added = await addDomain(ota, hostname);
    const token = added.dnsRecords.find((record) => record.type === "TXT")?.value ?? "";
    publishCname(ota, hostname, token);

    const res = await check(ota, added.id, ota.owners[0]?.id ?? "");

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: added.id, hostname, verificationStatus: "pending" });
    const row = await waitForRow(added.id, (stored) => stored["verification_status"] === "verified");
    expect(row).toMatchObject({
      verified_at: t.clock.now(),
      check_failures: 0,
      last_checked_at: t.clock.now(),
      last_check_error: null,
      verification_token: token,
    });

    expect(await auditOf(added.id)).toEqual([
      expect.objectContaining({ action: "domain.added" }),
      expect.objectContaining({
        action: "domain.verified",
        actor_type: "system",
        actor_label: "domain.verify",
        actor_account_id: null,
        tenant_id: ota.tenant.id,
        details: {
          hostname,
          routing: "cname",
          before: { verificationStatus: "pending" },
          after: { verificationStatus: "verified" },
        },
      }),
    ]);
    // The token is published in DNS, but has no place in the audit trail.
    expect(JSON.stringify(await auditOf(added.id))).not.toContain(token);

    // Every active owner, not the admin or the agent, once.
    const emails = await emailsOf(ota.tenant.id, "domain.verified");
    expect(emails.map((email) => email["account_id"]).sort()).toEqual(ota.owners.map(({ id }) => id).sort());
    expect(emails[0]?.["data"]).toMatchObject({
      tenantName: ota.tenant.name,
      tenantKey: ota.tenant.key,
      hostname,
      domainsUrl: `${t.config.PUBLIC_PORTAL_URL}/otas/${ota.tenant.id}/domains`,
    });

    await settle();
    expect(eventsFor(hostname)).toEqual([{ v: 1, type: "domain", hostname }]);

    // The TLS probe of PBE-051 one minute later; until then the processor completes it with a log line.
    const [probe] = await jobsFor(DOMAIN_TLS_PROBE_JOB, added.id);
    expect(probe?.opts.delay).toBe(TLS_PROBE_DELAY_MS);
    expect(probe?.data).toEqual({ domainId: added.id });
    expect(await probe?.getState()).toBe("delayed");
    await probe?.promote();
    await vi.waitFor(async () => {
      const done = await domainsQueue.getJob(probe?.id ?? "");
      expect(await done?.getState()).toBe("completed");
      expect(done?.returnvalue).toEqual({ handled: false });
    }, WAIT);
    expect(logsWithMessage("domains.job_not_handled")).toContainEqual(
      expect.objectContaining({ job: DOMAIN_TLS_PROBE_JOB, domainId: added.id }),
    );

    // The portal's list shows the verified domain.
    const list = await t.http.get(domainsUrl(ota.tenant.id)).set(await bearer(ota.agent));
    expectResponseToMatch("listDomains", list, { document: "platform" });
    expect((list.body as { data: DomainBody[] }).data).toContainEqual(
      expect.objectContaining({ id: added.id, verificationStatus: "verified", lastCheckError: null }),
    );
  });

  it("[PBE-050 AC1] an apex whose A and AAAA records are the storefront addresses is verified", async () => {
    const ota = await arrangeOta();
    const apex = host("apex");
    const domainId = await customDomain(ota, apex);
    resolver.set("TXT", ownershipRecordName(apex), [[BUILDER_TOKEN]]);
    resolver.set("A", apex, [IPV4]);
    resolver.set("AAAA", apex, ["2001:DB8:0:0::10"]);

    expect((await check(ota, domainId, ota.admin)).status).toBe(202);

    await waitForRow(domainId, (row) => row["verification_status"] === "verified");
    expect((await auditOf(domainId)).at(-1)).toMatchObject({
      action: "domain.verified",
      details: { routing: "address" },
    });
  });

  it("[PBE-050 AC1] every error code is stored for the portal, and the domain stays pending before its deadline", async () => {
    const ota = await arrangeOta();
    const cases: Array<[DnsCheckError, (hostname: string) => void]> = [
      ["txt_missing", (h) => resolver.set("CNAME", h, [`${ota.tenant.key}.${TEST_BASE_DOMAIN}`])],
      [
        "txt_mismatch",
        (h) => {
          resolver.set("TXT", ownershipRecordName(h), [["vx-verify-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]]);
          resolver.set("CNAME", h, [`${ota.tenant.key}.${TEST_BASE_DOMAIN}`]);
        },
      ],
      ["cname_missing", (h) => resolver.set("TXT", ownershipRecordName(h), [[BUILDER_TOKEN]])],
      [
        "cname_wrong_target",
        (h) => {
          resolver.set("TXT", ownershipRecordName(h), [[BUILDER_TOKEN]]);
          resolver.set("CNAME", h, [`other.${TEST_BASE_DOMAIN}`]);
        },
      ],
      [
        "a_wrong_address",
        (h) => {
          resolver.set("TXT", ownershipRecordName(h), [[BUILDER_TOKEN]]);
          resolver.set("A", h, ["198.51.100.7"]);
        },
      ],
      [
        "dns_timeout",
        (h) => {
          resolver.fail("TXT", ownershipRecordName(h), "ETIMEOUT");
          resolver.set("CNAME", h, [`${ota.tenant.key}.${TEST_BASE_DOMAIN}`]);
        },
      ],
    ];
    const domains: Array<[DnsCheckError, string]> = [];
    for (const [code, records] of cases) {
      const hostname = host(code.replaceAll("_", "-"));
      const domainId = await customDomain(ota, hostname);
      records(hostname);
      expect((await check(ota, domainId, ota.owners[0]?.id ?? "")).status, code).toBe(202);
      domains.push([code, domainId]);
    }

    for (const [code, domainId] of domains) {
      const row = await waitForCheck(domainId);
      expect(row, code).toMatchObject({
        verification_status: "pending",
        last_check_error: code,
        last_checked_at: t.clock.now(),
        verified_at: null,
      });
      // A failed check before the deadline writes no audit row and sends no e-mail.
      expect(await auditOf(domainId), code).toEqual([]);
    }
    expect(await emailsOf(ota.tenant.id, "domain.failed")).toEqual([]);

    const list = await t.http.get(domainsUrl(ota.tenant.id)).set(await bearer(ota.agent));
    expectResponseToMatch("listDomains", list, { document: "platform" });
    const listed = new Map((list.body as { data: DomainBody[] }).data.map((domain) => [domain.id, domain]));
    for (const [code, domainId] of domains) {
      expect(listed.get(domainId), code).toMatchObject({
        verificationStatus: "pending",
        lastCheckError: code,
        lastCheckedAt: t.clock.now().toISOString(),
      });
    }
  });

  it("[PBE-050 AC1] a job for a domain that is gone or no longer pending changes nothing", async () => {
    const ota = await arrangeOta();
    const verifiedId = await customDomain(ota, host("done"), { status: "verified" });
    const jobs = worker.get(DomainJobs, { strict: false });
    const gone = testId("dom", 50_999);

    expect(await jobs.enqueueVerify(verifiedId)).toBe(true);
    expect(await jobs.enqueueVerify(gone)).toBe(true);

    for (const [domainId, status] of [
      [verifiedId, "verified"],
      [gone, "missing"],
    ] as const) {
      await vi.waitFor(async () => {
        const [job] = await jobsFor(DOMAIN_VERIFY_JOB, domainId);
        expect(await job?.getState()).toBe("completed");
        expect(job?.returnvalue).toEqual({ domainId, status, checked: false });
      }, WAIT);
    }
    expect(await domainRow(verifiedId)).toMatchObject({
      verification_status: "verified",
      last_checked_at: null,
    });
  });

  it("[PBE-050 AC1] asks DNS outside any transaction, and writes nothing for a domain removed meanwhile", async () => {
    const ota = await arrangeOta();
    const hostname = host("raced");
    const domainId = await customDomain(ota, hostname);
    publishCname(ota, hostname, BUILDER_TOKEN);
    const held = resolver.hold("TXT", ownershipRecordName(hostname));
    const jobs = worker.get(DomainJobs, { strict: false });

    expect(await jobs.enqueueVerify(domainId)).toBe(true);
    await held.asked;
    // The job waits for DNS without a lock on the row: the owner's removal goes through at once.
    const removed = await t.http
      .delete(`${domainsUrl(ota.tenant.id)}/${domainId}`)
      .set(await bearer(ota.owners[0]?.id ?? ""));
    expect(removed.status).toBe(204);
    held.release();

    await vi.waitFor(async () => {
      const [job] = await jobsFor(DOMAIN_VERIFY_JOB, domainId);
      expect(await job?.getState()).toBe("completed");
      expect(job?.returnvalue).toEqual({ domainId, status: "superseded", checked: false });
    }, WAIT);
    // The records were correct, but the domain is gone: no verification, e-mail, probe or row of the job.
    expect(await rowsOf("SELECT id FROM platform.tenant_domains WHERE id = $1", [domainId])).toEqual([]);
    expect((await auditOf(domainId)).map((row) => row["action"])).toEqual(["domain.removed"]);
    expect(await emailsOf(ota.tenant.id, "domain.verified")).toEqual([]);
    expect(await jobsFor(DOMAIN_TLS_PROBE_JOB, domainId)).toEqual([]);
    expect(logsWithMessage("domains.verify_superseded")).toContainEqual(
      expect.objectContaining({ domainId, tenantId: ota.tenant.id }),
    );
  });

  it("[PBE-050 AC1] a job of another name, or with data other than a domain id, fails at once", async () => {
    const bogus = await domainsQueue.add("domain.bogus", { domainId: testId("dom", 50_998) });
    const invalid = await domainsQueue.add(DOMAIN_VERIFY_JOB, { domainId: "dom_x", extra: true });

    for (const job of [bogus, invalid]) {
      await vi.waitFor(async () => {
        const failed = await domainsQueue.getJob(job.id ?? "");
        expect(await failed?.getState()).toBe("failed");
        // UnrecoverableError: one attempt, no retry.
        expect(failed?.attemptsMade).toBe(1);
      }, WAIT);
    }
    expect((await domainsQueue.getJob(bogus.id ?? ""))?.failedReason).toBe(
      "platform-domains has no job named domain.bogus",
    );
  });
});

// ---- domains.verify_pending ----------------------------------------------------------------------------------------

describe("domains.verify_pending: the 5-minute run", () => {
  it("[PBE-050 AC2] queues one domain.verify per pending custom domain, once per run, and leaves the others alone", async () => {
    const ota = await arrangeOta();
    const ready = host("ready");
    const readyId = await customDomain(ota, ready);
    publishCname(ota, ready, BUILDER_TOKEN);
    const waitingId = await customDomain(ota, host("waiting"));
    const verifiedId = await customDomain(ota, host("verified"), { status: "verified" });
    const failedId = await customDomain(ota, host("failed"), { status: "failed" });
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM platform.tenant_domains WHERE kind = 'custom' AND verification_status = 'pending'",
    );
    const scheduler = worker.get(VerifyPendingScheduler, { strict: false });

    const first = await scheduler.run();
    const second = await scheduler.run();

    expect(first).toEqual({ pending: Number(rows[0]?.count), queued: Number(rows[0]?.count) });
    // The waiting domain is still pending for the second run (its records never appear), whatever the first's jobs did.
    expect(second.pending).toBeGreaterThanOrEqual(1);
    expect(second.queued).toBe(second.pending);
    await waitForRow(readyId, (row) => row["verification_status"] === "verified");
    expect(await waitForCheck(waitingId)).toMatchObject({
      verification_status: "pending",
      last_check_error: "txt_missing",
    });
    // One job per domain and run: the second run of the same slot found the first one's job.
    for (const domainId of [readyId, waitingId]) {
      const jobs = await jobsFor(DOMAIN_VERIFY_JOB, domainId);
      expect(jobs.map((job) => job.id)).toEqual([verifyPendingJobId(domainId, t.clock.now())]);
    }
    for (const domainId of [verifiedId, failedId]) {
      expect(await jobsFor(DOMAIN_VERIFY_JOB, domainId)).toEqual([]);
      expect((await domainRow(domainId))["last_checked_at"]).toBeNull();
    }
    expect(logsWithMessage("domains.verify_pending_queued")).toContainEqual(expect.objectContaining(first));
  });

  it("[PBE-050 AC2] the schedule's job runs through the platform-maintenance processor and verifies a ready domain", async () => {
    const ota = await arrangeOta();
    const ready = host("scheduled");
    const readyId = await customDomain(ota, ready);
    publishCname(ota, ready, BUILDER_TOKEN);
    expect(PLATFORM_SCHEDULES.find((schedule) => schedule.id === DOMAINS_VERIFY_PENDING_JOB)).toMatchObject({
      pattern: "*/5 * * * *",
      features: ["custom_domains"],
    });

    // What the job scheduler adds every 5 minutes: a job named after the schedule, with an empty payload.
    const run = await maintenanceQueue.add(DOMAINS_VERIFY_PENDING_JOB, {});

    const result = await vi.waitFor(async () => {
      const done = await maintenanceQueue.getJob(run.id ?? "");
      expect(await done?.getState()).toBe("completed");
      return done?.returnvalue as { pending: number; queued: number } | { handled: false };
    }, WAIT);
    // VerifyPendingScheduler's answer, not the processor's `{ handled: false }` for a schedule without a handler.
    expect(result).toEqual({ pending: expect.any(Number), queued: expect.any(Number) });
    expect("queued" in result && result.queued === result.pending && result.pending >= 1).toBe(true);
    await waitForRow(readyId, (row) => row["verification_status"] === "verified");
    expect((await jobsFor(DOMAIN_VERIFY_JOB, readyId)).map((job) => job.id)).toEqual([
      verifyPendingJobId(readyId, t.clock.now()),
    ]);
  });
});

// ---- The 72-hour window and "Check now" ----------------------------------------------------------------------------

describe("the verification window", () => {
  it("[PBE-050 AC2] a domain past 72 hours becomes failed and the owners get an e-mail; check now restarts the window with the same token", async () => {
    const ota = await arrangeOta();
    const hostname = host("late");
    const added = await addDomain(ota, hostname);
    const token = added.dnsRecords.find((record) => record.type === "TXT")?.value ?? "";
    // The records were never created; the window ends.
    t.clock.advance(VERIFICATION_WINDOW_MS);
    const jobs = worker.get(DomainJobs, { strict: false });

    expect(await jobs.enqueueVerify(added.id)).toBe(true);

    const failed = await waitForRow(added.id, (row) => row["verification_status"] === "failed");
    expect(failed).toMatchObject({ last_check_error: "txt_missing", last_checked_at: t.clock.now() });
    expect((await auditOf(added.id)).at(-1)).toEqual(
      expect.objectContaining({
        action: "domain.verification_failed",
        actor_type: "system",
        actor_label: "domain.verify",
        details: {
          hostname,
          verificationDeadlineAt: added.verificationDeadlineAt,
          before: { verificationStatus: "pending" },
          after: { verificationStatus: "failed", lastCheckError: "txt_missing" },
        },
      }),
    );
    const emails = await emailsOf(ota.tenant.id, "domain.failed");
    expect(emails.map((email) => email["account_id"]).sort()).toEqual(ota.owners.map(({ id }) => id).sort());
    expect(emails[0]?.["data"]).toMatchObject({ hostname, reason: DNS_CHECK_ERROR_TEXT.txt_missing });
    const message = await waitForMessage({ to: ota.owners[0]?.email ?? "", timeoutMs: MAIL_WAIT_MS });
    expect(message.Subject).toBe(`${hostname} could not be verified for ${ota.tenant.name}`);
    await settle();
    expect(eventsFor(hostname)).toEqual([{ v: 1, type: "domain", hostname }]);

    // The owner creates the records and checks now: a new 72-hour window with the same token, then verified.
    publishCname(ota, hostname, token);
    const res = await check(ota, added.id, ota.admin);

    expect(res.status).toBe(202);
    const restarted = res.body as DomainBody;
    expect(restarted).toMatchObject({
      verificationStatus: "pending",
      verificationDeadlineAt: new Date(t.clock.now().getTime() + VERIFICATION_WINDOW_MS).toISOString(),
      lastCheckError: "txt_missing",
    });
    expect(restarted.dnsRecords.find((record) => record.type === "TXT")?.value).toBe(token);
    expect(
      (await auditOf(added.id)).find((row) => row["action"] === "domain.verification_restarted"),
    ).toEqual(
      expect.objectContaining({
        actor_type: "account",
        actor_account_id: ota.admin,
        details: {
          hostname,
          before: { verificationStatus: "failed", verificationDeadlineAt: added.verificationDeadlineAt },
          after: { verificationStatus: "pending", verificationDeadlineAt: restarted.verificationDeadlineAt },
        },
      }),
    );
    await waitForRow(added.id, (row) => row["verification_status"] === "verified");
    // The verification of the new window e-mails the owners again.
    expect((await emailsOf(ota.tenant.id, "domain.verified")).length).toBe(ota.owners.length);
  });
});

// ---- checkDomain ---------------------------------------------------------------------------------------------------

describe("checkDomain", () => {
  it("[PBE-050] refuses the sub-domain and a verified domain with 409 CONFLICT, and queues nothing", async () => {
    const ota = await arrangeOta();
    const verifiedId = await customDomain(ota, host("ok"), { status: "verified" });

    const subdomain = await check(ota, ota.domain.id, ota.owners[0]?.id ?? "");
    const verified = await check(ota, verifiedId, ota.owners[0]?.id ?? "");

    expect([subdomain.status, errorOf(subdomain)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "subdomain" } }),
    ]);
    expect([verified.status, errorOf(verified)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "already_verified" } }),
    ]);
    expect(await jobsFor(DOMAIN_VERIFY_JOB, ota.domain.id)).toEqual([]);
    expect(await jobsFor(DOMAIN_VERIFY_JOB, verifiedId)).toEqual([]);
  });

  it("[PBE-050] answers 403 to agents, 404 to strangers and 409 TENANT_NOT_ACTIVE for a suspended OTA", async () => {
    const ota = await arrangeOta();
    const suspended = await arrangeOta("suspended");
    const stranger = await insertAccount(pool, { email: uniqueEmail("stranger-pbe050") });
    const first = await customDomain(ota, host("agent"));
    const second = await customDomain(ota, host("stranger"));
    const third = await customDomain(suspended, host("suspended"));

    const agent = await check(ota, first, ota.agent);
    const outsider = await check(ota, second, stranger.id);
    const notActive = await check(suspended, third, suspended.owners[0]?.id ?? "");

    expect([agent.status, errorOf(agent).code]).toEqual([403, "FORBIDDEN"]);
    expect([outsider.status, errorOf(outsider).code]).toEqual([404, "NOT_FOUND"]);
    expect([notActive.status, errorOf(notActive)]).toEqual([
      409,
      expect.objectContaining({ code: "TENANT_NOT_ACTIVE", details: { status: "suspended" } }),
    ]);
    for (const domainId of [first, second, third]) {
      expect(await jobsFor(DOMAIN_VERIFY_JOB, domainId)).toEqual([]);
    }
  });

  it("[PBE-050] allows one check per domain per minute: the next answers 429 RATE_LIMITED with Retry-After", async () => {
    const ota = await arrangeOta();
    const limited = await customDomain(ota, host("limited"));
    const other = await customDomain(ota, host("other"));

    const first = await check(ota, limited, ota.owners[0]?.id ?? "");
    const again = await check(ota, limited, ota.admin);
    const another = await check(ota, other, ota.admin);

    expect(first.status).toBe(202);
    expect([again.status, errorOf(again).code]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(again.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(again.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(another.status).toBe(202);
  });

  it("[PBE-050] answers 503 SERVICE_UNAVAILABLE when the job cannot be queued; a failed domain's new window stands", async () => {
    const ota = await arrangeOta();
    const domainId = await customDomain(ota, host("redis"), {
      status: "failed",
      deadline: new Date(t.clock.now().getTime() - HOUR_MS),
    });
    vi.spyOn(t.app.get(DomainJobs, { strict: false }), "enqueueVerify").mockResolvedValueOnce(false);

    const res = await check(ota, domainId, ota.owners[0]?.id ?? "");

    expect([res.status, errorOf(res).code]).toEqual([503, "SERVICE_UNAVAILABLE"]);
    // The 5-minute run checks the pending domain.
    expect(await domainRow(domainId)).toMatchObject({
      verification_status: "pending",
      verification_deadline_at: new Date(t.clock.now().getTime() + VERIFICATION_WINDOW_MS),
    });
  });
});
