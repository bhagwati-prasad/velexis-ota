import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { DateTime } from "@/components/date-time";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { INVOICE_LIST_STRINGS as S, STATUS_LABELS, TABLE_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type AdminInvoice = Schemas["AdminInvoice"];
type InvoiceStatus = AdminInvoice["status"];
type SearchParams = Record<string, string | string[] | undefined>;

/** The filters of `adminListInvoices` that the URL carries; an absent or empty parameter is no filter. */
interface InvoiceFilters {
  readonly status?: InvoiceStatus;
  readonly tenantId?: string;
  readonly cursor?: string;
}

/** Every status of the platform document has a label: a new one fails the type check until it has one. */
const STATUS_NAMES: Readonly<Record<InvoiceStatus, string>> = STATUS_LABELS.invoice;

/** `TenantId` of the platform document, and its length for the search field. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;
const TENANT_ID_LENGTH = 30;

/** The `maxLength` of the `Cursor` parameter. */
const CURSOR_MAX_LENGTH = 512;

function isStatus(value: string): value is InvoiceStatus {
  return Object.hasOwn(STATUS_NAMES, value);
}

/** A query parameter: `""` when absent, `undefined` when repeated (a URL no filter bar writes). */
function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * The filters of the page URL, or `undefined` when one of them is not a value the API takes: the page then says so
 * instead of showing an unfiltered list under a filtered address.
 */
function parseFilters(params: SearchParams): InvoiceFilters | undefined {
  const status = single(params.status);
  const tenantId = single(params.tenantId)?.trim();
  const cursor = single(params.cursor);
  if (status === undefined || tenantId === undefined || cursor === undefined) {
    return undefined;
  }
  if (
    (status !== "" && !isStatus(status)) ||
    (tenantId !== "" && !TENANT_ID.test(tenantId)) ||
    cursor.length > CURSOR_MAX_LENGTH
  ) {
    return undefined;
  }
  return {
    ...(status === "" ? {} : { status }),
    ...(tenantId === "" ? {} : { tenantId }),
    ...(cursor === "" ? {} : { cursor }),
  };
}

/** `href` with the query of `filters` (an empty one gives the bare path). */
function withQuery(href: string, filters: Readonly<Record<string, string | undefined>>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined) {
      query.set(name, value);
    }
  }
  const text = query.toString();
  return text === "" ? href : `${href}?${text}`;
}

function sessionEnded(error: ApiError | undefined): boolean {
  return error?.code === "UNAUTHENTICATED" || error?.code === "TOKEN_EXPIRED";
}

const LINK_CLASS = "font-medium underline underline-offset-4";

function Muted({ children }: { readonly children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** An instant, or `empty` for `null`. */
function When({ value, empty }: { readonly value: string | null; readonly empty: string }) {
  return value === null ? <Muted>{empty}</Muted> : <DateTime value={value} />;
}

/**
 * A Stripe-hosted link (the invoice page or its PDF), only for an `https:` URL; anything else is not rendered as a
 * link. `noopener noreferrer`: Stripe's page gets neither this window nor the admin URL it was opened from.
 */
function StripeLink({ href, children }: { readonly href: string | null; readonly children: ReactNode }) {
  if (href === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return url.protocol === "https:" ? (
    <a href={url.toString()} rel="noopener noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  ) : null;
}

/**
 * One page of invoices: a server table (nothing of a row reaches the browser but what it renders), each invoice with
 * its OTA and subscription linked, its amounts as `Money` (the API's decimal strings, with the currency's decimals)
 * and its Stripe-hosted page and PDF, and "Next page" and "First page" links that keep the filters of the URL.
 */
function InvoiceTable({
  rows,
  filters,
  nextCursor,
}: {
  readonly rows: readonly AdminInvoice[];
  readonly filters: InvoiceFilters;
  readonly nextCursor: string | null;
}) {
  const kept = { status: filters.status, tenantId: filters.tenantId };
  return (
    <div className="grid gap-4">
      <Table>
        <TableCaption className="sr-only">{S.caption}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{S.columnNumber}</TableHead>
            <TableHead scope="col">{S.columnOta}</TableHead>
            <TableHead scope="col">{S.columnSubscription}</TableHead>
            <TableHead scope="col">{S.columnStatus}</TableHead>
            <TableHead scope="col">{S.columnPeriod}</TableHead>
            <TableHead scope="col" className="text-right">
              {S.columnTotal}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {S.columnPaid}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {S.columnDue}
            </TableHead>
            <TableHead scope="col">{S.columnIssued}</TableHead>
            <TableHead scope="col">{S.columnPaidAt}</TableHead>
            <TableHead scope="col">{S.columnLinks}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={11} className="text-muted-foreground">
                {S.empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((invoice) => (
              <TableRow key={invoice.id} data-invoice={invoice.id} className="align-top">
                <TableCell>
                  <span className="grid gap-0.5">
                    <span className="font-mono text-xs">{invoice.number}</span>
                    {invoice.providerInvoiceId === null ? null : (
                      <span className="font-mono text-xs text-muted-foreground">
                        {invoice.providerInvoiceId}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/tenants/${encodeURIComponent(invoice.tenantId)}?tab=subscription`}
                    className={`${LINK_CLASS} font-mono text-xs break-all`}
                  >
                    {invoice.tenantId}
                  </Link>
                </TableCell>
                <TableCell>
                  {invoice.subscriptionId === null ? (
                    <Muted>{S.noSubscription}</Muted>
                  ) : (
                    <Link
                      href={`/subscriptions/${encodeURIComponent(invoice.subscriptionId)}`}
                      className={`${LINK_CLASS} font-mono text-xs break-all`}
                    >
                      {invoice.subscriptionId}
                    </Link>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge kind="invoice" status={invoice.status} />
                </TableCell>
                <TableCell>
                  {invoice.periodStart === null || invoice.periodEnd === null ? (
                    <Muted>{S.none}</Muted>
                  ) : (
                    <span>
                      <DateTime value={invoice.periodStart} mode="date" /> {S.periodTo}{" "}
                      <DateTime value={invoice.periodEnd} mode="date" />
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Money value={invoice.total} />
                </TableCell>
                <TableCell className="text-right">
                  <Money value={invoice.amountPaid} />
                </TableCell>
                <TableCell className="text-right">
                  <Money value={invoice.amountDue} />
                </TableCell>
                <TableCell>
                  <When value={invoice.issuedAt} empty={S.notYet} />
                </TableCell>
                <TableCell>
                  <When value={invoice.paidAt} empty={S.notYet} />
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-3">
                    <StripeLink href={invoice.hostedInvoiceUrl}>
                      {S.invoicePage}
                      <span className="sr-only">{S.invoiceOf(invoice.number)}</span>
                    </StripeLink>
                    <StripeLink href={invoice.invoicePdfUrl}>
                      {S.invoicePdf}
                      <span className="sr-only">{S.invoiceOf(invoice.number)}</span>
                    </StripeLink>
                  </span>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {nextCursor === null && filters.cursor === undefined ? null : (
        <nav aria-label={TABLE_STRINGS.paginationLabel} className="flex flex-wrap gap-4 text-sm">
          {filters.cursor === undefined ? null : (
            <Link href={withQuery("/invoices", kept)} className={LINK_CLASS}>
              {TABLE_STRINGS.firstPage}
            </Link>
          )}
          {nextCursor === null ? null : (
            <Link href={withQuery("/invoices", { ...kept, cursor: nextCursor })} className={LINK_CLASS}>
              {TABLE_STRINGS.nextPage}
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}

/**
 * `/invoices` (README §2; flows/platform-admin-operations.md, billing; PF-89, PAD-012): the Velexis invoices of every
 * OTA from `adminListInvoices`, synchronised from Stripe, newest first. `FilterBar` keeps the status and the OTA (its
 * tenant id, which a subscription's page links as "All invoices of this OTA") in the URL and the pager links the next
 * page with the cursor of the answer, so every list is a link another admin can open. Amounts are the API's decimal
 * strings in the invoice's currency, shown with `Money`; the Stripe-hosted page and PDF are linked only when they are
 * `https:` URLs. The page validates its URL and calls `adminListInvoices` with exactly those filters; a parameter the API
 * would refuse, or a `VALIDATION_FAILED` answer (a stale cursor), shows a notice instead of a list and asks for none.
 */
export default async function InvoicesPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const filters = parseFilters(await searchParams);
  const invoices =
    filters === undefined
      ? undefined
      : await (await platformApi()).GET("/v1/admin/invoices", { params: { query: filters } });
  if (sessionEnded(invoices?.error)) {
    redirect("/sign-in");
  }

  const fields: FilterField[] = [
    {
      kind: "select",
      name: "status",
      label: S.statusLabel,
      options: Object.entries(STATUS_NAMES).map(([value, label]) => ({ value, label })),
    },
    {
      kind: "search",
      name: "tenantId",
      label: S.tenantLabel,
      placeholder: S.tenantPlaceholder,
      maxLength: TENANT_ID_LENGTH,
    },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      <FilterBar fields={fields} label={S.filtersLabel} />
      {filters?.tenantId === undefined ? null : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-filter="tenant">
          <span>{S.oneTenant}</span>
          <Link
            href={`/tenants/${encodeURIComponent(filters.tenantId)}?tab=subscription`}
            className={LINK_CLASS}
          >
            {S.openTenant} <span className="font-mono">{filters.tenantId}</span>
          </Link>
          <Link href={withQuery("/invoices", { status: filters.status })} className={LINK_CLASS}>
            {S.everyTenant}
          </Link>
        </p>
      )}
      {invoices === undefined || invoices.error?.code === "VALIDATION_FAILED" ? (
        <Alert>
          <AlertDescription>
            <p>{S.invalidFilters}</p>
            <p>
              <Link href="/invoices" className={LINK_CLASS}>
                {S.showAll}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : invoices.error === undefined ? (
        <InvoiceTable
          rows={invoices.data.data}
          filters={filters ?? {}}
          nextCursor={invoices.data.page.nextCursor}
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(invoices.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
