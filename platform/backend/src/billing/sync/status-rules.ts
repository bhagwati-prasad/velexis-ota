// The status rules of billing sync (PBE-045; subscription-billing flow §E, PADR-0002 item 7, PADR-0014 items 1 and 4,
// ADR-0013 point 7, scope PF-74): what a tenant's subscription status does to the tenant. They run in the transaction
// of each billing event, after the Stripe subscription was copied into its row, with the tenant's row locked, so they
// act on the subscription as that transaction wrote it and two events of one tenant never interleave.
//
// The rules read the tenant's **shown** subscription, the current one (CURRENT_SUBSCRIPTION_STATUSES), else the latest
// (`SubscriptionsRepository.findShownForTenant`), not the subscription of the event: a late event about an earlier,
// canceled Stripe subscription leaves an OTA that pays a newer one alone. A manual subscription (before M5, or a manual
// trial not replaced yet) is the business of the manual-trial schedule (PBE-047): the rules change nothing for it.
//
// | Status of the shown Stripe subscription  | Effect                                                              |
// |------------------------------------------|---------------------------------------------------------------------|
// | `trialing`, `active`                     | `billing_notice` cleared; a `billing` suspension is resumed          |
// | `past_due`, `paused`                     | `billing_notice = 'past_due'` (the banner of the portal and OTA admin) |
// | `canceled`, `unpaid`, `incomplete_expired` | an `active` tenant is suspended with reason `billing`              |
// | `incomplete`                             | nothing (the Checkout is not paid yet)                              |
//
// `tenants.plan_code` follows the plan of the shown Stripe subscription (ADR-0013 point 6). A suspension for another
// reason (`abuse`, `request`, `admin`) is never resumed here, and a tenant that is `provisioning` or `failed` is never
// suspended (an expired Checkout of a new OTA is the abandoned-Checkout schedule's, flow §H).
//
// Every change audits and publishes `tenant`: a new plan or banner is published after the commit (`vx:invalidate`
// `tenant`) and recorded by the caller's `subscription.updated` audit row (`before` and `after`); a suspend or resume
// goes through SuspensionService in the same transaction (`suspendInTransaction`, `resumeInTransaction`: the tenant's
// status, the `suspend` or `resume` job, the `tenant.suspended` or `tenant.resumed` audit row, the owners' e-mail, the
// invalidation), and its job is dispatched after the commit. Billing never deletes data.
import { Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../../audit/audit.repository";
import { Clock } from "../../common/clock";
import { afterCommit, InvalidationPublisher } from "../../common/redis/invalidation.publisher";
import { SuspensionService, type LifecycleActor } from "../../provisioning/suspension.service";
import { TenantsRepository, type TenantRecord } from "../../tenants/tenants.repository";
import { SubscriptionsRepository } from "../subscriptions.repository";

/** The statuses that clear the banner and end a `billing` suspension (PADR-0014 item 4). */
export const RESUMING_STATUSES: ReadonlySet<string> = new Set(["trialing", "active"]);

/** The statuses that show the `past_due` banner (`paused` is treated like `past_due`, flow §E). */
export const PAST_DUE_STATUSES: ReadonlySet<string> = new Set(["past_due", "paused"]);

/** The statuses that suspend an active tenant with reason `billing`. */
export const SUSPENDING_STATUSES: ReadonlySet<string> = new Set(["canceled", "unpaid", "incomplete_expired"]);

/** The banner the rules set for a `past_due` or `paused` subscription. */
export const PAST_DUE_NOTICE = "past_due";

/** What the rules read of the tenant. */
export interface RulesTenant {
  readonly status: string;
  readonly suspensionReason: string | null;
  readonly billingNotice: string | null;
}

/** What the rules read of the tenant's shown subscription. */
export interface RulesSubscription {
  readonly status: string;
  /** `stripe` or `manual`. */
  readonly billingProvider: string;
}

/** What the rules ask for. */
export interface BillingEffects {
  /** The banner the tenant should show: `past_due`, or `null`; the tenant's own value when the rules keep it. */
  readonly billingNotice: string | null;
  /** A suspend (reason `billing`) or a resume of a `billing` suspension, or nothing. */
  readonly lifecycle: "suspend" | "resume" | null;
}

/** The effects of the shown `subscription` (`undefined` when the tenant has none) on `tenant` (see the file header). */
export function billingEffects(
  subscription: RulesSubscription | undefined,
  tenant: RulesTenant,
): BillingEffects {
  const unchanged: BillingEffects = { billingNotice: tenant.billingNotice, lifecycle: null };
  if (subscription === undefined || subscription.billingProvider !== "stripe") {
    return unchanged;
  }
  if (RESUMING_STATUSES.has(subscription.status)) {
    const billingSuspension = tenant.status === "suspended" && tenant.suspensionReason === "billing";
    return { billingNotice: null, lifecycle: billingSuspension ? "resume" : null };
  }
  if (PAST_DUE_STATUSES.has(subscription.status)) {
    return { billingNotice: PAST_DUE_NOTICE, lifecycle: null };
  }
  if (SUSPENDING_STATUSES.has(subscription.status)) {
    return { ...unchanged, lifecycle: tenant.status === "active" ? "suspend" : null };
  }
  return unchanged;
}

/** A value before and after a change. */
export interface Change<T> {
  readonly before: T;
  readonly after: T;
}

/** What `BillingStatusRules.apply` did in the transaction. */
export interface AppliedBillingRules {
  /** The shown subscription the rules read; `undefined` when the tenant has none. */
  readonly subscription:
    | {
        readonly id: string;
        readonly status: string;
        readonly billingProvider: string;
        readonly planCode: string;
      }
    | undefined;
  readonly effects: BillingEffects;
  /** The tenant's plan, when the rules changed it. */
  readonly plan: Change<string> | undefined;
  /** The tenant's banner, when the rules changed it. */
  readonly billingNotice: Change<string | null> | undefined;
  /** The `suspend` or `resume` job the rules queued, dispatched after the commit. */
  readonly lifecycleJobId: string | undefined;
}

@Injectable()
export class BillingStatusRules {
  constructor(
    private readonly subscriptions: SubscriptionsRepository,
    private readonly tenants: TenantsRepository,
    private readonly suspension: SuspensionService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
  ) {}

  /**
   * Applies the rules to `tenant` (its row locked in `trx` by the caller, as it was read then) in `trx`, a transaction
   * of `runInTransaction`: the plan and the banner, the invalidation after the commit, and a suspend or resume whose job
   * is dispatched after the commit. `actor` is billing sync's `system` actor.
   */
  async apply(
    trx: PlatformTransaction,
    tenant: TenantRecord,
    actor: LifecycleActor,
  ): Promise<AppliedBillingRules> {
    const shown = await this.subscriptions.findShownForTenant(tenant.id, trx);
    const subscription =
      shown === undefined
        ? undefined
        : {
            id: shown.id,
            status: shown.status,
            billingProvider: shown.billing_provider,
            planCode: shown.plan_code,
          };
    const effects = billingEffects(subscription, {
      status: tenant.status,
      suspensionReason: tenant.suspension_reason,
      billingNotice: tenant.billing_notice,
    });
    const now = this.clock.now();
    let plan: Change<string> | undefined;
    if (subscription?.billingProvider === "stripe") {
      const before = await this.tenants.setPlanCode(trx, tenant.id, subscription.planCode, now);
      plan = before === undefined ? undefined : { before, after: subscription.planCode };
    }
    let billingNotice: Change<string | null> | undefined;
    if (
      effects.billingNotice !== tenant.billing_notice &&
      (await this.tenants.setBillingNotice(trx, tenant.id, effects.billingNotice, now))
    ) {
      billingNotice = { before: tenant.billing_notice, after: effects.billingNotice };
    }
    if (plan !== undefined || billingNotice !== undefined) {
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: tenant.id });
    }
    let lifecycleJobId: string | undefined;
    if (effects.lifecycle === "suspend") {
      lifecycleJobId = await this.suspension.suspendInTransaction(trx, tenant.id, "billing", actor);
    } else if (effects.lifecycle === "resume") {
      lifecycleJobId = await this.suspension.resumeInTransaction(trx, tenant.id, actor);
    }
    if (lifecycleJobId !== undefined) {
      const jobId = lifecycleJobId;
      afterCommit(trx, () => this.suspension.dispatchQuietly(jobId, tenant.id, actor));
    }
    return { subscription, effects, plan, billingNotice, lifecycleJobId };
  }
}
