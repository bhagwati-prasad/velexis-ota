// `flights.upsell` (upsellFlightOffer; OBE-022; ota/docs/flows/search-and-price.md §2 step 6, OADR-0002 points 1, 3
// and 5, OADR-0005): the airline's other fare families on the same flights, from Amadeus Branded Fares Upsell, stored as
// new offers (`origin = 'upsell'`) priced like search results, with a side-by-side comparison for a fare-family picker.
//
//   1. one transaction reads and checks: the storefront feature `brandedFareUpsell` in customer scope (`403
//      FEATURE_DISABLED`, `details.feature`; console scope may always call it), the path offer and `combineWithOfferIds`
//      as flights.getOffer reads them (`404`, `410 OFFER_EXPIRED`), all of one search (`422 OFFER_COMBINATION_INVALID`),
//      then builds the Amadeus request: `data.flightOffers` = the stored Amadeus offers verbatim, `data.payments` = the
//      card hints (`bin` as the integer `binNumber`, `offerIds` as Amadeus ids, all offers by default). An identical
//      request (jsonb equality of that request: same offers, same payments) of an upsell that has not expired is
//      answered again from `offer_upsells` (same `ups_` and `off_` ids, `cached: true`) without calling Amadeus;
//   2. Amadeus is called outside any transaction (AmadeusClient: rate limits, timeout, one retry of this read, error
//      mapping: error 34651 is `409 SOLD_OUT`); its `supplier_requests` row links to the base offer's search;
//   3. one transaction prices every readable offer of the answer with the engine (step `search`: markup only, in the
//      search's channel, so the alternatives compare with the search price) and inserts the `offer_upsells` row
//      (`completed`, or `no_upsell` when nothing could be stored) and the upsold `flight_offers` (`search_id` of the
//      base offer's search, so they are read, expire and are purged with it). Everything shares the search's
//      `expires_at` (OADR-0002 point 3; the document's "min(search expiry, now + 30 min)" is the same thing with the
//      default 30-minute TTL), and the answer is built from the stored rows, as a cached answer is.
//
// The answer's offers are the summary view plus `travelerPricings` (selling amounts in customer scope, `netPrice` and
// `markup` in console scope). `oneWayUpselledCombinations` (two or more input offers) is rebuilt from the flights of
// the stored offers, an upsell offer replacing the input offer that flies the same segments, so a cached answer equals
// the first one: the Amadeus `meta` is kept nowhere.
import { Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import { PinoLogger } from "nestjs-pino";
import { AmadeusClient, type AmadeusResponse } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { priceOffer } from "../pricing/pricing-engine";
import { Money, PricingInputError, type PricingResult } from "../pricing/pricing.types";
import { RulesRepository } from "../pricing/rules.repository";
import { displayLanguage, ReferenceNames } from "../reference/reference.mapper";
import { DEFAULT_FEATURES } from "../storefront/storefront.mapper";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  MAX_OFFERS_PER_SEARCH,
  netTotalOf,
  offerColumns,
  parseOffer,
  pricingInputOf,
  TRAVEL_CLASSES,
  type FlightOffer,
  type OfferColumns,
  type OfferScope,
  type ParsedOffer,
} from "./offers.mapper";
import { OffersRepository, type OfferRow, type UpsellRow } from "./offers.repository";
import { OffersService, offerDictionaries, parsedOfferOf, toOfferResponse } from "./offers.service";
import {
  addOfferCodes,
  amadeusDictionaries,
  emptyCodes,
  SearchesService,
  warningsOf,
  type AmadeusDictionaries,
} from "./searches.service";

type Schemas = components["schemas"];
export type UpsellResult = Schemas["UpsellResult"];
export type UpsellRequest = Schemas["UpsellRequest"];
type OfferPaymentCard = Schemas["OfferPaymentCard"];
type UpsellComparison = Schemas["UpsellComparison"];
type ComparisonColumn = Schemas["UpsellComparisonColumn"];
type ComparisonRow = Schemas["UpsellComparisonRow"];
type ComparisonCell = Schemas["UpsellComparisonCell"];
type OneWayCombination = Schemas["UpsellOneWayCombination"];
type BagAllowance = Schemas["BagAllowance"];
type AmenityType = Schemas["AmadeusAmenityType"];

/** The input of flights.upsell. */
export interface UpsellInput {
  readonly offerId: string;
  readonly body?: UpsellRequest | undefined;
  /** `Accept-Language`: the language of the dictionaries' country and currency names. */
  readonly acceptLanguage?: string | undefined;
}

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---- The Amadeus request -------------------------------------------------------------------------------------------

/** The Amadeus Branded Fares Upsell request (`Get_Upsell_Query`), as sent and as stored in `offer_upsells`. */
export interface AmadeusUpsellRequest {
  readonly data: {
    readonly type: "flight-offer-upsell";
    readonly flightOffers: readonly unknown[];
    readonly payments?: ReadonlyArray<{
      readonly brand: string;
      readonly binNumber?: number;
      readonly flightOfferIds: readonly string[];
    }>;
  };
}

/** Why the input offers cannot be upsold together: a field error of the body, or offers Amadeus cannot combine. */
export type UpsellRequestProblem =
  | { readonly kind: "validation"; readonly path: string; readonly code: string; readonly message: string }
  | { readonly kind: "combination"; readonly message: string };

/** One input offer of an upsell: its id, its Amadeus id and its verbatim Amadeus payload. */
export interface UpsellInputOffer {
  readonly id: string;
  readonly amadeusOfferId: string;
  readonly payload: unknown;
}

/**
 * The Amadeus request for `offers` (the path offer first) and the card hints, or the first problem: two offers with
 * the same Amadeus id cannot be told apart in `flightOfferIds` (an offer of the search and an upsell offer), and a
 * card's `offerIds` must name offers of the request. Empty `payments` are left out, so an identical request is
 * stored identically.
 */
export function buildUpsellRequest(
  offers: readonly UpsellInputOffer[],
  payments: readonly OfferPaymentCard[] | undefined,
): AmadeusUpsellRequest | UpsellRequestProblem {
  const amadeusIds = new Map<string, string>();
  for (const offer of offers) {
    if ([...amadeusIds.values()].includes(offer.amadeusOfferId)) {
      return {
        kind: "combination",
        message: "These offers cannot be upsold together: upsell them one at a time.",
      };
    }
    amadeusIds.set(offer.id, offer.amadeusOfferId);
  }
  const cards: Array<{ brand: string; binNumber?: number; flightOfferIds: string[] }> = [];
  for (const [index, card] of (payments ?? []).entries()) {
    const flightOfferIds: string[] = [];
    for (const [position, offerId] of (card.offerIds ?? offers.map((offer) => offer.id)).entries()) {
      const amadeusId = amadeusIds.get(offerId);
      if (amadeusId === undefined) {
        return {
          kind: "validation",
          path: `/payments/${index}/offerIds/${position}`,
          code: "not_in_request",
          message: "The card can only pay for offers of this upsell (offerId and combineWithOfferIds).",
        };
      }
      flightOfferIds.push(amadeusId);
    }
    cards.push({
      brand: card.brand,
      // The BIN is six digits (validated); Amadeus takes it as an integer. It is no amount.
      ...(card.bin === undefined ? {} : { binNumber: Number.parseInt(card.bin, 10) }),
      flightOfferIds,
    });
  }
  return {
    data: {
      type: "flight-offer-upsell",
      flightOffers: offers.map((offer) => offer.payload),
      ...(cards.length === 0 ? {} : { payments: cards }),
    },
  };
}

// ---- One-way combinations ------------------------------------------------------------------------------------------

/** The flights of an offer: carrier, number and local departure of every segment, by itinerary. */
function flightsOf(offer: ParsedOffer): string {
  return offer.itineraries
    .map((itinerary) =>
      itinerary.segments
        .map(
          (segment) =>
            `${segment.carrierCode}${segment.number}@${segment.departure.iataCode}${segment.departure.at}`,
        )
        .join("+"),
    )
    .join("|");
}

/** For each input offer, the upsell offers that fly its segments (Amadeus `meta.oneWayUpselledCombinations`). */
export function oneWayUpselledCombinations(
  inputs: ReadonlyArray<{ readonly id: string; readonly offer: ParsedOffer }>,
  upsells: ReadonlyArray<{ readonly id: string; readonly offer: ParsedOffer }>,
): OneWayCombination[] {
  return inputs.map((input) => {
    const flights = flightsOf(input.offer);
    return {
      offerId: input.id,
      upsellOfferIds: upsells
        .filter((upsell) => flightsOf(upsell.offer) === flights)
        .map((upsell) => upsell.id),
    };
  });
}

// ---- The comparison ------------------------------------------------------------------------------------------------

type CellStatus = ComparisonCell["status"];
type KnownStatus = Exclude<CellStatus, "unknown">;

/** The normalised features, in the order of the rows; the first three always have a row. */
const FEATURES = Object.freeze([
  { key: "checked_bags", label: "Checked bags", amenityType: "BAGGAGE", always: true },
  { key: "cabin_bag", label: "Cabin bag", amenityType: "BAGGAGE", always: false },
  { key: "refund", label: "Refund", amenityType: null, always: true },
  { key: "change", label: "Change", amenityType: null, always: true },
  { key: "seat_selection", label: "Seat selection", amenityType: "PRE_RESERVED_SEAT", always: false },
  { key: "meal", label: "Meal", amenityType: "MEAL", always: false },
  { key: "lounge", label: "Lounge", amenityType: "LOUNGE", always: false },
  { key: "priority_boarding", label: "Priority boarding", amenityType: null, always: false },
  { key: "miles", label: "Miles", amenityType: "FREQUENT_FLYER", always: false },
] as const satisfies ReadonlyArray<{
  key: string;
  label: string;
  amenityType: AmenityType | null;
  always: boolean;
}>);
type FeatureKey = (typeof FEATURES)[number]["key"];

/** The normalised feature an amenity describes, or `undefined` (its row is then keyed by the amenity code). */
export function featureKeyOf(description: string, amenityType: AmenityType | null): FeatureKey | undefined {
  const text = description.toUpperCase();
  if (amenityType === "BAGGAGE" || /\b(?:BAGS?|BAGGAGE|LUGGAGE)\b/.test(text)) {
    return /\b(?:CABIN|CARRY[\s-]?ON|HAND|PERSONAL ITEM|UNDER ?SEAT)\b/.test(text)
      ? "cabin_bag"
      : "checked_bags";
  }
  if (/REFUND/.test(text)) {
    return "refund";
  }
  if (/CHANGE|EXCHANGE|REBOOK/.test(text)) {
    return "change";
  }
  if (amenityType === "PRE_RESERVED_SEAT" || amenityType === "SEAT" || /\bSEAT/.test(text)) {
    return "seat_selection";
  }
  if (amenityType === "MEAL" || /\b(?:MEALS?|SNACKS?|FOOD)\b/.test(text)) {
    return "meal";
  }
  if (amenityType === "LOUNGE" || /LOUNGE/.test(text)) {
    return "lounge";
  }
  if (/PRIORITY/.test(text)) {
    return "priority_boarding";
  }
  if (amenityType === "FREQUENT_FLYER" || /\b(?:MILES|MILEAGE|POINTS)\b/.test(text)) {
    return "miles";
  }
  return undefined;
}

/**
 * An amenity that says the feature is not part of the fare: `NON REFUNDABLE`, `NONREFUNDABLE`, `NO CHANGES`, `REFUND
 * NOT ALLOWED`.
 */
const NEGATED = /\bNON[\s-]?\w|\b(?:NO|NOT)\b[\s-]*\w|\w\s+NOT\b/i;

/** How strongly a status speaks against the feature: the strongest of an offer's mentions wins. */
const STATUS_RANK: Readonly<Record<KnownStatus, number>> = Object.freeze({
  included: 0,
  chargeable: 1,
  not_offered: 2,
});

/** What an offer's amenities say about one feature. */
interface Mention {
  readonly key: string;
  readonly label: string;
  readonly amenityType: AmenityType | null;
  readonly status: KnownStatus;
}

/** Traveller types that stand for the offer (FlightSearchSummary's adults; offers.mapper.ts `leadPricing`). */
const ADULT_TYPES: ReadonlySet<string> = new Set(["ADULT", "SENIOR", "YOUNG", "STUDENT"]);

/** The amenities of the offer's lead traveller over every segment, by row key, in the order they appear. */
function mentionsOf(offer: FlightOffer): Map<string, Mention> {
  const pricings = offer.travelerPricings ?? [];
  const lead = pricings.find((pricing) => ADULT_TYPES.has(pricing.travelerType)) ?? pricings[0];
  const mentions = new Map<string, Mention>();
  for (const segment of lead?.segments ?? []) {
    for (const amenity of segment.amenities ?? []) {
      const description = amenity.description.trim();
      if (description === "") {
        continue;
      }
      const amenityType = amenity.amenityType ?? null;
      const feature = featureKeyOf(description, amenityType);
      const key = feature ?? amenity.code ?? description.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const status: KnownStatus = NEGATED.test(description)
        ? "not_offered"
        : amenity.status === "chargeable"
          ? "chargeable"
          : "included";
      const known = mentions.get(key);
      mentions.set(key, {
        key,
        label: known?.label ?? FEATURES.find((entry) => entry.key === feature)?.label ?? description,
        amenityType: known?.amenityType ?? amenityType,
        status:
          known === undefined || STATUS_RANK[status] > STATUS_RANK[known.status] ? status : known.status,
      });
    }
  }
  return mentions;
}

/** `1 × 23 kg`, `2 pieces`, `20 kg`: a bag allowance for a cell. */
function bagDetail(bags: BagAllowance): string | null {
  const unit = (bags.weightUnit ?? "kg").toLowerCase();
  if (bags.quantity !== null && bags.quantity !== undefined && bags.quantity > 0) {
    return bags.weight !== null && bags.weight !== undefined && bags.weight > 0
      ? `${bags.quantity} × ${bags.weight} ${unit}`
      : `${bags.quantity} ${bags.quantity === 1 ? "piece" : "pieces"}`;
  }
  return bags.weight !== null && bags.weight !== undefined && bags.weight > 0
    ? `${bags.weight} ${unit}`
    : null;
}

/** One column of the comparison: the offer as answered and its main cabin. */
export interface ComparisonOffer {
  readonly offer: FlightOffer;
  readonly mainCabin: Exclude<ComparisonColumn["cabin"], undefined>;
}

/** A cell of a bag row: the allowance decides when it is known, the amenities otherwise. */
function bagCell(
  allowance: BagAllowance | null | undefined,
  mention: Mention | undefined,
  hasAmenities: boolean,
): Pick<ComparisonCell, "status" | "detail"> {
  if (allowance !== null && allowance !== undefined) {
    const detail = bagDetail(allowance);
    if (detail !== null) {
      return { status: "included", detail };
    }
    return { status: mention?.status === "chargeable" ? "chargeable" : "not_offered", detail: null };
  }
  return { status: mention?.status ?? (hasAmenities ? "not_offered" : "unknown"), detail: null };
}

/** A cell of the refund or change row: the amenities, else the offer's known refundability or changeability. */
function conditionCell(
  known: boolean | null | undefined,
  mention: Mention | undefined,
  hasAmenities: boolean,
): Pick<ComparisonCell, "status" | "detail"> {
  if (mention !== undefined) {
    return { status: mention.status, detail: null };
  }
  if (known === false) {
    return { status: "not_offered", detail: null };
  }
  if (known === true) {
    return { status: "included", detail: null };
  }
  return { status: hasAmenities ? "not_offered" : "unknown", detail: null };
}

/**
 * The side-by-side comparison of the base offer and its upsell offers: columns base first, then the upsell offers by
 * ascending selling price (ties in the answer's order); rows the normalised features (checked bags, refund and change
 * always, the others when an offer names them), then the other amenities by code, each with one cell per column. An
 * offer whose amenity list is published but lacks a feature does not offer it; without any amenities it is unknown.
 */
export function upsellComparison(
  base: ComparisonOffer,
  upsells: readonly ComparisonOffer[],
  minorUnits: number,
): UpsellComparison {
  const ordered = [
    base,
    ...[...upsells].sort((a, b) =>
      new Money(a.offer.price.total.amount).comparedTo(b.offer.price.total.amount),
    ),
  ];
  const baseTotal = new Money(base.offer.price.total.amount);
  const columns: ComparisonColumn[] = ordered.map((entry, index) => {
    const { offer } = entry;
    const outbound = offer.summary.brandedFares?.find((fare) => fare.itineraryIndex === 0);
    return {
      offerId: offer.id,
      isBaseOffer: index === 0,
      brandedFare: outbound?.code ?? null,
      brandedFareLabel: outbound?.label ?? null,
      cabin: entry.mainCabin,
      price: offer.price.total,
      priceDifference: {
        amount: new Money(offer.price.total.amount).minus(baseTotal).toFixed(minorUnits),
        currency: offer.price.total.currency,
      },
      includedCheckedBags: offer.summary.includedCheckedBags ?? null,
      refundable: offer.summary.refundable ?? null,
      changeable: offer.summary.changeable ?? null,
    };
  });
  const mentions = ordered.map((entry) => mentionsOf(entry.offer));
  const keys: string[] = FEATURES.filter(
    (feature) => feature.always || mentions.some((found) => found.has(feature.key)),
  ).map((feature) => feature.key);
  for (const found of mentions) {
    for (const key of found.keys()) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  const rows: ComparisonRow[] = keys.map((key) => {
    const feature = FEATURES.find((entry) => entry.key === key);
    const first = mentions.map((found) => found.get(key)).find((mention) => mention !== undefined);
    return {
      key,
      label: feature?.label ?? first?.label ?? key,
      amenityType: first?.amenityType ?? feature?.amenityType ?? null,
      values: ordered.map((entry, index) => {
        const mention = mentions[index]?.get(key);
        const hasAmenities = (mentions[index]?.size ?? 0) > 0;
        const summary = entry.offer.summary;
        const cell: Pick<ComparisonCell, "status" | "detail"> =
          key === "checked_bags"
            ? bagCell(summary.includedCheckedBags, mention, hasAmenities)
            : key === "cabin_bag"
              ? bagCell(summary.includedCabinBags, mention, hasAmenities)
              : key === "refund"
                ? conditionCell(summary.refundable, mention, hasAmenities)
                : key === "change"
                  ? conditionCell(summary.changeable, mention, hasAmenities)
                  : {
                      status: mention?.status ?? (hasAmenities ? "not_offered" : "unknown"),
                      detail: null,
                    };
        return { offerId: entry.offer.id, ...cell };
      }),
    };
  });
  return { columns, rows };
}

/** An upsell offer as the answer lists it: the summary view plus `travelerPricings` (no `amadeus`, no breakdown). */
function listedOffer(offer: FlightOffer): FlightOffer {
  const { amadeus: _amadeus, ...rest } = offer;
  const { breakdown: _breakdown, ...price } = rest.price;
  return { ...rest, price };
}

/** True when the storefront's `features` jsonb leaves Branded Fares Upsell on (the default). */
function upsellEnabled(features: unknown): boolean {
  const value = isRecord(features) ? features["brandedFareUpsell"] : undefined;
  return typeof value === "boolean" ? value : DEFAULT_FEATURES.brandedFareUpsell;
}

/** The Amadeus dictionaries of `a`, completed by those of `b`. */
function mergeDictionaries(a: AmadeusDictionaries, b: AmadeusDictionaries): AmadeusDictionaries {
  return {
    locations: { ...b.locations, ...a.locations },
    carriers: { ...b.carriers, ...a.carriers },
    aircraft: { ...b.aircraft, ...a.aircraft },
    currencies: { ...b.currencies, ...a.currencies },
  };
}

/** The checked input of an upsell that calls Amadeus. */
interface PreparedUpsell {
  readonly kind: "call";
  /** The path offer first, then `combineWithOfferIds`. */
  readonly inputs: readonly OfferRow[];
  readonly request: AmadeusUpsellRequest;
  readonly requestJson: string;
  readonly minorUnits: number;
}

/** An Amadeus upsell offer about to be stored. */
interface UpsellCandidate {
  readonly id: string;
  readonly payload: unknown;
  readonly parsed: ParsedOffer;
  readonly position: number;
  readonly columns: OfferColumns;
  readonly result: PricingResult;
}

@Injectable()
export class UpsellService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly offers: OffersService,
    private readonly repository: OffersRepository,
    private readonly searches: SearchesService,
    private readonly rules: RulesRepository,
    private readonly amadeus: AmadeusClient,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(UpsellService.name);
  }

  /** Upsells the offer (and the offers combined with it), or answers an identical earlier upsell again. */
  async upsell(input: UpsellInput): Promise<UpsellResult> {
    const tenant = this.tenants.require();
    const scope = this.offers.scope();
    const language = new ReferenceNames(displayLanguage(input.acceptLanguage));
    const prepared = await this.tx.run((trx) => this.prepare(trx, input, scope, language));
    if (prepared.kind === "cached") {
      this.logger.info(
        { upsellId: prepared.result.id, baseOfferId: prepared.result.baseOfferId },
        "upsell.reused",
      );
      return prepared.result;
    }
    const base = prepared.inputs[0] as OfferRow;
    const context: AmadeusCallContext = {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation: "flights.upsell",
      requestId: this.tenants.requestId() ?? tenant.requestId,
      searchId: base.searchId,
    };
    const reply = await this.amadeus.upsellAirOffers(context, {
      // The stored Amadeus offers verbatim and the card hints, as the Branded Fares Upsell specification defines them.
      body: prepared.request as unknown as Parameters<AmadeusClient["upsellAirOffers"]>[1]["body"],
    });
    const result = await this.tx.run((trx) => this.store(trx, tenant, prepared, reply, scope, language));
    this.logger.info(
      {
        upsellId: result.id,
        baseOfferId: result.baseOfferId,
        resultCount: result.offers.length,
        durationMs: reply.call.durationMs,
      },
      "upsell.completed",
    );
    return result;
  }

  /** Step 1: the checks, the Amadeus request, and an identical earlier upsell when there is one. */
  private async prepare(
    trx: TenantTransaction,
    input: UpsellInput,
    scope: OfferScope,
    language: ReferenceNames,
  ): Promise<PreparedUpsell | { readonly kind: "cached"; readonly result: UpsellResult }> {
    if (scope === "customer" && !upsellEnabled(await this.repository.features(trx))) {
      throw new AppError("FEATURE_DISABLED", {
        message: "Branded fare upsell is not enabled for this storefront.",
        details: { feature: "brandedFareUpsell" },
      });
    }
    const combine = input.body?.combineWithOfferIds ?? [];
    const repeated = combine.indexOf(input.offerId);
    if (repeated >= 0) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          {
            path: `/combineWithOfferIds/${repeated}`,
            code: "duplicate",
            message: "The offer to upsell is already part of the request.",
          },
        ],
      });
    }
    const ids = [input.offerId, ...combine];
    const inputs = await this.offers.readable(trx, ids, scope);
    if (inputs.length !== ids.length) {
      throw new AppError("NOT_FOUND", { message: "No flight offer with this id." });
    }
    const now = this.clock.now();
    if (inputs.some((row) => row.expiresAt.getTime() <= now.getTime())) {
      throw new AppError("OFFER_EXPIRED");
    }
    const base = inputs[0] as OfferRow;
    if (inputs.some((row) => row.searchId !== base.searchId || row.currency !== base.currency)) {
      throw new AppError("OFFER_COMBINATION_INVALID", {
        message: "Only offers of the same search can be upsold together.",
      });
    }
    const request = buildUpsellRequest(inputs, input.body?.payments);
    if ("kind" in request) {
      if (request.kind === "combination") {
        throw new AppError("OFFER_COMBINATION_INVALID", { message: request.message });
      }
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [{ path: request.path, code: request.code, message: request.message }],
      });
    }
    const minorUnits = await this.offers.minorUnits(trx, base.currency);
    const requestJson = JSON.stringify(request);
    const reusable = await this.repository.reusableUpsell(trx, base.id, requestJson, now);
    if (reusable !== undefined) {
      const offers = await this.repository.upsellOffers(trx, reusable.id);
      return {
        kind: "cached",
        result: await this.answer(trx, reusable, inputs, offers, {
          scope,
          language,
          minorUnits,
          cached: true,
          now,
        }),
      };
    }
    return { kind: "call", inputs, request, requestJson, minorUnits };
  }

  /** Step 3: prices and stores the upsell offers of the Amadeus answer, and answers from the stored rows. */
  private async store(
    trx: TenantTransaction,
    tenant: RequestTenant,
    prepared: PreparedUpsell,
    reply: AmadeusResponse<unknown>,
    scope: OfferScope,
    language: ReferenceNames,
  ): Promise<UpsellResult> {
    const base = prepared.inputs[0] as OfferRow;
    const body = isRecord(reply.body) ? reply.body : {};
    const answerDictionaries = isRecord(body["dictionaries"]) ? body["dictionaries"] : {};
    const dictionaries = mergeDictionaries(
      offerDictionaries(prepared.inputs),
      amadeusDictionaries(answerDictionaries),
    );
    const cityOf = (code: string): string | null => dictionaries.locations[code]?.cityCode ?? null;
    const data: unknown[] = Array.isArray(body["data"]) ? body["data"] : [];
    const seen = new Set<string>();
    const readable: Array<{
      readonly payload: unknown;
      readonly parsed: ParsedOffer;
      readonly position: number;
    }> = [];
    let skipped = 0;
    data.forEach((payload, position) => {
      const parsed = parseOffer(payload);
      if (parsed === undefined || seen.has(parsed.amadeusId) || parsed.price.currency !== base.currency) {
        skipped += 1;
        return;
      }
      seen.add(parsed.amadeusId);
      readable.push({ payload, parsed, position });
    });
    const now = this.clock.now();
    const rules = await this.rules.loadActiveRules(trx);
    if (rules.invalidRules.length > 0) {
      this.logger.warn(
        {
          baseOfferId: base.id,
          invalidRules: rules.invalidRules.map(({ table, id, reason }) => ({ table, id, reason })),
        },
        "upsell.pricing_rules_skipped",
      );
    }
    const codes = emptyCodes();
    readable.forEach(({ parsed }) => addOfferCodes(codes, parsed));
    const countries = await this.searches.names(trx, codes, dictionaries, new ReferenceNames(undefined));
    const countryOf = (code: string): string | null => countries.names.location(code)?.countryCode ?? null;
    const channel = base.searchChannel === "console" ? "console" : "storefront";
    const candidates: UpsellCandidate[] = [];
    for (const { payload, parsed, position } of readable) {
      const columns = offerColumns(parsed, cityOf);
      const netTotal = netTotalOf(parsed, prepared.minorUnits);
      if (netTotal === undefined) {
        skipped += 1;
        continue;
      }
      try {
        const result = priceOffer(
          pricingInputOf(parsed, columns, {
            at: now,
            minorUnits: prepared.minorUnits,
            netTotal,
            channel,
            countryOf,
          }),
          rules.markupRules,
          rules.feeRules,
          { kind: "search" },
        );
        candidates.push({ id: this.ids.newId("off"), payload, parsed, position, columns, result });
      } catch (error) {
        if (!(error instanceof PricingInputError)) {
          throw error;
        }
        skipped += 1;
      }
      if (candidates.length === MAX_OFFERS_PER_SEARCH) {
        break;
      }
    }
    if (skipped > 0) {
      this.logger.warn({ baseOfferId: base.id, skipped }, "upsell.offers_skipped");
    }
    const upsell: UpsellRow = {
      id: this.ids.newId("ups"),
      baseOfferId: base.id,
      amadeusRequest: prepared.request,
      warnings: Array.isArray(body["warnings"]) ? body["warnings"] : [],
      dictionaries: answerDictionaries,
      status: candidates.length > 0 ? "completed" : "no_upsell",
      resultCount: candidates.length,
      // OADR-0002 point 3: upsell offers live as long as the search of the offer they upsell.
      expiresAt: base.searchExpiresAt,
      createdAt: now,
    };
    await this.repository.insertUpsell(trx, {
      id: upsell.id,
      base_offer_id: upsell.baseOfferId,
      amadeus_request: prepared.requestJson,
      warnings: JSON.stringify(upsell.warnings),
      dictionaries: JSON.stringify(upsell.dictionaries),
      status: upsell.status,
      result_count: upsell.resultCount,
      expires_at: upsell.expiresAt,
      created_at: now,
      updated_at: now,
    });
    await this.repository.insertOffers(
      trx,
      candidates.map((row) => ({
        id: row.id,
        environment: tenant.environment,
        origin: "upsell",
        search_id: base.searchId,
        upsell_id: upsell.id,
        amadeus_offer_id: row.parsed.amadeusId,
        source: row.parsed.source,
        position: row.position,
        payload: JSON.stringify(row.payload),
        currency: base.currency,
        net_total: row.result.net,
        markup_amount: row.result.markupTotal,
        selling_total: row.result.selling,
        markup_rule_id: row.result.markupRuleId,
        validating_carrier: row.columns.validatingCarrier,
        marketing_carriers: [...row.columns.marketingCarriers],
        origin_iata: row.columns.originIata,
        destination_iata: row.columns.destinationIata,
        first_departure_local: row.columns.firstDepartureLocal,
        last_arrival_local: row.columns.lastArrivalLocal,
        itinerary_departure_minutes: [...row.columns.departureMinutes],
        itinerary_arrival_minutes: [...row.columns.arrivalMinutes],
        itinerary_duration_minutes: [...row.columns.durationMinutes],
        max_stops: row.columns.maxStops,
        total_duration_minutes: row.columns.totalDurationMinutes,
        main_cabin: row.columns.mainCabin,
        min_checked_bags: row.columns.minCheckedBags,
        refundable: row.columns.refundable,
        changeable: row.columns.changeable,
        branded_fares: [...row.columns.brandedFares],
        best_score: null,
        bookable_seats: row.columns.bookableSeats,
        last_ticketing_date: row.columns.lastTicketingDate,
        instant_ticketing_required: row.columns.instantTicketingRequired,
        expires_at: upsell.expiresAt,
        created_at: now,
        updated_at: now,
      })),
    );
    const offers = await this.repository.upsellOffers(trx, upsell.id);
    return await this.answer(trx, upsell, prepared.inputs, offers, {
      scope,
      language,
      minorUnits: prepared.minorUnits,
      cached: false,
      now,
    });
  }

  /** The UpsellResult of a stored upsell, its input offers (the path offer first) and its stored offers. */
  private async answer(
    trx: TenantTransaction,
    upsell: UpsellRow,
    inputs: readonly OfferRow[],
    offers: readonly OfferRow[],
    options: {
      readonly scope: OfferScope;
      readonly language: ReferenceNames;
      readonly minorUnits: number;
      readonly cached: boolean;
      readonly now: Date;
    },
  ): Promise<UpsellResult> {
    const base = inputs[0] as OfferRow;
    const parsedInputs = inputs.map((row) => ({ id: row.id, row, offer: parsedOfferOf(row) }));
    const parsedOffers = offers.map((row) => ({ id: row.id, row, offer: parsedOfferOf(row) }));
    const codes = emptyCodes();
    [...parsedInputs, ...parsedOffers].forEach(({ offer }) => addOfferCodes(codes, offer));
    codes.currencies.add(base.currency);
    const dictionaries = mergeDictionaries(
      offerDictionaries([...inputs, ...offers]),
      amadeusDictionaries(upsell.dictionaries),
    );
    const nameSet = await this.searches.names(trx, codes, dictionaries, options.language);
    const context = {
      scope: options.scope,
      view: "full" as const,
      now: options.now,
      minorUnits: options.minorUnits,
      names: nameSet.names,
      dictionaries,
      offerIds: new Map<string, string>(),
    };
    const cityOf = (code: string): string | null => dictionaries.locations[code]?.cityCode ?? null;
    const comparisonOf = (entry: {
      readonly row: OfferRow;
      readonly offer: ParsedOffer;
    }): ComparisonOffer => {
      const cabin = offerColumns(entry.offer, cityOf).mainCabin;
      return {
        offer: toOfferResponse(entry.row, context),
        mainCabin: TRAVEL_CLASSES.find((travelClass) => travelClass === cabin) ?? null,
      };
    };
    const upsellOffers = parsedOffers.map(comparisonOf);
    const result: UpsellResult = {
      id: upsell.id,
      baseOfferId: base.id,
      offerIds: inputs.map((row) => row.id),
      offers: upsellOffers.map((entry) => listedOffer(entry.offer)),
      comparison: upsellComparison(
        comparisonOf({ row: base, offer: parsedOfferOf(base) }),
        upsellOffers,
        options.minorUnits,
      ),
      cached: options.cached,
      dictionaries: nameSet.dictionaries,
      warnings: warningsOf(upsell.warnings),
      createdAt: upsell.createdAt.toISOString(),
      expiresAt: upsell.expiresAt.toISOString(),
    };
    if (inputs.length > 1) {
      result.oneWayUpselledCombinations = oneWayUpselledCombinations(parsedInputs, parsedOffers);
    }
    return result;
  }
}
