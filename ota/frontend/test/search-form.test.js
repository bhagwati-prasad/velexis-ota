// The home page's search form (ota/frontend/docs/pages.md §3): partials/search-form.html in the real index.html
// (partials expanded by the build's include plugin), enhanced by src/components/search-form.js with the passenger
// picker and the date range, against a fake SDK. It covers the query string the form sends for one-way, return and
// multi-city trips, the plain GET without JavaScript, the client checks, pre-filling from the address, the passenger
// steppers and the multi-city rows.
import { NotFoundError } from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { DEBOUNCE_MS } from "../src/components/location-combobox.js";
import { checkPassengers, passengerSummary } from "../src/components/passenger-picker.js";
import {
  MAX_LEGS,
  formatLegs,
  mount,
  parseLegs,
  readSearchQuery,
  searchUrl,
} from "../src/components/search-form.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["Location"]} Location */

/** What the mocked boot() of the home page module resolves with. */
const pageBoot = vi.hoisted(() => ({ client: /** @type {unknown} */ (null) }));
vi.mock("../src/boot.js", () => ({
  boot: async () => ({ config: {}, session: null, client: pageBoot.client }),
}));

/** The traveller's "today" in these tests. */
const TODAY = "2026-10-18";

/**
 * A location as reference.locations.search answers it.
 * @param {"AIRPORT" | "CITY"} subType
 * @param {string} iataCode
 * @param {string} name
 * @param {string} cityName
 * @returns {Location}
 */
const place = (subType, iataCode, name, cityName) => ({
  id: `${subType}:${iataCode}`,
  subType,
  iataCode,
  name,
  detailedName: name,
  cityCode: iataCode,
  cityName,
  countryCode: "XX",
  countryName: "Testland",
  stateCode: null,
  timeZone: "UTC",
  geoCode: { latitude: 0, longitude: 0 },
  airports: [],
});

/** Suggestions by keyword: the first one is the place the tests choose. */
const PLACES = /** @type {Record<string, Location[]>} */ ({
  Paris: [place("CITY", "PAR", "Paris", "Paris"), place("AIRPORT", "CDG", "Charles de Gaulle", "Paris")],
  "New York": [place("CITY", "NYC", "New York", "New York")],
  Miami: [place("AIRPORT", "MIA", "Miami International Airport", "Miami")],
  London: [place("CITY", "LON", "London", "London")],
});
/** Airports by code for reference.airports.get. */
const AIRPORTS = /** @type {Record<string, Location>} */ ({
  LHR: place("AIRPORT", "LHR", "London Heathrow Airport", "London"),
  MIA: place("AIRPORT", "MIA", "Miami International Airport", "Miami"),
});

/** A fake SDK client with the reference calls the form makes. */
function fakeClient() {
  return {
    reference: {
      locations: {
        search: vi.fn(async (/** @type {{ keyword: string }} */ { keyword }) => {
          const exact = Object.values(PLACES)
            .flat()
            .filter((location) => location.iataCode === keyword);
          return { data: PLACES[keyword] ?? exact, page: { nextCursor: null, limit: 8 } };
        }),
      },
      airports: {
        get: vi.fn(async (/** @type {{ iataCode: string }} */ { iataCode }) => {
          const airport = AIRPORTS[iataCode];
          if (!airport) {
            throw new NotFoundError({ code: "NOT_FOUND", message: "Not found", status: 404 });
          }
          return { ...airport, icaoCode: null, active: true };
        }),
      },
    },
  };
}

/** @type {Browser | undefined} */
let browser;
/** The body of index.html with its partials expanded. */
/** @type {Document} */
let homePage;

beforeAll(async () => {
  // Expands index.html with the build's include plugin and parses it once in a happy-dom browser page; each test
  // imports a fresh copy of its body into the test document.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  const html = await transform.handler(readFileSync(join(STOREFRONT_ROOT, "index.html"), "utf8"), {
    path: "/index.html",
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
  page.url = "https://demo.ota.example.com/";
  page.content = html;
  homePage = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}, 15_000); // file reads, the include plugin and one happy-dom browser; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

beforeEach(() => {
  document.body.replaceChildren(
    ...Array.from(homePage.body.childNodes, (node) => document.importNode(node, true)),
  );
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

const form = () => /** @type {HTMLFormElement} */ (document.querySelector("form[data-search-form]"));
/** @param {string} selector */
const field = (selector) => /** @type {HTMLInputElement} */ (form().querySelector(selector));
const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim();

/**
 * Mounts the form with a fake SDK; `navigate` records where the submit goes.
 * @param {string} [query] the page's address query
 */
function mountForm(query = "") {
  const client = fakeClient();
  const navigate = vi.fn();
  const announce = vi.fn();
  const view = mount(form(), {
    client,
    params: new URLSearchParams(query),
    navigate,
    announce,
    today: TODAY,
  });
  return { client, navigate, announce, view };
}

/** Waits until queued promise callbacks have run (the fake SDK answers at once). */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
};

/** Types `value` into a text field as one keystroke. */
function type(/** @type {HTMLInputElement} */ input, /** @type {string} */ value) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Presses `key` on an element; returns whether its default action was prevented. */
function press(/** @type {Element} */ element, /** @type {string} */ key) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Types a place name, waits for the suggestions and chooses the first with the keyboard. */
async function choose(/** @type {HTMLInputElement} */ input, /** @type {string} */ name) {
  type(input, name);
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  await settle();
  press(input, "ArrowDown");
  press(input, "Enter");
}

/** Sets a date input as the browser's picker does. */
function setDate(/** @type {HTMLInputElement} */ input, /** @type {string} */ value) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Submits the form as its submit button does. */
function submit() {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  form().dispatchEvent(event);
  return event;
}

/** Clicks a passenger stepper button. */
function step(/** @type {"adults" | "children" | "infants"} */ type, /** @type {1 | -1} */ delta) {
  const button = /** @type {HTMLButtonElement} */ (
    form().querySelector(`[data-stepper="${type}"] [data-step="${delta}"]`)
  );
  button.click();
  return button;
}

/** The trip radio of `value`. */
const tripRadio = (/** @type {string} */ value) => field(`input[name="trip"][value="${value}"]`);

/** Chooses a trip type as the traveller does. */
function chooseTrip(/** @type {string} */ value) {
  const radio = tripRadio(value);
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));
}

const legRows = () => Array.from(form().querySelectorAll("[data-legs] > [data-leg]"));
/** The inputs of multi-city row `index`. */
function legInputs(/** @type {number} */ index) {
  const row = /** @type {Element} */ (legRows()[index]);
  return {
    from: /** @type {HTMLInputElement} */ (
      row.querySelector('[data-location-combobox="leg-from"] input[role="combobox"]')
    ),
    to: /** @type {HTMLInputElement} */ (
      row.querySelector('[data-location-combobox="leg-to"] input[role="combobox"]')
    ),
    date: /** @type {HTMLInputElement} */ (row.querySelector("input[data-leg-date]")),
    remove: /** @type {HTMLButtonElement} */ (row.querySelector('[data-action="remove-leg"]')),
  };
}

describe("search form: without JavaScript", () => {
  it("[OFE-004] is a real GET form to /search.html whose fields are the search parameters", () => {
    const plain = form();
    expect(plain.method).toBe("get");
    expect(plain.getAttribute("action")).toBe("/search.html");
    // Typed codes are the place fields; multi-city needs JavaScript and is not offered.
    field("#search-from").value = "PAR";
    field("#search-to").value = "NYC";
    field("#search-depart").value = "2026-11-20";
    field("#search-return").value = "2026-11-27";

    expect(searchUrl(plain)).toBe(
      "/search.html?trip=return&from=PAR&to=NYC&depart=2026-11-20&return=2026-11-27&adults=1&children=0&infants=0&cabin=ECONOMY",
    );
    expect(form().querySelector("[data-trip-multi]")?.hasAttribute("hidden")).toBe(true);
    expect(tripRadio("multi").disabled).toBe(true);
    // The passenger inputs are plain number fields; the toggle and the steppers need JavaScript.
    expect(field("[data-passenger-toggle]").hidden).toBe(true);
    expect(field("[data-passenger-panel]").hidden).toBe(false);
    expect(field('[data-stepper="adults"] [data-step="1"]').hidden).toBe(true);
    // Without the toggle the panel stays in the flow of the form: it floats over the page only once enhanced.
    expect(field("[data-passenger-panel]").className).not.toMatch(/absolute/);
    mountForm();
    expect(field("[data-passenger-panel]").classList.contains("md:absolute")).toBe(true);
  });
});

describe("search form: submit", () => {
  it("[OFE-004 AC2] a return trip sends from, to, both dates, the passengers and the cabin", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { navigate } = mountForm();
    await choose(field("#search-from"), "Paris");
    await choose(field("#search-to"), "New York");
    setDate(field("#search-depart"), "2026-11-20");
    setDate(field("#search-return"), "2026-11-27");
    step("adults", 1);
    step("children", 1);
    step("infants", 1);
    field("#search-cabin").value = "BUSINESS";

    const event = submit();

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      "/search.html?trip=return&from=PAR&to=NYC&depart=2026-11-20&return=2026-11-27&adults=2&children=1&infants=1&cabin=BUSINESS",
    );
    // The visible texts are not sent; the codes are, in the hidden inputs.
    expect(field("#search-from").value).toBe("Paris (PAR)");
    expect(field('input[type="hidden"][name="from"]').value).toBe("PAR");
  });

  it("[OFE-004 AC2] a one-way trip sends no return date, even one typed before switching", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { navigate } = mountForm();
    await choose(field("#search-from"), "London");
    await choose(field("#search-to"), "Miami");
    setDate(field("#search-depart"), "2026-12-01");
    setDate(field("#search-return"), "2026-12-10");

    chooseTrip("oneway");
    expect(field("[data-return-field]").hidden).toBe(true);
    submit();

    expect(navigate).toHaveBeenCalledWith(
      "/search.html?trip=oneway&from=LON&to=MIA&depart=2026-12-01&adults=1&children=0&infants=0&cabin=ECONOMY",
    );
  });

  it("[OFE-004 AC2] a multi-city trip sends its legs as legs=FROM-TO-DATE,… instead of from, to and depart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { navigate, announce } = mountForm();
    await choose(field("#search-from"), "Paris");
    await choose(field("#search-to"), "New York");
    setDate(field("#search-depart"), "2026-11-20");

    chooseTrip("multi");

    // The first two rows start from what the simple form held: the route and date, then onwards from New York.
    expect(form().querySelector("[data-route]")?.hasAttribute("hidden")).toBe(true);
    expect(form().querySelector("[data-legs-section]")?.hasAttribute("hidden")).toBe(false);
    expect(legRows()).toHaveLength(2);
    expect(legInputs(0).from.value).toBe("Paris (PAR)");
    expect(legInputs(0).to.value).toBe("New York (NYC)");
    expect(legInputs(0).date.value).toBe("2026-11-20");
    expect(legInputs(1).from.value).toBe("New York (NYC)");
    expect(text(legRows()[1]?.querySelector("legend"))).toBe("Flight 2");
    expect(legInputs(0).remove.hidden).toBe(true);

    await choose(legInputs(1).to, "Miami");
    setDate(legInputs(1).date, "2026-11-25");
    // Renumbering the rows leaves the suggestions inside them alone.
    expect(text(legRows()[1]?.querySelector('[data-location-combobox="leg-to"] [role="option"]'))).toBe(
      "MIA Miami International Airport Miami, Testland",
    );
    /** @type {HTMLButtonElement} */ (form().querySelector('[data-action="add-leg"]')).click();
    expect(legRows()).toHaveLength(3);
    expect(announce).toHaveBeenCalledWith("Flight 3 added");
    // The new row starts where the last one ended, and the focus is in its first field.
    expect(legInputs(2).from.value).toBe("Miami International Airport (MIA)");
    expect(document.activeElement).toBe(legInputs(2).from);
    await choose(legInputs(2).to, "Paris");
    setDate(legInputs(2).date, "2026-12-01");

    submit();

    expect(navigate).toHaveBeenCalledWith(
      "/search.html?trip=multi&legs=PAR-NYC-2026-11-20,NYC-MIA-2026-11-25,MIA-PAR-2026-12-01&adults=1&children=0&infants=0&cabin=ECONOMY",
    );
  });

  it("[OFE-004 AC2] the query reads back into the same search, multi-city legs included", () => {
    const query = readSearchQuery(
      new URLSearchParams(
        "trip=multi&legs=PAR-NYC-2026-11-20,NYC-MIA-2026-11-25&adults=2&children=1&infants=1&cabin=FIRST",
      ),
    );
    expect(query).toEqual({
      trip: "multi",
      from: null,
      to: null,
      depart: null,
      return: null,
      legs: [
        { from: "PAR", to: "NYC", date: "2026-11-20" },
        { from: "NYC", to: "MIA", date: "2026-11-25" },
      ],
      adults: 2,
      children: 1,
      infants: 1,
      cabin: "FIRST",
    });
    expect(formatLegs(query.legs)).toBe("PAR-NYC-2026-11-20,NYC-MIA-2026-11-25");
    // Malformed values fall back to the defaults.
    expect(parseLegs("PAR-NYC-2026-02-30")).toEqual([]);
    expect(parseLegs("PAR-NYC")).toEqual([]);
    expect(readSearchQuery(new URLSearchParams("from=par&adults=12&cabin=LUXURY&infants=x"))).toMatchObject({
      trip: "oneway",
      from: "PAR",
      adults: 1,
      infants: 0,
      cabin: "ECONOMY",
    });
    expect(readSearchQuery(new URLSearchParams("")).trip).toBe("return");
  });
});

describe("search form: checks before leaving the page", () => {
  it("[OFE-004] a return before the departure is a field error, with the summary focused and nothing sent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { navigate } = mountForm();
    await choose(field("#search-from"), "Paris");
    await choose(field("#search-to"), "New York");
    setDate(field("#search-depart"), "2026-11-20");
    setDate(field("#search-return"), "2026-11-19");

    submit();

    expect(navigate).not.toHaveBeenCalled();
    const summary = /** @type {HTMLElement} */ (form().querySelector("[data-error-summary]"));
    expect(summary.hidden).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(text(summary.querySelector("h2"))).toBe("There is 1 problem");
    expect(text(summary.querySelector("li"))).toBe("The return cannot be before the departure");
    const returnDate = field("#search-return");
    expect(returnDate.getAttribute("aria-invalid")).toBe("true");
    expect(
      text(document.getElementById(/** @type {string} */ (returnDate.getAttribute("aria-describedby")))),
    ).toBe("The return cannot be before the departure");
    // The browser's own picker keeps the return from the departure on.
    expect(returnDate.min).toBe("2026-11-20");

    // A same-day return is a valid trip, and the errors go away.
    setDate(field("#search-return"), "2026-11-20");
    submit();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(summary.hidden).toBe(true);
    expect(returnDate.hasAttribute("aria-invalid")).toBe(false);
  });

  it("[OFE-004] missing places and dates, an unchosen text, the same place twice and a past date are reported", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { navigate } = mountForm();

    submit();
    expect(Array.from(form().querySelectorAll("[data-error-summary] li"), (item) => text(item))).toEqual([
      "Enter an airport or city",
      "Enter an airport or city",
      "Choose a date",
      "Choose a date",
    ]);
    expect(field("#search-from").getAttribute("aria-invalid")).toBe("true");

    await choose(field("#search-from"), "Paris");
    type(field("#search-to"), "Pariss");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    setDate(field("#search-depart"), "2026-10-17");
    setDate(field("#search-return"), "2026-10-20");
    submit();
    expect(Array.from(form().querySelectorAll("[data-error-summary] li"), (item) => text(item))).toEqual([
      "Choose an airport or city from the list, or type its 3-letter code",
      "Choose today or a later date",
    ]);

    await choose(field("#search-to"), "Paris");
    setDate(field("#search-depart"), TODAY);
    submit();
    expect(Array.from(form().querySelectorAll("[data-error-summary] li"), (item) => text(item))).toEqual([
      "Choose a destination different from the departure",
    ]);
    expect(navigate).not.toHaveBeenCalled();
    // The summary links to the field.
    const link = /** @type {HTMLAnchorElement} */ (form().querySelector("[data-error-summary] a"));
    link.click();
    expect(document.activeElement).toBe(field("#search-to"));
  });

  it("[OFE-004] more infants than adults, or more than 9 seats, open the passengers with the error", () => {
    const { navigate } = mountForm("from=PAR&to=NYC&depart=2026-11-20&trip=oneway");
    field("#search-adults").value = "2";
    field("#search-infants").value = "3";
    field("#search-children").value = "8";

    submit();

    expect(navigate).not.toHaveBeenCalled();
    expect(field("[data-passenger-toggle]").getAttribute("aria-expanded")).toBe("true");
    expect(field("[data-passenger-panel]").hidden).toBe(false);
    expect(Array.from(form().querySelectorAll("[data-error-summary] li"), (item) => text(item))).toEqual([
      "At most 9 passengers can have a seat (adults and children together)",
      "Each infant travels on an adult's lap: add an adult or remove an infant",
    ]);
    expect(field("#search-children").getAttribute("aria-invalid")).toBe("true");
    expect(field("#search-infants").getAttribute("aria-invalid")).toBe("true");
    expect(checkPassengers({ adults: 0, children: 0, infants: 0 })).toEqual([
      { path: "/adults", code: "ADULTS_RANGE" },
    ]);
    expect(checkPassengers({ adults: 9, children: 0, infants: 9 })).toEqual([]);

    // The summary's link (a click, or Enter on it) takes the focus to the stepper, and the panel stays open for it.
    const link = /** @type {HTMLAnchorElement} */ (form().querySelector("[data-error-summary] a"));
    link.click();
    expect(field("[data-passenger-panel]").hidden).toBe(false);
    expect(document.activeElement).toBe(field("#search-children"));
  });

  it("[OFE-004] each multi-city flight may not be before the one above it", () => {
    const { navigate } = mountForm("trip=multi&legs=PAR-NYC-2026-11-25,NYC-MIA-2026-11-20");

    submit();

    expect(navigate).not.toHaveBeenCalled();
    expect(Array.from(form().querySelectorAll("[data-error-summary] li"), (item) => text(item))).toEqual([
      "This flight cannot be before the flight above it",
    ]);
    expect(legInputs(1).date.getAttribute("aria-invalid")).toBe("true");
    expect(legInputs(1).date.min).toBe("2026-11-25");
  });
});

describe("search form: pre-filled from the address", () => {
  it("[OFE-004] fills codes with their labels from reference.airports.get, dates, passengers and cabin", async () => {
    const { client, navigate } = mountForm(
      "from=lhr&to=PAR&depart=2026-11-20&adults=2&children=1&cabin=PREMIUM_ECONOMY",
    );
    await settle();

    expect(tripRadio("oneway").checked).toBe(true);
    expect(field("#search-from").value).toBe("London Heathrow Airport (LHR)");
    // PAR is a city: no airport of that code, so its label comes from the location search.
    expect(client.reference.airports.get).toHaveBeenCalledWith({ iataCode: "PAR" });
    expect(field("#search-to").value).toBe("Paris (PAR)");
    expect(field("#search-depart").value).toBe("2026-11-20");
    expect(field("[data-passenger-summary]").textContent).toBe("2 adults, 1 child");
    expect(field("#search-cabin").value).toBe("PREMIUM_ECONOMY");

    submit();
    expect(navigate).toHaveBeenCalledWith(
      "/search.html?trip=oneway&from=LHR&to=PAR&depart=2026-11-20&adults=2&children=1&infants=0&cabin=PREMIUM_ECONOMY",
    );
  });

  it("[OFE-004] multi-city rows started from pre-filled codes get their labels too", async () => {
    const { client } = mountForm("trip=multi&from=LHR&to=MIA&depart=2026-11-20");
    await settle();

    expect(legRows()).toHaveLength(2);
    expect(legInputs(0).from.value).toBe("London Heathrow Airport (LHR)");
    expect(legInputs(0).to.value).toBe("Miami International Airport (MIA)");
    expect(legInputs(1).from.value).toBe("Miami International Airport (MIA)");
    expect(legInputs(0).date.value).toBe("2026-11-20");
    // Still one request per code for the whole form.
    expect(client.reference.airports.get).toHaveBeenCalledTimes(2);
  });

  it("[OFE-004] fills multi-city rows from legs= and asks each code's label once", async () => {
    const { client, navigate } = mountForm("trip=multi&legs=MIA-LHR-2026-11-20,LHR-MIA-2026-11-28");
    await settle();

    expect(tripRadio("multi").checked).toBe(true);
    expect(legRows()).toHaveLength(2);
    expect(legInputs(0).from.value).toBe("Miami International Airport (MIA)");
    expect(legInputs(1).to.value).toBe("Miami International Airport (MIA)");
    expect(legInputs(1).date.value).toBe("2026-11-28");
    expect(client.reference.airports.get).toHaveBeenCalledTimes(2);

    submit();
    expect(navigate).toHaveBeenCalledWith(
      "/search.html?trip=multi&legs=MIA-LHR-2026-11-20,LHR-MIA-2026-11-28&adults=1&children=0&infants=0&cabin=ECONOMY",
    );
  });
});

describe("search form: passengers and dates", () => {
  it("[OFE-004] the passenger picker is a disclosure with labelled steppers that stop at the bounds", () => {
    const { announce } = mountForm();
    const toggle = field("[data-passenger-toggle]");
    const panel = field("[data-passenger-panel]");
    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);

    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    const fewerAdults = /** @type {HTMLButtonElement} */ (
      form().querySelector('[data-stepper="adults"] [data-step="-1"]')
    );
    expect(fewerAdults.getAttribute("aria-label")).toBe("Fewer adults");
    expect(fewerAdults.getAttribute("aria-disabled")).toBe("true");
    expect(text(form().querySelector('label[for="search-infants"]'))).toBe(
      "Infants Under 2, on an adult's lap",
    );

    // No infant without an adult's lap: one infant per adult.
    const moreInfants = step("infants", 1);
    expect(field("#search-infants").value).toBe("1");
    expect(moreInfants.getAttribute("aria-disabled")).toBe("true");
    step("infants", 1);
    expect(field("#search-infants").value).toBe("1");
    expect(fewerAdults.getAttribute("aria-disabled")).toBe("true");
    expect(announce).toHaveBeenLastCalledWith("1 infant");

    // At most 9 seats: 3 adults leave room for 6 children.
    step("adults", 1);
    step("adults", 1);
    for (let i = 0; i < 8; i += 1) {
      step("children", 1);
    }
    expect(field("#search-children").value).toBe("6");
    expect(field("#search-children").max).toBe("6");
    expect(field("#search-adults").max).toBe("3");
    expect(
      form().querySelector('[data-stepper="adults"] [data-step="1"]')?.getAttribute("aria-disabled"),
    ).toBe("true");
    expect(text(form().querySelector("[data-passenger-summary]"))).toBe("3 adults, 6 children, 1 infant");
    expect(passengerSummary({ adults: 1, children: 0, infants: 0 })).toBe("1 adult");

    // Escape closes the panel and gives the focus back to the toggle; so does Done.
    press(field("#search-children"), "Escape");
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    toggle.click();
    /** @type {HTMLButtonElement} */ (form().querySelector("[data-passenger-done]")).click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // A click elsewhere on the page closes it too (the press takes the focus out of the picker first, as in a browser).
    toggle.click();
    expect(panel.hidden).toBe(false);
    toggle.blur();
    document.body.click();
    expect(panel.hidden).toBe(true);
  });

  it("[OFE-004] dates start today, the return from the departure, and only return trips show the return", () => {
    mountForm();
    const depart = field("#search-depart");
    const ret = field("#search-return");
    expect(depart.min).toBe(TODAY);
    expect(ret.min).toBe(TODAY);

    setDate(depart, "2026-12-24");
    expect(ret.min).toBe("2026-12-24");
    expect(ret.disabled).toBe(false);

    chooseTrip("oneway");
    expect(ret.disabled).toBe(true);
    expect(field("[data-return-field]").hidden).toBe(true);
    chooseTrip("multi");
    expect(depart.disabled).toBe(true);
    chooseTrip("return");
    expect(depart.disabled).toBe(false);
    expect(ret.disabled).toBe(false);
    expect(field('input[type="hidden"][name="from"]').disabled).toBe(false);
  });

  it("[OFE-004] multi-city has 2 to 6 flights; removing one renumbers the rest and keeps the focus nearby", () => {
    const { announce } = mountForm("trip=multi");
    const add = /** @type {HTMLButtonElement} */ (form().querySelector('[data-action="add-leg"]'));
    expect(legRows()).toHaveLength(2);

    while (!add.hidden) {
      add.click();
    }
    expect(legRows()).toHaveLength(MAX_LEGS);
    expect(legInputs(5).remove.getAttribute("aria-label")).toBe("Remove flight 6");
    // Every row has its own labelled fields.
    const ids = legRows().flatMap((_row, index) =>
      Object.values(legInputs(index)).map((element) => element.id),
    );
    expect(new Set(ids.filter(Boolean)).size).toBe(MAX_LEGS * 3);
    expect(form().querySelector(`label[for="${legInputs(3).date.id}"]`)).not.toBeNull();

    legInputs(1).remove.click();
    expect(legRows()).toHaveLength(MAX_LEGS - 1);
    expect(announce).toHaveBeenLastCalledWith("Flight 2 removed");
    expect(add.hidden).toBe(false);
    expect(document.activeElement).toBe(add);
    expect(legRows().map((row) => text(row.querySelector("legend")))).toEqual([
      "Flight 1",
      "Flight 2",
      "Flight 3",
      "Flight 4",
      "Flight 5",
    ]);
    expect(legInputs(1).from.getAttribute("data-error-path")).toBe(
      "/legs/1/from /originDestinations/1/originLocationCode",
    );
    while (legRows().length > 2) {
      legInputs(legRows().length - 1).remove.click();
    }
    expect(legInputs(0).remove.hidden).toBe(true);
    expect(legInputs(1).remove.hidden).toBe(true);
  });
});

describe("search form: enhancement keeps what the traveller chose", () => {
  it("[OFE-004] values the address does not mention stay as the traveller left them before the script ran", () => {
    tripRadio("oneway").checked = true;
    tripRadio("return").checked = false;
    field("#search-adults").value = "3";
    field("#search-depart").value = "2026-11-02";
    field("#search-cabin").value = "FIRST";

    mountForm("children=2");

    expect(tripRadio("oneway").checked).toBe(true);
    expect(field("[data-return-field]").hidden).toBe(true);
    expect(field("#search-depart").value).toBe("2026-11-02");
    expect(field("#search-cabin").value).toBe("FIRST");
    expect(text(form().querySelector("[data-passenger-summary]"))).toBe("3 adults, 2 children");
  });
});

describe("home page module", () => {
  it("[OFE-004] boots, then enhances the search form with the page's client and address", async () => {
    const client = fakeClient();
    pageBoot.client = client;
    const address = `${location.pathname}${location.search}`;
    history.replaceState(null, "", "/?from=LHR&trip=oneway");
    try {
      await import("../src/pages/index.js");
      await settle();
    } finally {
      history.replaceState(null, "", address);
    }

    expect(document.documentElement.dataset.js).toBe("on");
    expect(field("#search-from").getAttribute("role")).toBe("combobox");
    expect(client.reference.airports.get).toHaveBeenCalledWith({ iataCode: "LHR" });
    expect(field("#search-from").value).toBe("London Heathrow Airport (LHR)");
    expect(tripRadio("oneway").checked).toBe(true);
  });
});
