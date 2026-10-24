// `customer.subscription.created`, `…updated` and `…deleted` of the billing endpoint (PBE-045; subscription-billing
// flow §D and §E, PADR-0002 items 5, 6 and 7, ADR-0013 points 6 and 7, scope PF-73 AC1 and PF-74), and the update path
// that the completed Checkout (checkout-session-completed.handler.ts) and the admin's resync (PBE-048) share.
//
// The handler never trusts the payload or the order of events (PADR-0002 item 5): it re-fetches the subscription
// (`subscriptions.retrieve(event.objectId)`), so a duplicate or a late event writes Stripe's current state again and
// changes nothing, and any order of events ends with the same rows. Stripe is called before the transaction, never
// inside it (architecture §2.3). Then:
//
// 1. The row: the Stripe row with this `provider_subscription_id`, else the pre-inserted row its
//    `metadata.velexis_subscription_id` names (the `incomplete` row of an OTA created in M5). Without either the event
//    ends `ignored` (`UNKNOWN_SUBSCRIPTION`): a subscription of an existing OTA (a manual trial, a canceled
//    subscription) gets its row from `checkout.session.completed`, which re-fetches it in turn.
// 2. One transaction (`runInTransaction`) locks the tenant's row first (the lock order of every tenant change), then
//    the subscription's row. A subscription whose `metadata.velexis_tenant_id` names another OTA than its row, or whose
//    Customer `billing_customers` stores for another OTA, fails for good (`TENANT_MISMATCH`, `CUSTOMER_CONFLICT`) and
//    writes nothing, as for a completed Checkout. Then `syncInTransaction` runs:
//    - the price is mapped to its plan (price-to-plan.ts; `UNKNOWN_PRICE` fails the event);
//    - a row that takes the "one current subscription" slot (a current status, or always for a completed Checkout)
//      replaces the tenant's other current row when that one is a manual trial or an unpaid (`incomplete`) Stripe row:
//      `canceled` in the same transaction (PADR-0002 item 6). Another current Stripe subscription that is paid or in
//      dunning is a conflict an admin resolves: the event fails with `SUBSCRIPTION_CONFLICT`;
//    - the subscription's state is copied into the row: status, Customer, subscription and price ids, plan and interval,
//      the period of its one item, trial end, `cancel_at_period_end`, `canceled_at`; `provider_synced_at` is the time of
//      the re-fetch. `version + 1` and `updated_at` only when something changed, so a duplicate leaves the row as it was;
//    - the status rules (status-rules.ts): the tenant's plan and banner, a suspend or resume;
//    - a `provisioning` OTA whose shown subscription is now `trialing` or `active` has its `queued` provision job
//      dispatched after the commit (the dispatch gate opens, dispatcher.ts; the reconciler would take it within 5
//      minutes otherwise);
//    - one `subscription.updated` audit row (actor `system`, `billing.sync`; the event id as request id) when anything
//      changed: the subscription's fields and the tenant's plan and banner before and after, the replaced rows.
// 3. After the commit: the invalidation, the dispatch of the provision job and of the suspend or resume job (never
//    failing the event; the reconciler takes a job left `queued`).
//
// The event resolves to the tenant (`stripe_events.tenant_id`). Log lines carry ids and statuses, never an e-mail
// address or a payload.
import { Inject, Injectable } from "@nestjs/common";
import { REQUEST_ID_PATTERN } from "@velexis/logger";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type Stripe from "stripe";
import type { PlatformTransaction } from "../../../audit/audit.repository";
import { AuditService } from "../../../audit/audit.service";
import { Clock } from "../../../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../../../common/database";
import { IdGenerator } from "../../../common/ids";
import { afterCommit, runInTransaction } from "../../../common/redis/invalidation.publisher";
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
import {
  CURRENT_SUBSCRIPTION_STATUSES,
  SubscriptionsRepository,
  type StripeSubscriptionRecord,
  type StripeSubscriptionState,
} from "../../subscriptions.repository";
import { PriceToPlan, type SubscriptionPlan } from "../price-to-plan";
import { BillingStatusRules, RESUMING_STATUSES, type AppliedBillingRules } from "../status-rules";

/** The event types of this handler. */
export const SUBSCRIPTION_EVENT_TYPES = Object.freeze([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const);

/** The `actor_label` of billing sync's `system` actor (audit rows, suspensions). */
export const BILLING_SYNC_LABEL = "billing.sync";

/** A Stripe subscription id (`sub_`, letters, digits, underscores). */
export const STRIPE_SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,250}$/;

/** A tenant id (`ten_` and a ULID), as `client_reference_id` and `metadata.velexis_tenant_id` carry it. */
export const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A platform subscription id (`sub_` and a ULID), as `metadata.velexis_subscription_id` carries it. */
export const PLATFORM_SUBSCRIPTION_ID = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A Stripe Customer id as `billing_customers` allows it (`cus_`, letters and digits). */
export const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;

/** The statuses of a Stripe subscription that `subscriptions` stores (Stripe's eight). */
const STRIPE_STATUSES: ReadonlySet<string> = new Set([
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
]);

const CURRENT_STATUSES: ReadonlySet<string> = new Set(CURRENT_SUBSCRIPTION_STATUSES);

/** Billing sync's actor for `event`: the event id is the request id of the audit rows and jobs it causes. */
export function billingSyncActor(event: Pick<StripeInboxEvent, "id">): LifecycleActor {
  return REQUEST_ID_PATTERN.test(event.id)
    ? { type: "system", label: BILLING_SYNC_LABEL, requestId: event.id }
    : { type: "system", label: BILLING_SYNC_LABEL };
}

/** The value of `key` in Stripe metadata, when it is a string. */
function metadataValue(metadata: Stripe.Metadata | null | undefined, key: string): string | undefined {
  const value: unknown = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

/** `metadata.velexis_tenant_id` when it is a tenant id. */
export function velexisTenantIdOf(metadata: Stripe.Metadata | null | undefined): string | undefined {
  const value = metadataValue(metadata, "velexis_tenant_id");
  return value !== undefined && TENANT_ID.test(value) ? value : undefined;
}

/** `metadata.velexis_subscription_id` when it is a platform subscription id. */
export function velexisSubscriptionIdOf(metadata: Stripe.Metadata | null | undefined): string | undefined {
  const value = metadataValue(metadata, "velexis_subscription_id");
  return value !== undefined && PLATFORM_SUBSCRIPTION_ID.test(value) ? value : undefined;
}

/** The id of a Stripe reference that may be expanded (`"cus_…"` or `{id: "cus_…"}`); `undefined` for none. */
export function stripeIdOf(
  reference: string | { readonly id: string } | null | undefined,
): string | undefined {
  if (typeof reference === "string") {
    return reference;
  }
  return reference === null || reference === undefined ? undefined : reference.id;
}

/** A Stripe timestamp (Unix seconds) as a Date; `null` for none. */
function dateOf(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

/**
 * The state of `subscription` that its row keeps, with its `plan` (the price of its one item, price-to-plan.ts).
 * Throws StripeEventFailure (not retryable) for a status the table does not know or a Customer of another shape.
 */
export function subscriptionStateOf(
  subscription: Stripe.Subscription,
  plan: SubscriptionPlan,
  tenantId: string,
): StripeSubscriptionState {
  if (!STRIPE_STATUSES.has(subscription.status)) {
    throw new StripeEventFailure(
      "UNSUPPORTED_SUBSCRIPTION",
      "the subscription's status is not one Velexis stores",
      { retryable: false, tenantId },
    );
  }
  const customerId = stripeIdOf(subscription.customer);
  if (customerId === undefined || !CUSTOMER_ID.test(customerId)) {
    throw new StripeEventFailure("INVALID_CUSTOMER", "the subscription's Customer is not a cus_ id", {
      retryable: false,
      tenantId,
    });
  }
  const [item] = subscription.items.data;
  return {
    status: subscription.status,
    planCode: plan.planCode,
    billingInterval: plan.interval,
    providerCustomerId: customerId,
    providerSubscriptionId: subscription.id,
    providerPriceId: plan.priceId,
    trialEndsAt: dateOf(subscription.trial_end),
    currentPeriodStart: dateOf(item?.current_period_start),
    currentPeriodEnd: dateOf(item?.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: dateOf(subscription.canceled_at),
  };
}

/** The fields of a subscription an audit row shows (dates as ISO strings). */
type AuditView = Readonly<Record<string, string | boolean | null>>;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** The audit view of a row. */
function viewOfRow(row: StripeSubscriptionRecord): AuditView {
  return {
    status: row.status,
    planCode: row.plan_code,
    billingInterval: row.billing_interval,
    providerCustomerId: row.provider_customer_id,
    providerSubscriptionId: row.provider_subscription_id,
    providerPriceId: row.provider_price_id,
    trialEndsAt: iso(row.trial_ends_at),
    currentPeriodStart: iso(row.current_period_start),
    currentPeriodEnd: iso(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    canceledAt: iso(row.canceled_at),
    checkoutSessionId: row.checkout_session_id,
  };
}

/** The audit view of a state written with `checkoutSessionId` (`null` keeps `stored`). */
function viewOfState(
  state: StripeSubscriptionState,
  checkoutSessionId: string | null,
  stored: string | null,
): AuditView {
  return {
    status: state.status,
    planCode: state.planCode,
    billingInterval: state.billingInterval,
    providerCustomerId: state.providerCustomerId,
    providerSubscriptionId: state.providerSubscriptionId,
    providerPriceId: state.providerPriceId,
    trialEndsAt: iso(state.trialEndsAt),
    currentPeriodStart: iso(state.currentPeriodStart),
    currentPeriodEnd: iso(state.currentPeriodEnd),
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    canceledAt: iso(state.canceledAt),
    checkoutSessionId: checkoutSessionId ?? stored,
  };
}

/** The fields of `after` that differ from `before`, each side with only those fields. */
export function changedFields(
  before: AuditView,
  after: AuditView,
): { readonly before: Record<string, unknown>; readonly after: Record<string, unknown> } {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      changedBefore[key] = before[key] ?? null;
      changedAfter[key] = after[key];
    }
  }
  return { before: changedBefore, after: changedAfter };
}

/** True when writing `state` (and `checkoutSessionId`, unless `null`) changes the row `row`. */
export function stateDiffers(
  row: StripeSubscriptionRecord,
  state: StripeSubscriptionState,
  checkoutSessionId: string | null,
): boolean {
  const { before } = changedFields(
    viewOfRow(row),
    viewOfState(state, checkoutSessionId, row.checkout_session_id),
  );
  return Object.keys(before).length > 0;
}

/** Registers the dispatch of the job `jobId` after the commit of `trx`; it never fails (the reconciler recovers). */
export function dispatchAfterCommit(
  trx: PlatformTransaction,
  dispatcher: ProvisioningDispatcher,
  logger: PinoLogger,
  job: { readonly jobId: string; readonly tenantId: string },
  actor: LifecycleActor,
): void {
  afterCommit(trx, async () => {
    try {
      await dispatcher.dispatch(
        job.jobId,
        actor.type === "system" && actor.requestId !== undefined ? { requestId: actor.requestId } : {},
      );
    } catch (error) {
      logger.warn({ jobId: job.jobId, tenantId: job.tenantId, err: error }, "provisioning.dispatch_failed");
    }
  });
}

/** One sync of a Stripe subscription into its row, in the caller's transaction (step 2 of the file header). */
export interface SubscriptionSyncInput {
  readonly event: StripeInboxEvent;
  readonly actor: LifecycleActor;
  /** The tenant, its row locked in the transaction. */
  readonly tenant: TenantRecord;
  /** The re-fetched subscription. */
  readonly subscription: Stripe.Subscription;
  /** The row to write (locked), or `undefined` to insert one (a completed Checkout only). */
  readonly row: StripeSubscriptionRecord | undefined;
  /** `cs_…` of a completed Checkout; `null` keeps the stored one. */
  readonly checkoutSessionId: string | null;
  /** True for a completed Checkout: it replaces the tenant's manual or unpaid row whatever the status. */
  readonly replacesCurrent: boolean;
  /** More facts for the audit row (ids only). */
  readonly details?: Readonly<Record<string, unknown>>;
  /** True when the caller changed something the audit row reports (the Customer of a Checkout). */
  readonly otherChange?: boolean;
}

/** What a sync did. */
export interface SubscriptionSyncResult {
  /** The row as written. */
  readonly row: StripeSubscriptionRecord;
  /** True when the row was inserted or its state changed. */
  readonly changed: boolean;
  /** The rows it replaced (`canceled`). */
  readonly superseded: readonly string[];
  readonly rules: AppliedBillingRules;
  /** The provision job dispatched after the commit, if any. */
  readonly provisionJobId: string | undefined;
}

@Injectable()
@HandlesStripeEvents("billing", SUBSCRIPTION_EVENT_TYPES)
export class SubscriptionChangedHandler implements StripeEventHandler {
  constructor(
    private readonly stripe: StripeClient,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly customers: BillingCustomersRepository,
    private readonly tenants: TenantsRepository,
    private readonly prices: PriceToPlan,
    private readonly rules: BillingStatusRules,
    private readonly jobs: ProvisioningJobsRepository,
    private readonly dispatcher: ProvisioningDispatcher,
    private readonly audit: AuditService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(SubscriptionChangedHandler.name) private readonly logger: PinoLogger,
  ) {}

  async handle(event: StripeInboxEvent): Promise<StripeEventOutcome> {
    const objectId = event.objectId;
    if (objectId === null || !STRIPE_SUBSCRIPTION_ID.test(objectId)) {
      return { status: "ignored", reason: "NO_SUBSCRIPTION: the event names no Stripe subscription" };
    }
    const subscription = await this.stripe.api().subscriptions.retrieve(objectId);
    const hint = velexisSubscriptionIdOf(subscription.metadata);
    const ref =
      (await this.subscriptions.findStripeRef(subscription.id)) ??
      (hint === undefined ? undefined : await this.subscriptions.findPendingStripeRef(hint));
    if (ref === undefined) {
      return {
        status: "ignored",
        reason: `UNKNOWN_SUBSCRIPTION: no row of ${subscription.id} yet; the completed Checkout writes it`,
        tenantId: await this.knownTenant(velexisTenantIdOf(subscription.metadata)),
      };
    }
    const actor = billingSyncActor(event);
    return runInTransaction(this.db, async (trx): Promise<StripeEventOutcome> => {
      const tenant = await this.tenants.lockForUpdate(trx, ref.tenant_id);
      if (tenant === undefined || !isShownTenantStatus(tenant.status)) {
        return {
          status: "ignored",
          reason: "TENANT_NOT_BILLABLE: the subscription's OTA is deleted or being deleted",
          tenantId: tenant?.id ?? null,
        };
      }
      const row =
        (await this.subscriptions.lockStripeByProvider(trx, subscription.id)) ??
        (hint === undefined ? undefined : await this.subscriptions.lockPendingStripe(trx, hint, tenant.id));
      if (row === undefined || row.tenant_id !== tenant.id) {
        // Another event filled the pending row between the read and the lock: the next attempt reads it again.
        throw new StripeEventFailure("SUBSCRIPTION_MOVED", "the subscription's row changed meanwhile", {
          retryable: true,
          tenantId: tenant.id,
        });
      }
      await this.assertSameTenant(trx, subscription, tenant.id);
      await this.syncInTransaction(trx, {
        event,
        actor,
        tenant,
        subscription,
        row,
        checkoutSessionId: null,
        replacesCurrent: false,
      });
      return { status: "processed", tenantId: tenant.id };
    });
  }

  /**
   * Copies `input.subscription` into its row in `trx`, a transaction of `runInTransaction` in which the tenant's row is
   * locked, and applies the status rules (step 2 of the file header).
   */
  async syncInTransaction(
    trx: PlatformTransaction,
    input: SubscriptionSyncInput,
  ): Promise<SubscriptionSyncResult> {
    const { event, actor, tenant, subscription, row } = input;
    const plan = await this.prices.planOf(trx, subscription, tenant.id);
    const state = subscriptionStateOf(subscription, plan, tenant.id);
    const now = this.clock.now();
    const superseded =
      input.replacesCurrent || CURRENT_STATUSES.has(state.status)
        ? await this.supersedeOthers(trx, tenant.id, row?.id ?? null, now)
        : [];
    let written: StripeSubscriptionRecord;
    let changed: boolean;
    if (row === undefined) {
      written = await this.subscriptions.insertStripe(trx, {
        id: this.ids.new("sub"),
        tenantId: tenant.id,
        state,
        checkoutSessionId: input.checkoutSessionId,
        now,
      });
      changed = true;
    } else {
      changed = stateDiffers(row, state, input.checkoutSessionId);
      written = await this.subscriptions.writeStripe(trx, row.id, {
        state,
        checkoutSessionId: input.checkoutSessionId,
        now,
        changed,
      });
    }
    const rules = await this.rules.apply(trx, tenant, actor);
    let provisionJobId: string | undefined;
    if (
      tenant.status === "provisioning" &&
      rules.subscription !== undefined &&
      RESUMING_STATUSES.has(rules.subscription.status)
    ) {
      const job = await this.jobs.latestProvisionJob(tenant.id, trx);
      if (job?.status === "queued") {
        provisionJobId = job.id;
        dispatchAfterCommit(trx, this.dispatcher, this.logger, { jobId: job.id, tenantId: tenant.id }, actor);
      }
    }
    if (
      changed ||
      superseded.length > 0 ||
      rules.plan !== undefined ||
      rules.billingNotice !== undefined ||
      input.otherChange === true
    ) {
      await this.record(trx, input, { row, written, superseded, rules });
    }
    this.logger.info(
      {
        eventId: event.id,
        eventType: event.type,
        tenantId: tenant.id,
        subscriptionId: written.id,
        providerSubscriptionId: written.provider_subscription_id,
        status: written.status,
        changed,
        superseded: superseded.length,
        lifecycle: rules.effects.lifecycle,
        provisionJobId: provisionJobId ?? null,
      },
      "billing.subscription_synced",
    );
    return { row: written, changed, superseded, rules, provisionJobId };
  }

  /**
   * Cancels the other current subscriptions of `tenantId` (all but `keepId`) that a Stripe row replaces: manual trials
   * and unpaid (`incomplete`) Stripe rows. Another current Stripe subscription fails the event (`SUBSCRIPTION_CONFLICT`).
   * Returns the ids it canceled.
   */
  private async supersedeOthers(
    trx: PlatformTransaction,
    tenantId: string,
    keepId: string | null,
    now: Date,
  ): Promise<string[]> {
    const others = await this.subscriptions.lockOtherCurrent(trx, tenantId, keepId);
    const conflicting = others.filter(
      (other) => other.billing_provider === "stripe" && other.status !== "incomplete",
    );
    if (conflicting.length > 0) {
      throw new StripeEventFailure(
        "SUBSCRIPTION_CONFLICT",
        `the OTA has another current Stripe subscription (${conflicting.map((other) => other.id).join(", ")})`,
        { retryable: false, tenantId },
      );
    }
    const ids = others.map((other) => other.id);
    await this.subscriptions.supersede(trx, ids, now);
    return ids;
  }

  /** The `subscription.updated` audit row of a sync that changed something. */
  private async record(
    trx: PlatformTransaction,
    input: SubscriptionSyncInput,
    result: {
      readonly row: StripeSubscriptionRecord | undefined;
      readonly written: StripeSubscriptionRecord;
      readonly superseded: readonly string[];
      readonly rules: AppliedBillingRules;
    },
  ): Promise<void> {
    const { event, actor, tenant } = input;
    const { row, written, superseded, rules } = result;
    const fields =
      row === undefined
        ? { before: {}, after: viewOfRow(written) }
        : changedFields(viewOfRow(row), viewOfRow(written));
    const before: Record<string, unknown> = { ...fields.before };
    const after: Record<string, unknown> = { ...fields.after };
    if (rules.plan !== undefined) {
      before["tenantPlanCode"] = rules.plan.before;
      after["tenantPlanCode"] = rules.plan.after;
    }
    if (rules.billingNotice !== undefined) {
      before["billingNotice"] = rules.billingNotice.before;
      after["billingNotice"] = rules.billingNotice.after;
    }
    await this.audit.record(trx, {
      actorType: "system",
      actorLabel: BILLING_SYNC_LABEL,
      action: "subscription.updated",
      targetType: "subscription",
      targetId: written.id,
      tenantId: tenant.id,
      tenantKey: tenant.key,
      // A new row has no `before` of its own; the tenant's plan and banner before the change still have one.
      ...(Object.keys(before).length === 0 ? {} : { before }),
      after,
      details: {
        eventId: event.id,
        eventType: event.type,
        created: row === undefined,
        ...(superseded.length === 0 ? {} : { supersededSubscriptionIds: [...superseded] }),
        ...(rules.lifecycleJobId === undefined
          ? {}
          : { lifecycle: rules.effects.lifecycle, lifecycleJobId: rules.lifecycleJobId }),
        ...input.details,
      },
      ...(actor.type === "system" && actor.requestId !== undefined ? { requestId: actor.requestId } : {}),
    });
  }

  /**
   * Fails the event for good when the re-fetched `subscription` names another OTA than its row's `tenantId`: its
   * `metadata.velexis_tenant_id` (`TENANT_MISMATCH`), or a Customer that `billing_customers` stores for another OTA
   * (`CUSTOMER_CONFLICT`), as the completed Checkout's handler does. Nothing is written; an admin resolves it in Stripe.
   */
  private async assertSameTenant(
    trx: PlatformTransaction,
    subscription: Stripe.Subscription,
    tenantId: string,
  ): Promise<void> {
    const metadataTenant = velexisTenantIdOf(subscription.metadata);
    if (metadataTenant !== undefined && metadataTenant !== tenantId) {
      throw new StripeEventFailure(
        "TENANT_MISMATCH",
        "the subscription's metadata names another OTA than its row",
        { retryable: false, tenantId },
      );
    }
    const customerId = stripeIdOf(subscription.customer);
    const holder =
      customerId === undefined ? undefined : await this.customers.tenantOfCustomer(trx, customerId);
    if (holder !== undefined && holder !== tenantId) {
      throw new StripeEventFailure(
        "CUSTOMER_CONFLICT",
        "the subscription's Customer belongs to another OTA",
        { retryable: false, tenantId },
      );
    }
  }

  /** `tenantId` when it names a tenant (an ignored event may name it, `stripe_events.tenant_id`), else `null`. */
  private async knownTenant(tenantId: string | undefined): Promise<string | null> {
    return tenantId !== undefined && (await this.tenants.exists(tenantId)) ? tenantId : null;
  }
}
