// src/components/location-combobox.js (ota/frontend/docs/pages.md §3, ota/frontend/README.md §8 Search row): the ARIA
// 1.2 combobox over reference.locations.search on the real markup of partials/search-form.html, against a fake SDK.
// It covers the keyboard (arrow keys, Enter, Escape), the 250 ms debounce with the previous call aborted, the
// "No airport or city found" state, typed IATA codes when the search fails, and labels of pre-filled codes.
import { ConnectionError, NotFoundError, ServerError } from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEBOUNCE_MS, locationLabel, lookupLabel, mount } from "../src/components/location-combobox.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["Location"]} Location */

/**
 * A location as reference.locations.search answers it.
 * @param {Partial<Location> & Pick<Location, "subType" | "iataCode" | "name" | "cityName">} fields
 * @returns {Location}
 */
const location = (fields) => ({
  id: `${fields.subType}:${fields.iataCode}`,
  detailedName: fields.name,
  cityCode: fields.iataCode,
  countryCode: "FR",
  countryName: "France",
  stateCode: null,
  timeZone: "Europe/Paris",
  geoCode: { latitude: 48.85, longitude: 2.35 },
  airports: [],
  ...fields,
});

const PARIS = location({
  subType: "CITY",
  iataCode: "PAR",
  name: "Paris",
  cityName: "Paris",
  airports: [
    { iataCode: "CDG", name: "Paris Charles de Gaulle Airport" },
    { iataCode: "ORY", name: "Paris Orly Airport" },
  ],
});
const CDG = location({
  subType: "AIRPORT",
  iataCode: "CDG",
  name: "Paris Charles de Gaulle Airport",
  cityCode: "PAR",
  cityName: "Paris",
});
const ORY = location({
  subType: "AIRPORT",
  iataCode: "ORY",
  name: "Paris Orly Airport",
  cityCode: "PAR",
  cityName: "Paris",
});
const LHR = location({
  subType: "AIRPORT",
  iataCode: "LHR",
  name: "London Heathrow Airport",
  cityCode: "LON",
  cityName: "London",
  countryCode: "GB",
  countryName: "United Kingdom",
});

/** An SDK error as the SDK builds it. @param {new (init: object) => Error} ErrorClass */
const sdkError = (ErrorClass, code = "", status = 0) =>
  new ErrorClass({ code, message: `${code} from the API`, status, requestId: "req_ofe004" });

/** A page of locations as the SDK resolves it. @param {Location[]} data */
const page = (data) => ({ data, page: { nextCursor: null, limit: 8 } });

/**
 * A call of the fake `reference.locations.search` that answers when the test says so, or rejects with `ABORTED` like
 * the SDK when its signal aborts.
 * @typedef {{ params: { keyword: string }, signal: AbortSignal, at: number, resolve: (value: unknown) => void, reject: (error: unknown) => void }} PendingCall
 */

/**
 * A fake SDK client. `locations.search` answers at once with `answer(keyword)` unless `manual` is set; then each call
 * waits in `calls` for the test.
 * @param {{ answer?: (keyword: string) => Location[] | Error, manual?: boolean, airports?: Record<string, Location | Error> }} [options]
 */
function fakeClient({ answer = () => [], manual = false, airports = {} } = {}) {
  /** @type {PendingCall[]} */
  const calls = [];
  const search = vi.fn(
    (/** @type {{ keyword: string }} */ params, /** @type {{ signal?: AbortSignal }} */ options = {}) =>
      new Promise((resolve, reject) => {
        const signal = /** @type {AbortSignal} */ (options.signal ?? new AbortController().signal);
        signal.addEventListener("abort", () => reject(sdkError(ConnectionError, "ABORTED")), { once: true });
        const call = { params, signal, at: Date.now(), resolve, reject };
        calls.push(call);
        if (!manual) {
          const result = answer(params.keyword);
          if (result instanceof Error) {
            reject(result);
          } else {
            resolve(page(result));
          }
        }
      }),
  );
  const get = vi.fn(async (/** @type {{ iataCode: string }} */ { iataCode }) => {
    const airport = airports[iataCode];
    if (airport instanceof Error) {
      throw airport;
    }
    if (!airport) {
      throw sdkError(NotFoundError, "NOT_FOUND", 404);
    }
    return { ...airport, icaoCode: null, active: true };
  });
  return { calls, reference: { locations: { search }, airports: { get } } };
}

/** The search form partial's markup, read once; each test imports a fresh copy into the document. */
/** @type {Document} */
let partial;
/** @type {Browser | undefined} */
let browser;

beforeAll(() => {
  browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  const source = browser.newPage();
  source.content = readFileSync(join(STOREFRONT_ROOT, "partials", "search-form.html"), "utf8");
  partial = /** @type {Document} */ (/** @type {unknown} */ (source.mainFrame.document));
}, 15_000); // one happy-dom browser and a file read; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

beforeEach(() => {
  document.body.replaceChildren(
    ...Array.from(partial.body.childNodes, (node) => document.importNode(node, true)),
  );
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** The "From" field of the form. */
const fromRoot = () => /** @type {HTMLElement} */ (document.querySelector('[data-location-combobox="from"]'));
const textInput = () => /** @type {HTMLInputElement} */ (document.getElementById("search-from"));
const hiddenInput = () =>
  /** @type {HTMLInputElement} */ (fromRoot().querySelector("input[data-combobox-value]"));
const listbox = () => /** @type {HTMLElement} */ (fromRoot().querySelector('[role="listbox"]'));
const popup = () => /** @type {HTMLElement} */ (fromRoot().querySelector("[data-combobox-popup]"));
const options = () => Array.from(listbox().querySelectorAll('[role="option"]'));
const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim();

/** Types `value` into the focused field as one keystroke. */
function type(/** @type {string} */ value) {
  const input = textInput();
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Presses `key` in the field; returns whether its default action was prevented. */
function press(/** @type {string} */ key, /** @type {KeyboardEventInit} */ init = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  textInput().dispatchEvent(event);
  return event.defaultPrevented;
}

/** Waits until queued promise callbacks have run (the fake SDK answers at once). */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
};

/** Types `value` and lets the debounce run out and the fake SDK answer. */
async function typeAndWait(/** @type {string} */ value) {
  type(value);
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  await settle();
}

describe("location combobox: enhancement", () => {
  it("[OFE-004] turns the plain text field into a combobox whose code travels in the hidden input", () => {
    const input = textInput();
    expect(input.name).toBe("from");
    expect(input.getAttribute("pattern")).toBe("[A-Za-z]{3}");

    mount(fromRoot(), { client: fakeClient() });

    expect(input.hasAttribute("name")).toBe(false);
    expect(hiddenInput().name).toBe("from");
    expect(hiddenInput().value).toBe("");
    expect(input.hasAttribute("pattern")).toBe(false);
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("aria-controls")).toBe(listbox().id);
    // The listbox is named by the field's visible label.
    const label = /** @type {HTMLLabelElement} */ (fromRoot().querySelector("label"));
    expect(listbox().getAttribute("aria-labelledby")).toBe(label.id);
    expect(label.htmlFor).toBe(input.id);
    expect(popup().hidden).toBe(true);
  });
});

describe("location combobox: keyboard", () => {
  it("[OFE-004 AC1] arrow keys move aria-activedescendant through the suggestions, wrapping at both ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const announce = vi.fn();
    mount(fromRoot(), { client: fakeClient({ answer: () => [PARIS, CDG, ORY] }), announce });
    const input = textInput();

    await typeAndWait("Par");

    // The answer opens the list without choosing anything.
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(popup().hidden).toBe(false);
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "false",
    ]);
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    expect(options().map((option) => text(option))).toEqual([
      "PAR Paris (all airports) France · CDG, ORY",
      "CDG Paris Charles de Gaulle Airport Paris, France",
      "ORY Paris Orly Airport Paris, France",
    ]);
    expect(announce).toHaveBeenCalledWith("3 airports or cities found");

    const [paris, cdg, ory] = /** @type {HTMLElement[]} */ (options());
    expect(press("ArrowDown")).toBe(true);
    expect(input.getAttribute("aria-activedescendant")).toBe(paris?.id);
    expect(paris?.getAttribute("aria-selected")).toBe("true");
    press("ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe(cdg?.id);
    expect(options().filter((option) => option.getAttribute("aria-selected") === "true")).toEqual([cdg]);
    press("ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe(ory?.id);
    press("ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe(paris?.id);
    press("ArrowUp");
    expect(input.getAttribute("aria-activedescendant")).toBe(ory?.id);
    press("ArrowUp");
    expect(input.getAttribute("aria-activedescendant")).toBe(cdg?.id);
    // Moving the caret gives visual focus back to the text.
    press("Home");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    expect(options().every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
    // The ids are unique and point into the field's own listbox.
    expect(new Set(options().map((option) => option.id)).size).toBe(3);
    expect(paris?.id.startsWith(`${listbox().id}-`)).toBe(true);
  });

  it("[OFE-004 AC1] Enter selects the active suggestion without submitting the form", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const box = mount(fromRoot(), { client: fakeClient({ answer: () => [PARIS, CDG, ORY] }) });
    const input = textInput();
    await typeAndWait("Par");

    press("ArrowDown");
    press("ArrowDown");
    const prevented = press("Enter");

    expect(prevented).toBe(true);
    expect(input.value).toBe("Paris Charles de Gaulle Airport (CDG)");
    expect(hiddenInput().value).toBe("CDG");
    expect(box.resolve()).toBe("CDG");
    expect(box.selection()).toEqual({ code: "CDG", label: "Paris Charles de Gaulle Airport (CDG)" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(popup().hidden).toBe(true);
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    // With the list closed, Enter submits the form as usual.
    expect(press("Enter")).toBe(false);
  });

  it("[OFE-004 AC1] Escape closes the list and keeps the typed text", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const box = mount(fromRoot(), { client: fakeClient({ answer: () => [PARIS, CDG] }) });
    const input = textInput();
    await typeAndWait("Pari");
    press("ArrowDown");

    expect(press("Escape")).toBe(true);

    expect(input.value).toBe("Pari");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(popup().hidden).toBe(true);
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    expect(hiddenInput().value).toBe("");
    expect(box.selection()).toBeNull();
    // A second Escape (list already closed) leaves the text alone too.
    expect(press("Escape")).toBe(false);
    expect(input.value).toBe("Pari");
    // Down opens the same suggestions again, Alt+Down without choosing one.
    press("ArrowDown", { altKey: true });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("[OFE-004 AC1] Escape before the answer arrives keeps the list closed and the typed text", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const client = fakeClient({ answer: () => [PARIS, CDG] });
    mount(fromRoot(), { client });
    const input = textInput();
    await typeAndWait("Par");
    expect(popup().hidden).toBe(false);

    // Typing on while the old suggestions show, then Escape before the debounce runs out.
    type("Pari");
    expect(press("Escape")).toBe(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    await settle();

    expect(popup().hidden).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe("Pari");
    expect(client.reference.locations.search).toHaveBeenCalledTimes(1);

    // Escape with the list still closed (typed quickly) cancels the waiting search too.
    type("Paris");
    expect(press("Escape")).toBe(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    await settle();
    expect(popup().hidden).toBe(true);
    expect(client.reference.locations.search).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("Paris");
  });

  it("[OFE-004 AC1] typing gives the visual focus back to the text; Enter never picks a stale suggestion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const box = mount(fromRoot(), { client: fakeClient({ answer: () => [PARIS, CDG] }) });
    const input = textInput();
    await typeAndWait("Par");
    press("ArrowDown");
    press("ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]?.id);

    type("Parx");

    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    expect(options().every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
    // Enter now submits the form as usual instead of choosing CDG over the typed text.
    expect(press("Enter")).toBe(false);
    expect(input.value).toBe("Parx");
    expect(box.selection()).toBeNull();
  });

  it("[OFE-004] a click on a suggestion selects it and keeps the focus in the field", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mount(fromRoot(), { client: fakeClient({ answer: () => [PARIS, CDG, ORY] }) });
    await typeAndWait("par");
    const ory = /** @type {HTMLElement} */ (options()[2]);

    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    ory.querySelector("span")?.dispatchEvent(mousedown);
    ory.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(mousedown.defaultPrevented).toBe(true);
    expect(textInput().value).toBe("Paris Orly Airport (ORY)");
    expect(hiddenInput().value).toBe("ORY");
    expect(popup().hidden).toBe(true);
  });

  it("[OFE-004] editing a chosen place forgets its code; leaving the field closes the list", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const box = mount(fromRoot(), { client: fakeClient({ answer: () => [PARIS] }) });
    await typeAndWait("Paris");
    press("ArrowDown");
    press("Enter");
    expect(hiddenInput().value).toBe("PAR");

    await typeAndWait("Paris (PA");

    expect(hiddenInput().value).toBe("");
    expect(box.selection()).toBeNull();
    expect(popup().hidden).toBe(false);
    textInput().dispatchEvent(new FocusEvent("blur"));
    expect(popup().hidden).toBe(true);
    expect(textInput().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("location combobox: requests", () => {
  it("[OFE-004 AC3] typing quickly sends at most one request per 250 ms and aborts the previous one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const client = fakeClient({ manual: true });
    mount(fromRoot(), { client });
    const search = client.reference.locations.search;

    // A burst of keystrokes 50 ms apart: nothing is sent while typing, one request 250 ms after the last keystroke.
    for (const value of ["P", "Pa", "Par", "Pari", "Paris"]) {
      type(value);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 51);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenLastCalledWith(
      { keyword: "Paris", subType: ["AIRPORT", "CITY"], limit: 8 },
      { signal: expect.any(AbortSignal) },
    );

    // Slower typing, a keystroke every 300 ms while each answer is still out: one request per pause, and every
    // keystroke aborts the request in flight.
    for (const value of ["Paris C", "Paris Ch", "Paris Cha"]) {
      type(value);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(search).toHaveBeenCalledTimes(4);
    expect(client.calls.map((call) => call.params.keyword)).toEqual([
      "Paris",
      "Paris C",
      "Paris Ch",
      "Paris Cha",
    ]);
    expect(client.calls.map((call) => call.signal.aborted)).toEqual([true, true, true, false]);
    const gaps = client.calls.slice(1).map((call, index) => call.at - (client.calls[index]?.at ?? 0));
    expect(gaps.every((gap) => gap >= DEBOUNCE_MS)).toBe(true);

    // An aborted request's answer never reaches the list.
    client.calls[0]?.resolve(page([LHR]));
    await settle();
    expect(options()).toEqual([]);
    client.calls[3]?.resolve(page([CDG]));
    await settle();
    expect(options().map((option) => text(option))).toEqual([
      "CDG Paris Charles de Gaulle Airport Paris, France",
    ]);
  });

  it("[OFE-004] searches from 2 characters only; deleting below 2 cancels the waiting search", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const client = fakeClient({ manual: true });
    mount(fromRoot(), { client });

    type("P");
    await vi.advanceTimersByTimeAsync(1000);
    type(" P ");
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.reference.locations.search).not.toHaveBeenCalled();

    type("Pa");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(client.calls.map((call) => call.params.keyword)).toEqual(["Pa"]);
    type("P");
    expect(client.calls[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.reference.locations.search).toHaveBeenCalledTimes(1);
  });

  it("[OFE-004] shows 'No airport or city found' when the search finds nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const announce = vi.fn();
    mount(fromRoot(), { client: fakeClient({ answer: () => [] }), announce });

    await typeAndWait("Zzzz");

    const empty = /** @type {HTMLElement} */ (fromRoot().querySelector("[data-combobox-empty]"));
    expect(popup().hidden).toBe(false);
    expect(empty.hidden).toBe(false);
    expect(text(empty)).toBe("No airport or city found");
    expect(listbox().hidden).toBe(true);
    expect(textInput().getAttribute("aria-expanded")).toBe("false");
    expect(announce).toHaveBeenCalledWith("No airport or city found");
    expect(press("ArrowDown")).toBe(false);
  });

  it("[OFE-004] accepts a typed IATA code when the search fails, and only a suggested one after an answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    /** @type {Record<string, Location[] | Error>} */
    const answers = {
      LHR: sdkError(ServerError, "SERVICE_UNAVAILABLE", 503),
      lgw: sdkError(ConnectionError, "NETWORK_ERROR"),
      Bar: [
        location({ subType: "AIRPORT", iataCode: "BCN", name: "Barcelona Airport", cityName: "Barcelona" }),
      ],
      lhr: [LHR],
    };
    const box = mount(fromRoot(), {
      client: fakeClient({ answer: (keyword) => answers[keyword] ?? [] }),
    });

    // The search failed: the typed code is the field's value, upper case.
    await typeAndWait("LHR");
    expect(popup().hidden).toBe(true);
    expect(box.resolve()).toBe("LHR");
    expect(hiddenInput().value).toBe("LHR");

    await typeAndWait("lgw");
    expect(box.resolve()).toBe("LGW");

    // Typed before any answer for this text (the debounce is still running): accepted, the API checks it.
    type("ory");
    expect(box.resolve()).toBe("ORY");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // Three letters that the answer does not hold as a code are not a place.
    await typeAndWait("Bar");
    expect(box.resolve()).toBeNull();
    expect(hiddenInput().value).toBe("");

    // A typed code that the answer holds takes that suggestion's label.
    await typeAndWait("lhr");
    expect(box.resolve()).toBe("LHR");
    expect(textInput().value).toBe("London Heathrow Airport (LHR)");

    // Names are never codes.
    await typeAndWait("London");
    expect(box.resolve()).toBeNull();
  });
});

describe("location combobox: pre-filled codes", () => {
  it("[OFE-004] reference.airports.get fills the label of a pre-filled airport code", async () => {
    const client = fakeClient({ airports: { LHR } });
    const box = mount(fromRoot(), { client });

    box.setValue("lhr");
    expect(textInput().value).toBe("LHR");
    expect(hiddenInput().value).toBe("LHR");
    await settle();

    expect(client.reference.airports.get).toHaveBeenCalledWith({ iataCode: "LHR" });
    expect(textInput().value).toBe("London Heathrow Airport (LHR)");
    expect(box.resolve()).toBe("LHR");
    expect(client.reference.locations.search).not.toHaveBeenCalled();
  });

  it("[OFE-004] a city code is looked up among the locations; without an answer the code stays", async () => {
    const client = fakeClient({ answer: (keyword) => (keyword === "PAR" ? [PARIS, CDG] : []) });
    expect(await lookupLabel(client, "PAR")).toBe("Paris (PAR)");
    expect(client.reference.airports.get).toHaveBeenCalledWith({ iataCode: "PAR" });
    expect(await lookupLabel(client, "XXX")).toBeNull();

    const failing = fakeClient({ airports: { LHR: sdkError(ServerError, "INTERNAL_ERROR", 500) } });
    const box = mount(fromRoot(), { client: failing });
    box.setValue("LHR");
    await settle();
    expect(textInput().value).toBe("LHR");
    expect(box.resolve()).toBe("LHR");
    expect(failing.reference.locations.search).not.toHaveBeenCalled();
  });

  it("[OFE-004] a label that arrives after the traveller typed is dropped", async () => {
    /** @type {(label: string | null) => void} */
    let answerLabel = () => {};
    const box = mount(fromRoot(), {
      client: fakeClient(),
      labelFor: () =>
        new Promise((resolve) => {
          answerLabel = resolve;
        }),
    });

    box.setValue("LHR");
    type("Lon");
    answerLabel("London Heathrow Airport (LHR)");
    await settle();

    expect(textInput().value).toBe("Lon");
    expect(box.selection()).toBeNull();
  });

  it("[OFE-004] labels name the airport, or the city for a city code", () => {
    expect(locationLabel(LHR)).toBe("London Heathrow Airport (LHR)");
    expect(locationLabel(PARIS)).toBe("Paris (PAR)");
  });
});
