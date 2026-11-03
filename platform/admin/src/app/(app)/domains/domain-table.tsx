"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { useState } from "react";

import {
  recheckDomain,
  removeDomain,
  type RecheckDomainState,
  type RemoveDomainState,
} from "@/app/(app)/domains/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, type ListPage } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { isStepUpRequired, useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DOMAIN_ACTION_STRINGS as S,
  DOMAIN_CHECK_ERRORS,
  DOMAIN_KIND_LABELS,
  DOMAIN_LIST_STRINGS as L,
} from "@/lib/strings";

/**
 * The storefront hosts of `/domains` (README §2; PADR-0004; PF-92) and the actions on each: **Re-check** queues the
 * checks of the host now (`ConfirmDialog`, saying what is checked for its kind and status), **Remove** deletes an
 * abusive custom domain with a reason (`ReasonDialog`; a sub-domain offers none). The outcome of the last action stays
 * above the table while the revalidated page shows the hosts as they are now. The rows hold only the fields the table
 * shows.
 */

type Schemas = components["schemas"];
type AdminDomain = Schemas["AdminDomain"];

/** One host as the table shows it: the fields of `AdminDomain` it needs, and nothing else. */
export interface DomainRow {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly hostname: string;
  readonly kind: AdminDomain["kind"];
  readonly isPrimary: boolean;
  readonly verificationStatus: AdminDomain["verificationStatus"];
  readonly verifiedAt: string | null;
  readonly verificationDeadlineAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckError: string | null;
  readonly checkFailures: number;
  readonly tlsStatus: AdminDomain["tlsStatus"];
  readonly tlsExpiresAt: string | null;
  readonly tlsCheckedAt: string | null;
  readonly createdAt: string;
}

const IDLE_RECHECK: RecheckDomainState = { status: "idle" };
const IDLE_REMOVE: RemoveDomainState = { status: "idle" };

const LINK_CLASS = "font-medium underline-offset-4 hover:underline focus-visible:underline";

const CHECK_ERRORS: Readonly<Record<string, string>> = DOMAIN_CHECK_ERRORS;

function Muted({ children }: { readonly children: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** What the last DNS check found missing, in words; a code the list does not know yet shows as the API answers it. */
export function checkErrorText(code: string): string {
  return Object.hasOwn(CHECK_ERRORS, code) ? (CHECK_ERRORS[code] ?? code) : `${L.otherCheckError} ${code}`;
}

/** What "Re-check" does for this host: the DNS check its kind and status call for, and the TLS probe. */
function recheckDescription(row: DomainRow): string {
  if (row.kind === "subdomain") {
    return S.recheckSubdomain;
  }
  if (row.verificationStatus === "pending") {
    return S.recheckPending;
  }
  return row.verificationStatus === "verified" ? S.recheckVerified : S.recheckFailed;
}

type ActionId = "recheck" | "remove";

export interface DomainTableProps {
  /** The hosts of the page, newest first. */
  readonly domains: readonly DomainRow[];
  /** The `page` of the answer: "Next page" while there is one, keeping the filters of the URL. */
  readonly page: ListPage;
}

export function DomainTable({ domains, page }: DomainTableProps) {
  const recheck = useStepUpAction(recheckDomain, IDLE_RECHECK);
  const remove = useStepUpAction(removeDomain, IDLE_REMOVE);
  // The outcome shown is the one of the action that ran last.
  const [latest, setLatest] = useState<ActionId | undefined>(undefined);
  const pending = recheck.isPending || remove.isPending;

  const columns: ColumnDef<DomainRow>[] = [
    {
      id: "host",
      header: L.columnHost,
      cell: ({ row }) => (
        <span className="grid gap-1">
          <span className="font-mono break-all">{row.original.hostname}</span>
          {row.original.isPrimary ? <span className="text-xs font-medium">{L.primary}</span> : null}
        </span>
      ),
    },
    {
      id: "ota",
      header: L.columnOta,
      cell: ({ row }) => (
        <Link
          href={`/tenants/${encodeURIComponent(row.original.tenantId)}?tab=domains`}
          className={`${LINK_CLASS} font-mono`}
        >
          {row.original.tenantKey}
        </Link>
      ),
    },
    {
      id: "kind",
      header: L.columnKind,
      cell: ({ row }) => DOMAIN_KIND_LABELS[row.original.kind],
    },
    {
      id: "verification",
      header: L.columnVerification,
      cell: ({ row }) => {
        const domain = row.original;
        return (
          <span className="grid gap-1">
            <StatusBadge kind="domain" status={domain.verificationStatus} />
            {domain.verifiedAt === null ? null : (
              <span className="text-xs text-muted-foreground">
                {L.verifiedOn} <DateTime value={domain.verifiedAt} mode="date" />
              </span>
            )}
            {domain.verificationStatus === "pending" && domain.verificationDeadlineAt !== null ? (
              <span className="text-xs text-muted-foreground">
                {L.deadline} <DateTime value={domain.verificationDeadlineAt} />
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "lastCheck",
      header: L.columnLastCheck,
      cell: ({ row }) => {
        const domain = row.original;
        if (domain.lastCheckedAt === null) {
          return <Muted>{L.neverChecked}</Muted>;
        }
        return (
          <span className="grid max-w-xs gap-1">
            <DateTime value={domain.lastCheckedAt} />
            <span className="text-xs" data-check-error={domain.lastCheckError ?? ""}>
              {domain.lastCheckError === null ? L.checkPassed : checkErrorText(domain.lastCheckError)}
            </span>
            {domain.checkFailures > 0 ? (
              <span className="text-xs font-medium text-red-900">
                {L.checkFailures(domain.checkFailures)}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "tls",
      header: L.columnTls,
      cell: ({ row }) => {
        const domain = row.original;
        return (
          <span className="grid gap-1">
            <StatusBadge kind="tls" status={domain.tlsStatus} />
            <span className="text-xs text-muted-foreground">
              {domain.tlsExpiresAt === null ? (
                L.noTls
              ) : (
                <>
                  {L.tlsExpires} <DateTime value={domain.tlsExpiresAt} mode="date" />
                </>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {domain.tlsCheckedAt === null ? (
                L.tlsNeverChecked
              ) : (
                <>
                  {L.tlsChecked} <DateTime value={domain.tlsCheckedAt} />
                </>
              )}
            </span>
          </span>
        );
      },
    },
    {
      id: "added",
      header: L.columnAdded,
      cell: ({ row }) => <DateTime value={row.original.createdAt} />,
    },
    {
      id: "actions",
      header: L.columnActions,
      cell: ({ row }) => {
        const domain = row.original;
        return (
          <span className="flex flex-wrap gap-2">
            <ConfirmDialog
              trigger={
                <Button variant="outline" size="sm" disabled={pending}>
                  {S.recheck}
                  <span className="sr-only">{S.hostSuffix(domain.hostname)}</span>
                </Button>
              }
              title={S.recheckTitle(domain.hostname)}
              description={recheckDescription(domain)}
              confirmLabel={S.recheckConfirm}
              destructive={false}
              onConfirm={() => {
                const formData = new FormData();
                formData.set("domainId", domain.id);
                formData.set("hostname", domain.hostname);
                setLatest("recheck");
                recheck.dispatch(formData);
              }}
            />
            {domain.kind === "custom" ? (
              <ReasonDialog
                trigger={
                  <Button variant="outline" size="sm" disabled={pending}>
                    {S.remove}
                    <span className="sr-only">{S.hostSuffix(domain.hostname)}</span>
                  </Button>
                }
                title={S.removeTitle(domain.hostname)}
                description={S.removeDescription(domain.tenantKey)}
                confirmLabel={S.removeConfirm}
                onConfirm={(formData) => {
                  setLatest("remove");
                  remove.dispatch(formData);
                }}
              >
                <input type="hidden" name="domainId" value={domain.id} />
                <input type="hidden" name="hostname" value={domain.hostname} />
                <input type="hidden" name="tenantId" value={domain.tenantId} />
              </ReasonDialog>
            ) : null}
          </span>
        );
      },
    },
  ];

  const outcome = latest === undefined ? undefined : { recheck: recheck.state, remove: remove.state }[latest];
  return (
    <div className="grid gap-4">
      {outcome === undefined || latest === undefined ? null : <Outcome action={latest} state={outcome} />}
      {pending ? <p className="text-sm text-muted-foreground">{S.working}</p> : null}
      <DataTable
        columns={columns}
        data={domains}
        caption={L.caption}
        emptyMessage={L.empty}
        getRowId={(row) => row.id}
        page={page}
      />
      {recheck.stepUpDialog}
      {remove.stepUpDialog}
    </div>
  );
}

/** The outcome of the last action: done in words, or a refusal. A step-up request is no answer yet. */
function Outcome({
  action,
  state,
}: {
  readonly action: ActionId;
  readonly state: RecheckDomainState | RemoveDomainState;
}) {
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
      {action === "recheck" ? S.rechecked(state.hostname) : S.removed(state.hostname)}
    </p>
  );
}
