// listInvoices (PBE-046; platform/docs/api-inventory-resources.md §6, subscription-billing flow §D, ADR-0017 "Platform
// invoices", scope PF-73 AC2): owners and finance members (TenantRoleGuard, `viewBilling`) see Velexis's invoices to
// the OTA, newest first (issue date, then creation, then id), as billing sync copied them from Stripe
// (invoice.handler.ts): number, status, total, amount due and paid, the billed period, the issue and payment dates and
// the links to the Stripe-hosted page and PDF. Amounts are `Money` in the invoice's currency, with that currency's
// decimals (`reference.currencies.minor_units`: `5000` JPY, `49.00` EUR; minor-units.ts `toCurrencyAmount`). The list
// is short (one invoice per billing period) and not paginated; it is empty before the OTA's first Stripe invoice, needs
// no milestone switch, and works while the OTA is suspended (PADR-0014 item 5: the owner can download invoices).
import { Controller, Get } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import { InvoicesRepository, type InvoiceListRow } from "./invoices.repository";
import { toCurrencyAmount } from "./minor-units";

export type Invoice = components["schemas"]["Invoice"];
export type InvoiceList = components["schemas"]["InvoiceList"];

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * The portal's `Invoice` of a stored row: amounts with the decimals of the row's currency (as stored when
 * `reference.currencies` lacks it, which billing sync never writes).
 */
export function toInvoice(row: InvoiceListRow): Invoice {
  const currency = row.currency.trim();
  const money = (stored: string): Invoice["total"] => ({
    amount: row.minor_units === null ? stored : toCurrencyAmount(stored, row.minor_units),
    currency,
  });
  return {
    id: row.id,
    number: row.number,
    status: row.status as Invoice["status"],
    total: money(row.total),
    amountDue: money(row.amount_due),
    amountPaid: money(row.amount_paid),
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    issuedAt: iso(row.issued_at),
    paidAt: iso(row.paid_at),
    hostedInvoiceUrl: row.hosted_invoice_url,
    invoicePdfUrl: row.invoice_pdf_url,
  };
}

@Controller("v1/tenants/:tenantId/invoices")
export class InvoicesController {
  constructor(private readonly invoices: InvoicesRepository) {}

  @Get()
  @OpenApiOperation("listInvoices")
  @TenantRoles(...tenantRolesOf("listInvoices"))
  async listInvoices(@CurrentMembership() membership: TenantMembership): Promise<InvoiceList> {
    const rows = await this.invoices.listForTenant(membership.tenantId);
    return { data: rows.map(toInvoice) };
  }
}
