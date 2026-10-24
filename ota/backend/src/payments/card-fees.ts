// The credit-card fee of a checkout payment (ota/docs/flows/checkout-stripe.md §2 step 4, OADR-0005 point 7; OBE-038):
// the Amadeus credit-card fee of the card's brand for the offers being bought, plus the OTA's own `payment_card` fee
// rules on the amount charged before the fee (`offer + ancillaries`). The sum is the checkout's `fees_amount`
// (`totals.cardFee`) and the payment's `card_fee_amount`, both in the checkout currency and its minor units.
//
// The Amadeus fee comes from the priced offer when its pricing answer has a `credit-card-fees` entry of that brand for
// every offer (flights.price with card hints); otherwise Flight Offers Price is called once more with the priced
// offer's confirmed Amadeus offers, `include=credit-card-fees` and `data.payments = [{brand, binNumber,
// flightOfferIds}]` (`quote`, outside any transaction), and the brand's fees of the answer are summed. A brand the
// answer lists no fee for costs nothing. An answer whose offers have another grand total than the priced ones means the
// fare moved: `409 PRICE_CHANGED`, and nothing is changed (checkout.complete re-prices, OBE-042). An answer in another
// currency cannot be used (`502 SUPPLIER_ERROR`).
//
// The `payment_card` rules are matched with the facts of the priced offer's offers together, exactly as the priced
// offer's own `booking_service` fees were (the shopping context's engine input, OADR-0005 point 2), with the card
// brand of the hint. Pure functions apart from `CardFees`, which loads the rules and the airports' countries in the
// caller's transaction and calls Amadeus between transactions; money is decimal.js, never a JavaScript number.
import { Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import { AmadeusClient } from "../amadeus/amadeus.client";
import { priceOffer } from "../pricing/pricing-engine";
import {
  Money,
  PricingInputError,
  type FeeLine,
  type PricingChannel,
  type PricingInput,
} from "../pricing/pricing.types";
import { RulesRepository } from "../pricing/rules.repository";
import {
  netTotalOf,
  offerColumns,
  parseOffer,
  pricingInputOf,
  tripTypeOf,
  type ParsedOffer,
} from "../shopping/offers.mapper";
import { readPricingReply, snapshotOf } from "../shopping/priced-offers.mapper";
import type { CheckoutPricedOffer } from "../shopping/priced-offers.service";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import type { GatewayContext } from "./payment-gateway";
import { PaymentsRepository } from "./payments.repository";

type CreditCardFee = components["schemas"]["CreditCardFee"];
type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const distinct = <T>(values: Iterable<T>): T[] => [...new Set(values)];

/** The card hint a fee is quoted for (PaymentCardHint). */
export interface CardHint {
  /** Amadeus PaymentBrand (`VISA`). */
  readonly brand: string;
  /** The first six digits, or `undefined`. */
  readonly bin?: string | undefined;
}

/** A quoted card fee. */
export interface CardFeeQuote {
  readonly brand: string;
  readonly bin: string | null;
  /** The Amadeus credit-card fee of the brand for the offers, in the checkout currency. */
  readonly amadeusFee: string;
  /** The OTA's `payment_card` fee lines. */
  readonly feeLines: readonly FeeLine[];
  /** `amadeusFee + Σ feeLines`: `totals.cardFee`. */
  readonly total: string;
  /** Where the Amadeus fee came from. */
  readonly source: "priced_offer" | "amadeus";
}

/** The Amadeus pricing request of a quote: the priced offer's confirmed offers, as Amadeus answered them. */
export interface CardFeeRequest {
  readonly body: {
    readonly data: {
      readonly type: "flight-offers-pricing";
      readonly flightOffers: readonly unknown[];
      readonly payments: ReadonlyArray<{
        readonly brand: string;
        readonly binNumber?: number;
        readonly flightOfferIds: readonly string[];
      }>;
    };
  };
  readonly query: { readonly include: ["credit-card-fees"]; readonly forceClass: boolean };
}

/** Everything a quote needs, prepared in a transaction (`CardFees.prepare`). */
export interface CardFeePlan {
  readonly hint: CardHint;
  readonly currency: string;
  readonly minorUnits: number;
  /** The `payment_card` fees of the rules on `baseAmount`. */
  readonly feeLines: readonly FeeLine[];
  /** The Amadeus fee from the priced offer, when it has one for every offer. */
  readonly pricedOfferFee: string | undefined;
  /** The Amadeus offer ids of the priced offer, in its order. */
  readonly amadeusOfferIds: readonly string[];
  /** Amadeus offer id → its priced `price.grandTotal`. */
  readonly grandTotals: ReadonlyMap<string, string>;
  readonly request: CardFeeRequest;
  /** The search the priced offer belongs to (the `supplier_requests` link). */
  readonly searchId: string;
}

// ---- The Amadeus fee ---------------------------------------------------------------------------------------------

/**
 * The Amadeus fee of `brand` from a priced offer's `creditCardFees`: the sum over `offerIds` when every one of them
 * has an entry of the brand in `currency`, else `undefined` (the fee has to be quoted).
 */
export function pricedOfferCardFee(
  fees: readonly CreditCardFee[],
  brand: string,
  offerIds: readonly string[],
  currency: string,
  minorUnits: number,
): string | undefined {
  let total = new Money(0);
  for (const offerId of offerIds) {
    const fee = fees.find((entry) => entry.offerId === offerId && entry.brand === brand);
    if (fee === undefined || fee.amount.currency !== currency) {
      return undefined;
    }
    total = total.plus(fee.amount.amount);
  }
  return offerIds.length === 0 ? undefined : total.toFixed(minorUnits);
}

/**
 * The Amadeus fee of `brand` in a Flight Offers Price answer (`included["credit-card-fees"]`), summed over the entries
 * of `amadeusOfferIds`; `0` when the answer lists none for the brand. An entry in another currency, or with an amount
 * that is not a decimal, cannot be used: `undefined`.
 */
export function quotedCardFee(
  included: JsonObject,
  brand: string,
  amadeusOfferIds: readonly string[],
  currency: string,
  minorUnits: number,
): string | undefined {
  const fees = isRecord(included["credit-card-fees"]) ? included["credit-card-fees"] : {};
  let total = new Money(0);
  for (const fee of Object.values(fees)) {
    if (
      !isRecord(fee) ||
      fee["brand"] !== brand ||
      !amadeusOfferIds.includes(text(fee["flightOfferId"]) ?? "")
    ) {
      continue;
    }
    const amount = text(fee["amount"]);
    if (amount === undefined || !/^\d+(?:\.\d+)?$/.test(amount) || text(fee["currency"]) !== currency) {
      return undefined;
    }
    total = total.plus(amount);
  }
  return total.toFixed(minorUnits);
}

/** The Amadeus offer ids of `answered` offers whose `price.grandTotal` differs from the priced one, or is missing. */
export function changedFares(
  grandTotals: ReadonlyMap<string, string>,
  answered: readonly unknown[],
): string[] {
  const answeredTotals = new Map<string, string | undefined>();
  for (const offer of answered) {
    if (isRecord(offer) && typeof offer["id"] === "string") {
      const price = isRecord(offer["price"]) ? offer["price"] : {};
      answeredTotals.set(offer["id"], text(price["grandTotal"]));
    }
  }
  return [...grandTotals].flatMap(([id, priced]) => {
    const now = answeredTotals.get(id);
    return now !== undefined && /^\d+(?:\.\d+)?$/.test(now) && new Money(now).equals(priced) ? [] : [id];
  });
}

// ---- The OTA's payment_card fees ---------------------------------------------------------------------------------

/**
 * The engine input of the priced offer's offers together, as the shopping context prices a priced offer's fees: one
 * offer's own facts, or for several the net totals summed, the first offer's route, travellers and source, the
 * carriers, cabins and segments of all of them and the trip type of all their itineraries. `undefined` for an offer
 * the engine cannot price.
 */
export function pricingInputOfOffers(
  offers: readonly ParsedOffer[],
  context: {
    readonly at: Date;
    readonly minorUnits: number;
    readonly channel: PricingChannel;
    readonly countryOf: (code: string) => string | null;
    readonly cityOf: (code: string) => string | null;
  },
): PricingInput | undefined {
  const inputs: PricingInput[] = [];
  for (const offer of offers) {
    const netTotal = netTotalOf(offer, context.minorUnits);
    if (netTotal === undefined) {
      return undefined;
    }
    inputs.push(
      pricingInputOf(offer, offerColumns(offer, context.cityOf), {
        at: context.at,
        minorUnits: context.minorUnits,
        netTotal,
        channel: context.channel,
        countryOf: context.countryOf,
      }),
    );
  }
  const first = inputs[0];
  if (first === undefined || inputs.length === 1) {
    return first;
  }
  const itineraries = offers.flatMap((offer) =>
    offer.itineraries.map((itinerary) => ({
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
    tripType: tripTypeOf(itineraries, context.cityOf),
  };
}

/** `amadeusFee + Σ lines`, with the currency's minor units. */
export function cardFeeTotal(amadeusFee: string, lines: readonly FeeLine[], minorUnits: number): string {
  return lines.reduce((total, line) => total.plus(line.amount), new Money(amadeusFee)).toFixed(minorUnits);
}

/** The Amadeus pricing request of a card-fee quote. */
export function cardFeeRequest(
  flightOffers: readonly unknown[],
  amadeusOfferIds: readonly string[],
  hint: CardHint,
  forceClass: boolean,
): CardFeeRequest {
  return {
    body: {
      data: {
        type: "flight-offers-pricing",
        flightOffers,
        payments: [
          {
            brand: hint.brand,
            ...(hint.bin === undefined ? {} : { binNumber: Number(hint.bin) }),
            flightOfferIds: [...amadeusOfferIds],
          },
        ],
      },
    },
    query: { include: ["credit-card-fees"], forceClass },
  };
}

@Injectable()
export class CardFees {
  constructor(
    private readonly amadeus: AmadeusClient,
    private readonly rules: RulesRepository,
    private readonly repository: PaymentsRepository,
  ) {}

  /**
   * Step 1, in the caller's transaction: the `payment_card` fee lines of the rules for the hint's brand on
   * `baseAmount`, the Amadeus fee when the priced offer has it, and the request that quotes it otherwise.
   */
  async prepare(
    trx: TenantTransaction,
    priced: CheckoutPricedOffer,
    hint: CardHint,
    baseAmount: string,
    now: Date,
  ): Promise<CardFeePlan> {
    const { row, pricedOffer, minorUnits } = priced;
    const snapshot = snapshotOf(row.response);
    const reply = readPricingReply(row.response);
    const parsed: ParsedOffer[] = [];
    for (const payload of reply.flightOffers) {
      const offer = parseOffer(payload);
      if (offer === undefined) {
        throw new Error("a stored priced offer has an offer that cannot be read");
      }
      parsed.push(offer);
    }
    const dictionaries = isRecord(reply.dictionaries) ? reply.dictionaries : {};
    const locations = isRecord(dictionaries["locations"]) ? dictionaries["locations"] : {};
    const cityOf = (code: string): string | null => {
      const location = locations[code];
      return isRecord(location) ? (text(location["cityCode"]) ?? null) : null;
    };
    const codes = distinct(
      parsed.flatMap((offer) =>
        offer.itineraries.flatMap((itinerary) =>
          itinerary.segments.flatMap((segment) => [segment.departure.iataCode, segment.arrival.iataCode]),
        ),
      ),
    );
    const countries = await this.repository.airportCountries(trx, codes);
    const input = pricingInputOfOffers(parsed, {
      at: now,
      minorUnits,
      channel: snapshot.channel,
      countryOf: (code) => countries.get(code) ?? null,
      cityOf,
    });
    if (input === undefined) {
      throw new Error("a stored priced offer cannot be priced again");
    }
    const active = await this.rules.loadActiveRules(trx);
    let feeLines: readonly FeeLine[];
    try {
      feeLines = priceOffer(input, active.markupRules, active.feeRules, {
        kind: "payment_card",
        cardBrand: hint.brand,
        baseAmount,
      }).feeLines;
    } catch (error) {
      if (error instanceof PricingInputError) {
        throw new Error("the card fee of a stored priced offer cannot be priced", { cause: error });
      }
      throw error;
    }
    const amadeusOfferIds = parsed.map((offer) => offer.amadeusId);
    return {
      hint,
      currency: row.currency,
      minorUnits,
      feeLines,
      pricedOfferFee: pricedOfferCardFee(
        pricedOffer.creditCardFees,
        hint.brand,
        pricedOffer.offerIds,
        row.currency,
        minorUnits,
      ),
      amadeusOfferIds,
      grandTotals: new Map(parsed.map((offer) => [offer.amadeusId, offer.price.grandTotal])),
      request: cardFeeRequest(reply.flightOffers, amadeusOfferIds, hint, row.forceClass),
      searchId: row.searchId,
    };
  }

  /**
   * Step 2, outside any transaction: the quote, with one Flight Offers Price call when the priced offer has no fee of
   * the brand (`operation` is the SDK method it belongs to, for `supplier_requests`).
   */
  async quote(ctx: GatewayContext, plan: CardFeePlan, operation: string): Promise<CardFeeQuote> {
    const done = (amadeusFee: string, source: CardFeeQuote["source"]): CardFeeQuote => ({
      brand: plan.hint.brand,
      bin: plan.hint.bin ?? null,
      amadeusFee,
      feeLines: plan.feeLines,
      total: cardFeeTotal(amadeusFee, plan.feeLines, plan.minorUnits),
      source,
    });
    if (plan.pricedOfferFee !== undefined) {
      return done(plan.pricedOfferFee, "priced_offer");
    }
    const reply = await this.amadeus.quoteAirOffers(
      {
        tenantId: ctx.tenantId,
        environment: ctx.environment,
        operation,
        requestId: ctx.requestId,
        searchId: plan.searchId,
      },
      {
        body: plan.request.body as unknown as Parameters<AmadeusClient["quoteAirOffers"]>[1]["body"],
        query: plan.request.query,
      },
    );
    const answer = readPricingReply(reply.body);
    const changed = changedFares(plan.grandTotals, answer.flightOffers);
    if (changed.length > 0) {
      throw new AppError("PRICE_CHANGED", {
        message: "The fare changed while the card fee was quoted: price the offer again.",
        details: { reason: "fare_changed" },
      });
    }
    const fee = quotedCardFee(
      answer.included,
      plan.hint.brand,
      plan.amadeusOfferIds,
      plan.currency,
      plan.minorUnits,
    );
    if (fee === undefined) {
      throw new AppError("SUPPLIER_ERROR", { message: "The supplier's card fee could not be read." });
    }
    return done(fee, "amadeus");
  }
}

// ---- What a cancellation keeps of the card fee ------------------------------------------------------------------

/**
 * The part of a payment's card fee a cancellation keeps (lead decision (2) of 2026-10-23, second batch;
 * FIX-W28-CANCEL): `card_fee_amount` less its refundable lines (`payments.card_fee_lines`, checkout/pricing-mode.ts
 * `CardFeeLine`: an OTA `payment_card` fee whose rule was `refundable` when it was quoted), never below 0. The Amadeus
 * credit-card fee is never refundable, whatever its line says; a line that cannot be read, and a payment without lines
 * (written before tenant migration 0004), count as not refundable: the whole fee is kept.
 */
export function keptCardFeeOf(
  payment: { readonly cardFeeAmount: string; readonly cardFeeLines?: unknown },
  minorUnits: number,
): string {
  const fee = new Money(payment.cardFeeAmount);
  let refundable = new Money(0);
  for (const line of Array.isArray(payment.cardFeeLines) ? (payment.cardFeeLines as unknown[]) : []) {
    const amount = isRecord(line) ? text(line["amount"]) : undefined;
    if (
      isRecord(line) &&
      line["source"] === "fee_rule" &&
      line["refundable"] === true &&
      amount !== undefined &&
      /^\d+(?:\.\d+)?$/.test(amount)
    ) {
      refundable = refundable.plus(amount);
    }
  }
  return Money.max(fee.minus(refundable), 0).toFixed(minorUnits);
}
