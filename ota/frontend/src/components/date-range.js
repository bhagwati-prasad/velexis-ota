// Departure and return dates of the search form (ota/frontend/docs/pages.md §3, ota/frontend/README.md §8 Search
// row): native date inputs, so the browser brings its own accessible picker and the value is always `YYYY-MM-DD`.
//
// mount() keeps `min` up to date (departure from today, return from the departure), shows the return date only for
// return trips (hidden and disabled otherwise, so it is not sent), and `check()` reports a missing date, a date in the
// past and a return before the departure as field errors for lib/forms.js. A same-day return is a valid trip.
// "Today" is the traveller's local date.

/** @typedef {"oneway" | "return" | "multi"} Trip */
/** @typedef {{ path: string, code: string }} FieldError */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether `text` is a real calendar date written `YYYY-MM-DD`.
 * @param {unknown} text
 * @returns {text is string}
 */
export function isIsoDate(text) {
  const match = typeof text === "string" ? ISO_DATE.exec(text) : null;
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The local date of `now` as `YYYY-MM-DD` (the traveller's "today").
 * @param {Date} [now]
 */
export function todayIso(now = new Date()) {
  const pad = (/** @type {number} */ value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The field errors of one date: missing, not a date, before today, or before `order.after` (`order.afterCode`).
 * @param {string} value
 * @param {string} path
 * @param {string} today
 * @param {{ after?: string, afterCode?: string }} [order] a date this one may not precede, and the code if it does
 * @returns {FieldError[]}
 */
export function checkDate(value, path, today, { after, afterCode } = {}) {
  if (value === "") {
    return [{ path, code: "DATE_REQUIRED" }];
  }
  if (!isIsoDate(value)) {
    return [{ path, code: "format" }];
  }
  if (value < today) {
    return [{ path, code: "DATE_IN_PAST" }];
  }
  if (after !== undefined && afterCode !== undefined && isIsoDate(after) && value < after) {
    return [{ path, code: afterCode }];
  }
  return [];
}

/**
 * Mounts the date pair on its wrapper (`[data-date-range]` with `input[data-date="depart"]`, `input[data-date="return"]`
 * and the return's `[data-return-field]`). Returns `update({ trip })`, `set(dates)`, `values()`, `check()`.
 * @param {HTMLElement} root
 * @param {{ today?: string, trip?: Trip }} [props] `today` for tests (default: the local date)
 */
export function mount(root, { today = todayIso(), trip = "return" } = {}) {
  const depart = /** @type {HTMLInputElement} */ (root.querySelector('input[data-date="depart"]'));
  const ret = /** @type {HTMLInputElement} */ (root.querySelector('input[data-date="return"]'));
  const returnField = /** @type {HTMLElement} */ (root.querySelector("[data-return-field]") ?? ret);
  let current = trip;

  /** The return date may not be before the departure (or today). */
  const sync = () => {
    depart.min = today;
    ret.min = isIsoDate(depart.value) && depart.value > today ? depart.value : today;
  };

  /** @param {{ trip: Trip }} props */
  const update = ({ trip: next }) => {
    current = next;
    const returnTrip = next === "return";
    depart.disabled = next === "multi";
    depart.required = next !== "multi";
    ret.disabled = !returnTrip;
    ret.required = returnTrip;
    returnField.hidden = !returnTrip;
  };

  depart.addEventListener("input", sync);
  depart.addEventListener("change", sync);
  sync();
  update({ trip });

  return {
    update,
    /**
     * Sets the dates that are real `YYYY-MM-DD` dates (others are left empty).
     * @param {{ depart?: string | null, return?: string | null }} dates
     */
    set(dates) {
      if (dates.depart !== undefined) {
        depart.value = isIsoDate(dates.depart) ? dates.depart : "";
      }
      if (dates.return !== undefined) {
        ret.value = isIsoDate(dates.return) ? dates.return : "";
      }
      sync();
    },
    values: () => ({ depart: depart.value, return: ret.value }),
    /**
     * The field errors of the dates for the current trip (`/depart`, `/return`); none for multi-city.
     * @returns {FieldError[]}
     */
    check() {
      if (current === "multi") {
        return [];
      }
      const errors = checkDate(depart.value, "/depart", today);
      if (current === "return") {
        errors.push(
          ...checkDate(ret.value, "/return", today, {
            after: depart.value,
            afterCode: "RETURN_BEFORE_DEPARTURE",
          }),
        );
      }
      return errors;
    },
    destroy() {
      depart.removeEventListener("input", sync);
      depart.removeEventListener("change", sync);
    },
  };
}
