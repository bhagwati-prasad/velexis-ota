import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  auditListQuery,
  auditRowOf,
  exportHref,
  exportProblem,
  parseAuditFilters,
  type AuditActorType,
  type AuditFilters,
  type SearchParams,
} from "@/app/(app)/audit/audit-filters";
import { AuditTable } from "@/app/(app)/audit/audit-table";
import type { ListPage } from "@/components/data-table";
import { FilterBar, type FilterField, type FilterOption } from "@/components/filter-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { AUDIT_ACTOR_LABELS, AUDIT_STRINGS as S } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

// Every actor type of the platform document has a label: a new one fails the type check until it has one.
const ACTOR_TYPES: Readonly<Record<AuditActorType, string>> = AUDIT_ACTOR_LABELS;

const LINK_CLASS = "font-medium underline underline-offset-4";

/** The choices of a select filter: the known names, and the URL's value if it is another one the API takes. */
function nameOptions(names: readonly string[], current: string | undefined): FilterOption[] {
  const options = names.map((name) => ({ value: name, label: name }));
  if (current !== undefined && !names.includes(current)) {
    options.push({ value: current, label: current });
  }
  return options;
}

function filterFields(filters: AuditFilters | undefined): FilterField[] {
  return [
    {
      kind: "search",
      name: "tenantId",
      label: S.tenantLabel,
      placeholder: S.tenantPlaceholder,
      maxLength: 30,
    },
    {
      kind: "search",
      name: "actorAccountId",
      label: S.actorAccountLabel,
      placeholder: S.actorAccountPlaceholder,
      maxLength: 30,
    },
    {
      kind: "select",
      name: "actorType",
      label: S.actorTypeLabel,
      options: Object.entries(ACTOR_TYPES).map(([value, label]) => ({ value, label })),
    },
    {
      kind: "select",
      name: "action",
      label: S.actionLabel,
      options: nameOptions(AUDIT_ACTIONS, filters?.action),
    },
    {
      kind: "select",
      name: "targetType",
      label: S.targetTypeLabel,
      options: nameOptions(AUDIT_TARGET_TYPES, filters?.targetType),
    },
    { kind: "search", name: "targetId", label: S.targetIdLabel, maxLength: 128 },
    { kind: "date", name: "from", label: S.fromLabel },
    { kind: "date", name: "to", label: S.toLabel },
  ];
}

/** The notice of a URL whose filters cannot be used, with a link to the whole log. */
function InvalidFilters({ message }: { readonly message: string }) {
  return (
    <Alert>
      <AlertDescription>
        <p>{message}</p>
        <p>
          <Link href="/audit" className={LINK_CLASS}>
            {S.showAll}
          </Link>
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The CSV export of the filters: a plain link to `/audit/export.csv` with the same parameters, never a `next/link`,
 * whose prefetch would run the export (and write its audit row) without a click. Offered once the period is set and
 * spans at most one year, as `adminExportAudit` requires.
 */
function ExportPanel({ filters }: { readonly filters: AuditFilters }) {
  const problem = exportProblem(filters);
  return (
    <section
      aria-labelledby="audit-export"
      className="grid gap-2 rounded-xl border bg-card p-4 text-card-foreground shadow-xs"
    >
      <h2 id="audit-export" className="text-base font-semibold">
        {S.exportTitle}
      </h2>
      <p className="text-sm text-muted-foreground">{S.exportIntro}</p>
      {problem === undefined ? (
        <p>
          <a href={exportHref(filters)} className={`${LINK_CLASS} text-sm`}>
            {S.exportLink}
          </a>
        </p>
      ) : (
        <p className="text-sm" data-export={problem}>
          {problem === "period_missing" ? S.exportNeedsPeriod : S.exportTooLong}
        </p>
      )}
    </section>
  );
}

/**
 * `/audit` (README §2, PF-85): the platform audit log, newest first. `FilterBar` keeps every filter in the URL (the
 * OTA, the acting account, the actor type, the action and the target kind of the backend's own lists, the target id and
 * the period as two UTC days, the last one included), and `DataTable` pages with the cursor of the answer, so every
 * search is a link another admin can open; the tenant and account pages link here with their filters. The page reads
 * only its URL (`audit-filters.ts`): it validates the parameters and calls `adminListAudit` with exactly them; a
 * parameter the API would refuse, or a period whose first day is after its last, shows a notice instead of a list and
 * calls nothing. Each row shows its redacted details in `JsonView`. The export panel links the CSV file of the same
 * filters (`/audit/export.csv`, streamed from `adminExportAudit`) once the period is set and at most one year long.
 */
export default async function AuditPage({ searchParams }: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const parsed = parseAuditFilters(await searchParams);
  const filters = parsed.ok ? parsed.filters : undefined;
  const rows =
    filters === undefined
      ? undefined
      : await (
          await platformApi()
        ).GET("/v1/admin/audit-log", { params: { query: auditListQuery(filters) } });
  if (rows?.error?.code === "UNAUTHENTICATED" || rows?.error?.code === "TOKEN_EXPIRED") {
    redirect("/sign-in");
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      <FilterBar fields={filterFields(filters)} label={S.filtersLabel} />
      {filters === undefined || rows === undefined ? (
        <InvalidFilters
          message={!parsed.ok && parsed.problem === "period_order" ? S.periodOrder : S.invalidFilters}
        />
      ) : (
        <>
          <ExportPanel filters={filters} />
          {rows.error?.code === "VALIDATION_FAILED" ? (
            <InvalidFilters message={S.invalidFilters} />
          ) : rows.error === undefined ? (
            <AuditTable
              rows={rows.data.data.map(auditRowOf)}
              page={{ nextCursor: rows.data.page.nextCursor } satisfies ListPage}
            />
          ) : (
            <Alert variant="destructive">
              <AlertTitle>{S.unavailableTitle}</AlertTitle>
              <AlertDescription>{errorMessage(rows.error)}</AlertDescription>
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
