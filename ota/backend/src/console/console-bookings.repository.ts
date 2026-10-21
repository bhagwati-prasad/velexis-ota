// The console reads of bookings (OBE-061; ota/docs/flows/console-operations.md §2 "Bookings list and detail" and §3
// step 3, db README §10 "B4 Console"): every booking of the OTA in one environment, and what the console detail shows
// beside the rows BookingsRepository reads for the customer view.
//
// - `list` and `count`: console.bookings.list. Every query leads with `b.environment` (the console indexes do), then
//   the document's filters, AND-ed (list values OR-ed): status, ticketing status, ticketing deadline before, record
//   locator (the main one or any associated record), reference, customer, customer or contact e-mail (exact, any
//   case), traveller last name (prefix, any case and accent), first departure (local date), creation time, derived
//   payment state, channel, validating carrier, creating staff member, tag (GIN), free text, and the needs-attention
//   filters: reconciliation outcome (`bookings.reconcile_outcome`), an open cancellation request (a
//   `booking.cancellation_requested` event of a booking that is not cancelled) and a schedule change (a
//   `booking.schedule_changed` event, the row's `hasScheduleChange`). Sorts by creation, first departure, ticketing
//   deadline (nulls last in both directions) or selling total, with the id as tie-breaker, after a keyset position: the
//   sort key as text (UTC with microseconds for instants, the numeric's own text for totals, `null` for a booking
//   without a deadline). `count` stops at 10 001 rows (totalCount is exact up to 10 000).
// - The derived payment state (ConsolePaymentStatus) is computed from the booking's `payments` (their captured and
//   refunded amounts, which the refund webhooks keep): no payment → `unpaid` for a storefront booking, `not_applicable`
//   for console and imported ones (paid offline); anything captured → `refunded`, `partially_refunded` or `paid`; else
//   an authorisation → `authorized`; else only failed attempts → `failed`; else `unpaid` (an attempt in progress, a
//   voided authorisation).
// - `details`, `events`, `notes`, `supplierRequests`, `staffActions`, `lastOrderRead`: the console-only columns of one
//   booking (offices, net amounts, markup rule, ticketing agreement, automated processes, redacted forms of payment,
//   commissions, forms of identification, failure, tags), its whole timeline (staff-only events included), its staff
//   notes (`staff.note` events), the last Amadeus calls without their bodies, the last staff actions without their
//   before and after, and the last Flight Order Management GET.
//
// Like every tenant repository it takes the `tenantTx` transaction first, never opens one and never names a tenant
// schema. Amounts are read as text, local date-times through `to_char`.
import { Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** A SQL fragment of type `T` (Kysely's RawBuilder, which @velexis/db does not re-export by name). */
type RawBuilder<T> = ReturnType<typeof sql.raw<T>>;

/** The sort orders of console.bookings.list. */
export type ConsoleBookingSort =
  | "created"
  | "-created"
  | "departure"
  | "-departure"
  | "ticketingDeadline"
  | "-ticketingDeadline"
  | "total"
  | "-total";

/** The filters of console.bookings.list, as validated (list values non-empty when present). */
export interface ConsoleBookingFilters {
  readonly status?: readonly string[] | undefined;
  readonly ticketingStatus?: readonly string[] | undefined;
  /** ISO-8601 instant. */
  readonly ticketingDeadlineBefore?: string | undefined;
  readonly recordLocator?: string | undefined;
  readonly reference?: string | undefined;
  readonly customerId?: string | undefined;
  readonly customerEmail?: string | undefined;
  /** Already folded: upper case, no accents (`foldName`). */
  readonly travelerLastName?: string | undefined;
  /** `YYYY-MM-DD`, local date of the first departure, inclusive. */
  readonly departureFrom?: string | undefined;
  readonly departureTo?: string | undefined;
  /** ISO-8601 instants: `createdFrom` inclusive, `createdTo` exclusive. */
  readonly createdFrom?: string | undefined;
  readonly createdTo?: string | undefined;
  readonly paymentStatus?: readonly string[] | undefined;
  readonly source?: readonly string[] | undefined;
  readonly validatingCarrier?: string | undefined;
  readonly createdByStaffId?: string | undefined;
  readonly tag?: string | undefined;
  readonly reconcileOutcome?: readonly string[] | undefined;
  readonly cancellationRequested?: boolean | undefined;
  readonly hasScheduleChange?: boolean | undefined;
  readonly q?: string | undefined;
}

/** One page of console.bookings.list. */
export interface ConsoleBookingListQuery extends ConsoleBookingFilters {
  readonly environment: string;
  readonly sort: ConsoleBookingSort;
  /** The keyset position of the previous page: its last row's sort key (`null`: no deadline) and id. */
  readonly after?: { readonly key: string | null; readonly id: string } | undefined;
  /** Rows to read (the page size plus one). */
  readonly limit: number;
}

/** A row of the console list (ConsoleBookingSummary before mapping). */
export interface ConsoleBookingListRow {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly channel: string;
  readonly environment: string;
  readonly recordLocator: string | null;
  readonly amadeusOrderId: string | null;
  readonly customerId: string | null;
  readonly customerEmail: string | null;
  readonly customerFirstName: string | null;
  readonly customerLastName: string | null;
  /** `FIRST LAST` of the lead traveller, or `null` before the order is recorded. */
  readonly leadTravelerName: string | null;
  readonly leadLastName: string;
  readonly travelersCount: number;
  readonly tripType: string | null;
  readonly originIata: string | null;
  readonly destinationIata: string | null;
  /** `YYYY-MM-DDTHH:MM:SS`: the first segment's local departure, else the first departure in the origin's zone. */
  readonly firstDepartureLocal: string;
  /** The local departure of the last bound of a trip with more than one, else `null`. */
  readonly returnLocal: string | null;
  readonly validatingCarrier: string | null;
  readonly ticketingStatus: string;
  readonly ticketingDeadlineAt: Date | null;
  readonly paymentStatus: string;
  readonly currency: string;
  readonly totalAmount: string;
  readonly netAmount: string;
  readonly markupAmount: string;
  readonly lastSyncedAt: Date | null;
  readonly syncError: string | null;
  readonly hasScheduleChange: boolean;
  readonly tags: string[];
  readonly createdByStaffId: string | null;
  readonly createdAt: Date;
  readonly cancelledAt: Date | null;
  /** The sort key as text (see the file header); `null` for a booking without a deadline. */
  readonly sortKey: string | null;
}

/** The console-only columns of one booking. */
export interface ConsoleBookingDetailsRow {
  readonly environment: string;
  readonly createdByStaffId: string | null;
  readonly netServicesAmount: string | null;
  readonly markupRuleId: string | null;
  readonly markupRuleName: string | null;
  readonly ticketingAgreement: unknown;
  readonly automatedProcess: unknown;
  readonly formOfPayments: unknown;
  readonly commissions: unknown;
  readonly formOfIdentifications: unknown;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly tags: string[];
  readonly paymentStatus: string;
  readonly customerEmail: string | null;
  readonly customerFirstName: string | null;
  readonly customerLastName: string | null;
}

/** A `booking_events` row as staff see it, with the name of a customer actor. */
export interface ConsoleEventRow {
  readonly id: string;
  readonly type: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly statusFrom: string | null;
  readonly statusTo: string | null;
  readonly summary: string | null;
  readonly data: unknown;
  readonly visibleToCustomer: boolean;
  readonly supplierRequestId: string | null;
  readonly createdAt: Date;
}

/** A `supplier_requests` row without its bodies. */
export interface ConsoleSupplierRequestRow {
  readonly id: string;
  readonly environment: string;
  readonly operation: string;
  readonly amadeusApi: string;
  readonly amadeusOperationId: string;
  readonly httpMethod: string;
  readonly path: string;
  readonly officeId: string | null;
  readonly httpStatus: number | null;
  readonly outcome: string;
  readonly errorCodes: number[];
  readonly durationMs: number | null;
  readonly correlationId: string | null;
  readonly requestId: string | null;
  readonly bookingId: string | null;
  readonly searchId: string | null;
  readonly staffId: string | null;
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly createdAt: Date;
}

/** A `staff_actions` row without its before and after. */
export interface ConsoleStaffActionRow {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly staffEmail: string | null;
  readonly staffRole: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly bookingId: string | null;
  readonly reason: string | null;
  readonly outcome: string;
  readonly requestId: string | null;
  readonly createdAt: Date;
}

/** The event types the needs-attention filters and `hasScheduleChange` read. */
export const SCHEDULE_CHANGED_EVENT = "booking.schedule_changed";
export const CANCELLATION_REQUESTED_EVENT = "booking.cancellation_requested";
/** The event type of a staff note (console.bookings.addNote, OBE-062): the text is `data.text`. */
export const STAFF_NOTE_EVENT = "staff.note";

/** How many events, Amadeus calls and staff actions the detail shows (the document's limits). */
export const DETAIL_LIMITS = Object.freeze({
  events: 100,
  notes: 100,
  supplierRequests: 20,
  staffActions: 20,
});

/** totalCount is exact up to this many rows, `null` above. */
export const TOTAL_COUNT_LIMIT = 10_000;

/** The local date-time text of a `timestamp` column. */
const LOCAL_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS`;

/** The letters without a decomposition that a name is folded from, and what they become. */
const UNDECOMPOSED: Readonly<Record<string, string>> = Object.freeze({ ø: "o", ł: "l", ı: "i", đ: "d" });

/** A letter without its accents (`é` → `e`). */
const unaccented = (letter: string): string =>
  UNDECOMPOSED[letter] ?? letter.normalize("NFD").replace(/\p{M}/gu, "");

/**
 * The accented lower-case letters a traveller's last name is folded from in SQL (`translate`), and the letter each
 * becomes: the stored names are Amadeus names (A–Z), so this only matters for rows written otherwise.
 */
const ACCENTED = "àáâãäåāăąçćčďđèéêëēėęěğìíîïīįıłñńňòóôõöøōőŕřśšşţťùúûüūůűųýÿźżž";
const UNACCENTED = [...ACCENTED].map(unaccented).join("");

/** `value` with the LIKE wildcards escaped (the default escape character is the backslash). */
const likePrefix = (value: string): string => `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/** The local first departure of booking `b` (see ConsoleBookingListRow). */
const firstDepartureLocalOf = sql<string>`coalesce(
  (SELECT to_char(s.departure_local, ${LOCAL_FORMAT}) FROM booking_segments s
    WHERE s.booking_id = b.id ORDER BY s.itinerary_index, s.segment_index LIMIT 1),
  to_char(b.first_departure_at AT TIME ZONE coalesce(
    (SELECT a.time_zone FROM reference.airports a WHERE a.iata_code = b.origin_iata), 'UTC'), ${LOCAL_FORMAT})
)`;

/** The derived payment state of booking `b` (see the file header). */
const paymentStatusOf = sql<string>`(
  SELECT CASE
    WHEN count(p.id) = 0 THEN CASE WHEN b.channel = 'storefront' THEN 'unpaid' ELSE 'not_applicable' END
    WHEN sum(p.amount_captured) > 0 AND sum(p.amount_refunded) >= sum(p.amount_captured) THEN 'refunded'
    WHEN sum(p.amount_captured) > 0 AND sum(p.amount_refunded) > 0 THEN 'partially_refunded'
    WHEN sum(p.amount_captured) > 0 THEN 'paid'
    WHEN bool_or(p.status = 'authorized') THEN 'authorized'
    WHEN bool_and(p.status = 'failed') THEN 'failed'
    ELSE 'unpaid'
  END
  FROM payments p WHERE p.booking_id = b.id
)`;

const hasEvent = (type: string) =>
  sql<boolean>`EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.type = ${type})`;

/** An open cancellation request of booking `b`. */
const cancellationRequestedOf = sql<boolean>`(b.status <> 'cancelled' AND ${hasEvent(CANCELLATION_REQUESTED_EVENT)})`;

/** The columns of the sorts, and how their keys are compared. */
const SORT_COLUMNS = Object.freeze({
  created: { column: "b.created_at", kind: "instant" },
  departure: { column: "b.first_departure_at", kind: "instant" },
  ticketingDeadline: { column: "b.ticketing_deadline_at", kind: "nullable_instant" },
  total: { column: "b.total_amount", kind: "amount" },
} as const);

type SortField = keyof typeof SORT_COLUMNS;

/** The field and direction of a sort. */
export function sortOf(sort: ConsoleBookingSort): { readonly field: SortField; readonly desc: boolean } {
  const desc = sort.startsWith("-");
  return { field: (desc ? sort.slice(1) : sort) as SortField, desc };
}

/** The sort key of booking `b` as text (see the file header). */
function sortKeyOf(field: SortField): RawBuilder<string | null> {
  const { column, kind } = SORT_COLUMNS[field];
  return kind === "amount"
    ? sql<string>`${sql.ref(column)}::text`
    : sql<string | null>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
}

/** `upper` without accents: how traveller last names and the free text are compared. */
export function foldName(value: string): string {
  return [...value.toLowerCase()].map(unaccented).join("").toUpperCase();
}

/** The conditions of `filters` on booking `b` (environment excluded). */
function conditionsOf(filters: ConsoleBookingFilters): RawBuilder<boolean>[] {
  const conditions: RawBuilder<boolean>[] = [];
  const list = (values: readonly string[] | undefined) =>
    values !== undefined && values.length > 0 ? [...values] : undefined;
  const status = list(filters.status);
  if (status !== undefined) {
    conditions.push(sql<boolean>`b.status = ANY(${status}::text[])`);
  }
  const ticketingStatus = list(filters.ticketingStatus);
  if (ticketingStatus !== undefined) {
    conditions.push(sql<boolean>`b.ticketing_status = ANY(${ticketingStatus}::text[])`);
  }
  if (filters.ticketingDeadlineBefore !== undefined) {
    conditions.push(sql<boolean>`b.ticketing_deadline_at < ${filters.ticketingDeadlineBefore}::timestamptz`);
  }
  if (filters.recordLocator !== undefined) {
    conditions.push(sql<boolean>`(b.record_locator = ${filters.recordLocator} OR EXISTS (
      SELECT 1 FROM booking_associated_records r WHERE r.booking_id = b.id AND r.reference = ${filters.recordLocator}
    ))`);
  }
  if (filters.reference !== undefined) {
    conditions.push(sql<boolean>`b.reference = ${filters.reference}`);
  }
  if (filters.customerId !== undefined) {
    conditions.push(sql<boolean>`b.customer_id = ${filters.customerId}`);
  }
  if (filters.customerEmail !== undefined) {
    const email = filters.customerEmail.toLowerCase();
    conditions.push(sql<boolean>`(lower(b.contact_email) = ${email} OR EXISTS (
      SELECT 1 FROM customers c WHERE c.id = b.customer_id AND lower(c.email) = ${email}
    ))`);
  }
  if (filters.travelerLastName !== undefined) {
    const prefix = likePrefix(filters.travelerLastName.toLowerCase());
    conditions.push(sql<boolean>`EXISTS (
      SELECT 1 FROM booking_travelers t
      WHERE t.booking_id = b.id AND translate(lower(t.last_name), ${ACCENTED}, ${UNACCENTED}) LIKE ${prefix}
    )`);
  }
  if (filters.departureFrom !== undefined) {
    conditions.push(sql<boolean>`(${firstDepartureLocalOf})::date >= ${filters.departureFrom}::date`);
  }
  if (filters.departureTo !== undefined) {
    conditions.push(sql<boolean>`(${firstDepartureLocalOf})::date <= ${filters.departureTo}::date`);
  }
  if (filters.createdFrom !== undefined) {
    conditions.push(sql<boolean>`b.created_at >= ${filters.createdFrom}::timestamptz`);
  }
  if (filters.createdTo !== undefined) {
    conditions.push(sql<boolean>`b.created_at < ${filters.createdTo}::timestamptz`);
  }
  const paymentStatus = list(filters.paymentStatus);
  if (paymentStatus !== undefined) {
    conditions.push(sql<boolean>`${paymentStatusOf} = ANY(${paymentStatus}::text[])`);
  }
  const source = list(filters.source);
  if (source !== undefined) {
    conditions.push(sql<boolean>`b.channel = ANY(${source}::text[])`);
  }
  if (filters.validatingCarrier !== undefined) {
    conditions.push(sql<boolean>`b.validating_carrier = ${filters.validatingCarrier}`);
  }
  if (filters.createdByStaffId !== undefined) {
    conditions.push(sql<boolean>`b.created_by_staff_id = ${filters.createdByStaffId}`);
  }
  if (filters.tag !== undefined) {
    conditions.push(sql<boolean>`b.tags @> ARRAY[${filters.tag}]::text[]`);
  }
  const reconcileOutcome = list(filters.reconcileOutcome);
  if (reconcileOutcome !== undefined) {
    conditions.push(sql<boolean>`b.reconcile_outcome = ANY(${reconcileOutcome}::text[])`);
  }
  if (filters.cancellationRequested !== undefined) {
    conditions.push(
      filters.cancellationRequested ? cancellationRequestedOf : sql<boolean>`NOT ${cancellationRequestedOf}`,
    );
  }
  if (filters.hasScheduleChange !== undefined) {
    const changed = hasEvent(SCHEDULE_CHANGED_EVENT);
    conditions.push(filters.hasScheduleChange ? changed : sql<boolean>`NOT ${changed}`);
  }
  if (filters.q !== undefined) {
    const upper = likePrefix(foldName(filters.q));
    const lower = likePrefix(filters.q.toLowerCase());
    conditions.push(sql<boolean>`(
      b.reference LIKE ${upper}
      OR b.record_locator LIKE ${upper}
      OR EXISTS (SELECT 1 FROM booking_associated_records r WHERE r.booking_id = b.id AND r.reference LIKE ${upper})
      OR lower(b.contact_email) LIKE ${lower}
      OR b.lead_last_name LIKE ${upper}
    )`);
  }
  return conditions;
}

/** The keyset condition after `after` for `sort` (see the file header). */
function afterCondition(
  sort: ConsoleBookingSort,
  after: { readonly key: string | null; readonly id: string },
): RawBuilder<boolean> {
  const { field, desc } = sortOf(sort);
  const { column, kind } = SORT_COLUMNS[field];
  const comparison = sql.raw(desc ? "<" : ">");
  const ref = sql.ref(column);
  if (kind === "amount") {
    return sql<boolean>`(${ref}, b.id) ${comparison} (${after.key}::numeric, ${after.id})`;
  }
  if (kind === "instant") {
    return sql<boolean>`(${ref}, b.id) ${comparison} (${after.key}::timestamp AT TIME ZONE 'UTC', ${after.id})`;
  }
  // Nulls last in both directions: after a dated row come the later (earlier) dated rows, then every undated one;
  // after an undated row only undated rows with a greater (smaller) id.
  if (after.key === null) {
    return sql<boolean>`(${ref} IS NULL AND b.id ${comparison} ${after.id})`;
  }
  return sql<boolean>`(${ref} IS NULL OR (${ref}, b.id) ${comparison} (${after.key}::timestamp AT TIME ZONE 'UTC', ${after.id}))`;
}

@Injectable()
export class ConsoleBookingsRepository {
  /** One page of the console list (see the file header). */
  async list(trx: TenantTransaction, query: ConsoleBookingListQuery): Promise<ConsoleBookingListRow[]> {
    const { field, desc } = sortOf(query.sort);
    const { column, kind } = SORT_COLUMNS[field];
    const direction = desc ? "desc" : "asc";
    const conditions = conditionsOf(query);
    if (query.after !== undefined) {
      conditions.push(afterCondition(query.sort, query.after));
    }
    let select = trx
      .selectFrom("bookings as b")
      .leftJoin("customers as c", "c.id", "b.customer_id")
      .select([
        "b.id as id",
        "b.reference as reference",
        "b.status as status",
        "b.channel as channel",
        "b.environment as environment",
        "b.record_locator as recordLocator",
        "b.amadeus_order_id as amadeusOrderId",
        "b.customer_id as customerId",
        "c.email as customerEmail",
        "c.first_name as customerFirstName",
        "c.last_name as customerLastName",
        "b.lead_last_name as leadLastName",
        "b.travelers_count as travelersCount",
        "b.trip_type as tripType",
        "b.validating_carrier as validatingCarrier",
        "b.ticketing_status as ticketingStatus",
        "b.ticketing_deadline_at as ticketingDeadlineAt",
        "b.last_synced_at as lastSyncedAt",
        "b.sync_error as syncError",
        "b.tags as tags",
        "b.created_by_staff_id as createdByStaffId",
        "b.created_at as createdAt",
        "b.cancelled_at as cancelledAt",
        sql<string | null>`b.origin_iata::text`.as("originIata"),
        sql<string | null>`b.destination_iata::text`.as("destinationIata"),
        sql<string>`b.currency::text`.as("currency"),
        sql<string>`b.total_amount::text`.as("totalAmount"),
        sql<string>`b.net_amount::text`.as("netAmount"),
        sql<string>`b.markup_amount::text`.as("markupAmount"),
        sql<string | null>`(
          SELECT t.first_name || ' ' || t.last_name FROM booking_travelers t WHERE t.booking_id = b.id
          ORDER BY t.traveler_type <> 'ADULT', length(t.amadeus_traveler_id), t.amadeus_traveler_id LIMIT 1
        )`.as("leadTravelerName"),
        firstDepartureLocalOf.as("firstDepartureLocal"),
        sql<string | null>`(
          SELECT to_char(s.departure_local, ${LOCAL_FORMAT}) FROM booking_segments s
          WHERE s.booking_id = b.id AND s.itinerary_index > 0
          ORDER BY s.itinerary_index DESC, s.segment_index LIMIT 1
        )`.as("returnLocal"),
        paymentStatusOf.as("paymentStatus"),
        hasEvent(SCHEDULE_CHANGED_EVENT).as("hasScheduleChange"),
        sortKeyOf(field).as("sortKey"),
      ])
      .where("b.environment", "=", query.environment);
    if (conditions.length > 0) {
      select = select.where(sql<boolean>`${sql.join(conditions, sql` AND `)}`);
    }
    const ordered =
      kind === "nullable_instant"
        ? select.orderBy(sql`${sql.ref(column)} ${sql.raw(direction)} NULLS LAST`)
        : select.orderBy(sql.ref(column), direction);
    return await ordered.orderBy("b.id", direction).limit(query.limit).execute();
  }

  /** How many bookings `filters` match in `environment`, counted up to TOTAL_COUNT_LIMIT + 1. */
  async count(trx: TenantTransaction, environment: string, filters: ConsoleBookingFilters): Promise<number> {
    const conditions = conditionsOf(filters);
    let inner = trx
      .selectFrom("bookings as b")
      .select(sql<number>`1`.as("one"))
      .where("b.environment", "=", environment);
    if (conditions.length > 0) {
      inner = inner.where(sql<boolean>`${sql.join(conditions, sql` AND `)}`);
    }
    const row = await trx
      .selectFrom(inner.limit(TOTAL_COUNT_LIMIT + 1).as("matching"))
      .select(sql<number>`count(*)::int`.as("count"))
      .executeTakeFirstOrThrow();
    return row.count;
  }

  /** The environment of booking `id`, or `undefined` when there is none. */
  async environmentOf(trx: TenantTransaction, id: string): Promise<string | undefined> {
    const row = await trx
      .selectFrom("bookings")
      .select("environment")
      .where("id", "=", id)
      .executeTakeFirst();
    return row?.environment;
  }

  /** The console-only columns of booking `id` (see the file header); `undefined` when there is none. */
  async details(trx: TenantTransaction, id: string): Promise<ConsoleBookingDetailsRow | undefined> {
    return await trx
      .selectFrom("bookings as b")
      .leftJoin("customers as c", "c.id", "b.customer_id")
      .leftJoin("markup_rules as m", "m.id", "b.markup_rule_id")
      .select([
        "b.environment as environment",
        "b.created_by_staff_id as createdByStaffId",
        "b.markup_rule_id as markupRuleId",
        "m.name as markupRuleName",
        "b.ticketing_agreement as ticketingAgreement",
        "b.automated_process as automatedProcess",
        "b.form_of_payments as formOfPayments",
        "b.commissions as commissions",
        "b.form_of_identifications as formOfIdentifications",
        "b.failure_code as failureCode",
        "b.failure_message as failureMessage",
        "b.tags as tags",
        "c.email as customerEmail",
        "c.first_name as customerFirstName",
        "c.last_name as customerLastName",
        sql<string | null>`b.net_services_amount::text`.as("netServicesAmount"),
        paymentStatusOf.as("paymentStatus"),
      ])
      .where("b.id", "=", id)
      .executeTakeFirst();
  }

  /** The booking's events, newest first, `limit` at most; `types` narrows them. */
  async events(
    trx: TenantTransaction,
    bookingId: string,
    page: { readonly limit: number; readonly types?: readonly string[] | undefined },
  ): Promise<ConsoleEventRow[]> {
    let select = trx
      .selectFrom("booking_events as e")
      .leftJoin("customers as c", (join) =>
        join.onRef("c.id", "=", "e.actor_id").on("e.actor_type", "=", "customer"),
      )
      .select([
        "e.id as id",
        "e.type as type",
        "e.actor_type as actorType",
        "e.actor_id as actorId",
        "e.status_from as statusFrom",
        "e.status_to as statusTo",
        "e.summary as summary",
        "e.data as data",
        "e.visible_to_customer as visibleToCustomer",
        "e.supplier_request_id as supplierRequestId",
        "e.created_at as createdAt",
        sql<string | null>`nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')`.as("actorName"),
      ])
      .where("e.booking_id", "=", bookingId);
    if (page.types !== undefined) {
      select = select.where("e.type", "in", [...page.types]);
    }
    return await select.orderBy("e.created_at", "desc").orderBy("e.id", "desc").limit(page.limit).execute();
  }

  /** The booking's last Amadeus calls, newest first, without their bodies. */
  async supplierRequests(
    trx: TenantTransaction,
    bookingId: string,
    limit: number,
  ): Promise<ConsoleSupplierRequestRow[]> {
    return await trx
      .selectFrom("supplier_requests")
      .select([
        "id",
        "environment",
        "operation",
        "amadeus_api as amadeusApi",
        "amadeus_operation_id as amadeusOperationId",
        "http_method as httpMethod",
        "path",
        "office_id as officeId",
        "http_status as httpStatus",
        "outcome",
        "error_codes as errorCodes",
        "duration_ms as durationMs",
        "correlation_id as correlationId",
        "request_id as requestId",
        "booking_id as bookingId",
        "search_id as searchId",
        "staff_id as staffId",
        "redacted",
        "truncated",
        "created_at as createdAt",
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
  }

  /** The id of the booking's last Flight Order Management GET (a sync attempt), or `null`. */
  async lastOrderRead(trx: TenantTransaction, bookingId: string): Promise<string | null> {
    const row = await trx
      .selectFrom("supplier_requests")
      .select("id")
      .where("booking_id", "=", bookingId)
      .where("amadeus_api", "=", "FlightOrderManagement")
      .where("http_method", "=", "GET")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /** The booking's last staff actions, newest first, without their before and after. */
  async staffActions(
    trx: TenantTransaction,
    bookingId: string,
    limit: number,
  ): Promise<ConsoleStaffActionRow[]> {
    return await trx
      .selectFrom("staff_actions")
      .select([
        "id",
        "actor_type as actorType",
        "actor_id as actorId",
        "staff_email as staffEmail",
        "staff_role as staffRole",
        "action",
        "target_type as targetType",
        "target_id as targetId",
        "booking_id as bookingId",
        "reason",
        "outcome",
        "request_id as requestId",
        "created_at as createdAt",
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
  }
}
