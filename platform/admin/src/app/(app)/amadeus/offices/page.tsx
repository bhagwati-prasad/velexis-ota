import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AddOfficesForm, type AccountOption } from "@/app/(app)/amadeus/offices/add-offices-form";
import { OfficeTable, type OfficeRow } from "@/app/(app)/amadeus/offices/office-table";
import type { ListPage } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  ADD_OFFICES_STRINGS,
  AMADEUS_OFFICE_STRINGS as S,
  STATUS_LABELS,
  SUPPLIER_ENVIRONMENT_LABELS,
} from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type Environment = Schemas["Environment"];
type OfficeStatus = Schemas["AmadeusOfficeStatus"];
type Office = Schemas["AdminAmadeusOffice"];
type SearchParams = Record<string, string | string[] | undefined>;

/** The filters of `adminListAmadeusOffices` that the URL carries; an absent or empty parameter is no filter. */
interface OfficeFilters {
  readonly environment?: Environment;
  readonly status?: OfficeStatus;
  readonly cursor?: string;
}

// Every value of the platform document has a label: a new one fails the type check until it has one.
const ENVIRONMENT_NAMES: Readonly<Record<Environment, string>> = SUPPLIER_ENVIRONMENT_LABELS;
const STATUS_NAMES: Readonly<Record<OfficeStatus, string>> = STATUS_LABELS.amadeusOffice;

/** The `maxLength` of the `Cursor` parameter. */
const CURSOR_MAX_LENGTH = 512;

function isEnvironment(value: string): value is Environment {
  return Object.hasOwn(ENVIRONMENT_NAMES, value);
}

function isStatus(value: string): value is OfficeStatus {
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
function parseOfficeFilters(params: SearchParams): OfficeFilters | undefined {
  const environment = single(params.environment);
  const status = single(params.status);
  const cursor = single(params.cursor);
  if (environment === undefined || status === undefined || cursor === undefined) {
    return undefined;
  }
  if (
    (environment !== "" && !isEnvironment(environment)) ||
    (status !== "" && !isStatus(status)) ||
    cursor.length > CURSOR_MAX_LENGTH
  ) {
    return undefined;
  }
  return {
    ...(environment === "" ? {} : { environment }),
    ...(status === "" ? {} : { status }),
    ...(cursor === "" ? {} : { cursor }),
  };
}

/**
 * The fields of one office that the table shows. The rows go to a client component, so everything they hold is sent
 * to the browser: only these fields go, whatever else an answer might carry.
 */
function rowOf(office: Office): OfficeRow {
  return {
    id: office.id,
    officeId: office.officeId,
    environment: office.environment,
    status: office.status,
    assignedTenant:
      office.assignedTenant === null
        ? null
        : { id: office.assignedTenant.id, key: office.assignedTenant.key },
    assignedAt: office.assignedAt,
    releaseRequestedAt: office.releaseRequestedAt,
    notes: office.notes,
    createdAt: office.createdAt,
    version: office.version,
  };
}

function sessionEnded(error: ApiError | undefined): boolean {
  return error?.code === "UNAUTHENTICATED" || error?.code === "TOKEN_EXPIRED";
}

const LINK_CLASS = "font-medium underline underline-offset-4";

/**
 * `/amadeus/offices` (README §2, flows/amadeus-connection.md §A, PADR-0012, PF-90): the office pool of the Velexis
 * Amadeus accounts from `adminListAmadeusOffices`, oldest first. `FilterBar` keeps the environment and the status in
 * the URL (the dashboard links `?environment=…&status=…`) and `DataTable` pages with the cursor of the answer, so every
 * list is a link another admin can open. Each office shows its status and, while it is assigned or releasing, its
 * OTA. An available office can be assigned to an OTA or retired (reason); every office's notes can be edited. Above
 * the list, offices are added in bulk to the pool of an account (`adminListAmadeusAccounts` gives the choice). A filter
 * the API would refuse shows a notice instead of a list and asks the API for no list.
 */
export default async function AmadeusOfficesPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const filters = parseOfficeFilters(await searchParams);
  const api = await platformApi();
  const [offices, accounts] = await Promise.all([
    filters === undefined
      ? Promise.resolve(undefined)
      : api.GET("/v1/admin/amadeus-offices", { params: { query: filters } }),
    api.GET("/v1/admin/amadeus-accounts"),
  ]);
  if (sessionEnded(offices?.error) || sessionEnded(accounts.error)) {
    redirect("/sign-in");
  }

  const accountOptions: readonly AccountOption[] | null =
    accounts.error === undefined
      ? accounts.data.data.map((account) => ({
          id: account.id,
          label: ADD_OFFICES_STRINGS.accountOption(
            account.name,
            ENVIRONMENT_NAMES[account.environment] ?? account.environment,
          ),
        }))
      : null;
  const defaultAccountId =
    accounts.error === undefined && filters?.environment !== undefined
      ? accounts.data.data.find((account) => account.environment === filters.environment)?.id
      : undefined;

  const fields: FilterField[] = [
    {
      kind: "select",
      name: "environment",
      label: S.environmentLabel,
      options: Object.entries(ENVIRONMENT_NAMES).map(([value, label]) => ({ value, label })),
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
      <AddOfficesForm accounts={accountOptions} defaultAccountId={defaultAccountId} />
      <section aria-labelledby="office-list" className="grid gap-4">
        <h2 id="office-list" className="text-lg font-semibold tracking-tight">
          {S.listTitle}
        </h2>
        <FilterBar fields={fields} label={S.filtersLabel} />
        {offices === undefined || offices.error?.code === "VALIDATION_FAILED" ? (
          <Alert>
            <AlertDescription>
              <p>{S.invalidFilters}</p>
              {/* The filter bar's "Clear filters" shows only for a filter it has, not for a bad cursor alone. */}
              <p>
                <Link href="/amadeus/offices" className={LINK_CLASS}>
                  {S.showAll}
                </Link>
              </p>
            </AlertDescription>
          </Alert>
        ) : offices.error === undefined ? (
          <OfficeTable
            offices={offices.data.data.map(rowOf)}
            page={{ nextCursor: offices.data.page.nextCursor } satisfies ListPage}
          />
        ) : (
          <Alert variant="destructive">
            <AlertTitle>{S.unavailableTitle}</AlertTitle>
            <AlertDescription>{errorMessage(offices.error)}</AlertDescription>
          </Alert>
        )}
      </section>
    </div>
  );
}
