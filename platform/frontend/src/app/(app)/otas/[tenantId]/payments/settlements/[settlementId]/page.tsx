import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  feeRate,
  isSettlementId,
  isShownStatus,
  linesCsvPath,
  type Settlement,
  STATEMENT_TIME_ZONE,
  statementMonth,
  statementPath,
  statementsPath,
} from "@/app/(app)/otas/[tenantId]/payments/settlements/statements";
import { DateTime } from "@/components/date-time";
import { Money, type MoneyValue } from "@/components/money";
import { NotAllowed } from "@/components/not-allowed";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiResult } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { can } from "@/lib/roles";
import { SETTLEMENTS_STRINGS } from "@/lib/strings";
import { requireTenant } from "@/lib/tenant";

export const metadata: Metadata = { title: SETTLEMENTS_STRINGS.title };

type Params = Promise<{ tenantId: string; settlementId: string }>;

/**
 * `getSettlement` (owners and finance members). A draft, a voided draft, a statement of another OTA and an id the API
 * refuses answer `404` (or `400`): the not-found page, as for an OTA the caller is no member of. An ended session goes
 * to sign-in and back to this statement, an unverified account to `/verify-pending`; other failures are returned for the
 * page to show the portal's message.
 */
async function loadStatement(tenantId: string, settlementId: string): Promise<ApiResult<Settlement>> {
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/settlements/{settlementId}", {
    params: { path: { tenantId, settlementId } },
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      redirect(`/sign-in?${new URLSearchParams({ next: statementPath(tenantId, settlementId) }).toString()}`);
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
    if (code === "NOT_FOUND" || code === "VALIDATION_FAILED") {
      notFound();
    }
  }
  return result;
}

/** One row of the totals: what it is and its amount, as the API answered it. */
function TotalRow({
  label,
  value,
  id,
  strong = false,
}: {
  readonly label: string;
  readonly value: MoneyValue;
  readonly id: string;
  readonly strong?: boolean;
}) {
  return (
    <tr className="border-b last:border-0" data-total={id}>
      <th
        scope="row"
        className={strong ? "py-2 pr-4 text-left font-semibold" : "py-2 pr-4 text-left font-normal"}
      >
        {label}
      </th>
      <td className={strong ? "py-2 text-right font-semibold" : "py-2 text-right"}>
        <Money value={value} />
      </td>
    </tr>
  );
}

/** How the net amount is made up (PADR-0003 item 5): every part of `netAmount` as the API answered it, then the net. */
function Totals({ statement }: { readonly statement: Settlement }) {
  return (
    <section aria-labelledby="statement-totals-title" className="grid gap-3">
      <h2 id="statement-totals-title" className="text-xl font-semibold tracking-tight">
        {SETTLEMENTS_STRINGS.totalsCaption}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-labelledby="statement-totals-title">
          <thead className="sr-only">
            <tr>
              <th scope="col">{SETTLEMENTS_STRINGS.item}</th>
              <th scope="col">{SETTLEMENTS_STRINGS.amount}</th>
            </tr>
          </thead>
          <tbody>
            <TotalRow id="gross" label={SETTLEMENTS_STRINGS.gross} value={statement.grossAmount} />
            <TotalRow id="refunds" label={SETTLEMENTS_STRINGS.refunds} value={statement.refundsAmount} />
            <TotalRow id="disputes" label={SETTLEMENTS_STRINGS.disputes} value={statement.disputesAmount} />
            <TotalRow
              id="stripeFees"
              label={SETTLEMENTS_STRINGS.stripeFees}
              value={statement.stripeFeesAmount}
            />
            <TotalRow
              id="velexisFees"
              label={SETTLEMENTS_STRINGS.velexisFees(feeRate(statement.feeBps))}
              value={statement.velexisFeesAmount}
            />
            <TotalRow
              id="adjustments"
              label={SETTLEMENTS_STRINGS.adjustments}
              value={statement.adjustmentsAmount}
            />
            <TotalRow id="net" label={SETTLEMENTS_STRINGS.net} value={statement.netAmount} strong />
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted-foreground">{SETTLEMENTS_STRINGS.formula}</p>
    </section>
  );
}

/**
 * `/otas/[tenantId]/payments/settlements/[settlementId]` (README §2 Signed in; flows/stripe-payments-account.md §F;
 * PF-63 AC3): one statement for owners and finance members: its month and currency (the `h1`), the status and what it
 * means, the net amount, the transfer date and the bank reference, the fee rate, how the net amount is made up, the
 * notes from Velexis, and the CSV of its lines (`lines.csv`, the route handler that streams `downloadSettlementLines`
 * with the user's session). A draft never appears: the API answers `404` for it, and a status the portal does not show
 * renders the not-found page too. An id that is no statement id makes no call. The tenant comes from the layout's
 * `getTenant`; another role gets the not-allowed page without a call.
 */
export default async function SettlementPage({ params }: Readonly<{ params: Params }>) {
  const { tenantId, settlementId } = await params;
  const loaded = await requireTenant(tenantId);
  if (loaded.error !== undefined) {
    // The layout renders the portal's message for this failure in place of the page.
    return null;
  }
  const { tenant } = loaded;
  if (!can(tenant.myRole, "viewSettlements")) {
    return <NotAllowed tenantId={tenant.id} role={tenant.myRole} />;
  }
  if (!isSettlementId(settlementId)) {
    notFound();
  }
  const result = await loadStatement(tenant.id, settlementId);
  const backLink = (
    <p className="text-sm">
      <Link href={statementsPath(tenant.id)} className="font-medium underline underline-offset-4">
        {SETTLEMENTS_STRINGS.backToList}
      </Link>
    </p>
  );
  if (result.error !== undefined) {
    return (
      <div className="mx-auto grid max-w-3xl gap-8">
        {backLink}
        <h1 className="text-3xl font-semibold tracking-tight">{SETTLEMENTS_STRINGS.title}</h1>
        <Alert variant="destructive">
          <AlertTitle>{SETTLEMENTS_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(result.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  const statement = result.data;
  if (!isShownStatus(statement.status)) {
    notFound();
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-8" data-settlement={statement.id}>
      {backLink}
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {SETTLEMENTS_STRINGS.statementTitle(statementMonth(statement.periodStart), statement.currency)}
          </h1>
          <StatusBadge kind="settlement" status={statement.status} />
        </div>
        <p data-status-explanation={statement.status}>
          {SETTLEMENTS_STRINGS.statusExplanations[statement.status]}
        </p>
      </div>

      <section aria-labelledby="statement-summary-title" className="grid gap-3">
        <h2 id="statement-summary-title" className="sr-only">
          {SETTLEMENTS_STRINGS.summaryLabel}
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">{SETTLEMENTS_STRINGS.net}</dt>
          <dd className="font-semibold">
            <Money value={statement.netAmount} />
          </dd>
          <dt className="text-muted-foreground">{SETTLEMENTS_STRINGS.paidOn}</dt>
          <dd>
            {statement.paidAt === null ? (
              <span className="text-muted-foreground">
                {statement.status === "carried_forward"
                  ? SETTLEMENTS_STRINGS.noTransfer
                  : SETTLEMENTS_STRINGS.notPaidYet}
              </span>
            ) : (
              <DateTime value={statement.paidAt} mode="date" timeZone={STATEMENT_TIME_ZONE} />
            )}
          </dd>
          <dt className="text-muted-foreground">{SETTLEMENTS_STRINGS.payoutReference}</dt>
          <dd className="break-all">{statement.payoutReference ?? SETTLEMENTS_STRINGS.notSet}</dd>
          <dt className="text-muted-foreground">{SETTLEMENTS_STRINGS.feeRate}</dt>
          <dd>{feeRate(statement.feeBps)}</dd>
        </dl>
        <p className="text-sm text-muted-foreground">{SETTLEMENTS_STRINGS.periodNote}</p>
      </section>

      <Totals statement={statement} />

      <section aria-labelledby="statement-lines-title" className="grid gap-3">
        <h2 id="statement-lines-title" className="text-xl font-semibold tracking-tight">
          {SETTLEMENTS_STRINGS.linesTitle}
        </h2>
        <p className="text-sm">
          {SETTLEMENTS_STRINGS.lineCount(statement.lineCount)}. {SETTLEMENTS_STRINGS.linesIntro}
        </p>
        <p>
          {/*
            A plain link to the route handler (no client navigation or prefetch). The file's answer is an attachment,
            so the browser saves it and stays on this page; without a `download` attribute a refusal still renders
            its plain-text explanation and an ended session reaches sign-in, as they would not in a download.
          */}
          <a
            href={linesCsvPath(tenant.id, statement.id)}
            className="font-medium underline underline-offset-4"
            data-csv-link=""
          >
            {SETTLEMENTS_STRINGS.download}
          </a>
        </p>
      </section>

      {statement.notes === null ? null : (
        <section aria-labelledby="statement-notes-title" className="grid gap-2">
          <h2 id="statement-notes-title" className="text-xl font-semibold tracking-tight">
            {SETTLEMENTS_STRINGS.notesTitle}
          </h2>
          <p className="text-sm break-words whitespace-pre-line">{statement.notes}</p>
        </section>
      )}
    </div>
  );
}
