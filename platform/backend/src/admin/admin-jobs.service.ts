// The platform admin's tenant jobs and queues (PBE-031; platform/docs/api-inventory-admin.md §3, flows/platform-admin-
// operations.md §C, PADR-0001 items 3, 7 and 8, ADR-0009 item 11, scope PF-83 and PF-84). Who may call is
// AdminAuthGuard's (`platform_admin`); this service owns the reads, the transactions of the two job actions, their
// audit rows (`actor_type = 'platform_admin'`, in the transaction of the change) and the dispatch after the commit.
//
// Tenant jobs (`provisioning_jobs`, the kinds of the API: `provision`, `migrate`, `suspend`, `resume`):
//
// - `list` (adminListProvisioningJobs): newest first, filters `status`, `kind` and `tenantId`, an opaque cursor of the
//   last job's id (`400 VALIDATION_FAILED`, `/query/cursor`, for anything else), `limit` 50 by default.
// - `get` (adminGetProvisioningJob): the job with its step log, its input (`payload`), its output (`result`), its lease
//   (`locked_until`, only while `running`) and `bullmqState`, the BullMQ state of its current attempt `<jobId>-<attempt>`
//   on `ota-tenant-ops` (`null` before the first dispatch; `unknown` when BullMQ no longer holds it, and also while
//   Redis cannot be asked, logged as `admin.job_state_unavailable`: the rest of the page comes from PostgreSQL). The
//   repository never selects the reveal columns (`reveal_ciphertext`, its KEK id), and `payload` and `result` (ids and
//   options the platform wrote: `targetVersion`, the suspension reason, `schemaVersion`, `officeId`, `apiKeyIds`) also
//   lose every key that names a ciphertext, so no ciphertext is ever answered.
// - `retry` (adminRetryProvisioningJob): one transaction locks the job; only a `failed` one is retried (`409
//   PROVISIONING_NOT_RETRYABLE`, `details.reason = not_failed`). A `provision` job also locks its tenant, which must be
//   `failed` (`tenant_not_failed`) and goes back to `provisioning` (`version + 1`, a `tenant` invalidation after the
//   commit). A **new** job of the same kind and payload is queued, requested by the admin; the failed one stays as
//   history. A job of that kind already queued or running for the OTA fails on the partial unique index
//   (`job_active`). Audit `provisioning_job.retried` (target the new job; the failed job, its error and the tenant
//   status in the row). After the commit the job is dispatched as the owner's retry dispatches it (never failing the
//   call; the reconciler takes a job left `queued`, and a `provision` job may wait for its gate), and the answer is
//   `202 {job}` as it is then. When the schema already exists the OTA worker's run is a no-op and only the platform's
//   post-steps run again (each idempotent), so the OTA becomes `active`.
// - `cancel` (adminCancelProvisioningJob, **reason**): one transaction locks the job; only a `queued` one is canceled
//   (`409 CONFLICT`, `details.reason = not_queued`, for a running or finished job). It becomes `canceled`
//   (`finished_at`), nothing more is sent to the OTA worker (the reconciler dispatches `queued` jobs only), and the
//   tenant's status does not change. Audit `provisioning_job.canceled` with the reason.
//
// Queues (QueueInspector, BullMQ read-only but for one retry): `listQueues` and `listFailedQueueJobs` for every queue of
// both backends (an unknown queue `404 NOT_FOUND`), and `retryQueueJob` (adminRetryQueueJob) for platform queues only:
// an `ota-*` queue answers `403 FORBIDDEN` (`details.reason = ota_queue`) whatever the job; a job id that is not a
// failed job of the queue `404 NOT_FOUND`. The retry runs inside the transaction of its audit row
// `queue_job.retried`, after the row is written, so a retry that fails leaves no row and a row means the job was moved.
// Redis unreachable answers `503 SERVICE_UNAVAILABLE` for the three queue operations.
//
// Jobs of the post-MVP kinds (`export`, `delete`, …) are outside the API: nothing creates them, the list leaves them
// out and the detail and the actions answer `404 NOT_FOUND`.
import { Inject, Injectable } from "@nestjs/common";
import { bullmqJobId, OTA_TENANT_OPS, type QueueName } from "@velexis/api-types/jobs";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { ProvisioningDispatcher } from "../provisioning/dispatcher";
import { stepLog } from "../provisioning/post-steps/post-steps.runner";
import {
  MAX_JOB_ERROR_LENGTH,
  ProvisioningJobsRepository,
  type AdminJobDetailRow,
  type AdminJobListRow,
  type ProvisioningJobKind,
  type ProvisioningJobStatus,
} from "../provisioning/provisioning-jobs.repository";
import { TenantsRepository } from "../tenants/tenants.repository";
import {
  QueueInspector,
  queueOwnerOf,
  type FailedQueueJobList,
  type InspectedJobState,
  type QueueList,
} from "./queue-inspector";

export type AdminProvisioningJob = components["schemas"]["AdminProvisioningJob"];
export type AdminProvisioningJobList = components["schemas"]["AdminProvisioningJobList"];
export type AdminProvisioningJobDetail = components["schemas"]["AdminProvisioningJobDetail"];
export type AdminProvisioningJobResult = components["schemas"]["AdminProvisioningJobResult"];
export type AdminReasonRequest = components["schemas"]["AdminReasonRequest"];
export type { FailedQueueJobList, QueueList };

/** The query of `adminListProvisioningJobs`, as the validation interceptor coerced it (`limit` defaults to 50). */
export interface ListProvisioningJobsQuery {
  readonly status?: ProvisioningJobStatus | undefined;
  readonly kind?: ProvisioningJobKind | undefined;
  readonly tenantId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The page size without `limit` (the document's default), for the job list and the failed queue jobs. */
export const DEFAULT_ADMIN_PAGE_LIMIT = 50;

/** The job kinds of the API (`ProvisioningJobKind`, PADR-0001 item 8); the other kinds of the table are post-MVP. */
export const ADMIN_JOB_KINDS: readonly ProvisioningJobKind[] = Object.freeze([
  "provision",
  "migrate",
  "suspend",
  "resume",
]);

const ADMIN_KINDS: ReadonlySet<string> = new Set(ADMIN_JOB_KINDS);

/** The unique index that allows one active job of each kind per tenant (migration 0001). */
const ACTIVE_JOB_UNIQUE_INDEX = "provisioning_jobs_active_uq";

/** PostgreSQL's SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

/** True when `error` is the unique violation of a second active job of one kind for a tenant. */
function isActiveJobConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === ACTIVE_JOB_UNIQUE_INDEX;
}

/** An opaque cursor: base64url of `{"id": "<job id>"}`, the last job of the page. */
export function encodeJobCursor(jobId: string): string {
  return Buffer.from(JSON.stringify({ id: jobId }), "utf8").toString("base64url");
}

const JOB_ID = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The job id of a cursor of this list, or `undefined` when it is not one. */
export function decodeJobCursor(cursor: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const id: unknown = (value as Record<string, unknown>)["id"];
    return Object.keys(value).length === 1 && typeof id === "string" && JOB_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function invalidCursor(): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "Is not a cursor of this list." }],
  });
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names that hold a ciphertext (`reveal_ciphertext`, `clientSecretCiphertext`, …): never answered. */
const CIPHERTEXT_KEY = /ciphertext/i;

/**
 * A copy of `value` without any key, at any depth, whose name holds `ciphertext`: what the job detail answers of a
 * `payload` or a `result`. (The shared redactor is not applied: it would hide `apiKeyIds`, ids the page must show.)
 */
export function withoutCiphertexts(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const strip = (entry: unknown): unknown => {
    if (Array.isArray(entry)) {
      return entry.map(strip);
    }
    if (isRecord(entry)) {
      return Object.fromEntries(
        Object.entries(entry)
          .filter(([key]) => !CIPHERTEXT_KEY.test(key))
          .map(([key, nested]) => [key, strip(nested)]),
      );
    }
    return entry;
  };
  return strip(value) as Record<string, unknown>;
}

/** The `AdminProvisioningJob` of a job row: the error at most 1,000 characters long. */
export function toAdminProvisioningJob(row: AdminJobListRow): AdminProvisioningJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantKey: row.tenant_key,
    kind: row.kind as AdminProvisioningJob["kind"],
    status: row.status,
    step: row.step,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    error: row.error === null ? null : row.error.slice(0, MAX_JOB_ERROR_LENGTH),
    scheduledAt: row.scheduled_at.toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

/** The `AdminProvisioningJobDetail` of a job row and the BullMQ state of its current attempt. */
export function toAdminProvisioningJobDetail(
  row: AdminJobDetailRow,
  bullmqState: InspectedJobState | null,
): AdminProvisioningJobDetail {
  return {
    ...toAdminProvisioningJob(row),
    steps: stepLog(row.steps).map((entry) => ({
      step: entry.step,
      status: entry.status,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      ...(entry.error === undefined
        ? {}
        : { error: { code: entry.error.code, message: entry.error.message.slice(0, MAX_JOB_ERROR_LENGTH) } }),
    })),
    payload: isRecord(row.payload) ? withoutCiphertexts(row.payload) : {},
    result: isRecord(row.result) ? withoutCiphertexts(row.result) : null,
    lockedUntil: row.status === "running" ? iso(row.locked_until) : null,
    bullmqState,
  };
}

/** A queue name of either backend, or `404 NOT_FOUND`. */
function knownQueue(name: string): { readonly name: QueueName; readonly owner: "platform" | "ota" } {
  const owner = queueOwnerOf(name);
  if (owner === undefined) {
    throw new AppError("NOT_FOUND");
  }
  return { name: name as QueueName, owner };
}

@Injectable()
export class AdminJobsService {
  constructor(
    private readonly jobs: ProvisioningJobsRepository,
    private readonly tenants: TenantsRepository,
    private readonly dispatcher: ProvisioningDispatcher,
    private readonly queues: QueueInspector,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(AdminJobsService.name) private readonly logger: PinoLogger,
  ) {}

  /** adminListProvisioningJobs (see the file header). */
  async list(query: ListProvisioningJobsQuery): Promise<AdminProvisioningJobList> {
    const limit = query.limit ?? DEFAULT_ADMIN_PAGE_LIMIT;
    let afterJobId: string | undefined;
    if (query.cursor !== undefined) {
      afterJobId = decodeJobCursor(query.cursor);
      if (afterJobId === undefined || !(await this.jobs.exists(afterJobId))) {
        throw invalidCursor();
      }
    }
    const rows = await this.jobs.listForAdmin(
      { kinds: ADMIN_JOB_KINDS, status: query.status, kind: query.kind, tenantId: query.tenantId },
      afterJobId,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAdminProvisioningJob),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeJobCursor(last.id) : null,
        limit,
      },
    };
  }

  /** adminGetProvisioningJob (see the file header). */
  async get(jobId: string): Promise<AdminProvisioningJobDetail> {
    const row = await this.jobs.findForAdmin(jobId);
    if (row === undefined || !ADMIN_KINDS.has(row.kind)) {
      throw new AppError("NOT_FOUND");
    }
    return toAdminProvisioningJobDetail(row, await this.bullmqStateOf(row));
  }

  /** adminRetryProvisioningJob by the admin of `claims` (see the file header). */
  async retry(claims: Pick<AccessTokenClaims, "sub">, jobId: string): Promise<AdminProvisioningJobResult> {
    let created: { readonly jobId: string; readonly tenantId: string };
    try {
      created = await runInTransaction(this.db, async (trx) => {
        const job = await this.jobs.lockForAdmin(trx, jobId);
        if (job === undefined || !ADMIN_KINDS.has(job.kind)) {
          throw new AppError("NOT_FOUND");
        }
        if (job.status !== "failed") {
          throw new AppError("PROVISIONING_NOT_RETRYABLE", {
            details: { reason: "not_failed", status: job.status },
          });
        }
        const now = this.clock.now();
        let tenantStatus = job.tenant_status;
        if (job.kind === "provision") {
          const tenant = await this.tenants.lockForUpdate(trx, job.tenant_id);
          if (
            tenant === undefined ||
            tenant.status !== "failed" ||
            !(await this.tenants.reopenFailed(trx, job.tenant_id, now))
          ) {
            throw new AppError("PROVISIONING_NOT_RETRYABLE", {
              details: { reason: "tenant_not_failed", tenantStatus: tenant?.status ?? job.tenant_status },
            });
          }
          tenantStatus = "provisioning";
          this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: job.tenant_id });
        }
        const next = await this.jobs.insertQueued(trx, {
          id: this.ids.new("job"),
          tenantId: job.tenant_id,
          kind: job.kind,
          requestedByAccountId: claims.sub,
          now,
          payload: isRecord(job.payload) ? job.payload : {},
        });
        await this.audit.record(trx, {
          actorType: "platform_admin",
          actorAccountId: claims.sub,
          action: "provisioning_job.retried",
          targetType: "provisioning_job",
          targetId: next.id,
          tenantId: job.tenant_id,
          tenantKey: job.tenant_key,
          ...(job.kind === "provision"
            ? { before: { tenantStatus: job.tenant_status }, after: { tenantStatus } }
            : {}),
          details: {
            kind: job.kind,
            previousJobId: job.id,
            previousAttempt: job.attempt,
            previousError: job.error,
          },
        });
        return { jobId: next.id, tenantId: job.tenant_id };
      });
    } catch (error) {
      if (isActiveJobConflict(error)) {
        throw new AppError("PROVISIONING_NOT_RETRYABLE", { cause: error, details: { reason: "job_active" } });
      }
      throw error;
    }
    await this.dispatchQuietly(created.jobId, created.tenantId);
    return { job: await this.jobOf(created.jobId) };
  }

  /** adminCancelProvisioningJob by the admin of `claims`, with the request's reason (see the file header). */
  async cancel(
    claims: Pick<AccessTokenClaims, "sub">,
    jobId: string,
    request: AdminReasonRequest,
  ): Promise<AdminProvisioningJobResult> {
    return runInTransaction(this.db, async (trx) => {
      const job = await this.jobs.lockForAdmin(trx, jobId);
      if (job === undefined || !ADMIN_KINDS.has(job.kind)) {
        throw new AppError("NOT_FOUND");
      }
      const now = this.clock.now();
      if (job.status !== "queued" || !(await this.jobs.markCanceled(trx, { jobId, now }))) {
        throw new AppError("CONFLICT", { details: { reason: "not_queued", status: job.status } });
      }
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "provisioning_job.canceled",
        targetType: "provisioning_job",
        targetId: job.id,
        tenantId: job.tenant_id,
        tenantKey: job.tenant_key,
        before: { status: job.status },
        after: { status: "canceled" },
        details: { kind: job.kind, attempt: job.attempt, reason: request.reason },
      });
      return { job: await this.jobOf(job.id, trx) };
    });
  }

  /** adminListQueues (see the file header). */
  listQueues(): Promise<QueueList> {
    return this.queues.listQueues();
  }

  /** adminListFailedQueueJobs (see the file header). */
  listFailedQueueJobs(queue: string, limit: number | undefined): Promise<FailedQueueJobList> {
    return this.queues.listFailed(knownQueue(queue).name, limit ?? DEFAULT_ADMIN_PAGE_LIMIT);
  }

  /** adminRetryQueueJob by the admin of `claims` (see the file header). */
  async retryQueueJob(claims: Pick<AccessTokenClaims, "sub">, queue: string, jobId: string): Promise<void> {
    const { name, owner } = knownQueue(queue);
    if (owner !== "platform") {
      throw new AppError("FORBIDDEN", { details: { reason: "ota_queue" } });
    }
    const job = await this.queues.failedJob(name, jobId);
    if (job === undefined) {
      throw new AppError("NOT_FOUND");
    }
    await runInTransaction(this.db, async (trx) => {
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "queue_job.retried",
        targetType: "queue_job",
        targetId: `${name}:${jobId}`,
        details: {
          queue: name,
          jobId,
          name: job.name,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
        },
      });
      // Last in the transaction: a retry that fails rolls the audit row back.
      if (!(await this.queues.retry(name, job))) {
        throw new AppError("NOT_FOUND");
      }
    });
  }

  /** The job as the admin lists it, read on `db` (the pool, or the caller's transaction). */
  private async jobOf(
    jobId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<AdminProvisioningJob> {
    const row = await this.jobs.findForAdmin(jobId, db);
    if (row === undefined) {
      throw new Error("AdminJobsService: the job written in this request cannot be read back");
    }
    return toAdminProvisioningJob(row);
  }

  /** `bullmqState` of the detail: `null` before the first dispatch, `unknown` when Redis cannot be asked. */
  private async bullmqStateOf(row: AdminJobDetailRow): Promise<InspectedJobState | null> {
    if (row.attempt < 1) {
      return null;
    }
    try {
      return await this.queues.jobState(OTA_TENANT_OPS, bullmqJobId(row.id, row.attempt));
    } catch (error) {
      this.logger.warn({ jobId: row.id, attempt: row.attempt, err: error }, "admin.job_state_unavailable");
      return "unknown";
    }
  }

  /** Dispatches a job queued by this request after its commit; never rejects (the reconciler takes it up). */
  private async dispatchQuietly(jobId: string, tenantId: string): Promise<void> {
    try {
      await this.dispatcher.dispatch(jobId);
    } catch (error) {
      this.logger.warn({ jobId, tenantId, err: error }, "provisioning.dispatch_failed");
    }
  }
}
