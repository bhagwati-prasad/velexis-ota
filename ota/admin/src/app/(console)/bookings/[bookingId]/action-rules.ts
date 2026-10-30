// The shared vocabulary of a booking's actions (OAD-008, routes.md §3.2 "Actions", README §7): the form field names, the
// choices the dialogs offer and the pure rules that decide what an action does to the booking and its money. The server
// actions (actions.ts), the page that renders the dialogs (page.tsx) and the dialogs themselves (`*-dialog.tsx`,
// `*-form.tsx`) import it. A module without a directive: a `"use server"` module may export async functions only, and a
// `"use client"` module would reach the server only as client references. No SDK runtime import (types only), no Zod
// (the actions validate with it on the server), no secret and no card data: the admin never asks for a card
// (OADR-0018 point 8, OADR-0004), so nothing here names a card number, a holder or an expiry date.
//
// - Issue (`console.bookings.issue`): an airline-card booking is issued only with an `other` form of payment of the OTA's
//   own settlement with the airline, `CASH` or `ACCOUNT`, for the booking's flight offers; any other booking without one
//   (the API uses the OTA-merchant `other` of the ticketing job). An authorised Stripe payment is captured first; an
//   unpaid booking needs `allowUnpaid`, which only an owner or an admin may send (OADR-0008). An airline-card booking
//   whose card the airline did not charge (its payment not `captured`: the airline issued no ticket, so the payment
//   stayed `processing`) is unpaid too, and needs both (console-operations.md §2 step 8; OAD-016's journey found that
//   the dialog offered no `allowUnpaid` there, so such a booking could not be issued at all).
// - Cancel (`console.bookings.cancel`): what Amadeus is asked for is the API's own answer, `cancellationMode` of
//   console.bookings.get (nothing issued: the order is released; every ticket issued today in the OTA's time zone:
//   void; a ticket of an earlier day or of an unknown time: the void will most likely be refused, and the cancellation
//   is a request to the airline). The API decides "today" in `storefront_settings.time_zone`, the zone of its
//   cancellation quote, so the dialog never says void while the API finds the tickets of yesterday (lead decision (2a)
//   of 2026-10-30, FIX-W35-OTA; until then the dialog decided it from the platform tenant's zone). The refund modes follow
//   the payment the money step acts on (change-and-cancel.md "Staff cancellations", cancellation.service.ts
//   `staffRefundOf`): a captured Stripe payment gives back nothing, everything still refundable or an amount; an
//   authorisation is released whole (`full`), in part (`amount`: the rest is captured) or captured whole (`none`); an
//   airline card and a booking without payment take `none` only (`refund_via_airline`).
// - Payments (`console.payments.capture`, `.refund`): capture for an `authorized` Stripe payment, up to the authorised
//   amount; refund for a `captured` or `partially_refunded` Stripe payment, up to what is still refundable (captured
//   less refunded less the refunds still `pending` or `processing`, as the API counts it). Airline-card payments are
//   never refunded here.
// - Patch (`console.bookings.patch`): the API replaces an order contact of the same purpose whole, and a traveller's
//   `contact` whole, so the traveller and contact dialogs post the stored contact (`KEPT_FIELD`, `keptContactOf`) and the
//   action puts the dialog's values over it: what the dialog does not show is sent back as it was.
//
// Money stays a decimal string (conventions §1): the sums below use whole ten-thousandths in a `bigint`, never a float.
import type { ConsoleBooking, ConsolePayment, StaffRole } from "@velexis/ota-sdk";

import type { MoneyValue } from "@/components/money";

// ---- Field names ------------------------------------------------------------------------------------------------------

/** Hidden: the booking (`bkg_…`). */
export const BOOKING_ID_FIELD = "bookingId";
/** Hidden: the version the page displayed, sent as `ifMatch` (the booking's, or the payment's for a capture). */
export const VERSION_FIELD = "version";
/** Hidden: the payment (`pay_…`). */
export const PAYMENT_ID_FIELD = "paymentId";
/** Checkbox: tell the traveller (`notifyCustomer`). */
export const NOTIFY_FIELD = "notifyCustomer";
/** Checkbox (owner and admin only): issue although the payment is not captured (`allowUnpaid`). */
export const ALLOW_UNPAID_FIELD = "allowUnpaid";
/** Radio of an airline-card booking's issuance: the OTA's settlement with the airline, `CASH` or `ACCOUNT`. */
export const SETTLEMENT_FIELD = "settlement";
/** Hidden: the booking's flight offers (`flightOfferIds` of the `other` form of payment), comma-separated. */
export const FLIGHT_OFFERS_FIELD = "flightOfferIds";
/** Select of a cancellation: `reasonCode`. */
export const REASON_CODE_FIELD = "reasonCode";
/** Radio of a cancellation: `refund.mode`. */
export const REFUND_MODE_FIELD = "refundMode";
/** An amount as staff type it (`refund.amount.amount`, a capture's or a refund's `amount.amount`). */
export const AMOUNT_FIELD = "amount";
/** Hidden: the currency of `amount`. */
export const CURRENCY_FIELD = "currency";
/** Select of a payment refund: the refund's category (the API's `reason`; the dialog's reason is its `reasonNote`). */
export const REFUND_REASON_FIELD = "refundReason";
/** A note's text. */
export const NOTE_TEXT_FIELD = "text";
/** Checkbox of a note: show it to the customer too. */
export const NOTE_VISIBLE_FIELD = "visibleToCustomer";
/** Hidden: the element a patch dialog changes (`PATCH_ELEMENTS`). */
export const PATCH_ELEMENT_FIELD = "element";
/**
 * Hidden (the traveller and contact dialogs): the stored contact as JSON (`keptContactOf`), which the action sends back
 * with the dialog's values over it. The API replaces an order contact of the same purpose whole and a traveller's
 * `contact` whole (it merges a traveller field by field), so what the dialog does not show (other phones, a phone's
 * device type, a state, a post box, a middle name, a traveller's address) must travel with the edit or it is lost.
 */
export const KEPT_FIELD = "kept";
/** The longest `kept` an action reads: a contact with three phones and a full address is far shorter. */
export const KEPT_MAX_LENGTH = 8000;

/** The inputs of the patch dialogs (one element per dialog). */
export const PATCH_FIELDS = Object.freeze({
  travelerId: "travelerId",
  firstName: "firstName",
  lastName: "lastName",
  dateOfBirth: "dateOfBirth",
  gender: "gender",
  email: "email",
  phoneCountryCode: "phoneCountryCode",
  phoneNumber: "phoneNumber",
  purpose: "purpose",
  companyName: "companyName",
  addressLine1: "addressLine1",
  addressLine2: "addressLine2",
  postalCode: "postalCode",
  cityName: "cityName",
  countryCode: "countryCode",
  language: "language",
  remarkType: "remarkType",
  remarkText: "remarkText",
  agreementOption: "agreementOption",
  agreementDelay: "agreementDelay",
});

/** The elements a patch dialog changes: one traveller, one contact, a new remark, or the ticketing agreement. */
export const PATCH_ELEMENTS = ["traveler", "contact", "remark", "ticketingAgreement"] as const;
export type PatchElement = (typeof PATCH_ELEMENTS)[number];

// ---- Choices --------------------------------------------------------------------------------------------------------

/** One choice of a select or a radio group: the value the API takes and its words. */
export interface Choice<T extends string = string> {
  readonly value: T;
  readonly label: string;
}

/** `ConsoleBookingCancelRequest.reasonCode`. */
export const CANCEL_REASON_CODES = [
  { value: "customer_request", label: "The customer asked" },
  { value: "duplicate", label: "Duplicate booking" },
  { value: "fraud", label: "Fraud" },
  { value: "schedule_change", label: "Schedule change" },
  { value: "no_payment", label: "Not paid" },
  { value: "ticketing_deadline", label: "Ticketing deadline passed" },
  { value: "airline_request", label: "The airline asked" },
  { value: "other", label: "Other" },
] as const satisfies readonly Choice[];
export type CancelReasonCode = (typeof CANCEL_REASON_CODES)[number]["value"];

/** `ConsolePaymentRefundRequest.reason`. */
export const REFUND_REASONS = [
  { value: "customer_request", label: "The customer asked" },
  { value: "booking_cancelled", label: "Booking cancelled" },
  { value: "schedule_change", label: "Schedule change" },
  { value: "duplicate", label: "Duplicate payment" },
  { value: "fraud", label: "Fraud" },
  { value: "goodwill", label: "Goodwill" },
  { value: "other", label: "Other" },
] as const satisfies readonly Choice[];
export type RefundReason = (typeof REFUND_REASONS)[number]["value"];

/**
 * The `other` forms of payment an airline-card booking is issued with (OADR-0018 point 8, the backend's
 * `AIRLINE_CARD_SETTLEMENT_METHODS`): the OTA's own settlement with the airline. Never a card.
 */
export const SETTLEMENT_METHODS = [
  { value: "ACCOUNT", label: "ACCOUNT: the OTA's account with the airline" },
  { value: "CASH", label: "CASH: settled by the OTA" },
] as const satisfies readonly Choice[];
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number]["value"];

/** `refund.mode` of a cancellation. */
export type RefundMode = "none" | "full" | "amount";

/** Amadeus `gender` of a traveller. */
export const GENDERS = [
  { value: "MALE", label: "Male" },
  { value: "FEMALE", label: "Female" },
  { value: "UNSPECIFIED", label: "Unspecified" },
  { value: "UNDISCLOSED", label: "Undisclosed" },
] as const satisfies readonly Choice[];
export type Gender = (typeof GENDERS)[number]["value"];

/** Amadeus contact purposes. */
export const CONTACT_PURPOSES = [
  { value: "STANDARD", label: "Standard" },
  { value: "INVOICE", label: "Invoice" },
  { value: "STANDARD_WITHOUT_TRANSMISSION", label: "Standard, not sent to the airline" },
] as const satisfies readonly Choice[];
export type ContactPurpose = (typeof CONTACT_PURPOSES)[number]["value"];

/** Amadeus phone device types. */
export const PHONE_DEVICE_TYPES = ["MOBILE", "LANDLINE", "FAX"] as const;
export type PhoneDeviceType = (typeof PHONE_DEVICE_TYPES)[number];

/** A stored phone as `kept` carries it. */
export interface KeptPhone {
  readonly deviceType?: PhoneDeviceType;
  readonly countryCallingCode?: string;
  readonly number?: string;
}

/**
 * A stored contact as `kept` carries it (`KEPT_FIELD`): the parts of an Amadeus contact, text only, without empty
 * values and without what the booking adds to it (`id`, `isPrimary`).
 */
export interface KeptContact {
  readonly addresseeName?: {
    readonly firstName?: string;
    readonly middleName?: string;
    readonly lastName?: string;
    readonly secondLastName?: string;
  };
  readonly companyName?: string;
  readonly emailAddress?: string;
  readonly phones?: readonly KeptPhone[];
  readonly address?: {
    readonly lines?: readonly string[];
    readonly postalCode?: string;
    readonly countryCode?: string;
    readonly cityName?: string;
    readonly stateName?: string;
    readonly postalBox?: string;
  };
  readonly language?: string;
  readonly purpose?: ContactPurpose;
}

const NAME_PARTS = ["firstName", "middleName", "lastName", "secondLastName"] as const;
const ADDRESS_PARTS = ["postalCode", "countryCode", "cityName", "stateName", "postalBox"] as const;
const CONTACT_TEXT_PARTS = ["companyName", "emailAddress", "language"] as const;

/** `value`'s non-empty text properties of `keys`. */
function textParts<K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const parts: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const part = record[key];
    if (typeof part === "string" && part !== "") {
      parts[key] = part;
    }
  }
  return parts;
}

/** `value` is one of `values`. */
function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** The stored contact `contact` as `kept` carries it (`KeptContact`), or `undefined` when it has nothing. */
export function keptContactOf(contact: object | null | undefined): KeptContact | undefined {
  if (contact === null || contact === undefined) {
    return undefined;
  }
  const record = contact as Record<string, unknown>;
  const name = textParts(record["addresseeName"], NAME_PARTS);
  const storedAddress = record["address"];
  const address = textParts(storedAddress, ADDRESS_PARTS);
  const storedLines =
    typeof storedAddress === "object" && storedAddress !== null
      ? (storedAddress as Record<string, unknown>)["lines"]
      : undefined;
  const lines = Array.isArray(storedLines)
    ? storedLines.filter((line): line is string => typeof line === "string" && line !== "").slice(0, 10)
    : [];
  const phones = (Array.isArray(record["phones"]) ? (record["phones"] as unknown[]) : [])
    .map((phone): KeptPhone => {
      const deviceType =
        typeof phone === "object" && phone !== null
          ? (phone as Record<string, unknown>)["deviceType"]
          : undefined;
      return {
        ...(oneOf(PHONE_DEVICE_TYPES, deviceType) ? { deviceType } : {}),
        ...textParts(phone, ["countryCallingCode", "number"] as const),
      };
    })
    .filter((phone) => Object.keys(phone).length > 0)
    .slice(0, 3);
  const purpose = record["purpose"];
  const kept: KeptContact = {
    ...(Object.keys(name).length === 0 ? {} : { addresseeName: name }),
    ...textParts(record, CONTACT_TEXT_PARTS),
    ...(phones.length === 0 ? {} : { phones }),
    ...(Object.keys(address).length === 0 && lines.length === 0
      ? {}
      : { address: { ...(lines.length === 0 ? {} : { lines }), ...address } }),
    ...(oneOf(valuesOf(CONTACT_PURPOSES), purpose) ? { purpose } : {}),
  };
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** `kept` as its hidden field holds it (JSON), or `undefined` when there is nothing to keep. */
export function keptFieldOf(kept: KeptContact | undefined): string | undefined {
  return kept === undefined ? undefined : JSON.stringify(kept);
}

/**
 * The general remark types staff may add. `BACKOFFICE` is left out: the order's `VELEXIS <reference>` remark is that
 * type, and the backend keeps it.
 */
export const REMARK_TYPES = [
  { value: "GENERAL_MISCELLANEOUS", label: "General" },
  { value: "CONFIDENTIAL", label: "Confidential" },
  { value: "INVOICE", label: "Invoice" },
  { value: "QUALITY_CONTROL", label: "Quality control" },
  { value: "FULFILLMENT", label: "Fulfilment" },
  { value: "ITINERARY", label: "Itinerary" },
  { value: "TICKETING_MISCELLANEOUS", label: "Ticketing" },
  { value: "TOUR_CODE", label: "Tour code" },
] as const satisfies readonly Choice[];
export type RemarkType = (typeof REMARK_TYPES)[number]["value"];

/** Amadeus ticketing agreement options; the two `DELAY_*` need a delay in days (`2D`). */
export const AGREEMENT_OPTIONS = [
  { value: "CONFIRM", label: "Confirm: ticket when the payment is done" },
  { value: "DELAY_TO_QUEUE", label: "Queue the order after a delay without issuance" },
  { value: "DELAY_TO_CANCEL", label: "Cancel the order after a delay without issuance" },
] as const satisfies readonly Choice[];
export type AgreementOption = (typeof AGREEMENT_OPTIONS)[number]["value"];

/** A ticketing agreement's delay: whole days, `1D` to `365D`. */
export const AGREEMENT_DELAY_PATTERN = /^(?:[1-9][0-9]?|[1-2][0-9]{2}|3[0-5][0-9]|36[0-5])D$/;

/** The values of a list of choices. */
export function valuesOf<T extends string>(choices: readonly Choice<T>[]): [T, ...T[]] {
  const values = choices.map((choice) => choice.value);
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error("a list of choices is never empty");
  }
  return [first, ...rest];
}

/** The words of `value` in `choices`, else the value itself. */
export function labelOfChoice(choices: readonly Choice[], value: string): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}

// ---- Amounts ----------------------------------------------------------------------------------------------------------

/** A `Money.amount` of the API: a decimal string with at most four decimals. */
const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]{1,4}))?$/;
/** Ten-thousandths: the finest `Money.amount`. */
const SCALE = 4;

/** An amount in whole ten-thousandths, or `undefined` when it is not a decimal string. */
export function amountUnits(amount: string): bigint | undefined {
  const match = DECIMAL.exec(amount);
  if (match === null) {
    return undefined;
  }
  const [, sign = "", whole = "0", fraction = ""] = match;
  const units = BigInt(`${whole}${fraction.padEnd(SCALE, "0")}`);
  return sign === "-" ? -units : units;
}

/** Whole ten-thousandths as a decimal string with two decimals, or up to four when the amount has them. */
export function unitsAmount(units: bigint): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(SCALE + 1, "0");
  const whole = digits.slice(0, -SCALE);
  let fraction = digits.slice(-SCALE);
  while (fraction.length > 2 && fraction.endsWith("0")) {
    fraction = fraction.slice(0, -1);
  }
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** `a − b` of two amounts of one currency, or `undefined` when either is not a decimal string. */
export function subtractAmounts(a: MoneyValue, b: MoneyValue): MoneyValue | undefined {
  const left = amountUnits(a.amount);
  const right = amountUnits(b.amount);
  if (left === undefined || right === undefined || a.currency !== b.currency) {
    return undefined;
  }
  return { amount: unitsAmount(left - right), currency: a.currency };
}

/** The amount is a decimal string above zero. */
export function isPositiveAmount(amount: string): boolean {
  const units = amountUnits(amount);
  return units !== undefined && units > 0n;
}

/**
 * An amount as staff may type it for a capture or a refund: digits with at most two decimals, above zero (the API's
 * request rule for card currencies; a currency with fewer minor units is refused by the API with its field error).
 */
export const TYPED_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/;

/** `amount` is not above `limit` (both decimal strings). */
export function amountWithin(amount: string, limit: string): boolean {
  const value = amountUnits(amount);
  const max = amountUnits(limit);
  return value !== undefined && max !== undefined && value <= max;
}

// ---- Issue ------------------------------------------------------------------------------------------------------------

type BookingPayment = ConsoleBooking["payments"][number];

/** The roles that may issue a booking whose payment is not captured (`allowUnpaid`, OADR-0008). */
export const ALLOW_UNPAID_ROLES: readonly StaffRole[] = Object.freeze(["owner", "admin"]);

/** A payment taken by the airline with the traveller's card (OADR-0004). */
export function isAirlinePayment(payment: Pick<BookingPayment, "method" | "provider">): boolean {
  return payment.method === "airline_card" || payment.provider === "airline";
}

/** A Stripe payment. */
function isStripe(payment: Pick<BookingPayment, "provider">): boolean {
  return payment.provider === "stripe";
}

/** The payment statuses of a payment that captured money. */
const CAPTURED_STATUSES: ReadonlySet<string> = new Set(["captured", "partially_refunded"]);

/** A flight offer id of an Amadeus order (`"1"`). */
export const FLIGHT_OFFER_ID_PATTERN = /^[0-9A-Za-z]{1,10}$/;

/**
 * The booking's flight offers (`flightOfferIds` of an `other` form of payment): the offers of its segments, else of
 * its record locators and forms of payment, else `["1"]` (an order of one offer).
 */
export function flightOfferIdsOf(booking: ConsoleBooking): string[] {
  const ids = new Set<string>();
  for (const itinerary of booking.itineraries) {
    for (const segment of itinerary.segments) {
      if (FLIGHT_OFFER_ID_PATTERN.test(segment.flightOfferId)) {
        ids.add(segment.flightOfferId);
      }
    }
  }
  if (ids.size === 0) {
    for (const id of [
      ...booking.recordLocators.map((record) => record.flightOfferId),
      ...booking.formOfPayments.flatMap((form) => form.flightOfferIds),
    ]) {
      if (typeof id === "string" && FLIGHT_OFFER_ID_PATTERN.test(id)) {
        ids.add(id);
      }
    }
  }
  return ids.size === 0 ? ["1"] : [...ids].slice(0, 6);
}

/** How the issue dialog issues a booking. */
export type IssuePlan =
  /**
   * An airline-card booking: the card cannot be charged again, so the dialog asks for the OTA's settlement (`CASH` or
   * `ACCOUNT`) for `flightOfferIds`; no capture, no card. `charged`: the airline charged the card (a payment
   * `captured`); when it did not, the API counts the booking as unpaid, and only an owner or an admin may issue it
   * (`allowUnpaid`).
   */
  | {
      readonly kind: "airline_card";
      readonly flightOfferIds: readonly string[];
      readonly charged: boolean;
    }
  /** A Stripe authorisation, captured before the issuance. */
  | { readonly kind: "capture"; readonly amount: MoneyValue }
  /** Paid already (captured), or a console or imported booking without payment. */
  | { readonly kind: "paid" | "not_applicable" }
  /** Not paid: issued only with `allowUnpaid` (owner and admin). */
  | { readonly kind: "unpaid" };

/** What issuing `booking` takes (see `IssuePlan`). */
export function issuePlanOf(booking: ConsoleBooking): IssuePlan {
  if (booking.payments.some(isAirlinePayment)) {
    return {
      kind: "airline_card",
      flightOfferIds: flightOfferIdsOf(booking),
      // As the API's issuePaymentOf counts it: a payment that captured money pays the issuance.
      charged: booking.payments.some((payment) => CAPTURED_STATUSES.has(payment.status)),
    };
  }
  if (booking.payments.some((payment) => CAPTURED_STATUSES.has(payment.status))) {
    return { kind: "paid" };
  }
  const authorized = booking.payments.find((payment) => isStripe(payment) && payment.status === "authorized");
  if (authorized !== undefined) {
    return { kind: "capture", amount: authorized.amountAuthorized };
  }
  return booking.paymentStatus === "not_applicable" ? { kind: "not_applicable" } : { kind: "unpaid" };
}

/** The role may send `allowUnpaid`. */
export function canAllowUnpaid(role: StaffRole): boolean {
  return ALLOW_UNPAID_ROLES.includes(role);
}

// ---- Cancel -----------------------------------------------------------------------------------------------------------

/** What Amadeus is asked for by a cancellation (routes.md §3.2: release / void / request-only). */
export type CancelSupplierStep = "release" | "void" | "request_only";

/** The payment a cancellation's money step acts on, as the dialog offers its refund. */
export type CancelMoney =
  | { readonly kind: "none" }
  | { readonly kind: "airline" }
  | { readonly kind: "captured"; readonly refundable: MoneyValue }
  | { readonly kind: "authorized"; readonly authorized: MoneyValue };

/** What cancelling `booking` does: the Amadeus step and the payment's refund modes. */
export interface CancelPlan {
  /**
   * The Amadeus step, the API's `cancellationMode.mode`; `null` when the answer has none (the API cannot cancel the
   * booking, or an answer from before the field): the dialog then names no step.
   */
  readonly supplier: CancelSupplierStep | null;
  readonly money: CancelMoney;
  /** The refund modes the dialog offers, the default first. */
  readonly modes: readonly RefundMode[];
  /** The currency of an `amount` (the booking's). */
  readonly currency: string;
}

/**
 * The Amadeus step of a cancellation as the API decides it (`ConsoleBooking.cancellationMode`, see the file header):
 * `release` without a ticket that holds a seat, `void` when every such ticket was issued today in the OTA's time zone
 * (the void window closes at midnight there, `voidDeadlineAt`), `request_only` otherwise; `null` without a mode.
 */
export function cancelSupplierStepOf(booking: ConsoleBooking): CancelSupplierStep | null {
  return booking.cancellationMode?.mode ?? null;
}

/** The payment a cancellation's money step acts on (the airline card first: it is never refunded through Stripe). */
export function cancelMoneyOf(booking: ConsoleBooking): CancelMoney {
  if (booking.payments.some(isAirlinePayment)) {
    return { kind: "airline" };
  }
  const captured = booking.payments.find(
    (payment) => isStripe(payment) && CAPTURED_STATUSES.has(payment.status),
  );
  if (captured !== undefined) {
    const refundable = subtractAmounts(captured.amountCaptured, captured.amountRefunded);
    if (refundable !== undefined) {
      return { kind: "captured", refundable };
    }
  }
  const authorized = booking.payments.find((payment) => isStripe(payment) && payment.status === "authorized");
  if (authorized !== undefined) {
    return { kind: "authorized", authorized: authorized.amountAuthorized };
  }
  return { kind: "none" };
}

/** The refund modes of a payment, the default first: nothing back from a capture, a release of an authorisation. */
export function refundModesOf(money: CancelMoney): readonly RefundMode[] {
  switch (money.kind) {
    case "captured":
      return ["none", "full", "amount"];
    case "authorized":
      return ["full", "amount", "none"];
    case "airline":
    case "none":
      return ["none"];
  }
}

/** What cancelling `booking` does (see `CancelPlan`). */
export function cancelPlanOf(booking: ConsoleBooking): CancelPlan {
  const money = cancelMoneyOf(booking);
  return {
    supplier: cancelSupplierStepOf(booking),
    money,
    modes: refundModesOf(money),
    currency: booking.totals.currency,
  };
}

// ---- Payments ---------------------------------------------------------------------------------------------------------

/** A payment staff may capture now: an `authorized` Stripe payment. */
export function capturableOf(payment: ConsolePayment): MoneyValue | undefined {
  return isStripe(payment) && payment.status === "authorized" ? payment.amountAuthorized : undefined;
}

/** The refunds the API still counts against what is refundable: asked for, not finished at Stripe. */
export const IN_FLIGHT_REFUND_STATUSES: ReadonlySet<string> = new Set(["pending", "processing"]);

/**
 * The refunds of `payment` still on their way to Stripe (`pending`, `processing`), summed, or `undefined` when there are
 * none or one of them cannot be counted (not a decimal string, or not in the payment's currency, which the API never
 * answers): what is refundable is then shown as captured less refunded, and the API decides.
 */
export function refundsInFlightOf(
  payment: Pick<ConsolePayment, "amount" | "refunds">,
): MoneyValue | undefined {
  let units = 0n;
  for (const refund of payment.refunds) {
    if (!IN_FLIGHT_REFUND_STATUSES.has(refund.status)) {
      continue;
    }
    const amount = amountUnits(refund.amount.amount);
    if (amount === undefined || refund.amount.currency !== payment.amount.currency) {
      return undefined;
    }
    units += amount;
  }
  return units > 0n ? { amount: unitsAmount(units), currency: payment.amount.currency } : undefined;
}

/**
 * What staff may still refund of a payment now, as the API counts it (`refundableAmount` of the backend's
 * refunds.repository.ts): a Stripe payment that captured money, less what was refunded, less the refunds still on their
 * way to Stripe (`refundsInFlightOf`); never an airline-card payment (`refund_via_airline`). `undefined` when nothing is
 * left. The booking page's Payments tab and the payment's own page show and offer the same figure (FIX-W32-OTA, lead
 * decision (1h) of 2026-10-28: the booking page subtracted no refund in flight until then).
 */
export function refundableOf(payment: ConsolePayment): MoneyValue | undefined {
  if (!isStripe(payment) || isAirlinePayment(payment) || !CAPTURED_STATUSES.has(payment.status)) {
    return undefined;
  }
  const refundable = subtractAmounts(payment.amountCaptured, payment.amountRefunded);
  if (refundable === undefined) {
    return undefined;
  }
  const inFlight = refundsInFlightOf(payment);
  const rest = inFlight === undefined ? refundable : subtractAmounts(refundable, inFlight);
  return rest !== undefined && isPositiveAmount(rest.amount) ? rest : undefined;
}
