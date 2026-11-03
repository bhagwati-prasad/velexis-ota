// `invoice.finalized`, `invoice.paid`, `invoice.payment_failed` and `invoice.voided` of the billing endpoint (PBE-046;
// subscription-billing flow §D, invoice row, PADR-0002 items 5 and 8, ADR-0013, ADR-0017 "Platform invoices", scope
// PF-73 AC2): Velexis's invoices to the OTAs are Stripe's, and billing sync copies each one into `invoices`, keyed by
// its `provider_invoice_id`, for the portal's list (`listInvoices`, invoices.controller.ts).
//
// The handler never trusts the payload or the order of events (PADR-0002 item 5): it re-fetches the invoice
// (`invoices.retrieve(event.objectId)`) before any transaction, so a duplicate or a late event writes Stripe's current
// state again, and any order of events ends with the same row. Two events of one invoice whose re-fetches overlap in
// the worker (concurrency 2) could still commit the older answer last, so (PADR-0002 item 5, revision of 2026-10-27,
// lead decision (2) of 2026-10-27):
//
// - **An invoice of a subscription** is written under the lock of that subscription (subscription-lock.ts,
//   `SubscriptionSyncLock`), the lock its own events take too. An invoice's subscription never changes, so a first
//   retrieve names it; then the handler takes the lock, re-fetches the invoice under it (the answer it writes) and
//   confirms the lock in the transaction just before the commit (`SUBSCRIPTION_LOCK_LOST`, retryable, writes nothing
//   when it is no longer this event's). Another event of the subscription waits for it (`SUBSCRIPTION_BUSY` after
//   30 s) and re-fetches after that commit, so the row ends in Stripe's newest state.
// - **An invoice without a subscription** (a one-off invoice, which Velexis does not create in the MVP) takes no lock;
//   its upsert keeps the newest state instead. `provider_synced_at` stores when the re-fetch whose answer the row
//   holds was started (the worker's Clock, taken just before the call), and a write whose re-fetch started before the
//   stored one is skipped. Stripe answers a re-fetch that starts after a change with that change, and every change
//   sends an event whose re-fetch starts after it, so the row ends with the answer of the latest re-fetch, which is
//   Stripe's newest state, whichever of two overlapping re-fetches commits last (`invoices.int.test.ts` shows it).
//   The worker runs on one VM, so the starts compare on one clock. The tenant's row lock below serialises the reads
//   and writes of the comparison.
//
// Then one transaction (`runInTransaction`) after the re-fetch:
//
// 1. The OTA: the one whose Stripe Customer the invoice names (`billing_customers`), else the OTA of the subscription's
//    row, else `velexis_tenant_id` of the subscription's metadata that the invoice carries
//    (`parent.subscription_details.metadata`). When two of them name different OTAs, the event fails for good
//    (`TENANT_MISMATCH`) and writes nothing; an admin resolves it in Stripe. No OTA ends the event `ignored`
//    (`UNKNOWN_TENANT`), as does an OTA that is deleted or being deleted (`TENANT_NOT_BILLABLE`) and a draft invoice,
//    which has no number yet (`INVOICE_DRAFT`; Stripe sends the four events only for finalized invoices).
// 2. The tenant's row is locked first (`FOR UPDATE`, billing's lock order, flow §D), then the stored invoice
//    (`FOR UPDATE`). A stored invoice of another OTA fails for good (`TENANT_MISMATCH`).
// 3. The state (`invoiceStateOf`): `number`, status, the currency (upper case) and the amounts, converted from Stripe's
//    minor units with the currency's exponent from `reference.currencies` (minor-units.ts, decimal.js; a currency it
//    lacks fails for good with `UNKNOWN_CURRENCY`, an amount the `numeric(12,2)` columns cannot hold exactly with
//    `UNSUPPORTED_AMOUNT`): `total`; `subtotal` = `total_excluding_tax` (after discounts, before tax) and `tax_amount` =
//    `total − total_excluding_tax`, so `invoices_total_ck` (`total = subtotal + tax_amount`) holds with discounts and
//    inclusive taxes too; `amount_paid`; `amount_due` = `amount_remaining` (what is still due, 0 once paid). The billed
//    period is the span of the invoice's lines (`lines.data[].period`: the subscription period it charges, in advance),
//    else the invoice's own `period_start` and `period_end`; issued = `effective_at`, else `status_transitions.
//    finalized_at`; due = `due_date`; paid = `status_transitions.paid_at`; the Stripe-hosted page and PDF.
// 4. The row is inserted (`inv_…`), or updated when anything differs (`updated_at` then), always with
//    `provider_synced_at`. `subscription_id` links the OTA's row of the subscription (its Stripe row, else the
//    pre-inserted row that `velexis_subscription_id` names); an unknown one keeps the stored link. Another invoice with
//    the same number fails for good (`INVOICE_NUMBER_CONFLICT`).
// 5. `invoice.payment_failed`, while the re-fetched invoice is still unpaid (`open` or `uncollectible`) and its write
//    was not skipped: `billing.payment_failed` (PADR-0013 item 5) is queued to every active owner of the OTA, once per
//    owner, invoice and payment attempt (`attempt_count`), in the transaction, besides Stripe's own e-mail. A failure
//    that the owner has paid since sends nothing.
//
// Invoices are a copy of Stripe's: no audit row is written (the audit catalogue, PADR-0006 item 6, has no invoice
// action); the event row (`stripe_events`) and the log line record the sync. The event resolves to the tenant. Log
// lines carry ids and statuses, never an amount, an e-mail address or a payload.
import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type Stripe from "stripe";
import type { PlatformTransaction } from "../../../audit/audit.repository";
import { Clock } from "../../../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../../../common/database";
import { IdGenerator } from "../../../common/ids";
import { runInTransaction } from "../../../common/redis/invalidation.publisher";
import { StripeClient } from "../../../common/stripe/stripe.client";
import {
  HandlesStripeEvents,
  StripeEventFailure,
  type StripeEventHandler,
  type StripeEventOutcome,
  type StripeInboxEvent,
} from "../../../common/stripe/stripe-inbox.service";
import { OutboxService } from "../../../notifications/outbox.service";
import { isShownTenantStatus } from "../../../provisioning/suspension.service";
import { TenantsRepository, type TenantRecord } from "../../../tenants/tenants.repository";
import { BillingCustomersRepository } from "../../billing-customers.repository";
import {
  INVOICE_STATUSES,
  invoiceDiffers,
  InvoicesRepository,
  type InvoiceRecord,
  type InvoiceState,
  type InvoiceStatus,
} from "../../invoices.repository";
import {
  BillingMoney,
  fromMinorUnits,
  MinorUnitsError,
  toCurrencyAmount,
  toStoredAmount,
} from "../../minor-units";
import { SubscriptionSyncLock, type HeldSubscriptionLock } from "../subscription-lock";
import {
  STRIPE_SUBSCRIPTION_ID,
  stripeIdOf,
  velexisSubscriptionIdOf,
  velexisTenantIdOf,
} from "./subscription-changed.handler";

/** The event types of this handler. */
export const INVOICE_EVENT_TYPES = Object.freeze([
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
] as const);

/** The e-mail to the owners when Stripe could not collect an invoice (PADR-0013 item 5). */
export const PAYMENT_FAILED_TEMPLATE = "billing.payment_failed";

/** A Stripe invoice id (`in_`, letters, digits, underscores). */
export const STRIPE_INVOICE_ID = /^in_[A-Za-z0-9_]{1,250}$/;

/** An ISO 4217 code as `invoices.currency` allows it. */
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** The statuses of an invoice that is still to be paid: a failed payment e-mails the owners about it. */
const UNPAID_STATUSES: ReadonlySet<InvoiceStatus> = new Set(["open", "uncollectible"]);

const STATUSES: ReadonlySet<string> = new Set(INVOICE_STATUSES);

/** A Stripe timestamp (Unix seconds) as a Date; `null` for none. */
function dateOf(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

/**
 * The Stripe subscription `invoice` belongs to (`parent.subscription_details.subscription`); `undefined` for an
 * invoice without one. Throws StripeEventFailure (not retryable) for a subscription id of another shape.
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const reference = invoice.parent?.subscription_details?.subscription;
  const id = stripeIdOf(reference ?? null);
  if (id === undefined) {
    return undefined;
  }
  if (!STRIPE_SUBSCRIPTION_ID.test(id)) {
    throw new StripeEventFailure("INVALID_SUBSCRIPTION", "the invoice's subscription is not a sub_ id", {
      retryable: false,
    });
  }
  return id;
}

/** The subscription's metadata the invoice carries (`parent.subscription_details.metadata`). */
function subscriptionMetadataOf(invoice: Stripe.Invoice): Stripe.Metadata | null {
  return invoice.parent?.subscription_details?.metadata ?? null;
}

/** The invoice's currency in upper case; throws StripeEventFailure (not retryable) for another shape. */
export function invoiceCurrency(invoice: Stripe.Invoice): string {
  const currency = typeof invoice.currency === "string" ? invoice.currency.toUpperCase() : "";
  if (!CURRENCY_CODE.test(currency)) {
    throw new StripeEventFailure("UNKNOWN_CURRENCY", "the invoice's currency is not an ISO 4217 code", {
      retryable: false,
    });
  }
  return currency;
}

/** The billed period: the span of the invoice's lines, else the invoice's own `period_start` and `period_end`. */
function periodOf(invoice: Stripe.Invoice): { readonly start: Date | null; readonly end: Date | null } {
  const periods = invoice.lines.data
    .map((line) => line.period)
    .filter((period) => Number.isFinite(period.start) && Number.isFinite(period.end));
  if (periods.length === 0) {
    return { start: dateOf(invoice.period_start), end: dateOf(invoice.period_end) };
  }
  return {
    start: dateOf(Math.min(...periods.map((period) => period.start))),
    end: dateOf(Math.max(...periods.map((period) => period.end))),
  };
}

/** The `numeric(12,2)` text of `minor` Stripe minor units with `exponent`. */
const storedAmount = (minor: number, exponent: number): string =>
  toStoredAmount(fromMinorUnits(minor, exponent));

/** The amounts of an invoice row: `numeric(12,2)` text, with `total = subtotal + taxAmount` (file header, step 3). */
type InvoiceAmounts = Pick<InvoiceState, "subtotal" | "taxAmount" | "total" | "amountPaid" | "amountDue">;

/**
 * The amounts of `invoice` converted with `exponent` (step 3 of the file header). Throws StripeEventFailure
 * `UNSUPPORTED_AMOUNT` (not retryable) for an amount the `numeric(12,2)` columns cannot hold exactly.
 */
function amountsOf(invoice: Stripe.Invoice, exponent: number, tenantId: string): InvoiceAmounts {
  try {
    const total = storedAmount(invoice.total, exponent);
    // Before tax and after discounts; without Stripe's figure, the total less the invoice's taxes.
    const taxes = (invoice.total_taxes ?? []).reduce(
      (sum, tax) => sum.plus(fromMinorUnits(tax.amount, exponent)),
      new BillingMoney(0),
    );
    const subtotal =
      invoice.total_excluding_tax === null
        ? toStoredAmount(new BillingMoney(total).minus(taxes).toFixed())
        : storedAmount(invoice.total_excluding_tax, exponent);
    return {
      subtotal,
      taxAmount: toStoredAmount(new BillingMoney(total).minus(subtotal).toFixed()),
      total,
      amountPaid: storedAmount(invoice.amount_paid, exponent),
      amountDue: storedAmount(invoice.amount_remaining, exponent),
    };
  } catch (error) {
    if (error instanceof MinorUnitsError) {
      throw new StripeEventFailure("UNSUPPORTED_AMOUNT", error.message, { retryable: false, tenantId });
    }
    throw error;
  }
}

/**
 * The state of the finalized `invoice` (a number) that its row keeps (step 3 of the file header), its amounts converted
 * with `exponent`, the currency's in `reference.currencies`. Throws StripeEventFailure (not retryable) for a status the
 * table does not know or an amount it cannot hold exactly.
 */
export function invoiceStateOf(
  invoice: Stripe.Invoice & { readonly number: string },
  exponent: number,
  tenantId: string,
): InvoiceState {
  const status = invoice.status;
  if (status === null || !STATUSES.has(status)) {
    throw new StripeEventFailure("UNSUPPORTED_INVOICE", "the invoice's status is not one Velexis stores", {
      retryable: false,
      tenantId,
    });
  }
  const amounts = amountsOf(invoice, exponent, tenantId);
  const period = periodOf(invoice);
  return {
    number: invoice.number,
    status: status as InvoiceStatus,
    currency: invoiceCurrency(invoice),
    ...amounts,
    periodStart: period.start,
    periodEnd: period.end,
    issuedAt: dateOf(invoice.effective_at ?? invoice.status_transitions.finalized_at),
    dueAt: dateOf(invoice.due_date),
    paidAt: dateOf(invoice.status_transitions.paid_at),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
  };
}

/** The OTAs an invoice names, by where they come from (step 1 of the file header). */
export interface InvoiceTenantClaims {
  /** The OTA whose Stripe Customer the invoice names (`billing_customers`). */
  readonly customer: string | undefined;
  /** The OTA of the subscription's row (`subscriptions.provider_subscription_id`). */
  readonly subscription: string | undefined;
  /** `velexis_tenant_id` of the subscription's metadata on the invoice. */
  readonly metadata: string | undefined;
}

/**
 * The OTA of an invoice: the Customer's, else the subscription row's, else the metadata's; `undefined` for none. Throws
 * StripeEventFailure `TENANT_MISMATCH` (not retryable) when two of them name different OTAs.
 */
export function invoiceTenantOf(claims: InvoiceTenantClaims): string | undefined {
  const named = [claims.customer, claims.subscription, claims.metadata].filter(
    (tenantId): tenantId is string => tenantId !== undefined,
  );
  const [first] = named;
  if (named.some((tenantId) => tenantId !== first)) {
    throw new StripeEventFailure(
      "TENANT_MISMATCH",
      "the invoice's Customer, subscription and metadata name different OTAs",
      { retryable: false, tenantId: first },
    );
  }
  return first;
}

/** How the handler's write of one re-fetch is serialised (file header). */
interface SyncContext {
  /** The Stripe subscription whose lock this event holds; `undefined` for an invoice without one. */
  readonly subscriptionId: string | undefined;
  /** The held lock, confirmed just before the commit; `undefined` without a subscription. */
  readonly held: HeldSubscriptionLock | undefined;
  /** When the re-fetch whose answer is written started (`provider_synced_at`). */
  readonly syncedAt: Date;
}

/** What a write did, for the log line. */
interface InvoiceWriteResult {
  readonly row: InvoiceRecord | undefined;
  readonly created: boolean;
  readonly changed: boolean;
  /** True when a newer re-fetch had committed already (an invoice without a subscription): nothing was written. */
  readonly stale: boolean;
  readonly emailed: number;
}

@Injectable()
@HandlesStripeEvents("billing", INVOICE_EVENT_TYPES)
export class InvoiceHandler implements StripeEventHandler {
  constructor(
    private readonly stripe: StripeClient,
    private readonly invoices: InvoicesRepository,
    private readonly customers: BillingCustomersRepository,
    private readonly tenants: TenantsRepository,
    private readonly outbox: OutboxService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly lock: SubscriptionSyncLock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(InvoiceHandler.name) private readonly logger: PinoLogger,
  ) {}

  async handle(event: StripeInboxEvent): Promise<StripeEventOutcome> {
    const objectId = event.objectId;
    if (objectId === null || !STRIPE_INVOICE_ID.test(objectId)) {
      return { status: "ignored", reason: "NO_INVOICE: the event names no Stripe invoice" };
    }
    const startedAt = this.clock.now();
    const first = await this.stripe.api().invoices.retrieve(objectId);
    const subscriptionId = invoiceSubscriptionId(first);
    if (subscriptionId === undefined) {
      // No subscription, no lock: the upsert keeps the newest re-fetch (file header).
      return this.sync(event, objectId, first, { subscriptionId, held: undefined, syncedAt: startedAt });
    }
    return this.lock.run(subscriptionId, { eventId: event.id }, async (held) => {
      // The re-fetch whose answer is written, under the subscription's lock.
      const syncedAt = this.clock.now();
      const invoice = await this.stripe.api().invoices.retrieve(objectId);
      return this.sync(event, objectId, invoice, { subscriptionId, held, syncedAt });
    });
  }

  /** Steps 1 to 5 of the file header for the re-fetched `invoice`, Stripe's `providerInvoiceId`. */
  private async sync(
    event: StripeInboxEvent,
    providerInvoiceId: string,
    invoice: Stripe.Invoice,
    context: SyncContext,
  ): Promise<StripeEventOutcome> {
    const number = invoice.number;
    if (number === null || invoice.status === "draft") {
      return { status: "ignored", reason: "INVOICE_DRAFT: the invoice is not finalized yet" };
    }
    const metadata = subscriptionMetadataOf(invoice);
    const customerId = stripeIdOf(invoice.customer);
    return runInTransaction(this.db, async (trx): Promise<StripeEventOutcome> => {
      const tenantId = invoiceTenantOf({
        customer:
          customerId === undefined ? undefined : await this.customers.tenantOfCustomer(trx, customerId),
        subscription:
          context.subscriptionId === undefined
            ? undefined
            : await this.invoices.tenantOfSubscription(trx, context.subscriptionId),
        metadata: velexisTenantIdOf(metadata),
      });
      if (tenantId === undefined) {
        return {
          status: "ignored",
          reason: "UNKNOWN_TENANT: no OTA's Customer or subscription is the invoice's",
        };
      }
      const tenant = await this.tenants.lockForUpdate(trx, tenantId);
      if (tenant === undefined || !isShownTenantStatus(tenant.status)) {
        return {
          status: "ignored",
          reason: "TENANT_NOT_BILLABLE: the invoice's OTA is unknown, deleted or being deleted",
          tenantId: tenant?.id ?? null,
        };
      }
      const currency = invoiceCurrency(invoice);
      const exponent = await this.invoices.exponentOf(trx, currency);
      if (exponent === undefined) {
        throw new StripeEventFailure("UNKNOWN_CURRENCY", `${currency} is not in reference.currencies`, {
          retryable: false,
          tenantId,
        });
      }
      const state = invoiceStateOf({ ...invoice, number }, exponent, tenantId);
      const result = await this.write(trx, {
        event,
        tenant,
        invoice,
        providerInvoiceId,
        pendingRowId: velexisSubscriptionIdOf(metadata),
        state,
        exponent,
        context,
      });
      // The last statement before the commit: the write commits only while the lock is this event's.
      await context.held?.confirm();
      this.logger.info(
        {
          eventId: event.id,
          eventType: event.type,
          tenantId,
          invoiceId: result.row?.id ?? null,
          providerInvoiceId,
          providerSubscriptionId: context.subscriptionId ?? null,
          status: state.status,
          created: result.created,
          changed: result.changed,
          stale: result.stale,
          emailed: result.emailed,
        },
        "billing.invoice_synced",
      );
      return { status: "processed", tenantId };
    });
  }

  /** Steps 2 (the stored row), 4 and 5 of the file header, in `trx`, the tenant's row locked. */
  private async write(
    trx: PlatformTransaction,
    input: {
      readonly event: StripeInboxEvent;
      readonly tenant: TenantRecord;
      readonly invoice: Stripe.Invoice;
      readonly providerInvoiceId: string;
      readonly pendingRowId: string | undefined;
      readonly state: InvoiceState;
      readonly exponent: number;
      readonly context: SyncContext;
    },
  ): Promise<InvoiceWriteResult> {
    const { event, tenant, invoice, providerInvoiceId, state, context } = input;
    const storedRow = await this.invoices.lockByProvider(trx, providerInvoiceId);
    if (storedRow !== undefined && storedRow.tenant_id !== tenant.id) {
      throw new StripeEventFailure("TENANT_MISMATCH", "the invoice's row belongs to another OTA", {
        retryable: false,
        tenantId: tenant.id,
      });
    }
    const storedSyncedAt = storedRow?.provider_synced_at ?? null;
    if (
      context.held === undefined &&
      storedSyncedAt !== null &&
      storedSyncedAt.getTime() > context.syncedAt.getTime()
    ) {
      // A re-fetch that started later has committed already: its answer is the newer state (file header).
      return { row: storedRow, created: false, changed: false, stale: true, emailed: 0 };
    }
    const subscriptionId =
      context.subscriptionId === undefined
        ? null
        : ((await this.invoices.subscriptionRowOf(
            trx,
            tenant.id,
            context.subscriptionId,
            input.pendingRowId,
          )) ?? null);
    const now = this.clock.now();
    let row: InvoiceRecord;
    let changed: boolean;
    try {
      if (storedRow === undefined) {
        row = await this.invoices.insert(trx, {
          id: this.ids.new("inv"),
          tenantId: tenant.id,
          subscriptionId,
          providerInvoiceId,
          state,
          syncedAt: context.syncedAt,
          now,
        });
        changed = true;
      } else {
        changed = invoiceDiffers(storedRow, state, subscriptionId);
        row = await this.invoices.update(trx, storedRow.id, {
          state,
          subscriptionId,
          syncedAt: context.syncedAt,
          now,
          changed,
        });
      }
    } catch (error) {
      if (isNumberConflict(error)) {
        throw new StripeEventFailure("INVOICE_NUMBER_CONFLICT", "another invoice has the same number", {
          retryable: false,
          tenantId: tenant.id,
        });
      }
      throw error;
    }
    const emailed =
      event.type === "invoice.payment_failed" && UNPAID_STATUSES.has(state.status)
        ? await this.notifyOwners(trx, tenant, invoice, input)
        : 0;
    return { row, created: storedRow === undefined, changed, stale: false, emailed };
  }

  /**
   * Queues `billing.payment_failed` to every active owner of `tenant`, once per owner, invoice and payment attempt
   * (step 5 of the file header); answers how many were queued now.
   */
  private async notifyOwners(
    trx: PlatformTransaction,
    tenant: TenantRecord,
    invoice: Stripe.Invoice,
    input: { readonly providerInvoiceId: string; readonly state: InvoiceState; readonly exponent: number },
  ): Promise<number> {
    const { state } = input;
    const billingUrl = this.outbox.portalLink(`/otas/${tenant.id}/billing`);
    const amountDue = `${toCurrencyAmount(state.amountDue, input.exponent)} ${state.currency}`;
    let queued = 0;
    for (const owner of await this.invoices.activeOwners(trx, tenant.id)) {
      const email = await this.outbox.queue(trx, {
        templateKey: PAYMENT_FAILED_TEMPLATE,
        to: owner.email,
        accountId: owner.account_id,
        tenantId: tenant.id,
        data: {
          fullName: owner.full_name,
          tenantName: tenant.name,
          tenantKey: tenant.key,
          invoiceNumber: state.number,
          amountDue,
          billingUrl,
        },
        idempotencyKey: `payment_failed:${input.providerInvoiceId}:${invoice.attempt_count}`,
      });
      if (email.queued) {
        queued += 1;
      }
    }
    return queued;
  }
}

/** The `invoices.number` constraint (`number text NOT NULL UNIQUE`). */
const NUMBER_CONSTRAINT = "invoices_number_key";
const UNIQUE_VIOLATION = "23505";

/** True for the `pg` error of a second invoice with the same number (Kysely passes it through). */
function isNumberConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === NUMBER_CONSTRAINT;
}
