import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SubscriptionTable, type SubscriptionRow } from "@/app/(app)/subscriptions/subscription-table";
import type { ListPage } from "@/components/data-table";
import { FilterBar, type FilterField, type FilterOption } from "@/components/filter-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { BILLING_PROVIDER_LABELS, STATUS_LABELS, SUBSCRIPTION_LIST_STRINGS as S } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type SubscriptionStatus = Schemas["SubscriptionStatus"];
type BillingProvider = Schemas["BillingProvider"];
type SearchParams = Record<string, string | string[] | undefined>;

/** The filters of `adminListSubscriptions` that the URL carries; an absent or empty parameter is no filter. */
interface SubscriptionFilters {
  readonly status?: SubscriptionStatus;
  readonly provider?: BillingProvider;
  readonly planCode?: string;
  readonly cursor?: string;
}

/** Every status and provider of the platform document has a label: a new one fails the type check until it has one. */
const STATUS_NAMES: Readonly<Record<SubscriptionStatus, string>> = STATUS_LABELS.subscription;
const PROVIDER_NAMES: Readonly<Record<BillingProvider, string>> = BILLING_PROVIDER_LABELS;

/** `PlanCode` of the platform document. */
const PLAN_CODE = /^[a-z][a-z0-9_]{1,39}$/;

/** The `maxLength` of the `Cursor` parameter. */
const CURSOR_MAX_LENGTH = 512;

function isStatus(value: string): value is SubscriptionStatus {
  return Object.hasOwn(STATUS_NAMES, value);
}

function isProvider(value: string): value is BillingProvider {
  return Object.hasOwn(PROVIDER_NAMES, value);
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
function parseFilters(params: SearchParams): SubscriptionFilters | undefined {
  const status = single(params.status);
  const provider = single(params.provider);
  const planCode = single(params.planCode);
  const cursor = single(params.cursor);
  if (status === undefined || provider === undefined || planCode === undefined || cursor === undefined) {
    return undefined;
  }
  if (
    (status !== "" && !isStatus(status)) ||
    (provider !== "" && !isProvider(provider)) ||
    (planCode !== "" && !PLAN_CODE.test(planCode)) ||
    cursor.length > CURSOR_MAX_LENGTH
  ) {
    return undefined;
  }
  return {
    ...(status === "" ? {} : { status }),
    ...(provider === "" ? {} : { provider }),
    ...(planCode === "" ? {} : { planCode }),
    ...(cursor === "" ? {} : { cursor }),
  };
}

/** The plan filter: every plan (retired ones too, subscriptions keep them), and the URL's code if it is unknown. */
function planOptions(
  plans: readonly Schemas["AdminPlan"][] | undefined,
  current: string | undefined,
): FilterOption[] {
  const options: FilterOption[] = (plans ?? []).map((plan) => ({
    value: plan.code,
    label: plan.isActive ? plan.name : S.retiredPlan(plan.name),
  }));
  if (current !== undefined && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: current });
  }
  return options;
}

/**
 * The fields of one row that the table shows. The rows go to a client component, so everything they hold is sent to
 * the browser: only these fields go, whatever else an answer might carry.
 */
function rowOf(row: Schemas["AdminSubscription"]): SubscriptionRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantKey: row.tenantKey,
    tenantName: row.tenantName,
    planCode: row.planCode,
    planName: row.planName,
    status: row.status,
    billingProvider: row.billingProvider,
    billingInterval: row.billingInterval,
    trialEndsAt: row.trialEndsAt,
    currentPeriodEnd: row.currentPeriodEnd,
    createdAt: row.createdAt,
  };
}

function sessionEnded(error: ApiError | undefined): boolean {
  return error?.code === "UNAUTHENTICATED" || error?.code === "TOKEN_EXPIRED";
}

/**
 * `/subscriptions` (README §2; subscription-billing flow §G): every subscription row of every OTA, newest first.
 * `FilterBar` keeps the status, the billing provider (`manual` for the trials before M5, `stripe`) and the plan in the
 * URL, and `DataTable` pages with the cursor of the answer, so a list is a link another admin can open. The page reads
 * only its URL: it validates the parameters, calls `adminListSubscriptions` with them and `adminListPlans` for the
 * plan filter's names (the list still shows without them). A parameter the API would refuse, or a `VALIDATION_FAILED`
 * answer (a stale cursor), shows a notice instead of a list.
 */
export default async function SubscriptionsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const filters = parseFilters(await searchParams);
  const api = await platformApi();
  const [subscriptions, plans] = await Promise.all([
    filters === undefined ? undefined : api.GET("/v1/admin/subscriptions", { params: { query: filters } }),
    api.GET("/v1/admin/plans"),
  ]);
  if (sessionEnded(subscriptions?.error) || sessionEnded(plans.error)) {
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
      name: "provider",
      label: S.providerLabel,
      options: Object.entries(PROVIDER_NAMES).map(([value, label]) => ({ value, label })),
    },
    {
      kind: "select",
      name: "planCode",
      label: S.planLabel,
      options: planOptions(plans.data?.data, filters?.planCode),
    },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      <FilterBar fields={fields} label={S.filtersLabel} />
      {subscriptions === undefined || subscriptions.error?.code === "VALIDATION_FAILED" ? (
        <Alert>
          <AlertDescription>
            <p>{S.invalidFilters}</p>
            <p>
              <Link href="/subscriptions" className="font-medium underline underline-offset-4">
                {S.showAll}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : subscriptions.error === undefined ? (
        <SubscriptionTable
          subscriptions={subscriptions.data.data.map(rowOf)}
          page={{ nextCursor: subscriptions.data.page.nextCursor } satisfies ListPage}
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(subscriptions.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
