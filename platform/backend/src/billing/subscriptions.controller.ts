// getSubscription (platform/docs/api-inventory-resources.md §6; scope §1.2 "See subscription, plan and invoices"):
// owners and finance members see the OTA's subscription. `banner` is what the portal shows: `canceled` for a canceled
// subscription, `past_due` for one whose payment failed, otherwise the billing notice that billing sync keeps on the
// tenant (`past_due`, `trial_ending`) or nothing. `canManageInStripe` is true only for a Stripe subscription, whose plan,
// card and cancellation live in the Stripe Customer Portal (M5); the manual trials before M5 have none.
import { Controller, Get } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import { SubscriptionsRepository, type SubscriptionRow } from "./subscriptions.repository";

export type Subscription = components["schemas"]["Subscription"];

/** The portal's billing banner of a subscription and its tenant's billing notice. */
export function bannerOf(status: string, billingNotice: string | null): Subscription["banner"] {
  if (status === "canceled") {
    return "canceled";
  }
  if (status === "past_due") {
    return "past_due";
  }
  return billingNotice === "past_due" || billingNotice === "trial_ending" ? billingNotice : null;
}

/** The `Subscription` of the OpenAPI document. */
export function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    planCode: row.plan_code,
    planName: row.plan_name,
    status: row.status as Subscription["status"],
    billingProvider: row.billing_provider as Subscription["billingProvider"],
    billingInterval: row.billing_interval as Subscription["billingInterval"],
    trialEndsAt: row.trial_ends_at === null ? null : row.trial_ends_at.toISOString(),
    currentPeriodEnd: row.current_period_end === null ? null : row.current_period_end.toISOString(),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    banner: bannerOf(row.status, row.billing_notice),
    canManageInStripe: row.billing_provider === "stripe",
  };
}

@Controller("v1/tenants/:tenantId/subscription")
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsRepository) {}

  @Get()
  @OpenApiOperation("getSubscription")
  @TenantRoles(...tenantRolesOf("getSubscription"))
  async getSubscription(@CurrentMembership() membership: TenantMembership): Promise<Subscription> {
    const row = await this.subscriptions.findShownForTenant(membership.tenantId);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return toSubscription(row);
  }
}
