// The tenant repository of bookings (OBE-042; ota/docs/data-model.md §2, db README §2.1, tenant migration 0002 §3):
// `bookings` and their children (`booking_associated_records`, `booking_travelers`, `booking_contacts`,
// `booking_segments`, `booking_tickets`, `booking_ancillaries`, `booking_remarks`) and the append-only
// `booking_events`, which the bookings module owns, plus what the orchestration reads or changes of tables it does not
// own: the storefront settings a booking follows, the checkout's pricing mode and its status once completed, a
// payment's link to its booking, and the time zones of airports (local Amadeus times become instants in SQL, `AT TIME
// ZONE`). The checkout and payment rows themselves are read through CheckoutRepository and PaymentsRepository.
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
  readonly opsAlertEmail: string | null;
  readonly supportEmail: string | null;
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
        "ops_alert_email as opsAlertEmail",
        "support_email as supportEmail",
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
}
