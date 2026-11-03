// `purge.daily` (PBE-034; platform/docs/architecture.md §5): the worker's module graph (WorkerModule, as dist/worker.js
// builds it, with the FakeClock of the API) on this file's database clone and Redis database deletes the rows past
// their retention, in batches of 1 000, and nothing else: used or expired `account_tokens` 7 days on, `account_sessions`
// 30 days after their expiry, `sent` outbox rows 30 days after sending, `processed` Stripe events and final credential
// submissions 90 days on. A final row is judged by its own time (`sent_at`, `processed_at`, `finished_at`), and by
// `updated_at` only without it; a rotation family goes generation by generation. `platform_audit_log` is never
// touched. Rows are written with times relative to the FakeClock, which the tests move instead of waiting.
//
// Failed custom domains (FIX-W39-PLATFORM, lead decision (2g) of 2026-11-02; PADR-0004 item 4) go 7 days after their
// failure (the check that failed them, else `updated_at`), each with one `domain.removed` audit row and a `domain`
// invalidation (read here on `vx:invalidate`); the sub-domain, pending and verified domains and younger failures stay.
//
// The job runs through the `platform-maintenance` queue and its one processor, as the job scheduler would start it, or
// by calling the handler. The worker's job schedulers are not registered here (JobSchedulerRegistry is replaced), so
// no run starts on its own during a test.
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import type { Job, Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { PurgeRepository, type PurgeTable } from "../../../src/common/purge.repository";
import {
  FAILED_DOMAIN_PURGE_REASON,
  PURGE_BATCH_SIZE,
  PURGE_DAILY_JOB,
  PURGE_MAX_BATCHES,
  PurgeScheduler,
  type PurgeDailyResult,
} from "../../../src/common/purge.scheduler";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertRow,
  insertTenantDomain,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  testId,
} from "../../builders/platform-rows";
import { insertOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/** Starting the API and the worker's module graph takes seconds; the bound allows for a loaded 4-CPU CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's setup: a few hundred inserts and a purge run (thousands of rows for the batches); seconds at most. */
const GROUP_SETUP_TIMEOUT_MS = 90_000;
/** How long a test waits for the worker to finish a job. */
const WAIT_MS = 20_000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let purge: PurgeScheduler;
let repository: PurgeRepository;
let maintenance: Queue;
let accountId: string;
let tenantIds: string[];
const workerLogs = new LogSink();
let nextId = 1;

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .compile();
  await worker.init();
  purge = worker.get(PurgeScheduler, { strict: false });
  repository = worker.get(PurgeRepository, { strict: false });
  maintenance = worker.get<Queue>(getQueueToken(PLATFORM_QUEUE.maintenance), { strict: false });
  accountId = (await insertAccount(pool)).id;
  // Credential submissions belong to an OTA; one open submission per OTA, kind and environment is allowed.
  tenantIds = [];
  for (let n = 0; n < 3; n += 1) {
    tenantIds.push((await insertOta(pool)).tenant.id);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

/** The instant `days` days (and `ms` more milliseconds) before the FakeClock's now. */
function ago(days: number, ms = 0): Date {
  return new Date(t.clock.now().getTime() - days * DAY_MS - ms);
}

const n = (): number => nextId++;

/** An `account_tokens` row: issued `days` ago (24 hours of life unless `expiresAt`), used at `consumedAt`. */
async function token(expiresAt: Date, consumedAt: Date | null): Promise<string> {
  const i = n();
  const row = await insertRow(pool, "account_tokens", {
    id: testId("atk", i),
    account_id: accountId,
    purpose: "password_reset",
    token_hash: i.toString(16).padStart(64, "0"),
    email: "person@example.com",
    expires_at: expiresAt,
    consumed_at: consumedAt,
    created_at: new Date(expiresAt.getTime() - DAY_MS),
    updated_at: consumedAt ?? expiresAt,
  });
  return row.id;
}

/** An `account_sessions` row of its own family that expired (or expires) at `expiresAt`. */
async function session(expiresAt: Date, revokedAt: Date | null = null): Promise<string> {
  const i = n();
  const id = testId("asn", i);
  await insertRow(pool, "account_sessions", {
    id,
    account_id: accountId,
    refresh_token_hash: i.toString(16).padStart(64, "a"),
    family_id: id,
    expires_at: expiresAt,
    family_expires_at: expiresAt,
    revoked_at: revokedAt,
    revoke_reason: revokedAt === null ? null : "logout",
    created_at: new Date(expiresAt.getTime() - 7 * DAY_MS),
    updated_at: revokedAt ?? expiresAt,
  });
  return id;
}

/**
 * A rotation family: one `account_sessions` row per generation, expiring at `expiries` (oldest generation first), each
 * row's `replaced_by_id` naming the next one and `family_id` the first one. Returns the ids, oldest first.
 */
async function rotatedFamily(expiries: readonly Date[]): Promise<string[]> {
  const ids = expiries.map(() => testId("asn", n()));
  const familyId = ids[0] ?? "";
  const familyExpiresAt = new Date(Math.max(...expiries.map((expiry) => expiry.getTime())));
  // The newest generation first, so each `replaced_by_id` names a row that exists.
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const id = ids[index] ?? "";
    const expiresAt = expiries[index] ?? familyExpiresAt;
    const replacedBy = ids[index + 1] ?? null;
    await insertRow(pool, "account_sessions", {
      id,
      account_id: accountId,
      refresh_token_hash: id.slice(4).toLowerCase().padStart(64, "b"),
      family_id: familyId,
      replaced_by_id: replacedBy,
      expires_at: expiresAt,
      family_expires_at: familyExpiresAt,
      rotated_at: replacedBy === null ? null : new Date(expiresAt.getTime() - DAY_MS),
      created_at: new Date(expiresAt.getTime() - 2 * DAY_MS),
      updated_at: expiresAt,
    });
  }
  return ids;
}

/**
 * The time columns of a final row, for the tests of which time counts: `ownAt` replaces the row's own time (`sent_at`,
 * `processed_at` or `finished_at`; `null` leaves it empty) and `updatedAt` its `updated_at`. Both default to `at`.
 */
interface RowTimes {
  readonly ownAt?: Date | null;
  readonly updatedAt?: Date;
}

/** An `email_outbox` row in `status`, created and last changed at `at` (sent then, for `sent`). */
async function email(
  status: "pending" | "sending" | "sent" | "failed" | "canceled",
  at: Date,
  times: RowTimes = {},
): Promise<string> {
  const row = await insertRow(pool, "email_outbox", {
    id: testId("eml", n()),
    template: "auth.password_changed",
    to_email: "person@example.com",
    account_id: accountId,
    data: { fullName: "Person" },
    status,
    attempts: status === "pending" ? 0 : 1,
    sent_at: status === "sent" ? (times.ownAt === undefined ? at : times.ownAt) : null,
    secrets_purged_at: status === "pending" || status === "sending" ? null : at,
    created_at: new Date(at.getTime() - MINUTE_MS),
    updated_at: times.updatedAt ?? at,
  });
  return row.id;
}

/** A `stripe_events` row in `status`, received and last changed at `at` (processed then, for `processed`). */
async function stripeEvent(
  status: "received" | "processing" | "processed" | "ignored" | "failed",
  at: Date,
  times: RowTimes = {},
): Promise<string> {
  const i = n();
  const row = await insertRow(pool, "stripe_events", {
    id: `evt_test${String(i).padStart(10, "0")}`,
    endpoint: "billing",
    type: "invoice.paid",
    livemode: false,
    stripe_created_at: new Date(at.getTime() - MINUTE_MS),
    status,
    attempts: status === "received" ? 0 : 1,
    received_at: new Date(at.getTime() - MINUTE_MS),
    processed_at: status === "processed" ? (times.ownAt === undefined ? at : times.ownAt) : null,
    updated_at: times.updatedAt ?? at,
  });
  return row.id;
}

/** A `credential_submissions` row of `tenantId` in `status`, finished (or last changed) at `at`. */
async function submission(
  tenantId: string,
  status: "pending" | "verifying" | "applied" | "failed" | "superseded",
  at: Date,
  times: RowTimes = {},
): Promise<string> {
  const open = status === "pending" || status === "verifying";
  const row = await insertRow(pool, "credential_submissions", {
    id: testId("crs", n()),
    tenant_id: tenantId,
    kind: "amadeus",
    environment: "test",
    public_data: { clientId: "client-id" },
    secret_ciphertext: open ? Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8") : null,
    encryption_key_id: PLACEHOLDER_KEK_ID,
    status,
    attempts: open ? 0 : 1,
    submitted_by_account_id: accountId,
    finished_at: open ? null : times.ownAt === undefined ? at : times.ownAt,
    created_at: new Date(at.getTime() - MINUTE_MS),
    updated_at: times.updatedAt ?? at,
  });
  return row.id;
}

/** An audit row written `days` ago, as any state change writes one. */
async function auditRow(days: number): Promise<string> {
  const row = await insertRow(pool, "platform_audit_log", {
    actor_type: "system",
    actor_label: "purge test",
    action: "account.updated",
    target_type: "account",
    target_id: accountId,
    details: {},
    created_at: ago(days),
  });
  return String(row.id);
}

const TABLE_OF: Readonly<Record<PurgeTable, string>> = {
  account_tokens: "platform.account_tokens",
  account_sessions: "platform.account_sessions",
  email_outbox: "platform.email_outbox",
  stripe_events: "platform.stripe_events",
  credential_submissions: "platform.credential_submissions",
};

/** Which of `ids` are still rows of `table`. */
async function remaining(table: PurgeTable, ids: readonly string[]): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM ${TABLE_OF[table]} WHERE id = ANY($1::text[]) ORDER BY id`,
    [[...ids]],
  );
  return rows.map((row) => row.id);
}

/** Every audit row's id and time, oldest first. */
async function auditLog(): Promise<Array<{ id: string; created_at: Date }>> {
  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    "SELECT id::text AS id, created_at FROM platform.platform_audit_log ORDER BY id",
  );
  return rows;
}

/** Runs `purge.daily` as the job scheduler starts it: a job named after the schedule on `platform-maintenance`. */
async function runScheduledJob(): Promise<Job> {
  const job = await maintenance.add(PURGE_DAILY_JOB, {});
  const deadline = Date.now() + WAIT_MS;
  while ((await job.getState()) !== "completed") {
    expect(Date.now(), "the purge job to complete").toBeLessThan(deadline);
    expect(await job.getState(), "the purge job not to fail").not.toBe("failed");
    await new Promise((done) => setTimeout(done, 50));
  }
  return (await maintenance.getJob(job.id ?? "")) ?? job;
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

describe("purge.daily", () => {
  /** The rows past their retention, which the run deletes, and the rows it keeps, per table. */
  const due: Record<PurgeTable, string[]> = {
    account_tokens: [],
    account_sessions: [],
    email_outbox: [],
    stripe_events: [],
    credential_submissions: [],
  };
  const kept: Record<PurgeTable, string[]> = {
    account_tokens: [],
    account_sessions: [],
    email_outbox: [],
    stripe_events: [],
    credential_submissions: [],
  };
  let auditBefore: Array<{ id: string; created_at: Date }>;
  let oldAuditIds: string[];
  let job: Job;
  let logLines: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // account_tokens: 7 days after the use or the expiry.
    due.account_tokens.push(
      await token(ago(8), ago(8, MINUTE_MS)), // used 8 days ago
      await token(ago(7, MINUTE_MS), null), // expired unused, 7 days and a minute ago
      await token(ago(5), ago(9)), // used 9 days ago (its expiry is later)
    );
    kept.account_tokens.push(
      await token(ago(6, -DAY_MS), ago(6)), // used 6 days ago
      await token(ago(6), null), // expired unused 6 days ago
      await token(ago(-1), null), // still valid
    );
    // account_sessions: 30 days after the expiry, revoked or not.
    due.account_sessions.push(await session(ago(31)), await session(ago(30, MINUTE_MS), ago(35)));
    kept.account_sessions.push(
      await session(ago(29)),
      await session(ago(-5)),
      await session(ago(29), ago(40)),
    );
    // Rotation families (`replaced_by_id` chains): a family whose every generation is past its retention goes in one
    // statement; of a family with a generation still inside it, only the older generations go.
    due.account_sessions.push(...(await rotatedFamily([ago(40), ago(35), ago(31)])));
    const [oldGeneration = "", newGeneration = ""] = await rotatedFamily([ago(31), ago(29)]);
    due.account_sessions.push(oldGeneration);
    kept.account_sessions.push(newGeneration);
    // email_outbox: sent ones, 30 days after sending; no other status. The sending time counts, not a later
    // `updated_at`; `updated_at` stands in only for a row without `sent_at`.
    due.email_outbox.push(
      await email("sent", ago(31)),
      await email("sent", ago(30, MINUTE_MS)),
      await email("sent", ago(31), { updatedAt: ago(1) }),
      await email("sent", ago(31), { ownAt: null }),
    );
    kept.email_outbox.push(
      await email("sent", ago(29)),
      await email("sent", ago(29), { updatedAt: ago(31) }),
      await email("sent", ago(29), { ownAt: null }),
      await email("failed", ago(120)),
      await email("canceled", ago(120)),
      await email("pending", ago(120)),
      await email("sending", ago(120)),
    );
    // stripe_events: processed ones, 90 days after processing; no other status. The processing time counts, as above.
    due.stripe_events.push(
      await stripeEvent("processed", ago(91)),
      await stripeEvent("processed", ago(91), { updatedAt: ago(1) }),
      await stripeEvent("processed", ago(91), { ownAt: null }),
    );
    kept.stripe_events.push(
      await stripeEvent("processed", ago(89)),
      await stripeEvent("processed", ago(89), { updatedAt: ago(91) }),
      await stripeEvent("processed", ago(89), { ownAt: null }),
      await stripeEvent("ignored", ago(200)),
      await stripeEvent("failed", ago(200)),
      await stripeEvent("received", ago(200)),
      await stripeEvent("processing", ago(200)),
    );
    // credential_submissions: final ones, 90 days after finishing; open ones stay. The finishing time counts, as
    // above.
    const [first = "", second = "", third = ""] = tenantIds;
    due.credential_submissions.push(
      await submission(first, "applied", ago(91)),
      await submission(first, "failed", ago(120)),
      await submission(first, "superseded", ago(90, MINUTE_MS)),
      await submission(first, "failed", ago(91), { updatedAt: ago(1) }),
      await submission(first, "applied", ago(91), { ownAt: null }),
    );
    kept.credential_submissions.push(
      await submission(second, "applied", ago(89)),
      await submission(second, "failed", ago(89), { updatedAt: ago(91) }),
      await submission(second, "superseded", ago(89), { ownAt: null }),
      await submission(second, "pending", ago(200)),
      await submission(third, "verifying", ago(200)),
    );
    // platform_audit_log: rows far older than any retention.
    oldAuditIds = [await auditRow(400), await auditRow(120), await auditRow(31)];
    auditBefore = await auditLog();

    job = await runScheduledJob();
    logLines = [...t.logs.lines, ...workerLogs.lines].filter((line) => line["msg"] === PURGE_DAILY_JOB);
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-034 AC1] removes only the rows past their retention, in every table", async () => {
    for (const table of Object.keys(due) as PurgeTable[]) {
      expect(await remaining(table, [...due[table], ...kept[table]]), table).toEqual(sorted(kept[table]));
    }
    const result = job.returnvalue as PurgeDailyResult;
    expect(result.deleted).toEqual({
      account_tokens: due.account_tokens.length,
      account_sessions: due.account_sessions.length,
      email_outbox: due.email_outbox.length,
      stripe_events: due.stripe_events.length,
      credential_submissions: due.credential_submissions.length,
      // No failed custom domain in this group: its own group follows (FIX-W39-PLATFORM).
      tenant_domains: 0,
    });
  });

  it("[PBE-034 AC1] never touches platform_audit_log, and writes no audit row of its own", async () => {
    expect(await auditLog()).toEqual(auditBefore);
    expect(auditBefore.map((row) => row.id)).toEqual(expect.arrayContaining(oldAuditIds));
  });

  it("[PBE-034] logs the count of every table, and no row's content", () => {
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toMatchObject({
      level: 30,
      account_tokens: 3,
      account_sessions: 6,
      email_outbox: 4,
      stripe_events: 3,
      credential_submissions: 5,
    });
    expect(JSON.stringify(logLines)).not.toContain("person@example.com");
  });
});

describe("purge.daily with the FakeClock moving on", () => {
  const ids: Record<PurgeTable, string[]> = {
    account_tokens: [],
    account_sessions: [],
    email_outbox: [],
    stripe_events: [],
    credential_submissions: [],
  };
  let beforeRetention: Record<PurgeTable, string[]>;
  let afterRetention: Record<PurgeTable, string[]>;

  beforeAll(async () => {
    // Each row is two hours short of its retention.
    const short = -2 * 60 * MINUTE_MS;
    ids.account_tokens.push(await token(ago(7, short), null), await token(ago(6), ago(7, short)));
    ids.account_sessions.push(await session(ago(30, short)));
    ids.email_outbox.push(await email("sent", ago(30, short)));
    ids.stripe_events.push(await stripeEvent("processed", ago(90, short)));
    ids.credential_submissions.push(await submission(tenantIds[0] ?? "", "failed", ago(90, short)));

    const snapshot = async () => {
      const result = {} as Record<PurgeTable, string[]>;
      for (const table of Object.keys(ids) as PurgeTable[]) {
        result[table] = await remaining(table, ids[table]);
      }
      return result;
    };
    await purge.run();
    beforeRetention = await snapshot();
    t.clock.advance(3 * 60 * MINUTE_MS);
    await purge.run();
    afterRetention = await snapshot();
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-034 AC1] keeps a row until its retention has passed by the Clock, then removes it", () => {
    for (const table of Object.keys(ids) as PurgeTable[]) {
      expect(beforeRetention[table], table).toEqual(sorted(ids[table]));
      expect(afterRetention[table], table).toEqual([]);
    }
  });
});

describe("purge.daily batches", () => {
  const COUNT = 2 * PURGE_BATCH_SIZE + 345;
  let deletedTokens: number;
  let batches: number[];
  let left: number;

  beforeAll(async () => {
    // Expired, unused tokens of 10 days ago, written in one statement.
    await pool.query(
      "INSERT INTO platform.account_tokens (id, account_id, purpose, token_hash, email, expires_at, created_at, " +
        "updated_at) SELECT 'atk_batch' || lpad(i::text, 6, '0'), $1, 'email_verification', " +
        "md5('batch' || i::text) || md5('token' || i::text), 'person@example.com', $2, $3, $2 " +
        "FROM generate_series(1, $4::int) AS i",
      [accountId, ago(10), ago(11), COUNT],
    );
    const spy = vi.spyOn(repository, "deleteBatch");
    const result = await purge.run();
    deletedTokens = result.deleted.account_tokens;
    batches = await Promise.all(
      spy.mock.calls
        .map((call, index) => ({ table: call[0], result: spy.mock.results[index]?.value as Promise<number> }))
        .filter((call) => call.table === "account_tokens")
        .map((call) => call.result),
    );
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM platform.account_tokens WHERE id LIKE 'atk\\_batch%'",
    );
    left = rows[0]?.n ?? -1;
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-034] deletes in batches of 1 000 rows until a batch deletes fewer", () => {
    expect(left).toBe(0);
    expect(deletedTokens).toBe(COUNT);
    expect(batches).toEqual([PURGE_BATCH_SIZE, PURGE_BATCH_SIZE, COUNT - 2 * PURGE_BATCH_SIZE]);
  });
});

describe("purge.daily with a backlog beyond one run", () => {
  let tokenBatches: number;
  let result: PurgeDailyResult;
  let capped: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // Every batch of account_tokens reports a full batch (a backlog of more than a million rows, without writing
    // them); the other tables are purged for real.
    const deleteBatch = repository.deleteBatch.bind(repository);
    const spy = vi
      .spyOn(repository, "deleteBatch")
      .mockImplementation((table, cutoff, limit) =>
        table === "account_tokens" ? Promise.resolve(limit) : deleteBatch(table, cutoff, limit),
      );
    result = await purge.run();
    tokenBatches = spy.mock.calls.filter((call) => call[0] === "account_tokens").length;
    spy.mockRestore();
    // nestjs-pino's PinoLogger writes to the process's root logger, which may be the API's (t.logs) or the worker's.
    capped = [...t.logs.lines, ...workerLogs.lines].filter((line) => line["msg"] === "purge.capped");
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-034] stops a table after PURGE_MAX_BATCHES batches in one run, and logs purge.capped", () => {
    expect(tokenBatches).toBe(PURGE_MAX_BATCHES);
    expect(result.deleted.account_tokens).toBe(PURGE_MAX_BATCHES * PURGE_BATCH_SIZE);
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({
      level: 40,
      table: "account_tokens",
      deleted: PURGE_MAX_BATCHES * PURGE_BATCH_SIZE,
      batches: PURGE_MAX_BATCHES,
    });
  });
});

describe("purge.daily: failed custom domains (FIX-W39-PLATFORM, lead decision (2g) of 2026-11-02)", () => {
  /** A verification value of the shape addDomain gives: it never reaches an audit row. */
  const TOKEN = "vx-verify-K7Q4M2XP9TRWH5ZDB3NV8QKE1MZT6RYC";
  const due: string[] = [];
  const kept: string[] = [];
  const hosts = new Map<string, string>();
  let primaryTenant = "";
  let primaryDomain = "";
  let subdomainHost = "";
  let failedSubdomain = "";
  let result: PurgeDailyResult;
  let events: InvalidationEvent[] = [];
  let auditBefore: string[];

  /** A custom domain of `tenantId` in `status`, last checked at `lastCheckedAt`, changed at `updatedAt`. */
  async function domain(
    tenantId: string,
    status: "pending" | "verified" | "failed",
    lastCheckedAt: Date | null,
    options: { updatedAt?: Date; primary?: boolean } = {},
  ): Promise<string> {
    const hostname = `purge-${randomBytes(5).toString("hex")}.example.net`;
    const row = await insertTenantDomain(
      pool,
      { id: tenantId },
      {
        id: testId("dom", n()),
        hostname,
        kind: "custom",
        is_primary: options.primary ?? false,
        verification_status: status,
        verification_token: TOKEN,
        verification_deadline_at: ago(20),
        verified_at: status === "verified" ? ago(30) : null,
        last_checked_at: lastCheckedAt,
        last_check_error: status === "failed" ? "txt_missing" : null,
        created_at: ago(30),
        updated_at: options.updatedAt ?? lastCheckedAt ?? ago(30),
      },
    );
    hosts.set(row.id, hostname);
    return row.id;
  }

  beforeAll(async () => {
    const [first = "", second = ""] = tenantIds;
    due.push(
      await domain(first, "failed", ago(8)), // failed 8 days ago
      await domain(first, "failed", ago(7, MINUTE_MS)), // 7 days and a minute ago
      await domain(first, "failed", null, { updatedAt: ago(8) }), // no check: updated_at stands in
      await domain(first, "failed", ago(9), { updatedAt: ago(1) }), // the failing check counts, not a later write
    );
    kept.push(
      await domain(second, "failed", ago(6)), // failed 6 days ago
      await domain(second, "failed", ago(7, -MINUTE_MS)), // a minute short of 7 days
      await domain(second, "failed", null, { updatedAt: ago(6) }),
      await domain(second, "pending", ago(30)), // pending, however old
      await domain(second, "verified", ago(30)), // verified, however old
    );
    // A failed primary custom domain: the sub-domain becomes primary again, as removeDomain makes it.
    const ota = await insertOta(pool);
    primaryTenant = ota.tenant.id;
    subdomainHost = ota.domain.hostname;
    await pool.query("UPDATE platform.tenant_domains SET is_primary = false WHERE id = $1", [ota.domain.id]);
    primaryDomain = await domain(primaryTenant, "failed", ago(10), { primary: true });
    due.push(primaryDomain);
    // The sub-domain is never deleted, whatever its row says.
    const other = await insertOta(pool);
    failedSubdomain = other.domain.id;
    await pool.query(
      "UPDATE platform.tenant_domains SET verification_status = 'failed', last_checked_at = $2, updated_at = $2 " +
        "WHERE id = $1",
      [failedSubdomain, ago(30)],
    );
    kept.push(failedSubdomain);

    const watched = new Set([...hosts.values(), subdomainHost, other.domain.hostname]);
    const subscriber = new Redis(t.redis.url, { lazyConnect: true });
    subscriber.on("message", (_channel: string, message: string) => {
      const event = JSON.parse(message) as InvalidationEvent;
      if (event.type === "domain" && watched.has(event.hostname)) {
        events.push(event);
      }
    });
    await subscriber.connect();
    await subscriber.subscribe(INVALIDATION_CHANNEL);
    try {
      auditBefore = (await auditLog()).map((row) => row.id);
      events = [];
      result = (await runScheduledJob()).returnvalue as PurgeDailyResult;
      // The invalidations go out after each commit, before the job completes; pub/sub takes milliseconds.
      await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(due.length + 1), {
        timeout: 3_000,
        interval: 20,
      });
      await delay(50);
    } finally {
      await subscriber.quit();
    }
  }, GROUP_SETUP_TIMEOUT_MS);

  /** Which of `ids` are still domain rows. */
  async function remainingDomains(ids: readonly string[]): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM platform.tenant_domains WHERE id = ANY($1::text[]) ORDER BY id",
      [[...ids]],
    );
    return rows.map((row) => row.id);
  }

  it("[FIX-W39-PLATFORM AC3] deletes the custom domains failed more than 7 days ago, and keeps younger failures, pending and verified domains and every sub-domain", async () => {
    expect(await remainingDomains([...due, ...kept])).toEqual(sorted(kept));
    expect(result.deleted.tenant_domains).toBe(due.length);
    // The flag of the deleted primary domain went back to the sub-domain: exactly one primary.
    const { rows } = await pool.query<{ hostname: string }>(
      "SELECT hostname FROM platform.tenant_domains WHERE tenant_id = $1 AND is_primary",
      [primaryTenant],
    );
    expect(rows.map((row) => row.hostname)).toEqual([subdomainHost]);
  });

  it("[FIX-W39-PLATFORM AC3] writes one domain.removed audit row per deleted domain, without the verification value", async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT id::text AS id, actor_type, actor_label, action, target_type, target_id, tenant_id, details " +
        "FROM platform.platform_audit_log WHERE NOT (id::text = ANY($1::text[])) ORDER BY id",
      [auditBefore],
    );
    expect(rows.map((row) => row["target_id"]).sort()).toEqual(sorted(due));
    for (const row of rows) {
      const id = String(row["target_id"]);
      expect(row).toMatchObject({
        actor_type: "system",
        actor_label: PURGE_DAILY_JOB,
        action: "domain.removed",
        target_type: "domain",
      });
      expect(row["details"]).toMatchObject({
        reason: FAILED_DOMAIN_PURGE_REASON,
        before: {
          hostname: hosts.get(id),
          verificationStatus: "failed",
          isPrimary: id === primaryDomain,
          lastCheckError: "txt_missing",
        },
      });
    }
    expect(rows.find((row) => row["target_id"] === primaryDomain)?.["details"]).toMatchObject({
      primaryHostname: subdomainHost,
    });
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("[FIX-W39-PLATFORM AC3] publishes a domain invalidation for each deleted host after its commit, and for the sub-domain that is primary again", () => {
    const hostnames = events.map((event) => (event.type === "domain" ? event.hostname : ""));
    expect(sorted(hostnames)).toEqual(sorted([...due.map((id) => hosts.get(id) ?? ""), subdomainHost]));
  });

  it("[FIX-W39-PLATFORM AC3] frees the host name: another OTA may add it again", async () => {
    const freed = hosts.get(due[0] ?? "") ?? "";
    const row = await insertTenantDomain(
      pool,
      { id: tenantIds[2] ?? "" },
      {
        id: testId("dom", n()),
        hostname: freed,
        kind: "custom",
        verification_status: "pending",
        verification_token: TOKEN,
      },
    );
    expect(row.hostname).toBe(freed);
  });

  it("[FIX-W39-PLATFORM AC3] keeps a candidate whose window checkDomain restarted between the read and its lock", async () => {
    const [, second = ""] = tenantIds;
    const restarted = await domain(second, "failed", ago(10));
    const auditIds = (await auditLog()).map((row) => row.id);
    // The read saw it failed; `checkDomain` then made it `pending` with a new window (domains.repository.ts), before
    // the purge took the tenant's domain lock and the row.
    const read = vi
      .spyOn(repository, "failedCustomDomains")
      .mockResolvedValueOnce([{ id: restarted, tenant_id: second }]);
    await pool.query(
      "UPDATE platform.tenant_domains SET verification_status = 'pending', verification_deadline_at = $2, " +
        "updated_at = $3 WHERE id = $1",
      [restarted, new Date(t.clock.now().getTime() + 3 * DAY_MS), t.clock.now()],
    );

    try {
      const outcome = await purge.run();

      expect(outcome.deleted.tenant_domains).toBe(0);
    } finally {
      read.mockRestore();
    }
    const { rows } = await pool.query<{ verification_status: string }>(
      "SELECT verification_status FROM platform.tenant_domains WHERE id = $1",
      [restarted],
    );
    expect(rows).toEqual([{ verification_status: "pending" }]);
    expect((await auditLog()).filter((row) => !auditIds.includes(row.id))).toEqual([]);
  });
});
