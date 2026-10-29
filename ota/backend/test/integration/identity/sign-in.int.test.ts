// auth.signIn, auth.refresh, auth.signOut and auth.getSession through the API's whole pipeline (OBE-033;
// flows/my-bookings-and-guest-lookup.md §1, §3 steps 3, 6 and 7, §4 and §7; OADR-0006 points 1, 2, 4 and 5; ADR-0008
// "Lockout"), against PostgreSQL 16 and Redis 7, in both modes: the hosted storefront's edge (cookies, CSRF, no token in
// any body) and key callers (bearer tokens in the body, never a cookie). The file clones the @velexis/testing template
// (tenant_alpha and tenant_beta provisioned), writes the platform rows of two active tenants with a secret key each as
// the platform does, inserts customers with Argon2id password identities, and starts the API in-process. Every answer is
// checked against the OTA document (`expectResponseToMatch`). Each test signs in from IP addresses of its own
// (`X-Forwarded-For` through the trusted loopback proxy for the edge, `X-Velexis-End-User-IP` for the secret key), so the
// sign-in rate limit of 10 per minute per IP never mixes the tests. Passwords are made up per run; no value is a secret.
import { randomBytes, randomUUID } from "node:crypto";
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
import type { ConfigService } from "@nestjs/config";
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
import { newId } from "../../../src/common/ids";
import type { ApiConfig } from "../../../src/config";
import type { CustomerSessionRecord } from "../../../src/identity/sessions.repository";
import { hashCustomerPassword } from "../../../src/identity/sign-in.service";
import { TokenService } from "../../../src/identity/token.service";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeHeaders, newApiKey, newCsrfToken, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const ALPHA_HOST = "alpha.ota.example.com";

/** A password made up for this run, and its Argon2id hash (made once, below). */
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;
const WRONG = `${PASSWORD}-wrong`;
let passwordHash = "";

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

/** A new address for one test, so no test sees another's customer, lockout or sessions. */
const newAddress = (label: string): string => `${label}.${randomBytes(4).toString("hex")}@example.com`;

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one test's sign-ins. */
const newIp = (): string => {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
};

/** Inserts an active tenant of a provisioned test schema and a secret test key of it, as the platform does. */
async function insertTenant(key: "alpha" | "beta"): Promise<{ tenantId: string; apiKey: string }> {
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
  return { tenantId, apiKey };
}

/** Inserts a customer with a password identity for `email` into `schema`; its id. */
async function insertCustomer(
  schema: TenantSchema,
  email: string,
  status: "active" | "disabled" | "pending_verification" = "active",
): Promise<string> {
  const id = newId("cus");
  await tenantTx(tenantDb, schema, async (trx) => {
    await trx
      .insertInto("customers")
      .values({ id, email, status, first_name: "Anna", last_name: "Berg", email_verified_at: new Date() })
      .execute();
    await trx
      .insertInto("customer_identities")
      .values({
        id: newId("cid"),
        customer_id: id,
        provider: "password",
        provider_subject: email.toLowerCase(),
        password_hash: passwordHash,
        email,
      })
      .execute();
  });
  return id;
}

/** Every row of family `sessionId` in `schema`, oldest first. */
function familyRows(schema: TenantSchema, sessionId: string): Promise<CustomerSessionRecord[]> {
  return tenantTx(tenantDb, schema, (trx) =>
    trx
      .selectFrom("customer_sessions")
      .selectAll()
      .where("family_id", "=", sessionId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute(),
  );
}

/** A TokenService of the API's key at `clock`: tokens the API accepts, issued at another time. */
function tokensAt(clock: FakeClock): TokenService {
  const config = { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>;
  return new TokenService(config, clock);
}

/** A `Set-Cookie` header parsed: the value and the attributes as written. */
interface SetCookie {
  readonly value: string;
  readonly attributes: readonly string[];
}

/** The cookies an answer sets, by name. */
function setCookies(res: Response): Map<string, SetCookie> {
  const header = res.headers["set-cookie"] as unknown;
  const lines = Array.isArray(header) ? (header as string[]) : typeof header === "string" ? [header] : [];
  const cookies = new Map<string, SetCookie>();
  for (const line of lines) {
    const [pair = "", ...attributes] = line.split("; ");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), { value: pair.slice(index + 1), attributes });
  }
  return cookies;
}

/** The browser of one storefront visitor: the cookies the API set, sent back on every request. */
class Visitor {
  readonly jar = new Map<string, string>();
  readonly ip = newIp();

  constructor(readonly host = ALPHA_HOST) {
    this.jar.set("__Host-vx_csrf", newCsrfToken());
  }

  /** Keeps what an answer set: a cookie with `Max-Age=0` is removed, as a browser does. */
  remember(res: Response): void {
    for (const [name, cookie] of setCookies(res)) {
      if (cookie.attributes.includes("Max-Age=0")) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, cookie.value);
      }
    }
  }

  headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    const csrf = this.jar.get("__Host-vx_csrf") ?? "";
    return {
      ...edgeHeaders(this.host),
      Origin: `https://${this.host}`,
      "X-CSRF-Token": csrf,
      "X-Forwarded-For": this.ip,
      "User-Agent": "Mozilla/5.0 (storefront test)",
      Cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join("; "),
      ...extra,
    };
  }

  async post(path: string, body: unknown, idempotencyKey: string = randomUUID()): Promise<Response> {
    const res = await request(api.server)
      .post(path)
      .set(this.headers({ "Idempotency-Key": idempotencyKey }))
      .send(body as object);
    this.remember(res);
    return res;
  }

  async get(path: string): Promise<Response> {
    const res = await request(api.server).get(path).set(this.headers());
    this.remember(res);
    return res;
  }
}

/** A server of a third-party storefront with alpha's secret key, calling for one visitor. */
class KeyClient {
  readonly ip = newIp();

  constructor(readonly apiKey = alphaKey) {}

  headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      "X-Api-Key": this.apiKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": "Mozilla/5.0 (third-party storefront test)",
      ...extra,
    };
  }

  post(path: string, body: unknown, extra: Readonly<Record<string, string>> = {}): Promise<Response> {
    return request(api.server)
      .post(path)
      .set(this.headers({ "Idempotency-Key": randomUUID(), ...extra }))
      .send(body as object);
  }

  get(path: string, accessToken: string): Promise<Response> {
    return request(api.server)
      .get(path)
      .set(this.headers({ Authorization: `Bearer ${accessToken}` }));
  }
}

/** Every token-like field name of the contract's session shapes. */
const TOKEN_FIELDS = ["accessToken", "refreshToken", "tokenType"];

/** True when `body` (an answer's JSON) holds no token field and none of `values` anywhere. */
function holdsNoToken(body: unknown, values: readonly string[]): boolean {
  const text = JSON.stringify(body);
  return (
    TOKEN_FIELDS.every((field) => !text.includes(`"${field}"`)) &&
    values.every((value) => !text.includes(value))
  );
}

/** The session cookies' attributes as OADR-0006 point 2 and api-changes §2.3 write them. */
function expectStorefrontCookie(
  cookie: SetCookie | undefined,
  maxAge: number | "positive",
  httpOnly: boolean,
): void {
  expect(cookie).toBeDefined();
  const attributes = cookie?.attributes ?? [];
  const age = attributes.find((attribute) => attribute.startsWith("Max-Age="));
  if (maxAge === "positive") {
    expect(Number(age?.slice("Max-Age=".length))).toBeGreaterThan(0);
  } else {
    expect(age).toBe(`Max-Age=${maxAge}`);
  }
  expect(attributes).toEqual(expect.arrayContaining(["Path=/", "Secure", "SameSite=Lax"]));
  expect(attributes.includes("HttpOnly")).toBe(httpOnly);
  expect(attributes.some((attribute) => attribute.toLowerCase().startsWith("domain="))).toBe(false);
}

// Cloning the template, hashing the test password with Argon2id (19 MiB) and building the API's module graph (Nest,
// pools, Redis, the OTA document's validators) take several seconds alone and much longer on a busy 4-CPU runner: all
// of it happens once here, with its own timeout, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  [db, redis, passwordHash] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    hashCustomerPassword(PASSWORD),
  ]);
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
  ({ tenantId: alphaId, apiKey: alphaKey } = await insertTenant("alpha"));
  ({ tenantId: betaId, apiKey: betaKey } = await insertTenant("beta"));
  api = await createTestApp({ database: db, redis });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

describe("auth.signIn: the lockout", () => {
  it("locks the address at the fifth wrong password; the sixth attempt answers 423 even with the right one [OBE-033 AC1]", async () => {
    const email = newAddress("locked");
    await insertCustomer("tenant_alpha" as TenantSchema, email);
    const visitor = new Visitor();

    const wrong: Response[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      wrong.push(await visitor.post("/v1/auth/sign-in", { email, password: WRONG }));
    }
    const right = await visitor.post("/v1/auth/sign-in", { email, password: PASSWORD });

    expect(wrong.slice(0, 4).map((res) => [res.status, res.body.error.code, res.body.error.details])).toEqual(
      [4, 3, 2, 1].map((left) => [401, "INVALID_CREDENTIALS", { remainingAttempts: left }]),
    );
    for (const res of [wrong[4], right]) {
      expect([res?.status, res?.body.error.code]).toEqual([423, "ACCOUNT_LOCKED"]);
      expect(Number(res?.headers["retry-after"])).toBeGreaterThan(890);
      expect(Number(res?.headers["retry-after"])).toBeLessThanOrEqual(900);
      expect(Date.parse(res?.body.error.details.lockedUntil as string)).toBeGreaterThan(Date.now() + 880_000);
      expect(res?.headers["set-cookie"]).toBeUndefined();
      expectResponseToMatch("signIn", res as Response);
    }
    expectResponseToMatch("signIn", wrong[0] as Response);
    // The counter of architecture §7: tenant, environment and the digest of the address, living 15 minutes.
    const counter = `t:${alphaId}:test:authfail:${sha256Hex(email.toLowerCase())}`;
    expect(await redis.client.get(counter)).toBe("5");
    expect(await redis.client.ttl(counter)).toBeGreaterThan(890);
    expect((await redis.client.keys("*authfail*")).join(" ")).not.toContain(email);
  });

  it("never looks at more than five passwords of one address, however many arrive at once", async () => {
    const email = newAddress("burst");
    const customerId = await insertCustomer("tenant_alpha" as TenantSchema, email);
    const visitor = new Visitor();

    // Eight wrong passwords at once (under the IP's limit of 10 a minute): each attempt is counted before its
    // password is verified, so the sixth to eighth are refused without a verification, as the fifth locks.
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => visitor.post("/v1/auth/sign-in", { email, password: WRONG })),
    );

    const statuses = answers.map((res) => res.status).sort();
    expect(statuses).toEqual([401, 401, 401, 401, 423, 423, 423, 423]);
    const remaining = answers
      .filter((res) => res.status === 401)
      .map((res) => res.body.error.details.remainingAttempts as number)
      .sort();
    expect(remaining).toEqual([1, 2, 3, 4]);
    expect(await redis.client.get(`t:${alphaId}:test:authfail:${sha256Hex(email)}`)).toBe("5");
    const verified = api.sink
      .records()
      .filter((line) => line["msg"] === "customer.sign_in_failed" && line["customerId"] === customerId);
    expect(verified).toHaveLength(5);
  });

  it("counts per tenant: the same address at another tenant is neither locked nor a customer there", async () => {
    const email = newAddress("two-tenants");
    await insertCustomer("tenant_alpha" as TenantSchema, email);
    await insertCustomer("tenant_beta" as TenantSchema, email);
    const atAlpha = new Visitor();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await atAlpha.post("/v1/auth/sign-in", { email, password: WRONG });
    }
    const alphaOnly = newAddress("alpha-only");
    await insertCustomer("tenant_alpha" as TenantSchema, alphaOnly);

    const atBeta = await new KeyClient(betaKey).post("/v1/auth/sign-in", { email, password: PASSWORD });
    const strangerAtBeta = await new KeyClient(betaKey).post("/v1/auth/sign-in", {
      email: alphaOnly,
      password: PASSWORD,
    });

    expect(atBeta.status).toBe(200);
    expect(atBeta.body.session.subject.id).toMatch(/^cus_/);
    expect([strangerAtBeta.status, strangerAtBeta.body.error.code]).toEqual([401, "INVALID_CREDENTIALS"]);
    expect(await redis.client.exists(`t:${betaId}:test:authfail:${sha256Hex(email)}`)).toBe(0);
  });

  it("answers an unknown address, a wrong password and a disabled customer with the same body", async () => {
    const known = newAddress("known");
    const disabled = newAddress("disabled");
    await insertCustomer("tenant_alpha" as TenantSchema, known);
    await insertCustomer("tenant_alpha" as TenantSchema, disabled, "disabled");
    const client = new KeyClient();

    const answers = [
      await client.post("/v1/auth/sign-in", { email: newAddress("unknown"), password: PASSWORD }),
      await client.post("/v1/auth/sign-in", { email: known, password: WRONG }),
      await client.post("/v1/auth/sign-in", { email: disabled, password: PASSWORD }),
    ];

    const bodies = answers.map((res) => ({ ...res.body.error, requestId: undefined }));
    expect(answers.map((res) => res.status)).toEqual([401, 401, 401]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ code: "INVALID_CREDENTIALS", details: { remainingAttempts: 4 } });
  });

  it("answers 403 FEATURE_DISABLED while customer accounts are off for the storefront", async () => {
    const email = newAddress("feature");
    await insertCustomer("tenant_beta" as TenantSchema, email);
    // The template's schemas are migrated, not seeded: the settings row is written here as provisioning would.
    const setAccounts = (enabled: boolean) =>
      tenantTx(tenantDb, "tenant_beta" as TenantSchema, (trx) =>
        trx
          .insertInto("storefront_settings")
          .values({ brand_name: "beta Travel", customer_accounts_enabled: enabled })
          .onConflict((conflict) => conflict.column("id").doUpdateSet({ customer_accounts_enabled: enabled }))
          .execute(),
      );
    await setAccounts(false);
    try {
      const res = await new KeyClient(betaKey).post("/v1/auth/sign-in", { email, password: PASSWORD });

      expect([res.status, res.body.error.code, res.body.error.details]).toEqual([
        403,
        "FEATURE_DISABLED",
        { feature: "customerAccounts" },
      ]);
      expectResponseToMatch("signIn", res);
    } finally {
      await setAccounts(true);
    }
  });
});

describe("edge mode: cookies, never a token in a body", () => {
  it("signs in, reads the session, refreshes and signs out without a token in any body [OBE-033 AC2]", async () => {
    const email = newAddress("edge");
    const customerId = await insertCustomer("tenant_alpha" as TenantSchema, email);
    const visitor = new Visitor();
    const csrfBefore = visitor.jar.get("__Host-vx_csrf") ?? "";

    const signIn = await visitor.post("/v1/auth/sign-in", { email, password: PASSWORD, rememberMe: false });
    const signInCookies = setCookies(signIn);
    const accessToken = signInCookies.get("__Host-vx_at")?.value ?? "";
    const refreshToken = signInCookies.get("__Host-vx_rt")?.value ?? "";

    expect(signIn.status).toBe(200);
    expectResponseToMatch("signIn", signIn);
    expect(signIn.headers["cache-control"]).toBe("no-store");
    expect(holdsNoToken(signIn.body, [accessToken, refreshToken])).toBe(true);
    expect(signIn.body.customer).toMatchObject({
      id: customerId,
      email,
      status: "active",
      emailVerified: true,
    });
    expect(signIn.body.session).toMatchObject({ rememberMe: false, authMethod: "password", ipCountry: null });
    expect(signIn.body.session.userAgent).toBe("Mozilla/5.0 (storefront test)");
    expect(accessToken.split(".")).toHaveLength(3);
    expect(refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expectStorefrontCookie(signInCookies.get("__Host-vx_at"), 900, true);
    expectStorefrontCookie(signInCookies.get("__Host-vx_rt"), "positive", true);
    expect(Number(signInCookies.get("__Host-vx_rt")?.attributes[0]?.slice(8))).toBeLessThanOrEqual(12 * 3600);
    // The CSRF value is rotated at sign-in, so a value planted before it is useless (OADR-0006 point 2).
    expectStorefrontCookie(signInCookies.get("__Host-vx_csrf"), 30 * 24 * 3600, false);
    expect(visitor.jar.get("__Host-vx_csrf")).not.toBe(csrfBefore);

    const session = await visitor.get("/v1/auth/session");
    expect([session.status, session.body.session.id]).toEqual([200, signIn.body.session.id]);
    expect(session.headers["cache-control"]).toBe("private, no-store");
    expect(session.body.customer.lastSignInAt).toEqual(expect.any(String));
    expect(holdsNoToken(session.body, [accessToken, refreshToken])).toBe(true);
    expectResponseToMatch("getSession", session);

    const csrfBeforeRefresh = visitor.jar.get("__Host-vx_csrf");
    const refresh = await visitor.post("/v1/auth/refresh", {});
    const refreshCookies = setCookies(refresh);
    expect(refresh.status).toBe(200);
    expectResponseToMatch("refreshSession", refresh);
    expect(refresh.body.session.id).toBe(signIn.body.session.id);
    expect(refresh.body.session.refreshTokenExpiresAt).toBe(signIn.body.session.refreshTokenExpiresAt);
    expect(refreshCookies.get("__Host-vx_rt")?.value).not.toBe(refreshToken);
    expect(refreshCookies.get("__Host-vx_at")?.value).toEqual(expect.any(String));
    // A refresh rotates the session cookies, not the CSRF value.
    expect(refreshCookies.has("__Host-vx_csrf")).toBe(false);
    expect(visitor.jar.get("__Host-vx_csrf")).toBe(csrfBeforeRefresh);
    expect(
      holdsNoToken(refresh.body, [
        refreshCookies.get("__Host-vx_at")?.value ?? "",
        refreshCookies.get("__Host-vx_rt")?.value ?? "",
      ]),
    ).toBe(true);

    const signOut = await visitor.post("/v1/auth/sign-out", {});
    const signOutCookies = setCookies(signOut);
    expect([signOut.status, signOut.text]).toEqual([204, ""]);
    expectResponseToMatch("signOut", signOut);
    expectStorefrontCookie(signOutCookies.get("__Host-vx_at"), 0, true);
    expectStorefrontCookie(signOutCookies.get("__Host-vx_rt"), 0, true);
    expectStorefrontCookie(signOutCookies.get("__Host-vx_csrf"), 30 * 24 * 3600, false);
    const rows = await familyRows("tenant_alpha" as TenantSchema, signIn.body.session.id as string);
    expect(rows.map((row) => row.revoke_reason)).toEqual(["logout", "logout"]);

    // The signed-out access token no longer answers "me", although it has not expired.
    const after = await request(api.server)
      .get("/v1/auth/session")
      .set({
        ...edgeHeaders(ALPHA_HOST),
        Cookie: `__Host-vx_at=${refreshCookies.get("__Host-vx_at")?.value ?? ""}`,
      });
    expect([after.status, after.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
    const text = api.sink.text();
    for (const secret of [PASSWORD, accessToken, refreshToken]) {
      expect(text).not.toContain(secret);
    }
  });

  it("refuses a refresh token in the body (400 INVALID_REQUEST) and answers 401 without the refresh cookie", async () => {
    const email = newAddress("edge-body");
    await insertCustomer("tenant_alpha" as TenantSchema, email);
    const visitor = new Visitor();
    await visitor.post("/v1/auth/sign-in", { email, password: PASSWORD });
    const refreshToken = visitor.jar.get("__Host-vx_rt") ?? "";

    const inBody = await visitor.post("/v1/auth/refresh", { refreshToken });
    expect([inBody.status, inBody.body.error.code]).toEqual([400, "INVALID_REQUEST"]);
    expect(inBody.headers["set-cookie"]).toBeUndefined();
    expectResponseToMatch("refreshSession", inBody);

    visitor.jar.delete("__Host-vx_rt");
    const without = await visitor.post("/v1/auth/refresh", {});
    expect([without.status, without.body.error.code]).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    expectResponseToMatch("refreshSession", without);
  });

  it("revokes the family and clears both cookies when an old rotated refresh token comes back [OBE-033 AC3]", async () => {
    const email = newAddress("reuse");
    await insertCustomer("tenant_alpha" as TenantSchema, email);
    const visitor = new Visitor();
    const signIn = await visitor.post("/v1/auth/sign-in", { email, password: PASSWORD });
    const sessionId = signIn.body.session.id as string;
    const first = visitor.jar.get("__Host-vx_rt") ?? "";
    await visitor.post("/v1/auth/refresh", {});
    const second = visitor.jar.get("__Host-vx_rt") ?? "";
    expect(second).not.toBe(first);

    // The old cookie comes back (a stolen copy, or a browser that missed the rotation).
    visitor.jar.set("__Host-vx_rt", first);
    const reuse = await visitor.post("/v1/auth/refresh", {});
    const cleared = setCookies(reuse);

    expect([reuse.status, reuse.body.error.code]).toEqual([401, "REFRESH_TOKEN_REUSED"]);
    expectResponseToMatch("refreshSession", reuse);
    expectStorefrontCookie(cleared.get("__Host-vx_at"), 0, true);
    expectStorefrontCookie(cleared.get("__Host-vx_rt"), 0, true);
    expect([cleared.get("__Host-vx_at")?.value, cleared.get("__Host-vx_rt")?.value]).toEqual(["", ""]);
    expect(visitor.jar.has("__Host-vx_rt")).toBe(false);
    expect(holdsNoToken(reuse.body, [first, second])).toBe(true);
    const rows = await familyRows("tenant_alpha" as TenantSchema, sessionId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([row.revoke_reason, row.revoked_at]).toEqual(["rotation_reuse", expect.any(Date)]);
    }
    // The newest token of the family is dead too.
    visitor.jar.set("__Host-vx_rt", second);
    const newest = await visitor.post("/v1/auth/refresh", {});
    expect([newest.status, newest.body.error.code]).toEqual([401, "REFRESH_TOKEN_INVALID"]);
  });

  it("replays a refresh only to the holder of the refresh cookie it rotated", async () => {
    const email = newAddress("refresh-replay");
    await insertCustomer("tenant_alpha" as TenantSchema, email);
    const visitor = new Visitor();
    await visitor.post("/v1/auth/sign-in", { email, password: PASSWORD });
    const csrf = visitor.jar.get("__Host-vx_csrf") ?? "";
    const presented = visitor.jar.get("__Host-vx_rt") ?? "";
    const key = randomUUID();

    const first = await visitor.post("/v1/auth/refresh", {}, key);
    const rotated = setCookies(first);
    expect(first.status).toBe(200);
    // Script on the page can read the CSRF cookie and see the Idempotency-Key, never the refresh cookie: the same
    // key and CSRF value without the rotated refresh token get no answer that carries the new tokens.
    const stranger = await request(api.server)
      .post("/v1/auth/refresh")
      .set({
        ...edgeHeaders(ALPHA_HOST),
        Origin: `https://${ALPHA_HOST}`,
        "X-CSRF-Token": csrf,
        "X-Forwarded-For": visitor.ip,
        "Idempotency-Key": key,
        Cookie: `__Host-vx_csrf=${csrf}`,
      })
      .send({});
    expect([stranger.status, stranger.body.error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    expect(stranger.headers["set-cookie"]).toBeUndefined();
    // The browser that missed the answer retries with the cookie it still holds and gets the same new pair.
    visitor.jar.set("__Host-vx_rt", presented);
    const retry = await visitor.post("/v1/auth/refresh", {}, key);
    expect(retry.status).toBe(200);
    expect(setCookies(retry).get("__Host-vx_rt")?.value).toBe(rotated.get("__Host-vx_rt")?.value);
    expect(setCookies(retry).get("__Host-vx_at")?.value).toBe(rotated.get("__Host-vx_at")?.value);
  });

  it("answers 401 TOKEN_EXPIRED to the refresh cookie without the access cookie, so one refresh and one retry keep the customer signed in [FIX-W33-OTA] [OBE-031]", async () => {
    const email = newAddress("idle");
    await insertCustomer("tenant_alpha" as TenantSchema, email);
    const visitor = new Visitor();
    const signIn = await visitor.post("/v1/auth/sign-in", { email, password: PASSWORD });
    expect(signIn.status).toBe(200);
    // The browser drops the access cookie when its Max-Age of 900 s ends and keeps sending the refresh cookie.
    visitor.jar.delete("__Host-vx_at");

    const idle = await visitor.get("/v1/auth/session");
    expect([idle.status, idle.body.error.code]).toEqual([401, "TOKEN_EXPIRED"]);
    expect(idle.headers["set-cookie"]).toBeUndefined();
    expectResponseToMatch("getSession", idle);
    // What the SDK in cookie mode does next (OADR-0006 point 5): one auth.refresh with the cookie, then the call again.
    const refresh = await visitor.post("/v1/auth/refresh", {});
    expect(refresh.status).toBe(200);
    expect(setCookies(refresh).get("__Host-vx_at")?.value).toEqual(expect.any(String));
    const retried = await visitor.get("/v1/auth/session");
    expect([retried.status, retried.body.session.id]).toEqual([200, signIn.body.session.id]);
    const refused = api.sink.records().filter((line) => line["msg"] === "customer.token_refused");
    expect(refused.map((line) => line["reason"])).toContain("access_cookie_missing");
  });

  it("keeps 401 UNAUTHENTICATED without either cookie, and a refresh cookie that opens no session costs one refused refresh [FIX-W33-OTA] [OBE-031]", async () => {
    const visitor = new Visitor();

    const neither = await visitor.get("/v1/auth/session");
    expect([neither.status, neither.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("getSession", neither);

    // A refresh token of the contract's form that no family has: the guard does not look it up.
    visitor.jar.set("__Host-vx_rt", `rt_${randomBytes(32).toString("base64url")}`);
    const unknown = await visitor.get("/v1/auth/session");
    expect([unknown.status, unknown.body.error.code]).toEqual([401, "TOKEN_EXPIRED"]);
    // The refresh is refused and clears both session cookies, so the next call is a visitor's again.
    const refresh = await visitor.post("/v1/auth/refresh", {});
    expect([refresh.status, refresh.body.error.code]).toEqual([401, "REFRESH_TOKEN_INVALID"]);
    expect(visitor.jar.has("__Host-vx_rt")).toBe(false);
    const after = await visitor.get("/v1/auth/session");
    expect([after.status, after.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);

    // A value of another form is no refresh cookie at all.
    visitor.jar.set("__Host-vx_rt", "not-a-refresh-token");
    const malformed = await visitor.get("/v1/auth/session");
    expect([malformed.status, malformed.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
  });
});

describe("bearer mode: tokens in the body, never a cookie", () => {
  it("signs in, reads the session, refreshes and signs out with the contract's tokens [OBE-033 AC2]", async () => {
    const email = newAddress("bearer");
    const customerId = await insertCustomer("tenant_alpha" as TenantSchema, email);
    const client = new KeyClient();

    const signIn = await client.post("/v1/auth/sign-in", { email, password: PASSWORD });
    expect(signIn.status).toBe(200);
    expectResponseToMatch("signIn", signIn);
    expect(signIn.headers["set-cookie"]).toBeUndefined();
    expect(signIn.body.session).toMatchObject({
      tokenType: "Bearer",
      subject: { type: "customer", id: customerId },
      accessToken: expect.any(String),
      refreshToken: expect.stringMatching(/^rt_/),
    });
    // rememberMe defaults to true: a 30-day family.
    const days = (Date.parse(signIn.body.session.refreshTokenExpiresAt as string) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    const { accessToken, refreshToken } = signIn.body.session as {
      accessToken: string;
      refreshToken: string;
    };

    const session = await client.get("/v1/auth/session", accessToken);
    expect(session.status).toBe(200);
    expectResponseToMatch("getSession", session);
    expect(session.body.session).toMatchObject({
      rememberMe: true,
      userAgent: "Mozilla/5.0 (third-party storefront test)",
    });
    expect(session.headers["set-cookie"]).toBeUndefined();

    const refresh = await client.post("/v1/auth/refresh", { refreshToken });
    expect(refresh.status).toBe(200);
    expectResponseToMatch("refreshSession", refresh);
    expect(refresh.headers["set-cookie"]).toBeUndefined();
    expect(refresh.body.session.refreshToken).not.toBe(refreshToken);
    expect(refresh.body.customer.id).toBe(customerId);

    const withoutToken = await client.post("/v1/auth/refresh", {});
    expect([withoutToken.status, withoutToken.body.error.code]).toEqual([400, "VALIDATION_FAILED"]);
    expect(withoutToken.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/refreshToken" })]);

    const signOut = await client.post(
      "/v1/auth/sign-out",
      {},
      { Authorization: `Bearer ${refresh.body.session.accessToken as string}` },
    );
    expect([signOut.status, signOut.headers["set-cookie"]]).toEqual([204, undefined]);
    expectResponseToMatch("signOut", signOut);
    const after = await client.post("/v1/auth/refresh", { refreshToken: refresh.body.session.refreshToken });
    expect([after.status, after.body.error.code]).toEqual([401, "REFRESH_TOKEN_INVALID"]);
  });

  it("replays the same session for a retried sign-in with the same Idempotency-Key", async () => {
    const email = newAddress("replay");
    const customerId = await insertCustomer("tenant_alpha" as TenantSchema, email);
    const client = new KeyClient();
    const key = randomUUID();

    const first = await client.post(
      "/v1/auth/sign-in",
      { email, password: PASSWORD },
      { "Idempotency-Key": key },
    );
    const retry = await client.post(
      "/v1/auth/sign-in",
      { email, password: PASSWORD },
      { "Idempotency-Key": key },
    );

    expect([first.status, retry.status]).toEqual([200, 200]);
    expect(retry.body).toEqual(first.body);
    const sessions = await tenantTx(tenantDb, "tenant_alpha" as TenantSchema, (trx) =>
      trx.selectFrom("customer_sessions").select("id").where("customer_id", "=", customerId).execute(),
    );
    expect(sessions).toHaveLength(1);
    // The stored answer carries tokens: its plain copy is redacted and it is kept encrypted only.
    const stored = await tenantTx(tenantDb, "tenant_alpha" as TenantSchema, (trx) =>
      trx
        .selectFrom("idempotency_keys")
        .select(["scope", "request_hash", "response_body", "response_ciphertext"])
        .where("key", "=", key)
        .executeTakeFirstOrThrow(),
    );
    const plain = JSON.stringify(stored.response_body);
    expect(plain).not.toContain(first.body.session.accessToken as string);
    expect(plain).not.toContain(first.body.session.refreshToken as string);
    expect(stored.scope).toMatch(/:signIn$/);
    expect(stored.response_ciphertext).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });

  it("signs out one session by its refresh token alone, or every session with scope all", async () => {
    const email = newAddress("sign-out");
    await insertCustomer("tenant_alpha" as TenantSchema, email);
    const client = new KeyClient();
    const sessions: { accessToken: string; refreshToken: string; id: string }[] = [];
    for (let device = 0; device < 3; device += 1) {
      const res = await client.post("/v1/auth/sign-in", { email, password: PASSWORD });
      const session = await client.get("/v1/auth/session", res.body.session.accessToken as string);
      sessions.push({ ...res.body.session, id: session.body.session.id });
    }
    const [laptop, phone, tablet] = sessions as [
      (typeof sessions)[0],
      (typeof sessions)[0],
      (typeof sessions)[0],
    ];

    const byRefreshToken = await client.post("/v1/auth/sign-out", { refreshToken: laptop.refreshToken });
    const nothing = await client.post("/v1/auth/sign-out", {});
    const all = await client.post(
      "/v1/auth/sign-out",
      { scope: "all" },
      { Authorization: `Bearer ${phone.accessToken}` },
    );

    expect(byRefreshToken.status).toBe(204);
    expect([nothing.status, nothing.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("signOut", nothing);
    expect(all.status).toBe(204);
    const reasons = await Promise.all(
      [laptop, phone, tablet].map(async (session) =>
        (await familyRows("tenant_alpha" as TenantSchema, session.id)).map((row) => row.revoke_reason),
      ),
    );
    expect(reasons).toEqual([["logout"], ["logout"], ["logout"]]);
    const me = await client.get("/v1/auth/session", tablet.accessToken);
    expect([me.status, me.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("signs out by the refresh token when the access token has already expired", async () => {
    const email = newAddress("expired-sign-out");
    const customerId = await insertCustomer("tenant_alpha" as TenantSchema, email);
    const client = new KeyClient();
    const signIn = await client.post("/v1/auth/sign-in", { email, password: PASSWORD });
    const { refreshToken } = signIn.body.session as { refreshToken: string };
    const session = await client.get("/v1/auth/session", signIn.body.session.accessToken as string);
    const sessionId = session.body.session.id as string;
    // An access token of the session issued 20 minutes ago: expired, as the SDK's stored one is after a pause.
    const expired = await tokensAt(new FakeClock(Date.now() - 20 * 60 * 1000)).signCustomerToken({
      sub: customerId,
      tid: alphaId,
      sid: sessionId,
    });
    const bearer = { Authorization: `Bearer ${expired.token}` };

    // Without a refresh token the SDK is told to refresh and retry; nothing is revoked.
    const alone = await client.post("/v1/auth/sign-out", {}, bearer);
    expect([alone.status, alone.body.error.code]).toEqual([401, "TOKEN_EXPIRED"]);
    expectResponseToMatch("signOut", alone);
    expect(
      (await familyRows("tenant_alpha" as TenantSchema, sessionId)).map((row) => row.revoked_at),
    ).toEqual([null]);

    // The document: `current` revokes the session of the refresh token when the access token has expired.
    const withRefreshToken = await client.post("/v1/auth/sign-out", { refreshToken }, bearer);
    expect(withRefreshToken.status).toBe(204);
    expectResponseToMatch("signOut", withRefreshToken);
    expect(
      (await familyRows("tenant_alpha" as TenantSchema, sessionId)).map((row) => row.revoke_reason),
    ).toEqual(["logout"]);
    const after = await client.post("/v1/auth/refresh", { refreshToken });
    expect([after.status, after.body.error.code]).toEqual([401, "REFRESH_TOKEN_INVALID"]);
  });
});
