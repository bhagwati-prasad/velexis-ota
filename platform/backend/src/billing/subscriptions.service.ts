// The platform admin's subscriptions (platform/docs/api-inventory-admin.md §4, flows/subscription-billing.md §G,
// flows/platform-admin-operations.md §D; PADR-0002 items 6 and 9; scope PF-75): adminListSubscriptions,
// adminGetSubscription and adminUpdateManualSubscription. Who may call them is AdminAuthGuard's (`platform_admin`).
// This service owns the transaction of the manual edit, its audit row (`actor_type = 'platform_admin'`) and the
// `tenant` invalidation after the commit.
//
// - The list holds every subscription row, current or ended, newest first (`created_at`, then id), with the filters
//   `status`, `provider` and `planCode` and an opaque cursor of the last row's id (`400 VALIDATION_FAILED`,
//   `/query/cursor`, for any other value).
// - The detail adds the subscription's invoices and the Stripe events of its OTA, newest first and at most 50 each;
//   both are empty before M5, when every subscription is a manual trial. Its `ETag` is the subscription's version.
// - The manual edit changes a `manual` subscription only (`409 CONFLICT`, `details.reason = stripe_billed`, for one
//   billed by Stripe, whose plan and status change in the Customer Portal or with the M5 resync), with `If-Match`
//   (`412 PRECONDITION_FAILED`) and a reason (the OpenAPI schema requires 5–500 characters) that the audit row keeps in
//   its `details`. It may set the plan (an active plan, public or not; `422 UNPROCESSABLE`, `plan_not_active`, for an
//   unknown or retired one), the end of the trial, or the status: `canceled` sets `canceled_at`; `trialing` reopens
//   the subscription and clears `canceled_at`, unless the OTA has another current subscription (`409 CONFLICT`,
//   `current_exists`; `subscriptions_current_uq` refuses a concurrent one the same way). Only the fields that differ
//   from the stored ones are written (`version + 1`); a request that changes nothing writes nothing.
// - The tenant's plan follows its current subscription: when the edited subscription is current after the edit
//   (trialing or past due) and its plan differs from `tenants.plan_code`, the tenant moves to it (`version + 1`) in the
//   same transaction and a `tenant` invalidation goes out after the commit, so the OTA backend reloads the quotas. A
//   plan change on a canceled subscription is history and leaves the tenant alone.
// - The edit locks the tenant's row first, then the subscription's (FIX-W30-PLATFORM, lead decision (2) of
//   2026-10-26): billing's lock order (flow §D), which billing sync keeps too, so an edit and a billing-sync write of
//   the same OTA (a completed Checkout replacing the manual trial) wait for each other in turn, never in a circle.
//
// The tenant write needs TenantsModule's repository, a module of BillingModule's own layer (architecture §2.2), so
// AdminModule (layer 4) provides this service, as it provides ProvisioningJobsRepository; BillingModule provides
// PlansService.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { TenantsRepository } from "../tenants/tenants.repository";
import { PlansRepository } from "./plans.repository";
import {
  CURRENT_SUBSCRIPTION_INDEX,
  CURRENT_SUBSCRIPTION_STATUSES,
  SubscriptionsRepository,
  type AdminSubscriptionRow,
  type InvoiceRow,
  type ManualSubscriptionChanges,
  type StripeEventRow,
} from "./subscriptions.repository";

export type AdminSubscription = components["schemas"]["AdminSubscription"];
export type AdminSubscriptionList = components["schemas"]["AdminSubscriptionList"];
export type AdminSubscriptionDetail = components["schemas"]["AdminSubscriptionDetail"];
export type AdminInvoice = components["schemas"]["AdminInvoice"];
export type AdminStripeEvent = components["schemas"]["AdminStripeEvent"];
export type UpdateManualSubscriptionRequest = components["schemas"]["UpdateManualSubscriptionRequest"];

/** The query of `adminListSubscriptions`, as the validation interceptor coerced it (`limit` defaults to 50). */
export interface ListSubscriptionsQuery {
  readonly status?: AdminSubscription["status"] | undefined;
  readonly provider?: AdminSubscription["billingProvider"] | undefined;
  readonly planCode?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The page size without `limit` (the document's default). */
export const DEFAULT_SUBSCRIPTION_PAGE_LIMIT = 50;

/** The most invoices and Stripe events of a subscription's detail (`maxItems` of AdminSubscriptionDetail). */
export const SUBSCRIPTION_HISTORY_LIMIT = 50;

/** The longest `lastError` of an AdminStripeEvent (`maxLength`). */
const LAST_ERROR_MAX_LENGTH = 1000;

const UNIQUE_VIOLATION = "23505";
const CURRENT: ReadonlySet<string> = new Set(CURRENT_SUBSCRIPTION_STATUSES);

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The admin's subscription of a row. */
export function toAdminSubscription(row: AdminSubscriptionRow): AdminSubscription {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantKey: row.tenant_key,
    tenantName: row.tenant_name,
    planCode: row.plan_code,
    planName: row.plan_name,
    status: row.status as AdminSubscription["status"],
    billingProvider: row.billing_provider as AdminSubscription["billingProvider"],
    billingInterval: row.billing_interval as AdminSubscription["billingInterval"],
    trialEndsAt: iso(row.trial_ends_at),
    currentPeriodStart: iso(row.current_period_start),
    currentPeriodEnd: iso(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    canceledAt: iso(row.canceled_at),
    providerCustomerId: row.provider_customer_id,
    providerSubscriptionId: row.provider_subscription_id,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

/** The admin's invoice of a row: amounts as `Money` in the invoice currency. */
export function toAdminInvoice(row: InvoiceRow): AdminInvoice {
  const money = (amount: string) => ({ amount, currency: row.currency });
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    number: row.number,
    status: row.status as AdminInvoice["status"],
    subtotal: money(row.subtotal),
    taxAmount: money(row.tax_amount),
    total: money(row.total),
    amountPaid: money(row.amount_paid),
    amountDue: money(row.amount_due),
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    issuedAt: iso(row.issued_at),
    dueAt: iso(row.due_at),
    paidAt: iso(row.paid_at),
    hostedInvoiceUrl: row.hosted_invoice_url,
    invoicePdfUrl: row.invoice_pdf_url,
    providerInvoiceId: row.provider_invoice_id,
    createdAt: row.created_at.toISOString(),
  };
}

/** The admin's Stripe event of an inbox row: ids, type and state; `lastError` cut to its 1000 characters. */
export function toAdminStripeEvent(row: StripeEventRow): AdminStripeEvent {
  return {
    id: row.id,
    endpoint: row.endpoint as AdminStripeEvent["endpoint"],
    type: row.type,
    status: row.status as AdminStripeEvent["status"],
    attempts: row.attempts,
    lastError: row.last_error === null ? null : row.last_error.slice(0, LAST_ERROR_MAX_LENGTH),
    tenantId: row.tenant_id,
    receivedAt: row.received_at.toISOString(),
    processedAt: iso(row.processed_at),
  };
}

/** An opaque cursor: base64url of `{"id": "<subscription id>"}`, the last subscription of the page. */
export function encodeSubscriptionCursor(subscriptionId: string): string {
  return Buffer.from(JSON.stringify({ id: subscriptionId }), "utf8").toString("base64url");
}

const SUBSCRIPTION_ID = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The subscription id of a cursor of this list, or `undefined` when it is not one. */
export function decodeSubscriptionCursor(cursor: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const id: unknown = (value as Record<string, unknown>)["id"];
    return Object.keys(value).length === 1 && typeof id === "string" && SUBSCRIPTION_ID.test(id)
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

function invalidCursor(): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "Is not a cursor of this list." }],
  });
}

function currentExists(): AppError<"CONFLICT"> {
  return new AppError("CONFLICT", { details: { reason: "current_exists" } });
}

/** True for the `pg` error of a second current subscription of a tenant (Kysely passes it through). */
function isCurrentSubscriptionConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === CURRENT_SUBSCRIPTION_INDEX;
}

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly subscriptions: SubscriptionsRepository,
    private readonly plans: PlansRepository,
    private readonly tenants: TenantsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** adminListSubscriptions: one page of subscriptions, newest first, with the filters of the query. */
  async list(query: ListSubscriptionsQuery): Promise<AdminSubscriptionList> {
    const limit = query.limit ?? DEFAULT_SUBSCRIPTION_PAGE_LIMIT;
    let afterId: string | undefined;
    if (query.cursor !== undefined) {
      afterId = decodeSubscriptionCursor(query.cursor);
      if (afterId === undefined || !(await this.subscriptions.exists(afterId))) {
        throw invalidCursor();
      }
    }
    const rows = await this.subscriptions.listAdmin(
      { status: query.status, provider: query.provider, planCode: query.planCode },
      afterId,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAdminSubscription),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeSubscriptionCursor(last.id) : null,
        limit,
      },
    };
  }

  /** adminGetSubscription: the subscription with its invoices and its OTA's Stripe events; `404` when unknown. */
  async get(subscriptionId: string): Promise<AdminSubscriptionDetail> {
    const row = await this.subscriptions.findAdmin(subscriptionId);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const [invoices, events] = await Promise.all([
      this.subscriptions.invoicesOf(row.id, SUBSCRIPTION_HISTORY_LIMIT),
      this.subscriptions.stripeEventsOf(row.tenant_id, SUBSCRIPTION_HISTORY_LIMIT),
    ]);
    return {
      subscription: toAdminSubscription(row),
      invoices: invoices.map(toAdminInvoice),
      events: events.map(toAdminStripeEvent),
    };
  }

  /**
   * adminUpdateManualSubscription: the changes of `request` that differ from the stored row, with `version + 1`, one
   * `subscription.manually_updated` audit row holding the reason, the changed fields before and after and, when the
   * tenant's plan followed, its plan before and after, and a `tenant` invalidation after the commit in that case. The
   * tenant's row is locked before the subscription's (file header).
   */
  async updateManual(
    claims: Pick<AccessTokenClaims, "sub">,
    subscriptionId: string,
    version: number,
    request: UpdateManualSubscriptionRequest,
  ): Promise<AdminSubscription> {
    const now = this.clock.now();
    return runInTransaction(this.db, async (trx) => {
      // Billing's lock order (file header): the tenant's row, then the subscription's.
      const ref = await this.subscriptions.findRef(subscriptionId, trx);
      if (ref === undefined || (await this.tenants.lockForUpdate(trx, ref.tenant_id)) === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const current = await this.subscriptions.lockForUpdate(trx, subscriptionId);
      if (current === undefined) {
        throw new AppError("NOT_FOUND");
      }
      if (current.version !== version) {
        throw new AppError("PRECONDITION_FAILED");
      }
      if (current.billing_provider !== "manual") {
        throw new AppError("CONFLICT", { details: { reason: "stripe_billed" } });
      }

      const changes: ManualSubscriptionChanges = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (request.planCode !== undefined && request.planCode !== current.plan_code) {
        if (!(await this.plans.isActive(request.planCode, trx))) {
          throw new AppError("UNPROCESSABLE", { details: { reason: "plan_not_active" } });
        }
        changes.plan_code = request.planCode;
        before["planCode"] = current.plan_code;
        after["planCode"] = request.planCode;
      }
      if (request.trialEndsAt !== undefined) {
        const trialEndsAt = new Date(request.trialEndsAt);
        if (current.trial_ends_at?.getTime() !== trialEndsAt.getTime()) {
          changes.trial_ends_at = trialEndsAt;
          before["trialEndsAt"] = iso(current.trial_ends_at);
          after["trialEndsAt"] = trialEndsAt.toISOString();
        }
      }
      if (request.status !== undefined && request.status !== current.status) {
        if (request.status === "trialing" && !CURRENT.has(current.status)) {
          if (await this.subscriptions.hasOtherCurrent(trx, current.tenant_id, current.id)) {
            throw currentExists();
          }
        }
        changes.status = request.status;
        changes.canceled_at = request.status === "canceled" ? now : null;
        before["status"] = current.status;
        after["status"] = request.status;
      }

      if (Object.keys(changes).length > 0) {
        try {
          await this.subscriptions.updateManual(trx, current.id, changes, now);
        } catch (error) {
          throw isCurrentSubscriptionConflict(error) ? currentExists() : error;
        }
        const status = changes.status ?? current.status;
        const planCode = changes.plan_code ?? current.plan_code;
        const tenantPlanBefore = CURRENT.has(status)
          ? await this.tenants.setPlanCode(trx, current.tenant_id, planCode, now)
          : undefined;
        const tenantPlanChanged = tenantPlanBefore !== undefined;
        await this.audit.record(trx, {
          actorType: "platform_admin",
          actorAccountId: claims.sub,
          action: "subscription.manually_updated",
          targetType: "subscription",
          targetId: current.id,
          tenantId: current.tenant_id,
          before,
          after,
          details: {
            reason: request.reason,
            ...(tenantPlanChanged ? { tenantPlan: { before: tenantPlanBefore, after: planCode } } : {}),
          },
        });
        if (tenantPlanChanged) {
          this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: current.tenant_id });
        }
      }

      const row = await this.subscriptions.findAdmin(current.id, trx);
      if (row === undefined) {
        throw new Error(`subscription ${current.id} vanished inside its own transaction`);
      }
      return toAdminSubscription(row);
    });
  }
}
