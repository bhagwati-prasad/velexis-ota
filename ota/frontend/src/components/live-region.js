// The polite live region of every page (ota/frontend/README.md §8, Dynamic content; ota/frontend/docs/pages.md §2):
// screen readers announce "Loading", result counts, price changes and payment progress from it without moving focus.
//
// The region is the `[data-live-region]` element of partials/states.html (`role="status"`, `aria-live="polite"`,
// visually hidden); a page without the partial gets one appended. Every mount on a page shares that element. A message
// is written shortly after the region is emptied, so the same text announced twice is read twice, and a message
// cleared within that delay (a configuration that came from the cache at once) is never read at all.

/** How long the region stays empty before a message is written, in ms. */
const ANNOUNCE_DELAY_MS = 150;

/**
 * Mounts the live region inside `root` (default: the page's body): the existing `[data-live-region]` element, or a new
 * visually hidden `role="status"` element. `announce(message)` replaces what the region says, `clear()` empties it,
 * and `destroy()` clears it and removes an element that this mount created.
 * @param {ParentNode & Node} [root]
 * @returns {{ element: HTMLElement, announce: (message: string) => void, clear: () => void, destroy: () => void }}
 */
export function mount(root = document.body) {
  const doc = root.ownerDocument ?? /** @type {Document} */ (root);
  let element = /** @type {HTMLElement | null} */ (root.querySelector("[data-live-region]"));
  const created = !element;
  if (!element) {
    element = doc.createElement("div");
    element.dataset.liveRegion = "";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.setAttribute("aria-atomic", "true");
    element.className = "sr-only";
    root.append(element);
  }
  const region = element;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    region.textContent = "";
  };
  return {
    element: region,
    announce(message) {
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        region.textContent = message;
      }, ANNOUNCE_DELAY_MS);
    },
    clear,
    destroy() {
      clear();
      if (created) {
        region.remove();
      }
    },
  };
}
