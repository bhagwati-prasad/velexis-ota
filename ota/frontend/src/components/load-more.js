// "Show more flights" on the results page (ota/frontend/docs/pages.md §4, README §9: results render 20 at a time).
// The `[data-load-more]` block of search.html holds a status line ("Showing 20 of 57") and the button; the page's
// `onLoad` fetches the next page with `page.next()` and appends it. While it runs, the button keeps its focus but is
// marked `aria-disabled` with a busy label, and a second press is ignored.

import { t } from "../lib/i18n.js";

/**
 * Mounts the load-more block. Returns `{ update, destroy }`; `update({ shown, total, hasMore })` shows the status and
 * the button (hidden when nothing is left).
 * @param {HTMLElement} root the `[data-load-more]` element
 * @param {{ onLoad: () => Promise<unknown> }} props
 */
export function mount(root, { onLoad }) {
  const button = /** @type {HTMLButtonElement} */ (root.querySelector('[data-action="load-more"]'));
  const status = root.querySelector("[data-load-more-status]");
  const idleLabel = t("results.loadMore");
  let busy = false;

  /** @param {boolean} value */
  const setBusy = (value) => {
    busy = value;
    button.textContent = value ? t("results.loadingMore") : idleLabel;
    if (value) {
      button.setAttribute("aria-disabled", "true");
    } else {
      button.removeAttribute("aria-disabled");
    }
  };

  const onClick = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onLoad();
    } finally {
      setBusy(false);
    }
  };
  button.textContent = idleLabel;
  button.addEventListener("click", onClick);

  return {
    /** @param {{ shown: number, total: number, hasMore: boolean }} props */
    update({ shown, total, hasMore }) {
      root.hidden = total === 0;
      button.hidden = !hasMore;
      if (status) {
        status.textContent = t("results.showing", { shown, total });
      }
    },
    destroy() {
      button.removeEventListener("click", onClick);
    },
  };
}
