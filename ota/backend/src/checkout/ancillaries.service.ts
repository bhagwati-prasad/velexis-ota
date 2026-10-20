// checkout.setAncillaries (setCheckoutAncillaries, `x-scope: both`; OBE-037; ota/docs/flows/checkout-stripe.md §2
// step 2, OADR-0005 point 7, the OTA document's operation). The selections replace the checkout's extras: checked and
// cabin bags, other services (PRIORITY_BOARDING, AIRPORT_CHECKIN, FAST_TRACK) and chargeable seats.
//
//   1. the checkout as checkout.get reads it (access as the checkout's, `404` otherwise, another tenant's id included):
//      completed `409 CHECKOUT_ALREADY_COMPLETED` (`details.bookingId`), expired or abandoned `410 CHECKOUT_EXPIRED`, a
//      stale `If-Match` `412 PRECONDITION_FAILED`;
//   2. the catalogue of the checkout's base priced offer, as flights.getAncillaries loads it (`403 FEATURE_DISABLED` in
//      customer scope while the storefront sells no ancillaries); each selection must be one of its options, by
//      `optionId` or explicitly by `type` (with `serviceName`, `seatNumber`, `quantity`, `weight`), for a traveller
//      and segments of that option (`planExtras`): otherwise `422 ANCILLARY_NOT_AVAILABLE` with
//      `details.selectionIndex` and `details.reason` (`unknown_option`, `not_bookable_for_traveler`,
//      `not_bookable_for_segment`, `quantity_exceeded`); two selections for the same traveller, segment and kind are
//      `400 VALIDATION_FAILED`, Amadeus taking one bag item, one seat and a list of services per traveller and segment.
//      An empty `selections` needs no catalogue: only the feature is checked, so no catalogue load calls Amadeus;
//   3. Flight Offers Price, outside any transaction: the base priced offer's confirmed Amadeus offers (net, verbatim
//      from `priced_offers`) with the selections in `travelerPricings[].fareDetailsBySegment[].additionalServices`,
//      the travellers entered so far (name, date of birth, gender) and `include=bags,other-services`
//      (`buildServicesRequest`). Amadeus errors 4926 and 32171 on a selection are `422 ANCILLARY_NOT_AVAILABLE`
//      (`rejected_by_airline`, `seat_unavailable` for a seat), `409 SOLD_OUT` and the timeouts and outages stay as the
//      client maps them, anything else is `502 SUPPLIER_ERROR` (`servicesErrorOf`). An empty `selections` reverts to
//      the base priced offer without a call, unless the base priced offer expired: then it is priced again without
//      extras;
//   4. one transaction locks the checkout and checks it again (state and `If-Match`), stores the answer as a child
//      priced offer (`parent_priced_offer_id` = the base; PricedOffersService.storeServicesPricing: the flights keep
//      the base's markup and booking fees while Amadeus confirms their net, otherwise they are priced again), and
//      prices the extras: each extra's net is Amadeus's `price.additionalServices` of its kind, shared over the
//      extras of that kind by their catalogue prices, or the catalogue price where Amadeus states none (`extraNets`),
//      plus one `ancillary_service` fee per extra from the engine (OADR-0005 point 7). The checkout's totals follow:
//      `offer` = the child's selling total (the flights), `ancillaries` = Σ of the extras' selling prices, the card
//      fee unchanged, `total = offer + ancillaries + cardFee` (the `checkouts_total_ck` CHECK). With `expectedTotal`, a
//      new total that differs answers `409 PRICE_CHANGED` (`details.oldPrice` = the expected total, `newPrice`,
//      `pricedOfferId` = the stored child) and the checkout is left unchanged: its priced offer, extras, totals and
//      `version`. Otherwise `checkout_ancillaries` are replaced, `checkouts.priced_offer_id` points at the child and the
//      `version` is bumped; the answer is the whole checkout.
//
// The checkout's payment is not touched (the payments module reads the checkout, not the other way round): a payment
// that is not confirmed yet is re-quoted by checkout.updatePayment or replaced by checkout.createPayment, whose
// amounts start from the checkout's offer and extras, and checkout.complete compares the authorised amount with the
// checkout's total.
import { Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import type { Insertable, TenantDatabase } from "@velexis/db";
import { AppError, type FieldError } from "@velexis/errors";
import { PinoLogger } from "nestjs-pino";
import { AmadeusClient, type AmadeusResponse } from "../amadeus/amadeus.client";
import { AMADEUS_ERROR_CODES, AmadeusCallError } from "../amadeus/error-mapper";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { Money, type FeeLine, type MoneyValue, type PricingExtra } from "../pricing/pricing.types";
import { distribute, parseOffer } from "../shopping/offers.mapper";
import {
  confirmedOffersOf,
  pricingQuery,
  readPricingReply,
  snapshotOf,
  type AmadeusPricingRequest,
  type ConfirmedOffer,
  type PricingInclude,
} from "../shopping/priced-offers.mapper";
import type { PricedOfferRow } from "../shopping/priced-offers.repository";
import {
  additionalServiceAmounts,
  PricedOffersService,
  type CheckoutPricedOffer,
} from "../shopping/priced-offers.service";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { effectiveStatus, ifMatchSatisfied, type Checkout } from "./checkout.mapper";
import { CheckoutRepository } from "./checkout.repository";
import { CheckoutService, type CheckoutStepInput } from "./checkout.service";

type Schemas = components["schemas"];
export type CheckoutAncillariesRequest = Schemas["CheckoutAncillariesRequest"];
type AncillarySelection = Schemas["AncillarySelection"];
type AncillaryCatalogue = Schemas["AncillaryCatalogue"];
type AncillaryOption = Schemas["AncillaryOption"];
type AncillaryType = AncillaryOption["type"];
type ServiceName = Schemas["AmadeusServiceName"];
type AmadeusTraveler = Schemas["AmadeusTraveler"];
type MoneyAmount = Schemas["Money"];
type CheckoutAncillaryInsert = Insertable<TenantDatabase["checkout_ancillaries"]>;

/** The `include` of the re-pricing (the document: `include=bags,other-services`). */
export const SERVICES_INCLUDE: readonly PricingInclude[] = Object.freeze(["bags", "other-services"]);

/** The Amadeus data errors that, on a selection, mean the airline rejected it. */
const REJECTION_CODES: ReadonlySet<number> = new Set([
  AMADEUS_ERROR_CODES.invalidData,
  AMADEUS_ERROR_CODES.mandatoryDataMissing,
]);

/** The supplier errors answered as the client mapped them (the operation's `x-error-codes`). */
const SUPPLIER_CODES_KEPT: ReadonlySet<string> = new Set([
  "SOLD_OUT",
  "OFFER_EXPIRED",
  "SUPPLIER_ERROR",
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_TIMEOUT",
  "SUPPLIER_NOT_CONFIGURED",
  "SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
]);

/** `details.reason` of `422 ANCILLARY_NOT_AVAILABLE` (the error catalogue's list). */
export type UnavailableReason =
  | "unknown_option"
  | "not_bookable_for_traveler"
  | "not_bookable_for_segment"
  | "quantity_exceeded"
  | "rejected_by_airline"
  | "seat_unknown"
  | "seat_unavailable";

/** One selection resolved against the catalogue. */
export interface PlannedExtra {
  /** Its position in `selections`. */
  readonly index: number;
  /** Its reference in the engine's fee lines (`extraRef`). */
  readonly ref: string;
  readonly option: AncillaryOption;
  readonly type: AncillaryType;
  readonly offerId: string;
  readonly amadeusOfferId: string;
  readonly travelerId: string;
  readonly segmentIds: readonly string[];
  /** Bags: the pieces; 1 for a service or a seat. */
  readonly quantity: number;
  readonly weight: number | null;
  readonly weightUnit: string | null;
  readonly serviceName: ServiceName | null;
  readonly seatNumber: string | null;
  /** The catalogue's price of the option (net: ancillaries carry no markup); `null` for a seat. */
  readonly cataloguePrice: string | null;
}

// ---- Selections ----------------------------------------------------------------------------------------------------

const BAGS: ReadonlySet<AncillaryType> = new Set(["CHECKED_BAGS", "CABIN_BAGS"]);

function unavailable(
  index: number,
  reason: UnavailableReason,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): AppError {
  return new AppError("ANCILLARY_NOT_AVAILABLE", {
    message,
    details: { selectionIndex: index, reason, ...details },
  });
}

function invalid(fieldErrors: readonly FieldError[]): AppError {
  return new AppError("VALIDATION_FAILED", { fieldErrors });
}

/** A field of a selection that does not belong to its kind: `400` (the value is never echoed). */
function misplacedField(
  selection: AncillarySelection,
  index: number,
  type: AncillaryType,
): AppError | undefined {
  const misplaced: Array<[keyof AncillarySelection, boolean]> = [
    ["seatNumber", type !== "SEATS"],
    ["serviceName", type !== "OTHER_SERVICES"],
    ["weight", !BAGS.has(type)],
    ["weightUnit", !BAGS.has(type)],
  ];
  const field = misplaced.find(([name, wrong]) => wrong && selection[name] !== undefined)?.[0];
  return field === undefined
    ? undefined
    : invalid([
        {
          path: `/selections/${index}/${field}`,
          code: "not_allowed",
          message: `This field does not apply to ${type}.`,
        },
      ]);
}

/** How far a selection got against an option: a plan, or the reason it stopped, the later the more telling. */
type Fit =
  | { readonly kind: "ok"; readonly extra: PlannedExtra }
  | {
      readonly kind: "no";
      readonly stage: number;
      readonly reason: UnavailableReason;
      readonly message: string;
    };

const sameMembers = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item) => b.includes(item));

/** The selection on one option: its traveller, its segments, then what it asks of the option (see the header). */
function fit(selection: AncillarySelection, index: number, option: AncillaryOption): Fit {
  if (!option.travelerIds.includes(selection.travelerId)) {
    return {
      kind: "no",
      stage: 1,
      reason: "not_bookable_for_traveler",
      message: "This extra cannot be booked for this traveller.",
    };
  }
  const segmentIds = [...new Set(selection.segmentIds ?? option.segmentIds)];
  if (
    !segmentIds.every((id) => option.segmentIds.includes(id)) ||
    (option.bookableByItinerary === false && !sameMembers(segmentIds, option.segmentIds))
  ) {
    return {
      kind: "no",
      stage: 2,
      reason: "not_bookable_for_segment",
      message: "This extra cannot be booked for these flights.",
    };
  }
  const bags = BAGS.has(option.type);
  const quantity = selection.quantity ?? (bags ? (option.quantity ?? 1) : 1);
  const offered = bags ? (option.quantity ?? 1) : 1;
  if (quantity !== offered) {
    return quantity > offered
      ? { kind: "no", stage: 3, reason: "quantity_exceeded", message: "This quantity cannot be booked." }
      : { kind: "no", stage: 3, reason: "unknown_option", message: "No extra matches this selection." };
  }
  if (
    (selection.weight !== undefined && selection.weight !== option.weight) ||
    (selection.weightUnit !== undefined && selection.weightUnit !== option.weightUnit) ||
    (selection.serviceName !== undefined && selection.serviceName !== option.serviceName)
  ) {
    return { kind: "no", stage: 3, reason: "unknown_option", message: "No extra matches this selection." };
  }
  return {
    kind: "ok",
    extra: {
      index,
      ref: `selection:${index}`,
      option,
      type: option.type,
      offerId: option.offerId,
      amadeusOfferId: option.amadeus.flightOfferId,
      travelerId: selection.travelerId,
      segmentIds,
      quantity,
      weight: bags ? (option.weight ?? null) : null,
      weightUnit: bags ? (option.weightUnit ?? null) : null,
      serviceName: option.type === "OTHER_SERVICES" ? (option.serviceName ?? null) : null,
      seatNumber: option.type === "SEATS" ? (selection.seatNumber ?? null) : null,
      cataloguePrice: option.netPrice?.amount ?? option.price?.amount ?? null,
    },
  };
}

/** One selection as an extra of the catalogue, or the error it answers. */
function planOne(selection: AncillarySelection, index: number, catalogue: AncillaryCatalogue): PlannedExtra {
  const options = [
    ...catalogue.checkedBags,
    ...catalogue.cabinBags,
    ...catalogue.otherServices,
    ...catalogue.seats,
  ];
  let candidates: AncillaryOption[];
  if (selection.optionId !== undefined) {
    const option = options.find((entry) => entry.id === selection.optionId);
    if (
      option === undefined ||
      (selection.type !== undefined && selection.type !== option.type) ||
      (selection.offerId !== undefined && selection.offerId !== option.offerId)
    ) {
      throw unavailable(index, "unknown_option", "This extra is not offered for this checkout.");
    }
    candidates = [option];
  } else {
    if (selection.type === undefined) {
      throw invalid([
        { path: `/selections/${index}/type`, code: "required", message: "Give an optionId or a type." },
      ]);
    }
    if (selection.type === "OTHER_SERVICES" && selection.serviceName === undefined) {
      throw invalid([
        {
          path: `/selections/${index}/serviceName`,
          code: "required",
          message: "Name the service to add.",
        },
      ]);
    }
    const offerId = selection.offerId ?? catalogue.segments[0]?.offerId;
    candidates = options.filter((option) => option.type === selection.type && option.offerId === offerId);
  }
  const type = candidates[0]?.type ?? selection.type;
  if (type !== undefined) {
    const misplaced = misplacedField(selection, index, type);
    if (misplaced !== undefined) {
      throw misplaced;
    }
    if (type === "SEATS" && selection.seatNumber === undefined) {
      throw invalid([
        {
          path: `/selections/${index}/seatNumber`,
          code: "required",
          message: "A seat is bought by its number.",
        },
      ]);
    }
  }
  let furthest: Extract<Fit, { kind: "no" }> | undefined;
  for (const option of candidates) {
    const result = fit(selection, index, option);
    if (result.kind === "ok") {
      return result.extra;
    }
    if (furthest === undefined || result.stage > furthest.stage) {
      furthest = result;
    }
  }
  if (furthest === undefined) {
    throw unavailable(index, "unknown_option", "This extra is not offered for this checkout.");
  }
  throw unavailable(index, furthest.reason, furthest.message);
}

/** The Amadeus slot an extra fills per traveller and segment: one bag item of each kind, one seat, each service once. */
function slotOf(extra: PlannedExtra): string {
  return extra.type === "OTHER_SERVICES" ? `OTHER_SERVICES:${extra.serviceName ?? ""}` : extra.type;
}

/**
 * The selections resolved against the catalogue, in their order (see the file header, step 2); throws `422
 * ANCILLARY_NOT_AVAILABLE` or `400 VALIDATION_FAILED` for the first selection that cannot be sold.
 */
export function planExtras(
  selections: readonly AncillarySelection[],
  catalogue: AncillaryCatalogue,
): PlannedExtra[] {
  const extras = selections.map((selection, index) => planOne(selection, index, catalogue));
  const slots = new Map<string, number>();
  for (const extra of extras) {
    for (const segmentId of extra.segmentIds) {
      const key = [extra.amadeusOfferId, extra.travelerId, segmentId, slotOf(extra)].join("\u0000");
      const first = slots.get(key);
      if (first !== undefined) {
        throw invalid([
          {
            path: `/selections/${extra.index}`,
            code: "duplicate",
            message: `Selection ${first} already adds this kind of extra for this traveller and flight.`,
          },
        ]);
      }
      slots.set(key, extra.index);
    }
  }
  return extras;
}

// ---- The Amadeus request -----------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** A fare detail of a request offer: where an extra's `additionalServices` go, and its JSON pointer. */
interface FareDetailSlot {
  readonly detail: JsonObject;
  readonly pointer: string;
}

/** The request and, per fare detail that carries extras, the selections it carries (to read Amadeus's pointers). */
export interface ServicesRequest {
  readonly request: AmadeusPricingRequest;
  readonly pointers: ReadonlyMap<string, readonly number[]>;
}

/** The travellers entered so far as Amadeus travellers (name, date of birth, gender), those with anything entered. */
export function travelersOf(travelers: Checkout["travelers"]): AmadeusTraveler[] {
  return travelers.flatMap((traveler) => {
    const entry: AmadeusTraveler = { id: traveler.travelerId };
    const name = traveler.name;
    if (name?.firstName !== undefined && name.lastName !== undefined) {
      entry.name = { firstName: name.firstName, lastName: name.lastName };
    }
    if (typeof traveler.dateOfBirth === "string") {
      entry.dateOfBirth = traveler.dateOfBirth;
    }
    if (typeof traveler.gender === "string") {
      entry.gender = traveler.gender;
    }
    return Object.keys(entry).length > 1 ? [entry] : [];
  });
}

/**
 * The Flight Offers Price request (see the file header, step 3): copies of the base priced offer's confirmed offers
 * whose fare details carry exactly the selected extras (any `additionalServices` the stored offers had are dropped).
 * An extra whose traveller or segment the stored offer lacks is `422 ANCILLARY_NOT_AVAILABLE`.
 */
export function buildServicesRequest(
  offers: ReadonlyArray<{ readonly amadeusOfferId: string; readonly payload: unknown }>,
  extras: readonly PlannedExtra[],
  travelers: readonly AmadeusTraveler[],
  fareRules: boolean,
): ServicesRequest {
  const payloads = offers.map((offer) => structuredClone(offer.payload));
  for (const payload of payloads) {
    for (const pricing of records(isRecord(payload) ? payload["travelerPricings"] : undefined)) {
      for (const detail of records(pricing["fareDetailsBySegment"])) {
        delete detail["additionalServices"];
      }
    }
  }
  const slotOfDetail = (extra: PlannedExtra, segmentId: string): FareDetailSlot | undefined => {
    const offerIndex = offers.findIndex((offer) => offer.amadeusOfferId === extra.amadeusOfferId);
    const payload = payloads[offerIndex];
    const pricings = records(isRecord(payload) ? payload["travelerPricings"] : undefined);
    const pricingIndex = pricings.findIndex((pricing) => pricing["travelerId"] === extra.travelerId);
    const details = records(pricings[pricingIndex]?.["fareDetailsBySegment"]);
    const detailIndex = details.findIndex((detail) => detail["segmentId"] === segmentId);
    const detail = details[detailIndex];
    return detail === undefined
      ? undefined
      : {
          detail,
          pointer: `/data/flightOffers/${offerIndex}/travelerPricings/${pricingIndex}/fareDetailsBySegment/${detailIndex}`,
        };
  };
  const pointers = new Map<string, number[]>();
  for (const extra of extras) {
    for (const segmentId of extra.segmentIds) {
      const slot = slotOfDetail(extra, segmentId);
      if (slot === undefined) {
        throw unavailable(
          extra.index,
          "not_bookable_for_segment",
          "This extra cannot be booked for these flights.",
        );
      }
      const services = isRecord(slot.detail["additionalServices"]) ? slot.detail["additionalServices"] : {};
      const allowance = {
        quantity: extra.quantity,
        ...(extra.weight === null ? {} : { weight: extra.weight }),
        ...(extra.weightUnit === null ? {} : { weightUnit: extra.weightUnit }),
      };
      switch (extra.type) {
        case "CHECKED_BAGS":
          services["chargeableCheckedBags"] = allowance;
          break;
        case "CABIN_BAGS":
          services["chargeableCabinBags"] = allowance;
          break;
        case "SEATS":
          services["chargeableSeat"] = { number: extra.seatNumber };
          break;
        case "OTHER_SERVICES":
          services["otherServices"] = [
            ...(Array.isArray(services["otherServices"]) ? services["otherServices"] : []),
            extra.serviceName,
          ];
          break;
      }
      slot.detail["additionalServices"] = services;
      pointers.set(slot.pointer, [...(pointers.get(slot.pointer) ?? []), extra.index]);
    }
  }
  return {
    request: {
      data: {
        type: "flight-offers-pricing",
        flightOffers: payloads,
        ...(travelers.length === 0 ? {} : { travelers: [...travelers] }),
        additionalInformation: { fareRules },
      },
    },
    pointers,
  };
}

/** The `additionalServices` member an Amadeus pointer names below a fare detail, as the kind of extra it holds. */
const MEMBER_TYPES: ReadonlyArray<readonly [string, AncillaryType]> = [
  ["chargeableCheckedBags", "CHECKED_BAGS"],
  ["chargeableCabinBags", "CABIN_BAGS"],
  ["chargeableSeat", "SEATS"],
  ["otherServices", "OTHER_SERVICES"],
];

/** The selection an Amadeus `source.pointer` points at (`/data/flightOffers/0/travelerPricings[0]/…`), if any. */
export function selectionOfPointer(
  pointer: unknown,
  pointers: ReadonlyMap<string, readonly number[]>,
  extras: readonly PlannedExtra[],
): number | undefined {
  if (typeof pointer !== "string") {
    return undefined;
  }
  const normalised = pointer.replace(/\[(\d+)\]/g, "/$1");
  for (const [prefix, indexes] of pointers) {
    if (normalised !== prefix && !normalised.startsWith(`${prefix}/`)) {
      continue;
    }
    const member = MEMBER_TYPES.find(([name]) => normalised.includes(`/additionalServices/${name}`));
    const ofType = member === undefined ? [] : indexes.filter((index) => extras[index]?.type === member[1]);
    return ofType[0] ?? indexes[0];
  }
  return undefined;
}

/**
 * The API error of a failed re-pricing (see the file header, step 3): a rejection (4926, 32171) of a selection is
 * `422 ANCILLARY_NOT_AVAILABLE`; the supplier codes of the operation stay; any other answer is `502 SUPPLIER_ERROR`.
 */
export function servicesErrorOf(
  error: unknown,
  pointers: ReadonlyMap<string, readonly number[]>,
  extras: readonly PlannedExtra[],
): unknown {
  if (!(error instanceof AppError) || SUPPLIER_CODES_KEPT.has(error.code)) {
    return error;
  }
  const cause = error.cause;
  const rejected = (message: string, details: Readonly<Record<string, unknown>>): AppError =>
    new AppError("ANCILLARY_NOT_AVAILABLE", {
      message,
      details,
      ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
      cause,
    });
  if (cause instanceof AmadeusCallError && extras.length > 0) {
    for (const issue of cause.issues) {
      if (issue.code === undefined || !REJECTION_CODES.has(issue.code)) {
        continue;
      }
      const index = selectionOfPointer(issue.source?.pointer, pointers, extras);
      const extra = index === undefined ? undefined : extras[index];
      if (index === undefined || extra === undefined) {
        // A data error the travellers did not cause (that is TRAVELER_DATA_INVALID): the base priced, so the extras.
        if (error.code === "SUPPLIER_REJECTED") {
          return rejected("The airline rejected the extras.", { reason: "rejected_by_airline" });
        }
        continue;
      }
      return extra.type === "SEATS"
        ? rejected("This seat cannot be booked.", {
            selectionIndex: index,
            reason: "seat_unavailable",
            seatNumber: extra.seatNumber,
            segmentId: extra.segmentIds[0],
          })
        : rejected("The airline rejected this extra.", {
            selectionIndex: index,
            reason: "rejected_by_airline",
          });
    }
  }
  return new AppError("SUPPLIER_ERROR", {
    message: "The supplier could not price the extras.",
    ...(error.supplier === undefined ? {} : { supplier: error.supplier }),
    cause: cause ?? error,
  });
}

// ---- Prices ------------------------------------------------------------------------------------------------------

/**
 * The net price of every extra, in their order (see the file header, step 4): per confirmed offer and kind, Amadeus's
 * `price.additionalServices` shared over the offer's extras of that kind in proportion to their catalogue prices
 * (equally when none has one), or each extra's catalogue price where Amadeus states no amount for the kind. A
 * positive amount for a kind no extra of the offer has is `502 SUPPLIER_ERROR`: the airline would charge for something
 * not selected.
 */
export function extraNets(
  extras: readonly PlannedExtra[],
  confirmed: ReadonlyArray<{ readonly amadeusOfferId: string; readonly payload: unknown }>,
  minorUnits: number,
): string[] {
  const nets: string[] = extras.map(() => "");
  for (const offer of confirmed) {
    const reported = additionalServiceAmounts(offer.payload);
    const ofOffer = extras.filter((extra) => extra.amadeusOfferId === offer.amadeusOfferId);
    for (const [type, amount] of reported) {
      if (amount.gt(0) && !ofOffer.some((extra) => extra.type === type)) {
        throw new AppError("SUPPLIER_ERROR", {
          message: "The supplier priced extras that were not selected.",
        });
      }
    }
    for (const type of new Set(ofOffer.map((extra) => extra.type))) {
      const ofType = ofOffer.filter((extra) => extra.type === type);
      const catalogue = ofType.map((extra) => new Money(extra.cataloguePrice ?? 0));
      const amount = reported.get(type);
      const shares =
        amount === undefined
          ? catalogue
          : distribute(amount.toDecimalPlaces(minorUnits, Money.ROUND_HALF_UP), catalogue, minorUnits);
      ofType.forEach((extra, position) => {
        nets[extra.index] = (shares[position] ?? new Money(0)).toFixed(minorUnits);
      });
    }
  }
  if (nets.some((net) => net === "")) {
    throw new Error("an extra's offer is not among the confirmed offers");
  }
  return nets;
}

/** What `ancillaryRows` needs besides the extras. */
export interface AncillaryRowsInput {
  readonly checkoutId: string;
  readonly currency: string;
  readonly minorUnits: number;
  readonly extras: readonly PlannedExtra[];
  /** `extraNets`, in the order of `extras`. */
  readonly nets: readonly string[];
  /** The `ancillary_service` fee lines of the engine, `extraRef` naming each line's extra. */
  readonly feeLines: readonly FeeLine[];
  /** `checkout_travelers.id` by Amadeus traveller id. */
  readonly travelerRowIds: ReadonlyMap<string, string>;
  readonly now: Date;
  readonly newId: () => string;
}

/**
 * The `checkout_ancillaries` rows of the extras and their selling total: per extra its net plus its fee lines
 * (`price_amount`), the net (`net_amount`), its first segment (`segment_id`; `details.segmentIds` lists them all, and
 * the catalogue option, label, fee lines and the verbatim Amadeus option are in `details`), one millisecond apart in
 * their order (the table has no position column).
 */
export function ancillaryRows(input: AncillaryRowsInput): {
  readonly rows: CheckoutAncillaryInsert[];
  readonly total: string;
} {
  const units = input.minorUnits;
  let total: MoneyValue = new Money(0);
  const rows = input.extras.map((extra, position): CheckoutAncillaryInsert => {
    const net = new Money(input.nets[position] ?? 0);
    const lines = input.feeLines.filter((line) => line.extraRef === extra.ref);
    const selling = lines.reduce((sum, line) => sum.plus(line.amount), net);
    total = total.plus(selling);
    const travelerRowId = input.travelerRowIds.get(extra.travelerId);
    if (travelerRowId === undefined) {
      throw new Error("an extra's traveller is not a traveller of the checkout");
    }
    return {
      id: input.newId(),
      checkout_id: input.checkoutId,
      checkout_traveler_id: travelerRowId,
      segment_id: extra.segmentIds[0] ?? null,
      type: extra.type,
      service_code:
        extra.type === "OTHER_SERVICES"
          ? extra.serviceName
          : extra.type === "SEATS"
            ? extra.seatNumber
            : (extra.option.amadeus.includedKey ?? extra.option.id),
      quantity: extra.quantity,
      weight: extra.weight,
      weight_unit: extra.weightUnit,
      seat_number: extra.seatNumber,
      currency: input.currency,
      price_amount: selling.toFixed(units),
      net_amount: net.toFixed(units),
      details: JSON.stringify({
        optionId: extra.option.id,
        label: extra.option.label,
        travelerId: extra.travelerId,
        segmentIds: extra.segmentIds,
        offerId: extra.offerId,
        feeLines: lines,
        amadeus: extra.option.amadeus.raw ?? null,
      }),
      created_at: new Date(input.now.getTime() + position),
      updated_at: input.now,
    };
  });
  return { rows, total: total.toFixed(units) };
}

/**
 * The checkout total (CheckoutTotals, the `checkouts_total_ck` CHECK): `total = offer + ancillaries + cardFee`, the
 * card fee being `fees_amount` (`0` while no card is known), in the currency's minor units.
 */
export function checkoutTotalOf(
  offer: string,
  ancillaries: string,
  cardFee: string,
  minorUnits: number,
): string {
  return new Money(offer).plus(ancillaries).plus(cardFee).toFixed(minorUnits);
}

// ---- The service -------------------------------------------------------------------------------------------------

/** What the re-pricing gave: the request and answer, and the extras with their nets for the engine. */
interface ServicesQuote {
  readonly request: AmadeusPricingRequest;
  readonly reply: AmadeusResponse<unknown>;
  readonly nets: readonly string[];
  readonly extras: readonly PricingExtra[];
}

/** The outcome of the writing transaction. */
type Applied =
  | {
      readonly kind: "applied";
      readonly pricedOfferId: string;
      readonly fareChanged: boolean;
    }
  | {
      readonly kind: "price_changed";
      readonly pricedOfferId: string;
      readonly oldPrice: MoneyAmount;
      readonly newPrice: MoneyAmount;
    };

/** The checkout must be open or payment pending, not expired, and at the `If-Match` version. */
function checkChangeable(
  checkout: Pick<Checkout, "status" | "bookingId" | "version">,
  ifMatch: string | undefined,
): void {
  if (checkout.status === "completed") {
    throw new AppError(
      "CHECKOUT_ALREADY_COMPLETED",
      checkout.bookingId === null ? {} : { details: { bookingId: checkout.bookingId } },
    );
  }
  if (checkout.status === "expired" || checkout.status === "abandoned") {
    throw new AppError("CHECKOUT_EXPIRED");
  }
  if (!ifMatchSatisfied(ifMatch, checkout.version)) {
    throw new AppError("PRECONDITION_FAILED");
  }
}

/** The base priced offer's confirmed Amadeus offers (net, verbatim), in the order of its offers. */
function storedOffersOf(row: PricedOfferRow): ConfirmedOffer[] {
  const snapshot = snapshotOf(row.response);
  const confirmed = confirmedOffersOf(
    snapshot.offers.map((offer) => ({
      id: offer.offerId,
      amadeusOfferId: offer.amadeusOfferId,
      currency: row.currency,
    })),
    readPricingReply(row.response).flightOffers,
    parseOffer,
  );
  if (confirmed === undefined) {
    throw new Error("a stored priced offer cannot be read");
  }
  return confirmed;
}

@Injectable()
export class AncillariesService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly checkouts: CheckoutService,
    private readonly repository: CheckoutRepository,
    private readonly pricedOffers: PricedOffersService,
    private readonly amadeus: AmadeusClient,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(AncillariesService.name);
  }

  /** checkout.setAncillaries (see the file header). */
  async setAncillaries(input: CheckoutStepInput<CheckoutAncillariesRequest>): Promise<Checkout> {
    const tenant = this.tenants.require();
    const view = await this.checkouts.get(input.checkoutId, input.acceptLanguage);
    checkChangeable(view, input.ifMatch);
    let extras: PlannedExtra[] = [];
    if (input.body.selections.length === 0) {
      // Removing every extra needs no catalogue: only the feature is checked, so no catalogue is loaded from Amadeus.
      await this.pricedOffers.checkAncillariesForCheckout();
    } else {
      const catalogue = await this.pricedOffers.ancillariesForCheckout(view.basePricedOfferId);
      extras = planExtras(input.body.selections, catalogue);
    }
    const base = await this.tx.run(async (trx) => {
      const priced = await this.pricedOffers.forCheckout(trx, view.basePricedOfferId, input.acceptLanguage);
      if (priced === undefined) {
        throw new Error("the base priced offer of a checkout is missing");
      }
      return priced;
    });
    const revert = extras.length === 0 && base.row.expiresAt.getTime() > this.clock.now().getTime();
    const quote = revert ? undefined : await this.quote(tenant, base, extras, view);
    const applied = await this.tx.run((trx) => this.apply(trx, input, base, extras, quote));
    if (applied.kind === "price_changed") {
      throw new AppError("PRICE_CHANGED", {
        message:
          "The checkout total with these extras differs from the expected total; the checkout is unchanged.",
        details: {
          oldPrice: applied.oldPrice,
          newPrice: applied.newPrice,
          pricedOfferId: applied.pricedOfferId,
        },
      });
    }
    this.logger.info(
      {
        checkoutId: view.id,
        pricedOfferId: applied.pricedOfferId,
        extras: extras.length,
        reverted: revert,
        fareChanged: applied.fareChanged,
      },
      "checkout.ancillaries_set",
    );
    return await this.checkouts.get(view.id, input.acceptLanguage);
  }

  /** Step 3 (see the file header): Flight Offers Price with the extras, outside any transaction. */
  private async quote(
    tenant: RequestTenant,
    base: CheckoutPricedOffer,
    extras: readonly PlannedExtra[],
    view: Checkout,
  ): Promise<ServicesQuote> {
    const stored = storedOffersOf(base.row);
    const { request, pointers } = buildServicesRequest(
      stored,
      extras,
      travelersOf(view.travelers),
      snapshotOf(base.row.response).fareRules,
    );
    let reply: AmadeusResponse<unknown>;
    try {
      reply = await this.amadeus.quoteAirOffers(
        {
          tenantId: tenant.tenantId,
          environment: tenant.environment,
          operation: "checkout.setAncillaries",
          requestId: this.tenants.requestId() ?? tenant.requestId,
          searchId: base.row.searchId,
        },
        {
          // The stored Amadeus offers verbatim with the extras, as the specification defines them.
          body: request as unknown as Parameters<AmadeusClient["quoteAirOffers"]>[1]["body"],
          query: pricingQuery(SERVICES_INCLUDE, base.row.forceClass),
        },
      );
    } catch (error) {
      throw servicesErrorOf(error, pointers, extras);
    }
    const confirmed = confirmedOffersOf(
      stored.map((offer) => ({
        id: offer.offerId,
        amadeusOfferId: offer.amadeusOfferId,
        currency: base.row.currency,
      })),
      readPricingReply(reply.body).flightOffers,
      parseOffer,
    );
    if (confirmed === undefined) {
      throw new AppError("SUPPLIER_ERROR", { message: "The supplier's pricing answer could not be read." });
    }
    const nets = extraNets(extras, confirmed, base.minorUnits);
    return {
      request,
      reply,
      nets,
      extras: extras.map((extra, position) => ({
        ref: extra.ref,
        amount: nets[position] ?? "0",
        travelers: 1,
        segments: Math.max(1, extra.segmentIds.length),
      })),
    };
  }

  /** Step 4 (see the file header), in one transaction. */
  private async apply(
    trx: TenantTransaction,
    input: CheckoutStepInput<CheckoutAncillariesRequest>,
    base: CheckoutPricedOffer,
    extras: readonly PlannedExtra[],
    quote: ServicesQuote | undefined,
  ): Promise<Applied> {
    const now = this.clock.now();
    const checkout = await this.repository.checkout(trx, input.checkoutId, true);
    if (checkout === undefined) {
      throw new AppError("NOT_FOUND", { message: "No checkout with this id." });
    }
    const status = effectiveStatus(checkout, now);
    checkChangeable(
      {
        status,
        bookingId: status === "completed" ? await this.repository.bookingIdOf(trx, checkout.id) : null,
        version: checkout.version,
      },
      input.ifMatch,
    );
    const units = base.minorUnits;
    let pricedOfferId = base.row.id;
    let offerAmount = base.row.sellingTotal;
    let fareChanged = false;
    let rows: CheckoutAncillaryInsert[] = [];
    let ancillaries = new Money(0).toFixed(units);
    if (quote !== undefined) {
      const stored = await this.pricedOffers.storeServicesPricing(trx, {
        base: base.row,
        request: quote.request,
        include: SERVICES_INCLUDE,
        reply: quote.reply,
        extras: quote.extras,
        acceptLanguage: input.acceptLanguage,
      });
      pricedOfferId = stored.priced.row.id;
      offerAmount = stored.priced.row.sellingTotal;
      fareChanged = stored.fareChanged;
      const travelers = await this.repository.travelers(trx, checkout.id);
      const built = ancillaryRows({
        checkoutId: checkout.id,
        currency: checkout.currency,
        minorUnits: units,
        extras,
        nets: quote.nets,
        feeLines: stored.extraFeeLines,
        travelerRowIds: new Map(travelers.map((row) => [row.amadeusTravelerId, row.id])),
        now,
        newId: () => this.ids.newId("can"),
      });
      rows = built.rows;
      ancillaries = built.total;
    }
    const offer = new Money(offerAmount).toFixed(units);
    const total = checkoutTotalOf(offer, ancillaries, checkout.feesAmount, units);
    const expected = input.body.expectedTotal;
    if (
      expected !== undefined &&
      (expected.currency !== checkout.currency || !new Money(expected.amount).equals(total))
    ) {
      // The child priced offer stays (`details.pricedOfferId`); the checkout is left as it was.
      return {
        kind: "price_changed",
        pricedOfferId,
        oldPrice: { amount: expected.amount, currency: expected.currency },
        newPrice: { amount: total, currency: checkout.currency },
      };
    }
    await this.repository.replaceAncillaries(trx, checkout.id, rows);
    await this.repository.setPricing(trx, checkout.id, {
      pricedOfferId,
      offerAmount: offer,
      ancillariesAmount: ancillaries,
      totalAmount: total,
      now,
    });
    return { kind: "applied", pricedOfferId, fareChanged };
  }
}
