// `/customers/[customerId]` (README §5, routes.md §8, OAD-012): one customer account of the OTA, read-only in the MVP
// (no edits, no GDPR export).
//
// - `console.customers.get({ customerId })` (`customers:read`, every role): the account as the customer sees it
//   (e-mail and its verification, pending address, phone, date of birth, marketing consent, terms, sign-in, sign-up),
//   the saved-traveller and active-session counts and the booking statistics of the environment of the switch. Opening
//   a customer is an audited read on the API's side (`staff_actions` `customer.view`, the GDPR access log), so the page
//   says so and reads the customer once per render.
// - `console.bookings.list({ customerId })` (`bookings:read`): every booking of the customer in the environment, as the
//   bookings list shows them (OAD-006's `BookingsTable` and `bookingRow`), newest first, with cursor paging: `cursor`
//   is the `page.nextCursor` of the previous page and `limit` the page size (25), the only parameters of this page's
//   URL. The bookings list itself filters by customer with `/bookings?customerId=<id>`, linked from here.
// - A deleted account is shown as the API returns it and nothing more: `status: deleted`, its placeholder address, no
//   name (the API's empty names: "Deleted account"), no phone, date of birth or pending address, its statistics and its
//   bookings, which the deletion keeps. Nothing is looked up elsewhere to fill the gaps.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this page
// (with its page of bookings), an ended session to the portal (`redirectOnSessionError`), an id that is not a customer
// id (never sent) and `404 NOT_FOUND` render the page's own "not found" state inside the shell, and every other API
// error renders the console's message for its code with the request id and "Try again". A failure of the bookings list
// is shown in its section; the account stays.
import type { ConsoleBookingSummary, ConsoleCustomer, ConsoleListBookingsParams } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookingsTable } from "@/app/(console)/bookings/bookings-table";
import {
  BOOKINGS_PATH,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  bookingRow,
  formatInstant,
  queryOf,
} from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { Money, type MoneyValue } from "@/components/money";
import { toneClasses, type StatusTone } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { cn } from "@/lib/utils";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

export const metadata: Metadata = { title: "Customer" };

const PAGE_STRINGS = Object.freeze({
  back: "All customers",
  retry: "Try again",
  unavailableTitle: "The customer could not be loaded",
  forbiddenTitle: "You cannot open customers",
  notFoundTitle: "Customer not found",
  notFound: "No customer account with this id in this OTA. The link may be wrong.",
  deleted: "Deleted account",
  noName: "No name given",
  deletedNotice:
    "This account was deleted. Its name, phone, date of birth and pending address are no longer shown; its bookings are kept.",
  audited: "Opening a customer is recorded in the staff actions (GDPR access log).",
  inBookingsList: "Open in the bookings list",
  account: "Account",
  statistics: "Statistics",
  statisticsIntro: (environment: string) =>
    `Bookings of this customer in the ${environment} environment; the account is shared by both environments.`,
  bookings: "Bookings",
  bookingsIntro: (environment: string) =>
    `Every booking of this customer in the ${environment} environment, newest first.`,
  noBookings: (environment: string) => `No bookings of this customer in the ${environment} environment.`,
  bookingsUnavailable: "The bookings could not be loaded",
  bookingsForbidden: "You cannot list bookings",
  invalidPageTitle: "This link has a page the list cannot use",
  invalidPage: (labels: string) => `Not valid: ${labels}.`,
  firstPage: "First page",
  none: "None",
  yes: "Yes",
  no: "No",
  consentGiven: "Given",
  consentNotGiven: "Not given",
  facts: {
    email: "E-mail",
    emailVerified: "E-mail verified",
    pendingEmail: "New e-mail awaiting confirmation",
    phone: "Phone",
    dateOfBirth: "Date of birth",
    marketing: "Marketing consent",
    terms: "Terms accepted",
    lastSignIn: "Last sign-in",
    signedUp: "Signed up",
    updated: "Last change",
    savedTravelers: "Saved travellers",
    activeSessions: "Active sessions",
    bookings: "Bookings",
    upcoming: "Upcoming trips",
    cancelled: "Cancelled bookings",
    totalSpent: "Total spent",
    totalRefunded: "Total refunded",
    lastBooking: "Last booking",
  },
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";

/** The list of customers. */
const CUSTOMERS_PATH = "/customers";
/** The permission of the page (scope §1.3: every role). */
const READ_PERMISSION = "customers:read";
/** The permission of the customer's bookings (every role). */
const BOOKINGS_PERMISSION = "bookings:read";
/** A customer id as the document's path parameter takes it. */
const CUSTOMER_ID_PATTERN = /^cus_[0-9A-Za-z]{12,40}$/;
/** The cursor's query parameter. */
const CURSOR_PARAM = "cursor";
/** The page size's query parameter. */
const LIMIT_PARAM = "limit";
/** The longest cursor the page passes on; the API's cursors are far shorter. */
const MAX_CURSOR_LENGTH = 2048;

type Customer = ConsoleCustomer["customer"];
type CustomerStatus = Customer["status"];
type Phone = NonNullable<Customer["phone"]>;

const STATUS_LABELS: Readonly<Record<CustomerStatus, string>> = {
  active: "Active",
  pending_verification: "Awaiting e-mail verification",
  disabled: "Disabled",
  deleted: "Deleted",
};
const STATUS_TONES: Readonly<Record<CustomerStatus, StatusTone>> = {
  active: "success",
  pending_verification: "info",
  disabled: "warning",
  deleted: "neutral",
};

const CONSENT_SOURCES: Readonly<Record<Customer["marketingConsent"]["source"], string>> = {
  sign_up: "at sign-up",
  account: "in the account",
  unsubscribe_link: "through an unsubscribe link",
  console: "by staff",
};

/** The URL of a customer's page, with its page of bookings. */
function customerHref(customerId: string, query: URLSearchParams = new URLSearchParams()): string {
  const path = `${CUSTOMERS_PATH}/${encodeURIComponent(customerId)}`;
  const text = query.toString();
  return text === "" ? path : `${path}?${text}`;
}

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

/** The refusal of a role without `permission`, in the console's words. */
function forbidden(permission: string): string {
  return errorMessage({
    code: "FORBIDDEN",
    status: 403,
    requestId: null,
    fieldErrors: [],
    retryable: false,
    details: { requiredPermission: permission },
  });
}

// ---- The page of bookings ---------------------------------------------------------------------------------------

/** What the URL asks of the bookings list: its parameters, or the names of those the API would refuse. */
type BookingsQuery =
  | { readonly ok: true; readonly params: ConsoleListBookingsParams; readonly paging: URLSearchParams }
  | { readonly ok: false; readonly invalid: readonly string[] };

/** The bookings of `customerId` for the URL `query`: the cursor and the page size (25 by default). */
function bookingsQueryOf(customerId: string, query: URLSearchParams): BookingsQuery {
  const values = (name: string) => query.getAll(name).filter((value) => value !== "");
  const invalid: string[] = [];
  const params: ConsoleListBookingsParams = { customerId, limit: DEFAULT_PAGE_SIZE };
  const paging = new URLSearchParams();
  const cursors = values(CURSOR_PARAM);
  const [cursor] = cursors;
  if (cursors.length > 1 || (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)) {
    invalid.push("Page");
  } else if (cursor !== undefined) {
    params.cursor = cursor;
    paging.set(CURSOR_PARAM, cursor);
  }
  const limits = values(LIMIT_PARAM);
  const [limitText] = limits;
  if (limitText !== undefined) {
    const limit = /^\d{1,3}$/.test(limitText) ? Number(limitText) : Number.NaN;
    if (limits.length > 1 || !(limit >= 1 && limit <= MAX_PAGE_SIZE)) {
      invalid.push("Page size");
    } else {
      params.limit = limit;
      paging.set(LIMIT_PARAM, String(limit));
    }
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, params, paging };
}

/** The customer's bookings as the page loaded them. */
type BookingsView =
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid"; readonly labels: readonly string[] }
  | { readonly kind: "failed"; readonly error: VelexisErrorLike }
  | {
      readonly kind: "loaded";
      readonly bookings: readonly ConsoleBookingSummary[];
      readonly nextCursor: string | null;
      readonly totalCount?: number | null;
    };

// ---- Small pieces -----------------------------------------------------------------------------------------------

/** A customer's name: the given and family names, or none (a deleted account's are empty). */
function nameOf(customer: Customer): string | undefined {
  const name = [customer.firstName, customer.lastName]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" ");
  return name === "" ? undefined : name;
}

/** A phone as one line: `+46 701234567 (mobile)`. */
function phoneText(phone: Phone): string | undefined {
  const code = phone.countryCallingCode?.replace(/^\+/, "");
  const number = [code === undefined || code === "" ? "" : `+${code}`, phone.number ?? ""]
    .filter((part) => part !== "")
    .join(" ");
  if (number === "") {
    return undefined;
  }
  return phone.deviceType === undefined ? number : `${number} (${phone.deviceType.toLowerCase()})`;
}

/** An instant in the OTA's time zone, or nothing. */
function instant(value: string | null | undefined, timeZone: string): ReactNode {
  return value === null || value === undefined || value === "" ? null : (
    <time dateTime={value}>{formatInstant(value, timeZone)}</time>
  );
}

/** An amount, or nothing. */
function money(value: MoneyValue | null): ReactNode {
  return value === null ? null : <Money value={value} />;
}

/** A value with nothing to show. */
function isBlank(value: ReactNode): boolean {
  return value === null || value === undefined || value === "";
}

/** One fact: a label and its value ("None" when it has none). */
type Fact = readonly [label: string, value: ReactNode];

/** Facts as a description list. */
function Facts({ items }: { readonly items: readonly Fact[] }) {
  return (
    <dl className="grid grid-cols-[minmax(9rem,max-content)_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{isBlank(value) ? PAGE_STRINGS.none : value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A heading, an optional description and the content, as one region named by its heading. */
function Section({
  id,
  title,
  description,
  children,
  className,
}: {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn("grid content-start gap-3 rounded-lg border p-4", className)}
    >
      <div className="grid gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        {description === undefined ? null : <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The page's "not found" state, with the way back to the list. */
function NotFound() {
  return (
    <ErrorState title={PAGE_STRINGS.notFoundTitle} description={{ message: PAGE_STRINGS.notFound }}>
      <Link href={CUSTOMERS_PATH} className={LINK_CLASS}>
        {PAGE_STRINGS.back}
      </Link>
    </ErrorState>
  );
}

// ---- Sections ---------------------------------------------------------------------------------------------------

function Header({ customer }: { readonly customer: Customer }) {
  const deleted = customer.status === "deleted";
  const tone = STATUS_TONES[customer.status] ?? "neutral";
  return (
    <div className="grid gap-2">
      <Link href={CUSTOMERS_PATH} className={cn(LINK_CLASS, "justify-self-start")}>
        {PAGE_STRINGS.back}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {deleted ? PAGE_STRINGS.deleted : (nameOf(customer) ?? PAGE_STRINGS.noName)}
        </h1>
        <Badge variant="outline" data-status={customer.status} data-tone={tone} className={toneClasses(tone)}>
          {STATUS_LABELS[customer.status] ?? customer.status}
        </Badge>
      </div>
      <code className="text-xs text-muted-foreground">{customer.id}</code>
      {deleted ? (
        <p role="note" className={cn("rounded-md px-3 py-2 text-sm", toneClasses("neutral"))}>
          {PAGE_STRINGS.deletedNotice}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{PAGE_STRINGS.audited}</p>
    </div>
  );
}

function AccountSection({
  result,
  timeZone,
}: {
  readonly result: ConsoleCustomer;
  readonly timeZone: string;
}) {
  const { customer } = result;
  const consent = customer.marketingConsent;
  return (
    <Section id="customer-account" title={PAGE_STRINGS.account}>
      <Facts
        items={[
          [PAGE_STRINGS.facts.email, <span className="break-all">{customer.email}</span>],
          [
            PAGE_STRINGS.facts.emailVerified,
            customer.emailVerified ? (
              <>
                {PAGE_STRINGS.yes}
                {customer.emailVerifiedAt === null ? null : (
                  <>, {instant(customer.emailVerifiedAt, timeZone)}</>
                )}
              </>
            ) : (
              PAGE_STRINGS.no
            ),
          ],
          [PAGE_STRINGS.facts.pendingEmail, customer.pendingEmail],
          [PAGE_STRINGS.facts.phone, customer.phone === null ? null : phoneText(customer.phone)],
          [PAGE_STRINGS.facts.dateOfBirth, customer.dateOfBirth],
          [
            PAGE_STRINGS.facts.marketing,
            <>
              {consent.granted ? PAGE_STRINGS.consentGiven : PAGE_STRINGS.consentNotGiven}{" "}
              {CONSENT_SOURCES[consent.source] ?? consent.source}, {instant(consent.updatedAt, timeZone)}
            </>,
          ],
          [PAGE_STRINGS.facts.terms, customer.termsAcceptedVersion ?? null],
          [PAGE_STRINGS.facts.lastSignIn, instant(customer.lastSignInAt, timeZone)],
          [PAGE_STRINGS.facts.signedUp, instant(customer.createdAt, timeZone)],
          [PAGE_STRINGS.facts.updated, instant(customer.updatedAt, timeZone)],
          [PAGE_STRINGS.facts.savedTravelers, String(result.savedTravelersCount)],
          [PAGE_STRINGS.facts.activeSessions, String(result.activeSessionsCount)],
        ]}
      />
    </Section>
  );
}

function StatisticsSection({
  result,
  environment,
  timeZone,
}: {
  readonly result: ConsoleCustomer;
  readonly environment: string;
  readonly timeZone: string;
}) {
  const { stats } = result;
  return (
    <Section
      id="customer-statistics"
      title={PAGE_STRINGS.statistics}
      description={PAGE_STRINGS.statisticsIntro(environment)}
    >
      <Facts
        items={[
          [PAGE_STRINGS.facts.bookings, String(stats.bookingsCount)],
          [PAGE_STRINGS.facts.upcoming, String(stats.upcomingBookingsCount)],
          [PAGE_STRINGS.facts.cancelled, String(stats.cancelledBookingsCount)],
          [PAGE_STRINGS.facts.totalSpent, money(stats.totalSpent)],
          [PAGE_STRINGS.facts.totalRefunded, money(stats.totalRefunded)],
          [PAGE_STRINGS.facts.lastBooking, instant(stats.lastBookingAt, timeZone)],
        ]}
      />
    </Section>
  );
}

function BookingsSection({
  customerId,
  view,
  environment,
  timeZone,
  here,
}: {
  readonly customerId: string;
  readonly view: BookingsView;
  readonly environment: string;
  readonly timeZone: string;
  readonly here: string;
}) {
  let content: ReactNode;
  switch (view.kind) {
    case "forbidden":
      content = (
        <ErrorState
          title={PAGE_STRINGS.bookingsForbidden}
          description={{ message: forbidden(BOOKINGS_PERMISSION) }}
        />
      );
      break;
    case "invalid":
      content = (
        <section role="alert" className="grid max-w-xl gap-3">
          <h3 className="font-semibold">{PAGE_STRINGS.invalidPageTitle}</h3>
          <p>{PAGE_STRINGS.invalidPage(view.labels.join(", "))}</p>
          <Link href={customerHref(customerId)} className={LINK_CLASS}>
            {PAGE_STRINGS.firstPage}
          </Link>
        </section>
      );
      break;
    case "failed":
      content = (
        <ErrorState title={PAGE_STRINGS.bookingsUnavailable} error={view.error}>
          {/* The same URL again: the customer and the bookings are read anew. */}
          <a href={here} className={LINK_CLASS}>
            {PAGE_STRINGS.retry}
          </a>
        </ErrorState>
      );
      break;
    case "loaded":
      content = (
        <BookingsTable
          rows={view.bookings.map((summary) => bookingRow(summary, timeZone))}
          page={{ nextCursor: view.nextCursor }}
          emptyMessage={PAGE_STRINGS.noBookings(environment)}
          {...(view.totalCount === undefined ? {} : { totalCount: view.totalCount })}
        />
      );
      break;
  }
  return (
    <Section
      id="customer-bookings"
      title={PAGE_STRINGS.bookings}
      description={PAGE_STRINGS.bookingsIntro(environment)}
    >
      {view.kind === "forbidden" ? null : (
        <Link
          href={`${BOOKINGS_PATH}?${new URLSearchParams({ customerId }).toString()}`}
          className={cn(LINK_CLASS, "justify-self-start")}
        >
          {PAGE_STRINGS.inBookingsList}
        </Link>
      )}
      {content}
    </Section>
  );
}

// ---- The page ---------------------------------------------------------------------------------------------------

export default async function CustomerPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ customerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { customerId } = await params;
  const query = queryOf(await searchParams);
  const bookingsQuery = bookingsQueryOf(customerId, query);
  // Where an expired session comes back to: this customer and its page of bookings.
  const here = customerHref(customerId, bookingsQuery.ok ? bookingsQuery.paging : undefined);

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff, environment } = request;
  const timeZone = staff.tenant.timeZone;

  if (!can(staff, READ_PERMISSION)) {
    return (
      <ErrorState title={PAGE_STRINGS.forbiddenTitle} description={{ message: forbidden(READ_PERMISSION) }} />
    );
  }
  if (!CUSTOMER_ID_PATTERN.test(customerId)) {
    // The API would refuse it (`400 VALIDATION_FAILED`): no request.
    return <NotFound />;
  }

  let result: ConsoleCustomer;
  try {
    result = await request.console.customers.get({ customerId });
  } catch (error) {
    const failure = await apiFailure(error, here);
    if (failure.code === "NOT_FOUND") {
      return <NotFound />;
    }
    return (
      <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
        <a href={here} className={LINK_CLASS}>
          {PAGE_STRINGS.retry}
        </a>
        <Link href={CUSTOMERS_PATH} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
      </ErrorState>
    );
  }

  let bookings: BookingsView;
  if (!can(staff, BOOKINGS_PERMISSION)) {
    bookings = { kind: "forbidden" };
  } else if (!bookingsQuery.ok) {
    bookings = { kind: "invalid", labels: bookingsQuery.invalid };
  } else {
    try {
      const page = await request.console.bookings.list(bookingsQuery.params);
      bookings = {
        kind: "loaded",
        bookings: page.data,
        nextCursor: page.page.nextCursor,
        ...(page.totalCount === undefined ? {} : { totalCount: page.totalCount }),
      };
    } catch (error) {
      bookings = { kind: "failed", error: await apiFailure(error, here) };
    }
  }

  return (
    <div className="grid gap-6">
      <Header customer={result.customer} />
      <div className="grid gap-6 lg:grid-cols-2">
        <AccountSection result={result} timeZone={timeZone} />
        <StatisticsSection result={result} environment={environment} timeZone={timeZone} />
      </div>
      <BookingsSection
        customerId={customerId}
        view={bookings}
        environment={environment}
        timeZone={timeZone}
        here={here}
      />
    </div>
  );
}
