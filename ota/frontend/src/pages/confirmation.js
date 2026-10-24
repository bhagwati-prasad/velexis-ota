// Entry module of the confirmation page (confirmation.html, ota/frontend/docs/pages.md §11, flow
// ota/docs/flows/checkout-stripe.md §3, SDK guide B3 §2.8, OADR-0003). The complete page and the airline-card page
// open it with `/confirmation.html?booking=bkg_…`, and with `&pending=1` when the airline's answer to Flight Create
// Orders was lost (`504 SUPPLIER_TIMEOUT`) or the checkout is still being completed (`409 CHECKOUT_BEING_COMPLETED`):
// the order may exist, and the reconciliation decides within about 15 minutes.
//
// 1. `bookings.get({ bookingId })`: reference, trip, travellers, total, contact e-mail. Access comes from the customer
//    session or the guest cookie `__Host-vx_bt` (cookie mode: no token in JavaScript).
// 2. `bookings.getTicketingStatus({ bookingId, refresh: true })` at once, then again after its `pollAfterSeconds`
//    while that is not `null`: every 10 s while the booking is `pending`, every few seconds while its tickets are
//    being issued. When a pending booking is decided, the page reads the booking again (its record locator, tickets
//    and status) and drops `pending=1` from the address, so a reload shows the final state.
//
// States (pages.md §11): `ticketed` ("Your tickets are issued", ticket numbers, the booking page and its documents);
// `confirmed` (also partly ticketed, ticketing failed or under manual review: "Booking confirmed; tickets are being
// issued, we will e-mail you"); `pending` ("We are confirming your booking with the airline", polled); `failed` ("Your
// booking did not go through. You have not been charged."); a guest booking adds "Save your reference" with the lookup
// link and, when the OTA has customer accounts and nobody is signed in, "Create an account"; `401` (neither a session
// nor the booking's guest cookie) links to `/lookup.html`. A failed poll keeps the state on the screen and tries again;
// polling stops after 30 minutes of a pending booking (the page says so and offers "Check again") and after 10 minutes
// of ticketing (the page already says the tickets follow by e-mail).

import { boot, renderState } from "../boot.js";
import { airlineLabel, renderItinerary } from "../components/itinerary.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { clone, fill } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import { formatMoney } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { signInHref } from "../lib/session.js";
import { replaceQuery, withQuery } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["Booking"]} Booking */
/** @typedef {import("@velexis/ota-sdk").Schemas["BookingItinerary"]} BookingItinerary */
/** @typedef {import("@velexis/ota-sdk").Schemas["BookingTicketingStatus"]} TicketingStatus */
/** @typedef {import("@velexis/ota-sdk").Schemas["Ticket"]} Ticket */
/** @typedef {import("@velexis/ota-sdk").Schemas["Itinerary"]} Itinerary */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {Pick<VelexisClient, "bookings">} PageClient */
/** @typedef {"ticketed" | "confirmed" | "pending" | "failed" | "cancelled"} ConfirmationState */

/** A booking id as the API writes it. */
export const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;
/** The polling interval while a booking is pending, when an answer gives none (OADR-0003: 10 s). */
export const PENDING_POLL_SECONDS = 10;
/** The wait before trying again after a poll that failed. */
export const RETRY_POLL_SECONDS = 10;
/** How long a pending booking is polled before the page offers "Check again" instead. */
export const PENDING_POLL_LIMIT_MS = 30 * 60_000;
/** How long the issue of tickets is polled; the page already says that the tickets follow by e-mail. */
export const TICKETING_POLL_LIMIT_MS = 10 * 60_000;
/** Ticket types of the flights themselves (EMDs are extras). */
const FLIGHT_TICKETS = new Set(["ETICKET", "PTICKET"]);
/** Failures of a poll after which polling cannot do better. */
const FINAL_POLL_STATES = new Set([
  "suspended",
  "unknown-host",
  "signed-out",
  "not-found",
  "forbidden",
  "validation",
  "feature-disabled",
]);
/** Failures of the first load without Retry. */
const FINAL_LOAD_STATES = new Set([
  "suspended",
  "unknown-host",
  "forbidden",
  "validation",
  "feature-disabled",
]);
/** The border of the status panel per state (complete class names, for Tailwind's scanner). */
const PANEL_BORDER = Object.freeze({
  ticketed: "border-success",
  confirmed: "border-success",
  pending: "border-warning",
  failed: "border-error",
  cancelled: "border-muted/30",
});

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

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The state the page shows for a booking status and its ticketing status.
 * @param {string | null | undefined} bookingStatus `BookingTicketingStatus.bookingStatus` / `Booking.status`
 * @param {string | null | undefined} ticketingStatus `BookingTicketingStatus.status` / `Booking.ticketing.status`
 * @returns {ConfirmationState}
 */
export function confirmationState(bookingStatus, ticketingStatus) {
  if (bookingStatus === "pending" || bookingStatus === "failed" || bookingStatus === "cancelled") {
    return bookingStatus;
  }
  return bookingStatus === "ticketed" || ticketingStatus === "issued" ? "ticketed" : "confirmed";
}

/**
 * The booking page of a booking (`#documents` for its documents).
 * @param {string} bookingId
 * @param {string} [hash]
 */
export const bookingHref = (bookingId, hash = "") =>
  `${withQuery("/booking.html", { id: bookingId })}${hash}`;

/**
 * A bound of a booking in the shape of the result card's row (components/itinerary.js): its airlines and the airports
 * of its connections come from its flights.
 * @param {BookingItinerary} itinerary
 * @returns {Itinerary}
 */
function itineraryRow(itinerary) {
  const segments = list(itinerary.segments);
  return /** @type {Itinerary} */ (
    /** @type {unknown} */ ({
      ...itinerary,
      marketingCarriers: [...new Set(segments.map((segment) => segment?.carrierCode).filter(Boolean))],
      stopAirports: segments.slice(0, -1).map((segment) => segment?.arrival?.iataCode ?? ""),
    })
  );
}

/**
 * Runs the confirmation page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the
 * page has no confirmation area, else `{ done, destroy }`: `done` settles once the booking (or a state) is shown.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, history?: History, now?: () => number }} [env] for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-confirmation-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const location = env.location ?? view.location;
  const history = env.history ?? view.history;
  const now = env.now ?? (() => Date.now());
  const { config, client, session = null } = context;
  const locale = config?.defaultLocale;
  const support = config?.support ?? null;
  const live = mountLiveRegion(doc.body);

  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (main.querySelector(selector));
  const el = {
    title: find("[data-confirmation-title]"),
    state: find("[data-confirmation-state]"),
    loading: find("[data-confirmation-loading]"),
    content: find("[data-confirmation-content]"),
    panel: find("[data-status-panel]"),
    text: find("[data-status-text]"),
    progress: find("[data-status-progress]"),
    stillPending: find("[data-status-still-pending]"),
    stillPendingText: find("[data-status-still-pending-text]"),
    checkAgain: /** @type {HTMLButtonElement} */ (main.querySelector("button[data-check-again]")),
    ticketsBlock: find("[data-tickets-block]"),
    tickets: find("[data-tickets]"),
    bookingLinks: find("[data-booking-links]"),
    bookingLink: /** @type {HTMLAnchorElement} */ (main.querySelector("a[data-booking-link]")),
    documentsLink: /** @type {HTMLAnchorElement} */ (main.querySelector("a[data-documents-link]")),
    searchLink: find("[data-search-link]"),
    referenceBlock: find("[data-reference-block]"),
    reference: find("[data-reference]"),
    airlineReferences: find("[data-airline-references]"),
    guestBlock: find("[data-guest-block]"),
    createAccount: find("[data-create-account]"),
    tripBlock: find("[data-trip-block]"),
    itineraries: find("[data-itineraries]"),
    travellers: find("[data-travellers]"),
    total: find("[data-total]"),
  };

  const params = new URLSearchParams(location.search);
  const bookingParam = params.get("booking");
  const bookingId = bookingParam !== null && BOOKING_ID.test(bookingParam) ? bookingParam : null;
  /** Whether the address says the booking is being confirmed (the complete or airline-card page after a timeout). */
  let pendingHint = params.get("pending") === "1";
  /** @type {Booking | null} */
  let booking = null;
  /** The last ticketing status the API gave. @type {TicketingStatus | null} */
  let status = null;
  /** The state on the screen. @type {ConfirmationState | null} */
  let shown = null;
  /** The booking whose trip is on the screen (the trip is drawn again only for a new booking). @type {Booking | null} */
  let drawn = null;
  /** Whether the next poll may ask Amadeus (a supplier error asks the stored state once). */
  let refresh = true;
  /** Whether a poll is scheduled or running. */
  let polling = false;
  /** Whether polling of a pending booking stopped at its limit. */
  let stoppedPending = false;
  /** The end of polling for the current phase (`pending` or `ticketing`). */
  let deadline = { phase: "", at: 0 };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** Running calls, aborted by destroy. @type {Set<AbortController>} */
  const controllers = new Set();
  let destroyed = false;

  /** A new AbortController for a call, forgotten once the call settled. */
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

  /** The booking's status: the latest ticketing answer's, else the booking's own. */
  const bookingStatus = () => status?.bookingStatus ?? booking?.status ?? null;
  /** The ticketing status: the latest ticketing answer's, else the booking's own. */
  const ticketingStatus = () => status?.status ?? booking?.ticketing?.status ?? null;

  /** Sets the page's heading and title. */
  const setTitle = (/** @type {string} */ title) => {
    el.title.textContent = title;
    doc.title = title;
  };

  /**
   * Replaces the booking with a state of the first load (it could not be read).
   * @param {Pick<PageState, "name" | "message"> & Partial<PageState>} state
   * @param {{ links?: Array<{ label: string, href: string }>, onRetry?: () => void, requestId?: string | null, focus?: boolean }} [options]
   */
  const showPageState = (state, { links = [], onRetry, requestId = null, focus = false } = {}) => {
    el.loading.hidden = true;
    el.content.hidden = true;
    setTitle(t("confirmation.title"));
    doc.title = state.message;
    const element = renderState(
      el.state,
      { ...state, scope: "inline" },
      { support, requestId, focus, ...(onRetry ? { onRetry } : {}) },
    );
    const retry = element.querySelector('[data-action="retry"]')?.closest("p") ?? null;
    for (const link of links) {
      const item = fill(clone("tpl-state-link", doc), link);
      if (retry) {
        retry.before(item);
      } else {
        element.append(item);
      }
    }
    live.announce(state.message);
  };

  const lookupLink = () => ({ label: t("confirmation.findBooking"), href: "/lookup.html" });

  /** "We could not find this booking", with the lookup link. */
  const showMissing = (focus = false) => {
    showPageState(
      { name: "not-found", message: t("confirmation.missing") },
      { links: [lookupLink()], focus },
    );
  };

  /** The page without access to the booking (`401`): the lookup link, and sign-in for a customer's booking. */
  const showLookup = (focus = false) => {
    const links = [lookupLink()];
    if (!session && config?.features?.customerAccounts !== false) {
      links.push({ label: t("account.signIn"), href: signInHref(location) });
    }
    showPageState(
      {
        // Not an API state: its name gives it its hint (`stateHint.confirmation-lookup`) and its `data-state`.
        name: /** @type {PageState["name"]} */ (/** @type {unknown} */ ("confirmation-lookup")),
        message: t("confirmation.lookup"),
      },
      { links, focus },
    );
  };

  /**
   * One line of a list (`tpl-confirmation-item`).
   * @param {string} text
   */
  const item = (text) => fill(clone("tpl-confirmation-item", doc), { text });

  /** The name of a traveller of the booking by its Amadeus id. */
  const travellerName = (/** @type {string | null | undefined} */ travelerId) => {
    const traveller = list(booking?.travelers).find((entry) => entry?.travelerId === travelerId);
    const first = traveller?.name?.firstName;
    const last = traveller?.name?.lastName;
    return typeof first === "string" && typeof last === "string"
      ? t("confirmation.traveller", { firstName: first, lastName: last })
      : null;
  };

  /** The issued flight tickets: the latest ticketing answer's, else the booking's. */
  const issuedTickets = () =>
    list(status ? status.tickets : booking?.tickets).filter(
      (/** @type {Ticket} */ ticket) =>
        FLIGHT_TICKETS.has(ticket?.documentType) &&
        ticket.status === "ISSUED" &&
        typeof ticket.documentNumber === "string",
    );

  /** The e-mail address of the booking's primary contact, when there is one. */
  const contactEmail = () => {
    const contacts = list(booking?.contacts);
    const contact = contacts.find((entry) => entry?.isPrimary) ?? contacts[0];
    const email = contact?.emailAddress;
    return typeof email === "string" && email.trim() !== "" ? email.trim() : null;
  };

  /**
   * The text of a state, with the contact e-mail when there is one.
   * @param {ConfirmationState} state
   */
  const stateText = (state) => {
    const email = contactEmail();
    switch (state) {
      case "ticketed":
        return email ? t("confirmation.ticketedEmail", { email }) : t("confirmation.ticketedText");
      case "confirmed":
        return email ? t("confirmation.confirmedEmail", { email }) : t("confirmation.confirmedText");
      case "pending":
        return email ? t("confirmation.pendingEmail", { email }) : t("confirmation.pendingText");
      case "failed":
        return t("confirmation.failedText");
      default:
        return t("confirmation.cancelledText");
    }
  };

  /** The trip of the booking: its bounds, travellers and total. */
  const renderTrip = () => {
    if (!booking) {
      return;
    }
    const tripType = booking.tripType ?? "one_way";
    /** @type {Map<string, string>} */
    const airlines = new Map();
    for (const segment of list(booking.itineraries).flatMap((itinerary) => list(itinerary?.segments))) {
      if (typeof segment?.carrierName === "string" && segment.carrierName !== "") {
        airlines.set(segment.carrierCode, segment.carrierName);
      }
    }
    el.itineraries.replaceChildren(
      ...list(booking.itineraries).map((itinerary) =>
        renderItinerary(itineraryRow(itinerary), {
          doc,
          locale,
          tripType,
          airline: (code) => airlineLabel(code, airlines.get(code)),
          place: (code) => code,
        }),
      ),
    );
    el.travellers.replaceChildren(
      ...list(booking.travelers)
        .map((traveller) => travellerName(traveller?.travelerId))
        .filter((name) => name !== null)
        .map((name) => item(/** @type {string} */ (name))),
    );
    el.total.textContent = formatMoney(booking.totals?.total, locale);
    el.reference.textContent = booking.reference ?? "";
    const airlineReferences = list(booking.recordLocators)
      .filter((locator) => typeof locator?.reference === "string" && locator.originSystemCode !== "1A")
      .map((locator) => t("confirmation.airlineReference", locator));
    el.airlineReferences.textContent =
      airlineReferences.length > 0
        ? t("confirmation.airlineReferences", { references: airlineReferences.join(", ") })
        : "";
    el.airlineReferences.hidden = airlineReferences.length === 0;
  };

  /** Shows the booking in its current state; the live region announces a new state. */
  const render = () => {
    if (!booking || bookingId === null) {
      return;
    }
    const state = confirmationState(bookingStatus(), ticketingStatus());
    const title = t(`confirmation.${state}`);
    const text = stateText(state);
    el.state.replaceChildren();
    el.loading.hidden = true;
    el.content.hidden = false;
    setTitle(title);
    el.panel.dataset.status = state;
    el.panel.classList.remove(...Object.values(PANEL_BORDER));
    el.panel.classList.add(PANEL_BORDER[state]);
    el.text.textContent = text;
    el.progress.hidden = !(state === "pending" && polling);
    el.stillPending.hidden = !(state === "pending" && stoppedPending);
    el.stillPendingText.textContent = t("confirmation.stillPending");

    const tickets = state === "ticketed" || state === "confirmed" ? issuedTickets() : [];
    el.tickets.replaceChildren(
      ...tickets.map((ticket) => {
        const name = ticket.travelerName ?? travellerName(ticket.travelerId);
        return item(
          name ? t("confirmation.ticket", { number: ticket.documentNumber, name }) : ticket.documentNumber,
        );
      }),
    );
    el.ticketsBlock.hidden = tickets.length === 0;

    const linked = state === "ticketed" || state === "confirmed" || state === "cancelled";
    el.bookingLinks.hidden = !linked;
    el.bookingLink.href = bookingHref(bookingId);
    el.documentsLink.href = bookingHref(bookingId, "#documents");
    el.documentsLink.hidden = state !== "ticketed";
    el.searchLink.hidden = state !== "failed";

    const failed = state === "failed";
    el.referenceBlock.hidden = failed || typeof booking.reference !== "string";
    el.tripBlock.hidden = failed;
    el.guestBlock.hidden = failed || booking.isGuest !== true;
    el.createAccount.hidden = session !== null || config?.features?.customerAccounts === false;
    if (drawn !== booking) {
      drawn = booking;
      renderTrip();
    }

    if (state !== shown) {
      shown = state;
      live.announce(`${title}. ${text}`);
    }
  };

  /**
   * Plans the next poll in `seconds`, unless the current phase (a pending booking, or tickets being issued) reached
   * its limit.
   * @param {number} seconds
   */
  const schedule = (seconds) => {
    clearTimeout(timer);
    const phase = bookingStatus() === "pending" ? "pending" : "ticketing";
    if (deadline.phase !== phase) {
      deadline = {
        phase,
        at: now() + (phase === "pending" ? PENDING_POLL_LIMIT_MS : TICKETING_POLL_LIMIT_MS),
      };
    }
    if (now() + seconds * 1000 > deadline.at) {
      polling = false;
      stoppedPending = phase === "pending";
      return;
    }
    polling = true;
    stoppedPending = false;
    timer = setTimeout(() => {
      poll().catch(report);
    }, seconds * 1000);
  };

  /** Stops polling. */
  const stop = () => {
    clearTimeout(timer);
    polling = false;
  };

  /**
   * Plans the next poll after a ticketing answer: its `pollAfterSeconds` (10 s for a pending booking without one), or
   * none when the state is final.
   */
  const scheduleNext = () => {
    const after = status?.pollAfterSeconds;
    if (typeof after === "number" && after > 0) {
      schedule(after);
    } else if (bookingStatus() === "pending") {
      schedule(PENDING_POLL_SECONDS);
    } else {
      stop();
    }
  };

  /** The booking again, after a pending booking was decided (its locator, tickets and status). */
  const reloadBooking = async () => {
    if (bookingId === null) {
      return;
    }
    const call = track();
    try {
      booking = await client.bookings.get({ bookingId }, { signal: call.signal });
    } catch (error) {
      // The booking on the screen stays, with the decided status of the ticketing answer.
      if (!isAborted(error)) {
        report(error);
      }
    } finally {
      call.done();
    }
  };

  /** Drops `pending=1` from the address once the booking is decided, so a reload shows the final state. */
  const dropPendingHint = () => {
    if (pendingHint) {
      pendingHint = false;
      replaceQuery({ pending: null }, { location, history });
    }
  };

  /** One poll of the ticketing status. */
  const poll = async () => {
    if (destroyed || bookingId === null) {
      return;
    }
    const wasPending = bookingStatus() === "pending";
    const call = track();
    /** @type {TicketingStatus} */
    let next;
    try {
      next = await client.bookings.getTicketingStatus({ bookingId, refresh }, { signal: call.signal });
    } catch (error) {
      call.done();
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (FINAL_POLL_STATES.has(state.name)) {
        stop();
      } else {
        // The airline's side failed with a refresh: the next poll reads the stored state.
        refresh = !state.name.startsWith("supplier-");
        schedule(
          state.name === "rate-limited" && state.retryAfterSeconds
            ? state.retryAfterSeconds
            : RETRY_POLL_SECONDS,
        );
      }
      render();
      return;
    }
    call.done();
    if (destroyed) {
      return;
    }
    refresh = true;
    status = next;
    if (wasPending && next.bookingStatus !== "pending") {
      dropPendingHint();
      await reloadBooking();
      if (destroyed) {
        return;
      }
    }
    scheduleNext();
    render();
  };

  /** "Check again" after polling of a pending booking stopped at its limit. */
  const onCheckAgain = () => {
    stoppedPending = false;
    deadline = { phase: "", at: 0 };
    polling = true;
    render();
    // The button goes away with its block: the focus moves to the page's heading, which says the state.
    el.title.focus();
    poll().catch(report);
  };
  el.checkAgain.addEventListener("click", onCheckAgain);

  /**
   * The first load: the booking and its ticketing status together.
   * @param {{ focus?: boolean }} [options]
   */
  const load = async ({ focus = false } = {}) => {
    if (bookingId === null) {
      return;
    }
    el.state.replaceChildren();
    el.content.hidden = true;
    el.loading.hidden = false;
    setTitle(pendingHint ? t("confirmation.pending") : t("confirmation.title"));
    live.announce(pendingHint ? t("confirmation.pending") : t("confirmation.loading"));
    const call = track();
    const [loaded, ticketing] = await Promise.allSettled([
      client.bookings.get({ bookingId }, { signal: call.signal }),
      client.bookings.getTicketingStatus({ bookingId, refresh: true }, { signal: call.signal }),
    ]);
    call.done();
    if (destroyed) {
      return;
    }
    if (loaded.status === "rejected") {
      const error = loaded.reason;
      if (isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (state.name === "signed-out") {
        showLookup(focus);
        return;
      }
      if (state.name === "not-found") {
        showMissing(focus);
        return;
      }
      const unexpected = state.name === "unexpected" || state.name === "validation";
      showPageState(unexpected ? { ...state, message: t("state.unexpected") } : state, {
        focus,
        requestId: unexpected ? requestIdOf(error) : null,
        ...(FINAL_LOAD_STATES.has(state.name) ? {} : { onRetry: () => load({ focus: true }).catch(report) }),
      });
      return;
    }
    booking = loaded.value;
    if (ticketing.status === "fulfilled") {
      status = ticketing.value;
      if (booking?.status === "pending" && status.bookingStatus !== "pending") {
        // Decided between the two answers: the booking with its record locator and tickets.
        await reloadBooking();
        if (destroyed) {
          return;
        }
      }
      scheduleNext();
    } else {
      status = null;
      const state = pageStateFor(ticketing.reason);
      const open =
        bookingStatus() === "pending" || ["pending", "in_progress"].includes(String(ticketingStatus()));
      if (open && !FINAL_POLL_STATES.has(state.name)) {
        refresh = !state.name.startsWith("supplier-");
        schedule(RETRY_POLL_SECONDS);
      }
    }
    if (bookingStatus() !== "pending") {
      dropPendingHint();
    }
    render();
  };

  const done = (async () => {
    if (bookingId === null) {
      showMissing();
      return;
    }
    await load();
  })().catch(report);

  return {
    done,
    destroy() {
      destroyed = true;
      stop();
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
      el.checkAgain.removeEventListener("click", onCheckAgain);
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
