"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";

import { DataTable, type ListPage } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status-badge";
import { JOB_KIND_LABELS, JOB_LIST_STRINGS as S } from "@/lib/strings";

/** One row of `adminListProvisioningJobs`. */
export type JobSummary = components["schemas"]["AdminProvisioningJob"];

const LINK_CLASS = "font-medium underline-offset-4 hover:underline focus-visible:underline";

/** The label of a job kind, or the raw kind for one this build does not know yet (a newer API). */
function kindLabel(kind: string): string {
  return Object.hasOwn(JOB_KIND_LABELS, kind) ? JOB_KIND_LABELS[kind as keyof typeof JOB_KIND_LABELS] : kind;
}

function Muted({ children }: { readonly children: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** An instant, or "Not yet" for `null`. */
function When({ value }: { readonly value: string | null }) {
  return value === null ? <Muted>{S.notYet}</Muted> : <DateTime value={value} />;
}

const COLUMNS: ColumnDef<JobSummary>[] = [
  {
    id: "job",
    header: S.columnJob,
    cell: ({ row }) => (
      <Link
        href={`/provisioning-jobs/${encodeURIComponent(row.original.id)}`}
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
      <Link
        href={`/tenants/${encodeURIComponent(row.original.tenantId)}`}
        className={`${LINK_CLASS} font-mono`}
      >
        {row.original.tenantKey}
      </Link>
    ),
  },
  {
    id: "kind",
    header: S.columnKind,
    cell: ({ row }) => kindLabel(row.original.kind),
  },
  {
    id: "status",
    header: S.columnStatus,
    cell: ({ row }) => <StatusBadge kind="job" status={row.original.status} />,
  },
  {
    id: "step",
    header: S.columnStep,
    cell: ({ row }) =>
      row.original.step === null ? (
        <Muted>{S.notYet}</Muted>
      ) : (
        <span className="font-mono text-xs">{row.original.step}</span>
      ),
  },
  {
    id: "attempts",
    header: S.columnAttempts,
    cell: ({ row }) => (
      <span className="tabular-nums">{S.attemptsOf(row.original.attempt, row.original.maxAttempts)}</span>
    ),
  },
  {
    id: "error",
    header: S.columnError,
    cell: ({ row }) =>
      row.original.error === null ? (
        <Muted>{S.none}</Muted>
      ) : (
        <span className="block max-w-md whitespace-normal">{row.original.error}</span>
      ),
  },
  {
    id: "scheduled",
    header: S.columnScheduled,
    cell: ({ row }) => <DateTime value={row.original.scheduledAt} />,
  },
  {
    id: "started",
    header: S.columnStarted,
    cell: ({ row }) => <When value={row.original.startedAt} />,
  },
  {
    id: "finished",
    header: S.columnFinished,
    cell: ({ row }) => <When value={row.original.finishedAt} />,
  },
];

export interface JobTableProps {
  /** The rows of `adminListProvisioningJobs`. */
  readonly jobs: readonly JobSummary[];
  /** The `page` of the answer: "Next page" while there is one, keeping the filters of the URL. */
  readonly page: ListPage;
}

/**
 * The tenant jobs of one page of `/provisioning-jobs` (PF-83): the job (linking to its page with the step log and the
 * actions), the OTA (linking to its tenant page), kind, status, step, attempts, last error and the three times. The
 * page's server component fetches the rows with the filters and the cursor of its URL; `DataTable` links the next
 * page with the same filters, so every page of a filtered list is a shareable link.
 */
export function JobTable({ jobs, page }: JobTableProps) {
  return (
    <DataTable
      columns={COLUMNS}
      data={jobs}
      caption={S.caption}
      emptyMessage={S.empty}
      getRowId={(row) => row.id}
      page={page}
    />
  );
}
