import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { SettlementActions } from "@/app/(app)/settlements/[settlementId]/settlement-actions";
import { DateTime } from "@/components/date-time";
import { Money } from "@/components/money";
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
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  SETTLEMENT_ACTION_STRINGS,
  SETTLEMENT_DETAIL_STRINGS as S,
  SETTLEMENT_LINE_TYPE_LABELS,
  SUPPLIER_ENVIRONMENT_LABELS,
  TABLE_STRINGS,
  formatBasisPoints,
  formatCount,
  formatMonth,
} from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type AdminSettlement = Schemas["AdminSettlement"];
type SettlementLine = Schemas["AdminSettlementLine"];
type SearchParams = Record<string, string | string[] | undefined>;

/** Every kind of line and environment of the platform document has a label: a new one fails the type check. */
const LINE_TYPES: Readonly<Record<Schemas["SettlementLineType"], string>> = SETTLEMENT_LINE_TYPE_LABELS;
const ENVIRONMENTS: Readonly<Record<Schemas["Environment"], string>> = SUPPLIER_ENVIRONMENT_LABELS;

/** `AdminSettlementId` of the platform document; another value is no statement, and the API is not asked. */
const SETTLEMENT_ID = /^stl_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The `maxLength` of the `Cursor` parameter. */
const CURSOR_MAX_LENGTH = 512;

/** How many lines one page shows. */
const LINES_PER_PAGE = 50;

const LINK_CLASS = "font-medium underline underline-offset-4";

function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}

/** The lines' cursor of the URL: `""` without one, `undefined` when repeated or too long (a URL no link writes). */
function cursorOf(params: SearchParams): string | undefined {
  const value = params.cursor;
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" && value.length <= CURSOR_MAX_LENGTH ? value : undefined;
}

function sessionEnded(error: ApiError | undefined): boolean {
  return error?.code === "UNAUTHENTICATED" || error?.code === "TOKEN_EXPIRED";
}

function Muted({ children }: { readonly children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>;
}

/** An instant, or `empty` for `null`. */
function When({ value, empty = S.notYet }: { readonly value: string | null; readonly empty?: string }) {
  return value === null ? <Muted>{empty}</Muted> : <DateTime value={value} />;
}

/** An account id linking its support page, or "None". */
function AccountLink({ accountId }: { readonly accountId: string | null }) {
  return accountId === null ? (
    <Muted>{S.none}</Muted>
  ) : (
    <Link href={`/accounts/${encodeURIComponent(accountId)}`} className={LINK_CLASS}>
      <Mono>{accountId}</Mono>
    </Link>
  );
}

function Fields({ children }: { readonly children: ReactNode }) {
  return <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">{children}</dl>;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Panel({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid content-start gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A decimal string above zero. */
function isPositive(amount: string): boolean {
  return !amount.startsWith("-") && /[1-9]/.test(amount);
}

/** One total: its label and its amount, right-aligned. */
function Total({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </>
  );
}

/** The totals of PADR-0003 item 5, each a decimal string of the API formatted with `Intl`. */
function TotalsPanel({ settlement }: { readonly settlement: AdminSettlement }) {
  return (
    <Panel id="settlement-totals" title={S.totalsTitle}>
      <p className="text-sm text-muted-foreground">{S.totalsIntro}</p>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[1fr_max-content]">
        <Total label={S.gross}>
          <Money value={settlement.grossAmount} />
        </Total>
        <Total label={S.refunds}>
          <Money value={settlement.refundsAmount} />
        </Total>
        <Total label={S.disputes}>
          <Money value={settlement.disputesAmount} />
        </Total>
        <Total label={S.stripeFees}>
          <Money value={settlement.stripeFeesAmount} />
        </Total>
        <Total label={S.velexisFees(formatBasisPoints(settlement.feeBps))}>
          <Money value={settlement.velexisFeesAmount} />
        </Total>
        <Total label={S.adjustments}>
          <Money value={settlement.adjustmentsAmount} />
        </Total>
        <dt className="border-t pt-2 font-semibold">{S.net}</dt>
        <dd className="border-t pt-2 text-right font-semibold">
          <Money value={settlement.netAmount} />
        </dd>
      </dl>
      <p className="text-sm text-muted-foreground">
        {isPositive(settlement.netAmount.amount) ? S.netPositive : S.netNotPositive}
      </p>
    </Panel>
  );
}

function DetailsPanel({ settlement }: { readonly settlement: AdminSettlement }) {
  return (
    <Panel id="settlement-details" title={S.detailsTitle}>
      <Fields>
        <Field label={S.status}>
          <StatusBadge kind="settlement" status={settlement.status} />
        </Field>
        <Field label={S.ota}>
          <Link href={`/tenants/${encodeURIComponent(settlement.tenantId)}`} className={LINK_CLASS}>
            {settlement.tenantName}
          </Link>{" "}
          <Mono>{settlement.tenantKey}</Mono>
        </Field>
        <Field label={S.month}>{formatMonth(settlement.periodStart)}</Field>
        <Field label={S.currency}>{settlement.currency}</Field>
        <Field label={S.environment}>{labelOf(ENVIRONMENTS, settlement.environment)}</Field>
        <Field label={S.lines}>{formatCount(settlement.lineCount)}</Field>
        <Field label={S.generated}>
          <DateTime value={settlement.generatedAt} />
        </Field>
        <Field label={S.approved}>
          <When value={settlement.approvedAt} />
        </Field>
        <Field label={S.approvedBy}>
          <AccountLink accountId={settlement.approvedByAccountId} />
        </Field>
        <Field label={S.paid}>
          {settlement.paidAt === null ? (
            <Muted>{S.notYet}</Muted>
          ) : (
            <DateTime value={settlement.paidAt} mode="date" />
          )}
        </Field>
        <Field label={S.paidBy}>
          <AccountLink accountId={settlement.paidByAccountId} />
        </Field>
        <Field label={S.payoutReference}>
          {settlement.payoutReference === null ? (
            <Muted>{S.none}</Muted>
          ) : (
            <Mono>{settlement.payoutReference}</Mono>
          )}
        </Field>
        {settlement.carriedToId === null ? null : (
          <Field label={S.carriedTo}>
            <Link href={`/settlements/${encodeURIComponent(settlement.carriedToId)}`} className={LINK_CLASS}>
              <Mono>{settlement.carriedToId}</Mono>
            </Link>
          </Field>
        )}
        {settlement.voidedAt === null ? null : (
          <Field label={S.voided}>
            <DateTime value={settlement.voidedAt} />
          </Field>
        )}
        {settlement.voidReason === null ? null : (
          <Field label={S.voidReason}>
            <span className="whitespace-pre-wrap">{settlement.voidReason}</span>
          </Field>
        )}
        {settlement.notes === null ? null : (
          <Field label={S.notes}>
            <span className="whitespace-pre-wrap">{settlement.notes}</span>
          </Field>
        )}
        <Field label={S.version}>{settlement.version}</Field>
        <Field label={S.id}>
          <Mono>{settlement.id}</Mono>
        </Field>
      </Fields>
    </Panel>
  );
}

/** The review status of the OTA's payout account, which approving and paying a positive net need `verified`. */
function PayoutPanel({ settlement }: { readonly settlement: AdminSettlement }) {
  return (
    <Panel id="settlement-payout" title={S.payoutTitle}>
      {settlement.payoutAccountStatus === null ? (
        <p className="text-sm">{S.noPayoutAccount}</p>
      ) : (
        <Fields>
          <Field label={S.payoutStatus}>
            <StatusBadge kind="payoutAccount" status={settlement.payoutAccountStatus} />
          </Field>
        </Fields>
      )}
      <p className="text-sm text-muted-foreground">{S.payoutNeeded}</p>
      <p className="text-sm">
        <Link
          href={`/tenants/${encodeURIComponent(settlement.tenantId)}?tab=connections`}
          className={LINK_CLASS}
        >
          {S.openPayout(settlement.tenantName)}
        </Link>
      </p>
    </Panel>
  );
}

/** The Stripe and OTA references of a line, the ones it has. */
function References({ line }: { readonly line: SettlementLine }) {
  const references = [
    line.balanceTransactionId,
    line.paymentIntentId,
    line.velexisPaymentId,
    line.checkoutId,
  ].filter((reference): reference is string => reference !== null);
  if (references.length === 0) {
    return <Muted>{S.none}</Muted>;
  }
  return (
    <span className="grid gap-0.5">
      {references.map((reference) => (
        <Mono key={reference}>{reference}</Mono>
      ))}
    </span>
  );
}

/** One page of lines: a server table, with "Next page" and "First page" links of the lines' cursor. */
function LinesTable({
  settlementId,
  lines,
  cursor,
  nextCursor,
}: {
  readonly settlementId: string;
  readonly lines: readonly SettlementLine[];
  readonly cursor: string;
  readonly nextCursor: string | null;
}) {
  const path = `/settlements/${encodeURIComponent(settlementId)}`;
  return (
    <div className="grid gap-4">
      <Table>
        <TableCaption className="sr-only">{S.linesCaption}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{S.columnDate}</TableHead>
            <TableHead scope="col">{S.columnType}</TableHead>
            <TableHead scope="col">{S.columnDescription}</TableHead>
            <TableHead scope="col" className="text-right">
              {S.columnAmount}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {S.columnStripeFee}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {S.columnOriginal}
            </TableHead>
            <TableHead scope="col">{S.columnReferences}</TableHead>
            <TableHead scope="col">{S.columnAddedBy}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => (
            <TableRow key={line.id} className="align-top">
              <TableCell>
                <DateTime value={line.occurredAt} />
              </TableCell>
              <TableCell>{labelOf(LINE_TYPES, line.type)}</TableCell>
              <TableCell className="min-w-48 whitespace-normal">
                {line.description === null ? <Muted>{S.none}</Muted> : line.description}
              </TableCell>
              <TableCell className="text-right">
                <Money value={line.amount} />
              </TableCell>
              <TableCell className="text-right">
                <Money value={line.stripeFee} />
              </TableCell>
              <TableCell className="text-right">
                {line.originalAmount === null ? (
                  <Muted>{S.none}</Muted>
                ) : (
                  <Money value={line.originalAmount} />
                )}
              </TableCell>
              <TableCell>
                <References line={line} />
              </TableCell>
              <TableCell>
                <AccountLink accountId={line.createdByAccountId} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {nextCursor === null && cursor === "" ? null : (
        <nav aria-label={TABLE_STRINGS.paginationLabel} className="flex flex-wrap gap-4 text-sm">
          {cursor === "" ? null : (
            <Link href={path} className={LINK_CLASS}>
              {TABLE_STRINGS.firstPage}
            </Link>
          )}
          {nextCursor === null ? null : (
            <Link
              href={`${path}?${new URLSearchParams({ cursor: nextCursor }).toString()}`}
              className={LINK_CLASS}
            >
              {TABLE_STRINGS.nextPage}
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/settlements" className="text-sm font-medium underline underline-offset-4">
      {S.backToList}
    </Link>
  );
}

/**
 * `/settlements/[settlementId]` (README §2, flows/platform-admin-operations.md "Sequence: settlement review and
 * payout", PF-91): one statement from `adminGetSettlement` (its totals, its OTA and the review status of the OTA's
 * payout account) and a page of its lines from `adminListSettlementLines` (`cursor` in the URL), with the CSV download
 * of every line (`lines.csv`, a plain link to the route handler that streams `adminDownloadSettlementLines` with the
 * admin's session). The review actions (`SettlementActions`) follow the statement's status; they get the ids, status,
 * version, currency, net amount and payout account status only. An id that is no statement id, and an unknown one,
 * render the not-found page.
 */
export default async function SettlementPage({
  params,
  searchParams,
}: Readonly<{ params: Promise<{ settlementId: string }>; searchParams: Promise<SearchParams> }>) {
  const { settlementId } = await params;
  if (!SETTLEMENT_ID.test(settlementId)) {
    notFound();
  }
  const cursor = cursorOf(await searchParams);
  const api = await platformApi();
  const [result, lines] = await Promise.all([
    api.GET("/v1/admin/settlements/{settlementId}", { params: { path: { settlementId } } }),
    cursor === undefined
      ? undefined
      : api.GET("/v1/admin/settlements/{settlementId}/lines", {
          params: {
            path: { settlementId },
            query: { limit: LINES_PER_PAGE, ...(cursor === "" ? {} : { cursor }) },
          },
        }),
  ]);
  if (sessionEnded(result.error) || sessionEnded(lines?.error)) {
    redirect(`/sign-in?${new URLSearchParams({ next: `/settlements/${settlementId}` }).toString()}`);
  }
  if (result.error !== undefined) {
    if (result.error.code === "NOT_FOUND" || result.error.code === "VALIDATION_FAILED") {
      notFound();
    }
    return (
      <div className="mx-auto grid max-w-6xl gap-6">
        <BackLink />
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(result.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  const settlement = result.data;
  const month = formatMonth(settlement.periodStart);
  const csvHref = `/settlements/${encodeURIComponent(settlement.id)}/lines.csv`;

  let linesContent: ReactNode;
  if (lines === undefined || lines.error?.code === "VALIDATION_FAILED") {
    linesContent = (
      <Alert>
        <AlertDescription>
          <p>{S.linesInvalid}</p>
          <p>
            <Link href={`/settlements/${encodeURIComponent(settlement.id)}`} className={LINK_CLASS}>
              {S.firstLines}
            </Link>
          </p>
        </AlertDescription>
      </Alert>
    );
  } else if (lines.error !== undefined) {
    linesContent = (
      <Alert variant="destructive">
        <AlertTitle>{S.linesUnavailable}</AlertTitle>
        <AlertDescription>{errorMessage(lines.error)}</AlertDescription>
      </Alert>
    );
  } else if (lines.data.data.length === 0 && cursor === "") {
    linesContent = (
      <p className="text-sm text-muted-foreground">
        {settlement.status === "void" ? S.voidLines : S.linesEmpty}
      </p>
    );
  } else {
    linesContent = (
      <LinesTable
        settlementId={settlement.id}
        lines={lines.data.data}
        cursor={cursor ?? ""}
        nextCursor={lines.data.page.nextCursor}
      />
    );
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <BackLink />
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{S.heading(settlement.tenantName, month)}</h1>
          <StatusBadge kind="settlement" status={settlement.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{settlement.id}</span> · {settlement.currency} ·{" "}
          {labelOf(ENVIRONMENTS, settlement.environment)}
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <TotalsPanel settlement={settlement} />
        <DetailsPanel settlement={settlement} />
      </div>
      <PayoutPanel settlement={settlement} />
      <Panel id="settlement-review" title={SETTLEMENT_ACTION_STRINGS.sectionTitle}>
        <SettlementActions
          settlementId={settlement.id}
          status={settlement.status}
          version={settlement.version}
          currency={settlement.currency}
          netAmount={settlement.netAmount}
          payoutAccountStatus={settlement.payoutAccountStatus}
          tenantId={settlement.tenantId}
          tenantName={settlement.tenantName}
          month={month}
          today={new Date().toISOString().slice(0, 10)}
        />
      </Panel>
      <Panel id="settlement-lines" title={S.linesTitle}>
        <p className="text-sm text-muted-foreground">{S.linesIntro(settlement.currency)}</p>
        <p className="grid gap-1 text-sm">
          {/* A plain link, never next/link: a prefetch would download the file without a click. */}
          <a href={csvHref} className={LINK_CLASS}>
            {S.downloadCsv}
          </a>
          <span className="text-muted-foreground">{S.downloadHint}</span>
        </p>
        {linesContent}
      </Panel>
    </div>
  );
}
