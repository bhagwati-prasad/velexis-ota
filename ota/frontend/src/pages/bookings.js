// Entry module of My bookings (bookings.html, ota/frontend/docs/pages-account.md §1–§2, flow
// ota/docs/flows/my-bookings-and-guest-lookup.md §3 step 4, SDK guide B3 §3). `/bookings.html?tab=upcoming|past|cancelled`
// lists the signed-in customer's trips of one tab; the tabs are links, so each tab has its own address, history entry
// and reload.
//
// 1. Who: a signed-in customer (boot's `auth.getSession`). Anybody else is sent on with `location.replace`: to sign-in
//    with `next` back to this tab, or, when the OTA has no customer accounts, to the guest lookup (pages-account.md §1;
//    the guest cookie is httpOnly, so the page cannot tell a guest from a visitor).
// 2. `bookings.list({ timeframe: tab, limit: 20, sort })` with the default order of each tab spelt out (upcoming by
//    departure, past and cancelled newest departure first). "Load more" appends `page.next()` and moves the focus to the
//    first new booking. A `401` (the session ended, the SDK's one refresh failed) goes to sign-in with `next`.
// 3. A card per booking (`tpl-booking-row`, partials/templates/booking-row.html): route, dates, travellers, reference,
//    status (a word and a colour), a schedule change, the total; it links to `/booking.html?id=bkg_…`.
//
// States (pages-account.md §2): empty upcoming ("No upcoming trips", the search and the guest lookup), empty past or
// cancelled (a short message), and the shared states of a failed call with Retry.

import { boot, renderState } from "../boot.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { clone, fill } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatLocalDate, formatMoney } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { signInHref } from "../lib/session.js";
import { withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["BookingSummary"]} BookingSummary */
/** @typedef {import("@velexis/ota-sdk").Page<BookingSummary>} BookingsPage */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {Pick<VelexisClient, "bookings">} PageClient */
/** @typedef {"upcoming" | "past" | "cancelled"} BookingsTab */

/** The tabs of My bookings, in their order. */
export const TABS = /** @type {const} */ (["upcoming", "past", "cancelled"]);
/** Bookings per page of the list. */
export const PAGE_SIZE = 20;
/** The order of each tab (the API's defaults, spelt out). */
export const TAB_SORT = Object.freeze({ upcoming: "departure", past: "-departure", cancelled: "-departure" });
/** Where a visitor goes when the OTA has no customer accounts. */
export const LOOKUP_PATH = "/lookup.html";
/** Ticketing states of a booking whose tickets are still to come. */
const TICKETS_OPEN = new Set(["pending", "in_progress"]);
/** The date of a card: "Fri 20 Nov 2026". */
const CARD_DATE = /** @type {const} */ ({
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
/** Failures of the list without Retry. */
const FINAL_STATES = new Set(["suspended", "unknown-host", "forbidden", "feature-disabled", "validation"]);

/**
 * Reports an error of the page (the browser's console and `error` event) without breaking it.
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
 * The tab of a `tab` parameter: one of TABS, else `upcoming`.
 * @param {string | null} value
 * @returns {BookingsTab}
 */
export const tabOf = (value) =>
  TABS.includes(/** @type {BookingsTab} */ (value)) ? /** @type {BookingsTab} */ (value) : "upcoming";

/**
 * The address of a tab.
 * @param {BookingsTab} tab
 */
export const tabHref = (tab) => withQuery("/bookings.html", { tab });

/**
 * The booking page of a booking.
 * @param {string} bookingId
 */
export const bookingPageHref = (bookingId) => withQuery("/booking.html", { id: bookingId });

/**
 * The status a card or the booking page shows: the booking's own, or `cancellation_requested` for a live booking whose
 * cancellation waits for the staff or the airline. Always a word (`bookingStatus.<status>` of lib/i18n.js) with its
 * colour.
 * @param {string} status
 * @param {{ status?: string } | null | undefined} [cancellation]
 */
export function statusCode(status, cancellation = null) {
  return status !== "cancelled" && cancellation?.status === "pending" ? "cancellation_requested" : status;
}

/**
 * The fields of one booking card (`tpl-booking-row`).
 * @param {BookingSummary} booking
 * @param {string | undefined} locale
 */
export function bookingRow(booking, locale) {
  const destination =
    typeof booking.destinationCityName === "string" && booking.destinationCityName.trim() !== ""
      ? t("bookings.place", { name: booking.destinationCityName.trim(), code: booking.destinationCode })
      : booking.destinationCode;
  const depart = formatLocalDate(booking.departureAt, locale, CARD_DATE);
  const returnAt = typeof booking.returnAt === "string" ? booking.returnAt : null;
  const status = statusCode(booking.status);
  const notice = booking.hasScheduleChange
    ? t("bookings.scheduleChanged")
    : booking.status !== "cancelled" && TICKETS_OPEN.has(String(booking.ticketingStatus))
      ? t("bookings.ticketsPending")
      : null;
  return {
    id: booking.id,
    href: bookingPageHref(booking.id),
    route: t("bookings.route", { from: booking.originCode, to: destination }),
    status: t(`bookingStatus.${status}`),
    statusCode: status,
    dates: returnAt
      ? t("bookings.dates", { depart, return: formatLocalDate(returnAt, locale, CARD_DATE) })
      : depart,
    travellers: t("bookings.travellers", {
      count: booking.travelersCount,
      name: booking.leadTravelerName,
    }),
    reference: booking.reference,
    notice,
    noNotice: notice === null,
    total: formatMoney(booking.total, locale),
  };
}

/**
 * Runs My bookings (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page has no
 * bookings area, else `{ done, destroy }`: `done` settles once the first page (or a state) is shown, or the visitor was
 * sent on.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, replace?: (url: string) => void }} [env] for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-bookings-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const location = env.location ?? view.location;
  const replace = env.replace ?? ((/** @type {string} */ url) => location.replace(url));
  const { config, client, session = null } = context;
  const locale = config?.defaultLocale;
  const support = config?.support ?? null;
  const live = mountLiveRegion(doc.body);

  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (main.querySelector(selector));
  const el = {
    title: find("h1"),
    state: find("[data-bookings-state]"),
    loading: find("[data-bookings-loading]"),
    content: find("[data-bookings-content]"),
    list: find("[data-bookings-list]"),
    empty: find("[data-bookings-empty]"),
    emptyTitle: find("[data-bookings-empty-title]"),
    emptyUpcoming: find("[data-bookings-empty-upcoming]"),
    loadMore: find("[data-load-more]"),
    loadMoreButton: /** @type {HTMLButtonElement} */ (main.querySelector('button[data-action="load-more"]')),
    loadMoreState: find("[data-load-more-state]"),
  };

  const tab = tabOf(new URLSearchParams(location.search).get("tab"));
  /** The last page the list shows. @type {BookingsPage | null} */
  let current = null;
  /** Bookings on the screen. */
  let shown = 0;
  let busy = false;
  let destroyed = false;
  /** Running calls, aborted by destroy. @type {Set<AbortController>} */
  const controllers = new Set();

  const track = () => {
    const controller = new AbortController();
    controllers.add(controller);
    return { signal: controller.signal, done: () => controllers.delete(controller) };
  };

  /** @param {unknown} error */
  const requestIdOf = (error) =>
    error instanceof Error && "requestId" in error
      ? String(/** @type {{ requestId: unknown }} */ (error).requestId ?? "") || null
      : null;

  const tabName = t(`bookings.tab.${tab}`);
  doc.title = t("bookings.pageTitle", { tab: tabName });
  for (const link of /** @type {HTMLAnchorElement[]} */ (Array.from(main.querySelectorAll("a[data-tab]")))) {
    const own = link.dataset.tab === tab;
    link.href = tabHref(/** @type {BookingsTab} */ (link.dataset.tab));
    if (own) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }

  /** Who may not see the list goes on: sign-in with `next`, or the lookup without customer accounts. */
  const sendOn = () => {
    replace(config?.features?.customerAccounts === false ? LOOKUP_PATH : signInHref(location));
  };

  /**
   * The cards of `bookings`, appended to the list. Returns the first new card's link.
   * @param {ReadonlyArray<BookingSummary>} bookings
   * @returns {HTMLAnchorElement | null}
   */
  const append = (bookings) => {
    const rows = bookings.map((booking) => fill(clone("tpl-booking-row", doc), bookingRow(booking, locale)));
    el.list.append(...rows);
    shown += rows.length;
    return /** @type {HTMLAnchorElement | null} */ (rows[0]?.querySelector("a") ?? null);
  };

  /** Shows the list (or the tab's empty state) and "Load more" while more pages exist. */
  const showList = () => {
    el.loading.hidden = true;
    el.content.hidden = false;
    el.empty.hidden = shown > 0;
    el.emptyTitle.textContent = t(`bookings.empty.${tab}`);
    el.emptyUpcoming.hidden = tab !== "upcoming";
    el.loadMore.hidden = current === null || current.page.nextCursor === null;
  };

  /**
   * The first page of the tab.
   * @param {{ focus?: boolean }} [options]
   */
  const load = async ({ focus = false } = {}) => {
    el.state.replaceChildren();
    el.content.hidden = true;
    el.loading.hidden = false;
    live.announce(t("bookings.loading"));
    const call = track();
    try {
      current = await client.bookings.list(
        { timeframe: tab, limit: PAGE_SIZE, sort: TAB_SORT[tab] },
        { signal: call.signal },
      );
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (state.name === "signed-out") {
        sendOn();
        return;
      }
      el.loading.hidden = true;
      const unexpected = state.name === "unexpected" || state.name === "validation";
      renderState(el.state, unexpected ? { ...state, message: t("state.unexpected") } : state, {
        support,
        focus,
        requestId: unexpected ? requestIdOf(error) : null,
        ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => load({ focus: true }).catch(report) }),
      });
      live.announce(state.message);
      return;
    } finally {
      call.done();
    }
    if (destroyed) {
      return;
    }
    el.list.replaceChildren();
    shown = 0;
    append(current.data);
    showList();
    live.announce(shown > 0 ? t("bookings.loaded", { count: shown }) : t(`bookings.empty.${tab}`));
  };

  /** "Load more": the next page, appended; the focus moves to its first booking. */
  const onLoadMore = async () => {
    if (busy || current === null || current.page.nextCursor === null) {
      return;
    }
    busy = true;
    el.loadMoreState.replaceChildren();
    el.loadMoreButton.setAttribute("aria-disabled", "true");
    el.loadMoreButton.textContent = t("bookings.loadingMore");
    live.announce(t("bookings.loadingMore"));
    try {
      const next = await current.next();
      if (destroyed) {
        return;
      }
      if (next) {
        current = next;
        const first = append(next.data);
        showList();
        live.announce(t("bookings.loadedMore", { count: next.data.length }));
        first?.focus();
      } else {
        el.loadMore.hidden = true;
      }
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (state.name === "signed-out") {
        sendOn();
        return;
      }
      renderState(el.loadMoreState, state, {
        support,
        requestId: state.name === "unexpected" ? requestIdOf(error) : null,
      });
      live.announce(state.message);
    } finally {
      busy = false;
      el.loadMoreButton.removeAttribute("aria-disabled");
      el.loadMoreButton.textContent = t("bookings.loadMore");
    }
  };
  const onLoadMoreClick = () => {
    onLoadMore().catch(report);
  };
  el.loadMoreButton.textContent = t("bookings.loadMore");
  el.loadMoreButton.addEventListener("click", onLoadMoreClick);

  const done = (async () => {
    if (!session || config?.features?.customerAccounts === false) {
      sendOn();
      return;
    }
    await load();
  })().catch(report);

  return {
    done,
    destroy() {
      destroyed = true;
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
      el.loadMoreButton.removeEventListener("click", onLoadMoreClick);
      live.clear();
    },
  };
}

document.documentElement.dataset.js = "on";

boot().then((context) => {
  try {
    start(
      /** @type {{ config: StorefrontConfig, client: PageClient, session: SessionInfo | null }} */ (
        /** @type {unknown} */ (context)
      ),
    );
  } catch (error) {
    report(error);
  }
});
