import type { components } from "@velexis/api-types/platform";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { StripeEventTable, type StripeEventRow } from "@/app/(app)/stripe-events/event-table";
import type { ListPage } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { STATUS_LABELS, STRIPE_EVENT_LIST_STRINGS as S } from "@/lib/strings";

export const metadata: Metadata = { title: S.title };

type Schemas = components["schemas"];
type AdminStripeEvent = Schemas["AdminStripeEvent"];
type EventStatus = AdminStripeEvent["status"];
type SearchParams = Record<string, string | string[] | undefined>;

/** The filters of `adminListStripeEvents` that the URL carries; an absent or empty parameter is no filter. */
interface StripeEventFilters {
  readonly status?: EventStatus;
  readonly type?: string;
  readonly tenantId?: string;
  readonly cursor?: string;
}

/** Every status of the platform document has a label: a new one fails the type check until it has one. */
const STATUS_NAMES: Readonly<Record<EventStatus, string>> = STATUS_LABELS.stripeEvent;

/** The `type` parameter of `adminListStripeEvents`: an exact Stripe event type, at most 255 characters. */
const EVENT_TYPE = /^[a-z_]+(\.[a-z_]+)+$/;
const EVENT_TYPE_MAX_LENGTH = 255;

/** `TenantId` of the platform document, and its length for the search field. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;
const TENANT_ID_LENGTH = 30;

/** The `maxLength` of the `Cursor` parameter. */
const CURSOR_MAX_LENGTH = 512;

function isStatus(value: string): value is EventStatus {
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
function parseFilters(params: SearchParams): StripeEventFilters | undefined {
  const status = single(params.status);
  const type = single(params.type)?.trim();
  const tenantId = single(params.tenantId)?.trim();
  const cursor = single(params.cursor);
  if (status === undefined || type === undefined || tenantId === undefined || cursor === undefined) {
    return undefined;
  }
  if (
    (status !== "" && !isStatus(status)) ||
    (type !== "" && (type.length > EVENT_TYPE_MAX_LENGTH || !EVENT_TYPE.test(type))) ||
    (tenantId !== "" && !TENANT_ID.test(tenantId)) ||
    cursor.length > CURSOR_MAX_LENGTH
  ) {
    return undefined;
  }
  return {
    ...(status === "" ? {} : { status }),
    ...(type === "" ? {} : { type }),
    ...(tenantId === "" ? {} : { tenantId }),
    ...(cursor === "" ? {} : { cursor }),
  };
}

/**
 * The fields of one event that the table shows. The rows go to a client component, so everything they hold is sent to
 * the browser: only these fields go, whatever else an answer might carry.
 */
function rowOf(event: AdminStripeEvent): StripeEventRow {
  return {
    id: event.id,
    endpoint: event.endpoint,
    type: event.type,
    status: event.status,
    attempts: event.attempts,
    lastError: event.lastError,
    tenantId: event.tenantId,
    receivedAt: event.receivedAt,
    processedAt: event.processedAt,
  };
}

function sessionEnded(error: ApiError | undefined): boolean {
  return error?.code === "UNAUTHENTICATED" || error?.code === "TOKEN_EXPIRED";
}

const LINK_CLASS = "font-medium underline underline-offset-4";

/**
 * `/stripe-events` (README §2; subscription-billing flow, failure handling; PF-89, PAD-012): the Stripe webhook inbox
 * of both receivers from `adminListStripeEvents`, failed and ignored events first (each group newest first), then the
 * others, with the last error that says why. `FilterBar` keeps the status, the exact event type and the OTA (its tenant
 * id, which a subscription's page links as "All Stripe events of this OTA") in the URL (the dashboard links
 * `?status=failed`), and `DataTable` pages with the cursor of the answer, so every list is a link another admin can
 * open. A failed or ignored event can be reprocessed (`StripeEventTable`); other statuses offer nothing. A filter the
 * API would refuse, or a `VALIDATION_FAILED` answer, shows a notice instead of a list and asks the API for no list.
 */
export default async function StripeEventsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const filters = parseFilters(await searchParams);
  const events =
    filters === undefined
      ? undefined
      : await (await platformApi()).GET("/v1/admin/stripe-events", { params: { query: filters } });
  if (sessionEnded(events?.error)) {
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
      kind: "search",
      name: "type",
      label: S.typeLabel,
      placeholder: S.typePlaceholder,
      maxLength: EVENT_TYPE_MAX_LENGTH,
    },
    {
      kind: "search",
      name: "tenantId",
      label: S.tenantLabel,
      placeholder: S.tenantPlaceholder,
      maxLength: TENANT_ID_LENGTH,
    },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{S.title}</h1>
        <p className="text-muted-foreground">{S.intro}</p>
      </div>
      <FilterBar fields={fields} label={S.filtersLabel} />
      {events === undefined || events.error?.code === "VALIDATION_FAILED" ? (
        <Alert>
          <AlertDescription>
            <p>{S.invalidFilters}</p>
            {/* The filter bar's "Clear filters" shows only for a filter it has, not for a bad cursor alone. */}
            <p>
              <Link href="/stripe-events" className={LINK_CLASS}>
                {S.showAll}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : events.error === undefined ? (
        <StripeEventTable
          events={events.data.data.map(rowOf)}
          page={{ nextCursor: events.data.page.nextCursor } satisfies ListPage}
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>{S.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(events.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
