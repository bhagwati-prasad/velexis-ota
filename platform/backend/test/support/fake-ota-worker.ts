// FakeOtaWorker (PBE-019; PADR-0017 item 1): the OTA worker's part of provisioning for platform integration tests. It
// is a BullMQ worker on `ota-tenant-ops` that takes the `tenant.*` messages the platform dispatches and answers on
// `platform-tenant-events` the way the real OTA worker does (ota/backend/src/provisioning/tenant-ops.processor.ts and
// tenant-events.producer.ts), with an outcome chosen per tenant:
//
//   const fake = await FakeOtaWorker.start({ redisUrl: t.redis.url, schemaNameOf: schemaNamesFrom(pool) });
//   fake.setOutcome(tenantId, { type: "failed", retryable: true });
//   const [handled] = await fake.waitForHandled((all) => all.filter((h) => h.message.jobId === jobId).length > 0);
//   await fake.close();
//
// - `provisioned` (the default): `tenant.provision` answers `tenant.provisioned` with a fake ledger of the two tenant
//   migrations (FAKE_TENANT_LEDGER) and the three OTA steps, all `succeeded`; `tenant.migrate` answers
//   `tenant.migrated` with the ledger up to `targetVersion`; `tenant.suspend` and `tenant.resume` answer
//   `tenant.suspended` and `tenant.resumed`.
// - `failed {retryable, code?}`: `tenant.provision` answers `tenant.provision_failed` (`create_schema` succeeded,
//   `run_migrations` failed) and `tenant.migrate` answers `tenant.migration_failed` for the second migration, both with
//   `retryable` as given. `tenant.suspend` and `tenant.resume` have no failure event: they get no answer.
// - `silent`: no answer at all, like a lost message or the real worker today for `tenant.suspend` (PADR-0001 item 7).
//
// Every message is checked with `validateJob` of `@velexis/api-types/jobs` on receipt (an invalid one is recorded in
// `invalid` and fails as BullMQ's `UnrecoverableError`, as in the real worker), and every answer before it is added, so
// a test that runs the fake also proves that both directions keep the PBE-004 contract. An answer carries the message's
// `jobId`, `tenantId` and `requestId`, `requestedAt` from `now()`, and the message's BullMQ id `<jobId>-<attempt>` as
// its own BullMQ id, from which the platform reads the attempt. The fake answers at once: BullMQ's tries inside one
// attempt (`attempts: 3`) are the real worker's business. After a failure answer, and when it stays silent, the BullMQ
// job fails at once (`UnrecoverableError`), so the reconciler (PBE-023) finds it "failed without an event"; after a
// success answer it completes.
//
// It never connects to a tenant schema, and it writes nothing to PostgreSQL: the schema name of a tenant comes from
// `schemaNameOf` (schemaNamesFrom reads `platform.tenants`, as the real worker does with its read-only role). It is
// test-only code: nothing under src/ imports it, and the build never ships test/.
import { createHash } from "node:crypto";
import {
  BULLMQ_PREFIX,
  JOB_CONTRACT_VERSION,
  MessageValidationError,
  OTA_PROVISIONING_STEPS,
  OTA_TENANT_OPS,
  parseBullmqJobId,
  PLATFORM_TENANT_EVENTS,
  TENANT_OPS_JOB_NAMES,
  validateJob,
  type ProvisioningStepRecord,
  type TenantEvent,
  type TenantJobError,
  type TenantMigrationRecord,
  type TenantOpsJob,
} from "@velexis/api-types/jobs";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { Queryable } from "../builders/platform-rows";

/** What the fake answers for one tenant (see the file header). */
export type FakeOtaOutcome =
  | { readonly type: "provisioned" }
  | {
      readonly type: "failed";
      readonly retryable: boolean;
      /** The error code of the answer; default `LOCK_TIMEOUT` when retryable, else `CHECKSUM_MISMATCH`. */
      readonly code?: string;
    }
  | { readonly type: "silent" };

/** The default outcome of every tenant. */
export const FAKE_PROVISIONED: FakeOtaOutcome = Object.freeze({ type: "provisioned" });

/** One migration of the fake ledger: a row of a tenant schema's `schema_migrations` without its time. */
export type FakeLedgerEntry = Omit<TenantMigrationRecord, "appliedAt">;

/** A checksum that looks like a SHA-256 of a migration file: the SHA-256 of its name. */
function fakeChecksum(version: string): string {
  return createHash("sha256").update(`fake-ota-worker:${version}`, "utf8").digest("hex");
}

/** The fake ledger of every provisioned schema: the two tenant migrations of ota/backend/migrations/tenant. */
export const FAKE_TENANT_LEDGER: readonly FakeLedgerEntry[] = Object.freeze(
  [
    { version: "0001_baseline", phase: "expand", durationMs: 412 },
    { version: "0002_add_mvp_tenant_deltas", phase: "expand", durationMs: 87 },
  ].map((entry) => Object.freeze({ ...entry, checksum: fakeChecksum(entry.version) }) as FakeLedgerEntry),
);

/** One message the fake took, and what it answered. */
export interface FakeOtaHandled {
  /** The message's BullMQ id, `<jobId>-<attempt>` for a dispatch. */
  readonly bullmqJobId: string | undefined;
  readonly message: TenantOpsJob;
  /** The event it added to `platform-tenant-events`; `null` when it stayed silent. */
  readonly answer: TenantEvent | null;
}

/** A message that broke its contract: refused, never answered. */
export interface FakeOtaInvalid {
  readonly bullmqJobId: string | undefined;
  readonly name: string;
  readonly error: MessageValidationError;
}

export interface FakeOtaWorkerOptions {
  /** The Redis of the platform under test (`t.redis.url`); the queues use the BullMQ prefix `vx`. */
  readonly redisUrl: string;
  /** The schema name of a tenant, for `tenant.provisioned`: `schemaNamesFrom(pool)` reads `platform.tenants`. */
  readonly schemaNameOf: (tenantId: string) => Promise<string>;
  /** The time of the answers; default the system clock. Pass `() => t.clock.now()` to follow a FakeClock. */
  readonly now?: () => Date;
  /** The outcome of a tenant without one of its own; default FAKE_PROVISIONED. */
  readonly defaultOutcome?: FakeOtaOutcome;
}

/** How long `waitForHandled` waits by default. */
export const FAKE_OTA_WAIT_MS = 10_000;

/** `schemaNameOf` that reads `platform.tenants.schema_name` through `db` (a pool of the test's role). */
export function schemaNamesFrom(db: Queryable): (tenantId: string) => Promise<string> {
  return async (tenantId) => {
    const { rows } = await db.query("SELECT schema_name FROM platform.tenants WHERE id = $1", [tenantId]);
    const schemaName = (rows[0] as { schema_name?: unknown } | undefined)?.schema_name;
    if (typeof schemaName !== "string") {
      throw new Error(`fake OTA worker: the tenant ${tenantId} has no row in platform.tenants`);
    }
    return schemaName;
  };
}

/** The BullMQ id of an answer: the message's own id when it is the dispatch id of the message's job. */
function answerJobId(message: TenantOpsJob, id: string | undefined): string | undefined {
  if (id === undefined) {
    return undefined;
  }
  return parseBullmqJobId(id)?.jobId === message.jobId ? id : undefined;
}

export class FakeOtaWorker {
  private readonly outcomes = new Map<string, FakeOtaOutcome>();
  private readonly handledMessages: FakeOtaHandled[] = [];
  private readonly invalidMessages: FakeOtaInvalid[] = [];
  private readonly workerErrors: Error[] = [];
  private readonly now: () => Date;
  private readonly defaultOutcome: FakeOtaOutcome;
  private readonly worker: Worker;
  private readonly events: Queue;

  private constructor(
    private readonly connection: Redis,
    private readonly options: FakeOtaWorkerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.defaultOutcome = options.defaultOutcome ?? FAKE_PROVISIONED;
    this.events = new Queue(PLATFORM_TENANT_EVENTS, { connection, prefix: BULLMQ_PREFIX });
    this.worker = new Worker(OTA_TENANT_OPS, (job) => this.process(job), {
      connection,
      prefix: BULLMQ_PREFIX,
      concurrency: 2,
    });
    this.worker.on("error", (error) => {
      this.workerErrors.push(error);
    });
  }

  /** Starts the worker on `options.redisUrl` and resolves once it and its event queue are connected. */
  static async start(options: FakeOtaWorkerOptions): Promise<FakeOtaWorker> {
    const connection = new Redis(options.redisUrl, {
      maxRetriesPerRequest: null,
      connectionName: "fake-ota-worker",
    });
    const fake = new FakeOtaWorker(connection, options);
    try {
      await Promise.all([fake.worker.waitUntilReady(), fake.events.waitUntilReady()]);
    } catch (error) {
      await fake.close();
      throw error;
    }
    return fake;
  }

  /** The messages taken so far, in the order they were answered. */
  get handled(): readonly FakeOtaHandled[] {
    return [...this.handledMessages];
  }

  /** The messages refused as invalid. */
  get invalid(): readonly FakeOtaInvalid[] {
    return [...this.invalidMessages];
  }

  /** Errors of the worker itself (its Redis connections). */
  get errors(): readonly Error[] {
    return [...this.workerErrors];
  }

  /** The outcome of every later message about `tenantId`. */
  setOutcome(tenantId: string, outcome: FakeOtaOutcome): void {
    this.outcomes.set(tenantId, outcome);
  }

  /**
   * Resolves with the handled messages once `done(handled)` is true, checking after every message; rejects after
   * `timeoutMs`.
   */
  async waitForHandled(
    done: (handled: readonly FakeOtaHandled[]) => boolean,
    timeoutMs: number = FAKE_OTA_WAIT_MS,
  ): Promise<readonly FakeOtaHandled[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const handled = this.handled;
      if (done(handled)) {
        return handled;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `fake OTA worker: the expected messages did not arrive within ${timeoutMs} ms (${handled.length} handled)`,
        );
      }
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 20));
    }
  }

  /** Stops the worker (it finishes the messages in progress), then closes the queue and the connection. */
  async close(): Promise<void> {
    await this.worker.close();
    await this.events.close();
    if (this.connection.status === "ready") {
      await this.connection.quit();
    } else {
      this.connection.disconnect();
    }
  }

  private async process(job: Job): Promise<string> {
    const message = this.validMessage(job);
    const outcome = this.outcomes.get(message.tenantId) ?? this.defaultOutcome;
    const answer = await this.answerTo(message, outcome);
    if (answer !== null) {
      validateJob(answer.name, answer);
      const jobId = answerJobId(message, job.id);
      await this.events.add(answer.name, answer, jobId === undefined ? {} : { jobId });
    }
    this.handledMessages.push({ bullmqJobId: job.id, message, answer });
    if (
      answer === null ||
      answer.name === "tenant.provision_failed" ||
      answer.name === "tenant.migration_failed"
    ) {
      throw new UnrecoverableError(
        answer === null ? "fake OTA worker: no answer (silent)" : `fake OTA worker: ${answer.name}`,
      );
    }
    return answer.name;
  }

  /** The message of `job`, checked against its contract; an invalid one is recorded and fails as unrecoverable. */
  private validMessage(job: Job): TenantOpsJob {
    try {
      if (!(TENANT_OPS_JOB_NAMES as readonly string[]).includes(job.name)) {
        throw new MessageValidationError(JSON.stringify(job.name), [
          { path: "/name", keyword: "name", message: "is not a message of ota-tenant-ops" },
        ]);
      }
      return validateJob(job.name, job.data) as TenantOpsJob;
    } catch (error) {
      if (error instanceof MessageValidationError) {
        this.invalidMessages.push({ bullmqJobId: job.id, name: job.name, error });
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  /** The event that answers `message` under `outcome`, or `null` for none. */
  private async answerTo(message: TenantOpsJob, outcome: FakeOtaOutcome): Promise<TenantEvent | null> {
    if (outcome.type === "silent") {
      return null;
    }
    const at = this.now().toISOString();
    const envelope = {
      v: JOB_CONTRACT_VERSION,
      jobId: message.jobId,
      tenantId: message.tenantId,
      requestedAt: at,
      requestId: message.requestId,
    } as const;
    const failed =
      outcome.type === "failed"
        ? {
            error: {
              code: outcome.code ?? (outcome.retryable ? "LOCK_TIMEOUT" : "CHECKSUM_MISMATCH"),
              message: outcome.retryable
                ? "canceling statement due to lock timeout"
                : "a tenant migration was changed after it was applied",
            },
            retryable: outcome.retryable,
          }
        : undefined;
    switch (message.name) {
      case "tenant.provision":
        if (failed !== undefined) {
          return {
            ...envelope,
            name: "tenant.provision_failed",
            payload: {
              ...failed,
              steps: [step("create_schema", at), step("run_migrations", at, failed.error)],
            },
          };
        }
        return {
          ...envelope,
          name: "tenant.provisioned",
          payload: {
            schemaName: await this.options.schemaNameOf(message.tenantId),
            schemaVersion: lastVersion(FAKE_TENANT_LEDGER),
            migrations: ledger(FAKE_TENANT_LEDGER, at),
            steps: OTA_PROVISIONING_STEPS.map((name) => step(name, at)),
          },
        };
      case "tenant.migrate": {
        if (failed !== undefined) {
          return {
            ...envelope,
            name: "tenant.migration_failed",
            payload: { version: lastVersion(FAKE_TENANT_LEDGER), ...failed },
          };
        }
        const target = message.payload.targetVersion;
        const end = FAKE_TENANT_LEDGER.findIndex((entry) => entry.version === target);
        const applied = end < 0 ? FAKE_TENANT_LEDGER : FAKE_TENANT_LEDGER.slice(0, end + 1);
        return {
          ...envelope,
          name: "tenant.migrated",
          payload: { schemaVersion: lastVersion(applied), migrations: ledger(applied, at) },
        };
      }
      case "tenant.suspend":
        return failed === undefined ? { ...envelope, name: "tenant.suspended", payload: {} } : null;
      case "tenant.resume":
        return failed === undefined ? { ...envelope, name: "tenant.resumed", payload: {} } : null;
    }
  }
}

/** A step of the OTA run that started and ended at `at`; failed when `error` is given. */
function step(name: string, at: string, error?: TenantJobError): ProvisioningStepRecord {
  return error === undefined
    ? { step: name, status: "succeeded", startedAt: at, finishedAt: at }
    : { step: name, status: "failed", startedAt: at, finishedAt: at, error };
}

/** The ledger rows of `entries`, applied at `at`. */
function ledger(entries: readonly FakeLedgerEntry[], at: string): TenantMigrationRecord[] {
  return entries.map((entry) => ({ ...entry, appliedAt: at }));
}

function lastVersion(entries: readonly FakeLedgerEntry[]): string {
  const last = entries[entries.length - 1];
  if (last === undefined) {
    throw new Error("fake OTA worker: an empty ledger has no schema version");
  }
  return last.version;
}
