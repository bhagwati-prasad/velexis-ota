// `retention.daily` (OBE-056; ota/docs/data-model.md §6, ota/docs/architecture.md §6, OADR-0014 points 2, 4 and 5, db
// README §6): at 03:35 UTC every day, per tenant (`active` and `suspended`; jobs/schedulers.ts fans it out), one job
// deletes the rows the data model keeps only for a while:
//
//   supplier_requests              older than 90 days (created_at)
//   queue_snapshots                older than 30 days (fetched_at)
//   idempotency_keys               expired (expires_at reached: 24 hours after the request)
//   customer_sessions              expired more than 7 days ago (expires_at)
//   customer_password_resets       expired more than 7 days ago (expires_at)
//   booking_access_tokens          expired more than 7 days ago (expires_at)
//
// in batches of RETENTION_BATCH (1 000) rows, one statement and one short transaction each (retention.repository.ts),
// so no purge holds many locks or writes a large transaction. A job runs at most RETENTION_BATCHES_PER_JOB batches per
// table; a table whose last batch was full asks for more (OADR-0014 point 2), and the runner queues the job again at
// the back of `ota-maintenance`, at most MAX_CONTINUATIONS times per run (fan-out.ts), so a backlog drains over a few
// jobs and, at worst, a few days. Bookings, payments, refunds, booking and payment events, documents, staff actions,
// customers and notifications are never deleted: financial and audit records stay until the tenant is deleted
// (data-model §6). The cut-offs come from `Clock`. The job logs `retention.purged` with the counts per table, never a
// row's content.
import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { TenantJob, type TenantJobHandler, type TenantJobOutcome } from "./fan-out";
import { RetentionRepository } from "./retention.repository";

/** The schedule and job name (jobs/schedulers.ts). */
export const RETENTION_JOB = "retention.daily";

/** The rows one delete statement removes at most (db README §6). */
export const RETENTION_BATCH = 1000;

/**
 * The batches one job runs at most per table (10 000 rows); a table whose last batch was full continues in the next
 * job, so with MAX_CONTINUATIONS a daily run deletes up to 210 000 rows per table and tenant.
 */
export const RETENTION_BATCHES_PER_JOB = 10;

const DAY_MS = 24 * 60 * 60_000;

/** How long each kept-for-a-while row is kept (data-model §6). */
export const RETENTION_PERIODS = Object.freeze({
  /** `supplier_requests`: 90 days after the call. */
  supplierRequestsMs: 90 * DAY_MS,
  /** `queue_snapshots`: 30 days after the read. */
  queueSnapshotsMs: 30 * DAY_MS,
  /** Customer sessions, reset tokens and booking access tokens: 7 days after their expiry. */
  expiredTokensMs: 7 * DAY_MS,
} as const);

/** The tables the purge deletes from, by the name of their count. */
export type RetentionTable =
  | "supplierRequests"
  | "queueSnapshots"
  | "idempotencyKeys"
  | "customerSessions"
  | "passwordResets"
  | "bookingAccessTokens";

/** The rows one job deleted, per table. */
export type RetentionCounts = Readonly<Record<RetentionTable, number>>;

/** One table's delete: at most `limit` rows past the table's limit at `now`. */
type RetentionDelete = (trx: TenantTransaction, now: Date, limit: number) => Promise<number>;

/** The deletes of one run, by table, in the order of data-model §6 (see the file header). */
export function retentionDeletes(
  repository: RetentionRepository,
): Readonly<Record<RetentionTable, RetentionDelete>> {
  const before = (now: Date, ms: number): Date => new Date(now.getTime() - ms);
  return {
    supplierRequests: (trx, now, limit) =>
      repository.supplierRequests(trx, before(now, RETENTION_PERIODS.supplierRequestsMs), limit),
    queueSnapshots: (trx, now, limit) =>
      repository.queueSnapshots(trx, before(now, RETENTION_PERIODS.queueSnapshotsMs), limit),
    idempotencyKeys: (trx, now, limit) => repository.idempotencyKeys(trx, now, limit),
    customerSessions: (trx, now, limit) =>
      repository.customerSessions(trx, before(now, RETENTION_PERIODS.expiredTokensMs), limit),
    passwordResets: (trx, now, limit) =>
      repository.passwordResets(trx, before(now, RETENTION_PERIODS.expiredTokensMs), limit),
    bookingAccessTokens: (trx, now, limit) =>
      repository.bookingAccessTokens(trx, before(now, RETENTION_PERIODS.expiredTokensMs), limit),
  };
}

/** `retention.daily` for one tenant (03:35 UTC daily, fanned out by jobs/fan-out.ts; see the file header). */
@Injectable()
@TenantJob(RETENTION_JOB)
export class RetentionProcessor implements TenantJobHandler {
  private readonly deletes: Readonly<Record<RetentionTable, RetentionDelete>>;

  constructor(
    private readonly tx: TenantTx,
    repository: RetentionRepository,
    private readonly clock: Clock,
    @InjectPinoLogger(RetentionProcessor.name) private readonly logger: PinoLogger,
  ) {
    this.deletes = retentionDeletes(repository);
  }

  /** Up to RETENTION_BATCHES_PER_JOB batches per table for the job's tenant; a full last batch asks for more. */
  async run(tenant: PlatformTenant): Promise<TenantJobOutcome> {
    // One instant for the whole job: its continuations take their own.
    const now = this.clock.now();
    const counts: Record<RetentionTable, number> = {
      supplierRequests: 0,
      queueSnapshots: 0,
      idempotencyKeys: 0,
      customerSessions: 0,
      passwordResets: 0,
      bookingAccessTokens: 0,
    };
    let more = false;
    for (const table of Object.keys(counts) as RetentionTable[]) {
      const remove = this.deletes[table];
      for (let batch = 1; ; batch += 1) {
        const deleted = await this.tx.run((trx) => remove(trx, now, RETENTION_BATCH));
        counts[table] += deleted;
        if (deleted < RETENTION_BATCH) {
          break;
        }
        if (batch >= RETENTION_BATCHES_PER_JOB) {
          more = true;
          break;
        }
      }
    }
    const result: RetentionCounts = counts;
    this.logger.info({ tenantId: tenant.id, ...result, more }, "retention.purged");
    return { more, counts: result };
  }
}
