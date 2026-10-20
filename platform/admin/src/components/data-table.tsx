"use client";

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TABLE_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** The query parameter of the list operations' cursor (`page.nextCursor` of the previous page). */
export const CURSOR_PARAM = "cursor";

/** What a list URL changes: a value sets the parameter, `null` or `""` removes it; the others stay as they are. */
export type SearchParamChanges = Readonly<Record<string, string | null | undefined>>;

/** The query of the page being rendered, as `useSearchParams` or a server component's `searchParams` give it. */
export interface ReadableSearchParams {
  forEach(callback: (value: string, name: string) => void): void;
}

/**
 * The URL of the list `pathname` with the query `current` changed by `changes` (README §4: filters and the cursor
 * live in the URL, so every list page is a shareable link). Parameters that `changes` does not name keep their values,
 * repeated ones included, in their order; a changed one moves to the end. An unchanged URL without a query is the
 * bare path.
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

/** The page of a list answer (`Page` of the platform document): only the cursor of the next page matters here. */
export interface ListPage {
  readonly nextCursor: string | null;
}

export interface DataTableProps<Row, Value> {
  /** The columns, defined in a client module next to the page (cells may render links, badges, actions). */
  readonly columns: ColumnDef<Row, Value>[];
  /** The rows, as the server component fetched them. */
  readonly data: readonly Row[];
  /** What the table lists ("Tenants"): its caption, read by screen readers. */
  readonly caption: string;
  /** Show the caption on screen too; it is visually hidden by default. */
  readonly captionVisible?: boolean;
  /** The text of an empty table. */
  readonly emptyMessage?: string;
  /** A stable id per row (the resource id), so rows keep their identity across renders. */
  readonly getRowId?: (row: Row, index: number) => string;
  /**
   * The `page` of the list answer. With it, the table links to the next page (`cursor=<nextCursor>`) and, on a later
   * page, back to the first; the filters in the URL stay.
   */
  readonly page?: ListPage;
  readonly className?: string;
}

/**
 * The shadcn/ui data table on TanStack Table (ADR-0014, README §3 and §4): tenants, jobs, queues, accounts, the audit
 * log. Server components fetch the rows with the filters and the cursor of the page URL; the table renders them and
 * links the pages, so every page of a filtered list is a shareable link. The API sorts; the table does not.
 */
export function DataTable<Row, Value>({
  columns,
  data,
  caption,
  captionVisible = false,
  emptyMessage = TABLE_STRINGS.empty,
  getRowId,
  page,
  className,
}: DataTableProps<Row, Value>) {
  const table = useReactTable({
    data: data as Row[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    ...(getRowId === undefined ? {} : { getRowId }),
  });
  const rows = table.getRowModel().rows;
  return (
    <div className={cn("grid gap-4", className)}>
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
