"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";

import { DataTable, type ListPage } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status-badge";
import { TENANT_LIST_STRINGS } from "@/lib/strings";

/** One row of `adminListTenants`. */
export type TenantSummary = components["schemas"]["AdminTenantSummary"];

/** The detail page of an OTA. Not exported: a server module calling it from this client module would fail. */
function tenantHref(tenantId: string): string {
  return `/tenants/${encodeURIComponent(tenantId)}`;
}

function columns(planNames: Readonly<Record<string, string>>): ColumnDef<TenantSummary>[] {
  return [
    {
      id: "ota",
      header: TENANT_LIST_STRINGS.columnOta,
      cell: ({ row }) => (
        <div className="grid gap-0.5">
          <Link
            href={tenantHref(row.original.id)}
            className="font-medium underline-offset-4 hover:underline focus-visible:underline"
          >
            {row.original.name}
          </Link>
          <span className="font-mono text-xs text-muted-foreground">{row.original.key}</span>
        </div>
      ),
    },
    {
      id: "status",
      header: TENANT_LIST_STRINGS.columnStatus,
      cell: ({ row }) => <StatusBadge kind="tenant" status={row.original.status} />,
    },
    {
      id: "plan",
      header: TENANT_LIST_STRINGS.columnPlan,
      cell: ({ row }) => {
        const name = planNames[row.original.planCode];
        return name === undefined ? (
          <span className="font-mono text-xs">{row.original.planCode}</span>
        ) : (
          <span>
            {name} <span className="font-mono text-xs text-muted-foreground">{row.original.planCode}</span>
          </span>
        );
      },
    },
    {
      id: "owner",
      header: TENANT_LIST_STRINGS.columnOwner,
      cell: ({ row }) =>
        row.original.ownerEmail === null ? (
          <span className="text-muted-foreground">{TENANT_LIST_STRINGS.noOwner}</span>
        ) : (
          <span className="break-all">{row.original.ownerEmail}</span>
        ),
    },
    {
      id: "created",
      header: TENANT_LIST_STRINGS.columnCreated,
      cell: ({ row }) => <DateTime value={row.original.createdAt} />,
    },
    {
      id: "activated",
      header: TENANT_LIST_STRINGS.columnActivated,
      cell: ({ row }) =>
        row.original.activatedAt === null ? (
          <span className="text-muted-foreground">{TENANT_LIST_STRINGS.notYet}</span>
        ) : (
          <DateTime value={row.original.activatedAt} />
        ),
    },
  ];
}

export interface TenantTableProps {
  /** The rows of `adminListTenants`. */
  readonly tenants: readonly TenantSummary[];
  /** The `page` of the answer: "Next page" while there is one, keeping the filters of the URL. */
  readonly page: ListPage;
  /** Plan code → plan name, from `adminListPlans`; a code without a name shows as the code. */
  readonly planNames: Readonly<Record<string, string>>;
}

/**
 * The OTAs of one page of `/tenants` (PF-81): name (linking to the detail page) and key, status, plan, owner e-mail,
 * creation and set-up time. The page's server component fetches the rows with the filters and the cursor of its URL;
 * `DataTable` links the next page with the same filters, so every page of a search is a shareable link.
 */
export function TenantTable({ tenants, page, planNames }: TenantTableProps) {
  return (
    <DataTable
      columns={columns(planNames)}
      data={tenants}
      caption={TENANT_LIST_STRINGS.caption}
      emptyMessage={TENANT_LIST_STRINGS.empty}
      getRowId={(row) => row.id}
      page={page}
    />
  );
}
