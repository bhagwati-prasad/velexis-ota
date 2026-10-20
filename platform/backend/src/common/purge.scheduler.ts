// `purge.daily` (PBE-034; platform/docs/architecture.md §5, daily at 02:50 UTC): deletes the platform rows that are past
// their retention, so tables of short-lived records do not grow for ever:
//
// - `account_tokens`: used or expired, 7 days after the use or the expiry;
// - `account_sessions`: expired, 30 days after the expiry;
// - `email_outbox`: `sent`, 30 days after sending;
// - `stripe_events`: `processed`, 90 days after processing;
// - `credential_submissions`: final (`applied`, `failed`, `superseded`), 90 days after finishing.
//
// purge.repository.ts says exactly which rows count. The cut-offs are the Clock's time of the run minus each
// retention. Each table is purged in batches of PURGE_BATCH_SIZE rows, one statement and transaction each, until a
// batch deletes fewer; rows another transaction holds are skipped and go in a later run. At most
// PURGE_MAX_BATCHES batches per table and run (a backlog after a long stop is worked off over a few days instead of
// holding the worker; `purge.capped` says so). `platform_audit_log` is never purged (append-only), and the run writes
// no audit row: it is housekeeping of rows past their life, not a change of state anyone made.
//
// The run logs `purge.daily` with the count of every table (never a row's content) and returns the counts, which
// BullMQ keeps with the job. A database failure fails the job, and BullMQ tries again with the defaults of ADR-0009;
// the batches committed before the failure stay done. The worker provides the handler (CommonModule.forWorker), and
// the one processor of `platform-maintenance` runs it (maintenance.processor.ts).
import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "./clock";
import { PURGE_TABLES, PurgeRepository, type PurgeTable } from "./purge.repository";
import { MaintenanceJob, type MaintenanceJobHandler } from "./queues/maintenance.processor";

/** The schedule and job name (scheduler.registry.ts). */
export const PURGE_DAILY_JOB = "purge.daily";

/** The rows one statement deletes at most. */
export const PURGE_BATCH_SIZE = 1000;

/** The batches per table and run at most (one million rows). */
export const PURGE_MAX_BATCHES = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long each table keeps a row after its use, expiry, sending, processing or end (architecture §5). */
export const PURGE_RETENTION_MS: Readonly<Record<PurgeTable, number>> = Object.freeze({
  account_tokens: 7 * DAY_MS,
  account_sessions: 30 * DAY_MS,
  email_outbox: 30 * DAY_MS,
  stripe_events: 90 * DAY_MS,
  credential_submissions: 90 * DAY_MS,
});

/** What a finished run returns (BullMQ keeps it with the job): the rows deleted per table. */
export interface PurgeDailyResult {
  readonly deleted: Readonly<Record<PurgeTable, number>>;
}

@Injectable()
@MaintenanceJob(PURGE_DAILY_JOB)
export class PurgeScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly purge: PurgeRepository,
    private readonly clock: Clock,
    @InjectPinoLogger(PurgeScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<PurgeDailyResult> {
    const now = this.clock.now().getTime();
    const deleted: Record<PurgeTable, number> = {
      account_tokens: 0,
      account_sessions: 0,
      email_outbox: 0,
      stripe_events: 0,
      credential_submissions: 0,
    };
    for (const table of PURGE_TABLES) {
      deleted[table] = await this.purgeTable(table, new Date(now - PURGE_RETENTION_MS[table]));
    }
    const result: PurgeDailyResult = { deleted };
    this.logger.info({ ...deleted }, "purge.daily");
    return result;
  }

  /** The batches of one table, until one deletes fewer than PURGE_BATCH_SIZE rows or PURGE_MAX_BATCHES ran. */
  private async purgeTable(table: PurgeTable, cutoff: Date): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
      const count = await this.purge.deleteBatch(table, cutoff, PURGE_BATCH_SIZE);
      total += count;
      if (count < PURGE_BATCH_SIZE) {
        return total;
      }
    }
    this.logger.warn({ table, deleted: total, batches: PURGE_MAX_BATCHES }, "purge.capped");
    return total;
  }
}
