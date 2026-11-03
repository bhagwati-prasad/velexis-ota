// The deletes of `purge.daily` (purge.scheduler.ts, PBE-034; platform/docs/architecture.md §5): one method that deletes
// at most `limit` rows of one table past a cut-off, for the five tables whose rows have a retention, and the reads and
// writes of the failed custom domains' deletion (FIX-W39-PLATFORM, below). Kysely on the
// process's `PLATFORM_DB` (the worker's pool), schema-qualified tables (ADR-0005). The cut-off is the caller's Clock
// minus the table's retention, never the database's `now()`, so tests move time with the FakeClock.
//
// Which rows of each table are past their retention (the cut-off is `now - retention`):
//
// - `account_tokens`: used (`consumed_at`) or expired (`expires_at`) before the cut-off. A token lives 24 hours at
//   most, so nothing still usable is near a cut-off of 7 days.
// - `account_sessions`: expired (`expires_at`) before the cut-off. Every row's `expires_at` is at most its family's
//   `family_expires_at`, and a family ends at most 30 days after its first row, so when a family's first row (the row
//   `SessionsRepository.lockFamily` locks) is 30 days past its own expiry the whole family ended long ago. Deleting a
//   row clears the `replaced_by_id` of the row before it (`ON DELETE SET NULL`).
// - `email_outbox`: `sent`, and sent (`sent_at`, else `updated_at`) before the cut-off. `pending`, `sending`, `failed`
//   and `canceled` rows stay. The idempotency key of a sent e-mail holds until its row goes (README §4).
// - `stripe_events`: `processed`, and processed (`processed_at`, else `updated_at`) before the cut-off. `received`,
//   `processing`, `ignored` and `failed` rows stay.
// - `credential_submissions`: final (`applied`, `failed`, `superseded`; their secrets are erased already, by the
//   table's check constraint) and finished (`finished_at`, else `updated_at`) before the cut-off. Open submissions
//   stay.
//
// A final row's own time is the one that counts; `updated_at` only stands in for a row that lacks it, and is never
// earlier, so a row is never deleted early. Each call is one statement in its own transaction: it picks the ids
// first (`FOR UPDATE SKIP LOCKED`, so a row another transaction holds, a refresh or a send under way, is left for the
// next run and nothing waits) and deletes them. `platform_audit_log` is never touched: it is append-only, and
// velexis_platform_app has no DELETE on it (migration 0002).
//
// **Failed custom domains** (FIX-W39-PLATFORM, lead decision (2g) of 2026-11-02; PADR-0004 item 4: "failed domains
// older than 7 days are deleted so the host name is free again"): `tenant_domains` rows of `kind = 'custom'` in
// `verification_status = 'failed'` whose failure is older than the cut-off. The failure's time is the check that
// failed the domain (`last_checked_at`: the check past the 72-hour deadline, or the third failed re-check); a later
// check of a failed domain only moves it later, and `updated_at` stands in for a row without a check. The sub-domain
// (`kind = 'subdomain'`) is never deleted. Unlike the five tables above, each domain is its own transaction with an
// audit row and an invalidation (purge.scheduler.ts), so this part reads the candidates (`failedCustomDomains`), then
// per domain takes the tenant's domain lock (the transaction-level advisory lock of the domain writes,
// DomainsRepository.lockTenantDomains, same key) and the row (`lockFailedCustomDomain`, which checks the conditions
// again: a domain whose window `checkDomain` restarted meanwhile is `pending` and stays), deletes it
// (`deleteDomain`) and, for a primary one, moves the flag back to the sub-domain (`makeSubdomainPrimary`), as
// `removeDomain` does.
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "./database";

/** The tables `purge.daily` deletes from, in the order it purges them. */
export const PURGE_TABLES = Object.freeze([
  "account_tokens",
  "account_sessions",
  "email_outbox",
  "stripe_events",
  "credential_submissions",
] as const);

export type PurgeTable = (typeof PURGE_TABLES)[number];

/** The final statuses of `credential_submissions` (migration 0002). */
const FINAL_SUBMISSION_STATUSES = ["applied", "failed", "superseded"] as const;

/** A failed custom domain the purge may delete: its id and tenant (FIX-W39-PLATFORM). */
export interface FailedDomainCandidate {
  readonly id: string;
  readonly tenant_id: string;
}

/** A failed custom domain locked for its deletion, with what the audit row and the invalidation name. */
export interface FailedDomainRow extends FailedDomainCandidate {
  readonly hostname: string;
  readonly purpose: string;
  readonly is_primary: boolean;
  readonly verification_deadline_at: Date | null;
  readonly last_checked_at: Date | null;
  readonly last_check_error: string | null;
}

@Injectable()
export class PurgeRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * Deletes at most `limit` rows of `table` that are past their retention at `cutoff` (see the file header) and
   * returns how many it deleted.
   */
  async deleteBatch(table: PurgeTable, cutoff: Date, limit: number): Promise<number> {
    switch (table) {
      case "account_tokens":
        return this.deleteAccountTokens(cutoff, limit);
      case "account_sessions":
        return this.deleteAccountSessions(cutoff, limit);
      case "email_outbox":
        return this.deleteSentEmails(cutoff, limit);
      case "stripe_events":
        return this.deleteProcessedStripeEvents(cutoff, limit);
      case "credential_submissions":
        return this.deleteFinalSubmissions(cutoff, limit);
    }
  }

  /**
   * At most `limit` failed custom domains whose failure (`last_checked_at`, else `updated_at`) is before `cutoff`,
   * oldest failure first, read on the pool (see the file header). Never a sub-domain.
   */
  async failedCustomDomains(cutoff: Date, limit: number): Promise<FailedDomainCandidate[]> {
    return this.failedCustomDomainQuery(this.db, cutoff)
      .select(["id", "tenant_id"])
      .orderBy((eb) => eb.fn.coalesce("last_checked_at", "updated_at"))
      .orderBy("id")
      .limit(limit)
      .execute();
  }

  /**
   * Waits until no other transaction holds the domain lock of the tenant and holds it until `trx` ends: the
   * transaction-level advisory lock DomainsRepository.lockTenantDomains takes for every domain write (the same key),
   * so the deletion never crosses a primary change or a restarted window.
   */
  async lockTenantDomains(trx: PlatformTransaction, tenantId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`platform.tenant_domains:${tenantId}`}, 0))`.execute(
      trx,
    );
  }

  /**
   * The domain `domainId`, locked (`FOR UPDATE`) in `trx`, while it is still a failed custom domain whose failure is
   * before `cutoff`; `undefined` otherwise (gone, removed, or its window restarted meanwhile).
   */
  async lockFailedCustomDomain(
    trx: PlatformTransaction,
    domainId: string,
    cutoff: Date,
  ): Promise<FailedDomainRow | undefined> {
    return this.failedCustomDomainQuery(trx, cutoff)
      .select([
        "id",
        "tenant_id",
        "hostname",
        "purpose",
        "is_primary",
        "verification_deadline_at",
        "last_checked_at",
        "last_check_error",
      ])
      .where("id", "=", domainId)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Deletes one domain row in `trx`. */
  async deleteDomain(trx: PlatformTransaction, domainId: string): Promise<void> {
    await trx.deleteFrom("platform.tenant_domains").where("id", "=", domainId).execute();
  }

  /**
   * Makes the tenant's sub-domain for `purpose` primary again in `trx` (the purge deleted the primary custom domain);
   * answers its host name, or `undefined` when the tenant has none.
   */
  async makeSubdomainPrimary(
    trx: PlatformTransaction,
    tenantId: string,
    purpose: string,
    now: Date,
  ): Promise<string | undefined> {
    const subdomain = await trx
      .selectFrom("platform.tenant_domains")
      .select(["id", "hostname"])
      .where("tenant_id", "=", tenantId)
      .where("purpose", "=", purpose)
      .where("kind", "=", "subdomain")
      .orderBy("created_at")
      .orderBy("id")
      .forUpdate()
      .executeTakeFirst();
    if (subdomain === undefined) {
      return undefined;
    }
    await trx
      .updateTable("platform.tenant_domains")
      .set({ is_primary: true, updated_at: now })
      .where("id", "=", subdomain.id)
      .execute();
    return subdomain.hostname;
  }

  /** The failed custom domains whose failure is before `cutoff`, on `db`. */
  private failedCustomDomainQuery(db: PlatformDb | PlatformTransaction, cutoff: Date) {
    return db
      .selectFrom("platform.tenant_domains")
      .where("kind", "=", "custom")
      .where("verification_status", "=", "failed")
      .where((row) => row(row.fn.coalesce("last_checked_at", "updated_at"), "<", cutoff));
  }

  private async deleteAccountTokens(cutoff: Date, limit: number): Promise<number> {
    const result = await this.db
      .deleteFrom("platform.account_tokens")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("platform.account_tokens")
          .select("id")
          .where((row) => row.or([row("consumed_at", "<", cutoff), row("expires_at", "<", cutoff)]))
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  private async deleteAccountSessions(cutoff: Date, limit: number): Promise<number> {
    const result = await this.db
      .deleteFrom("platform.account_sessions")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("platform.account_sessions")
          .select("id")
          .where("expires_at", "<", cutoff)
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  private async deleteSentEmails(cutoff: Date, limit: number): Promise<number> {
    const result = await this.db
      .deleteFrom("platform.email_outbox")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("platform.email_outbox")
          .select("id")
          .where("status", "=", "sent")
          .where((row) => row(row.fn.coalesce("sent_at", "updated_at"), "<", cutoff))
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  private async deleteProcessedStripeEvents(cutoff: Date, limit: number): Promise<number> {
    const result = await this.db
      .deleteFrom("platform.stripe_events")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("platform.stripe_events")
          .select("id")
          .where("status", "=", "processed")
          .where((row) => row(row.fn.coalesce("processed_at", "updated_at"), "<", cutoff))
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  private async deleteFinalSubmissions(cutoff: Date, limit: number): Promise<number> {
    const result = await this.db
      .deleteFrom("platform.credential_submissions")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("platform.credential_submissions")
          .select("id")
          .where("status", "in", [...FINAL_SUBMISSION_STATUSES])
          .where((row) => row(row.fn.coalesce("finished_at", "updated_at"), "<", cutoff))
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
