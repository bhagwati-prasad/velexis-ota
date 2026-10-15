// Flight Offers Price (`quoteAirOffers`, POST /v1/shopping/flight-offers/pricing) of the Amadeus stub (OBE-019).
//
// The stub prices whatever flight offers it is sent. It echoes the posted `data.flightOffers` (Amadeus's flow posts
// the offers that Flight Offers Search or Branded Fares Upsell answered) and adds the `bookingRequirements` of
// fixtures/flight-offers-price/success.json, one traveller requirement per traveller of the posted offers. Each value
// of the `include` query parameter adds one `included` dictionary, built for the posted offers:
//   - `bags`, `other-services`: the fixture's entries, for the posted segments and travellers;
//   - `detailed-fare-rules`: the fixture's fare notes, one entry per fare basis of the posted offers;
//   - `credit-card-fees`: one entry per posted payment (`data.payments`, with a `brand`) and flight offer it pays,
//     with the fee of that brand in fixtures/flight-offers-price/credit-card-fees.json (0.00 for a brand not listed).
// Pricing offer 2 of the Flight Offers Search fixture answers exactly success.json (without `included` when nothing
// is included); with `include=credit-card-fees` and VISA, MASTERCARD and AMERICAN_EXPRESS payments for it, exactly
// credit-card-fees.json.
//
// Scenarios: `price-changed` raises the base and the total of each traveller pricing by PRICE_CHANGE_PER_TRAVELER, the
// offer's base, total and grandTotal by as much per traveller pricing, and adds warning 37200 (PRICE DISCREPANCY);
// `sold-out` answers error 34651 (SEGMENT SELL FAILURE). Money stays a decimal string: amounts are raised on their
// digits with BigInt, never through a JavaScript number.
import type { FixtureLoader, OperationHandler } from "../routes";
import {
  PRICE_CHANGE_PER_TRAVELER,
  PRICE_DISCREPANCY_WARNING,
  soldOutResponse,
  type StubResponse,
} from "../scenarios";

/** The fixture folder of Flight Offers Price. */
export const FLIGHT_OFFERS_PRICE_FIXTURES = "flight-offers-price";
/** The fixture variant that holds the credit-card fee of each brand. */
export const CREDIT_CARD_FEES_FIXTURE = "credit-card-fees";

/** The dictionaries `include` can ask for, in the order of the specification's `included`. */
const PRICING_INCLUDES = ["credit-card-fees", "bags", "other-services", "detailed-fare-rules"] as const;
type PricingInclude = (typeof PRICING_INCLUDES)[number];

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** The `data.flightOffers` of a Flight Offers Price or Branded Fares Upsell request body (objects only). */
export function postedFlightOffers(body: unknown): JsonObject[] {
  return records(isRecord(body) && isRecord(body["data"]) ? body["data"]["flightOffers"] : undefined);
}

function segmentsOf(offer: JsonObject): JsonObject[] {
  return records(offer["itineraries"]).flatMap((itinerary) => records(itinerary["segments"]));
}

/** The id of the first segment of the posted offers (the segment `sold-out` cannot sell). */
export function firstSegmentId(offers: readonly JsonObject[]): string | undefined {
  const id = offers.flatMap(segmentsOf)[0]?.["id"];
  return typeof id === "string" ? id : undefined;
}

function segmentIdsOf(offers: readonly JsonObject[]): string[] {
  return unique(offers.flatMap(segmentsOf).flatMap((segment) => strings([segment["id"]])));
}

function travelerIdsOf(offers: readonly JsonObject[]): string[] {
  return unique(
    offers.flatMap((offer) =>
      records(offer["travelerPricings"]).flatMap((pricing) => strings([pricing["travelerId"]])),
    ),
  );
}

/** Each fare basis of the posted offers once, with the first segment it prices. */
function fareBasesOf(
  offers: readonly JsonObject[],
): { readonly fareBasis: string; readonly segmentId: string }[] {
  const found = new Map<string, string>();
  for (const offer of offers) {
    for (const pricing of records(offer["travelerPricings"])) {
      for (const detail of records(pricing["fareDetailsBySegment"])) {
        const { fareBasis, segmentId } = detail;
        if (typeof fareBasis === "string" && typeof segmentId === "string" && !found.has(fareBasis)) {
          found.set(fareBasis, segmentId);
        }
      }
    }
  }
  return [...found].map(([fareBasis, segmentId]) => ({ fareBasis, segmentId }));
}

/** `{ "1": a, "2": b, … }`, the shape of Amadeus's `included` dictionaries. */
function numbered(entries: readonly unknown[]): JsonObject {
  return Object.fromEntries(entries.map((entry, index) => [String(index + 1), entry]));
}

const AMOUNT = /^(\d+)(\.\d+)?$/;

/** `amount` (a decimal string) raised by `units` major units, keeping its decimals; anything else is left as it is. */
export function raiseAmount(amount: unknown, units: number): unknown {
  const match = typeof amount === "string" ? AMOUNT.exec(amount) : null;
  if (match?.[1] === undefined) {
    return amount;
  }
  return `${(BigInt(match[1]) + BigInt(units)).toString()}${match[2] ?? ""}`;
}

function raisePrice(price: unknown, units: number, fields: readonly string[]): unknown {
  if (!isRecord(price)) {
    return price;
  }
  const raised: JsonObject = { ...price };
  for (const field of fields) {
    if (field in raised) {
      raised[field] = raiseAmount(raised[field], units);
    }
  }
  return raised;
}

/** `price-changed`: the offer with each traveller pricing and the offer's own price raised. */
function raiseOffer(offer: JsonObject): JsonObject {
  const pricings = records(offer["travelerPricings"]);
  const raised: JsonObject = {
    ...offer,
    price: raisePrice(offer["price"], PRICE_CHANGE_PER_TRAVELER * Math.max(pricings.length, 1), [
      "base",
      "total",
      "grandTotal",
    ]),
  };
  if (Array.isArray(offer["travelerPricings"])) {
    raised["travelerPricings"] = offer["travelerPricings"].map((pricing: unknown) =>
      isRecord(pricing)
        ? { ...pricing, price: raisePrice(pricing["price"], PRICE_CHANGE_PER_TRAVELER, ["base", "total"]) }
        : pricing,
    );
  }
  return raised;
}

function includesOf(query: Readonly<Record<string, unknown>>): Set<PricingInclude> {
  const asked = strings(query["include"]);
  return new Set(PRICING_INCLUDES.filter((include) => asked.includes(include)));
}

/** The `included` object of a fixture body (`{}` when it has none). */
function includedOf(fixtureBody: unknown): JsonObject {
  const included = isRecord(fixtureBody) ? fixtureBody["included"] : undefined;
  return isRecord(included) ? included : {};
}

/** The fixture's entries of `dictionary` with the posted segments and travellers (kept when there are none). */
function forPostedOffers(
  dictionary: unknown,
  segmentIds: readonly string[],
  travelerIds: readonly string[],
): JsonObject {
  const entries = isRecord(dictionary) ? Object.values(dictionary) : [];
  return numbered(
    entries.map((entry) =>
      isRecord(entry)
        ? {
            ...entry,
            ...(segmentIds.length > 0 ? { segmentIds: [...segmentIds] } : {}),
            ...(travelerIds.length > 0 ? { travelerIds: [...travelerIds] } : {}),
          }
        : entry,
    ),
  );
}

function fareRulesFor(dictionary: unknown, offers: readonly JsonObject[]): JsonObject {
  const template = isRecord(dictionary) ? Object.values(dictionary).find(isRecord) : undefined;
  const fareBases = fareBasesOf(offers);
  if (template === undefined || fareBases.length === 0) {
    return isRecord(dictionary) ? dictionary : {};
  }
  return numbered(
    fareBases.map(({ fareBasis, segmentId }) => ({
      fareBasis,
      name: template["name"],
      fareNotes: template["fareNotes"],
      segmentId,
    })),
  );
}

/** One credit-card fee per posted payment with a brand and per flight offer it pays (all posted offers by default). */
function creditCardFeesFor(feesFixture: unknown, body: unknown, offers: readonly JsonObject[]): JsonObject {
  const known = new Map<string, { readonly amount: unknown; readonly currency: unknown }>();
  const feeTable = includedOf(feesFixture)["credit-card-fees"];
  for (const fee of isRecord(feeTable) ? Object.values(feeTable) : []) {
    if (isRecord(fee) && typeof fee["brand"] === "string") {
      known.set(fee["brand"], { amount: fee["amount"], currency: fee["currency"] });
    }
  }
  const currency = [...known.values()][0]?.currency ?? "EUR";
  const offerIds = offers.flatMap((offer) => strings([offer["id"]]));
  const payments = records(isRecord(body) && isRecord(body["data"]) ? body["data"]["payments"] : undefined);
  const fees = payments.flatMap((payment) => {
    const brand = payment["brand"];
    if (typeof brand !== "string") {
      return [];
    }
    const paid = strings(payment["flightOfferIds"]);
    const fee = known.get(brand) ?? { amount: "0.00", currency };
    return (paid.length > 0 ? paid : offerIds).map((flightOfferId) => ({
      brand,
      amount: fee.amount,
      currency: fee.currency,
      flightOfferId,
    }));
  });
  return numbered(fees);
}

/** The handler of `quoteAirOffers`, reading its fixtures through `loadFixture`. */
export function quoteAirOffersHandler(loadFixture: FixtureLoader): OperationHandler {
  return (context): StubResponse => {
    const posted = postedFlightOffers(context.body);
    if (context.scenario === "sold-out") {
      return soldOutResponse(firstSegmentId(posted));
    }
    const { status, body: fixture } = loadFixture(FLIGHT_OFFERS_PRICE_FIXTURES, "success");
    const fixtureData = isRecord(fixture) && isRecord(fixture["data"]) ? fixture["data"] : {};
    const requirements = isRecord(fixtureData["bookingRequirements"])
      ? fixtureData["bookingRequirements"]
      : {};
    const travelerTemplate = records(requirements["travelerRequirements"])[0] ?? {};
    const travelerIds = travelerIdsOf(posted);
    const segmentIds = segmentIdsOf(posted);

    const priced = context.scenario === "price-changed" ? posted.map(raiseOffer) : posted;
    const data: JsonObject = {
      ...fixtureData,
      flightOffers: priced,
      bookingRequirements: {
        ...requirements,
        travelerRequirements: travelerIds.map((travelerId) => ({ ...travelerTemplate, travelerId })),
      },
    };

    const includes = includesOf(context.query);
    const fixtureIncluded = includedOf(fixture);
    const included: JsonObject = {};
    for (const include of includes) {
      switch (include) {
        case "credit-card-fees":
          included[include] = creditCardFeesFor(
            loadFixture(FLIGHT_OFFERS_PRICE_FIXTURES, CREDIT_CARD_FEES_FIXTURE).body,
            context.body,
            posted,
          );
          break;
        case "bags":
        case "other-services":
          included[include] = forPostedOffers(fixtureIncluded[include], segmentIds, travelerIds);
          break;
        case "detailed-fare-rules":
          included[include] = fareRulesFor(fixtureIncluded[include], posted);
          break;
      }
    }

    return {
      status,
      body: {
        ...(context.scenario === "price-changed" ? { warnings: [PRICE_DISCREPANCY_WARNING] } : {}),
        data,
        ...(includes.size > 0 ? { included } : {}),
        ...(isRecord(fixture) && fixture["dictionaries"] !== undefined
          ? { dictionaries: fixture["dictionaries"] }
          : {}),
      },
    };
  };
}
