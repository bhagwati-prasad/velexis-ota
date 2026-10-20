// The Amadeus requests of the booking orchestration (OBE-042; ota/docs/architecture-booking.md §1 step 2, OADR-0003
// point 3, OADR-0008 point 1, the contract's checkout.complete steps 5 and 7). Pure functions: no I/O, no clock.
//
// Flight Create Orders (`POST /v1/booking/flight-orders?issue=<issue>`), `data`:
//   - `type: flight-order`, `queuingOfficeId` and `ownerOfficeId` of the tenant's connection;
//   - `flightOffers`: the priced Amadeus offers verbatim (net, as Flight Offers Price confirmed them);
//   - `travelers`: each checkout traveller under its Amadeus id, with the decrypted documents (in memory only; the
//     client's `supplier_requests` row keeps them masked) and only the fields the specification declares;
//   - `contacts` from the checkout contacts (`isPrimary` is the OTA's, not Amadeus's);
//   - `remarks.general`: each special request upper-cased (GENERAL_MISCELLANEOUS, with its travellers) and the remark
//     `VELEXIS <reference>` (BACKOFFICE, as the contract's step 5 writes it), which reconciliation looks for;
//   - `ticketingAgreement: {option: CONFIRM}` (the order is paid: `authorize_before_booking` only, OADR-0008 point 2);
//   - `automatedProcess`: `IMMEDIATE` on the tenant's booking queue (`storefront_settings.booking_queue_number` and
//     category) in the queuing office, so the order can be found after a timeout; none without a queue;
//   - `formOfPayments`: the OTA-merchant model, `other.method` for every offer (the traveller pays the OTA through
//     Stripe; Amadeus never sees a card on this path).
// `issue` is true for `issue_at_booking` and for an offer with `instantTicketingRequired` (OADR-0008 point 1).
//
// Flight Order Issue (`POST /v1/booking/flight-orders/{id}/issuance`): `data.formOfPayments` with the same `other`
// method.
import type { components } from "@velexis/api-types";
import type { AmadeusDiscount, StoredDocument } from "../checkout/traveler-documents";
import { velexisRemarkText } from "./booking-reference";

type Schemas = components["schemas"];

/** `storefront_settings.ticketing_policy` (IssuancePolicy). */
export type TicketingPolicy = Schemas["IssuancePolicy"];

/** Amadeus `OtherPaymentMethod`. */
export type OtherPaymentMethod = "ACCOUNT" | "CHECK" | "CASH" | "NONREFUNDABLE" | "PYTON";

/**
 * The form of payment of the OTA-merchant model: the OTA settles with the airline on its account (contract step 5:
 * `other.method` ACCOUNT, CASH or NONREFUNDABLE). The storefront settings have no column for it yet, so it is this
 * constant.
 */
export const ORDER_FORM_OF_PAYMENT: OtherPaymentMethod = "ACCOUNT";

/** The general remark type of the `VELEXIS <reference>` remark (contract step 5). */
export const VELEXIS_REMARK_SUBTYPE = "BACKOFFICE";

/** The general remark type of the traveller's special requests (checkout_remarks). */
export const SPECIAL_REQUEST_SUBTYPE = "GENERAL_MISCELLANEOUS";

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** A checkout traveller as the order needs it (decrypted lists included). */
export interface OrderTraveler {
  /** The Amadeus traveller id of the priced offer (`"1"`). */
  readonly travelerId: string;
  readonly firstName: string | null;
  readonly middleName: string | null;
  readonly lastName: string | null;
  readonly secondLastName: string | null;
  /** `YYYY-MM-DD`. */
  readonly dateOfBirth: string | null;
  readonly gender: string | null;
  readonly contact: unknown;
  readonly documents: readonly StoredDocument[];
  readonly discounts: readonly AmadeusDiscount[];
  readonly loyaltyPrograms: unknown;
  readonly emergencyContact: unknown;
}

/** A checkout contact as the order needs it. */
export interface OrderContact {
  readonly purpose: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly phones: unknown;
  readonly address: unknown;
  readonly language: string | null;
}

/** A special request of the checkout. */
export interface OrderRemark {
  readonly text: string;
  readonly travelerIds: readonly string[];
}

/** The tenant's booking queue (`storefront_settings`), or none. */
export interface BookingQueue {
  readonly number: number;
  readonly category: number;
}

/** Everything a Flight Create Orders request is built from. */
export interface OrderRequestInput {
  /** The priced Amadeus offers, verbatim. */
  readonly flightOffers: readonly unknown[];
  readonly travelers: readonly OrderTraveler[];
  readonly contacts: readonly OrderContact[];
  readonly remarks: readonly OrderRemark[];
  /** The booking reference of the claim. */
  readonly reference: string;
  readonly queue: BookingQueue | null;
  readonly offices: { readonly queuing: string; readonly owner: string };
  readonly issue: boolean;
  readonly formOfPayment?: OtherPaymentMethod;
}

/** The body and query of Flight Create Orders. */
export interface CreateOrderRequest {
  readonly body: { readonly data: JsonObject };
  readonly query: { readonly issue: boolean };
}

/** The body of Flight Order Issue. */
export interface IssueOrderRequest {
  readonly data: { readonly formOfPayments: readonly JsonObject[] };
}

/** `issue` of Flight Create Orders: `issue_at_booking`, or an offer that must be ticketed at once (OADR-0008 point 1). */
export function issueAtCreate(policy: TicketingPolicy, instantTicketingRequired: boolean): boolean {
  return policy === "issue_at_booking" || instantTicketingRequired;
}

/** The Amadeus ids of the offers (`flightOffers[].id`), in order. */
export function amadeusOfferIdsOf(flightOffers: readonly unknown[]): string[] {
  return flightOffers.flatMap((offer) =>
    isRecord(offer) && typeof offer["id"] === "string" ? [offer["id"]] : [],
  );
}

/** Whether any offer must be ticketed at once (`instantTicketingRequired`). */
export function requiresInstantTicketing(flightOffers: readonly unknown[]): boolean {
  return flightOffers.some((offer) => isRecord(offer) && offer["instantTicketingRequired"] === true);
}

/** An object without the keys whose value is `null` or `undefined`. */
function compact(entries: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== null && value !== undefined),
  );
}

/** The Amadeus `Name` of a traveller (`firstName`, `middleName`, `lastName`, `secondLastName`). */
function nameOf(traveler: OrderTraveler): JsonObject {
  return compact({
    firstName: traveler.firstName,
    middleName: traveler.middleName,
    lastName: traveler.lastName,
    secondLastName: traveler.secondLastName,
  });
}

/** An Amadeus `IdentityDocument` from a sealed document: the fields of the specification only. */
function documentOf(document: StoredDocument): JsonObject {
  return compact({
    documentType: document.documentType,
    number: document.number,
    issuanceDate: document.issuanceDate,
    expiryDate: document.expiryDate,
    issuanceCountry: document.issuanceCountry,
    issuanceLocation: document.issuanceLocation,
    nationality: document.nationality,
    birthPlace: document.birthPlace,
    validityCountry: document.validityCountry,
    birthCountry: document.birthCountry,
    holder: document.holder,
  });
}

/** An Amadeus `Contact` from a stored contact object: its declared fields only. */
function amadeusContactOf(value: unknown): JsonObject | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const contact = compact({
    addresseeName: isRecord(value["addresseeName"]) ? value["addresseeName"] : undefined,
    address: isRecord(value["address"]) ? value["address"] : undefined,
    language: typeof value["language"] === "string" ? value["language"] : undefined,
    purpose: typeof value["purpose"] === "string" ? value["purpose"] : undefined,
    phones: records(value["phones"]).length > 0 ? records(value["phones"]) : undefined,
    companyName: typeof value["companyName"] === "string" ? value["companyName"] : undefined,
    emailAddress: typeof value["emailAddress"] === "string" ? value["emailAddress"] : undefined,
  });
  return Object.keys(contact).length === 0 ? undefined : contact;
}

/** The Amadeus traveller of a checkout traveller. */
export function amadeusTravelerOf(traveler: OrderTraveler): JsonObject {
  const loyalty = records(traveler.loyaltyPrograms);
  return compact({
    id: traveler.travelerId,
    dateOfBirth: traveler.dateOfBirth,
    gender: traveler.gender,
    name: nameOf(traveler),
    documents: traveler.documents.length > 0 ? traveler.documents.map(documentOf) : undefined,
    emergencyContact: isRecord(traveler.emergencyContact) ? traveler.emergencyContact : undefined,
    loyaltyPrograms: loyalty.length > 0 ? loyalty : undefined,
    discountEligibility:
      traveler.discounts.length > 0 ? traveler.discounts.map((entry) => ({ ...entry })) : undefined,
    contact: amadeusContactOf(traveler.contact),
  });
}

/** The Amadeus contact of a checkout contact. */
export function amadeusOrderContactOf(contact: OrderContact): JsonObject {
  const phones = records(contact.phones);
  return compact({
    addresseeName:
      contact.firstName === null && contact.lastName === null
        ? undefined
        : compact({ firstName: contact.firstName, lastName: contact.lastName }),
    address: isRecord(contact.address) ? contact.address : undefined,
    language: contact.language,
    purpose: contact.purpose,
    phones: phones.length > 0 ? phones : undefined,
    companyName: contact.companyName,
    emailAddress: contact.email,
  });
}

/** `remarks.general`: the special requests (upper case) and the `VELEXIS <reference>` remark, last. */
export function generalRemarksOf(remarks: readonly OrderRemark[], reference: string): JsonObject[] {
  return [
    ...remarks.map((remark) =>
      compact({
        subType: SPECIAL_REQUEST_SUBTYPE,
        text: remark.text.toUpperCase(),
        travelerIds: remark.travelerIds.length > 0 ? [...remark.travelerIds] : undefined,
      }),
    ),
    { subType: VELEXIS_REMARK_SUBTYPE, text: velexisRemarkText(reference) },
  ];
}

/** `formOfPayments` of the OTA-merchant model: one `other` entry for the offers. */
export function formOfPaymentsOf(
  flightOfferIds: readonly string[],
  method: OtherPaymentMethod = ORDER_FORM_OF_PAYMENT,
): JsonObject[] {
  return [{ other: { method, flightOfferIds: [...flightOfferIds] } }];
}

/** The Flight Create Orders request of a claimed booking (see the file header). */
export function buildCreateOrderRequest(input: OrderRequestInput): CreateOrderRequest {
  if (input.flightOffers.length === 0) {
    throw new TypeError("buildCreateOrderRequest: no flight offer");
  }
  const offerIds = amadeusOfferIdsOf(input.flightOffers);
  const contacts = input.contacts.map(amadeusOrderContactOf);
  const data: JsonObject = {
    type: "flight-order",
    queuingOfficeId: input.offices.queuing,
    ownerOfficeId: input.offices.owner,
    flightOffers: [...input.flightOffers],
    travelers: input.travelers.map(amadeusTravelerOf),
    remarks: { general: generalRemarksOf(input.remarks, input.reference) },
    formOfPayments: formOfPaymentsOf(offerIds, input.formOfPayment),
    ticketingAgreement: { option: "CONFIRM" },
    ...(input.queue === null
      ? {}
      : {
          automatedProcess: [
            {
              code: "IMMEDIATE",
              queue: { number: String(input.queue.number), category: String(input.queue.category) },
              officeId: input.offices.queuing,
            },
          ],
        }),
    ...(contacts.length > 0 ? { contacts } : {}),
  };
  return { body: { data }, query: { issue: input.issue } };
}

/** The Flight Order Issue request: the OTA-merchant form of payment for the order's offers. */
export function buildIssueRequest(
  flightOfferIds: readonly string[],
  method: OtherPaymentMethod = ORDER_FORM_OF_PAYMENT,
): IssueOrderRequest {
  return { data: { formOfPayments: formOfPaymentsOf(flightOfferIds, method) } };
}

/**
 * The travellers a re-price sends to Flight Offers Price when one of them carries discount data (contract step 4):
 * their id, date of birth and discount entries, the fields the pricing uses.
 */
export function pricingTravelersOf(travelers: readonly OrderTraveler[]): JsonObject[] {
  return travelers.map((traveler) =>
    compact({
      id: traveler.travelerId,
      dateOfBirth: traveler.dateOfBirth,
      discountEligibility:
        traveler.discounts.length > 0 ? traveler.discounts.map((entry) => ({ ...entry })) : undefined,
    }),
  );
}
