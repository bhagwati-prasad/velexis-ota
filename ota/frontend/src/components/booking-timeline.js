// The history of a booking on the booking page (ota/frontend/docs/pages-account.md §3 point 7): the customer-visible
// events of `bookings.listEvents` (booking.created, payment.captured, booking.ticketed, booking.contacts_updated,
// booking.cancelled, refund.requested, refund.succeeded …), newest first, each with its time in the OTA's time zone
// and the API's own localised `summary`. "Show earlier events" appends the next page (`page.next()`).
//
// The markup is the `[data-timeline]` section of booking.html: the list (`[data-timeline-list]`), the empty line
// (`[data-timeline-empty]`), the button (`button[data-timeline-more]`) and a state slot (`[data-timeline-state]`); each
// event is a clone of `tpl-timeline-event` filled with `fill()`, so API text only ever becomes text.

import { renderState } from "../boot.js";
import { clone, fill } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatTimestamp } from "../lib/format.js";
import { t } from "../lib/i18n.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["BookingEvent"]} BookingEvent */
/** @typedef {{ data: BookingEvent[], page: { nextCursor: string | null }, next: () => Promise<EventsPage | null> }} EventsPage */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontSupport"]} StorefrontSupport */

/**
 * Reports an error of the component without breaking the page.
 * @param {unknown} error
 */
function report(error) {
  try {
    globalThis.reportError?.(error);
  } catch {
    // Nothing else to do.
  }
}

/**
 * The fields of one event (`tpl-timeline-event`).
 * @param {BookingEvent} event
 * @param {{ locale?: string, timeZone?: string }} context
 */
export function timelineItem(event, { locale, timeZone }) {
  return {
    type: event.type,
    at: event.createdAt,
    time: formatTimestamp(event.createdAt, locale, timeZone),
    summary: typeof event.summary === "string" ? event.summary : "",
  };
}

/**
 * Mounts the timeline on its section. `show(page)` replaces the events with a first page; `fail(error, onRetry)` shows
 * why the events could not be loaded; `destroy()` removes the listeners.
 * @param {HTMLElement} root the `[data-timeline]` element
 * @param {{ locale?: string, timeZone?: string, support?: Partial<StorefrontSupport> | null, announce?: (text: string) => void }} props
 */
export function mount(root, { locale, timeZone, support = null, announce = () => {} }) {
  const doc = root.ownerDocument;
  const list = /** @type {HTMLElement} */ (root.querySelector("[data-timeline-list]"));
  const empty = /** @type {HTMLElement} */ (root.querySelector("[data-timeline-empty]"));
  const more = /** @type {HTMLButtonElement} */ (root.querySelector("button[data-timeline-more]"));
  const state = /** @type {HTMLElement} */ (root.querySelector("[data-timeline-state]"));
  /** @type {EventsPage | null} */
  let current = null;
  let busy = false;

  /**
   * Appends events; returns the first new item.
   * @param {ReadonlyArray<BookingEvent>} events
   */
  const append = (events) => {
    const items = events.map((event) =>
      fill(clone("tpl-timeline-event", doc), timelineItem(event, { locale, timeZone })),
    );
    list.append(...items);
    return items[0] ?? null;
  };

  const sync = () => {
    empty.hidden = list.childElementCount > 0;
    more.hidden = current === null || current.page.nextCursor === null;
  };

  const onMore = async () => {
    if (busy || current === null || current.page.nextCursor === null) {
      return;
    }
    busy = true;
    state.replaceChildren();
    more.setAttribute("aria-disabled", "true");
    more.textContent = t("timeline.loadingMore");
    try {
      const next = await current.next();
      if (next) {
        current = next;
        const first = append(next.data);
        if (first) {
          first.tabIndex = -1;
          first.focus();
        }
      } else if (current) {
        current = { ...current, page: { nextCursor: null } };
      }
      sync();
    } catch (error) {
      if (!isAborted(error)) {
        const failure = pageStateFor(error);
        renderState(state, { ...failure, message: t("timeline.failed") }, { support });
        announce(t("timeline.failed"));
      }
    } finally {
      busy = false;
      more.removeAttribute("aria-disabled");
      more.textContent = t("timeline.more");
    }
  };
  const onClick = () => {
    onMore().catch(report);
  };
  more.textContent = t("timeline.more");
  more.addEventListener("click", onClick);

  return {
    /**
     * Shows a first page of events.
     * @param {EventsPage} page
     */
    show(page) {
      current = page;
      state.replaceChildren();
      list.replaceChildren();
      append(page.data);
      sync();
    },
    /**
     * Shows that the events could not be loaded, with Retry when given.
     * @param {unknown} error
     * @param {() => void} [onRetry]
     */
    fail(error, onRetry) {
      current = null;
      list.replaceChildren();
      empty.hidden = true;
      more.hidden = true;
      const failure = pageStateFor(error);
      renderState(
        state,
        { ...failure, message: t("timeline.failed") },
        { support, ...(onRetry ? { onRetry } : {}) },
      );
    },
    destroy() {
      more.removeEventListener("click", onClick);
    },
  };
}
