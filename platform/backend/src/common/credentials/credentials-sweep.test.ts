// The sweep of lost `credentials.verify` jobs (FIX-W38-PLATFORM, lead decision (2f) of 2026-10-31; credentials-sweep.ts)
// over stand-ins of the repository, the queue, the logger and the database: which submissions it picks by the Clock,
// when it queues a job again (none that will still run, a finished one replaced, the submission id as the job id),
// that it fails a submission left verifying through `failStuck` and counts only what was written, the status guard of
// `failStuck` (still verifying and unchanged since the cut-off), what it writes then, the job scheduler it registers,
// and that its log lines carry ids and counts only. The writes against PostgreSQL and Redis run in
// test/integration/connections/credential-submissions.int.test.ts.
import { FakeClock } from "@velexis/testing";
import type { Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it } from "vitest";
import type { AuditService } from "../../audit/audit.service";
import type { OutboxService } from "../../notifications/outbox.service";
import type { EnvelopeService } from "../crypto.provider";
import type { PlatformDb } from "../database";
import type {
  CredentialSubmissionOutcome,
  CredentialSubmissionsRepository,
  CredentialSubmissionView,
} from "./credential-submissions.repository";
import { CREDENTIALS_SWEEP_JOB, CREDENTIALS_VERIFY_JOB } from "./credential-submissions.service";
import {
  CREDENTIALS_SWEEP_BATCH_SIZE,
  CREDENTIALS_SWEEP_EVERY_MS,
  CredentialsSweep,
  CredentialsSweepScheduler,
  SWEEP_PENDING_AGE_MS,
  SWEEP_VERIFYING_AGE_MS,
} from "./credentials-sweep";
import {
  CredentialsVerifyProcessor,
  CredentialVerifiers,
  PROVIDER_UNAVAILABLE,
  VERIFICATION_INCOMPLETE_MESSAGE,
  VERIFICATION_TIMEOUT_REASON,
} from "./credentials-verify.processor";

const NOW = new Date("2026-01-15T10:00:00.000Z");
const MINUTE = 60_000;
const TENANT = "ten_01JA2ZA1C5E9G3J7K2M6P00001";
const OWNER = "acc_01JA2ZA1C5E9G3J7K2M6P00001";
const PENDING_ID = "crs_01JA2ZA1C5E9G3J7K2M6P00001";
const OTHER_PENDING_ID = "crs_01JA2ZA1C5E9G3J7K2M6P00002";
const VERIFYING_ID = "crs_01JA2ZA1C5E9G3J7K2M6P00003";

/** A log line as the stand-in logger keeps it. */
interface Line {
  readonly level: "info" | "warn" | "error";
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function recordingLogger(lines: Line[]): PinoLogger {
  const at =
    (level: Line["level"]) =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, fields, message });
    };
  return { info: at("info"), warn: at("warn"), error: at("error") } as unknown as PinoLogger;
}

/** A BullMQ job of the stand-in queue: its state, and whether it was removed. */
interface StandInJob {
  state: string;
  removed: boolean;
}

/**
 * The sweep over stand-ins: `stale` answers the ids of each status (and records the cut-off asked for), the queue
 * holds `jobs` by id and records each add, and `failStuck` answers a failed row for the ids of `stuckFails`.
 */
class SweepHarness {
  readonly clock = new FakeClock(NOW);
  readonly lines: Line[] = [];
  readonly stale: Record<"pending" | "verifying", string[]> = { pending: [], verifying: [] };
  readonly asked: Array<{ status: string; before: Date; limit: number }> = [];
  readonly jobs = new Map<string, StandInJob>();
  readonly added: Array<{ name: string; data: unknown; jobId: string | undefined }> = [];
  readonly failCalls: Array<{ id: string; before: Date }> = [];
  /** The ids `failStuck` fails; any other answers `undefined` (a job won, or the row changed). */
  readonly stuckFails = new Set<string>();
  readonly sweep: CredentialsSweep;

  constructor() {
    const repository = {
      staleIds: (status: "pending" | "verifying", before: Date, limit: number) => {
        this.asked.push({ status, before, limit });
        return Promise.resolve([...this.stale[status]]);
      },
    };
    const queue = {
      getJob: (id: string) => {
        const job = this.jobs.get(id);
        if (job === undefined || job.removed) {
          return Promise.resolve(undefined);
        }
        return Promise.resolve({
          getState: () => Promise.resolve(job.state),
          remove: () => {
            job.removed = true;
            return Promise.resolve();
          },
        });
      },
      add: (name: string, data: unknown, options: { jobId?: string }) => {
        this.added.push({ name, data, jobId: options.jobId });
        if (options.jobId !== undefined) {
          this.jobs.set(options.jobId, { state: "waiting", removed: false });
        }
        return Promise.resolve({});
      },
    };
    const verify = {
      failStuck: (id: string, before: Date) => {
        this.failCalls.push({ id, before });
        return Promise.resolve(
          this.stuckFails.has(id)
            ? {
                id,
                tenant_id: TENANT,
                kind: "amadeus",
                environment: "test",
                status: "failed",
                error_code: PROVIDER_UNAVAILABLE,
              }
            : undefined,
        );
      },
    };
    this.sweep = new CredentialsSweep(
      repository as unknown as CredentialSubmissionsRepository,
      verify as unknown as CredentialsVerifyProcessor,
      this.clock,
      queue as unknown as Queue,
      recordingLogger(this.lines),
    );
  }
}

describe("CredentialsSweep.run", () => {
  it("[FIX-W38-PLATFORM AC5] picks pending submissions older than 10 minutes and verifying ones older than 1 hour, by the Clock", async () => {
    const h = new SweepHarness();

    expect(await h.sweep.run()).toEqual({ requeued: 0, failed: 0 });

    expect(h.asked).toEqual([
      {
        status: "pending",
        before: new Date(NOW.getTime() - 10 * MINUTE),
        limit: CREDENTIALS_SWEEP_BATCH_SIZE,
      },
      {
        status: "verifying",
        before: new Date(NOW.getTime() - 60 * MINUTE),
        limit: CREDENTIALS_SWEEP_BATCH_SIZE,
      },
    ]);
    expect([SWEEP_PENDING_AGE_MS, SWEEP_VERIFYING_AGE_MS, CREDENTIALS_SWEEP_EVERY_MS]).toEqual([
      10 * MINUTE,
      60 * MINUTE,
      5 * MINUTE,
    ]);
    // A run that changed nothing logs nothing.
    expect(h.lines).toEqual([]);
  });

  it("[FIX-W38-PLATFORM AC5] queues credentials.verify again with the submission id as the job id, unless a job of it will still run", async () => {
    const h = new SweepHarness();
    h.stale.pending = [PENDING_ID, OTHER_PENDING_ID];
    // The first submission's job is gone (a lost enqueue); the second one's still waits in the queue.
    h.jobs.set(OTHER_PENDING_ID, { state: "waiting", removed: false });

    expect(await h.sweep.run()).toEqual({ requeued: 1, failed: 0 });
    expect(h.added).toEqual([
      { name: CREDENTIALS_VERIFY_JOB, data: { submissionId: PENDING_ID }, jobId: PENDING_ID },
    ]);

    // A second run while that job waits queues nothing twice.
    expect(await h.sweep.run()).toEqual({ requeued: 0, failed: 0 });
    expect(h.added).toHaveLength(1);

    for (const state of ["delayed", "active", "prioritized", "waiting-children"]) {
      h.jobs.set(PENDING_ID, { state, removed: false });
      expect(await h.sweep.run(), state).toEqual({ requeued: 0, failed: 0 });
    }
    expect(h.added).toHaveLength(1);
  });

  it("[FIX-W38-PLATFORM AC5] replaces a finished job of a pending submission, which BullMQ would keep instead of a new add", async () => {
    const h = new SweepHarness();
    h.stale.pending = [PENDING_ID, OTHER_PENDING_ID];
    const failed: StandInJob = { state: "failed", removed: false };
    const completed: StandInJob = { state: "completed", removed: false };
    h.jobs.set(PENDING_ID, failed);
    h.jobs.set(OTHER_PENDING_ID, completed);

    expect(await h.sweep.run()).toEqual({ requeued: 2, failed: 0 });

    expect([failed.removed, completed.removed]).toEqual([true, true]);
    expect(h.added.map((add) => add.jobId)).toEqual([PENDING_ID, OTHER_PENDING_ID]);
  });

  it("[FIX-W38-PLATFORM AC5] fails a submission left verifying through failStuck, and counts only what it wrote", async () => {
    const h = new SweepHarness();
    h.stale.verifying = [VERIFYING_ID, OTHER_PENDING_ID];
    h.stuckFails.add(VERIFYING_ID);

    expect(await h.sweep.run()).toEqual({ requeued: 0, failed: 1 });

    const cutOff = new Date(NOW.getTime() - SWEEP_VERIFYING_AGE_MS);
    expect(h.failCalls).toEqual([
      { id: VERIFYING_ID, before: cutOff },
      { id: OTHER_PENDING_ID, before: cutOff },
    ]);
    // No job is queued for a verifying submission.
    expect(h.added).toEqual([]);
  });

  it("[FIX-W38-PLATFORM AC5] logs ids, the tenant, kind, environment, error code and counts only", async () => {
    const h = new SweepHarness();
    h.stale.pending = [PENDING_ID];
    h.stale.verifying = [VERIFYING_ID];
    h.stuckFails.add(VERIFYING_ID);

    await h.sweep.run();

    expect(h.lines).toEqual([
      { level: "info", fields: { submissionId: PENDING_ID }, message: "credentials.sweep_requeued" },
      {
        level: "warn",
        fields: {
          submissionId: VERIFYING_ID,
          tenantId: TENANT,
          kind: "amadeus",
          environment: "test",
          errorCode: PROVIDER_UNAVAILABLE,
        },
        message: "credentials.sweep_failed",
      },
      { level: "info", fields: { requeued: 1, failed: 1 }, message: "credentials.sweep" },
    ]);
  });
});

describe("CredentialsSweepScheduler", () => {
  it("[FIX-W38-PLATFORM AC5] registers one credentials.sweep job scheduler on its queue, every 5 minutes", async () => {
    const upserts: unknown[][] = [];
    const queue = {
      upsertJobScheduler: (...args: unknown[]) => {
        upserts.push(args);
        return Promise.resolve({});
      },
    };
    const scheduler = new CredentialsSweepScheduler(queue as unknown as Queue, recordingLogger([]));

    await scheduler.register();
    await scheduler.register();

    // An upsert: a second start replaces the scheduler of the same id, never adds a second one.
    expect(upserts).toEqual([
      [CREDENTIALS_SWEEP_JOB, { every: 5 * MINUTE }, { name: CREDENTIALS_SWEEP_JOB, data: {} }],
      [CREDENTIALS_SWEEP_JOB, { every: 5 * MINUTE }, { name: CREDENTIALS_SWEEP_JOB, data: {} }],
    ]);
  });
});

/** A verifying submission as `lock` reads it, last changed `updatedAt`. */
function verifyingRow(
  updatedAt: Date,
  overrides: Partial<CredentialSubmissionView> = {},
): CredentialSubmissionView {
  return {
    id: VERIFYING_ID,
    tenant_id: TENANT,
    kind: "stripe_api_keys",
    environment: "live",
    public_data: { publishableKey: "pk_live_1TestPublishableKeyOnly" },
    encryption_key_id: "master-v1",
    status: "verifying",
    error_code: null,
    error_message: null,
    attempts: 2,
    submitted_by_account_id: OWNER,
    finished_at: null,
    created_at: new Date(updatedAt.getTime() - MINUTE),
    updated_at: updatedAt,
    ...overrides,
  };
}

/** `failStuck` over stand-ins: the locked row, and what is written in the transaction. */
class FailStuckHarness {
  locked: CredentialSubmissionView | undefined;
  readonly finished: Array<{ id: string; outcome: CredentialSubmissionOutcome; now: Date }> = [];
  readonly audit: unknown[] = [];
  readonly queued: unknown[] = [];
  readonly processor: CredentialsVerifyProcessor;

  constructor() {
    const repository = {
      lock: () => Promise.resolve(this.locked),
      finish: (_trx: unknown, id: string, outcome: CredentialSubmissionOutcome, now: Date) => {
        this.finished.push({ id, outcome, now });
        const current = this.locked as CredentialSubmissionView;
        return Promise.resolve({
          ...current,
          status: outcome.status,
          error_code: outcome.status === "failed" ? outcome.errorCode : null,
          error_message: outcome.status === "failed" ? outcome.errorMessage : null,
          finished_at: now,
          updated_at: now,
        });
      },
      tenantLabel: () =>
        Promise.resolve({ name: "Agency Travel", key: "agency", status: "active", deleted_at: null }),
      emailRecipient: () =>
        Promise.resolve({ account_id: OWNER, email: "owner@example.com", full_name: "Anna Berg" }),
    };
    const audit = {
      record: (_trx: unknown, entry: unknown) => {
        this.audit.push(entry);
        return Promise.resolve({ id: "1", createdAt: NOW });
      },
    };
    const outbox = {
      portalLink: (path: string) => `https://platform.example.com${path}`,
      queue: (_trx: unknown, message: unknown) => {
        this.queued.push(message);
        return Promise.resolve();
      },
    };
    const db = {
      transaction: () => ({ execute: <T>(work: (trx: object) => Promise<T>): Promise<T> => work({}) }),
    };
    const envelope = {
      decrypt: () => Promise.reject(new Error("failStuck never decrypts a secret")),
    };
    this.processor = new CredentialsVerifyProcessor(
      repository as unknown as CredentialSubmissionsRepository,
      new CredentialVerifiers(),
      envelope as unknown as EnvelopeService,
      audit as unknown as AuditService,
      outbox as unknown as OutboxService,
      new FakeClock(NOW),
      db as unknown as PlatformDb,
      recordingLogger([]),
    );
  }
}

describe("CredentialsVerifyProcessor.failStuck", () => {
  const cutOff = new Date(NOW.getTime() - SWEEP_VERIFYING_AGE_MS);

  it("[FIX-W38-PLATFORM AC5] fails a submission still verifying since before the cut-off: PROVIDER_UNAVAILABLE, the rejected audit row and the e-mail", async () => {
    const h = new FailStuckHarness();
    h.locked = verifyingRow(new Date(cutOff.getTime() - 1));

    const row = await h.processor.failStuck(VERIFYING_ID, cutOff);

    expect(row).toMatchObject({ status: "failed", error_code: PROVIDER_UNAVAILABLE });
    // `finish` erases both secret columns in the same UPDATE (the repository's one write of a final status).
    expect(h.finished).toEqual([
      {
        id: VERIFYING_ID,
        outcome: {
          status: "failed",
          errorCode: PROVIDER_UNAVAILABLE,
          errorMessage: VERIFICATION_INCOMPLETE_MESSAGE,
        },
        now: NOW,
      },
    ]);
    expect(h.audit).toEqual([
      {
        actorType: "system",
        actorLabel: CREDENTIALS_SWEEP_JOB,
        action: "payments.api_keys_rejected",
        targetType: "credential_submission",
        targetId: VERIFYING_ID,
        tenantId: TENANT,
        before: { status: "verifying" },
        after: { status: "failed", errorCode: PROVIDER_UNAVAILABLE },
        details: {
          kind: "stripe_api_keys",
          environment: "live",
          attempt: 2,
          errorMessage: VERIFICATION_INCOMPLETE_MESSAGE,
          reason: VERIFICATION_TIMEOUT_REASON,
        },
      },
    ]);
    expect(h.queued).toEqual([
      expect.objectContaining({
        templateKey: "connection.credentials_failed",
        to: "owner@example.com",
        idempotencyKey: `credentials:${VERIFYING_ID}`,
        data: expect.objectContaining({
          errorCode: PROVIDER_UNAVAILABLE,
          reason: VERIFICATION_INCOMPLETE_MESSAGE,
        }) as unknown,
      }),
    ]);
  });

  it("[FIX-W38-PLATFORM AC5] writes nothing when a job finished first, the row is gone, or an attempt started since the cut-off", async () => {
    const h = new FailStuckHarness();
    const old = new Date(cutOff.getTime() - 1);
    for (const locked of [
      verifyingRow(old, { status: "applied" }),
      verifyingRow(old, { status: "failed" }),
      verifyingRow(old, { status: "superseded" }),
      verifyingRow(old, { status: "pending" }),
      verifyingRow(cutOff),
      verifyingRow(NOW),
      undefined,
    ]) {
      h.locked = locked;
      expect(await h.processor.failStuck(VERIFYING_ID, cutOff)).toBeUndefined();
    }
    expect([h.finished, h.audit, h.queued]).toEqual([[], [], []]);
  });
});
