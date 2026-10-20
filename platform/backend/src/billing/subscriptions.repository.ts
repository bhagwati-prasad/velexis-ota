// The `subscriptions` repository (platform/docs/architecture.md §2.1: BillingModule owns the table). PBE-017 brings
// the read of `getSubscription`, PBE-018 the manual trial of a new OTA (ADR-0013 point 4, the path before M5), PBE-033
// the admin's list, detail and manual edit, with the subscription's invoices and its OTA's Stripe events (both empty
// before M5); the Stripe Billing sync (M5) adds its writes. Kysely on the API's `PLATFORM_DB` (ADR-0005).
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

type SubscriptionTable = Selectable<PlatformDatabase["platform.subscriptions"]>;

/** A subscription row as the admin sees it: its columns, its OTA's key and name, and its plan's name. */
export interface AdminSubscriptionRow extends Pick<
  SubscriptionTable,
  | "id"
  | "tenant_id"
  | "plan_code"
  | "status"
  | "billing_provider"
  | "billing_interval"
  | "trial_ends_at"
  | "current_period_start"
  | "current_period_end"
  | "cancel_at_period_end"
  | "canceled_at"
  | "provider_customer_id"
  | "provider_subscription_id"
  | "created_at"
  | "version"
> {
  readonly tenant_key: string;
  readonly tenant_name: string;
  readonly plan_name: string;
}

/** The filters of the admin's subscription list. */
export interface AdminSubscriptionFilter {
  readonly status?: string | undefined;
  readonly provider?: string | undefined;
  readonly planCode?: string | undefined;
}

/** What the manual edit reads of the locked row. */
export type LockedSubscription = Pick<
  SubscriptionTable,
  | "id"
  | "tenant_id"
  | "plan_code"
  | "status"
  | "billing_provider"
  | "trial_ends_at"
  | "canceled_at"
  | "version"
>;

/** The columns an admin may change on a manual subscription. */
export interface ManualSubscriptionChanges {
  plan_code?: string;
  trial_ends_at?: Date;
  status?: string;
  canceled_at?: Date | null;
}

/** An invoice row of a subscription's history (`platform.invoices`, synchronised from Stripe in M5). */
export type InvoiceRow = Pick<
  Selectable<PlatformDatabase["platform.invoices"]>,
  | "id"
  | "tenant_id"
  | "subscription_id"
  | "number"
  | "status"
  | "currency"
  | "subtotal"
  | "tax_amount"
  | "total"
  | "amount_paid"
  | "amount_due"
  | "period_start"
  | "period_end"
  | "issued_at"
  | "due_at"
  | "paid_at"
  | "hosted_invoice_url"
  | "invoice_pdf_url"
  | "provider_invoice_id"
  | "created_at"
>;

/** A Stripe event of the webhook inbox (`platform.stripe_events`, M5): ids, type and state, never a payload. */
export type StripeEventRow = Pick<
  Selectable<PlatformDatabase["platform.stripe_events"]>,
  | "id"
  | "endpoint"
  | "type"
  | "status"
  | "attempts"
  | "last_error"
  | "tenant_id"
  | "received_at"
  | "processed_at"
>;

/** The unique index that allows one current subscription per tenant (migration 0002). */
export const CURRENT_SUBSCRIPTION_INDEX = "subscriptions_current_uq";

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
   * (after a cancellation, the canceled one); `undefined` for a tenant without any. Read on `db`: the pool, or the
   * caller's transaction (PBE-030: the resume of a billing suspension reads it under the tenant's row lock).
   */
  async findShownForTenant(
    tenantId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<SubscriptionRow | undefined> {
    return db
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

  /**
   * One page of the admin's subscription list, newest first (`created_at`, then id), after the subscription `afterId`
   * when given; `limit` rows at most. The keyset compares with the row's stored `created_at`, so no precision is lost
   * in the cursor.
   */
  async listAdmin(
    filter: AdminSubscriptionFilter,
    afterId: string | undefined,
    limit: number,
  ): Promise<AdminSubscriptionRow[]> {
    let query = this.adminViews(this.db);
    if (filter.status !== undefined) {
      query = query.where("s.status", "=", filter.status);
    }
    if (filter.provider !== undefined) {
      query = query.where("s.billing_provider", "=", filter.provider);
    }
    if (filter.planCode !== undefined) {
      query = query.where("s.plan_code", "=", filter.planCode);
    }
    if (afterId !== undefined) {
      query = query.where(
        sql<boolean>`(s.created_at, s.id) < (SELECT c.created_at, c.id FROM platform.subscriptions c WHERE c.id = ${afterId})`,
      );
    }
    return query.orderBy("s.created_at", "desc").orderBy("s.id", "desc").limit(limit).execute();
  }

  /** True when the subscription `id` exists (a cursor names a subscription of this table). */
  async exists(id: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("platform.subscriptions")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The subscription `id` as the admin sees it, read on `db`; `undefined` when there is none. */
  async findAdmin(
    id: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<AdminSubscriptionRow | undefined> {
    return this.adminViews(db).where("s.id", "=", id).executeTakeFirst();
  }

  /** The subscription `id`, locked for the rest of the caller's transaction (`FOR UPDATE`). */
  async lockForUpdate(trx: PlatformTransaction, id: string): Promise<LockedSubscription | undefined> {
    return trx
      .selectFrom("platform.subscriptions")
      .select([
        "id",
        "tenant_id",
        "plan_code",
        "status",
        "billing_provider",
        "trial_ends_at",
        "canceled_at",
        "version",
      ])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * True when `tenantId` has a current subscription (CURRENT_SUBSCRIPTION_STATUSES) other than `exceptId`, read in
   * `trx`. `subscriptions_current_uq` still refuses a concurrent second one.
   */
  async hasOtherCurrent(trx: PlatformTransaction, tenantId: string, exceptId: string): Promise<boolean> {
    const row = await trx
      .selectFrom("platform.subscriptions")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("id", "<>", exceptId)
      .where("status", "in", CURRENT_SUBSCRIPTION_STATUSES)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Writes the admin's `changes` to the manual subscription `id` (locked by `lockForUpdate`) in `trx`, with
   * `version + 1` and `updated_at = now`. A second current subscription of the tenant fails on
   * `subscriptions_current_uq` (CURRENT_SUBSCRIPTION_INDEX).
   */
  async updateManual(
    trx: PlatformTransaction,
    id: string,
    changes: ManualSubscriptionChanges,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("platform.subscriptions")
      .set({ ...changes, version: sql<number>`version + 1`, updated_at: now })
      .where("id", "=", id)
      .where("billing_provider", "=", "manual")
      .executeTakeFirstOrThrow();
  }

  /** The invoices of the subscription `id`, newest first (`created_at`, then id), `limit` at most. */
  async invoicesOf(id: string, limit: number): Promise<InvoiceRow[]> {
    return this.db
      .selectFrom("platform.invoices")
      .select([
        "id",
        "tenant_id",
        "subscription_id",
        "number",
        "status",
        "currency",
        "subtotal",
        "tax_amount",
        "total",
        "amount_paid",
        "amount_due",
        "period_start",
        "period_end",
        "issued_at",
        "due_at",
        "paid_at",
        "hosted_invoice_url",
        "invoice_pdf_url",
        "provider_invoice_id",
        "created_at",
      ])
      .where("subscription_id", "=", id)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
  }

  /**
   * The Stripe events resolved to `tenantId` (the inbox of CommonModule, read only), newest first (`received_at`, then
   * id), `limit` at most.
   */
  async stripeEventsOf(tenantId: string, limit: number): Promise<StripeEventRow[]> {
    return this.db
      .selectFrom("platform.stripe_events")
      .select([
        "id",
        "endpoint",
        "type",
        "status",
        "attempts",
        "last_error",
        "tenant_id",
        "received_at",
        "processed_at",
      ])
      .where("tenant_id", "=", tenantId)
      .orderBy("received_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
  }

  /** The admin reads of subscriptions: the row with its OTA's key and name and its plan's name. */
  private adminViews(db: PlatformDb | PlatformTransaction) {
    return db
      .selectFrom("platform.subscriptions as s")
      .innerJoin("platform.tenants as t", "t.id", "s.tenant_id")
      .innerJoin("platform.plans as p", "p.code", "s.plan_code")
      .select([
        "s.id",
        "s.tenant_id",
        "s.plan_code",
        "s.status",
        "s.billing_provider",
        "s.billing_interval",
        "s.trial_ends_at",
        "s.current_period_start",
        "s.current_period_end",
        "s.cancel_at_period_end",
        "s.canceled_at",
        "s.provider_customer_id",
        "s.provider_subscription_id",
        "s.created_at",
        "s.version",
        "t.key as tenant_key",
        "t.name as tenant_name",
        "p.name as plan_name",
      ]);
  }
}
