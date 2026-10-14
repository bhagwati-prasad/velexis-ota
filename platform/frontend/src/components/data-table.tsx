"use client";

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";

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

export interface DataTableProps<Row, Value> {
  /** The columns, defined in a client module next to the page (cells may render links, badges, actions). */
  readonly columns: ColumnDef<Row, Value>[];
  /** The rows, as the server component fetched them. */
  readonly data: readonly Row[];
  /** What the table lists ("API keys"): its caption, read by screen readers. */
  readonly caption: string;
  /** Show the caption on screen too; it is visually hidden by default. */
  readonly captionVisible?: boolean;
  /** The text of an empty table. */
  readonly emptyMessage?: string;
  /** A stable id per row (the resource id), so rows keep their identity across renders. */
  readonly getRowId?: (row: Row, index: number) => string;
  readonly className?: string;
}

/**
 * The shadcn/ui data table on TanStack Table (ADR-0014, README §4): invoices, settlements, API keys. Server
 * components fetch the rows; paging is by the API's cursor in the page URL, so the table only renders.
 */
export function DataTable<Row, Value>({
  columns,
  data,
  caption,
  captionVisible = false,
  emptyMessage = TABLE_STRINGS.empty,
  getRowId,
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
    <Table className={className}>
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
  );
}
