// Unit tests of the pure parts of flights.upsell (OBE-022; upsell.service.ts): the Amadeus request, the one-way
// combinations rebuilt from the flights, the feature keys of amenities and the fare-family comparison.
import { describe, expect, it } from "vitest";
import { parseOffer, type FlightOffer, type ParsedOffer } from "./offers.mapper";
import {
  buildUpsellRequest,
  featureKeyOf,
  oneWayUpselledCombinations,
  upsellComparison,
  type ComparisonOffer,
} from "./upsell.service";

/** A one-segment Amadeus offer flying `flight` (`IB3436`) at `at`. */
function amadeusOffer(id: string, flight: string, at = "2027-01-15T07:15:00"): unknown {
  return {
    type: "flight-offer",
    id,
    source: "GDS",
    itineraries: [
      {
        duration: "PT2H5M",
        segments: [
          {
            id: "1",
            departure: { iataCode: "MAD", at },
            arrival: { iataCode: "ORY", at: "2027-01-15T09:20:00" },
            carrierCode: flight.slice(0, 2),
            number: flight.slice(2),
            duration: "PT2H5M",
            numberOfStops: 0,
          },
        ],
      },
    ],
    price: { currency: "EUR", total: "98.47", base: "56.00", grandTotal: "98.47" },
    travelerPricings: [{ travelerId: "1", travelerType: "ADULT", fareOption: "STANDARD", price: {} }],
  };
}

function parsed(payload: unknown): ParsedOffer {
  const offer = parseOffer(payload);
  if (offer === undefined) {
    throw new Error("test offer cannot be parsed");
  }
  return offer;
}

describe("buildUpsellRequest", () => {
  const baseInput = { id: "off_base", amadeusOfferId: "2", payload: amadeusOffer("2", "IB3436") };
  const offers = [baseInput, { id: "off_other", amadeusOfferId: "3", payload: amadeusOffer("3", "UX1027") }];

  it("sends the stored Amadeus offers verbatim and leaves out empty payments", () => {
    expect(buildUpsellRequest(offers, undefined)).toEqual({
      data: { type: "flight-offer-upsell", flightOffers: offers.map((offer) => offer.payload) },
    });
    expect(buildUpsellRequest(offers, [])).toEqual(buildUpsellRequest(offers, undefined));
  });

  it("sends the BIN as the integer binNumber and the offers a card pays as Amadeus ids, all by default", () => {
    const request = buildUpsellRequest(offers, [
      { brand: "VISA", bin: "411111" },
      { brand: "MASTERCARD", offerIds: ["off_other"] },
    ]);
    expect(request).toMatchObject({
      data: {
        payments: [
          { brand: "VISA", binNumber: 411111, flightOfferIds: ["2", "3"] },
          { brand: "MASTERCARD", flightOfferIds: ["3"] },
        ],
      },
    });
    expect(request).not.toHaveProperty("data.payments.1.binNumber");
  });

  it("refuses a card for an offer outside the request and two offers with one Amadeus id", () => {
    expect(buildUpsellRequest(offers, [{ brand: "VISA", offerIds: ["off_base", "off_elsewhere"] }])).toEqual({
      kind: "validation",
      path: "/payments/0/offerIds/1",
      code: "not_in_request",
      message: expect.any(String) as unknown,
    });
    expect(
      buildUpsellRequest(
        [baseInput, { id: "off_upsold", amadeusOfferId: "2", payload: amadeusOffer("2", "IB3436") }],
        undefined,
      ),
    ).toMatchObject({ kind: "combination" });
  });
});

describe("oneWayUpselledCombinations", () => {
  it("gives each input offer the upsell offers that fly its segments", () => {
    const inputs = [
      { id: "off_out", offer: parsed(amadeusOffer("1", "IB3436")) },
      { id: "off_back", offer: parsed(amadeusOffer("2", "UX1027", "2027-01-20T18:00:00")) },
    ];
    const upsells = [
      { id: "off_u1", offer: parsed(amadeusOffer("1", "IB3436")) },
      { id: "off_u2", offer: parsed(amadeusOffer("2", "UX1027", "2027-01-20T18:00:00")) },
      { id: "off_u3", offer: parsed(amadeusOffer("3", "IB3436")) },
      // Same flight number, another day: another flight.
      { id: "off_u4", offer: parsed(amadeusOffer("4", "IB3436", "2027-01-16T07:15:00")) },
    ];
    expect(oneWayUpselledCombinations(inputs, upsells)).toEqual([
      { offerId: "off_out", upsellOfferIds: ["off_u1", "off_u3"] },
      { offerId: "off_back", upsellOfferIds: ["off_u2"] },
    ]);
  });
});

describe("featureKeyOf", () => {
  it.each([
    ["CHECKED BAG 1PC OF 23KG", "BAGGAGE", "checked_bags"],
    ["CABIN BAGGAGE 10KG 1PC", "BAGGAGE", "cabin_bag"],
    ["CARRY-ON BAG", null, "cabin_bag"],
    ["2ND BAG", null, "checked_bags"],
    ["REFUNDABLE TICKET", "BRANDED_FARES", "refund"],
    ["NON REFUNDABLE TICKET", "BRANDED_FARES", "refund"],
    ["CHANGEABLE TICKET", "BRANDED_FARES", "change"],
    ["REBOOKING", null, "change"],
    ["CHOICE OF STANDARD SEAT", "PRE_RESERVED_SEAT", "seat_selection"],
    ["SNACK", null, "meal"],
    ["MEAL", "MEAL", "meal"],
    ["LOUNGE ACCESS", "LOUNGE", "lounge"],
    ["PRIORITY BOARDING", "TRAVEL_SERVICES", "priority_boarding"],
    ["MILEAGE ACCRUAL", "FREQUENT_FLYER", "miles"],
    ["WIFI", "WIFI", undefined],
  ] as const)("%s (%s) → %s", (description, amenityType, key) => {
    expect(featureKeyOf(description, amenityType)).toBe(key);
  });
});

/** An offer of the comparison with only the fields it reads. */
function column(
  id: string,
  total: string,
  options: {
    readonly brand?: string;
    readonly checked?: {
      quantity?: number | null;
      weight?: number | null;
      weightUnit?: string | null;
    } | null;
    readonly refundable?: boolean | null;
    readonly amenities?: ReadonlyArray<{
      code?: string | null;
      description: string;
      amenityType?: string | null;
      status: "included" | "chargeable";
    }>;
  } = {},
): ComparisonOffer {
  const offer = {
    id,
    price: { total: { amount: total, currency: "EUR" } },
    summary: {
      brandedFares:
        options.brand === undefined ? [] : [{ itineraryIndex: 0, code: options.brand, label: options.brand }],
      includedCheckedBags: options.checked ?? null,
      includedCabinBags: null,
      refundable: options.refundable ?? null,
      changeable: null,
    },
    travelerPricings: [
      {
        travelerId: "1",
        travelerType: "ADULT",
        fareOption: "STANDARD",
        segments: [{ segmentId: "1", amenities: options.amenities ?? [] }],
      },
    ],
  };
  return { offer: offer as unknown as FlightOffer, mainCabin: "ECONOMY" };
}

describe("upsellComparison", () => {
  const base = column("off_base", "108.32", { brand: "BASIC", checked: { quantity: 0 } });
  const flexible = column("off_flex", "208.42", {
    brand: "FLEXIBLE",
    checked: { quantity: 1, weight: 23, weightUnit: "KG" },
    amenities: [
      { code: "06B", description: "REFUNDABLE TICKET", amenityType: "BRANDED_FARES", status: "included" },
      { code: "059", description: "CHANGEABLE TICKET", amenityType: "BRANDED_FARES", status: "included" },
      { code: "0B5", description: "WIFI ACCESS", amenityType: "WIFI", status: "chargeable" },
    ],
  });
  const classic = column("off_classic", "139.12", {
    brand: "CLASSIC",
    checked: { quantity: 1 },
    amenities: [
      { code: "0C3", description: "CHECKED BAG 1PC OF 23KG", amenityType: "BAGGAGE", status: "included" },
      { code: "059", description: "CHANGES NOT PERMITTED", amenityType: "BRANDED_FARES", status: "included" },
    ],
  });
  const basicAgain = column("off_basic", "108.32", {
    brand: "BASIC",
    checked: { quantity: 0 },
    amenities: [
      { code: "0C3", description: "CHECKED BAG 1PC OF 23KG", amenityType: "BAGGAGE", status: "chargeable" },
    ],
  });

  it("puts the base first, then the upsell offers by ascending price, with the differences to the base", () => {
    const comparison = upsellComparison(base, [flexible, classic, basicAgain], 2);
    expect(
      comparison.columns.map((entry) => [
        entry.offerId,
        entry.isBaseOffer,
        entry.brandedFare,
        entry.price.amount,
        entry.priceDifference.amount,
      ]),
    ).toEqual([
      ["off_base", true, "BASIC", "108.32", "0.00"],
      ["off_basic", false, "BASIC", "108.32", "0.00"],
      ["off_classic", false, "CLASSIC", "139.12", "30.80"],
      ["off_flex", false, "FLEXIBLE", "208.42", "100.10"],
    ]);
    expect(comparison.columns[0]).toMatchObject({ cabin: "ECONOMY", includedCheckedBags: { quantity: 0 } });
  });

  it("marks each feature included, chargeable, not offered or unknown per column", () => {
    const comparison = upsellComparison(base, [flexible, classic, basicAgain], 2);
    const cells = (key: string) =>
      comparison.rows
        .find((row) => row.key === key)
        ?.values.map((cell) => [cell.status, cell.detail ?? null]);
    // Columns: base (no amenities), BASIC, CLASSIC, FLEXIBLE.
    expect(comparison.rows.map((row) => row.key)).toEqual(["checked_bags", "refund", "change", "0B5"]);
    expect(cells("checked_bags")).toEqual([
      ["not_offered", null],
      ["chargeable", null],
      ["included", "1 piece"],
      ["included", "1 × 23 kg"],
    ]);
    expect(cells("refund")).toEqual([
      ["unknown", null],
      ["not_offered", null],
      ["not_offered", null],
      ["included", null],
    ]);
    // "CHANGES NOT PERMITTED" negates the change.
    expect(cells("change")).toEqual([
      ["unknown", null],
      ["not_offered", null],
      ["not_offered", null],
      ["included", null],
    ]);
    const wifi = comparison.rows.find((row) => row.key === "0B5");
    expect(wifi).toMatchObject({ label: "WIFI ACCESS", amenityType: "WIFI" });
    expect(wifi?.values.map((cell) => cell.status)).toEqual([
      "unknown",
      "not_offered",
      "not_offered",
      "chargeable",
    ]);
    expect(comparison.rows.find((row) => row.key === "checked_bags")).toMatchObject({
      label: "Checked bags",
      amenityType: "BAGGAGE",
    });
  });

  it("uses the known refundability when no amenity names it, and reads a negated amenity as not offered", () => {
    const comparison = upsellComparison(
      column("off_base", "100.00", { refundable: false }),
      [
        column("off_up", "120.00", { refundable: true }),
        column("off_non", "110.00", {
          amenities: [
            { description: "NONREFUNDABLE TICKET", amenityType: "BRANDED_FARES", status: "included" },
          ],
        }),
      ],
      2,
    );
    expect(comparison.rows.find((row) => row.key === "refund")?.values.map((cell) => cell.status)).toEqual([
      "not_offered",
      "not_offered",
      "included",
    ]);
  });
});
