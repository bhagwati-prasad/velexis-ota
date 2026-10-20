import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { TenantTable, type TenantSummary } from "@/app/(app)/tenants/tenant-table";
import type { ListPage } from "@/components/data-table";
import { FilterBar, SEARCH_MAX_LENGTH, type FilterField, type FilterOption } from "@/components/filter-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { STATUS_LABELS, TENANT_LIST_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: TENANT_LIST_STRINGS.title };

type Schemas = components["schemas"];
type TenantStatus = Schemas["TenantStatus"];
type AdminPlan = Schemas["AdminPlan"];
type SearchParams = Record<string, string | string[] | undefined>;

/** The filters of `adminListTenants` that the URL carries; an absent or empty parameter is no filter. */
interface TenantFilters {
  readonly q?: string;
  readonly status?: TenantStatus;
  readonly planCode?: string;
  readonly cursor?: string;
}

/** The labels of every tenant status (checked against the platform document by `StatusBadge`). */
const STATUS_NAMES: Readonly<Record<TenantStatus, string>> = STATUS_LABELS.tenant;

/** `PlanCode` of the platform document. */
const PLAN_CODE = /^[a-z][a-z0-9_]{1,39}$/;

/** The `maxLength` of the `Cursor` parameter. */
const CURSOR_MAX_LENGTH = 512;

function isTenantStatus(value: string): value is TenantStatus {
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
 * instead of showing an unfiltered list under a filtered address. The search is trimmed, as the filter bar trims it,
 * and counted in code points, as the API's `maxLength` counts them.
 */
function parseTenantFilters(params: SearchParams): TenantFilters | undefined {
  const q = single(params.q)?.trim();
  const status = single(params.status);
  const planCode = single(params.planCode);
  const cursor = single(params.cursor);
  if (q === undefined || status === undefined || planCode === undefined || cursor === undefined) {
    return undefined;
  }
  if ([...q].length > SEARCH_MAX_LENGTH) {
    return undefined;
  }
  if (status !== "" && !isTenantStatus(status)) {
    return undefined;
  }
  if (planCode !== "" && !PLAN_CODE.test(planCode)) {
    return undefined;
  }
  if (cursor.length > CURSOR_MAX_LENGTH) {
    return undefined;
  }
  return {
    ...(q === "" ? {} : { q }),
    ...(status === "" ? {} : { status }),
    ...(planCode === "" ? {} : { planCode }),
    ...(cursor === "" ? {} : { cursor }),
  };
}

/** The plan filter: every plan (retired ones too, OTAs can still be on them), and the URL's code if it is unknown. */
function planOptions(plans: readonly AdminPlan[] | undefined, current: string | undefined): FilterOption[] {
  const options: FilterOption[] = (plans ?? []).map((plan) => ({
    value: plan.code,
    label: plan.isActive ? plan.name : TENANT_LIST_STRINGS.retiredPlan(plan.name),
  }));
  if (current !== undefined && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: current });
  }
  return options;
}

/**
 * The fields of one row that the table shows. The rows go to a client component, so everything they hold is sent to
 * the browser: only these fields go, whatever else an answer might carry (as on the detail page).
 */
function summaryOf(row: TenantSummary): TenantSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status,
    planCode: row.planCode,
    ownerEmail: row.ownerEmail,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
  };
}

function sessionEnded(error: ApiError | undefined): boolean {
  return error?.code === "UNAUTHENTICATED" || error?.code === "TOKEN_EXPIRED";
}

/**
 * `/tenants` (README §2, PF-81): every OTA, newest first. `FilterBar` keeps the search (`q`: part of the key, the name
 * or an owner's e-mail address), the status and the plan in the URL, and `DataTable` pages with the cursor of the
 * answer, so a search is a link another admin can open. The page reads only its URL: it validates the parameters,
 * calls `adminListTenants` with them and `adminListPlans` for the plan filter's names (the list still shows without
 * them). A parameter the API would refuse shows a notice instead of a list.
 */
export default async function TenantsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const filters = parseTenantFilters(await searchParams);
  const api = await platformApi();
  const [tenants, plans] = await Promise.all([
    filters === undefined ? undefined : api.GET("/v1/admin/tenants", { params: { query: filters } }),
    api.GET("/v1/admin/plans"),
  ]);
  if (sessionEnded(tenants?.error) || sessionEnded(plans.error)) {
    redirect("/sign-in");
  }

  const fields: FilterField[] = [
    {
      kind: "search",
      name: "q",
      label: TENANT_LIST_STRINGS.searchLabel,
      placeholder: TENANT_LIST_STRINGS.searchPlaceholder,
    },
    {
      kind: "select",
      name: "status",
      label: TENANT_LIST_STRINGS.statusLabel,
      options: Object.entries(STATUS_NAMES).map(([value, label]) => ({ value, label })),
    },
    {
      kind: "select",
      name: "planCode",
      label: TENANT_LIST_STRINGS.planLabel,
      options: planOptions(plans.data?.data, filters?.planCode),
    },
  ];
  const planNames = Object.fromEntries((plans.data?.data ?? []).map((plan) => [plan.code, plan.name]));

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{TENANT_LIST_STRINGS.title}</h1>
        <p className="text-muted-foreground">{TENANT_LIST_STRINGS.intro}</p>
      </div>
      <FilterBar fields={fields} label={TENANT_LIST_STRINGS.filtersLabel} />
      {tenants === undefined || tenants.error?.code === "VALIDATION_FAILED" ? (
        <Alert>
          <AlertDescription>
            <p>{TENANT_LIST_STRINGS.invalidFilters}</p>
            {/* The filter bar's "Clear filters" shows only for a filter it has, not for a bad cursor alone. */}
            <p>
              <Link href="/tenants" className="font-medium underline underline-offset-4">
                {TENANT_LIST_STRINGS.showAll}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : tenants.error === undefined ? (
        <TenantTable
          tenants={tenants.data.data.map(summaryOf)}
          page={{ nextCursor: tenants.data.page.nextCursor } satisfies ListPage}
          planNames={planNames}
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{TENANT_LIST_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(tenants.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
