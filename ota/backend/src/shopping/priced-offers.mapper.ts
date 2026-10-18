// Priced offers between the API, Amadeus Flight Offers Price and `priced_offers` (OBE-023; ota/docs/flows/
// search-and-price.md §2 steps 7–8 and §3, OADR-0002 point 3, OADR-0005 points 5, 7 and 8). Pure functions: no I/O,
// no clock (the caller passes `now`), money in decimal.js (`Money` of the pricing context), never a JavaScript number.
//
// Request side: the stored Amadeus offers of the request become `data.flightOffers` verbatim, the card hints
// `data.payments` (`bin` as the integer `binNumber`, offers as their Amadeus ids), the travellers `data.travelers`
// (their ids must be the offers' traveller ids) and `fareRules` `data.additionalInformation.fareRules`; `include` and
// `forceClass` go to the query (`buildPricingRequest`, `pricingIncludeOf`).
//
// Storage side: `priced_offers.response` holds the Amadeus answer verbatim (data, included, dictionaries, warnings)
// plus `velexis`, the pricing snapshot of OADR-0005 point 8 (`PricingSnapshot`): the owner, the include flags, the
// results total the customer saw, per offer its confirmed net, markup and markup lines, the fee lines of the
// booking, the ids of the ancillary options, and what flights.getAncillaries and flights.getFareRules loaded later.
// A later rule change or deletion never changes a stored priced offer: every answer is rebuilt from that snapshot.
//
// Response side (`toPricedOffer`): the confirmed selling price (net + markup + the `booking_service` and `ticketing`
// fees), the comparison with the results price (`priceChange`; results prices carry no fees, OADR-0005 point 7, so the
// fees of the priced offer are added to the results total and a fee never reads as a price change), the booking
// requirements with `off_` ids, the card fees, the ancillary catalogue (`anc_` options from `included.bags`,
// `included.other-services` and the offers' chargeable-seat data) and the fare rules (UI shape and raw data). Customer
// scope gets selling amounts only: the Amadeus offers inside `amadeus.data` carry the markup as the search results do
// (offers.mapper.ts `sellingAmadeusOffer`), and `netPrice`, `markup` and the options' `netPrice` are console scope only.
// Ancillaries have no markup in the MVP (markup rules have no ancillary scope; their fees are `ancillary_service` fees
// at checkout.setAncillaries, OADR-0005 point 7), so an option's selling price is the Amadeus price.
import { isDeepStrictEqual } from "node:util";
import type { components } from "@velexis/api-types";
import {
  Money,
  type FeeLine,
  type MarkupLine,
  type MoneyValue,
  type PricingChannel,
} from "../pricing/pricing.types";
import {
  distribute,
  sellingAmadeusOffer,
  travelerMarkupShares,
  type FlightOffer,
  type OfferScope,
  type ParsedOffer,
  type ParsedSegment,
} from "./offers.mapper";

type Schemas = components["schemas"];
export type PricedOffer = Schemas["PricedOffer"];
export type PricingRequest = Schemas["PricingRequest"];
export type PricingInclude = Schemas["PricingInclude"];
export type AncillaryCatalogue = Schemas["AncillaryCatalogue"];
export type FareRuleSet = Schemas["FareRuleSet"];
type FareRuleSummary = Schemas["FareRuleSummary"];
type FareRuleCategory = Schemas["FareRuleCategory"];
type FareRuleComponent = Schemas["FareRuleComponent"];
type FareRuleText = Schemas["FareRuleText"];
type AncillaryOption = Schemas["AncillaryOption"];
type AncillarySegment = Schemas["AncillarySegment"];
type AncillaryTraveler = Schemas["AncillaryTraveler"];
type AncillaryAdditionalServices = Schemas["AncillaryAdditionalServices"];
type AncillaryAvailability = Schemas["PricedOfferAncillaryAvailability"];
type BookingRequirements = Schemas["PricingBookingRequirements"];
type TravelerRequirement = Schemas["PricingTravelerRequirement"];
type CreditCardFee = Schemas["CreditCardFee"];
type PriceChange = Schemas["PricingPriceChange"];
type SellingPrice = Schemas["SellingPrice"];
type PriceBreakdown = Schemas["PriceBreakdown"];
type PriceBreakdownFee = Schemas["PriceBreakdownFee"];
type PriceBreakdownService = Schemas["PriceBreakdownService"];
type PricedOfferAmadeus = Schemas["PricedOfferAmadeus"];
type MoneyAmount = Schemas["Money"];
type PaymentBrand = Schemas["AmadeusPaymentBrand"];
type ServiceName = Schemas["AmadeusServiceName"];
type OfferPaymentCard = Schemas["OfferPaymentCard"];
type AmadeusTraveler = Schemas["AmadeusTraveler"];
type Warning = Schemas["Warning"];
type Dictionaries = Schemas["Dictionaries"];
type TravelerType = Schemas["AmadeusTravelerType"];
type AdditionalServiceType = Schemas["AmadeusAdditionalServiceType"];
/** The verbatim Amadeus `included` entry of an option (AmadeusBags or AmadeusOtherServices). */
type AncillaryRaw = NonNullable<AncillaryOption["amadeus"]["raw"]>;

// ---- Loose JSON readers (Amadeus answers and stored jsonb are read defensively) ------------------------------------

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;
const flag = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
/** A decimal amount as the document's Money accepts it (at most 4 decimals). */
const MONEY_AMOUNT = /^-?\d+(?:\.\d{1,4})?$/;
const CURRENCY = /^[A-Z]{3}$/;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

const money = (amount: MoneyValue | string, currency: string, minorUnits: number): MoneyAmount => ({
  amount: new Money(amount).toFixed(minorUnits),
  currency,
});

const sum = (values: ReadonlyArray<MoneyValue | string>): MoneyValue =>
  values.reduce<MoneyValue>((total, value) => total.plus(value), new Money(0));

/** Keys of an Amadeus `included` map in their natural order ("1", "2", …, "10"). */
function sortedKeys(map: JsonObject): string[] {
  return Object.keys(map).sort((a, b) => {
    const left = /^\d+$/.test(a) ? Number.parseInt(a, 10) : Number.NaN;
    const right = /^\d+$/.test(b) ? Number.parseInt(b, 10) : Number.NaN;
    if (!Number.isNaN(left) && !Number.isNaN(right)) {
      return left - right;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// ---- Enumerations of the document ----------------------------------------------------------------------------------

/** The Amadeus pricing sub-resources, in the order of the specification's `included`. */
export const PRICING_INCLUDES: readonly PricingInclude[] = Object.freeze([
  "credit-card-fees",
  "bags",
  "other-services",
  "detailed-fare-rules",
]);
const PAYMENT_BRANDS: readonly PaymentBrand[] = Object.freeze([
  "VISA",
  "AMERICAN_EXPRESS",
  "MASTERCARD",
  "VISA_ELECTRON",
  "VISA_DEBIT",
  "MASTERCARD_DEBIT",
  "MAESTRO",
]);
const SERVICE_NAMES: readonly ServiceName[] = Object.freeze([
  "PRIORITY_BOARDING",
  "AIRPORT_CHECKIN",
  "FAST_TRACK",
]);
const FARE_RULE_CATEGORIES: readonly FareRuleCategory["category"][] = Object.freeze([
  "REFUND",
  "EXCHANGE",
  "REVALIDATION",
  "REISSUE",
  "REBOOK",
  "CANCELLATION",
]);
const ADDITIONAL_SERVICE_TYPES: readonly AdditionalServiceType[] = Object.freeze([
  "CHECKED_BAGS",
  "MEALS",
  "SEATS",
  "OTHER_SERVICES",
]);
/** Traveller types that stand for the price "per adult" (FlightSearchSummary's adults). */
const ADULT_TYPES: ReadonlySet<string> = new Set(["ADULT", "SENIOR", "YOUNG", "STUDENT"]);
/** The fare rule categories that say whether a ticket can be changed. */
const CHANGE_CATEGORIES: ReadonlySet<string> = new Set(["EXCHANGE", "REISSUE", "REBOOK", "REVALIDATION"]);
/** The fee types of Amadeus `price.fees` → PriceBreakdownFee.type. */
const AMADEUS_FEE_TYPES: Readonly<Record<string, PriceBreakdownFee["type"]>> = Object.freeze({
  TICKETING: "ticketing",
  FORM_OF_PAYMENT: "form_of_payment",
  SUPPLIER: "supplier",
});

// ---- The request ---------------------------------------------------------------------------------------------------

/**
 * The `include` of a pricing: the request's (in the specification's order), or the defaults of the operation:
 * `bags` and `other-services` when the storefront sells ancillaries, `detailed-fare-rules` (the storefront shows the
 * fare rules in the price summary, flow §2 step 8) and `credit-card-fees` when card hints are given.
 */
export function pricingIncludeOf(body: PricingRequest, ancillariesEnabled: boolean): PricingInclude[] {
  const requested = body.include;
  if (requested !== undefined) {
    return PRICING_INCLUDES.filter((include) => requested.includes(include));
  }
  return PRICING_INCLUDES.filter((include) => {
    switch (include) {
      case "bags":
      case "other-services":
        return ancillariesEnabled;
      case "detailed-fare-rules":
        return true;
      case "credit-card-fees":
        return (body.payments?.length ?? 0) > 0;
    }
  });
}

/** One stored offer of a pricing request: its id, Amadeus id, verbatim Amadeus payload and traveller ids. */
export interface PricingInputOffer {
  readonly id: string;
  readonly amadeusOfferId: string;
  readonly payload: unknown;
  readonly travelerIds: readonly string[];
}

/** The Amadeus Flight Offers Price request body (`FlightOfferPricingIn`), as sent. */
export interface AmadeusPricingRequest {
  readonly data: {
    readonly type: "flight-offers-pricing";
    readonly flightOffers: readonly unknown[];
    readonly payments?: ReadonlyArray<{
      readonly brand: string;
      readonly binNumber?: number;
      readonly flightOfferIds: readonly string[];
    }>;
    readonly travelers?: readonly AmadeusTraveler[];
    readonly additionalInformation: { readonly fareRules: boolean };
  };
}

/** Why the request cannot be sent: a field error of the body, or offers Amadeus cannot price together. */
export type PricingRequestProblem =
  | { readonly kind: "validation"; readonly path: string; readonly code: string; readonly message: string }
  | {
      readonly kind: "combination";
      readonly reason: "duplicate" | "travelers_mismatch";
      readonly message: string;
    };

const sameMembers = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

/**
 * The Amadeus request for `offers` (in the order of `offerIds`) and the body's card hints, travellers and `fareRules`
 * (default true), or the first problem: two offers with one Amadeus id cannot be told apart in `flightOfferIds`, the
 * offers must have the same travellers, a card's `offerIds` must name offers of the request, and a traveller's `id`
 * must be one of the offers' traveller ids, once.
 */
export function buildPricingRequest(
  offers: readonly PricingInputOffer[],
  body: Pick<PricingRequest, "payments" | "travelers" | "fareRules">,
): AmadeusPricingRequest | PricingRequestProblem {
  const amadeusIds = new Map<string, string>();
  for (const offer of offers) {
    if ([...amadeusIds.values()].includes(offer.amadeusOfferId)) {
      return {
        kind: "combination",
        reason: "duplicate",
        message: "These offers cannot be priced together: price them one at a time.",
      };
    }
    amadeusIds.set(offer.id, offer.amadeusOfferId);
  }
  const travelerIds = offers[0]?.travelerIds ?? [];
  if (offers.some((offer) => !sameMembers(offer.travelerIds, travelerIds))) {
    return {
      kind: "combination",
      reason: "travelers_mismatch",
      message: "Offers priced together must be for the same travellers.",
    };
  }
  const payments: Array<{ brand: string; binNumber?: number; flightOfferIds: string[] }> = [];
  for (const [index, card] of (body.payments ?? []).entries()) {
    const flightOfferIds: string[] = [];
    for (const [position, offerId] of (card.offerIds ?? offers.map((offer) => offer.id)).entries()) {
      const amadeusId = amadeusIds.get(offerId);
      if (amadeusId === undefined) {
        return {
          kind: "validation",
          path: `/payments/${index}/offerIds/${position}`,
          code: "not_in_request",
          message: "The card can only pay for offers of this request (offerIds).",
        };
      }
      flightOfferIds.push(amadeusId);
    }
    payments.push(cardHint(card, flightOfferIds));
  }
  const seen = new Set<string>();
  for (const [index, traveler] of (body.travelers ?? []).entries()) {
    const id = traveler.id;
    const problem =
      id === undefined
        ? { code: "required", message: "Each traveller needs the id of its traveller pricing." }
        : seen.has(id)
          ? { code: "duplicate", message: "Each traveller can be given once." }
          : !travelerIds.includes(id)
            ? {
                code: "unknown_traveler",
                message: "The id must be the travelerId of one of the offers' travellers.",
              }
            : undefined;
    if (problem !== undefined) {
      return { kind: "validation", path: `/travelers/${index}/id`, ...problem };
    }
    seen.add(id as string);
  }
  const travelers = body.travelers ?? [];
  return {
    data: {
      type: "flight-offers-pricing",
      flightOffers: offers.map((offer) => offer.payload),
      ...(payments.length === 0 ? {} : { payments }),
      ...(travelers.length === 0 ? {} : { travelers }),
      additionalInformation: { fareRules: body.fareRules ?? true },
    },
  };
}

function cardHint(
  card: OfferPaymentCard,
  flightOfferIds: string[],
): { brand: string; binNumber?: number; flightOfferIds: string[] } {
  return {
    brand: card.brand,
    // The BIN is six digits (validated); Amadeus takes it as an integer. It is no amount.
    ...(card.bin === undefined ? {} : { binNumber: Number.parseInt(card.bin, 10) }),
    flightOfferIds,
  };
}

/** The Flight Offers Price query: `include` (comma-separated by the client) and `forceClass`. */
export function pricingQuery(
  include: readonly PricingInclude[],
  forceClass: boolean,
): { include?: PricingInclude[]; forceClass: boolean } {
  return { ...(include.length === 0 ? {} : { include: [...include] }), forceClass };
}

// ---- The answer ----------------------------------------------------------------------------------------------------

/** A Flight Offers Price answer, read leniently. */
export interface PricingReply {
  /** `data` as answered (`type`, `flightOffers`, `bookingRequirements`, …). */
  readonly data: JsonObject;
  readonly flightOffers: readonly unknown[];
  readonly bookingRequirements: unknown;
  /** `included`, `{}` when absent. */
  readonly included: JsonObject;
  readonly dictionaries: unknown;
  readonly warnings: unknown;
}

export function readPricingReply(body: unknown): PricingReply {
  const raw = isRecord(body) ? body : {};
  const data = isRecord(raw["data"]) ? raw["data"] : {};
  return {
    data,
    flightOffers: Array.isArray(data["flightOffers"]) ? data["flightOffers"] : [],
    bookingRequirements: data["bookingRequirements"],
    included: isRecord(raw["included"]) ? raw["included"] : {},
    dictionaries: raw["dictionaries"],
    warnings: raw["warnings"],
  };
}

/** An offer as Amadeus confirmed it: the stored offer's ids and the answered (verbatim) payload. */
export interface ConfirmedOffer {
  readonly offerId: string;
  readonly amadeusOfferId: string;
  readonly payload: unknown;
  readonly parsed: ParsedOffer;
}

/**
 * The confirmed payload of every requested offer, in the order of the request, or `undefined` when the answer lacks
 * one of them, has one twice, cannot be read (`parse`, offers.mapper.ts `parseOffer`) or prices it in another
 * currency: such an answer cannot be stored as a priced offer.
 */
export function confirmedOffersOf(
  requested: ReadonlyArray<{
    readonly id: string;
    readonly amadeusOfferId: string;
    readonly currency: string;
  }>,
  flightOffers: readonly unknown[],
  parse: (payload: unknown) => ParsedOffer | undefined,
): ConfirmedOffer[] | undefined {
  const answered = new Map<string, { payload: unknown; parsed: ParsedOffer | undefined }[]>();
  for (const payload of flightOffers) {
    const id = isRecord(payload) ? text(payload["id"]) : undefined;
    if (id !== undefined) {
      answered.set(id, [...(answered.get(id) ?? []), { payload, parsed: parse(payload) }]);
    }
  }
  const confirmed: ConfirmedOffer[] = [];
  for (const offer of requested) {
    const matches = answered.get(offer.amadeusOfferId) ?? [];
    const [match] = matches;
    if (
      matches.length !== 1 ||
      match?.parsed === undefined ||
      match.parsed.price.currency !== offer.currency
    ) {
      return undefined;
    }
    confirmed.push({
      offerId: offer.id,
      amadeusOfferId: offer.amadeusOfferId,
      payload: match.payload,
      parsed: match.parsed,
    });
  }
  return confirmed;
}

/** The earliest of the offers' `lastTicketingDate`s (`YYYY-MM-DD`), `null` when none has one. */
export function earliestTicketingDate(
  offers: ReadonlyArray<{ readonly parsed: ParsedOffer }>,
): string | null {
  const dates = offers.flatMap((offer) => offer.parsed.lastTicketingDate ?? []).sort();
  return dates[0] ?? null;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * `expires_at` of a priced offer (OADR-0002 point 3): `min(now + offer_ttl_minutes, end of lastTicketingDate)`. The
 * date has no time zone; its end is read as the end of that day in UTC.
 */
export function pricedOfferExpiry(now: Date, ttlMinutes: number, lastTicketingDate: string | null): Date {
  const byTtl = now.getTime() + ttlMinutes * MINUTE_MS;
  const day = lastTicketingDate === null ? Number.NaN : Date.parse(`${lastTicketingDate}T00:00:00Z`);
  return new Date(Number.isNaN(day) ? byTtl : Math.min(byTtl, day + DAY_MS));
}

// ---- The snapshot of OADR-0005 point 8 -------------------------------------------------------------------------------

/** The key of the pricing snapshot inside `priced_offers.response`, next to the verbatim Amadeus answer. */
export const SNAPSHOT_KEY = "velexis";

/** How one offer of the priced offer was priced (markup only: the booking's fees are `PricingSnapshot.feeLines`). */
export interface OfferPricingSnapshot {
  readonly offerId: string;
  readonly amadeusOfferId: string;
  /** Confirmed Amadeus `grandTotal`, in the currency's minor units. */
  readonly net: string;
  readonly markup: string;
  /** `net + markup`. */
  readonly selling: string;
  readonly markupRuleId: string | null;
  readonly markupRuleName: string | null;
  readonly markupLines: readonly MarkupLine[];
}

/** What flights.getAncillaries loaded later (Flight Offers Price with `include=bags,other-services`). */
export interface AncillaryLoad {
  readonly loadedAt: string;
  /** `included.bags` and `included.other-services` of that answer. */
  readonly included: JsonObject;
  readonly warnings: unknown;
  /** Option key → `anc_` id (`ancillaryOptionKeys`). */
  readonly optionIds: Readonly<Record<string, string>>;
}

/** What flights.getFareRules loaded later (Flight Offers Price with `include=detailed-fare-rules`, fareRules). */
export interface FareRulesLoad {
  readonly loadedAt: string;
  /** Amadeus offer id → the `fareRules` of that offer in the answer. */
  readonly fareRules: Readonly<Record<string, unknown>>;
  readonly detailedFareRules: unknown;
  readonly warnings: unknown;
}

/** The pricing snapshot stored with the verbatim answer (`response.velexis`). */
export interface PricingSnapshot {
  readonly version: 1;
  readonly searchId: string;
  /** The owner: the customer who priced it, else the customer of the search; `null` for a guest. */
  readonly customerId: string | null;
  readonly channel: PricingChannel;
  readonly include: readonly PricingInclude[];
  /** `data.additionalInformation.fareRules` as sent. */
  readonly fareRules: boolean;
  readonly forceClass: boolean;
  readonly minorUnits: number;
  /** Σ of the offers' selling totals in the results (`flight_offers.selling_total`): what the customer saw. */
  readonly resultsTotal: string;
  readonly offers: readonly OfferPricingSnapshot[];
  /** The `booking_service` and `ticketing` fees of the priced offer (OADR-0005 point 7). */
  readonly feeLines: readonly FeeLine[];
  /** Option key → `anc_` id of the catalogue embedded at pricing (`ancillaryOptionKeys`). */
  readonly optionIds: Readonly<Record<string, string>>;
  readonly loads: { readonly ancillaries?: AncillaryLoad; readonly fareRules?: FareRulesLoad };
}

/** A stored priced offer's snapshot; a response without a readable one was never written (an internal error). */
export function snapshotOf(response: unknown): PricingSnapshot {
  const raw = isRecord(response) ? response[SNAPSHOT_KEY] : undefined;
  if (
    !isRecord(raw) ||
    raw["version"] !== 1 ||
    typeof raw["searchId"] !== "string" ||
    typeof raw["resultsTotal"] !== "string" ||
    !Number.isInteger(raw["minorUnits"]) ||
    !Array.isArray(raw["offers"]) ||
    !Array.isArray(raw["feeLines"]) ||
    !isRecord(raw["optionIds"]) ||
    !isRecord(raw["loads"])
  ) {
    throw new Error("a stored priced offer has no readable pricing snapshot");
  }
  return raw as unknown as PricingSnapshot;
}

// ---- Prices ------------------------------------------------------------------------------------------------------

/** An offer of the priced offer with its confirmed reading and its markup. */
export interface PricedOfferPart {
  readonly offerId: string;
  readonly amadeusOfferId: string;
  readonly payload: unknown;
  readonly parsed: ParsedOffer;
  readonly markup: string;
}

/** Σ of the Amadeus fees of an offer (`price.fees`). */
const amadeusFees = (offer: ParsedOffer): MoneyValue => sum(offer.price.fees.map((fee) => fee.amount));

/** One traveller over every offer of the priced offer. */
interface TravelerTotals {
  readonly travelerId: string;
  readonly travelerType: TravelerType;
  base: MoneyValue;
  taxes: MoneyValue;
  total: MoneyValue;
  readonly taxDetails: Map<string, MoneyValue>;
}

/** The travellers of the offers by id (first-seen order), net plus each offer's markup share. */
function travelerTotals(parts: readonly PricedOfferPart[], minorUnits: number): TravelerTotals[] {
  const byId = new Map<string, TravelerTotals>();
  for (const part of parts) {
    const shares = travelerMarkupShares(part.parsed, new Money(part.markup), minorUnits);
    part.parsed.travelerPricings.forEach((pricing, index) => {
      if (pricing.total === null || pricing.base === null) {
        return;
      }
      const share = shares[index] ?? new Money(0);
      const known = byId.get(pricing.travelerId) ?? {
        travelerId: pricing.travelerId,
        travelerType: pricing.travelerType,
        base: new Money(0),
        taxes: new Money(0),
        total: new Money(0),
        taxDetails: new Map<string, MoneyValue>(),
      };
      known.base = known.base.plus(pricing.base).plus(share);
      known.taxes = known.taxes.plus(new Money(pricing.total).minus(pricing.base));
      known.total = known.total.plus(pricing.total).plus(share);
      for (const tax of pricing.taxes) {
        known.taxDetails.set(tax.code, (known.taxDetails.get(tax.code) ?? new Money(0)).plus(tax.amount));
      }
      byId.set(pricing.travelerId, known);
    });
  }
  return [...byId.values()];
}

/**
 * The confirmed selling price of the priced offer (SellingPrice): per offer the markup folded into the base fare, as in
 * the results, plus the service fees of the booking (`fees`, and one `service_fee` line per fee rule in the
 * breakdown, spread over the travellers in proportion to their totals). `total = base + taxes + fees +
 * additionalServices = net + markup + fees`.
 */
export function pricedSellingPrice(
  parts: readonly PricedOfferPart[],
  feeLines: readonly FeeLine[],
  currency: string,
  minorUnits: number,
): SellingPrice {
  const fee = sum(feeLines.map((line) => line.amount));
  const base = sum(parts.map((part) => new Money(part.parsed.price.base).plus(part.markup)));
  const supplierFees = sum(parts.map((part) => amadeusFees(part.parsed)));
  const taxes = sum(
    parts.map((part) =>
      new Money(part.parsed.price.total).minus(part.parsed.price.base).minus(amadeusFees(part.parsed)),
    ),
  );
  const additional = sum(
    parts.map((part) => new Money(part.parsed.price.grandTotal).minus(part.parsed.price.total)),
  );
  const total = sum(parts.map((part) => new Money(part.parsed.price.grandTotal).plus(part.markup))).plus(fee);
  const travelers = travelerTotals(parts, minorUnits);
  const feeShares = distribute(
    fee,
    travelers.map((traveler) => traveler.total),
    minorUnits,
  );
  const lead = travelers.findIndex((traveler) => ADULT_TYPES.has(traveler.travelerType));
  const leadTraveler = travelers[lead];
  const fees: PriceBreakdownFee[] = [];
  for (const [type, label] of Object.entries(AMADEUS_FEE_TYPES)) {
    const amount = sum(
      parts.flatMap((part) =>
        part.parsed.price.fees.filter((entry) => entry.type === type).map((e) => e.amount),
      ),
    );
    if (!amount.isZero()) {
      fees.push({ type: label, amount: money(amount, currency, minorUnits), description: null });
    }
  }
  for (const line of feeLines) {
    if (!new Money(line.amount).isZero()) {
      fees.push({
        type: "service_fee",
        amount: money(line.amount, currency, minorUnits),
        description: line.label,
      });
    }
  }
  const breakdown: PriceBreakdown = {
    travelers: travelers.map((traveler, index) => {
      const share = feeShares[index] ?? new Money(0);
      return {
        travelerId: traveler.travelerId,
        travelerType: traveler.travelerType,
        base: money(traveler.base, currency, minorUnits),
        taxes: money(traveler.taxes, currency, minorUnits),
        fees: money(share, currency, minorUnits),
        total: money(traveler.total.plus(share), currency, minorUnits),
        taxDetails: [...traveler.taxDetails].map(([code, amount]) => ({
          code,
          amount: money(amount, currency, minorUnits),
        })),
      };
    }),
    fees,
    additionalServices: additionalServicesOf(parts, currency, minorUnits),
    refundableTaxes: refundableTaxesOf(parts, currency, minorUnits),
  };
  return {
    currency,
    total: money(total, currency, minorUnits),
    base: money(base, currency, minorUnits),
    taxes: money(taxes, currency, minorUnits),
    fees: money(supplierFees.plus(fee), currency, minorUnits),
    additionalServices: additional.isZero() ? null : money(additional, currency, minorUnits),
    perAdult:
      leadTraveler === undefined
        ? null
        : money(leadTraveler.total.plus(feeShares[lead] ?? 0), currency, minorUnits),
    breakdown,
  };
}

/** Amadeus `price.additionalServices` summed by type over the offers. */
function additionalServicesOf(
  parts: readonly PricedOfferPart[],
  currency: string,
  minorUnits: number,
): PriceBreakdownService[] {
  const byType = new Map<AdditionalServiceType, MoneyValue>();
  for (const part of parts) {
    const price = isRecord(part.payload) ? part.payload["price"] : undefined;
    for (const service of records(isRecord(price) ? price["additionalServices"] : undefined)) {
      const type = service["type"];
      const amount = text(service["amount"]);
      if (oneOf(type, ADDITIONAL_SERVICE_TYPES) && amount !== undefined && MONEY_AMOUNT.test(amount)) {
        byType.set(type, (byType.get(type) ?? new Money(0)).plus(amount));
      }
    }
  }
  return [...byType].map(([type, amount]) => ({ type, amount: money(amount, currency, minorUnits) }));
}

/** Σ of the offers' `price.refundableTaxes`, or `null` when an offer does not say. */
function refundableTaxesOf(
  parts: readonly PricedOfferPart[],
  currency: string,
  minorUnits: number,
): MoneyAmount | null {
  const amounts = parts.map((part) => {
    const price = isRecord(part.payload) ? part.payload["price"] : undefined;
    const amount = isRecord(price) ? text(price["refundableTaxes"]) : undefined;
    return amount !== undefined && MONEY_AMOUNT.test(amount) ? amount : undefined;
  });
  return amounts.some((amount) => amount === undefined)
    ? null
    : money(sum(amounts as string[]), currency, minorUnits);
}

/**
 * The confirmed total against the results total (PricingPriceChange). Results prices carry no fees (OADR-0005 point
 * 7), so `oldPrice` is the results total plus the priced offer's fees: the difference is what the supplier (and only
 * the supplier) changed, and a booking fee never reads as a price change.
 */
export function priceChangeOf(
  resultsTotal: string,
  feeTotal: string,
  sellingTotal: string,
  currency: string,
  minorUnits: number,
): PriceChange {
  const oldPrice = new Money(resultsTotal).plus(feeTotal);
  const difference = new Money(sellingTotal).minus(oldPrice);
  return {
    changed: !difference.isZero(),
    oldPrice: money(oldPrice, currency, minorUnits),
    newPrice: money(sellingTotal, currency, minorUnits),
    difference: money(difference, currency, minorUnits),
    direction: difference.isZero() ? "none" : difference.isPositive() ? "up" : "down",
  };
}

// ---- Booking requirements and card fees ------------------------------------------------------------------------------

const REQUIREMENT_FLAGS = [
  "phoneNumberRequired",
  "phoneCountryCodeRequired",
  "invoiceAddressRequired",
  "mailingAddressRequired",
  "postalCodeRequired",
] as const;
const TRAVELER_FLAGS = [
  "genderRequired",
  "documentRequired",
  "documentIssuanceCityRequired",
  "dateOfBirthRequired",
  "redressRequiredIfAny",
  "airFranceDiscountRequired",
  "spanishResidentDiscountRequired",
  "residenceRequired",
] as const;

/**
 * Amadeus `bookingRequirements` as PricingBookingRequirements: the flags it gives (a missing e-mail or mobile flag is
 * `false`), one entry per traveller with an id, and the 3-D Secure requirements with the offers' `off_` ids (Amadeus
 * offer ids the request did not have are left out).
 */
export function bookingRequirementsOf(
  raw: unknown,
  offerIdOf: (amadeusOfferId: string) => string | undefined,
): BookingRequirements {
  const source = isRecord(raw) ? raw : {};
  const requirements: BookingRequirements = {
    emailAddressRequired: source["emailAddressRequired"] === true,
    mobilePhoneNumberRequired: source["mobilePhoneNumberRequired"] === true,
    travelerRequirements: records(source["travelerRequirements"]).flatMap((entry) => {
      const travelerId = text(entry["travelerId"]);
      if (travelerId === undefined) {
        return [];
      }
      const requirement: TravelerRequirement = { travelerId };
      for (const name of TRAVELER_FLAGS) {
        const value = flag(entry[name]);
        if (value !== undefined) {
          requirement[name] = value;
        }
      }
      return [requirement];
    }),
  };
  for (const name of REQUIREMENT_FLAGS) {
    const value = flag(source[name]);
    if (value !== undefined) {
      requirements[name] = value;
    }
  }
  const secure = records(source["threeDomainSecureRequirements"]).flatMap((entry) => {
    const required = flag(entry["is3dsAuthenticationRequired"]);
    const offerIds = strings(entry["flightOfferIds"]).flatMap((id) => offerIdOf(id) ?? []);
    return required === undefined || offerIds.length === 0
      ? []
      : [{ offerIds, is3dsAuthenticationRequired: required }];
  });
  if (secure.length > 0) {
    requirements.threeDomainSecureRequirements = secure;
  }
  return requirements;
}

/** Amadeus `included.credit-card-fees` as CreditCardFee (unknown brands, offers or malformed amounts left out). */
export function creditCardFeesOf(
  included: JsonObject,
  offerIdOf: (amadeusOfferId: string) => string | undefined,
): CreditCardFee[] {
  const fees = isRecord(included["credit-card-fees"]) ? included["credit-card-fees"] : {};
  return sortedKeys(fees).flatMap((key) => {
    const fee = fees[key];
    if (!isRecord(fee)) {
      return [];
    }
    const brand = fee["brand"];
    const amount = text(fee["amount"]);
    const currency = text(fee["currency"]);
    const offerId = offerIdOf(text(fee["flightOfferId"]) ?? "");
    if (
      !oneOf(brand, PAYMENT_BRANDS) ||
      amount === undefined ||
      !MONEY_AMOUNT.test(amount) ||
      currency === undefined ||
      !CURRENCY.test(currency) ||
      offerId === undefined
    ) {
      return [];
    }
    return [{ brand, amount: { amount, currency }, offerId }];
  });
}

// ---- The ancillary catalogue ----------------------------------------------------------------------------------------

/** Where a catalogue comes from: the included maps of one Amadeus answer and the option ids given to it. */
export interface CatalogueSource {
  /** `included` of the pricing answer, or of flights.getAncillaries' later answer. */
  readonly included: JsonObject;
  readonly optionIds: Readonly<Record<string, string>>;
  readonly loadedAt: Date;
  readonly warnings: unknown;
}

/** An option before it gets its id: its key in `optionIds` and everything else. */
interface OptionDraft {
  readonly key: string;
  readonly option: Omit<AncillaryOption, "id">;
}

/** The segments of an offer, by id. */
function segmentsOf(offer: ParsedOffer): ParsedSegment[] {
  return offer.itineraries.flatMap((itinerary) => itinerary.segments);
}

/** The offer an included entry is for: the one flying its first segment, else the first offer. */
function offerOfEntry(entry: JsonObject, offers: readonly ConfirmedOffer[]): ConfirmedOffer | undefined {
  const [segmentId] = strings(entry["segmentIds"]);
  return (
    offers.find((offer) => segmentsOf(offer.parsed).some((segment) => segment.id === segmentId)) ?? offers[0]
  );
}

/** `"75.00"` of an Amadeus elementary price in `currency`, at most `minorUnits` decimals; `undefined` otherwise. */
function elementaryAmount(value: unknown, currency: string, minorUnits: number): string | undefined {
  if (!isRecord(value) || value["currencyCode"] !== currency) {
    return undefined;
  }
  // Amadeus may append a letter (`514.13A`: additional collection) to the amount.
  const amount = text(value["amount"])?.replace(/[A-Z]$/, "");
  if (amount === undefined || !/^\d+(?:\.\d+)?$/.test(amount)) {
    return undefined;
  }
  const decimal = new Money(amount);
  return decimal.decimalPlaces() > minorUnits ? undefined : decimal.toFixed(minorUnits);
}

/** `MAD–ORY` (and `, ORY–MAD`, …) for the segments an option covers. */
function routeOf(offer: ParsedOffer, segmentIds: readonly string[]): string {
  return segmentsOf(offer)
    .filter((segment) => segmentIds.includes(segment.id))
    .map((segment) => `${segment.departure.iataCode}–${segment.arrival.iataCode}`)
    .join(", ");
}

const SERVICE_LABELS: Readonly<Record<ServiceName, string>> = Object.freeze({
  PRIORITY_BOARDING: "Priority boarding",
  AIRPORT_CHECKIN: "Airport check-in",
  FAST_TRACK: "Fast track",
});

function bagLabel(
  kind: "checked" | "cabin",
  quantity: number | null,
  weight: number | null,
  unit: string | null,
): string {
  const pieces = quantity ?? 1;
  const noun = `extra ${kind} bag${pieces === 1 ? "" : "s"}`;
  const measure = weight === null ? "" : ` (${weight} ${(unit ?? "KG").toLowerCase()})`;
  return `${pieces} ${noun}${measure}`;
}

/** The travellers and segments of `offer` an entry names (all of them when it names none). */
function scopeOf(
  entry: JsonObject,
  offer: ParsedOffer,
): { readonly travelerIds: string[]; readonly segmentIds: string[] } {
  const offerTravelers = offer.travelerPricings.map((pricing) => pricing.travelerId);
  const offerSegments = segmentsOf(offer).map((segment) => segment.id);
  const travelers = strings(entry["travelerIds"]);
  const segments = strings(entry["segmentIds"]);
  return {
    travelerIds:
      travelers.length === 0 ? offerTravelers : offerTravelers.filter((id) => travelers.includes(id)),
    segmentIds: segments.length === 0 ? offerSegments : offerSegments.filter((id) => segments.includes(id)),
  };
}

/** The bag and service options of an `included` map, before their ids. */
function includedDrafts(
  included: JsonObject,
  offers: readonly ConfirmedOffer[],
  currency: string,
  minorUnits: number,
): OptionDraft[] {
  const drafts: OptionDraft[] = [];
  const bags = isRecord(included["bags"]) ? included["bags"] : {};
  for (const key of sortedKeys(bags)) {
    const entry = bags[key];
    const offer = isRecord(entry) ? offerOfEntry(entry, offers) : undefined;
    const amount = isRecord(entry) ? elementaryAmount(entry["price"], currency, minorUnits) : undefined;
    if (!isRecord(entry) || offer === undefined || amount === undefined) {
      continue;
    }
    const { travelerIds, segmentIds } = scopeOf(entry, offer.parsed);
    const quantity = integer(entry["quantity"]) ?? null;
    const weight = integer(entry["weight"]) ?? null;
    const weightUnit = text(entry["weightUnit"]) ?? null;
    if (travelerIds.length === 0 || segmentIds.length === 0 || (quantity !== null && quantity < 1)) {
      continue;
    }
    const cabin = /CABIN/i.test(text(entry["name"]) ?? "");
    const allowance = {
      ...(quantity === null ? {} : { quantity }),
      ...(weight === null ? {} : { weight }),
      ...(weightUnit === null ? {} : { weightUnit }),
    };
    const additionalServices: AncillaryAdditionalServices = cabin
      ? { chargeableCabinBags: allowance }
      : { chargeableCheckedBags: allowance };
    drafts.push({
      key: `bags:${key}`,
      option: {
        type: cabin ? "CABIN_BAGS" : "CHECKED_BAGS",
        name: text(entry["name"]) ?? (cabin ? "CABIN_BAG" : "CHECKED_BAG"),
        label: `${bagLabel(cabin ? "cabin" : "checked", quantity, weight, weightUnit)} – ${routeOf(offer.parsed, segmentIds)}`,
        descriptions: strings(entry["descriptions"]),
        offerId: offer.offerId,
        travelerIds,
        segmentIds,
        bookableByTraveler: flag(entry["bookableByTraveler"]) ?? true,
        bookableByItinerary: flag(entry["bookableByItinerary"]) ?? false,
        quantity,
        weight,
        weightUnit,
        serviceName: null,
        requiresSeatNumber: false,
        price: { amount, currency },
        netPrice: { amount, currency },
        amadeus: {
          flightOfferId: offer.amadeusOfferId,
          includedKey: key,
          segmentIds,
          additionalServices,
          raw: entry as AncillaryRaw,
        },
      },
    });
  }
  const services = isRecord(included["other-services"]) ? included["other-services"] : {};
  for (const key of sortedKeys(services)) {
    const entry = services[key];
    const offer = isRecord(entry) ? offerOfEntry(entry, offers) : undefined;
    const amount = isRecord(entry) ? elementaryAmount(entry["price"], currency, minorUnits) : undefined;
    const name = isRecord(entry) ? entry["name"] : undefined;
    if (!isRecord(entry) || offer === undefined || amount === undefined || !oneOf(name, SERVICE_NAMES)) {
      continue;
    }
    const { travelerIds, segmentIds } = scopeOf(entry, offer.parsed);
    if (travelerIds.length === 0 || segmentIds.length === 0) {
      continue;
    }
    drafts.push({
      key: `other-services:${key}`,
      option: {
        type: "OTHER_SERVICES",
        name,
        label: `${SERVICE_LABELS[name]} – ${routeOf(offer.parsed, segmentIds)}`,
        descriptions: strings(entry["descriptions"]),
        offerId: offer.offerId,
        travelerIds,
        segmentIds,
        bookableByTraveler: flag(entry["bookableByTraveler"]) ?? true,
        bookableByItinerary: flag(entry["bookableByItinerary"]) ?? false,
        quantity: null,
        weight: null,
        weightUnit: null,
        serviceName: name,
        requiresSeatNumber: false,
        price: { amount, currency },
        netPrice: { amount, currency },
        amadeus: {
          flightOfferId: offer.amadeusOfferId,
          includedKey: key,
          segmentIds,
          additionalServices: { otherServices: [name] },
          raw: entry as AncillaryRaw,
        },
      },
    });
  }
  return drafts;
}

/**
 * The chargeable-seat options of the offers (no seat map exists in the supplier scope): one per offer and segment
 * where a traveller's fare carries `additionalServices.chargeableSeat`, or a chargeable PRE_RESERVED_SEAT amenity on a
 * GDS or NDC offer. The seat is bought by number, its price is known only after re-pricing (`price: null`).
 */
function seatDrafts(offers: readonly ConfirmedOffer[]): OptionDraft[] {
  const drafts: OptionDraft[] = [];
  for (const offer of offers) {
    const source = isRecord(offer.payload) ? offer.payload : {};
    const amenitiesCount = source["source"] === "GDS" || source["source"] === "NDC";
    const pricings = records(source["travelerPricings"]);
    for (const segment of segmentsOf(offer.parsed)) {
      const travelerIds = pricings.flatMap((pricing) => {
        const detail = records(pricing["fareDetailsBySegment"]).find(
          (item) => item["segmentId"] === segment.id,
        );
        const services = detail?.["additionalServices"];
        const seat = isRecord(services) && services["chargeableSeat"] !== undefined;
        const amenity =
          amenitiesCount &&
          records(detail?.["amenities"]).some(
            (item) => item["amenityType"] === "PRE_RESERVED_SEAT" && item["isChargeable"] === true,
          );
        const travelerId = text(pricing["travelerId"]);
        return (seat || amenity) && travelerId !== undefined ? [travelerId] : [];
      });
      if (travelerIds.length === 0) {
        continue;
      }
      drafts.push({
        key: `seats:${offer.offerId}:${segment.id}`,
        option: {
          type: "SEATS",
          name: "SEAT",
          label: `Seat selection – ${segment.departure.iataCode}–${segment.arrival.iataCode}`,
          descriptions: [],
          offerId: offer.offerId,
          travelerIds,
          segmentIds: [segment.id],
          bookableByTraveler: true,
          bookableByItinerary: true,
          quantity: null,
          weight: null,
          weightUnit: null,
          serviceName: null,
          requiresSeatNumber: true,
          price: null,
          netPrice: null,
          amadeus: {
            flightOfferId: offer.amadeusOfferId,
            includedKey: null,
            segmentIds: [segment.id],
            additionalServices: { chargeableSeat: {} },
            raw: null,
          },
        },
      });
    }
  }
  return drafts;
}

/**
 * The keys of the options a catalogue built from `included` and the offers has, in order: the caller gives each an
 * `anc_` id once (when the catalogue is first built) and stores the ids with the source, so the ids stay stable.
 */
export function ancillaryOptionKeys(
  included: JsonObject,
  offers: readonly ConfirmedOffer[],
  currency: string,
  minorUnits: number,
): string[] {
  return [...includedDrafts(included, offers, currency, minorUnits), ...seatDrafts(offers)].map(
    (draft) => draft.key,
  );
}

/**
 * The `anc_` ids of the catalogue embedded at pricing that a later load of the same priced offer keeps, so an option
 * has one id for the priced offer (the document's ids are stable): a seat option (built from the offers, not from
 * `included`) under its key, and a bag or service option whose Amadeus `included` entry is the same under the same key.
 * `keys` are the later load's option keys (`ancillaryOptionKeys`).
 */
export function keptOptionIds(
  earlier: { readonly included: JsonObject; readonly optionIds: Readonly<Record<string, string>> },
  included: JsonObject,
  keys: readonly string[],
): Record<string, string> {
  const entryOf = (source: JsonObject, kind: string, key: string): unknown => {
    const map = source[kind];
    return isRecord(map) ? map[key] : undefined;
  };
  const kept: Record<string, string> = {};
  for (const key of keys) {
    const id = earlier.optionIds[key];
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator);
    const includedKey = key.slice(separator + 1);
    if (
      id !== undefined &&
      (kind === "seats" ||
        ((kind === "bags" || kind === "other-services") &&
          entryOf(included, kind, includedKey) !== undefined &&
          isDeepStrictEqual(
            entryOf(earlier.included, kind, includedKey),
            entryOf(included, kind, includedKey),
          )))
    ) {
      kept[key] = id;
    }
  }
  return kept;
}

/** What a catalogue needs besides its source. */
export interface CatalogueContext {
  readonly pricedOfferId: string;
  readonly currency: string;
  readonly minorUnits: number;
  readonly scope: OfferScope;
  readonly expiresAt: Date;
  readonly offers: readonly ConfirmedOffer[];
}

/**
 * The ancillary catalogue (AncillaryCatalogue): the travellers and segments of the offers, then the options by kind.
 * An option needs an id in `source.optionIds`, a price in the priced offer's currency (no FX in the MVP) and at least
 * one traveller and segment of its offer; anything else is left out. `netPrice` is console scope only.
 */
export function ancillaryCatalogueOf(source: CatalogueSource, context: CatalogueContext): AncillaryCatalogue {
  const options = [
    ...includedDrafts(source.included, context.offers, context.currency, context.minorUnits),
    ...seatDrafts(context.offers),
  ].flatMap((draft): AncillaryOption[] => {
    const id = source.optionIds[draft.key];
    if (id === undefined) {
      return [];
    }
    const { netPrice, ...option } = draft.option;
    return [context.scope === "console" ? { id, ...option, netPrice: netPrice ?? null } : { id, ...option }];
  });
  const travelers = new Map<string, AncillaryTraveler>();
  const segments: AncillarySegment[] = [];
  for (const offer of context.offers) {
    for (const pricing of offer.parsed.travelerPricings) {
      if (!travelers.has(pricing.travelerId)) {
        travelers.set(pricing.travelerId, {
          travelerId: pricing.travelerId,
          travelerType: pricing.travelerType,
        });
      }
    }
    offer.parsed.itineraries.forEach((itinerary, itineraryIndex) => {
      for (const segment of itinerary.segments) {
        segments.push({
          segmentId: segment.id,
          offerId: offer.offerId,
          itineraryIndex,
          originCode: segment.departure.iataCode,
          destinationCode: segment.arrival.iataCode,
          flightNumber: `${segment.carrierCode}${segment.number}`,
          departureAt: segment.departure.at,
        });
      }
    });
  }
  const seats = options.filter((option) => option.type === "SEATS");
  return {
    pricedOfferId: context.pricedOfferId,
    currency: context.currency,
    travelers: [...travelers.values()],
    segments,
    checkedBags: options.filter((option) => option.type === "CHECKED_BAGS"),
    cabinBags: options.filter((option) => option.type === "CABIN_BAGS"),
    otherServices: options.filter((option) => option.type === "OTHER_SERVICES"),
    seats,
    seatsSupported: seats.length > 0,
    loadedAt: source.loadedAt.toISOString(),
    expiresAt: context.expiresAt.toISOString(),
    warnings: warningsOf(source.warnings),
  };
}

/** Which ancillary kinds a priced offer shows (PricedOfferAncillaryAvailability). */
export function ancillaryAvailabilityOf(
  catalogue: AncillaryCatalogue | null,
  loaded: boolean,
  seats: boolean,
): AncillaryAvailability {
  return {
    loaded,
    checkedBags: (catalogue?.checkedBags.length ?? 0) > 0,
    cabinBags: (catalogue?.cabinBags.length ?? 0) > 0,
    otherServices: (catalogue?.otherServices.length ?? 0) > 0,
    seats,
  };
}

// ---- Fare rules ----------------------------------------------------------------------------------------------------

/** The fare data of one offer: its `fareRules` (Amadeus FareRules) and its parsed reading. */
export interface FareRulesOffer {
  readonly offerId: string;
  readonly fareRules: unknown;
  readonly parsed: ParsedOffer;
}

/** Where fare rules come from: the offers' `fareRules` and `included.detailed-fare-rules` of one answer. */
export interface FareRulesSource {
  readonly offers: readonly FareRulesOffer[];
  readonly detailedFareRules: unknown;
  readonly loadedAt: Date;
  readonly warnings: unknown;
}

const descriptionsOf = (value: unknown): FareRuleText[] =>
  records(value).flatMap((description) => {
    const body = text(description["text"]);
    return body === undefined
      ? []
      : [{ descriptionType: text(description["descriptionType"]) ?? null, text: body }];
  });

/** The rules of an Amadeus `fareRules`, with their currency. */
function rulesOf(fareRules: unknown): {
  readonly currency: string | undefined;
  readonly rules: JsonObject[];
} {
  const raw = isRecord(fareRules) ? fareRules : {};
  const currency = text(raw["currency"]);
  return {
    currency: currency !== undefined && CURRENCY.test(currency) ? currency : undefined,
    rules: records(raw["rules"]),
  };
}

function penaltyOf(rule: JsonObject, currency: string): MoneyAmount | null {
  const amount = text(rule["maxPenaltyAmount"]);
  return amount !== undefined && MONEY_AMOUNT.test(amount) ? { amount, currency } : null;
}

/** One entry per offer and Amadeus rule (categories outside the document's list are left out). */
function categoriesOf(source: FareRulesSource, fallbackCurrency: string): FareRuleCategory[] {
  return source.offers.flatMap((offer) => {
    const { currency, rules } = rulesOf(offer.fareRules);
    return rules.flatMap((rule): FareRuleCategory[] => {
      const category = rule["category"];
      if (!oneOf(category, FARE_RULE_CATEGORIES)) {
        return [];
      }
      const applicability = isRecord(rule["applicability"]) ? rule["applicability"] : {};
      return [
        {
          offerId: offer.offerId,
          category,
          applicable: rule["notApplicable"] !== true,
          chargeable: flag(rule["isChargeable"]) ?? null,
          maxPenalty: penaltyOf(rule, currency ?? fallbackCurrency),
          circumstances: text(rule["circumstances"]) ?? null,
          travelerIds: strings(applicability["travelerIds"]),
          segmentIds: strings(applicability["segmentIds"]),
          texts: descriptionsOf(rule["descriptions"]),
        },
      ];
    });
  });
}

/** `included.detailed-fare-rules` as FareRuleComponent, in key order. */
function fareComponentsOf(detailed: unknown): FareRuleComponent[] {
  const map = isRecord(detailed) ? detailed : {};
  return sortedKeys(map).flatMap((key) => {
    const entry = map[key];
    if (!isRecord(entry)) {
      return [];
    }
    const notes = isRecord(entry["fareNotes"]) ? entry["fareNotes"] : {};
    return [
      {
        key,
        fareBasis: text(entry["fareBasis"]) ?? null,
        name: text(entry["name"]) ?? null,
        segmentId: text(entry["segmentId"]) ?? null,
        category: text(notes["category"]) ?? null,
        notes: descriptionsOf(notes["descriptions"]),
      },
    ];
  });
}

/** What the detailed fare notes say, as far as their wording is unambiguous. */
function notesVerdict(components: readonly FareRuleComponent[]): {
  readonly refundable: boolean | null;
  readonly changeable: boolean | null;
} {
  const notes = components.flatMap((component) => component.notes.map((note) => note.text)).join("\n");
  const refundable = /\bNON[\s-]?REFUNDABLE\b|\bREFUNDS?\s+(?:ARE\s+)?NOT\s+(?:PERMITTED|ALLOWED)\b/i.test(
    notes,
  )
    ? false
    : null;
  const changeable = /\bCHANGES?\s+(?:ARE\s+)?NOT\s+(?:PERMITTED|ALLOWED)\b|\bNO\s+CHANGES?\b/i.test(notes)
    ? false
    : /\bCHANGES?\b[^.]*?\b(?:CHARGE|PERMITTED|ALLOWED|FREE)\b/i.test(notes)
      ? true
      : null;
  return { refundable, changeable };
}

/** The most restrictive verdict of several offers: any `false` wins, then any unknown, else `true`. */
function strictest(verdicts: ReadonlyArray<boolean | null>): boolean | null {
  if (verdicts.includes(false)) {
    return false;
  }
  return verdicts.length === 0 || verdicts.includes(null) ? null : true;
}

/** The highest penalty of the rules of `categories`, among those of one currency (the first one seen). */
function highestPenalty(categories: readonly FareRuleCategory[]): MoneyAmount | null {
  let highest: MoneyAmount | null = null;
  for (const category of categories) {
    const penalty = category.maxPenalty;
    if (
      category.applicable &&
      penalty !== null &&
      penalty !== undefined &&
      (highest === null ||
        (penalty.currency === highest.currency && new Money(penalty.amount).gt(highest.amount)))
    ) {
      highest = penalty;
    }
  }
  return highest;
}

/**
 * Refund and change conditions at a glance (FareRuleSummary), the most restrictive over the offers: per offer the fare
 * rules decide (any applicable REFUND rule = refundable, only not-applicable ones = not; EXCHANGE, REISSUE, REBOOK or
 * REVALIDATION for changes), else the detailed fare notes when their wording is unambiguous (`NON-REFUNDABLE`,
 * `CHANGES NOT PERMITTED`, `CHANGES … CHARGE`), else the branded-fare amenities (offers.mapper.ts), else unknown.
 * `source` names the most authoritative source used.
 */
export function fareRuleSummaryOf(source: FareRulesSource, currency: string): FareRuleSummary {
  const categories = categoriesOf(source, currency);
  const notes = notesVerdict(fareComponentsOf(source.detailedFareRules));
  const used = new Set<FareRuleSummary["source"]>();
  const verdict = (
    offer: FareRulesOffer,
    pick: (category: string) => boolean,
    field: "refundable" | "changeable",
  ) => {
    const matching = categories.filter(
      (category) => category.offerId === offer.offerId && pick(category.category),
    );
    if (matching.length > 0) {
      used.add("fare_rules");
      return matching.some((category) => category.applicable);
    }
    if (notes[field] !== null) {
      used.add("detailed_fare_rules");
      return notes[field];
    }
    if (offer.parsed[field] !== null) {
      used.add("amenities");
    }
    return offer.parsed[field];
  };
  const refundable = strictest(
    source.offers.map((offer) => verdict(offer, (c) => c === "REFUND", "refundable")),
  );
  const changeable = strictest(
    source.offers.map((offer) => verdict(offer, (c) => CHANGE_CATEGORIES.has(c), "changeable")),
  );
  const order: Array<FareRuleSummary["source"]> = ["fare_rules", "detailed_fare_rules", "amenities"];
  return {
    refundable,
    changeable,
    refundPenalty: highestPenalty(categories.filter((category) => category.category === "REFUND")),
    changePenalty: highestPenalty(categories.filter((category) => CHANGE_CATEGORIES.has(category.category))),
    source: order.find((name) => used.has(name)) ?? "unknown",
  };
}

/** True when the source has any rule of the document's categories or any detailed fare note. */
export function hasFareRules(source: FareRulesSource): boolean {
  return (
    source.offers.some((offer) =>
      rulesOf(offer.fareRules).rules.some((rule) => oneOf(rule["category"], FARE_RULE_CATEGORIES)),
    ) || fareComponentsOf(source.detailedFareRules).length > 0
  );
}

/**
 * The fare rules of a priced offer (FareRuleSet): the summary, one category entry per offer and rule, the detailed
 * notes per fare component, and the raw Amadeus data (offers whose `fareRules` have no rule are left out of `raw`).
 * Penalties are in the currency of the offer's `fareRules` (no FX in the MVP).
 */
export function fareRuleSetOf(pricedOfferId: string, currency: string, source: FareRulesSource): FareRuleSet {
  const categories = categoriesOf(source, currency);
  const fareComponents = fareComponentsOf(source.detailedFareRules);
  const penaltyCurrency =
    source.offers.map((offer) => rulesOf(offer.fareRules).currency).find((code) => code !== undefined) ??
    currency;
  return {
    pricedOfferId,
    currency: penaltyCurrency,
    available: categories.length > 0 || fareComponents.length > 0,
    summary: fareRuleSummaryOf(source, currency),
    categories,
    fareComponents,
    raw: {
      fareRules: source.offers.flatMap((offer) =>
        rulesOf(offer.fareRules).rules.length === 0
          ? []
          : [
              {
                offerId: offer.offerId,
                fareRules: offer.fareRules as FareRuleSet["raw"]["fareRules"][number]["fareRules"],
              },
            ],
      ),
      detailedFareRules: (isRecord(source.detailedFareRules)
        ? source.detailedFareRules
        : {}) as FareRuleSet["raw"]["detailedFareRules"],
    },
    loadedAt: source.loadedAt.toISOString(),
    warnings: warningsOf(source.warnings),
  };
}

// ---- Warnings ------------------------------------------------------------------------------------------------------

/** Amadeus warnings as the document's Warning (title required; other fields copied when well-typed). */
export function warningsOf(value: unknown): Warning[] {
  return records(value).flatMap((entry) => {
    const title = text(entry["title"]);
    if (title === undefined) {
      return [];
    }
    const warning: Warning = { title };
    const code = integer(entry["code"]);
    if (code !== undefined) {
      warning.code = code;
    }
    const detail = text(entry["detail"]);
    if (detail !== undefined) {
      warning.detail = detail;
    }
    const source = entry["source"];
    if (isRecord(source)) {
      const copy: NonNullable<Warning["source"]> = {};
      for (const field of ["parameter", "pointer", "example"] as const) {
        const value = text(source[field]);
        if (value !== undefined) {
          copy[field] = value;
        }
      }
      warning.source = copy;
    }
    return [warning];
  });
}

// ---- The Amadeus exchange ------------------------------------------------------------------------------------------

/**
 * `amadeus` of a priced offer: the query, the answer's `data` and its `included` maps. Console scope gets them
 * verbatim; customer scope gets each confirmed offer with its markup folded in (`sellingAmadeusOffer`, as in the
 * results), the rest as answered (booking requirements, card fees and ancillary prices carry no markup). An answered
 * offer that is not one of the priced offers has no selling price: customer scope never gets it, since its amounts
 * are net.
 */
export function pricedOfferAmadeusOf(
  reply: PricingReply,
  parts: readonly PricedOfferPart[],
  query: { readonly include: readonly PricingInclude[]; readonly forceClass: boolean },
  scope: OfferScope,
  minorUnits: number,
): PricedOfferAmadeus {
  const data =
    scope === "console"
      ? reply.data
      : {
          ...reply.data,
          flightOffers: reply.flightOffers.flatMap((payload) => {
            const id = isRecord(payload) ? payload["id"] : undefined;
            const part = parts.find((candidate) => candidate.amadeusOfferId === id);
            return part === undefined
              ? []
              : [sellingAmadeusOffer(payload, part.parsed, part.markup, minorUnits)];
          }),
        };
  const amadeus: PricedOfferAmadeus = {
    query: { include: query.include.join(","), forceClass: query.forceClass },
    data: { ...data, type: text(data["type"]) ?? "flight-offers-pricing" } as PricedOfferAmadeus["data"],
  };
  if (Object.keys(reply.included).length > 0) {
    amadeus.included = reply.included as NonNullable<PricedOfferAmadeus["included"]>;
  }
  return amadeus;
}

// ---- The answer ----------------------------------------------------------------------------------------------------

/** A stored priced offer as `toPricedOffer` reads it (the row's columns and the parsed stored answer). */
export interface StoredPricedOffer {
  readonly id: string;
  readonly searchId: string;
  readonly offerIds: readonly string[];
  readonly currency: string;
  readonly netTotal: string;
  readonly markupAmount: string;
  readonly feeAmount: string;
  readonly sellingTotal: string;
  readonly markupRuleId: string | null;
  readonly lastTicketingDate: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly snapshot: PricingSnapshot;
  readonly reply: PricingReply;
}

/** What the answer needs besides the stored row. */
export interface PricedOfferContext {
  readonly scope: OfferScope;
  readonly now: Date;
  /** The priced offers in the order of `offerIds`, with their confirmed readings and markups. */
  readonly parts: readonly PricedOfferPart[];
  /** The offers as FlightOffer (full view, confirmed amounts), in the same order. */
  readonly offers: readonly FlightOffer[];
  readonly dictionaries: Dictionaries;
}

/**
 * The PricedOffer of a stored priced offer: what flights.price answers and flights.getPricedOffer reads again. The
 * embedded catalogue and fare rules are those of the pricing answer: what flights.getAncillaries and
 * flights.getFareRules load later is not part of it.
 */
export function toPricedOffer(stored: StoredPricedOffer, context: PricedOfferContext): PricedOffer {
  const { snapshot, reply, currency } = stored;
  const minorUnits = snapshot.minorUnits;
  const offerIdOf = (amadeusId: string): string | undefined =>
    context.parts.find((part) => part.amadeusOfferId === amadeusId)?.offerId;
  const confirmed: ConfirmedOffer[] = context.parts.map((part) => ({
    offerId: part.offerId,
    amadeusOfferId: part.amadeusOfferId,
    payload: part.payload,
    parsed: part.parsed,
  }));
  const include = snapshot.include;
  const bagsOrServices = include.includes("bags") || include.includes("other-services");
  const catalogue = bagsOrServices
    ? ancillaryCatalogueOf(
        {
          included: reply.included,
          optionIds: snapshot.optionIds,
          loadedAt: stored.createdAt,
          warnings: reply.warnings,
        },
        {
          pricedOfferId: stored.id,
          currency,
          minorUnits,
          scope: context.scope,
          expiresAt: stored.expiresAt,
          offers: confirmed,
        },
      )
    : null;
  const fareSource: FareRulesSource = {
    offers: context.parts.map((part) => ({
      offerId: part.offerId,
      fareRules: isRecord(part.payload) ? part.payload["fareRules"] : undefined,
      parsed: part.parsed,
    })),
    detailedFareRules: reply.included["detailed-fare-rules"],
    loadedAt: stored.createdAt,
    warnings: reply.warnings,
  };
  const fareRulesAsked = include.includes("detailed-fare-rules") || snapshot.fareRules;
  const seats = seatDrafts(confirmed).length > 0;
  const result: PricedOffer = {
    id: stored.id,
    status: stored.expiresAt.getTime() <= context.now.getTime() ? "expired" : "active",
    searchId: stored.searchId,
    offerIds: [...stored.offerIds],
    customerId: snapshot.customerId,
    offers: [...context.offers],
    price: pricedSellingPrice(context.parts, snapshot.feeLines, currency, minorUnits),
    priceChange: priceChangeOf(
      snapshot.resultsTotal,
      stored.feeAmount,
      stored.sellingTotal,
      currency,
      minorUnits,
    ),
    bookingRequirements: bookingRequirementsOf(reply.bookingRequirements, offerIdOf),
    creditCardFees: creditCardFeesOf(reply.included, offerIdOf),
    selectedAncillaries: [],
    ancillaries: ancillaryAvailabilityOf(
      catalogue,
      include.includes("bags") && include.includes("other-services"),
      seats,
    ),
    conditions: fareRuleSummaryOf(fareSource, currency),
    fareRules:
      fareRulesAsked && hasFareRules(fareSource) ? fareRuleSetOf(stored.id, currency, fareSource) : null,
    ancillaryCatalogue: catalogue,
    include: [...include],
    forceClass: snapshot.forceClass,
    lastTicketingDate: stored.lastTicketingDate,
    instantTicketingRequired: context.parts.some((part) => part.parsed.instantTicketingRequired),
    paymentCardRequired: context.parts.some((part) => part.parsed.paymentCardRequired === true),
    dictionaries: context.dictionaries,
    warnings: warningsOf(reply.warnings),
    amadeus: pricedOfferAmadeusOf(
      reply,
      context.parts,
      { include, forceClass: snapshot.forceClass },
      context.scope,
      minorUnits,
    ),
    createdAt: stored.createdAt.toISOString(),
    expiresAt: stored.expiresAt.toISOString(),
  };
  if (context.scope === "console") {
    const first = snapshot.offers[0];
    result.netPrice = money(stored.netTotal, currency, minorUnits);
    result.markup = {
      amount: money(stored.markupAmount, currency, minorUnits),
      ruleId: stored.markupRuleId,
      ruleName: first?.markupRuleName ?? null,
      serviceFee: snapshot.feeLines.length === 0 ? null : money(stored.feeAmount, currency, minorUnits),
    };
  }
  return result;
}
