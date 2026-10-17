// The `plans` repository (platform/docs/architecture.md §2.1: BillingModule owns the table). This task brings the read
// of the pricing page and the create-OTA wizard; the admin's plan management and the Stripe price links come with
// PBE-041. Kysely on the API's `PLATFORM_DB` (ADR-0005).
import { Inject, Injectable } from "@nestjs/common";
import type { PlatformDatabase, Selectable } from "@velexis/db";
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
}
