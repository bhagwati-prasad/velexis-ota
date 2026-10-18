// The flight search form (partials/search-form.html, ota/frontend/docs/pages.md §3): one-way, return and multi-city
// trips, location comboboxes, dates, passengers and cabin. The form is a real `GET /search.html` form that works
// without JavaScript; mount() enhances it and, on submit, checks it and goes to the results page with the query
// string the form itself would send:
//
//   /search.html?trip=return&from=PAR&to=NYC&depart=2026-11-20&return=2026-11-27&adults=2&children=0&infants=0&cabin=ECONOMY
//   /search.html?trip=multi&legs=PAR-NYC-2026-11-20,NYC-MIA-2026-11-25&adults=1&children=0&infants=0&cabin=ECONOMY
//
// - The parameters are the form's own successful controls in document order (lib/url.js `withQuery`, lists with
//   literal commas): hidden sections are disabled, so a one-way trip sends no `return` and a multi-city trip sends
//   `legs` instead of `from`, `to` and `depart`. A leg is `<from>-<to>-<YYYY-MM-DD>`; 2 to 6 legs.
// - Checks before leaving (pages.md §3): every place chosen or a typed code (location-combobox.js), origin and
//   destination different, dates from today, the return not before the departure, each leg not before the one above
//   it, 1–9 adults, at most 9 seats and one infant per adult (passenger-picker.js). Problems are shown with
//   lib/forms.js (`aria-invalid`, messages, an error summary that receives focus).
// - `readSearchQuery(params)` reads the same query back (the home page's address pre-fills the form; the results page
//   runs the search from it). Pre-filled codes get their labels from `reference.airports.get`.
// - Defaults: 1 adult, economy, return trip (`SEARCH_DEFAULTS`). `StorefrontConfig` publishes no search defaults, so
//   these are the storefront's own; the OTA's default cabin (`storefront_settings.search_defaults`) applies on the
//   server only to searches sent without a cabin, which this form never sends.

import { clone, fill } from "../lib/dom.js";
import { clearFieldErrors, showFieldErrors } from "../lib/forms.js";
import { t } from "../lib/i18n.js";
import { withQuery } from "../lib/url.js";
import { checkDate, isIsoDate, mount as mountDateRange, todayIso } from "./date-range.js";
import { mount as mountLiveRegion } from "./live-region.js";
import { lookupLabel, mount as mountCombobox } from "./location-combobox.js";
import { MAX_SEATS, PASSENGER_TYPES, mount as mountPassengers } from "./passenger-picker.js";

/** @typedef {import("./date-range.js").Trip} Trip */
/** @typedef {import("./location-combobox.js").ReferenceClient} ReferenceClient */
/** @typedef {ReturnType<typeof mountCombobox>} Combobox */
/** @typedef {{ path: string, code: string }} FieldError */
/** @typedef {{ from: string, to: string, date: string }} Leg */
/**
 * A search as the query string carries it. Missing or malformed values are `null` (codes, dates) or the defaults.
 * @typedef {object} SearchQuery
 * @property {Trip} trip
 * @property {string | null} from IATA code
 * @property {string | null} to IATA code
 * @property {string | null} depart `YYYY-MM-DD`
 * @property {string | null} return `YYYY-MM-DD`
 * @property {Leg[]} legs multi-city legs (empty when `legs` is missing or malformed)
 * @property {number} adults
 * @property {number} children
 * @property {number} infants
 * @property {Cabin} cabin
 */
/** @typedef {"ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST"} Cabin */
/**
 * @typedef {object} SearchFormProps
 * @property {ReferenceClient} client the SDK client (location search and labels)
 * @property {URLSearchParams} [params] a query to pre-fill the form with (the page's address)
 * @property {(url: string) => void} [navigate] goes to the results (default: `location.assign`)
 * @property {(message: string) => void} [announce] the polite live region (default: the page's)
 * @property {string} [today] the local date, `YYYY-MM-DD` (for tests)
 */

/** Trip types, as the `trip` parameter names them. */
export const TRIPS = /** @type {const} */ (["oneway", "return", "multi"]);
/** Cabins, as Amadeus names them (`travelClass`). */
export const CABINS = /** @type {const} */ (["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]);
/** Fewest and most legs of a multi-city trip (Amadeus takes up to 6 origin-destinations). */
export const MIN_LEGS = 2;
export const MAX_LEGS = 6;
/** What the form shows when the address says nothing else. */
export const SEARCH_DEFAULTS = Object.freeze({
  trip: /** @type {Trip} */ ("return"),
  adults: 1,
  children: 0,
  infants: 0,
  cabin: /** @type {Cabin} */ ("ECONOMY"),
});

const IATA_CODE = /^[A-Z]{3}$/;
const LEG = /^([A-Za-z]{3})-([A-Za-z]{3})-(\d{4}-\d{2}-\d{2})$/;
const COUNT = /^\d{1,2}$/;

/**
 * The `legs` parameter: `PAR-NYC-2026-11-20,NYC-MIA-2026-11-25`.
 * @param {ReadonlyArray<Leg>} legs
 */
export const formatLegs = (legs) => legs.map(({ from, to, date }) => `${from}-${to}-${date}`).join(",");

/**
 * Reads the `legs` parameter; an empty list when any leg is malformed or there are more than 6.
 * @param {string | null} text
 * @returns {Leg[]}
 */
export function parseLegs(text) {
  if (!text) {
    return [];
  }
  /** @type {Leg[]} */
  const legs = [];
  for (const part of text.split(",")) {
    const match = LEG.exec(part.trim());
    if (!match || !isIsoDate(match[3])) {
      return [];
    }
    legs.push({
      from: /** @type {string} */ (match[1]).toUpperCase(),
      to: /** @type {string} */ (match[2]).toUpperCase(),
      date: /** @type {string} */ (match[3]),
    });
  }
  return legs.length <= MAX_LEGS ? legs : [];
}

/**
 * A count parameter within its range, else `fallback`.
 * @param {string | null} text
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function countParam(text, min, max, fallback) {
  if (text === null || !COUNT.test(text)) {
    return fallback;
  }
  const value = Number(text);
  return value >= min && value <= max ? value : fallback;
}

/**
 * Reads a search from its query string (see the top of this file). Unknown or malformed values fall back to the
 * defaults; the trip is `trip` when valid, else multi-city with `legs`, return with `return`, one way with `from`,
 * `to` or `depart`, else the default.
 * @param {URLSearchParams} params
 * @returns {SearchQuery}
 */
export function readSearchQuery(params) {
  const code = (/** @type {string} */ name) => {
    const value = (params.get(name) ?? "").trim().toUpperCase();
    return IATA_CODE.test(value) ? value : null;
  };
  const date = (/** @type {string} */ name) => {
    const value = params.get(name);
    return isIsoDate(value) ? value : null;
  };
  const legs = parseLegs(params.get("legs"));
  const query = {
    from: code("from"),
    to: code("to"),
    depart: date("depart"),
    return: date("return"),
  };
  const tripParam = params.get("trip");
  /** @type {Trip} */
  let trip = SEARCH_DEFAULTS.trip;
  if (TRIPS.includes(/** @type {Trip} */ (tripParam))) {
    trip = /** @type {Trip} */ (tripParam);
  } else if (legs.length > 0) {
    trip = "multi";
  } else if (query.return) {
    trip = "return";
  } else if (query.from || query.to || query.depart) {
    trip = "oneway";
  }
  const cabin = params.get("cabin");
  return {
    trip,
    ...query,
    legs,
    adults: countParam(params.get("adults"), 1, MAX_SEATS, SEARCH_DEFAULTS.adults),
    children: countParam(params.get("children"), 0, MAX_SEATS - 1, SEARCH_DEFAULTS.children),
    infants: countParam(params.get("infants"), 0, MAX_SEATS, SEARCH_DEFAULTS.infants),
    cabin: CABINS.includes(/** @type {Cabin} */ (cabin))
      ? /** @type {Cabin} */ (cabin)
      : SEARCH_DEFAULTS.cabin,
  };
}

/**
 * The results URL the form sends: its successful controls in document order (disabled ones left out), empty values
 * dropped, lists with literal commas.
 * @param {HTMLFormElement} form
 */
export function searchUrl(form) {
  /** @type {Array<[string, string]>} */
  const entries = [];
  for (const [name, value] of new FormData(form)) {
    if (typeof value === "string") {
      entries.push([name, value]);
    }
  }
  return withQuery(form.getAttribute("action") || "/search.html", entries);
}

/**
 * The field errors of one place: nothing typed, or text that is neither a suggestion nor an accepted code.
 * @param {Combobox} box
 * @param {string} path
 * @returns {{ code: string | null, errors: FieldError[] }}
 */
function checkPlace(box, path) {
  if (box.isEmpty()) {
    return { code: null, errors: [{ path, code: "LOCATION_REQUIRED" }] };
  }
  const code = box.resolve();
  return { code, errors: code === null ? [{ path, code: "LOCATION_NOT_CHOSEN" }] : [] };
}

/**
 * The field errors of an origin and destination pair (each place, and the same place twice).
 * @param {Combobox} fromBox
 * @param {Combobox} toBox
 * @param {string} fromPath
 * @param {string} toPath
 * @returns {FieldError[]}
 */
function checkRoute(fromBox, toBox, fromPath, toPath) {
  const from = checkPlace(fromBox, fromPath);
  const to = checkPlace(toBox, toPath);
  const errors = [...from.errors, ...to.errors];
  if (from.code !== null && from.code === to.code) {
    errors.push({ path: toPath, code: "SAME_LOCATION" });
  }
  return errors;
}

let generatedIds = 0;

/**
 * Gives `input` (not yet in the page) an id no element of the page has, and points `label` at it.
 * @param {Document} doc
 * @param {HTMLInputElement} input
 * @param {HTMLLabelElement | null} label
 * @param {string} prefix
 */
function labelInput(doc, input, label, prefix) {
  do {
    generatedIds += 1;
    input.id = `${prefix}-${generatedIds}`;
  } while (doc.getElementById(input.id));
  if (label) {
    label.htmlFor = input.id;
  }
}

/**
 * Mounts the search form (see the top of this file). Returns `{ destroy }`.
 * @param {HTMLFormElement} form the `[data-search-form]` form
 * @param {SearchFormProps} props
 */
export function mount(
  form,
  {
    client,
    params = new URLSearchParams(),
    navigate = (url) => form.ownerDocument.defaultView?.location.assign(url),
    announce,
    today = todayIso(),
  },
) {
  const doc = form.ownerDocument;
  const say = announce ?? mountLiveRegion(doc.body).announce;
  /** @type {Map<string, Promise<string | null>>} */
  const labels = new Map();
  /** One label request per code for the whole form. @param {string} code */
  const labelFor = (code) => {
    let label = labels.get(code);
    if (!label) {
      label = lookupLabel(client, code);
      labels.set(code, label);
    }
    return label;
  };
  /** @param {Element | null} root */
  const combobox = (root) =>
    mountCombobox(/** @type {HTMLElement} */ (root), { client, announce: say, labelFor });

  form.noValidate = true;
  const route = /** @type {HTMLElement} */ (form.querySelector("[data-route]"));
  const fromBox = combobox(form.querySelector('[data-location-combobox="from"]'));
  const toBox = combobox(form.querySelector('[data-location-combobox="to"]'));
  const dates = mountDateRange(/** @type {HTMLElement} */ (form.querySelector("[data-date-range]")), {
    today,
  });
  const passengers = mountPassengers(
    /** @type {HTMLElement} */ (form.querySelector("[data-passenger-picker]")),
    { announce: say },
  );
  const cabin = /** @type {HTMLSelectElement} */ (form.querySelector('select[name="cabin"]'));
  const tripRadios = /** @type {HTMLInputElement[]} */ (
    Array.from(form.querySelectorAll('input[name="trip"]'))
  );
  const legsSection = /** @type {HTMLElement} */ (form.querySelector("[data-legs-section]"));
  const legsList = /** @type {HTMLElement} */ (form.querySelector("[data-legs]"));
  const legsValue = /** @type {HTMLInputElement} */ (form.querySelector("input[data-legs-value]"));
  const addButton = /** @type {HTMLButtonElement} */ (form.querySelector('[data-action="add-leg"]'));

  // Multi-city needs JavaScript (the legs are composed into one parameter), so it appears only now.
  form.querySelector("[data-trip-multi]")?.removeAttribute("hidden");
  for (const radio of tripRadios) {
    radio.disabled = false;
  }

  /**
   * @typedef {object} LegRow
   * @property {HTMLElement} element
   * @property {Combobox} from
   * @property {Combobox} to
   * @property {HTMLInputElement} date
   */
  /** @type {LegRow[]} */
  const legs = [];

  const trip = () => /** @type {Trip} */ (tripRadios.find((radio) => radio.checked)?.value ?? "return");

  /** Numbers the legs, their error paths and date limits, and which buttons apply. */
  const renumber = () => {
    legs.forEach((leg, index) => {
      const remove = /** @type {HTMLElement | null} */ (
        leg.element.querySelector('[data-action="remove-leg"]')
      );
      // Only the legend and the button: the suggestions inside the row have `data-field`s of their own.
      const legend = leg.element.querySelector("legend");
      const number = index + 1;
      if (legend) {
        fill(legend, { title: t("search.legTitle", { number }) });
      }
      if (remove) {
        fill(remove, { removeLabel: t("search.removeLeg", { number }) });
        remove.hidden = legs.length <= MIN_LEGS;
      }
      leg.from.input.setAttribute(
        "data-error-path",
        `/legs/${index}/from /originDestinations/${index}/originLocationCode`,
      );
      leg.to.input.setAttribute(
        "data-error-path",
        `/legs/${index}/to /originDestinations/${index}/destinationLocationCode`,
      );
      leg.date.setAttribute(
        "data-error-path",
        `/legs/${index}/date /originDestinations/${index}/departureDateTimeRange/date`,
      );
      const previous = legs[index - 1]?.date.value ?? "";
      leg.date.min = isIsoDate(previous) && previous > today ? previous : today;
    });
    addButton.hidden = legs.length >= MAX_LEGS;
  };

  /**
   * Adds a leg row, pre-filled with what is known.
   * @param {{ from?: { code: string, label?: string } | null, to?: { code: string, label?: string } | null, date?: string | null }} [values]
   */
  const addLeg = (values = {}) => {
    const element = clone("tpl-search-leg", doc);
    const date = /** @type {HTMLInputElement} */ (element.querySelector("input[data-leg-date]"));
    labelInput(doc, date, date.closest("div")?.querySelector("label") ?? null, "search-leg-date");
    legsList.append(element);
    /** @type {LegRow} */
    const leg = {
      element,
      from: combobox(element.querySelector('[data-location-combobox="leg-from"]')),
      to: combobox(element.querySelector('[data-location-combobox="leg-to"]')),
      date,
    };
    if (values.from) {
      leg.from.setValue(values.from.code, values.from.label);
    }
    if (values.to) {
      leg.to.setValue(values.to.code, values.to.label);
    }
    date.value = isIsoDate(values.date) ? values.date : "";
    date.addEventListener("change", renumber);
    element.querySelector('[data-action="remove-leg"]')?.addEventListener("click", () => removeLeg(leg));
    legs.push(leg);
    renumber();
    return leg;
  };

  /** @param {LegRow} leg */
  const removeLeg = (leg) => {
    const index = legs.indexOf(leg);
    if (index < 0 || legs.length <= MIN_LEGS) {
      return;
    }
    leg.from.destroy();
    leg.to.destroy();
    leg.element.remove();
    legs.splice(index, 1);
    renumber();
    say(t("search.legRemoved", { number: index + 1 }));
    addButton.focus();
  };

  /**
   * A chosen place to start a leg with: its label when it has a real one, else only its code, so the leg asks for the
   * label itself (a pre-filled code whose label has not arrived yet, or a typed code; still one request per code).
   * @param {{ code: string, label: string } | null} place
   */
  const legPlace = (place) =>
    place && place.label.trim().toUpperCase() !== place.code ? place : place && { code: place.code };

  /** The first two legs from what the simple form holds: its route and date, then onwards from the destination. */
  const seedLegs = () => {
    const from = legPlace(fromBox.selection());
    const to = legPlace(toBox.selection());
    addLeg({ from, to, date: dates.values().depart });
    addLeg({ from: to });
  };

  /** Shows the parts of the form the trip type needs; hidden parts are disabled, so they are not sent. */
  const applyTrip = () => {
    const current = trip();
    const multi = current === "multi";
    if (multi && legs.length === 0) {
      seedLegs();
    }
    while (multi && legs.length < MIN_LEGS) {
      addLeg();
    }
    route.hidden = multi;
    fromBox.setDisabled(multi);
    toBox.setDisabled(multi);
    dates.update({ trip: current });
    legsSection.hidden = !multi;
    legsValue.disabled = !multi;
  };

  /** Every problem of the form as field errors (the top of this file). @returns {FieldError[]} */
  const check = () => {
    /** @type {FieldError[]} */
    const errors = [];
    if (trip() === "multi") {
      legs.forEach((leg, index) => {
        errors.push(...checkRoute(leg.from, leg.to, `/legs/${index}/from`, `/legs/${index}/to`));
        errors.push(
          ...checkDate(leg.date.value, `/legs/${index}/date`, today, {
            after: legs[index - 1]?.date.value,
            afterCode: "LEG_BEFORE_PREVIOUS",
          }),
        );
      });
    } else {
      errors.push(...checkRoute(fromBox, toBox, "/from", "/to"), ...dates.check());
    }
    const passengerErrors = passengers.check();
    if (passengerErrors.length > 0) {
      // The summary links to the steppers: they must be visible.
      passengers.open();
    }
    errors.push(...passengerErrors);
    if (!CABINS.includes(/** @type {Cabin} */ (cabin.value))) {
      errors.push({ path: "/cabin", code: "enum" });
    }
    return errors;
  };

  /** @param {SubmitEvent} event */
  const onSubmit = (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    const errors = check();
    if (errors.length > 0) {
      showFieldErrors(form, errors);
      return;
    }
    legsValue.value =
      trip() === "multi"
        ? formatLegs(
            legs.map((leg) => ({
              from: /** @type {string} */ (leg.from.resolve()),
              to: /** @type {string} */ (leg.to.resolve()),
              date: leg.date.value,
            })),
          )
        : "";
    navigate(searchUrl(form));
  };

  const onTripChange = () => {
    clearFieldErrors(form);
    applyTrip();
  };

  const onAddLeg = () => {
    if (legs.length < MAX_LEGS) {
      const leg = addLeg({ from: legPlace(legs[legs.length - 1]?.to.selection() ?? null) });
      say(t("search.legAdded", { number: legs.length }));
      leg.from.focus();
    }
  };

  // Pre-fill from the address. What it does not mention keeps the form's own value: its default, or what the
  // traveller chose before the script ran.
  const query = readSearchQuery(params);
  if (["trip", "legs", "from", "to", "depart", "return"].some((name) => params.has(name))) {
    for (const radio of tripRadios) {
      radio.checked = radio.value === query.trip;
    }
  }
  if (query.from) {
    fromBox.setValue(query.from);
  }
  if (query.to) {
    toBox.setValue(query.to);
  }
  dates.set({
    ...(params.has("depart") ? { depart: query.depart } : {}),
    ...(params.has("return") ? { return: query.return } : {}),
  });
  passengers.set(
    Object.fromEntries(PASSENGER_TYPES.filter((type) => params.has(type)).map((type) => [type, query[type]])),
  );
  if (params.has("cabin")) {
    cabin.value = query.cabin;
  }
  for (const leg of query.legs) {
    addLeg({ from: { code: leg.from }, to: { code: leg.to }, date: leg.date });
  }
  applyTrip();

  form.addEventListener("submit", onSubmit);
  for (const radio of tripRadios) {
    radio.addEventListener("change", onTripChange);
  }
  addButton.addEventListener("click", onAddLeg);

  return {
    destroy() {
      form.removeEventListener("submit", onSubmit);
      for (const radio of tripRadios) {
        radio.removeEventListener("change", onTripChange);
      }
      addButton.removeEventListener("click", onAddLeg);
      for (const box of [fromBox, toBox, ...legs.flatMap((leg) => [leg.from, leg.to])]) {
        box.destroy();
      }
      passengers.destroy();
      dates.destroy();
    },
  };
}
