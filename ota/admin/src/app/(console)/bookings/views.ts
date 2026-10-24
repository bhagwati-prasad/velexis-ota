// The model of the bookings list `/bookings` (routes.md §3.1, console-operations flow §3 step 3, OAD-006): the filters
// its URL carries and how they become the parameters of `console.bookings.list`, the saved views (the needs-attention
// work lists and the other preset lists) and the row the table shows. The page's server component and the client
// filter component both use it, so it imports no server-only module and no value of a client module, and of the SDK
// only types (OADR-0018 point 1).
//
// The URL is the state: every filter, the sort and the cursor are search parameters, so every view of the list is a
// link staff can share. A list filter repeats its parameter (`status=confirmed&status=partially_ticketed`; a
// comma-separated value is read too), days are `YYYY-MM-DD` (the created days in the OTA's time zone, the departure
// days local to the airport, as the API takes them), and `deadlineWithin` (`24h`, `72h`, `7d`) is a window from the
// time of the request, so a link to "deadline within 24 hours" stays right whenever it is opened. A value the API
// would refuse is never sent: the page names the parameter of the link that is not valid instead of listing bookings
// under a filtered address with the filter left out.
import type {
  ConsoleBookingSort,
  ConsoleBookingStatus,
  ConsoleBookingSummary,
  ConsoleListBookingsParams,
  ConsolePaymentStatus,
  ConsoleTicketingStatus,
} from "@velexis/ota-sdk";

import { DEFAULT_LOCALE, type MoneyValue } from "@/components/money";
import { STATUS_LABELS } from "@/components/status-badge";

/** The route of the list. */
export const BOOKINGS_PATH = "/bookings";

/** The cursor's query parameter (`page.nextCursor` of the previous page; `CURSOR_PARAM` of the data table). */
export const CURSOR_PARAM_NAME = "cursor";
/**
 * The time a `deadlineWithin` window counts from on a later page: the first page's, which its "Next page" link pins
 * (`ListQuery.pinned`), because the API binds a cursor to the filters of the page that wrote it.
 */
export const AS_OF_PARAM_NAME = "asOf";
/** The page size's query parameter. */
export const LIMIT_PARAM_NAME = "limit";
/** The parameters of a position in the list, which a change of filters drops: the list starts on its first page. */
const POSITION_PARAM_NAMES: ReadonlySet<string> = new Set([CURSOR_PARAM_NAME, AS_OF_PARAM_NAME]);

/** `name` is a parameter of a position in the list (the cursor and the time a deadline window counts from). */
export function isPositionParam(name: string): boolean {
  return POSITION_PARAM_NAMES.has(name);
}

/** Rows per page unless the URL says otherwise (routes.md §3.1). */
export const DEFAULT_PAGE_SIZE = 25;
/** The largest page the API serves (`Limit` of the OTA document). */
export const MAX_PAGE_SIZE = 100;
/** The longest cursor the page passes on; the API's cursors are far shorter. */
const MAX_CURSOR_LENGTH = 2048;

// ---- Values of the OTA document -------------------------------------------------------------------------------

/** One choice of a filter. */
export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/** The choices of `labels` in their order: every value of the document's enum, which `STATUS_LABELS` keeps complete. */
function optionsOf(labels: Readonly<Record<string, string>>): readonly FilterOption[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

/** A type guard for the values of one enum. */
function isOneOf<Value extends string>(values: readonly Value[]): (value: string) => value is Value {
  return (value): value is Value => (values as readonly string[]).includes(value);
}

/** `BookingStatus`. */
export const BOOKING_STATUSES = Object.keys(STATUS_LABELS.booking) as ConsoleBookingStatus[];
/** `IssuanceStatus`. */
export const TICKETING_STATUSES = Object.keys(STATUS_LABELS.ticketing) as ConsoleTicketingStatus[];
/** `ConsolePaymentStatus`. */
export const PAYMENT_STATUSES = Object.keys(STATUS_LABELS.payment) as ConsolePaymentStatus[];

/** `ConsoleBookingSummary.channel`, the `source` filter. */
export type BookingSource = ConsoleBookingSummary["channel"];
/** The channel of a booking in words. */
export const SOURCE_LABELS: Readonly<Record<BookingSource, string>> = Object.freeze({
  storefront: "Storefront",
  console: "Console",
  import: "Imported",
});
const BOOKING_SOURCES = Object.keys(SOURCE_LABELS) as BookingSource[];

/** `ConsoleBookingSummary.tripType` in words. */
export const TRIP_TYPE_LABELS: Readonly<Record<ConsoleBookingSummary["tripType"], string>> = Object.freeze({
  one_way: "One way",
  round_trip: "Return",
  multi_city: "Multi-city",
});

/** `bookings.reconcile_outcome`, the `reconcileOutcome` filter (OADR-0003). */
export type ReconcileOutcome = "found" | "not_found" | "manual_review";
const RECONCILE_LABELS: Readonly<Record<ReconcileOutcome, string>> = Object.freeze({
  manual_review: "Needs staff review",
  found: "Order found",
  not_found: "Order not found",
});
const RECONCILE_OUTCOMES = Object.keys(RECONCILE_LABELS) as ReconcileOutcome[];

/** The sorts of `consoleListBookings`; `-created` is the API's default and is never written to the URL. */
const SORT_LABELS: Readonly<Record<Exclude<ConsoleBookingSort, "-created">, string>> = Object.freeze({
  created: "Oldest first",
  departure: "Departure, soonest first",
  "-departure": "Departure, latest first",
  ticketingDeadline: "Ticketing deadline, soonest first",
  "-ticketingDeadline": "Ticketing deadline, latest first",
  "-total": "Total, highest first",
  total: "Total, lowest first",
});
const DEFAULT_SORT: ConsoleBookingSort = "-created";
const BOOKING_SORTS = [DEFAULT_SORT, ...Object.keys(SORT_LABELS)] as ConsoleBookingSort[];

const HOUR_MS = 3_600_000;
/** The windows of `deadlineWithin`: the ticketing deadline is before now plus the window. */
export const DEADLINE_WINDOWS: Readonly<Record<string, { readonly label: string; readonly ms: number }>> =
  Object.freeze({
    "24h": { label: "Within 24 hours", ms: 24 * HOUR_MS },
    "72h": { label: "Within 3 days", ms: 72 * HOUR_MS },
    "7d": { label: "Within 7 days", ms: 7 * 24 * HOUR_MS },
  });

const YES_NO: readonly FilterOption[] = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

/**
 * The needs-attention filters of `consoleListBookings` (OpenAPI document, SDK docs/extensions.md §4) that the SDK's
 * parameter type does not list; the SDK's route table sends them.
 */
export interface NeedsAttentionParams {
  reconcileOutcome?: ReconcileOutcome[];
  cancellationRequested?: boolean;
  hasScheduleChange?: boolean;
}

/** What the page passes to `console.bookings.list`. */
export type BookingListParams = ConsoleListBookingsParams & NeedsAttentionParams;

// ---- Filters ----------------------------------------------------------------------------------------------------

/** Where a filter shows: in the first row, under "More filters", or only as a chip (a link sets it). */
export type FilterPlacement = "main" | "more" | "link";

interface FilterBase<Name extends string> {
  readonly name: Name;
  readonly label: string;
  readonly placement: FilterPlacement;
}

/** Free text; applied when staff submit the filters. */
export interface TextFilter<Name extends string = string> extends FilterBase<Name> {
  readonly kind: "text";
  readonly inputType: "search" | "text" | "email";
  readonly placeholder?: string;
  readonly maxLength: number;
  /** Record locators, references and airline codes are upper case in the API. */
  readonly upperCase?: boolean;
  /** The message for a value the API would refuse, or `undefined` when it takes it. */
  readonly check: (value: string) => string | undefined;
}

/** A calendar day, `YYYY-MM-DD`; applied when staff submit the filters. */
export interface DateFilter<Name extends string = string> extends FilterBase<Name> {
  readonly kind: "date";
}

/** Several choices at once (OR-ed by the API); applied at once. */
export interface MultiFilter<Name extends string = string> extends FilterBase<Name> {
  readonly kind: "multi";
  readonly options: readonly FilterOption[];
}

/** One choice or none; applied at once. */
export interface SelectFilter<Name extends string = string> extends FilterBase<Name> {
  readonly kind: "select";
  readonly options: readonly FilterOption[];
  /** The label of no choice. */
  readonly anyLabel: string;
}

export type BookingFilter = TextFilter | DateFilter | MultiFilter | SelectFilter;

const CODE_POINTS = (value: string) => [...value].length;

function lengthCheck(min: number, max: number): (value: string) => string | undefined {
  return (value) => {
    const length = CODE_POINTS(value);
    if (length < min) {
      return `Enter at least ${min} characters.`;
    }
    return length > max ? `Enter at most ${max} characters.` : undefined;
  };
}

function patternCheck(pattern: RegExp, message: string): (value: string) => string | undefined {
  return (value) => (pattern.test(value) ? undefined : message);
}

/** An e-mail address as far as the admin checks it; the API checks the format again. */
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** An instant with a zone, as `format: date-time` takes it. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** `YYYY-MM-DD` of a real calendar day. */
export function isCalendarDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Every filter of the list, in the order of the form and of the URL. The rules are those of the `consoleListBookings`
 * parameters in the OTA document.
 */
export const BOOKING_FILTERS = [
  {
    name: "q",
    kind: "text",
    label: "Search",
    placement: "main",
    inputType: "search",
    placeholder: "Reference, record locator, e-mail or last name",
    maxLength: 100,
    check: lengthCheck(2, 100),
  },
  {
    name: "status",
    kind: "multi",
    label: "Status",
    placement: "main",
    options: optionsOf(STATUS_LABELS.booking),
  },
  {
    name: "ticketingStatus",
    kind: "multi",
    label: "Ticketing",
    placement: "main",
    options: optionsOf(STATUS_LABELS.ticketing),
  },
  {
    name: "paymentStatus",
    kind: "multi",
    label: "Payment",
    placement: "main",
    options: optionsOf(STATUS_LABELS.payment),
  },
  { name: "source", kind: "multi", label: "Channel", placement: "main", options: optionsOf(SOURCE_LABELS) },
  {
    name: "sort",
    kind: "select",
    label: "Sort",
    placement: "main",
    anyLabel: "Newest first",
    options: optionsOf(SORT_LABELS),
  },
  {
    name: "recordLocator",
    kind: "text",
    label: "Record locator",
    placement: "more",
    inputType: "text",
    maxLength: 8,
    upperCase: true,
    check: patternCheck(/^[A-Z0-9]{5,8}$/, "Enter 5 to 8 letters or digits."),
  },
  {
    name: "reference",
    kind: "text",
    label: "Booking reference",
    placement: "more",
    inputType: "text",
    maxLength: 10,
    upperCase: true,
    check: patternCheck(/^[A-Z0-9]{6,10}$/, "Enter 6 to 10 letters or digits."),
  },
  {
    name: "customerEmail",
    kind: "text",
    label: "Customer e-mail",
    placement: "more",
    inputType: "email",
    maxLength: 254,
    check: (value) =>
      EMAIL.test(value) && value.length <= 254 ? undefined : "Enter a whole e-mail address.",
  },
  {
    name: "travelerLastName",
    kind: "text",
    label: "Traveller last name",
    placement: "more",
    inputType: "text",
    placeholder: "Beginning of the name",
    maxLength: 60,
    check: lengthCheck(2, 60),
  },
  {
    name: "validatingCarrier",
    kind: "text",
    label: "Validating airline",
    placement: "more",
    inputType: "text",
    placeholder: "IATA code",
    maxLength: 2,
    upperCase: true,
    check: patternCheck(/^[A-Z0-9]{2}$/, "Enter the airline's 2-character IATA code."),
  },
  {
    name: "tag",
    kind: "text",
    label: "Tag",
    placement: "more",
    inputType: "text",
    maxLength: 40,
    check: lengthCheck(1, 40),
  },
  { name: "departureFrom", kind: "date", label: "Departure from", placement: "more" },
  { name: "departureTo", kind: "date", label: "Departure to", placement: "more" },
  { name: "createdFrom", kind: "date", label: "Created from", placement: "more" },
  { name: "createdTo", kind: "date", label: "Created to", placement: "more" },
  {
    name: "deadlineWithin",
    kind: "select",
    label: "Ticketing deadline",
    placement: "more",
    anyLabel: "Any time",
    options: Object.entries(DEADLINE_WINDOWS).map(([value, window]) => ({ value, label: window.label })),
  },
  {
    name: "reconcileOutcome",
    kind: "multi",
    label: "Reconciliation",
    placement: "more",
    options: optionsOf(RECONCILE_LABELS),
  },
  {
    name: "cancellationRequested",
    kind: "select",
    label: "Cancellation requested",
    placement: "more",
    anyLabel: "Any",
    options: YES_NO,
  },
  {
    name: "hasScheduleChange",
    kind: "select",
    label: "Schedule changed",
    placement: "more",
    anyLabel: "Any",
    options: YES_NO,
  },
  {
    name: "customerId",
    kind: "text",
    label: "Customer",
    placement: "link",
    inputType: "text",
    maxLength: 44,
    check: patternCheck(/^cus_[0-9A-Za-z]{12,40}$/, "Not a customer id."),
  },
  {
    name: "createdByStaffId",
    kind: "text",
    label: "Created by",
    placement: "link",
    inputType: "text",
    maxLength: 44,
    check: patternCheck(/^stf_[0-9A-Za-z]{16,40}$/, "Not a staff member's id."),
  },
  {
    name: "ticketingDeadlineBefore",
    kind: "text",
    label: "Ticketing deadline before",
    placement: "link",
    inputType: "text",
    maxLength: 40,
    check: (value) => (instantOf(value) === undefined ? "Not a time with a zone." : undefined),
  },
] as const satisfies readonly BookingFilter[];

/** The name of a filter of the list. */
export type FilterName = (typeof BOOKING_FILTERS)[number]["name"];

/** A filter of the list, with its name. */
export type ListFilter =
  TextFilter<FilterName> | DateFilter<FilterName> | MultiFilter<FilterName> | SelectFilter<FilterName>;

/** The values of the filters, by name: a list for every kind (none, one, or the choices of a multi filter). */
export type FilterValues = Readonly<Partial<Record<FilterName, readonly string[]>>>;

/** The messages of the values the API would refuse, by filter. */
export type FilterErrors = Readonly<Partial<Record<FilterName, string>>>;

const FILTER_NAMES: ReadonlySet<string> = new Set(BOOKING_FILTERS.map((filter) => filter.name));

/** The filter called `name`. */
export function filterByName(name: FilterName): ListFilter {
  const filter = BOOKING_FILTERS.find((candidate) => candidate.name === name);
  if (filter === undefined) {
    throw new TypeError(`unknown bookings filter ${name}`);
  }
  return filter;
}

/** The query of a URL as `URLSearchParams`, `useSearchParams()` or a server component's parsed `searchParams` give it. */
export interface QueryLike {
  forEach(callback: (value: string, name: string) => void): void;
}

/** A server component's `searchParams` as a query (repeated parameters in order). */
export function queryOf(
  searchParams: Readonly<Record<string, string | string[] | undefined>>,
): URLSearchParams {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(searchParams)) {
    for (const item of typeof value === "string" ? [value] : (value ?? [])) {
      query.append(name, item);
    }
  }
  return query;
}

/**
 * The filter values of a URL as it is: a multi filter's values from every repetition and every comma-separated part,
 * the other filters' values as they are; empty values are left out (a form sent without JavaScript writes them).
 */
export function filterValuesOf(query: QueryLike): FilterValues {
  const values: Partial<Record<FilterName, string[]>> = {};
  query.forEach((value, name) => {
    if (!FILTER_NAMES.has(name)) {
      return;
    }
    const filterName = name as FilterName;
    const parts = filterByName(filterName).kind === "multi" ? value.split(",") : [value];
    for (const part of parts.map((item) => item.trim()).filter((item) => item !== "")) {
      (values[filterName] ??= []).push(part);
    }
  });
  return values;
}

/** The result of `checkFilters`. */
export interface CheckedFilters {
  /** The values as the URL and the API get them: trimmed, upper case where the API wants it, in option order. */
  readonly values: FilterValues;
  /** The values the API would refuse. */
  readonly errors: FilterErrors;
}

/** One filter's values, normalised, or the message of the first one the API would refuse. */
function checkFilter(
  filter: BookingFilter,
  raw: readonly string[],
): { values: string[] } | { error: string } {
  if (filter.kind === "multi") {
    const allowed = filter.options.map((option) => option.value);
    const unknown = raw.find((value) => !allowed.includes(value));
    return unknown === undefined
      ? { values: allowed.filter((value) => raw.includes(value)) }
      : { error: `"${unknown}" is not one of the choices.` };
  }
  const given = raw.map((value) => value.trim()).filter((value) => value !== "");
  if (given.length > 1) {
    return { error: "Give one value only." };
  }
  const [first] = given;
  if (first === undefined) {
    return { values: [] };
  }
  switch (filter.kind) {
    case "text": {
      const value = filter.upperCase === true ? first.toUpperCase() : first;
      const error = filter.check(value);
      return error === undefined ? { values: [value] } : { error };
    }
    case "date":
      return isCalendarDay(first) ? { values: [first] } : { error: "Enter a day as YYYY-MM-DD." };
    case "select":
      if (filter.name === "sort" && first === DEFAULT_SORT) {
        return { values: [] };
      }
      return filter.options.some((option) => option.value === first)
        ? { values: [first] }
        : { error: `"${first}" is not one of the choices.` };
  }
}

/** Every filter value normalised, and the ones the API would refuse. */
export function checkFilters(values: FilterValues): CheckedFilters {
  const normalised: Partial<Record<FilterName, readonly string[]>> = {};
  const errors: Partial<Record<FilterName, string>> = {};
  for (const filter of BOOKING_FILTERS) {
    const raw = values[filter.name] ?? [];
    const checked = checkFilter(filter, raw);
    if ("error" in checked) {
      errors[filter.name] = checked.error;
    } else if (checked.values.length > 0) {
      normalised[filter.name] = checked.values;
    }
  }
  return { values: normalised, errors };
}

/** The list has at least one filter. */
export function hasFilters(values: FilterValues): boolean {
  return BOOKING_FILTERS.some((filter) => (values[filter.name] ?? []).length > 0);
}

/**
 * The URL of the list with `values` as its filters: every filter of `current` replaced, the position dropped (the
 * cursor and `asOf`: a new filter starts on the first page), every other parameter of `current` (the page size) kept
 * in its place. Filters are written in the order of `BOOKING_FILTERS`, a multi filter as one parameter per choice, so
 * one set of filters always gives the same URL.
 */
export function bookingsHref(current: QueryLike, values: FilterValues): string {
  const next = new URLSearchParams();
  current.forEach((value, name) => {
    if (!FILTER_NAMES.has(name) && !isPositionParam(name)) {
      next.append(name, value);
    }
  });
  for (const filter of BOOKING_FILTERS) {
    for (const value of values[filter.name] ?? []) {
      next.append(filter.name, value);
    }
  }
  const query = next.toString();
  return query === "" ? BOOKINGS_PATH : `${BOOKINGS_PATH}?${query}`;
}

/** "Clear filters": the list without filters and cursor, and without the parameters in `invalid` (a bad page size). */
export function clearedHref(current: QueryLike, invalid: readonly string[] = []): string {
  const kept = new URLSearchParams();
  current.forEach((value, name) => {
    if (!invalid.includes(name)) {
      kept.append(name, value);
    }
  });
  return bookingsHref(kept, {});
}

/** The path and query of the page itself, as Next.js got it (for `/auth/refresh?next=` and "Try again"). */
export function currentHref(query: URLSearchParams): string {
  const text = query.toString();
  return text === "" ? BOOKINGS_PATH : `${BOOKINGS_PATH}?${text}`;
}

// ---- Saved views -------------------------------------------------------------------------------------------------

/** A link with preset filters (routes.md §3.1). */
export interface BookingView {
  readonly id: string;
  readonly label: string;
  /** What the view lists, for its link's description. */
  readonly description: string;
  /** `attention`: the needs-attention work lists of console-operations §3 step 3; `lists`: the other presets. */
  readonly group: "attention" | "lists";
  /** The table's text when the view is empty. */
  readonly emptyMessage: string;
  readonly filters: FilterValues;
}

/** The view groups in display order, with their headings. */
export const VIEW_GROUPS: readonly { readonly id: BookingView["group"]; readonly label: string }[] = [
  { id: "attention", label: "Needs attention" },
  { id: "lists", label: "Lists" },
];

const OPEN_BOOKING: readonly ConsoleBookingStatus[] = ["confirmed", "partially_ticketed"];

/**
 * The saved views. The API combines filters with AND, so "needs attention" is five views, one per reason
 * (console-operations §3 step 3, the `consoleListBookings` description): ticketing failed or in manual review, a
 * reconciliation that staff must settle, a ticketing deadline within 24 hours, an open cancellation request and an
 * airline schedule change. "To issue" lists the bookings without tickets in deadline order.
 */
export const BOOKING_VIEWS: readonly BookingView[] = [
  {
    id: "ticketing-problems",
    label: "Ticketing problems",
    description: "Ticketing failed or in manual review",
    group: "attention",
    emptyMessage: "No booking has a ticketing problem.",
    filters: { ticketingStatus: ["failed", "manual_review"] },
  },
  {
    id: "reconciliation-review",
    label: "Reconciliation review",
    description: "Supplier timeouts the reconciliation could not settle",
    group: "attention",
    emptyMessage: "No reconciliation waits for staff.",
    filters: { reconcileOutcome: ["manual_review"] },
  },
  {
    id: "deadline-24h",
    label: "Deadline within 24 h",
    description: "Not fully ticketed, ticketing deadline within 24 hours",
    group: "attention",
    emptyMessage: "No ticketing deadline falls within the next 24 hours.",
    filters: { status: OPEN_BOOKING, sort: ["ticketingDeadline"], deadlineWithin: ["24h"] },
  },
  {
    id: "cancellation-requested",
    label: "Cancellation requested",
    description: "A cancellation request the booking has not been cancelled for",
    group: "attention",
    emptyMessage: "No cancellation request is open.",
    filters: { cancellationRequested: ["true"] },
  },
  {
    id: "schedule-changed",
    label: "Schedule changed",
    description: "An airline schedule change since booking",
    group: "attention",
    emptyMessage: "No booking has a schedule change.",
    filters: { hasScheduleChange: ["true"] },
  },
  {
    id: "all",
    label: "All bookings",
    description: "Every booking, newest first",
    group: "lists",
    emptyMessage: "No bookings yet in this environment.",
    filters: {},
  },
  {
    id: "to-issue",
    label: "To issue",
    description: "Confirmed or partially ticketed, in deadline order",
    group: "lists",
    emptyMessage: "No booking waits for tickets.",
    filters: { status: OPEN_BOOKING, sort: ["ticketingDeadline"] },
  },
  {
    id: "reconciling",
    label: "Reconciling",
    description: "Outcome unknown after a supplier timeout",
    group: "lists",
    emptyMessage: "No booking is being reconciled.",
    filters: { status: ["pending"] },
  },
  {
    id: "cancelled",
    label: "Cancelled",
    description: "Cancelled bookings, newest first",
    group: "lists",
    emptyMessage: "No booking is cancelled.",
    filters: { status: ["cancelled"] },
  },
  {
    id: "imported",
    label: "Imported",
    description: "Bookings imported from Amadeus by record locator",
    group: "lists",
    emptyMessage: "No booking was imported.",
    filters: { source: ["import"] },
  },
];

const NO_QUERY: QueryLike = { forEach: () => undefined };

/** The link of a saved view. */
export function viewHref(view: BookingView): string {
  return bookingsHref(NO_QUERY, view.filters);
}

/** The view whose filters are exactly those of the URL (in any order), or `undefined`. */
export function activeView(query: QueryLike): BookingView | undefined {
  const { values, errors } = checkFilters(filterValuesOf(query));
  if (Object.keys(errors).length > 0) {
    return undefined;
  }
  const href = bookingsHref(NO_QUERY, values);
  return BOOKING_VIEWS.find((view) => viewHref(view) === href);
}

// ---- The API's parameters -----------------------------------------------------------------------------------------

/** What `listParams` needs besides the URL. */
export interface ListContext {
  /** Epoch ms of the request: `deadlineWithin` counts from it. */
  readonly now: number;
  /** The OTA's time zone (`tenant.timeZone`): the created days are its days. */
  readonly timeZone: string;
}

/** The result of `listParams`. */
export interface ListQuery {
  readonly params: BookingListParams;
  /** The URL's parameters that the API would refuse, by name (filters, cursor, `asOf` and page size). */
  readonly invalid: readonly string[];
  /**
   * What the "Next page" link must carry besides the cursor so the next page sends the same filters: `asOf`, the time
   * a `deadlineWithin` window counted from on this page. The API refuses a cursor of other filters
   * (`400 VALIDATION_FAILED`), and "now + 24 h" is another instant on every request.
   */
  readonly pinned?: Readonly<Record<string, string>>;
}

/** The offset of `timeZone` from UTC at `instant`, in ms (`Intl`'s view of the zone's rules). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return local - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * The instant a calendar day starts in `timeZone`, as an ISO string (UTC); `days` later for `days` > 0. A zone the
 * runtime does not know counts as UTC.
 */
export function dayStartIn(day: string, timeZone: string, days = 0): string {
  const match = DAY.exec(day);
  if (match === null) {
    throw new TypeError(`not a calendar day: ${day}`);
  }
  const midnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  let offset: number;
  try {
    offset = zoneOffsetMs(midnight, timeZone);
    // Twice: the offset at the guess may differ from the one at the result across a change of daylight saving time.
    offset = zoneOffsetMs(midnight - offset, timeZone);
  } catch {
    offset = 0;
  }
  return new Date(midnight - offset).toISOString();
}

/** An instant of the URL (`format: date-time`), as epoch ms, or `undefined` when it is not one. */
function instantOf(value: string): number | undefined {
  const instant = INSTANT.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(instant) ? instant : undefined;
}

/**
 * The cursor, the time a deadline window counts from on a later page (`asOf`, read only with a cursor: a first page
 * counts from the request) and the page size of the URL.
 */
function pagingOf(query: QueryLike): {
  cursor?: string;
  asOf?: number;
  limit: number;
  invalid: string[];
} {
  const cursors: string[] = [];
  const asOfs: string[] = [];
  const limits: string[] = [];
  query.forEach((value, name) => {
    if (name === CURSOR_PARAM_NAME && value !== "") {
      cursors.push(value);
    } else if (name === AS_OF_PARAM_NAME && value !== "") {
      asOfs.push(value);
    } else if (name === LIMIT_PARAM_NAME && value !== "") {
      limits.push(value);
    }
  });
  const invalid: string[] = [];
  const [cursor] = cursors;
  if (cursors.length > 1 || (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)) {
    invalid.push(CURSOR_PARAM_NAME);
  }
  let asOf: number | undefined;
  const [asOfText] = asOfs;
  if (cursor !== undefined && asOfText !== undefined) {
    asOf = asOfs.length > 1 ? undefined : instantOf(asOfText);
    if (asOf === undefined) {
      invalid.push(AS_OF_PARAM_NAME);
    }
  }
  let limit = DEFAULT_PAGE_SIZE;
  const [limitText] = limits;
  if (limitText !== undefined) {
    const parsed = /^\d{1,3}$/.test(limitText) ? Number(limitText) : Number.NaN;
    if (limits.length > 1 || !(parsed >= 1 && parsed <= MAX_PAGE_SIZE)) {
      invalid.push(LIMIT_PARAM_NAME);
    } else {
      limit = parsed;
    }
  }
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(asOf === undefined ? {} : { asOf }),
    limit,
    invalid,
  };
}

/** The one value of a checked filter. */
function single(values: FilterValues, name: FilterName): string | undefined {
  return values[name]?.[0];
}

/** The filters the API takes as the URL writes them. */
const PLAIN_TEXT_PARAMS = [
  "recordLocator",
  "reference",
  "customerEmail",
  "travelerLastName",
  "validatingCarrier",
  "tag",
  "departureFrom",
  "departureTo",
  "customerId",
  "createdByStaffId",
] as const satisfies readonly FilterName[];

/** `ticketingDeadlineBefore`: the earlier of the link's instant and `now` plus the `deadlineWithin` window. */
function deadlineBefore(
  instant: string | undefined,
  window: string | undefined,
  now: number,
): string | undefined {
  const candidates: number[] = [];
  if (instant !== undefined) {
    candidates.push(Date.parse(instant));
  }
  const windowMs = window === undefined ? undefined : DEADLINE_WINDOWS[window]?.ms;
  if (windowMs !== undefined) {
    candidates.push(now + windowMs);
  }
  return candidates.length === 0 ? undefined : new Date(Math.min(...candidates)).toISOString();
}

/**
 * The parameters of `console.bookings.list` for the URL `query`: the filters (`deadlineWithin` as
 * `ticketingDeadlineBefore` from `now`, or on a later page from the first page's `asOf` (never later than `now`, so a
 * link cannot widen the window), the earlier of the two when both are given; the created days as instants in the
 * OTA's time zone, `createdTo` up to the end of its day), the sort, the cursor and the page size (25 by default).
 * `invalid` names the URL's parameters the API would refuse; the page then sends nothing. `pinned` is what the next
 * page's link carries so that it sends the same filters.
 */
export function listParams(query: QueryLike, context: ListContext): ListQuery {
  const { values, errors } = checkFilters(filterValuesOf(query));
  const paging = pagingOf(query);
  const windowFrom = paging.asOf === undefined ? context.now : Math.min(paging.asOf, context.now);
  const text = (name: FilterName) => single(values, name);
  const params: BookingListParams = { limit: paging.limit };
  if (paging.cursor !== undefined) {
    params.cursor = paging.cursor;
  }

  const q = text("q");
  if (q !== undefined) {
    params.q = q;
  }
  const status = values.status?.filter(isOneOf(BOOKING_STATUSES));
  if (status !== undefined) {
    params.status = status;
  }
  const ticketingStatus = values.ticketingStatus?.filter(isOneOf(TICKETING_STATUSES));
  if (ticketingStatus !== undefined) {
    params.ticketingStatus = ticketingStatus;
  }
  const paymentStatus = values.paymentStatus?.filter(isOneOf(PAYMENT_STATUSES));
  if (paymentStatus !== undefined) {
    params.paymentStatus = paymentStatus;
  }
  const source = values.source?.filter(isOneOf(BOOKING_SOURCES));
  if (source !== undefined) {
    params.source = source;
  }
  const sort = text("sort");
  if (sort !== undefined && isOneOf(BOOKING_SORTS)(sort)) {
    params.sort = sort;
  }
  for (const name of PLAIN_TEXT_PARAMS) {
    const value = text(name);
    if (value !== undefined) {
      params[name] = value;
    }
  }
  const createdFrom = text("createdFrom");
  if (createdFrom !== undefined) {
    params.createdFrom = dayStartIn(createdFrom, context.timeZone);
  }
  const createdTo = text("createdTo");
  if (createdTo !== undefined) {
    params.createdTo = dayStartIn(createdTo, context.timeZone, 1);
  }
  const deadlineWindow = text("deadlineWithin");
  const deadline = deadlineBefore(text("ticketingDeadlineBefore"), deadlineWindow, windowFrom);
  if (deadline !== undefined) {
    params.ticketingDeadlineBefore = deadline;
  }
  const reconcileOutcome = values.reconcileOutcome?.filter(isOneOf(RECONCILE_OUTCOMES));
  if (reconcileOutcome !== undefined) {
    params.reconcileOutcome = reconcileOutcome;
  }
  const cancellationRequested = text("cancellationRequested");
  if (cancellationRequested !== undefined) {
    params.cancellationRequested = cancellationRequested === "true";
  }
  const hasScheduleChange = text("hasScheduleChange");
  if (hasScheduleChange !== undefined) {
    params.hasScheduleChange = hasScheduleChange === "true";
  }
  return {
    params,
    invalid: [...(Object.keys(errors) as FilterName[]), ...paging.invalid],
    ...(deadlineWindow === undefined
      ? {}
      : { pinned: { [AS_OF_PARAM_NAME]: new Date(windowFrom).toISOString() } }),
  };
}

/** The label of a filter or paging parameter, for the notice of an invalid link. */
export function parameterLabel(name: string): string {
  if (FILTER_NAMES.has(name)) {
    return filterByName(name as FilterName).label;
  }
  return isPositionParam(name) ? "Page" : name === LIMIT_PARAM_NAME ? "Page size" : name;
}

// ---- Rows -------------------------------------------------------------------------------------------------------

/** A time as the table shows it, with the value for `<time dateTime>`. */
export interface ShownTime {
  readonly label: string;
  readonly dateTime: string;
}

/** One row of the table: only what it shows crosses into the client component, already formatted on the server. */
export interface BookingRow {
  readonly id: string;
  readonly reference: string;
  readonly recordLocator: string | null;
  readonly leadTraveler: string;
  /** Travellers besides the lead traveller. */
  readonly otherTravelers: number;
  readonly guest: boolean;
  /** `CDG → JFK`. */
  readonly route: string;
  readonly tripType: string;
  /** The first departure, local to the airport. */
  readonly departure: ShownTime;
  readonly status: ConsoleBookingStatus;
  readonly ticketingStatus: ConsoleTicketingStatus;
  readonly ticketingDeadline: ShownTime | null;
  readonly paymentStatus: ConsolePaymentStatus;
  readonly total: MoneyValue;
  readonly net: MoneyValue;
  readonly markup: MoneyValue;
  readonly channel: string;
  readonly created: ShownTime;
  readonly scheduleChanged: boolean;
}

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** A local date and time without a zone (`2026-11-20T10:25:00`, an airport's time), as it reads there. */
export function formatLocalTime(value: string): string {
  const match = LOCAL_TIME.exec(value);
  if (match === null) {
    return value;
  }
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, { ...TIME_FORMAT, timeZone: "UTC" }).format(
    Date.UTC(year, month - 1, day, hour, minute),
  );
}

/** An instant in the OTA's time zone (UTC when the runtime does not know the zone). */
export function formatInstant(value: string, timeZone: string): string {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    return value;
  }
  try {
    return new Intl.DateTimeFormat(DEFAULT_LOCALE, { ...TIME_FORMAT, timeZone }).format(instant);
  } catch {
    return new Intl.DateTimeFormat(DEFAULT_LOCALE, { ...TIME_FORMAT, timeZone: "UTC" }).format(instant);
  }
}

/** The row of a booking of `console.bookings.list`, times in the OTA's time zone. */
export function bookingRow(summary: ConsoleBookingSummary, timeZone: string): BookingRow {
  return {
    id: summary.id,
    reference: summary.reference,
    recordLocator: summary.recordLocator,
    leadTraveler: summary.leadTravelerName,
    otherTravelers: Math.max(summary.travelersCount - 1, 0),
    guest: summary.isGuest,
    route: `${summary.originCode} → ${summary.destinationCode}`,
    tripType: TRIP_TYPE_LABELS[summary.tripType] ?? summary.tripType,
    departure: { label: formatLocalTime(summary.departureAt), dateTime: summary.departureAt },
    status: summary.status,
    ticketingStatus: summary.ticketingStatus,
    ticketingDeadline:
      summary.ticketingDeadlineAt === null
        ? null
        : {
            label: formatInstant(summary.ticketingDeadlineAt, timeZone),
            dateTime: summary.ticketingDeadlineAt,
          },
    paymentStatus: summary.paymentStatus,
    total: { amount: summary.total.amount, currency: summary.total.currency },
    net: { amount: summary.net.amount, currency: summary.net.currency },
    markup: { amount: summary.markup.amount, currency: summary.markup.currency },
    channel: SOURCE_LABELS[summary.channel] ?? summary.channel,
    created: { label: formatInstant(summary.createdAt, timeZone), dateTime: summary.createdAt },
    scheduleChanged: summary.hasScheduleChange,
  };
}
