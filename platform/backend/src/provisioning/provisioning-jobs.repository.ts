// The `provisioning_jobs` repository (platform/docs/architecture.md §2.1: ProvisioningModule owns the table; PADR-0001).
// PBE-018 brings the `provision` job of a new OTA, inserted `queued` in the create-OTA transaction; PBE-019 the read of
// a job with its dispatch gate and the transition `queued → running` of a dispatch; the tenant events and post-steps
// (PBE-022) and the reconciler, retries and the key reveal (PBE-023) add their reads and transitions. Kysely on the
// process's `PLATFORM_DB`, schema-qualified tables (ADR-0005). Times are the service's `Clock`, never the database's
// `now()`, so leases follow the FakeClock in tests.
import { Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { CURRENT_SUBSCRIPTION_STATUSES } from "../billing/subscriptions.repository";

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

@Injectable()
export class ProvisioningJobsRepository {
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
}
