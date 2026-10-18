// Airport and city autocomplete of the search form (ota/frontend/docs/pages.md §3, ota/frontend/README.md §8 Search
// row): the ARIA 1.2 combobox pattern with list autocomplete over `reference.locations.search`.
//
// Markup (partials/search-form.html): a wrapper `[data-location-combobox]` with a `<label>`, the visible text input
// and a hidden input `[data-combobox-value]`. Without JavaScript the text input carries the field's `name`, so a
// typed 3-letter code is sent as it is. mount() moves the name to the hidden input, which then holds the chosen IATA
// code, and adds the listbox (options cloned from `<template id="tpl-location-option">` and filled with textContent).
//
// - Search: from 2 characters, 250 ms after the last keystroke, `{ keyword, subType: ["AIRPORT", "CITY"], limit: 8 }`.
//   Every keystroke aborts the call in flight through `options.signal` (its `ABORTED` error is ignored), so typing
//   quickly sends at most one request per 250 ms and an old answer never overwrites a newer one.
// - Keyboard: Down and Up open the list and move `aria-activedescendant` (wrapping), Alt+Down opens it without
//   moving, Enter selects the active option (without submitting the form), Escape closes the list, keeps the typed
//   text and drops a search still waiting (so its answer does not open the list again), Home, End, Left, Right and
//   typing give the visual focus back to the text. The list closes when the field loses focus.
// - A typed IATA code is accepted when the search failed (or has not answered yet for that text); after a successful
//   answer it must be one of the suggestions. `resolve()` gives the code the form sends.
// - `setValue(code)` pre-fills a code (from the address bar) and asks `reference.airports.get` for its label; a city
//   code, which is no airport, is looked up among the locations; without an answer the code itself stays.

import { NotFoundError } from "@velexis/ota-sdk";

import { clone, fill } from "../lib/dom.js";
import { isAborted } from "../lib/errors.js";
import { t } from "../lib/i18n.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["Location"]} Location */
/** @typedef {Pick<VelexisClient, "reference">} ReferenceClient */
/** @typedef {{ code: string, label: string }} Selection */
/**
 * @typedef {object} ComboboxProps
 * @property {ReferenceClient} client the SDK client
 * @property {(message: string) => void} [announce] the page's polite live region (result counts)
 * @property {(code: string) => Promise<string | null>} [labelFor] the label of a pre-filled code (default:
 *   `lookupLabel`)
 * @property {number} [debounceMs] the pause after the last keystroke before searching (250 ms)
 */

/** Fewest characters that start a search. */
export const MIN_KEYWORD_LENGTH = 2;
/** Longest keyword the API accepts. */
export const MAX_KEYWORD_LENGTH = 50;
/** Pause after the last keystroke before searching, in ms. */
export const DEBOUNCE_MS = 250;
/** Suggestions per search. */
export const SUGGESTION_LIMIT = 8;
/** Location types the field suggests. */
const SUB_TYPES = /** @type {const} */ (["AIRPORT", "CITY"]);
const IATA_CODE = /^[A-Za-z]{3}$/;

let generatedIds = 0;

/**
 * An id that no element of `doc` has yet.
 * @param {Document} doc
 * @param {string} prefix
 */
function unusedId(doc, prefix) {
  let id;
  do {
    generatedIds += 1;
    id = `${prefix}-${generatedIds}`;
  } while (doc.getElementById(id));
  return id;
}

/**
 * The text a chosen location shows in the field: "London Heathrow Airport (LHR)", or the city for a city code,
 * "London (LON)".
 * @param {Pick<Location, "subType" | "iataCode" | "name" | "cityName">} location
 */
export function locationLabel(location) {
  const name = location.subType === "CITY" ? location.cityName || location.name : location.name;
  return t("location.label", { name: name || location.iataCode, code: location.iataCode });
}

/**
 * The label of a pre-filled code: the airport's name from `reference.airports.get`, or, for a code that is no
 * airport (a city such as PAR), the exact match of `reference.locations.search`. `null` when neither answers.
 * @param {ReferenceClient} client
 * @param {string} code
 * @returns {Promise<string | null>}
 */
export async function lookupLabel(client, code) {
  try {
    const airport = await client.reference.airports.get({ iataCode: code });
    return t("location.label", { name: airport.name, code: airport.iataCode });
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      return null;
    }
  }
  try {
    const page = await client.reference.locations.search({
      keyword: code,
      subType: [...SUB_TYPES],
      limit: SUGGESTION_LIMIT,
    });
    const match = (page.data ?? []).find((location) => location.iataCode === code);
    return match ? locationLabel(match) : null;
  } catch {
    return null;
  }
}

/**
 * The option texts of a location: its code, a title and a detail line.
 * @param {Location} location
 */
function optionData(location) {
  if (location.subType === "CITY") {
    const airports = (location.airports ?? []).map((airport) => airport.iataCode).join(", ");
    return {
      code: location.iataCode,
      title: t("location.allAirports", { city: location.cityName || location.name }),
      detail: airports
        ? t("location.cityDetail", { country: location.countryName, airports })
        : location.countryName,
    };
  }
  return {
    code: location.iataCode,
    title: location.name,
    detail: t("location.place", { city: location.cityName, country: location.countryName }),
  };
}

/**
 * Mounts the combobox on its wrapper. Returns the field's controls: `resolve()` (the code to send, see the top of
 * this file), `selection()`, `setValue(code, label?)`, `clear()`, `setDisabled(disabled)`, `focus()` and `destroy()`.
 * @param {HTMLElement} root the `[data-location-combobox]` wrapper
 * @param {ComboboxProps} props
 */
export function mount(root, { client, announce = () => {}, labelFor, debounceMs = DEBOUNCE_MS }) {
  const doc = root.ownerDocument;
  const input = /** @type {HTMLInputElement} */ (root.querySelector('input:not([type="hidden"])'));
  const hidden = /** @type {HTMLInputElement} */ (root.querySelector("input[data-combobox-value]"));
  const label = root.querySelector("label");
  const lookup = labelFor ?? ((/** @type {string} */ code) => lookupLabel(client, code));

  if (!input.id) {
    input.id = unusedId(doc, "vx-location");
  }
  if (label) {
    label.htmlFor = input.id;
    label.id ||= `${input.id}-label`;
  }
  // From now on the IATA code travels in the hidden input; the visible text has no name.
  if (input.name) {
    hidden.name = input.name;
    input.removeAttribute("name");
  }
  hidden.value = "";
  input.removeAttribute("pattern");
  input.removeAttribute("title");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("autocomplete", "off");

  const popup = doc.createElement("div");
  popup.className =
    "absolute left-0 z-30 mt-1 w-full min-w-64 overflow-hidden rounded-ui border border-muted/40 bg-surface text-ink shadow-lg";
  popup.hidden = true;
  popup.dataset.comboboxPopup = "";
  const listbox = doc.createElement("ul");
  listbox.id = `${input.id}-listbox`;
  listbox.setAttribute("role", "listbox");
  if (label) {
    listbox.setAttribute("aria-labelledby", label.id);
  }
  listbox.className = "max-h-80 overflow-y-auto py-1";
  const empty = doc.createElement("p");
  empty.className = "px-3 py-2 text-muted";
  empty.textContent = t("location.none");
  empty.hidden = true;
  empty.dataset.comboboxEmpty = "";
  popup.append(listbox, empty);
  root.append(popup);
  input.setAttribute("aria-controls", listbox.id);

  /** @type {Selection | null} */
  let selected = null;
  /** @type {Location[]} */
  let options = [];
  let active = -1;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {AbortController | null} */
  let controller = null;
  /** The last search that answered: its keyword, whether it failed, and its suggestions. */
  /** @type {{ keyword: string, failed: boolean, locations: Location[] } | null} */
  let answered = null;
  /** Increases with every change of the value, so a late label of a pre-filled code never replaces a newer one. */
  let generation = 0;

  const isOpen = () => !popup.hidden;
  const optionElements = () =>
    /** @type {HTMLElement[]} */ (Array.from(listbox.querySelectorAll('[role="option"]')));

  /** @param {number} index */
  const setActive = (index) => {
    active = index;
    optionElements().forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
    const current = index >= 0 ? optionElements()[index] : undefined;
    if (current) {
      input.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView?.({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const close = () => {
    popup.hidden = true;
    input.setAttribute("aria-expanded", "false");
    setActive(-1);
  };

  /** Shows the suggestions, or "No airport or city found" after an answer without any. */
  const open = () => {
    const hasOptions = options.length > 0;
    listbox.hidden = !hasOptions;
    empty.hidden = hasOptions;
    popup.hidden = false;
    input.setAttribute("aria-expanded", String(hasOptions));
  };

  /** @param {Location[]} locations */
  const render = (locations) => {
    options = locations;
    const elements = locations.map((location, index) => {
      /** @type {HTMLElement} */
      let option;
      try {
        option = clone("tpl-location-option", doc);
        fill(option, optionData(location));
      } catch {
        option = doc.createElement("li");
        option.setAttribute("role", "option");
        option.textContent = locationLabel(location);
      }
      option.id = `${listbox.id}-${index}`;
      option.dataset.index = String(index);
      option.setAttribute("aria-selected", "false");
      return option;
    });
    listbox.replaceChildren(...elements);
    active = -1;
    input.removeAttribute("aria-activedescendant");
  };

  /** @param {Selection | null} selection */
  const select = (selection) => {
    selected = selection;
    hidden.value = selection?.code ?? "";
    if (selection) {
      input.value = selection.label;
    }
  };

  /** @param {number} index */
  const choose = (index) => {
    const location = options[index];
    if (location) {
      generation += 1;
      select({ code: location.iataCode, label: locationLabel(location) });
    }
    close();
  };

  const cancelSearch = () => {
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = null;
  };

  /** @param {string} keyword */
  const search = async (keyword) => {
    const own = new AbortController();
    controller = own;
    try {
      const page = await client.reference.locations.search(
        { keyword: keyword.slice(0, MAX_KEYWORD_LENGTH), subType: [...SUB_TYPES], limit: SUGGESTION_LIMIT },
        { signal: own.signal },
      );
      if (own.signal.aborted) {
        return;
      }
      const locations = Array.isArray(page?.data) ? page.data : [];
      answered = { keyword, failed: false, locations };
      render(locations);
      if (doc.activeElement === input) {
        open();
        announce(
          locations.length > 0 ? t("location.count", { count: locations.length }) : t("location.none"),
        );
      }
    } catch (error) {
      if (own.signal.aborted || isAborted(error)) {
        return;
      }
      // The field still accepts a typed IATA code (resolve()).
      answered = { keyword, failed: true, locations: [] };
      render([]);
      close();
    } finally {
      if (controller === own) {
        controller = null;
      }
    }
  };

  const onInput = () => {
    if (selected && input.value !== selected.label) {
      select(null);
    }
    generation += 1;
    cancelSearch();
    // Typing gives the visual focus back to the text: Enter must not pick a suggestion of an older keyword.
    if (active >= 0) {
      setActive(-1);
    }
    const keyword = input.value.trim();
    if (keyword.length < MIN_KEYWORD_LENGTH) {
      render([]);
      close();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void search(keyword);
    }, debounceMs);
  };

  /** @param {KeyboardEvent} event */
  const onKeyDown = (event) => {
    const count = options.length;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (count === 0) {
          return;
        }
        event.preventDefault();
        const down = event.key === "ArrowDown";
        if (!isOpen()) {
          open();
          if (!event.altKey) {
            setActive(down ? 0 : count - 1);
          }
        } else if (!event.altKey) {
          setActive(down ? (active + 1) % count : active <= 0 ? count - 1 : active - 1);
        }
        return;
      }
      case "Enter":
        if (isOpen() && active >= 0) {
          event.preventDefault();
          choose(active);
        } else if (isOpen()) {
          close();
        }
        return;
      case "Escape":
        // A search still waiting for the debounce or its answer would open the list again: it is dropped too.
        cancelSearch();
        if (isOpen()) {
          // Closes the list; the typed text stays.
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        return;
      case "Home":
      case "End":
      case "ArrowLeft":
      case "ArrowRight":
        if (active >= 0) {
          setActive(-1);
        }
        return;
      default:
    }
  };

  /** @param {Event} event */
  const onPopupMouseDown = (event) => {
    // Keeps the focus in the field while an option is clicked.
    event.preventDefault();
  };

  /** @param {Event} event */
  const onPopupClick = (event) => {
    const target = /** @type {Element | null} */ (event.target);
    const option = target && typeof target.closest === "function" ? target.closest('[role="option"]') : null;
    if (option) {
      choose(Number(option.getAttribute("data-index")));
    }
  };

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("blur", close);
  popup.addEventListener("mousedown", onPopupMouseDown);
  popup.addEventListener("click", onPopupClick);

  return {
    /** The visible text input (for field errors and focus). */
    input,
    /**
     * The IATA code the form sends, or `null`: the chosen suggestion; else a typed 3-letter code that matches a
     * suggestion of the answer for that text, or any typed code when that search failed or has not answered.
     * The hidden input is set accordingly.
     * @returns {string | null}
     */
    resolve() {
      if (selected) {
        return selected.code;
      }
      const text = input.value.trim();
      if (!IATA_CODE.test(text)) {
        return null;
      }
      const code = text.toUpperCase();
      const sameText = answered !== null && answered.keyword.toUpperCase() === code;
      const match = sameText ? answered?.locations.find((location) => location.iataCode === code) : undefined;
      if (match) {
        select({ code, label: locationLabel(match) });
        return code;
      }
      if (!sameText || answered?.failed) {
        select({ code, label: input.value });
        return code;
      }
      return null;
    },
    /** The chosen code and its label, or `null`. */
    selection: () => (selected ? { ...selected } : null),
    /** Whether nothing is typed. */
    isEmpty: () => input.value.trim() === "",
    /**
     * Pre-fills a code. Without a label, the code shows until `reference.airports.get` (or the location search for a
     * city code) answers; a label that arrives after the traveller typed is dropped.
     * @param {string} code
     * @param {string} [labelText]
     */
    setValue(code, labelText) {
      cancelSearch();
      close();
      generation += 1;
      const ticket = generation;
      const upper = code.toUpperCase();
      select({ code: upper, label: labelText ?? upper });
      if (labelText === undefined) {
        void lookup(upper).then(
          (text) => {
            if (text && ticket === generation && selected?.code === upper && input.value === upper) {
              select({ code: upper, label: text });
            }
          },
          () => {},
        );
      }
    },
    clear() {
      cancelSearch();
      generation += 1;
      select(null);
      input.value = "";
      render([]);
      close();
    },
    /** @param {boolean} disabled */
    setDisabled(disabled) {
      input.disabled = disabled;
      hidden.disabled = disabled;
      if (disabled) {
        cancelSearch();
        close();
      }
    },
    focus: () => input.focus(),
    destroy() {
      cancelSearch();
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("blur", close);
      popup.remove();
    },
  };
}
