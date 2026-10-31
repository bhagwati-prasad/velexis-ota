// The signed-in account's routes under `/v1/me` (PBE-016; platform/docs/scope.md PF-06 AC1 and PF-07 AC1,
// api-inventory §5, PADR-0008 item 2, PADR-0015 item 3) through the HTTP pipeline (createTestApp) on this file's
// database clone and Redis database: getMe with the memberships and the six milestone switches, also for an
// unverified account; updateMe with `If-Match` and `ETag`; changePassword, which keeps the caller's session and ends
// every other one, with the OTA cut-off `staffdeny:acct:<id>`; listSessions with the current family; and revokeSession,
// after which the revoked family's refresh token fails. Every answer is checked against the platform document, and no
// log line holds a token or a password.
//
// Sessions start with real sign-ins (Argon2id) in the setup hooks, with explicit bounds; admin families, which PBE-028
// writes, and revoked or expired families are inserted as rows. Tokens of accounts that never sign in come from the
// application's TokenService. Each group calls from an end-user IP of its own (RFC 5737), so the per-IP sign-in limit
// of one group never touches another. Two switches are on (FEATURE_CUSTOM_DOMAINS, FEATURE_SETTLEMENTS), so getMe
// shows each of the six as configured, not a default.
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { generateToken } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PasswordPolicy } from "../../../src/auth/password-policy";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { redisKeys, STAFF_DENY_ACCOUNT_TTL_SECONDS } from "../../../src/common/redis/redis-keys";
import { insertUnverifiedAccount, TEST_PASSWORD } from "../../builders/accounts";
import { insertAccount, insertRow, testId, type PlatformRow } from "../../builders/platform-rows";
import { insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone and parsing the platform document take about two seconds alone; the bound
 * allows for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's setup: a few sign-ins and Argon2id hashes; seconds at most, bounded for CI. */
const GROUP_SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the invalidation event of a commit. */
const WAIT_MS = 10_000;

/** A new password that meets the rules; a test value, never a real password. */
const NEW_PASSWORD = "Silver-Fjord-Morning-7";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15";
const OTHER_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/131.0";

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let subscriber: Redis;
/** The Argon2id hash of TEST_PASSWORD, made once and shared by the accounts of this file. */
let passwordHash: string;
/** The `account` invalidations this file's accounts received. */
const invalidated: InvalidationEvent[] = [];
const accountsOfThisFile = new Set<string>();

/** Every password and token this file used or received, for the log scan. */
const secrets = new Set<string>([TEST_PASSWORD, NEW_PASSWORD]);

let ipCounter = 0;
/** A documentation IP (RFC 5737) of its own for each group of calls, so their rate limits never meet. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${200 + ipCounter}`;
}

let counter = 0;
/** A new account (active and verified unless `overrides` say otherwise) that signs in with TEST_PASSWORD. */
async function newAccount(
  overrides: Parameters<typeof insertAccount>[1] = {},
): Promise<PlatformRow<"accounts">> {
  counter += 1;
  const account = await insertAccount(pool, {
    email: `me-${counter}-${Date.now()}@example.com`,
    password_hash: passwordHash,
    ...overrides,
  });
  accountsOfThisFile.add(account.id);
  return account;
}

/** The tokens of a PortalSession answer, as far as the tests read them. */
interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
}

function remember(res: Response): Response {
  const body = res.body as Record<string, unknown>;
  for (const field of ["accessToken", "refreshToken"]) {
    if (typeof body[field] === "string") {
      secrets.add(body[field]);
    }
  }
  return res;
}

async function signIn(email: string, password: string, ip: string, userAgent?: string): Promise<Response> {
  secrets.add(password);
  return remember(
    await t.http.post("/v1/auth/sign-in").set(t.bffHeaders(ip, userAgent)).send({ email, password }),
  );
}

/** Signs `account` in with TEST_PASSWORD and returns the session. */
async function sessionOf(
  account: Pick<PlatformRow<"accounts">, "email">,
  ip: string,
  userAgent?: string,
): Promise<Session> {
  const res = await signIn(account.email, TEST_PASSWORD, ip, userAgent);
  expect(res.status).toBe(200);
  return res.body as Session;
}

async function refresh(refreshToken: string, ip = "203.0.113.90"): Promise<Response> {
  secrets.add(refreshToken);
  return remember(await t.http.post("/v1/auth/refresh").set(t.bffHeaders(ip)).send({ refreshToken }));
}

/** `Authorization: Bearer` of `accessToken` and the BFF headers. */
function authOf(accessToken: string, ip = "203.0.113.91"): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, ...t.bffHeaders(ip) };
}

/** A fresh portal access token of `account` from the application's TokenService, for a family that need not exist. */
async function tokenOf(account: Pick<PlatformRow<"accounts">, "id" | "email_verified_at">): Promise<string> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: account.id,
    sid: testId("asn", 8000 + counter),
    ev: account.email_verified_at !== null,
    amr: ["pwd"],
  });
  secrets.add(token);
  return token;
}

/** `200`, or the status and the error code of the envelope (whose request id is the header's). */
function outcomeOf(res: Response): string {
  if (res.status < 300) {
    return String(res.status);
  }
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return `${res.status} ${error.code}`;
}

async function accountRow(accountId: string): Promise<PlatformRow<"accounts">> {
  const { rows } = await pool.query("SELECT * FROM platform.accounts WHERE id = $1", [accountId]);
  return rows[0] as PlatformRow<"accounts">;
}

/** The audit rows of `action` about `targetId`. */
async function auditRows(action: string, targetId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT actor_type, actor_account_id, target_type, target_id, request_id, details " +
      "FROM platform.platform_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
    [action, targetId],
  );
  return rows as Array<Record<string, unknown>>;
}

let familyCounter = 0;
/**
 * Inserts the first row of a family of `account` as another task writes it (an admin sign-in of PBE-028), or a family
 * that is revoked or has ended, and returns its id and the refresh token whose SHA-256 it stores.
 */
async function insertFamily(
  account: Pick<PlatformRow<"accounts">, "id">,
  values: {
    readonly audience: "portal" | "platform_admin";
    readonly createdAt: Date;
    readonly endsAt: Date;
    readonly revokedAt?: Date;
    readonly userAgent?: string;
    readonly ipAddress?: string;
  },
): Promise<{ readonly familyId: string; readonly refreshToken: string }> {
  familyCounter += 1;
  const familyId = testId("asn", 9000 + familyCounter);
  const { token, hash } = generateToken("rt");
  secrets.add(token);
  await insertRow(pool, "account_sessions", {
    id: familyId,
    account_id: account.id,
    family_id: familyId,
    audience: values.audience,
    refresh_token_hash: hash,
    user_agent: values.userAgent ?? null,
    ip_address: values.ipAddress ?? null,
    expires_at: values.endsAt,
    family_expires_at: values.endsAt,
    revoked_at: values.revokedAt ?? null,
    revoke_reason: values.revokedAt === undefined ? null : "logout",
    mfa_verified_at: values.audience === "platform_admin" ? values.createdAt : null,
    created_at: values.createdAt,
    updated_at: values.createdAt,
  });
  return { familyId, refreshToken: token };
}

/** The family (`sid`) of a portal access token. */
async function familyOfToken(accessToken: string): Promise<string> {
  return (await tokens.verify(accessToken, "portal")).sid;
}

/** Waits for the `account` invalidation of `accountId`. */
async function invalidationOf(accountId: string): Promise<InvalidationEvent> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const event = invalidated.find(
      (candidate) => "accountId" in candidate && candidate.accountId === accountId,
    );
    if (event !== undefined) {
      return event;
    }
    if (Date.now() > deadline) {
      throw new Error(`no account invalidation of ${accountId} within ${WAIT_MS} ms`);
    }
    await new Promise((done) => setTimeout(done, 20));
  }
}

beforeAll(async () => {
  t = await createTestApp({
    env: {
      LOG_LEVEL: "trace",
      FEATURE_CUSTOM_DOMAINS: "true",
      // Custom domains need the storefront's IPv4 address since PBE-049: the placeholder of `.env.example`.
      STOREFRONT_IPV4: "203.0.113.10",
      FEATURE_SETTLEMENTS: "true",
      // Settlements need the Stripe key since FIX-W36-PLATFORM: the development value of `.env.example`.
      STRIPE_SECRET_KEY: "sk_test_replace_me",
    },
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  passwordHash = await t.app.get(PasswordPolicy).hash(TEST_PASSWORD);
  // The reference fixture of @velexis/testing has no time zones: the zones the profile updates use, as the loader
  // writes them (tools/reference-data). Asia/Kolkata stays out on purpose.
  await pool.query(
    "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
      "VALUES ('Europe/Oslo', NULL, 60, 120), ('America/New_York', NULL, -300, -240)",
  );
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in the first test.
  responseChecker("platform");
  // Redis pub/sub is not scoped to a database index: other test files may publish on `vx:invalidate` at the same
  // time, so only the events about this file's accounts are kept.
  subscriber = new Redis(t.redis.url, { lazyConnect: true, connectionName: "platform-me-test" });
  subscriber.on("message", (channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (
      channel === INVALIDATION_CHANNEL &&
      event.type === "account" &&
      accountsOfThisFile.has(event.accountId)
    ) {
      invalidated.push(event);
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
}, SETUP_TIMEOUT_MS);

describe("getMe", () => {
  let unverified: PlatformRow<"accounts">;
  let member: PlatformRow<"accounts">;
  let disabled: PlatformRow<"accounts">;
  let active: Awaited<ReturnType<typeof insertOta>>;
  let suspended: Awaited<ReturnType<typeof insertOta>>;
  const answers: Record<string, Response> = {};

  beforeAll(async () => {
    unverified = await insertUnverifiedAccount(pool, {
      email: `me-unverified-${Date.now()}@example.com`,
      full_name: "Nora Unverified",
    });
    accountsOfThisFile.add(unverified.id);
    member = await newAccount({ full_name: "Anna Berg", locale: "en-GB", time_zone: "Europe/Oslo" });
    disabled = await newAccount({ status: "disabled" });
    active = await insertOta(pool, { tenant: { name: "Fjord Travel" }, members: [[member, "owner"]] });
    suspended = await insertOta(pool, {
      tenant: { name: "Polar Trips", status: "suspended" },
      members: [[member, "finance"]],
    });
    // A removed membership is not shown.
    const removed = await insertOta(pool, { tenant: { name: "Left Behind" } });
    await insertMembership(pool, removed.tenant, member, { role: "admin", status: "removed" });

    answers["unverified"] = await t.http.get("/v1/me").set(authOf(await tokenOf(unverified)));
    answers["member"] = await t.http.get("/v1/me").set(authOf(await tokenOf(member)));
    answers["disabled"] = await t.http.get("/v1/me").set(authOf(await tokenOf(disabled)));
    answers["anonymous"] = await t.http.get("/v1/me").set(t.bffHeaders("203.0.113.92"));
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-016 AC4] getMe works for an unverified account and shows all six switches", () => {
    const res = answers["unverified"] as Response;
    expectResponseToMatch("getMe", res, { document: "platform" });
    expect(outcomeOf(res)).toBe("200");
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.body).toEqual({
      id: unverified.id,
      email: unverified.email,
      emailVerified: false,
      fullName: "Nora Unverified",
      locale: "en",
      timeZone: "UTC",
      mfaEnabled: false,
      mfaEnabledAt: null,
      isPlatformAdmin: false,
      createdAt: unverified.created_at.toISOString(),
      version: 1,
      memberships: [],
      features: {
        stripeBilling: false,
        ownStripe: false,
        settlements: true,
        ownAmadeus: false,
        customDomains: true,
        liveSwitch: false,
      },
    });
  });

  it("lists the active memberships with the OTA's key, name and status and the role", () => {
    const res = answers["member"] as Response;
    expectResponseToMatch("getMe", res, { document: "platform" });
    expect(res.body).toMatchObject({
      id: member.id,
      emailVerified: true,
      fullName: "Anna Berg",
      locale: "en-GB",
      timeZone: "Europe/Oslo",
      memberships: [
        {
          membershipId: active.memberships[0]?.id,
          tenantId: active.tenant.id,
          tenantKey: active.tenant.key,
          tenantName: "Fjord Travel",
          tenantStatus: "active",
          role: "owner",
        },
        {
          membershipId: suspended.memberships[0]?.id,
          tenantId: suspended.tenant.id,
          tenantKey: suspended.tenant.key,
          tenantName: "Polar Trips",
          tenantStatus: "suspended",
          role: "finance",
        },
      ],
    });
  });

  it("answers 401 to an account that may no longer hold a session, and without a token", () => {
    for (const name of ["disabled", "anonymous"]) {
      expectResponseToMatch("getMe", answers[name] as Response, { document: "platform" });
    }
    expect(outcomeOf(answers["disabled"] as Response)).toBe("401 UNAUTHENTICATED");
    expect(outcomeOf(answers["anonymous"] as Response)).toBe("401 UNAUTHENTICATED");
  });
});

describe("updateMe", () => {
  let account: PlatformRow<"accounts">;
  let unverified: PlatformRow<"accounts">;
  let headers: Record<string, string>;
  const answers: Record<string, Response> = {};

  function patch(
    ifMatch: string | undefined,
    body: Record<string, unknown>,
    auth = headers,
  ): Promise<Response> {
    const req = t.http.patch("/v1/me").set(auth);
    return (ifMatch === undefined ? req : req.set("If-Match", ifMatch)).send(body);
  }

  beforeAll(async () => {
    account = await newAccount({ full_name: "Anna Berg" });
    unverified = await insertUnverifiedAccount(pool, {
      email: `me-unverified-patch-${Date.now()}@example.com`,
    });
    accountsOfThisFile.add(unverified.id);
    headers = authOf(await tokenOf(account));
    answers["updated"] = await patch('"1"', { fullName: "  Anna Berg-Lund ", timeZone: "Europe/Oslo" });
    answers["stale"] = await patch('"1"', { locale: "en-GB" });
    answers["invalid"] = await patch('"2"', { fullName: "   ", timeZone: "Asia/Kolkata" });
    answers["withoutIfMatch"] = await patch(undefined, { locale: "en-GB" });
    answers["empty"] = await patch('"2"', {});
    answers["unchanged"] = await patch('"2"', { fullName: "Anna Berg-Lund", timeZone: "Europe/Oslo" });
    answers["unverified"] = await patch('"1"', { locale: "en-GB" }, authOf(await tokenOf(unverified)));
  }, GROUP_SETUP_TIMEOUT_MS);

  it("changes the profile with If-Match, answers the new version in ETag and audits the change [PF-07 AC1]", async () => {
    const res = answers["updated"] as Response;
    expectResponseToMatch("updateMe", res, { document: "platform" });
    expect(outcomeOf(res)).toBe("200");
    expect(res.headers["etag"]).toBe('"2"');
    expect(res.body).toMatchObject({
      id: account.id,
      fullName: "Anna Berg-Lund",
      timeZone: "Europe/Oslo",
      version: 2,
    });
    expect(await auditRows("account.updated", account.id)).toEqual([
      {
        actor_type: "account",
        actor_account_id: account.id,
        target_type: "account",
        target_id: account.id,
        request_id: res.headers["x-request-id"],
        details: {
          before: { fullName: "Anna Berg", timeZone: "UTC" },
          after: { fullName: "Anna Berg-Lund", timeZone: "Europe/Oslo" },
        },
      },
    ]);
  });

  it("[PBE-016 AC4] updateMe with a stale If-Match answers 412 [PF-07 AC1]", async () => {
    const res = answers["stale"] as Response;
    expectResponseToMatch("updateMe", res, { document: "platform" });
    expect(outcomeOf(res)).toBe("412 PRECONDITION_FAILED");
    expect(await accountRow(account.id)).toMatchObject({ locale: "en", version: 2 });
  });

  it("refuses a blank name, an unknown time zone, a missing If-Match and an empty body with 400", async () => {
    for (const name of ["invalid", "withoutIfMatch", "empty"]) {
      const res = answers[name] as Response;
      expectResponseToMatch("updateMe", res, { document: "platform" });
      expect(outcomeOf(res)).toBe("400 VALIDATION_FAILED");
    }
    expect(answers["invalid"]?.body).toMatchObject({
      error: {
        fieldErrors: [
          { path: "/fullName", code: "blank" },
          { path: "/timeZone", code: "unknown" },
        ],
      },
    });
    expect(JSON.stringify(answers["invalid"]?.body)).not.toContain("Asia/Kolkata");
    expect(answers["withoutIfMatch"]?.body).toMatchObject({
      error: { fieldErrors: [{ path: "/header/If-Match" }] },
    });
    expect(await accountRow(account.id)).toMatchObject({ full_name: "Anna Berg-Lund", version: 2 });
  });

  it("writes nothing for a request that changes nothing, and lets an unverified account edit its profile", async () => {
    const unchanged = answers["unchanged"] as Response;
    expect(outcomeOf(unchanged)).toBe("200");
    expect(unchanged.headers["etag"]).toBe('"2"');
    expect(await auditRows("account.updated", account.id)).toHaveLength(1);
    const res = answers["unverified"] as Response;
    expectResponseToMatch("updateMe", res, { document: "platform" });
    expect(outcomeOf(res)).toBe("200");
    expect(res.body).toMatchObject({ emailVerified: false, locale: "en-GB", version: 2 });
  });
});

describe("changePassword", () => {
  const ip = nextIp();
  let account: PlatformRow<"accounts">;
  let current: Session;
  let other: Session;
  let admin: { familyId: string; refreshToken: string };
  const answers: Record<string, Response> = {};
  /** The account's hash, its revoked rows and its OTA cut-off after the refusals, before the change. */
  let afterRefusals: { passwordHash: string | null; revokedRows: number; staffDeny: string | null };
  let changedAt: Date;

  function change(accessToken: string, body: Record<string, unknown>): Promise<Response> {
    for (const value of Object.values(body)) {
      secrets.add(String(value));
    }
    return t.http.post("/v1/me/password").set(authOf(accessToken, ip)).send(body);
  }

  beforeAll(async () => {
    account = await newAccount();
    current = await sessionOf(account, ip);
    other = await sessionOf(account, ip);
    admin = await insertFamily(account, {
      audience: "platform_admin",
      createdAt: t.clock.now(),
      endsAt: new Date(t.clock.now().getTime() + 12 * HOUR_MS),
    });
    const unverified = await insertUnverifiedAccount(pool, {
      email: `me-unverified-password-${Date.now()}@example.com`,
      password_hash: passwordHash,
    });
    answers["unverified"] = await change(await tokenOf(unverified), {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    answers["wrongCurrent"] = await change(current.accessToken, {
      currentPassword: "Not-The-Password-2026",
      newPassword: NEW_PASSWORD,
    });
    answers["weak"] = await change(current.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: "qwertyuiop",
    });
    const { rows: revoked } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM platform.account_sessions WHERE account_id = $1 AND revoked_at IS NOT NULL",
      [account.id],
    );
    afterRefusals = {
      passwordHash: (await accountRow(account.id)).password_hash,
      revokedRows: revoked[0]?.n ?? -1,
      staffDeny: await t.redis.client.get(redisKeys.staffDenyAccount(account.id).key),
    };
    t.clock.advance(MINUTE_MS);
    changedAt = t.clock.now();
    answers["changed"] = await change(current.accessToken, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
  }, GROUP_SETUP_TIMEOUT_MS);

  it("refuses an unverified account, a wrong current password and a weak new password, changing nothing", async () => {
    for (const res of Object.values(answers)) {
      expectResponseToMatch("changePassword", res, { document: "platform" });
    }
    expect(outcomeOf(answers["unverified"] as Response)).toBe("403 EMAIL_NOT_VERIFIED");
    expect(answers["wrongCurrent"]?.body).toMatchObject({
      error: {
        code: "CURRENT_PASSWORD_INCORRECT",
        status: 422,
        fieldErrors: [{ path: "/currentPassword", code: "incorrect" }],
      },
    });
    expect(answers["weak"]?.body).toMatchObject({
      error: { code: "PASSWORD_TOO_WEAK", fieldErrors: [{ path: "/newPassword", code: "breached" }] },
    });
    expect(JSON.stringify([answers["wrongCurrent"]?.body, answers["weak"]?.body])).not.toMatch(
      /Not-The-Password|qwertyuiop/,
    );
    // Until the accepted change: the same hash, no session revoked and no OTA cut-off.
    expect(afterRefusals).toEqual({ passwordHash, revokedRows: 0, staffDeny: null });
    expect(await auditRows("account.password_changed", account.id)).toHaveLength(1);
  });

  it("changes the password, keeps the caller's session and revokes every other one with staffdeny", async () => {
    expect(outcomeOf(answers["changed"] as Response)).toBe("204");
    const currentFamily = await familyOfToken(current.accessToken);
    const { rows } = await pool.query<{
      family_id: string;
      revoked_at: Date | null;
      revoke_reason: string | null;
    }>("SELECT family_id, revoked_at, revoke_reason FROM platform.account_sessions WHERE account_id = $1", [
      account.id,
    ]);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect([row.revoked_at, row.revoke_reason]).toEqual(
        row.family_id === currentFamily ? [null, null] : [changedAt, "password_change"],
      );
    }
    expect(outcomeOf(await refresh(current.refreshToken))).toBe("200");
    expect(outcomeOf(await refresh(other.refreshToken))).toBe("401 REFRESH_TOKEN_INVALID");
    expect(outcomeOf(await refresh(admin.refreshToken))).toBe("401 REFRESH_TOKEN_INVALID");

    const key = redisKeys.staffDenyAccount(account.id).key;
    expect(await t.redis.client.get(key)).toBe(String(changedAt.getTime()));
    const ttl = await t.redis.client.pttl(key);
    expect(ttl).toBeGreaterThan((STAFF_DENY_ACCOUNT_TTL_SECONDS - 60) * 1000);
    expect(ttl).toBeLessThanOrEqual(STAFF_DENY_ACCOUNT_TTL_SECONDS * 1000);

    expect((await accountRow(account.id)).password_changed_at).toEqual(changedAt);
    expect(outcomeOf(await signIn(account.email, NEW_PASSWORD, ip))).toBe("200");
    expect(outcomeOf(await signIn(account.email, TEST_PASSWORD, ip))).toBe("401 INVALID_CREDENTIALS");
  });

  it("e-mails the account, audits and announces the change", async () => {
    const { rows } = await pool.query(
      "SELECT template, to_email FROM platform.email_outbox WHERE account_id = $1",
      [account.id],
    );
    expect(rows).toEqual([{ template: "auth.password_changed", to_email: account.email }]);
    expect(await auditRows("account.password_changed", account.id)).toEqual([
      {
        actor_type: "account",
        actor_account_id: account.id,
        target_type: "account",
        target_id: account.id,
        request_id: answers["changed"]?.headers["x-request-id"],
        details: { revokedFamilies: 2, staffDenyFrom: changedAt.toISOString() },
      },
    ]);
    expect(await invalidationOf(account.id)).toEqual({ v: 1, type: "account", accountId: account.id });
  });
});

describe("listSessions and revokeSession", () => {
  const ip = nextIp();
  const otherIp = nextIp();
  let account: PlatformRow<"accounts">;
  let first: Session;
  let second: Session;
  let secondRotated: Session;
  let admin: { familyId: string; refreshToken: string };
  let stranger: { familyId: string; refreshToken: string };
  let signedInAt: Date[];
  let refreshedAt: Date;
  let listed: Response;
  let revoked: Response;
  let revokedAt: Date;
  let listedAfter: Response;
  const refusals: Record<string, Response> = {};

  beforeAll(async () => {
    account = await newAccount();
    const now = t.clock.now();
    // Families that are not active: revoked, and past their end.
    await insertFamily(account, {
      audience: "portal",
      createdAt: new Date(now.getTime() - 2 * DAY_MS),
      endsAt: new Date(now.getTime() + DAY_MS),
      revokedAt: new Date(now.getTime() - DAY_MS),
    });
    await insertFamily(account, {
      audience: "portal",
      createdAt: new Date(now.getTime() - 31 * DAY_MS),
      endsAt: new Date(now.getTime() - DAY_MS),
    });
    stranger = await insertFamily(await newAccount(), {
      audience: "portal",
      createdAt: now,
      endsAt: new Date(now.getTime() + DAY_MS),
    });

    signedInAt = [t.clock.now()];
    first = await sessionOf(account, ip, BROWSER);
    t.clock.advance(MINUTE_MS);
    signedInAt.push(t.clock.now());
    second = await sessionOf(account, otherIp, OTHER_BROWSER);
    t.clock.advance(MINUTE_MS);
    refreshedAt = t.clock.now();
    const rotated = await refresh(second.refreshToken);
    expect(rotated.status).toBe(200);
    secondRotated = rotated.body as Session;
    t.clock.advance(MINUTE_MS);
    signedInAt.push(t.clock.now());
    admin = await insertFamily(account, {
      audience: "platform_admin",
      createdAt: t.clock.now(),
      endsAt: new Date(t.clock.now().getTime() + 12 * HOUR_MS),
      userAgent: BROWSER,
      ipAddress: "2001:db8::7",
    });

    listed = await t.http.get("/v1/me/sessions").set(authOf(first.accessToken));
    const secondFamily = await familyOfToken(second.accessToken);
    t.clock.advance(MINUTE_MS);
    revokedAt = t.clock.now();
    revoked = await t.http.delete(`/v1/me/sessions/${secondFamily}`).set(authOf(first.accessToken));
    listedAfter = await t.http.get("/v1/me/sessions").set(authOf(first.accessToken));
    refusals["again"] = await t.http.delete(`/v1/me/sessions/${secondFamily}`).set(authOf(first.accessToken));
    refusals["stranger"] = await t.http
      .delete(`/v1/me/sessions/${stranger.familyId}`)
      .set(authOf(first.accessToken));
    refusals["unknown"] = await t.http
      .delete(`/v1/me/sessions/${testId("asn", 99_999)}`)
      .set(authOf(first.accessToken));
    refusals["malformed"] = await t.http
      .delete("/v1/me/sessions/not%20an%20id")
      .set(authOf(first.accessToken));
    refusals["anonymous"] = await t.http
      .delete(`/v1/me/sessions/${admin.familyId}`)
      .set(t.bffHeaders("203.0.113.93"));
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-016 AC3] the session list shows the current family [PF-06 AC1]", async () => {
    expectResponseToMatch("listSessions", listed, { document: "platform" });
    expect(outcomeOf(listed)).toBe("200");
    expect(listed.body).toEqual({
      data: [
        {
          familyId: admin.familyId,
          audience: "platform_admin",
          userAgent: BROWSER,
          ipAddress: "2001:db8::7",
          createdAt: signedInAt[2]?.toISOString(),
          lastUsedAt: null,
          current: false,
        },
        {
          familyId: await familyOfToken(second.accessToken),
          audience: "portal",
          userAgent: OTHER_BROWSER,
          ipAddress: otherIp,
          createdAt: signedInAt[1]?.toISOString(),
          lastUsedAt: refreshedAt.toISOString(),
          current: false,
        },
        {
          familyId: await familyOfToken(first.accessToken),
          audience: "portal",
          userAgent: BROWSER,
          ipAddress: ip,
          createdAt: signedInAt[0]?.toISOString(),
          lastUsedAt: null,
          current: true,
        },
      ],
    });
  });

  it("[PBE-016 AC3] revoking another family makes its refresh token fail [PF-06 AC1]", async () => {
    expectResponseToMatch("revokeSession", revoked, { document: "platform" });
    expect(outcomeOf(revoked)).toBe("204");
    expect(outcomeOf(await refresh(secondRotated.refreshToken))).toBe("401 REFRESH_TOKEN_INVALID");
    expect((listedAfter.body as { data: Array<{ familyId: string }> }).data.map((s) => s.familyId)).toEqual([
      admin.familyId,
      await familyOfToken(first.accessToken),
    ]);
    const secondFamily = await familyOfToken(second.accessToken);
    expect(await auditRows("auth.session_revoked", secondFamily)).toEqual([
      {
        actor_type: "account",
        actor_account_id: account.id,
        target_type: "session",
        target_id: secondFamily,
        request_id: revoked.headers["x-request-id"],
        details: { audience: "portal" },
      },
    ]);
    const { rows } = await pool.query<{ revoked_at: Date | null; revoke_reason: string | null }>(
      "SELECT revoked_at, revoke_reason FROM platform.account_sessions WHERE family_id = $1",
      [secondFamily],
    );
    expect(rows).toEqual([
      { revoked_at: revokedAt, revoke_reason: "logout" },
      { revoked_at: revokedAt, revoke_reason: "logout" },
    ]);
    // The caller's own family still works.
    expect(outcomeOf(await refresh(first.refreshToken))).toBe("200");
  });

  it("answers 404 for a revoked, unknown or another account's family, and leaves the other account's alone", async () => {
    for (const res of Object.values(refusals)) {
      expectResponseToMatch("revokeSession", res, { document: "platform" });
    }
    expect(outcomeOf(refusals["again"] as Response)).toBe("404 NOT_FOUND");
    expect(outcomeOf(refusals["stranger"] as Response)).toBe("404 NOT_FOUND");
    expect(outcomeOf(refusals["unknown"] as Response)).toBe("404 NOT_FOUND");
    expect(outcomeOf(refusals["malformed"] as Response)).toBe("400 VALIDATION_FAILED");
    expect(outcomeOf(refusals["anonymous"] as Response)).toBe("401 UNAUTHENTICATED");
    expect(outcomeOf(await refresh(stranger.refreshToken))).toBe("200");
  });

  it("works for an account that waits for verification", async () => {
    const unverified = await insertUnverifiedAccount(pool, {
      email: `me-unverified-sessions-${Date.now()}@example.com`,
      password_hash: passwordHash,
    });
    const session = await sessionOf(unverified, nextIp());
    const res = await t.http.get("/v1/me/sessions").set(authOf(session.accessToken));
    expectResponseToMatch("listSessions", res, { document: "platform" });
    expect((res.body as { data: Array<{ current: boolean }> }).data.map((s) => s.current)).toEqual([true]);
  });
});

describe("the logs", () => {
  it("never hold a token or a password of this file", () => {
    expect(secrets.size).toBeGreaterThan(10);
    const text = t.logs.lines.map((line) => JSON.stringify(line)).join("\n");
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
  });
});
