// The `provisioning_jobs` repository (platform/docs/architecture.md §2.1: ProvisioningModule owns the table; PADR-0001).
// PBE-018 brings the `provision` job of a new OTA, inserted `queued` in the create-OTA transaction; the dispatch
// (PBE-019), the tenant events and post-steps (PBE-022) and the reconciler, retries and the key reveal (PBE-023) add
// their reads and transitions. Kysely on the API's `PLATFORM_DB`, schema-qualified tables (ADR-0005).
import { Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../audit/audit.repository";

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
}
