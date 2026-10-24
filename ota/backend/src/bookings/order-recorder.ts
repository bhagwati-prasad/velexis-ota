// The record step of the booking orchestration and the booking as an answer (OBE-042; ota/docs/architecture-booking.md
// §1 step 3, OADR-0008 point 3, db README §8, the contract's checkout.complete step 6 and its Booking schema).
//
// `readCreatedOrder` reads the Flight Create Orders answer leniently: the order id, the associated records (the first
// is the main record locator), the offers (parsed as the shopping module parses them), the tickets, the ticketing
// agreement, the automated processes and the forms of payment. An answer without an id or a record locator cannot be
// recorded: the orchestration treats it like a lost answer (the order may exist).
//
// `OrderRecorder.record`, inside the caller's T2 transaction (the booking locked, still `pending`):
//   - `booking_associated_records`, `booking_segments` (local times as Amadeus gives them, instants through the
//     airports' time zones, the lead traveller's cabin, class, fare basis, branded fare and bags), `booking_travelers`
//     (documents and discount cards sealed again for the booking row, associated data
//     `tenant_<key>.booking_travelers.<column>:<btr_…>`; only the main document's type, last 4, expiry and countries
//     stay readable), `booking_contacts`, `booking_remarks` (the special requests, visible to the customer, and the
//     `VELEXIS <reference>` back-office remark, never), `booking_tickets` when the order came back issued;
//   - the booking: `confirmed`, `ticketed` (every traveller has an e-ticket) or `partially_ticketed`, the Amadeus order
//     id, record locator, offices, `last_ticketing_date` (the earliest of the offers) and `ticketing_deadline_at` (its
//     start in the OTA's time zone, or the ticketing agreement's date when earlier, OADR-0008 point 3), the ticketing
//     agreement, automated processes and forms of payment, the forms of identification with their numbers cut to the
//     last 4 characters (`form_of_identifications`, OBE-062's maskedIdentifications, since FIX-W27-SYNC), `order_snapshot`
//     (the order after the shared redactor: document, discount card and certificate numbers masked, card data
//     removed), `last_synced_at`;
//   - `ticketing_status`: `issued` / `partially_issued` with tickets; without them `failed` when the order was asked
//     to issue (the ticketing job retries from 5 minutes later, OBE-044), `manual_review` for that policy, else
//     `pending` (capture, then Flight Order Issue);
//   - the outbox `booking.confirmed` to the primary contact (dedupe key `booking.confirmed:<bkg_…>`), and
//     `booking_events` (`booking.created`, and `booking.ticketed` or `booking.ticketing_failed`).
//
// `OrderRecorder.event` is the one way the bookings module writes a booking event, so it is where the booking documents
// are asked for (OBE-053, documents/documents.processor.ts): `booking.created` (the itinerary, and the e-ticket receipts
// of an order that came back issued), `booking.ticketed` (the receipts and a new itinerary, whichever path stored the
// tickets: checkout.complete, the ticketing job, the sync, a refresh), `booking.schedule_changed` (a new itinerary,
// whichever synchronisation found the change; lead decision (3) of 2026-10-23) and `booking.cancelled` (the cancelled
// itinerary) enqueue `document.render` jobs after the commit of the event's transaction. For the same reason
// `booking.ticketed` also queues the traveller's `booking.ticketed` e-mail with the e-tickets (OBE-055, flow §3 step 7:
// dedupe key `booking.ticketed:<bkg_…>:v<version>`), which the worker sends with the receipts attached once they are
// ready (notifications/attachments.ts), as it sends `booking.confirmed` with the itinerary.
//
// `toBooking` turns the stored rows into the contract's Booking in customer scope: selling amounts only (no net,
// markup or office), documents with `numberMasked`, discount numbers masked, customer-visible remarks only. Bookings
// without an Amadeus order view leave `amadeus` out (bookings.get of OBE-046 adds it).
import { Inject, Injectable, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import { aadFor, decryptValue, encryptValue, LocalFileKeyProvider, type KeyProvider } from "@velexis/crypto";
import type { Insertable, TenantDatabase, TenantSchema } from "@velexis/db";
import { redactPayload } from "@velexis/logger";
import { PinoLogger } from "nestjs-pino";
import type {
  CheckoutContactRow,
  CheckoutRemarkRow,
  CheckoutTravelerRow,
} from "../checkout/checkout.repository";
import {
  readableDiscount,
  readableDocument,
  type AmadeusDiscount,
  type StoredDocument,
} from "../checkout/traveler-documents";
import { IdGenerator } from "../common/ids";
import type { SharedConfig } from "../config";
import { DocumentRequests } from "../documents/documents.processor";
import { storefrontUrl } from "../notifications/renderer";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { Money } from "../pricing/pricing.types";
import { parseOffer, type ParsedOffer } from "../shopping/offers.mapper";
import { warningsOf } from "../shopping/priced-offers.mapper";
import { TenantContext, type ContextActor } from "../tenancy/tenant-context";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import { velexisRemarkText } from "./booking-reference";
import { maskedIdentifications } from "./identifications";
import {
  BookingsRepository,
  type BookingChildren,
  type BookingRow,
  type BookingSettingsRow,
  type BookingTravelerRow,
} from "./bookings.repository";
import {
  SPECIAL_REQUEST_SUBTYPE,
  VELEXIS_REMARK_SUBTYPE,
  type TicketingPolicy,
} from "./order-request.builder";

type Schemas = components["schemas"];
export type Booking = Schemas["Booking"];
export type CheckoutCompletion = Schemas["CheckoutCompletion"];
export type Warning = Schemas["Warning"];
type Payment = Schemas["Payment"];
type Traveler = Schemas["Traveler"];
type Contact = Schemas["Contact"];
type Ticket = Schemas["Ticket"];
type Remark = Schemas["Remark"];
type BookingItinerary = Schemas["BookingItinerary"];
type BookingSegment = Schemas["BookingSegment"];
type MoneyAmount = Schemas["Money"];
type AmadeusName = Schemas["AmadeusName"];
type Db = TenantDatabase;

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** How long after a failed issuance the ticketing job tries again first (OADR-0008 point 4). */
export const FIRST_TICKETING_RETRY_MS = 5 * 60_000;

/** How long a synchronisation counts as fresh in an answer (Booking.syncStatus). */
const FRESH_SYNC_MS = 6 * 60 * 60_000;

/** The booking event of stored tickets, which queues the traveller's e-ticket e-mail of the same name. */
export const TICKETED_EVENT = "booking.ticketed";

/** The ticket type of an e-ticket (`booking_tickets.document_type`), the tickets the e-ticket e-mail lists. */
const E_TICKET_TYPE = "ETICKET";

/** A BCP 47 locale as the outbox accepts it. */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

// ---- The created order ---------------------------------------------------------------------------------------------

/** An Amadeus AirTravelDocument of an order. */
export interface OrderTicket {
  readonly documentType: string;
  readonly documentNumber: string;
  readonly documentStatus: string;
  readonly travelerId: string | null;
  readonly segmentIds: readonly string[];
  readonly raw: JsonObject;
}

/** An `associatedRecords` entry. */
export interface OrderRecord {
  readonly reference: string;
  readonly originSystemCode: string;
  readonly creationDate: string | null;
  readonly flightOfferId: string | null;
}

/** A Flight Create Orders (or Flight Order Issue) answer, read for the record step. */
export interface CreatedOrder {
  /** `data.id`. */
  readonly id: string;
  readonly records: readonly OrderRecord[];
  readonly queuingOfficeId: string | null;
  readonly ownerOfficeId: string | null;
  readonly offers: readonly ParsedOffer[];
  readonly travelerIds: readonly string[];
  readonly tickets: readonly OrderTicket[];
  readonly ticketingAgreement: JsonObject | null;
  readonly automatedProcess: readonly JsonObject[];
  readonly formOfPayments: readonly JsonObject[];
  /** `data` as answered (the snapshot is written after the shared redactor). */
  readonly data: JsonObject;
  readonly dictionaries: unknown;
  readonly warnings: readonly Warning[];
}

const DOCUMENT_TYPES = ["ETICKET", "PTICKET", "EMD", "MCO"] as const;
const DOCUMENT_STATUSES = ["ISSUED", "REFUNDED", "VOID", "ORIGINAL", "EXCHANGED"] as const;
const DOCUMENT_NUMBER = /^[0-9]{3}-?[0-9]{6,13}$/;

/** The travel documents of an order's `data` (`tickets[]`), each with a valid type and number. */
export function ticketsOf(data: JsonObject): OrderTicket[] {
  return records(data["tickets"]).flatMap((raw) => {
    const documentType = text(raw["documentType"]);
    const documentNumber = text(raw["documentNumber"]);
    if (
      documentType === undefined ||
      documentNumber === undefined ||
      !(DOCUMENT_TYPES as readonly string[]).includes(documentType) ||
      !DOCUMENT_NUMBER.test(documentNumber)
    ) {
      return [];
    }
    const status = text(raw["documentStatus"]);
    return [
      {
        documentType,
        documentNumber,
        documentStatus:
          status !== undefined && (DOCUMENT_STATUSES as readonly string[]).includes(status)
            ? status
            : "ISSUED",
        travelerId: text(raw["travelerId"]) ?? null,
        segmentIds: strings(raw["segmentIds"]),
        raw: { ...raw },
      },
    ];
  });
}

/**
 * The order of a Flight Create Orders or Flight Order Issue answer, or `undefined` when it cannot be recorded (no id,
 * no record locator of the stored form, an offer that cannot be read).
 */
export function readCreatedOrder(body: unknown): CreatedOrder | undefined {
  const data = isRecord(body) && isRecord(body["data"]) ? body["data"] : undefined;
  const id = data === undefined ? undefined : text(data["id"]);
  if (data === undefined || id === undefined) {
    return undefined;
  }
  const orderRecords: OrderRecord[] = records(data["associatedRecords"]).flatMap((raw) => {
    const reference = text(raw["reference"]);
    const originSystemCode = text(raw["originSystemCode"]);
    return reference === undefined || originSystemCode === undefined
      ? []
      : [
          {
            reference,
            originSystemCode,
            creationDate: text(raw["creationDate"]) ?? null,
            flightOfferId: text(raw["flightOfferId"]) ?? null,
          },
        ];
  });
  const main = orderRecords[0];
  if (main === undefined || !/^[A-Z0-9]{5,8}$/.test(main.reference)) {
    return undefined;
  }
  const offers: ParsedOffer[] = [];
  for (const raw of records(data["flightOffers"])) {
    const parsed = parseOffer(raw);
    if (parsed === undefined) {
      return undefined;
    }
    offers.push(parsed);
  }
  if (offers.length === 0) {
    return undefined;
  }
  const travelerIds = records(data["travelers"]).flatMap((traveler) => strings([traveler["id"]]));
  return {
    id,
    records: orderRecords,
    queuingOfficeId: text(data["queuingOfficeId"]) ?? null,
    ownerOfficeId: text(data["ownerOfficeId"]) ?? null,
    offers,
    travelerIds:
      travelerIds.length > 0
        ? travelerIds
        : [
            ...new Set(
              offers.flatMap((offer) => offer.travelerPricings.map((pricing) => pricing.travelerId)),
            ),
          ],
    tickets: ticketsOf(data),
    ticketingAgreement: isRecord(data["ticketingAgreement"]) ? { ...data["ticketingAgreement"] } : null,
    automatedProcess: records(data["automatedProcess"]),
    formOfPayments: records(data["formOfPayments"]),
    data,
    dictionaries: isRecord(body) ? body["dictionaries"] : undefined,
    warnings: warningsOf(isRecord(body) ? body["warnings"] : undefined),
  };
}

// ---- Ticketing -----------------------------------------------------------------------------------------------------

/** How much of an order the e-tickets cover: every traveller, some, or none. */
export type TicketCoverage = "full" | "partial" | "none";

/** The coverage of `tickets` (e-tickets with a traveller) over the order's travellers. */
export function ticketCoverage(
  travelerIds: readonly string[],
  tickets: readonly OrderTicket[],
): TicketCoverage {
  const ticketed = new Set(
    tickets
      .filter((ticket) => ticket.documentType === "ETICKET" && ticket.documentStatus === "ISSUED")
      .flatMap((ticket) => (ticket.travelerId === null ? [] : [ticket.travelerId])),
  );
  const covered = travelerIds.filter((id) => ticketed.has(id)).length;
  if (travelerIds.length > 0 && covered === travelerIds.length) {
    return "full";
  }
  return covered > 0 ? "partial" : "none";
}

/** The booking status and ticketing status after an order (or an issuance) with this coverage. */
export function ticketingStateOf(
  coverage: TicketCoverage,
  options: { readonly issueRequested: boolean; readonly policy: TicketingPolicy },
): { readonly status: string; readonly ticketingStatus: string; readonly issueFailed: boolean } {
  if (coverage === "full") {
    return { status: "ticketed", ticketingStatus: "issued", issueFailed: false };
  }
  if (coverage === "partial") {
    return { status: "partially_ticketed", ticketingStatus: "partially_issued", issueFailed: false };
  }
  if (options.issueRequested) {
    return { status: "confirmed", ticketingStatus: "failed", issueFailed: true };
  }
  return {
    status: "confirmed",
    ticketingStatus: options.policy === "manual_review" ? "manual_review" : "pending",
    issueFailed: false,
  };
}

/** The earliest `lastTicketingDate` of the offers (`YYYY-MM-DD`), or `null`. */
export function lastTicketingDateOf(offers: readonly ParsedOffer[]): string | null {
  return offers.flatMap((offer) => offer.lastTicketingDate ?? []).sort()[0] ?? null;
}

/**
 * The local date-time of the ticketing deadline (OADR-0008 point 3): the start of `lastTicketingDate`, or the order's
 * `ticketingAgreement.dateTime` when it is earlier (a date is read at 00:00); `null` when neither is known. The caller
 * reads it in the OTA's time zone.
 */
export function deadlineLocalOf(
  lastTicketingDate: string | null,
  agreement: JsonObject | null,
): string | null {
  const local = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2}))?)?/.exec(value);
    if (match?.[1] === undefined) {
      return undefined;
    }
    return `${match[1]}T${match[2] ?? "00:00"}:${match[3] ?? "00"}`;
  };
  const candidates = [local(lastTicketingDate), local(agreement?.["dateTime"])].filter(
    (value): value is string => value !== undefined,
  );
  return candidates.sort()[0] ?? null;
}

// ---- Segments ------------------------------------------------------------------------------------------------------

/** A segment row of an order, before its instants and ids. */
export interface SegmentPlan {
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
  readonly arrivalIata: string;
  readonly arrivalTerminal: string | null;
  readonly arrivalLocal: string;
  readonly durationMinutes: number | null;
  readonly numberOfStops: number;
  readonly stops: readonly JsonObject[];
  readonly co2Emissions: readonly JsonObject[];
  readonly cabin: string | null;
  readonly bookingClass: string | null;
  readonly fareBasis: string | null;
  readonly brandedFare: string | null;
  readonly includedCheckedBags: JsonObject | null;
  readonly fareDetails: readonly JsonObject[];
}

const CABINS = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"];

/**
 * The segments of an order's offers, in order: itineraries numbered across the offers (one-way offers priced together
 * make one booking of several bounds), segments within each itinerary; the fare of the lead traveller (the first
 * pricing) for the cabin, class, fare basis, branded fare and included bags, every traveller's in `fareDetails`.
 */
export function segmentPlansOf(offers: readonly ParsedOffer[]): SegmentPlan[] {
  const plans: SegmentPlan[] = [];
  let itineraryOffset = 0;
  for (const offer of offers) {
    offer.itineraries.forEach((itinerary, itineraryIndex) => {
      itinerary.segments.forEach((segment, segmentIndex) => {
        const index = itineraryOffset + itineraryIndex;
        const segmentId = segment.id === "" ? `${index + 1}${segmentIndex + 1}` : segment.id;
        const details = offer.travelerPricings.flatMap((pricing) =>
          pricing.fareDetails
            .filter((detail) => detail.segmentId === segment.id)
            .map((detail) => ({ travelerId: pricing.travelerId, detail })),
        );
        const lead = details[0]?.detail;
        const bags = lead?.checkedBags ?? null;
        plans.push({
          amadeusFlightOfferId: offer.amadeusId,
          amadeusSegmentId: segmentId,
          itineraryIndex: index,
          segmentIndex,
          carrierCode: segment.carrierCode,
          flightNumber: segment.number,
          operatingCarrierCode: segment.operatingCarrier,
          aircraftCode: segment.aircraft,
          departureIata: segment.departure.iataCode,
          departureTerminal: segment.departure.terminal,
          departureLocal: segment.departure.at,
          arrivalIata: segment.arrival.iataCode,
          arrivalTerminal: segment.arrival.terminal,
          arrivalLocal: segment.arrival.at,
          durationMinutes: segment.durationMinutes,
          numberOfStops: segment.numberOfStops,
          stops: segment.stops,
          co2Emissions: segment.co2Emissions,
          cabin:
            lead?.cabin !== undefined && lead.cabin !== null && CABINS.includes(lead.cabin)
              ? lead.cabin
              : null,
          bookingClass:
            lead?.bookingClass !== undefined &&
            lead.bookingClass !== null &&
            /^[A-Z]$/.test(lead.bookingClass)
              ? lead.bookingClass
              : null,
          fareBasis: lead?.fareBasis ?? null,
          brandedFare: lead?.brandedFare ?? null,
          includedCheckedBags:
            bags === null
              ? null
              : { quantity: bags.quantity, weight: bags.weight, weightUnit: bags.weightUnit },
          fareDetails: details.map(({ travelerId, detail }) => ({
            travelerId,
            cabin: detail.cabin,
            fareBasis: detail.fareBasis,
            brandedFare: detail.brandedFare,
            class: detail.bookingClass,
          })),
        });
      });
    });
    itineraryOffset += offer.itineraries.length;
  }
  return plans;
}

// ---- Booking travellers' documents at rest -------------------------------------------------------------------------

/** Injection token of the KEKs that seal the booking traveller columns (MASTER_KEY_DIR, MASTER_KEY_CURRENT). */
export const BOOKINGS_KEY_PROVIDER = "BOOKINGS_KEY_PROVIDER";

/** The KEKs of MASTER_KEY_DIR, MASTER_KEY_CURRENT (ADR-0010, ADR-0026); the API does not start without them. */
export const bookingsKeyProvider: FactoryProvider<Promise<KeyProvider>> = {
  provide: BOOKINGS_KEY_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<SharedConfig, true>) =>
    LocalFileKeyProvider.fromDir(
      config.get("MASTER_KEY_DIR", { infer: true }),
      config.get("MASTER_KEY_CURRENT", { infer: true }),
    ),
};

const BOOKING_TRAVELERS = "booking_travelers";
const DOCUMENTS_COLUMN = "documents_ciphertext";
const DISCOUNTS_COLUMN = "discount_eligibility_ciphertext";

/**
 * A booking traveller's documents and discount entries at rest, as checkout travellers keep theirs
 * (checkout/traveler-documents.ts), under the associated data of the booking row:
 * `tenant_<key>.booking_travelers.<column>:<btr_…>`. Decrypted values live in memory only; buffers are zeroed.
 */
@Injectable()
export class BookingTravelerDocuments {
  constructor(@Inject(BOOKINGS_KEY_PROVIDER) private readonly keys: KeyProvider) {}

  async seal(
    schema: TenantSchema,
    travelerRowId: string,
    documents: readonly StoredDocument[],
    discounts: readonly AmadeusDiscount[],
  ): Promise<{
    readonly documentsCiphertext: Buffer | null;
    readonly discountEligibilityCiphertext: Buffer | null;
    readonly encryptionKeyId: string | null;
  }> {
    const sealOne = async (column: string, value: readonly unknown[]) =>
      value.length === 0
        ? undefined
        : await encryptValue(JSON.stringify(value), {
            aad: aadFor(schema, BOOKING_TRAVELERS, column, travelerRowId),
            keys: this.keys,
          });
    const documentsSealed = await sealOne(DOCUMENTS_COLUMN, documents);
    const discountsSealed = await sealOne(DISCOUNTS_COLUMN, discounts);
    return {
      documentsCiphertext: documentsSealed?.ciphertext ?? null,
      discountEligibilityCiphertext: discountsSealed?.ciphertext ?? null,
      encryptionKeyId: documentsSealed?.kekId ?? discountsSealed?.kekId ?? null,
    };
  }

  async open(
    schema: TenantSchema,
    row: Pick<BookingTravelerRow, "id" | "documentsCiphertext" | "discountEligibilityCiphertext">,
  ): Promise<{ readonly documents: StoredDocument[]; readonly discounts: AmadeusDiscount[] }> {
    const openOne = async (column: string, value: Buffer | null): Promise<unknown[]> => {
      if (value === null) {
        return [];
      }
      const plaintext = await decryptValue(value, {
        aad: aadFor(schema, BOOKING_TRAVELERS, column, row.id),
        keys: this.keys,
      });
      try {
        const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
        if (!Array.isArray(parsed)) {
          throw new Error("a sealed booking traveller list cannot be read");
        }
        return parsed as unknown[];
      } finally {
        plaintext.fill(0);
      }
    };
    return {
      documents: (await openOne(DOCUMENTS_COLUMN, row.documentsCiphertext)) as StoredDocument[],
      discounts: (await openOne(DISCOUNTS_COLUMN, row.discountEligibilityCiphertext)) as AmadeusDiscount[],
    };
  }
}

// ---- Recording (T2) ------------------------------------------------------------------------------------------------

/** A checkout traveller with its decrypted lists. */
export interface CheckoutTravelerView {
  readonly row: CheckoutTravelerRow;
  readonly documents: readonly StoredDocument[];
  readonly discounts: readonly AmadeusDiscount[];
}

/** What the record step needs. */
export interface RecordOrderInput {
  readonly schema: TenantSchema;
  readonly tenantKey: string;
  /** The booking, locked by the caller, still `pending`. */
  readonly booking: BookingRow;
  readonly order: CreatedOrder;
  readonly travelers: readonly CheckoutTravelerView[];
  readonly contacts: readonly CheckoutContactRow[];
  readonly remarks: readonly CheckoutRemarkRow[];
  readonly settings: BookingSettingsRow;
  readonly policy: TicketingPolicy;
  readonly issueRequested: boolean;
  /** The e-mail's locale. */
  readonly locale: string;
  readonly actor: ContextActor;
  readonly requestId: string;
  readonly supplierRequestId: string | null;
  readonly now: Date;
}

/** What the record step decided. */
export interface RecordedOrder {
  readonly status: string;
  readonly ticketingStatus: string;
  readonly coverage: TicketCoverage;
  /** The order was asked to issue and came back without a ticket. */
  readonly issueFailed: boolean;
}

/** `booking_events.actor_type` of a request's actor. */
export function eventActorOf(actor: ContextActor): { readonly type: string; readonly id: string | null } {
  return { type: actor.type, id: actor.id };
}

/** The main document of a traveller (the first one the traveller holds, else the first), for the readable columns. */
function mainDocumentOf(documents: readonly StoredDocument[]): StoredDocument | undefined {
  return documents.find((document) => document.holder) ?? documents[0];
}

/** `YYYY-MM-DD` of a document date, or `null`. */
const dateOrNull = (value: string | undefined): string | null =>
  value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

/** An upper-case country code, or `null`. */
const countryOrNull = (value: string | undefined): string | null =>
  value !== undefined && /^[A-Z]{2}$/.test(value) ? value : null;

@Injectable()
export class OrderRecorder {
  private readonly baseDomain: string;

  constructor(
    private readonly repository: BookingsRepository,
    private readonly documents: BookingTravelerDocuments,
    private readonly outbox: OutboxService,
    private readonly ids: IdGenerator,
    private readonly logger: PinoLogger,
    config: ConfigService<SharedConfig, true>,
    private readonly documentRequests: DocumentRequests,
    private readonly tenants: TenantContext,
  ) {
    logger.setContext(OrderRecorder.name);
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** The record step, in the caller's transaction (see the file header). */
  async record(trx: TenantTransaction, input: RecordOrderInput): Promise<RecordedOrder> {
    const { booking, order, now } = input;
    const segments = await this.segmentRows(trx, booking.id, order.offers, now);
    const travelers = await this.travelerRows(input);
    const travelerRowIds = new Map(travelers.map((row) => [row.amadeus_traveler_id, row.id]));
    const coverage = ticketCoverage(order.travelerIds, order.tickets);
    const state = ticketingStateOf(coverage, { issueRequested: input.issueRequested, policy: input.policy });
    const lastTicketingDate = lastTicketingDateOf(order.offers);
    const deadlineLocal = deadlineLocalOf(lastTicketingDate, order.ticketingAgreement);
    const [deadline] =
      deadlineLocal === null
        ? [undefined]
        : await this.repository.instants(trx, [{ local: deadlineLocal, zone: input.settings.timeZone }]);
    await this.repository.insertChildren(trx, {
      associatedRecords: order.records.map((record, index) => ({
        id: this.ids.newId("bar"),
        booking_id: booking.id,
        reference: record.reference,
        origin_system_code: record.originSystemCode,
        creation_date: record.creationDate,
        flight_offer_id: record.flightOfferId,
        is_primary: index === 0,
        created_at: now,
        updated_at: now,
      })),
      travelers,
      contacts: input.contacts.map((contact, index) => ({
        id: this.ids.newId("bco"),
        booking_id: booking.id,
        purpose: contact.purpose,
        is_primary: contact.isPrimary,
        first_name: contact.firstName,
        last_name: contact.lastName,
        company_name: contact.companyName,
        email: contact.email,
        phones: JSON.stringify(Array.isArray(contact.phones) ? contact.phones : []),
        address:
          contact.address === null || contact.address === undefined ? null : JSON.stringify(contact.address),
        language: contact.language,
        // The checkout's order, one millisecond apart: the table has no position column.
        created_at: new Date(now.getTime() + index),
        updated_at: now,
      })),
      segments,
      remarks: [
        ...input.remarks.map((remark, index) => ({
          id: this.ids.newId("rmk"),
          booking_id: booking.id,
          kind: "general",
          sub_type: SPECIAL_REQUEST_SUBTYPE,
          text: remark.text.toUpperCase(),
          traveler_ids: [...remark.travelerIds],
          visible_to_customer: true,
          created_at: new Date(now.getTime() + index),
          updated_at: now,
        })),
        {
          id: this.ids.newId("rmk"),
          booking_id: booking.id,
          kind: "general",
          sub_type: VELEXIS_REMARK_SUBTYPE,
          text: velexisRemarkText(booking.reference),
          visible_to_customer: false,
          created_at: new Date(now.getTime() + input.remarks.length),
          updated_at: now,
        },
      ],
      tickets: this.ticketRows(booking.id, order, travelerRowIds, now),
    });
    const first = segments[0];
    const last = segments.at(-1);
    await this.repository.updateBooking(trx, booking.id, {
      status: state.status,
      amadeus_order_id: order.id,
      record_locator: order.records[0]?.reference ?? null,
      origin_system_code: order.records[0]?.originSystemCode ?? null,
      queuing_office_id: order.queuingOfficeId ?? booking.queuingOfficeId,
      owner_office_id: order.ownerOfficeId ?? booking.ownerOfficeId,
      last_ticketing_date: lastTicketingDate,
      ticketing_deadline_at: deadline ?? null,
      ticketing_agreement:
        order.ticketingAgreement === null ? null : JSON.stringify(order.ticketingAgreement),
      automated_process: JSON.stringify(order.automatedProcess),
      issued_at: coverage === "none" ? null : now,
      ticketing_status: state.ticketingStatus,
      ...(input.issueRequested
        ? {
            ticketing_requested_at: now,
            ticketing_attempts: 1,
            ticketing_last_attempt_at: now,
            ticketing_next_attempt_at: state.issueFailed
              ? new Date(now.getTime() + FIRST_TICKETING_RETRY_MS)
              : null,
            ticketing_error_code: state.issueFailed ? "TICKETING_FAILED" : null,
            ticketing_error: state.issueFailed
              ? "Flight Create Orders with issue=true returned no ticket"
              : null,
          }
        : {}),
      validating_carrier: order.offers[0]?.validatingAirlineCodes[0] ?? booking.validatingCarrier,
      form_of_payments: JSON.stringify(redactPayload(order.formOfPayments)),
      // The forms of identification, numbers cut to their last 4 (FIX-W27-SYNC: console.bookings.get shows them).
      form_of_identifications: JSON.stringify(maskedIdentifications(order.data["formOfIdentifications"])),
      order_snapshot: JSON.stringify(redactPayload(order.data)),
      order_dictionaries: order.dictionaries === undefined ? null : JSON.stringify(order.dictionaries),
      ...(first === undefined || last === undefined
        ? {}
        : {
            first_departure_at: first.departure_at,
            last_arrival_at: segments.reduce(
              (latest, segment) =>
                new Date(segment.arrival_at).getTime() > new Date(latest).getTime()
                  ? segment.arrival_at
                  : latest,
              last.arrival_at,
            ),
          }),
      last_synced_at: now,
      updated_at: now,
    });
    // The confirmation first, so it is queued (and, its itinerary ready, sent) before an e-ticket e-mail of the same
    // transaction.
    await this.confirmationEmail(trx, input, segments, travelers);
    const actor = eventActorOf(input.actor);
    await this.event(trx, booking.id, {
      type: "booking.created",
      actor,
      statusFrom: "pending",
      statusTo: state.status,
      summary: `Booking ${booking.reference} confirmed by the airline (record locator ${order.records[0]?.reference ?? ""}).`,
      data: { recordLocator: order.records[0]?.reference ?? null, issueRequested: input.issueRequested },
      visibleToCustomer: true,
      supplierRequestId: input.supplierRequestId,
      requestId: input.requestId,
      now,
    });
    if (coverage !== "none") {
      await this.event(trx, booking.id, {
        type: TICKETED_EVENT,
        actor,
        statusFrom: state.status,
        statusTo: state.status,
        summary: "E-tickets issued.",
        data: { tickets: order.tickets.map((ticket) => ticket.documentNumber) },
        visibleToCustomer: true,
        supplierRequestId: input.supplierRequestId,
        requestId: input.requestId,
        now,
      });
    } else if (state.issueFailed) {
      await this.event(trx, booking.id, {
        type: "booking.ticketing_failed",
        actor,
        statusFrom: state.status,
        statusTo: state.status,
        summary: "The order was created, but the airline did not issue the tickets yet.",
        data: { attempt: 1, code: "TICKETING_FAILED" },
        visibleToCustomer: false,
        supplierRequestId: input.supplierRequestId,
        requestId: input.requestId,
        now,
      });
    }
    return {
      status: state.status,
      ticketingStatus: state.ticketingStatus,
      coverage,
      issueFailed: state.issueFailed,
    };
  }

  /** Records the tickets of a Flight Order Issue answer on a booking (T4 of the orchestration). */
  ticketRows(
    bookingId: string,
    order: Pick<CreatedOrder, "tickets" | "offers">,
    travelerRowIds: ReadonlyMap<string, string>,
    now: Date,
  ): Insertable<Db["booking_tickets"]>[] {
    return order.tickets.map((ticket) => ({
      id: this.ids.newId("tkt"),
      booking_id: bookingId,
      booking_traveler_id:
        ticket.travelerId === null ? null : (travelerRowIds.get(ticket.travelerId) ?? null),
      amadeus_traveler_id: ticket.travelerId,
      document_type: ticket.documentType,
      document_number: ticket.documentNumber,
      status: ticket.documentStatus,
      segment_ids: [...ticket.segmentIds],
      validating_carrier: order.offers[0]?.validatingAirlineCodes[0] ?? null,
      issued_at: now,
      details: JSON.stringify(redactPayload(ticket.raw)),
      created_at: now,
      updated_at: now,
    }));
  }

  /**
   * Appends a booking event; `data` goes through the shared redactor. The events that change a booking document ask
   * for it in the same transaction, and `booking.ticketed` queues the e-ticket e-mail (see the file header).
   */
  async event(
    trx: TenantTransaction,
    bookingId: string,
    event: {
      readonly type: string;
      readonly actor: { readonly type: string; readonly id: string | null };
      readonly statusFrom?: string | null;
      readonly statusTo?: string | null;
      readonly summary: string;
      readonly data?: Record<string, unknown>;
      readonly visibleToCustomer: boolean;
      readonly supplierRequestId?: string | null;
      readonly requestId: string;
      readonly now: Date;
      /**
       * `false` keeps the traveller's e-mail of the event out of the outbox (console.bookings.issue with
       * `notifyCustomer: false`, OBE-063); the documents are asked for all the same.
       */
      readonly notifyCustomer?: boolean;
    },
  ): Promise<void> {
    await this.repository.insertEvent(trx, {
      id: this.ids.newId("evt"),
      booking_id: bookingId,
      type: event.type,
      actor_type: event.actor.type,
      actor_id: event.actor.id,
      status_from: event.statusFrom ?? null,
      status_to: event.statusTo ?? null,
      summary: event.summary,
      data: JSON.stringify(redactPayload(event.data ?? {})),
      visible_to_customer: event.visibleToCustomer,
      supplier_request_id: event.supplierRequestId ?? null,
      request_id: event.requestId,
      created_at: event.now,
      updated_at: event.now,
    });
    await this.documentRequests.afterBookingEvent(trx, bookingId, event.type);
    if (event.type === TICKETED_EVENT && event.notifyCustomer !== false) {
      await this.ticketedEmail(trx, bookingId);
    }
  }

  /**
   * The outbox `booking.ticketed` e-mail of a `booking.ticketed` event (see the file header): the booking's e-tickets
   * to the primary contact (or the booking's contact e-mail), in the contact's language or the storefront's, once per
   * booking version. A booking without e-tickets queues nothing; a call the outbox refuses (InvalidNotificationError,
   * raised before any SQL) is logged and skipped: the tickets are recorded all the same.
   */
  private async ticketedEmail(trx: TenantTransaction, bookingId: string): Promise<void> {
    const booking = await this.repository.booking(trx, bookingId);
    if (booking === undefined) {
      return;
    }
    const children = await this.repository.children(trx, bookingId);
    const tickets = children.tickets.filter((ticket) => ticket.documentType === E_TICKET_TYPE);
    if (tickets.length === 0) {
      return;
    }
    const settings = await this.repository.settings(trx);
    const primary = children.contacts.find((contact) => contact.isPrimary) ?? children.contacts[0];
    const language = primary?.language ?? null;
    const names = new Map(
      children.travelers.map((traveler) => [
        traveler.amadeusTravelerId,
        `${traveler.firstName} ${traveler.lastName}`.trim(),
      ]),
    );
    try {
      await this.outbox.enqueue(trx, {
        templateKey: TICKETED_EVENT,
        to: primary?.email ?? booking.contactEmail,
        locale: language !== null && LOCALE.test(language) ? language : (settings?.defaultLocale ?? "en"),
        customerId: booking.customerId,
        bookingId: booking.id,
        dedupeKey: `${TICKETED_EVENT}:${booking.id}:v${booking.version}`,
        data: {
          booking: {
            reference: booking.reference,
            recordLocator: booking.recordLocator ?? "",
            url: `${storefrontUrl(this.tenants.require().key, this.baseDomain)}/booking.html?id=${booking.id}`,
            total: { amount: booking.totalAmount, currency: booking.currency },
            contact: { firstName: primary?.firstName ?? "", lastName: primary?.lastName ?? "" },
            travellers: children.travelers.map((traveler) => ({
              firstName: traveler.firstName,
              lastName: traveler.lastName,
            })),
            segments: children.segments.map((segment) => ({
              origin: segment.departureIata,
              destination: segment.arrivalIata,
              departureAt: segment.departureLocal,
              arrivalAt: segment.arrivalLocal,
              carrierCode: segment.carrierCode,
              flightNumber: segment.flightNumber,
            })),
          },
          tickets: tickets.map((ticket) => ({
            number: ticket.documentNumber,
            travellerName: names.get(ticket.amadeusTravelerId ?? "") ?? "",
          })),
        },
      });
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.error({ bookingId, err: error }, "bookings.ticketed_email_invalid");
    }
  }

  /** The segment rows of the order, with their instants read in the airports' time zones (UTC when unknown). */
  private async segmentRows(
    trx: TenantTransaction,
    bookingId: string,
    offers: readonly ParsedOffer[],
    now: Date,
  ): Promise<Array<Insertable<Db["booking_segments"]> & { departure_at: Date; arrival_at: Date }>> {
    const plans = segmentPlansOf(offers);
    const zones = await this.repository.airportTimeZones(
      trx,
      plans.flatMap((plan) => [plan.departureIata, plan.arrivalIata]),
    );
    const instants = await this.repository.instants(
      trx,
      plans.flatMap((plan) => [
        { local: plan.departureLocal, zone: zones.get(plan.departureIata) ?? "UTC" },
        { local: plan.arrivalLocal, zone: zones.get(plan.arrivalIata) ?? "UTC" },
      ]),
    );
    return plans.map((plan, index) => {
      const departureAt = instants[index * 2] ?? now;
      const arrivalAt = instants[index * 2 + 1] ?? departureAt;
      return {
        id: this.ids.newId("seg"),
        booking_id: bookingId,
        amadeus_flight_offer_id: plan.amadeusFlightOfferId,
        amadeus_segment_id: plan.amadeusSegmentId,
        itinerary_index: plan.itineraryIndex,
        segment_index: plan.segmentIndex,
        carrier_code: plan.carrierCode,
        flight_number: plan.flightNumber,
        operating_carrier_code: plan.operatingCarrierCode,
        aircraft_code: plan.aircraftCode,
        departure_iata: plan.departureIata,
        departure_terminal: plan.departureTerminal,
        departure_local: plan.departureLocal,
        departure_at: departureAt,
        arrival_iata: plan.arrivalIata,
        arrival_terminal: plan.arrivalTerminal,
        arrival_local: plan.arrivalLocal,
        // An arrival before the departure (unknown zones) would break `booking_segments_time_ck`.
        arrival_at: arrivalAt.getTime() < departureAt.getTime() ? departureAt : arrivalAt,
        duration_minutes: plan.durationMinutes,
        number_of_stops: plan.numberOfStops,
        stops: plan.stops.length === 0 ? null : JSON.stringify(plan.stops),
        cabin: plan.cabin,
        booking_class: plan.bookingClass,
        fare_basis: plan.fareBasis,
        branded_fare: plan.brandedFare,
        included_checked_bags:
          plan.includedCheckedBags === null ? null : JSON.stringify(plan.includedCheckedBags),
        fare_details: JSON.stringify(plan.fareDetails),
        co2_emissions: plan.co2Emissions.length === 0 ? null : JSON.stringify(plan.co2Emissions),
        created_at: now,
        updated_at: now,
      };
    });
  }

  /** The traveller rows, their documents sealed again for the booking. */
  private async travelerRows(
    input: RecordOrderInput,
  ): Promise<Array<Insertable<Db["booking_travelers"]> & { id: string; amadeus_traveler_id: string }>> {
    const rows: Array<Insertable<Db["booking_travelers"]> & { id: string; amadeus_traveler_id: string }> = [];
    const fareOptions = new Map(
      input.order.offers.flatMap((offer) =>
        offer.travelerPricings.map((pricing) => [pricing.travelerId, pricing.fareOption] as const),
      ),
    );
    for (const view of input.travelers) {
      const { row } = view;
      const id = this.ids.newId("btr");
      const sealed = await this.documents.seal(input.schema, id, view.documents, view.discounts);
      const main = mainDocumentOf(view.documents);
      rows.push({
        id,
        booking_id: input.booking.id,
        saved_traveler_id: row.savedTravelerId,
        amadeus_traveler_id: row.amadeusTravelerId,
        traveler_type: row.travelerType,
        fare_option: fareOptions.get(row.amadeusTravelerId) ?? null,
        associated_adult_id: row.associatedAdultId,
        first_name: row.firstName ?? "",
        middle_name: row.middleName,
        last_name: row.lastName ?? "",
        second_last_name: row.secondLastName,
        date_of_birth: row.dateOfBirth,
        gender: row.gender,
        contact: isRecord(row.contact) ? JSON.stringify(row.contact) : null,
        documents_ciphertext: sealed.documentsCiphertext,
        discount_eligibility_ciphertext: sealed.discountEligibilityCiphertext,
        encryption_key_id: sealed.encryptionKeyId,
        document_type: main?.documentType ?? null,
        document_last4: main === undefined ? null : main.number.slice(-4),
        document_expiry_date: dateOrNull(main?.expiryDate),
        document_issuance_country: countryOrNull(main?.issuanceCountry),
        document_nationality: countryOrNull(main?.nationality),
        loyalty_programs: JSON.stringify(Array.isArray(row.loyaltyPrograms) ? row.loyaltyPrograms : []),
        emergency_contact: isRecord(row.emergencyContact) ? JSON.stringify(row.emergencyContact) : null,
        created_at: input.now,
        updated_at: input.now,
      });
    }
    return rows;
  }

  /**
   * The outbox `booking.confirmed` e-mail to the primary contact (or the booking's contact e-mail). A call the outbox
   * refuses (InvalidNotificationError, raised before any SQL) is logged and skipped: the order exists at Amadeus and
   * must be recorded even when its e-mail cannot be sent.
   */
  private async confirmationEmail(
    trx: TenantTransaction,
    input: RecordOrderInput,
    segments: ReadonlyArray<Insertable<Db["booking_segments"]>>,
    travelers: ReadonlyArray<Insertable<Db["booking_travelers"]>>,
  ): Promise<void> {
    try {
      await this.enqueueConfirmation(trx, input, segments, travelers);
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.error({ bookingId: input.booking.id, err: error }, "bookings.confirmation_email_invalid");
    }
  }

  private async enqueueConfirmation(
    trx: TenantTransaction,
    input: RecordOrderInput,
    segments: ReadonlyArray<Insertable<Db["booking_segments"]>>,
    travelers: ReadonlyArray<Insertable<Db["booking_travelers"]>>,
  ): Promise<void> {
    const { booking } = input;
    const primary = input.contacts.find((contact) => contact.isPrimary) ?? input.contacts[0];
    await this.outbox.enqueue(trx, {
      templateKey: "booking.confirmed",
      to: primary?.email ?? booking.contactEmail,
      locale: input.locale,
      customerId: booking.customerId,
      bookingId: booking.id,
      dedupeKey: `booking.confirmed:${booking.id}`,
      data: {
        booking: {
          reference: booking.reference,
          recordLocator: input.order.records[0]?.reference ?? "",
          url: `${storefrontUrl(input.tenantKey, this.baseDomain)}/booking.html?id=${booking.id}`,
          total: { amount: booking.totalAmount, currency: booking.currency },
          contact: { firstName: primary?.firstName ?? "", lastName: primary?.lastName ?? "" },
          travellers: travelers.map((traveler) => ({
            firstName: traveler.first_name,
            lastName: traveler.last_name,
          })),
          segments: segments.map((segment) => ({
            origin: segment.departure_iata,
            destination: segment.arrival_iata,
            departureAt: segment.departure_local,
            arrivalAt: segment.arrival_local,
            carrierCode: segment.carrier_code,
            flightNumber: segment.flight_number,
          })),
        },
      },
    });
  }
}

// ---- The answer ----------------------------------------------------------------------------------------------------

/** A booking traveller with its decrypted lists. */
export interface BookingTravelerView {
  readonly row: BookingTravelerRow;
  readonly documents: readonly StoredDocument[];
  readonly discounts: readonly AmadeusDiscount[];
}

/** What `toBooking` reads. */
export interface BookingViewInput {
  readonly booking: BookingRow;
  readonly children: BookingChildren;
  readonly travelers: readonly BookingTravelerView[];
  readonly payments: readonly Payment[];
  readonly policy: TicketingPolicy;
  readonly minorUnits: number;
  readonly now: Date;
}

const money = (amount: string, currency: string, minorUnits: number): MoneyAmount => ({
  amount: new Money(amount).toFixed(minorUnits),
  currency,
});

/** The customer's line about the ticketing state (BookingTicketing.message). */
export function ticketingMessageOf(bookingStatus: string, ticketingStatus: string): string | null {
  if (bookingStatus === "pending") {
    return "We are confirming your booking with the airline.";
  }
  if (bookingStatus === "failed" || bookingStatus === "cancelled") {
    return null;
  }
  switch (ticketingStatus) {
    case "issued":
      return "Your booking is confirmed and your e-tickets are issued.";
    case "manual_review":
      return "Your booking is confirmed. Our team will issue your e-tickets shortly.";
    default:
      return "Your booking is confirmed. E-tickets are being issued.";
  }
}

function nameOf(
  row: Pick<BookingTravelerRow, "firstName" | "middleName" | "lastName" | "secondLastName">,
): AmadeusName {
  return {
    firstName: row.firstName,
    ...(row.middleName === null ? {} : { middleName: row.middleName }),
    lastName: row.lastName,
    ...(row.secondLastName === null ? {} : { secondLastName: row.secondLastName }),
  };
}

function metadataOf(value: unknown): Record<string, string> {
  return isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : {};
}

function itinerariesOf(children: BookingChildren): BookingItinerary[] {
  const byIndex = new Map<number, BookingChildren["segments"][number][]>();
  for (const segment of children.segments) {
    byIndex.set(segment.itineraryIndex, [...(byIndex.get(segment.itineraryIndex) ?? []), segment]);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([index, segments]) => {
      const first = segments[0];
      const last = segments.at(-1);
      if (first === undefined || last === undefined) {
        return [];
      }
      return [
        {
          index,
          originCode: first.departureIata,
          destinationCode: last.arrivalIata,
          departureAt: first.departureLocal,
          arrivalAt: last.arrivalLocal,
          durationMinutes: Math.max(
            0,
            Math.round((last.arrivalAt.getTime() - first.departureAt.getTime()) / 60_000),
          ),
          stops: segments.length - 1,
          segments: segments.map((segment): BookingSegment => ({
            id: segment.amadeusSegmentId,
            flightOfferId: segment.amadeusFlightOfferId,
            departure: {
              iataCode: segment.departureIata,
              terminal: segment.departureTerminal,
              at: segment.departureLocal,
            },
            arrival: {
              iataCode: segment.arrivalIata,
              terminal: segment.arrivalTerminal,
              at: segment.arrivalLocal,
            },
            carrierCode: segment.carrierCode,
            carrierName: null,
            number: segment.flightNumber,
            flightNumber: `${segment.carrierCode}${segment.flightNumber}`,
            operatingCarrierCode: segment.operatingCarrierCode,
            aircraftCode: segment.aircraftCode,
            durationMinutes: segment.durationMinutes,
            cabin: segment.cabin as NonNullable<BookingSegment["cabin"]> | null,
            bookingClass: segment.bookingClass,
            fareBasis: segment.fareBasis,
            brandedFare: segment.brandedFare,
            brandedFareLabel: null,
            includedCheckedBags: isRecord(segment.includedCheckedBags)
              ? {
                  quantity:
                    typeof segment.includedCheckedBags["quantity"] === "number"
                      ? segment.includedCheckedBags["quantity"]
                      : null,
                  weight:
                    typeof segment.includedCheckedBags["weight"] === "number"
                      ? segment.includedCheckedBags["weight"]
                      : null,
                  weightUnit:
                    typeof segment.includedCheckedBags["weightUnit"] === "string"
                      ? segment.includedCheckedBags["weightUnit"]
                      : null,
                }
              : null,
            status: segment.status as NonNullable<BookingSegment["status"]>,
            isFlown: segment.isFlown,
          })),
        },
      ];
    });
}

/** The allowed actions of a booking right after checkout.complete (OBE-046's allowed-actions.ts takes over). */
function allowedActionsOf(booking: BookingRow): Booking["allowedActions"] {
  const live =
    booking.status === "confirmed" ||
    booking.status === "ticketed" ||
    booking.status === "partially_ticketed";
  const reason =
    booking.status === "pending"
      ? "pending"
      : booking.status === "failed"
        ? "failed"
        : booking.status === "cancelled"
          ? "cancelled"
          : undefined;
  const reasons: Record<string, Booking["allowedActions"]["reasons"][string]> = {};
  if (!live && reason !== undefined) {
    for (const action of [
      "canModifyContacts",
      "canModifyTravelerDocuments",
      "canModifyLoyaltyPrograms",
      "canAddRemarks",
    ]) {
      reasons[action] = reason;
    }
  }
  reasons["canCancel"] = reason ?? "disabled_by_ota";
  reasons["canDownloadDocuments"] = reason ?? "pending";
  reasons["canAddAncillaries"] = reason ?? "disabled_by_ota";
  return {
    canCancel: false,
    canModifyContacts: live,
    canModifyTravelerDocuments: live,
    canModifyLoyaltyPrograms: live,
    canAddRemarks: live,
    canDownloadDocuments: false,
    canRefresh: live,
    canAddAncillaries: false,
    reasons,
  };
}

/** The booking in customer scope (see the file header). */
export function toBooking(input: BookingViewInput): Booking {
  const { booking, children, minorUnits } = input;
  const currency = booking.currency;
  const amount = (value: string) => money(value, currency, minorUnits);
  const ticketsByTraveler = new Map<string, string[]>();
  for (const ticket of children.tickets) {
    if (ticket.amadeusTravelerId !== null) {
      ticketsByTraveler.set(ticket.amadeusTravelerId, [
        ...(ticketsByTraveler.get(ticket.amadeusTravelerId) ?? []),
        ticket.documentNumber,
      ]);
    }
  }
  const namesByTraveler = new Map(
    children.travelers.map((row) => [row.amadeusTravelerId, `${row.firstName} ${row.lastName}`]),
  );
  const travelers: Traveler[] = input.travelers.map(({ row, documents, discounts }) => ({
    id: row.id,
    travelerId: row.amadeusTravelerId,
    travelerType: row.travelerType as Traveler["travelerType"],
    associatedAdultId: row.associatedAdultId,
    savedTravelerId: row.savedTravelerId,
    name: nameOf(row),
    dateOfBirth: row.dateOfBirth,
    gender: row.gender as NonNullable<Traveler["gender"]> | null,
    contact: isRecord(row.contact) ? (row.contact as NonNullable<Traveler["contact"]>) : null,
    documents: documents.map(readableDocument),
    loyaltyPrograms: records(row.loyaltyPrograms) as NonNullable<Traveler["loyaltyPrograms"]>,
    discountEligibility: discounts.map(readableDiscount),
    emergencyContact: isRecord(row.emergencyContact)
      ? (row.emergencyContact as NonNullable<Traveler["emergencyContact"]>)
      : null,
    complete: true,
    ticketNumbers: ticketsByTraveler.get(row.amadeusTravelerId) ?? [],
  }));
  const contacts: Contact[] = children.contacts.map((row) => ({
    id: row.id,
    purpose: row.purpose as Contact["purpose"],
    isPrimary: row.isPrimary,
    addresseeName:
      row.firstName === null && row.lastName === null
        ? null
        : {
            ...(row.firstName === null ? {} : { firstName: row.firstName }),
            ...(row.lastName === null ? {} : { lastName: row.lastName }),
          },
    companyName: row.companyName,
    emailAddress: row.email,
    phones: records(row.phones) as NonNullable<Contact["phones"]>,
    address: isRecord(row.address) ? (row.address as NonNullable<Contact["address"]>) : null,
    language: row.language,
  }));
  const tickets: Ticket[] = children.tickets.map((row) => ({
    id: row.id,
    documentType: row.documentType as Ticket["documentType"],
    documentNumber: row.documentNumber,
    status: row.status as Ticket["status"],
    travelerId: row.amadeusTravelerId,
    travelerName:
      row.amadeusTravelerId === null ? null : (namesByTraveler.get(row.amadeusTravelerId) ?? null),
    segmentIds: [...row.segmentIds],
    issuedAt: row.issuedAt?.toISOString() ?? null,
    total: null,
  }));
  const remarks: Remark[] = children.remarks
    .filter((row) => row.visibleToCustomer)
    .map((row) => ({
      id: row.id,
      kind: row.kind === "airline" ? "airline" : "general",
      subType: row.subType as Remark["subType"],
      text: row.text,
      travelerIds: [...row.travelerIds],
      source: row.createdByStaffId === null ? "customer" : "staff",
      createdAt: row.createdAt.toISOString(),
    }));
  const base = new Money(booking.netBaseAmount ?? "0").plus(booking.markupAmount);
  const fees = new Money(booking.netFeesAmount ?? "0").plus(booking.feesAmount);
  const cardFee = new Money(booking.cardFeeAmount);
  const lastSync = booking.lastSyncedAt;
  return {
    id: booking.id,
    reference: booking.reference,
    status: booking.status as Booking["status"],
    channel: booking.channel as Booking["channel"],
    customerId: booking.customerId,
    isGuest: booking.customerId === null,
    recordLocator: booking.recordLocator,
    recordLocators: children.associatedRecords.map((record) => ({
      reference: record.reference,
      originSystemCode: record.originSystemCode,
      flightOfferId: record.flightOfferId,
      creationDate: record.creationDate,
      primary: record.isPrimary,
    })),
    tripType: (booking.tripType ?? "one_way") as Booking["tripType"],
    itineraries: itinerariesOf(children),
    travelers,
    contacts,
    ancillaries: [],
    tickets,
    payments: [...input.payments],
    refunds: [],
    remarks,
    totals: {
      currency,
      base: amount(base.toString()),
      taxes: amount(booking.taxesAmount),
      fees: amount(fees.toString()),
      ancillaries: amount(booking.ancillariesAmount),
      cardFee: cardFee.isZero() ? null : amount(booking.cardFeeAmount),
      total: amount(booking.totalAmount),
      paid: amount(booking.amountPaid),
      refunded: amount(booking.amountRefunded),
    },
    ticketing: {
      status: booking.ticketingStatus as Booking["ticketing"]["status"],
      policy: input.policy,
      deadlineAt: booking.ticketingDeadlineAt?.toISOString() ?? null,
      lastTicketingDate: booking.lastTicketingDate,
      issuedAt: booking.issuedAt?.toISOString() ?? null,
      message: ticketingMessageOf(booking.status, booking.ticketingStatus),
    },
    allowedActions: allowedActionsOf(booking),
    cancellation: null,
    lastSyncedAt: lastSync?.toISOString() ?? null,
    syncStatus:
      lastSync !== null && input.now.getTime() - lastSync.getTime() < FRESH_SYNC_MS ? "fresh" : "stale",
    metadata: metadataOf(booking.metadata),
    version: booking.version,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
  };
}
