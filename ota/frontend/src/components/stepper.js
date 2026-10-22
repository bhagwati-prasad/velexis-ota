// The stepper of the checkout page (ota/frontend/docs/pages.md §7, README §8): the steps of `checkout.html` in order
// (`travellers`, `contacts`, `extras` when the OTA sells extras, `payment`), which of them are done according to
// `checkout.progress`, and which one is shown. A step the traveller may open is a real link to its address
// (`/checkout.html?id=chk_…&step=…`), so it works with the keyboard and the browser's own link handling; the page
// intercepts the click and moves to the step with a history entry. The current step carries `aria-current="step"`, and
// every step says its status in words (never by colour alone, WCAG 1.4.1).
//
// The rules are pure functions, shared with the page: a step can be opened once every step before it is complete
// (`travelersComplete` for contacts; travellers and contacts for extras and payment). Extras are optional, so they
// count as done as soon as they can be opened. The payment step is never done on this page: paying happens on the
// payment pages.

import { clone, fill } from "../lib/dom.js";
import { t } from "../lib/i18n.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["CheckoutProgress"]} CheckoutProgress */
/** @typedef {"travellers" | "contacts" | "extras" | "payment"} CheckoutStep */
/** @typedef {"done" | "current" | "open" | "locked"} StepStatus */

/** Every step of the checkout page, in order. */
export const CHECKOUT_STEPS = /** @type {const} */ (["travellers", "contacts", "extras", "payment"]);

/**
 * Whether a text is one of the checkout's steps.
 * @param {unknown} value
 * @returns {value is CheckoutStep}
 */
export const isStep = (value) => CHECKOUT_STEPS.some((step) => step === value);

/**
 * The steps of this storefront: extras only when it sells them (`features.ancillaries`).
 * @param {{ ancillaries?: boolean } | null | undefined} features
 * @returns {CheckoutStep[]}
 */
export function checkoutSteps(features) {
  return CHECKOUT_STEPS.filter((step) => step !== "extras" || features?.ancillaries === true);
}

/**
 * Whether a step is complete: travellers and contacts from `progress`; extras once the data before them is complete
 * (they are optional); the payment step never on this page.
 * @param {CheckoutStep} step
 * @param {Partial<CheckoutProgress> | null | undefined} progress
 */
export function isComplete(step, progress) {
  switch (step) {
    case "travellers":
      return progress?.travelersComplete === true;
    case "contacts":
      return progress?.contactsComplete === true;
    case "extras":
      return progress?.travelersComplete === true && progress?.contactsComplete === true;
    default:
      return false;
  }
}

/**
 * The first step of `steps` that still needs data (travellers, then contacts), or `null` when the data is complete.
 * @param {ReadonlyArray<CheckoutStep>} steps
 * @param {Partial<CheckoutProgress> | null | undefined} progress
 * @returns {CheckoutStep | null}
 */
export function firstIncompleteStep(steps, progress) {
  return (
    steps.find((step) => (step === "travellers" || step === "contacts") && !isComplete(step, progress)) ??
    null
  );
}

/**
 * Whether a step can be opened: every step before it is complete.
 * @param {CheckoutStep} step
 * @param {ReadonlyArray<CheckoutStep>} steps
 * @param {Partial<CheckoutProgress> | null | undefined} progress
 */
export function isReachable(step, steps, progress) {
  const index = steps.indexOf(step);
  return index >= 0 && steps.slice(0, index).every((before) => isComplete(before, progress));
}

/**
 * The step to show for a requested one: the request when it can be opened, else the first step that still needs data
 * (or the first step).
 * @param {unknown} requested the `step` of the address
 * @param {ReadonlyArray<CheckoutStep>} steps
 * @param {Partial<CheckoutProgress> | null | undefined} progress
 * @returns {CheckoutStep}
 */
export function stepToShow(requested, steps, progress) {
  if (isStep(requested) && isReachable(requested, steps, progress)) {
    return requested;
  }
  return firstIncompleteStep(steps, progress) ?? /** @type {CheckoutStep} */ (steps[0]);
}

/**
 * The status of each step for the stepper.
 * @param {ReadonlyArray<CheckoutStep>} steps
 * @param {CheckoutStep} current
 * @param {Partial<CheckoutProgress> | null | undefined} progress
 * @returns {Array<{ step: CheckoutStep, status: StepStatus }>}
 */
export function stepStatuses(steps, current, progress) {
  return steps.map((step) => ({
    step,
    status:
      step === current
        ? "current"
        : !isReachable(step, steps, progress)
          ? "locked"
          : isComplete(step, progress)
            ? "done"
            : "open",
  }));
}

/**
 * Mounts the stepper on its list (`<ol>` inside a `<nav>`), with items cloned from `tpl-step`: `update` renders the
 * steps, `onSelect(step)` runs when the traveller follows the link of a step (the default navigation is prevented).
 * @param {HTMLElement} list
 * @param {{ hrefFor: (step: CheckoutStep) => string, onSelect: (step: CheckoutStep) => void }} props
 */
export function mount(list, { hrefFor, onSelect }) {
  const doc = list.ownerDocument;
  /** @param {Event} event */
  const onClick = (event) => {
    const origin = /** @type {Element | null} */ (event.target);
    const link = origin?.closest?.("a[data-step-link]");
    const step = link?.getAttribute("data-step-link");
    const mouse = /** @type {MouseEvent} */ (event);
    // A click that opens a new tab or window keeps the browser's own behaviour.
    if (!link || !isStep(step) || mouse.ctrlKey || mouse.metaKey || mouse.shiftKey || mouse.altKey) {
      return;
    }
    event.preventDefault();
    onSelect(step);
  };
  list.addEventListener("click", onClick);
  return {
    /**
     * @param {{ steps: ReadonlyArray<CheckoutStep>, current: CheckoutStep, progress: Partial<CheckoutProgress> | null | undefined }} state
     */
    update({ steps, current, progress }) {
      list.replaceChildren(
        ...stepStatuses(steps, current, progress).map(({ step, status }, index) => {
          const item = fill(clone("tpl-step", doc), {
            status,
            label: t("checkout.stepLabel", { number: index + 1, name: t(`checkout.step.${step}`) }),
            // An open step says nothing more: its link is the status.
            statusText: status === "open" ? null : t(`checkout.stepStatus.${status}`),
          });
          const link = /** @type {HTMLAnchorElement | null} */ (item.querySelector("a[data-step-link]"));
          const text = /** @type {HTMLElement | null} */ (item.querySelector("[data-step-text]"));
          if (link && text) {
            // A locked step is text; the others are links to their address.
            if (status === "locked") {
              link.remove();
            } else {
              text.remove();
              link.href = hrefFor(step);
              link.setAttribute("data-step-link", step);
              if (status === "current") {
                link.setAttribute("aria-current", "step");
              }
            }
          }
          return item;
        }),
      );
    },
    destroy() {
      list.removeEventListener("click", onClick);
      list.replaceChildren();
    },
  };
}
