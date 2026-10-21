// The price page (ota/frontend/docs/pages.md §6): price.html with its partials expanded by the build's include plugin,
// run by src/pages/price.js against a fake SDK. It covers the breakdown with every fee line label and the API's total
// (OADR-0005 point 7), the extras shown as "Available in checkout" only when `features.ancillaries` is on, the fare
// rules in "Changes and refunds", a changed price, the countdown to "Price expired" with fake timers, the disabled
// Continue of M2, and the states of §6 for their error codes.
import {
  ConnectionError,
  ExpiredError,
  NotFoundError,
  RateLimitError,
  ServerError,
  SupplierError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import {
  compareDecimal,
  detailLines,
  feeLabel,
  lowestPrice,
  travellerLines,
} from "../src/components/price-breakdown.js";
import { formatMoney } from "../src/lib/format.js";
import {
  EXPIRY_WARNING_SECONDS,
  countdownText,
  extrasLines,
  flightLink,
  requirementTexts,
  secondsLeft,
  start,
} from "../src/pages/price.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** What the mocked boot() of the page module resolves with; `null` keeps it waiting (the static import above). */
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
const SEARCH_ID = "srch_01JPRICEPAGE000001";
const BASE_ID = "off_01JPRICEPAGEBASE001";
const OFFER_ID = "off_01JPRICEPAGEFLEX001";
const PRICED_ID = "prc_01JPRICEPAGE0000001";
/** The offer page the traveller priced the flight on (the base offer with the flexible fare chosen). */
const REFERRER = `${ORIGIN}/offer.html?offer=${BASE_ID}&fare=${OFFER_ID}`;
/** How long the polite live region waits before it speaks (components/live-region.js), with a margin. */
const ANNOUNCED_MS = 200;

const CONFIG = Object.freeze({
  defaultLocale: "en-GB",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { ancillaries: false, seatSelection: false },
});
const EXTRAS_CONFIG = Object.freeze({ ...CONFIG, features: { ancillaries: true, seatSelection: false } });

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });
/** @param {string} amount */
const money = (amount) => formatMoney(eur(amount), "en-GB");

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
const RETURN = dateFromToday(37);

/** An ISO timestamp `seconds` from now (fake timers included). */
const fromNow = (/** @type {number} */ seconds) => new Date(Date.now() + seconds * 1000).toISOString();

/**
 * One flight.
 * @param {string} id
 * @param {string} from
 * @param {string} to
 * @param {string} departAt
 * @param {string} arriveAt
 */
const segment = (id, from, to, departAt, arriveAt) => ({
  id,
  departure: { iataCode: from, terminal: null, at: departAt, airportName: null },
  arrival: { iataCode: to, terminal: null, at: arriveAt, airportName: null },
  carrierCode: "AF",
  carrierName: "Air France",
  number: "1234",
  flightNumber: `AF${id}234`,
  operating: null,
  aircraft: { code: "359", name: "Airbus A350-900" },
  duration: null,
  durationMinutes: 500,
  numberOfStops: 0,
  cabin: "ECONOMY",
  brandedFare: "FLEX",
  brandedFareLabel: "ECONOMY FLEX",
  layoverAfter: null,
});

/** The priced flight in full view: a direct return trip Paris–New York for two adults and a child. */
function flightOffer() {
  return {
    id: OFFER_ID,
    searchId: SEARCH_ID,
    origin: "upsell",
    baseOfferId: BASE_ID,
    upsellId: "ups_01JPRICEPAGEUPSELL01",
    status: "active",
    source: "GDS",
    summary: {
      tripType: "round_trip",
      originCode: "CDG",
      destinationCode: "JFK",
      departureAt: `${DEPART}T10:00:00`,
      returnAt: `${RETURN}T18:00:00`,
      totalDurationMinutes: 1000,
      maxStops: 0,
      marketingCarriers: ["AF"],
      cabins: ["ECONOMY"],
      brandedFares: [
        { itineraryIndex: 0, code: "FLEX", label: "ECONOMY FLEX" },
        { itineraryIndex: 1, code: "FLEX", label: "ECONOMY FLEX" },
      ],
      includedCheckedBags: { quantity: 1, weight: 23, weightUnit: "KG" },
      includedCabinBags: { quantity: 1, weight: null, weightUnit: null },
      refundable: true,
      changeable: true,
      numberOfBookableSeats: 9,
      tags: [],
    },
    itineraries: [
      {
        index: 0,
        originCode: "CDG",
        destinationCode: "JFK",
        departureAt: `${DEPART}T10:00:00`,
        arrivalAt: `${DEPART}T12:20:00`,
        duration: "PT8H20M",
        durationMinutes: 500,
        stops: 0,
        stopAirports: [],
        arrivalDayOffset: 0,
        marketingCarriers: ["AF"],
        segments: [segment("1", "CDG", "JFK", `${DEPART}T10:00:00`, `${DEPART}T12:20:00`)],
      },
      {
        index: 1,
        originCode: "JFK",
        destinationCode: "CDG",
        departureAt: `${RETURN}T18:00:00`,
        arrivalAt: `${dateFromToday(38)}T07:20:00`,
        duration: "PT7H20M",
        durationMinutes: 440,
        stops: 0,
        stopAirports: [],
        arrivalDayOffset: 1,
        marketingCarriers: ["AF"],
        segments: [segment("2", "JFK", "CDG", `${RETURN}T18:00:00`, `${dateFromToday(38)}T07:20:00`)],
      },
    ],
    travelerPricings: ["ADULT", "ADULT", "CHILD"].map((travelerType, index) => ({
      travelerId: String(index + 1),
      travelerType,
      fareOption: "STANDARD",
      associatedAdultId: null,
      segments: [],
    })),
    validatingAirlineCodes: ["AF"],
    price: {
      currency: "EUR",
      total: eur("1262.06"),
      base: eur("1000.00"),
      taxes: eur("200.00"),
      fees: eur("25.50"),
    },
  };
}

/**
 * The priced offer. Its total deliberately differs from the sum of its lines: the page must show the API's total.
 * @param {Record<string, unknown>} [overrides]
 */
function pricedOffer(overrides = {}) {
  return {
    id: PRICED_ID,
    status: "active",
    searchId: SEARCH_ID,
    offerIds: [OFFER_ID],
    customerId: null,
    offers: [flightOffer()],
    price: {
      currency: "EUR",
      total: eur("1262.06"),
      base: eur("1000.00"),
      taxes: eur("200.00"),
      fees: eur("25.50"),
      additionalServices: null,
      perAdult: eur("441.20"),
      breakdown: {
        travelers: [
          traveller("1", "ADULT", "380.00", "56.20", "5.00", "441.20"),
          traveller("2", "ADULT", "380.00", "56.20", "5.00", "441.20"),
          traveller("3", "CHILD", "285.00", "46.20", "3.50", "334.70"),
        ],
        fees: [
          { type: "ticketing", amount: eur("4.50"), description: null },
          { type: "service_fee", amount: eur("15.00"), description: "Booking service fee" },
          { type: "service_fee", amount: eur("6.00"), description: "Ticketing service" },
        ],
        additionalServices: [],
        refundableTaxes: null,
      },
    },
    priceChange: {
      changed: false,
      oldPrice: eur("1262.06"),
      newPrice: eur("1262.06"),
      difference: eur("0.00"),
      direction: "none",
    },
    bookingRequirements: {
      emailAddressRequired: true,
      mobilePhoneNumberRequired: true,
      travelerRequirements: [
        { travelerId: "1", dateOfBirthRequired: true, documentRequired: true },
        { travelerId: "3", dateOfBirthRequired: true },
      ],
    },
    creditCardFees: [],
    selectedAncillaries: [],
    ancillaries: { loaded: true, checkedBags: true, cabinBags: false, otherServices: true, seats: true },
    conditions: {
      refundable: true,
      changeable: true,
      refundPenalty: eur("70.00"),
      changePenalty: eur("0.00"),
      source: "fare_rules",
    },
    fareRules: null,
    ancillaryCatalogue: null,
    include: ["bags", "other-services", "detailed-fare-rules"],
    forceClass: false,
    dictionaries: {
      locations: {
        CDG: { cityCode: "PAR", countryCode: "FR", airportName: "Charles de Gaulle", cityName: "Paris" },
        JFK: { cityCode: "NYC", countryCode: "US", airportName: "John F Kennedy", cityName: "New York" },
      },
      carriers: { AF: { name: "Air France" } },
    },
    createdAt: fromNow(-60),
    expiresAt: fromNow(19 * 60),
    ...overrides,
  };
}

/**
 * The selling price of one traveller.
 * @param {string} travelerId
 * @param {string} travelerType
 * @param {string} base
 * @param {string} taxes
 * @param {string} fees
 * @param {string} total
 */
function traveller(travelerId, travelerType, base, taxes, fees, total) {
  return {
    travelerId,
    travelerType,
    base: eur(base),
    taxes: eur(taxes),
    fees: eur(fees),
    total: eur(total),
    taxDetails: [],
  };
}

/**
 * One option of the ancillary catalogue.
 * @param {string} id
 * @param {"CHECKED_BAGS" | "CABIN_BAGS" | "SEATS" | "OTHER_SERVICES"} type
 * @param {string | null} price
 * @param {string | null} [serviceName]
 */
const option = (id, type, price, serviceName = null) => ({
  id,
  type,
  name: serviceName ?? (type === "SEATS" ? "SEAT" : "CHECKED_BAG"),
  label: type === "CHECKED_BAGS" ? "1 extra checked bag (23 kg)" : (serviceName ?? "Seat"),
  offerId: OFFER_ID,
  travelerIds: ["1"],
  segmentIds: ["1"],
  serviceName,
  requiresSeatNumber: type === "SEATS",
  price: price === null ? null : eur(price),
  amadeus: { flightOfferId: "1", segmentIds: ["1"], additionalServices: {} },
});

/** The ancillary catalogue: three bags (the cheapest is not the first, nor the first as text), services, seats. */
function catalogue() {
  return {
    pricedOfferId: PRICED_ID,
    currency: "EUR",
    travelers: [],
    segments: [],
    checkedBags: [
      option("anc_01JPRICEPAGEBAG00001", "CHECKED_BAGS", "35.00"),
      option("anc_01JPRICEPAGEBAG00002", "CHECKED_BAGS", "9.50"),
      option("anc_01JPRICEPAGEBAG00003", "CHECKED_BAGS", "120.00"),
    ],
    cabinBags: [],
    otherServices: [
      option("anc_01JPRICEPAGESRV00001", "OTHER_SERVICES", "12.00", "PRIORITY_BOARDING"),
      option("anc_01JPRICEPAGESRV00002", "OTHER_SERVICES", "8.00", "PRIORITY_BOARDING"),
      option("anc_01JPRICEPAGESRV00003", "OTHER_SERVICES", "25.00", "FAST_TRACK"),
    ],
    seats: [option("anc_01JPRICEPAGESEAT0001", "SEATS", null)],
    seatsSupported: true,
    expiresAt: fromNow(19 * 60),
  };
}

/** The fare rules: a summary, three rule categories and one fare note. */
function fareRules() {
  return {
    pricedOfferId: PRICED_ID,
    currency: "EUR",
    available: true,
    summary: {
      refundable: true,
      changeable: true,
      refundPenalty: eur("70.00"),
      changePenalty: eur("0.00"),
      source: "detailed_fare_rules",
    },
    categories: [
      {
        offerId: OFFER_ID,
        category: "REFUND",
        applicable: true,
        chargeable: true,
        maxPenalty: eur("70.00"),
        circumstances: "BEFORE DEPARTURE",
        texts: [],
      },
      { offerId: OFFER_ID, category: "EXCHANGE", applicable: true, chargeable: false, maxPenalty: null },
      { offerId: OFFER_ID, category: "REVALIDATION", applicable: false },
    ],
    fareComponents: [
      {
        key: "1",
        fareBasis: "YFLEXFR",
        name: "PENALTIES",
        segmentId: "1",
        category: "PENALTIES",
        notes: [{ descriptionType: "PENALTIES", text: "CHANGES\nANY TIME CHARGE EUR 0.00" }],
      },
    ],
    raw: { fareRules: [], detailedFareRules: {} },
  };
}

/**
 * A fake SDK client with the calls of the price page; each `flights` method can be replaced.
 * @param {{ getPricedOffer?: Function, getAncillaries?: Function, getFareRules?: Function }} [overrides]
 */
function fakeClient(overrides = {}) {
  return {
    flights: {
      getPricedOffer: vi.fn(overrides.getPricedOffer ?? (async () => pricedOffer())),
      getAncillaries: vi.fn(overrides.getAncillaries ?? (async () => catalogue())),
      getFareRules: vi.fn(overrides.getFareRules ?? (async () => fareRules())),
    },
  };
}

/** @param {string} code @param {number} status @param {Function} ErrorClass */
const apiError = (ErrorClass, code, status) =>
  new ErrorClass({ code, message: `${code} from the fake API`, status, requestId: "req_pricepage" });

/** @type {Browser | undefined} */
let browser;
/** @type {Document} */
let pricePageDocument;
/** The test window's address before each test. */
let address = "";
/** The test document's title before each test. */
let title = "";
/** Views started by the current test, destroyed after it. */
const views = /** @type {Array<{ destroy: () => void }>} */ ([]);

beforeAll(async () => {
  // Expands price.html with the build's include plugin and parses it once in a happy-dom browser page; each test
  // imports a fresh copy of its body into the test document.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  const html = await transform.handler(readFileSync(join(STOREFRONT_ROOT, "price.html"), "utf8"), {
    path: "/price.html",
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
  page.url = `${ORIGIN}/price.html`;
  page.content = html;
  pricePageDocument = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}, 15_000); // file reads, the include plugin and one happy-dom browser; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

beforeEach(() => {
  address = `${location.pathname}${location.search}`;
  title = document.title;
  document.body.replaceChildren(
    ...Array.from(pricePageDocument.body.childNodes, (node) => document.importNode(node, true)),
  );
  document.title = pricePageDocument.title;
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  vi.useRealTimers();
  document.body.replaceChildren();
  document.title = title;
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
const texts = (/** @type {string} */ selector) => Array.from(document.querySelectorAll(selector), text);
const stateOf = (/** @type {string} */ container) => $(`${container} [data-state]`);
const liveRegion = () => text($("[data-live-region]"));

/**
 * The lines of one breakdown section as [label, detail, amount].
 * @param {"travellers" | "details"} name
 */
const sectionLines = (name) =>
  Array.from(
    document.querySelectorAll(`[data-price-section][data-section="${name}"] [data-price-line]`),
    (line) => {
      const detail = /** @type {HTMLElement} */ (line.querySelector('[data-field="detail"]'));
      return [
        text(line.querySelector('[data-field="label"]')),
        detail.hidden ? null : text(detail),
        text(line.querySelector('[data-field="amount"]')),
      ];
    },
  );

/**
 * Starts the price page at `/price.html?<query>` with a fake SDK.
 * @param {{ query?: string, client?: ReturnType<typeof fakeClient>, config?: object, referrer?: string }} [options]
 */
function open({
  query = `priced=${PRICED_ID}`,
  client = fakeClient(),
  config = CONFIG,
  referrer = REFERRER,
} = {}) {
  history.replaceState(null, "", `/price.html?${query}`);
  const view = start(
    { config: /** @type {never} */ (config), client: /** @type {never} */ (client) },
    { referrer },
  );
  if (!view) {
    throw new Error("the price page did not start");
  }
  views.push(view);
  return { view, client };
}

describe("price page: the confirmed price", () => {
  it("[OFE-007 AC1] the breakdown shows every fee line label and the total from the API", async () => {
    const { view, client } = open();
    await view.done;
    await settle();

    expect(client.flights.getPricedOffer).toHaveBeenCalledTimes(1);
    expect(client.flights.getPricedOffer).toHaveBeenCalledWith(
      { pricedOfferId: PRICED_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect($("[data-price-content]").hidden).toBe(false);
    expect($("[data-price-loading]").hidden).toBe(true);
    expect(document.title).toBe("Your price");

    // Per traveller type: the adults pay the same and share one line; nothing is multiplied.
    expect(sectionLines("travellers")).toEqual([
      [
        "2 adults",
        `Fare ${money("380.00")} · Taxes and charges ${money("56.20")} · Fees ${money("5.00")}`,
        `${money("441.20")} each`,
      ],
      [
        "1 child",
        `Fare ${money("285.00")} · Taxes and charges ${money("46.20")} · Fees ${money("3.50")}`,
        money("334.70"),
      ],
    ]);
    // Every fee line with its label (the OTA's fee rule labels, the airline's fee by type), and the API's total, which
    // is not the sum of the lines.
    expect(sectionLines("details")).toEqual([
      ["Fares", null, money("1000.00")],
      ["Taxes and charges", null, money("200.00")],
      ["Ticketing fee", null, money("4.50")],
      ["Booking service fee", null, money("15.00")],
      ["Ticketing service", null, money("6.00")],
      ["Total", null, money("1262.06")],
    ]);
    expect($('[data-price-line][data-kind="total"]')).not.toBeNull();
    expect(text($("[data-price-total]"))).toBe(money("1262.06"));
    expect(text($("[data-price-total-note]"))).toBe("Total for 3 travellers");
    expect(texts("[data-price-conditions] > li")).toEqual(["Refundable", "Changes allowed"]);
  });

  it("[OFE-007] shows the trip, the flights, the booking requirements and a disabled Continue", async () => {
    const { view } = open();
    await view.done;
    await settle();

    expect(text($("[data-price-summary]"))).toContain(
      "Return flight from Charles de Gaulle (CDG) to John F Kennedy (JFK)",
    );
    expect(text($("[data-price-summary]"))).toContain("2 adults, 1 child");
    expect(document.querySelectorAll("[data-price-itineraries] > [data-itinerary]")).toHaveLength(2);
    expect(text($("[data-price-itineraries]"))).toContain("Air France (AF)");
    expect(text($("[data-price-fare]"))).toBe("Fare: ECONOMY FLEX");
    expect($("[data-price-changed]").hidden).toBe(true);
    expect($("[data-price-requirements]").hidden).toBe(false);
    expect(texts("[data-price-requirements-list] > li")).toEqual([
      "The full name of each traveller, as in their passport or ID card",
      "An e-mail address",
      "A mobile phone number",
      "The date of birth of each traveller",
      "Passport or ID card details",
    ]);
    // Continue is there, but disabled until checkout opens (OFE-011, M3).
    const button = /** @type {HTMLButtonElement} */ ($("button[data-continue]"));
    expect(text(button)).toBe("Continue to checkout");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe("checkout-note");
    expect(text(document.getElementById("checkout-note"))).toBe("Checkout opens soon.");
    // Back to the offer page the flight was priced on.
    expect($("a[data-back-link]").hidden).toBe(false);
    expect($("a[data-back-link]").getAttribute("href")).toBe(`/offer.html?offer=${BASE_ID}&fare=${OFFER_ID}`);
  });

  it("[OFE-007] a changed price shows the old and the new total side by side and an explicit Continue", async () => {
    vi.useFakeTimers();
    const changed = pricedOffer({
      priceChange: {
        changed: true,
        oldPrice: eur("1249.66"),
        newPrice: eur("1262.06"),
        difference: eur("12.40"),
        direction: "up",
      },
    });
    const { view } = open({ client: fakeClient({ getPricedOffer: async () => changed }) });
    await view.done;
    await settle();
    vi.advanceTimersByTime(ANNOUNCED_MS);

    expect($("[data-price-changed]").hidden).toBe(false);
    expect(text($("[data-price-changed] h2"))).toBe("The airline changed the price");
    // `oldPrice` is the results total plus the fees added at pricing, not the total the results showed.
    expect(texts("[data-price-changed] dt")).toEqual(["Expected price", "Confirmed price"]);
    expect(text($("[data-price-old]"))).toBe(money("1249.66"));
    expect(text($("[data-price-new]"))).toBe(money("1262.06"));
    expect(text($("[data-price-difference]"))).toBe(`${money("12.40")} more than expected`);
    expect(text($("button[data-continue]"))).toBe(`Continue at the new price, ${money("1262.06")}`);
    expect(liveRegion()).toBe(
      `The airline changed the price from ${money("1249.66")} to ${money("1262.06")}`,
    );

    const lower = pricedOffer({
      priceChange: {
        changed: true,
        oldPrice: eur("1270.00"),
        newPrice: eur("1262.06"),
        difference: eur("-7.94"),
        direction: "down",
      },
    });
    view.destroy();
    const second = open({ client: fakeClient({ getPricedOffer: async () => lower }) });
    await second.view.done;
    await settle();
    expect(text($("[data-price-difference]"))).toBe(`${money("7.94")} less than expected`);
  });

  it("[OFE-007] with ancillaries on, extras are available in checkout from their lowest price, with no selection", async () => {
    const { view, client } = open({ config: EXTRAS_CONFIG });
    await view.done;
    await settle();

    expect(client.flights.getAncillaries).toHaveBeenCalledTimes(1);
    expect(client.flights.getAncillaries).toHaveBeenCalledWith(
      { pricedOfferId: PRICED_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect($("[data-price-extras]").hidden).toBe(false);
    expect(text($("[data-price-extras] h2"))).toBe("Available in checkout");
    expect(texts("[data-price-extras-list] > li")).toEqual([
      `Extra checked bags from ${money("9.50")}`,
      `Priority boarding from ${money("8.00")}`,
      `Fast track at security from ${money("25.00")}`,
    ]);
    // Nothing to choose here, and no seats while the storefront offers no seat selection.
    expect($("[data-price-extras]").querySelector("input, select, button")).toBeNull();
  });

  it("[OFE-007] with ancillaries off no extras call is made; a failed call leaves the list out without a banner", async () => {
    const off = open();
    await off.view.done;
    await settle();
    expect(off.client.flights.getAncillaries).not.toHaveBeenCalled();
    expect($("[data-price-extras]").hidden).toBe(true);
    off.view.destroy();

    const failing = open({
      config: EXTRAS_CONFIG,
      client: fakeClient({
        getAncillaries: async () => {
          throw apiError(SupplierError, "SUPPLIER_TIMEOUT", 504);
        },
      }),
    });
    await failing.view.done;
    await settle();
    expect(failing.client.flights.getAncillaries).toHaveBeenCalledTimes(1);
    expect($("[data-price-extras]").hidden).toBe(true);
    expect(document.querySelector("[data-state]")).toBeNull();
    expect($("[data-price-content]").hidden).toBe(false);
  });

  it("[OFE-007] fare rules appear in the Changes and refunds disclosure", async () => {
    const { view, client } = open();
    await view.done;
    await settle();

    expect(client.flights.getFareRules).toHaveBeenCalledWith(
      { pricedOfferId: PRICED_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const rules = /** @type {HTMLDetailsElement} */ ($("details[data-fare-rules]"));
    expect(text(rules.querySelector("summary"))).toBe("Changes and refunds");
    expect(texts("[data-rules-summary] > li")).toEqual([
      `Refund: Allowed for a fee of up to ${money("70.00")} per traveller`,
      "Change: Allowed free of charge",
    ]);
    expect(texts("[data-rules-categories] > li")).toEqual([
      `Refund: Allowed for a fee of up to ${money("70.00")} BEFORE DEPARTURE`,
      "Change: Allowed free of charge",
      "Revalidation: Not allowed",
    ]);
    expect($("[data-rules-notes]").hidden).toBe(false);
    expect(text($("[data-rules-notes-list]"))).toBe("PENALTIES (YFLEXFR) CHANGES ANY TIME CHARGE EUR 0.00");
    // Airline texts keep their lines.
    expect($("[data-rules-notes-list] p.whitespace-pre-line:last-child").textContent).toBe(
      "CHANGES\nANY TIME CHARGE EUR 0.00",
    );
    expect($("[data-rules-unavailable]").hidden).toBe(true);
    expect($("[data-rules-loading]").hidden).toBe(true);
  });

  it("[OFE-007] failed fare rules keep the embedded rules, else say so with a Retry for the rules alone", async () => {
    let calls = 0;
    const { view, client } = open({
      client: fakeClient({
        getFareRules: async () => {
          calls += 1;
          if (calls === 1) {
            throw new ConnectionError({ code: "NETWORK_ERROR", message: "offline", status: 0 });
          }
          return fareRules();
        },
      }),
    });
    await view.done;
    await settle();

    const state = stateOf("[data-rules-state]");
    expect(text(state.querySelector('[data-field="title"]'))).toBe(
      "The fare rules could not be loaded right now",
    );
    // The conditions at a glance of the priced offer stay.
    expect(texts("[data-rules-summary] > li")).toEqual([
      `Refund: Allowed for a fee of up to ${money("70.00")} per traveller`,
      "Change: Allowed free of charge",
    ]);
    expect($("[data-price-content]").hidden).toBe(false);

    /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]')).click();
    await settle();
    expect(client.flights.getFareRules).toHaveBeenCalledTimes(2);
    expect(client.flights.getPricedOffer).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-rules-state] [data-state]")).toBeNull();
    expect(texts("[data-rules-categories] > li")).toHaveLength(3);
    view.destroy();

    const embedded = open({
      client: fakeClient({
        getPricedOffer: async () => pricedOffer({ fareRules: { ...fareRules(), available: false } }),
        getFareRules: async () => {
          throw apiError(ServerError, "SERVICE_UNAVAILABLE", 503);
        },
      }),
    });
    await embedded.view.done;
    await settle();
    expect(document.querySelector("[data-rules-state] [data-state]")).toBeNull();
    expect(texts("[data-rules-categories] > li")).toHaveLength(3);
    expect(text($("[data-rules-unavailable]"))).toBe(
      "The airline has not published detailed rules for this fare.",
    );
    expect($("[data-rules-unavailable]").hidden).toBe(false);
  });

  it("[OFE-007] fare rules of a priced offer that expired meanwhile say so without a Retry", async () => {
    const { view, client } = open({
      client: fakeClient({
        getFareRules: async () => {
          throw apiError(ExpiredError, "OFFER_EXPIRED", 410);
        },
      }),
    });
    await view.done;
    await settle();

    const state = stateOf("[data-rules-state]");
    expect(text(state.querySelector('[data-field="title"]'))).toBe(
      "The fare rules could not be loaded right now",
    );
    expect(state.querySelector('[data-action="retry"]')).toBeNull();
    expect(client.flights.getFareRules).toHaveBeenCalledTimes(1);
    // The price itself stays: its own countdown says when it expires.
    expect($("[data-price-content]").hidden).toBe(false);
  });
});

describe("price page: expiry", () => {
  it("[OFE-007 AC2] the countdown reaches zero and shows the expired state with Re-price", async () => {
    vi.useFakeTimers();
    const { view } = open({
      client: fakeClient({ getPricedOffer: async () => pricedOffer({ expiresAt: fromNow(65) }) }),
    });
    await view.done;
    await settle();

    const countdown = $("[data-price-countdown]");
    expect(countdown.getAttribute("role")).toBe("timer");
    expect(countdown.hidden).toBe(false);
    expect(text(countdown)).toBe("Price held for 1:05");
    // Five minutes or less: the countdown warns, and the page says so once with the price.
    expect(countdown.hasAttribute("data-expiring")).toBe(true);
    vi.advanceTimersByTime(ANNOUNCED_MS);
    expect(liveRegion()).toBe(
      `Your price: ${money("1262.06")} in total. Less than ${EXPIRY_WARNING_SECONDS / 60} minutes left at this price`,
    );

    vi.advanceTimersByTime(60_000 - ANNOUNCED_MS);
    expect(text(countdown)).toBe("Price held for 0:05");
    expect(document.querySelector("[data-price-expired] [data-state]")).toBeNull();

    vi.advanceTimersByTime(5_000);
    expect(countdown.hidden).toBe(true);
    const state = stateOf("[data-price-expired]");
    expect(state.getAttribute("data-state")).toBe("price-expired");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Price expired");
    expect(text(state)).toContain("Re-price to see the current price.");
    const link = /** @type {HTMLAnchorElement} */ (state.querySelector("a[data-state-link]"));
    expect(text(link)).toBe("Re-price this flight");
    expect(link.getAttribute("href")).toBe(`/offer.html?offer=${BASE_ID}&fare=${OFFER_ID}`);
    expect(/** @type {HTMLButtonElement} */ ($("button[data-continue]")).disabled).toBe(true);
    vi.advanceTimersByTime(ANNOUNCED_MS);
    expect(liveRegion()).toBe("Price expired");

    // Nothing keeps ticking once the page is gone.
    view.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("[OFE-007 AC2] the countdown warns once when five minutes are left, without announcing every second", async () => {
    vi.useFakeTimers();
    const { view } = open({
      client: fakeClient({
        getPricedOffer: async () => pricedOffer({ expiresAt: fromNow(EXPIRY_WARNING_SECONDS + 2) }),
      }),
    });
    await view.done;
    await settle();

    const countdown = $("[data-price-countdown]");
    expect(text(countdown)).toBe("Price held for 5:02");
    expect(countdown.hasAttribute("data-expiring")).toBe(false);
    vi.advanceTimersByTime(ANNOUNCED_MS);
    expect(liveRegion()).toBe(`Your price: ${money("1262.06")} in total`);

    // 5:01 is not announced; at 5:00 the page warns once.
    vi.advanceTimersByTime(1_000 - ANNOUNCED_MS);
    expect(text(countdown)).toBe("Price held for 5:01");
    expect(liveRegion()).toBe(`Your price: ${money("1262.06")} in total`);
    vi.advanceTimersByTime(1_000);
    expect(text(countdown)).toBe("Price held for 5:00");
    expect(countdown.hasAttribute("data-expiring")).toBe(true);
    vi.advanceTimersByTime(ANNOUNCED_MS);
    expect(liveRegion()).toBe("Less than 5 minutes left at this price");

    // The next seconds update the timer only. Each check falls on a tick, where an announcement would have emptied the
    // region (it writes the message only after a short delay).
    vi.advanceTimersByTime(1_000 - ANNOUNCED_MS);
    for (const shown of ["4:59", "4:58", "4:57"]) {
      expect(text(countdown)).toBe(`Price held for ${shown}`);
      expect(liveRegion()).toBe("Less than 5 minutes left at this price");
      vi.advanceTimersByTime(1_000);
    }
  });

  it("[OFE-007 AC2] a price that has already expired shows the expired state at once", async () => {
    vi.useFakeTimers();
    const { view } = open({
      referrer: "",
      client: fakeClient({ getPricedOffer: async () => pricedOffer({ expiresAt: fromNow(-1) }) }),
    });
    await view.done;
    await settle();

    expect($("[data-price-countdown]").hidden).toBe(true);
    const state = stateOf("[data-price-expired]");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("Price expired");
    // Opened without the offer page: Re-price opens the offer page of the priced flight.
    expect(state.querySelector("a[data-state-link]")?.getAttribute("href")).toBe(
      `/offer.html?offer=${OFFER_ID}`,
    );
    expect($("a[data-back-link]").getAttribute("href")).toBe(`/offer.html?offer=${OFFER_ID}`);
    vi.advanceTimersByTime(ANNOUNCED_MS);
    expect(liveRegion()).toBe(`Your price: ${money("1262.06")} in total. Price expired`);
    // No countdown runs for an expired price.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("[OFE-007 AC2] counts down from the API's expiresAt", () => {
    const now = Date.now();
    expect(secondsLeft(new Date(now + 1_199_400).toISOString(), now)).toBe(1200);
    expect(secondsLeft(new Date(now - 5_000).toISOString(), now)).toBe(0);
    expect(secondsLeft("not a date", now)).toBeNull();
    expect(secondsLeft(undefined, now)).toBeNull();
    expect(countdownText(1199)).toBe("19:59");
    expect(countdownText(5)).toBe("0:05");
    expect(countdownText(3723)).toBe("1:02:03");
    expect(countdownText(0)).toBe("0:00");
  });
});

describe("price page: states", () => {
  it.each([
    ["410 OFFER_EXPIRED", () => apiError(ExpiredError, "OFFER_EXPIRED", 410)],
    ["404 NOT_FOUND (purged after it expired)", () => apiError(NotFoundError, "NOT_FOUND", 404)],
  ])("[OFE-007] %s shows the expired fare with a link to price the flight again", async (_name, error) => {
    const { view, client } = open({
      config: EXTRAS_CONFIG,
      client: fakeClient({
        getPricedOffer: async () => {
          throw error();
        },
      }),
    });
    await view.done;
    await settle();

    const state = stateOf("[data-price-state]");
    expect(state.getAttribute("data-state")).toBe("offer-expired");
    expect(text(state.querySelector('[data-field="title"]'))).toBe("This fare is no longer available");
    expect(state.querySelector('[data-action="retry"]')).toBeNull();
    const link = state.querySelector("a[data-state-link]");
    expect(text(link)).toBe("Price this flight again");
    expect(link?.getAttribute("href")).toBe(`/offer.html?offer=${BASE_ID}&fare=${OFFER_ID}`);
    expect($("[data-price-content]").hidden).toBe(true);
    expect(client.flights.getAncillaries).not.toHaveBeenCalled();
    expect(client.flights.getFareRules).not.toHaveBeenCalled();
    expect(document.title).toBe("This fare is no longer available");
  });

  it("[OFE-007] an expired price opened without the offer page links to a new search", async () => {
    const { view } = open({
      referrer: `${ORIGIN}/search.html?search=${SEARCH_ID}`,
      client: fakeClient({
        getPricedOffer: async () => {
          throw apiError(ExpiredError, "OFFER_EXPIRED", 410);
        },
      }),
    });
    await view.done;
    await settle();

    const link = stateOf("[data-price-state]").querySelector("a[data-state-link]");
    expect(text(link)).toBe("Search flights");
    expect(link?.getAttribute("href")).toBe("/");
    expect($("a[data-back-link]").hidden).toBe(true);
  });

  it.each([
    [
      "a connection failure",
      () => new ConnectionError({ code: "NETWORK_ERROR", message: "offline", status: 0 }),
      "unavailable",
    ],
    ["503 SERVICE_UNAVAILABLE", () => apiError(ServerError, "SERVICE_UNAVAILABLE", 503), "unavailable"],
    ["429 RATE_LIMITED", () => apiError(RateLimitError, "RATE_LIMITED", 429), "rate-limited"],
  ])(
    "[OFE-007] %s of getPricedOffer offers Retry, which loads the price again",
    async (_name, error, name) => {
      let calls = 0;
      const { view, client } = open({
        client: fakeClient({
          getPricedOffer: async () => {
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

      const state = stateOf("[data-price-state]");
      expect(state.getAttribute("data-state")).toBe(name);
      expect($("[data-price-content]").hidden).toBe(true);

      /** @type {HTMLButtonElement} */ (state.querySelector('[data-action="retry"]')).click();
      await settle();

      expect(client.flights.getPricedOffer).toHaveBeenCalledTimes(2);
      expect(document.querySelector("[data-price-state] [data-state]")).toBeNull();
      expect($("[data-price-content]").hidden).toBe(false);
      expect(text($("[data-price-total]"))).toBe(money("1262.06"));
      expect(document.activeElement).toBe($("[data-price-title]"));
    },
  );

  it.each([["priced=nope"], [""], [`priced=${OFFER_ID}`]])(
    "[OFE-007] an address without a valid priced offer id (%s) shows that the price was not found, without a call",
    async (query) => {
      const { view, client } = open({ query, referrer: "" });
      await view.done;
      await settle();

      const state = stateOf("[data-price-state]");
      expect(text(state.querySelector('[data-field="title"]'))).toBe("We could not find this price");
      expect(state.querySelector("a[data-state-link]")?.getAttribute("href")).toBe("/");
      expect(client.flights.getPricedOffer).not.toHaveBeenCalled();
    },
  );
});

describe("price page helpers", () => {
  it("[OFE-007] compares decimal amounts exactly, never as JavaScript numbers", () => {
    expect(compareDecimal("9.50", "35.00")).toBe(-1);
    expect(compareDecimal("100", "99.99")).toBe(1);
    expect(compareDecimal("0.1", "0.10")).toBe(0);
    expect(compareDecimal("007.5", "7.50")).toBe(0);
    expect(compareDecimal("-1.00", "0")).toBe(-1);
    expect(compareDecimal("-0.00", "0")).toBe(0);
    expect(compareDecimal("-2", "-10")).toBe(1);
    expect(compareDecimal("12345678901234567890.01", "12345678901234567890.02")).toBe(-1);
    expect(compareDecimal("1e3", "1")).toBeNull();
    expect(compareDecimal(5, "1")).toBeNull();
    expect(
      lowestPrice([null, eur("35.00"), eur("9.50"), eur("120.00"), { amount: "x", currency: "EUR" }]),
    ).toEqual(eur("9.50"));
    expect(lowestPrice([eur("12.00"), { amount: "1.00", currency: "USD" }])).toEqual(eur("12.00"));
    expect(lowestPrice([null, undefined])).toBeNull();
  });

  it("[OFE-007 AC1] labels fee lines by their own label, else by type, and lists unequal travellers one by one", () => {
    expect(feeLabel({ type: "service_fee", description: " Booking service fee " })).toBe(
      "Booking service fee",
    );
    expect(feeLabel({ type: "service_fee", description: null })).toBe("Service fee");
    expect(feeLabel({ type: "form_of_payment", description: "" })).toBe("Payment fee");
    expect(feeLabel({ type: "supplier", description: null })).toBe("Airline fee");
    expect(feeLabel({ type: /** @type {never} */ ("other"), description: null })).toBe("Fee");

    const lines = travellerLines(
      [
        traveller("1", "ADULT", "380.00", "56.20", "5.00", "441.20"),
        traveller("2", "ADULT", "380.00", "60.20", "5.00", "445.20"),
        traveller("3", "HELD_INFANT", "40.00", "10.00", "0.00", "50.00"),
      ],
      "en-GB",
    );
    expect(lines.map((line) => [line.label, line.detail, line.amount])).toEqual([
      [
        "Adult 1",
        `Fare ${money("380.00")} · Taxes and charges ${money("56.20")} · Fees ${money("5.00")}`,
        money("441.20"),
      ],
      [
        "Adult 2",
        `Fare ${money("380.00")} · Taxes and charges ${money("60.20")} · Fees ${money("5.00")}`,
        money("445.20"),
      ],
      ["1 infant on a lap", `Fare ${money("40.00")} · Taxes and charges ${money("10.00")}`, money("50.00")],
    ]);

    // Without a breakdown: the fees as one line, extras already priced in, and always the API's total.
    const plain = detailLines(
      /** @type {never} */ ({
        currency: "EUR",
        total: eur("999.99"),
        base: eur("800.00"),
        taxes: eur("150.00"),
        fees: eur("20.00"),
        additionalServices: eur("35.00"),
      }),
      "en-GB",
    );
    expect(plain.map((line) => [line.kind, line.label, line.amount])).toEqual([
      ["base", "Fares", money("800.00")],
      ["taxes", "Taxes and charges", money("150.00")],
      ["fee", "Fees", money("20.00")],
      ["service", "Extras", money("35.00")],
      ["total", "Total", money("999.99")],
    ]);
    const services = detailLines(
      /** @type {never} */ ({
        ...pricedOffer().price,
        breakdown: {
          travelers: [],
          fees: [],
          additionalServices: [{ type: "CHECKED_BAGS", amount: eur("35.00") }],
        },
      }),
      "en-GB",
    );
    expect(services.map((line) => line.label)).toEqual([
      "Fares",
      "Taxes and charges",
      "Fees",
      "Extra checked bags",
      "Total",
    ]);
  });

  it("[OFE-007] lists extras by kind, seats only with seat selection", () => {
    expect(extrasLines(null)).toEqual([]);
    expect(extrasLines(/** @type {never} */ (catalogue()), { locale: "en-GB", seats: true })).toEqual([
      { label: "Extra checked bags", detail: `from ${money("9.50")}` },
      { label: "Priority boarding", detail: `from ${money("8.00")}` },
      { label: "Fast track at security", detail: `from ${money("25.00")}` },
      { label: "A preferred seat, by seat number", detail: null },
    ]);
    const unpriced = /** @type {never} */ ({
      ...catalogue(),
      checkedBags: [],
      otherServices: [
        {
          ...option("anc_01JPRICEPAGESRV00009", "OTHER_SERVICES", null, null),
          name: "LOUNGE",
          label: "Lounge access",
        },
      ],
    });
    expect(extrasLines(unpriced, { locale: "en-GB" })).toEqual([{ label: "Lounge access", detail: null }]);
  });

  it("[OFE-007] links to the offer page the flight was priced on, else the first priced offer", () => {
    expect(flightLink(REFERRER, ORIGIN)).toBe(`/offer.html?offer=${BASE_ID}&fare=${OFFER_ID}`);
    expect(flightLink(REFERRER, ORIGIN, [OFFER_ID])).toBe(`/offer.html?offer=${BASE_ID}&fare=${OFFER_ID}`);
    // The offer page of another flight, another site or a malformed address never becomes the link.
    expect(flightLink(`${ORIGIN}/offer.html?offer=off_01JPRICEPAGEOTHER01`, ORIGIN, [OFFER_ID])).toBe(
      `/offer.html?offer=${OFFER_ID}`,
    );
    expect(flightLink(`https://evil.example/offer.html?offer=${OFFER_ID}`, ORIGIN, [OFFER_ID])).toBe(
      `/offer.html?offer=${OFFER_ID}`,
    );
    expect(flightLink(`${ORIGIN}/offer.html?offer=nope`, ORIGIN)).toBeNull();
    expect(flightLink("not a url", ORIGIN, ["nope"])).toBeNull();
    expect(flightLink("", ORIGIN, [])).toBeNull();
  });

  it("[OFE-007] lists what the airline needs at booking", () => {
    expect(requirementTexts(null)).toEqual([
      "The full name of each traveller, as in their passport or ID card",
    ]);
    expect(
      requirementTexts(
        /** @type {never} */ ({
          emailAddressRequired: false,
          mobilePhoneNumberRequired: false,
          phoneNumberRequired: true,
          postalCodeRequired: true,
          invoiceAddressRequired: true,
          mailingAddressRequired: true,
          travelerRequirements: [
            {
              travelerId: "1",
              genderRequired: true,
              documentIssuanceCityRequired: true,
              residenceRequired: true,
              redressRequiredIfAny: true,
              spanishResidentDiscountRequired: true,
              airFranceDiscountRequired: true,
            },
          ],
        }),
      ),
    ).toEqual([
      "The full name of each traveller, as in their passport or ID card",
      "A phone number",
      "The gender of each traveller",
      "The city where each passport or ID card was issued",
      "The address of residence of each traveller",
      "A redress number, if a traveller has one",
      "Spanish resident discount details",
      "Air France discount card details",
      "A postal code",
      "An invoice address",
      "A postal address",
    ]);
  });
});
