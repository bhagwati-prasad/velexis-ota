// `purge.daily` (PBE-034; platform/docs/architecture.md §5, daily at 02:50 UTC): deletes the platform rows that are past
// their retention, so tables of short-lived records do not grow for ever:
//
// - `account_tokens`: used or expired, 7 days after the use or the expiry;
// - `account_sessions`: expired, 30 days after the expiry;
// - `email_outbox`: `sent`, 30 days after sending;
// - `stripe_events`: `processed`, 90 days after processing;
// - `credential_submissions`: final (`applied`, `failed`, `superseded`), 90 days after finishing;
// - `tenant_domains`: custom domains in `failed`, 7 days after their failure, so the host name is free again
//   (FIX-W39-PLATFORM, lead decision (2g) of 2026-11-02; PADR-0004 item 4). The sub-domain is never deleted.
//
// purge.repository.ts says exactly which rows count. The cut-offs are the Clock's time of the run minus each
// retention. Each table is purged in batches of PURGE_BATCH_SIZE rows, one statement and transaction each, until a
// batch deletes fewer; rows another transaction holds are skipped and go in a later run. At most
// PURGE_MAX_BATCHES batches per table and run (a backlog after a long stop is worked off over a few days instead of
// holding the worker; `purge.capped` says so). `platform_audit_log` is never purged (append-only), and the run writes
// no audit row for those five tables: it is housekeeping of rows past their life, not a change of state anyone made.
//
// A failed custom domain is different: its deletion frees a host name another OTA may claim, and the OTA saw the
// domain in its list. Each one is deleted in a transaction of its own, under the tenant's domain lock with the row
// locked and its conditions checked again (a window `checkDomain` restarted meanwhile keeps the domain), with one
// audit row `domain.removed` (actor `system`, label `purge.daily`; the host name, its status, deadline, last check and
// error code, `details.reason = failed_expired`; never the verification token) and, after the commit, a `domain`
// invalidation for the host (and the sub-domain, when the flag moved back to it from a failed primary domain, as
// `removeDomain` does), so the OTA backend and TLS `ask` forget it. At most PURGE_BATCH_SIZE × PURGE_MAX_BATCHES
// domains per run, like the tables.
//
// The run logs `purge.daily` with the count of every table (never a row's content) and returns the counts, which
// BullMQ keeps with the job. A database failure fails the job, and BullMQ tries again with the defaults of ADR-0009;
// the batches committed before the failure stay done. The worker provides the handler (CommonModule.forWorker), and
// the one processor of `platform-maintenance` runs it (maintenance.processor.ts).
import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AuditService } from "../audit/audit.service";
import { Clock } from "./clock";
import { PLATFORM_DB, type PlatformDb } from "./database";
import {
  PURGE_TABLES,
  PurgeRepository,
  type FailedDomainCandidate,
  type PurgeTable,
} from "./purge.repository";
import { MaintenanceJob, type MaintenanceJobHandler } from "./queues/maintenance.processor";
import { InvalidationPublisher, runInTransaction } from "./redis/invalidation.publisher";

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

/** How long a failed custom domain is kept after its failure (PADR-0004 item 4; FIX-W39-PLATFORM). */
export const FAILED_DOMAIN_RETENTION_MS = 7 * DAY_MS;

/** The `details.reason` of the audit row of a failed custom domain the purge deleted. */
export const FAILED_DOMAIN_PURGE_REASON = "failed_expired";

/** The tables a run deletes from: the five of PURGE_TABLES and the failed custom domains of `tenant_domains`. */
export type PurgedTable = PurgeTable | "tenant_domains";

/** What a finished run returns (BullMQ keeps it with the job): the rows deleted per table. */
export interface PurgeDailyResult {
  readonly deleted: Readonly<Record<PurgedTable, number>>;
}

@Injectable()
@MaintenanceJob(PURGE_DAILY_JOB)
export class PurgeScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly purge: PurgeRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(PurgeScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<PurgeDailyResult> {
    const now = this.clock.now().getTime();
    const deleted: Record<PurgedTable, number> = {
      account_tokens: 0,
      account_sessions: 0,
      email_outbox: 0,
      stripe_events: 0,
      credential_submissions: 0,
      tenant_domains: 0,
    };
    for (const table of PURGE_TABLES) {
      deleted[table] = await this.purgeTable(table, new Date(now - PURGE_RETENTION_MS[table]));
    }
    deleted.tenant_domains = await this.purgeFailedDomains(new Date(now - FAILED_DOMAIN_RETENTION_MS));
    const result: PurgeDailyResult = { deleted };
    this.logger.info({ ...deleted }, "purge.daily");
    return result;
  }

  /**
   * The failed custom domains whose failure is before `cutoff`, each deleted in a transaction of its own (see the file
   * header), batch after batch of candidates until one is short or PURGE_MAX_BATCHES ran. Answers how many it deleted.
   */
  private async purgeFailedDomains(cutoff: Date): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
      const candidates = await this.purge.failedCustomDomains(cutoff, PURGE_BATCH_SIZE);
      let deleted = 0;
      for (const candidate of candidates) {
        if (await this.deleteFailedDomain(candidate, cutoff)) {
          deleted += 1;
        }
      }
      total += deleted;
      // A candidate kept by its second look (its window restarted meanwhile) is not one to read again.
      if (candidates.length < PURGE_BATCH_SIZE || deleted === 0) {
        return total;
      }
    }
    this.logger.warn({ table: "tenant_domains", deleted: total, batches: PURGE_MAX_BATCHES }, "purge.capped");
    return total;
  }

  /**
   * Deletes one failed custom domain in a transaction of its own: the tenant's domain lock, the row locked and checked
   * again, the deletion (and the sub-domain primary again when the domain was primary), the audit row and, after the
   * commit, the `domain` invalidations. Answers whether it deleted the domain.
   */
  private async deleteFailedDomain(candidate: FailedDomainCandidate, cutoff: Date): Promise<boolean> {
    return runInTransaction(this.db, async (trx) => {
      await this.purge.lockTenantDomains(trx, candidate.tenant_id);
      const domain = await this.purge.lockFailedCustomDomain(trx, candidate.id, cutoff);
      if (domain === undefined) {
        return false;
      }
      const now = this.clock.now();
      await this.purge.deleteDomain(trx, domain.id);
      const promoted = domain.is_primary
        ? await this.purge.makeSubdomainPrimary(trx, domain.tenant_id, domain.purpose, now)
        : undefined;
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: PURGE_DAILY_JOB,
        action: "domain.removed",
        targetType: "domain",
        targetId: domain.id,
        tenantId: domain.tenant_id,
        before: {
          hostname: domain.hostname,
          verificationStatus: "failed",
          isPrimary: domain.is_primary,
          verificationDeadlineAt: domain.verification_deadline_at?.toISOString() ?? null,
          lastCheckedAt: domain.last_checked_at?.toISOString() ?? null,
          lastCheckError: domain.last_check_error,
        },
        details: {
          reason: FAILED_DOMAIN_PURGE_REASON,
          retentionDays: FAILED_DOMAIN_RETENTION_MS / DAY_MS,
          ...(promoted === undefined ? {} : { primaryHostname: promoted }),
        },
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: domain.hostname });
      if (promoted !== undefined) {
        this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: promoted });
      }
      return true;
    });
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
