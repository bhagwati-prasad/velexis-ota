// Passengers of the search form (ota/frontend/docs/pages.md §3, ota/frontend/README.md §8 Search row): a disclosure
// with a labelled stepper per passenger type. The markup (partials/search-form.html) is a fieldset of three number
// inputs (`adults`, `children`, `infants`) that works without JavaScript; mount() adds the toggle button with the
// summary ("2 adults, 1 child"), collapses the panel (a pop-over on wider screens) and shows the − and + buttons.
// A click outside closes it, unless that click moved the focus into it (a link of the form's error summary).
//
// Rules (Amadeus Flight Offers Search): 1 to 9 adults, at most 9 seats (adults and children together), and infants
// travel on a lap, so never more infants than adults. The steppers stop at these bounds (`aria-disabled`, so a button
// keeps the focus at its end); the inputs' `min` and `max` follow them; `check()` reports typed values that break
// them as field errors for lib/forms.js.

import { t } from "../lib/i18n.js";

/** @typedef {"adults" | "children" | "infants"} PassengerType */
/** @typedef {Record<PassengerType, number>} Passengers */
/** @typedef {{ path: string, code: string }} FieldError */

/** Seats one search may ask for (adults and children; infants sit on a lap). */
export const MAX_SEATS = 9;
/** The passenger types in the order of the form. */
export const PASSENGER_TYPES = /** @type {const} */ (["adults", "children", "infants"]);
const WHOLE_NUMBER = /^\d{1,2}$/;
/** Classes that make the enhanced panel a pop-over under its toggle on wider screens (complete names for Tailwind). */
const FLOATING_PANEL_CLASSES = ["md:absolute", "md:z-20", "md:mt-2", "md:w-80", "md:shadow-lg"];

/**
 * A count as typed: a whole number, or `NaN` for anything else.
 * @param {string} text
 */
export const parseCount = (text) => (WHOLE_NUMBER.test(text.trim()) ? Number(text.trim()) : Number.NaN);

/**
 * The summary on the toggle button: "1 adult", "2 adults, 1 child, 1 infant".
 * @param {Passengers} passengers
 */
export function passengerSummary({ adults, children, infants }) {
  const parts = [t("passengers.adults", { count: Number.isInteger(adults) ? adults : 1 })];
  if (children > 0) {
    parts.push(t("passengers.children", { count: children }));
  }
  if (infants > 0) {
    parts.push(t("passengers.infants", { count: infants }));
  }
  return parts.join(t("passengers.separator"));
}

/**
 * The range of each type given the others: adults 1–9 and never fewer than the infants, at most 9 seats, at most one
 * infant per adult. Invalid counts of the other types count as their minimum.
 * @param {Passengers} passengers
 * @returns {Record<PassengerType, { min: number, max: number }>}
 */
export function passengerBounds({ adults, children, infants }) {
  const a = Number.isInteger(adults) && adults >= 1 ? Math.min(adults, MAX_SEATS) : 1;
  const c = Number.isInteger(children) && children >= 0 ? Math.min(children, MAX_SEATS - 1) : 0;
  const i = Number.isInteger(infants) && infants >= 0 ? Math.min(infants, MAX_SEATS) : 0;
  return {
    adults: { min: Math.max(1, i), max: Math.max(1, MAX_SEATS - c) },
    children: { min: 0, max: Math.max(0, MAX_SEATS - a) },
    infants: { min: 0, max: a },
  };
}

/**
 * The field errors of a passenger mix (paths `/adults`, `/children`, `/infants`, as in the search request).
 * @param {Passengers} passengers
 * @returns {FieldError[]}
 */
export function checkPassengers({ adults, children, infants }) {
  /** @type {FieldError[]} */
  const errors = [];
  const adultsOk = Number.isInteger(adults) && adults >= 1 && adults <= MAX_SEATS;
  const childrenOk = Number.isInteger(children) && children >= 0 && children <= MAX_SEATS - 1;
  const infantsOk = Number.isInteger(infants) && infants >= 0 && infants <= MAX_SEATS;
  if (!adultsOk) {
    errors.push({ path: "/adults", code: "ADULTS_RANGE" });
  }
  if (!childrenOk) {
    errors.push({ path: "/children", code: "CHILDREN_RANGE" });
  }
  if (!infantsOk) {
    errors.push({ path: "/infants", code: "INFANTS_RANGE" });
  }
  if (adultsOk && childrenOk && adults + children > MAX_SEATS) {
    errors.push({ path: "/children", code: "TOO_MANY_SEATS" });
  }
  if (adultsOk && infantsOk && infants > adults) {
    errors.push({ path: "/infants", code: "INFANTS_EXCEED_ADULTS" });
  }
  return errors;
}

/**
 * Mounts the picker on its wrapper (`[data-passenger-picker]`). Returns `values()`, `set(values)`, `check()`,
 * `open()`, `close()` and `destroy()`.
 * @param {HTMLElement} root
 * @param {{ announce?: (message: string) => void }} [props] `announce`: the page's polite live region (new counts)
 */
export function mount(root, { announce = () => {} } = {}) {
  const doc = root.ownerDocument;
  const toggle = /** @type {HTMLButtonElement} */ (root.querySelector("[data-passenger-toggle]"));
  const panel = /** @type {HTMLElement} */ (root.querySelector("[data-passenger-panel]"));
  const summary = root.querySelector("[data-passenger-summary]");
  const done = /** @type {HTMLButtonElement | null} */ (root.querySelector("[data-passenger-done]"));
  /** @type {Record<PassengerType, HTMLInputElement>} */
  const inputs = /** @type {Record<PassengerType, HTMLInputElement>} */ (
    Object.fromEntries(
      PASSENGER_TYPES.map((type) => [type, root.querySelector(`input[data-passengers="${type}"]`)]),
    )
  );

  /** @returns {Passengers} */
  const values = () => ({
    adults: parseCount(inputs.adults.value),
    children: parseCount(inputs.children.value),
    infants: parseCount(inputs.infants.value),
  });

  /**
   * The step buttons of one type.
   * @param {PassengerType} type
   * @returns {HTMLButtonElement[]}
   */
  const stepButtons = (type) => Array.from(root.querySelectorAll(`[data-stepper="${type}"] [data-step]`));

  /** Brings bounds, buttons and the summary up to date with the inputs. */
  const refresh = () => {
    const current = values();
    const bounds = passengerBounds(current);
    for (const type of PASSENGER_TYPES) {
      const input = inputs[type];
      input.min = String(bounds[type].min);
      input.max = String(bounds[type].max);
      const count = current[type];
      for (const button of stepButtons(type)) {
        const up = Number(button.dataset.step) > 0;
        const blocked = Number.isInteger(count)
          ? up
            ? count >= bounds[type].max
            : count <= bounds[type].min
          : false;
        button.setAttribute("aria-disabled", String(blocked));
      }
    }
    if (summary) {
      summary.textContent = passengerSummary(current);
    }
  };

  /**
   * One step up or down; nothing at a bound.
   * @param {PassengerType} type
   * @param {number} delta
   */
  const step = (type, delta) => {
    const current = values();
    const bounds = passengerBounds(current)[type];
    const count = Number.isInteger(current[type]) ? current[type] : bounds.min;
    const next = Math.min(bounds.max, Math.max(bounds.min, count + delta));
    if (next !== current[type]) {
      inputs[type].value = String(next);
      refresh();
      announce(t(`passengers.${type}`, { count: next }));
    }
  };

  const isOpen = () => toggle.getAttribute("aria-expanded") === "true";
  const open = () => {
    toggle.setAttribute("aria-expanded", "true");
    panel.hidden = false;
  };
  const close = () => {
    toggle.setAttribute("aria-expanded", "false");
    panel.hidden = true;
  };

  // Enhancement: the toggle and steppers appear, the panel collapses and, on wider screens, floats under the toggle
  // (without the toggle it stays in the flow of the form, so it never covers the page).
  panel.classList.add(...FLOATING_PANEL_CLASSES);
  toggle.hidden = false;
  toggle.setAttribute("aria-controls", panel.id);
  if (done) {
    done.hidden = false;
  }
  for (const type of PASSENGER_TYPES) {
    for (const button of stepButtons(type)) {
      button.hidden = false;
    }
  }
  close();
  refresh();

  const onToggle = () => (isOpen() ? close() : open());
  const onDone = () => {
    close();
    toggle.focus();
  };
  /** @param {Event} event */
  const onClick = (event) => {
    const target = /** @type {Element | null} */ (event.target);
    const button = target && typeof target.closest === "function" ? target.closest("[data-step]") : null;
    const stepper = button?.closest("[data-stepper]");
    if (button && stepper && button.getAttribute("aria-disabled") !== "true") {
      step(
        /** @type {PassengerType} */ (stepper.getAttribute("data-stepper")),
        Number(button.getAttribute("data-step")),
      );
    }
  };
  /** @param {KeyboardEvent} event */
  const onKeyDown = (event) => {
    if (event.key === "Escape" && isOpen()) {
      event.preventDefault();
      close();
      toggle.focus();
    }
  };
  /** @param {Event} event */
  const onDocumentClick = (event) => {
    const target = /** @type {Node | null} */ (event.target);
    // A click elsewhere closes the panel, unless it moved the focus into it (a link of the error summary).
    if (isOpen() && target && !root.contains(target) && !root.contains(doc.activeElement)) {
      close();
    }
  };

  toggle.addEventListener("click", onToggle);
  done?.addEventListener("click", onDone);
  panel.addEventListener("click", onClick);
  panel.addEventListener("input", refresh);
  root.addEventListener("keydown", onKeyDown);
  doc.addEventListener("click", onDocumentClick);

  return {
    values,
    /**
     * Sets the counts (missing types keep theirs).
     * @param {Partial<Passengers>} passengers
     */
    set(passengers) {
      for (const type of PASSENGER_TYPES) {
        const count = passengers[type];
        if (Number.isInteger(count)) {
          inputs[type].value = String(count);
        }
      }
      refresh();
    },
    check: () => checkPassengers(values()),
    open,
    close,
    destroy() {
      toggle.removeEventListener("click", onToggle);
      done?.removeEventListener("click", onDone);
      panel.removeEventListener("click", onClick);
      panel.removeEventListener("input", refresh);
      root.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("click", onDocumentClick);
    },
  };
}
