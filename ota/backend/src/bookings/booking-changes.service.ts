// bookings.update (updateBooking, `x-scope: customer`; OBE-048, OF-08 AC1; ota/docs/flows/change-and-cancel.md §1, §3
// steps 1–2, §4): what the owning customer, or the guest holding the booking's token, changes of a booking after it
// was made. The booking access guard let the request in (`BookingAccessContext.require`); the validation interceptor
// checked the body against BookingUpdateRequest. In the MVP only `contacts` and `remarks` are applied:
//
//   - `travelers` (documents, contact, emergency contact, loyalty programmes) answers `403 FEATURE_DISABLED`
//     (`details.feature = "travelerChanges"`) before anything is read or sent (allowed-actions.ts TRAVELER_CHANGES);
//   - T1 (the booking locked `FOR UPDATE`, nothing written): `If-Match` (`412 PRECONDITION_FAILED` when stale), a
//     cancelled booking (`409 BOOKING_ALREADY_CANCELLED`), the allowed action of each element (`canModifyContacts`,
//     `canAddRemarks`; `409 BOOKING_NOT_MODIFIABLE` with `details.reason` and `details.action`), the contacts as
//     checkout.setContacts checks them with the contact requirements of the booked priced offer while it exists (exactly
//     one primary STANDARD contact with an e-mail; `422 CONTACT_DATA_INVALID` with `fieldErrors`), and the remarks
//     (`400 VALIDATION_FAILED`: a text of blanks only, which the document's pattern lets through and Amadeus would get
//     empty, or a traveller id the booking does not have). Then the PATCH `data`: the order's flight offers by id (the
//     specification requires the element; an id adds no service), the full contacts list (Amadeus replaces it;
//     `isPrimary` is the OTA's, never sent), and the order's whole `remarks` element (Amadeus replaces it
//     too: the stored general and airline remarks, the `VELEXIS <reference>` back-office remark always among them)
//     with each new special request upper-cased as GENERAL_MISCELLANEOUS; a special request the order already has (same
//     text and travellers) is not added twice, so a retry after a timeout adds nothing. A request that changes nothing
//     (no contacts, every remark already there) makes no Amadeus call and answers the booking as it is.
//   - Flight Order Management PATCH with no transaction open (OADR-0003 point 1). Amadeus 2552 answers
//     `409 VERSION_CONFLICT` and nothing changes locally; a refusal pointing at `/data/contacts` becomes
//     `422 CONTACT_DATA_INVALID` with `fieldErrors`; the codes the operation documents pass, any other becomes
//     `502 SUPPLIER_ERROR`. A failure that leaves the outcome unknown (OADR-0003 points 7 and 9: the change may have
//     been applied) is followed by a resync (CustomerBookingsService.refresh without its throttle: one GET, the
//     snapshot) and the record step on the order read (below, "resynced"), then answered with its error: a timeout
//     (`504 SUPPLIER_TIMEOUT`, the contract's case), and as for Flight Create Orders any other answer once the request
//     may have reached Amadeus that does not prove a refusal (an Amadeus `5xx`, a cut connection: `502`/`503`). A retry
//     with the old `If-Match` is stale once the change was found, and adds no special request twice when it was not.
//   - T2, the record (the booking locked again): the answer's contacts replace `booking_contacts` when they differ (the
//     primary one is the contact with the requested primary e-mail) and the primary e-mail becomes `contact_email`
//     (guest lookup, notifications); each new special request becomes a `booking_remarks` row visible to the customer;
//     the answer becomes `order_snapshot` after the shared redactor, with `order_dictionaries` and `last_synced_at`
//     (when another writer changed the booking since T1, only the answer's contacts and remarks are merged into the
//     stored snapshot: the rest of the answer may be older than that write); `version + 1`; the customer-visible events
//     `booking.contacts_updated` and `booking.remark_added`, one millisecond apart in that order (OrderRecorder.event;
//     their data holds counts, never an address); and, when the contacts changed, a confirmation e-mail of the booking
//     as it is now to the new primary address and to the previous `contact_email` when it differs (dedupe keys
//     `booking.contacts_updated:<bkg_…>:v<version>:new|old`). OADR-0013 point 4 has no template key of its own for a
//     contacts change: the confirmation is `booking.confirmed`, the MVP key that confirms a booking to its traveller.
//     After an unknown outcome ("resynced") only what the order read shows of the requested change is recorded:
//     contacts equal to those sent, special requests sent that the order has (the events' data says
//     `cause: resync_after_timeout`, or `resync_after_supplier_error` after another unknown outcome); nothing else, and
//     nothing at all (no version, event or e-mail) when the change is not there.
//
// The answer is the booking in customer scope (CustomerBookingsService.get) with its new `ETag`. Only the booking row
// is locked (the lock order of OADR-0003 point 11 starts with the checkout, which this does not touch); the event and
// outbox rows' foreign-key locks come after it.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import type { Insertable, TenantDatabase } from "@velexis/db";
import { AppError, isAppError, type FieldError, type OtaErrorCode } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AmadeusClient, type PatchFlightOrderRequest } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { AmadeusCallError } from "../amadeus/error-mapper";
import { ifMatchSatisfied } from "../checkout/checkout.mapper";
import {
  contactErrors,
  MAX_CONTACTS,
  MAX_FIELD_ERRORS,
  primaryIndexOf,
  type CheckoutContactRequirements,
} from "../checkout/requirements";
import { BookingAccessContext } from "../common/auth/booking-access.guard";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import type { SharedConfig } from "../config";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { storefrontUrl } from "../notifications/renderer";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { allowedActionsOf, type ActionReason, type BookingAction } from "./allowed-actions";
import { createFailureKind } from "./booking-orchestrator.service";
import { VELEXIS_REMARK_PREFIX, velexisRemarkText } from "./booking-reference";
import {
  BookingsRepository,
  type BookingChildren,
  type BookingContactRow,
  type BookingRemarkRow,
  type BookingRow,
} from "./bookings.repository";
import { CustomerBookingsService } from "./customer-bookings.service";
import { eventActorOf, OrderRecorder, type Booking } from "./order-recorder";
import { SPECIAL_REQUEST_SUBTYPE, VELEXIS_REMARK_SUBTYPE } from "./order-request.builder";

type Schemas = components["schemas"];
export type BookingUpdateRequest = Schemas["BookingUpdateRequest"];
type ContactInput = Schemas["ContactInput"];
type RemarkInput = Schemas["RemarkInput"];
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

/** `supplier_requests.operation` of the PATCH and of the resync after a timeout. */
export const UPDATE_OPERATION = "bookings.update";

/** `details.feature` of the refusal of traveller changes (`403 FEATURE_DISABLED`). */
export const TRAVELER_CHANGES_FEATURE = "travelerChanges";

/** The customer-visible events of an update (the contract's names). */
export const CONTACTS_UPDATED_EVENT = "booking.contacts_updated";
export const REMARK_ADDED_EVENT = "booking.remark_added";

/** The confirmation e-mail of a contacts change (see the file header). */
export const CONTACTS_CONFIRMATION_TEMPLATE = "booking.confirmed";

/** The prefix of the confirmation's dedupe keys: `booking.contacts_updated:<bkg_…>:v<version>:new|old`. */
export const CONTACTS_CONFIRMATION_DEDUPE = "booking.contacts_updated";

/**
 * The client's errors bookings.update passes on: the codes its operation documents (`x-error-codes`); any other
 * becomes `502 SUPPLIER_ERROR` (a refusal pointing at the contacts becomes `422 CONTACT_DATA_INVALID` first).
 */
const DOCUMENTED_SUPPLIER_CODES: ReadonlySet<string> = new Set<OtaErrorCode>([
  "VERSION_CONFLICT",
  "TRAVELER_DATA_INVALID",
  "CONTACT_DATA_INVALID",
  "SUPPLIER_NOT_CONFIGURED",
  "RATE_LIMITED",
  "SUPPLIER_ERROR",
  "SERVICE_UNAVAILABLE",
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_TIMEOUT",
]);

/** The contact purposes `booking_contacts_purpose` accepts. */
const CONTACT_PURPOSES: ReadonlySet<string> = new Set([
  "STANDARD",
  "INVOICE",
  "STANDARD_WITHOUT_TRANSMISSION",
]);

/** A BCP 47 tag the outbox accepts as a locale (outbox.service.ts). */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

// ---- Pure rules -----------------------------------------------------------------------------------------------------

/** `403 FEATURE_DISABLED` for a request that changes travellers: not offered in the MVP (see the file header). */
export function refuseTravelerChanges(body: BookingUpdateRequest): void {
  if (body.travelers !== undefined) {
    throw new AppError("FEATURE_DISABLED", {
      message: "Traveller details cannot be changed online: please contact the travel agency.",
      details: { feature: TRAVELER_CHANGES_FEATURE },
    });
  }
}

/**
 * The contact requirements of a booking: those of its booked priced offer's `bookingRequirements` (the checkout's,
 * requirements.ts `requirementsOf`), or the base ones (a primary e-mail) once the priced offer is gone.
 */
export function contactRequirementOf(bookingRequirements: unknown): CheckoutContactRequirements {
  const source = isRecord(bookingRequirements) ? bookingRequirements : {};
  return {
    emailRequired: true,
    mobilePhoneRequired: source["mobilePhoneNumberRequired"] === true,
    phoneRequired: source["phoneNumberRequired"] === true,
    phoneCountryCodeRequired: source["phoneCountryCodeRequired"] === true,
    invoiceAddressRequired: source["invoiceAddressRequired"] === true,
    mailingAddressRequired: source["mailingAddressRequired"] === true,
    postalCodeRequired: source["postalCodeRequired"] === true,
    maxContacts: MAX_CONTACTS,
  };
}

/**
 * The `400 VALIDATION_FAILED` field errors of remarks: a text of blanks only (the document's pattern allows spaces, and
 * the text is trimmed before it is sent, so Amadeus would get an empty remark), or a traveller the booking does not
 * have.
 */
export function remarkInputErrors(
  remarks: readonly RemarkInput[],
  travelerIds: ReadonlySet<string>,
): FieldError[] {
  return remarks
    .flatMap((remark, index): FieldError[] => [
      ...(remark.text.trim() === ""
        ? [
            {
              path: `/remarks/${index}/text`,
              code: "minLength",
              message: "Enter the text of the request.",
            },
          ]
        : []),
      ...(remark.travelerIds ?? []).flatMap((travelerId, position) =>
        travelerIds.has(travelerId)
          ? []
          : [
              {
                path: `/remarks/${index}/travelerIds/${position}`,
                code: "enum",
                message: "This traveller is not part of the booking.",
              },
            ],
      ),
    ])
    .slice(0, MAX_FIELD_ERRORS);
}

/**
 * True when a failed PATCH may have been applied (OADR-0003 points 7 and 9): a timeout, or any other answer once the
 * request may have reached Amadeus that does not prove a refusal (an Amadeus `5xx`, a cut connection, an answer that
 * cannot be read; `createFailureKind` of Flight Create Orders). A `4xx` refusal (2552 included) and an error raised
 * before the request left the backend changed nothing.
 */
export function patchOutcomeUnknown(error: unknown): boolean {
  return (isAppError(error) && error.code === "SUPPLIER_TIMEOUT") || createFailureKind(error) === "unknown";
}

/** The Amadeus contacts of a request's contacts: the fields the specification declares, without the OTA's `isPrimary`. */
export function amadeusContactsOf(contacts: readonly ContactInput[]): JsonObject[] {
  return contacts.map((contact) => {
    const entry: JsonObject = { purpose: contact.purpose ?? "STANDARD" };
    for (const field of [
      "addresseeName",
      "companyName",
      "emailAddress",
      "phones",
      "address",
      "language",
    ] as const) {
      if (contact[field] !== undefined) {
        entry[field] = structuredClone(contact[field]);
      }
    }
    return entry;
  });
}

/** A special request to add: upper-cased as Amadeus stores it, with its distinct travellers. */
export interface NewRemark {
  readonly text: string;
  readonly travelerIds: readonly string[];
}

/** The identity of a special request: its text in upper case and its travellers, sorted. */
const remarkKey = (remark: { readonly text: string; readonly travelerIds: readonly string[] }): string =>
  `${remark.text.trim().toUpperCase()}|${[...remark.travelerIds].sort().join(",")}`;

/** The special requests (GENERAL_MISCELLANEOUS) of an Amadeus `remarks` element. */
function orderSpecialRequests(remarks: unknown): NewRemark[] {
  const element = isRecord(remarks) ? remarks : {};
  return records(element["general"]).flatMap((remark) => {
    const body = text(remark["text"]);
    return remark["subType"] === SPECIAL_REQUEST_SUBTYPE && body !== undefined
      ? [{ text: body, travelerIds: strings(remark["travelerIds"]) }]
      : [];
  });
}

/**
 * The order's `remarks` element as the booking knows it: the snapshot's when it has one, else the general remarks of
 * `booking_remarks` (subtype, text, travellers).
 */
export function storedRemarksOf(snapshot: unknown, rows: readonly BookingRemarkRow[]): JsonObject {
  if (isRecord(snapshot) && isRecord(snapshot["remarks"])) {
    return snapshot["remarks"];
  }
  return {
    general: rows
      .filter((row) => row.kind === "general")
      .map((row) => ({
        subType: row.subType,
        text: row.text,
        ...(row.travelerIds.length > 0 ? { travelerIds: [...row.travelerIds] } : {}),
      })),
  };
}

/** The special requests of a request that the order does not have yet, upper-cased, each once (see the file header). */
export function newRemarksOf(stored: JsonObject, sent: readonly RemarkInput[]): NewRemark[] {
  const seen = new Set(orderSpecialRequests(stored).map(remarkKey));
  const added: NewRemark[] = [];
  for (const remark of sent) {
    const entry: NewRemark = {
      text: remark.text.trim().toUpperCase(),
      travelerIds: [...new Set(remark.travelerIds ?? [])],
    };
    const key = remarkKey(entry);
    if (!seen.has(key)) {
      seen.add(key);
      added.push(entry);
    }
  }
  return added;
}

/** True for the `VELEXIS <reference>` back-office remark of an Amadeus `remarks.general` entry. */
const isVelexisRemark = (remark: JsonObject): boolean =>
  remark["subType"] === VELEXIS_REMARK_SUBTYPE &&
  (text(remark["text"]) ?? "").startsWith(`${VELEXIS_REMARK_PREFIX} `);

/**
 * The `remarks` element of the PATCH: the stored general remarks, the new special requests and the stored airline
 * remarks; the `VELEXIS <reference>` remark is added back when the stored element lost it.
 */
export function patchRemarksOf(
  stored: JsonObject,
  added: readonly NewRemark[],
  reference: string,
): JsonObject {
  const general = records(stored["general"]).map((remark) => ({ ...remark }));
  general.push(
    ...added.map((remark) => ({
      subType: SPECIAL_REQUEST_SUBTYPE,
      text: remark.text,
      ...(remark.travelerIds.length > 0 ? { travelerIds: [...remark.travelerIds] } : {}),
    })),
  );
  if (!general.some(isVelexisRemark)) {
    general.push({ subType: VELEXIS_REMARK_SUBTYPE, text: velexisRemarkText(reference) });
  }
  const airline = records(stored["airline"]).map((remark) => ({ ...remark }));
  return { general, ...(airline.length > 0 ? { airline } : {}) };
}

/** The order's flight offers named by id only: the snapshot's, else the booking's segments' (`"1"` when none). */
export function flightOfferRefsOf(snapshot: unknown, segments: BookingChildren["segments"]): JsonObject[] {
  const fromSnapshot = isRecord(snapshot)
    ? records(snapshot["flightOffers"]).flatMap((offer) => text(offer["id"]) ?? [])
    : [];
  const ids =
    fromSnapshot.length > 0
      ? fromSnapshot
      : [...new Set(segments.map((segment) => segment.amadeusFlightOfferId))];
  return (ids.length > 0 ? ids : ["1"]).map((id) => ({ type: "flight-offer", id }));
}

/** A contact as `booking_contacts` stores it (without its id and times). */
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
 * The booking contacts of an order's contacts. The primary one is the STANDARD contact with `primaryEmail` (the
 * request's primary contact), else the first STANDARD contact with an e-mail, else the first with an e-mail, else the
 * first.
 */
export function contactValuesOf(
  contacts: readonly JsonObject[],
  primaryEmail: string | null,
): ContactValues[] {
  const values = contacts.map((contact): ContactValues => {
    const name = isRecord(contact["addresseeName"]) ? contact["addresseeName"] : {};
    const purpose = text(contact["purpose"]) ?? "STANDARD";
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
  const wanted = primaryEmail?.toLowerCase();
  const primary = [
    values.findIndex(
      (value) =>
        value.purpose === "STANDARD" && wanted !== undefined && value.email?.toLowerCase() === wanted,
    ),
    values.findIndex((value) => value.purpose === "STANDARD" && value.email !== null),
    values.findIndex((value) => value.email !== null),
    0,
  ].find((index) => index >= 0);
  return values.map((value, index) => ({ ...value, isPrimary: index === primary }));
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

/** The identity of a contact for `contactsMatch`: purpose, e-mail (any case), names (any case) and phone numbers. */
function contactKey(contact: JsonObject): string {
  const name = isRecord(contact["addresseeName"]) ? contact["addresseeName"] : {};
  const phones = records(contact["phones"])
    .map((phone) => `${text(phone["countryCallingCode"]) ?? ""}${text(phone["number"]) ?? ""}`)
    .sort();
  return [
    text(contact["purpose"]) ?? "STANDARD",
    (text(contact["emailAddress"]) ?? "").toLowerCase(),
    (text(name["firstName"]) ?? "").toUpperCase(),
    (text(name["lastName"]) ?? "").toUpperCase(),
    phones.join(","),
  ].join("|");
}

/** True when an order's contacts are the contacts a request sent (in any order): the PATCH was applied. */
export function contactsMatch(order: readonly JsonObject[], sent: readonly JsonObject[]): boolean {
  const left = order.map(contactKey).sort();
  const right = sent.map(contactKey).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** True when an order's `remarks` element holds the special request `remark`. */
export function orderHasRemark(remarks: unknown, remark: NewRemark): boolean {
  const key = remarkKey(remark);
  return orderSpecialRequests(remarks).some((entry) => remarkKey(entry) === key);
}

/** True when the booking has a special request row equal to `remark`. */
function rowsHaveRemark(rows: readonly BookingRemarkRow[], remark: NewRemark): boolean {
  const key = remarkKey(remark);
  return rows.some(
    (row) =>
      row.kind === "general" &&
      row.subType === SPECIAL_REQUEST_SUBTYPE &&
      remarkKey({ text: row.text, travelerIds: row.travelerIds }) === key,
  );
}

/**
 * The snapshot after a PATCH answered `reply`: the answer itself, or, when another writer changed the booking since
 * T1 (`merge`), the stored snapshot with the answer's contacts and remarks only (see the file header).
 */
export function snapshotAfter(
  stored: unknown,
  reply: JsonObject,
  merge: boolean,
  elements: { readonly contacts: boolean; readonly remarks: boolean },
): JsonObject {
  if (!merge) {
    return redactPayload(reply);
  }
  const snapshot: JsonObject = isRecord(stored) ? { ...stored } : {};
  if (elements.contacts && reply["contacts"] !== undefined) {
    snapshot["contacts"] = reply["contacts"];
  }
  if (elements.remarks && reply["remarks"] !== undefined) {
    snapshot["remarks"] = reply["remarks"];
  }
  return redactPayload(snapshot);
}

/** The OTA path of an Amadeus pointer into the contacts of a request (`/data/contacts/0/emailAddress`), or none. */
function contactPath(pointer: unknown): string | undefined {
  if (typeof pointer !== "string") {
    return undefined;
  }
  const match = /^\/data(\/contacts(?:\/.*)?)$/.exec(pointer.replace(/\[(\d+)\]/g, "/$1"));
  return match?.[1];
}

/**
 * The answer of a failed PATCH (see the file header): Amadeus's refusal of the contacts becomes
 * `422 CONTACT_DATA_INVALID` with one field error per issue pointing at them; the codes bookings.update documents pass;
 * any other becomes `502 SUPPLIER_ERROR`.
 */
export function updateErrorOf(error: unknown): unknown {
  if (!isAppError(error)) {
    return error;
  }
  if (error.code === "SUPPLIER_REJECTED" && error.cause instanceof AmadeusCallError) {
    const fieldErrors = error.cause.issues.flatMap((issue): FieldError[] => {
      const path = contactPath(issue.source?.pointer);
      return path === undefined
        ? []
        : [{ path, code: "invalid", ...(issue.title === undefined ? {} : { message: issue.title }) }];
    });
    if (fieldErrors.length > 0) {
      return new AppError("CONTACT_DATA_INVALID", {
        message: "The airline did not accept the contact details.",
        fieldErrors: fieldErrors.slice(0, MAX_FIELD_ERRORS),
        ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
        cause: error,
      });
    }
  }
  if (DOCUMENTED_SUPPLIER_CODES.has(error.code)) {
    return error;
  }
  return new AppError("SUPPLIER_ERROR", {
    ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
    cause: error,
  });
}

/** `409 BOOKING_NOT_MODIFIABLE` for an action the booking does not allow, with its reason. */
function notModifiable(action: BookingAction, reason: ActionReason): AppError {
  return new AppError("BOOKING_NOT_MODIFIABLE", {
    message:
      reason === "flown"
        ? "This trip is over: the booking can no longer be changed online."
        : "The booking cannot be changed online right now.",
    details: { reason, action },
  });
}

// ---- The repository -------------------------------------------------------------------------------------------------

/**
 * What bookings.update writes and reads besides BookingsRepository: the booking's contacts replaced, its new special
 * requests, and the contact requirements of its booked priced offer. Like every tenant repository it takes the
 * `tenantTx` transaction first and never names a tenant schema.
 */
@Injectable()
export class BookingChangesRepository {
  /** The `bookingRequirements` of the priced offer `pricedOfferId` (`undefined` once it is purged). */
  async bookingRequirements(trx: TenantTransaction, pricedOfferId: string): Promise<unknown> {
    const row = await trx
      .selectFrom("priced_offers")
      .select("booking_requirements as bookingRequirements")
      .where("id", "=", pricedOfferId)
      .executeTakeFirst();
    return row?.bookingRequirements ?? undefined;
  }

  /** Replaces the contacts of the booking `bookingId` with `rows` (the primary one is unique per booking). */
  async replaceContacts(
    trx: TenantTransaction,
    bookingId: string,
    rows: readonly Insertable<Db["booking_contacts"]>[],
  ): Promise<void> {
    await trx.deleteFrom("booking_contacts").where("booking_id", "=", bookingId).execute();
    if (rows.length > 0) {
      await trx
        .insertInto("booking_contacts")
        .values([...rows])
        .execute();
    }
  }

  /** Inserts remarks of a booking. */
  async insertRemarks(
    trx: TenantTransaction,
    rows: readonly Insertable<Db["booking_remarks"]>[],
  ): Promise<void> {
    if (rows.length > 0) {
      await trx
        .insertInto("booking_remarks")
        .values([...rows])
        .execute();
    }
  }
}

// ---- The service ----------------------------------------------------------------------------------------------------

/** What T1 read and built. */
interface PreparedUpdate {
  readonly bookingId: string;
  readonly orderId: string;
  readonly office: string | null;
  /** The booking's `version` at T1. */
  readonly version: number;
  /** The Flight Order Management PATCH `data`. */
  readonly data: JsonObject;
  /** The Amadeus contacts sent, or `undefined` when the request has none. */
  readonly contacts: JsonObject[] | undefined;
  /** The e-mail of the request's primary contact. */
  readonly primaryEmail: string | null;
  /** The special requests sent that the order did not have; empty without remarks. */
  readonly remarks: readonly NewRemark[];
}

/** Why the order was read back after a failed PATCH (the events' `data.cause`). */
type ResyncCause = "resync_after_timeout" | "resync_after_supplier_error";

/**
 * Where the order a record step projects comes from: the PATCH's answer (`patched`), or the order read back after an
 * unknown outcome (a ResyncCause: "resynced" in the file header).
 */
type RecordCause = "patched" | ResyncCause;

/** A contact row of a projected contact, one millisecond apart from the previous (the table has no position column). */
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

@Injectable()
export class BookingChangesService {
  private readonly baseDomain: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly bookings: BookingsRepository,
    private readonly repository: BookingChangesRepository,
    private readonly recorder: OrderRecorder,
    private readonly customerBookings: CustomerBookingsService,
    private readonly amadeus: AmadeusClient,
    private readonly outbox: OutboxService,
    private readonly tenants: TenantContext,
    private readonly access: BookingAccessContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    config: ConfigService<SharedConfig, true>,
    @InjectPinoLogger(BookingChangesService.name) private readonly logger: PinoLogger,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** bookings.update (see the file header); answers the booking in customer scope. */
  async update(bookingId: string, ifMatch: string, body: BookingUpdateRequest): Promise<Booking> {
    this.access.require(bookingId);
    refuseTravelerChanges(body);
    const tenant = this.tenants.require();
    const prepared = await this.tx.run((trx) => this.prepare(trx, tenant, bookingId, ifMatch, body));
    if (prepared === undefined) {
      // Nothing to change: every special request is in the order already.
      return await this.customerBookings.get(bookingId, { refresh: false });
    }
    let reply;
    try {
      reply = await this.amadeus.patchFlightOrder(this.callContext(tenant, bookingId, prepared.office), {
        flightOrderId: prepared.orderId,
        // Built from the validated request and the stored order (see prepare), as JSON.
        body: { data: prepared.data } as unknown as PatchFlightOrderRequest["body"],
      });
    } catch (error) {
      if (patchOutcomeUnknown(error)) {
        // The change may have been applied at Amadeus: read the order back before answering.
        await this.resyncAfterUnknownOutcome(
          tenant,
          prepared,
          isAppError(error) && error.code === "SUPPLIER_TIMEOUT"
            ? "resync_after_timeout"
            : "resync_after_supplier_error",
        );
      }
      throw updateErrorOf(error);
    }
    const replyBody: unknown = reply.body;
    const replyData = isRecord(replyBody) && isRecord(replyBody["data"]) ? replyBody["data"] : undefined;
    if (replyData === undefined) {
      // A 2xx without an order: the change happened, what Amadeus holds is unknown here.
      await this.resyncAfterUnknownOutcome(tenant, prepared, "resync_after_supplier_error");
      throw new AppError("SUPPLIER_ERROR");
    }
    await this.tx.run((trx) =>
      this.record(trx, tenant, prepared, "patched", {
        data: replyData,
        dictionaries: isRecord(replyBody) ? replyBody["dictionaries"] : undefined,
        supplierRequestId: reply.call.supplierRequestId,
      }),
    );
    return await this.customerBookings.get(bookingId, { refresh: false });
  }

  /**
   * T1 (see the file header): the checks and the PATCH data; `undefined` when the request changes nothing. Writes
   * nothing, so a refused update or an Amadeus refusal leaves the booking as it was.
   */
  private async prepare(
    trx: TenantTransaction,
    tenant: RequestTenant,
    bookingId: string,
    ifMatch: string,
    body: BookingUpdateRequest,
  ): Promise<PreparedUpdate | undefined> {
    const booking = await this.bookings.booking(trx, bookingId, true);
    const details = await this.bookings.bookingDetails(trx, bookingId);
    if (booking === undefined || details === undefined || booking.environment !== tenant.environment) {
      // The guard read it in this request: only a concurrent erasure gets here.
      throw new AppError("NOT_FOUND");
    }
    if (!ifMatchSatisfied(ifMatch, booking.version)) {
      throw new AppError("PRECONDITION_FAILED", { details: { currentVersion: booking.version } });
    }
    if (booking.status === "cancelled") {
      throw new AppError("BOOKING_ALREADY_CANCELLED");
    }
    const children = await this.bookings.children(trx, bookingId);
    const allowed = allowedActionsOf({
      status: booking.status,
      ticketingStatus: booking.ticketingStatus,
      amadeusOrderId: booking.amadeusOrderId,
      lastArrivalAt: booking.lastArrivalAt,
      segments: children.segments,
      // The documents, the storefront switches and the refresh throttle decide other actions only.
      documentsReady: false,
      features: { selfServiceCancellation: false, ancillaries: false },
      lastRefreshAt: null,
      now: this.clock.now(),
    });
    const wanted: BookingAction[] = [
      ...(body.contacts === undefined ? [] : (["canModifyContacts"] as const)),
      ...(body.remarks === undefined ? [] : (["canAddRemarks"] as const)),
    ];
    for (const action of wanted) {
      if (!allowed[action]) {
        throw notModifiable(action, allowed.reasons[action] ?? "pending");
      }
    }
    const orderId = booking.amadeusOrderId;
    if (orderId === null) {
      throw notModifiable(wanted[0] ?? "canModifyContacts", "pending");
    }
    const snapshot = details.orderSnapshot;
    const data: JsonObject = {
      type: "flight-order",
      id: orderId,
      flightOffers: flightOfferRefsOf(snapshot, children.segments),
    };
    let contacts: JsonObject[] | undefined;
    let primaryEmail: string | null = null;
    if (body.contacts !== undefined) {
      const requirements =
        booking.pricedOfferId === null
          ? undefined
          : await this.repository.bookingRequirements(trx, booking.pricedOfferId);
      const errors = contactErrors(body.contacts, contactRequirementOf(requirements));
      if (errors.length > 0) {
        throw new AppError("CONTACT_DATA_INVALID", {
          message: "Please check the contact details.",
          fieldErrors: errors,
        });
      }
      primaryEmail = body.contacts[primaryIndexOf(body.contacts)]?.emailAddress ?? null;
      contacts = amadeusContactsOf(body.contacts);
      data["contacts"] = contacts;
    }
    let remarks: NewRemark[] = [];
    if (body.remarks !== undefined) {
      const errors = remarkInputErrors(
        body.remarks,
        new Set(children.travelers.map((row) => row.amadeusTravelerId)),
      );
      if (errors.length > 0) {
        throw new AppError("VALIDATION_FAILED", { fieldErrors: errors });
      }
      const stored = storedRemarksOf(snapshot, children.remarks);
      remarks = newRemarksOf(stored, body.remarks);
      if (remarks.length > 0) {
        data["remarks"] = patchRemarksOf(stored, remarks, booking.reference);
      }
    }
    if (contacts === undefined && remarks.length === 0) {
      return undefined;
    }
    return {
      bookingId,
      orderId,
      office: booking.ownerOfficeId,
      version: booking.version,
      data,
      contacts,
      primaryEmail,
      remarks,
    };
  }

  /**
   * After a PATCH whose outcome is unknown (`patchOutcomeUnknown`, or a 2xx without an order): the refresh without its
   * throttle (the snapshot), then the record step on the order it stored, so the booking shows what Amadeus holds of
   * the change. Its failure is logged; the caller answers the original error.
   */
  private async resyncAfterUnknownOutcome(
    tenant: RequestTenant,
    prepared: PreparedUpdate,
    cause: ResyncCause,
  ): Promise<void> {
    try {
      const outcome = await this.customerBookings.refresh(
        tenant,
        prepared.bookingId,
        UPDATE_OPERATION,
        {},
        { throttleMs: 0 },
      );
      let recorded = false;
      if (outcome.kind === "refreshed" || outcome.kind === "superseded") {
        recorded = await this.tx.run((trx) => this.record(trx, tenant, prepared, cause, undefined));
      }
      this.logger.info(
        { bookingId: prepared.bookingId, cause, outcome: outcome.kind, recorded },
        "bookings.update_resynced",
      );
    } catch (error) {
      this.logger.warn({ bookingId: prepared.bookingId, err: error }, "bookings.update_resync_failed");
    }
  }

  /**
   * T2 (see the file header): the order (`reply.data`, or the stored snapshot after the refresh of an unknown outcome)
   * recorded on the booking. Answers whether anything was recorded (always after a PATCH that answered).
   */
  private async record(
    trx: TenantTransaction,
    tenant: RequestTenant,
    prepared: PreparedUpdate,
    cause: RecordCause,
    reply:
      | {
          readonly data: JsonObject;
          readonly dictionaries: unknown;
          readonly supplierRequestId: string | null;
        }
      | undefined,
  ): Promise<boolean> {
    const { bookingId } = prepared;
    const now = this.clock.now();
    const booking = await this.bookings.booking(trx, bookingId, true);
    const details = await this.bookings.bookingDetails(trx, bookingId);
    if (booking === undefined || details === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const children = await this.bookings.children(trx, bookingId);
    const order: JsonObject =
      reply === undefined ? (isRecord(details.orderSnapshot) ? details.orderSnapshot : {}) : reply.data;

    // The contacts: the order's, when they are those sent (always after a PATCH that answered).
    let contacts: ContactValues[] | undefined;
    if (prepared.contacts !== undefined) {
      const orderContacts = Array.isArray(order["contacts"])
        ? records(order["contacts"])
        : cause === "patched"
          ? prepared.contacts
          : [];
      if (cause === "patched" || contactsMatch(orderContacts, prepared.contacts)) {
        const values = contactValuesOf(orderContacts, prepared.primaryEmail);
        if (
          values.length > 0 &&
          canonicalJson(values) !== canonicalJson(storedContactValues(children.contacts))
        ) {
          contacts = values;
        }
      }
    }
    // The special requests: those sent that the order has (all of them when the answer has no remarks) and the
    // booking has not.
    const remarks = prepared.remarks.filter(
      (remark) =>
        (cause === "patched" && !isRecord(order["remarks"])) || orderHasRemark(order["remarks"], remark),
    );
    const added = remarks.filter((remark) => !rowsHaveRemark(children.remarks, remark));
    if (cause !== "patched" && contacts === undefined && added.length === 0) {
      return false;
    }

    const primary = contacts?.find((contact) => contact.isPrimary);
    if (contacts !== undefined) {
      await this.repository.replaceContacts(
        trx,
        bookingId,
        contacts.map((contact, index) => contactRowOf(this.ids.newId("bco"), bookingId, contact, now, index)),
      );
    }
    await this.repository.insertRemarks(
      trx,
      added.map((remark, index) => ({
        id: this.ids.newId("rmk"),
        booking_id: bookingId,
        kind: "general",
        sub_type: SPECIAL_REQUEST_SUBTYPE,
        text: remark.text,
        traveler_ids: [...remark.travelerIds],
        visible_to_customer: true,
        created_at: new Date(now.getTime() + index),
        updated_at: now,
      })),
    );
    const moved = booking.version !== prepared.version;
    await this.bookings.updateBooking(trx, bookingId, {
      ...(reply === undefined
        ? {}
        : {
            order_snapshot: JSON.stringify(
              snapshotAfter(details.orderSnapshot, reply.data, moved, {
                contacts: prepared.contacts !== undefined,
                remarks: prepared.remarks.length > 0,
              }),
            ),
            ...(moved || reply.dictionaries === undefined
              ? {}
              : { order_dictionaries: JSON.stringify(reply.dictionaries) }),
            ...(moved ? {} : { last_synced_at: now, sync_error: null }),
          }),
      ...(primary?.email === null || primary?.email === undefined ? {} : { contact_email: primary.email }),
      updated_at: now,
    });
    const version = booking.version + 1;
    const actor = eventActorOf(tenant.actor);
    const requestId = this.tenants.requestId() ?? tenant.requestId;
    const eventData = cause === "patched" ? {} : { cause };
    if (contacts !== undefined) {
      await this.recorder.event(trx, bookingId, {
        type: CONTACTS_UPDATED_EVENT,
        actor,
        statusFrom: booking.status,
        statusTo: booking.status,
        summary: "Contact details updated.",
        data: { ...eventData, contacts: contacts.length },
        visibleToCustomer: true,
        supplierRequestId: reply?.supplierRequestId ?? null,
        requestId,
        now,
      });
    }
    if (added.length > 0) {
      await this.recorder.event(trx, bookingId, {
        type: REMARK_ADDED_EVENT,
        actor,
        statusFrom: booking.status,
        statusTo: booking.status,
        summary: added.length === 1 ? "Special request added." : "Special requests added.",
        data: { ...eventData, remarks: added.length },
        visibleToCustomer: true,
        supplierRequestId: reply?.supplierRequestId ?? null,
        requestId,
        // One millisecond after the contacts event: the timeline orders events by time (ids are random within one).
        now: new Date(now.getTime() + 1),
      });
    }
    if (contacts !== undefined && primary !== undefined) {
      await this.confirmations(trx, tenant, booking, children, primary, version);
    }
    return true;
  }

  /**
   * The confirmation of a contacts change (see the file header) to the new primary address and, when it differs, to
   * the previous `contact_email`. A call the outbox refuses (InvalidNotificationError, raised before any SQL) is logged
   * and skipped: the change happened at Amadeus and is recorded all the same.
   */
  private async confirmations(
    trx: TenantTransaction,
    tenant: RequestTenant,
    booking: BookingRow,
    children: BookingChildren,
    primary: ContactValues,
    version: number,
  ): Promise<void> {
    if (primary.email === null) {
      return;
    }
    const settings = await this.bookings.settings(trx);
    const locale =
      primary.language !== null && LOCALE.test(primary.language)
        ? primary.language
        : (settings?.defaultLocale ?? "en");
    const data = {
      booking: {
        reference: booking.reference,
        recordLocator: booking.recordLocator ?? "",
        url: `${storefrontUrl(tenant.key, this.baseDomain)}/booking.html?id=${booking.id}`,
        total: { amount: booking.totalAmount, currency: booking.currency },
        contact: { firstName: primary.firstName ?? "", lastName: primary.lastName ?? "" },
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
    };
    const recipients: Array<[string, "new" | "old"]> = [[primary.email, "new"]];
    if (booking.contactEmail.toLowerCase() !== primary.email.toLowerCase()) {
      recipients.push([booking.contactEmail, "old"]);
    }
    for (const [to, which] of recipients) {
      try {
        await this.outbox.enqueue(trx, {
          templateKey: CONTACTS_CONFIRMATION_TEMPLATE,
          to,
          locale,
          customerId: booking.customerId,
          bookingId: booking.id,
          dedupeKey: `${CONTACTS_CONFIRMATION_DEDUPE}:${booking.id}:v${version}:${which}`,
          data,
        });
      } catch (error) {
        if (!(error instanceof InvalidNotificationError)) {
          throw error;
        }
        this.logger.error({ bookingId: booking.id, err: error }, "bookings.update_confirmation_invalid");
      }
    }
  }

  private callContext(tenant: RequestTenant, bookingId: string, office: string | null): AmadeusCallContext {
    return {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation: UPDATE_OPERATION,
      requestId: this.tenants.requestId() ?? tenant.requestId,
      bookingId,
      ...(office === null ? {} : { orderOffice: office }),
    };
  }
}
