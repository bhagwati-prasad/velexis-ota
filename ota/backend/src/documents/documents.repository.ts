// The tenant repository of booking documents (OBE-053; OADR-0013 items 6 and 7, tenant.sql `booking_documents`, db
// README §8): the `booking_documents` rows the documents module owns, and what its renderers read of tables other
// modules own, read-only: the booking and its travellers, segments and tickets (bookings), the brand and the square
// logo (`storefront_settings`, `storefront_assets`), and the airport and airline names of `reference`.
//
// It never reads `booking_travelers.documents_ciphertext`: a document shows a traveller's identity document as its type
// and `document_last4`, so the full number never reaches the worker's memory for a PDF.
//
// A document row is written in one of two states:
//   ready   the file is stored at `storage_key` (`tenant_<key>/documents/<bookingId>/<documentId>.pdf`), with its
//           SHA-256 (`content_hash`) and size; a new version of a document is a new row and the rows it replaces
//           (same booking, kind and ticket) become `superseded` (OADR-0013 items 6 and 7);
//   failed  a render that failed (the job retries it): nothing is stored at its key, so `content_hash` is the SHA-256 of
//           no bytes (FAILED_CONTENT_HASH, the column is NOT NULL) and `size_bytes` is null; it supersedes nothing, so
//           the last ready version stays downloadable, and the next ready version of the document supersedes it.
// `pending` is not used: the job writes a row when it has a result, and a document without a row is not ready yet.
//
// The downloads (OBE-054, OADR-0013 item 9) read the rows in the API: a booking's ready documents, newest first with a
// keyset position as UTC text with microseconds (a JavaScript Date would lose them and skip or repeat rows); one
// document of a booking for its signed URL; and the document stored at a storage key, with its booking's environment,
// for the file endpoint. The one row they write outside `booking_documents` is the staff-only booking event of a
// download URL (`document.downloaded`, which asks for no document), appended to `booking_events` as the bookings
// module appends its events (BookingsRepository.insertEvent), so this module needs nothing of that one.
//
// Like every tenant repository it takes the `tenantTx` transaction first, never opens one and never names a tenant
// schema. Amounts are read as text, local date-times through `to_char`, never as JavaScript numbers or local dates.
import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import type {
  DocumentBooking,
  DocumentBrand,
  DocumentSegment,
  DocumentTicket,
  DocumentTraveler,
} from "./renderers/itinerary.renderer";

type Db = TenantDatabase;

/** The kinds of document the MVP renders (OADR-0013 item 6: no invoice, credit note or EMD receipt). */
export const DOCUMENT_KINDS = ["itinerary", "e_ticket_receipt"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The `content_hash` of a `failed` row: the SHA-256 of no bytes, as nothing is stored at its key. */
export const FAILED_CONTENT_HASH = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

/** The ticket type that gets a receipt (`booking_tickets.document_type`). */
const E_TICKET = "ETICKET";

/** The local date-time text of a `timestamp` value. */
const LOCAL_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS`;

/**
 * The first key of the advisory lock that serialises the document writes of one booking (`lockDocuments`): its
 * `hashtext`, with the booking id's as the second key. Advisory locks of two keys never meet the one-key locks of the
 * migration runner (`pg_advisory_xact_lock(hashtext(schema))`).
 */
export const DOCUMENTS_LOCK_SPACE = "velexis.booking_documents";

/** What a trigger needs of a booking: its version (the job key's) and its e-tickets. */
export interface RenderTargets {
  readonly version: number;
  /** `booking_tickets.id` of every e-ticket, in number order. */
  readonly eTicketIds: readonly string[];
}

/** The square logo's asset row. */
export interface LogoAssetRow {
  readonly storageKey: string;
  readonly contentType: string;
  readonly contentHash: string;
}

/** What the renderers read, besides the logo's bytes (the processor reads them from storage). */
export interface RenderSource {
  /** The booking's `version` when it was read. */
  readonly version: number;
  /** The brand, or `null` without a settings row (the processor takes the tenant's name). */
  readonly brand: DocumentBrand | null;
  readonly logo: LogoAssetRow | null;
  readonly booking: DocumentBooking;
  readonly travelers: readonly DocumentTraveler[];
  readonly segments: readonly DocumentSegment[];
  readonly tickets: readonly DocumentTicket[];
  readonly airports: ReadonlyMap<string, string>;
  readonly airlines: ReadonlyMap<string, string>;
}

/** A `booking_documents` row that is not superseded. */
export interface CurrentDocumentRow {
  readonly id: string;
  readonly status: string;
  readonly contentHash: string;
  readonly createdAt: Date;
}

/** A document as bookings.listDocuments lists it, with its keyset position. */
export interface ListedDocumentRow {
  readonly id: string;
  readonly bookingId: string;
  readonly ticketId: string | null;
  readonly kind: string;
  readonly status: string;
  readonly locale: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number | null;
  readonly invoiceNumber: string | null;
  readonly createdAt: Date;
  /** `created_at` in UTC with microseconds: the cursor's key. */
  readonly sortKey: string;
}

/** One document of a booking, as its download URL needs it. */
export interface DownloadDocumentRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly storageKey: string;
  /** The file's SHA-256: FAILED_CONTENT_HASH for a failed rendering (nothing stored), also once superseded. */
  readonly contentHash: string;
}

/** The document stored at a storage key, as the file endpoint serves it. */
export interface StoredFileRow {
  readonly id: string;
  readonly bookingId: string;
  readonly status: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly contentHash: string;
  /** The booking's environment (`test`, `live`). */
  readonly environment: string;
}

/** `created_at` of `column` as UTC text with microseconds (a keyset position). */
const utcKeyOf = (column: string) =>
  sql<string>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

/** Which document: a booking's itinerary, or the receipt of one of its tickets. */
export interface DocumentSlot {
  readonly bookingId: string;
  readonly kind: DocumentKind;
  /** `booking_tickets.id` of a receipt; `null` for the itinerary. */
  readonly ticketId: string | null;
}

@Injectable()
export class DocumentsRepository {
  /** The booking's version and e-tickets, as the caller's transaction sees them; `undefined` for an unknown id. */
  async renderTargets(trx: TenantTransaction, bookingId: string): Promise<RenderTargets | undefined> {
    const booking = await trx
      .selectFrom("bookings")
      .select("version")
      .where("id", "=", bookingId)
      .executeTakeFirst();
    if (booking === undefined) {
      return undefined;
    }
    const tickets = await trx
      .selectFrom("booking_tickets")
      .select("id")
      .where("booking_id", "=", bookingId)
      .where("document_type", "=", E_TICKET)
      .orderBy("document_number")
      .orderBy("id")
      .execute();
    return { version: booking.version, eTicketIds: tickets.map((ticket) => ticket.id) };
  }

  /** Everything a document of the booking shows (see the file header); `undefined` for an unknown id. */
  async renderSource(trx: TenantTransaction, bookingId: string): Promise<RenderSource | undefined> {
    const settings = await trx
      .selectFrom("storefront_settings")
      .select([
        "brand_name as name",
        "legal_name as legalName",
        "support_email as supportEmail",
        "support_phone as supportPhone",
        "primary_color as primaryColor",
        "logo_square_asset_id as logoAssetId",
        "time_zone as timeZone",
      ])
      .orderBy("created_at")
      .limit(1)
      .executeTakeFirst();
    const zone = settings?.timeZone ?? "UTC";
    const booking = await trx
      .selectFrom("bookings")
      .select([
        "id",
        "reference",
        "status",
        "record_locator as recordLocator",
        "created_at as createdAt",
        "version",
        sql<string>`to_char(created_at AT TIME ZONE ${zone}, ${LOCAL_FORMAT})`.as("bookedLocal"),
        sql<string | null>`to_char(cancelled_at AT TIME ZONE ${zone}, ${LOCAL_FORMAT})`.as("cancelledLocal"),
        sql<string>`currency::text`.as("currency"),
        sql<string>`total_amount::text`.as("totalAmount"),
        sql<string | null>`validating_carrier::text`.as("validatingCarrier"),
      ])
      .where("id", "=", bookingId)
      .executeTakeFirst();
    if (booking === undefined) {
      return undefined;
    }
    const travelers = await trx
      .selectFrom("booking_travelers")
      .select([
        "id",
        "amadeus_traveler_id as amadeusTravelerId",
        "traveler_type as travelerType",
        "first_name as firstName",
        "middle_name as middleName",
        "last_name as lastName",
        "document_type as documentType",
        "document_last4 as documentLast4",
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("amadeus_traveler_id")
      .execute();
    const segments = await trx
      .selectFrom("booking_segments")
      .select([
        "amadeus_flight_offer_id as amadeusFlightOfferId",
        "amadeus_segment_id as amadeusSegmentId",
        "itinerary_index as itineraryIndex",
        "segment_index as segmentIndex",
        "flight_number as flightNumber",
        "departure_terminal as departureTerminal",
        "arrival_terminal as arrivalTerminal",
        "duration_minutes as durationMinutes",
        "cabin",
        "booking_class as bookingClass",
        "included_checked_bags as includedCheckedBags",
        "status",
        sql<string>`carrier_code::text`.as("carrierCode"),
        sql<string | null>`operating_carrier_code::text`.as("operatingCarrierCode"),
        sql<string>`departure_iata::text`.as("departureIata"),
        sql<string>`arrival_iata::text`.as("arrivalIata"),
        sql<string>`to_char(departure_local, ${LOCAL_FORMAT})`.as("departureLocal"),
        sql<string>`to_char(arrival_local, ${LOCAL_FORMAT})`.as("arrivalLocal"),
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("amadeus_flight_offer_id")
      .orderBy("itinerary_index")
      .orderBy("segment_index")
      .execute();
    const tickets = await trx
      .selectFrom("booking_tickets")
      .select([
        "id",
        "booking_traveler_id as travelerId",
        "amadeus_traveler_id as amadeusTravelerId",
        "document_type as documentType",
        "document_number as documentNumber",
        "status",
        "segment_ids as segmentIds",
        "issued_at as issuedAt",
        sql<string | null>`to_char(issued_at AT TIME ZONE ${zone}, ${LOCAL_FORMAT})`.as("issuedLocal"),
        sql<string | null>`validating_carrier::text`.as("validatingCarrier"),
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("document_number")
      .orderBy("id")
      .execute();
    const logoAssetId = settings?.logoAssetId ?? null;
    const logo =
      logoAssetId === null
        ? undefined
        : await trx
            .selectFrom("storefront_assets")
            .select([
              "storage_key as storageKey",
              "content_type as contentType",
              "content_hash as contentHash",
            ])
            .where("id", "=", logoAssetId)
            .executeTakeFirst();
    const carriers = [
      booking.validatingCarrier,
      ...segments.flatMap((segment) => [segment.carrierCode, segment.operatingCarrierCode]),
      ...tickets.map((ticket) => ticket.validatingCarrier),
    ];
    return {
      version: booking.version,
      brand:
        settings === undefined
          ? null
          : {
              name: settings.name,
              legalName: settings.legalName,
              supportEmail: settings.supportEmail,
              supportPhone: settings.supportPhone,
              primaryColor: settings.primaryColor,
            },
      logo: logo ?? null,
      booking: {
        id: booking.id,
        reference: booking.reference,
        status: booking.status,
        recordLocator: booking.recordLocator,
        createdAt: booking.createdAt,
        bookedLocal: booking.bookedLocal,
        cancelledLocal: booking.cancelledLocal,
        currency: booking.currency,
        totalAmount: booking.totalAmount,
        validatingCarrier: booking.validatingCarrier,
      },
      travelers,
      segments,
      tickets,
      airports: await this.cityNames(
        trx,
        segments.flatMap((segment) => [segment.departureIata, segment.arrivalIata]),
      ),
      airlines: await this.airlineNames(trx, carriers),
    };
  }

  /** City names (else airport names) by IATA airport code, as far as `reference` knows them. */
  private async cityNames(trx: TenantTransaction, codes: readonly string[]): Promise<Map<string, string>> {
    const wanted = [...new Set(codes.filter((code) => /^[A-Z]{3}$/.test(code)))].sort();
    if (wanted.length === 0) {
      return new Map();
    }
    const rows = await trx
      .selectFrom("reference.airports as a")
      .leftJoin("reference.cities as c", "c.iata_code", "a.city_code")
      .select([
        sql<string>`a.iata_code::text`.as("code"),
        sql<string>`coalesce(c.name, a.city_name, a.name)`.as("name"),
      ])
      .where("a.iata_code", "in", wanted)
      .execute();
    return new Map(rows.map((row) => [row.code, row.name]));
  }

  /** Airline names by IATA code, as far as `reference` knows them. */
  private async airlineNames(
    trx: TenantTransaction,
    codes: ReadonlyArray<string | null>,
  ): Promise<Map<string, string>> {
    const wanted = [
      ...new Set(codes.filter((code): code is string => code !== null && /^[A-Z0-9]{2}$/.test(code))),
    ].sort();
    if (wanted.length === 0) {
      return new Map();
    }
    const rows = await trx
      .selectFrom("reference.airlines")
      .select([sql<string>`iata_code::text`.as("code"), sql<string>`coalesce(common_name, name)`.as("name")])
      .where("iata_code", "in", wanted)
      .execute();
    return new Map(rows.map((row) => [row.code, row.name]));
  }

  /**
   * Serialises the document writes of booking `bookingId` (the render's T2 and the failed row, documents.processor.ts):
   * takes the transaction-level advisory lock of the booking's documents (`pg_advisory_xact_lock`, DOCUMENTS_LOCK_SPACE
   * and the booking id's `hashtext`, released when `trx` ends), then reads the booking's version and reference (a
   * document's file name) `FOR KEY SHARE`, the lock the document row's foreign key takes on the booking anyway.
   *
   * It never takes `FOR UPDATE`, `FOR NO KEY UPDATE` or `FOR SHARE` on the booking (lead decision of 2026-10-22,
   * OADR-0014 point 6): a claim of the booking (`FOR NO KEY UPDATE SKIP LOCKED`, ticketing and the reconciliation) is
   * never kept from it by a document being written, and a booking change (`FOR UPDATE`) only waits for the short
   * write. The caller compares the version with the one it rendered. Two writes of one booking wait for each other on
   * the advisory lock only; a hash collision of two booking ids makes them wait for each other too, which is harmless.
   */
  async lockDocuments(
    trx: TenantTransaction,
    bookingId: string,
  ): Promise<{ readonly version: number; readonly reference: string } | undefined> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${DOCUMENTS_LOCK_SPACE}), hashtext(${bookingId}))`.execute(
      trx,
    );
    return await trx
      .selectFrom("bookings")
      .select(["version", "reference"])
      .where("id", "=", bookingId)
      .forKeyShare()
      .executeTakeFirst();
  }

  /** The number of a ticket of the booking (a receipt's file name); `undefined` when it has no such ticket. */
  async ticketNumber(
    trx: TenantTransaction,
    bookingId: string,
    ticketId: string,
  ): Promise<string | undefined> {
    const row = await trx
      .selectFrom("booking_tickets")
      .select("document_number as documentNumber")
      .where("booking_id", "=", bookingId)
      .where("id", "=", ticketId)
      .executeTakeFirst();
    return row?.documentNumber;
  }

  /** The rows of a document that are not superseded, newest first. */
  async currentDocuments(trx: TenantTransaction, slot: DocumentSlot): Promise<CurrentDocumentRow[]> {
    let query = trx
      .selectFrom("booking_documents")
      .select(["id", "status", "content_hash as contentHash", "created_at as createdAt"])
      .where("booking_id", "=", slot.bookingId)
      .where("kind", "=", slot.kind)
      .where("status", "<>", "superseded");
    query =
      slot.ticketId === null
        ? query.where("booking_ticket_id", "is", null)
        : query.where("booking_ticket_id", "=", slot.ticketId);
    return await query.orderBy("created_at", "desc").orderBy("id", "desc").execute();
  }

  async insert(trx: TenantTransaction, row: Insertable<Db["booking_documents"]>): Promise<void> {
    await trx.insertInto("booking_documents").values(row).execute();
  }

  /** Marks the rows `ids` superseded; returns how many changed. */
  async supersede(trx: TenantTransaction, ids: readonly string[], now: Date): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await trx
      .updateTable("booking_documents")
      .set({ status: "superseded", updated_at: now })
      .where("id", "in", [...ids])
      .where("status", "<>", "superseded")
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Records another failed render on a `failed` row. */
  async touch(trx: TenantTransaction, id: string, now: Date): Promise<void> {
    await trx.updateTable("booking_documents").set({ updated_at: now }).where("id", "=", id).execute();
  }

  /**
   * The booking's `ready` documents (OBE-054: bookings.listDocuments), of `kinds` when given, newest first
   * (`created_at`, then `id`), after the keyset position `after`, at most `limit` rows.
   */
  async readyDocuments(
    trx: TenantTransaction,
    bookingId: string,
    page: {
      readonly kinds?: readonly string[] | undefined;
      readonly after?: { readonly key: string; readonly id: string } | undefined;
      readonly limit: number;
    },
  ): Promise<ListedDocumentRow[]> {
    let select = trx
      .selectFrom("booking_documents as d")
      .select([
        "d.id as id",
        "d.booking_id as bookingId",
        "d.booking_ticket_id as ticketId",
        "d.kind as kind",
        "d.status as status",
        "d.locale as locale",
        "d.file_name as fileName",
        "d.content_type as contentType",
        "d.size_bytes as sizeBytes",
        "d.invoice_number as invoiceNumber",
        "d.created_at as createdAt",
        utcKeyOf("d.created_at").as("sortKey"),
      ])
      .where("d.booking_id", "=", bookingId)
      .where("d.status", "=", "ready");
    if (page.kinds !== undefined && page.kinds.length > 0) {
      select = select.where("d.kind", "in", [...page.kinds]);
    }
    if (page.after !== undefined) {
      select = select.where(
        sql<boolean>`(d.created_at, d.id) < (${page.after.key}::timestamp AT TIME ZONE 'UTC', ${page.after.id})`,
      );
    }
    return await select.orderBy("d.created_at", "desc").orderBy("d.id", "desc").limit(page.limit).execute();
  }

  /** Appends a booking event: the `document.downloaded` event of a download URL (OBE-054; see the file header). */
  async insertBookingEvent(trx: TenantTransaction, row: Insertable<Db["booking_events"]>): Promise<void> {
    await trx.insertInto("booking_events").values(row).execute();
  }

  /** Document `documentId` of booking `bookingId` (OBE-054: its download URL); `undefined` for another booking's. */
  async documentOf(
    trx: TenantTransaction,
    bookingId: string,
    documentId: string,
  ): Promise<DownloadDocumentRow | undefined> {
    return await trx
      .selectFrom("booking_documents")
      .select([
        "id",
        "kind",
        "status",
        "file_name as fileName",
        "content_type as contentType",
        "storage_key as storageKey",
        "content_hash as contentHash",
      ])
      .where("id", "=", documentId)
      .where("booking_id", "=", bookingId)
      .executeTakeFirst();
  }

  /** The document stored at `storageKey`, with its booking's environment (OBE-054: the file endpoint). */
  async fileByStorageKey(trx: TenantTransaction, storageKey: string): Promise<StoredFileRow | undefined> {
    return await trx
      .selectFrom("booking_documents as d")
      .innerJoin("bookings as b", "b.id", "d.booking_id")
      .select([
        "d.id as id",
        "d.booking_id as bookingId",
        "d.status as status",
        "d.file_name as fileName",
        "d.content_type as contentType",
        "d.content_hash as contentHash",
        "b.environment as environment",
      ])
      .where("d.storage_key", "=", storageKey)
      .executeTakeFirst();
  }
}
