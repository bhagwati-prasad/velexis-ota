// Result facets, highlights and the "best" score of a flight search (OBE-021; OADR-0002 point 8, the document's
// flights.listResults and FlightSearch). Pure functions over the summary columns of the stored offers (at most 250 per
// search): no I/O, no clock, money in decimal.js (`Money` of the pricing context), never a JavaScript number.
//
// - `bestScores`: the ranking of the default `best` sort, written to `flight_offers.best_score` at insert: price
//   weighted 60 %, total duration 30 %, stops 10 % (FlightOfferSort), each normalised over the search (min-max), so 0
//   is the best possible offer and lower is better; 4 decimals.
// - `highlightsOf`: the cheapest, fastest and best offer of the whole result set (`flight_searches.highlights`).
// - `matchesFilters`: the filters of flights.listResults, the same semantics as the SQL of searches.repository.ts (the
//   integration test pages through the SQL results and compares them with `total`):
//     stops            max_stops in the list, 2 = two or more
//     carriers         every marketing carrier of the offer is in the list
//     minPrice/maxPrice  selling total, inclusive
//     departureWindow / arrivalWindow  `{itinerary}:{HH:MM}-{HH:MM}`, inclusive, wrapping midnight when the end is
//                      before the start; ORed within an itinerary, ANDed across itineraries; an offer without that
//                      itinerary does not match
//     maxDurationMinutes  every itinerary at most this long
//     cabins           main cabin in the list
//     minIncludedCheckedBags  known included bags at least this many
//     refundable/changeable  known and equal (unknown never matches)
//     brandedFares     any branded fare of the offer in the list
// - `computeFacets`: disjunctive faceting: each group counts the offers that match every active filter except its own,
//   and the time bands of itinerary i ignore only the windows of itinerary i. Buckets list every value present in the
//   search, so a ticked value whose count fell to 0 stays visible.
import { createHash } from "node:crypto";
import type { components } from "@velexis/api-types";
import { Money, type MoneyValue } from "../pricing/pricing.types";

type Schemas = components["schemas"];
export type Facets = Schemas["Facets"];
export type FacetBucket = Schemas["FacetBucket"];
export type FacetTimeBand = Schemas["FacetTimeBand"];
export type FacetDurationRange = Schemas["FacetDurationRange"];
export type FlightSearchHighlights = Schemas["FlightSearchHighlights"];
export type FlightSearchHighlight = Schemas["FlightSearchHighlight"];
export type MoneyAmount = Schemas["Money"];
export type TravelClass = Schemas["AmadeusTravelClass"];

/** The summary columns of one stored offer that filters, facets, the score and the highlights read. */
export interface FacetRow {
  readonly id: string;
  /** `selling_total`, a decimal string. */
  readonly sellingTotal: string;
  readonly maxStops: number;
  readonly marketingCarriers: readonly string[];
  /** Per itinerary: local departure time in minutes after midnight. */
  readonly departureMinutes: readonly number[];
  /** Per itinerary: local arrival time in minutes after midnight. */
  readonly arrivalMinutes: readonly number[];
  /** Per itinerary: duration in minutes. */
  readonly durationMinutes: readonly number[];
  readonly totalDurationMinutes: number;
  readonly mainCabin: string | null;
  readonly minCheckedBags: number | null;
  readonly refundable: boolean | null;
  readonly changeable: boolean | null;
  readonly brandedFares: readonly string[];
}

/** A row with its score, for the highlights. */
export interface ScoredRow extends FacetRow {
  /** `best_score`, a decimal string. */
  readonly bestScore: string;
}

/** A time window of one itinerary, in minutes after midnight, both ends inclusive. */
export interface TimeWindow {
  readonly itineraryIndex: number;
  readonly from: number;
  readonly to: number;
}

/** The filters of flights.listResults, parsed. An absent filter is not applied. */
export interface ResultFilters {
  readonly stops?: readonly number[] | undefined;
  readonly carriers?: readonly string[] | undefined;
  /** Decimal string, inclusive. */
  readonly minPrice?: string | undefined;
  /** Decimal string, inclusive. */
  readonly maxPrice?: string | undefined;
  readonly departureWindows?: readonly TimeWindow[] | undefined;
  readonly arrivalWindows?: readonly TimeWindow[] | undefined;
  readonly maxDurationMinutes?: number | undefined;
  readonly cabins?: readonly string[] | undefined;
  readonly minIncludedCheckedBags?: number | undefined;
  readonly refundable?: boolean | undefined;
  readonly changeable?: boolean | undefined;
  readonly brandedFares?: readonly string[] | undefined;
}

/** The facet groups, each ignoring its own filter. */
export type FilterGroup =
  | "price"
  | "stops"
  | "carriers"
  | "cabins"
  | "brandedFares"
  | "includedCheckedBags"
  | "refundable"
  | "changeable"
  | "durations";

/** What a facet count leaves out: one group's filter, or the windows of one itinerary. */
export type FilterExclusion =
  | { readonly group: FilterGroup }
  | { readonly departureItinerary: number }
  | { readonly arrivalItinerary: number }
  | null;

/** The time-of-day bands of the facets (FacetTimeBand), in minutes, both ends inclusive. */
export const TIME_BANDS = Object.freeze([
  { band: "early_morning", from: 0, to: 359 },
  { band: "morning", from: 360, to: 719 },
  { band: "afternoon", from: 720, to: 1079 },
  { band: "evening", from: 1080, to: 1439 },
] as const);

/** The main cabins in display order. */
export const CABIN_ORDER: readonly TravelClass[] = Object.freeze([
  "ECONOMY",
  "PREMIUM_ECONOMY",
  "BUSINESS",
  "FIRST",
]);

const CABIN_LABELS: Readonly<Record<TravelClass, string>> = Object.freeze({
  ECONOMY: "Economy",
  PREMIUM_ECONOMY: "Premium economy",
  BUSINESS: "Business",
  FIRST: "First",
});

const STOP_LABELS: readonly string[] = Object.freeze(["Non-stop", "1 stop", "2+ stops"]);
const BAG_LABELS: readonly string[] = Object.freeze([
  "No checked bag",
  "1 checked bag",
  "2 checked bags",
  "3+ checked bags",
]);

/** The highest stops and bags buckets: "2" is two or more stops, "3" three or more bags. */
const MAX_STOPS_BUCKET = 2;
const MAX_BAGS_BUCKET = 3;

/** The weights of the best score (FlightOfferSort): price 60 %, duration 30 %, stops 10 %. */
const SCORE_WEIGHTS = Object.freeze({ price: "0.6", duration: "0.3", stops: "0.1" });
/** Decimals of `best_score` (`numeric(12,4)`). */
export const SCORE_DECIMALS = 4;

/** `HH:MM` of minutes after midnight. */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const WINDOW = /^([0-5]):([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** A `{itineraryIndex}:{HH:MM}-{HH:MM}` window (the document's pattern), or `undefined` when malformed. */
export function parseWindow(value: string): TimeWindow | undefined {
  const match = WINDOW.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, index, fromH, fromM, toH, toM] = match;
  const minutes = (hours: string | undefined, mins: string | undefined): number =>
    Number.parseInt(hours ?? "0", 10) * 60 + Number.parseInt(mins ?? "0", 10);
  return {
    itineraryIndex: Number.parseInt(index ?? "0", 10),
    from: minutes(fromH, fromM),
    to: minutes(toH, toM),
  };
}

/** True when `minutes` lies in the window (inclusive; wrapping midnight when `to` is before `from`). */
export function inWindow(minutes: number, window: Pick<TimeWindow, "from" | "to">): boolean {
  return window.from <= window.to
    ? minutes >= window.from && minutes <= window.to
    : minutes >= window.from || minutes <= window.to;
}

/** The windows grouped by itinerary, in itinerary order. */
export function windowsByItinerary(windows: readonly TimeWindow[]): Map<number, TimeWindow[]> {
  const grouped = new Map<number, TimeWindow[]>();
  for (const window of [...windows].sort((a, b) => a.itineraryIndex - b.itineraryIndex)) {
    const list = grouped.get(window.itineraryIndex) ?? [];
    list.push(window);
    grouped.set(window.itineraryIndex, list);
  }
  return grouped;
}

function matchesWindows(
  minutes: readonly number[],
  windows: readonly TimeWindow[] | undefined,
  skipItinerary: number | undefined,
): boolean {
  if (windows === undefined || windows.length === 0) {
    return true;
  }
  for (const [index, list] of windowsByItinerary(windows)) {
    if (index === skipItinerary) {
      continue;
    }
    const value = minutes[index];
    if (value === undefined || !list.some((window) => inWindow(value, window))) {
      return false;
    }
  }
  return true;
}

function matchesStops(maxStops: number, stops: readonly number[]): boolean {
  return stops.some((value) =>
    value >= MAX_STOPS_BUCKET ? maxStops >= MAX_STOPS_BUCKET : maxStops === value,
  );
}

/** True when `row` matches every active filter, except the one `exclusion` names. */
export function matchesFilters(
  row: FacetRow,
  filters: ResultFilters,
  exclusion: FilterExclusion = null,
): boolean {
  const skip = (group: FilterGroup): boolean =>
    exclusion !== null && "group" in exclusion && exclusion.group === group;
  const selling = new Money(row.sellingTotal);
  const checks: Array<() => boolean> = [
    () => skip("stops") || filters.stops === undefined || matchesStops(row.maxStops, filters.stops),
    () => {
      const carriers = filters.carriers;
      return (
        skip("carriers") ||
        carriers === undefined ||
        row.marketingCarriers.every((carrier) => carriers.includes(carrier))
      );
    },
    () => skip("price") || filters.minPrice === undefined || selling.gte(filters.minPrice),
    () => skip("price") || filters.maxPrice === undefined || selling.lte(filters.maxPrice),
    () =>
      matchesWindows(
        row.departureMinutes,
        filters.departureWindows,
        exclusion !== null && "departureItinerary" in exclusion ? exclusion.departureItinerary : undefined,
      ),
    () =>
      matchesWindows(
        row.arrivalMinutes,
        filters.arrivalWindows,
        exclusion !== null && "arrivalItinerary" in exclusion ? exclusion.arrivalItinerary : undefined,
      ),
    () => {
      const limit = filters.maxDurationMinutes;
      return skip("durations") || limit === undefined || row.durationMinutes.every((value) => value <= limit);
    },
    () =>
      skip("cabins") ||
      filters.cabins === undefined ||
      (row.mainCabin !== null && filters.cabins.includes(row.mainCabin)),
    () =>
      skip("includedCheckedBags") ||
      filters.minIncludedCheckedBags === undefined ||
      (row.minCheckedBags !== null && row.minCheckedBags >= filters.minIncludedCheckedBags),
    () => skip("refundable") || filters.refundable === undefined || row.refundable === filters.refundable,
    () => skip("changeable") || filters.changeable === undefined || row.changeable === filters.changeable,
    () => {
      const codes = filters.brandedFares;
      return (
        skip("brandedFares") || codes === undefined || row.brandedFares.some((code) => codes.includes(code))
      );
    },
  ];
  return checks.every((check) => check());
}

// ---- Score and highlights ------------------------------------------------------------------------------------------

/** (value − min) / (max − min) over the search, 0 when every offer has the same value. */
function normalised(value: MoneyValue, min: MoneyValue, max: MoneyValue): MoneyValue {
  return max.eq(min) ? new Money(0) : value.minus(min).div(max.minus(min));
}

function minMax(values: readonly MoneyValue[]): { min: MoneyValue; max: MoneyValue } {
  let min = values[0] ?? new Money(0);
  let max = min;
  for (const value of values) {
    min = value.lt(min) ? value : min;
    max = value.gt(max) ? value : max;
  }
  return { min, max };
}

/**
 * The `best_score` of every row, by id: 0.6 × normalised price + 0.3 × normalised total duration + 0.1 × stops
 * (0, 0.5 or 1 for two or more), as a decimal string with 4 decimals; lower is better.
 */
export function bestScores(
  rows: ReadonlyArray<Pick<FacetRow, "id" | "sellingTotal" | "totalDurationMinutes" | "maxStops">>,
): Map<string, string> {
  const prices = rows.map((row) => new Money(row.sellingTotal));
  const durations = rows.map((row) => new Money(row.totalDurationMinutes));
  const price = minMax(prices);
  const duration = minMax(durations);
  const scores = new Map<string, string>();
  rows.forEach((row, index) => {
    const stops = new Money(Math.min(row.maxStops, MAX_STOPS_BUCKET)).div(MAX_STOPS_BUCKET);
    const score = normalised(prices[index] ?? price.min, price.min, price.max)
      .times(SCORE_WEIGHTS.price)
      .plus(
        normalised(durations[index] ?? duration.min, duration.min, duration.max).times(
          SCORE_WEIGHTS.duration,
        ),
      )
      .plus(stops.times(SCORE_WEIGHTS.stops));
    scores.set(row.id, score.toFixed(SCORE_DECIMALS));
  });
  return scores;
}

/** Orders by the given keys, then by selling total, then by id (FlightOfferSort: "ties by price, then offer id"). */
function compareBy(primary: (row: ScoredRow) => MoneyValue): (a: ScoredRow, b: ScoredRow) => number {
  return (a, b) =>
    primary(a).comparedTo(primary(b)) ||
    new Money(a.sellingTotal).comparedTo(b.sellingTotal) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The cheapest, fastest and best offer of `rows` (all null for none). */
export function highlightsOf(
  rows: readonly ScoredRow[],
  money: (amount: string) => MoneyAmount,
): FlightSearchHighlights {
  const pick = (compare: (a: ScoredRow, b: ScoredRow) => number): FlightSearchHighlight | null => {
    const [first] = [...rows].sort(compare);
    return first === undefined
      ? null
      : { offerId: first.id, price: money(first.sellingTotal), durationMinutes: first.totalDurationMinutes };
  };
  return {
    cheapest: pick(compareBy((row) => new Money(row.sellingTotal))),
    fastest: pick(compareBy((row) => new Money(row.totalDurationMinutes))),
    best: pick(compareBy((row) => new Money(row.bestScore))),
  };
}

/** The highlight tags an offer holds (`OfferSummary.tags`). */
export function tagsOf(
  offerId: string,
  highlights: FlightSearchHighlights | null | undefined,
): Array<"cheapest" | "fastest" | "best"> {
  if (highlights === null || highlights === undefined) {
    return [];
  }
  return (["cheapest", "fastest", "best"] as const).filter((tag) => highlights[tag]?.offerId === offerId);
}

// ---- Facets ----------------------------------------------------------------------------------------------------------

/** How facet amounts and labels are written. */
export interface FacetOptions {
  /** A selling amount as `Money` in the search currency. */
  readonly money: (amount: string) => MoneyAmount;
  /** The display name of a carrier, or `null`. */
  readonly carrierLabel: (code: string) => string | null;
  /** The label of a branded fare code, or `null`. */
  readonly brandedFareLabel: (code: string) => string | null;
}

/** Count and lowest selling total of the rows matching `predicate`. */
function bucketOf(
  value: string,
  label: string | null,
  rows: readonly FacetRow[],
  predicate: (row: FacetRow) => boolean,
  options: FacetOptions,
): FacetBucket {
  let count = 0;
  let min: MoneyValue | null = null;
  for (const row of rows) {
    if (predicate(row)) {
      count += 1;
      const selling = new Money(row.sellingTotal);
      min = min === null || selling.lt(min) ? selling : min;
    }
  }
  return { value, label, count, minPrice: min === null ? null : options.money(min.toString()) };
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function distinct(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byCode);
}

const triState = (value: boolean | null): "true" | "false" | "unknown" =>
  value === null ? "unknown" : value ? "true" : "false";

const stopsBucket = (maxStops: number): number => Math.min(maxStops, MAX_STOPS_BUCKET);
const bagsBucket = (bags: number): number => Math.min(bags, MAX_BAGS_BUCKET);

/** The facets of `rows` (all offers of one search) under `filters`. */
export function computeFacets(
  rows: readonly FacetRow[],
  filters: ResultFilters,
  options: FacetOptions,
): Facets {
  const except = (exclusion: FilterExclusion): FacetRow[] =>
    rows.filter((row) => matchesFilters(row, filters, exclusion));
  const matching = except(null);

  const priceRows = except({ group: "price" }).map((row) => new Money(row.sellingTotal));
  const priceRange = minMax(priceRows);

  const stopsRows = except({ group: "stops" });
  const stops = [...new Set(rows.map((row) => stopsBucket(row.maxStops)))]
    .sort((a, b) => a - b)
    .map((value) =>
      bucketOf(
        String(value),
        STOP_LABELS[value] ?? null,
        stopsRows,
        (row) => stopsBucket(row.maxStops) === value,
        options,
      ),
    );

  const carrierRows = except({ group: "carriers" });
  const carriers = distinct(rows.flatMap((row) => row.marketingCarriers)).map((code) =>
    bucketOf(
      code,
      options.carrierLabel(code),
      carrierRows,
      (row) => row.marketingCarriers.includes(code),
      options,
    ),
  );

  const cabinRows = except({ group: "cabins" });
  const presentCabins = new Set(rows.map((row) => row.mainCabin));
  const cabins = CABIN_ORDER.filter((cabin) => presentCabins.has(cabin)).map((cabin) =>
    bucketOf(cabin, CABIN_LABELS[cabin], cabinRows, (row) => row.mainCabin === cabin, options),
  );

  const brandRows = except({ group: "brandedFares" });
  const brandedFares = distinct(rows.flatMap((row) => row.brandedFares)).map((code) =>
    bucketOf(
      code,
      options.brandedFareLabel(code),
      brandRows,
      (row) => row.brandedFares.includes(code),
      options,
    ),
  );

  const bagRows = except({ group: "includedCheckedBags" });
  const includedCheckedBags = [
    ...new Set(rows.flatMap((row) => (row.minCheckedBags === null ? [] : [bagsBucket(row.minCheckedBags)]))),
  ]
    .sort((a, b) => a - b)
    .map((value) =>
      bucketOf(
        String(value),
        BAG_LABELS[value] ?? null,
        bagRows,
        (row) => row.minCheckedBags !== null && bagsBucket(row.minCheckedBags) === value,
        options,
      ),
    );

  const conditionFacet = (
    group: "refundable" | "changeable",
    labels: Readonly<Record<"true" | "false" | "unknown", string>>,
  ): FacetBucket[] => {
    const groupRows = except({ group });
    const present = new Set(rows.map((row) => triState(row[group])));
    return (["true", "false", "unknown"] as const)
      .filter((value) => present.has(value))
      .map((value) =>
        bucketOf(value, labels[value], groupRows, (row) => triState(row[group]) === value, options),
      );
  };

  const itineraryCount = rows.reduce((count, row) => Math.max(count, row.departureMinutes.length), 0);
  const itineraries = Array.from({ length: itineraryCount }, (_unused, index) => index);
  const timeBands = (kind: "departure" | "arrival"): FacetTimeBand[] =>
    itineraries.flatMap((index) => {
      const bandRows = except(
        kind === "departure" ? { departureItinerary: index } : { arrivalItinerary: index },
      );
      const minutesOf = (row: FacetRow): number | undefined =>
        (kind === "departure" ? row.departureMinutes : row.arrivalMinutes)[index];
      return TIME_BANDS.map(({ band, from, to }) => {
        const bucket = bucketOf(
          band,
          null,
          bandRows,
          (row) => {
            const minutes = minutesOf(row);
            return minutes !== undefined && minutes >= from && minutes <= to;
          },
          options,
        );
        return {
          itineraryIndex: index,
          band,
          from: formatMinutes(from),
          to: formatMinutes(to),
          count: bucket.count,
          minPrice: bucket.minPrice ?? null,
        };
      });
    });

  const durationRows = except({ group: "durations" });
  const durations: FacetDurationRange[] = itineraries.flatMap((index) => {
    const values = durationRows.flatMap((row) => {
      const value = row.durationMinutes[index];
      return value === undefined ? [] : [value];
    });
    return values.length === 0
      ? []
      : [{ itineraryIndex: index, minMinutes: Math.min(...values), maxMinutes: Math.max(...values) }];
  });

  return {
    total: matching.length,
    price: {
      min: priceRows.length === 0 ? null : options.money(priceRange.min.toString()),
      max: priceRows.length === 0 ? null : options.money(priceRange.max.toString()),
    },
    stops,
    carriers,
    cabins,
    brandedFares,
    includedCheckedBags,
    refundable: conditionFacet("refundable", {
      true: "Refundable",
      false: "Non-refundable",
      unknown: "Unknown",
    }),
    changeable: conditionFacet("changeable", {
      true: "Changeable",
      false: "Not changeable",
      unknown: "Unknown",
    }),
    departureTimes: timeBands("departure"),
    arrivalTimes: timeBands("arrival"),
    durations,
  };
}

// ---- Query, sort and cursor ------------------------------------------------------------------------------------------

export type ResultSort = Schemas["FlightOfferSort"];

/** The query of flights.listResults as the validation interceptor leaves it (arrays split, numbers coerced). */
export interface ResultQuery {
  readonly stops?: readonly number[] | undefined;
  readonly carriers?: readonly string[] | undefined;
  readonly minPrice?: string | undefined;
  readonly maxPrice?: string | undefined;
  readonly departureWindow?: readonly string[] | undefined;
  readonly arrivalWindow?: readonly string[] | undefined;
  readonly maxDurationMinutes?: number | undefined;
  readonly cabins?: readonly string[] | undefined;
  readonly minIncludedCheckedBags?: number | undefined;
  readonly refundable?: boolean | undefined;
  readonly changeable?: boolean | undefined;
  readonly brandedFares?: readonly string[] | undefined;
}

function sortedDistinct<T extends string | number>(values: readonly T[] | undefined): T[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function windows(values: readonly string[] | undefined): TimeWindow[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  const parsed = values.flatMap((value) => parseWindow(value) ?? []);
  return parsed.sort((a, b) => a.itineraryIndex - b.itineraryIndex || a.from - b.from || a.to - b.to);
}

/** The filters of a listResults query, lists sorted and without duplicates (so equal filters fingerprint equally). */
export function parseResultFilters(query: ResultQuery): ResultFilters {
  return {
    stops: sortedDistinct(query.stops),
    carriers: sortedDistinct(query.carriers),
    minPrice: query.minPrice,
    maxPrice: query.maxPrice,
    departureWindows: windows(query.departureWindow),
    arrivalWindows: windows(query.arrivalWindow),
    maxDurationMinutes: query.maxDurationMinutes,
    cabins: sortedDistinct(query.cabins),
    minIncludedCheckedBags: query.minIncludedCheckedBags,
    refundable: query.refundable,
    changeable: query.changeable,
    brandedFares: sortedDistinct(query.brandedFares),
  };
}

/** A short digest of the search, the filters and the sort, which a cursor carries. */
export function resultFingerprint(searchId: string, filters: ResultFilters, sort: ResultSort): string {
  const canonical = JSON.stringify([
    searchId,
    sort,
    Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}

/** A value of a sort key: a decimal string, a local date-time, a number of minutes. */
export type SortKeyValue = string | number;

/** Where the next page starts: after the row with these sort keys and this id, under the same fingerprint. */
export interface ResultCursor {
  readonly fingerprint: string;
  readonly keys: readonly SortKeyValue[];
  readonly id: string;
}

const CURSOR_VERSION = 1;

/** The opaque cursor of `cursor` (base64url JSON). */
export function encodeCursor(cursor: ResultCursor): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, cursor.fingerprint, cursor.keys, cursor.id])).toString(
    "base64url",
  );
}

/** The cursor of `value`, or `undefined` when it is not one this API wrote. */
export function decodeCursor(value: string): ResultCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    return undefined;
  }
  const [version, fingerprint, keys, id] = parsed as unknown[];
  if (
    version !== CURSOR_VERSION ||
    typeof fingerprint !== "string" ||
    typeof id !== "string" ||
    !/^off_[0-9A-Za-z]{16,40}$/.test(id) ||
    !Array.isArray(keys) ||
    keys.length > 3 ||
    !keys.every((key) => (typeof key === "string" && key.length <= 40) || Number.isInteger(key))
  ) {
    return undefined;
  }
  return { fingerprint, keys: keys as SortKeyValue[], id };
}

/** The facets of a search without results (pending, failed or empty). */
export function emptyFacets(): Facets {
  return {
    total: 0,
    price: { min: null, max: null },
    stops: [],
    carriers: [],
    cabins: [],
    brandedFares: [],
    includedCheckedBags: [],
    refundable: [],
    changeable: [],
    departureTimes: [],
    arrivalTimes: [],
    durations: [],
  };
}
