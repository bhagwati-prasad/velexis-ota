import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  isShownStatus,
  STATEMENT_TIME_ZONE,
  statementMonth,
  statementPath,
  statementsPath,
  type SettlementSummary,
} from "@/app/(app)/otas/[tenantId]/payments/settlements/statements";
import { DateTime } from "@/components/date-time";
import { Money } from "@/components/money";
import { NotAllowed } from "@/components/not-allowed";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { platformApi, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can, otaPath } from "@/lib/roles";
import { SETTLEMENTS_STRINGS } from "@/lib/strings";
import { requireTenant } from "@/lib/tenant";

export const metadata: Metadata = { title: SETTLEMENTS_STRINGS.title };

type SettlementList = components["schemas"]["SettlementList"];

/**
 * `listSettlements` (owners and finance members). An ended session goes to sign-in and back to this page, an
 * unverified account to `/verify-pending`, an OTA the caller is no member of (any more) to the not-found page; other
 * failures are returned for the page to show the portal's message.
 */
async function loadStatements(tenantId: string): Promise<ApiResult<SettlementList>> {
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/settlements", { params: { path: { tenantId } } });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: statementsPath(tenantId) }).toString()}`);
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
    if (code === "NOT_FOUND") {
      notFound();
    }
  }
  return result;
}

/** When the net amount of a statement reached the OTA: the transfer date, not yet, or no transfer at all. */
function PaidOn({ statement }: { readonly statement: SettlementSummary }) {
  if (statement.paidAt !== null) {
    return <DateTime value={statement.paidAt} mode="date" timeZone={STATEMENT_TIME_ZONE} />;
  }
  return (
    <span className="text-muted-foreground">
      {statement.status === "carried_forward"
        ? SETTLEMENTS_STRINGS.noTransfer
        : SETTLEMENTS_STRINGS.notPaidYet}
    </span>
  );
}

/** The statements, newest period first as the API answers them, each linked to its page. */
function StatementsTable({
  tenantId,
  statements,
}: {
  readonly tenantId: string;
  readonly statements: readonly SettlementSummary[];
}) {
  return (
    <Table>
      <TableCaption className="sr-only">{SETTLEMENTS_STRINGS.caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{SETTLEMENTS_STRINGS.period}</TableHead>
          <TableHead scope="col">{SETTLEMENTS_STRINGS.currency}</TableHead>
          <TableHead scope="col">{SETTLEMENTS_STRINGS.status}</TableHead>
          <TableHead scope="col" className="text-right">
            {SETTLEMENTS_STRINGS.net}
          </TableHead>
          <TableHead scope="col">{SETTLEMENTS_STRINGS.paidOn}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {statements.map((statement) => (
          <TableRow key={statement.id} data-settlement={statement.id}>
            <TableCell>
              <Link
                href={statementPath(tenantId, statement.id)}
                className="font-medium underline underline-offset-4"
              >
                {statementMonth(statement.periodStart)}
              </Link>
            </TableCell>
            <TableCell>{statement.currency}</TableCell>
            <TableCell>
              <StatusBadge kind="settlement" status={statement.status} />
            </TableCell>
            <TableCell className="text-right">
              <Money value={statement.netAmount} />
            </TableCell>
            <TableCell>
              <PaidOn statement={statement} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * `/otas/[tenantId]/payments/settlements` (README §2 Signed in; flows/stripe-payments-account.md §F; PF-63 AC3): the
 * monthly statements of the payments Velexis took for the OTA, for owners and finance members: the period (a calendar
 * month in UTC, linked to the statement's page with its totals and CSV), the currency, the status, the net amount and
 * the date of the bank transfer. Only statements Velexis approved appear: the API never answers drafts or voided
 * drafts, and the page shows no other status either. The tenant comes from the layout's `getTenant`; another role gets
 * the not-allowed page without a call. A list that cannot be loaded shows the portal's message in its place.
 */
export default async function SettlementsPage({
  params,
}: Readonly<{ params: Promise<{ tenantId: string }> }>) {
  const { tenantId } = await params;
  const loaded = await requireTenant(tenantId);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  if (!can(tenant.myRole, "viewSettlements")) {
    return <NotAllowed tenantId={tenant.id} role={tenant.myRole} />;
  }
  const statements = await loadStatements(tenant.id);
  const shown = statements.data?.data.filter((statement) => isShownStatus(statement.status)) ?? [];

  return (
    <div className="mx-auto grid max-w-4xl gap-8">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{SETTLEMENTS_STRINGS.title}</h1>
        <p className="text-muted-foreground">{SETTLEMENTS_STRINGS.intro}</p>
        <p className="text-sm">
          <Link
            href={otaPath(tenant.id, "/payments/payout-account")}
            className="font-medium underline underline-offset-4"
          >
            {SETTLEMENTS_STRINGS.payoutLink}
          </Link>
        </p>
      </div>
      {statements.error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>{SETTLEMENTS_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(statements.error)}</AlertDescription>
        </Alert>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground" data-settlements-empty="">
          {SETTLEMENTS_STRINGS.empty}
        </p>
      ) : (
        <div className="grid gap-2">
          <StatementsTable tenantId={tenant.id} statements={shown} />
          <p className="text-sm text-muted-foreground">{SETTLEMENTS_STRINGS.periodNote}</p>
        </div>
      )}
    </div>
  );
}
