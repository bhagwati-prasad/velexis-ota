// auth.requestPasswordReset, auth.resetPassword and auth.changePassword through the API's whole pipeline, with the
// worker sending the reset e-mails to Mailpit (OBE-034; the document's three operations, ADR-0008 "Passwords",
// "Lockout" and "E-mail verification and password reset", OADR-0006 points 2 and 4), against PostgreSQL 16, Redis 7
// and Mailpit, in both modes: the hosted storefront's edge (cookies, CSRF, no token in any body) and key callers
// (bearer tokens in the body, never a cookie).
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned), writes the platform rows of
// two active tenants with a secret key each as the platform does, seeds their storefront settings as provisioning
// does, inserts customers with Argon2id password identities, and starts both processes in-process: the API
// (createTestApp) and the worker (WorkerModule.forRoot, whose ota-notifications consumer renders and sends the outbox's
// e-mails through Mailpit's SMTP port). The schedulers the worker registers are removed: the `notify` job that follows
// each commit is what sends. Every client calls from IP addresses of its own (`X-Forwarded-For` through the trusted
// loopback proxy for the edge, `X-Velexis-End-User-IP` for the secret key) and every customer has an address of its
// own (`uniqueEmail`), so the limits of architecture §8 never mix the tests, and every e-mail is found by its
// recipient. Scenarios that sign in, wait for Mailpit or hash passwords run in their `beforeAll` hook with a budget of
// their own; the tests only read what they left. Passwords are made up per run; no value is a secret.
import { randomBytes, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { generateToken, hashApiKey, sha256Hex } from "@velexis/crypto";
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
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { extractLinks, mailpit, uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { APP_DIR, loadWorkerConfig } from "../../../src/config";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { hashCustomerPassword } from "../../../src/identity/sign-in.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import {
  edgeHeaders,
  newApiKey,
  newCsrfToken,
  testApiCredentials,
  testWorkerVariables,
} from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/**
 * Cloning the template, hashing the test password with Argon2id (19 MiB), starting the API's graph (it parses the OTA
 * document and compiles its validators) and the worker's (BullMQ connections, the scheduler registration): a few
 * seconds alone, more while every package's integration tests run on a 4-CPU CI runner. The bound only stops a
 * start-up that hangs.
 */
const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/**
 * A scenario signs in a few times, asks for a reset, waits for the worker to send it through Mailpit and hashes a new
 * password or two (Argon2id): about a second locally; the bound allows for CI load and only stops a scenario that
 * hangs.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for one e-mail. */
const MAIL_WAIT_MS = 20_000;

const ALPHA_HOST = "alpha.ota.example.com";
type Schema = "tenant_alpha" | "tenant_beta";

/** The password of every inserted customer, made up for this run, and its Argon2id hash (made once, below). */
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;
const WRONG = `${PASSWORD}-wrong`;
let passwordHash = "";

/** A new password for one scenario: long enough, never on the breached list. */
const newPassword = (): string => `Fjord-${randomBytes(9).toString("base64url")}`;

/** A weak password and a breached one of the policy (ADR-0008: at least 10 characters, not on the list). */
const SHORT_PASSWORD = "Fjord-La4";
const BREACHED_PASSWORD = "1234567890";

const quietPoolLogger = { error: (): void => undefined };

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let worker: INestApplicationContext;
const workerSink = new MemorySink();
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let alphaKey: string;
let betaKey: string;
/** Every reset token this file read from an e-mail or made: none may reach a log line. */
const secrets: string[] = [PASSWORD];

/** The development SMTP_URL (Mailpit) of the environment. */
function mailpitSmtpUrl(): string {
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig({ SMTP_URL: env.url({ protocols: ["smtp:"] }) }).SMTP_URL;
}

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one client. */
const newIp = (): string => {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
};

function inTenant<T>(schema: Schema, fn: (trx: TenantTransaction) => Promise<T>): Promise<T> {
  return tenantTx(tenantDb, schema as TenantSchema, fn);
}

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

/** Inserts a customer with a password identity (PASSWORD) for `email` into `schema`; its id. */
async function insertCustomer(
  schema: Schema,
  email: string,
  status: "active" | "disabled" | "pending_verification" = "active",
): Promise<string> {
  const id = newId("cus");
  await inTenant(schema, async (trx) => {
    await trx
      .insertInto("customers")
      .values({
        id,
        email,
        status,
        first_name: "Anna",
        last_name: "Berg",
        email_verified_at: status === "pending_verification" ? null : new Date(),
      })
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

/** Inserts an open reset of `customerId` with a token made here, as the API stores them; the token. */
async function insertReset(
  schema: Schema,
  customerId: string,
  options: { readonly expiresAt?: Date; readonly createdAt?: Date } = {},
): Promise<string> {
  const { token, hash } = generateToken("pr", 32);
  secrets.push(token);
  const now = options.createdAt ?? new Date();
  await inTenant(schema, (trx) =>
    trx
      .insertInto("customer_password_resets")
      .values({
        id: newId("pwr"),
        customer_id: customerId,
        token_hash: hash,
        expires_at: options.expiresAt ?? new Date(now.getTime() + 3_600_000),
        created_at: now,
        updated_at: now,
      })
      .execute(),
  );
  return token;
}

/** The customer, its identity, its sessions, resets and notifications in `schema`. */
async function customerState(schema: Schema, customerId: string) {
  return inTenant(schema, async (trx) => ({
    customer: await trx
      .selectFrom("customers")
      .selectAll()
      .where("id", "=", customerId)
      .executeTakeFirstOrThrow(),
    identity: await trx
      .selectFrom("customer_identities")
      .selectAll()
      .where("customer_id", "=", customerId)
      .executeTakeFirstOrThrow(),
    sessions: await trx
      .selectFrom("customer_sessions")
      .selectAll()
      .where("customer_id", "=", customerId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute(),
    resets: await trx
      .selectFrom("customer_password_resets")
      .selectAll()
      .where("customer_id", "=", customerId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute(),
    notifications: await trx
      .selectFrom("notifications")
      .selectAll()
      .where("customer_id", "=", customerId)
      .execute(),
  }));
}

/** The idempotency record of `key` in `schema` (one per key here: every scenario's principal is its own). */
async function idempotencyRecord(schema: Schema, key: string) {
  return inTenant(schema, (trx) =>
    trx.selectFrom("idempotency_keys").selectAll().where("key", "=", key).executeTakeFirst(),
  );
}

/** The plain columns of an idempotency record that could hold a value: never a token or a password. */
function plainColumns(record: Awaited<ReturnType<typeof idempotencyRecord>>): string {
  return JSON.stringify([record?.request_hash, record?.response_headers, record?.response_body]);
}

/** The reset token of the newest e-mail to `to` that the worker sent (`count` of them at least): read from its link. */
async function resetTokenOfMail(to: string, count = 1): Promise<{ token: string; link: string }> {
  let message = await waitForMessage({ to, timeoutMs: MAIL_WAIT_MS });
  const deadline = Date.now() + MAIL_WAIT_MS;
  while ((await mailpit.search({ to })).length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `resetTokenOfMail: ${count} e-mails to the address did not arrive within ${MAIL_WAIT_MS} ms`,
      );
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  const [newest] = await mailpit.search({ to });
  if (newest !== undefined) {
    message = await mailpit.get(newest.ID);
  }
  const link = extractLinks(message).find((url) => url.includes("/account/reset-password.html?token="));
  if (link === undefined) {
    throw new Error("resetTokenOfMail: the e-mail holds no reset link");
  }
  const token = new URL(link).searchParams.get("token") ?? "";
  secrets.push(token);
  return { token, link };
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
    return {
      ...edgeHeaders(this.host),
      Origin: `https://${this.host}`,
      "X-CSRF-Token": this.jar.get("__Host-vx_csrf") ?? "",
      "X-Forwarded-For": this.ip,
      "User-Agent": "Mozilla/5.0 (storefront test)",
      Cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join("; "),
      ...extra,
    };
  }

  async post(path: string, body: unknown): Promise<Response> {
    const res = await request(api.server)
      .post(path)
      .set(this.headers({ "Idempotency-Key": randomUUID() }))
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

/** A server of a third-party storefront with a secret key, calling for one visitor. */
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

  post(path: string, body: unknown, accessToken?: string, idempotencyKey = randomUUID()): Promise<Response> {
    return request(api.server)
      .post(path)
      .set(
        this.headers({
          "Idempotency-Key": idempotencyKey,
          ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
        }),
      )
      .send(body as object);
  }

  get(path: string, accessToken: string): Promise<Response> {
    return request(api.server)
      .get(path)
      .set(this.headers({ Authorization: `Bearer ${accessToken}` }));
  }
}

/** A key caller's session: the tokens of a bearer sign-in. */
interface BearerSession {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** Signs `email` in with `password` through a new key client; the session's tokens. */
async function bearerSignIn(email: string, password = PASSWORD): Promise<BearerSession> {
  const res = await new KeyClient().post("/v1/auth/sign-in", { email, password });
  if (res.status !== 200) {
    throw new Error(`bearerSignIn: sign-in answered ${res.status}`);
  }
  const session = {
    sessionId: "",
    accessToken: res.body.session.accessToken as string,
    refreshToken: res.body.session.refreshToken as string,
  };
  const me = await new KeyClient().get("/v1/auth/session", session.accessToken);
  secrets.push(session.accessToken, session.refreshToken);
  return { ...session, sessionId: me.body.session.id as string };
}

/** Every token-like field name of the contract's session shapes. */
const TOKEN_FIELDS = ["accessToken", "refreshToken", "tokenType"];

/** True when `body` (an answer's JSON) holds no token field and none of `values` anywhere. */
function holdsNoToken(body: unknown, values: readonly string[]): boolean {
  const text = JSON.stringify(body);
  return (
    TOKEN_FIELDS.every((field) => !text.includes(`"${field}"`)) &&
    values.every((value) => value === "" || !text.includes(value))
  );
}

/** The session cookies' attributes as OADR-0006 point 2 and api-changes §2.3 write them. */
function expectStorefrontCookie(cookie: SetCookie | undefined, httpOnly: boolean): void {
  expect(cookie).toBeDefined();
  const attributes = cookie?.attributes ?? [];
  const age = attributes.find((attribute) => attribute.startsWith("Max-Age="));
  expect(Number(age?.slice("Max-Age=".length))).toBeGreaterThan(0);
  expect(attributes).toEqual(expect.arrayContaining(["Path=/", "Secure", "SameSite=Lax"]));
  expect(attributes.includes("HttpOnly")).toBe(httpOnly);
  expect(attributes.some((attribute) => attribute.toLowerCase().startsWith("domain="))).toBe(false);
}

/** The headers of an answer that may differ between two identical answers: the request id and the time. */
function comparableHeaders(res: Response): Record<string, unknown> {
  const { "x-request-id": _requestId, date: _date, ...rest } = res.headers as Record<string, unknown>;
  return rest;
}

/** Every log line both applications wrote. */
function allLogText(): string {
  return `${api.sink.text()}\n${workerSink.text()}`;
}

beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of the operations the tests check (Customer and the session shapes are large) compile on
  // their first check: here, with every status the tests below check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["requestPasswordReset", [202, 403]],
    ["resetPassword", [200, 400, 422]],
    ["changePassword", [200, 401, 422, 423]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, passwordHash] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    hashCustomerPassword(PASSWORD),
  ]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  ({ tenantId: alphaId, apiKey: alphaKey } = await insertTenant("alpha"));
  ({ apiKey: betaKey } = await insertTenant("beta"));
  // The settings rows as provisioning seeds them (customer accounts on).
  for (const [schema, name] of [
    ["tenant_alpha", "Alpha Travel"],
    ["tenant_beta", "Beta Travel"],
  ] as const) {
    await inTenant(schema, (trx) =>
      seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" }),
    );
  }

  api = await createTestApp({ database: db, redis, env: { LOG_LEVEL: "debug" } });
  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    LOG_LEVEL: "debug",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
    SMTP_URL: mailpitSmtpUrl(),
  });
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(
    WorkerModule.forRoot(config, { logger: createWorkerLogger(config, workerSink) }),
  );
  await worker.init();
  // No scheduler iteration may fire while the file runs: each commit's `notify` job sends the e-mails.
  const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
}, SETUP_TIMEOUT_MS);

describe("[OBE-034 AC1] a reset link works once, and every older session is revoked", () => {
  const email = uniqueEmail("obe034-reset");
  const next = newPassword();
  let customerId = "";
  let bearer: BearerSession;
  const visitor = new Visitor();
  let requested: Response;
  let mail: { token: string; link: string };
  let confirm: Response;
  let again: Response;
  let before: Awaited<ReturnType<typeof customerState>>;
  let after: Awaited<ReturnType<typeof customerState>>;
  const answers: Record<string, Response> = {};
  const lockouts: (string | null)[] = [];
  const confirmKey = randomUUID();
  let confirmRecord: Awaited<ReturnType<typeof idempotencyRecord>>;

  beforeAll(async () => {
    const counter = `t:${alphaId}:test:authfail:${sha256Hex(email.toLowerCase())}`;
    // A customer still waiting for e-mail verification, with a bearer session, an edge session and two wrong sign-ins.
    customerId = await insertCustomer("tenant_alpha", email, "pending_verification");
    bearer = await bearerSignIn(email);
    await visitor.post("/v1/auth/sign-in", { email, password: PASSWORD });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await new KeyClient().post("/v1/auth/sign-in", { email, password: WRONG });
    }
    before = await customerState("tenant_alpha", customerId);
    lockouts.push(await redis.client.get(counter));

    requested = await new Visitor().post("/v1/auth/password-resets", { email, returnPath: "/account/trips" });
    mail = await resetTokenOfMail(email);
    confirm = await new KeyClient().post(
      "/v1/auth/password-resets/confirm",
      { token: mail.token, newPassword: next, signIn: true },
      undefined,
      confirmKey,
    );
    secrets.push(confirm.body.session?.accessToken ?? "", confirm.body.session?.refreshToken ?? "");
    confirmRecord = await idempotencyRecord("tenant_alpha", confirmKey);
    again = await new KeyClient().post("/v1/auth/password-resets/confirm", {
      token: mail.token,
      newPassword: newPassword(),
    });
    after = await customerState("tenant_alpha", customerId);
    lockouts.push(await redis.client.get(counter));

    const client = new KeyClient();
    answers["oldRefresh"] = await client.post("/v1/auth/refresh", { refreshToken: bearer.refreshToken });
    answers["oldAccess"] = await client.get("/v1/auth/session", bearer.accessToken);
    answers["edgeSession"] = await visitor.get("/v1/auth/session");
    answers["edgeRefresh"] = await visitor.post("/v1/auth/refresh", {});
    answers["newSession"] = await client.get("/v1/auth/session", confirm.body.session.accessToken as string);
    answers["oldPassword"] = await new KeyClient().post("/v1/auth/sign-in", { email, password: PASSWORD });
    answers["newPassword"] = await new KeyClient().post("/v1/auth/sign-in", { email, password: next });
  }, SCENARIO_TIMEOUT_MS);

  it("accepts the request, e-mails a one-hour link on the storefront host and answers the reset with a new session [OBE-034 AC1]", () => {
    expect(requested.status).toBe(202);
    expectResponseToMatch("requestPasswordReset", requested);
    expect(requested.body).toEqual({
      status: "accepted",
      message: "If an account exists for this address, we have sent a link to reset your password.",
    });
    expect(new URL(mail.link).origin).toBe(`https://${ALPHA_HOST}`);
    expect(mail.token).toMatch(/^pr_[A-Za-z0-9_-]{43}$/);
    const [reset] = after.resets;
    expect(after.resets).toHaveLength(1);
    expect(reset?.token_hash).toBe(sha256Hex(mail.token));
    expect((reset?.expires_at.getTime() ?? 0) - (reset?.created_at.getTime() ?? 0)).toBe(3_600_000);
    expect(reset?.requested_ip).toMatch(/^203\.0\.113\./);

    expect(confirm.status).toBe(200);
    expectResponseToMatch("resetPassword", confirm);
    expect(confirm.headers["cache-control"]).toBe("no-store");
    expect(confirm.headers["set-cookie"]).toBeUndefined();
    expect(confirm.body.customer).toMatchObject({ id: customerId, emailVerified: true, status: "active" });
    expect(confirm.body.session).toMatchObject({
      tokenType: "Bearer",
      subject: { type: "customer", id: customerId },
    });
    expect([answers["newSession"]?.status, answers["newSession"]?.body.session.rememberMe]).toEqual([
      200,
      true,
    ]);
    expect(answers["newPassword"]?.status).toBe(200);
  });

  it("refuses the link the second time: 400 PASSWORD_RESET_TOKEN_INVALID with reason used [OBE-034 AC1]", () => {
    expect([again.status, again.body.error.code, again.body.error.details]).toEqual([
      400,
      "PASSWORD_RESET_TOKEN_INVALID",
      { reason: "used" },
    ]);
    expectResponseToMatch("resetPassword", again);
    expect(after.resets[0]?.used_at).toEqual(expect.any(Date));
    // The refused second use changed nothing: the password is the first reset's.
    expect(answers["newPassword"]?.status).toBe(200);
  });

  it("revokes every session opened before the reset, bearer and edge alike [OBE-034 AC1]", () => {
    const families = new Set(before.sessions.map((row) => row.family_id));
    expect(families.size).toBe(2);
    const older = after.sessions.filter((row) => families.has(row.family_id));
    expect(older.length).toBeGreaterThanOrEqual(2);
    for (const row of older) {
      expect([row.revoke_reason, row.revoked_at]).toEqual(["password_change", expect.any(Date)]);
    }
    expect([answers["oldRefresh"]?.status, answers["oldRefresh"]?.body.error.code]).toEqual([
      401,
      "REFRESH_TOKEN_INVALID",
    ]);
    expect([answers["oldAccess"]?.status, answers["oldAccess"]?.body.error.code]).toEqual([
      401,
      "UNAUTHENTICATED",
    ]);
    expect([answers["edgeSession"]?.status, answers["edgeSession"]?.body.error.code]).toEqual([
      401,
      "UNAUTHENTICATED",
    ]);
    expect([answers["edgeRefresh"]?.status, answers["edgeRefresh"]?.body.error.code]).toEqual([
      401,
      "REFRESH_TOKEN_INVALID",
    ]);
    expect([answers["oldPassword"]?.status, answers["oldPassword"]?.body.error.code]).toEqual([
      401,
      "INVALID_CREDENTIALS",
    ]);
  });

  it("stores the new hash, verifies the address and clears the sign-in lockout", () => {
    expect(after.identity.password_hash).not.toBe(before.identity.password_hash);
    expect(after.identity.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(after.identity.password_updated_at).toEqual(expect.any(Date));
    expect(after.identity.email_verified_at).toEqual(expect.any(Date));
    expect(before.customer.email_verified_at).toBeNull();
    expect(after.customer).toMatchObject({ status: "active", version: before.customer.version + 1 });
    // The two wrong sign-ins before the reset were forgotten.
    expect(lockouts).toEqual(["2", null]);
  });

  it("keeps the token in clear nowhere: not in the outbox row, not in a log line", () => {
    const [notification] = after.notifications;
    expect(after.notifications).toHaveLength(1);
    expect(notification).toMatchObject({
      template_key: "auth.password_reset",
      recipient: email,
      status: "sent",
    });
    expect(notification?.secret_payload_ciphertext).toBeNull();
    expect(JSON.stringify(notification)).not.toContain(mail.token);
    const text = allLogText();
    for (const secret of [mail.token, next, PASSWORD, bearer.refreshToken]) {
      expect(text).not.toContain(secret);
    }
    // The stored answer of the confirmation keeps the new session's tokens in its ciphertext only.
    expect(confirmRecord).toMatchObject({ status: "completed", response_status: 200 });
    expect(confirmRecord?.response_ciphertext).not.toBeNull();
    const session = confirm.body.session as { accessToken: string; refreshToken: string };
    for (const secret of [mail.token, next, session.accessToken, session.refreshToken]) {
      expect(plainColumns(confirmRecord)).not.toContain(secret);
    }
  });
});

describe("auth.resetPassword in edge mode and without a session", () => {
  const edgeEmail = uniqueEmail("obe034-reset-edge");
  const quietEmail = uniqueEmail("obe034-reset-nosignin");
  const visitor = new Visitor();
  const csrfBefore = visitor.jar.get("__Host-vx_csrf") ?? "";
  let edgeConfirm: Response;
  let edgeSession: Response;
  let quietConfirm: Response;
  let quietCustomerId = "";
  let quietSessions = 0;

  beforeAll(async () => {
    await insertCustomer("tenant_alpha", edgeEmail);
    await visitor.post("/v1/auth/password-resets", { email: edgeEmail });
    const { token } = await resetTokenOfMail(edgeEmail);
    edgeConfirm = await visitor.post("/v1/auth/password-resets/confirm", {
      token,
      newPassword: newPassword(),
    });
    edgeSession = await visitor.get("/v1/auth/session");

    quietCustomerId = await insertCustomer("tenant_alpha", quietEmail);
    const quietToken = await insertReset("tenant_alpha", quietCustomerId);
    quietConfirm = await new KeyClient().post("/v1/auth/password-resets/confirm", {
      token: quietToken,
      newPassword: newPassword(),
      signIn: false,
    });
    quietSessions = (await customerState("tenant_alpha", quietCustomerId)).sessions.length;
  }, SCENARIO_TIMEOUT_MS);

  it("sets the new session in the cookies, rotates the CSRF value and answers session: null", () => {
    const cookies = setCookies(edgeConfirm);
    expect(edgeConfirm.status).toBe(200);
    expectResponseToMatch("resetPassword", edgeConfirm);
    expect(edgeConfirm.body.session).toBeNull();
    expectStorefrontCookie(cookies.get("__Host-vx_at"), true);
    expectStorefrontCookie(cookies.get("__Host-vx_rt"), true);
    expectStorefrontCookie(cookies.get("__Host-vx_csrf"), false);
    expect(visitor.jar.get("__Host-vx_csrf")).not.toBe(csrfBefore);
    expect(
      holdsNoToken(edgeConfirm.body, [
        cookies.get("__Host-vx_at")?.value ?? "",
        cookies.get("__Host-vx_rt")?.value ?? "",
      ]),
    ).toBe(true);
    expect([edgeSession.status, edgeSession.body.customer.email]).toEqual([200, edgeEmail]);
  });

  it("opens no session with signIn: false", () => {
    expect(quietConfirm.status).toBe(200);
    expectResponseToMatch("resetPassword", quietConfirm);
    expect(quietConfirm.body).toMatchObject({ customer: { id: quietCustomerId }, session: null });
    expect(quietConfirm.headers["set-cookie"]).toBeUndefined();
    expect(quietSessions).toBe(0);
  });
});

describe("auth.resetPassword: refused tokens and passwords", () => {
  const email = uniqueEmail("obe034-reset-refusals");
  let customerId = "";
  const answers: Record<string, Response> = {};
  let state: Awaited<ReturnType<typeof customerState>>;

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    const client = new KeyClient();
    const confirm = (token: string, password = newPassword()) =>
      client.post("/v1/auth/password-resets/confirm", { token, newPassword: password });

    answers["unknown"] = await confirm(generateToken("pr", 32).token);
    const expired = await insertReset("tenant_alpha", customerId, {
      createdAt: new Date(Date.now() - 2 * 3_600_000),
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    answers["expired"] = await confirm(expired);
    // An open link is ended by a newer request: only the newest link of a customer works.
    const superseded = await insertReset("tenant_alpha", customerId);
    answers["request"] = await new KeyClient().post("/v1/auth/password-resets", { email });
    answers["superseded"] = await confirm(superseded);
    const fresh = await resetTokenOfMail(email);
    answers["short"] = await confirm(fresh.token, SHORT_PASSWORD);
    answers["breached"] = await confirm(fresh.token, BREACHED_PASSWORD);
    // A token of alpha is unknown at beta: the tenants' tables never meet.
    answers["otherTenant"] = await new KeyClient(betaKey).post("/v1/auth/password-resets/confirm", {
      token: fresh.token,
      newPassword: newPassword(),
    });
    answers["valid"] = await confirm(fresh.token);
    state = await customerState("tenant_alpha", customerId);
  }, SCENARIO_TIMEOUT_MS);

  it("answers 400 PASSWORD_RESET_TOKEN_INVALID with reason unknown, expired, or expired for a superseded link", () => {
    for (const [name, reason] of [
      ["unknown", "unknown"],
      ["expired", "expired"],
      ["superseded", "expired"],
      ["otherTenant", "unknown"],
    ] as const) {
      const res = answers[name];
      expect([name, res?.status, res?.body.error.code, res?.body.error.details]).toEqual([
        name,
        400,
        "PASSWORD_RESET_TOKEN_INVALID",
        { reason },
      ]);
      expectResponseToMatch("resetPassword", res as Response);
    }
    expect(answers["request"]?.status).toBe(202);
  });

  it("answers 422 PASSWORD_TOO_WEAK for a short or breached password and keeps the link usable", () => {
    expect([
      answers["short"]?.status,
      answers["short"]?.body.error.code,
      answers["short"]?.body.error.details,
    ]).toEqual([422, "PASSWORD_TOO_WEAK", { violations: ["minLength"] }]);
    expect(answers["short"]?.body.error.fieldErrors).toEqual([
      { path: "/newPassword", code: "too_weak", message: expect.any(String) as string },
    ]);
    expect([answers["breached"]?.status, answers["breached"]?.body.error.details]).toEqual([
      422,
      { violations: ["breached"] },
    ]);
    for (const name of ["short", "breached"]) {
      expectResponseToMatch("resetPassword", answers[name] as Response);
      expect(JSON.stringify(answers[name]?.body)).not.toContain(
        name === "short" ? SHORT_PASSWORD : BREACHED_PASSWORD,
      );
    }
    expect(answers["valid"]?.status).toBe(200);
    expect(state.resets.filter((row) => row.used_at !== null)).toHaveLength(1);
  });
});

describe("[OBE-034 AC1] two confirmations of one link at the same moment", () => {
  const email = uniqueEmail("obe034-reset-race");
  const passwords = [newPassword(), newPassword()];
  let answers: Response[] = [];
  let winnerSignIn: Response;
  let state: Awaited<ReturnType<typeof customerState>>;

  beforeAll(async () => {
    const customerId = await insertCustomer("tenant_alpha", email);
    const token = await insertReset("tenant_alpha", customerId);
    // Sent together, so both usually find the link open before either has hashed its new password.
    answers = await Promise.all(
      passwords.map((password) =>
        new KeyClient().post("/v1/auth/password-resets/confirm", { token, newPassword: password }),
      ),
    );
    for (const res of answers) {
      secrets.push(res.body.session?.accessToken ?? "", res.body.session?.refreshToken ?? "");
    }
    state = await customerState("tenant_alpha", customerId);
    const winner = answers.findIndex((res) => res.status === 200);
    winnerSignIn = await new KeyClient().post("/v1/auth/sign-in", {
      email,
      password: passwords[winner] ?? PASSWORD,
    });
  }, SCENARIO_TIMEOUT_MS);

  it("lets exactly one reset the password and open a session; the other answers reason used [OBE-034 AC1]", () => {
    const outcomes = answers
      .map((res) => ({
        status: res.status,
        reason: res.status === 200 ? undefined : (res.body.error?.details?.reason as string | undefined),
      }))
      .sort((a, b) => a.status - b.status);
    expect(outcomes).toEqual([
      { status: 200, reason: undefined },
      { status: 400, reason: "used" },
    ]);
    for (const res of answers) {
      expectResponseToMatch("resetPassword", res);
    }
    expect(state.resets.map((row) => row.used_at !== null)).toEqual([true]);
    expect(state.sessions).toHaveLength(1);
    // The stored hash is the one of the confirmation that answered 200.
    expect(winnerSignIn.status).toBe(200);
  });
});

describe("[OBE-034 AC2] auth.requestPasswordReset answers known and unknown addresses alike", () => {
  const known = uniqueEmail("obe034-known");
  const unknown = uniqueEmail("obe034-unknown");
  const disabled = uniqueEmail("obe034-disabled");
  const throttled = uniqueEmail("obe034-throttled");
  const edgeKnown = uniqueEmail("obe034-edge-known");
  const edgeUnknown = uniqueEmail("obe034-edge-unknown");
  const ids: Record<string, string> = {};
  const key: Record<string, Response> = {};
  const edge: Record<string, Response> = {};
  const states: Record<string, Awaited<ReturnType<typeof customerState>>> = {};

  beforeAll(async () => {
    ids["known"] = await insertCustomer("tenant_alpha", known);
    ids["disabled"] = await insertCustomer("tenant_alpha", disabled, "disabled");
    ids["throttled"] = await insertCustomer("tenant_alpha", throttled);
    ids["edgeKnown"] = await insertCustomer("tenant_alpha", edgeKnown);
    // Three reset e-mails within the hour already: a fourth is dropped silently.
    for (let minutes = 50; minutes >= 10; minutes -= 20) {
      await insertReset("tenant_alpha", ids["throttled"], {
        createdAt: new Date(Date.now() - minutes * 60_000),
      });
    }
    for (const [name, email] of [
      ["known", known],
      ["unknown", unknown],
      ["disabled", disabled],
      ["throttled", throttled],
    ] as const) {
      key[name] = await new KeyClient().post("/v1/auth/password-resets", { email });
    }
    for (const [name, email] of [
      ["known", edgeKnown],
      ["unknown", edgeUnknown],
    ] as const) {
      edge[name] = await new Visitor().post("/v1/auth/password-resets", { email });
    }
    await resetTokenOfMail(known);
    await resetTokenOfMail(edgeKnown);
    for (const name of ["known", "disabled", "throttled", "edgeKnown"]) {
      states[name] = await customerState("tenant_alpha", ids[name] ?? "");
    }
  }, SCENARIO_TIMEOUT_MS);

  it("answers byte-identical 202 bodies and the same headers for every address, apart from the request id [OBE-034 AC2]", () => {
    const reference = key["known"] as Response;
    expect(reference.status).toBe(202);
    expectResponseToMatch("requestPasswordReset", reference);
    for (const name of ["unknown", "disabled", "throttled"]) {
      const res = key[name] as Response;
      expect([name, res.status, res.text]).toEqual([name, 202, reference.text]);
      expect(comparableHeaders(res)).toEqual(comparableHeaders(reference));
      expect(res.headers["x-request-id"]).not.toBe(reference.headers["x-request-id"]);
    }
    const edgeReference = edge["known"] as Response;
    expect([edgeReference.status, edgeReference.text]).toEqual([202, reference.text]);
    expect([edge["unknown"]?.status, edge["unknown"]?.text]).toEqual([202, edgeReference.text]);
    expect(comparableHeaders(edge["unknown"] as Response)).toEqual(comparableHeaders(edgeReference));
    expect(edgeReference.headers["set-cookie"]).toBeUndefined();
  });

  it("e-mails only the known, active address; blocked and throttled customers get nothing", () => {
    for (const name of ["known", "edgeKnown"]) {
      expect(states[name]?.resets).toHaveLength(1);
      expect(states[name]?.notifications.map((row) => row.template_key)).toEqual(["auth.password_reset"]);
    }
    expect(states["disabled"]?.resets).toHaveLength(0);
    expect(states["disabled"]?.notifications).toHaveLength(0);
    expect(states["throttled"]?.resets).toHaveLength(3);
    expect(states["throttled"]?.notifications).toHaveLength(0);
    const outcomes = api.sink
      .records()
      .filter((line) => line["msg"] === "customer.password_reset_requested")
      .map((line) => line["outcome"]);
    expect(outcomes).toEqual(
      expect.arrayContaining(["sent", "unknown_address", "customer_blocked", "throttled"]),
    );
    for (const email of [known, unknown, disabled, throttled]) {
      expect(allLogText()).not.toContain(email);
    }
  });

  it("answers 403 FEATURE_DISABLED for every address while customer accounts are off", async () => {
    const setAccounts = (enabled: boolean) =>
      inTenant("tenant_beta", (trx) =>
        trx.updateTable("storefront_settings").set({ customer_accounts_enabled: enabled }).execute(),
      );
    const betaKnown = uniqueEmail("obe034-beta-off");
    await insertCustomer("tenant_beta", betaKnown);
    await setAccounts(false);
    try {
      const answers = [
        await new KeyClient(betaKey).post("/v1/auth/password-resets", { email: betaKnown }),
        await new KeyClient(betaKey).post("/v1/auth/password-resets", {
          email: uniqueEmail("obe034-beta-none"),
        }),
      ];
      for (const res of answers) {
        expect([res.status, res.body.error.code, res.body.error.details]).toEqual([
          403,
          "FEATURE_DISABLED",
          { feature: "customerAccounts" },
        ]);
        expectResponseToMatch("requestPasswordReset", res);
      }
    } finally {
      await setAccounts(true);
    }
  });
});

describe("[OBE-034 AC3] auth.changePassword with a wrong current password", () => {
  const email = uniqueEmail("obe034-change-wrong");
  let customerId = "";
  let current: BearerSession;
  let other: BearerSession;
  let wrong: Response;
  let signedOut: Response;
  let before: Awaited<ReturnType<typeof customerState>>;
  let after: Awaited<ReturnType<typeof customerState>>;
  let refreshAfter: Response;
  let signInAfter: Response;

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    current = await bearerSignIn(email);
    other = await bearerSignIn(email);
    before = await customerState("tenant_alpha", customerId);
    wrong = await new KeyClient().post(
      "/v1/auth/password/change",
      { currentPassword: WRONG, newPassword: newPassword() },
      current.accessToken,
    );
    signedOut = await new KeyClient().post("/v1/auth/password/change", {
      currentPassword: PASSWORD,
      newPassword: newPassword(),
    });
    after = await customerState("tenant_alpha", customerId);
    refreshAfter = await new KeyClient().post("/v1/auth/refresh", { refreshToken: other.refreshToken });
    signInAfter = await new KeyClient().post("/v1/auth/sign-in", { email, password: PASSWORD });
  }, SCENARIO_TIMEOUT_MS);

  it("answers 422 CURRENT_PASSWORD_INCORRECT, as the document says, and changes nothing [OBE-034 AC3]", () => {
    expect([wrong.status, wrong.body.error.code, wrong.body.error.fieldErrors]).toEqual([
      422,
      "CURRENT_PASSWORD_INCORRECT",
      [{ path: "/currentPassword", code: "incorrect", message: expect.any(String) as string }],
    ]);
    expectResponseToMatch("changePassword", wrong);
    expect(after.identity).toEqual(before.identity);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.customer).toEqual(before.customer);
    // The sessions and the password still work.
    expect(refreshAfter.status).toBe(200);
    expect(signInAfter.status).toBe(200);
  });

  it("answers 401 UNAUTHENTICATED without a signed-in customer and changes nothing [OBE-034 AC3]", () => {
    expect([signedOut.status, signedOut.body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("changePassword", signedOut);
    expect(after.identity.password_hash).toBe(before.identity.password_hash);
  });
});

describe("auth.changePassword: rotating the session and revoking the others", () => {
  const email = uniqueEmail("obe034-change");
  const keepEmail = uniqueEmail("obe034-change-keep");
  const next = newPassword();
  let customerId = "";
  let current: BearerSession;
  let other: BearerSession;
  let keepOther: BearerSession;
  let changed: Response;
  let kept: Response;
  const answers: Record<string, Response> = {};
  let state: Awaited<ReturnType<typeof customerState>>;

  beforeAll(async () => {
    customerId = await insertCustomer("tenant_alpha", email);
    current = await bearerSignIn(email);
    other = await bearerSignIn(email);
    const openReset = await insertReset("tenant_alpha", customerId);
    changed = await new KeyClient().post(
      "/v1/auth/password/change",
      { currentPassword: PASSWORD, newPassword: next },
      current.accessToken,
    );
    secrets.push(changed.body.session?.accessToken ?? "", changed.body.session?.refreshToken ?? "");
    state = await customerState("tenant_alpha", customerId);
    const client = new KeyClient();
    answers["me"] = await client.get("/v1/auth/session", changed.body.session.accessToken as string);
    answers["otherRefresh"] = await client.post("/v1/auth/refresh", { refreshToken: other.refreshToken });
    answers["openReset"] = await client.post("/v1/auth/password-resets/confirm", {
      token: openReset,
      newPassword: newPassword(),
    });
    answers["newPassword"] = await new KeyClient().post("/v1/auth/sign-in", { email, password: next });
    answers["newRefresh"] = await client.post("/v1/auth/refresh", {
      refreshToken: changed.body.session.refreshToken as string,
    });
    // Last: the current session's old refresh token was rotated, so presenting it is a reuse.
    answers["oldRefresh"] = await client.post("/v1/auth/refresh", { refreshToken: current.refreshToken });

    await insertCustomer("tenant_alpha", keepEmail);
    const keepCurrent = await bearerSignIn(keepEmail);
    keepOther = await bearerSignIn(keepEmail);
    kept = await new KeyClient().post(
      "/v1/auth/password/change",
      { currentPassword: PASSWORD, newPassword: newPassword(), signOutOtherSessions: false },
      keepCurrent.accessToken,
    );
    answers["keptRefresh"] = await client.post("/v1/auth/refresh", { refreshToken: keepOther.refreshToken });
  }, SCENARIO_TIMEOUT_MS);

  it("answers AuthSessionResult with the current session rotated: the same session, a new refresh token", () => {
    expect(changed.status).toBe(200);
    expectResponseToMatch("changePassword", changed);
    expect(changed.headers["set-cookie"]).toBeUndefined();
    expect(changed.body.customer.id).toBe(customerId);
    expect(changed.body.session.refreshToken).not.toBe(current.refreshToken);
    expect([answers["me"]?.status, answers["me"]?.body.session.id]).toEqual([200, current.sessionId]);
    expect(answers["newRefresh"]?.status).toBe(200);
    expect([answers["oldRefresh"]?.status, answers["oldRefresh"]?.body.error.code]).toEqual([
      401,
      "REFRESH_TOKEN_REUSED",
    ]);
    expect(answers["newPassword"]?.status).toBe(200);
  });

  it("revokes every other session and ends open reset links; keeps them with signOutOtherSessions: false", () => {
    const others = state.sessions.filter((row) => row.family_id === other.sessionId);
    expect(others.map((row) => row.revoke_reason)).toEqual(["password_change"]);
    const currents = state.sessions.filter((row) => row.family_id === current.sessionId);
    expect(currents.map((row) => [row.revoked_at, row.rotated_at === null])).toEqual([
      [null, false],
      [null, true],
    ]);
    expect([answers["otherRefresh"]?.status, answers["otherRefresh"]?.body.error.code]).toEqual([
      401,
      "REFRESH_TOKEN_INVALID",
    ]);
    expect([answers["openReset"]?.status, answers["openReset"]?.body.error.details]).toEqual([
      400,
      { reason: "expired" },
    ]);
    expect(kept.status).toBe(200);
    expect(answers["keptRefresh"]?.status).toBe(200);
  });
});

describe("auth.changePassword in edge mode, the lockout and the password rules", () => {
  const edgeEmail = uniqueEmail("obe034-change-edge");
  const lockEmail = uniqueEmail("obe034-change-lock");
  const rulesEmail = uniqueEmail("obe034-change-rules");
  const visitor = new Visitor();
  let signIn: Response;
  let edgeChange: Response;
  let edgeMe: Response;
  let csrfBefore = "";
  let refreshBefore = "";
  const attempts: Response[] = [];
  let lockedRight: Response;
  const rules: Record<string, Response> = {};

  beforeAll(async () => {
    await insertCustomer("tenant_alpha", edgeEmail);
    signIn = await visitor.post("/v1/auth/sign-in", { email: edgeEmail, password: PASSWORD });
    csrfBefore = visitor.jar.get("__Host-vx_csrf") ?? "";
    refreshBefore = visitor.jar.get("__Host-vx_rt") ?? "";
    edgeChange = await visitor.post("/v1/auth/password/change", {
      currentPassword: PASSWORD,
      newPassword: newPassword(),
    });
    edgeMe = await visitor.get("/v1/auth/session");

    await insertCustomer("tenant_alpha", lockEmail);
    const locked = await bearerSignIn(lockEmail);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      attempts.push(
        await new KeyClient().post(
          "/v1/auth/password/change",
          { currentPassword: WRONG, newPassword: newPassword() },
          locked.accessToken,
        ),
      );
    }
    lockedRight = await new KeyClient().post(
      "/v1/auth/password/change",
      { currentPassword: PASSWORD, newPassword: newPassword() },
      locked.accessToken,
    );

    await insertCustomer("tenant_alpha", rulesEmail);
    const session = await bearerSignIn(rulesEmail);
    const change = (password: string) =>
      new KeyClient().post(
        "/v1/auth/password/change",
        { currentPassword: PASSWORD, newPassword: password },
        session.accessToken,
      );
    rules["same"] = await change(PASSWORD);
    rules["short"] = await change(SHORT_PASSWORD);
    rules["breached"] = await change(BREACHED_PASSWORD);
  }, SCENARIO_TIMEOUT_MS);

  it("answers AuthSessionInfo without a token and rotates the session and CSRF cookies", () => {
    const cookies = setCookies(edgeChange);
    expect(edgeChange.status).toBe(200);
    expectResponseToMatch("changePassword", edgeChange);
    expect(edgeChange.body.session.id).toBe(signIn.body.session.id);
    expectStorefrontCookie(cookies.get("__Host-vx_at"), true);
    expectStorefrontCookie(cookies.get("__Host-vx_rt"), true);
    expectStorefrontCookie(cookies.get("__Host-vx_csrf"), false);
    expect(cookies.get("__Host-vx_rt")?.value).not.toBe(refreshBefore);
    expect(cookies.get("__Host-vx_csrf")?.value).not.toBe(csrfBefore);
    expect([edgeMe.status, edgeMe.body.session.id]).toEqual([200, signIn.body.session.id]);
    expect(
      holdsNoToken(edgeChange.body, [
        cookies.get("__Host-vx_at")?.value ?? "",
        cookies.get("__Host-vx_rt")?.value ?? "",
      ]),
    ).toBe(true);
  });

  it("locks at the fifth wrong current password; then the right one answers 423 with Retry-After too", () => {
    expect(attempts.slice(0, 4).map((res) => [res.status, res.body.error.code])).toEqual(
      Array.from({ length: 4 }, () => [422, "CURRENT_PASSWORD_INCORRECT"]),
    );
    for (const res of [attempts[4], lockedRight]) {
      expect([res?.status, res?.body.error.code]).toEqual([423, "ACCOUNT_LOCKED"]);
      expect(Number(res?.headers["retry-after"])).toBeGreaterThan(0);
      expectResponseToMatch("changePassword", res as Response);
    }
  });

  it("answers 422 PASSWORD_TOO_WEAK for the current password again, a short and a breached one", () => {
    expect([
      rules["same"]?.status,
      rules["same"]?.body.error.code,
      rules["same"]?.body.error.details,
    ]).toEqual([422, "PASSWORD_TOO_WEAK", { violations: ["sameAsCurrent"] }]);
    expect(rules["short"]?.body.error.details).toEqual({ violations: ["minLength"] });
    expect(rules["breached"]?.body.error.details).toEqual({ violations: ["breached"] });
    for (const res of Object.values(rules)) {
      expect(res.body.error.fieldErrors[0].path).toBe("/newPassword");
      expectResponseToMatch("changePassword", res);
    }
  });

  it("never writes a password or a token into a log line", () => {
    const text = allLogText();
    for (const secret of secrets) {
      if (secret !== "") {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe("a stored answer of auth.changePassword is replayed only to its own session", () => {
  const email = uniqueEmail("obe034-change-replay");
  const idempotencyKey = randomUUID();
  let first: Response;
  let replay: Response;
  let otherSession: Response;
  let record: Awaited<ReturnType<typeof idempotencyRecord>>;
  let body: { currentPassword: string; newPassword: string; signOutOtherSessions: boolean };

  beforeAll(async () => {
    await insertCustomer("tenant_alpha", email);
    const current = await bearerSignIn(email);
    const other = await bearerSignIn(email);
    const client = new KeyClient();
    body = { currentPassword: PASSWORD, newPassword: newPassword(), signOutOtherSessions: false };
    first = await client.post("/v1/auth/password/change", body, current.accessToken, idempotencyKey);
    secrets.push(first.body.session?.accessToken ?? "", first.body.session?.refreshToken ?? "");
    replay = await client.post("/v1/auth/password/change", body, current.accessToken, idempotencyKey);
    otherSession = await client.post("/v1/auth/password/change", body, other.accessToken, idempotencyKey);
    record = await idempotencyRecord("tenant_alpha", idempotencyKey);
  }, SCENARIO_TIMEOUT_MS);

  it("replays the same answer to the same session and refuses the key from another session of the customer", () => {
    expect(first.status).toBe(200);
    expect([replay.status, replay.body.session.refreshToken]).toEqual([200, first.body.session.refreshToken]);
    expect([otherSession.status, otherSession.body.error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
  });

  it("stores the answer's tokens in its ciphertext only, and neither password anywhere", () => {
    expect(record).toMatchObject({ status: "completed", response_status: 200 });
    expect(record?.response_ciphertext).not.toBeNull();
    const session = first.body.session as { accessToken: string; refreshToken: string };
    for (const secret of [
      body.currentPassword,
      body.newPassword,
      session.accessToken,
      session.refreshToken,
    ]) {
      expect(plainColumns(record)).not.toContain(secret);
      expect(allLogText()).not.toContain(secret);
    }
  });
});
