// The live office requests of the admin dashboard (FIX-W41-PLATFORM, lead decision (2n) of 2026-11-04;
// platform/docs/api-inventory-admin.md §2 `adminGetDashboard`, flows/platform-admin-operations.md §E,
// flows/amadeus-connection.md §C): `adminGetDashboard` through the HTTP pipeline (createTestApp), every answer checked
// against the platform document. `liveOfficeRequests` lists the OTAs whose live Velexis connection waits for an office,
// read from `supplier_connections` (never from the audit log), oldest first, then by connection id, at most 50.
//
// This file has its own database clone: the Velexis live account is one per environment, and the counters of the
// dashboard read the whole clone. Rows are written with the builders; the admin token comes from the application's
// TokenService. The other counters of the dashboard are proven in admin-tenants.int.test.ts.
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { LIVE_OFFICE_REQUESTS_LIMIT } from "../../../src/admin/admin-dashboard.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  insertAccount,
  insertAmadeusAccount,
  insertRow,
  insertSupplierConnection,
  insertTenant,
  testId,
  velexisSource,
  type PlatformRow,
} from "../../builders/platform-rows";
import { createTestApp, type TestApp } from "../../support/app";

/** Starting the API (database clone, Nest module graph, Ajv compilation of the document) takes seconds on CI. */
const SETUP_TIMEOUT_MS = 60_000;
// Documentation addresses (RFC 5737) only.
const ADMIN_IP = "203.0.113.48";
const MINUTE_MS = 60 * 1000;

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let admin: PlatformRow<"accounts">;
let velexisTest: PlatformRow<"amadeus_accounts">;
let velexisLive: PlatformRow<"amadeus_accounts">;

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, the module graph and the platform document.
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  responseChecker("platform");
  admin = await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true });
  velexisTest = await insertAmadeusAccount(pool);
  velexisLive = await insertAmadeusAccount(pool, {
    environment: "live",
    base_url: "https://travel.api.amadeus.com",
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

interface LiveOfficeRequestBody {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly tenantName: string;
  readonly connectionId: string;
  readonly requestedAt: string;
}

async function liveOfficeRequests(): Promise<LiveOfficeRequestBody[]> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: admin.id,
    sid: testId("asn", 4801),
    ev: true,
    amr: ["pwd", "otp"],
  });
  const res = await t.http
    .get("/v1/admin/dashboard")
    .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expectResponseToMatch("adminGetDashboard", res, { document: "platform" });
  return (res.body as { liveOfficeRequests: LiveOfficeRequestBody[] }).liveOfficeRequests;
}

/** An instant `minutes` minutes before the FakeClock's now. */
const minutesAgo = (minutes: number): Date => new Date(t.clock.now().getTime() - minutes * MINUTE_MS);

/** An OTA in `status` with its live Velexis connection waiting for an office, requested `minutes` ago. */
async function waitingOta(
  label: string,
  minutes: number,
  tenant: Partial<PlatformRow<"tenants">> = {},
  connection: Record<string, unknown> = {},
): Promise<{ readonly tenant: PlatformRow<"tenants">; readonly connectionId: string }> {
  const row = await insertTenant(pool, { name: `${label} Travel`, ...tenant });
  const live = await insertSupplierConnection(pool, row, {
    ...velexisSource(velexisLive),
    status: "pending_verification",
    created_at: minutesAgo(minutes),
    updated_at: minutesAgo(minutes),
    ...connection,
  });
  return { tenant: row, connectionId: live.id };
}

describe("adminGetDashboard: liveOfficeRequests", () => {
  it("[FIX-W41-PLATFORM AC9] lists the OTAs whose live Velexis connection waits for an office, oldest first, from the connections themselves", async () => {
    // Requested 30, 20 and 20 minutes ago (the last two in the same instant: the connection id orders them).
    const oldest = await waitingOta("Oldest", 30);
    const sameA = await waitingOta("Same A", 20, {}, { id: testId("sc", 48_001) });
    const sameB = await waitingOta("Same B", 20, {}, { id: testId("sc", 48_002) });
    // A suspended OTA still waits (an admin may serve it before the OTA is back).
    const suspended = await waitingOta("Paused", 10, { status: "suspended", suspension_reason: "admin" });
    // Not waiting: served (an office on it, active), disabled by an admin, a test connection, own live credentials,
    // and an OTA that is being deleted.
    await waitingOta(
      "Served",
      40,
      {},
      { status: "active", office_ids: ["LIV1A0001"], default_office_id: "LIV1A0001" },
    );
    await waitingOta("Disabled", 40, {}, { status: "disabled" });
    const testOnly = await insertTenant(pool, { name: "Test Only Travel" });
    await insertSupplierConnection(pool, testOnly, {
      ...velexisSource(velexisTest),
      status: "pending_verification",
      created_at: minutesAgo(50),
    });
    const ownLive = await insertTenant(pool, { name: "Own Live Travel" });
    await insertSupplierConnection(pool, ownLive, {
      environment: "live",
      base_url: "https://travel.api.amadeus.com",
      status: "pending_verification",
      office_ids: [],
      default_office_id: null,
      created_at: minutesAgo(50),
    });
    await waitingOta("Leaving", 60, { status: "deprovisioning" });
    await waitingOta("Gone", 60, { status: "deleted", deleted_at: minutesAgo(5) });

    const requests = await liveOfficeRequests();

    expect(requests).toEqual([
      {
        tenantId: oldest.tenant.id,
        tenantKey: oldest.tenant.key,
        tenantName: "Oldest Travel",
        connectionId: oldest.connectionId,
        requestedAt: minutesAgo(30).toISOString(),
      },
      expect.objectContaining({ tenantId: sameA.tenant.id, connectionId: sameA.connectionId }),
      expect.objectContaining({ tenantId: sameB.tenant.id, connectionId: sameB.connectionId }),
      expect.objectContaining({
        tenantId: suspended.tenant.id,
        tenantName: "Paused Travel",
        requestedAt: minutesAgo(10).toISOString(),
      }),
    ]);
    // Stable: the same answer again.
    expect(await liveOfficeRequests()).toEqual(requests);
    // The audit log plays no part: none of these requests has an `amadeus.live_requested` row, and one of another
    // OTA (whose request was served) adds nothing.
    await insertRow(pool, "platform_audit_log", {
      actor_type: "account",
      action: "amadeus.live_requested",
      target_type: "supplier_connection",
      target_id: testId("sc", 48_999),
      tenant_id: testOnly.id,
      details: { environment: "live" },
    });
    expect(await liveOfficeRequests()).toEqual(requests);

    // Once an office is assigned (the connection active with it), the request leaves the list.
    await pool.query(
      "UPDATE platform.supplier_connections SET status = 'active', office_ids = '{LIV1A0002}', default_office_id = 'LIV1A0002' WHERE id = $1",
      [oldest.connectionId],
    );
    expect((await liveOfficeRequests()).map((request) => request.tenantId)).toEqual([
      sameA.tenant.id,
      sameB.tenant.id,
      suspended.tenant.id,
    ]);
  });

  it("[FIX-W41-PLATFORM AC9] answers at most 50 requests, the oldest ones", async () => {
    // 51 more OTAs waiting, older than every request above.
    const ids: string[] = [];
    for (let index = 0; index < LIVE_OFFICE_REQUESTS_LIMIT + 1; index += 1) {
      const { tenant } = await waitingOta(`Bulk ${index}`, 10_000 - index);
      ids.push(tenant.id);
    }

    const requests = await liveOfficeRequests();

    expect(requests).toHaveLength(LIVE_OFFICE_REQUESTS_LIMIT);
    expect(requests.map((request) => request.tenantId)).toEqual(ids.slice(0, LIVE_OFFICE_REQUESTS_LIMIT));
  });
});
