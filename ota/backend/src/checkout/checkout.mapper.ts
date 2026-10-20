// Checkouts between the tenant tables and the API (OBE-036; the OTA document's Checkout, Traveler, Contact, Remark and
// CheckoutAncillary schemas, ota/docs/flows/checkout-stripe.md §2 steps 1–2). Pure functions: no I/O and no clock (the
// caller passes `now`); money in decimal.js (`Money` of the pricing context), never a JavaScript number.
//
// Every step answers the whole checkout (`toCheckout`): the stored rows, the decrypted travellers (documents only as
// `readableDocument` shows them, traveller-documents.ts), the requirements and the progress (requirements.ts), and from
// the priced offer being bought (in customer scope: selling amounts only, in console scope too) the price breakdown,
// the flights, the summary, the conditions and the ticketing data. `totals` are the checkout's own columns:
// `total = offer + ancillaries + cardFee`, `cardFee` null while no card brand is known (`payment_brand`). The status
// is computed: an `open` or `payment_pending` checkout is `expired` after `expires_at`, before the expiry job marks it.
// The active payment is OBE-038's, so `payment` is null and `progress.paymentReady` only reflects `pay_later`.
//
// `ETag` is `"<version>"`; `If-Match` takes it quoted, weak (`W/"3"`), bare (`3`), as a list, or `*`.
import type { components } from "@velexis/api-types";
import { Money } from "../pricing/pricing.types";
import type {
  CheckoutAncillaryRow,
  CheckoutContactRow,
  CheckoutRemarkRow,
  CheckoutRow,
  CheckoutTravelerRow,
} from "./checkout.repository";
import {
  contactErrors,
  missingErrorsOf,
  missingFieldsOf,
  type CheckoutRequirements,
  type ContactData,
  type FieldError,
  type TravelerData,
} from "./requirements";
import {
  readableDiscount,
  readableDocument,
  type AmadeusDiscount,
  type StoredDocument,
} from "./traveler-documents";

type Schemas = components["schemas"];
export type Checkout = Schemas["Checkout"];
export type CheckoutCreateRequest = Schemas["CheckoutCreateRequest"];
export type CheckoutTravelersRequest = Schemas["CheckoutTravelersRequest"];
export type CheckoutContactsRequest = Schemas["CheckoutContactsRequest"];
export type CheckoutRemarksRequest = Schemas["CheckoutRemarksRequest"];
type PricedOffer = Schemas["PricedOffer"];
type Traveler = Schemas["Traveler"];
type Contact = Schemas["Contact"];
type Remark = Schemas["Remark"];
type CheckoutAncillary = Schemas["CheckoutAncillary"];
type CheckoutProgress = Schemas["CheckoutProgress"];
type CheckoutTicketing = Schemas["CheckoutTicketing"];
type Itinerary = Schemas["Itinerary"];
type OfferSummary = Schemas["OfferSummary"];
type MoneyAmount = Schemas["Money"];
type AmadeusName = Schemas["AmadeusName"];
type AmadeusContact = Schemas["AmadeusContact"];
type AmadeusPhone = Schemas["AmadeusPhone"];
type AmadeusAddress = Schemas["AmadeusAddress"];
type AmadeusLoyaltyProgram = Schemas["AmadeusLoyaltyProgram"];
type AmadeusEmergencyContact = Schemas["AmadeusEmergencyContact"];
type TravelerType = Schemas["AmadeusTravelerType"];
type Gender = Schemas["AmadeusStakeholderGender"];
type ContactPurpose = Schemas["AmadeusContactPurpose"];
type ServiceName = Schemas["AmadeusServiceName"];

/** `Cache-Control` of every checkout answer: personal, and it changes with every step. */
export const CHECKOUT_CACHE_CONTROL = "no-store";

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const distinct = <T>(values: Iterable<T>): T[] => [...new Set(values)];

// ---- ETag and If-Match --------------------------------------------------------------------------------------------

/** The checkout's `ETag`. */
export function etagOf(version: number): string {
  return `"${version}"`;
}

/**
 * Whether an `If-Match` value matches the current `version`: absent, `*`, or one of its comma-separated entries
 * (quoted, weak or bare digits) equal to it. Anything else is stale or malformed: `412 PRECONDITION_FAILED`.
 */
export function ifMatchSatisfied(header: string | undefined, version: number): boolean {
  if (header === undefined) {
    return true;
  }
  return header.split(",").some((entry) => {
    const tag = entry.trim();
    if (tag === "*") {
      return true;
    }
    const match = /^(?:W\/)?"?(\d{1,10})"?$/.exec(tag);
    return match !== null && Number(match[1]) === version;
  });
}

// ---- Status -------------------------------------------------------------------------------------------------------

/** The status a checkout answers: `expired` after `expires_at` while it is `open` or `payment_pending`. */
export function effectiveStatus(
  row: Pick<CheckoutRow, "status" | "expiresAt">,
  now: Date,
): Checkout["status"] {
  const status = row.status as Checkout["status"];
  return (status === "open" || status === "payment_pending") && row.expiresAt.getTime() <= now.getTime()
    ? "expired"
    : status;
}

// ---- Travellers ---------------------------------------------------------------------------------------------------

/** A traveller row with its decrypted lists. */
export interface TravelerView {
  readonly row: CheckoutTravelerRow;
  readonly documents: readonly StoredDocument[];
  readonly discounts: readonly AmadeusDiscount[];
}

/** The name of a traveller row, `null` until any part is entered. */
function nameOf(row: CheckoutTravelerRow): AmadeusName | null {
  const name: AmadeusName = {};
  if (row.firstName !== null) {
    name.firstName = row.firstName;
  }
  if (row.middleName !== null) {
    name.middleName = row.middleName;
  }
  if (row.lastName !== null) {
    name.lastName = row.lastName;
  }
  if (row.secondLastName !== null) {
    name.secondLastName = row.secondLastName;
  }
  return Object.keys(name).length === 0 ? null : name;
}

/** The traveller as the completeness checks read it. */
export function travelerDataOf(view: TravelerView): TravelerData {
  const { row } = view;
  return {
    name: nameOf(row),
    dateOfBirth: row.dateOfBirth,
    gender: row.gender,
    contact: isRecord(row.contact) ? (row.contact as AmadeusContact) : null,
    documents: view.documents,
    discountEligibility: view.discounts,
  };
}

function toTraveler(view: TravelerView, requirements: CheckoutRequirements): Traveler {
  const { row } = view;
  const requirement = requirements.travelers.find((entry) => entry.travelerId === row.amadeusTravelerId);
  const missing = requirement === undefined ? [] : missingFieldsOf(travelerDataOf(view), requirement);
  return {
    id: row.id,
    travelerId: row.amadeusTravelerId,
    travelerType: row.travelerType as TravelerType,
    associatedAdultId: row.associatedAdultId,
    savedTravelerId: row.savedTravelerId,
    name: nameOf(row),
    dateOfBirth: row.dateOfBirth,
    gender: row.gender as Gender | null,
    contact: isRecord(row.contact) ? (row.contact as AmadeusContact) : null,
    documents: view.documents.map(readableDocument),
    loyaltyPrograms: records(row.loyaltyPrograms) as AmadeusLoyaltyProgram[],
    discountEligibility: view.discounts.map(readableDiscount),
    emergencyContact: isRecord(row.emergencyContact)
      ? (row.emergencyContact as AmadeusEmergencyContact)
      : null,
    complete: missing.length === 0,
    missingFields: missing,
    saveToAccount: row.saveToProfile,
  };
}

// ---- Contacts -----------------------------------------------------------------------------------------------------

function phonesOf(value: unknown): AmadeusPhone[] {
  return records(value) as AmadeusPhone[];
}

function addressOf(value: unknown): AmadeusAddress | null {
  return isRecord(value) ? (value as AmadeusAddress) : null;
}

/** A stored contact as the contact checks read it. */
export function contactDataOf(row: CheckoutContactRow): ContactData {
  const data: ContactData = {
    purpose: row.purpose as ContactPurpose,
    isPrimary: row.isPrimary,
    phones: phonesOf(row.phones),
  };
  if (row.email !== null) {
    data.emailAddress = row.email;
  }
  const address = addressOf(row.address);
  if (address !== null) {
    data.address = address;
  }
  return data;
}

function toContact(row: CheckoutContactRow): Contact {
  const addressee: AmadeusName = {};
  if (row.firstName !== null) {
    addressee.firstName = row.firstName;
  }
  if (row.lastName !== null) {
    addressee.lastName = row.lastName;
  }
  return {
    id: row.id,
    purpose: row.purpose as ContactPurpose,
    isPrimary: row.isPrimary,
    addresseeName: Object.keys(addressee).length === 0 ? null : addressee,
    companyName: row.companyName,
    emailAddress: row.email,
    phones: phonesOf(row.phones),
    address: addressOf(row.address),
    language: row.language,
  };
}

// ---- Ancillaries and remarks --------------------------------------------------------------------------------------

const ANCILLARY_TYPES: readonly CheckoutAncillary["type"][] = [
  "CHECKED_BAGS",
  "CABIN_BAGS",
  "SEATS",
  "OTHER_SERVICES",
];
const SERVICE_NAMES: readonly ServiceName[] = ["PRIORITY_BOARDING", "AIRPORT_CHECKIN", "FAST_TRACK"];
const DEFAULT_LABELS: Readonly<Record<CheckoutAncillary["type"], string>> = {
  CHECKED_BAGS: "Extra checked bag",
  CABIN_BAGS: "Extra cabin bag",
  SEATS: "Seat",
  OTHER_SERVICES: "Extra service",
};

const money = (amount: string, currency: string, minorUnits: number): MoneyAmount => ({
  amount: new Money(amount).toFixed(minorUnits),
  currency,
});

/**
 * A `checkout_ancillaries` row as CheckoutAncillary. The selection's catalogue option, its display label and its
 * segments are read from `details` (`optionId`, `label`, `segmentIds`) when checkout.setAncillaries (OBE-037) stored
 * them; otherwise the row's own traveller and segment (all segments for a row without one) and a generic label.
 */
function toAncillary(
  row: CheckoutAncillaryRow,
  travelerIdOf: ReadonlyMap<string, string>,
  segmentIds: readonly string[],
  minorUnits: number,
): CheckoutAncillary {
  const details = isRecord(row.details) ? row.details : {};
  const type = ANCILLARY_TYPES.includes(row.type as CheckoutAncillary["type"])
    ? (row.type as CheckoutAncillary["type"])
    : "OTHER_SERVICES";
  const optionId = typeof details["optionId"] === "string" ? details["optionId"] : null;
  const detailSegments = strings(details["segmentIds"]);
  const bags = type === "CHECKED_BAGS" || type === "CABIN_BAGS";
  return {
    id: row.id,
    optionId: optionId !== null && /^anc_[0-9A-Za-z]{16,40}$/.test(optionId) ? optionId : null,
    type,
    label: typeof details["label"] === "string" ? details["label"] : DEFAULT_LABELS[type],
    travelerId:
      (row.checkoutTravelerId === null ? undefined : travelerIdOf.get(row.checkoutTravelerId)) ??
      (typeof details["travelerId"] === "string" ? details["travelerId"] : ""),
    segmentIds:
      detailSegments.length > 0 ? detailSegments : row.segmentId === null ? [...segmentIds] : [row.segmentId],
    quantity: bags ? row.quantity : null,
    weight: row.weight,
    weightUnit: row.weightUnit,
    serviceName:
      type === "OTHER_SERVICES" && SERVICE_NAMES.includes(row.serviceCode as ServiceName)
        ? (row.serviceCode as ServiceName)
        : null,
    seatNumber: row.seatNumber,
    price: money(row.priceAmount, row.currency, minorUnits),
  };
}

function toRemark(row: CheckoutRemarkRow): Remark {
  return {
    id: row.id,
    kind: "general",
    subType: "GENERAL_MISCELLANEOUS",
    text: row.text,
    travelerIds: [...row.travelerIds],
    source: row.source === "staff" ? "staff" : "customer",
    createdAt: row.createdAt.toISOString(),
  };
}

// ---- Flights ------------------------------------------------------------------------------------------------------

/** The flights of every offer of the priced offer, in order, numbered from 0. */
export function itinerariesOf(pricedOffer: Pick<PricedOffer, "offers">): Itinerary[] {
  return pricedOffer.offers
    .flatMap((offer) => offer.itineraries)
    .map((itinerary, index) => ({ ...itinerary, index }));
}

/** The most restrictive of known verdicts: any `false` wins, then any unknown, else `true`. */
function strictest(values: ReadonlyArray<boolean | null | undefined>): boolean | null {
  if (values.some((value) => value === false)) {
    return false;
  }
  return values.every((value) => value === true) ? true : null;
}

/**
 * The summary of the offers being bought: the offer's own for one offer; for several (one-way offers priced
 * together) the first one's, with the trip type, return, durations, stops, carriers, cabins, branded fares and the
 * strictest conditions of all of them.
 */
export function summaryOf(
  pricedOffer: Pick<PricedOffer, "offers">,
  itineraries: readonly Itinerary[],
): OfferSummary {
  const offers = pricedOffer.offers;
  const first = offers[0];
  if (first === undefined) {
    throw new Error("a priced offer without offers");
  }
  if (offers.length === 1) {
    return first.summary;
  }
  const summaries = offers.map((offer) => offer.summary);
  const opening = itineraries[0];
  const closing = itineraries.at(-1);
  const roundTrip =
    itineraries.length === 2 && opening !== undefined && closing !== undefined
      ? closing.destinationCode === opening.originCode
      : false;
  let offset = 0;
  const brandedFares = offers.flatMap((offer) => {
    const fares = (offer.summary.brandedFares ?? []).map((fare) => ({
      ...fare,
      itineraryIndex: fare.itineraryIndex + offset,
    }));
    offset += offer.itineraries.length;
    return fares;
  });
  const seats = summaries.flatMap((summary) => summary.numberOfBookableSeats ?? []);
  const ticketing = summaries.flatMap((summary) => summary.lastTicketingDate ?? []).sort();
  const co2 = summaries.map((summary) => summary.co2Kg);
  const summary: OfferSummary = {
    ...first.summary,
    tripType: itineraries.length <= 1 ? "one_way" : roundTrip ? "round_trip" : "multi_city",
    returnAt: itineraries.length > 1 ? (closing?.departureAt ?? null) : null,
    totalDurationMinutes: summaries.reduce((total, entry) => total + entry.totalDurationMinutes, 0),
    maxStops: Math.max(...summaries.map((entry) => entry.maxStops)),
    marketingCarriers: distinct(summaries.flatMap((entry) => entry.marketingCarriers)),
    cabins: distinct(summaries.flatMap((entry) => entry.cabins)),
    refundable: strictest(summaries.map((entry) => entry.refundable)),
    changeable: strictest(summaries.map((entry) => entry.changeable)),
    numberOfBookableSeats: seats.length === summaries.length ? Math.min(...seats) : null,
    lastTicketingDate: ticketing[0] ?? null,
    co2Kg: co2.every((value): value is number => typeof value === "number")
      ? co2.reduce((total, value) => total + value, 0)
      : null,
    tags: [],
  };
  if (summaries.every((entry) => entry.operatingCarriers !== undefined)) {
    summary.operatingCarriers = distinct(summaries.flatMap((entry) => entry.operatingCarriers ?? []));
  }
  if (brandedFares.length > 0) {
    summary.brandedFares = brandedFares;
  }
  return summary;
}

// ---- The checkout -------------------------------------------------------------------------------------------------

/** What `toCheckout` needs besides the rows. */
export interface CheckoutViewInput {
  readonly checkout: CheckoutRow;
  readonly travelers: readonly TravelerView[];
  readonly contacts: readonly CheckoutContactRow[];
  readonly ancillaries: readonly CheckoutAncillaryRow[];
  readonly remarks: readonly CheckoutRemarkRow[];
  /** The priced offer being bought (`checkouts.priced_offer_id`), in customer scope. */
  readonly pricedOffer: PricedOffer;
  readonly minorUnits: number;
  readonly requirements: CheckoutRequirements;
  readonly settings: { readonly ticketingPolicy: string; readonly paymentTiming: string };
  readonly bookingId: string | null;
  readonly now: Date;
}

/** Completeness of the steps: what each traveller and the contacts still lack, with paths into the checkout. */
export function progressOf(
  travelers: readonly TravelerView[],
  contacts: readonly CheckoutContactRow[],
  requirements: CheckoutRequirements,
  paymentReady: boolean,
): CheckoutProgress {
  const travelerMissing: FieldError[] = travelers.flatMap((view, index) => {
    const requirement = requirements.travelers.find(
      (entry) => entry.travelerId === view.row.amadeusTravelerId,
    );
    return requirement === undefined ? [] : missingErrorsOf(index, travelerDataOf(view), requirement);
  });
  const contactMissing = contactErrors(contacts.map(contactDataOf), requirements.contact);
  const travelersComplete = travelerMissing.length === 0;
  const contactsComplete = contactMissing.length === 0;
  return {
    travelersComplete,
    contactsComplete,
    paymentReady,
    readyToComplete: travelersComplete && contactsComplete && paymentReady,
    missing: [...travelerMissing, ...contactMissing],
  };
}

function metadataOf(value: unknown): Record<string, string> {
  return isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : {};
}

/** The whole checkout (Checkout), see the file header. */
export function toCheckout(input: CheckoutViewInput): Checkout {
  const { checkout, pricedOffer, minorUnits } = input;
  const currency = checkout.currency;
  const itineraries = itinerariesOf(pricedOffer);
  const segmentIds = distinct(
    itineraries.flatMap((itinerary) => itinerary.segments.map((segment) => segment.id)),
  );
  const travelerIdOf = new Map(input.travelers.map((view) => [view.row.id, view.row.amadeusTravelerId]));
  const paymentTiming = input.settings.paymentTiming as CheckoutTicketing["paymentTiming"];
  const ticketing: CheckoutTicketing = {
    policy: input.settings.ticketingPolicy as CheckoutTicketing["policy"],
    paymentTiming,
    instantTicketingRequired: pricedOffer.instantTicketingRequired === true,
    lastTicketingDate: pricedOffer.lastTicketingDate ?? null,
  };
  const result: Checkout = {
    id: checkout.id,
    status: effectiveStatus(checkout, input.now),
    customerId: checkout.customerId,
    isGuest: checkout.isGuest,
    channel: checkout.channel === "console" ? "console" : "storefront",
    pricedOfferId: checkout.pricedOfferId,
    basePricedOfferId: checkout.basePricedOfferId,
    offerIds: [...pricedOffer.offerIds],
    currency,
    totals: {
      currency,
      offer: money(checkout.offerAmount, currency, minorUnits),
      ancillaries: money(checkout.ancillariesAmount, currency, minorUnits),
      cardFee: checkout.paymentBrand === null ? null : money(checkout.feesAmount, currency, minorUnits),
      total: money(checkout.totalAmount, currency, minorUnits),
      ...(pricedOffer.price.breakdown === undefined ? {} : { breakdown: pricedOffer.price.breakdown }),
    },
    priceChange: null,
    requirements: input.requirements,
    progress: progressOf(input.travelers, input.contacts, input.requirements, paymentTiming === "pay_later"),
    travelers: input.travelers.map((view) => toTraveler(view, input.requirements)),
    contacts: input.contacts.map(toContact),
    ancillaries: input.ancillaries.map((row) => toAncillary(row, travelerIdOf, segmentIds, minorUnits)),
    remarks: input.remarks.map(toRemark),
    payment: null,
    itineraries,
    summary: summaryOf(pricedOffer, itineraries),
    conditions: pricedOffer.conditions ?? null,
    ticketing,
    bookingId: input.bookingId,
    locale: checkout.locale,
    metadata: metadataOf(checkout.metadata),
    termsAcceptedAt: checkout.termsAcceptedAt?.toISOString() ?? null,
    warnings: [],
    version: checkout.version,
    expiresAt: checkout.expiresAt.toISOString(),
    createdAt: checkout.createdAt.toISOString(),
    updatedAt: checkout.updatedAt.toISOString(),
  };
  return result;
}
