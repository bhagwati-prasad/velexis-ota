// The filter sidebar and the sort of the results page (ota/frontend/docs/pages.md §4, src/components/filters.js and
// sort.js): the query-string form of every filter (read, written, checked), and the sidebar of search.html (partials
// expanded by the build's include plugin) built from facets, reporting the filters its controls hold.
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import {
  FILTER_PARAMS,
  filtersToQuery,
  hasFilters,
  mount,
  readFilters,
  wholeUnits,
} from "../src/components/filters.js";
import { DEFAULT_SORT, SORTS, mount as mountSort, readSort, sortParam } from "../src/components/sort.js";
import { toQuery } from "../src/lib/url.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** @typedef {import("@velexis/ota-sdk").FlightResultFilters} FlightResultFilters */

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });

/** Facets of a return trip, as flights.listResults answers them. */
const FACETS = Object.freeze({
  total: 42,
  price: { min: eur("199.99"), max: eur("1250.40") },
  stops: [
    { value: "0", label: "Non-stop", count: 12, minPrice: eur("412.30") },
    { value: "1", label: "1 stop", count: 25, minPrice: eur("199.99") },
    { value: "2", label: "2+ stops", count: 5, minPrice: eur("250.00") },
  ],
  carriers: [
    { value: "AF", label: null, count: 20, minPrice: eur("230.00") },
    { value: "KL", label: "KLM", count: 22, minPrice: eur("199.99") },
    { value: "U2", label: null, count: 3, minPrice: null },
  ],
  cabins: [
    { value: "ECONOMY", label: "Economy", count: 40, minPrice: eur("199.99") },
    { value: "BUSINESS", label: "Business", count: 2, minPrice: eur("1100.00") },
  ],
  brandedFares: [
    { value: "LIGHT", label: "ECONOMY LIGHT", count: 10, minPrice: eur("199.99") },
    { value: "FLEX", label: null, count: 4, minPrice: eur("500.00") },
  ],
  includedCheckedBags: [
    { value: "0", label: "No checked bag", count: 10, minPrice: eur("199.99") },
    { value: "1", label: "1 checked bag", count: 30, minPrice: eur("260.00") },
    { value: "2", label: "2 checked bags", count: 2, minPrice: eur("900.00") },
  ],
  refundable: [
    { value: "true", label: "Refundable", count: 5, minPrice: eur("800.00") },
    { value: "false", label: "Non-refundable", count: 37, minPrice: eur("199.99") },
  ],
  changeable: [{ value: "unknown", label: "Unknown", count: 42, minPrice: eur("199.99") }],
  departureTimes: [0, 1].flatMap((itineraryIndex) => [
    { itineraryIndex, band: "early_morning", from: "00:00", to: "05:59", count: 0, minPrice: null },
    { itineraryIndex, band: "morning", from: "06:00", to: "11:59", count: 20, minPrice: eur("199.99") },
  ]),
  arrivalTimes: [],
  durations: [
    { itineraryIndex: 0, minMinutes: 455, maxMinutes: 1210 },
    { itineraryIndex: 1, minMinutes: 472, maxMinutes: 1298 },
  ],
});

/** @type {Browser | undefined} */
let browser;
/** @type {Document} */
let resultsPage;

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
  resultsPage = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}, 15_000); // file reads, the include plugin and one happy-dom browser; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

beforeEach(() => {
  document.body.replaceChildren(
    ...Array.from(resultsPage.body.childNodes, (node) => document.importNode(node, true)),
  );
});

afterEach(() => {
  document.body.replaceChildren();
});

const form = () => /** @type {HTMLFormElement} */ (document.querySelector("form[data-filters]"));
const group = (/** @type {string} */ name) =>
  /** @type {HTMLElement} */ (form().querySelector(`[data-filter-group="${name}"]`));
const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
/** @param {string} name @param {string} value */
const option = (name, value) =>
  /** @type {HTMLInputElement} */ (form().querySelector(`input[name="${name}"][value="${value}"]`));
/** The labels of a group's options. @param {string} name */
const labels = (name) => Array.from(group(name).querySelectorAll("li"), text);
const priceRange = () => /** @type {HTMLInputElement} */ (form().querySelector("input[data-price-range]"));
const durationRange = () =>
  /** @type {HTMLInputElement} */ (form().querySelector("input[data-duration-range]"));
const field = (/** @type {string} */ selector) =>
  /** @type {HTMLInputElement} */ (form().querySelector(selector));

/** Ticks a checkbox or radio as a click does. */
function tick(/** @type {HTMLInputElement} */ input, checked = true) {
  input.checked = checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Moves a slider or types into a field, then commits the value. */
function commit(/** @type {HTMLInputElement} */ input, /** @type {string} */ value) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Mounts the sidebar with the facets above.
 * @param {FlightResultFilters} [filters]
 */
function mountSidebar(filters = {}) {
  const onChange = vi.fn();
  const view = mount(form(), { locale: "en-GB", onChange });
  view.update({
    facets: /** @type {never} */ (FACETS),
    filters,
    carrierName: (code) => (code === "AF" ? "Air France" : code === "KL" ? "KLM Royal Dutch Airlines" : null),
    tripType: "round_trip",
  });
  return { view, onChange };
}

/** The filters as they come back from the address the page writes for them. */
const throughAddress = (/** @type {FlightResultFilters} */ filters) =>
  readFilters(new URLSearchParams(toQuery(filtersToQuery(filters))));

describe("filters in the query string", () => {
  it("[OFE-005 AC1] every filter round-trips through the query string with the API's names and comma lists", () => {
    /** @type {FlightResultFilters} */
    const filters = {
      stops: [0, 2],
      carriers: ["AF", "KL"],
      minPrice: "100",
      maxPrice: "500.50",
      departureWindow: ["0:06:00-11:59", "1:18:00-23:59"],
      arrivalWindow: ["0:00:00-05:59"],
      maxDurationMinutes: 600,
      cabins: ["ECONOMY", "BUSINESS"],
      minIncludedCheckedBags: 2,
      refundable: true,
      changeable: true,
      brandedFares: ["LIGHT", "FLEX_PLUS"],
    };
    const query = toQuery(filtersToQuery(filters));
    expect(query).toBe(
      "stops=0,2&carriers=AF,KL&minPrice=100&maxPrice=500.50" +
        "&departureWindow=0%3A06%3A00-11%3A59,1%3A18%3A00-23%3A59&arrivalWindow=0%3A00%3A00-05%3A59" +
        "&maxDurationMinutes=600&cabins=ECONOMY,BUSINESS&minIncludedCheckedBags=2&refundable=true" +
        "&changeable=true&brandedFares=LIGHT,FLEX_PLUS",
    );
    expect(readFilters(new URLSearchParams(query))).toEqual(filters);
    expect(Object.keys(filtersToQuery(filters))).toEqual([...FILTER_PARAMS]);
    // Inactive filters are written as null, so replaceQuery removes them from the address.
    expect(filtersToQuery({ stops: [1] })).toMatchObject({ stops: [1], carriers: null, refundable: null });
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ refundable: true })).toBe(true);
    expect(readFilters(new URLSearchParams(""))).toEqual({});
  });

  it("[OFE-005] malformed or unknown values are left out", () => {
    expect(
      readFilters(
        new URLSearchParams(
          "stops=2,x,3,0&stops=1&carriers=af,AFR,K1,af&minPrice=12.345&maxPrice=-5" +
            "&departureWindow=6:06:00-11:59,0:24:00-25:00,0:18:00-23:59&arrivalWindow=" +
            "&maxDurationMinutes=10&cabins=economy,COACH&minIncludedCheckedBags=0&refundable=false" +
            "&changeable=yes&brandedFares=light,no%20spaces",
        ),
      ),
    ).toEqual({
      stops: [0, 1, 2],
      carriers: ["AF", "K1"],
      departureWindow: ["0:18:00-23:59"],
      cabins: ["ECONOMY"],
      brandedFares: ["LIGHT"],
    });
    expect(readFilters(new URLSearchParams("maxDurationMinutes=4321&minIncludedCheckedBags=4"))).toEqual({});
    expect(readFilters(new URLSearchParams("maxDurationMinutes=30&minIncludedCheckedBags=3"))).toEqual({
      maxDurationMinutes: 30,
      minIncludedCheckedBags: 3,
    });
  });

  it("[OFE-005] slider bounds are whole currency units of the API's decimal strings", () => {
    expect(wholeUnits("412.30", false)).toBe(412n);
    expect(wholeUnits("412.30", true)).toBe(413n);
    expect(wholeUnits("412.00", true)).toBe(412n);
    expect(wholeUnits("99999999999999999999.01", true)).toBe(100000000000000000000n);
    expect(wholeUnits("-1", true)).toBeNull();
    expect(wholeUnits(undefined, true)).toBeNull();
  });

  it("[OFE-005] sort offers best, price, duration, departure and arrival; best is left out of the address", () => {
    expect(SORTS).toEqual(["best", "price", "duration", "departure", "arrival"]);
    expect(readSort(new URLSearchParams("sort=duration"))).toBe("duration");
    expect(readSort(new URLSearchParams("sort=-price"))).toBe(DEFAULT_SORT);
    expect(readSort(new URLSearchParams(""))).toBe("best");
    expect(sortParam("best")).toBeNull();
    expect(sortParam("arrival")).toBe("arrival");

    const select = /** @type {HTMLSelectElement} */ (document.querySelector("select[data-sort]"));
    expect(Array.from(select.options, (entry) => entry.value)).toEqual([...SORTS]);
    const onChange = vi.fn();
    const view = mountSort(select, { sort: "departure", onChange });
    expect(select.value).toBe("departure");
    select.value = "price";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("price");
    view.update({ sort: "arrival" });
    expect(select.value).toBe("arrival");
    view.destroy();
  });
});

describe("filter sidebar", () => {
  it("[OFE-005] shows the facet groups with counts, from-prices and airline names and codes", () => {
    mountSidebar();

    expect(form().hidden).toBe(false);
    expect(labels("stops")).toEqual([
      "Direct (12) from €412.30",
      "1 stop (25) from €199.99",
      "2 or more stops (5) from €250.00",
    ]);
    expect(labels("carriers")).toEqual([
      "Air France (AF) (20) from €230.00",
      "KLM Royal Dutch Airlines (KL) (22) from €199.99",
      "U2 (3)",
    ]);
    expect(labels("departureWindow")).toEqual([
      "Outbound: Early morning 00:00–05:59 (0)",
      "Outbound: Morning 06:00–11:59 (20) from €199.99",
      "Return: Early morning 00:00–05:59 (0)",
      "Return: Morning 06:00–11:59 (20) from €199.99",
    ]);
    expect(group("arrivalWindow").hidden).toBe(true);
    expect(labels("cabins")).toEqual(["Economy (40) from €199.99", "Business (2) from €1,100.00"]);
    expect(labels("minIncludedCheckedBags")).toEqual([
      "Any",
      "At least 1 checked bag",
      "At least 2 checked bags",
    ]);
    expect(option("minIncludedCheckedBags", "").checked).toBe(true);
    // Only "Refundable": no offer is known to be changeable.
    expect(labels("conditions")).toEqual(["Refundable (5) from €800.00"]);
    expect(labels("brandedFares")).toEqual(["ECONOMY LIGHT (10) from €199.99", "FLEX (4) from €500.00"]);
    // The price slider spans the whole units of the price range; the duration slider 5-minute steps of the longest
    // shortest itinerary to the longest one.
    expect([priceRange().min, priceRange().max, priceRange().value]).toEqual(["199", "1251", "1251"]);
    expect(text(form().querySelector("[data-price-output]"))).toBe("Up to €1,251.00");
    expect(priceRange().getAttribute("aria-valuetext")).toBe("Up to €1,251.00");
    expect([durationRange().min, durationRange().max, durationRange().step]).toEqual(["470", "1300", "5"]);
    expect(durationRange().getAttribute("aria-valuetext")).toBe("Up to 21 h 40 min");
    expect(field('[data-action="clear-filters"]').hidden).toBe(true);
  });

  it("[OFE-005 AC1] the controls report filters that round-trip through the query string", () => {
    const { onChange } = mountSidebar();
    /** @returns {FlightResultFilters} */
    const reported = () => onChange.mock.lastCall?.[0];

    tick(option("stops", "0"));
    expect(reported()).toEqual({ stops: [0] });
    tick(option("stops", "1"));
    tick(option("carriers", "KL"));
    tick(option("departureWindow", "0:06:00-11:59"));
    tick(option("departureWindow", "1:06:00-11:59"));
    tick(option("cabins", "BUSINESS"));
    tick(option("minIncludedCheckedBags", "2"));
    tick(option("refundable", "true"));
    tick(option("brandedFares", "FLEX"));
    commit(field('input[name="minPrice"]'), "250");
    // The slider sets the maximum price field.
    commit(priceRange(), "800");
    expect(field('input[name="maxPrice"]').value).toBe("800");
    expect(text(form().querySelector("[data-price-output]"))).toBe("Up to €800.00");
    commit(durationRange(), "900");
    expect(durationRange().getAttribute("aria-valuetext")).toBe("Up to 15 h");

    const filters = reported();
    expect(filters).toEqual({
      stops: [0, 1],
      carriers: ["KL"],
      minPrice: "250",
      maxPrice: "800",
      departureWindow: ["0:06:00-11:59", "1:06:00-11:59"],
      maxDurationMinutes: 900,
      cabins: ["BUSINESS"],
      minIncludedCheckedBags: 2,
      refundable: true,
      brandedFares: ["FLEX"],
    });
    expect(throughAddress(filters)).toEqual(filters);
    expect(field('[data-action="clear-filters"]').hidden).toBe(false);

    // A slider at its end means no limit; so does an empty price field.
    commit(priceRange(), priceRange().max);
    expect(field('input[name="maxPrice"]').value).toBe("");
    commit(durationRange(), durationRange().max);
    commit(field('input[name="minPrice"]'), "");
    expect(reported()).not.toHaveProperty("maxPrice");
    expect(reported()).not.toHaveProperty("maxDurationMinutes");
    expect(reported()).not.toHaveProperty("minPrice");
    // Typing a maximum moves the slider; Enter applies it at once.
    const maxPrice = field('input[name="maxPrice"]');
    maxPrice.value = "640.50";
    maxPrice.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(reported()).toMatchObject({ maxPrice: "640.50" });
    expect(priceRange().value).toBe("641");
  });

  it("[OFE-005] a malformed price is marked and changes nothing; the form never navigates", () => {
    const { onChange } = mountSidebar();
    const minPrice = field('input[name="minPrice"]');
    commit(minPrice, "12.345");
    expect(minPrice.getAttribute("aria-invalid")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
    commit(minPrice, "12.34");
    expect(minPrice.hasAttribute("aria-invalid")).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith({ minPrice: "12.34" });

    const submit = new Event("submit", { bubbles: true, cancelable: true });
    form().dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("[OFE-005] active filters the facets do not list keep a checkbox; Clear filters empties everything", () => {
    const { view, onChange } = mountSidebar({
      stops: [0],
      carriers: ["XQ"],
      departureWindow: ["0:05:00-09:00"],
      minIncludedCheckedBags: 3,
      changeable: true,
      maxPrice: "2000",
      maxDurationMinutes: 1300,
    });

    expect(option("carriers", "XQ").checked).toBe(true);
    expect(labels("carriers").at(-1)).toBe("XQ");
    expect(labels("departureWindow").at(-1)).toBe("Outbound: 05:00–09:00");
    expect(option("minIncludedCheckedBags", "3").checked).toBe(true);
    expect(labels("conditions")).toEqual(["Refundable (5) from €800.00", "Changes allowed"]);
    expect(option("changeable", "true").checked).toBe(true);
    // The sliders stretch to hold the chosen values, so they are not read back as "no limit".
    expect([priceRange().max, priceRange().value]).toEqual(["2000", "2000"]);
    expect(field('input[name="maxPrice"]').value).toBe("2000");
    expect([durationRange().max, durationRange().value]).toEqual(["1305", "1300"]);
    expect(view.read()).toEqual({
      stops: [0],
      carriers: ["XQ"],
      maxPrice: "2000",
      departureWindow: ["0:05:00-09:00"],
      maxDurationMinutes: 1300,
      minIncludedCheckedBags: 3,
      changeable: true,
    });

    const clear = /** @type {HTMLButtonElement} */ (form().querySelector('[data-action="clear-filters"]'));
    expect(clear.hidden).toBe(false);
    clear.click();
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(view.read()).toEqual({});
    expect(Array.from(form().querySelectorAll('input[type="checkbox"]:checked'))).toHaveLength(0);
    expect(option("minIncludedCheckedBags", "").checked).toBe(true);
    expect(clear.hidden).toBe(true);
    expect(document.activeElement).toBe(form().querySelector("[data-filters-title]"));
  });

  it("[OFE-005] filters of the address stay active when no offer matches the others (facets without ranges)", () => {
    // A reloaded address whose carrier excludes every offer: the facets carry no price range and no durations.
    const onChange = vi.fn();
    const view = mount(form(), { locale: "en-GB", onChange });
    view.update({
      facets: /** @type {never} */ ({
        ...FACETS,
        total: 0,
        price: { min: null, max: null },
        durations: [],
      }),
      filters: { carriers: ["XQ"], maxPrice: "300", maxDurationMinutes: 600 },
      carrierName: () => null,
      tripType: "round_trip",
    });

    // The duration filter is shown on its slider (the end, "no limit", above it) and read back.
    expect(group("maxDurationMinutes").hidden).toBe(false);
    expect([durationRange().min, durationRange().max, durationRange().value]).toEqual(["600", "605", "600"]);
    expect(durationRange().getAttribute("aria-valuetext")).toBe("Up to 10 h");
    // The price slider has no range to offer; the number input holds the maximum.
    expect(group("price").hidden).toBe(false);
    expect(priceRange().disabled).toBe(true);
    expect(field('input[name="maxPrice"]').value).toBe("300");
    expect(view.read()).toEqual({ carriers: ["XQ"], maxPrice: "300", maxDurationMinutes: 600 });

    // Removing the carrier keeps the other filters.
    tick(option("carriers", "XQ"), false);
    expect(onChange).toHaveBeenLastCalledWith({ maxPrice: "300", maxDurationMinutes: 600 });
    // The facets of the wider result bring the ranges: the sliders keep the chosen values.
    view.update({ facets: /** @type {never} */ (FACETS), filters: onChange.mock.lastCall?.[0] });
    expect(priceRange().disabled).toBe(false);
    expect([durationRange().min, durationRange().max, durationRange().value]).toEqual(["470", "1300", "600"]);
    commit(durationRange(), durationRange().max);
    expect(onChange).toHaveBeenLastCalledWith({ maxPrice: "300" });
    view.destroy();
  });

  it("[OFE-005] new facets update counts in place, so the focused checkbox keeps the focus", () => {
    const { view } = mountSidebar();
    const direct = option("stops", "0");
    direct.focus();
    tick(direct);
    view.update({
      facets: /** @type {never} */ ({
        ...FACETS,
        stops: [
          { value: "0", label: "Non-stop", count: 12, minPrice: eur("412.30") },
          { value: "1", label: "1 stop", count: 4, minPrice: eur("500.00") },
          { value: "2", label: "2+ stops", count: 0, minPrice: null },
        ],
      }),
      filters: { stops: [0] },
    });
    expect(option("stops", "0")).toBe(direct);
    expect(document.activeElement).toBe(direct);
    expect(direct.checked).toBe(true);
    expect(labels("stops")).toEqual([
      "Direct (12) from €412.30",
      "1 stop (4) from €500.00",
      "2 or more stops (0)",
    ]);
    // Late airline names relabel the carriers without new checkboxes.
    const before = option("carriers", "U2");
    view.update({ carrierName: (code) => (code === "U2" ? "easyJet" : null) });
    expect(option("carriers", "U2")).toBe(before);
    expect(labels("carriers")).toContain("easyJet (U2) (3)");
    view.destroy();
  });
});
