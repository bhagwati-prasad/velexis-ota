"use client";

// The table of `/bookings` (routes.md §3.1, OAD-006): the shared data table with the bookings list's columns. Its
// cells render links, badges and money, which are functions a server component cannot hand to a client component, so
// the columns live in this client module and the page's server component passes plain rows (`BookingRow` of
// views.ts, formatted on the server). The table neither filters nor sorts: the API did, and "Next page" links
// `page.nextCursor` with the URL's other parameters kept.
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";

import type { BookingRow, ShownTime } from "@/app/(console)/bookings/views";
import { DataTable, type ListPage } from "@/components/data-table";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";

export const TABLE_COLUMN_STRINGS = Object.freeze({
  caption: "Bookings",
  reference: "Reference",
  recordLocator: "Record locator",
  travelers: "Travellers",
  departure: "Route and departure",
  status: "Status",
  ticketing: "Ticketing",
  payment: "Payment",
  total: "Total",
  channel: "Channel",
  created: "Created",
  guest: "Guest booking",
  noRecordLocator: "None yet",
  more: (count: number) => `+${count} more`,
  deadline: "Deadline",
  net: "Net",
  markup: "Markup",
  scheduleChanged: "Schedule changed",
});

const MUTED = "text-xs text-muted-foreground";

/** The detail page of a booking (OAD-007). */
function bookingHref(bookingId: string): string {
  return `/bookings/${encodeURIComponent(bookingId)}`;
}

function Time({ value }: { readonly value: ShownTime }) {
  return <time dateTime={value.dateTime}>{value.label}</time>;
}

const COLUMNS: ColumnDef<BookingRow>[] = [
  {
    id: "reference",
    header: TABLE_COLUMN_STRINGS.reference,
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <Link
          href={bookingHref(row.original.id)}
          className="font-mono font-medium underline-offset-4 hover:underline focus-visible:underline"
        >
          {row.original.reference}
        </Link>
        {row.original.guest ? <span className={MUTED}>{TABLE_COLUMN_STRINGS.guest}</span> : null}
      </div>
    ),
  },
  {
    id: "recordLocator",
    header: TABLE_COLUMN_STRINGS.recordLocator,
    cell: ({ row }) =>
      row.original.recordLocator === null ? (
        <span className="text-muted-foreground">{TABLE_COLUMN_STRINGS.noRecordLocator}</span>
      ) : (
        <span className="font-mono">{row.original.recordLocator}</span>
      ),
  },
  {
    id: "travelers",
    header: TABLE_COLUMN_STRINGS.travelers,
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span>{row.original.leadTraveler}</span>
        {row.original.otherTravelers > 0 ? (
          <span className={MUTED}>{TABLE_COLUMN_STRINGS.more(row.original.otherTravelers)}</span>
        ) : null}
      </div>
    ),
  },
  {
    id: "departure",
    header: TABLE_COLUMN_STRINGS.departure,
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span className="font-medium">{row.original.route}</span>
        <span className={MUTED}>
          {row.original.tripType} · <Time value={row.original.departure} />
        </span>
      </div>
    ),
  },
  {
    id: "status",
    header: TABLE_COLUMN_STRINGS.status,
    cell: ({ row }) => (
      <div className="grid justify-items-start gap-1">
        <StatusBadge kind="booking" status={row.original.status} />
        {row.original.scheduleChanged ? (
          <span className="text-xs font-medium text-amber-800">{TABLE_COLUMN_STRINGS.scheduleChanged}</span>
        ) : null}
      </div>
    ),
  },
  {
    id: "ticketing",
    header: TABLE_COLUMN_STRINGS.ticketing,
    cell: ({ row }) => {
      const deadline = row.original.ticketingDeadline;
      return (
        <div className="grid justify-items-start gap-1">
          <StatusBadge kind="ticketing" status={row.original.ticketingStatus} />
          {deadline === null ? null : (
            <span className={MUTED}>
              {TABLE_COLUMN_STRINGS.deadline} <Time value={deadline} />
            </span>
          )}
        </div>
      );
    },
  },
  {
    id: "payment",
    header: TABLE_COLUMN_STRINGS.payment,
    cell: ({ row }) => <StatusBadge kind="payment" status={row.original.paymentStatus} />,
  },
  {
    id: "total",
    header: TABLE_COLUMN_STRINGS.total,
    cell: ({ row }) => (
      <div className="grid gap-0.5 text-right">
        <Money value={row.original.total} className="font-medium" />
        <span className={MUTED}>
          {TABLE_COLUMN_STRINGS.net} <Money value={row.original.net} />
        </span>
        <span className={MUTED}>
          {TABLE_COLUMN_STRINGS.markup} <Money value={row.original.markup} />
        </span>
      </div>
    ),
  },
  {
    id: "channel",
    header: TABLE_COLUMN_STRINGS.channel,
    cell: ({ row }) => row.original.channel,
  },
  {
    id: "created",
    header: TABLE_COLUMN_STRINGS.created,
    cell: ({ row }) => <Time value={row.original.created} />,
  },
];

export interface BookingsTableProps {
  /** One page of `console.bookings.list`, as rows. */
  readonly rows: readonly BookingRow[];
  /** The `page` of the answer: "Next page" uses its `nextCursor`. */
  readonly page: ListPage;
  /** `totalCount` of the answer when it has one (`null`: more than 10 000). */
  readonly totalCount?: number | null;
  /** The text of an empty list (the saved view's, or the filters'). */
  readonly emptyMessage: string;
}

/**
 * The bookings of one page: reference (linking to the detail page), record locator, travellers, route and first
 * departure, booking, ticketing and payment status, the selling total with its net cost and markup, channel and
 * creation time.
 */
export function BookingsTable({ rows, page, totalCount, emptyMessage }: BookingsTableProps) {
  return (
    <DataTable
      columns={COLUMNS}
      data={rows}
      caption={TABLE_COLUMN_STRINGS.caption}
      emptyMessage={emptyMessage}
      getRowId={(row) => row.id}
      page={page}
      {...(totalCount === undefined ? {} : { totalCount })}
    />
  );
}
