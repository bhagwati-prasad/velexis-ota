// The platform admin's dashboard and tenant views (PBE-029; platform/docs/api-inventory-admin.md §2 and §3,
// flows/platform-admin-operations.md §B, scope PF-81) through the HTTP pipeline (createTestApp) on this file's database
// clone and this worker's Redis database: the dashboard counters (tenants by status, failed tenant jobs of the last 24
// hours of the FakeClock, failed BullMQ jobs per platform queue, the office pool, and the M5 counters `null` with
// every switch off), the OTA search (owner e-mail, key, name, status and plan filters, cursor pages that hold every
// tenant exactly once), the control-plane view of one OTA (valid against the document, no secret, the last 20 jobs and
// 50 audit rows) and the edit of its notes and legal name (If-Match, one audit row, the `tenant` invalidation).
//
// Rows are written with the builders; admin and portal tokens come from the application's TokenService. Tests that
// count something compare with what they added, so their order never matters. The M5 counters with their switches on
// are covered by src/admin/admin-dashboard.service.test.ts.
import { INVALIDATION_CHANNEL, PLATFORM_QUEUES, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { BULLMQ_PREFIX, PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertPaymentConnection,
  insertPlan,
  insertRow,
  insertSettlement,
  insertSupplierConnection,
  insertTenant,
  insertTenantDomain,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  testId,
  velexisSource,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember, insertMembership, insertOta, TEST_BASE_DOMAIN } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** Starting the API (database clone, Nest module graph, Ajv compilation of the document) takes seconds on CI. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for an invalidation or for BullMQ to fail a job. */
const WAIT_MS = 10_000;
// Documentation addresses (RFC 5737) only.
const ADMIN_IP = "203.0.113.41";
const HOUR_MS = 60 * 60 * 1000;
const STATUSES = ["provisioning", "active", "suspended", "failed"] as const;

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let subscriber: Redis;
let admin: PlatformRow<"accounts">;
/** The Velexis Amadeus account of the `test` environment (one per environment). */
let velexisTest: PlatformRow<"amadeus_accounts">;
const events: InvalidationEvent[] = [];
/** Ids of rows written without a builder (jobs, audit rows, invitations, events) are unique within the file. */
let next = 1;
const nextId = (prefix: string): string => testId(prefix, 5000 + next++);

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  admin = await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true });
  velexisTest = await insertAmadeusAccount(pool);

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    events.push(JSON.parse(message) as InvalidationEvent);
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
}, SETUP_TIMEOUT_MS);

async function adminHeaders(): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: admin.id,
    sid: testId("asn", 1),
    ev: true,
    amr: ["pwd", "otp"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

async function portalHeaders(accountId: string): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: testId("asn", 2),
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

function errorOf(res: Response): { code: string; fieldErrors?: Array<{ path: string }> } {
  return (res.body as { error: { code: string; fieldErrors?: Array<{ path: string }> } }).error;
}

/** Every property name in a JSON value, at any depth. */
function propertyNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(propertyNames);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([name, child]) => [name, ...propertyNames(child)]);
  }
  return [];
}

interface SummaryBody {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: string;
  readonly planCode: string;
  readonly ownerEmail: string | null;
}

interface ListBody {
  readonly data: SummaryBody[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

/** Every tenant id of `query` (`limit` per page), following `nextCursor` to the last page. */
async function pageThrough(
  query: Record<string, string | number>,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await t.http
      .get("/v1/admin/tenants")
      .query(cursor === null ? query : { ...query, cursor })
      .set(await adminHeaders());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectResponseToMatch("adminListTenants", res, { document: "platform" });
    const body = res.body as ListBody;
    ids.push(...body.data.map(({ id }) => id));
    cursor = body.page.nextCursor;
    pages += 1;
    expect(pages, "pages").toBeLessThan(100);
  } while (cursor !== null);
  return { ids, pages };
}

/** The shown tenants of the database in the order of the search (newest first, then id). */
async function shownTenantIds(where = "TRUE", values: unknown[] = []): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT id FROM platform.tenants
      WHERE status IN ('provisioning', 'active', 'suspended', 'failed') AND (${where})
      ORDER BY created_at DESC, id DESC`,
    values,
  );
  return (rows as Array<{ id: string }>).map(({ id }) => id);
}

describe("the admin routes of PBE-029", () => {
  it("refuse a portal access token and a request without one", async () => {
    const member = await insertAccount(pool);
    const ota = await insertOta(pool);
    const routes = [
      t.http.get("/v1/admin/dashboard"),
      t.http.get("/v1/admin/tenants"),
      t.http.get(`/v1/admin/tenants/${ota.tenant.id}`),
    ];
    for (const route of routes) {
      const res = await route.set(await portalHeaders(member.id));
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe("UNAUTHENTICATED");
    }
    const patch = await t.http
      .patch(`/v1/admin/tenants/${ota.tenant.id}`)
      .set(t.bffHeaders(ADMIN_IP))
      .set("If-Match", '"1"')
      .send({ notes: "No token" });
    expect(patch.status).toBe(401);
  });
});

describe("adminListTenants", () => {
  it("[PBE-029 AC1] finds an OTA by part of an active owner's e-mail address, ignoring letter case", async () => {
    const owner = await insertAccount(pool, { email: "ingrid.solberg-fjordline@nordic-fares.example.com" });
    const laterOwner = await insertAccount(pool, { email: "second.owner@nordic-fares.example.com" });
    const { tenant } = await insertOta(pool, { tenant: { name: "Nordic Fares" } });
    await insertMembership(pool, tenant, owner, {
      role: "owner",
      created_at: new Date("2026-10-01T08:00:00Z"),
    });
    await insertMembership(pool, tenant, laterOwner, {
      role: "owner",
      created_at: new Date("2026-10-02T08:00:00Z"),
    });
    // The same part of an address on an admin and on a removed owner of other OTAs matches nothing.
    const adminOfOther = await insertAccount(pool, { email: "ola.solberg-fjordline@other.example.com" });
    const removedOwner = await insertAccount(pool, { email: "kari.solberg-fjordline@gone.example.com" });
    const other = await insertOta(pool);
    await insertMember(pool, other.tenant, adminOfOther, "admin");
    const third = await insertOta(pool);
    await insertMembership(pool, third.tenant, removedOwner, { role: "owner", status: "removed" });

    const res = await t.http
      .get("/v1/admin/tenants")
      .query({ q: "SOLBERG-Fjordline" })
      .set(await adminHeaders());

    expect(res.status).toBe(200);
    expectResponseToMatch("adminListTenants", res, { document: "platform" });
    expect((res.body as ListBody).data).toEqual([
      {
        id: tenant.id,
        key: tenant.key,
        name: "Nordic Fares",
        status: "active",
        planCode: tenant.plan_code,
        ownerEmail: owner.email,
        createdAt: tenant.created_at.toISOString(),
        activatedAt: tenant.activated_at?.toISOString(),
      },
    ]);
    expect((res.body as ListBody).page).toEqual({ nextCursor: null, limit: 50 });
  });

  it("[PBE-029 AC1] pages through every OTA exactly once, newest first, also with a filter", async () => {
    // Five OTAs created at the same instant: the id breaks the tie, so no page boundary loses or repeats one.
    const sameInstant = new Date("2026-10-10T12:00:00.000Z");
    for (let i = 0; i < 5; i += 1) {
      await insertTenant(pool, { name: `Paging Fjord ${i}`, created_at: sameInstant });
    }
    await insertTenant(pool, {
      name: "Paging Fjord suspended",
      status: "suspended",
      suspension_reason: "abuse",
    });
    await insertTenant(pool, { name: "Paging Fjord gone", status: "deleted", deleted_at: sameInstant });

    const all = await pageThrough({ limit: 2 });
    const expected = await shownTenantIds();
    expect(expected.length).toBeGreaterThanOrEqual(6);
    expect(all.ids).toEqual(expected);
    expect(new Set(all.ids).size).toBe(all.ids.length);
    expect(all.pages).toBe(Math.ceil(expected.length / 2));

    const filtered = await pageThrough({ q: "paging fjord", limit: 2 });
    expect(filtered.ids).toEqual(await shownTenantIds("name ILIKE 'Paging Fjord%'"));
    expect(filtered.ids).toHaveLength(6);
    expect(filtered.pages).toBe(3);
  });

  it("matches part of the key or the name and filters by status and plan", async () => {
    const plan = await insertPlan(pool, { code: "fjord_pro" });
    const suspended = await insertTenant(pool, {
      key: "fjordpro",
      name: "Fjord Pro Travel",
      plan_code: plan.code,
      status: "suspended",
      suspension_reason: "request",
      suspended_at: new Date("2026-10-05T09:00:00Z"),
    });
    const failed = await insertTenant(pool, { key: "fjordfail", name: "Westcoast Trips", status: "failed" });

    const ids = async (query: Record<string, string>): Promise<string[]> => {
      const res = await t.http
        .get("/v1/admin/tenants")
        .query(query)
        .set(await adminHeaders());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expectResponseToMatch("adminListTenants", res, { document: "platform" });
      return (res.body as ListBody).data.map(({ id }) => id);
    };

    expect(await ids({ q: "FJORDPRO" })).toEqual([suspended.id]);
    expect(await ids({ q: "westcoast" })).toEqual([failed.id]);
    expect(await ids({ q: "fjord", status: "failed" })).toEqual([failed.id]);
    expect(await ids({ planCode: plan.code })).toEqual([suspended.id]);
    expect(await ids({ status: "suspended", planCode: plan.code })).toEqual([suspended.id]);
    expect(await ids({ status: "active", planCode: plan.code })).toEqual([]);
    // `%` and `_` are plain characters, not patterns.
    expect(await ids({ q: "%" })).toEqual([]);
  });

  it("answers 400 on /query/cursor for a cursor that is not one of the list", async () => {
    const unknown = Buffer.from(JSON.stringify({ id: testId("ten", 9999) }), "utf8").toString("base64url");
    for (const cursor of ["not-a-cursor", unknown, Buffer.from("[]", "utf8").toString("base64url")]) {
      const res = await t.http
        .get("/v1/admin/tenants")
        .query({ cursor })
        .set(await adminHeaders());
      expect(res.status, cursor).toBe(400);
      expect(errorOf(res).code).toBe("VALIDATION_FAILED");
      expect(errorOf(res).fieldErrors?.map(({ path }) => path)).toEqual(["/query/cursor"]);
    }
    const tooMany = await t.http
      .get("/v1/admin/tenants")
      .query({ limit: 201 })
      .set(await adminHeaders());
    expect(tooMany.status).toBe(400);
  });
});

describe("adminGetTenant", () => {
  interface FullOta {
    readonly tenant: PlatformRow<"tenants">;
    readonly owner: PlatformRow<"accounts">;
    readonly adminMember: PlatformRow<"accounts">;
    readonly jobIds: string[];
    readonly auditIds: string[];
    /** The `token_hash` values of the OTA's invitations, which no answer may contain. */
    readonly tokenHashes: string[];
  }

  /** The failed job's error, longer than the 1000 characters of `AdminProvisioningJob.error`. */
  const LONG_JOB_ERROR = `LOCK_TIMEOUT: ${"the schema was busy; ".repeat(60)}`;

  let full: FullOta;

  beforeAll(async () => {
    full = await fullOta();
    // About a hundred rows, written one by one.
  }, SETUP_TIMEOUT_MS);

  /** An OTA with a row of every kind the detail shows, secrets included in the tables. */
  async function fullOta(): Promise<FullOta> {
    const owner = await insertAccount(pool, { full_name: "Anna Berg", mfa_enabled: true });
    const adminMember = await insertAccount(pool);
    const removed = await insertAccount(pool);
    const { tenant } = await insertOta(pool, {
      tenant: {
        name: "Acme Travel",
        legal_name: "Acme Travel AS",
        country_code: "NO",
        time_zone: "Europe/Oslo",
        support_email: "support@acme-travel.example.com",
        schema_version: "0002_tenant_mvp",
        metadata: { notes: "Pilot customer; contact Anna for anything urgent.", source: "sales" },
      },
      subscription: {},
    });
    await insertMembership(pool, tenant, owner, {
      role: "owner",
      created_at: new Date("2026-10-01T08:00:00Z"),
    });
    await insertMembership(pool, tenant, adminMember, {
      role: "admin",
      created_at: new Date("2026-10-02T08:00:00Z"),
    });
    await insertMembership(pool, tenant, removed, { role: "agent", status: "removed" });
    const tokenHashes: string[] = [];
    for (const [status, email] of [
      ["pending", "jo@acme-travel.example.com"],
      ["revoked", "old@acme-travel.example.com"],
    ] as const) {
      const tokenHash = `${"0".repeat(60)}${String(next).padStart(4, "0")}`;
      tokenHashes.push(tokenHash);
      await insertRow(pool, "tenant_invitations", {
        id: nextId("ivt"),
        tenant_id: tenant.id,
        email,
        role: "agent",
        token_hash: tokenHash,
        status,
        invited_by_account_id: owner.id,
        expires_at: new Date(t.clock.now().getTime() + 7 * 24 * HOUR_MS),
      });
    }

    // Connections with every ciphertext column filled.
    await insertSupplierConnection(pool, tenant, {
      ...velexisSource(velexisTest),
      office_ids: ["NCE1A0955"],
      default_office_id: "NCE1A0955",
      status: "active",
    });
    await insertSupplierConnection(pool, tenant, { environment: "live", client_id: "acme-live-client" });
    await insertPaymentConnection(pool, tenant, { statement_descriptor_suffix: "ACME TRAVEL" });
    await insertPaymentConnection(pool, tenant, {
      environment: "live",
      account_mode: "api_keys",
      account_reference: "acct_1TestAcmeAccount",
      publishable_key: "pk_live_1TestPublishableKeyOnly",
      secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
      webhook_secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
      encryption_key_id: PLACEHOLDER_KEK_ID,
      status: "pending",
    });
    await insertTenantDomain(pool, tenant, {
      hostname: "travel.acme.example.net",
      kind: "custom",
      verification_status: "pending",
      verification_token: "vx-verify-ACMEACMEACMEACMEACMEACMEACMEAC",
      verified_at: null,
    });

    // 22 jobs of the API's kinds (the provision job holds the reveal ciphertext), one post-MVP `export` job (never
    // shown) and a job of another OTA.
    const jobIds: string[] = [];
    const start = t.clock.now().getTime() - 100 * HOUR_MS;
    for (let i = 0; i < 22; i += 1) {
      const id = nextId("job");
      const created = new Date(start + i * HOUR_MS);
      await insertRow(pool, "provisioning_jobs", {
        id,
        tenant_id: tenant.id,
        kind: i === 0 ? "provision" : "migrate",
        status: i === 21 ? "failed" : "succeeded",
        step: i === 0 ? "notify" : "run_migrations",
        attempt: 1,
        error: i === 21 ? LONG_JOB_ERROR : null,
        payload: { requestedBy: "test" },
        result: i === 0 ? { schemaVersion: "0002_tenant_mvp" } : null,
        reveal_ciphertext: i === 0 ? Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8") : null,
        reveal_encryption_key_id: i === 0 ? PLACEHOLDER_KEK_ID : null,
        scheduled_at: created,
        started_at: created,
        finished_at: new Date(created.getTime() + 60_000),
        created_at: created,
      });
      jobIds.push(id);
    }
    await insertRow(pool, "provisioning_jobs", {
      id: nextId("job"),
      tenant_id: tenant.id,
      kind: "export",
      status: "succeeded",
      created_at: new Date(start + 30 * HOUR_MS),
    });

    // 52 audit rows of the OTA, and one of another OTA.
    const auditIds: string[] = [];
    for (let i = 0; i < 52; i += 1) {
      const row = await insertRow(pool, "platform_audit_log", {
        actor_type: "account",
        actor_account_id: owner.id,
        actor_label: owner.email,
        action: "invitation.created",
        target_type: "invitation",
        target_id: testId("ivt", 7000 + i),
        tenant_id: tenant.id,
        tenant_key: tenant.key,
        request_id: `req_${i}`,
        ip_address: "198.51.100.23",
        user_agent: "Mozilla/5.0 (Test)",
        details: { email: `person${i}@acme-travel.example.com`, role: "agent" },
      });
      auditIds.push(row.id);
    }
    const stranger = await insertOta(pool);
    await insertRow(pool, "platform_audit_log", {
      actor_type: "system",
      action: "tenant.activated",
      target_type: "tenant",
      target_id: stranger.tenant.id,
      tenant_id: stranger.tenant.id,
      tenant_key: stranger.tenant.key,
    });
    return { tenant, owner, adminMember, jobIds, auditIds, tokenHashes };
  }

  it("[PBE-029 AC2] answers the control-plane view, valid against the document, with no property ending in Ciphertext", async () => {
    const { tenant, owner, adminMember, jobIds, auditIds, tokenHashes } = full;

    const res = await t.http.get(`/v1/admin/tenants/${tenant.id}`).set(await adminHeaders());

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectResponseToMatch("adminGetTenant", res, { document: "platform" });
    expect(res.headers["etag"]).toBe(`"${tenant.version}"`);
    expect(propertyNames(res.body).filter((name) => /ciphertext$/i.test(name))).toEqual([]);
    expect(res.text).not.toContain(PLACEHOLDER_CIPHERTEXT);
    expect(res.text).not.toContain(Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8").toString("base64"));
    expect(res.text).not.toContain(Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8").toString("hex"));
    expect(res.text).not.toContain(PLACEHOLDER_KEK_ID);
    for (const tokenHash of tokenHashes) {
      expect(res.text).not.toContain(tokenHash);
    }
    expect(res.text).not.toContain("requestedBy");

    const body = res.body as {
      tenant: Record<string, unknown>;
      members: Array<{ accountId: string; role: string }>;
      invitations: Array<{ email: string; status: string }>;
      subscription: { planCode: string; status: string } | null;
      amadeusConnections: Array<{ environment: string; credentialSource: string }>;
      paymentConnections: Array<{ environment: string; accountMode: string }>;
      domains: Array<{ hostname: string }>;
      recentJobs: Array<{ id: string; kind: string; tenantKey: string; error: string | null }>;
      recentAudit: Array<{ id: string; tenantId: string }>;
    };
    expect(body.tenant).toEqual({
      id: tenant.id,
      key: tenant.key,
      name: "Acme Travel",
      legalName: "Acme Travel AS",
      status: "active",
      suspensionReason: null,
      suspendedAt: null,
      billingNotice: null,
      planCode: tenant.plan_code,
      defaultCurrency: "EUR",
      countryCode: "NO",
      timeZone: "Europe/Oslo",
      supportEmail: "support@acme-travel.example.com",
      storefrontEnvironment: "test",
      liveEnabledAt: null,
      primaryHost: `${tenant.key}.${TEST_BASE_DOMAIN}`,
      schemaVersion: "0002_tenant_mvp",
      notes: "Pilot customer; contact Anna for anything urgent.",
      createdAt: tenant.created_at.toISOString(),
      activatedAt: tenant.activated_at?.toISOString(),
      version: tenant.version,
    });
    expect(body.members.map(({ accountId, role }) => [accountId, role])).toEqual([
      [owner.id, "owner"],
      [adminMember.id, "admin"],
    ]);
    expect(body.invitations.map(({ email, status }) => [email, status])).toEqual([
      ["jo@acme-travel.example.com", "pending"],
    ]);
    expect(body.subscription).toMatchObject({ planCode: tenant.plan_code, status: "trialing" });
    expect(body.amadeusConnections.map((c) => [c.environment, c.credentialSource])).toEqual([
      ["test", "velexis"],
      ["live", "tenant"],
    ]);
    expect(body.paymentConnections.map((c) => [c.environment, c.accountMode])).toEqual([
      ["test", "velexis"],
      ["live", "api_keys"],
    ]);
    expect(body.domains.map(({ hostname }) => hostname).sort()).toEqual(
      [`${tenant.key}.${TEST_BASE_DOMAIN}`, "travel.acme.example.net"].sort(),
    );
    expect(body.recentJobs.map(({ id }) => id)).toEqual(jobIds.slice(-20).reverse());
    expect(
      body.recentJobs.every(({ kind, tenantKey }) => kind === "migrate" && tenantKey === tenant.key),
    ).toBe(true);
    // The newest job failed with an error longer than the document allows: the answer cuts it to 1000 characters.
    expect(LONG_JOB_ERROR.length).toBeGreaterThan(1000);
    expect(body.recentJobs[0]?.error).toBe(LONG_JOB_ERROR.slice(0, 1000));
    expect(body.recentAudit.map(({ id }) => id)).toEqual(auditIds.slice(-50).reverse());
    expect(body.recentAudit.every(({ tenantId }) => tenantId === tenant.id)).toBe(true);
  });

  it("answers subscription null for an OTA without one, and 404 for an unknown or deleted OTA", async () => {
    const { tenant } = await insertOta(pool, { tenant: { status: "provisioning", activated_at: null } });
    const res = await t.http.get(`/v1/admin/tenants/${tenant.id}`).set(await adminHeaders());
    expect(res.status).toBe(200);
    expectResponseToMatch("adminGetTenant", res, { document: "platform" });
    expect(res.body).toMatchObject({
      subscription: null,
      members: [],
      invitations: [],
      amadeusConnections: [],
      paymentConnections: [],
      recentJobs: [],
      recentAudit: [],
    });

    const deleted = await insertTenant(pool, {
      status: "deleted",
      deleted_at: new Date("2026-10-09T09:00:00Z"),
    });
    for (const id of [testId("ten", 9998), deleted.id]) {
      const missing = await t.http.get(`/v1/admin/tenants/${id}`).set(await adminHeaders());
      expect(missing.status, id).toBe(404);
      expectResponseToMatch("adminGetTenant", missing, { document: "platform" });
      expect(errorOf(missing).code).toBe("NOT_FOUND");
    }
  });
});

describe("adminUpdateTenant", () => {
  async function auditRowsOf(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = 'tenant.updated' ORDER BY id",
      [tenantId],
    );
    return rows as Array<Record<string, unknown>>;
  }

  async function tenantRow(tenantId: string): Promise<PlatformRow<"tenants">> {
    const { rows } = await pool.query("SELECT * FROM platform.tenants WHERE id = $1", [tenantId]);
    return rows[0] as PlatformRow<"tenants">;
  }

  it("stores the notes in metadata.notes and the legal name with If-Match, audits once and publishes a tenant invalidation", async () => {
    const { tenant } = await insertOta(pool, { tenant: { metadata: { source: "sales" } } });
    events.length = 0;

    const detail = await t.http.get(`/v1/admin/tenants/${tenant.id}`).set(await adminHeaders());
    const etag = detail.headers["etag"] as string;
    const res = await t.http
      .patch(`/v1/admin/tenants/${tenant.id}`)
      .set(await adminHeaders())
      .set("If-Match", etag)
      .send({ notes: "Pilot customer.", legalName: "Fjord Travel AS" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectResponseToMatch("adminUpdateTenant", res, { document: "platform" });
    expect(res.headers["etag"]).toBe(`"${tenant.version + 1}"`);
    expect(res.body).toMatchObject({
      id: tenant.id,
      notes: "Pilot customer.",
      legalName: "Fjord Travel AS",
      version: tenant.version + 1,
    });
    const row = await tenantRow(tenant.id);
    expect(row.metadata).toEqual({ source: "sales", notes: "Pilot customer." });
    expect(row.legal_name).toBe("Fjord Travel AS");
    expect(row.updated_at.toISOString()).toBe(t.clock.now().toISOString());

    const audit = await auditRowsOf(tenant.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "platform_admin",
      actor_account_id: admin.id,
      actor_label: admin.email,
      target_type: "tenant",
      target_id: tenant.id,
      tenant_key: tenant.key,
      ip_address: ADMIN_IP,
      details: {
        before: { legalName: null, notes: null },
        after: { legalName: "Fjord Travel AS", notes: "Pilot customer." },
      },
    });
    await vi.waitFor(
      () => {
        expect(events).toContainEqual({ v: 1, type: "tenant", id: tenant.id });
      },
      { timeout: WAIT_MS },
    );
  });

  it("clears the notes with null in any tenant status, and writes nothing for a request that changes nothing", async () => {
    const { tenant } = await insertOta(pool, {
      tenant: {
        status: "suspended",
        suspension_reason: "abuse",
        suspended_at: new Date("2026-10-05T09:00:00Z"),
        legal_name: "Kept AS",
        metadata: { notes: "Watch this one.", source: "sales" },
      },
    });

    const cleared = await t.http
      .patch(`/v1/admin/tenants/${tenant.id}`)
      .set(await adminHeaders())
      .set("If-Match", `"${tenant.version}"`)
      .send({ notes: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expectResponseToMatch("adminUpdateTenant", cleared, { document: "platform" });
    expect(cleared.body).toMatchObject({
      status: "suspended",
      suspensionReason: "abuse",
      suspendedAt: "2026-10-05T09:00:00.000Z",
      notes: null,
      legalName: "Kept AS",
    });
    expect((await tenantRow(tenant.id)).metadata).toEqual({ source: "sales" });

    const unchanged = await t.http
      .patch(`/v1/admin/tenants/${tenant.id}`)
      .set(await adminHeaders())
      .set("If-Match", `"${tenant.version + 1}"`)
      .send({ notes: null, legalName: "Kept AS" });
    expect(unchanged.status).toBe(200);
    expect(unchanged.headers["etag"]).toBe(`"${tenant.version + 1}"`);
    expect((await tenantRow(tenant.id)).version).toBe(tenant.version + 1);
    expect(await auditRowsOf(tenant.id)).toHaveLength(1);
  });

  it("answers 412 for a stale If-Match, 404 for an unknown OTA and 400 for an empty or unknown body", async () => {
    const { tenant } = await insertOta(pool);
    const stale = await t.http
      .patch(`/v1/admin/tenants/${tenant.id}`)
      .set(await adminHeaders())
      .set("If-Match", `"${tenant.version + 5}"`)
      .send({ notes: "Too late." });
    expect(stale.status).toBe(412);
    expectResponseToMatch("adminUpdateTenant", stale, { document: "platform" });
    expect(errorOf(stale).code).toBe("PRECONDITION_FAILED");
    expect((await tenantRow(tenant.id)).version).toBe(tenant.version);
    expect(await auditRowsOf(tenant.id)).toEqual([]);

    const unknown = await t.http
      .patch(`/v1/admin/tenants/${testId("ten", 9997)}`)
      .set(await adminHeaders())
      .set("If-Match", '"1"')
      .send({ notes: "Nobody." });
    expect(unknown.status).toBe(404);

    for (const body of [{}, { name: "Renamed" }, { notes: "x".repeat(4001) }]) {
      const invalid = await t.http
        .patch(`/v1/admin/tenants/${tenant.id}`)
        .set(await adminHeaders())
        .set("If-Match", `"${tenant.version}"`)
        .send(body);
      expect(invalid.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(errorOf(invalid).code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("adminGetDashboard", () => {
  interface DashboardBody {
    readonly tenantsByStatus: Record<(typeof STATUSES)[number], number>;
    readonly provisioningFailed24h: number;
    readonly jobsFailedByQueue: Record<string, number>;
    readonly officePool: Array<{ environment: string; available: number; assigned: number }>;
    readonly domainsPending: number | null;
    readonly settlementsToReview: number | null;
    readonly stripeEventsFailed: number | null;
    readonly subscriptionsPastDue: number | null;
  }

  async function dashboard(): Promise<DashboardBody> {
    const res = await t.http.get("/v1/admin/dashboard").set(await adminHeaders());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectResponseToMatch("adminGetDashboard", res, { document: "platform" });
    return res.body as DashboardBody;
  }

  const failedQueue = PLATFORM_QUEUE.domains;

  beforeAll(async () => {
    // Two jobs on a platform queue that BullMQ fails at once (no retry), by a worker of this test only; the API itself
    // runs no processor.
    const connection = new Redis(t.redis.url, { maxRetriesPerRequest: null });
    const queue = new Queue(failedQueue, { connection, prefix: BULLMQ_PREFIX });
    const worker = new Worker(
      failedQueue,
      () => {
        throw new UnrecoverableError("a test job that fails");
      },
      { connection, prefix: BULLMQ_PREFIX },
    );
    try {
      await queue.add("domain.verify", { domainId: testId("dom", 9001) }, { attempts: 1 });
      await queue.add("domain.verify", { domainId: testId("dom", 9002) }, { attempts: 1 });
      await vi.waitFor(
        async () => {
          expect(await queue.getFailedCount()).toBe(2);
        },
        { timeout: WAIT_MS, interval: 50 },
      );
    } finally {
      await worker.close();
      await queue.close();
      await connection.quit();
    }
    // Redis connections, a BullMQ worker and its first jobs.
  }, SETUP_TIMEOUT_MS);

  it("[PBE-029 AC3] answers the M5 counters null while every switch is off, whatever the tables hold", async () => {
    const { tenant } = await insertOta(pool, { subscription: { status: "past_due" } });
    await insertTenantDomain(pool, tenant, {
      hostname: "pending.dashboard.example.net",
      kind: "custom",
      verification_status: "pending",
      verification_token: "vx-verify-DASHDASHDASHDASHDASHDASHDASHDA",
      verified_at: null,
    });
    await insertSettlement(pool, tenant);
    await insertRow(pool, "stripe_events", {
      id: "evt_1TestDashboardFailed",
      endpoint: "billing",
      type: "invoice.paid",
      livemode: false,
      stripe_created_at: new Date("2026-10-01T09:00:00Z"),
      status: "failed",
      last_error: "test failure",
    });

    const body = await dashboard();

    expect(body).toMatchObject({
      domainsPending: null,
      settlementsToReview: null,
      stripeEventsFailed: null,
      subscriptionsPastDue: null,
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        "tenantsByStatus",
        "provisioningFailed24h",
        "jobsFailedByQueue",
        "officePool",
        "domainsPending",
        "settlementsToReview",
        "stripeEventsFailed",
        "subscriptionsPastDue",
      ].sort(),
    );
  });

  it("counts the OTAs by status and the tenant jobs that failed in the last 24 hours of the clock", async () => {
    const before = await dashboard();
    const tenant = await insertTenant(pool, { status: "provisioning", activated_at: null });
    await insertTenant(pool, { status: "suspended", suspension_reason: "admin" });
    await insertTenant(pool, { status: "suspended", suspension_reason: "billing" });
    await insertTenant(pool, { status: "failed", activated_at: null });
    await insertTenant(pool, { status: "deleted", deleted_at: new Date("2026-10-09T09:00:00Z") });
    const now = t.clock.now().getTime();
    for (const [status, finishedHoursAgo] of [
      ["failed", 2],
      ["failed", 23],
      ["failed", 30],
      ["succeeded", 1],
    ] as const) {
      await insertRow(pool, "provisioning_jobs", {
        id: nextId("job"),
        tenant_id: tenant.id,
        kind: "migrate",
        status,
        attempt: 1,
        finished_at: new Date(now - finishedHoursAgo * HOUR_MS),
      });
    }

    const after = await dashboard();

    expect(after.tenantsByStatus).toEqual({
      provisioning: before.tenantsByStatus.provisioning + 1,
      active: before.tenantsByStatus.active,
      suspended: before.tenantsByStatus.suspended + 2,
      failed: before.tenantsByStatus.failed + 1,
    });
    expect(after.provisioningFailed24h).toBe(before.provisioningFailed24h + 2);
    const { rows } = await pool.query(
      "SELECT status, count(*)::int AS n FROM platform.tenants WHERE status IN ('provisioning', 'active', 'suspended', 'failed') GROUP BY status",
    );
    const counted = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const row of rows as Array<{ status: string; n: number }>) {
      counted[row.status] = row.n;
    }
    expect(after.tenantsByStatus).toEqual(counted);
  });

  it("counts the failed jobs of every platform queue from BullMQ, zero included", async () => {
    const body = await dashboard();

    expect(Object.keys(body.jobsFailedByQueue).sort()).toEqual([...PLATFORM_QUEUES].sort());
    for (const queue of PLATFORM_QUEUES) {
      expect(body.jobsFailedByQueue[queue], queue).toBe(queue === failedQueue ? 2 : 0);
    }
  });

  it("shows the office pool of each environment with a Velexis Amadeus account, test before live", async () => {
    const live = await insertAmadeusAccount(pool, {
      environment: "live",
      base_url: "https://travel.api.amadeus.com",
    });
    const { tenant } = await insertOta(pool);
    for (const status of ["available", "available", "available", "assigned", "retired"] as const) {
      await insertAmadeusOffice(pool, velexisTest, {
        status,
        ...(status === "assigned" ? { assigned_tenant_id: tenant.id, assigned_at: t.clock.now() } : {}),
      });
    }
    await insertAmadeusOffice(pool, live);

    const body = await dashboard();

    expect(body.officePool).toEqual([
      { environment: "test", available: 3, assigned: 1 },
      { environment: "live", available: 1, assigned: 0 },
    ]);
  });
});
