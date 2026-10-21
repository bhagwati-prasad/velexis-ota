import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountTable, type AccountSummary } from "@/app/(app)/accounts/account-table";
import type { ListPage } from "@/components/data-table";
import { FilterBar, SEARCH_MAX_LENGTH, type FilterField } from "@/components/filter-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ACCOUNT_LIST_STRINGS as S, STATUS_LABELS } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type AccountStatus = components["schemas"]["AccountStatus"];
type SearchParams = Record<string, string | string[] | undefined>;

/** The filters of `adminListAccounts` that the URL carries; an absent or empty parameter is no filter. */
interface AccountFilters {
  readonly q?: string;
  readonly status?: AccountStatus;
  readonly cursor?: string;
}

/** The labels of every account status (checked against the platform document by `StatusBadge`). */
const STATUS_NAMES: Readonly<Record<AccountStatus, string>> = STATUS_LABELS.account;

/** The `maxLength` of the `Cursor` parameter. */
const CURSOR_MAX_LENGTH = 512;

function isAccountStatus(value: string): value is AccountStatus {
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
function parseAccountFilters(params: SearchParams): AccountFilters | undefined {
  const q = single(params.q)?.trim();
  const status = single(params.status);
  const cursor = single(params.cursor);
  if (q === undefined || status === undefined || cursor === undefined) {
    return undefined;
  }
  if (
    [...q].length > SEARCH_MAX_LENGTH ||
    (status !== "" && !isAccountStatus(status)) ||
    cursor.length > CURSOR_MAX_LENGTH
  ) {
    return undefined;
  }
  return {
    ...(q === "" ? {} : { q }),
    ...(status === "" ? {} : { status }),
    ...(cursor === "" ? {} : { cursor }),
  };
}

/**
 * The fields of one row that the table shows. The rows go to a client component, so everything they hold is sent to
 * the browser: only these fields go, whatever else an answer might carry.
 */
function summaryOf(row: AccountSummary): AccountSummary {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    status: row.status,
    mfaEnabled: row.mfaEnabled,
    isPlatformAdmin: row.isPlatformAdmin,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

function sessionEnded(error: ApiError | undefined): boolean {
  return error?.code === "UNAUTHENTICATED" || error?.code === "TOKEN_EXPIRED";
}

/**
 * `/accounts` (README §2, PF-87): every account of the portal and the admin, newest first. `FilterBar` keeps the
 * search (`q`: part of the e-mail address or the name) and the status in the URL, and `DataTable` pages with the cursor
 * of the answer, so a search is a link another admin can open. The page reads only its URL: it validates the
 * parameters and calls `adminListAccounts` with exactly them; a parameter the API would refuse shows a notice instead
 * of a list, and calls nothing. Each account links to its support page with the actions.
 */
export default async function AccountsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const filters = parseAccountFilters(await searchParams);
  const accounts =
    filters === undefined
      ? undefined
      : await (await platformApi()).GET("/v1/admin/accounts", { params: { query: filters } });
  if (sessionEnded(accounts?.error)) {
    redirect("/sign-in");
  }

  const fields: FilterField[] = [
    {
      kind: "search",
      name: "q",
      label: S.searchLabel,
      placeholder: S.searchPlaceholder,
      maxLength: SEARCH_MAX_LENGTH,
    },
    {
      kind: "select",
      name: "status",
      label: S.statusLabel,
      options: Object.entries(STATUS_NAMES).map(([value, label]) => ({ value, label })),
    },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      <FilterBar fields={fields} label={S.filtersLabel} />
      {accounts === undefined || accounts.error?.code === "VALIDATION_FAILED" ? (
        <Alert>
          <AlertDescription>
            <p>{S.invalidFilters}</p>
            <p>
              <Link href="/accounts" className="font-medium underline underline-offset-4">
                {S.showAll}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : accounts.error === undefined ? (
        <AccountTable
          accounts={accounts.data.data.map(summaryOf)}
          page={{ nextCursor: accounts.data.page.nextCursor } satisfies ListPage}
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(accounts.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
