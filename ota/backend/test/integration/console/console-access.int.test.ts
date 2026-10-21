// Console access through the API's whole pipeline (OBE-060; OADR-0009 rule 1.2 and point 8, OADR-0011 points 4 to 9,
// flows/console-operations.md §6), against PostgreSQL 16 and Redis 7: the OTA admin's service key (a direct loopback
// connection only, console operations only, a staff token, X-Velexis-Environment and the staff member's forwarded IP
// and user agent), the role matrix and the live environment, and the staff_actions rows of console calls and of
// denied attempts. The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned), writes the
// platform rows as the platform does (alpha in test, beta live; accounts and memberships of every role; a secret key
// scoped `console` and one scoped `console:automation`), stores portal tokens as the platform's createConsoleToken
// does, and starts the API in-process with probe routes bound to console operations that have no handler yet (their
// guards are the pipeline's; their 501 routes skip the guards). Supertest connects from 127.0.0.1 without
// X-Forwarded-For: the OTA admin's direct connection. Each admin client forwards an end-user IP address of its own, so
// the sign-in limit of 10 per minute per IP never mixes the tests. Tokens and names are made up per run.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { Controller, Get, Param, Post } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Clock } from "../../../src/common/clock";
import { OpenApiOperation } from "../../../src/common/http/openapi-operation.decorator";
import { trackerDigest } from "../../../src/common/http/rate-limits";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import type { ApiConfig } from "../../../src/config";
import { StaffActionsWriter } from "../../../src/console/staff-actions.writer";
import { StaffTokens } from "../../../src/identity/staff/staff-sessions";
import { CallerResolver } from "../../../src/tenancy/caller-resolver";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeHeaders, newApiKey, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Role = "owner" | "admin" | "agent" | "finance" | "viewer";
type Environment = "test" | "live";

/** A passport number of the probe's audited read: made up per run, never stored in full. */
const PASSPORT = `X${randomInt(10_000_000, 99_999_999)}`;
/** A token-shaped value the probe puts into its before and after: never stored. */
const PROBE_TOKEN = `eyJ${randomBytes(24).toString("base64url")}`;

/**
 * Routes bound to console operations that have no handler yet (OBE-061 onwards), so the whole guard pipeline runs on
 * them: list bookings (`bookings:read`), create a markup rule (`settings:write`), and get a booking, whose handler
 * audits the read itself with a before and after that carry a document number and a token.
 */
@Controller("__console")
class ConsoleProbe {
  constructor(private readonly writer: StaffActionsWriter) {}

  @Get("bookings")
  @OpenApiOperation("consoleListBookings")
  list(): { data: unknown[] } {
    return { data: [] };
  }

  @Post("settings/markup-rules")
  @OpenApiOperation("consoleCreateMarkupRule")
  createMarkupRule(): { created: boolean } {
    return { created: true };
  }

  @Get("bookings/:bookingId")
  @OpenApiOperation("consoleGetBooking")
  async getBooking(@Param("bookingId") bookingId: string): Promise<{ id: string }> {
    const traveller = {
      name: { firstName: "ANNA", lastName: "BERG" },
      documents: [{ documentType: "PASSPORT", number: PASSPORT, issuanceCountry: "ES" }],
    };
    await this.writer.recordAlone({
      action: "booking.retrieve",
      targetType: "booking",
      targetId: bookingId,
      before: { travelers: [traveller], session: { accessToken: PROBE_TOKEN } },
      after: { travelers: [traveller], bookingToken: PROBE_TOKEN },
    });
    return { id: bookingId };
  }
}

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let betaId: string;
/** alpha's secret key scoped `console`: a custom console with staff tokens. */
let alphaConsoleKey: string;
let alphaConsoleKeyId: string;
/** alpha's secret key scoped `console:automation` with `bookings:read` only. */
let alphaAutomationKey: string;
let alphaAutomationKeyId: string;

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one end user. */
const newIp = (): string => {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
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

/** Inserts an active tenant of a provisioned test schema. */
async function insertTenant(key: "alpha" | "beta", live: boolean): Promise<string> {
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
  return tenantId;
}

/** Issues a secret test key of `tenantId` with `scopes`, as the platform does. */
async function issueKey(tenantId: string, scopes: string[]): Promise<{ key: string; id: string }> {
  const key = newApiKey("sk");
  const id = newId("key");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id,
      tenant_id: tenantId,
      name: `Console (${scopes.join(", ")})`,
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      scopes,
    })
    .execute();
  return { key, id };
}

/** A portal account and its membership in one tenant. */
interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: Role;
}

/** Inserts an active account with MFA and its membership with `role` in `tenantId`. */
async function insertMember(tenantId: string, role: Role): Promise<Member> {
  const email = `staff.${randomBytes(4).toString("hex")}@example.com`;
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email,
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
  return { accountId, staffId, tenantId, email, role };
}

/** Stores a portal token for `member` as the platform's API does. */
async function portalTokenFor(member: Member): Promise<string> {
  const token = newPortalToken();
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

/** The OTA admin's server for one staff member: the service key, the staff member's IP and user agent. */
class AdminServer {
  readonly ip = newIp();
  readonly userAgent = `Mozilla/5.0 (OTA admin test ${randomBytes(3).toString("hex")})`;

  constructor(readonly environment: Environment = "test") {}

  headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      "X-Api-Key": testApiCredentials().serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": this.userAgent,
      "X-Velexis-Environment": this.environment,
      ...extra,
    };
  }

  /** A POST with a new Idempotency-Key and, when given, the staff access token. */
  post(path: string, body: unknown, accessToken?: string, extra: Readonly<Record<string, string>> = {}) {
    const req = request(api.server)
      .post(path)
      .set(this.headers({ "Idempotency-Key": randomUUID(), ...extra }))
      .send(body as object);
    return accessToken === undefined ? req : req.set("Authorization", `Bearer ${accessToken}`);
  }

  get(path: string, accessToken?: string, extra: Readonly<Record<string, string>> = {}) {
    const req = request(api.server).get(path).set(this.headers(extra));
    return accessToken === undefined ? req : req.set("Authorization", `Bearer ${accessToken}`);
  }

  signIn(portalToken: string, extra: Readonly<Record<string, string>> = {}) {
    return this.post(
      "/v1/console/auth/sign-in",
      { grantType: "portal_token", portalToken },
      undefined,
      extra,
    );
  }

  me(accessToken?: string, extra: Readonly<Record<string, string>> = {}) {
    return this.get("/v1/console/auth/me", accessToken, extra);
  }
}

/** A staff member signed in through the OTA admin. */
interface SignedIn {
  readonly admin: AdminServer;
  readonly member: Member;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly familyId: string;
  readonly body: Record<string, unknown>;
}

/** Signs `member` in through a new admin client (in `environment`); fails the test unless it answers 200. */
async function signIn(member: Member, environment: Environment = "test"): Promise<SignedIn> {
  const admin = new AdminServer(environment);
  const res = await admin.signIn(await portalTokenFor(member));
  expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
  const session = res.body.session as { accessToken: string; refreshToken: string };
  const [, payload = ""] = session.accessToken.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sid: string };
  return {
    admin,
    member,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    familyId: claims.sid,
    body: res.body as Record<string, unknown>,
  };
}

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** The staff_actions rows of `schema` that `where` selects, oldest first. */
async function staffActions(
  schema: "tenant_alpha" | "tenant_beta",
  where: { staffId?: string; actorId?: string },
): Promise<Array<Record<string, unknown>>> {
  return tenantTx(tenantDb, schema as TenantSchema, (trx) => {
    let query = trx.selectFrom("staff_actions").selectAll().orderBy("created_at").orderBy("id");
    if (where.staffId !== undefined) {
      query = query.where("staff_id", "=", where.staffId);
    }
    if (where.actorId !== undefined) {
      query = query.where("actor_id", "=", where.actorId);
    }
    return query.execute() as Promise<Array<Record<string, unknown>>>;
  });
}

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
  alphaId = await insertTenant("alpha", false);
  betaId = await insertTenant("beta", true);
  ({ key: alphaConsoleKey, id: alphaConsoleKeyId } = await issueKey(alphaId, ["console"]));
  ({ key: alphaAutomationKey, id: alphaAutomationKeyId } = await issueKey(alphaId, [
    "console:automation",
    "bookings:read",
  ]));
  api = await createTestApp({ database: db, redis, controllers: [ConsoleProbe] });
  // The first sign-in, me and audited call of a process open the pools' connections and warm the token and validation
  // code; done once here, so that no test pays for it.
  const warmUp = await signIn(await insertMember(alphaId, "owner"));
  expect((await warmUp.admin.me(warmUp.accessToken)).status).toBe(200);
  expect((await warmUp.admin.get("/__console/bookings", warmUp.accessToken)).status).toBe(200);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

describe("the OTA admin's service key", () => {
  it("is refused with an X-Forwarded-For or X-Forwarded-Host header, as Caddy sends them, and logged without its value [OBE-060 AC1]", async () => {
    const signedIn = await signIn(await insertMember(alphaId, "agent"));
    const admin = signedIn.admin;

    const answers = [
      await admin.me(signedIn.accessToken, { "X-Forwarded-For": "203.0.113.50" }),
      await admin.me(signedIn.accessToken, { "X-Forwarded-Host": "api.ota.example.com" }),
      await admin.signIn(newPortalToken(), { "X-Forwarded-For": "203.0.113.50" }),
    ];
    // Through a storefront's /api/*, Caddy adds its edge credential too: an ambiguous request.
    const throughStorefront = await admin.me(signedIn.accessToken, {
      ...edgeHeaders(),
      "X-Forwarded-For": "203.0.113.50",
    });

    for (const res of answers) {
      expect(answer(res)).toEqual([401, "INVALID_API_KEY"]);
    }
    expectResponseToMatch("consoleGetMe", answers[0] as Response);
    expect(answer(throughStorefront)).toEqual([400, "INVALID_REQUEST"]);
    const events = api.sink
      .records()
      .filter((line) => line["securityEvent"] === "caller.service_key_not_direct");
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((line) => line["reason"] === "forwarded")).toBe(true);
    expect(api.sink.text()).not.toContain(testApiCredentials().serviceKey);
    // The same staff member through the direct connection is served.
    expect((await admin.me(signedIn.accessToken)).status).toBe(200);
  });

  it("is the service caller only from a loopback socket peer, whatever the headers say [OBE-060 AC1]", async () => {
    const resolver = api.app.get(CallerResolver);
    const headers = { "x-api-key": testApiCredentials().serviceKey };

    await expect(resolver.resolve({ headers, remoteAddress: "127.0.0.1" }, "authenticated")).resolves.toEqual(
      {
        type: "service",
        id: "service",
      },
    );
    await expect(
      resolver.resolve({ headers, remoteAddress: "::ffff:127.0.0.1" }, "authenticated"),
    ).resolves.toMatchObject({ type: "service" });
    for (const remoteAddress of ["192.0.2.10", "10.0.0.5", "2001:db8::10", undefined]) {
      await expect(resolver.resolve({ headers, remoteAddress }, "authenticated")).rejects.toMatchObject({
        code: "INVALID_API_KEY",
        status: 401,
      });
    }
    expect(
      api.sink
        .records()
        .filter(
          (line) =>
            line["securityEvent"] === "caller.service_key_not_direct" && line["reason"] === "not_loopback",
        ).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("is refused on a customer operation and on console operations without a staff token [OBE-060 AC1]", async () => {
    const admin = new AdminServer();

    const customer = await admin.get("/v1/reference/airlines");
    const withoutToken = [await admin.me(), await admin.get("/__console/bookings")];
    const notAToken = await admin.get("/__console/bookings", "not-a-staff-token");
    const customerToken = await admin.get("/__console/bookings", `${PROBE_TOKEN}.x.y`);

    expect(answer(customer)).toEqual([403, "SCOPE_NOT_ALLOWED"]);
    expect(customer.body.error.details).toEqual({ reason: "service_console_only" });
    expectResponseToMatch("listAirlines", customer);
    for (const res of [...withoutToken, notAToken, customerToken]) {
      expect(answer(res)).toEqual([401, "UNAUTHENTICATED"]);
    }
    expectResponseToMatch("consoleGetMe", withoutToken[0] as Response);
  });

  it("needs X-Velexis-Environment and a valid X-Velexis-End-User-IP: 400 VALIDATION_FAILED without them", async () => {
    const signedIn = await signIn(await insertMember(alphaId, "agent"));
    const { admin, accessToken } = signedIn;
    const send = (headers: Record<string, string>) =>
      request(api.server)
        .get("/v1/console/auth/me")
        .set(headers)
        .set("Authorization", `Bearer ${accessToken}`);
    const { "X-Velexis-Environment": _environment, ...withoutEnvironment } = admin.headers();
    const { "X-Velexis-End-User-IP": _ip, ...withoutIp } = admin.headers();

    const answers = {
      withoutEnvironment: await send(withoutEnvironment),
      otherEnvironment: await send({ ...admin.headers(), "X-Velexis-Environment": "staging" }),
      withoutIp: await send(withoutIp),
      malformedIp: await send({ ...admin.headers(), "X-Velexis-End-User-IP": "203.0.113.999" }),
      twoIps: await send({ ...admin.headers(), "X-Velexis-End-User-IP": "203.0.113.1, 203.0.113.2" }),
    };

    for (const [name, res] of Object.entries(answers)) {
      expect([name, ...answer(res)]).toEqual([name, 400, "VALIDATION_FAILED"]);
      expectResponseToMatch("consoleGetMe", res);
    }
    expect(answers.withoutEnvironment.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/header/X-Velexis-Environment", code: "required" }),
    ]);
    expect(answers.withoutIp.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/header/X-Velexis-End-User-IP", code: "required" }),
    ]);
    expect(JSON.stringify(answers.malformedIp.body)).not.toContain("203.0.113.999");
  });

  it("refreshes and signs out with the tenant of the refresh token's family, and answers expired tokens 401 TOKEN_EXPIRED", async () => {
    const signedIn = await signIn(await insertMember(alphaId, "finance"));
    const { admin } = signedIn;
    const clock = new FakeClock(new Date(Date.now() - 20 * 60 * 1000));
    const expired = await new StaffTokens(
      api.app.get<ConfigService<ApiConfig, true>>(ConfigService),
      clock as unknown as Clock,
    ).sign({ sub: signedIn.member.staffId, tid: alphaId, sid: signedIn.familyId, role: "finance" });

    const refreshed = await admin.post("/v1/console/auth/refresh", { refreshToken: signedIn.refreshToken });
    const unknownRefresh = await admin.post("/v1/console/auth/refresh", {
      refreshToken: `srt_01JA2Z9W5K7Q3M8N4P6R2T0V1F${randomBytes(32).toString("base64url").slice(0, 43)}`,
    });
    const unknownPortalToken = await admin.signIn(newPortalToken());
    const passwordGrant = await admin.post("/v1/console/auth/sign-in", {
      grantType: "password",
      email: "maria.lopez@example.com",
      password: `pw-${randomBytes(6).toString("hex")}`,
    });
    const expiredMe = await admin.me(expired.token);

    expect(answer(refreshed)).toEqual([200, undefined]);
    expectResponseToMatch("consoleRefreshSession", refreshed);
    expect(answer(unknownRefresh)).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    expect(answer(unknownPortalToken)).toEqual([401, "PORTAL_TOKEN_INVALID"]);
    expect(answer(passwordGrant)).toEqual([403, "FEATURE_DISABLED"]);
    expect(answer(expiredMe)).toEqual([401, "TOKEN_EXPIRED"]);

    const rotated = refreshed.body.session as { accessToken: string; refreshToken: string };
    const unknownSignOut = await admin.post("/v1/console/auth/sign-out", {
      refreshToken: `srt_01JA2Z9W5K7Q3M8N4P6R2T0V1G${randomBytes(32).toString("base64url").slice(0, 43)}`,
    });
    const noCredential = await admin.post("/v1/console/auth/sign-out", {});
    const signedOut = await admin.post("/v1/console/auth/sign-out", { refreshToken: rotated.refreshToken });

    expect(unknownSignOut.status).toBe(204);
    expect(answer(noCredential)).toEqual([401, "UNAUTHENTICATED"]);
    expect(signedOut.status).toBe(204);
    expect(answer(await admin.me(rotated.accessToken))).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("counts the console calls of a staff member per staff session (600 per minute)", async () => {
    const signedIn = await signIn(await insertMember(alphaId, "agent"));
    const counter = `rl:ota_console:${trackerDigest("principal", `staff:${signedIn.familyId}`)}`;

    expect((await signedIn.admin.me(signedIn.accessToken)).status).toBe(200);
    expect((await signedIn.admin.get("/__console/bookings", signedIn.accessToken)).status).toBe(200);

    expect(await redis.client.get(counter)).toBe("2");
  });
});

describe("console.auth.signIn through the OTA admin", () => {
  it("counts sign-ins per forwarded end-user IP: the eleventh in a minute answers 429, another IP is served, and the rows carry the forwarded IP and user agent [OBE-060 AC2]", async () => {
    const member = await insertMember(alphaId, "agent");
    const admin = new AdminServer();
    const answers: Response[] = [];
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      answers.push(await admin.signIn(await portalTokenFor(member)));
    }
    const otherIp = new AdminServer();
    const other = await otherIp.signIn(await portalTokenFor(member));

    expect(answers.slice(0, 10).map(answer)).toEqual(Array.from({ length: 10 }, () => [200, undefined]));
    expect(answer(answers[10] as Response)).toEqual([429, "RATE_LIMITED"]);
    expect(answers[10]?.headers["retry-after"]).toMatch(/^\d+$/);
    expectResponseToMatch("consoleSignIn", answers[10] as Response);
    expect(answer(other)).toEqual([200, undefined]);
    expect(other.body.tenant).toMatchObject({ id: alphaId, environment: "test" });

    const rows = await staffActions("tenant_alpha", { staffId: member.staffId });
    expect(rows).toHaveLength(11);
    expect(rows.every((row) => row["action"] === "staff.sign_in" && row["outcome"] === "succeeded")).toBe(
      true,
    );
    expect(
      rows.filter((row) => row["ip_address"] === admin.ip && row["user_agent"] === admin.userAgent),
    ).toHaveLength(10);
    expect(rows.filter((row) => row["ip_address"] === otherIp.ip)).toHaveLength(1);
    expect(rows.some((row) => String(row["ip_address"]).includes("127.0.0.1"))).toBe(false);
  });

  it("opens a session of the portal token's tenant in the environment asked for, and lists the environments", async () => {
    const agent = await signIn(await insertMember(betaId, "agent"), "live");

    expect(agent.body["tenant"]).toMatchObject({ id: betaId, environment: "live" });
    expect(agent.body["environments"]).toEqual(["test", "live"]);
    const me = await agent.admin.me(agent.accessToken);
    expect(answer(me)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetMe", me);
    expect(me.body.tenant).toMatchObject({ id: betaId, environment: "live" });
  });
});

describe("environments and permissions", () => {
  it("answers a viewer asking for live with 403 ENVIRONMENT_NOT_ALLOWED and writes a denied row [OBE-060 AC3]", async () => {
    const viewer = await insertMember(betaId, "viewer");
    const liveAdmin = new AdminServer("live");

    const liveSignIn = await liveAdmin.signIn(await portalTokenFor(viewer));
    const session = await signIn(viewer, "test");
    const liveMe = await session.admin.me(session.accessToken, { "X-Velexis-Environment": "live" });
    const liveList = await session.admin.get("/__console/bookings", session.accessToken, {
      "X-Velexis-Environment": "live",
    });
    const testMe = await session.admin.me(session.accessToken);

    for (const res of [liveSignIn, liveMe, liveList]) {
      expect(answer(res)).toEqual([403, "ENVIRONMENT_NOT_ALLOWED"]);
      expect(res.body.error.details).toEqual({ environment: "live", environments: ["test"] });
    }
    expectResponseToMatch("consoleSignIn", liveSignIn);
    expectResponseToMatch("consoleGetMe", liveMe);
    expect(session.body["environments"]).toEqual(["test"]);
    expect(answer(testMe)).toEqual([200, undefined]);

    const rows = await staffActions("tenant_beta", { staffId: viewer.staffId });
    expect(rows.map((row) => [row["action"], row["outcome"]])).toEqual([
      ["staff.sign_in", "denied"],
      ["staff.sign_in", "succeeded"],
      ["auth.me", "denied"],
      ["bookings.list", "denied"],
    ]);
    // The refused sign-in opened no session.
    expect(rows[0]).toMatchObject({
      actor_type: "staff",
      staff_role: "viewer",
      target_type: null,
      target_id: null,
      ip_address: liveAdmin.ip,
      user_agent: liveAdmin.userAgent,
    });
    expect(rows[2]).toMatchObject({
      actor_type: "staff",
      staff_role: "viewer",
      ip_address: session.admin.ip,
      user_agent: session.admin.userAgent,
    });
  });

  it("refuses live on a tenant that is not live, for every role, writes a denied row and leaves the portal token unused", async () => {
    const member = await insertMember(alphaId, "owner");
    const portalToken = await portalTokenFor(member);
    const liveAdmin = new AdminServer("live");

    const liveSignIn = await liveAdmin.signIn(portalToken);
    // Refused before the sign-in took the token: the same token still opens a test session.
    const testSignIn = await new AdminServer().signIn(portalToken);
    const owner = await signIn(member);
    const res = await owner.admin.me(owner.accessToken, { "X-Velexis-Environment": "live" });

    for (const refused of [liveSignIn, res]) {
      expect(answer(refused)).toEqual([403, "ENVIRONMENT_NOT_ALLOWED"]);
      expect(refused.body.error.details).toEqual({ environment: "live", environments: ["test"] });
    }
    expect(answer(testSignIn)).toEqual([200, undefined]);
    expect(owner.body["environments"]).toEqual(["test"]);
    const rows = await staffActions("tenant_alpha", { staffId: member.staffId });
    expect(rows.map((row) => [row["action"], row["outcome"], row["staff_role"]])).toEqual([
      ["staff.sign_in", "succeeded", "owner"],
      ["staff.sign_in", "succeeded", "owner"],
      ["auth.me", "denied", "owner"],
    ]);
    expect(rows[2]).toMatchObject({ ip_address: owner.admin.ip, user_agent: owner.admin.userAgent });
  });

  it("answers an agent's settings write with 403 FORBIDDEN naming settings:write and writes a denied row [OBE-060 AC3]", async () => {
    const agent = await signIn(await insertMember(alphaId, "agent"));

    const res = await agent.admin.post("/__console/settings/markup-rules", {}, agent.accessToken);

    expect(answer(res)).toEqual([403, "FORBIDDEN"]);
    expect(res.body.error.details).toEqual({ requiredPermission: "settings:write" });
    expectResponseToMatch("consoleCreateMarkupRule", res);
    const rows = await staffActions("tenant_alpha", { staffId: agent.member.staffId });
    expect(rows.slice(1)).toEqual([
      expect.objectContaining({
        actor_type: "staff",
        actor_id: agent.member.staffId,
        account_id: agent.member.accountId,
        staff_email: agent.member.email,
        staff_role: "agent",
        action: "settings.markupRules.create",
        outcome: "denied",
        ip_address: agent.admin.ip,
        user_agent: agent.admin.userAgent,
        request_id: expect.any(String),
      }),
    ]);
  });

  it("gives a custom console's staff token the role's permissions and a key-only call the key's, audited as the key", async () => {
    const agent = await signIn(await insertMember(alphaId, "agent"));
    const custom = (path: string, key: string, accessToken?: string) => {
      const req = request(api.server)
        .post(path)
        .set({ "X-Api-Key": key, "X-Velexis-End-User-IP": "192.0.2.77", "Idempotency-Key": randomUUID() });
      return accessToken === undefined ? req : req.set("Authorization", `Bearer ${accessToken}`);
    };

    // A console key with an OTA admin session's token: the same staff member, the same role.
    const write = await custom("/__console/settings/markup-rules", alphaConsoleKey, agent.accessToken).send(
      {},
    );
    const read = await request(api.server)
      .get("/__console/bookings")
      .set({ "X-Api-Key": alphaConsoleKey, Authorization: `Bearer ${agent.accessToken}` });
    const environmentHeader = await request(api.server)
      .get("/__console/bookings")
      .set({
        "X-Api-Key": alphaConsoleKey,
        Authorization: `Bearer ${agent.accessToken}`,
        "X-Velexis-Environment": "test",
      });
    // The console key without a staff token: key-only calls need console:automation.
    const consoleKeyOnly = await request(api.server)
      .get("/__console/bookings")
      .set({ "X-Api-Key": alphaConsoleKey, "X-Velexis-End-User-IP": "192.0.2.78" });
    // console:automation with bookings:read only.
    const automationRead = await request(api.server)
      .get("/__console/bookings")
      .set("X-Api-Key", alphaAutomationKey);
    const automationWrite = await custom("/__console/settings/markup-rules", alphaAutomationKey).send({});

    expect(answer(write)).toEqual([403, "FORBIDDEN"]);
    expect(answer(read)).toEqual([200, undefined]);
    expect(answer(environmentHeader)).toEqual([400, "VALIDATION_FAILED"]);
    expect(answer(consoleKeyOnly)).toEqual([403, "SCOPE_NOT_ALLOWED"]);
    expect(consoleKeyOnly.body.error.details).toEqual({ requiredScope: "console:automation" });
    expectResponseToMatch("consoleListBookings", consoleKeyOnly);
    expect(answer(automationRead)).toEqual([200, undefined]);
    expect(answer(automationWrite)).toEqual([403, "FORBIDDEN"]);
    expect(automationWrite.body.error.details).toEqual({ requiredPermission: "settings:write" });

    const keyRows = await staffActions("tenant_alpha", { actorId: alphaAutomationKeyId });
    expect(keyRows.map((row) => [row["actor_type"], row["staff_id"], row["action"], row["outcome"]])).toEqual(
      [
        ["api_key", null, "bookings.list", "succeeded"],
        ["api_key", null, "settings.markupRules.create", "denied"],
      ],
    );
    expect(keyRows[1]?.["ip_address"]).toBe("192.0.2.77");
    const consoleKeyRows = await staffActions("tenant_alpha", { actorId: alphaConsoleKeyId });
    expect(
      consoleKeyRows.map((row) => [row["actor_type"], row["action"], row["outcome"], row["ip_address"]]),
    ).toEqual([["api_key", "bookings.list", "denied", "192.0.2.78"]]);
  });

  it("writes one succeeded row per console call of the staff member", async () => {
    const finance = await signIn(await insertMember(alphaId, "finance"));

    expect((await finance.admin.get("/__console/bookings", finance.accessToken)).status).toBe(200);
    expect((await finance.admin.me(finance.accessToken)).status).toBe(200);

    const rows = await staffActions("tenant_alpha", { staffId: finance.member.staffId });
    expect(rows.map((row) => [row["action"], row["outcome"], row["ip_address"]])).toEqual([
      ["staff.sign_in", "succeeded", finance.admin.ip],
      ["bookings.list", "succeeded", finance.admin.ip],
    ]);
  });
});

describe("staff_actions rows", () => {
  it("contain no token and no full document number [OBE-060 AC4]", async () => {
    const agent = await signIn(await insertMember(alphaId, "agent"));
    const bookingId = newId("bkg");

    const res = await agent.admin.get(`/__console/bookings/${bookingId}`, agent.accessToken);

    expect(answer(res)).toEqual([200, undefined]);
    const rows = await staffActions("tenant_alpha", { staffId: agent.member.staffId });
    // The use case audited the read itself: the pipeline adds no second row.
    expect(rows.map((row) => row["action"])).toEqual(["staff.sign_in", "booking.retrieve"]);
    expect(rows[1]).toMatchObject({ target_type: "booking", target_id: bookingId, outcome: "succeeded" });
    const after = rows[1]?.["after"] as { travelers: Array<{ documents: Array<{ number: string }> }> };
    expect(after.travelers[0]?.documents[0]?.number).toMatch(new RegExp(`${PASSPORT.slice(-4)}$`));
    const everything = JSON.stringify([
      ...(await staffActions("tenant_alpha", {})),
      ...(await staffActions("tenant_beta", {})),
    ]);
    for (const secret of [
      PASSPORT,
      PROBE_TOKEN,
      agent.accessToken,
      agent.refreshToken,
      testApiCredentials().serviceKey,
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(api.sink.text()).not.toContain(PASSPORT);
    expect(api.sink.text()).not.toContain(agent.accessToken);
  });
});
