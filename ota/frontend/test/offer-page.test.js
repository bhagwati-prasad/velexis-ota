// The offer page (ota/frontend/docs/pages.md §5): offer.html with its partials expanded by the build's include plugin,
// run by src/pages/offer.js against a fake SDK. It covers the offer in full view, the branded-fare upsell only when
// `features.brandedFareUpsell` is on (and the original fare alone when it fails), pricing the chosen fare family and
// opening the price page with the priced offer, and the states of §5 for their error codes.
import {
  ConnectionError,
  ExpiredError,
  NotFoundError,
  RateLimitError,
  ServerError,
  SoldOutError,
  SupplierError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { differenceText, familiesFromUpsell, familyFromOffer } from "../src/components/fare-families.js";
import { formatLocalDate, formatMoney } from "../src/lib/format.js";
import { PRICE_INCLUDE, PRICE_TIMEOUT_MS, baggageRows, resultsLinks, start } from "../src/pages/offer.js";
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

/** The test window's origin: the page compares the referrer with its own. */
const ORIGIN = globalThis.location.origin;
const SEARCH_ID = "srch_01JOFFERPAGE000001";
const OFFER_ID = "off_01JOFFERPAGEBASE001";
const FLEX_ID = "off_01JOFFERPAGEFLEX001";
const PREMIUM_ID = "off_01JOFFERPAGEPREM001";
const PRICED_ID = "prc_01JOFFERPAGEPRICED1";
/** The results page the traveller came from (with its search id, filters and sort). */
const RESULTS_QUERY = `trip=return&from=PAR&to=NYC&depart=DEPART&return=RETURN&adults=2&children=1&infants=0&cabin=ECONOMY&search=${SEARCH_ID}&stops=0,1&sort=price`;

/**
 * A `YYYY-MM-DD` date some days from today (flights in the fixtures never lie in the past).
 * @param {number} days
 */
function dateFromToday(days) {
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days))
    .toISOString()
    .slice(0, 10);
}
const DEPART = dateFromToday(30);
const NEXT_DAY = dateFromToday(31);
const RETURN = dateFromToday(37);
const REFERRER = `${ORIGIN}/search.html?${RESULTS_QUERY.replace("DEPART", DEPART).replace("RETURN", RETURN)}`;

const CONFIG = Object.freeze({
  defaultLocale: "en-GB",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { brandedFareUpsell: false },
});
const UPSELL_CONFIG = Object.freeze({ ...CONFIG, features: { brandedFareUpsell: true } });

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });

/**
 * One flight.
 * @param {string} id
 * @param {string} from
 * @param {string} to
 * @param {string} departAt
 * @param {string} arriveAt
 * @param {object | null} [layoverAfter]
 */
const segment = (id, from, to, departAt, arriveAt, layoverAfter = null) => ({
  id,
  departure: { iataCode: from, terminal: from === "CDG" ? "2E" : null, at: departAt, airportName: null },
  arrival: { iataCode: to, terminal: null, at: arriveAt, airportName: null },
  carrierCode: "AF",
  carrierName: "Air France",
  number: "1234",
  flightNumber: `AF${id}234`,
  operating: null,
  aircraft: { code: "359", name: "Airbus A350-900" },
  duration: null,
  durationMinutes: 300,
  numberOfStops: 0,
  cabin: "ECONOMY",
  brandedFare: "LIGHT",
  brandedFareLabel: "ECONOMY LIGHT",
  layoverAfter,
});

/**
 * The fare of one traveller on one flight.
 * @param {string} segmentId
 * @param {number} bags
 */
const fareDetail = (segmentId, bags) => ({
  segmentId,
  cabin: "ECONOMY",
  fareBasis: "VLOWFR",
  brandedFare: "LIGHT",
  brandedFareLabel: "ECONOMY LIGHT",
  class: "V",
  includedCheckedBags: { quantity: bags, weight: bags > 0 ? 23 : null, weightUnit: bags > 0 ? "KG" : null },
  includedCabinBags: { quantity: 1, weight: null, weightUnit: null },
  amenities: [
    {
      code: "0CC",
      description: "PRE RESERVED SEAT ASSIGNMENT",
      status: "chargeable",
      amenityType: "PRE_RESERVED_SEAT",
    },
    { code: "0L7", description: "SNACK", status: "included", amenityType: "MEAL" },
  ],
});

/**
 * The offer in full view: a return trip for two adults and a child whose outbound connects in Amsterdam and lands
 * the next day. Its total deliberately differs from base + taxes + fees: the page must show the API's total.
 */
function fullOffer() {
  return {
    id: OFFER_ID,
    searchId: SEARCH_ID,
    origin: "search",
    baseOfferId: null,
    upsellId: null,
    status: "active",
    source: "GDS",
    expiresAt: `${DEPART}T00:00:00Z`,
    createdAt: `${DEPART}T00:00:00Z`,
    price: {
      currency: "EUR",
      total: eur("1240.56"),
      base: eur("100.00"),
      taxes: eur("20.00"),
      fees: eur("5.00"),
      additionalServices: null,
      perAdult: eur("441.20"),
    },
    summary: {
      tripType: "round_trip",
      originCode: "CDG",
      destinationCode: "JFK",
      departureAt: `${DEPART}T21:35:00`,
      returnAt: `${RETURN}T10:00:00`,
      totalDurationMinutes: 1320,
      maxStops: 1,
      marketingCarriers: ["AF"],
      cabins: ["ECONOMY"],
      brandedFares: [
        { itineraryIndex: 0, code: "LIGHT", label: "ECONOMY LIGHT" },
        { itineraryIndex: 1, code: "LIGHT", label: "ECONOMY LIGHT" },
      ],
      includedCheckedBags: { quantity: 0, weight: null, weightUnit: null },
      includedCabinBags: { quantity: 1, weight: null, weightUnit: null },
      refundable: false,
      changeable: true,
      numberOfBookableSeats: 3,
      tags: [],
    },
    itineraries: [
      {
        index: 0,
        originCode: "CDG",
        destinationCode: "JFK",
        departureAt: `${DEPART}T21:35:00`,
        arrivalAt: `${NEXT_DAY}T07:10:00`,
        duration: "PT15H35M",
        durationMinutes: 935,
        stops: 1,
        stopAirports: ["AMS"],
        arrivalDayOffset: 1,
        marketingCarriers: ["AF"],
        segments: [
          segment("1", "CDG", "AMS", `${DEPART}T21:35:00`, `${DEPART}T22:50:00`, {
            duration: "PT2H5M",
            durationMinutes: 125,
            airportChange: false,
            overnight: true,
            nextDepartureCode: "AMS",
          }),
          segment("2", "AMS", "JFK", `${NEXT_DAY}T00:55:00`, `${NEXT_DAY}T07:10:00`),
        ],
      },
      {
        index: 1,
        originCode: "JFK",
        destinationCode: "CDG",
        departureAt: `${RETURN}T10:00:00`,
        arrivalAt: `${RETURN}T22:25:00`,
        duration: "PT6H25M",
        durationMinutes: 385,
        stops: 0,
        stopAirports: [],
        arrivalDayOffset: 0,
        marketingCarriers: ["AF"],
        segments: [segment("3", "JFK", "CDG", `${RETURN}T10:00:00`, `${RETURN}T22:25:00`)],
      },
    ],
    travelerPricings: ["ADULT", "ADULT", "CHILD"].map((travelerType, index) => ({
      travelerId: String(index + 1),
      travelerType,
      fareOption: "STANDARD",
      associatedAdultId: null,
      // The adults have no checked bag on the long flight from Amsterdam; the child has one on every flight.
      segments: [fareDetail("1", 1), fareDetail("2", travelerType === "CHILD" ? 1 : 0), fareDetail("3", 1)],
    })),
    validatingAirlineCodes: ["AF"],
    lastTicketingDate: DEPART,
    numberOfBookableSeats: 3,
    dictionaries: {
      locations: {
        CDG: { cityCode: "PAR", countryCode: "FR", airportName: "Charles de Gaulle", cityName: "Paris" },
        JFK: { cityCode: "NYC", countryCode: "US", airportName: "John F Kennedy", cityName: "New York" },
        AMS: { cityCode: "AMS", countryCode: "NL", airportName: "Schiphol", cityName: "Amsterdam" },
      },
      carriers: { AF: { name: "Air France" } },
    },
  };
}

/**
 * A comparison cell.
 * @param {string} offerId
 * @param {string} status
 * @param {string | null} [detail]
 */
const cell = (offerId, status, detail = null) => ({ offerId, status, detail });

/** The upsell result: the base fare and two other fare families of the same flights. */
function upsellResult() {
  return {
    id: "ups_01JOFFERPAGEUPSELL01",
    baseOfferId: OFFER_ID,
    offerIds: [OFFER_ID],
    offers: [],
    comparison: {
      columns: [
        {
          offerId: OFFER_ID,
          isBaseOffer: true,
          brandedFare: "LIGHT",
          brandedFareLabel: "ECONOMY LIGHT",
          cabin: "ECONOMY",
          price: eur("1240.56"),
          priceDifference: eur("0.00"),
          includedCheckedBags: { quantity: 0, weight: null, weightUnit: null },
          refundable: false,
          changeable: true,
        },
        {
          offerId: FLEX_ID,
          isBaseOffer: false,
          brandedFare: "FLEX",
          brandedFareLabel: "ECONOMY FLEX",
          cabin: "ECONOMY",
          price: eur("1385.56"),
          priceDifference: eur("145.00"),
          includedCheckedBags: { quantity: 1, weight: 23, weightUnit: "KG" },
          refundable: true,
          changeable: true,
        },
        {
          offerId: PREMIUM_ID,
          isBaseOffer: false,
          brandedFare: null,
          brandedFareLabel: null,
          cabin: "PREMIUM_ECONOMY",
          price: eur("1990.00"),
          priceDifference: eur("749.44"),
          includedCheckedBags: { quantity: 2, weight: 23, weightUnit: "KG" },
          refundable: true,
          changeable: true,
        },
      ],
      rows: [
        {
          key: "checked_bags",
          label: "Checked bags",
          amenityType: "BAGGAGE",
          values: [
            cell(OFFER_ID, "not_offered"),
            cell(FLEX_ID, "included", "1 × 23 kg"),
            cell(PREMIUM_ID, "included", "2 × 23 kg"),
          ],
        },
        {
          key: "refund",
          label: "Refund",
          amenityType: null,
          values: [
            cell(OFFER_ID, "not_offered"),
            cell(FLEX_ID, "chargeable", "Fee from €70"),
            cell(PREMIUM_ID, "included"),
          ],
        },
        {
          key: "seat_selection",
          label: "Seat selection",
          amenityType: "PRE_RESERVED_SEAT",
          values: [cell(OFFER_ID, "chargeable"), cell(FLEX_ID, "included"), cell(PREMIUM_ID, "unknown")],
        },
      ],
    },
    cached: false,
    createdAt: `${DEPART}T00:00:00Z`,
    expiresAt: `${DEPART}T00:00:00Z`,
  };
}

/** @param {string} [id] */
const pricedOffer = (id = PRICED_ID) => ({ id, offerIds: [OFFER_ID], price: { total: eur("1250.56") } });

/**
 * A fake SDK client with the calls of the offer page; each `flights` method can be replaced.
 * @param {{ getOffer?: Function, upsell?: Function, price?: Function }} [overrides]
 */
function fakeClient(overrides = {}) {
  return {
    flights: {
      getOffer: vi.fn(overrides.getOffer ?? (async () => fullOffer())),
      upsell: vi.fn(overrides.upsell ?? (async () => upsellResult())),
      price: vi.fn(overrides.price ?? (async () => pricedOffer())),
    },
  };
}

/** @param {string} code @param {number} status @param {Function} ErrorClass */
const apiError = (ErrorClass, code, status) =>
  new ErrorClass({ code, message: `${code} from the fake API`, status, requestId: "req_offerpage" });

/** @type {Browser | undefined} */
let browser;
/** @type {Document} */
let offerPageDocument;
/** The test window's address before each test. */
let address = "";
/** Views started by the current test, destroyed after it. */
const views = /** @type {Array<{ destroy: () => void }>} */ ([]);

beforeAll(async () => {
  // Expands offer.html with the build's include plugin and parses it once in a happy-dom browser page; each test
  // imports a fresh copy of its body into the test document.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  const html = await transform.handler(readFileSync(join(STOREFRONT_ROOT, "offer.html"), "utf8"), {
    path: "/offer.html",
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
  page.url = `${ORIGIN}/offer.html`;
  page.content = html;
  offerPageDocument = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}, 15_000); // file reads, the include plugin and one happy-dom browser; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

beforeEach(() => {
  address = `${location.pathname}${location.search}`;
  document.body.replaceChildren(
    ...Array.from(offerPageDocument.body.childNodes, (node) => document.importNode(node, true)),
  );
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
  history.replaceState(null, "", address);
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
const families = () => Array.from(document.querySelectorAll("[data-fare-families] > li[data-fare-family]"));
const radio = (/** @type {string} */ offerId) =>
  /** @type {HTMLInputElement} */ (document.querySelector(`input[name="fare"][value="${offerId}"]`));
const stateOf = (/** @type {string} */ container) => $(`${container} [data-state]`);
const params = () => new URLSearchParams(location.search);

/**
 * Starts the offer page at `/offer.html?<query>` with a fake SDK.
 * @param {{ query?: string, client?: ReturnType<typeof fakeClient>, config?: object, referrer?: string }} [options]
 */
function open({
  query = `offer=${OFFER_ID}`,
  client = fakeClient(),
  config = CONFIG,
  referrer = REFERRER,
} = {}) {
  history.replaceState(null, "", `/offer.html?${query}`);
  const navigate = vi.fn();
  const view = start(
    { config: /** @type {never} */ (config), client: /** @type {never} */ (client) },
    { referrer, navigate },
  );
  if (!view) {
    throw new Error("the offer page did not start");
  }
  views.push(view);
  return { view, client, navigate };
}

/** Ticks a fare family's radio button as a click does (checked, then `change`). */
function choose(/** @type {string} */ offerId) {
  const input = radio(offerId);
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Submits the fare form as "Continue with this fare" does. */
function continueWithFare() {
  const form = /** @type {HTMLFormElement} */ ($("form[data-fare-form]"));
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("offer page: the offer and its fares", () => {
  it("[OFE-006 AC1] with brandedFareUpsell off shows the offer in full and makes no upsell call", async () => {
    const { view, client } = open();
    await view.done;
    await settle();

    expect(client.flights.getOffer).toHaveBeenCalledTimes(1);
    expect(client.flights.getOffer).toHaveBeenCalledWith(
      { offerId: OFFER_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.flights.upsell).not.toHaveBeenCalled();

    expect($("[data-offer-content]").hidden).toBe(false);
    expect($("[data-offer-loading]").hidden).toBe(true);
    expect(text($("[data-offer-title]"))).toBe(
      "Return flight from Charles de Gaulle (CDG) to John F Kennedy (JFK)",
    );
    expect(document.title).toBe("Return flight from Charles de Gaulle (CDG) to John F Kennedy (JFK)");
    expect(text($("[data-offer-summary]"))).toBe(
      `Outbound ${formatLocalDate(DEPART, "en-GB")} · Return ${formatLocalDate(RETURN, "en-GB")} · 2 adults, 1 child`,
    );
    // Itinerary rows, flights and the connection in Amsterdam.
    expect(document.querySelectorAll("[data-offer-itineraries] > [data-itinerary]")).toHaveLength(2);
    expect(document.querySelectorAll("[data-offer-segments] [data-segment]")).toHaveLength(3);
    const layover = text($("[data-offer-segments] [data-layover]"));
    expect(layover).toContain("2 h 5 min connection in Schiphol (AMS)");
    expect(layover).toContain("Overnight connection");
    expect(text($("[data-offer-segments] [data-segment]"))).toContain("Air France (AF) · AF1234");
    // Baggage per traveller type, per flight where the flights differ.
    expect(Array.from(document.querySelectorAll("[data-offer-baggage] > [data-baggage]"), text)).toEqual([
      "Adult Checked bags: Charles de Gaulle (CDG)–Schiphol (AMS): 1 bag of 23 kg; Schiphol (AMS)–John F Kennedy (JFK): None; John F Kennedy (JFK)–Charles de Gaulle (CDG): 1 bag of 23 kg Cabin bags: 1 bag",
      "Child Checked bags: 1 bag of 23 kg Cabin bags: 1 bag",
    ]);
    // The API's total, never base + taxes + fees.
    expect(text($("[data-offer-price]"))).toBe(formatMoney(eur("1240.56"), "en-GB"));
    expect(text($("[data-offer-price-note]"))).toBe("Total for 3 travellers");
    expect(text($("[data-offer-per-adult]"))).toBe("€441.20 per adult");
    expect(text($("[data-offer-seats]"))).toBe("3 seats left at this price");

    // The original fare alone: one card, no radio button.
    expect(families()).toHaveLength(1);
    expect(document.querySelector('input[name="fare"]')).toBeNull();
    const card = text(families()[0]);
    expect(card).toContain("ECONOMY LIGHT");
    expect(card).toContain("€1,240.56 in total");
    expect(card).toContain("Checked bags: Not included");
    expect(card).toContain("Cabin bag: Included 1 bag");
    expect(card).toContain("Refund: Not included");
    expect(card).toContain("Change: Included");
    expect(card).toContain("PRE RESERVED SEAT ASSIGNMENT: For a fee");
    expect(text($("[data-fares-status]"))).toBe("");
    expect(text($("[data-selected-fare]"))).toBe("Selected fare: ECONOMY LIGHT, €1,240.56 in total");
    // Back to the results as they were.
    expect($("a[data-back-link]").hidden).toBe(false);
    expect($("a[data-back-link]").getAttribute("href")).toBe(
      new URL(REFERRER).pathname + new URL(REFERRER).search,
    );
  });

  it("[OFE-006 AC1] makes no upsell call when the configuration has no features at all", async () => {
    const { view, client } = open({ config: { defaultLocale: "en-GB" } });
    await view.done;
    await settle();

    expect(client.flights.getOffer).toHaveBeenCalledTimes(1);
    expect(client.flights.upsell).not.toHaveBeenCalled();
    expect(families()).toHaveLength(1);
  });

  it("[OFE-006 AC1] with brandedFareUpsell on shows the fare families of the upsell", async () => {
    const { view, client } = open({ config: UPSELL_CONFIG });
    await view.done;
    await settle();

    expect(client.flights.upsell).toHaveBeenCalledTimes(1);
    expect(client.flights.upsell).toHaveBeenCalledWith(
      { offerId: OFFER_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(families()).toHaveLength(3);
    expect(families().map((family) => family.getAttribute("data-offer-id"))).toEqual([
      OFFER_ID,
      FLEX_ID,
      PREMIUM_ID,
    ]);
    // The original fare is chosen; the others say what they cost more, from the API's differences.
    expect(radio(OFFER_ID).checked).toBe(true);
    expect(radio(FLEX_ID).checked).toBe(false);
    expect(text(families()[0])).toContain("Your fare from the results");
    const flex = text(families()[1]);
    expect(flex).toContain("ECONOMY FLEX");
    expect(flex).toContain("€1,385.56 in total");
    expect(flex).toContain("€145.00 more than your fare");
    expect(flex).toContain("Checked bags: Included 1 × 23 kg");
    expect(flex).toContain("Refund: For a fee Fee from €70");
    expect(flex).toContain("Seat selection: Included");
    // A column without a fare family is named after its cabin; an unknown status is said, not coloured.
    const premium = text(families()[2]);
    expect(premium).toContain("Premium economy");
    expect(premium).toContain("Seat selection: Not known");
    expect(radio(FLEX_ID).getAttribute("aria-describedby")).toBe(
      families()[1]?.querySelector("[data-fare-features]")?.id,
    );
    expect(text($("[data-fares-status]"))).toBe("Compare what each fare includes and choose one.");
  });

  it("[OFE-006 AC1] a failed upsell shows the original fare only, without an error banner", async () => {
    const { view, client } = open({
      config: UPSELL_CONFIG,
      client: fakeClient({
        upsell: async () => {
          throw apiError(SupplierError, "SUPPLIER_TIMEOUT", 504);
        },
      }),
    });
    await view.done;
    await settle();

    expect(client.flights.upsell).toHaveBeenCalledTimes(1);
    expect(families()).toHaveLength(1);
    expect(document.querySelector('input[name="fare"]')).toBeNull();
    expect(document.querySelector("main [data-state]")).toBeNull();
    expect(text($("[data-fares-status]"))).toBe("");
    expect($("[data-offer-content]").hidden).toBe(false);
  });

  it("[OFE-006 AC1] until the upsell answers, the original fare stands alone and Continue prices it", async () => {
    /** @type {(value: unknown) => void} */
    let answer = () => {};
    const { view, client, navigate } = open({
      config: UPSELL_CONFIG,
      client: fakeClient({ upsell: () => new Promise((resolve) => (answer = resolve)) }),
    });
    await settle();

    expect(client.flights.upsell).toHaveBeenCalledTimes(1);
    expect($("[data-offer-content]").hidden).toBe(false);
    expect(families()).toHaveLength(1);
    expect(document.querySelector('input[name="fare"]')).toBeNull();
    expect(text($("[data-fares-status]"))).toBe("Looking for other fares on these flights…");

    continueWithFare();
    await settle();
    expect(client.flights.price).toHaveBeenCalledWith(
      { offerIds: [OFFER_ID], include: [...PRICE_INCLUDE] },
      { timeoutMs: PRICE_TIMEOUT_MS },
    );
    expect(navigate).toHaveBeenCalledWith(`/price.html?priced=${PRICED_ID}`);

    answer(upsellResult());
    await view.done;
    await settle();
    expect(families()).toHaveLength(3);
    expect(radio(OFFER_ID).checked).toBe(true);
  });

  it("[OFE-006 AC1] an upsell without other fare families keeps the original fare alone", async () => {
    const lonely = upsellResult();
    lonely.comparison.columns = lonely.comparison.columns.slice(0, 1);
    const { view } = open({ config: UPSELL_CONFIG, client: fakeClient({ upsell: async () => lonely }) });
    await view.done;
    await settle();

    expect(families()).toHaveLength(1);
    expect(document.querySelector('input[name="fare"]')).toBeNull();
    expect(text($("[data-fares-status]"))).toBe("");
  });
});

describe("offer page: pricing the chosen fare", () => {
  it("[OFE-006 AC2] choosing a fare family prices that family's off_ id and navigates with the returned prc_ id", async () => {
    const { view, client, navigate } = open({ config: UPSELL_CONFIG });
    await view.done;
    await settle();

    choose(FLEX_ID);
    expect(params().get("fare")).toBe(FLEX_ID);
    expect(params().get("offer")).toBe(OFFER_ID);
    expect(text($("[data-selected-fare]"))).toBe("Selected fare: ECONOMY FLEX, €1,385.56 in total");

    continueWithFare();
    await settle();

    expect(client.flights.price).toHaveBeenCalledTimes(1);
    expect(client.flights.price).toHaveBeenCalledWith(
      { offerIds: [FLEX_ID], include: ["bags", "other-services", "detailed-fare-rules"] },
      { timeoutMs: PRICE_TIMEOUT_MS },
    );
    expect(PRICE_TIMEOUT_MS).toBe(60_000);
    expect(PRICE_INCLUDE).toEqual(["bags", "other-services", "detailed-fare-rules"]);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`/price.html?priced=${PRICED_ID}`);
  });

  it("[OFE-006 AC2] without fare families Continue prices the offer itself", async () => {
    const { view, client, navigate } = open();
    await view.done;
    await settle();

    continueWithFare();
    await settle();

    expect(client.flights.price).toHaveBeenCalledWith(
      { offerIds: [OFFER_ID], include: [...PRICE_INCLUDE] },
      { timeoutMs: PRICE_TIMEOUT_MS },
    );
    expect(navigate).toHaveBeenCalledWith(`/price.html?priced=${PRICED_ID}`);
  });

  it("[OFE-006 AC2] a reload keeps the chosen fare family of the address", async () => {
    const { view, client, navigate } = open({
      config: UPSELL_CONFIG,
      query: `offer=${OFFER_ID}&fare=${PREMIUM_ID}`,
    });
    await view.done;
    await settle();

    expect(client.flights.getOffer).toHaveBeenCalledWith({ offerId: OFFER_ID }, expect.anything());
    expect(radio(PREMIUM_ID).checked).toBe(true);
    choose(OFFER_ID);
    expect(params().has("fare")).toBe(false);
    choose(PREMIUM_ID);
    continueWithFare();
    await settle();
    expect(client.flights.price).toHaveBeenCalledWith(
      { offerIds: [PREMIUM_ID], include: [...PRICE_INCLUDE] },
      { timeoutMs: PRICE_TIMEOUT_MS },
    );
    expect(navigate).toHaveBeenCalledWith(`/price.html?priced=${PRICED_ID}`);
  });

  it("[OFE-006 AC2] a second submit while pricing runs sends no second price call", async () => {
    /** @type {(value: unknown) => void} */
    let answer = () => {};
    const { view, client, navigate } = open({
      client: fakeClient({ price: () => new Promise((resolve) => (answer = resolve)) }),
    });
    await view.done;
    await settle();

    continueWithFare();
    continueWithFare();
    await settle();
    expect(client.flights.price).toHaveBeenCalledTimes(1);
    expect($("form[data-fare-form]").getAttribute("aria-busy")).toBe("true");
    expect(text($('form[data-fare-form] button[type="submit"]'))).toBe("Confirming the price…");

    answer(pricedOffer());
    await settle();
    expect(navigate).toHaveBeenCalledWith(`/price.html?priced=${PRICED_ID}`);
  });
});

describe("offer page: states", () => {
  it.each([
    ["410 OFFER_EXPIRED", () => apiError(ExpiredError, "OFFER_EXPIRED", 410)],
    ["404 NOT_FOUND (purged after it expired)", () => apiError(NotFoundError, "NOT_FOUND", 404)],
  ])(
    "[OFE-006 AC3] %s from getOffer shows the expired fare with a link to refreshed results",
    async (_name, error) => {
      const { view, client } = open({
        config: UPSELL_CONFIG,
        client: fakeClient({
          getOffer: async () => {
            throw error();
          },
        }),
      });
      await view.done;
      await settle();

      const state = stateOf("[data-offer-state]");
      expect(state.getAttribute("data-state")).toBe("offer-expired");
      expect(text(state.querySelector('[data-field="title"]'))).toBe("This fare is no longer available");
      expect(text(state)).toContain("Search again to see the current prices.");
      expect(state.querySelector('[data-action="retry"]')).toBeNull();
      // Refreshed results: the same trip, filters and sort, without the expired search id.
      const link = /** @type {HTMLAnchorElement} */ (state.querySelector("a[data-state-link]"));
      expect(text(link)).toBe("Search again for current prices");
      const target = new URL(/** @type {string} */ (link.getAttribute("href")), ORIGIN);
      expect(target.pathname).toBe("/search.html");
      expect(target.searchParams.has("search")).toBe(false);
      expect(target.searchParams.get("from")).toBe("PAR");
      expect(target.searchParams.get("depart")).toBe(DEPART);
      expect(target.searchParams.get("stops")).toBe("0,1");
      expect(target.searchParams.get("sort")).toBe("price");
      expect($("[data-offer-content]").hidden).toBe(true);
      expect(client.flights.upsell).not.toHaveBeenCalled();
      expect(document.title).toBe("This fare is no longer available");
    },
  );

  it("[OFE-006 AC3] 410 OFFER_EXPIRED at pricing links to the offer's search when the page was opened directly", async () => {
    const { view, navigate } = open({
      referrer: "",
      client: fakeClient({
        price: async () => {
          throw apiError(ExpiredError, "OFFER_EXPIRED", 410);
        },
      }),
    });
    await view.done;
    await settle();
    expect($("a[data-back-link]").getAttribute("href")).toBe(`/search.html?search=${SEARCH_ID}`);

    continueWithFare();
    await settle();

    const state = stateOf("[data-offer-state]");
    expect(state.getAttribute("data-state")).toBe("offer-expired");
    expect(state.querySelector("a[data-state-link]")?.getAttribute("href")).toBe(
      `/search.html?search=${SEARCH_ID}`,
    );
    expect($("[data-offer-content]").hidden).toBe(true);
    expect(document.activeElement).toBe(state.querySelector('[data-field="title"]'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("[OFE-006 AC3] 409 SOLD_OUT at pricing shows that the flight sold out, with a link back to the results", async () => {
    const { view, navigate } = open({
      client: fakeClient({
        price: async () => {
          throw apiError(SoldOutError, "SOLD_OUT", 409);
        },
      }),
    });
    await view.done;
    await settle();

    continueWithFare();
    await settle();

    const state = stateOf("[data-offer-state]");
    expect(state.getAttribute("data-state")).toBe("sold-out");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("This flight just sold out");
    expect(state.querySelector('[data-action="retry"]')).toBeNull();
    const link = state.querySelector("a[data-state-link]");
    expect(text(link)).toBe("Back to results");
    // Back to the results as they were, search id included.
    expect(link?.getAttribute("href")).toBe(new URL(REFERRER).pathname + new URL(REFERRER).search);
    expect($("[data-offer-content]").hidden).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "504 SUPPLIER_TIMEOUT",
      () => apiError(SupplierError, "SUPPLIER_TIMEOUT", 504),
      "Airlines are not answering right now",
    ],
    [
      "503 SUPPLIER_UNAVAILABLE",
      () => apiError(SupplierError, "SUPPLIER_UNAVAILABLE", 503),
      "Airlines are not answering right now",
    ],
    [
      "503 SERVICE_UNAVAILABLE",
      () => apiError(ServerError, "SERVICE_UNAVAILABLE", 503),
      "The service is not available right now. Nothing is lost: try again in a moment.",
    ],
  ])("[OFE-006 AC3] %s at pricing offers Retry and keeps the chosen fare", async (_name, error, title) => {
    let calls = 0;
    const { view, client, navigate } = open({
      config: UPSELL_CONFIG,
      client: fakeClient({
        price: async () => {
          calls += 1;
          if (calls === 1) {
            throw error();
          }
          return pricedOffer();
        },
      }),
    });
    await view.done;
    await settle();
    choose(FLEX_ID);

    continueWithFare();
    await settle();

    const state = stateOf("[data-price-state]");
    expect(text(state.querySelector('[data-field="title"]'))).toBe(title);
    // The offer and the fares stay, as chosen.
    expect($("[data-offer-content]").hidden).toBe(false);
    expect(radio(FLEX_ID).checked).toBe(true);
    expect(params().get("fare")).toBe(FLEX_ID);
    expect(navigate).not.toHaveBeenCalled();

    /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]')).click();
    await settle();

    expect(client.flights.price).toHaveBeenCalledTimes(2);
    expect(client.flights.price).toHaveBeenLastCalledWith(
      { offerIds: [FLEX_ID], include: [...PRICE_INCLUDE] },
      { timeoutMs: PRICE_TIMEOUT_MS },
    );
    expect(navigate).toHaveBeenCalledWith(`/price.html?priced=${PRICED_ID}`);
    expect(document.querySelector("[data-price-state] [data-state]")).toBeNull();
  });

  it.each([
    [
      "a connection failure",
      () => new ConnectionError({ code: "NETWORK_ERROR", message: "offline", status: 0 }),
      "unavailable",
    ],
    ["503 SERVICE_UNAVAILABLE", () => apiError(ServerError, "SERVICE_UNAVAILABLE", 503), "unavailable"],
    ["429 RATE_LIMITED", () => apiError(RateLimitError, "RATE_LIMITED", 429), "rate-limited"],
  ])("[OFE-006 AC3] %s of getOffer offers Retry, which loads the offer again", async (_name, error, name) => {
    let calls = 0;
    const { view, client } = open({
      client: fakeClient({
        getOffer: async () => {
          calls += 1;
          if (calls === 1) {
            throw error();
          }
          return fullOffer();
        },
      }),
    });
    await view.done;
    await settle();

    const state = stateOf("[data-offer-state]");
    expect(state.getAttribute("data-state")).toBe(name);
    expect($("[data-offer-content]").hidden).toBe(true);

    /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]')).click();
    await settle();

    expect(client.flights.getOffer).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-offer-state] [data-state]")).toBeNull();
    expect($("[data-offer-content]").hidden).toBe(false);
    expect(families()).toHaveLength(1);
  });

  it.each([["offer=nope"], [""], ["offer=srch_01JOFFERPAGE000001"]])(
    "[OFE-006 AC3] an address without a valid offer id (%s) shows that the flight was not found, without a call",
    async (query) => {
      const { view, client } = open({ query, referrer: "" });
      await view.done;
      await settle();

      const state = stateOf("[data-offer-state]");
      expect(text(state.querySelector('[data-field="title"]'))).toBe("We could not find this flight");
      expect(state.querySelector("a[data-state-link]")?.getAttribute("href")).toBe("/");
      expect(text(state.querySelector("a[data-state-link]"))).toBe("Search flights");
      expect(client.flights.getOffer).not.toHaveBeenCalled();
    },
  );
});

describe("offer page helpers", () => {
  it("[OFE-006 AC3] results links come from the results page, else the offer's search, else the home page", () => {
    expect(resultsLinks(`${ORIGIN}/search.html?from=PAR&to=NYC&search=${SEARCH_ID}&stops=0`, ORIGIN)).toEqual(
      {
        back: `/search.html?from=PAR&to=NYC&search=${SEARCH_ID}&stops=0`,
        refresh: "/search.html?from=PAR&to=NYC&stops=0",
      },
    );
    // A bookmark of the results (search id only): its own page offers Refresh.
    expect(resultsLinks(`${ORIGIN}/search.html?search=${SEARCH_ID}`, ORIGIN, null)).toEqual({
      back: `/search.html?search=${SEARCH_ID}`,
      refresh: `/search.html?search=${SEARCH_ID}`,
    });
    // Another site or page never becomes a link.
    expect(resultsLinks(`https://evil.example/search.html?from=PAR&to=NYC`, ORIGIN, SEARCH_ID)).toEqual({
      back: `/search.html?search=${SEARCH_ID}`,
      refresh: `/search.html?search=${SEARCH_ID}`,
    });
    expect(resultsLinks(`${ORIGIN}/price.html?priced=${PRICED_ID}`, ORIGIN, "nope")).toEqual({
      back: "/",
      refresh: "/",
    });
    expect(resultsLinks("not a url", ORIGIN)).toEqual({ back: "/", refresh: "/" });
  });

  it("[OFE-006 AC1] fare families keep the API's amounts and say each status in words", () => {
    const upsell = familiesFromUpsell(/** @type {never} */ (upsellResult()));
    expect(
      upsell.map((family) => [family.offerId, family.price.amount, family.difference?.amount ?? null]),
    ).toEqual([
      [OFFER_ID, "1240.56", null],
      [FLEX_ID, "1385.56", "145.00"],
      [PREMIUM_ID, "1990.00", "749.44"],
    ]);
    expect(familiesFromUpsell(null)).toEqual([]);
    const base = familyFromOffer(/** @type {never} */ (fullOffer()));
    expect(base).toMatchObject({ offerId: OFFER_ID, name: "ECONOMY LIGHT", isBase: true, difference: null });
    // A difference's sign is read from the API's text, never computed.
    const family = { ...base, isBase: false };
    expect(differenceText({ ...family, difference: eur("-12.50") }, "en-GB")).toBe(
      "€12.50 less than your fare",
    );
    expect(differenceText({ ...family, difference: eur("0.00") }, "en-GB")).toBe("Same price as your fare");
    expect(differenceText({ ...family, difference: eur("45.00") }, "en-GB")).toBe(
      "€45.00 more than your fare",
    );
  });

  it("[OFE-006 AC1] baggage falls back to the summary's adult allowance without fare details", () => {
    const offer = fullOffer();
    const summaryOnly = /** @type {never} */ ({ ...offer, travelerPricings: undefined });
    expect(baggageRows(summaryOnly)).toEqual([
      { traveller: "Each adult", checked: "Checked bags: None", cabin: "Cabin bags: 1 bag" },
    ]);
    const unknown = /** @type {never} */ ({
      ...offer,
      travelerPricings: [],
      summary: { ...offer.summary, includedCheckedBags: null, includedCabinBags: null },
    });
    expect(baggageRows(unknown)).toEqual([]);
  });
});
