// The `subscriptions` repository (platform/docs/architecture.md §2.1: BillingModule owns the table). PBE-017 brings
// the read of `getSubscription`, PBE-018 the manual trial of a new OTA (ADR-0013 point 4, the path before M5); the
// Stripe Billing sync (M5) adds its writes. Kysely on the API's `PLATFORM_DB` (ADR-0005).
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
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

/** The manual trial of a new OTA. */
export interface NewManualTrial {
  /** `sub_…`. */
  readonly id: string;
  readonly tenantId: string;
  /** The plan of the trial (`early_access` before M5); its `trial_days` set the end of the trial. */
  readonly planCode: string;
  /** The time of the creation: the start of the trial, `created_at` and `updated_at`. */
  readonly now: Date;
}

/** The manual trial as written. */
export interface ManualTrialRow {
  readonly id: string;
  readonly plan_code: string;
  readonly status: string;
  readonly billing_provider: string;
  readonly trial_ends_at: Date | null;
}

@Injectable()
export class SubscriptionsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * Inserts the subscription of a new OTA before M5 in `trx`, in one statement that reads the plan: `trialing`,
   * `billing_provider = 'manual'` (nobody bills it), monthly, `trial_ends_at = now + plans.trial_days` days, no provider
   * ids (ADR-0013 point 4). Throws when `planCode` names no plan, so the caller's transaction rolls back; a second
   * current subscription of the tenant fails on `subscriptions_current_uq`.
   *
   * A trial day is 24 hours, as Stripe counts `trial_period_days`: `make_interval(days => …)` on a `timestamptz` would
   * count calendar days in the session's `TimeZone`, so the end would move by an hour across a summer-time change
   * wherever the server's zone is not UTC.
   */
  async insertManualTrial(trx: PlatformTransaction, trial: NewManualTrial): Promise<ManualTrialRow> {
    const row = await trx
      .insertInto("platform.subscriptions")
      .columns([
        "id",
        "tenant_id",
        "plan_code",
        "status",
        "billing_interval",
        "billing_provider",
        "trial_ends_at",
        "created_at",
        "updated_at",
      ])
      .expression(
        trx
          .selectFrom("platform.plans as p")
          .select([
            sql<string>`${trial.id}::text`.as("id"),
            sql<string>`${trial.tenantId}::text`.as("tenant_id"),
            "p.code as plan_code",
            sql<string>`'trialing'::text`.as("status"),
            sql<string>`'month'::text`.as("billing_interval"),
            sql<string>`'manual'::text`.as("billing_provider"),
            sql<Date>`${trial.now}::timestamptz + make_interval(hours => 24 * p.trial_days)`.as(
              "trial_ends_at",
            ),
            sql<Date>`${trial.now}::timestamptz`.as("created_at"),
            sql<Date>`${trial.now}::timestamptz`.as("updated_at"),
          ])
          .where("p.code", "=", trial.planCode),
      )
      .returning(["id", "plan_code", "status", "billing_provider", "trial_ends_at"])
      .executeTakeFirst();
    if (row === undefined) {
      throw new Error(`insertManualTrial: the plan ${trial.planCode} does not exist`);
    }
    return row;
  }

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
