"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { useState } from "react";

import { reprocessStripeEvent, type ReprocessState } from "@/app/(app)/stripe-events/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, type ListPage } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status-badge";
import { isStepUpRequired, useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  STRIPE_EVENT_ACTION_STRINGS as A,
  STRIPE_EVENT_ENDPOINT_LABELS,
  STRIPE_EVENT_LIST_STRINGS as L,
  formatCount,
} from "@/lib/strings";

/**
 * The Stripe webhook inbox of `/stripe-events` (README §2; PF-89, PAD-012) in the API's order (failed and ignored
 * first) and "Reprocess" on each `failed` or `ignored` event, the only statuses `adminReprocessStripeEvent` takes
 * (`ConfirmDialog`, no reason: the operation asks for none). The outcome of the last reprocess stays above the table
 * while the revalidated page shows the event as received. The rows hold only the fields the table shows.
 */

type AdminStripeEvent = components["schemas"]["AdminStripeEvent"];

/** One event as the table shows it: the fields of `AdminStripeEvent` it needs, and nothing else. */
export interface StripeEventRow {
  readonly id: string;
  readonly endpoint: AdminStripeEvent["endpoint"];
  readonly type: string;
  readonly status: AdminStripeEvent["status"];
  readonly attempts: number;
  readonly lastError: string | null;
  readonly tenantId: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
}

/** The statuses `adminReprocessStripeEvent` takes; any other answers `409 CONFLICT`. */
const REPROCESSABLE: ReadonlySet<StripeEventRow["status"]> = new Set(["failed", "ignored"]);

/** Whether "Reprocess" is offered for an event. */
function canReprocess(status: StripeEventRow["status"]): boolean {
  return REPROCESSABLE.has(status);
}

const ENDPOINTS: Readonly<Record<string, string>> = STRIPE_EVENT_ENDPOINT_LABELS;

const IDLE: ReprocessState = { status: "idle" };

const LINK_CLASS = "font-medium underline-offset-4 hover:underline focus-visible:underline";

function Muted({ children }: { readonly children: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

export interface StripeEventTableProps {
  /** The events of the page, failed and ignored first. */
  readonly events: readonly StripeEventRow[];
  /** The `page` of the answer: "Next page" while there is one, keeping the filters of the URL. */
  readonly page: ListPage;
}

export function StripeEventTable({ events, page }: StripeEventTableProps) {
  const reprocess = useStepUpAction(reprocessStripeEvent, IDLE);
  // An outcome shows once a reprocess ran; until then nothing does.
  const [ran, setRan] = useState(false);

  const columns: ColumnDef<StripeEventRow>[] = [
    {
      id: "event",
      header: L.columnEvent,
      cell: ({ row }) => (
        <span className="grid gap-1">
          <span className="font-mono text-xs break-all">{row.original.id}</span>
          <span className="text-xs text-muted-foreground">
            {Object.hasOwn(ENDPOINTS, row.original.endpoint)
              ? ENDPOINTS[row.original.endpoint]
              : row.original.endpoint}
          </span>
        </span>
      ),
    },
    {
      id: "type",
      header: L.columnType,
      cell: ({ row }) => <span className="font-mono text-xs break-all">{row.original.type}</span>,
    },
    {
      id: "status",
      header: L.columnStatus,
      cell: ({ row }) => <StatusBadge kind="stripeEvent" status={row.original.status} />,
    },
    {
      id: "attempts",
      header: L.columnAttempts,
      cell: ({ row }) => <span className="tabular-nums">{formatCount(row.original.attempts)}</span>,
    },
    {
      id: "error",
      header: L.columnError,
      cell: ({ row }) =>
        row.original.lastError === null ? (
          <Muted>{L.none}</Muted>
        ) : (
          <span className="block max-w-xs text-xs break-words whitespace-normal">
            {row.original.lastError}
          </span>
        ),
    },
    {
      id: "ota",
      header: L.columnOta,
      cell: ({ row }) =>
        row.original.tenantId === null ? (
          <Muted>{L.noTenant}</Muted>
        ) : (
          <Link
            href={`/tenants/${encodeURIComponent(row.original.tenantId)}?tab=subscription`}
            className={`${LINK_CLASS} font-mono text-xs break-all`}
          >
            {row.original.tenantId}
          </Link>
        ),
    },
    {
      id: "received",
      header: L.columnReceived,
      cell: ({ row }) => <DateTime value={row.original.receivedAt} />,
    },
    {
      id: "processed",
      header: L.columnProcessed,
      cell: ({ row }) =>
        row.original.processedAt === null ? (
          <Muted>{L.notYet}</Muted>
        ) : (
          <DateTime value={row.original.processedAt} />
        ),
    },
    {
      id: "actions",
      header: L.columnActions,
      cell: ({ row }) => {
        const event = row.original;
        if (!canReprocess(event.status)) {
          return null;
        }
        return (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm" disabled={reprocess.isPending}>
                {A.reprocess}
                <span className="sr-only">{A.eventSuffix(event.id)}</span>
              </Button>
            }
            title={A.confirmTitle(event.id)}
            description={A.confirmDescription(event.type)}
            confirmLabel={A.confirm}
            destructive={false}
            onConfirm={() => {
              const formData = new FormData();
              formData.set("eventId", event.id);
              setRan(true);
              reprocess.dispatch(formData);
            }}
          />
        );
      },
    },
  ];

  return (
    <div className="grid gap-4">
      {ran ? <Outcome state={reprocess.state} /> : null}
      {reprocess.isPending ? <p className="text-sm text-muted-foreground">{A.working}</p> : null}
      <DataTable
        columns={columns}
        data={events}
        caption={L.caption}
        emptyMessage={L.empty}
        getRowId={(row) => row.id}
        page={page}
      />
      {reprocess.stepUpDialog}
    </div>
  );
}

/** The outcome of the last reprocess: queued, or the refusal in words. A step-up request is no answer yet. */
function Outcome({ state }: { readonly state: ReprocessState }) {
  if (state.status === "idle" || isStepUpRequired(state)) {
    return null;
  }
  if (state.status === "failed") {
    return (
      <Alert variant="destructive" data-notice="failed" data-code={state.code}>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <p role="status" data-notice="done" className="rounded-lg border px-4 py-3 text-sm font-medium">
      {A.done(state.eventId)}
    </p>
  );
}
