// The deletes of `purge.daily` (purge.scheduler.ts, PBE-034; platform/docs/architecture.md §5): one method that deletes
// at most `limit` rows of one table past a cut-off, for the five tables whose rows have a retention. Kysely on the
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
import { Inject, Injectable } from "@nestjs/common";
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
