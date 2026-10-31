// `/payments` (README §5, routes.md §7, OAD-011): every payment of the OTA in the environment of the switch, newest
// first, through `console.payments.list` (`payments:read`, every role), with filters and cursor paging.
//
// The URL is the state, as on `/bookings` (routes.md §3.1), so every view of the list is a link staff can share: a
// list filter repeats its parameter (`status=authorized&status=captured`; a comma-separated value is read too) and
// takes the values of the OTA document's enums (`status` as `Payment.status` spells it, `provider`, `method`);
// `bookingId` is one booking id (`bkg_…`); `createdFrom` / `createdTo` are days (`YYYY-MM-DD`) in the OTA's time zone,
// `createdTo` up to the end of its day; `cursor` is the `page.nextCursor` of the previous page, which "Next page" sets
// and "First page" drops, the other parameters kept (the API binds a cursor to the filters that wrote it, and the
// same URL always sends the same filters); `limit` is the page size (25). The filters are a plain GET form to this
// page: it works without JavaScript and writes nothing but the URL. A link with a value the API would refuse is never
// sent: the page names its parameters, with "Clear filters".
//
// Rows are formatted here, on the server: the payment (a link to its page), its creation time in the OTA's time zone,
// its booking (a link, with the booking's status) or none yet, the provider and method with the card's brand and last
// 4 only (never its expiry or holder), the payment's status and its amounts.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// list, an ended session to the portal (`redirectOnSessionError`), and every other API error renders the console's
// message for its code with the request id under the filters, with "Try again" (and "Clear filters" for `400
// VALIDATION_FAILED`).
import type { ConsoleListPaymentsParams, ConsolePayment, Payment } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  BOOKING_ID_PATTERN,
  METHOD_LABELS,
  PROVIDER_LABELS,
  bookingHref,
  cardText,
  labelOf,
} from "@/app/(console)/bookings/[bookingId]/sections";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  dayStartIn,
  formatInstant,
  isCalendarDay,
  queryOf,
} from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { Money } from "@/components/money";
import { STATUS_LABELS, StatusBadge } from "@/components/status-badge";
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

export const metadata: Metadata = { title: "Payments" };

const PAGE_STRINGS = Object.freeze({
  title: "Payments",
  intro: (environment: string) =>
    `Every payment of this OTA in the ${environment} environment, newest first: Stripe payments and airline-card payments.`,
  filters: "Payment filters",
  apply: "Apply filters",
  clear: "Clear filters",
  any: "Any",
  selected: (count: number) => `${count} selected`,
  invalidTitle: "This link has filters the list cannot use",
  invalid: (labels: string) => `Not valid: ${labels}. Change them above, or clear the filters.`,
  unavailableTitle: "The payments could not be loaded",
  forbiddenTitle: "You cannot open the payments",
  retry: "Try again",
  noMatch: "No payment matches these filters.",
  noPayments: "No payments yet in this environment.",
  caption: "Payments",
  pages: "Pages",
  firstPage: "First page",
  nextPage: "Next page",
  noBooking: "No booking yet",
  captured: "Captured",
  refunded: "Refunded",
  columns: {
    payment: "Payment",
    created: "Created",
    booking: "Booking",
    means: "Provider and method",
    status: "Status",
    amount: "Amount",
  },
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const FIELD_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const PAGE_LINK_CLASS =
  "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";
const MUTED = "text-xs text-muted-foreground";

/** The route of the list. */
const PAYMENTS_PATH = "/payments";
/** The permission of the list (scope §1.3: every role). */
const READ_PERMISSION = "payments:read";
/** The cursor's query parameter. */
const CURSOR_PARAM = "cursor";
/** The page size's query parameter. */
const LIMIT_PARAM = "limit";
/** The longest cursor the page passes on; the API's cursors are far shorter. */
const MAX_CURSOR_LENGTH = 2048;

// ---- Values of the OTA document -------------------------------------------------------------------------------------

type PaymentStatus = Payment["status"];
type PaymentProvider = Payment["provider"];
type PaymentMethod = Payment["method"];

/** `true`, or the members of `All` that `Listed` misses (which `true` is not assignable to). */
type Complete<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : Exclude<All, Listed>;

/** `Payment.status`, in the order of the status machine (the badge's labels name every one). */
const STATUSES = Object.keys(STATUS_LABELS.paymentRecord) as PaymentStatus[];
/** `Payment.provider`: Stripe and the airline first, the providers of later milestones after them. */
const PROVIDERS = [
  "stripe",
  "airline",
  "adyen",
  "checkout_com",
  "paypal",
  "manual",
] as const satisfies readonly PaymentProvider[];
/** `Payment.method`: the storefront's methods first, then the ones staff record. */
const METHODS = [
  "card",
  "airline_card",
  "apple_pay",
  "google_pay",
  "paypal",
  "bank_transfer",
  "agency_credit",
  "cash",
] as const satisfies readonly PaymentMethod[];
// Compile-time completeness: a provider or method the document adds and these lists miss fails the type check.
const _providersComplete: Complete<PaymentProvider, (typeof PROVIDERS)[number]> = true;
const _methodsComplete: Complete<PaymentMethod, (typeof METHODS)[number]> = true;

// ---- The URL's filters -----------------------------------------------------------------------------------------------

/** One choice of a list filter. */
interface Choice {
  readonly value: string;
  readonly label: string;
}

/** A filter of several choices (OR-ed by the API). */
interface MultiFilter {
  readonly kind: "multi";
  readonly name: "status" | "provider" | "method";
  readonly label: string;
  readonly choices: readonly Choice[];
}

/** A filter of one value. */
interface SingleFilter {
  readonly kind: "booking" | "day";
  readonly name: "bookingId" | "createdFrom" | "createdTo";
  readonly label: string;
}

type PaymentFilter = MultiFilter | SingleFilter;

/** Every filter of the list, in the order of the form and of the URL. */
const FILTERS: readonly PaymentFilter[] = [
  {
    kind: "multi",
    name: "status",
    label: "Status",
    choices: STATUSES.map((value) => ({ value, label: STATUS_LABELS.paymentRecord[value] })),
  },
  {
    kind: "multi",
    name: "provider",
    label: "Provider",
    choices: PROVIDERS.map((value) => ({ value, label: labelOf(PROVIDER_LABELS, value) })),
  },
  {
    kind: "multi",
    name: "method",
    label: "Method",
    choices: METHODS.map((value) => ({ value, label: labelOf(METHOD_LABELS, value) })),
  },
  { kind: "booking", name: "bookingId", label: "Booking id" },
  { kind: "day", name: "createdFrom", label: "Created from" },
  { kind: "day", name: "createdTo", label: "Created to" },
];

const FILTER_NAMES: ReadonlySet<string> = new Set(FILTERS.map((filter) => filter.name));

/** The labels of the URL's parameters, for the notice of a link that is not valid. */
const PARAMETER_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(FILTERS.map((filter) => [filter.name, filter.label])),
  [CURSOR_PARAM]: "Page",
  [LIMIT_PARAM]: "Page size",
};

/** The filters of a URL, normalised: the multi filters' choices in the form's order, the single values trimmed. */
type FilterValues = Readonly<Partial<Record<PaymentFilter["name"], readonly string[]>>>;

/** What `listQueryOf` makes of a URL. */
interface ListQuery {
  readonly values: FilterValues;
  readonly params: ConsoleListPaymentsParams;
  /** The URL's parameters the API would refuse, by name; the page then sends nothing. */
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

/** One filter's values, normalised, or `undefined` when the API would refuse them. */
function checkFilter(filter: PaymentFilter, query: URLSearchParams): string[] | undefined {
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
  const valid = filter.kind === "booking" ? BOOKING_ID_PATTERN.test(first) : isCalendarDay(first);
  return valid ? [first] : undefined;
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

/**
 * The parameters of `console.payments.list` for the URL `query`: the filters (the created days as instants in the
 * OTA's time zone, `createdTo` up to the end of its day), the cursor and the page size (25 by default).
 */
function listQueryOf(query: URLSearchParams, timeZone: string): ListQuery {
  const invalid: string[] = [];
  const values: Partial<Record<PaymentFilter["name"], readonly string[]>> = {};
  for (const filter of FILTERS) {
    const checked = checkFilter(filter, query);
    if (checked === undefined) {
      invalid.push(filter.name);
    } else if (checked.length > 0) {
      values[filter.name] = checked;
    }
  }

  const params: ConsoleListPaymentsParams = { limit: DEFAULT_PAGE_SIZE };
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

  const status = values.status?.filter((value): value is PaymentStatus =>
    (STATUSES as readonly string[]).includes(value),
  );
  if (status !== undefined) {
    params.status = status;
  }
  const provider = values.provider?.filter((value): value is PaymentProvider =>
    (PROVIDERS as readonly string[]).includes(value),
  );
  if (provider !== undefined) {
    params.provider = provider;
  }
  const method = values.method?.filter((value): value is PaymentMethod =>
    (METHODS as readonly string[]).includes(value),
  );
  if (method !== undefined) {
    params.method = method;
  }
  const [bookingId] = values.bookingId ?? [];
  if (bookingId !== undefined) {
    params.bookingId = bookingId;
  }
  const [createdFrom] = values.createdFrom ?? [];
  if (createdFrom !== undefined) {
    params.createdFrom = dayStartIn(createdFrom, timeZone);
  }
  const [createdTo] = values.createdTo ?? [];
  if (createdTo !== undefined) {
    params.createdTo = dayStartIn(createdTo, timeZone, 1);
  }
  return { values, params, invalid };
}

/** The list has at least one filter. */
function hasFilters(values: FilterValues): boolean {
  return FILTERS.some((filter) => (values[filter.name] ?? []).length > 0);
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
  return text === "" ? PAYMENTS_PATH : `${PAYMENTS_PATH}?${text}`;
}

/** "Clear filters": the list without filters and cursor, and without a page size the API would refuse. */
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

// ---- The page -------------------------------------------------------------------------------------------------------

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

/** One field of the filter form, showing the URL's values. */
function FilterField({
  filter,
  values,
}: {
  readonly filter: PaymentFilter;
  readonly values: readonly string[];
}) {
  const id = `payments-filter-${filter.name}`;
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
              "flex min-w-40 cursor-pointer list-none items-center justify-between gap-2",
            )}
          >
            <span id={`${id}-summary`}>{choiceSummary(filter, values)}</span>
            <span aria-hidden="true" className="text-muted-foreground group-open:rotate-180">
              ▾
            </span>
          </summary>
          <fieldset className="absolute z-20 mt-1 grid min-w-56 gap-2 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
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
        type={filter.kind === "day" ? "date" : "text"}
        defaultValue={values[0] ?? ""}
        {...(filter.kind === "booking"
          ? { placeholder: "bkg_…", maxLength: 44, autoComplete: "off", spellCheck: false, className: "w-72" }
          : { className: "w-44" })}
      />
    </div>
  );
}

/** The filters: a GET form to this page, which reads it the same way with or without JavaScript. */
function PaymentFilters({
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
      action={PAYMENTS_PATH}
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
      </div>
      <PaymentFilters query={query} values={values} />
      {children}
    </div>
  );
}

/** The cells of one payment. */
function PaymentRow({ payment, timeZone }: { readonly payment: ConsolePayment; readonly timeZone: string }) {
  const card = cardText(payment);
  return (
    <TableRow>
      <TableCell>
        <Link
          href={`${PAYMENTS_PATH}/${encodeURIComponent(payment.id)}`}
          className="font-mono text-xs font-medium underline-offset-4 hover:underline focus-visible:underline"
        >
          {payment.id}
        </Link>
      </TableCell>
      <TableCell>
        <time dateTime={payment.createdAt}>{formatInstant(payment.createdAt, timeZone)}</time>
      </TableCell>
      <TableCell>
        {payment.booking === null ? (
          <span className="text-muted-foreground">{PAGE_STRINGS.noBooking}</span>
        ) : (
          <div className="grid justify-items-start gap-1">
            <Link
              href={bookingHref(payment.booking.id, { tab: "payments" })}
              prefetch={false}
              className="font-mono font-medium underline-offset-4 hover:underline focus-visible:underline"
            >
              {payment.booking.reference}
            </Link>
            <StatusBadge kind="booking" status={payment.booking.status} />
          </div>
        )}
      </TableCell>
      <TableCell>
        <div className="grid gap-0.5">
          <span>
            {labelOf(PROVIDER_LABELS, payment.provider)} · {labelOf(METHOD_LABELS, payment.method)}
          </span>
          {card === undefined ? null : <span className={MUTED}>{card}</span>}
        </div>
      </TableCell>
      <TableCell>
        <StatusBadge kind="paymentRecord" status={payment.status} />
      </TableCell>
      <TableCell>
        <div className="grid gap-0.5 text-right">
          <Money value={payment.amount} className="font-medium" />
          <span className={MUTED}>
            {PAGE_STRINGS.captured} <Money value={payment.amountCaptured} />
          </span>
          <span className={MUTED}>
            {PAGE_STRINGS.refunded} <Money value={payment.amountRefunded} />
          </span>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** The payments of one page, and the links to the next page and back to the first. */
function PaymentsTable({
  payments,
  timeZone,
  query,
  nextCursor,
  emptyMessage,
}: {
  readonly payments: readonly ConsolePayment[];
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
          {payments.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            payments.map((payment) => <PaymentRow key={payment.id} payment={payment} timeZone={timeZone} />)
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

export default async function PaymentsPage({
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

  let payments: ConsolePayment[];
  let nextCursor: string | null;
  try {
    const page = await request.console.payments.list(list.params);
    payments = page.data;
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
      <PaymentsTable
        payments={payments}
        timeZone={timeZone}
        query={query}
        nextCursor={nextCursor}
        emptyMessage={hasFilters(list.values) ? PAGE_STRINGS.noMatch : PAGE_STRINGS.noPayments}
      />
    </ListShell>
  );
}
