// The platform audit log in the platform admin (PBE-032; scope PF-85, PADR-0006 "Audit", platform/docs/
// api-inventory-admin.md §7, flows/platform-admin-operations.md §I) through the HTTP pipeline (createTestApp) on this
// file's database clone: the search by OTA, actor, action, target and period with its cursor, and the CSV export
// (headers, records, the formula neutralisation, the one-year period, the 100 000-row cap, and the audit row the export
// writes). JSON answers are checked against the platform document; the CSV is compared with the search's rows.
//
// Audit rows are written as rows with `created_at` relative to the real time of the run (the column defaults to the
// database's `now()`, and the export's period is checked against nothing else), oldest first, so their ids follow
// their times. The 100 000-row export runs once, in its group's setup hook, with an explicit bound.
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditCsvHeader, auditCsvRecord, type AuditEntry } from "../../../src/audit/audit-csv";
import { AuditQueryService, EXPORT_MAX_ROWS } from "../../../src/audit/audit-query.service";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  insertAccount,
  insertTenant,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { createTestApp, type TestApp } from "../../support/app";

/** Starting the API on a database clone and parsing the platform document take seconds; bounded for a loaded runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** Writing 100 005 audit rows in one statement and exporting 100 000 of them: seconds; bounded for a loaded runner. */
const LARGE_EXPORT_TIMEOUT_MS = 120_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_IP = "203.0.113.30";

let t: TestApp;
let pool: PlatformPool;
let admin: PlatformRow<"accounts">;
let actorX: PlatformRow<"accounts">;
let actorY: PlatformRow<"accounts">;
let tenantA: PlatformRow<"tenants">;
let tenantB: PlatformRow<"tenants">;
/** The rows of the filter tests, by name, oldest first. */
const rows: Record<"r1" | "r2" | "r3" | "r4" | "r5", string> = { r1: "", r2: "", r3: "", r4: "", r5: "" };
/** The time the rows are placed around: the start of this run. */
const runStart = Date.now();
const daysAgo = (days: number): Date => new Date(runStart - days * DAY_MS);

interface AuditInsert {
  readonly actorType: string;
  readonly actorAccountId?: string;
  readonly actorLabel?: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly tenant?: PlatformRow<"tenants">;
  readonly userAgent?: string;
  readonly details?: Record<string, unknown>;
  readonly createdAt: Date;
}

/** Writes one audit row and returns its id. */
async function insertAudit(row: AuditInsert): Promise<string> {
  const { rows: inserted } = await pool.query<{ id: string }>(
    "INSERT INTO platform.platform_audit_log (actor_type, actor_account_id, actor_label, action, target_type, " +
      "target_id, tenant_id, tenant_key, request_id, ip_address, user_agent, details, created_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id::text AS id",
    [
      row.actorType,
      row.actorAccountId ?? null,
      row.actorLabel ?? null,
      row.action,
      row.targetType,
      row.targetId,
      row.tenant?.id ?? null,
      row.tenant?.key ?? null,
      "req_01JC4M2P6R0T4W8Y2A6C0E4G8K",
      "198.51.100.23",
      row.userAgent ?? "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0",
      JSON.stringify(row.details ?? {}),
      row.createdAt,
    ],
  );
  return inserted[0]?.id ?? "";
}

beforeAll(async () => {
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  admin = await insertAccount(pool, {
    email: "lena.holm@velexis.example.com",
    is_platform_admin: true,
    mfa_enabled: true,
    mfa_secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
    encryption_key_id: PLACEHOLDER_KEK_ID,
  });
  actorX = await insertAccount(pool, { email: "anna.berg@example.com" });
  actorY = await insertAccount(pool, { email: "bo.lind@example.com" });
  tenantA = await insertTenant(pool, { key: "acme" });
  tenantB = await insertTenant(pool, { key: "nordic" });
  rows.r1 = await insertAudit({
    actorType: "account",
    actorAccountId: actorX.id,
    actorLabel: actorX.email,
    action: "invitation.created",
    targetType: "invitation",
    targetId: testId("ivt", 1),
    tenant: tenantA,
    details: { email: "jo@acme-travel.example.com", role: "agent" },
    createdAt: daysAgo(40),
  });
  rows.r2 = await insertAudit({
    actorType: "platform_admin",
    actorAccountId: admin.id,
    actorLabel: admin.email,
    action: "tenant.suspended",
    targetType: "tenant",
    targetId: tenantA.id,
    tenant: tenantA,
    details: { reason: "Card testing, reported by Stripe.", before: { status: "active" } },
    createdAt: daysAgo(20),
  });
  rows.r5 = await insertAudit({
    actorType: "system",
    actorLabel: "provisioning.activate",
    action: "tenant.activated",
    targetType: "tenant",
    targetId: tenantB.id,
    tenant: tenantB,
    createdAt: daysAgo(15),
  });
  rows.r3 = await insertAudit({
    actorType: "account",
    actorAccountId: actorX.id,
    actorLabel: actorX.email,
    action: "api_key.revoked",
    targetType: "api_key",
    targetId: testId("key", 3),
    tenant: tenantB,
    // A browser string that a spreadsheet would run as a formula.
    userAgent: '=HYPERLINK("https://attacker.example.net","x")',
    createdAt: daysAgo(5),
  });
  rows.r4 = await insertAudit({
    actorType: "account",
    actorAccountId: actorY.id,
    actorLabel: actorY.email,
    action: "account.updated",
    targetType: "account",
    targetId: actorY.id,
    createdAt: daysAgo(1),
  });
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in the first test.
  responseChecker("platform");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

async function adminHeaders(): Promise<Record<string, string>> {
  const { token } = await t.app.get(TokenService).sign({
    aud: "platform_admin",
    sub: admin.id,
    sid: testId("asn", 1),
    ev: true,
    amr: ["pwd", "otp"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

/** A query string of `params` (values URI-encoded). */
function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");
}

async function listAudit(params: Record<string, string>): Promise<Response> {
  return t.http.get(`/v1/admin/audit-log?${query(params)}`).set(await adminHeaders());
}

async function exportAudit(params: Record<string, string>): Promise<Response> {
  return t.http
    .get(`/v1/admin/audit-log.csv?${query(params)}`)
    .set(await adminHeaders())
    .buffer(true);
}

/** The ids of an `AuditEntryList` answer. */
function idsOf(res: Response): string[] {
  return (res.body as { data: Array<{ id: string }> }).data.map((row) => row.id);
}

function errorOf(res: Response): { code: string; fieldErrors?: unknown } {
  return (res.body as { error: { code: string; fieldErrors?: unknown } }).error;
}

async function auditMark(): Promise<string> {
  const { rows: found } = await pool.query<{ id: string }>(
    "SELECT coalesce(max(id), 0)::text AS id FROM platform.platform_audit_log",
  );
  return found[0]?.id ?? "0";
}

async function auditRowsSince(mark: string): Promise<Array<Record<string, unknown>>> {
  const { rows: found } = await pool.query(
    "SELECT actor_type, actor_account_id, action, target_type, target_id, tenant_id, host(ip_address) AS ip_address, " +
      "details FROM platform.platform_audit_log WHERE id > $1 ORDER BY id",
    [mark],
  );
  return found as Array<Record<string, unknown>>;
}

/** The period that holds every row of the filter tests and none of the large export's. */
const filterPeriod = (): Record<string, string> => ({
  from: daysAgo(50).toISOString(),
  to: daysAgo(-1).toISOString(),
});

describe("adminListAudit", () => {
  it("filters by OTA, newest first [PBE-032 AC1]", async () => {
    const res = await listAudit({ tenantId: tenantA.id });

    expect(res.status).toBe(200);
    expectResponseToMatch("adminListAudit", res, { document: "platform" });
    expect(idsOf(res)).toEqual([rows.r2, rows.r1]);
    expect((res.body as { data: AuditEntry[] }).data[0]).toEqual({
      id: rows.r2,
      tenantId: tenantA.id,
      tenantKey: "acme",
      actorType: "platform_admin",
      actorAccountId: admin.id,
      actorLabel: admin.email,
      action: "tenant.suspended",
      targetType: "tenant",
      targetId: tenantA.id,
      requestId: "req_01JC4M2P6R0T4W8Y2A6C0E4G8K",
      ipAddress: "198.51.100.23",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0",
      details: { reason: "Card testing, reported by Stripe.", before: { status: "active" } },
      createdAt: daysAgo(20).toISOString(),
    });
  });

  it("filters by acting account and by actor type [PBE-032 AC1]", async () => {
    const byActor = await listAudit({ actorAccountId: actorX.id });
    const bySystem = await listAudit({ actorType: "system", ...filterPeriod() });

    expect(idsOf(byActor)).toEqual([rows.r3, rows.r1]);
    expect(idsOf(bySystem)).toEqual([rows.r5]);
    expectResponseToMatch("adminListAudit", bySystem, { document: "platform" });
  });

  it("filters by exact action and by target [PBE-032 AC1]", async () => {
    const byAction = await listAudit({ action: "tenant.suspended" });
    const byPrefix = await listAudit({ action: "tenant.suspend" });
    const byTarget = await listAudit({ targetType: "api_key", targetId: testId("key", 3) });
    const byTargetType = await listAudit({ targetType: "tenant", ...filterPeriod() });

    expect(idsOf(byAction)).toEqual([rows.r2]);
    expect(idsOf(byPrefix)).toEqual([]);
    expect(idsOf(byTarget)).toEqual([rows.r3]);
    expect(idsOf(byTargetType)).toEqual([rows.r5, rows.r2]);
  });

  it("filters by period, from inclusive and to exclusive, and combines the filters [PBE-032 AC1]", async () => {
    const period = await listAudit({ from: daysAgo(30).toISOString(), to: daysAgo(10).toISOString() });
    const fromExact = await listAudit({ from: daysAgo(20).toISOString(), to: daysAgo(15).toISOString() });
    const combined = await listAudit({
      tenantId: tenantB.id,
      actorAccountId: actorX.id,
      from: daysAgo(10).toISOString(),
    });
    const onlyTo = await listAudit({ to: daysAgo(30).toISOString(), tenantId: tenantA.id });

    expect(idsOf(period)).toEqual([rows.r5, rows.r2]);
    // r2 was written exactly at `from` (kept), r5 exactly at `to` (left out).
    expect(idsOf(fromExact)).toEqual([rows.r2]);
    expect(idsOf(combined)).toEqual([rows.r3]);
    expect(idsOf(onlyTo)).toEqual([rows.r1]);
  });

  it("refuses a period whose from is after its to", async () => {
    const res = await listAudit({ from: daysAgo(1).toISOString(), to: daysAgo(2).toISOString() });

    expect(res.status).toBe(400);
    expectResponseToMatch("adminListAudit", res, { document: "platform" });
    expect(errorOf(res)).toEqual(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        fieldErrors: [expect.objectContaining({ path: "/query/from", code: "after_to" })],
      }),
    );
  });

  it("pages with an opaque cursor and refuses one that is not a cursor of the list", async () => {
    const first = await listAudit({ ...filterPeriod(), limit: "2" });
    const firstBody = first.body as { page: { nextCursor: string | null; limit: number } };
    expect(idsOf(first)).toEqual([rows.r4, rows.r3]);
    expect(firstBody.page.limit).toBe(2);

    const second = await listAudit({
      ...filterPeriod(),
      limit: "2",
      cursor: firstBody.page.nextCursor ?? "",
    });
    const third = await listAudit({
      ...filterPeriod(),
      limit: "2",
      cursor: (second.body as { page: { nextCursor: string } }).page.nextCursor,
    });
    expect(idsOf(second)).toEqual([rows.r5, rows.r2]);
    expect(third.body).toEqual({
      data: [expect.objectContaining({ id: rows.r1 })],
      page: { nextCursor: null, limit: 2 },
    });

    const cursorOf = (id: string): string => Buffer.from(JSON.stringify({ id })).toString("base64url");
    // Not base64url, not JSON, the id of no row, and an id beyond the bigint column.
    for (const cursor of ["%%%", "bm90LWpzb24", cursorOf("999999999"), cursorOf("9999999999999999999")]) {
      const res = await listAudit({ cursor });
      expect(res.status).toBe(400);
      expect(errorOf(res).fieldErrors).toEqual([expect.objectContaining({ path: "/query/cursor" })]);
    }
  });

  it("refuses a call without an admin token", async () => {
    const res = await t.http.get("/v1/admin/audit-log").set(t.bffHeaders(ADMIN_IP));
    expect([res.status, errorOf(res).code]).toEqual([401, "UNAUTHENTICATED"]);
  });
});

describe("adminExportAudit", () => {
  const from = daysAgo(50);
  const to = daysAgo(-1);
  let mark: string;
  let res: Response;
  let listed: Response;

  beforeAll(async () => {
    mark = await auditMark();
    res = await exportAudit({ tenantId: tenantA.id, from: from.toISOString(), to: to.toISOString() });
    listed = await listAudit({ tenantId: tenantA.id, from: from.toISOString(), to: to.toISOString() });
  }, SETUP_TIMEOUT_MS);

  it("answers the rows of the filters as a streamed CSV attachment that is never cached [PBE-032 AC1]", () => {
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="velexis-audit-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv"`,
    );
    expect(res.headers["transfer-encoding"]).toBe("chunked");
    const entries = (listed.body as { data: AuditEntry[] }).data;
    expect(entries.map((entry) => entry.id)).toEqual([rows.r2, rows.r1]);
    expect(res.text).toBe(auditCsvHeader() + entries.map(auditCsvRecord).join(""));
  });

  it("writes one audit row audit.exported with the filters and the period [PBE-032 AC1] [PBE-032 AC4]", async () => {
    expect(await auditRowsSince(mark)).toEqual([
      {
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        action: "audit.exported",
        target_type: "audit_log",
        target_id: null,
        tenant_id: null,
        ip_address: ADMIN_IP,
        details: {
          filters: { tenantId: tenantA.id },
          from: from.toISOString(),
          to: to.toISOString(),
          maxRows: EXPORT_MAX_ROWS,
        },
      },
    ]);
  });

  it("neutralises a cell that a spreadsheet would run as a formula", async () => {
    const exported = await exportAudit({
      targetType: "api_key",
      from: from.toISOString(),
      to: to.toISOString(),
    });

    expect(exported.status).toBe(200);
    expect(exported.text).toContain(`"'=HYPERLINK(""https://attacker.example.net"",""x"")"`);
    expect(exported.text).not.toContain(",=HYPERLINK");
  });

  it("refuses a period over one year, a reversed period and a missing end, and writes no audit row", async () => {
    const before = await auditMark();
    const end = daysAgo(1);
    const oneYearBefore = new Date(end.getTime());
    oneYearBefore.setUTCFullYear(oneYearBefore.getUTCFullYear() - 1);

    const overAYear = await exportAudit({
      from: new Date(oneYearBefore.getTime() - 1000).toISOString(),
      to: end.toISOString(),
    });
    const reversed = await exportAudit({ from: end.toISOString(), to: daysAgo(2).toISOString() });
    const noEnd = await exportAudit({ from: end.toISOString() });

    for (const refused of [overAYear, reversed, noEnd]) {
      expect(refused.status).toBe(400);
      expectResponseToMatch("adminExportAudit", refused, { document: "platform" });
    }
    expect(errorOf(overAYear).fieldErrors).toEqual([
      expect.objectContaining({ path: "/query/to", code: "range" }),
    ]);
    expect(errorOf(reversed).fieldErrors).toEqual([expect.objectContaining({ path: "/query/from" })]);
    expect(errorOf(noEnd).fieldErrors).toEqual([expect.objectContaining({ path: "/query/to" })]);
    expect(await auditRowsSince(before)).toEqual([]);

    // Exactly one year is allowed.
    const oneYear = await exportAudit({ from: oneYearBefore.toISOString(), to: end.toISOString() });
    expect(oneYear.status).toBe(200);
  });

  it("refuses a call without an admin token", async () => {
    const refused = await t.http
      .get(`/v1/admin/audit-log.csv?${query({ from: from.toISOString(), to: to.toISOString() })}`)
      .set(t.bffHeaders(ADMIN_IP));
    expect([refused.status, errorOf(refused).code]).toEqual([401, "UNAUTHENTICATED"]);
  });
});

describe("a large export", () => {
  const written = EXPORT_MAX_ROWS + 5;
  const at = daysAgo(300);
  let lastId: number;
  let res: Response;
  let lines: string[];

  beforeAll(async () => {
    const { rows: inserted } = await pool.query<{ last: string }>(
      "WITH added AS (INSERT INTO platform.platform_audit_log (actor_type, actor_label, action, target_type, " +
        "target_id, details, created_at) SELECT 'api_key', 'pk_test_1a2b', 'api_key.updated', 'api_key', " +
        "'key_' || n, '{}', $2 FROM generate_series(1, $1) AS n RETURNING id) SELECT max(id)::text AS last FROM added",
      [written, at],
    );
    lastId = Number(inserted[0]?.last);
    res = await exportAudit({
      from: new Date(at.getTime() - DAY_MS).toISOString(),
      to: new Date(at.getTime() + DAY_MS).toISOString(),
    });
    lines = res.text.split("\r\n");
  }, LARGE_EXPORT_TIMEOUT_MS);

  it("holds at most 100 000 rows, newest first", () => {
    expect(res.status).toBe(200);
    // The header, 100 000 records, and the empty text after the last CRLF.
    expect(lines).toHaveLength(EXPORT_MAX_ROWS + 2);
    expect(lines[0]).toBe(auditCsvHeader().trimEnd());
    expect(lines.at(-1)).toBe("");
    expect(lines[1]?.split(",")[0]).toBe(String(lastId));
    expect(lines[EXPORT_MAX_ROWS]?.split(",")[0]).toBe(String(lastId - EXPORT_MAX_ROWS + 1));
  });

  it("aborts the answer when a batch fails after the first, so a cut file never looks complete", async () => {
    // The second batch of rows fails, as a lost database connection would, after the header and the first batch
    // have been sent.
    const service = t.app.get(AuditQueryService, { strict: false });
    const prototype = Object.getPrototypeOf(service) as { page: (...args: unknown[]) => Promise<unknown> };
    const page = prototype.page;
    let calls = 0;
    const spy = vi.spyOn(prototype, "page").mockImplementation(function (this: unknown, ...args: unknown[]) {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error("connection terminated")) : page.apply(this, args);
    });

    try {
      await expect(
        exportAudit({
          from: new Date(at.getTime() - DAY_MS).toISOString(),
          to: new Date(at.getTime() + DAY_MS).toISOString(),
        }),
      ).rejects.toThrow();
    } finally {
      // A test added after this one reads the audit log through the real queries again, even when this one fails.
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    expect(t.logs.withMessage("audit.export_failed")).toEqual([
      // pino's level 50 is `error`.
      expect.objectContaining({ level: 50, rowsWritten: 1_000 }),
    ]);
  });
});
