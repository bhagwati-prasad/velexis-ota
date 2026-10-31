// The OTA's own Stripe API keys and the return to Velexis payments end to end (PBE-057;
// flows/stripe-payments-account.md §D and §E, PADR-0010, PADR-0011 items 5 and 6; scope PF-62). The API
// (createTestApp) takes `submitStripeApiKeys`, `useVelexisPayments` and `listPaymentConnections` on this file's
// database clone; the worker's module graph (WorkerModule, as dist/worker.js builds it, with the API's FakeClock) runs
// `credentials.verify` from the same Redis database with the real `stripe_api_keys` verifier it registers
// (StripeApiKeysVerifier). Both graphs share one FakeStripe in place of the Stripe client: `GET /v1/account` answers
// the account `grantOwnKey` gave a key and 401 for any other key, and nothing reaches Stripe.
//
// Each test arranges its own OTA: an owner and an admin with MFA, a finance member, an agent, a viewer, an owner
// without MFA, a stranger and the `velexis` test connection. The milestone switch is a stand-in this file turns on (as
// stripe-connect.int.test.ts does), so one test can turn it off. A delayed retry is promoted at once instead of waiting
// for its backoff (ADR-0009: 30 s, then doubling). The secret keys and webhook secrets are random per test, and after
// every test no log line of either process (at `trace`), no Redis value (the jobs, their data, results and errors) and
// no audit, outbox, submission or connection row holds one in clear; every address is a `uniqueEmail` of this file
// (Mailpit is shared). The Stripe settings are the development values of `.env.example`.
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { sha256Hex } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail } from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import Stripe from "stripe";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { secretPlace } from "../../../src/common/credentials/credential-submissions.repository";
import { CredentialVerifiers } from "../../../src/common/credentials/credentials-verify.processor";
import { associatedData, EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURE_VARIABLES,
  FeatureSwitches,
  FEATURES,
  featuresFor,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { idempotencyKey, StripeClient } from "../../../src/common/stripe/stripe.client";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import {
  STRIPE_WEBHOOK_EVENTS,
  stripeKeyProblems,
} from "../../../src/payment-connections/stripe-api-keys.service";
import {
  connectionSecretPlace,
  connectionWebhookSecretPlace,
  keyModeOf,
  storedKeysProblem,
  StripeApiKeysVerifier,
  stripeKeyCheckOf,
} from "../../../src/payment-connections/stripe-api-keys.verifier";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertPaymentConnection,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember, insertOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FakeStripe } from "../../support/fake-stripe";

/**
 * The database clone, the API's and the worker's Nest module graphs and the platform document of
 * expectResponseToMatch; the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish a submission (it takes milliseconds; under Vitest's 5 s). */
const WAIT = { timeout: 3_000, interval: 20 } as const;
/** How long a test waits for an event on `vx:invalidate` (delivered within milliseconds when it is sent). */
const EVENT_WAIT = { timeout: 2_000, interval: 20 } as const;
/** The first number of this file's ids (`testId`), away from the other test files'. */
const FIRST_ID = 57_000;
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.57";
const SESSION = testId("asn", FIRST_ID);
/** The Stripe settings of the application: the development values of `.env.example`. */
const STRIPE_ENV = Object.freeze({
  STRIPE_SECRET_KEY: "sk_test_replace_me",
  STRIPE_CONNECT_CLIENT_ID: "ca_replace_me",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_replace_me",
});
/** The OTA API host of the test applications' STOREFRONT_BASE_DOMAIN (`ota.example.com`). */
const WEBHOOK_BASE = "https://api.ota.example.com/webhooks/stripe/c/";

type Row = Record<string, unknown>;
type Who = TenantRole | "ownerWithoutMfa" | "stranger";

/** The milestone switches of the API: `own_stripe` on unless a test turns it off. */
class TestSwitches {
  readonly on = new Set<Feature>();

  isEnabled(feature: Feature): boolean {
    return this.on.has(feature);
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(
        FEATURES.map((feature) => [FEATURE_VARIABLES[feature], this.on.has(feature)]),
      ) as FeatureConfig,
    );
  }
}

const switches = new TestSwitches();
const stripe = new FakeStripe();
const workerLogs = new LogSink();
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let tokens: TokenService;
let envelope: EnvelopeService;
let connectionsQueue: Queue;
let subscriber: Redis;
let next = FIRST_ID + 1;
/** Every `vx:invalidate` event received. */
const events: InvalidationEvent[] = [];
/** The secrets of the current test: none may appear in clear in a log line, a Redis value or a row. */
const secretsOfTest: string[] = [];

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs and the platform document.
  t = await createTestApp({
    env: { LOG_LEVEL: "trace", ...STRIPE_ENV },
    overrides: [
      { provide: FeatureSwitches, useValue: switches },
      { provide: StripeClient, useValue: stripe },
    ],
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  envelope = t.app.get(EnvelopeService, { strict: false });
  connectionsQueue = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.connections), { strict: false });
  responseChecker("platform");

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .overrideProvider(StripeClient)
    .useValue(stripe)
    .compile();
  await worker.init();

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    events.push(JSON.parse(message) as InvalidationEvent);
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(() => {
  switches.on.clear();
  switches.on.add("own_stripe");
  stripe.reset();
  secretsOfTest.length = 0;
});

afterEach(async () => {
  // A paused queue is resumed for the next test, whatever this one did.
  if (await connectionsQueue.isPaused()) {
    await connectionsQueue.resume();
  }
  await expectNoSecretAnywhere();
});

// ---- Arrangement ---------------------------------------------------------------------------------------------------

/** An OTA of this file: its people and its `velexis` test connection. */
interface Ota {
  readonly tenant: PlatformRow<"tenants">;
  readonly people: ReadonlyMap<Who, PlatformRow<"accounts">>;
  readonly connection: PlatformRow<"payment_provider_connections">;
}

async function arrangeOta(): Promise<Ota> {
  const n = next++;
  const { tenant } = await insertOta(pool, {
    tenant: { id: testId("ten", n), key: `sak${n}`, name: `Agency ${n} Travel` },
  });
  const people = new Map<Who, PlatformRow<"accounts">>();
  for (const role of TENANT_ROLES) {
    const account = await insertAccount(pool, {
      id: testId("acc", next++),
      email: uniqueEmail(`${role}-pbe057`),
      full_name: `${role} ${n}`,
      mfa_enabled: role === "owner" || role === "admin",
    });
    await insertMember(pool, tenant, account, role);
    people.set(role, account);
  }
  const ownerWithoutMfa = await insertAccount(pool, { id: testId("acc", next++) });
  await insertMember(pool, tenant, ownerWithoutMfa, "owner");
  people.set("ownerWithoutMfa", ownerWithoutMfa);
  people.set("stranger", await insertAccount(pool, { id: testId("acc", next++), mfa_enabled: true }));
  const connection = await insertPaymentConnection(pool, tenant, {
    id: testId("ppc", n),
    statement_descriptor_suffix: `AGENCY ${n}`,
  });
  return { tenant, people, connection };
}

function person(ota: Ota, who: Who): PlatformRow<"accounts"> {
  const account = ota.people.get(who);
  if (account === undefined) {
    throw new Error(`no ${who} in the OTA`);
  }
  return account;
}

/** A Stripe account id of this file, unique per call. */
const newAccountId = (): string => `acct_1TestPbe057Agency${next++}`;

/** The keys of one submission: a random secret (or restricted) key and webhook secret of this test. */
interface Keys {
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly webhookSecret: string;
}

function newKeys(environment: "test" | "live" = "test", kind: "sk" | "rk" = "sk"): Keys {
  const keys = {
    publishableKey: `pk_${environment}_${randomBytes(12).toString("hex")}`,
    secretKey: `${kind}_${environment}_${randomBytes(18).toString("hex")}`,
    webhookSecret: `whsec_${randomBytes(18).toString("hex")}`,
  };
  secretsOfTest.push(keys.secretKey, keys.webhookSecret);
  return keys;
}

/** The headers of a portal call by `who`, with a TOTP step-up now unless `stepUp` is false. */
async function portal(ota: Ota, who: Who, stepUp = true): Promise<Record<string, string>> {
  const nowSeconds = Math.floor(t.clock.now().getTime() / 1000);
  const { token } = await tokens.sign({
    aud: "portal",
    sub: person(ota, who).id,
    sid: SESSION,
    ev: true,
    amr: stepUp ? ["pwd", "otp"] : ["pwd"],
    ...(stepUp ? { mfa_at: nowSeconds } : {}),
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

async function submitKeys(
  ota: Ota,
  keys: Keys,
  environment: "test" | "live" = "test",
  who: Who = "owner",
  stepUp = true,
): Promise<Response> {
  return t.http
    .put(`/v1/tenants/${ota.tenant.id}/payment-connections/${environment}/api-keys`)
    .set(await portal(ota, who, stepUp))
    .send(keys);
}

async function useVelexis(
  ota: Ota,
  environment: "test" | "live" = "test",
  who: Who = "owner",
  stepUp = true,
): Promise<Response> {
  return t.http
    .post(`/v1/tenants/${ota.tenant.id}/payment-connections/${environment}/use-velexis`)
    .set(await portal(ota, who, stepUp))
    .send();
}

async function list(ota: Ota, who: Who = "finance"): Promise<Response> {
  return t.http.get(`/v1/tenants/${ota.tenant.id}/payment-connections`).set(await portal(ota, who, false));
}

// ---- Rows, jobs and the worker -------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[]): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const submissionRow = async (id: string): Promise<Row> =>
  (await rowsOf("SELECT * FROM platform.credential_submissions WHERE id = $1", [id]))[0] as Row;

const submissionsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf("SELECT * FROM platform.credential_submissions WHERE tenant_id = $1 ORDER BY created_at, id", [
    tenantId,
  ]);

const connectionsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT * FROM platform.payment_provider_connections WHERE tenant_id = $1 ORDER BY environment = 'live', id",
    [tenantId],
  );

const auditOf = (tenantId: string, action: string): Promise<Row[]> =>
  rowsOf("SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id", [
    tenantId,
    action,
  ]);

const emailsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf("SELECT template, to_email, data FROM platform.email_outbox WHERE tenant_id = $1 ORDER BY id", [
    tenantId,
  ]);

/** Waits until the submission's status is one of `statuses`, promoting a delayed retry at once; answers the row. */
async function waitForStatus(id: string, ...statuses: string[]): Promise<Row> {
  return vi.waitFor(async () => {
    const job = await connectionsQueue.getJob(id);
    if (job !== undefined && (await job.getState()) === "delayed") {
      await job.promote();
    }
    const row = await submissionRow(id);
    expect(statuses).toContain(row["status"]);
    return row;
  }, WAIT);
}

/** Waits until the BullMQ job of the submission is completed, so nothing of it runs after the test. */
async function waitForJobDone(id: string): Promise<void> {
  await vi.waitFor(async () => {
    const job = await connectionsQueue.getJob(id);
    expect(await job?.getState()).toBe("completed");
  }, WAIT);
}

/** Waits for `{type: "connection", tenantId}` on `vx:invalidate`. */
async function connectionEvent(tenantId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(events).toContainEqual({ v: 1, type: "connection", tenantId });
  }, EVENT_WAIT);
}

/** Every value of the Redis database of the test application, as text: keys, strings, hashes, lists, sets, zsets. */
async function redisValues(): Promise<string> {
  const redis = t.redis.client;
  const keys = await redis.keys("*");
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(key);
    const type = await redis.type(key);
    if (type === "string") {
      parts.push((await redis.get(key)) ?? "");
    } else if (type === "hash") {
      parts.push(JSON.stringify(await redis.hgetall(key)));
    } else if (type === "list") {
      parts.push(...(await redis.lrange(key, 0, -1)));
    } else if (type === "set") {
      parts.push(...(await redis.smembers(key)));
    } else if (type === "zset") {
      parts.push(...(await redis.zrange(key, 0, -1)));
    } else if (type === "stream") {
      parts.push(JSON.stringify(await redis.xrange(key, "-", "+")));
    }
  }
  return parts.join("\n");
}

/** No secret of the test in clear in a log line of either process, a Redis value or a row of this file's tables. */
async function expectNoSecretAnywhere(): Promise<void> {
  if (secretsOfTest.length === 0) {
    return;
  }
  const logs = JSON.stringify([...t.logs.lines, ...workerLogs.lines]);
  const redis = await redisValues();
  const rows = JSON.stringify([
    ...(await rowsOf("SELECT * FROM platform.platform_audit_log", [])),
    ...(await rowsOf("SELECT * FROM platform.email_outbox", [])),
    ...(await rowsOf("SELECT * FROM platform.credential_submissions", [])),
    ...(await rowsOf("SELECT * FROM platform.payment_provider_connections", [])),
  ]);
  for (const secret of secretsOfTest) {
    expect(logs.includes(secret), "a secret in a log line").toBe(false);
    expect(redis.includes(secret), "a secret in Redis").toBe(false);
    expect(rows.includes(secret), "a secret in a row").toBe(false);
  }
}

/** The plaintext of `ciphertext` decrypted for `place`. */
async function decrypt(
  ciphertext: unknown,
  place: Parameters<EnvelopeService["decrypt"]>[1],
): Promise<string> {
  return (await envelope.decrypt(ciphertext as Buffer, place)).toString("utf8");
}

function errorOf(res: Response): { code: string; details?: Row; fieldErrors?: Row[] } {
  return (res.body as { error: { code: string; details?: Row; fieldErrors?: Row[] } }).error;
}

const outcomeOf = (res: Response): string =>
  res.status < 400 ? String(res.status) : `${res.status} ${errorOf(res).code}`;

/** The columns of an `api_keys` connection (stand-in ciphertexts: the return to Velexis never opens them). */
function apiKeysColumns(environment: "test" | "live") {
  return {
    account_mode: "api_keys",
    account_reference: newAccountId(),
    publishable_key: `pk_${environment}_TestPublishableOnly`,
    secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
    webhook_secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
    encryption_key_id: PLACEHOLDER_KEK_ID,
    connected_at: t.clock.now(),
    last_verified_at: t.clock.now(),
  };
}

/** Turns the OTA's test connection into an `api_keys` one in `status`; answers the row. */
async function apiKeysTestConnection(
  ota: Ota,
  status: "active" | "disabled" = "active",
): Promise<PlatformRow<"payment_provider_connections">> {
  const columns = apiKeysColumns("test");
  const { rows } = await pool.query(
    `UPDATE platform.payment_provider_connections
        SET account_mode = $2, account_reference = $3, publishable_key = $4, secret_ciphertext = $5,
            webhook_secret_ciphertext = $6, encryption_key_id = $7, connected_at = $8, last_verified_at = $9,
            status = $10
      WHERE id = $1 RETURNING *`,
    [
      ota.connection.id,
      columns.account_mode,
      columns.account_reference,
      columns.publishable_key,
      columns.secret_ciphertext,
      columns.webhook_secret_ciphertext,
      columns.encryption_key_id,
      columns.connected_at,
      columns.last_verified_at,
      status,
    ],
  );
  return rows[0] as PlatformRow<"payment_provider_connections">;
}

/** Inserts the OTA's live connection in `api_keys` mode; answers the row. */
function apiKeysLiveConnection(ota: Ota): Promise<PlatformRow<"payment_provider_connections">> {
  return insertPaymentConnection(pool, ota.tenant, {
    ...apiKeysColumns("live"),
    id: testId("ppc", next++),
    environment: "live",
    statement_descriptor_suffix: null,
  });
}

/** Writes the OTA's payout account in `status` (stand-in ciphertext: the return to Velexis never decrypts it). */
async function payoutAccount(
  tenantId: string,
  status: "pending_review" | "verified" | "rejected",
): Promise<void> {
  await pool.query(
    `INSERT INTO platform.tenant_payout_accounts
       (tenant_id, account_holder_name, country_code, currency, scheme, bank_details_ciphertext, encryption_key_id,
        last4, status)
     VALUES ($1, 'Agency Travel AS', 'NO', 'EUR', 'iban', $2, $3, '7947', $4)
     ON CONFLICT (tenant_id) DO UPDATE SET status = EXCLUDED.status`,
    [tenantId, Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"), PLACEHOLDER_KEK_ID, status],
  );
}

// ---- Tests ---------------------------------------------------------------------------------------------------------

describe("the submission rules", () => {
  it("[PBE-057 AC1] want every key of the path's environment and a webhook secret the OTA backend accepts", () => {
    const keys = {
      publishableKey: "pk_test_Abc1",
      secretKey: "sk_test_Abc2",
      webhookSecret: "whsec_Abcdefgh",
    };
    expect(stripeKeyProblems(keys, "test")).toEqual([]);
    expect(stripeKeyProblems({ ...keys, secretKey: "rk_test_Abc2" }, "test")).toEqual([]);
    expect(stripeKeyProblems(keys, "live").map((problem) => [problem.path, problem.code])).toEqual([
      ["/publishableKey", "environment"],
      ["/secretKey", "environment"],
    ]);
    // A live key on the test environment, and a webhook secret of fewer than 8 characters after `whsec_`.
    const problems = stripeKeyProblems(
      { ...keys, secretKey: "sk_live_Abc2", webhookSecret: "whsec_Abcdefg" },
      "test",
    );
    expect(problems.map((problem) => [problem.path, problem.code])).toEqual([
      ["/secretKey", "environment"],
      ["/webhookSecret", "pattern"],
    ]);
    expect(JSON.stringify(problems)).not.toMatch(/Abc2|Abcdefg/);
    expect([keyModeOf("pk_live_X1"), keyModeOf("rk_test_X1"), keyModeOf("whsec_X1")]).toEqual([
      "live",
      "test",
      undefined,
    ]);
    // The OTA backend opens the connection's secrets with exactly these associated data.
    expect(associatedData(connectionSecretPlace("ppc_X"))).toBe(
      "platform.payment_provider_connections.secret_ciphertext:ppc_X",
    );
    expect(associatedData(connectionWebhookSecretPlace("ppc_X"))).toBe(
      "platform.payment_provider_connections.webhook_secret_ciphertext:ppc_X",
    );
  });

  it("[PBE-057] map Stripe's answers to the verifier's outcomes, and refuse stored keys of the other mode unasked", () => {
    const data = { publishableKey: "pk_test_Abc1", connectionId: "ppc_X" };
    const secrets = { secret: "sk_test_Abc2", webhookSecret: "whsec_Abcdefgh" };
    expect(storedKeysProblem(data, secrets, "test")).toBeUndefined();
    expect(storedKeysProblem(data, secrets, "live")).toMatchObject({ errorCode: "STRIPE_LIVEMODE_MISMATCH" });
    expect(storedKeysProblem(data, { ...secrets, webhookSecret: "whsec_short" }, "test")).toMatchObject({
      errorCode: "STRIPE_KEY_INVALID",
    });
    expect(stripeKeyCheckOf({ ok: true, account: { id: "acct_1Abc", object: "account" } }, "test")).toEqual({
      outcome: "verified",
      result: { accountId: "acct_1Abc" },
    });
    expect(
      stripeKeyCheckOf({ ok: true, account: { id: "acct_1Abc", livemode: false } }, "live"),
    ).toMatchObject({
      outcome: "rejected",
      errorCode: "STRIPE_LIVEMODE_MISMATCH",
    });
    expect(stripeKeyCheckOf({ ok: true, account: { object: "account" } }, "test")).toMatchObject({
      outcome: "unavailable",
    });
    expect(stripeKeyCheckOf({ ok: false, error: FakeStripe.apiError(429) }, "test")).toEqual({
      outcome: "unavailable",
      errorMessage: "Stripe could not verify the key (rate_limit_error 429).",
    });
    expect(stripeKeyCheckOf({ ok: false, error: FakeStripe.connectionError() }, "test")).toMatchObject({
      outcome: "unavailable",
    });
    expect(
      stripeKeyCheckOf({ ok: false, error: FakeStripe.apiError(400, "parameter_unknown") }, "test"),
    ).toMatchObject({ outcome: "unavailable" });
  });

  it("[PBE-057] registers the stripe_api_keys verifier in the worker's one registry", () => {
    const verifiers = worker.get(CredentialVerifiers, { strict: false });
    expect(verifiers.get("stripe_api_keys")).toBeInstanceOf(StripeApiKeysVerifier);
  });
});

describe("PUT /v1/tenants/{tenantId}/payment-connections/{environment}/api-keys (submitStripeApiKeys)", () => {
  it("[PBE-057 AC1] switches the connection to api_keys with the verified account and both secrets sealed for it", async () => {
    const ota = await arrangeOta();
    const keys = newKeys();
    const accountId = newAccountId();
    stripe.grantOwnKey(keys.secretKey, { accountId });

    const res = await submitKeys(ota, keys);

    expect(outcomeOf(res)).toBe("202");
    expectResponseToMatch("submitStripeApiKeys", res, { document: "platform" });
    const body = res.body as { submission: Row; webhookUrl: string; webhookEvents: string[] };
    expect(body.submission).toMatchObject({
      kind: "stripe_api_keys",
      environment: "test",
      status: "pending",
    });
    expect(body.webhookUrl).toBe(`${WEBHOOK_BASE}${ota.connection.id}`);
    expect(body.webhookEvents).toEqual([...STRIPE_WEBHOOK_EVENTS]);
    const submissionId = body.submission["id"] as string;

    const submission = await waitForStatus(submissionId, "applied");
    expect(submission).toMatchObject({
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
      error_code: null,
    });
    expect(submission["public_data"]).toEqual({
      publishableKey: keys.publishableKey,
      connectionId: ota.connection.id,
    });
    // GET /v1/account was asked once, with the submitted secret key.
    expect(stripe.ownKeyDigests).toEqual([sha256Hex(keys.secretKey)]);

    const [connection] = await connectionsOf(ota.tenant.id);
    expect(connection).toMatchObject({
      id: ota.connection.id,
      account_mode: "api_keys",
      account_reference: accountId,
      publishable_key: keys.publishableKey,
      status: "active",
      version: ota.connection.version + 1,
      created_by_account_id: person(ota, "owner").id,
      encryption_key_id: envelope.currentKekId(),
      disconnected_at: null,
      statement_descriptor_suffix: ota.connection.statement_descriptor_suffix,
    });
    expect(connection?.["connected_at"]).toEqual(t.clock.now());
    expect(connection?.["last_verified_at"]).toEqual(t.clock.now());
    // Each secret is sealed for its own column of this row, as the OTA backend opens it, and for nothing else.
    const sealedSecret = connection?.["secret_ciphertext"];
    const sealedWebhook = connection?.["webhook_secret_ciphertext"];
    expect(await decrypt(sealedSecret, connectionSecretPlace(ota.connection.id))).toBe(keys.secretKey);
    expect(await decrypt(sealedWebhook, connectionWebhookSecretPlace(ota.connection.id))).toBe(
      keys.webhookSecret,
    );
    await expect(decrypt(sealedSecret, connectionWebhookSecretPlace(ota.connection.id))).rejects.toThrow();
    await expect(decrypt(sealedSecret, secretPlace("secret_ciphertext", submissionId))).rejects.toThrow();

    const [submitted] = await auditOf(ota.tenant.id, "payments.api_keys_submitted");
    expect(submitted).toMatchObject({ actor_account_id: person(ota, "owner").id, target_id: submissionId });
    const [applied] = await auditOf(ota.tenant.id, "payments.api_keys_applied");
    expect(applied).toMatchObject({ actor_type: "system", target_id: submissionId });
    expect(applied?.["details"]).toMatchObject({
      kind: "stripe_api_keys",
      environment: "test",
      connectionId: ota.connection.id,
      connectionCreated: false,
      before: { accountMode: "velexis", accountReference: null, status: "verifying" },
      after: { accountMode: "api_keys", accountReference: accountId, status: "applied" },
    });
    await connectionEvent(ota.tenant.id);
    expect(await emailsOf(ota.tenant.id)).toEqual([
      expect.objectContaining({
        template: "connection.credentials_applied",
        to_email: person(ota, "owner").email,
      }),
    ]);

    // The list shows the mode, the account, the publishable key and the webhook URL; the submission is done.
    const listed = await list(ota);
    expect(listed.status).toBe(200);
    expectResponseToMatch("listPaymentConnections", listed, { document: "platform" });
    expect((listed.body as { data: Row[] }).data).toEqual([
      expect.objectContaining({
        id: ota.connection.id,
        accountMode: "api_keys",
        accountReference: accountId,
        publishableKey: keys.publishableKey,
        webhookUrl: `${WEBHOOK_BASE}${ota.connection.id}`,
        pendingSubmission: null,
      }),
    ]);
  });

  it("[PBE-057 AC1] answers VALIDATION_FAILED for a live key on the test environment, storing and asking nothing", async () => {
    const ota = await arrangeOta();
    const live = newKeys("live");

    const res = await submitKeys(ota, live, "test");

    expect(outcomeOf(res)).toBe("400 VALIDATION_FAILED");
    expectResponseToMatch("submitStripeApiKeys", res, { document: "platform" });
    expect(errorOf(res).fieldErrors?.map((error) => [error["path"], error["code"]])).toEqual([
      ["/publishableKey", "environment"],
      ["/secretKey", "environment"],
    ]);
    expect(JSON.stringify(res.body)).not.toContain(live.secretKey.slice(8));
    // A test key on the live environment, and a webhook secret the OTA backend would refuse.
    const test = newKeys("test");
    expect(outcomeOf(await submitKeys(ota, test, "live"))).toBe("400 VALIDATION_FAILED");
    const short = await submitKeys(ota, { ...test, webhookSecret: "whsec_Abc1234" });
    expect(outcomeOf(short)).toBe("400 VALIDATION_FAILED");
    expect(errorOf(short).fieldErrors?.map((error) => error["path"])).toEqual(["/webhookSecret"]);

    expect(await submissionsOf(ota.tenant.id)).toEqual([]);
    expect(await auditOf(ota.tenant.id, "payments.api_keys_submitted")).toEqual([]);
    expect(stripe.calls).toEqual([]);
    expect((await connectionsOf(ota.tenant.id))[0]).toMatchObject({ account_mode: "velexis", version: 1 });
  });

  it("[PBE-057] fails the submission with STRIPE_KEY_INVALID when Stripe refuses the key, the connection unchanged", async () => {
    const ota = await arrangeOta();
    const keys = newKeys();

    const res = await submitKeys(ota, keys);
    expect(outcomeOf(res)).toBe("202");
    const submissionId = (res.body as { submission: { id: string } }).submission.id;

    const failed = await waitForStatus(submissionId, "failed");
    expect(failed).toMatchObject({
      error_code: "STRIPE_KEY_INVALID",
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
    });
    // Stripe's type, status and code only: never Stripe's message, which names the key.
    expect(failed["error_message"]).toContain("invalid_request_error 401");
    expect(failed["error_message"]).not.toContain("Invalid API Key");
    expect((await connectionsOf(ota.tenant.id))[0]).toMatchObject({
      account_mode: "velexis",
      account_reference: null,
      secret_ciphertext: null,
      version: 1,
    });
    expect(await emailsOf(ota.tenant.id)).toEqual([
      expect.objectContaining({ template: "connection.credentials_failed" }),
    ]);
    const listed = await list(ota);
    expect((listed.body as { data: Row[] }).data[0]).toMatchObject({
      webhookUrl: null,
      pendingSubmission: { id: submissionId, status: "failed", errorCode: "STRIPE_KEY_INVALID" },
    });

    // A restricted key without access to the account (403) is refused the same way.
    const restricted = newKeys("test", "rk");
    stripe.grantOwnKey(restricted.secretKey, { accountId: newAccountId() });
    stripe.failNext(
      "accounts.retrieveCurrent",
      new Stripe.errors.StripePermissionError({
        type: "invalid_request_error",
        message: "No access",
        statusCode: 403,
      }),
    );
    const again = await submitKeys(ota, restricted);
    const refused = await waitForStatus(
      (again.body as { submission: { id: string } }).submission.id,
      "failed",
    );
    expect(refused).toMatchObject({ error_code: "STRIPE_KEY_INVALID" });
    expect(refused["error_message"]).toContain("invalid_request_error 403");
    expect((await connectionsOf(ota.tenant.id))[0]).toMatchObject({ account_mode: "velexis", version: 1 });
  });

  it("[PBE-057] tries again while Stripe is unavailable, then applies the keys", async () => {
    const ota = await arrangeOta();
    const keys = newKeys("test", "rk");
    const accountId = newAccountId();
    stripe.grantOwnKey(keys.secretKey, { accountId });
    stripe.failNext("accounts.retrieveCurrent", FakeStripe.apiError(503));

    const res = await submitKeys(ota, keys);

    const submissionId = (res.body as { submission: { id: string } }).submission.id;
    const applied = await waitForStatus(submissionId, "applied");
    expect(applied["attempts"]).toBe(2);
    expect(stripe.ownKeyDigests).toEqual([sha256Hex(keys.secretKey), sha256Hex(keys.secretKey)]);
    expect((await connectionsOf(ota.tenant.id))[0]).toMatchObject({
      account_mode: "api_keys",
      account_reference: accountId,
    });
  });

  it("[PBE-057] keeps one webhook URL for an environment without a connection, and creates that connection under it", async () => {
    const ota = await arrangeOta();
    await connectionsQueue.pause();
    const first = await submitKeys(ota, newKeys("live"), "live");
    expect(outcomeOf(first)).toBe("202");
    const url = (first.body as { webhookUrl: string }).webhookUrl;
    expect(url).toMatch(
      /^https:\/\/api\.ota\.example\.com\/webhooks\/stripe\/c\/ppc_[0-9A-HJKMNP-TV-Z]{26}$/,
    );
    expect(url).not.toBe(`${WEBHOOK_BASE}${ota.connection.id}`);

    // Typed again (the first submission superseded), the keys keep the URL the owner configured in Stripe.
    const keys = newKeys("live");
    const accountId = newAccountId();
    stripe.grantOwnKey(keys.secretKey, { accountId, livemode: true });
    const second = await submitKeys(ota, keys, "live");
    expect((second.body as { webhookUrl: string }).webhookUrl).toBe(url);
    await connectionsQueue.resume();

    await waitForStatus((second.body as { submission: { id: string } }).submission.id, "applied");
    const live = (await connectionsOf(ota.tenant.id))[1];
    const liveId = url.slice(WEBHOOK_BASE.length);
    expect(live).toMatchObject({
      id: liveId,
      environment: "live",
      account_mode: "api_keys",
      account_reference: accountId,
      publishable_key: keys.publishableKey,
      status: "active",
      capture_mode: "manual",
      statement_descriptor_suffix: ota.connection.statement_descriptor_suffix,
    });
    expect(await decrypt(live?.["secret_ciphertext"], connectionSecretPlace(liveId))).toBe(keys.secretKey);
    const [applied] = await auditOf(ota.tenant.id, "payments.api_keys_applied");
    expect(applied?.["details"]).toMatchObject({ connectionCreated: true, before: { connectionId: null } });
    await waitForJobDone((first.body as { submission: { id: string } }).submission.id);
  });

  it("[PBE-057] answers one webhook URL to two submissions at the same moment for an environment without a connection", async () => {
    const ota = await arrangeOta();
    await connectionsQueue.pause();

    // A double click: the second waits for the first's slot lock and keeps the connection id it stored.
    const [first, second] = await Promise.all([
      submitKeys(ota, newKeys("live"), "live"),
      submitKeys(ota, newKeys("live"), "live"),
    ]);

    expect([outcomeOf(first), outcomeOf(second)]).toEqual(["202", "202"]);
    const url = (first.body as { webhookUrl: string }).webhookUrl;
    expect((second.body as { webhookUrl: string }).webhookUrl).toBe(url);
    const rows = await submissionsOf(ota.tenant.id);
    expect(rows.map((row) => row["status"]).sort()).toEqual(["pending", "superseded"]);
    expect(rows.map((row) => (row["public_data"] as Row)["connectionId"])).toEqual([
      url.slice(WEBHOOK_BASE.length),
      url.slice(WEBHOOK_BASE.length),
    ]);

    // Neither key was granted: the open submission fails, the superseded one is skipped.
    await connectionsQueue.resume();
    const open = rows.find((row) => row["status"] === "pending");
    const superseded = rows.find((row) => row["status"] === "superseded");
    await waitForStatus(open?.["id"] as string, "failed");
    await waitForJobDone(open?.["id"] as string);
    await waitForJobDone(superseded?.["id"] as string);
  });

  it("[PBE-057] fails with STRIPE_LIVEMODE_MISMATCH when Stripe answers for the other mode", async () => {
    const ota = await arrangeOta();
    const keys = newKeys();
    stripe.grantOwnKey(keys.secretKey, { accountId: newAccountId(), livemode: true });

    const res = await submitKeys(ota, keys);

    const failed = await waitForStatus((res.body as { submission: { id: string } }).submission.id, "failed");
    expect(failed["error_code"]).toBe("STRIPE_LIVEMODE_MISMATCH");
    expect((await connectionsOf(ota.tenant.id))[0]).toMatchObject({ account_mode: "velexis", version: 1 });
  });

  it("[PBE-057] never switches a connection a platform admin disabled (CONNECTION_DISABLED)", async () => {
    const ota = await arrangeOta();
    await pool.query("UPDATE platform.payment_provider_connections SET status = 'disabled' WHERE id = $1", [
      ota.connection.id,
    ]);
    const keys = newKeys();
    stripe.grantOwnKey(keys.secretKey, { accountId: newAccountId() });

    const res = await submitKeys(ota, keys);

    const failed = await waitForStatus((res.body as { submission: { id: string } }).submission.id, "failed");
    expect(failed).toMatchObject({ error_code: "CONNECTION_DISABLED", secret_ciphertext: null });
    expect((await connectionsOf(ota.tenant.id))[0]).toMatchObject({
      account_mode: "velexis",
      status: "disabled",
      secret_ciphertext: null,
      version: 1,
    });
  });

  it("[PBE-057] keeps the connection when the OTA was suspended meanwhile, or the environment got another connection", async () => {
    const ota = await arrangeOta();
    const keys = newKeys();
    stripe.grantOwnKey(keys.secretKey, { accountId: newAccountId() });
    await connectionsQueue.pause();
    const suspendedRes = await submitKeys(ota, keys);
    await pool.query("UPDATE platform.tenants SET status = 'suspended' WHERE id = $1", [ota.tenant.id]);

    await connectionsQueue.resume();
    const suspended = await waitForStatus(
      (suspendedRes.body as { submission: { id: string } }).submission.id,
      "failed",
    );
    expect(suspended).toMatchObject({ error_code: "TENANT_NOT_ACTIVE", secret_ciphertext: null });
    expect((await connectionsOf(ota.tenant.id))[0]).toMatchObject({ account_mode: "velexis", version: 1 });

    // Live keys for an environment without a connection, then a live connection created under another id: the
    // webhook URL the owner configured would name no connection, so the keys are not applied.
    const other = await arrangeOta();
    const live = newKeys("live");
    stripe.grantOwnKey(live.secretKey, { accountId: newAccountId() });
    await connectionsQueue.pause();
    const changedRes = await submitKeys(other, live, "live");
    const created = await insertPaymentConnection(pool, other.tenant, {
      id: testId("ppc", next++),
      environment: "live",
    });
    await connectionsQueue.resume();
    const changed = await waitForStatus(
      (changedRes.body as { submission: { id: string } }).submission.id,
      "failed",
    );
    expect(changed["error_code"]).toBe("CONNECTION_CHANGED");
    expect((await connectionsOf(other.tenant.id))[1]).toMatchObject({
      id: created.id,
      account_mode: "velexis",
      secret_ciphertext: null,
      version: 1,
    });
  });

  it("[PBE-057] takes owners and admins with a step-up while own_stripe is on and the OTA is active", async () => {
    const ota = await arrangeOta();
    const keys = newKeys("test", "rk");
    stripe.grantOwnKey(keys.secretKey, { accountId: newAccountId() });

    const byAdmin = await submitKeys(ota, keys, "test", "admin");
    expect(outcomeOf(byAdmin)).toBe("202");
    await waitForStatus((byAdmin.body as { submission: { id: string } }).submission.id, "applied");

    const outcomes: Record<string, string> = {};
    for (const who of ["finance", "agent", "viewer", "stranger", "ownerWithoutMfa"] as const) {
      outcomes[who] = outcomeOf(await submitKeys(ota, keys, "test", who));
    }
    outcomes["ownerWithoutStepUp"] = outcomeOf(await submitKeys(ota, keys, "test", "owner", false));
    expect(outcomes).toEqual({
      finance: "403 FORBIDDEN",
      agent: "403 FORBIDDEN",
      viewer: "403 FORBIDDEN",
      stranger: "404 NOT_FOUND",
      ownerWithoutMfa: "403 MFA_REQUIRED",
      ownerWithoutStepUp: "401 REAUTH_REQUIRED",
    });

    switches.on.clear();
    const off = await submitKeys(ota, keys);
    expect(outcomeOf(off)).toBe("403 FEATURE_DISABLED");
    expectResponseToMatch("submitStripeApiKeys", off, { document: "platform" });
    switches.on.add("own_stripe");

    await pool.query("UPDATE platform.tenants SET status = 'suspended' WHERE id = $1", [ota.tenant.id]);
    const suspended = await submitKeys(ota, keys);
    expect(outcomeOf(suspended)).toBe("409 TENANT_NOT_ACTIVE");
    expect(errorOf(suspended).details).toEqual({ status: "suspended" });
    // One submission only: the admin's.
    expect(await submissionsOf(ota.tenant.id)).toHaveLength(1);
  });
});

describe("POST /v1/tenants/{tenantId}/payment-connections/{environment}/use-velexis (useVelexisPayments)", () => {
  it("[PBE-057 AC2] clears every secret and reference of an api_keys connection, audited and invalidated", async () => {
    const ota = await arrangeOta();
    const before = await apiKeysTestConnection(ota);
    // An open submission of new keys becomes moot: the owner's choice is Velexis.
    await connectionsQueue.pause();
    const pending = await submitKeys(ota, newKeys());
    const pendingId = (pending.body as { submission: { id: string } }).submission.id;
    // The list shows the open submission next to the connection it would change.
    const listed = await list(ota);
    expect((listed.body as { data: Row[] }).data[0]).toMatchObject({
      accountMode: "api_keys",
      webhookUrl: `${WEBHOOK_BASE}${before.id}`,
      pendingSubmission: { id: pendingId, status: "pending", errorCode: null },
    });

    const res = await useVelexis(ota);

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("useVelexisPayments", res, { document: "platform" });
    expect(res.headers["etag"]).toBe(`"${before.version + 1}"`);
    expect(res.body).toMatchObject({
      id: before.id,
      accountMode: "velexis",
      status: "active",
      accountReference: null,
      publishableKey: null,
      connectedAt: null,
      disconnectedAt: null,
      webhookUrl: null,
      pendingSubmission: null,
      capabilities: {},
      version: before.version + 1,
    });
    const [after] = await connectionsOf(ota.tenant.id);
    expect(after).toMatchObject({
      account_mode: "velexis",
      account_reference: null,
      publishable_key: null,
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
      encryption_key_id: null,
      connected_at: null,
      last_verified_at: null,
      status: "active",
      created_by_account_id: person(ota, "owner").id,
      statement_descriptor_suffix: before.statement_descriptor_suffix,
    });
    expect(await submissionRow(pendingId)).toMatchObject({
      status: "superseded",
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
    });
    const [audit] = await auditOf(ota.tenant.id, "payments.switched_to_velexis");
    expect(audit).toMatchObject({ actor_account_id: person(ota, "owner").id, target_id: before.id });
    expect(audit?.["details"]).toEqual({
      environment: "test",
      deauthorization: "not_needed",
      supersededSubmissionIds: [pendingId],
      before: { accountMode: "api_keys", accountReference: before.account_reference, status: "active" },
      after: { accountMode: "velexis", accountReference: null, status: "active" },
    });
    await connectionEvent(ota.tenant.id);
    // An API-key connection has no OAuth grant to revoke: Stripe is not asked.
    expect(stripe.calls).toEqual([]);

    // The superseded submission's job finds it final and asks Stripe nothing.
    await connectionsQueue.resume();
    await waitForJobDone(pendingId);
    expect(stripe.calls).toEqual([]);
  });

  it("[PBE-057 AC2] answers 422 for the live connection without a verified payout account, asking and changing nothing", async () => {
    const ota = await arrangeOta();
    const live = await apiKeysLiveConnection(ota);

    const none = await useVelexis(ota, "live");
    expect(outcomeOf(none)).toBe("422 PAYOUT_ACCOUNT_REQUIRED");
    expectResponseToMatch("useVelexisPayments", none, { document: "platform" });
    await payoutAccount(ota.tenant.id, "pending_review");
    expect(outcomeOf(await useVelexis(ota, "live"))).toBe("422 PAYOUT_ACCOUNT_REQUIRED");
    await payoutAccount(ota.tenant.id, "rejected");
    expect(outcomeOf(await useVelexis(ota, "live"))).toBe("422 PAYOUT_ACCOUNT_REQUIRED");
    expect((await connectionsOf(ota.tenant.id))[1]).toMatchObject({
      account_mode: "api_keys",
      account_reference: live.account_reference,
      version: live.version,
    });
    expect(await auditOf(ota.tenant.id, "payments.switched_to_velexis")).toEqual([]);

    await payoutAccount(ota.tenant.id, "verified");
    const res = await useVelexis(ota, "live");
    expect(outcomeOf(res)).toBe("200");
    expect(res.body).toMatchObject({ environment: "live", accountMode: "velexis", accountReference: null });
  });

  it("[PBE-057] deauthorises a connect_standard account first; a failure there is logged and does not block", async () => {
    const ota = await arrangeOta();
    const accountId = newAccountId();
    await pool.query(
      `UPDATE platform.payment_provider_connections
          SET account_mode = 'connect_standard', account_reference = $2, connected_at = $3,
              capabilities = '{"chargesEnabled": true}'
        WHERE id = $1`,
      [ota.connection.id, accountId, t.clock.now()],
    );

    const res = await useVelexis(ota);

    expect(outcomeOf(res)).toBe("200");
    expect(res.body).toMatchObject({ accountMode: "velexis", accountReference: null, capabilities: {} });
    expect(stripe.callsOf("oauth.deauthorize")).toEqual([
      expect.objectContaining({
        params: { client_id: STRIPE_ENV.STRIPE_CONNECT_CLIENT_ID, stripe_user_id: accountId },
        idempotencyKey: idempotencyKey("use_velexis_deauthorize", `${ota.connection.id}:1`),
      }),
    ]);
    expect(stripe.deauthorized).toEqual([accountId]);
    const [audit] = await auditOf(ota.tenant.id, "payments.switched_to_velexis");
    expect(audit?.["details"]).toMatchObject({ deauthorization: "deauthorized" });

    // Stripe failing: the switch still happens, the failure is logged with Stripe's type, status and code only.
    const other = await arrangeOta();
    const otherAccount = newAccountId();
    await pool.query(
      `UPDATE platform.payment_provider_connections
          SET account_mode = 'connect_standard', account_reference = $2, connected_at = $3
        WHERE id = $1`,
      [other.connection.id, otherAccount, t.clock.now()],
    );
    stripe.failNext("oauth.deauthorize", FakeStripe.apiError(500));
    const failed = await useVelexis(other);
    expect(outcomeOf(failed)).toBe("200");
    expect(failed.body).toMatchObject({ accountMode: "velexis" });
    const logged = t.logs
      .withMessage("payments.use_velexis_deauthorize_failed")
      .filter((line) => line["tenantId"] === other.tenant.id);
    expect(logged).toEqual([
      expect.objectContaining({ stripeAccount: otherAccount, failure: "api_error 500" }),
    ]);
    expect((await auditOf(other.tenant.id, "payments.switched_to_velexis"))[0]?.["details"]).toMatchObject({
      deauthorization: "failed",
    });
  });

  it("[PBE-057] leaves the account connected while the OTA's other connection still holds it", async () => {
    const ota = await arrangeOta();
    const accountId = newAccountId();
    await pool.query(
      `UPDATE platform.payment_provider_connections
          SET account_mode = 'connect_standard', account_reference = $2, connected_at = $3
        WHERE id = $1`,
      [ota.connection.id, accountId, t.clock.now()],
    );
    const live = await insertPaymentConnection(pool, ota.tenant, {
      id: testId("ppc", next++),
      environment: "live",
      account_mode: "connect_standard",
      account_reference: accountId,
      connected_at: t.clock.now(),
    });
    await payoutAccount(ota.tenant.id, "verified");

    const res = await useVelexis(ota, "test");

    expect(outcomeOf(res)).toBe("200");
    expect(stripe.callsOf("oauth.deauthorize")).toEqual([]);
    expect(
      t.logs
        .withMessage("payments.use_velexis_deauthorize_skipped")
        .filter((line) => line["tenantId"] === ota.tenant.id),
    ).toEqual([expect.objectContaining({ reason: "still_connected", stripeAccount: accountId })]);
    expect((await connectionsOf(ota.tenant.id))[1]).toMatchObject({
      id: live.id,
      account_mode: "connect_standard",
      account_reference: accountId,
    });

    // The last connection of the account deauthorises it.
    expect(outcomeOf(await useVelexis(ota, "live"))).toBe("200");
    expect(stripe.deauthorized).toEqual([accountId]);
  });

  it("[PBE-057] answers a velexis connection unchanged, and keeps a platform admin's disable", async () => {
    const ota = await arrangeOta();

    const unchanged = await useVelexis(ota);
    expect(outcomeOf(unchanged)).toBe("200");
    expect(unchanged.headers["etag"]).toBe(`"${ota.connection.version}"`);
    expect(unchanged.body).toMatchObject({ accountMode: "velexis", version: ota.connection.version });
    expect(await auditOf(ota.tenant.id, "payments.switched_to_velexis")).toEqual([]);

    const other = await arrangeOta();
    await apiKeysTestConnection(other, "disabled");
    const disabled = await useVelexis(other);
    expect(outcomeOf(disabled)).toBe("200");
    expect(disabled.body).toMatchObject({
      accountMode: "velexis",
      status: "disabled",
      accountReference: null,
    });
    expect((await connectionsOf(other.tenant.id))[0]).toMatchObject({
      status: "disabled",
      disconnected_at: null,
      secret_ciphertext: null,
    });
  });

  it("[PBE-057] takes owners with a step-up only, with or without own_stripe, while the OTA is active", async () => {
    const ota = await arrangeOta();
    await apiKeysTestConnection(ota);

    const outcomes: Record<string, string> = {};
    for (const who of ["admin", "finance", "agent", "viewer", "stranger", "ownerWithoutMfa"] as const) {
      outcomes[who] = outcomeOf(await useVelexis(ota, "test", who));
    }
    outcomes["ownerWithoutStepUp"] = outcomeOf(await useVelexis(ota, "test", "owner", false));
    outcomes["liveWithoutConnection"] = outcomeOf(await useVelexis(ota, "live"));
    expect(outcomes).toEqual({
      admin: "403 FORBIDDEN",
      finance: "403 FORBIDDEN",
      agent: "403 FORBIDDEN",
      viewer: "403 FORBIDDEN",
      stranger: "404 NOT_FOUND",
      ownerWithoutMfa: "403 MFA_REQUIRED",
      ownerWithoutStepUp: "401 REAUTH_REQUIRED",
      liveWithoutConnection: "404 NOT_FOUND",
    });

    await pool.query("UPDATE platform.tenants SET status = 'suspended' WHERE id = $1", [ota.tenant.id]);
    const suspended = await useVelexis(ota);
    expect(outcomeOf(suspended)).toBe("409 TENANT_NOT_ACTIVE");
    expectResponseToMatch("useVelexisPayments", suspended, { document: "platform" });
    await pool.query("UPDATE platform.tenants SET status = 'active' WHERE id = $1", [ota.tenant.id]);

    // Not behind a switch: an OTA can always come back to Velexis.
    switches.on.clear();
    expect(outcomeOf(await useVelexis(ota))).toBe("200");
  });
});
