// Unit tests of the offer and search mapping (OBE-021; offers.mapper.ts): Amadeus offers read and normalised into the
// summary columns and the engine's input, stored offers as the API's FlightOffer in customer scope (selling amounts
// only) and console scope (net and markup), and flights.search bodies as Amadeus requests.
import { describe, expect, it } from "vitest";
import { Money, type MoneyValue } from "../pricing/pricing.types";
import {
  buildAmadeusSearch,
  codesOf,
  criteriaRequestOf,
  distribute,
  isoDuration,
  localDateTime,
  netTotalOf,
  offerColumns,
  parseIsoDuration,
  parseOffer,
  parseSearchDefaults,
  pricingInputOf,
  searchCriteriaOf,
  searchSummaryOf,
  toFlightOffer,
  type DisplayNames,
  type FlightSearchAdvancedRequest,
  type FlightSearchCreateRequest,
  type FlightSearchSimpleRequest,
  type LocationInfo,
  type OfferMappingContext,
  type ParsedOffer,
  type StoredOffer,
} from "./offers.mapper";

/** A synthetic round trip Paris CDG → New York (via Amsterdam) → Paris Orly, one adult and one child. */
const ROUND_TRIP = Object.freeze({
  type: "flight-offer",
  id: "7",
  source: "GDS",
  instantTicketingRequired: false,
  oneWay: false,
  lastTicketingDate: "2027-01-10",
  numberOfBookableSeats: 4,
  itineraries: [
    {
      duration: "PT16H30M",
      segments: [
        {
          departure: { iataCode: "CDG", terminal: "2F", at: "2027-01-15T22:10:00" },
          arrival: { iataCode: "AMS", at: "2027-01-15T23:40:00" },
          carrierCode: "AF",
          number: "1240",
          aircraft: { code: "320" },
          operating: { carrierCode: "KL" },
          duration: "PT1H30M",
          id: "1",
          numberOfStops: 0,
          co2Emissions: [{ weight: 80, weightUnit: "KG", cabin: "ECONOMY" }],
        },
        {
          departure: { iataCode: "AMS", at: "2027-01-16T06:10:00" },
          arrival: { iataCode: "JFK", terminal: "4", at: "2027-01-16T08:40:00" },
          carrierCode: "KL",
          number: "641",
          aircraft: { code: "333" },
          duration: "PT8H30M",
          id: "2",
          numberOfStops: 0,
          co2Emissions: [{ weight: 420, weightUnit: "KG", cabin: "BUSINESS" }],
        },
      ],
    },
    {
      duration: "PT7H5M",
      segments: [
        {
          departure: { iataCode: "JFK", at: "2027-01-22T18:00:00" },
          arrival: { iataCode: "ORY", at: "2027-01-23T07:05:00" },
          carrierCode: "AF",
          number: "9",
          duration: "PT7H5M",
          id: "3",
          numberOfStops: 0,
        },
      ],
    },
  ],
  price: {
    currency: "EUR",
    total: "900.00",
    base: "600.00",
    fees: [
      { amount: "0.00", type: "SUPPLIER" },
      { amount: "5.00", type: "TICKETING" },
    ],
    grandTotal: "900.00",
    margins: [{ amount: "1.00", type: "AGENT" }],
  },
  validatingAirlineCodes: ["AF"],
  fareRules: { rules: [{ category: "REFUND", notApplicable: true }] },
  travelerPricings: [
    {
      travelerId: "1",
      fareOption: "STANDARD",
      travelerType: "ADULT",
      price: {
        currency: "EUR",
        total: "600.00",
        base: "400.00",
        taxes: [{ amount: "150.00", code: "FR" }],
        margins: [{ amount: "1.00" }],
      },
      fareDetailsBySegment: [
        {
          segmentId: "1",
          cabin: "ECONOMY",
          fareBasis: "YLIGHT",
          brandedFare: "LIGHT",
          brandedFareLabel: "ECONOMY LIGHT",
          class: "Y",
          includedCheckedBags: { weight: 23, weightUnit: "KG" },
          amenities: [
            {
              description: "CHANGEABLE TICKET",
              isChargeable: true,
              amenityType: "BRANDED_FARES",
              amenityProvider: { name: "BrandedFare" },
            },
          ],
        },
        {
          segmentId: "2",
          cabin: "BUSINESS",
          fareBasis: "JLIGHT",
          brandedFare: "LIGHT",
          brandedFareLabel: "ECONOMY LIGHT",
          class: "J",
          includedCheckedBags: { quantity: 2 },
        },
        {
          segmentId: "3",
          cabin: "ECONOMY",
          fareBasis: "YSTD",
          brandedFare: "STANDARD",
          brandedFareLabel: "ECONOMY STANDARD",
          class: "Y",
          includedCheckedBags: { quantity: 1 },
        },
      ],
    },
    {
      travelerId: "2",
      fareOption: "STANDARD",
      travelerType: "CHILD",
      price: { currency: "EUR", total: "300.00", base: "200.00" },
      fareDetailsBySegment: [
        { segmentId: "1", cabin: "ECONOMY", class: "Y", includedCheckedBags: { quantity: 1 } },
        { segmentId: "2", cabin: "BUSINESS", class: "J", includedCheckedBags: { quantity: 1 } },
        { segmentId: "3", cabin: "ECONOMY", class: "Y", includedCheckedBags: { quantity: 1 } },
      ],
    },
  ],
});

const CITIES: Readonly<Record<string, string>> = { CDG: "PAR", ORY: "PAR", AMS: "AMS", JFK: "NYC" };
const cityOf = (code: string): string | null => CITIES[code] ?? null;

const LOCATIONS: Readonly<Record<string, LocationInfo>> = {
  CDG: {
    cityCode: "PAR",
    countryCode: "FR",
    airportName: "Paris Charles de Gaulle",
    cityName: "Paris",
    countryName: "France",
    timeZone: "Europe/Paris",
  },
  JFK: {
    cityCode: "NYC",
    countryCode: "US",
    airportName: "John F. Kennedy International",
    cityName: "New York",
    countryName: "United States",
    timeZone: "America/New_York",
  },
};
const NAMES: DisplayNames = {
  location: (code) => LOCATIONS[code],
  carrierName: (code) => ({ AF: "Air France", KL: "KLM" })[code] ?? null,
  aircraftName: (code) => (code === "320" ? "AIRBUS A320" : null),
};

function parsed(payload: unknown = ROUND_TRIP): ParsedOffer {
  const offer = parseOffer(payload);
  if (offer === undefined) {
    throw new Error("the test offer cannot be read");
  }
  return offer;
}

/** The stored row of the round trip with a 10 % markup. */
const STORED: StoredOffer = Object.freeze({
  id: "off_01JA4C8Q2H6K9M3P5S8U1W4Y7A",
  searchId: "srch_01JA4C8Q0D5N7R2T6V9X3Z1B4F",
  source: "GDS",
  payload: ROUND_TRIP,
  currency: "EUR",
  netTotal: "900.00",
  markupAmount: "90.00",
  sellingTotal: "990.00",
  markupRuleId: "mkr_01JA4C8Q2H6K9M3P5S8U1W4Y7B",
  markupRuleName: "Ten percent",
  expiresAt: new Date("2026-10-18T10:30:00Z"),
  createdAt: new Date("2026-10-18T10:00:00Z"),
});

function context(overrides: Partial<OfferMappingContext> = {}): OfferMappingContext {
  return {
    scope: "customer",
    view: "full",
    now: new Date("2026-10-18T10:05:00Z"),
    minorUnits: 2,
    highlights: {
      cheapest: { offerId: STORED.id, price: { amount: "990.00", currency: "EUR" }, durationMinutes: 1415 },
      fastest: null,
      best: null,
    },
    offerIds: new Map(),
    names: NAMES,
    cityOf,
    ...overrides,
  };
}

/** Every key of a JSON value whose name starts with `net`, as JSON pointers. */
function netKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => netKeys(item, `${path}/${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(/^net/i.test(key) ? [`${path}/${key}`] : []),
      ...netKeys(item, `${path}/${key}`),
    ]);
  }
  return [];
}

describe("times and durations", () => {
  it("reads ISO 8601 durations in minutes and writes them back", () => {
    expect(parseIsoDuration("PT5H45M")).toBe(345);
    expect(parseIsoDuration("PT45M")).toBe(45);
    expect(parseIsoDuration("P1DT2H")).toBe(1560);
    expect(parseIsoDuration("PT2H30M59S")).toBe(150);
    expect(parseIsoDuration("PT")).toBeUndefined();
    expect(parseIsoDuration("5 hours")).toBeUndefined();
    expect(isoDuration(390)).toBe("PT6H30M");
    expect(isoDuration(45)).toBe("PT45M");
    expect(isoDuration(120)).toBe("PT2H");
  });

  it("normalises Amadeus local date-times to seconds without fraction or offset", () => {
    expect(localDateTime("2027-01-15T06:00")).toBe("2027-01-15T06:00:00");
    expect(localDateTime("2027-01-15T06:00:00.000")).toBe("2027-01-15T06:00:00");
    expect(localDateTime("15/01/2027")).toBeUndefined();
  });

  it("refuses local date-times that do not exist (they would break the minutes and timestamp columns)", () => {
    expect(localDateTime("2027-01-15T24:00:00")).toBeUndefined();
    expect(localDateTime("2027-01-15T06:60:00")).toBeUndefined();
    expect(localDateTime("2027-02-30T06:00:00")).toBeUndefined();
    expect(localDateTime("2028-02-29T23:59:59")).toBe("2028-02-29T23:59:59");
  });
});

describe("parseOffer", () => {
  it("refuses an offer it cannot show or price", () => {
    const without = (mutate: (copy: Record<string, unknown>) => void): unknown => {
      const copy = structuredClone(ROUND_TRIP) as unknown as Record<string, unknown>;
      mutate(copy);
      return copy;
    };
    expect(parseOffer(null)).toBeUndefined();
    expect(parseOffer(without((copy) => delete copy["id"]))).toBeUndefined();
    expect(parseOffer(without((copy) => (copy["itineraries"] = [])))).toBeUndefined();
    expect(parseOffer(without((copy) => (copy["itineraries"] = [{ segments: [] }])))).toBeUndefined();
    expect(parseOffer(without((copy) => (copy["price"] = { currency: "EUR", total: "1" })))).toBeUndefined();
    expect(parseOffer(without((copy) => (copy["source"] = "OTHER")))).toBeUndefined();
    expect(
      parseOffer(
        without((copy) => {
          const [first] = copy["itineraries"] as Array<{ segments: Array<Record<string, unknown>> }>;
          delete first?.segments[0]?.["carrierCode"];
        }),
      ),
    ).toBeUndefined();
  });

  it("reads refundability from the fare rules and changeability from a branded-fare amenity", () => {
    const offer = parsed();
    expect(offer.refundable).toBe(false);
    expect(offer.changeable).toBe(true);
    const plain = structuredClone(ROUND_TRIP) as unknown as Record<string, unknown>;
    delete plain["fareRules"];
    expect(parsed(plain).refundable).toBeNull();
  });

  it("reads an amenity that negates a refund or a change as no, never as yes", () => {
    const withAmenities = (descriptions: readonly string[]): ParsedOffer => {
      const copy = structuredClone(ROUND_TRIP) as unknown as {
        fareRules?: unknown;
        travelerPricings: Array<{ fareDetailsBySegment: Array<{ amenities?: unknown }> }>;
      };
      delete copy.fareRules;
      const [first] = copy.travelerPricings[0]?.fareDetailsBySegment ?? [];
      if (first !== undefined) {
        first.amenities = descriptions.map((description) => ({ description, isChargeable: false }));
      }
      return parsed(copy);
    };
    expect(withAmenities(["NON REFUNDABLE TICKET", "NON-CHANGEABLE TICKET"])).toMatchObject({
      refundable: false,
      changeable: false,
    });
    expect(withAmenities(["NO REFUND", "CHANGES NOT PERMITTED"])).toMatchObject({
      refundable: false,
      changeable: false,
    });
    expect(withAmenities(["REFUNDABLE TICKET", "CHANGEABLE TICKET"])).toMatchObject({
      refundable: true,
      changeable: true,
    });
    expect(withAmenities(["PRE RESERVED SEAT ASSIGNMENT"])).toMatchObject({
      refundable: null,
      changeable: null,
    });
  });

  it("refuses an offer with a traveller pricing it cannot read: its net price would stay in `amadeus`", () => {
    const withPricings = (mutate: (pricings: Array<Record<string, unknown>>) => void): unknown => {
      const copy = structuredClone(ROUND_TRIP) as unknown as {
        travelerPricings: Array<Record<string, unknown>>;
      };
      mutate(copy.travelerPricings);
      return copy;
    };
    expect(
      parseOffer(withPricings((pricings) => (pricings[1] = { ...pricings[1], travelerType: "PET" }))),
    ).toBe(undefined);
    expect(parseOffer(withPricings((pricings) => delete pricings[1]?.["travelerId"]))).toBeUndefined();
    expect(parseOffer(withPricings((pricings) => (pricings[1] = { ...pricings[1], travelerId: "1" })))).toBe(
      undefined,
    );
  });

  it("leaves a negative bag allowance unknown", () => {
    const copy = structuredClone(ROUND_TRIP) as unknown as {
      travelerPricings: Array<{ fareDetailsBySegment: Array<{ includedCheckedBags?: unknown }> }>;
    };
    const details = copy.travelerPricings[0]?.fareDetailsBySegment ?? [];
    details.forEach((detail) => (detail.includedCheckedBags = { quantity: -1 }));
    expect(offerColumns(parsed(copy), cityOf).minCheckedBags).toBeNull();
  });
});

describe("offerColumns", () => {
  it("fills the summary columns of a round trip", () => {
    const columns = offerColumns(parsed(), cityOf);

    expect(columns).toMatchObject({
      originIata: "CDG",
      destinationIata: "JFK",
      firstDepartureLocal: "2027-01-15T22:10:00",
      lastArrivalLocal: "2027-01-23T07:05:00",
      maxStops: 1,
      marketingCarriers: ["AF", "KL"],
      operatingCarriers: ["KL"],
      validatingCarrier: "AF",
      departureMinutes: [1330, 1080],
      arrivalMinutes: [520, 425],
      durationMinutes: [990, 425],
      totalDurationMinutes: 1415,
      // The longest segment (AMS–JFK, 8 h 30) is in business for the adult.
      mainCabin: "BUSINESS",
      cabins: ["ECONOMY", "BUSINESS"],
      // A weight-only allowance counts as one bag; the adult's fewest is 1.
      minCheckedBags: 1,
      refundable: false,
      changeable: true,
      brandedFares: ["LIGHT", "STANDARD"],
      tripType: "round_trip",
      segmentCount: 3,
      travelers: { ADULT: 1, CHILD: 1 },
      bookableSeats: 4,
      lastTicketingDate: "2027-01-10",
      instantTicketingRequired: false,
    });
  });

  it("leaves the bags unknown when a segment of the lead traveller has no allowance", () => {
    const copy = structuredClone(ROUND_TRIP) as unknown as {
      travelerPricings: Array<{ fareDetailsBySegment: Array<Record<string, unknown>> }>;
    };
    delete copy.travelerPricings[0]?.fareDetailsBySegment[2]?.["includedCheckedBags"];
    expect(offerColumns(parsed(copy), cityOf).minCheckedBags).toBeNull();
  });

  it("gives the engine the offer's facts", () => {
    const offer = parsed();
    const columns = offerColumns(offer, cityOf);
    const input = pricingInputOf(offer, columns, {
      at: new Date("2026-10-18T10:00:00Z"),
      minorUnits: 2,
      netTotal: "900.00",
      channel: "storefront",
      countryOf: (code) => ({ CDG: "FR", JFK: "US" })[code] ?? null,
    });
    expect(input).toMatchObject({
      currency: "EUR",
      netTotal: "900.00",
      origin: "CDG",
      destination: "JFK",
      originCountry: "FR",
      destinationCountry: "US",
      validatingCarriers: ["AF"],
      marketingCarriers: ["AF", "KL"],
      cabins: ["ECONOMY", "BUSINESS"],
      travelers: { ADULT: 1, CHILD: 1 },
      segmentCount: 3,
      tripType: "round_trip",
      source: "GDS",
      channel: "storefront",
    });
  });

  it("prices the net total only in the currency's minor units", () => {
    expect(netTotalOf(parsed(), 2)).toBe("900.00");
    const yen = structuredClone(ROUND_TRIP) as unknown as { price: Record<string, unknown> };
    yen.price = { currency: "JPY", total: "120000.00", base: "80000", grandTotal: "120000.00" };
    expect(netTotalOf(parsed(yen), 0)).toBe("120000");
    yen.price = { currency: "JPY", total: "120000.50", base: "80000", grandTotal: "120000.50" };
    expect(netTotalOf(parsed(yen), 0)).toBeUndefined();
    // `net_total` is numeric(12,2): an amount it cannot hold is not priced (the offer is left out).
    yen.price = { currency: "JPY", total: "10000000000", base: "1", grandTotal: "10000000000" };
    expect(netTotalOf(parsed(yen), 0)).toBeUndefined();
  });

  it("lists the codes a response needs names for", () => {
    expect(codesOf(parsed())).toEqual({
      locations: ["AMS", "CDG", "JFK", "ORY"],
      carriers: ["AF", "KL"],
      aircraft: ["320", "333"],
    });
  });
});

describe("distribute", () => {
  const amounts = (values: readonly MoneyValue[]): string[] => values.map((value) => value.toFixed(2));

  it("splits in proportion, the shares adding up to the total exactly", () => {
    expect(amounts(distribute(new Money("90.00"), [new Money(600), new Money(300)], 2))).toEqual([
      "60.00",
      "30.00",
    ]);
    const thirds = distribute(new Money("10.00"), [new Money(1), new Money(1), new Money(1)], 2);
    expect(amounts(thirds)).toEqual(["3.34", "3.33", "3.33"]);
    expect(thirds.reduce((sum, value) => sum.plus(value), new Money(0)).toFixed(2)).toBe("10.00");
  });

  it("keeps the sign of a discount and splits equally when every weight is zero", () => {
    expect(amounts(distribute(new Money("-0.05"), [new Money(1), new Money(1)], 2))).toEqual([
      "-0.03",
      "-0.02",
    ]);
    expect(amounts(distribute(new Money("1.00"), [new Money(0), new Money(0)], 2))).toEqual(["0.50", "0.50"]);
    expect(distribute(new Money("1.00"), [], 2)).toEqual([]);
    expect(
      distribute(new Money("7"), [new Money(1), new Money(2)], 0).map((value) => value.toFixed(0)),
    ).toEqual(["2", "5"]);
  });
});

describe("toFlightOffer", () => {
  it("gives customer scope selling amounts only, inside `amadeus` too [OBE-021 AC1]", () => {
    const offer = toFlightOffer(STORED, context());

    expect(offer?.price).toEqual({
      currency: "EUR",
      total: { amount: "990.00", currency: "EUR" },
      base: { amount: "690.00", currency: "EUR" },
      taxes: { amount: "295.00", currency: "EUR" },
      fees: { amount: "5.00", currency: "EUR" },
      additionalServices: null,
      perAdult: { amount: "660.00", currency: "EUR" },
      breakdown: {
        travelers: [
          {
            travelerId: "1",
            travelerType: "ADULT",
            base: { amount: "460.00", currency: "EUR" },
            taxes: { amount: "200.00", currency: "EUR" },
            fees: { amount: "0.00", currency: "EUR" },
            total: { amount: "660.00", currency: "EUR" },
            taxDetails: [{ code: "FR", amount: { amount: "150.00", currency: "EUR" } }],
          },
          {
            travelerId: "2",
            travelerType: "CHILD",
            base: { amount: "230.00", currency: "EUR" },
            taxes: { amount: "100.00", currency: "EUR" },
            fees: { amount: "0.00", currency: "EUR" },
            total: { amount: "330.00", currency: "EUR" },
            taxDetails: [],
          },
        ],
        fees: [{ type: "ticketing", amount: { amount: "5.00", currency: "EUR" }, description: null }],
      },
    });
    const amadeus = offer?.amadeus as unknown as {
      price: Record<string, unknown>;
      travelerPricings: Array<{ price: Record<string, unknown> }>;
    };
    expect(amadeus.price).toMatchObject({ base: "690.00", total: "990.00", grandTotal: "990.00" });
    expect(amadeus.price).not.toHaveProperty("margins");
    expect(
      amadeus.travelerPricings.map((pricing) => [pricing.price["base"], pricing.price["total"]]),
    ).toEqual([
      ["460.00", "660.00"],
      ["230.00", "330.00"],
    ]);
    expect(amadeus.travelerPricings[0]?.price).not.toHaveProperty("margins");
    expect(offer).not.toHaveProperty("netPrice");
    expect(offer).not.toHaveProperty("markup");
    expect(netKeys(offer)).toEqual([]);
    // The stored payload is left as it was.
    expect(ROUND_TRIP.price.grandTotal).toBe("900.00");
  });

  it("gives console scope the verbatim offer, the net price and the markup", () => {
    const offer = toFlightOffer(STORED, context({ scope: "console" }));

    expect(offer?.amadeus).toEqual(ROUND_TRIP);
    expect(offer?.netPrice).toEqual({ amount: "900.00", currency: "EUR" });
    expect(offer?.markup).toEqual({
      amount: { amount: "90.00", currency: "EUR" },
      ruleId: STORED.markupRuleId,
      ruleName: "Ten percent",
      serviceFee: null,
    });
    expect(offer?.price.total).toEqual({ amount: "990.00", currency: "EUR" });
  });

  it("leaves `amadeus`, the traveller pricings and the breakdown out of the summary view", () => {
    const offer = toFlightOffer(STORED, context({ view: "summary" }));

    expect(offer).not.toHaveProperty("amadeus");
    expect(offer).not.toHaveProperty("travelerPricings");
    expect(offer?.price).not.toHaveProperty("breakdown");
    expect(offer?.summary).toMatchObject({
      tripType: "round_trip",
      originCode: "CDG",
      destinationCode: "JFK",
      departureAt: "2027-01-15T22:10:00",
      returnAt: "2027-01-22T18:00:00",
      maxStops: 1,
      cabins: ["ECONOMY", "BUSINESS"],
      brandedFares: [
        { itineraryIndex: 0, code: "LIGHT", label: "ECONOMY LIGHT" },
        { itineraryIndex: 1, code: "STANDARD", label: "ECONOMY STANDARD" },
      ],
      includedCheckedBags: { quantity: null, weight: 23, weightUnit: "KG" },
      refundable: false,
      changeable: true,
      co2Kg: null,
      tags: ["cheapest"],
    });
  });

  it("maps itineraries and segments with names, layovers and day offsets", () => {
    const offer = toFlightOffer(STORED, context());
    const [outbound, inbound] = offer?.itineraries ?? [];

    expect(outbound).toMatchObject({
      index: 0,
      originCode: "CDG",
      destinationCode: "JFK",
      departureAt: "2027-01-15T22:10:00",
      arrivalAt: "2027-01-16T08:40:00",
      durationMinutes: 990,
      stops: 1,
      stopAirports: ["AMS"],
      arrivalDayOffset: 1,
      marketingCarriers: ["AF", "KL"],
    });
    expect(outbound?.segments[0]).toMatchObject({
      id: "1",
      departure: {
        iataCode: "CDG",
        terminal: "2F",
        at: "2027-01-15T22:10:00",
        cityCode: "PAR",
        countryCode: "FR",
        airportName: "Paris Charles de Gaulle",
        cityName: "Paris",
      },
      carrierName: "Air France",
      flightNumber: "AF1240",
      operating: { carrierCode: "KL", carrierName: "KLM" },
      aircraft: { code: "320", name: "AIRBUS A320" },
      durationMinutes: 90,
      cabin: "ECONOMY",
      bookingClass: "Y",
      brandedFare: "LIGHT",
      co2Emissions: [{ weight: 80, weightUnit: "KG", cabin: "ECONOMY" }],
      layoverAfter: {
        duration: "PT6H30M",
        durationMinutes: 390,
        airportChange: false,
        overnight: true,
        nextDepartureCode: "AMS",
      },
    });
    expect(outbound?.segments[1]?.layoverAfter).toBeNull();
    expect(inbound).toMatchObject({ index: 1, stops: 0, arrivalDayOffset: 1, stopAirports: [] });
    expect(offer?.travelerPricings?.[0]?.segments[0]?.amenities).toEqual([
      {
        code: null,
        description: "CHANGEABLE TICKET",
        amenityType: "BRANDED_FARES",
        status: "chargeable",
        provider: "BrandedFare",
      },
    ]);
  });

  it("marks an offer expired after its expiry, and leaves out one it cannot read", () => {
    expect(toFlightOffer(STORED, context({ now: new Date("2026-10-18T10:30:00Z") }))?.status).toBe("expired");
    expect(toFlightOffer({ ...STORED, payload: { id: "1" } }, context())).toBeUndefined();
  });
});

describe("buildAmadeusSearch", () => {
  const DEFAULTS = parseSearchDefaults({});
  const SIMPLE: FlightSearchSimpleRequest = {
    mode: "simple",
    originLocationCode: "PAR",
    destinationLocationCode: "NYC",
    departureDate: "2027-01-15",
    returnDate: "2027-01-22",
    adults: 2,
    children: 1,
    includedAirlineCodes: ["AF", "KL"],
    max: 300,
  };

  it("builds the GET query of a SIMPLE search with the currency and the storefront's limit", () => {
    expect(buildAmadeusSearch(SIMPLE, "EUR", DEFAULTS, "customer")).toEqual({
      operationId: "getFlightOffers",
      query: {
        originLocationCode: "PAR",
        destinationLocationCode: "NYC",
        departureDate: "2027-01-15",
        returnDate: "2027-01-22",
        adults: 2,
        children: 1,
        includedAirlineCodes: "AF,KL",
        currencyCode: "EUR",
        max: 250,
      },
    });
    const defaults = parseSearchDefaults({ maxResults: 50, nonStop: true, cabin: "BUSINESS" });
    const { max: _max, ...withoutMax } = SIMPLE;
    expect(buildAmadeusSearch(withoutMax, "GBP", defaults, "customer")).toMatchObject({
      query: { travelClass: "BUSINESS", nonStop: true, currencyCode: "GBP", max: 50 },
    });
    expect(
      buildAmadeusSearch({ ...SIMPLE, nonStop: false, travelClass: "ECONOMY" }, "EUR", defaults, "customer"),
    ).toMatchObject({ query: { travelClass: "ECONOMY", nonStop: false } });
  });

  it("refuses SIMPLE criteria Amadeus would reject", () => {
    const problem = (request: FlightSearchCreateRequest) =>
      buildAmadeusSearch(request, "EUR", DEFAULTS, "customer") as { path?: string; kind?: string };
    expect(problem({ ...SIMPLE, adults: 5, children: 5 })).toMatchObject({
      path: "/children",
      kind: "validation",
    });
    expect(problem({ ...SIMPLE, adults: 1, children: 0, infants: 2 })).toMatchObject({ path: "/infants" });
    expect(problem({ ...SIMPLE, excludedAirlineCodes: ["IB"] })).toMatchObject({
      path: "/excludedAirlineCodes",
    });
    expect(problem({ ...SIMPLE, returnDate: "2027-01-14" })).toMatchObject({ path: "/returnDate" });
  });

  const ADVANCED: FlightSearchAdvancedRequest = {
    mode: "advanced",
    query: {
      originDestinations: [
        {
          id: "1",
          originLocationCode: "PAR",
          destinationLocationCode: "NYC",
          departureDateTimeRange: { date: "2027-01-15" },
        },
        {
          id: "2",
          originLocationCode: "NYC",
          destinationLocationCode: "MIA",
          departureDateTimeRange: { date: "2027-01-20" },
        },
      ],
      travelers: [
        { id: "1", travelerType: "ADULT" },
        { id: "2", travelerType: "HELD_INFANT", associatedAdultId: "1" },
      ],
      sources: ["GDS", "NDC"],
      searchCriteria: {
        maxFlightOffers: 400,
        additionalInformation: { fareRules: false },
        flightFilters: {
          cabinRestrictions: [
            { cabin: "BUSINESS", coverage: "MOST_SEGMENTS", originDestinationIds: ["1", "2"] },
          ],
          connectionRestriction: { maxNumberOfConnections: 0 },
        },
      },
    },
    resultOptions: { limit: 5 },
  };

  it("fills the POST body of an ADVANCED search: currency, sources, cap and information flags", () => {
    const built = buildAmadeusSearch(ADVANCED, "EUR", parseSearchDefaults({ sources: ["GDS"] }), "customer");
    expect(built).toMatchObject({
      operationId: "searchFlightOffers",
      body: {
        currencyCode: "EUR",
        sources: ["GDS"],
        searchCriteria: {
          maxFlightOffers: 250,
          additionalInformation: { brandedFares: true, chargeableCheckedBags: true, fareRules: false },
        },
      },
    });
  });

  it("refuses sources the storefront does not allow, and negotiated fares in customer scope", () => {
    expect(
      buildAmadeusSearch(ADVANCED, "EUR", parseSearchDefaults({ sources: ["EAC"] }), "customer"),
    ).toMatchObject({
      kind: "sources",
      path: "/query/sources",
    });
    const negotiated: FlightSearchCreateRequest = {
      mode: "advanced",
      query: {
        ...ADVANCED.query,
        searchCriteria: { pricingOptions: { fareType: ["NEGOTIATED"] } },
      },
    };
    expect(buildAmadeusSearch(negotiated, "EUR", DEFAULTS, "customer")).toMatchObject({ kind: "negotiated" });
    expect(buildAmadeusSearch(negotiated, "EUR", DEFAULTS, "console")).toMatchObject({
      operationId: "searchFlightOffers",
    });
    const noOrigin: FlightSearchCreateRequest = {
      mode: "advanced",
      query: {
        originDestinations: [{ id: "1", destinationLocationCode: "NYC" }],
        travelers: [],
        sources: ["GDS"],
      },
    };
    expect(buildAmadeusSearch(noOrigin, "EUR", DEFAULTS, "console")).toMatchObject({
      kind: "validation",
      path: "/query/originDestinations/0/originLocationCode",
    });
  });

  it("refuses ADVANCED travellers Amadeus would refuse: more than 9 over two years old, more infants than adults", () => {
    const withTravelers = (types: readonly string[]): FlightSearchCreateRequest =>
      ({
        mode: "advanced",
        query: {
          ...ADVANCED.query,
          travelers: types.map((travelerType, index) => ({ id: String(index + 1), travelerType })),
        },
      }) as FlightSearchCreateRequest;
    const nine = Array.from({ length: 9 }, () => "ADULT");
    expect(
      buildAmadeusSearch(withTravelers([...nine, "HELD_INFANT"]), "EUR", DEFAULTS, "console"),
    ).toMatchObject({
      operationId: "searchFlightOffers",
    });
    expect(buildAmadeusSearch(withTravelers([...nine, "CHILD"]), "EUR", DEFAULTS, "console")).toMatchObject({
      kind: "validation",
      path: "/query/travelers",
      code: "range",
    });
    expect(
      buildAmadeusSearch(
        withTravelers(["ADULT", "HELD_INFANT", "SEATED_INFANT"]),
        "EUR",
        DEFAULTS,
        "console",
      ),
    ).toMatchObject({ kind: "validation", path: "/query/travelers", code: "range" });
  });

  it("reads search_defaults leniently", () => {
    expect(parseSearchDefaults(null)).toEqual({
      maxResults: 250,
      nonStop: undefined,
      cabin: undefined,
      sources: undefined,
    });
    expect(parseSearchDefaults({ maxResults: 0, nonStop: "yes", cabin: "LUXURY", sources: ["XYZ"] })).toEqual(
      {
        maxResults: 250,
        nonStop: undefined,
        cabin: undefined,
        sources: undefined,
      },
    );
  });

  it("describes the trip and the criteria of both modes", () => {
    expect(searchSummaryOf(SIMPLE)).toEqual({
      tripType: "round_trip",
      legs: [
        { originDestinationId: "1", originCode: "PAR", destinationCode: "NYC", departureDate: "2027-01-15" },
        { originDestinationId: "2", originCode: "NYC", destinationCode: "PAR", departureDate: "2027-01-22" },
      ],
      travelers: { adults: 2, children: 1, infants: 0, total: 3 },
      travelClass: null,
      nonStop: false,
    });
    expect(searchSummaryOf(ADVANCED)).toEqual({
      tripType: "multi_city",
      legs: [
        { originDestinationId: "1", originCode: "PAR", destinationCode: "NYC", departureDate: "2027-01-15" },
        { originDestinationId: "2", originCode: "NYC", destinationCode: "MIA", departureDate: "2027-01-20" },
      ],
      travelers: { adults: 1, children: 0, infants: 1, total: 2 },
      travelClass: "BUSINESS",
      nonStop: true,
    });
    expect(criteriaRequestOf(ADVANCED)).not.toHaveProperty("resultOptions");
    const built = buildAmadeusSearch(SIMPLE, "EUR", DEFAULTS, "customer");
    if ("kind" in built) {
      throw new Error("the SIMPLE search was refused");
    }
    expect(searchCriteriaOf(SIMPLE, built)).toMatchObject({
      mode: "simple",
      amadeusOperationId: "getFlightOffers",
      amadeusQuery: { adults: "2", max: "250", includedAirlineCodes: "AF,KL" },
      amadeusBody: null,
    });
  });
});
