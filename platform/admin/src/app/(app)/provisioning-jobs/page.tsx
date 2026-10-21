import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { JobTable, type JobSummary } from "@/app/(app)/provisioning-jobs/job-table";
import type { ListPage } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { JOB_KIND_LABELS, JOB_LIST_STRINGS as S, STATUS_LABELS } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type JobStatus = Schemas["ProvisioningJobStatus"];
type JobKind = Schemas["ProvisioningJobKind"];
type SearchParams = Record<string, string | string[] | undefined>;

/** The filters of `adminListProvisioningJobs` that the URL carries; an absent or empty parameter is no filter. */
interface JobFilters {
  readonly status?: JobStatus;
  readonly kind?: JobKind;
  readonly tenantId?: string;
  readonly cursor?: string;
}

// Every value of the platform document has a label: a new one fails the type check until it has one.
const STATUS_NAMES: Readonly<Record<JobStatus, string>> = STATUS_LABELS.job;
const KIND_NAMES: Readonly<Record<JobKind, string>> = JOB_KIND_LABELS;

/** `TenantId` of the platform document. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The `maxLength` of the `Cursor` parameter. */
const CURSOR_MAX_LENGTH = 512;

function isStatus(value: string): value is JobStatus {
  return Object.hasOwn(STATUS_NAMES, value);
}

function isKind(value: string): value is JobKind {
  return Object.hasOwn(KIND_NAMES, value);
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
function parseJobFilters(params: SearchParams): JobFilters | undefined {
  const status = single(params.status);
  const kind = single(params.kind);
  const tenantId = single(params.tenantId);
  const cursor = single(params.cursor);
  if (status === undefined || kind === undefined || tenantId === undefined || cursor === undefined) {
    return undefined;
  }
  if (
    (status !== "" && !isStatus(status)) ||
    (kind !== "" && !isKind(kind)) ||
    (tenantId !== "" && !TENANT_ID.test(tenantId)) ||
    cursor.length > CURSOR_MAX_LENGTH
  ) {
    return undefined;
  }
  return {
    ...(status === "" ? {} : { status }),
    ...(kind === "" ? {} : { kind }),
    ...(tenantId === "" ? {} : { tenantId }),
    ...(cursor === "" ? {} : { cursor }),
  };
}

/**
 * The fields of one row that the table shows. The rows go to a client component, so everything they hold is sent to
 * the browser: only these fields go, whatever else an answer might carry.
 */
function summaryOf(row: JobSummary): JobSummary {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantKey: row.tenantKey,
    kind: row.kind,
    status: row.status,
    step: row.step,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    error: row.error,
    scheduledAt: row.scheduledAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function sessionEnded(error: ApiError | undefined): boolean {
  return error?.code === "UNAUTHENTICATED" || error?.code === "TOKEN_EXPIRED";
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

const LINK_CLASS = "font-medium underline underline-offset-4";

/**
 * The notice of a list limited to one OTA (`tenantId`, as the jobs tab of a tenant links it): a link to the OTA and
 * one to the same filters for every OTA. The filter bar keeps `tenantId` while the status or kind changes.
 */
function OneTenantNotice({
  filters,
  tenantKey,
}: {
  readonly filters: JobFilters;
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
        href={withQuery("/provisioning-jobs", { status: filters.status, kind: filters.kind })}
        className={LINK_CLASS}
      >
        {S.everyTenant}
      </Link>
    </p>
  );
}

/**
 * `/provisioning-jobs` (README §2, PF-83): the tenant jobs of every OTA (`provision`, `migrate`, `suspend`,
 * `resume`), newest first. `FilterBar` keeps the status and the kind in the URL, `tenantId` (from the jobs tab of a
 * tenant) stays with them, and `DataTable` pages with the cursor of the answer, so every list is a link another admin
 * can open. The page reads only its URL: it validates the parameters and calls `adminListProvisioningJobs` with
 * exactly them. A parameter the API would refuse shows a notice instead of a list, and calls nothing. Each job links
 * to its page, where it can be retried or canceled.
 */
export default async function ProvisioningJobsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const filters = parseJobFilters(await searchParams);
  const jobs =
    filters === undefined
      ? undefined
      : await (await platformApi()).GET("/v1/admin/provisioning-jobs", { params: { query: filters } });
  if (sessionEnded(jobs?.error)) {
    redirect("/sign-in");
  }

  const fields: FilterField[] = [
    {
      kind: "select",
      name: "status",
      label: S.statusLabel,
      options: Object.entries(STATUS_NAMES).map(([value, label]) => ({ value, label })),
    },
    {
      kind: "select",
      name: "kind",
      label: S.kindLabel,
      options: Object.entries(KIND_NAMES).map(([value, label]) => ({ value, label })),
    },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      <FilterBar fields={fields} label={S.filtersLabel} />
      {filters?.tenantId === undefined ? null : (
        <OneTenantNotice filters={filters} tenantKey={jobs?.data?.data[0]?.tenantKey} />
      )}
      {jobs === undefined || jobs.error?.code === "VALIDATION_FAILED" ? (
        <Alert>
          <AlertDescription>
            <p>{S.invalidFilters}</p>
            {/* The filter bar's "Clear filters" shows only for a filter it has, not for a bad cursor or OTA alone. */}
            <p>
              <Link href="/provisioning-jobs" className={LINK_CLASS}>
                {S.showAll}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : jobs.error === undefined ? (
        <JobTable
          jobs={jobs.data.data.map(summaryOf)}
          page={{ nextCursor: jobs.data.page.nextCursor } satisfies ListPage}
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(jobs.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
