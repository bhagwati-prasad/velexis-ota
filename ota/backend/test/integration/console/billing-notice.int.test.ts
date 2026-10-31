// `tenant.billingNotice` of the console session (OBE-082; ota/docs/api-changes-console-and-internal.md §3.1, ADR-0013
// point 7, platform/docs/flows/subscription-billing.md §E and §G, platform/docs/architecture.md §6.2) through the
// API's whole pipeline, against PostgreSQL 16 and Redis 7.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: alpha `active` in `test`, beta `active` and live, an owner of alpha and an agent of beta. The
// OTA admin's service key (OTA_ADMIN_SERVICE_KEY, OBE-060) signs them in with portal tokens stored as the platform's
// createConsoleToken stores them (PADR-0007), from an end-user IP of each staff member's own. The test plays the
// platform's billing sync: it sets `platform.tenants.billing_notice` as velexis_migrator (the OTA backend never writes a
// platform table, ADR-0003) with `version + 1`, as tenants.repository.ts `setBillingNotice` does, and publishes the
// `tenant` invalidation on `vx:invalidate` after the commit. console.auth.me and console.auth.refresh read the tenant
// row through the 60 s cache (`tenant:<id>`), so until the event the cached row still serves; the acceptance bound is
// one second from the event to an answer with the new notice. The sign-in reads the row past the cache.
//
// Each test has a tenant of its own, so neither sees the other's notice. Every answer is checked against the OTA
// document. Tokens and names are made up per run; no value is a secret.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { sha256Hex } from "@velexis/crypto";
import { createPlatformDb, createPool, sql, type Kysely, type PlatformDatabase } from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Environment = "test" | "live";
type Role = "owner" | "agent";
type Notice = "past_due" | "trial_ending" | null;

/** The acceptance bound: an answer with the new notice within one second of the `tenant` invalidation. */
const REFRESH_BOUND = { timeout: 1000, interval: 20 } as const;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let alphaId: string;
let betaId: string;

/** A portal account and its membership in one tenant. */
interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly tenantId: string;
  readonly role: Role;
}

/** Inserts an active tenant of a provisioned test schema, with no billing notice (as provisioning leaves it). */
async function insertTenant(key: "alpha" | "beta", live: boolean): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id,
      key,
      name: `${key} Travel`,
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/Madrid",
      storefront_environment: live ? "live" : "test",
      live_enabled_at: live ? new Date() : null,
    })
    .execute();
  return id;
}

/** Inserts an active account with MFA and its active membership with `role` in `tenantId`. */
async function insertMember(tenantId: string, role: Role): Promise<Member> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: `billing.${randomBytes(4).toString("hex")}@example.com`,
      full_name: "Maria Lopez",
      status: "active",
      email_verified_at: new Date(),
      locale: "en-GB",
      time_zone: "Europe/Paris",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, tenantId, role };
}

/** The platform's billing sync on the tenant row (tenants.repository.ts `setBillingNotice`), without the event. */
async function setBillingNotice(tenantId: string, notice: Notice): Promise<void> {
  const result = await migrator
    .updateTable("platform.tenants")
    .set({ billing_notice: notice, version: sql<number>`version + 1`, updated_at: new Date() })
    .where("id", "=", tenantId)
    .executeTakeFirst();
  expect(Number(result.numUpdatedRows)).toBe(1);
}

/** Publishes the `tenant` invalidation on `vx:invalidate`, as the platform does after its commit. */
async function publishTenantInvalidation(tenantId: string): Promise<void> {
  const event: InvalidationEvent = { v: 1, type: "tenant", id: tenantId };
  await redis.client.publish(INVALIDATION_CHANNEL, JSON.stringify(event));
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stores a portal token for `member` as the platform's createConsoleToken does (PADR-0007; MFA for live tenants). */
async function portalTokenFor(member: Member): Promise<string> {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: member.tenantId,
    membershipId: member.staffId,
    role: member.role,
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 60, "NX")).toBe(
    "OK",
  );
  return token;
}

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** `tenant.billingNotice` of an answer, or `"missing"` when the field is left out. */
function noticeOf(res: Response): unknown {
  const tenant = (res.body as { tenant?: Record<string, unknown> }).tenant ?? {};
  return "billingNotice" in tenant ? tenant["billingNotice"] : "missing";
}

let staffCount = 0;

/** A staff member signed in through the OTA admin: its service key, the staff member's IP and user agent. */
class Staff {
  private readonly ip: string;
  private accessToken = "";
  private refreshToken = "";

  constructor(readonly member: Member) {
    staffCount += 1;
    this.ip = `198.51.100.${staffCount}`;
  }

  private headers(environment: Environment): Record<string, string> {
    return {
      "X-Api-Key": testApiCredentials().serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": "Mozilla/5.0 (billing notice test)",
      "X-Velexis-Environment": environment,
    };
  }

  /** console.auth.signIn with a new portal token, asking for `environment`; keeps the session's tokens. */
  async signIn(environment: Environment = "test"): Promise<Response> {
    const res = await request(api.server)
      .post("/v1/console/auth/sign-in")
      .set({ ...this.headers(environment), "Idempotency-Key": randomUUID() })
      .send({ grantType: "portal_token", portalToken: await portalTokenFor(this.member) });
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleSignIn", res);
    this.keep(res);
    return res;
  }

  /** console.auth.refresh with the current refresh token; keeps the rotated tokens. */
  async refresh(environment: Environment = "test"): Promise<Response> {
    const res = await request(api.server)
      .post("/v1/console/auth/refresh")
      .set({ ...this.headers(environment), "Idempotency-Key": randomUUID() })
      .send({ refreshToken: this.refreshToken });
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleRefreshSession", res);
    this.keep(res);
    return res;
  }

  /** console.auth.me in `environment` with the staff access token. */
  async me(environment: Environment = "test"): Promise<Response> {
    const res = await request(api.server)
      .get("/v1/console/auth/me")
      .set({ ...this.headers(environment), Authorization: `Bearer ${this.accessToken}` });
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetMe", res);
    return res;
  }

  private keep(res: Response): void {
    const session = (res.body as { session: { accessToken: string; refreshToken: string } }).session;
    this.accessToken = session.accessToken;
    this.refreshToken = session.refreshToken;
  }
}

// Cloning the template and building the API's module graph (Nest, pools, Redis, the OTA document's validators) take
// several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own budget, and
// the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of the three operations compile on their first check: here, not in a test.
  const checker = responseChecker("ota");
  for (const operationId of ["consoleSignIn", "consoleRefreshSession", "consoleGetMe"] as const) {
    checker.check(operationId, { status: 200, body: {} });
  }
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  [alphaId, betaId] = await Promise.all([insertTenant("alpha", false), insertTenant("beta", true)]);
  api = await createTestApp({ database: db, redis });
  // The first sign-in and me of a process open the pools' connections and warm the token code; done once here, so that
  // no test pays for it. The warm-up member is alpha's, and leaves alpha's notice alone.
  const warmUp = new Staff(await insertMember(alphaId, "owner"));
  await warmUp.signIn();
  await warmUp.me();
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await db?.drop();
});

describe("tenant.billingNotice in the console session", () => {
  it("[OBE-082 AC1] shows billing_notice = 'past_due', set on the platform row as migrator, in the next console.auth.me after the tenant invalidation", async () => {
    const owner = new Staff(await insertMember(alphaId, "owner"));
    // No notice yet: the field is there, `null`.
    expect(noticeOf(await owner.signIn())).toBeNull();
    expect(noticeOf(await owner.me())).toBeNull();
    // console.auth.me has the tenant row in the 60 s cache now, so nothing but the invalidation can end it in this test.
    expect(await redis.client.exists(redisKeys.tenant(alphaId).key)).toBe(1);

    await setBillingNotice(alphaId, "past_due");
    // Until the platform's event, the cached row still serves.
    expect(noticeOf(await owner.me())).toBeNull();

    await publishTenantInvalidation(alphaId);
    // The acceptance bound: the next console.auth.me after the subscriber dropped the row reports the notice.
    await vi.waitFor(async () => {
      expect(noticeOf(await owner.me())).toBe("past_due");
    }, REFRESH_BOUND);

    // The refreshed session and a new sign-in carry it too.
    expect(noticeOf(await owner.refresh())).toBe("past_due");
    expect(noticeOf(await new Staff(owner.member).signIn())).toBe("past_due");
  });

  it("[OBE-082 AC1] follows trial_ending and the cleared notice the same way, with the same value in both environments of a live tenant", async () => {
    const agent = new Staff(await insertMember(betaId, "agent"));
    const live = await agent.signIn("live");
    expect([(live.body as { environments: string[] }).environments, noticeOf(live)]).toEqual([
      ["test", "live"],
      null,
    ]);
    expect(noticeOf(await agent.me("live"))).toBeNull();
    expect(await redis.client.exists(redisKeys.tenant(betaId).key)).toBe(1);

    // billing.manual_trials, 14 days before the trial ends (flows §G).
    await setBillingNotice(betaId, "trial_ending");
    // The sign-in reads the tenant row past the cache: it is never behind the cached row.
    expect(noticeOf(await new Staff(agent.member).signIn("live"))).toBe("trial_ending");
    expect(noticeOf(await agent.me("live"))).toBeNull();
    await publishTenantInvalidation(betaId);
    await vi.waitFor(async () => {
      expect(noticeOf(await agent.me("live"))).toBe("trial_ending");
    }, REFRESH_BOUND);
    // The column is per tenant: the test console of the same OTA shows the same notice.
    const inTest = await agent.me("test");
    expect([
      (inTest.body as { tenant: { environment: string } }).tenant.environment,
      noticeOf(inTest),
    ]).toEqual(["test", "trial_ending"]);

    // A paid subscription (`trialing` or `active`) clears it (flows §E): the banner goes with the next event.
    await setBillingNotice(betaId, null);
    await publishTenantInvalidation(betaId);
    await vi.waitFor(async () => {
      expect(noticeOf(await agent.me("live"))).toBeNull();
    }, REFRESH_BOUND);
    expect(noticeOf(await agent.me("test"))).toBeNull();
    expect(noticeOf(await agent.refresh("live"))).toBeNull();
  });
});
