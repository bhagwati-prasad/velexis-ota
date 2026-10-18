// Unit tests of the priced-offer mapping (OBE-023; priced-offers.mapper.ts): the Flight Offers Price request, the
// reading of its answer, the expiry, the selling price with the booking's fees, the price change, the booking
// requirements, card fees, the ancillary catalogue, the fare rules and the customer- and console-scope answers.
import { describe, expect, it } from "vitest";
import { Money, type FeeLine } from "../pricing/pricing.types";
import { parseOffer, type ParsedOffer } from "./offers.mapper";
import {
  ancillaryCatalogueOf,
  ancillaryOptionKeys,
  bookingRequirementsOf,
  buildPricingRequest,
  confirmedOffersOf,
  creditCardFeesOf,
  earliestTicketingDate,
  fareRuleSetOf,
  fareRuleSummaryOf,
  hasFareRules,
  keptOptionIds,
  priceChangeOf,
  pricedOfferAmadeusOf,
  pricedOfferExpiry,
  pricedSellingPrice,
  pricingIncludeOf,
  pricingQuery,
  readPricingReply,
  snapshotOf,
  SNAPSHOT_KEY,
  toPricedOffer,
  warningsOf,
  type ConfirmedOffer,
  type FareRulesSource,
  type PricedOfferPart,
  type PricingSnapshot,
  type StoredPricedOffer,
} from "./priced-offers.mapper";

/** A synthetic one-way Madrid → Orly offer for one adult and one child (no real person, no recorded data). */
function amadeusOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "flight-offer",
    id: "1",
    source: "GDS",
    instantTicketingRequired: false,
    lastTicketingDate: "2027-01-10",
    itineraries: [
      {
        duration: "PT2H",
        segments: [
          {
            departure: { iataCode: "MAD", at: "2027-01-15T07:15:00" },
            arrival: { iataCode: "ORY", at: "2027-01-15T09:15:00" },
            carrierCode: "IB",
            number: "3436",
            duration: "PT2H",
            id: "3",
            numberOfStops: 0,
          },
        ],
      },
    ],
    price: {
      currency: "EUR",
      total: "300.00",
      base: "200.00",
      fees: [
        { amount: "0.00", type: "SUPPLIER" },
        { amount: "5.00", type: "TICKETING" },
      ],
      grandTotal: "300.00",
      margins: [{ amount: "1.00" }],
    },
    validatingAirlineCodes: ["IB"],
    travelerPricings: [
      {
        travelerId: "1",
        fareOption: "STANDARD",
        travelerType: "ADULT",
        price: { currency: "EUR", total: "180.00", base: "120.00", taxes: [{ amount: "30.00", code: "ES" }] },
        fareDetailsBySegment: [
          { segmentId: "3", cabin: "ECONOMY", fareBasis: "ADNN", brandedFare: "BASIC", class: "A" },
        ],
      },
      {
        travelerId: "2",
        fareOption: "STANDARD",
        travelerType: "CHILD",
        price: { currency: "EUR", total: "120.00", base: "80.00", taxes: [{ amount: "20.00", code: "ES" }] },
        fareDetailsBySegment: [{ segmentId: "3", cabin: "ECONOMY", fareBasis: "ADNNCH", class: "A" }],
      },
    ],
    ...overrides,
  };
}

function parsed(payload: unknown): ParsedOffer {
  const offer = parseOffer(payload);
  if (offer === undefined) {
    throw new Error("the test offer cannot be read");
  }
  return offer;
}

function confirmed(
  payload: Record<string, unknown>,
  offerId = "off_01JA4CA1Q8T1W4Z7C0F3J6M9P2",
): ConfirmedOffer {
  return { offerId, amadeusOfferId: String(payload["id"]), payload, parsed: parsed(payload) };
}

function feeLine(feeType: FeeLine["feeType"], label: string, amount: string): FeeLine {
  return {
    ruleId: `fee_${label.length}`,
    feeType,
    label,
    refundable: false,
    extraRef: null,
    appliesPer: "booking",
    units: 1,
    fixedApplied: true,
    capped: null,
    amount,
  };
}

const FEES = [
  feeLine("booking_service", "Booking service fee", "10.00"),
  feeLine("ticketing", "Ticketing fee", "3.30"),
];

describe("the pricing request", () => {
  const offers = [
    { id: "off_a", amadeusOfferId: "1", payload: { id: "1" }, travelerIds: ["1", "2"] },
    { id: "off_b", amadeusOfferId: "4", payload: { id: "4" }, travelerIds: ["2", "1"] },
  ];

  it("sends the stored offers verbatim with the card hints, travellers and fareRules", () => {
    const request = buildPricingRequest(offers, {
      payments: [
        { brand: "VISA", bin: "411111" },
        { brand: "MASTERCARD", offerIds: ["off_b"] },
      ],
      travelers: [{ id: "2", dateOfBirth: "2015-01-01" }],
    });

    expect(request).toEqual({
      data: {
        type: "flight-offers-pricing",
        flightOffers: [{ id: "1" }, { id: "4" }],
        payments: [
          { brand: "VISA", binNumber: 411111, flightOfferIds: ["1", "4"] },
          { brand: "MASTERCARD", flightOfferIds: ["4"] },
        ],
        travelers: [{ id: "2", dateOfBirth: "2015-01-01" }],
        additionalInformation: { fareRules: true },
      },
    });
    expect(buildPricingRequest(offers.slice(0, 1), { fareRules: false })).toEqual({
      data: {
        type: "flight-offers-pricing",
        flightOffers: [{ id: "1" }],
        additionalInformation: { fareRules: false },
      },
    });
  });

  it("refuses cards and travellers that are not the request's, offers it cannot tell apart and other travellers", () => {
    expect(buildPricingRequest(offers, { payments: [{ brand: "VISA", offerIds: ["off_c"] }] })).toMatchObject(
      {
        kind: "validation",
        path: "/payments/0/offerIds/0",
        code: "not_in_request",
      },
    );
    expect(buildPricingRequest(offers, { travelers: [{ id: "3" }] })).toMatchObject({
      kind: "validation",
      path: "/travelers/0/id",
      code: "unknown_traveler",
    });
    expect(buildPricingRequest(offers, { travelers: [{ id: "1" }, { id: "1" }] })).toMatchObject({
      path: "/travelers/1/id",
      code: "duplicate",
    });
    expect(buildPricingRequest(offers, { travelers: [{ dateOfBirth: "2015-01-01" }] })).toMatchObject({
      path: "/travelers/0/id",
      code: "required",
    });
    expect(
      buildPricingRequest(
        [
          offers[0] as (typeof offers)[number],
          { ...(offers[1] as (typeof offers)[number]), amadeusOfferId: "1" },
        ],
        {},
      ),
    ).toMatchObject({ kind: "combination", reason: "duplicate" });
    expect(
      buildPricingRequest(
        [
          offers[0] as (typeof offers)[number],
          { ...(offers[1] as (typeof offers)[number]), travelerIds: ["1"] },
        ],
        {},
      ),
    ).toMatchObject({ kind: "combination", reason: "travelers_mismatch" });
  });

  it("asks for the request's include in the specification's order, or for the operation's defaults", () => {
    expect(pricingIncludeOf({ include: ["detailed-fare-rules", "bags"] }, true)).toEqual([
      "bags",
      "detailed-fare-rules",
    ]);
    expect(pricingIncludeOf({ include: [] }, true)).toEqual([]);
    expect(pricingIncludeOf({}, true)).toEqual(["bags", "other-services", "detailed-fare-rules"]);
    expect(pricingIncludeOf({}, false)).toEqual(["detailed-fare-rules"]);
    expect(pricingIncludeOf({ payments: [{ brand: "VISA" }] }, false)).toEqual([
      "credit-card-fees",
      "detailed-fare-rules",
    ]);
    expect(pricingQuery(["bags"], true)).toEqual({ include: ["bags"], forceClass: true });
    expect(pricingQuery([], false)).toEqual({ forceClass: false });
  });
});

describe("the pricing answer", () => {
  it("matches each requested offer with its confirmed payload, or refuses an answer that lacks or changes one", () => {
    const one = amadeusOffer();
    const four = amadeusOffer({ id: "4" });
    const requested = [
      { id: "off_a", amadeusOfferId: "4", currency: "EUR" },
      { id: "off_b", amadeusOfferId: "1", currency: "EUR" },
    ];

    expect(confirmedOffersOf(requested, [one, four], parseOffer)?.map((offer) => offer.offerId)).toEqual([
      "off_a",
      "off_b",
    ]);
    expect(confirmedOffersOf(requested, [one], parseOffer)).toBeUndefined();
    expect(confirmedOffersOf(requested, [one, four, four], parseOffer)).toBeUndefined();
    expect(confirmedOffersOf(requested, [one, { id: "4" }], parseOffer)).toBeUndefined();
    expect(
      confirmedOffersOf(
        requested.slice(0, 1),
        [amadeusOffer({ id: "4", price: { currency: "USD", total: "1", base: "1" } })],
        parseOffer,
      ),
    ).toBeUndefined();
  });

  it("reads the answer leniently", () => {
    expect(readPricingReply(undefined)).toEqual({
      data: {},
      flightOffers: [],
      bookingRequirements: undefined,
      included: {},
      dictionaries: undefined,
      warnings: undefined,
    });
    const reply = readPricingReply({
      data: { type: "flight-offers-pricing", flightOffers: [{ id: "1" }], bookingRequirements: { a: 1 } },
      included: { bags: {} },
      warnings: [{ code: 37200, title: "PRICE DISCREPANCY", status: 200 }],
    });
    expect(reply.flightOffers).toEqual([{ id: "1" }]);
    expect(reply.included).toEqual({ bags: {} });
    expect(warningsOf(reply.warnings)).toEqual([{ code: 37200, title: "PRICE DISCREPANCY" }]);
    expect(warningsOf([{ detail: "no title" }, "text"])).toEqual([]);
  });
});

describe("the expiry", () => {
  const now = new Date("2027-01-09T10:00:00Z");

  it("is the offer TTL, or the end of the earliest last ticketing day when that comes first", () => {
    expect(pricedOfferExpiry(now, 30, null).toISOString()).toBe("2027-01-09T10:30:00.000Z");
    expect(pricedOfferExpiry(now, 30, "2027-01-10").toISOString()).toBe("2027-01-09T10:30:00.000Z");
    expect(pricedOfferExpiry(new Date("2027-01-09T23:50:00Z"), 30, "2027-01-09").toISOString()).toBe(
      "2027-01-10T00:00:00.000Z",
    );
    expect(
      earliestTicketingDate([
        confirmed(amadeusOffer({ lastTicketingDate: "2027-01-12" })),
        confirmed(amadeusOffer({ lastTicketingDate: "2027-01-10" })),
        confirmed(amadeusOffer({ lastTicketingDate: undefined })),
      ]),
    ).toBe("2027-01-10");
    expect(earliestTicketingDate([confirmed(amadeusOffer({ lastTicketingDate: undefined }))])).toBeNull();
  });
});

describe("the selling price of a priced offer", () => {
  const part = (markup: string, payload = amadeusOffer()): PricedOfferPart => ({
    ...confirmed(payload),
    markup,
  });

  it("folds the markup into the base fare and adds the booking's fees, so total = net + markup + fees", () => {
    const price = pricedSellingPrice([part("30.00")], FEES, "EUR", 2);

    expect(price).toMatchObject({
      currency: "EUR",
      total: { amount: "343.30", currency: "EUR" },
      base: { amount: "230.00", currency: "EUR" },
      taxes: { amount: "95.00", currency: "EUR" },
      fees: { amount: "18.30", currency: "EUR" },
      additionalServices: null,
      // The adult's 180.00 + 18.00 of the markup (60 %) + 7.98 of the fees.
      perAdult: { amount: "205.98", currency: "EUR" },
    });
    const sum = ["base", "taxes", "fees"].reduce(
      (total, field) =>
        total.plus((price as unknown as Record<string, { amount: string }>)[field]?.amount ?? 0),
      new Money(0),
    );
    expect(sum.toFixed(2)).toBe(price.total.amount);
    expect(price.breakdown?.travelers).toEqual([
      {
        travelerId: "1",
        travelerType: "ADULT",
        base: { amount: "138.00", currency: "EUR" },
        taxes: { amount: "60.00", currency: "EUR" },
        fees: { amount: "7.98", currency: "EUR" },
        total: { amount: "205.98", currency: "EUR" },
        taxDetails: [{ code: "ES", amount: { amount: "30.00", currency: "EUR" } }],
      },
      {
        travelerId: "2",
        travelerType: "CHILD",
        base: { amount: "92.00", currency: "EUR" },
        taxes: { amount: "40.00", currency: "EUR" },
        fees: { amount: "5.32", currency: "EUR" },
        total: { amount: "137.32", currency: "EUR" },
        taxDetails: [{ code: "ES", amount: { amount: "20.00", currency: "EUR" } }],
      },
    ]);
    expect(price.breakdown?.fees).toEqual([
      { type: "ticketing", amount: { amount: "5.00", currency: "EUR" }, description: null },
      {
        type: "service_fee",
        amount: { amount: "10.00", currency: "EUR" },
        description: "Booking service fee",
      },
      { type: "service_fee", amount: { amount: "3.30", currency: "EUR" }, description: "Ticketing fee" },
    ]);
  });

  it("adds the offers of a combination up per traveller, with their additional services", () => {
    const second = amadeusOffer({
      id: "4",
      price: {
        currency: "EUR",
        total: "100.00",
        base: "80.00",
        grandTotal: "130.00",
        additionalServices: [{ amount: "30.00", type: "CHECKED_BAGS" }],
        refundableTaxes: "10.00",
      },
      travelerPricings: [
        {
          travelerId: "1",
          fareOption: "STANDARD",
          travelerType: "ADULT",
          price: { currency: "EUR", total: "60.00", base: "48.00" },
          fareDetailsBySegment: [],
        },
        {
          travelerId: "2",
          fareOption: "STANDARD",
          travelerType: "CHILD",
          price: { currency: "EUR", total: "40.00", base: "32.00" },
          fareDetailsBySegment: [],
        },
      ],
    });

    const price = pricedSellingPrice([part("0.00"), part("10.00", second)], [], "EUR", 2);

    expect(price.total.amount).toBe("440.00");
    expect(price.additionalServices).toEqual({ amount: "30.00", currency: "EUR" });
    expect(price.breakdown?.additionalServices).toEqual([
      { type: "CHECKED_BAGS", amount: { amount: "30.00", currency: "EUR" } },
    ]);
    // Only one of the offers says which taxes are refundable.
    expect(price.breakdown?.refundableTaxes).toBeNull();
    expect(
      price.breakdown?.travelers.map((traveler) => [traveler.travelerId, traveler.total.amount]),
    ).toEqual([
      ["1", "246.00"],
      ["2", "164.00"],
    ]);
    expect(
      new Money(price.base.amount)
        .plus(price.taxes.amount)
        .plus(price.fees.amount)
        .plus(price.additionalServices?.amount ?? 0)
        .toFixed(2),
    ).toBe(price.total.amount);
  });

  it("compares the confirmed total with the results total plus the same fees", () => {
    expect(priceChangeOf("108.32", "11.08", "119.40", "EUR", 2)).toEqual({
      changed: false,
      oldPrice: { amount: "119.40", currency: "EUR" },
      newPrice: { amount: "119.40", currency: "EUR" },
      difference: { amount: "0.00", currency: "EUR" },
      direction: "none",
    });
    expect(priceChangeOf("108.32", "11.19", "130.51", "EUR", 2)).toMatchObject({
      changed: true,
      oldPrice: { amount: "119.51" },
      difference: { amount: "11.00" },
      direction: "up",
    });
    expect(priceChangeOf("108.32", "0", "100.00", "EUR", 2)).toMatchObject({
      changed: true,
      difference: { amount: "-8.32" },
      direction: "down",
    });
  });
});

describe("booking requirements and card fees", () => {
  const offerIdOf = (amadeusId: string): string | undefined => (amadeusId === "1" ? "off_one" : undefined);

  it("copies the flags Amadeus gives, per traveller, with the 3-D Secure requirements by off_ id", () => {
    expect(
      bookingRequirementsOf(
        {
          mobilePhoneNumberRequired: true,
          postalCodeRequired: false,
          travelerRequirements: [
            { travelerId: "1", genderRequired: true, documentRequired: "yes" },
            { genderRequired: true },
          ],
          threeDomainSecureRequirements: [
            { flightOfferIds: ["1", "9"], is3dsAuthenticationRequired: true },
            { flightOfferIds: ["9"], is3dsAuthenticationRequired: true },
          ],
        },
        offerIdOf,
      ),
    ).toEqual({
      emailAddressRequired: false,
      mobilePhoneNumberRequired: true,
      postalCodeRequired: false,
      travelerRequirements: [{ travelerId: "1", genderRequired: true }],
      threeDomainSecureRequirements: [{ offerIds: ["off_one"], is3dsAuthenticationRequired: true }],
    });
    expect(bookingRequirementsOf(undefined, offerIdOf)).toEqual({
      emailAddressRequired: false,
      mobilePhoneNumberRequired: false,
      travelerRequirements: [],
    });
  });

  it("keeps the card fees of known brands and offers with well-formed amounts", () => {
    expect(
      creditCardFeesOf(
        {
          "credit-card-fees": {
            "2": { brand: "MASTERCARD", amount: "1.50", currency: "EUR", flightOfferId: "1" },
            "1": { brand: "VISA", amount: "1.20", currency: "EUR", flightOfferId: "1" },
            "3": { brand: "DINERS", amount: "2.00", currency: "EUR", flightOfferId: "1" },
            "4": { brand: "VISA", amount: "1,20", currency: "EUR", flightOfferId: "1" },
            "5": { brand: "VISA", amount: "1.20", currency: "EUR", flightOfferId: "9" },
          },
        },
        offerIdOf,
      ),
    ).toEqual([
      { brand: "VISA", amount: { amount: "1.20", currency: "EUR" }, offerId: "off_one" },
      { brand: "MASTERCARD", amount: { amount: "1.50", currency: "EUR" }, offerId: "off_one" },
    ]);
  });
});

describe("the ancillary catalogue", () => {
  const included = {
    bags: {
      "1": {
        quantity: 1,
        weight: 23,
        weightUnit: "KG",
        name: "CHECKED_BAG",
        price: { amount: "30.00", currencyCode: "EUR" },
        bookableByItinerary: true,
        segmentIds: ["3"],
        travelerIds: ["1", "2", "7"],
      },
      "2": {
        quantity: 2,
        name: "CABIN_BAG",
        price: { amount: "15.00A", currencyCode: "EUR" },
        segmentIds: ["3"],
      },
      "3": { quantity: 1, name: "CHECKED_BAG", price: { amount: "28.00", currencyCode: "USD" } },
      "4": { quantity: 1, name: "CHECKED_BAG", price: { amount: "28.005", currencyCode: "EUR" } },
    },
    "other-services": {
      "1": {
        name: "PRIORITY_BOARDING",
        price: { amount: "9.00", currencyCode: "EUR" },
        bookableByTraveler: true,
        bookableByItinerary: true,
        segmentIds: ["3"],
        travelerIds: ["1"],
      },
      "2": { name: "LOUNGE", price: { amount: "40.00", currencyCode: "EUR" } },
    },
  };
  const seatOffer = amadeusOffer({
    travelerPricings: [
      {
        travelerId: "1",
        fareOption: "STANDARD",
        travelerType: "ADULT",
        price: { currency: "EUR", total: "180.00", base: "120.00" },
        fareDetailsBySegment: [
          {
            segmentId: "3",
            cabin: "ECONOMY",
            amenities: [{ description: "SEAT", isChargeable: true, amenityType: "PRE_RESERVED_SEAT" }],
          },
        ],
      },
      {
        travelerId: "2",
        fareOption: "STANDARD",
        travelerType: "CHILD",
        price: { currency: "EUR", total: "120.00", base: "80.00" },
        fareDetailsBySegment: [{ segmentId: "3", cabin: "ECONOMY" }],
      },
    ],
  });
  const offers = [confirmed(seatOffer, "off_seat")];
  const keys = ancillaryOptionKeys(included, offers, "EUR", 2);
  const optionIds = Object.fromEntries(
    keys.map((key, index) => [key, `anc_${String(index).padStart(16, "0")}`]),
  );
  const context = {
    pricedOfferId: "prc_01JA4CB2E7G1J4L6N9Q2S5U8W1",
    currency: "EUR",
    minorUnits: 2,
    scope: "customer" as const,
    expiresAt: new Date("2027-01-09T10:30:00Z"),
    offers,
  };
  const source = { included, optionIds, loadedAt: new Date("2027-01-09T10:00:00Z"), warnings: [] };

  it("has an option per usable included entry and per chargeable seat, in a stable order", () => {
    expect(keys).toEqual(["bags:1", "bags:2", "other-services:1", "seats:off_seat:3"]);
  });

  it("lists the options by kind with selling prices, their Amadeus items, and no net price in customer scope", () => {
    const catalogue = ancillaryCatalogueOf(source, context);

    expect(catalogue).toMatchObject({
      pricedOfferId: context.pricedOfferId,
      currency: "EUR",
      travelers: [
        { travelerId: "1", travelerType: "ADULT" },
        { travelerId: "2", travelerType: "CHILD" },
      ],
      segments: [
        {
          segmentId: "3",
          offerId: "off_seat",
          itineraryIndex: 0,
          originCode: "MAD",
          destinationCode: "ORY",
          flightNumber: "IB3436",
          departureAt: "2027-01-15T07:15:00",
        },
      ],
      seatsSupported: true,
      loadedAt: "2027-01-09T10:00:00.000Z",
      expiresAt: "2027-01-09T10:30:00.000Z",
      warnings: [],
    });
    expect(catalogue.checkedBags).toEqual([
      {
        id: optionIds["bags:1"],
        type: "CHECKED_BAGS",
        name: "CHECKED_BAG",
        label: "1 extra checked bag (23 kg) – MAD–ORY",
        descriptions: [],
        offerId: "off_seat",
        travelerIds: ["1", "2"],
        segmentIds: ["3"],
        bookableByTraveler: true,
        bookableByItinerary: true,
        quantity: 1,
        weight: 23,
        weightUnit: "KG",
        serviceName: null,
        requiresSeatNumber: false,
        price: { amount: "30.00", currency: "EUR" },
        amadeus: {
          flightOfferId: "1",
          includedKey: "1",
          segmentIds: ["3"],
          additionalServices: { chargeableCheckedBags: { quantity: 1, weight: 23, weightUnit: "KG" } },
          raw: included.bags["1"],
        },
      },
    ]);
    expect(
      catalogue.cabinBags.map((option) => [option.label, option.price, option.amadeus.additionalServices]),
    ).toEqual([
      [
        "2 extra cabin bags – MAD–ORY",
        { amount: "15.00", currency: "EUR" },
        { chargeableCabinBags: { quantity: 2 } },
      ],
    ]);
    expect(
      catalogue.otherServices.map((option) => [
        option.serviceName,
        option.travelerIds,
        option.amadeus.additionalServices,
      ]),
    ).toEqual([["PRIORITY_BOARDING", ["1"], { otherServices: ["PRIORITY_BOARDING"] }]]);
    expect(catalogue.seats).toEqual([
      expect.objectContaining({
        type: "SEATS",
        travelerIds: ["1"],
        segmentIds: ["3"],
        requiresSeatNumber: true,
        price: null,
        amadeus: expect.objectContaining({
          includedKey: null,
          additionalServices: { chargeableSeat: {} },
          raw: null,
        }),
      }),
    ]);
    for (const option of [
      ...catalogue.checkedBags,
      ...catalogue.cabinBags,
      ...catalogue.otherServices,
      ...catalogue.seats,
    ]) {
      expect(option).not.toHaveProperty("netPrice");
    }
  });

  it("gives console scope the Amadeus price, and leaves out options without an id", () => {
    const catalogue = ancillaryCatalogueOf(
      { ...source, optionIds: { "bags:1": "anc_0000000000000001" } },
      { ...context, scope: "console" },
    );

    expect(catalogue.checkedBags.map((option) => [option.id, option.netPrice])).toEqual([
      ["anc_0000000000000001", { amount: "30.00", currency: "EUR" }],
    ]);
    expect(catalogue.cabinBags).toEqual([]);
    expect(catalogue.otherServices).toEqual([]);
    expect(catalogue.seatsSupported).toBe(false);
  });

  it("keeps the ids of the embedded catalogue for the options a later load answers unchanged", () => {
    // The pricing included bags only: its catalogue has the bags and the seat; the later load adds the services, and
    // its bag "2" is another entry (another price) under the same key.
    const embeddedIncluded = { bags: included.bags };
    const embeddedIds = Object.fromEntries(
      ancillaryOptionKeys(embeddedIncluded, offers, "EUR", 2).map((key) => [key, `id-of-${key}`]),
    );
    const later = {
      bags: {
        ...included.bags,
        "2": { ...included.bags["2"], price: { amount: "17.00", currencyCode: "EUR" } },
      },
      "other-services": included["other-services"],
    };

    expect(
      keptOptionIds(
        { included: embeddedIncluded, optionIds: embeddedIds },
        later,
        ancillaryOptionKeys(later, offers, "EUR", 2),
      ),
    ).toEqual({ "bags:1": "id-of-bags:1", "seats:off_seat:3": "id-of-seats:off_seat:3" });
    expect(keptOptionIds({ included: {}, optionIds: {} }, later, ["bags:1", "seats:off_seat:3"])).toEqual({});
  });
});

describe("the fare rules", () => {
  const rules = {
    currency: "EUR",
    rules: [
      {
        category: "EXCHANGE",
        maxPenaltyAmount: "50.00",
        isChargeable: true,
        applicability: { segmentIds: ["3"] },
      },
      {
        category: "REFUND",
        notApplicable: true,
        descriptions: [{ descriptionType: "PENALTIES", text: "NO REFUND" }],
      },
      { category: "UNKNOWN_CATEGORY" },
    ],
  };
  const detailed = {
    "1": {
      fareBasis: "ADNN",
      name: "PENALTIES",
      segmentId: "3",
      fareNotes: {
        descriptions: [
          {
            descriptionType: "PENALTIES",
            text: "CHANGES\n  ANY TIME CHARGE EUR 70.00.\nTICKET IS NON-REFUNDABLE.",
          },
        ],
      },
    },
  };
  const sourceOf = (
    fareRules: unknown,
    detailedFareRules: unknown,
    payload = amadeusOffer(),
  ): FareRulesSource => ({
    offers: [{ offerId: "off_one", fareRules, parsed: parsed(payload) }],
    detailedFareRules,
    loadedAt: new Date("2027-01-09T10:00:00Z"),
    warnings: [],
  });

  it("lists every rule of the document's categories and the detailed notes, with the raw data", () => {
    const set = fareRuleSetOf("prc_01JA4CB2E7G1J4L6N9Q2S5U8W1", "EUR", sourceOf(rules, detailed));

    expect(set).toMatchObject({
      pricedOfferId: "prc_01JA4CB2E7G1J4L6N9Q2S5U8W1",
      currency: "EUR",
      available: true,
      summary: {
        refundable: false,
        changeable: true,
        refundPenalty: null,
        changePenalty: { amount: "50.00", currency: "EUR" },
        source: "fare_rules",
      },
      fareComponents: [
        {
          key: "1",
          fareBasis: "ADNN",
          name: "PENALTIES",
          segmentId: "3",
          category: null,
          notes: [{ descriptionType: "PENALTIES", text: expect.stringContaining("NON-REFUNDABLE") }],
        },
      ],
      raw: { fareRules: [{ offerId: "off_one", fareRules: rules }], detailedFareRules: detailed },
      loadedAt: "2027-01-09T10:00:00.000Z",
    });
    expect(set.categories).toEqual([
      {
        offerId: "off_one",
        category: "EXCHANGE",
        applicable: true,
        chargeable: true,
        maxPenalty: { amount: "50.00", currency: "EUR" },
        circumstances: null,
        travelerIds: [],
        segmentIds: ["3"],
        texts: [],
      },
      {
        offerId: "off_one",
        category: "REFUND",
        applicable: false,
        chargeable: null,
        maxPenalty: null,
        circumstances: null,
        travelerIds: [],
        segmentIds: [],
        texts: [{ descriptionType: "PENALTIES", text: "NO REFUND" }],
      },
    ]);
  });

  it("reads unambiguous detailed notes, then the amenities, when no rule decides", () => {
    expect(fareRuleSummaryOf(sourceOf(undefined, detailed), "EUR")).toMatchObject({
      refundable: false,
      changeable: true,
      source: "detailed_fare_rules",
    });
    const amenities = amadeusOffer({
      travelerPricings: [
        {
          travelerId: "1",
          fareOption: "STANDARD",
          travelerType: "ADULT",
          price: { currency: "EUR", total: "300.00", base: "200.00" },
          fareDetailsBySegment: [
            { segmentId: "3", amenities: [{ description: "REFUNDABLE TICKET", isChargeable: true }] },
          ],
        },
      ],
    });
    expect(fareRuleSummaryOf(sourceOf(undefined, {}, amenities), "EUR")).toMatchObject({
      refundable: true,
      changeable: null,
      source: "amenities",
    });
    const nothing = sourceOf(undefined, undefined);
    expect(fareRuleSummaryOf(nothing, "EUR")).toEqual({
      refundable: null,
      changeable: null,
      refundPenalty: null,
      changePenalty: null,
      source: "unknown",
    });
    expect(hasFareRules(nothing)).toBe(false);
    expect(fareRuleSetOf("prc_01JA4CB2E7G1J4L6N9Q2S5U8W1", "EUR", nothing)).toMatchObject({
      available: false,
      categories: [],
      fareComponents: [],
      raw: { fareRules: [], detailedFareRules: {} },
    });
  });

  it("takes the most restrictive verdict over several offers", () => {
    const source: FareRulesSource = {
      offers: [
        {
          offerId: "off_one",
          fareRules: { rules: [{ category: "REFUND" }] },
          parsed: parsed(amadeusOffer()),
        },
        { offerId: "off_two", fareRules: undefined, parsed: parsed(amadeusOffer({ id: "4" })) },
      ],
      detailedFareRules: undefined,
      loadedAt: new Date(),
      warnings: [],
    };
    expect(fareRuleSummaryOf(source, "EUR")).toMatchObject({ refundable: null, source: "fare_rules" });
    expect(
      fareRuleSummaryOf(
        {
          ...source,
          offers: [
            ...source.offers.slice(0, 1),
            {
              offerId: "off_two",
              fareRules: { rules: [{ category: "REFUND", notApplicable: true }] },
              parsed: parsed(amadeusOffer({ id: "4" })),
            },
          ],
        },
        "EUR",
      ),
    ).toMatchObject({ refundable: false });
  });
});

describe("the priced offer answer", () => {
  const payload = amadeusOffer();
  const parts: PricedOfferPart[] = [{ ...confirmed(payload), markup: "30.00" }];
  const snapshot: PricingSnapshot = {
    version: 1,
    searchId: "srch_01JA4C8Q0D5N7R2T6V9X3Z1B4F",
    customerId: null,
    channel: "storefront",
    include: ["detailed-fare-rules"],
    fareRules: true,
    forceClass: false,
    minorUnits: 2,
    resultsTotal: "330.00",
    offers: [
      {
        offerId: parts[0]?.offerId ?? "",
        amadeusOfferId: "1",
        net: "300.00",
        markup: "30.00",
        selling: "330.00",
        markupRuleId: "mkr_01JA4C8Q0D5N7R2T6V9X3Z1B4F",
        markupRuleName: "Ten percent",
        markupLines: [],
      },
    ],
    feeLines: FEES,
    optionIds: {},
    loads: {},
  };
  const response = {
    data: {
      type: "flight-offers-pricing",
      flightOffers: [payload],
      bookingRequirements: { emailAddressRequired: true },
    },
    included: {
      "detailed-fare-rules": {
        "1": { fareBasis: "ADNN", fareNotes: { descriptions: [{ text: "TICKET IS NON-REFUNDABLE." }] } },
      },
    },
    warnings: [],
    [SNAPSHOT_KEY]: snapshot,
  };
  const stored: StoredPricedOffer = {
    id: "prc_01JA4CB2E7G1J4L6N9Q2S5U8W1",
    searchId: snapshot.searchId,
    offerIds: [parts[0]?.offerId ?? ""],
    currency: "EUR",
    netTotal: "300.00",
    markupAmount: "30.00",
    feeAmount: "13.30",
    sellingTotal: "343.30",
    markupRuleId: "mkr_01JA4C8Q0D5N7R2T6V9X3Z1B4F",
    lastTicketingDate: "2027-01-10",
    expiresAt: new Date("2027-01-09T10:30:00Z"),
    createdAt: new Date("2027-01-09T10:00:00Z"),
    snapshot: snapshotOf(response),
    reply: readPricingReply(response),
  };
  const context = {
    scope: "customer" as const,
    now: new Date("2027-01-09T10:05:00Z"),
    parts,
    offers: [],
    dictionaries: { locations: {}, carriers: {}, aircraft: {}, currencies: {} },
  };

  it("answers selling amounts only in customer scope, with the Amadeus offers rewritten to them", () => {
    const answer = toPricedOffer(stored, context);

    expect(answer).toMatchObject({
      id: stored.id,
      status: "active",
      customerId: null,
      price: { total: { amount: "343.30" } },
      priceChange: { changed: false, oldPrice: { amount: "343.30" }, newPrice: { amount: "343.30" } },
      bookingRequirements: { emailAddressRequired: true, mobilePhoneNumberRequired: false },
      creditCardFees: [],
      selectedAncillaries: [],
      ancillaries: {
        loaded: false,
        checkedBags: false,
        cabinBags: false,
        otherServices: false,
        seats: false,
      },
      ancillaryCatalogue: null,
      fareRules: { available: true, summary: { refundable: false } },
      include: ["detailed-fare-rules"],
      lastTicketingDate: "2027-01-10",
      instantTicketingRequired: false,
      paymentCardRequired: false,
      amadeus: { query: { include: "detailed-fare-rules", forceClass: false } },
      createdAt: "2027-01-09T10:00:00.000Z",
      expiresAt: "2027-01-09T10:30:00.000Z",
    });
    expect(answer).not.toHaveProperty("netPrice");
    expect(answer).not.toHaveProperty("markup");
    const offer = answer.amadeus?.data.flightOffers[0] as unknown as {
      price: Record<string, unknown>;
      travelerPricings: Array<{ price: { total: string } }>;
    };
    expect(offer.price).toMatchObject({ total: "330.00", base: "230.00", grandTotal: "330.00" });
    expect(offer.price).not.toHaveProperty("margins");
    expect(offer.travelerPricings.map((pricing) => pricing.price.total)).toEqual(["198.00", "132.00"]);
    // The stored answer itself is never changed.
    expect((payload["price"] as Record<string, unknown>)["grandTotal"]).toBe("300.00");
    expect(toPricedOffer(stored, { ...context, now: new Date("2027-01-09T10:30:00Z") }).status).toBe(
      "expired",
    );
  });

  it("adds the net price, the markup and the verbatim Amadeus answer in console scope", () => {
    const answer = toPricedOffer(stored, { ...context, scope: "console" });

    expect(answer.netPrice).toEqual({ amount: "300.00", currency: "EUR" });
    expect(answer.markup).toEqual({
      amount: { amount: "30.00", currency: "EUR" },
      ruleId: "mkr_01JA4C8Q0D5N7R2T6V9X3Z1B4F",
      ruleName: "Ten percent",
      serviceFee: { amount: "13.30", currency: "EUR" },
    });
    expect(answer.amadeus?.data.flightOffers[0]).toEqual(payload);
    expect(
      pricedOfferAmadeusOf(stored.reply, parts, { include: [], forceClass: true }, "console", 2).query,
    ).toEqual({ include: "", forceClass: true });
  });

  it("never gives customer scope an answered offer that is not one of the priced offers (its amounts are net)", () => {
    const stray = amadeusOffer({ id: "9" });
    const reply = readPricingReply({
      data: { type: "flight-offers-pricing", flightOffers: [stray, payload] },
    });

    const customer = pricedOfferAmadeusOf(reply, parts, { include: [], forceClass: false }, "customer", 2);
    const verbatim = pricedOfferAmadeusOf(reply, parts, { include: [], forceClass: false }, "console", 2);

    expect(customer.data.flightOffers.map((offer) => [offer.id, offer.price?.grandTotal])).toEqual([
      ["1", "330.00"],
    ]);
    expect(verbatim.data.flightOffers.map((offer) => offer.id)).toEqual(["9", "1"]);
  });

  it("refuses a stored answer without its snapshot", () => {
    expect(() => snapshotOf({ data: {} })).toThrow("no readable pricing snapshot");
    expect(() => snapshotOf({ [SNAPSHOT_KEY]: { ...snapshot, version: 2 } })).toThrow();
  });
});
