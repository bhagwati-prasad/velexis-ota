// console.auth.signIn, refresh, signOut and me through the API's whole pipeline (OBE-059; OADR-0011 points 1–3 and
// 5, PADR-0007, flows/console-operations.md §1, §3 step 1, §4 and §6), against PostgreSQL 16 and Redis 7. The file
// clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned), writes the platform rows as the
// platform does (two active tenants, beta live; a secret key scoped `console` for each; accounts and memberships of
// every role), stores portal tokens as the platform's createConsoleToken does (`SET ptk:<sha256> … EX 60 NX`, PBE-039),
// and starts the API in-process. Every answer is checked against the OTA document (`expectResponseToMatch`). Each
// client calls from an IP address of its own (`X-Velexis-End-User-IP`), so the sign-in limit of 10 per minute per IP
// never mixes the tests. FIX-W23-STAFF adds the MFA rule of live tenants (PADR-0008; flows §6): a portal token whose
// `mfa` flag is false signs in to the test tenant alpha but not to the live tenant beta. Tokens and names are made up
// per run; no value is a secret.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { hashApiKey, sha256Hex } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
  type TenantSchema,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  FakeClock,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import type { ApiConfig } from "../../../src/config";
import { StaffTokens } from "../../../src/identity/staff/staff-sessions";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { newApiKey, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Role = "owner" | "admin" | "agent" | "finance" | "viewer";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let betaId: string;
let alphaKey: string;
let betaKey: string;

/** The permissions of each role, as ota/docs/scope.md §1.3 lists them (in the document's StaffPermission order). */
const SCOPE_PERMISSIONS: Readonly<Record<Role, readonly string[]>> = {
  owner: [
    "bookings:read",
    "bookings:write",
    "bookings:issue",
    "bookings:cancel",
    "customers:read",
    "queues:read",
    "supplier_requests:read",
    "amadeus:read",
    "amadeus:write",
    "settings:read",
    "settings:write",
    "payments:read",
    "payments:capture",
    "payments:refund",
  ],
  admin: [
    "bookings:read",
    "bookings:write",
    "bookings:issue",
    "bookings:cancel",
    "customers:read",
    "queues:read",
    "supplier_requests:read",
    "amadeus:read",
    "amadeus:write",
    "settings:read",
    "settings:write",
    "payments:read",
    "payments:capture",
    "payments:refund",
  ],
  agent: [
    "bookings:read",
    "bookings:write",
    "bookings:issue",
    "bookings:cancel",
    "customers:read",
    "queues:read",
    "supplier_requests:read",
    "amadeus:read",
    "settings:read",
    "payments:read",
    "payments:capture",
  ],
  finance: [
    "bookings:read",
    "customers:read",
    "supplier_requests:read",
    "settings:read",
    "payments:read",
    "payments:capture",
    "payments:refund",
  ],
  viewer: ["bookings:read", "customers:read", "settings:read", "payments:read"],
};

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one client. */
const newIp = (): string => {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
};

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A portal token in the platform's format (PADR-0007 item 1): `ptk_` and 43 random base62 characters. */
function newPortalToken(): string {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  return token;
}

/** Inserts an active tenant of a provisioned test schema and a secret test key of it scoped `console`. */
async function insertTenant(
  key: "alpha" | "beta",
  live: boolean,
): Promise<{ tenantId: string; apiKey: string }> {
  const tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: tenantId,
      key,
      name: `${key} Travel`,
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/Madrid",
      storefront_environment: live ? "live" : "test",
      live_enabled_at: live ? new Date() : null,
    })
    .execute();
  const apiKey = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "OTA admin (test)",
      kind: "secret",
      environment: "test",
      prefix: apiKey.slice(0, 14),
      key_hash: hashApiKey(apiKey, testApiCredentials().pepper),
      last4: apiKey.slice(-4),
      scopes: ["console"],
    })
    .execute();
  return { tenantId, apiKey };
}

/** A portal account and its membership in one tenant. */
interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly tenantId: string;
  readonly email: string;
}

/** Inserts an active account (unless `accountId` names one) and its membership with `role` in `tenantId`. */
async function insertMember(tenantId: string, role: Role, accountId?: string): Promise<Member> {
  const email = `staff.${randomBytes(4).toString("hex")}@example.com`;
  const account = accountId ?? newId("acc");
  if (accountId === undefined) {
    await migrator
      .insertInto("platform.accounts")
      .values({
        id: account,
        email,
        full_name: "Maria Lopez",
        status: "active",
        email_verified_at: new Date(),
        locale: "en-GB",
        time_zone: "Europe/Paris",
        mfa_enabled: true,
      })
      .execute();
  }
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: tenantId, account_id: account, role, status: "active" })
    .execute();
  return { accountId: account, staffId, tenantId, email };
}

/**
 * Stores a portal token for `member` as the platform's API does (issued now, unless `issuedAt` says otherwise; `mfa`
 * is the token's flag that the account has MFA enabled).
 */
async function portalTokenFor(
  member: Member,
  role: Role = "agent",
  issuedAt = new Date(),
  mfa = true,
): Promise<string> {
  const token = newPortalToken();
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: member.tenantId,
    membershipId: member.staffId,
    role,
    mfa,
    issuedAt: issuedAt.toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 60, "NX")).toBe(
    "OK",
  );
  return token;
}

/** Publishes an invalidation event on `vx:invalidate`, as the platform does after its commit. */
async function publish(event: InvalidationEvent): Promise<void> {
  await redis.client.publish(INVALIDATION_CHANNEL, JSON.stringify(event));
}

/** The claims of a JWT, decoded without verification (the API verified it). */
function claimsOf(token: string): Record<string, unknown> {
  const [, payload = ""] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** The OTA admin's server for one staff member: a console key, the staff member's IP and user agent. */
class ConsoleClient {
  readonly ip = newIp();
  readonly userAgent = `Mozilla/5.0 (console test ${randomBytes(3).toString("hex")})`;

  constructor(readonly apiKey: string = alphaKey) {}

  headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      "X-Api-Key": this.apiKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": this.userAgent,
      ...extra,
    };
  }

  post(path: string, body: unknown, extra: Readonly<Record<string, string>> = {}): Promise<Response> {
    return request(api.server)
      .post(path)
      .set(this.headers({ "Idempotency-Key": randomUUID(), ...extra }))
      .send(body as object);
  }

  signIn(portalToken: string, extra: Readonly<Record<string, string>> = {}): Promise<Response> {
    return this.post("/v1/console/auth/sign-in", { grantType: "portal_token", portalToken }, extra);
  }

  refresh(refreshToken: string): Promise<Response> {
    return this.post("/v1/console/auth/refresh", { refreshToken });
  }

  signOut(body: Record<string, unknown>, accessToken?: string): Promise<Response> {
    return this.post(
      "/v1/console/auth/sign-out",
      body,
      accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` },
    );
  }

  me(accessToken?: string): Promise<Response> {
    const req = request(api.server).get("/v1/console/auth/me").set(this.headers());
    return accessToken === undefined ? req : req.set("Authorization", `Bearer ${accessToken}`);
  }
}

/** A signed-in staff member: the client and the tokens of the answer. */
interface SignedIn {
  readonly client: ConsoleClient;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly familyId: string;
  readonly body: Record<string, unknown>;
}

/** Signs `member` in through a new client of `apiKey`; fails the test unless it answers 200. */
async function signIn(member: Member, apiKey = alphaKey): Promise<SignedIn> {
  const client = new ConsoleClient(apiKey);
  const res = await client.signIn(await portalTokenFor(member));
  expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
  const session = res.body.session as { accessToken: string; refreshToken: string };
  return {
    client,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    familyId: claimsOf(session.accessToken)["sid"] as string,
    body: res.body as Record<string, unknown>,
  };
}

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

// Cloning the template and building the API's module graph (Nest, pools, Redis, the OTA document's validators) take
// several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own budget, and
// the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-reader",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  ({ tenantId: alphaId, apiKey: alphaKey } = await insertTenant("alpha", false));
  ({ tenantId: betaId, apiKey: betaKey } = await insertTenant("beta", true));
  api = await createTestApp({ database: db, redis });
  // The first sign-in and me of a process open the pools' connections and warm the token and validation code; done
  // once here, so that no test pays for it.
  const warmUp = await signIn(await insertMember(alphaId, "owner"));
  expect((await warmUp.client.me(warmUp.accessToken)).status).toBe(200);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

describe("console.auth.signIn", () => {
  it("redeems a portal token once; the second use and a token of another tenant answer 401 [OBE-059 AC1]", async () => {
    const member = await insertMember(alphaId, "agent");
    const client = new ConsoleClient();
    const token = await portalTokenFor(member);

    const first = await client.signIn(token);
    const second = await client.signIn(token);
    const betaMember = await insertMember(betaId, "agent");
    const betaToken = await portalTokenFor(betaMember);
    const atAlpha = await client.signIn(betaToken);
    const thenAtBeta = await new ConsoleClient(betaKey).signIn(betaToken);

    expect(answer(first)).toEqual([200, undefined]);
    expectResponseToMatch("consoleSignIn", first);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body.session.subject).toEqual({ type: "staff", id: member.staffId, roles: ["agent"] });
    expect(first.body.staff).toMatchObject({
      id: member.staffId,
      accountId: member.accountId,
      role: "agent",
    });
    expect(first.body.tenant).toMatchObject({ id: alphaId, key: "alpha", environment: "test" });
    expect(first.body.environments).toEqual(["test"]);
    for (const res of [second, atAlpha, thenAtBeta]) {
      expect(answer(res)).toEqual([401, "PORTAL_TOKEN_INVALID"]);
      expectResponseToMatch("consoleSignIn", res);
    }
    // GETDEL: the token is gone after its first presentation, wherever that was.
    expect(await redis.client.exists(redisKeys.portalToken(sha256Hex(token)).key)).toBe(0);
    expect(await redis.client.exists(redisKeys.portalToken(sha256Hex(betaToken)).key)).toBe(0);
  });

  it("issues a staff access token and a 12-hour family that stores no token in clear", async () => {
    const member = await insertMember(alphaId, "finance");
    const { accessToken, refreshToken, familyId, body } = await signIn(member);

    const claims = claimsOf(accessToken);
    expect(claims).toMatchObject({ typ: "staff", sub: member.staffId, tid: alphaId, roles: ["finance"] });
    expect(familyId).toMatch(/^asn_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Number(claims["exp"]) - Number(claims["iat"])).toBe(900);
    expect(refreshToken).toMatch(/^srt_/);
    const session = body["session"] as { refreshTokenExpiresAt: string; accessTokenExpiresAt: string };
    const lifetime = Date.parse(session.refreshTokenExpiresAt) - Number(claims["iat"]) * 1000;
    expect(Math.abs(lifetime - 12 * 3600 * 1000)).toBeLessThan(2000);
    const key = redisKeys.staffSession(familyId).key;
    expect(await redis.client.ttl(key)).toBeGreaterThan(12 * 3600 - 60);
    const stored = (await redis.client.get(key)) ?? "";
    expect(stored).toContain(sha256Hex(refreshToken));
    expect(stored).not.toContain(refreshToken);
    expect(stored).not.toContain(accessToken);
  });

  it("writes one staff_actions row staff.sign_in with the staff member's IP and user agent, and no token", async () => {
    const member = await insertMember(alphaId, "admin");
    const { client, refreshToken, accessToken, familyId } = await signIn(member);

    const rows = await tenantTx(tenantDb, "tenant_alpha" as TenantSchema, (trx) =>
      trx.selectFrom("staff_actions").selectAll().where("staff_id", "=", member.staffId).execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: "staff",
      actor_id: member.staffId,
      account_id: member.accountId,
      staff_email: member.email,
      staff_role: "admin",
      action: "staff.sign_in",
      target_type: "staff_session",
      target_id: familyId,
      outcome: "succeeded",
      ip_address: client.ip,
      user_agent: client.userAgent,
    });
    expect(rows[0]?.request_id).toEqual(expect.any(String));
    const text = JSON.stringify(rows);
    expect(text).not.toContain(refreshToken);
    expect(text).not.toContain(accessToken);
  });

  it("refuses a portal token issued before the account's staffdeny:acct cut-off", async () => {
    const member = await insertMember(alphaId, "agent");
    const client = new ConsoleClient();
    const now = Date.now();
    const token = await portalTokenFor(member, "agent", new Date(now - 2000));
    const cutOff = redisKeys.staffDenyAccount(member.accountId);
    // The platform's "sign out everywhere" a second after it issued the token.
    await redis.client.set(cutOff.key, String(now - 1000), "EX", cutOff.ttlSeconds);

    const refused = await client.signIn(token);
    const later = await client.signIn(await portalTokenFor(member));

    expect(answer(refused)).toEqual([401, "PORTAL_TOKEN_INVALID"]);
    expectResponseToMatch("consoleSignIn", refused);
    expect(await redis.client.exists(redisKeys.portalToken(sha256Hex(token)).key)).toBe(0);
    // A token issued after the cut-off opens a session.
    expect(answer(later)).toEqual([200, undefined]);
  });

  it("answers the password grant with 403 FEATURE_DISABLED (passwordGrant)", async () => {
    const res = await new ConsoleClient().post("/v1/console/auth/sign-in", {
      grantType: "password",
      email: "maria.lopez@example.com",
      password: `pw-${randomBytes(6).toString("hex")}`,
    });

    expect(answer(res)).toEqual([403, "FEATURE_DISABLED"]);
    expect(res.body.error.details).toEqual({ feature: "passwordGrant" });
    expectResponseToMatch("consoleSignIn", res);
  });

  it("refuses a removed or suspended membership and a disabled account with 403 STAFF_MEMBERSHIP_INACTIVE", async () => {
    const removed = await insertMember(alphaId, "agent");
    const suspended = await insertMember(alphaId, "agent");
    const disabled = await insertMember(alphaId, "agent");
    await migrator
      .updateTable("platform.tenant_memberships")
      .set({ status: "removed" })
      .where("id", "=", removed.staffId)
      .execute();
    await migrator
      .updateTable("platform.tenant_memberships")
      .set({ status: "suspended" })
      .where("id", "=", suspended.staffId)
      .execute();
    await migrator
      .updateTable("platform.accounts")
      .set({ status: "disabled" })
      .where("id", "=", disabled.accountId)
      .execute();

    for (const member of [removed, suspended, disabled]) {
      const res = await new ConsoleClient().signIn(await portalTokenFor(member));
      expect([member.staffId, ...answer(res)]).toEqual([member.staffId, 403, "STAFF_MEMBERSHIP_INACTIVE"]);
      expectResponseToMatch("consoleSignIn", res);
    }
  });

  it("replays the stored session to a retry with the same Idempotency-Key", async () => {
    const member = await insertMember(alphaId, "viewer");
    const client = new ConsoleClient();
    const key = randomUUID();
    const token = await portalTokenFor(member);

    const first = await client.signIn(token, { "Idempotency-Key": key });
    const retry = await client.signIn(token, { "Idempotency-Key": key });

    expect(answer(first)).toEqual([200, undefined]);
    expect(answer(retry)).toEqual([200, undefined]);
    expect(retry.body.session).toEqual(first.body.session);
  });

  it("offers live to the non-viewer roles of a live tenant only", async () => {
    const agent = await insertMember(betaId, "agent");
    const viewer = await insertMember(betaId, "viewer");

    const agentSession = await signIn(agent, betaKey);
    const viewerSession = await signIn(viewer, betaKey);

    expect(agentSession.body["environments"]).toEqual(["test", "live"]);
    expect(viewerSession.body["environments"]).toEqual(["test"]);
    const me = await agentSession.client.me(agentSession.accessToken);
    expect(me.body.environments).toEqual(["test", "live"]);
  });

  it("refuses a portal token without MFA for a live OTA with 403 MFA_REQUIRED: the token stays used, nothing opens [FIX-W23-STAFF AC2]", async () => {
    const member = await insertMember(betaId, "agent");
    const client = new ConsoleClient(betaKey);
    const token = await portalTokenFor(member, "agent", new Date(), false);

    const refused = await client.signIn(token);
    const again = await client.signIn(token);

    expect(answer(refused)).toEqual([403, "MFA_REQUIRED"]);
    expectResponseToMatch("consoleSignIn", refused);
    expect(refused.headers["cache-control"]).toBe("no-store");
    expect(refused.body.error.details).toBeUndefined();
    // GETDEL: the refused token is gone, so presenting it again is an unknown token.
    expect(await redis.client.exists(redisKeys.portalToken(sha256Hex(token)).key)).toBe(0);
    expect(answer(again)).toEqual([401, "PORTAL_TOKEN_INVALID"]);
    // No session and no staff_actions row for the refused sign-in.
    // This file's Redis database is its own (useRedis), so the families listed are this file's.
    const families = await redis.client.keys("staffsess:*");
    const stored = families.length === 0 ? [] : await redis.client.mget(...families);
    expect(stored.filter((value) => value?.includes(member.staffId))).toEqual([]);
    const rows = await tenantTx(tenantDb, "tenant_beta" as TenantSchema, (trx) =>
      trx.selectFrom("staff_actions").select("id").where("staff_id", "=", member.staffId).execute(),
    );
    expect(rows).toEqual([]);
    // With MFA (a token the platform issues once MFA is on) the same member signs in, live offered.
    const withMfa = await client.signIn(await portalTokenFor(member, "agent", new Date(), true));
    expect(answer(withMfa)).toEqual([200, undefined]);
    expect(withMfa.body.environments).toEqual(["test", "live"]);
    const after = await redis.client.mget(...(await redis.client.keys("staffsess:*")));
    expect(after.filter((value) => value?.includes(member.staffId))).toHaveLength(1);
  });

  it("signs in to a test OTA with or without MFA on the portal token [FIX-W23-STAFF AC2]", async () => {
    const member = await insertMember(alphaId, "agent");
    const client = new ConsoleClient();

    const without = await client.signIn(await portalTokenFor(member, "agent", new Date(), false));
    const withMfa = await client.signIn(await portalTokenFor(member, "agent", new Date(), true));

    for (const res of [without, withMfa]) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("consoleSignIn", res);
      expect(res.body.environments).toEqual(["test"]);
      expect(res.body.session.subject).toEqual({ type: "staff", id: member.staffId, roles: ["agent"] });
    }
  });

  it("counts sign-ins per end-user IP: the eleventh in a minute answers 429", async () => {
    const client = new ConsoleClient();
    const answers: Response[] = [];
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      answers.push(await client.signIn(newPortalToken()));
    }

    expect(answers.slice(0, 10).map(answer)).toEqual(
      Array.from({ length: 10 }, () => [401, "PORTAL_TOKEN_INVALID"]),
    );
    expect(answer(answers[10] as Response)).toEqual([429, "RATE_LIMITED"]);
    expect(answer(await new ConsoleClient().signIn(newPortalToken()))).toEqual([401, "PORTAL_TOKEN_INVALID"]);
  });
});

describe("console.auth.me", () => {
  it("returns the permissions of scope §1.3 for each of the five roles [OBE-059 AC3]", async () => {
    for (const role of ["owner", "admin", "agent", "finance", "viewer"] as const) {
      const member = await insertMember(alphaId, role);
      const { client, accessToken, familyId } = await signIn(member);

      const res = await client.me(accessToken);

      expect([role, res.status]).toEqual([role, 200]);
      expectResponseToMatch("consoleGetMe", res);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect([role, [...(res.body.permissions as string[])].sort()]).toEqual([
        role,
        [...SCOPE_PERMISSIONS[role]].sort(),
      ]);
      expect(res.body.staff).toMatchObject({
        id: member.staffId,
        role,
        status: "active",
        timeZone: "Europe/Paris",
      });
      expect(res.body.tenant).toMatchObject({
        id: alphaId,
        environment: "test",
        timeZone: "Europe/Madrid",
        supplier: { connected: false, officeIds: [] },
      });
      expect(res.body.session).toMatchObject({ id: familyId, userAgent: client.userAgent });
      expect(res.body.environments).toEqual(["test"]);
    }
  });

  it("needs a staff token of this tenant: none, another tenant's and a malformed one answer 401", async () => {
    const betaMember = await insertMember(betaId, "owner");
    const atBeta = await signIn(betaMember, betaKey);
    const client = new ConsoleClient();

    const answers = [
      await client.me(),
      await client.me(atBeta.accessToken),
      await client.me(`${atBeta.accessToken.slice(0, -4)}AAAA`),
    ];

    for (const res of answers) {
      expect(answer(res)).toEqual([401, "UNAUTHENTICATED"]);
      expectResponseToMatch("consoleGetMe", res);
    }
    expect((await atBeta.client.me(atBeta.accessToken)).status).toBe(200);
  });
});

describe("revocation", () => {
  it("a staffdeny:acct cut-off newer than the family makes the next request and refresh fail [OBE-059 AC2]", async () => {
    const member = await insertMember(alphaId, "agent");
    const older = await signIn(member);
    const createdAt = Date.parse((await older.client.me(older.accessToken)).body.session.createdAt as string);
    const cutOff = redisKeys.staffDenyAccount(member.accountId);

    // A cut-off from before the family leaves it alone.
    await redis.client.set(cutOff.key, String(createdAt - 1000), "EX", cutOff.ttlSeconds);
    const before = await older.client.me(older.accessToken);
    // The platform's "sign out everywhere" after the sign-in.
    await redis.client.set(cutOff.key, String(createdAt + 1), "EX", cutOff.ttlSeconds);
    const me = await older.client.me(older.accessToken);
    const refresh = await older.client.refresh(older.refreshToken);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await signIn(member);

    expect(before.status).toBe(200);
    expect(answer(me)).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("consoleGetMe", me);
    expect(answer(refresh)).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    expectResponseToMatch("consoleRefreshSession", refresh);
    expect((await newer.client.me(newer.accessToken)).status).toBe(200);
  });

  it("a staffdeny:tenant cut-off ends the tenant's families", async () => {
    const member = await insertMember(betaId, "agent");
    const session = await signIn(member, betaKey);
    const cutOff = redisKeys.staffDenyTenant(betaId);

    await redis.client.set(cutOff.key, String(Date.now() + 1), "EX", 60);
    const me = await session.client.me(session.accessToken);
    await redis.client.del(cutOff.key);

    expect(answer(me)).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("a membership invalidation for a removed member takes effect within one second [OBE-059 AC2]", async () => {
    const member = await insertMember(alphaId, "agent");
    const { client, accessToken, refreshToken, familyId } = await signIn(member);
    expect((await client.me(accessToken)).status).toBe(200);
    const cached = redisKeys.member(member.accountId, alphaId).key;
    expect(await redis.client.exists(cached)).toBe(1);

    await migrator
      .updateTable("platform.tenant_memberships")
      .set({ status: "removed" })
      .where("id", "=", member.staffId)
      .execute();
    // The membership is cached for 60 s: until the platform's event, the session still works.
    expect((await client.me(accessToken)).status).toBe(200);
    await publish({ v: 1, type: "membership", accountId: member.accountId, tenantId: alphaId });
    // Within one second the subscriber has dropped the cached membership, so the next request reads the platform row.
    await vi.waitFor(
      async () => {
        expect(await redis.client.exists(cached)).toBe(0);
      },
      { timeout: 1000, interval: 10 },
    );

    const me = await client.me(accessToken);
    expect(answer(me)).toEqual([403, "STAFF_MEMBERSHIP_INACTIVE"]);
    expectResponseToMatch("consoleGetMe", me);
    const refresh = await client.refresh(refreshToken);
    expect(answer(refresh)).toEqual([403, "STAFF_MEMBERSHIP_INACTIVE"]);
    expectResponseToMatch("consoleRefreshSession", refresh);
    expect(await redis.client.exists(redisKeys.staffSession(familyId).key)).toBe(0);
  });

  it("a role change ends the session: a new sign-in is needed", async () => {
    const member = await insertMember(alphaId, "agent");
    const { client, accessToken, refreshToken } = await signIn(member);
    expect((await client.me(accessToken)).status).toBe(200);
    const cached = redisKeys.member(member.accountId, alphaId).key;

    await migrator
      .updateTable("platform.tenant_memberships")
      .set({ role: "viewer" })
      .where("id", "=", member.staffId)
      .execute();
    await publish({ v: 1, type: "membership", accountId: member.accountId, tenantId: alphaId });
    await vi.waitFor(
      async () => {
        expect(await redis.client.exists(cached)).toBe(0);
      },
      { timeout: 1000, interval: 10 },
    );

    expect(answer(await client.me(accessToken))).toEqual([401, "UNAUTHENTICATED"]);
    expect(answer(await client.refresh(refreshToken))).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    const again = await signIn(member);
    expect(claimsOf(again.accessToken)["roles"]).toEqual(["viewer"]);
  });
});

describe("console.auth.refresh", () => {
  it("rotates the refresh token; the rotated one presented again revokes the family (REFRESH_TOKEN_REUSED)", async () => {
    const member = await insertMember(alphaId, "agent");
    const { client, refreshToken, familyId } = await signIn(member);
    const key = redisKeys.staffSession(familyId).key;
    const ttl = await redis.client.ttl(key);

    const rotated = await client.refresh(refreshToken);
    const next = rotated.body.session as { accessToken: string; refreshToken: string };
    const again = await client.refresh(next.refreshToken);
    const ttlAfter = await redis.client.ttl(key);
    const newest = again.body.session as { accessToken: string; refreshToken: string };
    const meAfterRotation = await client.me(newest.accessToken);
    const reused = await client.refresh(refreshToken);
    const afterReuse = await client.refresh(newest.refreshToken);
    const meAfterReuse = await client.me(newest.accessToken);

    expect([answer(rotated), answer(again)]).toEqual([
      [200, undefined],
      [200, undefined],
    ]);
    expectResponseToMatch("consoleRefreshSession", rotated);
    expect(rotated.headers["cache-control"]).toBe("no-store");
    expect(new Set([refreshToken, next.refreshToken, newest.refreshToken]).size).toBe(3);
    expect(claimsOf(newest.accessToken)).toMatchObject({ sid: familyId, sub: member.staffId });
    expect(again.body.permissions).toEqual(expect.arrayContaining(["bookings:issue"]));
    // KEEPTTL: a rotation never extends the family.
    expect(ttlAfter).toBeLessThanOrEqual(ttl);
    expect(meAfterRotation.status).toBe(200);
    // The first token, rotated two generations ago, is still known as a rotated one.
    expect(answer(reused)).toEqual([401, "REFRESH_TOKEN_REUSED"]);
    expectResponseToMatch("consoleRefreshSession", reused);
    expect(answer(afterReuse)).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    expect(answer(meAfterReuse)).toEqual([401, "UNAUTHENTICATED"]);
    expect(await redis.client.exists(redisKeys.staffSession(familyId).key)).toBe(0);
    expect(await redis.client.exists(redisKeys.staffDeny(familyId).key)).toBe(1);
  });

  it("refuses a customer refresh token, a made-up one and another tenant's with 401 REFRESH_TOKEN_INVALID", async () => {
    const betaMember = await insertMember(betaId, "agent");
    const atBeta = await signIn(betaMember, betaKey);
    const client = new ConsoleClient();

    const answers = [
      await client.refresh(`rt_${randomBytes(32).toString("base64url")}`),
      await client.refresh(`srt_${atBeta.familyId.slice(4)}${randomBytes(32).toString("base64url")}`),
      await client.refresh(atBeta.refreshToken),
    ];

    for (const res of answers) {
      expect(answer(res)).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    }
    // Neither the made-up token nor the presentation at another tenant touched beta's session.
    expect((await atBeta.client.refresh(atBeta.refreshToken)).status).toBe(200);
  });
});

describe("console.auth.signOut", () => {
  it("ends the session of the access token: it and its refresh token stop working at once", async () => {
    const member = await insertMember(alphaId, "agent");
    const { client, accessToken, refreshToken } = await signIn(member);

    const res = await client.signOut({}, accessToken);

    expect(res.status).toBe(204);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(answer(await client.me(accessToken))).toEqual([401, "UNAUTHENTICATED"]);
    expect(answer(await client.refresh(refreshToken))).toEqual([401, "REFRESH_TOKEN_INVALID"]);
  });

  it("answers 204 again for the access token of a session that has ended; scope all then needs a live one", async () => {
    const member = await insertMember(alphaId, "agent");
    const removed = await insertMember(alphaId, "agent");
    const { client, accessToken } = await signIn(member);
    const gone = await signIn(removed);
    await migrator
      .updateTable("platform.tenant_memberships")
      .set({ status: "removed" })
      .where("id", "=", removed.staffId)
      .execute();
    await publish({ v: 1, type: "membership", accountId: removed.accountId, tenantId: alphaId });
    const cached = redisKeys.member(removed.accountId, alphaId).key;
    await vi.waitFor(
      async () => {
        expect(await redis.client.exists(cached)).toBe(0);
      },
      { timeout: 1000, interval: 10 },
    );

    const first = await client.signOut({}, accessToken);
    const again = await client.signOut({}, accessToken);
    const everywhere = await client.signOut({ scope: "all" }, accessToken);
    // The removed member's session still exists (its refresh has not run yet): the sign-out ends it.
    const byRemoved = await gone.client.signOut({}, gone.accessToken);

    expect([first.status, again.status]).toEqual([204, 204]);
    expect(answer(everywhere)).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("consoleSignOut", everywhere);
    expect(byRemoved.status).toBe(204);
    expect(await redis.client.exists(redisKeys.staffSession(gone.familyId).key)).toBe(0);
    expect(await redis.client.exists(redisKeys.staffDeny(gone.familyId).key)).toBe(1);
  });

  it("answers 401 TOKEN_EXPIRED to an expired access token alone, as its x-error-codes say; with the refresh token it signs out [FIX-W23-STAFF AC1]", async () => {
    const member = await insertMember(alphaId, "agent");
    const { client, accessToken, refreshToken, familyId } = await signIn(member);
    // The same claims, signed with the API's key by a clock 20 minutes back: expired 5 minutes ago.
    const past = new FakeClock(new Date(Date.now() - 20 * 60 * 1000));
    const tokens = new StaffTokens(
      { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>,
      past as unknown as Clock,
    );
    const expired = (await tokens.sign({ sub: member.staffId, tid: alphaId, sid: familyId, role: "agent" }))
      .token;

    const alone = await client.signOut({}, expired);
    const withRefresh = await client.signOut({ refreshToken }, expired);

    expect(answer(alone)).toEqual([401, "TOKEN_EXPIRED"]);
    expectResponseToMatch("consoleSignOut", alone);
    expect(withRefresh.status).toBe(204);
    expect(answer(await client.me(accessToken))).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("ends a session by its refresh token alone; an unknown one is a no-op 204 and no credential 401", async () => {
    const member = await insertMember(alphaId, "agent");
    const { client, accessToken, refreshToken } = await signIn(member);

    const unknown = await client.signOut({ refreshToken: `srt_${randomBytes(48).toString("base64url")}` });
    const meAfterUnknown = await client.me(accessToken);
    const byRefresh = await client.signOut({ scope: "current", refreshToken });
    const none = await client.signOut({});

    expect(unknown.status).toBe(204);
    expect(meAfterUnknown.status).toBe(200);
    expect(byRefresh.status).toBe(204);
    expect(answer(await client.me(accessToken))).toEqual([401, "UNAUTHENTICATED"]);
    expect(answer(none)).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("consoleSignOut", none);
  });

  it("scope all ends every session of the member in this OTA, and none elsewhere", async () => {
    const member = await insertMember(alphaId, "admin");
    const elsewhere = await insertMember(betaId, "admin", member.accountId);
    const first = await signIn(member);
    const second = await signIn(member);
    const atBeta = await signIn(elsewhere, betaKey);

    const res = await first.client.signOut({ scope: "all" }, first.accessToken);

    expect(res.status).toBe(204);
    expect(answer(await second.client.me(second.accessToken))).toEqual([401, "UNAUTHENTICATED"]);
    expect(answer(await second.client.refresh(second.refreshToken))).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    expect((await atBeta.client.me(atBeta.accessToken)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = await signIn(member);
    expect((await later.client.me(later.accessToken)).status).toBe(200);
  });
});
