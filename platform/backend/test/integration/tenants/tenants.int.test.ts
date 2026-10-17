// The tenant routes of the portal (PBE-017; platform/docs/api-inventory.md §7, scope PF-10 AC1 and PF-13) and
// TenantRoleGuard, through the HTTP pipeline (createTestApp) on this file's database clone: the key check, the list of
// the caller's OTAs, the overview and the profile update with its audit row and its `tenant` invalidation. Accounts,
// OTAs and memberships are written with the builders; tokens come from the application's TokenService. Every answer is
// checked against the platform document.
//
// Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same time,
// so the subscriber keeps only the events of this file's tenants.
import { Controller, Get, HttpCode } from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { platformOperations, type PlatformOperationId } from "@velexis/api-types/operations";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { Feature, RequireRecentMfa } from "../../../src/common/auth/decorators";
import { TENANT_ROLES_METADATA, TenantRoles } from "../../../src/common/auth/tenant-role.guard";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { boundOperationId, OpenApiOperation } from "../../../src/common/http/openapi-operation.decorator";
import { TENANT_OPERATION_ROLES } from "../../../src/memberships/tenant-roles";
import { RESERVED_TENANT_KEYS } from "../../../src/tenants/tenant-key";
import { insertAccount, insertTenant, insertTenantDomain, testId } from "../../builders/platform-rows";
import { insertMember, insertMembership, insertOta, type InsertedOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

const TENANT_PATH = "/v1/tenants/{tenantId}";
const MINUTE = 60;
const FAMILY = testId("asn", 1);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.7";

/**
 * A test-only route under a tenant path with a step-up and a switch on top of its roles, to show the guard order of
 * architecture §3: TenantRoleGuard (step 6) before RecentMfaGuard (7) and FeatureGuard (8). It binds `listDomains`,
 * whose parameters it has, on a path of its own, so it never meets the real route of PBE-027.
 */
@Controller("v1/tenants/:tenantId/test-guard-order")
class GuardOrderTestController {
  @Get()
  @HttpCode(200)
  @OpenApiOperation("listDomains")
  @TenantRoles("owner")
  @RequireRecentMfa()
  @Feature("custom_domains")
  reach(): { reached: true } {
    return { reached: true };
  }
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let subscriber: Redis;

/** The people of the main OTA: one per role, a stranger, a removed and a suspended member, and an unverified one. */
const people: Record<string, string> = {};
let ota: InsertedOta;

/** The invalidation events of this file's tenants, in the order they arrived, with the tenant's version then. */
interface Delivery {
  readonly event: InvalidationEvent;
  version?: number | undefined;
}
const received: Delivery[] = [];
const watched = new Set<string>();

/** Every token this file signed, to check that none reaches a log line. */
const signed: string[] = [];

async function account(overrides: Parameters<typeof insertAccount>[1] = {}): Promise<string> {
  return (await insertAccount(pool, overrides)).id;
}

beforeAll(async () => {
  t = await createTestApp({ controllers: [GuardOrderTestController] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  // The reference fixture of @velexis/testing has no time zones: the zones the profile updates use, as the loader
  // writes them (tools/reference-data). Asia/Kolkata stays out on purpose.
  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ('Europe/London', 'GB', 0, 60), ('Europe/Kyiv', NULL, 120, 180)",
  );

  for (const role of ["owner", "admin", "agent", "finance", "viewer"] as const) {
    people[role] = await account(role === "owner" ? { mfa_enabled: true } : {});
  }
  people["stranger"] = await account();
  people["removed"] = await account();
  people["suspended"] = await account();
  people["unverified"] = await account({ status: "pending_verification", email_verified_at: null });
  ota = await insertOta(pool, {
    tenant: { name: "Acme Travel", schema_version: "20261001090000_baseline", country_code: "FR" },
    subscription: {},
    members: (["owner", "admin", "agent", "finance", "viewer"] as const).map((role) => [
      { id: people[role] ?? "" },
      role,
    ]),
  });
  await insertMembership(
    pool,
    ota.tenant,
    { id: people["removed"] ?? "" },
    { role: "owner", status: "removed" },
  );
  await insertMembership(
    pool,
    ota.tenant,
    { id: people["suspended"] ?? "" },
    { role: "owner", status: "suspended" },
  );
  watched.add(ota.tenant.id);

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (event.type === "tenant" && watched.has(event.id)) {
      const delivery: Delivery = { event };
      received.push(delivery);
      void pool.query("SELECT version FROM platform.tenants WHERE id = $1", [event.id]).then(({ rows }) => {
        delivery.version = (rows[0] as { version: number } | undefined)?.version;
      });
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, 60_000);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
});

/** `Authorization: Bearer` with a fresh portal token of the application's TokenService, at the FakeClock's time. */
async function bearer(who: string, input: Partial<AccessTokenInput> = {}): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: people[who] ?? who,
    sid: FAMILY,
    ev: who !== "unverified",
    amr: ["pwd"],
    ...input,
  });
  signed.push(token);
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** The error code of an envelope answer, with the request id in the body and the header. */
function errorOf(res: { body: unknown; headers: Record<string, string> }): string {
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return error.code;
}

const tenantUrl = (id: string = ota.tenant.id): string => `/v1/tenants/${id}`;
const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

describe("checkTenantKey", () => {
  // Each test checks as an account of its own: the 30 checks per account and minute hold across the tests.
  const check = async (key: string, who: string) =>
    t.http
      .get("/v1/tenants/key-availability")
      .query({ key })
      .set(await bearer(who));

  it("[PBE-017 AC1] answers invalid for ab, 1abc and a_bc, reserved for admin, and taken for a failed tenant's key", async () => {
    await insertTenant(pool, { key: "failedota", status: "failed" });
    const typist = await account();
    const answers = [];
    for (const key of ["ab", "1abc", "a_bc", "admin", "failedota"]) {
      const res = await check(key, typist);
      expect(res.status, key).toBe(200);
      expectResponseToMatch("checkTenantKey", res, { document: "platform" });
      answers.push(res.body as unknown);
    }

    expect(answers).toEqual([
      { key: "ab", available: false, reason: "invalid", storefrontHost: "ab.ota.example.com" },
      { key: "1abc", available: false, reason: "invalid", storefrontHost: "1abc.ota.example.com" },
      { key: "a_bc", available: false, reason: "invalid", storefrontHost: "a_bc.ota.example.com" },
      { key: "admin", available: false, reason: "reserved", storefrontHost: "admin.ota.example.com" },
      { key: "failedota", available: false, reason: "taken", storefrontHost: "failedota.ota.example.com" },
    ]);
  });

  it("answers available with the storefront host for a free key, and taken for a key of a tenant in any status", async () => {
    for (const status of ["provisioning", "suspended", "deleted"]) {
      await insertTenant(pool, { key: `held${status}`, status });
    }
    const typist = await account();

    const free = await check("freshkey", typist);
    expect(free.body).toEqual({
      key: "freshkey",
      available: true,
      storefrontHost: "freshkey.ota.example.com",
    });
    expectResponseToMatch("checkTenantKey", free, { document: "platform" });
    for (const key of [ota.tenant.key, "heldprovisioning", "heldsuspended", "helddeleted"]) {
      expect((await check(key, typist)).body, key).toMatchObject({ available: false, reason: "taken" });
    }
    // A second account: the reserved names alone are almost as many checks as one account may make in a minute.
    const secondTypist = await account();
    for (const key of RESERVED_TENANT_KEYS) {
      expect((await check(key, secondTypist)).body, key).toMatchObject({
        available: false,
        reason: "reserved",
      });
    }
  });

  it("needs a verified account, and a key of 1 to 64 characters", async () => {
    const typist = await account();
    const unverified = await check("freshkey", "unverified");
    const tooLong = await check("a".repeat(65), typist);
    const missing = await t.http.get("/v1/tenants/key-availability").set(await bearer(typist));

    expect([unverified.status, errorOf(unverified)]).toEqual([403, "EMAIL_NOT_VERIFIED"]);
    expect([tooLong.status, errorOf(tooLong)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(tooLong.body).toMatchObject({
      error: { fieldErrors: [{ path: "/query/key", code: "maxLength" }] },
    });
    expect([missing.status, errorOf(missing)]).toEqual([400, "VALIDATION_FAILED"]);
    for (const res of [unverified, tooLong, missing]) {
      expectResponseToMatch("checkTenantKey", res, { document: "platform" });
    }
  });

  it("counts 30 checks per account per minute: the 31st answers 429 RATE_LIMITED with Retry-After", async () => {
    const typist = await account();
    const statuses: number[] = [];
    for (let n = 0; n < 30; n += 1) {
      statuses.push((await check(`acme${n}`, typist)).status);
    }
    const limited = await check("acme30", typist);
    const someoneElse = await check("acme30", await account());

    expect(statuses).toEqual(Array.from({ length: 30 }, () => 200));
    expect([limited.status, errorOf(limited)]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(MINUTE);
    expectResponseToMatch("checkTenantKey", limited, { document: "platform" });
    expect(someoneElse.status).toBe(200);
  });
});

describe("listTenants", () => {
  it("lists the OTAs of the caller's active memberships, oldest first, with the role and the storefront URL", async () => {
    const lister = await account();
    const first = await insertOta(pool, { tenant: { created_at: new Date("2026-01-01T09:00:00Z") } });
    const second = await insertTenant(pool, {
      created_at: new Date("2026-01-02T09:00:00Z"),
      status: "provisioning",
      activated_at: null,
    });
    await insertTenantDomain(pool, second, {
      hostname: "travel.acme.example",
      kind: "custom",
      verification_token: "velexis-verify-test-token",
      is_primary: true,
    });
    const removed = await insertOta(pool, { tenant: { created_at: new Date("2026-01-03T09:00:00Z") } });
    const deleted = await insertOta(pool, {
      tenant: { created_at: new Date("2026-01-04T09:00:00Z"), status: "deleted" },
    });
    await insertMember(pool, second, { id: lister }, "finance");
    await insertMember(pool, first.tenant, { id: lister }, "owner");
    await insertMembership(pool, removed.tenant, { id: lister }, { role: "admin", status: "removed" });
    await insertMember(pool, deleted.tenant, { id: lister }, "owner");

    const res = await t.http.get("/v1/tenants").set(await bearer(lister));

    expect(res.status).toBe(200);
    expectResponseToMatch("listTenants", res, { document: "platform" });
    expect(res.body).toEqual({
      data: [
        {
          id: first.tenant.id,
          key: first.tenant.key,
          name: first.tenant.name,
          status: "active",
          role: "owner",
          planCode: "early_access",
          storefrontUrl: `https://${first.tenant.key}.ota.example.com/`,
          storefrontEnvironment: "test",
        },
        {
          id: second.id,
          key: second.key,
          name: second.name,
          status: "provisioning",
          role: "finance",
          planCode: "early_access",
          storefrontUrl: "https://travel.acme.example/",
          storefrontEnvironment: "test",
        },
      ],
    });
  });

  it("works before the e-mail is verified, and answers an empty list to an account without OTAs", async () => {
    const unverified = await t.http.get("/v1/tenants").set(await bearer("unverified"));
    const none = await t.http.get("/v1/tenants").set(await bearer("stranger"));
    const anonymous = await t.http.get("/v1/tenants");

    expect([unverified.status, unverified.body]).toEqual([200, { data: [] }]);
    expect([none.status, none.body]).toEqual([200, { data: [] }]);
    expect([anonymous.status, errorOf(anonymous)]).toEqual([401, "UNAUTHENTICATED"]);
    for (const res of [unverified, none, anonymous]) {
      expectResponseToMatch("listTenants", res, { document: "platform" });
    }
  });
});

describe("getTenant", () => {
  it("shows the OTA to every role with myRole, the primary host, the schema version and the version as ETag", async () => {
    for (const role of ["owner", "admin", "agent", "finance", "viewer"] as const) {
      const res = await t.http.get(tenantUrl()).set(await bearer(role));

      expect(res.status, role).toBe(200);
      expectResponseToMatch("getTenant", res, { document: "platform" });
      expect(res.headers["etag"]).toBe(`"${(res.body as { version: number }).version}"`);
      expect(res.body).toMatchObject({
        id: ota.tenant.id,
        key: ota.tenant.key,
        name: "Acme Travel",
        status: "active",
        suspensionReason: null,
        billingNotice: null,
        planCode: "early_access",
        defaultCurrency: "EUR",
        countryCode: "FR",
        timeZone: "UTC",
        storefrontEnvironment: "test",
        liveEnabledAt: null,
        primaryHost: `${ota.tenant.key}.ota.example.com`,
        schemaVersion: "20261001090000_baseline",
        createdAt: ota.tenant.created_at.toISOString(),
        activatedAt: "2026-10-01T09:05:00.000Z",
        myRole: role,
      });
    }
  });

  it("shows a suspended OTA with its reason and billing notice to its members", async () => {
    const { tenant } = await insertOta(pool, {
      tenant: {
        status: "suspended",
        suspended_at: new Date("2026-10-10T00:00:00Z"),
        suspension_reason: "billing",
        billing_notice: "past_due",
      },
      members: [[{ id: people["viewer"] ?? "" }, "viewer"]],
    });

    const res = await t.http.get(tenantUrl(tenant.id)).set(await bearer("viewer"));

    expect(res.status).toBe(200);
    expectResponseToMatch("getTenant", res, { document: "platform" });
    expect(res.body).toMatchObject({
      status: "suspended",
      suspensionReason: "billing",
      billingNotice: "past_due",
    });
  });

  it("[PBE-017 AC4] answers 404 NOT_FOUND to a stranger, a removed or suspended member, and for unknown, malformed or deleted OTAs", async () => {
    const { tenant: deleted } = await insertOta(pool, {
      tenant: { status: "deleted", deleted_at: new Date("2026-10-10T00:00:00Z") },
      members: [[{ id: people["owner"] ?? "" }, "owner"]],
    });
    const calls: Array<[string, string]> = [
      ["stranger", tenantUrl()],
      ["removed", tenantUrl()],
      ["suspended", tenantUrl()],
      ["owner", tenantUrl(testId("ten", 99_999))],
      ["owner", tenantUrl(deleted.id)],
      ["owner", "/v1/tenants/not-a-tenant-id"],
    ];

    for (const [who, url] of calls) {
      const res = await t.http.get(url).set(await bearer(who));
      expect([res.status, errorOf(res)], `${who} ${url}`).toEqual([404, "NOT_FOUND"]);
      expectResponseToMatch("getTenant", res, { document: "platform" });
    }
  });
});

describe("updateTenant", () => {
  const patch = async (who: string, version: number | undefined, body: unknown, id = ota.tenant.id) => {
    const request = t.http.patch(tenantUrl(id)).set(await bearer(who));
    if (version !== undefined) {
      request.set("If-Match", `"${version}"`);
    }
    return request.send(body as object);
  };
  const currentVersion = async (id: string = ota.tenant.id): Promise<number> => {
    const { rows } = await pool.query("SELECT version FROM platform.tenants WHERE id = $1", [id]);
    return (rows[0] as { version: number }).version;
  };

  it("[PBE-017 AC2] lets owners and admins edit the profile with If-Match; each change answers the new version as ETag", async () => {
    const start = await currentVersion();

    const byOwner = await patch("owner", start, { name: "Acme Travel Group", legalName: "Acme Travel SAS" });
    const byAdmin = await patch("admin", start + 1, {
      supportEmail: "support@acme-travel.example.com",
      countryCode: "GB",
      timeZone: "Europe/London",
    });
    const clearing = await patch("owner", start + 2, { legalName: null, supportEmail: null });

    for (const res of [byOwner, byAdmin, clearing]) {
      expect(res.status).toBe(200);
      expectResponseToMatch("updateTenant", res, { document: "platform" });
    }
    expect(byOwner.headers["etag"]).toBe(`"${start + 1}"`);
    expect(byOwner.body).toMatchObject({
      name: "Acme Travel Group",
      legalName: "Acme Travel SAS",
      version: start + 1,
      myRole: "owner",
    });
    expect(byAdmin.headers["etag"]).toBe(`"${start + 2}"`);
    expect(byAdmin.body).toMatchObject({
      supportEmail: "support@acme-travel.example.com",
      countryCode: "GB",
      timeZone: "Europe/London",
      myRole: "admin",
    });
    expect(clearing.body).toMatchObject({ legalName: null, supportEmail: null, version: start + 3 });
    const fetched = await t.http.get(tenantUrl()).set(await bearer("viewer"));
    expect(fetched.headers["etag"]).toBe(`"${start + 3}"`);
    expect(fetched.body).toMatchObject({ name: "Acme Travel Group", countryCode: "GB", key: ota.tenant.key });
  });

  it("[PBE-017 AC2] refuses the key and the default currency: they are not in the schema", async () => {
    const version = await currentVersion();

    const key = await patch("owner", version, { key: "otherkey" });
    const currency = await patch("owner", version, { defaultCurrency: "USD", name: "Renamed" });

    for (const res of [key, currency]) {
      expect([res.status, errorOf(res)]).toEqual([400, "VALIDATION_FAILED"]);
      expectResponseToMatch("updateTenant", res, { document: "platform" });
    }
    expect(key.body).toMatchObject({
      error: { fieldErrors: [{ path: "/key", code: "additionalProperties" }] },
    });
    expect(currency.body).toMatchObject({
      error: { fieldErrors: [{ path: "/defaultCurrency", code: "additionalProperties" }] },
    });
    const { rows } = await pool.query(
      "SELECT key, default_currency, name, version FROM platform.tenants WHERE id = $1",
      [ota.tenant.id],
    );
    expect(rows[0]).toEqual({
      key: ota.tenant.key,
      default_currency: "EUR",
      name: expect.any(String),
      version,
    });
    expect((rows[0] as { name: string }).name).not.toBe("Renamed");
  });

  it("[PBE-017 AC2] answers 412 PRECONDITION_FAILED to a stale If-Match and 400 without one, changing nothing", async () => {
    const version = await currentVersion();

    const stale = await patch("owner", version - 1, { name: "Stale" });
    const missing = await patch("owner", undefined, { name: "Missing" });

    expect([stale.status, errorOf(stale)]).toEqual([412, "PRECONDITION_FAILED"]);
    expect([missing.status, errorOf(missing)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(missing.body).toMatchObject({ error: { fieldErrors: [{ path: "/header/If-Match" }] } });
    expectResponseToMatch("updateTenant", stale, { document: "platform" });
    expectResponseToMatch("updateTenant", missing, { document: "platform" });
    expect(await currentVersion()).toBe(version);
  });

  it("answers 403 FORBIDDEN to agents, finance members and viewers, and 404 to non-members", async () => {
    const version = await currentVersion();

    for (const who of ["agent", "finance", "viewer"]) {
      const res = await patch(who, version, { name: "Not allowed" });
      expect([res.status, errorOf(res)], who).toEqual([403, "FORBIDDEN"]);
      expectResponseToMatch("updateTenant", res, { document: "platform" });
    }
    const stranger = await patch("stranger", version, { name: "Not allowed" });
    expect([stranger.status, errorOf(stranger)]).toEqual([404, "NOT_FOUND"]);
    expect(await currentVersion()).toBe(version);
  });

  it("answers 409 TENANT_NOT_ACTIVE with details.status unless the OTA is active", async () => {
    for (const status of ["provisioning", "suspended", "failed"]) {
      const { tenant } = await insertOta(pool, {
        tenant: { status, activated_at: null },
        members: [[{ id: people["owner"] ?? "" }, "owner"]],
      });

      const res = await patch("owner", tenant.version, { name: "Renamed" }, tenant.id);

      expect([res.status, errorOf(res)], status).toEqual([409, "TENANT_NOT_ACTIVE"]);
      expect(res.body).toMatchObject({ error: { details: { status } } });
      expectResponseToMatch("updateTenant", res, { document: "platform" });
    }
  });

  it("refuses a country of no reference data and an unknown time zone without echoing them", async () => {
    const version = await currentVersion();

    const res = await patch("owner", version, { countryCode: "QQ", timeZone: "Mars/Olympus_Mons" });

    expect([res.status, errorOf(res)]).toEqual([400, "VALIDATION_FAILED"]);
    expectResponseToMatch("updateTenant", res, { document: "platform" });
    expect(res.body).toMatchObject({
      error: {
        fieldErrors: [
          { path: "/timeZone", code: "unknown" },
          { path: "/countryCode", code: "unknown" },
        ],
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("QQ");
    expect(JSON.stringify(res.body)).not.toContain("Olympus");
    expect(await currentVersion()).toBe(version);
  });

  it("checks the time zone against reference.time_zones and stores it as sent, never as another alias", async () => {
    const version = await currentVersion();

    const kyiv = await patch("owner", version, { timeZone: "Europe/Kyiv" });
    // A real IANA zone (Node.js knows it) that this database's reference data does not hold.
    const kolkata = await patch("owner", version + 1, { timeZone: "Asia/Kolkata" });

    expect(kyiv.status).toBe(200);
    expectResponseToMatch("updateTenant", kyiv, { document: "platform" });
    expect(kyiv.body).toMatchObject({ timeZone: "Europe/Kyiv", version: version + 1 });
    expect([kolkata.status, errorOf(kolkata)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(kolkata.body).toMatchObject({
      error: { fieldErrors: [{ path: "/timeZone", code: "unknown" }] },
    });
    expectResponseToMatch("updateTenant", kolkata, { document: "platform" });
    const { rows } = await pool.query("SELECT time_zone, version FROM platform.tenants WHERE id = $1", [
      ota.tenant.id,
    ]);
    expect(rows[0]).toEqual({ time_zone: "Europe/Kyiv", version: version + 1 });
  });

  it("writes one tenant.updated audit row with the fields that changed, before and after", async () => {
    const { tenant } = await insertOta(pool, {
      tenant: { name: "Audited Travel", legal_name: "Audited AS" },
      members: [[{ id: people["admin"] ?? "" }, "admin"]],
    });

    const res = await patch(
      "admin",
      tenant.version,
      { name: "Audited Travel Group", legalName: "Audited AS" },
      tenant.id,
    );

    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      "SELECT actor_type, actor_account_id, target_type, target_id, tenant_id, tenant_key, request_id, ip_address, details " +
        "FROM platform.platform_audit_log WHERE action = 'tenant.updated' AND target_id = $1",
      [tenant.id],
    );
    expect(rows).toEqual([
      {
        actor_type: "account",
        actor_account_id: people["admin"],
        target_type: "tenant",
        target_id: tenant.id,
        tenant_id: tenant.id,
        tenant_key: tenant.key,
        request_id: res.headers["x-request-id"],
        ip_address: PERSON_IP,
        details: { before: { name: "Audited Travel" }, after: { name: "Audited Travel Group" } },
      },
    ]);
  });

  it("[PBE-017 AC4] publishes a tenant invalidation after the commit of an update, and none for a refused or empty one", async () => {
    const { tenant } = await insertOta(pool, {
      tenant: { name: "Cached Travel" },
      members: [[{ id: people["owner"] ?? "" }, "owner"]],
    });
    watched.add(tenant.id);
    const events = () => received.filter(({ event }) => event.type === "tenant" && event.id === tenant.id);

    const stale = await patch("owner", tenant.version + 1, { name: "Stale" }, tenant.id);
    const unchanged = await patch("owner", tenant.version, { name: "Cached Travel" }, tenant.id);
    const changed = await patch("owner", tenant.version, { name: "Cached Travel Group" }, tenant.id);

    expect(stale.status).toBe(412);
    expect(unchanged.status).toBe(200);
    expect(unchanged.headers["etag"]).toBe(`"${tenant.version}"`);
    expect(changed.status).toBe(200);
    await vi.waitFor(() => expect(events()[0]?.version).toBeDefined(), { timeout: 10_000, interval: 20 });
    // Events of one publisher arrive in order: the refused and the empty update published nothing before this one.
    expect(events().map(({ event, version }) => ({ event, version }))).toEqual([
      { event: { v: 1, type: "tenant", id: tenant.id }, version: tenant.version + 1 },
    ]);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM platform.platform_audit_log WHERE action = 'tenant.updated' AND target_id = $1",
      [tenant.id],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });
});

describe("TenantRoleGuard", () => {
  /** A value for each path parameter of the tenant operations; the guard decides before anything reads them. */
  const PATH_VALUES: Readonly<Record<string, string>> = {
    memberId: testId("stf", 99_999),
    invitationId: testId("ivt", 99_999),
    keyId: testId("key", 99_999),
    environment: "test",
  };
  const tenantOperations = platformOperations.filter(
    ({ path }) => path === TENANT_PATH || path.startsWith(`${TENANT_PATH}/`),
  );

  /** The handlers of the API (not the test controller) bound to tenant operations, with their @TenantRoles. */
  function boundTenantHandlers(): Map<string, unknown> {
    const scanner = t.app.get(MetadataScanner);
    const bound = new Map<string, unknown>();
    for (const wrapper of t.app.get(DiscoveryService).getControllers()) {
      const prototype = wrapper.metatype?.prototype as Record<string, unknown> | undefined;
      if (prototype === undefined || wrapper.metatype === GuardOrderTestController) {
        continue;
      }
      for (const name of scanner.getAllMethodNames(prototype)) {
        const operationId = boundOperationId(prototype[name]);
        if (tenantOperations.some((operation) => operation.operationId === operationId)) {
          bound.set(operationId ?? "", Reflect.getMetadata(TENANT_ROLES_METADATA, prototype[name] as object));
        }
      }
    }
    return bound;
  }

  it("[PBE-017 AC4] protects every bound route under /v1/tenants/{tenantId} with the roles of the matrix", () => {
    const bound = boundTenantHandlers();

    expect([...bound.keys()]).toEqual(
      expect.arrayContaining(["getSubscription", "getTenant", "updateTenant"]),
    );
    for (const [operationId, roles] of bound) {
      expect(roles, operationId).toEqual(
        TENANT_OPERATION_ROLES[operationId as keyof typeof TENANT_OPERATION_ROLES],
      );
    }
  });

  it("[PBE-017 AC4] answers 404 NOT_FOUND to a non-member on every route under /v1/tenants/{tenantId}", async () => {
    expect(tenantOperations.length).toBeGreaterThan(20);
    for (const { operationId, method, path } of tenantOperations) {
      const url = path.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) =>
        name === "tenantId" ? ota.tenant.id : (PATH_VALUES[name] ?? name),
      );
      for (const who of ["stranger", "removed"]) {
        const res = await t.http[method as "get" | "post" | "patch" | "put" | "delete"](url)
          .set(await bearer(who))
          .set("If-Match", '"1"')
          .set("Idempotency-Key", "0f8f4c1e-3a8b-4d5e-9f1a-2b3c4d5e6f70");
        expect([res.status, errorOf(res)], `${who} ${method.toUpperCase()} ${url}`).toEqual([
          404,
          "NOT_FOUND",
        ]);
        expectResponseToMatch(operationId as PlatformOperationId, res, { document: "platform" });
      }
    }
  });

  it("runs after the authentication and before the step-up and the switches (architecture §3)", async () => {
    const url = `${tenantUrl()}/test-guard-order`;
    const mfaAgo = (seconds: number): Partial<AccessTokenInput> => ({
      amr: ["pwd", "otp"],
      mfa_at: nowSeconds() - seconds,
    });

    const anonymous = await t.http.get(url);
    const stranger = await t.http.get(url).set(await bearer("stranger", mfaAgo(20 * MINUTE)));
    const viewer = await t.http.get(url).set(await bearer("viewer", mfaAgo(20 * MINUTE)));
    const ownerStale = await t.http.get(url).set(await bearer("owner", mfaAgo(20 * MINUTE)));
    const ownerFresh = await t.http.get(url).set(await bearer("owner", mfaAgo(MINUTE)));

    expect([anonymous.status, errorOf(anonymous)]).toEqual([401, "UNAUTHENTICATED"]);
    expect([stranger.status, errorOf(stranger)]).toEqual([404, "NOT_FOUND"]);
    expect([viewer.status, errorOf(viewer)]).toEqual([403, "FORBIDDEN"]);
    expect([ownerStale.status, errorOf(ownerStale)]).toEqual([401, "REAUTH_REQUIRED"]);
    expect([ownerFresh.status, errorOf(ownerFresh)]).toEqual([403, "FEATURE_DISABLED"]);
  });

  it("reads the membership on every request: a removal acts at once", async () => {
    const leaving = await account();
    const membership = await insertMember(pool, ota.tenant, { id: leaving }, "admin");
    const headers = await bearer(leaving);

    const before = await t.http.get(tenantUrl()).set(headers);
    await pool.query("UPDATE platform.tenant_memberships SET status = 'removed' WHERE id = $1", [
      membership.id,
    ]);
    const after = await t.http.get(tenantUrl()).set(headers);

    expect(before.status).toBe(200);
    expect([after.status, errorOf(after)]).toEqual([404, "NOT_FOUND"]);
  });
});

describe("logging", () => {
  it("never writes a token into a log line", () => {
    const logged = JSON.stringify(t.logs.lines);

    expect(signed.length).toBeGreaterThan(0);
    for (const token of signed) {
      expect(logged).not.toContain(token.split(".")[2]);
    }
  });
});
