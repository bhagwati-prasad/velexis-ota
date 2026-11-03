// The OTA's own Amadeus credentials end to end (PBE-053; flows/amadeus-connection.md §D and "Failure handling",
// PADR-0010, PADR-0012 item 4; scope PF-52). The API (createTestApp) takes `submitAmadeusCredentials` and
// `listAmadeusConnections` on this file's database clone; the worker's module graph (WorkerModule, as dist/worker.js
// builds it, with the API's FakeClock) runs `credentials.verify` from the same Redis database with the real `amadeus`
// verifier it registers (AmadeusCredentialsVerifier). Its token requests go to the Amadeus stub of @velexis/testing,
// started in this process on a free port with one accepted client id and secret, as AMADEUS_BASE_URL_TEST and
// AMADEUS_BASE_URL_LIVE of both processes: any other pair answers `401 invalid_client`.
//
// Each test arranges its own OTA: an owner and an admin with MFA, a Velexis office of the test account assigned to it,
// and its `velexis` test connection on that office. The milestone switch is a stand-in this file turns on (as
// stripe-connect.int.test.ts does), so one test can turn it off. A delayed retry is promoted at once instead of waiting
// for its backoff (ADR-0009: 30 s, then doubling). The secrets are random per test, and after every test no log line of
// either process (at `trace`), no Redis value (the jobs, their data, results and errors) and no audit, outbox,
// submission or connection row holds one; every address is a `uniqueEmail` of this file (Mailpit is shared).
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { secretPlace } from "../../../src/common/credentials/credential-submissions.repository";
import { CredentialVerifiers } from "../../../src/common/credentials/credentials-verify.processor";
import { EnvelopeService } from "../../../src/common/crypto.provider";
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
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import {
  AmadeusCredentialsVerifier,
  connectionSecretPlace,
} from "../../../src/supplier-connections/amadeus-credentials.verifier";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertSupplierConnection,
  testId,
  velexisSource,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember, insertOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/**
 * The database clone, the API's and the worker's Nest module graphs, the stub (its specifications load once) and the
 * platform document of expectResponseToMatch; the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish a submission (it takes milliseconds; under Vitest's 5 s). */
const WAIT = { timeout: 3_000, interval: 20 } as const;
/** How long a test waits for the worker's e-mail to reach Mailpit, and for an event on `vx:invalidate`. */
const MAIL_WAIT_MS = 3_000;
const EVENT_WAIT = { timeout: 2_000, interval: 20 } as const;
/** The first number of this file's ids (`testId`), away from the other test files'. */
const FIRST_ID = 53_000;
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.53";
const SESSION = testId("asn", FIRST_ID);
/** The one client id the stub accepts (not a secret); its secret is random per run (`acceptedSecret`). */
const ACCEPTED_CLIENT_ID = "acme-own-amadeus-client";
/** The offices of the OTA's own credentials in the submissions of this file. */
const OWN_OFFICES = ["OSLN12345", "OSLN12346"] as const;

type Row = Record<string, unknown>;

/** The milestone switches of the API and the worker: `own_amadeus` on unless a test turns it off. */
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
const workerLogs = new LogSink();
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let stub: AmadeusStub;
let tokens: TokenService;
let envelope: EnvelopeService;
let connectionsQueue: Queue;
let subscriber: Redis;
let testAccount: PlatformRow<"amadeus_accounts">;
let acceptedSecret: string;
let next = FIRST_ID + 1;
/** Every `vx:invalidate` event received. */
const events: InvalidationEvent[] = [];
/** The secrets of the current test: none may appear in a log line, a Redis value or a row. */
const secretsOfTest: string[] = [];

beforeAll(async () => {
  // Expensive set-up, once per file: the stub, the clone, both module graphs and the platform document.
  acceptedSecret = `accepted-${randomBytes(18).toString("hex")}`;
  stub = await startAmadeusStub({
    credentials: { clientId: ACCEPTED_CLIENT_ID, clientSecret: acceptedSecret },
  });
  t = await createTestApp({
    env: { LOG_LEVEL: "trace", AMADEUS_BASE_URL_TEST: stub.url, AMADEUS_BASE_URL_LIVE: stub.url },
    overrides: [{ provide: FeatureSwitches, useValue: switches }],
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
    // The worker refuses to apply a kind whose switch is off (FIX-W39-PLATFORM, lead decision (2b) of 2026-11-02):
    // it reads the same switches as the API.
    .overrideProvider(FeatureSwitches)
    .useValue(switches)
    .compile();
  await worker.init();

  testAccount = await insertAmadeusAccount(pool, {
    id: testId("ama", FIRST_ID),
    environment: "test",
    base_url: stub.url,
  });
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
  await stub?.stop();
}, SETUP_TIMEOUT_MS);

beforeEach(() => {
  switches.on.clear();
  switches.on.add("own_amadeus");
  stub.setDefaultScenario("success");
  stub.clearRequests();
  secretsOfTest.length = 0;
  secretsOfTest.push(acceptedSecret);
});

afterEach(async () => {
  // A paused queue is resumed for the next test, whatever this one did.
  if (await connectionsQueue.isPaused()) {
    await connectionsQueue.resume();
  }
  await expectNoSecretAnywhere();
});

// ---- Arrangement ---------------------------------------------------------------------------------------------------

/** An OTA of this file: its members, its assigned Velexis test office and its `velexis` test connection. */
interface Ota {
  readonly tenant: PlatformRow<"tenants">;
  readonly people: ReadonlyMap<Who, PlatformRow<"accounts">>;
  readonly office: PlatformRow<"amadeus_offices">;
  readonly connection: PlatformRow<"supplier_connections">;
}

type Who = TenantRole | "ownerWithoutMfa" | "stranger";

async function arrangeOta(): Promise<Ota> {
  const n = next++;
  const { tenant } = await insertOta(pool, {
    tenant: { id: testId("ten", n), key: `own${n}`, name: `Agency ${n} Travel` },
  });
  const people = new Map<Who, PlatformRow<"accounts">>();
  for (const role of TENANT_ROLES) {
    const account = await insertAccount(pool, {
      id: testId("acc", next++),
      email: uniqueEmail(`${role}-pbe053`),
      full_name: `${role} ${n}`,
      mfa_enabled: true,
    });
    await insertMember(pool, tenant, account, role);
    people.set(role, account);
  }
  const ownerWithoutMfa = await insertAccount(pool, { id: testId("acc", next++) });
  await insertMember(pool, tenant, ownerWithoutMfa, "owner");
  people.set("ownerWithoutMfa", ownerWithoutMfa);
  people.set("stranger", await insertAccount(pool, { id: testId("acc", next++), mfa_enabled: true }));
  const office = await insertAmadeusOffice(pool, testAccount, {
    id: testId("amo", n),
    office_id: `NCE1A${String(n % 10_000).padStart(4, "0")}`,
    status: "assigned",
    assigned_tenant_id: tenant.id,
    assigned_at: t.clock.now(),
  });
  const connection = await insertSupplierConnection(pool, tenant, {
    ...velexisSource(testAccount),
    id: testId("sc", n),
    office_ids: [office.office_id],
    default_office_id: office.office_id,
    queuing_office_id: office.office_id,
    owner_office_id: office.office_id,
    status: "active",
  });
  return { tenant, people, office, connection };
}

function person(ota: Ota, who: Who): PlatformRow<"accounts"> {
  const account = ota.people.get(who);
  if (account === undefined) {
    throw new Error(`no ${who} in the OTA`);
  }
  return account;
}

/** A random secret of this test, remembered for the checks after it. */
function newSecret(): string {
  const secret = `wrong-${randomBytes(18).toString("hex")}`;
  secretsOfTest.push(secret);
  return secret;
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

/** The body of a submission: the accepted pair unless `clientSecret` says otherwise, the two own offices. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: ACCEPTED_CLIENT_ID,
    clientSecret: acceptedSecret,
    officeIds: [...OWN_OFFICES],
    defaultOfficeId: OWN_OFFICES[0],
    ownerOfficeId: OWN_OFFICES[1],
    ...overrides,
  };
}

/** `submitAmadeusCredentials` by `who` for `environment`. */
async function submit(
  ota: Ota,
  requestBody: Record<string, unknown> = body(),
  options: { readonly who?: Who; readonly environment?: "test" | "live"; readonly stepUp?: boolean } = {},
): Promise<Response> {
  return t.http
    .put(`/v1/tenants/${ota.tenant.id}/amadeus-connections/${options.environment ?? "test"}/credentials`)
    .set(await portal(ota, options.who ?? "owner", options.stepUp ?? true))
    .send(requestBody);
}

/** `listAmadeusConnections` by the owner, checked against the document. */
async function listConnections(ota: Ota): Promise<Array<Record<string, unknown>>> {
  const res = await t.http
    .get(`/v1/tenants/${ota.tenant.id}/amadeus-connections`)
    .set(await portal(ota, "owner", false));
  expect(res.status).toBe(200);
  expectResponseToMatch("listAmadeusConnections", res, { document: "platform" });
  return (res.body as { data: Array<Record<string, unknown>> }).data;
}

// ---- Rows, jobs and the worker -------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[]): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const submissionRow = async (id: string): Promise<Row> =>
  (await rowsOf("SELECT * FROM platform.credential_submissions WHERE id = $1", [id]))[0] as Row;

const submissionsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf("SELECT id FROM platform.credential_submissions WHERE tenant_id = $1", [tenantId]);

const connectionOf = async (tenantId: string, environment: "test" | "live"): Promise<Row | undefined> =>
  (
    await rowsOf("SELECT * FROM platform.supplier_connections WHERE tenant_id = $1 AND environment = $2", [
      tenantId,
      environment,
    ])
  )[0];

const officeRow = async (id: string): Promise<Row> =>
  (await rowsOf("SELECT * FROM platform.amadeus_offices WHERE id = $1", [id]))[0] as Row;

const auditOf = (targetId: string): Promise<Row[]> =>
  rowsOf("SELECT * FROM platform.platform_audit_log WHERE target_id = $1 ORDER BY id", [targetId]);

const emailsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT template, to_email, account_id, data FROM platform.email_outbox WHERE tenant_id = $1 ORDER BY id",
    [tenantId],
  );

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

/** No secret of the test in a log line of either process, a Redis value or a row (ciphertexts aside). */
async function expectNoSecretAnywhere(): Promise<void> {
  const logs = JSON.stringify([...t.logs.lines, ...workerLogs.lines]);
  const redis = await redisValues();
  const rows = JSON.stringify([
    ...(await rowsOf("SELECT * FROM platform.platform_audit_log", [])),
    ...(await rowsOf("SELECT * FROM platform.email_outbox", [])),
    ...(await rowsOf(
      "SELECT id, public_data, error_code, error_message FROM platform.credential_submissions",
      [],
    )),
    ...(await rowsOf(
      "SELECT id, base_url, client_id, office_ids, last_error FROM platform.supplier_connections",
      [],
    )),
  ]);
  for (const secret of secretsOfTest) {
    expect(logs.includes(secret), "a secret in a log line").toBe(false);
    expect(redis.includes(secret), "a secret in Redis").toBe(false);
    expect(rows.includes(secret), "a secret in a row").toBe(false);
  }
}

/** The plaintext of a ciphertext decrypted for `place`. */
async function decrypt(
  ciphertext: unknown,
  place: Parameters<EnvelopeService["decrypt"]>[1],
): Promise<string> {
  const plaintext = await envelope.decrypt(ciphertext as Buffer, place);
  return plaintext.toString("utf8");
}

/** Waits until `vx:invalidate` carried `event`. */
async function waitForEvent(event: InvalidationEvent): Promise<void> {
  await vi.waitFor(() => {
    expect(events).toContainEqual(event);
  }, EVENT_WAIT);
}

function errorOf(res: Response): { code: string; details?: Record<string, unknown>; fieldErrors?: unknown } {
  return (res.body as { error: { code: string; details?: Record<string, unknown>; fieldErrors?: unknown } })
    .error;
}

const submissionIdOf = (res: Response): string => (res.body as { submission: { id: string } }).submission.id;

// ---- Tests ---------------------------------------------------------------------------------------------------------

describe("PUT /v1/tenants/{tenantId}/amadeus-connections/{environment}/credentials (submitAmadeusCredentials)", () => {
  it("[PBE-053 AC2] switches the connection to the OTA's credentials, re-encrypts the secret for the connection and sets the Velexis office releasing", async () => {
    const ota = await arrangeOta();
    const owner = person(ota, "owner");
    // The worker waits, so the submission and its own ciphertext can be read before the apply.
    await connectionsQueue.pause();

    const res = await submit(ota);

    expect(res.status).toBe(202);
    expectResponseToMatch("submitAmadeusCredentials", res, { document: "platform" });
    const submissionId = submissionIdOf(res);
    expect(res.body).toEqual({
      submission: {
        id: submissionId,
        kind: "amadeus",
        environment: "test",
        status: "pending",
        errorCode: null,
        errorMessage: null,
        createdAt: t.clock.now().toISOString(),
        finishedAt: null,
      },
    });
    const pending = await submissionRow(submissionId);
    expect(pending["public_data"]).toEqual({
      clientId: ACCEPTED_CLIENT_ID,
      officeIds: [...OWN_OFFICES],
      defaultOfficeId: OWN_OFFICES[0],
      queuingOfficeId: OWN_OFFICES[0],
      ownerOfficeId: OWN_OFFICES[1],
    });
    const submissionCiphertext = pending["secret_ciphertext"] as Buffer;
    expect(submissionCiphertext).toBeInstanceOf(Buffer);
    // The portal sees the open submission next to the connection it does not change yet.
    const [waiting] = await listConnections(ota);
    expect(waiting).toMatchObject({
      credentialSource: "velexis",
      pendingSubmission: { id: submissionId, status: "pending", errorCode: null },
    });

    await connectionsQueue.resume();
    const applied = await waitForStatus(submissionId, "applied");

    expect(applied).toMatchObject({
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
      error_code: null,
    });
    const connection = await connectionOf(ota.tenant.id, "test");
    expect(connection).toMatchObject({
      id: ota.connection.id,
      credential_source: "tenant",
      amadeus_account_id: null,
      base_url: stub.url,
      client_id: ACCEPTED_CLIENT_ID,
      encryption_key_id: envelope.currentKekId(),
      office_ids: [...OWN_OFFICES],
      default_office_id: OWN_OFFICES[0],
      queuing_office_id: OWN_OFFICES[0],
      owner_office_id: OWN_OFFICES[1],
      status: "active",
      last_verified_at: t.clock.now(),
      last_error: null,
      version: ota.connection.version + 1,
    });
    // Re-encrypted: a new envelope bound to the connection's row, which the submission's associated data cannot open.
    const connectionCiphertext = connection?.["client_secret_ciphertext"] as Buffer;
    expect(connectionCiphertext.equals(submissionCiphertext)).toBe(false);
    expect(await decrypt(connectionCiphertext, connectionSecretPlace(ota.connection.id))).toBe(
      acceptedSecret,
    );
    await expect(
      decrypt(connectionCiphertext, secretPlace("secret_ciphertext", submissionId)),
    ).rejects.toThrow();
    await expect(decrypt(submissionCiphertext, connectionSecretPlace(ota.connection.id))).rejects.toThrow();
    // The Velexis office keeps serving the OTA's old orders until an admin releases it (PADR-0012 item 4).
    expect(await officeRow(ota.office.id)).toMatchObject({
      status: "releasing",
      assigned_tenant_id: ota.tenant.id,
      release_requested_at: t.clock.now(),
      version: ota.office.version + 1,
    });
    expect(stub.requests().map((request) => [request.operation, request.status])).toEqual([
      ["oauth2Token", 200],
    ]);

    const audit = await auditOf(submissionId);
    expect(audit.map((entry) => [entry["action"], entry["actor_type"]])).toEqual([
      ["amadeus.credentials_submitted", "account"],
      ["amadeus.credentials_applied", "system"],
    ]);
    expect(audit[0]?.["actor_account_id"]).toBe(owner.id);
    expect(audit[1]?.["details"]).toMatchObject({
      kind: "amadeus",
      environment: "test",
      connectionCreated: false,
      releasingOfficeIds: [ota.office.office_id],
      before: {
        status: "verifying",
        connectionId: ota.connection.id,
        credentialSource: "velexis",
        amadeusAccountId: testAccount.id,
        officeIds: [ota.office.office_id],
        version: ota.connection.version,
      },
      after: {
        status: "applied",
        connectionId: ota.connection.id,
        credentialSource: "tenant",
        connectionStatus: "active",
        amadeusAccountId: null,
        baseUrl: stub.url,
        clientId: ACCEPTED_CLIENT_ID,
        officeIds: [...OWN_OFFICES],
        version: ota.connection.version + 1,
      },
    });
    const [released] = await auditOf(ota.office.id);
    expect(released).toMatchObject({
      action: "amadeus_office.released",
      actor_type: "system",
      actor_label: "credentials.verify",
      tenant_id: ota.tenant.id,
    });
    expect(released?.["details"]).toMatchObject({
      officeId: ota.office.office_id,
      environment: "test",
      reason: "own_credentials_applied",
      submissionId,
      connectionId: ota.connection.id,
      before: { status: "assigned" },
      after: { status: "releasing" },
    });
    // The OTA backend drops its cached connection and account rows at once.
    await waitForEvent({ v: 1, type: "connection", tenantId: ota.tenant.id });
    await waitForEvent({ v: 1, type: "amadeus_account", id: testAccount.id });

    expect(await emailsOf(ota.tenant.id)).toMatchObject([
      { template: "connection.credentials_applied", to_email: owner.email, account_id: owner.id },
    ]);
    const message = await waitForMessage({ to: owner.email, timeoutMs: MAIL_WAIT_MS });
    expect(message.Subject).toBe(`Amadeus credentials verified for ${ota.tenant.name} (test)`);

    const [switched] = await listConnections(ota);
    expect(switched).toMatchObject({
      id: ota.connection.id,
      credentialSource: "tenant",
      clientId: ACCEPTED_CLIENT_ID,
      status: "active",
      officeIds: [...OWN_OFFICES],
      pendingSubmission: null,
    });
    expect((await connectionsQueue.getJob(submissionId))?.data).toEqual({ submissionId });
  });

  it("[PBE-053 AC2] creates the connection of an environment without one (own live credentials before a Velexis live office)", async () => {
    const ota = await arrangeOta();
    const admin = person(ota, "admin");

    const res = await submit(ota, body({ ownerOfficeId: undefined }), { who: "admin", environment: "live" });

    expect(res.status).toBe(202);
    const submissionId = submissionIdOf(res);
    await waitForStatus(submissionId, "applied");
    const live = await connectionOf(ota.tenant.id, "live");
    expect(live).toMatchObject({
      credential_source: "tenant",
      amadeus_account_id: null,
      base_url: stub.url,
      client_id: ACCEPTED_CLIENT_ID,
      office_ids: [...OWN_OFFICES],
      default_office_id: OWN_OFFICES[0],
      queuing_office_id: OWN_OFFICES[0],
      owner_office_id: OWN_OFFICES[0],
      ticketing_defaults: {},
      monitored_queues: [],
      status: "active",
      created_by_account_id: admin.id,
      version: 1,
    });
    const liveId = live?.["id"] as string;
    expect(liveId).toMatch(/^sc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await decrypt(live?.["client_secret_ciphertext"], connectionSecretPlace(liveId))).toBe(
      acceptedSecret,
    );
    // The test environment and its Velexis office are untouched.
    expect(await connectionOf(ota.tenant.id, "test")).toEqual(ota.connection);
    expect(await officeRow(ota.office.id)).toEqual(ota.office);
    const applied = (await auditOf(submissionId)).find(
      (entry) => entry["action"] === "amadeus.credentials_applied",
    );
    expect(applied?.["details"]).toMatchObject({
      environment: "live",
      connectionCreated: true,
      releasingOfficeIds: [],
      before: { connectionId: null },
      after: { connectionId: liveId, credentialSource: "tenant", version: 1 },
    });
    await waitForEvent({ v: 1, type: "connection", tenantId: ota.tenant.id });
    expect(
      (await listConnections(ota)).map((connection) => [
        connection["environment"],
        connection["credentialSource"],
      ]),
    ).toEqual([
      ["test", "velexis"],
      ["live", "tenant"],
    ]);
  });

  it("[PBE-053 AC2] [FIX-W39-PLATFORM AC6] switches a connection already on the OTA's credentials again (a rotation): a new envelope and offices, the queues and releasing office kept, the automated processes of offices it no longer holds dropped", async () => {
    const ota = await arrangeOta();
    // Settings the OTA made on its Velexis office (PBE-040). The switches keep the monitored queues (PADR-0012 item 4,
    // flow §D) and drop each automatedProcess entry of an office the new credentials do not hold (FIX-W39-PLATFORM,
    // lead decision (2j) of 2026-11-02: ADR-0012 office isolation, PBE-040's rule); an entry without an office stays.
    const velexisEntry = { code: "DELAYED", officeId: ota.office.office_id, delay: "1D" };
    const firstOwnEntry = {
      code: "IMMEDIATE",
      officeId: OWN_OFFICES[0],
      queue: { number: "7", category: "1" },
    };
    const officelessEntry = { code: "ERROR", text: "Ticketing failed" };
    const ticketingDefaults = {
      ticketingAgreement: { option: "DELAY_TO_CANCEL", delay: "2D" },
      automatedProcess: [velexisEntry, firstOwnEntry, officelessEntry],
      issue: false,
    };
    const monitoredQueues = [{ officeId: ota.office.office_id, queueId: 7, category: 1 }];
    await pool.query(
      "UPDATE platform.supplier_connections SET ticketing_defaults = $2, monitored_queues = $3 WHERE id = $1",
      [ota.connection.id, JSON.stringify(ticketingDefaults), JSON.stringify(monitoredQueues)],
    );
    const first = submissionIdOf(await submit(ota));
    await waitForStatus(first, "applied");
    const switched = (await connectionOf(ota.tenant.id, "test")) as Row;
    const releasing = await officeRow(ota.office.id);
    expect([switched["credential_source"], releasing["status"]]).toEqual(["tenant", "releasing"]);
    // The Velexis office's automated process is gone; the queue of the releasing office stays usable.
    const afterFirst = { ...ticketingDefaults, automatedProcess: [firstOwnEntry, officelessEntry] };
    expect([switched["ticketing_defaults"], switched["monitored_queues"]]).toEqual([
      afterFirst,
      monitoredQueues,
    ]);
    expect(
      (await auditOf(first)).find((entry) => entry["action"] === "amadeus.credentials_applied")?.["details"],
    ).toMatchObject({
      droppedAutomatedProcessOfficeIds: [ota.office.office_id],
      before: { ticketingDefaults },
      after: { ticketingDefaults: afterFirst },
    });
    t.clock.advance(60_000);

    const res = await submit(
      ota,
      body({ officeIds: [OWN_OFFICES[1]], defaultOfficeId: OWN_OFFICES[1], ownerOfficeId: undefined }),
      { who: "admin" },
    );

    expect(res.status).toBe(202);
    const second = submissionIdOf(res);
    await waitForStatus(second, "applied");
    const rotated = await connectionOf(ota.tenant.id, "test");
    const afterRotation = { ...ticketingDefaults, automatedProcess: [officelessEntry] };
    expect(rotated).toMatchObject({
      id: ota.connection.id,
      credential_source: "tenant",
      amadeus_account_id: null,
      base_url: stub.url,
      client_id: ACCEPTED_CLIENT_ID,
      office_ids: [OWN_OFFICES[1]],
      default_office_id: OWN_OFFICES[1],
      queuing_office_id: OWN_OFFICES[1],
      owner_office_id: OWN_OFFICES[1],
      ticketing_defaults: afterRotation,
      monitored_queues: monitoredQueues,
      status: "active",
      last_verified_at: t.clock.now(),
      created_by_account_id: switched["created_by_account_id"],
      version: (switched["version"] as number) + 1,
    });
    // A new envelope for the same row: it differs from the first switch's and opens with the connection's data.
    const ciphertext = rotated?.["client_secret_ciphertext"] as Buffer;
    expect(ciphertext.equals(switched["client_secret_ciphertext"] as Buffer)).toBe(false);
    expect(await decrypt(ciphertext, connectionSecretPlace(ota.connection.id))).toBe(acceptedSecret);
    // The office the first switch set releasing is left as it was: one release, by the first switch.
    expect(await officeRow(ota.office.id)).toEqual(releasing);
    expect((await auditOf(ota.office.id)).map((entry) => entry["details"])).toMatchObject([
      { submissionId: first, reason: "own_credentials_applied" },
    ]);
    const applied = (await auditOf(second)).find(
      (entry) => entry["action"] === "amadeus.credentials_applied",
    );
    expect(applied?.["details"]).toMatchObject({
      connectionCreated: false,
      releasingOfficeIds: [],
      droppedAutomatedProcessOfficeIds: [OWN_OFFICES[0]],
      before: {
        credentialSource: "tenant",
        amadeusAccountId: null,
        officeIds: [...OWN_OFFICES],
        ticketingDefaults: afterFirst,
        version: switched["version"],
      },
      after: {
        credentialSource: "tenant",
        officeIds: [OWN_OFFICES[1]],
        ticketingDefaults: afterRotation,
        version: (switched["version"] as number) + 1,
      },
    });
    // One e-mail to each submitter (outbox ids say nothing about the order in which they were queued).
    const emails = (await emailsOf(ota.tenant.id)).map((email) => [email["template"], email["account_id"]]);
    expect(emails).toHaveLength(2);
    expect(emails).toEqual(
      expect.arrayContaining([
        ["connection.credentials_applied", person(ota, "owner").id],
        ["connection.credentials_applied", person(ota, "admin").id],
      ]),
    );
  });

  it("[PBE-053 AC1] leaves the connection unchanged for credentials Amadeus refuses, erases the secret and e-mails the submitter", async () => {
    const ota = await arrangeOta();
    const owner = person(ota, "owner");
    const wrong = newSecret();

    const res = await submit(ota, body({ clientSecret: wrong }));

    expect(res.status).toBe(202);
    const submissionId = submissionIdOf(res);
    const failed = await waitForStatus(submissionId, "failed");
    expect(failed).toMatchObject({
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
      error_code: "AMADEUS_CREDENTIALS_INVALID",
      error_message:
        "Amadeus refused the client id and secret (HTTP 401 invalid_client (Amadeus code 38187)).",
      attempts: 1,
    });
    expect(stub.requests().map((request) => [request.operation, request.status])).toEqual([
      ["oauth2Token", 401],
    ]);
    // The working connection and its office are exactly as they were.
    expect(await connectionOf(ota.tenant.id, "test")).toEqual(ota.connection);
    expect(await officeRow(ota.office.id)).toEqual(ota.office);
    expect(await auditOf(ota.office.id)).toEqual([]);
    expect((await auditOf(submissionId)).map((entry) => entry["action"])).toEqual([
      "amadeus.credentials_submitted",
      "amadeus.credentials_rejected",
    ]);

    const [email] = await emailsOf(ota.tenant.id);
    expect(email).toMatchObject({ template: "connection.credentials_failed", to_email: owner.email });
    expect(email?.["data"]).toMatchObject({
      credentials: "Amadeus credentials",
      environment: "test",
      errorCode: "AMADEUS_CREDENTIALS_INVALID",
    });
    const message = await waitForMessage({ to: owner.email, timeoutMs: MAIL_WAIT_MS });
    expect(message.Subject).toBe(`Amadeus credentials not verified for ${ota.tenant.name} (test)`);
    expect(message.Text).toContain("(AMADEUS_CREDENTIALS_INVALID)");

    const [connection] = await listConnections(ota);
    expect(connection).toMatchObject({
      credentialSource: "velexis",
      status: "active",
      pendingSubmission: { id: submissionId, status: "failed", errorCode: "AMADEUS_CREDENTIALS_INVALID" },
    });
  });

  it("[PBE-053 AC1] requires a TOTP step-up, and MFA, before it stores anything", async () => {
    const ota = await arrangeOta();

    const noStepUp = await submit(ota, body(), { stepUp: false });
    expect(noStepUp.status).toBe(401);
    expect(errorOf(noStepUp).code).toBe("REAUTH_REQUIRED");
    expectResponseToMatch("submitAmadeusCredentials", noStepUp, { document: "platform" });

    const noMfa = await submit(ota, body(), { who: "ownerWithoutMfa" });
    expect(noMfa.status).toBe(403);
    expect(errorOf(noMfa).code).toBe("MFA_REQUIRED");

    expect(await submissionsOf(ota.tenant.id)).toEqual([]);
    expect(stub.requests()).toEqual([]);
  });

  it("[PBE-053 AC1] is for owners and admins while own Amadeus credentials are on", async () => {
    const ota = await arrangeOta();

    const outcomes: string[] = [];
    for (const who of ["finance", "agent", "viewer", "stranger"] as const) {
      const res = await submit(ota, body(), { who });
      outcomes.push(`${who} ${res.status} ${errorOf(res).code}`);
    }
    switches.on.delete("own_amadeus");
    const off = await submit(ota);

    expect(outcomes).toEqual([
      "finance 403 FORBIDDEN",
      "agent 403 FORBIDDEN",
      "viewer 403 FORBIDDEN",
      "stranger 404 NOT_FOUND",
    ]);
    expect(off.status).toBe(403);
    expect(errorOf(off)).toMatchObject({ code: "FEATURE_DISABLED", details: { feature: "own_amadeus" } });
    expect(await submissionsOf(ota.tenant.id)).toEqual([]);
  });

  it("[PBE-053 AC1] refuses offices outside officeIds with a field error each, and an OTA that is not active", async () => {
    const ota = await arrangeOta();

    const outside = await submit(
      ota,
      body({ defaultOfficeId: "NCE1A9998", queuingOfficeId: "NCE1A9999", ownerOfficeId: OWN_OFFICES[1] }),
    );
    expect(outside.status).toBe(400);
    expectResponseToMatch("submitAmadeusCredentials", outside, { document: "platform" });
    expect(errorOf(outside)).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [
        { path: "/defaultOfficeId", code: "unknown" },
        { path: "/queuingOfficeId", code: "unknown" },
      ],
    });
    const malformed = await submit(ota, body({ officeIds: ["osln12345"], defaultOfficeId: "osln12345" }));
    expect([malformed.status, errorOf(malformed).code]).toEqual([400, "VALIDATION_FAILED"]);

    await pool.query("UPDATE platform.tenants SET status = 'suspended' WHERE id = $1", [ota.tenant.id]);
    const suspended = await submit(ota);
    expect(suspended.status).toBe(409);
    expect(errorOf(suspended)).toMatchObject({ code: "TENANT_NOT_ACTIVE", details: { status: "suspended" } });

    expect(await submissionsOf(ota.tenant.id)).toEqual([]);
  });
});

describe("credentials.verify of an amadeus submission (the worker's verifier)", () => {
  it("[PBE-053] is the worker graph's verifier of the amadeus kind", () => {
    const registered = worker.get(CredentialVerifiers, { strict: false }).get("amadeus");

    expect(registered).toBeInstanceOf(AmadeusCredentialsVerifier);
    expect((registered as AmadeusCredentialsVerifier).baseUrlOf("live")).toBe(stub.url);
  });

  it("[PBE-053] retries an Amadeus that cannot answer, then fails with PROVIDER_UNAVAILABLE and leaves the connection", async () => {
    const ota = await arrangeOta();
    stub.setDefaultScenario("server-error");

    const res = await submit(ota);
    const submissionId = submissionIdOf(res);
    const failed = await waitForStatus(submissionId, "failed");

    expect(failed).toMatchObject({
      secret_ciphertext: null,
      error_code: "PROVIDER_UNAVAILABLE",
      attempts: 5,
    });
    expect(failed["error_message"]).toMatch(/^Amadeus could not verify the credentials \(HTTP 500\b/);
    expect(stub.requests().map((request) => request.status)).toEqual([500, 500, 500, 500, 500]);
    expect(await connectionOf(ota.tenant.id, "test")).toEqual(ota.connection);
    expect(await officeRow(ota.office.id)).toEqual(ota.office);
  });

  it("[PBE-053] [FIX-W39-PLATFORM AC5] does not switch a connection a platform admin disabled after the submission (CONNECTION_DISABLED)", async () => {
    const ota = await arrangeOta();
    // Disabled while the submission waits: the submit itself refuses a disabled connection up front (the next test).
    await connectionsQueue.pause();
    const submissionId = submissionIdOf(await submit(ota));
    await pool.query("UPDATE platform.supplier_connections SET status = 'disabled' WHERE id = $1", [
      ota.connection.id,
    ]);
    const disabled = await connectionOf(ota.tenant.id, "test");

    await connectionsQueue.resume();
    const failed = await waitForStatus(submissionId, "failed");

    expect(failed).toMatchObject({ secret_ciphertext: null, error_code: "CONNECTION_DISABLED", attempts: 1 });
    expect(await connectionOf(ota.tenant.id, "test")).toEqual(disabled);
    expect(await officeRow(ota.office.id)).toEqual(ota.office);
    expect(await auditOf(ota.office.id)).toEqual([]);
  });

  it("[FIX-W39-PLATFORM AC5] refuses a connection a platform admin disabled up front with 409 CONFLICT connection_disabled, and writes nothing", async () => {
    const ota = await arrangeOta();
    await pool.query("UPDATE platform.supplier_connections SET status = 'disabled' WHERE id = $1", [
      ota.connection.id,
    ]);
    const disabled = await connectionOf(ota.tenant.id, "test");

    const res = await submit(ota);

    expect([res.status, errorOf(res)]).toEqual([
      409,
      expect.objectContaining({ code: "CONFLICT", details: { reason: "connection_disabled" } }),
    ]);
    expectResponseToMatch("submitAmadeusCredentials", res, { document: "platform" });
    // No submission, no audit row of one, no job: the connection and its office as they were.
    expect(await submissionsOf(ota.tenant.id)).toEqual([]);
    expect(
      await rowsOf(
        "SELECT id FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = 'amadeus.credentials_submitted'",
        [ota.tenant.id],
      ),
    ).toEqual([]);
    expect(await connectionOf(ota.tenant.id, "test")).toEqual(disabled);
    expect(await officeRow(ota.office.id)).toEqual(ota.office);
    expect(stub.requests()).toEqual([]);

    // Another environment of the OTA is not affected: its own credentials for live are taken.
    const live = await submit(ota, body(), { environment: "live" });
    expect(live.status).toBe(202);
    await waitForStatus(submissionIdOf(live), "applied");
  });

  it("[PBE-053] keeps the connection of an OTA suspended after it submitted (TENANT_NOT_ACTIVE)", async () => {
    const ota = await arrangeOta();
    await connectionsQueue.pause();
    const submissionId = submissionIdOf(await submit(ota));
    await pool.query("UPDATE platform.tenants SET status = 'suspended' WHERE id = $1", [ota.tenant.id]);

    await connectionsQueue.resume();
    const failed = await waitForStatus(submissionId, "failed");

    expect(failed).toMatchObject({ secret_ciphertext: null, error_code: "TENANT_NOT_ACTIVE", attempts: 1 });
    expect(await connectionOf(ota.tenant.id, "test")).toEqual(ota.connection);
    expect(await officeRow(ota.office.id)).toEqual(ota.office);
  });
});
