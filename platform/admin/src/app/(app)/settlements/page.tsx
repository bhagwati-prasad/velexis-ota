import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { GenerateDraftsForm, type MonthOption } from "@/app/(app)/settlements/generate-drafts-form";
import { DateTime } from "@/components/date-time";
import { FilterBar, type FilterField, type FilterOption } from "@/components/filter-bar";
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
  STATUS_LABELS,
  SETTLEMENT_LIST_STRINGS as S,
  TABLE_STRINGS,
  formatCount,
  formatMonth,
} from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type SettlementStatus = Schemas["AdminSettlementStatus"];
type SettlementSummary = Schemas["AdminSettlementSummary"];
type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The filters of `adminListSettlements` that the URL carries; an absent or empty parameter is no filter. The month is
 * `period=YYYY-MM` in the URL (readable and shareable) and the API's `periodStart` (its first instant, UTC) in the call.
 */
interface SettlementFilters {
  readonly status?: SettlementStatus;
  readonly period?: string;
  readonly tenantId?: string;
  readonly cursor?: string;
}

/** Every status of the platform document has a label: a new one fails the type check until it has one. */
const STATUS_NAMES: Readonly<Record<SettlementStatus, string>> = STATUS_LABELS.settlement;

/** A month of the URL (`period`): `YYYY-MM`. */
const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/** `TenantId` of the platform document. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The `maxLength` of the `Cursor` parameter. */
const CURSOR_MAX_LENGTH = 512;

/** How many closed months the month filter offers, newest first. */
const FILTER_MONTHS = 24;

/** How many closed months "Generate drafts" offers, newest first (the month before the current one is preselected). */
const GENERATE_MONTHS = 12;

function isStatus(value: string): value is SettlementStatus {
  return Object.hasOwn(STATUS_NAMES, value);
}

/** A query parameter: `""` when absent, `undefined` when repeated (a URL no filter bar writes). */
function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * The filters of the page URL, or `undefined` when one of them is not a value the API takes: the page then says so
 * instead of showing an unfiltered list under a filtered address.
 */
function parseFilters(params: SearchParams): SettlementFilters | undefined {
  const status = single(params.status);
  const period = single(params.period);
  const tenantId = single(params.tenantId);
  const cursor = single(params.cursor);
  if (status === undefined || period === undefined || tenantId === undefined || cursor === undefined) {
    return undefined;
  }
  if (
    (status !== "" && !isStatus(status)) ||
    (period !== "" && !PERIOD.test(period)) ||
    (tenantId !== "" && !TENANT_ID.test(tenantId)) ||
    cursor.length > CURSOR_MAX_LENGTH
  ) {
    return undefined;
  }
  return {
    ...(status === "" ? {} : { status }),
    ...(period === "" ? {} : { period }),
    ...(tenantId === "" ? {} : { tenantId }),
    ...(cursor === "" ? {} : { cursor }),
  };
}

/** The API's `periodStart` of a month of the URL (`2027-02` → `2027-02-01T00:00:00Z`). */
function periodStartOf(period: string): string {
  return `${period}-01T00:00:00Z`;
}

/**
 * The `count` calendar months (UTC) that have ended by `now`, newest first: the previous month, the one before, …
 * Each is its URL value and its name.
 */
function closedMonths(now: Date, count: number): MonthOption[] {
  const months: MonthOption[] = [];
  for (let back = 1; back <= count; back += 1) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const value = `${String(first.getUTCFullYear()).padStart(4, "0")}-${String(first.getUTCMonth() + 1).padStart(2, "0")}`;
    months.push({ value, label: formatMonth(periodStartOf(value)) });
  }
  return months;
}

/** The month filter: the closed months, and the URL's month when it is not one of them. */
function periodOptions(months: readonly MonthOption[], current: string | undefined): FilterOption[] {
  const options: FilterOption[] = months.map((month) => ({ value: month.value, label: month.label }));
  if (current !== undefined && !options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: formatMonth(periodStartOf(current)) });
  }
  return options;
}

/** `href` with the query of `filters` (an empty one gives the bare path). */
function withQuery(href: string, filters: Readonly<Record<string, string | undefined>>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined) {
      query.set(name, value);
    }
  }
  const text = query.toString();
  return text === "" ? href : `${href}?${text}`;
}

function sessionEnded(error: ApiError | undefined): boolean {
  return error?.code === "UNAUTHENTICATED" || error?.code === "TOKEN_EXPIRED";
}

const LINK_CLASS = "font-medium underline underline-offset-4";

/**
 * The notice of a list limited to one OTA (`tenantId`, as the payout account on a tenant's page links it): a link to
 * the OTA and one to the same filters for every OTA. The filter bar keeps `tenantId` while the status or month changes.
 */
function OneTenantNotice({
  filters,
  tenantKey,
}: {
  readonly filters: SettlementFilters;
  /** The OTA's key, from the first row; `undefined` on an empty list, which shows the id instead. */
  readonly tenantKey: string | undefined;
}) {
  const tenantId = filters.tenantId ?? "";
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-filter="tenant">
      <span>{S.oneTenant}</span>
      <Link href={`/tenants/${encodeURIComponent(tenantId)}`} className={LINK_CLASS}>
        {S.openTenant} <span className="font-mono">{tenantKey ?? tenantId}</span>
      </Link>
      <Link
        href={withQuery("/settlements", { status: filters.status, period: filters.period })}
        className={LINK_CLASS}
      >
        {S.everyTenant}
      </Link>
    </p>
  );
}

/** An instant, or "Not yet" for `null`. */
function When({ value }: { readonly value: string | null }) {
  return value === null ? (
    <span className="text-muted-foreground">{S.none}</span>
  ) : (
    <DateTime value={value} />
  );
}

/**
 * One page of statements: a server table (nothing of a row reaches the browser but what it renders), each statement
 * linking its review page and its OTA, with "Next page" and "First page" links that keep the filters of the URL.
 */
function SettlementTable({
  rows,
  filters,
  nextCursor,
}: {
  readonly rows: readonly SettlementSummary[];
  readonly filters: SettlementFilters;
  readonly nextCursor: string | null;
}) {
  const kept = { status: filters.status, period: filters.period, tenantId: filters.tenantId };
  return (
    <div className="grid gap-4">
      <Table>
        <TableCaption className="sr-only">{S.caption}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{S.columnStatement}</TableHead>
            <TableHead scope="col">{S.columnOta}</TableHead>
            <TableHead scope="col">{S.columnMonth}</TableHead>
            <TableHead scope="col">{S.columnCurrency}</TableHead>
            <TableHead scope="col">{S.columnStatus}</TableHead>
            <TableHead scope="col" className="text-right">
              {S.columnNet}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {S.columnLines}
            </TableHead>
            <TableHead scope="col">{S.columnGenerated}</TableHead>
            <TableHead scope="col">{S.columnApproved}</TableHead>
            <TableHead scope="col">{S.columnPaid}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="text-muted-foreground">
                {S.empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    href={`/settlements/${encodeURIComponent(row.id)}`}
                    className={`${LINK_CLASS} font-mono text-xs break-all`}
                  >
                    {row.id}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="grid gap-0.5">
                    <Link href={`/tenants/${encodeURIComponent(row.tenantId)}`} className={LINK_CLASS}>
                      {row.tenantName}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">{row.tenantKey}</span>
                  </span>
                </TableCell>
                <TableCell>{formatMonth(row.periodStart)}</TableCell>
                <TableCell>
                  {row.currency}
                  {row.environment === "test" ? (
                    <span className="ml-2 text-xs text-muted-foreground">{S.testEnvironment}</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <StatusBadge kind="settlement" status={row.status} />
                </TableCell>
                <TableCell className="text-right">
                  <Money value={row.netAmount} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(row.lineCount)}</TableCell>
                <TableCell>
                  <DateTime value={row.generatedAt} />
                </TableCell>
                <TableCell>
                  <When value={row.approvedAt} />
                </TableCell>
                <TableCell>
                  {row.paidAt === null ? (
                    <span className="text-muted-foreground">{S.none}</span>
                  ) : (
                    <DateTime value={row.paidAt} mode="date" />
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {nextCursor === null && filters.cursor === undefined ? null : (
        <nav aria-label={TABLE_STRINGS.paginationLabel} className="flex flex-wrap gap-4 text-sm">
          {filters.cursor === undefined ? null : (
            <Link href={withQuery("/settlements", kept)} className={LINK_CLASS}>
              {TABLE_STRINGS.firstPage}
            </Link>
          )}
          {nextCursor === null ? null : (
            <Link href={withQuery("/settlements", { ...kept, cursor: nextCursor })} className={LINK_CLASS}>
              {TABLE_STRINGS.nextPage}
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}

/**
 * `/settlements` (README §2, flows/platform-admin-operations.md "Sequence: settlement review and payout", PF-91): the
 * monthly statements of every OTA, newest month first. `FilterBar` keeps the status and the month in the URL,
 * `tenantId` (from the payout account on a tenant's page) stays with them, and the pager links the next page with the
 * cursor of the answer, so every list is a link another admin can open; `status=draft` is the review queue. The page
 * validates its URL and calls `adminListSettlements` with exactly those filters; a parameter the API would refuse, or a
 * `VALIDATION_FAILED` answer (a stale cursor), shows a notice instead of a list and asks for none.
 *
 * "Generate drafts" (`GenerateDraftsForm`, `adminGenerateSettlements`) rebuilds the drafts of a month that has ended,
 * for every OTA or, on a list limited to one OTA, for that OTA only.
 */
export default async function SettlementsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const filters = parseFilters(await searchParams);
  const settlements =
    filters === undefined
      ? undefined
      : await (
          await platformApi()
        ).GET("/v1/admin/settlements", {
          params: {
            query: {
              ...(filters.status === undefined ? {} : { status: filters.status }),
              ...(filters.period === undefined ? {} : { periodStart: periodStartOf(filters.period) }),
              ...(filters.tenantId === undefined ? {} : { tenantId: filters.tenantId }),
              ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
            },
          },
        });
  if (sessionEnded(settlements?.error)) {
    redirect("/sign-in");
  }

  const now = new Date();
  const fields: FilterField[] = [
    {
      kind: "select",
      name: "status",
      label: S.statusLabel,
      options: Object.entries(STATUS_NAMES).map(([value, label]) => ({ value, label })),
    },
    {
      kind: "select",
      name: "period",
      label: S.periodLabel,
      options: periodOptions(closedMonths(now, FILTER_MONTHS), filters?.period),
    },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      <GenerateDraftsForm months={closedMonths(now, GENERATE_MONTHS)} tenantId={filters?.tenantId ?? null} />
      <FilterBar fields={fields} label={S.filtersLabel} />
      {filters?.tenantId === undefined ? null : (
        <OneTenantNotice filters={filters} tenantKey={settlements?.data?.data[0]?.tenantKey} />
      )}
      {settlements === undefined || settlements.error?.code === "VALIDATION_FAILED" ? (
        <Alert>
          <AlertDescription>
            <p>{S.invalidFilters}</p>
            <p>
              <Link href="/settlements" className={LINK_CLASS}>
                {S.showAll}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : settlements.error === undefined ? (
        <SettlementTable
          rows={settlements.data.data}
          filters={filters ?? {}}
          nextCursor={settlements.data.page.nextCursor}
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(settlements.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
