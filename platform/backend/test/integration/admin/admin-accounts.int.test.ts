// Account support and platform admins in the platform admin (PBE-032; scope PF-86 and PF-87, PADR-0006 "Access",
// platform/docs/api-inventory-admin.md §7, flows/platform-admin-operations.md §H) through the HTTP pipeline
// (createTestApp) on this file's database clone and Redis database: the account search and detail, disable, enable,
// unlock and the MFA reset (reasons, the step-up, sessions revoked, the OTA cut-off `staffdeny:acct:<id>`, the
// `account` invalidation, the `auth.mfa_changed` e-mail), the admins list, grant and revoke (verified accounts with MFA
// only, never oneself or the last admin), and exactly one audit row with `actor_type = 'platform_admin'` for every
// change. Every JSON answer is checked against the platform document.
//
// Admin tokens come from the application's TokenService for accounts written with the builders (the admin sign-in has
// its own tests, admin-auth.int.test.ts); a token carries a step-up (`mfa_at` = now) unless a test says otherwise.
// TOTP secrets are placeholder bytes: nothing here decrypts one. The "last admin" refusals need a caller who is no
// longer an admin by the time the change runs (the guard lets only active admins in), so those tests hold the
// caller's row locked in a transaction of their own, wait until the request waits for that lock, and then revoke the
// caller's rights and commit, as a concurrent revocation would. Sign-ins (Argon2id) run in the setup hooks, each group
// from an end-user IP of its own (RFC 5737), so the per-IP sign-in limit of one group never touches another.
import { generateToken, sha256Hex } from "@velexis/crypto";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { Redis } from "ioredis";
import type { Response, Test } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MFA_CHANGES } from "../../../src/accounts/mfa.service";
import { PasswordPolicy } from "../../../src/auth/password-policy";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { redisKeys } from "../../../src/common/redis/redis-keys";
import { TEST_PASSWORD } from "../../builders/accounts";
import {
  insertAccount,
  insertRow,
  insertTenant,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  testId,
  type AccountRow,
  type PlatformRow,
} from "../../builders/platform-rows";
import { createTestApp, type TestApp } from "../../support/app";

/** Starting the API on a database clone and parsing the platform document take seconds; bounded for a loaded runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's setup: a few sign-ins (Argon2id verifications) and admin calls; seconds at most, bounded for CI. */
const GROUP_SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for an invalidation event or for a request to wait for a lock. */
const WAIT_MS = 10_000;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ADMIN_IP = "203.0.113.20";
const REASON = "Identity confirmed on a video call with the passport (SUP-431).";

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let passwordHash: string;
let subscriber: Redis;
/** The caller of most tests: an active platform admin with MFA. */
let admin: PlatformRow<"accounts">;
/** The account invalidations received, by account id. */
const invalidated: string[] = [];
let rowCounter = 0;

let ipCounter = 0;
/** A documentation IP (RFC 5737) of its own for each group of sign-ins, so their rate limits never meet. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${100 + ipCounter}`;
}

beforeAll(async () => {
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  passwordHash = await t.app.get(PasswordPolicy).hash(TEST_PASSWORD);
  admin = await insertAdmin({ full_name: "Lena Holm", email: "lena.holm@velexis.example.com" });
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in the first test.
  responseChecker("platform");
  subscriber = new Redis(t.redis.url, { lazyConnect: true, connectionName: "platform-admin-accounts-test" });
  subscriber.on("message", (channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (channel === INVALIDATION_CHANNEL && event.type === "account") {
      invalidated.push(event.accountId);
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
}, SETUP_TIMEOUT_MS);

// The "last admin" tests take the rights of every other admin, the file's admin included (onlyAdmins); give them back
// after every test, so a failing test never makes the tests after it fail as well.
afterEach(async () => {
  await pool.query("UPDATE platform.accounts SET is_platform_admin = true WHERE id = $1", [admin.id]);
});

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);
const ago = (ms: number): Date => new Date(t.clock.now().getTime() - ms);
const ahead = (ms: number): Date => new Date(t.clock.now().getTime() + ms);

/** An active platform admin with MFA on (a placeholder secret: nothing here decrypts it). */
function insertAdmin(overrides: Partial<AccountRow> = {}): Promise<PlatformRow<"accounts">> {
  return insertAccount(pool, {
    is_platform_admin: true,
    password_hash: passwordHash,
    ...withMfa(),
    ...overrides,
  });
}

/** The MFA columns of an account with MFA on. */
function withMfa(): Partial<AccountRow> {
  return {
    mfa_enabled: true,
    mfa_enabled_at: ago(30 * DAY_MS),
    mfa_secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
    encryption_key_id: PLACEHOLDER_KEK_ID,
  };
}

/** A portal account that signs in with TEST_PASSWORD (active and verified unless `overrides` say otherwise). */
function insertPerson(overrides: Partial<AccountRow> = {}): Promise<PlatformRow<"accounts">> {
  return insertAccount(pool, { password_hash: passwordHash, ...overrides });
}

/** The headers of an admin call of `sub` (default: the admin), with a step-up now unless `stepUp` is false. */
async function adminHeaders(
  options: { readonly sub?: string; readonly stepUp?: boolean } = {},
): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: options.sub ?? admin.id,
    sid: testId("asn", 1),
    ev: true,
    amr: ["pwd", "otp"],
    ...(options.stepUp === false ? {} : { mfa_at: nowSeconds() }),
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

type Method = "get" | "post" | "delete";

/** An admin call; `headers` default to the admin's with a step-up. */
async function call(
  method: Method,
  path: string,
  options: { readonly body?: object; readonly headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = options.headers ?? (await adminHeaders());
  const request: Test = t.http[method](path).set(headers);
  return options.body === undefined ? request : request.send(options.body);
}

/** `<status>` of a success, or `<status> <code>` of an error answer whose request id is the header's. */
function outcomeOf(res: Response): string {
  if (res.status < 300) {
    return String(res.status);
  }
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return `${res.status} ${error.code}`;
}

function errorOf(res: Response): { code: string; details?: Record<string, unknown>; fieldErrors?: unknown } {
  return (res.body as { error: { code: string; details?: Record<string, unknown>; fieldErrors?: unknown } })
    .error;
}

/** The highest audit row id so far: rows written later have higher ids. */
async function auditMark(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT coalesce(max(id), 0)::text AS id FROM platform.platform_audit_log",
  );
  return rows[0]?.id ?? "0";
}

interface AuditRowRead {
  readonly id: string;
  readonly actor_type: string;
  readonly actor_account_id: string | null;
  readonly action: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly request_id: string | null;
  readonly ip_address: string | null;
  readonly details: Record<string, unknown>;
}

/** The audit rows written after `mark`, oldest first. */
async function auditRowsSince(mark: string): Promise<AuditRowRead[]> {
  const { rows } = await pool.query<AuditRowRead>(
    "SELECT id::text AS id, actor_type, actor_account_id, action, target_type, target_id, request_id, " +
      "host(ip_address) AS ip_address, details FROM platform.platform_audit_log WHERE id > $1 ORDER BY id",
    [mark],
  );
  return rows;
}

async function accountRow(id: string): Promise<PlatformRow<"accounts">> {
  const { rows } = await pool.query("SELECT * FROM platform.accounts WHERE id = $1", [id]);
  return rows[0] as PlatformRow<"accounts">;
}

/** A refresh family of `accountId` (its first row only), active unless `revokedAt` or a past `endsAt` say otherwise. */
async function insertFamily(
  accountId: string,
  values: {
    readonly audience: "portal" | "platform_admin";
    readonly endsAt?: Date;
    readonly revokedAt?: Date;
  },
): Promise<string> {
  rowCounter += 1;
  const familyId = testId("asn", 5000 + rowCounter);
  const createdAt = ago(HOUR_MS);
  const endsAt = values.endsAt ?? ahead(values.audience === "portal" ? 7 * DAY_MS : HOUR_MS);
  await insertRow(pool, "account_sessions", {
    id: familyId,
    account_id: accountId,
    family_id: familyId,
    audience: values.audience,
    refresh_token_hash: generateToken("rt").hash,
    expires_at: endsAt,
    family_expires_at: endsAt,
    revoked_at: values.revokedAt ?? null,
    revoke_reason: values.revokedAt === undefined ? null : "logout",
    mfa_verified_at: values.audience === "platform_admin" ? createdAt : null,
    created_at: createdAt,
    updated_at: createdAt,
  });
  return familyId;
}

async function familiesOf(
  accountId: string,
): Promise<
  Array<{ family_id: string; audience: string; revoked_at: Date | null; revoke_reason: string | null }>
> {
  const { rows } = await pool.query<{
    family_id: string;
    audience: string;
    revoked_at: Date | null;
    revoke_reason: string | null;
  }>(
    "SELECT family_id, audience, revoked_at, revoke_reason FROM platform.account_sessions WHERE account_id = $1 " +
      "ORDER BY family_id",
    [accountId],
  );
  return rows;
}

/** Ten recovery codes of `accountId`, as their hashes only. */
async function insertRecoveryCodes(accountId: string): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await pool.query(
      "INSERT INTO platform.account_recovery_codes (account_id, code_hash, created_at) VALUES ($1, $2, $3)",
      [accountId, sha256Hex(`${accountId}-code-${index}`), t.clock.now()],
    );
  }
}

/** Waits for the `account` invalidation of `accountId`. */
async function expectInvalidation(accountId: string): Promise<void> {
  await vi.waitFor(() => expect(invalidated).toContain(accountId), { timeout: WAIT_MS, interval: 20 });
}

/** A portal sign-in with TEST_PASSWORD from `ip`: `200` (no MFA), `403 ACCOUNT_DISABLED`, `423 ACCOUNT_LOCKED`, … */
async function signIn(ip: string, email: string): Promise<Response> {
  return t.http.post("/v1/auth/sign-in").set(t.bffHeaders(ip)).send({ email, password: TEST_PASSWORD });
}

/**
 * Runs `request` while the caller's account row is locked by a transaction of this test, waits until the request
 * waits for that lock, then takes the caller's admin rights away and commits: the request goes on as if another admin
 * had revoked the caller at that moment (the guard has already let the caller in).
 */
async function withCallerRevokedMidRequest(callerId: string, request: () => Test): Promise<Response> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM platform.accounts WHERE id = $1 FOR UPDATE", [callerId]);
    const pending = Promise.resolve(request());
    await vi.waitFor(
      async () => {
        const { rows } = await pool.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity " +
            "WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        expect(rows[0]?.waiting ?? 0).toBeGreaterThan(0);
      },
      { timeout: WAIT_MS, interval: 20 },
    );
    await client.query(
      "UPDATE platform.accounts SET is_platform_admin = false, version = version + 1 WHERE id = $1",
      [callerId],
    );
    await client.query("COMMIT");
    return await pending;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Makes every active platform admin but `keep` a former admin, so `keep` are the only active admins. */
async function onlyAdmins(...keep: readonly string[]): Promise<void> {
  await pool.query(
    "UPDATE platform.accounts SET is_platform_admin = false WHERE is_platform_admin AND NOT (id = ANY($1))",
    [keep],
  );
}

describe("the admin scope", () => {
  it("refuses calls without an admin token and with a portal token", async () => {
    const person = await insertPerson();
    const { token: portalToken } = await tokens.sign({
      aud: "portal",
      sub: admin.id,
      sid: testId("asn", 2),
      ev: true,
      amr: ["pwd", "otp"],
      mfa_at: nowSeconds(),
    });
    const portal = { Authorization: `Bearer ${portalToken}`, ...t.bffHeaders(ADMIN_IP) };
    const none = t.bffHeaders(ADMIN_IP);

    const outcomes = [
      outcomeOf(await call("get", "/v1/admin/accounts", { headers: none })),
      outcomeOf(await call("get", `/v1/admin/accounts/${person.id}`, { headers: portal })),
      outcomeOf(
        await call("post", `/v1/admin/accounts/${person.id}/disable`, {
          headers: portal,
          body: { reason: REASON },
        }),
      ),
      outcomeOf(await call("get", "/v1/admin/admins", { headers: portal })),
      outcomeOf(await call("delete", `/v1/admin/admins/${admin.id}`, { headers: none })),
    ];

    expect(outcomes).toEqual(Array(5).fill("401 UNAUTHENTICATED"));
    expect((await accountRow(person.id)).status).toBe("active");
  });
});

describe("adminListAccounts", () => {
  const domain = "search-list.example.com";
  let anna: PlatformRow<"accounts">;
  let annika: PlatformRow<"accounts">;
  let bo: PlatformRow<"accounts">;
  let percent: PlatformRow<"accounts">;

  beforeAll(async () => {
    anna = await insertPerson({
      email: `anna.berg@${domain}`,
      full_name: "Anna Berg",
      created_at: ago(4 * DAY_MS),
    });
    annika = await insertPerson({
      email: `a.sol@${domain}`,
      full_name: "Annika Sol",
      status: "disabled",
      created_at: ago(3 * DAY_MS),
    });
    bo = await insertPerson({
      email: `bo.lind@${domain}`,
      full_name: "Bo Lind",
      created_at: ago(2 * DAY_MS),
    });
    // The only account whose address or name holds a `%`, an `_` or a `\`.
    percent = await insertPerson({
      email: `percent@${domain}`,
      full_name: "Agent 100%_off\\desk",
      created_at: ago(DAY_MS),
    });
  });

  it("finds accounts by part of the address or the name, ignoring letter case, newest first", async () => {
    const res = await call("get", `/v1/admin/accounts?q=ANN&limit=10`);

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminListAccounts", res, { document: "platform" });
    const { data } = res.body as { data: Array<Record<string, unknown>> };
    expect(data.map((row) => row["id"])).toEqual([annika.id, anna.id]);
    expect(data[1]).toEqual({
      id: anna.id,
      email: anna.email,
      fullName: "Anna Berg",
      status: "active",
      mfaEnabled: false,
      isPlatformAdmin: false,
      lastLoginAt: null,
      createdAt: anna.created_at.toISOString(),
    });

    const byDomain = await call(
      "get",
      `/v1/admin/accounts?q=${encodeURIComponent(`@${domain.toUpperCase()}`)}`,
    );
    expect((byDomain.body as { data: Array<{ id: string }> }).data.map((row) => row.id)).toEqual([
      percent.id,
      bo.id,
      annika.id,
      anna.id,
    ]);
  });

  it("matches %, _ and \\ in the search literally", async () => {
    const found = async (q: string): Promise<string[]> => {
      const res = await call("get", `/v1/admin/accounts?q=${encodeURIComponent(q)}`);
      expect(outcomeOf(res)).toBe("200");
      return (res.body as { data: Array<{ id: string }> }).data.map((row) => row.id);
    };

    // As LIKE wildcards, `%` and `_` would match every account; unescaped, `\` would escape the closing `%` and
    // match only names that end with a `%`.
    expect([await found("%"), await found("_"), await found("0%_"), await found("\\")]).toEqual([
      [percent.id],
      [percent.id],
      [percent.id],
      [percent.id],
    ]);
  });

  it("filters by status", async () => {
    const res = await call("get", `/v1/admin/accounts?q=${encodeURIComponent(domain)}&status=disabled`);

    expect(outcomeOf(res)).toBe("200");
    expect((res.body as { data: Array<{ id: string; status: string }> }).data).toEqual([
      expect.objectContaining({ id: annika.id, status: "disabled" }),
    ]);
  });

  it("pages with an opaque cursor and refuses a cursor that is not one of the list", async () => {
    const q = encodeURIComponent(domain);
    const first = await call("get", `/v1/admin/accounts?q=${q}&limit=3`);
    const firstBody = first.body as {
      data: Array<{ id: string }>;
      page: { nextCursor: string | null; limit: number };
    };
    expect(firstBody.data.map((row) => row.id)).toEqual([percent.id, bo.id, annika.id]);
    expect(firstBody.page.limit).toBe(3);
    expect(firstBody.page.nextCursor).toEqual(expect.any(String));

    const second = await call(
      "get",
      `/v1/admin/accounts?q=${q}&limit=3&cursor=${encodeURIComponent(firstBody.page.nextCursor ?? "")}`,
    );
    expectResponseToMatch("adminListAccounts", second, { document: "platform" });
    expect(second.body).toEqual({
      data: [expect.objectContaining({ id: anna.id })],
      page: { nextCursor: null, limit: 3 },
    });

    const unknown = Buffer.from(JSON.stringify({ id: testId("acc", 999_999) })).toString("base64url");
    for (const cursor of ["not-a-cursor", unknown]) {
      const res = await call("get", `/v1/admin/accounts?cursor=${cursor}`);
      expect(outcomeOf(res)).toBe("400 VALIDATION_FAILED");
      expect(errorOf(res).fieldErrors).toEqual([
        expect.objectContaining({ path: "/query/cursor", code: "cursor" }),
      ]);
    }
  });
});

describe("adminGetAccount", () => {
  let person: PlatformRow<"accounts">;
  let tenant: PlatformRow<"tenants">;
  let membershipId: string;

  beforeAll(async () => {
    person = await insertPerson({ full_name: "Mikael Lind", last_login_at: ago(2 * HOUR_MS), ...withMfa() });
    tenant = await insertTenant(pool, { name: "Nordic Fares" });
    const other = await insertTenant(pool);
    membershipId = testId("stf", 7001);
    await insertRow(pool, "tenant_memberships", {
      id: membershipId,
      tenant_id: tenant.id,
      account_id: person.id,
      role: "owner",
      status: "active",
    });
    await insertRow(pool, "tenant_memberships", {
      id: testId("stf", 7002),
      tenant_id: other.id,
      account_id: person.id,
      role: "agent",
      status: "removed",
    });
    await insertFamily(person.id, { audience: "portal" });
    await insertFamily(person.id, { audience: "platform_admin" });
    await insertFamily(person.id, { audience: "portal", revokedAt: ago(MINUTE_MS) });
    await insertFamily(person.id, { audience: "portal", endsAt: ago(MINUTE_MS) });
    // 52 rows about the account, one by it, and one of someone else.
    for (let index = 0; index < 52; index += 1) {
      await pool.query(
        "INSERT INTO platform.platform_audit_log (actor_type, actor_account_id, actor_label, action, target_type, " +
          "target_id, details) VALUES ('platform_admin', $1, 'lena.holm@velexis.example.com', 'account.unlocked', " +
          "'account', $2, $3)",
        [admin.id, person.id, JSON.stringify({ n: index })],
      );
    }
    await pool.query(
      "INSERT INTO platform.platform_audit_log (actor_type, actor_account_id, action, target_type, target_id, " +
        "tenant_id, tenant_key, details) VALUES ('account', $1, 'invitation.created', 'invitation', $2, $3, $4, '{}')",
      [person.id, testId("ivt", 1), tenant.id, tenant.key],
    );
    await pool.query(
      "INSERT INTO platform.platform_audit_log (actor_type, actor_account_id, action, target_type, target_id, details) " +
        "VALUES ('account', $1, 'account.updated', 'account', $1, '{}')",
      [admin.id],
    );
  }, GROUP_SETUP_TIMEOUT_MS);

  it("answers the account, its active memberships, its active sessions and its last 50 audit rows", async () => {
    const res = await call("get", `/v1/admin/accounts/${person.id}`);

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminGetAccount", res, { document: "platform" });
    const body = res.body as {
      account: Record<string, unknown>;
      memberships: unknown[];
      activeSessions: number;
      recentAudit: Array<{ action: string; actorAccountId: string; targetId: string; details: unknown }>;
    };
    expect(body.account).toEqual({
      id: person.id,
      email: person.email,
      emailVerified: true,
      fullName: "Mikael Lind",
      locale: "en",
      timeZone: "UTC",
      status: "active",
      mfaEnabled: true,
      mfaEnabledAt: person.mfa_enabled_at?.toISOString(),
      isPlatformAdmin: false,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: person.last_login_at?.toISOString(),
      createdAt: person.created_at.toISOString(),
      version: 1,
    });
    expect(body.memberships).toEqual([
      {
        membershipId,
        tenantId: tenant.id,
        tenantKey: tenant.key,
        tenantName: "Nordic Fares",
        tenantStatus: "active",
        role: "owner",
      },
    ]);
    expect(body.activeSessions).toBe(2);
    expect(body.recentAudit).toHaveLength(50);
    // Newest first: the row the account acted in, then the rows about it, from the 52nd down.
    expect(body.recentAudit[0]).toEqual(
      expect.objectContaining({
        action: "invitation.created",
        actorAccountId: person.id,
        tenantKey: tenant.key,
      }),
    );
    expect(body.recentAudit[1]).toEqual(
      expect.objectContaining({ action: "account.unlocked", targetId: person.id, details: { n: 51 } }),
    );
    expect(body.recentAudit.at(-1)).toEqual(expect.objectContaining({ details: { n: 3 } }));
    expect(JSON.stringify(res.body)).not.toContain(PLACEHOLDER_CIPHERTEXT);
  });

  it("answers 404 for an unknown account and 400 for an id that is not an account id", async () => {
    expect(outcomeOf(await call("get", `/v1/admin/accounts/${testId("acc", 999_998)}`))).toBe(
      "404 NOT_FOUND",
    );
    const res = await call("get", "/v1/admin/accounts/ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F");
    expect(outcomeOf(res)).toBe("400 VALIDATION_FAILED");
    expect(errorOf(res).fieldErrors).toEqual([expect.objectContaining({ path: "/path/accountId" })]);
  });
});

describe("adminDisableAccount", () => {
  const ip = nextIp();
  let person: PlatformRow<"accounts">;
  let mark: string;
  let res: Response;
  let signInAfter: Response;

  beforeAll(async () => {
    person = await insertPerson({ full_name: "Mikael Lind" });
    await insertFamily(person.id, { audience: "portal" });
    await insertFamily(person.id, { audience: "portal" });
    mark = await auditMark();
    res = await call("post", `/v1/admin/accounts/${person.id}/disable`, { body: { reason: REASON } });
    signInAfter = await signIn(ip, person.email);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("requires a reason of 5 to 500 characters and changes nothing without one [PBE-032 AC3]", async () => {
    const other = await insertPerson();
    const before = await auditMark();
    for (const body of [{}, { reason: "abc " }, { reason: "x".repeat(501) }]) {
      const refused = await call("post", `/v1/admin/accounts/${other.id}/disable`, { body });
      expect(outcomeOf(refused)).toBe("400 VALIDATION_FAILED");
      expectResponseToMatch("adminDisableAccount", refused, { document: "platform" });
    }
    expect((await accountRow(other.id)).status).toBe("active");
    expect(await auditRowsSince(before)).toEqual([]);
    expect(await t.redis.client.get(redisKeys.staffDenyAccount(other.id).key)).toBeNull();
  });

  it("disables the account, revokes its sessions, cuts off its OTA staff sessions and publishes `account` [PBE-032 AC3]", async () => {
    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminDisableAccount", res, { document: "platform" });
    expect(res.body).toEqual(expect.objectContaining({ id: person.id, status: "disabled", version: 2 }));
    expect(await familiesOf(person.id)).toEqual([
      expect.objectContaining({ revoked_at: t.clock.now(), revoke_reason: "admin" }),
      expect.objectContaining({ revoked_at: t.clock.now(), revoke_reason: "admin" }),
    ]);
    expect(await t.redis.client.get(redisKeys.staffDenyAccount(person.id).key)).toBe(
      String(t.clock.now().getTime()),
    );
    await expectInvalidation(person.id);
    // The account's sign-in now answers ACCOUNT_DISABLED after the right password.
    expect(outcomeOf(signInAfter)).toBe("403 ACCOUNT_DISABLED");
  });

  it("writes one audit row account.disabled with the reason [PBE-032 AC3] [PBE-032 AC4]", async () => {
    const rows = (await auditRowsSince(mark)).filter((row) => row.action !== "auth.sign_in_failed");
    expect(rows).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        action: "account.disabled",
        target_type: "account",
        target_id: person.id,
        request_id: res.headers["x-request-id"],
        ip_address: ADMIN_IP,
        details: {
          reason: REASON,
          revokedFamilies: 2,
          staffDenyFrom: t.clock.now().toISOString(),
          before: { status: "active" },
          after: { status: "disabled" },
        },
      }),
    ]);
  });

  it("answers 409 not_enabled for a disabled or deleted account and 404 for an unknown one", async () => {
    const deleted = await insertPerson({ status: "deleted", deleted_at: ago(DAY_MS) });
    const before = await auditMark();
    for (const id of [person.id, deleted.id]) {
      const refused = await call("post", `/v1/admin/accounts/${id}/disable`, { body: { reason: REASON } });
      expect(outcomeOf(refused)).toBe("409 CONFLICT");
      expectResponseToMatch("adminDisableAccount", refused, { document: "platform" });
      expect(errorOf(refused).details).toEqual({ reason: "not_enabled" });
    }
    const unknown = await call("post", `/v1/admin/accounts/${testId("acc", 999_997)}/disable`, {
      body: { reason: REASON },
    });
    expect(outcomeOf(unknown)).toBe("404 NOT_FOUND");
    expect(await auditRowsSince(before)).toEqual([]);
  });

  it("never disables the caller's own account [PBE-032 AC2]", async () => {
    const before = await auditMark();
    const refused = await call("post", `/v1/admin/accounts/${admin.id}/disable`, {
      body: { reason: REASON },
    });

    expect(outcomeOf(refused)).toBe("403 FORBIDDEN");
    expectResponseToMatch("adminDisableAccount", refused, { document: "platform" });
    expect(errorOf(refused).details).toEqual({ reason: "self" });
    expect((await accountRow(admin.id)).status).toBe("active");
    expect(await auditRowsSince(before)).toEqual([]);
    expect(await t.redis.client.get(redisKeys.staffDenyAccount(admin.id).key)).toBeNull();
  });

  it("disables another platform admin, whose admin access ends at once", async () => {
    const other = await insertAdmin();
    const otherHeaders = await adminHeaders({ sub: other.id });
    expect(outcomeOf(await call("get", "/v1/admin/me", { headers: otherHeaders }))).toBe("200");

    const disabled = await call("post", `/v1/admin/accounts/${other.id}/disable`, {
      body: { reason: REASON },
    });

    expect(outcomeOf(disabled)).toBe("200");
    expect(outcomeOf(await call("get", "/v1/admin/me", { headers: otherHeaders }))).toBe(
      "401 UNAUTHENTICATED",
    );
  });

  it("never disables the last active platform admin, even when the caller loses the rights meanwhile [PBE-032 AC2]", async () => {
    const caller = await insertAdmin();
    const last = await insertAdmin();
    await onlyAdmins(caller.id, last.id);
    const headers = await adminHeaders({ sub: caller.id });
    const before = await auditMark();

    const refused = await withCallerRevokedMidRequest(caller.id, () =>
      t.http.post(`/v1/admin/accounts/${last.id}/disable`).set(headers).send({ reason: REASON }),
    );

    expect(outcomeOf(refused)).toBe("403 FORBIDDEN");
    expectResponseToMatch("adminDisableAccount", refused, { document: "platform" });
    expect(errorOf(refused).details).toEqual({ reason: "last_admin" });
    expect(await accountRow(last.id)).toEqual(
      expect.objectContaining({ status: "active", is_platform_admin: true }),
    );
    expect(await auditRowsSince(before)).toEqual([]);
  });
});

describe("adminEnableAccount", () => {
  const ip = nextIp();
  let verified: PlatformRow<"accounts">;
  let unverified: PlatformRow<"accounts">;
  let mark: string;
  let enabledVerified: Response;
  let enabledUnverified: Response;
  let signInAfter: Response;

  beforeAll(async () => {
    verified = await insertPerson({ status: "disabled" });
    unverified = await insertPerson({ status: "disabled", email_verified_at: null });
    mark = await auditMark();
    enabledVerified = await call("post", `/v1/admin/accounts/${verified.id}/enable`, {
      body: { reason: REASON },
    });
    enabledUnverified = await call("post", `/v1/admin/accounts/${unverified.id}/enable`, {
      body: { reason: REASON },
    });
    signInAfter = await signIn(ip, verified.email);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("takes a disabled account back to active, or to pending_verification without a verified address [PBE-032 AC3]", async () => {
    expect([outcomeOf(enabledVerified), outcomeOf(enabledUnverified)]).toEqual(["200", "200"]);
    expectResponseToMatch("adminEnableAccount", enabledVerified, { document: "platform" });
    expectResponseToMatch("adminEnableAccount", enabledUnverified, { document: "platform" });
    expect(enabledVerified.body).toEqual(expect.objectContaining({ status: "active", version: 2 }));
    expect(enabledUnverified.body).toEqual(
      expect.objectContaining({ status: "pending_verification", emailVerified: false, version: 2 }),
    );
    expect(outcomeOf(signInAfter)).toBe("200");
    await expectInvalidation(verified.id);
    await expectInvalidation(unverified.id);
  });

  it("writes one audit row account.enabled per account with the reason [PBE-032 AC3] [PBE-032 AC4]", async () => {
    const rows = (await auditRowsSince(mark)).filter((row) => row.action === "account.enabled");
    expect(rows).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        target_id: verified.id,
        details: { reason: REASON, before: { status: "disabled" }, after: { status: "active" } },
      }),
      expect.objectContaining({
        actor_type: "platform_admin",
        target_id: unverified.id,
        details: {
          reason: REASON,
          before: { status: "disabled" },
          after: { status: "pending_verification" },
        },
      }),
    ]);
    expect((await auditRowsSince(mark)).filter((row) => row.target_id === verified.id)).toHaveLength(1);
  });

  it("requires a reason and answers 409 not_disabled for an account that is not disabled [PBE-032 AC3]", async () => {
    const active = await insertPerson();
    const before = await auditMark();

    const noReason = await call("post", `/v1/admin/accounts/${active.id}/enable`, { body: {} });
    const notDisabled = await call("post", `/v1/admin/accounts/${active.id}/enable`, {
      body: { reason: REASON },
    });

    expect([outcomeOf(noReason), outcomeOf(notDisabled)]).toEqual(["400 VALIDATION_FAILED", "409 CONFLICT"]);
    expectResponseToMatch("adminEnableAccount", notDisabled, { document: "platform" });
    expect(errorOf(notDisabled).details).toEqual({ reason: "not_disabled" });
    expect(await auditRowsSince(before)).toEqual([]);
  });
});

describe("adminUnlockAccount", () => {
  const ip = nextIp();
  let locked: PlatformRow<"accounts">;
  let signInBefore: Response;
  let mark: string;
  let res: Response;
  let signInAfter: Response;

  beforeAll(async () => {
    locked = await insertPerson({ failed_login_count: 5, locked_until: ahead(10 * MINUTE_MS) });
    signInBefore = await signIn(ip, locked.email);
    mark = await auditMark();
    res = await call("post", `/v1/admin/accounts/${locked.id}/unlock`);
    signInAfter = await signIn(ip, locked.email);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("clears the lockout, so the next sign-in with the right password works [PBE-032 AC3]", () => {
    expect(outcomeOf(signInBefore)).toBe("423 ACCOUNT_LOCKED");
    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminUnlockAccount", res, { document: "platform" });
    expect(res.body).toEqual(
      expect.objectContaining({ id: locked.id, failedLoginCount: 0, lockedUntil: null, version: 1 }),
    );
    expect(outcomeOf(signInAfter)).toBe("200");
  });

  it("writes one audit row account.unlocked with the counters before [PBE-032 AC3] [PBE-032 AC4]", async () => {
    const rows = (await auditRowsSince(mark)).filter((row) => row.action === "account.unlocked");
    expect(rows).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        target_id: locked.id,
        details: {
          wasLocked: true,
          before: { failedLoginCount: 5, lockedUntil: ahead(10 * MINUTE_MS).toISOString() },
          after: { failedLoginCount: 0, lockedUntil: null },
        },
      }),
    ]);
  });

  it("answers an account that is not locked as it is, still with one audit row, and 404 for an unknown one", async () => {
    const free = await insertPerson();
    const before = await auditMark();

    const unlocked = await call("post", `/v1/admin/accounts/${free.id}/unlock`);
    const unknown = await call("post", `/v1/admin/accounts/${testId("acc", 999_996)}/unlock`);

    expect([outcomeOf(unlocked), outcomeOf(unknown)]).toEqual(["200", "404 NOT_FOUND"]);
    expect(unlocked.body).toEqual(
      expect.objectContaining({ status: "active", failedLoginCount: 0, lockedUntil: null }),
    );
    expect(await auditRowsSince(before)).toEqual([
      expect.objectContaining({
        action: "account.unlocked",
        target_id: free.id,
        details: expect.objectContaining({ wasLocked: false }),
      }),
    ]);
  });
});

describe("adminResetAccountMfa", () => {
  let person: PlatformRow<"accounts">;
  let mark: string;
  let res: Response;

  beforeAll(async () => {
    person = await insertPerson({ full_name: "Anna Berg", ...withMfa() });
    await insertRecoveryCodes(person.id);
    await insertFamily(person.id, { audience: "portal" });
    await insertFamily(person.id, { audience: "portal" });
    mark = await auditMark();
    res = await call("post", `/v1/admin/accounts/${person.id}/reset-mfa`, { body: { reason: REASON } });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("turns MFA off, deletes the recovery codes, revokes every session and cuts off the staff sessions [PBE-032 AC3]", async () => {
    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminResetAccountMfa", res, { document: "platform" });
    expect(res.body).toEqual(
      expect.objectContaining({ id: person.id, mfaEnabled: false, mfaEnabledAt: null, version: 2 }),
    );
    expect(await accountRow(person.id)).toEqual(
      expect.objectContaining({
        mfa_enabled: false,
        mfa_enabled_at: null,
        mfa_secret_ciphertext: null,
        encryption_key_id: null,
      }),
    );
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM platform.account_recovery_codes WHERE account_id = $1",
      [person.id],
    );
    expect(rows[0]?.n).toBe(0);
    expect((await familiesOf(person.id)).map((family) => family.revoke_reason)).toEqual(["admin", "admin"]);
    expect(await t.redis.client.get(redisKeys.staffDenyAccount(person.id).key)).toBe(
      String(t.clock.now().getTime()),
    );
    await expectInvalidation(person.id);
  });

  it("e-mails the account auth.mfa_changed [PBE-032 AC3]", async () => {
    const { rows } = await pool.query<{ template: string; to_email: string; data: unknown }>(
      "SELECT template, to_email, data FROM platform.email_outbox WHERE account_id = $1",
      [person.id],
    );
    expect(rows).toEqual([
      {
        template: "auth.mfa_changed",
        to_email: person.email,
        data: { fullName: "Anna Berg", change: MFA_CHANGES.disabled },
      },
    ]);
  });

  it("writes one audit row account.mfa_reset with the reason and no secret [PBE-032 AC3] [PBE-032 AC4]", async () => {
    const rows = await auditRowsSince(mark);
    expect(rows).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        action: "account.mfa_reset",
        target_type: "account",
        target_id: person.id,
        details: {
          reason: REASON,
          recoveryCodesRemoved: 10,
          revokedFamilies: 2,
          staffDenyFrom: t.clock.now().toISOString(),
          before: { mfaEnabled: true },
          after: { mfaEnabled: false },
        },
      }),
    ]);
  });

  it("needs a step-up within 15 minutes and a reason [PBE-032 AC3]", async () => {
    const other = await insertPerson(withMfa());
    const before = await auditMark();
    const stale = await adminHeaders({ stepUp: false });

    const noStepUp = await call("post", `/v1/admin/accounts/${other.id}/reset-mfa`, {
      headers: stale,
      body: { reason: REASON },
    });
    const noReason = await call("post", `/v1/admin/accounts/${other.id}/reset-mfa`, { body: {} });

    expect([outcomeOf(noStepUp), outcomeOf(noReason)]).toEqual([
      "401 REAUTH_REQUIRED",
      "400 VALIDATION_FAILED",
    ]);
    expectResponseToMatch("adminResetAccountMfa", noStepUp, { document: "platform" });
    expect((await accountRow(other.id)).mfa_enabled).toBe(true);
    expect(await auditRowsSince(before)).toEqual([]);
  });

  it("refuses a platform admin target (403 platform_admin) and an account without MFA (409 mfa_not_enabled)", async () => {
    const otherAdmin = await insertAdmin();
    const noMfa = await insertPerson();
    const before = await auditMark();

    const adminTarget = await call("post", `/v1/admin/accounts/${otherAdmin.id}/reset-mfa`, {
      body: { reason: REASON },
    });
    const withoutMfa = await call("post", `/v1/admin/accounts/${noMfa.id}/reset-mfa`, {
      body: { reason: REASON },
    });

    expect([outcomeOf(adminTarget), outcomeOf(withoutMfa)]).toEqual(["403 FORBIDDEN", "409 CONFLICT"]);
    expectResponseToMatch("adminResetAccountMfa", adminTarget, { document: "platform" });
    expectResponseToMatch("adminResetAccountMfa", withoutMfa, { document: "platform" });
    expect(errorOf(adminTarget).details).toEqual({ reason: "platform_admin" });
    expect(errorOf(withoutMfa).details).toEqual({ reason: "mfa_not_enabled" });
    expect((await accountRow(otherAdmin.id)).mfa_enabled).toBe(true);
    expect(await auditRowsSince(before)).toEqual([]);
    expect(await t.redis.client.get(redisKeys.staffDenyAccount(otherAdmin.id).key)).toBeNull();
  });
});

describe("adminListAdmins", () => {
  it("lists every platform admin by name, and no other account", async () => {
    const zoe = await insertAdmin({ full_name: "Zoe Admin", last_login_at: ago(HOUR_MS) });
    const person = await insertPerson({ full_name: "Aaron Person" });

    const res = await call("get", "/v1/admin/admins");

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminListAdmins", res, { document: "platform" });
    const { data } = res.body as { data: Array<{ accountId: string; fullName: string }> };
    const ids = data.map((row) => row.accountId);
    // By name: Lena Holm before Zoe Admin, whatever the database's collation does with the other names.
    expect(ids.indexOf(admin.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(admin.id)).toBeLessThan(ids.indexOf(zoe.id));
    expect(ids).not.toContain(person.id);
    expect(data.find((row) => row.accountId === zoe.id)).toEqual({
      accountId: zoe.id,
      email: zoe.email,
      fullName: "Zoe Admin",
      mfaEnabled: true,
      lastLoginAt: zoe.last_login_at?.toISOString(),
    });
    expect(data.find((row) => row.accountId === admin.id)).toEqual(
      expect.objectContaining({ fullName: "Lena Holm" }),
    );
  });
});

describe("adminGrantAdmin", () => {
  let candidate: PlatformRow<"accounts">;
  let mark: string;
  let res: Response;

  beforeAll(async () => {
    candidate = await insertPerson({
      email: "Jonas.Dahl@velexis.example.com",
      full_name: "Jonas Dahl",
      ...withMfa(),
    });
    mark = await auditMark();
    res = await call("post", "/v1/admin/admins", {
      body: { email: "jonas.dahl@VELEXIS.example.com", reason: REASON },
    });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("makes a verified, active account with MFA a platform admin [PBE-032 AC2]", async () => {
    expect(outcomeOf(res)).toBe("201");
    expectResponseToMatch("adminGrantAdmin", res, { document: "platform" });
    expect(res.body).toEqual({
      accountId: candidate.id,
      email: candidate.email,
      fullName: "Jonas Dahl",
      mfaEnabled: true,
      lastLoginAt: null,
    });
    expect(await accountRow(candidate.id)).toEqual(
      expect.objectContaining({ is_platform_admin: true, version: 2 }),
    );
    // The new admin's token passes the admin guard now.
    expect(
      outcomeOf(await call("get", "/v1/admin/me", { headers: await adminHeaders({ sub: candidate.id }) })),
    ).toBe("200");
  });

  it("writes one audit row admin.granted with the reason [PBE-032 AC2] [PBE-032 AC4]", async () => {
    expect(await auditRowsSince(mark)).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        action: "admin.granted",
        target_type: "account",
        target_id: candidate.id,
        details: { reason: REASON, before: { isPlatformAdmin: false }, after: { isPlatformAdmin: true } },
      }),
    ]);
  });

  it("needs an existing account with a verified address, active and with MFA [PBE-032 AC2]", async () => {
    const unverified = await insertPerson({
      ...withMfa(),
      status: "pending_verification",
      email_verified_at: null,
    });
    const disabled = await insertPerson({ ...withMfa(), status: "disabled" });
    const noMfa = await insertPerson();
    const before = await auditMark();

    const grant = (email: string): Promise<Response> =>
      call("post", "/v1/admin/admins", { body: { email, reason: REASON } });
    const answers = [
      await grant("nobody@velexis.example.com"),
      await grant(admin.email),
      await grant(unverified.email),
      await grant(disabled.email),
      await grant(noMfa.email),
    ];

    expect(answers.map(outcomeOf)).toEqual([
      "404 NOT_FOUND",
      "409 CONFLICT",
      "422 UNPROCESSABLE",
      "422 UNPROCESSABLE",
      "422 UNPROCESSABLE",
    ]);
    for (const answer of answers) {
      expectResponseToMatch("adminGrantAdmin", answer, { document: "platform" });
    }
    expect(answers.slice(1).map((answer) => errorOf(answer).details)).toEqual([
      { reason: "already_admin" },
      { reason: "email_not_verified" },
      { reason: "account_not_active" },
      { reason: "mfa_not_enabled" },
    ]);
    for (const account of [unverified, disabled, noMfa]) {
      expect((await accountRow(account.id)).is_platform_admin).toBe(false);
    }
    expect(await auditRowsSince(before)).toEqual([]);
  });

  it("needs a step-up and a reason", async () => {
    const other = await insertPerson(withMfa());
    const noStepUp = await call("post", "/v1/admin/admins", {
      headers: await adminHeaders({ stepUp: false }),
      body: { email: other.email, reason: REASON },
    });
    const noReason = await call("post", "/v1/admin/admins", { body: { email: other.email } });

    expect([outcomeOf(noStepUp), outcomeOf(noReason)]).toEqual([
      "401 REAUTH_REQUIRED",
      "400 VALIDATION_FAILED",
    ]);
    expect((await accountRow(other.id)).is_platform_admin).toBe(false);
  });
});

describe("adminRevokeAdmin", () => {
  let target: PlatformRow<"accounts">;
  let adminFamily: string;
  let portalFamily: string;
  let targetHeaders: Record<string, string>;
  let mark: string;
  let res: Response;

  beforeAll(async () => {
    target = await insertAdmin({ full_name: "Jo Former" });
    adminFamily = await insertFamily(target.id, { audience: "platform_admin" });
    portalFamily = await insertFamily(target.id, { audience: "portal" });
    targetHeaders = await adminHeaders({ sub: target.id });
    mark = await auditMark();
    res = await call("delete", `/v1/admin/admins/${target.id}?reason=${encodeURIComponent(REASON)}`);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("takes the rights away, revokes the admin sessions and keeps the portal ones [PBE-032 AC2]", async () => {
    expect(outcomeOf(res)).toBe("204");
    expectResponseToMatch("adminRevokeAdmin", res, { document: "platform" });
    expect(await accountRow(target.id)).toEqual(
      expect.objectContaining({ is_platform_admin: false, version: 2 }),
    );
    expect(await familiesOf(target.id)).toEqual(
      [
        {
          family_id: adminFamily,
          audience: "platform_admin",
          revoked_at: t.clock.now(),
          revoke_reason: "admin",
        },
        { family_id: portalFamily, audience: "portal", revoked_at: null, revoke_reason: null },
      ].sort((a, b) => (a.family_id < b.family_id ? -1 : 1)),
    );
    // AdminAuthGuard re-reads the flag: the former admin's token stops working at once.
    expect(outcomeOf(await call("get", "/v1/admin/me", { headers: targetHeaders }))).toBe(
      "401 UNAUTHENTICATED",
    );
  });

  it("writes one audit row admin.revoked with the optional reason [PBE-032 AC2] [PBE-032 AC4]", async () => {
    expect(await auditRowsSince(mark)).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin.id,
        action: "admin.revoked",
        target_type: "account",
        target_id: target.id,
        details: {
          reason: REASON,
          revokedFamilies: 1,
          before: { isPlatformAdmin: true },
          after: { isPlatformAdmin: false },
        },
      }),
    ]);

    const another = await insertAdmin();
    const before = await auditMark();
    expect(outcomeOf(await call("delete", `/v1/admin/admins/${another.id}`))).toBe("204");
    expect(await auditRowsSince(before)).toEqual([
      expect.objectContaining({
        action: "admin.revoked",
        target_id: another.id,
        details: { revokedFamilies: 0, before: { isPlatformAdmin: true }, after: { isPlatformAdmin: false } },
      }),
    ]);
  });

  it("never revokes the caller's own rights [PBE-032 AC2]", async () => {
    const before = await auditMark();
    const refused = await call("delete", `/v1/admin/admins/${admin.id}`);

    expect(outcomeOf(refused)).toBe("403 FORBIDDEN");
    expectResponseToMatch("adminRevokeAdmin", refused, { document: "platform" });
    expect(errorOf(refused).details).toEqual({ reason: "self" });
    expect((await accountRow(admin.id)).is_platform_admin).toBe(true);
    expect(await auditRowsSince(before)).toEqual([]);
  });

  it("never revokes the last active platform admin, even when the caller loses the rights meanwhile [PBE-032 AC2]", async () => {
    const caller = await insertAdmin();
    const last = await insertAdmin();
    await onlyAdmins(caller.id, last.id);
    const headers = await adminHeaders({ sub: caller.id });
    const before = await auditMark();

    const refused = await withCallerRevokedMidRequest(caller.id, () =>
      t.http.delete(`/v1/admin/admins/${last.id}`).set(headers),
    );

    expect(outcomeOf(refused)).toBe("403 FORBIDDEN");
    expectResponseToMatch("adminRevokeAdmin", refused, { document: "platform" });
    expect(errorOf(refused).details).toEqual({ reason: "last_admin" });
    expect((await accountRow(last.id)).is_platform_admin).toBe(true);
    expect(await auditRowsSince(before)).toEqual([]);
  });

  it("leaves one admin when the last two revoke each other at the same time [PBE-032 AC2]", async () => {
    const first = await insertAdmin();
    const second = await insertAdmin();
    await onlyAdmins(first.id, second.id);
    const firstHeaders = await adminHeaders({ sub: first.id });
    const secondHeaders = await adminHeaders({ sub: second.id });

    const answers = await Promise.all([
      t.http.delete(`/v1/admin/admins/${second.id}`).set(firstHeaders),
      t.http.delete(`/v1/admin/admins/${first.id}`).set(secondHeaders),
    ]);

    const outcomes = answers.map(outcomeOf).sort();
    expect(outcomes[0]).toBe("204");
    expect(["401 UNAUTHENTICATED", "403 FORBIDDEN"]).toContain(outcomes[1]);
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM platform.accounts WHERE is_platform_admin AND status = 'active' AND id = ANY($1)",
      [[first.id, second.id]],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("answers 404 for an account that is not a platform admin, and needs a step-up", async () => {
    const person = await insertPerson();
    const other = await insertAdmin();

    const notAdmin = await call("delete", `/v1/admin/admins/${person.id}`);
    const noStepUp = await call("delete", `/v1/admin/admins/${other.id}`, {
      headers: await adminHeaders({ stepUp: false }),
    });
    const shortReason = await call("delete", `/v1/admin/admins/${other.id}?reason=abc`);

    expect([outcomeOf(notAdmin), outcomeOf(noStepUp), outcomeOf(shortReason)]).toEqual([
      "404 NOT_FOUND",
      "401 REAUTH_REQUIRED",
      "400 VALIDATION_FAILED",
    ]);
    expect(errorOf(shortReason).fieldErrors).toEqual([expect.objectContaining({ path: "/query/reason" })]);
    expect((await accountRow(other.id)).is_platform_admin).toBe(true);
  });
});

describe("audit rows of the changes", () => {
  it("writes exactly one row with actor_type platform_admin for every state-changing operation [PBE-032 AC4]", async () => {
    const disableTarget = await insertPerson();
    const enableTarget = await insertPerson({ status: "disabled" });
    const unlockTarget = await insertPerson({ failed_login_count: 3 });
    const resetTarget = await insertPerson(withMfa());
    const grantTarget = await insertPerson(withMfa());
    const revokeTarget = await insertAdmin();
    const changes: Array<[string, () => Promise<Response>, string]> = [
      [
        "adminDisableAccount",
        () => call("post", `/v1/admin/accounts/${disableTarget.id}/disable`, { body: { reason: REASON } }),
        disableTarget.id,
      ],
      [
        "adminEnableAccount",
        () => call("post", `/v1/admin/accounts/${enableTarget.id}/enable`, { body: { reason: REASON } }),
        enableTarget.id,
      ],
      [
        "adminUnlockAccount",
        () => call("post", `/v1/admin/accounts/${unlockTarget.id}/unlock`),
        unlockTarget.id,
      ],
      [
        "adminResetAccountMfa",
        () => call("post", `/v1/admin/accounts/${resetTarget.id}/reset-mfa`, { body: { reason: REASON } }),
        resetTarget.id,
      ],
      [
        "adminGrantAdmin",
        () => call("post", "/v1/admin/admins", { body: { email: grantTarget.email, reason: REASON } }),
        grantTarget.id,
      ],
      ["adminRevokeAdmin", () => call("delete", `/v1/admin/admins/${revokeTarget.id}`), revokeTarget.id],
    ];

    const written: Array<[string, number, string[], string[]]> = [];
    for (const [operationId, change] of changes) {
      const before = await auditMark();
      const res = await change();
      expect(res.status).toBeLessThan(300);
      const rows = await auditRowsSince(before);
      written.push([
        operationId,
        rows.length,
        rows.map((row) => `${row.actor_type} ${row.actor_account_id ?? ""}`),
        rows.map((row) => row.target_id ?? ""),
      ]);
    }

    expect(written).toEqual(
      changes.map(([operationId, , targetId]) => [
        operationId,
        1,
        [`platform_admin ${admin.id}`],
        [targetId],
      ]),
    );
  });
});
