// The tenant repository of bookings (OBE-042; ota/docs/data-model.md §2, db README §2.1, tenant migration 0002 §3):
// `bookings` and their children (`booking_associated_records`, `booking_travelers`, `booking_contacts`,
// `booking_segments`, `booking_tickets`, `booking_ancillaries`, `booking_remarks`) and the append-only
// `booking_events`, which the bookings module owns, plus what the orchestration reads or changes of tables it does not
// own: the storefront settings a booking follows, the checkout's pricing mode and its status once completed, a
// payment's link to its booking, and the time zones of airports (local Amadeus times become instants in SQL, `AT TIME
// ZONE`). The checkout and payment rows themselves are read through CheckoutRepository and PaymentsRepository.
//
// The customer reads (OBE-046, db README §10 "My trips"): a customer's bookings of one environment by tab on the
// partial indexes `bookings_customer_{upcoming,past,cancelled}_idx`, with keyset positions as UTC text with
// microseconds (a JavaScript Date would lose them and skip or repeat rows); the booking access guard's read (the
// booking's environment and customer, and whether a presented guest token hash is a live `booking_access_tokens` row
// of it, and since OBE-047 the use it records on that row); the list card of one booking (bookings.lookup's answer,
// OBE-047); the customer-visible events; the services, refunds and current documents of a booking; and what a refresh
// claims and writes (`bookings.sync_claimed_at` is the claim and, with `last_synced_at`, the throttle since FIX-W27-SYNC;
// before, `booking.sync_requested` events were; the record step of every synchronisation is booking-sync.service.ts's).
// City names come from `reference.airports` and `reference.cities`.
//
// Like every tenant repository it takes the `tenantTx` transaction first, never opens one and never names a tenant
// schema. Amounts are read as text (`numeric::text`), dates and local date-times through `to_char`, never as
// JavaScript numbers or local-time dates; jsonb is written as JSON text.
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase, type Updateable } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

type Db = TenantDatabase;

/** What the orchestration reads of `storefront_settings`. */
export interface BookingSettingsRow {
  readonly ticketingPolicy: string;
  readonly paymentTiming: string;
  /** IANA time zone of the OTA (the ticketing deadline, OADR-0008 point 3). */
  readonly timeZone: string;
  readonly bookingQueueNumber: number | null;
  readonly bookingQueueCategory: number;
  readonly defaultLocale: string;
}

/** What the orchestration reads of a checkout besides CheckoutRepository's row. */
export interface CheckoutExtrasRow {
  readonly pricingMode: string;
  readonly createdByStaffId: string | null;
}

/** A `bookings` row. */
export interface BookingRow {
  readonly id: string;
  readonly environment: string;
  readonly reference: string;
  readonly channel: string;
  readonly customerId: string | null;
  readonly checkoutId: string | null;
  readonly pricedOfferId: string | null;
  readonly status: string;
  readonly amadeusOrderId: string | null;
  readonly recordLocator: string | null;
  readonly originSystemCode: string | null;
  readonly supplierConnectionId: string | null;
  readonly queuingOfficeId: string | null;
  readonly ownerOfficeId: string | null;
  /** `YYYY-MM-DD`. */
  readonly lastTicketingDate: string | null;
  readonly ticketingDeadlineAt: Date | null;
  readonly issueRequested: boolean;
  readonly issuedAt: Date | null;
  readonly ticketingStatus: string;
  readonly ticketingAttempts: number;
  readonly ticketingNextAttemptAt: Date | null;
  readonly tripType: string | null;
  readonly originIata: string | null;
  readonly destinationIata: string | null;
  readonly firstDepartureAt: Date;
  readonly lastArrivalAt: Date;
  readonly validatingCarrier: string | null;
  readonly travelersCount: number;
  readonly currency: string;
  readonly pricingMode: string;
  readonly netAmount: string;
  readonly netBaseAmount: string | null;
  readonly netFeesAmount: string | null;
  readonly markupAmount: string;
  readonly feesAmount: string;
  readonly cardFeeAmount: string;
  readonly ancillariesAmount: string;
  readonly taxesAmount: string;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly amountRefunded: string;
  readonly contactEmail: string;
  readonly leadLastName: string;
  readonly failureCode: string | null;
  readonly metadata: unknown;
  readonly lastSyncedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly createOrderStartedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A `booking_travelers` row. */
export interface BookingTravelerRow {
  readonly id: string;
  readonly amadeusTravelerId: string;
  readonly travelerType: string;
  readonly associatedAdultId: string | null;
  readonly savedTravelerId: string | null;
  readonly firstName: string;
  readonly middleName: string | null;
  readonly lastName: string;
  readonly secondLastName: string | null;
  /** `YYYY-MM-DD`. */
  readonly dateOfBirth: string | null;
  readonly gender: string | null;
  readonly contact: unknown;
  readonly documentsCiphertext: Buffer | null;
  readonly discountEligibilityCiphertext: Buffer | null;
  readonly loyaltyPrograms: unknown;
  readonly emergencyContact: unknown;
}

/** A `booking_contacts` row. */
export interface BookingContactRow {
  readonly id: string;
  readonly purpose: string;
  readonly isPrimary: boolean;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly phones: unknown;
  readonly address: unknown;
  readonly language: string | null;
}

/** A `booking_segments` row; local times as `YYYY-MM-DDTHH:MM:SS`. */
export interface BookingSegmentRow {
  readonly id: string;
  readonly amadeusFlightOfferId: string;
  readonly amadeusSegmentId: string;
  readonly itineraryIndex: number;
  readonly segmentIndex: number;
  readonly carrierCode: string;
  readonly flightNumber: string;
  readonly operatingCarrierCode: string | null;
  readonly aircraftCode: string | null;
  readonly departureIata: string;
  readonly departureTerminal: string | null;
  readonly departureLocal: string;
  readonly departureAt: Date;
  readonly arrivalIata: string;
  readonly arrivalTerminal: string | null;
  readonly arrivalLocal: string;
  readonly arrivalAt: Date;
  readonly durationMinutes: number | null;
  readonly numberOfStops: number;
  readonly cabin: string | null;
  readonly bookingClass: string | null;
  readonly fareBasis: string | null;
  readonly brandedFare: string | null;
  readonly includedCheckedBags: unknown;
  readonly status: string;
  readonly isFlown: boolean;
}

/** A `booking_tickets` row. */
export interface BookingTicketRow {
  readonly id: string;
  readonly amadeusTravelerId: string | null;
  readonly documentType: string;
  readonly documentNumber: string;
  readonly status: string;
  readonly segmentIds: readonly string[];
  readonly issuedAt: Date | null;
  readonly details: unknown;
}

/** A `booking_remarks` row. */
export interface BookingRemarkRow {
  readonly id: string;
  readonly kind: string;
  readonly subType: string;
  readonly text: string;
  readonly travelerIds: readonly string[];
  readonly visibleToCustomer: boolean;
  readonly createdByStaffId: string | null;
  readonly createdAt: Date;
}

/** A `booking_associated_records` row. */
export interface BookingAssociatedRecordRow {
  readonly reference: string;
  readonly originSystemCode: string;
  /** `YYYY-MM-DDTHH:MM:SS.mmm`, local as Amadeus gives it. */
  readonly creationDate: string | null;
  readonly flightOfferId: string | null;
  readonly isPrimary: boolean;
}

/** Everything an answer shows of a booking's child tables. */
export interface BookingChildren {
  readonly travelers: readonly BookingTravelerRow[];
  readonly contacts: readonly BookingContactRow[];
  readonly segments: readonly BookingSegmentRow[];
  readonly tickets: readonly BookingTicketRow[];
  readonly remarks: readonly BookingRemarkRow[];
  readonly associatedRecords: readonly BookingAssociatedRecordRow[];
}

/** The rows a recorded order adds under its booking. */
export interface BookingChildInserts {
  readonly associatedRecords: readonly Insertable<Db["booking_associated_records"]>[];
  readonly travelers: readonly Insertable<Db["booking_travelers"]>[];
  readonly contacts: readonly Insertable<Db["booking_contacts"]>[];
  readonly segments: readonly Insertable<Db["booking_segments"]>[];
  readonly remarks: readonly Insertable<Db["booking_remarks"]>[];
  readonly tickets: readonly Insertable<Db["booking_tickets"]>[];
}

/** A local date-time and the IANA zone it is read in. */
export interface ZonedLocal {
  /** `YYYY-MM-DDTHH:MM:SS` (or a date, read at 00:00). */
  readonly local: string;
  readonly zone: string;
}

/** The local date-time text of a `timestamp` column. */
const LOCAL_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS`;

// ---- Customer reads (OBE-046) ---------------------------------------------------------------------------------------

/** What the customer reads need of `storefront_settings`. */
export interface CustomerBookingSettingsRow {
  readonly ticketingPolicy: string;
  /** The `features` jsonb (`{ancillaries, brandedFareUpsell, selfServiceCancellation}`), read defensively. */
  readonly features: unknown;
  /** `time_zone` (IANA): the OTA's day, which decides a same-day void (cancellation-mode.ts). */
  readonly timeZone: string;
}

/** A "My trips" tab of bookings.list (`timeframe`). */
export type BookingTimeframe = "upcoming" | "past" | "cancelled" | "all";

/** The order of bookings.list (`sort`). */
export type BookingListSort = "departure" | "-departure" | "created" | "-created";

/** The statuses of the upcoming and past tabs (db README §10; the partial indexes `bookings_customer_*_idx`). */
export const ACTIVE_BOOKING_STATUSES = ["pending", "confirmed", "ticketed", "partially_ticketed"] as const;

/** One page of a customer's bookings. */
export interface BookingListQuery {
  readonly environment: string;
  readonly customerId: string;
  readonly timeframe: BookingTimeframe;
  readonly sort: BookingListSort;
  /** `YYYY-MM-DD`: the local date of the first departure, inclusive. */
  readonly departureFrom?: string | undefined;
  readonly departureTo?: string | undefined;
  /** ISO-8601 instants: `createdFrom` inclusive, `createdTo` exclusive. */
  readonly createdFrom?: string | undefined;
  readonly createdTo?: string | undefined;
  /** The keyset position of the previous page: its last row's sort key (`sortKey`) and id. */
  readonly after?: { readonly key: string; readonly id: string } | undefined;
  /** Rows to read (the page size plus one, to know whether there is a next page). */
  readonly limit: number;
  readonly now: Date;
}

/** A booking of a list page. */
export interface BookingListRow {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly recordLocator: string | null;
  readonly tripType: string | null;
  readonly originIata: string | null;
  readonly destinationIata: string | null;
  readonly firstDepartureAt: Date;
  readonly lastArrivalAt: Date;
  /** `YYYY-MM-DDTHH:MM:SS`: the first segment's local departure, else the first departure in the origin's zone. */
  readonly firstDepartureLocal: string;
  readonly travelersCount: number;
  readonly currency: string;
  readonly totalAmount: string;
  readonly ticketingStatus: string;
  readonly leadLastName: string;
  readonly hasScheduleChange: boolean;
  readonly createdAt: Date;
  readonly cancelledAt: Date | null;
  /** The sort key in UTC with microseconds (`YYYY-MM-DDTHH:MM:SS.US`), the keyset position of the next page. */
  readonly sortKey: string;
}

/** A segment of a list card. */
export interface SummarySegmentRow {
  readonly bookingId: string;
  readonly itineraryIndex: number;
  readonly departureIata: string;
  readonly arrivalIata: string;
  readonly departureLocal: string;
  readonly arrivalLocal: string;
  readonly carrierCode: string;
}

/** The lead traveller of a list card. */
export interface LeadTravelerRow {
  readonly bookingId: string;
  readonly firstName: string;
  readonly lastName: string;
}

/** What the booking access guard reads of a booking: where it lives, whose it is, and the presented tokens' grant. */
export interface BookingAccessRow {
  readonly environment: string;
  readonly customerId: string | null;
  readonly status: string;
  /** One of the presented token hashes is a live `booking_access_tokens` row of this booking. */
  readonly tokenGranted: boolean;
}

/** The `bookings` columns the customer answers read besides BookingRow. */
export interface BookingDetailsRow {
  readonly ticketingRequestedAt: Date | null;
  readonly ticketingLastAttemptAt: Date | null;
  readonly ticketingErrorCode: string | null;
  readonly orderSnapshot: unknown;
  readonly orderIncluded: unknown;
  readonly orderDictionaries: unknown;
  readonly syncError: string | null;
  readonly cancelledBy: string | null;
  /** `cancel_reason`: the typed reason code of a customer's cancellation (or the airline's text). */
  readonly cancelReason: string | null;
  /** The last refresh claim or sync of the booking (`sync_claimed_at` or `last_synced_at`, whichever is later). */
  readonly lastRefreshAt: Date | null;
  /** `sync_claimed_at`: the last claim of a synchronisation (the sync's or a refresh's). */
  readonly syncClaimedAt: Date | null;
  /** `sync_changes`: what the last recorded synchronisation changed (order-diff.ts `syncChangesOf`). */
  readonly syncChanges: unknown;
}

/** A customer-visible `booking_events` row. */
export interface BookingEventRow {
  readonly id: string;
  readonly bookingId: string;
  readonly type: string;
  readonly actorType: string;
  readonly statusFrom: string | null;
  readonly statusTo: string | null;
  readonly summary: string | null;
  readonly data: unknown;
  readonly createdAt: Date;
  /** `created_at` in UTC with microseconds, the keyset position of the next page. */
  readonly sortKey: string;
}

/** A `booking_ancillaries` row with its traveller's and segment's Amadeus ids. */
export interface BookingAncillaryRow {
  readonly id: string;
  readonly travelerId: string | null;
  readonly segmentId: string | null;
  readonly type: string;
  readonly serviceCode: string | null;
  readonly quantity: number;
  readonly weight: number | null;
  readonly weightUnit: string | null;
  readonly seatNumber: string | null;
  readonly currency: string | null;
  readonly priceAmount: string;
  readonly status: string;
  readonly source: string;
  readonly emdNumber: string | null;
}

/** A `refunds` row of a booking. */
export interface BookingRefundRow {
  readonly id: string;
  readonly paymentId: string;
  readonly currency: string;
  readonly amount: string;
  readonly penaltyAmount: string | null;
  readonly reason: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly processedAt: Date | null;
}

/** A current `booking_documents` row (latest per kind and ticket, not superseded). */
export interface BookingDocumentRow {
  readonly id: string;
  readonly ticketId: string | null;
  readonly kind: string;
  readonly status: string;
  readonly locale: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number | null;
  readonly invoiceNumber: string | null;
  readonly createdAt: Date;
}

/** The booking a refresh claims, locked `FOR UPDATE`. */
export interface RefreshClaimRow {
  readonly status: string;
  readonly amadeusOrderId: string | null;
  readonly ownerOfficeId: string | null;
  readonly lastRefreshAt: Date | null;
  /** The booking's `version` at the claim: the record step writes nothing when another writer changed it since. */
  readonly version: number;
}

/**
 * The staff-only event that recorded the claim of a synchronisation (the sync's and the refreshes') until FIX-W27-SYNC:
 * no longer written (lead decision (3) of 2026-10-23, `bookings.sync_claimed_at` is the claim); the events written
 * before stay on the bookings' timelines.
 */
export const REFRESH_CLAIM_EVENT = "booking.sync_requested";

/** A timestamptz column as UTC text with microseconds: the keyset positions of the lists. */
const utcKeyOf = (column: string) =>
  sql<string>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

/** The last refresh of booking `b`: its last claim of a synchronisation or `last_synced_at`, whichever is later. */
const lastRefreshOf = sql<Date | null>`greatest(b.last_synced_at, b.sync_claimed_at)`;

/**
 * The local first departure of booking `b`: its first segment's local time, else (a pending booking has no segment
 * yet) `first_departure_at` in the origin airport's time zone (UTC when unknown).
 */
const firstDepartureLocalOf = sql<string>`coalesce(
  (SELECT to_char(s.departure_local, ${LOCAL_FORMAT}) FROM booking_segments s
    WHERE s.booking_id = b.id ORDER BY s.itinerary_index, s.segment_index LIMIT 1),
  to_char(b.first_departure_at AT TIME ZONE coalesce(
    (SELECT a.time_zone FROM reference.airports a WHERE a.iata_code = b.origin_iata), 'UTC'), ${LOCAL_FORMAT})
)`;

/** The payment states a checkout's active payment can be in (not cancelled, failed or refunded). */
export const ACTIVE_PAYMENT_STATUSES = [
  "requires_payment_method",
  "requires_action",
  "processing",
  "authorized",
  "captured",
] as const;

@Injectable()
export class BookingsRepository {
  /** The settings a booking follows; `undefined` without a settings row (provisioning never leaves one so). */
  async settings(trx: TenantTransaction): Promise<BookingSettingsRow | undefined> {
    return await trx
      .selectFrom("storefront_settings")
      .select([
        "ticketing_policy as ticketingPolicy",
        "payment_timing as paymentTiming",
        "time_zone as timeZone",
        "booking_queue_number as bookingQueueNumber",
        "booking_queue_category as bookingQueueCategory",
        "default_locale as defaultLocale",
      ])
      .executeTakeFirst();
  }

  /** The checkout columns CheckoutRepository does not read. */
  async checkoutExtras(trx: TenantTransaction, checkoutId: string): Promise<CheckoutExtrasRow | undefined> {
    return await trx
      .selectFrom("checkouts")
      .select(["pricing_mode as pricingMode", "created_by_staff_id as createdByStaffId"])
      .where("id", "=", checkoutId)
      .executeTakeFirst();
  }

  /** The id of the checkout's newest payment that is still active (ACTIVE_PAYMENT_STATUSES), or `undefined`. */
  async activePaymentId(trx: TenantTransaction, checkoutId: string): Promise<string | undefined> {
    const row = await trx
      .selectFrom("payments")
      .select("id")
      .where("checkout_id", "=", checkoutId)
      .where("status", "in", [...ACTIVE_PAYMENT_STATUSES])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row?.id;
  }

  /** The booking a checkout produced (`bookings.checkout_id` is unique), locked `FOR UPDATE` when `lock`. */
  async bookingOfCheckout(
    trx: TenantTransaction,
    checkoutId: string,
    lock = false,
  ): Promise<{ readonly id: string; readonly status: string } | undefined> {
    let query = trx.selectFrom("bookings").select(["id", "status"]).where("checkout_id", "=", checkoutId);
    if (lock) {
      query = query.forUpdate();
    }
    return await query.executeTakeFirst();
  }

  async insertBooking(trx: TenantTransaction, row: Insertable<Db["bookings"]>): Promise<void> {
    await trx.insertInto("bookings").values(row).execute();
  }

  /** The booking `id`, locked `FOR UPDATE` when `lock`; `undefined` for an unknown id. */
  async booking(trx: TenantTransaction, id: string, lock = false): Promise<BookingRow | undefined> {
    let query = trx
      .selectFrom("bookings")
      .select([
        "id",
        "environment",
        "reference",
        "channel",
        "customer_id as customerId",
        "checkout_id as checkoutId",
        "priced_offer_id as pricedOfferId",
        "status",
        "amadeus_order_id as amadeusOrderId",
        "record_locator as recordLocator",
        "origin_system_code as originSystemCode",
        "supplier_connection_id as supplierConnectionId",
        "queuing_office_id as queuingOfficeId",
        "owner_office_id as ownerOfficeId",
        "ticketing_deadline_at as ticketingDeadlineAt",
        "issue_requested as issueRequested",
        "issued_at as issuedAt",
        "ticketing_status as ticketingStatus",
        "ticketing_attempts as ticketingAttempts",
        "ticketing_next_attempt_at as ticketingNextAttemptAt",
        "trip_type as tripType",
        "first_departure_at as firstDepartureAt",
        "last_arrival_at as lastArrivalAt",
        "validating_carrier as validatingCarrier",
        "travelers_count as travelersCount",
        "pricing_mode as pricingMode",
        "contact_email as contactEmail",
        "lead_last_name as leadLastName",
        "failure_code as failureCode",
        "metadata",
        "last_synced_at as lastSyncedAt",
        "cancelled_at as cancelledAt",
        "create_order_started_at as createOrderStartedAt",
        "version",
        "created_at as createdAt",
        "updated_at as updatedAt",
        sql<string | null>`to_char(last_ticketing_date, 'YYYY-MM-DD')`.as("lastTicketingDate"),
        sql<string | null>`origin_iata::text`.as("originIata"),
        sql<string | null>`destination_iata::text`.as("destinationIata"),
        sql<string>`currency::text`.as("currency"),
        sql<string>`net_amount::text`.as("netAmount"),
        sql<string | null>`net_base_amount::text`.as("netBaseAmount"),
        sql<string | null>`net_fees_amount::text`.as("netFeesAmount"),
        sql<string>`markup_amount::text`.as("markupAmount"),
        sql<string>`fees_amount::text`.as("feesAmount"),
        sql<string>`card_fee_amount::text`.as("cardFeeAmount"),
        sql<string>`ancillaries_amount::text`.as("ancillariesAmount"),
        sql<string>`taxes_amount::text`.as("taxesAmount"),
        sql<string>`total_amount::text`.as("totalAmount"),
        sql<string>`amount_paid::text`.as("amountPaid"),
        sql<string>`amount_refunded::text`.as("amountRefunded"),
      ])
      .where("id", "=", id);
    if (lock) {
      query = query.forUpdate();
    }
    return await query.executeTakeFirst();
  }

  /** Changes the booking `id` and bumps its `version` (the ETag of bookings.update and bookings.cancel). */
  async updateBooking(
    trx: TenantTransaction,
    id: string,
    values: Omit<Updateable<Db["bookings"]>, "version" | "id">,
  ): Promise<void> {
    await trx
      .updateTable("bookings")
      .set({ ...values, version: sql`version + 1` })
      .where("id", "=", id)
      .execute();
  }

  /** Inserts the child rows of a recorded order. */
  async insertChildren(trx: TenantTransaction, rows: BookingChildInserts): Promise<void> {
    if (rows.associatedRecords.length > 0) {
      await trx
        .insertInto("booking_associated_records")
        .values([...rows.associatedRecords])
        .execute();
    }
    if (rows.travelers.length > 0) {
      await trx
        .insertInto("booking_travelers")
        .values([...rows.travelers])
        .execute();
    }
    if (rows.contacts.length > 0) {
      await trx
        .insertInto("booking_contacts")
        .values([...rows.contacts])
        .execute();
    }
    if (rows.segments.length > 0) {
      await trx
        .insertInto("booking_segments")
        .values([...rows.segments])
        .execute();
    }
    if (rows.remarks.length > 0) {
      await trx
        .insertInto("booking_remarks")
        .values([...rows.remarks])
        .execute();
    }
    await this.insertTickets(trx, rows.tickets);
  }

  /** Inserts tickets; a document number the booking has already is left as it is (`booking_tickets_number_uq`). */
  async insertTickets(
    trx: TenantTransaction,
    rows: readonly Insertable<Db["booking_tickets"]>[],
  ): Promise<void> {
    if (rows.length > 0) {
      await trx
        .insertInto("booking_tickets")
        .values([...rows])
        .onConflict((conflict) => conflict.columns(["booking_id", "document_number"]).doNothing())
        .execute();
    }
  }

  /** Appends a booking event (`booking_events` is append-only: `updated_at` equals `created_at`). */
  async insertEvent(trx: TenantTransaction, row: Insertable<Db["booking_events"]>): Promise<void> {
    await trx.insertInto("booking_events").values(row).execute();
  }

  /** The `id`s of the booking's travellers by Amadeus traveller id. */
  async travelerIds(trx: TenantTransaction, bookingId: string): Promise<Map<string, string>> {
    const rows = await trx
      .selectFrom("booking_travelers")
      .select(["id", "amadeus_traveler_id as travelerId"])
      .where("booking_id", "=", bookingId)
      .execute();
    return new Map(rows.map((row) => [row.travelerId, row.id]));
  }

  /** Everything an answer shows of the booking's child tables, in their order. */
  async children(trx: TenantTransaction, bookingId: string): Promise<BookingChildren> {
    const travelers = await trx
      .selectFrom("booking_travelers")
      .select([
        "id",
        "amadeus_traveler_id as amadeusTravelerId",
        "traveler_type as travelerType",
        "associated_adult_id as associatedAdultId",
        "saved_traveler_id as savedTravelerId",
        "first_name as firstName",
        "middle_name as middleName",
        "last_name as lastName",
        "second_last_name as secondLastName",
        "gender",
        "contact",
        "documents_ciphertext as documentsCiphertext",
        "discount_eligibility_ciphertext as discountEligibilityCiphertext",
        "loyalty_programs as loyaltyPrograms",
        "emergency_contact as emergencyContact",
        sql<string | null>`to_char(date_of_birth, 'YYYY-MM-DD')`.as("dateOfBirth"),
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("amadeus_traveler_id")
      .execute();
    const contacts = await trx
      .selectFrom("booking_contacts")
      .select([
        "id",
        "purpose",
        "is_primary as isPrimary",
        "first_name as firstName",
        "last_name as lastName",
        "company_name as companyName",
        "email",
        "phones",
        "address",
        "language",
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const segments = await trx
      .selectFrom("booking_segments")
      .select([
        "id",
        "amadeus_flight_offer_id as amadeusFlightOfferId",
        "amadeus_segment_id as amadeusSegmentId",
        "itinerary_index as itineraryIndex",
        "segment_index as segmentIndex",
        "carrier_code as carrierCode",
        "flight_number as flightNumber",
        "operating_carrier_code as operatingCarrierCode",
        "aircraft_code as aircraftCode",
        "departure_terminal as departureTerminal",
        "departure_at as departureAt",
        "arrival_terminal as arrivalTerminal",
        "arrival_at as arrivalAt",
        "duration_minutes as durationMinutes",
        "number_of_stops as numberOfStops",
        "cabin",
        "booking_class as bookingClass",
        "fare_basis as fareBasis",
        "branded_fare as brandedFare",
        "included_checked_bags as includedCheckedBags",
        "status",
        "is_flown as isFlown",
        sql<string>`departure_iata::text`.as("departureIata"),
        sql<string>`arrival_iata::text`.as("arrivalIata"),
        sql<string>`to_char(departure_local, ${LOCAL_FORMAT})`.as("departureLocal"),
        sql<string>`to_char(arrival_local, ${LOCAL_FORMAT})`.as("arrivalLocal"),
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("itinerary_index")
      .orderBy("segment_index")
      .execute();
    const tickets = await trx
      .selectFrom("booking_tickets")
      .select([
        "id",
        "amadeus_traveler_id as amadeusTravelerId",
        "document_type as documentType",
        "document_number as documentNumber",
        "status",
        "segment_ids as segmentIds",
        "issued_at as issuedAt",
        "details",
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("document_number")
      .execute();
    const remarks = await trx
      .selectFrom("booking_remarks")
      .select([
        "id",
        "kind",
        "sub_type as subType",
        "text",
        "traveler_ids as travelerIds",
        "visible_to_customer as visibleToCustomer",
        "created_by_staff_id as createdByStaffId",
        "created_at as createdAt",
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const associatedRecords = await trx
      .selectFrom("booking_associated_records")
      .select([
        "reference",
        "origin_system_code as originSystemCode",
        "flight_offer_id as flightOfferId",
        "is_primary as isPrimary",
        sql<string | null>`to_char(creation_date, 'YYYY-MM-DD"T"HH24:MI:SS.MS')`.as("creationDate"),
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("is_primary", "desc")
      .orderBy("reference")
      .execute();
    return { travelers, contacts, segments, tickets, remarks, associatedRecords };
  }

  /** The ids of the payments of a booking, oldest first. */
  async paymentIdsOf(trx: TenantTransaction, bookingId: string): Promise<string[]> {
    const rows = await trx
      .selectFrom("payments")
      .select("id")
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map((row) => row.id);
  }

  /** Changes the checkout after the orchestration and bumps its `version`. */
  async updateCheckout(
    trx: TenantTransaction,
    id: string,
    values: Omit<Updateable<Db["checkouts"]>, "version" | "id">,
  ): Promise<void> {
    await trx
      .updateTable("checkouts")
      .set({ ...values, version: sql`version + 1` })
      .where("id", "=", id)
      .execute();
  }

  /** The IANA time zone of each known airport of `codes` (`reference.airports`, those that have one). */
  async airportTimeZones(trx: TenantTransaction, codes: readonly string[]): Promise<Map<string, string>> {
    const wanted = [...new Set(codes.filter((code) => /^[A-Z]{3}$/.test(code)))];
    if (wanted.length === 0) {
      return new Map();
    }
    const rows = await trx
      .selectFrom("reference.airports")
      .select(["iata_code", "time_zone"])
      .where("iata_code", "in", wanted)
      .where("time_zone", "is not", null)
      .execute();
    return new Map(rows.flatMap((row) => (row.time_zone === null ? [] : [[row.iata_code, row.time_zone]])));
  }

  /**
   * The instants of local date-times, each read in its IANA zone (`timestamp AT TIME ZONE zone`, PostgreSQL's time
   * zone rules), in the order given.
   */
  async instants(trx: TenantTransaction, items: readonly ZonedLocal[]): Promise<Date[]> {
    if (items.length === 0) {
      return [];
    }
    const locals = items.map((item) => item.local);
    const zones = items.map((item) => item.zone);
    const { rows } = await sql<{ at: Date }>`
      SELECT (t.l::timestamp AT TIME ZONE t.z) AS at
      FROM unnest(${locals}::text[], ${zones}::text[]) WITH ORDINALITY AS t(l, z, ord)
      ORDER BY t.ord
    `.execute(trx);
    return rows.map((row) => row.at);
  }

  // ---- Customer reads (OBE-046) -------------------------------------------------------------------------------------

  /** The settings the customer answers follow; `undefined` without a settings row. */
  async customerSettings(trx: TenantTransaction): Promise<CustomerBookingSettingsRow | undefined> {
    return await trx
      .selectFrom("storefront_settings")
      .select(["ticketing_policy as ticketingPolicy", "features", "time_zone as timeZone"])
      .executeTakeFirst();
  }

  /**
   * One page of a customer's bookings of one environment (db README §10 "My trips"): upcoming = the active statuses
   * whose last arrival is now or later, past = the active statuses whose last arrival has passed, cancelled, all =
   * every status but `failed`; then the filters, the keyset position and the sort with the id as tie-breaker.
   */
  async customerBookings(trx: TenantTransaction, query: BookingListQuery): Promise<BookingListRow[]> {
    const byDeparture = query.sort === "departure" || query.sort === "-departure";
    const direction = query.sort.startsWith("-") ? "desc" : "asc";
    const column = byDeparture ? "b.first_departure_at" : "b.created_at";
    let select = this.summaryRows(trx, column)
      .where("b.environment", "=", query.environment)
      .where("b.customer_id", "=", query.customerId);
    switch (query.timeframe) {
      case "upcoming":
        select = select
          .where("b.status", "in", [...ACTIVE_BOOKING_STATUSES])
          .where("b.last_arrival_at", ">=", query.now);
        break;
      case "past":
        select = select
          .where("b.status", "in", [...ACTIVE_BOOKING_STATUSES])
          .where("b.last_arrival_at", "<", query.now);
        break;
      case "cancelled":
        select = select.where("b.status", "=", "cancelled");
        break;
      case "all":
        select = select.where("b.status", "<>", "failed");
        break;
    }
    if (query.departureFrom !== undefined) {
      select = select.where(sql<boolean>`(${firstDepartureLocalOf})::date >= ${query.departureFrom}::date`);
    }
    if (query.departureTo !== undefined) {
      select = select.where(sql<boolean>`(${firstDepartureLocalOf})::date <= ${query.departureTo}::date`);
    }
    if (query.createdFrom !== undefined) {
      select = select.where(sql<boolean>`b.created_at >= ${query.createdFrom}::timestamptz`);
    }
    if (query.createdTo !== undefined) {
      select = select.where(sql<boolean>`b.created_at < ${query.createdTo}::timestamptz`);
    }
    if (query.after !== undefined) {
      const comparison = sql.raw(direction === "desc" ? "<" : ">");
      select = select.where(
        sql<boolean>`(${sql.ref(column)}, b.id) ${comparison} (${query.after.key}::timestamp AT TIME ZONE 'UTC', ${query.after.id})`,
      );
    }
    const ordered = byDeparture
      ? select.orderBy("b.first_departure_at", direction)
      : select.orderBy("b.created_at", direction);
    return await ordered.orderBy("b.id", direction).limit(query.limit).execute();
  }

  /** The list card of the booking `id` of `environment` (bookings.lookup, OBE-047); `undefined` when there is none. */
  async bookingSummary(
    trx: TenantTransaction,
    environment: string,
    id: string,
  ): Promise<BookingListRow | undefined> {
    return await this.summaryRows(trx, "b.created_at")
      .where("b.id", "=", id)
      .where("b.environment", "=", environment)
      .executeTakeFirst();
  }

  /** The columns of a list card (BookingListRow), with `sortColumn` as the keyset key. */
  private summaryRows(trx: TenantTransaction, sortColumn: "b.first_departure_at" | "b.created_at") {
    return trx.selectFrom("bookings as b").select([
      "b.id as id",
      "b.reference as reference",
      "b.status as status",
      "b.record_locator as recordLocator",
      "b.trip_type as tripType",
      "b.first_departure_at as firstDepartureAt",
      "b.last_arrival_at as lastArrivalAt",
      "b.travelers_count as travelersCount",
      "b.ticketing_status as ticketingStatus",
      "b.lead_last_name as leadLastName",
      "b.created_at as createdAt",
      "b.cancelled_at as cancelledAt",
      sql<string | null>`b.origin_iata::text`.as("originIata"),
      sql<string | null>`b.destination_iata::text`.as("destinationIata"),
      sql<string>`b.currency::text`.as("currency"),
      sql<string>`b.total_amount::text`.as("totalAmount"),
      firstDepartureLocalOf.as("firstDepartureLocal"),
      sql<boolean>`EXISTS (
          SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.type = 'booking.schedule_changed'
        )`.as("hasScheduleChange"),
      utcKeyOf(sortColumn).as("sortKey"),
    ]);
  }

  /** The segments of the bookings `ids`, in bound and segment order. */
  async summarySegments(trx: TenantTransaction, ids: readonly string[]): Promise<SummarySegmentRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("booking_segments")
      .select([
        "booking_id as bookingId",
        "itinerary_index as itineraryIndex",
        "carrier_code as carrierCode",
        sql<string>`departure_iata::text`.as("departureIata"),
        sql<string>`arrival_iata::text`.as("arrivalIata"),
        sql<string>`to_char(departure_local, ${LOCAL_FORMAT})`.as("departureLocal"),
        sql<string>`to_char(arrival_local, ${LOCAL_FORMAT})`.as("arrivalLocal"),
      ])
      .where("booking_id", "in", [...ids])
      .orderBy("booking_id")
      .orderBy("itinerary_index")
      .orderBy("segment_index")
      .execute();
  }

  /** The lead traveller of each of the bookings `ids` (its first adult by Amadeus id, else its first traveller). */
  async leadTravelers(trx: TenantTransaction, ids: readonly string[]): Promise<LeadTravelerRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("booking_travelers")
      .distinctOn("booking_id")
      .select(["booking_id as bookingId", "first_name as firstName", "last_name as lastName"])
      .where("booking_id", "in", [...ids])
      .orderBy("booking_id")
      .orderBy(sql`traveler_type <> 'ADULT'`)
      .orderBy(sql`length(amadeus_traveler_id)`)
      .orderBy("amadeus_traveler_id")
      .execute();
  }

  /** The city name of each known airport of `codes` (`reference.cities`, else the airport's own city name). */
  async cityNames(trx: TenantTransaction, codes: readonly string[]): Promise<Map<string, string>> {
    const wanted = [...new Set(codes.filter((code) => /^[A-Z]{3}$/.test(code)))];
    if (wanted.length === 0) {
      return new Map();
    }
    const rows = await trx
      .selectFrom("reference.airports as a")
      .leftJoin("reference.cities as c", "c.iata_code", "a.city_code")
      .select([
        sql<string>`a.iata_code::text`.as("code"),
        sql<string | null>`coalesce(c.name, a.city_name)`.as("name"),
      ])
      .where("a.iata_code", "in", wanted)
      .execute();
    return new Map(rows.flatMap((row) => (row.name === null ? [] : [[row.code, row.name]])));
  }

  /**
   * What the booking access guard decides on: the booking's environment, customer and status, and whether one of
   * `tokenHashes` (SHA-256 hex of presented guest tokens) is a token of this booking that is neither revoked nor
   * expired at `now`. `undefined` for an unknown id.
   */
  async bookingAccess(
    trx: TenantTransaction,
    bookingId: string,
    tokenHashes: readonly string[],
    now: Date,
  ): Promise<BookingAccessRow | undefined> {
    return await trx
      .selectFrom("bookings as b")
      .select([
        "b.environment as environment",
        "b.customer_id as customerId",
        "b.status as status",
        sql<boolean>`EXISTS (
          SELECT 1 FROM booking_access_tokens t
          WHERE t.booking_id = b.id AND t.token_hash = ANY(${[...tokenHashes]}::text[])
            AND t.revoked_at IS NULL AND t.expires_at > ${now}
        )`.as("tokenGranted"),
      ])
      .where("b.id", "=", bookingId)
      .executeTakeFirst();
  }

  /**
   * Records one authenticated request on the live tokens of booking `bookingId` among `tokenHashes` (OBE-047):
   * `last_used_at` and `use_count + 1`.
   */
  async recordTokenUse(
    trx: TenantTransaction,
    bookingId: string,
    tokenHashes: readonly string[],
    now: Date,
  ): Promise<void> {
    if (tokenHashes.length === 0) {
      return;
    }
    await trx
      .updateTable("booking_access_tokens")
      .set({ last_used_at: now, use_count: sql`use_count + 1`, updated_at: now })
      .where("booking_id", "=", bookingId)
      .where("token_hash", "in", [...tokenHashes])
      .where("revoked_at", "is", null)
      .where("expires_at", ">", now)
      .execute();
  }

  /** The columns of the booking `id` the customer answers read besides `booking()`. */
  async bookingDetails(trx: TenantTransaction, id: string): Promise<BookingDetailsRow | undefined> {
    return await trx
      .selectFrom("bookings as b")
      .select([
        "b.ticketing_requested_at as ticketingRequestedAt",
        "b.ticketing_last_attempt_at as ticketingLastAttemptAt",
        "b.ticketing_error_code as ticketingErrorCode",
        "b.order_snapshot as orderSnapshot",
        "b.order_included as orderIncluded",
        "b.order_dictionaries as orderDictionaries",
        "b.sync_error as syncError",
        "b.cancelled_by as cancelledBy",
        "b.cancel_reason as cancelReason",
        "b.sync_claimed_at as syncClaimedAt",
        "b.sync_changes as syncChanges",
        lastRefreshOf.as("lastRefreshAt"),
      ])
      .where("b.id", "=", id)
      .executeTakeFirst();
  }

  /** A page of the booking's customer-visible events, newest first, after the keyset position `after`. */
  async customerEvents(
    trx: TenantTransaction,
    bookingId: string,
    page: {
      readonly after?: { readonly key: string; readonly id: string } | undefined;
      readonly limit: number;
    },
  ): Promise<BookingEventRow[]> {
    let select = trx
      .selectFrom("booking_events as e")
      .select([
        "e.id as id",
        "e.booking_id as bookingId",
        "e.type as type",
        "e.actor_type as actorType",
        "e.status_from as statusFrom",
        "e.status_to as statusTo",
        "e.summary as summary",
        "e.data as data",
        "e.created_at as createdAt",
        utcKeyOf("e.created_at").as("sortKey"),
      ])
      .where("e.booking_id", "=", bookingId)
      .where("e.visible_to_customer", "=", true);
    if (page.after !== undefined) {
      select = select.where(
        sql<boolean>`(e.created_at, e.id) < (${page.after.key}::timestamp AT TIME ZONE 'UTC', ${page.after.id})`,
      );
    }
    return await select.orderBy("e.created_at", "desc").orderBy("e.id", "desc").limit(page.limit).execute();
  }

  /** The booking's additional services, with the Amadeus ids of their traveller and segment. */
  async ancillaries(trx: TenantTransaction, bookingId: string): Promise<BookingAncillaryRow[]> {
    return await trx
      .selectFrom("booking_ancillaries as a")
      .leftJoin("booking_travelers as t", "t.id", "a.booking_traveler_id")
      .leftJoin("booking_segments as s", "s.id", "a.booking_segment_id")
      .leftJoin("booking_tickets as k", "k.id", "a.emd_ticket_id")
      .select([
        "a.id as id",
        "t.amadeus_traveler_id as travelerId",
        "s.amadeus_segment_id as segmentId",
        "a.type as type",
        "a.service_code as serviceCode",
        "a.quantity as quantity",
        "a.weight as weight",
        "a.weight_unit as weightUnit",
        "a.seat_number as seatNumber",
        "a.status as status",
        "a.source as source",
        "k.document_number as emdNumber",
        sql<string | null>`a.currency::text`.as("currency"),
        sql<string>`a.price_amount::text`.as("priceAmount"),
      ])
      .where("a.booking_id", "=", bookingId)
      .orderBy("a.created_at")
      .orderBy("a.id")
      .execute();
  }

  /** The refunds of the booking, oldest first. */
  async refundsOf(trx: TenantTransaction, bookingId: string): Promise<BookingRefundRow[]> {
    return await trx
      .selectFrom("refunds")
      .select([
        "id",
        "payment_id as paymentId",
        "reason",
        "status",
        "created_at as createdAt",
        "processed_at as processedAt",
        sql<string>`currency::text`.as("currency"),
        sql<string>`amount::text`.as("amount"),
        sql<string | null>`penalty_amount::text`.as("penaltyAmount"),
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }

  /** The booking's current documents: the newest of each kind and ticket that is not superseded. */
  async currentDocuments(trx: TenantTransaction, bookingId: string): Promise<BookingDocumentRow[]> {
    return await trx
      .selectFrom("booking_documents")
      .distinctOn(["kind", "booking_ticket_id"])
      .select([
        "id",
        "booking_ticket_id as ticketId",
        "kind",
        "status",
        "locale",
        "file_name as fileName",
        "content_type as contentType",
        "size_bytes as sizeBytes",
        "invoice_number as invoiceNumber",
        "created_at as createdAt",
      ])
      .where("booking_id", "=", bookingId)
      .where("status", "<>", "superseded")
      .orderBy("kind")
      .orderBy("booking_ticket_id")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
  }

  /**
   * The booking `id` locked `FOR UPDATE` for a refresh claim, with its last refresh; `undefined` when unknown.
   *
   * Two statements: the lock first, then the read, which sees what a concurrent claim the lock waited for committed
   * (its `sync_claimed_at`), so the second of two refreshes is throttled instead of calling Amadeus a second time.
   */
  async lockForRefresh(trx: TenantTransaction, id: string): Promise<RefreshClaimRow | undefined> {
    const locked = await trx
      .selectFrom("bookings")
      .select("id")
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (locked === undefined) {
      return undefined;
    }
    return await trx
      .selectFrom("bookings as b")
      .select([
        "b.status as status",
        "b.amadeus_order_id as amadeusOrderId",
        "b.owner_office_id as ownerOfficeId",
        "b.version as version",
        lastRefreshOf.as("lastRefreshAt"),
      ])
      .where("b.id", "=", id)
      .executeTakeFirst();
  }

  /**
   * Writes what a refresh read of the order; bumps `version` only when `bumpVersion` (the refresh stores new or
   * changed tickets or a new status, which the documents follow: lead decision (6a) of 2026-10-22). A refresh that only
   * brings the snapshot up to date leaves the ETag as it is.
   */
  async updateSynced(
    trx: TenantTransaction,
    id: string,
    values: Omit<Updateable<Db["bookings"]>, "version" | "id">,
    bumpVersion: boolean,
  ): Promise<void> {
    await trx
      .updateTable("bookings")
      .set(bumpVersion ? { ...values, version: sql`version + 1` } : values)
      .where("id", "=", id)
      .execute();
  }

  /** Adds associated records a refresh found; one the booking has already (same reference and system) is kept. */
  async insertAssociatedRecords(
    trx: TenantTransaction,
    rows: readonly Insertable<Db["booking_associated_records"]>[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await trx
      .insertInto("booking_associated_records")
      .values([...rows])
      .onConflict((conflict) =>
        conflict.columns(["booking_id", "reference", "origin_system_code"]).doNothing(),
      )
      .execute();
  }

  /**
   * Records the claim of a synchronisation of the booking `id` (the sync's or a refresh's) at `at`, under the lock the
   * claim holds: `sync_claimed_at` only, never `version`, `updated_at` or a key column (so the update takes no
   * `FOR UPDATE`, OADR-0014 point 6) and no booking event (lead decision (3) of 2026-10-23).
   */
  async markSyncClaimed(trx: TenantTransaction, id: string, at: Date): Promise<void> {
    await trx.updateTable("bookings").set({ sync_claimed_at: at }).where("id", "=", id).execute();
  }

  /** Records the Amadeus `documentStatus` of a ticket found by a refresh (VOID, REFUNDED, EXCHANGED …). */
  async updateTicketStatus(
    trx: TenantTransaction,
    ticketId: string,
    state: { readonly status: string; readonly now: Date },
  ): Promise<void> {
    await trx
      .updateTable("booking_tickets")
      .set({ status: state.status, updated_at: state.now })
      .where("id", "=", ticketId)
      .execute();
  }
}
