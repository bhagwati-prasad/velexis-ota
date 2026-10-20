// The `plans` repository (platform/docs/architecture.md §2.1: BillingModule owns the table). PBE-017 brought the read
// of the pricing page and the create-OTA wizard; PBE-033 the admin's plan management (list with tenant counts, create,
// update, the active-plan check of a manual subscription). The Stripe price links come with PBE-042 (M5). Kysely on
// the API's `PLATFORM_DB` (ADR-0005).
//
// **The version of a plan.** Unlike the other versioned tables, `platform.plans` has no `version` column (migrations
// 0001 and 0002). The version that `adminUpdatePlan` takes in `If-Match` is derived from `updated_at` instead:
// `planVersion(updated_at)`, the instant in epoch milliseconds (`updatedAt` of the answer, as `Date.parse` reads it).
// Every write of a plan goes through `update` here, which moves `updated_at` to
// `GREATEST(now, date_trunc('milliseconds', updated_at) + 1 ms)`: the version grows by at least one on every change,
// also when two changes fall within the same millisecond or the clock stands still (the FakeClock of the tests), so a
// stale `If-Match` never matches again. A writer outside this repository must keep that rule.
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

type PlanTable = Selectable<PlatformDatabase["platform.plans"]>;

/** What `listPlans` reads of a plan. */
export type PublicPlanRow = Pick<
  PlanTable,
  | "code"
  | "name"
  | "description"
  | "currency"
  | "monthly_price"
  | "annual_price"
  | "trial_days"
  | "limits"
  | "features"
  | "stripe_price_id_month"
  | "stripe_price_id_year"
>;

/** What the admin's plan answers read of a plan. */
export type PlanRecord = PublicPlanRow &
  Pick<
    PlanTable,
    | "is_public"
    | "is_active"
    | "sort_order"
    | "settlement_fee_bps"
    | "stripe_product_id"
    | "created_at"
    | "updated_at"
  >;

/** A plan with the number of OTAs on it (`tenants.plan_code`, in any status). */
export type AdminPlanRow = PlanRecord & { readonly tenant_count: number };

/** The columns of a new plan; the others keep their defaults (`is_active`, the Stripe ids, the usage fees). */
export interface NewPlan {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly currency: string;
  /** Decimal strings (conventions §1). */
  readonly monthly_price: string;
  readonly annual_price: string | null;
  /** The JSON text of `limits` and `features` (jsonb columns are written as JSON text). */
  readonly limitsJson: string;
  readonly featuresJson: string;
  readonly is_public: boolean;
  readonly trial_days: number;
  readonly settlement_fee_bps: number;
  readonly sort_order: number;
  /** The time of the creation: `created_at` and `updated_at`. */
  readonly now: Date;
}

/** The columns an admin may change (never `code` or `currency`); `limits` and `features` as JSON text. */
export interface PlanChanges {
  name?: string;
  description?: string | null;
  monthly_price?: string;
  annual_price?: string | null;
  limitsJson?: string;
  featuresJson?: string;
  is_public?: boolean;
  is_active?: boolean;
  trial_days?: number;
  settlement_fee_bps?: number;
  sort_order?: number;
}

/** The columns of PlanRecord, as every admin read selects them. */
const PLAN_RECORD_COLUMNS = [
  "p.code",
  "p.name",
  "p.description",
  "p.currency",
  "p.monthly_price",
  "p.annual_price",
  "p.trial_days",
  "p.limits",
  "p.features",
  "p.stripe_price_id_month",
  "p.stripe_price_id_year",
  "p.is_public",
  "p.is_active",
  "p.sort_order",
  "p.settlement_fee_bps",
  "p.stripe_product_id",
  "p.created_at",
  "p.updated_at",
] as const;

/**
 * The optimistic-locking version of a plan: its `updated_at` in epoch milliseconds (see the file header). `Date`
 * holds milliseconds, so the digits beyond them that PostgreSQL may store are not part of it.
 */
export function planVersion(updatedAt: Date): number {
  return updatedAt.getTime();
}

@Injectable()
export class PlansRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** The public, active plans in `sort_order` (then `code`, so the order is stable). */
  async listPublicActive(): Promise<PublicPlanRow[]> {
    return this.db
      .selectFrom("platform.plans")
      .select([
        "code",
        "name",
        "description",
        "currency",
        "monthly_price",
        "annual_price",
        "trial_days",
        "limits",
        "features",
        "stripe_price_id_month",
        "stripe_price_id_year",
      ])
      .where("is_public", "=", true)
      .where("is_active", "=", true)
      .orderBy("sort_order")
      .orderBy("code")
      .execute();
  }

  /** Every plan, public or not, active or retired, in `sort_order` then `code`, with its tenant count. */
  async listWithTenantCounts(): Promise<AdminPlanRow[]> {
    return this.withTenantCounts(this.db).orderBy("p.sort_order").orderBy("p.code").execute();
  }

  /** The plan `code` with its tenant count, read on `db`; `undefined` when there is none. */
  async findWithTenantCount(
    code: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<AdminPlanRow | undefined> {
    return this.withTenantCounts(db).where("p.code", "=", code).executeTakeFirst();
  }

  /** The plan `code`, locked for the rest of the caller's transaction (`FOR UPDATE`). */
  async lockForUpdate(trx: PlatformTransaction, code: string): Promise<PlanRecord | undefined> {
    return trx
      .selectFrom("platform.plans as p")
      .select(PLAN_RECORD_COLUMNS)
      .where("p.code", "=", code)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Inserts a new, active plan in `trx` unless a plan with its code exists (`ON CONFLICT (code) DO NOTHING`, so of two
   * concurrent creations of one code, one inserts and the other gets `false`). True when this call inserted it.
   */
  async insertIfNew(trx: PlatformTransaction, plan: NewPlan): Promise<boolean> {
    const row = await trx
      .insertInto("platform.plans")
      .values({
        code: plan.code,
        name: plan.name,
        description: plan.description,
        currency: plan.currency,
        monthly_price: plan.monthly_price,
        annual_price: plan.annual_price,
        limits: plan.limitsJson,
        features: plan.featuresJson,
        is_public: plan.is_public,
        is_active: true,
        trial_days: plan.trial_days,
        settlement_fee_bps: plan.settlement_fee_bps,
        sort_order: plan.sort_order,
        created_at: plan.now,
        updated_at: plan.now,
      })
      .onConflict((conflict) => conflict.column("code").doNothing())
      .returning("code")
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Writes `changes` to the plan `code` (locked by `lockForUpdate`) in `trx` and moves `updated_at`, and so the
   * plan's version, forward by at least one millisecond (see the file header).
   */
  async update(trx: PlatformTransaction, code: string, changes: PlanChanges, now: Date): Promise<void> {
    const { limitsJson, featuresJson, ...columns } = changes;
    await trx
      .updateTable("platform.plans")
      .set({
        ...columns,
        ...(limitsJson === undefined ? {} : { limits: limitsJson }),
        ...(featuresJson === undefined ? {} : { features: featuresJson }),
        updated_at: sql<Date>`GREATEST(${now}::timestamptz, date_trunc('milliseconds', updated_at) + interval '1 millisecond')`,
      })
      .where("code", "=", code)
      .executeTakeFirstOrThrow();
  }

  /** True when `code` names a plan that is not retired (`is_active`), public or not. */
  async isActive(code: string, db: PlatformDb | PlatformTransaction = this.db): Promise<boolean> {
    const row = await db
      .selectFrom("platform.plans")
      .select("code")
      .where("code", "=", code)
      .where("is_active", "=", true)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** True when `code` is a currency of `reference.currencies` (billing reads the reference data directly). */
  async currencyExists(code: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("reference.currencies")
      .select("code")
      .where("code", "=", code)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The admin reads of plans: every PlanRecord column and the plan's tenant count. */
  private withTenantCounts(db: PlatformDb | PlatformTransaction) {
    return db
      .selectFrom("platform.plans as p")
      .select(PLAN_RECORD_COLUMNS)
      .select(
        sql<number>`(SELECT count(*) FROM platform.tenants t WHERE t.plan_code = p.code)::int`.as(
          "tenant_count",
        ),
      );
  }
}
