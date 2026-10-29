// The console booking actions (OBE-062; ota/docs/flows/console-operations.md §2 "Amadeus order view", "Patch",
// "Resync, notes", OADR-0018 point 8 and its follow-up, the document's consoleRetrieveFlightOrder, consolePatchBooking,
// consoleResyncBooking and consoleAddBookingNote): what OTA staff (or a `console:automation` key with the operation's
// permission) do to one booking of the request's environment besides issuing and cancelling it (OBE-063). The
// permission guard checked `bookings:read` or `bookings:write` and the environment before this runs (OBE-060); a
// booking of the other environment, or an unknown id, answers `404 NOT_FOUND`. No transaction is open during an
// Amadeus call (OADR-0003 point 1); the only row a use case locks is the booking (the lock order of OADR-0003 point 11
// starts with the checkout, which none of these touches).
//
// - `retrieve` (`bookings:read`): one Flight Order Management GET of the booking's order (`include`, `fareRules`
//   passed through) answered verbatim with the call's facts (ConsoleFlightOrderRetrieval): net prices and the full
//   documents, which no other answer shows, never logged. Forms of payment pass the shared redactor all the same (no
//   card number reaches the console, OADR-0018 point 8), and the dictionaries keep `carriers` and `aircraft` as in
//   every booking answer (the document's location and currency entries cannot hold Amadeus's maps). With
//   `updateSnapshot` (default) the answer also becomes the booking's `order_snapshot` (redacted),
//   `order_dictionaries`, `order_included` (bags, fare rules), `last_synced_at` and clears `sync_error`, without the
//   child tables (that is resync) and without a new `version`; a booking another writer changed while the order was
//   read keeps its snapshot (`snapshotUpdated: false`). It is an audited read
//   (OADR-0011 point 8 as decided on 2026-10-21: a supplier record): the use case writes its `order.retrieve` row (the
//   document's action name) itself, with the booking; its handler also opts in with `@AuditedRead`, and the
//   interceptor writes no second row for a call whose use case wrote one. A
//   booking without an Amadeus order answers `409 BOOKING_NOT_MODIFIABLE`; an order Amadeus no longer has
//   `404 NOT_FOUND` with `error.supplier`.
//
// - `patch` (`bookings:write`, `If-Match`): the travellers, contacts, remarks and ticketing agreement of the order
//   (plan step 2), and the elements the document sends as given (forms of payment, automated processes, offices,
//   commissions, forms of identification), through one Flight Order Management PATCH; `tags` and `metadata` are local
//   only (no Amadeus call, any status, `booking.tags_updated`). Before anything is read or sent:
//     · a `creditCard` form of payment (or a B2B wallet's virtual card) answers `403 FEATURE_DISABLED`
//       (`details.feature = "consoleCardPayment"`): card data reaches the OTA only through the storefront's
//       airline-card route (ADR-0011, OADR-0018 point 8 and its follow-up);
//     · `flightOffers` (chargeable services, which re-price the booking), `tickets` and `associatedRecords` answer
//       `403 FEATURE_DISABLED` (`details.feature = "consolePatchElements"`, `details.elements`): the MVP's patch
//       does not re-price or rewrite tickets and records;
//     · `ticketingAgreement.dateTime` and `segmentIds` are Amadeus outputs: `400 VALIDATION_FAILED` (`read_only`).
//   Then (T1, the booking locked) the `If-Match` (`412 PRECONDITION_FAILED` when stale), a cancelled booking
//   (`409 BOOKING_ALREADY_CANCELLED`) and one without an order (`409 BOOKING_NOT_MODIFIABLE`). Amadeus PATCH replaces
//   each element it is sent, so the request is merged with the stored order first: each traveller sent over the
//   stored one, every traveller of the booking going (`mergeTravelers`, default: its fields replace the stored ones,
//   its name's parts too, a document replaces the stored one of its type and keeps its number when sent without one;
//   `false`: the travellers as sent), the contacts by purpose (`mergeContacts`), and the remarks added to the stored
//   ones, exact duplicates skipped (`mergeRemarks`; `false` replaces the lists sent; the `VELEXIS <reference>`
//   BACKOFFICE remark is always kept). The data names the order's flight offers by id only, as the specification
//   requires `flightOffers` and an id alone adds no service. The call: Amadeus 2552 answers
//   `409 VERSION_CONFLICT` and other refusals `422 SUPPLIER_REJECTED` or `TRAVELER_DATA_INVALID`, nothing changed; a
//   timeout (`504 SUPPLIER_TIMEOUT`, the outcome unknown) is followed by a resync of the booking (below, without the
//   throttle), then answered 504. The record (T2): the answer becomes the snapshot, the contacts, remarks and
//   order columns follow it (below), the travellers sent are stored as sent (documents sealed again; Amadeus answers
//   may mask them), `tags`/`metadata`, `last_synced_at`, `version + 1`, the event `booking.patched` (visible to the
//   customer when contacts or documents changed) and the `booking.patch` staff action with the redacted before and
//   after. With `notifyCustomer` the same transaction queues the `booking.updated` e-mail of the booking as it is now
//   to its contact e-mail (the itinerary attached when one is ready) and, when the change moved that address, the short
//   notice of the same key to the previous one, which names the booking reference only (BookingUpdatedEmails of
//   bookings/booking-updated-emails.ts, dedupe keys `booking.patched:<bkg_…>:v<version>:new|old`; OADR-0013 point 4
//   as revised on 2026-10-23, lead decision (3) of 2026-10-23, FIX-W28-NOTIFY). A patch that timed out e-mails
//   nothing. A patch of `tags`/`metadata` alone changes nothing the traveller sees: its `notifyCustomer` sends no
//   e-mail and the answer carries the warning NOTIFICATION_NOT_SENT_WARNING instead. An e-mail the outbox refuses (an
//   address or data it cannot send: logged, the change recorded all the same) adds the warning
//   NOTIFICATION_REFUSED_WARNING, or CONTACT_NOTICE_REFUSED_WARNING for the notice to the previous address, to the
//   answer, so the staff member knows the traveller was not told (lead decision (6) of 2026-10-24, FIX-W29-OTA).
//
// - `resync` (`bookings:write`): a refresh through the background sync's service (BookingSyncService.refresh, OBE-045,
//   as OBE-062's question asked; lead decision (3) of 2026-10-23, FIX-W27-SYNC: the claim in
//   `bookings.sync_claimed_at`, one Flight Order Management GET, and the record through the sync's diff of
//   order-diff.ts with its events: tickets, segments and their schedule changes (`booking.schedule_changed`, a new
//   itinerary), a cancellation by the airline, a status that is now ticketed, the associated records, the forms of
//   identification, the snapshot; the console's throttle of 10 s answers `429 RATE_LIMITED`), then the projection of
//   the stored order on the booking (T3, below), the event `booking.synced` and the `booking.resync` staff action. It
//   answers the booking, the differences between the console views before and after (ConsoleSyncChange, JSON pointers
//   into the booking: a schedule change shows as its segments' new times), whether the status changed and the
//   previous status. A booking without an order, or a cancelled one, answers `409 BOOKING_NOT_MODIFIABLE`; an order
//   Amadeus no longer has `422 SUPPLIER_REJECTED` (`supplierSync.status = order_not_found`).
//
// - `addNote` (`bookings:write`, `Idempotency-Key`): a `staff.note` booking event, staff-only unless the staff member
//   asks for `visibleToCustomer` (the document's option; the default keeps it out of bookings.listEvents), and the
//   `booking.note` staff action (the note's id, never its text). The booking's `version` does not change.
//
// The projection of an order on the booking (patch, resync): the contacts are replaced by the order's when they differ
// (the primary one keeps its purpose; its e-mail becomes `contact_email`); the remarks the order has and the booking
// has not are added (by a staff member's patch: `created_by_staff_id`), those it no longer has are removed, matched by
// kind, type and text (the `VELEXIS <reference>` remark is never removed); the ticketing agreement (and with it the
// ticketing deadline, OADR-0008 point 3), automated processes, forms of payment (redacted), commissions, forms of
// identification and offices follow the order's. A projection that changed something bumps `version`.
//
// Every copy of an order these actions keep (the snapshot, the PATCH request in `supplier_requests`, the staff
// action's before and after, `form_of_identifications`) passes the shared redactor and has the numbers of its forms of
// identification (passport, identity card, driving licence numbers) cut to their last 4, as console.bookings.get shows
// them (`keptOrderDataOf`, `maskedIdentifications`; the shared redactor cuts them the same way since FIX-W26-SECURITY,
// and cutting a cut number again changes nothing). Only Amadeus and the retrieve's answer see them in full.
//
// Since OBE-063 (flow console-operations.md §1 and §2 "Issue", "Cancel", OADR-0008 point 1, OADR-0018 point 8, the
// document's consoleIssueBooking and consoleCancelBooking):
//
// - `issue` (`bookings:issue`, `If-Match`, `Idempotency-Key`). Before anything is read: a `creditCard` form of payment
//   (or a B2B wallet's virtual card) answers `403 FEATURE_DISABLED` (`consoleCardPayment`), and `allowUnpaid` from
//   anyone but an owner or an admin (a console key included) `403 FORBIDDEN` (`details.option = "allowUnpaid"`). Then
//   the ticketing claim of the ticketing job (T1, ticketing.service.ts): the booking `FOR NO KEY UPDATE SKIP LOCKED`
//   (held: `503 SERVICE_UNAVAILABLE` with `Retry-After`), the `If-Match`, the status (`ticketed` or issued: `409
//   ALREADY_ISSUED`; `cancelled`: `409 BOOKING_ALREADY_CANCELLED`; no order: `409 BOOKING_NOT_MODIFIABLE`), no
//   cancellation holding it (an undecided one, and since FIX-W31-OTA, lead decision (1) of 2026-10-27, one whose claim
//   committed less than 5 minutes ago and whose DELETE has no recorded outcome yet: cancellation-state.ts
//   `cancellationHoldOf`) and no fresh claim of the job or of another request (`409 BOOKING_NOT_MODIFIABLE`,
//   `details.reason` `cancellation_pending` or `ticketing_in_progress`), an airline-card booking only with `other`
//   forms of payment `CASH` or `ACCOUNT` (the OTA's own settlement with the airline; `400 VALIDATION_FAILED` at
//   `/formOfPayments` otherwise), and the payment (`issuePaymentOf`): a captured one is paid, an authorised Stripe
//   payment is captured first (`capturePayment`, default true), a console or imported booking without payment needs
//   none, anything else answers `402 PAYMENT_REQUIRED` unless `allowUnpaid`. The claim writes `ticketing_status =
//   in_progress` with `ticketing_last_attempt_at = now`, its fencing token, so the ticketing job skips the booking. The
//   capture (no transaction open): console.payments.capture's (ConsolePaymentsService.captureForIssue, its
//   `payment.capture` staff action), whose failure releases the claim and answers `402 PAYMENT_DECLINED` (a Stripe that
//   does not answer: `502 PAYMENT_PROVIDER_ERROR`, which the same key can retry): nothing is issued. Then the resync,
//   always first, as the job's every attempt (OADR-0008 point 4, OADR-0003 point 7: an issuance that timed out, the
//   job's or an earlier staff request's, may have issued): Flight Order Management GET, whose tickets for every
//   traveller (or, for a booking without any yet, for some) are recorded as found, without a second issuance
//   (`resyncBeforeIssue`); a GET that fails releases the claim and answers its error (a timeout as `503
//   SUPPLIER_UNAVAILABLE`, no issuance being in doubt; an order Amadeus no longer has as `422 SUPPLIER_REJECTED`), so
//   the order is never issued without it. Then Flight Order Issue with the request's forms of payment, or the
//   OTA-merchant `other` of the booking's offers (the job's). An answer without a reliable outcome (a timeout, an
//   Amadeus `5xx`, an unreadable `2xx`) is followed by Flight Order Management GET (the resync of OADR-0003 point 7,
//   never a second issuance): tickets found are recorded, else the claim is released and the answer is the call's (`504
//   SUPPLIER_TIMEOUT`: resync before retrying). A refusal (`502 TICKETING_FAILED`, `422 SUPPLIER_REJECTED`, `409
//   VERSION_CONFLICT`) releases the claim: the ticketing status it found (an abandoned `in_progress` as `failed`), its
//   next attempt, the error code and a staff-only `booking.ticketing_failed` event. With tickets (T2, fenced by the
//   claim): the job's result step (`recordIssuedTickets`: tickets, status, snapshot, `booking.ticketed` with the
//   receipts and, unless `notifyCustomer: false`, the e-mail) and the `booking.issue` staff action with the redacted
//   before and after. The idempotency interceptor serialises a double submit of one key: the second request replays the
//   first answer, so the payment is captured and the order issued once.
// - `cancel` (`bookings:cancel`, `If-Match`, `Idempotency-Key`): CancellationService.cancelByStaff (see its file
//   header: the refresh, the claim, the DELETE, the record and money steps of OBE-049 with `refund.mode`, the flag
//   and the worker's check of a DELETE without an answer), whose record step's transaction writes the `booking.cancel`
//   staff action; the answer is the booking, with ORDER_GONE_WARNING when Amadeus no longer had the order. The
//   same-key replays of its `504` are answered from the booking (ConsoleCancelBookingIdempotencyHooks).
import { Injectable } from "@nestjs/common";
import type { components, operations } from "@velexis/api-types";
import type { Insertable, TenantDatabase, Updateable } from "@velexis/db";
import { AppError, isAppError, type FieldError, type OtaErrorCode } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  AmadeusClient,
  requestPath,
  type IssueFlightOrderRequest,
  type PatchFlightOrderRequest,
} from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { AmadeusCallError } from "../amadeus/error-mapper";
import { AMADEUS_OPERATIONS } from "../amadeus/limits";
import {
  createFailureKind,
  pendingBookingOf,
  replayedTimeout,
} from "../bookings/booking-orchestrator.service";
import { VELEXIS_REMARK_PREFIX, velexisRemarkText } from "../bookings/booking-reference";
import {
  bookingEtagOf,
  consoleDictionariesOf,
  offerFareRulesOf,
  type FareRuleType,
  type StoredFareRules,
} from "../bookings/bookings.mapper";
import {
  BookingsRepository,
  type BookingChildren,
  type BookingContactRow,
  type BookingRemarkRow,
  type BookingRow,
  type BookingTravelerRow,
} from "../bookings/bookings.repository";
import { BookingSyncService } from "../bookings/booking-sync.service";
import { BookingUpdatedEmails, type BookingUpdatedEmail } from "../bookings/booking-updated-emails";
import {
  bookingBusy,
  CancellationService,
  ORDER_GONE_WARNING,
  type StaffCancelRecord,
} from "../bookings/cancellation.service";
import { CustomerBookingsService } from "../bookings/customer-bookings.service";
import {
  BookingTravelerDocuments,
  deadlineLocalOf,
  eventActorOf,
  OrderRecorder,
  readCreatedOrder,
  ticketCoverage,
  type CreatedOrder,
  type TicketCoverage,
} from "../bookings/order-recorder";
import {
  amadeusOrderContactOf,
  amadeusTravelerOf,
  buildIssueRequest,
  VELEXIS_REMARK_SUBTYPE,
} from "../bookings/order-request.builder";
import {
  recordIssuedTickets,
  TicketingRepository,
  ticketingClaimFresh,
  type TicketingBookingRow,
} from "../bookings/ticketing.service";
import { cancellationHoldOf } from "../bookings/cancellation-state";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotencyRecord,
  type IdempotencyResource,
  type IdempotencyResponse,
} from "../common/http/idempotency.service";
import { PaymentsRepository, type PaymentRow } from "../payments/payments.repository";
import type { StaffRole } from "../tenancy/platform-read.repository";
import type { AmadeusDiscount, StoredDocument } from "../checkout/traveler-documents";
import { ifMatchSatisfied } from "../checkout/checkout.mapper";
import { StaffContext } from "../common/auth/staff.guard";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  CONSOLE_BOOKING_CACHE_CONTROL,
  CONSOLE_REFRESH_THROTTLE_MS,
  maskedIdentifications,
  type ConsoleBooking,
} from "./console-bookings.mapper";
import {
  ConsoleBookingsRepository,
  STAFF_NOTE_EVENT,
  type ConsoleBookingDetailsRow,
} from "./console-bookings.repository";
import { ConsoleBookingsService } from "./console-bookings.service";
import { ConsolePaymentsService } from "./console-payments.service";
import { StaffActionsWriter } from "./staff-actions.writer";

type Schemas = components["schemas"];
export type ConsoleRetrieveQuery = NonNullable<
  operations["consoleRetrieveFlightOrder"]["parameters"]["query"]
>;
export type ConsolePatchRequest = Schemas["ConsoleBookingPatchRequest"];
export type ConsoleResyncRequest = Schemas["ConsoleBookingResyncRequest"];
export type ConsoleNoteRequest = Schemas["ConsoleBookingNoteRequest"];
export type ConsoleFlightOrderRetrieval = Schemas["ConsoleFlightOrderRetrieval"];
export type ConsoleBookingResyncResult = Schemas["ConsoleBookingResyncResult"];
export type ConsoleBookingNote = Schemas["ConsoleBookingNote"];
export type ConsoleSyncChange = Schemas["ConsoleSyncChange"];
export type ConsoleIssueRequest = Schemas["ConsoleBookingIssueRequest"];
export type ConsoleCancelRequest = Schemas["ConsoleBookingCancelRequest"];
type ConsoleActor = Schemas["ConsoleActor"];
type Warning = Schemas["Warning"];

type Db = TenantDatabase;
type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

// ---- Names ----------------------------------------------------------------------------------------------------------

/** The `staff_actions.action` of each action (the document's names). */
export const CONSOLE_BOOKING_ACTIONS = Object.freeze({
  retrieve: "order.retrieve",
  patch: "booking.patch",
  tagsUpdated: "booking.tags_updated",
  resync: "booking.resync",
  note: "booking.note",
  issue: "booking.issue",
  cancel: "booking.cancel",
});

/** The booking events the actions write (staff notes are `staff.note`, STAFF_NOTE_EVENT). */
export const BOOKING_PATCHED_EVENT = "booking.patched";
export const BOOKING_SYNCED_EVENT = "booking.synced";

/** `supplier_requests.operation` of the actions' Amadeus calls. */
const OPERATIONS = Object.freeze({
  retrieve: "console.bookings.retrieve",
  patch: "console.bookings.patch",
  resync: "console.bookings.resync",
  issue: "console.bookings.issue",
});

/** `details.feature` of the refusals of console.bookings.patch (`403 FEATURE_DISABLED`). */
export const CONSOLE_CARD_PAYMENT_FEATURE = "consoleCardPayment";
export const CONSOLE_PATCH_ELEMENTS_FEATURE = "consolePatchElements";

/** The order elements a patch sends to Amadeus. */
export const AMADEUS_PATCH_ELEMENTS = [
  "travelers",
  "contacts",
  "remarks",
  "formOfPayments",
  "ticketingAgreement",
  "automatedProcess",
  "queuingOfficeId",
  "ownerOfficeId",
  "commissions",
  "formOfIdentifications",
] as const;
type AmadeusPatchElement = (typeof AMADEUS_PATCH_ELEMENTS)[number];

/** The elements of the document the MVP's patch refuses (`403 FEATURE_DISABLED`, see the file header). */
export const UNSUPPORTED_PATCH_ELEMENTS = ["flightOffers", "tickets", "associatedRecords"] as const;

/** The local-only elements (no Amadeus call). */
export const LOCAL_PATCH_ELEMENTS = ["tags", "metadata"] as const;
type LocalPatchElement = (typeof LOCAL_PATCH_ELEMENTS)[number];

/** The prefix of the dedupe keys of a patch's `booking.updated` e-mails: `booking.patched:<bkg_…>:v<version>:new|old`. */
export const PATCH_EMAIL_DEDUPE = "booking.patched";

/** The warning of a `tags`/`metadata` patch with `notifyCustomer`: nothing the traveller sees changed, nothing sent. */
export const NOTIFICATION_NOT_SENT_WARNING: Warning = Object.freeze({
  title: "CUSTOMER NOT NOTIFIED",
  detail: "Tags and metadata are internal: no e-mail was sent to the traveller about this change.",
});

/**
 * The warning of a patch whose `booking.updated` e-mail to the contact e-mail the outbox refused (lead decision (6) of
 * 2026-10-24): the change is recorded, the traveller was not told.
 */
export const NOTIFICATION_REFUSED_WARNING: Warning = Object.freeze({
  title: "CUSTOMER NOT NOTIFIED",
  detail:
    "The e-mail about this change could not be queued for the booking's contact address: tell the traveller yourself.",
});

/** The warning of a patch whose notice to the previous contact address the outbox refused (lead decision (6)). */
export const CONTACT_NOTICE_REFUSED_WARNING: Warning = Object.freeze({
  title: "PREVIOUS CONTACT NOT NOTIFIED",
  detail: "The notice of the contact change could not be queued for the previous contact address.",
});

/**
 * The client's errors each use case passes on: the codes its operation documents (`x-error-codes`), plus
 * `503 SERVICE_UNAVAILABLE` (the client's rate limiter without Redis, the `503` every operation documents); any other
 * becomes `502 SUPPLIER_ERROR`. console.bookings.retrieve documents no `OFFICE_NOT_ALLOWED` (as the refresh of
 * console.bookings.get and resync, which map it the same way); console.bookings.patch does, for the offices it sends.
 */
const SUPPLIER_CODES: readonly OtaErrorCode[] = [
  "SUPPLIER_REJECTED",
  "SUPPLIER_NOT_CONFIGURED",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "SUPPLIER_ERROR",
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_TIMEOUT",
];
const RETRIEVE_SUPPLIER_CODES: ReadonlySet<string> = new Set<OtaErrorCode>(SUPPLIER_CODES);
const PATCH_SUPPLIER_CODES: ReadonlySet<string> = new Set<OtaErrorCode>([
  ...SUPPLIER_CODES,
  "OFFICE_NOT_ALLOWED",
  "VERSION_CONFLICT",
  "TRAVELER_DATA_INVALID",
  "CONTACT_DATA_INVALID",
]);

/** The remark types `booking_remarks_sub_type_ck` accepts, by kind. */
const REMARK_TYPES: Readonly<Record<RemarkKind, ReadonlySet<string>>> = Object.freeze({
  general: new Set([
    "GENERAL_MISCELLANEOUS",
    "CONFIDENTIAL",
    "INVOICE",
    "QUALITY_CONTROL",
    "BACKOFFICE",
    "FULFILLMENT",
    "ITINERARY",
    "TICKETING_MISCELLANEOUS",
    "TOUR_CODE",
  ]),
  airline: new Set([
    "OTHER_SERVICE_INFORMATION",
    "KEYWORD",
    "OTHER_SERVICE",
    "CLIENT_ID",
    "ADVANCED_TICKET_TIME_LIMIT",
  ]),
});

const CONTACT_PURPOSES: ReadonlySet<string> = new Set([
  "STANDARD",
  "INVOICE",
  "STANDARD_WITHOUT_TRANSMISSION",
]);
const GENDERS: ReadonlySet<string> = new Set(["MALE", "FEMALE", "UNSPECIFIED", "UNDISCLOSED"]);
const DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "VISA",
  "PASSPORT",
  "IDENTITY_CARD",
  "KNOWN_TRAVELER",
  "REDRESS",
]);
/** The optional text fields of a sealed document (StoredDocument), in its order. */
const DOCUMENT_FIELDS = [
  "issuanceDate",
  "expiryDate",
  "issuanceCountry",
  "issuanceLocation",
  "nationality",
  "birthPlace",
  "validityCountry",
  "birthCountry",
] as const;

// ---- Pure rules -----------------------------------------------------------------------------------------------------

/** True when a list of forms of payment carries card data: a `creditCard`, or a B2B wallet's virtual card. */
export function carriesCardData(formOfPayments: unknown): boolean {
  return records(formOfPayments).some(
    (entry) =>
      entry["creditCard"] !== undefined ||
      (isRecord(entry["b2bWallet"]) && entry["b2bWallet"]["virtualCreditCardDetails"] !== undefined),
  );
}

/** The elements of a patch request, by kind (see the file header). */
export function patchElementsOf(body: ConsolePatchRequest): {
  readonly amadeus: AmadeusPatchElement[];
  readonly local: LocalPatchElement[];
  readonly unsupported: string[];
} {
  const sent = (name: string): boolean => (body as JsonObject)[name] !== undefined;
  return {
    amadeus: AMADEUS_PATCH_ELEMENTS.filter(sent),
    local: LOCAL_PATCH_ELEMENTS.filter(sent),
    unsupported: UNSUPPORTED_PATCH_ELEMENTS.filter(sent),
  };
}

/**
 * The refusals of a patch request that need no booking (see the file header): card data, the elements the MVP
 * refuses, the ticketing agreement's read-only fields, and a body without any element. Throws the first.
 */
export function refusePatchRequest(body: ConsolePatchRequest): void {
  if (carriesCardData(body.formOfPayments)) {
    throw new AppError("FEATURE_DISABLED", {
      message: "Card payments cannot be entered in the console.",
      details: { feature: CONSOLE_CARD_PAYMENT_FEATURE },
    });
  }
  const elements = patchElementsOf(body);
  if (elements.unsupported.length > 0) {
    throw new AppError("FEATURE_DISABLED", {
      message: "These order elements cannot be changed from the console yet.",
      details: { feature: CONSOLE_PATCH_ELEMENTS_FEATURE, elements: elements.unsupported },
    });
  }
  const agreement = isRecord(body.ticketingAgreement) ? body.ticketingAgreement : {};
  const readOnly: FieldError[] = (["dateTime", "segmentIds"] as const)
    .filter((field) => agreement[field] !== undefined)
    .map((field) => ({
      path: `/ticketingAgreement/${field}`,
      code: "read_only",
      message: "Amadeus sets this field; send option and delay only.",
    }));
  if (readOnly.length > 0) {
    throw new AppError("VALIDATION_FAILED", { fieldErrors: readOnly });
  }
  if (elements.amadeus.length === 0 && elements.local.length === 0) {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [
        { path: "", code: "required", message: "Send at least one order element, tags or metadata." },
      ],
    });
  }
}

// ---- console.bookings.issue's rules (OBE-063) --------------------------------------------------------------------------

/** The roles that may issue a booking that is not paid (`allowUnpaid`; the document: owner and admin only). */
export const ALLOW_UNPAID_ROLES: readonly StaffRole[] = Object.freeze(["owner", "admin"]);

/**
 * The `other` methods an airline-card booking is issued with (OADR-0018 point 8): the OTA's own settlement with the
 * airline, never a card.
 */
export const AIRLINE_CARD_SETTLEMENT_METHODS: readonly string[] = Object.freeze(["CASH", "ACCOUNT"]);

/** The booking statuses an issuance takes: an order without tickets for every traveller. */
const ISSUABLE_STATUSES: ReadonlySet<string> = new Set(["confirmed", "partially_ticketed"]);

/** The payment statuses of a payment that captured money (the booking is paid). */
const PAID_STATUSES: ReadonlySet<string> = new Set(["captured", "partially_refunded"]);

/** The `payment.capture` staff action's reason of a capture before an issuance without a reason of its own. */
export const ISSUE_CAPTURE_REASON = "Captured before issuing the tickets (console.bookings.issue).";

/**
 * The refusals of an issuance that need no booking (see the file header): card data (`403 FEATURE_DISABLED`), and
 * `allowUnpaid` from a caller whose `role` is not owner or admin (a console key has none: `403 FORBIDDEN`).
 */
export function refuseIssueRequest(body: ConsoleIssueRequest, role: StaffRole | undefined): void {
  if (carriesCardData(body.formOfPayments)) {
    throw new AppError("FEATURE_DISABLED", {
      message: "Card payments cannot be entered in the console.",
      details: { feature: CONSOLE_CARD_PAYMENT_FEATURE },
    });
  }
  if (body.allowUnpaid === true && (role === undefined || !ALLOW_UNPAID_ROLES.includes(role))) {
    throw new AppError("FORBIDDEN", {
      message: "Only an owner or an admin may issue a booking that is not paid.",
      details: { option: "allowUnpaid", allowedRoles: [...ALLOW_UNPAID_ROLES], role: role ?? null },
    });
  }
}

/**
 * An airline-card booking is issued only with `other` forms of payment `CASH` or `ACCOUNT` (OADR-0018 point 8): the
 * card cannot be charged again. `400 VALIDATION_FAILED` at `/formOfPayments` otherwise.
 */
export function refuseAirlineCardIssue(formOfPayments: unknown): void {
  const entries = Array.isArray(formOfPayments) ? formOfPayments : [];
  const message = "An airline-card booking is issued with an `other` form of payment, CASH or ACCOUNT.";
  if (entries.length === 0) {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [{ path: "/formOfPayments", code: "required", message }],
    });
  }
  const refused: FieldError[] = entries.flatMap((entry: unknown, index) => {
    const other = isRecord(entry) && isRecord(entry["other"]) ? entry["other"] : undefined;
    const settled =
      other !== undefined &&
      Object.keys(entry as JsonObject).length === 1 &&
      AIRLINE_CARD_SETTLEMENT_METHODS.includes(String(other["method"]));
    return settled ? [] : [{ path: `/formOfPayments/${index}`, code: "airline_card_settlement", message }];
  });
  if (refused.length > 0) {
    throw new AppError("VALIDATION_FAILED", { fieldErrors: refused });
  }
}

/** How an issuance is paid (`issuePaymentOf`). */
export type IssuePayment =
  /** A payment captured money (Stripe, or the airline that charged its card). */
  | { readonly kind: "paid" }
  /** An authorised Stripe payment, captured before the issuance. */
  | { readonly kind: "capture"; readonly paymentId: string }
  /** A console or imported booking without a payment: none is needed (`paymentStatus = not_applicable`). */
  | { readonly kind: "not_applicable" }
  /** Anything else: issued only with `allowUnpaid`. */
  | { readonly kind: "unpaid" };

/** How the booking's payments pay an issuance (see the file header). */
export function issuePaymentOf(input: {
  readonly channel: string;
  readonly payments: readonly Pick<PaymentRow, "id" | "provider" | "status" | "providerPaymentId">[];
  readonly capturePayment: boolean;
}): IssuePayment {
  if (input.payments.some((payment) => PAID_STATUSES.has(payment.status))) {
    return { kind: "paid" };
  }
  const authorised = input.payments.find(
    (payment) =>
      payment.provider === "stripe" && payment.status === "authorized" && payment.providerPaymentId !== null,
  );
  if (authorised !== undefined && input.capturePayment) {
    return { kind: "capture", paymentId: authorised.id };
  }
  if (input.payments.length === 0 && input.channel !== "storefront") {
    return { kind: "not_applicable" };
  }
  return { kind: "unpaid" };
}

/** The codes an issuance passes on as they are (its `x-error-codes` and the `503` of every operation). */
const ISSUE_SUPPLIER_CODES: ReadonlySet<string> = new Set<OtaErrorCode>([
  ...SUPPLIER_CODES,
  "VERSION_CONFLICT",
  "TICKETING_FAILED",
]);

/**
 * The answer of a failed Flight Order Issue: the codes the operation documents as they are, the airline's refusal of
 * the travellers' data as `422 SUPPLIER_REJECTED` (with its supplier issue), any other `502 SUPPLIER_ERROR`.
 */
export function issueAnswerOf(error: unknown): unknown {
  if (
    isAppError(error) &&
    (error.code === "TRAVELER_DATA_INVALID" || error.code === "CONTACT_DATA_INVALID")
  ) {
    return new AppError("SUPPLIER_REJECTED", {
      ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
      cause: error,
    });
  }
  return documented(error, ISSUE_SUPPLIER_CODES);
}

/**
 * The answer of a failed resync before an issuance (`resyncBeforeIssue`): nothing was sent for issuance, so a timeout
 * is `503 SUPPLIER_UNAVAILABLE` (a `504` would tell the staff that tickets may have been issued), an order Amadeus no
 * longer has `422 SUPPLIER_REJECTED` (resync the booking), the other documented codes as they are, anything else
 * `502 SUPPLIER_ERROR`.
 */
export function issueResyncAnswerOf(error: unknown): unknown {
  if (isOrderNotFound(error)) {
    return new AppError("SUPPLIER_REJECTED", {
      message: "Amadeus no longer has this order: resync the booking.",
      ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
      cause: error,
    });
  }
  if (isAppError(error) && error.code === "SUPPLIER_TIMEOUT") {
    return new AppError("SUPPLIER_UNAVAILABLE", { cause: error });
  }
  return documented(error, ISSUE_SUPPLIER_CODES);
}

/**
 * Whether the order the resync before an issuance read holds tickets an earlier call issued, which are recorded
 * instead of issued again (OADR-0008 point 4): tickets for every traveller, or, for a booking without any ticket yet
 * (`confirmed`), for some (the ticketing job records those as well). A `partially_ticketed` booking's own tickets are
 * no reason to skip the issuance of the others.
 */
export function issuedBeforeIssue(bookingStatus: string, coverage: TicketCoverage): boolean {
  return coverage === "full" || (coverage === "partial" && bookingStatus === "confirmed");
}

/** The API code of a failed call: an AppError's, `INTERNAL_ERROR` for anything else (a bug). */
const codeOf = (error: unknown): string => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/** The purpose of an Amadeus contact (`STANDARD` when it has none). */
const purposeOf = (contact: JsonObject): string => text(contact["purpose"]) ?? "STANDARD";

/**
 * The contacts a patch sends: with `merge`, each contact sent replaces the stored one of its purpose and the others
 * are kept; without, the list sent.
 */
export function mergeContacts(
  stored: readonly JsonObject[],
  sent: readonly JsonObject[],
  merge: boolean,
): JsonObject[] {
  if (!merge) {
    return sent.map((contact) => ({ ...contact }));
  }
  const byPurpose = new Map(sent.map((contact) => [purposeOf(contact), contact]));
  const merged = stored.map((contact) => ({ ...(byPurpose.get(purposeOf(contact)) ?? contact) }));
  const kept = new Set(stored.map(purposeOf));
  return [
    ...merged,
    ...sent.filter((contact) => !kept.has(purposeOf(contact))).map((contact) => ({ ...contact })),
  ];
}

type RemarkKind = "general" | "airline";

/** The identity of a remark: kind, type, airline (airline remarks) and text in upper case. */
export function remarkKey(kind: RemarkKind, remark: JsonObject): string {
  const subType = text(remark["subType"]) ?? "";
  const airline = kind === "airline" ? (text(remark["airlineCode"]) ?? "") : "";
  return `${kind}|${subType}|${airline}|${(text(remark["text"]) ?? "").trim().toUpperCase()}`;
}

/** True for the `VELEXIS <reference>` back-office remark of an Amadeus `remarks.general` entry. */
const isVelexisRemark = (remark: JsonObject): boolean =>
  remark["subType"] === VELEXIS_REMARK_SUBTYPE &&
  (text(remark["text"]) ?? "").startsWith(`${VELEXIS_REMARK_PREFIX} `);

/**
 * The remarks a patch sends (Amadeus replaces the whole `remarks` element, so both lists always go): with `merge`
 * the stored remarks plus those sent that are not already there; without, each list sent replaces the stored list of
 * its kind. The `VELEXIS <reference>` remark is kept in every case.
 */
export function mergeRemarks(
  stored: unknown,
  sent: {
    readonly general?: readonly unknown[] | undefined;
    readonly airline?: readonly unknown[] | undefined;
  },
  merge: boolean,
  reference: string,
): JsonObject {
  const storedRemarks = isRecord(stored) ? stored : {};
  const lists = {} as Record<RemarkKind, JsonObject[]>;
  for (const kind of ["general", "airline"] as const) {
    const before = records(storedRemarks[kind]);
    const given = records(sent[kind]);
    if (!merge) {
      lists[kind] = sent[kind] === undefined ? before : given;
      continue;
    }
    const seen = new Set(before.map((remark) => remarkKey(kind, remark)));
    const added = given.filter((remark) => {
      const key = remarkKey(kind, remark);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    lists[kind] = [...before, ...added];
  }
  if (!lists.general.some(isVelexisRemark)) {
    const kept = records(storedRemarks["general"]).find(isVelexisRemark);
    lists.general.push(kept ?? { subType: VELEXIS_REMARK_SUBTYPE, text: velexisRemarkText(reference) });
  }
  return {
    general: lists.general.map((remark) => ({ ...remark })),
    ...(lists.airline.length > 0 ? { airline: lists.airline.map((remark) => ({ ...remark })) } : {}),
  };
}

/** A traveller merge refused: a document sent without a number that the traveller does not have. */
export interface MissingDocumentNumber {
  /** The index of the document in the traveller's `documents` as sent. */
  readonly index: number;
}

/**
 * The documents of a merged traveller: each one sent (sent without `number`: with the number and fields of the stored
 * document of its type, and issuing country when given), then, with `merge`, the stored ones of a type not sent.
 */
export function mergeDocuments(
  stored: readonly JsonObject[],
  sent: readonly JsonObject[],
  merge: boolean,
): { readonly documents: JsonObject[]; readonly missing: MissingDocumentNumber[] } {
  const missing: MissingDocumentNumber[] = [];
  const documents = sent.flatMap((document, index) => {
    if (text(document["number"]) !== undefined) {
      return [{ ...document }];
    }
    const kept = stored.find(
      (candidate) =>
        candidate["documentType"] === document["documentType"] &&
        (document["issuanceCountry"] === undefined ||
          candidate["issuanceCountry"] === document["issuanceCountry"]),
    );
    if (kept === undefined) {
      missing.push({ index });
      return [];
    }
    return [{ ...kept, ...document, number: kept["number"] }];
  });
  if (merge) {
    const types = new Set(sent.map((document) => document["documentType"]));
    documents.push(
      ...stored.filter((document) => !types.has(document["documentType"])).map((d) => ({ ...d })),
    );
  }
  return { documents, missing };
}

/**
 * A traveller of a patch: with `merge`, the fields sent over the stored traveller (the name's parts one by one, the
 * documents by `mergeDocuments`); without, the traveller as sent (a document without a number still keeps the
 * stored one's).
 */
export function mergeTraveler(
  stored: JsonObject,
  sent: JsonObject,
  merge: boolean,
): { readonly traveler: JsonObject; readonly missing: MissingDocumentNumber[] } {
  const traveler: JsonObject = merge ? { ...stored, ...sent } : { ...sent };
  if (merge && isRecord(stored["name"]) && isRecord(sent["name"])) {
    traveler["name"] = { ...stored["name"], ...sent["name"] };
  }
  let missing: MissingDocumentNumber[] = [];
  if (Array.isArray(sent["documents"])) {
    const documents = mergeDocuments(records(stored["documents"]), records(sent["documents"]), merge);
    traveler["documents"] = documents.documents;
    missing = documents.missing;
  }
  return { traveler, missing };
}

/** An Amadeus remark of an order, as `booking_remarks` stores it. */
export interface OrderRemarkEntry {
  readonly kind: RemarkKind;
  readonly key: string;
  readonly subType: string;
  readonly text: string;
  readonly category: string | null;
  readonly airlineCode: string | null;
  readonly keyword: string | null;
  readonly travelerIds: string[];
  readonly flightOfferIds: string[];
}

/** The remarks of an order's `remarks` element that `booking_remarks` can hold (known types, with a text). */
export function orderRemarksOf(remarks: unknown): OrderRemarkEntry[] {
  const element = isRecord(remarks) ? remarks : {};
  return (["general", "airline"] as const).flatMap((kind) =>
    records(element[kind]).flatMap((remark) => {
      const subType = text(remark["subType"]);
      const body = text(remark["text"]);
      if (subType === undefined || body === undefined || !REMARK_TYPES[kind].has(subType)) {
        return [];
      }
      const category = text(remark["category"]);
      return [
        {
          kind,
          key: remarkKey(kind, remark),
          subType,
          text: body,
          category: category !== undefined && /^[A-Z]$/.test(category) ? category : null,
          airlineCode: kind === "airline" ? (text(remark["airlineCode"]) ?? "YY") : null,
          keyword: text(remark["keyword"]) ?? null,
          travelerIds: strings(remark["travelerIds"]),
          flightOfferIds: strings(remark["flightOfferIds"]),
        },
      ];
    }),
  );
}

/** The identity of a stored remark (`booking_remarks` has no airline code in BookingRemarkRow: matched without). */
const rowKey = (row: BookingRemarkRow): string =>
  `${row.kind}|${row.subType}|${row.text.trim().toUpperCase()}`;
const entryKeyWithoutAirline = (entry: OrderRemarkEntry): string =>
  `${entry.kind}|${entry.subType}|${entry.text.trim().toUpperCase()}`;

/** True for the stored `VELEXIS <reference>` remark, which the projection never removes. */
const isVelexisRow = (row: BookingRemarkRow): boolean =>
  row.subType === VELEXIS_REMARK_SUBTYPE && row.text.startsWith(`${VELEXIS_REMARK_PREFIX} `);

/**
 * What the projection does to a booking's remarks for an order's remarks (see the file header): the order's remarks
 * the booking has are kept (with their visibility and author), the others added, and the booking's remarks the order
 * no longer has removed, the `VELEXIS <reference>` one excepted. Duplicates match one for one.
 */
export function planRemarks(
  rows: readonly BookingRemarkRow[],
  order: readonly OrderRemarkEntry[],
): { readonly insert: OrderRemarkEntry[]; readonly remove: BookingRemarkRow[] } {
  const remaining = [...rows];
  const insert: OrderRemarkEntry[] = [];
  for (const entry of order) {
    const index = remaining.findIndex((row) => rowKey(row) === entryKeyWithoutAirline(entry));
    if (index >= 0) {
      remaining.splice(index, 1);
    } else {
      insert.push(entry);
    }
  }
  return { insert, remove: remaining.filter((row) => !isVelexisRow(row)) };
}

/** A contact as `booking_contacts` stores it (without its ids and times). */
export interface ContactValues {
  readonly purpose: string;
  readonly isPrimary: boolean;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly phones: JsonObject[];
  readonly address: JsonObject | null;
  readonly language: string | null;
}

/**
 * The booking contacts of an order's contacts: the primary one is the first of `primaryPurpose` with an e-mail, else
 * the first with an e-mail, else the first.
 */
export function contactValuesOf(contacts: readonly JsonObject[], primaryPurpose: string): ContactValues[] {
  const values = contacts.map((contact) => {
    const name = isRecord(contact["addresseeName"]) ? contact["addresseeName"] : {};
    const purpose = purposeOf(contact);
    return {
      purpose: CONTACT_PURPOSES.has(purpose) ? purpose : "STANDARD",
      isPrimary: false,
      firstName: text(name["firstName"]) ?? null,
      lastName: text(name["lastName"]) ?? null,
      companyName: text(contact["companyName"]) ?? null,
      email: text(contact["emailAddress"]) ?? null,
      phones: records(contact["phones"]),
      address: isRecord(contact["address"]) ? contact["address"] : null,
      language: text(contact["language"]) ?? null,
    };
  });
  const primary = Math.max(
    0,
    [
      values.findIndex((value) => value.purpose === primaryPurpose && value.email !== null),
      values.findIndex((value) => value.email !== null),
    ].find((index) => index >= 0) ?? 0,
  );
  return values.map((value, index) => ({ ...value, isPrimary: index === primary }));
}

/** JSON text with sorted keys, so equal values compare equal whatever produced them. */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(sort);
    }
    if (isRecord(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort(item[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value ?? null));
}

/** The stored contacts in the shape of `contactValuesOf`, to compare. */
function storedContactValues(rows: readonly BookingContactRow[]): ContactValues[] {
  return rows.map((row) => ({
    purpose: row.purpose,
    isPrimary: row.isPrimary,
    firstName: row.firstName,
    lastName: row.lastName,
    companyName: row.companyName,
    email: row.email,
    phones: records(row.phones),
    address: isRecord(row.address) ? row.address : null,
    language: row.language,
  }));
}

/** The order's flight offers named by id only (an id adds no service; the specification requires the element). */
export function flightOfferRefsOf(
  snapshot: unknown,
  children: Pick<BookingChildren, "segments">,
): JsonObject[] {
  const fromSnapshot = isRecord(snapshot)
    ? records(snapshot["flightOffers"]).flatMap((offer) => text(offer["id"]) ?? [])
    : [];
  const ids =
    fromSnapshot.length > 0
      ? fromSnapshot
      : [...new Set(children.segments.map((segment) => segment.amadeusFlightOfferId))];
  return (ids.length > 0 ? ids : ["1"]).map((id) => ({ type: "flight-offer", id }));
}

/**
 * An order's `data` as Velexis keeps a copy of it (the snapshot, the PATCH request of the supplier log, the staff
 * action): the shared redactor, then the numbers of its forms of identification (passport, identity card or driving
 * licence numbers) cut to their last 4, as console.bookings.get shows them. The shared redactor already cuts them
 * (FIX-W26-SECURITY); the second cut keeps the same last 4.
 */
export function keptOrderDataOf(data: JsonObject): JsonObject {
  const redacted = redactPayload(data);
  return Array.isArray(redacted["formOfIdentifications"])
    ? { ...redacted, formOfIdentifications: maskedIdentifications(redacted["formOfIdentifications"]) }
    : redacted;
}

/**
 * The Amadeus answer as console.bookings.retrieve returns it: verbatim, except that its forms of payment pass the
 * shared redactor (no card number, OADR-0018 point 8) and its dictionaries go through `consoleDictionariesOf`:
 * `carriers` and `aircraft`, and since FIX-W33-OTA `locations` and `currencies` with the `key` member the document's
 * AmadeusLocationEntry and AmadeusCurrencyEntry require (Amadeus's maps by code never have it).
 */
export function consoleOrderReplyOf(body: JsonObject): JsonObject {
  const { dictionaries: raw, ...rest } = body;
  const reply: JsonObject = { ...rest };
  const data = body["data"];
  if (isRecord(data) && data["formOfPayments"] !== undefined) {
    reply["data"] = { ...data, formOfPayments: redactPayload(data["formOfPayments"]) };
  }
  const dictionaries = consoleDictionariesOf(raw);
  if (dictionaries !== null) {
    reply["dictionaries"] = dictionaries;
  }
  return reply;
}

/** The differences between two console views of a booking that a resync can make (ConsoleSyncChange). */
export function consoleSyncChanges(before: ConsoleBooking, after: ConsoleBooking): ConsoleSyncChange[] {
  const changes: ConsoleSyncChange[] = [];
  const compare = (path: string, label: string, previous: unknown, next: unknown): void => {
    if (canonicalJson(previous) !== canonicalJson(next)) {
      changes.push({ path, label, before: previous ?? null, after: next ?? null });
    }
  };
  compare("/status", "Booking status", before.status, after.status);
  compare("/ticketing/status", "Ticketing status", before.ticketing.status, after.ticketing.status);
  after.tickets.forEach((ticket, index) => {
    const previous = before.tickets.find((candidate) => candidate.documentNumber === ticket.documentNumber);
    if (previous === undefined) {
      changes.push({
        path: `/tickets/${index}`,
        label: `Ticket ${ticket.documentNumber}`,
        before: null,
        after: {
          documentType: ticket.documentType,
          documentNumber: ticket.documentNumber,
          status: ticket.status,
          travelerId: ticket.travelerId,
        },
      });
      return;
    }
    compare(
      `/tickets/${index}/status`,
      `Ticket ${ticket.documentNumber} status`,
      previous.status,
      ticket.status,
    );
  });
  const previousSegments = before.itineraries.flatMap((itinerary) => itinerary.segments);
  after.itineraries.forEach((itinerary, itineraryIndex) => {
    itinerary.segments.forEach((segment, segmentIndex) => {
      const previous = previousSegments.find(
        (candidate) => candidate.flightOfferId === segment.flightOfferId && candidate.id === segment.id,
      );
      if (previous === undefined) {
        return;
      }
      const path = `/itineraries/${itineraryIndex}/segments/${segmentIndex}`;
      compare(`${path}/status`, `${segment.flightNumber} status`, previous.status, segment.status);
      compare(`${path}/isFlown`, `${segment.flightNumber} flown`, previous.isFlown, segment.isFlown);
      compare(
        `${path}/departure/at`,
        `${segment.flightNumber} departure time`,
        previous.departure.at,
        segment.departure.at,
      );
      compare(
        `${path}/arrival/at`,
        `${segment.flightNumber} arrival time`,
        previous.arrival.at,
        segment.arrival.at,
      );
    });
  });
  const locators = (booking: ConsoleBooking) =>
    booking.recordLocators.map((record) => `${record.originSystemCode}:${record.reference}`).sort();
  compare("/recordLocators", "Record locators", locators(before), locators(after));
  const contacts = (booking: ConsoleBooking) => booking.contacts.map(({ id: _id, ...contact }) => contact);
  compare("/contacts", "Contacts", contacts(before), contacts(after));
  const remarks = (booking: ConsoleBooking) =>
    booking.remarks.map((remark) => ({
      kind: remark.kind,
      subType: remark.subType,
      text: remark.text,
      travelerIds: remark.travelerIds,
    }));
  compare("/remarks", "Remarks", remarks(before), remarks(after));
  compare("/ticketingAgreement", "Ticketing agreement", before.ticketingAgreement, after.ticketingAgreement);
  compare("/automatedProcess", "Automated processes", before.automatedProcess, after.automatedProcess);
  compare("/formOfPayments", "Forms of payment", before.formOfPayments, after.formOfPayments);
  compare("/queuingOfficeId", "Queuing office", before.queuingOfficeId, after.queuingOfficeId);
  compare("/ownerOfficeId", "Owner office", before.ownerOfficeId, after.ownerOfficeId);
  return changes;
}

/** A supplier error a use case passes on: codes the operation does not document become `502 SUPPLIER_ERROR`. */
function documented(error: unknown, codes: ReadonlySet<string>): unknown {
  if (!isAppError(error) || codes.has(error.code)) {
    return error;
  }
  return new AppError("SUPPLIER_ERROR", {
    ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
    cause: error,
  });
}

/** True for an Amadeus `404` (an order Amadeus no longer has). */
const isOrderNotFound = (error: unknown): error is AppError =>
  isAppError(error) && error.cause instanceof AmadeusCallError && error.cause.httpStatus === 404;

/** A sealed document as `booking_travelers` keeps it (StoredDocument), or `undefined` for one without a number. */
function storedDocumentOf(document: JsonObject): StoredDocument | undefined {
  const type = text(document["documentType"]);
  const number = text(document["number"]);
  if (type === undefined || number === undefined || !DOCUMENT_TYPES.has(type)) {
    return undefined;
  }
  const stored: Record<string, unknown> = { documentType: type, number };
  for (const field of DOCUMENT_FIELDS) {
    const value = text(document[field]);
    if (value !== undefined) {
      stored[field] = value;
    }
  }
  stored["holder"] = document["holder"] !== false;
  return stored as unknown as StoredDocument;
}

const dateOrNull = (value: unknown): string | null =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
const countryOrNull = (value: string | undefined): string | null =>
  value !== undefined && /^[A-Z]{2}$/.test(value) ? value : null;

/** The value of a name part: the merged traveller's when it has the key, else the stored one. */
function namePart(name: JsonObject, key: string, stored: string | null): string | null {
  return Object.prototype.hasOwnProperty.call(name, key) ? (text(name[key]) ?? null) : stored;
}

// ---- The service ----------------------------------------------------------------------------------------------------

/** What T1 of a patch read and built. */
interface PreparedPatch {
  readonly orderId: string;
  readonly office: string | null;
  /** The booking as T1 read it (the before of a resync after a timeout). */
  readonly previous: BookingState;
  /** The Flight Order Management PATCH `data`. */
  readonly data: JsonObject;
  /** The stored values of the elements sent (the staff action's before). */
  readonly before: JsonObject;
  /** The travellers sent, merged, with their rows. */
  readonly travelers: readonly { readonly row: BookingTravelerRow; readonly traveler: JsonObject }[];
  /** The keys of the remarks the request sent (their new rows carry the staff member). */
  readonly sentRemarkKeys: ReadonlySet<string>;
}

/** What T1 of an issuance claimed and read. */
interface IssueClaim {
  /** The booking as the claim found it (before `in_progress`). */
  readonly booking: TicketingBookingRow;
  readonly orderId: string;
  /** `ticketing_last_attempt_at` of the claim: its fencing token. */
  readonly claimedAt: Date;
  readonly payment: IssuePayment;
  /** The ids of the order's flight offers (the default form of payment names them). */
  readonly offerIds: readonly string[];
}

/** Why an order is projected on the booking. */
type ProjectionCause = "patch" | "resync" | "patch_timeout";

/** A booking's status and version before a synchronisation (the `booking.resync` staff action's before). */
interface BookingState {
  readonly status: string;
  readonly version: number;
}

@Injectable()
export class ConsoleBookingActionsService {
  constructor(
    private readonly tx: TenantTx,
    private readonly bookings: BookingsRepository,
    private readonly repository: ConsoleBookingsRepository,
    private readonly travelerDocuments: BookingTravelerDocuments,
    private readonly customerBookings: CustomerBookingsService,
    private readonly consoleBookings: ConsoleBookingsService,
    private readonly amadeus: AmadeusClient,
    private readonly audit: StaffActionsWriter,
    private readonly tenants: TenantContext,
    private readonly staff: StaffContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectPinoLogger(ConsoleBookingActionsService.name) private readonly logger: PinoLogger,
    private readonly sync: BookingSyncService,
    private readonly emails: BookingUpdatedEmails,
    private readonly ticketing: TicketingRepository,
    private readonly recorder: OrderRecorder,
    private readonly payments: PaymentsRepository,
    private readonly consolePayments: ConsolePaymentsService,
    private readonly cancellations: CancellationService,
  ) {}

  // ---- console.bookings.retrieve -----------------------------------------------------------------------------------

  /** The verbatim Amadeus order of a booking (see the file header). */
  async retrieve(bookingId: string, query: ConsoleRetrieveQuery): Promise<ConsoleFlightOrderRetrieval> {
    const tenant = this.tenants.require();
    const include: "bags"[] = [...(query.include ?? [])];
    const fareRules: FareRuleType[] = [...(query.fareRules ?? [])];
    const updateSnapshot = query.updateSnapshot !== false;
    const claim = await this.tx.run(async (trx) => {
      const booking = await this.bookingOfEnvironment(trx, tenant, bookingId);
      return { orderId: this.requireOrder(booking), office: booking.ownerOfficeId, version: booking.version };
    });
    const amadeusQuery = {
      ...(include.length > 0 ? { include: [...include] } : {}),
      ...(fareRules.length > 0 ? { fareRules: [...fareRules] } : {}),
    };
    let reply;
    try {
      reply = await this.amadeus.getFlightOrder(
        this.callContext(tenant, bookingId, OPERATIONS.retrieve, claim.office),
        { flightOrderId: claim.orderId, query: amadeusQuery },
      );
    } catch (error) {
      if (isOrderNotFound(error)) {
        throw new AppError("NOT_FOUND", {
          message: "Amadeus no longer has this order.",
          ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
          cause: error,
        });
      }
      throw documented(error, RETRIEVE_SUPPLIER_CODES);
    }
    const body: unknown = reply.body;
    if (!isRecord(body) || !isRecord(body["data"])) {
      throw new AppError("SUPPLIER_ERROR");
    }
    const supplierRequestId = reply.call.supplierRequestId;
    if (supplierRequestId === null) {
      // The answer names its supplier_requests row, which could not be written (the log line says why).
      throw new Error("console.bookings.retrieve: the Amadeus call could not be recorded");
    }
    const retrievedAt = this.clock.now();
    const data = body["data"];
    const snapshotUpdated = await this.tx.run(async (trx) => {
      let updated = false;
      if (updateSnapshot) {
        const booking = await this.bookings.booking(trx, bookingId, true);
        const details = await this.bookings.bookingDetails(trx, bookingId);
        if (booking !== undefined && details !== undefined && booking.version === claim.version) {
          const included = isRecord(details.orderIncluded) ? { ...details.orderIncluded } : {};
          if (include.length > 0) {
            included["bags"] = isRecord(body["included"]) ? (body["included"]["bags"] ?? {}) : {};
            included["bagsLoadedAt"] = retrievedAt.toISOString();
          }
          if (fareRules.length > 0) {
            const rules: StoredFareRules = {
              loadedAt: retrievedAt.toISOString(),
              types: [...fareRules],
              offers: offerFareRulesOf(data),
            };
            included["fareRules"] = rules;
          }
          await this.bookings.updateSynced(
            trx,
            bookingId,
            {
              order_snapshot: JSON.stringify(keptOrderDataOf(data)),
              ...(body["dictionaries"] === undefined
                ? {}
                : { order_dictionaries: JSON.stringify(body["dictionaries"]) }),
              order_included: JSON.stringify(redactPayload(included)),
              last_synced_at: retrievedAt,
              sync_error: null,
              updated_at: retrievedAt,
            },
            false,
          );
          updated = true;
        }
      }
      await this.audit.record(trx, {
        action: CONSOLE_BOOKING_ACTIONS.retrieve,
        targetType: "booking",
        targetId: bookingId,
        bookingId,
        after: {
          flightOrderId: claim.orderId,
          include,
          fareRules,
          snapshotUpdated: updated,
          supplierRequestId,
        },
      });
      return updated;
    });
    const spec = AMADEUS_OPERATIONS.getFlightOrder;
    return {
      bookingId,
      flightOrderId: claim.orderId,
      retrievedAt: retrievedAt.toISOString(),
      include,
      fareRules,
      snapshotUpdated,
      call: {
        supplierRequestId,
        environment: tenant.environment,
        officeId: reply.call.officeId,
        amadeusApi: spec.api,
        amadeusOperationId: spec.operationId,
        httpMethod: spec.method,
        path: requestPath(spec.path, { "flight-orderId": claim.orderId }, amadeusQuery),
        httpStatus: reply.call.status,
        durationMs: reply.call.durationMs,
        correlationId: reply.call.correlationId,
      },
      amadeus: consoleOrderReplyOf(body) as ConsoleFlightOrderRetrieval["amadeus"],
    };
  }

  // ---- console.bookings.patch --------------------------------------------------------------------------------------

  /** Changes the booking's order and its local tags (see the file header); answers the console booking. */
  async patch(bookingId: string, ifMatch: string, body: ConsolePatchRequest): Promise<ConsoleBooking> {
    refusePatchRequest(body);
    const tenant = this.tenants.require();
    const elements = patchElementsOf(body);
    if (elements.amadeus.length === 0) {
      await this.tx.run((trx) => this.patchLocally(trx, tenant, bookingId, ifMatch, body));
      return await this.answer(
        bookingId,
        body.notifyCustomer === true ? [NOTIFICATION_NOT_SENT_WARNING] : [],
      );
    }
    const prepared = await this.tx.run((trx) =>
      this.preparePatch(trx, tenant, bookingId, ifMatch, body, elements.amadeus),
    );
    let reply;
    try {
      reply = await this.amadeus.patchFlightOrder(
        this.callContext(tenant, bookingId, OPERATIONS.patch, prepared.office),
        {
          flightOrderId: prepared.orderId,
          // Built from the validated request and the stored order (see preparePatch), as JSON.
          body: { data: prepared.data } as unknown as PatchFlightOrderRequest["body"],
        },
        // The supplier log keeps the request as Velexis keeps an order (forms of identification cut, too).
        { redactedRequest: { data: keptOrderDataOf(prepared.data) } },
      );
    } catch (error) {
      if (isAppError(error) && error.code === "SUPPLIER_TIMEOUT") {
        // The change may have happened at Amadeus: read the order back before answering, so the booking shows it.
        await this.resyncAfterTimeout(tenant, bookingId, prepared);
      }
      throw documented(error, PATCH_SUPPLIER_CODES);
    }
    const replyBody: unknown = reply.body;
    const replyData = isRecord(replyBody) && isRecord(replyBody["data"]) ? replyBody["data"] : undefined;
    if (replyData === undefined) {
      // A 2xx without an order: the change happened, its result is unknown here.
      await this.resyncAfterTimeout(tenant, bookingId, prepared);
      throw new AppError("SUPPLIER_ERROR");
    }
    const refused = await this.tx.run((trx) =>
      this.recordPatch(trx, tenant, bookingId, body, elements.amadeus, prepared, {
        data: replyData,
        dictionaries: isRecord(replyBody) ? replyBody["dictionaries"] : undefined,
        supplierRequestId: reply.call.supplierRequestId,
      }),
    );
    return await this.answer(
      bookingId,
      refused.map((email) =>
        email === "updated" ? NOTIFICATION_REFUSED_WARNING : CONTACT_NOTICE_REFUSED_WARNING,
      ),
    );
  }

  /**
   * The console booking after a patch, with the warnings of a `notifyCustomer` that sent nothing (a `tags`/`metadata`
   * patch, or an e-mail the outbox refused).
   */
  private async answer(bookingId: string, notices: readonly Warning[]): Promise<ConsoleBooking> {
    const booking = await this.consoleBookings.get(bookingId, { refresh: false });
    return notices.length > 0
      ? { ...booking, warnings: [...(booking.warnings ?? []), ...notices.map((warning) => ({ ...warning }))] }
      : booking;
  }

  /** A patch of `tags` and `metadata` only: no Amadeus call, any status (see the file header). */
  private async patchLocally(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    ifMatch: string,
    body: ConsolePatchRequest,
  ): Promise<void> {
    const booking = await this.bookingOfEnvironment(trx, tenant, bookingId, true);
    this.requireVersion(booking, ifMatch);
    const details = await this.repository.details(trx, bookingId);
    const now = this.clock.now();
    await this.bookings.updateBooking(trx, bookingId, {
      ...(body.tags === undefined ? {} : { tags: [...body.tags] }),
      ...(body.metadata === undefined ? {} : { metadata: JSON.stringify(body.metadata) }),
      updated_at: now,
    });
    await this.audit.record(trx, {
      action: CONSOLE_BOOKING_ACTIONS.tagsUpdated,
      targetType: "booking",
      targetId: bookingId,
      bookingId,
      reason: body.reason ?? null,
      before: {
        ...(body.tags === undefined ? {} : { tags: details?.tags ?? [] }),
        ...(body.metadata === undefined ? {} : { metadata: booking.metadata }),
      },
      after: {
        ...(body.tags === undefined ? {} : { tags: body.tags }),
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      },
    });
  }

  /** T1 of a patch: the checks, and the PATCH data merged with the stored order (see the file header). */
  private async preparePatch(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    ifMatch: string,
    body: ConsolePatchRequest,
    elements: readonly AmadeusPatchElement[],
  ): Promise<PreparedPatch> {
    const booking = await this.bookingOfEnvironment(trx, tenant, bookingId, true);
    this.requireVersion(booking, ifMatch);
    if (booking.status === "cancelled") {
      throw new AppError("BOOKING_ALREADY_CANCELLED");
    }
    const orderId = this.requireOrder(booking);
    const stored = await this.bookings.bookingDetails(trx, bookingId);
    const details = await this.repository.details(trx, bookingId);
    if (stored === undefined || details === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const children = await this.bookings.children(trx, bookingId);
    const snapshot = isRecord(stored.orderSnapshot) ? stored.orderSnapshot : {};
    const data: JsonObject = {
      type: "flight-order",
      id: orderId,
      flightOffers: flightOfferRefsOf(snapshot, children),
    };
    const before: JsonObject = {};
    const travelers: { row: BookingTravelerRow; traveler: JsonObject }[] = [];
    const sentRemarkKeys = new Set<string>();
    for (const element of elements) {
      switch (element) {
        case "travelers": {
          const merged = await this.mergedTravelers(tenant, children, body);
          travelers.push(...merged.sent);
          data["travelers"] = merged.travelers;
          before["travelers"] = merged.before;
          break;
        }
        case "contacts": {
          const storedContacts = Array.isArray(snapshot["contacts"])
            ? records(snapshot["contacts"])
            : children.contacts.map((row) => amadeusOrderContactOf(row));
          data["contacts"] = mergeContacts(
            storedContacts,
            records(body.contacts),
            body.mergeContacts !== false,
          );
          before["contacts"] = storedContacts;
          break;
        }
        case "remarks": {
          const storedRemarks = isRecord(snapshot["remarks"])
            ? snapshot["remarks"]
            : {
                general: children.remarks
                  .filter((row) => row.kind === "general")
                  .map((row) => ({
                    subType: row.subType,
                    text: row.text,
                    ...(row.travelerIds.length > 0 ? { travelerIds: [...row.travelerIds] } : {}),
                  })),
              };
          const sent = isRecord(body.remarks) ? body.remarks : {};
          for (const kind of ["general", "airline"] as const) {
            for (const remark of records(sent[kind])) {
              sentRemarkKeys.add(remarkKey(kind, remark));
            }
          }
          data["remarks"] = mergeRemarks(
            storedRemarks,
            {
              general: Array.isArray(sent["general"]) ? sent["general"] : undefined,
              airline: Array.isArray(sent["airline"]) ? sent["airline"] : undefined,
            },
            body.mergeRemarks !== false,
            booking.reference,
          );
          before["remarks"] = storedRemarks;
          break;
        }
        case "formOfPayments":
        case "ticketingAgreement":
        case "automatedProcess":
        case "queuingOfficeId":
        case "ownerOfficeId":
        case "commissions":
        case "formOfIdentifications": {
          // Sent as given: Amadeus replaces the element with it.
          data[element] = (body as JsonObject)[element];
          before[element] = storedElementOf(element, booking, details);
        }
      }
    }
    return {
      orderId,
      office: booking.ownerOfficeId,
      previous: { status: booking.status, version: booking.version },
      data,
      before,
      travelers,
      sentRemarkKeys,
    };
  }

  /**
   * The travellers of a patch (see the file header): Amadeus replaces the whole `travelers` element, so with
   * `mergeTravelers` every traveller of the booking goes, those sent merged over the stored ones (documents decrypted
   * in memory for the request only); without, the travellers as sent. `sent` are the travellers sent with their rows
   * (what the record step stores), `before` their stored versions (the staff action's before, redacted there).
   */
  private async mergedTravelers(
    tenant: RequestTenant,
    children: BookingChildren,
    body: ConsolePatchRequest,
  ): Promise<{
    readonly travelers: JsonObject[];
    readonly sent: { row: BookingTravelerRow; traveler: JsonObject }[];
    readonly before: JsonObject[];
  }> {
    const merge = body.mergeTravelers !== false;
    const stored = new Map<string, JsonObject>();
    for (const row of children.travelers) {
      const opened = await this.travelerDocuments.open(tenant.schemaName, row);
      stored.set(
        row.amadeusTravelerId,
        amadeusTravelerOf({
          travelerId: row.amadeusTravelerId,
          firstName: row.firstName,
          middleName: row.middleName,
          lastName: row.lastName,
          secondLastName: row.secondLastName,
          dateOfBirth: row.dateOfBirth,
          gender: row.gender,
          contact: row.contact,
          documents: opened.documents,
          discounts: opened.discounts,
          loyaltyPrograms: row.loyaltyPrograms,
          emergencyContact: row.emergencyContact,
        }),
      );
    }
    const sent: { row: BookingTravelerRow; traveler: JsonObject }[] = [];
    const before: JsonObject[] = [];
    for (const [index, traveler] of records(body.travelers).entries()) {
      const row = children.travelers.find((candidate) => candidate.amadeusTravelerId === traveler["id"]);
      const storedTraveler = row === undefined ? undefined : stored.get(row.amadeusTravelerId);
      if (row === undefined || storedTraveler === undefined) {
        throw new AppError("TRAVELER_DATA_INVALID", {
          fieldErrors: [
            {
              path: `/travelers/${index}/id`,
              code: "invalid",
              message: "No traveller of the booking has this id.",
            },
          ],
        });
      }
      const merged = mergeTraveler(storedTraveler, traveler, merge);
      if (merged.missing.length > 0) {
        throw new AppError("TRAVELER_DATA_INVALID", {
          fieldErrors: merged.missing.map((missing) => ({
            path: `/travelers/${index}/documents/${missing.index}/number`,
            code: "required",
            message: "The traveller has no document of this type to keep the number of.",
          })),
        });
      }
      before.push(storedTraveler);
      sent.push({ row, traveler: merged.traveler });
    }
    const byId = new Map(sent.map((entry) => [entry.row.amadeusTravelerId, entry.traveler]));
    return {
      travelers: merge
        ? children.travelers.flatMap((row): JsonObject[] => {
            const traveler = byId.get(row.amadeusTravelerId) ?? stored.get(row.amadeusTravelerId);
            return traveler === undefined ? [] : [traveler];
          })
        : sent.map((entry) => entry.traveler),
      sent,
      before,
    };
  }

  /**
   * T2 of a patch: the answer recorded on the booking (see the file header). Answers the `booking.updated` e-mails the
   * outbox refused (none without `notifyCustomer`).
   */
  private async recordPatch(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    body: ConsolePatchRequest,
    elements: readonly AmadeusPatchElement[],
    prepared: PreparedPatch,
    reply: {
      readonly data: JsonObject;
      readonly dictionaries: unknown;
      readonly supplierRequestId: string | null;
    },
  ): Promise<readonly BookingUpdatedEmail[]> {
    const now = this.clock.now();
    const booking = await this.bookings.booking(trx, bookingId, true);
    const details = await this.repository.details(trx, bookingId);
    if (booking === undefined || details === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const children = await this.bookings.children(trx, bookingId);
    // The order as Amadeus answered it, with what was sent for an element the answer leaves out.
    const order: JsonObject = { ...prepared.data, ...reply.data };
    const projected = await this.projectOrder(trx, booking, details, children, order, {
      staffId: this.staffId(),
      sentRemarkKeys: prepared.sentRemarkKeys,
      now,
    });
    const leadLastName = await this.storeTravelers(trx, tenant, booking, children, prepared.travelers, now);
    await this.bookings.updateBooking(trx, bookingId, {
      ...projected.values,
      order_snapshot: JSON.stringify(keptOrderDataOf(reply.data)),
      ...(reply.dictionaries === undefined ? {} : { order_dictionaries: JSON.stringify(reply.dictionaries) }),
      ...(body.tags === undefined ? {} : { tags: [...body.tags] }),
      ...(body.metadata === undefined ? {} : { metadata: JSON.stringify(body.metadata) }),
      ...(leadLastName === undefined ? {} : { lead_last_name: leadLastName }),
      last_synced_at: now,
      sync_error: null,
      updated_at: now,
    });
    const documentsChanged = prepared.travelers.some((entry) => Array.isArray(entry.traveler["documents"]));
    const changed = [...elements, ...patchElementsOf(body).local];
    await this.bookings.insertEvent(trx, {
      id: this.ids.newId("evt"),
      booking_id: bookingId,
      type: BOOKING_PATCHED_EVENT,
      actor_type: eventActorOf(tenant.actor).type,
      actor_id: eventActorOf(tenant.actor).id,
      status_from: booking.status,
      status_to: booking.status,
      summary: "Booking details updated.",
      data: JSON.stringify(redactPayload({ elements: changed })),
      visible_to_customer: elements.includes("contacts") || documentsChanged,
      supplier_request_id: reply.supplierRequestId,
      request_id: this.requestId(tenant),
      created_at: now,
      updated_at: now,
    });
    // What was sent: the travellers sent (merged), not the others the PATCH carried unchanged; the writer redacts it
    // (documents), the forms of identification are cut here.
    const sent = keptOrderDataOf(prepared.data);
    const after: JsonObject = {};
    for (const element of elements) {
      after[element] =
        element === "travelers" ? prepared.travelers.map((entry) => entry.traveler) : sent[element];
    }
    await this.audit.record(trx, {
      action: CONSOLE_BOOKING_ACTIONS.patch,
      targetType: "booking",
      targetId: bookingId,
      bookingId,
      reason: body.reason ?? null,
      before: {
        ...prepared.before,
        ...(body.tags === undefined ? {} : { tags: details.tags }),
        ...(body.metadata === undefined ? {} : { metadata: booking.metadata }),
      },
      after: {
        ...after,
        ...(body.tags === undefined ? {} : { tags: body.tags }),
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      },
    });
    if (body.notifyCustomer !== true) {
      return [];
    }
    return await this.notifyCustomer(trx, tenant, booking, {
      contactsChanged: projected.changed.includes("contacts"),
      previousLanguage: children.contacts.find((row) => row.isPrimary)?.language ?? null,
    });
  }

  /**
   * The `booking.updated` e-mails of a patch with `notifyCustomer` (see the file header), in the record's transaction:
   * the booking read again as the patch left it (`before` is the row it locked first: its previous contact e-mail; the
   * previous primary contact's language is the notice's locale). Answers the e-mails the outbox refused.
   */
  private async notifyCustomer(
    trx: TenantTransaction,
    tenant: RequestTenant,
    before: BookingRow,
    change: { readonly contactsChanged: boolean; readonly previousLanguage: string | null },
  ): Promise<readonly BookingUpdatedEmail[]> {
    const booking = await this.bookings.booking(trx, before.id);
    if (booking === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const children = await this.bookings.children(trx, booking.id);
    const primary = children.contacts.find((row) => row.isPrimary);
    const sent = await this.emails.send(trx, {
      tenantKey: tenant.key,
      booking,
      travelers: children.travelers,
      segments: children.segments,
      contact: {
        email: booking.contactEmail,
        firstName: primary?.firstName ?? null,
        lastName: primary?.lastName ?? null,
        language: primary?.language ?? null,
      },
      previousEmail: before.contactEmail,
      previousLanguage: change.previousLanguage,
      contactsChanged: change.contactsChanged,
      dedupePrefix: PATCH_EMAIL_DEDUPE,
      version: booking.version,
    });
    return sent.refused;
  }

  /**
   * The travellers of a patch stored as sent (documents and discount cards sealed again for their rows); returns the
   * lead traveller's new upper-case last name, or `undefined` when no traveller was sent.
   */
  private async storeTravelers(
    trx: TenantTransaction,
    tenant: RequestTenant,
    booking: BookingRow,
    children: BookingChildren,
    travelers: PreparedPatch["travelers"],
    now: Date,
  ): Promise<string | undefined> {
    if (travelers.length === 0) {
      return undefined;
    }
    const lastNames = new Map(children.travelers.map((row) => [row.id, row.lastName]));
    for (const { row, traveler } of travelers) {
      const name = isRecord(traveler["name"]) ? traveler["name"] : {};
      const documents = records(traveler["documents"]).flatMap(
        (document) => storedDocumentOf(document) ?? [],
      );
      const discounts = records(traveler["discountEligibility"]) as AmadeusDiscount[];
      const sealed = await this.travelerDocuments.seal(tenant.schemaName, row.id, documents, discounts);
      const main = documents.find((document) => document.holder) ?? documents[0];
      const lastName = namePart(name, "lastName", row.lastName) ?? row.lastName;
      lastNames.set(row.id, lastName);
      await this.repository.updateTraveler(trx, booking.id, row.id, {
        first_name: namePart(name, "firstName", row.firstName) ?? row.firstName,
        middle_name: namePart(name, "middleName", row.middleName),
        last_name: lastName,
        second_last_name: namePart(name, "secondLastName", row.secondLastName),
        date_of_birth: Object.prototype.hasOwnProperty.call(traveler, "dateOfBirth")
          ? dateOrNull(traveler["dateOfBirth"])
          : row.dateOfBirth,
        gender:
          typeof traveler["gender"] === "string" && GENDERS.has(traveler["gender"])
            ? traveler["gender"]
            : row.gender,
        contact: isRecord(traveler["contact"]) ? JSON.stringify(traveler["contact"]) : null,
        loyalty_programs: JSON.stringify(records(traveler["loyaltyPrograms"])),
        emergency_contact: isRecord(traveler["emergencyContact"])
          ? JSON.stringify(traveler["emergencyContact"])
          : null,
        documents_ciphertext: sealed.documentsCiphertext,
        discount_eligibility_ciphertext: sealed.discountEligibilityCiphertext,
        encryption_key_id: sealed.encryptionKeyId,
        document_type: main?.documentType ?? null,
        document_last4: main === undefined ? null : main.number.slice(-4),
        document_expiry_date: dateOrNull(main?.expiryDate),
        document_issuance_country: countryOrNull(main?.issuanceCountry),
        document_nationality: countryOrNull(main?.nationality),
        updated_at: now,
      });
    }
    // The lead traveller as the console list reads it: the first adult, by Amadeus id.
    const lead = [...children.travelers].sort(
      (a, b) =>
        Number(a.travelerType !== "ADULT") - Number(b.travelerType !== "ADULT") ||
        a.amadeusTravelerId.length - b.amadeusTravelerId.length ||
        a.amadeusTravelerId.localeCompare(b.amadeusTravelerId),
    )[0];
    return lead === undefined ? undefined : (lastNames.get(lead.id) ?? lead.lastName).toUpperCase();
  }

  /**
   * After a PATCH whose outcome is unknown: the refresh without its throttle and the projection of the order read, so
   * the booking shows what Amadeus holds. Its failure is logged; the caller answers the original error.
   */
  private async resyncAfterTimeout(
    tenant: RequestTenant,
    bookingId: string,
    prepared: Pick<PreparedPatch, "previous" | "sentRemarkKeys">,
  ): Promise<void> {
    try {
      const outcome = await this.customerBookings.refresh(
        tenant,
        bookingId,
        OPERATIONS.patch,
        {},
        { throttleMs: 0 },
      );
      if (outcome.kind === "refreshed" || outcome.kind === "superseded") {
        // The staff member's remarks the PATCH may have added are theirs, as after a PATCH that answered.
        await this.tx.run((trx) =>
          this.recordResync(trx, tenant, bookingId, "patch_timeout", prepared.previous, {
            staffId: this.staffId(),
            sentRemarkKeys: prepared.sentRemarkKeys,
          }),
        );
      }
      this.logger.info({ bookingId, outcome: outcome.kind }, "console.bookings.patch_resynced");
    } catch (error) {
      this.logger.warn({ bookingId, err: error }, "console.bookings.patch_resync_failed");
    }
  }

  // ---- console.bookings.resync -------------------------------------------------------------------------------------

  /** The booking synchronised with its Amadeus order (see the file header). */
  async resync(bookingId: string, body: ConsoleResyncRequest): Promise<ConsoleBookingResyncResult> {
    const tenant = this.tenants.require();
    await this.tx.run(async (trx) => {
      const booking = await this.bookingOfEnvironment(trx, tenant, bookingId);
      this.requireOrder(booking);
      if (booking.status === "cancelled") {
        throw new AppError("BOOKING_NOT_MODIFIABLE", {
          message: "A cancelled booking has no order to synchronise.",
          details: { status: booking.status },
        });
      }
    });
    const before = await this.consoleBookings.get(bookingId, { refresh: false });
    const outcome = await this.sync.refresh({ id: tenant.tenantId, key: tenant.key }, bookingId, {
      operation: OPERATIONS.resync,
      requestId: this.requestId(tenant),
      environment: tenant.environment,
      query: { include: body.include, fareRules: body.fareRules },
      throttleMs: CONSOLE_REFRESH_THROTTLE_MS,
      staffId: tenant.actor.type === "staff" ? tenant.actor.id : null,
    });
    switch (outcome.kind) {
      case "skipped":
        throw new AppError("BOOKING_NOT_MODIFIABLE", { details: { status: before.status } });
      case "throttled":
        throw new AppError("RATE_LIMITED", {
          message: "This booking was synchronised a moment ago: try again shortly.",
          details: { retryAfterSeconds: outcome.retryAfterSeconds },
        });
      case "not_found":
        throw new AppError("SUPPLIER_REJECTED", { message: "Amadeus no longer has this order." });
      case "refreshed":
      case "superseded":
        break;
    }
    await this.tx.run((trx) =>
      this.recordResync(
        trx,
        tenant,
        bookingId,
        "resync",
        { status: before.status, version: before.version },
        { staffId: null, sentRemarkKeys: new Set() },
      ),
    );
    const synced = await this.consoleBookings.get(bookingId, { refresh: false });
    const warnings = outcome.kind === "refreshed" ? outcome.warnings : [];
    const after: ConsoleBooking =
      outcome.kind === "refreshed"
        ? {
            ...synced,
            syncStatus: "refreshed",
            supplierSync: { ...synced.supplierSync, status: "refreshed" },
            ...(warnings.length > 0 ? { warnings: [...(synced.warnings ?? []), ...warnings] } : {}),
          }
        : synced;
    return {
      booking: after,
      changes: consoleSyncChanges(before, after),
      statusChanged: before.status !== after.status,
      previousStatus: before.status,
    };
  }

  /**
   * T3 of a resync (and of the resync after a timed-out patch): the stored order projected on the booking, the event
   * `booking.synced` and the `booking.resync` staff action, whose before is `previous` (the booking before the refresh
   * that read the order, which may have changed its status) and whose after is the booking now.
   */
  private async recordResync(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    cause: ProjectionCause,
    previous: BookingState,
    remarks: { readonly staffId: string | null; readonly sentRemarkKeys: ReadonlySet<string> },
  ): Promise<void> {
    const now = this.clock.now();
    const booking = await this.bookings.booking(trx, bookingId, true);
    const stored = await this.bookings.bookingDetails(trx, bookingId);
    const details = await this.repository.details(trx, bookingId);
    if (booking === undefined || stored === undefined || details === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const children = await this.bookings.children(trx, bookingId);
    const order = isRecord(stored.orderSnapshot) ? stored.orderSnapshot : {};
    const projected = await this.projectOrder(trx, booking, details, children, order, { ...remarks, now });
    if (projected.changed.length > 0) {
      await this.bookings.updateBooking(trx, bookingId, { ...projected.values, updated_at: now });
    }
    await this.bookings.insertEvent(trx, {
      id: this.ids.newId("evt"),
      booking_id: bookingId,
      type: BOOKING_SYNCED_EVENT,
      actor_type: eventActorOf(tenant.actor).type,
      actor_id: eventActorOf(tenant.actor).id,
      status_from: booking.status,
      status_to: booking.status,
      summary: "Booking synchronised with the airline.",
      data: JSON.stringify(redactPayload({ cause, elements: projected.changed })),
      visible_to_customer: false,
      request_id: this.requestId(tenant),
      created_at: now,
      updated_at: now,
    });
    await this.audit.record(trx, {
      action: CONSOLE_BOOKING_ACTIONS.resync,
      targetType: "booking",
      targetId: bookingId,
      bookingId,
      reason: cause === "patch_timeout" ? "Synchronised after a patch whose outcome was unknown." : null,
      before: { status: previous.status, version: previous.version },
      after: {
        status: booking.status,
        version: booking.version + (projected.changed.length > 0 ? 1 : 0),
        elements: projected.changed,
      },
    });
  }

  /**
   * The projection of an order (`order`: an Amadeus `data`) on the booking (see the file header): writes the contacts
   * and remarks, and returns the booking columns that change with the names of the elements that changed.
   */
  private async projectOrder(
    trx: TenantTransaction,
    booking: BookingRow,
    details: ConsoleBookingDetailsRow,
    children: BookingChildren,
    order: JsonObject,
    options: {
      readonly staffId: string | null;
      readonly sentRemarkKeys: ReadonlySet<string>;
      readonly now: Date;
    },
  ): Promise<{ readonly values: Updateable<Db["bookings"]>; readonly changed: string[] }> {
    const changed: string[] = [];
    const values: Updateable<Db["bookings"]> = {};
    const { now } = options;
    if (Array.isArray(order["contacts"])) {
      const primaryPurpose = children.contacts.find((row) => row.isPrimary)?.purpose ?? "STANDARD";
      const contacts = contactValuesOf(records(order["contacts"]), primaryPurpose);
      if (
        contacts.length > 0 &&
        canonicalJson(contacts) !== canonicalJson(storedContactValues(children.contacts))
      ) {
        await this.repository.replaceContacts(
          trx,
          booking.id,
          contacts.map((contact, index) =>
            contactRowOf(this.ids.newId("bco"), booking.id, contact, now, index),
          ),
        );
        const primary = contacts.find((contact) => contact.isPrimary);
        if (primary?.email !== null && primary?.email !== undefined) {
          values.contact_email = primary.email;
        }
        changed.push("contacts");
      }
    }
    if (isRecord(order["remarks"])) {
      const plan = planRemarks(children.remarks, orderRemarksOf(order["remarks"]));
      if (plan.insert.length > 0 || plan.remove.length > 0) {
        await this.repository.deleteRemarks(
          trx,
          booking.id,
          plan.remove.map((row) => row.id),
        );
        await this.bookings.insertChildren(trx, {
          associatedRecords: [],
          travelers: [],
          contacts: [],
          segments: [],
          tickets: [],
          remarks: plan.insert.map((entry, index) => ({
            id: this.ids.newId("rmk"),
            booking_id: booking.id,
            kind: entry.kind,
            sub_type: entry.subType,
            category: entry.category,
            airline_code: entry.airlineCode,
            keyword: entry.keyword,
            text: entry.text,
            traveler_ids: entry.travelerIds,
            flight_offer_ids: entry.flightOfferIds,
            visible_to_customer: false,
            created_by_staff_id: options.sentRemarkKeys.has(entry.key) ? options.staffId : null,
            created_at: new Date(now.getTime() + index),
            updated_at: now,
          })),
        });
        changed.push("remarks");
      }
    }
    const jsonColumns = [
      ["ticketingAgreement", "ticketing_agreement", details.ticketingAgreement],
      ["automatedProcess", "automated_process", details.automatedProcess],
      ["formOfPayments", "form_of_payments", details.formOfPayments],
      ["commissions", "commissions", details.commissions],
      ["formOfIdentifications", "form_of_identifications", details.formOfIdentifications],
    ] as const;
    for (const [element, column, current] of jsonColumns) {
      const raw = order[element];
      const value = element === "ticketingAgreement" ? (isRecord(raw) ? raw : undefined) : records(raw);
      if (raw === undefined || value === undefined) {
        continue;
      }
      const next =
        element === "formOfPayments"
          ? redactPayload(value)
          : element === "formOfIdentifications"
            ? maskedIdentifications(value)
            : value;
      if (canonicalJson(next) !== canonicalJson(current)) {
        values[column] = JSON.stringify(next);
        changed.push(element);
      }
    }
    if (changed.includes("ticketingAgreement")) {
      const agreement = isRecord(order["ticketingAgreement"]) ? order["ticketingAgreement"] : null;
      const local = deadlineLocalOf(booking.lastTicketingDate, agreement);
      const settings = await this.bookings.settings(trx);
      const [deadline] =
        local === null || settings === undefined
          ? [undefined]
          : await this.bookings.instants(trx, [{ local, zone: settings.timeZone }]);
      if (local === null || deadline !== undefined) {
        values.ticketing_deadline_at = deadline ?? null;
      }
    }
    for (const [element, column, current] of [
      ["queuingOfficeId", "queuing_office_id", booking.queuingOfficeId],
      ["ownerOfficeId", "owner_office_id", booking.ownerOfficeId],
    ] as const) {
      const office = text(order[element]);
      if (office !== undefined && office !== current) {
        values[column] = office;
        changed.push(element);
      }
    }
    return { values, changed };
  }

  // ---- console.bookings.addNote ------------------------------------------------------------------------------------

  /** A staff note on the booking's timeline (see the file header). */
  async addNote(bookingId: string, body: ConsoleNoteRequest): Promise<ConsoleBookingNote> {
    const tenant = this.tenants.require();
    return await this.tx.run(async (trx) => {
      await this.bookingOfEnvironment(trx, tenant, bookingId);
      const id = this.ids.newId("evt");
      const now = this.clock.now();
      const visibleToCustomer = body.visibleToCustomer === true;
      const actor = eventActorOf(tenant.actor);
      await this.bookings.insertEvent(trx, {
        id,
        booking_id: bookingId,
        type: STAFF_NOTE_EVENT,
        actor_type: actor.type,
        actor_id: actor.id,
        summary: body.text,
        data: JSON.stringify(redactPayload({ text: body.text })),
        visible_to_customer: visibleToCustomer,
        request_id: this.requestId(tenant),
        created_at: now,
        updated_at: now,
      });
      // The note's id and visibility only: its text is the staff member's, possibly personal data.
      await this.audit.record(trx, {
        action: CONSOLE_BOOKING_ACTIONS.note,
        targetType: "booking",
        targetId: bookingId,
        bookingId,
        after: { noteId: id, visibleToCustomer },
      });
      return {
        id,
        bookingId,
        text: body.text,
        visibleToCustomer,
        author: this.author(tenant),
        createdAt: now.toISOString(),
      };
    });
  }

  /** The author of a note: the signed-in staff member, else the key of a key-only call. */
  private author(tenant: RequestTenant): ConsoleActor {
    const principal = this.staff.get();
    if (principal !== undefined) {
      return {
        type: "staff",
        id: principal.family.staffId,
        name: principal.member.account.fullName,
        email: principal.member.account.email,
        role: principal.member.role,
      };
    }
    return {
      type: tenant.actor.type === "api_key" ? "api_key" : "system",
      id: tenant.actor.type === "api_key" ? tenant.actor.id : null,
      name: null,
      email: null,
      role: null,
    };
  }

  // ---- console.bookings.issue (OBE-063) ----------------------------------------------------------------------------

  /** Issues the booking's tickets, capturing an authorised payment first (see the file header); answers the booking. */
  async issue(bookingId: string, ifMatch: string, body: ConsoleIssueRequest): Promise<ConsoleBooking> {
    refuseIssueRequest(body, this.staff.get()?.member.role);
    const tenant = this.tenants.require();
    const claim = await this.tx.run((trx) => this.claimIssue(trx, tenant, bookingId, ifMatch, body));
    if (claim.payment.kind === "capture") {
      await this.captureBeforeIssue(tenant, claim, claim.payment.paymentId, body);
    }
    const context = this.callContext(tenant, bookingId, OPERATIONS.issue, claim.booking.ownerOfficeId);
    const found = await this.resyncBeforeIssue(tenant, claim, context);
    if (found !== undefined) {
      await this.tx.run((trx) =>
        this.recordIssue(trx, tenant, claim, body, found.order, {
          via: "resync",
          supplierRequestId: found.supplierRequestId,
        }),
      );
      this.logger.info({ bookingId }, "console.bookings.issue_found_before_issue");
      return await this.consoleBookings.get(bookingId, { refresh: false });
    }
    const formOfPayments =
      body.formOfPayments === undefined
        ? buildIssueRequest(claim.offerIds).data.formOfPayments
        : body.formOfPayments.map((entry) => ({ ...entry }));
    let order: CreatedOrder | undefined;
    let supplierRequestId: string | null = null;
    try {
      const reply = await this.amadeus.issueFlightOrder(context, {
        flightOrderId: claim.orderId,
        // The request's forms of payment, validated and free of card data (refuseIssueRequest), or the job's default.
        body: { data: { formOfPayments } } as unknown as IssueFlightOrderRequest["body"],
      });
      order = readCreatedOrder(reply.body);
      supplierRequestId = reply.call.supplierRequestId;
    } catch (error) {
      if (createFailureKind(error) !== "unknown") {
        // A refusal, or a call that never reached Amadeus: nothing was issued.
        await this.releaseIssue(tenant, claim, codeOf(error));
        throw issueAnswerOf(error);
      }
      return await this.afterUnknownIssue(tenant, claim, body, error);
    }
    if (order === undefined) {
      // A 2xx that cannot be read: the tickets may exist, so the order is read back as after a timeout.
      return await this.afterUnknownIssue(tenant, claim, body, new AppError("SUPPLIER_ERROR"));
    }
    if (ticketCoverage(order.travelerIds, order.tickets) === "none") {
      await this.releaseIssue(tenant, claim, "TICKETING_FAILED");
      throw new AppError("TICKETING_FAILED", { message: "Flight Order Issue answered without a ticket." });
    }
    await this.tx.run((trx) =>
      this.recordIssue(trx, tenant, claim, body, order, { via: "issue", supplierRequestId }),
    );
    return await this.consoleBookings.get(bookingId, { refresh: false });
  }

  /**
   * T1 of an issuance: the ticketing claim (see the file header). Answers the claim's facts; throws the refusals.
   */
  private async claimIssue(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    ifMatch: string,
    body: ConsoleIssueRequest,
  ): Promise<IssueClaim> {
    const now = this.clock.now();
    const row = await this.ticketing.lock(trx, bookingId, { skipLocked: true });
    if (row === undefined) {
      const exists = await this.bookings.booking(trx, bookingId);
      if (exists === undefined || exists.environment !== tenant.environment) {
        throw new AppError("NOT_FOUND");
      }
      throw bookingBusy();
    }
    if (row.environment !== tenant.environment) {
      throw new AppError("NOT_FOUND");
    }
    if (!ifMatchSatisfied(ifMatch, row.version)) {
      throw new AppError("PRECONDITION_FAILED", { details: { currentVersion: row.version } });
    }
    if (row.status === "cancelled") {
      throw new AppError("BOOKING_ALREADY_CANCELLED");
    }
    if (row.status === "ticketed" || row.ticketingStatus === "issued") {
      throw new AppError("ALREADY_ISSUED", { details: { status: row.status } });
    }
    if (row.amadeusOrderId === null || !ISSUABLE_STATUSES.has(row.status)) {
      throw new AppError("BOOKING_NOT_MODIFIABLE", {
        message: "The booking has no Amadeus order to issue.",
        details: { status: row.status },
      });
    }
    // A cancellation holds the booking (FIX-W31-OTA, cancellation-state.ts `cancellationHoldOf`): its DELETE is in
    // flight (a fresh `cancellation_claimed_at`) or got no answer and is undecided, as before.
    if (cancellationHoldOf(row, now) !== undefined) {
      throw new AppError("BOOKING_NOT_MODIFIABLE", {
        message: "A cancellation of this booking is being checked with the airline.",
        details: { reason: "cancellation_pending" },
      });
    }
    if (ticketingClaimFresh(row, now)) {
      throw new AppError("BOOKING_NOT_MODIFIABLE", {
        message: "The tickets of this booking are being issued right now: reload it in a moment.",
        details: { reason: "ticketing_in_progress" },
      });
    }
    if (row.paidByAirlineCard) {
      refuseAirlineCardIssue(body.formOfPayments);
    }
    const payments: PaymentRow[] = [];
    for (const id of await this.bookings.paymentIdsOf(trx, bookingId)) {
      const payment = await this.payments.payment(trx, id);
      if (payment !== undefined) {
        payments.push(payment);
      }
    }
    const booking = await this.bookings.booking(trx, bookingId);
    const stored = await this.bookings.bookingDetails(trx, bookingId);
    if (booking === undefined || stored === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const payment = issuePaymentOf({
      channel: booking.channel,
      payments,
      capturePayment: body.capturePayment !== false,
    });
    if (payment.kind === "unpaid" && body.allowUnpaid !== true) {
      throw new AppError("PAYMENT_REQUIRED", {
        message: "The booking is not paid: capture its payment, or issue it unpaid (owner or admin).",
        details: { paymentStatus: "unpaid" },
      });
    }
    const children = await this.bookings.children(trx, bookingId);
    await this.bookings.updateBooking(trx, bookingId, {
      ticketing_status: "in_progress",
      ticketing_last_attempt_at: now,
      ticketing_next_attempt_at: null,
      updated_at: now,
    });
    return {
      booking: row,
      orderId: row.amadeusOrderId,
      claimedAt: now,
      payment,
      offerIds: flightOfferRefsOf(stored.orderSnapshot, children).map((ref) => String(ref["id"])),
    };
  }

  /**
   * The capture of an authorised Stripe payment before the issuance (console.payments.capture's, with its staff
   * action). A capture that does not happen releases the claim and answers `402 PAYMENT_DECLINED` (a Stripe that does
   * not answer: its `502`, which the same key can retry); a payment captured meanwhile is paid all the same.
   */
  private async captureBeforeIssue(
    tenant: RequestTenant,
    claim: IssueClaim,
    paymentId: string,
    body: ConsoleIssueRequest,
  ): Promise<void> {
    try {
      await this.consolePayments.captureForIssue(paymentId, body.reason ?? ISSUE_CAPTURE_REASON);
      return;
    } catch (error) {
      const now = await this.tx.run((trx) => this.payments.payment(trx, paymentId));
      if (now !== undefined && PAID_STATUSES.has(now.status)) {
        // Captured by someone else in the meantime (a staff capture, a retry job): the booking is paid.
        this.logger.info({ bookingId: claim.booking.id, paymentId }, "console.bookings.issue_paid_meanwhile");
        return;
      }
      const code = codeOf(error);
      this.logger.warn(
        { bookingId: claim.booking.id, paymentId, code },
        "console.bookings.issue_capture_failed",
      );
      await this.releaseIssue(tenant, claim, code === "PAYMENT_PROVIDER_ERROR" ? code : "PAYMENT_DECLINED");
      if (isAppError(error) && error.code === "PAYMENT_PROVIDER_ERROR") {
        throw error;
      }
      throw new AppError("PAYMENT_DECLINED", {
        message: "The payment could not be captured; nothing was issued.",
        details: { paymentId },
        cause: error,
      });
    }
  }

  /**
   * The resync before an issuance (see the file header; OADR-0008 point 4): Flight Order Management GET of the claimed
   * order. Answers the order and its call when it holds tickets an earlier call issued (`issuedBeforeIssue`), which are
   * recorded instead of issued again, else `undefined` (the issuance follows). A GET that fails releases the claim and
   * throws its answer (`issueResyncAnswerOf`): the order is never issued without it.
   */
  private async resyncBeforeIssue(
    tenant: RequestTenant,
    claim: IssueClaim,
    context: AmadeusCallContext,
  ): Promise<{ readonly order: CreatedOrder; readonly supplierRequestId: string | null } | undefined> {
    let order: CreatedOrder | undefined;
    let supplierRequestId: string | null;
    try {
      const reply = await this.amadeus.getFlightOrder(context, { flightOrderId: claim.orderId });
      order = readCreatedOrder(reply.body);
      supplierRequestId = reply.call.supplierRequestId;
    } catch (error) {
      this.logger.warn(
        { bookingId: claim.booking.id, code: codeOf(error) },
        "console.bookings.issue_resync_first_failed",
      );
      await this.releaseIssue(tenant, claim, codeOf(error));
      throw issueResyncAnswerOf(error);
    }
    if (order === undefined) {
      await this.releaseIssue(tenant, claim, "SUPPLIER_ERROR");
      throw new AppError("SUPPLIER_ERROR", {
        message: "The order read before the issuance could not be read; nothing was issued.",
      });
    }
    return issuedBeforeIssue(claim.booking.status, ticketCoverage(order.travelerIds, order.tickets))
      ? { order, supplierRequestId }
      : undefined;
  }

  /**
   * After a Flight Order Issue without a reliable outcome (OADR-0003 point 7: no second issuance in the request): the
   * order read back; its tickets are recorded and the booking answered, or the claim is released and the call's error
   * answered (`504`: resync before retrying, Amadeus may still issue).
   */
  private async afterUnknownIssue(
    tenant: RequestTenant,
    claim: IssueClaim,
    body: ConsoleIssueRequest,
    error: unknown,
  ): Promise<ConsoleBooking> {
    const bookingId = claim.booking.id;
    try {
      const reply = await this.amadeus.getFlightOrder(
        this.callContext(tenant, bookingId, OPERATIONS.issue, claim.booking.ownerOfficeId),
        { flightOrderId: claim.orderId },
      );
      const order = readCreatedOrder(reply.body);
      if (order !== undefined && ticketCoverage(order.travelerIds, order.tickets) !== "none") {
        await this.tx.run((trx) =>
          this.recordIssue(trx, tenant, claim, body, order, {
            via: "resync",
            supplierRequestId: reply.call.supplierRequestId,
          }),
        );
        this.logger.info({ bookingId }, "console.bookings.issue_found_after_unknown");
        return await this.consoleBookings.get(bookingId, { refresh: false });
      }
    } catch (readError) {
      this.logger.warn({ bookingId, code: codeOf(readError) }, "console.bookings.issue_resync_failed");
    }
    await this.releaseIssue(tenant, claim, codeOf(error));
    throw issueAnswerOf(error);
  }

  /**
   * The booking locked again (`FOR UPDATE`) when it still holds this issuance's claim (`in_progress` with the claim's
   * `ticketing_last_attempt_at`, still issuable), else `undefined`.
   */
  private async fencedIssue(
    trx: TenantTransaction,
    claim: IssueClaim,
  ): Promise<TicketingBookingRow | undefined> {
    const current = await this.ticketing.lock(trx, claim.booking.id, { skipLocked: false });
    if (
      current === undefined ||
      !ISSUABLE_STATUSES.has(current.status) ||
      current.ticketingStatus !== "in_progress" ||
      current.ticketingLastAttemptAt?.getTime() !== claim.claimedAt.getTime()
    ) {
      this.logger.warn(
        { bookingId: claim.booking.id, version: current?.version },
        "console.bookings.issue_claim_lost",
      );
      return undefined;
    }
    return current;
  }

  /** T2 of an issuance with tickets (see the file header): the job's result step and the `booking.issue` staff action. */
  private async recordIssue(
    trx: TenantTransaction,
    tenant: RequestTenant,
    claim: IssueClaim,
    body: ConsoleIssueRequest,
    order: CreatedOrder,
    via: { readonly via: "issue" | "resync"; readonly supplierRequestId: string | null },
  ): Promise<void> {
    const now = this.clock.now();
    const current = await this.fencedIssue(trx, claim);
    const recorded =
      current === undefined
        ? undefined
        : await recordIssuedTickets(
            trx,
            { bookings: this.bookings, recorder: this.recorder },
            current,
            order,
            {
              actor: eventActorOf(tenant.actor),
              summary:
                via.via === "resync"
                  ? "E-tickets issued by the travel agency (found at the airline and recorded)."
                  : "E-tickets issued by the travel agency.",
              data: {
                tickets: order.tickets.map((ticket) => ticket.documentNumber),
                via: via.via === "resync" ? "console_resync" : "console",
              },
              supplierRequestId: via.supplierRequestId,
              requestId: this.requestId(tenant),
              now,
              notifyCustomer: body.notifyCustomer !== false,
            },
          );
    await this.audit.record(trx, {
      action: CONSOLE_BOOKING_ACTIONS.issue,
      targetType: "booking",
      targetId: claim.booking.id,
      bookingId: claim.booking.id,
      reason: body.reason ?? null,
      before: {
        status: claim.booking.status,
        ticketingStatus: claim.booking.ticketingStatus,
        version: claim.booking.version,
        payment: claim.payment.kind,
      },
      after: {
        status: recorded?.status ?? current?.status ?? null,
        ticketingStatus: recorded?.ticketingStatus ?? null,
        tickets: order.tickets.length,
        via: via.via,
        captured: claim.payment.kind === "capture" && body.capturePayment !== false,
        allowUnpaid: claim.payment.kind === "unpaid",
        formOfPayments: redactPayload(body.formOfPayments ?? "default"),
        notifyCustomer: body.notifyCustomer !== false,
        ...(recorded === undefined ? { claimLost: true } : {}),
      },
    });
  }

  /**
   * Releases an issuance's claim that issued nothing (see the file header), fenced by the claim: the ticketing status it
   * found (an abandoned `in_progress` as `failed`) and its next attempt, the error, and a staff-only
   * `booking.ticketing_failed` event. Never throws: a release that fails is logged (an `in_progress` claim older than 5
   * minutes is abandoned and taken over).
   */
  private async releaseIssue(tenant: RequestTenant, claim: IssueClaim, code: string): Promise<void> {
    try {
      await this.tx.run(async (trx) => {
        const now = this.clock.now();
        const current = await this.fencedIssue(trx, claim);
        if (current === undefined) {
          return;
        }
        const previous = claim.booking.ticketingStatus;
        await this.bookings.updateBooking(trx, current.id, {
          ticketing_status: previous === "in_progress" ? "failed" : previous,
          ticketing_next_attempt_at: previous === "in_progress" ? null : claim.booking.ticketingNextAttemptAt,
          ticketing_error_code: code,
          ticketing_error: `Staff issuance failed: ${code}`,
          updated_at: now,
        });
        await this.recorder.event(trx, current.id, {
          type: "booking.ticketing_failed",
          actor: eventActorOf(tenant.actor),
          statusFrom: current.status,
          statusTo: current.status,
          summary: "The travel agency's issuance did not issue the tickets.",
          data: { via: "console", code },
          visibleToCustomer: false,
          requestId: this.requestId(tenant),
          now,
        });
      });
    } catch (error) {
      this.logger.error({ bookingId: claim.booking.id, err: error }, "console.bookings.issue_release_failed");
    }
  }

  // ---- console.bookings.cancel (OBE-063) ---------------------------------------------------------------------------

  /** Cancels the booking for the staff (see the file header); answers the booking. */
  async cancel(bookingId: string, ifMatch: string, body: ConsoleCancelRequest): Promise<ConsoleBooking> {
    const outcome = await this.cancellations.cancelByStaff(
      bookingId,
      ifMatch,
      {
        reasonCode: body.reasonCode,
        reason: body.reason,
        refund: body.refund,
        notifyCustomer: body.notifyCustomer,
      },
      (trx, record) => this.recordCancel(trx, bookingId, record),
    );
    const booking = await this.consoleBookings.get(bookingId, { refresh: false });
    return outcome.orderNotFound
      ? { ...booking, warnings: [...(booking.warnings ?? []), { ...ORDER_GONE_WARNING }] }
      : booking;
  }

  /** The `booking.cancel` staff action, in the record step's transaction (redacted before and after). */
  private async recordCancel(
    trx: TenantTransaction,
    bookingId: string,
    record: StaffCancelRecord,
  ): Promise<void> {
    const { money, ask } = record;
    await this.audit.record(trx, {
      action: CONSOLE_BOOKING_ACTIONS.cancel,
      targetType: "booking",
      targetId: bookingId,
      bookingId,
      reason: ask.staff?.reason ?? null,
      before: {
        status: record.before.status,
        version: record.before.version,
        amountPaid: record.before.amountPaid,
      },
      after: {
        status: "cancelled",
        reasonCode: ask.reasonCode,
        cause: record.cause,
        ticketsVoided: record.ticketsVoided,
        refundMode: record.before.refundMode,
        refund: { amount: ask.estimate.estimatedRefund, currency: ask.currency },
        refundStatus: money.refundStatus,
        ...(money.refund === null ? {} : { refundId: money.refund.id }),
        ...(money.voidPayment === null ? {} : { voidPaymentId: money.voidPayment.id }),
        ...(money.capture === null
          ? {}
          : { capturePaymentId: money.capture.payment.id, captureAmount: money.capture.amount }),
        notifyCustomer: ask.staff?.notifyCustomer ?? true,
      },
    });
  }

  /**
   * The answer of a same-key replay of console.bookings.cancel's stored `504` (ConsoleCancelBookingIdempotencyHooks),
   * from the booking (never an Amadeus call): the same `504` while the worker has not decided, then the booking (`200`)
   * or the final error.
   */
  async replayCancel(record: IdempotencyRecord): Promise<IdempotencyResponse | undefined> {
    if (record.resource?.type !== "booking" || record.response.status !== 504) {
      return undefined;
    }
    const bookingId = record.resource.id;
    const decided = await this.cancellations.decideReplay(bookingId, "staff");
    if (decided === undefined) {
      return undefined;
    }
    if (decided.kind === "undecided") {
      return replayedTimeout(record.response);
    }
    if (decided.kind === "error") {
      return this.cancellations.errorReplay(decided.error);
    }
    const booking = await this.consoleBookings.get(bookingId, { refresh: false });
    this.logger.info({ bookingId }, "console.bookings.cancel_replayed");
    return {
      status: 200,
      headers: { etag: bookingEtagOf(booking.version), "cache-control": CONSOLE_BOOKING_CACHE_CONTROL },
      setCookie: [],
      body: booking,
    };
  }

  // ---- Shared ------------------------------------------------------------------------------------------------------

  /** The booking of the request's environment (`lock`: `FOR UPDATE`); another environment's or none is a 404. */
  private async bookingOfEnvironment(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    lock = false,
  ): Promise<BookingRow> {
    const booking = await this.bookings.booking(trx, bookingId, lock);
    if (booking === undefined || booking.environment !== tenant.environment) {
      throw new AppError("NOT_FOUND");
    }
    return booking;
  }

  /** The booking's Amadeus order id; a pending or failed booking has none (`409 BOOKING_NOT_MODIFIABLE`). */
  private requireOrder(booking: BookingRow): string {
    if (booking.amadeusOrderId === null || booking.status === "pending" || booking.status === "failed") {
      throw new AppError("BOOKING_NOT_MODIFIABLE", {
        message: "The booking has no Amadeus order.",
        details: { status: booking.status },
      });
    }
    return booking.amadeusOrderId;
  }

  /** `412 PRECONDITION_FAILED` unless `ifMatch` names the booking's version. */
  private requireVersion(booking: BookingRow, ifMatch: string): void {
    if (!ifMatchSatisfied(ifMatch, booking.version)) {
      throw new AppError("PRECONDITION_FAILED", { details: { currentVersion: booking.version } });
    }
  }

  private staffId(): string | null {
    return this.staff.get()?.family.staffId ?? null;
  }

  private callContext(
    tenant: RequestTenant,
    bookingId: string,
    operation: string,
    office: string | null,
  ): AmadeusCallContext {
    return {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation,
      requestId: this.requestId(tenant),
      bookingId,
      ...(tenant.actor.type === "staff" && tenant.actor.id !== null ? { staffId: tenant.actor.id } : {}),
      ...(office === null ? {} : { orderOffice: office }),
    };
  }

  private requestId(tenant: RequestTenant): string {
    return this.tenants.requestId() ?? tenant.requestId;
  }
}

/** The stored value of an element sent as given (a patch's before). */
function storedElementOf(
  element: AmadeusPatchElement,
  booking: BookingRow,
  details: ConsoleBookingDetailsRow,
): unknown {
  switch (element) {
    case "formOfPayments":
      return details.formOfPayments;
    case "ticketingAgreement":
      return details.ticketingAgreement;
    case "automatedProcess":
      return details.automatedProcess;
    case "commissions":
      return details.commissions;
    case "formOfIdentifications":
      return maskedIdentifications(details.formOfIdentifications);
    case "queuingOfficeId":
      return booking.queuingOfficeId;
    case "ownerOfficeId":
      return booking.ownerOfficeId;
    case "travelers":
    case "contacts":
    case "remarks":
      // Merged with the stored order: preparePatch reads them itself.
      return null;
  }
}

/** The `booking_contacts` row of a projected contact, one millisecond apart from the previous (no position column). */
function contactRowOf(
  id: string,
  bookingId: string,
  contact: ContactValues,
  now: Date,
  index: number,
): Insertable<Db["booking_contacts"]> {
  return {
    id,
    booking_id: bookingId,
    purpose: contact.purpose,
    is_primary: contact.isPrimary,
    first_name: contact.firstName,
    last_name: contact.lastName,
    company_name: contact.companyName,
    email: contact.email,
    phones: JSON.stringify(contact.phones),
    address: contact.address === null ? null : JSON.stringify(contact.address),
    language: contact.language,
    created_at: new Date(now.getTime() + index),
    updated_at: now,
  };
}

/**
 * The idempotency hooks of console.bookings.cancel (as CancelBookingIdempotencyHooks of bookings.cancel): a `504
 * SUPPLIER_TIMEOUT` of a DELETE without an answer is linked to its booking and kept, and its same-key replays are
 * answered from the booking (`ConsoleBookingActionsService.replayCancel`): the same `504` until the worker decides,
 * then the booking or the final error.
 */
@Injectable()
@IdempotencyHooksFor(["consoleCancelBooking"])
export class ConsoleCancelBookingIdempotencyHooks implements IdempotencyHooks {
  constructor(private readonly actions: ConsoleBookingActionsService) {}

  resourceOf(response: IdempotencyResponse): IdempotencyResource | undefined {
    return pendingBookingOf(response);
  }

  resolveReplay(record: IdempotencyRecord): Promise<IdempotencyResponse | undefined> {
    return this.actions.replayCancel(record);
  }
}
