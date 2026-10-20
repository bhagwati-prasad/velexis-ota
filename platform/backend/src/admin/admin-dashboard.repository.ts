// The counters of the platform admin's dashboard (PBE-029; platform/docs/api-inventory-admin.md §2 `adminGetDashboard`):
// read-only counts over `tenants`, `provisioning_jobs`, `tenant_domains`, `settlements`, `stripe_events` and
// `subscriptions` (the `x-platform-tables` of the operation), on the caller's transaction (AdminDashboardService opens
// one read-only snapshot, conventions §2: repositories never open transactions). Kysely, schema-qualified tables
// (ADR-0005).
//
// They are counted here rather than through each owner's repository, as the onboarding checklist reads its facts
// (PBE-024): the dashboard is one snapshot of the whole platform and changes nothing, the counts are aggregates that
// no owner's use case needs, and two of the owners' repositories do not exist yet (SettlementsModule and CommonModule's
// Stripe event inbox, architecture §2.1, come with M5). Nothing here reads a row's content: only `count(*)`. The office
// pool levels come through their owner (AmadeusAccountsRepository.officeCounts).
import { Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../audit/audit.repository";
import { MEMBER_VISIBLE_TENANT_STATUSES, type TenantStatus } from "../common/auth/tenant-role.guard";
import type { PlatformDb } from "../common/database";

type Reader = PlatformDb | PlatformTransaction;

/** The number of OTAs in each status of `TenantStatus`, zero included. */
export type TenantStatusCounts = Record<TenantStatus, number>;

const count = (value: string | number | bigint): number => Number(value);

@Injectable()
export class AdminDashboardRepository {
  /** The OTAs by status, for every status of `TenantStatus` (zero when none); other statuses are not counted. */
  async tenantsByStatus(db: Reader): Promise<TenantStatusCounts> {
    const rows = await db
      .selectFrom("platform.tenants")
      .select((eb) => ["status", eb.fn.countAll<string>().as("count")])
      .where("status", "in", MEMBER_VISIBLE_TENANT_STATUSES)
      .groupBy("status")
      .execute();
    const counts = Object.fromEntries(MEMBER_VISIBLE_TENANT_STATUSES.map((status) => [status, 0])) as Record<
      TenantStatus,
      number
    >;
    for (const row of rows) {
      counts[row.status as TenantStatus] = count(row.count);
    }
    return counts;
  }

  /** Tenant jobs of any kind that ended `failed` at or after `since`. */
  async jobsFailedSince(db: Reader, since: Date): Promise<number> {
    const row = await db
      .selectFrom("platform.provisioning_jobs")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("status", "=", "failed")
      .where("finished_at", ">=", since)
      .executeTakeFirstOrThrow();
    return count(row.count);
  }

  /** Custom domains waiting for their DNS verification (`kind = 'custom'`, `verification_status = 'pending'`). */
  async customDomainsPending(db: Reader): Promise<number> {
    const row = await db
      .selectFrom("platform.tenant_domains")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("kind", "=", "custom")
      .where("verification_status", "=", "pending")
      .executeTakeFirstOrThrow();
    return count(row.count);
  }

  /** Settlements in `draft`, waiting for an admin's review. */
  async draftSettlements(db: Reader): Promise<number> {
    const row = await db
      .selectFrom("platform.settlements")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("status", "=", "draft")
      .executeTakeFirstOrThrow();
    return count(row.count);
  }

  /** Stripe events whose processing failed (`status = 'failed'`), of both webhook endpoints. */
  async failedStripeEvents(db: Reader): Promise<number> {
    const row = await db
      .selectFrom("platform.stripe_events")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("status", "=", "failed")
      .executeTakeFirstOrThrow();
    return count(row.count);
  }

  /** Subscriptions in `past_due`. */
  async pastDueSubscriptions(db: Reader): Promise<number> {
    const row = await db
      .selectFrom("platform.subscriptions")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("status", "=", "past_due")
      .executeTakeFirstOrThrow();
    return count(row.count);
  }
}
