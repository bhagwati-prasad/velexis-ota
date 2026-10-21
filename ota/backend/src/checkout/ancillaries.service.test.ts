// Unit tests of the pure parts of checkout.setAncillaries (OBE-037; ancillaries.service.ts): the selections resolved
// against a catalogue, the Flight Offers Price request with the extras, the extras' nets from Amadeus's
// `price.additionalServices` or the catalogue, their rows and selling prices with the `ancillary_service` fees, the
// checkout total, and the API errors of a failed re-pricing. The flights' net of a confirmed offer with extras
// (priced-offers.service.ts `flightNetOf`) is tested here too, as the re-pricing reads it.
import type { components } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { mapAmadeusError, type AmadeusIssue } from "../amadeus/error-mapper";
import { priceOffer } from "../pricing/pricing-engine";
import type { FeeLine, FeeRule, PricingInput } from "../pricing/pricing.types";
import { parseOffer } from "../shopping/offers.mapper";
import { additionalServiceAmounts, flightNetOf } from "../shopping/priced-offers.service";
import {
  ancillaryRows,
  buildServicesRequest,
  checkoutTotalOf,
  extraNets,
  extrasMissingFrom,
  planExtras,
  pricingExtrasOf,
  selectionOfPointer,
  servicesErrorOf,
  storedExtrasOf,
  travelersOf,
  type PlannedExtra,
} from "./ancillaries.service";
import type { CheckoutAncillaryRow } from "./checkout.repository";

type Schemas = components["schemas"];
type AncillaryCatalogue = Schemas["AncillaryCatalogue"];
type AncillaryOption = Schemas["AncillaryOption"];
type AncillarySelection = Schemas["AncillarySelection"];

const OFFER = "off_01JA4CC3B6E9H2L5N8R1U4X7A0";

/** A catalogue option of offer "2" for traveller "1" on segments "3" and "4" (overrides win). */
function option(overrides: Partial<AncillaryOption> & Pick<AncillaryOption, "id" | "type">): AncillaryOption {
  const segmentIds = overrides.segmentIds ?? ["3", "4"];
  return {
    name: overrides.type === "OTHER_SERVICES" ? "PRIORITY_BOARDING" : "CHECKED_BAG",
    label: `${overrides.type} option`,
    descriptions: [],
    offerId: OFFER,
    travelerIds: ["1"],
    segmentIds,
    bookableByTraveler: true,
    bookableByItinerary: true,
    quantity: null,
    weight: null,
    weightUnit: null,
    serviceName: null,
    requiresSeatNumber: overrides.type === "SEATS",
    price: null,
    netPrice: null,
    ...overrides,
    amadeus: {
      flightOfferId: "2",
      includedKey: overrides.type === "SEATS" ? null : "1",
      segmentIds,
      additionalServices: {},
      raw: null,
      ...overrides.amadeus,
    },
  };
}

const eur = (amount: string) => ({ amount, currency: "EUR" });

const BAG = option({
  id: "anc_01JA4CC3B6E9H2L5N8R1U4X7A1",
  type: "CHECKED_BAGS",
  quantity: 1,
  weight: 23,
  weightUnit: "KG",
  price: eur("30.00"),
  netPrice: eur("30.00"),
});
const TWO_BAGS = option({
  id: "anc_01JA4CC3B6E9H2L5N8R1U4X7A2",
  type: "CHECKED_BAGS",
  quantity: 2,
  weight: 23,
  weightUnit: "KG",
  price: eur("65.00"),
  netPrice: eur("65.00"),
  amadeus: { flightOfferId: "2", includedKey: "2", segmentIds: ["3", "4"], additionalServices: {} },
});
const PRIORITY = option({
  id: "anc_01JA4CC3B6E9H2L5N8R1U4X7A3",
  type: "OTHER_SERVICES",
  serviceName: "PRIORITY_BOARDING",
  price: eur("9.00"),
  netPrice: eur("9.00"),
  bookableByItinerary: false,
});
const FAST_TRACK = option({
  id: "anc_01JA4CC3B6E9H2L5N8R1U4X7A4",
  type: "OTHER_SERVICES",
  name: "FAST_TRACK",
  serviceName: "FAST_TRACK",
  segmentIds: ["3"],
  price: eur("12.00"),
  netPrice: eur("12.00"),
});
const SEAT = option({ id: "anc_01JA4CC3B6E9H2L5N8R1U4X7A5", type: "SEATS", name: "SEAT", segmentIds: ["4"] });

const CATALOGUE: AncillaryCatalogue = {
  pricedOfferId: "prc_01JA4CC3B6E9H2L5N8R1U4X7A0",
  currency: "EUR",
  travelers: [{ travelerId: "1", travelerType: "ADULT" }],
  segments: [
    {
      segmentId: "3",
      offerId: OFFER,
      itineraryIndex: 0,
      originCode: "MAD",
      destinationCode: "ORY",
      flightNumber: "IB3436",
      departureAt: "2027-01-15T07:15:00",
    },
  ],
  checkedBags: [BAG, TWO_BAGS],
  cabinBags: [],
  otherServices: [PRIORITY, FAST_TRACK],
  seats: [SEAT],
  seatsSupported: true,
  loadedAt: "2026-10-20T08:00:00.000Z",
  expiresAt: "2026-10-20T08:30:00.000Z",
  warnings: [],
};

/** The error `run` throws. */
function thrown(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("nothing was thrown");
}

const plan = (selections: AncillarySelection[]): PlannedExtra[] => planExtras(selections, CATALOGUE);

describe("planExtras", () => {
  it("resolves an option id with the option's segments, quantity, weight and catalogue price", () => {
    expect(plan([{ optionId: BAG.id, travelerId: "1" }])).toEqual([
      expect.objectContaining({
        index: 0,
        ref: "selection:0",
        option: BAG,
        type: "CHECKED_BAGS",
        offerId: OFFER,
        amadeusOfferId: "2",
        travelerId: "1",
        segmentIds: ["3", "4"],
        quantity: 1,
        weight: 23,
        weightUnit: "KG",
        serviceName: null,
        seatNumber: null,
        cataloguePrice: "30.00",
      }),
    ]);
  });

  it("finds the option of an explicit selection by type, quantity and service, on part of an itinerary", () => {
    const extras = plan([
      { type: "CHECKED_BAGS", travelerId: "1", quantity: 2, segmentIds: ["3"] },
      { type: "OTHER_SERVICES", serviceName: "FAST_TRACK", travelerId: "1" },
      { type: "SEATS", travelerId: "1", seatNumber: "12C" },
    ]);
    expect(extras.map((extra) => [extra.option.id, extra.segmentIds, extra.quantity])).toEqual([
      [TWO_BAGS.id, ["3"], 2],
      [FAST_TRACK.id, ["3"], 1],
      [SEAT.id, ["4"], 1],
    ]);
    expect(extras[2]).toMatchObject({ seatNumber: "12C", cataloguePrice: null });
  });

  it("answers 422 ANCILLARY_NOT_AVAILABLE with the selection's index and the reason", () => {
    const cases: Array<[AncillarySelection, string]> = [
      [{ optionId: "anc_01JA4CC3B6E9H2L5N8R1U4X7ZZ", travelerId: "1" }, "unknown_option"],
      [{ optionId: BAG.id, type: "CABIN_BAGS", travelerId: "1" }, "unknown_option"],
      [{ optionId: BAG.id, travelerId: "2" }, "not_bookable_for_traveler"],
      [{ optionId: BAG.id, travelerId: "1", segmentIds: ["9"] }, "not_bookable_for_segment"],
      // PRIORITY_BOARDING is sold for both flights at once only.
      [{ optionId: PRIORITY.id, travelerId: "1", segmentIds: ["3"] }, "not_bookable_for_segment"],
      [{ optionId: BAG.id, travelerId: "1", quantity: 2 }, "quantity_exceeded"],
      [{ type: "CHECKED_BAGS", travelerId: "1", quantity: 3 }, "quantity_exceeded"],
      [{ type: "CHECKED_BAGS", travelerId: "1", weight: 32 }, "unknown_option"],
      [{ type: "OTHER_SERVICES", serviceName: "AIRPORT_CHECKIN", travelerId: "1" }, "unknown_option"],
      [{ type: "CABIN_BAGS", travelerId: "1" }, "unknown_option"],
    ];
    for (const [selection, reason] of cases) {
      const error = thrown(() => plan([{ optionId: BAG.id, travelerId: "1" }, selection]));
      expect([reason, error.code, error.status]).toEqual([reason, "ANCILLARY_NOT_AVAILABLE", 422]);
      expect(error.details).toEqual({ selectionIndex: 1, reason });
    }
  });

  it("answers 400 for a selection without a kind or a field of another kind, and for two of a slot", () => {
    const cases: Array<[AncillarySelection[], string, string]> = [
      [[{ travelerId: "1" }], "/selections/0/type", "required"],
      [[{ type: "OTHER_SERVICES", travelerId: "1" }], "/selections/0/serviceName", "required"],
      [[{ optionId: SEAT.id, travelerId: "1" }], "/selections/0/seatNumber", "required"],
      [[{ optionId: BAG.id, travelerId: "1", seatNumber: "12C" }], "/selections/0/seatNumber", "not_allowed"],
      [[{ optionId: PRIORITY.id, travelerId: "1", weight: 23 }], "/selections/0/weight", "not_allowed"],
      [
        [
          { optionId: BAG.id, travelerId: "1" },
          { optionId: TWO_BAGS.id, travelerId: "1", segmentIds: ["4"] },
        ],
        "/selections/1",
        "duplicate",
      ],
    ];
    for (const [selections, path, code] of cases) {
      const error = thrown(() => plan(selections));
      expect([path, error.code]).toEqual([path, "VALIDATION_FAILED"]);
      expect(error.fieldErrors).toEqual([expect.objectContaining({ path, code })]);
    }
    // Two services on one flight, and bags on different flights, are two slots.
    expect(
      plan([
        { optionId: BAG.id, travelerId: "1", segmentIds: ["3"] },
        { optionId: TWO_BAGS.id, travelerId: "1", segmentIds: ["4"] },
        { optionId: PRIORITY.id, travelerId: "1" },
        { optionId: FAST_TRACK.id, travelerId: "1" },
      ]),
    ).toHaveLength(4);
  });
});

/** The stored (base) Amadeus offer "2": one adult on segments 3 and 4, a seat marker left on segment 4. */
function storedOffer(): { amadeusOfferId: string; payload: Record<string, unknown> } {
  return {
    amadeusOfferId: "2",
    payload: {
      type: "flight-offer",
      id: "2",
      source: "GDS",
      itineraries: [
        {
          duration: "PT5H",
          segments: [
            {
              id: "3",
              departure: { iataCode: "MAD", at: "2027-01-15T07:15:00" },
              arrival: { iataCode: "ORY", at: "2027-01-15T09:20:00" },
              carrierCode: "IB",
              number: "3436",
              duration: "PT2H5M",
              numberOfStops: 0,
            },
            {
              id: "4",
              departure: { iataCode: "ORY", at: "2027-01-15T10:30:00" },
              arrival: { iataCode: "LHR", at: "2027-01-15T11:00:00" },
              carrierCode: "IB",
              number: "7701",
              duration: "PT1H30M",
              numberOfStops: 0,
            },
          ],
        },
      ],
      price: { currency: "EUR", total: "98.47", base: "56.00", grandTotal: "98.47" },
      travelerPricings: [
        {
          travelerId: "1",
          travelerType: "ADULT",
          fareOption: "STANDARD",
          price: { currency: "EUR", total: "98.47", base: "56.00" },
          fareDetailsBySegment: [
            { segmentId: "3", cabin: "ECONOMY", class: "A" },
            { segmentId: "4", cabin: "ECONOMY", class: "A", additionalServices: { chargeableSeat: {} } },
          ],
        },
      ],
    },
  };
}

describe("buildServicesRequest", () => {
  const extras = plan([
    { optionId: BAG.id, travelerId: "1" },
    { optionId: PRIORITY.id, travelerId: "1" },
    { optionId: FAST_TRACK.id, travelerId: "1" },
    { optionId: SEAT.id, travelerId: "1", seatNumber: "12C" },
  ]);

  it("puts exactly the extras into copies of the stored offers' fare details, with the travellers entered", () => {
    const stored = storedOffer();
    const travelers = [{ id: "1", dateOfBirth: "1988-04-12" }];

    const { request, pointers } = buildServicesRequest([stored], extras, travelers, true);

    const details = (
      request.data.flightOffers[0] as { travelerPricings: Array<{ fareDetailsBySegment: unknown[] }> }
    ).travelerPricings[0]?.fareDetailsBySegment;
    expect(details).toEqual([
      {
        segmentId: "3",
        cabin: "ECONOMY",
        class: "A",
        additionalServices: {
          chargeableCheckedBags: { quantity: 1, weight: 23, weightUnit: "KG" },
          otherServices: ["PRIORITY_BOARDING", "FAST_TRACK"],
        },
      },
      {
        segmentId: "4",
        cabin: "ECONOMY",
        class: "A",
        additionalServices: {
          chargeableCheckedBags: { quantity: 1, weight: 23, weightUnit: "KG" },
          otherServices: ["PRIORITY_BOARDING"],
          chargeableSeat: { number: "12C" },
        },
      },
    ]);
    expect(request.data).toMatchObject({
      type: "flight-offers-pricing",
      travelers,
      additionalInformation: { fareRules: true },
    });
    expect([...pointers]).toEqual([
      ["/data/flightOffers/0/travelerPricings/0/fareDetailsBySegment/0", [0, 1, 2]],
      ["/data/flightOffers/0/travelerPricings/0/fareDetailsBySegment/1", [0, 1, 3]],
    ]);
    // The stored offer is left as it was.
    expect(stored).toEqual(storedOffer());
  });

  it("drops the stored offers' own additionalServices without extras, and leaves travellers out when none", () => {
    const { request } = buildServicesRequest([storedOffer()], [], [], false);
    expect(JSON.stringify(request)).not.toContain("additionalServices");
    expect(request.data).not.toHaveProperty("travelers");
  });

  it("answers 422 for an extra of a segment the stored offer does not fly", () => {
    const [bag] = plan([{ optionId: BAG.id, travelerId: "1" }]);
    const short = storedOffer();
    const pricing = (short.payload["travelerPricings"] as Array<{ fareDetailsBySegment: unknown[] }>)[0];
    pricing?.fareDetailsBySegment.pop();
    const error = thrown(() => buildServicesRequest([short], bag === undefined ? [] : [bag], [], true));
    expect(error.details).toEqual({ selectionIndex: 0, reason: "not_bookable_for_segment" });
  });
});

describe("travelersOf", () => {
  it("sends what was entered: the name when complete, the date of birth and the gender", () => {
    const travelers = [
      {
        travelerId: "1",
        name: { firstName: "TESTA", lastName: "SAMPLE" },
        dateOfBirth: "1988-04-12",
        gender: "FEMALE",
      },
      { travelerId: "2", name: { firstName: "TESTB" }, dateOfBirth: null, gender: null },
      { travelerId: "3", name: null, dateOfBirth: "2019-02-01", gender: null },
    ] as unknown as Parameters<typeof travelersOf>[0];
    expect(travelersOf(travelers)).toEqual([
      {
        id: "1",
        name: { firstName: "TESTA", lastName: "SAMPLE" },
        dateOfBirth: "1988-04-12",
        gender: "FEMALE",
      },
      { id: "3", dateOfBirth: "2019-02-01" },
    ]);
  });
});

/** A confirmed offer "2" whose `grandTotal` holds `services` on top of the 98.47 of the flights. */
function confirmedWith(services: Array<{ type: string; amount: string }>, grandTotal: string) {
  const payload = {
    ...storedOffer().payload,
    price: { currency: "EUR", total: "98.47", base: "56.00", grandTotal, additionalServices: services },
  };
  return { amadeusOfferId: "2", payload };
}

describe("extraNets", () => {
  const extras = plan([
    { optionId: BAG.id, travelerId: "1", segmentIds: ["3"] },
    { optionId: TWO_BAGS.id, travelerId: "1", segmentIds: ["4"] },
    { optionId: PRIORITY.id, travelerId: "1" },
    { optionId: SEAT.id, travelerId: "1", seatNumber: "12C" },
  ]);

  it("takes the catalogue prices where Amadeus states no amount (a seat has none: 0)", () => {
    expect(extraNets(extras, [confirmedWith([], "98.47")], 2)).toEqual(["30.00", "65.00", "9.00", "0.00"]);
  });

  it("shares Amadeus's amount of a kind over its extras by their catalogue prices, to the cent", () => {
    const confirmed = confirmedWith(
      [
        { type: "CHECKED_BAGS", amount: "100.00" },
        { type: "SEATS", amount: "15.00" },
      ],
      "213.47",
    );
    const nets = extraNets(extras, [confirmed], 2);
    expect(nets).toEqual(["31.58", "68.42", "9.00", "15.00"]);
    expect(Number(nets[0]) * 100 + Number(nets[1]) * 100).toBe(10_000);
  });

  it("answers 502 when Amadeus charges a kind no extra of the offer has", () => {
    const [bag] = extras;
    const confirmed = confirmedWith([{ type: "MEALS", amount: "7.00" }], "105.47");
    const error = thrown(() => extraNets(bag === undefined ? [] : [bag], [confirmed], 2));
    expect([error.code, error.status]).toEqual(["SUPPLIER_ERROR", 502]);
    // A kind it states at zero is no charge.
    expect(
      extraNets(
        bag === undefined ? [] : [bag],
        [confirmedWith([{ type: "MEALS", amount: "0.00" }], "98.47")],
        2,
      ),
    ).toEqual(["30.00"]);
  });
});

describe("flightNetOf and additionalServiceAmounts", () => {
  it("reads the flights' net as grandTotal minus the extras, summed by kind", () => {
    const confirmed = confirmedWith(
      [
        { type: "CHECKED_BAGS", amount: "30.00" },
        { type: "CHECKED_BAGS", amount: "65.00" },
        { type: "OTHER_SERVICES", amount: "9.00" },
      ],
      "202.47",
    );
    const parsed = parseOffer(confirmed.payload);
    if (parsed === undefined) {
      throw new Error("the test offer cannot be parsed");
    }
    expect(
      Object.fromEntries([...additionalServiceAmounts(confirmed.payload)].map(([k, v]) => [k, v.toFixed(2)])),
    ).toEqual({ CHECKED_BAGS: "95.00", OTHER_SERVICES: "9.00" });
    expect(flightNetOf({ payload: confirmed.payload, parsed }, 2)).toBe("98.47");
    // An answer whose extras exceed its grandTotal cannot be priced.
    expect(
      flightNetOf(
        {
          payload: confirmed.payload,
          parsed: { ...parsed, price: { ...parsed.price, grandTotal: "50.00" } },
        },
        2,
      ),
    ).toBeUndefined();
  });
});

const INPUT: PricingInput = {
  at: new Date("2026-10-20T08:00:00Z"),
  currency: "EUR",
  minorUnits: 2,
  netTotal: "98.47",
  origin: "MAD",
  destination: "ORY",
  originCountry: "ES",
  destinationCountry: "FR",
  validatingCarriers: ["IB"],
  marketingCarriers: ["IB"],
  cabins: ["ECONOMY"],
  travelers: { ADULT: 1 },
  segmentCount: 2,
  tripType: "one_way",
  source: "GDS",
  channel: "storefront",
};

const FEE_RULE: FeeRule = {
  id: "fee_01JA4CC3B6E9H2L5N8R1U4X7A0",
  name: "Extras",
  label: "Extras service fee",
  feeType: "ancillary_service",
  scope: {},
  calculation: "percentage_plus_fixed",
  percentage: "10",
  fixedAmount: "1.00",
  fixedCurrency: "EUR",
  appliesPer: "segment",
  minAmount: null,
  maxAmount: null,
  refundable: false,
  priority: 100,
  isActive: true,
  activeFrom: null,
  activeUntil: null,
};

describe("ancillaryRows and checkoutTotalOf", () => {
  it("sells each extra at its net plus its ancillary_service fee lines, and total = offer + ancillaries + fees [OBE-037 AC1]", () => {
    const extras = plan([
      { optionId: BAG.id, travelerId: "1" },
      { optionId: FAST_TRACK.id, travelerId: "1" },
    ]);
    const nets = ["30.00", "12.00"];
    // The engine's step `pricing` with the extras: 10 % of each net plus 1.00 per segment it covers.
    const fees = priceOffer(INPUT, [], [FEE_RULE], {
      kind: "pricing",
      extras: extras.map((extra, position) => ({
        ref: extra.ref,
        amount: nets[position] ?? "0",
        travelers: 1,
        segments: extra.segmentIds.length,
      })),
    });
    const feeLines: FeeLine[] = fees.feeLines.filter((line) => line.extraRef !== null);
    expect(feeLines.map((line) => [line.extraRef, line.amount])).toEqual([
      ["selection:0", "5.00"],
      ["selection:1", "2.20"],
    ]);
    let next = 0;

    const { rows, total } = ancillaryRows({
      checkoutId: "chk_01JA4CC3B6E9H2L5N8R1U4X7A0",
      currency: "EUR",
      minorUnits: 2,
      extras,
      nets,
      feeLines,
      travelerRowIds: new Map([["1", "ctr_01JA4CC3B6E9H2L5N8R1U4X7A0"]]),
      now: new Date("2026-10-20T08:00:00Z"),
      newId: () => `can_01JA4CC3B6E9H2L5N8R1U4X7A${String((next += 1))}`,
    });

    expect(total).toBe("49.20");
    expect(rows).toEqual([
      expect.objectContaining({
        id: "can_01JA4CC3B6E9H2L5N8R1U4X7A1",
        checkout_traveler_id: "ctr_01JA4CC3B6E9H2L5N8R1U4X7A0",
        segment_id: "3",
        type: "CHECKED_BAGS",
        service_code: "1",
        quantity: 1,
        weight: 23,
        weight_unit: "KG",
        seat_number: null,
        currency: "EUR",
        net_amount: "30.00",
        price_amount: "35.00",
        created_at: new Date("2026-10-20T08:00:00.000Z"),
      }),
      expect.objectContaining({
        segment_id: "3",
        type: "OTHER_SERVICES",
        service_code: "FAST_TRACK",
        net_amount: "12.00",
        price_amount: "14.20",
        created_at: new Date("2026-10-20T08:00:00.001Z"),
      }),
    ]);
    expect(JSON.parse(String(rows[0]?.details))).toMatchObject({
      optionId: BAG.id,
      label: BAG.label,
      travelerId: "1",
      segmentIds: ["3", "4"],
      offerId: OFFER,
      feeLines: [expect.objectContaining({ extraRef: "selection:0", amount: "5.00" })],
    });
    // The checkout's total: the flights, the extras and the card fee (none yet).
    expect(checkoutTotalOf("98.47", total, "0.00", 2)).toBe("147.67");
    expect(checkoutTotalOf("98.47", total, "3.10", 2)).toBe("150.77");
  });
});

describe("servicesErrorOf and selectionOfPointer", () => {
  const extras = plan([
    { optionId: BAG.id, travelerId: "1" },
    { optionId: SEAT.id, travelerId: "1", seatNumber: "12C" },
  ]);
  const { pointers } = buildServicesRequest([storedOffer()], extras, [], true);
  const amadeus400 = (issues: AmadeusIssue[]) =>
    mapAmadeusError("quoteAirOffers", { kind: "http", status: 400, issues });
  const detail = "/data/flightOffers/0/travelerPricings/0/fareDetailsBySegment";

  it("finds the selection of an Amadeus pointer, in either notation", () => {
    expect(selectionOfPointer(`${detail}/1/additionalServices/chargeableSeat/number`, pointers, extras)).toBe(
      1,
    );
    expect(
      selectionOfPointer(
        "/data/flightOffers[0]/travelerPricings[0]/fareDetailsBySegment[1]",
        pointers,
        extras,
      ),
    ).toBe(0);
    expect(selectionOfPointer(`${detail}/0/additionalServices/chargeableCheckedBags`, pointers, extras)).toBe(
      0,
    );
    expect(selectionOfPointer("/data/travelers/0", pointers, extras)).toBeUndefined();
    expect(selectionOfPointer(undefined, pointers, extras)).toBeUndefined();
  });

  it("answers 422 ANCILLARY_NOT_AVAILABLE for a rejected selection, with the seat of a seat", () => {
    const bag = servicesErrorOf(
      amadeus400([
        {
          code: 4926,
          title: "INVALID DATA RECEIVED",
          source: { pointer: `${detail}/0/additionalServices/chargeableCheckedBags` },
        },
      ]),
      pointers,
      extras,
    ) as AppError;
    expect([bag.code, bag.status, bag.details]).toEqual([
      "ANCILLARY_NOT_AVAILABLE",
      422,
      { selectionIndex: 0, reason: "rejected_by_airline" },
    ]);
    expect(bag.supplier).toMatchObject({ provider: "amadeus", code: 4926 });

    const seat = servicesErrorOf(
      amadeus400([
        {
          code: 32171,
          title: "MANDATORY DATA MISSING",
          source: { pointer: `${detail}/1/additionalServices/chargeableSeat` },
        },
      ]),
      pointers,
      extras,
    ) as AppError;
    expect(seat.details).toEqual({
      selectionIndex: 1,
      reason: "seat_unavailable",
      seatNumber: "12C",
      segmentId: "4",
    });

    const anywhere = servicesErrorOf(
      amadeus400([{ code: 4926, title: "INVALID DATA RECEIVED" }]),
      pointers,
      extras,
    ) as AppError;
    expect([anywhere.code, anywhere.details]).toEqual([
      "ANCILLARY_NOT_AVAILABLE",
      { reason: "rejected_by_airline" },
    ]);
  });

  it("keeps the operation's supplier codes and answers 502 SUPPLIER_ERROR for anything else", () => {
    const soldOut = amadeus400([{ code: 34651, title: "SEGMENT SELL FAILURE" }]);
    expect(servicesErrorOf(soldOut, pointers, extras)).toBe(soldOut);
    const timeout = mapAmadeusError("quoteAirOffers", { kind: "timeout" });
    expect(servicesErrorOf(timeout, pointers, extras)).toBe(timeout);
    for (const failure of [
      // Traveller data Amadeus refused is no extra's fault; the operation has no TRAVELER_DATA_INVALID.
      amadeus400([
        { code: 4926, title: "INVALID DATA RECEIVED", source: { pointer: "/data/travelers/0/dateOfBirth" } },
      ]),
      amadeus400([{ code: 477, title: "INVALID FORMAT" }]),
      mapAmadeusError("quoteAirOffers", { kind: "http", status: 409, issues: [{ code: 2552 }] }),
    ]) {
      const mapped = servicesErrorOf(failure, pointers, extras) as AppError;
      expect([mapped.code, mapped.status]).toEqual(["SUPPLIER_ERROR", 502]);
    }
    // Without extras a rejection is the supplier's; errors that are no AppError pass as they are.
    expect((servicesErrorOf(amadeus400([{ code: 4926 }]), new Map(), []) as AppError).code).toBe(
      "SUPPLIER_ERROR",
    );
    const bug = new TypeError("bug");
    expect(servicesErrorOf(bug, pointers, extras)).toBe(bug);
  });
});

describe("the extras of a checkout at checkout.complete's re-pricing (FIX-W22)", () => {
  const extras = plan([
    { optionId: BAG.id, travelerId: "1" },
    { optionId: FAST_TRACK.id, travelerId: "1" },
    { optionId: SEAT.id, travelerId: "1", seatNumber: "12C" },
  ]);
  const nets = ["30.00", "12.00", "8.00"];

  /** The rows `ancillaryRows` writes for `extras`, as CheckoutRepository reads them back. */
  function storedRows(): CheckoutAncillaryRow[] {
    let next = 0;
    const { rows } = ancillaryRows({
      checkoutId: "chk_01JA4CC3B6E9H2L5N8R1U4X7A0",
      currency: "EUR",
      minorUnits: 2,
      extras,
      nets,
      feeLines: [],
      travelerRowIds: new Map([["1", "ctr_01JA4CC3B6E9H2L5N8R1U4X7A0"]]),
      now: new Date("2026-10-20T08:00:00Z"),
      newId: () => `can_01JA4CC3B6E9H2L5N8R1U4X7A${String((next += 1))}`,
    });
    return rows.map((row) => ({
      id: String(row.id),
      checkoutTravelerId: row.checkout_traveler_id ?? null,
      segmentId: row.segment_id ?? null,
      type: String(row.type),
      serviceCode: row.service_code ?? null,
      quantity: Number(row.quantity),
      weight: row.weight ?? null,
      weightUnit: row.weight_unit ?? null,
      seatNumber: row.seat_number ?? null,
      currency: "EUR",
      priceAmount: String(row.price_amount),
      netAmount: String(row.net_amount),
      details: JSON.parse(String(row.details)) as unknown,
    }));
  }

  it("[FIX-W22 AC1] reads the stored extras back as the same additional services, the stored net as their share", () => {
    const stored = storedExtrasOf(storedRows(), [{ offerId: OFFER, amadeusOfferId: "2" }]);

    expect(stored).toEqual(
      extras.map((extra, index) => ({
        index: extra.index,
        ref: extra.ref,
        type: extra.type,
        amadeusOfferId: extra.amadeusOfferId,
        travelerId: extra.travelerId,
        segmentIds: extra.segmentIds,
        quantity: extra.quantity,
        weight: extra.weight,
        weightUnit: extra.weightUnit,
        serviceName: extra.serviceName,
        seatNumber: extra.seatNumber,
        cataloguePrice: nets[index],
      })),
    );
    // The same Flight Offers Price request as checkout.setAncillaries sent.
    expect(buildServicesRequest([storedOffer()], stored ?? [], [], true).request).toEqual(
      buildServicesRequest([storedOffer()], extras, [], true).request,
    );
    expect(pricingExtrasOf(stored ?? [], nets)).toEqual([
      { ref: "selection:0", amount: "30.00", travelers: 1, segments: 2 },
      { ref: "selection:1", amount: "12.00", travelers: 1, segments: 1 },
      { ref: "selection:2", amount: "8.00", travelers: 1, segments: 1 },
    ]);
  });

  it("[FIX-W22 AC1] cannot read back an extra without its offer, traveller, segments, service or seat", () => {
    const offers = [{ offerId: OFFER, amadeusOfferId: "2" }];
    const [bag, service, seat] = storedRows();
    if (bag === undefined || service === undefined || seat === undefined) {
      throw new Error("three rows were written");
    }
    expect(storedExtrasOf([bag], [{ offerId: "off_other", amadeusOfferId: "9" }])).toBeUndefined();
    expect(
      storedExtrasOf([{ ...bag, details: { ...(bag.details as object), travelerId: 1 } }], offers),
    ).toBeUndefined();
    expect(storedExtrasOf([{ ...bag, details: {}, segmentId: null }], offers)).toBeUndefined();
    expect(storedExtrasOf([{ ...service, serviceCode: null }], offers)).toBeUndefined();
    expect(storedExtrasOf([{ ...seat, seatNumber: null }], offers)).toBeUndefined();
    expect(storedExtrasOf([{ ...bag, type: "LOUNGE" }], offers)).toBeUndefined();
    expect(storedExtrasOf([], offers)).toEqual([]);
  });

  it("[FIX-W22 AC1] finds the extras an answer no longer carries on one of their segments", () => {
    const { request } = buildServicesRequest([storedOffer()], extras, [], true);
    const echoed = { amadeusOfferId: "2", payload: request.data.flightOffers[0] };
    expect(extrasMissingFrom(extras, [echoed])).toEqual([]);

    const answered = structuredClone(echoed);
    const details = (
      answered.payload as {
        travelerPricings: Array<{ fareDetailsBySegment: Array<Record<string, unknown>> }>;
      }
    ).travelerPricings[0]?.fareDetailsBySegment;
    // Segment 4 lost the bag and the seat; segment 3 lost FAST_TRACK.
    if (details?.[0] === undefined || details[1] === undefined) {
      throw new Error("the fixture flies two segments");
    }
    details[0]["additionalServices"] = { chargeableCheckedBags: { quantity: 1 }, otherServices: [] };
    details[1]["additionalServices"] = { otherServices: ["PRIORITY_BOARDING"] };
    expect(extrasMissingFrom(extras, [answered]).map((extra) => extra.ref)).toEqual([
      "selection:0",
      "selection:1",
      "selection:2",
    ]);
    // A seat Amadeus echoes by number counts, an answer without the offer carries nothing.
    details[1]["additionalServices"] = {
      chargeableCheckedBags: { quantity: 1 },
      chargeableSeatNumber: "12C",
    };
    expect(extrasMissingFrom(extras, [answered]).map((extra) => extra.ref)).toEqual(["selection:1"]);
    expect(extrasMissingFrom(extras, [])).toHaveLength(3);
  });
});
