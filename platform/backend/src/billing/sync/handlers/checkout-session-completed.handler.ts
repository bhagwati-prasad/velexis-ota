// `checkout.session.completed` of the billing endpoint (PBE-045; subscription-billing flow §D, PADR-0002 items 1, 5 and
// 6, ADR-0013 point 3, scope PF-71 and PF-73 AC1, lead decision (5) of 2026-10-24): the webhook, never the browser's
// redirect, makes a Checkout's subscription the OTA's (PBE-044 starts the Checkout).
//
// The handler re-fetches the Checkout Session before any transaction (it never trusts the payload or the order of
// events, PADR-0002 item 5). A session that is not `mode: subscription` or not `complete`, or whose
// `client_reference_id` names no OTA, ends `ignored`. A session whose metadata names another OTA than its
// `client_reference_id`, or without a subscription, fails for good (an admin looks). The session no longer changes
// once complete; its subscription does, so the handler takes the lock of that Stripe subscription
// (subscription-lock.ts, FIX-W30-PLATFORM, PADR-0002 item 5 revision of 2026-10-26), which the subscription's own
// events take too, and re-fetches the subscription under it (`subscriptions.retrieve`): two events of one
// subscription that overlap in the worker run one after the other, so an older re-fetch never commits after a newer
// one. A subscription whose metadata names another OTA, or whose Customer is of another shape, fails for good. Then
// one transaction (`runInTransaction`) locks the tenant's row (billing's lock order, flow §D) and:
//
// 1. stores the session's Customer as the OTA's Stripe Customer (`billing_customers`: inserted, or updated with this
//    Customer, its `livemode` and the e-mail address Checkout collected; PADR-0002 item 1). A Customer another OTA holds
//    fails the event (`CUSTOMER_CONFLICT`);
// 2. finds the subscription's row by `provider_subscription_id`, else the pre-inserted row that
//    `metadata.velexis_subscription_id` names (an OTA created in M5, or retried after an abandoned Checkout), else
//    inserts one; the tenant's other current row (a manual trial, an unpaid Stripe row) is canceled first in the same
//    transaction (PADR-0002 item 6), and the subscription's state, plan and Session are copied with the update path of
//    `SubscriptionChangedHandler.syncInTransaction` (the price's plan, the status rules, `subscription.updated`
//    audited). A `provisioning` OTA has its `queued` provision job dispatched after the commit (the gate opens with
//    `trialing` or `active`; dispatcher.ts), and a `billing` suspension is resumed by the status rules;
// 3. lead decision (5) of 2026-10-24: an OTA that is `failed` (an abandoned Checkout, billing flow §H) whose owner paid
//    through `createCheckoutSession`, so that the shown subscription is now this one and `trialing` or `active`, is
//    re-dispatched as `retryProvisioning` would do it: `failed → provisioning` (`version + 1`), a new `queued` provision
//    job (the active one when there is one; the failed ones stay as history), `provisioning_job.retried` audited
//    (actor `system`, `billing.sync`, the Session), the `tenant` invalidation and the dispatch after the commit.
//
// The lock is confirmed in the transaction just before its commit and released after the work that follows the commit.
// A duplicate or a second event of the same session writes nothing new and dispatches nothing: the job is `running`
// (or done) and the tenant no longer `failed`, so provisioning starts exactly once. The event resolves to the tenant.
import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type Stripe from "stripe";
import type { PlatformTransaction } from "../../../audit/audit.repository";
import { AuditService } from "../../../audit/audit.service";
import { Clock } from "../../../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../../../common/database";
import { IdGenerator } from "../../../common/ids";
import { InvalidationPublisher, runInTransaction } from "../../../common/redis/invalidation.publisher";
import { StripeClient } from "../../../common/stripe/stripe.client";
import {
  HandlesStripeEvents,
  StripeEventFailure,
  type StripeEventHandler,
  type StripeEventOutcome,
  type StripeInboxEvent,
} from "../../../common/stripe/stripe-inbox.service";
import { ProvisioningDispatcher } from "../../../provisioning/dispatcher";
import { ProvisioningJobsRepository } from "../../../provisioning/provisioning-jobs.repository";
import { isShownTenantStatus, type LifecycleActor } from "../../../provisioning/suspension.service";
import { TenantsRepository, type TenantRecord } from "../../../tenants/tenants.repository";
import { BillingCustomersRepository } from "../../billing-customers.repository";
import { SubscriptionsRepository } from "../../subscriptions.repository";
import { RESUMING_STATUSES } from "../status-rules";
import { SubscriptionSyncLock, type HeldSubscriptionLock } from "../subscription-lock";
import {
  BILLING_SYNC_LABEL,
  billingSyncActor,
  CUSTOMER_ID,
  dispatchAfterCommit,
  STRIPE_SUBSCRIPTION_ID,
  stripeIdOf,
  SubscriptionChangedHandler,
  TENANT_ID,
  velexisSubscriptionIdOf,
  velexisTenantIdOf,
  type SubscriptionSyncResult,
} from "./subscription-changed.handler";

/** A Checkout Session id (`cs_`, letters, digits, underscores). */
export const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/;

/** What the Session and its re-fetched subscription name, checked before the transaction. */
interface CompletedCheckout {
  readonly session: Stripe.Checkout.Session;
  readonly tenantId: string;
  /** The subscription as Stripe answered it under its lock. */
  readonly subscription: Stripe.Subscription;
  readonly customerId: string;
  /** `metadata.velexis_subscription_id` of the Session or its subscription. */
  readonly pendingRowId: string | undefined;
}

@Injectable()
@HandlesStripeEvents("billing", ["checkout.session.completed"])
export class CheckoutSessionCompletedHandler implements StripeEventHandler {
  constructor(
    private readonly stripe: StripeClient,
    private readonly sync: SubscriptionChangedHandler,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly customers: BillingCustomersRepository,
    private readonly tenants: TenantsRepository,
    private readonly jobs: ProvisioningJobsRepository,
    private readonly dispatcher: ProvisioningDispatcher,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly lock: SubscriptionSyncLock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(CheckoutSessionCompletedHandler.name) private readonly logger: PinoLogger,
  ) {}

  async handle(event: StripeInboxEvent): Promise<StripeEventOutcome> {
    const objectId = event.objectId;
    if (objectId === null || !CHECKOUT_SESSION_ID.test(objectId)) {
      return { status: "ignored", reason: "NO_CHECKOUT_SESSION: the event names no Checkout Session" };
    }
    const session = await this.stripe.api().checkout.sessions.retrieve(objectId);
    if (session.mode !== "subscription") {
      return { status: "ignored", reason: `NOT_SUBSCRIPTION_MODE: the session is in ${session.mode} mode` };
    }
    if (session.status !== "complete") {
      return { status: "ignored", reason: "SESSION_NOT_COMPLETE: the session is not complete" };
    }
    const tenantId = session.client_reference_id;
    if (tenantId === null || !TENANT_ID.test(tenantId) || !(await this.tenants.exists(tenantId))) {
      return { status: "ignored", reason: "UNKNOWN_TENANT: the session's client_reference_id names no OTA" };
    }
    const subscriptionId = this.subscriptionIdOf(session, tenantId);
    return this.lock.run(subscriptionId, { eventId: event.id }, (held) =>
      this.syncLocked(event, session, tenantId, held),
    );
  }

  /** The subscription's re-fetch and the write of `handle`, while `held` is its lock (file header). */
  private async syncLocked(
    event: StripeInboxEvent,
    session: Stripe.Checkout.Session,
    tenantId: string,
    held: HeldSubscriptionLock,
  ): Promise<StripeEventOutcome> {
    const subscription = await this.stripe.api().subscriptions.retrieve(held.subscriptionId);
    const checkout = this.completedCheckout(session, tenantId, subscription);
    const actor = billingSyncActor(event);
    return runInTransaction(this.db, async (trx): Promise<StripeEventOutcome> => {
      const tenant = await this.tenants.lockForUpdate(trx, tenantId);
      if (tenant === undefined || !isShownTenantStatus(tenant.status)) {
        return {
          status: "ignored",
          reason: "TENANT_NOT_BILLABLE: the session's OTA is deleted or being deleted",
          tenantId,
        };
      }
      const now = this.clock.now();
      const holder = await this.customers.tenantOfCustomer(trx, checkout.customerId);
      if (holder !== undefined && holder !== tenantId) {
        throw new StripeEventFailure("CUSTOMER_CONFLICT", "the session's Customer belongs to another OTA", {
          retryable: false,
          tenantId,
        });
      }
      const customer = await this.customers.upsertFromSync(trx, {
        tenantId,
        customerId: checkout.customerId,
        livemode: session.livemode,
        billingEmail: session.customer_details?.email ?? null,
        now,
      });
      let row = await this.subscriptions.lockStripeByProvider(trx, checkout.subscription.id);
      if (row !== undefined && row.tenant_id !== tenantId) {
        throw new StripeEventFailure("TENANT_MISMATCH", "the subscription's row belongs to another OTA", {
          retryable: false,
          tenantId,
        });
      }
      if (row === undefined && checkout.pendingRowId !== undefined) {
        row = await this.subscriptions.lockPendingStripe(trx, checkout.pendingRowId, tenantId);
      }
      const synced = await this.sync.syncInTransaction(trx, {
        event,
        actor,
        tenant,
        subscription: checkout.subscription,
        row,
        checkoutSessionId: session.id,
        replacesCurrent: true,
        details: {
          checkoutSessionId: session.id,
          customerId: checkout.customerId,
          ...(customer.changed ? { previousCustomerId: customer.previousCustomerId } : {}),
        },
        otherChange: customer.changed,
      });
      if (tenant.status === "failed" && this.paidByThisCheckout(synced)) {
        await this.reopenFailed(trx, tenant, actor, { checkoutSessionId: session.id, synced, now });
      }
      // The last statement before the commit: the write commits only while the lock is this event's.
      await held.confirm();
      return { status: "processed", tenantId };
    });
  }

  /**
   * The Stripe subscription a completed `session` of `tenantId` created, whose lock the handler takes; throws
   * StripeEventFailure (not retryable) for a session whose metadata names another OTA or that has no subscription.
   */
  private subscriptionIdOf(session: Stripe.Checkout.Session, tenantId: string): string {
    const metadataTenant = velexisTenantIdOf(session.metadata);
    if (metadataTenant !== undefined && metadataTenant !== tenantId) {
      throw new StripeEventFailure(
        "TENANT_MISMATCH",
        "the session's metadata names another OTA than its client_reference_id",
        { retryable: false, tenantId },
      );
    }
    const subscriptionId = stripeIdOf(session.subscription);
    if (subscriptionId === undefined || !STRIPE_SUBSCRIPTION_ID.test(subscriptionId)) {
      throw new StripeEventFailure("NO_SUBSCRIPTION", "the completed session has no subscription", {
        retryable: false,
        tenantId,
      });
    }
    return subscriptionId;
  }

  /**
   * The Customer and the pre-inserted row of a completed `session` of `tenantId` and its `subscription`, re-fetched
   * under its lock; throws StripeEventFailure (not retryable) when they do not fit together.
   */
  private completedCheckout(
    session: Stripe.Checkout.Session,
    tenantId: string,
    subscription: Stripe.Subscription,
  ): CompletedCheckout {
    const fail = (code: string, message: string): StripeEventFailure =>
      new StripeEventFailure(code, message, { retryable: false, tenantId });
    const subscriptionTenant = velexisTenantIdOf(subscription.metadata);
    if (subscriptionTenant !== undefined && subscriptionTenant !== tenantId) {
      throw fail("TENANT_MISMATCH", "the subscription's metadata names another OTA than the session");
    }
    const customerId = stripeIdOf(session.customer) ?? stripeIdOf(subscription.customer);
    if (customerId === undefined || !CUSTOMER_ID.test(customerId)) {
      throw fail("INVALID_CUSTOMER", "the session's Customer is not a cus_ id");
    }
    return {
      session,
      tenantId,
      subscription,
      customerId,
      pendingRowId:
        velexisSubscriptionIdOf(session.metadata) ?? velexisSubscriptionIdOf(subscription.metadata),
    };
  }

  /** True when the tenant's shown subscription is now the Checkout's and it is `trialing` or `active` (paid). */
  private paidByThisCheckout(synced: SubscriptionSyncResult): boolean {
    const shown = synced.rules.subscription;
    return shown !== undefined && shown.id === synced.row.id && RESUMING_STATUSES.has(shown.status);
  }

  /** Step 3 of the file header, in `trx`, for the locked `failed` tenant. */
  private async reopenFailed(
    trx: PlatformTransaction,
    tenant: TenantRecord,
    actor: LifecycleActor,
    context: {
      readonly checkoutSessionId: string;
      readonly synced: SubscriptionSyncResult;
      readonly now: Date;
    },
  ): Promise<void> {
    const { checkoutSessionId, synced, now } = context;
    if (!(await this.tenants.reopenFailed(trx, tenant.id, now))) {
      return;
    }
    const previous = await this.jobs.latestProvisionJob(tenant.id, trx);
    const active = previous !== undefined && (previous.status === "queued" || previous.status === "running");
    const jobId = active
      ? previous.id
      : (
          await this.jobs.insertQueued(trx, {
            id: this.ids.new("job"),
            tenantId: tenant.id,
            kind: "provision",
            requestedByAccountId: null,
            now,
          })
        ).id;
    await this.audit.record(trx, {
      actorType: "system",
      actorLabel: BILLING_SYNC_LABEL,
      action: "provisioning_job.retried",
      targetType: "provisioning_job",
      targetId: jobId,
      tenantId: tenant.id,
      tenantKey: tenant.key,
      before: { tenantStatus: "failed" },
      after: { tenantStatus: "provisioning" },
      details: {
        kind: "provision",
        reason: "checkout_completed",
        checkoutSessionId,
        subscriptionId: synced.row.id,
        ...(previous === undefined || active
          ? {}
          : { previousJobId: previous.id, previousError: previous.error }),
      },
      ...(actor.type === "system" && actor.requestId !== undefined ? { requestId: actor.requestId } : {}),
    });
    this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: tenant.id });
    dispatchAfterCommit(trx, this.dispatcher, this.logger, { jobId, tenantId: tenant.id }, actor);
    this.logger.info(
      { tenantId: tenant.id, jobId, checkoutSessionId, subscriptionId: synced.row.id },
      "billing.failed_tenant_redispatched",
    );
  }
}
