// The one-time console token of the OTA admin's single sign-on (PBE-039; PADR-0007, flows/team-and-ota-admin-sso.md
// §C, PADR-0008, scope PF-22) through the HTTP pipeline (createTestApp) on this file's database clone and Redis
// database: the token stored as `ptk:<sha256>` for 60 seconds with `NX`, its value for the OTA backend, the audit row
// without it, `no-store`; the refusals (a suspended or otherwise inactive OTA with its status, a live OTA and an
// account without MFA, a closed account, a non-member); the limit of 30 per account per minute; `503` while Redis
// refuses the write; and the token in no log line, no idempotency record and no other Redis key or value. Accounts and
// OTAs are written with the builders; access tokens come from the application's TokenService; every answer is checked
// against the platform document.
import { sha256Hex } from "@velexis/crypto";
import { expectResponseToMatch } from "@velexis/testing";
import type { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { RATE_LIMITS } from "../../../src/common/http/throttler.config";
import { REDIS_CLIENT } from "../../../src/common/redis/redis.module";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import { insertAccount, testId, type AccountRow } from "../../builders/platform-rows";
import { insertMember, insertOta, type OtaOptions } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

const FAMILY = testId("asn", 1);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.39";
/** The OTA admin of the test applications (PUBLIC_OTA_ADMIN_URL of TEST_MAIL_ENV) with the hand-off route. */
const SSO_URL = "http://localhost:3002/sso";
/** The platform document's `PortalToken`. */
const PORTAL_TOKEN = /^ptk_[0-9A-Za-z]{43}$/;
/** An Idempotency-Key of the document's shape, sent although the operation is not idempotent. */
const IDEMPOTENCY_KEY = "console-token-idem-0001";

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
/** The application's own Redis client, whose `set` a test may watch or make fail. */
let appRedis: Redis;

beforeAll(async () => {
  // Every line at every level is captured, so "no log line holds the token" covers the debug and trace lines too.
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  appRedis = t.app.get<Redis>(REDIS_CLIENT);
  // The database clone and the Nest module graph (Ajv compilation of the document included) are the expensive part,
  // and CI runs every package at once on 4 CPUs.
}, 60_000);

afterAll(async () => {
  await t?.close();
});

/** `Authorization: Bearer` with a fresh portal token of `accountId`, at the FakeClock's time. */
async function bearer(
  accountId: string,
  input: Partial<AccessTokenInput> = {},
): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
    ...input,
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** A new account (active, verified, without MFA unless `overrides` say otherwise). */
async function account(overrides: Partial<AccountRow> = {}): Promise<string> {
  return (await insertAccount(pool, overrides)).id;
}

/** A new OTA (active and in test mode unless `tenant` says otherwise) with `accountId` as a member of `role`. */
async function otaWith(
  accountId: string,
  role: TenantRole = "agent",
  tenant: OtaOptions["tenant"] = {},
): Promise<{ tenantId: string; membershipId: string }> {
  const { tenant: row, memberships } = await insertOta(pool, {
    tenant,
    members: [[{ id: accountId }, role]],
  });
  const [membership] = memberships;
  if (membership === undefined) {
    throw new Error("insertOta wrote no membership");
  }
  return { tenantId: row.id, membershipId: membership.id };
}

/** POST createConsoleToken, checked against the platform document. */
async function createToken(tenantId: string, headers: Record<string, string>): Promise<Response> {
  const res = await t.http.post(`/v1/tenants/${tenantId}/console-token`).set(headers);
  expectResponseToMatch("createConsoleToken", res, { document: "platform" });
  return res;
}

/** The error code of an envelope answer, with the request id in the body and the header. */
function errorOf(res: Response): { code: string; details?: unknown } {
  const { error } = res.body as { error: { code: string; requestId: string; details?: unknown } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return error.details === undefined ? { code: error.code } : { code: error.code, details: error.details };
}

/** The `console.token_issued` rows of a membership. */
async function tokenAudits(membershipId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT action, actor_type, actor_account_id, target_type, target_id, tenant_id, request_id, details " +
      "FROM platform.platform_audit_log WHERE target_id = $1 AND action = 'console.token_issued' ORDER BY id",
    [membershipId],
  );
  return rows as Array<Record<string, unknown>>;
}

/** Every key of this file's Redis database with its value as text (strings, hashes, lists, sets, sorted sets). */
async function redisContents(): Promise<Map<string, string>> {
  const client = t.redis.client;
  const contents = new Map<string, string>();
  let cursor = "0";
  do {
    const [next, keys] = await client.scan(cursor, "COUNT", 500);
    cursor = next;
    for (const key of keys) {
      const type = await client.type(key);
      const value =
        type === "string"
          ? await client.get(key)
          : type === "hash"
            ? await client.hgetall(key)
            : type === "list"
              ? await client.lrange(key, 0, -1)
              : type === "set"
                ? await client.smembers(key)
                : type === "zset"
                  ? await client.zrange(key, 0, -1)
                  : type;
      contents.set(key, JSON.stringify(value));
    }
  } while (cursor !== "0");
  return contents;
}

/** The `ptk:` keys of this file's Redis database. */
async function portalTokenKeys(): Promise<string[]> {
  return [...(await redisContents()).keys()].filter((key) => key.startsWith("ptk:")).sort();
}

/** The one-time token and the rest of a 201 answer. */
interface ConsoleTokenBody {
  readonly portalToken: string;
  readonly expiresAt: string;
  readonly consoleSsoUrl: string;
}

describe("createConsoleToken", () => {
  it("[PBE-039 AC1] gives an active member a token stored as ptk:<sha256> for 60 seconds with NX, audited without the token", async () => {
    const accountId = await account();
    const { tenantId, membershipId } = await otaWith(accountId, "agent");
    const setSpy = vi.spyOn(appRedis, "set");

    const res = await createToken(tenantId, await bearer(accountId));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as ConsoleTokenBody;
    expect(body).toEqual({
      portalToken: expect.stringMatching(PORTAL_TOKEN) as string,
      expiresAt: new Date(t.clock.now().getTime() + 60_000).toISOString(),
      consoleSsoUrl: SSO_URL,
    });

    // One SET of the token's digest, with a 60-second expiry and only if absent.
    const key = `ptk:${sha256Hex(body.portalToken)}`;
    const tokenWrites = setSpy.mock.calls.filter(([name]) => String(name).startsWith("ptk:"));
    expect(tokenWrites).toEqual([[key, expect.any(String), "EX", 60, "NX"]]);
    const ttl = await t.redis.client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    const stored = await t.redis.client.get(key);
    expect(JSON.parse(stored ?? "null")).toEqual({
      v: 1,
      accountId,
      tenantId,
      membershipId,
      role: "agent",
      mfa: false,
      issuedAt: t.clock.now().toISOString(),
      requestId: res.headers["x-request-id"],
    });

    const audits = await tokenAudits(membershipId);
    expect(audits).toEqual([
      {
        action: "console.token_issued",
        actor_type: "account",
        actor_account_id: accountId,
        target_type: "membership",
        target_id: membershipId,
        tenant_id: tenantId,
        request_id: res.headers["x-request-id"],
        details: { role: "agent", mfa: false, expiresAt: body.expiresAt },
      },
    ]);
    for (const secret of [body.portalToken, body.portalToken.slice(4), sha256Hex(body.portalToken)]) {
      expect(JSON.stringify(audits)).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
  });

  it("[PBE-039 AC1] gives a token to a member of every role, each redeemable once by its own digest", async () => {
    const { tenant } = await insertOta(pool);
    const issued = new Set<string>();
    for (const role of TENANT_ROLES) {
      const accountId = await account({ mfa_enabled: role === "owner" });
      const membership = await insertMember(pool, tenant, { id: accountId }, role);

      const res = await createToken(tenant.id, await bearer(accountId));

      expect(res.status, `${role}: ${JSON.stringify(res.body)}`).toBe(201);
      const { portalToken } = res.body as ConsoleTokenBody;
      issued.add(portalToken);
      // The OTA backend takes the key with GETDEL: a second take finds nothing.
      const key = `ptk:${sha256Hex(portalToken)}`;
      const taken = JSON.parse((await t.redis.client.getdel(key)) ?? "null") as Record<string, unknown>;
      expect(taken).toMatchObject({ membershipId: membership.id, role, mfa: role === "owner" });
      expect(await t.redis.client.getdel(key)).toBeNull();
    }
    expect(issued.size).toBe(TENANT_ROLES.length);
  });

  it("[PBE-039 AC2] answers TENANT_NOT_ACTIVE with the status (and the reason of a suspension), writing nothing", async () => {
    const cases = [
      [
        { status: "suspended", suspension_reason: "billing", suspended_at: new Date("2026-10-20T08:00:00Z") },
        { status: "suspended", suspensionReason: "billing" },
      ],
      [
        { status: "suspended", suspension_reason: "abuse", suspended_at: new Date("2026-10-20T08:00:00Z") },
        { status: "suspended", suspensionReason: "abuse" },
      ],
      [{ status: "provisioning", activated_at: null }, { status: "provisioning" }],
      [{ status: "failed", activated_at: null }, { status: "failed" }],
    ] as const;
    const keysBefore = await portalTokenKeys();
    for (const [tenant, details] of cases) {
      const accountId = await account({ mfa_enabled: true });
      const { tenantId, membershipId } = await otaWith(accountId, "owner", tenant);

      const res = await createToken(tenantId, await bearer(accountId));

      expect(res.status, tenant.status).toBe(409);
      expect(errorOf(res)).toEqual({ code: "TENANT_NOT_ACTIVE", details });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(await tokenAudits(membershipId)).toEqual([]);
    }
    expect(await portalTokenKeys()).toEqual(keysBefore);
  });

  it("[PBE-039 AC2] refuses a live OTA to an account without MFA (MFA_REQUIRED) and admits one with MFA", async () => {
    const live = { storefront_environment: "live", live_enabled_at: new Date("2026-10-10T09:00:00Z") };
    const withoutMfa = await account({ mfa_enabled: false });
    const withMfa = await account({ mfa_enabled: true });
    const { tenant, memberships } = await insertOta(pool, {
      tenant: live,
      members: [
        [{ id: withoutMfa }, "admin"],
        [{ id: withMfa }, "viewer"],
      ],
    });
    const keysBefore = await portalTokenKeys();

    const refused = await createToken(tenant.id, await bearer(withoutMfa));

    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toEqual({ code: "MFA_REQUIRED" });
    expect(await tokenAudits(memberships[0]?.id ?? "")).toEqual([]);
    expect(await portalTokenKeys()).toEqual(keysBefore);

    // A recent TOTP code is not needed: the live-OTA rule asks for MFA enabled, not for a step-up.
    const admitted = await createToken(tenant.id, await bearer(withMfa));

    expect(admitted.status, JSON.stringify(admitted.body)).toBe(201);
    const { portalToken } = admitted.body as ConsoleTokenBody;
    const stored = JSON.parse(
      (await t.redis.client.get(`ptk:${sha256Hex(portalToken)}`)) ?? "null",
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({ role: "viewer", mfa: true });
    // A test-only OTA admits the same account without MFA.
    const { tenantId } = await otaWith(withoutMfa, "admin");
    expect((await createToken(tenantId, await bearer(withoutMfa))).status).toBe(201);
  });

  it("[PBE-039 AC3] keeps the token out of every log line, the idempotency store and every other Redis key", async () => {
    const accountId = await account();
    const { tenantId } = await otaWith(accountId, "finance");
    const issued: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await createToken(tenantId, {
        ...(await bearer(accountId)),
        "Idempotency-Key": IDEMPOTENCY_KEY,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      issued.push((res.body as ConsoleTokenBody).portalToken);
    }

    // The same Idempotency-Key answered three different tokens: nothing was stored for a replay.
    expect(new Set(issued).size).toBe(3);
    const contents = await redisContents();
    expect([...contents.keys()].filter((key) => key.startsWith("vx:idem:"))).toEqual([]);
    for (const token of issued) {
      for (const secret of [token, token.slice(4)]) {
        for (const [key, value] of contents) {
          expect(key, key).not.toContain(secret);
          expect(value, key).not.toContain(secret);
        }
        expect(JSON.stringify(t.logs.lines)).not.toContain(secret);
      }
      // Only the digest names the key, and its value holds the grant, not the token.
      expect(contents.has(`ptk:${sha256Hex(token)}`)).toBe(true);
    }
    expect(t.logs.lines.length).toBeGreaterThan(0);
  });

  it("answers 503 SERVICE_UNAVAILABLE while Redis refuses the token, with no audit row and no key", async () => {
    const accountId = await account();
    const { tenantId, membershipId } = await otaWith(accountId);
    const keysBefore = await portalTokenKeys();
    const failing = vi
      .spyOn(appRedis as unknown as { set: (...args: unknown[]) => Promise<unknown> }, "set")
      .mockRejectedValueOnce(Object.assign(new Error("Connection is closed."), { name: "Error" }));

    const res = await createToken(tenantId, await bearer(accountId));

    expect(failing).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toEqual({ code: "SERVICE_UNAVAILABLE" });
    expect(await tokenAudits(membershipId)).toEqual([]);
    expect(await portalTokenKeys()).toEqual(keysBefore);
  });

  it("refuses a closed account (401), an unverified token (403) and a non-member (404) without a token", async () => {
    const disabled = await account();
    const { tenantId, membershipId } = await otaWith(disabled);
    await pool.query("UPDATE platform.accounts SET status = 'disabled' WHERE id = $1", [disabled]);
    const member = await account();
    const { tenantId: otherTenant } = await otaWith(member);
    const stranger = await account();
    const keysBefore = await portalTokenKeys();

    const closed = await createToken(tenantId, await bearer(disabled));
    const unverified = await createToken(otherTenant, await bearer(member, { ev: false }));
    const foreign = await createToken(otherTenant, await bearer(stranger));

    expect([closed.status, errorOf(closed)]).toEqual([401, { code: "UNAUTHENTICATED" }]);
    expect([unverified.status, errorOf(unverified)]).toEqual([403, { code: "EMAIL_NOT_VERIFIED" }]);
    expect([foreign.status, errorOf(foreign)]).toEqual([404, { code: "NOT_FOUND" }]);
    expect(await tokenAudits(membershipId)).toEqual([]);
    expect(await portalTokenKeys()).toEqual(keysBefore);
  });

  it("re-reads the account: a token that still says ev: true gets nothing for a locked or no longer verified account", async () => {
    // PortalAuthGuard reads only the token's claims, so these refusals come from the service's fresh read.
    const locked = await account({ status: "locked" });
    const { tenantId: lockedTenant, membershipId: lockedMembership } = await otaWith(locked);
    const unverified = await account({ status: "pending_verification", email_verified_at: null });
    const { tenantId: unverifiedTenant, membershipId: unverifiedMembership } = await otaWith(unverified);
    const keysBefore = await portalTokenKeys();

    const lockedRes = await createToken(lockedTenant, await bearer(locked));
    const unverifiedRes = await createToken(unverifiedTenant, await bearer(unverified));

    expect([lockedRes.status, errorOf(lockedRes)]).toEqual([401, { code: "UNAUTHENTICATED" }]);
    expect([unverifiedRes.status, errorOf(unverifiedRes)]).toEqual([403, { code: "EMAIL_NOT_VERIFIED" }]);
    expect(unverifiedRes.headers["cache-control"]).toBe("no-store");
    expect(await tokenAudits(lockedMembership)).toEqual([]);
    expect(await tokenAudits(unverifiedMembership)).toEqual([]);
    expect(await portalTokenKeys()).toEqual(keysBefore);
  });

  it("allows 30 tokens per account per minute, then answers 429 RATE_LIMITED with Retry-After", async () => {
    const accountId = await account();
    const { tenantId, membershipId } = await otaWith(accountId);
    const headers = await bearer(accountId);
    const { limit } = RATE_LIMITS.consoleToken;
    expect(limit).toBe(30);

    for (let i = 0; i < limit; i += 1) {
      const res = await t.http.post(`/v1/tenants/${tenantId}/console-token`).set(headers);
      expect(res.status, `request ${i + 1}`).toBe(201);
    }
    const limited = await createToken(tenantId, headers);

    expect(limited.status).toBe(429);
    expect(errorOf(limited)).toEqual({ code: "RATE_LIMITED" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(await tokenAudits(membershipId)).toHaveLength(limit);
  });
});
