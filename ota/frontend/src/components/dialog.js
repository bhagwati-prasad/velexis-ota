// A modal dialog on the native `<dialog>` element (ota/frontend/README.md §5.2 "Dialogs", §8): `showModal()` makes the
// rest of the page inert, traps the focus and closes on Escape, so the component adds only what the element leaves to
// the page:
//
// - `open()` remembers the element that had the focus and moves it to the dialog's `[autofocus]` control, else to its
//   first control; closing gives the focus back to that element (when it is still on the page).
// - Every `[data-dialog-close]` button inside closes it.
// - `setBusy(true)` while a request runs: Escape (the `cancel` event) and the close buttons do nothing, so a dialog is
//   not closed under a request that is still deciding (an account deletion, a cancellation). A browser may still close
//   a modal dialog on a repeated Escape (the close watcher's rule: without a user activation in between, its `cancel`
//   event cannot be cancelled), so a page asks `isOpen()` when the request ends and opens it again to show a failure.
// - `onClose(returnValue)` is called once per close, whichever way it closed (a button, Escape, `close()`).
//
// The markup stays in the page's HTML (labelled by its heading with `aria-labelledby`); this module never writes HTML.

/**
 * @typedef {object} DialogProps
 * @property {(returnValue: string) => void} [onClose] called after the dialog closed
 */

/**
 * @typedef {object} DialogView
 * @property {(opener?: Element | null) => void} open shows the dialog as a modal; `opener` gets the focus back afterwards
 *   (default: the element that has the focus now)
 * @property {(returnValue?: string) => void} close closes the dialog (also while busy)
 * @property {(busy: boolean) => void} setBusy while busy, Escape and the close buttons do nothing
 * @property {() => boolean} isOpen whether the dialog is shown
 * @property {() => void} destroy removes the listeners (the dialog stays in the page)
 */

const FOCUSABLE = [
  "input:not([type='hidden']):not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * Mounts the dialog behaviour on a `<dialog>` element (see the top of this file).
 * @param {HTMLDialogElement} dialog
 * @param {DialogProps} [props]
 * @returns {DialogView}
 */
export function mount(dialog, props = {}) {
  const doc = dialog.ownerDocument;
  let busy = false;
  /** @type {HTMLElement | null} */
  let opener = null;

  /** @param {Event} event */
  const onCancel = (event) => {
    // Escape: the browser closes the dialog after this event unless it is cancelled.
    if (busy) {
      event.preventDefault();
    }
  };
  const onCloseEvent = () => {
    const back = opener;
    opener = null;
    if (back?.isConnected && typeof back.focus === "function") {
      back.focus();
    }
    props.onClose?.(dialog.returnValue);
  };
  /** @param {Event} event */
  const onClick = (event) => {
    const target = /** @type {Element | null} */ (event.target);
    const button = target?.closest?.("[data-dialog-close]");
    if (!button || !dialog.contains(button)) {
      return;
    }
    event.preventDefault();
    if (!busy) {
      close();
    }
  };

  /** @param {string} [returnValue] */
  function close(returnValue) {
    if (!dialog.open) {
      return;
    }
    if (typeof dialog.close === "function") {
      dialog.close(returnValue);
    } else {
      // An element without the dialog API (an old browser): hide it and run the close steps by hand.
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new (doc.defaultView ?? globalThis).Event("close"));
    }
  }

  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("close", onCloseEvent);
  dialog.addEventListener("click", onClick);

  return {
    open(from) {
      if (dialog.open) {
        return;
      }
      const active = from === undefined ? doc.activeElement : from;
      opener = active instanceof (doc.defaultView ?? globalThis).HTMLElement ? active : null;
      dialog.returnValue = "";
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
      const first =
        /** @type {HTMLElement | null} */ (dialog.querySelector("[autofocus]")) ??
        /** @type {HTMLElement | null} */ (dialog.querySelector(FOCUSABLE));
      first?.focus();
    },
    close,
    setBusy(next) {
      busy = next;
      if (next) {
        dialog.setAttribute("aria-busy", "true");
      } else {
        dialog.removeAttribute("aria-busy");
      }
    },
    isOpen: () => dialog.open,
    destroy() {
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onCloseEvent);
      dialog.removeEventListener("click", onClick);
    },
  };
}
