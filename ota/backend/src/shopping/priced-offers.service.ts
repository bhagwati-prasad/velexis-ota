// `flights.price`, `flights.getPricedOffer`, `flights.getAncillaries` and `flights.getFareRules` (priceFlightOffers,
// getPricedOffer, getPricedOfferAncillaries, getPricedOfferFareRules; OBE-023; ota/docs/flows/search-and-price.md §2
// steps 7–8 and §3, OADR-0002 point 3, OADR-0005 points 5, 7 and 8).
//
// flights.price:
//   1. one transaction reads and checks: `offerIds` as flights.getOffer reads them (`404`, `410 OFFER_EXPIRED`), all of
//      one search (`422 OFFER_COMBINATION_INVALID`, `details.reason` `different_search`, `duplicate` or
//      `travelers_mismatch`), then builds the Amadeus request (priced-offers.mapper.ts `buildPricingRequest`) with the
//      `include` of the request or the defaults (`pricingIncludeOf`). Raw `amadeusFlightOffers` are console scope only
//      (`403 SCOPE_NOT_ALLOWED`) and not priced yet (`422 UNPROCESSABLE`, `raw_offers_not_supported`), and re-pricing
//      with `additionalServices` is the checkout's (`422 UNPROCESSABLE`, `additional_services_not_supported`;
//      checkout.setAncillaries, OBE-037);
//   2. Amadeus Flight Offers Price is called outside any transaction (AmadeusClient: rate limits, timeout, one retry of
//      this read, error mapping: error 34651 is `409 SOLD_OUT`); its `supplier_requests` row links to the search;
//   3. one transaction prices the confirmed offers with the engine (each offer's markup at step `search`, in the
//      search's channel, as the results priced it, so with the same rules an unchanged net keeps its markup; the
//      booking's `booking_service` and `ticketing` fees once, at step `pricing`, for the offers together) and inserts the
//      `priced_offers` row: the redacted request, the verbatim answer with the pricing snapshot, the booking
//      requirements, `price_changed`, the amounts (`selling = net + markup + fees`) and `expires_at = min(now +
//      offer_ttl_minutes, end of the earliest lastTicketingDate)`. The answer is read back from the stored row, as
//      flights.getPricedOffer reads it. With `expectedTotal`, a confirmed total that differs answers `409
//      PRICE_CHANGED` (`details.oldPrice`, `newPrice`, `pricedOfferId`) after the priced offer is stored.
//
// Reads (getPricedOffer, getAncillaries, getFareRules): a priced offer is readable in its own environment; one with an
// owner (priced by a signed-in customer, or of a customer's search) only by that customer and in console scope;
// anything else, another tenant's id included, is `404`. After `expires_at` it is `410 OFFER_EXPIRED`. PostgreSQL
// only: the document's "Redis (`prc:{id}`)" predates OADR-0002 point 1, which keeps no offer data in Redis.
//
// getAncillaries (customer scope needs the storefront feature `ancillaries`, `403 FEATURE_DISABLED`) and getFareRules
// answer from the pricing answer when it included what they need (`bags` and `other-services`; `detailed-fare-rules`
// with `fareRules`), else from what an earlier call loaded, else they call Flight Offers Price once more for the
// same Amadeus offers with that `include` and store the result in the snapshot (the first load wins, so `anc_` ids
// never change once answered). A fare that is gone by then (`SOLD_OUT`) answers `410 OFFER_EXPIRED`: price again.
import { Injectable } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { PinoLogger } from "nestjs-pino";
import { AmadeusClient, type AmadeusResponse } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { priceOffer } from "../pricing/pricing-engine";
import {
  Money,
  PricingInputError,
  type PricingChannel,
  type PricingInput,
  type PricingResult,
} from "../pricing/pricing.types";
import { RulesRepository } from "../pricing/rules.repository";
import { displayLanguage, ReferenceNames } from "../reference/reference.mapper";
import { DEFAULT_FEATURES } from "../storefront/storefront.mapper";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  netTotalOf,
  offerColumns,
  parseOffer,
  pricingInputOf,
  tripTypeOf,
  type FlightOffer,
  type OfferScope,
} from "./offers.mapper";
import { OffersRepository, type OfferRow } from "./offers.repository";
import { OffersService, offerDictionaries, parsedOfferOf, toOfferResponse } from "./offers.service";
import {
  ancillaryCatalogueOf,
  ancillaryOptionKeys,
  buildPricingRequest,
  confirmedOffersOf,
  earliestTicketingDate,
  fareRuleSetOf,
  keptOptionIds,
  pricedOfferExpiry,
  pricingIncludeOf,
  pricingQuery,
  readPricingReply,
  snapshotOf,
  SNAPSHOT_KEY,
  toPricedOffer,
  type AmadeusPricingRequest,
  type AncillaryCatalogue,
  type AncillaryLoad,
  type CatalogueSource,
  type ConfirmedOffer,
  type FareRuleSet,
  type FareRulesLoad,
  type FareRulesSource,
  type OfferPricingSnapshot,
  type PricedOffer,
  type PricedOfferPart,
  type PricingInclude,
  type PricingRequest,
  type PricingSnapshot,
  type StoredPricedOffer,
} from "./priced-offers.mapper";
import { PricedOffersRepository, type PricedOfferRow } from "./priced-offers.repository";
import {
  addOfferCodes,
  amadeusDictionaries,
  emptyCodes,
  SearchesService,
  type AmadeusDictionaries,
} from "./searches.service";

/** The input of flights.price. */
export interface PriceInput {
  readonly body: PricingRequest;
  /** `Accept-Language`: the language of the dictionaries' country and currency names. */
  readonly acceptLanguage?: string | undefined;
}

/** The created priced offer and its `Location`. */
export interface CreatedPricedOffer {
  readonly pricedOffer: PricedOffer;
  readonly location: string;
}

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `include` of the later ancillary and fare-rule loads. */
const ANCILLARY_INCLUDE: readonly PricingInclude[] = Object.freeze(["bags", "other-services"]);
const FARE_RULES_INCLUDE: readonly PricingInclude[] = Object.freeze(["detailed-fare-rules"]);

/** True when the storefront's `features` jsonb leaves ancillaries on (the default). */
function ancillariesEnabled(features: unknown): boolean {
  const value = isRecord(features) ? features["ancillaries"] : undefined;
  return typeof value === "boolean" ? value : DEFAULT_FEATURES.ancillaries;
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

const distinct = <T>(values: Iterable<T>): T[] => [...new Set(values)];

/** The checked input of a pricing. */
interface PreparedPricing {
  /** The offers in the order of `offerIds`. */
  readonly offers: readonly OfferRow[];
  readonly request: AmadeusPricingRequest;
  readonly include: readonly PricingInclude[];
  readonly forceClass: boolean;
  readonly fareRules: boolean;
  readonly currency: string;
  readonly minorUnits: number;
  readonly offerTtlMinutes: number;
  readonly channel: PricingChannel;
  readonly customerId: string | null;
}

/** The engine's view of the confirmed offers: per offer its markup, and the fees of the offers together. */
interface PricingOutcome {
  readonly offers: readonly OfferPricingSnapshot[];
  readonly fees: PricingResult;
  readonly taxes: string;
  readonly net: string;
  readonly markup: string;
  readonly selling: string;
}

@Injectable()
export class PricedOffersService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly offers: OffersService,
    private readonly offerRows: OffersRepository,
    private readonly repository: PricedOffersRepository,
    private readonly searches: SearchesService,
    private readonly rules: RulesRepository,
    private readonly amadeus: AmadeusClient,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(PricedOffersService.name);
  }

  // ---- flights.price -----------------------------------------------------------------------------------------------

  /** Prices the offers with Amadeus and stores the priced offer; `409 PRICE_CHANGED` after storing it, see above. */
  async price(input: PriceInput): Promise<CreatedPricedOffer> {
    const tenant = this.tenants.require();
    const scope = this.offers.scope();
    const body = input.body;
    const offerIds = this.checkBody(body, scope);
    const language = new ReferenceNames(displayLanguage(input.acceptLanguage));
    const prepared = await this.tx.run((trx) => this.prepare(trx, tenant, offerIds, body, scope));
    const first = prepared.offers[0] as OfferRow;
    const context: AmadeusCallContext = {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation: "flights.price",
      requestId: this.tenants.requestId() ?? tenant.requestId,
      searchId: first.searchId,
    };
    const reply = await this.amadeus.quoteAirOffers(context, {
      // The stored Amadeus offers verbatim, the card hints and travellers, as the specification defines them.
      body: prepared.request as unknown as Parameters<AmadeusClient["quoteAirOffers"]>[1]["body"],
      query: pricingQuery(prepared.include, prepared.forceClass),
    });
    const pricedOffer = await this.tx.run((trx) => this.store(trx, tenant, prepared, reply, scope, language));
    this.logger.info(
      {
        pricedOfferId: pricedOffer.id,
        offerCount: pricedOffer.offerIds.length,
        priceChanged: pricedOffer.priceChange.changed,
        durationMs: reply.call.durationMs,
      },
      "pricing.completed",
    );
    const expected = body.expectedTotal;
    if (
      expected !== undefined &&
      (expected.currency !== pricedOffer.price.total.currency ||
        !new Money(expected.amount).equals(pricedOffer.price.total.amount))
    ) {
      throw new AppError("PRICE_CHANGED", {
        message: "The confirmed total differs from the expected total; the priced offer was stored.",
        details: {
          oldPrice: { amount: expected.amount, currency: expected.currency },
          newPrice: pricedOffer.price.total,
          pricedOfferId: pricedOffer.id,
        },
      });
    }
    return { pricedOffer, location: `/v1/priced-offers/${pricedOffer.id}` };
  }

  /** The offer ids to price, after the checks of the body that need no data. */
  private checkBody(body: PricingRequest, scope: OfferScope): readonly string[] {
    if (body.amadeusFlightOffers !== undefined) {
      if (scope !== "console") {
        throw new AppError("SCOPE_NOT_ALLOWED", {
          message: "Raw Amadeus offers can only be priced in console scope.",
          details: { reason: "console_only" },
        });
      }
      if (body.offerIds !== undefined) {
        throw new AppError("VALIDATION_FAILED", {
          fieldErrors: [
            {
              path: "/amadeusFlightOffers",
              code: "oneOf",
              message: "Give either offerIds or amadeusFlightOffers, not both.",
            },
          ],
        });
      }
      throw new AppError("UNPROCESSABLE", {
        message: "Raw Amadeus offers cannot be priced yet: search and price their off_ ids.",
        details: { reason: "raw_offers_not_supported" },
      });
    }
    if (body.offerIds === undefined) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [{ path: "/offerIds", code: "required", message: "The offers to price are required." }],
      });
    }
    if ((body.additionalServices?.length ?? 0) > 0) {
      throw new AppError("UNPROCESSABLE", {
        message: "Extras are priced by the checkout (checkout.setAncillaries), not by flights.price.",
        details: { reason: "additional_services_not_supported" },
      });
    }
    return body.offerIds;
  }

  /** Step 1: the checks and the Amadeus request. */
  private async prepare(
    trx: TenantTransaction,
    tenant: RequestTenant,
    offerIds: readonly string[],
    body: PricingRequest,
    scope: OfferScope,
  ): Promise<PreparedPricing> {
    const settings = await this.repository.settings(trx);
    if (settings === undefined) {
      this.logger.warn({ tenantId: tenant.tenantId }, "pricing.settings_missing");
      throw new AppError("TENANT_SUSPENDED", { message: "The storefront of this OTA is not ready yet." });
    }
    const offers = await this.offers.readable(trx, offerIds, scope);
    if (offers.length !== offerIds.length) {
      throw new AppError("NOT_FOUND", { message: "No flight offer with this id." });
    }
    const now = this.clock.now();
    if (offers.some((row) => row.expiresAt.getTime() <= now.getTime())) {
      throw new AppError("OFFER_EXPIRED");
    }
    const first = offers[0] as OfferRow;
    if (offers.some((row) => row.searchId !== first.searchId || row.currency !== first.currency)) {
      throw new AppError("OFFER_COMBINATION_INVALID", {
        message: "Only offers of the same search can be priced together.",
        details: { offerIds: [...offerIds], reason: "different_search" },
      });
    }
    const request = buildPricingRequest(
      offers.map((row) => ({
        id: row.id,
        amadeusOfferId: row.amadeusOfferId,
        payload: row.payload,
        travelerIds: parsedOfferOf(row).travelerPricings.map((pricing) => pricing.travelerId),
      })),
      body,
    );
    if ("kind" in request) {
      if (request.kind === "combination") {
        throw new AppError("OFFER_COMBINATION_INVALID", {
          message: request.message,
          details: { offerIds: [...offerIds], reason: request.reason },
        });
      }
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [{ path: request.path, code: request.code, message: request.message }],
      });
    }
    return {
      offers,
      request,
      include: pricingIncludeOf(body, scope === "console" || ancillariesEnabled(settings.features)),
      forceClass: body.forceClass ?? false,
      fareRules: request.data.additionalInformation.fareRules,
      currency: first.currency,
      minorUnits: await this.offers.minorUnits(trx, first.currency),
      offerTtlMinutes: settings.offerTtlMinutes,
      channel: first.searchChannel === "console" ? "console" : "storefront",
      customerId: tenant.actor.type === "customer" ? tenant.actor.id : first.searchCustomerId,
    };
  }

  /** Step 3: prices the confirmed offers, stores the priced offer, and answers it as stored. */
  private async store(
    trx: TenantTransaction,
    tenant: RequestTenant,
    prepared: PreparedPricing,
    reply: AmadeusResponse<unknown>,
    scope: OfferScope,
    language: ReferenceNames,
  ): Promise<PricedOffer> {
    const answer = readPricingReply(reply.body);
    const confirmed = confirmedOffersOf(
      prepared.offers.map((row) => ({
        id: row.id,
        amadeusOfferId: row.amadeusOfferId,
        currency: row.currency,
      })),
      answer.flightOffers,
      parseOffer,
    );
    if (confirmed === undefined) {
      throw new AppError("SUPPLIER_ERROR", { message: "The supplier's pricing answer could not be read." });
    }
    const now = this.clock.now();
    const dictionaries = mergeDictionaries(
      offerDictionaries(prepared.offers),
      amadeusDictionaries(answer.dictionaries),
    );
    const outcome = await this.priceConfirmed(trx, prepared, confirmed, dictionaries, now);
    const id = this.ids.newId("prc");
    const lastTicketingDate = earliestTicketingDate(confirmed);
    const bagsOrServices = prepared.include.includes("bags") || prepared.include.includes("other-services");
    const resultsTotal = prepared.offers
      .reduce((total, row) => total.plus(row.sellingTotal), new Money(0))
      .toFixed(prepared.minorUnits);
    const snapshot: PricingSnapshot = {
      version: 1,
      searchId: (prepared.offers[0] as OfferRow).searchId,
      customerId: prepared.customerId,
      channel: prepared.channel,
      include: [...prepared.include],
      fareRules: prepared.fareRules,
      forceClass: prepared.forceClass,
      minorUnits: prepared.minorUnits,
      resultsTotal,
      offers: outcome.offers,
      feeLines: outcome.fees.feeLines,
      optionIds: bagsOrServices
        ? this.optionIds(answer.included, confirmed, prepared.currency, prepared.minorUnits)
        : {},
      loads: {},
    };
    const oldPrice = new Money(resultsTotal).plus(outcome.fees.feeTotal);
    await this.repository.insert(trx, {
      id,
      environment: tenant.environment,
      offer_id: (prepared.offers[0] as OfferRow).id,
      parent_priced_offer_id: null,
      offer_ids: prepared.offers.map((row) => row.id),
      include_credit_card_fees: prepared.include.includes("credit-card-fees"),
      include_bags: prepared.include.includes("bags"),
      include_other_services: prepared.include.includes("other-services"),
      include_detailed_fare_rules: prepared.include.includes("detailed-fare-rules"),
      force_class: prepared.forceClass,
      // db README §8: travellers' documents and loyalty or discount numbers masked, the card hints are brand and BIN.
      amadeus_request: JSON.stringify(redactPayload(prepared.request)),
      // The answer as received; the redactor changes nothing in offers and only guards against an answer that would
      // echo a traveller's document or a card, which no column outside a `*_ciphertext` one may hold in clear.
      response: JSON.stringify({
        ...redactPayload(isRecord(reply.body) ? reply.body : {}),
        [SNAPSHOT_KEY]: snapshot,
      }),
      booking_requirements:
        answer.bookingRequirements === undefined ? null : JSON.stringify(answer.bookingRequirements),
      price_changed: !oldPrice.equals(outcome.selling),
      currency: prepared.currency,
      net_total: outcome.net,
      taxes_total: outcome.taxes,
      markup_amount: outcome.markup,
      fee_amount: outcome.fees.feeTotal,
      selling_total: outcome.selling,
      markup_rule_id: outcome.offers[0]?.markupRuleId ?? null,
      last_ticketing_date: lastTicketingDate,
      expires_at: pricedOfferExpiry(now, prepared.offerTtlMinutes, lastTicketingDate),
      created_at: now,
      updated_at: now,
    });
    const row = await this.repository.byId(trx, id);
    if (row === undefined) {
      throw new Error("a stored priced offer is not readable in its own tenant");
    }
    return await this.answer(trx, row, scope, language, now);
  }

  /**
   * The engine on the confirmed offers (OADR-0005 point 7): each offer's markup at step `search`, as its results price
   * was computed; the fees at step `pricing` once, for the offers together (net totals summed, the carriers, cabins and
   * segments of all of them), so per-booking fees count once. One offer gives exactly the engine's `pricing` step.
   */
  private async priceConfirmed(
    trx: TenantTransaction,
    prepared: PreparedPricing,
    confirmed: readonly ConfirmedOffer[],
    dictionaries: AmadeusDictionaries,
    now: Date,
  ): Promise<PricingOutcome> {
    const rules = await this.rules.loadActiveRules(trx);
    if (rules.invalidRules.length > 0) {
      this.logger.warn(
        { invalidRules: rules.invalidRules.map(({ table, id, reason }) => ({ table, id, reason })) },
        "pricing.pricing_rules_skipped",
      );
    }
    const codes = emptyCodes();
    confirmed.forEach((offer) => addOfferCodes(codes, offer.parsed));
    const countries = await this.searches.names(trx, codes, dictionaries, new ReferenceNames(undefined));
    const countryOf = (code: string): string | null => countries.names.location(code)?.countryCode ?? null;
    const cityOf = (code: string): string | null => dictionaries.locations[code]?.cityCode ?? null;
    const unreadable = (cause?: unknown): AppError =>
      new AppError("SUPPLIER_ERROR", {
        message: "The supplier's pricing answer could not be priced.",
        cause,
      });
    try {
      const inputs: PricingInput[] = confirmed.map((offer) => {
        const netTotal = netTotalOf(offer.parsed, prepared.minorUnits);
        if (netTotal === undefined) {
          throw unreadable();
        }
        return pricingInputOf(offer.parsed, offerColumns(offer.parsed, cityOf), {
          at: now,
          minorUnits: prepared.minorUnits,
          netTotal,
          channel: prepared.channel,
          countryOf,
        });
      });
      const ruleNames = new Map(rules.markupRules.map((rule) => [rule.id, rule.name]));
      const offers = confirmed.map((offer, index): OfferPricingSnapshot => {
        const result = priceOffer(inputs[index] as PricingInput, rules.markupRules, rules.feeRules, {
          kind: "search",
        });
        return {
          offerId: offer.offerId,
          amadeusOfferId: offer.amadeusOfferId,
          net: result.net,
          markup: result.markupTotal,
          selling: result.selling,
          markupRuleId: result.markupRuleId,
          markupRuleName: result.markupRuleId === null ? null : (ruleNames.get(result.markupRuleId) ?? null),
          markupLines: result.markupLines,
        };
      });
      const fees = priceOffer(combinedInput(inputs, confirmed, cityOf), rules.markupRules, rules.feeRules, {
        kind: "pricing",
      });
      const net = offers.reduce((total, offer) => total.plus(offer.net), new Money(0));
      const markup = offers.reduce((total, offer) => total.plus(offer.markup), new Money(0));
      const taxes = confirmed.reduce(
        (total, offer) =>
          total
            .plus(offer.parsed.price.total)
            .minus(offer.parsed.price.base)
            .minus(offer.parsed.price.fees.reduce((sum, fee) => sum.plus(fee.amount), new Money(0))),
        new Money(0),
      );
      const units = prepared.minorUnits;
      return {
        offers,
        fees,
        taxes: taxes.toFixed(units),
        net: net.toFixed(units),
        markup: markup.toFixed(units),
        selling: net.plus(markup).plus(fees.feeTotal).toFixed(units),
      };
    } catch (error) {
      if (error instanceof PricingInputError) {
        throw unreadable(error);
      }
      throw error;
    }
  }

  /**
   * An `anc_` id for every option of the catalogue built from `included` and the confirmed offers: the id the
   * catalogue embedded at pricing gave the same option (`earlier`, `keptOptionIds`), else a new one.
   */
  private optionIds(
    included: JsonObject,
    confirmed: readonly ConfirmedOffer[],
    currency: string,
    minorUnits: number,
    earlier?: { readonly included: JsonObject; readonly optionIds: Readonly<Record<string, string>> },
  ): Record<string, string> {
    const keys = ancillaryOptionKeys(included, confirmed, currency, minorUnits);
    const kept = earlier === undefined ? {} : keptOptionIds(earlier, included, keys);
    return Object.fromEntries(keys.map((key) => [key, kept[key] ?? this.ids.newId("anc")]));
  }

  // ---- flights.getPricedOffer ----------------------------------------------------------------------------------------

  /** The stored priced offer, as flights.price answered it. */
  async get(pricedOfferId: string, acceptLanguage?: string): Promise<PricedOffer> {
    const scope = this.offers.scope();
    const language = new ReferenceNames(displayLanguage(acceptLanguage));
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const row = await this.readable(trx, pricedOfferId, scope, now);
      return await this.answer(trx, row, scope, language, now);
    });
  }

  // ---- flights.getAncillaries ----------------------------------------------------------------------------------------

  /** The ancillary catalogue: from the pricing answer, an earlier load, or one more Flight Offers Price call. */
  async ancillaries(pricedOfferId: string): Promise<AncillaryCatalogue> {
    const scope = this.offers.scope();
    const first = await this.tx.run(async (trx) => {
      if (scope === "customer") {
        const settings = await this.repository.settings(trx);
        if (!ancillariesEnabled(settings?.features)) {
          throw new AppError("FEATURE_DISABLED", {
            message: "Ancillaries are not enabled for this storefront.",
            details: { feature: "ancillaries" },
          });
        }
      }
      const row = await this.readable(trx, pricedOfferId, scope, this.clock.now());
      const priced = await this.pricedParts(trx, row);
      const source = catalogueSourceOf(row, priced.snapshot, priced.reply.included);
      return source === undefined
        ? { kind: "load" as const, row, priced }
        : { kind: "ready" as const, catalogue: catalogueOf(row, priced, source, scope) };
    });
    if (first.kind === "ready") {
      return first.catalogue;
    }
    const reply = await this.reload(first.row, first.priced.offerRows, "flights.getAncillaries", {
      include: ANCILLARY_INCLUDE,
      fareRules: false,
    });
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const answer = readPricingReply(reply.body);
      const included: JsonObject = {};
      for (const name of ANCILLARY_INCLUDE) {
        if (answer.included[name] !== undefined) {
          included[name] = answer.included[name];
        }
      }
      const { snapshot, reply: pricing } = first.priced;
      const load: AncillaryLoad = {
        loadedAt: now.toISOString(),
        included,
        warnings: answer.warnings ?? [],
        // An option the pricing answer embedded already (only bags or only other services were included) keeps its id.
        optionIds: this.optionIds(included, first.priced.confirmed, first.row.currency, snapshot.minorUnits, {
          included: pricing.included,
          optionIds: snapshot.optionIds,
        }),
      };
      const stored = await this.storedLoad(trx, first.row, "ancillaries", load, now);
      const source: CatalogueSource = {
        included: stored.included,
        optionIds: stored.optionIds,
        loadedAt: new Date(stored.loadedAt),
        warnings: stored.warnings,
      };
      return catalogueOf(first.row, first.priced, source, scope);
    });
  }

  // ---- flights.getFareRules ------------------------------------------------------------------------------------------

  /** The fare rules: from the pricing answer, an earlier load, or one more Flight Offers Price call. */
  async fareRules(pricedOfferId: string): Promise<FareRuleSet> {
    const scope = this.offers.scope();
    const first = await this.tx.run(async (trx) => {
      const row = await this.readable(trx, pricedOfferId, scope, this.clock.now());
      const priced = await this.pricedParts(trx, row);
      const source = fareRulesSourceOf(row, priced);
      return source === undefined
        ? { kind: "load" as const, row, priced }
        : { kind: "ready" as const, rules: fareRuleSetOf(row.id, row.currency, source) };
    });
    if (first.kind === "ready") {
      return first.rules;
    }
    const reply = await this.reload(first.row, first.priced.offerRows, "flights.getFareRules", {
      include: FARE_RULES_INCLUDE,
      fareRules: true,
    });
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const answer = readPricingReply(reply.body);
      const fareRules: Record<string, unknown> = {};
      for (const payload of answer.flightOffers) {
        if (isRecord(payload) && typeof payload["id"] === "string" && payload["fareRules"] !== undefined) {
          fareRules[payload["id"]] = payload["fareRules"];
        }
      }
      const load: FareRulesLoad = {
        loadedAt: now.toISOString(),
        fareRules,
        detailedFareRules: answer.included["detailed-fare-rules"] ?? {},
        warnings: answer.warnings ?? [],
      };
      const stored = await this.storedLoad(trx, first.row, "fareRules", load, now);
      return fareRuleSetOf(first.row.id, first.row.currency, fareRulesFromLoad(first.priced.parts, stored));
    });
  }

  // ---- Shared ------------------------------------------------------------------------------------------------------

  /**
   * The priced offer if the request may read it: its environment, and its owner's customer or console scope (`404`
   * otherwise, another tenant's id included); `410 OFFER_EXPIRED` after `expires_at`.
   */
  private async readable(
    trx: TenantTransaction,
    pricedOfferId: string,
    scope: OfferScope,
    now: Date,
  ): Promise<PricedOfferRow> {
    const tenant = this.tenants.require();
    const row = await this.repository.byId(trx, pricedOfferId);
    const owner = row === undefined ? null : snapshotOf(row.response).customerId;
    if (
      row === undefined ||
      row.environment !== tenant.environment ||
      row.searchEnvironment !== tenant.environment ||
      (owner !== null &&
        scope !== "console" &&
        !(tenant.actor.type === "customer" && tenant.actor.id === owner))
    ) {
      throw new AppError("NOT_FOUND", { message: "No priced offer with this id." });
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new AppError("OFFER_EXPIRED");
    }
    return row;
  }

  /** The stored answer of a priced offer: its offers' rows, the confirmed offers with their markups. */
  private async pricedParts(trx: TenantTransaction, row: PricedOfferRow): Promise<PricedParts> {
    const snapshot = snapshotOf(row.response);
    const reply = readPricingReply(row.response);
    const found = new Map(
      (await this.offerRows.offersByIds(trx, row.offerIds)).map((offer) => [offer.id, offer]),
    );
    const offerRows = row.offerIds.map((id) => {
      const offer = found.get(id);
      if (offer === undefined) {
        throw new Error("an offer of a stored priced offer is missing");
      }
      return offer;
    });
    const confirmed = confirmedOffersOf(
      offerRows.map((offer) => ({
        id: offer.id,
        amadeusOfferId: offer.amadeusOfferId,
        currency: row.currency,
      })),
      reply.flightOffers,
      parseOffer,
    );
    if (confirmed === undefined) {
      throw new Error("a stored priced offer cannot be read");
    }
    const parts = confirmed.map((offer): PricedOfferPart => {
      const pricing = snapshot.offers.find((entry) => entry.offerId === offer.offerId);
      if (pricing === undefined) {
        throw new Error("a stored priced offer has no pricing of one of its offers");
      }
      return { ...offer, markup: pricing.markup };
    });
    return { snapshot, reply, offerRows, confirmed, parts };
  }

  /** The PricedOffer of a stored row. */
  private async answer(
    trx: TenantTransaction,
    row: PricedOfferRow,
    scope: OfferScope,
    language: ReferenceNames,
    now: Date,
  ): Promise<PricedOffer> {
    const priced = await this.pricedParts(trx, row);
    const { snapshot, reply, offerRows, confirmed } = priced;
    const dictionaries = mergeDictionaries(
      offerDictionaries(offerRows),
      amadeusDictionaries(reply.dictionaries),
    );
    const codes = emptyCodes();
    confirmed.forEach((offer) => addOfferCodes(codes, offer.parsed));
    codes.currencies.add(row.currency);
    const nameSet = await this.searches.names(trx, codes, dictionaries, language);
    const upsellIds = confirmed.some((offer) => offer.parsed.upsellFlightOfferIds.length > 0)
      ? await this.offerRows.searchOfferIds(trx, row.searchId)
      : new Map<string, string>();
    const offers: FlightOffer[] = offerRows.map((offerRow, index) => {
      const pricing = snapshot.offers.find((entry) => entry.offerId === offerRow.id) as OfferPricingSnapshot;
      return toOfferResponse(
        {
          ...offerRow,
          payload: (confirmed[index] as ConfirmedOffer).payload,
          netTotal: pricing.net,
          markupAmount: pricing.markup,
          sellingTotal: pricing.selling,
          markupRuleId: pricing.markupRuleId,
          markupRuleName: pricing.markupRuleName,
        },
        {
          scope,
          view: "full",
          now,
          minorUnits: snapshot.minorUnits,
          names: nameSet.names,
          dictionaries,
          offerIds: upsellIds,
        },
      );
    });
    const stored: StoredPricedOffer = {
      id: row.id,
      searchId: row.searchId,
      offerIds: row.offerIds,
      currency: row.currency,
      netTotal: row.netTotal,
      markupAmount: row.markupAmount,
      feeAmount: row.feeAmount,
      sellingTotal: row.sellingTotal,
      markupRuleId: row.markupRuleId,
      lastTicketingDate: row.lastTicketingDate,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      snapshot,
      reply,
    };
    return toPricedOffer(stored, {
      scope,
      now,
      parts: priced.parts,
      offers,
      dictionaries: nameSet.dictionaries,
    });
  }

  /**
   * One more Flight Offers Price call for the priced offer's Amadeus offers (the stored offers, as first sent), outside
   * any transaction. A fare that is gone (`SOLD_OUT`) means the priced offer cannot be used any more: `410
   * OFFER_EXPIRED`, price again.
   */
  private async reload(
    row: PricedOfferRow,
    offerRows: readonly OfferRow[],
    operation: string,
    options: { readonly include: readonly PricingInclude[]; readonly fareRules: boolean },
  ): Promise<AmadeusResponse<unknown>> {
    const tenant = this.tenants.require();
    const request: AmadeusPricingRequest = {
      data: {
        type: "flight-offers-pricing",
        flightOffers: offerRows.map((offer) => offer.payload),
        additionalInformation: { fareRules: options.fareRules },
      },
    };
    try {
      return await this.amadeus.quoteAirOffers(
        {
          tenantId: tenant.tenantId,
          environment: tenant.environment,
          operation,
          requestId: this.tenants.requestId() ?? tenant.requestId,
          searchId: row.searchId,
        },
        {
          body: request as unknown as Parameters<AmadeusClient["quoteAirOffers"]>[1]["body"],
          query: pricingQuery(options.include, row.forceClass),
        },
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "SOLD_OUT") {
        throw new AppError("OFFER_EXPIRED", {
          message: "The priced fare is no longer available: price the offer again.",
          cause: error,
        });
      }
      throw error;
    }
  }

  /** Stores a load, unless one of its kind is stored already; answers the load that is stored. */
  private async storedLoad<K extends "ancillaries" | "fareRules">(
    trx: TenantTransaction,
    row: PricedOfferRow,
    kind: K,
    load: NonNullable<PricingSnapshot["loads"][K]>,
    now: Date,
  ): Promise<NonNullable<PricingSnapshot["loads"][K]>> {
    if (await this.repository.storeLoad(trx, row.id, kind, JSON.stringify(load), now)) {
      return load;
    }
    // Another request stored its load first: answer that one, so the ids stay those already answered.
    const current = await this.repository.byId(trx, row.id);
    if (current === undefined) {
      // The purge removed it meanwhile: it had expired.
      throw new AppError("OFFER_EXPIRED");
    }
    const earlier = snapshotOf(current.response).loads[kind];
    if (earlier === undefined) {
      throw new Error("a priced offer's load was neither stored nor found");
    }
    return earlier as NonNullable<PricingSnapshot["loads"][K]>;
  }
}

/** A stored priced offer read for an answer. */
interface PricedParts {
  readonly snapshot: PricingSnapshot;
  readonly reply: ReturnType<typeof readPricingReply>;
  /** The offers' rows, in the order of `offer_ids`. */
  readonly offerRows: readonly OfferRow[];
  readonly confirmed: readonly ConfirmedOffer[];
  readonly parts: readonly PricedOfferPart[];
}

/**
 * The engine input of the offers together: net totals summed, the first offer's route, travellers and source, the
 * carriers, cabins and segments of all of them, and the trip type of all their itineraries.
 */
function combinedInput(
  inputs: readonly PricingInput[],
  confirmed: readonly ConfirmedOffer[],
  cityOf: (code: string) => string | null,
): PricingInput {
  const first = inputs[0] as PricingInput;
  if (inputs.length === 1) {
    return first;
  }
  const itineraries = confirmed.flatMap((offer) =>
    offer.parsed.itineraries.map((itinerary) => ({
      origin: itinerary.segments[0]?.departure.iataCode ?? "",
      destination: itinerary.segments.at(-1)?.arrival.iataCode ?? "",
    })),
  );
  return {
    ...first,
    netTotal: inputs
      .reduce((total, input) => total.plus(input.netTotal), new Money(0))
      .toFixed(first.minorUnits),
    validatingCarriers: distinct(inputs.flatMap((input) => input.validatingCarriers)),
    marketingCarriers: distinct(inputs.flatMap((input) => input.marketingCarriers)),
    cabins: distinct(inputs.flatMap((input) => input.cabins)),
    segmentCount: inputs.reduce((total, input) => total + input.segmentCount, 0),
    tripType: tripTypeOf(itineraries, cityOf),
  };
}

/**
 * The catalogue source of a priced offer without a call: the pricing answer when it included both `bags` and
 * `other-services`, else what flights.getAncillaries loaded earlier, else `undefined`.
 */
function catalogueSourceOf(
  row: PricedOfferRow,
  snapshot: PricingSnapshot,
  included: JsonObject,
): CatalogueSource | undefined {
  if (snapshot.include.includes("bags") && snapshot.include.includes("other-services")) {
    return {
      included,
      optionIds: snapshot.optionIds,
      loadedAt: row.createdAt,
      warnings: readPricingReply(row.response).warnings,
    };
  }
  const load = snapshot.loads.ancillaries;
  return load === undefined
    ? undefined
    : {
        included: load.included,
        optionIds: load.optionIds,
        loadedAt: new Date(load.loadedAt),
        warnings: load.warnings,
      };
}

function catalogueOf(
  row: PricedOfferRow,
  priced: PricedParts,
  source: CatalogueSource,
  scope: OfferScope,
): AncillaryCatalogue {
  return ancillaryCatalogueOf(source, {
    pricedOfferId: row.id,
    currency: row.currency,
    minorUnits: priced.snapshot.minorUnits,
    scope,
    expiresAt: row.expiresAt,
    offers: priced.confirmed,
  });
}

/**
 * The fare-rule source of a priced offer without a call: the pricing answer when it asked for detailed fare rules and
 * `fareRules`, else what flights.getFareRules loaded earlier, else `undefined`.
 */
function fareRulesSourceOf(row: PricedOfferRow, priced: PricedParts): FareRulesSource | undefined {
  const { snapshot, reply, parts } = priced;
  if (snapshot.include.includes("detailed-fare-rules") && snapshot.fareRules) {
    return {
      offers: parts.map((part) => ({
        offerId: part.offerId,
        fareRules: isRecord(part.payload) ? part.payload["fareRules"] : undefined,
        parsed: part.parsed,
      })),
      detailedFareRules: reply.included["detailed-fare-rules"],
      loadedAt: row.createdAt,
      warnings: reply.warnings,
    };
  }
  const load = snapshot.loads.fareRules;
  return load === undefined ? undefined : fareRulesFromLoad(parts, load);
}

function fareRulesFromLoad(parts: readonly PricedOfferPart[], load: FareRulesLoad): FareRulesSource {
  return {
    offers: parts.map((part) => ({
      offerId: part.offerId,
      fareRules: load.fareRules[part.amadeusOfferId],
      parsed: part.parsed,
    })),
    detailedFareRules: load.detailedFareRules,
    loadedAt: new Date(load.loadedAt),
    warnings: load.warnings,
  };
}
