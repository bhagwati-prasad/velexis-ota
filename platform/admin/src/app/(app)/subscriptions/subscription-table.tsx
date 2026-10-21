"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";

import { DataTable, type ListPage } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status-badge";
import {
  BILLING_INTERVAL_LABELS,
  BILLING_PROVIDER_LABELS,
  SUBSCRIPTION_LIST_STRINGS as S,
} from "@/lib/strings";

type AdminSubscription = components["schemas"]["AdminSubscription"];

/** The fields of one row that the table shows; the page hands it nothing else. */
export type SubscriptionRow = Pick<
  AdminSubscription,
  | "id"
  | "tenantId"
  | "tenantKey"
  | "tenantName"
  | "planCode"
  | "planName"
  | "status"
  | "billingProvider"
  | "billingInterval"
  | "trialEndsAt"
  | "currentPeriodEnd"
  | "createdAt"
>;

const LINK_CLASS = "font-medium underline-offset-4 hover:underline focus-visible:underline";

function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}

/** An instant, or "None" for `null`. */
function When({ value }: { readonly value: string | null }) {
  return value === null ? (
    <span className="text-muted-foreground">{S.none}</span>
  ) : (
    <DateTime value={value} />
  );
}

const COLUMNS: ColumnDef<SubscriptionRow>[] = [
  {
    id: "subscription",
    header: S.columnSubscription,
    cell: ({ row }) => (
      <Link
        href={`/subscriptions/${encodeURIComponent(row.original.id)}`}
        className={`${LINK_CLASS} font-mono text-xs break-all`}
      >
        {row.original.id}
      </Link>
    ),
  },
  {
    id: "ota",
    header: S.columnOta,
    cell: ({ row }) => (
      <span className="grid gap-0.5">
        <Link href={`/tenants/${encodeURIComponent(row.original.tenantId)}`} className={LINK_CLASS}>
          {row.original.tenantName}
        </Link>
        <span className="font-mono text-xs text-muted-foreground">{row.original.tenantKey}</span>
      </span>
    ),
  },
  {
    id: "plan",
    header: S.columnPlan,
    cell: ({ row }) => (
      <span>
        {row.original.planName}{" "}
        <span className="font-mono text-xs text-muted-foreground">{row.original.planCode}</span>
      </span>
    ),
  },
  {
    id: "status",
    header: S.columnStatus,
    cell: ({ row }) => <StatusBadge kind="subscription" status={row.original.status} />,
  },
  {
    id: "billing",
    header: S.columnBilling,
    cell: ({ row }) => (
      <span className="grid gap-0.5">
        <span>{labelOf(BILLING_PROVIDER_LABELS, row.original.billingProvider)}</span>
        <span className="text-xs text-muted-foreground">
          {labelOf(BILLING_INTERVAL_LABELS, row.original.billingInterval)}
        </span>
      </span>
    ),
  },
  {
    id: "trialEnds",
    header: S.columnTrialEnds,
    cell: ({ row }) => <When value={row.original.trialEndsAt} />,
  },
  {
    id: "periodEnds",
    header: S.columnPeriodEnds,
    cell: ({ row }) => <When value={row.original.currentPeriodEnd} />,
  },
  {
    id: "created",
    header: S.columnCreated,
    cell: ({ row }) => <DateTime value={row.original.createdAt} />,
  },
];

export interface SubscriptionTableProps {
  /** The rows of `adminListSubscriptions`, with only the fields the table shows. */
  readonly subscriptions: readonly SubscriptionRow[];
  /** The `page` of the answer: "Next page" while there is one, keeping the filters of the URL. */
  readonly page: ListPage;
}

/**
 * The subscriptions of one page of `/subscriptions`: the id (linking to the detail page), the OTA (linking to its
 * page), the plan, the status, who bills it and how often, the end of the trial and of the current period, and the
 * creation time. `DataTable` links the next page with the filters of the URL, so every page of a list is shareable.
 */
export function SubscriptionTable({ subscriptions, page }: SubscriptionTableProps) {
  return (
    <DataTable
      columns={COLUMNS}
      data={subscriptions}
      caption={S.caption}
      emptyMessage={S.empty}
      getRowId={(row) => row.id}
      page={page}
    />
  );
}
