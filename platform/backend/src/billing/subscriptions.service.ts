// The platform admin's subscriptions (platform/docs/api-inventory-admin.md §4, flows/subscription-billing.md §G,
// flows/platform-admin-operations.md §D; PADR-0002 items 6 and 9; scope PF-75): adminListSubscriptions,
// adminGetSubscription and adminUpdateManualSubscription. Who may call them is AdminAuthGuard's (`platform_admin`).
// This service owns the transaction of the manual edit, its audit row (`actor_type = 'platform_admin'`; `system` with
// the command's label when `tenants:create-demo` of dist/cli.js sets the demo OTA's subscription `active`, PBE-075) and
// the `tenant` invalidation after the commit.
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
//   `current_exists`; `subscriptions_current_uq` refuses a concurrent one the same way); `active` (MANUAL_PAID_STATUS:
//   paid outside Stripe, which go-live accepts; FIX-W48-PLATFORM, lead decision (15g) of 2026-11-11) does the same from
//   any status, and the OTA's trial banner goes with it, as the daily run would clear it (`manualTrialStep`; a banner
//   of another kind stays). Only the fields that differ from the stored ones are written (`version + 1`); a request that
//   changes nothing writes nothing.
// - Moving the end of a `past_due` manual trial to a later UTC day than today (without `status`, or with `trialing`)
//   reopens it (FIX-W41-PLATFORM, lead decision (2l) of 2026-11-04): the status becomes `trialing`, and the OTA's banner
//   (`tenants.billing_notice`) is what the daily run (`billing.manual_trials`, `manualTrialStep`) sets for a trial of
//   that end: `trial_ending` when the new end is within the notice window (14 days), cleared otherwise (a banner of
//   another kind stays). The audit row says so (`status` before and after, and `billingNotice` in its details when it
//   changed), and a changed banner publishes `tenant` after the commit, so the portal and the OTA admin follow.
// - The tenant's plan follows its current subscription: when the edited subscription is current after the edit
//   (trialing or past due) and its plan differs from `tenants.plan_code`, the tenant moves to it (`version + 1`) in the
//   same transaction and a `tenant` invalidation goes out after the commit, so the OTA backend reloads the quotas. A
//   plan change on a canceled subscription is history and leaves the tenant alone.
// - The edit locks the tenant's row first, then the subscription's (FIX-W30-PLATFORM, lead decision (2) of
//   2026-10-26): billing's lock order (flow §D), which billing sync keeps too, so an edit and a billing-sync write of
//   the same OTA (a completed Checkout replacing the manual trial) wait for each other in turn, never in a circle.
//
// - The resync (`adminResyncSubscription`, PBE-048; flow §D, PADR-0002 item 5) re-fetches a Stripe subscription and
//   applies billing sync's update path to its row (subscription-changed.handler.ts `resync`): under the subscription's
//   lock, the status rules included, with one `subscription.resynced` audit row of the admin. A manual subscription has
//   nothing to fetch (`409 CONFLICT`, `details.reason = manual`), nor has a Stripe row whose Checkout has not completed
//   (`details.reason = not_linked`). A billing-sync failure writes nothing and answers `409 CONFLICT` with its code in
//   lower case as `details.reason` (`unknown_price` for a price no plan links, `subscription_busy` while an event of the
//   subscription holds its lock, `tenant_mismatch`, …); a Stripe failure answers `502 PROVIDER_ERROR`. The answer is
//   the row as it is after the commit.
// - The invoices (`adminListInvoices`, and `invoices[]` of the detail) answer their amounts with the decimals of their
//   currency, as the portal's `listInvoices` does (`5000` JPY, `49.00` EUR; lead decision (2g) of 2026-11-04, PBE-048,
//   `invoiceMoney` of invoices.controller.ts). The list is newest first (issue date, an invoice without one last, then
//   creation, then id), with the filters `tenantId` and `status` and an opaque cursor of the last invoice's id.
//
// The tenant write needs TenantsModule's repository, a module of BillingModule's own layer (architecture §2.2), so
// AdminModule (layer 4) provides this service, as it provides ProvisioningJobsRepository; BillingModule provides
// PlansService. The resync's update path is billing sync's SubscriptionChangedHandler (layer 3), which AdminModule
// provides with what it needs.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import Stripe from "stripe";
import { AuditService, type AuditDetails } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { StripeNotConfiguredError } from "../common/stripe/stripe.client";
import { StripeEventFailure } from "../common/stripe/stripe-inbox.service";
import { TenantsRepository } from "../tenants/tenants.repository";
import { invoiceMoney } from "./invoices.controller";
import { PlansRepository } from "./plans.repository";
import { providerError, stripeBillingFailureOf } from "./stripe-billing.gateway";
import { SubscriptionChangedHandler } from "./sync/handlers/subscription-changed.handler";
import { manualTrialStep, utcDay } from "./sync/manual-trials.scheduler";
import {
  CURRENT_SUBSCRIPTION_INDEX,
  CURRENT_SUBSCRIPTION_STATUSES,
  MANUAL_PAID_STATUS,
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
export type AdminInvoiceList = components["schemas"]["AdminInvoiceList"];
export type AdminStripeEvent = components["schemas"]["AdminStripeEvent"];
export type UpdateManualSubscriptionRequest = components["schemas"]["UpdateManualSubscriptionRequest"];

/**
 * Who makes a manual edit: a platform admin (adminUpdateManualSubscription, the access token's `sub`; audited as
 * `platform_admin`), or a command of dist/cli.js (PBE-075: `tenants:create-demo` sets the demo OTA's subscription
 * `active`; audited as `system` with the command's label, and its `details` beside the reason).
 */
export type ManualSubscriptionActor =
  | Pick<AccessTokenClaims, "sub">
  | { readonly system: { readonly label: string; readonly details: AuditDetails } };

/** The query of `adminListSubscriptions`, as the validation interceptor coerced it (`limit` defaults to 50). */
export interface ListSubscriptionsQuery {
  readonly status?: AdminSubscription["status"] | undefined;
  readonly provider?: AdminSubscription["billingProvider"] | undefined;
  readonly planCode?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The query of `adminListInvoices`, as the validation interceptor coerced it (`limit` defaults to 50). */
export interface ListInvoicesQuery {
  readonly tenantId?: string | undefined;
  readonly status?: AdminInvoice["status"] | undefined;
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

/**
 * The admin's invoice of a row: amounts as `Money` in the invoice currency, with the currency's decimals as the
 * portal's `listInvoices` answers them (`invoiceMoney`, lead decision (2g) of 2026-11-04).
 */
export function toAdminInvoice(row: InvoiceRow): AdminInvoice {
  const money = (stored: string) => invoiceMoney(stored, row.currency, row.minor_units);
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

/** An opaque cursor: base64url of `{"id": "<id>"}`, the last row of the page. */
export function encodeIdCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

/** The id of a cursor made by `encodeIdCursor` when it matches `pattern`, or `undefined` when it is not one. */
export function decodeIdCursor(cursor: string, pattern: RegExp): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const id: unknown = (value as Record<string, unknown>)["id"];
    return Object.keys(value).length === 1 && typeof id === "string" && pattern.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** An opaque cursor: base64url of `{"id": "<subscription id>"}`, the last subscription of the page. */
export function encodeSubscriptionCursor(subscriptionId: string): string {
  return encodeIdCursor(subscriptionId);
}

const SUBSCRIPTION_ID = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;
const INVOICE_ID = /^inv_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The subscription id of a cursor of this list, or `undefined` when it is not one. */
export function decodeSubscriptionCursor(cursor: string): string | undefined {
  return decodeIdCursor(cursor, SUBSCRIPTION_ID);
}

/** An opaque cursor of the admin's invoice list: base64url of `{"id": "<invoice id>"}`, the page's last invoice. */
export function encodeInvoiceCursor(invoiceId: string): string {
  return encodeIdCursor(invoiceId);
}

/** The invoice id of a cursor of the admin's invoice list, or `undefined` when it is not one. */
export function decodeInvoiceCursor(cursor: string): string | undefined {
  return decodeIdCursor(cursor, INVOICE_ID);
}

/**
 * The answer to a failed resync (file header): `409 CONFLICT` with the billing-sync failure's code in lower case, or
 * `502 PROVIDER_ERROR` for a Stripe failure; anything else as it is.
 */
export function resyncError(error: unknown): unknown {
  if (error instanceof StripeEventFailure) {
    return new AppError("CONFLICT", { details: { reason: error.code.toLowerCase() } });
  }
  if (error instanceof Stripe.errors.StripeError || error instanceof StripeNotConfiguredError) {
    return providerError(stripeBillingFailureOf("subscriptions.retrieve", error));
  }
  return error;
}

export function invalidCursor(): AppError<"VALIDATION_FAILED"> {
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
    private readonly sync: SubscriptionChangedHandler,
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
   * adminResyncSubscription: the Stripe subscription of the row `subscriptionId` re-fetched and applied by billing
   * sync's update path, with the admin's `subscription.resynced` audit row (file header). `404` for an unknown row,
   * `409` for a manual one, one without a Stripe subscription or a billing-sync failure, `502` when Stripe fails.
   */
  async resync(claims: Pick<AccessTokenClaims, "sub">, subscriptionId: string): Promise<AdminSubscription> {
    const row = await this.subscriptions.findAdmin(subscriptionId);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (row.billing_provider !== "stripe") {
      throw new AppError("CONFLICT", { details: { reason: "manual" } });
    }
    if (row.provider_subscription_id === null) {
      throw new AppError("CONFLICT", { details: { reason: "not_linked" } });
    }
    try {
      await this.sync.resync(
        { id: row.id, tenantId: row.tenant_id, providerSubscriptionId: row.provider_subscription_id },
        claims.sub,
      );
    } catch (error) {
      throw resyncError(error);
    }
    const synced = await this.subscriptions.findAdmin(row.id);
    if (synced === undefined) {
      throw new Error(`subscription ${row.id} vanished after its resync`);
    }
    return toAdminSubscription(synced);
  }

  /** adminListInvoices: one page of invoices, newest first, with the filters of the query (file header). */
  async listInvoices(query: ListInvoicesQuery): Promise<AdminInvoiceList> {
    const limit = query.limit ?? DEFAULT_SUBSCRIPTION_PAGE_LIMIT;
    let afterId: string | undefined;
    if (query.cursor !== undefined) {
      afterId = decodeInvoiceCursor(query.cursor);
      if (afterId === undefined || !(await this.subscriptions.invoiceExists(afterId))) {
        throw invalidCursor();
      }
    }
    const rows = await this.subscriptions.listInvoicesAdmin(
      { tenantId: query.tenantId, status: query.status },
      afterId,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAdminInvoice),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeInvoiceCursor(last.id) : null,
        limit,
      },
    };
  }

  /**
   * adminUpdateManualSubscription: the changes of `request` that differ from the stored row, with `version + 1`, one
   * `subscription.manually_updated` audit row holding the reason, the changed fields before and after and, when the
   * tenant's plan followed, its plan before and after, and a `tenant` invalidation after the commit in that case. The
   * tenant's row is locked before the subscription's (file header). `actor` is the admin, or a CLI command (PBE-075).
   */
  async updateManual(
    actor: ManualSubscriptionActor,
    subscriptionId: string,
    version: number,
    request: UpdateManualSubscriptionRequest,
  ): Promise<AdminSubscription> {
    const now = this.clock.now();
    return runInTransaction(this.db, async (trx) => {
      // Billing's lock order (file header): the tenant's row, then the subscription's.
      const ref = await this.subscriptions.findRef(subscriptionId, trx);
      const tenant = ref === undefined ? undefined : await this.tenants.lockForUpdate(trx, ref.tenant_id);
      if (tenant === undefined) {
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
        // `trialing` and `active` make the subscription current again: no second current one for the OTA.
        if (CURRENT.has(request.status) && !CURRENT.has(current.status)) {
          if (await this.subscriptions.hasOtherCurrent(trx, current.tenant_id, current.id)) {
            throw currentExists();
          }
        }
        changes.status = request.status;
        changes.canceled_at = request.status === "canceled" ? now : null;
        before["status"] = current.status;
        after["status"] = request.status;
      }
      // A past-due trial whose end moves to a later UTC day than today is open again (file header).
      const reopened =
        current.status === "past_due" &&
        changes.trial_ends_at !== undefined &&
        utcDay(changes.trial_ends_at) > utcDay(now) &&
        (request.status === undefined || request.status === "trialing");
      if (reopened && changes.status === undefined) {
        changes.status = "trialing";
        changes.canceled_at = null;
        before["status"] = current.status;
        after["status"] = "trialing";
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
        // The banner the daily run sets for the reopened trial (`trial_ending` within the notice window, else none), or
        // for a subscription paid outside Stripe (no trial banner).
        const paid = changes.status === MANUAL_PAID_STATUS;
        const billingNotice =
          reopened || paid
            ? manualTrialStep(
                {
                  status: paid ? MANUAL_PAID_STATUS : "trialing",
                  trialEndsAt: changes.trial_ends_at ?? current.trial_ends_at,
                  updatedAt: now,
                  billingNotice: tenant.billing_notice,
                },
                now,
              ).billingNotice
            : tenant.billing_notice;
        const billingNoticeChanged =
          billingNotice !== tenant.billing_notice &&
          (await this.tenants.setBillingNotice(trx, current.tenant_id, billingNotice, now));
        // An actor with a `sub` (the admin's token claims, whatever else they hold) is always the admin; only the
        // command's actor, which has none, is audited as `system` (PBE-075).
        const by =
          "sub" in actor
            ? { actor: { actorType: "platform_admin", actorAccountId: actor.sub } as const, details: {} }
            : {
                actor: { actorType: "system", actorLabel: actor.system.label } as const,
                details: actor.system.details,
              };
        await this.audit.record(trx, {
          ...by.actor,
          action: "subscription.manually_updated",
          targetType: "subscription",
          targetId: current.id,
          tenantId: current.tenant_id,
          before,
          after,
          details: {
            ...by.details,
            reason: request.reason,
            ...(tenantPlanChanged ? { tenantPlan: { before: tenantPlanBefore, after: planCode } } : {}),
            ...(billingNoticeChanged
              ? { billingNotice: { before: tenant.billing_notice, after: billingNotice } }
              : {}),
          },
        });
        if (tenantPlanChanged || billingNoticeChanged) {
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
