// Stripe Checkout and the Stripe Customer Portal of an OTA (PBE-044; platform/docs/flows/subscription-billing.md §B and
// §F, platform/docs/flows/signup-and-create-ota.md step 7, PADR-0002 items 1, 3 and 11, scope PF-71 and PF-72). The
// webhook, never a redirect, activates a subscription (PBE-045): nothing here changes a subscription's status.
//
// `start(input)`, the Checkout of one OTA, for createTenant and retryProvisioning (LifecycleService) and for
// createCheckoutSession (below). Every Stripe call runs without an open transaction (architecture §2.3):
//
// 1. The OTA's Stripe Customer: the stored `billing_customers` row, else a new Customer (the owner's e-mail address,
//    the OTA's legal name or name, `metadata.velexis_tenant_id`; Stripe idempotency key `customer:<tenantId>`), stored
//    with `ON CONFLICT DO NOTHING` (PADR-0002 item 1: one Customer per OTA, reused after a cancellation).
// 2. The Checkout Session of `checkoutSessionParams` (stripe-billing.gateway.ts): the plan's price for the interval, the
//    Velexis metadata (`velexis_subscription_id` when an `incomplete` row was written before), the plan's trial only
//    when the OTA never had a Stripe subscription, `payment_method_collection: "always"`, success URL
//    `<PUBLIC_PORTAL_URL>/otas/<id>/setup?checkout=success` and cancel URL `<PUBLIC_PORTAL_URL>/otas/<id>/billing?
//    checkout=canceled`; Stripe idempotency key `checkout:<tenantId>:<requestKey>` (the request's `Idempotency-Key`,
//    or the retry's new job id), so a retried request gets the same Session.
// 3. One transaction records the Session id (with the plan and interval) on the pre-inserted `incomplete` row, if any,
//    and audits `billing.checkout_started` (the Session id, never its URL).
//
// A Stripe failure throws `502 PROVIDER_ERROR` (`details.provider = stripe`); what was stored before it stays (the
// Customer is reused next time). createTenant turns it into `checkoutError` instead (lifecycle.service.ts).
//
// `createCheckoutSession` (owners, `Idempotency-Key`, FeatureGuard: `stripe_billing`): for an OTA that exists already
// (a manual trial ending, a canceled subscription, an abandoned Checkout). The plan must be public, active and have a
// Stripe price for the interval (`422 PLAN_NOT_AVAILABLE`). An OTA whose Stripe subscription is current (`trialing`,
// `active`, `past_due`, `paused`, `unpaid`) manages it in the Customer Portal (`409 CONFLICT`, `details.reason =
// stripe_subscription_active`). No subscription row is inserted: the current row (a manual trial) keeps its slot until
// the webhook replaces it; only the `incomplete` row of an OTA created in M5 carries the new Session. The answer is
// `201 {url, expiresAt}`.
//
// `createCustomerPortalSession` (owners, FeatureGuard: `stripe_billing`): the OTA's Customer must exist (`409
// CONFLICT`, `details.reason = no_stripe_customer`); `billingPortal.sessions.create({customer, return_url:
// <PUBLIC_PORTAL_URL>/otas/<id>/billing})` and the session URL, which the controller sends with `no-store`. Nothing is
// written or audited; the URL is never logged or stored.
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AuditService } from "../audit/audit.service";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { idempotencyKey } from "../common/stripe/stripe.client";
import type { PlatformBackendConfig } from "../config";
import { publicBase } from "../notifications/outbox.service";
import { BillingCustomersRepository } from "./billing-customers.repository";
import { PlansRepository, type PublicPlanRow } from "./plans.repository";
import {
  checkoutSessionParams,
  providerError,
  StripeBillingFailure,
  StripeBillingGateway,
  type CreatedCheckoutSession,
} from "./stripe-billing.gateway";
import { SubscriptionsRepository, type CheckoutSubscriptionRow } from "./subscriptions.repository";

export type BillingInterval = components["schemas"]["BillingInterval"];
export type CreateCheckoutSessionRequest = components["schemas"]["CreateCheckoutSessionRequest"];
export type CheckoutSession = components["schemas"]["CheckoutSession"];
export type CustomerPortalSession = components["schemas"]["CustomerPortalSession"];

/**
 * The statuses of a Stripe subscription that the owner manages in the Customer Portal: a new Checkout would make a
 * second Stripe subscription (`409 CONFLICT`). An `incomplete` row has not been paid yet, so it may get a new Checkout.
 */
export const PORTAL_MANAGED_STATUSES: ReadonlySet<string> = new Set([
  "trialing",
  "active",
  "past_due",
  "paused",
  "unpaid",
]);

/** A plan that can be bought through Checkout with one interval. */
export interface CheckoutPlan {
  readonly code: string;
  readonly interval: BillingInterval;
  /** `price_…`: the plan's Stripe Price for the interval. */
  readonly priceId: string;
  /** `plans.trial_days`, given on the OTA's first Stripe subscription only. */
  readonly trialDays: number;
}

/** The CheckoutPlan of `plan` for `interval`; `undefined` when the plan has no Stripe Price for it. */
export function checkoutPlanOf(plan: PublicPlanRow, interval: BillingInterval): CheckoutPlan | undefined {
  const priceId = interval === "year" ? plan.stripe_price_id_year : plan.stripe_price_id_month;
  return priceId === null ? undefined : { code: plan.code, interval, priceId, trialDays: plan.trial_days };
}

/**
 * The pre-inserted `incomplete` row a new Checkout may carry (`velexis_subscription_id`): the current subscription
 * when it is the Stripe row of an OTA created in M5 that no Stripe subscription has filled yet; `null` otherwise.
 */
export function pendingCheckoutRowOf(current: CheckoutSubscriptionRow | undefined): string | null {
  return current !== undefined &&
    current.billing_provider === "stripe" &&
    current.status === "incomplete" &&
    current.provider_subscription_id === null
    ? current.id
    : null;
}

/** One Checkout of an OTA (see the file header, `start`). */
export interface StartCheckoutInput {
  readonly tenantId: string;
  /** `acc_…` of the owner who starts it: the e-mail address of a new Customer, the actor of the audit row. */
  readonly accountId: string;
  readonly plan: CheckoutPlan;
  /** `sub_…` of the pre-inserted `incomplete` row, or `null`. */
  readonly subscriptionId: string | null;
  /**
   * What makes the Stripe idempotency key `checkout:<tenantId>:<requestKey>`: the request's `Idempotency-Key`, or the
   * new job's id of a retry.
   */
  readonly requestKey: string;
}

@Injectable()
export class CheckoutService {
  private readonly portalBase: string;

  constructor(
    private readonly plans: PlansRepository,
    private readonly customers: BillingCustomersRepository,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly gateway: StripeBillingGateway,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(CheckoutService.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.portalBase = publicBase(config.get("PUBLIC_PORTAL_URL", { infer: true }));
  }

  /**
   * The plan `planCode` for a Checkout with `interval`: public, active and with a Stripe Price for the interval, else
   * `422 PLAN_NOT_AVAILABLE`.
   */
  async planFor(planCode: string, interval: BillingInterval): Promise<CheckoutPlan> {
    const plan = (await this.plans.listPublicActive()).find((candidate) => candidate.code === planCode);
    const checkoutPlan = plan === undefined ? undefined : checkoutPlanOf(plan, interval);
    if (checkoutPlan === undefined) {
      throw new AppError("PLAN_NOT_AVAILABLE");
    }
    return checkoutPlan;
  }

  /** The Checkout of one OTA (see the file header); `502 PROVIDER_ERROR` when Stripe fails. */
  async start(input: StartCheckoutInput): Promise<CreatedCheckoutSession> {
    const { tenantId, accountId, plan, subscriptionId } = input;
    try {
      const customerId = await this.customerOf(tenantId, accountId);
      const trialDays = (await this.subscriptions.hasStripeSubscription(tenantId)) ? null : plan.trialDays;
      const session = await this.gateway.createCheckoutSession(
        checkoutSessionParams({
          tenantId,
          customerId,
          priceId: plan.priceId,
          planCode: plan.code,
          subscriptionId,
          trialDays,
          successUrl: this.portalLink(`/otas/${tenantId}/setup`, { checkout: "success" }),
          cancelUrl: this.portalLink(`/otas/${tenantId}/billing`, { checkout: "canceled" }),
        }),
        idempotencyKey("checkout", `${tenantId}:${input.requestKey}`),
      );
      await runInTransaction(this.db, async (trx) => {
        const now = this.clock.now();
        if (subscriptionId !== null) {
          await this.subscriptions.recordCheckoutSession(trx, {
            id: subscriptionId,
            checkoutSessionId: session.id,
            planCode: plan.code,
            billingInterval: plan.interval,
            now,
          });
        }
        await this.audit.record(trx, {
          actorType: "account",
          actorAccountId: accountId,
          action: "billing.checkout_started",
          targetType: subscriptionId === null ? "tenant" : "subscription",
          targetId: subscriptionId ?? tenantId,
          tenantId,
          details: {
            checkoutSessionId: session.id,
            customerId,
            planCode: plan.code,
            billingInterval: plan.interval,
            trialDays,
            subscriptionId,
          },
        });
      });
      this.logger.info(
        { tenantId, checkoutSessionId: session.id, planCode: plan.code, billingInterval: plan.interval },
        "billing.checkout_started",
      );
      return session;
    } catch (error) {
      if (error instanceof StripeBillingFailure) {
        throw providerError(error);
      }
      throw error;
    }
  }

  /** createCheckoutSession by an owner (see the file header). */
  async createCheckoutSession(
    membership: TenantMembership,
    request: CreateCheckoutSessionRequest,
    requestKey: string,
  ): Promise<CheckoutSession> {
    const { tenantId, accountId } = membership;
    const current = await this.subscriptions.findCurrentForCheckout(tenantId);
    if (current?.billing_provider === "stripe" && PORTAL_MANAGED_STATUSES.has(current.status)) {
      throw new AppError("CONFLICT", { details: { reason: "stripe_subscription_active" } });
    }
    const plan = await this.planFor(request.planCode, request.billingInterval);
    const session = await this.start({
      tenantId,
      accountId,
      plan,
      subscriptionId: pendingCheckoutRowOf(current),
      requestKey,
    });
    return { url: session.url, expiresAt: session.expiresAt.toISOString() };
  }

  /** createCustomerPortalSession by an owner (see the file header). */
  async createCustomerPortalSession(membership: TenantMembership): Promise<CustomerPortalSession> {
    const { tenantId } = membership;
    const customer = await this.customers.find(tenantId);
    if (customer === undefined) {
      throw new AppError("CONFLICT", { details: { reason: "no_stripe_customer" } });
    }
    try {
      const session = await this.gateway.createPortalSession(
        {
          customerId: customer.provider_customer_id,
          returnUrl: this.portalLink(`/otas/${tenantId}/billing`),
        },
        // A new session every call; the key covers the SDK's network retry of this one.
        idempotencyKey("portal_session", `${tenantId}:${randomUUID()}`),
      );
      return { url: session.url };
    } catch (error) {
      if (error instanceof StripeBillingFailure) {
        throw providerError(error);
      }
      throw error;
    }
  }

  /** The stored Stripe Customer of `tenantId`, else a new one (step 1 of `start`). */
  private async customerOf(tenantId: string, accountId: string): Promise<string> {
    const stored = await this.customers.find(tenantId);
    if (stored !== undefined) {
      return stored.provider_customer_id;
    }
    const context = await this.customers.customerContext(tenantId, accountId);
    if (context === undefined) {
      throw new Error("CheckoutService: the tenant or the account of the Checkout does not exist");
    }
    const created = await this.gateway.createCustomer(
      { tenantId, email: context.email, name: context.name },
      idempotencyKey("customer", tenantId),
    );
    const row = await this.customers.insertIfAbsent({
      tenantId,
      customerId: created.id,
      livemode: created.livemode,
      billingEmail: context.email,
      now: this.clock.now(),
    });
    return row.provider_customer_id;
  }

  /** A link into the portal on PUBLIC_PORTAL_URL, never a host taken from a request. */
  private portalLink(path: string, query: Readonly<Record<string, string>> = {}): string {
    const url = new URL(`${this.portalBase}${path}`);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }
    return url.toString();
  }
}
