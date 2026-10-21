"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import type { ReactNode } from "react";

import { DataTable, type ListPage } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { JsonView } from "@/components/json-view";
import { AUDIT_ACTOR_LABELS, AUDIT_STRINGS as S } from "@/lib/strings";

/** One row of `adminListAudit` (and of the `recentAudit` of an account), as `auditRowOf` keeps it. */
type AuditRow = components["schemas"]["AuditEntry"];

const LINK_CLASS = "font-medium underline-offset-4 hover:underline focus-visible:underline";

/** The label of an actor type, or the raw type for one this build does not know yet (a newer API). */
function actorLabel(type: string): string {
  return Object.hasOwn(AUDIT_ACTOR_LABELS, type)
    ? AUDIT_ACTOR_LABELS[type as keyof typeof AUDIT_ACTOR_LABELS]
    : type;
}

function Muted({ children }: { readonly children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>;
}

/** The page of an object the admin has one for: accounts and OTAs. */
function targetHref(type: string | null, id: string | null): string | undefined {
  if (id === null) {
    return undefined;
  }
  if (type === "account") {
    return `/accounts/${encodeURIComponent(id)}`;
  }
  return type === "tenant" ? `/tenants/${encodeURIComponent(id)}` : undefined;
}

const COLUMNS: ColumnDef<AuditRow>[] = [
  {
    id: "when",
    header: S.columnWhen,
    cell: ({ row }) => <DateTime value={row.original.createdAt} />,
  },
  {
    id: "ota",
    header: S.columnOta,
    cell: ({ row }) =>
      row.original.tenantId === null ? (
        <Muted>{S.none}</Muted>
      ) : (
        <Link
          href={`/tenants/${encodeURIComponent(row.original.tenantId)}`}
          className={`${LINK_CLASS} font-mono`}
        >
          {row.original.tenantKey ?? row.original.tenantId}
        </Link>
      ),
  },
  {
    id: "actor",
    header: S.columnActor,
    cell: ({ row }) => {
      const { actorType, actorAccountId, actorLabel: label } = row.original;
      return (
        <span className="grid gap-0.5">
          <span>{actorLabel(actorType)}</span>
          {label === null ? null : actorAccountId === null ? (
            <span className="text-xs break-all text-muted-foreground">{label}</span>
          ) : (
            <Link
              href={`/accounts/${encodeURIComponent(actorAccountId)}`}
              className={`${LINK_CLASS} text-xs break-all`}
            >
              {label}
            </Link>
          )}
        </span>
      );
    },
  },
  {
    id: "action",
    header: S.columnAction,
    cell: ({ row }) => <Mono>{row.original.action}</Mono>,
  },
  {
    id: "target",
    header: S.columnTarget,
    cell: ({ row }) => {
      const { targetType, targetId } = row.original;
      if (targetType === null && targetId === null) {
        return <Muted>{S.none}</Muted>;
      }
      const label = [targetType, targetId].filter((part) => part !== null).join(" ");
      const href = targetHref(targetType, targetId);
      return href === undefined ? (
        <Mono>{label}</Mono>
      ) : (
        <Link href={href} className={`${LINK_CLASS} font-mono text-xs break-all`}>
          {label}
        </Link>
      );
    },
  },
  {
    id: "request",
    header: S.columnRequest,
    cell: ({ row }) =>
      row.original.requestId === null ? <Muted>{S.none}</Muted> : <Mono>{row.original.requestId}</Mono>,
  },
  {
    id: "client",
    header: S.columnClient,
    cell: ({ row }) =>
      row.original.ipAddress === null && row.original.userAgent === null ? (
        <Muted>{S.none}</Muted>
      ) : (
        <span className="grid max-w-56 gap-0.5 whitespace-normal">
          {row.original.ipAddress === null ? null : <Mono>{row.original.ipAddress}</Mono>}
          {row.original.userAgent === null ? null : (
            <span className="text-xs break-words text-muted-foreground">{row.original.userAgent}</span>
          )}
        </span>
      ),
  },
  {
    id: "details",
    header: S.columnDetails,
    cell: ({ row }) => (
      <JsonView value={row.original.details} label={S.detailsOf(row.original.id)} className="min-w-64" />
    ),
  },
];

export interface AuditTableProps {
  /** The rows, newest first, as `auditRowOf` keeps them. */
  readonly rows: readonly AuditRow[];
  /** The `page` of a list answer: "Next page" while there is one, keeping the filters of the URL. */
  readonly page?: ListPage;
  /** The text of an empty table. */
  readonly emptyMessage?: string;
}

/**
 * Audit rows (README §2 `/audit`, PF-85): when, the OTA (linking its page), the actor (its kind, and its e-mail
 * snapshot linking the account), the dotted action, the target (linking an account or an OTA), the request id, the IP
 * address and browser, and the redacted details in `JsonView`. The audit search pages with the cursor; an account's
 * page shows its recent rows without paging.
 */
export function AuditTable({ rows, page, emptyMessage = S.empty }: AuditTableProps) {
  return (
    <DataTable
      columns={COLUMNS}
      data={rows}
      caption={S.caption}
      emptyMessage={emptyMessage}
      getRowId={(row) => row.id}
      {...(page === undefined ? {} : { page })}
    />
  );
}
