// `/pnr` (README §5, routes.md §4, console-operations flow §3 step 4, OAD-009): the PNR lookup and import. Staff enter a
// record locator; the page reads `console.bookings.findByRecordLocator({ reference })` (`bookings:read`: every role,
// lead decision of 2026-10-28 on OBE-064; an audited read, `pnr.lookup`, and an Amadeus call) and shows each matching
// order of the OTA's offices: its record locators, travellers, flights, tickets, last ticketing date, queuing office and
// net total, and its link to the OTA: the booking it already is (a link, with its status), or "Import as a booking"
// (import-dialog.tsx, `console.bookings.import`, `bookings:write`) with an idempotency key rendered here once per match
// and render. Staff with `amadeus:read` also get the verbatim order (already redacted by the API) in a JSON view, and,
// under a valid record locator whatever the lookup answered, the Advanced panel (advanced-panel.tsx, OAD-010): the raw
// `console.amadeus.getFlightOrderByReference` and `getFlightOrder` reads, each run by its button in a server action,
// never while this page renders.
//
// The URL is the state: `/pnr?recordLocator=L2P9XC` (the form is a plain GET form to this page, and an orphan PNR of
// a queue links here, queues/queue-views.tsx); `reference` is read too, the API's own name of the parameter. The value
// is put in the API's spelling (no spaces, capitals) and checked against `^[A-Z0-9]{5,8}$` first: a value the API would
// refuse is never sent, and the form says what is wrong.
//
// The answers of OBE-064 (backend README "Console: PNR lookup and import"):
//
//   `404 NOT_FOUND`            "No order with this record locator in your offices"
//   `403 OFFICE_NOT_ALLOWED`   "This order belongs to an office outside this OTA", explained: Amadeus has the order,
//                              but its owner office (or its queuing office, without an owner office) is not one of the
//                              OTA's offices, which the page lists; another OTA's order is never shown
//   a match with `bookingId`   the existing booking (a second import would answer `409 ORDER_ALREADY_IMPORTED`, which
//                              the dialog links too); `409 CONFLICT` for a deleted or disabled customer is the dialog's
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this lookup,
// an ended session to the portal (`redirectOnSessionError`), and every other API error renders the console's message
// for its code with the request id under the form, with "Try again".
import type { ConsoleStaffProfile, PnrLookupResult, PnrMatch } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { formatInstant, formatLocalTime } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { JsonView } from "@/components/json-view";
import { Money, type MoneyValue } from "@/components/money";
import { StatusBadge, toneClasses } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { can, type StaffEnvironment } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { cn } from "@/lib/utils";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import { AdvancedPanel } from "./advanced-panel";
import { ImportDialog } from "./import-dialog";
import {
  PNR_PATH,
  RECORD_LOCATOR_PARAM,
  RECORD_LOCATOR_PATTERN,
  REFERENCE_PARAM,
  bookingPath,
  normalizeRecordLocator,
  pnrHref,
} from "./import-rules";

export const metadata: Metadata = { title: "PNR lookup" };

const PAGE_STRINGS = Object.freeze({
  title: "PNR lookup",
  intro:
    "Find an Amadeus order by its record locator, also one made outside Velexis (a GDS terminal booking), and import it as a booking of this OTA.",
  audited: "Each lookup reads Amadeus and is recorded in the audit trail.",
  form: "Look up a record locator",
  label: "Record locator",
  hint: "5 to 8 letters and digits, as the GDS or the airline's confirmation shows it.",
  submit: "Look up",
  invalid: "Enter 5 to 8 letters and digits, like L2P9XC.",
  forbiddenTitle: "You cannot look up PNRs",
  unavailableTitle: "The lookup could not be made",
  retry: "Try again",
  noMatchTitle: "No match",
  noMatch: "No order with this record locator in your offices.",
  officeTitle: "This order belongs to an office outside this OTA",
  office:
    "Amadeus has an order with this record locator, but its owner office (or its queuing office, when it has no owner office) is not one of this OTA's Amadeus offices. Velexis shows and imports only the orders of the OTA's own offices.",
  offices: (offices: string) => `This OTA's offices: ${offices}.`,
  noOffices: "This OTA has no Amadeus office set up in this environment.",
  results: (reference: string, count: number) =>
    `${count} order${count === 1 ? "" : "s"} with record locator ${reference}`,
  retrievedAt: (at: string) => `Read from Amadeus at ${at}.`,
  warnings: "Amadeus warnings",
  order: "Amadeus order",
  attached: "Already a booking of this OTA:",
  noImport: "Importing an order needs the permission bookings:write.",
  notImportable: "This order cannot be imported.",
  recordLocators: "Record locators",
  primary: "primary",
  travelers: "Travellers",
  flights: "Flights",
  tickets: "Tickets",
  noTickets: "None issued",
  lastTicketingDate: "Last ticketing date",
  queuingOffice: "Queuing office",
  netTotal: "Net total",
  unknown: "Unknown",
  verbatim: "Amadeus order (verbatim, redacted by the API)",
  columns: {
    flight: "Flight",
    from: "From",
    to: "To",
    departure: "Departure (local)",
    status: "Status",
  },
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const MUTED = "text-sm text-muted-foreground";

/** The permission of the lookup (`x-permission` of consoleFindBookingByRecordLocator). */
const READ_PERMISSION = "bookings:read";
/** The permission of an import. */
const IMPORT_PERMISSION = "bookings:write";
/** The permission of the verbatim order and of the Advanced panel's raw reads (routes.md §4 "Advanced"). */
const RAW_PERMISSION = "amadeus:read";
/** The permission of the import dialog's customer search. */
const CUSTOMERS_PERMISSION = "customers:read";

type SearchParams = Record<string, string | string[] | undefined>;

/** The one value of a search parameter (the first of a repeated one). */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

/** The lookup's answer, or the API's refusal. */
type Lookup =
  | { readonly ok: true; readonly result: PnrLookupResult }
  | { readonly ok: false; readonly error: VelexisErrorLike };

async function lookUp(request: ConsoleRequest, reference: string, here: string): Promise<Lookup> {
  try {
    return { ok: true, result: await request.console.bookings.findByRecordLocator({ reference }) };
  } catch (error) {
    return { ok: false, error: await apiFailure(error, here) };
  }
}

// ---- Pieces ---------------------------------------------------------------------------------------------------------

/** The lookup form: a GET form to this page, so a lookup is a link (and works without JavaScript). */
function LookupForm({ value, error }: { readonly value: string; readonly error?: string | undefined }) {
  const describedBy = error === undefined ? "pnr-reference-hint" : "pnr-reference-hint pnr-reference-error";
  return (
    <form
      method="get"
      action={PNR_PATH}
      role="search"
      aria-label={PAGE_STRINGS.form}
      className="grid max-w-md gap-2"
    >
      <Label htmlFor="pnr-reference">{PAGE_STRINGS.label}</Label>
      <p id="pnr-reference-hint" className="text-xs text-muted-foreground">
        {PAGE_STRINGS.hint}
      </p>
      <div className="flex gap-2">
        <Input
          id="pnr-reference"
          name={RECORD_LOCATOR_PARAM}
          defaultValue={value}
          required
          maxLength={12}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono uppercase"
          aria-describedby={describedBy}
          {...(error === undefined ? {} : { "aria-invalid": true })}
        />
        <Button type="submit">{PAGE_STRINGS.submit}</Button>
      </div>
      {error === undefined ? null : (
        <p id="pnr-reference-error" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

/** The heading and the form, above whatever the page shows. */
function PnrShell({
  value,
  error,
  children,
}: {
  readonly value: string;
  readonly error?: string | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAGE_STRINGS.intro}</p>
        <p className={MUTED}>{PAGE_STRINGS.audited}</p>
      </div>
      <LookupForm value={value} error={error} />
      {children}
    </div>
  );
}

/** One fact: a label and its value. */
type Fact = readonly [label: string, value: ReactNode];

function Facts({ items }: { readonly items: readonly Fact[] }) {
  return (
    <dl className="grid grid-cols-[minmax(9rem,max-content)_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A traveller's name as a PNR writes it (`MOREAU/CLAIRE`), or "Unknown". */
function travelerName(first: string | null, last: string | null): string {
  const name = [last, first].filter((part): part is string => typeof part === "string" && part !== "");
  return name.length === 0 ? PAGE_STRINGS.unknown : name.join("/");
}

/** The currency of an order: its net total's, else the first offer's price's (the verbatim order's). */
function orderCurrency(match: PnrMatch): string | null {
  const currency =
    match.summary.grandTotal?.currency ??
    (match.amadeus as { flightOffers?: { price?: { currency?: unknown } }[] }).flightOffers?.[0]?.price
      ?.currency;
  return typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : null;
}

/** The flights of a match. */
function FlightsTable({ match }: { readonly match: PnrMatch }) {
  const columns = Object.values(PAGE_STRINGS.columns);
  return (
    <Table>
      <TableCaption className="sr-only">
        {PAGE_STRINGS.flights} {match.flightOrderId}
      </TableCaption>
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
        {match.summary.segments.map((segment) => (
          <TableRow key={segment.segmentId}>
            <TableCell className="font-mono">
              {segment.carrierCode} {segment.number}
            </TableCell>
            <TableCell>{segment.originCode}</TableCell>
            <TableCell>{segment.destinationCode}</TableCell>
            <TableCell>
              <time dateTime={segment.departureAt}>{formatLocalTime(segment.departureAt)}</time>
            </TableCell>
            <TableCell>{segment.bookingStatus ?? PAGE_STRINGS.unknown}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** What this OTA has of a match: its booking, or the import (for `bookings:write`). */
function MatchLink({
  match,
  reference,
  staff,
  environment,
}: {
  readonly match: PnrMatch;
  readonly reference: string;
  readonly staff: ConsoleStaffProfile;
  readonly environment: StaffEnvironment;
}) {
  if (match.bookingId !== null) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm" data-booking={match.bookingId}>
        <span>{PAGE_STRINGS.attached}</span>
        <Link
          href={bookingPath(match.bookingId)}
          prefetch={false}
          className="font-mono font-medium text-primary underline underline-offset-4"
        >
          {match.bookingReference ?? match.bookingId}
        </Link>
        {match.bookingStatus === null ? null : <StatusBadge kind="booking" status={match.bookingStatus} />}
      </p>
    );
  }
  if (!match.importable) {
    return <p className={MUTED}>{PAGE_STRINGS.notImportable}</p>;
  }
  if (!can(staff, IMPORT_PERMISSION)) {
    return <p className={MUTED}>{PAGE_STRINGS.noImport}</p>;
  }
  const net: MoneyValue | null = match.summary.grandTotal ?? null;
  return (
    <ImportDialog
      reference={reference}
      flightOrderId={match.flightOrderId}
      currency={orderCurrency(match)}
      net={net}
      environment={environment}
      idempotencyKey={crypto.randomUUID()}
      canSearchCustomers={can(staff, CUSTOMERS_PERMISSION)}
    />
  );
}

/** One matching order: its summary, its link to the OTA and, for `amadeus:read`, the verbatim order. */
function MatchCard({
  match,
  index,
  reference,
  staff,
  environment,
}: {
  readonly match: PnrMatch;
  readonly index: number;
  readonly reference: string;
  readonly staff: ConsoleStaffProfile;
  readonly environment: StaffEnvironment;
}) {
  const { summary } = match;
  const headingId = `pnr-match-${index}`;
  const facts: Fact[] = [
    [
      PAGE_STRINGS.recordLocators,
      <ul key="records" className="grid gap-0.5">
        {summary.recordLocators.map((record) => (
          <li key={`${record.originSystemCode}-${record.reference}`}>
            <span className="font-mono">{record.reference}</span> ({record.originSystemCode}
            {record.primary ? `, ${PAGE_STRINGS.primary}` : ""})
          </li>
        ))}
      </ul>,
    ],
    [
      PAGE_STRINGS.travelers,
      <ul key="travelers" className="grid gap-0.5">
        {summary.travelers.map((traveler) => (
          <li key={traveler.travelerId}>{travelerName(traveler.firstName, traveler.lastName)}</li>
        ))}
      </ul>,
    ],
    [
      PAGE_STRINGS.tickets,
      summary.ticketNumbers.length === 0 ? (
        <span className="text-muted-foreground">{PAGE_STRINGS.noTickets}</span>
      ) : (
        <span className="font-mono">{summary.ticketNumbers.join(", ")}</span>
      ),
    ],
    [PAGE_STRINGS.lastTicketingDate, summary.lastTicketingDate ?? PAGE_STRINGS.unknown],
    [PAGE_STRINGS.queuingOffice, summary.queuingOfficeId ?? PAGE_STRINGS.unknown],
    [
      PAGE_STRINGS.netTotal,
      summary.grandTotal === null ? PAGE_STRINGS.unknown : <Money value={summary.grandTotal} />,
    ],
  ];
  return (
    <section aria-labelledby={headingId} className="grid gap-4 rounded-xl border p-4 shadow-sm">
      <div className="grid gap-2">
        <h3 id={headingId} className="text-base font-semibold">
          {PAGE_STRINGS.order} <code className="font-mono text-sm break-all">{match.flightOrderId}</code>
        </h3>
        <MatchLink match={match} reference={reference} staff={staff} environment={environment} />
      </div>
      <Facts items={facts} />
      <div className="grid gap-2">
        <h4 className="text-sm font-medium">{PAGE_STRINGS.flights}</h4>
        <FlightsTable match={match} />
      </div>
      {can(staff, RAW_PERMISSION) ? <JsonView value={match.amadeus} label={PAGE_STRINGS.verbatim} /> : null}
    </section>
  );
}

/** The lookup's answer: the matches, the time of the read and Amadeus's warnings. */
function LookupResult({
  result,
  staff,
  environment,
}: {
  readonly result: PnrLookupResult;
  readonly staff: ConsoleStaffProfile;
  readonly environment: StaffEnvironment;
}) {
  const warnings = result.warnings
    .map((warning) => warning.detail ?? warning.title)
    .filter((text): text is string => typeof text === "string" && text !== "");
  return (
    <section aria-labelledby="pnr-results-heading" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="pnr-results-heading" className="text-xl font-semibold">
          {PAGE_STRINGS.results(result.reference, result.matches.length)}
        </h2>
        <p className={MUTED}>
          {PAGE_STRINGS.retrievedAt(formatInstant(result.retrievedAt, staff.tenant.timeZone))}
        </p>
      </div>
      {warnings.length === 0 ? null : (
        <div role="note" className={cn("grid gap-1 rounded-md px-3 py-2 text-sm", toneClasses("warning"))}>
          <p className="font-medium">{PAGE_STRINGS.warnings}</p>
          <ul className="list-disc pl-5">
            {/* By position: two warnings of a lookup may say the same. */}
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {result.matches.map((match, index) => (
        <MatchCard
          key={match.flightOrderId}
          match={match}
          index={index}
          reference={result.reference}
          staff={staff}
          environment={environment}
        />
      ))}
    </section>
  );
}

/** "No order with this record locator in your offices". */
function NoMatch() {
  return (
    <section role="status" aria-labelledby="pnr-no-match" className="grid max-w-xl gap-2">
      <h2 id="pnr-no-match" className="text-xl font-semibold">
        {PAGE_STRINGS.noMatchTitle}
      </h2>
      <p>{PAGE_STRINGS.noMatch}</p>
    </section>
  );
}

/** `403 OFFICE_NOT_ALLOWED`, explained with the OTA's offices. */
function OfficeNotAllowed({
  error,
  staff,
}: {
  readonly error: VelexisErrorLike;
  readonly staff: ConsoleStaffProfile;
}) {
  const offices = staff.tenant.supplier.officeIds;
  return (
    <ErrorState
      title={PAGE_STRINGS.officeTitle}
      description={{
        message: PAGE_STRINGS.office,
        ...(error.requestId === null || error.requestId === "" ? {} : { requestId: error.requestId }),
      }}
    >
      <p className={MUTED} data-offices="true">
        {offices.length === 0 ? PAGE_STRINGS.noOffices : PAGE_STRINGS.offices(offices.join(", "))}
      </p>
    </ErrorState>
  );
}

export default async function PnrPage({ searchParams }: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const query = await searchParams;
  const typed = firstOf(query[RECORD_LOCATOR_PARAM]) ?? firstOf(query[REFERENCE_PARAM]) ?? "";
  const reference = normalizeRecordLocator(typed);
  const valid = RECORD_LOCATOR_PATTERN.test(reference);
  // Where an expired session comes back to: this lookup.
  const here = valid ? pnrHref(reference) : PNR_PATH;

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

  if (reference === "") {
    return <PnrShell value="" />;
  }
  if (!valid) {
    // The API would refuse it (`400 VALIDATION_FAILED`): no request, the form says why.
    return <PnrShell value={typed.trim()} error={PAGE_STRINGS.invalid} />;
  }

  const lookup = await lookUp(request, reference, here);
  // The Advanced panel's raw reads (`amadeus:read`), under whatever the lookup answered: support may need Amadeus's own
  // answer most when the lookup found nothing or failed.
  const advanced = (flightOrderIds: readonly string[]) =>
    can(staff, RAW_PERMISSION) ? (
      <AdvancedPanel reference={reference} flightOrderIds={flightOrderIds} />
    ) : null;
  if (!lookup.ok) {
    const { error } = lookup;
    if (error.code === "NOT_FOUND") {
      return (
        <PnrShell value={reference}>
          <NoMatch />
          {advanced([])}
        </PnrShell>
      );
    }
    if (error.code === "OFFICE_NOT_ALLOWED") {
      return (
        <PnrShell value={reference}>
          <OfficeNotAllowed error={error} staff={staff} />
          {advanced([])}
        </PnrShell>
      );
    }
    return (
      <PnrShell value={reference}>
        <ErrorState title={PAGE_STRINGS.unavailableTitle} error={error}>
          {/* The same lookup again. */}
          <a href={here} className={LINK_CLASS}>
            {PAGE_STRINGS.retry}
          </a>
        </ErrorState>
        {advanced([])}
      </PnrShell>
    );
  }

  return (
    <PnrShell value={reference}>
      {lookup.result.matches.length === 0 ? (
        <NoMatch />
      ) : (
        <LookupResult result={lookup.result} staff={staff} environment={environment} />
      )}
      {advanced(lookup.result.matches.map((match) => match.flightOrderId))}
    </PnrShell>
  );
}
