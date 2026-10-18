// The results page (ota/frontend/docs/pages.md §4): search.html with its partials expanded by the build's include
// plugin, run by src/pages/search.js against a fake SDK. It covers the search and the `search=srch_…` id in the
// address, filters and sort mirrored in the query string and kept over a reload without a new search, "Show more
// flights", offer cards that show the API's totals as text, and the states of §4 for their error codes.
import {
  ConnectionError,
  ExpiredError,
  NotFoundError,
  SupplierError,
  ValidationError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { formatMoney } from "../src/lib/format.js";
import {
  RESULTS_LIMIT,
  SEARCH_TIMEOUT_MS,
  nearbyDates,
  searchRequestFor,
  shiftDate,
  start,
  summaryFromQuery,
} from "../src/pages/search.js";
import { readSearchQuery } from "../src/components/search-form.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** What the mocked boot() of the page module resolves with; `null` keeps it waiting (the static import below). */
const pageBoot = vi.hoisted(() => ({ context: /** @type {unknown} */ (null) }));
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return {
    ...actual,
    boot: () => (pageBoot.context ? Promise.resolve(pageBoot.context) : new Promise(() => {})),
  };
});

const TODAY = "2026-10-18";
const SEARCH_ID = "srch_01JRESULTSPAGE00001";
const NEXT_SEARCH_ID = "srch_01JRESULTSPAGE00002";
const QUERY =
  "trip=return&from=PAR&to=NYC&depart=2026-11-20&return=2026-11-27&adults=2&children=0&infants=0&cabin=ECONOMY";
const CONFIG = Object.freeze({
  defaultLocale: "en-GB",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
});

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });

/** Facets of the whole search, as listResults answers them. */
const FACETS = Object.freeze({
  total: 42,
  price: { min: eur("199.99"), max: eur("1250.40") },
  stops: [
    { value: "0", label: "Non-stop", count: 12, minPrice: eur("412.30") },
    { value: "1", label: "1 stop", count: 30, minPrice: eur("199.99") },
  ],
  carriers: [
    { value: "AF", label: null, count: 20, minPrice: eur("230.00") },
    { value: "KL", label: "KLM", count: 22, minPrice: eur("199.99") },
  ],
  cabins: [{ value: "ECONOMY", label: "Economy", count: 42, minPrice: eur("199.99") }],
  brandedFares: [{ value: "LIGHT", label: "ECONOMY LIGHT", count: 10, minPrice: eur("199.99") }],
  includedCheckedBags: [
    { value: "0", label: "No checked bag", count: 10, minPrice: eur("199.99") },
    { value: "1", label: "1 checked bag", count: 32, minPrice: eur("260.00") },
  ],
  refundable: [
    { value: "true", label: "Refundable", count: 5, minPrice: eur("800.00") },
    { value: "false", label: "Non-refundable", count: 37, minPrice: eur("199.99") },
  ],
  changeable: [{ value: "true", label: "Changeable", count: 20, minPrice: eur("300.00") }],
  departureTimes: [0, 1].flatMap((itineraryIndex) => [
    { itineraryIndex, band: "morning", from: "06:00", to: "11:59", count: 20, minPrice: eur("199.99") },
    { itineraryIndex, band: "evening", from: "18:00", to: "23:59", count: 22, minPrice: eur("230.00") },
  ]),
  arrivalTimes: [],
  durations: [
    { itineraryIndex: 0, minMinutes: 455, maxMinutes: 1210 },
    { itineraryIndex: 1, minMinutes: 470, maxMinutes: 1300 },
  ],
});

const AIRLINES = /** @type {Record<string, string>} */ ({
  AF: "Air France",
  KL: "KLM Royal Dutch Airlines",
});

/**
 * One flight.
 * @param {string} id
 * @param {string} carrierCode
 * @param {string} from
 * @param {string} to
 * @param {string} departAt
 * @param {string} arriveAt
 * @param {object | null} [layoverAfter]
 */
const segment = (id, carrierCode, from, to, departAt, arriveAt, layoverAfter = null) => ({
  id,
  departure: { iataCode: from, terminal: from === "CDG" ? "2E" : null, at: departAt, airportName: null },
  arrival: { iataCode: to, terminal: null, at: arriveAt, airportName: null },
  carrierCode,
  carrierName: null,
  number: "1234",
  flightNumber: `${carrierCode}1234`,
  operating: null,
  aircraft: { code: "359", name: "Airbus A350-900" },
  duration: null,
  durationMinutes: 500,
  numberOfStops: 0,
  cabin: "ECONOMY",
  layoverAfter,
});

/**
 * An offer of the search (summary view): a return trip whose outbound has one stop in Amsterdam and lands the next
 * day. Its total deliberately differs from base + taxes + fees: the card must show the API's total.
 * @param {number} n
 * @param {{ total?: string, perAdult?: string, carriers?: string[], tags?: string[] }} [options]
 */
function offer(n, { total = "412.30", perAdult = "206.15", carriers = ["AF"], tags = [] } = {}) {
  const [carrier = "AF"] = carriers;
  return {
    id: `off_01JOFFER${String(n).padStart(8, "0")}`,
    searchId: SEARCH_ID,
    origin: "search",
    status: "active",
    source: "GDS",
    expiresAt: "2026-10-18T12:30:00Z",
    createdAt: "2026-10-18T12:00:00Z",
    price: {
      currency: "EUR",
      total: eur(total),
      base: eur("100.00"),
      taxes: eur("20.00"),
      fees: eur("5.00"),
      additionalServices: null,
      perAdult: eur(perAdult),
    },
    summary: {
      tripType: "round_trip",
      originCode: "CDG",
      destinationCode: "JFK",
      departureAt: "2026-11-20T21:35:00",
      returnAt: "2026-11-27T10:00:00",
      totalDurationMinutes: 1500,
      maxStops: 1,
      marketingCarriers: carriers,
      cabins: ["ECONOMY"],
      brandedFares: [{ itineraryIndex: 0, code: "LIGHT", label: "ECONOMY LIGHT" }],
      includedCheckedBags: { quantity: 1, weight: 23, weightUnit: "KG" },
      refundable: false,
      changeable: true,
      numberOfBookableSeats: 3,
      tags,
    },
    itineraries: [
      {
        index: 0,
        originCode: "CDG",
        destinationCode: "JFK",
        departureAt: "2026-11-20T21:35:00",
        arrivalAt: "2026-11-21T07:10:00",
        duration: "PT15H35M",
        durationMinutes: 935,
        stops: 1,
        stopAirports: ["AMS"],
        arrivalDayOffset: 1,
        marketingCarriers: carriers,
        segments: [
          segment("1", carrier, "CDG", "AMS", "2026-11-20T21:35:00", "2026-11-20T22:50:00", {
            duration: "PT2H5M",
            durationMinutes: 125,
            airportChange: false,
            overnight: false,
            nextDepartureCode: "AMS",
          }),
          segment("2", carrier, "AMS", "JFK", "2026-11-21T00:55:00", "2026-11-21T07:10:00"),
        ],
      },
      {
        index: 1,
        originCode: "JFK",
        destinationCode: "CDG",
        departureAt: "2026-11-27T10:00:00",
        arrivalAt: "2026-11-27T22:25:00",
        duration: "PT6H25M",
        durationMinutes: 385,
        stops: 0,
        stopAirports: [],
        arrivalDayOffset: 0,
        marketingCarriers: carriers,
        segments: [segment("3", carrier, "JFK", "CDG", "2026-11-27T10:00:00", "2026-11-27T22:25:00")],
      },
    ],
  };
}

/** The search as flights.search and flights.getSearch answer it. */
const SEARCH = Object.freeze({
  id: SEARCH_ID,
  status: "completed",
  mode: "simple",
  customerId: null,
  criteria: {
    mode: "simple",
    request: {
      mode: "simple",
      originLocationCode: "PAR",
      destinationLocationCode: "NYC",
      departureDate: "2026-11-20",
      returnDate: "2026-11-27",
      adults: 2,
      children: 0,
      infants: 0,
      travelClass: "ECONOMY",
    },
    amadeusOperationId: "getFlightOffers",
  },
  summary: {
    tripType: "round_trip",
    legs: [
      { originDestinationId: "1", originCode: "PAR", destinationCode: "NYC", departureDate: "2026-11-20" },
      { originDestinationId: "2", originCode: "NYC", destinationCode: "PAR", departureDate: "2026-11-27" },
    ],
    travelers: { adults: 2, children: 0, infants: 0, total: 2 },
    travelClass: "ECONOMY",
  },
  currency: "EUR",
  resultCount: 42,
  highlights: { cheapest: null, fastest: null, best: null },
  facets: FACETS,
  dictionaries: {
    locations: {
      PAR: { cityCode: "PAR", countryCode: "FR", airportName: null, cityName: "Paris" },
      NYC: { cityCode: "NYC", countryCode: "US", airportName: null, cityName: "New York" },
    },
    carriers: {},
  },
  createdAt: "2026-10-18T12:00:00Z",
  completedAt: "2026-10-18T12:00:05Z",
  expiresAt: "2026-10-18T12:30:05Z",
});

/**
 * A results page as listResults answers it; `next()` gives `nextPage`.
 * @param {{ offers?: object[], total?: number, nextCursor?: string | null, nextPage?: object | null, facets?: object }} [options]
 */
function resultsPage({
  offers = [offer(1, { tags: ["cheapest"] }), offer(2, { carriers: ["KL"] })],
  total = 42,
  nextCursor = null,
  nextPage = null,
  facets = FACETS,
} = {}) {
  return {
    data: offers,
    page: { nextCursor, limit: RESULTS_LIMIT },
    searchId: SEARCH_ID,
    currency: "EUR",
    total,
    sort: "best",
    facets: { ...facets, total },
    dictionaries: {
      locations: {
        AMS: { cityCode: "AMS", countryCode: "NL", airportName: "Schiphol", cityName: "Amsterdam" },
      },
      carriers: { AF: { name: "Air France" } },
    },
    expiresAt: "2026-10-18T12:30:05Z",
    next: vi.fn(async () => nextPage),
  };
}

/** Places for the search form's labels and the "nearby airports" suggestions. */
const LOCATIONS = /** @type {Record<string, object[]>} */ ({
  CDG: [
    {
      id: "AIRPORT:CDG",
      subType: "AIRPORT",
      iataCode: "CDG",
      name: "Charles de Gaulle",
      cityCode: "PAR",
      cityName: "Paris",
      countryCode: "FR",
    },
  ],
  JFK: [
    {
      id: "AIRPORT:JFK",
      subType: "AIRPORT",
      iataCode: "JFK",
      name: "John F Kennedy International",
      cityCode: "NYC",
      cityName: "New York",
      countryCode: "US",
    },
  ],
});

/**
 * A fake SDK client with the calls of the results page; each `flights` method can be replaced.
 * @param {{ search?: Function, getSearch?: Function, listResults?: Function }} [overrides]
 */
function fakeClient(overrides = {}) {
  return {
    flights: {
      search: vi.fn(overrides.search ?? (async () => structuredClone(SEARCH))),
      getSearch: vi.fn(overrides.getSearch ?? (async () => structuredClone(SEARCH))),
      listResults: vi.fn(overrides.listResults ?? (async () => resultsPage())),
    },
    reference: {
      airlines: {
        list: vi.fn(async (/** @type {{ iataCodes: string[] }} */ { iataCodes }) => ({
          data: iataCodes
            .filter((code) => AIRLINES[code])
            .map((code) => ({ iataCode: code, name: AIRLINES[code] })),
          page: { nextCursor: null, limit: 100 },
        })),
      },
      locations: {
        search: vi.fn(async (/** @type {{ keyword: string }} */ { keyword }) => ({
          data: LOCATIONS[keyword] ?? [],
          page: { nextCursor: null, limit: 8 },
        })),
      },
      airports: {
        get: vi.fn(async () => {
          throw new NotFoundError({ code: "NOT_FOUND", message: "Not found", status: 404 });
        }),
      },
    },
  };
}

/** @type {Browser | undefined} */
let browser;
/** @type {Document} */
let resultsPageDocument;
/** The test window's address before each test. */
let address = "";
/** Views started by the current test, destroyed after it. */
const views = /** @type {Array<{ destroy: () => void }>} */ ([]);

beforeAll(async () => {
  // Expands search.html with the build's include plugin and parses it once in a happy-dom browser page; each test
  // imports a fresh copy of its body into the test document.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  const html = await transform.handler(readFileSync(join(STOREFRONT_ROOT, "search.html"), "utf8"), {
    path: "/search.html",
  });
  browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  const page = browser.newPage();
  page.url = "https://demo.ota.example.com/search.html";
  page.content = html;
  resultsPageDocument = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}, 15_000); // file reads, the include plugin and one happy-dom browser; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

/** Puts a fresh copy of search.html's body into the test document. */
function loadPage() {
  document.body.replaceChildren(
    ...Array.from(resultsPageDocument.body.childNodes, (node) => document.importNode(node, true)),
  );
}

beforeEach(() => {
  address = `${location.pathname}${location.search}`;
  loadPage();
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
  history.replaceState(null, "", address);
  vi.useRealTimers();
});

/** Waits until queued promise callbacks have run (the fake SDK answers at once). */
const settle = async () => {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
};

const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const cards = () => Array.from(document.querySelectorAll("[data-offers] > li[data-offer]"));
const params = () => new URLSearchParams(location.search);

/**
 * Starts the results page at `/search.html?<query>` with a fake SDK.
 * @param {string} query
 * @param {ReturnType<typeof fakeClient>} [client]
 */
function open(query, client = fakeClient()) {
  history.replaceState(null, "", `/search.html?${query}`);
  const view = start(
    { config: /** @type {never} */ (CONFIG), client: /** @type {never} */ (client) },
    {
      today: TODAY,
    },
  );
  if (!view) {
    throw new Error("the results page did not start");
  }
  views.push(view);
  return { view, client };
}

/** Ticks a checkbox or radio as a click does (checked, then `change` on the form). */
function tick(/** @type {HTMLInputElement} */ input, checked = true) {
  input.checked = checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Sets a field's value and commits it (`change`), as typing and leaving the field does. */
function commit(/** @type {HTMLInputElement | HTMLSelectElement} */ field, /** @type {string} */ value) {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

/** @param {string} name @param {string} value */
const option = (name, value) =>
  /** @type {HTMLInputElement} */ (
    document.querySelector(`form[data-filters] input[name="${name}"][value="${value}"]`)
  );

/** The last listResults parameters. */
const lastList = (/** @type {ReturnType<typeof fakeClient>} */ client) =>
  /** @type {Record<string, unknown>} */ (client.flights.listResults.mock.calls.at(-1)?.[0]);

describe("results page: search and address", () => {
  it("[OFE-005 AC1] searches once, writes the search id into the address and lists the first 20 offers", async () => {
    const { view, client } = open(QUERY);
    await view.done;
    await settle();

    expect(client.flights.search).toHaveBeenCalledTimes(1);
    expect(client.flights.search).toHaveBeenCalledWith(
      {
        mode: "simple",
        originLocationCode: "PAR",
        destinationLocationCode: "NYC",
        departureDate: "2026-11-20",
        returnDate: "2026-11-27",
        adults: 2,
        children: 0,
        infants: 0,
        travelClass: "ECONOMY",
        resultOptions: { limit: 0 },
      },
      { timeoutMs: SEARCH_TIMEOUT_MS },
    );
    expect(SEARCH_TIMEOUT_MS).toBe(60_000);
    // replaceState: the same history entry now carries the search id, the query is kept.
    expect(params().get("search")).toBe(SEARCH_ID);
    expect(params().get("from")).toBe("PAR");
    expect(client.flights.getSearch).not.toHaveBeenCalled();
    expect(client.flights.listResults).toHaveBeenCalledTimes(1);
    expect(client.flights.listResults).toHaveBeenCalledWith(
      { searchId: SEARCH_ID, sort: "best", limit: 20 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    expect(cards()).toHaveLength(2);
    expect(text($("[data-results-count]"))).toBe("42 flights");
    expect(text($("[data-results-title]"))).toBe("Flights from Paris (PAR) to New York (NYC)");
    expect(document.title).toBe("Flights from Paris (PAR) to New York (NYC)");
    expect(text($("[data-search-summary]"))).toBe(
      "Paris (PAR) → New York (NYC) · Fri 20 Nov – Fri 27 Nov · 2 adults · Economy",
    );
    // Airline names for the filters: one reference.airlines.list call for the codes of the facets.
    expect(client.reference.airlines.list).toHaveBeenCalledTimes(1);
    expect(client.reference.airlines.list).toHaveBeenCalledWith({ iataCodes: ["AF", "KL"], limit: 100 });
    expect(text(option("carriers", "KL").closest("label"))).toContain("KLM Royal Dutch Airlines (KL)");
    expect(text(option("carriers", "AF").closest("label"))).toContain("Air France (AF) (20) from €230.00");
  });

  it("[OFE-005 AC1] filters and sort round-trip through the query string and survive a reload without a new search", async () => {
    const first = open(QUERY);
    await first.view.done;
    await settle();
    const { client } = first;

    tick(option("stops", "0"));
    await settle();
    expect(lastList(client)).toEqual({ searchId: SEARCH_ID, sort: "best", stops: [0], limit: 20 });
    expect(params().get("stops")).toBe("0");

    tick(option("carriers", "AF"));
    tick(option("departureWindow", "1:18:00-23:59"));
    tick(option("refundable", "true"));
    tick(option("minIncludedCheckedBags", "1"));
    commit(/** @type {HTMLInputElement} */ ($("#filter-max-price")), "500");
    commit(/** @type {HTMLInputElement} */ ($("#filter-duration")), "900");
    commit(/** @type {HTMLSelectElement} */ ($("select[data-sort]")), "price");
    await settle();

    const expected = {
      searchId: SEARCH_ID,
      sort: "price",
      stops: [0],
      carriers: ["AF"],
      maxPrice: "500",
      departureWindow: ["1:18:00-23:59"],
      maxDurationMinutes: 900,
      minIncludedCheckedBags: 1,
      refundable: true,
      limit: 20,
    };
    expect(lastList(client)).toEqual(expected);
    expect(Object.fromEntries(params())).toEqual({
      trip: "return",
      from: "PAR",
      to: "NYC",
      depart: "2026-11-20",
      return: "2026-11-27",
      adults: "2",
      children: "0",
      infants: "0",
      cabin: "ECONOMY",
      search: SEARCH_ID,
      stops: "0",
      carriers: "AF",
      maxPrice: "500",
      departureWindow: "1:18:00-23:59",
      maxDurationMinutes: "900",
      minIncludedCheckedBags: "1",
      refundable: "true",
      sort: "price",
    });

    // Reload: the same address in a fresh page.
    first.view.destroy();
    loadPage();
    const reload = fakeClient();
    const second = start(
      { config: /** @type {never} */ (CONFIG), client: /** @type {never} */ (reload) },
      {
        today: TODAY,
      },
    );
    views.push(/** @type {{ destroy: () => void }} */ (second));
    await second?.done;
    await settle();

    expect(client.flights.search).toHaveBeenCalledTimes(1);
    expect(reload.flights.search).not.toHaveBeenCalled();
    expect(reload.flights.getSearch).toHaveBeenCalledWith({ searchId: SEARCH_ID });
    expect(reload.flights.listResults).toHaveBeenCalledTimes(1);
    expect(lastList(reload)).toEqual(expected);
    // The sidebar and the sort show the filters of the address.
    expect(option("stops", "0").checked).toBe(true);
    expect(option("stops", "1").checked).toBe(false);
    expect(option("carriers", "AF").checked).toBe(true);
    expect(option("departureWindow", "1:18:00-23:59").checked).toBe(true);
    expect(option("refundable", "true").checked).toBe(true);
    expect(option("minIncludedCheckedBags", "1").checked).toBe(true);
    expect(/** @type {HTMLInputElement} */ ($("#filter-max-price")).value).toBe("500");
    expect(/** @type {HTMLInputElement} */ ($("#filter-duration")).value).toBe("900");
    expect(/** @type {HTMLSelectElement} */ ($("select[data-sort]")).value).toBe("price");
    expect(cards()).toHaveLength(2);
  });

  it("[OFE-005] a filter change drops the cursor and aborts the call still running", async () => {
    /** @type {Array<(page: unknown) => void>} */
    const pending = [];
    const client = fakeClient({
      listResults: () => new Promise((resolve) => pending.push(resolve)),
    });
    const { view } = open(QUERY, client);
    await settle();
    pending.shift()?.(resultsPage({ nextCursor: "eyJvIjoyMH0" }));
    await view.done;

    tick(option("stops", "0"));
    tick(option("stops", "1"));
    await settle();
    const calls = client.flights.listResults.mock.calls;
    expect(calls).toHaveLength(3);
    const [, second, third] = calls;
    expect(second?.[1].signal.aborted).toBe(true);
    expect(third?.[1].signal.aborted).toBe(false);
    expect(third?.[0]).toEqual({ searchId: SEARCH_ID, sort: "best", stops: [0, 1], limit: 20 });
    expect(third?.[0]).not.toHaveProperty("cursor");

    // The aborted answer arrives late and is ignored; the current one is shown.
    pending.shift()?.(resultsPage({ offers: [offer(9)], total: 1 }));
    pending.shift()?.(resultsPage({ offers: [offer(7), offer(8)], total: 2 }));
    await settle();
    expect(text($("[data-results-count]"))).toBe("2 flights");
    expect(cards().map((card) => card.querySelector("article")?.getAttribute("data-offer-id"))).toEqual([
      "off_01JOFFER00000007",
      "off_01JOFFER00000008",
    ]);
  });

  it("[OFE-005] 'Show more flights' appends page.next() and moves the focus to the first new card", async () => {
    const second = resultsPage({ offers: [offer(3), offer(4)], nextCursor: null });
    const firstPage = resultsPage({ nextCursor: "eyJvIjoyMH0", nextPage: second });
    const { view } = open(QUERY, fakeClient({ listResults: async () => firstPage }));
    await view.done;
    await settle();

    const more = /** @type {HTMLButtonElement} */ ($('[data-action="load-more"]'));
    expect($("[data-load-more]").hidden).toBe(false);
    expect(more.hidden).toBe(false);
    expect(text($("[data-load-more-status]"))).toBe("Showing 2 of 42");
    more.click();
    await settle();

    expect(firstPage.next).toHaveBeenCalledTimes(1);
    expect(cards()).toHaveLength(4);
    expect(document.activeElement).toBe(cards()[2]?.querySelector("article"));
    expect(text($("[data-load-more-status]"))).toBe("Showing 4 of 42");
    expect(more.hidden).toBe(true);
  });

  it("[OFE-005] a sort chosen while the search runs is mirrored and used for the first page", async () => {
    /** @type {(search: unknown) => void} */
    let answer = () => {};
    const client = fakeClient({ search: () => new Promise((resolve) => (answer = resolve)) });
    const { view } = open(QUERY, client);
    await settle();

    commit(/** @type {HTMLSelectElement} */ ($("select[data-sort]")), "duration");
    await settle();
    expect(params().get("sort")).toBe("duration");
    expect(client.flights.listResults).not.toHaveBeenCalled();

    answer(structuredClone(SEARCH));
    await view.done;
    expect(client.flights.listResults).toHaveBeenCalledTimes(1);
    expect(lastList(client)).toEqual({ searchId: SEARCH_ID, sort: "duration", limit: 20 });
  });

  it("[OFE-005] a multi-city query searches in ADVANCED mode with the Amadeus body", async () => {
    const { view, client } = open(
      "trip=multi&legs=PAR-NYC-2026-11-20,NYC-MIA-2026-11-25&adults=2&children=1&infants=1&cabin=BUSINESS",
    );
    await view.done;

    expect(client.flights.search).toHaveBeenCalledWith(
      {
        mode: "advanced",
        query: {
          originDestinations: [
            {
              id: "1",
              originLocationCode: "PAR",
              destinationLocationCode: "NYC",
              departureDateTimeRange: { date: "2026-11-20" },
            },
            {
              id: "2",
              originLocationCode: "NYC",
              destinationLocationCode: "MIA",
              departureDateTimeRange: { date: "2026-11-25" },
            },
          ],
          travelers: [
            { id: "1", travelerType: "ADULT" },
            { id: "2", travelerType: "ADULT" },
            { id: "3", travelerType: "CHILD" },
            { id: "4", travelerType: "HELD_INFANT", associatedAdultId: "1" },
          ],
          sources: ["GDS"],
          searchCriteria: {
            flightFilters: {
              cabinRestrictions: [
                { cabin: "BUSINESS", coverage: "MOST_SEGMENTS", originDestinationIds: ["1", "2"] },
              ],
            },
          },
        },
        resultOptions: { limit: 0 },
      },
      { timeoutMs: SEARCH_TIMEOUT_MS },
    );
  });

  it("[OFE-005] trips read from the query: return, one way and incomplete", () => {
    const read = (/** @type {string} */ query) =>
      summaryFromQuery(readSearchQuery(new URLSearchParams(query)));
    const roundTrip = read(QUERY);
    expect(roundTrip?.tripType).toBe("round_trip");
    expect(searchRequestFor(/** @type {never} */ (roundTrip))).toEqual({
      mode: "simple",
      originLocationCode: "PAR",
      destinationLocationCode: "NYC",
      departureDate: "2026-11-20",
      returnDate: "2026-11-27",
      adults: 2,
      children: 0,
      infants: 0,
      travelClass: "ECONOMY",
    });
    expect(read("trip=oneway&from=LON&to=MAD&depart=2026-12-01")?.tripType).toBe("one_way");
    expect(read("trip=return&from=LON&to=MAD&depart=2026-12-01")?.legs).toHaveLength(1);
    expect(read("from=LON&depart=2026-12-01")).toBeNull();
    expect(read("trip=multi&legs=PAR-NYC-2026-11-20")).toBeNull();
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("[OFE-005] a page opened without a search shows the form instead of searching", async () => {
    const { view, client } = open("from=PAR");
    await view.done;
    expect(client.flights.search).not.toHaveBeenCalled();
    expect(/** @type {HTMLDetailsElement} */ ($("details[data-search-panel]")).open).toBe(true);
    expect(text($("[data-results-title]"))).toBe("Search flights");
    expect($("[data-results-layout]").hidden).toBe(true);
  });
});

describe("results page: offer cards", () => {
  it("[OFE-005 AC2] cards show the API's totals as text, never a sum of the price parts", async () => {
    const innerHtml = vi.spyOn(Element.prototype, "innerHTML", "set");
    const hostile = offer(5, { total: "1234.50", perAdult: "617.25", carriers: ["ZZ"] });
    hostile.itineraries[0].segments[0].departure.airportName = '<img src="x" onerror="alert(1)">';
    const client = fakeClient({ listResults: async () => resultsPage({ offers: [hostile], total: 1 }) });
    client.reference.airlines.list.mockResolvedValue({
      data: [{ iataCode: "ZZ", name: "<b>Zed Air</b>" }],
      page: { nextCursor: null, limit: 100 },
    });
    const { view } = open(QUERY, client);
    await view.done;
    await settle();

    const [card] = cards();
    const price = text(card?.querySelector('[data-field="price"]'));
    expect(price).toBe(formatMoney({ amount: "1234.50", currency: "EUR" }, "en-GB"));
    expect(price).toBe("€1,234.50");
    expect(text(card?.querySelector('[data-field="perAdult"]'))).toBe("€617.25 per adult");
    expect(text(card?.querySelector('[data-field="priceNote"]'))).toBe("Total for 2 travellers");
    // base 100.00 + taxes 20.00 + fees 5.00 = 125.00 appears nowhere: the card adds nothing up.
    expect(text(card)).not.toContain("125");
    expect(card?.querySelector("a")?.getAttribute("aria-label")).toBe("Select this flight for €1,234.50");
    // API data stays text: no element is made from it and no HTML is parsed while rendering.
    expect(card?.querySelector("img, b")).toBeNull();
    expect(text(card)).toContain('<img src="x" onerror="alert(1)"> (CDG), terminal 2E');
    expect(innerHtml).not.toHaveBeenCalled();
  });

  it("[OFE-005] cards show each bound, the fare facts, the airline name and code, and the flight details", async () => {
    const { view } = open(QUERY);
    await view.done;
    await settle();

    const card = /** @type {HTMLElement} */ (cards()[0]);
    const [outbound, inbound] = Array.from(card.querySelectorAll("[data-itinerary]"));
    expect(text(outbound)).toBe(
      "Outbound 21:35 CDG 15 h 35 min 1 stop via AMS 07:10 +1 day JFK Air France (AF)",
    );
    expect(outbound?.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-20T21:35:00");
    expect(text(inbound)).toBe("Return 10:00 JFK 6 h 25 min Direct 22:25 CDG Air France (AF)");
    expect(Array.from(card.querySelectorAll("[data-offer-tags] li"), text)).toEqual(["Cheapest"]);
    expect(Array.from(card.querySelectorAll("[data-offer-facts] li"), text)).toEqual([
      "ECONOMY LIGHT",
      "1 checked bag included",
      "Non-refundable",
      "Changes allowed",
      "3 seats left at this price",
    ]);
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/offer.html?offer=off_01JOFFER00000001");
    const details = Array.from(card.querySelectorAll("[data-offer-segments] [data-segment]"), text);
    expect(details[0]).toBe(
      "Air France (AF) · AF1234 20 Nov 2026, 21:35 CDG, terminal 2E 20 Nov 2026, 22:50 Schiphol (AMS) 8 h 20 min · Economy · Airbus A350-900",
    );
    expect(text(card.querySelector("[data-layover]"))).toBe("2 h 5 min connection in Schiphol (AMS)");
    // The second offer's airline name comes from reference.airlines.list.
    expect(text(cards()[1]?.querySelector('[data-field="carriers"]'))).toBe("KLM Royal Dutch Airlines (KL)");
  });
});

describe("results page: states", () => {
  it("[OFE-005 AC3] searching shows the summary, skeleton cards and 'Searching airlines…'", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    /** @type {(search: unknown) => void} */
    let answer = () => {};
    const client = fakeClient({ search: () => new Promise((resolve) => (answer = resolve)) });
    const { view } = open(QUERY, client);
    await vi.advanceTimersByTimeAsync(200);

    expect(text($("[data-search-summary]"))).toBe("PAR → NYC · Fri 20 Nov – Fri 27 Nov · 2 adults · Economy");
    expect($("[data-results-layout]").hidden).toBe(false);
    expect(document.querySelectorAll("[data-offers] > li[data-offer-skeleton]")).toHaveLength(3);
    expect($("[data-offers] > li[data-offer-skeleton]").getAttribute("aria-hidden")).toBe("true");
    expect($("[data-offers]").getAttribute("aria-busy")).toBe("true");
    expect(text($("[data-results-count]"))).toBe("Searching airlines…");
    expect(text($("[data-live-region]"))).toBe("Searching airlines…");

    answer(structuredClone(SEARCH));
    await view.done;
    await vi.advanceTimersByTimeAsync(200);
    expect(document.querySelectorAll("[data-offer-skeleton]")).toHaveLength(0);
    expect($("[data-offers]").getAttribute("aria-busy")).toBe("false");
    expect(text($("[data-live-region]"))).toBe("42 flights");
  });

  it("[OFE-005 AC3] no offers shows 'No flights found', the form pre-filled, nearby dates and airports", async () => {
    const client = fakeClient({
      search: async () => ({
        ...structuredClone(SEARCH),
        resultCount: 0,
        summary: {
          tripType: "round_trip",
          legs: [
            {
              originDestinationId: "1",
              originCode: "CDG",
              destinationCode: "JFK",
              departureDate: "2026-11-20",
            },
            {
              originDestinationId: "2",
              originCode: "JFK",
              destinationCode: "CDG",
              departureDate: "2026-11-27",
            },
          ],
          travelers: { adults: 1, children: 0, infants: 0, total: 1 },
          travelClass: "ECONOMY",
        },
      }),
      listResults: async () => resultsPage({ offers: [], total: 0 }),
    });
    const { view } = open(
      "trip=return&from=CDG&to=JFK&depart=2026-11-20&return=2026-11-27&adults=1&children=0&infants=0&cabin=ECONOMY",
      client,
    );
    await view.done;
    await settle();

    const state = $('[data-results-state] [data-state="no-offers"]');
    expect(text(state.querySelector("h2"))).toBe("No flights found");
    expect($("[data-results-layout]").hidden).toBe(true);
    expect(/** @type {HTMLDetailsElement} */ ($("details[data-search-panel]")).open).toBe(true);
    expect(/** @type {HTMLInputElement} */ ($('input[name="depart"]')).value).toBe("2026-11-20");
    expect(/** @type {HTMLInputElement} */ ($('input[name="return"]')).value).toBe("2026-11-27");
    const links = Array.from(state.querySelectorAll("[data-suggestions] a"), (link) => [
      text(link),
      link.getAttribute("href"),
    ]);
    expect(links).toEqual([
      [
        "One day earlier: Thu 19 Nov – Thu 26 Nov",
        "/search.html?trip=return&from=CDG&to=JFK&depart=2026-11-19&return=2026-11-26&adults=1&children=0&infants=0&cabin=ECONOMY",
      ],
      [
        "One day later: Sat 21 Nov – Sat 28 Nov",
        "/search.html?trip=return&from=CDG&to=JFK&depart=2026-11-21&return=2026-11-28&adults=1&children=0&infants=0&cabin=ECONOMY",
      ],
      [
        "From any airport in Paris (PAR)",
        "/search.html?trip=return&from=PAR&to=JFK&depart=2026-11-20&return=2026-11-27&adults=1&children=0&infants=0&cabin=ECONOMY",
      ],
      [
        "To any airport in New York (NYC)",
        "/search.html?trip=return&from=CDG&to=NYC&depart=2026-11-20&return=2026-11-27&adults=1&children=0&infants=0&cabin=ECONOMY",
      ],
    ]);
    // No earlier date before today.
    const tomorrow = summaryFromQuery(
      readSearchQuery(new URLSearchParams("trip=oneway&from=CDG&to=JFK&depart=2026-10-18")),
    );
    expect(nearbyDates(/** @type {never} */ (tomorrow), TODAY, "en-GB").map((s) => s.label)).toEqual([
      "One day later: Mon 19 Oct",
    ]);
  });

  it("[OFE-005 AC3] filters that exclude everything show 'No flights match these filters' with Clear filters", async () => {
    const client = fakeClient({
      listResults: async (/** @type {Record<string, unknown>} */ request) =>
        request["carriers"] ? resultsPage({ offers: [], total: 0 }) : resultsPage(),
    });
    const { view } = open(`${QUERY}&search=${SEARCH_ID}&carriers=KL&stops=0`, client);
    await view.done;
    await settle();

    const box = $('[data-results-message] [data-state="no-match"]');
    expect(text(box.querySelector('[data-field="title"]'))).toBe("No flights match these filters");
    expect($("[data-results-layout]").hidden).toBe(false);
    expect($("form[data-filters]").hidden).toBe(false);
    expect(option("carriers", "KL").checked).toBe(true);

    /** @type {HTMLButtonElement} */ (box.querySelector('[data-action="clear-filters"]')).click();
    await settle();
    expect(lastList(client)).toEqual({ searchId: SEARCH_ID, sort: "best", limit: 20 });
    expect(params().has("carriers")).toBe(false);
    expect(params().has("stops")).toBe(false);
    expect(params().get("search")).toBe(SEARCH_ID);
    expect(option("carriers", "KL").checked).toBe(false);
    expect($('[data-results-message] [data-state="no-match"]')).toBeNull();
    expect(cards()).toHaveLength(2);
    expect(document.activeElement).toBe($("[data-results-count]"));
  });

  it("[OFE-005 AC3] a search without any offer is 'No flights found', even with filters in the address", async () => {
    const client = fakeClient({
      search: async () => ({ ...structuredClone(SEARCH), resultCount: 0 }),
      listResults: async () => resultsPage({ offers: [], total: 0 }),
    });
    const { view } = open(`${QUERY}&stops=0`, client);
    await view.done;
    await settle();

    expect(lastList(client)).toEqual({ searchId: SEARCH_ID, sort: "best", stops: [0], limit: 20 });
    expect(text($('[data-results-state] [data-state="no-offers"] h2'))).toBe("No flights found");
    expect($('[data-results-message] [data-state="no-match"]')).toBeNull();
  });

  it("[OFE-005 AC3] 410 SEARCH_EXPIRED shows 'Prices have expired'; Refresh runs the same search again", async () => {
    const expired = new ExpiredError({ code: "SEARCH_EXPIRED", message: "Expired", status: 410 });
    let listed = 0;
    const client = fakeClient({
      search: async () => ({ ...structuredClone(SEARCH), id: NEXT_SEARCH_ID }),
      listResults: async () => {
        listed += 1;
        if (listed === 1) {
          throw expired;
        }
        return resultsPage();
      },
    });
    const { view } = open(`${QUERY}&search=${SEARCH_ID}&stops=0`, client);
    await view.done;
    await settle();

    const state = $("[data-results-state] [data-state]");
    expect(state.getAttribute("data-state")).toBe("search-expired");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Prices have expired");
    expect($("[data-results-layout]").hidden).toBe(true);
    const refresh = /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]'));
    expect(text(refresh)).toBe("Refresh results");
    expect(client.flights.search).not.toHaveBeenCalled();

    refresh.click();
    await settle();
    expect(client.flights.search).toHaveBeenCalledTimes(1);
    expect(client.flights.search).toHaveBeenCalledWith(
      { ...SEARCH.criteria.request, resultOptions: { limit: 0 } },
      { timeoutMs: SEARCH_TIMEOUT_MS },
    );
    // The new search replaces the id; the filters stay.
    expect(params().get("search")).toBe(NEXT_SEARCH_ID);
    expect(lastList(client)).toEqual({ searchId: NEXT_SEARCH_ID, sort: "best", stops: [0], limit: 20 });
    expect(cards()).toHaveLength(2);
    expect(document.activeElement).toBe($("[data-results-count]"));
  });

  it("[OFE-005 AC3] a search that getSearch reports expired shows the same state without listing offers", async () => {
    const client = fakeClient({ getSearch: async () => ({ ...structuredClone(SEARCH), status: "expired" }) });
    const { view } = open(`search=${SEARCH_ID}`, client);
    await view.done;
    await settle();
    expect($("[data-results-state] [data-state]").getAttribute("data-state")).toBe("search-expired");
    // The summary is rebuilt from getSearch for a bookmark without the search query.
    expect(text($("[data-search-summary]"))).toBe(
      "Paris (PAR) → New York (NYC) · Fri 20 Nov – Fri 27 Nov · 2 adults · Economy",
    );
    expect(client.flights.listResults.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it.each([
    ["SUPPLIER_TIMEOUT", 504],
    ["SUPPLIER_UNAVAILABLE", 503],
  ])("[OFE-005 AC3] %s shows 'Airlines are not answering right now' with Retry", async (code, status) => {
    let attempts = 0;
    const client = fakeClient({
      search: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new SupplierError({ code, message: "Supplier", status });
        }
        return structuredClone(SEARCH);
      },
    });
    const { view } = open(QUERY, client);
    await view.done;

    const state = $("[data-results-state] [data-state]");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Airlines are not answering right now");
    expect(params().has("search")).toBe(false);
    const retry = /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]'));
    expect(text(retry)).toBe("Try again");
    retry.click();
    await settle();
    expect(client.flights.search).toHaveBeenCalledTimes(2);
    expect(client.flights.search.mock.calls[1]?.[0]).toEqual(client.flights.search.mock.calls[0]?.[0]);
    expect(params().get("search")).toBe(SEARCH_ID);
    expect(cards()).toHaveLength(2);
  });

  it("[OFE-005 AC3] 400 VALIDATION_FAILED goes back to the form with field errors", async () => {
    const client = fakeClient({
      search: async () => {
        throw new ValidationError({
          code: "VALIDATION_FAILED",
          message: "Invalid request",
          status: 400,
          fieldErrors: [{ path: "/departureDate", code: "format", message: "must match format date" }],
        });
      },
    });
    const { view } = open(QUERY, client);
    await view.done;

    expect(/** @type {HTMLDetailsElement} */ ($("details[data-search-panel]")).open).toBe(true);
    expect($('input[name="depart"]').getAttribute("aria-invalid")).toBe("true");
    const summary = $("form[data-search-form] [data-error-summary]");
    expect(summary.hidden).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(text(summary)).toContain("Enter a value in the right format");
    expect($("[data-results-layout]").hidden).toBe(true);
  });

  it("[OFE-005 AC3] a 400 of a multi-city search maps the pointers into its ADVANCED body onto the flight rows", async () => {
    const client = fakeClient({
      search: async () => {
        throw new ValidationError({
          code: "VALIDATION_FAILED",
          message: "Invalid request",
          status: 400,
          fieldErrors: [
            {
              path: "/query/originDestinations/1/departureDateTimeRange/date",
              code: "format",
              message: "must match format date",
            },
          ],
        });
      },
    });
    const { view } = open("trip=multi&legs=PAR-NYC-2026-11-20,NYC-MIA-2026-11-25&adults=1", client);
    await view.done;

    const dates = Array.from(
      document.querySelectorAll("form[data-search-form] [data-legs] input[data-leg-date]"),
      (input) => /** @type {HTMLInputElement} */ (input),
    );
    expect(dates.map((input) => input.value)).toEqual(["2026-11-20", "2026-11-25"]);
    expect(dates[0]?.hasAttribute("aria-invalid")).toBe(false);
    expect(dates[1]?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe($("form[data-search-form] [data-error-summary]"));
  });

  it("[OFE-005] the shared states: no supplier without Retry, a lost connection with Retry", async () => {
    const notConfigured = fakeClient({
      search: async () => {
        throw new SupplierError({ code: "SUPPLIER_NOT_CONFIGURED", message: "No supplier", status: 424 });
      },
    });
    const first = open(QUERY, notConfigured);
    await first.view.done;
    expect(text($('[data-results-state] [data-field="title"]'))).toBe("Flight search is not available yet");
    expect($('[data-results-state] [data-action="retry"]')).toBeNull();

    first.view.destroy();
    loadPage();
    const offline = fakeClient({
      search: async () => {
        throw new ConnectionError({ code: "NETWORK_ERROR", message: "Failed to fetch", status: 0 });
      },
    });
    const second = open(QUERY, offline);
    await second.view.done;
    expect($("[data-results-state] [data-state]").getAttribute("data-state")).toBe("unavailable");
    expect($('[data-results-state] [data-action="retry"]')).not.toBeNull();
  });

  it("[OFE-005] a search that failed at the supplier, opened again, offers a new search", async () => {
    const client = fakeClient({
      getSearch: async () => ({
        ...structuredClone(SEARCH),
        status: "failed",
        error: { code: "SUPPLIER_TIMEOUT", message: "Timeout", status: 504 },
      }),
      search: async () => ({ ...structuredClone(SEARCH), id: NEXT_SEARCH_ID }),
    });
    const { view } = open(`search=${SEARCH_ID}`, client);
    await view.done;
    const state = $("[data-results-state] [data-state]");
    expect(state.getAttribute("data-state")).toBe("supplier-timeout");
    /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]')).click();
    await settle();
    expect(client.flights.search).toHaveBeenCalledWith(
      { ...SEARCH.criteria.request, resultOptions: { limit: 0 } },
      { timeoutMs: SEARCH_TIMEOUT_MS },
    );
    expect(params().get("search")).toBe(NEXT_SEARCH_ID);
  });
});

describe("results page module", () => {
  it("[OFE-005] boots, then runs the results page with the page's client", async () => {
    const client = fakeClient();
    pageBoot.context = { config: CONFIG, session: null, client };
    history.replaceState(null, "", `/search.html?${QUERY}`);
    try {
      vi.resetModules();
      await import("../src/pages/search.js");
      await settle();
      await settle();
    } finally {
      pageBoot.context = null;
    }
    expect(document.documentElement.dataset.js).toBe("on");
    expect(client.flights.search).toHaveBeenCalledTimes(1);
    expect(params().get("search")).toBe(SEARCH_ID);
    expect(cards()).toHaveLength(2);
  });
});
