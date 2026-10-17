// listPlans (platform/docs/api-inventory.md §6; scope PF-70 AC1): the public, active plans for the pricing page and
// the create-OTA wizard, without a token. Money stays a decimal string (conventions §1). `checkoutAvailable` says per
// billing interval whether Stripe Checkout can start: only while Stripe Billing is switched on (FEATURE_STRIPE_BILLING,
// PADR-0015; before M5 Checkout is never available) and when the plan has a Stripe price for that interval.
import { Controller, Get } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { FeatureSwitches } from "../common/features";
import { OpenApiOperation } from "../common/http/openapi-operation.decorator";
import { PlansRepository, type PublicPlanRow } from "./plans.repository";

export type Plan = components["schemas"]["Plan"];
export type PlanList = components["schemas"]["PlanList"];
type PlanLimits = components["schemas"]["PlanLimits"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A quota of `plans.limits`: a whole number of at least 0, or 0 when the plan does not set it. */
function quota(limits: Record<string, unknown>, name: keyof PlanLimits): number {
  const value = limits[name];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The `PlanLimits` of a plan's `limits` column: the four quotas of the schema, a quota the column lacks as 0 (none)
 * and `liveMode` only when it is `true`, so a plan with incomplete limits never grants more than it says.
 */
export function planLimits(limits: unknown): PlanLimits {
  const values = isObject(limits) ? limits : {};
  return {
    staffSeats: quota(values, "staffSeats"),
    apiKeys: quota(values, "apiKeys"),
    customDomains: quota(values, "customDomains"),
    liveMode: values["liveMode"] === true,
  };
}

/** The feature flags of a plan's `features` column: its boolean entries. */
export function planFeatures(features: unknown): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(isObject(features) ? features : {})) {
    if (typeof value === "boolean") {
      flags[name] = value;
    }
  }
  return flags;
}

/** The `Plan` of the OpenAPI document; `checkoutEnabled` is the FEATURE_STRIPE_BILLING switch. */
export function toPlan(row: PublicPlanRow, checkoutEnabled: boolean): Plan {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    monthlyPrice: { amount: row.monthly_price, currency: row.currency },
    annualPrice: row.annual_price === null ? null : { amount: row.annual_price, currency: row.currency },
    trialDays: row.trial_days,
    limits: planLimits(row.limits),
    features: planFeatures(row.features),
    checkoutAvailable: {
      month: checkoutEnabled && row.stripe_price_id_month !== null,
      year: checkoutEnabled && row.stripe_price_id_year !== null,
    },
  };
}

@Controller("v1/plans")
export class PlansController {
  constructor(
    private readonly plans: PlansRepository,
    private readonly switches: FeatureSwitches,
  ) {}

  @Get()
  @OpenApiOperation("listPlans")
  async listPlans(): Promise<PlanList> {
    const checkoutEnabled = this.switches.isEnabled("stripe_billing");
    const rows = await this.plans.listPublicActive();
    return { data: rows.map((row) => toPlan(row, checkoutEnabled)) };
  }
}
