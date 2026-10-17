// The `subscriptions` repository (platform/docs/architecture.md §2.1: BillingModule owns the table). This task brings
// the read of `getSubscription`; the manual trial of a new OTA (PBE-018) and the Stripe Billing sync (M5) add their
// writes. Kysely on the API's `PLATFORM_DB` (ADR-0005).
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

/**
 * The statuses of a tenant's current subscription: the `subscriptions_current_uq` index of migration 0002 allows at
 * most one row in them per tenant. `canceled` and `incomplete_expired` rows are history.
 */
export const CURRENT_SUBSCRIPTION_STATUSES = Object.freeze([
  "trialing",
  "active",
  "past_due",
  "paused",
  "incomplete",
  "unpaid",
] as const);

/** A subscription row with its plan's name and the tenant's billing notice. */
export interface SubscriptionRow extends Pick<
  Selectable<PlatformDatabase["platform.subscriptions"]>,
  | "id"
  | "plan_code"
  | "status"
  | "billing_provider"
  | "billing_interval"
  | "trial_ends_at"
  | "current_period_end"
  | "cancel_at_period_end"
> {
  readonly plan_name: string;
  /** `tenants.billing_notice`: `past_due`, `trial_ending` or `null`, kept by billing sync. */
  readonly billing_notice: string | null;
}

@Injectable()
export class SubscriptionsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * The subscription of `tenantId` that the portal shows: the current one, or, when there is none, the latest one
   * (after a cancellation, the canceled one); `undefined` for a tenant without any.
   */
  async findShownForTenant(tenantId: string): Promise<SubscriptionRow | undefined> {
    return this.db
      .selectFrom("platform.subscriptions as s")
      .innerJoin("platform.plans as p", "p.code", "s.plan_code")
      .innerJoin("platform.tenants as t", "t.id", "s.tenant_id")
      .select([
        "s.id",
        "s.plan_code",
        "s.status",
        "s.billing_provider",
        "s.billing_interval",
        "s.trial_ends_at",
        "s.current_period_end",
        "s.cancel_at_period_end",
        "p.name as plan_name",
        "t.billing_notice",
      ])
      .where("s.tenant_id", "=", tenantId)
      .orderBy(sql`CASE WHEN s.status IN (${sql.join(CURRENT_SUBSCRIPTION_STATUSES)}) THEN 0 ELSE 1 END`)
      .orderBy("s.created_at", "desc")
      .orderBy("s.id", "desc")
      .limit(1)
      .executeTakeFirst();
  }
}
