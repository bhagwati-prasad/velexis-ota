"use client";

// The data table of the OTA admin (README §7 and §9): the shadcn/ui table on TanStack Table, for bookings, payments,
// customers, queues, rules and the supplier log. The API filters, sorts and pages; the table does neither. A server
// component reads the filters, the sort and the cursor from its `searchParams`, calls the SDK and hands the rows and
// the `page` to the table, which links the next page (`cursor=<page.nextCursor>`) and back to the first one with the
// other parameters kept, so every view of a list is a shareable link. Filter components above the table write
// `searchParams` only (`listHref`). This is a client module: server components render `DataTable` but cannot call its
// helpers, which reach them as client references.
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DEFAULT_LOCALE } from "@/components/money";
import { cn } from "@/lib/utils";

/** The query parameter of the list operations' cursor (`page.nextCursor` of the previous page). */
export const CURSOR_PARAM = "cursor";

/** The highest exact `totalCount` of `console.bookings.list`: above it the API answers `null`. */
export const TOTAL_COUNT_LIMIT = 10_000;

export const TABLE_STRINGS = Object.freeze({
  empty: "Nothing matches these filters.",
  paginationLabel: "Pages",
  firstPage: "First page",
  nextPage: "Next page",
  total: (count: string) => `${count} in total`,
});

/** What a list URL changes: a value sets the parameter, `null` or `""` removes it; the others stay as they are. */
export type SearchParamChanges = Readonly<Record<string, string | null | undefined>>;

/** The query of the page being rendered, as `useSearchParams` or a server component's `searchParams` give it. */
export interface ReadableSearchParams {
  forEach(callback: (value: string, name: string) => void): void;
}

/**
 * The URL of the list `pathname` with the query `current` changed by `changes`. Parameters that `changes` does not
 * name keep their values, repeated ones (`status=confirmed&status=ticketed`) included, in their order; a changed one
 * moves to the end. An unchanged URL without a query is the bare path. A filter change also passes
 * `{ cursor: null }`, so the new view starts on its first page.
 */
export function listHref(
  pathname: string,
  current: ReadableSearchParams,
  changes: SearchParamChanges,
): string {
  const next = new URLSearchParams();
  current.forEach((value, name) => {
    if (!Object.hasOwn(changes, name)) {
      next.append(name, value);
    }
  });
  for (const [name, value] of Object.entries(changes)) {
    if (value !== null && value !== undefined && value !== "") {
      next.set(name, value);
    }
  }
  const query = next.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

/**
 * The total of a list as the table shows it: the exact count, `10,000+` when the API answers `null` (it counts
 * exactly up to 10 000), and nothing when the operation gives no count.
 */
export function formatTotalCount(totalCount: number | null | undefined): string | undefined {
  if (totalCount === undefined) {
    return undefined;
  }
  const format = new Intl.NumberFormat(DEFAULT_LOCALE);
  return totalCount === null ? `${format.format(TOTAL_COUNT_LIMIT)}+` : format.format(totalCount);
}

/** The `page` of a list answer (`PageInfo` of the OTA document): only the cursor of the next page matters here. */
export interface ListPage {
  readonly nextCursor: string | null;
}

export interface DataTableProps<Row, Value> {
  /** The columns, defined in a client module next to the page (cells may render links, badges, money). */
  readonly columns: ColumnDef<Row, Value>[];
  /** The rows, as the server component fetched them. */
  readonly data: readonly Row[];
  /** What the table lists ("Bookings"): its caption, read by screen readers. */
  readonly caption: string;
  /** Show the caption on screen too; it is visually hidden by default. */
  readonly captionVisible?: boolean;
  /** The text of an empty table (per saved view: "No booking needs attention"). */
  readonly emptyMessage?: string;
  /** A stable id per row (the resource id), so rows keep their identity across renders. */
  readonly getRowId?: (row: Row, index: number) => string;
  /** The `page` of the list answer: with it, the table links the next page and, on a later page, the first. */
  readonly page?: ListPage;
  /** The list's `totalCount` when the operation gives one (`null`: more than 10 000). */
  readonly totalCount?: number | null;
  /** The filters of the list (a client component that writes `searchParams`), above the table. */
  readonly toolbar?: ReactNode;
  readonly className?: string;
}

/** A server-filtered, cursor-paged table. */
export function DataTable<Row, Value>({
  columns,
  data,
  caption,
  captionVisible = false,
  emptyMessage = TABLE_STRINGS.empty,
  getRowId,
  page,
  totalCount,
  toolbar,
  className,
}: DataTableProps<Row, Value>) {
  const table = useReactTable({
    data: data as Row[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    ...(getRowId === undefined ? {} : { getRowId }),
  });
  const rows = table.getRowModel().rows;
  const total = formatTotalCount(totalCount);
  return (
    <div className={cn("grid gap-4", className)}>
      {toolbar}
      {total === undefined ? null : (
        <p className="text-sm text-muted-foreground tabular-nums">{TABLE_STRINGS.total(total)}</p>
      )}
      <Table>
        <TableCaption className={cn(captionVisible ? "mt-0 mb-4 caption-top text-left" : "sr-only")}>
          {caption}
        </TableCaption>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} scope="col" colSpan={header.colSpan}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={Math.max(columns.length, 1)}
                className="h-20 text-center text-muted-foreground"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {page === undefined ? null : <CursorPagination nextCursor={page.nextCursor} />}
    </div>
  );
}

const PAGE_LINK_CLASS =
  "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

/** "First page" on a later page and "Next page" while there is one; nothing on a single page. */
function CursorPagination({ nextCursor }: { readonly nextCursor: string | null }) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams() ?? new URLSearchParams();
  const onLaterPage = (searchParams.get(CURSOR_PARAM) ?? "") !== "";
  if (!onLaterPage && nextCursor === null) {
    return null;
  }
  return (
    <nav aria-label={TABLE_STRINGS.paginationLabel} className="flex flex-wrap justify-end gap-2">
      {onLaterPage ? (
        <Link href={listHref(pathname, searchParams, { [CURSOR_PARAM]: null })} className={PAGE_LINK_CLASS}>
          {TABLE_STRINGS.firstPage}
        </Link>
      ) : null}
      {nextCursor === null ? null : (
        <Link
          href={listHref(pathname, searchParams, { [CURSOR_PARAM]: nextCursor })}
          className={PAGE_LINK_CLASS}
        >
          {TABLE_STRINGS.nextPage}
        </Link>
      )}
    </nav>
  );
}
