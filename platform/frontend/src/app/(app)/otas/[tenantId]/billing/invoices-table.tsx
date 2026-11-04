"use client";

import type { components } from "@velexis/api-types/platform";
import type { ColumnDef } from "@tanstack/react-table";
import { createContext, useContext, type ReactNode } from "react";

import { followableUrl } from "@/app/(app)/otas/[tenantId]/billing/billing-rules";
import { DataTable } from "@/components/data-table";
import { formatDateTime } from "@/components/date-time";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";
import { BILLING_STRINGS } from "@/lib/strings";

/**
 * The invoices of the billing page (PFE-021; README §2 `/otas/[tenantId]/billing` and §4 `DataTable`; flows/
 * subscription-billing.md §D; PF-73 AC2): Velexis's invoices to the OTA as `listInvoices` answers them, newest first,
 * for owners and finance members. Each row has the invoice number, the billed period (the days of its start and its
 * end in the OTA's time zone), the total with `Money` (the API's decimal string with the currency's own decimals,
 * never a float), the status in words, and the links to the invoice page and the PDF that Stripe hosts.
 *
 * The links open Stripe in a new tab with `rel="noopener noreferrer"` (the Stripe page gets no handle on the portal and
 * no referrer), and only when the API's URL is an absolute `https:` URL without credentials (`followableUrl`):
 * anything else, or no URL yet (a draft), reads "Not available yet". The columns are module constants whose cells read
 * the OTA's time zone from a context, so they are never made again on a render.
 */

type Invoice = components["schemas"]["Invoice"];

/** The OTA's time zone, for the billed period's dates. */
const TimeZoneContext = createContext("UTC");

/** A date of the billed period, as `DateTime` shows it: the API's instant in `<time>`, the day in the OTA's zone. */
function PeriodDate({ value }: { readonly value: string }) {
  const timeZone = useContext(TimeZoneContext);
  return <time dateTime={value}>{formatDateTime(value, { mode: "date", timeZone }) ?? value}</time>;
}

/** The billed period: the days of its start and its end, or "No period" when the invoice names none. */
function Period({ invoice }: { readonly invoice: Invoice }) {
  if (invoice.periodStart === null || invoice.periodEnd === null) {
    return <span className="text-muted-foreground">{BILLING_STRINGS.noPeriod}</span>;
  }
  return (
    <span className="whitespace-nowrap">
      <PeriodDate value={invoice.periodStart} />
      {BILLING_STRINGS.periodTo}
      <PeriodDate value={invoice.periodEnd} />
    </span>
  );
}

/** One Stripe link of an invoice: its own words, then the invoice and the new tab for screen readers. */
function StripeLink({
  href,
  number,
  children,
}: {
  readonly href: string;
  readonly number: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium underline underline-offset-4"
    >
      {children}
      <span className="sr-only">{BILLING_STRINGS.linkContext(number)}</span>
    </a>
  );
}

/** The links of an invoice that the API answered as followable URLs. */
function InvoiceLinks({ invoice }: { readonly invoice: Invoice }) {
  const hosted = followableUrl(invoice.hostedInvoiceUrl);
  const pdf = followableUrl(invoice.invoicePdfUrl);
  if (hosted === undefined && pdf === undefined) {
    return <span className="text-muted-foreground">{BILLING_STRINGS.noLinks}</span>;
  }
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-1">
      {hosted === undefined ? null : (
        <StripeLink href={hosted} number={invoice.number}>
          {BILLING_STRINGS.viewInvoice}
        </StripeLink>
      )}
      {pdf === undefined ? null : (
        <StripeLink href={pdf} number={invoice.number}>
          {BILLING_STRINGS.downloadPdf}
        </StripeLink>
      )}
    </span>
  );
}

const COLUMNS = BILLING_STRINGS.invoiceColumns;

/** The columns of the table; constants, so the cells keep their identity across renders. */
const INVOICE_COLUMNS: ColumnDef<Invoice>[] = [
  {
    id: "number",
    header: COLUMNS.number,
    cell: ({ row }) => <span className="font-medium">{row.original.number}</span>,
  },
  { id: "period", header: COLUMNS.period, cell: ({ row }) => <Period invoice={row.original} /> },
  {
    id: "total",
    header: COLUMNS.total,
    cell: ({ row }) => <Money value={row.original.total} />,
  },
  {
    id: "status",
    header: COLUMNS.status,
    cell: ({ row }) => <StatusBadge kind="invoice" status={row.original.status} />,
  },
  { id: "links", header: COLUMNS.links, cell: ({ row }) => <InvoiceLinks invoice={row.original} /> },
];

export interface InvoicesTableProps {
  /** The invoices as `listInvoices` answers them, newest first. */
  readonly invoices: readonly Invoice[];
  /** The OTA's time zone (IANA), for the billed period's dates. */
  readonly timeZone: string;
}

/** The invoices, in the API's order, with an empty message before the first one. */
export function InvoicesTable({ invoices, timeZone }: InvoicesTableProps) {
  return (
    <TimeZoneContext.Provider value={timeZone}>
      <DataTable
        columns={INVOICE_COLUMNS}
        data={invoices}
        caption={BILLING_STRINGS.invoicesCaption}
        emptyMessage={BILLING_STRINGS.invoicesEmpty}
        getRowId={(invoice) => invoice.id}
      />
    </TimeZoneContext.Provider>
  );
}
