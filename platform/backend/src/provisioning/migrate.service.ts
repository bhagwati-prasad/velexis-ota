// Tenant migrations seen from the platform (PBE-030; platform/docs/flows/provisioning.md §5, architecture.md §6.1,
// PADR-0001 items 7 and 8, OADR-0007 items 5 and 7). The platform never touches a tenant schema (decisions.md §5): it
// asks the OTA worker to migrate one, and it mirrors the ledger the OTA side reports.
//
// - `request` (adminMigrateTenant): one transaction locks the tenant's row. An unknown tenant, or one without a
//   `TenantStatus`, answers `404 NOT_FOUND`; a tenant without a schema yet (`schema_version` empty: the setup has not
//   recorded its migrations) `409 CONFLICT` (`details.reason = schema_missing`). A `migrate` job is queued (payload
//   `{targetVersion?}`, requested by the admin) with one `tenant.migration_requested` audit row (`actor_type =
//   'platform_admin'`); a second active `migrate` job of the tenant fails on `provisioning_jobs_active_uq`, which answers
//   `409 CONFLICT` (`migrate_job_active`). After the commit the job is dispatched as `tenant.migrate` (never failing the
//   call; the reconciler takes a job left `queued`) and the answer is the job as it is then.
// - `recordMigrated` (`tenant.migrated`, from the tenant-event consumer): the event's ledger, the schema's full one, is
//   upserted into `tenant_schema_migrations` (`applied`, checksum, phase, duration; a version mirrored for the first
//   time takes the job, or the deploy's request id for a fan-out report, as `runner_id`, and one mirrored before keeps
//   the runner that applied it), and `tenants.schema_version` becomes the event's `schemaVersion` unless it holds a
//   later version already (`compareMigrationVersions`: the reports of a job and of the deploy fan-out may
//   arrive in any order, and a schema never goes back). When the consumer passes the event's job (the job's current
//   attempt), the job is also finished: a `record_migrations` step in its log, `result.schemaVersion`, `succeeded`,
//   only while it is still active at that attempt. The deploy fan-out's reports (`jobId: null`) only mirror. A change of
//   the schema version or a finished job writes one `tenant.migrated` audit row (`actor_type = 'system'`). One
//   transaction; a second delivery writes the same rows again and nothing else.
// - `recordFanOutFailure` (`tenant.migration_failed` with `jobId: null`): the deploy fan-out could not migrate one
//   schema. Nothing is mirrored (the report has no ledger row to write) and the tenant's status and schema version stay;
//   ops get one `ops.alert` per tenant and deploy run (keyed by the tenant and the report's request id) and the alert is
//   audited once as `tenant.migration_failed` (`system`). The `tenant.migration_failed` answer of a `migrate` job goes
//   to the failure handler instead (tenant-events.processor.ts), which re-queues it when the OTA worker says it is
//   retryable or fails the job with an `ops.alert` (PADR-0001 item 7: never the tenant's status).
import { Inject, Injectable } from "@nestjs/common";
import type { TenantMigratedEvent, TenantMigrationFailedEvent } from "@velexis/api-types/jobs";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { OutboxService } from "../notifications/outbox.service";
import { TenantsRepository } from "../tenants/tenants.repository";
import { ProvisioningDispatcher } from "./dispatcher";
import { PROVISIONING_ACTOR_LABEL } from "./post-steps/activate.step";
import { ProvisioningJobsRepository, type AdminJobListRow } from "./provisioning-jobs.repository";
import { isShownTenantStatus } from "./suspension.service";

/** The `actor_label` of the audit rows of the deploy fan-out's reports. */
export const MIGRATION_REPORT_ACTOR_LABEL = "deploy";

/** The step a finished `migrate` job logs: the mirror of the ledger, as the provisioning post-step is named. */
export const MIGRATE_RECORD_STEP = "record_migrations";

/** The OTA worker's step of a `migrate` job, as a failed job's error names it. */
export const MIGRATE_OTA_STEP = "run_migrations";

/** PostgreSQL's SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

/** The unique index that allows one active job of each kind per tenant (migration 0001). */
const ACTIVE_JOB_UNIQUE_INDEX = "provisioning_jobs_active_uq";

/** True when `error` is the unique violation of a second active job of the tenant's kind. */
function isActiveJobConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === ACTIVE_JOB_UNIQUE_INDEX;
}

/** The number in front of a migration version (`0002` of `0002_add_loyalty`). */
function versionNumber(version: string): bigint {
  const digits = /^[0-9]+/.exec(version)?.[0];
  if (digits === undefined) {
    throw new RangeError("compareMigrationVersions: a version starts with its number");
  }
  return BigInt(digits);
}

/**
 * The order of two tenant migration versions (`TENANT_MIGRATION_VERSION_PATTERN`): by their numbers, then as text.
 * Negative when `a` comes before `b`, positive after, zero for the same version.
 */
export function compareMigrationVersions(a: string, b: string): number {
  const left = versionNumber(a);
  const right = versionNumber(b);
  if (left !== right) {
    return left < right ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when `candidate` is later than `current` (always, when there is no current version). */
export function isLaterMigrationVersion(candidate: string, current: string | null): boolean {
  return current === null || compareMigrationVersions(candidate, current) > 0;
}

/** The job an answer finishes: the event's job at its current attempt. */
export interface MigrateJobAnswer {
  readonly jobId: string;
  readonly attempt: number;
}

/** What `recordMigrated` did. */
export type MigratedOutcome =
  | {
      readonly outcome: "mirrored";
      /** The schema version the tenant has now. */
      readonly schemaVersion: string;
      /** True when this event moved `tenants.schema_version`. */
      readonly versionChanged: boolean;
      /** True when this event finished the `migrate` job it answers. */
      readonly jobSucceeded: boolean;
    }
  | { readonly outcome: "ignored"; readonly reason: "unknown_tenant" };

/** What `recordFanOutFailure` did. */
export type FanOutFailureOutcome =
  | {
      readonly outcome: "alerted";
      /** False when this report's alert was queued before (a second delivery). */
      readonly queued: boolean;
    }
  | { readonly outcome: "ignored"; readonly reason: "unknown_tenant" };

/** The `ops.alert` of a schema the deploy fan-out could not migrate. */
export function fanOutFailureAlert(
  tenant: { readonly id: string; readonly key: string; readonly schemaVersion: string | null },
  event: Pick<TenantMigrationFailedEvent, "requestId" | "payload">,
): { title: string; message: string } {
  const { version, error } = event.payload;
  const where = version === null ? "" : ` at the migration ${version}`;
  return {
    title: `Tenant migration failed: ${tenant.key}`,
    message:
      `The deploy fan-out (${event.requestId}) could not migrate the schema of the OTA ${tenant.key} (${tenant.id})` +
      `${where}: ${error.code}: ${error.message} The migration was rolled back; the OTA's status and its schema ` +
      `version (${tenant.schemaVersion ?? "none"}) did not change. Fix the cause, then migrate the OTA again from the ` +
      "platform admin (Tenants, Migrate) and check the logs of the OTA deploy.",
  };
}

@Injectable()
export class MigrateService {
  constructor(
    private readonly tenants: TenantsRepository,
    private readonly jobs: ProvisioningJobsRepository,
    private readonly dispatcher: ProvisioningDispatcher,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(MigrateService.name) private readonly logger: PinoLogger,
  ) {}

  /** adminMigrateTenant by the platform admin `accountId` (see the file header). */
  async request(
    tenantId: string,
    targetVersion: string | undefined,
    accountId: string,
  ): Promise<AdminJobListRow> {
    let jobId: string;
    try {
      jobId = await runInTransaction(this.db, async (trx) => {
        const tenant = await this.tenants.lockForUpdate(trx, tenantId);
        if (tenant === undefined || !isShownTenantStatus(tenant.status)) {
          throw new AppError("NOT_FOUND");
        }
        if (tenant.schema_version === null) {
          throw new AppError("CONFLICT", { details: { reason: "schema_missing", status: tenant.status } });
        }
        const now = this.clock.now();
        const payload = targetVersion === undefined ? {} : { targetVersion };
        const job = await this.jobs.insertQueued(trx, {
          id: this.ids.new("job"),
          tenantId,
          kind: "migrate",
          requestedByAccountId: accountId,
          now,
          payload,
        });
        await this.audit.record(trx, {
          actorType: "platform_admin",
          actorAccountId: accountId,
          action: "tenant.migration_requested",
          targetType: "tenant",
          targetId: tenantId,
          tenantId,
          tenantKey: tenant.key,
          details: {
            jobId: job.id,
            schemaVersion: tenant.schema_version,
            targetVersion: targetVersion ?? null,
          },
        });
        return job.id;
      });
    } catch (error) {
      if (isActiveJobConflict(error)) {
        throw new AppError("CONFLICT", { cause: error, details: { reason: "migrate_job_active" } });
      }
      throw error;
    }
    try {
      await this.dispatcher.dispatch(jobId);
    } catch (error) {
      this.logger.warn({ jobId, tenantId, err: error }, "provisioning.dispatch_failed");
    }
    const job = await this.jobs.findForAdmin(jobId);
    if (job === undefined) {
      throw new Error("MigrateService.request: the job written in this request cannot be read back");
    }
    return job;
  }

  /**
   * `tenant.migrated`: mirrors the ledger and the schema version, and finishes `answer`'s job when given (see the file
   * header).
   */
  async recordMigrated(event: TenantMigratedEvent, answer?: MigrateJobAnswer): Promise<MigratedOutcome> {
    return runInTransaction(this.db, async (trx): Promise<MigratedOutcome> => {
      const now = this.clock.now();
      // The job's row first, then the tenant's, in the order of the post-steps and the failure handler.
      const job = answer === undefined ? undefined : await this.jobs.lockForLifecycle(trx, answer.jobId);
      const tenant = await this.tenants.lockForUpdate(trx, event.tenantId);
      if (tenant === undefined) {
        return { outcome: "ignored", reason: "unknown_tenant" };
      }
      const { schemaVersion, migrations } = event.payload;
      const runnerId = event.jobId ?? event.requestId;
      for (const migration of migrations) {
        await this.jobs.upsertTenantMigration(trx, {
          tenantId: tenant.id,
          schemaName: tenant.schema_name ?? `tenant_${tenant.key}`,
          runnerId,
          migration,
          now,
        });
      }
      const versionChanged = isLaterMigrationVersion(schemaVersion, tenant.schema_version);
      if (versionChanged) {
        await this.tenants.setSchemaVersion(trx, tenant.id, schemaVersion, now);
      }
      const jobSucceeded =
        job !== undefined &&
        answer !== undefined &&
        (await this.finishJob(trx, job, answer, schemaVersion, now));
      if (versionChanged || jobSucceeded) {
        await this.audit.record(trx, {
          actorType: "system",
          actorLabel: event.jobId === null ? MIGRATION_REPORT_ACTOR_LABEL : PROVISIONING_ACTOR_LABEL,
          action: "tenant.migrated",
          targetType: "tenant",
          targetId: tenant.id,
          tenantId: tenant.id,
          tenantKey: tenant.key,
          before: { schemaVersion: tenant.schema_version },
          after: { schemaVersion: versionChanged ? schemaVersion : tenant.schema_version },
          details: {
            jobId: event.jobId,
            reportedVersion: schemaVersion,
            migrations: migrations.length,
          },
          requestId: event.requestId,
        });
      }
      return {
        outcome: "mirrored",
        schemaVersion: versionChanged ? schemaVersion : (tenant.schema_version ?? schemaVersion),
        versionChanged,
        jobSucceeded,
      };
    });
  }

  /** `tenant.migration_failed` of the deploy fan-out: one `ops.alert` and its audit row (see the file header). */
  async recordFanOutFailure(event: TenantMigrationFailedEvent): Promise<FanOutFailureOutcome> {
    return runInTransaction(this.db, async (trx): Promise<FanOutFailureOutcome> => {
      const tenant = await this.tenants.findWithHost(event.tenantId, trx);
      if (tenant === undefined) {
        return { outcome: "ignored", reason: "unknown_tenant" };
      }
      const alert = await this.outbox.queueOpsAlert(trx, {
        ...fanOutFailureAlert(
          { id: tenant.id, key: tenant.key, schemaVersion: tenant.schema_version },
          event,
        ),
        tenantId: tenant.id,
        idempotencyKey: `tenant.migration_failed:${tenant.id}:${event.requestId}`,
      });
      if (alert.queued) {
        await this.audit.record(trx, {
          actorType: "system",
          actorLabel: MIGRATION_REPORT_ACTOR_LABEL,
          action: "tenant.migration_failed",
          targetType: "tenant",
          targetId: tenant.id,
          tenantId: tenant.id,
          tenantKey: tenant.key,
          details: {
            jobId: null,
            version: event.payload.version,
            code: event.payload.error.code,
            schemaVersion: tenant.schema_version,
          },
          requestId: event.requestId,
        });
      }
      return { outcome: "alerted", queued: alert.queued };
    });
  }

  /**
   * Finishes the `migrate` job `job` (locked in `trx`) that `answer` answers: a `record_migrations` step, the schema
   * version in its result, `succeeded`; only while it is a `migrate` job still active at the answer's attempt.
   */
  private async finishJob(
    trx: PlatformTransaction,
    job: { readonly id: string; readonly kind: string; readonly status: string; readonly attempt: number },
    answer: MigrateJobAnswer,
    schemaVersion: string,
    now: Date,
  ): Promise<boolean> {
    if (
      job.kind !== "migrate" ||
      job.attempt !== answer.attempt ||
      (job.status !== "queued" && job.status !== "running")
    ) {
      return false;
    }
    const at = now.toISOString();
    await this.jobs.appendSteps(trx, {
      jobId: job.id,
      entries: [{ step: MIGRATE_RECORD_STEP, status: "succeeded", startedAt: at, finishedAt: at }],
      step: MIGRATE_RECORD_STEP,
      now,
    });
    await this.jobs.mergeResult(trx, job.id, { schemaVersion }, now);
    return this.jobs.markSucceeded(trx, { jobId: job.id, attempt: job.attempt, now });
  }
}
