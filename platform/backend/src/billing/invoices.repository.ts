// The `invoices` repository (PBE-046; platform/docs/architecture.md §2.1: BillingModule owns the table; subscription-
// billing flow §D, invoice row, PADR-0002 items 5 and 8, ADR-0017 "Platform invoices"). Velexis's invoices to the OTAs
// are Stripe's: billing sync copies each one into its row, keyed by `provider_invoice_id`, and the portal lists them.
// Kysely on `PLATFORM_DB` (ADR-0005).
//
// - The writes of billing sync (invoice.handler.ts) run in its transaction, after it has locked the tenant's row
//   (billing's lock order, flow §D): `lockByProvider` reads the stored row `FOR UPDATE`, `insert` and `update` write it.
//   Every billing-sync write of an OTA's invoices holds that tenant lock, so the read and the write of one transaction
//   are never interleaved with another's.
// - `exponentOf` reads the currency's exponent (`reference.currencies.minor_units`), as the plans read their currency
//   (billing reads the reference data directly).
// - `tenantOfSubscription` names the OTA of a Stripe subscription's row, and `subscriptionRowOf` the OTA's subscription
//   row the invoice belongs to (`invoices.subscription_id`).
// - `listForTenant` is the portal's list (`listInvoices`), newest first, each row with its currency's exponent.
// - `activeOwners` reads `tenant_memberships` and `accounts` (TenantsModule's and AuthModule's tables, read only) for
//   the owners' `billing.payment_failed` e-mail.
import { Inject, Injectable } from "@nestjs/common";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

type InvoiceTable = Selectable<PlatformDatabase["platform.invoices"]>;

/** The statuses of `invoices.status` (Stripe's five). */
export const INVOICE_STATUSES = Object.freeze(["draft", "open", "paid", "void", "uncollectible"] as const);

/** A status of INVOICE_STATUSES. */
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** The columns of InvoiceRecord. */
const RECORD_COLUMNS = [
  "id",
  "tenant_id",
  "subscription_id",
  "number",
  "status",
  "currency",
  "subtotal",
  "tax_amount",
  "total",
  "amount_paid",
  "amount_due",
  "period_start",
  "period_end",
  "issued_at",
  "due_at",
  "paid_at",
  "hosted_invoice_url",
  "invoice_pdf_url",
  "provider_invoice_id",
  "provider_synced_at",
  "created_at",
  "updated_at",
] as const;

/** A stored invoice as billing sync reads and writes it. Amounts are the `numeric(12,2)` text (`"49.00"`). */
export type InvoiceRecord = Pick<InvoiceTable, (typeof RECORD_COLUMNS)[number]>;

/**
 * What an invoice row keeps of a Stripe invoice (flow §D, invoice row): the number, the status, the currency (ISO,
 * upper case), the amounts as `numeric(12,2)` text (minor-units.ts `toStoredAmount`), the billed period, the dates and
 * the Stripe-hosted page and PDF.
 */
export interface InvoiceState {
  readonly number: string;
  readonly status: InvoiceStatus;
  readonly currency: string;
  readonly subtotal: string;
  readonly taxAmount: string;
  readonly total: string;
  readonly amountPaid: string;
  readonly amountDue: string;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly issuedAt: Date | null;
  readonly dueAt: Date | null;
  readonly paidAt: Date | null;
  readonly hostedInvoiceUrl: string | null;
  readonly invoicePdfUrl: string | null;
}

/** A new invoice row. */
export interface NewInvoice {
  /** `inv_…`. */
  readonly id: string;
  readonly tenantId: string;
  /** The OTA's subscription row the invoice belongs to, when one is known. */
  readonly subscriptionId: string | null;
  /** Stripe's `in_…`. */
  readonly providerInvoiceId: string;
  readonly state: InvoiceState;
  /** When the re-fetch that gave `state` started (`provider_synced_at`). */
  readonly syncedAt: Date;
  /** The Clock's time of the write. */
  readonly now: Date;
}

/** A write of a re-fetched state into a stored row. */
export interface InvoiceWrite {
  readonly state: InvoiceState;
  /** The subscription row to link; `null` keeps the stored link. */
  readonly subscriptionId: string | null;
  /** When the re-fetch that gave `state` started (`provider_synced_at`). */
  readonly syncedAt: Date;
  /** The Clock's time of the write. */
  readonly now: Date;
  /** True when the state or the link differs from the stored row: only then do they and `updated_at` change. */
  readonly changed: boolean;
}

/** One row of the portal's list: the row and its currency's exponent (`null` when `reference.currencies` lacks it). */
export interface InvoiceListRow extends Pick<
  InvoiceTable,
  | "id"
  | "number"
  | "status"
  | "currency"
  | "total"
  | "amount_due"
  | "amount_paid"
  | "period_start"
  | "period_end"
  | "issued_at"
  | "paid_at"
  | "hosted_invoice_url"
  | "invoice_pdf_url"
> {
  readonly minor_units: number | null;
}

/** An active owner of an OTA, as the owners' e-mail needs them. */
export interface InvoiceOwner {
  readonly account_id: string;
  readonly email: string;
  readonly full_name: string;
}

/** The columns of a state. */
function stateColumns(state: InvoiceState) {
  return {
    number: state.number,
    status: state.status,
    currency: state.currency,
    subtotal: state.subtotal,
    tax_amount: state.taxAmount,
    total: state.total,
    amount_paid: state.amountPaid,
    amount_due: state.amountDue,
    period_start: state.periodStart,
    period_end: state.periodEnd,
    issued_at: state.issuedAt,
    due_at: state.dueAt,
    paid_at: state.paidAt,
    hosted_invoice_url: state.hostedInvoiceUrl,
    invoice_pdf_url: state.invoicePdfUrl,
  };
}

const sameDate = (stored: Date | null, next: Date | null): boolean =>
  stored === null || next === null ? stored === next : stored.getTime() === next.getTime();

/**
 * True when writing `state` (and the link `subscriptionId`, unless `null`) changes the stored `row`. Amounts compare as
 * the `numeric(12,2)` text both sides hold (`"49.00"`), dates by their time.
 */
export function invoiceDiffers(
  row: InvoiceRecord,
  state: InvoiceState,
  subscriptionId: string | null,
): boolean {
  return (
    row.number !== state.number ||
    row.status !== state.status ||
    row.currency.trim() !== state.currency ||
    row.subtotal !== state.subtotal ||
    row.tax_amount !== state.taxAmount ||
    row.total !== state.total ||
    row.amount_paid !== state.amountPaid ||
    row.amount_due !== state.amountDue ||
    !sameDate(row.period_start, state.periodStart) ||
    !sameDate(row.period_end, state.periodEnd) ||
    !sameDate(row.issued_at, state.issuedAt) ||
    !sameDate(row.due_at, state.dueAt) ||
    !sameDate(row.paid_at, state.paidAt) ||
    row.hosted_invoice_url !== state.hostedInvoiceUrl ||
    row.invoice_pdf_url !== state.invoicePdfUrl ||
    (subscriptionId !== null && row.subscription_id !== subscriptionId)
  );
}

@Injectable()
export class InvoicesRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** The exponent (`minor_units`) of `currency` in `reference.currencies`; `undefined` for a currency it lacks. */
  async exponentOf(db: PlatformDb | PlatformTransaction, currency: string): Promise<number | undefined> {
    const row = await db
      .selectFrom("reference.currencies")
      .select("minor_units")
      .where("code", "=", currency)
      .executeTakeFirst();
    return row?.minor_units;
  }

  /** The stored invoice of Stripe's `providerInvoiceId`, locked in `trx` (`FOR UPDATE`); `undefined` for none. */
  async lockByProvider(
    trx: PlatformTransaction,
    providerInvoiceId: string,
  ): Promise<InvoiceRecord | undefined> {
    return trx
      .selectFrom("platform.invoices")
      .select(RECORD_COLUMNS)
      .where("provider_invoice_id", "=", providerInvoiceId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * The subscription row of `tenantId` an invoice of the Stripe subscription `providerSubscriptionId` belongs to: the
   * Stripe row of that subscription, else the pre-inserted row `pendingRowId` (`metadata.velexis_subscription_id`) that
   * no Stripe subscription has filled yet; read in `trx`. `undefined` for none, and for a row of another OTA.
   */
  async subscriptionRowOf(
    trx: PlatformTransaction,
    tenantId: string,
    providerSubscriptionId: string,
    pendingRowId: string | undefined,
  ): Promise<string | undefined> {
    const byProvider = await trx
      .selectFrom("platform.subscriptions")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("billing_provider", "=", "stripe")
      .where("provider_subscription_id", "=", providerSubscriptionId)
      .executeTakeFirst();
    if (byProvider !== undefined || pendingRowId === undefined) {
      return byProvider?.id;
    }
    const pending = await trx
      .selectFrom("platform.subscriptions")
      .select("id")
      .where("id", "=", pendingRowId)
      .where("tenant_id", "=", tenantId)
      .where("billing_provider", "=", "stripe")
      .where("provider_subscription_id", "is", null)
      .executeTakeFirst();
    return pending?.id;
  }

  /** The tenant of the Stripe subscription row `providerSubscriptionId`, read in `trx`; `undefined` for none. */
  async tenantOfSubscription(
    trx: PlatformTransaction,
    providerSubscriptionId: string,
  ): Promise<string | undefined> {
    const row = await trx
      .selectFrom("platform.subscriptions")
      .select("tenant_id")
      .where("billing_provider", "=", "stripe")
      .where("provider_subscription_id", "=", providerSubscriptionId)
      .executeTakeFirst();
    return row?.tenant_id;
  }

  /** Inserts a new invoice row in `trx` and returns it. */
  async insert(trx: PlatformTransaction, invoice: NewInvoice): Promise<InvoiceRecord> {
    return trx
      .insertInto("platform.invoices")
      .values({
        id: invoice.id,
        tenant_id: invoice.tenantId,
        subscription_id: invoice.subscriptionId,
        provider_invoice_id: invoice.providerInvoiceId,
        ...stateColumns(invoice.state),
        provider_synced_at: invoice.syncedAt,
        created_at: invoice.now,
        updated_at: invoice.now,
      })
      .returning(RECORD_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * Writes a re-fetched state into the stored row `id` (locked by the caller) in `trx`: always `provider_synced_at`,
   * and the state, the link and `updated_at` when `write.changed`. Returns the row as written.
   */
  async update(trx: PlatformTransaction, id: string, write: InvoiceWrite): Promise<InvoiceRecord> {
    const changes = write.changed
      ? {
          ...stateColumns(write.state),
          ...(write.subscriptionId === null ? {} : { subscription_id: write.subscriptionId }),
          updated_at: write.now,
        }
      : {};
    return trx
      .updateTable("platform.invoices")
      .set({ ...changes, provider_synced_at: write.syncedAt })
      .where("id", "=", id)
      .returning(RECORD_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * The invoices of `tenantId`, newest first: by issue date (an invoice without one last), then creation time, then id;
   * each with its currency's exponent. Not paginated (one invoice per billing period, `listInvoices`).
   */
  async listForTenant(tenantId: string): Promise<InvoiceListRow[]> {
    return this.db
      .selectFrom("platform.invoices as i")
      .leftJoin("reference.currencies as c", "c.code", "i.currency")
      .select([
        "i.id",
        "i.number",
        "i.status",
        "i.currency",
        "i.total",
        "i.amount_due",
        "i.amount_paid",
        "i.period_start",
        "i.period_end",
        "i.issued_at",
        "i.paid_at",
        "i.hosted_invoice_url",
        "i.invoice_pdf_url",
        "c.minor_units",
      ])
      .where("i.tenant_id", "=", tenantId)
      .orderBy(
        (eb) => eb.ref("i.issued_at"),
        (ob) => ob.desc().nullsLast(),
      )
      .orderBy("i.created_at", "desc")
      .orderBy("i.id", "desc")
      .execute();
  }

  /**
   * The active owners of `tenantId`, oldest membership first, with their e-mail address and name (read only), in `trx`.
   * An account that is disabled or deleted is left out.
   */
  async activeOwners(trx: PlatformTransaction, tenantId: string): Promise<InvoiceOwner[]> {
    return trx
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select(["m.account_id", "a.email", "a.full_name"])
      .where("m.tenant_id", "=", tenantId)
      .where("m.role", "=", "owner")
      .where("m.status", "=", "active")
      .where("a.status", "not in", ["disabled", "deleted"])
      .where("a.deleted_at", "is", null)
      .orderBy("m.created_at")
      .orderBy("m.id")
      .execute();
  }
}
