// The sections of a booking's detail page `/bookings/[bookingId]` (routes.md §3.2, README §9, OAD-007): what staff see
// of one booking, tab by tab, from the answers the page's server component loaded. The page (page.tsx) makes every SDK
// call; these components only render what they are given, so they are server components without state, data fetching
// or hooks, and none of their props crosses into the browser (only the HTML they render does).
//
//   Overview                `console.bookings.get`: the states that need staff (below), the booking's facts, the
//                           itinerary, ticketing, the pricing with its net and markup lines, the payment summary, the
//                           cancellation and both its `canCancel`s (FIX-W28-CANCEL), the supplier sync with the last
//                           Amadeus calls, and the console actions the caller may take now with the reasons of the others
//   Travellers and contacts `get`: travellers (identity documents, discount card numbers and the forms of
//                           identification cut to their last 4 here, whatever the API sends), contacts, every remark,
//                           the ticketing agreement, automated processes
//   Amadeus order           `console.bookings.retrieve`, only when this tab is opened (the page calls it then and
//                           never otherwise): the verbatim, redacted Flight Order with net prices and the full documents,
//                           an audited Amadeus call (`order.retrieve`)
//   Tickets and documents   `get`: tickets per traveller and segment, booking documents, services
//   Payments                `console.payments.get` per payment (`payments:read`): events, refunds, the airline card's
//                           rules; the forms of payment of the order (brand and last 4 only)
//   Timeline and notes      `get`: staff notes and every booking event, the internal ones marked
//   Staff actions           `get`: the last 20 staff actions on the booking (`recentStaffActions`)
//
// The tab is a search parameter (`?tab=`), so each tab is a link that works without JavaScript and loads only its own
// data; the links never prefetch, because opening the Amadeus order calls Amadeus.
//
// What needs staff (routes.md §3.2 "State") is listed above the tabs: a booking whose outcome is unknown (`pending`)
// with the time the reconciliation decides by, a reconciliation handed to the staff, ticketing in manual review or
// failed with its reason and deadline, an airline-card booking left without tickets, a cancellation that waits for the
// staff, a schedule change and a lost or failed sync. ConsoleBooking has no reconciliation fields, so the page reads
// them from the booking's events (newest first in the API's answer, compared by time here): the `reconcileUntil` of
// `booking.supplier_timeout` and `booking.reconcile_adopted`, and `booking.reconcile_manual_review`; the ticketing
// reason is the summary of the newest `booking.ticketing_failed` or `booking.ticketing_manual_review` event.
//
// Card data: no form of payment shows more than its brand and last 4 digits (no holder, no expiry: lead decision (1) of
// 2026-10-24), and the airline card is never offered again (OADR-0018, OADR-0004).
import type {
  ConsoleBooking,
  ConsoleBookingEvent,
  ConsoleFlightOrderRetrieval,
  ConsolePayment,
  ConsoleStaffAction,
} from "@velexis/ota-sdk";
import Link from "next/link";
import type { ReactNode } from "react";

import { BOOKINGS_PATH, formatInstant, formatLocalTime } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { JsonView } from "@/components/json-view";
import { Money, type MoneyValue } from "@/components/money";
import { StatusBadge, toneClasses, type StatusTone } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { errorMessage, type VelexisErrorLike } from "@/lib/errors";
import type { StaffEnvironment } from "@/lib/permissions";
import { cn } from "@/lib/utils";

// ---- Types of the answers -------------------------------------------------------------------------------------------

type Traveler = ConsoleBooking["travelers"][number];
type TravelerDocument = NonNullable<Traveler["documents"]>[number];
type Discount = NonNullable<Traveler["discountEligibility"]>[number];
type Contact = ConsoleBooking["contacts"][number];
type Phone = NonNullable<Contact["phones"]>[number];
type Remark = ConsoleBooking["remarks"][number];
type Ticket = ConsoleBooking["tickets"][number];
type BookingDocument = NonNullable<ConsoleBooking["documents"]>[number];
type Ancillary = ConsoleBooking["ancillaries"][number];
type BookingPayment = ConsoleBooking["payments"][number];
type BookingRefund = ConsoleBooking["refunds"][number];
type Itinerary = ConsoleBooking["itineraries"][number];
type Segment = Itinerary["segments"][number];
type FormOfPayment = ConsoleBooking["formOfPayments"][number];
type FormOfIdentification = ConsoleBooking["formOfIdentifications"][number];
type SupplierRequest = ConsoleBooking["recentSupplierRequests"][number];
type Actor = ConsoleBookingEvent["actor"];
type PaymentEvent = ConsolePayment["events"][number];
type PaymentRefund = ConsolePayment["refunds"][number];

/** An Amadeus issue of a supplier error (`error.supplier`), as far as the page shows it. */
export interface SupplierIssueLike {
  readonly code?: number | undefined;
  readonly title?: string | undefined;
}

/** One payment of the booking in the Payments tab: `console.payments.get`'s answer, or why it could not be read. */
export interface PaymentDetail {
  readonly id: string;
  readonly payment?: ConsolePayment;
  readonly error?: VelexisErrorLike;
}

/** What the Payments tab shows: the payments read one by one, or the booking's summary without `payments:read`. */
export type PaymentsView =
  { readonly permitted: true; readonly details: readonly PaymentDetail[] } | { readonly permitted: false };

/** The Amadeus order view: not offered for this booking, read, or refused. */
export type OrderView =
  | { readonly state: "unavailable"; readonly reason: string | undefined }
  | { readonly state: "loaded"; readonly retrieval: ConsoleFlightOrderRetrieval }
  | { readonly state: "failed"; readonly error: VelexisErrorLike; readonly supplier?: SupplierIssueLike };

/** The outcome of a "Sync from Amadeus" (`console.bookings.get` with `refresh: true`). */
export type RefreshOutcome =
  | { readonly ok: true }
  /** The refresh failed at Amadeus; the page shows the booking read again without it. */
  | { readonly ok: false; readonly error: VelexisErrorLike };

// ---- Tabs and links -----------------------------------------------------------------------------------------------

/** The tabs of the page, in their order (routes.md §3.2). */
export const BOOKING_TABS = [
  { id: "overview", label: "Overview" },
  { id: "travellers", label: "Travellers and contacts" },
  { id: "amadeus-order", label: "Amadeus order" },
  { id: "tickets", label: "Tickets and documents" },
  { id: "payments", label: "Payments" },
  { id: "timeline", label: "Timeline and notes" },
  { id: "staff-actions", label: "Staff actions" },
] as const;

/** A tab of the page. */
export type BookingTab = (typeof BOOKING_TABS)[number]["id"];

/** The tab of a page without `?tab=`. */
export const DEFAULT_TAB: BookingTab = "overview";
/** The tab's search parameter. */
export const TAB_PARAM = "tab";
/** The search parameter of "Sync from Amadeus" (`refresh=1`). */
export const REFRESH_PARAM = "refresh";

/** A booking id as the API writes it (`ConsoleBooking.id`). */
export const BOOKING_ID_PATTERN = /^bkg_[0-9A-Za-z]{16,40}$/;

/** The tab a search parameter names; the overview for anything else (a missing, repeated or unknown value). */
export function tabOf(value: string | readonly string[] | undefined): BookingTab {
  const tab = BOOKING_TABS.find((candidate) => candidate.id === value);
  return tab?.id ?? DEFAULT_TAB;
}

/** The URL of a booking's page: its tab (none for the overview) and, for "Sync from Amadeus", `refresh=1`. */
export function bookingHref(
  bookingId: string,
  options: { readonly tab?: BookingTab; readonly refresh?: boolean } = {},
): string {
  const query = new URLSearchParams();
  if (options.tab !== undefined && options.tab !== DEFAULT_TAB) {
    query.set(TAB_PARAM, options.tab);
  }
  if (options.refresh === true) {
    query.set(REFRESH_PARAM, "1");
  }
  const path = `${BOOKINGS_PATH}/${encodeURIComponent(bookingId)}`;
  const text = query.toString();
  return text === "" ? path : `${path}?${text}`;
}

// ---- Words --------------------------------------------------------------------------------------------------------

export const DETAIL_STRINGS = Object.freeze({
  back: "All bookings",
  title: "Booking",
  tabs: "Booking sections",
  none: "None",
  yes: "Yes",
  no: "No",
  internal: "Internal",
  visibleToCustomer: "Visible to the customer",
  guest: "Guest booking",
  attention: "Needs attention",
  sync: "Sync from Amadeus",
  synced: "Synchronised with Amadeus just now.",
  syncThrottled: "Synchronised with Amadeus moments ago: this is the data of that sync.",
  syncOrderNotFound: "Amadeus no longer has this order.",
  syncFailed: "The sync with Amadeus failed, so this is the stored booking.",
  syncNothing: "Nothing was synchronised: the booking has no Amadeus order to read, or it is cancelled.",
  version: "Version",
  recordLocator: "Record locator",
  noRecordLocator: "None yet",
  amadeusOrder: "Amadeus order",
  // Overview
  facts: "Booking",
  itinerary: "Itinerary",
  ticketing: "Ticketing",
  pricing: "Pricing",
  pricingDescription: "Net cost from Amadeus, the OTA's markup and fees, and the selling total.",
  paymentSummary: "Payment",
  cancellation: "Cancellation",
  supplierSync: "Supplier sync",
  recentCalls: "Recent Amadeus calls",
  consoleActions: "What you can do now",
  fareConditions: "Fare conditions",
  failure: "Failure",
  warnings: "Amadeus warnings",
  // Travellers
  travelers: "Travellers",
  contacts: "Contacts",
  remarks: "Remarks",
  agreement: "Ticketing agreement",
  automatedProcess: "Automated processes",
  otherElements: "Commissions and forms of identification",
  documentsMasked:
    "Identity document, card and identification numbers show their last 4 characters only; the Amadeus order has them in full.",
  // Amadeus order
  orderTitle: "Amadeus order",
  orderIntro:
    "Read from Amadeus when this tab opens (Flight Order Management GET): the verbatim order with net prices and the travellers' full documents. Each read is recorded in the staff actions and refreshes the stored order.",
  orderData: "Flight order",
  orderIncluded: "Included (bag options)",
  orderDictionaries: "Dictionaries",
  orderFailed: "The Amadeus order could not be read",
  orderAgain: "Read again",
  // Tickets
  tickets: "Tickets",
  documents: "Documents",
  services: "Services",
  noTickets: "No tickets issued.",
  noDocuments: "No documents yet.",
  noServices: "No services booked.",
  // Payments
  payments: "Payments",
  formsOfPayment: "Forms of payment on the Amadeus order",
  noPayments: "No payments.",
  noFormsOfPayment: "None recorded.",
  paymentEvents: "Events",
  paymentRefunds: "Refunds",
  noRefunds: "No refunds.",
  paymentUnavailable: "This payment could not be loaded",
  paymentsPermission: "Needs the permission payments:read for the payments' events and refunds.",
  airlineCard:
    "Charged by the airline through Amadeus: the card cannot be charged again, and refunds go through the airline, not the console.",
  // Timeline
  notes: "Notes",
  events: "Timeline",
  noNotes: "No notes.",
  noEvents: "No events.",
  details: "Details",
  // Staff actions
  staffActions: "Staff actions",
  staffActionsDescription: "The last 20 staff actions on this booking.",
  noStaffActions: "No staff actions yet.",
});

const NONE = DETAIL_STRINGS.none;

/** `SOME_VALUE`, `some_value` or `some.value` in words: "Some value". */
export function humanize(value: string): string {
  const words = value
    .replaceAll(/[_.-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The label of `value` in `labels`, else the value in words. */
function labelOf(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : humanize(value);
}

const POLICY_LABELS: Readonly<Record<string, string>> = {
  issue_after_payment: "Issue after payment",
  issue_at_booking: "Issue at booking",
  manual_review: "Manual review",
};

const PRICING_MODE_LABELS: Readonly<Record<string, string>> = {
  markup_rules: "Markup rules",
  net: "Sold at net",
  override: "Selling price set by staff",
};

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  storefront: "Storefront",
  console: "Console",
  import: "Imported",
};

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  stripe: "Stripe",
  adyen: "Adyen",
  checkout_com: "Checkout.com",
  paypal: "PayPal",
  manual: "Recorded by staff",
  airline: "Airline",
};

const METHOD_LABELS: Readonly<Record<string, string>> = {
  card: "Card",
  airline_card: "Airline card",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  paypal: "PayPal",
  bank_transfer: "Bank transfer",
  agency_credit: "Agency credit",
  cash: "Cash",
};

const CANCELLATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  cancelled: "Cancelled",
  pending: "Requested, not completed",
};

const REFUND_STATUS_LABELS: Readonly<Record<string, string>> = {
  not_applicable: "Nothing to refund",
  authorization_voided: "Authorisation voided",
  pending: "Pending",
  processing: "Processing",
  succeeded: "Succeeded",
  failed: "Failed",
  manual_review: "Needs staff review",
  cancelled: "Withdrawn",
};

const REFUND_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  not_applicable: "neutral",
  authorization_voided: "neutral",
  pending: "info",
  processing: "info",
  succeeded: "success",
  failed: "danger",
  manual_review: "warning",
  cancelled: "neutral",
};

const DOCUMENT_KIND_LABELS: Readonly<Record<string, string>> = {
  e_ticket_receipt: "E-ticket receipt",
  emd_receipt: "EMD receipt",
  itinerary: "Itinerary",
  invoice: "Invoice",
  credit_note: "Credit note",
};

/** The name of a bound: outbound and return of a round trip, else by its number. */
function itineraryLabel(tripType: string, index: number): string {
  if (tripType === "round_trip") {
    return index === 0 ? "Outbound" : "Return";
  }
  return tripType === "one_way" && index === 0 ? "Outbound" : `Flight ${index + 1}`;
}

const OUTCOME_TONES: Readonly<Record<string, StatusTone>> = {
  succeeded: "success",
  failed: "danger",
  denied: "warning",
  success: "success",
  client_error: "warning",
  server_error: "danger",
  timeout: "danger",
  network_error: "danger",
};

/** The console actions of `consoleActions`, in the order staff read them. */
const CONSOLE_ACTIONS = [
  ["canIssue", "Issue tickets"],
  ["canPatch", "Edit travellers, contacts, remarks and the ticketing agreement"],
  ["canCancel", "Cancel the booking"],
  ["canResync", "Resync from Amadeus"],
  ["canRetrieve", "Open the Amadeus order"],
  ["canAddNote", "Add a note"],
] as const;

/** Why a console action is not available (`ConsoleBookingActions.reasons`). */
const CONSOLE_REASONS: Readonly<Record<string, string>> = {
  no_permission: "your role does not allow it",
  cancelled: "the booking is cancelled",
  failed: "the booking failed",
  pending: "the booking's outcome is not known yet",
  no_amadeus_order: "the booking has no Amadeus order",
  already_ticketed: "the tickets are issued",
  flown: "the trip has started or is over",
  deadline_passed: "the ticketing deadline has passed",
  throttled: "it was synchronised moments ago",
};

/** Why the customer cannot cancel themselves (`allowedActions.reasons`). */
const CUSTOMER_REASONS: Readonly<Record<string, string>> = {
  cancelled: "the booking is cancelled",
  failed: "the booking failed",
  pending: "the booking or an earlier cancellation waits for a decision",
  flown: "the trip has started or is over",
  too_close_to_departure: "it is less than 3 hours before departure",
  disabled_by_ota: "self-service cancellation is off in the storefront settings",
  ticketed_non_refundable: "the tickets are not refundable",
  not_ticketed: "the tickets are not issued",
  throttled: "it was synchronised moments ago",
  not_offered_by_airline: "the airline does not offer it",
};

// ---- Small pieces -------------------------------------------------------------------------------------------------

/** A value with nothing to show. */
function isBlank(value: ReactNode): boolean {
  return value === null || value === undefined || value === "" || value === false;
}

/** An instant in the OTA's time zone, or `null`. */
function instant(value: string | null | undefined, timeZone: string): ReactNode {
  return value === null || value === undefined || value === "" ? null : (
    <time dateTime={value}>{formatInstant(value, timeZone)}</time>
  );
}

/** A local date and time of an airport, or `null`. */
function localTime(value: string | null | undefined): ReactNode {
  return value === null || value === undefined || value === "" ? null : (
    <time dateTime={value}>{formatLocalTime(value)}</time>
  );
}

/** An amount, or `null`. */
function money(value: MoneyValue | null | undefined): ReactNode {
  return value === null || value === undefined ? null : <Money value={value} />;
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return NONE;
  }
  return value ? DETAIL_STRINGS.yes : DETAIL_STRINGS.no;
}

/** A label in words with a matching colour, for values the shared status badges do not cover. */
function Pill({ tone, children }: { readonly tone: StatusTone; readonly children: ReactNode }) {
  return (
    <Badge variant="outline" data-tone={tone} className={toneClasses(tone)}>
      {children}
    </Badge>
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

/** One fact: a label and its value (`None` when it has none). */
type Fact = readonly [label: string, value: ReactNode];

/** Facts as a description list. */
function Facts({ items }: { readonly items: readonly Fact[] }) {
  return (
    <dl className="grid grid-cols-[minmax(9rem,max-content)_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{isBlank(value) ? NONE : value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A plain table with a caption, header cells and rows of cells. */
function SimpleTable({
  caption,
  columns,
  rows,
  empty,
}: {
  readonly caption: string;
  readonly columns: readonly string[];
  readonly rows: readonly { readonly key: string; readonly cells: readonly ReactNode[] }[];
  readonly empty: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b">
            {columns.map((column) => (
              <th key={column} scope="col" className="px-2 py-1.5 font-medium text-muted-foreground">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b align-top last:border-b-0">
              {row.cells.map((cell, index) => (
                <td key={columns[index] ?? index} className="px-2 py-1.5">
                  {isBlank(cell) ? NONE : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MASK = "•••••";

/** The last 4 characters of an identity document or card number behind a mask; never more of it. */
export function maskedNumber(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }
  return `${MASK}${value.trim().slice(-4)}`;
}

/** An identity document's number as the travellers tab shows it: its last 4 characters only. */
function documentNumber(document: TravelerDocument): string | undefined {
  return maskedNumber(document.numberMasked ?? document.number);
}

/**
 * A form of identification of the order as the travellers tab shows it: its number (a passport, identity card or
 * driving licence number) cut to its last 4 characters, whatever the API sends, as the travellers' documents are.
 */
function maskedIdentification(identification: FormOfIdentification): FormOfIdentification {
  const { number, ...rest } = identification;
  const masked = maskedNumber(number);
  return masked === undefined ? rest : { ...rest, number: masked };
}

/** A name as Amadeus holds it ("ANNA BERG"), or `undefined`. */
function fullName(
  name:
    | { readonly firstName?: string; readonly middleName?: string; readonly lastName?: string }
    | null
    | undefined,
): string | undefined {
  if (name === null || name === undefined) {
    return undefined;
  }
  const text = [name.firstName, name.middleName, name.lastName]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return text === "" ? undefined : text;
}

/** The owning customer as one line: `Anna Berg <anna.berg@example.com>`, the address alone without a name. */
function customerText(customer: NonNullable<ConsoleBooking["customer"]>): string {
  const name = [customer.firstName, customer.lastName]
    .filter((part): part is string => part !== null && part !== "")
    .join(" ");
  return name === "" ? customer.email : `${name} <${customer.email}>`;
}

/** A phone as one line: `+46 701234567 (mobile)`. */
function phoneText(phone: Phone): string {
  const number = [
    phone.countryCallingCode === undefined ? "" : `+${phone.countryCallingCode}`,
    phone.number ?? "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  return phone.deviceType === undefined ? number : `${number} (${phone.deviceType.toLowerCase()})`;
}

/** Who did something, in words: a name, else an e-mail address, else an id, else the kind of actor. */
function actorText(actor: Actor): string {
  const who = actor.name ?? actor.email ?? actor.id ?? humanize(actor.type);
  return actor.role === null || actor.role === undefined ? who : `${who} (${actor.role})`;
}

/** A status change: `confirmed → ticketed`. */
function statusChange(from: string | null, to: string | null): string | undefined {
  if (from === null && to === null) {
    return undefined;
  }
  if (from === null || from === to) {
    return to ?? undefined;
  }
  return `${from} → ${to ?? NONE}`;
}

/** A duration in minutes as hours and minutes. */
function duration(minutes: number | null | undefined): string | undefined {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return undefined;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest} min` : `${hours} h ${String(rest).padStart(2, "0")} min`;
}

/** A segment as one short line: `AF6 CDG → JFK`. */
function segmentText(segment: Segment): string {
  return `${segment.flightNumber} ${segment.departure.iataCode} → ${segment.arrival.iataCode}`;
}

/** The segments of the booking by Amadeus segment id. */
function segmentsById(booking: ConsoleBooking): ReadonlyMap<string, Segment> {
  return new Map(
    booking.itineraries.flatMap((itinerary) =>
      itinerary.segments.map((segment) => [segment.id, segment] as const),
    ),
  );
}

/** Segment ids as flights, an unknown id as it is. */
function segmentsText(ids: readonly string[], segments: ReadonlyMap<string, Segment>): string | undefined {
  if (ids.length === 0) {
    return undefined;
  }
  return ids
    .map((id) => {
      const segment = segments.get(id);
      return segment === undefined ? `Segment ${id}` : segmentText(segment);
    })
    .join(", ");
}

/** The travellers' names by Amadeus traveller id. */
function travelerNames(booking: ConsoleBooking): ReadonlyMap<string, string> {
  return new Map(
    booking.travelers.map((traveler) => [
      traveler.travelerId,
      fullName(traveler.name) ?? traveler.travelerId,
    ]),
  );
}

/** A JSON object with something in it. */
function hasEntries(value: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return value !== null && value !== undefined && Object.keys(value).length > 0;
}

// ---- What needs staff -----------------------------------------------------------------------------------------------

/** One state of the booking that needs staff (routes.md §3.2 "State"). */
export interface AttentionItem {
  readonly id:
    | "failed"
    | "reconciling"
    | "reconcile-review"
    | "airline-card"
    | "ticketing"
    | "cancellation"
    | "schedule-changed"
    | "sync";
  readonly tone: "warning" | "danger";
  readonly title: string;
  readonly detail?: string;
}

/** The events whose `data.reconcileUntil` says when the reconciliation decides. */
const RECONCILE_WINDOW_EVENTS: ReadonlySet<string> = new Set([
  "booking.supplier_timeout",
  "booking.reconcile_adopted",
]);
/** The event of a reconciliation handed to the staff (OADR-0003 point 5). */
const RECONCILE_REVIEW_EVENT = "booking.reconcile_manual_review";
/** The events that give a ticketing problem's reason. */
const TICKETING_PROBLEM_EVENTS: ReadonlySet<string> = new Set([
  "booking.ticketing_failed",
  "booking.ticketing_manual_review",
]);

/** The newest event matching `predicate` (by `createdAt`, whatever the order of the answer). */
function newestEvent(
  events: readonly ConsoleBookingEvent[],
  predicate: (event: ConsoleBookingEvent) => boolean,
): ConsoleBookingEvent | undefined {
  let newest: ConsoleBookingEvent | undefined;
  for (const event of events) {
    if (
      predicate(event) &&
      (newest === undefined || Date.parse(event.createdAt) > Date.parse(newest.createdAt))
    ) {
      newest = event;
    }
  }
  return newest;
}

/** `data.reconcileUntil` of an event, when it is a time. */
function reconcileUntilOf(event: ConsoleBookingEvent | undefined): string | undefined {
  const value = event?.data?.["reconcileUntil"];
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** The booking is paid by the traveller's card through the airline (OADR-0004). */
export function isAirlineCardBooking(booking: ConsoleBooking): boolean {
  return booking.payments.some(
    (payment) => payment.method === "airline_card" || payment.provider === "airline",
  );
}

/** The states of `booking` that need staff, the most urgent first, with times in the OTA's time zone. */
export function attentionOf(booking: ConsoleBooking, timeZone: string): AttentionItem[] {
  const items: AttentionItem[] = [];
  const when = (value: string) => formatInstant(value, timeZone);

  if (booking.status === "failed") {
    items.push({
      id: "failed",
      tone: "danger",
      title: "The booking failed",
      ...(booking.failure === null ? {} : { detail: `${booking.failure.code}: ${booking.failure.message}` }),
    });
  }

  if (booking.status === "pending") {
    const review = newestEvent(booking.events, (event) => event.type === RECONCILE_REVIEW_EVENT);
    if (review === undefined) {
      const until = reconcileUntilOf(
        newestEvent(booking.events, (event) => RECONCILE_WINDOW_EVENTS.has(event.type)),
      );
      items.push({
        id: "reconciling",
        tone: "warning",
        title:
          until === undefined
            ? "Outcome unknown, reconciling"
            : `Outcome unknown, reconciling until ${when(until)}`,
        detail:
          "Amadeus did not confirm the order. The reconciliation looks for it in the queuing office and decides; issue and cancel wait for it.",
      });
    } else {
      items.push({
        id: "reconcile-review",
        tone: "danger",
        title: "Reconciliation needs staff review",
        detail: `${review.summary} Check the order in Amadeus and decide.`,
      });
    }
  }

  const withOrder = booking.status === "confirmed" || booking.status === "partially_ticketed";
  if (withOrder && isAirlineCardBooking(booking) && booking.ticketing.status !== "issued") {
    items.push({
      id: "airline-card",
      tone: "danger",
      title: "The airline card cannot be charged again: issue with another form of payment or cancel",
      detail: "Card data is never entered in the console.",
    });
  }

  const ticketing = booking.ticketing.status;
  if (booking.status !== "pending" && (ticketing === "manual_review" || ticketing === "failed")) {
    const reason = newestEvent(booking.events, (event) => TICKETING_PROBLEM_EVENTS.has(event.type));
    const deadline = booking.ticketing.deadlineAt;
    items.push({
      id: "ticketing",
      tone: ticketing === "failed" ? "danger" : "warning",
      title: ticketing === "failed" ? "Ticketing failed" : "Ticketing needs staff review",
      detail: [
        reason?.summary ?? "No reason was recorded.",
        deadline === null ? "No ticketing deadline." : `Ticketing deadline ${when(deadline)}.`,
      ].join(" "),
    });
  }

  const cancellation = booking.cancellation;
  if (cancellation !== null && cancellation.refundStatus === "manual_review") {
    items.push({
      id: "cancellation",
      tone: "danger",
      title: "The cancellation's money needs staff",
      detail:
        "The kept amount could not be captured or the rest released: settle the payment from the console.",
    });
  } else if (cancellation !== null && cancellation.status === "pending") {
    items.push({
      id: "cancellation",
      tone: "warning",
      title: "Cancellation requested, not completed",
      detail: `Requested ${when(cancellation.requestedAt)}; it waits for Amadeus's answer or for the staff.`,
    });
  }

  if (
    booking.itineraries.some((itinerary) =>
      itinerary.segments.some((segment) => segment.scheduleChanged === true),
    )
  ) {
    items.push({
      id: "schedule-changed",
      tone: "warning",
      title: "Schedule changed by the airline",
      detail: "Check the new times in the itinerary and tell the traveller.",
    });
  }

  const sync = booking.supplierSync;
  if (sync.status === "order_not_found") {
    items.push({ id: "sync", tone: "danger", title: DETAIL_STRINGS.syncOrderNotFound });
  } else if (sync.status === "failed") {
    items.push({
      id: "sync",
      tone: "warning",
      title: "The last sync with Amadeus failed",
      ...(sync.lastError === null ? {} : { detail: sync.lastError }),
    });
  }
  return items;
}

const ATTENTION_CLASSES: Readonly<Record<AttentionItem["tone"], string>> = {
  warning: "border-amber-300 bg-amber-50 text-amber-950",
  danger: "border-red-300 bg-red-50 text-red-950",
};

/** The states that need staff, above the tabs. */
function Attention({ items }: { readonly items: readonly AttentionItem[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <section aria-label={DETAIL_STRINGS.attention} className="grid gap-2">
      {items.map((item) => (
        <div
          key={item.id}
          data-attention={item.id}
          data-tone={item.tone}
          className={cn("grid gap-1 rounded-md border px-4 py-3", ATTENTION_CLASSES[item.tone])}
        >
          <p className="font-semibold">{item.title}</p>
          {item.detail === undefined ? null : <p className="text-sm">{item.detail}</p>}
        </div>
      ))}
    </section>
  );
}

// ---- Header ---------------------------------------------------------------------------------------------------------

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";

function EnvironmentPill({ environment }: { readonly environment: StaffEnvironment }) {
  return <Pill tone={environment === "live" ? "warning" : "neutral"}>{environment.toUpperCase()}</Pill>;
}

/** The booking's name, states and the way back to the list. */
function Header({ booking, tab }: { readonly booking: ConsoleBooking; readonly tab: BookingTab }) {
  const canSync =
    booking.amadeusOrderId !== null && booking.status !== "cancelled" && booking.status !== "pending";
  return (
    <div className="grid gap-3">
      <Link href={BOOKINGS_PATH} className={cn(LINK_CLASS, "w-fit")}>
        {DETAIL_STRINGS.back}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {DETAIL_STRINGS.title} <span className="font-mono">{booking.reference}</span>
        </h1>
        {canSync ? (
          <Link
            href={bookingHref(booking.id, { tab, refresh: true })}
            prefetch={false}
            className={LINK_CLASS}
          >
            {DETAIL_STRINGS.sync}
          </Link>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge kind="booking" status={booking.status} />
        <StatusBadge kind="ticketing" status={booking.ticketing.status} />
        <StatusBadge kind="payment" status={booking.paymentStatus} />
        <StatusBadge kind="sync" status={booking.supplierSync.status} />
        <EnvironmentPill environment={booking.environment} />
        {booking.isGuest ? <Pill tone="neutral">{DETAIL_STRINGS.guest}</Pill> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {DETAIL_STRINGS.recordLocator}{" "}
        <span className="font-mono text-foreground">
          {booking.recordLocator ?? DETAIL_STRINGS.noRecordLocator}
        </span>{" "}
        · {labelOf(CHANNEL_LABELS, booking.channel)} · {DETAIL_STRINGS.version} {booking.version}
      </p>
    </div>
  );
}

/** The result of "Sync from Amadeus". */
function RefreshNotice({
  booking,
  refresh,
}: {
  readonly booking: ConsoleBooking;
  readonly refresh: RefreshOutcome;
}) {
  let text: string;
  let tone: StatusTone;
  if (!refresh.ok) {
    text = `${DETAIL_STRINGS.syncFailed} ${errorMessage(refresh.error)}`;
    tone = "warning";
  } else if (booking.supplierSync.status === "refreshed") {
    text = DETAIL_STRINGS.synced;
    tone = "success";
  } else if (booking.supplierSync.status === "throttled") {
    text = DETAIL_STRINGS.syncThrottled;
    tone = "info";
  } else if (booking.supplierSync.status === "order_not_found") {
    text = DETAIL_STRINGS.syncOrderNotFound;
    tone = "danger";
  } else {
    // The API ignores a refresh of a booking without an Amadeus order, or of a cancelled one.
    text = DETAIL_STRINGS.syncNothing;
    tone = "info";
  }
  return (
    <p role="status" data-tone={tone} className={cn("rounded-md px-3 py-2 text-sm", toneClasses(tone))}>
      {text}
      {!refresh.ok && refresh.error.requestId !== null ? ` (request id ${refresh.error.requestId})` : null}
    </p>
  );
}

/** The tabs, as links: the current one is marked. */
function Tabs({ bookingId, current }: { readonly bookingId: string; readonly current: BookingTab }) {
  return (
    <nav aria-label={DETAIL_STRINGS.tabs} className="border-b">
      <ul className="-mb-px flex flex-wrap gap-1">
        {BOOKING_TABS.map((tab) => (
          <li key={tab.id}>
            <Link
              href={bookingHref(bookingId, { tab: tab.id })}
              prefetch={false}
              aria-current={tab.id === current ? "page" : undefined}
              className={cn(
                "inline-block border-b-2 px-3 py-2 text-sm font-medium",
                tab.id === current
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ---- Overview -------------------------------------------------------------------------------------------------------

function BookingFacts({
  booking,
  timeZone,
}: {
  readonly booking: ConsoleBooking;
  readonly timeZone: string;
}) {
  const customer = booking.customer;
  return (
    <Section id="facts" title={DETAIL_STRINGS.facts}>
      <Facts
        items={[
          ["Reference", <span className="font-mono">{booking.reference}</span>],
          [
            "Record locators",
            booking.recordLocators.length === 0
              ? null
              : booking.recordLocators
                  .map(
                    (record) =>
                      `${record.reference} (${record.originSystemCode}${record.primary ? ", main" : ""})`,
                  )
                  .join(", "),
          ],
          [
            "Amadeus order id",
            booking.amadeusOrderId === null ? null : (
              <span className="font-mono">{booking.amadeusOrderId}</span>
            ),
          ],
          ["Environment", <EnvironmentPill environment={booking.environment} />],
          ["Channel", labelOf(CHANNEL_LABELS, booking.channel)],
          ["Customer", customer === null ? DETAIL_STRINGS.guest : customerText(customer)],
          ["Contact e-mail", booking.contactEmail],
          ["Owner office", booking.ownerOfficeId],
          ["Queuing office", booking.queuingOfficeId],
          ["Created by staff", booking.createdByStaffId],
          ["Checkout", booking.checkoutId ?? null],
          ["Priced offer", booking.pricedOfferId ?? null],
          ["Tags", booking.tags.length === 0 ? null : booking.tags.join(", ")],
          ["Created", instant(booking.createdAt, timeZone)],
          ["Updated", instant(booking.updatedAt, timeZone)],
          ["Cancelled", instant(booking.cancelledAt, timeZone)],
        ]}
      />
    </Section>
  );
}

function ItinerarySection({ booking }: { readonly booking: ConsoleBooking }) {
  return (
    <Section id="itinerary" title={DETAIL_STRINGS.itinerary} className="lg:col-span-2">
      {booking.itineraries.map((itinerary) => (
        <div key={itinerary.index} className="grid gap-2">
          <h3 className="font-medium">
            {itineraryLabel(booking.tripType, itinerary.index)}: {itinerary.originCode} →{" "}
            {itinerary.destinationCode}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              {[
                duration(itinerary.durationMinutes),
                itinerary.stops === 0 ? "non-stop" : `${itinerary.stops} stop(s)`,
              ]
                .filter((part) => part !== undefined)
                .join(" · ")}
            </span>
          </h3>
          <SimpleTable
            caption={`${itineraryLabel(booking.tripType, itinerary.index)} flights`}
            columns={["Flight", "Departure", "Arrival", "Fare", "Status"]}
            empty={NONE}
            rows={itinerary.segments.map((segment) => ({
              key: segment.id,
              cells: [
                <span className="grid">
                  <span className="font-medium">{segment.flightNumber}</span>
                  <span className="text-xs text-muted-foreground">
                    {[
                      segment.carrierName,
                      segment.operatingCarrierCode === null || segment.operatingCarrierCode === undefined
                        ? undefined
                        : `operated by ${segment.operatingCarrierCode}`,
                      segment.aircraftCode === null || segment.aircraftCode === undefined
                        ? undefined
                        : `aircraft ${segment.aircraftCode}`,
                    ]
                      .filter((part) => part !== undefined && part !== null)
                      .join(" · ")}
                  </span>
                </span>,
                <span className="grid">
                  <span>
                    {segment.departure.iataCode}
                    {segment.departure.terminal ? ` T${segment.departure.terminal}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">{localTime(segment.departure.at)}</span>
                </span>,
                <span className="grid">
                  <span>
                    {segment.arrival.iataCode}
                    {segment.arrival.terminal ? ` T${segment.arrival.terminal}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">{localTime(segment.arrival.at)}</span>
                </span>,
                [
                  segment.cabin === null || segment.cabin === undefined ? undefined : humanize(segment.cabin),
                  segment.bookingClass ?? undefined,
                  segment.fareBasis ?? undefined,
                  segment.brandedFareLabel ?? segment.brandedFare ?? undefined,
                ]
                  .filter((part) => part !== undefined)
                  .join(" · "),
                <span className="flex flex-wrap gap-1">
                  <Pill tone={segment.status === "CONFIRMED" ? "success" : "warning"}>
                    {humanize(segment.status)}
                  </Pill>
                  {segment.isFlown ? <Pill tone="neutral">Flown</Pill> : null}
                  {segment.scheduleChanged === true ? <Pill tone="warning">Schedule changed</Pill> : null}
                </span>,
              ],
            }))}
          />
        </div>
      ))}
    </Section>
  );
}

function TicketingSection({
  booking,
  timeZone,
}: {
  readonly booking: ConsoleBooking;
  readonly timeZone: string;
}) {
  const { ticketing, ticketingAgreement } = booking;
  return (
    <Section id="ticketing" title={DETAIL_STRINGS.ticketing}>
      <Facts
        items={[
          ["Status", <StatusBadge kind="ticketing" status={ticketing.status} />],
          ["Policy", labelOf(POLICY_LABELS, ticketing.policy)],
          ["Deadline", instant(ticketing.deadlineAt, timeZone)],
          ["Last ticketing date", ticketing.lastTicketingDate ?? null],
          ["Issued", instant(ticketing.issuedAt, timeZone)],
          [
            "Agreement",
            ticketingAgreement === null || ticketingAgreement.option === undefined
              ? null
              : [humanize(ticketingAgreement.option), ticketingAgreement.delay]
                  .filter((part) => part !== undefined)
                  .join(" · "),
          ],
          ["Issue requested at booking", yesNo(booking.issueRequested)],
          ["Customer message", ticketing.message ?? null],
        ]}
      />
    </Section>
  );
}

function PricingSection({ booking }: { readonly booking: ConsoleBooking }) {
  const { pricing } = booking;
  const line = (label: string, value: MoneyValue | null, note?: string): Fact => [
    label,
    value === null ? null : (
      <span>
        <Money value={value} />
        {note === undefined ? null : <span className="text-muted-foreground"> {note}</span>}
      </span>
    ),
  ];
  return (
    <Section id="pricing" title={DETAIL_STRINGS.pricing} description={DETAIL_STRINGS.pricingDescription}>
      <Facts
        items={[
          line("Net base fares", pricing.netBase),
          line("Net taxes", pricing.netTaxes),
          line("Net supplier fees", pricing.netFees),
          line("Net services", pricing.netServices),
          line("Net cost", pricing.net),
          line(
            "Markup",
            pricing.markup,
            pricing.markupRuleName === null ? undefined : `(${pricing.markupRuleName})`,
          ),
          line("Service fees", pricing.serviceFees),
          line("Card fees", pricing.cardFees ?? null),
          line("Selling total", pricing.selling),
          line("Margin", pricing.margin, `(${pricing.marginPercent} %)`),
          ["Pricing mode", labelOf(PRICING_MODE_LABELS, pricing.pricingMode)],
        ]}
      />
    </Section>
  );
}

function PaymentSummarySection({ booking }: { readonly booking: ConsoleBooking }) {
  const { totals } = booking;
  return (
    <Section id="payment-summary" title={DETAIL_STRINGS.paymentSummary}>
      <Facts
        items={[
          ["Payment status", <StatusBadge kind="payment" status={booking.paymentStatus} />],
          ["Base fares", money(totals.base)],
          ["Taxes", money(totals.taxes)],
          ["Fees", money(totals.fees)],
          ["Services", money(totals.ancillaries)],
          ["Card fee", money(totals.cardFee)],
          ["Total", money(totals.total)],
          ["Paid", money(totals.paid)],
          ["Refunded", money(totals.refunded)],
        ]}
      />
      {booking.payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{DETAIL_STRINGS.noPayments}</p>
      ) : (
        <ul className="grid gap-1 text-sm">
          {booking.payments.map((payment) => (
            <li key={payment.id} className="flex flex-wrap items-center gap-2">
              <span>
                {labelOf(PROVIDER_LABELS, payment.provider)} · {labelOf(METHOD_LABELS, payment.method)}
              </span>
              <StatusBadge kind="paymentRecord" status={payment.status} />
              <Money value={payment.amount} />
            </li>
          ))}
        </ul>
      )}
      <Link
        href={bookingHref(booking.id, { tab: "payments" })}
        prefetch={false}
        className={cn(LINK_CLASS, "w-fit")}
      >
        {DETAIL_STRINGS.payments}
      </Link>
    </Section>
  );
}

/** Whether an action is possible now, or why not. */
function ActionAvailability({
  allowed,
  reason,
}: {
  readonly allowed: boolean;
  readonly reason: string | undefined;
}) {
  return allowed ? (
    <Pill tone="success">Allowed</Pill>
  ) : (
    <span className="flex flex-wrap items-center gap-2">
      <Pill tone="neutral">Not now</Pill>
      {reason === undefined ? null : <span className="text-muted-foreground">{reason}</span>}
    </span>
  );
}

function CancellationSection({
  booking,
  timeZone,
}: {
  readonly booking: ConsoleBooking;
  readonly timeZone: string;
}) {
  const { cancellation, consoleActions, allowedActions } = booking;
  const consoleReason = consoleActions.reasons["canCancel"];
  const customerReason = allowedActions.reasons["canCancel"];
  const refund = cancellation?.refund ?? null;
  return (
    <Section id="cancellation" title={DETAIL_STRINGS.cancellation}>
      {cancellation === null ? (
        <p className="text-sm text-muted-foreground">Not cancelled.</p>
      ) : (
        <Facts
          items={[
            [
              "Status",
              <Pill tone={cancellation.status === "cancelled" ? "neutral" : "warning"}>
                {labelOf(CANCELLATION_STATUS_LABELS, cancellation.status)}
              </Pill>,
            ],
            ["Requested", instant(cancellation.requestedAt, timeZone)],
            ["Cancelled", instant(cancellation.cancelledAt, timeZone)],
            ["Cancelled by", humanize(cancellation.cancelledBy)],
            ["Reason", humanize(cancellation.reasonCode)],
            ["Comment", cancellation.comment ?? null],
            ["Tickets voided", yesNo(cancellation.ticketsVoided)],
            ["Estimated refund", money(cancellation.estimatedRefund)],
            [
              "Money back",
              <Pill tone={REFUND_STATUS_TONES[cancellation.refundStatus] ?? "neutral"}>
                {labelOf(REFUND_STATUS_LABELS, cancellation.refundStatus)}
              </Pill>,
            ],
            ["Refunded or released", money(refund?.amount)],
            ["Kept", money(refund?.penalty)],
          ]}
        />
      )}
      <Facts
        items={[
          [
            "Cancel from the console",
            <ActionAvailability
              allowed={consoleActions.canCancel}
              reason={consoleReason === undefined ? undefined : labelOf(CONSOLE_REASONS, consoleReason)}
            />,
          ],
          [
            "Customer self-service",
            <ActionAvailability
              allowed={allowedActions.canCancel}
              reason={customerReason === undefined ? undefined : labelOf(CUSTOMER_REASONS, customerReason)}
            />,
          ],
        ]}
      />
    </Section>
  );
}

function SupplierSyncSection({
  booking,
  timeZone,
}: {
  readonly booking: ConsoleBooking;
  readonly timeZone: string;
}) {
  const sync = booking.supplierSync;
  return (
    <Section id="supplier-sync" title={DETAIL_STRINGS.supplierSync} className="lg:col-span-2">
      <Facts
        items={[
          ["Status", <StatusBadge kind="sync" status={sync.status} />],
          ["Last synchronised", instant(sync.lastSyncedAt, timeZone)],
          ["Last attempt", instant(sync.lastAttemptAt, timeZone)],
          ["Last error", sync.lastError],
          ["Next scheduled sync", instant(sync.nextScheduledSyncAt, timeZone)],
          [
            "Amadeus call of the last attempt",
            sync.lastSupplierRequestId === null ? null : <code>{sync.lastSupplierRequestId}</code>,
          ],
        ]}
      />
      {sync.differences.length === 0 ? null : (
        <div className="grid gap-1">
          <h3 className="font-medium">Changes found by the last sync</h3>
          <ul className="grid gap-1 text-sm">
            {sync.differences.map((change) => (
              <li key={change.path}>
                <span className="font-medium">{change.label}</span>: {JSON.stringify(change.before ?? null)} →{" "}
                {JSON.stringify(change.after ?? null)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <h3 className="font-medium">{DETAIL_STRINGS.recentCalls}</h3>
      <SupplierCalls calls={booking.recentSupplierRequests} timeZone={timeZone} />
    </Section>
  );
}

function SupplierCalls({
  calls,
  timeZone,
}: {
  readonly calls: readonly SupplierRequest[];
  readonly timeZone: string;
}) {
  return (
    <SimpleTable
      caption={DETAIL_STRINGS.recentCalls}
      columns={["Time", "Operation", "Amadeus API", "HTTP", "Outcome", "Duration", "Amadeus errors"]}
      empty="No Amadeus calls for this booking."
      rows={calls.map((call) => ({
        key: call.id,
        cells: [
          instant(call.createdAt, timeZone),
          <span className="grid">
            <span>{call.operation}</span>
            <code className="text-xs text-muted-foreground">{call.id}</code>
          </span>,
          `${call.amadeusApi} (${call.amadeusOperationId})`,
          call.httpStatus === null ? null : String(call.httpStatus),
          <Pill tone={OUTCOME_TONES[call.outcome] ?? "neutral"}>{humanize(call.outcome)}</Pill>,
          call.durationMs === null ? null : `${call.durationMs} ms`,
          call.errorCodes.length === 0 ? null : call.errorCodes.join(", "),
        ],
      }))}
    />
  );
}

function ConsoleActionsSection({ booking }: { readonly booking: ConsoleBooking }) {
  const { consoleActions } = booking;
  return (
    <Section id="console-actions" title={DETAIL_STRINGS.consoleActions}>
      <Facts
        items={CONSOLE_ACTIONS.map(([key, label]): Fact => {
          const reason = consoleActions.reasons[key];
          return [
            label,
            <ActionAvailability
              allowed={consoleActions[key]}
              reason={reason === undefined ? undefined : labelOf(CONSOLE_REASONS, reason)}
            />,
          ];
        })}
      />
    </Section>
  );
}

function FareConditionsSection({ booking }: { readonly booking: ConsoleBooking }) {
  const conditions = booking.fareConditions ?? null;
  if (conditions === null) {
    return null;
  }
  return (
    <Section id="fare-conditions" title={DETAIL_STRINGS.fareConditions}>
      <Facts
        items={[
          ["Refundable", yesNo(conditions.refundable)],
          ["Refund penalty", money(conditions.refundPenalty)],
          ["Changeable", yesNo(conditions.changeable)],
          ["Change penalty", money(conditions.changePenalty)],
          ["Source", humanize(conditions.source)],
        ]}
      />
    </Section>
  );
}

function FailureSection({ booking }: { readonly booking: ConsoleBooking }) {
  const { failure } = booking;
  if (failure === null) {
    return null;
  }
  const supplier = failure.supplier ?? null;
  return (
    <Section id="failure" title={DETAIL_STRINGS.failure}>
      <Facts
        items={[
          ["Code", <code>{failure.code}</code>],
          ["Message", failure.message],
          [
            "Amadeus",
            supplier === null
              ? null
              : [
                  supplier.code === undefined ? undefined : String(supplier.code),
                  supplier.title,
                  supplier.detail,
                ]
                  .filter((part) => part !== undefined)
                  .join(" · "),
          ],
        ]}
      />
    </Section>
  );
}

function WarningsSection({ booking }: { readonly booking: ConsoleBooking }) {
  const warnings = booking.warnings ?? [];
  if (warnings.length === 0) {
    return null;
  }
  return (
    <Section id="warnings" title={DETAIL_STRINGS.warnings}>
      <ul className="grid gap-1 text-sm">
        {warnings.map((warning, index) => (
          <li key={`${warning.code ?? "warning"}-${index}`}>
            {warning.code === undefined ? null : <code>{warning.code}</code>} {warning.title}
            {warning.detail === undefined ? null : `: ${warning.detail}`}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Overview({ booking, timeZone }: { readonly booking: ConsoleBooking; readonly timeZone: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <BookingFacts booking={booking} timeZone={timeZone} />
      <ConsoleActionsSection booking={booking} />
      <FailureSection booking={booking} />
      <ItinerarySection booking={booking} />
      <TicketingSection booking={booking} timeZone={timeZone} />
      <PricingSection booking={booking} />
      <PaymentSummarySection booking={booking} />
      <CancellationSection booking={booking} timeZone={timeZone} />
      <FareConditionsSection booking={booking} />
      <WarningsSection booking={booking} />
      <SupplierSyncSection booking={booking} timeZone={timeZone} />
    </div>
  );
}

// ---- Travellers and contacts -------------------------------------------------------------------------------------

function documentLine(document: TravelerDocument): string {
  return [
    humanize(document.documentType),
    documentNumber(document) ?? "no number",
    document.issuanceCountry === undefined ? undefined : `issued in ${document.issuanceCountry}`,
    document.nationality === undefined ? undefined : `nationality ${document.nationality}`,
    document.expiryDate === undefined ? undefined : `expires ${document.expiryDate}`,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

function discountLine(discount: Discount): string {
  return [
    discount.subType === undefined ? "Discount" : humanize(discount.subType),
    maskedNumber(discount.cardNumber),
    discount.cityName,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

function TravelerCard({ traveler }: { readonly traveler: Traveler }) {
  const documents = traveler.documents ?? [];
  const loyalty = traveler.loyaltyPrograms ?? [];
  const discounts = traveler.discountEligibility ?? [];
  const emergency = traveler.emergencyContact ?? null;
  const contact = traveler.contact ?? null;
  return (
    <article
      aria-label={fullName(traveler.name) ?? `Traveller ${traveler.travelerId}`}
      className="grid gap-2 rounded-md border p-3"
    >
      <h3 className="font-medium">
        {fullName(traveler.name) ?? "Name not entered"}{" "}
        <span className="text-sm font-normal text-muted-foreground">
          {humanize(traveler.travelerType)} · traveller {traveler.travelerId}
        </span>
      </h3>
      <Facts
        items={[
          ["Date of birth", traveler.dateOfBirth ?? null],
          [
            "Gender",
            traveler.gender === null || traveler.gender === undefined ? null : humanize(traveler.gender),
          ],
          ["Travels with", traveler.associatedAdultId ?? null],
          [
            "Documents",
            documents.length === 0 ? null : (
              <ul className="grid gap-0.5">
                {documents.map((document, index) => (
                  <li key={`${document.documentType}-${index}`}>{documentLine(document)}</li>
                ))}
              </ul>
            ),
          ],
          [
            "Loyalty programmes",
            loyalty.length === 0
              ? null
              : loyalty
                  .map((program) => `${program.programOwner ?? ""} ${program.id ?? ""}`.trim())
                  .join(", "),
          ],
          ["Discounts", discounts.length === 0 ? null : discounts.map(discountLine).join(", ")],
          ["E-mail", contact?.emailAddress ?? null],
          [
            "Phones",
            (contact?.phones ?? []).length === 0 ? null : (contact?.phones ?? []).map(phoneText).join(", "),
          ],
          [
            "Emergency contact",
            emergency === null
              ? null
              : [
                  emergency.addresseeName,
                  emergency.countryCode === undefined ? undefined : `+${emergency.countryCode}`,
                  emergency.number,
                  emergency.text,
                ]
                  .filter((part) => part !== undefined && part !== "")
                  .join(" "),
          ],
          [
            "Ticket numbers",
            (traveler.ticketNumbers ?? []).length === 0 ? null : (traveler.ticketNumbers ?? []).join(", "),
          ],
        ]}
      />
    </article>
  );
}

function contactAddress(contact: Contact): string | undefined {
  const address = contact.address ?? null;
  if (address === null) {
    return undefined;
  }
  const text = [
    ...(address.lines ?? []),
    address.postalCode,
    address.cityName,
    address.stateName,
    address.countryCode,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(", ");
  return text === "" ? undefined : text;
}

function TravellersTab({
  booking,
  timeZone,
}: {
  readonly booking: ConsoleBooking;
  readonly timeZone: string;
}) {
  const names = travelerNames(booking);
  const agreement = booking.ticketingAgreement;
  return (
    <div className="grid gap-4">
      <Section id="travellers" title={DETAIL_STRINGS.travelers} description={DETAIL_STRINGS.documentsMasked}>
        <div className="grid gap-3 lg:grid-cols-2">
          {booking.travelers.map((traveler) => (
            <TravelerCard key={traveler.id} traveler={traveler} />
          ))}
        </div>
      </Section>
      <Section id="contacts" title={DETAIL_STRINGS.contacts}>
        <SimpleTable
          caption={DETAIL_STRINGS.contacts}
          columns={["Name", "Purpose", "E-mail", "Phones", "Address", "Language"]}
          empty="No contacts."
          rows={booking.contacts.map((contact: Contact) => ({
            key: contact.id,
            cells: [
              <span className="flex flex-wrap items-center gap-2">
                {fullName(contact.addresseeName) ?? contact.companyName ?? NONE}
                {contact.isPrimary ? <Pill tone="info">Primary</Pill> : null}
              </span>,
              humanize(contact.purpose),
              contact.emailAddress ?? null,
              (contact.phones ?? []).length === 0 ? null : (contact.phones ?? []).map(phoneText).join(", "),
              contactAddress(contact) ?? null,
              contact.language ?? null,
            ],
          }))}
        />
      </Section>
      <Section id="remarks" title={DETAIL_STRINGS.remarks}>
        <SimpleTable
          caption={DETAIL_STRINGS.remarks}
          columns={["Text", "Kind", "Source", "Travellers", "Added"]}
          empty="No remarks."
          rows={booking.remarks.map((remark: Remark) => ({
            key: remark.id,
            cells: [
              <span className="font-mono text-xs">{remark.text}</span>,
              `${humanize(remark.kind)} · ${remark.subType}`,
              humanize(remark.source),
              remark.travelerIds.length === 0
                ? "All"
                : remark.travelerIds.map((id) => names.get(id) ?? id).join(", "),
              instant(remark.createdAt, timeZone),
            ],
          }))}
        />
      </Section>
      <Section id="agreement" title={DETAIL_STRINGS.agreement}>
        <Facts
          items={[
            ["Option", agreement?.option === undefined ? null : humanize(agreement.option)],
            ["Delay", agreement?.delay ?? null],
            ["Applies at (Amadeus)", agreement?.dateTime ?? null],
            [
              "Segments",
              agreement?.segmentIds === undefined
                ? null
                : segmentsText(agreement.segmentIds, segmentsById(booking)),
            ],
          ]}
        />
        <h3 className="font-medium">{DETAIL_STRINGS.automatedProcess}</h3>
        <SimpleTable
          caption={DETAIL_STRINGS.automatedProcess}
          columns={["Code", "Queue", "Office", "Delay", "Applies at"]}
          empty="No automated processes."
          rows={booking.automatedProcess.map((process, index) => ({
            key: `process-${index}`,
            cells: [
              process.code ?? null,
              process.queue === undefined
                ? null
                : [process.queue.number, process.queue.category]
                    .filter((part) => part !== undefined)
                    .join(" / "),
              process.officeId ?? null,
              process.delay ?? null,
              process.dateTime ?? null,
            ],
          }))}
        />
      </Section>
      {booking.commissions.length === 0 && booking.formOfIdentifications.length === 0 ? null : (
        <JsonView
          label={DETAIL_STRINGS.otherElements}
          value={{
            commissions: booking.commissions,
            formOfIdentifications: booking.formOfIdentifications.map(maskedIdentification),
          }}
        />
      )}
    </div>
  );
}

// ---- Amadeus order -------------------------------------------------------------------------------------------------

/** Why the order cannot be opened (`consoleActions.reasons.canRetrieve`). */
const ORDER_UNAVAILABLE: Readonly<Record<string, string>> = {
  no_permission: "Your role cannot open the Amadeus order.",
  pending: "The order is not known yet: the reconciliation decides first.",
  failed: "The booking failed, so there is no Amadeus order.",
  no_amadeus_order: "The booking has no Amadeus order.",
};

function AmadeusOrderTab({
  bookingId,
  view,
  timeZone,
}: {
  readonly bookingId: string;
  readonly view: OrderView;
  readonly timeZone: string;
}) {
  const again = (
    <Link href={bookingHref(bookingId, { tab: "amadeus-order" })} prefetch={false} className={LINK_CLASS}>
      {DETAIL_STRINGS.orderAgain}
    </Link>
  );
  switch (view.state) {
    case "unavailable":
      return (
        <Section id="amadeus-order" title={DETAIL_STRINGS.orderTitle}>
          <p className="text-sm">
            {view.reason === undefined
              ? "The Amadeus order cannot be opened for this booking."
              : (ORDER_UNAVAILABLE[view.reason] ??
                `The Amadeus order cannot be opened: ${humanize(view.reason)}.`)}
          </p>
        </Section>
      );
    case "failed":
      return (
        <ErrorState title={DETAIL_STRINGS.orderFailed} error={view.error}>
          {view.supplier === undefined ? null : (
            <p className="text-sm">
              Amadeus{view.supplier.code === undefined ? "" : ` ${view.supplier.code}`}
              {view.supplier.title === undefined ? "" : `: ${view.supplier.title}`}
            </p>
          )}
          {again}
        </ErrorState>
      );
    case "loaded": {
      const { retrieval } = view;
      const { call, amadeus } = retrieval;
      const warnings = amadeus.warnings ?? [];
      return (
        <Section id="amadeus-order" title={DETAIL_STRINGS.orderTitle} description={DETAIL_STRINGS.orderIntro}>
          <Facts
            items={[
              ["Flight order id", <code>{retrieval.flightOrderId}</code>],
              ["Read", instant(retrieval.retrievedAt, timeZone)],
              [
                "Amadeus call",
                `${call.httpMethod} ${call.path} → ${call.httpStatus} in ${call.durationMs} ms`,
              ],
              ["Office", call.officeId],
              ["Amadeus request id", call.correlationId],
              ["Call log entry", <code>{call.supplierRequestId}</code>],
              ["Stored order refreshed", yesNo(retrieval.snapshotUpdated)],
            ]}
          />
          {warnings.length === 0 ? null : (
            <ul aria-label={DETAIL_STRINGS.warnings} className="grid gap-1 text-sm">
              {warnings.map((warning, index) => (
                <li key={`${warning.code ?? "warning"}-${index}`}>
                  {warning.code === undefined ? null : <code>{warning.code}</code>} {warning.title ?? ""}
                </li>
              ))}
            </ul>
          )}
          <JsonView label={DETAIL_STRINGS.orderData} value={amadeus.data} open />
          {amadeus.included === undefined ? null : (
            <JsonView label={DETAIL_STRINGS.orderIncluded} value={amadeus.included} />
          )}
          {amadeus.dictionaries === undefined ? null : (
            <JsonView label={DETAIL_STRINGS.orderDictionaries} value={amadeus.dictionaries} />
          )}
          {again}
        </Section>
      );
    }
  }
}

// ---- Tickets and documents -----------------------------------------------------------------------------------------

function TicketsTab({ booking, timeZone }: { readonly booking: ConsoleBooking; readonly timeZone: string }) {
  const segments = segmentsById(booking);
  const names = travelerNames(booking);
  const tickets = new Map(booking.tickets.map((ticket) => [ticket.id, ticket.documentNumber]));
  return (
    <div className="grid gap-4">
      <Section id="tickets" title={DETAIL_STRINGS.tickets}>
        <SimpleTable
          caption={DETAIL_STRINGS.tickets}
          columns={["Number", "Type", "Status", "Traveller", "Segments", "Issued", "Amount"]}
          empty={DETAIL_STRINGS.noTickets}
          rows={booking.tickets.map((ticket: Ticket) => ({
            key: ticket.id,
            cells: [
              <span className="font-mono">{ticket.documentNumber}</span>,
              ticket.documentType,
              <Pill tone={ticket.status === "ISSUED" ? "success" : "neutral"}>
                {humanize(ticket.status)}
              </Pill>,
              ticket.travelerName ??
                (ticket.travelerId === null ? null : (names.get(ticket.travelerId) ?? ticket.travelerId)),
              segmentsText(ticket.segmentIds, segments) ?? null,
              instant(ticket.issuedAt, timeZone),
              money(ticket.total),
            ],
          }))}
        />
      </Section>
      <Section id="documents" title={DETAIL_STRINGS.documents}>
        <SimpleTable
          caption={DETAIL_STRINGS.documents}
          columns={["Document", "Status", "File", "Language", "Ticket", "Created"]}
          empty={DETAIL_STRINGS.noDocuments}
          rows={(booking.documents ?? []).map((document: BookingDocument) => ({
            key: document.id,
            cells: [
              labelOf(DOCUMENT_KIND_LABELS, document.kind),
              <Pill
                tone={
                  document.status === "ready"
                    ? "success"
                    : document.status === "failed"
                      ? "danger"
                      : "neutral"
                }
              >
                {humanize(document.status)}
              </Pill>,
              <span className="grid">
                <span>{document.fileName}</span>
                {document.sizeBytes === null || document.sizeBytes === undefined ? null : (
                  <span className="text-xs text-muted-foreground">
                    {Math.ceil(document.sizeBytes / 1024)} KB
                  </span>
                )}
              </span>,
              document.locale,
              document.ticketId === null || document.ticketId === undefined
                ? null
                : (tickets.get(document.ticketId) ?? document.ticketId),
              instant(document.createdAt, timeZone),
            ],
          }))}
        />
      </Section>
      <Section id="services" title={DETAIL_STRINGS.services}>
        <SimpleTable
          caption={DETAIL_STRINGS.services}
          columns={["Service", "Traveller", "Segments", "Status", "Price", "EMD"]}
          empty={DETAIL_STRINGS.noServices}
          rows={booking.ancillaries.map((service: Ancillary) => ({
            key: service.id,
            cells: [
              service.label,
              service.travelerId === null ? "All" : (names.get(service.travelerId) ?? service.travelerId),
              segmentsText(service.segmentIds, segments) ?? null,
              humanize(service.status),
              money(service.price),
              service.emdNumber ?? null,
            ],
          }))}
        />
      </Section>
    </div>
  );
}

// ---- Payments -------------------------------------------------------------------------------------------------------

/** A form of payment of the order: its kind, method or brand and last 4 digits; never the holder or the expiry. */
function formOfPaymentText(form: FormOfPayment): string {
  switch (form.kind) {
    case "creditCard":
      return [
        "Card",
        form.brand ?? undefined,
        form.last4 === null || form.last4 === undefined ? undefined : `•••• ${form.last4}`,
      ]
        .filter((part) => part !== undefined)
        .join(" ");
    case "other":
      return form.method === null || form.method === undefined ? "Other" : `Other: ${form.method}`;
    case "b2bWallet":
      return form.cardFriendlyName === null || form.cardFriendlyName === undefined
        ? "B2B wallet"
        : `B2B wallet: ${form.cardFriendlyName}`;
  }
}

/** The card of a payment: brand and last 4 only. */
function cardText(payment: BookingPayment): string | undefined {
  if (payment.card !== null) {
    return `${payment.card.brand} •••• ${payment.card.last4}`;
  }
  return payment.cardHint === null || payment.cardHint === undefined ? undefined : payment.cardHint.brand;
}

function refundRequester(refund: PaymentRefund): string {
  const { requestedBy } = refund;
  return requestedBy.id === null
    ? humanize(requestedBy.type)
    : `${humanize(requestedBy.type)} ${requestedBy.id}`;
}

function PaymentCard({
  summary,
  detail,
  timeZone,
}: {
  readonly summary: BookingPayment;
  readonly detail: PaymentDetail | undefined;
  readonly timeZone: string;
}) {
  const payment: BookingPayment = detail?.payment ?? summary;
  const full = detail?.payment;
  const account = full?.providerConnection ?? null;
  const airline = payment.method === "airline_card" || payment.provider === "airline";
  return (
    <article aria-label={`Payment ${payment.id}`} className="grid gap-3 rounded-md border p-3">
      <h3 className="flex flex-wrap items-center gap-2 font-medium">
        {labelOf(PROVIDER_LABELS, payment.provider)} · {labelOf(METHOD_LABELS, payment.method)}
        <StatusBadge kind="paymentRecord" status={payment.status} />
        <code className="text-xs font-normal text-muted-foreground">{payment.id}</code>
      </h3>
      {airline ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {DETAIL_STRINGS.airlineCard}
        </p>
      ) : null}
      {detail?.error === undefined ? null : (
        <ErrorState title={DETAIL_STRINGS.paymentUnavailable} error={detail.error} />
      )}
      <Facts
        items={[
          ["Amount", money(payment.amount)],
          ["Card fee", money(payment.cardFee)],
          ["Authorised", money(payment.amountAuthorized)],
          ["Captured", money(payment.amountCaptured)],
          ["Refunded", money(payment.amountRefunded)],
          ["Capture", humanize(payment.captureMethod)],
          ["Card", cardText(payment) ?? null],
          [
            "3-D Secure",
            payment.threeDSecure.required ? humanize(payment.threeDSecure.status) : "Not required",
          ],
          [
            "Failure",
            payment.failure === null ? null : `${payment.failure.code}: ${payment.failure.message}`,
          ],
          [
            "Provider payment",
            payment.providerPaymentId === null || payment.providerPaymentId === undefined ? null : (
              <code>{payment.providerPaymentId}</code>
            ),
          ],
          ["Account", account === null ? null : humanize(account.accountMode)],
          ["Created", instant(payment.createdAt, timeZone)],
          ["Authorised at", instant(payment.authorizedAt, timeZone)],
          ["Captured at", instant(payment.capturedAt, timeZone)],
          ["Cancelled at", instant(payment.cancelledAt, timeZone)],
          ["Version", full === undefined ? null : String(full.version)],
        ]}
      />
      {full === undefined ? null : (
        <>
          <h4 className="font-medium">{DETAIL_STRINGS.paymentEvents}</h4>
          <SimpleTable
            caption={`${DETAIL_STRINGS.paymentEvents} of ${payment.id}`}
            columns={["Time", "Event", "Source", "Status", "Amount", DETAIL_STRINGS.details]}
            empty={DETAIL_STRINGS.noEvents}
            rows={full.events.map((event: PaymentEvent) => ({
              key: event.id,
              cells: [
                instant(event.createdAt, timeZone),
                <code className="text-xs">{event.type}</code>,
                humanize(event.source),
                statusChange(event.statusFrom, event.statusTo) ?? null,
                money(event.amount),
                hasEntries(event.payload) ? <JsonView label="Payload" value={event.payload} /> : null,
              ],
            }))}
          />
          <h4 className="font-medium">{DETAIL_STRINGS.paymentRefunds}</h4>
          <PaymentRefunds
            refunds={full.refunds}
            timeZone={timeZone}
            caption={`${DETAIL_STRINGS.paymentRefunds} of ${payment.id}`}
          />
        </>
      )}
    </article>
  );
}

function PaymentRefunds({
  refunds,
  timeZone,
  caption,
}: {
  readonly refunds: readonly PaymentRefund[];
  readonly timeZone: string;
  readonly caption: string;
}) {
  return (
    <SimpleTable
      caption={caption}
      columns={[
        "Requested",
        "Amount",
        "Kept",
        "Reason",
        "Status",
        "Requested by",
        "Stripe refund",
        "Failure",
      ]}
      empty={DETAIL_STRINGS.noRefunds}
      rows={refunds.map((refund) => ({
        key: refund.id,
        cells: [
          instant(refund.createdAt, timeZone),
          money(refund.amount),
          money(refund.penalty),
          <span className="grid">
            <span>{humanize(refund.reason)}</span>
            {refund.reasonNote === null ? null : (
              <span className="text-xs text-muted-foreground">{refund.reasonNote}</span>
            )}
          </span>,
          <Pill tone={REFUND_STATUS_TONES[refund.status] ?? "neutral"}>
            {labelOf(REFUND_STATUS_LABELS, refund.status)}
          </Pill>,
          refundRequester(refund),
          refund.providerRefundId === null ? null : <code>{refund.providerRefundId}</code>,
          refund.failureReason,
        ],
      }))}
    />
  );
}

function BookingRefunds({
  refunds,
  timeZone,
}: {
  readonly refunds: readonly BookingRefund[];
  readonly timeZone: string;
}) {
  return (
    <SimpleTable
      caption={DETAIL_STRINGS.paymentRefunds}
      columns={["Requested", "Payment", "Amount", "Kept", "Reason", "Status"]}
      empty={DETAIL_STRINGS.noRefunds}
      rows={refunds.map((refund) => ({
        key: refund.id,
        cells: [
          instant(refund.createdAt, timeZone),
          <code className="text-xs">{refund.paymentId}</code>,
          money(refund.amount),
          money(refund.penalty),
          humanize(refund.reason),
          <Pill tone={REFUND_STATUS_TONES[refund.status] ?? "neutral"}>
            {labelOf(REFUND_STATUS_LABELS, refund.status)}
          </Pill>,
        ],
      }))}
    />
  );
}

function PaymentsTab({
  booking,
  view,
  timeZone,
}: {
  readonly booking: ConsoleBooking;
  readonly view: PaymentsView;
  readonly timeZone: string;
}) {
  const details = view.permitted ? new Map(view.details.map((detail) => [detail.id, detail])) : undefined;
  return (
    <div className="grid gap-4">
      <Section id="payments" title={DETAIL_STRINGS.payments}>
        {view.permitted ? null : (
          <p className="text-sm text-muted-foreground">{DETAIL_STRINGS.paymentsPermission}</p>
        )}
        {booking.payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{DETAIL_STRINGS.noPayments}</p>
        ) : (
          booking.payments.map((summary) => (
            <PaymentCard
              key={summary.id}
              summary={summary}
              detail={details?.get(summary.id)}
              timeZone={timeZone}
            />
          ))
        )}
        {view.permitted ? null : (
          <>
            <h3 className="font-medium">{DETAIL_STRINGS.paymentRefunds}</h3>
            <BookingRefunds refunds={booking.refunds} timeZone={timeZone} />
          </>
        )}
      </Section>
      <Section id="forms-of-payment" title={DETAIL_STRINGS.formsOfPayment}>
        {booking.formOfPayments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{DETAIL_STRINGS.noFormsOfPayment}</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {booking.formOfPayments.map((form, index) => (
              <li key={`${form.kind}-${index}`}>
                {formOfPaymentText(form)}
                {form.flightOfferIds.length === 0 ? null : (
                  <span className="text-muted-foreground">
                    {" "}
                    · flight offers {form.flightOfferIds.join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ---- Timeline and notes --------------------------------------------------------------------------------------------

function VisibilityPill({ visible }: { readonly visible: boolean }) {
  return visible ? (
    <Pill tone="info">{DETAIL_STRINGS.visibleToCustomer}</Pill>
  ) : (
    <Pill tone="neutral">{DETAIL_STRINGS.internal}</Pill>
  );
}

function TimelineTab({ booking, timeZone }: { readonly booking: ConsoleBooking; readonly timeZone: string }) {
  return (
    <div className="grid gap-4">
      <Section id="notes" title={DETAIL_STRINGS.notes}>
        {booking.notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{DETAIL_STRINGS.noNotes}</p>
        ) : (
          <ul className="grid gap-2">
            {booking.notes.map((note) => (
              <li key={note.id} className="grid gap-1 rounded-md border p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  {instant(note.createdAt, timeZone)} · {actorText(note.author)}
                  <VisibilityPill visible={note.visibleToCustomer} />
                </p>
                <p className="whitespace-pre-wrap">{note.text}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="events" title={DETAIL_STRINGS.events}>
        {booking.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{DETAIL_STRINGS.noEvents}</p>
        ) : (
          <ol className="grid gap-2">
            {booking.events.map((event) => (
              <li
                key={event.id}
                data-event-type={event.type}
                className="grid gap-1 rounded-md border p-3 text-sm"
              >
                <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  {instant(event.createdAt, timeZone)} · {actorText(event.actor)} · <code>{event.type}</code>
                  <VisibilityPill visible={event.visibleToCustomer} />
                </p>
                <p>{event.summary}</p>
                {statusChange(event.statusFrom, event.statusTo) === undefined ? null : (
                  <p className="text-muted-foreground">
                    Status {statusChange(event.statusFrom, event.statusTo)}
                  </p>
                )}
                {hasEntries(event.data) ? (
                  <JsonView label={DETAIL_STRINGS.details} value={event.data} />
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}

// ---- Staff actions -------------------------------------------------------------------------------------------------

function StaffActionsTab({
  booking,
  timeZone,
}: {
  readonly booking: ConsoleBooking;
  readonly timeZone: string;
}) {
  return (
    <Section
      id="staff-actions"
      title={DETAIL_STRINGS.staffActions}
      description={DETAIL_STRINGS.staffActionsDescription}
    >
      <SimpleTable
        caption={DETAIL_STRINGS.staffActions}
        columns={["Time", "Action", "Outcome", "By", "Reason", "Request id"]}
        empty={DETAIL_STRINGS.noStaffActions}
        rows={booking.recentStaffActions.map((action: ConsoleStaffAction) => ({
          key: action.id,
          cells: [
            instant(action.createdAt, timeZone),
            <code className="text-xs">{action.action}</code>,
            <Pill tone={OUTCOME_TONES[action.outcome] ?? "neutral"}>{humanize(action.outcome)}</Pill>,
            actorText(action.actor),
            action.reason,
            action.requestId === null ? null : <code className="text-xs">{action.requestId}</code>,
          ],
        }))}
      />
    </Section>
  );
}

// ---- The page's content ---------------------------------------------------------------------------------------------

export interface BookingDetailProps {
  readonly booking: ConsoleBooking;
  readonly tab: BookingTab;
  /** The OTA's time zone (`tenant.timeZone`): instants are shown in it; airport times stay local. */
  readonly timeZone: string;
  /** The outcome of "Sync from Amadeus", when the page was asked for one. */
  readonly refresh?: RefreshOutcome | undefined;
  /** The Payments tab's payments (only when that tab is open). */
  readonly payments?: PaymentsView | undefined;
  /** The Amadeus order view (only when that tab is open). */
  readonly order?: OrderView | undefined;
}

/** The booking's header, what needs staff, the tabs and the open tab's sections. */
export function BookingDetail({ booking, tab, timeZone, refresh, payments, order }: BookingDetailProps) {
  return (
    <div className="grid gap-6">
      <Header booking={booking} tab={tab} />
      {refresh === undefined ? null : <RefreshNotice booking={booking} refresh={refresh} />}
      <Attention items={attentionOf(booking, timeZone)} />
      <Tabs bookingId={booking.id} current={tab} />
      <TabContent booking={booking} tab={tab} timeZone={timeZone} payments={payments} order={order} />
    </div>
  );
}

function TabContent({ booking, tab, timeZone, payments, order }: Omit<BookingDetailProps, "refresh">) {
  switch (tab) {
    case "overview":
      return <Overview booking={booking} timeZone={timeZone} />;
    case "travellers":
      return <TravellersTab booking={booking} timeZone={timeZone} />;
    case "amadeus-order":
      return (
        <AmadeusOrderTab
          bookingId={booking.id}
          view={order ?? { state: "unavailable", reason: booking.consoleActions.reasons["canRetrieve"] }}
          timeZone={timeZone}
        />
      );
    case "tickets":
      return <TicketsTab booking={booking} timeZone={timeZone} />;
    case "payments":
      return <PaymentsTab booking={booking} view={payments ?? { permitted: false }} timeZone={timeZone} />;
    case "timeline":
      return <TimelineTab booking={booking} timeZone={timeZone} />;
    case "staff-actions":
      return <StaffActionsTab booking={booking} timeZone={timeZone} />;
  }
}
