// Unit tests of the result filters, facets, best score, highlights and cursors (OBE-021; facets.ts).
import { beforeAll, describe, expect, it } from "vitest";
import { Money, type MoneyValue } from "../pricing/pricing.types";
import {
  bestScores,
  computeFacets,
  decodeCursor,
  emptyFacets,
  encodeCursor,
  formatMinutes,
  highlightsOf,
  inWindow,
  matchesFilters,
  parseResultFilters,
  parseWindow,
  resultFingerprint,
  tagsOf,
  type FacetOptions,
  type FacetRow,
  type Facets,
  type FilterExclusion,
  type FilterGroup,
  type ResultFilters,
} from "./facets";

/** A row with defaults: one non-stop itinerary departing 08:00, arriving 10:00, 120 minutes, economy. */
function row(id: string, overrides: Partial<FacetRow> = {}): FacetRow {
  return {
    id,
    sellingTotal: "100.00",
    maxStops: 0,
    marketingCarriers: ["AF"],
    departureMinutes: [480],
    arrivalMinutes: [600],
    durationMinutes: [120],
    totalDurationMinutes: 120,
    mainCabin: "ECONOMY",
    minCheckedBags: 0,
    refundable: null,
    changeable: null,
    brandedFares: [],
    ...overrides,
  };
}

const OPTIONS: FacetOptions = {
  money: (amount) => ({ amount: new Money(amount).toFixed(2), currency: "EUR" }),
  carrierLabel: (code) => ({ AF: "Air France", KL: "KLM" })[code] ?? null,
  brandedFareLabel: (code) => (code === "LIGHT" ? "ECONOMY LIGHT" : null),
};

const ids = (rows: readonly FacetRow[], filters: ResultFilters): string[] =>
  rows.filter((candidate) => matchesFilters(candidate, filters)).map((candidate) => candidate.id);

describe("time windows", () => {
  it("parses {itinerary}:{HH:MM}-{HH:MM} into minutes and refuses anything else", () => {
    expect(parseWindow("0:06:00-11:59")).toEqual({ itineraryIndex: 0, from: 360, to: 719 });
    expect(parseWindow("1:22:00-05:59")).toEqual({ itineraryIndex: 1, from: 1320, to: 359 });
    expect(parseWindow("6:06:00-11:59")).toBeUndefined();
    expect(parseWindow("0:24:00-11:59")).toBeUndefined();
    expect(parseWindow("0:6:00-11:59")).toBeUndefined();
  });

  it("includes both ends and wraps midnight when the end is before the start", () => {
    expect(inWindow(360, { from: 360, to: 719 })).toBe(true);
    expect(inWindow(719, { from: 360, to: 719 })).toBe(true);
    expect(inWindow(720, { from: 360, to: 719 })).toBe(false);
    expect(inWindow(1400, { from: 1320, to: 359 })).toBe(true);
    expect(inWindow(30, { from: 1320, to: 359 })).toBe(true);
    expect(inWindow(400, { from: 1320, to: 359 })).toBe(false);
    expect(formatMinutes(0)).toBe("00:00");
    expect(formatMinutes(1439)).toBe("23:59");
  });
});

describe("matchesFilters", () => {
  const rows = [
    row("off_a", { maxStops: 0, marketingCarriers: ["AF"], sellingTotal: "100.00" }),
    row("off_b", { maxStops: 1, marketingCarriers: ["AF", "KL"], sellingTotal: "150.00" }),
    row("off_c", { maxStops: 2, marketingCarriers: ["KL"], sellingTotal: "200.00" }),
    row("off_d", { maxStops: 3, marketingCarriers: ["LH"], sellingTotal: "250.00" }),
  ];

  it("reads stops 2 as two or more", () => {
    expect(ids(rows, { stops: [0] })).toEqual(["off_a"]);
    expect(ids(rows, { stops: [2] })).toEqual(["off_c", "off_d"]);
    expect(ids(rows, { stops: [0, 1] })).toEqual(["off_a", "off_b"]);
  });

  it("keeps offers whose every marketing carrier is listed", () => {
    expect(ids(rows, { carriers: ["AF"] })).toEqual(["off_a"]);
    expect(ids(rows, { carriers: ["AF", "KL"] })).toEqual(["off_a", "off_b", "off_c"]);
  });

  it("applies the price bounds inclusively, as decimals", () => {
    expect(ids(rows, { minPrice: "150", maxPrice: "200.00" })).toEqual(["off_b", "off_c"]);
    expect(ids(rows, { maxPrice: "99.99" })).toEqual([]);
  });

  it("ORs the windows of one itinerary and ANDs the itineraries; a missing itinerary does not match", () => {
    const trips = [
      row("off_morning_evening", { departureMinutes: [420, 1140], arrivalMinutes: [540, 1260] }),
      row("off_evening_evening", { departureMinutes: [1150, 1150], arrivalMinutes: [1260, 1260] }),
      row("off_morning_morning", { departureMinutes: [420, 420], arrivalMinutes: [540, 540] }),
      row("off_one_way", { departureMinutes: [420], arrivalMinutes: [540] }),
    ];
    const filters = parseResultFilters({
      departureWindow: ["0:06:00-11:59", "0:18:00-23:59", "1:18:00-23:59"],
    });
    expect(ids(trips, filters)).toEqual(["off_morning_evening", "off_evening_evening"]);
    expect(ids(trips, parseResultFilters({ arrivalWindow: ["1:08:00-10:00"] }))).toEqual([
      "off_morning_morning",
    ]);
  });

  it("needs every itinerary within the duration limit", () => {
    const trips = [
      row("off_short", { durationMinutes: [100, 110] }),
      row("off_long_return", { durationMinutes: [100, 200] }),
    ];
    expect(ids(trips, { maxDurationMinutes: 120 })).toEqual(["off_short"]);
  });

  it("excludes unknown conditions and bags whenever their filter is set", () => {
    const offers = [
      row("off_yes", { refundable: true, changeable: true, minCheckedBags: 2 }),
      row("off_no", { refundable: false, changeable: false, minCheckedBags: 0 }),
      row("off_unknown", { refundable: null, changeable: null, minCheckedBags: null }),
    ];
    expect(ids(offers, { refundable: true })).toEqual(["off_yes"]);
    expect(ids(offers, { refundable: false })).toEqual(["off_no"]);
    expect(ids(offers, { changeable: false })).toEqual(["off_no"]);
    expect(ids(offers, { minIncludedCheckedBags: 0 })).toEqual(["off_yes", "off_no"]);
    expect(ids(offers, { minIncludedCheckedBags: 1 })).toEqual(["off_yes"]);
  });

  it("matches cabins on the main cabin and branded fares on any itinerary", () => {
    const offers = [
      row("off_business", { mainCabin: "BUSINESS", brandedFares: ["BIZ"] }),
      row("off_light", { mainCabin: "ECONOMY", brandedFares: ["LIGHT", "STANDARD"] }),
      row("off_none", { mainCabin: null }),
    ];
    expect(ids(offers, { cabins: ["BUSINESS", "FIRST"] })).toEqual(["off_business"]);
    expect(ids(offers, { brandedFares: ["STANDARD"] })).toEqual(["off_light"]);
  });
});

describe("computeFacets", () => {
  const rows = [
    row("off_1", {
      sellingTotal: "120.00",
      marketingCarriers: ["AF"],
      maxStops: 0,
      departureMinutes: [400],
      durationMinutes: [130],
      brandedFares: ["LIGHT"],
    }),
    row("off_2", {
      sellingTotal: "90.00",
      marketingCarriers: ["KL"],
      maxStops: 1,
      departureMinutes: [800],
      durationMinutes: [200],
      minCheckedBags: 1,
    }),
    row("off_3", {
      sellingTotal: "300.00",
      marketingCarriers: ["AF"],
      maxStops: 0,
      departureMinutes: [1200],
      mainCabin: "BUSINESS",
      minCheckedBags: 2,
      refundable: true,
    }),
  ];

  it("counts each group without its own filter, and every other filter (disjunctive faceting)", () => {
    const facets = computeFacets(rows, { carriers: ["AF"], stops: [0] }, OPTIONS);

    expect(facets.total).toBe(2);
    // carriers ignore the carriers filter, apply the stops filter: KL's only offer has a stop.
    expect(facets.carriers).toEqual([
      { value: "AF", label: "Air France", count: 2, minPrice: { amount: "120.00", currency: "EUR" } },
      { value: "KL", label: "KLM", count: 0, minPrice: null },
    ]);
    // stops ignore the stops filter, apply the carriers filter.
    expect(facets.stops).toEqual([
      { value: "0", label: "Non-stop", count: 2, minPrice: { amount: "120.00", currency: "EUR" } },
      { value: "1", label: "1 stop", count: 0, minPrice: null },
    ]);
    expect(facets.price).toEqual({
      min: { amount: "120.00", currency: "EUR" },
      max: { amount: "300.00", currency: "EUR" },
    });
  });

  it("gives every itinerary four time bands that ignore that itinerary's windows only", () => {
    const filters = parseResultFilters({ departureWindow: ["0:06:00-11:59"] });
    const facets = computeFacets(rows, filters, OPTIONS);

    expect(facets.total).toBe(1);
    expect(facets.departureTimes?.map((band) => [band.band, band.from, band.to, band.count])).toEqual([
      ["early_morning", "00:00", "05:59", 0],
      ["morning", "06:00", "11:59", 1],
      ["afternoon", "12:00", "17:59", 1],
      ["evening", "18:00", "23:59", 1],
    ]);
    // The arrival bands apply the departure windows.
    expect(facets.arrivalTimes?.reduce((sum, band) => sum + band.count, 0)).toBe(1);
  });

  it("lists cabins, bags, conditions, branded fares and durations of the search", () => {
    const facets = computeFacets(rows, {}, OPTIONS);

    expect(facets.cabins?.map((bucket) => [bucket.value, bucket.label, bucket.count])).toEqual([
      ["ECONOMY", "Economy", 2],
      ["BUSINESS", "Business", 1],
    ]);
    expect(facets.includedCheckedBags?.map((bucket) => [bucket.value, bucket.count])).toEqual([
      ["0", 1],
      ["1", 1],
      ["2", 1],
    ]);
    expect(facets.refundable?.map((bucket) => [bucket.value, bucket.count])).toEqual([
      ["true", 1],
      ["unknown", 2],
    ]);
    expect(facets.brandedFares).toEqual([
      { value: "LIGHT", label: "ECONOMY LIGHT", count: 1, minPrice: { amount: "120.00", currency: "EUR" } },
    ]);
    expect(facets.durations).toEqual([{ itineraryIndex: 0, minMinutes: 120, maxMinutes: 200 }]);
  });

  it("is empty for a search without offers", () => {
    expect(computeFacets([], {}, OPTIONS)).toEqual(emptyFacets());
  });
});

describe("bestScores and highlights", () => {
  const rows = [
    row("off_cheap_slow", { sellingTotal: "100.00", totalDurationMinutes: 600, maxStops: 2 }),
    row("off_mid", { sellingTotal: "150.00", totalDurationMinutes: 300, maxStops: 1 }),
    row("off_dear_fast", { sellingTotal: "200.00", totalDurationMinutes: 200, maxStops: 0 }),
  ];

  it("weights price 60 %, duration 30 % and stops 10 % over the search, 4 decimals, lower is better", () => {
    const scores = bestScores(rows);

    // cheap: 0.6 × 0 + 0.3 × 1 + 0.1 × 1; mid: 0.6 × 0.5 + 0.3 × 0.25 + 0.1 × 0.5; dear: 0.6 × 1.
    expect(Object.fromEntries(scores)).toEqual({
      off_cheap_slow: "0.4000",
      off_mid: "0.4250",
      off_dear_fast: "0.6000",
    });
    expect(Object.fromEntries(bestScores([row("off_only")]))).toEqual({ off_only: "0.0000" });
  });

  it("picks the cheapest, fastest and best offer, ties by price then id", () => {
    const scores = bestScores(rows);
    const scored = rows.map((candidate) => ({ ...candidate, bestScore: scores.get(candidate.id) ?? "1" }));
    const highlights = highlightsOf(scored, (amount) => ({ amount, currency: "EUR" }));

    expect(highlights).toEqual({
      cheapest: {
        offerId: "off_cheap_slow",
        price: { amount: "100.00", currency: "EUR" },
        durationMinutes: 600,
      },
      fastest: {
        offerId: "off_dear_fast",
        price: { amount: "200.00", currency: "EUR" },
        durationMinutes: 200,
      },
      best: { offerId: "off_cheap_slow", price: { amount: "100.00", currency: "EUR" }, durationMinutes: 600 },
    });
    expect(tagsOf("off_cheap_slow", highlights)).toEqual(["cheapest", "best"]);
    expect(tagsOf("off_mid", highlights)).toEqual([]);
    expect(highlightsOf([], (amount) => ({ amount, currency: "EUR" }))).toEqual({
      cheapest: null,
      fastest: null,
      best: null,
    });

    const tie = [
      { ...row("off_b", { sellingTotal: "100.00" }), bestScore: "0.1000" },
      { ...row("off_a", { sellingTotal: "100.00" }), bestScore: "0.1000" },
    ];
    expect(highlightsOf(tie, (amount) => ({ amount, currency: "EUR" })).cheapest?.offerId).toBe("off_a");
  });
});

describe("cursors", () => {
  const SEARCH = "srch_01JA4C8Q0D5N7R2T6V9X3Z1B4F";

  it("round-trips the fingerprint, the sort keys and the id", () => {
    const cursor = { fingerprint: "abc", keys: ["0.4250", "150.00"], id: "off_01JA4C8Q2H6K9M3P5S8U1W4Y7A" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("refuses anything this API did not write", () => {
    expect(decodeCursor("not-base64-json")).toBeUndefined();
    expect(
      decodeCursor(
        Buffer.from(JSON.stringify([2, "abc", [], "off_01JA4C8Q2H6K9M3P5S8U1W4Y7A"])).toString("base64url"),
      ),
    ).toBeUndefined();
    expect(
      decodeCursor(Buffer.from(JSON.stringify([1, "abc", [], "srch_x"])).toString("base64url")),
    ).toBeUndefined();
    expect(
      decodeCursor(
        Buffer.from(JSON.stringify([1, "abc", [{}], "off_01JA4C8Q2H6K9M3P5S8U1W4Y7A"])).toString("base64url"),
      ),
    ).toBeUndefined();
  });

  it("fingerprints equal filters equally, whatever their order, and tells sorts and searches apart", () => {
    const a = parseResultFilters({ carriers: ["KL", "AF", "AF"], stops: [1, 0] });
    const b = parseResultFilters({ stops: [0, 1], carriers: ["AF", "KL"] });
    expect(resultFingerprint(SEARCH, a, "price")).toBe(resultFingerprint(SEARCH, b, "price"));
    expect(resultFingerprint(SEARCH, a, "price")).not.toBe(resultFingerprint(SEARCH, a, "best"));
    expect(resultFingerprint(SEARCH, a, "price")).not.toBe(
      resultFingerprint("srch_01JA4C8Q0D5N7R2T6V9X3Z1B4G", a, "price"),
    );
    expect(resultFingerprint(SEARCH, a, "price")).not.toBe(
      resultFingerprint(SEARCH, parseResultFilters({ carriers: ["AF"] }), "price"),
    );
  });
});

// ---- OBE-092: one parse and one filter check per row ------------------------------------------------------------------

/** A deterministic pseudo-random sequence (a linear congruential generator), so the rows are the same on every run. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** `count` rows of a round trip with repeated prices, durations and carriers, as the offers of one search. */
function generatedRows(count: number): FacetRow[] {
  const next = sequence(92);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  return Array.from({ length: count }, (_, index) => {
    const durations = [pick([95, 120, 185, 240, 330]), pick([100, 125, 190, 250, 400])];
    return row(`off_${String(index).padStart(4, "0")}`, {
      sellingTotal: pick(["89.90", "120.00", "120.0", "154.35", "199.99", "260.10", "310.00", "455.45"]),
      maxStops: pick([0, 0, 1, 2, 3]),
      marketingCarriers: pick([["AF"], ["KL"], ["AF", "KL"], ["LH"], ["AF", "LH"]]),
      departureMinutes: [pick([300, 420, 700, 900, 1250]), pick([30, 480, 760, 1100, 1300])],
      arrivalMinutes: [pick([400, 560, 800, 1000, 1380]), pick([90, 600, 860, 1200, 1430])],
      durationMinutes: durations,
      totalDurationMinutes: (durations[0] ?? 0) + (durations[1] ?? 0),
      mainCabin: pick(["ECONOMY", "ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", null]),
      minCheckedBags: pick([0, 1, 2, 4, null]),
      refundable: pick([true, false, null]),
      changeable: pick([true, false, null]),
      brandedFares: pick([[], ["LIGHT"], ["LIGHT", "FLEX"], ["FLEX"]]),
    });
  });
}

/** The facets of `rows` counted one group at a time with `matchesFilters`, every amount parsed where it is compared. */
function referenceFacets(rows: readonly FacetRow[], filters: ResultFilters) {
  const within = (exclusion: Parameters<typeof matchesFilters>[2]): FacetRow[] =>
    rows.filter((candidate) => matchesFilters(candidate, filters, exclusion));
  const bucket = (
    value: string,
    groupRows: readonly FacetRow[],
    predicate: (candidate: FacetRow) => boolean,
  ) => {
    const matching = groupRows.filter(predicate);
    const min = matching.reduce<MoneyValue | null>((lowest, candidate) => {
      const selling = new Money(candidate.sellingTotal);
      return lowest === null || selling.lt(lowest) ? selling : lowest;
    }, null);
    return { value, count: matching.length, minPrice: min === null ? null : OPTIONS.money(min.toString()) };
  };
  const priceRows = within({ group: "price" }).map((candidate) => new Money(candidate.sellingTotal));
  const lowest = priceRows.reduce<MoneyValue | null>(
    (low, value) => (low === null || value.lt(low) ? value : low),
    null,
  );
  const highest = priceRows.reduce<MoneyValue | null>(
    (high, value) => (high === null || value.gt(high) ? value : high),
    null,
  );
  const carriers = [...new Set(rows.flatMap((candidate) => candidate.marketingCarriers))].sort();
  const brands = [...new Set(rows.flatMap((candidate) => candidate.brandedFares))].sort();
  const bands = [
    [0, 359],
    [360, 719],
    [720, 1079],
    [1080, 1439],
  ] as const;
  const times = (kind: "departure" | "arrival") =>
    [0, 1].flatMap((index) =>
      bands.map(([from, to]) => {
        const groupRows = within(
          kind === "departure" ? { departureItinerary: index } : { arrivalItinerary: index },
        );
        const minutesOf = (candidate: FacetRow): number | undefined =>
          (kind === "departure" ? candidate.departureMinutes : candidate.arrivalMinutes)[index];
        const { count, minPrice } = bucket("", groupRows, (candidate) => {
          const minutes = minutesOf(candidate);
          return minutes !== undefined && minutes >= from && minutes <= to;
        });
        return { itineraryIndex: index, count, minPrice };
      }),
    );
  const durationRows = within({ group: "durations" });
  return {
    total: within(null).length,
    price: {
      min: lowest === null ? null : OPTIONS.money(lowest.toString()),
      max: highest === null ? null : OPTIONS.money(highest.toString()),
    },
    stops: [...new Set(rows.map((candidate) => Math.min(candidate.maxStops, 2)))]
      .sort((a, b) => a - b)
      .map((stops) =>
        bucket(
          String(stops),
          within({ group: "stops" }),
          (candidate) => Math.min(candidate.maxStops, 2) === stops,
        ),
      ),
    carriers: carriers.map((code) =>
      bucket(code, within({ group: "carriers" }), (candidate) => candidate.marketingCarriers.includes(code)),
    ),
    cabins: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]
      .filter((cabin) => rows.some((candidate) => candidate.mainCabin === cabin))
      .map((cabin) =>
        bucket(cabin, within({ group: "cabins" }), (candidate) => candidate.mainCabin === cabin),
      ),
    brandedFares: brands.map((code) =>
      bucket(code, within({ group: "brandedFares" }), (candidate) => candidate.brandedFares.includes(code)),
    ),
    includedCheckedBags: [
      ...new Set(
        rows.flatMap((candidate) =>
          candidate.minCheckedBags === null ? [] : [Math.min(candidate.minCheckedBags, 3)],
        ),
      ),
    ]
      .sort((a, b) => a - b)
      .map((bags) =>
        bucket(
          String(bags),
          within({ group: "includedCheckedBags" }),
          (candidate) => candidate.minCheckedBags !== null && Math.min(candidate.minCheckedBags, 3) === bags,
        ),
      ),
    refundable: (["true", "false", "unknown"] as const)
      .filter((state) => rows.some((candidate) => String(candidate.refundable ?? "unknown") === state))
      .map((state) =>
        bucket(
          state,
          within({ group: "refundable" }),
          (candidate) => String(candidate.refundable ?? "unknown") === state,
        ),
      ),
    departureTimes: times("departure"),
    arrivalTimes: times("arrival"),
    durations: [0, 1].flatMap((index) => {
      const values = durationRows.flatMap((candidate) => candidate.durationMinutes[index] ?? []);
      return values.length === 0
        ? []
        : [{ itineraryIndex: index, minMinutes: Math.min(...values), maxMinutes: Math.max(...values) }];
    }),
  };
}

describe("facets, highlights and scores of a search's offers [OBE-092]", () => {
  // The generated rows and the references (a check per row and group) are built once: a few ms.
  let rows: FacetRow[];
  beforeAll(() => {
    rows = generatedRows(250);
  });

  it("[OBE-092 AC2] counts every bucket as matchesFilters does with the group's own filter left out", () => {
    const filterSets: ResultFilters[] = [
      {},
      parseResultFilters({
        stops: [0, 1],
        carriers: ["AF", "KL"],
        minPrice: "100",
        maxPrice: "400.00",
        departureWindow: ["0:06:00-17:59", "1:12:00-23:59", "1:00:00-05:59"],
        arrivalWindow: ["0:06:00-23:59"],
        maxDurationMinutes: 300,
        cabins: ["ECONOMY", "PREMIUM_ECONOMY"],
        minIncludedCheckedBags: 0,
        refundable: true,
        brandedFares: ["LIGHT"],
      }),
      parseResultFilters({ carriers: ["LH"], refundable: false, changeable: true }),
    ];
    for (const filters of filterSets) {
      const facets = computeFacets(rows, filters, OPTIONS);
      const expected = referenceFacets(rows, filters);
      const shape = (buckets: readonly { value: string; count: number; minPrice?: unknown }[] | undefined) =>
        (buckets ?? []).map(({ value, count, minPrice }) => ({ value, count, minPrice }));
      const bands = (buckets: Facets["departureTimes"]) =>
        (buckets ?? []).map(({ itineraryIndex, count, minPrice }) => ({ itineraryIndex, count, minPrice }));

      expect(facets.total).toBe(expected.total);
      expect(facets.price).toEqual(expected.price);
      expect(shape(facets.stops)).toEqual(expected.stops);
      expect(shape(facets.carriers)).toEqual(expected.carriers);
      expect(shape(facets.cabins)).toEqual(expected.cabins);
      expect(shape(facets.brandedFares)).toEqual(expected.brandedFares);
      expect(shape(facets.includedCheckedBags)).toEqual(expected.includedCheckedBags);
      expect(shape(facets.refundable)).toEqual(expected.refundable);
      expect(bands(facets.departureTimes)).toEqual(expected.departureTimes);
      expect(bands(facets.arrivalTimes)).toEqual(expected.arrivalTimes);
      expect(facets.durations).toEqual(expected.durations);
    }
  });

  it("[OBE-092 AC2] leaves out exactly the excluded group's filter, or the windows of one itinerary", () => {
    // The reference of an exclusion is the same filters without it: a check per row that never skips one.
    const filterSets: ResultFilters[] = [
      parseResultFilters({
        stops: [0, 1],
        carriers: ["AF", "KL"],
        minPrice: "100",
        maxPrice: "400.00",
        departureWindow: ["0:06:00-17:59", "1:12:00-23:59", "1:00:00-05:59"],
        arrivalWindow: ["0:06:00-23:59", "1:08:00-21:59"],
        maxDurationMinutes: 300,
        cabins: ["ECONOMY", "PREMIUM_ECONOMY"],
        minIncludedCheckedBags: 1,
        refundable: true,
        changeable: false,
        brandedFares: ["LIGHT"],
      }),
      parseResultFilters({
        stops: [2],
        minPrice: "150",
        departureWindow: ["1:18:00-05:59"],
        changeable: true,
      }),
    ];
    const groupFilters: Record<FilterGroup, ReadonlyArray<keyof ResultFilters>> = {
      price: ["minPrice", "maxPrice"],
      stops: ["stops"],
      carriers: ["carriers"],
      cabins: ["cabins"],
      brandedFares: ["brandedFares"],
      includedCheckedBags: ["minIncludedCheckedBags"],
      refundable: ["refundable"],
      changeable: ["changeable"],
      durations: ["maxDurationMinutes"],
    };
    let changed = 0;
    for (const filters of filterSets) {
      const without = (keys: ReadonlyArray<keyof ResultFilters>): ResultFilters =>
        Object.fromEntries(
          Object.entries(filters).filter(([key]) => !keys.includes(key as keyof ResultFilters)),
        );
      const cases: Array<[FilterExclusion, ResultFilters]> = [
        ...(Object.keys(groupFilters) as FilterGroup[]).map((group): [FilterExclusion, ResultFilters] => [
          { group },
          without(groupFilters[group]),
        ]),
        ...[0, 1, 2].flatMap((index): Array<[FilterExclusion, ResultFilters]> => [
          [
            { departureItinerary: index },
            {
              ...filters,
              departureWindows: filters.departureWindows?.filter((window) => window.itineraryIndex !== index),
            },
          ],
          [
            { arrivalItinerary: index },
            {
              ...filters,
              arrivalWindows: filters.arrivalWindows?.filter((window) => window.itineraryIndex !== index),
            },
          ],
        ]),
      ];
      for (const candidate of rows) {
        const matches = matchesFilters(candidate, filters);
        for (const [exclusion, reference] of cases) {
          const excluded = matchesFilters(candidate, filters, exclusion);
          expect(excluded).toBe(matchesFilters(candidate, reference));
          changed += excluded !== matches ? 1 : 0;
        }
      }
    }
    // Not vacuous: some rows match only once one check is left out.
    expect(changed).toBeGreaterThan(20);
  });

  it("[OBE-092 AC2] picks the highlights a stable sort by each key, then price, then id picks", () => {
    const scores = bestScores(rows);
    // Reversed, so that the first of equal rows in the input is not the lowest id.
    const scored = [...rows]
      .reverse()
      .map((candidate) => ({ ...candidate, bestScore: scores.get(candidate.id) ?? "1" }));
    const money = (amount: string) => ({ amount, currency: "EUR" });
    const first = (key: (candidate: (typeof scored)[number]) => string | number) =>
      [...scored].sort(
        (a, b) =>
          new Money(key(a)).comparedTo(key(b)) ||
          new Money(a.sellingTotal).comparedTo(b.sellingTotal) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )[0];
    const highlight = (candidate: (typeof scored)[number] | undefined) =>
      candidate === undefined
        ? null
        : {
            offerId: candidate.id,
            price: money(candidate.sellingTotal),
            durationMinutes: candidate.totalDurationMinutes,
          };

    expect(highlightsOf(scored, money)).toEqual({
      cheapest: highlight(first((candidate) => candidate.sellingTotal)),
      fastest: highlight(first((candidate) => candidate.totalDurationMinutes)),
      best: highlight(first((candidate) => candidate.bestScore)),
    });
  });

  it("[OBE-092 AC2] scores every offer by the formula, prices and durations repeating or not", () => {
    const prices = rows.map((candidate) => new Money(candidate.sellingTotal));
    const durations = rows.map((candidate) => new Money(candidate.totalDurationMinutes));
    const span = (values: MoneyValue[]) => {
      const sorted = [...values].sort((a, b) => a.comparedTo(b));
      return { min: sorted[0] ?? new Money(0), max: sorted.at(-1) ?? new Money(0) };
    };
    const price = span(prices);
    const duration = span(durations);
    const normalised = (value: MoneyValue, range: { min: MoneyValue; max: MoneyValue }) =>
      range.max.eq(range.min) ? new Money(0) : value.minus(range.min).div(range.max.minus(range.min));
    const expected = Object.fromEntries(
      rows.map((candidate, index) => [
        candidate.id,
        normalised(prices[index] ?? new Money(0), price)
          .times("0.6")
          .plus(normalised(durations[index] ?? new Money(0), duration).times("0.3"))
          .plus(new Money(Math.min(candidate.maxStops, 2)).div(2).times("0.1"))
          .toFixed(4),
      ]),
    );

    expect(Object.fromEntries(bestScores(rows))).toEqual(expected);
  });
});
