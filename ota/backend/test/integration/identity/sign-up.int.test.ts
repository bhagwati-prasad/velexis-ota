// auth.signUp, auth.verifyEmail and auth.resendVerification through the API's whole pipeline, with the worker sending
// the verification e-mails to Mailpit (OBE-032; flows/my-bookings-and-guest-lookup.md §3 steps 1–2, api-changes §2.2,
// OADR-0006 points 2 and 4, ADR-0008), against PostgreSQL 16, Redis 7 and Mailpit, in both modes: the hosted
// storefront's edge (cookies, CSRF, no token in any body) and key callers (bearer tokens in the body, never a cookie).
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned), writes the platform rows of
// two active tenants with a secret key each as the platform does, seeds their storefront settings as provisioning
// does, and starts both processes in-process: the API (createTestApp) and the worker (WorkerModule.forRoot, whose
// ota-notifications consumer renders and sends the outbox's e-mails through Mailpit's SMTP port). The schedulers the
// worker registers are removed: the `notify` job that follows each commit is what sends. Each test signs up from IP
// addresses of its own (`X-Forwarded-For` through the trusted loopback proxy for the edge, `X-Velexis-End-User-IP`
// for the secret key) and with addresses of its own (`uniqueEmail`), so the limits of 5 per hour per IP and 3 per
// hour per address never mix the tests, and every e-mail is found by its recipient. Scenarios that wait for Mailpit run
// in their `beforeAll` hook with a budget of their own; the tests only read what they left. Passwords are made up per
// run; no value is a secret.
import { randomBytes, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { hashApiKey, sha256Hex } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
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
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { APP_DIR, loadWorkerConfig } from "../../../src/config";
import { BOOKING_CLAIMED_EVENT } from "../../../src/identity/customers.repository";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
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
 * Cloning the template, starting the API's graph (it parses the OTA document and compiles its validators) and the
 * worker's (BullMQ connections, the scheduler registration): a few seconds alone, more while every package's
 * integration tests run on a 4-CPU CI runner. The bound only stops a start-up that hangs.
 */
const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/**
 * A scenario signs up (one Argon2id hash), waits for the worker to send through Mailpit and verifies: well under a
 * second each locally; the bound allows for CI load and only stops a scenario that hangs.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for one e-mail. */
const MAIL_WAIT_MS = 20_000;

const ALPHA_HOST = "alpha.ota.example.com";

/** The legal versions the tenants publish (`storefront.legal`), stored in their settings. */
const TERMS_VERSION = "2026-09-01";
const PRIVACY_VERSION = "2026-08-15";

/** A password made up for this run: long enough and not on the breached list. */
const PASSWORD = `Fjord-${randomBytes(9).toString("base64url")}`;

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
let alphaKey: string;
let betaKey: string;

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one client. */
const newIp = (): string => {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
};

/** The development SMTP_URL (Mailpit) of the environment, where the worker sends. */
function mailpitSmtpUrl(): string {
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig({ SMTP_URL: env.url({ protocols: ["smtp:"] }) }).SMTP_URL;
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

/** Runs `fn` in a transaction of `schema` as velexis_ota_app, on this file's own pool. */
function inTenant<T>(
  schema: "tenant_alpha" | "tenant_beta",
  fn: (trx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return tenantTx(tenantDb, schema as TenantSchema, fn);
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

/** A sign-up body for `email` with the storefront's terms version. */
function signUpBody(email: string, extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    email,
    password: PASSWORD,
    firstName: "Anna",
    lastName: "Berg",
    marketingConsent: false,
    termsVersion: TERMS_VERSION,
    ...extra,
  };
}

/** The verification token of the newest e-mail to `to` that the worker sent: read from its link. */
async function tokenOfMail(to: string, count = 1): Promise<{ token: string; link: string }> {
  let message = await waitForMessage({ to, timeoutMs: MAIL_WAIT_MS });
  const deadline = Date.now() + MAIL_WAIT_MS;
  // A second e-mail to the same address: wait until Mailpit holds `count` of them, then read the newest.
  while ((await mailpit.search({ to })).length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `tokenOfMail: ${count} e-mails to the address did not arrive within ${MAIL_WAIT_MS} ms`,
      );
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  const [newest] = await mailpit.search({ to });
  if (newest !== undefined) {
    message = await mailpit.get(newest.ID);
  }
  const link = extractLinks(message).find((url) => url.includes("/account/verify.html?token="));
  if (link === undefined) {
    throw new Error("tokenOfMail: the e-mail holds no verification link");
  }
  return { token: new URL(link).searchParams.get("token") ?? "", link };
}

/** The customer of `email` in `schema` with its identity, or `undefined`. */
async function customerRows(schema: "tenant_alpha" | "tenant_beta", email: string) {
  return inTenant(schema, async (trx) => {
    const customer = await trx
      .selectFrom("customers")
      .selectAll()
      .where(sql<string>`lower(email)`, "=", email.toLowerCase())
      .executeTakeFirst();
    if (customer === undefined) {
      return undefined;
    }
    const identity = await trx
      .selectFrom("customer_identities")
      .selectAll()
      .where("customer_id", "=", customer.id)
      .executeTakeFirstOrThrow();
    const consents = await trx
      .selectFrom("customer_consents")
      .selectAll()
      .where("customer_id", "=", customer.id)
      .orderBy("kind")
      .execute();
    const preferences = await trx
      .selectFrom("customer_preferences")
      .selectAll()
      .where("customer_id", "=", customer.id)
      .executeTakeFirst();
    return { customer, identity, consents, preferences };
  });
}

/**
 * The recipients of the verification e-mails queued for `email` at alpha (the outbox rows, written in the request's
 * transaction): final once the answer arrives, unlike Mailpit, which the worker reaches a moment later.
 */
async function queuedTo(email: string): Promise<string[]> {
  const rows = await inTenant("tenant_alpha", (trx) =>
    trx
      .selectFrom("notifications")
      .select("recipient")
      .where("template_key", "=", "auth.verify_email")
      .where(sql<string>`lower(recipient)`, "=", email.toLowerCase())
      .execute(),
  );
  return rows.map((row) => row.recipient);
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
function expectStorefrontCookie(cookie: SetCookie | undefined, httpOnly: boolean): void {
  expect(cookie).toBeDefined();
  const attributes = cookie?.attributes ?? [];
  const age = attributes.find((attribute) => attribute.startsWith("Max-Age="));
  expect(Number(age?.slice("Max-Age=".length))).toBeGreaterThan(0);
  expect(attributes).toEqual(expect.arrayContaining(["Path=/", "Secure", "SameSite=Lax"]));
  expect(attributes.includes("HttpOnly")).toBe(httpOnly);
  expect(attributes.some((attribute) => attribute.toLowerCase().startsWith("domain="))).toBe(false);
}

/** Every log line both applications wrote. */
function allLogText(): string {
  return `${api.sink.text()}\n${workerSink.text()}`;
}

beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators compile on their first check (about a second for signUp's): here, for every status the
  // tests check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["signUp", [201, 400, 403, 409, 422, 429]],
    ["verifyEmail", [200, 400, 409]],
    ["resendEmailVerification", [202, 400, 403, 429]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
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
  ({ apiKey: alphaKey } = await insertTenant("alpha"));
  ({ apiKey: betaKey } = await insertTenant("beta"));
  // The settings rows as provisioning seeds them (verification not required, accounts on), with legal versions.
  for (const [schema, name] of [
    ["tenant_alpha", "Alpha Travel"],
    ["tenant_beta", "Beta Travel"],
  ] as const) {
    await inTenant(schema, async (trx) => {
      await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
      await trx
        .updateTable("storefront_settings")
        .set({ terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION })
        .execute();
    });
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

describe("[OBE-032 AC1] sign-up, then the e-mailed link", () => {
  const email = uniqueEmail("obe032-verify");
  const visitor = new Visitor();
  const confirmKey = randomUUID();
  let published: Response;
  let signedUp: Response;
  let mail: { token: string; link: string };
  let confirmed: Response;
  let replayed: Response;
  let again: Response;
  let rows: Awaited<ReturnType<typeof customerRows>>;

  beforeAll(async () => {
    published = await visitor.get("/v1/storefront");
    signedUp = await visitor.post(
      "/v1/auth/sign-up",
      signUpBody(email, { locale: "en-GB", currency: "EUR" }),
    );
    mail = await tokenOfMail(email);
    confirmed = await visitor.post("/v1/auth/email-verification/confirm", { token: mail.token }, confirmKey);
    replayed = await visitor.post("/v1/auth/email-verification/confirm", { token: mail.token }, confirmKey);
    again = await visitor.post("/v1/auth/email-verification/confirm", { token: mail.token });
    rows = await customerRows("tenant_alpha", email);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-032 AC1] creates the customer, its identity, preferences and consents, and answers 201", () => {
    expect(published.body.legal).toMatchObject({
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    });
    expect(signedUp.status).toBe(201);
    expectResponseToMatch("signUp", signedUp);
    expect(signedUp.headers["location"]).toBe("/v1/account");
    expect(signedUp.headers["cache-control"]).toBe("no-store");
    expect(signedUp.body.customer).toMatchObject({
      email,
      emailVerified: false,
      firstName: "Anna",
      lastName: "Berg",
      status: "active",
      marketingConsent: { granted: false, source: "sign_up" },
      termsAcceptedVersion: TERMS_VERSION,
      version: 1,
    });
    expect(signedUp.body.emailVerification).toMatchObject({
      policy: "not_required",
      verified: false,
      sentTo: expect.stringMatching(/^o\*\*\*@example\.com$/) as string,
    });
    const expiresIn = Date.parse(signedUp.body.emailVerification.expiresAt as string) - Date.now();
    expect(expiresIn).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(expiresIn).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

    expect(rows?.customer).toMatchObject({ status: "active", email_verified_at: expect.any(Date) as Date });
    expect(rows?.identity).toMatchObject({
      provider: "password",
      provider_subject: email.toLowerCase(),
      verification_token_hash: sha256Hex(mail.token),
    });
    expect(rows?.identity.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(rows?.preferences).toMatchObject({ locale: "en", currency: "EUR" });
    expect(
      rows?.consents.map((consent) => [
        consent.kind,
        consent.policy_version,
        consent.granted,
        consent.source,
      ]),
    ).toEqual([
      ["marketing", null, false, "sign_up"],
      ["privacy", PRIVACY_VERSION, true, "sign_up"],
      ["terms", TERMS_VERSION, true, "sign_up"],
    ]);
  });

  it("[OBE-032 AC1] e-mails a link to /account/verify.html on the storefront host, with the token only in the link", async () => {
    expect(mail.link).toBe(`https://${ALPHA_HOST}/account/verify.html?token=${mail.token}`);
    expect(mail.token).toMatch(/^vt_[A-Za-z0-9_-]{43}$/);
    const notifications = await inTenant("tenant_alpha", (trx) =>
      trx.selectFrom("notifications").selectAll().where("recipient", "=", email).execute(),
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      template_key: "auth.verify_email",
      status: "sent",
      secret_payload_ciphertext: null,
    });
    expect(JSON.stringify(notifications)).not.toContain(mail.token);
    // Neither the token nor the password reaches a log line of either process.
    expect(allLogText()).not.toContain(mail.token);
    expect(allLogText()).not.toContain(PASSWORD);
  });

  it("[OBE-032 AC1] verifies the address with the link's token", () => {
    expect(confirmed.status).toBe(200);
    expectResponseToMatch("verifyEmail", confirmed);
    expect(confirmed.body).toMatchObject({
      customer: { email, emailVerified: true, status: "active", version: 2 },
      verifiedEmail: email,
      emailChanged: false,
      claimedGuestBookings: 0,
      returnPath: null,
    });
    expect(Date.parse(confirmed.body.customer.emailVerifiedAt as string)).toBe(
      rows?.customer.email_verified_at?.getTime(),
    );
  });

  it("[OBE-032 AC1] uses the token once: the same key replays the answer, a new key answers 400 used", () => {
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(confirmed.body);
    expect(again.status).toBe(400);
    expectResponseToMatch("verifyEmail", again);
    expect(again.body.error).toMatchObject({
      code: "VERIFICATION_TOKEN_INVALID",
      details: { reason: "used" },
    });
  });
});

describe("[OBE-032 AC1] the token expires, and a resend replaces it", () => {
  const email = uniqueEmail("obe032-expire");
  // The secret key exists once the file's setup ran: the client is made in the scenario's hook.
  let client: KeyClient;
  let first: { token: string };
  let expired: Response;
  let resent: Response;
  let second: { token: string };
  let replaced: Response;
  let verified: Response;

  beforeAll(async () => {
    client = new KeyClient();
    const signedUp = await client.post("/v1/auth/sign-up", signUpBody(email));
    expect(signedUp.status).toBe(201);
    first = await tokenOfMail(email);
    // A day later: the link has expired (its expiry moved into the past), and its e-mail is more than a minute old.
    await inTenant("tenant_alpha", (trx) =>
      trx
        .updateTable("customer_identities")
        .set({
          verification_expires_at: new Date(Date.now() - 1000),
          verification_sent_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
        })
        .where("provider_subject", "=", email.toLowerCase())
        .execute(),
    );
    expired = await client.post("/v1/auth/email-verification/confirm", { token: first.token });
    resent = await client.post("/v1/auth/email-verification/resend", { email });
    second = await tokenOfMail(email, 2);
    replaced = await client.post("/v1/auth/email-verification/confirm", { token: first.token });
    verified = await client.post("/v1/auth/email-verification/confirm", { token: second.token });
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-032 AC1] answers 400 expired for a token past its 24 hours", () => {
    expect(expired.status).toBe(400);
    expectResponseToMatch("verifyEmail", expired);
    expect(expired.body.error).toMatchObject({
      code: "VERIFICATION_TOKEN_INVALID",
      details: { reason: "expired" },
    });
  });

  it("[OBE-032 AC1] a resend sends a new link; the old token is then unknown and the new one verifies", () => {
    expect(resent.status).toBe(202);
    expectResponseToMatch("resendEmailVerification", resent);
    expect(second.token).not.toBe(first.token);
    expect(replaced.body.error).toMatchObject({
      code: "VERIFICATION_TOKEN_INVALID",
      details: { reason: "unknown" },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.customer.emailVerified).toBe(true);
  });
});

describe("auth.resendVerification never tells whether an address has an account", () => {
  const unverified = uniqueEmail("obe032-resend-unverified");
  const verified = uniqueEmail("obe032-resend-verified");
  const unknown = uniqueEmail("obe032-resend-unknown");
  let client: KeyClient;
  let answers: Response[];
  let signedInResend: Response;
  let missingEmail: Response;

  beforeAll(async () => {
    client = new KeyClient();
    const signedUp = await client.post("/v1/auth/sign-up", signUpBody(unverified));
    const other = await new KeyClient().post("/v1/auth/sign-up", signUpBody(verified));
    await tokenOfMail(unverified);
    const { token } = await tokenOfMail(verified);
    await new KeyClient().post("/v1/auth/email-verification/confirm", { token });
    // The unverified address's e-mail is more than a minute old, so a resend may send again.
    await inTenant("tenant_alpha", (trx) =>
      trx
        .updateTable("customer_identities")
        .set({ verification_sent_at: new Date(Date.now() - 2 * 60 * 1000) })
        .where("provider_subject", "=", unverified.toLowerCase())
        .execute(),
    );
    answers = [
      await new KeyClient().post("/v1/auth/email-verification/resend", { email: unknown }),
      await new KeyClient().post("/v1/auth/email-verification/resend", { email: verified }),
      await new KeyClient().post("/v1/auth/email-verification/resend", { email: unverified }),
    ];
    await tokenOfMail(unverified, 2);
    // Signed in with the token of sign-up: within a minute of the last e-mail, nothing is sent, the answer is the same.
    signedInResend = await client.post(
      "/v1/auth/email-verification/resend",
      {},
      { Authorization: `Bearer ${signedUp.body.session.accessToken as string}` },
    );
    missingEmail = await new KeyClient().post("/v1/auth/email-verification/resend", {});
    expect(other.status).toBe(201);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-032] answers the same 202 for an unknown, a verified and an unverified address", () => {
    expect(answers.map((res) => res.status)).toEqual([202, 202, 202]);
    for (const res of answers) {
      expectResponseToMatch("resendEmailVerification", res);
      expect(res.body).toEqual(answers[0]?.body);
    }
    expect(signedInResend.status).toBe(202);
    expect(signedInResend.body).toEqual(answers[0]?.body);
  });

  it("[OBE-032] sends only to the unverified address, at most once a minute", async () => {
    // The outbox is final when the answers arrive (the e-mails are queued in their transactions); Mailpit agrees.
    expect(await queuedTo(unknown)).toEqual([]);
    expect(await queuedTo(verified)).toHaveLength(1);
    expect(await queuedTo(unverified)).toHaveLength(2);
    expect(await mailpit.search({ to: unknown })).toEqual([]);
    expect(await mailpit.search({ to: verified })).toHaveLength(1);
    expect(await mailpit.search({ to: unverified })).toHaveLength(2);
  });

  it("[OBE-032] needs an address without a signed-in customer", () => {
    expect(missingEmail.status).toBe(400);
    expect(missingEmail.body.error).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [{ path: "/email", code: "required" }],
    });
  });

  it("[OBE-032] answers 429 RATE_LIMITED from the fourth request for one address within the hour (architecture §8)", async () => {
    const address = uniqueEmail("obe032-resend-limit");

    // Four callers of their own, so only the limit per address can refuse.
    const answers: Response[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      answers.push(await new KeyClient().post("/v1/auth/email-verification/resend", { email: address }));
    }

    expect(answers.map((res) => res.status)).toEqual([202, 202, 202, 429]);
    expectResponseToMatch("resendEmailVerification", answers[3] as Response);
    expect(answers[3]?.body.error.code).toBe("RATE_LIMITED");
    expect(Number(answers[3]?.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("auth.resendVerification while an address change is pending", () => {
  const current = uniqueEmail("obe032-pending-current");
  const pending = uniqueEmail("obe032-pending-next");
  let anonymous: Response;
  let anonymousQueued: string[];
  let signedIn: Response;

  beforeAll(async () => {
    const client = new KeyClient();
    const signedUp = await client.post("/v1/auth/sign-up", signUpBody(current));
    expect(signedUp.status).toBe(201);
    // The address change of account.update (OBE-035), its e-mail more than a minute old: a resend may send again.
    await inTenant("tenant_alpha", async (trx) => {
      await trx
        .updateTable("customers")
        .set({ pending_email: pending })
        .where("id", "=", signedUp.body.customer.id as string)
        .execute();
      await trx
        .updateTable("customer_identities")
        .set({ verification_sent_at: new Date(Date.now() - 2 * 60 * 1000) })
        .where("customer_id", "=", signedUp.body.customer.id as string)
        .execute();
    });
    anonymous = await new KeyClient().post("/v1/auth/email-verification/resend", { email: current });
    anonymousQueued = await queuedTo(current);
    signedIn = await client.post(
      "/v1/auth/email-verification/resend",
      {},
      { Authorization: `Bearer ${signedUp.body.session.accessToken as string}` },
    );
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-032] mails the current address no link, which would confirm the pending one", () => {
    expect(anonymous.status).toBe(202);
    expect(anonymousQueued).toEqual([current]);
  });

  it("[OBE-032] mails the signed-in customer's link to the pending address", async () => {
    expect(signedIn.status).toBe(202);
    expect(await queuedTo(pending)).toEqual([pending]);
    expect(await queuedTo(current)).toEqual([current]);
  });
});

describe("[OBE-032 AC2] one address at two tenants", () => {
  it("[OBE-032 AC2] creates two customers; a duplicate at one tenant answers 409 EMAIL_ALREADY_REGISTERED", async () => {
    const email = uniqueEmail("obe032-two-tenants");

    const atAlpha = await new KeyClient(alphaKey).post("/v1/auth/sign-up", signUpBody(email));
    const atBeta = await new KeyClient(betaKey).post("/v1/auth/sign-up", signUpBody(email));
    const duplicate = await new KeyClient(alphaKey).post("/v1/auth/sign-up", signUpBody(email.toUpperCase()));

    expect([atAlpha.status, atBeta.status]).toEqual([201, 201]);
    expect(atAlpha.body.customer.id).not.toBe(atBeta.body.customer.id);
    expect(duplicate.status).toBe(409);
    expectResponseToMatch("signUp", duplicate);
    expect(duplicate.body.error).toMatchObject({
      code: "EMAIL_ALREADY_REGISTERED",
      fieldErrors: [{ path: "/email", code: "taken" }],
    });
    const alphaRows = await customerRows("tenant_alpha", email);
    const betaRows = await customerRows("tenant_beta", email);
    expect(alphaRows?.customer.id).toBe(atAlpha.body.customer.id);
    expect(betaRows?.customer.id).toBe(atBeta.body.customer.id);
    const alphaCount = await inTenant("tenant_alpha", (trx) =>
      trx
        .selectFrom("customers")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where(sql<string>`lower(email)`, "=", email.toLowerCase())
        .executeTakeFirstOrThrow(),
    );
    expect(alphaCount.count).toBe("1");
  });

  it("[OBE-032 AC2] makes one customer of two sign-ups of one address at the same time", async () => {
    const email = uniqueEmail("obe032-race");

    const answers = await Promise.all([
      new KeyClient().post("/v1/auth/sign-up", signUpBody(email)),
      new KeyClient().post("/v1/auth/sign-up", signUpBody(email)),
    ]);

    expect(answers.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(answers.find((res) => res.status === 409)?.body.error.code).toBe("EMAIL_ALREADY_REGISTERED");
  });

  it(
    "[OBE-032 AC2] does not find the token of one tenant at the other",
    async () => {
      const email = uniqueEmail("obe032-token-tenant");
      await new KeyClient(betaKey).post("/v1/auth/sign-up", signUpBody(email));
      const { token } = await tokenOfMail(email);

      const atAlpha = await new KeyClient(alphaKey).post("/v1/auth/email-verification/confirm", { token });

      expect(atAlpha.status).toBe(400);
      expect(atAlpha.body.error.details).toEqual({ reason: "unknown" });
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe("[OBE-032 AC3] the session of a sign-up", () => {
  it("[OBE-032 AC3] edge mode: session null in the body, the session in cookies and a new CSRF value", async () => {
    const visitor = new Visitor();
    const csrfBefore = visitor.jar.get("__Host-vx_csrf");

    const res = await visitor.post("/v1/auth/sign-up", signUpBody(uniqueEmail("obe032-edge")));

    expect(res.status).toBe(201);
    expectResponseToMatch("signUp", res);
    // Verification is off at alpha (the seeded settings).
    expect(res.body.emailVerification.policy).toBe("not_required");
    expect(res.body.session).toBeNull();
    const cookies = setCookies(res);
    expectStorefrontCookie(cookies.get("__Host-vx_at"), true);
    expectStorefrontCookie(cookies.get("__Host-vx_rt"), true);
    expectStorefrontCookie(cookies.get("__Host-vx_csrf"), false);
    expect(cookies.get("__Host-vx_csrf")?.value).not.toBe(csrfBefore);
    expect(
      holdsNoToken(res.body, [
        cookies.get("__Host-vx_at")?.value ?? "",
        cookies.get("__Host-vx_rt")?.value ?? "",
      ]),
    ).toBe(true);
    // The cookies are a session: getSession answers for the new customer.
    const session = await visitor.get("/v1/auth/session");
    expect(session.status).toBe(200);
    expect(session.body.customer.id).toBe(res.body.customer.id);
  });

  it("[OBE-032 AC3] bearer mode: the tokens in the body, never a cookie", async () => {
    const client = new KeyClient();

    const res = await client.post("/v1/auth/sign-up", signUpBody(uniqueEmail("obe032-bearer")));

    expect(res.status).toBe(201);
    expectResponseToMatch("signUp", res);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body.session).toMatchObject({
      tokenType: "Bearer",
      subject: { type: "customer", id: res.body.customer.id as string },
      refreshToken: expect.stringMatching(/^rt_/) as string,
    });
    const days = (Date.parse(res.body.session.refreshTokenExpiresAt as string) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    const session = await client.get("/v1/auth/session", res.body.session.accessToken as string);
    expect(session.status).toBe(200);
    expect(session.body.customer.id).toBe(res.body.customer.id);
  });

  it("[OBE-032 AC3] opens a session too while verification is required before checkout", async () => {
    const setRequired = (required: boolean) =>
      inTenant("tenant_beta", (trx) =>
        trx.updateTable("storefront_settings").set({ require_email_verification: required }).execute(),
      );
    await setRequired(true);
    try {
      const res = await new KeyClient(betaKey).post(
        "/v1/auth/sign-up",
        signUpBody(uniqueEmail("obe032-required")),
      );

      expect(res.status).toBe(201);
      expect(res.body.emailVerification.policy).toBe("required_before_checkout");
      expect(res.body.customer.status).toBe("active");
      expect(res.body.session.accessToken).toEqual(expect.any(String));
    } finally {
      await setRequired(false);
    }
  });

  it("[OBE-032 AC3] replays a sign-up with its session for 5 minutes, then without one", async () => {
    const client = new KeyClient();
    const key = randomUUID();
    const body = signUpBody(uniqueEmail("obe032-replay"));

    const first = await client.post("/v1/auth/sign-up", body, { "Idempotency-Key": key });
    const soon = await client.post("/v1/auth/sign-up", body, { "Idempotency-Key": key });
    await inTenant("tenant_alpha", (trx) =>
      trx
        .updateTable("idempotency_keys")
        .set({ created_at: new Date(Date.now() - 6 * 60 * 1000) })
        .where("key", "=", key)
        .execute(),
    );
    const later = await client.post("/v1/auth/sign-up", body, { "Idempotency-Key": key });

    expect([first.status, soon.status, later.status]).toEqual([201, 201, 201]);
    expect(soon.body).toEqual(first.body);
    expect(later.body).toEqual({ ...first.body, session: null });
  });

  it("[OBE-032 AC3] replays an edge sign-up's cookies for 5 minutes only", async () => {
    // A browser that missed the answer retries with the cookies it held before (its CSRF value is the idempotency
    // principal of a visitor without a session).
    const visitor = new Visitor();
    const before = new Map(visitor.jar);
    const retryAsBefore = (): void => {
      visitor.jar.clear();
      for (const [name, value] of before) {
        visitor.jar.set(name, value);
      }
    };
    const key = randomUUID();
    const body = signUpBody(uniqueEmail("obe032-edge-replay"));

    const first = await visitor.post("/v1/auth/sign-up", body, key);
    retryAsBefore();
    const soon = await visitor.post("/v1/auth/sign-up", body, key);
    retryAsBefore();
    await inTenant("tenant_alpha", (trx) =>
      trx
        .updateTable("idempotency_keys")
        .set({ created_at: new Date(Date.now() - 6 * 60 * 1000) })
        .where("key", "=", key)
        .execute(),
    );
    const later = await visitor.post("/v1/auth/sign-up", body, key);

    expect([first.status, soon.status, later.status]).toEqual([201, 201, 201]);
    expect(soon.body).toEqual(first.body);
    expect(setCookies(soon).get("__Host-vx_at")?.value).toBe(setCookies(first).get("__Host-vx_at")?.value);
    expect(setCookies(soon).get("__Host-vx_rt")?.value).toBe(setCookies(first).get("__Host-vx_rt")?.value);
    expect(later.body).toEqual(first.body);
    expect(later.headers["set-cookie"]).toBeUndefined();
  });
});

describe("auth.signUp refusals", () => {
  it("[OBE-032] answers 422 PASSWORD_TOO_WEAK for a short or a breached password, never quoting it", async () => {
    const client = new KeyClient();
    const short = await client.post(
      "/v1/auth/sign-up",
      signUpBody(uniqueEmail("obe032-short"), { password: "Fjord-La4" }),
    );
    const breached = await client.post(
      "/v1/auth/sign-up",
      signUpBody(uniqueEmail("obe032-breached"), { password: "1234567890" }),
    );

    for (const res of [short, breached]) {
      expect(res.status).toBe(422);
      expectResponseToMatch("signUp", res);
      expect(res.body.error.fieldErrors).toEqual([
        { path: "/password", code: "too_weak", message: expect.any(String) as string },
      ]);
    }
    expect(short.body.error.details).toEqual({ violations: ["minLength"] });
    expect(breached.body.error.details).toEqual({ violations: ["breached"] });
    expect(JSON.stringify([short.body, breached.body])).not.toMatch(/Fjord-La4|1234567890/);
  });

  it("[OBE-032] answers 400 VALIDATION_FAILED without the terms version, or with an older one", async () => {
    const client = new KeyClient();
    const { termsVersion: _omitted, ...withoutTerms } = signUpBody(uniqueEmail("obe032-no-terms"));
    const missing = await client.post("/v1/auth/sign-up", withoutTerms);
    const outdated = await client.post(
      "/v1/auth/sign-up",
      signUpBody(uniqueEmail("obe032-old-terms"), { termsVersion: "2020-01-01" }),
    );

    expect(missing.body.error.fieldErrors).toEqual([
      { path: "/termsVersion", code: "required", message: expect.any(String) as string },
    ]);
    expect(outdated.body.error.fieldErrors).toEqual([
      { path: "/termsVersion", code: "outdated", message: expect.any(String) as string },
    ]);
    for (const res of [missing, outdated]) {
      expect([res.status, res.body.error.code]).toEqual([400, "VALIDATION_FAILED"]);
      expectResponseToMatch("signUp", res);
    }
  });

  it("[OBE-032] answers 403 FEATURE_DISABLED while customer accounts are off", async () => {
    const setAccounts = (enabled: boolean) =>
      inTenant("tenant_beta", (trx) =>
        trx.updateTable("storefront_settings").set({ customer_accounts_enabled: enabled }).execute(),
      );
    await setAccounts(false);
    try {
      const client = new KeyClient(betaKey);
      const signUp = await client.post("/v1/auth/sign-up", signUpBody(uniqueEmail("obe032-feature")));
      const resend = await client.post("/v1/auth/email-verification/resend", {
        email: uniqueEmail("obe032-feature"),
      });

      for (const res of [signUp, resend]) {
        expect([res.status, res.body.error.code, res.body.error.details]).toEqual([
          403,
          "FEATURE_DISABLED",
          { feature: "customerAccounts" },
        ]);
      }
    } finally {
      await setAccounts(true);
    }
  });
});

describe("auth.verifyEmail: guest bookings and address changes", () => {
  /** A booking of `environment` at alpha with contact `email`, a guest's unless `customerId` is given; its id. */
  async function insertGuestBooking(
    email: string,
    environment: "test" | "live" = "test",
    customerId: string | null = null,
  ): Promise<string> {
    const id = newId("bkg");
    const departure = new Date(Date.now() + 30 * 86_400_000);
    await inTenant("tenant_alpha", (trx) =>
      trx
        .insertInto("bookings")
        .values({
          id,
          environment,
          reference: newBookingReference(),
          status: "confirmed",
          ticketing_status: "pending",
          trip_type: "one_way",
          origin_iata: "MAD",
          destination_iata: "ORY",
          first_departure_at: departure,
          last_arrival_at: new Date(departure.getTime() + 2 * 60 * 60 * 1000),
          travelers_count: 1,
          currency: "EUR",
          net_amount: "98.47",
          total_amount: "110.47",
          contact_email: email,
          lead_last_name: "BERG",
          customer_id: customerId,
        })
        .execute(),
    );
    return id;
  }

  /** Gives `customerId` a verification token of the test's own, as account.update's address change will. */
  async function setToken(customerId: string, token: string, pendingEmail: string | null): Promise<void> {
    await inTenant("tenant_alpha", async (trx) => {
      await trx
        .updateTable("customers")
        .set({ pending_email: pendingEmail })
        .where("id", "=", customerId)
        .execute();
      await trx
        .updateTable("customer_identities")
        .set({
          verification_token_hash: sha256Hex(token),
          verification_sent_at: new Date(),
          verification_expires_at: new Date(Date.now() + 60 * 60 * 1000),
        })
        .where("customer_id", "=", customerId)
        .execute();
    });
  }

  const newToken = (): string => `vt_${randomBytes(32).toString("base64url")}`;

  it("[OBE-032] attaches the guest bookings of the verified address and environment that have no customer", async () => {
    const email = uniqueEmail("obe032-claim");
    const client = new KeyClient();
    const signedUp = await client.post("/v1/auth/sign-up", signUpBody(email));
    const customerId = signedUp.body.customer.id as string;
    // Another customer's booking made with this address (booked while signed in to that account) stays theirs.
    const owner = await new KeyClient().post(
      "/v1/auth/sign-up",
      signUpBody(uniqueEmail("obe032-claim-owner")),
    );
    const ownerId = owner.body.customer.id as string;
    const guest = await insertGuestBooking(email.toUpperCase());
    const live = await insertGuestBooking(email, "live");
    const other = await insertGuestBooking(uniqueEmail("obe032-claim-other"));
    const owned = await insertGuestBooking(email, "test", ownerId);
    const token = newToken();
    await setToken(customerId, token, null);

    const res = await client.post("/v1/auth/email-verification/confirm", { token });

    expect(res.status).toBe(200);
    expect(res.body.claimedGuestBookings).toBe(1);
    const bookings = await inTenant("tenant_alpha", (trx) =>
      trx
        .selectFrom("bookings")
        .select(["id", "customer_id"])
        .where("id", "in", [guest, live, other, owned])
        .execute(),
    );
    expect(new Map(bookings.map((booking) => [booking.id, booking.customer_id]))).toEqual(
      new Map([
        [guest, customerId],
        [live, null],
        [other, null],
        [owned, ownerId],
      ]),
    );
    const events = await inTenant("tenant_alpha", (trx) =>
      trx.selectFrom("booking_events").selectAll().where("booking_id", "=", guest).execute(),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: BOOKING_CLAIMED_EVENT,
        actor_type: "customer",
        actor_id: customerId,
        visible_to_customer: true,
      }),
    ]);
  });

  it("[OBE-032] confirms a pending address: it becomes the address and the sign-in subject", async () => {
    const email = uniqueEmail("obe032-change-from");
    const next = uniqueEmail("obe032-change-to");
    const client = new KeyClient();
    const signedUp = await client.post("/v1/auth/sign-up", signUpBody(email));
    const customerId = signedUp.body.customer.id as string;
    const token = newToken();
    await setToken(customerId, token, next);

    const res = await client.post("/v1/auth/email-verification/confirm", { token });

    expect(res.status).toBe(200);
    expectResponseToMatch("verifyEmail", res);
    expect(res.body).toMatchObject({
      customer: { email: next, pendingEmail: null, emailVerified: true },
      verifiedEmail: next,
      emailChanged: true,
    });
    const rows = await customerRows("tenant_alpha", next);
    expect(rows?.identity.provider_subject).toBe(next.toLowerCase());
    const signIn = await client.post("/v1/auth/sign-in", { email: next, password: PASSWORD });
    expect(signIn.status).toBe(200);
  });

  it("[OBE-032] answers 409 when another customer holds the pending address", async () => {
    const email = uniqueEmail("obe032-taken-from");
    const taken = uniqueEmail("obe032-taken");
    const client = new KeyClient();
    const signedUp = await client.post("/v1/auth/sign-up", signUpBody(email));
    await new KeyClient().post("/v1/auth/sign-up", signUpBody(taken));
    const token = newToken();
    await setToken(signedUp.body.customer.id as string, token, taken);

    const res = await client.post("/v1/auth/email-verification/confirm", { token });

    expect(res.status).toBe(409);
    expectResponseToMatch("verifyEmail", res);
    expect(res.body.error.code).toBe("EMAIL_ALREADY_REGISTERED");
    const rows = await customerRows("tenant_alpha", email);
    expect(rows?.customer).toMatchObject({ pending_email: taken, email_verified_at: null });
  });
});
