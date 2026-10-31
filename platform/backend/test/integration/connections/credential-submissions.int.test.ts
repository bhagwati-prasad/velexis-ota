// The credential submission framework (PBE-052; PADR-0010, data-model-migration-0002.md `credential_submissions`,
// api-inventory-resources.md §3 `getCredentialSubmission`). The API's CredentialSubmissionsService (createTestApp)
// submits in a transaction of the test, as the operations of PBE-053 and PBE-057 will; the worker's module graph
// (WorkerModule, as dist/worker.js builds it, with the API's FakeClock) runs `credentials.verify` from the same Redis
// database and database clone. No real verifier exists yet (PBE-053 and PBE-057 add them), so this file registers a
// test verifier for both kinds in the worker's registry, from a module of its own that imports
// `CredentialSubmissionsModule.forWorker()` as theirs will (TestVerifierModule); each test scripts its answers
// (`verifier.onCheck`, `verifier.onApply`). Its `apply` writes a marker on the OTA's test payment connection
// (`last_error`), so a test sees that the apply ran in the job's transaction, or rolled back with it.
//
// The secrets are random per test, and after every test no log line of either process (at `trace`), no Redis value
// (the BullMQ jobs, their data, results and errors) and no audit or outbox row holds one. Every address is a
// `uniqueEmail` of this file, and the worker's e-mail processor sends to Mailpit. A delayed retry is promoted at once
// instead of waiting for its backoff (ADR-0009: 30 s, then doubling).
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Job, Queue } from "bullmq";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformTransaction } from "../../../src/audit/audit.repository";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { CredentialSubmissionsModule } from "../../../src/common/credentials/credential-submissions.module";
import {
  secretPlace,
  type CredentialKind,
} from "../../../src/common/credentials/credential-submissions.repository";
import {
  CREDENTIALS_VERIFY_JOB,
  CredentialSubmissionsService,
  InvalidCredentialSubmissionError,
  type SubmitCredentialsInput,
} from "../../../src/common/credentials/credential-submissions.service";
import {
  CredentialRejection,
  CredentialVerifiers,
  PROVIDER_UNAVAILABLE,
  SECRET_PLACEHOLDER,
  VERIFICATION_INCOMPLETE_MESSAGE,
  type CredentialApplied,
  type CredentialApplyInput,
  type CredentialCheck,
  type CredentialCheckInput,
  type CredentialVerifier,
} from "../../../src/common/credentials/credentials-verify.processor";
import { associatedData, EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_DB, PLATFORM_POOL, type PlatformDb, type PlatformPool } from "../../../src/common/database";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { runInTransaction } from "../../../src/common/redis/invalidation.publisher";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertPaymentConnection,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember, insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/**
 * The database clone, the API's and the worker's Nest module graphs and the platform document of
 * expectResponseToMatch; the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish a submission (it takes milliseconds; under Vitest's 5 s). */
const WAIT_MS = 3_000;
const WAIT = { timeout: WAIT_MS, interval: 20 } as const;
/** How long a test waits for the worker's e-mail to reach Mailpit. */
const MAIL_WAIT_MS = 3_000;
/** The first number of this file's ids (`testId`), away from the other test files'. */
const FIRST_ID = 52_000;
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.52";
const SESSION = testId("asn", FIRST_ID);

type Row = Record<string, unknown>;

/** What the test verifier does for one call; the defaults verify and apply. */
type OnCheck = (input: CredentialCheckInput) => Promise<CredentialCheck>;
type OnApply = (
  trx: PlatformTransaction,
  input: CredentialApplyInput,
) => Promise<CredentialApplied | undefined>;

/**
 * The verifier of both kinds in this file: it records every call (the decrypted secrets included, to compare them)
 * and answers as the test scripts it. Its default apply writes the marker `applied <submissionId>` into `last_error` of
 * the OTA's test payment connection, in the job's transaction.
 */
class TestVerifier implements CredentialVerifier {
  readonly checks: CredentialCheckInput[] = [];
  readonly applies: CredentialApplyInput[] = [];
  onCheck: OnCheck = () => Promise.resolve({ outcome: "verified", result: { accountId: "acct_testalpha" } });
  onApply: OnApply = (trx, input) => writeMarker(trx, input);

  async check(input: CredentialCheckInput): Promise<CredentialCheck> {
    this.checks.push(input);
    return this.onCheck(input);
  }

  async apply(trx: PlatformTransaction, input: CredentialApplyInput): Promise<CredentialApplied | undefined> {
    this.applies.push(input);
    return this.onApply(trx, input);
  }

  reset(): void {
    this.checks.length = 0;
    this.applies.length = 0;
    this.onCheck = () => Promise.resolve({ outcome: "verified", result: { accountId: "acct_testalpha" } });
    this.onApply = (trx, input) => writeMarker(trx, input);
  }
}

/** The default apply: the marker on the OTA's test payment connection, and what the audit row adds. */
async function writeMarker(
  trx: PlatformTransaction,
  input: CredentialApplyInput,
): Promise<CredentialApplied> {
  await trx
    .updateTable("platform.payment_provider_connections")
    .set({ last_error: `applied ${input.submissionId}` })
    .where("tenant_id", "=", input.tenantId)
    .where("environment", "=", "test")
    .execute();
  return {
    before: { connection: "velexis" },
    after: { connection: "switched" },
    details: { verifiedAccount: (input.result as { accountId?: string } | undefined)?.accountId ?? null },
  };
}

const verifier = new TestVerifier();

/**
 * Registers the test verifier for both kinds the way PBE-053 and PBE-057 register theirs: from a module of its own that
 * imports `CredentialSubmissionsModule.forWorker()`, in `onModuleInit`. So every test also proves that each importer of
 * `forWorker()` reaches the one registry the worker's `credentials.verify` reads (Nest 11 tells dynamic modules apart
 * by object reference: a `{ module: … }` built per call would give this module a registry of its own).
 */
@Injectable()
class TestVerifierRegistration implements OnModuleInit {
  constructor(private readonly verifiers: CredentialVerifiers) {}

  onModuleInit(): void {
    this.verifiers.register("amadeus", verifier);
    this.verifiers.register("stripe_api_keys", verifier);
  }
}

@Module({ imports: [CredentialSubmissionsModule.forWorker()], providers: [TestVerifierRegistration] })
class TestVerifierModule {}

const workerLogs = new LogSink();
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let verifiers: CredentialVerifiers;
let submissions: CredentialSubmissionsService;
let envelope: EnvelopeService;
let platformDb: PlatformDb;
let connectionsQueue: Queue;
let tokens: TokenService;
let next = FIRST_ID;
/** The secrets of the current test: none may appear in a log line, a Redis value or a row. */
const secretsOfTest: string[] = [];

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs and the platform document of expectResponseToMatch.
  t = await createTestApp({ env: { LOG_LEVEL: "trace" } });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  submissions = t.app.get(CredentialSubmissionsService, { strict: false });
  envelope = t.app.get(EnvelopeService, { strict: false });
  platformDb = t.app.get<PlatformDb>(PLATFORM_DB);
  tokens = t.app.get(TokenService);
  connectionsQueue = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.connections), { strict: false });
  responseChecker("platform");

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({
    imports: [WorkerModule.forRoot(t.config, logger), TestVerifierModule],
  })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .compile();
  await worker.init();
  verifiers = worker.get(CredentialVerifiers, { strict: false });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(() => {
  verifier.reset();
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

/** An OTA of this file: an owner (the submitter), an admin, its test payment connection. */
interface Ota {
  readonly tenant: PlatformRow<"tenants">;
  readonly owner: PlatformRow<"accounts">;
  readonly admin: PlatformRow<"accounts">;
}

async function arrangeOta(): Promise<Ota> {
  const n = next++;
  const { tenant } = await insertOta(pool, {
    tenant: { id: testId("ten", n), key: `crs${n}`, name: `Agency ${n} Travel` },
  });
  const owner = await insertAccount(pool, {
    id: testId("acc", next++),
    email: uniqueEmail("owner-pbe052"),
    full_name: `Owner ${n}`,
  });
  const admin = await insertAccount(pool, { id: testId("acc", next++), email: uniqueEmail("admin-pbe052") });
  await insertMember(pool, tenant, owner, "owner");
  await insertMember(pool, tenant, admin, "admin");
  await insertPaymentConnection(pool, tenant, { id: testId("ppc", next++) });
  return { tenant, owner, admin };
}

/** A random secret of this test, remembered for the checks after it. */
function newSecret(prefix: string): string {
  const secret = `${prefix}${randomBytes(18).toString("hex")}`;
  secretsOfTest.push(secret);
  return secret;
}

/** The secrets of a submission of `kind`: Stripe API keys carry the webhook secret too. */
function secretsFor(kind: CredentialKind): SubmitCredentialsInput["secrets"] {
  return kind === "amadeus"
    ? { secret: newSecret("amadeus-secret-") }
    : { secret: newSecret("sk_test_"), webhookSecret: newSecret("whsec_") };
}

/** The non-secret fields of a submission of `kind`. */
function publicDataFor(kind: CredentialKind): Record<string, unknown> {
  return kind === "amadeus"
    ? { clientId: "acme-amadeus-client", officeIds: ["OSLN12345"], defaultOfficeId: "OSLN12345" }
    : { publishableKey: "pk_test_1TestPublishableKeyOnly" };
}

/** Submits as the operations of PBE-053 and PBE-057 will: in a transaction of their own; answers the input and row. */
async function submit(
  ota: Ota,
  kind: CredentialKind = "amadeus",
  environment: "test" | "live" = "test",
  submittedBy: string = ota.owner.id,
) {
  const input: SubmitCredentialsInput = {
    tenantId: ota.tenant.id,
    kind,
    environment,
    publicData: publicDataFor(kind),
    secrets: secretsFor(kind),
    submittedBy,
  };
  const row = await runInTransaction(platformDb, (trx) => submissions.submit(trx, input));
  return { input, row };
}

// ---- Rows, jobs and the worker -------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[]): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const submissionRow = async (id: string): Promise<Row> =>
  (await rowsOf("SELECT * FROM platform.credential_submissions WHERE id = $1", [id]))[0] as Row;

const auditOf = (targetId: string): Promise<Row[]> =>
  rowsOf("SELECT * FROM platform.platform_audit_log WHERE target_id = $1 ORDER BY id", [targetId]);

const emailsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT template, to_email, account_id, data FROM platform.email_outbox WHERE tenant_id = $1 ORDER BY id",
    [tenantId],
  );

const markerOf = async (tenantId: string): Promise<unknown> =>
  (
    await rowsOf(
      "SELECT last_error FROM platform.payment_provider_connections WHERE tenant_id = $1 AND environment = 'test'",
      [tenantId],
    )
  )[0]?.["last_error"];

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

/** Waits until the BullMQ job of the submission is in `state`; answers it. */
async function waitForJob(id: string, state: "completed" | "failed" | "delayed"): Promise<Job> {
  return vi.waitFor(async () => {
    const job = await connectionsQueue.getJob(id);
    expect(job, `the job of ${id}`).toBeDefined();
    expect(await job?.getState()).toBe(state);
    return job as Job;
  }, WAIT);
}

/**
 * Pauses `platform-connections` for every worker (BullMQ's queue pause, which the worker's next fetch obeys; a pause of
 * the worker itself would not stop a fetch already waiting), so submissions stay `pending` until `resumeWorker()`; a
 * paused queue is resumed after every test.
 */
async function pauseWorker(): Promise<void> {
  await connectionsQueue.pause();
}

async function resumeWorker(): Promise<void> {
  await connectionsQueue.resume();
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

/** No secret of the test in a log line of either process, a Redis value, an audit row or an outbox row. */
async function expectNoSecretAnywhere(): Promise<void> {
  if (secretsOfTest.length === 0) {
    return;
  }
  const logs = JSON.stringify([...t.logs.lines, ...workerLogs.lines]);
  const redis = await redisValues();
  const rows = JSON.stringify([
    ...(await rowsOf("SELECT * FROM platform.platform_audit_log", [])),
    ...(await rowsOf("SELECT * FROM platform.email_outbox", [])),
    ...(await rowsOf(
      "SELECT id, public_data, error_code, error_message FROM platform.credential_submissions",
      [],
    )),
  ]);
  for (const secret of secretsOfTest) {
    expect(logs.includes(secret), "a secret in a log line").toBe(false);
    expect(redis.includes(secret), "a secret in Redis").toBe(false);
    expect(rows.includes(secret), "a secret in a row").toBe(false);
  }
}

/** The plaintext of a submission's ciphertext column, decrypted with the associated data of `rowId`. */
async function decryptAs(
  ciphertext: unknown,
  column: "secret_ciphertext" | "webhook_secret_ciphertext",
  rowId: string,
) {
  const plaintext = await envelope.decrypt(ciphertext as Buffer, secretPlace(column, rowId));
  return plaintext.toString("utf8");
}

/** The headers of a portal call by `accountId`. */
async function as(accountId: string): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: SESSION,
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

const errorOf = (res: Response): string => (res.body as { error: { code: string } }).error.code;

// ---- Tests ---------------------------------------------------------------------------------------------------------

describe("CredentialSubmissionsService.submit", () => {
  it("[PBE-052 AC1] supersedes the open submission of the tenant, kind and environment and erases its secrets", async () => {
    const ota = await arrangeOta();
    const other = await arrangeOta();
    await pauseWorker();
    const first = await submit(ota, "stripe_api_keys", "test");
    const otherEnvironment = await submit(ota, "stripe_api_keys", "live");
    const otherKind = await submit(ota, "amadeus", "test");
    const otherTenant = await submit(other, "stripe_api_keys", "test");
    const firstRow = await submissionRow(first.row.id);
    expect(firstRow).toMatchObject({ status: "pending", attempts: 0, submitted_by_account_id: ota.owner.id });
    // Each secret is bound to its column and row: the webhook secret decrypts only as the webhook secret of this row.
    expect(associatedData(secretPlace("secret_ciphertext", first.row.id))).toBe(
      `platform.credential_submissions.secret_ciphertext:${first.row.id}`,
    );
    expect(associatedData(secretPlace("webhook_secret_ciphertext", first.row.id))).toBe(
      `platform.credential_submissions.webhook_secret_ciphertext:${first.row.id}`,
    );
    expect(await decryptAs(firstRow["secret_ciphertext"], "secret_ciphertext", first.row.id)).toBe(
      first.input.secrets.secret,
    );
    expect(
      await decryptAs(firstRow["webhook_secret_ciphertext"], "webhook_secret_ciphertext", first.row.id),
    ).toBe(first.input.secrets.webhookSecret);
    await expect(
      decryptAs(firstRow["webhook_secret_ciphertext"], "secret_ciphertext", first.row.id),
    ).rejects.toThrow();

    const second = await submit(ota, "stripe_api_keys", "test");

    const superseded = await submissionRow(first.row.id);
    expect(superseded).toMatchObject({
      status: "superseded",
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
      error_code: null,
    });
    expect(superseded["finished_at"]).toEqual(t.clock.now());
    const secondRow = await submissionRow(second.row.id);
    expect(secondRow["status"]).toBe("pending");
    expect(await decryptAs(secondRow["secret_ciphertext"], "secret_ciphertext", second.row.id)).toBe(
      second.input.secrets.secret,
    );
    // A ciphertext copied to another row does not decrypt there (ADR-0010).
    await expect(
      decryptAs(secondRow["secret_ciphertext"], "secret_ciphertext", first.row.id),
    ).rejects.toThrow();
    // Another environment, another kind and another OTA keep their open submissions.
    for (const kept of [otherEnvironment, otherKind, otherTenant]) {
      expect((await submissionRow(kept.row.id))["status"]).toBe("pending");
    }
    const [audit] = await auditOf(second.row.id);
    expect(audit).toMatchObject({
      action: "payments.api_keys_submitted",
      actor_type: "account",
      actor_account_id: ota.owner.id,
      target_type: "credential_submission",
      tenant_id: ota.tenant.id,
    });
    expect(audit?.["details"]).toMatchObject({
      kind: "stripe_api_keys",
      environment: "test",
      supersededSubmissionIds: [first.row.id],
      after: { status: "pending", publicData: { publishableKey: "pk_test_1TestPublishableKeyOnly" } },
    });
    expect((await auditOf(otherKind.row.id))[0]?.["action"]).toBe("amadeus.credentials_submitted");
    // The job of each submission carries its id and nothing else.
    const job = await connectionsQueue.getJob(second.row.id);
    expect(job?.name).toBe(CREDENTIALS_VERIFY_JOB);
    expect(job?.data).toEqual({ submissionId: second.row.id });
    expect(job?.opts.attempts).toBe(5);

    // Once the worker runs, the superseded submission is skipped: its secrets are gone, and nothing asks the provider.
    await resumeWorker();
    for (const id of [second.row.id, otherEnvironment.row.id, otherKind.row.id, otherTenant.row.id]) {
      await waitForStatus(id, "applied");
    }
    expect(await waitForJob(first.row.id, "completed")).toMatchObject({
      returnvalue: { submissionId: first.row.id, status: "superseded" },
    });
    expect(verifier.checks.map((check) => check.submissionId)).not.toContain(first.row.id);
  });

  it("[PBE-052 AC1] lets two submissions at the same time leave exactly one open submission", async () => {
    const ota = await arrangeOta();
    await pauseWorker();

    const [a, b] = await Promise.all([submit(ota, "amadeus", "live"), submit(ota, "amadeus", "live")]);

    const statuses = [(await submissionRow(a.row.id))["status"], (await submissionRow(b.row.id))["status"]];
    expect(statuses.sort()).toEqual(["pending", "superseded"]);
    const open = await rowsOf(
      "SELECT id FROM platform.credential_submissions WHERE tenant_id = $1 AND status IN ('pending', 'verifying')",
      [ota.tenant.id],
    );
    expect(open).toHaveLength(1);
    await resumeWorker();
    await waitForStatus(open[0]?.["id"] as string, "applied");
  });

  it("[PBE-052 AC1] supersedes a submission that is verifying: its check's answer is never applied", async () => {
    const ota = await arrangeOta();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checking: (id: string) => void = () => undefined;
    const started = new Promise<string>((resolve) => {
      checking = resolve;
    });
    // The first check waits for the gate; the ones after it answer at once.
    let gated = false;
    verifier.onCheck = async (input) => {
      if (!gated) {
        gated = true;
        checking(input.submissionId);
        await gate;
      }
      return { outcome: "verified" };
    };
    const first = await submit(ota);
    const firstId = first.row.id;
    expect(await started).toBe(firstId);
    expect((await submissionRow(firstId))["status"]).toBe("verifying");

    const second = await submit(ota);
    expect(await submissionRow(firstId)).toMatchObject({
      status: "superseded",
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
    });
    release();

    expect(await waitForJob(firstId, "completed")).toMatchObject({
      returnvalue: { submissionId: firstId, status: "superseded" },
    });
    await waitForStatus(second.row.id, "applied");
    expect(verifier.applies.map((apply) => apply.submissionId)).toEqual([second.row.id]);
    expect(await markerOf(ota.tenant.id)).toBe(`applied ${second.row.id}`);
    expect((await auditOf(firstId)).map((row) => row["action"])).toEqual(["amadeus.credentials_submitted"]);
    expect((await emailsOf(ota.tenant.id)).map((row) => row["data"])).toHaveLength(1);
  });

  it("[PBE-052] refuses a call that can never give a submission, and rolls the caller's transaction back", async () => {
    const ota = await arrangeOta();
    const base: SubmitCredentialsInput = {
      tenantId: ota.tenant.id,
      kind: "amadeus",
      environment: "test",
      publicData: publicDataFor("amadeus"),
      secrets: { secret: newSecret("amadeus-secret-") },
      submittedBy: ota.owner.id,
    };
    const invalid: SubmitCredentialsInput[] = [
      { ...base, secrets: { secret: base.secrets.secret, webhookSecret: newSecret("whsec_") } },
      { ...base, kind: "stripe_api_keys", secrets: { secret: newSecret("sk_test_") } },
      { ...base, secrets: { secret: "" } },
      { ...base, publicData: { clientId: "acme", clientSecret: "not-here" } },
      { ...base, kind: "other" as CredentialKind },
    ];
    for (const input of invalid) {
      await expect(
        runInTransaction(platformDb, async (trx) => {
          await trx
            .updateTable("platform.tenants")
            .set({ name: "Changed in the same transaction" })
            .where("id", "=", ota.tenant.id)
            .execute();
          return submissions.submit(trx, input);
        }),
      ).rejects.toThrow(InvalidCredentialSubmissionError);
    }
    expect(
      await rowsOf("SELECT id FROM platform.credential_submissions WHERE tenant_id = $1", [ota.tenant.id]),
    ).toEqual([]);
    expect(
      (await rowsOf("SELECT name FROM platform.tenants WHERE id = $1", [ota.tenant.id]))[0]?.["name"],
    ).toBe(ota.tenant.name);
  });
});

describe("credentials.verify", () => {
  it("[PBE-052 AC2] applies verified credentials: both secret columns null, audited, the submitter e-mailed, no secret anywhere", async () => {
    const ota = await arrangeOta();

    const { input, row } = await submit(ota, "stripe_api_keys", "test");
    const applied = await waitForStatus(row.id, "applied");

    expect(applied).toMatchObject({
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
      error_code: null,
      error_message: null,
      attempts: 1,
    });
    expect(applied["finished_at"]).toEqual(t.clock.now());
    // The verifier got the decrypted secrets and the public fields; its apply ran in the job's transaction.
    expect(verifier.checks).toHaveLength(1);
    expect(verifier.checks[0]).toMatchObject({
      submissionId: row.id,
      tenantId: ota.tenant.id,
      kind: "stripe_api_keys",
      environment: "test",
      publicData: input.publicData,
      secrets: input.secrets,
      attempt: 1,
      lastAttempt: false,
    });
    expect(verifier.applies[0]).toMatchObject({
      submissionId: row.id,
      result: { accountId: "acct_testalpha" },
      submittedByAccountId: ota.owner.id,
    });
    expect(await markerOf(ota.tenant.id)).toBe(`applied ${row.id}`);
    const audit = (await auditOf(row.id)).find((entry) => entry["action"] === "payments.api_keys_applied");
    expect(audit).toMatchObject({
      actor_type: "system",
      actor_label: "credentials.verify",
      tenant_id: ota.tenant.id,
    });
    expect(audit?.["details"]).toMatchObject({
      kind: "stripe_api_keys",
      environment: "test",
      attempt: 1,
      verifiedAccount: "acct_testalpha",
      before: { connection: "velexis", status: "verifying" },
      after: { connection: "switched", status: "applied" },
    });
    expect(await emailsOf(ota.tenant.id)).toEqual([
      {
        template: "connection.credentials_applied",
        to_email: ota.owner.email,
        account_id: ota.owner.id,
        data: {
          fullName: ota.owner.full_name,
          tenantName: ota.tenant.name,
          tenantKey: ota.tenant.key,
          credentials: "Stripe API keys",
          environment: "test",
          connectionUrl: `${t.config.PUBLIC_PORTAL_URL.replace(/\/$/, "")}/otas/${ota.tenant.id}/payments`,
        },
      },
    ]);
    const message = await waitForMessage({ to: ota.owner.email, timeoutMs: MAIL_WAIT_MS });
    expect(message.Subject).toBe(`Stripe API keys verified for ${ota.tenant.name} (test)`);
    // The job's data, its result and the log lines name the submission, never a secret (checked after each test too).
    const job = await waitForJob(row.id, "completed");
    expect(job.data).toEqual({ submissionId: row.id });
    expect(job.returnvalue).toEqual({ submissionId: row.id, status: "applied" });
    await expectNoSecretAnywhere();
  });

  it("[PBE-052 AC2] fails a rejected submission with the verifier's code, erases both secrets and e-mails the reason", async () => {
    const ota = await arrangeOta();
    // A careless provider message quoting the key: the stored message never keeps it.
    verifier.onCheck = (input) =>
      Promise.resolve({
        outcome: "rejected",
        errorCode: "STRIPE_KEY_INVALID",
        errorMessage: `Stripe answered 401 (api_key_invalid) for ${input.secrets.secret}.`,
      });

    const { row } = await submit(ota, "stripe_api_keys", "live");
    const failed = await waitForStatus(row.id, "failed");

    expect(failed).toMatchObject({
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
      error_code: "STRIPE_KEY_INVALID",
      error_message: `Stripe answered 401 (api_key_invalid) for ${SECRET_PLACEHOLDER}.`,
      attempts: 1,
    });
    expect(verifier.applies).toEqual([]);
    expect(await markerOf(ota.tenant.id)).toBeNull();
    const audit = (await auditOf(row.id)).find((entry) => entry["action"] === "payments.api_keys_rejected");
    expect(audit?.["details"]).toMatchObject({
      kind: "stripe_api_keys",
      environment: "live",
      errorMessage: `Stripe answered 401 (api_key_invalid) for ${SECRET_PLACEHOLDER}.`,
      after: { status: "failed", errorCode: "STRIPE_KEY_INVALID" },
    });
    const [email] = await emailsOf(ota.tenant.id);
    expect(email).toMatchObject({ template: "connection.credentials_failed", to_email: ota.owner.email });
    expect(email?.["data"]).toMatchObject({ errorCode: "STRIPE_KEY_INVALID", environment: "live" });
    const message = await waitForMessage({ to: ota.owner.email, timeoutMs: MAIL_WAIT_MS });
    expect(message.Subject).toBe(`Stripe API keys not verified for ${ota.tenant.name} (live)`);
    expect(message.Text).toContain(
      `Stripe answered 401 (api_key_invalid) for ${SECRET_PLACEHOLDER}. (STRIPE_KEY_INVALID)`,
    );
    expect((await waitForJob(row.id, "completed")).returnvalue).toEqual({
      submissionId: row.id,
      status: "failed",
    });
  });

  it("[PBE-052 AC2] retries an unavailable provider with the submission verifying, then fails it with PROVIDER_UNAVAILABLE", async () => {
    const ota = await arrangeOta();
    verifier.onCheck = () =>
      Promise.resolve({ outcome: "unavailable", errorMessage: "Amadeus answered 503." });

    const { row } = await submit(ota, "amadeus", "test");
    // The first attempt fails the job: the submission stays verifying, with its secret and without an error.
    const job = await waitForJob(row.id, "delayed");
    expect(job.failedReason).toBe(
      `credentials.verify of ${row.id}: attempt 1 incomplete (provider_unavailable); retried`,
    );
    expect(await submissionRow(row.id)).toMatchObject({ status: "verifying", attempts: 1, error_code: null });
    expect((await submissionRow(row.id))["secret_ciphertext"]).not.toBeNull();

    const failed = await waitForStatus(row.id, "failed");

    expect(failed).toMatchObject({
      attempts: 5,
      error_code: PROVIDER_UNAVAILABLE,
      error_message: "Amadeus answered 503.",
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
    });
    expect(verifier.checks.map((check) => [check.attempt, check.lastAttempt])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ]);
    expect((await auditOf(row.id)).map((entry) => entry["action"])).toEqual([
      "amadeus.credentials_submitted",
      "amadeus.credentials_rejected",
    ]);
    expect((await emailsOf(ota.tenant.id)).map((email) => email["template"])).toEqual([
      "connection.credentials_failed",
    ]);
    // The last attempt ends the job failed, so the queue views show it.
    expect((await waitForJob(row.id, "failed")).failedReason).toBe(
      `credentials.verify of ${row.id}: the last attempt was incomplete (provider_unavailable)`,
    );
  });

  /**
   * An attempt that cannot complete for a reason of its own: retried like an unavailable provider, then the
   * submission fails with PROVIDER_UNAVAILABLE and the fixed message, both secrets erased, audited with the reason and
   * the submitter e-mailed; the job ends failed naming the reason.
   */
  async function expectIncompleteToFail(ota: Ota, submissionId: string, reason: string, action: string) {
    const failed = await waitForStatus(submissionId, "failed");
    expect(failed).toMatchObject({
      attempts: 5,
      error_code: PROVIDER_UNAVAILABLE,
      error_message: VERIFICATION_INCOMPLETE_MESSAGE,
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
    });
    expect(verifier.applies.map((apply) => apply.submissionId)).not.toContain(submissionId);
    expect(await markerOf(ota.tenant.id)).toBeNull();
    const audit = (await auditOf(submissionId)).find((entry) => entry["action"] === action);
    expect(audit?.["details"]).toMatchObject({
      reason,
      attempt: 5,
      after: { status: "failed", errorCode: PROVIDER_UNAVAILABLE },
    });
    expect((await emailsOf(ota.tenant.id)).map((email) => email["template"])).toEqual([
      "connection.credentials_failed",
    ]);
    expect((await waitForJob(submissionId, "failed")).failedReason).toBe(
      `credentials.verify of ${submissionId}: the last attempt was incomplete (${reason})`,
    );
  }

  it("[PBE-052 AC2] fails a submission whose kind has no verifier after its retries, its secrets erased", async () => {
    const ota = await arrangeOta();
    // A worker without the module of this kind has no verifier for it.
    vi.spyOn(verifiers, "get").mockReturnValue(undefined);

    const { row } = await submit(ota, "stripe_api_keys", "test");

    await expectIncompleteToFail(ota, row.id, "no_verifier", "payments.api_keys_rejected");
    expect(verifier.checks).toEqual([]);
  });

  it("[PBE-052 AC2] fails a submission whose secret does not decrypt after its retries, its secrets erased", async () => {
    const ota = await arrangeOta();
    const other = await arrangeOta();
    await pauseWorker();
    const { row } = await submit(ota, "amadeus", "test");
    const elsewhere = await submit(other, "amadeus", "test");
    // A ciphertext copied from another row is bound to that row and does not decrypt here (ADR-0010).
    await pool.query(
      `UPDATE platform.credential_submissions
          SET secret_ciphertext = (SELECT secret_ciphertext FROM platform.credential_submissions WHERE id = $2)
        WHERE id = $1`,
      [row.id, elsewhere.row.id],
    );

    await resumeWorker();

    await expectIncompleteToFail(ota, row.id, "undecryptable", "amadeus.credentials_rejected");
    expect(verifier.checks.map((check) => check.submissionId)).not.toContain(row.id);
    await waitForStatus(elsewhere.row.id, "applied");
  });

  it("[PBE-052 AC2] fails a submission whose verifier answers outside the contract after its retries, its secrets erased", async () => {
    const ota = await arrangeOta();
    // A rejection without a stable code: never stored, the attempt counts as incomplete.
    verifier.onCheck = (input) =>
      Promise.resolve({
        outcome: "rejected",
        errorCode: "not a code",
        errorMessage: `Rejected ${input.secrets.secret}`,
      });

    const { row } = await submit(ota, "amadeus", "live");

    await expectIncompleteToFail(ota, row.id, "invalid_result", "amadeus.credentials_rejected");
    expect(verifier.checks).toHaveLength(5);
  });

  it("[PBE-052] retries a crash while verifying or applying: the retry finds the submission verifying and applies it", async () => {
    const ota = await arrangeOta();
    let checks = 0;
    verifier.onCheck = (input) => {
      checks += 1;
      if (checks === 1) {
        // A verifier bug, with the secret in its message: it reaches neither a log line nor the job.
        throw new Error(`simulated crash with ${input.secrets.secret}`);
      }
      return Promise.resolve({ outcome: "verified" });
    };
    let applies = 0;
    verifier.onApply = async (trx, input) => {
      applies += 1;
      await writeMarker(trx, input);
      if (applies === 1) {
        throw new Error("simulated crash after the connection was written");
      }
      return undefined;
    };

    const { row } = await submit(ota, "amadeus", "live");

    expect((await waitForJob(row.id, "delayed")).failedReason).toBe(
      `credentials.verify of ${row.id}: attempt 1 incomplete (verifier_error); retried`,
    );
    expect(await submissionRow(row.id)).toMatchObject({ status: "verifying", attempts: 1 });
    const applied = await waitForStatus(row.id, "applied");
    expect(applied).toMatchObject({ attempts: 3, secret_ciphertext: null, webhook_secret_ciphertext: null });
    expect(checks).toBe(3);
    // The apply that crashed rolled back with its transaction; the next one committed with the submission.
    expect(await markerOf(ota.tenant.id)).toBe(`applied ${row.id}`);
    expect((await auditOf(row.id)).map((entry) => entry["action"])).toEqual([
      "amadeus.credentials_submitted",
      "amadeus.credentials_applied",
    ]);
    const logs = [...t.logs.lines, ...workerLogs.lines];
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "credentials.verifier_failed",
        submissionId: row.id,
        errorText: `simulated crash with ${SECRET_PLACEHOLDER}`,
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: "credentials.apply_failed", submissionId: row.id, attempt: 2 }),
    );
  });

  it("[PBE-052] finds a submission a crash left verifying, and completes it", async () => {
    const ota = await arrangeOta();
    await pauseWorker();
    const { row } = await submit(ota, "amadeus", "test");
    // What a worker that died after its first step leaves behind.
    await pool.query(
      "UPDATE platform.credential_submissions SET status = 'verifying', attempts = 1 WHERE id = $1",
      [row.id],
    );

    await resumeWorker();

    expect(await waitForStatus(row.id, "applied")).toMatchObject({ attempts: 2, secret_ciphertext: null });
  });

  it("[PBE-052] fails the submission when apply rejects it, with the apply's writes rolled back", async () => {
    const ota = await arrangeOta();
    verifier.onApply = async (trx, input) => {
      await writeMarker(trx, input);
      throw new CredentialRejection(
        "STRIPE_LIVEMODE_MISMATCH",
        "Stripe answered livemode false for a live key.",
      );
    };

    const { row } = await submit(ota, "stripe_api_keys", "live");

    expect(await waitForStatus(row.id, "failed")).toMatchObject({
      error_code: "STRIPE_LIVEMODE_MISMATCH",
      error_message: "Stripe answered livemode false for a live key.",
      secret_ciphertext: null,
      webhook_secret_ciphertext: null,
      attempts: 1,
    });
    expect(await markerOf(ota.tenant.id)).toBeNull();
    expect((await auditOf(row.id)).map((entry) => entry["action"])).toEqual([
      "payments.api_keys_submitted",
      "payments.api_keys_rejected",
    ]);
  });

  it("[PBE-052] e-mails nobody when the submitter left the OTA before the verification ended", async () => {
    const ota = await arrangeOta();
    const leaver = await insertAccount(pool, {
      id: testId("acc", next++),
      email: uniqueEmail("leaver-pbe052"),
    });
    await insertMembership(pool, ota.tenant, leaver, { role: "admin", status: "removed" });
    await pauseWorker();

    const { row } = await submit(ota, "amadeus", "test", leaver.id);
    await resumeWorker();

    await waitForStatus(row.id, "applied");
    expect(await emailsOf(ota.tenant.id)).toEqual([]);
  });
});

describe("GET /v1/tenants/{tenantId}/credential-submissions/{submissionId} (getCredentialSubmission)", () => {
  it("[PBE-052] answers owners and admins the status and error, never a secret; other roles 403, others 404", async () => {
    const ota = await arrangeOta();
    const other = await arrangeOta();
    verifier.onCheck = () =>
      Promise.resolve({
        outcome: "rejected",
        errorCode: "STRIPE_KEY_INVALID",
        errorMessage: "Stripe answered 401.",
      });
    const { row } = await submit(ota, "stripe_api_keys", "test");
    await waitForStatus(row.id, "failed");
    const path = `/v1/tenants/${ota.tenant.id}/credential-submissions/${row.id}`;

    for (const accountId of [ota.owner.id, ota.admin.id]) {
      const res = await t.http.get(path).set(await as(accountId));
      expect(res.status).toBe(200);
      expectResponseToMatch("getCredentialSubmission", res, { document: "platform" });
      expect(res.body).toEqual({
        id: row.id,
        kind: "stripe_api_keys",
        environment: "test",
        status: "failed",
        errorCode: "STRIPE_KEY_INVALID",
        errorMessage: "Stripe answered 401.",
        createdAt: t.clock.now().toISOString(),
        finishedAt: t.clock.now().toISOString(),
      });
    }

    // The roles the matrix leaves out of connection changes.
    for (const role of TENANT_ROLES.filter((r): r is TenantRole => r !== "owner" && r !== "admin")) {
      const member = await insertAccount(pool, { id: testId("acc", next++) });
      await insertMember(pool, ota.tenant, member, role);
      const res = await t.http.get(path).set(await as(member.id));
      expect(res.status, role).toBe(403);
      expect(errorOf(res)).toBe("FORBIDDEN");
    }
    // The owner of another OTA, and a submission of another OTA under the caller's own OTA: 404.
    const stranger = await t.http.get(path).set(await as(other.owner.id));
    expect(stranger.status).toBe(404);
    const crossed = await t.http
      .get(`/v1/tenants/${other.tenant.id}/credential-submissions/${row.id}`)
      .set(await as(other.owner.id));
    expect(crossed.status).toBe(404);
    expect(errorOf(crossed)).toBe("NOT_FOUND");
    const malformed = await t.http
      .get(`/v1/tenants/${ota.tenant.id}/credential-submissions/sub_123`)
      .set(await as(ota.owner.id));
    expect(malformed.status).toBe(400);
    expect(errorOf(malformed)).toBe("VALIDATION_FAILED");
  });

  it("[PBE-052] answers a pending submission without its public fields or ciphertexts", async () => {
    const ota = await arrangeOta();
    await pauseWorker();
    const { row } = await submit(ota, "amadeus", "live");

    const res = await t.http
      .get(`/v1/tenants/${ota.tenant.id}/credential-submissions/${row.id}`)
      .set(await as(ota.owner.id));

    expect(res.status).toBe(200);
    expectResponseToMatch("getCredentialSubmission", res, { document: "platform" });
    expect(res.body).toMatchObject({
      status: "pending",
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ciphertext|clientId|officeIds|acme-amadeus-client/i);
    await resumeWorker();
    await waitForStatus(row.id, "applied");
  });
});
