"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";

import { DataTable, type ListPage } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status-badge";
import { ACCOUNT_LIST_STRINGS as S } from "@/lib/strings";

/** One row of `adminListAccounts`. */
export type AccountSummary = components["schemas"]["AdminAccountSummary"];

const LINK_CLASS = "font-medium underline-offset-4 hover:underline focus-visible:underline";

function Muted({ children }: { readonly children: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

const COLUMNS: ColumnDef<AccountSummary>[] = [
  {
    id: "account",
    header: S.columnAccount,
    cell: ({ row }) => (
      <span className="grid gap-0.5">
        <Link href={`/accounts/${encodeURIComponent(row.original.id)}`} className={LINK_CLASS}>
          {row.original.fullName}
        </Link>
        <span className="text-xs break-all text-muted-foreground">{row.original.email}</span>
      </span>
    ),
  },
  {
    id: "status",
    header: S.columnStatus,
    cell: ({ row }) => <StatusBadge kind="account" status={row.original.status} />,
  },
  {
    id: "mfa",
    header: S.columnMfa,
    cell: ({ row }) => (row.original.mfaEnabled ? S.mfaOn : <Muted>{S.mfaOff}</Muted>),
  },
  {
    id: "admin",
    header: S.columnAdmin,
    cell: ({ row }) => (row.original.isPlatformAdmin ? S.yes : <Muted>{S.no}</Muted>),
  },
  {
    id: "lastLogin",
    header: S.columnLastLogin,
    cell: ({ row }) =>
      row.original.lastLoginAt === null ? (
        <Muted>{S.never}</Muted>
      ) : (
        <DateTime value={row.original.lastLoginAt} />
      ),
  },
  {
    id: "created",
    header: S.columnCreated,
    cell: ({ row }) => <DateTime value={row.original.createdAt} />,
  },
];

export interface AccountTableProps {
  /** The rows of `adminListAccounts`. */
  readonly accounts: readonly AccountSummary[];
  /** The `page` of the answer: "Next page" while there is one, keeping the filters of the URL. */
  readonly page: ListPage;
}

/**
 * The accounts of one page of `/accounts` (PF-87): name (linking to the account's support page) and e-mail address,
 * status, two-factor, platform admin, last sign-in and creation. The page's server component fetches the rows with
 * the filters and the cursor of its URL; `DataTable` links the next page with the same filters.
 */
export function AccountTable({ accounts, page }: AccountTableProps) {
  return (
    <DataTable
      columns={COLUMNS}
      data={accounts}
      caption={S.caption}
      emptyMessage={S.empty}
      getRowId={(row) => row.id}
      page={page}
    />
  );
}
