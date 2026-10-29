// Rows → the console bookings answers of the OTA document (OBE-061; ota/docs/flows/console-operations.md §2, the
// document's ConsoleBookingSummary, ConsoleBookingPage and ConsoleBooking): what staff see of a booking, which is more
// than customer scope shows (bookings/bookings.mapper.ts) and never less safe:
//
//   - net amounts, markup, margin, the markup rule, offices, the ticketing agreement, automated processes, commissions,
//     the creating staff member, the supplier sync state, every remark (staff and system ones included), the whole
//     timeline (staff-only events included), staff notes, the last Amadeus calls and staff actions, and the failure of a
//     failed booking appear here only;
//   - `amadeus.order` is the stored snapshot itself (net prices, written after the shared redactor: document, discount
//     card and certificate numbers to their last 4 characters, card data removed), read through the redactor again;
//     form of identification numbers are cut to their last 4 here as in customer scope;
//   - traveller documents are shown as customer scope shows them (`numberMasked`, decrypted only to build it): the full
//     numbers are the audited console.bookings.retrieve's (OBE-062), as the document's ConsoleBookingExample shows;
//   - forms of payment come from `bookings.form_of_payments` (redacted at write: brand, last 4, method; no holder and no
//     expiry since FIX-W29-SECURITY, so `holder` and `expiryDate` are null for every booking recorded since);
//   - event data passes the shared redactor; staff actions carry no before or after, Amadeus calls no bodies.
//
// The sync state (ConsoleBookingSyncStatus): `not_applicable` without an Amadeus order (pending, failed), else
// `order_not_found` when the last refresh found no order, `failed` after another sync error, `fresh` within 6 h of the
// last sync, else `stale`; a refresh of this request makes it `refreshed` or `throttled`. The inherited
// `Booking.syncStatus` maps `order_not_found` to `failed` and `not_applicable` to `fresh` (the document's rule). The
// supplier sync block fills `nextScheduledSyncAt` from the background sync's schedule and `differences` from the last
// recorded synchronisation's diff (FIX-W27-SYNC; `toSupplierSync`).
//
// `consoleActions` weighs the caller's permissions (the role's, or a key's own) and the booking's state; a refused
// action names its reason (`no_permission` first). `canCancel` follows the departure rule console.bookings.cancel
// checks (`cancelDepartureReasonOf` without the self-service window, FIX-W30-OTA): `flown` once any segment departed,
// not only once the last one landed, which `canIssue` keeps. The list cursor is opaque base64url JSON: the sort key (an instant
// in UTC with microseconds, a total, or `null` for a booking without a ticketing deadline), the id and a fingerprint of
// the environment, filters and sort, so a cursor of other filters is refused (`400 VALIDATION_FAILED`).
import type { components } from "@velexis/api-types";
import { redactPayload } from "@velexis/logger";
import { cancelDepartureReasonOf, STAFF_CANCEL_CUTOFF_MS } from "../bookings/allowed-actions";
import { VELEXIS_REMARK_PREFIX } from "../bookings/booking-reference";
import {
  dictionariesOf,
  FRESH_SYNC_MS,
  listFingerprint,
  type BookingAmadeus,
} from "../bookings/bookings.mapper";
import type { BookingRemarkRow, BookingRow } from "../bookings/bookings.repository";
import { ORDER_NOT_FOUND } from "../bookings/customer-bookings.service";
import { maskedIdentifications } from "../bookings/identifications";
import type { Booking } from "../bookings/order-recorder";
import type { StaffPermission } from "../common/auth/roles";
import { Money, type MoneyValue } from "../pricing/pricing.types";
import { invalidCursor } from "../reference/reference.mapper";
import type {
  ConsoleBookingDetailsRow,
  ConsoleBookingFilters,
  ConsoleBookingListRow,
  ConsoleBookingSort,
  ConsoleEventRow,
  ConsoleStaffActionRow,
  ConsoleSupplierRequestRow,
} from "./console-bookings.repository";
import { sortOf } from "./console-bookings.repository";

type Schemas = components["schemas"];
export type ConsoleBookingSummary = Schemas["ConsoleBookingSummary"];
export type ConsoleBookingPage = Schemas["ConsoleBookingPage"];
export type ConsoleBooking = Schemas["ConsoleBooking"];
export type ConsoleBookingSyncStatus = Schemas["ConsoleBookingSyncStatus"];
export type ConsoleBookingActions = Schemas["ConsoleBookingActions"];
type ConsoleBookingPricing = Schemas["ConsoleBookingPricing"];
type ConsoleSupplierSync = Schemas["ConsoleSupplierSync"];
type ConsoleSyncChange = Schemas["ConsoleSyncChange"];
type ConsoleFormOfPayment = Schemas["ConsoleFormOfPayment"];
type ConsoleActor = Schemas["ConsoleActor"];
type ConsoleBookingEvent = Schemas["ConsoleBookingEvent"];
type ConsoleBookingNote = Schemas["ConsoleBookingNote"];
type ConsoleStaffAction = Schemas["ConsoleStaffAction"];
type ConsoleSupplierRequest = Schemas["ConsoleSupplierRequest"];
type ConsoleCustomerRef = Schemas["ConsoleCustomerRef"];
type MoneyAmount = Schemas["Money"];
type Remark = Schemas["Remark"];
type ActionReason = ConsoleBookingActions["reasons"][string];

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** `Cache-Control` of console.bookings.list and get (personal data, never cached). */
export const CONSOLE_BOOKING_CACHE_CONTROL = "private, no-store";

/** How long after a refresh (or a sync) a staff refresh is throttled (console.bookings.get `refresh=true`). */
export const CONSOLE_REFRESH_THROTTLE_MS = 10_000;

const money = (amount: MoneyValue | string, currency: string, minorUnits: number): MoneyAmount => ({
  amount: new Money(amount).toFixed(minorUnits),
  currency,
});

// ---- Cursors -------------------------------------------------------------------------------------------------------

const CURSOR_VERSION = 1;
const INSTANT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const AMOUNT_KEY = /^-?\d{1,12}\.\d{2}$/;
const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;
const MAX_CURSOR_LENGTH = 400;

/** The fingerprint of a console list: the environment, every filter and the sort. */
export function consoleListFingerprint(
  environment: string,
  sort: ConsoleBookingSort,
  filters: ConsoleBookingFilters,
): string {
  const parts: Record<string, string | undefined> = { list: "console.bookings", environment, sort };
  for (const [name, value] of Object.entries(filters) as [string, unknown][]) {
    if (value === undefined) {
      continue;
    }
    parts[name] = Array.isArray(value) ? [...(value as string[])].sort().join(",") : String(value);
  }
  return listFingerprint(parts);
}

/** The opaque cursor after a row with this sort key and id. */
export function encodeConsoleCursor(fingerprint: string, key: string | null, id: string): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, fingerprint, key, id])).toString("base64url");
}

/**
 * The keyset position of `value` for the list of `fingerprint` sorted by `sort`; `400 VALIDATION_FAILED`
 * (`/query/cursor`) for a value this API did not write or a cursor of other filters.
 */
export function decodeConsoleCursor(
  value: string,
  fingerprint: string,
  sort: ConsoleBookingSort,
): { readonly key: string | null; readonly id: string } {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw invalidCursor();
  }
  const [version, print, key, id] = parsed as unknown[];
  const { field } = sortOf(sort);
  const keyValid =
    field === "total"
      ? typeof key === "string" && AMOUNT_KEY.test(key)
      : (typeof key === "string" && INSTANT_KEY.test(key)) || (key === null && field === "ticketingDeadline");
  if (
    version !== CURSOR_VERSION ||
    print !== fingerprint ||
    !keyValid ||
    typeof id !== "string" ||
    !BOOKING_ID.test(id)
  ) {
    throw invalidCursor();
  }
  return { key: key as string | null, id };
}

// ---- Shared --------------------------------------------------------------------------------------------------------

/** The sync state of a booking that this request did not refresh (see the file header). */
export function storedConsoleSyncStatusOf(input: {
  readonly status: string;
  readonly amadeusOrderId: string | null;
  readonly lastSyncedAt: Date | null;
  readonly syncError: string | null;
  readonly now: Date;
}): ConsoleBookingSyncStatus {
  if (input.amadeusOrderId === null || input.status === "pending" || input.status === "failed") {
    return "not_applicable";
  }
  if (input.syncError === ORDER_NOT_FOUND) {
    return "order_not_found";
  }
  if (input.syncError !== null) {
    return "failed";
  }
  return input.lastSyncedAt !== null && input.now.getTime() - input.lastSyncedAt.getTime() < FRESH_SYNC_MS
    ? "fresh"
    : "stale";
}

/** `Booking.syncStatus` of a console sync state (the document's mapping). */
export function bookingSyncStatusOf(status: ConsoleBookingSyncStatus): Booking["syncStatus"] {
  if (status === "order_not_found") {
    return "failed";
  }
  return status === "not_applicable" ? "fresh" : status;
}

/** `customers.status` of a deleted account. */
const DELETED_CUSTOMER = "deleted";

/**
 * A customer reference without its names (`null`): a deleted account as the console shows it (ConsoleCustomerRef,
 * "null for deleted accounts"). console.customers.get's recent bookings and console.bookings.list and get use it.
 */
export function withoutDeletedName(ref: ConsoleCustomerRef): ConsoleCustomerRef {
  return { ...ref, firstName: null, lastName: null };
}

/** The owning customer, or `null` for a guest booking (or one whose customer row is gone). */
function customerRefOf(row: {
  readonly customerId: string | null;
  readonly customerEmail: string | null;
  readonly customerFirstName: string | null;
  readonly customerLastName: string | null;
  readonly customerStatus: string | null;
}): ConsoleCustomerRef | null {
  if (row.customerId === null || row.customerEmail === null) {
    return null;
  }
  const ref: ConsoleCustomerRef = {
    id: row.customerId,
    email: row.customerEmail,
    firstName: row.customerFirstName,
    lastName: row.customerLastName,
  };
  // A deleted account keeps its row (and, until the purge, its names) for its bookings, but its names are not shown:
  // `null`, as the contract says of ConsoleCustomerRef (FIX-W32-OTA, lead decision (1f) of 2026-10-28; OBE-066's rule
  // of console.customers.get's recent bookings, `withoutDeletedName`). Its address is the `…@deleted.invalid`
  // placeholder already.
  return row.customerStatus === DELETED_CUSTOMER ? withoutDeletedName(ref) : ref;
}

// ---- console.bookings.list -----------------------------------------------------------------------------------------

/** A row of console.bookings.list. */
export function toConsoleBookingSummary(
  row: ConsoleBookingListRow,
  minorUnits: number,
  now: Date,
): ConsoleBookingSummary {
  const customer = customerRefOf(row);
  return {
    id: row.id,
    reference: row.reference,
    status: row.status as ConsoleBookingSummary["status"],
    channel: row.channel as ConsoleBookingSummary["channel"],
    environment: row.environment as ConsoleBookingSummary["environment"],
    recordLocator: row.recordLocator,
    amadeusOrderId: row.amadeusOrderId,
    customer,
    isGuest: row.customerId === null,
    leadTravelerName: row.leadTravelerName ?? row.leadLastName,
    travelersCount: row.travelersCount,
    tripType: (row.tripType ?? "one_way") as ConsoleBookingSummary["tripType"],
    originCode: row.originIata ?? "",
    destinationCode: row.destinationIata ?? "",
    departureAt: row.firstDepartureLocal,
    returnAt: row.returnLocal,
    validatingCarrier: row.validatingCarrier,
    ticketingStatus: row.ticketingStatus as ConsoleBookingSummary["ticketingStatus"],
    ticketingDeadlineAt: row.ticketingDeadlineAt?.toISOString() ?? null,
    paymentStatus: row.paymentStatus as ConsoleBookingSummary["paymentStatus"],
    total: money(row.totalAmount, row.currency, minorUnits),
    net: money(row.netAmount, row.currency, minorUnits),
    markup: money(row.markupAmount, row.currency, minorUnits),
    syncStatus: storedConsoleSyncStatusOf({ ...row, now }),
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    hasScheduleChange: row.hasScheduleChange,
    tags: [...row.tags],
    createdByStaffId: row.createdByStaffId,
    createdAt: row.createdAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

// ---- console.bookings.get: pieces ----------------------------------------------------------------------------------

/** How the selling total was built (ConsoleBookingPricing). */
export function toConsolePricing(
  booking: Pick<
    BookingRow,
    | "currency"
    | "pricingMode"
    | "netAmount"
    | "netBaseAmount"
    | "netFeesAmount"
    | "taxesAmount"
    | "markupAmount"
    | "feesAmount"
    | "cardFeeAmount"
    | "totalAmount"
  >,
  details: Pick<ConsoleBookingDetailsRow, "netServicesAmount" | "markupRuleId" | "markupRuleName">,
  minorUnits: number,
): ConsoleBookingPricing {
  const { currency } = booking;
  const amount = (value: MoneyValue | string) => money(value, currency, minorUnits);
  const selling = new Money(booking.totalAmount);
  const margin = selling.minus(booking.netAmount);
  return {
    currency,
    net: amount(booking.netAmount),
    netBase: amount(booking.netBaseAmount ?? "0"),
    netTaxes: amount(booking.taxesAmount),
    netFees: amount(booking.netFeesAmount ?? "0"),
    netServices: amount(details.netServicesAmount ?? "0"),
    markup: amount(booking.markupAmount),
    serviceFees: amount(booking.feesAmount),
    cardFees: new Money(booking.cardFeeAmount).isZero() ? null : amount(booking.cardFeeAmount),
    selling: amount(selling),
    margin: amount(margin),
    marginPercent: selling.isZero() ? "0.00" : margin.div(selling).times(100).toFixed(2),
    pricingMode: booking.pricingMode as ConsoleBookingPricing["pricingMode"],
    markupRuleId: details.markupRuleId,
    markupRuleName: details.markupRuleName,
  };
}

/** The stored `sync_changes` (order-diff.ts `syncChangesOf`) as ConsoleSyncChange entries; anything else is left out. */
export function syncDifferencesOf(value: unknown): ConsoleSyncChange[] {
  return records(value).flatMap((entry) => {
    const path = text(entry["path"]);
    const label = text(entry["label"]);
    return path === undefined || label === undefined || !path.startsWith("/")
      ? []
      : [{ path, label, before: entry["before"] ?? null, after: entry["after"] ?? null }];
  });
}

/**
 * The supplier sync block of the detail: `nextScheduledSyncAt` is when the background sync is due next
 * (bookings/sync-schedule.ts: every 6 h for upcoming trips, hourly in the 24 h before the ticketing deadline, never
 * within 30 minutes of a claim; `null` when it no longer reads the booking), `differences` what the last recorded
 * synchronisation changed, whichever path read the order (`bookings.sync_changes`, FIX-W27-SYNC).
 */
export function toSupplierSync(input: {
  readonly status: ConsoleBookingSyncStatus;
  readonly lastSyncedAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly syncError: string | null;
  readonly lastSupplierRequestId: string | null;
  readonly nextScheduledSyncAt: Date | null;
  /** `bookings.sync_changes`. */
  readonly differences: unknown;
}): ConsoleSupplierSync {
  return {
    status: input.status,
    lastSyncedAt: input.lastSyncedAt?.toISOString() ?? null,
    lastAttemptAt: input.lastAttemptAt?.toISOString() ?? null,
    lastError: input.syncError,
    lastSupplierRequestId: input.lastSupplierRequestId,
    nextScheduledSyncAt: input.nextScheduledSyncAt?.toISOString() ?? null,
    differences: syncDifferencesOf(input.differences),
  };
}

type CardBrand = NonNullable<ConsoleFormOfPayment["brand"]>;
type OtherPaymentMethod = NonNullable<ConsoleFormOfPayment["method"]>;

/** The card brands of the document (AmadeusCreditCardBrand); typed, so a name it does not have fails to compile. */
const CARD_BRANDS: ReadonlySet<string> = new Set<CardBrand>([
  "VISA",
  "AMERICAN_EXPRESS",
  "MASTERCARD",
  "VISA_ELECTRON",
  "VISA_DEBIT",
  "MASTERCARD_DEBIT",
  "MAESTRO",
  "DINERS",
  "EASYPAY",
]);
/** The other payment methods of the document (AmadeusOtherPaymentMethod). */
const OTHER_METHODS: ReadonlySet<string> = new Set<OtherPaymentMethod>([
  "ACCOUNT",
  "CHECK",
  "CASH",
  "NONREFUNDABLE",
  "PYTON",
]);
const isCardBrand = (value: string | undefined): value is CardBrand =>
  value !== undefined && CARD_BRANDS.has(value);
const isOtherPaymentMethod = (value: string | undefined): value is OtherPaymentMethod =>
  value !== undefined && OTHER_METHODS.has(value);

/** A stored (redacted) Amadeus form of payment as staff see it; `undefined` for an entry of no known kind. */
export function toConsoleFormOfPayment(entry: unknown): ConsoleFormOfPayment | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  for (const kind of ["creditCard", "other", "b2bWallet"] as const) {
    const value = entry[kind];
    if (!isRecord(value)) {
      continue;
    }
    const brand = text(value["brand"]);
    const number = text(value["number"]);
    const method = text(value["method"]);
    return {
      kind,
      brand: kind === "creditCard" && isCardBrand(brand) ? brand : null,
      // The stored number is the redactor's last 4 digits already; nothing longer is ever shown.
      last4: kind === "creditCard" && number !== undefined && /\d{4}$/.test(number) ? number.slice(-4) : null,
      holder: kind === "creditCard" ? (text(value["holder"]) ?? null) : null,
      expiryDate: kind === "creditCard" ? (text(value["expiryDate"]) ?? null) : null,
      method: kind === "other" && isOtherPaymentMethod(method) ? method : null,
      cardFriendlyName: kind === "b2bWallet" ? (text(value["cardFriendlyName"]) ?? null) : null,
      flightOfferIds: strings(value["flightOfferIds"]),
    };
  }
  return undefined;
}

/**
 * Forms of identification with their numbers cut to the last 4 characters (customer scope does the same): OBE-062's
 * projection, which the record step and the synchronisations also write since FIX-W27-SYNC (bookings/identifications.ts).
 */
export { maskedIdentifications };

/**
 * The stored order as staff see it (see the file header): the snapshot through the shared redactor, net prices and
 * every element kept, form of identification numbers cut; `null` without a snapshot with an order id.
 */
export function consoleOrderOf(snapshot: unknown, dictionaries: unknown): BookingAmadeus | null {
  if (!isRecord(snapshot)) {
    return null;
  }
  const data = structuredClone(redactPayload(snapshot));
  const flightOrderId = text(data["id"]);
  if (flightOrderId === undefined) {
    return null;
  }
  if (Array.isArray(data["formOfIdentifications"])) {
    data["formOfIdentifications"] = maskedIdentifications(data["formOfIdentifications"]);
  }
  return {
    flightOrderId,
    order: data as BookingAmadeus["order"],
    dictionaries: dictionariesOf(dictionaries),
  };
}

/** Every remark of the booking: staff ones, the customer's requests, and the system's (the Velexis back-office one). */
export function consoleRemarksOf(rows: readonly BookingRemarkRow[]): Remark[] {
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind === "airline" ? "airline" : "general",
    subType: row.subType as Remark["subType"],
    text: row.text,
    travelerIds: [...row.travelerIds],
    source:
      row.createdByStaffId !== null
        ? "staff"
        : row.visibleToCustomer &&
            !(row.subType === "BACKOFFICE" && row.text.startsWith(`${VELEXIS_REMARK_PREFIX} `))
          ? "customer"
          : "system",
    createdAt: row.createdAt.toISOString(),
  }));
}

const EVENT_ACTORS: ReadonlySet<string> = new Set([
  "staff",
  "api_key",
  "system",
  "customer",
  "guest",
  "supplier",
]);

/** Who caused an event, as far as the tenant tables tell. */
export function eventActorOf(
  row: Pick<ConsoleEventRow, "actorType" | "actorId" | "actorName">,
): ConsoleActor {
  const type = (EVENT_ACTORS.has(row.actorType) ? row.actorType : "system") as ConsoleActor["type"];
  const names: Partial<Record<ConsoleActor["type"], string>> = { system: "Velexis", supplier: "Amadeus" };
  return {
    type,
    id: type === "guest" || type === "system" || type === "supplier" ? null : row.actorId,
    name: type === "customer" ? row.actorName : (names[type] ?? null),
    email: null,
    role: null,
  };
}

/** A booking event in console scope (its data through the shared redactor). */
export function toConsoleEvent(row: ConsoleEventRow): ConsoleBookingEvent {
  return {
    id: row.id,
    type: row.type,
    actor: eventActorOf(row),
    summary: row.summary ?? row.type,
    statusFrom: row.statusFrom,
    statusTo: row.statusTo,
    visibleToCustomer: row.visibleToCustomer,
    supplierRequestId: row.supplierRequestId,
    data: isRecord(row.data) ? (redactPayload(row.data) as JsonObject) : {},
    createdAt: row.createdAt.toISOString(),
  };
}

/** A staff note (a `staff.note` event: its text is `data.text`, else the summary). */
export function toConsoleNote(row: ConsoleEventRow, bookingId: string): ConsoleBookingNote {
  const data = isRecord(row.data) ? row.data : {};
  return {
    id: row.id,
    bookingId,
    text: text(data["text"]) ?? row.summary ?? "",
    visibleToCustomer: row.visibleToCustomer,
    author: eventActorOf(row),
    createdAt: row.createdAt.toISOString(),
  };
}

const STAFF_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "agent", "finance", "viewer"]);

/** A staff action of the booking (no before or after). */
export function toConsoleStaffAction(row: ConsoleStaffActionRow): ConsoleStaffAction {
  const type: ConsoleActor["type"] =
    row.actorType === "api_key" ? "api_key" : row.actorType === "system" ? "system" : "staff";
  return {
    id: row.id,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    bookingId: row.bookingId,
    reason: row.reason,
    outcome: row.outcome as ConsoleStaffAction["outcome"],
    actor: {
      type,
      id: type === "system" ? null : row.actorId,
      name: type === "system" ? "Velexis" : null,
      email: type === "staff" ? row.staffEmail : null,
      role:
        type === "staff" && row.staffRole !== null && STAFF_ROLES.has(row.staffRole)
          ? (row.staffRole as NonNullable<ConsoleActor["role"]>)
          : null,
    },
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** An Amadeus call of the booking (no bodies). */
export function toConsoleSupplierRequest(row: ConsoleSupplierRequestRow): ConsoleSupplierRequest {
  return {
    id: row.id,
    environment: row.environment as ConsoleSupplierRequest["environment"],
    operation: row.operation,
    amadeusApi: row.amadeusApi as ConsoleSupplierRequest["amadeusApi"],
    amadeusOperationId: row.amadeusOperationId,
    httpMethod: row.httpMethod as ConsoleSupplierRequest["httpMethod"],
    path: row.path,
    officeId: row.officeId,
    httpStatus: row.httpStatus,
    outcome: row.outcome as ConsoleSupplierRequest["outcome"],
    errorCodes: [...row.errorCodes],
    durationMs: row.durationMs,
    correlationId: row.correlationId,
    requestId: row.requestId,
    bookingId: row.bookingId,
    searchId: row.searchId,
    staffId: row.staffId,
    redacted: row.redacted,
    truncated: row.truncated,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What `consoleActionsOf` weighs. */
export interface ConsoleActionsInput {
  readonly status: string;
  readonly ticketingStatus: string;
  readonly amadeusOrderId: string | null;
  readonly ticketingDeadlineAt: Date | null;
  readonly lastArrivalAt: Date;
  /** The booking's segments: their departure instants and Amadeus `isFlown` (the departure rule of canCancel). */
  readonly segments: readonly { readonly departureAt: Date; readonly isFlown: boolean }[];
  /** The last refresh claim or sync (`bookingDetails.lastRefreshAt`). */
  readonly lastRefreshAt: Date | null;
  readonly now: Date;
  /** Whether the caller holds a permission (the staff member's role, or a key-only call's scopes). */
  readonly can: (permission: StaffPermission) => boolean;
}

/** The console actions the caller may take on the booking now (see the file header). */
export function consoleActionsOf(input: ConsoleActionsInput): ConsoleBookingActions {
  const reasons: Record<string, ActionReason> = {};
  const now = input.now.getTime();
  const flown =
    input.lastArrivalAt.getTime() <= now ||
    (input.segments.length > 0 && input.segments.every((segment) => segment.isFlown));
  /** Why a booking without an order cannot be acted on at Amadeus, or `undefined` when it has one. */
  const withoutOrder = (): ActionReason | undefined => {
    if (input.status === "pending") {
      return "pending";
    }
    if (input.status === "failed") {
      return "failed";
    }
    return input.amadeusOrderId === null ? "no_amadeus_order" : undefined;
  };
  const decide = (action: string, permission: StaffPermission, reason: ActionReason | undefined): boolean => {
    const refused: ActionReason | undefined = input.can(permission) ? reason : "no_permission";
    if (refused !== undefined) {
      reasons[action] = refused;
    }
    return refused === undefined;
  };
  const live = (): ActionReason | undefined =>
    withoutOrder() ?? (input.status === "cancelled" ? "cancelled" : undefined);
  const issueReason = (): ActionReason | undefined => {
    const state = live();
    if (state !== undefined) {
      return state;
    }
    if (input.status === "ticketed" || input.ticketingStatus === "issued") {
      return "already_ticketed";
    }
    if (flown) {
      return "flown";
    }
    return input.ticketingDeadlineAt !== null && input.ticketingDeadlineAt.getTime() <= now
      ? "deadline_passed"
      : undefined;
  };
  const throttled =
    input.lastRefreshAt !== null && now - input.lastRefreshAt.getTime() < CONSOLE_REFRESH_THROTTLE_MS;
  return {
    canIssue: decide("canIssue", "bookings:issue", issueReason()),
    canPatch: decide("canPatch", "bookings:write", live()),
    // The one departure rule of every cancellation (bookings/allowed-actions.ts, FIX-W30-OTA), without the
    // self-service window, as console.bookings.cancel checks it: refused once any segment departed, not only landed.
    canCancel: decide(
      "canCancel",
      "bookings:cancel",
      live() ??
        // Without a window the rule answers `flown` or nothing.
        (cancelDepartureReasonOf(input.segments, input.now, STAFF_CANCEL_CUTOFF_MS) === undefined
          ? undefined
          : "flown"),
    ),
    canResync: decide("canResync", "bookings:write", withoutOrder() ?? (throttled ? "throttled" : undefined)),
    canRetrieve: decide("canRetrieve", "bookings:read", withoutOrder()),
    canAddNote: decide("canAddNote", "bookings:write", undefined),
    reasons,
  };
}

/** The failure of a failed booking, else `null`. */
export function failureOf(
  status: string,
  details: Pick<ConsoleBookingDetailsRow, "failureCode" | "failureMessage">,
): ConsoleBooking["failure"] {
  if (status !== "failed") {
    return null;
  }
  return {
    code: details.failureCode ?? "SUPPLIER_ERROR",
    message: details.failureMessage ?? "The booking could not be created with the airline.",
    supplier: null,
  };
}

/** Everything the console detail adds to the customer-shaped booking. */
export interface ConsoleDetailsInput {
  readonly booking: BookingRow;
  readonly details: ConsoleBookingDetailsRow;
  readonly minorUnits: number;
  readonly supplierSync: ConsoleSupplierSync;
  readonly events: readonly ConsoleEventRow[];
  readonly notes: readonly ConsoleEventRow[];
  readonly supplierRequests: readonly ConsoleSupplierRequestRow[];
  readonly staffActions: readonly ConsoleStaffActionRow[];
  readonly consoleActions: ConsoleBookingActions;
}

/** The booking in console scope: the customer-shaped `base` (see the file header) and the console-only details. */
export function toConsoleBooking(base: Booking, input: ConsoleDetailsInput): ConsoleBooking {
  const { booking, details } = input;
  return {
    ...base,
    environment: booking.environment as ConsoleBooking["environment"],
    amadeusOrderId: booking.amadeusOrderId,
    queuingOfficeId: booking.queuingOfficeId,
    ownerOfficeId: booking.ownerOfficeId,
    createdByStaffId: details.createdByStaffId,
    checkoutId: booking.checkoutId,
    pricedOfferId: booking.pricedOfferId,
    customer: customerRefOf({ customerId: booking.customerId, ...details }),
    contactEmail: booking.contactEmail,
    pricing: toConsolePricing(booking, details, input.minorUnits),
    paymentStatus: details.paymentStatus as ConsoleBooking["paymentStatus"],
    supplierSync: input.supplierSync,
    ticketingAgreement: isRecord(details.ticketingAgreement)
      ? (details.ticketingAgreement as ConsoleBooking["ticketingAgreement"])
      : null,
    automatedProcess: records(details.automatedProcess) as ConsoleBooking["automatedProcess"],
    formOfPayments: records(details.formOfPayments).flatMap((entry) => toConsoleFormOfPayment(entry) ?? []),
    commissions: records(details.commissions) as ConsoleBooking["commissions"],
    formOfIdentifications: maskedIdentifications(
      details.formOfIdentifications,
    ) as ConsoleBooking["formOfIdentifications"],
    issueRequested: booking.issueRequested,
    notes: input.notes.map((row) => toConsoleNote(row, booking.id)),
    events: input.events.map(toConsoleEvent),
    recentSupplierRequests: input.supplierRequests.map(toConsoleSupplierRequest),
    recentStaffActions: input.staffActions.map(toConsoleStaffAction),
    consoleActions: input.consoleActions,
    failure: failureOf(booking.status, details),
    tags: [...details.tags],
  };
}
