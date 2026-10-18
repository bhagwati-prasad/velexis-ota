// Forms of the storefront (ota/frontend/README.md §5.2, §8, conventions §4): native elements and validation
// attributes first, then this module for what the API says.
//
// - serialize(form): the form's successful controls as a plain object (repeated names become arrays). Controls
//   without a `name` are never included: the airline-card inputs have none (OADR-0017).
// - showFieldErrors(form, fieldErrors): maps the API's `fieldErrors` (JSON pointers into the request, `/<in>/<name>`
//   for parameters) onto controls: `aria-invalid="true"`, a message element linked by `aria-describedby`, and an
//   error summary at the top of the form that receives focus and links to each field (WCAG 3.3.1, 3.3.3).
//   A control matches a pointer through `data-error-path` (one or more pointers separated by spaces), else by its
//   `name`: the pointer's segments joined with dots (`/travelers/0/firstName` → `travelers.0.firstName`), or the
//   parameter name for `/path/…`, `/query/…`, `/header/…` and `/cookie/…`. Errors without a visible control appear
//   in the summary only. Messages come from lib/i18n.js by code, never from the rejected value. clearFieldErrors(form)
//   removes exactly what showFieldErrors added, and nothing the page marked itself.
// - setSubmitting / withSubmitState: the busy state of a submit (no double submits, `aria-busy`, busy label).
//
// Everything is built with createElement and textContent.

import { fieldErrorMessage, t } from "./i18n.js";

const PARAMETER_LOCATIONS = new Set(["path", "query", "header", "cookie"]);
const CONTROL_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
const ERROR_ATTRIBUTE = "data-field-error";
const SUMMARY_ATTRIBUTE = "data-error-summary";
const CREATED_SUMMARY_ATTRIBUTE = "data-error-summary-created";

/** @typedef {{ path: string, code: string, message?: string }} FieldError */
/** @typedef {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} Control */

let generatedIds = 0;

/**
 * What `showFieldErrors` added to each form (its messages and the controls each one describes), so that
 * `clearFieldErrors` removes exactly that.
 * @type {WeakMap<HTMLFormElement, Array<{ message: Element, controls: Control[] }>>}
 */
const shownErrors = new WeakMap();

/**
 * The element's id, after giving it one when it has none.
 * @param {Element} element
 * @param {string} prefix
 */
function idOf(element, prefix) {
  if (!element.id) {
    generatedIds += 1;
    element.id = `${prefix}-${generatedIds}`;
  }
  return element.id;
}

/**
 * The form's successful controls as a plain object: one string per name, an array for a repeated name (checkbox
 * groups). File inputs are left out. `submitter` adds the clicked button's name and value, as a native submit would.
 * @param {HTMLFormElement} form
 * @param {HTMLElement | null} [submitter]
 * @returns {Record<string, string | string[]>}
 */
export function serialize(form, submitter) {
  /** @type {Map<string, string | string[]>} */
  const values = new Map();
  const data = submitter ? new FormData(form, submitter) : new FormData(form);
  for (const [name, value] of data) {
    if (typeof value !== "string") {
      continue;
    }
    const existing = values.get(name);
    if (existing === undefined) {
      values.set(name, value);
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      values.set(name, [existing, value]);
    }
  }
  // Object.fromEntries defines own properties, so a control named "__proto__" cannot reach the prototype.
  return Object.fromEntries(values);
}

/**
 * The decoded segments of a JSON pointer (RFC 6901: `~1` is `/`, `~0` is `~`).
 * @param {string} pointer
 * @returns {string[]}
 */
export function pointerSegments(pointer) {
  if (!pointer.startsWith("/")) {
    return pointer === "" ? [] : [pointer];
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * The control names a pointer may refer to: the segments joined with dots, and for a parameter pointer
 * (`/query/departureDate`, `/query/include/1`) the parameter's name.
 * @param {string} pointer
 * @returns {string[]}
 */
export function fieldNamesFor(pointer) {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    return [];
  }
  const names = [segments.join(".")];
  const [location, parameter] = segments;
  if (location !== undefined && parameter !== undefined && PARAMETER_LOCATIONS.has(location)) {
    names.push(parameter);
  }
  return names;
}

/**
 * The visible controls of the form (hidden inputs cannot show an error).
 * @param {HTMLFormElement} form
 * @returns {Control[]}
 */
function visibleControls(form) {
  return /** @type {Control[]} */ (
    Array.from(form.elements).filter(
      (element) =>
        CONTROL_TAGS.has(element.tagName) && /** @type {HTMLInputElement} */ (element).type !== "hidden",
    )
  );
}

/**
 * The controls a field error belongs to: those naming its pointer in `data-error-path`, else those whose name
 * matches it (all radios of a group).
 * @param {HTMLFormElement} form
 * @param {string} pointer
 * @returns {Control[]}
 */
function controlsFor(form, pointer) {
  const controls = visibleControls(form);
  const byPath = controls.filter((control) =>
    (control.getAttribute("data-error-path") ?? "").split(/\s+/).includes(pointer),
  );
  if (byPath.length > 0) {
    return byPath;
  }
  for (const name of fieldNamesFor(pointer)) {
    const byName = controls.filter((control) => control.name === name);
    if (byName.length > 0) {
      return byName;
    }
  }
  return [];
}

/**
 * Adds or removes one id in an element's `aria-describedby`, keeping the others (hints) in order.
 * @param {Element} element
 * @param {string} id
 * @param {boolean} present
 */
function toggleDescribedBy(element, id, present) {
  const ids = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((token) => token !== "");
  const next = present ? [...ids.filter((token) => token !== id), id] : ids.filter((token) => token !== id);
  if (next.length === 0) {
    element.removeAttribute("aria-describedby");
  } else {
    element.setAttribute("aria-describedby", next.join(" "));
  }
}

/**
 * `base`, or `base` with a number appended when an element of the page already has that id.
 * @param {string} base
 */
function unusedId(base) {
  let id = base;
  while (document.getElementById(id)) {
    generatedIds += 1;
    id = `${base}-${generatedIds}`;
  }
  return id;
}

/**
 * Marks a group of controls invalid and puts the message after them: after the label that wraps the control (so the
 * message is not part of its accessible name, nor between a checkbox and its text), or at the end of their common
 * fieldset for a radio or checkbox group. Returns the message element.
 * @param {Control[]} controls
 * @param {string} message
 */
function markInvalid(controls, message) {
  const [first] = /** @type {[Control, ...Control[]]} */ (controls);
  const last = /** @type {Control} */ (controls[controls.length - 1]);
  const messageElement = document.createElement("p");
  messageElement.id = unusedId(`${idOf(first, "vx-field")}-error`);
  messageElement.setAttribute(ERROR_ATTRIBUTE, "");
  messageElement.className = "mt-1 text-sm font-medium text-error";
  messageElement.textContent = message;
  const fieldset = controls.length > 1 ? first.closest("fieldset") : null;
  if (fieldset && controls.every((control) => control.closest("fieldset") === fieldset)) {
    fieldset.append(messageElement);
  } else {
    (last.closest("label") ?? last).after(messageElement);
  }
  for (const control of controls) {
    control.setAttribute("aria-invalid", "true");
    toggleDescribedBy(control, messageElement.id, true);
  }
  return messageElement;
}

/**
 * The form's error summary: an element with `data-error-summary` inside the form, else a new one at its top.
 * @param {HTMLFormElement} form
 * @returns {HTMLElement}
 */
function summaryOf(form) {
  const existing = form.querySelector(`[${SUMMARY_ATTRIBUTE}]`);
  if (existing instanceof HTMLElement) {
    return existing;
  }
  const summary = document.createElement("div");
  summary.setAttribute(SUMMARY_ATTRIBUTE, "");
  summary.setAttribute(CREATED_SUMMARY_ATTRIBUTE, "");
  summary.className = "mb-6 rounded-ui border-2 border-error bg-panel p-4";
  form.prepend(summary);
  return summary;
}

/**
 * Fills the summary: a heading with the number of problems and one entry per problem, a link to its field when
 * there is one (activating it focuses the field).
 * @param {HTMLElement} summary
 * @param {Array<{ message: string, control: Control | null }>} problems
 */
function fillSummary(summary, problems) {
  const heading = document.createElement("h2");
  heading.id = `${idOf(summary, "vx-error-summary")}-title`;
  heading.className = "font-heading text-lg font-semibold text-error";
  heading.textContent = t("form.errorSummary.title", { count: problems.length });
  const list = document.createElement("ul");
  list.className = "mt-2 list-disc pl-5";
  for (const { message, control } of problems) {
    const item = document.createElement("li");
    if (control) {
      const link = document.createElement("a");
      link.href = `#${control.id}`;
      link.className = "underline";
      link.textContent = message;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        control.focus();
      });
      item.append(link);
    } else {
      item.textContent = message;
    }
    list.append(item);
  }
  summary.replaceChildren(heading, list);
  summary.setAttribute("aria-labelledby", heading.id);
  summary.tabIndex = -1;
  summary.hidden = false;
}

/**
 * Removes what `showFieldErrors` added, and only that: its messages, `aria-invalid` on the controls it marked (those
 * outside the form element with `form="…"` included) and the messages' ids in `aria-describedby`, and the summary (a
 * summary of the page's own markup is emptied and hidden). Marks and hints the page set itself stay.
 * @param {HTMLFormElement} form
 */
export function clearFieldErrors(form) {
  for (const { message, controls } of shownErrors.get(form) ?? []) {
    for (const control of controls) {
      control.removeAttribute("aria-invalid");
      toggleDescribedBy(control, message.id, false);
    }
    message.remove();
  }
  shownErrors.delete(form);
  const summary = form.querySelector(`[${SUMMARY_ATTRIBUTE}]`);
  if (summary instanceof HTMLElement) {
    if (summary.hasAttribute(CREATED_SUMMARY_ATTRIBUTE)) {
      summary.remove();
    } else {
      summary.replaceChildren();
      summary.hidden = true;
    }
  }
}

/**
 * Shows the API's field errors on the form (see the header of this file) after clearing earlier ones, and moves focus
 * to the error summary. One message per field: the first error of a field wins. Returns the summary, or `null` when
 * there was nothing to show.
 * @param {HTMLFormElement} form
 * @param {ReadonlyArray<FieldError>} fieldErrors `VelexisError.fieldErrors`
 * @param {{ focus?: boolean }} [options] `focus: false` leaves the focus where it is
 * @returns {HTMLElement | null}
 */
export function showFieldErrors(form, fieldErrors, { focus = true } = {}) {
  clearFieldErrors(form);
  /** @type {Array<{ message: string, control: Control | null }>} */
  const problems = [];
  /** @type {Array<{ message: Element, controls: Control[] }>} */
  const added = [];
  /** @type {Set<Control>} */
  const marked = new Set();
  const unmatched = new Set();
  for (const fieldError of fieldErrors) {
    const message = fieldErrorMessage(fieldError);
    const controls = controlsFor(form, String(fieldError.path));
    if (controls.length === 0) {
      if (!unmatched.has(message)) {
        unmatched.add(message);
        problems.push({ message, control: null });
      }
    } else if (!controls.some((control) => marked.has(control))) {
      controls.forEach((control) => marked.add(control));
      added.push({ message: markInvalid(controls, message), controls });
      // The summary links to the first control of the group.
      problems.push({ message, control: /** @type {Control} */ (controls[0]) });
    }
  }
  shownErrors.set(form, added);
  if (problems.length === 0) {
    return null;
  }
  const summary = summaryOf(form);
  fillSummary(summary, problems);
  if (focus) {
    summary.focus();
  }
  return summary;
}

/**
 * The form's submit buttons, those outside it with `form="<id>"` included.
 * @param {HTMLFormElement} form
 * @returns {Array<HTMLButtonElement | HTMLInputElement>}
 */
function submitButtons(form) {
  return /** @type {Array<HTMLButtonElement | HTMLInputElement>} */ (
    Array.from(form.elements).filter(
      (element) =>
        (element.tagName === "BUTTON" || element.tagName === "INPUT") &&
        /** @type {HTMLButtonElement | HTMLInputElement} */ (element).type === "submit",
    )
  );
}

/**
 * Whether the form is being submitted (between `setSubmitting(form, true)` and `setSubmitting(form, false)`).
 * @param {HTMLFormElement} form
 */
export const isSubmitting = (form) => form.hasAttribute("data-submitting");

/**
 * Puts the form in or out of its busy state: `aria-busy` on the form, `aria-disabled` on its submit buttons (they keep
 * focus, unlike `disabled`), and, on a button with a `data-busy-label` attribute, that label as its text while busy
 * (an empty attribute gives "Please wait…"). Buttons without the attribute keep their text.
 * @param {HTMLFormElement} form
 * @param {boolean} busy
 */
export function setSubmitting(form, busy) {
  form.toggleAttribute("data-submitting", busy);
  if (busy) {
    form.setAttribute("aria-busy", "true");
  } else {
    form.removeAttribute("aria-busy");
  }
  for (const button of submitButtons(form)) {
    const isInput = button.tagName === "INPUT";
    const busyLabel = button.hasAttribute("data-busy-label")
      ? button.getAttribute("data-busy-label") || t("app.submitting")
      : null;
    if (busy) {
      button.setAttribute("aria-disabled", "true");
      if (busyLabel !== null && !button.hasAttribute("data-idle-label")) {
        button.setAttribute("data-idle-label", isInput ? button.value : (button.textContent ?? ""));
        if (isInput) {
          button.value = busyLabel;
        } else {
          button.textContent = busyLabel;
        }
      }
    } else {
      button.removeAttribute("aria-disabled");
      const idleLabel = button.getAttribute("data-idle-label");
      if (idleLabel !== null) {
        if (isInput) {
          button.value = idleLabel;
        } else {
          button.textContent = idleLabel;
        }
        button.removeAttribute("data-idle-label");
      }
    }
  }
}

/**
 * Runs `task` with the form in its busy state and restores the form afterwards, also when `task` throws. A second
 * submit while the first runs does nothing and resolves with `undefined` (no double booking or double payment).
 * @template T
 * @param {HTMLFormElement} form
 * @param {() => Promise<T> | T} task
 * @returns {Promise<T | undefined>}
 */
export async function withSubmitState(form, task) {
  if (isSubmitting(form)) {
    return undefined;
  }
  setSubmitting(form, true);
  try {
    return await task();
  } finally {
    setSubmitting(form, false);
  }
}
