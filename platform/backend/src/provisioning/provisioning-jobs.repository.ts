// The `provisioning_jobs` repository (platform/docs/architecture.md §2.1: ProvisioningModule owns the table; PADR-0001).
// PBE-018 brings the `provision` job of a new OTA, inserted `queued` in the create-OTA transaction; PBE-019 the read of
// a job with its dispatch gate and the transition `queued → running` of a dispatch; PBE-022 the reads and writes of the
// tenant-event consumer and the post-steps (the job with its tenant, the step log, the result, the reveal ciphertext,
// the transition to `succeeded`) and the mirror of the tenant's migration ledger in `tenant_schema_migrations`, the
// module's other table; the reconciler, retries and the key reveal (PBE-023) add theirs. Kysely on the process's
// `PLATFORM_DB`, schema-qualified tables (ADR-0005). Times are the service's `Clock`, never the database's `now()`, so
// leases follow the FakeClock in tests.
import { Inject, Injectable } from "@nestjs/common";
import type { ProvisioningStepRecord, TenantMigrationRecord } from "@velexis/api-types/jobs";
import { sql } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { CURRENT_SUBSCRIPTION_STATUSES } from "../billing/subscriptions.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

/** The kinds of `provisioning_jobs.kind` (migration 0001). */
export type ProvisioningJobKind =
  "provision" | "migrate" | "suspend" | "resume" | "export" | "delete" | "restore" | "rotate_secrets";

/** The states of `provisioning_jobs.status` (migration 0001); `queued` and `running` are the active ones. */
export type ProvisioningJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** The attempts a provisioning job may make before it fails for good (provisioning flow, PADR-0001). */
export const PROVISION_MAX_ATTEMPTS = 5;

/** A new job, as the lifecycle service queues it. */
export interface NewProvisioningJob {
  /** `job_…`. */
  readonly id: string;
  readonly tenantId: string;
  readonly kind: ProvisioningJobKind;
  /** The account that asked for it; `null` for the system. */
  readonly requestedByAccountId: string | null;
  /** The time of the request: `scheduled_at` (it may start at once), `created_at` and `updated_at`. */
  readonly now: Date;
}

/** What the API answers about a job it has just queued (`TenantCreated.provisioningJob`). */
export interface QueuedJobRow {
  readonly id: string;
  readonly status: ProvisioningJobStatus;
}

/** A job as the dispatch reads it: the job, its tenant's status and the tenant's current subscription. */
export interface DispatchCandidateRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly kind: ProvisioningJobKind;
  readonly status: ProvisioningJobStatus;
  readonly scheduled_at: Date;
  /** The job's input (`provisioning_jobs.payload`), the payload of its `ota-tenant-ops` message. */
  readonly payload: unknown;
  readonly tenant_status: string;
  /** The status of the tenant's current subscription (CURRENT_SUBSCRIPTION_STATUSES); `null` when it has none. */
  readonly subscription_status: string | null;
  /** `stripe` or `manual`; `null` when the tenant has no current subscription. */
  readonly billing_provider: string | null;
}

/** The transition of a dispatch. */
export interface DispatchTransition {
  readonly jobId: string;
  /** The dispatch's time: the job must be due by then, and it becomes `started_at` on the first attempt. */
  readonly now: Date;
  /** The end of the lease (`locked_until`): now + 15 minutes. */
  readonly lockedUntil: Date;
}

/** A job as the tenant-event consumer and the post-steps read it: the job and what they need of its tenant. */
export interface PostStepJobRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly kind: ProvisioningJobKind;
  readonly status: ProvisioningJobStatus;
  readonly attempt: number;
  /** The step log (`[{step, status, startedAt, finishedAt, error?}]`), as stored. */
  readonly steps: unknown;
  /** The job's output so far (`{schemaVersion, officeId?, apiKeyIds}`), as stored; `null` before the first step. */
  readonly result: unknown;
  readonly tenant_key: string;
  readonly tenant_name: string;
  readonly tenant_status: string;
  /** `tenant_<key>` (a generated column, which Kysely types as nullable). */
  readonly tenant_schema_name: string | null;
}

/** What one post-step writes to the job's log. */
export interface StepLogWrite {
  readonly jobId: string;
  /** Appended to `steps` in order. */
  readonly entries: readonly ProvisioningStepRecord[];
  /** The new `step` (the current or last step). */
  readonly step: string;
  /** The new last error of the job (`error`), `null` to clear it; absent leaves it as it is. */
  readonly error?: string | null;
  readonly now: Date;
}

/** One row of a tenant's migration ledger, as the platform mirrors it. */
export interface TenantMigrationMirror {
  readonly tenantId: string;
  readonly schemaName: string;
  /** The job whose event reported the ledger (`runner_id`). */
  readonly runnerId: string;
  readonly migration: TenantMigrationRecord;
  readonly now: Date;
}

/** The columns of a `PostStepJobRow`: the job's and its tenant's. */
const POST_STEP_JOB_COLUMNS = [
  "j.id",
  "j.tenant_id",
  "j.kind",
  "j.status",
  "j.attempt",
  "j.steps",
  "j.result",
  "t.key as tenant_key",
  "t.name as tenant_name",
  "t.status as tenant_status",
  "t.schema_name as tenant_schema_name",
] as const;

@Injectable()
export class ProvisioningJobsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * Inserts `job` in `trx`, `queued` with no attempt made yet, `max_attempts = 5`, an empty step log and payload, and
   * `scheduled_at = now`. A second active job of the same kind for the tenant fails on `provisioning_jobs_active_uq`.
   */
  async insertQueued(trx: PlatformTransaction, job: NewProvisioningJob): Promise<QueuedJobRow> {
    const row = await trx
      .insertInto("platform.provisioning_jobs")
      .values({
        id: job.id,
        tenant_id: job.tenantId,
        kind: job.kind,
        status: "queued" satisfies ProvisioningJobStatus,
        attempt: 0,
        max_attempts: PROVISION_MAX_ATTEMPTS,
        scheduled_at: job.now,
        requested_by_account_id: job.requestedByAccountId,
        created_at: job.now,
        updated_at: job.now,
      })
      .returning(["id", "status"])
      .executeTakeFirstOrThrow();
    return { id: row.id, status: row.status as ProvisioningJobStatus };
  }

  /**
   * Reads job `jobId` in `trx` with its tenant's status and the tenant's current subscription (at most one row is in
   * CURRENT_SUBSCRIPTION_STATUSES, `subscriptions_current_uq`), and locks the job's row (`FOR UPDATE OF j`), so two
   * dispatches of one job run one after the other: the second reads the job the first one left. `undefined` for an
   * unknown job.
   */
  async lockForDispatch(trx: PlatformTransaction, jobId: string): Promise<DispatchCandidateRow | undefined> {
    const row = await trx
      .selectFrom("platform.provisioning_jobs as j")
      .innerJoin("platform.tenants as t", "t.id", "j.tenant_id")
      .leftJoin("platform.subscriptions as s", (join) =>
        join
          .onRef("s.tenant_id", "=", "j.tenant_id")
          .on("s.status", "in", [...CURRENT_SUBSCRIPTION_STATUSES]),
      )
      .select([
        "j.id",
        "j.tenant_id",
        "j.kind",
        "j.status",
        "j.scheduled_at",
        "j.payload",
        "t.status as tenant_status",
        "s.status as subscription_status",
        "s.billing_provider",
      ])
      .where("j.id", "=", jobId)
      .forUpdate("j")
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    return {
      ...row,
      kind: row.kind as ProvisioningJobKind,
      status: row.status as ProvisioningJobStatus,
    };
  }

  /**
   * The conditional update of a dispatch, in `trx`: `queued → running`, `attempt + 1`, `step = 'dispatch'`,
   * `started_at = coalesce(started_at, now)`, `locked_until` and `updated_at`, only while the job is `queued` and due
   * (`scheduled_at <= now`). Returns the new attempt, or `undefined` when another process won (no row changed).
   */
  async markDispatched(
    trx: PlatformTransaction,
    transition: DispatchTransition,
  ): Promise<number | undefined> {
    const { jobId, now, lockedUntil } = transition;
    const row = await trx
      .updateTable("platform.provisioning_jobs")
      .set((eb) => ({
        status: "running" satisfies ProvisioningJobStatus,
        attempt: eb("attempt", "+", 1),
        step: "dispatch",
        started_at: sql<Date>`coalesce(started_at, ${now}::timestamptz)`,
        locked_until: lockedUntil,
        updated_at: now,
      }))
      .where("id", "=", jobId)
      .where("status", "=", "queued" satisfies ProvisioningJobStatus)
      .where("scheduled_at", "<=", now)
      .returning("attempt")
      .executeTakeFirst();
    return row?.attempt;
  }

  /** Job `jobId` with its tenant, read on the pool (no lock): the tenant-event consumer's first look. */
  async findForEvent(jobId: string): Promise<PostStepJobRow | undefined> {
    const row = await this.db
      .selectFrom("platform.provisioning_jobs as j")
      .innerJoin("platform.tenants as t", "t.id", "j.tenant_id")
      .select(POST_STEP_JOB_COLUMNS)
      .where("j.id", "=", jobId)
      .executeTakeFirst();
    return row === undefined ? undefined : toPostStepJob(row);
  }

  /**
   * Job `jobId` with its tenant, read in `trx` with the job's row locked (`FOR UPDATE OF j`), so the post-steps of one
   * job never run twice at the same time: a second delivery of an event waits, then reads the log the first one left.
   */
  async lockForPostStep(trx: PlatformTransaction, jobId: string): Promise<PostStepJobRow | undefined> {
    const row = await trx
      .selectFrom("platform.provisioning_jobs as j")
      .innerJoin("platform.tenants as t", "t.id", "j.tenant_id")
      .select(POST_STEP_JOB_COLUMNS)
      .where("j.id", "=", jobId)
      .forUpdate("j")
      .executeTakeFirst();
    return row === undefined ? undefined : toPostStepJob(row);
  }

  /** Appends `entries` to the step log of a job locked by `lockForPostStep`, sets `step` and, when given, `error`. */
  async appendSteps(trx: PlatformTransaction, write: StepLogWrite): Promise<void> {
    await trx
      .updateTable("platform.provisioning_jobs")
      .set({
        // jsonb is written as JSON text; `||` appends the array's elements.
        steps: sql`steps || ${JSON.stringify(write.entries)}::jsonb`,
        step: write.step,
        ...(write.error === undefined ? {} : { error: write.error }),
        updated_at: write.now,
      })
      .where("id", "=", write.jobId)
      .execute();
  }

  /** Merges the top-level fields of `fields` into the `result` of a job locked by `lockForPostStep`. */
  async mergeResult(
    trx: PlatformTransaction,
    jobId: string,
    fields: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("platform.provisioning_jobs")
      .set({
        result: sql`coalesce(result, '{}'::jsonb) || ${JSON.stringify(fields)}::jsonb`,
        updated_at: now,
      })
      .where("id", "=", jobId)
      .execute();
  }

  /**
   * Stores the envelope-encrypted initial keys of a job locked by `lockForPostStep` for their one reveal
   * (`reveal_ciphertext`, `reveal_encryption_key_id`; PBE-023 reveals and erases them).
   */
  async storeReveal(
    trx: PlatformTransaction,
    jobId: string,
    reveal: { readonly ciphertext: Uint8Array; readonly kekId: string },
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("platform.provisioning_jobs")
      .set({
        reveal_ciphertext: Buffer.from(reveal.ciphertext),
        reveal_encryption_key_id: reveal.kekId,
        updated_at: now,
      })
      .where("id", "=", jobId)
      .execute();
  }

  /**
   * The end of a job whose post-steps activated its tenant, in `trx`: `succeeded`, `finished_at`, no lease and no
   * error, only while the job is still active (`queued` or `running`) at `attempt`. False when another process changed
   * it meanwhile (no row changed).
   */
  async markSucceeded(
    trx: PlatformTransaction,
    transition: { readonly jobId: string; readonly attempt: number; readonly now: Date },
  ): Promise<boolean> {
    const row = await trx
      .updateTable("platform.provisioning_jobs")
      .set({
        status: "succeeded" satisfies ProvisioningJobStatus,
        finished_at: transition.now,
        locked_until: null,
        error: null,
        updated_at: transition.now,
      })
      .where("id", "=", transition.jobId)
      .where("status", "in", ["queued", "running"] satisfies ProvisioningJobStatus[])
      .where("attempt", "=", transition.attempt)
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Mirrors one row of a tenant schema's ledger into `tenant_schema_migrations` in `trx` (`applied`): an upsert on
   * `(tenant_id, version)`, so a second report of the same ledger changes nothing but the times it carries.
   */
  async upsertTenantMigration(trx: PlatformTransaction, mirror: TenantMigrationMirror): Promise<void> {
    const { migration } = mirror;
    const finishedAt = new Date(migration.appliedAt);
    const startedAt =
      migration.durationMs === null ? finishedAt : new Date(finishedAt.getTime() - migration.durationMs);
    const values = {
      schema_name: mirror.schemaName,
      checksum: migration.checksum,
      phase: migration.phase,
      status: "applied",
      runner_id: mirror.runnerId,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: migration.durationMs,
      error: null,
      updated_at: mirror.now,
    };
    await trx
      .insertInto("platform.tenant_schema_migrations")
      .values({ ...values, tenant_id: mirror.tenantId, version: migration.version, created_at: mirror.now })
      .onConflict((conflict) => conflict.columns(["tenant_id", "version"]).doUpdateSet(values))
      .execute();
  }
}

/** The row of a `PostStepJobRow` query, typed. */
function toPostStepJob(row: Omit<PostStepJobRow, "kind" | "status"> & { kind: string; status: string }) {
  return {
    ...row,
    kind: row.kind as ProvisioningJobKind,
    status: row.status as ProvisioningJobStatus,
  } satisfies PostStepJobRow;
}
