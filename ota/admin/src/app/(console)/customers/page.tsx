// `/customers` (README §5, routes.md §8, OAD-012): the OTA's customer accounts through `console.customers.list`
// (`customers:read`, every role), with their booking statistics in the environment of the switch, a search by the
// start of an e-mail address, first or last name, filters and cursor paging. Guests are not customers: their bookings
// are found in the bookings list by e-mail.
//
// The URL is the state, as on `/bookings` and `/payments` (routes.md §3.1, §7), so every view of the list is a link
// staff can share: `q` (2 to 100 characters, the API's prefix search), `status` (repeated or comma-separated:
// `active`, `disabled`, `deleted`; none means the API's default, active and disabled, so deleted accounts are listed
// only when asked for), `emailVerified` and `hasBookings` (`true` or `false`), `sort` (the document's values; the
// default `-created` is never written), `cursor` (the `page.nextCursor` of the previous page, which "Next page" sets and
// "First page" drops, the other parameters kept: the API binds a cursor to the filters and the sort that wrote it) and
// `limit` (25). The filters are a plain GET form to this page: it works without JavaScript and writes nothing but the
// URL. A link with a value the API would refuse is never sent: the page names its parameters, with "Clear filters".
//
// Rows are formatted here, on the server: the customer (a link to the detail page), the e-mail address and whether it
// is verified, the account's status, the bookings and upcoming trips, the total spent (captured less refunded), the
// last booking and the sign-up, in the OTA's time zone. A deleted account is shown as the API returns it and nothing
// more: its placeholder address, no name ("Deleted account") and its statistics. The list is not an audited read
// (OADR-0011 point 8, flow §3 step 7); opening a customer is.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// list, an ended session to the portal (`redirectOnSessionError`), and every other API error renders the console's
// message for its code with the request id under the filters, with "Try again" (and "Clear filters" for `400
// VALIDATION_FAILED`).
import type { ConsoleCustomerSummary, ConsoleListCustomersParams } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  BOOKINGS_PATH,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  formatInstant,
  queryOf,
} from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { Money } from "@/components/money";
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

export const metadata: Metadata = { title: "Customers" };

const PAGE_STRINGS = Object.freeze({
  title: "Customers",
  intro: (environment: string) =>
    `The customer accounts of this OTA, with their bookings in the ${environment} environment. Accounts are shared by both environments.`,
  guestsBefore: "Guests are not customers: find a guest's bookings in the",
  bookingsList: "bookings list",
  guestsAfter: "by their e-mail address.",
  filters: "Customer filters",
  apply: "Search",
  clear: "Clear filters",
  any: "Any",
  invalidTitle: "This link has filters the list cannot use",
  invalid: (labels: string) => `Not valid: ${labels}. Change them above, or clear the filters.`,
  unavailableTitle: "The customers could not be loaded",
  forbiddenTitle: "You cannot open the customers",
  retry: "Try again",
  noMatch: "No customer matches these filters.",
  noCustomers: "No customer accounts yet.",
  caption: "Customers",
  pages: "Pages",
  firstPage: "First page",
  nextPage: "Next page",
  deleted: "Deleted account",
  noName: "No name given",
  verified: "Verified",
  notVerified: "Not verified",
  upcoming: (count: number) => `${count} upcoming`,
  never: "Never",
  nothing: "Nothing yet",
  columns: {
    customer: "Customer",
    email: "E-mail",
    status: "Status",
    bookings: "Bookings",
    totalSpent: "Total spent",
    lastBooking: "Last booking",
    signedUp: "Signed up",
  },
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const FIELD_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const PAGE_LINK_CLASS =
  "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";
const MUTED = "text-xs text-muted-foreground";

/** The route of the list. */
const CUSTOMERS_PATH = "/customers";
/** The permission of the list (scope §1.3: every role). */
const READ_PERMISSION = "customers:read";
/** The cursor's query parameter. */
const CURSOR_PARAM = "cursor";
/** The page size's query parameter. */
const LIMIT_PARAM = "limit";
/** The longest cursor the page passes on; the API's cursors are far shorter. */
const MAX_CURSOR_LENGTH = 2048;
/** The search's bounds (the document's `q`: `minLength` 2, `maxLength` 100). */
const MIN_SEARCH_LENGTH = 2;
const MAX_SEARCH_LENGTH = 100;

// ---- Values of the OTA document ---------------------------------------------------------------------------------

type CustomerStatus = ConsoleCustomerSummary["status"];
type CustomerSort = NonNullable<ConsoleListCustomersParams["sort"]>;

/** `true`, or the members of `All` that `Listed` misses (which `true` is not assignable to). */
type Complete<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : Exclude<All, Listed>;

/** The statuses of `ConsoleCustomerSummary`, in words and tones. */
const STATUS_LABELS: Readonly<Record<CustomerStatus, string>> = {
  active: "Active",
  disabled: "Disabled",
  deleted: "Deleted",
};
const STATUS_TONES: Readonly<Record<CustomerStatus, StatusTone>> = {
  active: "success",
  disabled: "warning",
  deleted: "neutral",
};
const STATUSES = Object.keys(STATUS_LABELS) as CustomerStatus[];

/** The sorts of the document, the default first. */
const SORTS = [
  ["-created", "Newest sign-ups first"],
  ["created", "Oldest sign-ups first"],
  ["name", "Name"],
  ["-lastBooking", "Latest booking first"],
  ["-totalSpent", "Highest total spent first"],
] as const satisfies readonly (readonly [CustomerSort, string])[];
// Compile-time completeness: a sort the document adds and this list misses fails the type check.
const _sortsComplete: Complete<CustomerSort, (typeof SORTS)[number][0]> = true;
const DEFAULT_SORT: CustomerSort = "-created";

// ---- The URL's filters -----------------------------------------------------------------------------------------

/** One choice of a filter. */
interface Choice {
  readonly value: string;
  readonly label: string;
}

/** The search by prefix. */
interface SearchFilter {
  readonly kind: "search";
  readonly name: "q";
  readonly label: string;
}

/** A filter of several choices (OR-ed by the API). */
interface MultiFilter {
  readonly kind: "multi";
  readonly name: "status";
  readonly label: string;
  readonly choices: readonly Choice[];
  /** What no choice means. */
  readonly none: string;
}

/** A filter of one choice: a yes or no question, or the sort. */
interface SelectFilter {
  readonly kind: "select";
  readonly name: "emailVerified" | "hasBookings" | "sort";
  readonly label: string;
  readonly choices: readonly Choice[];
  /** The text of the empty choice: the API's default. */
  readonly none: string;
}

type CustomerFilter = SearchFilter | MultiFilter | SelectFilter;

/** Every filter of the list, in the order of the form and of the URL. */
const FILTERS: readonly CustomerFilter[] = [
  { kind: "search", name: "q", label: "Search" },
  {
    kind: "multi",
    name: "status",
    label: "Account status",
    choices: STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
    none: "Active and disabled",
  },
  {
    kind: "select",
    name: "emailVerified",
    label: "E-mail",
    choices: [
      { value: "true", label: "Verified" },
      { value: "false", label: "Not verified" },
    ],
    none: PAGE_STRINGS.any,
  },
  {
    kind: "select",
    name: "hasBookings",
    label: "Bookings",
    choices: [
      { value: "true", label: "With bookings" },
      { value: "false", label: "Without bookings" },
    ],
    none: PAGE_STRINGS.any,
  },
  {
    kind: "select",
    name: "sort",
    label: "Sort",
    // The default sort is the empty choice, so the URL never writes it.
    choices: SORTS.filter(([value]) => value !== DEFAULT_SORT).map(([value, label]) => ({ value, label })),
    none: SORTS[0][1],
  },
];

const FILTER_NAMES: ReadonlySet<string> = new Set(FILTERS.map((filter) => filter.name));

/** The labels of the URL's parameters, for the notice of a link that is not valid. */
const PARAMETER_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(FILTERS.map((filter) => [filter.name, filter.label])),
  [CURSOR_PARAM]: "Page",
  [LIMIT_PARAM]: "Page size",
};

/** The filters of a URL, normalised. */
type FilterValues = Readonly<Partial<Record<CustomerFilter["name"], readonly string[]>>>;

/** What `listQueryOf` makes of a URL. */
interface ListQuery {
  readonly values: FilterValues;
  readonly params: ConsoleListCustomersParams;
  /** The URL's parameters the API would refuse, by name; the page then sends nothing. */
  readonly invalid: readonly string[];
}

/** Every value of `name` in the URL: repeated parameters (and comma-separated parts), trimmed, without empty ones. */
function valuesOf(query: URLSearchParams, name: string, split: boolean): string[] {
  return query
    .getAll(name)
    .flatMap((value) => (split ? value.split(",") : [value]))
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** One filter's values, normalised, or `undefined` when the API would refuse them. */
function checkFilter(filter: CustomerFilter, query: URLSearchParams): string[] | undefined {
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
  if (given.length > 1) {
    return undefined;
  }
  if (filter.kind === "search") {
    // The document's bounds count characters (code points), as the API's validator does, not UTF-16 units.
    const length = [...first].length;
    return length >= MIN_SEARCH_LENGTH && length <= MAX_SEARCH_LENGTH ? [first] : undefined;
  }
  if (filter.name === "sort" && first === DEFAULT_SORT) {
    return [];
  }
  return filter.choices.some((choice) => choice.value === first) ? [first] : undefined;
}

/** The URL's page size: none (the default), one the API serves (1 to 100), or `null` for one it would refuse. */
function pageSizeOf(query: URLSearchParams): number | null | undefined {
  const limits = valuesOf(query, LIMIT_PARAM, false);
  const [text] = limits;
  if (text === undefined) {
    return undefined;
  }
  const limit = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN;
  return limits.length === 1 && limit >= 1 && limit <= MAX_PAGE_SIZE ? limit : null;
}

/** `value` is one of `allowed`. */
function isOneOf<Value extends string>(allowed: readonly Value[]): (value: string) => value is Value {
  return (value): value is Value => (allowed as readonly string[]).includes(value);
}

/** The parameters of `console.customers.list` for the URL `query`: the filters, the sort, the cursor and the page size. */
function listQueryOf(query: URLSearchParams): ListQuery {
  const invalid: string[] = [];
  const values: Partial<Record<CustomerFilter["name"], readonly string[]>> = {};
  for (const filter of FILTERS) {
    const checked = checkFilter(filter, query);
    if (checked === undefined) {
      invalid.push(filter.name);
    } else if (checked.length > 0) {
      values[filter.name] = checked;
    }
  }

  const params: ConsoleListCustomersParams = { limit: DEFAULT_PAGE_SIZE };
  const cursors = valuesOf(query, CURSOR_PARAM, false);
  const [cursor] = cursors;
  if (cursors.length > 1 || (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)) {
    invalid.push(CURSOR_PARAM);
  } else if (cursor !== undefined) {
    params.cursor = cursor;
  }
  const limit = pageSizeOf(query);
  if (limit === null) {
    invalid.push(LIMIT_PARAM);
  } else if (limit !== undefined) {
    params.limit = limit;
  }

  const [q] = values.q ?? [];
  if (q !== undefined) {
    params.q = q;
  }
  const status = values.status?.filter(isOneOf(STATUSES));
  if (status !== undefined) {
    params.status = status;
  }
  const [emailVerified] = values.emailVerified ?? [];
  if (emailVerified !== undefined) {
    params.emailVerified = emailVerified === "true";
  }
  const [hasBookings] = values.hasBookings ?? [];
  if (hasBookings !== undefined) {
    params.hasBookings = hasBookings === "true";
  }
  const [sort] = (values.sort ?? []).filter(isOneOf(SORTS.map(([value]) => value)));
  if (sort !== undefined) {
    params.sort = sort;
  }
  return { values, params, invalid };
}

/** The list has at least one filter (the sort is not one). */
function hasFilters(values: FilterValues): boolean {
  return FILTERS.some((filter) => filter.name !== "sort" && (values[filter.name] ?? []).length > 0);
}

/** The URL of the list for `query`, with `changes` applied: a value sets a parameter, `null` removes it. */
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
  return text === "" ? CUSTOMERS_PATH : `${CUSTOMERS_PATH}?${text}`;
}

/** "Clear filters": the list without filters, sort and cursor, and without a page size the API would refuse. */
function clearedHref(query: URLSearchParams): string {
  const refusedLimit = pageSizeOf(query) === null;
  const kept = new URLSearchParams();
  query.forEach((value, name) => {
    if (!FILTER_NAMES.has(name) && name !== CURSOR_PARAM && !(refusedLimit && name === LIMIT_PARAM)) {
      kept.append(name, value);
    }
  });
  return listHref(kept);
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

/** What a multi filter's summary says: what no choice means, the chosen labels, or how many are chosen. */
function choiceSummary(filter: MultiFilter, values: readonly string[]): string {
  const labels = filter.choices
    .filter((choice) => values.includes(choice.value))
    .map((choice) => choice.label);
  return labels.length === 0 ? filter.none : labels.join(", ");
}

/** One field of the filter form, showing the URL's values. */
function FilterField({
  filter,
  values,
}: {
  readonly filter: CustomerFilter;
  readonly values: readonly string[];
}) {
  const id = `customers-filter-${filter.name}`;
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
          <fieldset className="absolute z-20 mt-1 grid min-w-48 gap-2 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
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
  if (filter.kind === "select") {
    return (
      <div className="grid content-start gap-2">
        <label htmlFor={id} className="text-sm leading-none font-medium">
          {filter.label}
        </label>
        <select id={id} name={filter.name} defaultValue={values[0] ?? ""} className={cn(FIELD_CLASS, "w-52")}>
          <option value="">{filter.none}</option>
          {filter.choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
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
        type="search"
        defaultValue={values[0] ?? ""}
        placeholder="E-mail, first or last name"
        aria-describedby={`${id}-hint`}
        maxLength={MAX_SEARCH_LENGTH}
        autoComplete="off"
        spellCheck={false}
        className="w-72"
      />
      <span id={`${id}-hint`} className={MUTED}>
        The start of it, at least {MIN_SEARCH_LENGTH} characters.
      </span>
    </div>
  );
}

/** The filters: a GET form to this page, which reads it the same way with or without JavaScript. */
function CustomerFilters({
  query,
  values,
}: {
  readonly query: URLSearchParams;
  readonly values: FilterValues;
}) {
  // The page size stays when the API serves it (a refused one goes, so the form's next list can be sent); the filters
  // and the position are the form's.
  const limit = pageSizeOf(query);
  const kept = typeof limit === "number" ? [String(limit)] : [];
  return (
    <form
      role="search"
      aria-label={PAGE_STRINGS.filters}
      method="get"
      action={CUSTOMERS_PATH}
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
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="outline">
          {PAGE_STRINGS.apply}
        </Button>
        {hasFilters(values) || (values.sort ?? []).length > 0 ? (
          <Link href={clearedHref(query)} className={LINK_CLASS}>
            {PAGE_STRINGS.clear}
          </Link>
        ) : null}
      </div>
    </form>
  );
}

/** The heading and the filters, above whatever the page shows. */
function ListShell({
  environment,
  query,
  values,
  children,
}: {
  readonly environment: string;
  readonly query: URLSearchParams;
  readonly values: FilterValues;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAGE_STRINGS.intro(environment)}</p>
        <p className="text-sm text-muted-foreground">
          {PAGE_STRINGS.guestsBefore}{" "}
          <Link href={BOOKINGS_PATH} className="font-medium text-primary underline underline-offset-4">
            {PAGE_STRINGS.bookingsList}
          </Link>{" "}
          {PAGE_STRINGS.guestsAfter}
        </p>
      </div>
      <CustomerFilters query={query} values={values} />
      {children}
    </div>
  );
}

/** A customer's name as the list shows it: the given and family names, or none. */
function nameOf(customer: Pick<ConsoleCustomerSummary, "firstName" | "lastName">): string | undefined {
  const name = [customer.firstName, customer.lastName]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(" ");
  return name === "" ? undefined : name;
}

/** The status of an account in words with a matching colour. */
function CustomerStatusBadge({ status }: { readonly status: CustomerStatus }) {
  const tone = STATUS_TONES[status] ?? "neutral";
  return (
    <Badge variant="outline" data-status={status} data-tone={tone} className={toneClasses(tone)}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** The cells of one customer. */
function CustomerRow({
  customer,
  timeZone,
}: {
  readonly customer: ConsoleCustomerSummary;
  readonly timeZone: string;
}) {
  // A deleted account has no name in the API's answer (`null`): it is named as deleted, never looked up elsewhere.
  const label =
    customer.status === "deleted" ? PAGE_STRINGS.deleted : (nameOf(customer) ?? PAGE_STRINGS.noName);
  return (
    <TableRow>
      <TableCell>
        <div className="grid gap-0.5">
          <Link
            href={`${CUSTOMERS_PATH}/${encodeURIComponent(customer.id)}`}
            className="font-medium underline-offset-4 hover:underline focus-visible:underline"
          >
            {label}
          </Link>
          <code className={MUTED}>{customer.id}</code>
        </div>
      </TableCell>
      <TableCell>
        <div className="grid gap-0.5">
          <span className="break-all">{customer.email}</span>
          <span className={MUTED}>
            {customer.emailVerified ? PAGE_STRINGS.verified : PAGE_STRINGS.notVerified}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <CustomerStatusBadge status={customer.status} />
      </TableCell>
      <TableCell>
        <div className="grid gap-0.5 tabular-nums">
          <span>{customer.bookingsCount}</span>
          <span className={MUTED}>{PAGE_STRINGS.upcoming(customer.upcomingBookingsCount)}</span>
        </div>
      </TableCell>
      <TableCell className="text-right">
        {customer.totalSpent === null ? (
          <span className="text-muted-foreground">{PAGE_STRINGS.nothing}</span>
        ) : (
          <Money value={customer.totalSpent} />
        )}
      </TableCell>
      <TableCell>
        {customer.lastBookingAt === null ? (
          <span className="text-muted-foreground">{PAGE_STRINGS.never}</span>
        ) : (
          <time dateTime={customer.lastBookingAt}>{formatInstant(customer.lastBookingAt, timeZone)}</time>
        )}
      </TableCell>
      <TableCell>
        <time dateTime={customer.createdAt}>{formatInstant(customer.createdAt, timeZone)}</time>
      </TableCell>
    </TableRow>
  );
}

/** The customers of one page, and the links to the next page and back to the first. */
function CustomersTable({
  customers,
  timeZone,
  query,
  nextCursor,
  emptyMessage,
}: {
  readonly customers: readonly ConsoleCustomerSummary[];
  readonly timeZone: string;
  readonly query: URLSearchParams;
  readonly nextCursor: string | null;
  readonly emptyMessage: string;
}) {
  const columns = Object.values(PAGE_STRINGS.columns);
  const onLaterPage = valuesOf(query, CURSOR_PARAM, false).length > 0;
  return (
    <div className="grid gap-4">
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
          {customers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            customers.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} timeZone={timeZone} />
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

export default async function CustomersPage({
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

  const list = listQueryOf(query);
  if (list.invalid.length > 0) {
    return (
      <ListShell environment={environment} query={query} values={list.values}>
        <section role="alert" className="grid max-w-xl gap-3">
          <h2 className="text-xl font-semibold">{PAGE_STRINGS.invalidTitle}</h2>
          <p>{PAGE_STRINGS.invalid(list.invalid.map((name) => PARAMETER_LABELS[name] ?? name).join(", "))}</p>
          <Link href={clearedHref(query)} className={LINK_CLASS}>
            {PAGE_STRINGS.clear}
          </Link>
        </section>
      </ListShell>
    );
  }

  let customers: ConsoleCustomerSummary[];
  let nextCursor: string | null;
  try {
    const page = await request.console.customers.list(list.params);
    customers = page.data;
    nextCursor = page.page.nextCursor;
  } catch (error) {
    const failure = await apiFailure(error, here);
    return (
      <ListShell environment={environment} query={query} values={list.values}>
        <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
          {/* The same URL again: the list is read anew. */}
          <a href={here} className={LINK_CLASS}>
            {PAGE_STRINGS.retry}
          </a>
          {failure.code === "VALIDATION_FAILED" ? (
            <Link href={clearedHref(query)} className={LINK_CLASS}>
              {PAGE_STRINGS.clear}
            </Link>
          ) : null}
        </ErrorState>
      </ListShell>
    );
  }

  return (
    <ListShell environment={environment} query={query} values={list.values}>
      <CustomersTable
        customers={customers}
        timeZone={staff.tenant.timeZone}
        query={query}
        nextCursor={nextCursor}
        emptyMessage={hasFilters(list.values) ? PAGE_STRINGS.noMatch : PAGE_STRINGS.noCustomers}
      />
    </ListShell>
  );
}
