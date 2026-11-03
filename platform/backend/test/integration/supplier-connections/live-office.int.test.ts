// The live Amadeus office (PBE-054; platform/docs/flows/amadeus-connection.md §C and §D item 5, PADR-0012 items 3, 5
// and 8; scope PF-51, PF-90) through the HTTP pipeline (createTestApp) on this file's database clone: the owner's
// `requestLiveAmadeus` (the live connection waiting for an office, its audit row, the ops alert, the `connection`
// invalidation, and the refusals: switch, plan, role, tenant status, an invalid body, an existing live connection, no
// Velexis live account, two concurrent requests), the platform admin's assignment of a live office (the connection
// `active`, the `amadeus.live_ready` e-mail to the owners) and `adminReleaseAmadeusOffice` (the confirmation and the
// reason, the office back in the pool, `connection_active` and `not_assigned`), and the `pendingSubmission` that every
// answered Amadeus connection carries (FIX-W39-PLATFORM, lead decision (2k) of 2026-11-02: the live request, the
// assignment, the list, the settings update, the admin's switch and tenant detail). Every answer is checked against the
// platform document.
//
// The worker's module graph (WorkerModule, with the same FakeClock) sends the queued e-mails through SMTP to Mailpit:
// the owners and OPS_ALERT_EMAIL have addresses of this file only (`uniqueEmail`), so other test files' mail never
// counts here. The milestone switches are a stand-in for FeatureSwitches whose `live_switch` a test can turn off, as
// custom-domains.int.test.ts does. Tokens come from the application's TokenService at the FakeClock's time. Every test
// starts without Amadeus accounts, offices or connections, and writes the OTAs and rows it needs with the builders.
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURES,
  FEATURE_VARIABLES,
  featuresFor,
  FeatureSwitches,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertPlan,
  insertRow,
  insertSupplierConnection,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  SEEDED_PLAN_CODE,
  testId,
  velexisSource,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertOta, type InsertedOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/** Starting the API and the worker's module graph takes seconds; the bound allows for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker, an e-mail or an invalidation. */
const WAIT_MS = 20_000;
/** A documentation address (RFC 5737) of the people. */
const PERSON_IP = "203.0.113.51";
const OPS_EMAIL = uniqueEmail("ops-live-office");
const REASON = "Acme confirmed that no booking with future travel remains on the office.";

/** The milestone switches of this application: `live_switch` on unless a test turns it off. */
class TestSwitches {
  readonly on = new Set<Feature>(["live_switch"]);

  isEnabled(feature: Feature): boolean {
    return this.on.has(feature);
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(
        FEATURES.map((feature) => [FEATURE_VARIABLES[feature], this.on.has(feature)]),
      ) as FeatureConfig,
    );
  }
}

/** The AmadeusConnection of the platform document, as the tests read it. */
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
  readonly pendingSubmission: unknown;
  readonly version: number;
}

/** The AdminAmadeusOffice of the platform document, as the tests read it. */
interface OfficeBody {
  readonly id: string;
  readonly officeId: string;
  readonly environment: string;
  readonly status: string;
  readonly assignedTenant: { readonly id: string; readonly key: string } | null;
  readonly assignedAt: string | null;
  readonly releaseRequestedAt: string | null;
  readonly releasedAt: string | null;
  readonly version: number;
}

/** An OTA of this file and its people: two owners (with addresses of this file), an admin and an agent. */
interface LiveOta extends InsertedOta {
  readonly owner: PlatformRow<"accounts">;
  readonly secondOwner: PlatformRow<"accounts">;
  readonly admin: PlatformRow<"accounts">;
  readonly agent: PlatformRow<"accounts">;
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let worker: TestingModule;
let subscriber: Redis;
let platformAdmin = "";
/** A plan with live mode; the seeded `early_access` plan has none. */
let livePlan = "";
const switches = new TestSwitches();
const workerLogs = new LogSink();
const events: InvalidationEvent[] = [];

beforeAll(async () => {
  // The database clone, the Nest module graphs of the API and the worker and the Ajv validators of the document are
  // the expensive part; SETUP_TIMEOUT_MS covers a loaded 4-CPU CI runner.
  t = await createTestApp({
    env: { OPS_ALERT_EMAIL: OPS_EMAIL },
    overrides: [{ provide: FeatureSwitches, useValue: switches }],
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .compile();
  await worker.init();
  // The e-mail queue is created by the worker graph; asking for it fails fast when the graph has none.
  worker.get(getQueueToken(PLATFORM_QUEUE.emails), { strict: false });
  platformAdmin = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;
  livePlan = (
    await insertPlan(pool, { limits: { staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode: true } })
  ).code;

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
  switches.on.add("live_switch");
});

// ---- Arrangement ---------------------------------------------------------------------------------------------------

/** An OTA (active on the live plan unless told otherwise) with two owners, an admin and an agent. */
async function liveOta(planCode = livePlan, status = "active"): Promise<LiveOta> {
  const owner = await insertAccount(pool, { email: uniqueEmail("live-owner") });
  const secondOwner = await insertAccount(pool, { email: uniqueEmail("live-owner-2") });
  const admin = await insertAccount(pool, { email: uniqueEmail("live-admin") });
  const agent = await insertAccount(pool);
  const inserted = await insertOta(pool, {
    tenant: { plan_code: planCode, status },
    members: [
      [owner, "owner"],
      [secondOwner, "owner"],
      [admin, "admin"],
      [agent, "agent"],
    ],
  });
  return { ...inserted, owner, secondOwner, admin, agent };
}

/** The Velexis account of `environment` (the live one on Amadeus's live host). */
async function velexisAccount(
  environment: "test" | "live" = "live",
): Promise<PlatformRow<"amadeus_accounts">> {
  return insertAmadeusAccount(pool, {
    environment,
    ...(environment === "live" ? { base_url: "https://travel.api.amadeus.com" } : {}),
  });
}

/** `Authorization: Bearer` with a fresh portal token of `accountId`, at the FakeClock's time. */
async function bearer(accountId: string): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: testId("asn", 1),
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** `Authorization: Bearer` with a fresh platform admin token (password and TOTP), at the FakeClock's time. */
async function adminBearer(): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: platformAdmin,
    sid: testId("asn", 2),
    ev: true,
    amr: ["pwd", "otp"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** `requestLiveAmadeus` by `accountId`, with `body` when given, checked against the document. */
async function requestLive(tenantId: string, accountId: string, body?: object): Promise<Response> {
  const req = t.http
    .post(`/v1/tenants/${tenantId}/amadeus-connections/live/request`)
    .set(await bearer(accountId));
  const res = body === undefined ? await req : await req.send(body);
  expectResponseToMatch("requestLiveAmadeus", res, { document: "platform" });
  return res;
}

/** `adminAssignAmadeusOffice`, checked against the document. */
async function assign(officeRowId: string, tenantId: string): Promise<Response> {
  const res = await t.http
    .post(`/v1/admin/amadeus-offices/${officeRowId}/assign`)
    .set(await adminBearer())
    .send({ tenantId });
  expectResponseToMatch("adminAssignAmadeusOffice", res, { document: "platform" });
  return res;
}

/** `adminReleaseAmadeusOffice` with `body`, checked against the document. */
async function release(officeRowId: string, body: object): Promise<Response> {
  const res = await t.http
    .post(`/v1/admin/amadeus-offices/${officeRowId}/release`)
    .set(await adminBearer())
    .send(body);
  expectResponseToMatch("adminReleaseAmadeusOffice", res, { document: "platform" });
  return res;
}

function errorOf(res: { body: unknown }): { code: string; details?: Record<string, unknown> } {
  return (res.body as { error: { code: string; details?: Record<string, unknown> } }).error;
}

async function connectionsOf(tenantId: string): Promise<Array<PlatformRow<"supplier_connections">>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.supplier_connections WHERE tenant_id = $1 ORDER BY environment",
    [tenantId],
  );
  return rows as Array<PlatformRow<"supplier_connections">>;
}

async function storedOffice(id: string): Promise<PlatformRow<"amadeus_offices">> {
  const { rows } = await pool.query("SELECT * FROM platform.amadeus_offices WHERE id = $1", [id]);
  return rows[0] as PlatformRow<"amadeus_offices">;
}

async function auditOf(tenantId: string, action: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id",
    [tenantId, action],
  );
  return rows as Array<Record<string, unknown>>;
}

/** The e-mails queued for the OTA with `template`: recipient and data, by recipient. */
async function outboxOf(
  tenantId: string,
  template: string,
): Promise<Array<{ to_email: string; data: Record<string, string> }>> {
  const { rows } = await pool.query(
    "SELECT to_email, data FROM platform.email_outbox WHERE tenant_id = $1 AND template = $2 ORDER BY to_email",
    [tenantId, template],
  );
  return rows as Array<{ to_email: string; data: Record<string, string> }>;
}

/** Waits until the invalidation events `expected` have arrived (in any order, among others). */
async function invalidations(expected: readonly InvalidationEvent[]): Promise<void> {
  const has = (event: InvalidationEvent): boolean =>
    events.some((received) => JSON.stringify(received) === JSON.stringify(event));
  await expect
    .poll(() => expected.every(has), { timeout: WAIT_MS, interval: 20, message: "the invalidation events" })
    .toBe(true);
}

/** How many sessions of this file's database wait for a lock (row and advisory locks alike). */
async function waitingOnLocks(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(DISTINCT l.pid)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
      "WHERE NOT l.granted AND a.datname = current_database()",
  );
  return (rows[0] as { waiting: number }).waiting;
}

// ---- requestLiveAmadeus and the live assignment --------------------------------------------------------------------

describe("requestLiveAmadeus and the live office assignment", () => {
  it("[PBE-054 AC1] an owner requests live access, an admin assigns a live office, and the connection becomes active with an e-mail to the owners", async () => {
    const live = await velexisAccount("live");
    const office = await insertAmadeusOffice(pool, live, { office_id: "OSL1A0101" });
    const ota = await liveOta();
    const note = "We start selling to Norway in March; our ticketing agreement with Amadeus is signed.";

    const requested = await requestLive(ota.tenant.id, ota.owner.id, { note });

    expect(requested.status).toBe(202);
    const waiting = requested.body as ConnectionBody;
    expect(waiting).toMatchObject({
      environment: "live",
      credentialSource: "velexis",
      status: "pending_verification",
      officeIds: [],
      defaultOfficeId: null,
      queuingOfficeId: null,
      ownerOfficeId: null,
      clientId: null,
      pendingSubmission: null,
      version: 1,
    });
    expect(await connectionsOf(ota.tenant.id)).toEqual([
      expect.objectContaining({
        id: waiting.id,
        environment: "live",
        credential_source: "velexis",
        amadeus_account_id: live.id,
        status: "pending_verification",
        office_ids: [],
        client_secret_ciphertext: null,
        created_by_account_id: ota.owner.id,
      }),
    ]);
    expect(await auditOf(ota.tenant.id, "amadeus.live_requested")).toEqual([
      expect.objectContaining({
        actor_type: "account",
        actor_account_id: ota.owner.id,
        target_type: "supplier_connection",
        target_id: waiting.id,
        details: expect.objectContaining({ environment: "live", note }) as unknown,
      }),
    ]);
    await invalidations([{ v: 1, type: "connection", tenantId: ota.tenant.id }]);
    const alert = await waitForMessage({
      to: OPS_EMAIL,
      subject: `[Velexis ops] Live Amadeus office requested: ${ota.tenant.name} (${ota.tenant.key})`,
      timeoutMs: WAIT_MS,
    });
    expect(alert.Text).toContain(`Note from the OTA: ${note}`);
    expect(alert.Text).toContain(waiting.id);
    expect(alert.Text).toContain(live.id);

    // Velexis completes the onboarding outside the system; the admin assigns the live office.
    const assigned = await assign(office.id, ota.tenant.id);

    expect(assigned.status).toBe(200);
    const body = assigned.body as { office: OfficeBody; connection: ConnectionBody };
    expect(body.office).toMatchObject({
      id: office.id,
      environment: "live",
      status: "assigned",
      assignedTenant: { id: ota.tenant.id, key: ota.tenant.key },
    });
    expect(body.connection).toMatchObject({
      id: waiting.id,
      environment: "live",
      credentialSource: "velexis",
      status: "active",
      officeIds: ["OSL1A0101"],
      defaultOfficeId: "OSL1A0101",
      queuingOfficeId: "OSL1A0101",
      ownerOfficeId: "OSL1A0101",
      version: 2,
    });
    await invalidations([
      { v: 1, type: "connection", tenantId: ota.tenant.id },
      { v: 1, type: "amadeus_account", id: live.id },
    ]);
    // Both owners get the e-mail, once each; the admin and the agent get none.
    const amadeusUrl = `${t.config.PUBLIC_PORTAL_URL.replace(/\/+$/, "")}/otas/${ota.tenant.id}/amadeus`;
    expect(await outboxOf(ota.tenant.id, "amadeus.live_ready")).toEqual(
      [ota.owner, ota.secondOwner]
        .sort((a, b) => (a.email < b.email ? -1 : 1))
        .map((owner) => ({
          to_email: owner.email,
          data: {
            fullName: owner.full_name,
            tenantName: ota.tenant.name,
            tenantKey: ota.tenant.key,
            officeId: "OSL1A0101",
            amadeusUrl,
          },
        })),
    );
    const ready = await waitForMessage({
      to: ota.owner.email,
      subject: `Live Amadeus access is ready for ${ota.tenant.name}`,
      timeoutMs: WAIT_MS,
    });
    expect(ready.Text).toContain(`Velexis assigned the live Amadeus office OSL1A0101 to your OTA`);
    expect(ready.Text).toContain(amadeusUrl);
    await waitForMessage({ to: ota.secondOwner.email, timeoutMs: WAIT_MS });

    // The portal lists the live connection as active.
    const list = await t.http
      .get(`/v1/tenants/${ota.tenant.id}/amadeus-connections`)
      .set(await bearer(ota.admin.id));
    expect(list.status).toBe(200);
    expect((list.body as { data: ConnectionBody[] }).data).toEqual([
      expect.objectContaining({ id: waiting.id, environment: "live", status: "active" }),
    ]);
  });

  it("takes no body at all, and a test office assignment e-mails nobody", async () => {
    await velexisAccount("live");
    const testAccount = await velexisAccount("test");
    const testOffice = await insertAmadeusOffice(pool, testAccount);
    const ota = await liveOta();

    const requested = await requestLive(ota.tenant.id, ota.owner.id);
    const assigned = await assign(testOffice.id, ota.tenant.id);

    expect(requested.status).toBe(202);
    const [audit] = await auditOf(ota.tenant.id, "amadeus.live_requested");
    expect(Object.keys(audit?.["details"] as Record<string, unknown>).sort()).toEqual([
      "after",
      "environment",
    ]);
    const [opsAlert] = await outboxOf(ota.tenant.id, "ops.alert");
    expect(opsAlert?.data["message"]).toContain("The OTA left no note.");
    expect(assigned.status).toBe(200);
    expect(await outboxOf(ota.tenant.id, "amadeus.live_ready")).toEqual([]);
  });

  it("refuses without the switch, without live mode in the plan, for a non-owner, for an OTA that is not active and for an invalid body, writing nothing", async () => {
    await velexisAccount("live");
    const ota = await liveOta();
    const testOnly = await liveOta(SEEDED_PLAN_CODE);
    const suspended = await liveOta(livePlan, "suspended");

    const forAdmin = await requestLive(ota.tenant.id, ota.admin.id);
    const forAgent = await requestLive(ota.tenant.id, ota.agent.id);
    const emptyNote = await requestLive(ota.tenant.id, ota.owner.id, { note: "" });
    const unknownField = await requestLive(ota.tenant.id, ota.owner.id, {
      note: "Please.",
      officeId: "OSL1A0101",
    });
    const withoutPlan = await requestLive(testOnly.tenant.id, testOnly.owner.id);
    const whileSuspended = await requestLive(suspended.tenant.id, suspended.owner.id, { note: "Please." });
    switches.on.delete("live_switch");
    const switchedOff = await requestLive(ota.tenant.id, ota.owner.id);

    expect([forAdmin.status, errorOf(forAdmin).code]).toEqual([403, "FORBIDDEN"]);
    expect([forAgent.status, errorOf(forAgent).code]).toEqual([403, "FORBIDDEN"]);
    for (const res of [emptyNote, unknownField]) {
      expect([res.status, errorOf(res).code]).toEqual([400, "VALIDATION_FAILED"]);
    }
    for (const res of [withoutPlan, switchedOff]) {
      expect([res.status, errorOf(res)]).toEqual([
        403,
        expect.objectContaining({ code: "FEATURE_DISABLED", details: { feature: "live_switch" } }),
      ]);
    }
    expect([whileSuspended.status, errorOf(whileSuspended)]).toEqual([
      409,
      expect.objectContaining({ code: "TENANT_NOT_ACTIVE", details: { status: "suspended" } }),
    ]);
    for (const tenant of [ota, testOnly, suspended]) {
      expect(await connectionsOf(tenant.tenant.id)).toEqual([]);
      expect(await auditOf(tenant.tenant.id, "amadeus.live_requested")).toEqual([]);
      expect(await outboxOf(tenant.tenant.id, "ops.alert")).toEqual([]);
    }
  });

  it("answers 409 live_connection_exists when the OTA has a live connection, its own credentials included", async () => {
    const live = await velexisAccount("live");
    const requestedBefore = await liveOta();
    const ownCredentials = await liveOta();
    await insertSupplierConnection(pool, ownCredentials.tenant, {
      environment: "live",
      base_url: "https://travel.api.amadeus.com",
    });
    const served = await liveOta();
    await insertSupplierConnection(pool, served.tenant, {
      ...velexisSource(live),
      status: "active",
      office_ids: ["OSL1A0102"],
      default_office_id: "OSL1A0102",
    });

    expect((await requestLive(requestedBefore.tenant.id, requestedBefore.owner.id)).status).toBe(202);
    const again = await requestLive(requestedBefore.tenant.id, requestedBefore.owner.id);
    const own = await requestLive(ownCredentials.tenant.id, ownCredentials.owner.id);
    const active = await requestLive(served.tenant.id, served.owner.id);

    for (const res of [again, own, active]) {
      expect([res.status, errorOf(res)]).toEqual([
        409,
        expect.objectContaining({ code: "CONFLICT", details: { reason: "live_connection_exists" } }),
      ]);
    }
    expect(await connectionsOf(requestedBefore.tenant.id)).toHaveLength(1);
    expect(await auditOf(requestedBefore.tenant.id, "amadeus.live_requested")).toHaveLength(1);
    expect(await outboxOf(requestedBefore.tenant.id, "ops.alert")).toHaveLength(1);
    expect(await connectionsOf(ownCredentials.tenant.id)).toEqual([
      expect.objectContaining({ credential_source: "tenant", version: 1 }),
    ]);
  });

  it("answers 409 live_account_missing without a Velexis live account, alerting ops once a day and storing nothing else", async () => {
    await velexisAccount("test");
    const ota = await liveOta();

    const first = await requestLive(ota.tenant.id, ota.owner.id, { note: "Ready when you are." });
    const second = await requestLive(ota.tenant.id, ota.owner.id);

    for (const res of [first, second]) {
      expect([res.status, errorOf(res)]).toEqual([
        409,
        expect.objectContaining({ code: "CONFLICT", details: { reason: "live_account_missing" } }),
      ]);
    }
    expect(await connectionsOf(ota.tenant.id)).toEqual([]);
    expect(await auditOf(ota.tenant.id, "amadeus.live_requested")).toEqual([]);
    const alerts = await outboxOf(ota.tenant.id, "ops.alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.data["title"]).toBe(
      `Live Amadeus request without a Velexis live account: ${ota.tenant.name} (${ota.tenant.key})`,
    );
    const message = await waitForMessage({
      to: OPS_EMAIL,
      subject: `[Velexis ops] ${alerts[0]?.data["title"] ?? ""}`,
      timeoutMs: WAIT_MS,
    });
    expect(message.Text).toContain("Create the live account in the platform admin");
  });

  it("two concurrent requests of one OTA give one live connection and one 409 live_connection_exists", async () => {
    await velexisAccount("live");
    const ota = await liveOta();
    const holder = await pool.connect();
    let answers: Response[];
    try {
      // Hold the OTA's connection lock of `live`, so both requests are in flight and wait for it at the same time.
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `platform.supplier_connections:${ota.tenant.id}:amadeus:live`,
      ]);
      const pending = Promise.all([
        requestLive(ota.tenant.id, ota.owner.id),
        requestLive(ota.tenant.id, ota.secondOwner.id),
      ]);
      // Awaited below; a failure before then must not count as unhandled.
      void pending.catch(() => undefined);
      await expect.poll(waitingOnLocks, { timeout: WAIT_MS, interval: 20 }).toBe(2);
      await holder.query("COMMIT");
      answers = await pending;
    } finally {
      holder.release();
    }

    expect(answers.map((res) => res.status).sort()).toEqual([202, 409]);
    const loser = answers.find((res) => res.status === 409);
    expect(loser && errorOf(loser).details).toEqual({ reason: "live_connection_exists" });
    expect(await connectionsOf(ota.tenant.id)).toHaveLength(1);
    expect(await auditOf(ota.tenant.id, "amadeus.live_requested")).toHaveLength(1);
  });
});

// ---- adminReleaseAmadeusOffice -------------------------------------------------------------------------------------

describe("adminReleaseAmadeusOffice", () => {
  it("[PBE-054 AC2] a releasing office returns to the pool only with the confirmation and a reason", async () => {
    const live = await velexisAccount("live");
    const ota = await liveOta();
    await insertSupplierConnection(pool, ota.tenant, {
      environment: "live",
      base_url: "https://travel.api.amadeus.com",
    });
    const assignedAt = new Date(t.clock.now().getTime() - 90 * 24 * 60 * 60 * 1000);
    const releaseRequestedAt = new Date(t.clock.now().getTime() - 30 * 24 * 60 * 60 * 1000);
    const office = await insertAmadeusOffice(pool, live, {
      office_id: "OSL1A0201",
      status: "releasing",
      assigned_tenant_id: ota.tenant.id,
      assigned_at: assignedAt,
      release_requested_at: releaseRequestedAt,
    });

    const refused = [
      await release(office.id, { reason: REASON }),
      await release(office.id, { confirmNoOpenBookings: false, reason: REASON }),
      await release(office.id, { confirmNoOpenBookings: true }),
      await release(office.id, { confirmNoOpenBookings: true, reason: "   no   " }),
    ];

    expect(refused.map((res) => [res.status, errorOf(res).code])).toEqual(
      Array.from({ length: 4 }, () => [400, "VALIDATION_FAILED"]),
    );
    expect(
      (refused[0]?.body as { error: { fieldErrors: Array<{ path: string }> } }).error.fieldErrors,
    ).toEqual([expect.objectContaining({ path: "/confirmNoOpenBookings" })]);
    expect(await storedOffice(office.id)).toMatchObject({
      status: "releasing",
      assigned_tenant_id: ota.tenant.id,
      released_at: null,
      version: 1,
    });
    expect(await auditOf(ota.tenant.id, "amadeus_office.released")).toEqual([]);

    // The reason is trimmed before it is counted and stored.
    const released = await release(office.id, { confirmNoOpenBookings: true, reason: `  ${REASON}  ` });

    expect(released.status).toBe(200);
    expect(released.body as OfficeBody).toMatchObject({
      id: office.id,
      officeId: "OSL1A0201",
      environment: "live",
      status: "available",
      assignedTenant: null,
      assignedAt: null,
      releaseRequestedAt: null,
      releasedAt: t.clock.now().toISOString(),
      version: 2,
    });
    expect(await storedOffice(office.id)).toMatchObject({
      status: "available",
      assigned_tenant_id: null,
      released_at: t.clock.now(),
    });
    expect(await auditOf(ota.tenant.id, "amadeus_office.released")).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: platformAdmin,
        target_type: "amadeus_office",
        target_id: office.id,
        details: {
          officeId: "OSL1A0201",
          environment: "live",
          reason: REASON,
          confirmNoOpenBookings: true,
          before: {
            status: "releasing",
            tenantId: ota.tenant.id,
            assignedAt: assignedAt.toISOString(),
            releaseRequestedAt: releaseRequestedAt.toISOString(),
          },
          after: { status: "available", tenantId: null, releasedAt: t.clock.now().toISOString() },
        },
      }),
    ]);
    await invalidations([{ v: 1, type: "amadeus_account", id: live.id }]);
    // The OTA's own connection is untouched, and the office is in the pool again: another OTA can get it.
    expect(await connectionsOf(ota.tenant.id)).toEqual([
      expect.objectContaining({ credential_source: "tenant", version: 1 }),
    ]);
    const again = await release(office.id, { confirmNoOpenBookings: true, reason: REASON });
    expect([again.status, errorOf(again)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "not_assigned" } }),
    ]);
    const next = await liveOta();
    expect((await assign(office.id, next.tenant.id)).status).toBe(200);
  });

  it("answers 409 connection_active for an assigned office that backs an active velexis connection, and releases one whose connection an admin disabled", async () => {
    const live = await velexisAccount("live");
    const active = await liveOta();
    const inUse = await insertAmadeusOffice(pool, live, {
      office_id: "OSL1A0301",
      status: "assigned",
      assigned_tenant_id: active.tenant.id,
      assigned_at: t.clock.now(),
    });
    await insertSupplierConnection(pool, active.tenant, {
      ...velexisSource(live),
      status: "active",
      office_ids: ["OSL1A0301"],
      default_office_id: "OSL1A0301",
    });
    const disabled = await liveOta();
    const abused = await insertAmadeusOffice(pool, live, {
      office_id: "OSL1A0302",
      status: "assigned",
      assigned_tenant_id: disabled.tenant.id,
      assigned_at: t.clock.now(),
    });
    await insertSupplierConnection(pool, disabled.tenant, {
      ...velexisSource(live),
      status: "disabled",
      office_ids: ["OSL1A0302"],
      default_office_id: "OSL1A0302",
    });

    const refused = await release(inUse.id, { confirmNoOpenBookings: true, reason: REASON });
    const released = await release(abused.id, { confirmNoOpenBookings: true, reason: REASON });

    expect([refused.status, errorOf(refused)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "connection_active" } }),
    ]);
    expect(await storedOffice(inUse.id)).toMatchObject({
      status: "assigned",
      assigned_tenant_id: active.tenant.id,
      version: 1,
    });
    expect(await auditOf(active.tenant.id, "amadeus_office.released")).toEqual([]);
    expect(released.status).toBe(200);
    expect(released.body as OfficeBody).toMatchObject({ status: "available", assignedTenant: null });
    expect(await auditOf(disabled.tenant.id, "amadeus_office.released")).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          before: expect.objectContaining({ status: "assigned", tenantId: disabled.tenant.id }) as unknown,
        }) as unknown,
      }),
    ]);
  });

  it("[FIX-W39-PLATFORM AC8] takes the released office out of the admin-disabled velexis connection that holds it: offices and defaults cleared, audited, invalidated, and re-enabling answers no_office", async () => {
    const live = await velexisAccount("live");
    const ota = await liveOta();
    const office = await insertAmadeusOffice(pool, live, {
      office_id: "OSL1A0311",
      status: "assigned",
      assigned_tenant_id: ota.tenant.id,
      assigned_at: t.clock.now(),
    });
    const connection = await insertSupplierConnection(pool, ota.tenant, {
      ...velexisSource(live),
      status: "disabled",
      office_ids: ["OSL1A0311"],
      default_office_id: "OSL1A0311",
      queuing_office_id: "OSL1A0311",
      owner_office_id: "OSL1A0311",
    });
    await pool.query("UPDATE platform.supplier_connections SET monitored_queues = $2 WHERE id = $1", [
      connection.id,
      JSON.stringify([{ officeId: "OSL1A0311", queueId: 7, category: 0 }]),
    ]);

    const released = await release(office.id, { confirmNoOpenBookings: true, reason: REASON });

    expect(released.status).toBe(200);
    expect(released.body as OfficeBody).toMatchObject({ status: "available", assignedTenant: null });
    const [stored] = await connectionsOf(ota.tenant.id);
    expect(stored).toMatchObject({
      id: connection.id,
      credential_source: "velexis",
      amadeus_account_id: live.id,
      status: "disabled",
      office_ids: [],
      default_office_id: null,
      queuing_office_id: null,
      owner_office_id: null,
      // The settings stay as the OTA set them; only the office fields name the released office no more.
      monitored_queues: [{ officeId: "OSL1A0311", queueId: 7, category: 0 }],
      version: connection.version + 1,
    });
    expect(await auditOf(ota.tenant.id, "amadeus_office.released")).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        target_id: office.id,
        details: expect.objectContaining({
          connectionId: connection.id,
          before: expect.objectContaining({
            status: "assigned",
            connectionStatus: "disabled",
            connectionOfficeIds: ["OSL1A0311"],
            connectionDefaultOfficeId: "OSL1A0311",
            connectionVersion: connection.version,
          }) as unknown,
          after: expect.objectContaining({
            status: "available",
            connectionStatus: "disabled",
            connectionOfficeIds: [],
            connectionDefaultOfficeId: null,
            connectionQueuingOfficeId: null,
            connectionOwnerOfficeId: null,
            connectionVersion: connection.version + 1,
          }) as unknown,
        }) as unknown,
      }),
    ]);
    await invalidations([
      { v: 1, type: "amadeus_account", id: live.id },
      { v: 1, type: "connection", tenantId: ota.tenant.id },
    ]);

    // The connection has no office any more: an admin cannot enable it until an office is assigned again.
    const enabled = await t.http
      .post(`/v1/admin/tenants/${ota.tenant.id}/connections/amadeus/live/status`)
      .set(await adminBearer())
      .send({ status: "active", reason: REASON });
    expectResponseToMatch("adminSetConnectionStatus", enabled, { document: "platform" });
    expect([enabled.status, errorOf(enabled)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "no_office", status: "disabled" } }),
    ]);
    expect((await connectionsOf(ota.tenant.id))[0]).toMatchObject({
      status: "disabled",
      version: connection.version + 1,
    });
  });

  it("[FIX-W39-PLATFORM AC8] leaves a disabled connection on another office, and an own-credential connection, as they are", async () => {
    const live = await velexisAccount("live");
    const ota = await liveOta();
    // A releasing office of an OTA that moved to its own credentials: its tenant connection is never touched.
    const releasing = await insertAmadeusOffice(pool, live, {
      office_id: "OSL1A0312",
      status: "releasing",
      assigned_tenant_id: ota.tenant.id,
      assigned_at: t.clock.now(),
      release_requested_at: t.clock.now(),
    });
    // The builder's default is a `tenant` connection (the OTA's own credentials, placeholder ciphertext).
    const own = await insertSupplierConnection(pool, ota.tenant, {
      environment: "live",
      status: "disabled",
      office_ids: ["OSL1A0312"],
      default_office_id: "OSL1A0312",
    });

    const released = await release(releasing.id, { confirmNoOpenBookings: true, reason: REASON });

    expect(released.status).toBe(200);
    const [stored] = await connectionsOf(ota.tenant.id);
    expect(stored).toMatchObject({ id: own.id, office_ids: ["OSL1A0312"], version: own.version });
    const [audit] = await auditOf(ota.tenant.id, "amadeus_office.released");
    expect(audit?.["details"]).not.toHaveProperty("connectionId");

    // An assigned office that the OTA's disabled `velexis` connection does not hold (it names another office; an OTA
    // has one assigned office per environment, so that one is not in the pool): the connection keeps its office.
    const other = await liveOta();
    const held = "OSL1A0314";
    const spare = await insertAmadeusOffice(pool, live, {
      office_id: "OSL1A0313",
      status: "assigned",
      assigned_tenant_id: other.tenant.id,
      assigned_at: t.clock.now(),
    });
    const disabled = await insertSupplierConnection(pool, other.tenant, {
      ...velexisSource(live),
      status: "disabled",
      office_ids: [held],
      default_office_id: held,
      queuing_office_id: held,
      owner_office_id: held,
    });

    const freed = await release(spare.id, { confirmNoOpenBookings: true, reason: REASON });

    expect([freed.status, (freed.body as OfficeBody).status]).toEqual([200, "available"]);
    expect((await connectionsOf(other.tenant.id))[0]).toMatchObject({
      id: disabled.id,
      status: "disabled",
      office_ids: [held],
      default_office_id: held,
      queuing_office_id: held,
      owner_office_id: held,
      version: disabled.version,
    });
    const [otherAudit] = await auditOf(other.tenant.id, "amadeus_office.released");
    expect(otherAudit?.["details"]).not.toHaveProperty("connectionId");
  });

  it("waits for an own-credential apply that holds the OTA's connection lock, then releases the office it moved to releasing", async () => {
    const live = await velexisAccount("live");
    const ota = await liveOta();
    const office = await insertAmadeusOffice(pool, live, {
      office_id: "OSL1A0401",
      status: "assigned",
      assigned_tenant_id: ota.tenant.id,
      assigned_at: t.clock.now(),
    });
    const holder = await pool.connect();
    let released: Response;
    try {
      // The apply of the OTA's own live credentials (PBE-053) takes the connection lock first, then moves the office
      // to `releasing`; the release must wait for that lock before it locks the office row, or the two deadlock.
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `platform.supplier_connections:${ota.tenant.id}:amadeus:live`,
      ]);
      const pending = release(office.id, { confirmNoOpenBookings: true, reason: REASON });
      // Awaited below; a failure before then must not count as unhandled.
      void pending.catch(() => undefined);
      await expect.poll(waitingOnLocks, { timeout: WAIT_MS, interval: 20 }).toBe(1);
      await holder.query(
        "UPDATE platform.amadeus_offices SET status = 'releasing', release_requested_at = $2, version = version + 1 " +
          "WHERE id = $1",
        [office.id, t.clock.now()],
      );
      await holder.query("COMMIT");
      released = await pending;
    } finally {
      holder.release();
    }

    expect(released.status).toBe(200);
    expect(released.body as OfficeBody).toMatchObject({
      status: "available",
      assignedTenant: null,
      version: 3,
    });
    expect(await auditOf(ota.tenant.id, "amadeus_office.released")).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          before: expect.objectContaining({ status: "releasing", tenantId: ota.tenant.id }) as unknown,
        }) as unknown,
      }),
    ]);
  });

  it("answers 409 not_assigned for an available or retired office and 404 for an unknown one", async () => {
    const live = await velexisAccount("live");
    const available = await insertAmadeusOffice(pool, live);
    const retired = await insertAmadeusOffice(pool, live, { status: "retired" });
    const body = { confirmNoOpenBookings: true, reason: REASON };

    const free = await release(available.id, body);
    const gone = await release(retired.id, body);
    const unknown = await release(testId("amo", 9999), body);

    for (const res of [free, gone]) {
      expect([res.status, errorOf(res)]).toEqual([
        409,
        expect.objectContaining({ code: "CONFLICT", details: { reason: "not_assigned" } }),
      ]);
    }
    expect([unknown.status, errorOf(unknown).code]).toEqual([404, "NOT_FOUND"]);
    expect(await storedOffice(available.id)).toMatchObject({ status: "available", version: 1 });
    expect(await storedOffice(retired.id)).toMatchObject({ status: "retired", version: 1 });
  });
});

// ---- The pendingSubmission of every answered connection ------------------------------------------------------------

/** The last sequence number of this file's submissions (`testId("crs", …)`). */
let submissionSeq = 54_900;

/**
 * A submission of the OTA's own Amadeus credentials for `environment`: `failed` as the worker leaves one (no secret,
 * error code AMADEUS_CREDENTIALS_INVALID), or `pending` as the API leaves one (a placeholder ciphertext that nothing
 * verifies: no job is queued, and this file's worker has no job scheduler). Each is newer than the ones before it.
 */
async function ownCredentialsSubmission(
  tenantId: string,
  environment: "test" | "live",
  status: "pending" | "failed",
): Promise<{ id: string; status: string; errorCode: string | null }> {
  submissionSeq += 1;
  const open = status === "pending";
  const row = await insertRow(pool, "credential_submissions", {
    id: testId("crs", submissionSeq),
    tenant_id: tenantId,
    kind: "amadeus",
    environment,
    status,
    error_code: open ? null : "AMADEUS_CREDENTIALS_INVALID",
    secret_ciphertext: open ? Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8") : null,
    encryption_key_id: open ? PLACEHOLDER_KEK_ID : null,
    finished_at: open ? null : t.clock.now(),
    created_at: new Date(t.clock.now().getTime() + submissionSeq),
  });
  return { id: row.id, status, errorCode: row.error_code };
}

describe("the pendingSubmission of every answered Amadeus connection (FIX-W39-PLATFORM)", () => {
  it("[FIX-W39-PLATFORM AC7] requestLiveAmadeus, adminAssignAmadeusOffice, updateAmadeusConnection, adminSetConnectionStatus and adminGetTenant answer it as listAmadeusConnections does", async () => {
    const live = await velexisAccount("live");
    const office = await insertAmadeusOffice(pool, live, { office_id: "OSL1A0401" });
    const ota = await liveOta();
    // The owner's own live credentials were refused before the OTA asked Velexis for a live office.
    const failed = await ownCredentialsSubmission(ota.tenant.id, "live", "failed");

    const requested = await requestLive(ota.tenant.id, ota.owner.id);
    expect([requested.status, (requested.body as ConnectionBody).pendingSubmission]).toEqual([202, failed]);

    const assigned = await assign(office.id, ota.tenant.id);
    expect([
      assigned.status,
      (assigned.body as { connection: ConnectionBody }).connection.pendingSubmission,
    ]).toEqual([200, failed]);

    // A newer submission, still open, is what every answer shows from now on.
    const pending = await ownCredentialsSubmission(ota.tenant.id, "live", "pending");
    const listed = await t.http
      .get(`/v1/tenants/${ota.tenant.id}/amadeus-connections`)
      .set(await bearer(ota.owner.id));
    expectResponseToMatch("listAmadeusConnections", listed, { document: "platform" });
    expect(
      (listed.body as { data: ConnectionBody[] }).data.map((c) => [c.environment, c.pendingSubmission]),
    ).toEqual([["live", pending]]);

    const [stored] = await connectionsOf(ota.tenant.id);
    const updated = await t.http
      .patch(`/v1/tenants/${ota.tenant.id}/amadeus-connections/live`)
      .set(await bearer(ota.owner.id))
      .set("If-Match", `"${stored?.version ?? 0}"`)
      .send({ monitoredQueues: [] });
    expectResponseToMatch("updateAmadeusConnection", updated, { document: "platform" });
    expect([updated.status, (updated.body as ConnectionBody).pendingSubmission]).toEqual([200, pending]);

    const disabled = await t.http
      .post(`/v1/admin/tenants/${ota.tenant.id}/connections/amadeus/live/status`)
      .set(await adminBearer())
      .send({ status: "disabled", reason: REASON });
    expectResponseToMatch("adminSetConnectionStatus", disabled, { document: "platform" });
    expect([disabled.status, (disabled.body as ConnectionBody).pendingSubmission]).toEqual([200, pending]);

    const detail = await t.http.get(`/v1/admin/tenants/${ota.tenant.id}`).set(await adminBearer());
    expectResponseToMatch("adminGetTenant", detail, { document: "platform" });
    expect(
      (detail.body as { amadeusConnections: ConnectionBody[] }).amadeusConnections.map((c) => [
        c.environment,
        c.status,
        c.pendingSubmission,
      ]),
    ).toEqual([["live", "disabled", pending]]);
  });

  it("[FIX-W39-PLATFORM AC7] shows each environment's own latest submission, and none once it was applied", async () => {
    const test = await velexisAccount("test");
    const live = await velexisAccount("live");
    const ota = await liveOta();
    await insertSupplierConnection(pool, ota.tenant, { ...velexisSource(test), status: "active" });
    await insertSupplierConnection(pool, ota.tenant, { ...velexisSource(live), status: "active" });
    const testFailed = await ownCredentialsSubmission(ota.tenant.id, "test", "failed");
    await ownCredentialsSubmission(ota.tenant.id, "live", "failed");
    // The latest live submission was applied: nothing is pending there any more.
    submissionSeq += 1;
    await insertRow(pool, "credential_submissions", {
      id: testId("crs", submissionSeq),
      tenant_id: ota.tenant.id,
      kind: "amadeus",
      environment: "live",
      status: "applied",
      finished_at: t.clock.now(),
      created_at: new Date(t.clock.now().getTime() + submissionSeq),
    });

    const listed = await t.http
      .get(`/v1/tenants/${ota.tenant.id}/amadeus-connections`)
      .set(await bearer(ota.owner.id));
    const detail = await t.http.get(`/v1/admin/tenants/${ota.tenant.id}`).set(await adminBearer());

    expect(
      (listed.body as { data: ConnectionBody[] }).data.map((c) => [c.environment, c.pendingSubmission]),
    ).toEqual([
      ["test", testFailed],
      ["live", null],
    ]);
    expect(
      (detail.body as { amadeusConnections: ConnectionBody[] }).amadeusConnections.map((c) => [
        c.environment,
        c.pendingSubmission,
      ]),
    ).toEqual([
      ["test", testFailed],
      ["live", null],
    ]);
  });
});
