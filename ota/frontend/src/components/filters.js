// The filter sidebar of the results page (ota/frontend/docs/pages.md §4; filter semantics in
// docs/velexis-sdk/sdk/docs/B2.md §3). The `<form data-filters>` of search.html holds one fieldset per filter; this
// module fills them from the facets of `flights.listResults` and turns the controls back into `FlightResultFilters`:
//
//   stops, carriers           checkboxes (airline name and IATA code, names from reference.airlines.list)
//   departureWindow,          checkboxes per itinerary and time band (`0:06:00-11:59`); bands of one itinerary are
//   arrivalWindow             ORed, itineraries ANDed by the API
//   minPrice, maxPrice        number inputs, plus a slider for the maximum (WCAG 2.5.7: typing is an alternative)
//   maxDurationMinutes        slider; at its maximum there is no filter
//   cabins, brandedFares      checkboxes
//   minIncludedCheckedBags    radios: any, at least 1, 2 or 3 checked bags
//   refundable, changeable    checkboxes ("only offers known to be refundable")
//
// The filters are mirrored in the query string with the API's own parameter names and comma lists
// (`stops=0,1&carriers=AF,KL`): `readFilters(params)` reads and checks them (unknown or malformed values are dropped),
// `filtersToQuery(filters)` writes them. The controls are the truth once mounted; a value the facets do not list but
// the filters hold (from the address) still gets its own checkbox, so every active filter can be seen and removed.
//
// Facet updates change counts in place (no re-render), so the focus stays on the control the traveller just used.
// Counts and "from" prices are the API's own; slider bounds are whole currency units of the API's price range,
// derived from the decimal strings without floating-point arithmetic.

import { clone, fill } from "../lib/dom.js";
import { formatMinutes, formatMoney } from "../lib/format.js";
import { hasString, t } from "../lib/i18n.js";
import { getList } from "../lib/url.js";
import { airlineLabel, itineraryTitle } from "./itinerary.js";
import { CABINS } from "./search-form.js";

/** @typedef {import("@velexis/ota-sdk").FlightResultFilters} FlightResultFilters */
/** @typedef {import("@velexis/ota-sdk").Schemas["Facets"]} Facets */
/** @typedef {import("@velexis/ota-sdk").Schemas["FacetBucket"]} FacetBucket */
/** @typedef {import("@velexis/ota-sdk").Schemas["FacetTimeBand"]} FacetTimeBand */
/** @typedef {import("@velexis/ota-sdk").Schemas["Money"]} Money */
/** @typedef {import("../lib/url.js").QueryValue} QueryValue */
/**
 * What the sidebar shows; `update()` takes any part of it.
 * @typedef {object} FiltersState
 * @property {Facets | null} facets the facets of the last results page
 * @property {FlightResultFilters} filters the active filters
 * @property {(code: string) => string | null} carrierName an airline's name, `null` when unknown
 * @property {string} tripType names the itineraries of the time bands
 */
/**
 * One checkbox or radio of a group.
 * @typedef {object} OptionItem
 * @property {string} key unique within the group
 * @property {string} name the control's name (a filter parameter)
 * @property {string} value
 * @property {"checkbox" | "radio"} type
 * @property {string} label
 * @property {number | null} count matching offers (from the facet)
 * @property {Money | null} minPrice the lowest selling total among them (from the facet)
 * @property {boolean} checked
 */

/** The filter parameters, in the order they are written to the query string. */
export const FILTER_PARAMS = Object.freeze(
  /** @type {const} */ ([
    "stops",
    "carriers",
    "minPrice",
    "maxPrice",
    "departureWindow",
    "arrivalWindow",
    "maxDurationMinutes",
    "cabins",
    "minIncludedCheckedBags",
    "refundable",
    "changeable",
    "brandedFares",
  ]),
);
/** The bounds of `maxDurationMinutes` that the API accepts. */
export const DURATION_LIMITS = Object.freeze({ min: 30, max: 4320 });
/** The step of the duration slider, in minutes. */
export const DURATION_STEP = 5;

/** List filters: the checkbox groups, sent as comma lists. */
const LIST_PARAMS = /** @type {const} */ ([
  "stops",
  "carriers",
  "departureWindow",
  "arrivalWindow",
  "cabins",
  "brandedFares",
]);
/** Single-value filters of the form's named controls. */
const VALUE_PARAMS = /** @type {const} */ ([
  "minPrice",
  "maxPrice",
  "minIncludedCheckedBags",
  "refundable",
  "changeable",
]);
const STOPS = ["0", "1", "2"];
const BAGS = ["1", "2", "3"];
const CARRIER = /^[A-Z0-9]{2}$/;
const AMOUNT = /^\d{1,12}(?:\.\d{1,2})?$/;
const WINDOW = /^([0-5]):((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/;
const BRANDED_FARE = /^[A-Z0-9_]{1,30}$/;
const WHOLE_MINUTES = /^\d{1,4}$/;
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
/** At most this many values per list filter (the API's `maxItems`). */
const MAX_ITEMS = Object.freeze({
  stops: 3,
  carriers: 50,
  departureWindow: 24,
  arrivalWindow: 24,
  cabins: 4,
  brandedFares: 20,
});

/** @param {string} value */
const upper = (value) => value.toUpperCase();

/**
 * Reads the filters of a query string. Unknown or malformed values are left out; lists keep their order without
 * duplicates (stops sorted). Only `refundable=true` and `changeable=true` are read: the storefront offers no
 * "non-refundable only" filter.
 * @param {URLSearchParams} params
 * @returns {FlightResultFilters}
 */
export function readFilters(params) {
  /**
   * @param {(typeof LIST_PARAMS)[number]} name
   * @param {(value: string) => boolean} accept
   * @param {(value: string) => string} [normalise]
   */
  const list = (name, accept, normalise = (value) => value) =>
    [...new Set(getList(name, params).map(normalise))].filter(accept).slice(0, MAX_ITEMS[name]);
  /** @type {FlightResultFilters} */
  const filters = {};

  const stops = list("stops", (value) => STOPS.includes(value));
  if (stops.length > 0) {
    filters.stops = /** @type {Array<0 | 1 | 2>} */ (stops.map(Number).sort((a, b) => a - b));
  }
  const carriers = list("carriers", (value) => CARRIER.test(value), upper);
  if (carriers.length > 0) {
    filters.carriers = carriers;
  }
  for (const name of /** @type {const} */ (["minPrice", "maxPrice"])) {
    const value = params.get(name);
    if (value !== null && AMOUNT.test(value)) {
      filters[name] = value;
    }
  }
  for (const name of /** @type {const} */ (["departureWindow", "arrivalWindow"])) {
    const windows = list(name, (value) => WINDOW.test(value));
    if (windows.length > 0) {
      filters[name] = /** @type {import("@velexis/ota-sdk").ItineraryTimeWindow[]} */ (windows);
    }
  }
  const duration = params.get("maxDurationMinutes") ?? "";
  if (WHOLE_MINUTES.test(duration)) {
    const minutes = Number(duration);
    if (minutes >= DURATION_LIMITS.min && minutes <= DURATION_LIMITS.max) {
      filters.maxDurationMinutes = minutes;
    }
  }
  const cabins = list("cabins", (value) => CABINS.includes(/** @type {never} */ (value)), upper);
  if (cabins.length > 0) {
    filters.cabins = /** @type {FlightResultFilters["cabins"]} */ (cabins);
  }
  const bags = params.get("minIncludedCheckedBags") ?? "";
  if (BAGS.includes(bags)) {
    filters.minIncludedCheckedBags = /** @type {1 | 2 | 3} */ (Number(bags));
  }
  if (params.get("refundable") === "true") {
    filters.refundable = true;
  }
  if (params.get("changeable") === "true") {
    filters.changeable = true;
  }
  const brands = list("brandedFares", (value) => BRANDED_FARE.test(value), upper);
  if (brands.length > 0) {
    filters.brandedFares = brands;
  }
  return filters;
}

/**
 * The query-string parameters of the filters: every filter parameter, `null` for an inactive one (so
 * `replaceQuery` removes it), lists as arrays (written with commas).
 * @param {FlightResultFilters} filters
 * @returns {Record<string, QueryValue>}
 */
export function filtersToQuery(filters) {
  return Object.fromEntries(
    FILTER_PARAMS.map((name) => {
      const value = /** @type {unknown} */ (filters[name]);
      return [
        name,
        value === undefined || value === null
          ? null
          : Array.isArray(value)
            ? /** @type {Array<string | number>} */ (value)
            : String(value),
      ];
    }),
  );
}

/**
 * Whether any filter is active.
 * @param {FlightResultFilters} filters
 */
export const hasFilters = (filters) => FILTER_PARAMS.some((name) => filters[name] !== undefined);

/**
 * The whole currency units of a non-negative decimal amount, rounded down or up ("412.30" → 412n or 413n), without
 * floating-point arithmetic; `null` when the text is not such an amount.
 * @param {unknown} amount
 * @param {boolean} up
 * @returns {bigint | null}
 */
export function wholeUnits(amount, up) {
  const match = typeof amount === "string" ? DECIMAL.exec(amount) : null;
  if (!match) {
    return null;
  }
  const whole = BigInt(/** @type {string} */ (match[1]));
  return up && /[1-9]/.test(match[2] ?? "") ? whole + 1n : whole;
}

/**
 * The label of a time window: "Morning 06:00–11:59", with the itinerary when the trip has several
 * ("Return: Evening 18:00–23:59"). A window that is no facet band shows its times only.
 * @param {number} index
 * @param {string | null} band
 * @param {string} from
 * @param {string} to
 * @param {{ tripType: string, itineraries: number }} trip
 */
function windowLabel(index, band, from, to, trip) {
  const bandLabel = band !== null && hasString(`band.${band}`) ? t(`band.${band}`) : "";
  const text =
    trip.itineraries > 1 || index > 0
      ? t("filters.windowFor", { itinerary: itineraryTitle(index, trip.tripType), band: bandLabel, from, to })
      : t("filters.window", { band: bandLabel, from, to });
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Mounts the filter sidebar on the `<form data-filters>` of search.html. `onChange(filters)` runs after every change
 * of a control (not while a slider is dragged) and after "Clear filters". Returns `{ update, clear, read, destroy }`.
 * @param {HTMLFormElement} form
 * @param {{ locale?: string, onChange: (filters: FlightResultFilters) => void }} props
 */
export function mount(form, { locale, onChange }) {
  const doc = form.ownerDocument;
  /** @type {Map<string, HTMLElement>} */
  const groups = new Map(
    Array.from(form.querySelectorAll("[data-filter-group]"), (element) => [
      /** @type {HTMLElement} */ (element).dataset["filterGroup"] ?? "",
      /** @type {HTMLElement} */ (element),
    ]),
  );
  /** The option elements of each group by key. @type {Map<string, Map<string, { element: HTMLElement, input: HTMLInputElement }>>} */
  const optionsByGroup = new Map();
  const input = (/** @type {string} */ selector) =>
    /** @type {HTMLInputElement | null} */ (form.querySelector(selector));
  const priceRange = input("input[data-price-range]");
  const minPrice = input('input[name="minPrice"]');
  const maxPrice = input('input[name="maxPrice"]');
  const priceOutput = form.querySelector("[data-price-output]");
  const durationRange = input("input[data-duration-range]");
  const durationOutput = form.querySelector("[data-duration-output]");
  const clearButton = /** @type {HTMLButtonElement | null} */ (
    form.querySelector('[data-action="clear-filters"]')
  );

  /** @type {FiltersState} */
  const state = { facets: null, filters: {}, carrierName: () => null, tripType: "one_way" };
  /** The widest price range seen, in whole units (bounds never shrink under a chosen value). */
  /** @type {{ min: bigint, max: bigint } | null} */
  let priceBounds = null;
  /** @type {{ min: number, max: number } | null} */
  let durationBounds = null;
  let currency = "";

  /** The filters the controls hold now. */
  const read = () => {
    const data = new FormData(form);
    const params = new URLSearchParams();
    for (const name of LIST_PARAMS) {
      const values = data.getAll(name).filter((value) => typeof value === "string" && value !== "");
      if (values.length > 0) {
        params.set(name, values.join(","));
      }
    }
    for (const name of VALUE_PARAMS) {
      const value = data.get(name);
      if (typeof value === "string" && value.trim() !== "") {
        params.set(name, value.trim());
      }
    }
    if (durationRange && durationBounds && Number(durationRange.value) < durationBounds.max) {
      params.set("maxDurationMinutes", durationRange.value);
    }
    return readFilters(params);
  };

  /**
   * Adds, updates and removes the options of one group; the group is hidden without options (or, for radios, with
   * only "Any").
   * @param {string} group
   * @param {OptionItem[]} items
   */
  const syncGroup = (group, items) => {
    const fieldset = groups.get(group);
    const list = fieldset?.querySelector("[data-filter-options]");
    if (!fieldset || !list) {
      return;
    }
    let known = optionsByGroup.get(group);
    if (!known) {
      known = new Map();
      optionsByGroup.set(group, known);
    }
    const keys = new Set(items.map((item) => item.key));
    for (const [key, entry] of known) {
      if (!keys.has(key) && !entry.input.checked) {
        entry.element.remove();
        known.delete(key);
      }
    }
    for (const item of items) {
      let entry = known.get(item.key);
      if (!entry) {
        const element = clone("tpl-filter-option", doc);
        const control = /** @type {HTMLInputElement} */ (element.querySelector("input"));
        control.type = item.type;
        control.name = item.name;
        control.value = item.value;
        list.append(element);
        entry = { element, input: control };
        known.set(item.key, entry);
      }
      fill(entry.element, {
        label: item.label,
        count: item.count === null ? null : t("filters.count", { count: item.count }),
        minPrice: item.minPrice ? t("filters.from", { price: formatMoney(item.minPrice, locale) }) : null,
        noMinPrice: !item.minPrice,
      });
      entry.input.checked = item.checked;
    }
    const radios = items.length > 0 && items.every((item) => item.type === "radio");
    fieldset.hidden = radios ? items.length < 2 : items.length === 0;
  };

  /**
   * Checkbox items from facet buckets, plus the selected values the facets do not list.
   * @param {string} name
   * @param {FacetBucket[] | undefined} buckets
   * @param {string[]} selected
   * @param {(value: string, bucket: FacetBucket | null) => string} label
   * @returns {OptionItem[]}
   */
  const checkboxes = (name, buckets, selected, label) => {
    const list = Array.isArray(buckets) ? buckets : [];
    const values = [
      ...list.map((bucket) => bucket.value),
      ...selected.filter((value) => !list.some((bucket) => bucket.value === value)),
    ];
    return values.map((value) => {
      const bucket = list.find((entry) => entry.value === value) ?? null;
      return {
        key: value,
        name,
        value,
        type: "checkbox",
        label: label(value, bucket),
        count: bucket ? bucket.count : null,
        minPrice: bucket?.minPrice ?? null,
        checked: selected.includes(value),
      };
    });
  };

  /**
   * Time-window items from the facet bands of one kind, plus selected windows that are no band.
   * @param {"departureWindow" | "arrivalWindow"} name
   * @param {FacetTimeBand[] | undefined} bands
   * @returns {OptionItem[]}
   */
  const windows = (name, bands) => {
    const list = Array.isArray(bands) ? bands : [];
    const selected = /** @type {string[]} */ (state.filters[name] ?? []);
    const itineraries = new Set(list.map((band) => band.itineraryIndex)).size;
    const trip = { tripType: state.tripType, itineraries };
    /** @type {OptionItem[]} */
    const items = list.map((band) => {
      const value = `${band.itineraryIndex}:${band.from}-${band.to}`;
      return {
        key: value,
        name,
        value,
        type: "checkbox",
        label: windowLabel(band.itineraryIndex, band.band, band.from, band.to, trip),
        count: band.count,
        minPrice: band.minPrice ?? null,
        checked: selected.includes(value),
      };
    });
    for (const value of selected) {
      const match = WINDOW.exec(value);
      if (match && !items.some((item) => item.value === value)) {
        items.push({
          key: value,
          name,
          value,
          type: "checkbox",
          label: windowLabel(Number(match[1]), null, match[2] ?? "", match[3] ?? "", trip),
          count: null,
          minPrice: null,
          checked: true,
        });
      }
    }
    return items;
  };

  /** The "Any" radio and one per number of bags from 1 (the API's buckets count exact numbers, so no counts). */
  const bagOptions = () => {
    const chosen = state.filters.minIncludedCheckedBags;
    const values = new Set(
      (state.facets?.includedCheckedBags ?? [])
        .map((bucket) => bucket.value)
        .filter((value) => BAGS.includes(value)),
    );
    if (chosen !== undefined) {
      values.add(String(chosen));
    }
    /** @type {OptionItem[]} */
    const items = [
      {
        key: "",
        name: "minIncludedCheckedBags",
        value: "",
        type: "radio",
        label: t("filters.anyBags"),
        count: null,
        minPrice: null,
        checked: chosen === undefined,
      },
    ];
    for (const value of BAGS.filter((bags) => values.has(bags))) {
      items.push({
        key: value,
        name: "minIncludedCheckedBags",
        value,
        type: "radio",
        label: t("filters.minBags", { count: Number(value) }),
        count: null,
        minPrice: null,
        checked: String(chosen) === value,
      });
    }
    return items;
  };

  /** "Refundable" and "Changes allowed", when some offers are known to be so (or the filter is on). */
  const conditionOptions = () =>
    /** @type {const} */ (["refundable", "changeable"]).flatMap((name) => {
      const bucket = (state.facets?.[name] ?? []).find((entry) => entry.value === "true") ?? null;
      const checked = state.filters[name] === true;
      return bucket || checked
        ? [
            /** @type {OptionItem} */ ({
              key: name,
              name,
              value: "true",
              type: "checkbox",
              label: t(`filters.${name}`),
              count: bucket ? bucket.count : null,
              minPrice: bucket?.minPrice ?? null,
              checked,
            }),
          ]
        : [];
    });

  /** The price group: slider bounds from the widest range seen, number inputs from the filters. */
  const syncPrice = () => {
    const group = groups.get("price");
    const range = state.facets?.price;
    const low = wholeUnits(range?.min?.amount, false);
    const high = wholeUnits(range?.max?.amount, true);
    currency = range?.max?.currency ?? range?.min?.currency ?? currency;
    if (low !== null && high !== null) {
      priceBounds = priceBounds
        ? {
            min: low < priceBounds.min ? low : priceBounds.min,
            max: high > priceBounds.max ? high : priceBounds.max,
          }
        : { min: low, max: high };
    }
    const chosenMax = wholeUnits(state.filters.maxPrice, true);
    if (priceBounds && chosenMax !== null && chosenMax > priceBounds.max) {
      priceBounds = { ...priceBounds, max: chosenMax };
    }
    const active = state.filters.minPrice !== undefined || state.filters.maxPrice !== undefined;
    if (group) {
      group.hidden = !active && (!priceBounds || priceBounds.min === priceBounds.max);
    }
    if (minPrice && doc.activeElement !== minPrice) {
      minPrice.value = state.filters.minPrice ?? "";
    }
    if (maxPrice && doc.activeElement !== maxPrice) {
      maxPrice.value = state.filters.maxPrice ?? "";
    }
    if (priceRange) {
      // No price range seen yet (no offer matches the other filters): nothing to slide over, the number inputs work.
      priceRange.disabled = priceBounds === null;
    }
    if (priceRange && priceBounds) {
      priceRange.min = String(priceBounds.min);
      priceRange.max = String(priceBounds.max);
      priceRange.step = "1";
      priceRange.value = String(
        chosenMax !== null && chosenMax >= priceBounds.min ? chosenMax : priceBounds.max,
      );
      showPrice(state.filters.maxPrice ?? priceRange.value);
    }
  };

  /** @param {string} amount the maximum price the slider shows */
  const showPrice = (amount) => {
    const text = currency
      ? t("filters.maxPrice", { price: formatMoney({ amount, currency }, locale) })
      : amount;
    if (priceOutput) {
      priceOutput.textContent = text;
    }
    priceRange?.setAttribute("aria-valuetext", text);
  };

  /**
   * Widens the duration slider's bounds (they never shrink under a chosen value).
   * @param {number} min
   * @param {number} max
   */
  const widenDuration = (min, max) => {
    durationBounds = durationBounds
      ? { min: Math.min(min, durationBounds.min), max: Math.max(max, durationBounds.max) }
      : { min, max };
  };

  /**
   * The duration slider: from the longest of the shortest itineraries to the longest one, in 5-minute steps. A chosen
   * maximum always fits, with the slider's end ("no limit") above it, also when the facets have no durations (the
   * other filters exclude every offer): the slider is then the filter's only control, and `read()` reports it.
   */
  const syncDuration = () => {
    const group = groups.get("maxDurationMinutes");
    const ranges = state.facets?.durations ?? [];
    if (ranges.length > 0) {
      const low = Math.max(...ranges.map((range) => range.minMinutes));
      const high = Math.max(...ranges.map((range) => range.maxMinutes));
      widenDuration(
        Math.max(DURATION_LIMITS.min, Math.floor(low / DURATION_STEP) * DURATION_STEP),
        Math.min(DURATION_LIMITS.max, Math.ceil(high / DURATION_STEP) * DURATION_STEP),
      );
    }
    const chosen = state.filters.maxDurationMinutes;
    if (chosen !== undefined) {
      // Bounds on the 5-minute grid of the slider (its steps count from its minimum), so its end stays reachable.
      widenDuration(
        Math.floor(chosen / DURATION_STEP) * DURATION_STEP,
        Math.ceil(chosen / DURATION_STEP) * DURATION_STEP + DURATION_STEP,
      );
    }
    if (group) {
      group.hidden = chosen === undefined && (!durationBounds || durationBounds.max <= durationBounds.min);
    }
    if (durationRange && durationBounds) {
      durationRange.min = String(durationBounds.min);
      durationRange.max = String(durationBounds.max);
      durationRange.step = String(DURATION_STEP);
      durationRange.value = String(chosen ?? durationBounds.max);
      showDuration(Number(durationRange.value));
    }
  };

  /** @param {number} minutes */
  const showDuration = (minutes) => {
    const text = t("filters.maxDuration", { duration: formatMinutes(minutes) });
    if (durationOutput) {
      durationOutput.textContent = text;
    }
    durationRange?.setAttribute("aria-valuetext", text);
  };

  const render = () => {
    const { facets, filters } = state;
    syncGroup(
      "stops",
      checkboxes("stops", facets?.stops, (filters.stops ?? []).map(String), (value, bucket) =>
        hasString(`stops.${value}`) ? t(`stops.${value}`) : (bucket?.label ?? value),
      ),
    );
    syncGroup(
      "carriers",
      checkboxes("carriers", facets?.carriers, filters.carriers ?? [], (code, bucket) =>
        airlineLabel(code, state.carrierName(code) ?? bucket?.label),
      ),
    );
    syncPrice();
    syncGroup("departureWindow", windows("departureWindow", facets?.departureTimes));
    syncGroup("arrivalWindow", windows("arrivalWindow", facets?.arrivalTimes));
    syncDuration();
    syncGroup(
      "cabins",
      checkboxes("cabins", facets?.cabins, filters.cabins ?? [], (value, bucket) =>
        hasString(`cabin.${value}`) ? t(`cabin.${value}`) : (bucket?.label ?? value),
      ),
    );
    syncGroup("minIncludedCheckedBags", bagOptions());
    syncGroup("conditions", conditionOptions());
    syncGroup(
      "brandedFares",
      checkboxes(
        "brandedFares",
        facets?.brandedFares,
        filters.brandedFares ?? [],
        (code, bucket) => bucket?.label ?? code,
      ),
    );
    if (clearButton) {
      clearButton.hidden = !hasFilters(filters);
    }
    if (facets) {
      form.hidden = false;
    }
  };

  /** Applies the controls: marks a malformed price, then reports the filters. */
  const apply = () => {
    for (const field of [minPrice, maxPrice]) {
      if (field) {
        const value = field.value.trim();
        if (value !== "" && !AMOUNT.test(value)) {
          field.setAttribute("aria-invalid", "true");
        } else {
          field.removeAttribute("aria-invalid");
        }
      }
    }
    const next = read();
    if (JSON.stringify(next) === JSON.stringify(state.filters)) {
      // Nothing changed (the same value committed twice, or a malformed price): no new request.
      return;
    }
    state.filters = next;
    if (clearButton) {
      clearButton.hidden = !hasFilters(state.filters);
    }
    onChange(state.filters);
  };

  /** @param {Event} event */
  const onInput = (event) => {
    if (event.target === priceRange && priceRange) {
      showPrice(priceRange.value);
    } else if (event.target === durationRange && durationRange) {
      showDuration(Number(durationRange.value));
    }
  };

  /** @param {Event} event */
  const onFormChange = (event) => {
    if (event.target === priceRange && priceRange && maxPrice) {
      // The slider sets the maximum; at its end there is none.
      maxPrice.value = priceRange.value === priceRange.max ? "" : priceRange.value;
    } else if (event.target === maxPrice && maxPrice && priceRange && priceBounds) {
      const chosen = wholeUnits(maxPrice.value.trim(), true);
      priceRange.value = String(
        chosen !== null && chosen >= priceBounds.min && chosen <= priceBounds.max ? chosen : priceBounds.max,
      );
      showPrice(chosen === null ? priceRange.value : maxPrice.value.trim());
    }
    apply();
  };

  /** @param {Event} event */
  const onSubmit = (event) => {
    // The form never navigates: the filters apply in place.
    event.preventDefault();
    apply();
  };

  /** @param {KeyboardEvent} event Enter in a price field applies it at once. */
  const onKeyDown = (event) => {
    if (event.key === "Enter" && (event.target === minPrice || event.target === maxPrice)) {
      event.preventDefault();
      onFormChange(event);
    }
  };

  const clear = () => {
    for (const control of Array.from(form.querySelectorAll("input"))) {
      const field = /** @type {HTMLInputElement} */ (control);
      if (field.type === "checkbox") {
        field.checked = false;
      } else if (field.type === "radio") {
        field.checked = field.value === "";
      } else if (field.type === "range") {
        field.value = field.max;
      } else {
        field.value = "";
        field.removeAttribute("aria-invalid");
      }
    }
    state.filters = {};
    render();
    onChange(state.filters);
  };

  const onClear = () => {
    clear();
    // The button hides itself: the focus goes to the sidebar's heading.
    /** @type {HTMLElement | null} */ (form.querySelector("[data-filters-title]"))?.focus();
  };

  form.addEventListener("input", onInput);
  form.addEventListener("change", onFormChange);
  form.addEventListener("submit", onSubmit);
  form.addEventListener("keydown", onKeyDown);
  clearButton?.addEventListener("click", onClear);

  return {
    /** @param {Partial<FiltersState>} next */
    update(next) {
      Object.assign(state, next);
      render();
    },
    clear,
    read,
    destroy() {
      form.removeEventListener("input", onInput);
      form.removeEventListener("change", onFormChange);
      form.removeEventListener("submit", onSubmit);
      form.removeEventListener("keydown", onKeyDown);
      clearButton?.removeEventListener("click", onClear);
    },
  };
}
