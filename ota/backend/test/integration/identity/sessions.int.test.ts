// Customer sessions, the customer guard and the session cookies in the API's pipeline (OBE-031; architecture §3 step 8
// and §3.2, ADR-0008, OADR-0006 points 1, 2 and 5), against PostgreSQL 16 and Redis 7. The file clones the
// @velexis/testing template (tenant_alpha and tenant_beta provisioned), writes the platform rows of two active tenants
// and a secret key each as the platform does, inserts customers into both schemas, and starts the API in-process with
// probe routes bound to operations of the document, so every guard applies to them as to the real handlers:
//
//   GET /__identity/session  getSession (a customer is required): answers the request's customer and actor;
//   GET /__identity/open     getStorefront (no customer): opens a session for `nextCustomer` and answers like a sign-in
//                            (cookies for the edge, the tokens in the body for a key).
//
// The refresh families are driven through `SessionsService` in a tenant context of their own, as the auth operations
// of OBE-032 and OBE-033 will drive them.
import { Controller, Get, Res } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { hashApiKey } from "@velexis/crypto";
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
import { isAppError } from "@velexis/errors";
import { createTestDatabase, FakeClock, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import type { Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CustomerContext } from "../../../src/common/auth/customer.guard";
import { Clock } from "../../../src/common/clock";
import { CookieWriter } from "../../../src/common/http/cookie-writer";
import { OpenApiOperation } from "../../../src/common/http/openapi-operation.decorator";
import { newId } from "../../../src/common/ids";
import type { ApiConfig } from "../../../src/config";
import { IdentityModule } from "../../../src/identity/identity.module";
import type { CustomerSessionRecord } from "../../../src/identity/sessions.repository";
import {
  REMEMBER_ME_SESSION_TTL_MS,
  SESSION_TTL_MS,
  SessionsService,
  type IssuedSession,
  type SessionTokens,
} from "../../../src/identity/sessions.service";
import { TokenService } from "../../../src/identity/token.service";
import { TenancyModule, type OtaPool } from "../../../src/tenancy/tenancy.module";
import { TenantContext, type RequestTenant } from "../../../src/tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { edgeHeaders, newApiKey, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const ALPHA_HOST = "alpha.ota.example.com";
const BETA_HOST = "beta.ota.example.com";

/** The customer the next `GET /__identity/open` opens a session for. */
let nextCustomer = "";

@Controller("__identity")
class SessionProbe {
  constructor(
    private readonly customers: CustomerContext,
    private readonly tenants: TenantContext,
    private readonly sessions: SessionsService,
    private readonly tx: TenantTx,
    private readonly cookies: CookieWriter,
  ) {}

  /** getSession: the guard requires a customer. */
  @Get("session")
  @OpenApiOperation("getSession")
  session(): unknown {
    const customer = this.customers.get();
    return {
      customer: customer === undefined ? null : { ...customer, accessTokenExpiresAt: undefined },
      actor: this.tenants.require().actor,
    };
  }

  /** getStorefront (no customer): opens a session for `nextCustomer` as a sign-in would. */
  @Get("open")
  @OpenApiOperation("getStorefront")
  async open(@Res({ passthrough: true }) res: Response): Promise<unknown> {
    const issued = await this.tx.run((trx) =>
      this.sessions.start(trx, {
        customerId: nextCustomer,
        identityId: null,
        rememberMe: false,
        userAgent: "probe",
      }),
    );
    const tokens = await this.sessions.tokensFor(issued);
    if (this.cookies.setSession(res, tokens)) {
      return { session: null };
    }
    return { session: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } };
  }
}

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let sessions: SessionsService;
let tenantContext: TenantContext;
let alpha: RequestTenant;
let beta: RequestTenant;
let alphaKey: string;
let betaKey: string;

/** Inserts an active tenant of a provisioned test schema, and a secret test key of it, as the platform does. */
async function insertTenant(key: "alpha" | "beta"): Promise<{ tenant: RequestTenant; apiKey: string }> {
  const tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id: tenantId, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  const apiKey = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: apiKey.slice(0, 14),
      key_hash: hashApiKey(apiKey, testApiCredentials().pepper),
      last4: apiKey.slice(-4),
    })
    .execute();
  const tenant: RequestTenant = {
    tenantId,
    key,
    schemaName: `tenant_${key}` as TenantSchema,
    environment: "test",
    caller: { type: "key", id: "key_test" },
    actor: { type: "system", id: null },
    requestId: "sessions-int-test",
  };
  return { tenant, apiKey };
}

/** Inserts a customer into `tenant`'s schema; its id. */
async function insertCustomer(tenant: RequestTenant, status = "active"): Promise<string> {
  const id = newId("cus");
  await tenantTx(tenantDb, tenant.schemaName, async (trx) => {
    await trx
      .insertInto("customers")
      .values({ id, email: `${id.toLowerCase()}@example.com`, status, first_name: "Anna", last_name: "Berg" })
      .execute();
  });
  return id;
}

/** Runs `fn` in a context of `tenant`, as a request of that tenant would. */
const inTenant = <T>(tenant: RequestTenant, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(tenant, fn);

/** Opens a family of `customerId` in `tenant`. */
function start(
  tenant: RequestTenant,
  customerId: string,
  options: { rememberMe?: boolean; userAgent?: string } = {},
): Promise<IssuedSession> {
  return inTenant(tenant, () =>
    api.app.get(TenantTx).run((trx) =>
      sessions.start(trx, {
        customerId,
        identityId: null,
        rememberMe: options.rememberMe ?? false,
        userAgent: options.userAgent ?? "Mozilla/5.0 (test)",
        ipCountry: "FR",
      }),
    ),
  );
}

const refresh = (tenant: RequestTenant, token: string): Promise<SessionTokens> =>
  inTenant(tenant, () => sessions.refresh(token));

/** The AppError code a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error("the promise resolved");
}

/** Every row of family `sessionId` in `tenant`'s schema, oldest first. */
function familyRows(tenant: RequestTenant, sessionId: string): Promise<CustomerSessionRecord[]> {
  return tenantTx(tenantDb, tenant.schemaName, (trx) =>
    trx
      .selectFrom("customer_sessions")
      .selectAll()
      .where("family_id", "=", sessionId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute(),
  );
}

/**
 * How long and how often the concurrency tests poll for sessions that wait for a lock: the requests queue within
 * milliseconds; two polls of one test stay inside Vitest's 5 s test bound, so a lock that is never waited for fails
 * with the poll's message.
 */
const LOCK_WAIT_POLL = { timeout: 2_000, interval: 20 };

/** How many sessions of this file's database wait for a lock right now (the row locks the tests hold). */
async function lockWaiters(): Promise<number> {
  const { rows } = await otaPool.query<{ waiting: number }>(
    "SELECT count(DISTINCT l.pid)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
      "WHERE NOT l.granted AND a.datname = current_database()",
  );
  return rows[0]?.waiting ?? -1;
}

/**
 * Runs `lock` in a transaction of `tenant` and keeps it open while `during` starts the work that must queue behind
 * it; then commits, and awaits what `during` handed back. So the test, not the scheduler, decides how far each
 * concurrent request gets before the others.
 */
async function whileLocked<T>(
  tenant: RequestTenant,
  lock: (trx: TenantTransaction) => Promise<unknown>,
  during: () => Promise<() => Promise<T>>,
): Promise<T> {
  let finish: (() => Promise<T>) | undefined;
  await tenantTx(tenantDb, tenant.schemaName, async (trx) => {
    await lock(trx);
    finish = await during();
  });
  if (finish === undefined) {
    throw new Error("whileLocked: the work did not start");
  }
  return finish();
}

/** A TokenService of the API's key at `clock`: tokens the API accepts, issued at another time. */
function tokensAt(clock: FakeClock): TokenService {
  const config = { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>;
  return new TokenService(config, clock);
}

// Cloning the template and building the API's module graph (Nest, pools, Redis, the OTA document's validators) take
// several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own timeout,
// and the tests only make calls.
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
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  ({ tenant: alpha, apiKey: alphaKey } = await insertTenant("alpha"));
  ({ tenant: beta, apiKey: betaKey } = await insertTenant("beta"));
  api = await createTestApp({
    database: db,
    redis,
    imports: [IdentityModule, TenancyModule.forApi()],
    providers: [CookieWriter],
    controllers: [SessionProbe],
  });
  sessions = api.app.get(SessionsService);
  tenantContext = api.app.get(TenantContext);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

describe("refresh families", () => {
  it("revokes every session of the family when a rotated refresh token is presented again [OBE-031 AC2]", async () => {
    const customerId = await insertCustomer(alpha);
    const family = await start(alpha, customerId);
    const other = await start(alpha, customerId);
    const second = await refresh(alpha, family.refreshToken);
    const third = await refresh(alpha, second.refreshToken);

    expect(await rejection(refresh(alpha, family.refreshToken))).toBe("REFRESH_TOKEN_REUSED");

    // Committed before the answer: every generation of the family is revoked, the newest one included.
    const rows = await familyRows(alpha, family.sessionId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect([row.revoke_reason, row.revoked_at]).toEqual(["rotation_reuse", expect.any(Date)]);
    }
    expect(await rejection(refresh(alpha, third.refreshToken))).toBe("REFRESH_TOKEN_INVALID");
    // A second reuse is still reported; the customer's other session is untouched and keeps working.
    expect(await rejection(refresh(alpha, second.refreshToken))).toBe("REFRESH_TOKEN_REUSED");
    expect((await refresh(alpha, other.refreshToken)).sessionId).toBe(other.sessionId);
    expect(
      api.sink
        .records()
        .filter((line) => line["msg"] === "customer.refresh_token_reused")
        .map((line) => line["sessionId"]),
    ).toEqual([family.sessionId, family.sessionId]);
    expect(api.sink.text()).not.toContain(family.refreshToken);
  });

  it("rotates on every refresh within the family's fixed end, storing only hashes", async () => {
    const customerId = await insertCustomer(alpha);
    const family = await start(alpha, customerId, { userAgent: `Mozilla/5.0 ${"x".repeat(600)}` });
    const rotated = await refresh(alpha, family.refreshToken);

    expect(family.refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(rotated.refreshToken).not.toBe(family.refreshToken);
    expect([rotated.sessionId, rotated.customerId]).toEqual([family.sessionId, customerId]);
    expect(rotated.refreshTokenExpiresAt).toEqual(family.refreshTokenExpiresAt);
    const [first, next] = await familyRows(alpha, family.sessionId);
    expect(first?.id).toBe(family.sessionId);
    expect(first).toMatchObject({
      family_id: family.sessionId,
      replaced_by_id: next?.id,
      rotated_at: expect.any(Date),
      revoked_at: null,
      remember_me: false,
      ip_address: null,
      ip_country: "FR",
    });
    expect(first?.user_agent).toHaveLength(512);
    expect(next).toMatchObject({
      family_id: family.sessionId,
      rotated_at: null,
      user_agent: first?.user_agent,
    });
    for (const row of [first, next]) {
      expect(row?.expires_at).toEqual(family.refreshTokenExpiresAt);
      expect(row?.family_expires_at).toEqual(family.refreshTokenExpiresAt);
      expect(row?.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(family.refreshToken.slice(3));
      expect(JSON.stringify(row)).not.toContain(rotated.refreshToken.slice(3));
    }
  });

  it("ends a family 12 hours after the sign-in, or 30 days with rememberMe, whatever the refreshes", async () => {
    const customerId = await insertCustomer(alpha);
    const clock = api.app.get(Clock);
    const signIn = new Date("2026-10-18T09:00:00.000Z");
    const now = vi.spyOn(clock, "now").mockReturnValue(signIn);
    const short = await start(alpha, customerId);
    const long = await start(alpha, customerId, { rememberMe: true });

    expect(short.refreshTokenExpiresAt.getTime() - signIn.getTime()).toBe(SESSION_TTL_MS);
    expect(long.refreshTokenExpiresAt.getTime() - signIn.getTime()).toBe(REMEMBER_ME_SESSION_TTL_MS);
    now.mockReturnValue(new Date(signIn.getTime() + SESSION_TTL_MS - 1000));
    const late = await refresh(alpha, short.refreshToken);
    expect(late.refreshTokenExpiresAt).toEqual(short.refreshTokenExpiresAt);
    now.mockReturnValue(new Date(signIn.getTime() + SESSION_TTL_MS));
    expect(await rejection(refresh(alpha, late.refreshToken))).toBe("REFRESH_TOKEN_INVALID");
    expect((await refresh(alpha, long.refreshToken)).rememberMe).toBe(true);
  });

  it("lets one of two concurrent refreshes with the same token win; the other is a reuse", async () => {
    const customerId = await insertCustomer(alpha);
    const family = await start(alpha, customerId);

    // Both refreshes read the unrotated row, then queue on the customer's lock until both wait: only the locks they
    // take after that read can tell them apart (without them, both would rotate).
    const results = await whileLocked(
      alpha,
      (trx) => trx.selectFrom("customers").select("id").where("id", "=", customerId).forUpdate().execute(),
      async () => {
        const refreshes = Promise.allSettled([
          refresh(alpha, family.refreshToken),
          refresh(alpha, family.refreshToken),
        ]);
        await expect.poll(lockWaiters, LOCK_WAIT_POLL).toBe(2);
        return () => refreshes;
      },
    );

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const failed = results.find((result) => result.status === "rejected");
    expect(isAppError(failed?.reason) ? failed.reason.code : failed?.reason).toBe("REFRESH_TOKEN_REUSED");
    const rows = await familyRows(alpha, family.sessionId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.revoke_reason).toBe("rotation_reuse");
    }
  });

  it("revokes the generation a concurrent rotation writes when every session of the customer is revoked", async () => {
    const customerId = await insertCustomer(alpha);
    const family = await start(alpha, customerId);
    const tx = api.app.get(TenantTx);

    // The refresh takes the customer's lock and waits for the family's first row; the revocation of every session (a
    // password change) then waits for the customer's lock, and runs only once the rotation has committed.
    const [rotation, revoked] = await whileLocked(
      alpha,
      (trx) =>
        trx
          .selectFrom("customer_sessions")
          .select("id")
          .where("id", "=", family.sessionId)
          .forUpdate()
          .execute(),
      async () => {
        const refreshing = refresh(alpha, family.refreshToken);
        // Should a poll fail, the outcome is reported by the assertion, not as an unhandled rejection.
        void refreshing.catch(() => undefined);
        await expect.poll(lockWaiters, LOCK_WAIT_POLL).toBe(1);
        const revoking = inTenant(alpha, () =>
          tx.run((trx) => sessions.revokeAllOfCustomer(trx, customerId, "password_change")),
        );
        void revoking.catch(() => undefined);
        await expect.poll(lockWaiters, LOCK_WAIT_POLL).toBe(2);
        return () => Promise.all([refreshing, revoking]);
      },
    );

    expect(revoked).toBe(1);
    const rows = await familyRows(alpha, family.sessionId);
    expect(rows.map((row) => row.revoke_reason)).toEqual(["password_change", "password_change"]);
    expect(await rejection(refresh(alpha, rotation.refreshToken))).toBe("REFRESH_TOKEN_INVALID");
  });

  it("refuses unknown and malformed tokens, a token of another tenant, and a disabled customer's", async () => {
    const customerId = await insertCustomer(alpha);
    const family = await start(alpha, customerId);
    const disabledId = await insertCustomer(alpha, "disabled");
    const disabled = await start(alpha, disabledId);

    for (const token of [`rt_${"A".repeat(43)}`, "rt_short", "not-a-token", `${family.refreshToken} `]) {
      expect([token.slice(0, 8), await rejection(refresh(alpha, token))]).toEqual([
        token.slice(0, 8),
        "REFRESH_TOKEN_INVALID",
      ]);
    }
    // Tenant isolation: beta's schema has no such row, and nothing of alpha's changes.
    expect(await rejection(refresh(beta, family.refreshToken))).toBe("REFRESH_TOKEN_INVALID");
    expect(await rejection(refresh(alpha, disabled.refreshToken))).toBe("REFRESH_TOKEN_INVALID");
    const [row] = await familyRows(alpha, family.sessionId);
    expect([row?.rotated_at, row?.revoked_at]).toEqual([null, null]);
    expect((await refresh(alpha, family.refreshToken)).sessionId).toBe(family.sessionId);
  });

  it("revokes one family of its own customer, or every family but the current one", async () => {
    const customerId = await insertCustomer(alpha);
    const strangerId = await insertCustomer(alpha);
    const [current, laptop, phone] = [
      await start(alpha, customerId),
      await start(alpha, customerId),
      await start(alpha, customerId),
    ];
    const tx = api.app.get(TenantTx);

    const strangers = await inTenant(alpha, () =>
      tx.run((trx) => sessions.revokeFamily(trx, strangerId, laptop.sessionId, "logout")),
    );
    const own = await inTenant(alpha, () =>
      tx.run((trx) => sessions.revokeFamily(trx, customerId, laptop.sessionId, "logout")),
    );
    const others = await inTenant(alpha, () =>
      tx.run((trx) => sessions.revokeAllOfCustomer(trx, customerId, "password_change", current.sessionId)),
    );

    expect([strangers, own, others]).toEqual([false, true, 1]);
    expect((await familyRows(alpha, laptop.sessionId))[0]?.revoke_reason).toBe("logout");
    expect((await familyRows(alpha, phone.sessionId))[0]?.revoke_reason).toBe("password_change");
    expect((await familyRows(alpha, current.sessionId))[0]?.revoked_at).toBeNull();
  });
});

describe("the customer guard", () => {
  it("answers 401 to a token of tenant A presented at tenant B, by key and by edge [OBE-031 AC1] [OF-01 AC2]", async () => {
    const customerId = await insertCustomer(alpha);
    const tokens = await inTenant(alpha, async () => sessions.tokensFor(await start(alpha, customerId)));

    const atBetaByKey = await request(api.server)
      .get("/__identity/session")
      .set({ "X-Api-Key": betaKey, Authorization: `Bearer ${tokens.accessToken}` });
    const atBetaByEdge = await request(api.server)
      .get("/__identity/session")
      .set({ ...edgeHeaders(BETA_HOST), Cookie: `__Host-vx_at=${tokens.accessToken}` });
    const atAlpha = await request(api.server)
      .get("/__identity/session")
      .set({ "X-Api-Key": alphaKey, Authorization: `Bearer ${tokens.accessToken}` });

    expect([atBetaByKey.status, atBetaByKey.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
    expect([atBetaByEdge.status, atBetaByEdge.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
    expect([atAlpha.status, atAlpha.body]).toEqual([
      200,
      {
        customer: { customerId, sessionId: tokens.sessionId },
        actor: { type: "customer", id: customerId },
      },
    ]);
    const refused = api.sink.records().filter((line) => line["msg"] === "customer.token_refused");
    expect(refused.map((line) => line["reason"])).toEqual(["other_tenant", "other_tenant"]);
    expect(api.sink.text()).not.toContain(tokens.accessToken);
  });

  it("answers 401 TOKEN_EXPIRED to an expired token and 401 UNAUTHENTICATED without one", async () => {
    const customerId = await insertCustomer(alpha);
    const issued = await start(alpha, customerId);
    const old = await tokensAt(new FakeClock(Date.now() - 20 * 60 * 1000)).signCustomerToken({
      sub: customerId,
      tid: alpha.tenantId,
      sid: issued.sessionId,
    });

    const expired = await request(api.server)
      .get("/__identity/session")
      .set({ ...edgeHeaders(ALPHA_HOST), Cookie: `__Host-vx_at=${old.token}` });
    const missing = await request(api.server).get("/__identity/session").set(edgeHeaders(ALPHA_HOST));

    expect([expired.status, expired.body.error.code]).toEqual([401, "TOKEN_EXPIRED"]);
    expect([missing.status, missing.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
  });
});

describe("the session cookies", () => {
  it("carry __Host-, Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain in edge mode, with no token in the body [OBE-031 AC3]", async () => {
    nextCustomer = await insertCustomer(alpha);

    const res = await request(api.server).get("/__identity/open").set(edgeHeaders(ALPHA_HOST));

    expect([res.status, res.body]).toEqual([200, { session: null }]);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.map((cookie) => cookie.split("=", 1)[0])).toEqual([
      "__Host-vx_at",
      "__Host-vx_rt",
      "__Host-vx_csrf",
    ]);
    for (const cookie of cookies) {
      const attributes = cookie.split("; ").slice(1);
      expect(attributes).toEqual(expect.arrayContaining(["Path=/", "Secure", "SameSite=Lax"]));
      expect(cookie).not.toMatch(/domain/i);
    }
    const [access = "", refreshCookie = "", csrf = ""] = cookies;
    expect(access).toMatch(
      /^__Host-vx_at=[\w-]+\.[\w-]+\.[\w-]+; Max-Age=900; Path=\/; Secure; SameSite=Lax; HttpOnly$/,
    );
    expect(refreshCookie).toMatch(
      /^__Host-vx_rt=rt_[\w-]{43}; Max-Age=\d+; Path=\/; Secure; SameSite=Lax; HttpOnly$/,
    );
    // What remains of the 12-hour family: the request's own time between opening the family and writing the cookie
    // comes off (a busy runner may take seconds; the exact arithmetic is cookie-writer.test.ts's).
    const refreshMaxAge = Number(/Max-Age=(\d+)/.exec(refreshCookie)?.[1]);
    expect(refreshMaxAge).toBeLessThanOrEqual(SESSION_TTL_MS / 1000);
    expect(refreshMaxAge).toBeGreaterThan(SESSION_TTL_MS / 1000 - 60);
    expect(csrf).toMatch(/^__Host-vx_csrf=[\w-]{43}; Max-Age=2592000; Path=\/; Secure; SameSite=Lax$/);

    // The access cookie is the edge's customer credential.
    const accessToken = access.slice("__Host-vx_at=".length, access.indexOf(";"));
    const me = await request(api.server)
      .get("/__identity/session")
      .set({ ...edgeHeaders(ALPHA_HOST), Cookie: `__Host-vx_at=${accessToken}` });
    expect([me.status, me.body.actor]).toEqual([200, { type: "customer", id: nextCustomer }]);
  });

  it("are never sent to a key caller, which gets the tokens in the body [OBE-031 AC3]", async () => {
    nextCustomer = await insertCustomer(beta);

    const res = await request(api.server).get("/__identity/open").set({ "X-Api-Key": betaKey });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    const body = res.body as { session: { accessToken: string; refreshToken: string } };
    expect(body.session.refreshToken).toMatch(/^rt_/);
    const me = await request(api.server)
      .get("/__identity/session")
      .set({ "X-Api-Key": betaKey, Authorization: `Bearer ${body.session.accessToken}` });
    expect([me.status, me.headers["set-cookie"], me.body.actor]).toEqual([
      200,
      undefined,
      { type: "customer", id: nextCustomer },
    ]);
  });
});
