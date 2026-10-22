// The error summary of a checkout step (ota/frontend/docs/pages.md §7, README §8 Forms, WCAG 3.3.1): the API's
// `fieldErrors` marked on the step's form by lib/forms.js (`aria-invalid`, a message linked by `aria-describedby`, the
// summary that receives focus and links to each field), or one message for a problem that belongs to no field.
//
// The checkout's errors come from two places, both as JSON pointers:
// - a `set*` call answers `422 TRAVELER_DATA_INVALID` / `CONTACT_DATA_INVALID` (or `400 VALIDATION_FAILED`) with
//   pointers into its request (`/travelers/0/name/firstName`, `/contacts/0/phones`);
// - `422 CHECKOUT_INCOMPLETE` of `checkout.createPayment` and `checkout.progress.missing` point into the checkout
//   (`/travelers/1/documents`), whose travellers are in the order of `checkout.travelers`.
// The forms send the travellers in the order of `checkout.requirements.travelers`, so `remapTravellerPointers` turns
// a checkout pointer into a form pointer through the travellers' `travelerId`. `stepOfPointer` says which step holds
// the field, so the page can jump to the first step with a problem.

import { clearFieldErrors, pointerSegments, showFieldErrors } from "../lib/forms.js";
import { t } from "../lib/i18n.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["FieldError"]} FieldError */
/** @typedef {import("./stepper.js").CheckoutStep} CheckoutStep */

/** The first segment of a pointer and the step that holds its fields. */
const STEP_BY_SEGMENT = /** @type {Readonly<Record<string, CheckoutStep>>} */ ({
  travelers: "travellers",
  contacts: "contacts",
  selections: "extras",
  remarks: "extras",
});

/**
 * The checkout step whose form holds the field of a pointer, or `null` (a pointer to no step's data).
 * @param {string} pointer
 * @returns {CheckoutStep | null}
 */
export function stepOfPointer(pointer) {
  const [first] = pointerSegments(String(pointer));
  return first !== undefined && Object.hasOwn(STEP_BY_SEGMENT, first)
    ? /** @type {CheckoutStep} */ (STEP_BY_SEGMENT[first])
    : null;
}

/**
 * The field errors of one step.
 * @param {ReadonlyArray<FieldError> | null | undefined} fieldErrors
 * @param {CheckoutStep} step
 * @returns {FieldError[]}
 */
export function errorsOfStep(fieldErrors, step) {
  return (fieldErrors ?? []).filter((error) => stepOfPointer(error.path) === step);
}

/**
 * The first of `steps` with a field error, or `null`.
 * @param {ReadonlyArray<FieldError> | null | undefined} fieldErrors
 * @param {ReadonlyArray<CheckoutStep>} steps
 * @returns {CheckoutStep | null}
 */
export function firstStepWithErrors(fieldErrors, steps) {
  return steps.find((step) => errorsOfStep(fieldErrors, step).length > 0) ?? null;
}

/**
 * Pointers into the checkout's travellers (`/travelers/<i>/…`, `i` in the order of `fromIds`) as pointers into the
 * form (`i` in the order of `toIds`), matched by `travelerId`. Other pointers stay as they are.
 * @param {ReadonlyArray<FieldError> | null | undefined} fieldErrors
 * @param {ReadonlyArray<string>} fromIds the `travelerId`s in the order of the pointers (`checkout.travelers`)
 * @param {ReadonlyArray<string>} toIds the `travelerId`s in the order of the form (`requirements.travelers`)
 * @returns {FieldError[]}
 */
export function remapTravellerPointers(fieldErrors, fromIds, toIds) {
  return (fieldErrors ?? []).map((error) => {
    const match = /^\/travelers\/(\d+)(?=\/|$)/.exec(String(error.path));
    if (!match) {
      return error;
    }
    const id = fromIds[Number(match[1])];
    const position = id === undefined ? -1 : toIds.indexOf(id);
    return position < 0
      ? error
      : { ...error, path: `/travelers/${position}${String(error.path).slice(match[0].length)}` };
  });
}

/**
 * Mounts the summary of a step's form (its `[data-error-summary]` element, else one lib/forms.js creates).
 * @param {HTMLFormElement} form
 */
export function mount(form) {
  const doc = form.ownerDocument;
  return {
    /**
     * Marks the fields of `fieldErrors` and fills and focuses the summary. Returns the summary, or `null` when there
     * was nothing to show.
     * @param {ReadonlyArray<FieldError>} fieldErrors
     * @param {{ focus?: boolean }} [options]
     */
    show(fieldErrors, { focus = true } = {}) {
      return showFieldErrors(form, fieldErrors, { focus });
    },
    /**
     * Shows one message without fields in the summary (after clearing the field errors) and focuses it.
     * @param {string} text
     * @param {{ focus?: boolean }} [options]
     */
    message(text, { focus = true } = {}) {
      clearFieldErrors(form);
      let summary = /** @type {HTMLElement | null} */ (form.querySelector("[data-error-summary]"));
      if (!summary) {
        summary = doc.createElement("div");
        summary.setAttribute("data-error-summary", "");
        summary.className = "mb-6 rounded-ui border-2 border-error bg-panel p-4";
        form.prepend(summary);
      }
      const heading = doc.createElement("h2");
      heading.id = `${form.id || "checkout-form"}-error-title`;
      heading.className = "font-heading text-lg font-semibold text-error";
      heading.textContent = t("form.errorSummary.title", { count: 1 });
      const body = doc.createElement("p");
      body.className = "mt-2";
      body.textContent = text;
      summary.replaceChildren(heading, body);
      summary.setAttribute("aria-labelledby", heading.id);
      summary.tabIndex = -1;
      summary.hidden = false;
      if (focus) {
        summary.focus();
      }
      return summary;
    },
    /** Removes what `show` or `message` added. */
    clear() {
      clearFieldErrors(form);
    },
  };
}
