// `/supplier-log` (README §5, routes.md §10, OAD-012): the OTA's Amadeus call log through
// `console.supplierRequests.list` (`supplier_requests:read`: owner, admin, agent, finance), newest first, in the
// environment of the switch: every call made for the OTA (storefront flows, console operations, raw calls and
// background jobs) with its time, Amadeus API and operation, method and path, office, HTTP status, outcome, Amadeus
// error codes, duration, the related booking, and the Velexis and Amadeus request ids. The API keeps the log 90 days.
//
// The bodies only on demand: `includeBodies=true` asks the API for the request and response bodies, which it stored
// redacted (card numbers to their last 4, security codes, document numbers, e-mail addresses and phone numbers masked,
// tokens and secrets removed; a body above 64 KB stored as `{ truncated, bytes, preview }`, OADR-0001 point 9) and
// redacts once more on the way out. The page shows them as the API returns them, in the collapsed JSON view of each
// call (`components/json-view.tsx`: React escapes the text, nothing is interpreted), and adds nothing. With bodies the
// API serves at most 20 calls a page, so the page size is 20 then (a larger one in the URL is refused before any call).
//
// The URL is the state, as on `/payments` (routes.md §7), so every view of the log is a link staff can share:
// `amadeusApi` and `outcome` repeat their parameter (a comma-separated value is read too) and take the document's
// values; `bookingId` is one booking id (`bkg_…`); `requestId` the Velexis `X-Request-Id` an error message quotes (the
// way from a failed console action to the Amadeus call behind it); `httpStatus` an HTTP status (100 to 599);
// `errorCode` an Amadeus error code; `createdFrom` / `createdTo` days in the OTA's time zone (`createdTo` up to the end
// of its day); `cursor` the `page.nextCursor` of the previous page ("Next page" sets it, "First page" drops it, the
// other parameters kept: the API binds a cursor to the filters that wrote it); `limit` the page size (25, or 20 with
// bodies). The filters are a plain GET form to this page. A link with a value the API would refuse is never sent: the
// page names its parameters, with "Clear filters". Showing or hiding the bodies keeps the filters and the position.
//
// The supplier log is not an audited read (OADR-0011 point 8, flow §3 step 7). Next.js hides a server component's
// error from `error.tsx` in production, so the codes the console can answer are handled here, on the server
// (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this log, an ended session to the
// portal (`redirectOnSessionError`), and every other API error renders the console's message for its code with the
// request id under the filters, with "Try again" (and "Clear filters" for `400 VALIDATION_FAILED`).
import type { ConsoleListSupplierRequestsParams, ConsoleSupplierRequest } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment, type ComponentProps, type ReactNode } from "react";

import { BOOKING_ID_PATTERN, bookingHref } from "@/app/(console)/bookings/[bookingId]/sections";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  dayStartIn,
  formatInstant,
  isCalendarDay,
  queryOf,
} from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { JsonView } from "@/components/json-view";
import { toneClasses, type StatusTone } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { cn } from "@/lib/utils";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

export const metadata: Metadata = { title: "Supplier log" };

const PAGE_STRINGS = Object.freeze({
  title: "Supplier log",
  intro: (environment: string) =>
    `Every Amadeus call made for this OTA in the ${environment} environment, newest first, kept for 90 days: storefront flows, console operations and background jobs.`,
  requestIdHint: "To find the call behind an error message, filter by the request id the message quotes.",
  filters: "Supplier log filters",
  apply: "Apply filters",
  clear: "Clear filters",
  any: "Any",
  selected: (count: number) => `${count} selected`,
  showBodies: "Show the redacted bodies",
  hideBodies: "Hide the bodies",
  bodiesOn:
    "Bodies are shown as the API returns them: card numbers, security codes, document numbers, e-mail addresses and phone numbers were masked before storage.",
  invalidTitle: "This link has filters the log cannot use",
  invalid: (labels: string) => `Not valid: ${labels}. Change them above, or clear the filters.`,
  unavailableTitle: "The supplier log could not be loaded",
  forbiddenTitle: "You cannot open the supplier log",
  retry: "Try again",
  noMatch: "No Amadeus call matches these filters.",
  noCalls: "No Amadeus calls in this environment in the last 90 days.",
  caption: "Amadeus calls",
  pages: "Pages",
  firstPage: "First page",
  nextPage: "Next page",
  office: "Office",
  noResponse: "No response",
  amadeusErrors: "Amadeus errors",
  booking: "Booking",
  requestId: "Request id",
  correlationId: "Amadeus request id",
  none: "None",
  bodies: "Bodies",
  bodiesOf: (api: string, time: string) => `Bodies of the ${api} call at ${time}`,
  redacted: "Redacted before storage.",
  notRedacted: "Stored without redaction.",
  truncated: "Truncated: a body above 64 KB is stored cut, with its size and its first part.",
  requestBody: (id: string) => `Request body of ${id}`,
  responseBody: (id: string) => `Response body of ${id}`,
  columns: {
    time: "Time",
    call: "Call",
    request: "Request",
    result: "Result",
    duration: "Duration",
    related: "Related",
  },
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const FIELD_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const PAGE_LINK_CLASS =
  "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";
const MUTED = "text-xs text-muted-foreground";

/** The route of the log. */
const SUPPLIER_LOG_PATH = "/supplier-log";
/** The permission of the log (scope §1.3: owner, admin, agent, finance). */
const READ_PERMISSION = "supplier_requests:read";
/** The cursor's query parameter. */
const CURSOR_PARAM = "cursor";
/** The page size's query parameter. */
const LIMIT_PARAM = "limit";
/** The bodies' query parameter, and its one value. */
const BODIES_PARAM = "includeBodies";
const BODIES_ON = "true";
/** The largest page with bodies (the document: "`limit` ≤ 20 then"). */
const MAX_PAGE_SIZE_WITH_BODIES = 20;
/** The longest cursor the page passes on; the API's cursors are far shorter. */
const MAX_CURSOR_LENGTH = 2048;
/** A Velexis request id as the filter takes it: visible ASCII, at most 100 characters (the document's `maxLength`). */
const REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,100}$/;

// ---- Values of the OTA document ---------------------------------------------------------------------------------

type AmadeusApi = ConsoleSupplierRequest["amadeusApi"];
type Outcome = ConsoleSupplierRequest["outcome"];

/** The Amadeus APIs of the log, in the order of a booking's life, by their names in the Amadeus documentation. */
const API_LABELS: Readonly<Record<AmadeusApi, string>> = {
  Authorization: "Authorization (access token)",
  FlightOffersSearch: "Flight Offers Search",
  FlightAvailabilitiesSearch: "Flight Availabilities Search",
  BrandedFaresUpsell: "Branded Fares Upsell",
  FlightOffersPrice: "Flight Offers Price",
  FlightCreateOrders: "Flight Create Orders",
  FlightOrderIssue: "Flight Order Issue",
  FlightOrderManagement: "Flight Order Management",
  GetFlightOrderByRecordLocator: "Get Flight Order by Record Locator",
  QueueList: "Queue List",
};
const AMADEUS_APIS = Object.keys(API_LABELS) as AmadeusApi[];

/** The outcomes of a call, in words and tones. */
const OUTCOME_LABELS: Readonly<Record<Outcome, string>> = {
  success: "Success",
  client_error: "Refused by Amadeus",
  server_error: "Amadeus error",
  timeout: "Timed out",
  network_error: "Network error",
};
const OUTCOME_TONES: Readonly<Record<Outcome, StatusTone>> = {
  success: "success",
  client_error: "warning",
  server_error: "danger",
  timeout: "danger",
  network_error: "danger",
};
const OUTCOMES = Object.keys(OUTCOME_LABELS) as Outcome[];

// ---- The URL's filters -----------------------------------------------------------------------------------------

/** One choice of a list filter. */
interface Choice {
  readonly value: string;
  readonly label: string;
}

/** A filter of several choices (OR-ed by the API). */
interface MultiFilter {
  readonly kind: "multi";
  readonly name: "amadeusApi" | "outcome";
  readonly label: string;
  readonly choices: readonly Choice[];
}

/** A filter of one value. */
interface SingleFilter {
  readonly kind: "booking" | "requestId" | "httpStatus" | "errorCode" | "day";
  readonly name: "bookingId" | "requestId" | "httpStatus" | "errorCode" | "createdFrom" | "createdTo";
  readonly label: string;
}

type LogFilter = MultiFilter | SingleFilter;

/** Every filter of the log, in the order of the form and of the URL. */
const FILTERS: readonly LogFilter[] = [
  {
    kind: "multi",
    name: "amadeusApi",
    label: "Amadeus API",
    choices: AMADEUS_APIS.map((value) => ({ value, label: API_LABELS[value] })),
  },
  {
    kind: "multi",
    name: "outcome",
    label: "Outcome",
    choices: OUTCOMES.map((value) => ({ value, label: OUTCOME_LABELS[value] })),
  },
  { kind: "httpStatus", name: "httpStatus", label: "HTTP status" },
  { kind: "errorCode", name: "errorCode", label: "Amadeus error code" },
  { kind: "booking", name: "bookingId", label: "Booking id" },
  { kind: "requestId", name: "requestId", label: "Request id" },
  { kind: "day", name: "createdFrom", label: "From" },
  { kind: "day", name: "createdTo", label: "To" },
];

const FILTER_NAMES: ReadonlySet<string> = new Set(FILTERS.map((filter) => filter.name));

/** The labels of the URL's other parameters, for the notice of a link that is not valid (a filter's is its label). */
const PARAMETER_LABELS = Object.freeze({
  cursor: "Page",
  limit: "Page size",
  limitWithBodies: `Page size (at most ${MAX_PAGE_SIZE_WITH_BODIES} with the bodies)`,
  bodies: "Bodies",
});

/** The filters of a URL, normalised: the multi filters' choices in the form's order, the single values trimmed. */
type FilterValues = Readonly<Partial<Record<LogFilter["name"], readonly string[]>>>;

/** What `listQueryOf` makes of a URL. */
interface ListQuery {
  readonly values: FilterValues;
  readonly params: ConsoleListSupplierRequestsParams;
  readonly includeBodies: boolean;
  /** The URL's parameters the API would refuse, by label; the page then sends nothing. */
  readonly invalid: readonly string[];
}

/** Every value of `name` in the URL: repeated parameters and comma-separated parts, trimmed, without empty ones. */
function valuesOf(query: URLSearchParams, name: string, split: boolean): string[] {
  return query
    .getAll(name)
    .flatMap((value) => (split ? value.split(",") : [value]))
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** A single filter's value is one the API takes. */
function validSingle(kind: SingleFilter["kind"], value: string): boolean {
  switch (kind) {
    case "booking":
      return BOOKING_ID_PATTERN.test(value);
    case "requestId":
      return REQUEST_ID_PATTERN.test(value);
    case "httpStatus":
      return /^\d{3}$/.test(value) && Number(value) >= 100 && Number(value) <= 599;
    case "errorCode":
      return /^\d{1,9}$/.test(value);
    case "day":
      return isCalendarDay(value);
  }
}

/** One filter's values, normalised, or `undefined` when the API would refuse them. */
function checkFilter(filter: LogFilter, query: URLSearchParams): string[] | undefined {
  if (filter.kind === "multi") {
    const given = valuesOf(query, filter.name, true);
    const allowed = filter.choices.map((choice) => choice.value);
    return given.every((value) => allowed.includes(value))
      ? allowed.filter((value) => given.includes(value))
      : undefined;
  }
  const given = valuesOf(query, filter.name, false);
  const [first] = given;
  if (first === undefined) {
    return [];
  }
  return given.length === 1 && validSingle(filter.kind, first) ? [first] : undefined;
}

/** Whether the URL asks for the bodies: `true`, `false`, or `null` for a value the API would refuse. */
function bodiesOf(query: URLSearchParams): boolean | null {
  const values = valuesOf(query, BODIES_PARAM, false);
  const [value] = values;
  if (value === undefined || (values.length === 1 && value === "false")) {
    return false;
  }
  return values.length === 1 && value === BODIES_ON ? true : null;
}

/** The URL's page size: none (the default), one the API serves, or `null` for one it would refuse. */
function pageSizeOf(query: URLSearchParams, includeBodies: boolean): number | null | undefined {
  const limits = valuesOf(query, LIMIT_PARAM, false);
  const [text] = limits;
  if (text === undefined) {
    return undefined;
  }
  const limit = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN;
  const max = includeBodies ? MAX_PAGE_SIZE_WITH_BODIES : MAX_PAGE_SIZE;
  return limits.length === 1 && limit >= 1 && limit <= max ? limit : null;
}

/** `value` is one of `allowed`. */
function isOneOf<Value extends string>(allowed: readonly Value[]): (value: string) => value is Value {
  return (value): value is Value => (allowed as readonly string[]).includes(value);
}

/**
 * The parameters of `console.supplierRequests.list` for the URL `query`: the filters (the days as instants in the
 * OTA's time zone, `createdTo` up to the end of its day), the bodies, the cursor and the page size (25, or 20 with the
 * bodies).
 */
function listQueryOf(query: URLSearchParams, timeZone: string): ListQuery {
  const invalid: string[] = [];
  const values: Partial<Record<LogFilter["name"], readonly string[]>> = {};
  for (const filter of FILTERS) {
    const checked = checkFilter(filter, query);
    if (checked === undefined) {
      invalid.push(filter.label);
    } else if (checked.length > 0) {
      values[filter.name] = checked;
    }
  }

  const bodies = bodiesOf(query);
  if (bodies === null) {
    invalid.push(PARAMETER_LABELS.bodies);
  }
  const includeBodies = bodies === true;
  const params: ConsoleListSupplierRequestsParams = {
    limit: includeBodies ? MAX_PAGE_SIZE_WITH_BODIES : DEFAULT_PAGE_SIZE,
  };
  if (includeBodies) {
    params.includeBodies = true;
  }
  const cursors = valuesOf(query, CURSOR_PARAM, false);
  const [cursor] = cursors;
  if (cursors.length > 1 || (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)) {
    invalid.push(PARAMETER_LABELS.cursor);
  } else if (cursor !== undefined) {
    params.cursor = cursor;
  }
  const limit = pageSizeOf(query, includeBodies);
  if (limit === null) {
    invalid.push(includeBodies ? PARAMETER_LABELS.limitWithBodies : PARAMETER_LABELS.limit);
  } else if (limit !== undefined) {
    params.limit = limit;
  }

  const amadeusApi = values.amadeusApi?.filter(isOneOf(AMADEUS_APIS));
  if (amadeusApi !== undefined) {
    params.amadeusApi = amadeusApi;
  }
  const outcome = values.outcome?.filter(isOneOf(OUTCOMES));
  if (outcome !== undefined) {
    params.outcome = outcome;
  }
  const [httpStatus] = values.httpStatus ?? [];
  if (httpStatus !== undefined) {
    params.httpStatus = Number(httpStatus);
  }
  const [errorCode] = values.errorCode ?? [];
  if (errorCode !== undefined) {
    params.errorCode = Number(errorCode);
  }
  const [bookingId] = values.bookingId ?? [];
  if (bookingId !== undefined) {
    params.bookingId = bookingId;
  }
  const [requestId] = values.requestId ?? [];
  if (requestId !== undefined) {
    params.requestId = requestId;
  }
  const [createdFrom] = values.createdFrom ?? [];
  if (createdFrom !== undefined) {
    params.createdFrom = dayStartIn(createdFrom, timeZone);
  }
  const [createdTo] = values.createdTo ?? [];
  if (createdTo !== undefined) {
    params.createdTo = dayStartIn(createdTo, timeZone, 1);
  }
  return { values, params, includeBodies, invalid };
}

/** The log has at least one filter. */
function hasFilters(values: FilterValues): boolean {
  return FILTERS.some((filter) => (values[filter.name] ?? []).length > 0);
}

/** The URL of the log for `query`, with `changes` applied: a value sets a parameter, `null` removes it. */
function listHref(query: URLSearchParams, changes: Readonly<Record<string, string | null>> = {}): string {
  const next = new URLSearchParams();
  query.forEach((value, name) => {
    if (!Object.hasOwn(changes, name)) {
      next.append(name, value);
    }
  });
  for (const [name, value] of Object.entries(changes)) {
    if (value !== null) {
      next.set(name, value);
    }
  }
  const text = next.toString();
  return text === "" ? SUPPLIER_LOG_PATH : `${SUPPLIER_LOG_PATH}?${text}`;
}

/** "Clear filters": the log without filters and cursor, with the bodies and the page size only when valid. */
function clearedHref(query: URLSearchParams): string {
  const bodies = bodiesOf(query);
  const refusedLimit = bodies === null || pageSizeOf(query, bodies) === null;
  const kept = new URLSearchParams();
  query.forEach((value, name) => {
    const dropped =
      FILTER_NAMES.has(name) ||
      name === CURSOR_PARAM ||
      (name === BODIES_PARAM && bodies !== true) ||
      (name === LIMIT_PARAM && refusedLimit);
    if (!dropped) {
      kept.append(name, value);
    }
  });
  return listHref(kept);
}

/**
 * The same log with the bodies shown or hidden: the filters and the position kept, a page size the other view would
 * refuse dropped.
 */
function bodiesHref(query: URLSearchParams, show: boolean): string {
  const limit = pageSizeOf(query, show);
  return listHref(query, {
    [BODIES_PARAM]: show ? BODIES_ON : null,
    ...(limit === null ? { [LIMIT_PARAM]: null } : {}),
  });
}

// ---- The page ---------------------------------------------------------------------------------------------------

/**
 * An error of the OTA API as the page's state: `TOKEN_EXPIRED` and an ended session redirect (Next.js's redirect is
 * thrown on), anything that is not an API error is thrown for the error boundary, and an API error is returned.
 */
async function apiFailure(error: unknown, here: string): Promise<VelexisErrorLike> {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  try {
    await redirectOnSessionError(error, here);
  } catch (thrown) {
    // `redirectOnSessionError` throws the same error back when it is not about the session.
    if (thrown !== error) {
      throw thrown;
    }
  }
  return error;
}

/** What a multi filter's summary says: "Any", the chosen labels, or how many are chosen. */
function choiceSummary(filter: MultiFilter, values: readonly string[]): string {
  const labels = filter.choices
    .filter((choice) => values.includes(choice.value))
    .map((choice) => choice.label);
  if (labels.length === 0) {
    return PAGE_STRINGS.any;
  }
  return labels.length <= 2 ? labels.join(", ") : PAGE_STRINGS.selected(labels.length);
}

/** The input of a single filter. */
const SINGLE_INPUTS: Readonly<Record<SingleFilter["kind"], ComponentProps<"input">>> = {
  booking: { type: "text", placeholder: "bkg_…", maxLength: 44, className: "w-72" },
  // The `X-Request-Id` an error message quotes (a UUID, or the client's own id of 8 to 128 characters).
  requestId: { type: "text", placeholder: "From an error message", maxLength: 100, className: "w-72" },
  httpStatus: { type: "text", inputMode: "numeric", pattern: "[0-9]{3}", maxLength: 3, className: "w-28" },
  errorCode: { type: "text", inputMode: "numeric", pattern: "[0-9]{1,9}", maxLength: 9, className: "w-36" },
  day: { type: "date", className: "w-44" },
};

/** One field of the filter form, showing the URL's values. */
function FilterField({ filter, values }: { readonly filter: LogFilter; readonly values: readonly string[] }) {
  const id = `supplier-log-filter-${filter.name}`;
  if (filter.kind === "multi") {
    return (
      <div className="grid content-start gap-2">
        <span id={`${id}-label`} className="text-sm leading-none font-medium">
          {filter.label}
        </span>
        <details className="group relative">
          <summary
            aria-labelledby={`${id}-label ${id}-summary`}
            className={cn(
              FIELD_CLASS,
              "flex min-w-48 cursor-pointer list-none items-center justify-between gap-2",
            )}
          >
            <span id={`${id}-summary`}>{choiceSummary(filter, values)}</span>
            <span aria-hidden="true" className="text-muted-foreground group-open:rotate-180">
              ▾
            </span>
          </summary>
          <fieldset className="absolute z-20 mt-1 grid min-w-64 gap-2 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
            <legend className="sr-only">{filter.label}</legend>
            {filter.choices.map((choice) => (
              <label key={choice.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name={filter.name}
                  value={choice.value}
                  defaultChecked={values.includes(choice.value)}
                  className="size-4 accent-primary"
                />
                {choice.label}
              </label>
            ))}
          </fieldset>
        </details>
      </div>
    );
  }
  return (
    <div className="grid content-start gap-2">
      <label htmlFor={id} className="text-sm leading-none font-medium">
        {filter.label}
      </label>
      <Input
        id={id}
        name={filter.name}
        defaultValue={values[0] ?? ""}
        autoComplete="off"
        spellCheck={false}
        {...SINGLE_INPUTS[filter.kind]}
      />
    </div>
  );
}

/** The filters: a GET form to this page, which reads it the same way with or without JavaScript. */
function LogFilters({
  query,
  values,
  includeBodies,
}: {
  readonly query: URLSearchParams;
  readonly values: FilterValues;
  readonly includeBodies: boolean;
}) {
  // The page size stays when the API serves it (a refused one goes, so the form's next list can be sent); the filters
  // and the position are the form's.
  const limit = pageSizeOf(query, includeBodies);
  const kept = typeof limit === "number" ? [String(limit)] : [];
  return (
    <form
      role="search"
      aria-label={PAGE_STRINGS.filters}
      method="get"
      action={SUPPLIER_LOG_PATH}
      className="grid gap-4"
    >
      {kept.map((value) => (
        <input key={LIMIT_PARAM} type="hidden" name={LIMIT_PARAM} value={value} />
      ))}
      <div className="flex flex-wrap items-start gap-4">
        {FILTERS.map((filter) => (
          <FilterField key={filter.name} filter={filter} values={values[filter.name] ?? []} />
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name={BODIES_PARAM}
          value={BODIES_ON}
          defaultChecked={includeBodies}
          className="size-4 accent-primary"
        />
        {PAGE_STRINGS.showBodies}
      </label>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="outline">
          {PAGE_STRINGS.apply}
        </Button>
        {hasFilters(values) ? (
          <Link href={clearedHref(query)} className={LINK_CLASS}>
            {PAGE_STRINGS.clear}
          </Link>
        ) : null}
      </div>
    </form>
  );
}

/** The heading and the filters, above whatever the page shows. */
function LogShell({
  environment,
  query,
  values,
  includeBodies,
  children,
}: {
  readonly environment: string;
  readonly query: URLSearchParams;
  readonly values: FilterValues;
  readonly includeBodies: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAGE_STRINGS.intro(environment)}</p>
        <p className="text-sm text-muted-foreground">{PAGE_STRINGS.requestIdHint}</p>
      </div>
      <LogFilters query={query} values={values} includeBodies={includeBodies} />
      {children}
    </div>
  );
}

/** The outcome of a call in words with a matching colour. */
function OutcomeBadge({ outcome }: { readonly outcome: Outcome }) {
  const tone = OUTCOME_TONES[outcome] ?? "neutral";
  return (
    <Badge variant="outline" data-outcome={outcome} data-tone={tone} className={toneClasses(tone)}>
      {OUTCOME_LABELS[outcome] ?? outcome}
    </Badge>
  );
}

/** The cells of one call, and the row of its bodies when they were asked for. */
function CallRows({
  call,
  timeZone,
  includeBodies,
  columns,
}: {
  readonly call: ConsoleSupplierRequest;
  readonly timeZone: string;
  readonly includeBodies: boolean;
  readonly columns: number;
}) {
  const api = API_LABELS[call.amadeusApi] ?? call.amadeusApi;
  const time = formatInstant(call.createdAt, timeZone);
  return (
    <>
      <TableRow className={includeBodies ? "border-b-0" : undefined}>
        <TableCell className="align-top">
          <time dateTime={call.createdAt}>{time}</time>
        </TableCell>
        <TableCell className="align-top">
          <div className="grid gap-0.5">
            <span className="font-medium">{api}</span>
            <code className="text-xs">{call.amadeusOperationId}</code>
            <span className={MUTED}>{call.operation}</span>
          </div>
        </TableCell>
        <TableCell className="max-w-md align-top">
          <div className="grid gap-0.5">
            <code className="text-xs break-all whitespace-normal">
              {call.httpMethod} {call.path}
            </code>
            {call.officeId === null ? null : (
              <span className={MUTED}>
                {PAGE_STRINGS.office} {call.officeId}
              </span>
            )}
          </div>
        </TableCell>
        <TableCell className="align-top">
          <div className="grid justify-items-start gap-1">
            <OutcomeBadge outcome={call.outcome} />
            <span className="text-sm">
              {call.httpStatus === null ? PAGE_STRINGS.noResponse : `HTTP ${call.httpStatus}`}
            </span>
            {call.errorCodes.length === 0 ? null : (
              <span className={MUTED}>
                {PAGE_STRINGS.amadeusErrors} {call.errorCodes.join(", ")}
              </span>
            )}
          </div>
        </TableCell>
        <TableCell className="align-top tabular-nums">
          {call.durationMs === null ? (
            <span className="text-muted-foreground">{PAGE_STRINGS.none}</span>
          ) : (
            `${new Intl.NumberFormat("en").format(call.durationMs)} ms`
          )}
        </TableCell>
        <TableCell className="align-top">
          <div className="grid gap-0.5">
            {call.bookingId === null ? null : (
              <span>
                {PAGE_STRINGS.booking}{" "}
                <Link
                  href={bookingHref(call.bookingId)}
                  prefetch={false}
                  className="font-mono text-xs font-medium underline-offset-4 hover:underline focus-visible:underline"
                >
                  {call.bookingId}
                </Link>
              </span>
            )}
            {call.requestId === null ? null : (
              <span className={MUTED}>
                {PAGE_STRINGS.requestId} <code>{call.requestId}</code>
              </span>
            )}
            {call.correlationId === null ? null : (
              <span className={MUTED}>
                {PAGE_STRINGS.correlationId} <code>{call.correlationId}</code>
              </span>
            )}
          </div>
        </TableCell>
      </TableRow>
      {includeBodies ? (
        <TableRow>
          <TableCell colSpan={columns} className="pt-0">
            <div
              role="group"
              aria-label={PAGE_STRINGS.bodiesOf(api, time)}
              className="grid gap-2 whitespace-normal"
            >
              <p className={MUTED}>
                {call.redacted ? PAGE_STRINGS.redacted : PAGE_STRINGS.notRedacted}
                {call.truncated ? ` ${PAGE_STRINGS.truncated}` : null}
              </p>
              <div className="grid gap-2 lg:grid-cols-2">
                <JsonView label={PAGE_STRINGS.requestBody(call.id)} value={call.requestBody} />
                <JsonView label={PAGE_STRINGS.responseBody(call.id)} value={call.responseBody} />
              </div>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

/** The calls of one page, and the links to the next page and back to the first. */
function CallsTable({
  calls,
  timeZone,
  query,
  includeBodies,
  nextCursor,
  emptyMessage,
}: {
  readonly calls: readonly ConsoleSupplierRequest[];
  readonly timeZone: string;
  readonly query: URLSearchParams;
  readonly includeBodies: boolean;
  readonly nextCursor: string | null;
  readonly emptyMessage: string;
}) {
  const columns = Object.values(PAGE_STRINGS.columns);
  const onLaterPage = valuesOf(query, CURSOR_PARAM, false).length > 0;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <Link href={bodiesHref(query, !includeBodies)} className={LINK_CLASS}>
          {includeBodies ? PAGE_STRINGS.hideBodies : PAGE_STRINGS.showBodies}
        </Link>
        {includeBodies ? <p className={MUTED}>{PAGE_STRINGS.bodiesOn}</p> : null}
      </div>
      <Table>
        <TableCaption className="sr-only">{PAGE_STRINGS.caption}</TableCaption>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column} scope="col">
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {calls.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            calls.map((call) => (
              <Fragment key={call.id}>
                <CallRows
                  call={call}
                  timeZone={timeZone}
                  includeBodies={includeBodies}
                  columns={columns.length}
                />
              </Fragment>
            ))
          )}
        </TableBody>
      </Table>
      {onLaterPage || nextCursor !== null ? (
        <nav aria-label={PAGE_STRINGS.pages} className="flex flex-wrap justify-end gap-2">
          {onLaterPage ? (
            <Link href={listHref(query, { [CURSOR_PARAM]: null })} className={PAGE_LINK_CLASS}>
              {PAGE_STRINGS.firstPage}
            </Link>
          ) : null}
          {nextCursor === null ? null : (
            <Link href={listHref(query, { [CURSOR_PARAM]: nextCursor })} className={PAGE_LINK_CLASS}>
              {PAGE_STRINGS.nextPage}
            </Link>
          )}
        </nav>
      ) : null}
    </div>
  );
}

export default async function SupplierLogPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = queryOf(await searchParams);
  const here = listHref(query);

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff, environment } = request;

  if (!can(staff, READ_PERMISSION)) {
    return (
      <ErrorState
        title={PAGE_STRINGS.forbiddenTitle}
        description={{
          message: errorMessage({
            code: "FORBIDDEN",
            status: 403,
            requestId: null,
            fieldErrors: [],
            retryable: false,
            details: { requiredPermission: READ_PERMISSION },
          }),
        }}
      />
    );
  }

  const timeZone = staff.tenant.timeZone;
  const list = listQueryOf(query, timeZone);
  if (list.invalid.length > 0) {
    return (
      <LogShell
        environment={environment}
        query={query}
        values={list.values}
        includeBodies={list.includeBodies}
      >
        <section role="alert" className="grid max-w-xl gap-3">
          <h2 className="text-xl font-semibold">{PAGE_STRINGS.invalidTitle}</h2>
          <p>{PAGE_STRINGS.invalid(list.invalid.join(", "))}</p>
          <Link href={clearedHref(query)} className={LINK_CLASS}>
            {PAGE_STRINGS.clear}
          </Link>
        </section>
      </LogShell>
    );
  }

  let calls: ConsoleSupplierRequest[];
  let nextCursor: string | null;
  try {
    const page = await request.console.supplierRequests.list(list.params);
    calls = page.data;
    nextCursor = page.page.nextCursor;
  } catch (error) {
    const failure = await apiFailure(error, here);
    return (
      <LogShell
        environment={environment}
        query={query}
        values={list.values}
        includeBodies={list.includeBodies}
      >
        <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
          {/* The same URL again: the log is read anew. */}
          <a href={here} className={LINK_CLASS}>
            {PAGE_STRINGS.retry}
          </a>
          {failure.code === "VALIDATION_FAILED" ? (
            <Link href={clearedHref(query)} className={LINK_CLASS}>
              {PAGE_STRINGS.clear}
            </Link>
          ) : null}
        </ErrorState>
      </LogShell>
    );
  }

  return (
    <LogShell environment={environment} query={query} values={list.values} includeBodies={list.includeBodies}>
      <CallsTable
        calls={calls}
        timeZone={timeZone}
        query={query}
        includeBodies={list.includeBodies}
        nextCursor={nextCursor}
        emptyMessage={hasFilters(list.values) ? PAGE_STRINGS.noMatch : PAGE_STRINGS.noCalls}
      />
    </LogShell>
  );
}
